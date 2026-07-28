import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import TabBar from '@/components/TabBar'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import repoIconsReducer from '@/store/repoIconsSlice'
import terminalMetaReducer from '@/store/terminalMetaSlice'
import codexActivityReducer from '@/store/codexActivitySlice'
import opencodeActivityReducer from '@/store/opencodeActivitySlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({ state: 'ready', send: vi.fn() }),
}))

const apiGet = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}))

// NOTE: PaneIcon and lucide-react are NOT mocked here on purpose — this is the
// integration proof. If lucide imports crash jsdom in this suite, mirror the
// exhaustive lucide mock from TabBar.test.tsx, but keep RepoIcon REAL.

function makeStore() {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      repoIcons: repoIconsReducer,
      terminalMeta: terminalMetaReducer,
      codexActivity: codexActivityReducer,
      opencodeActivity: opencodeActivityReducer,
      turnCompletion: turnCompletionReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [
          {
            id: 'tab-1',
            title: 'Agent Tab',
            mode: 'claude',
            status: 'running',
            createRequestId: 'req-1',
            createdAt: 1,
            initialCwd: '/home/u/myrepo',
          },
        ],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
      },
      panes: {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'claude',
              createRequestId: 'req-1',
              status: 'running',
              initialCwd: '/home/u/myrepo',
            },
          },
        },
        activePane: {},
        paneTitles: {},
      },
    } as any,
  })
}

describe('repo icon tab flow', () => {
  beforeEach(() => {
    apiGet.mockReset()
  })

  it('probes the meta endpoint and renders the server icon image on the tab', async () => {
    apiGet.mockResolvedValue({
      repoRoot: '/home/u/myrepo',
      checkoutRoot: '/home/u/myrepo',
      repoName: 'myrepo',
      hasIcon: true,
    })
    render(
      <Provider store={makeStore()}>
        <TabBar />
      </Provider>,
    )
    await waitFor(() => {
      const img = document.querySelector('img[src^="/api/repo-icon?cwd="]')
      expect(img).toBeTruthy()
    })
    expect(apiGet).toHaveBeenCalledWith(
      `/api/repo-icon/meta?cwd=${encodeURIComponent('/home/u/myrepo')}`,
    )
    expect(apiGet).toHaveBeenCalledTimes(1) // once per distinct repo, remembered in Redux
  })

  it('falls back to the letter avatar when the endpoint is absent (Node dev server)', async () => {
    apiGet.mockRejectedValue(new Error('404 Not Found'))
    render(
      <Provider store={makeStore()}>
        <TabBar />
      </Provider>,
    )
    await waitFor(() => {
      expect(screen.getByText('M')).toBeTruthy() // 'myrepo' -> 'M'
    })
    expect(document.querySelector('img[src^="/api/repo-icon"]')).toBeNull()
  })
})
