import { describe, expect, it, vi } from 'vitest'
import freshAgentReducer, {
  applyRuntimeOwner,
  applyRuntimeOwnerFenceRefresh,
} from '@/store/freshAgentSlice'
import { foldRefusalFencePair } from '@/lib/owner-fence-heal'
import type { SessionRuntimeOwnerMessage } from '@shared/ws-protocol'
import type { RootState } from '@/store/store'

function ownerFrame(overrides: Partial<SessionRuntimeOwnerMessage> = {}): SessionRuntimeOwnerMessage {
  return {
    type: 'session.runtimeOwner',
    provider: 'codex',
    sessionId: 'canonical-id',
    epoch: 1,
    generation: 1,
    ownerKind: 'terminal',
    operationId: 'op-1',
    transition: 'handoff-committed',
    ...overrides,
  }
}

/** Build a RootState-shaped state by folding owner frames through the REAL
 * reducer (the selectors-runtime-owner.test.ts idiom). */
function stateWithFrames(...frames: SessionRuntimeOwnerMessage[]): RootState {
  const freshAgent = frames
    .map((frame) => applyRuntimeOwner(frame))
    .reduce(freshAgentReducer, freshAgentReducer(undefined, { type: '@@INIT' }))
  return { freshAgent } as unknown as RootState
}

/** Run the helper against the given state, then apply the dispatched action
 * through the real reducer and return (dispatched actions, next state). */
function fold(
  state: RootState,
  paneLike: Parameters<typeof foldRefusalFencePair>[2],
  pair: Parameters<typeof foldRefusalFencePair>[3],
): { folded: boolean; dispatched: unknown[]; next: RootState } {
  const dispatched: unknown[] = []
  const folded = foldRefusalFencePair(
    (action) => dispatched.push(action),
    state,
    paneLike,
    pair,
  )
  // Apply each dispatched action through the real reducer in order.
  let freshAgent = state.freshAgent
  for (const action of dispatched) {
    freshAgent = freshAgentReducer(freshAgent, action as never)
  }
  return { folded, dispatched, next: { freshAgent } as unknown as RootState }
}

describe('foldRefusalFencePair (b8ke fence-heal, fix b)', () => {
  it('folds the refusal pair onto the CANONICAL key through the alias chain — the raw key stays untouched (LB-A3)', () => {
    // The rekey mirror chain (the r7 alias/rekey seeding idiom): the pane's
    // raw sessionRef aliases the canonical id; the canonical key holds the
    // live terminal owner.
    const state = stateWithFrames(
      ownerFrame({ sessionId: 'old-id', generation: 2, aliasOf: 'canonical-id' }),
      ownerFrame({ sessionId: 'canonical-id', generation: 3, terminalId: 't-owner' }),
    )

    const { folded, next } = fold(
      state,
      { sessionRef: { provider: 'codex', sessionId: 'old-id' } },
      { ownerEpoch: 1, ownerGeneration: 9 },
    )

    expect(folded).toBe(true)
    // The fold landed on the CANONICAL record (the key the next claim's
    // fence read resolves)…
    expect(next.freshAgent.runtimeOwners['codex:canonical-id'].generation).toBe(9)
    expect(next.freshAgent.runtimeOwners['codex:canonical-id'].ownerKind).toBe('terminal')
    // …and the raw (aliased) key is untouched by the merge-only fold.
    expect(next.freshAgent.runtimeOwners['codex:old-id'].generation).toBe(2)
  })

  it('dispatches (returns true) but the record stays absent when no record exists — the reducer no-op', () => {
    const state = stateWithFrames()
    const { folded, next } = fold(
      state,
      { sessionRef: { provider: 'codex', sessionId: 'never-seen' } },
      { ownerEpoch: 1, ownerGeneration: 5 },
    )
    // The return reports the DISPATCH decision, not the state change
    // (plan-review round 3, finding 3): the reducer may itself no-op.
    expect(folded).toBe(true)
    expect(next.freshAgent.runtimeOwners['codex:never-seen']).toBeUndefined()
  })

  it('returns false and dispatches nothing when the pair is absent (the missing-pair guard)', () => {
    const state = stateWithFrames(ownerFrame({ generation: 1 }))
    const dispatch = vi.fn()
    expect(foldRefusalFencePair(
      dispatch,
      state,
      { sessionRef: { provider: 'codex', sessionId: 'canonical-id' } },
      {},
    )).toBe(false)
    expect(foldRefusalFencePair(
      dispatch,
      state,
      { sessionRef: { provider: 'codex', sessionId: 'canonical-id' } },
      { ownerEpoch: 1 },
    )).toBe(false)
    expect(foldRefusalFencePair(
      dispatch,
      state,
      { sessionRef: { provider: 'codex', sessionId: 'canonical-id' } },
      { ownerGeneration: 4 },
    )).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('returns false when the pane-like resolves no canonical session', () => {
    const state = stateWithFrames()
    const dispatch = vi.fn()
    expect(foldRefusalFencePair(
      dispatch,
      state,
      {},
      { ownerEpoch: 1, ownerGeneration: 5 },
    )).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })
})
