import { useEffect, useRef, useState } from 'react'
import type { AppStore } from '@/store/store'
import type { HandoffError } from '@/store/paneTypes'
import { runPaneSessionHandoff, SESSION_HANDOFF_RETRY_BACKOFF_MS } from '@/lib/session-handoff'

/**
 * Typed reopen-handoff failure banner (kata b8ke) — the stuck-card pattern
 * (role="alert", real buttons, aria-labels). Rendered by FreshAgentView and
 * TerminalView when the pane carries a `handoffError` (the atomic reopen's
 * typed failure — the pane was KEPT). The Retry re-invokes the SAME handoff
 * identity after a short backoff (never an immediate tight loop — a
 * double-click can't stack timers), refreshing the observed
 * (epoch, generation) fence from the runtime-owner record at send time.
 */
export function SessionHandoffErrorBanner({ error, appStore, tabId, paneId }: {
  error: HandoffError
  appStore: AppStore
  tabId: string
  paneId: string
}) {
  const [retryArmed, setRetryArmed] = useState(false)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // A new failure (or unmount) cancels any pending retry timer; the button
  // re-arms for the new state.
  useEffect(() => {
    setRetryArmed(false)
    return () => {
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
    }
  }, [error])

  if (!error.retryable) {
    return (
      <div
        role="alert"
        data-testid="session-handoff-error-banner"
        aria-label={`Reopen failed: ${error.code}`}
        className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm"
      >
        {error.message}
      </div>
    )
  }

  return (
    <div
      role="alert"
      data-testid="session-handoff-error-banner"
      aria-label={`Reopen failed: ${error.code}`}
      className="flex items-center justify-between gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm"
    >
      <span>{error.message}</span>
      <button
        type="button"
        className="shrink-0 rounded border border-border/70 px-2 py-1 text-xs disabled:opacity-60"
        aria-label="Retry reopening this session"
        disabled={retryArmed}
        onClick={() => {
          if (retryTimerRef.current !== null) return
          setRetryArmed(true)
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null
            setRetryArmed(false)
            void runPaneSessionHandoff(appStore, { tabId, paneId })
          }, SESSION_HANDOFF_RETRY_BACKOFF_MS)
        }}
      >
        Retry
      </button>
    </div>
  )
}
