import { useLayoutEffect, useState } from 'react'

/**
 * Lock (inert + data-focus-locked) state for panes hosting a nested document
 * (BrowserPane, ExtensionPane).
 *
 * LOCKED ⇔ the pane is not allowed to hold DOM focus: ineligible (hidden tab,
 * non-active pane) OR ownership-denied at mount (agent-driven remount while
 * the user is in app chrome — the nested page's autofocus must not hijack the
 * outer document).
 *
 * Commit-order safety: the adoption read MUST NOT happen during render —
 * React renders the replacement subtree BEFORE the outgoing subtree's layout
 * cleanups write the ownership record, so a render-time read would latch
 * "unknown → allowed" permanently. The read happens in this layout effect:
 * deletions commit (with their records) before this effect runs, and the state
 * update lands before paint.
 *
 * Pointer unlock: there is NO eligibility transition or epoch bump when the
 * user clicks an already-active pane — so without this hook's listener, a
 * denied remount would keep the iframe inert forever. A pointerdown inside the
 * pane root is the user's intent to use the pane; the lock lifts (the click
 * itself is absorbed by the inert subtree; the NEXT click into the iframe
 * works — standard "click to wake" recovery).
 */
export function useIframeFocusLock(
  paneRoot: HTMLElement | null,
  focusEligible: boolean,
  mayFocusNow: () => boolean,
): boolean {
  const [locked, setLocked] = useState(() => !focusEligible)

  // paneRoot comes from a callback-ref STATE (not a ref object): the effect
  // re-runs the moment a deferred element (e.g. a server extension iframe
  // waiting on serverRunning) finally mounts, so the unlock listener always
  // ends up attached to a real DOM node.
  useLayoutEffect(() => {
    setLocked(!focusEligible || !mayFocusNow())
    // With inert applied, hit tests against the locked subtree retarget to the
    // closest NON-inert ancestor — the pane shell — so listen there (fall back
    // to the element itself when no shell exists, e.g. bare unit renders).
    const listenTarget = (paneRoot?.closest('[data-pane-id]') as HTMLElement | null) ?? paneRoot
    if (!listenTarget || !focusEligible) return
    const unlock = () => setLocked(false)
    listenTarget.addEventListener('pointerdown', unlock, true)
    return () => listenTarget.removeEventListener('pointerdown', unlock, true)
  }, [paneRoot, focusEligible, mayFocusNow])

  return locked
}
