/**
 * HARNESS-04 — Claude Code session writer.
 *
 * Writes real-layout `$CLAUDE_HOME/projects/<slug>/<sessionId>.jsonl` files
 * (plus `projects/<slug>/<parentId>/subagents/agent-<id>.jsonl` for subagents), matching what
 * `server/coding-cli/providers/claude.ts` + `session-indexer.ts` parse:
 *  - `system`/`init` line first (session_id, cwd, createdAt timestamp)
 *  - user/assistant turn pairs (parentUuid-chained, `message.role`/`content`)
 *  - optional trailing `summary` line (no timestamp — feeds title + summary,
 *    never recency; the tail-walk lands on the last timestamped turn line)
 *
 * Turn timestamps are scheduled so the LAST assistant line IS
 * `lastActivityAt`: init=createdAt, user_i=createdAt+2i-1, asst_i=createdAt+2i.
 *
 * Interactivity rule (`parseSessionFile`): ≤1 user text message ⇒
 * `isNonInteractive`. So every session that must be visible by default gets
 * ≥2 user messages; the corpus's 'noninteractive' and 'untitled-empty' roles
 * deliberately stay at 1/0.
 */

import path from 'path'
import fsp from 'fs/promises'
import type { CorpusContext, CorpusSessionExpectation } from './types.js'
import { recordFile } from './manifest.js'

export function claudeProjectSlug(cwd: string): string {
  // Real Claude Code project dir names: every non-alphanumeric rune → '-'.
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export interface ClaudeSessionSpec {
  role: string
  sessionId: string
  cwd: string
  /** Title-bearing text: written into the summary line when `withSummary`, else into the first user message. */
  titleText?: string
  /** user/assistant REPLY pairs (each implies one user message). */
  turns: number
  /** Additional user messages without replies (0/1). Default: `turns === 0 ? 0 : undefined`. */
  userMessages?: number
  withSummary: boolean
  createdAt: number
  lastActivityAt: number
  /**
   * Subagent transcript: written at the REAL claude layout
   * `projects/<slug>/<parentSessionId>/subagents/agent-<id>.jsonl` with
   * sidechain lines (`isSidechain: true`, promptId, agentId, and the parent sessionId —
   * the indexed child session id is nevertheless the filename stem, matching
   * `claude.extractSessionId`).
   */
  subagent?: { parentSessionId: string }
}

const iso = (ms: number): string => new Date(ms).toISOString()

export async function writeClaudeSession(
  ctx: CorpusContext,
  spec: ClaudeSessionSpec,
): Promise<CorpusSessionExpectation> {
  const userMsgCount = spec.userMessages ?? spec.turns
  if (spec.turns > 0 && spec.userMessages !== undefined && spec.userMessages !== spec.turns) {
    // The schedule below places bare user messages at createdAt+1, which only
    // works when there is no turn schedule (turns=0). The corpus never mixes
    // the two; refuse rather than emit a misordered transcript.
    throw new Error(`writeClaudeSession(${spec.role}): userMessages override requires turns === 0`)
  }
  if (spec.subagent) {
    // Sidechain transcripts have NO init line: turn i stamps are
    // user=createdAt+2(i-1), assistant=createdAt+2i-1.
    const wantsLast = spec.createdAt + 2 * spec.turns - 1
    if (spec.turns < 1 || spec.lastActivityAt !== wantsLast) {
      throw new Error(
        `writeClaudeSession(${spec.role}): subagent transcripts need turns>=1 and ` +
        `lastActivityAt === createdAt+2*turns-1 (${wantsLast}), got ${spec.lastActivityAt}`,
      )
    }
  } else if (spec.turns > 0 || userMsgCount > 0) {
    const expectedLast = spec.createdAt + 2 * spec.turns
    const soloTs = spec.createdAt + 1
    if (spec.turns > 0 && spec.lastActivityAt !== expectedLast) {
      throw new Error(
        `writeClaudeSession(${spec.role}): lastActivityAt ${spec.lastActivityAt} ` +
        `!= scheduled end of ${spec.turns} turns (${expectedLast})`,
      )
    }
    if (spec.turns === 0 && userMsgCount > 0 && spec.lastActivityAt !== soloTs) {
      throw new Error(
        `writeClaudeSession(${spec.role}): with ${userMsgCount} bare user message, ` +
        `lastActivityAt must be createdAt+1 (${soloTs}), got ${spec.lastActivityAt}`,
      )
    }
  }

  const projectDir = path.join(ctx.homeDir, '.claude', 'projects', claudeProjectSlug(spec.cwd))
  const dir = spec.subagent
    ? path.join(projectDir, spec.subagent.parentSessionId, 'subagents')
    : projectDir
  await fsp.mkdir(dir, { recursive: true })
  // Indexed id = filename stem. Real sidechain lines carry their parent sessionId,
  // while `claude.extractSessionId` deliberately makes the child stem authoritative.
  const indexedId = spec.subagent ? `agent-${spec.sessionId}` : spec.sessionId
  const file = path.join(dir, `${indexedId}.jsonl`)

  const lineBase = (schedTs: number) => ({
    cwd: spec.cwd,
    version: '2.1.23' as const,
    gitBranch: 'main',
    timestamp: iso(schedTs),
    ...(spec.subagent
      ? {
          sessionId: spec.subagent.parentSessionId,
          isSidechain: true,
          promptId: `${spec.sessionId}-prompt`,
          agentId: spec.sessionId,
        }
      : { sessionId: spec.sessionId }),
  })

  const lines: string[] = []
  const initUuid = `${spec.sessionId}-sys`
  if (!spec.subagent) {
    lines.push(JSON.stringify({
      ...lineBase(spec.createdAt),
      type: 'system',
      subtype: 'init',
      session_id: spec.sessionId,
      uuid: initUuid,
    }))
  }

  let previousUuid: string | null = spec.subagent ? null : initUuid
  for (let i = 1; i <= spec.turns; i += 1) {
    const userUuid = `${spec.sessionId}-u${i}`
    const asstUuid = `${spec.sessionId}-a${i}`
    const userTs = spec.subagent ? spec.createdAt + 2 * (i - 1) : spec.createdAt + 2 * i - 1
    const asstTs = spec.subagent ? spec.createdAt + 2 * i - 1 : spec.createdAt + 2 * i
    lines.push(JSON.stringify({
      ...lineBase(userTs),
      parentUuid: previousUuid,
      type: 'user',
      message: {
        role: 'user',
        content: i === 1
          ? `${spec.titleText ?? spec.role} request ${i}`
          : `${spec.titleText ?? spec.role} request ${i} followup`,
      },
      uuid: userUuid,
    }))
    lines.push(JSON.stringify({
      ...lineBase(asstTs),
      parentUuid: userUuid,
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-6-20260301',
        content: [{ type: 'text', text: `${spec.titleText ?? spec.role} reply ${i}` }],
        usage: {
          input_tokens: 100,
          output_tokens: 40,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
      uuid: asstUuid,
    }))
    previousUuid = asstUuid
  }

  // Bare (unreplied) user messages — the 'noninteractive' role.
  for (let i = spec.turns + 1; i <= spec.turns + (userMsgCount - spec.turns); i += 1) {
    const userUuid = `${spec.sessionId}-u${i}`
    lines.push(JSON.stringify({
      ...lineBase(spec.createdAt + 1),
      parentUuid: previousUuid,
      type: 'user',
      message: { role: 'user', content: `${spec.titleText ?? spec.role} request ${i}` },
      uuid: userUuid,
    }))
    previousUuid = userUuid
  }

  if (spec.withSummary) {
    lines.push(JSON.stringify({
      type: 'summary',
      summary: spec.titleText ?? spec.role,
      leafUuid: previousUuid,
    }))
  }

  await fsp.writeFile(file, `${lines.join('\n')}\n`)
  await recordFile(ctx.files, ctx.homeDir, file, `claude-session:${spec.role}`)

  const interactive = userMsgCount > 1
  // Wire title mirrors the server's derivation: summary line when present,
  // else the FULL first user message text (extractTitleFromMessage), else none.
  const wireTitle = spec.withSummary
    ? spec.titleText
    : userMsgCount > 0 && spec.titleText
      ? `${spec.titleText} request 1`
      : undefined
  const expectation: CorpusSessionExpectation = {
    key: `claude:${indexedId}`,
    provider: 'claude',
    sessionId: indexedId,
    role: spec.role,
    title: wireTitle,
    summary: spec.withSummary ? (spec.titleText ?? spec.role) : undefined,
    projectPath: spec.cwd,
    cwd: spec.cwd,
    createdAt: spec.createdAt,
    lastActivityAt: spec.lastActivityAt,
    visibility: 'listed',
  }
  if (spec.subagent) {
    expectation.visibility = 'hidden-default'
    expectation.visibleWith = { includeSubagents: true }
  } else if (!interactive && spec.titleText) {
    expectation.visibility = 'hidden-default'
    expectation.visibleWith = { includeNonInteractive: true }
  } else if (!interactive && !spec.titleText) {
    expectation.visibility = 'hidden-default'
    expectation.visibleWith = { includeNonInteractive: true, includeEmpty: true }
  }
  ctx.sessions.push(expectation)
  return expectation
}
