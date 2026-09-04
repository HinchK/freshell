// Focus-steal rebuff for non-eligible iframe panes (browser / extension).
//
// Web platform reality (verified empirically in Chromium, Aug 2026):
// `inert` on an iframe blocks sequential-focus entry, pointer hit testing
// AND outer-side programmatic focus — but a SCRIPT INSIDE the nested
// document can still hoist the iframe into the outer document's
// activeElement. No attribute combination (inert, tabindex=-1, sandbox
// w/ or w/o allow-same-origin, inert ancestor) stops that. The hoist is
// event-silent on the winning side (no focus/focusin on the iframe), but
// the displaced element DOES fire focusout (when it was an element) and the
// window fires blur (covers the displaced-is-body case). Also verified:
// calling blur() on the hoisted iframe restores control.
//
// So: panes whose `focusEligible` is false render their iframe with both
// `inert` (blocks pointer/sequential/outer-programmatic entry) AND
// `data-focus-locked` (this guard's marker). When focus lands on a locked
// iframe we blur it and restore focus to the element it displaced.

const LOCKED_ATTR = 'data-focus-locked'

function isLockedIframe(el: Element | null): el is HTMLIFrameElement {
  return !!el && el.tagName === 'IFRAME' && el.hasAttribute(LOCKED_ATTR)
}

/**
 * Install the rebuff listener pair. Returns a disposer. Idempotent with
 * respect to callers (one instance per app via useFocusStealGuard).
 *
 * focusout: element displaced by a hoist. window blur: body was active.
 * The activeElement reassignment is mid-flight during dispatch, so the
 * check runs after a task — deterministic in Chromium and jsdom alike.
 */
export function installFocusStealGuard(): () => void {
  const rebuff = (displaced: HTMLElement | null) => {
    setTimeout(() => {
      const active = document.activeElement
      if (!isLockedIframe(active)) return
      active.blur()
      if (displaced && document.contains(displaced)) {
        displaced.focus()
      } else {
        document.body.focus?.()
      }
    }, 0)
  }

  const onFocusOut = (e: FocusEvent) => {
    rebuff(e.target instanceof HTMLElement ? e.target : null)
  }
  const onWindowBlur = () => {
    rebuff(null)
  }

  document.addEventListener('focusout', onFocusOut)
  window.addEventListener('blur', onWindowBlur)
  return () => {
    document.removeEventListener('focusout', onFocusOut)
    window.removeEventListener('blur', onWindowBlur)
  }
}
