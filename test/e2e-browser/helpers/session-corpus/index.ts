/**
 * HARNESS-04 — multi-provider session corpus builder (public API).
 *
 * `buildSessionCorpus(homeDir)` materializes a deterministic, fully
 * self-contained set of Claude / Codex / OpenCode / Amplifier histories into
 * `homeDir` and returns the corpus contract ({ marker, manifestPath,
 * manifest }). Use it as `construct.setupHome` for any e2e server fixture,
 * or standalone for pure-fixture assertions.
 *
 * Deterministic given (homeDir, runToken): every timestamp is fixed, every
 * path/title/id embeds the `h04corpus-<runToken>` marker, and the manifest
 * records sha256 for every file written.
 */

import path from 'path'
import fsp from 'fs/promises'
import { randomBytes } from 'crypto'
import type { CorpusContext, SessionCorpus, CorpusSessionExpectation } from './types.js'
import { writeManifest, recordFile, type CorpusManifest } from './manifest.js'
import { writeClaudeSession } from './claude.js'
import { writeCodexSession } from './codex.js'
import { writeOpencodeCorpus } from './opencode.js'
import { writeAmplifierSession } from './amplifier.js'
import { createNestedGitRepos, createWorktreePair } from './git-layout.js'
import { applySessionOverride, type SessionOverrideEntry } from './overrides.js'

export type { SessionCorpus, CorpusBuildOptions } from './types.js'
export { loadSessionCorpusManifest, walkCoveragePaths, sha256File, writeManifest } from './manifest.js'
export type { CorpusManifest } from './manifest.js'
export type {
  CorpusProvider, CorpusSessionExpectation, CorpusFileRecord,
  CorpusGitFixture, SessionVisibility,
} from './types.js'

const T = (s: string): number => Date.parse(s)
const CLAUDE_PROVIDERS = ['claude', 'codex', 'opencode', 'amplifier'] as const

export interface BuildTiming {
  createdAt: number
  lastActivityAt: number
}

/**
 * Build the corpus under `homeDir` (typically an mkdtemp provided by the
 * caller). Returns the in-memory corpus; the identical manifest is on disk at
 * `<homeDir>/.freshell-corpus/manifest.json`.
 */
export async function buildSessionCorpus(
  homeDir: string,
  options: { runToken?: string; bulkCount?: number } = {},
): Promise<SessionCorpus> {
  const runToken = options.runToken ?? randomBytes(4).toString('hex')
  const bulkCount = options.bulkCount ?? 52
  const marker = `h04corpus-${runToken}`
  const ctx: CorpusContext = {
    homeDir,
    runToken,
    marker,
    workspace: path.join(homeDir, marker),
    files: [],
    sessions: [],
    gitFixtures: [],
  }

  const projectsRoot = path.join(ctx.workspace, 'projects')
  await fsp.mkdir(projectsRoot, { recursive: true })
  const projectDir = async (name: string): Promise<string> => {
    const dir = path.join(projectsRoot, name)
    await fsp.mkdir(dir, { recursive: true })
    return dir
  }

  // ── git layouts first: sessions reference their cwds/roots ──────────────
  const nested = await createNestedGitRepos(ctx)
  const worktree = await createWorktreePair(ctx)

  const overrides: Record<string, SessionOverrideEntry> = {}
  const claudeId = (() => {
    let n = 0
    return () => `10000000-0000-4000-8000-${(++n + 0x100).toString(16).padStart(12, '0')}`
  })()
  const applyOv = (exp: CorpusSessionExpectation, ov: SessionOverrideEntry) => {
    overrides[exp.key] = ov
    applySessionOverride(exp, ov)
  }

  // ── Claude ──────────────────────────────────────────────────────────────
  // Bulk page-fill: newest cohort, ms-resolved spread inside one second —
  // this is also the large fractional-timestamp population.
  const BULK_TOP = T('2026-08-04T12:00:00.900Z')
  for (let i = 1; i <= bulkCount; i += 1) {
    const last = BULK_TOP - i
    await writeClaudeSession(ctx, {
      role: `bulk-${String(i).padStart(3, '0')}`,
      sessionId: claudeId(),
      cwd: await projectDir(`bulk-p${i % 8}`),
      titleText: `${marker} bulk ${String(i).padStart(3, '0')}`,
      turns: 2,
      withSummary: true,
      createdAt: last - 4,
      lastActivityAt: last,
    })
  }

  const alphaCreated = T('2026-08-04T11:00:00.000Z')
  const alpha = await writeClaudeSession(ctx, {
    role: 'alpha',
    sessionId: claudeId(),
    cwd: await projectDir('alpha-project'),
    titleText: `${marker} alpha`,
    turns: 2,
    withSummary: true,
    createdAt: alphaCreated,
    lastActivityAt: alphaCreated + 4,
  })
  void alpha

  // Fractional-timestamp trio: one second, three distinct milliseconds.
  for (const [ms, role] of [[100, 'frac-100'], [200, 'frac-200'], [300, 'frac-300']] as const) {
    const last = T('2026-08-03T09:00:00.000Z') + ms
    await writeClaudeSession(ctx, {
      role,
      sessionId: claudeId(),
      cwd: await projectDir('frac-project'),
      titleText: `${marker} ${role}`,
      turns: 2,
      withSummary: true,
      createdAt: last - 4,
      lastActivityAt: last,
    })
  }

  // Git-layout sessions: projectPath must reflect REAL repo root resolution.
  const wtCreated = T('2026-08-03T08:00:00.000Z')
  const wtSession = await writeClaudeSession(ctx, {
    role: 'worktree',
    sessionId: claudeId(),
    cwd: worktree.wtCheckout,
    titleText: `${marker} worktree`,
    turns: 2,
    withSummary: true,
    createdAt: wtCreated,
    lastActivityAt: wtCreated + 4,
  })
  wtSession.projectPath = worktree.mainRepo
  wtSession.checkoutPath = worktree.wtCheckout

  const nestedCreated = T('2026-08-03T07:30:00.000Z')
  const nestedSession = await writeClaudeSession(ctx, {
    role: 'nested-repo',
    sessionId: claudeId(),
    cwd: nested.inner,
    titleText: `${marker} nested-repo`,
    turns: 2,
    withSummary: true,
    createdAt: nestedCreated,
    lastActivityAt: nestedCreated + 4,
  })
  nestedSession.projectPath = nested.inner

  const subdirCreated = T('2026-08-03T07:00:00.000Z')
  const subdirSession = await writeClaudeSession(ctx, {
    role: 'repo-subdir',
    sessionId: claudeId(),
    cwd: nested.subdir,
    titleText: `${marker} repo-subdir`,
    turns: 2,
    withSummary: true,
    createdAt: subdirCreated,
    lastActivityAt: subdirCreated + 4,
  })
  subdirSession.projectPath = nested.outer

  // Archived/deleted cohort carries the OLDEST timestamps: natural time order
  // then equals the wire's archived-last order, so cursor pagination is stable
  // across the archived boundary.
  const archClaude = await writeClaudeSession(ctx, {
    role: 'archived-claude',
    sessionId: claudeId(),
    cwd: await projectDir('archived-claude-project'),
    titleText: `${marker} archived-claude`,
    turns: 2,
    withSummary: true,
    createdAt: T('2026-07-02T08:00:00.000Z'),
    lastActivityAt: T('2026-07-02T08:00:00.004Z'),
  })
  applyOv(archClaude, { archived: true })

  const delClaude = await writeClaudeSession(ctx, {
    role: 'deleted-claude',
    sessionId: claudeId(),
    cwd: await projectDir('deleted-claude-project'),
    titleText: `${marker} deleted-claude`,
    turns: 2,
    withSummary: true,
    createdAt: T('2026-07-01T08:00:00.000Z'),
    lastActivityAt: T('2026-07-01T08:00:00.004Z'),
  })
  applyOv(delClaude, { deleted: true })

  const subCreated = T('2026-07-08T10:00:00.000Z')
  await writeClaudeSession(ctx, {
    role: 'subagent',
    sessionId: claudeId(),
    cwd: path.join(projectsRoot, 'alpha-project'),
    titleText: `${marker} subagent`,
    turns: 2,
    withSummary: false,
    subagent: true,
    createdAt: subCreated,
    lastActivityAt: subCreated + 4,
  })

  const niCreated = T('2026-07-10T10:00:00.000Z')
  await writeClaudeSession(ctx, {
    role: 'noninteractive',
    sessionId: claudeId(),
    cwd: await projectDir('noninteractive-project'),
    titleText: `${marker} noninteractive`,
    turns: 0,
    userMessages: 1,
    withSummary: false,
    createdAt: niCreated,
    lastActivityAt: niCreated + 1,
  })

  const emptyCreated = T('2026-07-05T10:00:00.000Z')
  await writeClaudeSession(ctx, {
    role: 'untitled-empty',
    sessionId: claudeId(),
    cwd: await projectDir('untitled-empty-project'),
    turns: 0,
    withSummary: false,
    createdAt: emptyCreated,
    lastActivityAt: emptyCreated,
  })

  // ── Codex ───────────────────────────────────────────────────────────────
  const gammaCreated = T('2026-08-03T10:00:00.000Z')
  await writeCodexSession(ctx, {
    role: 'gamma',
    sessionId: `${marker}-codex-gamma`,
    cwd: await projectDir('gamma-project'),
    titleText: `${marker} gamma`,
    createdAt: gammaCreated,
    lastActivityAt: gammaCreated + 2,
  })

  const archCodex = await writeCodexSession(ctx, {
    role: 'archived-codex',
    sessionId: `${marker}-codex-archived`,
    cwd: await projectDir('archived-codex-project'),
    titleText: `${marker} archived-codex`,
    createdAt: T('2026-07-02T07:55:00.000Z'),
    lastActivityAt: T('2026-07-02T07:55:00.002Z'),
  })
  applyOv(archCodex, { archived: true })

  const delCodex = await writeCodexSession(ctx, {
    role: 'deleted-codex',
    sessionId: `${marker}-codex-deleted`,
    cwd: await projectDir('deleted-codex-project'),
    titleText: `${marker} deleted-codex`,
    createdAt: T('2026-07-01T07:55:00.000Z'),
    lastActivityAt: T('2026-07-01T07:55:00.002Z'),
  })
  applyOv(delCodex, { deleted: true })

  const execCreated = T('2026-07-11T10:00:00.000Z')
  await writeCodexSession(ctx, {
    role: 'codex-exec',
    sessionId: `${marker}-codex-exec`,
    cwd: await projectDir('codex-exec-project'),
    titleText: `${marker} codex-exec`,
    createdAt: execCreated,
    lastActivityAt: execCreated + 2,
    source: 'exec',
  })

  await writeCodexSession(ctx, {
    role: 'provider-archived-codex',
    sessionId: `${marker}-codex-provider-archived`,
    cwd: path.join(projectsRoot, 'gamma-project'),
    titleText: `${marker} provider-archived-codex`,
    createdAt: T('2026-08-02T10:00:00.000Z'),
    lastActivityAt: T('2026-08-02T10:00:00.002Z'),
    archivedByProvider: true,
  })

  // ── OpenCode ────────────────────────────────────────────────────────────
  const [delta, echo, archOc] = await writeOpencodeCorpus(ctx, [
    {
      role: 'delta',
      sessionId: `${marker}-oc-delta`,
      title: `${marker} delta`,
      directory: await projectDir('delta-project'),
      projectId: `${marker}-proj-delta`,
      projectWorktree: await projectDir('delta-project'),
      timeCreated: T('2026-07-25T08:00:00.000Z'),
      timeUpdated: T('2026-07-25T08:00:00.001Z'),
    },
    {
      role: 'echo',
      sessionId: `${marker}-oc-echo`,
      title: `${marker} echo (provider title)`,
      directory: await projectDir('echo-project'),
      projectId: `${marker}-proj-echo`,
      projectWorktree: await projectDir('echo-project'),
      timeCreated: T('2026-07-19T08:00:00.000Z'),
      timeUpdated: T('2026-07-19T08:00:00.001Z'),
    },
    {
      role: 'archived-opencode',
      sessionId: `${marker}-oc-archived`,
      title: `${marker} archived-opencode`,
      directory: await projectDir('archived-opencode-project'),
      projectId: `${marker}-proj-archived-oc`,
      projectWorktree: await projectDir('archived-opencode-project'),
      timeCreated: T('2026-07-02T07:50:00.000Z'),
      timeUpdated: T('2026-07-02T07:50:00.001Z'),
    },
    {
      role: 'provider-archived-opencode',
      sessionId: `${marker}-oc-provider-archived`,
      title: `${marker} provider-archived-opencode`,
      directory: path.join(projectsRoot, 'delta-project'),
      projectId: `${marker}-proj-delta`,
      projectWorktree: path.join(projectsRoot, 'delta-project'),
      timeCreated: T('2026-07-21T08:00:00.000Z'),
      timeUpdated: T('2026-07-21T08:00:00.001Z'),
      timeArchived: T('2026-07-22T08:00:00.000Z'),
    },
    {
      role: 'child-opencode',
      sessionId: `${marker}-oc-child`,
      title: `${marker} child-opencode`,
      directory: path.join(projectsRoot, 'delta-project'),
      projectId: `${marker}-proj-delta`,
      projectWorktree: path.join(projectsRoot, 'delta-project'),
      timeCreated: T('2026-07-24T08:00:00.000Z'),
      timeUpdated: T('2026-07-24T08:00:00.001Z'),
      parentId: `${marker}-oc-delta`,
    },
    {
      role: 'deleted-opencode',
      sessionId: `${marker}-oc-deleted`,
      title: `${marker} deleted-opencode`,
      directory: await projectDir('deleted-opencode-project'),
      projectId: `${marker}-proj-deleted-oc`,
      projectWorktree: await projectDir('deleted-opencode-project'),
      timeCreated: T('2026-07-01T07:50:00.000Z'),
      timeUpdated: T('2026-07-01T07:50:00.001Z'),
    },
  ])
  applyOv(echo, {
    titleOverride: `${marker} echo renamed`,
    titleSource: 'user',
    summaryOverride: `${marker} echo override summary`,
  })
  applyOv(archOc, { archived: true })
  applyOv(
    ctx.sessions.find((s) => s.role === 'deleted-opencode')!,
    { deleted: true },
  )
  void delta

  // ── Amplifier ───────────────────────────────────────────────────────────
  await writeAmplifierSession(ctx, {
    role: 'epsilon',
    sessionId: `${marker}-amp-epsilon`,
    cwd: await projectDir('epsilon-project'),
    name: `${marker} epsilon`,
    description: `${marker} epsilon summary text`,
    created: T('2026-07-22T09:00:00.000Z') + 0.5, // fractional numeric → floored
    descriptionUpdatedAt: T('2026-07-22T09:00:02.000Z'),
    firstUserMessage: `${marker} epsilon request 1`,
    withEventsSidecar: true,
  })

  const archAmp = await writeAmplifierSession(ctx, {
    role: 'archived-amplifier',
    sessionId: `${marker}-amp-archived`,
    cwd: await projectDir('archived-amplifier-project'),
    name: `${marker} archived-amplifier`,
    description: `${marker} archived-amplifier summary`,
    created: T('2026-07-02T07:45:00.000Z'),
    descriptionUpdatedAt: T('2026-07-02T07:45:02.000Z'),
    firstUserMessage: `${marker} archived-amplifier request 1`,
    withEventsSidecar: true,
  })
  applyOv(archAmp, { archived: true })

  const delAmp = await writeAmplifierSession(ctx, {
    role: 'deleted-amplifier',
    sessionId: `${marker}-amp-deleted`,
    cwd: await projectDir('deleted-amplifier-project'),
    name: `${marker} deleted-amplifier`,
    description: `${marker} deleted-amplifier summary`,
    created: T('2026-07-01T07:45:00.000Z'),
    descriptionUpdatedAt: T('2026-07-01T07:45:02.000Z'),
    withEventsSidecar: false,
  })
  applyOv(delAmp, { deleted: true })

  // ── freshell config (settings + ALL session overrides) ──────────────────
  const freshellDir = path.join(ctx.homeDir, '.freshell')
  await fsp.mkdir(freshellDir, { recursive: true })
  const configPath = path.join(freshellDir, 'config.json')
  await fsp.writeFile(configPath, `${JSON.stringify({
    version: 1,
    settings: {
      codingCli: { enabledProviders: [...CLAUDE_PROVIDERS] },
    },
    sessionOverrides: overrides,
    terminalOverrides: {},
    projectColors: {},
  }, null, 2)}\n`)
  await recordFile(ctx.files, ctx.homeDir, configPath, 'freshell-config')

  // ── manifest ────────────────────────────────────────────────────────────
  const listedCount = ctx.sessions.filter((s) => s.visibility === 'listed').length
  const pageLimit = 50
  const expectedPages = Math.ceil(listedCount / pageLimit)
  if (expectedPages < 2) {
    throw new Error(`session corpus must exceed one page: listedCount=${listedCount}`)
  }

  const manifest: CorpusManifest = {
    formatVersion: 1,
    runId: marker,
    generatedAt: new Date().toISOString(),
    homeDir,
    providers: [...CLAUDE_PROVIDERS],
    roots: {
      claudeProjects: path.join(ctx.homeDir, '.claude', 'projects'),
      codexSessions: path.join(ctx.homeDir, '.codex', 'sessions'),
      codexArchived: path.join(ctx.homeDir, '.codex', 'archived_sessions'),
      opencodeData: path.join(ctx.homeDir, '.local', 'share', 'opencode'),
      amplifierProjects: path.join(ctx.homeDir, '.amplifier', 'projects'),
      freshellConfig: configPath,
      corpusWorkspace: ctx.workspace,
    },
    files: ctx.files,
    sessions: ctx.sessions,
    gitFixtures: ctx.gitFixtures,
    pagination: { listedCount, pageLimit, expectedPages },
  }
  const manifestPath = await writeManifest(ctx.homeDir, manifest)
  return { homeDir: ctx.homeDir, marker, manifestPath, manifest }
}
