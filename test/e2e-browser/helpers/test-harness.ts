import type { Page } from '@playwright/test'
import type { PerfAuditSnapshot } from '@/lib/perf-audit-bridge'
import type { TerminalWriteEvent } from '@/lib/test-harness'

/** Default waitForConnection window (ms) used when neither an explicit
 * per-call timeout nor FRESHELL_E2E_WS_READY_TIMEOUT_MS applies. 30s
 * preserves the historical REAL window: the old code passed 15s, but as
 * the predicate's argument (never bound), so the real window was
 * Playwright's 30s default. Binding 15s for real would have narrowed every
 * no-arg call site from 30s to 16s and risked new cold-start flakes. */
export const DEFAULT_WS_READY_TIMEOUT_MS = 30_000

/**
 * Resolve the effective waitForConnection window.
 *
 * Precedence: an explicit per-call timeout wins; otherwise the
 * FRESHELL_E2E_WS_READY_TIMEOUT_MS env var scales the window (the cloud e2e
 * lane sets it — see scripts/e2e-cloud.sh); otherwise the 30s default that
 * preserves the historical real window. Cloud cold starts can need more:
 * the client's 10s ready watchdog (CONNECTION_TIMEOUT_MS,
 * src/lib/ws-client.ts) force-closes a slow handshake and reconnects with
 * jittered 1→2→4s backoff, and the observed j90s flake exceeded a real 30s
 * window. Empty, non-numeric, or non-positive env values fall back to the
 * default — a malformed override must never poison the harness wait.
 */
export function resolveWsReadyTimeoutMs(
  explicitMs: number | undefined,
  env: Record<string, string | undefined> = process.env,
): number {
  if (explicitMs !== undefined) return explicitMs
  const raw = env.FRESHELL_E2E_WS_READY_TIMEOUT_MS
  if (raw === undefined || raw === '') return DEFAULT_WS_READY_TIMEOUT_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_WS_READY_TIMEOUT_MS
  return parsed
}

/**
 * Start/body reserve added to the connection and picker envelopes when
 * computing the cloud-lane per-test budget: healthy page.goto +
 * waitForHarness (~3s — their maxima are self-limiting: each throws its
 * own distinct navigation/wait timeout well before the test deadline) and
 * a body-start margin for the test's first steps.
 */
export const CLOUD_LANE_START_RESERVE_MS = 30_000

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
 * never drift from the implementation (delta-review r2): the
 * stabilization settle, at most one click budget per shell name (every
 * path through the loop makes at most SHELL_NAMES.length clicks, each
 * bounded by SHELL_CLICK_TIMEOUT_MS — including the successful one), and
 * at most one render wait.
 */
export function shellPickerWorstCaseMs(): number {
  return SHELL_PICKER_SETTLE_MS
    + SHELL_NAMES.length * SHELL_CLICK_TIMEOUT_MS
    + SHELL_RENDER_TIMEOUT_MS
}

/**
 * Resolve the cloud-lane per-test deadline budget, or null on the local
 * lane (kata tg4e). The budget COVERS THE PERMITTED COMPOSITION of the
 * fixture chain (delta-review r2): the connection envelope (waitForConnection
 * enforces its window W as a single total deadline, W + 1s slack) plus the
 * picker's permitted worst case plus a start/body reserve. The config's 60s
 * default deadline kills fixture setup mid-composition ("Test timeout of
 * 60000ms exceeded while setting up freshellPage" — the recorded tg4e flake,
 * whose retained trace shows connection AND render slowness co-occurring
 * in one container-wide disturbance). The budget derives from the SAME env
 * that scales the window (one source of truth, one parsing rule via
 * resolveWsReadyTimeoutMs) so a custom window scales the budget with it.
 * Callers must treat null as "do not touch the deadline" — the local
 * lane keeps the config default unchanged — and must apply the budget
 * EXTEND-ONLY (never shrink a declared deadline).
 */
export function resolveCloudLaneTestBudgetMs(
  env: Record<string, string | undefined> = process.env,
): number | null {
  if (!isCloudLaneWindowConfigured(env)) return null
  const connectionEnvelopeMs = resolveWsReadyTimeoutMs(undefined, env) + 1000
  return connectionEnvelopeMs + shellPickerWorstCaseMs() + CLOUD_LANE_START_RESERVE_MS
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

/**
 * Helpers for interacting with the Freshell test harness from Playwright tests.
 */
export class TestHarness {
  constructor(private page: Page) {}

  /** Wait for the test harness to be installed on the page */
  async waitForHarness(timeoutMs = 15_000): Promise<void> {
    await this.page.waitForFunction(
      () => !!window.__FRESHELL_TEST_HARNESS__,
      { timeout: timeoutMs },
    )
  }

  /**
   * Wait for WebSocket connection to reach 'ready' state.
   *
   * The timeout is passed as waitForFunction's OPTIONS (third argument).
   * The historical two-arg call bound the timeout object to the
   * predicate's argument, so every explicit window was decorative and the
   * real wait was Playwright's 30s default (empirically confirmed — see
   * the j90s load-bearing ledger, LB-1). The resolved window keeps +1s
   * slack, so the no-arg default lands at 31s — preserving (by 1s of
   * harmless widening) the real 30s window local runs always had.
   *
   * With opts.selfHealReload (opt-in, fresh-boot sites only), the window
   * splits into two phases sized from the resolved window W: phase 1 is a
   * boolean poll within floor(W/2); if ready has not landed, ONE
   * page.reload({ timeout: W - floor(W/2) }) mints a fresh boot chain and
   * the final phase waits the remaining budget MINUS the reload's elapsed
   * time (+1s slack) — W is a single total deadline, so the whole
   * self-heal path spends at most W + 1s wall clock — letting Playwright's
   * native TimeoutError propagate on failure.
   */
  async waitForConnection(timeoutMs?: number, opts: WaitForConnectionOptions = {}): Promise<void> {
    const resolvedTimeoutMs = resolveWsReadyTimeoutMs(timeoutMs)
    if (!opts.selfHealReload) {
      await this.page.waitForFunction(
        wsReadyPredicate,
        undefined,
        { timeout: resolvedTimeoutMs + 1000 },
      )
      return
    }
    const phase1Ms = Math.floor(resolvedTimeoutMs / 2)
    const remainingMs = resolvedTimeoutMs - phase1Ms
    const readyWithinPhase1 = await this.page.waitForFunction(
      wsReadyPredicate,
      undefined,
      { timeout: phase1Ms },
    ).then(() => true, () => false)
    if (!readyWithinPhase1) {
      // Enforce W as a SINGLE TOTAL deadline (kata tg4e): the reload's
      // navigation and phase-2's poll SHARE the remaining budget, so the
      // self-heal path spends at most W + 1s wall clock. The previous
      // shape let each step consume its own full sub-window (up to 1.5W
      // sequentially — 135s at W=90s: phase-1 W/2 + reload W/2 + phase-2
      // W/2), a drift that outgrew any per-test budget.
      const reloadStartedAt = Date.now()
      await this.page.reload({ timeout: remainingMs })
      const phase2Ms = Math.max(0, remainingMs - (Date.now() - reloadStartedAt)) + 1000
      await this.page.waitForFunction(
        wsReadyPredicate,
        undefined,
        { timeout: phase2Ms },
      )
    }
  }

  /**
   * Force-close the underlying WebSocket to trigger auto-reconnect.
   * Unlike the WsClient's disconnect() method, this does NOT set intentionalClose,
   * so the client will attempt to reconnect automatically.
   */
  async forceDisconnect(): Promise<void> {
    const previousLastReadyAt = await this.page.evaluate(() => {
      const state = window.__FRESHELL_TEST_HARNESS__?.getState()
      return state?.connection?.lastReadyAt ?? null
    })
    await this.page.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.forceDisconnect()
    })
    await this.page.waitForFunction(
      (lastReadyAt) => {
        const harness = window.__FRESHELL_TEST_HARNESS__
        if (!harness) return false
        const state = harness.getState()
        return harness.getWsReadyState() !== 'ready'
          || (state?.connection?.lastReadyAt ?? null) !== lastReadyAt
      },
      previousLastReadyAt,
      { timeout: 5_000 },
    )
  }

  /** Get the current Redux state */
  async getState(): Promise<any> {
    return this.page.evaluate(() => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      if (!harness) throw new Error('Test harness not installed')
      return harness.getState()
    })
  }

  /**
   * Get terminal buffer content via the xterm.js buffer API.
   * This works with all renderers (WebGL, canvas, DOM) unlike DOM scraping.
   * @param terminalId - specific terminal ID, or omit for first registered terminal
   */
  async getTerminalBuffer(terminalId?: string): Promise<string | null> {
    return this.page.evaluate((id) => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      if (!harness) throw new Error('Test harness not installed')
      return harness.getTerminalBuffer(id)
    }, terminalId)
  }

  async getPerfAuditSnapshot(): Promise<PerfAuditSnapshot | null> {
    return this.page.evaluate(() => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      if (!harness) throw new Error('Test harness not installed')
      return harness.getPerfAuditSnapshot()
    })
  }

  async getSentWsMessages(): Promise<unknown[]> {
    return this.page.evaluate(() => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      if (!harness) throw new Error('Test harness not installed')
      return harness.getSentWsMessages?.() ?? []
    })
  }

  async getSentWsMessagesWithTimestamps(): Promise<Array<{ __sentAt?: number; type?: string; requestId?: string }>> {
    return this.page.evaluate(() => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      if (!harness) throw new Error('Test harness not installed')
      return harness.getSentWsMessagesWithTimestamps?.() ?? []
    })
  }

  async clearSentWsMessages(): Promise<void> {
    await this.page.evaluate(() => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      if (!harness) throw new Error('Test harness not installed')
      harness.clearSentWsMessages?.()
    })
  }

  async getTerminalWriteEvents(): Promise<TerminalWriteEvent[]> {
    return this.page.evaluate(() => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      if (!harness) throw new Error('Test harness not installed')
      return harness.getTerminalWriteEvents?.() ?? []
    })
  }

  async clearTerminalWriteEvents(): Promise<void> {
    await this.page.evaluate(() => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      if (!harness) throw new Error('Test harness not installed')
      harness.clearTerminalWriteEvents?.()
    })
  }

  async receiveWsMessage(message: unknown): Promise<void> {
    await this.page.evaluate((msg) => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      if (!harness) throw new Error('Test harness not installed')
      harness.receiveWsMessage?.(msg as any)
    }, message)
  }

  /**
   * Wait for specific text to appear in the terminal buffer.
   * Uses the xterm.js buffer API via the test harness (renderer-agnostic).
   */
  async waitForTerminalText(
    text: string,
    options: { terminalId?: string; timeout?: number } = {},
  ): Promise<void> {
    const { terminalId, timeout = 10_000 } = options
    await this.page.waitForFunction(
      ({ searchText, id }) => {
        const harness = window.__FRESHELL_TEST_HARNESS__
        if (!harness) return false
        const buffer = harness.getTerminalBuffer(id)
        return buffer !== null && buffer.includes(searchText)
      },
      { searchText: text, id: terminalId },
      { timeout },
    )
  }

  /** Get tab count */
  async getTabCount(): Promise<number> {
    return this.page.evaluate(() => {
      const state = window.__FRESHELL_TEST_HARNESS__?.getState()
      return state?.tabs?.tabs?.length ?? 0
    })
  }

  /** Get active tab ID */
  async getActiveTabId(): Promise<string | null> {
    return this.page.evaluate(() => {
      const state = window.__FRESHELL_TEST_HARNESS__?.getState()
      return state?.tabs?.activeTabId ?? null
    })
  }

  /** Get pane layout for a tab */
  async getPaneLayout(tabId: string): Promise<any> {
    return this.page.evaluate((id) => {
      const state = window.__FRESHELL_TEST_HARNESS__?.getState()
      return state?.panes?.layouts?.[id] ?? null
    }, tabId)
  }

  /** Wait for a specific number of tabs */
  async waitForTabCount(count: number, timeoutMs = 10_000): Promise<void> {
    await this.page.waitForFunction(
      (expected) => {
        const state = window.__FRESHELL_TEST_HARNESS__?.getState()
        return (state?.tabs?.tabs?.length ?? 0) === expected
      },
      count,
      { timeout: timeoutMs },
    )
  }

  /** Wait for terminal to have a specific status */
  async waitForTerminalStatus(
    status: string,
    timeoutMs = 15_000,
  ): Promise<void> {
    await this.page.waitForFunction(
      (expectedStatus) => {
        const state = window.__FRESHELL_TEST_HARNESS__?.getState()
        if (!state) return false
        const tabs = state.tabs?.tabs ?? []
        const activeTabId = state.tabs?.activeTabId
        if (!activeTabId) return false
        const layout = state.panes?.layouts?.[activeTabId]
        if (!layout) return false
        // Check leaf nodes for terminal status
        const checkNode = (node: any): boolean => {
          if (node.type === 'leaf' && node.content?.kind === 'terminal') {
            return node.content.status === expectedStatus
          }
          if (node.type === 'split') {
            return node.children.some(checkNode)
          }
          return false
        }
        return checkNode(layout)
      },
      status,
      { timeout: timeoutMs },
    )
  }

  /** Get connection status from Redux */
  async getConnectionStatus(): Promise<string> {
    return this.page.evaluate(() => {
      const state = window.__FRESHELL_TEST_HARNESS__?.getState()
      return state?.connection?.status ?? 'unknown'
    })
  }

  /** Get settings from Redux (returns the inner AppSettings object) */
  async getSettings(): Promise<any> {
    return this.page.evaluate(() => {
      const state = window.__FRESHELL_TEST_HARNESS__?.getState()
      return state?.settings?.settings ?? null
    })
  }

  /**
   * Kill all running terminals via the REST API.
   *
   * This prevents PTY process accumulation across tests within a spec file.
   * The test server is worker-scoped (shared across tests) but each test
   * creates terminals. Without cleanup, PTY processes pile up and can cause
   * flaky tests or resource exhaustion.
   *
   * Uses GET /api/terminals to list, then sends WS `terminal.kill` messages
   * for each non-exited terminal through the harness's WebSocket connection.
   *
   * @param serverInfo - connection info for the test server
   */
  async killAllTerminals(serverInfo: { baseUrl: string; token: string }): Promise<void> {
    try {
      const terminals = await this.page.evaluate(
        async (info) => {
          const response = await fetch(`${info.baseUrl}/api/terminals`, {
            headers: { 'x-auth-token': info.token },
          })
          if (!response.ok) return []
          return response.json()
        },
        serverInfo,
      )

      if (!Array.isArray(terminals) || terminals.length === 0) return

      // Kill each non-exited terminal via WS message through the harness
      await this.page.evaluate(
        (terminalIds: string[]) => {
          const harness = window.__FRESHELL_TEST_HARNESS__
          if (!harness) return
          for (const terminalId of terminalIds) {
            harness.sendWsMessage({ type: 'terminal.kill', terminalId })
          }
        },
        terminals
          .filter((t: any) => t.status !== 'exited')
          .map((t: any) => t.terminalId),
      )

      // Brief wait for kills to propagate
      await this.page.waitForTimeout(200)
    } catch {
      // Cleanup errors should not fail tests
    }
  }
}

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

/** The shell options, in the order the picker leg tries them. Every
 * path through the loop makes at most one click per name. */
export const SHELL_NAMES = ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash'] as const

/** Playwright's click TimeoutError is the not-clickable signal (absent,
 * detached, or obstructed within the window — indistinguishable by name);
 * anything else (page closed, interruption, unexpected errors) is loud. */
function isClickUnavailableError(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError'
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
      if (!isClickUnavailableError(err)) throw err
      continue // option not clickable within the window — historical behavior
    }
    try {
      await page.locator('.xterm').first().waitFor({ state: 'visible', timeout: SHELL_RENDER_TIMEOUT_MS })
      return
    } catch (err) {
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
