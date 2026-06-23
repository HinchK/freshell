/**
 * Returns a per-session strictly-monotonic turn-complete timestamp.
 *
 * Fresh-agent turn completions are deduped on the client by the wall-clock `at`,
 * chosen over a per-session counter because a counter resets to zero on a server
 * restart and would swallow completions for a resumed durable session. Raw
 * `Date.now()` is not a reliable per-turn identity, though: two genuine
 * completions can land in the same millisecond, and the system clock can step
 * backwards (NTP correction). Either case would make a real later completion look
 * `<= last` and be dropped as a stale replay.
 *
 * Clamping each session's `at` to be strictly greater than its previous one
 * guarantees distinct turns never collide or regress *within a process*. It does
 * NOT by itself guarantee monotonicity across a restart — the clamp can push `at`
 * ahead of real wall time, and a fresh process may then stamp a lower value. That
 * residual gap is closed on the client, which clears its per-terminal `at`
 * baselines on a real server restart (`resetCompletionDedupeBaselines`).
 */
export function nextMonotonicTurnCompleteAt(lastAt: number | undefined, now: number): number {
  return lastAt !== undefined && now <= lastAt ? lastAt + 1 : now
}
