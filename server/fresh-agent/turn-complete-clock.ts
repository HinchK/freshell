/**
 * Returns a per-session strictly-monotonic turn-complete timestamp.
 *
 * Fresh-agent turn completions are deduped on the client by the wall-clock `at`
 * (it must stay monotonic across a server restart, where a per-session counter
 * would reset to zero and swallow completions for a resumed durable session).
 * Raw `Date.now()` is not a reliable per-turn identity, though: two genuine
 * completions can land in the same millisecond, and the system clock can step
 * backwards (NTP correction). Either case would make a real later completion look
 * `<= last` and be dropped as a stale replay.
 *
 * Clamping each session's `at` to be strictly greater than its previous one keeps
 * the wall-clock-seeded value (so restart monotonicity still holds) while
 * guaranteeing distinct turns never collide or regress within a process.
 */
export function nextMonotonicTurnCompleteAt(lastAt: number | undefined, now: number): number {
  return lastAt !== undefined && now <= lastAt ? lastAt + 1 : now
}
