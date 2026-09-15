import { safeSessionStorage } from './client-instance-id'
import {
  LAYOUT_WINDOW_ID_STORAGE_KEY,
  LEGACY_LAYOUT_BACKUP_STORAGE_KEY,
  LEGACY_LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY,
  LEGACY_LAYOUT_STORAGE_KEY,
} from './storage-keys'

/**
 * Per-window layout-key derivation (delta round 3, finding 1; e3r1 finding 3).
 *
 * Every page used to load and write the SAME origin-wide
 * `freshell.layout.v3` key, so once two windows diverged the last flush
 * replaced the only durable copy — refreshing the other window restored
 * the last writer's workspace. The layout envelope is now keyed per
 * window: `freshell.layout.v3.<layoutWindowId>`.
 *
 * The id is a DEDICATED mint-once layout-window-id (the sessionStorage key
 * `freshell.layout-window-id.v1`), minted once per context and reminted
 * ONLY by the tab-registry lease-collision rotation (e3r2 finding 1): a
 * duplicated browser tab COPIES the id like any sessionStorage entry, so
 * without the remint both tabs keep one layout key — either tab's flush
 * fully hydrates the other (crossTabSync's own-key path), and the last
 * writer's envelope is what a refresh of either restores. The rotation is
 * the one moment a window's identity legitimately splits, so it mints the
 * duplicate a fresh id: the duplicate becomes a sovereign NEW window
 * whose derived key is absent → boot rebuilds from the inventory, while
 * the ORIGINAL keeps its id and envelope (sessionStorage copies diverge
 * at duplication — HTML webstorage §12.2.2: each window has its own
 * individual copy — so the duplicate's remint write cannot reach it).
 * Every other path keeps the id stable — that rotation remint is the
 * ONLY one. The registry client id keeps
 * serving the tab-registry sync and the machine-bootstrap exclusion id
 * (machine-workspace.ts), unchanged.
 *
 * The bare `freshell.layout.v3` is the LEGACY key only: adopted
 * (byte-identical copy) into the FIRST window's derived key on its
 * post-change boot (one-shot, gated by the global
 * `freshell.layout.legacy-adopted.v1` marker — e3r1 finding 2) and NEVER
 * deleted — other live pre-change windows may still read it.
 *
 * All envelope-attached side channels are per-window key suffixes so two
 * windows can never cross-contaminate recovery state:
 * - the empty-tabs-guard backup:      `<derived>.bak`
 * - the fresh-agent centralization
 *   backup / commit / pending keys:   `<derived>.backup-before-fresh-agent-centralization`
 *                                     `<derived>.fresh-agent-centralization-commit`
 *                                     `<derived>.fresh-agent-centralization-pending`
 * - the pre-migration evidence
 *   sidecar:                          `freshell.layout.pre-migration-raw.v1.<layoutWindowId>`
 */
export const LAYOUT_STORAGE_KEY_PREFIX = 'freshell.layout.v3'
export const LAYOUT_PRE_MIGRATION_RAW_KEY_PREFIX = 'freshell.layout.pre-migration-raw.v1'

export const FRESH_AGENT_BACKUP_KEY_SUFFIX = 'backup-before-fresh-agent-centralization'
export const FRESH_AGENT_COMMIT_MARKER_KEY_SUFFIX = 'fresh-agent-centralization-commit'
export const FRESH_AGENT_PENDING_MARKER_KEY_SUFFIX = 'fresh-agent-centralization-pending'

// Key suffixes under the layout prefix that are NOT per-window envelope
// keys: the legacy backup and the legacy fresh-agent centralization
// channels. Window-derived keys never collide with them (layoutWindowIds
// are minted `layout-window-…` with no dots).
const RESERVED_LAYOUT_KEY_SUFFIXES = new Set([
  'bak',
  FRESH_AGENT_BACKUP_KEY_SUFFIX,
  FRESH_AGENT_COMMIT_MARKER_KEY_SUFFIX,
  FRESH_AGENT_PENDING_MARKER_KEY_SUFFIX,
])

export function derivedLayoutKey(layoutWindowId: string): string {
  return `${LAYOUT_STORAGE_KEY_PREFIX}.${layoutWindowId}`
}

export function derivedLayoutPreMigrationRawKey(layoutWindowId: string): string {
  return `${LAYOUT_PRE_MIGRATION_RAW_KEY_PREFIX}.${layoutWindowId}`
}

/** A per-window layout envelope key (`freshell.layout.v3.<id>`), excluding
 * the legacy bare key, the reserved legacy channels, and the per-window
 * side-channel suffixes (`<id>.bak`, `<id>.fresh-agent-*` — ids never
 * contain dots). */
export function isDerivedLayoutKey(key: string): boolean {
  if (!key.startsWith(`${LAYOUT_STORAGE_KEY_PREFIX}.`)) return false
  const suffix = key.slice(LAYOUT_STORAGE_KEY_PREFIX.length + 1)
  if (suffix.length === 0) return false
  if (suffix.includes('.')) return false
  return !RESERVED_LAYOUT_KEY_SUFFIXES.has(suffix)
}

let inMemoryLayoutWindowId = ''
let remintedLayoutWindowId = false

/** The mint-once per-window layout-window id: read from sessionStorage,
 * minted once per context when absent, and cached in memory regardless of
 * write success (a quota-exhausted sessionStorage must not re-mint per
 * call — one persistence flush resolves the key repeatedly). Reminted
 * ONLY by remintLayoutWindowId() — the tab-registry lease-collision
 * rotation; every other path keeps it stable. After a remint the
 * in-memory id is AUTHORITATIVE for the context's lifetime: a remint
 * whose setItem failed leaves the duplicated tab's STALE copied id in
 * storage, and a later getter must never re-read it over the established
 * remint (e3r3 finding 3) — that would re-share one layout key between
 * the tabs the rotation just split. A context with NO established
 * in-memory id still reads storage (the initial-boot mint-once
 * semantics). Duplicated tabs share the copied sessionStorage value
 * until that rotation resolves. */
export function getLayoutWindowId(): string {
  if (remintedLayoutWindowId && inMemoryLayoutWindowId) {
    return inMemoryLayoutWindowId
  }
  const storage = safeSessionStorage()
  let layoutWindowId = ''
  try {
    layoutWindowId = storage?.getItem(LAYOUT_WINDOW_ID_STORAGE_KEY) || ''
  } catch {
    layoutWindowId = ''
  }
  if (!layoutWindowId) {
    layoutWindowId = inMemoryLayoutWindowId
  }
  if (!layoutWindowId) {
    layoutWindowId = `layout-window-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`
    inMemoryLayoutWindowId = layoutWindowId
    try {
      storage?.setItem(LAYOUT_WINDOW_ID_STORAGE_KEY, layoutWindowId)
    } catch {
      // Keep the per-window in-memory id stable when the write fails.
    }
    return layoutWindowId
  }
  inMemoryLayoutWindowId = layoutWindowId
  return layoutWindowId
}

/** Remint the layout-window-id. EXCLUSIVELY the tab-registry
 * lease-collision rotation path (tabRegistrySync's
 * rotateClientInstanceIdAfterCollision — e3r2 finding 1): a duplicated
 * browser tab that copied the id becomes a sovereign NEW window (its new
 * derived key is absent → boot rebuilds from the inventory; the
 * ORIGINAL's copy is a separate sessionStorage object and is unaffected).
 * No other path may call this — every other consumer relies on the
 * mint-once stability. Once reminted, the in-memory id is authoritative
 * for this context's lifetime: a rejected setItem leaves the stale
 * copied value in storage, and the getter keeps the remint instead of
 * re-reading it (e3r3 finding 3). */
export function remintLayoutWindowId(): string {
  const layoutWindowId = `layout-window-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`
  inMemoryLayoutWindowId = layoutWindowId
  remintedLayoutWindowId = true
  try {
    safeSessionStorage()?.setItem(LAYOUT_WINDOW_ID_STORAGE_KEY, layoutWindowId)
  } catch {
    // Keep the per-window in-memory id stable when the write fails.
  }
  return layoutWindowId
}

/** The storage keys of THIS window's layout envelope and its channels.
 * Resolved lazily on every call so tests can seed sessionStorage ids
 * before or after module import, so a rotation remint is picked up
 * mid-session (persist flushes and event handling re-derive per call);
 * the id itself is mint-once per window. */
export function getWindowLayoutKey(): string {
  return derivedLayoutKey(getLayoutWindowId())
}

export function getWindowLayoutBackupKey(): string {
  return `${getWindowLayoutKey()}.bak`
}

export function getWindowLayoutPreMigrationRawKey(): string {
  return derivedLayoutPreMigrationRawKey(getLayoutWindowId())
}

export function getWindowFreshAgentBackupKey(): string {
  return `${getWindowLayoutKey()}.${FRESH_AGENT_BACKUP_KEY_SUFFIX}`
}

export function getWindowFreshAgentCommitMarkerKey(): string {
  return `${getWindowLayoutKey()}.${FRESH_AGENT_COMMIT_MARKER_KEY_SUFFIX}`
}

export function getWindowFreshAgentPendingMarkerKey(): string {
  return `${getWindowLayoutKey()}.${FRESH_AGENT_PENDING_MARKER_KEY_SUFFIX}`
}

export {
  LEGACY_LAYOUT_STORAGE_KEY,
  LEGACY_LAYOUT_BACKUP_STORAGE_KEY,
  LEGACY_LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY,
}
