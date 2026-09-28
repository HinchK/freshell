import { describe, it, expect, vi, beforeEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { addTab } from '@/store/tabsSlice'
import panesReducer, { initLayout, updatePaneTitle } from '@/store/panesSlice'
import { applySessionRenameCascade, clearSessionTitleOverride } from '@/store/titleSync'
import { renameOverviewTerminal } from '@/components/OverviewView'

vi.mock('nanoid', () => { let n = 0; return { nanoid: vi.fn(() => `pane-${++n}`) } })

const apiMocks = vi.hoisted(() => ({ patch: vi.fn().mockResolvedValue({}) }))
vi.mock('@/lib/api', () => ({ api: { patch: apiMocks.patch } }))

function freshAgentStore(sessionType: 'freshclaude' | 'kilroy' = 'freshclaude') {
  const store = configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } })
  store.dispatch(addTab({ title: 'freshell', mode: 'claude' }))
  const tabId = store.getState().tabs.tabs[0].id
  store.dispatch(initLayout({
    tabId,
    content: { kind: 'fresh-agent', sessionType, provider: 'claude',
               sessionId: 's1', createRequestId: 'r1', status: 'running' },
  }))
  const paneId = (store.getState().panes.layouts[tabId] as { id: string }).id
  return { store, tabId, paneId }
}

describe('applySessionRenameCascade', () => {
  /**
   * Unified agent names (Task 5): the session→pane user-flag cascade is the
   * retained LEGACY mirror for out-of-scope panes (kilroy and others) only.
   * A scoped agent pane never takes the cascade — its display comes from the
   * canonical sessionNames cache, and no local sticky flag is armed.
   */
  it('mirrors a sidebar session rename into an out-of-scope (kilroy) pane by sessionRef (D3/D4)', () => {
    const { store, tabId, paneId } = freshAgentStore('kilroy')
    applySessionRenameCascade({ dispatch: store.dispatch, getState: store.getState, provider: 'claude',
      sessionId: 's1', title: 'Renamed', cascadedTerminalId: null })
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('Renamed')
    expect(store.getState().panes.paneTitleSetByUser?.[tabId]?.[paneId]).toBe(true)
  })

  it('never cascades into a scoped fresh pane: no pane title, no user flag', () => {
    const { store, tabId, paneId } = freshAgentStore('freshclaude')
    applySessionRenameCascade({ dispatch: store.dispatch, getState: store.getState, provider: 'claude',
      sessionId: 's1', title: 'Renamed', cascadedTerminalId: null })
    // The pane keeps its derived default — the cascade never wrote it.
    expect(store.getState().panes.paneTitles[tabId]?.[paneId]).toBe('Freshclaude')
    expect(store.getState().panes.paneTitleSetByUser?.[tabId]?.[paneId]).toBeFalsy()
  })

  it('leaves panes of OTHER sessions alone (targets match provider:sessionId only)', () => {
    const { store, tabId, paneId } = freshAgentStore('kilroy')
    // initLayout seeds the pane's derived default title ('Kilroy'); a
    // cascade for a different session must leave it exactly as it was.
    const before = store.getState().panes.paneTitles[tabId][paneId]
    expect(before).toBe('Kilroy')
    applySessionRenameCascade({ dispatch: store.dispatch, getState: store.getState, provider: 'codex',
      sessionId: 's1', title: 'Renamed', cascadedTerminalId: null })
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe(before)
    applySessionRenameCascade({ dispatch: store.dispatch, getState: store.getState, provider: 'claude',
      sessionId: 'other-session', title: 'Renamed', cascadedTerminalId: null })
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe(before)
    expect(store.getState().panes.paneTitleSetByUser?.[tabId]?.[paneId]).toBeFalsy()
  })

  it('a user session rename overrides a previously sticky pane title (Scope Decision 3)', () => {
    const { store, tabId, paneId } = freshAgentStore('kilroy')
    store.dispatch(updatePaneTitle({ tabId, paneId, title: 'Mine' })) // sticky
    applySessionRenameCascade({ dispatch: store.dispatch, getState: store.getState, provider: 'claude',
      sessionId: 's1', title: 'UserWins', cascadedTerminalId: null })
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('UserWins')
    expect(store.getState().panes.paneTitleSetByUser?.[tabId]?.[paneId]).toBe(true)
  })
})

describe('clearSessionTitleOverride (reset to provider title)', () => {
  beforeEach(() => apiMocks.patch.mockClear())

  it('PATCHes the session with titleOverride:null by composite key', async () => {
    await clearSessionTitleOverride('claude', 's1')
    expect(apiMocks.patch).toHaveBeenCalledWith('/api/sessions/claude%3As1', { titleOverride: null })
  })

  it('URI-encodes the composite key as a single route segment', async () => {
    await clearSessionTitleOverride('opencode', 'a/b c')
    expect(apiMocks.patch).toHaveBeenCalledWith('/api/sessions/opencode%3Aa%2Fb%20c', { titleOverride: null })
  })

  it('propagates server errors (caller surfaces them in the dialog)', async () => {
    apiMocks.patch.mockRejectedValueOnce(new Error('500 boom'))
    await expect(clearSessionTitleOverride('opencode', 'z9')).rejects.toThrow('500 boom')
  })
})

function terminalStore(content: Record<string, unknown>) {
  const store = configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } })
  store.dispatch(addTab({ title: 'freshell', mode: 'claude' }))
  const tabId = store.getState().tabs.tabs[0].id
  store.dispatch(initLayout({ tabId, content: content as never }))
  const paneId = (store.getState().panes.layouts[tabId] as { id: string }).id
  return { store, tabId, paneId }
}

describe('OverviewView TerminalCard rename', () => {
  beforeEach(() => apiMocks.patch.mockClear())

  it('PATCHes the terminal AND mirrors the title into paneTitles with setByUser: true', async () => {
    const { store, tabId, paneId } = terminalStore({
      kind: 'terminal', mode: 'shell', terminalId: 'term-1', createRequestId: 'r-term', status: 'running',
    })
    await renameOverviewTerminal({
      dispatch: store.dispatch as never, terminalId: 'term-1', title: 'Overview name', description: 'a desc',
    })
    expect(apiMocks.patch).toHaveBeenCalledWith('/api/terminals/term-1', {
      titleOverride: 'Overview name',
      descriptionOverride: 'a desc',
    })
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('Overview name')
    expect(store.getState().panes.paneTitleSetByUser?.[tabId]?.[paneId]).toBe(true)
  })

  it('lands even on a previously user-renamed pane (user rename policy, Scope Decision 3)', async () => {
    const { store, tabId, paneId } = terminalStore({
      kind: 'terminal', mode: 'shell', terminalId: 'term-1', createRequestId: 'r-term', status: 'running',
    })
    store.dispatch(updatePaneTitle({ tabId, paneId, title: 'Mine' })) // sticky user title
    await renameOverviewTerminal({
      dispatch: store.dispatch as never, terminalId: 'term-1', title: 'Overview wins', description: '',
    })
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('Overview wins')
  })

  it('does not dispatch a pane mirror for a blank title (description-only edit)', async () => {
    const { store, tabId, paneId } = terminalStore({
      kind: 'terminal', mode: 'shell', terminalId: 'term-1', createRequestId: 'r-term', status: 'running',
    })
    const before = store.getState().panes.paneTitles[tabId][paneId]
    await renameOverviewTerminal({
      dispatch: store.dispatch as never, terminalId: 'term-1', title: '', description: 'only desc',
    })
    expect(apiMocks.patch).toHaveBeenCalledWith('/api/terminals/term-1', {
      titleOverride: undefined,
      descriptionOverride: 'only desc',
    })
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe(before)
  })
})
