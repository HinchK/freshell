import { describe, it, expect, afterEach } from 'vitest'
import WebSocket from 'ws'
import { startTargetServer, type TargetServer } from './target-server.js'

/**
 * HARNESS-06 target-server vitest coverage: the deterministic HTTP / WebSocket /
 * hot-reload fixture all later BROWSER-* items drive. Everything here uses
 * ephemeral loopback ports and instance-scoped ledgers -- no shared state.
 */

const servers: TargetServer[] = []

async function boot(opts?: Parameters<typeof startTargetServer>[0]): Promise<TargetServer> {
  const server = await startTargetServer(opts)
  servers.push(server)
  return server
}

afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!
    await s.stop().catch(() => {})
  }
})

async function readAllText(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.length }
  return new TextDecoder().decode(out)
}

describe('harness-06 target-server: HTTP surface', () => {
  it('serves the marker page with a stable #fixture-marker and default title', async () => {
    const s = await boot()
    const res = await fetch(`${s.baseUrl}/page`)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('id="fixture-marker"')
    expect(body).toContain('HARNESS-06 TARGET MARKER')
    // No CSP/XFO headers unless requested
    expect(res.headers.get('content-security-policy')).toBeNull()
    expect(res.headers.get('x-frame-options')).toBeNull()
  })

  it('sets CSP and X-Frame-Options variants on request (BROWSER-01)', async () => {
    const s = await boot()
    const csp = encodeURIComponent("default-src 'none'")
    const res = await fetch(`${s.baseUrl}/page?csp=${csp}&xfo=deny&title=My%20Probe`)
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'")
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(await res.text()).toContain('<title>My Probe</title>')
    const res2 = await fetch(`${s.baseUrl}/page?xfo=sameorigin`)
    expect(res2.headers.get('x-frame-options')).toBe('SAMEORIGIN')
  })

  it('echoes exact upstream inputs for GET/POST incl. binary bodies and records them', async () => {
    const s = await boot()
    const payload = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x41, 0x42])
    const res = await fetch(`${s.baseUrl}/echo?a=1&b=two%20words`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-fixture-sentinel': 'sentinel-123' },
      body: payload,
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.method).toBe('POST')
    expect(body.path).toBe('/echo')
    expect(body.query).toBe('a=1&b=two%20words')
    expect(Buffer.from(String(body.bodyBase64), 'base64')).toEqual(payload)

    const entries = s.ledger()
    expect(entries).toHaveLength(1)
    const entry = entries[0]
    expect(entry.kind).toBe('http')
    expect(entry.method).toBe('POST')
    expect(entry.query).toBe('a=1&b=two%20words')
    expect(entry.headers?.['x-fixture-sentinel']).toBe('sentinel-123')
    expect(Buffer.from(String(entry.bodyBase64), 'base64')).toEqual(payload)
    expect(entry.seq).toBe(1)
  })

  it('streams deterministic ordered chunks', async () => {
    const s = await boot()
    const res = await fetch(`${s.baseUrl}/stream?chunks=4&delayMs=1`)
    expect(res.status).toBe(200)
    const text = await readAllText(res.body!)
    expect(text).toBe('chunk-0/4\nchunk-1/4\nchunk-2/4\nchunk-3/4\n')
  })

  it('404s unknown paths with a JSON error', async () => {
    const s = await boot()
    const res = await fetch(`${s.baseUrl}/nope`)
    expect(res.status).toBe(404)
    const body = await res.json() as Record<string, unknown>
    expect(body.error).toBe('not found')
  })

  it('restarts on the SAME port after stop (BROWSER-05 offline→recover capability)', async () => {
    const s = await boot()
    const port = s.port
    expect((await fetch(`${s.baseUrl}/page`)).status).toBe(200)
    await s.stop()
    servers.length = 0 // already stopped
    const again = await boot({ port })
    expect(again.port).toBe(port)
    expect((await fetch(`${again.baseUrl}/page`)).status).toBe(200)
  })
})

describe('harness-06 target-server: WebSocket echo surface (BROWSER-02)', () => {
  function connect(s: TargetServer, query = '', protocols?: string | string[]) {
    return new WebSocket(`${s.wsUrl}/ws-echo${query}`, protocols)
  }

  function open(ws: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
  }

  it('echoes text and binary frames verbatim and records handshake + frames', async () => {
    const s = await boot()
    const ws = connect(s, '?from=vitest', 'freshell.test')
    await open(ws)
    expect(ws.protocol).toBe('freshell.test')

    const replies: Array<{ data: WebSocket.RawData; isBinary: boolean }> = []
    ws.on('message', (data, isBinary) => replies.push({ data, isBinary }))

    ws.send('hello-fixture')
    ws.send(Buffer.from([0x10, 0x00, 0xff]))

    await expect.poll(() => replies.length, { timeout: 5000, interval: 20 }).toBe(2)
    expect(replies[0].isBinary).toBe(false)
    expect(replies[0].data.toString()).toBe('hello-fixture')
    expect(replies[1].isBinary).toBe(true)
    expect(Buffer.from(replies[1].data as Buffer)).toEqual(Buffer.from([0x10, 0x00, 0xff]))

    await expect.poll(() => s.ledger().filter((e) => e.kind === 'ws-message').length).toBe(2)
    const openEntry = s.ledger().find((e) => e.kind === 'ws-open')
    expect(openEntry?.subprotocol).toBe('freshell.test')
    expect(openEntry?.query).toBe('from=vitest')

    const msgs = s.ledger().filter((e) => e.kind === 'ws-message')
    expect(msgs[0].isBinary).toBe(false)
    expect(Buffer.from(String(msgs[0].bodyBase64), 'base64').toString()).toBe('hello-fixture')
    expect(msgs[1].isBinary).toBe(true)
    expect(Buffer.from(String(msgs[1].bodyBase64), 'base64')).toEqual(Buffer.from([0x10, 0x00, 0xff]))

    ws.close()
    await expect.poll(() => s.ledger().some((e) => e.kind === 'ws-close')).toBe(true)
  })

  it('retains the cookie header on the upgrade ledger entry (BROWSER-02 cookie auth)', async () => {
    const s = await boot()
    const ws = new WebSocket(`${s.wsUrl}/ws-echo`, { headers: { cookie: 'auth=abc123' } })
    await open(ws)
    await expect.poll(() => s.ledger().some((e) => e.kind === 'ws-open')).toBe(true)
    const entry = s.ledger().find((e) => e.kind === 'ws-open')
    expect(entry?.headers?.cookie).toBe('auth=abc123')
    ws.close()
  })

  it('closeWebSockets() force-closes server-side with the requested code/reason', async () => {
    const s = await boot()
    const ws = connect(s)
    await open(ws)
    const closed = new Promise<{ code: number; reason: Buffer }>((resolve) => {
      ws.once('close', (code, reason) => resolve({ code, reason }))
    })
    await s.closeWebSockets(4000, 'fixture-close')
    const { code, reason } = await closed
    expect(code).toBe(4000)
    expect(reason.toString()).toBe('fixture-close')
  })

  it('rejects upgrades on non-fixture paths', async () => {
    const s = await boot()
    const ws = new WebSocket(`${s.wsUrl}/elsewhere`)
    const outcome = await new Promise<string>((resolve) => {
      ws.once('open', () => resolve('opened'))
      ws.once('error', () => resolve('error'))
      ws.once('unexpected-response', () => resolve('unexpected-response'))
    })
    expect(outcome).not.toBe('opened')
  })
})

describe('harness-06 target-server: hot-reload surface', () => {
  it('serves a deterministic build marker and broadcasts reload on bump', async () => {
    const s = await boot()
    expect(s.build()).toBe(1)
    const page1 = await (await fetch(`${s.baseUrl}/hot`)).text()
    expect(page1).toContain('id="build-marker"')
    expect(page1).toContain('build 1')

    // Open the SSE stream, then bump; the stream must carry the new build.
    const sse = await fetch(`${s.baseUrl}/hot/stream`, { headers: { accept: 'text/event-stream' } })
    expect(sse.headers.get('content-type')).toContain('text/event-stream')
    const reader = sse.body!.getReader()
    const bumpResult = s.bumpBuild()
    expect(bumpResult).toBe(2)
    expect(s.build()).toBe(2)

    const deadline = Date.now() + 5000
    let buf = ''
    while (Date.now() < deadline && !buf.includes('"build":2')) {
      const { done, value } = await reader.read()
      if (done) break
      buf += new TextDecoder().decode(value)
    }
    expect(buf).toContain('data: {"type":"reload","build":2}')
    reader.cancel().catch(() => {})

    const page2 = await (await fetch(`${s.baseUrl}/hot`)).text()
    expect(page2).toContain('build 2')
  })
})

describe('harness-06 target-server: in-process ledger endpoint', () => {
  it('exposes the ledger over /__admin/ledger for in-page assertions', async () => {
    const s = await boot()
    await fetch(`${s.baseUrl}/echo?m=1`, { method: 'PUT', body: 'abc' })
    const res = await fetch(`${s.baseUrl}/__admin/ledger`)
    const entries = await res.json() as Array<Record<string, unknown>>
    expect(entries.some((e) => e.kind === 'http' && e.path === '/echo' && e.method === 'PUT')).toBe(true)
    s.clearLedger()
    const cleared = await (await fetch(`${s.baseUrl}/__admin/ledger`)).json() as unknown[]
    expect(cleared).toHaveLength(0)
  })
})
