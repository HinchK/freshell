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
 * answers the typed clear. b8ke ext r12 F1: the clear STOPS AT THE CLEAR —
 * acknowledgment covers clearing the fence, not starting a writer over the
 * acknowledged-risk tree, so the client performs NO handoff request after
 * the clear; the cleared banner (HANDOFF_FORCE_CLEARED) surfaces the state
 * with the explicit "Start reopen again" action, and only THAT user action
 * re-initiates the handoff (which goes through the coordinator fresh, as
 * any new request would). An ordinary Retry never clears the fence (the
 * server answers the typed PLATFORM_LIMITED_FENCED refusal).
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
  // retry's PLATFORM_LIMITED_FENCED refusal. b8ke e3r4 F2 (the DESIGN
  // RECONCILIATION): the STALE-reason refusals (STALE_START_FENCED /
  // STALE_STOP_FENCED) NEVER offer the force-clear — those states mean
  // the prior runtime may STILL BE LIVE, so clearing to Vacant and
  // chaining a writer would weaken active-writer refusal; their recovery
  // is the server's CONFIRMED-DEATH PROBE ONLY (the Banner presents the
  // fenced state and probe-based retry guidance).
  const platformLimited = error.code === 'PLATFORM_LIMITED'
    || error.code === 'PLATFORM_LIMITED_FENCED'

  // b8ke ext r12 F1: the acknowledged force-clear's STOPPED state — the
  // fence cleared, no reopen ran. The explicit re-initiation affordance
  // ("Start reopen again") is the ONLY next step; no automatic retry ever
  // runs from the clear.
  const forceCleared = error.code === 'HANDOFF_FORCE_CLEARED'

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
            aria-label="Force clear the platform-limited fence, acknowledging unverified descendant processes may remain — the reopen is a separate explicit action"
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
          aria-label={forceCleared
            ? 'Start the reopen again now that the fence is cleared'
            : 'Retry reopening this session'}
          disabled={retryArmed}
          onClick={() => {
            if (retryTimerRef.current !== null) return
            setRetryArmed(true)
            retryTimerRef.current = setTimeout(() => {
              retryTimerRef.current = null
              setRetryArmed(false)
              void runPaneSessionHandoff(appStore, {
                tabId,
                paneId,
                // b8ke ext r16 F4: the cleared state's start-again action
                // CARRIES THE ACKNOWLEDGMENT — the clear landed in the
                // typed cleared-unverified state (never plain Vacant), and
                // the acknowledged-risk arm is what licenses the new
                // writer's START (the server records the acknowledgment
                // at the START; an unacknowledged start is refused typed).
                ...(forceCleared ? { acknowledgePlatformLimitedRisk: true } : {}),
              })
            }, SESSION_HANDOFF_RETRY_BACKOFF_MS)
          }}
        >
          {forceCleared ? 'Start reopen again' : 'Retry'}
        </button>
      </div>
    </div>
  )
}
