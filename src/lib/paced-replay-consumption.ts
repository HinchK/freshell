/**
 * Paced terminal replay consumption (responsive-terminal-restore Workstream 1,
 * client side): the ordered write-queue consumption frontier for ONE paced
 * attach generation of ONE terminal, and the coalescing decision that turns
 * frontier advances into `terminal.replay.credit` messages.
 *
 * The frontier is DISTINCT from the parser-applied checkpoint
 * (`terminal-attach-seq-state`): a frame counts as consumed when it is
 * applied through the write queue OR fully consumed by a null-screen-effect
 * pre-parser (startup probes, OSC52, turn-complete signals) — the checkpoint
 * still refuses filtered ranges. Unknown mutations (today's unapplied /
 * quarantine path) never advance the frontier; that range forfeits credit
 * and the server's retention/expiry handling covers the consequence.
 *
 * Credit rules mirror the server contract (`crates/freshell-ws/src/
 * paced_replay.rs`): a credit is due when the frontier moves beyond the last
 * credited value; `consumedSeq` never exceeds the highest received seq and —
 * once the frontier crosses the attach's session-window end — credits stop at
 * the window end (the server drains the accumulated tail un-credited and
 * completes; post-completion credits are stale generations it would ignore).
 * All values are generation-scoped by the caller: this state exists only for
 * the CURRENT `attachRequestId` and is replaced by the next attach.
 */
export type PacedReplayConsumptionState = {
  terminalId: string
  attachRequestId: string
  /** attach.ready `replayToSeq` — the paced session window end (the credit ceiling). */
  targetSeq: number | null
  /** Highest ordered seqEnd consumed (applied via the write queue or fully pre-filtered). */
  frontierSeq: number
  /** Highest seqEnd received for this generation (frames or gap bounds). */
  lastReceivedSeq: number
  /** Last consumedSeq actually credited — the coalescing guard. */
  lastSentCreditSeq: number
}

export type PacedReplayCredit = {
  terminalId: string
  attachRequestId: string
  consumedSeq: number
}

export type PacedReplayCreditDecision = {
  state: PacedReplayConsumptionState
  credit: PacedReplayCredit | null
}

function normalizeSeq(seq: number): number {
  return Number.isFinite(seq) ? Math.max(0, Math.floor(seq)) : 0
}

/**
 * Arm the consumption frontier for one paced attach generation. The frontier
 * starts at the attach's `sinceSeq` baseline: everything at or below it is
 * either already on the surface (delta attach) or nothing (full hydrate),
 * and the server's own credited cursor starts at the same baseline.
 */
export function beginPacedReplayConsumption(input: {
  terminalId: string
  attachRequestId: string
  sinceSeq: number
}): PacedReplayConsumptionState {
  const sinceSeq = normalizeSeq(input.sinceSeq)
  return {
    terminalId: input.terminalId,
    attachRequestId: input.attachRequestId,
    targetSeq: null,
    frontierSeq: sinceSeq,
    lastReceivedSeq: sinceSeq,
    lastSentCreditSeq: sinceSeq,
  }
}

/**
 * Record the session window end from the paced `attach.ready`
 * (`replayToSeq` — the fixed catch-up target at attach time; on paced ready
 * frames `replayFromSeq`/`replayToSeq` describe the SESSION window, never a
 * single page's bounds).
 */
export function pacedReplayOnReady(
  state: PacedReplayConsumptionState,
  ready: { replayToSeq: number },
): PacedReplayConsumptionState {
  const targetSeq = normalizeSeq(ready.replayToSeq)
  if (state.targetSeq === targetSeq) return state
  return { ...state, targetSeq }
}

/** Track the highest received seqEnd (output frames or gap bounds). */
export function pacedReplayMarkReceived(
  state: PacedReplayConsumptionState,
  seqEnd: number,
): PacedReplayConsumptionState {
  const received = normalizeSeq(seqEnd)
  if (received <= state.lastReceivedSeq) return state
  return { ...state, lastReceivedSeq: received }
}

/**
 * Advance the ordered consumption frontier to `seqEnd`: a frame was applied
 * through the write queue or fully consumed by a null-screen-effect
 * pre-parser. Monotonic — a regressed value changes nothing.
 */
export function pacedReplayConsumeThrough(
  state: PacedReplayConsumptionState,
  seqEnd: number,
): PacedReplayConsumptionState {
  const consumed = normalizeSeq(seqEnd)
  if (consumed <= state.frontierSeq) return state
  return { ...state, frontierSeq: consumed }
}

/**
 * Decide the next coalesced credit for the drain that is flushing now: at
 * most one credit per drain tick, carrying the current frontier clamped to
 * both the highest received seq and the session-window end. `null` when the
 * frontier has not moved past the last credited value (nothing new to
 * acknowledge — the steady post-restore state).
 */
export function pacedReplayNextCredit(
  state: PacedReplayConsumptionState,
): PacedReplayCreditDecision {
  if (state.targetSeq === null) return { state, credit: null }
  const frontier = Math.min(state.frontierSeq, state.lastReceivedSeq, state.targetSeq)
  if (frontier <= state.lastSentCreditSeq) return { state, credit: null }
  const next = { ...state, lastSentCreditSeq: frontier }
  return {
    state: next,
    credit: {
      terminalId: state.terminalId,
      attachRequestId: state.attachRequestId,
      consumedSeq: frontier,
    },
  }
}
