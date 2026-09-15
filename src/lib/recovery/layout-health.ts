import { parsePersistedLayoutRaw, type ParsedPersistedLayout } from '@/store/persistedState'
import { isWellFormedPaneTree } from '@/store/paneTreeValidation'
import { LAYOUT_STORAGE_KEY } from '@/store/storage-keys'

/** A local layout older than this rebuilds from the server instead of being
 * kept. 7 days is far beyond any terminal lifetime (15-minute default idle
 * timeout), so it only triggers for genuinely abandoned layouts. */
export const STALE_LAYOUT_MS = 7 * 24 * 60 * 60 * 1000

export type PersistedLayoutHealth = 'absent' | 'corrupt' | 'foreign' | 'stale' | 'healthy'

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

/** Leaf pane ids of a (already well-formedness-checked) layout tree.
 * Module-local: paneTreeValidation.ts exports no leaf collector (only
 * hasPaneTreeShape :127, isWellFormedPaneTree :133, validatePaneTree :141),
 * and panesSlice's collectLeaves/collectLeafPaneIds are module-private. */
function collectLeafIdsOf(node: unknown, into: Set<string> = new Set()): Set<string> {
  const n = node as { type?: string; id?: string; children?: unknown[] } | null
  if (!n || typeof n !== 'object') return into
  if (n.type === 'leaf') {
    if (typeof n.id === 'string') into.add(n.id)
    return into
  }
  for (const child of n.children ?? []) collectLeafIdsOf(child, into)
  return into
}

/** Leaf pane contents by pane id of a (possibly raw, unvalidated) layout
 * tree — only leaves whose content is a plain object contribute. Used by
 * the content-salvage check to pair RAW and PARSED leaf contents. */
function collectLeafContents(node: unknown, into: Map<string, Record<string, unknown>>): void {
  const n = node as { type?: string; id?: string; content?: unknown; children?: unknown[] } | null
  if (!n || typeof n !== 'object') return
  if (n.type === 'leaf') {
    if (typeof n.id === 'string' && !!n.content && typeof n.content === 'object' && !Array.isArray(n.content)) {
      into.set(n.id, n.content as Record<string, unknown>)
    }
    return
  }
  if (!Array.isArray(n.children)) return
  for (const child of n.children) collectLeafContents(child, into)
}

/** Parse-side migrations that deliberately DROP a raw content key while
 * carrying its durable value into another parsed key — verified against
 * the loader (persistedState.ts):
 * - resumeSessionId (terminal + fresh-agent): destructured out and never
 *   re-added (persistedState.ts:238, :307-315); its durable value lands in
 *   parsed sessionRef via migrateLegacyTerminalDurableState
 *   (persistedState.ts:231-261, shared/session-contract.ts:115-158).
 *   Current flushes never write it (stripTransientSessionFields,
 *   persistMiddleware.ts:261), so a raw resumeSessionId is legacy-only —
 *   its drop is migration, not salvage.
 * - model (freshopencode fresh-agent): migrated into modelSelection and
 *   the raw key dropped (persistedState.ts:316-333) — and a LEGITIMATE
 *   current flush DOES write model alongside modelSelection
 *   (FreshAgentModelDialog.tsx:348-372), so without this exemption a
 *   healthy model-pinned pane would misclassify corrupt.
 * Every other raw-key drop is silent salvage of a malformed durable field
 * — corruption by definition. */
function isParseMigratedContentKey(content: Record<string, unknown>, key: string): boolean {
  if (key === 'resumeSessionId') return true
  return key === 'model'
    && content.kind === 'fresh-agent'
    && content.sessionType === 'freshopencode'
    && content.provider === 'opencode'
}

/** Content-salvage detection (delta review round 2, finding 3): the
 * classifier's tree checks all validate the SANITIZED parse result, but
 * parsePersistedLayoutRaw silently strips malformed durable pane-content
 * fields BEFORE tree validation — e.g. a terminal sessionRef that fails
 * sanitizeSessionRef is destructured out and only re-added when
 * migrateLegacyTerminalDurableState accepts it (normalizeTerminalContent,
 * persistedState.ts:231-261), so the pane rehydrates WITHOUT its durable
 * identity while every tree-level check passes and the pane reopens as a
 * FRESH session. Pair RAW and PARSED leaf contents by pane id: any
 * top-level raw content key the parsed content dropped (outside the
 * verified migration set above) means the loader will silently discard
 * durable data → corruption. Parsed may have MORE keys (normalization
 * adds sessionRef/codexDurability/restoreError/modelSelection) — the rule
 * is raw-keys ⊆ parsed-keys. Legit current flushes never produce a
 * dropped key: in-memory content is normalized on every write path
 * (normalizePaneContent, panesSlice.ts:60-108 — sessionRef via
 * sanitizeSessionRef :72, codexDurability :73, restoreError :74) and the
 * flush strips the volatile keys the parse also drops
 * (persistMiddleware.ts:255-285). */
function hasSalvagedLeafContent(
  rawEnvelope: { panes?: { layouts?: unknown } } | undefined,
  parsed: ParsedPersistedLayout,
): boolean {
  const rawLayouts = rawEnvelope?.panes?.layouts
  if (!rawLayouts || typeof rawLayouts !== 'object') return false
  const rawLeafContents = new Map<string, Record<string, unknown>>()
  for (const node of Object.values(rawLayouts as Record<string, unknown>)) {
    collectLeafContents(node, rawLeafContents)
  }
  if (rawLeafContents.size === 0) return false
  const parsedLeafContents = new Map<string, Record<string, unknown>>()
  for (const node of Object.values(parsed.panes?.layouts ?? {})) {
    collectLeafContents(node, parsedLeafContents)
  }
  for (const [paneId, rawContent] of rawLeafContents) {
    const parsedContent = parsedLeafContents.get(paneId)
    if (!parsedContent) continue
    const parsedKeys = new Set(Object.keys(parsedContent))
    for (const key of Object.keys(rawContent)) {
      if (parsedKeys.has(key)) continue
      if (isParseMigratedContentKey(rawContent, key)) continue
      return true
    }
  }
  return false
}

/** Aliased-identity check over a (already well-formedness-checked) tree:
 * EVERY node id — split ids AND leaf ids — must be non-empty and unique
 * across the envelope (pane and split ids are minted from the same
 * globally-unique nanoid space, so legit flushes can never alias; any
 * duplication is corruption by definition). The renderer throws on
 * duplicate split ids (collectSurfaceOrder, pane-surface-layout.ts:47)
 * and duplicate leaf ids (collectSurfaceLeaves :23), so an aliased
 * envelope would otherwise classify healthy and strand the tab in its
 * error boundary. Runs after isWellFormedPaneTree, so ids are strings
 * here; a non-string still classifies aliased rather than trusting the
 * caller. */
function hasAliasedNodeIds(node: unknown, seenIds: Set<string>): boolean {
  const n = node as { type?: string; id?: string; children?: unknown[] } | null
  if (!n || typeof n !== 'object') return false
  const id = n.id
  if (typeof id !== 'string' || id === '' || seenIds.has(id)) return true
  seenIds.add(id)
  if (n.type === 'leaf') return false
  for (const child of n.children ?? []) {
    if (hasAliasedNodeIds(child, seenIds)) return true
  }
  return false
}

/** Classify the persisted layout envelope for the machine this boot
 * resolved. Reads only localStorage; no network.
 *
 * - absent:   nothing usable is persisted.
 * - corrupt:  the envelope exists but does not parse, parse-level salvage
 *             dropped invalid tab rows, content-level salvage silently
 *             stripped a durable pane-content field (a raw leaf content
 *             key the parsed result dropped, outside the verified
 *             migration set — see hasSalvagedLeafContent), a layout tree
 *             is malformed,
 *             identities are aliased (a duplicate tab id, or a duplicate
 *             or empty node id — split or leaf; legit flushes mint unique
 *             non-empty ids, so aliases are corruption by definition),
 *             referential integrity is broken (a layout entry without its
 *             tab, or a tab without its layout entry), or an active
 *             reference is missing/dangling (activeTabId not a parsed tab
 *             while tabs are non-empty; activePane[tabId] absent or not a
 *             leaf of that tab's layout).
 * - foreign: IFF the envelope is STAMPED and the stamp names a different
 *            machine. An unstamped envelope is legacy (pre-stamp) data
 *            assumed local — it can NEVER classify foreign, so a
 *            same-machine chooser re-pick keeps a healthy unstamped
 *            layout; Task 2's stamp backfill makes unstamped a one-boot
 *            transitional state.
 *            Accepted migration residual: a pre-migration envelope that
 *            actually belonged to a different machine (an origin remap
 *            before the first boot of this code) is mis-kept for one boot
 *            under this rule; the backfill then stamps it with the
 *            resolved machine id, so every later boot classifies correctly.
 * - stale:   older than STALE_LAYOUT_MS.
 * - healthy: everything else — the window keeps its local layout. */
export function classifyPersistedLayoutHealth(
  resolvedMachineId: string,
  opts: { now?: number; storage?: Storage } = {},
): PersistedLayoutHealth {
  const storage = opts.storage ?? safeStorage()
  const now = opts.now ?? Date.now()
  let raw: string | null = null
  try {
    raw = storage?.getItem(LAYOUT_STORAGE_KEY) ?? null
  } catch {
    return 'absent'
  }
  if (raw === null) return 'absent'
  let parsed: ParsedPersistedLayout | null = null
  try {
    parsed = parsePersistedLayoutRaw(raw)
  } catch {
    parsed = null
  }
  if (!parsed) return 'corrupt'
  // A shallowly-parsed envelope whose layout trees fail the loader's
  // well-formedness predicate would rehydrate as DEFAULT panes (the load
  // path drops malformed trees), silently losing the saved layout — that is
  // a corrupt layout, not a healthy one. Same predicate the loader uses
  // (paneTreeValidation.ts). Pane CONTENT payload sanitization is
  // classified too — by the raw-vs-parsed pairing below
  // (hasSalvagedLeafContent), which catches a durable field the parse
  // silently strips even though the sanitized result passes this
  // well-formedness predicate (delta review round 2, finding 3).
  // Aliased identities (duplicate or empty node ids — split or leaf —
  // across the envelope's trees) classify corrupt for the same reason:
  // the raw-count/membership/active-reference checks below all PASS on
  // aliased ids, and the zod layouts schema passes trees through as
  // z.unknown while paneTreeValidation only checks typeof id === 'string'
  // — so without this check a corrupt-cache state classifies healthy.
  const seenNodeIds = new Set<string>()
  for (const layout of Object.values(parsed.panes?.layouts ?? {})) {
    if (!isWellFormedPaneTree(layout)) return 'corrupt'
    if (hasAliasedNodeIds(layout, seenNodeIds)) return 'corrupt'
  }
  // Parse-level salvage drops rows SILENTLY (persistedState.ts salvageTabs
  // :88-102 — one structurally-invalid tab is dropped while the rest parse),
  // so a parsed result can be healthy-looking while the loader actually
  // discarded part of the workspace. One extra JSON.parse of the same raw
  // tells us how many tabs the loader SAW; if the parsed result kept fewer,
  // salvage dropped rows → corrupt. The same raw envelope also feeds the
  // content-salvage check below.
  let rawEnvelope: { tabs?: { tabs?: unknown[] }; panes?: { layouts?: unknown } } | undefined
  try {
    rawEnvelope = JSON.parse(raw)
  } catch {
    rawEnvelope = undefined   // unreachable here: JSON.parse already succeeded inside parsePersistedLayoutRaw
  }
  const rawTabCount = Array.isArray(rawEnvelope?.tabs?.tabs) ? rawEnvelope.tabs.tabs.length : undefined
  if (rawTabCount !== undefined && rawTabCount !== (parsed.tabs?.tabs?.length ?? 0)) {
    return 'corrupt'
  }
  // Content-salvage: a durable pane-content field the parse silently
  // strips (tree checks pass on the sanitized result) is corruption — the
  // pane would rehydrate without its durable identity. See
  // hasSalvagedLeafContent for the pairing rule and the verified
  // migration exemptions.
  if (hasSalvagedLeafContent(rawEnvelope, parsed)) return 'corrupt'
  // Referential integrity, BOTH directions — verified against the actual
  // loaders: a layout entry whose tabId is not among the parsed tabs is
  // DROPPED at load (cleanOrphanedLayouts, panesSlice.ts:328-371, called
  // from loadInitialPanesState at :418), and a tab whose id has NO layout
  // entry gets a RECONSTRUCTED default pane on mount (PaneLayout.tsx:18-27:
  // the mount effect dispatches initLayout with TabContent's defaultContent
  // when s.panes.layouts[tabId] is missing). Either way the saved
  // arrangement is silently lost — corrupt, not healthy. Accepted residual:
  // a flush landing in the transient window between addTab and its
  // initLayout classifies 'corrupt' and forces a rebuild; that path is safe
  // (upgrade 1 rebuilds from the window's own snapshot with preserved ids).
  // Tab ids must be unique: duplicates survive zTab parsing (z.array does
  // not reject them) and every other check below passes on aliased ids, but
  // the in-memory writers mint tab ids uniquely (nanoid in tabsSlice's
  // addTab/hydrateTabs paths), so a duplicate is corruption by definition.
  // Empty tab ids are unreachable here (zTab requires min(1), so salvage
  // drops the row and the raw-count check above classifies it).
  const parsedTabIds = new Set<string>()
  for (const t of parsed.tabs?.tabs ?? []) {
    const id = (t as { id?: unknown })?.id
    if (typeof id !== 'string') continue
    if (parsedTabIds.has(id)) return 'corrupt'
    parsedTabIds.add(id)
  }
  const layoutTabIds = Object.keys(parsed.panes?.layouts ?? {})
  for (const layoutTabId of layoutTabIds) {
    if (!parsedTabIds.has(layoutTabId)) return 'corrupt'
  }
  for (const tabId of parsedTabIds) {
    if (!layoutTabIds.includes(tabId)) return 'corrupt'
  }
  const tabCount = parsed.tabs?.tabs?.length ?? 0
  const paneCount = Object.keys(parsed.panes?.layouts ?? {}).length
  if (tabCount === 0 && paneCount === 0) return 'absent'
  // Active-reference validation (non-empty tabs). Persisted shape verified
  // against the real writer/reader: activeTabId lives at tabs.activeTabId
  // (persistMiddleware.ts:634 writes `state.tabs?.activeTabId ?? null`;
  // persistedState.ts:545 reads it back), and activePane lives at
  // panes.activePane as Record<tabId, paneId> (flushed inside the state.panes
  // spread at persistMiddleware.ts:608-628; read at persistedState.ts:551).
  // A legitimate flush NEVER produces a non-empty-tabs envelope without both
  // references: every in-memory writer keeps them valid — tabsSlice removeTab
  // re-points activeTabId to a surviving tab (tabsSlice.ts:363-371) and
  // hydrateTabs re-points to a merged tab (:427-435); panesSlice initLayout
  // sets activePane[tabId] to the layout's leaf (:1242), restoreLayout via
  // findFirstLeafId (:1258), resetLayout (:1280), splitPane (:1411), addPane
  // (:1502), closePane re-points to a surviving sibling leaf (:1466-1476),
  // cleanOrphanedLayouts removes entries with their layouts (:325-371), and
  // the hydrate merge validates candidates against the layout's leaf ids
  // (pickHydratedActivePane, :599-606). The zod schema fields are optional
  // only for legacy tolerance (persistedState.ts:52/:218) — v2/v3 writers
  // always maintained the invariant. The loaders do NOT heal loudly: an
  // invalid activeTabId is SILENTLY replaced with the first tab
  // (tabsSlice.ts:260-265) and activePane loads through unvalidated
  // (panesSlice.ts:402), so a damaged envelope would otherwise classify
  // healthy and silently lose the saved focus. Missing or dangling → corrupt.
  if (tabCount > 0) {
    const activeTabId = parsed.tabs?.activeTabId
    if (typeof activeTabId !== 'string' || !parsedTabIds.has(activeTabId)) return 'corrupt'
    for (const tabId of parsedTabIds) {
      const activePaneId = parsed.panes?.activePane?.[tabId]
      if (typeof activePaneId !== 'string') return 'corrupt'
      const layout = parsed.panes?.layouts?.[tabId]
      if (!layout || !collectLeafIdsOf(layout).has(activePaneId)) return 'corrupt'
    }
  }
  // Foreign IFF stamped AND the stamp names a different machine. Unstamped
  // = legacy (pre-stamp) data assumed local — never foreign (a same-machine
  // chooser re-pick keeps a healthy unstamped layout; Task 2's backfill then
  // stamps it so the next boot is unambiguous).
  const stamp = parsed.machineId
  if (typeof stamp === 'string' && stamp && stamp !== resolvedMachineId) return 'foreign'
  const persistedAt = typeof parsed.persistedAt === 'number' ? parsed.persistedAt : 0
  if (now - persistedAt > STALE_LAYOUT_MS) return 'stale'
  return 'healthy'
}

/** One-shot stamp backfill. Machine resolution dispatches no tabs/panes
 * action, so the persist middleware's dirty flags never fire
 * (persistMiddleware.ts:534 returns early; :719-751 dirties only tabs/,
 * panes/, tabRecency/, and turnCompletion changes) — a healthy legacy
 * (unstamped) envelope could stay unstamped indefinitely (e.g. a
 * terminal-free layout dispatches nothing on boot). Write the resolved
 * machine id into the RAW envelope directly: parse only as the gate
 * (parses AND lacks machineId), mutate the raw object, ONE synchronous
 * setItem — localStorage writes are all-or-nothing per key, the atomic
 * equivalent of the server side's temp-file+rename; there is no shared
 * atomic-write utility in the client to reuse (verified — only prose uses
 * "atomic" in src/). NO layout mutation (never write the reconstructed
 * ParsedPersistedLayout back — that would normalize/rewrite fields), no
 * full reflush, no broadcast, no store dispatch. Idempotent within a
 * boot: an already-stamped or unparseable envelope writes nothing. */
export function backfillPersistedLayoutMachineId(
  resolvedMachineId: string,
  storage: Storage | undefined = safeStorage(),
): boolean {
  if (!resolvedMachineId || !storage) return false
  let raw: string | null = null
  try {
    raw = storage.getItem(LAYOUT_STORAGE_KEY)
  } catch {
    return false
  }
  if (raw === null) return false
  let parsed: ParsedPersistedLayout | null = null
  try {
    parsed = parsePersistedLayoutRaw(raw)
  } catch {
    parsed = null
  }
  if (!parsed) return false
  if (typeof parsed.machineId === 'string' && parsed.machineId) return false
  let rawEnvelope: { machineId?: string }
  try {
    rawEnvelope = JSON.parse(raw)
  } catch {
    return false
  }
  if (typeof rawEnvelope.machineId === 'string' && rawEnvelope.machineId) return false
  rawEnvelope.machineId = resolvedMachineId
  try {
    storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(rawEnvelope))
    return true
  } catch {
    return false
  }
}
