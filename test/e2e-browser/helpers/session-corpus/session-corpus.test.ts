import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import { describe, it, expect, afterEach } from 'vitest'
import {
  sha256File,
  writeManifest,
  loadSessionCorpusManifest,
  walkCoveragePaths,
  type CorpusManifest,
} from './manifest.js'

/**
 * HARNESS-04 unit tests: the corpus manifest/hashing core.
 * Playwright contract proof lives in specs/harness-04-session-corpus.spec.ts.
 * Real files are written under os.tmpdir() mkdtemp homes only.
 */

const tempHomes: string[] = []

async function mkHome(): Promise<string> {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'h04-unit-'))
  tempHomes.push(home)
  return home
}

afterEach(async () => {
  while (tempHomes.length > 0) {
    const home = tempHomes.pop()!
    await fsp.rm(home, { recursive: true, force: true })
  }
})

function sampleManifest(homeDir: string): CorpusManifest {
  return {
    formatVersion: 1,
    runId: 'h04corpus-testtoken',
    generatedAt: '2026-08-09T00:00:00.000Z',
    homeDir,
    providers: ['claude', 'codex', 'opencode', 'amplifier'],
    roots: {
      claudeProjects: path.join(homeDir, '.claude', 'projects'),
      codexSessions: path.join(homeDir, '.codex', 'sessions'),
      codexArchived: path.join(homeDir, '.codex', 'archived_sessions'),
      opencodeData: path.join(homeDir, '.local', 'share', 'opencode'),
      amplifierProjects: path.join(homeDir, '.amplifier', 'projects'),
      freshellConfig: path.join(homeDir, '.freshell', 'config.json'),
      corpusWorkspace: path.join(homeDir, 'h04corpus-testtoken'),
    },
    files: [],
    sessions: [],
    gitFixtures: [],
    pagination: { listedCount: 67, pageLimit: 50, expectedPages: 2 },
  }
}

describe('session-corpus manifest core', () => {
  it('sha256File hashes known content', async () => {
    const home = await mkHome()
    const file = path.join(home, 'known.txt')
    await fsp.writeFile(file, 'hello corpus\n')
    const hash = await sha256File(file)
    // printf 'hello corpus\n' | sha256sum
    expect(hash).toBe('15f085ae206701271d2791c17f98b98439c7d681772d8f32a481082eb4ce88a4')
  })

  it('writeManifest + loadSessionCorpusManifest round-trips through disk', async () => {
    const home = await mkHome()
    const manifest = sampleManifest(home)
    manifest.files = [{
      path: '.claude/projects/x.jsonl',
      sha256: '00'.repeat(32),
      bytes: 3,
      role: 'claude-session:test',
    }]
    const manifestPath = await writeManifest(home, manifest)
    expect(manifestPath.endsWith(path.join('.freshell-corpus', 'manifest.json'))).toBe(true)

    const parsed = await loadSessionCorpusManifest(home)
    expect(parsed).toEqual(manifest)
  })

  it('loadSessionCorpusManifest rejects a malformed manifest', async () => {
    const home = await mkHome()
    await fsp.mkdir(path.join(home, '.freshell-corpus'), { recursive: true })
    await fsp.writeFile(
      path.join(home, '.freshell-corpus', 'manifest.json'),
      JSON.stringify({ ...sampleManifest(home), formatVersion: 2 }),
    )
    await expect(loadSessionCorpusManifest(home)).rejects.toThrow(/formatVersion/)
  })

  it('loadSessionCorpusManifest rejects a missing manifest', async () => {
    const home = await mkHome()
    await expect(loadSessionCorpusManifest(home)).rejects.toThrow()
  })

  it('walkCoveragePaths lists regular files with stable relative posix paths, sorted', async () => {
    const home = await mkHome()
    await fsp.mkdir(path.join(home, '.claude', 'projects', 'p-x'), { recursive: true })
    await fsp.writeFile(path.join(home, '.claude', 'projects', 'p-x', 'a.jsonl'), 'a\n')
    await fsp.writeFile(path.join(home, 'solo.txt'), 'b\n')
    await fsp.mkdir(path.join(home, 'empty-dir'), { recursive: true })
    await fsp.mkdir(path.join(home, '.codex', 'sessions', '2026', '08'), { recursive: true })
    await fsp.writeFile(path.join(home, '.codex', 'sessions', '2026', '08', 'r.jsonl'), 'c\n')

    const rels = await walkCoveragePaths(home)
    expect(rels).toEqual([
      '.claude/projects/p-x/a.jsonl',
      '.codex/sessions/2026/08/r.jsonl',
      'solo.txt',
    ])
  })
})
