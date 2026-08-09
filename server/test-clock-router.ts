/**
 * HARNESS-14 — the legacy server's test-clock control surface.
 *
 * Five endpoints driving `server/test-clock.ts`, byte-parity with the Rust
 * surface (`crates/freshell-server/src/test_clock_router.rs`): same paths,
 * same JSON envelopes, same statuses. Mounted in `server/index.ts` AFTER
 * `httpAuthMiddleware` (so auth is identical to every other `/api/*`
 * route); each request ALSO re-checks the `testClockEnabled()` gate here
 * and answers the catch-all's indistinguishable 404 when off — defense in
 * depth, so the surface cannot exist in a normal build even if the mount
 * is ever misplaced. (`FRESHELL_TEST_CLOCK` is never set by any launcher.)
 */
import { Router } from 'express'
import {
  MAX_ADVANCE_MS,
  advanceTestClockMs,
  freezeTestClock,
  resetTestClock,
  resumeTestClock,
  testClockEnabled,
  testClockSnapshot,
} from './test-clock.js'

export function createTestClockRouter(): Router {
  const router = Router()

  // Handler-level gate: off == unmounted (the catch-all 404 body).
  router.use('/test-clock', (_req, res, next) => {
    if (!testClockEnabled()) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    next()
  })

  router.get('/test-clock', (_req, res) => {
    res.json({ ok: true, ...testClockSnapshot() })
  })

  router.post('/test-clock/advance', (req, res) => {
    // `req.body || {}` parity with the repo's zod-style routers: a missing
    // body is validated as `{}` and fails the ms check below with a 400.
    const body = (req.body ?? {}) as Record<string, unknown>
    const ms = body.ms
    if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 0 || ms > MAX_ADVANCE_MS) {
      res.status(400).json({
        ok: false,
        error: 'invalid_advance',
        message: 'body.ms must be an integer in [0, MAX_ADVANCE_MS] (31 days)',
      })
      return
    }
    const result = advanceTestClockMs(ms)
    if (!result.ok) {
      // Unreachable while gated (the gate checked first); never 500 a
      // control surface.
      res.status(404).json({ error: 'Not found' })
      return
    }
    res.json(result)
  })

  router.post('/test-clock/freeze', (_req, res) => {
    res.json(freezeTestClock())
  })

  router.post('/test-clock/resume', (_req, res) => {
    res.json(resumeTestClock())
  })

  router.post('/test-clock/reset', (_req, res) => {
    res.json(resetTestClock())
  })

  return router
}
