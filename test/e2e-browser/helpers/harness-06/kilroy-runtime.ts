import { spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * HARNESS-06 kilroy-runtime driver: spawns `fixtures/fake-kilroy-runtime.mjs`
 * and exposes a typed stdio protocol client over it ("the harness-level full
 * Kilroy runtime"). The same process can also be used as a REAL server's
 * sidecar via the production seam `FRESHELL_CLAUDE_SIDECAR=<fixture>` (the
 * protocol is verbatim); this driver is for fixture-direct smoke/contract
 * assertions.
 */

export interface KilroyRequestLogEntry {
  pid: number
  t: number
  msg: Record<string, unknown>
}

export interface KilroyRuntime {
  proc: ChildProcess
  /** Write one protocol message (a single JSON line) to the sidecar's stdin. */
  send: (msg: Record<string, unknown>) => void
  /**
   * Wait for the NEXT event matching `type` (+ optional predicate) after the
   * runtime's read cursor. Sequential calls consume successive events, so
   * `await nextEvent('sdk.status', s==='idle')` twice yields distinct idles.
   */
  nextEvent: (
    type: string,
    pred?: (event: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ) => Promise<Record<string, unknown>>
  /** All events parsed from stdout so far (in arrival order). */
  events: () => readonly Record<string, unknown>[]
  kill: () => Promise<void>
}

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/fake-kilroy-runtime.mjs',
)

export async function spawnFakeKilroy(env: NodeJS.ProcessEnv = {}): Promise<KilroyRuntime> {
  const proc = spawn(process.execPath, [FIXTURE], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const events: Record<string, unknown>[] = []
  let cursor = 0
  const waiters: Array<{
    type: string
    pred?: (event: Record<string, unknown>) => boolean
    resolve: (event: Record<string, unknown>) => void
    timer: NodeJS.Timeout
  }> = []

  const rl = readline.createInterface({ input: proc.stdout! })
  rl.on('line', (line) => {
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    events.push(event)
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i]
      const idx = events.findIndex(
        (e, j) => j >= cursor && e.type === w.type && (!w.pred || w.pred(e)),
      )
      if (idx >= 0) {
        cursor = idx + 1
        waiters.splice(i, 1)
        clearTimeout(w.timer)
        w.resolve(events[idx])
      }
    }
  })

  const stderrChunks: Buffer[] = []
  proc.stderr!.on('data', (c: Buffer) => stderrChunks.push(c))

  // Ensure the child has booted its readline loop before callers write —
  // the fixture processes lines strictly in order, so stdin writes are safe
  // immediately after spawn (pipe buffering). We return right away.

  return {
    proc,
    send: (msg) => {
      if (!proc.stdin || proc.killed) throw new Error('fake-kilroy sidecar stdin unavailable')
      proc.stdin.write(`${JSON.stringify(msg)}\n`)
    },
    nextEvent: (type, pred, timeoutMs = 15_000) =>
      new Promise((resolve, reject) => {
        const existing = events.findIndex(
          (e, j) => j >= cursor && e.type === type && (!pred || pred(e)),
        )
        if (existing >= 0) {
          cursor = existing + 1
          resolve(events[existing])
          return
        }
        const timer = setTimeout(() => {
          const i = waiters.findIndex((w) => w.timer === timer)
          if (i >= 0) waiters.splice(i, 1)
          reject(
            new Error(
              `timed out (${timeoutMs}ms) waiting for fake-kilroy event ${type}; ` +
              `seen so far: ${events.map((e) => e.type).join(', ')}; ` +
              `stderr: ${Buffer.concat(stderrChunks).toString('utf8').slice(-500)}`,
            ),
          )
        }, timeoutMs)
        waiters.push({ type, pred, resolve, timer })
      }),
    events: () => events,
    kill: async () => {
      if (proc.exitCode !== null || proc.killed) return
      const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()))
      try { proc.kill('SIGKILL') } catch { /* already dead */ }
      await exited
      rl.close()
    },
  }
}

export async function readKilroyLedger(logPath: string): Promise<KilroyRequestLogEntry[]> {
  const text = await fs.readFile(logPath, 'utf8')
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as KilroyRequestLogEntry)
}
