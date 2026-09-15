import { parsePersistedLayoutRaw, type ParsedPersistedLayout } from '@/store/persistedState'
import { isWellFormedPaneTree } from '@/store/paneTreeValidation'
import { LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY, LAYOUT_STORAGE_KEY } from '@/store/storage-keys'
import { getPreMigrationLayoutRaw } from '@/store/storage-migration'
import { LEGACY_FRESHOPENCODE_DEFAULT_MODEL } from '@/store/paneTypes'
import { sanitizeRestoreError, sanitizeSessionRef } from '@shared/session-contract'

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

/** The durable pre-migration evidence sidecar (e2r4 review finding 1):
 * the OLDEST pre-rewrite `freshell.layout.v3` raw, written by the boot
 * migration's forced-rewrite path only while the key holds no value
 * (oldest evidence wins) and spared by the version-bump wipe. Null when
 * no rewrite ever captured evidence (or the key was consumed below). */
function readPreMigrationEvidenceRaw(storage: Storage | undefined): string | null {
  if (!storage) return null
  try {
    return storage.getItem(LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY)
  } catch {
    return null
  }
}

/** The pending post-rebuild evidence clear (e2r5 review finding 1): armed
 * by the boot gate after a COMPLETED rebuild, consumed ONLY by the persist
 * middleware's successful layout-write path. Module-level for the same
 * reason the capture above is: the middleware sees redux's middleware-API
 * object, not the store object the gate holds. Process-local by design —
 * a reload before the durable write loses the arm, which is exactly the
 * fail-safe direction (the sidecar evidence survives in storage and the
 * next boot rebuilds again). */
let preMigrationEvidenceClearPending = false

/** Arm the post-rebuild evidence clear. The App gate calls this instead of
 * clearing directly once a rebuild completes: persistence is debounced
 * (PERSIST_DEBOUNCE_MS, persistMiddleware.ts:37) and a failed write is
 * caught while the dirty flags clear (persistMiddleware.ts:696-704), so a
 * direct clear at the Redux boundary could strand the sanitized old
 * envelope in storage with the evidence DELETED — the next boot would
 * classify it healthy and permanently skip the required rebuild. */
export function armPreMigrationEvidenceClear(): void {
  preMigrationEvidenceClearPending = true
}

export function resetPreMigrationEvidenceArmForTests(): void {
  preMigrationEvidenceClearPending = false
}

/** Clear the evidence key; false when the remove failed (or no storage),
 * so the caller can keep the arm for a later retry. */
function clearPreMigrationLayoutEvidenceKey(storage: Storage | undefined): boolean {
  if (!storage) return false
  try {
    storage.removeItem(LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY)
    return true
  } catch {
    // retention is fail-safe; nothing user-visible to report
    return false
  }
}

/** Consume-and-clear the evidence sidecar after the boot gate's
 * adjudication: healthy-keep or a COMPLETED rebuild retires it; a failed
 * rebuild leaves it so the next boot retries with the original corrupt raw
 * intact. A failing removeItem also leaves it — retention is the
 * fail-safe direction, costing at most one redundant rebuild. */
export function clearPreMigrationLayoutEvidence(storage: Storage | undefined = safeStorage()): void {
  clearPreMigrationLayoutEvidenceKey(storage)
}

/** The DURABLE boundary (e2r5 review finding 1): the persist middleware
 * calls this immediately after a SUCCESSFUL layout write — the rebuilt
 * envelope is now the durable state, so retiring the evidence can no longer
 * strand the sanitized old envelope. Unarmed calls are no-ops; a failed
 * evidence remove keeps the arm so the next successful write retries. */
export function consumeArmedPreMigrationEvidenceClear(storage: Storage | undefined = safeStorage()): void {
  if (!preMigrationEvidenceClearPending) return
  if (clearPreMigrationLayoutEvidenceKey(storage)) {
    preMigrationEvidenceClearPending = false
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

/** Verified deliberate migrations that DROP a raw content key — parse-side
 * (persistedState.ts) or boot-migration-side (storage-migration.ts, whose
 * PRE-rewrite raw the salvage comparison reads via
 * getPreMigrationLayoutRaw) — as distinct from SILENT salvage of a
 * malformed durable field, which is corruption by definition. Every entry
 * cites its verified drop site, and every identity-bearing key is
 * VALUE-SENSITIVE (e2r2 review findings 1-2): a raw-key drop is exempt
 * ONLY when the parsed content shows the migration actually consumed the
 * value — drop + product = exempt; drop + no product = corruption.
 *
 * The exemption set covers BOTH content kinds of the fresh-agent
 * centralization migration: `fresh-agent` AND the legacy `agent-chat`
 * (the rewrite consumes agent-chat panes through the same
 * migrateLegacyFreshAgentContent, shared/fresh-agent.ts:365-424).
 *
 * - resumeSessionId (any kind): exempt iff the parsed content holds the
 *   migration product. Terminal: the parse destructures it out and never
 *   re-adds it (persistedState.ts:238; boot side storage-migration.ts:160),
 *   and migrateLegacyTerminalDurableState converts it into a sessionRef
 *   or restoreError (session-contract.ts:115-158) — an empty or non-string
 *   value produces NEITHER (session-contract.ts:132-134), so the pane
 *   would reopen as a fresh session → corruption. Fresh-agent family: a
 *   STRING value is re-added verbatim (fresh-agent.ts:318-320, :359, :420)
 *   so a drop means the value was non-string (unconsumed — no product
 *   unless another identity resolves) or the restore path shed it (the
 *   kept restoreError IS the product, fresh-agent.ts:321, :417).
 * - model (freshopencode fresh-agent): the parse destructures the raw key
 *   and rebuilds modelSelection (persistedState.ts:316-333; boot side
 *   storage-migration.ts:238-255). Exempt iff the parsed content holds a
 *   modelSelection, OR the raw value TRIMS to the stale DeepSeek default —
 *   the one documented drop whose product is deliberately ABSENT
 *   (paneTypes.ts:48-55; the trim mirrors the normalizer's own
 *   `legacyModel.trim()` comparison, paneTypes.ts:52, so a padded legacy
 *   default is the same deliberate drop — e2r3 review finding 2; pinned by
 *   persisted-state.fresh-agent.test.ts:233-254). A garbage value
 *   (non-string/blank) produces no modelSelection (paneTypes.ts:27-35) →
 *   the pane would reopen with the default model → corruption. The raw
 *   modelSelection key itself has NO exemption: a schema-invalid value
 *   that normalizes away (parsed-effective value undefined, no usable
 *   legacy model) was silently discarded, not migrated → corruption
 *   (e2r3 review finding 1).
 * - restoreError (terminal): exempt iff the RAW value is a valid
 *   RESTORE_UNAVAILABLE error — the only shape whose shed is the
 *   documented migration (the boot rewrite destructures a flush-carried
 *   error out and re-adds only the resume-migration's own,
 *   storage-migration.ts:160, :177; the parse keeps a valid one,
 *   persistedState.ts:246-248). A garbage value fails readRestoreError
 *   (persistedState.ts:140-149) and is dropped by BOTH sides with no
 *   replacement → corruption.
 * - restoreError (fresh-agent family): valid errors are always re-added
 *   (fresh-agent.ts:321, :356-357, :417; parse side :338-341), so a drop
 *   means the raw value was garbage — exempt only when the migration
 *   produced the replacement verdict (the parsed restoreError), e.g. an
 *   agent-chat pane with no usable identity (fresh-agent.ts:386-391).
 * - sessionRef (fresh-agent): the restore-unavailable identity shed — the
 *   existing-restoreError path destructures sessionRef out and never
 *   re-adds it while keeping the error (fresh-agent.ts:298-307, :313-322).
 *   Exempt iff the raw restoreError is valid (it is the announced shed).
 * - sessionRef (agent-chat): the conversion verdict — a non-canonical
 *   Claude ref is rejected into a restoreError
 *   (fresh-agent.ts:378-391, :412-418) while a valid ref is re-added
 *   (:421). Exempt iff the parsed content holds the restoreError.
 * - sessionRef / terminalId on a legacy codex recovery_failed terminal:
 *   the remint rewrite destructures BOTH the invalid legacy sessionRef
 *   and the failed recovery's dead terminalId (live handle) out — boot
 *   side storage-migration.ts:110-115 via :162; parse side
 *   persistedState.ts:120-125 via :245 — and never re-adds either,
 *   always replacing the pane status with 'creating' (valid codex ref
 *   kept) or 'error' (+ fresh invalid_legacy_restore_target)
 *   (storage-migration.ts:116-127; persistedState.ts:126-137). Pinned by
 *   storage-migration.test.ts:291-345, which asserts terminalId
 *   undefined alongside the status/error rewrite. Exempt iff the raw
 *   pane is the documented remint trigger (codex + recovery_failed) AND
 *   the parsed status shows the remint's announced replacement; a
 *   terminalId drop outside this trigger is unreachable via the
 *   migration (every other terminal shape keeps it), so it stays
 *   corruption.
 * - showThinking / showTools (fresh-agent family): vestigial per-pane
 *   display overrides with no writer since 2026-04, unconditionally
 *   deleted by the migration (fresh-agent.ts:310-311, :348-349, :404-405)
 *   and scrubbed on the next flush (persistMiddleware). No migration
 *   product exists BY DESIGN, so these two keys stay value-insensitive:
 *   any value is dead weight, and the fixture shapes pin live values
 *   (persisted-state.fresh-agent.test.ts:102-104).
 * - timelineSessionId / cliSessionId (fresh-agent family): consumed into
 *   the durable identity — the fallback resumeSessionId chain
 *   (fresh-agent.ts:325-329, :373-377) feeds
 *   migrateLegacyFreshAgentDurableState (:330-335, :378-383), which
 *   yields the parsed sessionRef (:360, :421) or a restoreError
 *   (:356-357, :412-418); the existing-restoreError path sheds them under
 *   reason invalid_legacy_restore_target (:296-307; parse side
 *   persistedState.ts:276-286; boot side storage-migration.ts:195-205)
 *   with the error kept as the product. Exempt iff the parsed content
 *   holds the sessionRef or restoreError product; an empty-string id
 *   resolves to nothing (fresh-agent.ts:168-170) → corruption. */
function isVerifiedMigrationContentDrop(
  rawContent: Record<string, unknown>,
  parsedContent: Record<string, unknown> | undefined,
  key: string,
): boolean {
  const parsedSessionRef = sanitizeSessionRef(parsedContent?.sessionRef)
  const parsedRestoreError = sanitizeRestoreError(parsedContent?.restoreError)
  const parsedHasDurableProduct = !!parsedSessionRef || !!parsedRestoreError
  const rawKind = rawContent.kind
  const isFreshAgentFamily = rawKind === 'fresh-agent' || rawKind === 'agent-chat'

  if (key === 'resumeSessionId') return parsedHasDurableProduct
  if (isFreshAgentFamily) {
    if (key === 'showThinking' || key === 'showTools') return true
    if (key === 'timelineSessionId' || key === 'cliSessionId') return parsedHasDurableProduct
    if (key === 'model') {
      const rawModel = rawContent.model
      return parsedContent?.sessionType === 'freshopencode'
        && parsedContent?.provider === 'opencode'
        && (parsedContent?.modelSelection !== undefined
          || (typeof rawModel === 'string' && rawModel.trim() === LEGACY_FRESHOPENCODE_DEFAULT_MODEL))
    }
    if (key === 'sessionRef') {
      return rawKind === 'agent-chat'
        ? !!parsedRestoreError
        : !!sanitizeRestoreError(rawContent.restoreError)
    }
    if (key === 'restoreError') return !!parsedRestoreError
  }
  if (rawKind === 'terminal') {
    if (key === 'restoreError') return !!sanitizeRestoreError(rawContent.restoreError)
    if (key === 'sessionRef' || key === 'terminalId') {
      if (rawContent.mode !== 'codex' || rawContent.status !== 'recovery_failed') return false
      const parsedStatus = parsedContent?.status
      return parsedStatus === 'creating' || parsedStatus === 'error'
    }
  }
  return false
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
 * durable data → corruption. The RAW side is the pre-migration envelope
 * on rewrite boots (see classifyPersistedLayoutHealth) — the boot
 * migration rewrites freshell.layout.v3 before the classifier runs, and
 * its normalizeLayoutNode strips the same keys the parse does
 * (storage-migration.ts:148-290), so only the captured pre-rewrite raw
 * still shows them (e2r1 review finding 1). Parsed may have MORE keys
 * (normalization adds sessionRef/codexDurability/restoreError/
 * modelSelection) — the rule is raw-keys ⊆ parsed-EFFECTIVE-keys, where
 * an effective key is one whose value is not `undefined` (e2r3 review
 * finding 1; see the inline rule below for why presence alone is
 * insufficient). Legit current
 * flushes never produce a dropped key: in-memory content is normalized
 * on every write path (normalizePaneContent, panesSlice.ts:60-108 —
 * sessionRef via sanitizeSessionRef :72, codexDurability :73,
 * restoreError :74) and the flush strips the volatile keys the parse
 * also drops (persistMiddleware.ts:255-285). */
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
    // e2r3 review finding 1: parsed-EFFECTIVE keys are the keys whose
    // value is not `undefined`. Key presence alone is insufficient:
    // normalizeFreshAgentContent ALWAYS re-adds the modelSelection key
    // (persistedState.ts:242-251) — with value undefined when the raw
    // selection fails FreshAgentModelSelectionSchema — so a key-presence
    // rule calls the pane healthy although the parse silently discarded
    // the selected model. JSON raw values are never undefined, so every
    // raw content key is a non-undefined value; a raw key whose
    // parsed-effective value is absent (key missing OR explicitly
    // undefined) is a DROP, subject to the same verified exemption set.
    const parsedEffectiveKeys = new Set(
      Object.keys(parsedContent).filter((key) => parsedContent[key] !== undefined),
    )
    for (const key of Object.keys(rawContent)) {
      if (parsedEffectiveKeys.has(key)) continue
      if (isVerifiedMigrationContentDrop(rawContent, parsedContent, key)) continue
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
  // salvage dropped rows → corrupt. This tab-count check reads the CURRENT
  // stored raw — the loader parses exactly that. The content-salvage
  // comparison below additionally needs the PRE-migration envelope when
  // this boot's storage migration rewrote the key.
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
  // migration exemptions. The raw side prefers the DURABLE pre-migration
  // evidence sidecar FIRST (e2r4 review finding 1): the migration's
  // rewrite mirrors the pre-rewrite raw into a dedicated key (oldest
  // evidence wins), so an interrupted recovery — the rebuild failed and
  // the page reloaded, or the page died before the gate adjudicated —
  // still classifies corrupt on the NEXT boot, when the process-local
  // capture is empty and the stored raw is already sanitized. The sidecar
  // also outranks this boot's process-local capture when both exist: the
  // capture reflects the CURRENT pre-rewrite envelope, while a surviving
  // sidecar means an earlier adjudication never completed — its original
  // evidence keeps driving corrupt-until-rebuilt (a legit later flush
  // only adds keys, and a genuinely restored pane re-adds the dropped key,
  // so the comparison converges on the first completed adjudication).
  // Then this boot's pre-rewrite capture (main.tsx imports the
  // self-executing migration before the store, and on essentially every
  // boot the marker guard fails — any flush changes the raw hash — so
  // migratePersistedLayout rewrites): the rewrite normalizes the same
  // leaves the parse does, so a POST-rewrite raw can never show a
  // stripped key (e2r1 review finding 1). No capture this boot → the
  // getter returns null and the stored raw still carries any invalid
  // content, so it is its own pre-migration truth.
  const salvageRaw = readPreMigrationEvidenceRaw(storage)
    ?? getPreMigrationLayoutRaw()
    ?? raw
  let salvageEnvelope: { panes?: { layouts?: unknown } } | undefined
  try {
    salvageEnvelope = JSON.parse(salvageRaw)
  } catch {
    salvageEnvelope = undefined
  }
  if (hasSalvagedLeafContent(salvageEnvelope, parsed)) return 'corrupt'
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
