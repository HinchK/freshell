import { describe, expect, it } from 'vitest'
import freshAgentReducer, { applyRuntimeOwner, type RuntimeOwnerRecord } from '@/store/freshAgentSlice'
import {
  canonicalPaneSession,
  derivePaneOwnerDivergence,
  selectOwnerFence,
  selectPaneOwnerDivergence,
  selectSessionRuntimeOwner,
} from '@/store/selectors/runtimeOwner'
import type { SessionRuntimeOwnerMessage } from '@shared/ws-protocol'
import type { RootState } from '@/store/store'

function stateWithRuntimeOwner(
  record: Partial<SessionRuntimeOwnerMessage> & { provider: string; sessionId: string },
): RootState {
  const frame: SessionRuntimeOwnerMessage = {
    type: 'session.runtimeOwner',
    epoch: 5,
    generation: 4,
    ownerKind: 'terminal',
    operationId: 'handoff-1',
    transition: 'handoff-committed',
    ...record,
  }
  const freshAgent = freshAgentReducer(undefined, applyRuntimeOwner(frame))
  return { freshAgent } as unknown as RootState
}

describe('selectPaneOwnerDivergence', () => {
  it('diverges a fresh-agent pane whose session is terminal-owned', () => {
    const state = stateWithRuntimeOwner({
      provider: 'codex',
      sessionId: 'sid-1',
      ownerKind: 'terminal',
      terminalId: 't-1',
      generation: 4,
    })
    expect(selectPaneOwnerDivergence(state, {
      paneKind: 'fresh-agent',
      provider: 'codex',
      sessionRef: { provider: 'codex', sessionId: 'sid-1' }, // sessionRef-only restored pane
    })).toEqual({
      ownerKind: 'terminal',
      terminalId: 't-1',
      generation: 4,
      transition: 'handoff-committed',
    })
  })

  it('returns null for same-kind owners (same-mode multi-device attachment)', () => {
    const state = stateWithRuntimeOwner({
      provider: 'codex',
      sessionId: 'sid-1',
      ownerKind: 'fresh-agent',
      generation: 4,
    })
    expect(selectPaneOwnerDivergence(state, {
      paneKind: 'fresh-agent',
      provider: 'codex',
      sessionRef: { provider: 'codex', sessionId: 'sid-1' },
    })).toBeNull()
  })

  it('returns null for vacant owners and absent records', () => {
    const vacant = stateWithRuntimeOwner({
      provider: 'codex',
      sessionId: 'sid-1',
      ownerKind: 'vacant',
      transition: 'released',
    })
    expect(selectPaneOwnerDivergence(vacant, {
      paneKind: 'fresh-agent',
      provider: 'codex',
      sessionRef: { provider: 'codex', sessionId: 'sid-1' },
    })).toBeNull()

    const empty = { freshAgent: { runtimeOwners: {} } } as unknown as RootState
    expect(selectPaneOwnerDivergence(empty, {
      paneKind: 'fresh-agent',
      provider: 'codex',
      sessionRef: { provider: 'codex', sessionId: 'sid-1' },
    })).toBeNull()
  })

  it('keys on sessionRef.sessionId when content.sessionId is absent', () => {
    const state = stateWithRuntimeOwner({
      provider: 'opencode',
      sessionId: 'ses-1',
      ownerKind: 'terminal',
      terminalId: 't-2',
      generation: 2,
    })
    expect(selectPaneOwnerDivergence(state, {
      paneKind: 'fresh-agent',
      provider: 'opencode',
      sessionRef: { provider: 'opencode', sessionId: 'ses-1' },
      sessionId: undefined,
    })).toEqual({
      ownerKind: 'terminal',
      terminalId: 't-2',
      generation: 2,
      transition: 'handoff-committed',
    })
  })

  it('falls back to the pane-level sessionId when no sessionRef exists', () => {
    const state = stateWithRuntimeOwner({
      provider: 'codex',
      sessionId: 'sid-direct',
      ownerKind: 'terminal',
      terminalId: 't-3',
      generation: 8,
    })
    expect(selectPaneOwnerDivergence(state, {
      paneKind: 'fresh-agent',
      provider: 'codex',
      sessionId: 'sid-direct',
    })?.terminalId).toBe('t-3')
  })

  it('returns null for unrelated panes (no matching record)', () => {
    const state = stateWithRuntimeOwner({
      provider: 'codex',
      sessionId: 'sid-1',
      ownerKind: 'terminal',
      terminalId: 't-1',
      generation: 4,
    })
    expect(selectPaneOwnerDivergence(state, {
      paneKind: 'fresh-agent',
      provider: 'codex',
      sessionRef: { provider: 'codex', sessionId: 'sid-OTHER' },
    })).toBeNull()
  })

  it('diverges a TERMINAL pane whose session is fresh-agent-owned (both directions)', () => {
    // Round-1 review: the reverse direction — a terminal pane observing a
    // fresh-agent owner — is the same selector with paneKind 'terminal'.
    const state = stateWithRuntimeOwner({
      provider: 'codex',
      sessionId: 'sid-1',
      ownerKind: 'fresh-agent',
      generation: 6,
    })
    expect(selectPaneOwnerDivergence(state, {
      paneKind: 'terminal',
      provider: 'codex',
      sessionRef: { provider: 'codex', sessionId: 'sid-1' },
    })).toEqual({
      ownerKind: 'fresh-agent',
      generation: 6,
      transition: 'handoff-committed',
    })
  })

  it('retains the transition state — handoff-started is not a live target (round-3 F15)', () => {
    const state = stateWithRuntimeOwner({
      provider: 'codex',
      sessionId: 'sid-1',
      ownerKind: 'terminal',
      transition: 'handoff-started',
      previousKind: 'fresh-agent',
      generation: 9,
    })
    const divergence = selectPaneOwnerDivergence(state, {
      paneKind: 'fresh-agent',
      provider: 'codex',
      sessionRef: { provider: 'codex', sessionId: 'sid-1' },
    })
    expect(divergence?.transition).toBe('handoff-started')
    expect(divergence?.terminalId).toBeUndefined()
  })
})

describe('selectSessionRuntimeOwner and fence helpers', () => {
  it('selectSessionRuntimeOwner returns the record keyed by provider:sessionId', () => {
    const state = stateWithRuntimeOwner({
      provider: 'codex',
      sessionId: 'sid-1',
      ownerKind: 'fresh-agent',
      epoch: 7,
      generation: 3,
    })
    const record: RuntimeOwnerRecord | undefined = selectSessionRuntimeOwner(state, 'codex', 'sid-1')
    expect(record).toMatchObject({ epoch: 7, generation: 3, ownerKind: 'fresh-agent' })
    expect(selectSessionRuntimeOwner(state, 'codex', 'missing')).toBeUndefined()
  })

  it('selectOwnerFence returns the (epoch, generation) pair from the record', () => {
    const state = stateWithRuntimeOwner({
      provider: 'codex',
      sessionId: 'sid-1',
      ownerKind: 'fresh-agent',
      epoch: 7,
      generation: 3,
    })
    expect(selectOwnerFence(state, 'codex', 'sid-1')).toEqual({ epoch: 7, generation: 3 })
    expect(selectOwnerFence(state, 'codex', 'missing')).toBeUndefined()
  })

  it('canonicalPaneSession prefers sessionRef.sessionId and falls back to sessionId', () => {
    expect(canonicalPaneSession({
      provider: 'codex',
      sessionRef: { provider: 'codex', sessionId: 'sid-ref' },
      sessionId: 'sid-content',
    })).toEqual({ provider: 'codex', sessionId: 'sid-ref' })
    expect(canonicalPaneSession({ provider: 'codex', sessionId: 'sid-content' })).toEqual({
      provider: 'codex',
      sessionId: 'sid-content',
    })
    expect(canonicalPaneSession({ provider: 'codex' })).toBeUndefined()
    expect(canonicalPaneSession({})).toBeUndefined()
  })

  it('derivePaneOwnerDivergence is null without a record (component-safe local derivation)', () => {
    expect(derivePaneOwnerDivergence(undefined, 'fresh-agent')).toBeNull()
    const record: RuntimeOwnerRecord = {
      provider: 'codex',
      sessionId: 'sid-1',
      epoch: 1,
      generation: 1,
      ownerKind: 'fresh-agent',
      transition: 'handoff-committed',
      updatedAt: Date.now(),
    }
    expect(derivePaneOwnerDivergence(record, 'fresh-agent')).toBeNull()
    expect(derivePaneOwnerDivergence({ ...record, ownerKind: 'terminal', terminalId: 't-1' }, 'fresh-agent'))
      .toEqual({ ownerKind: 'terminal', terminalId: 't-1', generation: 1, transition: 'handoff-committed' })
  })
})
