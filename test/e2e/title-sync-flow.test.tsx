import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import TabBar from '@/components/TabBar'
import PaneContainer from '@/components/panes/PaneContainer'
import tabsReducer, { addTab, openSessionTab } from '@/store/tabsSlice'
import panesReducer, { initLayout, updatePaneContent, updatePaneTitleByTerminalId } from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import extensionsReducer from '@/store/extensionsSlice'
import terminalMetaReducer from '@/store/terminalMetaSlice'
import sessionsReducer from '@/store/sessionsSlice'
import freshAgentReducer from '@/store/freshAgentSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import sessionNamesReducer, { receiveSessionNames } from '@/store/sessionNamesSlice'
import type { PaneNode } from '@/store/paneTypes'
import type { ClientExtensionEntry } from '@shared/extension-types'

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: vi.fn(),
    close: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    onReconnect: vi.fn(() => () => {}),
    state: 'ready',
  }),
}))

vi.mock('@/components/TerminalView', () => ({
  default: ({ paneId }: { paneId: string }) => <div data-testid={`terminal-${paneId}`}>Terminal</div>,
}))

const opencodeExtensions: ClientExtensionEntry[] = [{
  name: 'opencode',
  version: '1.0.0',
  label: 'OpenCode',
  description: '',
  category: 'cli',
  picker: { shortcut: 'O' },
  cli: {
    supportsModel: true,
    supportsPermissionMode: true,
    supportsResume: true,
    resumeCommandTemplate: ['opencode', '--session', '{{sessionId}}'],
  },
}]

const VALID_CLAUDE_SESSION_ID = '550e8400-e29b-41d4-a716-446655440000'

function createStore(
  layout: PaneNode,
  options: {
    paneTitle?: string
    extensions?: ClientExtensionEntry[]
  } = {},
) {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
      extensions: extensionsReducer,
      terminalMeta: terminalMetaReducer,
      sessions: sessionsReducer,
      freshAgent: freshAgentReducer,
      turnCompletion: turnCompletionReducer,
      sessionNames: sessionNamesReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [{
          id: 'tab-1',
          title: 'Tab 1',
          createRequestId: 'tab-1',
          mode: 'shell' as const,
          status: 'running' as const,
          shell: 'system' as const,
          createdAt: Date.now(),
        }],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
      },
      panes: {
        layouts: { 'tab-1': layout },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: { 'tab-1': { 'pane-1': options.paneTitle ?? 'Shell' } },
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
      settings: {
        settings: defaultSettings,
        loaded: true,
      },
      connection: {
        status: 'ready' as const,
        platform: 'linux' as const,
        availableClis: {},
      },
      extensions: {
        entries: options.extensions ?? [],
      },
      terminalMeta: {
        byTerminalId: {},
      },
      sessions: {
        projects: [],
        expandedProjects: {},
        loading: false,
        error: null,
      },
      freshAgent: {
        pendingCreates: {},
        sessions: {},
        pendingCreateFailures: {},
        availableModels: [],
      },
      turnCompletion: {
        seq: 0,
        pendingEvents: [],
        attentionByTab: {},
        attentionByPane: {},
      },
    },
  })
}

describe('title sync flow', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    cleanup()
  })

  it('shows runtime pane title updates in both the pane header and single-pane tab label', async () => {
    const layout: PaneNode = {
      type: 'leaf',
      id: 'pane-1',
      content: {
        kind: 'terminal',
        terminalId: 'term-1',
        createRequestId: 'req-1',
        status: 'running',
        mode: 'shell',
        shell: 'system',
      },
    }
    const store = createStore(layout)

    render(
      <Provider store={store}>
        <>
          <TabBar />
          <PaneContainer tabId="tab-1" node={layout} />
        </>
      </Provider>,
    )

    expect(screen.getAllByText('Shell').length).toBeGreaterThanOrEqual(1)

    await act(async () => {
      store.dispatch(updatePaneTitleByTerminalId({ terminalId: 'term-1', title: 'Release prep', setByUser: false }))
    })

    expect(screen.getAllByText('Release prep').length).toBeGreaterThanOrEqual(2)
    expect(store.getState().tabs.tabs[0].title).toBe('Tab 1')
  })

  it('keeps a scoped opencode pane on its canonical session name against local title writes and pane updates (Task 5)', async () => {
    const layout: PaneNode = {
      type: 'leaf',
      id: 'pane-1',
      content: {
        kind: 'terminal',
        terminalId: 'term-1',
        createRequestId: 'req-1',
        status: 'running',
        mode: 'opencode',
        sessionRef: { provider: 'opencode', sessionId: 'sess-oc-flow-1' },
      },
    }
    const store = createStore(layout, {
      paneTitle: 'OpenCode',
      extensions: opencodeExtensions,
    })

    render(
      <Provider store={store}>
        <>
          <TabBar />
          <PaneContainer tabId="tab-1" node={layout} />
        </>
      </Provider>,
    )

    // Pre-canonical: the derived provider label shows on the pane header and
    // the tab (a lowercase "Opencode" default never leaks).
    expect(screen.getAllByText('OpenCode').length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByText('Opencode')).not.toBeInTheDocument()

    // The server names the session -> the canonical name owns every surface.
    await act(async () => {
      store.dispatch(receiveSessionNames([{
        record: {
          ref: { kind: 'session', provider: 'opencode', sessionId: 'sess-oc-flow-1' },
          name: 'Canonical opencode name',
          source: 'first_message',
          revision: 2,
        },
        documentGeneration: 3,
        redirects: [],
        changed: true,
      }]))
    })

    expect(screen.getAllByText('Canonical opencode name').length).toBeGreaterThanOrEqual(2)

    // A legacy local title write (registry-shaped noise) never retitles it.
    await act(async () => {
      store.dispatch(updatePaneTitleByTerminalId({ terminalId: 'term-1', title: 'Release prep', setByUser: false }))
    })

    expect(screen.queryByText('Release prep')).not.toBeInTheDocument()
    expect(screen.getAllByText('Canonical opencode name').length).toBeGreaterThanOrEqual(2)

    // ...and a pane content update keeps the canonical name on every surface.
    await act(async () => {
      store.dispatch(updatePaneContent({
        tabId: 'tab-1',
        paneId: 'pane-1',
        content: {
          kind: 'terminal',
          terminalId: 'term-1',
          createRequestId: 'req-1',
          status: 'running',
          mode: 'opencode',
          sessionRef: { provider: 'opencode', sessionId: 'sess-oc-flow-1' },
        },
      }))
    })

    expect(screen.getAllByText('Canonical opencode name').length).toBeGreaterThanOrEqual(2)
  })

  it('shows the session title in the tab bar after reopening a session with a new title', async () => {
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
        extensions: extensionsReducer,
        terminalMeta: terminalMetaReducer,
        sessions: sessionsReducer,
        freshAgent: freshAgentReducer,
        turnCompletion: turnCompletionReducer,
      },
      middleware: (getDefault) =>
        getDefault({
          serializableCheck: {
            ignoredPaths: ['sessions.expandedProjects'],
          },
        }),
      preloadedState: {
        tabs: {
          tabs: [{
            id: 'existing-tab',
            title: 'Claude',
            createRequestId: 'existing-tab',
            mode: 'claude',
            status: 'running',
            shell: 'system',
            createdAt: Date.now(),
            sessionRef: { provider: 'claude', sessionId: VALID_CLAUDE_SESSION_ID },
          }],
          activeTabId: 'existing-tab',
          renameRequestTabId: null,
        },
        panes: {
          layouts: {
            'existing-tab': {
              type: 'leaf',
              id: 'pane-1',
              content: {
                kind: 'terminal',
                mode: 'claude',
                terminalId: 'term-xyz',
                sessionRef: { provider: 'claude', sessionId: VALID_CLAUDE_SESSION_ID },
                status: 'running',
              },
            },
          },
          activePane: { 'existing-tab': 'pane-1' },
          paneTitles: { 'existing-tab': { 'pane-1': 'Claude' } },
          paneTitleSetByUser: {},
          renameRequestTabId: null,
          renameRequestPaneId: null,
          zoomedPane: {},
          refreshRequestsByPane: {},
        },
        settings: { settings: defaultSettings, loaded: true },
        connection: { status: 'ready', platform: 'linux', serverInstanceId: 'srv-local' },
        extensions: { entries: [] },
        terminalMeta: { byTerminalId: {}, byTabId: {} },
        sessions: { projectGroups: [], expandedProjects: new Set(), activeTabProjectPath: null },
        freshAgent: { sessions: {}, pendingCreates: {}, pendingCreateFailures: {}, availableModels: [] },
        turnCompletion: { seq: 0, pendingEvents: [], attentionByTab: {}, attentionByPane: {} },
      },
    })

    // Add a second tab so first isn't auto-focused
    store.dispatch(addTab({ id: 'tab-2', title: 'Shell', mode: 'shell' }))
    store.dispatch(initLayout({ tabId: 'tab-2', content: { kind: 'terminal', mode: 'shell' } }))

    // Simulate reopening with a custom session title (as if renamed in sidebar)
    await store.dispatch(openSessionTab({
      sessionId: VALID_CLAUDE_SESSION_ID,
      provider: 'claude',
      title: 'Renamed from sidebar',
      hasTitle: true,
    }))

    render(
      <Provider store={store}>
        <TabBar />
      </Provider>,
    )

    expect(screen.getAllByText('Renamed from sidebar').length).toBeGreaterThanOrEqual(1)
  })
})
