import type { Tab, CodingCliProviderName } from '@/store/types'
import type { PaneContent } from '@/store/paneTypes'
import { getPairedSessionTypeTarget } from '@/lib/session-type-utils'
import { isDurableProviderSessionId } from '@shared/session-flavor'

export type ReopenPaneActivity = {
  isBusy: boolean
  hasWaitingItems?: boolean
}

export type ReopenPaneSessionTarget = {
  tabId: string
  paneId: string
  /** The pane's current session type — a public type OR the hidden kilroy flavor. */
  sourceSessionType: string
  targetSessionType: string
  provider: CodingCliProviderName
  sessionId: string
  cwd?: string
  label: string
  disabled: boolean
  disabledReason?: string
  /** The handoff's target runtime kind ('terminal' = the paired CLI). */
  targetKind: 'terminal' | 'fresh-agent'
  /** The paired CLI lane the target rides (claude/codex/opencode). */
  runtimeProvider: CodingCliProviderName
  /**
   * The session flavor the metadata legs record for this reopen
   * (setSessionMetadata + the tab's sessionMetadataByKey merge). Equals the
   * target EXCEPT when a hidden flavor rides the target CLI: a kilroy pane
   * reopened as the Claude CLI records KILROY — the runtime-kind change
   * must not orphan the flavor (round-2 R2-10). The public types keep
   * recording the target exactly as before.
   */
  metadataSessionType: string
}

function paneSourceSessionType(content: PaneContent): string | undefined {
  if (content.kind === 'terminal') return content.mode !== 'shell' ? content.mode : undefined
  if (content.kind === 'fresh-agent') return content.sessionType
  return undefined
}

/** The session flavor recorded on the pane's tab for a durable session. */
function recordedSessionFlavor(
  tab: Tab | undefined,
  ref: { provider: string; sessionId: string },
): string | undefined {
  return tab?.sessionMetadataByKey?.[`${ref.provider}:${ref.sessionId}`]?.sessionType
}

function paneCwd(content: PaneContent, tab?: Tab): string | undefined {
  return ('initialCwd' in content ? content.initialCwd : undefined) ?? tab?.initialCwd
}

function validRef(provider: string | undefined, sessionId: string | undefined) {
  if (!provider || !sessionId) return null
  return isDurableProviderSessionId(provider, sessionId)
    ? { provider: provider as CodingCliProviderName, sessionId }
    : null
}

function durableCodexRef(content: PaneContent) {
  if (content.kind !== 'terminal' || content.mode !== 'codex') return null
  const durableThreadId = content.codexDurability?.durableThreadId
  const state = content.codexDurability?.state
  if ((state === 'durable' || state === 'durable_resuming') && durableThreadId) {
    return validRef('codex', durableThreadId)
  }
  return null
}

function durablePaneSessionRef(content: PaneContent, tab?: Tab) {
  if (content.kind === 'terminal') {
    return validRef(content.sessionRef?.provider, content.sessionRef?.sessionId)
      ?? durableCodexRef(content)
      ?? (content.mode === 'codex'
        ? null
        : validRef(content.mode !== 'shell' ? content.mode : undefined, content.resumeSessionId))
      ?? validRef(tab?.sessionRef?.provider, tab?.sessionRef?.sessionId)
      ?? (tab?.mode === 'codex'
        ? null
        : validRef(tab?.mode !== 'shell' ? tab?.mode : undefined, tab?.resumeSessionId))
  }
  if (content.kind === 'fresh-agent') {
    return validRef(content.sessionRef?.provider, content.sessionRef?.sessionId)
      ?? validRef(content.provider, content.resumeSessionId)
      ?? validRef(tab?.sessionRef?.provider, tab?.sessionRef?.sessionId)
  }
  return null
}

function disabledReason(content: PaneContent, activity: ReopenPaneActivity): string | undefined {
  if (activity.hasWaitingItems) return 'Agent is waiting for input'
  if (activity.isBusy) return 'Agent is busy'
  if (content.kind === 'fresh-agent' && (content.status === 'creating' || content.status === 'starting')) {
    return 'Agent is still starting'
  }
  if (content.kind === 'terminal' && content.status === 'creating') {
    return 'Terminal is still starting'
  }
  return undefined
}

export function resolveReopenPaneSessionTarget(input: {
  tabId: string
  paneId: string
  content: PaneContent | null
  tab?: Tab
  activity: ReopenPaneActivity
}): ReopenPaneSessionTarget | null {
  const { tabId, paneId, content, tab, activity } = input
  if (!content) return null
  const sourceSessionType = paneSourceSessionType(content)
  // Resolve the durable ref FIRST — the recorded session flavor (kilroy)
  // participates in the paired-target derivation for CLI panes.
  const durableRef = durablePaneSessionRef(content, tab)
  const paired = durableRef
    ? getPairedSessionTypeTarget(sourceSessionType, {
      flavor: recordedSessionFlavor(tab, durableRef),
    })
    : null
  if (!paired || !durableRef || durableRef.provider !== paired.runtimeProvider) return null
  const reason = disabledReason(content, activity)
  return {
    tabId,
    paneId,
    sourceSessionType: paired.sourceSessionType,
    targetSessionType: paired.targetSessionType,
    provider: durableRef.provider,
    sessionId: durableRef.sessionId,
    cwd: paneCwd(content, tab),
    label: paired.label,
    disabled: Boolean(reason),
    ...(reason ? { disabledReason: reason } : {}),
    targetKind: paired.targetKind,
    runtimeProvider: paired.runtimeProvider,
    metadataSessionType: paired.metadataSessionType,
  }
}
