/**
 * Unified "needs attention" turn-complete gate (freshell-claude-sidecar).
 *
 * Every SDK `result` — success, error_during_execution, error_max_turns,
 * error_max_budget_usd, error_max_structured_output_retries, and
 * success-with-is_error — ends a turn the user may not have been watching,
 * so every result emits `sdk.turn.complete`. The ONE exception is a
 * user-initiated interrupt on a turn in flight: per the SDK contract the
 * `interrupt_settled` receipt lands BEFORE the interrupted turn's own
 * terminal result, so the arm site (index.mjs handleInterrupt) arms the mark
 * ONLY while a turn is plausibly awaiting a terminal frame —
 * `if (st.pendingResults > 0) st.turnCompleteGate.noteInterruptRequest()` —
 * and an accepted interrupt's mark then consumes (and suppresses) exactly
 * that result. The SDK RESOLVES an interrupt with nothing in flight
 * (sdk.d.ts:2384-2394 — resolution, not rejection; no result ever follows),
 * so an idle-session interrupt must arm NOTHING: a stray mark there would
 * survive and eat the NEXT unrelated turn's result. A rejected interrupt
 * (ok:false — the turn kept running) clears the mark.
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
