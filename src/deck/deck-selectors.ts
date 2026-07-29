import type { RootState } from '@/store/store'
import type { Tab } from '@/store/types'
import type { FreshAgentPaneContent, PaneContent, PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import type { TabStatusFlags } from './tile-state'
import { collectPaneEntries } from '@/lib/pane-utils'
import { getBusyPaneIdsForTab, hasWaitingPrompt, resolvePaneActivity } from '@/lib/pane-activity'
import { getFreshOpenCodeRouteCwd } from '@/lib/fresh-opencode-route'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'

export type TabRingStatus = { busy: boolean; green: boolean; amber: boolean }
export type DeckTab = { id: string; title: string; status: TabRingStatus; active: boolean }
export type DeckModel = { tabs: DeckTab[]; activeTabId: string | null }

function activityInputs(state: RootState) {
  return {
    codexActivityByTerminalId: state.codexActivity.byTerminalId,
    opencodeActivityByTerminalId: state.opencodeActivity.byTerminalId,
    claudeActivityByTerminalId: state.claudeActivity.byTerminalId,
    amplifierActivityByTerminalId: state.amplifierActivity.byTerminalId,
    paneRuntimeActivityByPaneId: state.paneRuntimeActivity.byPaneId,
    freshAgentSessions: state.freshAgent.sessions,
  }
}

function freshAgentSessionFor(state: RootState, content: FreshAgentPaneContent) {
  if (!content.sessionId) return undefined
  return state.freshAgent.sessions[makeFreshAgentSessionKey({
    sessionType: content.sessionType, provider: content.provider, sessionId: content.sessionId,
  })]
}

export function tabHasPendingApproval(state: RootState, tabId: string): boolean {
  const layout = state.panes.layouts[tabId]
  if (!layout) return false
  return collectPaneEntries(layout).some((entry) =>
    entry.content.kind === 'fresh-agent' && hasWaitingPrompt(freshAgentSessionFor(state, entry.content)))
}

export function getTabRingStatus(state: RootState, tab: Tab): TabRingStatus {
  const busy = getBusyPaneIdsForTab({
    tab,
    paneLayouts: state.panes.layouts as Record<string, PaneNode | undefined>,
    ...activityInputs(state),
  }).length > 0
  return {
    busy,
    green: !!state.turnCompletion.attentionByTab[tab.id],
    amber: tabHasPendingApproval(state, tab.id),
  }
}

/**
 * Pane entries for a tab, tolerant of layout-less tabs. This transient is REAL:
 * addTab (tabsSlice.ts:296) never seeds a layout — PaneLayout.tsx:30-35 initializes
 * it in a post-paint useEffect, and persisted-state restore can omit layout entries —
 * while the deck repaints synchronously per dispatch, so it WILL paint such tabs.
 * Mirrors the tab bar's live synthesis fallback (TabBar.tsx:203-221): synthesize a
 * single terminal pane from the tab's own fields. Do NOT touch TabBar; this is the
 * deck-local twin of that fallback.
 */
export function panesForTab(state: RootState, tab: Tab): Array<{ paneId: string; content: PaneContent }> {
  const layout = state.panes.layouts[tab.id]
  if (layout) return collectPaneEntries(layout)
  if (!tab.mode) return []
  return [{
    paneId: tab.id,
    content: {
      kind: 'terminal' as const,
      mode: tab.mode,
      shell: tab.shell,
      createRequestId: tab.createRequestId,
      status: tab.status,
      sessionRef: tab.sessionRef,
      initialCwd: tab.initialCwd,
    },
  }]
}

/**
 * Per-tab status flags, derived from the SAME conditions the tab bar uses:
 * - busy: any pane busy (getBusyPaneIdsForTab, TabBar.tsx:329-338)
 * - attention: turnCompletion.attentionByTab gated on tabAttentionStyle !== 'none'
 *   (TabItem.tsx:158-184 renders no bar/fill when the style is 'none')
 * - greenIcon: any non-busy pane whose effective status is 'running'
 *   (TabItem.tsx:135-147; non-terminal pane kinds count as 'running')
 */
export function getTabStatusFlags(state: RootState, tab: Tab): TabStatusFlags {
  const busyIds = getBusyPaneIdsForTab({
    tab,
    paneLayouts: state.panes.layouts as Record<string, PaneNode | undefined>,
    ...activityInputs(state),
  })
  const entries = panesForTab(state, tab) // layout entries, or the synthesized single pane
  const greenIcon = entries.some(({ paneId, content }) => {
    if (busyIds.includes(paneId)) return false
    const status = content.kind === 'terminal' ? content.status : 'running'
    return status === 'running'
  })
  const attentionStyle = state.settings.settings.panes.tabAttentionStyle
  return {
    busy: busyIds.length > 0,
    attention: !!state.turnCompletion.attentionByTab[tab.id] && attentionStyle !== 'none',
    greenIcon,
  }
}

export function selectDeckModel(state: RootState): DeckModel {
  const activeTabId = state.tabs.activeTabId
  return {
    activeTabId,
    tabs: state.tabs.tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      active: tab.id === activeTabId,
      status: getTabRingStatus(state, tab),
    })),
  }
}

export type ApproveTarget = {
  sessionId: string
  sessionType: FreshAgentPaneContent['sessionType']
  provider: FreshAgentPaneContent['provider']
  requestId: string | number
  cwd?: string
}

// freshopencode auth keys embed cwd server-side; claude/codex/kilroy are cwd-less.
// getFreshOpenCodeRouteCwd returns undefined for any non-freshopencode pane.
function freshOpenCodeCwdFor(state: RootState, content: FreshAgentPaneContent): string | undefined {
  return getFreshOpenCodeRouteCwd(content, { freshAgentSessions: state.freshAgent.sessions })
}

export function findApproveTarget(state: RootState, tabId: string): ApproveTarget | null {
  const layout = state.panes.layouts[tabId]
  if (!layout) return null
  for (const entry of collectPaneEntries(layout)) {
    if (entry.content.kind !== 'fresh-agent' || !entry.content.sessionId) continue
    const session = freshAgentSessionFor(state, entry.content)
    const pending = session ? Object.values(session.pendingPermissions) : []
    if (pending.length > 0) {
      const cwd = freshOpenCodeCwdFor(state, entry.content)
      return {
        sessionId: entry.content.sessionId,
        sessionType: entry.content.sessionType,
        provider: entry.content.provider,
        requestId: pending[0].requestId,
        ...(cwd ? { cwd } : {}),
      }
    }
  }
  return null
}

export type StopTarget =
  | { kind: 'fresh-agent'; sessionId: string; sessionType: FreshAgentPaneContent['sessionType']; provider: FreshAgentPaneContent['provider']; cwd?: string }
  | { kind: 'terminal'; paneId: string; terminalId: string; content: TerminalPaneContent }

export function findStopTarget(state: RootState, tabId: string): StopTarget | null {
  const layout = state.panes.layouts[tabId]
  const tab = state.tabs.tabs.find((t) => t.id === tabId)
  if (!layout || !tab) return null
  const entries = collectPaneEntries(layout)
  const isOnlyPane = layout.type === 'leaf'
  let terminalHit: StopTarget | null = null
  for (const entry of entries) {
    const { isBusy } = resolvePaneActivity({
      paneId: entry.paneId, content: entry.content, tabMode: tab.mode, isOnlyPane,
      ...activityInputs(state),
    })
    if (!isBusy) continue
    if (entry.content.kind === 'fresh-agent' && entry.content.sessionId) {
      const cwd = freshOpenCodeCwdFor(state, entry.content)
      return {
        kind: 'fresh-agent',
        sessionId: entry.content.sessionId,
        sessionType: entry.content.sessionType,
        provider: entry.content.provider,
        ...(cwd ? { cwd } : {}),
      }
    }
    if (!terminalHit && entry.content.kind === 'terminal' && entry.content.terminalId) {
      terminalHit = { kind: 'terminal', paneId: entry.paneId, terminalId: entry.content.terminalId, content: entry.content }
    }
  }
  return terminalHit
}
