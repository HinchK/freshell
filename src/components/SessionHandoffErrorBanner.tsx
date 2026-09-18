import { useEffect, useRef, useState } from 'react'
import type { AppStore } from '@/store/store'
import type { HandoffError } from '@/store/paneTypes'
import {
  runPaneSessionHandoff,
  runPaneSessionRecovery,
  SESSION_HANDOFF_RETRY_BACKOFF_MS,
} from '@/lib/session-handoff'

/**
 * Typed reopen-handoff failure banner (kata b8ke) — the stuck-card pattern
 * (role="alert", real buttons, aria-labels). Rendered by FreshAgentView and
 * TerminalView when the pane carries a `handoffError` (the atomic reopen's
 * typed failure — the pane was KEPT). The Retry re-invokes the SAME handoff
 * identity after a short backoff (never an immediate tight loop — a
 * double-click can't stack timers), refreshing the observed
 * (epoch, generation) fence from the runtime-owner record at send time.
 *
 * Force clear is a clear-only request: it repairs stale bookkeeping without
 * stopping or starting a writer. b8ke ext r28 F2: the r25 server repair made
 * the acknowledged clear accept the STALE-reason fences too (their
 * probe-only recovery left an evidence-less stale fence permanently
 * unrecoverable), so those refusals render the same action. b8ke ext r12
 * F1: the clear STOPS AT THE CLEAR —
 * clear; the cleared banner (HANDOFF_FORCE_CLEARED) surfaces the state with
 * an explicit Stop and reopen action. An ordinary Retry never clears the
 * fence (the server answers the typed PLATFORM_LIMITED_FENCED refusal).
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

  // R4-4: the force-clear action surfaces for the fence shapes the
  // server's acknowledged clear ACCEPTS — the PlatformLimited shapes
  // (the original PLATFORM_LIMITED failure and the ordinary retry's
  // PLATFORM_LIMITED_FENCED refusal) and, since the r25 server repair,
  // the STALE-reason refusals (STALE_START_FENCED / STALE_STOP_FENCED):
  // their recovery was the confirmed-death probe ONLY, so a stale fence
  // whose retained runtime evidence was gone was permanently
  // unrecoverable through the browser. The pre-r28 e3r4 DESIGN
  // RECONCILIATION rationale (clearing to Vacant + chaining a writer
  // would weaken active-writer refusal) no longer holds: the r25 clear
  // lands the TYPED cleared-unverified state and never chains a writer —
  // the acknowledged START is its own atomic arm, so the active-writer
  // refusal stays intact.
  const forceClearable = error.code === 'PLATFORM_LIMITED'
    || error.code === 'PLATFORM_LIMITED_FENCED'
    || error.code === 'STALE_START_FENCED'
    || error.code === 'STALE_STOP_FENCED'

  // b8ke ext r12 F1: the acknowledged force-clear's STOPPED state — the
  // fence cleared, no reopen ran. The explicit re-initiation affordance
  // ("Start reopen again") is the ONLY next step; no automatic retry ever
  // runs from the clear.
  // b8ke ext r28 F2: the CLEARED_UNVERIFIED_FENCED refusal (an ordinary
  // retry against the cleared-unverified key) is the SAME state — the
  // acknowledged START is the only next step, so its retry IS the
  // start-again action (an unfenced retry would loop the refusal
  // forever).
  const forceCleared = error.code === 'HANDOFF_FORCE_CLEARED'
    || error.code === 'CLEARED_UNVERIFIED_FENCED'

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
        {forceClearable ? (
          <button
            type="button"
            className="rounded border border-amber-500/70 px-2 py-1 text-xs disabled:opacity-60"
            aria-label="Force clear stale session bookkeeping — this does not stop or reopen the session"
            data-testid="session-handoff-force-clear-button"
            disabled={forceClearArmed}
            onClick={() => {
              if (forceClearTimerRef.current !== null) return
              setForceClearArmed(true)
              forceClearTimerRef.current = setTimeout(() => {
                forceClearTimerRef.current = null
                setForceClearArmed(false)
                void runPaneSessionRecovery(appStore, {
                  tabId,
                  paneId,
                  action: 'clear-stale-bookkeeping',
                })
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
                ...(forceCleared ? { action: 'stop-and-reopen' as const } : {}),
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

/**
 * b8ke ext r28 F2: the fenced-owner card's DIRECT recovery actions — the
 * shared action set FreshAgentView's and TerminalView's `fencedReason`
 * cards render. Pre-r28 the remote fenced-owner cards were passive, so
 * a stale fence whose retained runtime evidence was gone (the confirmed-
 * death probe could never resolve it) was PERMANENTLY unrecoverable
 * through the browser despite the server implementing the acknowledged
 * clear. The actions follow the server's accepted recovery arms:
 * - platform-limited | stale-start | stale-stop → the acknowledged
 *   FORCE-CLEAR (runPaneSessionHandoff with the risk acknowledgment;
 *   the server answers the typed clear and the pane surfaces the
 *   cleared state with its own start-again affordance);
 * - cleared-unverified (the r28-F1 post-clear state) → the acknowledged
 *   START ("Start reopen again" — the clear is not permission to start
 *   a writer; the acknowledgment at the START is);
 * - every other fenced reason (watcher-failed — probe-recovered) renders
 *   nothing: no operator clear exists for those.
 */
export function FencedOwnerRecoveryActions({ fencedReason, appStore, tabId, paneId }: {
  fencedReason: string
  appStore: AppStore
  tabId: string
  paneId: string
}) {
  const [armed, setArmed] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setArmed(false)
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [fencedReason])

  const forceClearable = fencedReason === 'platform-limited'
    || fencedReason === 'stale-start'
    || fencedReason === 'stale-stop'
  const clearedUnverified = fencedReason === 'cleared-unverified'
  if (!forceClearable && !clearedUnverified) return null

  const arm = (action: () => void) => {
    if (timerRef.current !== null) return
    setArmed(true)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setArmed(false)
      action()
    }, SESSION_HANDOFF_RETRY_BACKOFF_MS)
  }

  return (
    <>
      {forceClearable ? (
        <button
          type="button"
          className="shrink-0 rounded border border-amber-500/70 px-2 py-1 text-xs disabled:opacity-60"
          aria-label={`Force clear the ${fencedReason} fence — this does not stop or reopen the session`}
          data-testid="fenced-owner-force-clear-button"
          disabled={armed}
          onClick={() => {
            arm(() => {
              void runPaneSessionRecovery(appStore, {
                tabId,
                paneId,
                action: 'clear-stale-bookkeeping',
              })
            })
          }}
        >
          Force clear
        </button>
      ) : null}
      {clearedUnverified ? (
        <button
          type="button"
          className="shrink-0 rounded border border-border/70 px-2 py-1 text-xs disabled:opacity-60"
          aria-label="Start the reopen again now that the fence is cleared"
          data-testid="fenced-owner-start-again-button"
          disabled={armed}
          onClick={() => {
            arm(() => {
              void runPaneSessionHandoff(appStore, {
                tabId,
                paneId,
                action: 'stop-and-reopen',
              })
            })
          }}
        >
          Start reopen again
        </button>
      ) : null}
    </>
  )
}
