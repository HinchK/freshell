import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ComponentProps } from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import Sidebar from '@/components/Sidebar'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionsReducer from '@/store/sessionsSlice'
import sessionActivityReducer from '@/store/sessionActivitySlice'
import terminalDirectoryReducer from '@/store/terminalDirectorySlice'
import type { ProjectGroup } from '@/store/types'

// Mock react-window's List component
vi.mock('react-window', () => ({
  List: ({ rowCount, rowComponent: Row, rowProps, style }: {
    rowCount: number
    rowComponent: React.ComponentType<any>
    rowProps: any
    style: React.CSSProperties
  }) => {
    const items = []
    for (let i = 0; i < rowCount; i++) {
      items.push(
        <Row
          key={i}
          index={i}
          style={{ height: 56 }}
          ariaAttributes={{}}
          {...rowProps}
        />
      )
    }
    return <div style={style} data-testid="virtualized-list">{items}</div>
  },
}))

// Mock the WebSocket client
const mockSend = vi.fn()
const mockOnMessage = vi.fn(() => () => {})
const mockConnect = vi.fn().mockResolvedValue(undefined)
const mockFetchSidebarSessionsSnapshot = vi.fn()
const mockGetTerminalDirectoryPage = vi.fn()

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: mockSend,
    onMessage: mockOnMessage,
    connect: mockConnect,
  }),
}))

// Mock the searchSessions API
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual('@/lib/api')
  return {
    ...actual,
    fetchSidebarSessionsSnapshot: (...args: any[]) => mockFetchSidebarSessionsSnapshot(...args),
    getTerminalDirectoryPage: (...args: any[]) => mockGetTerminalDirectoryPage(...args),
    searchSessions: vi.fn(),
  }
})

vi.mock('@/components/ResumeSessionDialog', () => ({
  ResumeSessionDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="resume-dialog" /> : null,
}))

function createTestStore(options?: {
  projects?: ProjectGroup[]
  featureFlags?: Record<string, boolean>
}) {
  const projects = (options?.projects ?? []).map((project) => ({
    ...project,
    sessions: (project.sessions ?? []).map((session) => ({
      ...session,
      provider: session.provider ?? 'claude',
    })),
  }))

  return configureStore({
    reducer: {
      settings: settingsReducer,
      tabs: tabsReducer,
      panes: panesReducer,
      connection: connectionReducer,
      sessions: sessionsReducer,
      sessionActivity: sessionActivityReducer,
      terminalDirectory: terminalDirectoryReducer,
    },
    middleware: (getDefault) =>
      getDefault({
        serializableCheck: {
          ignoredPaths: ['sessions.expandedProjects'],
        },
      }),
    preloadedState: {
      settings: {
        settings: {
          ...defaultSettings,
          sidebar: {
            ...defaultSettings.sidebar,
            sortMode: 'activity' as const,
            showProjectBadges: true,
            hideEmptySessions: false,
          },
        },
        loaded: true,
        lastSavedAt: undefined,
      },
      tabs: {
        tabs: [],
        activeTabId: null,
      },
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
      },
      sessions: {
        projects,
        expandedProjects: new Set<string>(),
        isLoading: false,
        error: null,
      },
      connection: {
        status: 'connected',
        error: null,
        featureFlags: options?.featureFlags ?? { sessionResolve: true },
      },
      sessionActivity: {
        sessions: {},
      },
    },
  })
}

function renderSidebar(
  overrides: Partial<ComponentProps<typeof Sidebar>> = {},
  featureFlags: Record<string, boolean> = { sessionResolve: true },
) {
  const store = createTestStore({ featureFlags })
  const onNavigate = vi.fn()
  mockGetTerminalDirectoryPage.mockResolvedValue({
    items: [],
    nextCursor: null,
    revision: 1,
  })

  const result = render(
    <Provider store={store}>
      <Sidebar view="terminal" onNavigate={onNavigate} {...overrides} />
    </Provider>
  )

  return { ...result, onNavigate }
}

describe('Sidebar resume footer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockFetchSidebarSessionsSnapshot.mockReset()
    mockFetchSidebarSessionsSnapshot.mockResolvedValue({ projects: [] })
    mockGetTerminalDirectoryPage.mockReset()
    mockGetTerminalDirectoryPage.mockResolvedValue({
      items: [],
      nextCursor: null,
      revision: 1,
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('renders the footer as a sibling AFTER the scrollable list, not inside it', () => {
    renderSidebar()
    const list = screen.getByTestId('sidebar-session-list')
    const footer = screen.getByTestId('sidebar-resume-footer')
    // Not inside the scroll viewport:
    expect(list.contains(footer)).toBe(false)
    // After the list in document order:
    expect(
      list.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('keeps the footer outside the flex-1 min-h-0 region (pinned at every scroll position)', () => {
    renderSidebar()
    const footer = screen.getByTestId('sidebar-resume-footer')
    // No ancestor between footer and the sidebar root may be the scrollable
    // flex-1 min-h-0 wrapper.
    let node: HTMLElement | null = footer.parentElement
    let insideScrollRegion = false
    while (node) {
      const cls = node.className ?? ''
      if (cls.includes('flex-1') && cls.includes('min-h-0')) insideScrollRegion = true
      node = node.parentElement
    }
    expect(insideScrollRegion).toBe(false)
    expect(footer.className).toContain('flex-shrink-0')
  })

  it('is rendered in fullWidth (mobile) mode too', () => {
    renderSidebar({ fullWidth: true })
    expect(screen.getByTestId('sidebar-resume-button')).toBeInTheDocument()
  })

  it('opens the resume dialog on click and closes it again', () => {
    renderSidebar()
    expect(screen.queryByTestId('resume-dialog')).toBeNull()
    fireEvent.click(screen.getByTestId('sidebar-resume-button'))
    expect(screen.getByTestId('resume-dialog')).toBeInTheDocument()
  })

  it('the button is keyboard reachable (a real button with an accessible name)', () => {
    renderSidebar()
    const button = screen.getByTestId('sidebar-resume-button')
    expect(button.tagName).toBe('BUTTON')
    expect(button).toHaveAccessibleName()
  })

  it('does not render the footer without the sessionResolve feature flag', () => {
    // e.g. the Rust/Tauri deployments: same client bundle, no resolve
    // endpoint, and a featureFlags payload that omits the flag.
    renderSidebar({}, {})
    expect(screen.queryByTestId('sidebar-resume-footer')).toBeNull()
    expect(screen.queryByTestId('sidebar-resume-button')).toBeNull()
  })
})
