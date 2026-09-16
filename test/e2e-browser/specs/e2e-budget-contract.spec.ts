import { test, expect } from '../helpers/fixtures.js'
import { DEFAULT_TEST_TIMEOUT_MS, isCloudLaneWindowConfigured, TestHarness } from '../helpers/test-harness.js'
import type { Page } from '@playwright/test'

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
// explicit, harness install 60s default, picker worst) is behaviorally
// unit-pinned by freshellPageFixtureTimeoutMs. ONLY this pin resolves
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
