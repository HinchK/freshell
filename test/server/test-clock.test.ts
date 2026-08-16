/**
 * HARNESS-14 (legacy half) — `server/test-clock.ts` semantics parity with
 * `crates/freshell-platform/src/clock.rs`: one optional process-wide
 * epoch-ms clock gated by `FRESHELL_TEST_CLOCK`, advanced/frozen/resumed/reset
 * from the REST control surface, shared by idle cleanup, the terminal.create
 * rate window, and the tabs-registry TTL/retention clock.
 */
import { describe, expect, it, afterEach } from 'vitest'
import {
  MAX_ADVANCE_MS,
  TEST_CLOCK_ENV,
  __setTestClockEnabledOverrideForTests,
  advanceTestClockMs,
  freezeTestClock,
  resetTestClock,
  resumeTestClock,
  testClockEnabled,
  testClockNowMs,
  testClockSnapshot,
} from '../../server/test-clock.js'

const realNow = () => Date.now()

describe('server/test-clock (HARNESS-14)', () => {
  afterEach(() => {
    // The server vitest config SHUFFLES test order: normalize BOTH the
    // clock state and the override after every test so no test can observe
    // another's leftover virtual state.
    __setTestClockEnabledOverrideForTests(true)
    resetTestClock()
    __setTestClockEnabledOverrideForTests(null)
  })

  describe('gate off (default production behavior)', () => {
    it('is disabled with no env var and no override', () => {
      delete process.env[TEST_CLOCK_ENV]
      __setTestClockEnabledOverrideForTests(null)
      expect(testClockEnabled()).toBe(false)
    })

    it('nowMs is an identity passthrough to Date.now', () => {
      __setTestClockEnabledOverrideForTests(false)
      const before = realNow()
      const t = testClockNowMs()
      const after = realNow()
      expect(t).toBeGreaterThanOrEqual(before)
      expect(t).toBeLessThanOrEqual(after)
    })

    it('control verbs are Disabled no-ops and the snapshot is honest', () => {
      __setTestClockEnabledOverrideForTests(false)
      expect(advanceTestClockMs(1000)).toEqual({ ok: false, error: 'disabled' })
      expect(freezeTestClock()).toEqual({ ok: false, error: 'disabled' })
      expect(resumeTestClock()).toEqual({ ok: false, error: 'disabled' })
      expect(resetTestClock()).toEqual({ ok: false, error: 'disabled' })
      const snap = testClockSnapshot()
      expect(snap.enabled).toBe(false)
      expect(snap.mode).toBe('live')
      expect(snap.offsetMs).toBe(0)
    })
  })

  describe('enabled transitions', () => {
    it('advance increases the LIVE offset by exactly the delta', () => {
      __setTestClockEnabledOverrideForTests(true)
      resetTestClock()
      const before = testClockSnapshot()
      const r = advanceTestClockMs(90_000)
      expect(r.ok).toBe(true)
      const after = testClockSnapshot()
      expect(after.offsetMs - before.offsetMs).toBe(90_000)
      expect(after.nowMs).toBeGreaterThanOrEqual(before.nowMs + 90_000)
      expect(after.mode).toBe('live')
    })

    it('freeze holds time constant across real elapsed time', async () => {
      __setTestClockEnabledOverrideForTests(true)
      resetTestClock()
      advanceTestClockMs(60_000)
      const frozen = freezeTestClock()
      expect(frozen).toMatchObject({ ok: true, mode: 'frozen' })
      const heldAt = testClockSnapshot().nowMs
      await new Promise((r) => setTimeout(r, 20))
      expect(testClockSnapshot().nowMs).toBe(heldAt)
    })

    it('advance while FROZEN steps the held value exactly and composes', () => {
      __setTestClockEnabledOverrideForTests(true)
      resetTestClock()
      const frozenNow = freezeTestClock().ok ? testClockSnapshot().nowMs : 0
      advanceTestClockMs(5 * 60_000)
      expect(testClockSnapshot().nowMs).toBe(frozenNow + 5 * 60_000)
      advanceTestClockMs(11 * 60_000)
      const snap = testClockSnapshot()
      expect(snap.nowMs).toBe(frozenNow + 16 * 60_000)
      expect(snap.mode).toBe('frozen')
    })

    it('freeze is idempotent (re-freeze never drifts the held value)', async () => {
      __setTestClockEnabledOverrideForTests(true)
      resetTestClock()
      freezeTestClock()
      const heldAt = testClockSnapshot().nowMs
      await new Promise((r) => setTimeout(r, 5))
      freezeTestClock()
      expect(testClockSnapshot().nowMs).toBe(heldAt)
    })

    it('resume continues from the held value with no catch-up jump', async () => {
      __setTestClockEnabledOverrideForTests(true)
      resetTestClock()
      advanceTestClockMs(120_000)
      const frozenNow = (() => { freezeTestClock(); return testClockSnapshot().nowMs })()
      const resumed = resumeTestClock()
      expect(resumed).toMatchObject({ ok: true, mode: 'live' })
      expect(Math.abs(testClockSnapshot().nowMs - frozenNow)).toBeLessThan(1000)
      await new Promise((r) => setTimeout(r, 20))
      const later = testClockSnapshot()
      expect(later.nowMs).toBeGreaterThanOrEqual(frozenNow)
      expect(later.nowMs - frozenNow).toBeLessThan(1000)
    })

    it('reset restores pure wall clock (offset 0, live)', () => {
      __setTestClockEnabledOverrideForTests(true)
      resetTestClock()
      advanceTestClockMs(600_000)
      freezeTestClock()
      const snap = resetTestClock()
      expect(snap).toMatchObject({ ok: true, mode: 'live', offsetMs: 0 })
      expect(Math.abs(testClockSnapshot().nowMs - realNow())).toBeLessThan(1000)
    })

    it('never goes backwards across advance/freeze/resume (reset excluded by design)', () => {
      __setTestClockEnabledOverrideForTests(true)
      resetTestClock()
      let last = testClockSnapshot().nowMs
      const check = () => {
        const now = testClockSnapshot().nowMs
        expect(now).toBeGreaterThanOrEqual(last)
        last = now
      }
      advanceTestClockMs(1); check()
      freezeTestClock(); check()
      advanceTestClockMs(3_600_000); check()
      resumeTestClock(); check()
      advanceTestClockMs(0); check()
    })
  })

  describe('advance validation', () => {
    it('rejects non-finite, negative, and over-cap deltas without mutating', () => {
      __setTestClockEnabledOverrideForTests(true)
      resetTestClock()
      const before = testClockSnapshot().nowMs
      for (const bad of [-1, NaN, Infinity, 1.5, MAX_ADVANCE_MS + 1] as const) {
        expect(advanceTestClockMs(bad)).toEqual({ ok: false, error: 'invalid' })
      }
      expect(Math.abs(testClockSnapshot().nowMs - before)).toBeLessThan(1000)
      // The cap boundary itself is IN range.
      expect(advanceTestClockMs(MAX_ADVANCE_MS).ok).toBe(true)
    })
  })

  describe('override seam', () => {
    it('forcing disabled mid-use makes verbs Disabled and nowMs real', () => {
      __setTestClockEnabledOverrideForTests(true)
      resetTestClock()
      advanceTestClockMs(60_000)
      __setTestClockEnabledOverrideForTests(false)
      expect(testClockEnabled()).toBe(false)
      expect(advanceTestClockMs(1000)).toEqual({ ok: false, error: 'disabled' })
      expect(Math.abs(testClockSnapshot().nowMs - realNow())).toBeLessThan(1000)
      // Re-enabling exposes the stale offset again (no hidden clearing).
      __setTestClockEnabledOverrideForTests(true)
      expect(testClockSnapshot().offsetMs).toBeGreaterThanOrEqual(60_000)
    })
  })
})
