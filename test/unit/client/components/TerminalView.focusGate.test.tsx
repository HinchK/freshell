import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, waitFor, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import TerminalView from '@/components/TerminalView'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import type { TerminalPaneContent } from '@/store/paneTypes'
import type { AppSettings } from '@/store/types'

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn(() => () => {}),
  onReconnect: vi.fn(() => () => {}),
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => wsMocks,
}))

const openExternalUrlMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/open-url', () => ({
  openExternalUrl: openExternalUrlMock,
  shouldOpenLinkExternally: (event: MouseEvent) => event.ctrlKey || event.shiftKey,
}))

vi.mock('@/hooks/useNotificationSound', () => ({
  useNotificationSound: () => ({ play: vi.fn() }),
}))

vi.mock('@/lib/terminal-themes', () => ({
  getTerminalTheme: () => ({}),
}))

const terminalInstances: any[] = []
const registeredLinkProviders: any[] = []

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    paneId: string | null = null
    buffer = {
      active: {
        getLine: vi.fn(() => ({
          translateToString: () => 'Visit https://detected.example.com here',
        })),
      },
    }
    open = vi.fn((element: HTMLElement) => {
      this.paneId = element.closest('[data-pane-id]')?.getAttribute('data-pane-id') ?? null
    })
    loadAddon = vi.fn()
    registerLinkProvider = vi.fn((provider: any) => {
      registeredLinkProviders.push(provider)
      return { dispose: vi.fn() }
    })
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
    selectAll = vi.fn()
    reset = vi.fn()
    scrollToBottom = vi.fn()
    constructor(opts?: Record<string, unknown>) {
      if (opts) this.options = opts
      terminalInstances.push(this)
    }
  }

  return { Terminal: MockTerminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  },
}))

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

const paneContent: TerminalPaneContent = {
  kind: 'terminal',
  createRequestId: 'req-1',
  status: 'running',
  mode: 'shell',
  shell: 'system',
  terminalId: 'term-1',
  initialCwd: '/tmp',
}

function createStore(opts: { activeTabId?: string | null; activePaneId?: string; settings?: Partial<AppSettings> } = {}) {
  const mergedSettings = { ...defaultSettings, ...opts.settings, terminal: { ...defaultSettings.terminal, ...opts.settings?.terminal } }

  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
      turnCompletion: turnCompletionReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [{
          id: 'tab-1',
          createRequestId: 'req-1',
          title: 'Test',
          status: 'running' as const,
          mode: 'shell' as const,
          shell: 'system' as const,
          terminalId: 'term-1',
          createdAt: Date.now(),
        }],
        activeTabId: opts.activeTabId === undefined ? 'tab-1' : opts.activeTabId,
        renameRequestTabId: null,
      },
      panes: {
        layouts: { 'tab-1': { type: 'leaf' as const, id: 'pane-1', content: paneContent } },
        activePane: { 'tab-1': opts.activePaneId ?? 'pane-1' },
        paneTitles: {},
      },
      settings: { settings: mergedSettings, loaded: true },
      connection: { status: 'connected' as const, error: null },
      turnCompletion: {
        seq: 0,
        pendingEvents: [],
        attentionByTab: {},
        attentionByPane: {},
      },
    },
  })
}

describe('TerminalView scheduled-focus gate (agent focus neutrality)', () => {
  beforeEach(() => {
    terminalInstances.length = 0
    registeredLinkProviders.length = 0
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('focuses the terminal on mount when the pane owns focus (pin: user default preserved)', async () => {
    const store = createStore()
    render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} hidden={false} />
      </Provider>
    )
    await waitFor(() => expect(terminalInstances).toHaveLength(1))
    await waitFor(() => expect(terminalInstances[0].focus).toHaveBeenCalled())
  })

  it('never focuses a terminal that mounts in a hidden tab', async () => {
    const store = createStore()
    render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} hidden />
      </Provider>
    )
    await waitFor(() => expect(terminalInstances).toHaveLength(1))
    await act(async () => { await new Promise((r) => setTimeout(r, 150)) })
    expect(terminalInstances[0].focus).not.toHaveBeenCalled()
  })

  it('never focuses a terminal when another pane holds tab focus', async () => {
    const store = createStore({ activePaneId: 'pane-other' })
    render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} hidden={false} />
      </Provider>
    )
    await waitFor(() => expect(terminalInstances).toHaveLength(1))
    await act(async () => { await new Promise((r) => setTimeout(r, 150)) })
    expect(terminalInstances[0].focus).not.toHaveBeenCalled()
  })
})
