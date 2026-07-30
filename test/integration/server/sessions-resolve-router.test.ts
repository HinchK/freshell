// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import { createSessionsRouter } from '../../../server/sessions-router.js'
import type { ProjectGroup } from '../../../server/coding-cli/types.js'

const CLAUDE_ID = 'ed2afda6-a340-443e-ba60-024a1b3554b4'
const CODEX_ID = '019fac27-69d7-78a0-b972-b339d551042e'
const OPENCODE_ID = 'ses_root0000000000000000000000'
const AMP_ID_NEW = '417e8345-aaaa-4bbb-8ccc-000000000001'
const AMP_ID_OLD = '417e8345-bbbb-4ccc-8ddd-000000000002'

function fixtureProjects(): ProjectGroup[] {
  return [
    {
      projectPath: '/repo/alpha',
      sessions: [
        {
          provider: 'claude',
          sessionId: CLAUDE_ID,
          projectPath: '/repo/alpha',
          cwd: '/repo/alpha',
          title: 'Fix the parser',
          firstUserMessage: 'fix the parser',
          lastActivityAt: 400,
        },
        {
          provider: 'codex',
          sessionId: CODEX_ID,
          projectPath: '/repo/alpha',
          cwd: '/repo/alpha',
          sessionType: 'codex',
          lastActivityAt: 300,
        },
      ],
    },
    {
      projectPath: '/repo/beta',
      sessions: [
        {
          provider: 'opencode',
          sessionId: OPENCODE_ID,
          projectPath: '/repo/beta',
          cwd: '/repo/beta',
          lastActivityAt: 200,
        },
        {
          provider: 'amplifier',
          sessionId: AMP_ID_NEW,
          projectPath: '/repo/beta',
          cwd: '/repo/beta',
          lastActivityAt: 900,
        },
        {
          provider: 'amplifier',
          sessionId: AMP_ID_OLD,
          projectPath: '/repo/beta',
          cwd: '/repo/beta',
          lastActivityAt: 100,
        },
      ],
    },
  ]
}

interface HarnessOptions {
  projects?: ProjectGroup[]
  ready?: boolean
  resolveOpencodeSessionIds?: (
    ids: readonly string[],
  ) => Promise<{
    rootsBySessionId: Map<string, string>
    directoriesBySessionId?: Map<string, string>
    unresolvedSessionIds: Set<string>
  }>
  locateClaudeTranscript?: (
    id: string,
  ) => Promise<{ sessionId: string; sourceFile: string; cwd?: string } | null>
}

function buildApp(options: HarnessOptions = {}): Express {
  const app = express()
  app.use(express.json())
  app.use(
    '/api',
    createSessionsRouter({
      configStore: {
        getSettings: vi.fn().mockResolvedValue({}),
        patchSessionOverride: vi.fn(),
        deleteSession: vi.fn(),
      },
      codingCliIndexer: {
        getProjects: () => options.projects ?? fixtureProjects(),
        refresh: vi.fn().mockResolvedValue(undefined),
      },
      codingCliProviders: [],
      perfConfig: { slowSessionRefreshMs: 500 },
      terminalMetadata: { list: () => [] },
      getIndexReadiness: () => options.ready ?? true,
      resolveOpencodeSessionIds: options.resolveOpencodeSessionIds,
      locateClaudeTranscript: options.locateClaudeTranscript,
    }),
  )
  return app
}

const post = (app: Express, body: unknown) =>
  request(app).post('/api/sessions/resolve').send(body as object)

describe('POST /api/sessions/resolve', () => {
  let app: Express
  beforeEach(() => {
    app = buildApp()
  })

  it.each([
    ['claude exact uuid', CLAUDE_ID, 'claude', CLAUDE_ID],
    ['codex exact via command line', `codex resume ${CODEX_ID}`, 'codex', CODEX_ID],
    ['opencode exact via command line', `opencode --session ${OPENCODE_ID}`, 'opencode', OPENCODE_ID],
  ] as const)('%s resolves to a single exact match', async (_label, input, provider, id) => {
    const res = await post(app, { input })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ready')
    expect(res.body.matches).toHaveLength(1)
    expect(res.body.matches[0]).toMatchObject({ provider, sessionId: id, matchKind: 'exact' })
  })

  it('returns full resume metadata on matches', async () => {
    const res = await post(app, { input: CLAUDE_ID })
    expect(res.body.matches[0]).toMatchObject({
      provider: 'claude',
      sessionId: CLAUDE_ID,
      cwd: '/repo/alpha',
      title: 'Fix the parser',
      firstUserMessage: 'fix the parser',
      lastActivityAt: 400,
    })
  })

  it('prefix-matches short hex across providers, most-recent first', async () => {
    const res = await post(app, { input: '417e8345' })
    expect(res.body.status).toBe('ready')
    expect(res.body.matches.map((m: { sessionId: string }) => m.sessionId)).toEqual([
      AMP_ID_NEW,
      AMP_ID_OLD,
    ])
    expect(res.body.matches[0].matchKind).toBe('prefix')
    expect(res.body.matches[0].provider).toBe('amplifier')
  })

  it('caps ambiguous prefix matches at 20', async () => {
    const many: ProjectGroup[] = [
      {
        projectPath: '/repo/many',
        sessions: Array.from({ length: 25 }, (_, i) => ({
          provider: 'amplifier',
          sessionId: `417e8345-0000-4000-8000-${String(i).padStart(12, '0')}`,
          projectPath: '/repo/many',
          lastActivityAt: i,
        })),
      },
    ]
    const res = await post(buildApp({ projects: many }), { input: '417e8345' })
    expect(res.body.matches).toHaveLength(20)
    expect(res.body.matches[0].lastActivityAt).toBe(24) // most recent first
  })

  it('dedupes duplicate (provider, sessionId) snapshot entries, keeping the most recent', async () => {
    // Real-store finding: the same claude sessionId can appear on MULTIPLE
    // snapshot entries (same id, different transcript files).
    const dup: ProjectGroup[] = [
      {
        projectPath: '/repo/alpha',
        sessions: [
          {
            provider: 'claude',
            sessionId: CLAUDE_ID,
            projectPath: '/repo/alpha',
            cwd: '/repo/alpha',
            title: 'older file',
            lastActivityAt: 100,
          },
          {
            provider: 'claude',
            sessionId: CLAUDE_ID,
            projectPath: '/repo/alpha',
            cwd: '/repo/alpha',
            title: 'newer file',
            lastActivityAt: 500,
          },
        ],
      },
    ]
    const res = await post(buildApp({ projects: dup }), { input: CLAUDE_ID })
    expect(res.body.matches).toHaveLength(1)
    expect(res.body.matches[0]).toMatchObject({ title: 'newer file', lastActivityAt: 500 })
  })

  it('reports hint alongside evidence', async () => {
    const res = await post(app, { input: `codex resume ${CODEX_ID}` })
    expect(res.body.hint).toEqual({ provider: 'codex', source: 'command' })
  })

  it('returns ready + empty matches for an unknown id', async () => {
    const res = await post(app, { input: '019fffff-ffff-7fff-bfff-ffffffffffff' })
    expect(res.body).toMatchObject({ status: 'ready', matches: [] })
  })

  it('returns warming (not "not found") while the index is not ready', async () => {
    const res = await post(buildApp({ ready: false }), { input: CLAUDE_ID })
    expect(res.body).toMatchObject({ status: 'warming', matches: [] })
  })

  it('falls back to the opencode by-id query on exact-id index miss (with the row directory as cwd)', async () => {
    const unknown = 'ses_child000000000000000000000'
    const res = await post(
      buildApp({
        resolveOpencodeSessionIds: vi.fn().mockResolvedValue({
          rootsBySessionId: new Map([[unknown, OPENCODE_ID]]),
          directoriesBySessionId: new Map([[unknown, '/repo/beta']]),
          unresolvedSessionIds: new Set<string>(),
        }),
      }),
      { input: unknown },
    )
    expect(res.body.matches).toEqual([
      {
        provider: 'opencode',
        sessionId: unknown,
        cwd: '/repo/beta',
        sessionType: 'opencode',
        matchKind: 'exact',
      },
    ])
  })

  it('falls back to the claude transcript locator on exact-id index miss', async () => {
    const unknown = 'aaaaaaaa-1111-4222-8333-444444444444'
    const res = await post(
      buildApp({
        locateClaudeTranscript: vi.fn().mockResolvedValue({
          sessionId: unknown,
          sourceFile: `/home/u/.claude/projects/x/${unknown}.jsonl`,
          cwd: '/repo/gamma',
        }),
      }),
      { input: unknown },
    )
    expect(res.body.matches).toEqual([
      {
        provider: 'claude',
        sessionId: unknown,
        cwd: '/repo/gamma',
        sessionType: 'claude',
        matchKind: 'exact',
      },
    ])
  })

  it('returns ready + empty matches for garbage input with no id-like token', async () => {
    const res = await post(app, { input: 'hello decade facade!!' })
    expect(res.body).toMatchObject({ status: 'ready', matches: [], hint: null })
  })

  it('rejects an invalid body with 400', async () => {
    const res = await post(app, { nope: true })
    expect(res.status).toBe(400)
    expect(res.body.error).toBeDefined()
  })
})
