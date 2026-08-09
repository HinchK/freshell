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
import { RawWsClient, WS_OPCODE, rawHttpRequest } from './raw-clients.js'
import http from 'node:http'

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

describe('RawWsClient — codec + handshake', () => {
  const clients: RawWsClient[] = []
  let fixture: EchoWsFixture | undefined

  async function connect(): Promise<RawWsClient> {
    const client = await RawWsClient.connect(fixture!.wsUrl)
    clients.push(client)
    return client
  }

  afterEach(async () => {
    while (clients.length) await clients.pop()!.dispose()
    if (fixture) {
      await fixture.stop()
      fixture = undefined
    }
  })

  it('performs the RFC6455 handshake manually and records it', async () => {
    fixture = await EchoWsFixture.start()
    const client = await connect()
    expect(client.handshake.status).toBe(101)
    expect(client.handshake.headers['sec-websocket-accept']).toBeTruthy()
    expect(client.handshake.rawHead).toContain('HTTP/1.1 101')
    expect(client.reading).toBe(true)
    expect(client.destroyed).toBe(false)
  })

  it('echo roundtrips text with correct wire accounting on both directions', async () => {
    fixture = await EchoWsFixture.start()
    const client = await connect()
    client.sendText('hello-harness-05') // 16 bytes payload
    const echo = await client.waitForFrame((f) => f.opcode === WS_OPCODE.TEXT, 5000, 'text echo')
    expect(RawWsClient.text(echo)).toBe('hello-harness-05')

    // Client->server: 2 header + 4 mask key + 16 payload = 22 wire bytes.
    const sent = client.sentFrames[0]
    expect(sent.masked).toBe(true)
    expect(sent.opcode).toBe(WS_OPCODE.TEXT)
    expect(sent.fin).toBe(true)
    expect(sent.payloadBytes).toBe(16)
    expect(sent.wireBytes).toBe(22)

    // Server->client frames are unmasked: 2 header + 16 payload = 18.
    expect(echo.wireBytes).toBe(18)
    expect(echo.masked).toBe(false)

    // Socket-truth counters cover at least the observed frame bytes.
    expect(client.bytesSent).toBeGreaterThanOrEqual(22)
    expect(client.bytesReceived).toBeGreaterThanOrEqual(18)
  })

  it('echo roundtrips binary and preserves exact bytes', async () => {
    fixture = await EchoWsFixture.start()
    const client = await connect()
    const payload = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f, 0x42])
    client.sendBinary(payload)
    const echo = await client.waitForFrame((f) => f.opcode === WS_OPCODE.BINARY, 5000, 'binary echo')
    expect(echo.payload.equals(payload)).toBe(true)
  })

  it('encodes 64-bit payload lengths (>64KiB) correctly (echo proof)', async () => {
    fixture = await EchoWsFixture.start()
    const client = await connect()
    const big = Buffer.alloc(70_000)
    for (let i = 0; i < big.length; i++) big[i] = i % 251
    client.sendBinary(big)
    const echo = await client.waitForFrame((f) => f.opcode === WS_OPCODE.BINARY, 10_000, 'big echo')
    expect(echo.payloadBytes).toBe(70_000)
    expect(echo.payload.equals(big)).toBe(true)
    // 2 (type/len7=127) + 8 (u64 length) + 4 (mask key) + 70000 = 70014 sent.
    expect(client.sentFrames.at(-1)!.wireBytes).toBe(70_014)
  })

  it('sendPing produces a fixture pong carrying the payload; auto-reply knobs default on', async () => {
    fixture = await EchoWsFixture.start()
    const client = await connect()
    client.sendPing('probe-7')
    const pong = await client.waitForFrame((f) => f.opcode === WS_OPCODE.PONG, 5000, 'pong')
    expect(RawWsClient.text(pong)).toBe('probe-7')
  })

  it('waitForFrame times out with the supplied label when no frame matches', async () => {
    fixture = await EchoWsFixture.start()
    const client = await connect()
    await expect(
      client.waitForFrame((f) => f.opcode === 0x3, 300, 'never-arrives'),
    ).rejects.toThrow(/never-arrives/)
  })

  it('sendJson + static json/text helpers round-trip structured data', async () => {
    fixture = await EchoWsFixture.start()
    const client = await connect()
    client.sendJson({ type: 'probe', nested: { n: 42 } })
    const echo = await client.waitForFrame((f) => f.opcode === WS_OPCODE.TEXT, 5000, 'json echo')
    expect(RawWsClient.json<{ type: string; nested: { n: number } }>(echo)).toEqual({
      type: 'probe', nested: { n: 42 },
    })
  })

  it('records every sent and received frame in order in the ledgers', async () => {
    fixture = await EchoWsFixture.start()
    const client = await connect()
    client.sendText('one')
    client.sendText('two')
    client.sendText('three')
    await client.waitForFrame(
      () => client.receivedFrames.length === 3, 5000, 'three echoes',
    )
    expect(client.sentFrames.map((f) => f.payloadBytes)).toEqual([3, 3, 5])
    expect(client.receivedFrames.map((f) => RawWsClient.text(f))).toEqual(['one', 'two', 'three'])
  })
})

describe('RawWsClient — behaviors (pause / malformed / close codes / abort)', () => {
  const clients: RawWsClient[] = []
  let fixture: EchoWsFixture | undefined

  async function connect(options?: Parameters<typeof RawWsClient.connect>[1]): Promise<RawWsClient> {
    const client = await RawWsClient.connect(fixture!.wsUrl, options)
    clients.push(client)
    return client
  }

  afterEach(async () => {
    while (clients.length) await clients.pop()!.dispose()
    if (fixture) {
      await fixture.stop()
      fixture = undefined
    }
  })

  it('pauseReads() truly stops socket draining; resumeReads() is lossless and ordered', async () => {
    fixture = await EchoWsFixture.start()
    const client = await connect()
    client.pauseReads()
    expect(client.reading).toBe(false)

    client.sendText('flood:120:1843')
    const during = await client.collectFramesDuring(900)
    expect(during).toEqual([])
    expect(client.receivedFrames.length).toBe(0)
    const frozen = client.bytesReceived
    await new Promise((r) => setTimeout(r, 250))
    expect(client.bytesReceived).toBe(frozen)

    client.resumeReads()
    expect(client.reading).toBe(true)
    await client.waitForFrame(() => client.receivedFrames.length === 120, 10_000, 'full flood after resume')
    const seqs = client.receivedFrames.map((f) => Number(RawWsClient.text(f).split(':')[1]))
    expect(seqs).toEqual(Array.from({ length: 120 }, (_, i) => i))
  })

  it('connect({ autoRead: false }) starts paused (slow consumers from the first byte)', async () => {
    fixture = await EchoWsFixture.start()
    const client = await connect({ autoRead: false })
    expect(client.reading).toBe(false)
    client.sendText('flood:4:64')
    const during = await client.collectFramesDuring(400)
    expect(during).toEqual([])
    client.resumeReads()
    await client.waitForFrame(() => client.receivedFrames.length === 4, 5000, 'post-resume flood')
  })

  it('sending an RSV1-violating frame is recorded and the peer close (1002) is observed', async () => {
    fixture = await EchoWsFixture.start()
    const client = await connect()
    const sent = client.sendFrame({ rsv1: true, opcode: WS_OPCODE.TEXT, payload: 'x' })
    expect(sent.rsv1).toBe(true)
    const terminal = await client.waitForTerminalEvent(5000)
    expect(terminal).toBe('peer-close')
    expect(client.peerClose!.code).toBe(1002)
    // The fixture recorded (not crashed on) the protocol error.
    await expect.poll(() => fixture!.connections[0]?.errors.length, { timeout: 5000 }).toBeGreaterThan(0)
  })

  it('sending an unmasked client frame (mask:false) is recorded and rejected (1002)', async () => {
    fixture = await EchoWsFixture.start()
    const client = await connect()
    const sent = client.sendFrame({ mask: false, opcode: WS_OPCODE.TEXT, payload: 'x' })
    expect(sent.masked).toBe(false)
    const terminal = await client.waitForTerminalEvent(5000)
    expect(terminal).toBe('peer-close')
    expect(client.peerClose!.code).toBe(1002)
  })

  it('close:<code>:<reason> from the peer is captured with exact code and reason', async () => {
    fixture = await EchoWsFixture.start()
    const client = await connect()
    client.sendText('close:4000:fixture-bye')
    await client.waitForTerminalEvent(5000)
    expect(client.peerClose).toMatchObject({ code: 4000, reason: 'fixture-bye' })
  })

  it('closeGracefully completes the handshake and the fixture sees our 1000', async () => {
    fixture = await EchoWsFixture.start()
    const client = await connect()
    const outcome = await client.closeGracefully(1000, 'client-done')
    expect(['peer-close', 'tcp-end']).toContain(outcome)
    expect(client.peerClose!.code).toBe(1000)
    await expect.poll(() => fixture!.connections[0]?.closeCode, { timeout: 5000 }).toBe(1000)
    expect(fixture.connections[0].closeReason).toBe('client-done')
  })

  it('abort() tears the connection down instantly and no further frames are recorded', async () => {
    fixture = await EchoWsFixture.start()
    const client = await connect()
    client.sendText('flood:50:256')
    client.abort()
    await expect.poll(() => client.destroyed, { timeout: 5000 }).toBe(true)
    const framesAtAbort = client.receivedFrames.length
    await new Promise((r) => setTimeout(r, 400))
    expect(client.receivedFrames.length).toBe(framesAtAbort)
    await expect.poll(() => fixture!.connections[0]?.closedAt, { timeout: 5000 }).not.toBeNull()
  })

  it('a second normal socket stays usable while the first was sabotaged', async () => {
    fixture = await EchoWsFixture.start()
    const a = await connect()
    a.sendFrame({ rsv1: true, opcode: WS_OPCODE.TEXT, payload: 'x' })
    await a.waitForTerminalEvent(5000)
    expect(a.peerClose!.code).toBe(1002)

    const b = await connect()
    b.sendText('still-works')
    const echo = await b.waitForFrame((f) => f.opcode === WS_OPCODE.TEXT, 5000, 'second socket echo')
    expect(RawWsClient.text(echo)).toBe('still-works')
  })

  it('hello() sends the Freshell handshake frame shape', async () => {
    fixture = await EchoWsFixture.start()
    const client = await connect()
    client.hello('test-token-123')
    const echo = await client.waitForFrame((f) => f.opcode === WS_OPCODE.TEXT, 5000, 'hello echo')
    const parsed = RawWsClient.json<{ type: string; token: string; protocolVersion: number }>(echo)
    expect(parsed.type).toBe('hello')
    expect(parsed.token).toBe('test-token-123')
    expect(typeof parsed.protocolVersion).toBe('number')
  })
})

describe('rawHttpRequest — byte-accounted orchestration HTTP client', () => {
  let stub: http.Server | undefined
  let stubBaseUrl = ''

  afterEach(async () => {
    if (stub) {
      await new Promise<void>((resolve) => stub!.close(() => resolve()))
      stub = undefined
    }
  })

  async function startStub(
    handler: (req: http.IncomingMessage, body: Buffer, res: http.ServerResponse) => void,
  ): Promise<void> {
    stub = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => handler(req, Buffer.concat(chunks), res))
    })
    await new Promise<void>((resolve) => stub!.listen(0, '127.0.0.1', resolve))
    stubBaseUrl = `http://127.0.0.1:${(stub.address() as import('net').AddressInfo).port}`
  }

  it('sends an exact method/headers/body and reports status, headers, body, byte counters', async () => {
    let seen: { method?: string; path?: string; origin?: string; auth?: string; body?: string } = {}
    await startStub((req, body, res) => {
      seen = {
        method: req.method,
        path: req.url,
        origin: req.headers['origin'] as string | undefined,
        auth: req.headers['x-auth-token'] as string | undefined,
        body: body.toString('utf8'),
      }
      res.writeHead(201, { 'content-type': 'application/json', 'x-stub': 'yes' })
      res.end(JSON.stringify({ ok: true, n: 7 }))
    })

    const res = await rawHttpRequest(stubBaseUrl, {
      method: 'POST',
      path: '/api/tabs?x=1',
      headers: { 'x-auth-token': 'tok-abc', Origin: 'https://example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'tab-from-test' }),
    })

    expect(seen.method).toBe('POST')
    expect(seen.path).toBe('/api/tabs?x=1')
    expect(seen.origin).toBe('https://example.test')
    expect(seen.auth).toBe('tok-abc')
    expect(seen.body).toBe('{"name":"tab-from-test"}')

    expect(res.status).toBe(201)
    expect(res.headers['x-stub']).toBe('yes')
    expect(res.json()).toEqual({ ok: true, n: 7 })
    expect(res.body.toString('utf8')).toBe('{"ok":true,"n":7}')
    expect(res.rawHeaders.join(' ')).toContain('x-stub')
    expect(res.bytesSent).toBeGreaterThan(50)
    expect(res.bytesReceived).toBeGreaterThan(20)
    expect(res.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('honors header OMISSION (no implicit auth is ever added)', async () => {
    let auth: string | undefined = 'unset'
    await startStub((req, _body, res) => {
      auth = req.headers['x-auth-token'] as string | undefined
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":"no token"}')
    })
    const res = await rawHttpRequest(stubBaseUrl, { path: '/api/tabs' })
    expect(res.status).toBe(401)
    expect(auth).toBeUndefined()
  })

  it('times out with a labeled error instead of hanging', async () => {
    await startStub((_req, _body, _res) => {
      // never respond
    })
    await expect(rawHttpRequest(stubBaseUrl, { timeoutMs: 250 })).rejects.toThrow(/timed out after 250ms/)
  })

  it('reports connection-refused errors with the target in the message', async () => {
    await expect(rawHttpRequest('http://127.0.0.1:1', { timeoutMs: 2000 })).rejects.toThrow(/127\.0\.0\.1:1/)
  })
})

describe('RawWsClient — review-round-1 fixes', () => {
  const clients: RawWsClient[] = []
  let fixture: EchoWsFixture | undefined

  afterEach(async () => {
    while (clients.length) await clients.pop()!.dispose()
    if (fixture) {
      await fixture.stop()
      fixture = undefined
    }
  })

  it('R1: autoRead:false + a coalesced upgrade+frame records nothing until resume', async () => {
    // Bare net server: write the 101 head AND one WS text frame in ONE write,
    // so the frame bytes are already in userland when the client constructor
    // sees them. The contract: autoRead:false means NOTHING is recorded
    // until resumeReads(), even for bytes delivered with the handshake rest.
    const crypto = await import('node:crypto')
    const net = await import('node:net')
    const server = net.createServer((sock) => {
      sock.once('data', (req) => {
        const key = String(req).match(/Sec-WebSocket-Key: (.+)\r\n/)![1]
        const accept = crypto.createHash('sha1')
          .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
        const head = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
        // unmasked server TEXT frame 'coalesced' (9 bytes): 0x81 0x09 + payload
        const frame = Buffer.concat([Buffer.from([0x81, 0x09]), Buffer.from('coalesced')])
        sock.write(head + frame.toString('latin1'), 'latin1')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const { port } = server.address() as import('node:net').AddressInfo
    try {
      const client = await RawWsClient.connect(`ws://127.0.0.1:${port}/`, { autoRead: false })
      clients.push(client)
      expect(client.receivedFrames.length).toBe(0)
      await new Promise((r) => setTimeout(r, 300))
      expect(client.receivedFrames.length).toBe(0)
      client.resumeReads()
      const frame = await client.waitForFrame((f) => f.opcode === WS_OPCODE.TEXT, 5000, 'deferred coalesced frame')
      expect(RawWsClient.text(frame)).toBe('coalesced')
    } finally {
      server.close()
    }
  })

  it('R1: pauseReads(); resumeReads() is repeatable and drains deferred bytes each time', async () => {
    fixture = await EchoWsFixture.start()
    const client = await RawWsClient.connect(fixture.wsUrl)
    clients.push(client)
    client.sendText('one')
    await client.waitForFrame(() => client.receivedFrames.length === 1, 5000, 'first echo')

    client.pauseReads()
    client.sendText('two')
    await client.collectFramesDuring(300)
    expect(client.receivedFrames.length).toBe(1)
    client.resumeReads()
    await client.waitForFrame(() => client.receivedFrames.length === 2, 5000, 'second echo after resume')

    client.pauseReads()
    client.sendText('three')
    await client.collectFramesDuring(300)
    expect(client.receivedFrames.length).toBe(2)
    client.resumeReads()
    await client.waitForFrame(() => client.receivedFrames.length === 3, 5000, 'third echo after resume')
  })

  it('R2: nextJsonMessage only matches frames received after the call', async () => {
    fixture = await EchoWsFixture.start()
    const client = await RawWsClient.connect(fixture.wsUrl)
    clients.push(client)
    client.sendJson({ type: 'dup', n: 1 })
    const first = await client.nextJsonMessage<{ type: string; n: number }>('dup', 5000)
    expect(first.n).toBe(1)

    client.sendJson({ type: 'dup', n: 2 })
    const second = await client.nextJsonMessage<{ type: string; n: number }>('dup', 5000)
    expect(second.n).toBe(2)
  })

  it('R3: an empty peer close frame is answered with an EMPTY close frame (never 1005 on the wire)', async () => {
    fixture = await EchoWsFixture.start()
    const client = await RawWsClient.connect(fixture.wsUrl)
    clients.push(client)
    client.sendText('emptyclose')
    await client.waitForTerminalEvent(5000)
    // The 1005 sentinel is RECORDED for the spec, but must never be a
    // transmitted code. If it were, the fixture's ws receiver would flag a
    // WS_ERR_INVALID_CLOSE_CODE protocol error against us.
    expect(client.peerClose!.code).toBe(1005)
    const ourReply = client.sentFrames.find((f) => f.opcode === WS_OPCODE.CLOSE)
    expect(ourReply).toBeTruthy()
    expect(ourReply!.payloadBytes).toBe(0)
    await expect.poll(() => fixture!.connections[0]?.closedAt, { timeout: 5000 }).not.toBeNull()
    expect(fixture.connections[0].errors).toEqual([])
  })
})

describe('rawHttpRequest — review-round-1 fixes', () => {
  async function withAbortingStub(
    mode: 'rst' | 'fin',
    run: (baseUrl: string) => Promise<void>,
  ): Promise<void> {
    const srv = (await import('node:http')).createServer((_req, res) => {
      res.writeHead(200, { 'content-length': '64' })
      res.write('{"partial":')
      if (mode === 'rst') {
        res.socket!.destroy() // abrupt reset before body completes
      } else {
        res.socket!.end()    // graceful FIN mid-body (no RST)
      }
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const { port } = srv.address() as import('node:net').AddressInfo
    try {
      await run(`http://127.0.0.1:${port}`)
    } finally {
      srv.close()
    }
  }

  it('R4: rejects promptly (not at the 3s timeout) on mid-response RST', async () => {
    await withAbortingStub('rst', async (baseUrl) => {
      const started = Date.now()
      await expect(rawHttpRequest(baseUrl, { timeoutMs: 3000 })).rejects.toThrow(/rawHttpRequest:/)
      expect(Date.now() - started).toBeLessThan(2500)
    })
  })

  it('R4: rejects promptly (not hanging to timeout) on mid-response FIN (partial body)', async () => {
    await withAbortingStub('fin', async (baseUrl) => {
      const started = Date.now()
      await expect(rawHttpRequest(baseUrl, { timeoutMs: 3000 })).rejects.toThrow(/rawHttpRequest:/)
      expect(Date.now() - started).toBeLessThan(2500)
    })
  })
})
