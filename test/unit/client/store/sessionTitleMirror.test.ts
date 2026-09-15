import { configureStore } from '@reduxjs/toolkit'
import { describe, expect, it } from 'vitest'
import tabsReducer, { addTab } from '@/store/tabsSlice'
import { panesSlice, initLayout, updatePaneTitle } from '@/store/panesSlice'
import sessionsReducer, { commitSessionWindowVisibleRefresh } from '@/store/sessionsSlice'
import { sessionTitleMirrorMiddleware } from '@/store/sessionTitleMirror'

function buildStore() {
  return configureStore({
    reducer: { tabs: tabsReducer, panes: panesSlice.reducer, sessions: sessionsReducer },
    // The sessions slice keeps a Set in state (expandedProjects); test
    // stores including it disable the serializable check, matching the
    // production store's ignoredPaths carve-out (sessionsThunks.test.ts
    // pattern).
    middleware: (gDM) => gDM({ serializableCheck: false }).concat(sessionTitleMirrorMiddleware),
  })
}

function seedFreshAgentPane(store: ReturnType<typeof buildStore>, sessionId: string, provider = 'opencode') {
  store.dispatch(addTab({ id: 'tab-z', title: 'ZZ probe' }))
  store.dispatch(initLayout({
    tabId: 'tab-z',
    paneId: 'pane-z',
    content: {
      kind: 'fresh-agent',
      provider,
      sessionId,
      sessionType: 'freshopencode',
      sessionRef: { provider, sessionId },
    },
  }))
}

function landSessionRow(store: ReturnType<typeof buildStore>, row: {
  surface: string
  sessionId: string
  provider: string
  title?: string
  lastActivityAt?: number
}) {
  // There is no 'sessions/fetchSessionWindow/fulfilled' action — the fetch
  // thunk is hand-rolled and lands rows through the real commit action.
  store.dispatch(commitSessionWindowVisibleRefresh({
    surface: row.surface,
    projects: [{
      projectPath: '/freshell',
      sessions: [{
        provider: row.provider,
        sessionId: row.sessionId,
        projectPath: '/freshell',
        lastActivityAt: row.lastActivityAt ?? 1_000,
        ...(row.title !== undefined ? { title: row.title } : {}),
      }],
    }],
  }))
}

describe('sessionTitleMirrorMiddleware', () => {
  it('mirrors a session-directory title into a matching fresh-agent pane (the MCP-created-pane symptom)', () => {
    const store = buildStore()
    seedFreshAgentPane(store, 'sess-1')
    landSessionRow(store, { surface: 'sidebar', sessionId: 'sess-1', provider: 'opencode', title: 'ZZ probe summarize' })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('ZZ probe summarize')
    expect(store.getState().panes.paneTitleSetByUser['tab-z']?.['pane-z']).toBeFalsy()
  })

  it('never overwrites a user-set pane title', () => {
    const store = buildStore()
    seedFreshAgentPane(store, 'sess-1')
    store.dispatch(updatePaneTitle({ tabId: 'tab-z', paneId: 'pane-z', title: 'My name', setByUser: true }))
    landSessionRow(store, { surface: 'sidebar', sessionId: 'sess-1', provider: 'opencode', title: 'Directory title' })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('My name')
  })

  it('skips rows without a title and ignores non-sessions actions', () => {
    const store = buildStore()
    seedFreshAgentPane(store, 'sess-1')
    const seeded = store.getState().panes.paneTitles['tab-z']['pane-z']
    landSessionRow(store, { surface: 'sidebar', sessionId: 'sess-1', provider: 'opencode' })
    store.dispatch({ type: 'settings/updated', payload: {} })
    expect(store.getState().panes.paneTitles['tab-z']?.['pane-z']).toBe(seeded)
  })

  it('does not re-dispatch when the mirrored title already equals the pane title', () => {
    const store = buildStore()
    seedFreshAgentPane(store, 'sess-1')
    landSessionRow(store, { surface: 'sidebar', sessionId: 'sess-1', provider: 'opencode', title: 'Same title' })
    const before = store.getState()
    landSessionRow(store, { surface: 'sidebar', sessionId: 'sess-1', provider: 'opencode', title: 'Same title' })
    expect(store.getState().panes).toBe(before.panes)
  })

  it('a row RETAINED from an older fetch does not beat a fresher row another window fetched later (the deep-page retention case)', () => {
    const store = buildStore()
    seedFreshAgentPane(store, 'sess-1')
    landSessionRow(store, { surface: 'sidebar', sessionId: 'sess-1', provider: 'opencode', title: 'Retained sidebar title', lastActivityAt: 2_000 })
    landSessionRow(store, { surface: 'history', sessionId: 'sess-1', provider: 'opencode', title: 'Fresh history title', lastActivityAt: 2_000 })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('Fresh history title')
    // The later sidebar refresh commits the merged window the real thunk
    // builds — the retained row carries its existing fetchSeq because
    // mergeProjects passes the previous window's row OBJECTS through.
    const retainedProjects = store.getState().sessions.windows['sidebar'].projects
    store.dispatch(commitSessionWindowVisibleRefresh({
      surface: 'sidebar',
      projects: retainedProjects,
    }))
    // The window-level stamps are now the freshest of all three commits;
    // the retained row must STILL lose to History's row.
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('Fresh history title')
  })

  it('equal-activity rows fetched fresh by both windows: the later-fetched row wins (History holds the newer title)', () => {
    const store = buildStore()
    seedFreshAgentPane(store, 'sess-1')
    landSessionRow(store, { surface: 'sidebar', sessionId: 'sess-1', provider: 'opencode', title: 'Older sidebar title', lastActivityAt: 2_000 })
    landSessionRow(store, { surface: 'history', sessionId: 'sess-1', provider: 'opencode', title: 'Newer history title', lastActivityAt: 2_000 })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('Newer history title')
  })

  it('titles a pane created AFTER its directory row is already loaded (the missed-ordering symptom)', () => {
    const store = buildStore()
    landSessionRow(store, { surface: 'sidebar', sessionId: 'sess-1', provider: 'opencode', title: 'ZZ probe summarize' })
    seedFreshAgentPane(store, 'sess-1')
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('ZZ probe summarize')
    expect(store.getState().panes.paneTitleSetByUser['tab-z']?.['pane-z']).toBeFalsy()
  })

  it('a splitPane that binds a new pane to an already-landed session row mirrors the split pane (REST/MCP split binding path)', () => {
    const store = buildStore()
    seedFreshAgentPane(store, 'sess-1')
    landSessionRow(store, { surface: 'sidebar', sessionId: 'sess-1', provider: 'opencode', title: 'ZZ probe summarize' })
    store.dispatch({
      type: 'panes/splitPane',
      payload: {
        tabId: 'tab-z',
        paneId: 'pane-z',
        direction: 'horizontal',
        newPaneId: 'pane-z-split',
        newContent: {
          kind: 'fresh-agent',
          provider: 'opencode',
          sessionId: 'sess-1',
          sessionType: 'freshopencode',
          sessionRef: { provider: 'opencode', sessionId: 'sess-1' },
        },
      },
    })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z-split']).toBe('ZZ probe summarize')
    expect(store.getState().panes.paneTitleSetByUser['tab-z']?.['pane-z-split']).toBeFalsy()
  })

  it('mirrors into EVERY pane bound to the same session (two panes in one tab; the churn guard then rests)', () => {
    const store = buildStore()
    seedFreshAgentPane(store, 'sess-1')
    store.dispatch({
      type: 'panes/splitPane',
      payload: {
        tabId: 'tab-z',
        paneId: 'pane-z',
        direction: 'horizontal',
        newPaneId: 'pane-z-2',
        newContent: {
          kind: 'fresh-agent',
          provider: 'opencode',
          sessionId: 'sess-1',
          sessionType: 'freshopencode',
          sessionRef: { provider: 'opencode', sessionId: 'sess-1' },
        },
      },
    })
    landSessionRow(store, { surface: 'sidebar', sessionId: 'sess-1', provider: 'opencode', title: 'Both mirror' })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('Both mirror')
    expect(store.getState().panes.paneTitles['tab-z']['pane-z-2']).toBe('Both mirror')
    const before = store.getState()
    landSessionRow(store, { surface: 'sidebar', sessionId: 'sess-1', provider: 'opencode', title: 'Both mirror' })
    expect(store.getState().panes).toBe(before.panes)
  })

  // Reconcile-attach lifecycle (delta review round 1, finding 2): a
  // persisted fresh-agent pane rehydrates with sessionRef only (persistence
  // strips the top-level sessionId when a canonical sessionRef exists —
  // persistMiddleware stripTransientSessionFields), and the reconcile
  // verdicts that (re)bind sessions are generated panes actions the mirror
  // must trigger on.
  // e1r1 review finding 1 (the reviewer's exact failure case): a LIVE
  // FreshClaude pane keeps an EPHEMERAL nanoid runtime handle in the
  // top-level content.sessionId (minted by the SDK bridge with no
  // placeholder→durable materialization; FreshAgentView.tsx:1804-1828
  // retains it) while the DURABLE Claude UUID lives in content.sessionRef
  // — real shape verified in panesPersistence.test.ts:384-447 and
  // fresh-agent-turn-complete.test.ts:143-184. Directory rows key by the
  // durable UUID, so the mirror must title the pane through sessionRef.
  const DURABLE_CLAUDE = '11111111-2222-4333-8444-555555555555'

  function seedLiveDualIdClaudePane(store: ReturnType<typeof buildStore>) {
    store.dispatch(addTab({ id: 'tab-z', title: 'Claude probe' }))
    store.dispatch(initLayout({
      tabId: 'tab-z',
      paneId: 'pane-z',
      content: {
        kind: 'fresh-agent',
        provider: 'claude',
        sessionType: 'freshclaude',
        sessionId: 'claude-runtime-nanoid',
        createRequestId: 'req-claude',
        status: 'connected',
        sessionRef: { provider: 'claude', sessionId: DURABLE_CLAUDE },
      },
    }))
  }

  it('titles a live FreshClaude pane (ephemeral top-level sessionId, durable sessionRef) when its directory row lands', () => {
    const store = buildStore()
    seedLiveDualIdClaudePane(store)
    landSessionRow(store, { surface: 'sidebar', sessionId: DURABLE_CLAUDE, provider: 'claude', title: 'Durable row title' })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('Durable row title')
    expect(store.getState().panes.paneTitleSetByUser['tab-z']?.['pane-z']).toBeFalsy()
  })

  it('never overwrites a user-set pane title on a live dual-id FreshClaude pane', () => {
    const store = buildStore()
    seedLiveDualIdClaudePane(store)
    store.dispatch(updatePaneTitle({ tabId: 'tab-z', paneId: 'pane-z', title: 'My name', setByUser: true }))
    landSessionRow(store, { surface: 'sidebar', sessionId: DURABLE_CLAUDE, provider: 'claude', title: 'Directory title' })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('My name')
  })

  it('titles a persisted-shape fresh-agent pane (sessionRef only, no top-level sessionId) when its directory row lands — the healthy-reload pre-attach window', () => {
    const store = buildStore()
    store.dispatch(addTab({ id: 'tab-z', title: 'ZZ probe' }))
    store.dispatch(initLayout({
      tabId: 'tab-z',
      paneId: 'pane-z',
      content: {
        kind: 'fresh-agent',
        provider: 'opencode',
        sessionType: 'freshopencode',
        createRequestId: 'req-z',
        status: 'idle',
        sessionRef: { provider: 'opencode', sessionId: 'sess-1' },
      },
    }))
    landSessionRow(store, { surface: 'sidebar', sessionId: 'sess-1', provider: 'opencode', title: 'ZZ probe summarize' })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('ZZ probe summarize')
    expect(store.getState().panes.paneTitleSetByUser['tab-z']?.['pane-z']).toBeFalsy()
  })

  it('updates the pane title when applyFreshAgentReconcileAttach rebinds the pane to a different titled session', () => {
    const store = buildStore()
    seedFreshAgentPane(store, 'sess-1')
    landSessionRow(store, { surface: 'sidebar', sessionId: 'sess-1', provider: 'opencode', title: 'Old session title' })
    landSessionRow(store, { surface: 'sidebar', sessionId: 'sess-2', provider: 'opencode', title: 'New session title' })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('Old session title')
    store.dispatch({
      type: 'panes/applyFreshAgentReconcileAttach',
      payload: { tabId: 'tab-z', paneId: 'pane-z', sessionRef: { provider: 'opencode', sessionId: 'sess-2' } },
    })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('New session title')
  })

  it('updates a terminal pane title when applyReconcileAttach rebinds it to a different titled session', () => {
    const store = buildStore()
    store.dispatch(addTab({ id: 'tab-z', title: 'ZZ probe' }))
    store.dispatch(initLayout({
      tabId: 'tab-z',
      paneId: 'pane-z',
      content: {
        kind: 'terminal',
        mode: 'claude',
        createRequestId: 'req-t',
        status: 'running',
        terminalId: 'term-1',
        sessionRef: { provider: 'claude', sessionId: 's1' },
      },
    }))
    landSessionRow(store, { surface: 'sidebar', sessionId: 's1', provider: 'claude', title: 'First claude title' })
    landSessionRow(store, { surface: 'sidebar', sessionId: 's2', provider: 'claude', title: 'Second claude title' })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('First claude title')
    store.dispatch({
      type: 'panes/applyReconcileAttach',
      payload: { tabId: 'tab-z', paneId: 'pane-z', terminalId: 'term-1', sessionRef: { provider: 'claude', sessionId: 's2' } },
    })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('Second claude title')
  })

  it('never overwrites a user-set pane title when reconcile-attach rebinds the pane (rename-scope contract)', () => {
    const store = buildStore()
    seedFreshAgentPane(store, 'sess-1')
    store.dispatch(updatePaneTitle({ tabId: 'tab-z', paneId: 'pane-z', title: 'My name', setByUser: true }))
    landSessionRow(store, { surface: 'sidebar', sessionId: 'sess-2', provider: 'opencode', title: 'New session title' })
    store.dispatch({
      type: 'panes/applyFreshAgentReconcileAttach',
      payload: { tabId: 'tab-z', paneId: 'pane-z', sessionRef: { provider: 'opencode', sessionId: 'sess-2' } },
    })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('My name')
  })
})
