import { describe, expect, it } from 'vitest'
import freshAgentReducer, {
  applyRefusalFence,
  applyRuntimeOwner,
  resetRuntimeOwners,
  type RuntimeOwnerRecord,
} from '@/store/freshAgentSlice'
import type { SessionRuntimeOwnerMessage } from '@shared/ws-protocol'

const baseFrame = (overrides: Partial<SessionRuntimeOwnerMessage> = {}): SessionRuntimeOwnerMessage => ({
  type: 'session.runtimeOwner',
  provider: 'codex',
  sessionId: 'sid-1',
  epoch: 7,
  generation: 3,
  ownerKind: 'terminal',
  operationId: 'handoff-1',
  transition: 'handoff-committed',
  ...overrides,
})

function reducerWith(...actions: Array<ReturnType<typeof applyRuntimeOwner> | ReturnType<typeof resetRuntimeOwners>>) {
  return actions.reduce(freshAgentReducer, freshAgentReducer(undefined, { type: '@@INIT' }))
}

describe('freshAgentSlice runtimeOwners fold', () => {
  it('applies a runtime-owner frame keyed by provider:sessionId', () => {
    const state = reducerWith(applyRuntimeOwner(baseFrame({ terminalId: 't-9', generation: 4 })))
    expect(state.runtimeOwners['codex:sid-1']).toMatchObject({
      ownerKind: 'terminal',
      terminalId: 't-9',
      epoch: 7,
      generation: 4,
      transition: 'handoff-committed',
    })
  })

  it('ignores frames older than the recorded generation within the same epoch (monotonic)', () => {
    const state = reducerWith(
      applyRuntimeOwner(baseFrame({ generation: 5 })),
      applyRuntimeOwner(baseFrame({ generation: 3, transition: 'handoff-started' })),
    )
    expect(state.runtimeOwners['codex:sid-1'].generation).toBe(5)
  })

  it('a frame from a DIFFERENT epoch supersedes any recorded generation (round-2 restart epoch)', () => {
    const state = reducerWith(
      applyRuntimeOwner(baseFrame({ epoch: 6, generation: 10 })),
      applyRuntimeOwner(baseFrame({ epoch: 9, generation: 1 })),
    )
    expect(state.runtimeOwners['codex:sid-1']).toMatchObject(
      { epoch: 9, generation: 1 },
      "a restarted server's newer-epoch frame must never be ignored for a lower generation",
    )
  })

  it('records vacant owners (released) so divergence clears', () => {
    const state = reducerWith(
      applyRuntimeOwner(baseFrame({ generation: 5 })),
      applyRuntimeOwner(baseFrame({ generation: 6, ownerKind: 'vacant', transition: 'released' })),
    )
    expect(state.runtimeOwners['codex:sid-1'].ownerKind).toBe('vacant')
  })

  it('keeps transition state until superseded — a same-generation handoff-failed frame is never dropped (round-2 truth fold)', () => {
    const state = reducerWith(
      applyRuntimeOwner(baseFrame({
        generation: 4,
        ownerKind: 'fresh-agent',
        transition: 'handoff-started',
      })),
      // The corrective frame arrives at the SAME generation (fail does not
      // bump it): the restored prior owner + reason must land.
      applyRuntimeOwner(baseFrame({
        generation: 4,
        ownerKind: 'fresh-agent',
        previousKind: 'fresh-agent',
        transition: 'handoff-failed',
        reason: 'REAP_TIMEOUT',
      })),
    )
    expect(state.runtimeOwners['codex:sid-1']).toMatchObject({
      ownerKind: 'fresh-agent',
      transition: 'handoff-failed',
      reason: 'REAP_TIMEOUT',
    })
  })

  it('resetRuntimeOwners clears the map on ready (round-2 reconnect convergence)', () => {
    const state = reducerWith(
      applyRuntimeOwner(baseFrame({ generation: 10 })),
      applyRuntimeOwner(baseFrame({ sessionId: 'sid-other', generation: 2 })),
      resetRuntimeOwners(),
      applyRuntimeOwner(baseFrame({ generation: 1 })),
    )
    expect(state.runtimeOwners['codex:sid-1'].generation).toBe(1)
    expect(Object.keys(state.runtimeOwners)).toEqual(['codex:sid-1'])
  })

  it('carries previousKind and updatedAt on the stored record', () => {
    const before = Date.now()
    const state = reducerWith(applyRuntimeOwner(baseFrame({
      ownerKind: 'terminal',
      previousKind: 'fresh-agent',
    })))
    const record: RuntimeOwnerRecord = state.runtimeOwners['codex:sid-1']
    expect(record.previousKind).toBe('fresh-agent')
    expect(record.updatedAt).toBeGreaterThanOrEqual(before)
  })

  it('the refusal fence fold never regresses the recorded generation (advance-only, like the broadcast fold)', () => {
    // 2026-09-20 incident recovery (Task 5 review M1): a NEWER runtimeOwner
    // broadcast (gen 3) can fold between the server minting the 409 refusal
    // (gen 2) and the client processing it — the refusal must not roll the
    // record back, or the recovery attach would carry a stale fence the
    // wired server refuses with FENCE_REQUIRED.
    const seeded = reducerWith(applyRuntimeOwner(baseFrame({
      provider: 'opencode',
      sessionId: 'ses-fence',
      epoch: 1,
      generation: 3,
      ownerKind: 'fresh-agent',
    })))
    const refusalFold = (ownerGeneration: number) => freshAgentReducer(seeded, applyRefusalFence({
      provider: 'opencode',
      sessionId: 'ses-fence',
      ownerKind: 'fresh-agent',
      ownerGeneration,
    }))
    expect(refusalFold(2).runtimeOwners['opencode:ses-fence'].generation).toBe(3)
    expect(refusalFold(4).runtimeOwners['opencode:ses-fence'].generation).toBe(4)
  })
})
