import type { PanesState, PaneContent, PaneNode } from './paneTypes'
import { isScopedNameSourceContent } from '@/lib/tab-name-source'
import { stripScopedPaneTitleMetadata } from '@/lib/session-name-migration'

export type HydratePanesMeta = {
  localLayoutPersistedAt?: number
  remoteLayoutPersistedAt?: number
}

function collectLeafPaneIds(node: PaneNode): string[] {
  if (node.type === 'leaf') {
    return [node.id]
  }
  return [
    ...collectLeafPaneIds(node.children[0]),
    ...collectLeafPaneIds(node.children[1]),
  ]
}

/** Defensive leaf-id walk for RAW (unvalidated) incoming layouts: a
 * malformed split (e.g. missing children) yields no ids instead of
 * throwing — the full hydrate path never sees such trees (hydratePanes
 * normalizes first), but the title-only cross-window path reads the
 * incoming envelope's layouts directly. */
function collectLeafPaneIdsSafe(node: unknown): string[] {
  const ids: string[] = []
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object') return
    const record = candidate as { type?: unknown; id?: unknown; children?: unknown }
    if (record.type === 'leaf') {
      if (typeof record.id === 'string') ids.push(record.id)
      return
    }
    if (record.type === 'split' && Array.isArray(record.children)) {
      for (const child of record.children) visit(child)
    }
  }
  visit(node)
  return ids
}

function filterPaneMetadataByLayout<T>(
  metadata: Record<string, Record<string, T>> | undefined,
  tabId: string,
  paneIds: Set<string>,
): Record<string, T> | undefined {
  const tabMetadata = metadata?.[tabId]
  if (!tabMetadata) return undefined
  const filtered = Object.fromEntries(
    Object.entries(tabMetadata).filter(([paneId]) => paneIds.has(paneId)),
  )
  return Object.keys(filtered).length > 0 ? filtered : undefined
}

function pickHydratedActivePane(
  paneIds: string[],
  incomingActivePaneId: string | undefined,
  localActivePaneId: string | undefined,
): string | undefined {
  const paneIdSet = new Set(paneIds)
  if (incomingActivePaneId && paneIdSet.has(incomingActivePaneId)) {
    return incomingActivePaneId
  }
  if (localActivePaneId && paneIdSet.has(localActivePaneId)) {
    return localActivePaneId
  }
  return paneIds[paneIds.length - 1]
}

/** Tabs-style per-PANE title/flag reconcile — the `reconcileHydratedTabTitle`
 * analogue (tabsSlice.ts:137-142). A user-set title ALWAYS survives, and a
 * user-set flag never freezes the wrong text:
 *  - base side already user-set → it stands (covers both-user-set: the base
 *    is the recency/layout winner, so its title stands) with the flag true;
 *  - exactly one side user-set  → that side's title wins, flag true;
 *  - neither user-set           → the base side's title, flag = either side's flag. */
function reconcilePaneTitle(
  local: { title?: string; userSet?: boolean } | undefined,
  incoming: { title?: string; userSet?: boolean } | undefined,
  base: { title?: string; userSet?: boolean },
): { title?: string; userSet?: boolean } {
  if (base.userSet) return base
  const userSide = local?.userSet ? local : incoming?.userSet ? incoming : undefined
  if (userSide) return { title: userSide.title, userSet: true }
  return { title: base.title, userSet: !!(local?.userSet || incoming?.userSet) }
}

export function mergeHydratedPaneMetadata(
  state: PanesState,
  incoming: PanesState,
  layouts: Record<string, PaneNode>,
  incomingLayoutTabIds: Set<string>,
  meta?: HydratePanesMeta,
): Pick<PanesState, 'activePane' | 'paneTitles' | 'paneTitleSetByUser'> {
  const activePane: Record<string, string> = {}
  const paneTitles: Record<string, Record<string, string>> = {}
  const paneTitleSetByUser: Record<string, Record<string, boolean>> = {}

  // Tabs winner pattern (tabsSlice.ts pickHydratedTabWinner :115-128) for the
  // TITLE BASE — the SAME coalesced comparison the tabs path uses, not a
  // both-must-be-number rule: meta counts as present when EITHER timestamp
  // is a number, and a KNOWN remote beats a MISSING local (a newly received
  // tab's incoming metadata applies) while a numeric tie keeps LOCAL
  // (conservative — never clobber on ambiguity). No meta (or neither
  // timestamp numeric) → legacy behavior (the incoming side is the base
  // when the incoming layout won).
  const metaPresent =
    meta !== undefined &&
    (typeof meta.remoteLayoutPersistedAt === 'number' || typeof meta.localLayoutPersistedAt === 'number')
  const remoteStrictlyNewer = metaPresent
    ? (meta!.remoteLayoutPersistedAt ?? Number.NEGATIVE_INFINITY) >
      (meta!.localLayoutPersistedAt ?? Number.NEGATIVE_INFINITY)
    : false

  for (const [tabId, layout] of Object.entries(layouts)) {
    const paneIds = collectLeafPaneIds(layout)
    const paneIdSet = new Set(paneIds)
    const localLayoutPreserved = !incomingLayoutTabIds.has(tabId)
    const incomingIsBase = !metaPresent
      ? !localLayoutPreserved                        // legacy: incoming layout won → incoming base
      : !localLayoutPreserved && remoteStrictlyNewer // recency-guarded: an older remote is never the base

    const localTabTitles = filterPaneMetadataByLayout(state.paneTitles, tabId, paneIdSet)
    const incomingTabTitles = filterPaneMetadataByLayout(incoming.paneTitles, tabId, paneIdSet)
    const localTabFlags = filterPaneMetadataByLayout(state.paneTitleSetByUser, tabId, paneIdSet)
    const incomingTabFlags = filterPaneMetadataByLayout(incoming.paneTitleSetByUser, tabId, paneIdSet)
    const baseTabTitles = incomingIsBase
      ? (incomingTabTitles ?? localTabTitles)
      : localTabTitles
    const baseTabFlags = incomingIsBase ? incomingTabFlags : localTabFlags

    const nextActivePane = pickHydratedActivePane(
      paneIds,
      localLayoutPreserved ? undefined : incoming.activePane?.[tabId],
      state.activePane?.[tabId],
    )
    if (nextActivePane) {
      activePane[tabId] = nextActivePane
    }

    const nextTabTitles: Record<string, string> = {}
    const nextTabFlags: Record<string, boolean> = {}
    for (const paneId of paneIds) {
      const localTitle = localTabTitles?.[paneId]
      const incomingTitle = incomingTabTitles?.[paneId]
      const localFlag = localTabFlags !== undefined && paneId in localTabFlags
        ? localTabFlags[paneId]
        : undefined
      const incomingFlag = incomingTabFlags !== undefined && paneId in incomingTabFlags
        ? incomingTabFlags[paneId]
        : undefined
      const reconciled = reconcilePaneTitle(
        { title: localTitle, userSet: localFlag },
        { title: incomingTitle, userSet: incomingFlag },
        { title: baseTabTitles?.[paneId], userSet: baseTabFlags !== undefined && paneId in baseTabFlags
          ? baseTabFlags[paneId]
          : undefined },
      )
      if (reconciled.title !== undefined) {
        nextTabTitles[paneId] = reconciled.title
      }
      if (localFlag !== undefined || incomingFlag !== undefined || reconciled.userSet) {
        nextTabFlags[paneId] = !!reconciled.userSet
      }
    }
    if (Object.keys(nextTabTitles).length > 0) {
      paneTitles[tabId] = nextTabTitles
    }
    if (Object.keys(nextTabFlags).length > 0) {
      paneTitleSetByUser[tabId] = nextTabFlags
    }
  }

  // Unified agent names (Task 7): the merge output passes the ONE client
  // sanitizer — a scoped agent pane's title/flag is a retired legacy alias
  // (the canonical server record owns the name), so no hydrate path may
  // ever install or retain one.
  const sanitized = stripScopedPaneTitleMetadata(layouts, paneTitles, paneTitleSetByUser)
  return { activePane, ...sanitized }
}

/** Deep-equality for one pane-title metadata record (primitive leaves):
 * same tab keys, same per-tab pane keys, same values. `undefined` and
 * an absent record are equal (an empty merge result equals an empty
 * current record). */
function paneTitleRecordsEqual<T>(
  a: Record<string, Record<string, T>> | undefined,
  b: Record<string, Record<string, T>> | undefined,
): boolean {
  const aTabIds = Object.keys(a ?? {})
  const bTabIds = Object.keys(b ?? {})
  if (aTabIds.length !== bTabIds.length) return false
  for (const tabId of aTabIds) {
    if (!b || !(tabId in b)) return false
    const aTab = a?.[tabId]
    const bTab = b[tabId]
    const aPaneIds = Object.keys(aTab ?? {})
    const bPaneIds = Object.keys(bTab ?? {})
    if (aPaneIds.length !== bPaneIds.length) return false
    for (const paneId of aPaneIds) {
      if (!bTab || !(paneId in bTab)) return false
      if (aTab![paneId] !== bTab[paneId]) return false
    }
  }
  return true
}

/** Equal-result churn guard (e3r3 finding 1): true when a cross-window
 * title merge produced EXACTLY the pane titles and user-set flags the
 * state already holds. hydratePaneTitles uses this to leave the state
 * reference untouched, so persistMiddleware sees no panes change and a
 * receiver that already has the delivered title never re-flushes — the
 * convergence that makes the durable title apply safe without an echo
 * loop. */
export function paneTitleMetadataEquals(
  a: Pick<PanesState, 'paneTitles' | 'paneTitleSetByUser'>,
  b: Pick<PanesState, 'paneTitles' | 'paneTitleSetByUser'>,
): boolean {
  return paneTitleRecordsEqual(a.paneTitles, b.paneTitles)
    && paneTitleRecordsEqual(a.paneTitleSetByUser, b.paneTitleSetByUser)
}

/**
 * Unified agent names (Task 6): the local scoped pane ids of one tab — the
 * panes whose display/name is owned by the canonical session-names authority.
 * A stale foreign-window envelope's user-set flags (a pre-Task-5 rename)
 * must never freeze those panes' names, so the title-only cross-window merge
 * delivers nothing to them.
 */
function localScopedPaneIds(localLayout: unknown): Set<string> {
  const ids = new Set<string>()
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object') return
    const record = candidate as { type?: unknown; id?: unknown; content?: unknown; children?: unknown }
    if (record.type === 'leaf') {
      if (
        typeof record.id === 'string'
        && record.content
        && typeof record.content === 'object'
        && isScopedNameSourceContent(record.content as PaneContent)
      ) {
        ids.add(record.id)
      }
      return
    }
    if (record.type === 'split' && Array.isArray(record.children)) {
      for (const child of record.children) visit(child)
    }
  }
  visit(localLayout)
  return ids
}

/** TITLE-ONLY cross-window reconciliation (e3r1 finding 4): another
 * window's layout event may never adopt tabs, trees, content, active
 * panes, or ephemeral pane state — only pane TITLES flow across windows,
 * under the same recency + user-set rules the full merge's title half
 * uses (reconcilePaneTitle). Scoped to panes that exist in BOTH envelopes
 * (local layout AND incoming layout); an incoming side with no title for
 * a shared pane delivers nothing (the local entry stands verbatim — the
 * path delivers titles, it never erases them). The incoming base applies
 * only when the incoming layout is STRICTLY newer (layout persistedAt
 * meta); unknown-age incoming is never the base. A scoped agent pane
 * receives NOTHING from a foreign window (Task 6): its user-set flags and
 * titles are stale aliases of a canonical name, never a live freeze. */
export function mergeCrossWindowPaneTitles(
  state: PanesState,
  incoming: Pick<PanesState, 'paneTitles' | 'paneTitleSetByUser'>,
  incomingLayouts: Record<string, unknown>,
  meta?: HydratePanesMeta,
): Pick<PanesState, 'paneTitles' | 'paneTitleSetByUser'> {
  const paneTitles: Record<string, Record<string, string>> = {}
  const paneTitleSetByUser: Record<string, Record<string, boolean>> = {}

  const metaPresent =
    meta !== undefined &&
    (typeof meta.remoteLayoutPersistedAt === 'number' || typeof meta.localLayoutPersistedAt === 'number')
  const incomingIsBase = metaPresent
    ? (meta!.remoteLayoutPersistedAt ?? Number.NEGATIVE_INFINITY) >
      (meta!.localLayoutPersistedAt ?? Number.NEGATIVE_INFINITY)
    : false

  for (const [tabId, localLayout] of Object.entries(state.layouts)) {
    const localPaneIds = collectLeafPaneIds(localLayout)
    const paneIdSet = new Set(localPaneIds)
    const scopedPaneIds = localScopedPaneIds(localLayout)
    const incomingLayout = incomingLayouts[tabId]
    const incomingPaneIdSet = incomingLayout !== undefined && incomingLayout !== null
      ? new Set(collectLeafPaneIdsSafe(incomingLayout))
      : undefined

    const localTabTitles = filterPaneMetadataByLayout(state.paneTitles, tabId, paneIdSet)
    const localTabFlags = filterPaneMetadataByLayout(state.paneTitleSetByUser, tabId, paneIdSet)
    const incomingTabTitles = incomingPaneIdSet
      ? filterPaneMetadataByLayout(incoming.paneTitles, tabId, paneIdSet)
      : undefined
    const incomingTabFlags = incomingPaneIdSet
      ? filterPaneMetadataByLayout(incoming.paneTitleSetByUser, tabId, paneIdSet)
      : undefined

    const nextTabTitles: Record<string, string> = {}
    const nextTabFlags: Record<string, boolean> = {}
    for (const paneId of localPaneIds) {
      const localTitle = localTabTitles?.[paneId]
      const localFlag = localTabFlags !== undefined && paneId in localTabFlags
        ? localTabFlags[paneId]
        : undefined
      const sharedWithIncoming = incomingPaneIdSet?.has(paneId) ?? false
      const incomingTitle = sharedWithIncoming ? incomingTabTitles?.[paneId] : undefined
      const incomingFlag = sharedWithIncoming && incomingTabFlags !== undefined && paneId in incomingTabFlags
        ? incomingTabFlags[paneId]
        : undefined
      if (incomingTitle === undefined || scopedPaneIds.has(paneId)) {
        // No delivery for this pane — or a scoped agent pane (Task 7): a
        // foreign window may never freeze its title/flags AND the local
        // entry is a retired legacy alias (the canonical server record
        // owns the name) — it contributes nothing either way.
        if (scopedPaneIds.has(paneId)) continue
        if (localTitle !== undefined) nextTabTitles[paneId] = localTitle
        if (localFlag !== undefined) nextTabFlags[paneId] = localFlag
        continue
      }
      const reconciled = reconcilePaneTitle(
        { title: localTitle, userSet: localFlag },
        { title: incomingTitle, userSet: incomingFlag },
        incomingIsBase
          ? { title: incomingTitle, userSet: incomingFlag }
          : { title: localTitle, userSet: localFlag },
      )
      if (reconciled.title !== undefined) {
        nextTabTitles[paneId] = reconciled.title
      }
      if (localFlag !== undefined || incomingFlag !== undefined || reconciled.userSet) {
        nextTabFlags[paneId] = !!reconciled.userSet
      }
    }
    if (Object.keys(nextTabTitles).length > 0) {
      paneTitles[tabId] = nextTabTitles
    }
    if (Object.keys(nextTabFlags).length > 0) {
      paneTitleSetByUser[tabId] = nextTabFlags
    }
  }

  return { paneTitles, paneTitleSetByUser }
}
