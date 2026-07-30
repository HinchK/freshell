import { parseResumeInput } from '../../shared/resume-input-parser.js'
import type {
  ResumeResolveMatch,
  ResumeResolveResponse,
} from '../../shared/resume-resolve-contract.js'
import type { CodingCliSession, ProjectGroup } from './types.js'
import type { ClaudeTranscriptHit } from './claude-transcript-locator.js'

export const RESOLVE_MATCH_CAP = 20

export interface ResolveResumeDeps {
  getProjects: () => ProjectGroup[]
  isIndexReady: () => boolean
  resolveOpencodeSessionIds?: (
    ids: readonly string[],
  ) => Promise<{
    rootsBySessionId: Map<string, string>
    directoriesBySessionId?: Map<string, string>
    unresolvedSessionIds: Set<string>
  }>
  locateClaudeTranscript?: (sessionId: string) => Promise<ClaudeTranscriptHit | null>
}

export async function resolveResumeInput(
  input: string,
  deps: ResolveResumeDeps,
): Promise<ResumeResolveResponse> {
  const { candidates, hint } = parseResumeInput(input)

  if (!deps.isIndexReady()) {
    return { status: 'warming', matches: [], hint }
  }
  if (candidates.length === 0) {
    return { status: 'ready', matches: [], hint }
  }

  const sessions = deps.getProjects().flatMap((group) => group.sessions)

  // Evidence pass: one scan answers all providers at once. Candidates are
  // tried in priority order until one resolves.
  for (const candidate of candidates) {
    const needle = candidate.token.toLowerCase()
    const exact: ResumeResolveMatch[] = []
    const prefix: ResumeResolveMatch[] = []
    for (const session of sessions) {
      const id = session.sessionId.toLowerCase()
      if (id === needle) exact.push(toMatch(session, 'exact'))
      else if (id.startsWith(needle)) prefix.push(toMatch(session, 'prefix'))
    }
    const matches = exact.length > 0 ? exact : prefix
    if (matches.length > 0) {
      matches.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
      return { status: 'ready', matches: dedupe(matches).slice(0, RESOLVE_MATCH_CAP), hint }
    }
  }

  // Exact-id fallbacks for sessions the index cannot see (opencode child
  // sessions; cwd-less claude transcripts skipped on cold start).
  for (const candidate of candidates) {
    if (
      candidate.kind === 'prefixed-id' &&
      candidate.token.startsWith('ses_') &&
      deps.resolveOpencodeSessionIds
    ) {
      const resolution = await deps.resolveOpencodeSessionIds([candidate.token])
      if (!resolution.unresolvedSessionIds.has(candidate.token)) {
        return {
          status: 'ready',
          matches: [
            {
              provider: 'opencode',
              sessionId: candidate.token,
              // opencode resumes in the SPAWN cwd, not the session's stored
              // project dir — a cwd-less match would run the agent in the
              // wrong directory. The sqlite row's NOT NULL `directory`
              // column always supplies it.
              cwd: resolution.directoriesBySessionId?.get(candidate.token),
              sessionType: 'opencode',
              matchKind: 'exact',
            },
          ],
          hint,
        }
      }
    }
    if (candidate.kind === 'uuid' && deps.locateClaudeTranscript) {
      const hit = await deps.locateClaudeTranscript(candidate.token)
      if (hit) {
        return {
          status: 'ready',
          matches: [
            {
              provider: 'claude',
              sessionId: hit.sessionId,
              cwd: hit.cwd,
              sessionType: 'claude',
              matchKind: 'exact',
            },
          ],
          hint,
        }
      }
    }
  }

  return { status: 'ready', matches: [], hint }
}

function toMatch(session: CodingCliSession, matchKind: 'exact' | 'prefix'): ResumeResolveMatch {
  return {
    provider: session.provider,
    sessionId: session.sessionId,
    cwd: session.cwd ?? session.projectPath,
    sessionType: session.sessionType,
    title: session.title,
    firstUserMessage: session.firstUserMessage,
    lastActivityAt: session.lastActivityAt,
    matchKind,
  }
}

// Real stores carry the SAME (provider, sessionId) on multiple snapshot
// entries (observed: one claude id across 3 transcript files). Matches are
// sorted lastActivityAt desc BEFORE deduping, so the survivor is the entry
// with the most recent activity.
function dedupe(matches: ResumeResolveMatch[]): ResumeResolveMatch[] {
  const seen = new Set<string>()
  return matches.filter((match) => {
    const key = `${match.provider}:${match.sessionId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
