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
import { claudeProjectSlug, writeClaudeSession } from './claude.js'
import { codexDatePath, writeCodexSession } from './codex.js'
import { writeOpencodeCorpus, type OpencodeSessionSpec } from './opencode.js'
import { writeAmplifierSession } from './amplifier.js'
import { parseAmplifierMetadata } from '../../../../server/coding-cli/providers/amplifier.js'
import {
  runOpencodeListingQuery,
  THREE_VIEWS_MARKER_SQL_PATTERN,
} from '../../../../server/coding-cli/providers/opencode-listing-query.js'
import type { CorpusContext } from './types.js'

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

function mkCtx(homeDir: string): CorpusContext {
  return {
    homeDir,
    runToken: 'testtoken',
    marker: 'h04corpus-testtoken',
    workspace: path.join(homeDir, 'h04corpus-testtoken'),
    files: [],
    sessions: [],
    gitFixtures: [],
  }
}

describe('session-corpus claude writer', () => {
  it('encodes project dirs with the real Claude slug rule (non-alphanumerics → -)', () => {
    expect(claudeProjectSlug('/tmp/h04corpus-abc12/my-project'))
      .toBe('-tmp-h04corpus-abc12-my-project')
  })

  it('writes init + turns + trailing summary, registers hash + listed expectation', async () => {
    const home = await mkHome()
    const ctx = mkCtx(home)
    const cwd = path.join(ctx.workspace, 'projects', 'alpha-project')
    const createdAt = Date.parse('2026-08-04T09:00:00.000Z')
    const lastActivityAt = createdAt + 4 // init=+0, user1=+1, asst1=+2, user2=+3, asst2=+4
    const exp = await writeClaudeSession(ctx, {
      role: 'alpha',
      sessionId: '00000000-0000-4000-8000-0000000000a1',
      cwd,
      titleText: 'h04corpus-testtoken alpha',
      turns: 2,
      withSummary: true,
      createdAt,
      lastActivityAt,
    })

    const file = path.join(home, '.claude', 'projects', claudeProjectSlug(cwd),
      '00000000-0000-4000-8000-0000000000a1.jsonl')
    const raw = await fsp.readFile(file, 'utf-8')
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l))

    // init line: cwd + session id + createdAt timestamp
    expect(lines[0].type).toBe('system')
    expect(lines[0].subtype).toBe('init')
    expect(lines[0].cwd).toBe(cwd)
    expect(lines[0].session_id).toBe('00000000-0000-4000-8000-0000000000a1')
    expect(lines[0].timestamp).toBe('2026-08-04T09:00:00.000Z')
    // two user + two assistant turns, parentUuid chain
    const roles = lines.slice(1, 5).map((l) => l.type)
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(lines[2].parentUuid).toBe(lines[1].uuid)
    expect(lines[3].parentUuid).toBe(lines[2].uuid)
    // tail = summary line WITHOUT timestamp (drives title, not recency)
    const tail = lines[5]
    expect(tail.type).toBe('summary')
    expect(tail.summary).toBe('h04corpus-testtoken alpha')
    expect(tail.timestamp).toBeUndefined()
    // last timestamped line = lastActivityAt (the server's tail-walk lands here)
    expect(lines[4].timestamp).toBe('2026-08-04T09:00:00.004Z')

    // registered file hash + expectation
    expect(ctx.files).toHaveLength(1)
    expect(ctx.files[0].path.startsWith('.claude/projects/')).toBe(true)
    expect(ctx.files[0].path.endsWith('/00000000-0000-4000-8000-0000000000a1.jsonl')).toBe(true)
    await expect(fsp.readFile(path.join(home, ctx.files[0].path), 'utf-8')).resolves.toBe(raw)
    expect(exp).toMatchObject({
      provider: 'claude',
      role: 'alpha',
      title: 'h04corpus-testtoken alpha',
      summary: 'h04corpus-testtoken alpha',
      projectPath: cwd,
      cwd,
      createdAt,
      lastActivityAt,
      visibility: 'listed',
    })
    expect(ctx.sessions[0].key).toBe('claude:00000000-0000-4000-8000-0000000000a1')
  })

  it('one-message session: no reply, no summary → title from first message, hidden-default(noninteractive)', async () => {
    const home = await mkHome()
    const ctx = mkCtx(home)
    const cwd = path.join(ctx.workspace, 'projects', 'solo')
    const exp = await writeClaudeSession(ctx, {
      role: 'noninteractive',
      sessionId: '00000000-0000-4000-8000-0000000000b1',
      cwd,
      titleText: 'h04corpus-testtoken noninteractive',
      turns: 0,
      userMessages: 1,
      withSummary: false,
      createdAt: Date.parse('2026-07-10T10:00:00.000Z'),
      lastActivityAt: Date.parse('2026-07-10T10:00:00.001Z'),
    })
    const raw = await fsp.readFile(path.join(home, ctx.files[0].path), 'utf-8')
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.map((l) => l.type)).toEqual(['system', 'user'])
    expect(lines[1].message.content).toContain('h04corpus-testtoken noninteractive')
    expect(exp.title).toBe('h04corpus-testtoken noninteractive')
    expect(exp.summary).toBeUndefined()
    expect(exp.visibility).toBe('hidden-default')
    expect(exp.visibleWith).toEqual({ includeNonInteractive: true })
  })

  it('init-only session: no title at all → hidden-default(empty + noninteractive)', async () => {
    const home = await mkHome()
    const ctx = mkCtx(home)
    const exp = await writeClaudeSession(ctx, {
      role: 'untitled-empty',
      sessionId: '00000000-0000-4000-8000-0000000000c1',
      cwd: path.join(ctx.workspace, 'projects', 'empty'),
      turns: 0,
      withSummary: false,
      createdAt: Date.parse('2026-07-05T10:00:00.000Z'),
      lastActivityAt: Date.parse('2026-07-05T10:00:00.000Z'),
    })
    const raw = await fsp.readFile(path.join(home, ctx.files[0].path), 'utf-8')
    expect(raw.trim().split('\n')).toHaveLength(1)
    expect(exp.title).toBeUndefined()
    expect(exp.visibility).toBe('hidden-default')
    expect(exp.visibleWith).toEqual({ includeNonInteractive: true, includeEmpty: true })
  })

  it('subagent sessions land under projects/<slug>/subagents/', async () => {
    const home = await mkHome()
    const ctx = mkCtx(home)
    const cwd = path.join(ctx.workspace, 'projects', 'alpha-project')
    const exp = await writeClaudeSession(ctx, {
      role: 'subagent',
      sessionId: '00000000-0000-4000-8000-0000000000d1',
      cwd,
      titleText: 'h04corpus-testtoken subagent',
      turns: 2,
      withSummary: false,
      subagent: true,
      createdAt: Date.parse('2026-07-08T10:00:00.000Z'),
      lastActivityAt: Date.parse('2026-07-08T10:00:00.004Z'),
    })
    expect(ctx.files[0].path).toContain('/subagents/')
    expect(exp.visibility).toBe('hidden-default')
    expect(exp.visibleWith).toEqual({ includeSubagents: true })
    // title still derivable from the first user message when no summary line
    expect(exp.title).toContain('subagent')
  })
})

describe('session-corpus codex writer', () => {
  it('writes a real rollout file under sessions/YYYY/MM/DD with session_meta + turn records', async () => {
    const home = await mkHome()
    const ctx = mkCtx(home)
    const cwd = path.join(ctx.workspace, 'projects', 'gamma-project')
    const createdAt = Date.parse('2026-08-03T10:00:00.000Z')
    const lastActivityAt = Date.parse('2026-08-03T10:00:00.002Z')
    const exp = await writeCodexSession(ctx, {
      role: 'gamma',
      sessionId: 'h04corpus-testtoken-codex-gamma',
      cwd,
      titleText: 'h04corpus-testtoken gamma',
      createdAt,
      lastActivityAt,
    })

    // real codex layout: sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<id>.jsonl
    expect(exp.key).toBe('codex:h04corpus-testtoken-codex-gamma')
    const rel = ctx.files[0].path
    expect(rel).toBe(path.posix.join('.codex', 'sessions', codexDatePath(createdAt),
      `rollout-2026-08-03T10-00-00-h04corpus-testtoken-codex-gamma.jsonl`))

    const lines = (await fsp.readFile(path.join(home, rel), 'utf-8'))
      .trim().split('\n').map((l) => JSON.parse(l))
    expect(lines[0].type).toBe('session_meta')
    expect(lines[0].payload.id).toBe('h04corpus-testtoken-codex-gamma')
    expect(lines[0].payload.cwd).toBe(cwd)
    expect(lines[0].timestamp).toBe('2026-08-03T10:00:00.000Z')
    expect(lines[1].type).toBe('response_item')
    expect(lines[1].payload).toMatchObject({
      type: 'message', role: 'user',
      content: [{ type: 'input_text', text: 'h04corpus-testtoken gamma request 1' }],
    })
    expect(lines[1].timestamp).toBe('2026-08-03T10:00:00.001Z')
    expect(lines[2].payload.role).toBe('assistant')
    expect(lines[2].timestamp).toBe('2026-08-03T10:00:00.002Z')

    expect(exp).toMatchObject({
      provider: 'codex',
      title: 'h04corpus-testtoken gamma request 1',
      // codex parse: first ASSISTANT text becomes the wire summary (240 cap)
      summary: 'h04corpus-testtoken gamma reply 1',
      projectPath: cwd,
      createdAt,
      lastActivityAt,
      visibility: 'listed',
    })
  })

  it('exec-source sessions are marked hidden-default (noninteractive)', async () => {
    const home = await mkHome()
    const ctx = mkCtx(home)
    const exp = await writeCodexSession(ctx, {
      role: 'exec',
      sessionId: 'h04corpus-testtoken-codex-exec',
      cwd: path.join(ctx.workspace, 'projects', 'exec-project'),
      titleText: 'h04corpus-testtoken exec',
      createdAt: Date.parse('2026-07-11T10:00:00.000Z'),
      lastActivityAt: Date.parse('2026-07-11T10:00:00.002Z'),
      source: 'exec',
    })
    expect(exp.visibility).toBe('hidden-default')
    expect(exp.visibleWith).toEqual({ includeNonInteractive: true })
  })

  it('provider-archived rollouts write under archived_sessions/ and expect absence', async () => {
    const home = await mkHome()
    const ctx = mkCtx(home)
    const exp = await writeCodexSession(ctx, {
      role: 'provider-archived',
      sessionId: 'h04corpus-testtoken-codex-archived',
      cwd: path.join(ctx.workspace, 'projects', 'gamma-project'),
      titleText: 'h04corpus-testtoken provider archived',
      createdAt: Date.parse('2026-08-02T10:00:00.000Z'),
      lastActivityAt: Date.parse('2026-08-02T10:00:00.002Z'),
      archivedByProvider: true,
    })
    // NOT under sessions/** — the legacy glob never sees it, on purpose.
    expect(ctx.files[0].path.startsWith('.codex/archived_sessions/2026/08/02/')).toBe(true)
    expect(exp.visibility).toBe('absent')
    expect(exp.title).toBeUndefined() // never indexed: no wire semantics
    expect(exp.summary).toBeUndefined()
  })
})

describe('session-corpus opencode writer', () => {
  function ocSpec(home: string, over: Partial<OpencodeSessionSpec> & Pick<OpencodeSessionSpec, 'role'>): OpencodeSessionSpec {
    return {
      sessionId: `h04corpus-oc-${over.role}`,
      title: `h04corpus-testtoken ${over.role}`,
      directory: path.join(home, 'h04corpus-testtoken', 'projects', `${over.role}-project`),
      projectId: `proj-${over.role}`,
      projectWorktree: path.join(home, 'h04corpus-testtoken', 'projects', `${over.role}-project`),
      timeCreated: Date.parse('2026-07-20T08:00:00.000Z'),
      timeUpdated: Date.parse('2026-07-20T08:00:00.001Z'),
      ...over,
    }
  }

  it('creates the DB under XDG data home; production listing query sees only root non-archived rows', async () => {
    const home = await mkHome()
    const ctx = mkCtx(home)
    const specs = [
      ocSpec(home, { role: 'delta' }),
      ocSpec(home, { role: 'echo', timeUpdated: Date.parse('2026-07-19T08:00:00.001Z') }),
      ocSpec(home, { role: 'archived', timeArchived: Date.parse('2026-07-21T00:00:00.000Z') }),
      ocSpec(home, { role: 'child', parentId: 'h04corpus-oc-delta' }),
    ]
    const exps = await writeOpencodeCorpus(ctx, specs)

    // one hashed db file at the XDG data location
    expect(ctx.files).toHaveLength(1)
    expect(ctx.files[0].path).toBe('.local/share/opencode/opencode.db')

    // THE production listing query (opencode-listing-query.ts) is the reader
    // under test here: archived and child rows must not come back.
    const dbPath = path.join(home, '.local', 'share', 'opencode', 'opencode.db')
    const { rows } = await runOpencodeListingQuery(dbPath, THREE_VIEWS_MARKER_SQL_PATTERN)
    const ids = rows.map((r) => r.sessionId).sort()
    expect(ids).toEqual(['h04corpus-oc-delta', 'h04corpus-oc-echo'])

    const delta = rows.find((r) => r.sessionId === 'h04corpus-oc-delta')!
    expect(delta).toMatchObject({
      cwd: specs[0].directory,
      title: 'h04corpus-testtoken delta',
      createdAt: specs[0].timeCreated,
      lastActivityAt: specs[0].timeUpdated,
      projectPath: specs[0].projectWorktree,
    })

    // expectations
    const byRole = (role: string) => exps.find((e) => e.role === role)!
    expect(byRole('delta')).toMatchObject({
      provider: 'opencode', visibility: 'listed',
      title: 'h04corpus-testtoken delta',
      projectPath: specs[0].projectWorktree,
      lastActivityAt: specs[0].timeUpdated, createdAt: specs[0].timeCreated,
    })
    expect(byRole('archived').visibility).toBe('absent')
    expect(byRole('archived').title).toBeUndefined()
    expect(byRole('child').visibility).toBe('absent')
  })
})

describe('session-corpus amplifier writer', () => {
  it('writes metadata.json + sidecars, pins mtimes, floors fractional numeric timestamps', async () => {
    const home = await mkHome()
    const ctx = mkCtx(home)
    const cwd = path.join(ctx.workspace, 'projects', 'epsilon-project')
    const created = Date.parse('2026-07-22T09:00:00.000Z') + 0.5 // fractional numeric
    const updated = Date.parse('2026-07-22T09:00:02.000Z')
    const exp = await writeAmplifierSession(ctx, {
      role: 'epsilon',
      sessionId: 'h04corpus-testtoken-amp-epsilon',
      cwd,
      name: 'h04corpus-testtoken epsilon',
      description: 'h04corpus-testtoken epsilon summary text',
      created,
      descriptionUpdatedAt: updated,
      firstUserMessage: 'h04corpus-testtoken epsilon request 1',
      withEventsSidecar: true,
    })

    const dir = path.join(home, '.amplifier', 'projects', 'epsilon-project',
      'sessions', 'h04corpus-testtoken-amp-epsilon')
    const metaRaw = await fsp.readFile(path.join(dir, 'metadata.json'), 'utf-8')
    // three hashed files
    expect(ctx.files.map((f) => f.path).sort()).toEqual([
      '.amplifier/projects/epsilon-project/sessions/h04corpus-testtoken-amp-epsilon/events.jsonl',
      '.amplifier/projects/epsilon-project/sessions/h04corpus-testtoken-amp-epsilon/metadata.json',
      '.amplifier/projects/epsilon-project/sessions/h04corpus-testtoken-amp-epsilon/transcript.jsonl',
    ])

    // the production parser is the reader under test
    const parsed = parseAmplifierMetadata(metaRaw)
    expect(parsed).toMatchObject({
      sessionId: 'h04corpus-testtoken-amp-epsilon',
      cwd,
      createdAt: Math.floor(created), // fractional floored
      lastActivityAt: updated,
      title: 'h04corpus-testtoken epsilon',
      titleSource: 'provider-generated',
      summary: 'h04corpus-testtoken epsilon summary text',
    })

    // mtimes pinned to the seeded activity instant (recency fold must not
    // see build-time "now" dominating the seeded timestamps)
    for (const f of ['metadata.json', 'transcript.jsonl', 'events.jsonl']) {
      const stat = await fsp.stat(path.join(dir, f))
      expect(Math.floor(stat.mtimeMs)).toBe(updated)
    }

    // first user message is transcript-visible
    const transcript = await fsp.readFile(path.join(dir, 'transcript.jsonl'), 'utf-8')
    expect(transcript).toContain('"role":"user"')
    expect(transcript).toContain('h04corpus-testtoken epsilon request 1')

    expect(exp).toMatchObject({
      provider: 'amplifier',
      title: 'h04corpus-testtoken epsilon',
      summary: 'h04corpus-testtoken epsilon summary text',
      projectPath: cwd,
      createdAt: Math.floor(created),
      lastActivityAt: updated,
      visibility: 'listed',
    })
  })
})

describe('session-corpus claude writer validation', () => {
  it('rejects a turns>0 spec whose lastActivityAt does not match the turn schedule', async () => {
    const home = await mkHome()
    const ctx = mkCtx(home)
    await expect(writeClaudeSession(ctx, {
      role: 'bad',
      sessionId: '00000000-0000-4000-8000-0000000000e1',
      cwd: path.join(ctx.workspace, 'projects', 'bad'),
      titleText: 'bad',
      turns: 2,
      withSummary: true,
      createdAt: 1000,
      lastActivityAt: 9999, // schedule demands createdAt + 4
    })).rejects.toThrow(/lastActivityAt/)
  })
})
