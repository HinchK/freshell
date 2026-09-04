import { useCallback, useLayoutEffect, useRef } from 'react'
import {
  recordPaneFocusBeforeUnmount,
  shouldFocusPaneOnEligibleMount,
} from '@/lib/pane-focus-ownership'

type AdoptionState = 'pending' | 'allowed' | 'denied'

/**
 * Mount-time focus-adoption gate (agent focus neutrality).
 *
 * Pane content components auto-focus on eligible mounts and on false→true
 * eligibility flips (explicit select). Flips always focus. Eligible MOUNTS are
 * gated by recorded focus ownership: an agent-driven leaf→split REMOUNTS the
 * pane subtree, and Redux eligibility alone cannot distinguish "user split a
 * pane they were typing in" from "agent split while the user was in the
 * sidebar" — the pre-unmount ownership record can.
 *
 * The decision is consumed lazily via the returned `mayFocusNow`, so
 * components whose focus target materializes asynchronously (Monaco onMount,
 * a deferred extension iframe, terminal attach) evaluate the gate when the
 * focus would actually happen, not when the effect first ran. The decision is
 * made at most once per component instance; later flips bypass it entirely.
 */
export function usePaneFocusAdoption(paneId: string | undefined, focusEligible: boolean): () => boolean {
  const adoptionRef = useRef<AdoptionState>('pending')
  const wasIneligibleRef = useRef(!focusEligible)

  // Render-phase flip detection (same pattern as TerminalView's render-synced
  // refs): an explicit select resolves adoption to 'allowed' immediately, so
  // even a focus target that materializes later focuses unconditionally.
  if (focusEligible && wasIneligibleRef.current && adoptionRef.current === 'pending') {
    adoptionRef.current = 'allowed'
  }
  wasIneligibleRef.current = !focusEligible

  const mayFocusNow = useCallback((): boolean => {
    // Without a pane identity there is no ownership record — behave exactly
    // like a freshly created pane (which also defaults to "may focus").
    if (!paneId) return true
    if (adoptionRef.current === 'pending') {
      adoptionRef.current = shouldFocusPaneOnEligibleMount(paneId) ? 'allowed' : 'denied'
    }
    return adoptionRef.current === 'allowed'
  }, [paneId])

  // Record ownership at teardown. MUST be a layout-effect cleanup: passive
  // cleanups run after the DOM subtree is detached and could not answer the
  // contains() question.
  useLayoutEffect(() => {
    if (!paneId) return
    return () => recordPaneFocusBeforeUnmount(paneId)
  }, [paneId])

  return mayFocusNow
}
