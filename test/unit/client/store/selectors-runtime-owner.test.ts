import { describe, expect, it } from 'vitest'
import freshAgentReducer, { applyRuntimeOwner, type RuntimeOwnerRecord } from '@/store/freshAgentSlice'
import {
  canonicalPaneSession,
  derivePaneOwnerDivergence,
  isLifecycleStartSuperseded,
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

  // b8ke focused round-3 R3-5: a FENCED record drives the typed recovery
  // state for EVERY pane kind holding the sessionRef — including the
  // SAME-kind pane (no live writer exists; the ownerKind names the fenced
  // prior). Pre-fix, a same-kind pane saw no divergence at all and kept
  // acting as the committed owner.
  it('diverges a fenced record for BOTH pane kinds with the typed reason', () => {
    // A fresh-agent pane whose fenced prior was ALSO fresh-agent (the
    // same-kind shape a fresh→fresh handoff leaves fenced).
    const state = stateWithRuntimeOwner({
      provider: 'claude',
      sessionId: 'sid-fenced',
      ownerKind: 'fresh-agent',
      transition: 'handoff-failed',
      reason: 'platform-limited',
      fenced: true,
      generation: 8,
    })
    const sameKind = selectPaneOwnerDivergence(state, {
      paneKind: 'fresh-agent',
      provider: 'claude',
      sessionRef: { provider: 'claude', sessionId: 'sid-fenced' },
    })
    expect(sameKind).toMatchObject({
      ownerKind: 'fresh-agent',
      transition: 'handoff-failed',
      generation: 8,
      fencedReason: 'platform-limited',
    })
    // The opposite-kind pane sees the same recovery state.
    const terminalPane = selectPaneOwnerDivergence(state, {
      paneKind: 'terminal',
      provider: 'claude',
      sessionRef: { provider: 'claude', sessionId: 'sid-fenced' },
    })
    expect(terminalPane).toMatchObject({
      ownerKind: 'fresh-agent',
      transition: 'handoff-failed',
      fencedReason: 'platform-limited',
    })
  })

  // b8ke focused round-4 R4-7: a FENCED record whose prior is VACANT (the
  // server's fenced-with-no-prior replay shape — e.g. an unconfirmed
  // cleanup failure while starting from vacancy) drives the typed recovery
  // state, never the plain-vacant "all clear". Pre-fix, the vacant
  // early-return suppressed it and the pane showed no recovery UI.
  it('diverges a FENCED-VACANT record (fenced before the vacant early-return)', () => {
    const state = stateWithRuntimeOwner({
      provider: 'codex',
      sessionId: 'sid-fenced-vacant',
      ownerKind: 'vacant',
      transition: 'handoff-failed',
      reason: 'watcher-failed',
      fenced: true,
      generation: 11,
    })
    const divergence = selectPaneOwnerDivergence(state, {
      paneKind: 'terminal',
      provider: 'codex',
      sessionRef: { provider: 'codex', sessionId: 'sid-fenced-vacant' },
    })
    expect(divergence).toMatchObject({
      ownerKind: 'vacant',
      transition: 'handoff-failed',
      generation: 11,
      fencedReason: 'watcher-failed',
    })
    // The fenced state must not be lost for a plain vacant record.
    const plainVacant = stateWithRuntimeOwner({
      provider: 'codex',
      sessionId: 'sid-plain-vacant',
      ownerKind: 'vacant',
      transition: 'released',
    })
    expect(selectPaneOwnerDivergence(plainVacant, {
      paneKind: 'terminal',
      provider: 'codex',
      sessionRef: { provider: 'codex', sessionId: 'sid-plain-vacant' },
    })).toBeNull()
  })

  // b8ke focused round-4 R4-5 (client half): a fenced reap/stop FAILURE
  // broadcast carries the `fenced` marker — an online old-kind pane folds
  // the frame through the store and KEEPS the typed recovery state (the
  // same-kind fenced owner diverges), instead of resuming normal
  // polling/actions as a healthy owner.
  it('a fenced failure BROADCAST keeps the same-kind pane blocked (no polling resumption)', () => {
    // The online old-kind pane first sees the handoff start...
    const state = { freshAgent: freshAgentReducer(undefined, applyRuntimeOwner({
      type: 'session.runtimeOwner',
      provider: 'claude',
      sessionId: 'sid-bcast',
      epoch: 5,
      generation: 9,
      ownerKind: 'terminal',
      operationId: 'handoff-9',
      transition: 'handoff-started',
      previousKind: 'terminal',
    })) }
    // ...then the fenced failure frame (prior kind, handoff-failed, WITH
    // the fenced marker — the server's R4-5 broadcast shape).
    const after = { freshAgent: freshAgentReducer(state.freshAgent, applyRuntimeOwner({
      type: 'session.runtimeOwner',
      provider: 'claude',
      sessionId: 'sid-bcast',
      epoch: 5,
      generation: 9,
      ownerKind: 'terminal',
      operationId: 'handoff-9',
      transition: 'handoff-failed',
      reason: 'REAP_TIMEOUT',
      fenced: true,
    })) } as unknown as RootState
    // A SAME-KIND (terminal) pane stays divergent with the typed reason —
    // pre-fix (marker absent) the fold stored no `fenced` and a same-kind
    // owner read as healthy, resuming the pane's polling.
    expect(selectPaneOwnerDivergence(after, {
      paneKind: 'terminal',
      provider: 'claude',
      sessionRef: { provider: 'claude', sessionId: 'sid-bcast' },
    })).toMatchObject({
      ownerKind: 'terminal',
      transition: 'handoff-failed',
      fencedReason: 'REAP_TIMEOUT',
    })
  })

  // b8ke focused round-5 R5-3: an IN-PROGRESS lifecycle transition
  // (handoff-started — the live broadcast, or the ready-replay fold of
  // starting/handoff/stopping) is TRANSITION-BLOCKED for EVERY pane kind.
  // Pre-fix, derivePaneOwnerDivergence returned null whenever the record's
  // ownerKind matched the pane, so a same-kind pane reconnecting
  // mid-lifecycle saw no transition state and resumed normal
  // polling/scheduling.
  it('diverges an in-progress transition for a SAME-KIND pane (transition-blocked)', () => {
    const state = stateWithRuntimeOwner({
      provider: 'codex',
      sessionId: 'sid-starting',
      ownerKind: 'fresh-agent',
      transition: 'handoff-started',
      epoch: 2,
      generation: 4,
    })
    const sameKind = selectPaneOwnerDivergence(state, {
      paneKind: 'fresh-agent',
      provider: 'codex',
      sessionRef: { provider: 'codex', sessionId: 'sid-starting' },
    })
    expect(sameKind).toMatchObject({
      ownerKind: 'fresh-agent',
      transition: 'handoff-started',
      generation: 4,
      inProgress: true,
    })
    // The opposite-kind pane sees the same transition-blocked state.
    expect(selectPaneOwnerDivergence(state, {
      paneKind: 'terminal',
      provider: 'codex',
      sessionRef: { provider: 'codex', sessionId: 'sid-starting' },
    })).toMatchObject({
      ownerKind: 'fresh-agent',
      transition: 'handoff-started',
      inProgress: true,
    })
  })

  // R5-3 (the committed control): a same-kind COMMITTED owner still folds
  // as healthy — the block is exactly the in-progress transition state,
  // never same-mode multi-device attachment.
  it('a committed same-kind owner stays non-divergent (multi-device attachment untouched)', () => {
    const state = stateWithRuntimeOwner({
      provider: 'codex',
      sessionId: 'sid-committed',
      ownerKind: 'fresh-agent',
      transition: 'handoff-committed',
      epoch: 2,
      generation: 5,
    })
    expect(selectPaneOwnerDivergence(state, {
      paneKind: 'fresh-agent',
      provider: 'codex',
      sessionRef: { provider: 'codex', sessionId: 'sid-committed' },
    })).toBeNull()
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

describe('isLifecycleStartSuperseded (kata b8ke lifecycle-start suppression)', () => {
  // b8ke delta round-3 F2: a handoff IN FLIGHT supersedes a lifecycle
  // start EVEN WHEN the pane's kind matches the announced TARGET kind —
  // the handoff-started check must run BEFORE the kind-equality shortcut.
  // Pre-d3 the selector returned false for the matching kind and a
  // delayed attach during the Handoff window slipped the client-side
  // suppression (a fresh-agent pane while the handoff transitions it to
  // terminal, and the terminal twin for the reverse direction).
  it('supersedes a same-kind pane while the handoff is in flight (handoff-started precedes kind equality)', () => {
    const state = stateWithRuntimeOwner({
      provider: 'claude',
      sessionId: 'sid-sup',
      // The TARGET is a fresh-agent owner — the same kind as the pane
      // below — and the transition is IN FLIGHT.
      ownerKind: 'fresh-agent',
      transition: 'handoff-started',
      previousKind: 'terminal',
      generation: 12,
    })
    expect(isLifecycleStartSuperseded(
      state,
      'fresh-agent',
      { provider: 'claude', sessionRef: { provider: 'claude', sessionId: 'sid-sup' } },
      undefined,
    )).toBe(true)
    // The reverse direction: a terminal pane while the handoff targets
    // a terminal owner.
    const state2 = stateWithRuntimeOwner({
      provider: 'codex',
      sessionId: 'sid-sup-2',
      ownerKind: 'terminal',
      transition: 'handoff-started',
      previousKind: 'fresh-agent',
      generation: 3,
    })
    expect(isLifecycleStartSuperseded(
      state2,
      'terminal',
      { provider: 'codex', sessionRef: { provider: 'codex', sessionId: 'sid-sup-2' } },
      undefined,
    )).toBe(true)
  })

  it('fence-aware: a handoff-started record at an older observed generation still supersedes once current', () => {
    const state = stateWithRuntimeOwner({
      provider: 'claude',
      sessionId: 'sid-sup-3',
      ownerKind: 'fresh-agent',
      transition: 'handoff-started',
      generation: 7,
    })
    // The captured fence is OLDER than the in-flight record → superseded.
    expect(isLifecycleStartSuperseded(
      state,
      'fresh-agent',
      { provider: 'claude', sessionRef: { provider: 'claude', sessionId: 'sid-sup-3' } },
      { epoch: 5, generation: 6 },
    )).toBe(true)
    // A NEWER observed fence (the decision already captured a later
    // state) → not superseded by this record.
    expect(isLifecycleStartSuperseded(
      state,
      'fresh-agent',
      { provider: 'claude', sessionRef: { provider: 'claude', sessionId: 'sid-sup-3' } },
      { epoch: 5, generation: 8 },
    )).toBe(false)
  })

  it('a committed same-kind owner does NOT supersede (the multi-device attachment shape)', () => {
    const state = stateWithRuntimeOwner({
      provider: 'claude',
      sessionId: 'sid-same',
      ownerKind: 'fresh-agent',
      transition: 'handoff-committed',
      generation: 4,
    })
    expect(isLifecycleStartSuperseded(
      state,
      'fresh-agent',
      { provider: 'claude', sessionRef: { provider: 'claude', sessionId: 'sid-same' } },
      undefined,
    )).toBe(false)
  })
})
