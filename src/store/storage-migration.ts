// ============================================================
// localStorage Migration
// ============================================================
// This module MUST be imported before any slices that load from localStorage.
// When the persisted state schema changes in breaking ways, we increment
// STORAGE_VERSION to trigger a full clear on the next load.
//
// Increment STORAGE_VERSION when:
// - Tab/Pane structure changes
// - Coding CLI event schema changes (session.init → session.start, etc.)
// - Composite key format changes (provider:sessionId)
// - Any persisted state shape changes incompatibly
// ============================================================

import { createLogger } from '@/lib/client-logger'
import { clearAuthCookie } from '@/lib/auth'
import {
  LAYOUT_FRESH_AGENT_BACKUP_KEY,
  LAYOUT_FRESH_AGENT_COMMIT_MARKER_KEY,
  LAYOUT_FRESH_AGENT_MIGRATION_ID,
  LAYOUT_FRESH_AGENT_PENDING_MARKER_KEY,
  LAYOUT_SCHEMA_VERSION,
  PANES_SCHEMA_VERSION,
  hashPersistedLayoutRaw,
  migrateV2ToV3,
  parseLayoutFreshAgentCommitMarker,
  readRecoverablePersistedLayoutRaw,
} from './persistedState'
import { BROWSER_PREFERENCES_STORAGE_KEY } from './storage-keys'
import {
  LEGACY_LAYOUT_STORAGE_KEY,
  LAYOUT_PRE_MIGRATION_RAW_KEY_PREFIX,
  LAYOUT_STORAGE_KEY_PREFIX,
  getWindowFreshAgentBackupKey,
  getWindowFreshAgentCommitMarkerKey,
  getWindowFreshAgentPendingMarkerKey,
  getWindowLayoutKey,
  getWindowLayoutPreMigrationRawKey,
} from './window-layout-keys'
import {
  buildRestoreError,
  migrateLegacyTerminalDurableState,
  type RestoreError,
  sanitizeSessionRef,
} from '@shared/session-contract'
import { sanitizeCodexDurabilityRef } from '@shared/codex-durability'
import { migrateLegacyFreshAgentContent, migrateLegacyFreshAgentDurableState } from '@shared/fresh-agent'
import { normalizeFreshAgentPaneModelSelection } from './paneTypes'

const log = createLogger('StorageMigration')

const STORAGE_VERSION = 5
const STORAGE_VERSION_KEY = 'freshell_version'
const AUTH_STORAGE_KEY = 'freshell.auth-token'
const LEGACY_BROWSER_PREFERENCE_KEYS = [
  'freshell.terminal.fontFamily.v1',
] as const

type PersistedLayoutMigrationResult = 'none' | 'migrated' | 'failed'

function warnStructured(event: string, details: Record<string, unknown>): void {
  log.warn(JSON.stringify({
    severity: 'warn',
    component: 'storage-migration',
    event,
    ...details,
  }))
}

function readStorageVersion(): number {
  const stored = localStorage.getItem(STORAGE_VERSION_KEY)
  if (!stored) return 0
  const parsed = Number.parseInt(stored, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function clearFreshellKeysExcept(keep: string[], keepPrefixes: string[] = []): void {
  // Delta round 3, finding 1: the layout family and the pre-migration
  // evidence sidecars are keyed per window, so the version-bump wipe keeps
  // whole PREFIXES — every window's derived envelope, its .bak and
  // fresh-agent channels, and its sidecar — plus the legacy keys (the
  // layout prefix covers the bare legacy key, the legacy .bak, and the
  // legacy centralization channels; they are never deleted either).
  const keepSet = new Set(keep)
  for (const key of Object.keys(localStorage)) {
    if (!(key.startsWith('freshell.') || key === STORAGE_VERSION_KEY)) continue
    if (keepSet.has(key)) continue
    if (keepPrefixes.some((prefix) => key.startsWith(prefix))) continue
    localStorage.removeItem(key)
  }
}

function normalizeLayoutTab(tab: Record<string, unknown>): Record<string, unknown> {
  const mode = typeof tab.mode === 'string' ? tab.mode : undefined
  const codingCliProvider = typeof tab.codingCliProvider === 'string' ? tab.codingCliProvider : undefined
  const provider = codingCliProvider || (mode && mode !== 'shell' ? mode : undefined)
  const durableState = migrateLegacyTerminalDurableState({
    provider,
    sessionRef: tab.sessionRef,
    resumeSessionId: typeof tab.resumeSessionId === 'string' ? tab.resumeSessionId : undefined,
  })
  const codexDurability = sanitizeCodexDurabilityRef(tab.codexDurability)
  const { resumeSessionId: _resumeSessionId, sessionRef: _legacySessionRef, ...rest } = tab
  return {
    ...rest,
    ...(durableState.sessionRef ? { sessionRef: durableState.sessionRef } : {}),
    ...(codexDurability ? { codexDurability } : {}),
  }
}

function isCodexSessionRef(sessionRef: unknown): sessionRef is { provider: 'codex'; sessionId: string } {
  return !!sessionRef
    && typeof sessionRef === 'object'
    && (sessionRef as { provider?: unknown }).provider === 'codex'
    && typeof (sessionRef as { sessionId?: unknown }).sessionId === 'string'
    && (sessionRef as { sessionId: string }).sessionId.length > 0
}

function normalizeLegacyRecoveryFailedTerminal(
  content: Record<string, unknown>,
  durableState: { sessionRef?: unknown },
): Record<string, unknown> {
  if (content.kind !== 'terminal' || content.mode !== 'codex' || content.status !== 'recovery_failed') {
    return content
  }

  const {
    terminalId: _terminalId,
    status: _status,
    restoreError: _restoreError,
    ...rest
  } = content
  if (isCodexSessionRef(durableState.sessionRef)) {
    return {
      ...rest,
      status: 'creating',
    }
  }

  return {
    ...rest,
    status: 'error',
    restoreError: buildRestoreError('invalid_legacy_restore_target'),
  }
}

function readRestoreError(value: unknown): RestoreError | undefined {
  return (
    value
    && typeof value === 'object'
    && (value as any).code === 'RESTORE_UNAVAILABLE'
    && typeof (value as any).reason === 'string'
  )
    ? value as RestoreError
    : undefined
}

function hasFreshAgentLayoutMigrationMarkerForCurrentRaw(): boolean {
  const raw = localStorage.getItem(getWindowLayoutKey())
  if (!raw) return false
  const marker = parseLayoutFreshAgentCommitMarker(localStorage.getItem(getWindowFreshAgentCommitMarkerKey()))
  return marker?.migratedHash === hashPersistedLayoutRaw(raw)
}

function normalizeLayoutNode(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node
  const candidate = node as Record<string, unknown>

  if (candidate.type === 'leaf' && candidate.content && typeof candidate.content === 'object') {
    const content = migrateLegacyFreshAgentContent(candidate.content as Record<string, unknown>) as Record<string, unknown>
    if (content.kind === 'terminal') {
      const durableState = migrateLegacyTerminalDurableState({
        provider: typeof content.mode === 'string' && content.mode !== 'shell' ? content.mode : undefined,
        sessionRef: content.sessionRef,
        resumeSessionId: typeof content.resumeSessionId === 'string' ? content.resumeSessionId : undefined,
      })
      const { resumeSessionId: _resumeSessionId, sessionRef: _legacySessionRef, restoreError: _legacyRestoreError, ...rest } = content
      const codexDurability = sanitizeCodexDurabilityRef(content.codexDurability)
      const normalizedRuntime = normalizeLegacyRecoveryFailedTerminal(rest, durableState)
      const isLegacyRecoveryFailed = (
        rest.kind === 'terminal'
        && rest.mode === 'codex'
        && rest.status === 'recovery_failed'
      )
      const normalizedSessionRef = isLegacyRecoveryFailed && !isCodexSessionRef(durableState.sessionRef)
        ? undefined
        : durableState.sessionRef
      return {
        ...candidate,
        content: {
          ...normalizedRuntime,
          ...(normalizedSessionRef ? { sessionRef: normalizedSessionRef } : {}),
          ...(codexDurability ? { codexDurability } : {}),
          ...(!isLegacyRecoveryFailed && durableState.restoreError ? { restoreError: durableState.restoreError } : {}),
        },
      }
    }

    if (content.kind === 'fresh-agent') {
      const existingRestoreError = readRestoreError(content.restoreError)
      if (existingRestoreError) {
        const {
          sessionRef: _legacySessionRef,
          restoreError: _legacyRestoreError,
          // Vestigial per-pane display overrides (no writer since 2026-04):
          // dropped during migration, never constructed into pane content.
          showThinking: _legacyShowThinking,
          showTools: _legacyShowTools,
          ...restWithPossibleResume
        } = content

        const rest = existingRestoreError.reason === 'invalid_legacy_restore_target'
          ? (() => {
              const {
                resumeSessionId: _legacyResumeSessionId,
                timelineSessionId: _legacyTimelineSessionId,
                cliSessionId: _legacyCliSessionId,
                ...withoutLegacyIdentity
              } = restWithPossibleResume
              return withoutLegacyIdentity
            })()
          : restWithPossibleResume

        return {
          ...candidate,
          content: {
            ...rest,
            restoreError: existingRestoreError,
          },
        }
      }

      const provider = content.provider === 'claude' || content.provider === 'codex' || content.provider === 'opencode'
        ? content.provider
        : undefined
      const durableState = migrateLegacyFreshAgentDurableState({
        provider,
        sessionRef: content.sessionRef,
        resumeSessionId: typeof content.resumeSessionId === 'string'
          ? content.resumeSessionId
          : (typeof content.timelineSessionId === 'string'
              ? content.timelineSessionId
              : (typeof content.cliSessionId === 'string' ? content.cliSessionId : undefined)),
        rejectNonCanonicalClaudeSessionRef: true,
      })
      const {
        sessionRef: _legacySessionRef,
        restoreError: _legacyRestoreError,
        // Vestigial per-pane display overrides (no writer since 2026-04):
        // dropped during migration, never constructed into pane content.
        showThinking: _legacyShowThinking,
        showTools: _legacyShowTools,
        ...rest
      } = content
      const restWithNormalizedModel = content.sessionType === 'freshopencode' && content.provider === 'opencode'
        ? (() => {
            const {
              model: legacyModel,
              modelSelection: legacyModelSelection,
              ...withoutModel
            } = rest
            return {
              ...withoutModel,
              modelSelection: normalizeFreshAgentPaneModelSelection({
                sessionType: content.sessionType,
                provider: content.provider,
                modelSelection: legacyModelSelection,
                legacyModel,
              }),
            }
          })()
        : rest
      return {
        ...candidate,
        content: {
          ...restWithNormalizedModel,
          ...(durableState.sessionRef ? { sessionRef: durableState.sessionRef } : {}),
          ...('restoreError' in durableState && durableState.restoreError ? { restoreError: durableState.restoreError } : {}),
        },
      }
    }

    const sanitizedSessionRef = sanitizeSessionRef(content.sessionRef)
    if (!sanitizedSessionRef) return node

    const { sessionRef: _legacySessionRef, ...rest } = content
    return {
      ...candidate,
      content: {
        ...rest,
        sessionRef: sanitizedSessionRef,
      },
    }
  }

  if (candidate.type === 'split' && Array.isArray(candidate.children) && candidate.children.length === 2) {
    return {
      ...candidate,
      children: [
        normalizeLayoutNode(candidate.children[0]),
        normalizeLayoutNode(candidate.children[1]),
      ],
    }
  }

  return node
}

// The raw `freshell.layout.v3` envelope as it stood just BEFORE this
// boot's rewrite landed (e2r1 review finding 1). The every-boot
// normalizeLayoutNode pass strips content keys the recovery health
// classifier must still see (e.g. a terminal sessionRef that fails
// sanitizeSessionRef) from the STORED raw before classification runs,
// so the classifier reads the pre-rewrite envelope through
// getPreMigrationLayoutRaw() instead. Null when no rewrite occurred
// this boot (marker-guard held) — then the stored raw is its own
// pre-migration truth. One browser window is one JS realm, so one
// capture per boot is the correct scope; the rewrite ALSO mirrors this
// raw into the DURABLE per-window pre-migration evidence sidecar
// (freshell.layout.pre-migration-raw.v1.<clientInstanceId>) because this
// capture is empty
// again after a reload — see writeMigratedLayoutWithRecovery (e2r4
// review finding 1).
let preMigrationLayoutRaw: string | null = null

export function getPreMigrationLayoutRaw(): string | null {
  return preMigrationLayoutRaw
}

function writeMigratedLayoutWithRecovery(originalRaw: string, migratedRaw: string, expectedCurrentRaw: string): boolean {
  const layoutKey = getWindowLayoutKey()
  const backupKey = getWindowFreshAgentBackupKey()
  const commitMarkerKey = getWindowFreshAgentCommitMarkerKey()
  const pendingMarkerKey = getWindowFreshAgentPendingMarkerKey()
  try {
    localStorage.setItem(backupKey, originalRaw)
  } catch (error) {
    warnStructured('fresh_agent_layout_backup_write_failed', {
      key: backupKey,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }

  const currentRaw = localStorage.getItem(layoutKey)
  if (currentRaw !== expectedCurrentRaw) {
    try {
      localStorage.removeItem(backupKey)
      localStorage.removeItem(commitMarkerKey)
      localStorage.removeItem(pendingMarkerKey)
    } catch (error) {
      warnStructured('fresh_agent_layout_interleaving_cleanup_failed', {
        backupKey,
        markerKey: commitMarkerKey,
        pendingMarkerKey,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    warnStructured('fresh_agent_layout_interleaving_write_detected', {
      key: layoutKey,
    })
    return false
  }

  const pendingMarkerRaw = JSON.stringify({
    version: 1,
    migration: LAYOUT_FRESH_AGENT_MIGRATION_ID,
    backupKey: LAYOUT_FRESH_AGENT_BACKUP_KEY,
    originalHash: hashPersistedLayoutRaw(originalRaw),
    migratedHash: hashPersistedLayoutRaw(migratedRaw),
    startedAt: Date.now(),
  })

  try {
    localStorage.removeItem(commitMarkerKey)
    localStorage.setItem(pendingMarkerKey, pendingMarkerRaw)
  } catch (error) {
    warnStructured('fresh_agent_layout_pending_marker_write_failed', {
      key: pendingMarkerKey,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }

  // Durable evidence sidecar (e2r4 review finding 1): mirror the PRE-rewrite
  // raw into a dedicated key so the health classifier can still see what the
  // rewrite sanitized after a reload — the process-local capture below is
  // empty in the next JS realm. Written ONLY when the key holds no value:
  // OLDEST EVIDENCE WINS, a later boot's rewrite must never overwrite the
  // original corrupt raw. A failed write only warns; this boot still
  // classifies through the process-local capture.
  try {
    if (localStorage.getItem(getWindowLayoutPreMigrationRawKey()) === null) {
      localStorage.setItem(getWindowLayoutPreMigrationRawKey(), originalRaw)
    }
  } catch (error) {
    warnStructured('fresh_agent_layout_evidence_write_failed', {
      key: getWindowLayoutPreMigrationRawKey(),
      error: error instanceof Error ? error.message : String(error),
    })
  }

  preMigrationLayoutRaw = originalRaw
  try {
    localStorage.setItem(layoutKey, migratedRaw)
  } catch (error) {
    try {
      localStorage.removeItem(pendingMarkerKey)
    } catch {
      // keep the original write failure as the useful signal
    }
    warnStructured('fresh_agent_layout_write_failed', {
      key: layoutKey,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }

  try {
    localStorage.setItem(commitMarkerKey, JSON.stringify({
      version: 1,
      migration: LAYOUT_FRESH_AGENT_MIGRATION_ID,
      backupKey: LAYOUT_FRESH_AGENT_BACKUP_KEY,
      originalHash: hashPersistedLayoutRaw(originalRaw),
      migratedHash: hashPersistedLayoutRaw(migratedRaw),
      committedAt: Date.now(),
    }))
  } catch (error) {
    warnStructured('fresh_agent_layout_commit_marker_write_failed', {
      key: commitMarkerKey,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }

  try {
    localStorage.removeItem(pendingMarkerKey)
  } catch (error) {
    warnStructured('fresh_agent_layout_pending_marker_cleanup_failed', {
      key: pendingMarkerKey,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  return true
}

function migratePersistedLayout(): PersistedLayoutMigrationResult {
  const expectedCurrentRaw = localStorage.getItem(getWindowLayoutKey())
  const raw = readRecoverablePersistedLayoutRaw()
  if (!raw) return 'none'

  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    return 'none'
  }

  if (!parsed || typeof parsed !== 'object' || !parsed.tabs || !parsed.panes) {
    return 'none'
  }

  const nextTabs = Array.isArray(parsed.tabs.tabs)
    ? parsed.tabs.tabs.map((tab: Record<string, unknown>) => normalizeLayoutTab(tab))
    : []
  const nextLayouts = parsed.panes.layouts && typeof parsed.panes.layouts === 'object'
    ? Object.fromEntries(
      Object.entries(parsed.panes.layouts as Record<string, unknown>).map(([tabId, node]) => [tabId, normalizeLayoutNode(node)]),
    )
    : {}

  const migratedRaw = JSON.stringify({
    persistedAt: typeof parsed.persistedAt === 'number' ? parsed.persistedAt : Date.now(),
    version: LAYOUT_SCHEMA_VERSION,
    machineId: typeof parsed.machineId === 'string' && parsed.machineId ? parsed.machineId : undefined,
    tabs: {
      ...parsed.tabs,
      activeTabId: parsed.tabs.activeTabId ?? null,
      tabs: nextTabs,
    },
    panes: {
      version: Math.max(typeof parsed.panes.version === 'number' ? parsed.panes.version : 1, PANES_SCHEMA_VERSION),
      layouts: nextLayouts,
      activePane: parsed.panes.activePane ?? {},
      paneTitles: parsed.panes.paneTitles ?? {},
      paneTitleSetByUser: parsed.panes.paneTitleSetByUser ?? {},
    },
    tombstones: Array.isArray(parsed.tombstones) ? parsed.tombstones : [],
  })

  return writeMigratedLayoutWithRecovery(raw, migratedRaw, expectedCurrentRaw ?? raw) ? 'migrated' : 'failed'
}

function preservePersistedLayout(): PersistedLayoutMigrationResult {
  if (hasFreshAgentLayoutMigrationMarkerForCurrentRaw()) {
    return 'none'
  }

  const migrated = migratePersistedLayout()
  if (migrated !== 'none') {
    return migrated
  }

  if (!migrateV2ToV3()) {
    return 'none'
  }

  return migratePersistedLayout()
}

/** One-time LEGACY adoption (delta round 3, finding 1): when this window's
 * derived per-window layout key is ABSENT but the pre-change origin-wide
 * key exists — the single-window migration path — adopt the legacy
 * envelope as this window's own: a byte-identical copy into the derived
 * key, which the normal preserve/migrate flow below then migrates exactly
 * as today. The legacy key is NEVER deleted: other live pre-change windows
 * may still read it, and new windows without an envelope rebuild via the
 * machine-bootstrap inventory. Adoption runs only when the derived key is
 * absent — a window that already has its own envelope ignores later
 * legacy-key writes from pre-change windows. */
function adoptLegacyLayoutIntoWindowKey(): void {
  const ownKey = getWindowLayoutKey()
  try {
    if (localStorage.getItem(ownKey) !== null) return
    const legacyRaw = localStorage.getItem(LEGACY_LAYOUT_STORAGE_KEY)
    if (legacyRaw === null) return
    localStorage.setItem(ownKey, legacyRaw)
    log.info('Adopted the legacy layout envelope into this window\u2019s per-window key.')
  } catch (error) {
    warnStructured('layout_legacy_adoption_write_failed', {
      key: ownKey,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export function runStorageMigration(): void {
  try {
    adoptLegacyLayoutIntoWindowKey()
    const currentVersion = readStorageVersion()
    if (currentVersion >= STORAGE_VERSION) {
      const migratedLayout = preservePersistedLayout()
      if (migratedLayout === 'failed') {
        warnStructured('fresh_agent_layout_migration_aborted', {
          key: getWindowLayoutKey(),
        })
      }
      if (migratedLayout === 'migrated') {
        log.info('Migrated localStorage fresh-agent layout state without changing storage version.')
      }
      return
    }

    const preservedAuthToken = localStorage.getItem(AUTH_STORAGE_KEY)
    const migratedLayout = preservePersistedLayout()
    if (migratedLayout === 'failed') {
      warnStructured('fresh_agent_layout_migration_aborted', {
        key: getWindowLayoutKey(),
      })
      return
    }
    clearFreshellKeysExcept(
      [
        AUTH_STORAGE_KEY,
        BROWSER_PREFERENCES_STORAGE_KEY,
        ...LEGACY_BROWSER_PREFERENCE_KEYS,
      ],
      [
        // Every window's envelope, .bak, fresh-agent channels, and
        // pre-migration evidence sidecar — plus the never-deleted legacy
        // shapes of all of them (covered by the same prefixes).
        LAYOUT_STORAGE_KEY_PREFIX,
        LAYOUT_PRE_MIGRATION_RAW_KEY_PREFIX,
      ],
    )

    if (preservedAuthToken) {
      localStorage.setItem(AUTH_STORAGE_KEY, preservedAuthToken)
    } else {
      clearAuthCookie()
    }

    localStorage.setItem(STORAGE_VERSION_KEY, String(STORAGE_VERSION))
    log.info(
      `Migrated localStorage (version ${currentVersion} → ${STORAGE_VERSION}) ` +
      `${migratedLayout === 'migrated' ? 'while preserving restorable layout state.' : 'without preserved layout state.'}`
    )
  } catch (err) {
    log.warn('Storage migration failed:', err)
  }
}

// Execute immediately when this module is imported
runStorageMigration()

export {} // Make this a module
