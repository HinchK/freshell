import { createLogger } from '@/lib/client-logger'
import {
  createTerminalSurfaceCheckpoint,
  type TerminalSurfaceCheckpoint,
  type TerminalGeometryAuthority,
  type TerminalBufferType,
} from '@/lib/terminal-surface-checkpoint'
import { TERMINAL_CURSOR_STORAGE_KEY } from '@/store/storage-keys'

const log = createLogger('TerminalCursor')

export type CheckpointEntry = {
  checkpoint: TerminalSurfaceCheckpoint
  updatedAt: number
}

export type CursorEntry = CheckpointEntry

export type TerminalSurfaceCheckpointIdentity = {
  streamId: string | null
  serverInstanceId: string
  serverBootId?: string
}

/**
 * Surface scoping (responsive-terminal-restore WS2): checkpoints are keyed by
 * the surface that rendered them — a pane/surface instance — so sibling panes
 * rendering the same terminal cannot borrow or overwrite each other's
 * rendered progress. The pane id is the stable per-surface discriminator (the
 * attachRequestId already embeds `${paneId}:`). An absent scope addresses
 * the legacy terminal-keyed store and never sees scoped entries.
 */
export type TerminalSurfaceScope = { paneId?: string }

const SURFACE_KEY_SEPARATOR = '::'

function surfaceStoreKey(scope: TerminalSurfaceScope | undefined, terminalId: string): string {
  return scope?.paneId ? `${scope.paneId}${SURFACE_KEY_SEPARATOR}${terminalId}` : terminalId
}

type CursorMap = Record<string, CheckpointEntry>

const MAX_ENTRIES = 500
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
const PERSIST_DEBOUNCE_MS = 200
const PRUNE_INTERVAL_MS = 60 * 1000

let cache: CursorMap | null = null
let lastPruneAt = 0
let pendingPersist = false
let persistTimer: ReturnType<typeof setTimeout> | null = null

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined'
}

function normalizeSeq(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  const seq = Math.floor(value)
  return seq >= 0 ? seq : 0
}

function normalizeTimestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  const at = Math.floor(value)
  return at >= 0 ? at : 0
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isGeometryAuthority(value: unknown): value is TerminalGeometryAuthority {
  return value === 'single_client'
    || value === 'server_stream'
    || value === 'multi_client_unknown'
}

function isBufferType(value: unknown): value is TerminalBufferType {
  return value === 'normal' || value === 'alternate' || value === 'unknown'
}

function sanitizeCheckpoint(
  terminalId: string,
  raw: unknown,
): TerminalSurfaceCheckpoint | null {
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as Record<string, unknown>
  if (candidate.terminalId !== terminalId) return null
  if (typeof candidate.serverInstanceId !== 'string' || candidate.serverInstanceId.length === 0) return null
  if (typeof candidate.attachRequestId !== 'string' || candidate.attachRequestId.length === 0) return null
  if (typeof candidate.xtermVersion !== 'string' || candidate.xtermVersion.length === 0) return null
  if (!isGeometryAuthority(candidate.geometryAuthority)) return null

  const checkpoint = createTerminalSurfaceCheckpoint({
    terminalId,
    streamId: stringOrNull(candidate.streamId),
    serverInstanceId: candidate.serverInstanceId,
    serverBootId: optionalString(candidate.serverBootId),
    surfaceEpoch: normalizeSeq(candidate.surfaceEpoch),
    attachRequestId: candidate.attachRequestId,
    parserAppliedSeq: normalizeSeq(candidate.parserAppliedSeq),
    ...(typeof candidate.surfaceCoverageSeq === 'number'
      ? { surfaceCoverageSeq: normalizeSeq(candidate.surfaceCoverageSeq) }
      : {}),
    cols: normalizeSeq(candidate.cols),
    rows: normalizeSeq(candidate.rows),
    geometryEpoch: normalizeSeq(candidate.geometryEpoch),
    geometryAuthority: candidate.geometryAuthority,
    scrollback: normalizeSeq(candidate.scrollback),
    xtermVersion: candidate.xtermVersion,
    bufferType: isBufferType(candidate.bufferType) ? candidate.bufferType : 'unknown',
    parserIdle: candidate.parserIdle === true,
  })

  // A checkpoint needs SOME resumable position: rendered content (applied)
  // or accounted coverage past a null-screen-effect filtered prefix.
  if (checkpoint.parserAppliedSeq <= 0 && (checkpoint.surfaceCoverageSeq ?? 0) <= 0) return null
  return checkpoint
}

function terminalIdFromStoreKey(key: string): string {
  const separatorIndex = key.lastIndexOf(SURFACE_KEY_SEPARATOR)
  return separatorIndex === -1 ? key : key.slice(separatorIndex + SURFACE_KEY_SEPARATOR.length)
}

function sanitizeMap(raw: unknown): CursorMap {
  if (!raw || typeof raw !== 'object') return {}
  const input = raw as Record<string, unknown>
  const out: CursorMap = {}

  for (const [storeKey, value] of Object.entries(input)) {
    if (!storeKey) continue
    if (!value || typeof value !== 'object') continue

    const candidate = value as Record<string, unknown>
    // Scoped keys embed the terminal id (`${paneId}::${terminalId}`); the
    // checkpoint must still self-identify with that terminal.
    const checkpoint = sanitizeCheckpoint(terminalIdFromStoreKey(storeKey), candidate.checkpoint)
    const updatedAt = normalizeTimestamp(candidate.updatedAt)
    if (!checkpoint || updatedAt <= 0) continue

    out[storeKey] = { checkpoint, updatedAt }
  }

  return out
}

function pruneCursorMap(map: CursorMap, now: number): CursorMap {
  const cutoff = now - MAX_AGE_MS
  const retained: Array<{ terminalId: string; entry: CursorEntry }> = []

  for (const [terminalId, entry] of Object.entries(map)) {
    if (entry.updatedAt < cutoff) continue
    retained.push({ terminalId, entry })
  }

  retained.sort((a, b) => b.entry.updatedAt - a.entry.updatedAt)

  const trimmed = retained.slice(0, MAX_ENTRIES)
  const out: CursorMap = {}
  for (const { terminalId, entry } of trimmed) {
    out[terminalId] = entry
  }

  return out
}

function areCursorMapsEqual(a: CursorMap, b: CursorMap): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false

  for (const key of aKeys) {
    const aEntry = a[key]
    const bEntry = b[key]
    if (!aEntry || !bEntry) return false
    if (aEntry.updatedAt !== bEntry.updatedAt) return false
    if (JSON.stringify(aEntry.checkpoint) !== JSON.stringify(bEntry.checkpoint)) return false
  }

  return true
}

function persistMap(map: CursorMap): void {
  if (!canUseStorage()) return
  try {
    localStorage.setItem(TERMINAL_CURSOR_STORAGE_KEY, JSON.stringify(map))
  } catch (error) {
    log.warn('Failed to persist terminal cursor map:', error)
  }
}

function flushPersist(): void {
  if (!pendingPersist) return
  if (!cache) {
    pendingPersist = false
    return
  }
  pendingPersist = false
  persistMap(cache)
}

function schedulePersist(): void {
  if (!canUseStorage()) return
  pendingPersist = true
  if (persistTimer) return

  persistTimer = setTimeout(() => {
    persistTimer = null
    flushPersist()
  }, PERSIST_DEBOUNCE_MS)
}

function ensureLoaded(): CursorMap {
  if (cache) return cache
  if (!canUseStorage()) {
    cache = {}
    return cache
  }

  let parsed: CursorMap = {}
  try {
    const raw = localStorage.getItem(TERMINAL_CURSOR_STORAGE_KEY)
    if (raw) {
      parsed = sanitizeMap(JSON.parse(raw))
    }
  } catch (error) {
    log.warn('Failed to load terminal cursor map:', error)
  }

  const now = Date.now()
  const pruned = pruneCursorMap(parsed, now)
  lastPruneAt = now
  cache = pruned

  const changed = !areCursorMapsEqual(parsed, pruned)
  if (changed) {
    persistMap(pruned)
  }

  return cache
}

function sameCheckpointSurface(
  a: TerminalSurfaceCheckpoint,
  b: TerminalSurfaceCheckpoint,
): boolean {
  return a.terminalId === b.terminalId
    && a.streamId === b.streamId
    && a.serverInstanceId === b.serverInstanceId
    && a.serverBootId === b.serverBootId
    && a.surfaceEpoch === b.surfaceEpoch
    && a.cols === b.cols
    && a.rows === b.rows
    && a.geometryEpoch === b.geometryEpoch
    && a.geometryAuthority === b.geometryAuthority
    && a.scrollback === b.scrollback
    && a.xtermVersion === b.xtermVersion
    && a.bufferType === b.bufferType
}

function coveragePositionOf(checkpoint: TerminalSurfaceCheckpoint): number {
  const coverage = checkpoint.surfaceCoverageSeq
  // Zero coverage = no contiguous coverage beyond the applied position (a
  // rendered tail with a lost prefix): fall back to applied, exactly the
  // pre-cursor ranking behavior.
  if (typeof coverage !== 'number' || !Number.isFinite(coverage) || coverage <= 0) {
    return checkpoint.parserAppliedSeq
  }
  return Math.floor(coverage)
}

function chooseCheckpoint(
  existing: TerminalSurfaceCheckpoint | undefined,
  next: TerminalSurfaceCheckpoint,
): TerminalSurfaceCheckpoint {
  if (!existing) return next
  if (!sameCheckpointSurface(existing, next)) return next
  // Overwrite prevention: keep the most advanced reconstruction position —
  // coverage first (it subsumes the rendered baseline), applied as the
  // legacy tiebreak. A regressed save can never clobber real progress.
  const existingCoverage = coveragePositionOf(existing)
  const nextCoverage = coveragePositionOf(next)
  if (existingCoverage > nextCoverage) return existing
  if (existingCoverage < nextCoverage) return next
  if (existing.parserAppliedSeq > next.parserAppliedSeq) return existing
  return next
}

function saveCheckpointEntry(
  checkpoint: TerminalSurfaceCheckpoint,
  scope: TerminalSurfaceScope | undefined,
): void {
  if (!checkpoint.terminalId) return
  if (checkpoint.parserAppliedSeq <= 0 && (checkpoint.surfaceCoverageSeq ?? 0) <= 0) return

  const map = ensureLoaded()
  const now = Date.now()
  const storeKey = surfaceStoreKey(scope, checkpoint.terminalId)
  const existing = map[storeKey]
  const nextCheckpoint = chooseCheckpoint(existing?.checkpoint, checkpoint)
  map[storeKey] = { checkpoint: nextCheckpoint, updatedAt: now }

  const shouldPrune = Object.keys(map).length > MAX_ENTRIES
    || now - lastPruneAt >= PRUNE_INTERVAL_MS
  const nextMap = shouldPrune
    ? pruneCursorMap(map, now)
    : map
  if (shouldPrune) {
    lastPruneAt = now
  }
  cache = nextMap

  schedulePersist()
}

export function loadTerminalSurfaceCheckpoint(
  terminalId: string,
  identity: TerminalSurfaceCheckpointIdentity,
  scope?: TerminalSurfaceScope,
): TerminalSurfaceCheckpoint | null {
  if (!terminalId) return null
  const entry = ensureLoaded()[surfaceStoreKey(scope, terminalId)]
  if (!entry) return null

  const checkpoint = entry.checkpoint
  if (checkpoint.terminalId !== terminalId) return null
  if (checkpoint.streamId !== (identity.streamId ?? null)) return null
  if (checkpoint.serverInstanceId !== identity.serverInstanceId) return null
  if ((checkpoint.serverBootId ?? null) !== (identity.serverBootId ?? null)) return null

  return { ...checkpoint }
}

export function saveTerminalSurfaceCheckpoint(
  input: TerminalSurfaceCheckpoint,
  scope?: TerminalSurfaceScope,
): void {
  saveCheckpointEntry(createTerminalSurfaceCheckpoint(input), scope)
}

export function loadTerminalCursor(terminalId: string): number {
  void terminalId
  return 0
}

export function saveTerminalCursor(terminalId: string, seq: number): void {
  void terminalId
  void seq
}

export function clearTerminalCursor(terminalId: string): void {
  if (!terminalId) return
  const map = ensureLoaded()
  // Surface-scoped entries live under `${paneId}::${terminalId}` keys — a
  // terminal-wide clear must remove every pane's entry for the terminal.
  const matchingKeys = Object.keys(map).filter((key) => (
    map[key]?.checkpoint.terminalId === terminalId
  ))
  if (matchingKeys.length === 0) return
  for (const key of matchingKeys) {
    delete map[key]
  }
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  pendingPersist = false
  persistMap(map)
}

export function getCursorMapSize(): number {
  return Object.keys(ensureLoaded()).length
}

export function __resetTerminalCursorCacheForTests(): void {
  cache = null
  lastPruneAt = 0
  pendingPersist = false
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
}
