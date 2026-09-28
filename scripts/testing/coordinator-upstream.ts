import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { constants as osConstants } from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

import {
  buildRunScriptArgs,
  detectProjectManager,
  resolveManagerCommand,
  type PackageManagerKind,
} from '../lib/package-manager.js'

import type { UpstreamPhase } from './coordinator-command-matrix.js'
import { descendantPids, readProcessSnapshot, type CommandResult } from './process-tree.js'

const ACTIVE_ENV_KEY = 'FRESHELL_TEST_COORDINATOR_ACTIVE'
const FAKE_UPSTREAM_ENV_KEY = 'FRESHELL_TEST_COORDINATOR_FAKE_UPSTREAM'
const REPO_ROOT_ENV_KEY = 'FRESHELL_TEST_COORDINATOR_REPO_ROOT'
const PHASE_TIMEOUT_ENV_KEY = 'FRESHELL_TEST_COORDINATOR_PHASE_TIMEOUT_MS'
const PHASE_WATCH_POLL_ENV_KEY = 'FRESHELL_TEST_COORDINATOR_PHASE_WATCH_POLL_MS'
const DEFAULT_PHASE_TIMEOUT_MS = 2 * 60 * 60 * 1000
const DEFAULT_PHASE_WATCH_POLL_MS = 10_000
// The kill path runs inside a watchdog tick, so its synchronous process-table
// read must be bounded: an unbounded ps/PowerShell stall would freeze the
// event loop before the settle can finish.
const KILL_SNAPSHOT_TIMEOUT_MS = 10_000

export const PHASE_WATCHDOG_EXIT_CODE = 125

export type PhaseWatchdogReason = 'phase_timeout' | 'child_vanished'

export interface SpawnAndWaitOptions {
  livenessProbe?: (pid: number | undefined) => boolean | undefined
  /**
   * Arm the hard per-phase timeout. Default enabled; only dispatches that
   * never hold the coordinator gate (passthrough/delegated lanes) disable
   * it — they keep lost-completion liveness detection but no cap and no
   * kill.
   */
  hardTimeout?: boolean
}

function parsePositiveIntEnv(envVars: NodeJS.ProcessEnv, key: string, fallback: number): number {
  // Numeric separators ('7_200_000') are not parseInt digits; strip them so a
  // value copied from the documented default keeps its magnitude.
  const parsed = Number.parseInt((envVars[key] ?? '').replaceAll('_', ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function evaluatePhaseWatchdogTick(input: {
  childAlive: boolean | undefined
  consecutiveDeadTicks: number
  elapsedMs: number
  timeoutMs: number
}): PhaseWatchdogReason | undefined {
  if (input.childAlive === false && input.consecutiveDeadTicks >= 2) {
    return 'child_vanished'
  }
  if (input.elapsedMs >= input.timeoutMs) {
    return 'phase_timeout'
  }
  return undefined
}

function isChildAlive(pid: number | undefined): boolean | undefined {
  if (pid === undefined) {
    return undefined
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Kill-path snapshot runner: mirrors process-tree's runCommand (same 16 MiB
// maxBuffer) but bounds the synchronous read at KILL_SNAPSHOT_TIMEOUT_MS. On
// timeout spawnSync returns the error-shaped result, which flows into
// readProcessSnapshot's existing fallback/degraded handling.
function boundedSnapshotRunner(command: string, args: readonly string[]): CommandResult {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: KILL_SNAPSHOT_TIMEOUT_MS,
  })
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  }
}

// Kill the phase child AND its descendants: the phase child of a broad run is
// usually a package-manager wrapper around the real workload, so killing
// only the direct child would release the gate while the workload keeps
// running. The snapshot walk is the repo's existing process-tree primitive.
function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) {
    return
  }
  try {
    const snapshot = readProcessSnapshot(process.platform, boundedSnapshotRunner)
    const victims = [pid, ...descendantPids(pid, snapshot)]
    for (const victim of victims) {
      try {
        process.kill(victim, 'SIGKILL')
      } catch {
        // already dead
      }
    }
    return
  } catch (error) {
    // Degraded cleanup: without a process-table snapshot only the direct
    // child is reachable. Never silent — the event names what happened so a
    // surviving-workload overlap can be classified instead of re-guessed.
    console.error(JSON.stringify({
      severity: 'warn',
      event: 'phase_watchdog_tree_kill_degraded',
      timestamp: new Date().toISOString(),
      pid,
      error: (error as Error).message,
    }))
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already dead
    }
  }
}

function emitPhaseWatchdogEvent(reason: PhaseWatchdogReason, fields: {
  pid: number | undefined
  elapsedMs: number
  pollMs: number
  timeoutMs: number
}): void {
  console.error(JSON.stringify({
    severity: reason === 'phase_timeout' ? 'warn' : 'error',
    event: 'phase_watchdog_settled',
    timestamp: new Date().toISOString(),
    reason,
    ...fields,
  }))
}

const managerByRepoRoot = new Map<string, PackageManagerKind>()

function detectPhaseManager(repoRoot: string): PackageManagerKind {
  const cached = managerByRepoRoot.get(repoRoot)
  if (cached !== undefined) {
    return cached
  }
  const manager = detectProjectManager(repoRoot).manager
  managerByRepoRoot.set(repoRoot, manager)
  return manager
}

export function assertNoCoordinatorRecursion(envVars: NodeJS.ProcessEnv = process.env): void {
  if (envVars[ACTIVE_ENV_KEY] === '1') {
    throw new Error('Recursive coordinator entry is not allowed while FRESHELL_TEST_COORDINATOR_ACTIVE=1.')
  }
}

export function resolveVitestCommand(repoRoot: string): { command: string; args: string[] } {
  const require = createRequire(path.join(repoRoot, 'package.json'))
  const packagePath = require.resolve('vitest/package.json')
  const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { bin?: string | Record<string, string> }
  const relativeBin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.vitest
  if (!relativeBin || path.isAbsolute(relativeBin) || relativeBin.split(/[\/]/).includes('..')) {
    throw new Error('Vitest package does not expose a safe CLI entrypoint.')
  }
  return {
    command: process.execPath,
    args: [path.resolve(path.dirname(packagePath), relativeBin)],
  }
}

export function resolveCargoCommand(): { command: string; args: string[] } {
  return {
    command: process.platform === 'win32' ? 'cargo.exe' : 'cargo',
    args: [],
  }
}

export async function runUpstreamPhase(
  phase: UpstreamPhase,
  envVars: NodeJS.ProcessEnv = process.env,
  options: SpawnAndWaitOptions = {},
): Promise<number> {
  const childEnv: NodeJS.ProcessEnv = {
    ...envVars,
    [ACTIVE_ENV_KEY]: '1',
  }

  if (envVars[FAKE_UPSTREAM_ENV_KEY]) {
    return runFakePhase(phase, childEnv, options)
  }

  return runRealPhase(phase, childEnv, options)
}

interface SpawnSpec {
  command: string
  args: string[]
  selector: string
  viaShell?: boolean
}

function resolveSpawnSpec(phase: UpstreamPhase, envVars: NodeJS.ProcessEnv): SpawnSpec {
  if (phase.runner === 'npm') {
    const repoRoot = envVars[REPO_ROOT_ENV_KEY] ?? process.cwd()
    const manager = detectPhaseManager(repoRoot)
    const scriptArgs = buildRunScriptArgs(manager, phase.script, phase.args)
    const resolved = resolveManagerCommand({ manager, args: scriptArgs, env: envVars })
    return {
      command: resolved.command,
      args: resolved.args,
      ...(resolved.viaShell === true ? { viaShell: true } : {}),
      selector: `npm:${phase.script}${phase.args.length > 0 ? ` ${phase.args.join(' ')}` : ''}`,
    }
  }

  if (phase.runner === 'cargo') {
    const cargo = resolveCargoCommand()
    return {
      command: cargo.command,
      args: [...cargo.args, ...phase.args],
      selector: `cargo:${phase.args.join(' ')}`.trimEnd(),
    }
  }

  const repoRoot = envVars[REPO_ROOT_ENV_KEY] ?? process.cwd()
  const vitest = resolveVitestCommand(repoRoot)
  return {
    command: vitest.command,
    args: [...vitest.args, ...phase.args],
    selector: `vitest:${phase.config}:${phase.args.join(' ')}`.trimEnd(),
  }
}

async function runFakePhase(phase: UpstreamPhase, envVars: NodeJS.ProcessEnv, options: SpawnAndWaitOptions): Promise<number> {
  const fakeUpstreamPath = envVars[FAKE_UPSTREAM_ENV_KEY]
  if (!fakeUpstreamPath) {
    throw new Error('Fake upstream path was not provided.')
  }

  const spawnSpec = resolveSpawnSpec(phase, envVars)
  return spawnAndWait(
    process.execPath,
    [
      fakeUpstreamPath,
      JSON.stringify({
        selector: spawnSpec.selector,
        command: spawnSpec.command,
        args: spawnSpec.args,
      }),
    ],
    envVars,
    false,
    options,
  )
}

async function runRealPhase(phase: UpstreamPhase, envVars: NodeJS.ProcessEnv, options: SpawnAndWaitOptions): Promise<number> {
  const spawnSpec = resolveSpawnSpec(phase, envVars)
  return spawnAndWait(spawnSpec.command, spawnSpec.args, envVars, spawnSpec.viaShell === true, options)
}

export function spawnAndWait(
  command: string,
  args: string[],
  envVars: NodeJS.ProcessEnv,
  viaShell: boolean,
  options: SpawnAndWaitOptions = {},
): Promise<number> {
  const timeoutMs = parsePositiveIntEnv(envVars, PHASE_TIMEOUT_ENV_KEY, DEFAULT_PHASE_TIMEOUT_MS)
  const hardTimeoutEnabled = options.hardTimeout !== false
  // The timeout is honored at the poll cadence, so the effective poll
  // interval clamps down to the timeout when smaller; the clamp exists only
  // to honor the cap and is removed with it.
  const configuredPollMs = parsePositiveIntEnv(envVars, PHASE_WATCH_POLL_ENV_KEY, DEFAULT_PHASE_WATCH_POLL_MS)
  const pollMs = hardTimeoutEnabled ? Math.min(configuredPollMs, timeoutMs) : configuredPollMs
  const effectiveTimeoutMs = hardTimeoutEnabled ? timeoutMs : Number.POSITIVE_INFINITY
  const isAlive = options.livenessProbe ?? isChildAlive

  return new Promise((resolve, reject) => {
    const startedAtMs = Date.now()
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: envVars,
      ...(viaShell ? { shell: true } : {}),
    })

    let settled = false
    let consecutiveDeadTicks = 0

    const watchdog = setInterval(() => {
      const childAlive = isAlive(child.pid)
      consecutiveDeadTicks = childAlive === false ? consecutiveDeadTicks + 1 : 0
      const reason = evaluatePhaseWatchdogTick({
        childAlive,
        consecutiveDeadTicks,
        elapsedMs: Date.now() - startedAtMs,
        timeoutMs: effectiveTimeoutMs,
      })

      if (reason === undefined) {
        return
      }

      // The child hung (or its completion signal was lost with the process
      // gone): fail the phase instead of awaiting forever. On timeout the
      // whole spawned tree dies so no workload outlives the failed run.
      emitPhaseWatchdogEvent(reason, {
        pid: child.pid,
        elapsedMs: Date.now() - startedAtMs,
        pollMs,
        timeoutMs,
      })
      if (reason === 'phase_timeout') {
        killProcessTree(child.pid)
      }
      // In the lost-completion class the native exit callback never arrives,
      // so the ChildProcess handle keeps an event-loop reference forever and
      // a process that only assigns process.exitCode (like the coordinator's
      // main entry) never terminates. Drop the reference so the loop drains.
      child.unref()
      finish({ kind: 'code', code: PHASE_WATCHDOG_EXIT_CODE })
    }, pollMs)

    function finish(outcome: { kind: 'code'; code: number } | { kind: 'error'; error: Error }): void {
      if (settled) return
      settled = true
      clearInterval(watchdog)
      if (outcome.kind === 'error') {
        reject(outcome.error)
        return
      }
      resolve(outcome.code)
    }

    child.once('error', (error) => finish({ kind: 'error', error }))
    child.once('exit', (code, signal) => {
      if (typeof code === 'number') {
        finish({ kind: 'code', code })
        return
      }
      if (signal) {
        finish({ kind: 'code', code: 128 + (osConstants.signals[signal as keyof typeof osConstants.signals] ?? 1) })
        return
      }
      finish({ kind: 'code', code: 1 })
    })
  })
}
