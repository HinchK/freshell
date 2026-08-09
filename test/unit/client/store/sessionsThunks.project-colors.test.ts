// SESSION-05 (project colors): cross-context color CHANGE propagation.
// The store's merge path (append pagination, search pagination, silent
// background refresh merging over a deeper window) used to adopt a project
// color only when the existing group had none (`if (project.color &&
// !current.color)`) — fine when colors could only ever go unset→set, broken
// for "browser A recolors, browser B's already-colored group updates". The
// incoming page is server-authoritative, so an incoming color now WINS.
import { configureStore } from '@reduxjs/toolkit'
import { enableMapSet } from 'immer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import sessionsReducer, { setActiveSessionSurface } from '@/store/sessionsSlice'
import {
  fetchSessionWindow,
  _resetSessionWindowThunkState,
} from '@/store/sessionsThunks'

const fetchSidebarSessionsSnapshot = vi.fn() as any
const searchSessions = vi.fn() as any

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    fetchSidebarSessionsSnapshot: (...args: any[]) => fetchSidebarSessionsSnapshot(...args),
    searchSessions: (...args: any[]) => searchSessions(...args),
  }
})

enableMapSet()

function createStore(preloadedSessions?: Record<string, unknown>) {
  return configureStore({
    reducer: { sessions: sessionsReducer },
    ...(preloadedSessions ? {
      preloadedState: {
        sessions: {
          ...sessionsReducer(undefined, { type: '@@INIT' }),
          ...preloadedSessions,
        },
      },
    } : {}),
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({ serializableCheck: false }),
  })
}

function session(id: string, projectPath: string, lastActivityAt: number) {
  return {
    provider: 'claude',
    sessionId: id,
    projectPath,
    lastActivityAt,
    title: id,
  }
}

function projectGroup(projectPath: string, sessions: any[], color?: string) {
  return {
    projectPath,
    sessions,
    ...(color ? { color } : {}),
  }
}

describe('sessionsThunks project color merge (SESSION-05)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetSessionWindowThunkState()
  })

  afterEach(() => {
    _resetSessionWindowThunkState()
  })

  it('an incoming color on a seen project replaces the prior color (append merge)', async () => {
    // Page 1: the project, already colored '#111111' (a prior fetch set it).
    fetchSidebarSessionsSnapshot.mockResolvedValueOnce({
      projects: [projectGroup('/tmp/project-alpha', [session('alpha-new', '/tmp/project-alpha', 2_000)], '#111111')],
      totalSessions: 2,
      oldestIncludedTimestamp: 2_000,
      oldestIncludedSessionId: 'claude:alpha-new',
      hasMore: true,
    })
    // Page 2 (older sessions, SAME project): the color was since changed to
    // '#222222' (a DIFFERENT browser did it — the fetch is the only channel).
    fetchSidebarSessionsSnapshot.mockResolvedValueOnce({
      projects: [projectGroup('/tmp/project-alpha', [session('alpha-old', '/tmp/project-alpha', 1_000)], '#222222')],
      totalSessions: 2,
      oldestIncludedTimestamp: 1_000,
      oldestIncludedSessionId: 'claude:alpha-old',
      hasMore: false,
    })

    const store = createStore()
    store.dispatch(setActiveSessionSurface('sidebar'))

    await store.dispatch(fetchSessionWindow({ surface: 'sidebar', priority: 'visible' }) as any)
    expect(store.getState().sessions.windows.sidebar.projects[0].color).toBe('#111111')

    await store.dispatch(fetchSessionWindow({ surface: 'sidebar', priority: 'visible', append: true }) as any)
    const merged = store.getState().sessions.windows.sidebar.projects
      .find((p: any) => p.projectPath === '/tmp/project-alpha')
    expect(merged.sessions.map((s: any) => s.sessionId).sort()).toEqual(['alpha-new', 'alpha-old'])
    expect(merged.color).toBe('#222222')
  })

  it('an incoming color still fills an uncolored group (unset → set)', async () => {
    fetchSidebarSessionsSnapshot.mockResolvedValueOnce({
      projects: [projectGroup('/tmp/project-alpha', [session('alpha-new', '/tmp/project-alpha', 2_000)])],
      totalSessions: 2,
      oldestIncludedTimestamp: 2_000,
      oldestIncludedSessionId: 'claude:alpha-new',
      hasMore: true,
    })
    fetchSidebarSessionsSnapshot.mockResolvedValueOnce({
      projects: [projectGroup('/tmp/project-alpha', [session('alpha-old', '/tmp/project-alpha', 1_000)], '#333333')],
      totalSessions: 2,
      oldestIncludedTimestamp: 1_000,
      oldestIncludedSessionId: 'claude:alpha-old',
      hasMore: false,
    })

    const store = createStore()
    store.dispatch(setActiveSessionSurface('sidebar'))

    await store.dispatch(fetchSessionWindow({ surface: 'sidebar', priority: 'visible' }) as any)
    await store.dispatch(fetchSessionWindow({ surface: 'sidebar', priority: 'visible', append: true }) as any)

    const merged = store.getState().sessions.windows.sidebar.projects
      .find((p: any) => p.projectPath === '/tmp/project-alpha')
    expect(merged.color).toBe('#333333')
  })

  it('search windows carry the page colors through buildSearchPayload', async () => {
    searchSessions.mockResolvedValueOnce({
      results: [
        {
          sessionId: 'alpha-1',
          provider: 'claude',
          projectPath: '/tmp/project-alpha',
          title: 'needle hit',
          matchedIn: 'title',
          lastActivityAt: 1_000,
          isRunning: false,
        },
      ],
      tier: 'title',
      query: 'needle',
      totalScanned: 1,
      nextCursor: null,
      hasMore: false,
      projectColors: { '/tmp/project-alpha': '#aa00ff' },
    })

    const store = createStore()
    store.dispatch(setActiveSessionSurface('history'))

    await store.dispatch(fetchSessionWindow({
      surface: 'history',
      priority: 'visible',
      query: 'needle',
      searchTier: 'title',
    }) as any)

    const projects = store.getState().sessions.windows.history.projects
    expect(projects).toHaveLength(1)
    expect(projects[0].projectPath).toBe('/tmp/project-alpha')
    expect(projects[0].color).toBe('#aa00ff')
  })
})
