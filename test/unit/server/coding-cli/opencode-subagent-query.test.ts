import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isOpencodeSubagentSession } from '../../../../server/coding-cli/providers/opencode-subagent-query'
import { resolveOpencodeDatabasePath } from '../../../../server/coding-cli/providers/opencode'

vi.unmock('node:sqlite')

describe('isOpencodeSubagentSession', () => {
  let tempDir: string
  let dbPath: string

  beforeEach(async () => {
    // Throwaway tmp DB — never the user's real opencode data dir (session safety rule).
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-oc-subagent-'))
    dbPath = path.join(tempDir, 'opencode.db')
  })
  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  async function seed(opts: { parentIdColumn?: boolean } = {}): Promise<void> {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(dbPath)
    try {
      const parentCol = opts.parentIdColumn === false ? '' : 'parent_id TEXT,'
      db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, ${parentCol} directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);`)
      if (opts.parentIdColumn === false) {
        db.prepare(`INSERT INTO session (id, project_id, directory, title, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run('ses_flat', 'p1', '/repo', 'flat', 1, 2, null)
      } else {
        db.prepare(`INSERT INTO session (id, project_id, parent_id, directory, title, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run('ses_root', 'p1', null, '/repo', 'root', 1, 2, null)
        db.prepare(`INSERT INTO session (id, project_id, parent_id, directory, title, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run('ses_child', 'p1', 'ses_root', '/repo', 'child', 1, 2, null)
      }
    } finally {
      db.close()
    }
  }

  it('returns true for a child session (parent_id set)', async () => {
    await seed()
    expect(await isOpencodeSubagentSession('ses_child', dbPath)).toBe(true)
  })

  it('returns false for a root session', async () => {
    await seed()
    expect(await isOpencodeSubagentSession('ses_root', dbPath)).toBe(false)
  })

  it('returns false for a missing row', async () => {
    await seed()
    expect(await isOpencodeSubagentSession('ses_nope', dbPath)).toBe(false)
  })

  it('returns false when the schema has no parent_id column', async () => {
    await seed({ parentIdColumn: false })
    expect(await isOpencodeSubagentSession('ses_flat', dbPath)).toBe(false)
  })

  it('returns false when the DB file does not exist', async () => {
    expect(await isOpencodeSubagentSession('ses_child', path.join(tempDir, 'missing.db'))).toBe(false)
  })

  it('returns false on an unreadable/corrupt DB (never throws)', async () => {
    await fsp.writeFile(dbPath, 'not a sqlite file')
    expect(await isOpencodeSubagentSession('ses_child', dbPath)).toBe(false)
  })
})

describe('resolveOpencodeDatabasePath', () => {
  it('defaults to <XDG_DATA_HOME>/opencode/opencode.db (production default) and joins explicit data homes', async () => {
    const savedXdg = process.env.XDG_DATA_HOME
    const xdgTmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-oc-xdg-'))
    process.env.XDG_DATA_HOME = xdgTmp
    try {
      expect(resolveOpencodeDatabasePath()).toBe(path.join(xdgTmp, 'opencode', 'opencode.db'))
      expect(resolveOpencodeDatabasePath('/explicit/data/home')).toBe(path.join('/explicit/data/home', 'opencode.db'))
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = savedXdg
      await fsp.rm(xdgTmp, { recursive: true, force: true })
    }
  })
})
