import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import TabBar from '@/components/TabBar'
import tabsReducer, { openSessionTab, addTab } from '@/store/tabsSlice'
import panesReducer, { initLayout } from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import connectionReducer from '@/store/connectionSlice'
import extensionsReducer from '@/store/extensionsSlice'
import sessionNamesReducer, { receiveSessionNames } from '@/store/sessionNamesSlice'
import { selectTabDisplayTitles } from '@/store/selectors/sessionNameSelectors'
import type { SessionNameUpdate } from '@shared/session-names'

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({ send: vi.fn(), connect: vi.fn(), onMessage: vi.fn(() => () => {}), onReconnect: vi.fn(() => () => {}) }),
}))
vi.mock('@/lib/api', () => ({ api: { patch: vi.fn().mockResolvedValue({}) } }))
vi.mock('@/components/icons/PaneIcon', () => ({ default: () => <svg data-testid="pane-icon" /> }))

const SESS = '550e8400-e29b-41d4-a716-446655440000'

function createStore() {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      turnCompletion: turnCompletionReducer,
      connection: connectionReducer,
      extensions: extensionsReducer,
      sessionNames: sessionNamesReducer,
    },
    preloadedState: { settings: { settings: defaultSettings, loaded: true, lastSavedAt: null } } as never,
  })
}

function nameUpdate(name: string, revision: number, source: 'first_message' | 'manual'): SessionNameUpdate {
  return {
    record: {
      ref: { kind: 'session', provider: 'claude', sessionId: SESS },
      name,
      source,
      revision,
      ...(source === 'manual' ? { manualRevision: revision, renamedAt: 1_700_000_000_000 } : {}),
    },
    documentGeneration: revision,
    redirects: [],
    changed: true,
  }
}

describe('coding-agent naming flow (e2e)', () => {
  afterEach(() => cleanup())

  it('shows the dir name immediately, follows the canonical server name, keeps a shell sibling separate, and holds a manual rename against stale pushes', async () => {
    const store = createStore()
    const claudeTabId = () => store.getState().tabs.tabs.find((t) => t.mode === 'claude')!.id
    const shellTabId = () => store.getState().tabs.tabs.find((t) => t.id === 'tab-shell')!.id
    const displayed = () => {
      const titles = selectTabDisplayTitles(store.getState())
      return { claude: titles[claudeTabId()], shell: titles[shellTabId()] }
    }

    // A coding-agent (claude) terminal session opened from /home/dan/code/freshell.
    await act(async () => {
      await store.dispatch(openSessionTab({
        provider: 'claude',
        sessionId: SESS,
        cwd: '/home/dan/code/freshell',
        terminalId: 'term-claude',
        forceNew: true,
      }) as never)
    })
    // A sibling plain shell tab (scope guard: must keep its own name).
    act(() => {
      store.dispatch(addTab({ id: 'tab-shell', mode: 'shell', shell: 'wsl' }))
      store.dispatch(initLayout({ tabId: 'tab-shell', content: { kind: 'terminal', mode: 'shell', shell: 'wsl', terminalId: 'term-shell' } }))
    })

    render(<Provider store={store}><TabBar /></Provider>)

    // 1. Dir name shows immediately for the coding agent; the shell keeps a shell name.
    expect(displayed().claude).toBe('freshell')
    expect(displayed().shell).toBe('Shell')
    expect(screen.getAllByText('freshell').length).toBeGreaterThan(0)

    // 2. The server accepts the first-message name -> the tab follows it.
    act(() => {
      store.dispatch(receiveSessionNames([nameUpdate('Fix the login bug', 1, 'first_message')]))
    })
    expect(displayed().claude).toBe('Fix the login bug')
    expect(screen.getAllByText('Fix the login bug').length).toBeGreaterThan(0)
    expect(displayed().shell).toBe('Shell') // sibling untouched

    // 3. The user renames -> the server accepts a manual name -> it changes.
    act(() => {
      store.dispatch(receiveSessionNames([nameUpdate('My Project', 2, 'manual')]))
    })
    expect(displayed().claude).toBe('My Project')
    expect(screen.getAllByText('My Project').length).toBeGreaterThan(0)

    // 4. A late automatic push at a STALE revision never beats the manual name.
    act(() => {
      store.dispatch(receiveSessionNames([nameUpdate('Stale auto name', 1, 'first_message')]))
    })
    expect(displayed().claude).toBe('My Project')
    expect(screen.queryByText('Stale auto name')).not.toBeInTheDocument()
    expect(displayed().shell).toBe('Shell')
  })
})
