// SESSION-05 (project colors, render half): pins the legacy color treatment
// on History project headers — the swatch at the left of the header renders
// `project.color` (falling back to the legacy default `#6b7280`), an
// expanded project exposes the accessible color-picker row, and picking a
// color issues the `PUT /api/project-colors` write. The data channel that
// populates `project.color` (page `projectColors` → overlay → store) is
// covered in `test/unit/client/lib/api.project-colors.test.ts` and
// `test/unit/client/store/sessionsThunks.project-colors.test.ts`; this file
// pins the rendering contract those channels feed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'

import HistoryView from '@/components/HistoryView'
import sessionsReducer from '@/store/sessionsSlice'
import tabsReducer from '@/store/tabsSlice'
import { api } from '@/lib/api'

// HistoryView calls into api helpers for refresh/rename/delete/color; keep
// tests isolated (same convention as HistoryView.a11y.test.tsx).
// Spread the real module so pure named exports (e.g. isApiUnauthorizedError,
// consumed by fetchSessionWindow's rejection handler) stay live; `api` stays
// fully stubbed, and the thunk's direct network entry points are stubbed
// benignly so no real fetch escapes.
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    api: {
      get: vi.fn().mockResolvedValue([]),
      put: vi.fn().mockResolvedValue({}),
      patch: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    fetchSidebarSessionsSnapshot: vi.fn().mockResolvedValue({
      projects: [],
      totalSessions: 0,
      oldestIncludedTimestamp: 0,
      oldestIncludedSessionId: '',
      hasMore: false,
    }),
    searchSessions: vi.fn().mockResolvedValue({ results: [], hasMore: false }),
  }
})

const COLORED_PATH = '/repo/colored'
const PLAIN_PATH = '/repo/plain'
const LEGACY_DEFAULT_COLOR = '#6b7280'

function buildStore(expandedPaths: string[] = []) {
  return configureStore({
    reducer: {
      sessions: sessionsReducer,
      tabs: tabsReducer,
    },
    middleware: (getDefault) =>
      getDefault({
        serializableCheck: {
          ignoredPaths: ['sessions.expandedProjects'],
        },
      }),
    preloadedState: {
      sessions: {
        projects: [
          {
            projectPath: COLORED_PATH,
            color: '#ff8800',
            sessions: [
              {
                provider: 'claude',
                sessionId: 'session-colored',
                projectPath: COLORED_PATH,
                lastActivityAt: Date.now(),
                title: 'Colored session',
              },
            ],
          },
          {
            projectPath: PLAIN_PATH,
            sessions: [
              {
                provider: 'claude',
                sessionId: 'session-plain',
                projectPath: PLAIN_PATH,
                lastActivityAt: Date.now() - 60_000,
                title: 'Plain session',
              },
            ],
          },
        ],
        expandedProjects: new Set(expandedPaths),
      },
      tabs: { tabs: [], activeTabId: null },
    } as any,
  })
}

function headerSwatch(container: HTMLElement, projectPath: string): HTMLElement {
  const header = container.querySelector(`[data-project-path="${projectPath}"]`)
  expect(header, `project header for ${projectPath}`).not.toBeNull()
  const swatch = header!.querySelector('div[style*="background-color"]') as HTMLElement | null
  expect(swatch, `color swatch inside the ${projectPath} header`).not.toBeNull()
  return swatch!
}

describe('HistoryView project color treatment (SESSION-05)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders the configured color on the header swatch and the default gray elsewhere', () => {
    const { container } = render(
      <Provider store={buildStore()}>
        <HistoryView />
      </Provider>,
    )

    expect(headerSwatch(container, COLORED_PATH).style.backgroundColor).toBe('rgb(255, 136, 0)')
    expect(headerSwatch(container, PLAIN_PATH).style.backgroundColor).toBe('rgb(107, 114, 128)')
  })

  it('an expanded project exposes the accessible color picker row', () => {
    render(
      <Provider store={buildStore([COLORED_PATH])}>
        <HistoryView />
      </Provider>,
    )

    // The expanded area shows the "Color:" row with an accessible opener…
    const opener = screen.getByRole('button', { name: 'Open color picker' })
    expect(opener.style.backgroundColor).toBe('rgb(255, 136, 0)')

    // …which reveals the actual color input with its own accessible name.
    expect(screen.queryByRole('button', { name: 'Open color picker' })).toBeTruthy()
    fireEvent.click(opener)
    const input = screen.getByLabelText('Project color picker') as HTMLInputElement
    expect(input.value).toBe('#ff8800')
  })

  it('picking a color writes it via PUT /api/project-colors for that project', () => {
    render(
      <Provider store={buildStore([PLAIN_PATH])}>
        <HistoryView />
      </Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open color picker' }))
    const input = screen.getByLabelText('Project color picker') as HTMLInputElement
    fireEvent.change(input, { target: { value: '#123456' } })

    expect(api.put).toHaveBeenCalledWith('/api/project-colors', {
      projectPath: PLAIN_PATH,
      color: '#123456',
    })
  })

  it('an uncolored project starts the picker at the legacy default color', () => {
    render(
      <Provider store={buildStore([PLAIN_PATH])}>
        <HistoryView />
      </Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open color picker' }))
    const input = screen.getByLabelText('Project color picker') as HTMLInputElement
    expect(input.value).toBe(LEGACY_DEFAULT_COLOR)
  })
})
