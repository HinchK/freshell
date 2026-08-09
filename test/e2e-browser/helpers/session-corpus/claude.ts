/**
 * HARNESS-04 — Claude Code session writer.
 *
 * Writes real-layout `$CLAUDE_HOME/projects/<slug>/<sessionId>.jsonl` files
 * (plus `projects/<slug>/subagents/` for subagent sessions), matching what
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
  subagent?: boolean
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
  if (spec.turns > 0 || userMsgCount > 0) {
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
  const dir = spec.subagent ? path.join(projectDir, 'subagents') : projectDir
  await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${spec.sessionId}.jsonl`)

  const lines: string[] = []
  const initUuid = `${spec.sessionId}-sys`
  lines.push(JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: spec.sessionId,
    uuid: initUuid,
    timestamp: iso(spec.createdAt),
    cwd: spec.cwd,
    git: { branch: 'main', dirty: false },
  }))

  let previousUuid = initUuid
  for (let i = 1; i <= spec.turns; i += 1) {
    const userUuid = `${spec.sessionId}-u${i}`
    const asstUuid = `${spec.sessionId}-a${i}`
    lines.push(JSON.stringify({
      parentUuid: previousUuid,
      cwd: spec.cwd,
      sessionId: spec.sessionId,
      version: '2.1.23',
      gitBranch: 'main',
      type: 'user',
      message: {
        role: 'user',
        content: i === 1
          ? `${spec.titleText ?? spec.role} request ${i}`
          : `${spec.titleText ?? spec.role} request ${i} followup`,
      },
      uuid: userUuid,
      timestamp: iso(spec.createdAt + 2 * i - 1),
    }))
    lines.push(JSON.stringify({
      parentUuid: userUuid,
      cwd: spec.cwd,
      sessionId: spec.sessionId,
      version: '2.1.23',
      gitBranch: 'main',
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
      timestamp: iso(spec.createdAt + 2 * i),
    }))
    previousUuid = asstUuid
  }

  // Bare (unreplied) user messages — the 'noninteractive' role.
  for (let i = spec.turns + 1; i <= spec.turns + (userMsgCount - spec.turns); i += 1) {
    const userUuid = `${spec.sessionId}-u${i}`
    lines.push(JSON.stringify({
      parentUuid: previousUuid,
      cwd: spec.cwd,
      sessionId: spec.sessionId,
      version: '2.1.23',
      gitBranch: 'main',
      type: 'user',
      message: { role: 'user', content: `${spec.titleText ?? spec.role} request ${i}` },
      uuid: userUuid,
      timestamp: iso(spec.createdAt + 1),
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
  const expectation: CorpusSessionExpectation = {
    key: `claude:${spec.sessionId}`,
    provider: 'claude',
    sessionId: spec.sessionId,
    role: spec.role,
    title: spec.titleText,
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
