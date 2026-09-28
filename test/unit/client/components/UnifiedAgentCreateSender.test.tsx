import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import extensionsReducer from '@/store/extensionsSlice'
import freshAgentReducer from '@/store/freshAgentSlice'
import sessionsReducer from '@/store/sessionsSlice'
import type { PaneNode, TerminalPaneContent, FreshAgentPaneContent } from '@/store/paneTypes'

/**
 * Unified agent names (T6-R3 sender repair): the view-layer create senders
 * mint and persist a pre-durable namingHandle for every NEW scoped logical
 * conversation and send it on the create frame — the pane's rename capture
 * resolves the PENDING record while no durable identity exists, and create
 * retries re-send the SAME handle. A shell pane, an out-of-scope runtime
 * (kilroy), and a resume create (a durable sessionRef) deliberately send no
 * handle. These tests drive the REAL senders through the REAL store.
 */

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn(() => () => {}),
  onReconnect: vi.fn(() => () => {}),
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsMocks.send,
    connect: wsMocks.connect,
    onMessage: wsMocks.onMessage,
    onReconnect: wsMocks.onReconnect,
  }),
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
    getFreshAgentThreadSnapshot: vi.fn().mockResolvedValue({
      status: 'idle', capabilities: { send: true, interrupt: true }, turns: [],
    }),
    getFreshAgentModelCapabilities: vi.fn().mockResolvedValue({ models: [] }),
  },
}))
vi.mock('@/lib/auth', () => ({
  getAuthToken: vi.fn(() => undefined),
  clearAuthCookie: vi.fn(),
  setAuthToken: vi.fn(),
  initializeAuthToken: vi.fn(),
}))
vi.mock('@/lib/terminal-themes', () => ({ getTerminalTheme: () => ({}) }))

vi.mock('@/components/terminal/terminal-runtime', () => ({
  createTerminalRuntime: () => ({
    attachAddons: () => {},
    fit: vi.fn(),
    findNext: vi.fn(() => true),
    findPrevious: vi.fn(() => true),
    clearDecorations: vi.fn(),
    onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
    webglActive: () => false,
    emitContextLoss: () => {},
  }),
}))

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    open = vi.fn()
    loadAddon = vi.fn()
    write = vi.fn()
    writeln = vi.fn()
    clear = vi.fn()
    dispose = vi.fn()
    onData = vi.fn()
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    attachCustomKeyEventHandler = vi.fn()
    attachCustomWheelEventHandler = vi.fn()
    getSelection = vi.fn(() => '')
    focus = vi.fn()
  }
  return { Terminal: MockTerminal }
})
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

import TerminalView from '@/components/TerminalView'
import { FreshAgentView } from '@/components/fresh-agent/FreshAgentView'

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}
;(globalThis as unknown as { ResizeObserver: typeof MockResizeObserver }).ResizeObserver = MockResizeObserver

function sentFrames(type: string): Array<Record<string, unknown>> {
  return wsMocks.send.mock.calls.map((call) => call[0] as Record<string, unknown>).filter((m) => m.type === type)
}

function buildTerminalStore(content: TerminalPaneContent) {
  const tabId = 'tab-1'
  const paneId = 'pane-1'
  const root: PaneNode = { type: 'leaf', id: paneId, content }
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
      extensions: extensionsReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [{ id: tabId, mode: content.mode, status: 'running', title: 'freshell', createRequestId: content.createRequestId }],
        activeTabId: tabId,
      },
      panes: {
        layouts: { [tabId]: root },
        activePane: { [tabId]: paneId },
        paneTitles: { [tabId]: { [paneId]: 'freshell' } },
      },
      settings: { settings: { ...defaultSettings }, status: 'loaded' },
      connection: { status: 'connected' },
    },
  })
}

function terminalContent(overrides: Partial<TerminalPaneContent>): TerminalPaneContent {
  return {
    kind: 'terminal',
    createRequestId: 'req-1',
    status: 'creating',
    mode: 'codex',
    shell: 'system',
    initialCwd: '/home/dan/code/freshell',
    ...overrides,
  }
}

describe('unified agent names create-sender handle stamping (T6-R3)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    wsMocks.connect.mockResolvedValue(undefined)
  })
  afterEach(() => {
    cleanup()
  })

  describe('TerminalView terminal.create', () => {
    it('mints, persists, and sends a namingHandle for a new scoped conversation', async () => {
      const content = terminalContent({ mode: 'codex' })
      const store = buildTerminalStore(content)
      render(
        <Provider store={store}>
          <TerminalView tabId="tab-1" paneId="pane-1" paneContent={content} />
        </Provider>,
      )
      await waitFor(() => expect(sentFrames('terminal.create').length).toBeGreaterThan(0))
      const frame = sentFrames('terminal.create')[0]!
      expect(typeof frame.namingHandle).toBe('string')
      expect((frame.namingHandle as string).length).toBeGreaterThan(0)
      // The handle is persisted in the pane content (the capture/display rungs).
      await waitFor(() => {
        const state = store.getState() as unknown as { panes: { layouts: Record<string, PaneNode> } }
        const leaf = state.panes.layouts['tab-1'] as { type: string; content?: TerminalPaneContent }
        expect(leaf.content?.namingHandle).toBe(frame.namingHandle)
      })
    })

    it('re-sends the SAME handle on a remount (the persisted content drives the retry)', async () => {
      const content = terminalContent({ mode: 'codex' })
      const store = buildTerminalStore(content)
      const view = (paneContent: TerminalPaneContent) => (
        <Provider store={store}>
          <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} />
        </Provider>
      )
      const first = render(view(content))
      await waitFor(() => expect(sentFrames('terminal.create').length).toBeGreaterThan(0))
      const firstHandle = sentFrames('terminal.create')[0]!.namingHandle
      expect(typeof firstHandle).toBe('string')
      first.unmount()
      // The remount reads the PERSISTED content (the store's own copy) — the
      // pre-durable handle must survive and be re-sent as-is, never reminted.
      const state = store.getState() as unknown as { panes: { layouts: Record<string, PaneNode> } }
      const persisted = (state.panes.layouts['tab-1'] as { type: string; content?: TerminalPaneContent }).content
      expect(persisted?.namingHandle).toBe(firstHandle)
      render(view(persisted!))
      await waitFor(() => expect(sentFrames('terminal.create').length).toBeGreaterThan(1))
      const handles = sentFrames('terminal.create').map((f) => f.namingHandle)
      expect(handles.every((h) => h === firstHandle)).toBe(true)
    })

    it('sends no namingHandle for a shell pane', async () => {
      const content = terminalContent({ mode: 'shell' })
      const store = buildTerminalStore(content)
      render(
        <Provider store={store}>
          <TerminalView tabId="tab-1" paneId="pane-1" paneContent={content} />
        </Provider>,
      )
      await waitFor(() => expect(sentFrames('terminal.create').length).toBeGreaterThan(0))
      expect(sentFrames('terminal.create').every((f) => f.namingHandle === undefined)).toBe(true)
    })

    it('sends no namingHandle for a resume create (the durable record is the target)', async () => {
      const content = terminalContent({
        mode: 'claude',
        sessionRef: { provider: 'claude', sessionId: '550e8400-e29b-41d4-a716-446655440000' },
        resumeSessionId: '550e8400-e29b-41d4-a716-446655440000',
      })
      const store = buildTerminalStore(content)
      render(
        <Provider store={store}>
          <TerminalView tabId="tab-1" paneId="pane-1" paneContent={content} />
        </Provider>,
      )
      await waitFor(() => expect(sentFrames('terminal.create').length).toBeGreaterThan(0))
      expect(sentFrames('terminal.create').every((f) => f.namingHandle === undefined)).toBe(true)
    })

    it('re-sends the persisted namingHandle on a pending-reconcile FRESH recovery create', async () => {
      // A zero-turn codex/opencode pane recovers through the pane-reconcile
      // verdict lane: the server answers the reconcile probe with a FRESH
      // verdict (no durable conversation exists yet) and the pane re-creates
      // with pendingReconcile === 'fresh'. The pane's PRE-DURABLE naming
      // identity is not the conversation — the persisted namingHandle must
      // ride the recovery create, or the server mints a fresh empty record
      // and the pre-durable manual rename is orphaned behind a spent handle.
      const content = terminalContent({
        mode: 'codex',
        pendingReconcile: 'fresh',
        namingHandle: 'nh-persisted-reconcile',
      })
      const store = buildTerminalStore(content)
      render(
        <Provider store={store}>
          <TerminalView tabId="tab-1" paneId="pane-1" paneContent={content} />
        </Provider>,
      )
      await waitFor(() => expect(sentFrames('terminal.create').length).toBeGreaterThan(0))
      expect(sentFrames('terminal.create').every((f) => f.namingHandle === 'nh-persisted-reconcile')).toBe(true)
    })
  })

  describe('FreshAgentView freshAgent.create', () => {
    function buildFreshStore(content: FreshAgentPaneContent) {
      const tabId = 'tab-1'
      const paneId = 'pane-1'
      const root: PaneNode = { type: 'leaf', id: paneId, content }
      return configureStore({
        reducer: {
          tabs: tabsReducer,
          panes: panesReducer,
          settings: settingsReducer,
          connection: connectionReducer,
          extensions: extensionsReducer,
          freshAgent: freshAgentReducer,
          sessions: sessionsReducer,
        },
        middleware: (getDefaultMiddleware) =>
          getDefaultMiddleware({
            // sessions.expandedProjects is a Set by slice design (same
            // ignore as FreshAgentView.test.tsx's createStore).
            serializableCheck: {
              ignoredPaths: ['sessions.expandedProjects'],
            },
          }),
        preloadedState: {
          tabs: {
            tabs: [{ id: tabId, mode: content.sessionType, status: 'running', title: 'freshell', createRequestId: content.createRequestId }],
            activeTabId: tabId,
          },
          panes: {
            layouts: { [tabId]: root },
            activePane: { [tabId]: paneId },
            paneTitles: { [tabId]: { [paneId]: 'freshell' } },
          },
          settings: { settings: { ...defaultSettings }, status: 'loaded' },
          connection: { status: 'connected' },
        },
      })
    }

    function freshContent(overrides: Partial<FreshAgentPaneContent>): FreshAgentPaneContent {
      return {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'fresh-req-1',
        status: 'creating',
        initialCwd: '/home/dan/code/freshell',
        ...overrides,
      }
    }

    it('mints, persists, and sends a namingHandle for a new scoped fresh conversation', async () => {
      const content = freshContent({})
      const store = buildFreshStore(content)
      render(
        <Provider store={store}>
          <FreshAgentView tabId="tab-1" paneId="pane-1" paneContent={content} />
        </Provider>,
      )
      await waitFor(() => expect(sentFrames('freshAgent.create').length).toBeGreaterThan(0))
      const frame = sentFrames('freshAgent.create')[0]!
      expect(typeof frame.namingHandle).toBe('string')
      expect((frame.namingHandle as string).length).toBeGreaterThan(0)
      await waitFor(() => {
        const state = store.getState() as unknown as { panes: { layouts: Record<string, PaneNode> } }
        const leaf = state.panes.layouts['tab-1'] as { type: string; content?: FreshAgentPaneContent }
        expect(leaf.content?.namingHandle).toBe(frame.namingHandle)
      })
    })

    it('sends no namingHandle for an out-of-scope runtime (kilroy)', async () => {
      const content = freshContent({ sessionType: 'kilroy' as FreshAgentPaneContent['sessionType'], provider: 'claude' })
      const store = buildFreshStore(content)
      render(
        <Provider store={store}>
          <FreshAgentView tabId="tab-1" paneId="pane-1" paneContent={content} />
        </Provider>,
      )
      await waitFor(() => expect(sentFrames('freshAgent.create').length).toBeGreaterThan(0))
      expect(sentFrames('freshAgent.create').every((f) => f.namingHandle === undefined)).toBe(true)
    })
  })
})
