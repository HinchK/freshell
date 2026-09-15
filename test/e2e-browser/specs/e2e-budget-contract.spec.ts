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
