import { test as base, expect } from '../helpers/fixtures.js'
import { DEFAULT_TEST_TIMEOUT_MS } from '../helpers/test-harness.js'

// The fixture-timeout mechanism pin (delta review r11): a test-scoped
// fixture whose setup DETERMINISTICALLY outlives the test's own declared
// deadline, carrying its own larger fixture timeout. The test below
// reaches its body only if Playwright runs fixture setup on the fixture's
// separate timeout slot — the exact property the tg4e fix depends on
// (slow boot SETUP may outlive the test's own 60s ceiling). If the
// mechanism breaks, or the tuple wiring loses its timeout, the setup dies
// at the test's own deadline instead. Constant 30s on both lanes: this
// pin tests the MECHANISM; the lane-derived composed value is behaviorally
// unit-pinned by freshellPageFixtureTimeoutMs, and the real tuple wiring
// runs on every healthy boot of the legs and the full lane.
const test = base.extend<{ slowSetupWitness: void }>({
  slowSetupWitness: [async ({}, use) => {
    // 8s of real time vs the test's own 3s deadline: only the fixture's
    // own slot can carry this setup.
    await new Promise((resolve) => setTimeout(resolve, 8_000))
    await use()
  }, { timeout: 30_000 }],
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
// composition (231.5s at the default window) exceeds 180s, so wrapping
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
// the witness fixture's 8s setup survives ONLY on the fixture's own 30s
// slot. Reaching the body is the assertion — a mechanism regression fails
// this test with the test's own 3s timeout (deterministically, on every
// lane).
test.describe('the fixture-timeout mechanism (delta review r11)', () => {
  test.setTimeout(3_000)
  test('a fixture setup that outlives the test\'s own deadline passes when the fixture carries its own larger timeout', async ({ slowSetupWitness }) => {
    void slowSetupWitness
    // The test's own slot is intact after the slow setup: the wiring never
    // touched the test's deadline.
    expect(test.info().timeout).toBe(3_000)
  })
})
