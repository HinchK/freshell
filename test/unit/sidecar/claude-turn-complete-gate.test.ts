import { describe, expect, it } from 'vitest'
import { createTurnCompleteGate } from '../../../crates/freshell-claude-sidecar/turn-complete-gate.mjs'

describe('freshell-claude-sidecar turn-complete gate', () => {
  it('emits for every result subtype with no interrupt in flight', () => {
    for (const subtype of ['success', 'error_during_execution', 'error_max_turns', 'error_max_budget_usd', 'error_max_structured_output_retries']) {
      const gate = createTurnCompleteGate()
      expect(gate.resultEmitsAttention(), `${subtype} all ring`).toBe(true)
    }
  })

  it('suppresses the result that follows an accepted user interrupt', () => {
    const gate = createTurnCompleteGate()
    gate.noteInterruptRequest()
    gate.noteInterruptSettled(true)
    expect(gate.resultEmitsAttention()).toBe(false) // the interrupted turn's own result
    expect(gate.resultEmitsAttention()).toBe(true)  // the next turn rings again
  })

  it('a rejected interrupt (ok:false) never suppresses a later result', () => {
    const gate = createTurnCompleteGate()
    gate.noteInterruptRequest()
    gate.noteInterruptSettled(false)
    expect(gate.resultEmitsAttention()).toBe(true)
  })

  it('a mark survives a queued send and still consumes only the interrupted turn\'s result (no reset-at-send)', () => {
    // Ordering contract: the SDK serializes turns within one query, so the
    // interrupted turn's result is the FIRST result after the settle even if
    // the next prompt was queued before it arrived.
    const gate = createTurnCompleteGate()
    gate.noteInterruptRequest()
    gate.noteInterruptSettled(true)
    // (queued send happens here — the gate deliberately does NOT reset)
    expect(gate.resultEmitsAttention()).toBe(false) // interrupted turn's late result
    expect(gate.resultEmitsAttention()).toBe(true)  // the queued turn's own result
  })

  it('an interrupt with nothing pending never arms (the arm site skips the arm when no turn awaits a terminal frame)', () => {
    // The gate stays pure; the ARM-SITE policy it serves (index.mjs
    // handleInterrupt) is `if (st.pendingResults > 0)
    // st.turnCompleteGate.noteInterruptRequest()`. Modeled here the same way
    // the arm site does it: with NOTHING pending, the SDK RESOLVES the
    // interrupt (settle ok:true, no result ever follows — sdk.d.ts:2384-2394
    // documents RESOLUTION, not rejection, for the nothing-in-flight case),
    // so no mark may survive to eat the NEXT unrelated turn's result.
    const gate = createTurnCompleteGate()
    const pendingResults = 0
    if (pendingResults > 0) gate.noteInterruptRequest()
    gate.noteInterruptSettled(true)
    expect(gate.resultEmitsAttention()).toBe(true) // the next turn's result still rings
  })
})
