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
 * The id is a DEDICATED IMMUTABLE layout-window-id (the sessionStorage key
 * `freshell.layout-window-id.v1`), minted once per context and NEVER
 * rotated: the tab-registry client id it used
 * to be derived from rotates on lease collisions (a duplicated browser tab
 * claims the copied id), which would strand the duplicate's healthy
 * envelope on its next refresh (boot → absent → geometry-resetting
 * rebuild). Duplicated tabs COPY the layout-window-id like any
 * sessionStorage entry, so they share one envelope — bounded, matching
 * the pre-upgrade duplicate-tab semantics. The registry client id keeps
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

/** The IMMUTABLE per-window layout-window id: read from sessionStorage,
 * minted once per context when absent, and cached in memory regardless of
 * write success (a quota-exhausted sessionStorage must not re-mint per
 * call — one persistence flush resolves the key repeatedly). Never
 * rotated by lease collisions; duplicated tabs share the copied
 * sessionStorage value. */
export function getLayoutWindowId(): string {
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

/** The storage keys of THIS window's layout envelope and its channels.
 * Resolved lazily on every call so tests can seed sessionStorage ids
 * before or after module import; the id itself is stable per window. */
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
