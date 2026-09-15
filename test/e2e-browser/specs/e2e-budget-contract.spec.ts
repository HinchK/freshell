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

// Extend-only contract, unlimited side (delta review r4): Playwright's
// timeout value 0 means UNLIMITED. Replacing an unlimited deadline with
// any finite budget SHRINKS it, so the wiring must leave a declared 0
// untouched on both lanes. Resolves ONLY e2eMachineId — the fixture the
// guard lives in — so the unlimited deadline never wraps a full page
// boot (goto/picker chains whose wedges could otherwise hang the cloud
// task to its own kill timer; delta review r5). Under the unlimited
// deadline the fixture bounds its registration fetch (60s AbortSignal);
// under every finite deadline the fetch keeps its pre-run unbounded
// behavior (the test deadline itself bounds it — delta review r6).
test.describe('declared unlimited (0) deadline', () => {
  test.beforeEach(() => {
    test.setTimeout(0)
  })
  test('stays unlimited on both lanes (a finite budget would shrink it)', ({ e2eMachineId }) => {
    expect(test.info().timeout).toBe(0)
  })
})

// Default-class-only contract (delta review r5): a deadline declared
// ABOVE the config default is an explicit spec budget decision — the
// wiring must NOT raise it, even when the composed budget is larger.
// Raising it would touch other flakes' mechanisms (e.g.
// launch-retry-restart-rust's declared 180s is the deadline its own
// recorded flake exhausts — that spec's budget belongs to its own
// deflake run, not to this wiring).
test.describe('declared deadlines above the config default stay as declared', () => {
  test.beforeEach(() => {
    test.setTimeout(180_000)
  })
  test('keeps exactly its declared budget on both lanes', ({ freshellPage }) => {
    expect(test.info().timeout).toBe(180_000)
  })
})
