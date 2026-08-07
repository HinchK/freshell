import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import TabBar from '@/components/TabBar'
import tabsReducer from '@/store/tabsSlice'
import codexActivityReducer from '@/store/codexActivitySlice'
import opencodeActivityReducer from '@/store/opencodeActivitySlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import type { Tab } from '@/store/types'
import {
  composeResolvedSettings,
  createDefaultServerSettings,
  resolveLocalSettings,
} from '@shared/settings'

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({ send: vi.fn() }),
}))

// Partial mock: TabBar's import chain (TabBarResizeHandle -> @/components/panes)
// pulls in many icons; keep the real module and override only the ones the
// original mock stubbed with testids.
vi.mock('lucide-react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('lucide-react')>()),
  X: ({ className }: { className?: string }) => <svg data-testid="x-icon" className={className} />,
  Plus: ({ className }: { className?: string }) => <svg data-testid="plus-icon" className={className} />,
  Circle: ({ className }: { className?: string }) => <svg data-testid="circle-icon" className={className} />,
  ChevronDown: ({ className }: { className?: string }) => <svg data-testid="chevron-down-icon" className={className} />,
  ChevronLeft: ({ className }: { className?: string }) => <svg data-testid="chevron-left-icon" className={className} />,
  ChevronRight: ({ className }: { className?: string }) => <svg data-testid="chevron-right-icon" className={className} />,
  Terminal: ({ className }: { className?: string }) => <svg data-testid="terminal-icon" className={className} />,
  MessageSquare: ({ className }: { className?: string }) => <svg data-testid="message-square-icon" className={className} />,
  PanelLeft: ({ className }: { className?: string }) => <svg data-testid="panel-left-icon" className={className} />,
}))

vi.mock('@/components/icons/PaneIcon', () => ({
  default: ({ content, className }: any) => (
    <svg data-testid="pane-icon" data-content-kind={content?.kind} data-content-mode={content?.mode} className={className} />
  ),
}))

function createTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: `tab-${Math.random().toString(36).slice(2)}`,
    createRequestId: 'req-1',
    title: 'Terminal 1',
    status: 'running',
    mode: 'shell',
    shell: 'system',
    createdAt: Date.now(),
    ...overrides,
  }
}

function buildPanesPatch(options: { multirowTabs?: boolean; tabBarRows?: number }) {
  const panes: { multirowTabs?: boolean; tabBarRows?: number } = {}
  if (options.multirowTabs !== undefined) panes.multirowTabs = options.multirowTabs
  if (options.tabBarRows !== undefined) panes.tabBarRows = options.tabBarRows
  return Object.keys(panes).length > 0 ? { panes } : undefined
}

function createStore(options: { tabs: Tab[]; activeTabId: string | null; multirowTabs?: boolean; tabBarRows?: number }) {
  const localSettings = resolveLocalSettings(buildPanesPatch(options))
  const serverSettings = createDefaultServerSettings({
    loggingDebug: defaultSettings.logging.debug,
  })

  return configureStore({
    reducer: {
      tabs: tabsReducer,
      codexActivity: codexActivityReducer,
      opencodeActivity: opencodeActivityReducer,
      panes: panesReducer,
      settings: settingsReducer,
      turnCompletion: turnCompletionReducer,
    },
    preloadedState: {
      tabs: { tabs: options.tabs, activeTabId: options.activeTabId, renameRequestTabId: null },
      codexActivity: { byTerminalId: {}, lastSnapshotSeq: 0, liveMutationSeqByTerminalId: {}, removedMutationSeqByTerminalId: {} },
      opencodeActivity: { byTerminalId: {}, lastSnapshotSeq: 0, liveMutationSeqByTerminalId: {}, removedMutationSeqByTerminalId: {} },
      panes: { layouts: {}, activePane: {}, paneTitles: {} },
      settings: {
        serverSettings,
        localSettings,
        settings: composeResolvedSettings(serverSettings, localSettings),
        loaded: true,
      },
      turnCompletion: { seq: 0, pendingEvents: [], attentionByTab: {} },
    },
  })
}

function renderWithStore(ui: React.ReactElement, store: ReturnType<typeof createStore>) {
  return render(<Provider store={store}>{ui}</Provider>)
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => cleanup())

describe('TabBar multirow tabs', () => {
  it('uses flex-wrap on the tab strip container when multirowTabs is enabled', () => {
    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1', multirowTabs: true })
    const { container } = renderWithStore(<TabBar />, store)

    const flexWrap = container.querySelector('.flex-wrap')
    expect(flexWrap).not.toBeNull()
  })

  it('does not use flex-wrap when multirowTabs is disabled (single-row)', () => {
    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1', multirowTabs: false })
    const { container } = renderWithStore(<TabBar />, store)

    const flexWrap = container.querySelector('.flex-wrap')
    expect(flexWrap).toBeNull()
  })

  it('uses overflow-x-auto when multirowTabs is disabled (single-row)', () => {
    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1', multirowTabs: false })
    const { container } = renderWithStore(<TabBar />, store)

    const scrollContainer = container.querySelector('.overflow-x-auto')
    expect(scrollContainer).not.toBeNull()
  })

  it('does not render scroll arrow buttons when multirowTabs is enabled', () => {
    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1', multirowTabs: true })
    renderWithStore(<TabBar />, store)

    const leftBtn = screen.queryByLabelText('Scroll tabs left')
    const rightBtn = screen.queryByLabelText('Scroll tabs right')
    expect(leftBtn).toBeNull()
    expect(rightBtn).toBeNull()
  })

  it('renders scroll arrow buttons when multirowTabs is disabled', () => {
    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1', multirowTabs: false })
    renderWithStore(<TabBar />, store)

    const leftBtn = screen.getByLabelText('Scroll tabs left')
    const rightBtn = screen.getByLabelText('Scroll tabs right')
    expect(leftBtn).toBeInTheDocument()
    expect(rightBtn).toBeInTheDocument()
  })

  it('applies h-auto to the outer wrapper and a 3-row max-height to the tab strip when multirowTabs is enabled', () => {
    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1', multirowTabs: true })
    const { container } = renderWithStore(<TabBar />, store)

    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.className).toContain('h-auto')
    expect(wrapper.className).not.toContain('h-12')

    const strip = screen.getByTestId('tab-strip')
    // No Tailwind max-h-* class at all (superset of the old fixed-class check):
    // the max-height contract is the inline rem-based style below.
    expect(strip.className).not.toContain('max-h-')
    expect(strip.style.maxHeight).toBe('calc(6.25rem + 1px)')
  })

  it('derives the strip max-height from panes.tabBarRows', () => {
    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1', multirowTabs: true, tabBarRows: 5 })
    renderWithStore(<TabBar />, store)
    expect(screen.getByTestId('tab-strip').style.maxHeight).toBe('calc(10.5rem + 1px)')
  })

  it('applies no inline max-height in single-row mode', () => {
    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1', multirowTabs: false })
    renderWithStore(<TabBar />, store)
    expect(screen.getByTestId('tab-strip').style.maxHeight).toBe('')
  })

  it('applies fixed height to the outer wrapper when multirowTabs is disabled', () => {
    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1', multirowTabs: false })
    const { container } = renderWithStore(<TabBar />, store)

    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.className).toContain('h-12')
    expect(wrapper.className).not.toContain('h-auto')
  })

  it('still renders all tabs when multirowTabs is enabled', () => {
    const tabs = [
      createTab({ id: 'tab-1', title: 'Tab 1' }),
      createTab({ id: 'tab-2', title: 'Tab 2' }),
      createTab({ id: 'tab-3', title: 'Tab 3' }),
    ]
    const store = createStore({ tabs, activeTabId: 'tab-1', multirowTabs: true })
    renderWithStore(<TabBar />, store)

    expect(screen.getByText('Tab 1')).toBeInTheDocument()
    expect(screen.getByText('Tab 2')).toBeInTheDocument()
    expect(screen.getByText('Tab 3')).toBeInTheDocument()
  })

  it('still renders the + new tab button when multirowTabs is enabled', () => {
    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1', multirowTabs: true })
    renderWithStore(<TabBar />, store)

    const addButton = screen.getByRole('button', { name: 'New shell tab' })
    expect(addButton).toBeInTheDocument()
  })

  it('does not use overflow-y-auto on the tab strip when multirowTabs is disabled', () => {
    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1', multirowTabs: false })
    const { container } = renderWithStore(<TabBar />, store)

    const scrollContainer = container.querySelector('.overflow-x-auto')
    expect(scrollContainer).not.toBeNull()
    expect(scrollContainer!.className).not.toContain('overflow-y-auto')
  })

  it('uses overflow-y-auto on the tab strip when multirowTabs is enabled', () => {
    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1', multirowTabs: true })
    const { container } = renderWithStore(<TabBar />, store)

    const flexWrap = container.querySelector('.flex-wrap')
    expect(flexWrap).not.toBeNull()
    expect(flexWrap!.className).toContain('overflow-y-auto')
  })

  it('does not apply overflow-x-hidden to the tab strip when multirowTabs is enabled', () => {
    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1', multirowTabs: true })
    const { container } = renderWithStore(<TabBar />, store)

    const flexWrap = container.querySelector('.flex-wrap')
    expect(flexWrap).not.toBeNull()
    expect(flexWrap!.className).not.toContain('overflow-x-hidden')
  })

  it('defaults to multirow mode when no local settings are stored', () => {
    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1' })
    renderWithStore(<TabBar />, store)

    const strip = screen.getByTestId('tab-strip')
    expect(strip.className).toContain('flex-wrap')
    expect(strip.className).not.toContain('overflow-x-auto')
  })

  it('does not apply h-full to sidebar reopen slot in multirow mode', () => {
    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1', multirowTabs: true })
    const { container } = renderWithStore(
      <TabBar sidebarCollapsed={true} onToggleSidebar={() => {}} />,
      store,
    )

    const slot = container.querySelector('[data-testid="desktop-sidebar-reopen-slot"]')
    expect(slot).not.toBeNull()
    expect(slot!.className).not.toContain('h-full')
  })

  describe('tab widths', () => {
    it('fixes tabs at 175px in single-row mode', () => {
      const tab = createTab({ id: 'tab-1' })
      const store = createStore({ tabs: [tab], activeTabId: 'tab-1', multirowTabs: false })
      renderWithStore(<TabBar />, store)
      const wrapper = screen.getByTestId('tab-strip').firstElementChild as HTMLElement
      expect(wrapper.className).toContain('w-[175px]')
      expect(wrapper.className).toContain('shrink-0')
      expect(wrapper.className).not.toContain('grow')
      expect(wrapper.className).not.toContain('max-w-[200px]')
    })

    it('sizes tabs between 150px and 200px in multirow mode', () => {
      const tab = createTab({ id: 'tab-1' })
      const store = createStore({ tabs: [tab], activeTabId: 'tab-1', multirowTabs: true })
      renderWithStore(<TabBar />, store)
      const wrapper = screen.getByTestId('tab-strip').firstElementChild as HTMLElement
      expect(wrapper.className).toContain('grow')
      expect(wrapper.className).toContain('basis-[150px]')
      expect(wrapper.className).toContain('min-w-[150px]')
      expect(wrapper.className).toContain('max-w-[200px]')
      expect(wrapper.className).not.toContain('w-[175px]')
    })

    it('locks every tab to the full-row width when tabs wrap to multiple rows', () => {
      // Fake geometry (jsdom has no layout): a 1000px-wide strip whose content
      // wraps (scrollHeight 67 > the 2-row threshold at a 16px root).
      const clientWidthSpy = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(1000)
      const scrollHeightSpy = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(67)
      try {
        const tabs = Array.from({ length: 8 }, (_, i) =>
          createTab({ id: `tab-${i + 1}`, title: `Tab ${i + 1}` }),
        )
        const store = createStore({ tabs, activeTabId: 'tab-1', multirowTabs: true })
        renderWithStore(<TabBar />, store)
        const strip = screen.getByTestId('tab-strip')
        const wrappers = Array.from(strip.children) as HTMLElement[]
        expect(wrappers.length).toBe(8)
        for (const wrapper of wrappers) {
          // 1000px strip, 2px gap -> 6 tabs per full row -> floor((1000 - 5*2)/6) = 165.
          expect(wrapper.style.width).toBe('165px')
          expect(wrapper.className).toContain('shrink-0')
          expect(wrapper.className).not.toContain('grow')
          expect(wrapper.className).not.toContain('basis-[150px]')
          expect(wrapper.className).not.toContain('max-w-[200px]')
        }
      } finally {
        clientWidthSpy.mockRestore()
        scrollHeightSpy.mockRestore()
      }
    })

    it('prefers the fractional rect width so a knife-edge clientWidth round-up cannot overpredict capacity', () => {
      // Real-Chromium-validated knife edge: a true content width of 909.6px
      // rounds to clientWidth 910 (capacity 6), but only 5 tabs of >=150px
      // actually fit per row. The effect must prefer
      // floor(getBoundingClientRect().width) = 909 (capacity 5), so 6 tabs
      // wrap and lock to floor((909 - 4*2) / 5) = 180.
      const clientWidthSpy = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(910)
      const scrollHeightSpy = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(67)
      const rect = {
        width: 909.6, height: 67, top: 0, left: 0, right: 909.6, bottom: 67, x: 0, y: 0,
        toJSON: () => ({}),
      } as DOMRect
      const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(rect)
      try {
        const tabs = Array.from({ length: 6 }, (_, i) =>
          createTab({ id: `tab-${i + 1}`, title: `Tab ${i + 1}` }),
        )
        const store = createStore({ tabs, activeTabId: 'tab-1', multirowTabs: true })
        renderWithStore(<TabBar />, store)
        const wrappers = Array.from(screen.getByTestId('tab-strip').children) as HTMLElement[]
        expect(wrappers.length).toBe(6)
        for (const wrapper of wrappers) {
          expect(wrapper.style.width).toBe('180px')
        }
      } finally {
        clientWidthSpy.mockRestore()
        scrollHeightSpy.mockRestore()
        rectSpy.mockRestore()
      }
    })

    it('keeps stretch-to-fill when all tabs fit on a single multirow row', () => {
      // 1000px strip fits 6 tabs per row; 3 tabs -> single row -> no width lock.
      const clientWidthSpy = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(1000)
      try {
        const tabs = [
          createTab({ id: 'tab-1', title: 'Tab 1' }),
          createTab({ id: 'tab-2', title: 'Tab 2' }),
          createTab({ id: 'tab-3', title: 'Tab 3' }),
        ]
        const store = createStore({ tabs, activeTabId: 'tab-1', multirowTabs: true })
        renderWithStore(<TabBar />, store)
        const wrapper = screen.getByTestId('tab-strip').firstElementChild as HTMLElement
        expect(wrapper.style.width).toBe('')
        expect(wrapper.className).toContain('grow')
        expect(wrapper.className).toContain('basis-[150px]')
        expect(wrapper.className).toContain('min-w-[150px]')
        expect(wrapper.className).toContain('max-w-[200px]')
      } finally {
        clientWidthSpy.mockRestore()
      }
    })
  })

  describe('tab bar resize handle', () => {
    it('does not render in single-row mode', () => {
      const tab = createTab({ id: 'tab-1' })
      const store = createStore({ tabs: [tab], activeTabId: 'tab-1', multirowTabs: false })
      renderWithStore(<TabBar />, store)
      expect(screen.queryByTestId('tab-bar-resize-handle')).toBeNull()
    })

    it('does not render when tabs fit in one row', () => {
      // jsdom scrollHeight is 0 -> below the multi-row threshold.
      const tab = createTab({ id: 'tab-1' })
      const store = createStore({ tabs: [tab], activeTabId: 'tab-1', multirowTabs: true })
      renderWithStore(<TabBar />, store)
      expect(screen.queryByTestId('tab-bar-resize-handle')).toBeNull()
    })

    it('renders when the strip wraps to multiple rows', () => {
      const scrollHeightSpy = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(67)
      try {
        const tab = createTab({ id: 'tab-1' })
        const store = createStore({ tabs: [tab], activeTabId: 'tab-1', multirowTabs: true })
        renderWithStore(<TabBar />, store)
        expect(screen.getByTestId('tab-bar-resize-handle')).toBeTruthy()
      } finally {
        scrollHeightSpy.mockRestore()
      }
    })

    it('keyboard-resizing the handle updates the strip max-height via the store', () => {
      const scrollHeightSpy = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(67)
      try {
        const tab = createTab({ id: 'tab-1' })
        const store = createStore({ tabs: [tab], activeTabId: 'tab-1', multirowTabs: true })
        renderWithStore(<TabBar />, store)
        expect(screen.getByTestId('tab-strip').style.maxHeight).toBe('calc(6.25rem + 1px)')

        fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize tab bar height' }), { key: 'ArrowDown' })

        expect(screen.getByTestId('tab-strip').style.maxHeight).toBe('calc(8.375rem + 1px)')
        expect(store.getState().settings.localSettings.panes.tabBarRows).toBe(4)
      } finally {
        scrollHeightSpy.mockRestore()
      }
    })
  })
})
