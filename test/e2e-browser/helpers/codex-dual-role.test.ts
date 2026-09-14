import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { describe, it, expect } from 'vitest'
import { installDualRoleCodexCli } from '../fixtures/codex-dual-role'

/**
 * Behavioral pinning for the dual-role codex shim installed by e2e specs.
 *
 * The Rust server's codex terminal lane spawns TWO processes from the same
 * CODEX_CMD: the TUI (plain argv) and a `codex app-server` sidecar FIRST.
 * A terminal-only fake at CODEX_CMD exits 0 instantly on the sidecar spawn
 * (stdin is /dev/null), and every codex pane create dies PTY_SPAWN_FAILED.
 * The dual-role shim must therefore:
 *   (a) run the given terminal fake for plain argv (stdi. in/out passthrough), and
 *   (b) route argv containing `app-server` to the shared fake app-server,
 *       which STAYS ALIVE listening (the sidecar contract).
 */

const TERMINAL_MARKER = 'DUAL_ROLE_TERMINAL_RAN'

interface ShimProcess {
  child: ChildProcess
  stdout: string[]
  exited: Promise<number | null>
}

async function writeTerminalFake(binDir: string): Promise<string> {
  const terminalSrc = path.join(binDir, 'terminal-src.mjs')
  await fs.writeFile(terminalSrc, `console.log(${JSON.stringify(TERMINAL_MARKER)})\nprocess.exit(0)\n`, 'utf8')
  return terminalSrc
}

function spawnShim(binPath: string, args: string[], env?: NodeJS.ProcessEnv): ShimProcess {
  const stdout: string[] = []
  const child = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
  child.stdout?.on('data', (d) => stdout.push(String(d)))
  return { child, stdout, exited }
}

async function waitExit(shim: ShimProcess, timeoutMs: number): Promise<number | null> {
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs)
    void shim.exited.then((code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

async function didExit(shim: ShimProcess, timeoutMs: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    void shim.exited.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

async function stopShim(shim: ShimProcess): Promise<void> {
  if (shim.child.exitCode !== null || shim.child.signalCode !== null) return
  try {
    shim.child.kill('SIGTERM')
  } catch {
    return
  }
  if (await didExit(shim, 2_500)) return
  try {
    shim.child.kill('SIGKILL')
  } catch {
    return
  }
  if (!(await didExit(shim, 2_500))) {
    throw new Error(`dual-role shim PID ${shim.child.pid ?? 'unknown'} did not exit after SIGKILL`)
  }
}

function directChildPids(pid: number): number[] {
  const raw = fsSync.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim()
  return raw === '' ? [] : raw.split(/\s+/).map(Number)
}

async function freeLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

async function withCleanup<T>(body: () => Promise<T>, cleanupSteps: Array<() => Promise<void>>): Promise<T> {
  let result: T | undefined
  let primaryError: unknown
  try {
    result = await body()
  } catch (error) {
    primaryError = error
  }

  const cleanupErrors: unknown[] = []
  for (const cleanup of cleanupSteps) {
    try {
      await cleanup()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }

  if (primaryError !== undefined) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError([primaryError, ...cleanupErrors], 'dual-role test and cleanup both failed')
    }
    throw primaryError
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'dual-role cleanup failed')
  }
  return result as T
}

async function canBindLoopbackPort(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true))
    })
  })
}

describe('codex-dual-role shim', () => {
  it('preserves the test failure while attempting every cleanup step', async () => {
    const primary = new Error('primary test failure')
    const firstCleanup = new Error('first cleanup failure')
    const secondCleanup = new Error('second cleanup failure')
    const attempted: string[] = []
    let thrown: unknown

    try {
      await withCleanup(
        async () => {
          throw primary
        },
        [
          async () => {
            attempted.push('first')
            throw firstCleanup
          },
          async () => {
            attempted.push('second')
            throw secondCleanup
          },
        ],
      )
    } catch (error) {
      thrown = error
    }

    expect(attempted).toEqual(['first', 'second'])
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toEqual([primary, firstCleanup, secondCleanup])
  })

  it('runs the terminal fake for plain argv', async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-role-'))
    try {
      const terminalSrc = await writeTerminalFake(binDir)
      const bin = await installDualRoleCodexCli(binDir, terminalSrc)
      expect(bin).toBe(path.join(binDir, 'codex'))

      const shim = spawnShim(bin, [])
      const code = await waitExit(shim, 10_000)
      expect(code).not.toBeNull()
      expect(code).toBe(0)
      await waitUntil(2_000, () => shim.stdout.join('').includes(TERMINAL_MARKER))
    } finally {
      await fs.rm(binDir, { recursive: true, force: true })
    }
  }, 30_000)

  it('routes `app-server` argv to the fake app-server, which keeps listening (the sidecar contract)', async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-role-'))
    let shim: ShimProcess | undefined
    await withCleanup(async () => {
      const terminalSrc = await writeTerminalFake(binDir)
      const bin = await installDualRoleCodexCli(binDir, terminalSrc)

      shim = spawnShim(bin, ['-c', 'features.apps=false', 'app-server', '--listen', 'ws://127.0.0.1:0'])
      // A listening sidecar survives its whole lifetime — it does NOT exit 0
      // instantly the way a terminal-only fake does when stdin is /dev/null.
      const earlyExit = await waitExit(shim, 3_000)
      expect(earlyExit).toBeNull()
      // And it never confused itself for the terminal fake.
      await new Promise((r) => setTimeout(r, 100))
      expect(shim.stdout.join('')).not.toContain(TERMINAL_MARKER)
    }, [
      async () => { if (shim) await stopShim(shim) },
      () => fs.rm(binDir, { recursive: true, force: true }),
    ])
  }, 30_000)

  it('passes terminalEnv through to the terminal role only', async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-role-'))
    try {
      const terminalSrc = path.join(binDir, 'terminal-src.mjs')
      await fs.writeFile(
        terminalSrc,
        "console.log('env=' + process.env.DUAL_ROLE_TEST_ENV)\nprocess.exit(0)\n",
        'utf8',
      )
      const bin = await installDualRoleCodexCli(binDir, terminalSrc, {
        DUAL_ROLE_TEST_ENV: 'env-carry-1',
      })
      const shim = spawnShim(bin, [])
      const code = await waitExit(shim, 10_000)
      expect(code).toBe(0)
      await waitUntil(2_000, () => shim.stdout.join('').includes('env=env-carry-1'))
    } finally {
      await fs.rm(binDir, { recursive: true, force: true })
    }
  }, 30_000)

  it('a terminal-only fake at CODEX_CMD exits 0 instantly under sidecar argv (the pathology this shim fixes)', async () => {
    // Contrast test: documents the failure this helper prevents. If the
    // shared app-server fake stops working, the previous test fails; if the
    // dispatch breaks toward the terminal role, this one catches regression
    // in the FIXture's transitive meaning.
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-role-'))
    let shim: ShimProcess | undefined
    await withCleanup(async () => {
      const terminalSrc = await writeTerminalFake(binDir)
      const bin = await installDualRoleCodexCli(binDir, terminalSrc)

      shim = spawnShim(bin, ['-c', 'features.apps=false', 'app-server', '--listen', 'ws://127.0.0.1:0'])
      const code = await waitExit(shim, 10_000)
      // Terminal fake must NOT have run.
      expect(shim.stdout.join('')).not.toContain(TERMINAL_MARKER)
      expect(code).toBeNull()
    }, [
      async () => { if (shim) await stopShim(shim) },
      () => fs.rm(binDir, { recursive: true, force: true }),
    ])
  }, 30_000)

  it('releases its direct app-server listener after bounded graceful cleanup', async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-role-reap-'))
    const terminalSrc = await writeTerminalFake(binDir)
    const bin = await installDualRoleCodexCli(binDir, terminalSrc)
    const port = await freeLoopbackPort()
    const shim = spawnShim(bin, ['-c', 'features.apps=false', 'app-server', '--listen', `ws://127.0.0.1:${port}`])

    await withCleanup(async () => {
      await waitUntil(5_000, () => {
        return shim.child.exitCode === null
      })
      await waitUntil(5_000, async () => !(await canBindLoopbackPort(port)))

      await stopShim(shim)
      expect(await canBindLoopbackPort(port)).toBe(true)
    }, [
      () => stopShim(shim),
      () => fs.rm(binDir, { recursive: true, force: true }),
    ])
  }, 30_000)

  it.skipIf(process.platform !== 'linux')('runs the app-server in the shim process instead of an extra child', async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-role-direct-'))
    const terminalSrc = await writeTerminalFake(binDir)
    const bin = await installDualRoleCodexCli(binDir, terminalSrc)
    const port = await freeLoopbackPort()
    const shim = spawnShim(bin, ['-c', 'features.apps=false', 'app-server', '--listen', `ws://127.0.0.1:${port}`])

    await withCleanup(async () => {
      await waitUntil(5_000, async () => !(await canBindLoopbackPort(port)))
      expect(directChildPids(shim.child.pid ?? -1)).toEqual([])
    }, [
      () => stopShim(shim),
      () => fs.rm(binDir, { recursive: true, force: true }),
    ])
  }, 30_000)

  it.skipIf(process.platform === 'win32')('escalates cleanup when the direct app-server rejects SIGTERM', async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-role-escalate-'))
    const terminalSrc = await writeTerminalFake(binDir)
    const bin = await installDualRoleCodexCli(binDir, terminalSrc)
    const port = await freeLoopbackPort()
    const shim = spawnShim(
      bin,
      ['-c', 'features.apps=false', 'app-server', '--listen', `ws://127.0.0.1:${port}`],
      { ...process.env, FAKE_CODEX_APP_SERVER_IGNORE_SIGTERM: '1' },
    )

    await withCleanup(async () => {
      await waitUntil(5_000, () => {
        return shim.child.exitCode === null
      })
      await waitUntil(5_000, async () => !(await canBindLoopbackPort(port)))

      await stopShim(shim)
      expect(await canBindLoopbackPort(port)).toBe(true)
    }, [
      () => stopShim(shim),
      () => fs.rm(binDir, { recursive: true, force: true }),
    ])
  }, 30_000)
})

async function waitUntil(timeoutMs: number, pred: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pred()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('waitUntil timed out')
}
