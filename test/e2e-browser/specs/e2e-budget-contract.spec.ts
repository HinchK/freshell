import { test, expect } from '../helpers/fixtures.js'
import { resolveCloudLaneTestBudgetMs } from '../helpers/test-harness.js'

// Contract (kata tg4e, main-green campaign): when the cloud-lane window
// env is present, every test that boots the app through this fixtures
// module resolves the e2eMachineId fixture BEFORE any page/context work,
// and that fixture extends the per-test deadline (extend-only) to cover
// the fixture chain's evidence-shaped envelope — the self-healing
// waitForConnection spends at most W+1s (a single total deadline), and
// the picker/render tail adds its own envelope, so the config's 60s
// default can kill fixture setup mid-envelope (the recorded flake).
// When the env is absent (local lane) the default budget applies
// unchanged, and a spec's own larger declared deadline is always kept.

test('per-test deadline covers the harness wedge budget on the cloud lane', ({ freshellPage }) => {
  const cloudBudgetMs = resolveCloudLaneTestBudgetMs()
  if (cloudBudgetMs === null) {
    // Local lane: the wiring must be a NO-OP. The only value the fixture
    // could ever set is the derived cloud budget, so pin that it did NOT
    // set it — the config default (60_000) and any legitimate forwarded
    // --timeout override both pass; only an actual extension fails.
    const wouldBeCloudBudgetMs = resolveCloudLaneTestBudgetMs({
      ...process.env,
      FRESHELL_E2E_WS_READY_TIMEOUT_MS: '90000',
    })
    expect(wouldBeCloudBudgetMs).not.toBeNull()
    expect(test.info().timeout).not.toBe(wouldBeCloudBudgetMs)
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
