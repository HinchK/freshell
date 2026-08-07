import fsp from 'fs/promises'
import { runOpencodeSessionByIdOffThread } from './opencode-by-id-runner.js'
import { resolveOpencodeDatabasePath } from './opencode.js'

/**
 * Best-effort classification: does `sessionId` name an opencode SUBAGENT
 * (child) session — a `session` row with `parent_id NOT NULL`?
 *
 * `false` for: missing DB, missing row, schema without parent_id, and ANY
 * read/worker error. Classification must never block or fail terminal
 * creation, so runner rejections are swallowed HERE at the call site (the
 * runner keeps its reject-on-failure contract for resolve-fallbacks).
 *
 * The SQLite read runs INSIDE A WORKER THREAD (one short-lived worker per
 * lookup, 500ms busy timeout in the worker, hard outer timeout). NEVER open
 * DatabaseSync on the main thread here — it blocks the whole event loop
 * while the DB is locked (opencode-by-id-query.ts:3-11).
 */
export async function isOpencodeSubagentSession(
  sessionId: string,
  dbPath: string = resolveOpencodeDatabasePath(),
): Promise<boolean> {
  try {
    await fsp.access(dbPath)
  } catch {
    return false
  }
  try {
    const row = await runOpencodeSessionByIdOffThread(dbPath, sessionId)
    return row?.parentId != null
  } catch {
    return false
  }
}

/**
 * Cap for the terminal-create-path classification wait (ws-handler.ts): the
 * by-id worker runner carries a 15s OUTER timeout, so a wedged worker would
 * otherwise park terminal creation for up to 15s — violating "classification
 * never blocks terminal creation". On deadline the target stays UNCLASSIFIED
 * (`undefined`); the bindSession re-classification lane self-corrects later.
 */
export const OPENCODE_SUBAGENT_CLASSIFY_DEADLINE_MS = 1000

/**
 * Race `promise` against a `deadlineMs` timer: the promise's value if it
 * settles first, `undefined` on deadline. The timer is cleared (and unref'd)
 * so it never holds the process open; a late-resolving race loser is simply
 * ignored. Only safe for promises that never REJECT (the
 * isOpencodeSubagentSession contract) — a late rejection would be unhandled.
 */
export async function raceWithDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), deadlineMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Deadline-capped variant of {@link isOpencodeSubagentSession} for callers on
 * a latency budget (the terminal.create path). Identical answers on the fast
 * path; `undefined` (unclassified, NOT "root") when the lookup outlives the
 * deadline.
 */
export function isOpencodeSubagentSessionWithDeadline(
  sessionId: string,
  dbPath: string = resolveOpencodeDatabasePath(),
  deadlineMs: number = OPENCODE_SUBAGENT_CLASSIFY_DEADLINE_MS,
): Promise<boolean | undefined> {
  return raceWithDeadline(isOpencodeSubagentSession(sessionId, dbPath), deadlineMs)
}
