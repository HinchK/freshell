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
 *
 * b8ke focused round-4 R4-4: a PlatformLimited fence (this platform cannot
 * verify the prior runtime's descendant processes) renders the EXPLICIT
 * operator force-clear action — "Force clear" sends the handoff request
 * with the `acknowledgePlatformLimitedRisk` acknowledgment: the server
 * clears the fence (recording the unverified-descendant limitation) and
 * answers the typed clear; this client then retries the handoff
 * explicitly as the fresh no-prior sequence. An ordinary Retry never
 * clears the fence (the server answers the typed PLATFORM_LIMITED_FENCED
 * refusal).
 */
export function SessionHandoffErrorBanner({ error, appStore, tabId, paneId }: {
  error: HandoffError
  appStore: AppStore
  tabId: string
  paneId: string
}) {
  const [retryArmed, setRetryArmed] = useState(false)
  const [forceClearArmed, setForceClearArmed] = useState(false)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const forceClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // A new failure (or unmount) cancels any pending retry timer; the buttons
  // re-arm for the new state.
  useEffect(() => {
    setRetryArmed(false)
    setForceClearArmed(false)
    return () => {
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
      if (forceClearTimerRef.current !== null) {
        clearTimeout(forceClearTimerRef.current)
        forceClearTimerRef.current = null
      }
    }
  }, [error])

  // R4-4: the force-clear action surfaces for the platform-limited fence
  // shapes — the original PLATFORM_LIMITED failure and the ordinary
  // retry's PLATFORM_LIMITED_FENCED refusal.
  const platformLimited = error.code === 'PLATFORM_LIMITED'
    || error.code === 'PLATFORM_LIMITED_FENCED'

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
      <div className="flex shrink-0 items-center gap-2">
        {platformLimited ? (
          <button
            type="button"
            className="rounded border border-amber-500/70 px-2 py-1 text-xs disabled:opacity-60"
            aria-label="Force clear the platform-limited fence and reopen, acknowledging unverified descendant processes may remain"
            data-testid="session-handoff-force-clear-button"
            disabled={forceClearArmed}
            onClick={() => {
              if (forceClearTimerRef.current !== null) return
              setForceClearArmed(true)
              forceClearTimerRef.current = setTimeout(() => {
                forceClearTimerRef.current = null
                setForceClearArmed(false)
                void runPaneSessionHandoff(appStore, { tabId, paneId, acknowledgePlatformLimitedRisk: true })
              }, SESSION_HANDOFF_RETRY_BACKOFF_MS)
            }}
          >
            Force clear
          </button>
        ) : null}
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
    </div>
  )
}
