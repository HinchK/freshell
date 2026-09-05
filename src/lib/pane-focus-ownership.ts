// Pane focus-ownership memory: an agent-driven leaf→split REMOUNTS the split
// pane's DOM subtree. Mount-time autofocus (terminal, browser root, editor,
// pickers, extension iframe) previously keyed only off Redux eligibility — so
// an agent split executed while the user was interacting with app chrome
// (sidebar, tab strip) yanked DOM focus back into the remounted pane.
//
// Pane-content components record, at unmount time, whether their pane OWNED
// document focus; their eligible-MOUNT focus then gates on this record.
// Explicit selects (false→true eligibility flips) bypass the gate entirely.
//
// Semantics: unknown pane ids (fresh creation, app reload w/ persisted layout)
// default to "may focus" — preserving the long-standing user-driven UX where
// creating a pane in the active tab focuses it.

const ownershipByPaneId = new Map<string, boolean>()

/** Record, at unmount time, whether the pane's subtree currently owns
 *  document focus. Reads the pane root by its `data-pane-id` attribute (the
 *  Pane wrapper carries it for every content type). MUST be called from a
 *  useLayoutEffect cleanup — passive-effect cleanups run after DOM detach.
 *  When no root is found (bare unit-test renders), nothing is recorded;
 *  unknown ids default to "may focus". */
export function recordPaneFocusBeforeUnmount(paneId: string): void {
  const root = document.querySelector(`[data-pane-id="${CSS.escape(paneId)}"]`)
  if (!root) return
  const active = document.activeElement
  ownershipByPaneId.set(paneId, Boolean(active && root.contains(active)))
  // Bound growth across long sessions (closed panes leave stale entries):
  // evict the OLDEST entries (Maps iterate in insertion order). Never wipe
  // the whole map — that would erase the record this very write just made,
  // letting the pane's immediate remount focus as "unknown".
  const CAP = 512
  if (ownershipByPaneId.size > CAP) {
    const evict = ownershipByPaneId.size - CAP
    let i = 0
    for (const key of ownershipByPaneId.keys()) {
      if (i++ >= evict) break
      ownershipByPaneId.delete(key)
    }
  }
}

/** Whether an eligible mount may pull DOM focus. Unknown pane ids (freshly
 *  created panes) focus as before; a remounted pane only re-focuses if it
 *  owned focus before its previous unmount. */
export function shouldFocusPaneOnEligibleMount(paneId: string): boolean {
  return ownershipByPaneId.get(paneId) !== false
}

/** Test-only helper: erase all remembered ownership. */
export function resetPaneFocusOwnershipForTests(): void {
  ownershipByPaneId.clear()
}
