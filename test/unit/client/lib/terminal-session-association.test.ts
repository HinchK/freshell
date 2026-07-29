import { describe, expect, it, vi } from 'vitest'
import { reconcileTerminalSessionAssociation } from '@/lib/terminal-session-association'
import { reconcileTerminalSessionRefByTerminalId } from '@/store/panesSlice'
import { flushPersistedLayoutNow } from '@/store/persistControl'

function createState(content: Record<string, unknown>) {
  return {
    panes: {
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content,
        },
      },
    },
    tabs: {
      tabs: [{
        id: 'tab-1',
        title: 'Tab 1',
        status: 'running',
      }],
    },
  } as any
}

function makeStateWithTerminalPane({
  terminalId,
  sessionRef,
}: {
  terminalId: string
  sessionRef: { provider: string; sessionId: string }
}) {
  const dispatch = vi.fn()
  const getState = () => createState({
    kind: 'terminal',
    terminalId,
    createRequestId: 'req-1',
    status: 'running',
    mode: 'codex',
    shell: 'system',
    sessionRef,
  })
  return { dispatch, getState }
}

describe('terminal-session-association', () => {
  it('returns conflict and refuses to overwrite an existing canonical sessionRef', () => {
    const dispatch = vi.fn()
    const result = reconcileTerminalSessionAssociation({
      dispatch,
      getState: () => createState({
        kind: 'terminal',
        terminalId: 'term-1',
        createRequestId: 'req-1',
        status: 'running',
        mode: 'codex',
        shell: 'system',
        sessionRef: { provider: 'codex', sessionId: 'thread-new' },
      }),
      terminalId: 'term-1',
      sessionRef: { provider: 'codex', sessionId: 'thread-old' },
    })

    expect(result).toBe('conflict')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('reconciles matching canonical identity and clears legacy resumeSessionId', () => {
    const dispatch = vi.fn()
    const result = reconcileTerminalSessionAssociation({
      dispatch,
      getState: () => createState({
        kind: 'terminal',
        terminalId: 'term-1',
        createRequestId: 'req-1',
        status: 'running',
        mode: 'codex',
        shell: 'system',
        resumeSessionId: 'legacy-thread',
        sessionRef: { provider: 'codex', sessionId: 'thread-1' },
        codexDurability: {
          schemaVersion: 1,
          state: 'durable',
          durableThreadId: 'thread-1',
        },
      }),
      terminalId: 'term-1',
      sessionRef: { provider: 'codex', sessionId: 'thread-1' },
    })

    expect(result).toBe('reconciled')
    expect(dispatch).toHaveBeenCalled()
  })

  it('ignores unmatched panes cleanly', () => {
    const dispatch = vi.fn()
    const result = reconcileTerminalSessionAssociation({
      dispatch,
      getState: () => createState({
        kind: 'terminal',
        terminalId: 'term-2',
        createRequestId: 'req-1',
        status: 'running',
        mode: 'codex',
        shell: 'system',
      }),
      terminalId: 'term-1',
      sessionRef: { provider: 'codex', sessionId: 'thread-1' },
    })

    expect(result).toBe('ignored')
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('server-authoritative rebind (previousSessionId)', () => {
  it('rebinds when previousSessionId matches the pane current sessionRef', () => {
    // pane holds { provider: 'codex', sessionId: 'old-id' }
    const { dispatch, getState } = makeStateWithTerminalPane({
      terminalId: 't1',
      sessionRef: { provider: 'codex', sessionId: 'old-id' },
    })
    const result = reconcileTerminalSessionAssociation({
      dispatch,
      getState,
      terminalId: 't1',
      sessionRef: { provider: 'codex', sessionId: 'new-id' },
      previousSessionId: 'old-id',
    })
    expect(result).toBe('reconciled')
    expect(dispatch).toHaveBeenCalledWith(
      reconcileTerminalSessionRefByTerminalId({
        terminalId: 't1',
        sessionRef: { provider: 'codex', sessionId: 'new-id' },
      }),
    )
    expect(dispatch).toHaveBeenCalledWith(flushPersistedLayoutNow())
  })

  it('still conflicts when previousSessionId does NOT match the pane sessionRef', () => {
    const { dispatch, getState } = makeStateWithTerminalPane({
      terminalId: 't1',
      sessionRef: { provider: 'codex', sessionId: 'some-other-id' },
    })
    const result = reconcileTerminalSessionAssociation({
      dispatch,
      getState,
      terminalId: 't1',
      sessionRef: { provider: 'codex', sessionId: 'new-id' },
      previousSessionId: 'old-id',
    })
    expect(result).toBe('conflict')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('still conflicts when previousSessionId is absent (write-once preserved)', () => {
    const { dispatch, getState } = makeStateWithTerminalPane({
      terminalId: 't1',
      sessionRef: { provider: 'codex', sessionId: 'old-id' },
    })
    const result = reconcileTerminalSessionAssociation({
      dispatch,
      getState,
      terminalId: 't1',
      sessionRef: { provider: 'codex', sessionId: 'new-id' },
    })
    expect(result).toBe('conflict')
    expect(dispatch).not.toHaveBeenCalled()
  })
})
