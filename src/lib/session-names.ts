/**
 * Unified agent names (Task 5) — HTTP calls against the server's canonical
 * session-names routes: the batch bootstrap read (chunked at 100 refs) and
 * the captured-target rename. HTTP failures retain the server's error code
 * and the accepted record for the error UI.
 */
import { api, ApiError } from '@/lib/api'
import { createLogger } from '@/lib/client-logger'
import {
  SessionNameUpdateSchema,
  sessionNameRefKey,
  type NameIntent,
  type RenameSessionNameRequest,
  type SessionNameRef,
  type SessionNameUpdate,
} from '@shared/session-names'

const log = createLogger('SessionNames')

/** Client batch reads are chunked to this many refs per request. */
export const SESSION_NAMES_READ_CHUNK = 100

export class SessionNameRenameError extends Error {
  /** The HTTP status, when the failure was an HTTP response. */
  status?: number
  /** The server's machine-readable error code (`error` field of the body). */
  serverCode?: string
  /** The accepted canonical update the server carried on a conflict — the
   * error UI folds this so the winner is visible everywhere. */
  acceptedUpdate?: SessionNameUpdate
}

/** POST /api/session-names/read — batch bootstrap. Unknown refs are omitted
 * by the server; a chunked read still returns every resolvable update. */
export async function bootstrapSessionNames(
  refs: SessionNameRef[],
  options: { signal?: AbortSignal } = {},
): Promise<SessionNameUpdate[]> {
  const updates: SessionNameUpdate[] = []
  for (let index = 0; index < refs.length; index += SESSION_NAMES_READ_CHUNK) {
    const chunk = refs.slice(index, index + SESSION_NAMES_READ_CHUNK)
    const body = await api.post<{ names?: unknown }>(
      '/api/session-names/read',
      { refs: chunk },
      options,
    )
    for (const raw of Array.isArray(body?.names) ? body.names : []) {
      const parsed = SessionNameUpdateSchema.safeParse(raw)
      if (!parsed.success) {
        log.error('session name read returned an invalid update', { issues: parsed.error.issues })
        continue
      }
      updates.push(parsed.data)
    }
  }
  return updates
}

/** PATCH /api/session-names — the canonical rename. The caller captures
 * target + revision before opening the editor and passes them here. */
export async function renameSessionName(
  input: RenameSessionNameRequest,
  options: { signal?: AbortSignal } = {},
): Promise<SessionNameUpdate> {
  try {
    const body = await api.patch<unknown>('/api/session-names', input, options)
    const parsed = SessionNameUpdateSchema.safeParse(body)
    if (!parsed.success) {
      throw new SessionNameRenameError('the server returned an invalid session name update')
    }
    return parsed.data
  } catch (error) {
    // Aborts keep their native shape so callers' abort checks work.
    if (error instanceof Error && error.name === 'AbortError') throw error
    throw toRenameError(error)
  }
}

/** Normalize any rename failure into the typed error carrying the server's
 * code and accepted record. */
export function toRenameError(error: unknown): SessionNameRenameError {
  if (error instanceof SessionNameRenameError) return error
  const renameError = new SessionNameRenameError(
    error instanceof Error ? error.message : 'Failed to rename session',
  )
  if (error instanceof ApiError) {
    renameError.status = error.status
    const data = (error as unknown as { data?: unknown }).data
    if (data && typeof data === 'object') {
      const body = data as { error?: unknown; sessionName?: unknown }
      if (typeof body.error === 'string') renameError.serverCode = body.error
      const accepted = SessionNameUpdateSchema.safeParse(body.sessionName)
      if (accepted.success) renameError.acceptedUpdate = accepted.data
    }
  }
  return renameError
}

/** Collect every naming ref this client currently knows about — open panes,
 * directory rows, and background terminals — for the ready/reconnect batch
 * bootstrap (independent of the mounted composer/history page). */
export function collectSessionNameRefs(state: {
  panes?: { layouts?: Record<string, import('@/store/paneTypes').PaneNode> }
  sessions?: { windows?: Record<string, { projects?: Array<{ sessions?: Array<{ nameRef?: unknown }> }> }> }
  terminalDirectory?: { windows?: Record<string, { items?: Array<{ nameRef?: unknown }> }> }
}): SessionNameRef[] {
  const keys = new Set<string>()
  const refs: SessionNameRef[] = []

  const push = (ref: unknown) => {
    const parsed = parseSessionNameRef(ref)
    if (!parsed) return
    const key = sessionNameRefKey(parsed)
    if (keys.has(key)) return
    keys.add(key)
    refs.push(parsed)
  }

  for (const layout of Object.values(state.panes?.layouts ?? {})) {
    if (!layout) continue
    collectPaneRefs(layout, push)
  }
  for (const window of Object.values(state.sessions?.windows ?? {})) {
    for (const project of window?.projects ?? []) {
      for (const session of project?.sessions ?? []) {
        push(session?.nameRef)
      }
    }
  }
  for (const window of Object.values(state.terminalDirectory?.windows ?? {})) {
    for (const item of window?.items ?? []) {
      push(item?.nameRef)
    }
  }
  return refs
}

function collectPaneRefs(
  node: import('@/store/paneTypes').PaneNode,
  push: (ref: unknown) => void,
): void {
  if (node.type === 'leaf') {
    const content = node.content as Record<string, unknown>
    if (content.kind === 'terminal' || content.kind === 'fresh-agent') {
      push(content.nameRef)
      if (typeof content.namingHandle === 'string' && content.namingHandle.length > 0) {
        push({ kind: 'pending', id: content.namingHandle })
      }
      const sessionRef = content.sessionRef as { provider?: unknown; sessionId?: unknown } | undefined
      if (
        typeof sessionRef?.provider === 'string'
        && typeof sessionRef?.sessionId === 'string'
        && sessionRef.sessionId.length > 0
      ) {
        push({ kind: 'session', provider: sessionRef.provider, sessionId: sessionRef.sessionId })
      }
    }
    return
  }
  collectPaneRefs(node.children[0], push)
  collectPaneRefs(node.children[1], push)
}

/** Parse an unknown naming-ref-shaped value; undefined for anything else. */
export function parseSessionNameRef(value: unknown): SessionNameRef | undefined {
  if (!value || typeof value !== 'object') return undefined
  const ref = value as { kind?: unknown; id?: unknown; provider?: unknown; sessionId?: unknown }
  if (ref.kind === 'pending' && typeof ref.id === 'string' && ref.id.length > 0) {
    return { kind: 'pending', id: ref.id }
  }
  if (
    ref.kind === 'session'
    && typeof ref.provider === 'string'
    && typeof ref.sessionId === 'string'
    && ref.sessionId.length > 0
  ) {
    return { kind: 'session', provider: ref.provider as 'claude' | 'codex' | 'opencode', sessionId: ref.sessionId }
  }
  return undefined
}

/** Parse a name-intent CLI/MCP argument: only `user` and `automatic` are
 * accepted; anything else is a loud error (never a silent default). */
export function parseNameIntent(value: unknown): NameIntent {
  if (value === 'user' || value === 'automatic') return value
  throw new Error('--name-intent must be "user" or "automatic"')
}

/** Schema-parse a canonical update riding on any response body
 * (`sessionName`) or error body. Returns undefined for absent/invalid — a
 * malformed projection never enters the cache. */
export function parseSessionNameUpdate(value: unknown): SessionNameUpdate | undefined {
  const parsed = SessionNameUpdateSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
