import { createRequire } from 'node:module'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { constants as osConstants } from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UpstreamPhase } from '../../../../scripts/testing/coordinator-command-matrix.js'
import {
  PHASE_WATCHDOG_EXIT_CODE,
  assertNoCoordinatorRecursion,
  evaluatePhaseWatchdogTick,
  resolveVitestCommand,
  runUpstreamPhase,
  spawnAndWait,
} from '../../../../scripts/testing/coordinator-upstream.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../../../..')
const FIXTURE_PATH = path.join(REPO_ROOT, 'test', 'fixtures', 'testing', 'fake-coordinated-workload.mjs')
const require = createRequire(import.meta.url)

let tempDir: string
let captureFile: string
let fakePnpmEntry: string
let fakeNpmEntry: string

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-coordinator-upstream-'))
  captureFile = path.join(tempDir, 'capture.jsonl')
  fakePnpmEntry = path.join(tempDir, 'pnpm.cjs')
  fakeNpmEntry = path.join(tempDir, 'npm-cli.js')
  await fsp.writeFile(fakePnpmEntry, '')
  await fsp.writeFile(fakeNpmEntry, '')
})

afterEach(async () => {
  await fsp.rm(tempDir, { recursive: true, force: true })
})

interface FakeEnvOptions {
  repoRoot?: string
  npmExecpath?: string
  phaseWatchPollMs?: string
  phaseTimeoutMs?: string
}

function fakeEnv(behavior: Record<string, unknown> = {}, options: FakeEnvOptions = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FRESHELL_TEST_COORDINATOR_FAKE_UPSTREAM: FIXTURE_PATH,
    FRESHELL_TEST_COORDINATOR_FAKE_BEHAVIOR: JSON.stringify(behavior),
    FRESHELL_TEST_COORDINATOR_CAPTURE_FILE: captureFile,
    FRESHELL_TEST_COORDINATOR_REPO_ROOT: options.repoRoot ?? REPO_ROOT,
    npm_execpath: options.npmExecpath ?? fakePnpmEntry,
    ...(options.phaseWatchPollMs ? { FRESHELL_TEST_COORDINATOR_PHASE_WATCH_POLL_MS: options.phaseWatchPollMs } : {}),
    ...(options.phaseTimeoutMs ? { FRESHELL_TEST_COORDINATOR_PHASE_TIMEOUT_MS: options.phaseTimeoutMs } : {}),
  }
}

async function makeRepoRootFixture(manifest: Record<string, unknown>): Promise<string> {
  const repoRoot = path.join(tempDir, 'repo-root')
  await fsp.mkdir(repoRoot, { recursive: true })
  await fsp.writeFile(path.join(repoRoot, 'package.json'), JSON.stringify(manifest))
  return repoRoot
}

async function readCaptureLines() {
  const raw = await fsp.readFile(captureFile, 'utf8')
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

async function waitForCapturePid(selector: string, filter?: { role?: string }): Promise<number> {
  const deadline = Date.now() + 10_000
  let lastLines = ''
  while (Date.now() < deadline) {
    const raw = await fsp.readFile(captureFile, 'utf8').catch(() => '')
    lastLines = raw
    const parsed = raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const match = parsed.find((entry) =>
      entry.selector === selector && (!filter?.role || entry.role === filter.role))
    if (typeof match?.pid === 'number' && match.pid > 0) {
      return match.pid
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`capture pid for ${selector}${filter?.role ? ` (role=${filter.role})` : ''} never appeared; last capture: ${lastLines}`)
}

describe('coordinator-upstream', () => {
  it('resolves the repo-local vitest entry module under process.execPath', () => {
    const command = resolveVitestCommand(REPO_ROOT)

    expect(command.command).toBe(process.execPath)
    expect(command.args).toEqual([require.resolve('vitest/vitest.mjs')])
  })

  it('passes delegated help and watch invocations through the repo-local vitest entry with the recursion guard env set', async () => {
    const expectedVitest = require.resolve('vitest/vitest.mjs')
    const rustHelpPhase: UpstreamPhase = {
      runner: 'cargo',
      args: ['test', '-p', 'freshell-server', '--locked', '--help'],
    }
    const watchPhase: UpstreamPhase = {
      runner: 'vitest',
      config: 'default',
      args: ['--watch'],
    }

    expect(await runUpstreamPhase(rustHelpPhase, fakeEnv())).toBe(0)
    expect(await runUpstreamPhase(watchPhase, fakeEnv())).toBe(0)

    const captures = await readCaptureLines()
    expect(captures).toHaveLength(2)
    expect(captures[0]).toMatchObject({
      selector: 'cargo:test -p freshell-server --locked --help',
      command: process.platform === 'win32' ? 'cargo.exe' : 'cargo',
      args: ['test', '-p', 'freshell-server', '--locked', '--help'],
      active: '1',
    })
    expect(captures[1]).toMatchObject({
      selector: 'vitest:default:--watch',
      command: process.execPath,
      args: [expectedVitest, '--watch'],
      active: '1',
    })
  })

  it('propagates exact numeric exit codes from upstream children', async () => {
    const exitCode = await runUpstreamPhase({
      runner: 'npm',
      script: 'build',
      args: [],
    }, fakeEnv({
      'npm:build': { exitCode: 23 },
    }))

    expect(exitCode).toBe(23)
  })

  it('returns the conventional nonzero exit code when an upstream child exits by signal', async () => {
    const exitCode = await runUpstreamPhase({
      runner: 'npm',
      script: 'typecheck',
      args: [],
    }, fakeEnv({
      'npm:typecheck': { signal: 'SIGTERM' },
    }))

    const expectedExitCode = process.platform === 'win32'
      ? 1
      : 128 + osConstants.signals.SIGTERM
    expect(exitCode).toBe(expectedExitCode)
  })

  it('rejects recursive public coordinator entry', () => {
    expect(() => assertNoCoordinatorRecursion({
      FRESHELL_TEST_COORDINATOR_ACTIVE: '1',
    })).toThrow(/recursive/i)
  })

  it('runs script phases through pnpm without a separator when the repo root pins pnpm', async () => {
    const repoRoot = await makeRepoRootFixture({ packageManager: 'pnpm@10.34.5' })
    const phase: UpstreamPhase = { runner: 'npm', script: 'test:balanced', args: ['--reporter=dot'] }

    expect(await runUpstreamPhase(phase, fakeEnv({}, { repoRoot }))).toBe(0)

    const [capture] = await readCaptureLines()
    expect(capture).toMatchObject({
      selector: 'npm:test:balanced --reporter=dot',
      command: process.execPath,
      args: [fakePnpmEntry, 'run', 'test:balanced', '--reporter=dot'],
    })
  })

  it('keeps the npm separator for script phases in a repo root without the packageManager field', async () => {
    const repoRoot = await makeRepoRootFixture({ name: 'legacy-repo' })
    const phase: UpstreamPhase = { runner: 'npm', script: 'test:balanced', args: ['--reporter=dot'] }

    expect(await runUpstreamPhase(phase, fakeEnv({}, { repoRoot, npmExecpath: fakeNpmEntry }))).toBe(0)

    const [capture] = await readCaptureLines()
    expect(capture).toMatchObject({
      selector: 'npm:test:balanced --reporter=dot',
      command: process.execPath,
      args: [fakeNpmEntry, 'run', 'test:balanced', '--', '--reporter=dot'],
    })
  })
})

describe('phase watchdog', () => {
  it('requires two consecutive dead ticks before declaring the child vanished', () => {
    const base = { childAlive: false as const, elapsedMs: 500, timeoutMs: 10_000 }
    expect(evaluatePhaseWatchdogTick({ ...base, consecutiveDeadTicks: 1 })).toBeUndefined()
    expect(evaluatePhaseWatchdogTick({ ...base, consecutiveDeadTicks: 2 })).toBe('child_vanished')
  })

  it('ignores liveness it cannot determine', () => {
    expect(evaluatePhaseWatchdogTick({ childAlive: undefined, consecutiveDeadTicks: 5, elapsedMs: 500, timeoutMs: 10_000 })).toBeUndefined()
  })

  it('declares a phase timeout once elapsed time reaches the bound while the child lives', () => {
    expect(evaluatePhaseWatchdogTick({ childAlive: true, consecutiveDeadTicks: 0, elapsedMs: 9_999, timeoutMs: 10_000 })).toBeUndefined()
    expect(evaluatePhaseWatchdogTick({ childAlive: true, consecutiveDeadTicks: 0, elapsedMs: 10_000, timeoutMs: 10_000 })).toBe('phase_timeout')
  })

  it('fails a hanging phase child with the watchdog exit code once the phase timeout elapses', async () => {
    ;(globalThis as any).__ALLOW_CONSOLE_ERROR__ = true // the watchdog settle event logs to stderr
    const exitCode = await runUpstreamPhase({
      runner: 'npm',
      script: 'test:balanced',
      args: [],
    }, fakeEnv({
      'npm:test:balanced': { holdMs: 30_000 },
    }, {
      // injected through envVars so the watchdog knobs are test-visible:
      phaseWatchPollMs: '50',
      phaseTimeoutMs: '300',
    }))

    expect(exitCode).toBe(PHASE_WATCHDOG_EXIT_CODE)
  }, 15_000)

  it('settles through the child_vanished branch when the liveness probe reports the child gone', async () => {
    ;(globalThis as any).__ALLOW_CONSOLE_ERROR__ = true // the watchdog settle event logs to stderr
    const probeCalls: Array<number | undefined> = []
    const exitCode = await spawnAndWait(
      process.execPath,
      [FIXTURE_PATH, JSON.stringify({ selector: 'probe-test' })],
      fakeEnv({
        default: { holdMs: 30_000 },
      }, {
        phaseWatchPollMs: '25',
        // A large timeout proves the settle can only come from the vanish branch.
        phaseTimeoutMs: '30_000',
      }),
      false,
      {
        livenessProbe: (pid) => {
          probeCalls.push(pid)
          return false
        },
      },
    )

    expect(exitCode).toBe(PHASE_WATCHDOG_EXIT_CODE)
    // The probe was consulted with the real child pid on at least the two
    // consecutive dead ticks the grace requires.
    expect(probeCalls.length).toBeGreaterThanOrEqual(2)
    expect(probeCalls.every((pid) => typeof pid === 'number' && pid > 0)).toBe(true)

    // The probe lied about a child that is really alive: clean it up via the
    // pid the probe observed so no 30s orphan lingers in the test run.
    const realPid = probeCalls[0] as number
    try {
      process.kill(realPid, 'SIGKILL')
    } catch {
      // already exited
    }
  }, 15_000)

  it('stays inert when the phase child exits on its own before any bound', async () => {
    const exitCode = await runUpstreamPhase({
      runner: 'npm',
      script: 'typecheck',
      args: [],
    }, fakeEnv({
      'npm:typecheck': { exitCode: 23 },
    }, {
      phaseWatchPollMs: '50',
      phaseTimeoutMs: '300',
    }))

    expect(exitCode).toBe(23)
  }, 15_000)

  it('does not mask signal-exit codes when the watchdog is armed', async () => {
    const exitCode = await runUpstreamPhase({
      runner: 'npm',
      script: 'typecheck',
      args: [],
    }, fakeEnv({
      'npm:typecheck': { signal: 'SIGTERM' },
    }, {
      phaseWatchPollMs: '50',
      phaseTimeoutMs: '300',
    }))

    const expectedExitCode = process.platform === 'win32'
      ? 1
      : 128 + osConstants.signals.SIGTERM
    expect(exitCode).toBe(expectedExitCode)
  }, 15_000)

  it('settles promptly at the signal-mapped code when the child is killed outside the watchdog', async () => {
    const exitPromise = runUpstreamPhase({
      runner: 'npm',
      script: 'test:balanced',
      args: [],
    }, fakeEnv({
      'npm:test:balanced': { holdMs: 30_000 },
    }, {
      phaseWatchPollMs: '50',
      phaseTimeoutMs: '10_000',
    }))

    const pid = await waitForCapturePid('npm:test:balanced')
    expect(pid).toBeGreaterThan(0)

    process.kill(pid, 'SIGKILL')

    const expectedExitCode = process.platform === 'win32'
      ? 1
      : 128 + osConstants.signals.SIGKILL
    await expect(exitPromise).resolves.toBe(expectedExitCode)
  }, 20_000)

  it('reaps the phase child AND its descendants when the watchdog kills on timeout', async () => {
    ;(globalThis as any).__ALLOW_CONSOLE_ERROR__ = true // the watchdog settle event logs to stderr
    const exitPromise = runUpstreamPhase({
      runner: 'npm',
      script: 'test:balanced',
      args: [],
    }, fakeEnv({
      'npm:test:balanced': { holdMs: 30_000, spawnDescendant: true },
    }, {
      phaseWatchPollMs: '25',
      phaseTimeoutMs: '250',
    }))

    await expect(exitPromise).resolves.toBe(PHASE_WATCHDOG_EXIT_CODE)

    const directPid = await waitForCapturePid('npm:test:balanced')
    const descendantPid = await waitForCapturePid('npm:test:balanced', { role: 'descendant' })
    expect(directPid).toBeGreaterThan(0)
    expect(descendantPid).toBeGreaterThan(0)

    // Both the direct child and its spawned descendant must be gone: the
    // watchdog killed the whole tree, not just the wrapper.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(() => process.kill(directPid, 0)).toThrow()
    expect(() => process.kill(descendantPid, 0)).toThrow()
  }, 20_000)

  it('does not settle a hard-timeout-free dispatch at the configured phase timeout', async () => {
    ;(globalThis as any).__ALLOW_CONSOLE_ERROR__ = true // a red run of this case settles via the watchdog and logs to stderr
    const exitPromise = runUpstreamPhase({
      runner: 'npm',
      script: 'test:balanced',
      args: [],
    }, fakeEnv({
      'npm:test:balanced': { holdMs: 30_000 },
    }, {
      phaseWatchPollMs: '25',
      phaseTimeoutMs: '150',
    }), { hardTimeout: false })

    const pid = await waitForCapturePid('npm:test:balanced')
    expect(pid).toBeGreaterThan(0)

    // Four times the configured timeout later the phase must still be
    // pending: a dispatch that never holds the coordinator gate keeps no
    // hard cap, so nothing may settle (let alone kill) the child.
    const stillPending = await Promise.race([
      exitPromise.then(() => false, () => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 600)),
    ])
    expect(stillPending).toBe(true)

    process.kill(pid, 'SIGKILL')
    const expectedExitCode = process.platform === 'win32'
      ? 1
      : 128 + osConstants.signals.SIGKILL
    await expect(exitPromise).resolves.toBe(expectedExitCode)
  }, 20_000)

  it('keeps lost-completion liveness detection armed when the hard timeout is disabled', async () => {
    ;(globalThis as any).__ALLOW_CONSOLE_ERROR__ = true // the watchdog settle event logs to stderr
    const errSpy = vi.spyOn(console, 'error')
    let observedChildPid: number | undefined
    const exitCode = await spawnAndWait(
      process.execPath,
      [FIXTURE_PATH, JSON.stringify({ selector: 'passthrough-vanish' })],
      fakeEnv({
        default: { holdMs: 30_000 },
      }, {
        phaseWatchPollMs: '25',
        // Small enough that an incorrectly armed hard timeout would settle
        // (and kill) on the very first tick, before the vanish grace.
        phaseTimeoutMs: '25',
      }),
      false,
      {
        hardTimeout: false,
        livenessProbe: (pid) => {
          observedChildPid = pid
          return false
        },
      },
    )

    expect(exitCode).toBe(PHASE_WATCHDOG_EXIT_CODE)
    // The settle must come from the vanish branch, not the disabled hard
    // timeout: an armed cap would fire on the first tick with reason
    // phase_timeout and SIGKILL the child; no watchdog at all would never
    // settle.
    const settleEvents = errSpy.mock.calls
      .flat()
      .map(String)
      .filter((line) => line.includes('phase_watchdog_settled'))
    expect(settleEvents).toHaveLength(1)
    expect(settleEvents[0]).toContain('"reason":"child_vanished"')
    // The vanish branch never kills: the child that is really still holding
    // must have outlived the settle.
    expect(() => process.kill(observedChildPid!, 0)).not.toThrow()
    try {
      process.kill(observedChildPid!, 'SIGKILL')
    } catch {
      // already exited
    }
  }, 15_000)

  it('honors a phase timeout smaller than the poll cadence within one small poll', async () => {
    ;(globalThis as any).__ALLOW_CONSOLE_ERROR__ = true // the watchdog settle event logs to stderr
    const exitPromise = runUpstreamPhase({
      runner: 'npm',
      script: 'test:balanced',
      args: [],
    }, fakeEnv({
      'npm:test:balanced': { holdMs: 30_000 },
    }, {
      phaseWatchPollMs: '10_000',
      phaseTimeoutMs: '250',
    }))

    let raceTimer: NodeJS.Timeout | undefined
    const outcome = await Promise.race([
      exitPromise,
      new Promise<number>((resolve) => {
        raceTimer = setTimeout(() => resolve(-1), 3_000)
      }),
    ])
    clearTimeout(raceTimer)

    try {
      expect(outcome).toBe(PHASE_WATCHDOG_EXIT_CODE)
    } finally {
      // On a red run the phase is still pending here; let the armed
      // watchdog clean up its child so no orphan outlives the test.
      await exitPromise.catch(() => undefined)
    }
  }, 20_000)
})
