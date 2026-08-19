import { describe, it, expect, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { settingsSlice, updateSettingsLocal } from '../../../src/store/settingsSlice'
import { subagentInterestMiddleware } from '../../../src/store/subagentInterestMiddleware'

const { mockSend, reconnectHandlers } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  reconnectHandlers: [] as Array<() => void>,
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: mockSend,
    onReconnect: (h: () => void) => {
      reconnectHandlers.push(h)
    },
  }),
}))

function makeStore() {
  return configureStore({
    reducer: { settings: settingsSlice.reducer },
    middleware: (g) => g().concat(subagentInterestMiddleware),
  })
}

describe('subagentInterestMiddleware', () => {
  it('sends sessions.prefs on the first observed action and on toggle changes', () => {
    mockSend.mockClear()
    const store = makeStore()
    store.dispatch({ type: 'any/action' })
    expect(mockSend).toHaveBeenCalledWith({ type: 'sessions.prefs', includeSubagents: false })
    mockSend.mockClear()

    store.dispatch(updateSettingsLocal({ sidebar: { showSubagents: true } }))
    expect(mockSend).toHaveBeenCalledWith({ type: 'sessions.prefs', includeSubagents: true })
    mockSend.mockClear()

    store.dispatch(updateSettingsLocal({ sidebar: { showSubagents: false } }))
    expect(mockSend).toHaveBeenCalledWith({ type: 'sessions.prefs', includeSubagents: false })
  })

  it('re-sends current preference after a WS reconnect', () => {
    mockSend.mockClear()
    reconnectHandlers.length = 0
    const store = makeStore()
    store.dispatch(updateSettingsLocal({ sidebar: { showSubagents: true } }))
    mockSend.mockClear()
    for (const h of reconnectHandlers) h()
    expect(mockSend).toHaveBeenCalledWith({ type: 'sessions.prefs', includeSubagents: true })
  })
})
