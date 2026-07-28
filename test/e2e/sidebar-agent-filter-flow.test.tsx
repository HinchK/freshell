import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import Sidebar from '@/components/Sidebar'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionsReducer from '@/store/sessionsSlice'
import sessionActivityReducer from '@/store/sessionActivitySlice'
import terminalDirectoryReducer from '@/store/terminalDirectorySlice'
import codexActivityReducer from '@/store/codexActivitySlice'
import type { ProjectGroup } from '@/store/types'
import { searchSessions as mockSearchSessions, fetchSidebarSessionsSnapshot as mockFetchSnapshot } from '@/lib/api'
import { _resetSessionWindowThunkState } from '@/store/sessionsThunks'

const mockSend = vi.fn()
const mockOnMessage = vi.fn(() => () => {})
const mockConnect = vi.fn().mockResolvedValue(undefined)

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: mockSend,
    onMessage: mockOnMessage,
    connect: mockConnect,
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    fetchSidebarSessionsSnapshot: vi.fn(),
    searchSessions: vi.fn(),
  }
})

function createStore(options?: {
  projects?: ProjectGroup[]
  sessions?: Record<string, unknown>
  tabs?: any[]
  panes?: any
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
      codexActivity: codexActivityReducer,
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
            sortMode: 'activity',
            showProjectBadges: true,
            hideEmptySessions: false,
          },
        },
        loaded: true,
        lastSavedAt: undefined,
      },
      tabs: {
        tabs: options?.tabs ?? [],
        activeTabId: null,
      },
      panes: options?.panes ?? {
        layouts: {},
        activePane: {},
        paneTitles: {},
      },
      sessions: {
        projects,
        expandedProjects: new Set<string>(),
        wsSnapshotReceived: true,
        ...options?.sessions,
      },
      connection: {
        status: 'connected',
        error: null,
      },
      sessionActivity: {
        sessions: {},
      },
      terminalDirectory: {
        windows: {
          sidebar: {
            items: [],
            nextCursor: null,
            revision: 1,
          },
        },
        searches: {},
      },
      codexActivity: {
        byTerminalId: {},
        lastSnapshotSeq: 0,
        liveMutationSeqByTerminalId: {},
        removedMutationSeqByTerminalId: {},
      },
    },
  })
}

function renderSidebar(store: ReturnType<typeof createStore>) {
  const onNavigate = vi.fn()
  const result = render(
    <Provider store={store}>
      <Sidebar view="terminal" onNavigate={onNavigate} />
    </Provider>,
  )
  return { ...result, onNavigate }
}

describe('sidebar agent filter flow (e2e)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    _resetSessionWindowThunkState()
    vi.mocked(mockSearchSessions).mockReset()
    vi.mocked(mockFetchSnapshot).mockReset()
    vi.mocked(mockFetchSnapshot).mockResolvedValue({
      projects: [],
      totalSessions: 0,
      oldestIncludedTimestamp: 0,
      oldestIncludedSessionId: '',
      hasMore: false,
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    _resetSessionWindowThunkState()
  })

  const browseProjects: ProjectGroup[] = [
    {
      projectPath: '/home/user/repo-alpha',
      sessions: [
        {
          provider: 'claude',
          sessionId: 'session-alpha-claude',
          projectPath: '/home/user/repo-alpha',
          lastActivityAt: 3_000,
          title: 'Alpha claude session',
        },
        {
          provider: 'codex',
          sessionId: 'session-alpha-codex',
          projectPath: '/home/user/repo-alpha',
          lastActivityAt: 2_000,
          title: 'Alpha codex session',
        },
      ],
    },
    {
      projectPath: '/home/user/repo-beta',
      sessions: [
        {
          provider: 'codex',
          sessionId: 'session-beta-codex',
          projectPath: '/home/user/repo-beta',
          lastActivityAt: 1_000,
          title: 'Beta codex session',
        },
      ],
    },
  ]

  function createBrowseStore() {
    vi.mocked(mockFetchSnapshot).mockResolvedValue({
      projects: browseProjects,
      totalSessions: 3,
      oldestIncludedTimestamp: 1_000,
      oldestIncludedSessionId: 'codex:session-beta-codex',
      hasMore: false,
    })
    return createStore({
      projects: browseProjects,
      sessions: {
        activeSurface: 'sidebar',
        projects: browseProjects,
        lastLoadedAt: 1_000,
        windows: {
          sidebar: {
            projects: browseProjects,
            lastLoadedAt: 1_000,
            query: '',
            searchTier: 'title',
            appliedQuery: '',
            appliedSearchTier: 'title',
            loading: false,
            hasMore: false,
            oldestLoadedTimestamp: 1_000,
            oldestLoadedSessionId: 'codex:session-beta-codex',
          },
        },
      },
    })
  }

  it('agent dropdown filters browse results and the clear-x restores them', async () => {
    const store = createBrowseStore()
    renderSidebar(store)
    await act(() => vi.advanceTimersByTime(100))

    expect(screen.getByText('Alpha claude session')).toBeInTheDocument()
    expect(screen.getByText('Alpha codex session')).toBeInTheDocument()

    const select = screen.getByRole('combobox', { name: /agent filter/i }) as HTMLSelectElement
    expect(select).toHaveValue('all')
    // No extensions registry in this store -> capitalized fallback labels.
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      'All agents',
      'Claude',
      'Codex',
    ])
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      'all',
      'claude',
      'codex',
    ])

    fireEvent.change(select, { target: { value: 'codex' } })
    expect(screen.getByText('Alpha codex session')).toBeInTheDocument()
    expect(screen.getByText('Beta codex session')).toBeInTheDocument()
    expect(screen.queryByText('Alpha claude session')).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Clear agent filter'))
    expect(select).toHaveValue('all')
    expect(screen.getByText('Alpha claude session')).toBeInTheDocument()
  })

  it('agent filter ANDs with the repo filter and a committed server search', async () => {
    const store = createBrowseStore()
    vi.mocked(mockSearchSessions).mockResolvedValue({
      results: [
        {
          provider: 'claude',
          sessionId: 'session-alpha-claude',
          projectPath: '/home/user/repo-alpha',
          title: 'Alpha claude deploy notes',
          lastActivityAt: 3_000,
          archived: false,
        },
        {
          provider: 'codex',
          sessionId: 'session-alpha-codex',
          projectPath: '/home/user/repo-alpha',
          title: 'Alpha codex deploy notes',
          lastActivityAt: 2_000,
          archived: false,
        },
        {
          provider: 'codex',
          sessionId: 'session-beta-codex',
          projectPath: '/home/user/repo-beta',
          title: 'Beta codex deploy notes',
          lastActivityAt: 1_000,
          archived: false,
        },
      ],
      tier: 'title',
      query: 'deploy',
      totalScanned: 3,
    })
    renderSidebar(store)
    await act(() => vi.advanceTimersByTime(100))

    fireEvent.change(screen.getByRole('combobox', { name: /repo filter/i }), {
      target: { value: '/home/user/repo-alpha' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: /agent filter/i }), {
      target: { value: 'codex' },
    })
    fireEvent.change(screen.getByPlaceholderText('Search...'), {
      target: { value: 'deploy' },
    })
    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })

    // All three filters AND: only the alpha-repo codex search hit survives.
    expect(screen.getByText('Alpha codex deploy notes')).toBeInTheDocument()
    expect(screen.queryByText('Alpha claude deploy notes')).not.toBeInTheDocument()
    expect(screen.queryByText('Beta codex deploy notes')).not.toBeInTheDocument()

    // Both selections survive the search commit.
    expect(screen.getByRole('combobox', { name: /agent filter/i })).toHaveValue('codex')
    expect(screen.getByRole('combobox', { name: /repo filter/i })).toHaveValue('/home/user/repo-alpha')
  })
})
