// HARNESS-03 launcher for the deterministic provider fixtures in
// `fixtures/providers/`. Spawn-only (never through a Freshell server): the
// fixtures are plain Node ESM scripts launched as `node <fixture> ...args`,
// which is also what makes them hermetic — they can never resolve or exec a
// real provider binary, and `scrub` mode proves it by running with
// `PATH=/nonexistent` and an isolated HOME.
//
// Each launch gets its own temp root:
//   <tmp>/harness03-<rand>/ledger.jsonl   (launch records: argv/cwd/env/pid)
//   <tmp>/harness03-<rand>/events.jsonl   (normalized fixture events)
//   <tmp>/harness03-<rand>/cwd/           (fixture working directory)
//   <tmp>/harness03-<rand>/home/          (isolated HOME, scrub mode)
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const PROVIDER_FIXTURE_DIR = path.resolve(__dirname, '../fixtures/providers')

export interface ProviderLaunchOptions {
  /** Fixture file base name inside fixtures/providers (e.g. 'fake-claude.mjs'). */
  fixture: string
  args?: string[]
  /** Serialized inline as FRESHELL_FAKE_PROGRAM. */
  program?: unknown
  /** Extra env (probe vars named in FRESHELL_FAKE_ENV_RECORD, CODEX_HOME, ...). */
  env?: Record<string, string>
  cwd?: string
  /** Hermetic mode: PATH=/nonexistent, HOME=<isolated>, no inherited env. */
  scrub?: boolean
}

interface LedgerRow {
  t: number
  pid: number
  provider: string
  argv: string[]
  cwd: string
  env: Record<string, string>
}

export interface FixtureEvent {
  t: number
  pid: number
  provider: string
  kind: string
  data: Record<string, unknown>
  trigger: string
}

export class LaunchedFixture {
  readonly root: string
  readonly ledgerPath: string
  readonly eventsPath: string
  readonly cwd: string
  readonly home: string
  readonly proc: ChildProcess
  readonly pid: number
  private stdoutBuf = ''
  private stderrBuf = ''
  private exitedPromise: Promise<number | null>
  private stopped = false

  constructor(proc: ChildProcess, paths: { root: string; cwd: string; home: string }) {
    this.proc = proc
    this.pid = proc.pid ?? -1
    this.root = paths.root
    this.cwd = paths.cwd
    this.home = paths.home
    this.ledgerPath = path.join(paths.root, 'ledger.jsonl')
    this.eventsPath = path.join(paths.root, 'events.jsonl')
    proc.stdout?.on('data', (chunk) => {
      this.stdoutBuf += String(chunk)
    })
    proc.stderr?.on('data', (chunk) => {
      this.stderrBuf += String(chunk)
    })
    this.exitedPromise = new Promise((resolve) => {
      proc.on('exit', (code) => resolve(code))
    })
  }

  get stdout(): string {
    return this.stdoutBuf
  }

  get stderr(): string {
    return this.stderrBuf
  }

  /** Resolves with the exit code once the process exits (null on signal). */
  exited(): Promise<number | null> {
    return this.exitedPromise
  }

  readLedger(): LedgerRow[] {
    return readJsonl(this.ledgerPath)
  }

  readEvents(): FixtureEvent[] {
    return readJsonl(this.eventsPath)
  }

  /** Poll the event ledger until a matching event exists. */
  async waitEvent(
    kind: string,
    pred: (event: FixtureEvent) => boolean = () => true,
    timeoutMs = 10_000,
  ): Promise<FixtureEvent> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const match = this.readEvents().find((event) => event.kind === kind && pred(event))
      if (match) return match
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for fixture event "${kind}". Saw: ${JSON.stringify(this.readEvents())} | stdout: ${this.stdoutBuf} | stderr: ${this.stderrBuf}`,
        )
      }
      await sleep(25)
    }
  }

  /** Poll the accumulated stdout until a substring appears. */
  async waitOutput(needle: string, timeoutMs = 10_000): Promise<string> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (this.stdoutBuf.includes(needle)) return this.stdoutBuf
      if (this.exitedPromise && (await Promise.race([this.exitedPromise.then(() => true), sleep(10).then(() => false)]))) {
        break
      }
      if (Date.now() > deadline) break
      await sleep(25)
    }
    throw new Error(
      `Timed out waiting for fixture output ${JSON.stringify(needle)}. stdout: ${JSON.stringify(this.stdoutBuf)} | stderr: ${this.stderrBuf}`,
    )
  }

  sendLine(line: string): void {
    if (!this.proc.stdin) throw new Error('fixture stdin unavailable')
    this.proc.stdin.write(`${line}\n`)
  }

  /** SIGTERM, escalate to SIGKILL, then remove the temp root. Safe to call twice. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.proc.exitCode === null) {
      try {
        this.proc.kill('SIGTERM')
      } catch {
        // already gone
      }
      const exited = await Promise.race([this.exitedPromise.then(() => true), sleep(2_000).then(() => false)])
      if (!exited && this.proc.exitCode === null) {
        try {
          this.proc.kill('SIGKILL')
        } catch {
          // already gone
        }
        await this.exitedPromise
      }
    }
    fs.rmSync(this.root, { recursive: true, force: true })
  }
}

function readJsonl(file: string): any[] {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function launchProviderFixture(opts: ProviderLaunchOptions): Promise<LaunchedFixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness03-'))
  const cwd = opts.cwd ?? path.join(root, 'cwd')
  const home = path.join(root, 'home')
  fs.mkdirSync(cwd, { recursive: true })
  fs.mkdirSync(home, { recursive: true })

  // HOME is ALWAYS the per-launch isolated dir (never the user's real home),
  // so fixture side effects (rollout files, session stubs, …) stay
  // hermetic-by-default; `scrub` additionally hides PATH and inherited env.
  const env: Record<string, string> = opts.scrub
    ? { PATH: '/nonexistent', HOME: home }
    : { ...process.env, HOME: home }
  for (const [key, value] of Object.entries(opts.env ?? {})) env[key] = value
  env.FRESHELL_FAKE_LEDGER = path.join(root, 'ledger.jsonl')
  env.FRESHELL_FAKE_EVENTS = path.join(root, 'events.jsonl')
  if (opts.program !== undefined) env.FRESHELL_FAKE_PROGRAM = JSON.stringify(opts.program)

  const fixturePath = path.join(PROVIDER_FIXTURE_DIR, opts.fixture)
  const proc = spawn(process.execPath, [fixturePath, ...(opts.args ?? [])], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return new LaunchedFixture(proc, { root, cwd, home })
}
