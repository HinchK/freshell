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
