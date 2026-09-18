import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FencedOwnerRecoveryActions, SessionHandoffErrorBanner } from '@/components/SessionHandoffErrorBanner'
import type { HandoffError } from '@/store/paneTypes'

const runPaneSessionHandoffMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/session-handoff', () => ({
  runPaneSessionHandoff: runPaneSessionHandoffMock,
  SESSION_HANDOFF_RETRY_BACKOFF_MS: 0,
}))

function errorWith(overrides: Partial<HandoffError>): HandoffError {
  return {
    code: 'REAP_TIMEOUT',
    message: 'The reopen failed.',
    retryable: true,
    generation: 3,
    ...overrides,
  }
}

const store = {} as never

describe('SessionHandoffErrorBanner (kata b8ke R4-4 force-clear action)', () => {
  beforeEach(() => {
    runPaneSessionHandoffMock.mockReset()
    runPaneSessionHandoffMock.mockResolvedValue(false)
  })

  afterEach(() => {
    cleanup()
  })

  it('renders the Force clear action for a PlatformLimited fence', async () => {
    const user = userEvent.setup()
    render(
      <SessionHandoffErrorBanner
        error={errorWith({ code: 'PLATFORM_LIMITED_FENCED' })}
        appStore={store}
        tabId="tab-1"
        paneId="pane-1"
      />,
    )
    // b8ke ext r19 F2: the accessible name matches the ACTUAL behavior —
    // the action clears the blockage ONLY; the reopen is the separate
    // explicit "Start reopen again" action (the pre-r19 name promised
    // "and reopen", misleading screen-reader users).
    const button = screen.getByRole('button', {
      name: 'Force clear the platform-limited fence, acknowledging unverified descendant processes may remain — the reopen is a separate explicit action',
    })
    expect(button).toBeDefined()
    await user.click(button)
    await waitFor(() => {
      expect(runPaneSessionHandoffMock).toHaveBeenCalledWith(
        store,
        expect.objectContaining({
          tabId: 'tab-1',
          paneId: 'pane-1',
          acknowledgePlatformLimitedRisk: true,
        }),
      )
    })
  })

  it('renders the Force clear action for the original PLATFORM_LIMITED failure', () => {
    render(
      <SessionHandoffErrorBanner
        error={errorWith({ code: 'PLATFORM_LIMITED' })}
        appStore={store}
        tabId="tab-1"
        paneId="pane-1"
      />,
    )
    expect(screen.getByRole('button', { name: /force clear/i })).toBeDefined()
  })

  // b8ke ext r28 F2: the r25 server change made the acknowledged
  // force-clear accept the STALE-reason fences (their recovery was the
  // confirmed-death probe ONLY, so a stale fence whose retained runtime
  // evidence was gone was PERMANENTLY unrecoverable through the browser).
  // The pre-r28 banner deliberately withheld the action — the e3r4 DESIGN
  // RECONCILIATION's rationale (clearing to Vacant + chaining a writer)
  // no longer holds: the server's clear lands the TYPED
  // cleared-unverified state and NEVER chains a writer (the acknowledged
  // START is its own atomic arm), so the active-writer refusal is intact.
  it('renders the Force clear action for the stale-reason fences (the acknowledged clear is their operator escape)', async () => {
    const user = userEvent.setup()
    for (const code of ['STALE_START_FENCED', 'STALE_STOP_FENCED']) {
      const { unmount } = render(
        <SessionHandoffErrorBanner
          error={errorWith({ code })}
          appStore={store}
          tabId="tab-1"
          paneId="pane-1"
        />,
      )
      const button = screen.getByRole('button', { name: /force clear/i })
      expect(button, code).toBeDefined()
      await user.click(button)
      await waitFor(() => {
        expect(runPaneSessionHandoffMock).toHaveBeenCalledWith(
          store,
          expect.objectContaining({
            tabId: 'tab-1',
            paneId: 'pane-1',
            acknowledgePlatformLimitedRisk: true,
          }),
        )
      })
      runPaneSessionHandoffMock.mockClear()
      unmount()
    }
  })

  // b8ke ext r28 F2: an ordinary retry against a CLEARED-UNVERIFIED key
  // answers the typed CLEARED_UNVERIFIED_FENCED refusal — the state IS the
  // cleared fence, so the banner's action is the ACKNOWLEDGED START (the
  // same start-again affordance the cleared banner offers), never an
  // unfenced retry that would loop the refusal forever.
  it('renders the acknowledged Start-again action for CLEARED_UNVERIFIED_FENCED (the ordinary retry is refused)', async () => {
    const user = userEvent.setup()
    render(
      <SessionHandoffErrorBanner
        error={errorWith({ code: 'CLEARED_UNVERIFIED_FENCED' })}
        appStore={store}
        tabId="tab-1"
        paneId="pane-1"
      />,
    )
    expect(screen.queryByRole('button', { name: /force clear/i })).toBeNull()
    const startAgain = screen.getByRole('button', { name: /start the reopen again/i })
    await user.click(startAgain)
    await waitFor(() => {
      expect(runPaneSessionHandoffMock).toHaveBeenCalledWith(
        store,
        expect.objectContaining({
          tabId: 'tab-1',
          paneId: 'pane-1',
          acknowledgePlatformLimitedRisk: true,
        }),
      )
    })
  })

  it('no force-clear action for ordinary retryable failures — Retry stays the only action', async () => {
    const user = userEvent.setup()
    render(
      <SessionHandoffErrorBanner
        error={errorWith({ code: 'REAP_TIMEOUT' })}
        appStore={store}
        tabId="tab-1"
        paneId="pane-1"
      />,
    )
    expect(screen.queryByRole('button', { name: /force clear/i })).toBeNull()
    await user.click(screen.getByRole('button', { name: /retry/i }))
    await waitFor(() => {
      expect(runPaneSessionHandoffMock).toHaveBeenCalledWith(
        store,
        expect.objectContaining({
          tabId: 'tab-1',
          paneId: 'pane-1',
        }),
      )
      const call = runPaneSessionHandoffMock.mock.calls[0]
      expect(call[1].acknowledgePlatformLimitedRisk).toBeUndefined()
    })
  })
})

describe('b8ke ext r12 F1: the cleared state presents the explicit re-initiation affordance', () => {
  afterEach(() => {
    cleanup()
  })

  it('the cleared-state Start-again action carries the acknowledged-risk arm (b8ke ext r16 F4)', async () => {
    const user = userEvent.setup()
    render(
      <SessionHandoffErrorBanner
        error={errorWith({
          code: 'HANDOFF_FORCE_CLEARED',
          message: 'The platform-limited fence was cleared.',
          retryable: true,
          generation: 5,
        })}
        appStore={store}
        tabId="tab-1"
        paneId="pane-1"
      />,
    )
    const startAgain = screen.getByRole('button', {
      name: 'Start the reopen again now that the fence is cleared',
    })
    await user.click(startAgain)
    // The action re-initiates with the ACKNOWLEDGED-RISK arm (the cleared
    // state is not permission to start a writer — the acknowledgment at
    // the START is).
    await waitFor(() => {
      expect(runPaneSessionHandoffMock).toHaveBeenCalledWith(
        store,
        expect.objectContaining({
          tabId: 'tab-1',
          paneId: 'pane-1',
          acknowledgePlatformLimitedRisk: true,
        }),
      )
    })
  })

  it('renders HANDOFF_FORCE_CLEARED with the Start-again action and NO force-clear button', () => {
    render(
      <SessionHandoffErrorBanner
        error={errorWith({
          code: 'HANDOFF_FORCE_CLEARED',
          message: 'The platform-limited fence was cleared.',
          retryable: true,
          generation: 5,
        })}
        appStore={store}
        tabId="tab-1"
        paneId="pane-1"
      />,
    )
    const banner = screen.getByRole('alert')
    expect(banner).toHaveTextContent(/fence was cleared/i)
    // THE EXPLICIT AFFORDANCE: the user action that re-initiates the
    // handoff (which then goes through the coordinator fresh).
    expect(
      screen.getByRole('button', { name: 'Start the reopen again now that the fence is cleared' }),
    ).toBeDefined()
    expect(screen.getByRole('button', { name: /start the reopen again/i })).toBeDefined()
    // No force-clear action on the CLEARED state (the fence is gone).
    expect(screen.queryByRole('button', { name: /force clear/i })).toBeNull()
  })
})

describe('b8ke ext r28 F2: FencedOwnerRecoveryActions (the fenced-owner card recovery)', () => {
  beforeEach(() => {
    runPaneSessionHandoffMock.mockReset()
    runPaneSessionHandoffMock.mockResolvedValue(false)
  })

  afterEach(() => {
    cleanup()
  })

  // Pre-r28 the remote fenced-owner cards (FreshAgentView's and
  // TerminalView's `fencedReason` cards) were PASSIVE — a stale fence
  // whose retained runtime evidence was gone was permanently
  // unrecoverable through the browser despite the server implementing
  // the acknowledged clear.
  it('renders the Force clear action for the server-accepted unconfirmable reasons', async () => {
    const user = userEvent.setup()
    for (const fencedReason of [
      'platform-limited',
      'stale-start',
      'stale-stop',
    ] as const) {
      const { unmount } = render(
        <FencedOwnerRecoveryActions
          fencedReason={fencedReason}
          appStore={store}
          tabId="tab-1"
          paneId="pane-1"
        />,
      )
      const button = screen.getByRole('button', { name: /force clear/i })
      expect(button, fencedReason).toBeDefined()
      await user.click(button)
      await waitFor(() => {
        expect(runPaneSessionHandoffMock).toHaveBeenCalledWith(
          store,
          expect.objectContaining({
            tabId: 'tab-1',
            paneId: 'pane-1',
            acknowledgePlatformLimitedRisk: true,
          }),
        )
      })
      runPaneSessionHandoffMock.mockClear()
      unmount()
    }
  })

  it('renders the Start-again action (the acknowledged START) for the cleared-unverified state', async () => {
    const user = userEvent.setup()
    render(
      <FencedOwnerRecoveryActions
        fencedReason="cleared-unverified"
        appStore={store}
        tabId="tab-1"
        paneId="pane-1"
      />,
    )
    expect(screen.queryByRole('button', { name: /force clear/i })).toBeNull()
    const startAgain = screen.getByRole('button', { name: /start the reopen again/i })
    await user.click(startAgain)
    await waitFor(() => {
      expect(runPaneSessionHandoffMock).toHaveBeenCalledWith(
        store,
        expect.objectContaining({
          tabId: 'tab-1',
          paneId: 'pane-1',
          acknowledgePlatformLimitedRisk: true,
        }),
      )
    })
  })

  it('renders nothing for the probe-recovered fences (no operator clear exists)', () => {
    const { container } = render(
      <FencedOwnerRecoveryActions
        fencedReason="watcher-failed"
        appStore={store}
        tabId="tab-1"
        paneId="pane-1"
      />,
    )
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })
})
