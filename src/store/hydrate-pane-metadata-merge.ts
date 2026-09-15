import type { PanesState, PaneNode } from './paneTypes'

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

  return { activePane, paneTitles, paneTitleSetByUser }
}
