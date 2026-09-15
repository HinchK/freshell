# Cloud-Lane Test-Budget Deflake (kata tg4e) Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
- The `main` branch's test gates are green: the coordinated e2e lane at `origin/main` produces a zero-flake receipt. This run fixes exactly one flaky test — `host-stats-pane.spec.ts:47` "opens a System Status pane from the pane picker" (kata tg4e, freshellPage setup timeout: `Test timeout of 60000ms exceeded while setting up "freshellPage"`) — as one step of the main-green campaign.

### Explicit constraints
- Fix one test at a time: this run's scope is the single kata tg4e flake; the other three baseline flakes (katas 38hj, 5kyg, ebp6) are out of scope and recorded as pre-existing failures.
- Up to 15 delta review rounds are authorized for this run's delta review (overriding the default cap of 5).
- If this run's delta review finishes with PASSED, it is pre-approved to be PR'd onto main and merged once required checks pass (repo rules: self-merge is the norm).
- Red-Green-Refactor TDD; fix the system over the symptom; e2e proof on the configured cloud backend; never reduce coverage or loosen assertions to hide flakes.
- After main is green (later runs), tackle the flake katas backlog (phase 2, not this run).

### Accepted tradeoffs and residuals
- None stated by the user.

**Goal:** Eliminate the `host-stats-pane.spec.ts:47` freshellPage setup-timeout flake by making the per-test deadline cover the fixture chain's entire legal self-heal window on the cloud lane, for every spec that boots the app through the fixtures module — not just `settings.spec.ts`.

**Architecture:** The j90s wedge-tolerant self-heal in `TestHarness.waitForConnection` can legally spend ~91s+ inside the `freshellPage` fixture on the cloud lane (phase-1 `floor(W/2)` + one reload + phase-2 remaining, W=90s), but the Playwright per-test deadline stays at the config default 60s for every spec except `settings.spec.ts` (which got a hook-based 120s extension). A wedge that survives phase 1 therefore dies mid-recovery at the 60s deadline — the recorded tg4e failure. The fix derives the per-test budget from the same env that scales the window (`FRESHELL_E2E_WS_READY_TIMEOUT_MS`): budget = window + 30s overhead (= 120s at the cloud default, matching the probe-verified settings precedent), applied as an EXTEND-ONLY maximum from inside the earliest test-scoped fixture (`e2eMachineId`, resolved before `context`/`page` for every module-chain spec). Extend-only is load-bearing: several live cloud-lane specs declare larger budgets (300s idle-gate, 240s reconcile specs) and an unconditional override would shrink them. The local lane (env unset) is unchanged. The redundant settings-only hook is then removed so the budget has exactly one source of truth.

**Tech Stack:** Playwright 1.58.2 fixtures and `test.info().setTimeout`, TypeScript (NodeNext/ESM — relative imports in test files carry `.js`), Vitest for the e2e-helpers unit lane, the repo's cloud e2e lane (`scripts/e2e-cloud.sh`) for proof.

## Global Constraints

- Local-lane behavior is byte-identical when `FRESHELL_E2E_WS_READY_TIMEOUT_MS` is unset: no timeout changes, no new waits, no different call shapes on the default path.
- The self-heal stays cloud-only (env-presence gated) and fresh-boot-only: never opt a mid-test `waitForConnection` site into `selfHealReload` (a reload would destroy state under test).
- Never loosen the ready assertion, never skip or exclude specs, never raise `retries`, never widen `CLOUD_SKIP_SPECS` — those are coverage reductions, not fixes.
- The other three baseline flakes (kata 38hj `restore-contract-wall-rust.spec.ts:579`, kata 5kyg `recover-my-panes-rust.spec.ts:733`, kata ebp6 `reconcile-client-adoption-rust.spec.ts:542`) are pre-existing failures at base_ref 39192e8aa and stay out of scope; the final full e2e lane gate passes if they are the only retry-evidence cases.
- Malformed env values must never poison the budget (reuse `resolveWsReadyTimeoutMs`'s parsing/fallback — one parsing rule).
- A budget that covers the legal window must not silently become a per-test entitlement: assertions and waits inside test bodies keep their own explicit timeouts; only the deadline arithmetic changes.
- The wiring is EXTEND-ONLY (`test.info().timeout < budget` guard): a spec's own declared deadline (e.g. idle-gate-semantics' 300_000, the reconcile specs' 240_000) must never be shrunk by the cloud budget. The contract spec pins this.
- Accepted residuals, deliberately out of scope (recorded so the reviewer sees conscious scoping): (a) the client's timeout-less boot fetches (App.tsx:1691-1753, api.ts:181) remain unbounded — that product-level hardening is the qq5m flake class, tracked by its own kata and later campaign runs; the budget fix makes one wedge episode survivable without it. (b) `selectShellFromPicker`'s silent error-swallowing loop (fixtures.ts:128-161, ~177s absolute worst case) stays as-is — its realistic single-wedge tail is covered by the 120s budget, and bounding it changes local-lane failure semantics; a pathological multi-wedge run exceeding the budget remains possible (the j90s run accepted the same residual class). (c) `waitForHarness`'s decorative 15s (real 30s) is a known cosmetic quirk not implicated in this flake. (d) Raw-base specs that import `test` from `@playwright/test` directly and boot the app in-body (terminal-escape-key-rust, cli-rust, silent-input-loss-rust, sidebar-registry-sync-rust, sidebar-remote-status-rings-rust, sidebar-status-tier-sort-rust, diag03-rotation-redaction-rust — per the load-bearing finder, LB-B2) never resolve `e2eMachineId`; they keep the same 60s deadline with env-scaled 91s single-shot windows they have today. This run does not regress them and does not cover them; they are tracked by their own kata and addressed by a later campaign step.
- The gVisor wedge itself is infra-layer and cannot be deterministically forced; acceptance evidence is (a) the budget arithmetic covering the legal window (unit-pinned), (b) the contract spec proving the wiring under the env-present path, and (c) zero-flake cloud receipts for the affected spec at the committed HEAD.
- The full e2e lane at the run HEAD is part of this run's final gate (`npm run test:e2e`, cloud backend); PR checks do not run e2e on this repo, so the lane must be run explicitly.
- Accepted residuals, deliberately out of scope (recorded so the reviewer sees conscious scoping): (a) the client's timeout-less boot fetches (App.tsx:1691-1753, api.ts:181) remain unbounded — that product-level hardening is the qq5m flake class, tracked by its own kata and later campaign runs; the budget fix makes one wedge episode survivable without it. (b) `selectShellFromPicker`'s silent error-swallowing loop (fixtures.ts:128-161, ~177s absolute worst case) stays as-is — its realistic single-wedge tail is covered by the 120s budget, and bounding it changes local-lane failure semantics; a pathological multi-wedge run exceeding the budget remains possible (the j90s run accepted the same residual class). (c) `waitForHarness`'s decorative 15s (real 30s) is a known cosmetic quirk not implicated in this flake.

---

### Task 1: `resolveCloudLaneTestBudgetMs` resolver + unit tests

**Files:**
- Modify: `test/e2e-browser/helpers/test-harness.ts` (after `resolveWsReadyTimeoutMs`, near `DEFAULT_WS_READY_TIMEOUT_MS`)
- Test: `test/e2e-browser/helpers/test-harness.test.ts` (new `describe` block after `resolveWsReadyTimeoutMs`'s)

**Interfaces:**
- Consumes: `resolveWsReadyTimeoutMs(explicitMs, env)` (test-harness.ts:25-40), `DEFAULT_WS_READY_TIMEOUT_MS` (test-harness.ts:12), env key `FRESHELL_E2E_WS_READY_TIMEOUT_MS` (set to `90000` on the cloud lane by `scripts/e2e-cloud.sh:547`).
- Produces: `CLOUD_LANE_BUDGET_OVERHEAD_MS: number` (30_000) and `resolveCloudLaneTestBudgetMs(env?): number | null` — `null` when the env key is absent or empty (local lane: caller must not extend anything), otherwise `resolveWsReadyTimeoutMs(undefined, env) + CLOUD_LANE_BUDGET_OVERHEAD_MS`.

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

  it('derives window + overhead at the cloud default window (90s -> 120s)', () => {
    expect(resolveCloudLaneTestBudgetMs({ [ENV_VAR]: '90000' })).toBe(120_000)
  })

  it('scales with the configured window (60s -> 90s)', () => {
    expect(resolveCloudLaneTestBudgetMs({ [ENV_VAR]: '60000' })).toBe(90_000)
  })

  it('falls back to the default window plus overhead on malformed values (one parsing rule)', () => {
    for (const malformed of ['not-a-number', '0', '-5']) {
      expect(resolveCloudLaneTestBudgetMs({ [ENV_VAR]: malformed }))
        .toBe(DEFAULT_WS_READY_TIMEOUT_MS + CLOUD_LANE_BUDGET_OVERHEAD_MS)
    }
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:e2e:helpers -- test-harness`

Expected: FAIL because `CLOUD_LANE_BUDGET_OVERHEAD_MS` / `resolveCloudLaneTestBudgetMs` are not exported from `./test-harness` — the suite reports the missing exports and cannot assert the budget derivation (the behavior is absent).

- [ ] **Step 3: Add the minimal production implementation**

In `test/e2e-browser/helpers/test-harness.ts`, directly after `resolveWsReadyTimeoutMs`:

```ts
/**
 * Overhead added to the resolved WS-ready window when computing the
 * cloud-lane per-test budget. Covers the fixture steps that are not the
 * connection wait itself: page.goto + waitForHarness (1-3s), the one-shot
 * self-heal reload + fresh boot chain after a wedge episode (observed
 * ~6-10s), the selectShellFromPicker tail in the realistic single-wedge
 * case (1-6s), and body-start margin. 30s matches the probe-verified
 * settings.spec.ts precedent (120s budget at the 90s cloud window).
 */
export const CLOUD_LANE_BUDGET_OVERHEAD_MS = 30_000

/**
 * Resolve the cloud-lane per-test deadline budget, or null on the local
 * lane (kata tg4e): the freshellPage fixture's self-healing
 * waitForConnection can legally spend phase-1 (floor(W/2)) + one reload +
 * phase-2 (W - floor(W/2)) ≈ 91s+ at the cloud window W=90s before the
 * test body starts — the config's 60s default deadline kills fixture
 * setup mid-self-heal ("Test timeout of 60000ms exceeded while setting up
 * freshellPage"). The budget derives from the SAME env that scales the
 * window (one source of truth, one parsing rule via
 * resolveWsReadyTimeoutMs) so a custom window scales the budget with it.
 * Callers must treat null as "do not touch the deadline" — the local
 * lane keeps the config default unchanged.
 */
export function resolveCloudLaneTestBudgetMs(
  env: Record<string, string | undefined> = process.env,
): number | null {
  const raw = env.FRESHELL_E2E_WS_READY_TIMEOUT_MS
  if (raw === undefined || raw === '') return null
  return resolveWsReadyTimeoutMs(undefined, env) + CLOUD_LANE_BUDGET_OVERHEAD_MS
}
```

- [ ] **Step 4: Run the focused test**

Run: `npm run test:e2e:helpers -- test-harness`

Expected: PASS (new describe green; all pre-existing harness tests still green).

- [ ] **Step 5: Refactor while green**

Placement and naming only; no behavior variants. Keep the resolver adjacent to `resolveWsReadyTimeoutMs` so the two env-reading rules stay visually paired.

- [ ] **Step 6: Run impacted-test verification**

The resolver is new, unreferenced production code; the impacted set is the whole e2e-helpers unit lane.

Run: `npm run test:e2e:helpers`

Expected: PASS (the entire lane, not just test-harness).

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/helpers/test-harness.ts test/e2e-browser/helpers/test-harness.test.ts
git commit -m "test(e2e): add cloud-lane per-test budget resolver (kata tg4e)"
```

### Task 2: Wire the budget into the `e2eMachineId` fixture + committed contract spec

**Files:**
- Modify: `test/e2e-browser/helpers/fixtures.ts` (the `e2eMachineId` fixture, currently `e2eMachineId: async ({ testServer }, use) => { await use((await registerE2eMachine(testServer.info)).id) }`; also extend the module's existing `import` from `'./test-harness.js'`)
- Create: `test/e2e-browser/specs/e2e-budget-contract.spec.ts`
- Test: the new contract spec is this task's behavioral test (it runs on both lanes; on the cloud lane — env always present — it pins the real budget).

**Interfaces:**
- Consumes: `resolveCloudLaneTestBudgetMs()` (Task 1), the exported `test` object from `helpers/fixtures.ts` (`test.info().setTimeout(ms)`), `FRESHELL_E2E_WS_READY_TIMEOUT_MS` env presence.
- Produces: every test that resolves the `e2eMachineId` fixture (i.e., every spec that uses `page`/`context`/`freshellPage` from this fixtures module — all app-boot specs) runs under deadline `resolveCloudLaneTestBudgetMs()` when the cloud env is present; unchanged default deadline otherwise.

- [ ] **Step 1: Write the failing behavioral test (the contract spec)**

Create `test/e2e-browser/specs/e2e-budget-contract.spec.ts`:

```ts
import { test, expect } from '../helpers/fixtures.js'
import { resolveCloudLaneTestBudgetMs } from '../helpers/test-harness.js'

// Contract (kata tg4e, main-green campaign): when the cloud-lane window
// env is present, every test that boots the app through this fixtures
// module resolves the e2eMachineId fixture BEFORE any page/context work,
// and that fixture extends the per-test deadline (extend-only) to cover
// the fixture chain's legal window — the self-healing waitForConnection
// inside freshellPage can legally spend phase-1 (W/2) + one reload +
// phase-2 (W - W/2) before the test body starts, so the config's 60s
// default would kill fixture setup mid-self-heal (the recorded flake).
// When the env is absent (local lane) the default budget applies
// unchanged, and a spec's own larger declared deadline is always kept.

test('per-test deadline covers the harness wedge budget on the cloud lane', ({ freshellPage }) => {
  const cloudBudgetMs = resolveCloudLaneTestBudgetMs()
  if (cloudBudgetMs === null) {
    // Local lane: the historical default budget must be preserved
    // (playwright.config.ts timeout: 60_000). If the config default ever
    // changes, update this pin consciously.
    expect(test.info().timeout).toBe(60_000)
    return
  }
  expect(test.info().timeout).toBeGreaterThanOrEqual(cloudBudgetMs)
})

// Extend-only contract: a spec that declares a LARGER deadline than the
// derived budget keeps its own — the wiring must never shrink a declared
// budget (idle-gate-semantics declares 300_000; the reconcile specs
// declare 240_000). Hooks run before fixture resolution, so the declared
// value is what the fixture sees on entry.
test.describe('declared budgets larger than the wedge budget', () => {
  test.beforeEach(() => {
    test.setTimeout(300_000)
  })
  test('keeps its declared deadline under the cloud lane budget', ({ freshellPage }) => {
    expect(test.info().timeout).toBeGreaterThanOrEqual(300_000)
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run (env-set local invocation reproduces the cloud-shaped path; first local run pays the global-setup build):

```bash
FRESHELL_E2E_WS_READY_TIMEOUT_MS=90000 npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/e2e-budget-contract.spec.ts
```

Expected: the FIRST test FAILs because `test.info().timeout` is still the 60_000 config default — `60_000 < 120_000` (the budget extension is absent). The SECOND (never-shrink) test PASSes at this point and keeps passing after the wiring — it is a regression pin against override-instead-of-extend semantics, not part of this Red step. Also run the no-env leg and confirm the FIRST test PASSES at this point (60_000 pin, nothing extended — the local default must be green before the wiring too):

```bash
npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/e2e-budget-contract.spec.ts
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
  // fixture's self-healing waitForConnection can legally spend ~91s+ at
  // the 90s cloud window (phase-1 floor(W/2) + one reload + phase-2
  // remainder) before the test body starts; the config's 60s default
  // deadline kills fixture setup mid-self-heal — the recorded
  // "Test timeout of 60000ms exceeded while setting up freshellPage"
  // flake. Extending the deadline from inside this fixture makes the
  // budget cover the chain's own legal window for every module-chain
  // spec, not just settings.spec.ts (whose private hook this replaces).
  // Locally the env var is unset and the default budget applies
  // unchanged. The mechanism is probe-verified (settings.spec.ts
  // precedent, kata j90s): a setTimeout issued during fixture resolution
  // extends the live deadline over fixture time. EXTEND-ONLY: specs that
  // declare a larger deadline (idle-gate 300s, reconcile specs 240s)
  // keep their own budget — the guard must never shrink a declared
  // deadline to the cloud budget.
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

Expected: PASS (deadline now 120_000 under the env-set path; the never-shrink test still sees its declared 300_000). Then re-run the no-env leg:

```bash
npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/e2e-budget-contract.spec.ts
```

Expected: PASS (local default still exactly 60_000 for the first test — byte-identical local semantics; the never-shrink test keeps its 300_000).

- [ ] **Step 5: Refactor while green**

None beyond the comment placement above (the settings.spec.ts duplicate hook removal is Task 3 — keep it in place until then so settings never runs un-budgeted).

- [ ] **Step 6: Run impacted-test verification**

`fixtures.ts` is consumed by every e2e spec. Focused impacted set (real behavior, both lanes):

```bash
npm run test:e2e:helpers
FRESHELL_E2E_WS_READY_TIMEOUT_MS=90000 npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/host-stats-pane.spec.ts test/e2e-browser/specs/settings.spec.ts test/e2e-browser/specs/e2e-budget-contract.spec.ts
npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/host-stats-pane.spec.ts test/e2e-browser/specs/e2e-budget-contract.spec.ts
```

Expected: PASS for all four commands (the env-set invocation proves the cloud-shaped path boots, self-heals armed, picker selects a shell, and the budgeted tests pass; the unset invocation proves local semantics are unchanged).

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/helpers/fixtures.ts test/e2e-browser/specs/e2e-budget-contract.spec.ts
git commit -m "test(e2e): extend the per-test deadline to the cloud wedge budget from the earliest test-scoped fixture (kata tg4e)"
```

### Task 3: Remove the now-redundant settings.spec.ts budget hook

**Files:**
- Modify: `test/e2e-browser/specs/settings.spec.ts` (delete the `test.beforeEach` block, lines 8-21 in the current file: the cloud-only `test.setTimeout(120_000)` hook; its probe-verified mechanism documentation has moved into the `e2eMachineId` fixture comment in Task 2)

**Interfaces:**
- Consumes: Task 2's fixture-level budget (settings.spec.ts uses `freshellPage`, so it resolves `e2eMachineId` first: derived budget 120_000 at the cloud default window == the hook's 120_000, so the operative cloud-lane behavior is unchanged; at other configured windows the derived budget scales with the window — equal-or-larger than the old fixed hook at windows >= 90s, smaller below that but still arithmetically sufficient (window + overhead by construction)). The extend-only guard also means settings keeps any larger deadline it might declare in the future.
- Produces: one source of truth for the cloud wedge budget (the fixture), no per-spec opt-in.

- [ ] **Step 1: Write the failing behavioral test**

No new test: the behavior change (settings still budgeted after hook removal) is already protected by Task 2's contract spec (the wiring under the env-present path) and this task's verification runs below. Removing a redundant duplicate is a refactor under green, not new behavior.

- [ ] **Step 2: Run the test and verify the intended failure**

Skip (no Red step for a pure dedup refactor; record this justification).

- [ ] **Step 3: Add the minimal production implementation**

Delete the `test.beforeEach(async ({}) => { ... })` block from `test/e2e-browser/specs/settings.spec.ts` (the hook whose body is `if (process.env.FRESHELL_E2E_WS_READY_TIMEOUT_MS) test.setTimeout(120_000)` plus its comment). Leave the rest of `test.describe('Settings', () => {...})` untouched.

- [ ] **Step 4: Run the focused test**

```bash
FRESHELL_E2E_WS_READY_TIMEOUT_MS=90000 npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/settings.spec.ts test/e2e-browser/specs/e2e-budget-contract.spec.ts
npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/settings.spec.ts
```

Expected: PASS both (settings still green with and without the env; the budget now arrives via the fixture; settings' own mid-test reload leg at settings.spec.ts:225-233 keeps working under the same 120s-equivalent budget it had before).

- [ ] **Step 5: Refactor while green**

The deletion IS the refactor. Confirm the env-gated hook pattern is gone from every spec — the corrected check (the raw `setTimeout(120` grep matches ~28 benign unconditional declaration-time timeouts in other specs; the env-gated cloud hook is uniquely identified by its env reference):

```bash
grep -rn "FRESHELL_E2E_WS_READY_TIMEOUT_MS" test/e2e-browser/specs/
```

Expected: no output (settings.spec.ts was the only spec referencing the env var). Also confirm the j90s script suite `scripts/test/e2e-harness-timeout-env.test.sh` is unaffected (it uses settings.spec.ts only as a stubbed pass-through arg and pins the e2e-cloud.sh env plumbing, not the hook).

- [ ] **Step 6: Run impacted-test verification**

```bash
npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/settings.spec.ts test/e2e-browser/specs/host-stats-pane.spec.ts test/e2e-browser/specs/e2e-budget-contract.spec.ts
```

Expected: PASS (both lanes' semantics for settings and the target spec verified together).

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/settings.spec.ts
git commit -m "refactor(e2e): drop settings-only cloud budget hook superseded by the fixture-level budget (kata tg4e)"
```

### Task 4: Cloud-lane proof at the committed HEAD

**Files:**
- No source changes. Evidence receipts go to the run's logs dir (outside the tracked tree). The worktree must be clean and committed before each cloud invocation (dirty trees force a non-addressable full rebuild).

**Interfaces:**
- Consumes: Tasks 1-3 at the branch HEAD; the cloud lane (`scripts/e2e-cloud.sh run --cloud`), which bakes `FRESHELL_E2E_WS_READY_TIMEOUT_MS=90000` and `FRESHELL_E2E_SERVER_VERBOSE=1` into the job env.
- Produces: zero-flake receipts for the target spec and the contract spec at HEAD; evidence for the final gate and the kata tg4e close.

- [ ] **Step 1: Run the target spec and the contract spec on the cloud lane**

Commit any pending work first (`git status` clean), then:

```bash
npm run test:e2e:cloud -- --project=chromium test/e2e-browser/specs/host-stats-pane.spec.ts test/e2e-browser/specs/e2e-budget-contract.spec.ts
```

Expected: PASS with a zero-flake receipt ("All tasks completed successfully", no recovered-retry evidence). First run at a new commit pays ~7 min Cloud Build; subsequent runs ~3-5 min.

- [ ] **Step 2: Repeat for confidence**

Re-run the same command once more. Expected: PASS zero-flake again (the flake was observed ~1-in-7 for the class; two clean focused runs plus the arithmetic and the contract pin is the practical pre-gate evidence).

- [ ] **Step 3: Record evidence**

Save both receipts under `.worktrees/.the-usual-logs/hoststats-freshellpage-flake/reports/cloud-focus-*.log` with the invocation, exit codes, and the zero-flake footer. Note any recovered-retry case for investigation (a new failure mode under the widened budget — e.g. a picker-loop stall outliving 120s — would need its own root-cause before the gate, not a wider budget).

- [ ] **Step 4: No commit**

No tracked changes in this task (evidence lives outside the tree). If investigation reveals a defect, file it as a new focused task rather than expanding this one silently.

### Task 5: Full-suite gate at the final HEAD

**Files:**
- No source changes expected. Gate fixes (if any) follow the-usual's gate procedure as a batch.

**Interfaces:**
- Consumes: the final committed HEAD of all tasks.
- Produces: the run's gate evidence — standard suite green; full e2e lane green excluding the ledger-recorded pre-existing flakes (katas 38hj, 5kyg, ebp6 — reproducing at base_ref per the campaign baseline receipts).

- [ ] **Step 1: Standard coordinated suite**

```bash
FRESHELL_TEST_SUMMARY='the-usual hoststats-freshellpage-flake: final full-suite gate at HEAD' npm test
```

Expected: PASS (exit 0). This covers client/tooling vitest, source-runtime, Rust, Electron. Wait for the shared coordinator gate if held; never kill a foreign holder.

- [ ] **Step 2: Full e2e lane at HEAD**

```bash
FRESHELL_TEST_SUMMARY='the-usual hoststats-freshellpage-flake: final e2e lane gate at HEAD' npm run test:e2e
```

Expected: PASS with a zero-flake receipt, OR exit 1 whose ONLY recovered-retry cases are the three ledger-recorded pre-existing flakes (`restore-contract-wall-rust.spec.ts:579`, `recover-my-panes-rust.spec.ts:733`, `reconcile-client-adoption-rust.spec.ts:542`). Any retry-evidence case for `host-stats-pane.spec.ts`, `e2e-budget-contract.spec.ts`, `settings.spec.ts`, or any OTHER spec is a gate failure requiring root-cause (it means this run's fix is incomplete or regressed something).

- [ ] **Step 3: Record the gate entry**

Record time, HEAD SHA, exact commands, results, and the exemption evidence (base_ref reproduction receipts in `.worktrees/.the-usual-logs/main-green-campaign/baseline-receipts.md`) in the progress ledger and run-state.

- [ ] **Step 4: Close kata tg4e**

```bash
kata close tg4e --done --commit <final-HEAD-sha> --comment "Fixed by the-usual hoststats-freshellpage-flake: cloud-lane per-test budget now derives from FRESHELL_E2E_WS_READY_TIMEOUT_MS and is applied from the e2eMachineId fixture for every app-boot spec; settings' private hook removed. Evidence: budget arithmetic unit-pinned; e2e-budget-contract spec green on both lanes; zero-flake cloud receipts at HEAD; full-lane gate green excluding the three ledger-recorded pre-existing flakes (38hj/5kyg/ebp6)."
```

Expected: kata closes (asserts work complete). The other three katas stay open for their own runs.
