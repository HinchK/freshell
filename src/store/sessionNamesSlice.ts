/**
 * Unified agent names (Task 5) — the client's revisioned canonical cache.
 *
 * One saved name per scoped Claude/Codex/OpenCode session (terminal modes
 * claude/codex/opencode, fresh types freshclaude/freshcodex/freshopencode).
 * The server's `SessionNames` store is the authority; this slice is the
 * client's LAST-KNOWN projection of it. Records and pending→durable
 * redirects merge by their own server revisions (never arrival time),
 * nativeSync status merges by documentGeneration, and a status-only update
 * can never retitle a session.
 *
 * Intentionally NOT persisted: this cache is rebuilt from the server on
 * every ready/reconnect (batch bootstrap) and from every live projection
 * (session.name.updated pushes, directory rows, terminal inventory, fresh
 * snapshots). Nothing here is an independent name authority.
 */
import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { Middleware } from '@reduxjs/toolkit'
import {
  SessionNameRecordSchema,
  SessionNameUpdateSchema,
  sessionNameRefKey,
  type NativeSync,
  type SessionNameRecord,
  type SessionNameRef,
  type SessionNameUpdate,
} from '@shared/session-names'
import { createLogger } from '@/lib/client-logger'

const log = createLogger('SessionNames')

export interface SessionNamesRedirectEntry {
  toKey: string
  revision: number
}

export interface SessionNamesState {
  /** Canonical records by encoded ref key. */
  records: Record<string, SessionNameRecord>
  /** pending→durable redirects by encoded FROM key. */
  redirects: Record<string, SessionNamesRedirectEntry>
  /** Native writeback status by encoded (resolved) ref key, ordered by
   * documentGeneration — display/status data, never a name authority. */
  nativeSync: Record<string, { sync: NativeSync; documentGeneration: number }>
}

export interface SessionNameProjection {
  ref: SessionNameRef
  record: SessionNameRecord
}

const initialState: SessionNamesState = {
  records: {},
  redirects: {},
  nativeSync: {},
}

/** Fold one batch of canonical server updates (schema-validated on the wire). */
function foldUpdates(state: SessionNamesState, updates: SessionNameUpdate[]): void {
  for (const raw of updates) {
    const parsed = SessionNameUpdateSchema.safeParse(raw)
    if (!parsed.success) {
      log.error('session name update failed schema validation', { issues: parsed.error.issues })
      continue
    }
    const update = parsed.data
    for (const redirect of update.redirects) {
      const fromKey = sessionNameRefKey(redirect.from)
      const toKey = sessionNameRefKey(redirect.to)
      if (fromKey === toKey) continue
      const existing = state.redirects[fromKey]
      if (!existing || existing.revision < redirect.revision) {
        state.redirects[fromKey] = { toKey, revision: redirect.revision }
      } else if (
        existing.revision === redirect.revision
        && existing.toKey !== toKey
      ) {
        // Symmetric with the equal-revision record case: same redirect
        // revision carrying a different target is a protocol error; the
        // existing redirect is retained and the mismatch is logged.
        log.error('session name protocol error: equal redirect revision carries different target', {
          fromKey,
          revision: redirect.revision,
        })
      }
    }
    foldRecord(state, update.record)
    foldNativeSync(state, resolveNativeSyncKey(state, sessionNameRefKey(update.record.ref)), update)
  }
}

/** Fold one record by its own revision. Never retitles on a stale/lower
 * revision; equal revision is idempotent, and equal revision with different
 * content is a protocol error (existing retained, error logged). */
function foldRecord(state: SessionNamesState, record: SessionNameRecord): void {
  const key = sessionNameRefKey(record.ref)
  const existing = state.records[key]
  if (!existing) {
    state.records[key] = record
    return
  }
  if (record.revision > existing.revision) {
    state.records[key] = record
    return
  }
  if (record.revision === existing.revision && record.name !== existing.name) {
    log.error('session name protocol error: equal revision carries different content', {
      refKey: key,
      revision: record.revision,
    })
  }
}

/** Redirect remap: when a pending→durable redirect lands, move any record
 * still parked at the pending key onto the durable key, keeping the highest
 * revision at the target. */
function remapRedirectedRecords(state: SessionNamesState): void {
  for (const [fromKey, entry] of Object.entries(state.redirects)) {
    const fromRecord = state.records[fromKey]
    if (!fromRecord) continue
    const toRecord = state.records[entry.toKey]
    if (!toRecord || toRecord.revision < fromRecord.revision) {
      state.records[entry.toKey] = fromRecord
    }
    delete state.records[fromKey]
  }
}

/** Follow pending→durable redirects to the final ref key (chain-bounded),
 * so a status update delivered at a pre-redirect pending key parks its
 * nativeSync at the RESOLVED key instead of an orphaned one. */
function resolveNativeSyncKey(state: SessionNamesState, key: string): string {
  let resolved = key
  for (let hops = 0; hops < 8; hops += 1) {
    const redirect = state.redirects[resolved]
    if (!redirect) break
    resolved = redirect.toKey
  }
  return resolved
}

/** Fold the native-writeback projection by documentGeneration. Status-only
 * changes (changed:false, unchanged record revision) update ONLY this —
 * the record fold above is what gates any retitle. */
function foldNativeSync(state: SessionNamesState, key: string, update: SessionNameUpdate): void {
  if (!update.nativeSync) return
  const prev = state.nativeSync[key]
  if (prev && update.documentGeneration < prev.documentGeneration) return
  if (
    prev
    && update.documentGeneration === prev.documentGeneration
    && (prev.sync.status !== update.nativeSync.status || prev.sync.reason !== update.nativeSync.reason)
  ) {
    log.error('session name protocol error: equal nativeSync generation carries different status', {
      refKey: key,
      documentGeneration: update.documentGeneration,
    })
    return
  }
  state.nativeSync[key] = {
    sync: update.nativeSync,
    documentGeneration: update.documentGeneration,
  }
}

const sessionNamesSlice = createSlice({
  name: 'sessionNames',
  initialState,
  reducers: {
    /** Fold canonical `SessionNameUpdate`s (WS pushes, HTTP responses,
     * bootstrap reads). */
    receiveSessionNames(state, action: PayloadAction<SessionNameUpdate[]>) {
      foldUpdates(state, action.payload)
      remapRedirectedRecords(state)
    },
    /** Fold bare last-known projections (directory rows, terminal inventory,
     * fresh snapshots) by revision. Records are schema-validated so a
     * malformed row never enters the cache. */
    receiveSessionNameProjections(state, action: PayloadAction<SessionNameProjection[]>) {
      for (const projection of action.payload) {
        const parsed = SessionNameRecordSchema.safeParse(projection.record)
        if (!parsed.success) {
          log.error('session name projection failed schema validation', {
            refKey: sessionNameRefKey(projection.ref),
            issues: parsed.error.issues,
          })
          continue
        }
        foldRecord(state, parsed.data)
      }
      remapRedirectedRecords(state)
    },
  },
})

export const { receiveSessionNames, receiveSessionNameProjections } = sessionNamesSlice.actions
export default sessionNamesSlice.reducer

/**
 * Terminal-inventory snapshots carry last-known `sessionName` records +
 * `nameRef` on their rows; ingest them into the canonical cache at every
 * window commit so a scoped name converges regardless of which surface
 * fetched first. (Session-directory rows carry only a name STRING projection
 * — they are display fallbacks, not cache records; the sidebar reads the
 * string directly.)
 */
export const sessionNamesIngestMiddleware: Middleware = (store) => (next) => (action: any) => {
  const result = next(action)
  if (typeof action?.type === 'string' && INGEST_ACTION_TYPES.has(action.type)) {
    const state = store.getState() as { terminalDirectory?: { windows?: Record<string, { items?: Array<Record<string, unknown>> }> } }
    const projections: SessionNameProjection[] = []
    for (const window of Object.values(state.terminalDirectory?.windows ?? {})) {
      for (const item of window?.items ?? []) {
        if (item?.nameRef && item?.sessionName) {
          // The slice re-validates every record on fold; the untyped row
          // shape needs only the assertion to cross the action boundary.
          projections.push({ ref: item.nameRef as SessionNameRef, record: item.sessionName as SessionNameRecord })
        }
      }
    }
    if (projections.length > 0) {
      store.dispatch(receiveSessionNameProjections(projections))
    }
  }
  return result
}

const INGEST_ACTION_TYPES = new Set([
  'terminalDirectory/setTerminalDirectoryWindowData',
])
