# Cloud-Lane Test-Budget Deflake (kata tg4e) Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
- Campaign context (the end state several runs build toward): the `main` branch's test gates are green, meaning the coordinated e2e lane at `origin/main` produces a zero-flake receipt — reached by SEPARATE the-usual runs, each fixing ONE flaky test and landing on main via its own PR.
- THIS RUN's deliverable: fix exactly one flaky test — `host-stats-pane.spec.ts:47` "opens a System Status pane from the pane picker" (kata tg4e, freshellPage setup timeout: `Test timeout of 60000ms exceeded while setting up "freshellPage"`) — completely enough that the tg4e failure mode is eliminated from the harness (its own spec and the harness defects that produced it), and land it on main via PR if the delta review passes. The lane's OTHER pre-existing flakes are the campaign's remaining runs, not this run's scope.

### Explicit constraints
- Fix one test at a time: this run's scope is the single kata tg4e flake; the other three baseline flakes (katas 38hj, 5kyg, ebp6) are out of scope and recorded as pre-existing failures.
- Up to 15 delta review rounds are authorized for this run's delta review (overriding the default cap of 5).
- If this run's delta review finishes with PASSED, it is pre-approved to be PR'd onto main and merged once required checks pass (repo rules: self-merge is the norm).
- Red-Green-Refactor TDD; fix the system over the symptom; e2e proof on the configured cloud backend; never reduce coverage or loosen assertions to hide flakes.
- After main is green (later runs), tackle the flake katas backlog (phase 2, not this run).

### Accepted tradeoffs and residuals
- None stated by the user.

**Goal:** Eliminate the `host-stats-pane.spec.ts:47` freshellPage setup-timeout flake by fixing the three harness defects that jointly produced it: (1) the self-healing `waitForConnection` lets its phases, reload, and final poll each consume their own full window (a sequential 3-window drift up to 135s at W=90s) instead of enforcing W as a single total deadline; (2) the per-test deadline (60s) is smaller than the fixture chain's evidence-shaped envelope on the cloud lane (only `settings.spec.ts` got a hook-based 120s extension); (3) `selectShellFromPicker` — the piece the retained trace proves was the actual budget burner — conflates a slow terminal render with "wrong shell option", silently escalates through options that do not exist on this platform, swallows every error, and double-creates terminals.

**Architecture:** The retained attempt-1 trace (validator report, LB-C) shows the recorded failure was NOT the j90s zero-CPU wedge: the boot chain completed, WS ready landed at t0+23s (inside phase 1 — no self-heal reload), the fixture clicked "Shell" (terminal created server-side, active with `hasClients:true`), but the `.xterm` render starved >30s under container-wide CPU contention (54% CPU, a sibling worker's normally-200ms test took 74s in the same window). The loop's 30s `.xterm` wait failed, and the loop escalated — WSL (5s click timeout), CMD (mid-click at the 60s deadline) — options absent on the Linux picker, silently burning the remaining budget. The fix makes the harness envelope coherent and covered: `waitForConnection` enforces W as a single total deadline (phase-1 `floor(W/2)`; the reload and phase-2 share the remainder, +1s slack — the documented design intent and the j90s recap's Optional finding #4); the per-test budget derives from the same env that scales the window (`FRESHELL_E2E_WS_READY_TIMEOUT_MS`) and COVERS the chain's permitted composition (connection envelope W+1s + the picker's permitted worst case + start reserve = 206.5s at the cloud default; delta-review r2), applied as an EXTEND-ONLY maximum from inside the earliest test-scoped fixture (`e2eMachineId`, resolved before `context`/`page` for every module-chain spec); and `selectShellFromPicker` distinguishes an absent option (click TimeoutError — advance) from a successful click (wait generously for the render, fail loudly on timeout — never escalate). The local lane (env unset) keeps the default budget; the picker's healthy path is unchanged.

**Tech Stack:** Playwright 1.58.2 fixtures and `test.info().setTimeout`, TypeScript (NodeNext/ESM — relative imports in test files carry `.js`; type-only imports stay type-only), Vitest for the e2e-helpers unit lane (fake timers for clock-sensitive coherence tests), the repo's cloud e2e lane (`scripts/e2e-cloud.sh`) for proof.

## Global Constraints

- Budget changes are cloud-only and env-gated: with `FRESHELL_E2E_WS_READY_TIMEOUT_MS` unset, no timeout changes and no different call shapes on the default path (byte-identical local lane for the budget dimension).
- `waitForConnection`'s self-heal window W is a SINGLE TOTAL deadline: phase-1 + the reload's navigation + phase-2 share W (+1s slack), so the connection-wait envelope is W+1s (91s at the cloud window) — the budget never needs to cover a multi-W envelope. The pre-fix sequential drift (up to 135s) is fixed at the source (Task 2), not budgeted around.
- Budget = the fixture chain's PERMITTED COMPOSITION (delta-review r2): connection envelope (W + 1s total-deadline slack) + the picker's permitted worst case (derived from the picker's own exported constants — settle + one click budget per shell name + the render wait = 85.5s) + start/body reserve (30s) = 206.5s at the cloud default W=90s, unit-pinned so the composition cannot drift. A budget merely "evidence-sized" to the recorded episodes was rejected by review: the retained trace shows connection AND render slowness co-occurring in one container-wide disturbance, so the outer deadline must cover the waits the chain is permitted to compose, or the same outer setup-timeout flake recurs before the picker's diagnostic can fire. The extend-only guard keeps every declared budget >= the composition untouched (300s/240s/180s specs keep theirs).
- The wiring is EXTEND-ONLY (`test.info().timeout < budget` guard): a spec's own declared deadline (e.g. idle-gate-semantics' 300_000, the reconcile specs' 240_000) must never be shrunk by the cloud budget. The contract spec pins this.
- The self-heal stays cloud-only (env-presence gated) and fresh-boot-only: never opt a mid-test `waitForConnection` site into `selfHealReload` (a reload would destroy the state under test).
- Never loosen the ready assertion, never skip or exclude specs, never raise `retries`, never widen `CLOUD_SKIP_SPECS` — those are coverage reductions, not fixes. The picker fix TIGHTENS failure semantics (a thrown diagnostic replaces a silent fall-through past a successful click; non-timeout click errors propagate); it must not touch any passing-path assertion.
- Malformed env values must never poison the budget (reuse `resolveWsReadyTimeoutMs`'s parsing/fallback — one parsing rule).
- A budget that covers the evidence-shaped envelope must not silently become a per-test entitlement: assertions and waits inside test bodies keep their own explicit timeouts.
- The other three baseline flakes (kata 38hj `restore-contract-wall-rust.spec.ts:579`, kata 5kyg `recover-my-panes-rust.spec.ts:733`, kata ebp6 `reconcile-client-adoption-rust.spec.ts:542`) are pre-existing failures at base_ref 39192e8aa and stay out of scope; they are the campaign's next one-test-at-a-time steps.
- The gVisor wedge and container-slowness episodes are infra-layer and cannot be deterministically forced; acceptance evidence is (a) the budget arithmetic and total-deadline coherence (unit-pinned), (b) the contract spec proving the wiring under the env-present path, (c) the picker loop's new contract (unit-pinned: no escalation after a successful click; the render wait receives `SHELL_RENDER_TIMEOUT_MS`; loud timeout; non-timeout click errors propagate), and (d) zero-flake cloud receipts for the affected spec at the committed HEAD.
- Accepted residuals, deliberately out of scope (recorded so the reviewer sees conscious scoping): (a) the client's timeout-less boot fetches (App.tsx:1691-1753, api.ts:181) remain unbounded — that product-level hardening is the qq5m flake class, tracked by its own kata and later campaign runs; the fixes here make single infra episodes survivable without it. (b) The budget covers the fixture chain's permitted composition but not unbounded TEST-BODY work (bodies keep their own declared/explicit timeouts) and not the goto/waitForHarness maxima — both fail with their own distinct timeout signatures long before the outer deadline, never the "while setting up freshellPage" signature this run eliminates. (c) `waitForHarness`'s decorative 15s (real 30s) is a known cosmetic quirk not implicated in this flake. (d) Raw-base specs that import `test` from `@playwright/test` directly and boot the app in-body (terminal-escape-key-rust, cli-rust, silent-input-loss-rust, sidebar-registry-sync-rust, sidebar-remote-status-rings-rust, sidebar-status-tier-sort-rust, diag03-rotation-redaction-rust — load-bearing LB-B2) never resolve `e2eMachineId`; they keep the same 60s deadline they have today. This run does not regress them and does not cover them; they are tracked by kata j96j and addressed by a later campaign step.
- The full e2e lane at the run HEAD is part of this run's final gate (`npm run test:e2e`, cloud backend); PR checks do not run e2e on this repo, so the lane must be run explicitly.

---

### Task 1: `resolveCloudLaneTestBudgetMs` resolver + unit tests

**Files:**
- Modify: `test/e2e-browser/helpers/test-harness.ts` (after `resolveWsReadyTimeoutMs`, near `DEFAULT_WS_READY_TIMEOUT_MS`)
- Test: `test/e2e-browser/helpers/test-harness.test.ts` (new `describe` block after `resolveWsReadyTimeoutMs`'s)

**Interfaces:**
- Consumes: `resolveWsReadyTimeoutMs(explicitMs, env)` (test-harness.ts:25-40), `DEFAULT_WS_READY_TIMEOUT_MS` (test-harness.ts:12), env key `FRESHELL_E2E_WS_READY_TIMEOUT_MS` (set to `90000` on the cloud lane by `scripts/e2e-cloud.sh:547`).
- Produces (as amended by delta-review rounds 1-3): `isCloudLaneWindowConfigured(env?): boolean` (ONE presence rule — present AND non-empty), `shellPickerWorstCaseMs(): number` (the picker's permitted worst case derived from its own exported constants), `CLOUD_LANE_START_RESERVE_MS: number` (30_000), and `resolveCloudLaneTestBudgetMs(env?): number | null` — `null` when the window env is not configured (local lane: caller must not extend anything), otherwise the permitted composition: `resolveWsReadyTimeoutMs(undefined, env) + 1000 + shellPickerWorstCaseMs() + CLOUD_LANE_START_RESERVE_MS` (206.5s at the cloud default).

- [ ] **Step 1: Write the failing behavioral test**

Add to `test/e2e-browser/helpers/test-harness.test.ts` (match the file's existing vitest style — imports from `'./test-harness'`, `describe`/`it`; add `CLOUD_LANE_BUDGET_OVERHEAD_MS` and `resolveCloudLaneTestBudgetMs` to the existing import from `'./test-harness'`):

```ts
describe('resolveCloudLaneTestBudgetMs', () => {
  it('returns null when the cloud window env is absent (local lane budget untouched)', () => {
    expect(resolveCloudLaneTestBudgetMs({})).toBeNull()
  })

  it('returns null when the cloud window env is empty', () => {
    expect(resolveCloudLaneTestBudgetMs({ [ENV_VAR]: '' })).toBeNull()
  })

  it('covers the permitted composition at the cloud default window (delta review r2)', () => {
    // W=90s: connection envelope (W + 1s total-deadline slack) = 91_000;
    // picker worst case (settle + at most 5 clicks + the render wait) =
    // 500 + 5 * 5_000 + 60_000 = 85_500; start reserve 30_000. Total 206_500.
    expect(resolveCloudLaneTestBudgetMs({ [ENV_VAR]: '90000' })).toBe(206_500)
  })

  it('scales with the configured window (60s -> 176_500)', () => {
    expect(resolveCloudLaneTestBudgetMs({ [ENV_VAR]: '60000' })).toBe(176_500)
  })

  it('falls back to the default window composition on malformed values (one parsing rule)', () => {
    for (const malformed of ['not-a-number', '0', '-5']) {
      expect(resolveCloudLaneTestBudgetMs({ [ENV_VAR]: malformed }))
        .toBe(30_000 + 1_000 + shellPickerWorstCaseMs() + CLOUD_LANE_START_RESERVE_MS)
    }
  })

  it('always covers the permitted composition: connection envelope + picker worst + start reserve', () => {
    for (const windowMs of ['30000', '45000', '90000', '150000']) {
      const budget = resolveCloudLaneTestBudgetMs({ [ENV_VAR]: windowMs })
      expect(budget).not.toBeNull()
      expect(budget!).toBeGreaterThanOrEqual(
        Number(windowMs) + 1_000 + shellPickerWorstCaseMs() + CLOUD_LANE_START_RESERVE_MS,
      )
    }
  })
})

describe('shellPickerWorstCaseMs (single source for the picker budget pieces)', () => {
  it('derives from the picker\'s real constants: settle + one click budget per shell name + the render wait', () => {
    expect(shellPickerWorstCaseMs()).toBe(
      SHELL_PICKER_SETTLE_MS
        + SHELL_NAMES.length * SHELL_CLICK_TIMEOUT_MS
        + SHELL_RENDER_TIMEOUT_MS,
    )
  })
})

describe('isCloudLaneWindowConfigured (one presence rule for every cloud-lane gate)', () => {
  it('is false when the env key is absent', () => {
    expect(isCloudLaneWindowConfigured({})).toBe(false)
  })

  it('is false when the env key is empty (empty means unset — a stray empty export must not arm self-heal without the budget that covers it)', () => {
    expect(isCloudLaneWindowConfigured({ [ENV_VAR]: '' })).toBe(false)
  })

  it('is true when the env key is present and non-empty (including malformed values, which the window parser safely falls back)', () => {
    expect(isCloudLaneWindowConfigured({ [ENV_VAR]: '90000' })).toBe(true)
    expect(isCloudLaneWindowConfigured({ [ENV_VAR]: 'not-a-number' })).toBe(true)
  })

  it('agrees with the budget resolver on presence (coherence)', () => {
    for (const env of [{}, { [ENV_VAR]: '' }, { [ENV_VAR]: '0' }, { [ENV_VAR]: '90000' }]) {
      expect(resolveCloudLaneTestBudgetMs(env) !== null).toBe(isCloudLaneWindowConfigured(env))
    }
  })
})

```

(The listing above is the committed implementation of this task as amended by the delta-review remediations — the original draft derived the budget as window+30s; the committed derivation covers the fixture chain's permitted composition, delta review r2.)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:e2e:helpers -- test-harness`

Expected: FAIL because the new exports (`resolveCloudLaneTestBudgetMs`, `isCloudLaneWindowConfigured`, `shellPickerWorstCaseMs`, the picker constants, `CLOUD_LANE_START_RESERVE_MS`) are missing from `./test-harness` — the suite reports the missing exports and cannot assert the composed budget derivation (the behavior is absent).

- [ ] **Step 3: Add the minimal production implementation**

In `test/e2e-browser/helpers/test-harness.ts`, directly after `resolveWsReadyTimeoutMs`:

```ts
/**
 * Start/body reserve added to the connection and picker envelopes when
 * computing the cloud-lane per-test budget: healthy page.goto +
 * waitForHarness (~3s — their maxima are self-limiting: each throws its
 * own distinct navigation/wait timeout well before the test deadline) and
 * a body-start margin for the test's first steps.
 */
export const CLOUD_LANE_START_RESERVE_MS = 30_000

/**
 * Whether the cloud-lane window env key is configured (present AND
 * non-empty). ONE presence rule for every cloud-lane gate — the
 * freshellPage self-heal opt-in, settings' mid-test reload-leg opt-in,
 * and the per-test budget resolver (kata tg4e): an empty value means
 * "unset", exactly as a malformed value means "default" inside
 * resolveWsReadyTimeoutMs. A stray empty export must never arm the
 * self-heal while the budget resolver treats it as local (the incoherent
 * state delta-review round 1 flagged: self-heal at the 30s default
 * window plus the 60s render wait under the unchanged 60s deadline).
 */
export function isCloudLaneWindowConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.FRESHELL_E2E_WS_READY_TIMEOUT_MS
  return raw !== undefined && raw !== ''
}

/**
 * The permitted worst case of the shell-picker leg of the freshellPage
 * fixture, derived from the picker's OWN exported constants so it can
 * never drift from the implementation (delta-review r2): the
 * stabilization settle, at most one click budget per shell name (every
 * path through the loop makes at most SHELL_NAMES.length clicks, each
 * bounded by SHELL_CLICK_TIMEOUT_MS — including the successful one), and
 * at most one render wait.
 */
export function shellPickerWorstCaseMs(): number {
  return SHELL_PICKER_SETTLE_MS
    + SHELL_NAMES.length * SHELL_CLICK_TIMEOUT_MS
    + SHELL_RENDER_TIMEOUT_MS
}

/**
 * Resolve the cloud-lane per-test deadline budget, or null on the local
 * lane (kata tg4e). The budget COVERS THE PERMITTED COMPOSITION of the
 * fixture chain (delta-review r2): the connection envelope (waitForConnection
 * enforces its window W as a single total deadline, W + 1s slack) plus the
 * picker's permitted worst case plus a start/body reserve. The config's 60s
 * default deadline kills fixture setup mid-composition ("Test timeout of
 * 60000ms exceeded while setting up freshellPage" — the recorded tg4e flake,
 * whose retained trace shows connection AND render slowness co-occurring
 * in one container-wide disturbance). The budget derives from the SAME env
 * that scales the window (one source of truth, one parsing rule via
 * resolveWsReadyTimeoutMs) so a custom window scales the budget with it.
 * Callers must treat null as "do not touch the deadline" — the local
 * lane keeps the config default unchanged — and must apply the budget
 * EXTEND-ONLY (never shrink a declared deadline).
 */
export function resolveCloudLaneTestBudgetMs(
  env: Record<string, string | undefined> = process.env,
): number | null {
  if (!isCloudLaneWindowConfigured(env)) return null
  const connectionEnvelopeMs = resolveWsReadyTimeoutMs(undefined, env) + 1000
  return connectionEnvelopeMs + shellPickerWorstCaseMs() + CLOUD_LANE_START_RESERVE_MS
}

/**
 * The ready predicate shared by every waitForConnection phase. Must stay a
 * self-contained serializable function (Playwright ships its source to the
 * page): no closures over harness state.
 */
function wsReadyPredicate(): boolean {
  const harness = window.__FRESHELL_TEST_HARNESS__
  if (!harness) return false
  const reduxStatus = harness.getState()?.connection?.status
  return harness.getWsReadyState() === 'ready' && reduxStatus === 'ready'
}

export interface WaitForConnectionOptions {
  /**
   * Opt-in, ONE-SHOT mid-wait self-heal for fresh-boot waits (kata j90s).
   * When ready has not landed by half the resolved window, reload the page
   * once — a fresh boot chain is the observed recovery path from the
   * gVisor I/O wedge class, where a timeout-less boot fetch hangs and the
   * WS can never start regardless of window size (see the j90s stall
   * investigation) — then keep waiting with the remaining budget. The final
   * phase still throws Playwright's native TimeoutError: the assertion is
   * not loosened, only a transiently wedged boot is retried.
   *
   * Default OFF — every existing call site keeps its single-poll semantics.
   * Only fresh-boot sites (the freshellPage fixture, post-goto reload legs)
   * may opt in; a mid-test recovery wait must NOT (a reload would destroy
   * the state under test).
   */
  selfHealReload?: boolean
}

```

- [ ] **Step 4: Run the focused test**

Run: `npm run test:e2e:helpers -- test-harness`

Expected: PASS (new describe green; all pre-existing harness tests still green).

- [ ] **Step 5: Refactor while green**

Placement and naming only; keep the resolver adjacent to `resolveWsReadyTimeoutMs` so the two env-reading rules stay visually paired.

- [ ] **Step 6: Run impacted-test verification**

The resolver is new, unreferenced production code; the impacted set is the whole e2e-helpers unit lane.

Run: `npm run test:e2e:helpers`

Expected: PASS (the entire lane, not just test-harness).

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/helpers/test-harness.ts test/e2e-browser/helpers/test-harness.test.ts
git commit -m "test(e2e): add cloud-lane per-test budget resolver (kata tg4e)"
```

### Task 2: `waitForConnection` self-heal enforces W as one absolute total deadline

**Files:**
- Modify: `test/e2e-browser/helpers/test-harness.ts` (the self-healing branch of `waitForConnection`, test-harness.ts:101-126)
- Test: `test/e2e-browser/helpers/test-harness.test.ts` (the `TestHarness.waitForConnection wedge-tolerant self-heal (opt-in)` describe: update tests (c)/(d), add test (f), extend `fakePage` with a reload clock-advance option)

**Interfaces:**
- Consumes: the existing `fakePage(outcomes)` helper, `DEFAULT_WS_READY_TIMEOUT_MS`, `vi` from vitest (add to the existing vitest import).
- Produces: self-heal semantics where phase-1 = `floor(W/2)`, the reload's navigation timeout = the remainder, and phase-2's poll = `max(0, remainder - reloadElapsedMs) + 1000` — the whole self-heal path spends at most W + 1s wall clock, instead of each of the three steps independently consuming a full window (up to 135s at W=90s, a sequential drift that outgrew any per-test budget). Non-self-heal (`selfHealReload` absent) semantics are untouched: single poll, `W + 1000`.

**Why this is required scope:** the budget (Task 3) is sized W + 30s; with the current 3-full-windows drift, a wedge that survives phase 1 and has a slow reload legally burns 135s of connection wait alone — more than the entire budget — recreating the recorded failure class. The j90s design intent ("keeps waiting with the remaining budget") and the j90s recap's Optional finding #4 both call for exactly this total-deadline enforcement; this run lands it.

- [ ] **Step 1: Write the failing behavioral tests (the complete new contract, RED as one unit)**

In `test-harness.test.ts`, extend `fakePage` to support a reload that advances the (fake) clock, wrap the affected tests in the fake clock for determinism, update tests (c)/(d) to the total-deadline expectations, and add test (f). All of these are the RED suite: the implementation must take them to green in one Green step, with no assertion changes after implementation (Refactor happens while green).

(a) Extend `fakePage` (add an optional second parameter; keep every existing call site working unchanged):

```ts
function fakePage(
  outcomes: FakeWaitOutcome[] = [],
  opts: { reloadAdvanceMs?: number } = {},
) {
  // ...existing body unchanged except the reload fake:
  //   reload: (...args: unknown[]) => {
  //     reloads.push(args)
  //     if (opts.reloadAdvanceMs) vi.setSystemTime(Date.now() + opts.reloadAdvanceMs)
  //     return Promise.resolve()
  //   },
}
```

(b) Add `vi` to the existing `vitest` import. Wrap tests (c)/(d)/(f)/(g) each in `vi.useFakeTimers({ toFake: ['Date'] })` / `try { ... } finally { vi.useRealTimers() }` (the fake clock makes elapsed time exactly controlled). The absolute-deadline expectations (as amended by delta review r3 — the clock starts BEFORE phase 1):

```ts
  it('(c) self-heal ON + phase-1 timeout: exactly ONE reload, then a second poll bounded by the absolute deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const phase1 = Math.floor(DEFAULT_WS_READY_TIMEOUT_MS / 2)
      const remaining = DEFAULT_WS_READY_TIMEOUT_MS - phase1
      const { page, calls, reloads } = fakePage([{ reject: nativeTimeout(phase1) }, {}])
      await new TestHarness(page).waitForConnection(undefined, { selfHealReload: true })
      expect(reloads).toHaveLength(1)
      expect(reloads[0]).toEqual([{ timeout: remaining }])
      expect(calls).toHaveLength(2)
      // The three-argument binding contract holds for BOTH phases (LB-1):
      // a two-arg second poll would silently revert to the decorative-window
      // bug this kata already fixed once.
      expect(calls[1]).toHaveLength(3)
      expect(calls[1][1]).toBeUndefined()
      // Absolute-deadline contract: the clock starts BEFORE phase 1, so
      // with the fake clock's elapsed 0 phase 2 receives the whole window
      // W minus nothing (+1s slack) — never a fresh multi-window envelope.
      expect(calls[1][2]).toEqual({ timeout: DEFAULT_WS_READY_TIMEOUT_MS + 1000 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('(d) explicit timeout + self-heal: phases derive from the explicit window (floor), env var ignored', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      process.env[ENV_VAR] = '45000'
      const W = 20_001
      const phase1 = Math.floor(W / 2) // 10_000 — pins the floor()
      const remaining = W - phase1 // 10_001
      const { page, calls, reloads } = fakePage([{ reject: nativeTimeout(phase1) }, {}])
      await new TestHarness(page).waitForConnection(W, { selfHealReload: true })
      expect(calls[0][2]).toEqual({ timeout: phase1 })
      expect(reloads[0]).toEqual([{ timeout: remaining }])
      // Absolute-deadline contract: phase 2 = W - totalElapsed + 1s, and
      // with the fake clock's elapsed 0 that is W + 1000 exactly.
      expect(calls[1][2]).toEqual({ timeout: W + 1000 })
    } finally {
      vi.useRealTimers()
    }
  })

```

(Keep every other assertion in (c)/(d) — the reload count, the three-argument binding pins, `reloads[0]` — unchanged.)

(c) Add to the self-heal describe (after test (e)) — as amended by delta review r3, including the slow-phase-1 case (g) that a reload-only clock cannot pass:

```ts
  it('(f) absolute deadline: the reload elapsed time is charged to phase 2 (no multi-window envelope)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const phase1 = Math.floor(DEFAULT_WS_READY_TIMEOUT_MS / 2)
      const remaining = DEFAULT_WS_READY_TIMEOUT_MS - phase1
      const { page, calls, reloads } = fakePage(
        [{ reject: nativeTimeout(phase1) }, {}],
        { reloadAdvanceMs: 10_000 },
      )
      await new TestHarness(page).waitForConnection(undefined, { selfHealReload: true })
      expect(reloads).toHaveLength(1)
      expect(reloads[0]).toEqual([{ timeout: remaining }])
      expect(calls).toHaveLength(2)
      // The reload "took" 10s of wall clock: phase 2 receives W minus the
      // TOTAL elapsed (+1s slack) — never a fresh full window.
      expect(calls[1][2]).toEqual({ timeout: DEFAULT_WS_READY_TIMEOUT_MS - 10_000 + 1000 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('(g) absolute deadline: a slow PHASE-1 is charged to phase 2 too (the clock starts before phase 1)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const phase1 = Math.floor(DEFAULT_WS_READY_TIMEOUT_MS / 2)
      const { page, calls } = fakePage(
        [{ reject: nativeTimeout(phase1) }, {}],
        { phase1AdvanceMs: 8_000 },
      )
      await new TestHarness(page).waitForConnection(undefined, { selfHealReload: true })
      expect(calls).toHaveLength(2)
      // Phase 1 burned 8s of wall clock before its poll expired; an
      // absolute deadline must charge it: phase 2 = W - 8s (+1s slack).
      // A reload-only clock would hand phase 2 a fresh window.
      expect(calls[1][2]).toEqual({ timeout: DEFAULT_WS_READY_TIMEOUT_MS - 8_000 + 1000 })
    } finally {
      vi.useRealTimers()
    }
  })
```

- [ ] **Step 2: Run the focused tests and verify the intended failures**

Run: `npm run test:e2e:helpers -- test-harness`

Expected: FOUR RED, all for the same absent behavior — the current phase-2 poll does not honor an absolute deadline starting before phase 1:

- tests (c)/(d) FAIL: the current code yields `{ timeout: remaining }`-derived values, not the absolute-deadline `W + 1000` expectations.
- test (f) FAILs: the reload-only clock yields `{ timeout: remaining - 10_000 + 1000 }`, not `W - 10_000 + 1000`.
- test (g) FAILs: the reload-only clock ignores the 8s phase-1 burn entirely, yielding a fresh-window value instead of `W - 8_000 + 1000`.

Every other test in the lane stays green (the non-self-heal path and tests (a)/(b)/(e) are untouched).

- [ ] **Step 3: Add the minimal production implementation**

In `test-harness.ts`, replace the self-healing branch's reload + final poll:

```ts
    // ABSOLUTE deadline (kata tg4e, delta review r3): the clock starts
    // BEFORE phase 1, and phase-2 receives W minus the TOTAL elapsed
    // (phase-1 + reload), so the whole self-heal path spends at most
    // W + 1s wall clock regardless of which phase burns the time. A
    // reload-only clock would let a delayed phase-1 land on top of the
    // envelope under the same CPU contention this change addresses.
    const selfHealStartedAt = Date.now()
    const phase1Ms = Math.floor(resolvedTimeoutMs / 2)
    const remainingMs = resolvedTimeoutMs - phase1Ms
    const readyWithinPhase1 = await this.page.waitForFunction(
      wsReadyPredicate,
      undefined,
      { timeout: phase1Ms },
    ).then(() => true, () => false)
    if (!readyWithinPhase1) {
      await this.page.reload({ timeout: remainingMs })
      const elapsedMs = Date.now() - selfHealStartedAt
      const phase2Ms = Math.max(0, resolvedTimeoutMs - elapsedMs) + 1000
      await this.page.waitForFunction(
        wsReadyPredicate,
        undefined,
        { timeout: phase2Ms },
      )
    }
```

- [ ] **Step 4: Run the focused tests (complete focused suite to GREEN)**

Run: `npm run test:e2e:helpers -- test-harness`

Expected: PASS — the implementation takes the complete focused suite (updated (c)/(d) and new (f), plus every untouched test) to green in this one Green step.

- [ ] **Step 5: Refactor while green**

Placement and comment polish only — no assertion or behavior changes (all assertion changes happened in Step 1 and went RED-to-GREEN through Step 3).

- [ ] **Step 6: Run impacted-test verification**

The self-heal path is exercised by: the helpers unit lane (all of it), and every cloud-lane spec's freshellPage fixture (real-behavior set below; the local lane runs the non-self-heal path because the env is unset).

```bash
npm run test:e2e:helpers
FRESHELL_E2E_WS_READY_TIMEOUT_MS=90000 npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/host-stats-pane.spec.ts test/e2e-browser/specs/settings.spec.ts
```

Expected: PASS (the env-set local invocation runs the self-heal path for real: boots, phase-1 ready, no reload, picker selects a shell).

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/helpers/test-harness.ts test/e2e-browser/helpers/test-harness.test.ts
git commit -m "test(e2e): waitForConnection self-heal enforces its window as a single total deadline (kata tg4e)"
```

### Task 3: Wire the budget into the `e2eMachineId` fixture + committed contract spec

**Files:**
- Modify: `test/e2e-browser/helpers/fixtures.ts` (the `e2eMachineId` fixture, currently `e2eMachineId: async ({ testServer }, use) => { await use((await registerE2eMachine(testServer.info)).id) }`; also extend the module's existing `import` from `'./test-harness.js'`)
- Create: `test/e2e-browser/specs/e2e-budget-contract.spec.ts`
- Test: the new contract spec is this task's behavioral test (it runs on both lanes; on the cloud lane — env always present — it pins the real budget).

**Interfaces:**
- Consumes: `resolveCloudLaneTestBudgetMs()` (Task 1), the exported `test` object from `helpers/fixtures.ts` (`test.info().setTimeout(ms)`), `FRESHELL_E2E_WS_READY_TIMEOUT_MS` env presence.
- Produces: every test that resolves the `e2eMachineId` fixture (i.e., every spec that uses `page`/`context`/`freshellPage` from this fixtures module) runs under deadline `max(declared, resolveCloudLaneTestBudgetMs())` when the cloud env is present; unchanged default deadline otherwise.

- [ ] **Step 1: Write the failing behavioral test (the contract spec)**

Create `test/e2e-browser/specs/e2e-budget-contract.spec.ts`:

```ts
import { test, expect } from '../helpers/fixtures.js'
import { resolveCloudLaneTestBudgetMs } from '../helpers/test-harness.js'

// Contract (kata tg4e, main-green campaign): when the cloud-lane window
// env is configured, every test that boots the app through this fixtures
// module resolves the e2eMachineId fixture BEFORE any page/context work,
// and that fixture extends the per-test deadline EXTEND-ONLY to cover the
// fixture chain's permitted composition — the self-healing
// waitForConnection spends at most W+1s (an absolute total deadline), and
// the picker/render tail adds its own envelope, so the config's 60s
// default can kill fixture setup mid-envelope (the recorded flake).
// When the env is not configured (local lane) the wiring is a NO-OP, and
// a spec's own declared deadline is always kept.

test('per-test deadline covers the harness wedge budget on the cloud lane', ({ freshellPage }) => {
  const cloudBudgetMs = resolveCloudLaneTestBudgetMs()
  if (cloudBudgetMs === null) {
    // Local lane: the resolver is OFF in-lane (the unit tests pin its
    // no-op guard; the declared-60s describe below pins the observable
    // behavior end-to-end). Nothing to assert about the deadline value
    // here — the config default and any legitimate --timeout override
    // are both valid untouched values.
    expect(resolveCloudLaneTestBudgetMs()).toBeNull()
    return
  }
  expect(test.info().timeout).toBeGreaterThanOrEqual(cloudBudgetMs)
})

// Extend-only contract, larger side: a spec that declares a LARGER
// deadline than the derived budget keeps its own — the wiring must never
// shrink a declared budget (idle-gate-semantics declares 300_000; the
// reconcile specs declare 240_000). Hooks run before fixture resolution,
// so the declared value is what the fixture sees on entry.
test.describe('declared budgets larger than the wedge budget', () => {
  test.beforeEach(() => {
    test.setTimeout(300_000)
  })
  test('keeps its declared deadline under the cloud lane budget', ({ freshellPage }) => {
    expect(test.info().timeout).toBeGreaterThanOrEqual(300_000)
  })
})

// Extend-only contract, smaller side — and the observable LOCAL NO-OP
// pin: a describe that declares a SMALLER deadline than the budget.
// Locally (env not configured) the wiring must leave it EXACTLY as
// declared — an extension to any value fails this. Under the cloud env
// the wiring must raise it to EXACTLY the derived budget. A per-test
// hook declaration overrides any config default or --timeout override,
// so the declared 60_000 is deterministic on both lanes.
test.describe('declared budgets smaller than the wedge budget', () => {
  test.beforeEach(() => {
    test.setTimeout(60_000)
  })
  test('stays exactly as declared locally, and is raised to exactly the budget on the cloud lane', ({ freshellPage }) => {
    const cloudBudgetMs = resolveCloudLaneTestBudgetMs()
    if (cloudBudgetMs === null) {
      // Local no-op: the deadline must be exactly the declared value.
      expect(test.info().timeout).toBe(60_000)
      return
    }
    // Extend-only: a declared budget below the wedge budget is raised to
    // exactly the derived budget — never any other value.
    expect(test.info().timeout).toBe(cloudBudgetMs)
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run (env-set local invocation reproduces the cloud-shaped path; first local run pays the global-setup build):

```bash
FRESHELL_E2E_WS_READY_TIMEOUT_MS=90000 npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/e2e-budget-contract.spec.ts
```

Expected: the FIRST test FAILs because `test.info().timeout` is still the 60_000 config default — `60_000 < 206_500` (the budget extension is absent). The never-shrink and declared-60s describe tests PASS at this point and keep their local-side behavior after the wiring — the declared-60s test is the two-sided extend-only pin (exactly 60_000 locally; exactly the budget on the cloud lane), not part of this Red step. Also run the no-env leg and confirm every test PASSES at this point (the wiring is a no-op locally — the local default must be green before the wiring too):

```bash
env -u FRESHELL_E2E_WS_READY_TIMEOUT_MS npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/e2e-budget-contract.spec.ts
```

- [ ] **Step 3: Add the minimal production implementation**

In `test/e2e-browser/helpers/fixtures.ts`: extend the existing import from `'./test-harness.js'` with `resolveCloudLaneTestBudgetMs`, and replace the `e2eMachineId` fixture body:

```ts
  // Each test gets a distinct machine so the worker-scoped server cannot
  // restore the preceding test's workspace into a fresh browser context.
  // The id remains stable for every context that one test intentionally uses.
  //
  // Cloud-lane wedge budget (kata tg4e): this is the earliest test-scoped
  // fixture — resolved before context/page, so every module-chain spec's
  // whole fixture chain runs under the deadline set here. The freshellPage
  // fixture's boot chain — self-healing waitForConnection (at most W+1s,
  // a single total deadline) plus the picker/render tail (kata tg4e's
  // retained trace: a container-wide CPU-contention episode starved the
  // post-click .xterm render and the old picker loop silently burned the
  // remaining budget escalating through options absent on this platform) —
  // has an evidence-shaped envelope larger than the config's 60s default,
  // which killed fixture setup mid-envelope: the recorded
  // "Test timeout of 60000ms exceeded while setting up freshellPage"
  // flake. Extending the deadline from inside this fixture makes the
  // budget cover the chain's envelope for every module-chain spec, not
  // just settings.spec.ts (whose private hook Task 5 removes). Locally
  // the env var is unset and the default budget applies unchanged. The
  // mechanism is probe-verified (settings.spec.ts precedent, kata j90s):
  // a setTimeout issued during fixture resolution extends the live
  // deadline over fixture time. EXTEND-ONLY: specs that declare a larger
  // deadline (idle-gate 300s, reconcile specs 240s) keep their own
  // budget — the guard must never shrink a declared deadline to the
  // cloud budget.
  e2eMachineId: async ({ testServer }, use) => {
    const cloudBudgetMs = resolveCloudLaneTestBudgetMs()
    if (cloudBudgetMs !== null && test.info().timeout < cloudBudgetMs) {
      test.info().setTimeout(cloudBudgetMs)
    }
    await use((await registerE2eMachine(testServer.info)).id)
  },
```

- [ ] **Step 4: Run the focused test**

Run:

```bash
FRESHELL_E2E_WS_READY_TIMEOUT_MS=90000 npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/e2e-budget-contract.spec.ts
```

Expected: PASS (the undeclared test sees the composed budget 206_500 under the env-set path; the never-shrink test still sees its declared 300_000; the declared-60s test sees exactly the composed budget). Then re-run the no-env leg:

```bash
env -u FRESHELL_E2E_WS_READY_TIMEOUT_MS npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/e2e-budget-contract.spec.ts
```

Expected: PASS (the declared-60s test stays exactly 60_000 — the observable local no-op pin; the never-shrink test keeps its 300_000).

- [ ] **Step 5: Refactor while green**

None beyond the comment placement above (the settings.spec.ts duplicate hook removal is Task 5 — keep it in place until then so settings never runs un-budgeted).

- [ ] **Step 6: Run impacted-test verification**

`fixtures.ts` is consumed by every e2e spec. Focused impacted set (real behavior, both lanes):

```bash
npm run test:e2e:helpers
FRESHELL_E2E_WS_READY_TIMEOUT_MS=90000 npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/host-stats-pane.spec.ts test/e2e-browser/specs/settings.spec.ts test/e2e-browser/specs/e2e-budget-contract.spec.ts
env -u FRESHELL_E2E_WS_READY_TIMEOUT_MS npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/host-stats-pane.spec.ts test/e2e-browser/specs/e2e-budget-contract.spec.ts
```

Expected: PASS for all three commands (the env-set invocation proves the cloud-shaped path boots, self-heal armed, picker selects a shell, and the budgeted tests pass; the unset invocation proves local semantics are unchanged).

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/helpers/fixtures.ts test/e2e-browser/specs/e2e-budget-contract.spec.ts
git commit -m "test(e2e): extend the per-test deadline to the cloud wedge budget from the earliest test-scoped fixture (kata tg4e)"
```

### Task 4: Fix the `selectShellFromPicker` slow-render conflation (the recorded budget burner)

**Files:**
- Modify: `test/e2e-browser/helpers/test-harness.ts` (add the restructured `selectShellFromPicker` as an exported page-flow helper near `TestHarness` — it is page-manipulation logic, not fixture wiring; plus the `SHELL_RENDER_TIMEOUT_MS` export)
- Modify: `test/e2e-browser/helpers/fixtures.ts` (delete the module-private `selectShellFromPicker` and import the new one from `'./test-harness.js'`; the only call site is the `freshellPage` fixture)
- Test: `test/e2e-browser/helpers/test-harness.test.ts` (new `describe` with a purpose-built fake page following the file's existing fakePage pattern)

**Interfaces:**
- Consumes: `Page` (type-only).
- Produces: `SHELL_RENDER_TIMEOUT_MS: number` (60_000) and `selectShellFromPicker(page: Page): Promise<void>` with the contract: (a) early returns unchanged (xterm already visible, or appears during the 500ms stabilization wait); (b) a click that fails with Playwright's `TimeoutError` means the option was not clickable within its 5s window — absent, detached, or not actionable — and advances to the next shell name (the historical detachment-race behavior; the click's auto-retry already absorbs transient detachments inside the window); (c) a click that fails with ANY non-timeout error (page closed, test interrupted, unexpected errors) propagates — loud, never swallowed; (d) a SUCCESSFUL click never escalates: it waits up to `SHELL_RENDER_TIMEOUT_MS` for `.xterm` to become visible and on timeout throws a diagnostic error naming the clicked shell and the wait; (e) the every-option-not-clickable fall-through contract is preserved (returns normally).

**Why this is required scope (not residual):** the retained trace (validator LB-C, `reports/load-bearing-validator-LB-C.md`) proves the recorded tg4e failure was exactly this conflation: after a successful Shell click (terminal created server-side, active, `hasClients:true`), the 30s `.xterm` render wait failed under container-wide CPU contention, and the loop escalated into WSL/CMD — options absent on the Linux picker — silently burning the remaining budget until the 60s deadline (and double-creating terminals whenever escalation reaches an option that exists, e.g. Bash). The budget fix alone does not survive this episode class; the loop's semantics are the defect.

- [ ] **Step 1: Expose the current behavior unchanged, then write the failing behavioral tests**

**(a) Pure move, no semantic change:** move the CURRENT `selectShellFromPicker` implementation verbatim from `fixtures.ts` (lines 128-161, with its doc comment) to `test/e2e-browser/helpers/test-harness.ts` as an exported function, and import it in `fixtures.ts` from `'./test-harness.js'` (the `freshellPage` call site is unchanged). This is not the fix — it exposes the existing defective behavior so the new tests can fail against it behaviorally, not as a module-load error. Do not change the function's logic, timeouts, or swallow-shape in this step.

**(b) Write the tests:** add to `test/e2e-browser/helpers/test-harness.test.ts` (extend the existing import from `'./test-harness'` with `selectShellFromPicker` and `SHELL_RENDER_TIMEOUT_MS`):

```ts
describe('selectShellFromPicker slow-render contract (kata tg4e)', () => {
  interface ShellOutcome {
    clickError?: 'page-closed' // not-clickable click by default (TimeoutError)
    renderVisibleAfterMs?: number // omit = render never becomes visible
  }

  /**
   * A fake Page shaped for selectShellFromPicker's real call sites:
   * locator('.xterm').first() chains to isVisible() and
   * waitFor({ state, timeout }); getByRole('button', { name }) chains to
   * click({ timeout }); waitForTimeout(ms) is the stabilization pause.
   * `clicks` records the real button names (the implementation builds its
   * locator RegExp as `^Name$`), `renderWaits` records every post-click
   * .xterm wait window, `clickTimeouts` records every click's timeout
   * argument, and `settledMs` records the stabilization pause — the last
   * two connect the picker's ACTUAL call arguments to the exported
   * constants that compose the per-test budget (delta review r3: the
   * budget's picker envelope must derive from the timeouts really used).
   */
  function pickerPage(
    shells: Record<string, ShellOutcome>,
    xtermInitiallyVisible = false,
    opts: { xtermVisibleFromCall?: number } = {},
  ) {
    const clicks: string[] = []
    const renderWaits: number[] = []
    const clickTimeouts: number[] = []
    const settledMs: number[] = []
    let xtermVisibilityChecks = 0
    const xtermVisible = () => {
      xtermVisibilityChecks += 1
      if (opts.xtermVisibleFromCall !== undefined) {
        return xtermVisibilityChecks >= opts.xtermVisibleFromCall
      }
      return xtermInitiallyVisible
    }
    const currentShell = () => (clicks.length ? shells[clicks[clicks.length - 1]] : undefined)
    const page = {
      locator: (selector: string) => ({
        first: () => ({
          isVisible: () => Promise.resolve(selector === '.xterm' && xtermVisible()),
          waitFor: ({ timeout }: { state?: string; timeout?: number }) => {
            renderWaits.push(timeout ?? 0)
            const visibleAfter = currentShell()?.renderVisibleAfterMs
            if (visibleAfter === undefined || visibleAfter > (timeout ?? 0)) {
              return Promise.reject(new Error(`waitFor: Timeout ${timeout}ms exceeded`))
            }
            return Promise.resolve()
          },
        }),
      }),
      getByRole: (_kind: string, roleOpts: { name: RegExp }) => ({
        click: (clickOpts: { timeout?: number }) => {
          clickTimeouts.push(clickOpts?.timeout ?? 0)
          const name = roleOpts.name.source.replace(/^\^/, '').replace(/\$$/, '')
          clicks.push(name)
          const outcome = shells[name]
          if (outcome?.clickError === 'page-closed') {
            return Promise.reject(Object.assign(new Error('Page closed'), { name: 'TargetClosedError' }))
          }
          if (!outcome) {
            // Option not clickable (absent/detached/obstructed): Playwright's
            // actionability TimeoutError — indistinguishable by name from any
            // other not-clickable timeout, which is exactly the contract.
            return Promise.reject(Object.assign(new Error(`click: Timeout ${clickOpts?.timeout}ms exceeded`), { name: 'TimeoutError' }))
          }
          return Promise.resolve()
        },
      }),
      waitForTimeout: (ms: number) => {
        settledMs.push(ms)
        return Promise.resolve()
      },
    }
    return {
      page: page as unknown as Page,
      clicks,
      renderWaits,
      clickTimeouts,
      settledMs,
      xtermVisibilityChecks: () => xtermVisibilityChecks,
    }
  }

```

(The listing above is the committed fake as amended by delta review r3 — it records the click timeout and settle arguments and connects them to the exported constants `shellPickerWorstCaseMs()` composes from, so the budget's picker envelope provably derives from the timeouts `selectShellFromPicker` really uses.)

- [ ] **Step 2: Run the tests and verify the intended BEHAVIORAL failures**

Run: `npm run test:e2e:helpers -- test-harness`

Expected: the moved-but-unfixed implementation produces multiple BEHAVIORAL failures (the module exports exist — this is not a load failure; the tests execute the current defective behavior and fail for the right reasons):

- `a successful click waits the full render budget and never escalates` FAILs: `renderWaits` is `[30_000]` (the current 30s wait), not `[SHELL_RENDER_TIMEOUT_MS]` (60_000).
- `survives a render slower than the historical 30s wait` FAILs: the current 30s wait rejects at 35s and the loop escalates — `clicks` is `['Shell', 'WSL', ...]`, not `['Shell']`.
- `throws a diagnostic when a clicked shell never renders` FAILs: the current loop catches the wait error, swallows it, and escalates/falls through — no throw, and `clicks` grows past `['Shell']`.
- `a non-timeout click error propagates` FAILs: the current loop's bare `catch { continue }` swallows the page-closed error and advances.
- `falls through silently only when every option is not clickable` PASSES (that is the current behavior too — it stays).
- The already-visible and mid-wait-recheck tests PASS (early-return behavior is unchanged by the fix).
- `a not-clickable option ... advances to the next shell` PASSES (advance-on-timeout is the historical behavior the fix keeps).

- [ ] **Step 3: Add the minimal production implementation (replace the moved function's loop with the fixed contract)**

In `test/e2e-browser/helpers/test-harness.ts` (exported, near TestHarness):

```ts
/**
 * How long a SUCCESSFUL shell click waits for the terminal render
 * (.xterm visible) before failing loudly (kata tg4e). Evidence-sized:
 * the recorded failure's render starve exceeded 30s under container-wide
 * CPU contention (a sibling worker's normally-200ms test took 74s in the
 * same window), so a 30s wait conflated "slow render" with "wrong
 * option" and the loop escalated into absent options, silently burning
 * the test budget. 60s fits the recorded single-episode envelope inside
 * the 120s cloud budget (24s slow boot + click + render < 120s).
 */
export const SHELL_RENDER_TIMEOUT_MS = 60_000

/** Playwright's click TimeoutError is the not-clickable signal (absent,
 * detached, or obstructed within the window — indistinguishable by name);
 * anything else (page closed, interruption, unexpected errors) is loud. */
function isClickUnavailableError(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError'
}

/**
 * Select a shell from the PanePicker. Handles the race where buttons
 * detach during the platform-info Redux update: a click TimeoutError
 * means the option was not clickable within its window — absent,
 * detached, or obstructed — advance to the next candidate (Playwright's
 * click auto-retry already absorbs transient detachments inside its
 * window). A SUCCESSFUL click is different: the terminal create is in
 * flight, and a slow render is NOT evidence the option was wrong — wait
 * generously and fail loudly on timeout instead of escalating
 * (escalation after a successful click double-creates terminals and, in
 * the recorded tg4e failure, burned the remaining test budget on
 * options absent on this platform). Never reloads: the picker may already
 * have created state.
 */
export async function selectShellFromPicker(page: Page): Promise<void> {
  const xtermAlreadyVisible = await page.locator('.xterm').first().isVisible().catch(() => false)
  if (xtermAlreadyVisible) return

  // Wait a moment for the PanePicker to stabilize after WS connection
  // (platform info arrives and may change the option set).
  await page.waitForTimeout(500)

  const xtermNow = await page.locator('.xterm').first().isVisible().catch(() => false)
  if (xtermNow) return

  const shellNames = ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']
  for (const name of shellNames) {
    const button = page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
    try {
      await button.click({ timeout: 5_000 })
    } catch (err) {
      if (!isClickUnavailableError(err)) throw err
      continue // option not clickable within the window — historical behavior
    }
    try {
      await page.locator('.xterm').first().waitFor({ state: 'visible', timeout: SHELL_RENDER_TIMEOUT_MS })
      return
    } catch (err) {
      throw new Error(
        `Shell '${name}' was clicked but the terminal did not render within ${SHELL_RENDER_TIMEOUT_MS}ms. ` +
          'A slow or starved render is a first-class failure, not a wrong-option signal — ' +
          'not escalating (escalation double-creates terminals and burned the tg4e test budget). ' +
          `Underlying wait error: ${String(err)}`,
      )
    }
  }
  // Every option was absent (no picker, or unexpected labels) — the
  // historical fall-through contract: let the test surface its own error.
}
```

In `test/e2e-browser/helpers/fixtures.ts`: delete the module-private `selectShellFromPicker` (with its doc comment) and add `selectShellFromPicker` to the import from `'./test-harness.js'`; the `freshellPage` fixture's call site (`await selectShellFromPicker(page)`) is unchanged.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:e2e:helpers -- test-harness`

Expected: PASS (all eight new contract tests green; all pre-existing tests green).

- [ ] **Step 5: Refactor while green**

None needed — the move to `test-harness.ts` IS the cohesion refactor (page-flow helper leaves the fixture-wiring module).

- [ ] **Step 6: Run impacted-test verification**

`selectShellFromPicker` runs inside `freshellPage` for every spec that uses the fixture. Focused real-behavior set (both lanes; these specs exercise the healthy path end-to-end):

```bash
npm run test:e2e:helpers
FRESHELL_E2E_WS_READY_TIMEOUT_MS=90000 npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/host-stats-pane.spec.ts test/e2e-browser/specs/settings.spec.ts test/e2e-browser/specs/e2e-budget-contract.spec.ts
env -u FRESHELL_E2E_WS_READY_TIMEOUT_MS npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/host-stats-pane.spec.ts test/e2e-browser/specs/e2e-budget-contract.spec.ts
```

Expected: PASS for all three commands.

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/helpers/test-harness.ts test/e2e-browser/helpers/test-harness.test.ts test/e2e-browser/helpers/fixtures.ts
git commit -m "test(e2e): picker loop distinguishes absent options from slow renders and fails loudly (kata tg4e)"
```

### Task 5: Remove the now-redundant settings.spec.ts budget hook

**Files:**
- Modify: `test/e2e-browser/specs/settings.spec.ts` (delete the `test.beforeEach` block, lines 8-21 in the current file: the cloud-only `test.setTimeout(120_000)` hook; its probe-verified mechanism documentation has moved into the `e2eMachineId` fixture comment in Task 3)

**Interfaces:**
- Consumes: Task 3's fixture-level composed budget (settings.spec.ts uses `freshellPage`, so it resolves `e2eMachineId` first). At the cloud default window the composed budget (206.5s) strictly exceeds the removed hook's flat 120s — the hook was an under-budget artifact of the pre-composition design (delta review r2); settings now runs under the same composition-derived budget as every module-chain spec, i.e. MORE headroom than before, never less (extend-only). Under operator window overrides the whole composition scales with the window by construction.
- Produces: one source of truth for the cloud wedge budget (the fixture), no per-spec opt-in.

- [ ] **Step 1: Write the failing behavioral test**

No new test: the behavior change (settings still budgeted after hook removal) is already protected by Task 3's contract spec (the wiring under the env-present path) and this task's verification runs below. Removing a redundant duplicate is a refactor under green, not new behavior.

- [ ] **Step 2: Run the test and verify the intended failure**

Skip (no Red step for a pure dedup refactor; record this justification).

- [ ] **Step 3: Add the minimal production implementation**

Delete the `test.beforeEach(async ({}) => { ... })` block from `test/e2e-browser/specs/settings.spec.ts` (the hook whose body is `if (process.env.FRESHELL_E2E_WS_READY_TIMEOUT_MS) test.setTimeout(120_000)` plus its comment). Leave the rest of `test.describe('Settings', () => {...})` untouched.

- [ ] **Step 4: Run the focused test**

```bash
FRESHELL_E2E_WS_READY_TIMEOUT_MS=90000 npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/settings.spec.ts test/e2e-browser/specs/e2e-budget-contract.spec.ts
env -u FRESHELL_E2E_WS_READY_TIMEOUT_MS npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/settings.spec.ts
```

Expected: PASS both (settings still green with and without the env; the budget now arrives via the fixture; settings' own mid-test reload leg at settings.spec.ts:225-233 keeps working under the same 120s-equivalent budget it had before).

- [ ] **Step 5: Refactor while green**

The deletion IS the refactor. Confirm the env-gated BUDGET HOOK pattern is gone from every spec — the corrected check (the raw `setTimeout(120` grep matches ~28 benign unconditional declaration-time timeouts in other specs; the env-gated cloud hook is uniquely identified by its env reference):

```bash
grep -rn "FRESHELL_E2E_WS_READY_TIMEOUT_MS" test/e2e-browser/specs/
```

Expected: no direct env-key references in the specs (the cloud-lane presence gate is the shared `isCloudLaneWindowConfigured()` predicate imported from the helpers — settings.spec.ts's mid-test self-heal opt-in uses it, which is the legitimate j90s-era fresh-boot gate on the reload-leg test, NOT a budget hook; direct `process.env` reads of the window key and any `test.setTimeout` gated on it are both gone). Also confirm the j90s script suite `scripts/test/e2e-harness-timeout-env.test.sh` is unaffected (it uses settings.spec.ts only as a stubbed pass-through arg and pins the e2e-cloud.sh env plumbing, not the hook).

- [ ] **Step 6: Run impacted-test verification**

```bash
env -u FRESHELL_E2E_WS_READY_TIMEOUT_MS npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/settings.spec.ts test/e2e-browser/specs/host-stats-pane.spec.ts test/e2e-browser/specs/e2e-budget-contract.spec.ts
```

Expected: PASS (both lanes' semantics for settings and the target spec verified together).

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/settings.spec.ts
git commit -m "refactor(e2e): drop settings-only cloud budget hook superseded by the fixture-level budget (kata tg4e)"
```

### Task 6: Cloud-lane proof at the committed HEAD

**Files:**
- No source changes. Evidence receipts go to the run's logs dir (outside the tracked tree). The worktree must be clean and committed before each cloud invocation (dirty trees force a non-addressable full rebuild).

**Interfaces:**
- Consumes: Tasks 1-5 at the branch HEAD; the cloud lane (`scripts/e2e-cloud.sh run --cloud`), which bakes `FRESHELL_E2E_WS_READY_TIMEOUT_MS=90000` and `FRESHELL_E2E_SERVER_VERBOSE=1` into the job env.
- Produces: zero-flake receipts for the target spec and the contract spec at HEAD; evidence for the final gate.

- [ ] **Step 1: Run the target spec and the contract spec on the cloud lane**

Commit any pending work first (`git status` clean), then:

```bash
npm run test:e2e:cloud -- --project=chromium test/e2e-browser/specs/host-stats-pane.spec.ts test/e2e-browser/specs/e2e-budget-contract.spec.ts
```

Expected: PASS with a zero-flake receipt ("All tasks completed successfully", no recovered-retry evidence). First run at a new commit pays ~7 min Cloud Build; subsequent runs ~3-5 min.

- [ ] **Step 2: Repeat for confidence**

Re-run the same command once more. Expected: PASS zero-flake again (the flake was observed ~1-in-7 for the class; two clean focused runs plus the unit-pinned arithmetic, the contract spec, and the picker-contract tests is the practical pre-gate evidence).

- [ ] **Step 3: Record evidence**

Save both receipts under `.worktrees/.the-usual-logs/hoststats-freshellpage-flake/reports/cloud-focus-*.log` with the invocation, exit codes, and the zero-flake footer. Note any recovered-retry case for investigation — a failure now carries a diagnosable signature: a picker diagnostic ("did not render") names a still-starved render; a "Test timeout of 120000ms" names a budget-outliving episode. Either requires root-cause before the gate, not a wider budget.

- [ ] **Step 4: No commit**

No tracked changes in this task (evidence lives outside the tree). If investigation reveals a defect, file it as a new focused task rather than expanding this one silently.

### Task 7: Full-suite gate at the final HEAD

**Files:**
- No source changes expected. Gate fixes (if any) follow the-usual's gate procedure as a batch.

**Interfaces:**
- Consumes: the final committed HEAD of all tasks.
- Produces: the run's gate evidence — standard suite green; e2e lane green under the-usual's ledger-exemption criterion.

**Gate criterion (one consistent standard, stated precisely):** the gate passes when every suite is green EXCEPT failures that are ledger-recorded pre-existing failures. A recovered-retry case counts as a LEDGER-RECORDED PRE-EXISTING FAILURE when it satisfies EITHER form, each with receipts recorded in the run's ledgers:

- **Form A (individual reproduction):** the same test failed identically at base_ref 39192e8aa in a recorded run — the strongest form (e.g. `recover-my-panes-rust.spec.ts:733` (kata 5kyg) and `layout-sync-authoritative.spec.ts:104` (kata nxf6) both have direct base_ref receipts).
- **Form B (mechanistic impossibility for a probabilistic timing flake):** for non-deterministic timing flakes that finite base_ref sampling has not yet caught individually, ALL of: (i) a code-cited per-case analysis in the gate receipt showing the delta could not have caused the failure (the failing wait is an internal poll, a spec-local helper, or a declared budget the extend-only guard provably preserves — none altered by the delta); (ii) the lane's flake population demonstrated at base_ref by recorded full-lane runs showing retry cases there (population receipts); (iii) the case filed as its own kata for the campaign's backlog. Individual deterministic reproduction does not exist for this failure class; Form B is the honest ceiling, and it is falsifiable — a future reviewer can dispute any (i) analysis by showing a mechanism the delta does touch.

The e2e zero-flake receipt itself remains red-by-design until the campaign's later runs eliminate the backlog katas — this run's gate does NOT claim a green receipt, it claims green-exempted-per-ledger under the standard above. The three baseline flakes (38hj, 5kyg, ebp6) are the campaign's next one-test-at-a-time steps; every Form B case is likewise a kata.

The e2e lane gate is NOT satisfied by the retry-evidence subset check alone: the receipt exporter records only failures that later pass (`scripts/e2e-cloud-retry-receipt.mjs` — a test that exhausts all retries leaves NO recovered-retry case), and infrastructure/receipt-parse failures also exit 1. An exit-1 e2e lane run is a PASSING gate only when ALL of the following hold, each verified from the saved full run log:

1. **No terminal Playwright failure**: the per-task Playwright summary shows every test ultimately passed (a test that exhausted its retries appears as failed there and fails this condition even though it produced no retry-evidence case — this closes the empty-set loophole).
2. **Every recovered-retry case is dispositioned pre-existing under Form A or Form B above**, recorded in the gate receipt with the per-case citations. Any retry case whose failing mechanism the diff DOES touch is a gate failure requiring root-cause and (if confirmed) an in-run fix.
3. **No infrastructure failure**: the per-shard summary shows `Succeeded tasks: <shards>` and `Failed tasks: 0`, and the run did not fail in receipt parsing/validation (those exits are distinguishable by the runner's own error lines in the log).

Amendment trail: the original criterion enumerated exactly the three baseline flakes (Form A only). The first full-lane run at HEAD surfaced five OTHER population members; the standard was amended (transparently, commit e1640539b) to the Form-A-or-Form-B rule, and re-stated here (delta round 3) as one internally-consistent standard. The whole-branch reviewer independently re-verified and concurred with the exemption disposition.

- [ ] **Step 1: Standard coordinated suite**

```bash
FRESHELL_TEST_SUMMARY='the-usual hoststats-freshellpage-flake: final full-suite gate at HEAD' npm test
```

Expected: PASS (exit 0). This covers client/tooling vitest, source-runtime, Rust, Electron. Wait for the shared coordinator gate if held; never kill a foreign holder.

- [ ] **Step 2: Full e2e lane at HEAD**

```bash
FRESHELL_TEST_SUMMARY='the-usual hoststats-freshellpage-flake: final e2e lane gate at HEAD' npm run test:e2e
```

Expected: exit 0 with a zero-flake receipt, OR exit 1 that satisfies ALL THREE gate conditions above — no terminal Playwright failure; every recovered-retry case dispositioned pre-existing under Form A or Form B (per-case citations in the gate receipt; population/`base_ref` receipts; each case kata-filed); no infrastructure failure — each verified from the saved full run log. Save the complete run log under the run's reports directory as the gate evidence. A receipt containing a retry-evidence case for `host-stats-pane.spec.ts`, `e2e-budget-contract.spec.ts`, `settings.spec.ts`, OR any spec whose failing mechanism this delta touches, OR any terminal failure, OR any infrastructure failure is a gate failure: this run's fix is incomplete or regressed something.

- [ ] **Step 3: Record the gate entry**

Record time, HEAD SHA, exact commands, results, and the exemption evidence (the base_ref reproduction receipts) in the progress ledger and run-state. Note explicitly which (if any) of the three pre-existing flakes appeared, for the campaign's bookkeeping.

- [ ] **Step 4: No commit**

No tracked changes in this task. The worktree stays at the final HEAD with all tasks committed.

## Post-run integration sequence (orchestrator-owned, outside the plan's tasks — recorded so the full path to the requested result on main is visible)

The the-usual run itself ends at Task 7 (execution + reviews do not merge or push). The integration that delivers the fix onto `main` follows, in order:

1. Final delta Fresh Eyes review on the complete committed delta (base_ref 39192e8aa...HEAD), up to 15 rounds per the user's authorization. Review-loop fix commits land as they are substantiated (focused verification per fix).
2. AT THE FINAL HEAD after the loop passes — because review-loop fixes change the harness the receipts cover — the e2e proof re-runs before any PR exists: the focused cloud proof (`npm run test:e2e:cloud -- --project=chromium test/e2e-browser/specs/host-stats-pane.spec.ts test/e2e-browser/specs/e2e-budget-contract.spec.ts`, zero-flake receipt) AND the full gate (`npm test` + `npm run test:e2e` under the ledger-exemption criterion). No earlier-HEAD receipt substitutes; the PR is filed only with the final-HEAD receipts.
3. If and only if the delta review finishes PASSED and the final-HEAD gate receipts exist: per the user's explicit pre-approval, push the branch and open a PR onto `main`, wait for required checks, merge, and fast-forward local `main` from `origin/main`.
4. Close kata tg4e with the MERGE commit SHA and the evidence bundle (unit pins, contract spec, final-HEAD cloud receipts, gate entries).
5. Re-run the campaign's e2e gate at `origin/main` — this doubles as the post-merge proof of the tg4e fix on main and the refreshed baseline for the campaign's next one-test-at-a-time run (the remaining flakes: katas 38hj, 5kyg, ebp6, then the backlog katas).
