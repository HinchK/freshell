import { describe, expect, it } from 'vitest'
import freshAgentReducer, { applyRuntimeOwner, type RuntimeOwnerRecord } from '@/store/freshAgentSlice'
import {
  canonicalPaneSession,
  derivePaneOwnerDivergence,
  deriveTerminalOwnerConvergence,
  isLifecycleStartSuperseded,
  selectOwnerFence,
  selectPaneOwnerDivergence,
  selectPaneOwnerFence,
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

describe('b8ke ext F1: rekey alias chains resolve to the canonical key', () => {
  // The Claude rollback/fork rekey broadcasts a MIRROR record for the old
  // key (the canonical owner state + aliasOf naming the canonical id) and
  // the canonical record for the new key. A pane holding the pre-rekey
  // sessionRef must resolve THROUGH the alias chain to the canonical key
  // — pre-ext the stored aliasOf was parsed but never consumed, so the
  // pane kept referencing the superseded id and saw the same-kind mirror
  // record (no divergence, no convergence).

  function ownersState(
    frames: Array<Partial<SessionRuntimeOwnerMessage> & { provider: string; sessionId: string }>,
  ): RootState {
    let freshAgent = freshAgentReducer(undefined, { type: '@@INIT' })
    for (const record of frames) {
      const frame: SessionRuntimeOwnerMessage = {
        type: 'session.runtimeOwner',
        epoch: 5,
        generation: 4,
        ownerKind: 'terminal',
        operationId: 'handoff-1',
        transition: 'handoff-committed',
        ...record,
      }
      freshAgent = freshAgentReducer(freshAgent, applyRuntimeOwner(frame))
    }
    return { freshAgent } as unknown as RootState
  }

  it('canonicalPaneSession resolves the stored aliasOf chain to the fixpoint', () => {
    const ownersStateMap = {
      'claude:old-id': { aliasOf: 'new-id' },
      'claude:mid-id': { aliasOf: 'final-id' },
      'claude:chain-a': { aliasOf: 'chain-b' },
      'claude:chain-b': { aliasOf: 'chain-c' },
    } as Record<string, RuntimeOwnerRecord>
    expect(canonicalPaneSession(
      { provider: 'claude', sessionRef: { provider: 'claude', sessionId: 'old-id' } },
      ownersStateMap,
    )).toEqual({ provider: 'claude', sessionId: 'new-id' })
    expect(canonicalPaneSession(
      { provider: 'claude', sessionId: 'mid-id' },
      ownersStateMap,
    )).toEqual({ provider: 'claude', sessionId: 'final-id' })
    // Multi-hop chains walk to the fixpoint.
    expect(canonicalPaneSession(
      { provider: 'claude', sessionRef: { provider: 'claude', sessionId: 'chain-a' } },
      ownersStateMap,
    )).toEqual({ provider: 'claude', sessionId: 'chain-c' })
    // A key with no alias record stays itself; a foreign provider's alias
    // record never applies (the chain is per-provider).
    expect(canonicalPaneSession(
      { provider: 'claude', sessionRef: { provider: 'claude', sessionId: 'plain' } },
      ownersStateMap,
    )).toEqual({ provider: 'claude', sessionId: 'plain' })
    expect(canonicalPaneSession(
      { provider: 'codex', sessionRef: { provider: 'codex', sessionId: 'old-id' } },
      ownersStateMap,
    )).toEqual({ provider: 'codex', sessionId: 'old-id' })
  })

  it('an old-key pane diverges through the mirror record to the canonical owner (the convergence flow)', () => {
    // The old key holds the SAME-KIND mirror record (aliasOf → new-id);
    // the CANONICAL key holds a TERMINAL owner — an old-key fresh-agent
    // pane must see the terminal divergence ("opened as CLI elsewhere"),
    // never the same-kind mirror's null.
    const state = ownersState([
      { provider: 'claude', sessionId: 'old-id', ownerKind: 'fresh-agent', aliasOf: 'new-id' },
      { provider: 'claude', sessionId: 'new-id', ownerKind: 'terminal', terminalId: 't-1' },
    ])
    expect(selectPaneOwnerDivergence(state, {
      paneKind: 'fresh-agent',
      provider: 'claude',
      sessionRef: { provider: 'claude', sessionId: 'old-id' },
    })).toEqual({
      ownerKind: 'terminal',
      terminalId: 't-1',
      generation: 4,
      transition: 'handoff-committed',
    })
  })

  it('selectPaneOwnerFence observes through the alias chain', () => {
    const state = ownersState([
      { provider: 'claude', sessionId: 'old-id', ownerKind: 'fresh-agent', aliasOf: 'new-id', epoch: 9, generation: 7 },
      { provider: 'claude', sessionId: 'new-id', ownerKind: 'terminal', epoch: 9, generation: 7 },
    ])
    expect(selectPaneOwnerFence(state, {
      provider: 'claude',
      sessionRef: { provider: 'claude', sessionId: 'old-id' },
    })).toEqual({ epoch: 9, generation: 7 })
  })

  // b8ke ext r26 F6: isLifecycleStartSuperseded resolves the pane's
  // canonical session through the SAME stored alias chain as every other
  // store-backed consumer. Pre-r26 it called canonicalPaneSession without
  // the runtime-owner map, so a pane holding a pre-rekey sessionRef saw
  // the old key's SAME-KIND mirror record and issued a stale scheduled
  // lifecycle start instead of suppressing it locally (only the
  // server-side generation fence caught it).
  it('isLifecycleStartSuperseded follows the rekey alias chain — a pre-rekey pane is superseded', () => {
    const state = ownersState([
      { provider: 'claude', sessionId: 'old-id', ownerKind: 'fresh-agent', aliasOf: 'new-id' },
      { provider: 'claude', sessionId: 'new-id', ownerKind: 'terminal', terminalId: 't-1', generation: 9 },
    ])
    expect(isLifecycleStartSuperseded(
      state,
      'fresh-agent',
      { provider: 'claude', sessionRef: { provider: 'claude', sessionId: 'old-id' } },
      undefined,
    )).toBe(true)
    // Fence-aware: the canonical owner's generation is at least the
    // captured fence's — the stale scheduled start stays suppressed.
    expect(isLifecycleStartSuperseded(
      state,
      'fresh-agent',
      { provider: 'claude', sessionRef: { provider: 'claude', sessionId: 'old-id' } },
      { epoch: 5, generation: 8 },
    )).toBe(true)
  })

  it('a released-vacant stop frame refreshes the fence the next lifecycle request carries (b8ke ext r18 F1)', () => {
    // The kill → immediate recreate "Restart sidecar" sequence: the pane's
    // stored owner record still names the LIVE owner at generation 4, then
    // the server's release frame (broadcast on the successful stop
    // commit) folds over it — the pane's observed fence becomes the
    // post-stop (epoch, generation) pair, so the recreate's
    // freshAgent.create carries the CURRENT generation and succeeds on
    // the first try (pre-r18 the server never sent the frame, so the
    // fence stayed stale and the recreate was fenced as a stale pair).
    const afterStop = ownersState([
      { provider: 'codex', sessionId: 'sid-restart', ownerKind: 'vacant', generation: 5, epoch: 5, transition: 'released' },
    ])
    const pane = {
      paneKind: 'fresh-agent' as const,
      provider: 'codex',
      sessionRef: { provider: 'codex', sessionId: 'sid-restart' },
    }
    expect(selectPaneOwnerFence(afterStop, pane)).toEqual({ epoch: 5, generation: 5 })
    // And the pane is NOT divergent against the vacant record (it can
    // issue the lifecycle start immediately).
    expect(selectPaneOwnerDivergence(afterStop, pane)).toBeNull()
  })
})

describe('deriveTerminalOwnerConvergence (b8ke ext r11 F2)', () => {
  const committedTerminalOwner = (overrides: Partial<RuntimeOwnerRecord> = {}): RuntimeOwnerRecord => ({
    provider: 'codex',
    sessionId: 'sid-conv',
    epoch: 5,
    generation: 9,
    ownerKind: 'terminal',
    terminalId: 't-new-owner',
    operationId: 'handoff-1',
    transition: 'handoff-committed',
    ...overrides,
  })

  it('marks a committed same-kind owner with a DIFFERENT terminal id than the dead/absent pane terminal', () => {
    expect(deriveTerminalOwnerConvergence(committedTerminalOwner(), undefined)).toEqual({
      ownerKind: 'terminal',
      transition: 'handoff-committed',
      terminalId: 't-new-owner',
      generation: 9,
      sameKindTerminal: true,
    })
    expect(deriveTerminalOwnerConvergence(committedTerminalOwner(), 't-dead-prior')).toEqual({
      ownerKind: 'terminal',
      transition: 'handoff-committed',
      terminalId: 't-new-owner',
      generation: 9,
      sameKindTerminal: true,
    })
  })

  it('returns null when the owner IS the pane\'s own terminal (idempotent same-mode attachment)', () => {
    expect(deriveTerminalOwnerConvergence(committedTerminalOwner(), 't-new-owner')).toBeNull()
  })

  it('returns null for an in-progress handoff (the same-kind-transition blocking stays on the divergence path)', () => {
    expect(deriveTerminalOwnerConvergence(
      committedTerminalOwner({ transition: 'handoff-started' }),
      undefined,
    )).toBeNull()
  })

  it('returns null for a fenced record (the typed recovery state owns the pane)', () => {
    expect(deriveTerminalOwnerConvergence(
      committedTerminalOwner({ fenced: true }),
      undefined,
    )).toBeNull()
  })

  it('returns null for a fresh-agent owner (the cross-kind card flow is untouched)', () => {
    expect(deriveTerminalOwnerConvergence(
      committedTerminalOwner({ ownerKind: 'fresh-agent', terminalId: undefined }),
      undefined,
    )).toBeNull()
  })

  it('returns null for a vacant record or a terminal owner with no terminal id', () => {
    expect(deriveTerminalOwnerConvergence(
      committedTerminalOwner({ ownerKind: 'vacant', terminalId: undefined }),
      undefined,
    )).toBeNull()
    expect(deriveTerminalOwnerConvergence(
      committedTerminalOwner({ terminalId: undefined }),
      undefined,
    )).toBeNull()
    expect(deriveTerminalOwnerConvergence(undefined, undefined)).toBeNull()
  })
})

describe('b8ke ext r14 F3: the VACANT released frame clears an old-key pane', () => {
  function stateWithFrame(record: Partial<SessionRuntimeOwnerMessage>): RootState {
    const frame: SessionRuntimeOwnerMessage = {
      type: 'session.runtimeOwner',
      epoch: 5,
      generation: 4,
      ownerKind: 'terminal',
      operationId: 'rebind-1',
      transition: 'released',
      ...record,
    } as SessionRuntimeOwnerMessage
    const freshAgent = freshAgentReducer(undefined, applyRuntimeOwner(frame))
    return { freshAgent } as unknown as RootState
  }

  it('an old-key fresh-agent pane clears its divergence on the VACANT released frame (no attach action)', () => {
    // The old key first shows the terminal owner (the divergence the
    // pane presents mid-rebind).
    const before = stateWithFrame({
      provider: 'codex',
      sessionId: 'old-key',
      ownerKind: 'terminal',
      terminalId: 't-mover',
      generation: 4,
      transition: 'handoff-committed',
    })
    const pane = {
      paneKind: 'fresh-agent' as const,
      provider: 'codex',
      sessionRef: { provider: 'codex', sessionId: 'old-key' },
    }
    expect(selectPaneOwnerDivergence(before, pane)).not.toBeNull()

    // THE VACANT RELEASED FRAME (the ext-r14 server shape for a rebind's
    // superseded key): ownerKind "vacant", NO terminal id — the pane's
    // divergence CLEARS (no "opened as CLI elsewhere" card, no
    // direct-attach action pointing at a terminal that moved on).
    const after = stateWithFrame({
      provider: 'codex',
      sessionId: 'old-key',
      ownerKind: 'vacant',
      terminalId: undefined,
      generation: 5,
      transition: 'released',
    })
    expect(selectPaneOwnerDivergence(after, pane)).toBeNull()
  })
})
