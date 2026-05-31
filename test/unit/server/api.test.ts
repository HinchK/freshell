// @vitest-environment node
import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createHealthRouter } from '../../../server/health-router.js'

describe('GET /api/health', () => {
  it('returns unauthenticated launch discovery metadata', async () => {
    const app = express()

    app.use('/api/health', createHealthRouter({
      appVersion: '1.2.3',
      instanceId: 'instance-test-id',
      isReady: () => true,
      startedAt: new Date('2026-05-24T12:00:00.000Z'),
    }))

    app.use('/api', (_req, res) => {
      res.status(401).json({ error: 'Unauthorized' })
    })

    const res = await request(app).get('/api/health')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      app: 'freshell',
      ok: true,
      requiresAuth: true,
      version: '1.2.3',
      ready: true,
      instanceId: 'instance-test-id',
      startedAt: '2026-05-24T12:00:00.000Z',
    })
    expect(typeof res.body.version).toBe('string')
    expect(typeof res.body.ready).toBe('boolean')
    expect(typeof res.body.instanceId).toBe('string')
    expect(typeof res.body.startedAt).toBe('string')
  })
})
