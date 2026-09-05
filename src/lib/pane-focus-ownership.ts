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
   *  element, or null when none could be derived. ':scope' means the pane
   *  root itself held focus (the pane shell is tabbable). */
  selector: string | null
  /** Set while a mount-window restore for this pane is scheduled but has not
   *  fired. During that window a teardown must NOT overwrite the descriptor:
   *  the intermediate remount's own autofocus artifact (or blank focus) is
   *  in-flight, and the pre-split record is the only correct one. Cleared when
   *  the restore fires. */
  restorePending?: boolean
}

const recordByPaneId = new Map<string, PaneFocusRecord>()

/** Escape a value for use inside a quoted attribute selector. */
function attrValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Derive the most stable UNIQUELY-resolving selector for `el` within `root`.
 *  Candidate order: pane-root sentinel (`:scope`) → id → aria-label →
 *  data-testid → placeholder → role → sole-iframe → title → data-context.
 *  A candidate is only accepted when it matches exactly one element, so
 *  re-resolution after a remount can never land on a sibling. */
function describeInnerSelector(el: HTMLElement, root: Element): string | null {
  if (el === root) return ':scope'
  const tag = el.tagName.toLowerCase()
  const candidates: string[] = []
  if (el.id) candidates.push(`#${CSS.escape(el.id)}`)
  const ariaLabel = el.getAttribute('aria-label')
  if (ariaLabel) candidates.push(`${tag}[aria-label="${attrValue(ariaLabel)}"]`)
  const testId = el.getAttribute('data-testid')
  if (testId) candidates.push(`[data-testid="${attrValue(testId)}"]`)
  const placeholder = el.getAttribute('placeholder')
  if (placeholder) candidates.push(`${tag}[placeholder="${attrValue(placeholder)}"]`)
  const role = el.getAttribute('role')
  if (role) candidates.push(`${tag}[role="${attrValue(role)}"]`)
  // Embedded pages: a focused browser/extension iframe carries no other usable
  // attribute, and these panes host exactly one.
  if (tag === 'iframe' && root.querySelectorAll('iframe').length === 1) candidates.push('iframe')
  const title = el.getAttribute('title')
  if (title) candidates.push(`${tag}[title="${attrValue(title)}"]`)
  const dataContext = el.getAttribute('data-context')
  if (dataContext) candidates.push(`${tag}[data-context="${attrValue(dataContext)}"]`)
  for (const sel of candidates) {
    if (root.querySelectorAll(sel).length === 1 && root.querySelector(sel) === el) return sel
  }
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
  // An in-flight remount's restore owns the descriptor: the intermediate
  // subtree's focus is either blank or the remount's own autofocus artifact —
  // never the user. Burst splits (rapid sequential agent commands) must not
  // overwrite the pre-split record with it.
  const existing = recordByPaneId.get(paneId)
  if (existing?.restorePending) return
  const active = document.activeElement
  const owned = Boolean(active && root.contains(active))
  // LRU: refreshing an existing pane must move it to newest — `Map.set` on an
  // existing key keeps its original position, which would let a long-lived,
  // freshly re-recorded pane be evicted at the cap ahead of true ancients.
  if (recordByPaneId.has(paneId)) recordByPaneId.delete(paneId)
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
 *  focus, when no stable selector exists, when the pane is in a hidden tab,
 *  or when the element did not come back (e.g. transient UI like an open
 *  search bar — the content's default focus target stands in that case). */
export function resolveRecordedFocusTarget(paneId: string): HTMLElement | null {
  const record = recordByPaneId.get(paneId)
  if (!record?.owned || !record.selector) return null
  const root = document.querySelector(`[data-pane-id="${CSS.escape(paneId)}"]`)
  if (!root || root.closest('.tab-hidden')) return null
  const el = record.selector === ':scope' ? root : root.querySelector(record.selector)
  return el instanceof HTMLElement ? el : null
}

/** Schedule the mount-window restore for a pane: marks the record
 *  restore-pending (suppressing mid-burst descriptor overwrites), then after
 *  components' own mount focus ran (their passive/rAF focus runs first; this
 *  lands last) re-focuses the recorded element. Restore is governed by the
 *  RECORD, not the adoption gate: a pane that genuinely held DOM focus before
 *  teardown gets it back even when Redux focus eligibility says otherwise
 *  (e.g. the user Tabbed onto a Redux-inactive pane shell — Pane's shell is
 *  keyboard-focusable without changing activePane). Returns a cancel fn. */
export function schedulePaneFocusRestore(paneId: string): () => void {
  const record = recordByPaneId.get(paneId)
  if (record) record.restorePending = true
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const frame = requestAnimationFrame(() => {
    timer = setTimeout(() => {
      if (cancelled) return
      if (record) record.restorePending = false
      const el = resolveRecordedFocusTarget(paneId)
      if (el?.isConnected) el.focus()
    }, 0)
  })
  return () => {
    cancelled = true
    cancelAnimationFrame(frame)
    if (timer !== null) clearTimeout(timer)
  }
}

/** Test-only helper: erase all remembered ownership. */
export function resetPaneFocusOwnershipForTests(): void {
  recordByPaneId.clear()
}
