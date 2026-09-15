import { getCurrentTabRegistryClientInstanceId } from './client-instance-id'
import {
  LEGACY_LAYOUT_BACKUP_STORAGE_KEY,
  LEGACY_LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY,
  LEGACY_LAYOUT_STORAGE_KEY,
} from './storage-keys'

/**
 * Per-window layout-key derivation (delta round 3, finding 1).
 *
 * Every page used to load and write the SAME origin-wide
 * `freshell.layout.v3` key, so once two windows diverged the last flush
 * replaced the only durable copy — refreshing the other window restored
 * the last writer's workspace. The layout envelope is now keyed per
 * window: `freshell.layout.v3.<clientInstanceId>`, derived from the SAME
 * sessionStorage id source the tab-registry sync uses
 * (freshell.tabs.client-instance-id.v1 via getCurrentTabRegistryClientInstanceId
 * — the same getter the machine-bootstrap exclusion id uses,
 * machine-workspace.ts). The bare `freshell.layout.v3` is the LEGACY key
 * only: adopted (byte-identical copy) into a window's derived key on its
 * first post-change boot when the derived key is absent, and NEVER
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
 *   sidecar:                          `freshell.layout.pre-migration-raw.v1.<clientInstanceId>`
 */
export const LAYOUT_STORAGE_KEY_PREFIX = 'freshell.layout.v3'
export const LAYOUT_PRE_MIGRATION_RAW_KEY_PREFIX = 'freshell.layout.pre-migration-raw.v1'

export const FRESH_AGENT_BACKUP_KEY_SUFFIX = 'backup-before-fresh-agent-centralization'
export const FRESH_AGENT_COMMIT_MARKER_KEY_SUFFIX = 'fresh-agent-centralization-commit'
export const FRESH_AGENT_PENDING_MARKER_KEY_SUFFIX = 'fresh-agent-centralization-pending'

// Key suffixes under the layout prefix that are NOT per-window envelope
// keys: the legacy backup and the legacy fresh-agent centralization
// channels. Window-derived keys never collide with them (clientInstanceIds
// are minted `client-…` with no dots).
const RESERVED_LAYOUT_KEY_SUFFIXES = new Set([
  'bak',
  FRESH_AGENT_BACKUP_KEY_SUFFIX,
  FRESH_AGENT_COMMIT_MARKER_KEY_SUFFIX,
  FRESH_AGENT_PENDING_MARKER_KEY_SUFFIX,
])

export function derivedLayoutKey(clientInstanceId: string): string {
  return `${LAYOUT_STORAGE_KEY_PREFIX}.${clientInstanceId}`
}

export function derivedLayoutPreMigrationRawKey(clientInstanceId: string): string {
  return `${LAYOUT_PRE_MIGRATION_RAW_KEY_PREFIX}.${clientInstanceId}`
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

/** The storage keys of THIS window's layout envelope and its channels.
 * Resolved lazily on every call so tests can seed sessionStorage ids
 * before or after module import; the id itself is stable per window. */
export function getWindowLayoutKey(): string {
  return derivedLayoutKey(getCurrentTabRegistryClientInstanceId())
}

export function getWindowLayoutBackupKey(): string {
  return `${getWindowLayoutKey()}.bak`
}

export function getWindowLayoutPreMigrationRawKey(): string {
  return derivedLayoutPreMigrationRawKey(getCurrentTabRegistryClientInstanceId())
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
