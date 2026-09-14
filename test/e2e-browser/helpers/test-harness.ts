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
   * the final phase waits the remaining budget, letting Playwright's
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
      await this.page.reload({ timeout: remainingMs })
      await this.page.waitForFunction(
        wsReadyPredicate,
        undefined,
        { timeout: remainingMs },
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
