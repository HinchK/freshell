/**
 * HARNESS-04 — OpenCode session writer.
 *
 * Real layout (`server/coding-cli/providers/opencode-listing-query.ts`):
 * one SQLite database at `$XDG_DATA_HOME/opencode/opencode.db`
 * (fallback `<home>/.local/share/opencode`) with `project` + `session`
 * tables; the production listing SELECT filters
 * `time_archived IS NULL AND parent_id IS NULL`, maps `project.worktree` →
 * projectPath and the row's own `title` (a real provider title).
 *
 * All rows are written in one open/close; the db file is hashed once.
 */

import path from 'path'
import fsp from 'fs/promises'
import { DatabaseSync } from 'node:sqlite'
import type { CorpusContext, CorpusSessionExpectation } from './types.js'
import { recordFile } from './manifest.js'

export interface OpencodeSessionSpec {
  role: string
  sessionId: string
  /** Provider title (the session.title column, shown verbatim on the wire). */
  title: string
  /** session.directory — the cwd. */
  directory: string
  projectId: string
  /** project.worktree — becomes the wire projectPath. */
  projectWorktree: string
  /** INTEGER epoch ms (time_created). */
  timeCreated: number
  /** INTEGER epoch ms (time_updated → wire lastActivityAt). */
  timeUpdated: number
  /** When set, the production root listing never returns this row (provider-archived). */
  timeArchived?: number
  /** When set, the production root listing never returns this row (child/subagent). */
  parentId?: string
}

export async function writeOpencodeCorpus(
  ctx: CorpusContext,
  specs: OpencodeSessionSpec[],
): Promise<CorpusSessionExpectation[]> {
  const dataDir = path.join(ctx.homeDir, '.local', 'share', 'opencode')
  await fsp.mkdir(dataDir, { recursive: true })
  const dbPath = path.join(dataDir, 'opencode.db')

  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project (id TEXT PRIMARY KEY, worktree TEXT);
      CREATE TABLE IF NOT EXISTS session (
        id TEXT PRIMARY KEY, directory TEXT, title TEXT,
        time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
        project_id TEXT, parent_id TEXT
      );
    `)
    const seenProjects = new Set<string>()
    const insertProject = db.prepare('INSERT OR REPLACE INTO project (id, worktree) VALUES (?, ?)')
    const insertSession = db.prepare(`
      INSERT OR REPLACE INTO session
        (id, directory, title, time_created, time_updated, time_archived, project_id, parent_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const spec of specs) {
      if (!seenProjects.has(spec.projectId)) {
        insertProject.run(spec.projectId, spec.projectWorktree)
        seenProjects.add(spec.projectId)
      }
      insertSession.run(
        spec.sessionId, spec.directory, spec.title,
        Math.trunc(spec.timeCreated), Math.trunc(spec.timeUpdated),
        spec.timeArchived ?? null, spec.projectId, spec.parentId ?? null,
      )
    }
  } finally {
    db.close()
  }
  await recordFile(ctx.files, ctx.homeDir, dbPath, 'opencode-db')

  const expectations: CorpusSessionExpectation[] = specs.map((spec) => {
    const hidden = spec.timeArchived !== undefined || spec.parentId !== undefined
    const base: CorpusSessionExpectation = {
      key: `opencode:${spec.sessionId}`,
      provider: 'opencode',
      sessionId: spec.sessionId,
      role: spec.role,
      projectPath: spec.projectWorktree,
      cwd: spec.directory,
      lastActivityAt: Math.trunc(spec.timeUpdated),
      visibility: hidden ? 'absent' : 'listed',
    }
    if (!hidden) {
      base.title = spec.title
      base.createdAt = Math.trunc(spec.timeCreated)
    }
    ctx.sessions.push(base)
    return base
  })
  return expectations
}
