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

**Architecture:** The retained attempt-1 trace (validator report, LB-C) shows the recorded failure was NOT the j90s zero-CPU wedge: the boot chain completed, WS ready landed at t0+23s (inside phase 1 — no self-heal reload), the fixture clicked "Shell" (terminal created server-side, active with `hasClients:true`), but the `.xterm` render starved >30s under container-wide CPU contention (54% CPU, a sibling worker's normally-200ms test took 74s in the same window). The loop's 30s `.xterm` wait failed, and the loop escalated — WSL (5s click timeout), CMD (mid-click at the 60s deadline) — options absent on the Linux picker, silently burning the remaining budget. The fix makes the harness envelope coherent and covered: `waitForConnection` enforces W as a single total deadline (phase-1 `floor(W/2)`; the reload and phase-2 share the remainder, +1s slack — the documented design intent and the j90s recap's Optional finding #4); the per-test budget derives from the same env that scales the window (`FRESHELL_E2E_WS_READY_TIMEOUT_MS`) and COVERS the chain's permitted composition (connection envelope W+1s + the ENFORCED bounds on the initial operations — goto 60s explicit and harness install 60s explicit at the boot call site; unconfigured Playwright-Test navigations/waits are UNLIMITED, so the bounds are enforced in the fixture chain, not assumed; the shared helper's no-arg default stays 0, preserving every other caller's own deadline — delta r15 — + the picker's permitted worst case = 321.5s at the cloud default; delta-reviews r2+r5+r12+r13+r14+r15), applied as the `freshellPage` FIXTURE's OWN setup timeout (Playwright's fixture-timeout mechanism — slow setup gets the allowance while every test body keeps its declared or config-default ceiling; delta review r9); and `selectShellFromPicker` distinguishes a confirmed-absent option (click TimeoutError, then a bounded creation probe confirms nothing was created — advance) from a successful or late-dispatched click (wait generously for the render, fail loudly on timeout — never escalate; delta review r5: a click timeout does not prove the handler never ran). The local lane (env unset) keeps the default budget; the picker's healthy path is unchanged.

**Tech Stack:** Playwright 1.58.2 fixtures and `test.info().setTimeout`, TypeScript (NodeNext/ESM — relative imports in test files carry `.js`; type-only imports stay type-only), Vitest for the e2e-helpers unit lane (fake timers for clock-sensitive coherence tests), the repo's cloud e2e lane (`scripts/e2e-cloud.sh`) for proof.

## Global Constraints

- Budget changes are cloud-only and env-gated: with `FRESHELL_E2E_WS_READY_TIMEOUT_MS` unset, no timeout changes and no different call shapes on the default path (byte-identical local lane for the budget dimension).
- `waitForConnection`'s self-heal window W is a SINGLE TOTAL deadline: phase-1 + the reload's navigation + phase-2 share W (+1s slack), so the connection-wait envelope is W+1s (91s at the cloud window) — the budget never needs to cover a multi-W envelope. The pre-fix sequential drift (up to 135s) is fixed at the source (Task 2), not budgeted around.
- Budget = the fixture chain's PERMITTED COMPOSITION (delta-reviews r2+r5+r12+r13+r14): connection envelope (W + 1s total-deadline slack) + the initial operations' ENFORCED bounds (goto 60s explicit in freshellPage + harness install 60s explicit at the same boot call site, while the shared helper's no-arg default stays 0 so unrelated callers keep their own declared deadlines (delta r15) — NOT Playwright maxima: this runner defaults navigationTimeout and unconfigured waits to 0 = disabled, verified against playwright/lib/index.js _setupContextOptions and timeoutSettings, so WITHOUT enforcement a pathological op would pass silently under the slot where the pre-run 60s deadline caught it, the exact loosening delta r14 rejected; each bound IS the pre-run whole-test deadline as the single op's own bound — never looser for pathological ops, never tighter for recovering ones) + the picker's permitted worst case (derived from the picker's own exported constants — settle + one click budget + one creation-probe budget per shell name + the render wait = 110.5s) = 321.5s at the cloud default W=90s, unit-pinned so the composition cannot drift. (The former 30s start/body reserve is deleted: a body-start margin never belonged in a fixture-SETUP slot — the body has its own deadline.) A budget merely "evidence-sized" to the recorded episodes was rejected by review: the retained trace shows connection AND render slowness co-occurring in one container-wide disturbance, so the outer deadline must cover the waits the chain is permitted to compose, or the same outer setup-timeout flake recurs before the picker's diagnostic can fire.
- The wiring NEVER modifies a test's own deadline (delta review r9 — the r2-r8 whole-test/default-class extension is superseded): the composed budget is the `freshellPage` fixture's OWN timeout (Playwright's fixture-timeout mechanism, playwright.dev/docs/test-fixtures#fixture-timeout), so slow boot SETUP gets its allowance while every body keeps its declared or config-default ceiling on every lane (`DEFAULT_TEST_TIMEOUT_MS` = 60_000, the constant the Playwright configs import). Specs that need a larger BODY budget declare it themselves, cloud-gated to exactly what the pre-run state gave them (settings' two reload tests declare 120_000 under isCloudLaneWindowConfigured() — the removed hook's exact value; locally no declaration and the exact pre-run 60s, delta review r10); a declared 0 (unlimited) or an above-default declaration reaches the wiring unchanged. The former whole-test extension gave unrelated bodies ~171.5s of extra ceiling and could suppress their flakes — the fixture-timeout design removes that interference structurally. The contract spec pins it.
- The self-heal stays cloud-only (env-presence gated) and fresh-boot-only: never opt a mid-test `waitForConnection` site into `selfHealReload` (a reload would destroy the state under test).
- Never loosen the ready assertion, never skip or exclude specs, never raise `retries`, never widen `CLOUD_SKIP_SPECS` — those are coverage reductions, not fixes. The picker fix TIGHTENS failure semantics (a thrown diagnostic replaces a silent fall-through past a successful click; non-timeout click errors propagate); it must not touch any passing-path assertion.
- Malformed env values must never poison the budget (reuse `resolveWsReadyTimeoutMs`'s parsing/fallback — one parsing rule).
- A budget that covers the evidence-shaped envelope must not silently become a per-test entitlement: assertions and waits inside test bodies keep their own explicit timeouts.
- The other three baseline flakes (kata 38hj `restore-contract-wall-rust.spec.ts:579`, kata 5kyg `recover-my-panes-rust.spec.ts:733`, kata ebp6 `reconcile-client-adoption-rust.spec.ts:542`) are pre-existing failures at base_ref 39192e8aa and stay out of scope; they are the campaign's next one-test-at-a-time steps.
- The gVisor wedge and container-slowness episodes are infra-layer and cannot be deterministically forced; acceptance evidence is (a) the budget arithmetic and total-deadline coherence (unit-pinned), (b) the contract spec proving the wiring under the env-present path, (c) the picker loop's new contract (unit-pinned: no escalation after a successful click; the render wait receives `SHELL_RENDER_TIMEOUT_MS`; loud timeout; non-timeout click errors propagate; and — delta r5 — a click timeout followed by a late-dispatched create joins the success path, a click timeout with nothing created advances, and probe hard errors propagate), (d) the fixture-timeout application pin (the production freshellPage registration carries a deterministically slowed boot past the test's own deadline — delta r12), and (e) zero-flake cloud receipts for the affected spec at the committed HEAD.
- Accepted residuals, deliberately out of scope (recorded so the reviewer sees conscious scoping): (a) the client's timeout-less boot fetches (App.tsx:1691-1753, api.ts:181) remain unbounded — that product-level hardening is the qq5m flake class, tracked by its own kata and later campaign runs; the fixes here make single infra episodes survivable without it. (b) The budget covers the fixture chain's permitted composition INCLUDING the unbounded initial operations' allowances (delta review r13) but not unbounded TEST-BODY work (bodies keep their own declared/explicit timeouts). A goto/harness stall beyond its allowance fails the fixture slot loudly (fixture-timeout signature) — the timeout-less-fetch wedge class stays residual (a). (c) `waitForHarness`'s decorative 15s was an LB-1-class two-argument binding bug FIXED by this run (delta reviews r5+r6+r13+r14+r15): the committed call is the three-argument form honoring explicit values, and the NO-ARG DEFAULT is 0 — UNLIMITED, governed by the caller's own outer bound — the EXACT pre-run effective semantics for every caller (unconfigured Playwright-Test waits inherit the context's 0 default = disabled, verified against the runner source; callers deliberately declaring 120-600s deadlines keep their allowance — a shared finite default would narrow them, the mirror-image loosening r15 rejected). The ONE call site this run repairs — the freshellPage boot chain — passes CLOUD_LANE_HARNESS_WAIT_BOUND_MS (60_000, the pre-run whole-test deadline as the single wait's own bound) EXPLICITLY: a pathological boot-chain install stall dies at 60s where pre-run caught it, a slow-but-recovering one keeps its pre-run envelope. The one other explicit-argument call site (perf/run-sample.ts) passes 30_000, honored for real — the fix making declared windows real is the point (LB-1). (d) Raw-base specs that import `test` from `@playwright/test` directly and boot the app in-body (terminal-escape-key-rust, cli-rust, silent-input-loss-rust, sidebar-registry-sync-rust, sidebar-remote-status-rings-rust, sidebar-status-tier-sort-rust, diag03-rotation-redaction-rust — load-bearing LB-B2) never resolve `e2eMachineId`; they keep the same 60s deadline they have today. This run does not regress them and does not cover them; they are tracked by kata j96j and addressed by a later campaign step.
- The full e2e lane at the run HEAD is part of this run's final gate (`npm run test:e2e`, cloud backend); PR checks do not run e2e on this repo, so the lane must be run explicitly.

---

### Task 1: `resolveCloudLaneTestBudgetMs` resolver + unit tests

**Files:**
- Modify: `test/e2e-browser/helpers/test-harness.ts` (after `resolveWsReadyTimeoutMs`, near `DEFAULT_WS_READY_TIMEOUT_MS`)
- Test: `test/e2e-browser/helpers/test-harness.test.ts` (new `describe` block after `resolveWsReadyTimeoutMs`'s)

**Interfaces:**
- Consumes: `resolveWsReadyTimeoutMs(explicitMs, env)`, `DEFAULT_WS_READY_TIMEOUT_MS`, env key `FRESHELL_E2E_WS_READY_TIMEOUT_MS` (set to `90000` on the cloud lane by `scripts/e2e-cloud.sh`'s run-env block).
- Produces (as amended by delta-review rounds 1-5 and 9): `isCloudLaneWindowConfigured(env?): boolean` (ONE presence rule — present AND non-empty), `shellPickerWorstCaseMs(): number` (the picker's permitted worst case derived from its own exported constants — settle + one click budget + one creation-probe budget per shell name + the render wait), `CLOUD_LANE_GOTO_BOUND_MS: number` (60_000 — page.goto's ENFORCED bound, passed explicitly by freshellPage: unconfigured Playwright-Test navigation is UNLIMITED, so without the bound a pathological goto would pass silently under the slot) and `CLOUD_LANE_HARNESS_WAIT_BOUND_MS: number` (60_000 — the harness-install wait's ENFORCED bound and waitForHarness's committed default; delta reviews r12+r13+r14), `DEFAULT_TEST_TIMEOUT_MS: number` (60_000 — the Playwright configs' `timeout` value, imported from here as the single source of truth), `freshellPageFixtureTimeoutMs(env?): number | undefined` (the freshellPage fixture's OWN setup timeout: the composed budget on the cloud lane, undefined locally — unit-pinned below; delta review r9, replacing the superseded extension predicate), and `resolveCloudLaneTestBudgetMs(env?): number | null` — `null` when the window env is not configured (local lane: caller must not extend anything), otherwise the permitted composition: `resolveWsReadyTimeoutMs(undefined, env) + 1000 + CLOUD_LANE_GOTO_BOUND_MS + CLOUD_LANE_HARNESS_WAIT_BOUND_MS + shellPickerWorstCaseMs()` (321.5s at the cloud default).

- [ ] **Step 1: Write the failing behavioral test**

Add to `test/e2e-browser/helpers/test-harness.test.ts` (match the file's existing vitest style — imports from `'./test-harness'`, `describe`/`it`; add `CLOUD_LANE_GOTO_BOUND_MS`, `CLOUD_LANE_HARNESS_WAIT_BOUND_MS`, `resolveCloudLaneTestBudgetMs`, `shellPickerWorstCaseMs`, `isCloudLaneWindowConfigured`, `DEFAULT_TEST_TIMEOUT_MS`, and `freshellPageFixtureTimeoutMs` to the existing import from `'./test-harness'`, plus the picker constants `SHELL_PICKER_SETTLE_MS`/`SHELL_CLICK_TIMEOUT_MS`/`SHELL_PROBE_TIMEOUT_MS`/`SHELL_RENDER_TIMEOUT_MS`/`SHELL_NAMES` once Task 4 exports them):

**Dependency order (delta-review r5 reconciliation):** the listing below is the COMMITTED final state. `shellPickerWorstCaseMs` composes from the `SHELL_*` picker constants, whose values Task 4 owns — a worker executing top-down exports the constants (plain exported consts, no logic) together with this task's resolver so the whole listing compiles, and `selectShellFromPicker` itself is implemented in Task 4. The `freshellPageFixtureTimeoutMs` describe is the delta-r9 remediation's unit pin for the fixture-timeout wiring (it replaced the r5 extension-predicate describe when the whole-test extension was superseded).

```ts
describe('resolveCloudLaneTestBudgetMs', () => {
  it('returns null when the cloud window env is absent (local lane budget untouched)', () => {
    expect(resolveCloudLaneTestBudgetMs({})).toBeNull()
  })

  it('returns null when the cloud window env is empty', () => {
    expect(resolveCloudLaneTestBudgetMs({ [ENV_VAR]: '' })).toBeNull()
  })

  it('covers the permitted composition at the cloud default window (delta reviews r2+r5)', () => {
    // W=90s: connection envelope (W + 1s total-deadline slack) = 91_000;
    // the UNBOUNDED initial operations' allowances (goto 30_000 + harness
    // install 30_000 — explicit budget lines, NOT Playwright maxima:
    // navigationTimeout and unconfigured waits default to 0 = disabled in
    // Playwright Test, verified against the runner source; delta r13);
    // picker worst case
    // (settle + at most 5 clicks + 5 probes + the render wait) = 500 +
    // 5 * (5_000 + 5_000) + 60_000 = 110_500. Total 321_500.
    expect(resolveCloudLaneTestBudgetMs({ [ENV_VAR]: '90000' })).toBe(321_500)
  })

  it('scales with the configured window (60s -> 291_500)', () => {
    expect(resolveCloudLaneTestBudgetMs({ [ENV_VAR]: '60000' })).toBe(291_500)
  })

  it('falls back to the default window composition on malformed values (one parsing rule)', () => {
    for (const malformed of ['not-a-number', '0', '-5']) {
      expect(resolveCloudLaneTestBudgetMs({ [ENV_VAR]: malformed }))
        .toBe(30_000 + 1_000 + CLOUD_LANE_GOTO_BOUND_MS + CLOUD_LANE_HARNESS_WAIT_BOUND_MS + shellPickerWorstCaseMs())
    }
  })

  it('always covers the permitted composition: connection envelope + picker worst + start reserve', () => {
    for (const windowMs of ['30000', '45000', '90000', '150000']) {
      const budget = resolveCloudLaneTestBudgetMs({ [ENV_VAR]: windowMs })
      expect(budget).not.toBeNull()
      expect(budget!).toBeGreaterThanOrEqual(
        Number(windowMs) + 1_000 + CLOUD_LANE_GOTO_BOUND_MS + CLOUD_LANE_HARNESS_WAIT_BOUND_MS + shellPickerWorstCaseMs(),
      )
    }
  })
})

describe('shellPickerWorstCaseMs (single source for the picker budget pieces)', () => {
  it('derives from the picker\'s real constants: settle + one click budget + one creation-probe budget per shell name + the render wait', () => {
    expect(shellPickerWorstCaseMs()).toBe(
      SHELL_PICKER_SETTLE_MS
        + SHELL_NAMES.length * (SHELL_CLICK_TIMEOUT_MS + SHELL_PROBE_TIMEOUT_MS)
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

describe('freshellPageFixtureTimeoutMs (the boot chain owns its own setup allowance, delta review r9)', () => {
  it('is the composed budget on the cloud lane — the fixture SETUP gets the large window, never the test body', () => {
    expect(freshellPageFixtureTimeoutMs({ [ENV_VAR]: '90000' })).toBe(321_500)
    expect(freshellPageFixtureTimeoutMs({ [ENV_VAR]: '60000' })).toBe(291_500)
  })

  it('is undefined on the local lane: fixture time counts toward the test timeout — the exact pre-run behavior', () => {
    expect(freshellPageFixtureTimeoutMs({})).toBeUndefined()
    expect(freshellPageFixtureTimeoutMs({ [ENV_VAR]: '' })).toBeUndefined()
  })

  it('falls back to the default window composition on malformed values (one parsing rule)', () => {
    for (const malformed of ['not-a-number', '0', '-5']) {
      expect(freshellPageFixtureTimeoutMs({ [ENV_VAR]: malformed }))
        .toBe(30_000 + 1_000 + CLOUD_LANE_GOTO_BOUND_MS + CLOUD_LANE_HARNESS_WAIT_BOUND_MS + shellPickerWorstCaseMs())
    }
  })

  it('stays pinned to the config default ceiling: the DEFAULT_TEST_TIMEOUT_MS the configs import', () => {
    expect(DEFAULT_TEST_TIMEOUT_MS).toBe(60_000)
  })
})

```

(The listing above is the committed implementation of this task as amended by the delta-review remediations (rounds 1-5) — the original draft derived the budget as window+30s; the committed derivation covers the fixture chain's permitted composition (delta r2) including the picker's creation-probe budget (delta r5), and the extension-predicate describe is the delta-r5 default-class-only unit pin.)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:e2e:helpers -- test-harness`

Expected: FAIL because the new exports (`resolveCloudLaneTestBudgetMs`, `isCloudLaneWindowConfigured`, `shellPickerWorstCaseMs`, the picker constants, `CLOUD_LANE_GOTO_BOUND_MS`, `CLOUD_LANE_HARNESS_WAIT_BOUND_MS`, `DEFAULT_TEST_TIMEOUT_MS`, `freshellPageFixtureTimeoutMs`) are missing from `./test-harness` — the suite reports the missing exports and cannot assert the composed budget derivation or the fixture-timeout value (the behavior is absent).

- [ ] **Step 3: Add the minimal production implementation**

In `test/e2e-browser/helpers/test-harness.ts`, directly after `resolveWsReadyTimeoutMs`:

```ts
/**
 * page.goto's ENFORCED bound in the freshellPage boot chain and the
 * composition (delta reviews r12+r13+r14): goto in this repo's tests is
 * otherwise UNBOUNDED — Playwright Test defaults navigationTimeout to
 * 0 (= disabled) when the config sets none (playwright/lib/index.js
 * _setupContextOptions sets _defaultContextNavigationTimeout =
 * navigationTimeout || 0, applied to every context), so without an
 * explicit bound a pathological navigation would pass silently under the
 * fixture slot (the exact loosening delta review r14 rejected). The
 * bound is 60_000 — the pre-run WHOLE-TEST deadline as the single
 * operation's own bound: a pathological goto (90-200s) dies at 60s
 * exactly where the pre-run deadline caught it, and a slow-but-recovering
 * goto (30-60s) keeps the pass envelope pre-run gave it. freshellPage
 * passes this explicitly to page.goto, and the composition carries it as
 * a first-class term.
 */
export const CLOUD_LANE_GOTO_BOUND_MS = 60_000

/**
 * The harness-install wait's ENFORCED bound INSIDE THE FRESHELLPAGE BOOT
 * CHAIN (delta reviews r12+r13+r14+r15): 60_000 — the pre-run
 * WHOLE-TEST deadline as the single wait's own bound, for the same
 * no-loosening/no-narrowing reasons as CLOUD_LANE_GOTO_BOUND_MS. The
 * freshellPage fixture passes it EXPLICITLY to waitForHarness; the
 * shared helper's no-arg default stays 0 (the pre-run effective
 * semantics — unrelated callers keep their own declared deadlines).
 * The composition carries it as a first-class term.
 */
export const CLOUD_LANE_HARNESS_WAIT_BOUND_MS = 60_000

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
 * never drift from the implementation (delta-reviews r2+r5): the
 * stabilization settle, at most one click budget plus one creation-probe
 * budget per shell name (every path through the loop makes at most
 * SHELL_NAMES.length clicks, each followed by at most one probe —
 * including the successful one), and at most one render wait.
 */
export function shellPickerWorstCaseMs(): number {
  return SHELL_PICKER_SETTLE_MS
    + SHELL_NAMES.length * (SHELL_CLICK_TIMEOUT_MS + SHELL_PROBE_TIMEOUT_MS)
    + SHELL_RENDER_TIMEOUT_MS
}

/**
 * Resolve the cloud-lane per-test deadline budget, or null on the local
 * lane (kata tg4e). The budget COVERS THE PERMITTED COMPOSITION of the
 * fixture chain (delta-reviews r2+r12+r13+r14): the connection envelope (waitForConnection
 * enforces its window W as a single total deadline, W + 1s slack) plus
 * the initial operations' ENFORCED bounds (goto + harness install — see
 * the BOUND constants) plus the picker's permitted worst case. The config's 60s
 * default deadline kills fixture setup mid-composition ("Test timeout of
 * 60000ms exceeded while setting up freshellPage" — the recorded tg4e flake,
 * whose retained trace shows connection AND render slowness co-occurring
 * in one container-wide disturbance). The budget derives from the SAME env
 * that scales the window (one source of truth, one parsing rule via
 * resolveWsReadyTimeoutMs) so a custom window scales the budget with it.
 * Callers must treat null as "do not touch the deadline" — the local
 * lane keeps the config default unchanged — and must apply the budget via
 * freshellPageFixtureTimeoutMs (the fixture's own setup timeout — never
 * a test-deadline modification).
 */
export function resolveCloudLaneTestBudgetMs(
  env: Record<string, string | undefined> = process.env,
): number | null {
  if (!isCloudLaneWindowConfigured(env)) return null
  const connectionEnvelopeMs = resolveWsReadyTimeoutMs(undefined, env) + 1000
  return connectionEnvelopeMs
    + CLOUD_LANE_GOTO_BOUND_MS
    + CLOUD_LANE_HARNESS_WAIT_BOUND_MS
    + shellPickerWorstCaseMs()
}

/**
 * The per-test deadline declared by the Playwright config (both lanes —
 * the cloud config inherits the base). DEFAULT-CLASS in the superseded
 * r5-r8 design; in the committed fixture-timeout design (delta r9) it is
 * simply the TEST BODY ceiling on every lane, and the configs import it
 * from here as the single source of truth.
 */
export const DEFAULT_TEST_TIMEOUT_MS = 60_000

/**
 * The freshellPage fixture's OWN setup timeout (delta review r9): the
 * composed budget on the cloud lane, or undefined on the local lane.
 * Playwright gives a fixture its own timeout precisely so slow SETUP can
 * receive a larger allowance while the test keeps its original deadline
 * (playwright.dev/docs/test-fixtures#fixture-timeout) — the boot chain
 * (goto + waitForHarness + self-healing waitForConnection + the picker
 * leg) is fixture setup, and its permitted composition — every piece now
 * carries an ENFORCED bound (connection W+1s, goto 60s explicit, harness
 * install 60s default, picker worst; delta reviews r12+r13+r14) — is
 * exactly what resolveCloudLaneTestBudgetMs derives: 321.5s at the
 * default window.
 * undefined means no
 * fixture-specific timeout: fixture time counts toward the test timeout —
 * the exact pre-run behavior the local lane keeps. The test's own
 * deadline is NEVER modified by the wiring.
 */
export function freshellPageFixtureTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  return resolveCloudLaneTestBudgetMs(env) ?? undefined
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
- Modify: `test/e2e-browser/helpers/test-harness.ts` (the self-healing branch of `waitForConnection`)
- Test: `test/e2e-browser/helpers/test-harness.test.ts` (the `TestHarness.waitForConnection wedge-tolerant self-heal (opt-in)` describe: update tests (c)/(d)/(f), add tests (g)/(h)/(i), extend `fakePage` with reload and phase-1 clock-advance options)

**Interfaces:**
- Consumes: the existing `fakePage(outcomes)` helper, `DEFAULT_WS_READY_TIMEOUT_MS`, `vi` from vitest (add to the existing vitest import).
- Produces (as amended by delta reviews r3+r4+r5): self-heal semantics where the clock starts BEFORE phase 1 and W is a single total deadline: phase-1 = `max(1, floor(W/2))` (the clamp keeps sub-2ms windows bounded — Playwright treats a 0 timeout as unlimited, delta r5); the reload's navigation timeout = `max(1, W - elapsedAtReloadStart)` (the ABSOLUTE remaining, never a fresh half-window — a late-firing phase 1 must shrink it, delta r4); and phase-2's poll = `max(0, W - totalElapsed) + 1000` (phase-1 + reload both charged, delta r3) — the whole self-heal path spends at most W + 1s wall clock, instead of each of the three steps independently consuming a full window (up to 135s at W=90s, a sequential drift that outgrew any per-test budget). Non-self-heal (`selfHealReload` absent) semantics are untouched: single poll, `W + 1000`.

**Why this is required scope:** the budget (Task 3) covers the chain's permitted composition; with the pre-fix 3-full-windows drift, a wedge that survives phase 1 and has a slow reload legally burns 135s of connection wait alone — more than the entire composition — recreating the recorded failure class. The j90s design intent ("keeps waiting with the remaining budget") and the j90s recap's Optional finding #4 both call for exactly this total-deadline enforcement; this run lands it.

- [ ] **Step 1: Write the failing behavioral tests (the complete new contract, RED as one unit)**

In `test-harness.test.ts`, extend `fakePage` to support reload AND phase-1 clock advances, wrap the affected tests in the fake clock for determinism, update tests (c)/(d)/(f) to the total-deadline expectations, and add tests (g)/(h)/(i). All of these are the RED suite (as amended by delta reviews r3+r4+r5): the implementation must take them to green in one Green step, with no assertion changes after implementation (Refactor happens while green).

(a) Extend `fakePage` (add an optional second parameter; keep every existing call site working unchanged):

```ts
function fakePage(
  outcomes: FakeWaitOutcome[] = [],
  opts: { reloadAdvanceMs?: number, phase1AdvanceMs?: number } = {},
) {
  // ...existing body unchanged except:
  //  - the FIRST waitForFunction call advances the (fake) clock by
  //    opts.phase1AdvanceMs before rejecting (a slow/lately-firing
  //    phase-1 burn), and
  //  - the reload fake advances the clock by opts.reloadAdvanceMs:
  //   reload: (...args: unknown[]) => {
  //     reloads.push(args)
  //     if (opts.reloadAdvanceMs) vi.setSystemTime(Date.now() + opts.reloadAdvanceMs)
  //     return Promise.resolve()
  //   },
}
```

(b) Add `vi` to the existing `vitest` import. Wrap tests (c)/(d)/(f)/(g)/(h) each in `vi.useFakeTimers({ toFake: ['Date'] })` / `try { ... } finally { vi.useRealTimers() }` (the fake clock makes elapsed time exactly controlled). The committed absolute-deadline expectations (as amended by delta reviews r3+r4 — the clock starts BEFORE phase 1, and the reload's OWN timeout derives from the absolute remaining):

```ts
  it('(c) self-heal ON + phase-1 timeout: exactly ONE reload, then a second poll bounded by the absolute deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const phase1 = Math.floor(DEFAULT_WS_READY_TIMEOUT_MS / 2)
      const { page, calls, reloads } = fakePage([{ reject: nativeTimeout(phase1) }, {}])
      await new TestHarness(page).waitForConnection(undefined, { selfHealReload: true })
      expect(reloads).toHaveLength(1)
      // Absolute-deadline contract: the reload's OWN timeout is the time
      // remaining on the absolute clock (W with the fake clock's elapsed 0),
      // not the original half-window — a late-firing phase 1 must shrink it.
      expect(reloads[0]).toEqual([{ timeout: DEFAULT_WS_READY_TIMEOUT_MS }])
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
      const { page, calls, reloads } = fakePage([{ reject: nativeTimeout(phase1) }, {}])
      await new TestHarness(page).waitForConnection(W, { selfHealReload: true })
      expect(calls[0][2]).toEqual({ timeout: phase1 })
      // Absolute-deadline contract: the reload's timeout is the absolute
      // remaining (W with fake elapsed 0), and phase 2 = W - totalElapsed + 1s.
      expect(reloads[0]).toEqual([{ timeout: W }])
      expect(calls[1][2]).toEqual({ timeout: W + 1000 })
    } finally {
      vi.useRealTimers()
    }
  })

```

(Keep every other assertion in (c)/(d) — the reload count, the three-argument binding pins, `reloads[0]` — unchanged.)

(c) Add to the self-heal describe (after test (e)) — as amended by delta reviews r3+r4+r5, including the slow-phase-1 case (g) and the late-burn case (h) that a reload-only clock cannot pass, and the sub-2ms clamp case (i):

```ts
  it('(f) absolute deadline: the reload elapsed time is charged to phase 2 (no multi-window envelope)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const phase1 = Math.floor(DEFAULT_WS_READY_TIMEOUT_MS / 2)
      const { page, calls, reloads } = fakePage(
        [{ reject: nativeTimeout(phase1) }, {}],
        { reloadAdvanceMs: 10_000 },
      )
      await new TestHarness(page).waitForConnection(undefined, { selfHealReload: true })
      expect(reloads).toHaveLength(1)
      // The reload's own timeout is the absolute remaining at its start
      // (W with fake elapsed 0), then its 10s burn is charged to phase 2.
      expect(reloads[0]).toEqual([{ timeout: DEFAULT_WS_READY_TIMEOUT_MS }])
      expect(calls).toHaveLength(2)
      expect(calls[1][2]).toEqual({ timeout: DEFAULT_WS_READY_TIMEOUT_MS - 10_000 + 1000 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('(g) absolute deadline: a slow PHASE-1 is charged to phase 2 too (the clock starts before phase 1)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const phase1 = Math.floor(DEFAULT_WS_READY_TIMEOUT_MS / 2)
      const { page, calls, reloads } = fakePage(
        [{ reject: nativeTimeout(phase1) }, {}],
        { phase1AdvanceMs: 8_000 },
      )
      await new TestHarness(page).waitForConnection(undefined, { selfHealReload: true })
      expect(reloads).toHaveLength(1)
      // Phase 1 burned 8s of wall clock before its poll expired; BOTH the
      // reload's own timeout AND phase 2 must shrink by it (delta r4).
      expect(reloads[0]).toEqual([{ timeout: DEFAULT_WS_READY_TIMEOUT_MS - 8_000 }])
      expect(calls).toHaveLength(2)
      expect(calls[1][2]).toEqual({ timeout: DEFAULT_WS_READY_TIMEOUT_MS - 8_000 + 1000 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('(h) absolute deadline: a phase-1 timeout firing LATE (beyond its own allowance) still keeps the envelope at W+1s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const phase1 = Math.floor(DEFAULT_WS_READY_TIMEOUT_MS / 2)
      // Starvation delays the timeout processing past the 15s allowance:
      // phase 1 consumed 18s of wall clock before its rejection ran.
      const { page, calls, reloads } = fakePage(
        [{ reject: nativeTimeout(phase1) }, {}],
        { phase1AdvanceMs: 18_000 },
      )
      await new TestHarness(page).waitForConnection(undefined, { selfHealReload: true })
      expect(reloads).toHaveLength(1)
      // The reload's timeout is the ABSOLUTE remaining (W - 18s), never
      // the original half-window — this is the drift delta r4 closed.
      expect(reloads[0]).toEqual([{ timeout: DEFAULT_WS_READY_TIMEOUT_MS - 18_000 }])
      expect(calls).toHaveLength(2)
      expect(calls[1][2]).toEqual({ timeout: DEFAULT_WS_READY_TIMEOUT_MS - 18_000 + 1000 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('(i) a sub-2ms window degrades to the tightest BOUNDED phases (Playwright treats a 0 timeout as unlimited)', async () => {
    const { page, calls } = fakePage()
    await new TestHarness(page).waitForConnection(1, { selfHealReload: true })
    // floor(1/2) = 0 would hand Playwright an UNLIMITED phase-1 window —
    // the absolute-deadline contract would be void. Clamp to >= 1ms.
    expect(calls[0][2]).toEqual({ timeout: 1 })
  })
```

- [ ] **Step 2: Run the focused tests and verify the intended failures**

Run: `npm run test:e2e:helpers -- test-harness`

Expected: SIX RED, all for the same absent behavior — the pre-remediation self-heal neither honors an absolute deadline starting before phase 1 nor bounds the reload by it:

- tests (c)/(d)/(f) FAIL on the reload assertions: the current code hands the reload the half-window `{ timeout: remaining }`, not the absolute remaining (`W` at fake elapsed 0).
- test (g) FAILs: the reload-only clock ignores the 8s phase-1 burn entirely — the reload's timeout is not reduced to `W - 8_000` and phase 2 is not `W - 8_000 + 1000`.
- test (h) FAILs: the same half-window reload yields `15_000` instead of the absolute `W - 18_000 = 12_000`.
- test (i) FAILs: `floor(1/2) = 0` hands phase 1 an unlimited window instead of the clamped `{ timeout: 1 }`.

Every other test in the lane stays green (the non-self-heal path and tests (a)/(b)/(e) are untouched).

- [ ] **Step 3: Add the minimal production implementation**

In `test-harness.ts`, replace the self-healing branch's reload + final poll:

```ts
    // ABSOLUTE deadline (kata tg4e, delta reviews r3+r4+r5): the clock
    // starts BEFORE phase 1; the reload's OWN window and phase 2 both
    // derive from the time remaining on that clock, so the whole
    // self-heal path spends at most W + 1s wall clock regardless of
    // which phase burns the time. A reload-only or half-window reload
    // clock would let a delayed phase 1 land on top of the envelope
    // under the same CPU contention this change addresses.
    const selfHealStartedAt = Date.now()
    // Math.max(1, ...): floor(W/2) = 0 would hand Playwright an UNLIMITED
    // phase-1 window (0 means "no timeout") for sub-2ms windows — voiding
    // the absolute-deadline contract. Degrade to the tightest bounded
    // phase instead (delta review r5).
    const phase1Ms = Math.max(1, Math.floor(resolvedTimeoutMs / 2))
    const readyWithinPhase1 = await this.page.waitForFunction(
      wsReadyPredicate,
      undefined,
      { timeout: phase1Ms },
    ).then(() => true, () => false)
    if (!readyWithinPhase1) {
      // Math.max(1, ...) — never 0: Playwright treats a 0 timeout as
      // UNLIMITED, and an exhausted envelope must fail fast, not mint an
      // unbounded reload on top of an already-blown deadline.
      const remainingAtReloadMs = Math.max(
        1,
        resolvedTimeoutMs - (Date.now() - selfHealStartedAt),
      )
      await this.page.reload({ timeout: remainingAtReloadMs })
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

Expected: PASS — the implementation takes the complete focused suite (updated (c)/(d)/(f) and new (g)/(h)/(i), plus every untouched test) to green in this one Green step.

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

### Task 3: The boot chain owns its budget — `freshellPage`'s own fixture timeout + committed contract spec

**Files:**
- Modify: `test/e2e-browser/helpers/fixtures.ts` (convert `freshellPage` to the tuple form with its own `{ timeout }` option — the fixture-timeout mechanism, delta review r9; make `e2eMachineId` deadline-neutral with its CONDITIONALLY-bounded registration fetch — delta reviews r5+r6; extend the module's existing `import` from `'./test-harness.js'`)
- Modify: `test/e2e-browser/playwright.config.ts` (import `DEFAULT_TEST_TIMEOUT_MS` from the helpers and use it as the config's `timeout` — one source of truth for the body ceiling both lanes share; the cloud config inherits the base value)
- Create: `test/e2e-browser/specs/e2e-budget-contract.spec.ts`
- Test: the new contract spec is this task's behavioral test (it runs on both lanes; on the cloud lane — env always present — it pins the real wiring), and its fixture-timeout MECHANISM pin is the deterministic behavioral regression test for the property the whole fix depends on.

**Interfaces:**
- Consumes: `freshellPageFixtureTimeoutMs()` (Task 1), `isCloudLaneWindowConfigured()` (the self-heal opt-in gate), the exported `test` object from `helpers/fixtures.ts` (tuple-form fixture definitions), `FRESHELL_E2E_WS_READY_TIMEOUT_MS` env presence.
- Produces (as amended by delta review r9): the `freshellPage` fixture carries its OWN setup timeout — the composed budget on the cloud lane, undefined locally (fixture time counts toward the test timeout, the exact pre-run behavior) — so slow boot SETUP gets its allowance while every test body keeps its declared or config-default ceiling on every lane. The wiring NEVER modifies a test's own deadline: a declared 0 (Playwright's UNLIMITED), a declared 180s, a declared 300s all reach the run unchanged; specs that need a larger BODY budget declare it themselves (settings' two reload tests do — Task 5). The registration fetch inside `e2eMachineId` is bounded CONDITIONALLY: `AbortSignal.timeout` (60s, generous beyond every documented stall episode) applies only when the test's own deadline is unlimited (0) — a finite deadline already bounds the fetch (Playwright aborts fixture resolution at the deadline), and an unconditional private bound would be a new setup-flake vector inside the first fixture every freshellPage test resolves (delta reviews r5+r6).

- [ ] **Step 1: Write the failing behavioral test (the contract spec + the wiring-presence pin)**

Create `test/e2e-browser/specs/e2e-budget-contract.spec.ts` — ONE module with ONE import block: the deadline-neutrality pins use the plain `test` object, and the fixture-timeout APPLICATION pin (delta reviews r12+r14) uses a SCOPED `testSlowBoot` extension that overrides the `harness` DEPENDENCY with a TestHarness subclass whose waitForHarness deterministically sleeps 70s before delegating — only that pin resolves the slow harness; the spec's other pins keep the real (fast) one. The module's pieces in listing order:

```ts
import { test, expect } from '../helpers/fixtures.js'
import { DEFAULT_TEST_TIMEOUT_MS, isCloudLaneWindowConfigured, TestHarness } from '../helpers/test-harness.js'
import type { Page } from '@playwright/test'

// ...the deadline-neutrality pins on the plain `test` object (their full
// committed bodies are listed below)...

// The fixture-timeout APPLICATION pin (delta reviews r12+r14): it
// exercises THE PRODUCTION freshellPage REGISTRATION — not a synthetic
// witness. The pin's own test object overrides the `harness` DEPENDENCY
// with a TestHarness subclass whose waitForHarness deterministically
// sleeps 70s before delegating, so the production fixture's own setup
// legally exceeds the test's own CONFIG-DEFAULT deadline (60s — the same
// deadline every other spec runs under, so the pin's prerequisite-fixture
// stall exposure is exactly the lane's status quo, not a new flake
// vector; delta r14): reaching the test body is only possible if the
// production tuple wiring ({ timeout: freshellPageFixtureTimeoutMs() } in
// fixtures.ts) carries the boot on freshellPage's separate timeout slot.
// With the wiring removed, this test dies with the EXACT production
// tg4e message — "Test timeout of 60000ms exceeded while setting up
// 'freshellPage'" — deterministically (the 70s sleep dominates any
// machine speed). Validated by mutation during the r14 remediation. The
// lane-derived composed value (321.5s at the default window — every
// piece now carries an ENFORCED bound: connection W+1s, goto 60s
// explicit, harness install 60s at the boot call site, picker worst)
// is behaviorally unit-pinned by freshellPageFixtureTimeoutMs. ONLY this pin resolves
// the slow harness: the spec's other pins keep the real (fast) harness.
class DeterministicallySlowBootHarness extends TestHarness {
  constructor(page: Page) {
    super(page)
  }

  override async waitForHarness(timeoutMs?: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 70_000))
    return super.waitForHarness(timeoutMs)
  }
}

const testSlowBoot = test.extend<{ harness: TestHarness }>({
  harness: async ({ page }, use) => {
    await use(new DeterministicallySlowBootHarness(page))
  },
})
```

And the application pin's describe (the module's LAST block — but note it is listed here before the neutrality pins' full bodies for narrative order; in the committed file the neutrality pins come first, then the pin class, then this describe):

```ts
// The behavioral pin itself: the test keeps the CONFIG-DEFAULT 60s
// deadline — the same deadline every other spec runs under, so the
// prerequisite fixtures (e2eMachineId's registration, context, page)
// have exactly the stall exposure the rest of the lane already has
// (delta r14). The production freshellPage boot (deterministically
// >= 70s via the slow harness dependency) survives ONLY on the
// production fixture's own timeout slot. Reaching the body is the
// assertion — losing the tuple options in fixtures.ts fails this test
// with the EXACT production tg4e message, deterministically.
// Cloud-lane-only by the wiring's design: locally
// freshellPageFixtureTimeoutMs() is undefined (the exact pre-run local
// behavior), so the pin skips when the window env is not configured
// (the no-env leg reports it skipped).
testSlowBoot.describe('the production fixture-timeout application (delta reviews r12+r14)', () => {
  testSlowBoot.skip(!isCloudLaneWindowConfigured(), 'the fixture timeout is cloud-lane wiring; the local lane keeps its exact pre-run behavior')
  testSlowBoot('freshellPage setup outlives the test\'s own config-default deadline on the fixture\'s OWN production timeout slot', async ({ freshellPage }) => {
    void freshellPage
    // The test's own slot is intact and untouched after the 70s boot
    // rode the fixture's separate slot.
    expect(testSlowBoot.info().timeout).toBe(DEFAULT_TEST_TIMEOUT_MS)
  })
})
```

The deadline-neutrality pins (CONTINUING THE SAME MODULE — the plain `test`/`expect`/`DEFAULT_TEST_TIMEOUT_MS`/`isCloudLaneWindowConfigured` are already imported above; no repeated imports):

```ts
// Contract (kata tg4e, main-green campaign, delta review r9): the cloud
// wedge budget is the freshellPage FIXTURE's own setup timeout — Playwright
// gives a fixture a separate larger timeout precisely so slow setup (the
// boot chain: goto + waitForHarness + self-healing waitForConnection +
// the picker leg, whose permitted composition exceeds the config's 60s
// default — the recorded "Test timeout of 60000ms exceeded while setting up
// freshellPage" flake) can be allowed a larger window while the test keeps
// its original deadline. The wiring NEVER modifies a test's own deadline:
// every body keeps its declared or config-default ceiling on every lane
// (the former whole-test extension gave unrelated bodies ~171.5s of extra
// ceiling and could suppress their flakes — one flake at a time). The
// fixture-timeout value itself is unit-pinned (freshellPageFixtureTimeoutMs
// in test-harness.test.ts: the composed budget on the cloud lane,
// undefined locally).

test('the wiring never touches the test\'s own deadline: the undeclared default is kept on both lanes', ({ freshellPage }) => {
  // With the old whole-test extension this was the composed budget on the
  // cloud lane. The deterministic exact-value pins live in the declared
  // describes below (immune to --timeout overrides); this pin covers the
  // undeclared case under the lanes' stock invocation.
  expect(test.info().timeout).toBe(DEFAULT_TEST_TIMEOUT_MS)
})

// Extend-only contract, larger side: a spec that declares a LARGER
// deadline keeps its own — trivially true now (the wiring touches no test
// deadline at all), pinned anyway (idle-gate-semantics declares 300_000).
test.describe('declared budgets larger than the wedge budget', () => {
  test.beforeEach(() => {
    test.setTimeout(300_000)
  })
  test('keeps its declared deadline on both lanes', ({ freshellPage }) => {
    expect(test.info().timeout).toBeGreaterThanOrEqual(300_000)
  })
})

// Two-sided pin: a describe that declares a SMALLER deadline than the
// composed budget. With the old whole-test extension the cloud lane RAISED
// it to the budget (the r2-r8 design); the fixture-timeout design keeps it
// EXACTLY as declared on both lanes — the boot chain's allowance is the
// fixture's own timeout, not the test's. A per-test hook declaration
// overrides any config default or --timeout override, so the declared
// 60_000 is deterministic on both lanes.
test.describe('declared budgets smaller than the wedge budget', () => {
  test.beforeEach(() => {
    test.setTimeout(60_000)
  })
  test('stays exactly as declared on both lanes (the body keeps its ceiling; the fixture owns the setup envelope)', ({ freshellPage }) => {
    expect(test.info().timeout).toBe(60_000)
  })
})

// Extend-only contract, unlimited side (delta review r4): Playwright's
// timeout value 0 means UNLIMITED, and the wiring must never replace it
// with a finite budget. Resolves ONLY e2eMachineId — the fixture whose
// conditional registration-fetch bound is the only hazard under an
// unlimited deadline — so the unlimited deadline never wraps a full page
// boot (goto/picker chains whose wedges could otherwise hang the cloud
// task to its own kill timer; delta reviews r5+r9).
test.describe('declared unlimited (0) deadline', () => {
  test.beforeEach(() => {
    test.setTimeout(0)
  })
  test('stays unlimited on both lanes (a finite budget would shrink it)', ({ e2eMachineId }) => {
    expect(test.info().timeout).toBe(0)
  })
})

// Above-default contract (delta reviews r5+r9): a deadline declared ABOVE
// the config default is an explicit spec budget decision — e.g.
// launch-retry-restart-rust's declared 180s is the deadline its own
// recorded flake exhausts; that spec's budget belongs to its own deflake
// run. The wiring keeps it exactly as declared on both lanes. Resolves
// ONLY e2eMachineId (not freshellPage): the boot chain's permitted
// composition (321.5s at the default window) exceeds 180s, so wrapping
// the full boot under a knowingly-insufficient deadline would reintroduce
// the tg4e setup-flake class inside this contract test itself (delta
// review r9, Major 2).
test.describe('declared deadlines above the config default stay as declared', () => {
  test.beforeEach(() => {
    test.setTimeout(180_000)
  })
  test('keeps exactly its declared budget on both lanes', ({ e2eMachineId }) => {
    expect(test.info().timeout).toBe(180_000)
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run (env-set local invocation reproduces the cloud-shaped path; first local run pays the global-setup build):

```bash
FRESHELL_E2E_WS_READY_TIMEOUT_MS=90000 npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/e2e-budget-contract.spec.ts
```

Expected (delta reviews r13+r14 — a TRUE Red for the wiring application, the thing rounds 10-12 thought impossible): under the env-set leg, the APPLICATION pin FAILS — pre-wiring, freshellPage is still in the FUNCTION form (no fixture timeout), so its deterministically slowed boot (>= 70s via the slow harness dependency) dies against the test's own CONFIG-DEFAULT 60s deadline with the EXACT original production message, Test timeout of 60000ms exceeded while setting up 'freshellPage'. Every other test in the spec is green (they pin deadline-neutrality, which the unwired state already satisfies — and they resolve the real, fast harness). On the no-env leg the pin SKIPS (the wiring it pins is cloud-gated; locally freshellPageFixtureTimeoutMs() is undefined — the exact pre-run behavior) and the rest is green. Step 3 turns exactly this one Red green. The deadline-neutrality pins are green pre-wiring BY DESIGN — they pin the ABSENCE of deadline modification, and their RED value is against deadline-MUTATING wiring (demonstrated against the r2-r8 whole-test extension during the r9 remediation: three pins failed until the wiring was removed). The wiring's three failure modes are each covered: a wrong VALUE fails freshellPageFixtureTimeoutMs's unit pins (Task 1); a broken APPLICATION fails the production pin — WHICH IS THE TASK'S RED (see Step 2: pre-wiring it fails with the production tg4e signature); a wedged-boot budget insufficiency beyond the composition falls to the full-lane zero-flake gate (Task 7), exactly as it was pre-run. Playwright exposes no runtime API for a fixture's registered timeout, and the repo's quality bar rejects source-text pins — this hierarchy is the qualifying coverage.

```bash
env -u FRESHELL_E2E_WS_READY_TIMEOUT_MS npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/e2e-budget-contract.spec.ts
```

- [ ] **Step 3: Add the minimal production implementation**

In `test/e2e-browser/helpers/fixtures.ts`: extend the existing import from `'./test-harness.js'` with `freshellPageFixtureTimeoutMs`, convert `freshellPage` to the tuple form with its own timeout, and make `e2eMachineId` deadline-neutral with the conditional fetch bound (the committed form):

```ts
  // Tuple form with the fixture's OWN timeout (delta review r9): the boot
  // chain below (goto + waitForHarness + self-healing waitForConnection +
  // the picker leg) is fixture SETUP, and Playwright allows a fixture a
  // separate larger timeout so slow setup gets its allowance while the
  // TEST keeps its original deadline. On the cloud lane the timeout is the
  // composed budget (freshellPageFixtureTimeoutMs -> 321.5s at the default
  // window); locally it is undefined — fixture time counts toward the test
  // timeout, the exact pre-run behavior. The wiring NEVER modifies the
  // test's own deadline.
  freshellPage: [
    async ({ page, serverInfo, harness }, use) => {
      // ...the committed boot chain (goto with its EXPLICIT
      // CLOUD_LANE_GOTO_BOUND_MS timeout — delta r14: unconfigured
      // Playwright-Test navigation is UNLIMITED — waitForHarness,
      // waitForConnection with the isCloudLaneWindowConfigured()
      // self-heal gate, selectShellFromPicker, killAllTerminals)...
      await use(page)
    },
    { timeout: freshellPageFixtureTimeoutMs() },
  ],

  // Cloud-lane wedge budget (kata tg4e, delta review r9): the envelope
  // lives on the freshellPage fixture's OWN timeout. This fixture never
  // touches the test deadline; a declared 0 (Playwright's UNLIMITED)
  // reaches it unchanged — hence the conditional registration-fetch
  // bound below.
  e2eMachineId: async ({ testServer }, use) => {
    // Bound the registration fetch ONLY under an unlimited (0) test
    // deadline (delta reviews r5+r6): finite-deadline tests keep their
    // exact pre-run behavior; under unlimited there is no deadline to
    // bound anything, so the generous 60s bound makes a wedge fail loudly
    // instead of hanging the cloud task to its own kill timer.
    const machine = await registerE2eMachine(testServer.info, undefined, {
      fetchTimeoutMs: test.info().timeout === 0 ? 60_000 : undefined,
    })
    await use(machine.id)
  },
```

And in the same module, bound the registration fetch CONDITIONALLY (delta reviews r5+r6 — an unbounded fetch is un-killable only under an unlimited test deadline; a finite deadline already bounds it, because Playwright aborts fixture resolution at the deadline, and an unconditional private bound would be a NEW setup-flake vector inside the FIRST fixture every freshellPage test resolves, with no retry to survive the documented 40-60s container/loopback stall class):

```ts
  // registerE2eMachine gains an opts param (unbounded by default):
  export async function registerE2eMachine(
    serverInfo: E2eServerInfo,
    label = `Playwright test machine ${Date.now()}`,
    opts: { fetchTimeoutMs?: number } = {},
  ): Promise<E2eMachine> {
    // ...
    const created = await fetch(`${serverInfo.baseUrl}/api/machines`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ label }),
      ...(opts.fetchTimeoutMs !== undefined
        ? { signal: AbortSignal.timeout(opts.fetchTimeoutMs) }
        : {}),
    })
  }

  // The e2eMachineId fixture bounds it ONLY under an unlimited deadline:
  const machine = await registerE2eMachine(testServer.info, undefined, {
    fetchTimeoutMs: test.info().timeout === 0 ? 60_000 : undefined,
  })
  await use(machine.id)
```

The 60s bound is generous beyond every documented stall episode in this run's receipts; under a genuine wedge the unlimited-deadline pin fails loudly at 60s instead of hanging the cloud task to its own kill timer. Finite-deadline tests keep their exact pre-run behavior. The abort-fires path is not unit-tested: exercising it would require an artificially wedged server (a mock would test the mock); the bounded path itself is exercised by the unlimited pin's resolution on every run of the contract spec.

- [ ] **Step 4: Run the focused test**

Run:

```bash
FRESHELL_E2E_WS_READY_TIMEOUT_MS=90000 npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/e2e-budget-contract.spec.ts
```

Expected: PASS (the Step 2 Red is now green: the production tuple wiring carries the deterministically >= 70s slowed boot on the fixture's OWN slot, so the application pin reaches its body and observes its intact config-default 60s slot; the undeclared test keeps DEFAULT_TEST_TIMEOUT_MS on the env-set path — the wiring touches no test deadline; every declared test keeps its exact value: 300_000, 60_000, 0, 180_000). Then re-run the no-env leg:

```bash
env -u FRESHELL_E2E_WS_READY_TIMEOUT_MS npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/e2e-budget-contract.spec.ts
```

Expected: PASS (identical deadline values as the env-set leg — the wiring is deadline-neutral on both lanes; the fixture's own timeout is the only lane difference, unit-pinned by freshellPageFixtureTimeoutMs).

- [ ] **Step 5: Refactor while green**

None beyond the comment placement above (the settings.spec.ts duplicate hook removal is Task 5 — keep it in place until then so settings' reload tests keep their pre-run coverage until they declare their own budgets).

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
git add test/e2e-browser/helpers/fixtures.ts test/e2e-browser/specs/e2e-budget-contract.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): the boot chain owns its budget — freshellPage fixture timeout, deadline-neutral wiring (kata tg4e)"
```

### Task 4: Fix the `selectShellFromPicker` slow-render conflation (the recorded budget burner)

**Files:**
- Modify: `test/e2e-browser/helpers/test-harness.ts` (add the restructured `selectShellFromPicker` as an exported page-flow helper near `TestHarness` — it is page-manipulation logic, not fixture wiring; plus the `SHELL_RENDER_TIMEOUT_MS` export)
- Modify: `test/e2e-browser/helpers/fixtures.ts` (delete the module-private `selectShellFromPicker` and import the new one from `'./test-harness.js'`; the only call site is the `freshellPage` fixture)
- Test: `test/e2e-browser/helpers/test-harness.test.ts` (new `describe` with a purpose-built fake page following the file's existing fakePage pattern)

**Interfaces:**
- Consumes: `Page` (type-only).
- Produces: `SHELL_RENDER_TIMEOUT_MS: number` (60_000), `SHELL_PROBE_TIMEOUT_MS: number` (5_000, delta review r5), and `selectShellFromPicker(page: Page): Promise<void>` with the contract: (a) early returns unchanged (xterm already visible, or appears during the 500ms stabilization wait); (b) a click that fails with Playwright's `TimeoutError` is split by an existence precheck (delta reviews r7+r8): `locator.count() === 0` is AMBIGUOUS — the option never existed, OR the click dispatched and the picker pane was already replaced by the terminal pane (the picker's fade-then-replace on transitionend) before the catch ran — so the count-0 branch takes ONE immediate state read (`paneWasCreatedNow`: a dispatched-and-replaced pick has ALREADY created the terminal pane in state, so the instant read is true and the flow joins the render wait; a never-existed option reads false and advances on the click timeout alone, keeping absent options at their exact pre-run cost under the unchanged local 60s budget). Only an EXISTING button that timed out pays the full bounded creation probe (`SHELL_PROBE_TIMEOUT_MS`, checking for a TERMINAL-content pane — the only state a fresh-boot pick uniquely creates, since the initial tab and its picker pane already exist before the picker leg runs; delta review r6: an any-tab/any-layout signal is always true on fresh boot and would misroute absent options into the 60s render wait). A late dispatch joins the success path (d); only a confirmed nothing-created advances to the next shell name (the historical detachment-race advance, now dispatch-safe; delta reviews r5+r6+r7+r8); (c) a click (or probe) that fails with ANY non-timeout error (page closed, test interrupted, unexpected errors) propagates — loud, never swallowed; (d) a SUCCESSFUL click never escalates: it waits up to `SHELL_RENDER_TIMEOUT_MS` for `.xterm` to become visible; a TimeoutError throws a diagnostic naming the clicked shell and the wait, and any non-timeout failure (page closure, crash, interruption) propagates with its original identity (delta review r10); (e) the every-option-confirmed-absent fall-through contract is preserved (returns normally).

**Why this is required scope (not residual):** the retained trace (validator LB-C, `reports/load-bearing-validator-LB-C.md`) proves the recorded tg4e failure was exactly this conflation: after a successful Shell click (terminal created server-side, active, `hasClients:true`), the 30s `.xterm` render wait failed under container-wide CPU contention, and the loop escalated into WSL/CMD — options absent on the Linux picker — silently burning the remaining budget until the 60s deadline (and double-creating terminals whenever escalation reaches an option that exists, e.g. Bash). The budget fix alone does not survive this episode class; the loop's semantics are the defect.

- [ ] **Step 1: Expose the current behavior unchanged, then write the failing behavioral tests**

**(a) Pure move, no semantic change:** move the CURRENT `selectShellFromPicker` implementation verbatim from `fixtures.ts` (lines 128-161, with its doc comment) to `test/e2e-browser/helpers/test-harness.ts` as an exported function, and import it in `fixtures.ts` from `'./test-harness.js'` (the `freshellPage` call site is unchanged). This is not the fix — it exposes the existing defective behavior so the new tests can fail against it behaviorally, not as a module-load error. Do not change the function's logic, timeouts, or swallow-shape in this step.

**(b) Write the tests:** add to `test/e2e-browser/helpers/test-harness.test.ts` (extend the existing import from `'./test-harness'` with `selectShellFromPicker` and `SHELL_RENDER_TIMEOUT_MS`):

```ts
describe('selectShellFromPicker slow-render contract (kata tg4e)', () => {
  interface ShellOutcome {
    clickError?: 'page-closed' // not-clickable click by default (TimeoutError)
    renderVisibleAfterMs?: number // omit = render never becomes visible
    lateDispatch?: boolean // click times out BUT the handler ran: the probe finds a created pane
    clickTimesOut?: boolean // click times out with NOTHING dispatched (the button exists)
    dispatchedAndReplaced?: boolean // click dispatched, then the picker pane was REPLACED by the terminal pane before the catch ran (count 0, terminal already in state — delta r8)
    renderError?: 'page-closed' // the render wait fails with a HARD non-timeout error (delta r10)
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
    opts: { xtermVisibleFromCall?: number, probeHardError?: boolean } = {},
  ) {
    const clicks: string[] = []
    const renderWaits: number[] = []
    const clickTimeouts: number[] = []
    const settledMs: number[] = []
    const probeWaits: number[] = []
    const probeNows: number[] = []
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
            if (currentShell()?.renderError === 'page-closed') {
              // A hard infrastructure failure during the render wait —
              // must keep its identity (delta r10).
              return Promise.reject(Object.assign(new Error('Page closed'), { name: 'TargetClosedError' }))
            }
            const visibleAfter = currentShell()?.renderVisibleAfterMs
            if (visibleAfter === undefined || visibleAfter > (timeout ?? 0)) {
              // Playwright's real locator.waitFor timeout carries the
              // TimeoutError name — the loudness distinction depends on it.
              return Promise.reject(Object.assign(new Error(`waitFor: Timeout ${timeout}ms exceeded`), { name: 'TimeoutError' }))
            }
            return Promise.resolve()
          },
        }),
      }),
      getByRole: (_kind: string, roleOpts: { name: RegExp }) => ({
        // Existence signal for the post-timeout precheck (delta r7): a
        // non-existent option cannot have dispatched and must not pay a
        // probe.
        count: () => {
          const name = roleOpts.name.source.replace(/^\^/, '').replace(/\$$/, '')
          const outcome = shells[name]
          return Promise.resolve(outcome && !outcome.dispatchedAndReplaced ? 1 : 0)
        },
        click: (clickOpts: { timeout?: number }) => {
          clickTimeouts.push(clickOpts?.timeout ?? 0)
          const name = roleOpts.name.source.replace(/^\^/, '').replace(/\$$/, '')
          clicks.push(name)
          const outcome = shells[name]
          if (outcome?.clickError === 'page-closed') {
            return Promise.reject(Object.assign(new Error('Page closed'), { name: 'TargetClosedError' }))
          }
          if (outcome?.lateDispatch) {
            // The click's actionability window expired mid-dispatch: the
            // timeout fires even though the handler ran (delta r5 probe case).
            return Promise.reject(Object.assign(new Error(`click: Timeout ${clickOpts?.timeout}ms exceeded`), { name: 'TimeoutError' }))
          }
          if (outcome?.dispatchedAndReplaced) {
            // Playwright delivered the action but timed out in post-action
            // processing; by the time the catch runs the picker pane is
            // already REPLACED by the terminal pane (delta r8 race case).
            return Promise.reject(Object.assign(new Error(`click: Timeout ${clickOpts?.timeout}ms exceeded`), { name: 'TimeoutError' }))
          }
          if (outcome?.clickTimesOut) {
            // The button exists but the actionability window expired with
            // nothing dispatched (delta r7 precheck case).
            return Promise.reject(Object.assign(new Error(`click: Timeout ${clickOpts?.timeout}ms exceeded`), { name: 'TimeoutError' }))
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
      // The instant state read for the count-0 branch (delta r8): the
      // picker-replacement race means the terminal pane is ALREADY in
      // state when the button vanished — one evaluate answers it.
      evaluate: (_fn: unknown) => {
        probeNows.push(1)
        const last = shells[clicks[clicks.length - 1]]
        return Promise.resolve(Boolean(last?.lateDispatch || last?.dispatchedAndReplaced))
      },
      // The post-click-timeout creation probe (delta r5): resolves when the
      // late-dispatched pick created a pane; a plain timeout means nothing
      // was created; a hard error (page closed) propagates loudly.
      waitForFunction: (_fn: unknown, _arg: unknown, fnOpts?: { timeout?: number }) => {
        probeWaits.push(fnOpts?.timeout ?? 0)
        if (opts.probeHardError) {
          return Promise.reject(Object.assign(new Error('Page closed'), { name: 'TargetClosedError' }))
        }
        const last = shells[clicks[clicks.length - 1]]
        if (last?.lateDispatch) return Promise.resolve()
        return Promise.reject(Object.assign(new Error(`probe: Timeout ${fnOpts?.timeout}ms exceeded`), { name: 'TimeoutError' }))
      },
    }
    return {
      page: page as unknown as Page,
      clicks,
      renderWaits,
      clickTimeouts,
      settledMs,
      probeWaits,
      probeNows,
      xtermVisibilityChecks: () => xtermVisibilityChecks,
    }
  }

```

(The listing above is the committed fake as amended by delta reviews r3+r5 — it records the click timeout, settle, and creation-probe arguments and connects them to the exported constants `shellPickerWorstCaseMs()` composes from, so the budget's picker envelope provably derives from the timeouts `selectShellFromPicker` really uses.)

- [ ] **Step 2: Run the tests and verify the intended BEHAVIORAL failures**

Run: `npm run test:e2e:helpers -- test-harness`

Expected: the moved-but-unfixed implementation produces multiple BEHAVIORAL failures (the module exports exist — this is not a load failure; the tests execute the current defective behavior and fail for the right reasons):

- `a successful click waits the full render budget and never escalates` FAILs: `renderWaits` is `[30_000]` (the current 30s wait), not `[SHELL_RENDER_TIMEOUT_MS]` (60_000).
- `survives a render slower than the historical 30s wait` FAILs: the current 30s wait rejects at 35s and the loop escalates — `clicks` is `['Shell', 'WSL', ...]`, not `['Shell']`.
- `throws a diagnostic when a clicked shell never renders` FAILs: the current loop catches the wait error, swallows it, and escalates/falls through — no throw, and `clicks` grows past `['Shell']`.
- `a non-timeout click error propagates` FAILs: the current loop's bare `catch { continue }` swallows the page-closed error and advances.
- `falls through silently only when every option is not clickable` PASSES (that is the current behavior too — it stays).
- The already-visible and mid-wait-recheck tests PASS (early-return behavior is unchanged by the fix).
- `a not-clickable option ... advances to the next shell` PASSES against the moved pre-fix loop (advance-on-timeout without a probe is the historical behavior) but the probe rows RED against it: `a click timeout with a LATE DISPATCH ... is treated as the success path` FAILs (the pre-probe loop escalates — `clicks` grows past `['Shell']`), `a click timeout on an EXISTING option probes once before advancing` FAILs (`probeWaits` is empty — no probe call exists), `a click timeout on a NON-EXISTENT option (count 0) advances with NO probe cost` FAILs against the probe-everything shape (the probe ran for absent options), `a click that DISPATCHED and replaced the picker before the catch (count 0) still joins the success path` FAILs against the skip-everything shape (the loop advanced instead of taking the instant read + render wait), and `a probe hard error (page closed) propagates loudly` FAILs (the pre-probe loop swallows the whole click-timeout path and falls through silently), and `a render-wait HARD error (page closed) propagates with its original identity` FAILs against the moved pre-r10 catch (it rewrote EVERY failure as the did-not-render diagnostic, losing the TargetClosedError identity).
- The `paneCreationProbePredicate semantics` describe (delta review r6) executes the REAL exported predicate against stubbed harness states — fresh-boot picker state false, terminal pane true, split-tree recursion, picker-only split false, missing harness false — so the probe's state-shape contract is pinned independently of the flow fakes (the fakes exercise the picker LOOP's use of the probe; the semantics tests prove what the probe itself answers in the states Freshell really boots into).

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
 * the composed cloud budget.
 */
export const SHELL_RENDER_TIMEOUT_MS = 60_000

/** The PanePicker stabilization settle after WS connection (ms). */
export const SHELL_PICKER_SETTLE_MS = 500

/** Per-option click budget (ms): a timeout means "not clickable within
 * the window" (absent, detached, or obstructed) — the historical advance
 * case; Playwright's click auto-retry already absorbs transient
 * detachments inside this window. */
export const SHELL_CLICK_TIMEOUT_MS = 5_000

/**
 * Post-click-timeout creation-probe budget (ms, delta review r5):
 * Playwright's click timeout spans EVERY click stage — a timed-out click
 * does NOT prove the handler never ran. After a click TimeoutError the
 * picker waits this window for the harness state to show a created
 * tab/pane: a late dispatch is treated as the success path (render
 * wait), and only a confirmed nothing-created advances to the next
 * option (escalating on a late dispatch is the historical
 * double-creation path). Sized to the click budget: symmetric absorption
 * of the same dispatch lateness the click window tolerates.
 */
export const SHELL_PROBE_TIMEOUT_MS = 5_000

/** The shell options, in the order the picker leg tries them. Every
 * path through the loop makes at most one click per name. */
export const SHELL_NAMES = ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash'] as const

/** Playwright's native TimeoutError (click unavailability, probe
 * nothing-created): the bounded "not within the window" signal; anything
 * else (page closed, interruption, unexpected errors) is loud. */
function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError'
}

/**
 * Whether the page's harness state shows a TERMINAL-content pane —
 * the in-page predicate for the post-click-timeout creation probe (delta
 * reviews r5+r6). Must stay self-contained serializable (Playwright ships
 * its source). The signal is deliberately NOT "any tab or layout exists":
 * Freshell creates the initial tab and its picker pane BEFORE
 * selectShellFromPicker runs, so only a terminal-content leaf (what a
 * fresh-boot pick uniquely creates) distinguishes a late-dispatched click
 * from the pre-existing picker state. Exported for direct unit testing
 * against real state shapes.
 */
export function paneCreationProbePredicate(): boolean {
  const state = window.__FRESHELL_TEST_HARNESS__?.getState?.() as unknown as
    | { panes?: { layouts?: Record<string, unknown> } }
    | undefined
  if (!state) return false
  const layouts = state.panes?.layouts ?? {}
  const hasTerminalPane = (node: unknown): boolean => {
    if (node == null || typeof node !== 'object') return false
    const n = node as { type?: string; content?: { kind?: string }; children?: unknown[] }
    if (n.type === 'leaf') return n.content?.kind === 'terminal'
    if (Array.isArray(n.children)) return n.children.some(hasTerminalPane)
    return false
  }
  return Object.values(layouts).some(hasTerminalPane)
}

/**
 * Probe whether a timed-out click still dispatched (delta review r5):
 * waits up to SHELL_PROBE_TIMEOUT_MS for a created tab/pane. A timeout is
 * "nothing was created" (false); any non-timeout error propagates loudly.
 */
async function paneWasCreatedOnLateDispatch(page: Page): Promise<boolean> {
  try {
    await page.waitForFunction(
      paneCreationProbePredicate,
      undefined,
      { timeout: SHELL_PROBE_TIMEOUT_MS },
    )
    return true
  } catch (err) {
    if (!isTimeoutError(err)) throw err
    return false
  }
}

/**
 * ONE immediate state read — the count-0 branch's disambiguator (delta
 * review r8): a dispatched pick that made the button vanish did so by
 * REPLACING the picker pane with the terminal pane (the picker's
 * fade-then-replace on transitionend), so the terminal pane is ALREADY in
 * state and a single evaluate answers true with no wait budget; a
 * never-existed option answers false. This keeps absent options at their
 * exact pre-run cost while closing the dispatch race.
 */
async function paneWasCreatedNow(page: Page): Promise<boolean> {
  return page.evaluate(paneCreationProbePredicate)
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
  await page.waitForTimeout(SHELL_PICKER_SETTLE_MS)

  const xtermNow = await page.locator('.xterm').first().isVisible().catch(() => false)
  if (xtermNow) return

  for (const name of SHELL_NAMES) {
    const button = page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
    try {
      await button.click({ timeout: SHELL_CLICK_TIMEOUT_MS })
    } catch (err) {
      if (!isTimeoutError(err)) throw err
      // An option that never existed cannot have dispatched: advance on
      // the click timeout alone, with no probe cost (delta review r7 —
      // absent options paid a needless 5s probe on every healthy boot
      // whose picker omits them, under the unchanged local 60s budget).
      if (await button.count() === 0) {
        // count() === 0 is AMBIGUOUS (delta review r8): the option never
        // existed, OR the click dispatched and the picker pane was
        // already REPLACED by the terminal pane (the picker's
        // fade-then-replace) before this catch ran. In the latter the
        // terminal pane is ALREADY in state — one immediate read answers
        // with no wait budget. Only a confirmed never-existed advances.
        if (!(await paneWasCreatedNow(page))) continue
      } else if (!(await paneWasCreatedOnLateDispatch(page))) {
        // The button still exists but was not clickable within its
        // window: a late dispatch may still land mid-fade, so this branch
        // pays the full bounded probe.
        continue
      }
    }
    try {
      await page.locator('.xterm').first().waitFor({ state: 'visible', timeout: SHELL_RENDER_TIMEOUT_MS })
      return
    } catch (err) {
      // Only a TimeoutError may be diagnosed as render starvation (delta
      // review r10): a page closure, browser crash, or interruption keeps
      // its own identity — rewriting infrastructure failures as "did not
      // render" would misdiagnose them, the exact swallow-class this run
      // eliminates everywhere else (click + probe paths).
      if (!isTimeoutError(err)) throw err
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

Expected: PASS (all twelve new contract tests green — the original eight, the three delta-r5 probe rows (late-dispatch success path, nothing-created advance with per-advance probe pins, probe hard-error propagation), and the delta-r10 render-loudness row; all pre-existing tests green).

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
- Consumes: Task 3's fixture-level composed budget (settings.spec.ts uses `freshellPage`, so its boot chain runs under the freshellPage fixture's OWN timeout — at the cloud default window the composed budget (321.5s) strictly exceeds the removed hook's flat 120s). The hook was an under-budget artifact of the pre-composition design (delta review r2); with the fixture-timeout design (delta review r9) the fixture setup gets MORE headroom than the hook ever gave, while the test BODIES keep the config's 60s default. The two tests that reload mid-body restore the hook's exact coverage, cloud-gated and scoped to themselves (delta review r10): `if (isCloudLaneWindowConfigured()) test.setTimeout(120_000)` as the first statement of each body — the removed hook's exact value, under the same env gate; their mid-body connection wait's legal envelope (W+1s = 91s at W=90s) fits inside it exactly as it did for years. Locally: no declaration, the exact pre-run 60s behavior.
- Produces: one source of truth for the cloud wedge budget (the freshellPage fixture's own timeout), no per-spec opt-in — and per-test body declarations where a test's own body envelope genuinely exceeds the default (the two reload tests).

- [ ] **Step 1: Write the failing behavioral test**

No new test: the behavior change (settings still budgeted after hook removal) is already protected by Task 3's contract spec (the wiring under the env-present path) and this task's verification runs below. Removing a redundant duplicate is a refactor under green, not new behavior.

- [ ] **Step 2: Run the test and verify the intended failure**

Skip (no Red step for a pure dedup refactor; record this justification).

- [ ] **Step 3: Add the minimal production implementation**

Delete the `test.beforeEach(async ({}) => { ... })` block from `test/e2e-browser/specs/settings.spec.ts` (the hook whose body is `if (process.env.FRESHELL_E2E_WS_READY_TIMEOUT_MS) test.setTimeout(120_000)` plus its comment). Leave the rest of `test.describe('Settings', () => {...})` untouched, and give the two mid-body reload tests the hook's exact coverage as the FIRST statement of each body (the committed form): `if (isCloudLaneWindowConfigured()) test.setTimeout(120_000)` in `settings persist after reload` (its plain mid-body waitForConnection has a legal W+1s = 91s envelope at W=90s) and in `Expand thinking and Expand tools switches persist locally and reset to defaults` (its self-healing mid-body reload leg has the same envelope) — each with a comment naming the envelope, the hook it restores, and the delta-r10 rule (cloud-gated at the pre-run value; locally unchanged).

- [ ] **Step 4: Run the focused test**

```bash
FRESHELL_E2E_WS_READY_TIMEOUT_MS=90000 npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/settings.spec.ts test/e2e-browser/specs/e2e-budget-contract.spec.ts
env -u FRESHELL_E2E_WS_READY_TIMEOUT_MS npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/settings.spec.ts
```

Expected: PASS both (settings still green with and without the env; the boot budget now arrives via the freshellPage fixture's own timeout; the two mid-test reload legs keep working under their cloud-gated 120_000 body declarations — the exact coverage the removed hook provided, now scoped to the two tests that need it).

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

Save both receipts under `.worktrees/.the-usual-logs/hoststats-freshellpage-flake/reports/cloud-focus-*.log` with the invocation, exit codes, and the zero-flake footer. Note any recovered-retry case for investigation — a failure now carries a diagnosable signature: a picker diagnostic ("did not render") names a still-starved render; a fixture-timeout error naming the freshellPage fixture (Playwright's fixture-timeout failure — the composed budget at the default window, scaling with operator window overrides) names a budget-outliving SETUP episode, and a body "Test timeout" at the test's own declared/config deadline names a budget-outliving BODY (never the "while setting up freshellPage" signature this run eliminates). Either requires root-cause before the gate, not a wider budget.

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
