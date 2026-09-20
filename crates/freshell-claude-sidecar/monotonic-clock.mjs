/**
 * Per-session monotonic edge clock (freshell-claude-sidecar).
 *
 * The client folds `sdk.turn.complete` / `sdk.turn.waiting` edges under an
 * `at`-monotonic dedupe — an edge whose `at` is older-or-equal to the last
 * one seen for its session is silently dropped
 * (src/store/turnCompletionSlice.ts) — so every minted edge must be STRICTLY
 * greater than the previous one for that session even when two edges land in
 * the same millisecond or the wall clock stalls. This is the sidecar's
 * analog of the client's `nextMonotonicTurnCompleteAt`
 * (server/fresh-agent/turn-complete-clock.ts): ONE implementation of the
 * clamp, shared by every mint site — index.mjs's result/finally turn-complete
 * mints, the waiting edge injected into permission-channel.mjs, and the e2e
 * fake sidecar (imported next to turn-complete-gate.mjs) so the fixture
 * clamps identically to the real sidecar.
 */
export function nextMonotonic(last, now) {
  return last != null && now <= last ? last + 1 : now
}
