import type { CodingCliProviderName } from '@/lib/coding-cli-types'
import type { FreshAgentPaneContent } from '@/store/paneTypes'
import type { FreshAgentSessionState } from '@/store/freshAgentTypes'
import { getPreferredResumeSessionId } from '@/store/persistControl'
import type { CodingCliSession, ProjectGroup } from '@/store/types'

export type FreshAgentContextUsage = {
  percent: number
  contextTokens: number
  thresholdTokens: number
}

export function findIndexedSessionById(
  projects: ProjectGroup[],
  provider: CodingCliProviderName,
  sessionId: string,
): CodingCliSession | undefined {
  for (const project of projects) {
    const match = project.sessions.find((session) => (
      session.provider === provider && session.sessionId === sessionId
    ))
    if (match) return match
  }
  return undefined
}

/** Durable session id chain: preferred resume id → resumeSessionId → sessionRef
 * tail. sessionRef is the canonical durable identity — normalization flows can
 * strip resumeSessionId while retaining sessionRef, so a restored pane may
 * present sessionRef-only. The sessionRef tail only applies when its provider
 * matches the pane's provider. */
function durableSessionId(
  content: FreshAgentPaneContent,
  session: FreshAgentSessionState | undefined,
): string | undefined {
  return getPreferredResumeSessionId(session)
    ?? content.resumeSessionId
    ?? (content.sessionRef?.provider === content.provider ? content.sessionRef.sessionId : undefined)
}

/**
 * Resolve the live context-window usage for a fresh-agent pane from the
 * session indexer. Returns null (unknown) unless compactPercent AND
 * contextTokens AND compactThresholdTokens are all finite numbers — a partial
 * record must never render a meter with a token-less tooltip.
 */
export function resolveFreshAgentContextUsage(
  content: FreshAgentPaneContent,
  session: FreshAgentSessionState | undefined,
  projects: ProjectGroup[],
): FreshAgentContextUsage | null {
  const sessionId = durableSessionId(content, session)
  if (!sessionId) return null
  const indexed = findIndexedSessionById(projects, content.provider, sessionId)
  const usage = indexed?.tokenUsage
  if (!usage) return null

  const raw = usage.compactPercent
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  const contextTokens = usage.contextTokens
  if (typeof contextTokens !== 'number' || !Number.isFinite(contextTokens)) return null
  const thresholdTokens = usage.compactThresholdTokens
  if (typeof thresholdTokens !== 'number' || !Number.isFinite(thresholdTokens)) return null

  const percent = Math.max(0, Math.min(100, Math.round(raw)))
  return {
    percent,
    contextTokens: Math.round(contextTokens),
    thresholdTokens: Math.round(thresholdTokens),
  }
}
