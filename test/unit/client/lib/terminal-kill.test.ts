import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveTerminalKillFence, sendTerminalKill } from '@/lib/terminal-kill'
import {
  consumeTerminalReleaseMark,
  resetTerminalReleaseMarks,
} from '@/lib/terminal-release-marks'
import { configureStore } from '@reduxjs/toolkit'
import freshAgentReducer, { applyRuntimeOwner } from '@/store/freshAgentSlice'

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({ send: mockSend }),
}))

describe('sendTerminalKill', () => {
  beforeEach(() => {
    mockSend.mockClear()
    resetTerminalReleaseMarks()
  })

  // b8ke ext r20 F2: the PRODUCTION shape is FENCED — the production
  // senders resolve the session-owner fence and pass the observed
  // (epoch, generation) pair, so a reconnect-queued stale kill is
  // typed-refused by the server instead of killing a newer owner
  // (pre-r20 the helper could only send the unfenced frame).
  it('sends the terminal.kill message with the caller-resolved observed fence (the production shape)', () => {
    sendTerminalKill('term-1', { observedEpoch: 12, observedGeneration: 34 })
    expect(mockSend).toHaveBeenCalledWith({
      type: 'terminal.kill',
      terminalId: 'term-1',
      observedEpoch: 12,
      observedGeneration: 34,
    })
  })

  it('sends the plain unfenced frame when no fence is supplied (the no-owner-record kill)', () => {
    sendTerminalKill('term-1')
    expect(mockSend).toHaveBeenCalledWith({ type: 'terminal.kill', terminalId: 'term-1' })
  })

  it('marks the terminal released before sending', () => {
    sendTerminalKill('term-1')
    expect(consumeTerminalReleaseMark('term-1')).toBe(true)
  })
})

describe('resolveTerminalKillFence (b8ke ext r20 F2)', () => {
  it('resolves the observed pair from the runtimeOwners record (undefined when no record)', () => {
    const store = configureStore({ reducer: { freshAgent: freshAgentReducer } })
    expect(resolveTerminalKillFence(store, {
      provider: 'codex',
      sessionRef: { provider: 'codex', sessionId: 'ses-1' },
    })).toBeUndefined()
    store.dispatch(applyRuntimeOwner({
      type: 'session.runtimeOwner',
      provider: 'codex',
      sessionId: 'ses-1',
      epoch: 12,
      generation: 34,
      ownerKind: 'terminal',
      operationId: 'handoff-1',
      transition: 'handoff-committed',
    }))
    expect(resolveTerminalKillFence(store, {
      provider: 'codex',
      sessionRef: { provider: 'codex', sessionId: 'ses-1' },
    })).toEqual({ observedEpoch: 12, observedGeneration: 34 })
  })

  it('a newer-generation record is what the next kill would carry (the reconnect discipline)', () => {
    const store = configureStore({ reducer: { freshAgent: freshAgentReducer } })
    store.dispatch(applyRuntimeOwner({
      type: 'session.runtimeOwner',
      provider: 'codex',
      sessionId: 'ses-2',
      epoch: 5,
      generation: 34,
      ownerKind: 'terminal',
      operationId: 'op-1',
      transition: 'handoff-committed',
    }))
    expect(resolveTerminalKillFence(store, {
      provider: 'codex',
      sessionRef: { provider: 'codex', sessionId: 'ses-2' },
    })).toEqual({ observedEpoch: 5, observedGeneration: 34 })
  })
})
