// Regression test for the findFreePort TOCTOU consumer race (kata f3wp):
// if the picked port is stolen before the spawned freshell-server binds it,
// start() must retry with a fresh port instead of failing the whole fixture.
import { describe, it, expect } from 'vitest'
import net from 'node:net'
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
})
