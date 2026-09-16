import { test as base, expect } from '../helpers/fixtures.js'
import { DEFAULT_TEST_TIMEOUT_MS, isCloudLaneWindowConfigured, TestHarness } from '../helpers/test-harness.js'
import type { Page } from '@playwright/test'

// The fixture-timeout APPLICATION pin (delta review r12): it exercises
// THE PRODUCTION freshellPage REGISTRATION — not a synthetic witness.
// The spec's local test extension overrides the `harness` DEPENDENCY
// with a TestHarness subclass whose waitForHarness deterministically
// sleeps 8s before delegating, so the production fixture's own setup
// legally exceeds the test's own declared deadline: reaching the test
// body is only possible if the production tuple wiring
// ({ timeout: freshellPageFixtureTimeoutMs() } in fixtures.ts) carries
// the boot on freshellPage's separate timeout slot. With the wiring
// removed, this test dies with "Test timeout of 3000ms exceeded while
// setting up \"freshellPage\"" — the EXACT production tg4e signature —
// deterministically (the 8s sleep dominates any machine speed).
// Validated by mutation during the r12 remediation. The lane-derived
// composed value (261.5s at the default window, including the
// allowances for the UNBOUNDED initial operations — goto and harness
// install have NO Playwright maxima in this runner; delta r13) is
// behaviorally unit-pinned by freshellPageFixtureTimeoutMs.
class DeterministicallySlowBootHarness extends TestHarness {
  constructor(page: Page) {
    super(page)
  }

  override async waitForHarness(timeoutMs?: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 8_000))
    return super.waitForHarness(timeoutMs)
  }
}

const test = base.extend<{ harness: TestHarness }>({
  harness: async ({ page }, use) => {
    await use(new DeterministicallySlowBootHarness(page))
  },
})

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
// composition (261.5s at the default window) exceeds 180s, so wrapping
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


// The behavioral pin itself: the describe declares a 3s test deadline;
// the production freshellPage boot (deterministically >= 8s via the slow
// harness dependency) survives ONLY on the production fixture's own
// timeout slot. Reaching the body is the assertion — losing the tuple
// options in fixtures.ts fails this test with the production tg4e
// signature on every lane, deterministically.
test.describe('the production fixture-timeout application (delta review r12)', () => {
  // Cloud-lane-only wiring under test: locally freshellPageFixtureTimeoutMs()
  // is undefined — fixture time counts toward the test timeout, the exact
  // pre-run local behavior — so this pin skips when the window env is not
  // configured (the env-set leg and the cloud lane run it for real).
  test.skip(!isCloudLaneWindowConfigured(), 'the fixture timeout is cloud-lane wiring; the local lane keeps its exact pre-run behavior')
  test.setTimeout(3_000)
  test('freshellPage setup outlives the test\'s own deadline on the fixture\'s OWN production timeout slot', async ({ freshellPage }) => {
    void freshellPage
    // The test's own slot is intact after the slow boot: the wiring never
    // touched the test's deadline.
    expect(test.info().timeout).toBe(3_000)
  })
})
