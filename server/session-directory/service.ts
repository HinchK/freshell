import type { CodingCliProvider } from '../coding-cli/provider.js'
import type { ProjectGroup } from '../coding-cli/types.js'
import { logger } from '../logger.js'
import type { TerminalMeta } from '../terminal-metadata-service.js'
import { extractSnippet, searchSessionFile } from './file-search.js'
import { MAX_DIRECTORY_PAGE_ITEMS } from '../../shared/read-models.js'
import { matchTitleTierMetadata } from '../../shared/session-title-search.js'
import {
  buildSessionDirectoryComparableSnapshot,
  compareSessionDirectoryComparableItems,
} from './projection.js'
import type {
  SessionDirectoryItem,
  SessionDirectoryPage,
  SessionDirectoryQuery,
} from './types.js'

type QuerySessionDirectoryInput = {
  projects: ProjectGroup[]
  query: SessionDirectoryQuery
  terminalMeta: TerminalMeta[]
  providers?: CodingCliProvider[]
  signal?: AbortSignal
}

type FileSearchResult = {
  items: SessionDirectoryItem[]
  partial?: true
  partialReason?: 'budget' | 'io_error'
}

type CursorPayload = {
  lastActivityAt: number
  key: string
}

const IDENTITY_COLLISION_KEY_SAMPLE_LIMIT = 20

function buildSessionKey(item: { provider: string; sessionId: string }): string {
  return `${item.provider}:${item.sessionId}`
}

type PersistedIdentityCollision = {
  /** Internal only: used to quarantine every conflicting persisted row, never serialized. */
  keys: ReadonlySet<string>
  collisionCount: number
  duplicateItemCount: number
  collisionKeySamples: readonly string[]
  collisionKeySamplesTruncated: boolean
}

/**
 * Remove only persisted rows whose identity is ambiguous. Live terminals are
 * deliberately joined afterwards: their terminal-owned identity can still be
 * rendered as a generic running row without choosing between conflicting
 * transcript metadata.
 */
function quarantinePersistedProjects(
  projects: ProjectGroup[],
  collisionKeys: ReadonlySet<string>,
): ProjectGroup[] {
  return projects.map((project) => {
    const sessions = project.sessions.filter((session) => !collisionKeys.has(buildSessionKey(session)))
    return sessions.length === project.sessions.length ? project : { ...project, sessions }
  })
}

export class SessionDirectoryCursorError extends Error {
  constructor() {
    super('Invalid session-directory cursor')
    this.name = 'SessionDirectoryCursorError'
  }
}

/**
 * Detect identity corruption before any visibility/filter/pagination work.
 *
 * A collision is still an ERROR-level data-integrity event.  It must not,
 * however, make every healthy session inaccessible because a user copied one
 * transcript into a session directory.  Callers quarantine all rows for the
 * conflicted identities, return the remaining unambiguous rows, and expose a
 * small actionable integrity state to the client.
 */
function findPersistedIdentityCollisions(
  projects: ProjectGroup[],
): PersistedIdentityCollision | undefined {
  const counts = new Map<string, number>()
  for (const project of projects) {
    for (const session of project.sessions) {
      const key = buildSessionKey(session)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }

  const collisions = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort(([a], [b]) => a.localeCompare(b))
  if (collisions.length === 0) return undefined

  return {
    keys: new Set(collisions.map(([key]) => key)),
    collisionCount: collisions.length,
    duplicateItemCount: collisions.reduce((total, [, count]) => total + count, 0),
    collisionKeySamples: collisions
      .slice(0, IDENTITY_COLLISION_KEY_SAMPLE_LIMIT)
      .map(([key]) => key),
    collisionKeySamplesTruncated: collisions.length > IDENTITY_COLLISION_KEY_SAMPLE_LIMIT,
  }
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string): CursorPayload {
  try {
    const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorPayload>
    if (typeof payload.lastActivityAt !== 'number' || !Number.isFinite(payload.lastActivityAt) || typeof payload.key !== 'string' || payload.key.length === 0) {
      throw new Error('invalid')
    }
    return { lastActivityAt: payload.lastActivityAt, key: payload.key }
  } catch {
    throw new SessionDirectoryCursorError()
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Session-directory request aborted')
  }
}

function compareItems(a: SessionDirectoryItem, b: SessionDirectoryItem): number {
  return compareSessionDirectoryComparableItems(a, b)
}

function applySearch(item: SessionDirectoryItem, queryText: string): SessionDirectoryItem | null {
  const match = matchTitleTierMetadata(item, queryText)
  if (!match) return null

  return {
    ...item,
    matchedIn: match.matchedIn,
    snippet: extractSnippet(match.matchedValue, queryText, 40).slice(0, 140),
  }
}

function joinRunningState(item: SessionDirectoryItem, terminalMeta: TerminalMeta[]): SessionDirectoryItem {
  const match = terminalMeta.find((meta) => (
    meta.provider === item.provider &&
    meta.sessionId === item.sessionId
  ))

  if (!match) {
    return {
      ...item,
      isRunning: false,
    }
  }

  return {
    ...item,
    isRunning: true,
    runningTerminalId: match.terminalId,
  }
}

function providerDisplayName(provider: string): string {
  switch (provider) {
    case 'claude':
      return 'Claude CLI'
    case 'codex':
      return 'Codex CLI'
    case 'opencode':
      return 'OpenCode'
    default:
      return provider
  }
}

function buildLiveTerminalSessionItem(meta: TerminalMeta): SessionDirectoryItem | undefined {
  if (!meta.provider) return undefined

  const sessionId = meta.sessionId || `terminal:${meta.terminalId}`
  const projectPath = meta.checkoutRoot || meta.repoRoot || meta.cwd || `terminal:${meta.terminalId}`

  return {
    provider: meta.provider,
    sessionId,
    projectPath,
    checkoutPath: meta.checkoutRoot,
    title: providerDisplayName(meta.provider),
    lastActivityAt: meta.updatedAt,
    createdAt: meta.updatedAt,
    cwd: meta.cwd,
    sessionType: meta.provider,
    isRunning: true,
    runningTerminalId: meta.terminalId,
    liveTerminalOnly: !meta.sessionId,
    // STATUS-STRIP: live terminal rows carry the terminal's own usage so an
    // active fresh-agent session's meter has data even before/without the
    // indexer's persisted-record parse.
    tokenUsage: meta.tokenUsage,
    // Bug-1 (sidebar rail): mirror the Rust projection
    // (session_directory.rs build_live_terminal_session_item) — a terminal
    // whose opencode resume target is a SUBAGENT (child) session must carry
    // the classification so the default-visibility filter below can drop it.
    ...(meta.resumeTargetIsSubagent ? { isSubagent: true } : {}),
  }
}

function toItems(projects: ProjectGroup[], terminalMeta: TerminalMeta[]): SessionDirectoryItem[] {
  const items = buildSessionDirectoryComparableSnapshot(projects).map((item) => (
    joinRunningState({
      ...item,
      isRunning: false,
    }, terminalMeta)
  ))
  const existingKeys = new Set(items.map(buildSessionKey))

  for (const meta of terminalMeta) {
    const item = buildLiveTerminalSessionItem(meta)
    if (!item) continue
    const key = buildSessionKey(item)
    if (existingKeys.has(key)) continue
    items.push(item)
    existingKeys.add(key)
  }

  return items
}

async function applyFileSearch(
  items: SessionDirectoryItem[],
  queryText: string,
  tier: 'userMessages' | 'fullText',
  input: QuerySessionDirectoryInput,
  limit: number,
): Promise<FileSearchResult> {
  const providersByName = new Map(
    (input.providers ?? []).map((p) => [p.name, p])
  )

  // Build a lookup from sessionKey -> sourceFile from the original projects.
  // The toItems/projection step strips sourceFile, so we must look it up here.
  const sourceFiles = new Map<string, string>()
  for (const project of input.projects) {
    for (const session of project.sessions) {
      if (session.sourceFile) {
        sourceFiles.set(buildSessionKey({ provider: session.provider, sessionId: session.sessionId }), session.sourceFile)
      }
    }
  }

  const results: SessionDirectoryItem[] = []
  const maxScan = limit * 10 // Scan budget to avoid unbounded I/O
  let partial = false
  let partialReason: 'budget' | 'io_error' | undefined

  let scanned = 0
  for (const item of items) {
    if (results.length >= limit + 1) break
    if (scanned >= maxScan) {
      partial = true
      partialReason = 'budget'
      break
    }
    throwIfAborted(input.signal)

    const key = buildSessionKey(item)
    const sourceFile = sourceFiles.get(key)
    if (!sourceFile) continue

    const provider = providersByName.get(item.provider)
    if (!provider) continue

    scanned++

    try {
      const match = await searchSessionFile(provider, sourceFile, queryText, tier, input.signal)
      if (match) {
        results.push({
          ...item,
          matchedIn: match.matchedIn,
          snippet: match.snippet,
        })
      }
    } catch (error) {
      // Re-throw abort errors so they propagate correctly
      if (input.signal?.aborted) throw error
      // Graceful: mark partial and skip sessions with I/O errors
      partial = true
      if (partialReason !== 'budget') {
        partialReason = 'io_error'
      }
      continue
    }
  }

  const result: FileSearchResult = { items: results }
  if (partial) {
    result.partial = true
    result.partialReason = partialReason
  }
  return result
}

export async function querySessionDirectory(input: QuerySessionDirectoryInput): Promise<SessionDirectoryPage> {
  throwIfAborted(input.signal)
  const identityCollision = findPersistedIdentityCollisions(input.projects)
  if (identityCollision) {
    logger.error({
      collisionCount: identityCollision.collisionCount,
      duplicateItemCount: identityCollision.duplicateItemCount,
      collisionKeySamples: identityCollision.collisionKeySamples,
      collisionKeySamplesTruncated: identityCollision.collisionKeySamplesTruncated,
    }, 'Session directory identity collision; omitting conflicted sessions')
  }

  const limit = Math.min(input.query.limit ?? MAX_DIRECTORY_PAGE_ITEMS, MAX_DIRECTORY_PAGE_ITEMS)
  const tier = input.query.tier ?? 'title'
  const cursor = input.query.cursor ? decodeCursor(input.query.cursor) : null
  const revision = Math.max(
    0,
    ...input.projects.flatMap((project) => project.sessions.map((session) => session.lastActivityAt)),
    ...input.terminalMeta.map((meta) => meta.updatedAt),
  )

  // Filter persisted rows BEFORE joining live terminals. This prevents a
  // duplicate file from contributing arbitrary title/path metadata while
  // still allowing a currently running terminal to appear as its safe,
  // terminal-owned placeholder.
  const persistedProjects = identityCollision
    ? quarantinePersistedProjects(input.projects, identityCollision.keys)
    : input.projects

  let items = toItems(persistedProjects, input.terminalMeta).sort(compareItems)

  // STATUS-STRIP: snapshot the extras candidate list BEFORE the sidebar
  // visibility filters too — a fresh-agent pane's own session may be
  // subagent-classed, non-interactive, or untitled/idle, and its meter must
  // stay live regardless of the sidebar window's filtering state. Extras are
  // returned out-of-band and never merged into `items`, so lowering the
  // visibility bar here cannot leak hidden rows into the sidebar.
  const extrasCandidateItems = items

  // Server-side visibility pre-filtering to avoid wasting search budget on
  // sessions the client will hide. Matches the client's default sidebar settings.
  if (!input.query.includeSubagents) {
    items = items.filter((item) => !item.isSubagent)
  }
  if (!input.query.includeNonInteractive) {
    items = items.filter((item) => !item.isNonInteractive)
  }
  if (!input.query.includeEmpty) {
    items = items.filter((item) => item.isRunning || !!item.title?.trim())
  }

  if (cursor) {
    items = items.filter((item) => (
      item.lastActivityAt < cursor.lastActivityAt ||
      (item.lastActivityAt === cursor.lastActivityAt && buildSessionKey(item).localeCompare(cursor.key) < 0)
    ))
  }

  throwIfAborted(input.signal)

  let partial: true | undefined
  let partialReason: 'budget' | 'io_error' | undefined

  if (input.query.query?.trim()) {
    if (tier === 'title') {
      // Existing metadata-only search
      items = items
        .map((item) => applySearch(item, input.query.query!.trim()))
        .filter((item): item is SessionDirectoryItem => item !== null)
    } else {
      // File-based search for userMessages / fullText
      const fileResult = await applyFileSearch(items, input.query.query!.trim(), tier, {
        ...input,
        projects: persistedProjects,
      }, limit)
      items = fileResult.items
      partial = fileResult.partial
      partialReason = fileResult.partialReason
    }
  }

  const pageItems = items.slice(0, limit)
  const tail = pageItems.at(-1)
  const nextCursor = items.length > limit && tail
    ? encodeCursor({ lastActivityAt: tail.lastActivityAt, key: buildSessionKey(tail) })
    : null

  const page: SessionDirectoryPage = {
    items: pageItems,
    nextCursor,
    revision,
  }

  const includeKeys = input.query.includeKeys
  if (includeKeys && includeKeys.length > 0) {
    const wanted = new Set(includeKeys)
    const pageKeys = new Set(pageItems.map(buildSessionKey))
    const extras = extrasCandidateItems
      .filter((item) => wanted.has(buildSessionKey(item)) && !pageKeys.has(buildSessionKey(item)))
      .map((item) => ({
        provider: item.provider,
        sessionId: item.sessionId,
        ...(item.tokenUsage ? { tokenUsage: item.tokenUsage } : {}),
      }))
    if (extras.length > 0) {
      page.contextUsageExtras = extras
    }
  }

  // SESSION-05: embed the resolved project colors. They come from the
  // indexer's project groups (already overlaid from
  // `configStore.getProjectColors()` by `performRefresh`,
  // `coding-cli/session-indexer.ts`), so a color write is visible on the
  // very next refetch — and the key stays absent when nothing is
  // configured (optional in `shared/read-models.ts`), keeping the wire
  // identical to before for the no-colors case.
  const projectColors: Record<string, string> = {}
  for (const project of input.projects) {
    // `typeof` guard: a junk non-string value in the hand-edited
    // `config.json` map must not land on the page — the client parses it
    // as `z.record(z.string(), z.string())` and a failure there would
    // reject the whole session-window fetch. (Mirrors the store-side
    // normalization in the Rust port and the client's own `typeof` check
    // in `normalizeProjects`.)
    if (typeof project.color === 'string' && project.color) {
      projectColors[project.projectPath] = project.color
    }
  }
  if (Object.keys(projectColors).length > 0) {
    page.projectColors = projectColors
  }

  if (partial) {
    page.partial = partial
    page.partialReason = partialReason
  }
  if (identityCollision) {
    // Do not silently choose one duplicate. Every ambiguous PERSISTED row is
    // removed; a matching live terminal may remain as a generic, terminal-
    // owned row. The structured error is logged above and the UI gets enough
    // information to explain recovery without leaking ids or source paths.
    page.partial = true
    page.integrityError = {
      kind: 'identity_collision',
      collisionCount: identityCollision.collisionCount,
      duplicateItemCount: identityCollision.duplicateItemCount,
    }
  }

  return page
}
