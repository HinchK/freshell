import { describe, expect, it } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import freshAgentReducer from '@/store/freshAgentSlice'
import { handleFreshAgentMessage } from '@/lib/fresh-agent-ws'

describe('fresh-agent websocket public contract', () => {
  it('removes a session when the fresh-agent killed acknowledgement arrives', () => {
    const store = configureStore({
      reducer: { freshAgent: freshAgentReducer },
    })

    handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId: 'thread-1',
      sessionType: 'freshcodex',
      provider: 'codex',
      event: {
        type: 'freshAgent.session.snapshot',
        sessionId: 'thread-1',
        latestTurnId: null,
        status: 'idle',
        revision: 1,
      },
    })

    expect(handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.killed',
      sessionId: 'thread-1',
      sessionType: 'freshcodex',
      provider: 'codex',
      success: true,
    })).toBe(true)
    expect(store.getState().freshAgent.sessions['freshcodex:codex:thread-1']).toBeUndefined()
  })
})
