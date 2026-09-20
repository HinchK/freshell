import { describe, expect, it } from 'vitest'
import {
  beginRecoveryAttempt,
  createTerminalRecoveryAccounting,
  recordRecoveryProgress,
  resetRecoveryAccounting,
  TERMINAL_RECOVERY_MAX_ATTEMPTS,
  TERMINAL_RECOVERY_NO_PROGRESS_DEADLINE_MS,
} from '@/lib/terminal-recovery-accounting'

describe('terminal-recovery-accounting', () => {
  it('the initial hydration attach never counts toward the bound', () => {
    let state = createTerminalRecoveryAccounting()

    const initial = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1000 })
    expect(initial.allowed).toBe(true)
    state = initial.state
    expect(state.attempts).toBe(0)
    expect(state.initialAttachConsumed).toBe(true)

    // Recovery attempts count from the SECOND attach on.
    const second = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1001 })
    expect(second.allowed).toBe(true)
    expect(second.state.attempts).toBe(1)
  })

  it('allows the first progressless recovery attempts and blocks after the attempt bound', () => {
    let state = createTerminalRecoveryAccounting()

    const initial = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1000 })
    state = initial.state

    const first = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1001 })
    expect(first.allowed).toBe(true)
    state = first.state
    expect(state.attempts).toBe(1)

    const second = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1002 })
    expect(second.allowed).toBe(true)
    state = second.state
    expect(state.attempts).toBe(2)

    const third = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1003 })
    expect(third.allowed).toBe(true)
    state = third.state
    expect(state.attempts).toBe(3)
    expect(state.exhausted).toBe(false)

    // The 4th progressless recovery attach exceeds the bound: blocked,
    // visible retry state, automatic cycling stops.
    const fourth = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1004 })
    expect(fourth.allowed).toBe(false)
    expect(fourth.state.exhausted).toBe(true)

    // Once exhausted, every automatic attempt stays blocked.
    const fifth = beginRecoveryAttempt(fourth.state, { coverageSeq: 0, now: 1005 })
    expect(fifth.allowed).toBe(false)
  })

  it('genuine coverage progress resets the streak', () => {
    let state = createTerminalRecoveryAccounting()
    state = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1000 }).state
    state = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1001 }).state
    state = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1002 }).state
    expect(state.attempts).toBe(2)

    // The surface consumed real content: progress.
    state = recordRecoveryProgress(state, 9, 1003)
    expect(state.attempts).toBe(0)
    expect(state.lastProgressSeq).toBe(9)
    expect(state.streakStartedAt).toBeNull()

    // The next attach counts as a fresh first attempt.
    const next = beginRecoveryAttempt(state, { coverageSeq: 9, now: 1004 })
    expect(next.allowed).toBe(true)
    expect(next.state.attempts).toBe(1)
  })

  it('progress during exhaustion clears the exhausted state', () => {
    let state = createTerminalRecoveryAccounting()
    state = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1000 }).state
    for (let i = 0; i < TERMINAL_RECOVERY_MAX_ATTEMPTS + 1; i += 1) {
      state = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1010 + i }).state
    }
    expect(state.exhausted).toBe(true)

    state = recordRecoveryProgress(state, 4, 2000)
    expect(state.exhausted).toBe(false)
    expect(state.attempts).toBe(0)
  })

  it('a stale attempt whose coverage already advanced does not count as progress again', () => {
    let state = createTerminalRecoveryAccounting()
    state = recordRecoveryProgress(state, 9, 1000)

    // Same coverage reported again (idempotent advance): not progress.
    state = recordRecoveryProgress(state, 9, 1001)
    expect(state.attempts).toBe(0)
    expect(state.lastProgressSeq).toBe(9)
  })

  it('blocks a slow no-progress streak after the deadline', () => {
    let state = createTerminalRecoveryAccounting()
    state = beginRecoveryAttempt(state, { coverageSeq: 0, now: 0 }).state

    // Two counted progressless attempts spanning the deadline: the streak is
    // old enough that a third automatic attempt is refused.
    state = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1 }).state
    state = beginRecoveryAttempt(state, { coverageSeq: 0, now: TERMINAL_RECOVERY_NO_PROGRESS_DEADLINE_MS - 1 }).state
    expect(state.exhausted).toBe(false)

    const late = beginRecoveryAttempt(state, {
      coverageSeq: 0,
      now: TERMINAL_RECOVERY_NO_PROGRESS_DEADLINE_MS + 5000,
    })
    expect(late.allowed).toBe(false)
    expect(late.state.exhausted).toBe(true)
  })

  it('a single attempt just because the pane has been idle is never blocked by the deadline alone', () => {
    let state = createTerminalRecoveryAccounting()

    // One counted attempt, then a long idle gap, then ONE reconnect: the
    // deadline must not single-block an idle pane's first progressless
    // re-attach.
    state = beginRecoveryAttempt(state, { coverageSeq: 0, now: 0 }).state
    state = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1 }).state
    const lateSingle = beginRecoveryAttempt(state, {
      coverageSeq: 0,
      now: TERMINAL_RECOVERY_NO_PROGRESS_DEADLINE_MS * 10,
    })
    expect(lateSingle.allowed).toBe(true)
  })

  it('an explicit retry resets the accounting and re-arms automatic recovery', () => {
    let state = createTerminalRecoveryAccounting()
    state = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1000 }).state
    for (let i = 0; i < TERMINAL_RECOVERY_MAX_ATTEMPTS + 1; i += 1) {
      state = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1010 + i }).state
    }
    expect(state.exhausted).toBe(true)

    state = resetRecoveryAccounting(state, 0, 5000)
    expect(state.exhausted).toBe(false)
    expect(state.attempts).toBe(0)

    const retried = beginRecoveryAttempt(state, { coverageSeq: 0, now: 5001 })
    expect(retried.allowed).toBe(true)
    expect(retried.state.attempts).toBe(1)
  })

  it('exposes the documented bounds', () => {
    expect(TERMINAL_RECOVERY_MAX_ATTEMPTS).toBe(3)
    expect(TERMINAL_RECOVERY_NO_PROGRESS_DEADLINE_MS).toBe(30_000)
  })
})
