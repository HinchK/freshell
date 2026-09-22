import { describe, expect, it } from 'vitest'
import {
  beginRecoveryAttempt,
  createTerminalRecoveryAccounting,
  recordRecoveryProgress,
  recordRecoveryRestoreSuccess,
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

  it('a clean restore success resets the streak without touching the progress record', () => {
    let state = createTerminalRecoveryAccounting()
    state = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1000 }).state
    state = recordRecoveryProgress(state, 5, 1001)
    state = beginRecoveryAttempt(state, { coverageSeq: 5, now: 1002 }).state
    expect(state.attempts).toBe(1)
    expect(state.lastProgressSeq).toBe(5)

    // A clean, completed restore (attach.ready received, session completes,
    // no gap) is restore SUCCESS, not stagnation — it must reset the
    // progressless streak, or N ordinary reconnects of an idle converged
    // pane strand it on the retry strip.
    state = recordRecoveryRestoreSuccess(state)
    expect(state.attempts).toBe(0)
    expect(state.streakStartedAt).toBeNull()
    expect(state.exhausted).toBe(false)
    expect(state.lastAttemptKey).toBeNull()
    expect(state.lastProgressSeq).toBe(5, 'the coverage record is untouched by the streak reset')
    expect(state.initialAttachConsumed).toBe(true, 'the initial-attach exemption stays consumed')

    const next = beginRecoveryAttempt(state, { coverageSeq: 5, now: 1003 })
    expect(next.allowed).toBe(true)
    expect(next.state.attempts).toBe(1)
  })

  it('a clean restore success clears exhaustion and re-arms the bound', () => {
    let state = createTerminalRecoveryAccounting()
    state = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1000 }).state
    for (let i = 0; i < TERMINAL_RECOVERY_MAX_ATTEMPTS + 1; i += 1) {
      state = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1010 + i }).state
    }
    expect(state.exhausted).toBe(true)

    state = recordRecoveryRestoreSuccess(state)
    expect(state.exhausted).toBe(false)
    const after = beginRecoveryAttempt(state, { coverageSeq: 0, now: 5000 })
    expect(after.allowed).toBe(true)
  })

  it('many clean restores in a row never reach the bound', () => {
    let state = createTerminalRecoveryAccounting()
    state = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1000 }).state
    for (let flap = 0; flap < 20; flap += 1) {
      const attempt = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1010 + flap })
      expect(attempt.allowed, `flap ${flap} must stay auto-attaching`).toBe(true)
      state = recordRecoveryRestoreSuccess(attempt.state)
    }
    expect(state.attempts).toBe(0)
    expect(state.exhausted).toBe(false)
  })

  it('exposes the documented bounds', () => {
    expect(TERMINAL_RECOVERY_MAX_ATTEMPTS).toBe(3)
    expect(TERMINAL_RECOVERY_NO_PROGRESS_DEADLINE_MS).toBe(30_000)
  })

  describe('reconcile-episode calibration (M-1)', () => {
    it('collapses every attach of ONE reconcile episode into a single counted attempt', () => {
      let state = createTerminalRecoveryAccounting()
      state = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1000 }).state

      // One transport reconnect, then a legitimate reconcile-verdict
      // episode: the pending-mark attach and the verdict-fold attach are
      // deliberate pane lifecycle on an idle pane (no coverage progress).
      state = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1001 }).state
      expect(state.attempts).toBe(1)
      const episodePending = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1002, attemptKey: 'pending:5000' })
      expect(episodePending.allowed).toBe(true)
      expect(episodePending.state.attempts).toBe(2)
      state = episodePending.state

      const episodeFold = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1003, attemptKey: 'pending:5000' })
      expect(episodeFold.allowed).toBe(true)
      // The episode consumed ONE attempt, not two — a healthy pane must
      // need more than a single reconcile episode plus one reconnect to
      // reach the retry strip.
      expect(episodeFold.state.attempts).toBe(2)
    })

    it('a ws flap between an episode\u2019s attaches does not refund the episode key', () => {
      let state = createTerminalRecoveryAccounting()
      state = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1000 }).state
      state = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1001 }).state

      const episodePending = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1002, attemptKey: 'pending:5000' })
      state = episodePending.state
      expect(state.attempts).toBe(2)

      // An interleaved transport reconnect (no episode key) counts as its
      // own attempt but must not clear the episode key.
      const flap = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1003 })
      expect(flap.state.attempts).toBe(3)
      state = flap.state

      // The episode's closing (fold) attach still collapses into the
      // episode's single counted attempt.
      const episodeFold = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1004, attemptKey: 'pending:5000' })
      expect(episodeFold.allowed).toBe(true)
      expect(episodeFold.state.attempts).toBe(3)
    })

    it('a NEW reconcile episode counts again — the accounting stays bounded for no-progress storms', () => {
      let state = createTerminalRecoveryAccounting()
      state = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1000 }).state
      state = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1001 }).state
      state = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1002, attemptKey: 'pending:5000' }).state
      state = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1003, attemptKey: 'pending:5000' }).state
      expect(state.attempts).toBe(2)

      // A second full episode (new pending window → new key) counts once…
      state = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1104, attemptKey: 'pending:6000' }).state
      expect(state.attempts).toBe(3)
      state = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1105, attemptKey: 'pending:6000' }).state
      expect(state.attempts).toBe(3)

      // …and the third episode's first attach exceeds the bound: the strip
      // shows. Repeated progressless episodes still reach it honestly.
      const third = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1206, attemptKey: 'pending:7000' })
      expect(third.allowed).toBe(false)
      expect(third.state.exhausted).toBe(true)
    })

    it('genuine progress and explicit retry clear the episode key', () => {
      let state = createTerminalRecoveryAccounting()
      state = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1000 }).state
      state = beginRecoveryAttempt(state, { coverageSeq: 0, now: 1001, attemptKey: 'pending:5000' }).state
      expect(state.lastAttemptKey).toBe('pending:5000')

      // Live output resets the streak AND the episode key: a later attach
      // with the same key cannot ride a dead episode.
      state = recordRecoveryProgress(state, 9, 1002)
      expect(state.lastAttemptKey).toBeNull()
      const afterProgress = beginRecoveryAttempt(state, { coverageSeq: 9, now: 1003, attemptKey: 'pending:5000' })
      expect(afterProgress.state.attempts).toBe(1)

      state = resetRecoveryAccounting(afterProgress.state, 9, 1004)
      expect(state.lastAttemptKey).toBeNull()
    })
  })
})
