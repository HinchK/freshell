// @vitest-environment node
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { locateClaudeTranscript } from '../../../server/coding-cli/claude-transcript-locator.js'

const SESSION_ID = 'ed2afda6-a340-443e-ba60-024a1b3554b4'

describe('locateClaudeTranscript', () => {
  let projectsDir: string

  beforeEach(async () => {
    projectsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-projects-'))
  })

  afterEach(async () => {
    await fsp.rm(projectsDir, { recursive: true, force: true })
  })

  async function writeTranscript(dirName: string, id: string, lines: string[]) {
    const dir = path.join(projectsDir, dirName)
    await fsp.mkdir(dir, { recursive: true })
    const file = path.join(dir, `${id}.jsonl`)
    await fsp.writeFile(file, lines.join('\n'), 'utf8')
    return file
  }

  it('finds a transcript by exact id and reads cwd from the first entry', async () => {
    const file = await writeTranscript('-repo-alpha', SESSION_ID, [
      JSON.stringify({ type: 'summary', summary: 'hello' }),
      JSON.stringify({ type: 'user', cwd: '/repo/alpha', message: 'hi' }),
    ])
    await expect(locateClaudeTranscript(SESSION_ID, projectsDir)).resolves.toEqual({
      sessionId: SESSION_ID,
      sourceFile: file,
      cwd: '/repo/alpha',
    })
  })

  it('matches case-insensitively and returns the normalized id', async () => {
    await writeTranscript('-repo-alpha', SESSION_ID, [JSON.stringify({ cwd: '/repo/alpha' })])
    const hit = await locateClaudeTranscript(SESSION_ID.toUpperCase(), projectsDir)
    expect(hit?.sessionId).toBe(SESSION_ID)
  })

  it('returns undefined cwd when no entry carries one', async () => {
    await writeTranscript('-repo-beta', SESSION_ID, [JSON.stringify({ type: 'summary' })])
    const hit = await locateClaudeTranscript(SESSION_ID, projectsDir)
    expect(hit).not.toBeNull()
    expect(hit?.cwd).toBeUndefined()
  })

  it('returns null for an unknown id', async () => {
    await expect(
      locateClaudeTranscript('019fac27-69d7-78a0-b972-b339d551042e', projectsDir),
    ).resolves.toBeNull()
  })

  it('returns null for non-uuid input without touching the fs', async () => {
    await expect(locateClaudeTranscript('417e8345', projectsDir)).resolves.toBeNull()
  })

  it('returns null when the projects dir does not exist', async () => {
    await expect(
      locateClaudeTranscript(SESSION_ID, path.join(projectsDir, 'missing')),
    ).resolves.toBeNull()
  })
})
