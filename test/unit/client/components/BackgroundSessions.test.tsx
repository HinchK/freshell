import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import BackgroundSessions from '../../../../src/components/BackgroundSessions'
import tabsReducer from '../../../../src/store/tabsSlice'
import panesReducer from '../../../../src/store/panesSlice'
import settingsReducer from '../../../../src/store/settingsSlice'
import terminalDirectoryReducer from '../../../../src/store/terminalDirectorySlice'

const sentMessages: any[] = []
const mockGetTerminalDirectoryPage = vi.fn()

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    connect: () => Promise.resolve(),
    send: (msg: any) => {
      sentMessages.push(msg)
    },
    onMessage: () => () => {},
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getTerminalDirectoryPage: (...args: any[]) => mockGetTerminalDirectoryPage(...args),
  }
})

function makeStore() {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      terminalDirectory: terminalDirectoryReducer,
    },
  })
}

describe('BackgroundSessions', () => {
  beforeEach(() => {
    sentMessages.length = 0
    mockGetTerminalDirectoryPage.mockReset()
    mockGetTerminalDirectoryPage.mockResolvedValue({
      items: [
        {
          terminalId: 'term-codex-1',
          title: 'Codex',
          mode: 'codex',
          sessionRef: {
            provider: 'codex',
            sessionId: 'codex-sess-abc',
          },
          createdAt: Date.now() - 60000,
          lastActivityAt: Date.now() - 30000,
          status: 'running',
          hasClients: false,
        },
      ],
      nextCursor: null,
      revision: 1,
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('attaches with the real terminal mode, not hardcoded shell', async () => {
    const store = makeStore()
    const user = userEvent.setup()

    render(
      <Provider store={store}>
        <BackgroundSessions />
      </Provider>
    )

    // Wait for the list to load and render.
    const attachBtn = await screen.findByRole('button', { name: 'Attach' })
    await user.click(attachBtn)

    const tabs = store.getState().tabs.tabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0].mode).toBe('codex')
    expect(tabs[0].sessionRef).toEqual({
      provider: 'codex',
      sessionId: 'codex-sess-abc',
    })
    // terminalId is in pane content, not on the tab
    const layout = store.getState().panes.layouts[tabs[0].id]
    expect(layout).toBeDefined()
    expect(layout.type).toBe('leaf')
    if (layout.type === 'leaf') {
      expect(layout.content.kind).toBe('terminal')
      if (layout.content.kind === 'terminal') {
        expect(layout.content.terminalId).toBe('term-codex-1')
        expect(layout.content.sessionRef).toEqual({
          provider: 'codex',
          sessionId: 'codex-sess-abc',
        })
      }
    }
  })

  it('preserves the provider cwd when opening a running Claude background session', async () => {
    mockGetTerminalDirectoryPage.mockResolvedValue({
      items: [
        {
          terminalId: 'term-live-claude',
          title: 'Claude',
          mode: 'claude',
          cwd: '/home/user/live-project',
          sessionRef: {
            provider: 'claude',
            sessionId: '550e8400-e29b-41d4-a716-446655440000',
          },
          createdAt: Date.now() - 60000,
          lastActivityAt: Date.now() - 30000,
          status: 'running',
          hasClients: false,
        },
      ],
      nextCursor: null,
      revision: 2,
    })
    const store = makeStore()
    const user = userEvent.setup()

    render(
      <Provider store={store}>
        <BackgroundSessions />
      </Provider>
    )

    const attachBtn = await screen.findByRole('button', { name: 'Attach' })
    await user.click(attachBtn)

    const [tab] = store.getState().tabs.tabs
    expect(tab.initialCwd).toBe('/home/user/live-project')
    const layout = store.getState().panes.layouts[tab.id]
    expect(layout).toBeDefined()
    expect(layout.type).toBe('leaf')
    if (layout.type === 'leaf') {
      expect(layout.content.kind).toBe('terminal')
      if (layout.content.kind === 'terminal') {
        expect(layout.content).toMatchObject({
          kind: 'terminal',
          mode: 'claude',
          initialCwd: '/home/user/live-project',
          sessionRef: {
            provider: 'claude',
            sessionId: '550e8400-e29b-41d4-a716-446655440000',
          },
        })
      }
    }
  })
})
