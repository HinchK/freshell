import { describe, expect, it } from 'vitest'
import { nextMonotonic } from '../../../crates/freshell-claude-sidecar/monotonic-clock.mjs'

// The clamp behind every `sdk.turn.complete` / `sdk.turn.waiting` mint in the
// real sidecar AND the e2e fake (task-004 review F-M1): the client folds edges
// under an `at <= last` per-session dedupe (src/store/turnCompletionSlice.ts),
// so two edges landing in the same millisecond MUST still carry strictly
// increasing `at` — a raw Date.now() mint silently loses the second ring.
describe('freshell-claude-sidecar monotonic edge clock', () => {
  it('uses now for the first edge of a session', () => {
    expect(nextMonotonic(undefined, 1_000)).toBe(1_000)
    expect(nextMonotonic(null, 1_000)).toBe(1_000)
  })

  it('bumps past the last minted at when two edges land in the same millisecond', () => {
    const first = nextMonotonic(undefined, 1_000)
    expect(nextMonotonic(first, 1_000)).toBe(1_001)
    expect(nextMonotonic(1_001, 1_001)).toBe(1_002)
  })

  it('bumps past the last minted at when the wall clock stalls or steps backward', () => {
    expect(nextMonotonic(2_000, 1_998)).toBe(2_001)
    expect(nextMonotonic(2_001, 2_000)).toBe(2_002)
  })

  it('uses a genuinely later now unchanged', () => {
    expect(nextMonotonic(1_000, 1_500)).toBe(1_500)
  })
})
