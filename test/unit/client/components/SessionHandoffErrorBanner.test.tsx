import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SessionHandoffErrorBanner } from '@/components/SessionHandoffErrorBanner'
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
    const button = screen.getByRole('button', { name: /force clear/i })
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
