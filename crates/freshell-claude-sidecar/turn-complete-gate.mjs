/**
 * Unified "needs attention" turn-complete gate (freshell-claude-sidecar).
 *
 * Every SDK `result` — success, error_during_execution, error_max_turns,
 * error_max_budget_usd, error_max_structured_output_retries, and
 * success-with-is_error — ends a turn the user may not have been watching,
 * so every result emits `sdk.turn.complete`. The ONE exception is a
 * user-initiated interrupt: per the SDK contract the `interrupt_settled`
 * receipt lands BEFORE the interrupted turn's own terminal result, so an
 * accepted interrupt arms a mark that consumes (and suppresses) exactly
 * that result. A rejected interrupt (ok:false — the turn kept running)
 * clears the mark.
 *
 * There is DELIBERATELY no reset-on-send: the SDK serializes turns within
 * one query (a queued send is input pushed onto the same stream, and
 * results arrive in turn order), so the interrupted turn's result is
 * deterministically the FIRST result after the accepted settle. A
 * reset-at-send would race a queued send against the interrupted turn's
 * late result and let the user's own interrupt ring. Staleness is bounded
 * by the session lifecycle instead — the mark dies with the session state
 * when consumeStream's finally deletes it.
 */
export function createTurnCompleteGate() {
  let userInterruptPending = false
  return {
    noteInterruptRequest() { userInterruptPending = true },
    noteInterruptSettled(ok) { if (!ok) userInterruptPending = false },
    resultEmitsAttention() {
      const interrupted = userInterruptPending
      userInterruptPending = false
      return !interrupted
    },
  }
}
