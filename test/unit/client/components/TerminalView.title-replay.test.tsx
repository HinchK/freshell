import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import extensionsReducer from '@/store/extensionsSlice'
import { terminalInventoryTitleReplayMiddleware, foldTerminalInventoryTitles } from '@/lib/terminal-inventory-titles'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import { resetEnsureExtensionsRegistryCacheForTests } from '@/hooks/useEnsureExtensionsRegistry'

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn(),
  onReconnect: vi.fn().mockReturnValue(() => {}),
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsMocks.send,
    connect: wsMocks.connect,
    onMessage: wsMocks.onMessage,
    onReconnect: wsMocks.onReconnect,
  }),
}))

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }))
vi.mock('@/lib/auth', () => ({ getAuthToken: vi.fn(() => undefined) }))
vi.mock('@/lib/terminal-themes', () => ({ getTerminalTheme: () => ({}) }))
vi.mock('lucide-react', () => ({
  Loader2: ({ className }: { className?: string }) => <svg data-testid="loader" className={className} />,
}))
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

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

// e2r4 review finding 2: the terminal.title.updated handler recorded into
// the replay cache only behind the pane-binding match (msg.terminalId ===
// tid), so during recovery — inventory cached before the pane receives its
// reconciled terminalId — a NEWER terminal.title.updated broadcast was
// ignored by the unbound pane and never reached the cache; the later
// binding action then replayed the OLDER inventory snapshot title.
describe('TerminalView terminal.title.updated replay cache recording', () => {
  let messageHandler: ((msg: any) => void) | null = null

  beforeEach(() => {
    wsMocks.send.mockClear()
    wsMocks.onMessage.mockImplementation((callback: (msg: any) => void) => {
      messageHandler = callback
      return () => { messageHandler = null }
    })
    resetEnsureExtensionsRegistryCacheForTests()
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })

  afterEach(() => {
    cleanup()
    resetEnsureExtensionsRegistryCacheForTests()
    messageHandler = null
    vi.unstubAllGlobals()
  })

  function buildStore() {
    const tabId = 'tab-replay'
    const paneId = 'pane-replay'
    const terminalId = 't-replay-1'
    // A recovered pane: no terminalId yet (recovery builds panes without
    // one; the binding action lands it later).
    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'cr-replay-1',
      status: 'creating',
      mode: 'shell',
      shell: 'system',
    }
    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
        extensions: extensionsReducer,
      },
      middleware: (gDM) => gDM().concat(terminalInventoryTitleReplayMiddleware),
      preloadedState: {
        tabs: {
          tabs: [{ id: tabId, mode: 'shell', status: 'creating', title: 'freshell', createRequestId: 'cr-replay-1' }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: { settings: { ...defaultSettings }, status: 'loaded' },
        connection: { status: 'ready', error: null },
        extensions: { entries: [] },
      } as any,
    })
    return { store, tabId, paneId, paneContent, terminalId }
  }

  it('records a title broadcast for a terminalId not yet bound to the pane — a late binding replays the NEWER title, not the stale inventory snapshot', async () => {
    const { store, tabId, paneId, paneContent, terminalId } = buildStore()

    // The boot inventory frame cached the terminal's snapshot title (no
    // fold fires — no pane is bound to the terminal yet).
    expect(foldTerminalInventoryTitles(store, [{ terminalId, title: 'Boot snapshot' }])).toBe(0)

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>,
    )
    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    // A NEWER terminal-level title lands while the pane is still unbound.
    act(() => {
      messageHandler!({ type: 'terminal.title.updated', terminalId, title: 'Live newer title' })
    })
    // The pane's own title update stays binding-gated: an unbound pane
    // adopts nothing directly.
    expect(store.getState().panes.paneTitles?.[tabId]?.[paneId]).toBeUndefined()

    // The later binding action anchors the reconciled terminalId; the
    // replay middleware must serve the NEWER broadcast title.
    act(() => {
      store.dispatch({
        type: 'panes/updatePaneContent',
        payload: {
          tabId,
          paneId,
          content: { ...paneContent, terminalId, status: 'running' },
        },
      })
    })
    expect(store.getState().panes.paneTitles?.[tabId]?.[paneId]).toBe('Live newer title')
    expect(store.getState().panes.paneTitleSetByUser?.[tabId]?.[paneId]).toBeFalsy()
  })
})
