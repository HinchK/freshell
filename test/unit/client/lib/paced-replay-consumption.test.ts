import { describe, expect, it } from 'vitest'
import {
  beginPacedReplayConsumption,
  pacedReplayConsumeThrough,
  pacedReplayMarkReceived,
  pacedReplayNextCredit,
  pacedReplayOnReady,
} from '@/lib/paced-replay-consumption'

describe('paced-replay-consumption', () => {
  it('arms a fresh attach generation at the attach baseline', () => {
    const state = beginPacedReplayConsumption({
      terminalId: 'term-1',
      attachRequestId: 'attach-1',
      sinceSeq: 0,
    })
    expect(state).toEqual({
      terminalId: 'term-1',
      attachRequestId: 'attach-1',
      targetSeq: null,
      frontierSeq: 0,
      lastReceivedSeq: 0,
      lastSentCreditSeq: 0,
    })

    const delta = beginPacedReplayConsumption({
      terminalId: 'term-1',
      attachRequestId: 'attach-2',
      sinceSeq: 41,
    })
    expect(delta.frontierSeq).toBe(41)
    expect(delta.lastReceivedSeq).toBe(41)
    expect(delta.lastSentCreditSeq).toBe(41)
  })

  it('records the session-window target from attach.ready (replayToSeq)', () => {
    const state = pacedReplayOnReady(
      beginPacedReplayConsumption({
        terminalId: 'term-1',
        attachRequestId: 'attach-1',
        sinceSeq: 0,
      }),
      { replayToSeq: 120 },
    )
    expect(state.targetSeq).toBe(120)
  })

  it('never credits a frontier above the highest received seq', () => {
    let state = pacedReplayOnReady(
      beginPacedReplayConsumption({
        terminalId: 'term-1',
        attachRequestId: 'attach-1',
        sinceSeq: 0,
      }),
      { replayToSeq: 100 },
    )
    // A frame is applied BEFORE the receipt bookkeeping ran (defensive
    // ordering): the credit must clamp to what was received.
    state = pacedReplayConsumeThrough(state, 30)
    const decision = pacedReplayNextCredit(state)
    expect(decision.credit).toBeNull()

    state = pacedReplayMarkReceived(state, 30)
    const credited = pacedReplayNextCredit(state)
    expect(credited.credit).toEqual({
      terminalId: 'term-1',
      attachRequestId: 'attach-1',
      consumedSeq: 30,
    })
    expect(credited.state.lastSentCreditSeq).toBe(30)
  })

  it('coalesces: repeated credit drains without a frontier advance send nothing', () => {
    let state = pacedReplayOnReady(
      beginPacedReplayConsumption({
        terminalId: 'term-1',
        attachRequestId: 'attach-1',
        sinceSeq: 0,
      }),
      { replayToSeq: 100 },
    )
    state = pacedReplayMarkReceived(state, 12)
    state = pacedReplayConsumeThrough(state, 12)
    const first = pacedReplayNextCredit(state)
    expect(first.credit?.consumedSeq).toBe(12)
    const second = pacedReplayNextCredit(first.state)
    expect(second.credit).toBeNull()
  })

  it('clamps credits to the session-window target once the frontier crosses it', () => {
    let state = pacedReplayOnReady(
      beginPacedReplayConsumption({
        terminalId: 'term-1',
        attachRequestId: 'attach-1',
        sinceSeq: 0,
      }),
      { replayToSeq: 50 },
    )
    // Tail/live frames past the target advance the frontier, but the final
    // window credit lands exactly at the target and nothing follows it.
    state = pacedReplayMarkReceived(state, 80)
    state = pacedReplayConsumeThrough(state, 80)
    const decision = pacedReplayNextCredit(state)
    expect(decision.credit?.consumedSeq).toBe(50)
    expect(pacedReplayNextCredit(decision.state).credit).toBeNull()
  })

  it('sends no credit before the target is known', () => {
    const state = beginPacedReplayConsumption({
      terminalId: 'term-1',
      attachRequestId: 'attach-1',
      sinceSeq: 0,
    })
    const advanced = pacedReplayConsumeThrough(
      pacedReplayMarkReceived(state, 5),
      5,
    )
    expect(pacedReplayNextCredit(advanced).credit).toBeNull()
  })

  it('advances the frontier monotonically and ignores regressed seqs', () => {
    let state = pacedReplayOnReady(
      beginPacedReplayConsumption({
        terminalId: 'term-1',
        attachRequestId: 'attach-1',
        sinceSeq: 0,
      }),
      { replayToSeq: 100 },
    )
    state = pacedReplayMarkReceived(state, 20)
    state = pacedReplayConsumeThrough(state, 20)
    const regressed = pacedReplayConsumeThrough(state, 7)
    expect(regressed).toBe(state)
    expect(regressed.frontierSeq).toBe(20)
  })

  it('marks received seqs monotonically', () => {
    const state = pacedReplayOnReady(
      beginPacedReplayConsumption({
        terminalId: 'term-1',
        attachRequestId: 'attach-1',
        sinceSeq: 0,
      }),
      { replayToSeq: 100 },
    )
    const advanced = pacedReplayMarkReceived(state, 8)
    expect(advanced.lastReceivedSeq).toBe(8)
    expect(pacedReplayMarkReceived(advanced, 3).lastReceivedSeq).toBe(8)
  })

  it('credits partial consumption inside the window and continues from the frontier', () => {
    let state = pacedReplayOnReady(
      beginPacedReplayConsumption({
        terminalId: 'term-1',
        attachRequestId: 'attach-1',
        sinceSeq: 0,
      }),
      { replayToSeq: 100 },
    )
    state = pacedReplayMarkReceived(state, 50)
    state = pacedReplayConsumeThrough(state, 25)
    const partial = pacedReplayNextCredit(state)
    expect(partial.credit?.consumedSeq).toBe(25)

    state = pacedReplayConsumeThrough(partial.state, 50)
    const full = pacedReplayNextCredit(state)
    expect(full.credit?.consumedSeq).toBe(50)
  })
})
