import type { AppStore } from '@/store/store'
import { updateTab } from '@/store/tabsSlice'
import { updatePaneContent, setPaneHandoffError } from '@/store/panesSlice'
import { requestSessionHandoff, setSessionMetadata, type SessionHandoffResult } from '@/lib/api'
import { buildResumeContent, buildTerminalAttachContent } from '@/lib/session-type-utils'
import { findPaneContent } from '@/lib/pane-utils'
import { mergeSessionMetadataByKey } from '@/lib/session-metadata'
import { hasWaitingPrompt, resolvePaneActivity } from '@/lib/pane-activity'
import { getFreshOpenCodeRouteCwd } from '@/lib/fresh-opencode-route'
import { selectSessionRuntimeOwner } from '@/store/selectors/runtimeOwner'
import { resolveReopenPaneSessionTarget, type ReopenPaneSessionTarget } from '@/lib/session-flavor-reopen'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import type { FreshAgentProviderSettings } from '@/lib/fresh-agent-provider-types'
import type { FreshAgentSessionState } from '@/store/freshAgentTypes'
import type { PaneRuntimeActivityRecord } from '@/store/paneRuntimeActivitySlice'
import type { Tab } from '@/store/types'
import type { PaneContent, TerminalPaneContent, FreshAgentPaneContent } from '@/store/paneTypes'
import { createLogger } from '@/lib/client-logger'

const log = createLogger('SessionHandoff')

/**
 * kata b8ke: how long a user-driven handoff Retry waits before re-invoking
 * the server — a short backoff so a double-click can never tight-loop the
 * coordinator (round-3 review). Not an automatic retry loop: the User
 * Request forbids fixing handoffs with retries; every invocation here is
 * user-initiated.
 */
export const SESSION_HANDOFF_RETRY_BACKOFF_MS = 750

const EMPTY_CODEX_ACTIVITY_BY_ID = {}
const EMPTY_OPENCODE_ACTIVITY_BY_ID = {}
const EMPTY_CLAUDE_ACTIVITY_BY_ID = {}
const EMPTY_AMPLIFIER_ACTIVITY_BY_ID = {}
const EMPTY_PANE_RUNTIME_ACTIVITY_BY_ID: Record<string, PaneRuntimeActivityRecord> = {}
const EMPTY_FRESH_AGENT_SESSIONS: Record<string, FreshAgentSessionState> = {}

/** The pane context a handoff run resolves (mirrors the ContextMenuProvider fold). */
type ReopenPaneContext = {
  tab: Tab
  content: TerminalPaneContent | FreshAgentPaneContent
  target: ReopenPaneSessionTarget
  providerSettings: FreshAgentProviderSettings | undefined
  freshAgentSessions: Record<string, FreshAgentSessionState>
}

function sameReopenTargetIdentity(
  a: ReopenPaneSessionTarget,
  b: ReopenPaneSessionTarget,
): boolean {
  return a.tabId === b.tabId
    && a.paneId === b.paneId
    && a.sourceSessionType === b.sourceSessionType
    && a.targetSessionType === b.targetSessionType
    && a.provider === b.provider
    && a.sessionId === b.sessionId
}

function resolveReopenContext(
  state: ReturnType<AppStore['getState']>,
  tabId: string,
  paneId: string,
): ReopenPaneContext | null {
  const tab = state.tabs.tabs.find((item) => item.id === tabId)
  const layout = state.panes.layouts[tabId]
  const content: PaneContent | null = layout ? findPaneContent(layout, paneId) : null
  if (!tab || !content) return null
  // A reopen target only exists for terminal/fresh-agent panes — narrowing
  // here keeps the context's content typed for the createRequestId read.
  if (content.kind !== 'terminal' && content.kind !== 'fresh-agent') return null

  const activity = resolvePaneActivity({
    paneId,
    content,
    tabMode: tab.mode,
    isOnlyPane: layout.type === 'leaf',
    codexActivityByTerminalId: state.codexActivity?.byTerminalId ?? EMPTY_CODEX_ACTIVITY_BY_ID,
    opencodeActivityByTerminalId: state.opencodeActivity?.byTerminalId ?? EMPTY_OPENCODE_ACTIVITY_BY_ID,
    claudeActivityByTerminalId: state.claudeActivity?.byTerminalId ?? EMPTY_CLAUDE_ACTIVITY_BY_ID,
    amplifierActivityByTerminalId: state.amplifierActivity?.byTerminalId ?? EMPTY_AMPLIFIER_ACTIVITY_BY_ID,
    paneRuntimeActivityByPaneId: state.paneRuntimeActivity?.byPaneId ?? EMPTY_PANE_RUNTIME_ACTIVITY_BY_ID,
    freshAgentSessions: state.freshAgent?.sessions ?? EMPTY_FRESH_AGENT_SESSIONS,
  })
  let hasWaitingItems = false
  if (content.kind === 'fresh-agent' && content.sessionId) {
    hasWaitingItems = hasWaitingPrompt(
      (state.freshAgent?.sessions ?? EMPTY_FRESH_AGENT_SESSIONS)[
        makeFreshAgentSessionKey({
          sessionType: content.sessionType,
          provider: content.provider,
          sessionId: content.sessionId,
        })
      ],
    )
  }

  const target = resolveReopenPaneSessionTarget({
    tabId,
    paneId,
    content,
    tab,
    activity: {
      isBusy: activity.isBusy,
      ...(hasWaitingItems ? { hasWaitingItems } : {}),
    },
  })
  if (!target) return null
  return {
    tab,
    content,
    target,
    providerSettings: state.settings.settings.freshAgent?.providers?.[target.targetSessionType],
    freshAgentSessions: state.freshAgent?.sessions ?? EMPTY_FRESH_AGENT_SESSIONS,
  }
}

/**
 * kata b8ke: the ONE atomic reopen handoff runner. The server enters
 * Handoff (generation+1) under the coordinator lease, stops the prior
 * runtime, awaits its confirmed reap, starts the target, and commits +
 * broadcasts the new owner — the client sends ONE awaited request keyed on
 * the pane's durable sessionRef (content.sessionId is NOT required) and
 * converts locally only on success. Failure keeps the pane and folds the
 * typed error for the banner + Retry surface.
 *
 * `expected` (the clicked menu target) guards against the pane changing
 * identity mid-flight — the same guard the pre-b8ke flow had.
 */
export async function runPaneSessionHandoff(
  appStore: AppStore,
  options: { tabId: string; paneId: string; expected?: ReopenPaneSessionTarget },
): Promise<boolean> {
  const { tabId, paneId, expected } = options

  const current = resolveReopenContext(appStore.getState(), tabId, paneId)
  if (!current || current.target.disabled) return false
  if (expected && !sameReopenTargetIdentity(current.target, expected)) return false

  // Durable metadata FIRST, flavor-preserving (kilroy keeps recording
  // itself — the runtime-kind change must not orphan the flavor), with its
  // failure abort keeping the pane untouched.
  try {
    await setSessionMetadata(
      current.target.provider,
      current.target.sessionId,
      current.target.metadataSessionType,
      { sessionTypeSource: 'explicit' },
    )
  } catch (err) {
    log.warn({
      event: 'reopen_session_flavor_metadata_persist_failed',
      provider: current.target.provider,
      sessionId: current.target.sessionId,
      targetSessionType: current.target.targetSessionType,
      tabId,
      paneId,
      err,
    })
    return false
  }

  const latest = resolveReopenContext(appStore.getState(), tabId, paneId)
  if (!latest || latest.target.disabled) return false
  if (expected && !sameReopenTargetIdentity(latest.target, expected)) return false

  const resolvedCwd = latest.target.cwd ?? getFreshOpenCodeRouteCwd(
    latest.content,
    {
      freshAgentSessions: latest.freshAgentSessions,
      sessionId: latest.target.sessionId,
    },
  )

  // The observed (epoch, generation) fence pair is read at SEND time — a
  // retry after a stale-generation failure always carries the refreshed
  // pair from the runtime-owner record, never the stale one (round-2).
  const ownerRecord = selectSessionRuntimeOwner(
    appStore.getState(),
    latest.target.provider,
    latest.target.sessionId,
  )

  let handoff: SessionHandoffResult
  try {
    handoff = await requestSessionHandoff({
      provider: latest.target.provider,
      sessionId: latest.target.sessionId,
      targetKind: latest.target.targetKind,
      ...(latest.target.targetKind === 'fresh-agent'
        ? { sessionType: latest.target.targetSessionType }
        : { mode: latest.target.runtimeProvider }),
      tabId,
      paneId,
      ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
      ...(ownerRecord
        ? { observedEpoch: ownerRecord.epoch, observedGeneration: ownerRecord.generation }
        : {}),
      deviceId: appStore.getState().tabRegistry?.deviceId,
    })
  } catch (err) {
    log.warn({
      event: 'session_handoff_request_failed',
      provider: latest.target.provider,
      sessionId: latest.target.sessionId,
      targetKind: latest.target.targetKind,
      tabId,
      paneId,
      err,
    })
    appStore.dispatch(setPaneHandoffError({
      tabId,
      paneId,
      error: {
        code: 'HANDOFF_REQUEST_FAILED',
        message: 'The reopen could not reach the server. Try again.',
        retryable: true,
        generation: 0,
      },
    }))
    return false
  }

  if (!handoff.ok) {
    appStore.dispatch(setPaneHandoffError({
      tabId,
      paneId,
      error: {
        code: handoff.error.code,
        message: handoff.error.message,
        retryable: handoff.error.retryable,
        generation: handoff.error.ownerGeneration ?? 0,
      },
    }))
    return false
  }

  appStore.dispatch(updatePaneContent({
    tabId,
    paneId,
    content: handoff.owner.kind === 'terminal'
      ? buildTerminalAttachContent({
        createRequestId: latest.content.createRequestId,
        mode: handoff.owner.mode,
        provider: latest.target.provider,
        sessionId: latest.target.sessionId,
        terminalId: handoff.owner.terminalId,
        cwd: resolvedCwd,
      })
      : buildResumeContent({
        sessionType: handoff.owner.sessionType,
        sessionId: latest.target.sessionId,
        cwd: resolvedCwd,
        freshAgentProviderSettings: latest.providerSettings,
      }),
  }))

  const sessionMetadataByKey = mergeSessionMetadataByKey(
    latest.tab.sessionMetadataByKey,
    latest.target.provider,
    latest.target.sessionId,
    { sessionType: latest.target.metadataSessionType },
  )
  if (sessionMetadataByKey !== latest.tab.sessionMetadataByKey) {
    appStore.dispatch(updateTab({
      id: latest.tab.id,
      updates: { sessionMetadataByKey },
    }))
  }
  return true
}
