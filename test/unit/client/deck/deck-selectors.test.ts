import { describe, expect, it } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import freshAgentReducer from '@/store/freshAgentSlice'
import codexActivityReducer from '@/store/codexActivitySlice'
import claudeActivityReducer from '@/store/claudeActivitySlice'
import amplifierActivityReducer from '@/store/amplifierActivitySlice'
import opencodeActivityReducer from '@/store/opencodeActivitySlice'
import paneRuntimeActivityReducer from '@/store/paneRuntimeActivitySlice'
import settingsReducer from '@/store/settingsSlice'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import {
  findApproveTarget, findStopTarget, getTabRingStatus, selectDeckModel,
} from '@/deck/deck-selectors'

const reducer = {
  tabs: tabsReducer, panes: panesReducer, turnCompletion: turnCompletionReducer,
  freshAgent: freshAgentReducer, codexActivity: codexActivityReducer,
  claudeActivity: claudeActivityReducer, amplifierActivity: amplifierActivityReducer,
  opencodeActivity: opencodeActivityReducer, paneRuntimeActivity: paneRuntimeActivityReducer,
  settings: settingsReducer,
}

const s1Key = makeFreshAgentSessionKey({ sessionType: 'freshclaude', provider: 'claude', sessionId: 's1' })

function makeState(overrides: {
  claudeBusy?: boolean
  attention?: Record<string, boolean>
  pendingPermissions?: Record<string, { requestId: string }>
  freshAgentRunning?: boolean
} = {}) {
  const store = configureStore({
    reducer,
    preloadedState: {
      tabs: {
        tabs: [
          { id: 't1', createRequestId: 'c1', title: 'build', status: 'running', mode: 'shell', createdAt: 1 },
          { id: 't2', createRequestId: 'c2', title: 'claude', status: 'running', mode: 'shell', createdAt: 2 },
        ],
        activeTabId: 't1', renameRequestTabId: null, tombstones: [],
      },
      panes: {
        layouts: {
          t1: { type: 'leaf', id: 'p1', content: { kind: 'terminal', terminalId: 'term-1', createRequestId: 'c1', status: 'running', mode: 'claude' } },
          t2: { type: 'leaf', id: 'p2', content: { kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude', sessionId: 's1', createRequestId: 'c2', status: 'running' } },
        },
        activePane: { t1: 'p1', t2: 'p2' },
        paneTitles: {}, paneTitleSetByUser: {}, renameRequestTabId: null, renameRequestPaneId: null,
        zoomedPane: {}, refreshRequestsByPane: {}, restoreFallbackAttemptsByPane: {},
      },
      claudeActivity: { byTerminalId: overrides.claudeBusy ? { 'term-1': { phase: 'busy' } } : {} },
      turnCompletion: {
        seq: 0, lastAtByTerminalId: {}, lastIdleAtByTerminalId: {}, pendingEvents: [],
        attentionByTab: overrides.attention ?? {}, attentionByPane: {},
      },
      freshAgent: {
        sessions: {
          [s1Key]: {
            sessionKey: s1Key, threadId: 's1', sessionType: 'freshclaude', provider: 'claude', sessionId: 's1',
            status: overrides.freshAgentRunning ? 'running' : 'idle', streamingActive: false,
            pendingPermissions: overrides.pendingPermissions ?? {}, pendingQuestions: {},
          },
        },
        pendingCreates: {}, pendingCreateFailures: {}, availableModels: [],
      },
    } as never,
  })
  return store.getState() as never
}

describe('deck-selectors', () => {
  it('quiet tabs have no ring', () => {
    const state = makeState()
    const model = selectDeckModel(state)
    expect(model.tabs).toHaveLength(2)
    expect(model.tabs[0]).toMatchObject({ id: 't1', title: 'build', active: true, status: { busy: false, green: false, amber: false } })
  })

  it('busy terminal pane -> busy tab (blue)', () => {
    const state = makeState({ claudeBusy: true })
    const tab = (state as { tabs: { tabs: unknown[] } }).tabs.tabs[0]
    expect(getTabRingStatus(state, tab as never).busy).toBe(true)
    expect(selectDeckModel(state).tabs[0].status.busy).toBe(true)
  })

  it('attentionByTab -> green', () => {
    const state = makeState({ attention: { t1: true } })
    expect(selectDeckModel(state).tabs[0].status.green).toBe(true)
  })

  it('pending permission -> amber on the fresh-agent tab, and busy is suppressed', () => {
    const state = makeState({ pendingPermissions: { r1: { requestId: 'r1' } }, freshAgentRunning: true })
    const t2 = selectDeckModel(state).tabs[1]
    expect(t2.status.amber).toBe(true)
    expect(t2.status.busy).toBe(false) // isFreshAgentBusy yields false while waiting
  })

  it('findApproveTarget returns the pending permission for the tab', () => {
    const state = makeState({ pendingPermissions: { r1: { requestId: 'r1' } } })
    expect(findApproveTarget(state, 't2')).toEqual({
      sessionId: 's1', sessionType: 'freshclaude', provider: 'claude', requestId: 'r1',
    })
    expect(findApproveTarget(state, 't1')).toBeNull()
  })

  it('findStopTarget: busy fresh-agent wins; busy terminal otherwise; null when quiet', () => {
    const busyAgent = makeState({ freshAgentRunning: true })
    expect(findStopTarget(busyAgent, 't2')).toEqual({
      kind: 'fresh-agent', sessionId: 's1', sessionType: 'freshclaude', provider: 'claude',
    })
    expect(findStopTarget(busyAgent, 't2')).not.toHaveProperty('cwd') // claude stays cwd-less
    const busyTerm = makeState({ claudeBusy: true })
    expect(findStopTarget(busyTerm, 't1')).toMatchObject({ kind: 'terminal', paneId: 'p1', terminalId: 'term-1' })
    expect(findStopTarget(makeState(), 't1')).toBeNull()
  })
})

describe('freshopencode targets carry cwd (server auth keys embed it — A8)', () => {
  const oKey = makeFreshAgentSessionKey({ sessionType: 'freshopencode', provider: 'opencode', sessionId: 'ses_1' })
  function makeOpencodeState(overrides: { pendingPermissions?: Record<string, { requestId: string }>; running?: boolean } = {}) {
    const store = configureStore({
      reducer,
      preloadedState: {
        tabs: {
          tabs: [{ id: 't3', createRequestId: 'c3', title: 'oc', status: 'running', mode: 'shell', createdAt: 3 }],
          activeTabId: 't3', renameRequestTabId: null, tombstones: [],
        },
        panes: {
          layouts: {
            t3: { type: 'leaf', id: 'p3', content: { kind: 'fresh-agent', sessionType: 'freshopencode', provider: 'opencode', sessionId: 'ses_1', createRequestId: 'c3', status: 'running', initialCwd: '/repo/a' } },
          },
          activePane: { t3: 'p3' },
          paneTitles: {}, paneTitleSetByUser: {}, renameRequestTabId: null, renameRequestPaneId: null,
          zoomedPane: {}, refreshRequestsByPane: {}, restoreFallbackAttemptsByPane: {},
        },
        freshAgent: {
          sessions: {
            [oKey]: {
              sessionKey: oKey, threadId: 'ses_1', sessionType: 'freshopencode', provider: 'opencode', sessionId: 'ses_1',
              status: overrides.running ? 'running' : 'idle', streamingActive: false,
              pendingPermissions: overrides.pendingPermissions ?? {}, pendingQuestions: {},
            },
          },
          pendingCreates: {}, pendingCreateFailures: {}, availableModels: [],
        },
      } as never,
    })
    return store.getState() as never
  }

  it('findApproveTarget includes cwd for a freshopencode pane', () => {
    const state = makeOpencodeState({ pendingPermissions: { r9: { requestId: 'r9' } } })
    expect(findApproveTarget(state, 't3')).toEqual({
      sessionId: 'ses_1', sessionType: 'freshopencode', provider: 'opencode', requestId: 'r9', cwd: '/repo/a',
    })
  })

  it('findStopTarget includes cwd for a busy freshopencode pane', () => {
    const state = makeOpencodeState({ running: true })
    expect(findStopTarget(state, 't3')).toEqual({
      kind: 'fresh-agent', sessionId: 'ses_1', sessionType: 'freshopencode', provider: 'opencode', cwd: '/repo/a',
    })
  })
})
