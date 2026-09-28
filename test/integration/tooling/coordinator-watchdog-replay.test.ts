// @vitest-environment node
import { createRequire } from 'node:module'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

import { afterAll, describe, expect, it } from 'vitest'

import { buildCoordinatorEndpoint, tryListen } from '../../../scripts/testing/coordinator-endpoint.js'
import { getCoordinatorStoreDir, readHolder } from '../../../scripts/testing/coordinator-store.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const require = createRequire(import.meta.url)
const tsxCli = require.resolve('tsx/cli')
const COORDINATOR_PATH = path.resolve(__dirname, '../../../scripts/testing/test-coordinator.ts')
const FIXTURE_PATH = path.resolve(__dirname, '../../fixtures/testing/fake-coordinated-workload.mjs')
const REPO_ROOT = path.resolve(__dirname, '../../..')

const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-watchdog-replay-'))
const tempRepos: string[] = []

afterAll(async () => {
  await fsp.rm(tempRoot, { recursive: true, force: true })
})

function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, ...(env ? { env } : {}) })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

async function makeTempGitRepo(): Promise<{ repo: string; commonDir: string }> {
  const repo = path.join(tempRoot, `repo-${tempRepos.length}`)
  tempRepos.push(repo)
  await fsp.mkdir(repo, { recursive: true })
  await run('git', ['-C', repo, 'init'], repo)
  // A bootstrap commit keeps repo-context resolution (branch/commit/dirty
  // probing) on its happy path in an otherwise empty repo.
  await fsp.writeFile(path.join(repo, 'README.md'), 'watchdog replay\n')
  await run('git', ['-C', repo, '-c', 'user.name=watchdog-replay', '-c', 'user.email=watchdog-replay@example.invalid', 'add', 'README.md'], repo)
  await run('git', ['-C', repo, '-c', 'user.name=watchdog-replay', '-c', 'user.email=watchdog-replay@example.invalid', 'commit', '-m', 'bootstrap'], repo)
  const commonDirRaw = (await run('git', ['-C', repo, 'rev-parse', '--git-common-dir'], repo)).stdout.trim()
  const commonDir = path.resolve(repo, commonDirRaw)
  return { repo, commonDir }
}

interface CoordinatorOutcome {
  code: number
  stdout: string
  stderr: string
  storeDir: string
}

interface CoordinatorScenario {
  outcome: CoordinatorOutcome
  repo: string
  commonDir: string
}

function coordinatorEnv(repo: string, behavior: Record<string, unknown>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Repo-context isolation: the coordinator resolves its git context from
    // INIT_CWD/PWD before process.cwd(), so both must point at the temp repo
    // or the e2e would bind to the real repo's shared gate and store.
    INIT_CWD: repo,
    PWD: repo,
    FRESHELL_TEST_COORDINATOR_FAKE_UPSTREAM: FIXTURE_PATH,
    FRESHELL_TEST_COORDINATOR_FAKE_BEHAVIOR: JSON.stringify(behavior),
    FRESHELL_TEST_COORDINATOR_REPO_ROOT: REPO_ROOT,
    FRESHELL_TEST_COORDINATOR_PHASE_WATCH_POLL_MS: '50',
    FRESHELL_TEST_COORDINATOR_PHASE_TIMEOUT_MS: '400',
    FRESHELL_TEST_SUMMARY: 'watchdog replay',
  }
  delete env.FRESHELL_TEST_COORDINATOR_ACTIVE
  return env
}

async function runCoordinatorScenario(
  behavior: Record<string, unknown>,
  command: string = 'test',
): Promise<CoordinatorScenario> {
  const { repo, commonDir } = await makeTempGitRepo()
  const result = await run(process.execPath, [tsxCli, COORDINATOR_PATH, 'run', command], repo, coordinatorEnv(repo, behavior))
  return { outcome: { ...result, storeDir: getCoordinatorStoreDir(commonDir) }, repo, commonDir }
}

const WEDGE_BEHAVIOR: Record<string, unknown> = {
  'npm:test:balanced': { holdMs: 5_000 },
}

describe('coordinator phase watchdog end to end', () => {
  it('fails the run, releases the gate, and records the failure when a phase child wedges', { timeout: 60_000 }, async () => {
    const { outcome, commonDir } = await runCoordinatorScenario(WEDGE_BEHAVIOR)

    expect(outcome.code).toBe(125)
    expect(outcome.stderr).toContain('"event":"phase_watchdog_settled"')
    expect(outcome.stderr).toContain('"reason":"phase_timeout"')

    await expect(readHolder(outcome.storeDir)).resolves.toBeUndefined()
    const endpoint = buildCoordinatorEndpoint(commonDir)
    const listener = await tryListen(endpoint)
    expect(listener.kind).toBe('listening')
    if (listener.kind === 'listening') {
      await listener.close()
    }
  })

  it('keeps green runs green with the watchdog armed', { timeout: 60_000 }, async () => {
    const { outcome } = await runCoordinatorScenario({
      'npm:test:balanced': { exitCode: 0 },
    })

    expect(outcome.code).toBe(0)
    expect(outcome.stderr).not.toContain('phase_watchdog_settled')
    await expect(readHolder(outcome.storeDir)).resolves.toBeUndefined()
  })

  it('keeps a passthrough wedge alive past the phase timeout — no hard cap without the gate', { timeout: 60_000 }, async () => {
    // test:watch is a passthrough dispatch: it never acquires the shared
    // coordinator gate, so its phase keeps lost-completion liveness but no
    // hard timeout. The child holds 1.5s against the 400ms configured phase
    // timeout and must be allowed to finish green; an always-armed cap
    // would SIGKILL it at ~400ms and fail the run with exit 125.
    const { outcome } = await runCoordinatorScenario({ default: { holdMs: 1_500 } }, 'test:watch')

    expect(outcome.code).toBe(0)
    expect(outcome.stderr).not.toContain('phase_watchdog_settled')
  })

  it('records the watchdog failure as a run result other agents can see', { timeout: 60_000 }, async () => {
    const { outcome, repo } = await runCoordinatorScenario(WEDGE_BEHAVIOR)

    expect(outcome.code).toBe(125)
    const raw = await fsp.readFile(path.join(outcome.storeDir, 'command-runs.json'), 'utf8')
    const parsed = JSON.parse(raw) as {
      byKey: Record<string, { exitCode: number; repo: { repoRoot: string; worktreePath: string } }>
    }
    const recorded = Object.values(parsed.byKey).find((entry) => entry.exitCode === 125)
    // Binding proof: the failure was recorded against the temp repo, not the
    // real shared store — the isolation contract held end to end.
    expect(recorded?.repo.repoRoot).toBe(repo)
    expect(recorded?.repo.worktreePath).toBe(repo)
  })

  it('terminates a whole process whose child completion was lost — no leaked event-loop handle', { timeout: 30_000 }, async () => {
    // The lost-completion class is not externally fabricable through the real
    // coordinator CLI (the liveness probe is not injectable across a
    // process boundary), so this case proves the mechanism at process
    // level. A driver process settles its phase through the child_vanished
    // branch against a child that is really alive and stays alive for a
    // minute; the driver must then terminate promptly by event-loop drain
    // alone. Without child.unref() the leaked native handle keeps the
    // driver wedged until the child's 60s hold expires, and the explicit
    // 10s prompt-exit bound below fails exactly that regression.
    const driverPath = path.resolve(__dirname, '../../fixtures/testing/watchdog-process-exit-driver.ts')
    const sentinelPath = path.join(tempRoot, `driver-sentinel-${Date.now()}.json`)

    // stdio 'ignore' is load-bearing: the fixture child inherits the
    // driver's stdio, so piped streams would couple the driver's observable
    // exit to the child's death and mask a wedged driver.
    const driver = spawn(process.execPath, [tsxCli, driverPath, FIXTURE_PATH, sentinelPath], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        FRESHELL_TEST_COORDINATOR_PHASE_WATCH_POLL_MS: '25',
      },
      stdio: 'ignore',
    })

    const driverExit = new Promise<number>((resolve, reject) => {
      driver.once('error', reject)
      driver.once('exit', (code) => resolve(code ?? 1))
    })
    let boundTimer: NodeJS.Timeout | undefined
    const bounded = await Promise.race([
      driverExit,
      new Promise<'timeout'>((resolve) => {
        boundTimer = setTimeout(() => resolve('timeout'), 10_000)
      }),
    ])
    clearTimeout(boundTimer)

    if (bounded === 'timeout') {
      try {
        process.kill(driver.pid!, 'SIGKILL')
      } catch {
        // already dead
      }
      throw new Error('driver did not terminate promptly after the lost-completion settle — leaked event-loop handle')
    }
    expect(bounded).toBe(0)

    const sentinel = JSON.parse(await fsp.readFile(sentinelPath, 'utf8')) as {
      status: string
      childPid?: number
    }
    expect(sentinel.status).toBe('DRIVER_DONE')

    // The driver settled while its child was still alive; clean up the
    // orphan the driver's probe reported.
    if (typeof sentinel.childPid === 'number') {
      try {
        process.kill(sentinel.childPid, 'SIGKILL')
      } catch {
        // already dead
      }
    }
  })
})
