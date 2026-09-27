# Coordinator Phase-Child Watchdog Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
- The repo-wide test coordinator (`scripts/testing/test-coordinator.ts`) must detect abnormally-exited dispatched phase children and fail the run (releasing the shared coordinator gate) instead of wedging indefinitely. A stale or wedged gate holder must not block every other agent's broad test runs.

### Explicit constraints
- Fix kata freshell#t4c8 (P2, labels bug/infrastructure) via the the-usual workflow.
- Threat model: honest mistakes by cooperating agents — the goal is fail-fast + observability, not adversarial defenses (kata scope note).
- Kata-suggested direction (decide at implementation time): wrap each dispatched phase with a bounded timeout plus child-exit observation (spawn result close/exit code, or a watchdog failing the run when a phase produces no progress); optionally a stale-holder reclaim path (a recorded holder pid provably dead and past a grace period may be reaped by the next acquirer) — phase-level detection alone would have covered the 2026-09-22 incident.
- Red/green/refactor TDD; broad repo tests go through the shared coordinator gate; changes land via PR to main from the run worktree.

### Accepted tradeoffs and residuals
- The incident was pre-existing coordinator design, not introduced by the pnpm migration branch.
- The holder-level reclaim is optional per the kata; phase-level detection is the minimum incident-proof fix.

**Goal:** A dispatched phase child that dies, hangs, or whose completion event is lost fails the coordinated run promptly (exit 125, JSONL evidence, gate released) instead of wedging the repo-wide test gate for hours.

**Architecture:** Harden the single choke point every phase flows through — `spawnAndWait` in `scripts/testing/coordinator-upstream.ts` — with a poll-driven watchdog: every dispatched child gets a liveness/timeout watcher that settles the phase promise if the child is provably gone without an observed completion (the 2026-09-22 machine-suspend class) or has exceeded a bounded phase timeout (the alive-but-hung class). Failure plumbing is unchanged: a watchdog settle is just a nonzero phase exit code, which the existing `runPhases` → `runCoordinatedCommand` catch/finally path already records and releases the gate with. The kata's optional holder-reclaim is deliberately out of scope (see Out of Scope).

**Tech Stack:** TypeScript (NodeNext/ESM), Node `child_process.spawn`, Vitest with real short-lived child processes via the existing `FRESHELL_TEST_COORDINATOR_FAKE_UPSTREAM` fixture seam.

## Global Constraints

- pnpm 10.34.5 only; never `npm ci`/`npm install` in this tree. Focused, uncoordinated test path: `pnpm run test:vitest run <paths> --config config/vitest/vitest.config.ts`. Broad runs go through the coordinator (`pnpm run test`); never kill a foreign gate holder.
- Relative TypeScript imports must end in `.js` (NodeNext/ESM).
- Structured events go to stderr as JSONL matching the existing `scripts/testing/run-rust-tests.ts` idiom: `{ severity, event, timestamp, ...fields }` with a stable snake_case event name.
- Preserve existing coordinator behavior exactly where this plan does not change it: numeric exit-code passthrough, `128 + signal` mapping, spawn `error` → promise rejection (exit 1 at the run level), holder release via `clearHolderIfRunIdMatches` in the `finally` of `runCoordinatedCommand`.
- Exit-code semantics: 124 remains queue-wait timeout; 125 is the new watchdog-settled phase failure. A child that itself exits 125 is disambiguated by the `phase_watchdog_settled` JSONL event's `reason` field.
- Threat model: honest mistakes by cooperating agents. The watchdog may kill only processes it spawned (its own phase children); it must never signal foreign processes.
- Comments: brief, load-bearing only, matching existing repo style.
- Work on the run worktree branch `the-usual/coordinator-child-exit-watch`; PR to main only after explicit user approval. No pushes of behavior changes to main.

## Out of Scope (with reasons — do not implement)

- **Stale-holder reclaim (dead-holder reaping), kata's optional direction:** redundant with the gate's own primitive — the gate is a unix-socket/named-pipe listener (`coordinator-endpoint.ts`); when the holder process dies the OS closes its socket and the next waiter's `tryListen` succeeds immediately. Verified in the architecture report and by the 2026-09-22 recovery (the next agent acquired within seconds of the kill).
- **Holder heartbeat / live-holder liveness publication:** the incident's holder had a live event loop (only the phase promise was unsettled), so a process-liveness heartbeat would NOT have detected it, and the phase watchdog now covers the observed wedge class. Auto-reclaiming a live holder is impossible without killing a foreign process (forbidden). The unobserved "event-loop wedge outside phase code" class keeps today's bounded backstop: waiters give up at `FRESHELL_TEST_COORDINATOR_MAX_WAIT_MS` (24h default) with exit 124.
- **`run-standard-tests.ts:343` `execFileSync` on vitest-cloud.sh** (kata jjzw family): separate kata, separate change.

---

### Task 1: Phase watchdog core in `spawnAndWait` (timeout branch)

**Files:**
- Modify: `scripts/testing/coordinator-upstream.ts` (add ~55 lines: constants, helpers, watchdog wiring in `spawnAndWait`)
- Test: `test/unit/tooling/testing/coordinator-upstream.test.ts` (add cases)

**Interfaces:**
- Consumes: existing `spawnAndWait(command, args, envVars, viaShell)` shape; existing `FRESHELL_TEST_COORDINATOR_*` env-knob idiom (values parsed from the injected `envVars`, not `process.env`, so tests inject via `fakeEnv`).
- Produces:
  - `export type PhaseWatchdogReason = 'phase_timeout' | 'child_vanished'`
  - `export function evaluatePhaseWatchdogTick(input: { childAlive: boolean | undefined; consecutiveDeadTicks: number; elapsedMs: number; timeoutMs: number }): PhaseWatchdogReason | undefined`
  - `export const PHASE_WATCHDOG_EXIT_CODE = 125`
  - New env knobs parsed from the injected env: `FRESHELL_TEST_COORDINATOR_PHASE_TIMEOUT_MS` (default `7_200_000` = 2h), `FRESHELL_TEST_COORDINATOR_PHASE_WATCH_POLL_MS` (default `10_000`).
  - JSONL stderr event `phase_watchdog_settled` with fields `reason`, `pid`, `elapsedMs`, `pollMs`, `timeoutMs`.

- [ ] **Step 1: Write the failing behavioral tests**

Add to `test/unit/tooling/testing/coordinator-upstream.test.ts`:

```typescript
import {
  PHASE_WATCHDOG_EXIT_CODE,
  assertNoCoordinatorRecursion,
  evaluatePhaseWatchdogTick,
  resolveVitestCommand,
  runUpstreamPhase,
} from '../../../../scripts/testing/coordinator-upstream.js'

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
})
```

Extend the `fakeEnv` helper's `FakeEnvOptions` with the two watchdog knobs:

```typescript
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
```

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `pnpm run test:vitest run test/unit/tooling/testing/coordinator-upstream.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL — the new `describe('phase watchdog')` block fails to import `evaluatePhaseWatchdogTick`/`PHASE_WATCHDOG_EXIT_CODE` (module has no such exports); the behavior cases cannot pass because no watchdog exists.

- [ ] **Step 3: Add the minimal production implementation**

In `scripts/testing/coordinator-upstream.ts`:

Add constants and helpers (below the existing env keys at the top):

```typescript
const PHASE_TIMEOUT_ENV_KEY = 'FRESHELL_TEST_COORDINATOR_PHASE_TIMEOUT_MS'
const PHASE_WATCH_POLL_ENV_KEY = 'FRESHELL_TEST_COORDINATOR_PHASE_WATCH_POLL_MS'
const DEFAULT_PHASE_TIMEOUT_MS = 2 * 60 * 60 * 1000
const DEFAULT_PHASE_WATCH_POLL_MS = 10_000

export const PHASE_WATCHDOG_EXIT_CODE = 125

export type PhaseWatchdogReason = 'phase_timeout' | 'child_vanished'

function parsePositiveIntEnv(envVars: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const parsed = Number.parseInt(envVars[key] ?? '', 10)
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
```

Replace `spawnAndWait` with the watchdog-armed version (preserving the existing `error`→reject and `exit`→code semantics exactly):

```typescript
function spawnAndWait(
  command: string,
  args: string[],
  envVars: NodeJS.ProcessEnv,
  viaShell: boolean,
): Promise<number> {
  const pollMs = parsePositiveIntEnv(envVars, PHASE_WATCH_POLL_ENV_KEY, DEFAULT_PHASE_WATCH_POLL_MS)
  const timeoutMs = parsePositiveIntEnv(envVars, PHASE_TIMEOUT_ENV_KEY, DEFAULT_PHASE_TIMEOUT_MS)

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
      const childAlive = isChildAlive(child.pid)
      consecutiveDeadTicks = childAlive === false ? consecutiveDeadTicks + 1 : 0
      const reason = evaluatePhaseWatchdogTick({
        childAlive,
        consecutiveDeadTicks,
        elapsedMs: Date.now() - startedAtMs,
        timeoutMs,
      })

      if (reason === undefined) {
        return
      }

      // The child hung (or its completion signal was lost with the process
      // gone): fail the phase instead of awaiting forever. SIGKILL because a
      // hung runner must not survive the failed run.
      emitPhaseWatchdogEvent(reason, {
        pid: child.pid,
        elapsedMs: Date.now() - startedAtMs,
        pollMs,
        timeoutMs,
      })
      if (reason === 'phase_timeout') {
        child.kill('SIGKILL')
      }
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
```

Note the dead-tick accounting runs on every tick (before the decision, so the current tick counts) and resets to 0 whenever the child is observably alive; `consecutiveDeadTicks >= 2` therefore means two consecutive provably-dead polls separated by a full poll interval — the grace that keeps a normally-observed exit (whose `exit` event is merely queued) from being misread as a lost completion.

- [ ] **Step 4: Run the focused test**

Run: `pnpm run test:vitest run test/unit/tooling/testing/coordinator-upstream.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS (all new + existing cases in the file).

- [ ] **Step 5: Refactor while green**

Check for duplication between the watchdog's liveness probe and `coordinator-store.ts`'s `isProcessAlive`: both use `process.kill(pid, 0)` with EPERM-as-alive. They stay separate — the store's is private and file-local by design; hoisting a shared util across store/upstream modules is churn without benefit at this size. State this conclusion in the task review; no refactor needed.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: every consumer of `spawnAndWait`/`runUpstreamPhase` and all coordinator tooling tests (`test/unit/tooling/testing/`), plus the scripts lane that covers prepush-manager and related tooling (`test/unit/scripts/`), plus typecheck.

Run: `pnpm run test:vitest run test/unit/tooling/testing test/unit/scripts --config config/vitest/vitest.config.ts && pnpm run typecheck`

Expected: PASS (the workspace-baseline receipt at base_ref was 14 files / 122 tests green; this lane must stay green with the additions).

- [ ] **Step 7: Commit the task**

```bash
git add scripts/testing/coordinator-upstream.ts test/unit/tooling/testing/coordinator-upstream.test.ts
git commit -m "feat(coordinator): fail hanging phase children via a bounded phase watchdog

A dispatched phase whose child exceeds FRESHELL_TEST_COORDINATOR_PHASE_TIMEOUT_MS
(default 2h) is SIGKILLed and settles the phase with exit 125 plus a
phase_watchdog_settled JSONL event, instead of awaiting forever while holding
the repo-wide gate (kata freshell#t4c8, 2026-09-22 incident class)."
```

---

### Task 2: Dead-child detection (the lost-completion branch)

**Files:**
- Modify: `test/fixtures/testing/fake-coordinated-workload.mjs` (add `pid` to the capture record)
- Modify: `scripts/testing/coordinator-upstream.ts` (only if the tick accounting from Task 1 needs a fix — the branch itself is already wired by `evaluatePhaseWatchdogTick`'s `child_vanished` arm)
- Test: `test/unit/tooling/testing/coordinator-upstream.test.ts` (add cases)

**Interfaces:**
- Consumes: Task 1's `evaluatePhaseWatchdogTick`, `PHASE_WATCHDOG_EXIT_CODE`, watchdog wiring, `fakeEnv` knob options.
- Produces: the fixture capture record now includes `pid: number` (the fixture process's own pid) — Task 3's e2e also consumes this.

- [ ] **Step 1: Write the failing behavioral tests**

Fixture change (`test/fixtures/testing/fake-coordinated-workload.mjs`, in the `captureFile` block):

```javascript
  await fs.appendFile(
    captureFile,
    `${JSON.stringify({
      selector: payload.selector,
      command: payload.command,
      args: payload.args,
      pid: process.pid,
      active: process.env.FRESHELL_TEST_COORDINATOR_ACTIVE,
    })}\n`,
  )
```

New cases in `test/unit/tooling/testing/coordinator-upstream.test.ts`:

```typescript
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

    const deadline = Date.now() + 10_000
    let pid: number | undefined
    while (pid === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      const lines = await fsp.readFile(captureFile, 'utf8').catch(() => '')
      const parsed = lines.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      pid = parsed.find((entry) => entry.selector === 'npm:test:balanced')?.pid
    }
    expect(pid).toBeGreaterThan(0)

    process.kill(pid!, 'SIGKILL')

    const expectedExitCode = process.platform === 'win32'
      ? 1
      : 128 + osConstants.signals.SIGKILL
    await expect(exitPromise).resolves.toBe(expectedExitCode)
  }, 20_000)

  it('reaps the phase child it kills on timeout', async () => {
    const exitPromise = runUpstreamPhase({
      runner: 'npm',
      script: 'test:balanced',
      args: [],
    }, fakeEnv({
      'npm:test:balanced': { holdMs: 30_000 },
    }, {
      phaseWatchPollMs: '25',
      phaseTimeoutMs: '250',
    }))

    await expect(exitPromise).resolves.toBe(PHASE_WATCHDOG_EXIT_CODE)

    const deadline = Date.now() + 5_000
    let pid: number | undefined
    while (pid === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      const lines = await fsp.readFile(captureFile, 'utf8').catch(() => '')
      const parsed = lines.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      pid = parsed.find((entry) => entry.selector === 'npm:test:balanced')?.pid
    }
    expect(pid).toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(() => process.kill(pid!, 0)).toThrow()
  }, 20_000)
```

(Write the two cases exactly; the second uses the fixture's newly captured `pid` to prove the SIGKILLed child is really gone rather than leaked into the background.)

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `pnpm run test:vitest run test/unit/tooling/testing/coordinator-upstream.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL — the capture record has no `pid` field, so `expect(pid).toBeGreaterThan(0)` fails (undefined), proving the fixture seam is not yet in place. The kill-verification case then cannot run.

- [ ] **Step 3: Add the minimal production implementation**

Apply the fixture `pid` capture shown in Step 1. No `coordinator-upstream.ts` change is expected — Task 1 already wired the `child_vanished` arm. If the killed-outside case flakes because the watchdog's dead-tick grace can theoretically race a real `exit` delivery, fix the accounting in the watchdog tick (never weaken the two-tick grace; the real `exit` event must always win when it is deliverable).

- [ ] **Step 4: Run the focused test**

Run: `pnpm run test:vitest run test/unit/tooling/testing/coordinator-upstream.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS — the signal-mapped kill settles at `128 + SIGKILL` (the real exit event beats the grace), and the timeout-killed child is provably reaped.

- [ ] **Step 5: Refactor while green**

The two poll-for-capture loops are near-duplicates. Extract a local `async function waitForCapturePid(selector: string): Promise<number>` helper in the test file and use it in both cases. Re-run Step 4's command; expected PASS.

- [ ] **Step 6: Run impacted-test verification**

Any test that reads the fixture capture record may observe the new `pid` field: run the whole coordinator tooling lane.

Run: `pnpm run test:vitest run test/unit/tooling/testing test/unit/scripts --config config/vitest/vitest.config.ts && pnpm run typecheck`

Expected: PASS. (Existing `toMatchObject` assertions select named fields, so the added `pid` field is additive; verify no strict-equality assertion on the full capture record exists — if one does, update it to include `pid`.)

- [ ] **Step 7: Commit the task**

```bash
git add test/fixtures/testing/fake-coordinated-workload.mjs test/unit/tooling/testing/coordinator-upstream.test.ts
git commit -m "test(coordinator): prove dead-child detection and timeout reaping with pid capture"
```

---

### Task 3: End-to-end incident replay through the real coordinator + docs

**Files:**
- Create: `test/integration/tooling/coordinator-watchdog-replay.test.ts`
- Modify: `AGENTS.md` (Test Coordination section: two lines for the new knobs)

**Interfaces:**
- Consumes: Task 1–2 watchdog (env knobs), the fixture seam, `tsx` CLI (`require.resolve('tsx/cli')` — precedent `test/unit/config/sanitize-test-env.test.ts:10`), `buildCoordinatorEndpoint` + `tryListen` from `scripts/testing/coordinator-endpoint.js`, `getCoordinatorStoreDir` from `scripts/testing/coordinator-store.js`, `readHolder` from `scripts/testing/coordinator-store.js`.
- Produces: the incident-replay proof (coordinator child fails fast, releases gate, records the failure) and the agent-facing documentation of the knobs.

- [ ] **Step 1: Write the failing e2e test**

`test/integration/tooling/coordinator-watchdog-replay.test.ts`:

```typescript
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

function run(command: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd })
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

async function runCoordinatorIn(repo: string, commonDir: string, behavior: Record<string, unknown>): Promise<CoordinatorOutcome> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FRESHELL_TEST_COORDINATOR_FAKE_UPSTREAM: FIXTURE_PATH,
    FRESHELL_TEST_COORDINATOR_FAKE_BEHAVIOR: JSON.stringify(behavior),
    FRESHELL_TEST_COORDINATOR_REPO_ROOT: REPO_ROOT,
    FRESHELL_TEST_COORDINATOR_PHASE_WATCH_POLL_MS: '50',
    FRESHELL_TEST_COORDINATOR_PHASE_TIMEOUT_MS: '400',
    FRESHELL_TEST_SUMMARY: 'watchdog replay',
  }
  delete env.FRESHELL_TEST_COORDINATOR_ACTIVE

  const result = await run(process.execPath, [tsxCli, COORDINATOR_PATH, 'run', 'test'], repo)
  return { ...result, storeDir: getCoordinatorStoreDir(commonDir) }
}

const WEDGE_BEHAVIOR: Record<string, unknown> = {
  'npm:test:balanced': { holdMs: 5_000 },
}

describe('coordinator phase watchdog end to end', () => {
  it('fails the run, releases the gate, and records the failure when a phase child wedges', { timeout: 60_000 }, async () => {
    const { repo, commonDir } = await makeTempGitRepo()

    const outcome = await runCoordinatorIn(repo, commonDir, WEDGE_BEHAVIOR)

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
    const { repo, commonDir } = await makeTempGitRepo()

    const outcome = await runCoordinatorIn(repo, commonDir, {
      'npm:test:balanced': { exitCode: 0 },
    })

    expect(outcome.code).toBe(0)
    expect(outcome.stderr).not.toContain('phase_watchdog_settled')
    await expect(readHolder(outcome.storeDir)).resolves.toBeUndefined()
  })

  it('records the watchdog failure as a run result other agents can see', { timeout: 60_000 }, async () => {
    const { repo, commonDir } = await makeTempGitRepo()

    const outcome = await runCoordinatorIn(repo, commonDir, WEDGE_BEHAVIOR)

    expect(outcome.code).toBe(125)
    const raw = await fsp.readFile(path.join(outcome.storeDir, 'latest-runs.json'), 'utf8')
    const parsed = JSON.parse(raw) as { byKey: Record<string, { exitCode: number }> }
    expect(Object.values(parsed.byKey).some((entry) => entry.exitCode === 125)).toBe(true)
  })
})
```

The red-run shape is deliberate: with `holdMs: 5_000` and no watchdog yet in place, the coordinator at base waits out the child's clean 5s exit and finishes green, so the first case fails fast on `expect(outcome.code).toBe(125)` (expected 0, received green run) without wedging the test runner or leaking a 60-second child. After Tasks 1–2, the watchdog fires at ~400ms — long before the child's own exit — so the same behavior stays a genuine wedge for the watchdog to catch.

Before finalizing the file, the implementer must verify against the real source and adjust (these are load-bearing details, not trivia):
- `tryListen`'s exact export name and result union (architecture report cites `coordinator-endpoint.ts:80-110`).
- `readHolder`'s exact signature/return type (it exists in `coordinator-store.ts` near `writeHolder`).
- `latest-runs.json` filename — read the constant in `coordinator-store.ts` and use that exact name (do not invent one).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `pnpm run test:vitest run test/integration/tooling/coordinator-watchdog-replay.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL — at base the coordinator has no watchdog, so the wedge case's child exits cleanly after its 5s hold and the coordinator finishes green; the case fails fast on `expect(outcome.code).toBe(125)` (received 0), and the remaining assertions fail on the missing `phase_watchdog_settled` event. No test-runner wedge and no long-lived leaked children.

- [ ] **Step 3: Add the minimal production implementation**

There is no new production code in this task if Tasks 1–2 are complete: the coordinator's existing failure plumbing must carry the watchdog settle to the recorded run result and the cleared holder. If any of the three cases fail, fix the cause in the coordinator (`test-coordinator.ts` `runCoordinatedCommand` catch/finally), not in the test — the run record must show exit 125 and `holder.json` must be cleared by the existing `finally`.

- [ ] **Step 4: Run the focused test**

Run: `pnpm run test:vitest run test/integration/tooling/coordinator-watchdog-replay.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS (all three cases).

- [ ] **Step 5: Refactor while green**

Deduplicate the store-dir resolution inside the test file (one helper, used by all cases). Re-run Step 4; expected PASS.

- [ ] **Step 6: Run impacted-test verification + docs**

Add the agent-facing knob documentation to `AGENTS.md` in the Test Coordination section (after the `test:status` bullet):

```markdown
- Phase-child watchdog: a dispatched phase child that wedges or whose completion signal is lost fails the run with exit 125 (JSONL `phase_watchdog_settled` on stderr) and releases the gate instead of holding it indefinitely. Knobs: `FRESHELL_TEST_COORDINATOR_PHASE_TIMEOUT_MS` (default 7200000 = 2h, hard per-phase cap; a hung child is SIGKILLed) and `FRESHELL_TEST_COORDINATOR_PHASE_WATCH_POLL_MS` (default 10000, liveness poll cadence; two consecutive dead polls settle a lost completion).
```

Then run the full impacted set: the coordinator lane plus the new integration file.

Run: `pnpm run test:vitest run test/unit/tooling/testing test/unit/scripts test/integration/tooling/coordinator-watchdog-replay.test.ts --config config/vitest/vitest.config.ts && pnpm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add test/integration/tooling/coordinator-watchdog-replay.test.ts AGENTS.md
git commit -m "test(coordinator): e2e incident replay proves the watchdog fails fast and frees the gate"
```

---

## Final whole-branch verification (after Task 3)

Run the repo's broad coordinated suite from the worktree per the repo's documented full-suite procedure (`pnpm run test` — it queues on the shared coordinator gate like any broad run), expecting green with no pre-existing failures (baseline ledger: none). This is the whole-branch gate required before the delta review; its receipt goes in the run record.
