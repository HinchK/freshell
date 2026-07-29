import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendMock = vi.fn()
vi.mock('@/lib/ws-client', () => ({ getWsClient: () => ({ send: sendMock }) }))

import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { setActiveTab } from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import settingsReducer from '@/store/settingsSlice'
import { executeDeckStop, focusTabFromDeck, sendDeckApproval } from '@/deck/deck-actions'
import { sendTerminalInterrupt } from '@/lib/terminal-interrupt'

beforeEach(() => sendMock.mockClear())

function makeStore(attention: Record<string, boolean> = {}) {
  return configureStore({
    reducer: { tabs: tabsReducer, panes: panesReducer, turnCompletion: turnCompletionReducer, settings: settingsReducer },
    preloadedState: {
      tabs: { tabs: [{ id: 't1', createRequestId: 'c1', title: 'a', status: 'running', mode: 'shell', createdAt: 1 }], activeTabId: null, renameRequestTabId: null, tombstones: [] },
      turnCompletion: { seq: 0, lastAtByTerminalId: {}, lastIdleAtByTerminalId: {}, pendingEvents: [], attentionByTab: attention, attentionByPane: {} },
    } as never,
  })
}

describe('focusTabFromDeck', () => {
  it('dismisses green then activates, matching a TabBar click', () => {
    const store = makeStore({ t1: true })
    focusTabFromDeck(store as never, 't1')
    const state = store.getState()
    expect(state.tabs.activeTabId).toBe('t1')
    expect(state.turnCompletion.attentionByTab.t1).toBeFalsy()
  })
})

describe('sendDeckApproval', () => {
  it('sends the allow decision WITHOUT updatedInput', () => {
    sendDeckApproval({ sessionId: 's1', sessionType: 'freshclaude', provider: 'claude', requestId: 'r1' })
    expect(sendMock).toHaveBeenCalledTimes(1)
    const frame = sendMock.mock.calls[0][0]
    expect(frame).toEqual({
      type: 'freshAgent.approval.respond',
      sessionId: 's1', sessionType: 'freshclaude', provider: 'claude',
      requestId: 'r1', decision: { behavior: 'allow' },
    })
    expect('updatedInput' in frame.decision).toBe(false)
    expect('cwd' in frame).toBe(false) // claude/codex/kilroy frames stay cwd-less
  })

  it('includes cwd for a freshopencode target (server auth keys embed it)', () => {
    sendDeckApproval({ sessionId: 'ses_1', sessionType: 'freshopencode', provider: 'opencode', requestId: 'r9', cwd: '/repo/a' })
    expect(sendMock.mock.calls[0][0]).toMatchObject({
      type: 'freshAgent.approval.respond',
      sessionId: 'ses_1', sessionType: 'freshopencode', provider: 'opencode',
      requestId: 'r9', cwd: '/repo/a', decision: { behavior: 'allow' },
    })
  })
})

describe('executeDeckStop', () => {
  const termContent = { kind: 'terminal', terminalId: 'term-1', createRequestId: 'c1', status: 'running', mode: 'shell' } as never

  it('fresh-agent target -> freshAgent.interrupt (never terminal input)', () => {
    executeDeckStop({ kind: 'fresh-agent', sessionId: 's1', sessionType: 'freshclaude', provider: 'claude' }, false)
    expect(sendMock).toHaveBeenCalledWith({
      type: 'freshAgent.interrupt', sessionId: 's1', sessionType: 'freshclaude', provider: 'claude',
    })
    expect('cwd' in sendMock.mock.calls[0][0]).toBe(false)
  })

  it('freshopencode target -> interrupt frame carries cwd', () => {
    executeDeckStop({ kind: 'fresh-agent', sessionId: 'ses_1', sessionType: 'freshopencode', provider: 'opencode', cwd: '/repo/a' }, false)
    expect(sendMock).toHaveBeenCalledWith({
      type: 'freshAgent.interrupt', sessionId: 'ses_1', sessionType: 'freshopencode', provider: 'opencode', cwd: '/repo/a',
    })
  })

  it('terminal target -> ESC first, Ctrl+C when escalating', () => {
    executeDeckStop({ kind: 'terminal', paneId: 'p1', terminalId: 'term-1', content: termContent }, false)
    expect(sendMock.mock.calls[0][0]).toMatchObject({ type: 'terminal.input', terminalId: 'term-1', data: '\x1b' })
    executeDeckStop({ kind: 'terminal', paneId: 'p1', terminalId: 'term-1', content: termContent }, true)
    expect(sendMock.mock.calls[1][0]).toMatchObject({ type: 'terminal.input', terminalId: 'term-1', data: '\x03' })
  })
})

describe('sendTerminalInterrupt', () => {
  it('uses buildTerminalInputMessage so expectedSessionRef is preserved when derivable', () => {
    sendTerminalInterrupt(
      { kind: 'terminal', terminalId: 'term-1', createRequestId: 'c1', status: 'running', mode: 'shell', serverInstanceId: 'srv-1' } as never,
      'term-1', 'esc',
    )
    const frame = sendMock.mock.calls[0][0]
    expect(frame.type).toBe('terminal.input')
    expect(frame.data).toBe('\x1b')
  })
})