import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Page } from '@playwright/test'
import {
  CLOUD_LANE_GOTO_ALLOWANCE_MS,
  CLOUD_LANE_HARNESS_ALLOWANCE_MS,
  DEFAULT_TEST_TIMEOUT_MS,
  DEFAULT_WS_READY_TIMEOUT_MS,
  freshellPageFixtureTimeoutMs,
  paneCreationProbePredicate,
  SHELL_CLICK_TIMEOUT_MS,
  SHELL_NAMES,
  SHELL_PICKER_SETTLE_MS,
  SHELL_PROBE_TIMEOUT_MS,
  SHELL_RENDER_TIMEOUT_MS,
  TestHarness,
  isCloudLaneWindowConfigured,
  resolveCloudLaneTestBudgetMs,
  resolveWsReadyTimeoutMs,
  selectShellFromPicker,
  shellPickerWorstCaseMs,
} from './test-harness'

const ENV_VAR = 'FRESHELL_E2E_WS_READY_TIMEOUT_MS'

/**
 * A queued per-call outcome for the fake page's waitForFunction: omit the
 * entry (or leave `reject` unset) for success (the predicate became ready),
 * or set `reject` to simulate Playwright's native TimeoutError (the
 * predicate never became ready within that phase's window).
 */
interface FakeWaitOutcome {
  reject?: Error
}

/**
 * A fake Page that records the full argument tuple of each waitForFunction
 * call, plus every reload call. The tuple shape IS the contract under test:
 * Playwright's waitForFunction(pageFunction, arg, options) only honors a
 * timeout passed as the third argument. The historical two-arg call bound
 * the timeout object to the predicate's argument, making every explicit
 * window decorative (the real window was Playwright's 30s default — the j90s
 * load-bearing ledger, LB-1).
 */
function fakePage(
  outcomes: FakeWaitOutcome[] = [],
  opts: { reloadAdvanceMs?: number, phase1AdvanceMs?: number } = {},
) {
  const calls: unknown[][] = []
  const reloads: unknown[][] = []
  const queue = [...outcomes]
  const page = {
    waitForFunction: (...args: unknown[]) => {
      calls.push(args)
      const outcome = queue.shift()
      // The FIRST poll is phase 1: optionally advance the (faked) clock to
      // simulate a phase-1 that burned wall-clock time before expiring —
      // the absolute-deadline contract (delta review r3) must charge it.
      if (calls.length === 1 && opts.phase1AdvanceMs) {
        vi.setSystemTime(Date.now() + opts.phase1AdvanceMs)
      }
      if (outcome?.reject) return Promise.reject(outcome.reject)
      return Promise.resolve()
    },
    reload: (...args: unknown[]) => {
      reloads.push(args)
      if (opts.reloadAdvanceMs) vi.setSystemTime(Date.now() + opts.reloadAdvanceMs)
      return Promise.resolve()
    },
  }
  return { page: page as unknown as Page, calls, reloads }
}

// beforeEach: clear the ambient var (set by scripts/e2e-cloud.sh on the
// cloud lane) so every test starts from the default state, even in -t
// filtered runs that skip the earlier tests whose afterEach would
// otherwise clean it first.
beforeEach(() => {
  delete process.env[ENV_VAR]
})

afterEach(() => {
  delete process.env[ENV_VAR]
})

describe('resolveWsReadyTimeoutMs', () => {
  it('defaults to the 30s window that preserves the historical real window when the env var is unset', () => {
    expect(resolveWsReadyTimeoutMs(undefined, {})).toBe(DEFAULT_WS_READY_TIMEOUT_MS)
    expect(DEFAULT_WS_READY_TIMEOUT_MS).toBe(30_000)
  })

  it('uses the env value when set and no explicit timeout is given', () => {
    expect(resolveWsReadyTimeoutMs(undefined, { [ENV_VAR]: '45000' })).toBe(45_000)
  })

  it('lets an explicit per-call timeout win over the env value', () => {
    expect(resolveWsReadyTimeoutMs(20_000, { [ENV_VAR]: '45000' })).toBe(20_000)
  })

  it('falls back to the default for empty, non-numeric, or non-positive env values', () => {
    expect(resolveWsReadyTimeoutMs(undefined, { [ENV_VAR]: '' })).toBe(DEFAULT_WS_READY_TIMEOUT_MS)
    expect(resolveWsReadyTimeoutMs(undefined, { [ENV_VAR]: 'abc' })).toBe(DEFAULT_WS_READY_TIMEOUT_MS)
    expect(resolveWsReadyTimeoutMs(undefined, { [ENV_VAR]: '0' })).toBe(DEFAULT_WS_READY_TIMEOUT_MS)
    expect(resolveWsReadyTimeoutMs(undefined, { [ENV_VAR]: '-5' })).toBe(DEFAULT_WS_READY_TIMEOUT_MS)
  })
})

describe('resolveCloudLaneTestBudgetMs', () => {
  it('returns null when the cloud window env is absent (local lane budget untouched)', () => {
    expect(resolveCloudLaneTestBudgetMs({})).toBeNull()
  })

  it('returns null when the cloud window env is empty', () => {
    expect(resolveCloudLaneTestBudgetMs({ [ENV_VAR]: '' })).toBeNull()
  })

  it('covers the permitted composition at the cloud default window (delta reviews r2+r5+r12)', () => {
    // W=90s: connection envelope (W + 1s total-deadline slack) = 91_000;
    // goto max 30_000 + waitForHarness max 30_000 (delta r12: the initial
    // operations' LEGAL maxima, not their healthy ~3s — correlated cloud
    // slowness can stretch both to their deadlines together);
    // picker worst case (settle + at most 5 clicks + 5 probes + the render
    // wait) = 500 + 5 * (5_000 + 5_000) + 60_000 = 110_500.
    // Total 261_500.
    expect(resolveCloudLaneTestBudgetMs({ [ENV_VAR]: '90000' })).toBe(261_500)
  })

  it('scales with the configured window (60s -> 231_500)', () => {
    expect(resolveCloudLaneTestBudgetMs({ [ENV_VAR]: '60000' })).toBe(231_500)
  })

  it('falls back to the default window composition on malformed values (one parsing rule)', () => {
    for (const malformed of ['not-a-number', '0', '-5']) {
      expect(resolveCloudLaneTestBudgetMs({ [ENV_VAR]: malformed }))
        .toBe(30_000 + 1_000 + CLOUD_LANE_GOTO_ALLOWANCE_MS + CLOUD_LANE_HARNESS_ALLOWANCE_MS + shellPickerWorstCaseMs())
    }
  })

  it('always covers the permitted composition: connection envelope + picker worst + start reserve', () => {
    for (const windowMs of ['30000', '45000', '90000', '150000']) {
      const budget = resolveCloudLaneTestBudgetMs({ [ENV_VAR]: windowMs })
      expect(budget).not.toBeNull()
      expect(budget!).toBeGreaterThanOrEqual(
        Number(windowMs) + 1_000 + CLOUD_LANE_GOTO_ALLOWANCE_MS + CLOUD_LANE_HARNESS_ALLOWANCE_MS + shellPickerWorstCaseMs(),
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
    expect(freshellPageFixtureTimeoutMs({ [ENV_VAR]: '90000' })).toBe(261_500)
    expect(freshellPageFixtureTimeoutMs({ [ENV_VAR]: '60000' })).toBe(231_500)
  })

  it('is undefined on the local lane: fixture time counts toward the test timeout — the exact pre-run behavior', () => {
    expect(freshellPageFixtureTimeoutMs({})).toBeUndefined()
    expect(freshellPageFixtureTimeoutMs({ [ENV_VAR]: '' })).toBeUndefined()
  })

  it('falls back to the default window composition on malformed values (one parsing rule)', () => {
    for (const malformed of ['not-a-number', '0', '-5']) {
      expect(freshellPageFixtureTimeoutMs({ [ENV_VAR]: malformed }))
        .toBe(30_000 + 1_000 + CLOUD_LANE_GOTO_ALLOWANCE_MS + CLOUD_LANE_HARNESS_ALLOWANCE_MS + shellPickerWorstCaseMs())
    }
  })

  it('stays pinned to the config default ceiling: the DEFAULT_TEST_TIMEOUT_MS the configs import', () => {
    expect(DEFAULT_TEST_TIMEOUT_MS).toBe(60_000)
  })
})



describe('TestHarness.waitForConnection timeout wiring', () => {
  it('binds the default window (+1s slack) as waitForFunction OPTIONS', async () => {
    const { page, calls } = fakePage()
    await new TestHarness(page).waitForConnection()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toHaveLength(3)
    expect(calls[0][1]).toBeUndefined()
    expect(calls[0][2]).toEqual({ timeout: DEFAULT_WS_READY_TIMEOUT_MS + 1000 })
  })

  it('binds the env-scaled window as options when no explicit timeout is given', async () => {
    process.env[ENV_VAR] = '45000'
    const { page, calls } = fakePage()
    await new TestHarness(page).waitForConnection()
    expect(calls[0][1]).toBeUndefined()
    expect(calls[0][2]).toEqual({ timeout: 46_000 })
  })

  it('keeps an explicit timeout authoritative over the env var', async () => {
    process.env[ENV_VAR] = '45000'
    const { page, calls } = fakePage()
    await new TestHarness(page).waitForConnection(20_000)
    expect(calls[0][2]).toEqual({ timeout: 21_000 })
  })

  it('waitForHarness binds its timeout as waitForFunction OPTIONS (the LB-1 class binding bug, delta r5)', async () => {
    // The historical two-arg call bound the timeout object to the
    // predicate's ARGUMENT, making every explicit window decorative (the
    // real wait was Playwright's 30s default) — the same defect class this
    // run fixed in waitForConnection (LB-1).
    const { page, calls } = fakePage()
    await new TestHarness(page).waitForHarness(15_000)
    expect(calls[0]).toHaveLength(3)
    expect(calls[0][1]).toBeUndefined()
    expect(calls[0][2]).toEqual({ timeout: 15_000 })
  })

  it('waitForHarness default is 0 (unlimited, outer-bound-governed) — the exact pre-run effective semantics (delta review r13)', async () => {
    // The historical decorative 15s never applied: unconfigured
    // Playwright-Test waits inherit the context's 0 default (= disabled),
    // so the pre-run wait was bounded ONLY by the outer deadline. The r6
    // attempt to pin a 30s "historical effective window" rested on a false
    // default and NARROWED the wait; the committed default restores the
    // pre-run semantics: 0 = no inner limit, the test deadline (locally)
    // or the freshellPage fixture slot (cloud lane) governs.
    const { page, calls } = fakePage()
    await new TestHarness(page).waitForHarness()
    expect(calls[0][2]).toEqual({ timeout: 0 })
  })
})

describe('TestHarness.waitForConnection wedge-tolerant self-heal (opt-in)', () => {
  /** Playwright's native waitForFunction timeout rejection shape. */
  const nativeTimeout = (ms: number) => new Error(`Timeout ${ms}ms exceeded.`)

  it('(a) self-heal OFF (default): a never-ready predicate yields exactly ONE waitForFunction call and NO reload', async () => {
    // All existing call sites keep their single-poll semantics: even when
    // ready never lands inside a small window, the default path must not
    // reload (a mid-test reload would destroy state under test).
    const { page, calls, reloads } = fakePage([{ reject: nativeTimeout(1_100) }])
    await expect(new TestHarness(page).waitForConnection(100)).rejects.toThrow('Timeout 1100ms exceeded')
    expect(calls).toHaveLength(1)
    expect(reloads).toHaveLength(0)
  })

  it('(b) self-heal ON + ready within phase 1: NO reload, one poll bound to floor(W/2)', async () => {
    const { page, calls, reloads } = fakePage()
    await new TestHarness(page).waitForConnection(undefined, { selfHealReload: true })
    expect(calls).toHaveLength(1)
    expect(reloads).toHaveLength(0)
    expect(calls[0][2]).toEqual({ timeout: Math.floor(DEFAULT_WS_READY_TIMEOUT_MS / 2) })
  })

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

  it('(e) self-heal ON + both phases time out: the native TimeoutError propagates (exactly one reload, no retry loop)', async () => {
    const err = nativeTimeout(15_000)
    const { page, calls, reloads } = fakePage([{ reject: err }, { reject: err }])
    await expect(
      new TestHarness(page).waitForConnection(undefined, { selfHealReload: true }),
    ).rejects.toThrow('Timeout 15000ms exceeded')
    expect(reloads).toHaveLength(1)
    expect(calls).toHaveLength(2)
  })

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
})

describe('paneCreationProbePredicate semantics (delta review r6 — the real predicate, not a fake)', () => {
  /** The fresh-boot state: ONE tab whose single leaf is the picker pane —
   * the state Freshell creates BEFORE selectShellFromPicker runs. The r5
   * predicate (any tab OR any layout) was ALWAYS TRUE here, so an absent
   * option was misclassified as a late dispatch and burned the 60s render
   * wait instead of advancing. The predicate must be false in exactly
   * this shape. */
  const stubHarness = (state: unknown) => {
    vi.stubGlobal('window', { __FRESHELL_TEST_HARNESS__: { getState: () => state } })
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is FALSE on the fresh-boot picker state (initial tab + picker leaf, no terminal pane)', () => {
    stubHarness({
      tabs: { tabs: [{ id: 't1' }] },
      panes: { layouts: { t1: { type: 'leaf', id: 'p1', content: { kind: 'picker' } } } },
    })
    expect(paneCreationProbePredicate()).toBe(false)
  })

  it('is TRUE once a terminal pane exists (the late-dispatched pick)', () => {
    stubHarness({
      tabs: { tabs: [{ id: 't1' }] },
      panes: { layouts: { t1: { type: 'leaf', id: 'p1', content: { kind: 'terminal' } } } },
    })
    expect(paneCreationProbePredicate()).toBe(true)
  })

  it('walks split trees: a terminal pane nested under a split is found', () => {
    stubHarness({
      tabs: { tabs: [{ id: 't1' }] },
      panes: {
        layouts: {
          t1: {
            type: 'split',
            id: 's1',
            direction: 'horizontal',
            sizes: [0.5, 0.5],
            children: [
              { type: 'leaf', id: 'p1', content: { kind: 'picker' } },
              { type: 'leaf', id: 'p2', content: { kind: 'terminal' } },
            ],
          },
        },
      },
    })
    expect(paneCreationProbePredicate()).toBe(true)
  })

  it('is FALSE for a split tree of picker-only panes', () => {
    stubHarness({
      tabs: { tabs: [{ id: 't1' }] },
      panes: {
        layouts: {
          t1: {
            type: 'split',
            id: 's1',
            direction: 'vertical',
            sizes: [0.5, 0.5],
            children: [
              { type: 'leaf', id: 'p1', content: { kind: 'picker' } },
              { type: 'leaf', id: 'p2', content: { kind: 'picker' } },
            ],
          },
        },
      },
    })
    expect(paneCreationProbePredicate()).toBe(false)
  })

  it('is FALSE when the harness state is absent (no harness, no proof of creation)', () => {
    vi.stubGlobal('window', {})
    expect(paneCreationProbePredicate()).toBe(false)
  })
})

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
        // probe. A dispatchedAndReplaced outcome is the r8 race shape:
        // the button is GONE because the pick replaced the picker pane.
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

  it('returns immediately when .xterm is already visible', async () => {
    const { page, clicks } = pickerPage({}, true)
    await selectShellFromPicker(page)
    expect(clicks).toEqual([])
  })

  it('returns without clicking when .xterm appears during the stabilization wait', async () => {
    // The mid-wait recheck: a regression that skipped the second isVisible
    // check would fall into the click loop and double-create a terminal.
    const { page, clicks, xtermVisibilityChecks } = pickerPage({}, false, { xtermVisibleFromCall: 2 })
    await selectShellFromPicker(page)
    expect(clicks).toEqual([])
    expect(xtermVisibilityChecks()).toBe(2)
  })

  it('a successful click waits the full render budget and never escalates to other shells', async () => {
    const { page, clicks, renderWaits, clickTimeouts, settledMs } = pickerPage({
      Shell: { renderVisibleAfterMs: 5_000 },
      WSL: {}, CMD: {}, PowerShell: {}, Bash: {},
    })
    await selectShellFromPicker(page)
    expect(clicks).toEqual(['Shell'])
    expect(renderWaits).toEqual([SHELL_RENDER_TIMEOUT_MS])
    // The budget's picker envelope derives from THESE call arguments —
    // pin that the picker really uses the exported constants (delta r3).
    expect(clickTimeouts).toEqual([SHELL_CLICK_TIMEOUT_MS])
    expect(settledMs).toEqual([SHELL_PICKER_SETTLE_MS])
  })

  it('survives a render slower than the historical 30s wait (the recorded episode shape)', async () => {
    // The recorded tg4e trace: render starved past 30s. A 30s
    // implementation rejects here; the fix must wait longer.
    const { page, clicks, renderWaits } = pickerPage({
      Shell: { renderVisibleAfterMs: 35_000 },
    })
    await selectShellFromPicker(page)
    expect(clicks).toEqual(['Shell'])
    expect(renderWaits).toEqual([SHELL_RENDER_TIMEOUT_MS])
  })

  it('a render-wait HARD error (page closed) propagates with its original identity, never rewritten as render starvation', async () => {
    // The delta r10 loudness rule: only a TimeoutError is diagnosed as
    // "did not render"; page closure, browser crash, or interruption keep
    // their own error (a rewritten page-closed would misdiagnose an
    // infrastructure failure as render starvation).
    const { page, clicks } = pickerPage({
      Shell: { renderError: 'page-closed' },
      WSL: {}, CMD: {}, PowerShell: {}, Bash: {},
    })
    const err = await selectShellFromPicker(page).then(() => undefined, (e: unknown) => e)
    expect((err as Error).name).toBe('TargetClosedError')
    expect((err as Error).message).toBe('Page closed')
    expect(clicks).toEqual(['Shell']) // no escalation around a dead page
  })

  it('throws a diagnostic when a clicked shell never renders (loud, not silent)', async () => {
    const { page, clicks, renderWaits } = pickerPage({
      Shell: {}, // clicked, render never visible
      WSL: {}, CMD: {}, PowerShell: {}, Bash: {},
    })
    await expect(selectShellFromPicker(page)).rejects.toThrow(/did not render/)
    expect(clicks).toEqual(['Shell']) // no escalation, no terminal double-creation
    expect(renderWaits).toEqual([SHELL_RENDER_TIMEOUT_MS])
  })

  it('a not-clickable option (click TimeoutError: absent, detached, or obstructed) advances to the next shell', async () => {
    const { page, clicks, clickTimeouts } = pickerPage({
      Bash: { renderVisibleAfterMs: 1_000 }, // Shell/WSL/CMD/PowerShell not clickable
    })
    await selectShellFromPicker(page)
    expect(clicks).toEqual(['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash'])
    // Every click attempt uses the exported per-option budget — the same
    // constant shellPickerWorstCaseMs() composes from.
    expect(clickTimeouts).toEqual(Array.from({ length: 5 }, () => SHELL_CLICK_TIMEOUT_MS))
  })

  it('a non-timeout click error propagates (page closure is loud, never "option absent")', async () => {
    const { page, clicks } = pickerPage({
      Shell: { clickError: 'page-closed' },
    })
    await expect(selectShellFromPicker(page)).rejects.toThrow('Page closed')
    expect(clicks).toEqual(['Shell'])
  })

  it('a click timeout with a LATE DISPATCH (probe finds the created pane) is treated as the success path: render wait, no advance', async () => {
    // Playwright's click timeout spans every click stage — a timeout does
    // NOT prove the handler never ran (delta r5). Escalating here is the
    // historical double-creation path.
    const { page, clicks, renderWaits, probeWaits } = pickerPage({
      Shell: { lateDispatch: true, renderVisibleAfterMs: 1_000 },
      WSL: {}, CMD: {}, PowerShell: {}, Bash: {},
    })
    await selectShellFromPicker(page)
    expect(clicks).toEqual(['Shell']) // no second click — no double creation
    expect(probeWaits).toEqual([SHELL_PROBE_TIMEOUT_MS])
    expect(renderWaits).toEqual([SHELL_RENDER_TIMEOUT_MS]) // success-path render wait
  })

  it('a click timeout on a NON-EXISTENT option (count 0) advances with NO probe cost (delta review r7)', async () => {
    // A button that never existed cannot have dispatched: paying a probe
    // here cost every healthy boot whose picker omits the candidate a
    // deterministic extra 5s under the unchanged local 60s budget.
    const { page, clicks, clickTimeouts, probeWaits } = pickerPage({
      Bash: { renderVisibleAfterMs: 1_000 }, // Shell/WSL/CMD/PowerShell absent
    })
    await selectShellFromPicker(page)
    expect(clicks).toEqual(['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash'])
    expect(clickTimeouts).toEqual(Array.from({ length: 5 }, () => SHELL_CLICK_TIMEOUT_MS))
    // Absent options advance on the click timeout ALONE — no probe runs.
    expect(probeWaits).toEqual([])
  })

  it('a click timeout on an EXISTING option probes once before advancing (only an existing button could have dispatched)', async () => {
    const { page, clicks, probeWaits } = pickerPage({
      Shell: { clickTimesOut: true }, // exists, times out, nothing dispatched
      WSL: { clickTimesOut: true },
      CMD: { clickTimesOut: true },
      PowerShell: { clickTimesOut: true },
      Bash: { renderVisibleAfterMs: 1_000 },
    })
    await selectShellFromPicker(page)
    expect(clicks).toEqual(['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash'])
    // Four existing-but-timed-out options -> four probes, each using the
    // exported probe budget; Bash succeeds, so no probe for it.
    expect(probeWaits).toEqual(Array.from({ length: 4 }, () => SHELL_PROBE_TIMEOUT_MS))
  })

  it('a click that DISPATCHED and replaced the picker before the catch (count 0) still joins the success path (delta review r8)', async () => {
    // The race: Playwright delivered the action but timed out in
    // post-action processing; PanePicker faded and the picker pane was
    // REPLACED by the terminal pane before the catch ran. count() is 0,
    // but the terminal pane is already in state — an instant read must
    // catch it and wait for the render, never advance (advancing here
    // burns click windows on now-absent options and skips the render
    // wait entirely).
    const { page, clicks, renderWaits, probeWaits, probeNows } = pickerPage({
      Shell: { dispatchedAndReplaced: true, renderVisibleAfterMs: 1_000 },
      WSL: {}, CMD: {}, PowerShell: {}, Bash: {},
    })
    await selectShellFromPicker(page)
    expect(clicks).toEqual(['Shell']) // no advance despite count() === 0
    expect(probeWaits).toEqual([]) // no full probe needed — the instant read answered
    expect(probeNows).toEqual([1])
    expect(renderWaits).toEqual([SHELL_RENDER_TIMEOUT_MS]) // the render wait runs
  })

  it('a probe hard error (page closed) propagates loudly, never "option absent"', async () => {
    // The option EXISTS and its click timed out — the precheck passes the
    // probe the error belongs to. (A non-existent option would advance
    // before the probe, correctly.)
    const { page, clicks } = pickerPage(
      { Shell: { lateDispatch: true } },
      false,
      { probeHardError: true },
    )
    await expect(selectShellFromPicker(page)).rejects.toThrow('Page closed')
    expect(clicks).toEqual(['Shell'])
  })

  it('falls through silently only when every option is not clickable (historical contract)', async () => {
    const { page } = pickerPage({})
    await expect(selectShellFromPicker(page)).resolves.toBeUndefined()
  })
})
