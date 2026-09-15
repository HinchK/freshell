import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Page } from '@playwright/test'
import {
  CLOUD_LANE_START_RESERVE_MS,
  DEFAULT_WS_READY_TIMEOUT_MS,
  SHELL_CLICK_TIMEOUT_MS,
  SHELL_NAMES,
  SHELL_PICKER_SETTLE_MS,
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
})

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

  it('falls through silently only when every option is not clickable (historical contract)', async () => {
    const { page } = pickerPage({})
    await expect(selectShellFromPicker(page)).resolves.toBeUndefined()
  })
})
