/**
 * HARNESS-14 — the legacy server's controllable test clock.
 *
 * One optional process-wide epoch-ms clock, env-gated by
 * `FRESHELL_TEST_CLOCK=1` (or `true`). Behavior-identical port of the Rust
 * side (`crates/freshell-platform/src/clock.rs`) — see that module's doc
 * comment for the full semantics; both must offer the SAME verbs, mode
 * strings, and-cap, so a spec can drive either server implementation
 * identically:
 *
 *   enabled path: effective time = frozen ? held : Date.now() + offsetMs
 *   advance(ms)   advance-only, frozen steps the held value (monotonic;
 *                 no arbitrary set — consumers use `now - stamp` deltas and
 *                 a backward jump would wedge idle/TTL math)
 *   freeze()      capture current effective time (idempotent)
 *   resume()      continue LIVE from the held value (no catch-up jump)
 *   reset()       offset 0 + live (pure wall clock again)
 *
 * Gate OFF (every normal build/run — the var is never set by any launcher):
 * `testClockNowMs()` is an identity passthrough to `Date.now()` and every
 * control verb returns `{ ok:false, error:'disabled' }` without mutating.
 * The REST control router (`test-clock-router.ts`) is only mounted under
 * the same gate in `server/index.ts`, so the surface cannot exist in a
 * normal boot at all.
 */

export const TEST_CLOCK_ENV = 'FRESHELL_TEST_CLOCK'

/** Max single advance: 31 days (covers the largest threshold — the 24h
 *  agent idle hard cap — with headroom; bounds runaway test bugs). */
export const MAX_ADVANCE_MS = 31 * 24 * 60 * 60 * 1000

export type TestClockMode = 'live' | 'frozen'

export interface TestClockSnapshot {
  enabled: boolean
  mode: TestClockMode
  nowMs: number
  offsetMs: number
}

export type TestClockResult =
  | ({ ok: true } & TestClockSnapshot)
  | { ok: false; error: 'disabled' | 'invalid' }

// ── state (process-wide singleton; the whole transition is synchronous,
//    so Node's single thread makes each verb atomic without locks) ────────
let offsetMs = 0
let frozenAtMs: number | null = null

// The gate is read ONCE (parity with the Rust OnceLock): a server boot
// either has the test clock or it does not; mid-run env flips don't count.
const envEnabled = (() => {
  const raw = (process.env[TEST_CLOCK_ENV] ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true'
})()

let enabledOverride: boolean | null = null

/** Test-only seam (parity with the Rust `#[doc(hidden)]` override): `true`/
 *  `false` forces the gate, `null` restores env-driven behavior. */
export function __setTestClockEnabledOverrideForTests(value: boolean | null): void {
  enabledOverride = value
}

export function testClockEnabled(): boolean {
  return enabledOverride ?? envEnabled
}

function effectiveNowMs(): number {
  return frozenAtMs ?? Date.now() + offsetMs
}

/** Effective epoch ms. Gate-off fast path adds zero overhead. */
export function testClockNowMs(): number {
  if (!testClockEnabled()) return Date.now()
  return effectiveNowMs()
}

export function testClockSnapshot(): TestClockSnapshot {
  const enabled = testClockEnabled()
  // Gate-off answer is deliberately INERT (live, zero offset, wall now) so
  // disabled-state callers can never observe leftover virtual state.
  return enabled
    ? { enabled, mode: frozenAtMs !== null ? 'frozen' : 'live', nowMs: effectiveNowMs(), offsetMs }
    : { enabled, mode: 'live', nowMs: Date.now(), offsetMs: 0 }
}

/** Advance effective time by `ms` (frozen: steps the held value). Rejects
 *  non-integer / negative / over-cap deltas WITHOUT mutating. */
export function advanceTestClockMs(ms: number): TestClockResult {
  if (!testClockEnabled()) return { ok: false, error: 'disabled' }
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_ADVANCE_MS) {
    return { ok: false, error: 'invalid' }
  }
  if (frozenAtMs !== null) frozenAtMs += ms
  else offsetMs += ms
  return { ok: true, ...testClockSnapshot() }
}

/** Hold effective time at its current value until resume (idempotent). */
export function freezeTestClock(): TestClockResult {
  if (!testClockEnabled()) return { ok: false, error: 'disabled' }
  if (frozenAtMs === null) frozenAtMs = Date.now() + offsetMs
  return { ok: true, ...testClockSnapshot() }
}

/** Continue live FROM the held value (monotonic, no catch-up jump). */
export function resumeTestClock(): TestClockResult {
  if (!testClockEnabled()) return { ok: false, error: 'disabled' }
  if (frozenAtMs !== null) {
    offsetMs = frozenAtMs - Date.now()
    frozenAtMs = null
  }
  return { ok: true, ...testClockSnapshot() }
}

/** Back to pure wall clock (offset 0, live). */
export function resetTestClock(): TestClockResult {
  if (!testClockEnabled()) return { ok: false, error: 'disabled' }
  offsetMs = 0
  frozenAtMs = null
  return { ok: true, ...testClockSnapshot() }
}
