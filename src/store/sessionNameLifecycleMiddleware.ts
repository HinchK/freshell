import type { Middleware } from '@reduxjs/toolkit'
import { setTabNameSource } from './tabsSlice.js'
import {
  collectNameSourceLeaves,
  isScopedNameSourceContent,
  nextTabNameSourceAfterSourceLoss,
  paneContentIdentity,
  resolveInitialTabNameSource,
} from '@/lib/tab-name-source'
import type { TabNameSource } from '@shared/session-names'
import type { PaneNode } from './paneTypes'
import type { RootState } from './store'
import { createLogger } from '@/lib/client-logger'

const log = createLogger('SessionNameLifecycle')

type TabLike = { id: string; nameSource?: TabNameSource }

/**
 * Unified agent names (Task 6) — the guarded cross-slice source-pointer
 * coordinator. ONE place applies the plan's "Stable tab ownership" rules to
 * `tab.nameSource` by comparing the ACTUAL pre/post layout state around
 * every store fold:
 *
 * - A session-owned tab's display is its source pane's canonical name.
 *   Focus, activity, split/add, and provider preference can never move the
 *   pointer; only a real content change at the source slot can.
 * - `swapPanes` swaps payloads at fixed pane ids: the pointer follows the
 *   source pane's CONTENT identity to its new pane id, and ONLY when the
 *   swap actually landed (a refused swap leaves the layout reference
 *   untouched, so the pointer never moves — the same guard covers refused
 *   closes).
 * - Losing the source (close/move, or its content becoming non-agent)
 *   applies the removal rule ONCE: the first remaining scoped leaf in
 *   depth-first left-to-right order, else `legacy`.
 * - A same-pane conversation replacement keeps the logical source and reads
 *   the new binding (the old identity is nowhere else in the layout).
 * - `undefined` pointers resolve exactly once, at the initial content
 *   choice (a picker stays unresolved; a later agent addition never claims
 *   ownership).
 *
 * The middleware dispatches its reconciliations synchronously inside the
 * action chain, and is registered INNER to the persistence/mirror
 * subscribers, so every flush reads an already-reconciled pointer.
 */
export const sessionNameLifecycleMiddleware: Middleware = (store) => (next) => (action) => {
  const previousState = store.getState() as RootState
  const result = next(action)
  const state = store.getState() as RootState

  const updates = reconcileTabNameSources(previousState, state)
  for (const update of updates) {
    store.dispatch(setTabNameSource(update))
  }
  return result
}

/** Name-source equality without importing deep-equal machinery. */
function sameNameSource(
  a: TabNameSource | undefined,
  b: TabNameSource | undefined,
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.kind === b.kind && (a.kind !== 'session' || b.kind !== 'session' || a.paneId === b.paneId)
}

type ReconcileUpdate = { tabId: string; nameSource: TabNameSource }

/**
 * Compare actual before/after layout state for every surviving tab and
 * derive the pointer transitions the contract requires. Tabs whose layout
 * reference did not change are skipped — that single gate is what makes a
 * REFUSED swap/close (no layout change) never move a pointer.
 */
function reconcileTabNameSources(
  previousState: RootState,
  state: RootState,
): ReconcileUpdate[] {
  const previousLayouts = (previousState.panes?.layouts ?? {}) as Record<string, PaneNode>
  const layouts = (state.panes?.layouts ?? {}) as Record<string, PaneNode>
  if (previousLayouts === layouts) return []

  const updates: ReconcileUpdate[] = []
  for (const tab of ((state.tabs?.tabs ?? []) as TabLike[])) {
    const previousLayout = previousLayouts[tab.id]
    const layout = layouts[tab.id]
    if (previousLayout === layout) continue
    const next = reconcileOne(tab.nameSource, previousLayout, layout)
    if (next !== undefined && !sameNameSource(next, tab.nameSource)) {
      updates.push({ tabId: tab.id, nameSource: next })
    }
  }
  if (updates.length > 0) {
    log.debug('reconciled tab name sources', {
      updates: updates.map((u) => ({ tabId: u.tabId, ...u.nameSource })),
    })
  }
  return updates
}

/** One tab's pointer transition, from its previous pointer + layouts. */
function reconcileOne(
  pointer: TabNameSource | undefined,
  previousLayout: PaneNode | undefined,
  layout: PaneNode | undefined,
): TabNameSource | undefined {
  // Legacy is terminal: the existing non-agent derivation owns the tab.
  if (pointer?.kind === 'legacy') return undefined

  if (!layout) {
    // The tab lost its whole layout while still existing: with no scoped
    // leaf left, the removal rule returns the tab to the legacy derivation.
    return pointer?.kind === 'session' && previousLayout ? { kind: 'legacy' } : undefined
  }

  if (pointer?.kind !== 'session') {
    // No pointer yet: resolve ownership exactly once, at the initial
    // content choice (a picker-first tab stays unresolved).
    return resolveInitialTabNameSource(layout)
  }

  const sourceId = pointer.paneId
  const leaves = collectNameSourceLeaves(layout)
  const atSource = leaves.find((leaf) => leaf.paneId === sourceId)

  if (!atSource || !isScopedNameSourceContent(atSource.content)) {
    // The source pane is gone, or its content is no longer a scoped agent
    // (a replace/attach). First check whether the original content actually
    // MOVED to another pane id — a swap — and follow it; only a content
    // identity that is nowhere in the new layout is truly lost.
    const previousAtSource = previousLayout
      ? collectNameSourceLeaves(previousLayout).find((leaf) => leaf.paneId === sourceId)
      : undefined
    const previousIdentity = previousAtSource && isScopedNameSourceContent(previousAtSource.content)
      ? paneContentIdentity(previousAtSource.content)
      : undefined
    const movedTo = previousIdentity
      ? leaves.find((leaf) =>
        leaf.paneId !== sourceId
        && isScopedNameSourceContent(leaf.content)
        && paneContentIdentity(leaf.content) === previousIdentity)
      : undefined
    if (movedTo) {
      return { kind: 'session', paneId: movedTo.paneId }
    }
    // Removal rule (once): the first remaining scoped leaf, else legacy.
    // The source pane itself is excluded when it still exists holding
    // non-agent content.
    return nextTabNameSourceAfterSourceLoss(layout, atSource ? sourceId : undefined)
  }

  // The source pane is present and scoped. A content IDENTITY change at the
  // source slot means either a swap (both panes hold scoped content — the
  // original identity now lives at the other id) or a same-pane
  // conversation replacement (the old identity is gone). Only the swap
  // moves the pointer; the replacement keeps the logical source.
  if (previousLayout) {
    const previousAtSource = collectNameSourceLeaves(previousLayout)
      .find((leaf) => leaf.paneId === sourceId)
    const previousIdentity = previousAtSource ? paneContentIdentity(previousAtSource.content) : undefined
    const currentIdentity = paneContentIdentity(atSource.content)
    if (previousIdentity && currentIdentity && previousIdentity !== currentIdentity) {
      const movedTo = leaves.find((leaf) =>
        leaf.paneId !== sourceId
        && isScopedNameSourceContent(leaf.content)
        && paneContentIdentity(leaf.content) === previousIdentity)
      if (movedTo) {
        return { kind: 'session', paneId: movedTo.paneId }
      }
      // Fall through: same-pane replacement keeps the pointer.
    }
  }
  return undefined
}
