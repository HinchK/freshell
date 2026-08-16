// Regression test for the findFreePort TOCTOU consumer race (kata f3wp):
// if the picked port is stolen before the spawned freshell-server binds it,
// start() must retry with a fresh port instead of failing the whole fixture.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import http from 'node:http'
import { RustServer } from './rust-server.js'
import { findFreePort } from './test-server.js'

describe('RustServer.start bind-race retry', () => {
  it('boots on a fresh port when the first picked port is occupied', async () => {
    // Occupy a port and hold it for the duration of the test. Track accepted
    // sockets: the health poll that hits the blocker gets aborted client-side,
    // but undici leaves the pooled TCP connection half-open (empirically: it
    // never closes), and net.Server.close() waits FOREVER for open
    // connections -- without destroying them, teardown hangs until the test
    // timeout (observed: 600 s).
    const blocker = net.createServer()
    const blockerSockets = new Set<net.Socket>()
    blocker.on('connection', (socket) => {
      blockerSockets.add(socket)
      socket.on('close', () => blockerSockets.delete(socket))
    })
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject)
      blocker.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = blocker.address()
    if (!addr || typeof addr === 'string') throw new Error('no blocker port')
    const stolenPort = addr.port

    // Count picker invocations: vitest does NOT typecheck, so an unknown
    // `portPicker` option would be silently ignored pre-implementation and
    // start() would boot on a fresh findFreePort() port -- making the port
    // assertions below pass vacuously. The call-count assertion is what
    // makes this test genuinely RED before the seam exists (f3wp validated).
    let pickerCalls = 0
    const server = new RustServer({
      portPicker: async () => {
        pickerCalls++
        if (pickerCalls === 1) return stolenPort
        return findFreePort()
      },
    })
    try {
      const info = await server.start()
      expect(pickerCalls).toBeGreaterThanOrEqual(2) // seam consumed AND retried
      expect(info.port).not.toBe(stolenPort)
      expect(info.port).not.toBe(3001)
      expect(info.port).not.toBe(3002)
      const res = await fetch(`${info.baseUrl}/api/health`)
      expect(res.ok).toBe(true)
    } finally {
      await server.stop()
      // Destroy the lingering half-open connection (see comment above) so
      // blocker.close() can actually complete.
      for (const socket of blockerSockets) socket.destroy()
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  }, 600_000)

  // Regression test for kata f3wp council round 2 (B6): a foreign server that
  // answers /api/health but STALLS on the /api/server-info identity check
  // must be retried like any other bind race, not hard-failed. Before the
  // fix, AbortSignal.timeout()'s TimeoutError didn't match the bindRace
  // classifier, so start() threw immediately with full teardown instead of
  // "failing fast into the next attempt" as its own comment promised.
  it('retries when a foreign server on the picked port stalls the identity check', async () => {
    // A real HTTP server that answers /api/health (so waitForHealth's poll
    // succeeds and boot() proceeds to the identity check) but NEVER responds
    // to /api/server-info -- the request just hangs until our 2s
    // AbortSignal.timeout fires, reproducing the stalled-identity shape.
    const blocker = http.createServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      // /api/server-info (or anything else): never respond, never end.
    })
    const blockerSockets = new Set<import('node:net').Socket>()
    blocker.on('connection', (socket) => {
      blockerSockets.add(socket)
      socket.on('close', () => blockerSockets.delete(socket))
    })
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject)
      blocker.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = blocker.address()
    if (!addr || typeof addr === 'string') throw new Error('no blocker port')
    const stolenPort = addr.port

    let pickerCalls = 0
    const server = new RustServer({
      portPicker: async () => {
        pickerCalls++
        if (pickerCalls === 1) return stolenPort
        return findFreePort()
      },
    })
    try {
      const info = await server.start()
      // Retried past the stalled occupier onto a fresh port: proves the
      // TimeoutError was classified as a retryable bind race, not a hard
      // failure.
      expect(pickerCalls).toBeGreaterThanOrEqual(2)
      expect(info.port).not.toBe(stolenPort)
      const res = await fetch(`${info.baseUrl}/api/health`)
      expect(res.ok).toBe(true)
    } finally {
      await server.stop()
      for (const socket of blockerSockets) socket.destroy()
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  }, 600_000)
})

describe('RustServer stripEnvPrefixes', () => {
  // task-008-review M-3: the AGENT-24 kilroy lane must prove independence
  // from Gemini-summary availability STRUCTURALLY — a developer machine's
  // GEMINI_API_KEY must not leak through boot()'s `...process.env` spread
  // (an options.env entry can only add/override keys, never delete inherited
  // ones). Observed via the child's exec-time /proc/<pid>/environ (Linux).
  // Genuinely RED without the option: the probe key lands in the child env.
  it('deletes inherited env keys with the given prefixes from the spawned server', async () => {
    expect(process.platform, 'relies on /proc/<pid>/environ').toBe('linux')
    process.env.GEMINI_STRIP_PROBE = 'present'
    const server = new RustServer({ stripEnvPrefixes: ['GEMINI_'] })
    try {
      const info = await server.start()
      const keys = fs
        .readFileSync(`/proc/${info.pid}/environ`, 'utf8')
        .split('\0')
        .map((kv) => kv.split('=', 1)[0])
        .filter(Boolean)
      expect(
        keys.filter((k) => k.startsWith('GEMINI_')),
        'no GEMINI_* key may survive into the spawned server env',
      ).toEqual([])
    } finally {
      delete process.env.GEMINI_STRIP_PROBE
      await server.stop()
    }
  }, 600_000)
})
