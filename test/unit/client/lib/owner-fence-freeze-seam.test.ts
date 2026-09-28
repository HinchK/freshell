import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import freshAgentReducer, { applyRuntimeOwner } from '@/store/freshAgentSlice'
import {
  FENCE_FREEZE_QUERY_FLAG,
  _setFenceFreezeSeamForTests,
  fenceFreezeSeamActive,
  shouldSkipRuntimeOwnerBroadcastFold,
} from '@/lib/owner-fence-freeze-seam'
import { foldReadyRuntimeOwners, foldSessionRuntimeOwnerFrame } from '@/lib/fresh-agent-ws'
import { foldRefusalFencePair } from '@/lib/owner-fence-heal'
import type { SessionRuntimeOwnerMessage } from '@shared/ws-protocol'

// the-usual ownership-fence-fix delta round 6 (Path B): the default-off
// test-only seam that stages the typed stale-refusal healing in the
// browser e2e. Contract pinned here:
// - INERT by default (no flag → every broadcast folds exactly as today);
// - flag ON: ONLY the commit-to-Live (`handoff-committed`) runtimeOwner
//   BROADCAST frames are skipped — the frame class whose absence leaves a
//   pane's observed (epoch, generation) fence stale while the server moved
//   on (the missed-broadcast condition the e2e must simulate);
// - flag ON: every other fold path keeps working — the vacant `released`
//   broadcasts (the killed-session recovery affordance folds from them),
//   the typed-refusal fence fold (the heal under test), the ready-replay
//   folds, and the raw applyRuntimeOwner dispatch (the terminal.created
//   owner-trio fold routes through it).

function createFreshAgentStore() {
  return configureStore({
    reducer: {
      freshAgent: freshAgentReducer,
    },
  })
}

function ownerFrame(overrides: Partial<SessionRuntimeOwnerMessage> = {}): SessionRuntimeOwnerMessage {
  return {
    type: 'session.runtimeOwner',
    provider: 'codex',
    sessionId: 'sid-seam-1',
    epoch: 1,
    generation: 3,
    ownerKind: 'terminal',
    operationId: 'op-seam',
    transition: 'handoff-committed',
    ...overrides,
  }
}

/** The App-level fold wiring the predicate gates (App.tsx:1755): fold ONLY
 * when the seam does not skip the frame — mirroring the call site exactly. */
function appLevelFold(
  store: ReturnType<typeof createFreshAgentStore>,
  frame: SessionRuntimeOwnerMessage,
): void {
  if (!shouldSkipRuntimeOwnerBroadcastFold(frame)) {
    foldSessionRuntimeOwnerFrame(store.dispatch, frame)
  }
}

describe('owner-fence-freeze-seam (test-only, default-off)', () => {
  beforeEach(() => {
    _setFenceFreezeSeamForTests(false)
  })
  afterEach(() => {
    _setFenceFreezeSeamForTests(false)
  })

  it('is inert by default — no flag means every broadcast folds exactly as today', () => {
    expect(fenceFreezeSeamActive()).toBe(false)
    const store = createFreshAgentStore()
    appLevelFold(store, ownerFrame({ generation: 4, terminalId: 't-commit' }))
    expect(store.getState().freshAgent.runtimeOwners['codex:sid-seam-1']).toMatchObject({
      ownerKind: 'terminal',
      terminalId: 't-commit',
      generation: 4,
      transition: 'handoff-committed',
    })
  })

  it('flag ON skips ONLY the handoff-committed broadcast fold (the missed commit-to-Live frame)', () => {
    _setFenceFreezeSeamForTests(true)
    expect(fenceFreezeSeamActive()).toBe(true)

    const store = createFreshAgentStore()
    // The commit-to-Live broadcast the seam freezes the fence against.
    appLevelFold(store, ownerFrame({ generation: 5, terminalId: 't-fresh' }))
    expect(
      store.getState().freshAgent.runtimeOwners['codex:sid-seam-1'],
      'the missed commit broadcast must NOT fold the pane fence',
    ).toBeUndefined()

    // The vacant `released` broadcast still folds — the killed-session
    // recovery affordance (the pane's vacantRecovery bar) derives from it.
    appLevelFold(store, ownerFrame({
      generation: 6,
      ownerKind: 'vacant',
      transition: 'released',
      terminalId: undefined,
    }))
    expect(store.getState().freshAgent.runtimeOwners['codex:sid-seam-1']).toMatchObject({
      ownerKind: 'vacant',
      generation: 6,
      transition: 'released',
    })

    // The in-progress + failed transition broadcasts still fold.
    appLevelFold(store, ownerFrame({ generation: 7, transition: 'handoff-started' }))
    appLevelFold(store, ownerFrame({
      generation: 8,
      transition: 'handoff-failed',
      ownerKind: 'terminal',
      reason: 'platform-limited',
      fenced: true,
    }))
    const folded = store.getState().freshAgent.runtimeOwners['codex:sid-seam-1']
    expect(folded?.transition).toBe('handoff-failed')
    expect(folded?.generation).toBe(8)
  })

  it('flag ON keeps the typed-refusal fence fold working (the heal under test)', () => {
    _setFenceFreezeSeamForTests(true)
    const store = createFreshAgentStore()
    // The pane's record as the e2e leaves it: the vacant release folded,
    // the reopen's commit broadcast missed (generation frozen at 6).
    appLevelFold(store, ownerFrame({
      generation: 6,
      ownerKind: 'vacant',
      transition: 'released',
    }))

    // The typed stale refusal's CURRENT pair folds merge-only into the
    // SAME record — nothing about the seam blocks the refusal fold.
    const dispatched = foldRefusalFencePair(
      store.dispatch,
      store.getState(),
      { sessionRef: { provider: 'codex', sessionId: 'sid-seam-1' } },
      { ownerEpoch: 1, ownerGeneration: 9 },
    )
    expect(dispatched).toBe(true)
    expect(store.getState().freshAgent.runtimeOwners['codex:sid-seam-1']).toMatchObject({
      ownerKind: 'vacant',
      epoch: 1,
      generation: 9,
    })
  })

  it('flag ON keeps the ready-replay fold and the raw applyRuntimeOwner dispatch working', () => {
    _setFenceFreezeSeamForTests(true)
    const store = createFreshAgentStore()
    // The ready.runtimeOwners replay resets + re-folds — the reconnect
    // healing path must stay untouched by the seam.
    foldReadyRuntimeOwners(store.dispatch, [{
      provider: 'codex',
      sessionId: 'sid-seam-1',
      epoch: 1,
      generation: 12,
      ownerKind: 'terminal',
      state: 'live',
      terminalId: 't-replay',
    }])
    expect(store.getState().freshAgent.runtimeOwners['codex:sid-seam-1']).toMatchObject({
      ownerKind: 'terminal',
      terminalId: 't-replay',
      generation: 12,
    })

    // The terminal.created owner-trio fold routes through the raw reducer —
    // never through the App broadcast gate — so a fresh pane's own committed
    // pair still folds under the seam.
    store.dispatch(applyRuntimeOwner(ownerFrame({
      generation: 13,
      operationId: 'terminal-created:t-new',
      transition: 'handoff-committed',
    })))
    expect(store.getState().freshAgent.runtimeOwners['codex:sid-seam-1']).toMatchObject({
      generation: 13,
      transition: 'handoff-committed',
    })
  })

  it('reads the flag from the page URL exactly once (the documented query name)', () => {
    expect(FENCE_FREEZE_QUERY_FLAG).toBe('__freshellFreezeFence')
    // The cached read is what the App gate consults; the test hook is the
    // only mutator (the URL itself is exercised end-to-end by the e2e).
    _setFenceFreezeSeamForTests(true)
    expect(fenceFreezeSeamActive()).toBe(true)
  })
})
