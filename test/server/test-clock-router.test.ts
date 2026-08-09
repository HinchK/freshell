/**
 * HARNESS-14 (legacy half) — `server/test-clock-router.ts`: the five
 * `/api/test-clock*` control endpoints, byte-parity with the Rust
 * `crates/freshell-server/src/test_clock_router.rs` surface. Mounted in
 * `server/index.ts` after `httpAuthMiddleware`; every handler ALSO
 * re-checks the `FRESHELL_TEST_CLOCK` gate and answers the catch-all's
 * indistinguishable 404 when off (defense in depth).
 */
import { describe, expect, it, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createTestClockRouter } from '../../server/test-clock-router.js'
import {
  MAX_ADVANCE_MS,
  __setTestClockEnabledOverrideForTests,
  resetTestClock,
} from '../../server/test-clock.js'

function app() {
  const a = express()
  a.use(express.json())
  a.use('/api', createTestClockRouter())
  return request(a)
}

describe('server/test-clock-router (HARNESS-14)', () => {
  afterEach(() => {
    __setTestClockEnabledOverrideForTests(true)
    resetTestClock()
    __setTestClockEnabledOverrideForTests(null)
  })

  it('gate off: every verb is an indistinguishable 404', async () => {
    __setTestClockEnabledOverrideForTests(false)
    for (const [method, path] of [
      ['get', '/api/test-clock'],
      ['post', '/api/test-clock/advance'],
      ['post', '/api/test-clock/freeze'],
      ['post', '/api/test-clock/resume'],
      ['post', '/api/test-clock/reset'],
    ] as const) {
      const res = await app()[method](path)
      expect(res.status, `${method} ${path}`).toBe(404)
      expect(res.body).toEqual({ error: 'Not found' })
    }
  })

  it('gate on: GET reports enabled live state near wall clock', async () => {
    __setTestClockEnabledOverrideForTests(true)
    resetTestClock()
    const res = await app().get('/api/test-clock')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.enabled).toBe(true)
    expect(res.body.mode).toBe('live')
    expect(res.body.offsetMs).toBe(0)
    expect(Math.abs(res.body.nowMs - Date.now())).toBeLessThan(5000)
  })

  it('advance/freeze/resume/reset round-trip over HTTP', async () => {
    __setTestClockEnabledOverrideForTests(true)
    resetTestClock()

    let res = await app().post('/api/test-clock/advance').send({ ms: 90_000 })
    expect(res.status).toBe(200)
    expect(res.body.offsetMs).toBe(90_000)

    res = await app().post('/api/test-clock/freeze')
    expect(res.status).toBe(200)
    expect(res.body.mode).toBe('frozen')
    const held = res.body.nowMs
    await new Promise((r) => setTimeout(r, 20))
    res = await app().get('/api/test-clock')
    expect(res.body.nowMs).toBe(held)

    res = await app().post('/api/test-clock/resume')
    expect(res.status).toBe(200)
    expect(res.body.mode).toBe('live')
    expect(Math.abs(res.body.nowMs - held)).toBeLessThan(1000)

    res = await app().post('/api/test-clock/reset')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ mode: 'live', offsetMs: 0 })
  })

  it('advance rejects invalid bodies with 400 invalid_advance and mutates nothing', async () => {
    __setTestClockEnabledOverrideForTests(true)
    resetTestClock()
    for (const bad of [
      { ms: -1 },
      { ms: 1.5 },
      { ms: '60000' },
      { ms: MAX_ADVANCE_MS + 1 },
      {},
      'hello',
    ]) {
      const res = await app().post('/api/test-clock/advance').send(bad as never)
      expect(res.status, JSON.stringify(bad)).toBe(400)
      expect(res.body.error).toBe('invalid_advance')
      expect(typeof res.body.message).toBe('string')
    }
    // No body at all: also a 400 (parity with `req.body || {}`).
    const res = await app().post('/api/test-clock/advance')
    expect(res.status).toBe(400)
    const state = await app().get('/api/test-clock')
    expect(state.body.offsetMs).toBe(0)
  })
})
