// Pane focus-ownership memory: an agent-driven leaf→split REMOUNTS the split
// pane's DOM subtree. Mount-time autofocus (terminal, browser root, editor,
// pickers, extension iframe) previously keyed only off Redux eligibility — so
// an agent split executed while the user was interacting with app chrome
// (sidebar, tab strip) yanked DOM focus back into the remounted pane.
//
// Pane-content components record, at unmount time, whether their pane OWNED
// document focus — and, when it did, a best-effort stable selector for the
// exact element that held it (URL field, search input, composer). Their
// eligible-MOUNT focus then gates on this record, and the recorded element is
// re-resolved and refocused after the component's own mount focus ran, so a
// legitimate re-adoption restores the user's ACTUAL focus target instead of
// the content's default. Explicit selects (false→true eligibility flips and
// same-target epoch bumps) bypass the gate entirely.
//
// Semantics: unknown pane ids (fresh creation, app reload w/ persisted layout)
// default to "may focus" — preserving the long-standing user-driven UX where
// creating a pane in the active tab focuses it.
//
// Transient in-pane UI (an open terminal search bar, an in-progress pane
// rename) does not survive a leaf→split remount at all — that is pre-existing
// remount parity, identical for user-driven splits; the descriptor restore
// covers only elements that re-render on remount.

export interface PaneFocusRecord {
  owned: boolean
  /** Best-effort stable selector (within the pane root) for the focused
   *  element, or null when none could be derived. */
  selector: string | null
}

const recordByPaneId = new Map<string, PaneFocusRecord>()

/** Escape a value for use inside a quoted attribute selector. */
function attrValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Derive the most stable selector for `el` that re-resolves within `root`. */
function describeInnerSelector(el: HTMLElement, root: Element): string | null {
  const tag = el.tagName.toLowerCase()
  if (el.id) {
    const sel = `#${CSS.escape(el.id)}`
    if (root.querySelector(sel) === el) return sel
  }
  const ariaLabel = el.getAttribute('aria-label')
  if (ariaLabel) return `${tag}[aria-label="${attrValue(ariaLabel)}"]`
  const testId = el.getAttribute('data-testid')
  if (testId) return `[data-testid="${attrValue(testId)}"]`
  const placeholder = el.getAttribute('placeholder')
  if (placeholder) return `${tag}[placeholder="${attrValue(placeholder)}"]`
  const role = el.getAttribute('role')
  if (role) return `${tag}[role="${attrValue(role)}"]`
  return null
}

/** Record, at unmount time, whether the pane's subtree currently owns
 *  document focus (and which element holds it). Reads the pane root by its
 *  `data-pane-id` attribute (the Pane wrapper carries it for every content
 *  type). MUST be called from a useLayoutEffect cleanup — passive-effect
 *  cleanups run after DOM detach. When no root is found (bare unit-test
 *  renders), nothing is recorded; unknown ids default to "may focus". */
export function recordPaneFocusBeforeUnmount(paneId: string): void {
  const root = document.querySelector(`[data-pane-id="${CSS.escape(paneId)}"]`)
  if (!root) return
  const active = document.activeElement
  const owned = Boolean(active && root.contains(active))
  recordByPaneId.set(paneId, {
    owned,
    selector: owned && active instanceof HTMLElement ? describeInnerSelector(active, root) : null,
  })
  // Bound growth across long sessions (closed panes leave stale entries):
  // evict the OLDEST entries (Maps iterate in insertion order). Never wipe
  // the whole map — that would erase the record this very write just made.
  const CAP = 512
  if (recordByPaneId.size > CAP) {
    const evict = recordByPaneId.size - CAP
    let i = 0
    for (const key of recordByPaneId.keys()) {
      if (i++ >= evict) break
      recordByPaneId.delete(key)
    }
  }
}

/** Whether an eligible mount may pull DOM focus. Unknown pane ids (freshly
 *  created panes) focus as before; a remounted pane only re-focuses if it
 *  owned focus before its previous unmount. */
export function shouldFocusPaneOnEligibleMount(paneId: string): boolean {
  return recordByPaneId.get(paneId)?.owned !== false
}

/** Post-mount restore: re-resolve the recorded inner element inside the
 *  pane's NEW subtree. Returns null when the pane was not recorded as owning
 *  focus, when no stable selector exists, or when the element did not come
 *  back (e.g. transient UI like an open search bar — the content's default
 *  focus target stands in that case). */
export function resolveRecordedFocusTarget(paneId: string): HTMLElement | null {
  const record = recordByPaneId.get(paneId)
  if (!record?.owned || !record.selector) return null
  const root = document.querySelector(`[data-pane-id="${CSS.escape(paneId)}"]`)
  const el = root?.querySelector(record.selector)
  return el instanceof HTMLElement ? el : null
}

/** Test-only helper: erase all remembered ownership. */
export function resetPaneFocusOwnershipForTests(): void {
  recordByPaneId.clear()
}
