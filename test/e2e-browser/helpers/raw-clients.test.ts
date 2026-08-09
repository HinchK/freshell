/**
 * HARNESS-05 — unit tests for the raw HTTP/WebSocket Playrunner-runner
 * clients and their deterministic echo/error fixture. See
 * docs/plans/df1/HARNESS-05.md.
 *
 * These run under the dedicated E2E-helper vitest config
 * (`test/e2e-browser/vitest.config.ts`), NOT the coordinated suite.
 */
import { describe, it, expect, afterEach } from 'vitest'
import WebSocket from 'ws'
import { EchoWsFixture } from './echo-ws-fixture.js'

/** Connect a vendored ws client and resolve once open. */
async function connectVendorWs(wsUrl: string): Promise<WebSocket> {
  const ws = new WebSocket(wsUrl)
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', reject)
  })
  return ws
}

/** Resolve with the next vendor-client event tuple. */
function nextVendorEvent(ws: WebSocket, timeoutMs = 5000): Promise<{ kind: 'message'; data: WebSocket.RawData; isBinary: boolean } | { kind: 'close'; code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('nextVendorEvent: timeout')), timeoutMs)
    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      cleanup()
      resolve({ kind: 'message', data, isBinary })
    }
    const onClose = (code: number, reason: Buffer) => {
      cleanup()
      resolve({ kind: 'close', code, reason: reason.toString() })
    }
    function cleanup() {
      clearTimeout(timer)
      ws.off('message', onMessage)
      ws.off('close', onClose)
    }
    ws.on('message', onMessage)
    ws.on('close', onClose)
  })
}

describe('EchoWsFixture', () => {
  let fixture: EchoWsFixture | undefined

  afterEach(async () => {
    if (fixture) {
      await fixture.stop()
      fixture = undefined
    }
  })

  it('binds an ephemeral loopback port and exposes its ws URL', async () => {
    fixture = await EchoWsFixture.start()
    expect(fixture.port).toBeGreaterThan(0)
    expect(fixture.wsUrl).toMatch(new RegExp(`^ws://127\\.0\\.0\\.1:${fixture.port}/$`))
  })

  it('echoes text and binary frames verbatim', async () => {
    fixture = await EchoWsFixture.start()
    const ws = await connectVendorWs(fixture.wsUrl)
    try {
      ws.send('hello-fixture')
      const textHit = await nextVendorEvent(ws)
      expect(textHit).toEqual({ kind: 'message', data: Buffer.from('hello-fixture'), isBinary: false })

      const payload = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x42])
      ws.send(payload)
      const binHit = await nextVendorEvent(ws)
      expect(binHit.kind).toBe('message')
      if (binHit.kind === 'message') {
        expect(Buffer.from(binHit.data as Buffer).equals(payload)).toBe(true)
        expect(binHit.isBinary).toBe(true)
      }

      const conn = fixture.connections[0]
      expect(conn.framesReceived).toBe(2)
      expect(conn.closedAt).toBeNull()
    } finally {
      ws.close()
    }
  })

  it('`close:<code>:<reason>` makes the server close with exactly that code/reason', async () => {
    fixture = await EchoWsFixture.start()
    const ws = await connectVendorWs(fixture.wsUrl)
    ws.send('close:4000:fixture-bye')
    const hit = await nextVendorEvent(ws)
    expect(hit).toEqual({ kind: 'close', code: 4000, reason: 'fixture-bye' })

    // The ledger records the observed close metadata for that connection.
    await expect.poll(() => fixture!.connections[0]?.closedAt, { timeout: 5000 }).not.toBeNull()
    expect(fixture.connections[0].closeCode).toBe(4000)
    expect(fixture.connections[0].closeReason).toBe('fixture-bye')
  })

  it('`drop` destroys the TCP connection with no close frame', async () => {
    fixture = await EchoWsFixture.start()
    const ws = await connectVendorWs(fixture.wsUrl)
    ws.send('drop')
    const hit = await nextVendorEvent(ws)
    // ws clients report 1006 (abnormal closure) when the peer vanishes
    // WITHOUT a close frame; any fixture-sent close frame would carry a real
    // code (e.g. 1000). 1006 here proves the fixture sent none.
    expect(hit.kind).toBe('close')
    if (hit.kind === 'close') expect(hit.code).toBe(1006)
  })

  it('`flood:<count>:<size>` emits exactly count frames of size bytes, sequenced', async () => {
    fixture = await EchoWsFixture.start()
    const ws = await connectVendorWs(fixture.wsUrl)
    const payloads: string[] = []
    ws.on('message', (data) => { payloads.push(String(data)) })
    ws.send('flood:7:64')
    await expect.poll(() => payloads.length, { timeout: 5000 }).toBe(7)
    for (let i = 0; i < 7; i++) {
      expect(payloads[i].startsWith(`flood:${i}:`)).toBe(true)
      expect(payloads[i].length).toBe(64)
    }
  })

  it('never sends unprompted frames and tracks a ledger entry per connection', async () => {
    fixture = await EchoWsFixture.start()
    const a = await connectVendorWs(fixture.wsUrl)
    const b = await connectVendorWs(fixture.wsUrl)
    const messages: unknown[] = []
    a.on('message', (d) => messages.push(d))
    b.on('message', (d) => messages.push(d))
    await new Promise((r) => setTimeout(r, 300))
    expect(messages).toEqual([])
    expect(fixture.connections.length).toBe(2)
    expect(fixture.connections[0].id).not.toBe(fixture.connections[1].id)
    a.close()
    b.close()
  })

  it('stop() closes all connections and is idempotent', async () => {
    fixture = await EchoWsFixture.start()
    const ws = await connectVendorWs(fixture.wsUrl)
    const closed = nextVendorEvent(ws)
    await fixture.stop()
    const hit = await closed
    expect(hit.kind).toBe('close')
    await fixture.stop() // no throw
    const fixtureRef = fixture
    fixture = undefined // already stopped
    await fixtureRef.stop()
  })
})
