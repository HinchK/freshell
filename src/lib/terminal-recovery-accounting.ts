/**
 * Bounded automatic recovery accounting (responsive-terminal-restore
 * Workstream 2): one state object per terminal pane, gating automatic
 * attach/hydrate cycling.
 *
 * The progress signal is the SURFACE COVERAGE CURSOR — genuine consumption of
 * stream content (applied or fully pre-filtered). Receiving `attach.ready` or
 * another reconnect is NOT progress. The accounting resets on genuine
 * coverage progress or an explicit user retry; it NEVER triggers a kill, a
 * replacement, or an identity change — reaching the bound only stops
 * automatic attaches and shows a visible retry state.
 *
 * Bounds (constants per repo conventions, overridable by tests via `now`):
 * - at most TERMINAL_RECOVERY_MAX_ATTEMPTS consecutive progressless attempts;
 * - a progressless streak older than TERMINAL_RECOVERY_NO_PROGRESS_DEADLINE_MS
 *   with at least two attempts sent (a single stray re-attach after an idle
 *   pane is never blocked by the deadline alone).
 */
export const TERMINAL_RECOVERY_MAX_ATTEMPTS = 3
export const TERMINAL_RECOVERY_NO_PROGRESS_DEADLINE_MS = 30_000

export type TerminalRecoveryAccounting = {
  /** Highest coverage position that ever reset the streak. */
  lastProgressSeq: number
  /** Consecutive attach/hydrate attempts sent without coverage progress. */
  attempts: number
  /** When the current progressless streak started (null when clean). */
  streakStartedAt: number | null
  /** True once a bound was hit; blocks every automatic attempt until reset. */
  exhausted: boolean
  /**
   * False until the pane's INITIAL hydration attach is observed. The first
   * attach of a pane is initial hydration, not recovery cycling — it never
   * counts toward the bound (a reconcile-verdict episode legitimately fires
   * several deliberate re-attaches right after it).
   */
  initialAttachConsumed: boolean
  /**
   * Reconcile-episode key of the last COUNTED attempt (M-1): a reconcile
   * episode (pending window → verdict fold) deliberately re-attaches a
   * live-terminal pane several times with no coverage progress; every
   * attach carrying the SAME key collapses into the single attempt that
   * opened the episode. A NEW key counts as its own attempt, so repeated
   * progressless episodes stay bounded. Null when the last counted attempt
   * was keyless (a transport reconnect) or after a progress/retry reset —
   * keyless attempts never clear it, so an episode survives an interleaved
   * ws flap.
   */
  lastAttemptKey: string | null
}

export function createTerminalRecoveryAccounting(): TerminalRecoveryAccounting {
  return {
    lastProgressSeq: 0,
    attempts: 0,
    streakStartedAt: null,
    exhausted: false,
    initialAttachConsumed: false,
    lastAttemptKey: null,
  }
}

/**
 * Record genuine coverage progress. Idempotent: re-reporting the current
 * position changes nothing; only an ADVANCE resets the streak (and clears
 * exhaustion — live output on a stuck pane proves the surface is not dead).
 */
export function recordRecoveryProgress(
  state: TerminalRecoveryAccounting,
  coverageSeq: number,
  _now: number,
): TerminalRecoveryAccounting {
  if (coverageSeq <= state.lastProgressSeq) return state
  return {
    ...state,
    lastProgressSeq: coverageSeq,
    attempts: 0,
    streakStartedAt: null,
    exhausted: false,
    lastAttemptKey: null,
  }
}

/**
 * Round-4 reversal (plan:166): there is deliberately NO restore-success
 * entry point. "Reset recovery accounting on genuine parser progress or
 * explicit retry, not merely on receiving attach.ready or another
 * reconnect" — a converged idle pane's clean, cursor-confirmed,
 * empty-window reconnect is the plan's own example of NOT progress, and
 * its flap cycle must exhaust to the visible retry strip like any other
 * progressless cycle (with the content preserved and the accessible
 * retry state). Genuine progress resets through `recordRecoveryProgress`
 * at the frame-application site; explicit retry through
 * `resetRecoveryAccounting`.
 */

/**
 * Decide whether ONE automatic attach attempt may proceed, folding in any
 * progress-since-last-attempt first. `allowed: false` means the bound was
 * reached: the caller stops automatic re-attach cycling and shows the
 * visible retry state (the accounting stays exhausted until progress or an
 * explicit retry resets it). `input.attemptKey` (when present) identifies
 * the reconcile episode the attach belongs to: same-key attaches are
 * allowed without consuming the budget again (see
 * TerminalRecoveryAccounting.lastAttemptKey).
 */
export function beginRecoveryAttempt(
  state: TerminalRecoveryAccounting,
  input: { coverageSeq: number; now: number; attemptKey?: string },
): { state: TerminalRecoveryAccounting; allowed: boolean } {
  const progressed = recordRecoveryProgress(state, input.coverageSeq, input.now)
  if (!state.initialAttachConsumed) {
    // The pane's INITIAL hydration attach: never counts toward the bound.
    return {
      state: { ...progressed, initialAttachConsumed: true },
      allowed: true,
    }
  }
  if (progressed !== state) {
    return { state: progressed, allowed: true }
  }
  if (state.exhausted) {
    return { state, allowed: false }
  }
  // Reconcile-episode collapse (M-1): every attach of the episode that
  // already consumed its single counted attempt is allowed without
  // counting again.
  if (input.attemptKey !== undefined && input.attemptKey === state.lastAttemptKey) {
    return { state, allowed: true }
  }
  const attempts = state.attempts
  const streakStartedAt = state.streakStartedAt ?? input.now
  const deadlineExceeded = attempts >= 2
    && input.now - streakStartedAt >= TERMINAL_RECOVERY_NO_PROGRESS_DEADLINE_MS
  if (attempts >= TERMINAL_RECOVERY_MAX_ATTEMPTS || deadlineExceeded) {
    return { state: { ...state, exhausted: true }, allowed: false }
  }
  return {
    state: {
      ...state,
      attempts: attempts + 1,
      streakStartedAt,
      // Keyless attempts keep the previous episode's key (an interleaved
      // ws flap must not refund it); keyed attempts become the new
      // episode's anchor.
      ...(input.attemptKey !== undefined ? { lastAttemptKey: input.attemptKey } : {}),
    },
    allowed: true,
  }
}

/**
 * Explicit user retry (the visible retry control, or an explicit pane
 * refresh): resets the accounting to clean and re-arms automatic recovery
 * from the current coverage position.
 */
export function resetRecoveryAccounting(
  state: TerminalRecoveryAccounting,
  coverageSeq: number,
  _now: number,
): TerminalRecoveryAccounting {
  return {
    lastProgressSeq: coverageSeq,
    attempts: 0,
    streakStartedAt: null,
    exhausted: false,
    lastAttemptKey: null,
    // An explicit retry happens on an already-hydrated pane: the initial
    // attach exemption stays consumed.
    initialAttachConsumed: true,
  }
}
