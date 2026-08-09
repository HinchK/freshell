import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { WebSocketServer, WebSocket, type RawData } from 'ws'

/**
 * HARNESS-06 — deterministic HTTP / WebSocket / hot-reload target fixture.
 *
 * One owned Node process per instance, bound to 127.0.0.1 on an ephemeral port
 * (or a caller-chosen port for stop→recover scenarios). The later BROWSER-01..05
 * items point the server-under-test's proxy at this fixture; the checklist
 * validation reaches every surface directly from the fixture smoke.
 *
 * Surfaces (HTTP):
 *   GET  /page               marker page; ?csp=<policy>&xfo=deny|sameorigin&title=
 *   ANY  /echo               echoes exact upstream inputs as JSON + ledger entry
 *   GET  /stream?chunks&delayMs  ordered chunked stream `chunk-i/N\n`
 *   GET  /hot                hot-reload page (#build-marker, EventSource driven)
 *   GET  /hot/stream         SSE; a `reload` event carries every bumpBuild()
 *   POST /__admin/bump       (also exposed via bumpBuild())
 *   GET  /ws-page            page whose inline JS opens /ws-echo and mirrors
 *                            frames into the DOM (#ws-log), for frameLocator flows
 *   GET  /__admin/ledger     JSON dump of the in-process request/frame ledger
 * Surfaces (WS):
 *   /ws-echo                 verbatim text/binary echo; handshake + frame ledger;
 *                            optional subprotocol allow-list negotiation
 *
 * Everything is deterministic: no timers except the caller-chosen stream delay,
 * no filesystem watching (hot "reload" is an explicit bump), no randomness.
 */

export interface TargetLedgerEntry {
  seq: number
  kind: 'http' | 'ws-open' | 'ws-message' | 'ws-close'
  at: number
  method?: string
  path?: string
  query?: string
  headers?: Record<string, string | string[] | undefined>
  bodyBase64?: string
  isBinary?: boolean
  subprotocol?: string
  code?: number
  reason?: string
}

export interface TlsKeyPair {
  key: string | Buffer
  cert: string | Buffer
}

export interface TargetServerOptions {
  /** Bind a specific port (default 0 = OS-assigned ephemeral). */
  port?: number
  /** TLS keypair; when present the surfaces speak https/wss. */
  tls?: TlsKeyPair
}

const WS_SUBPROTOCOL_ALLOWLIST = ['freshell.test', 'freshell.probe']

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

function markerPage(title: string): string {
  return [
    '<!doctype html>',
    `<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>`,
    '<body>',
    '<div id="fixture-marker" data-fixture="harness-06">HARNESS-06 TARGET MARKER</div>',
    '</body></html>',
  ].join('\n')
}

function wsPage(): string {
  // The inline script intentionally has no external dependencies -- the page
  // must work even when the proxy-under-test strips everything else.
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>harness-06 ws-page</title></head>
<body>
<div id="fixture-marker">HARNESS-06 WS PAGE</div>
<div id="ws-log" data-state="connecting"></div>
<script>
(function () {
  var log = document.getElementById('ws-log')
  var params = new URLSearchParams(location.search)
  var sub = params.get('subprotocol')
  var proto = location.protocol === 'https:' ? 'wss' : 'ws'
  var url = proto + '://' + location.host + '/ws-echo?from=ws-page'
  var ws = sub ? new WebSocket(url, sub) : new WebSocket(url)
  window.__fixtureWs = ws
  function add(cls, text) {
    var d = document.createElement('div')
    d.className = cls
    d.textContent = text
    log.appendChild(d)
  }
  function b64(buf) {
    var bytes = new Uint8Array(buf)
    var s = ''
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
    return btoa(s)
  }
  ws.addEventListener('open', function () {
    log.setAttribute('data-state', 'open')
    add('ws-open', 'open:' + (ws.protocol || ''))
  })
  ws.addEventListener('message', function (ev) {
    if (typeof ev.data === 'string') { add('ws-message', 'text:' + ev.data); return }
    ev.data.arrayBuffer().then(function (buf) { add('ws-message', 'bin:' + b64(buf)) })
  })
  ws.addEventListener('close', function (ev) {
    log.setAttribute('data-state', 'closed')
    add('ws-close', 'close:' + ev.code + ':' + ev.reason)
  })
})()
</script>
</body></html>`
}

function hotPage(build: number): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>harness-06 hot</title></head>
<body>
<div id="fixture-marker">HARNESS-06 HOT PAGE</div>
<div id="build-marker">build ${build}</div>
<script>
(function () {
  var es = new EventSource('/hot/stream')
  es.onmessage = function (ev) {
    try {
      var m = JSON.parse(ev.data)
      if (m && m.type === 'reload') location.reload()
    } catch (e) { /* ignore malformed fixture messages */ }
  }
})()
</script>
</body></html>`
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

export class TargetServer {
  private readonly server: http.Server | https.Server
  private readonly wss: WebSocketServer
  private readonly sockets = new Set<net.Socket>()
  private readonly wsClients = new Set<WebSocket>()
  private readonly sseClients = new Set<http.ServerResponse>()
  private entries: TargetLedgerEntry[] = []
  private seq = 0
  private currentBuild = 1
  private _port = 0
  private stopped = false

  private constructor(private readonly tls?: TlsKeyPair) {
    const listener = (req: http.IncomingMessage, res: http.ServerResponse) => {
      void this.handle(req, res).catch((err) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: String(err) }))
      })
    }
    this.server = tls ? https.createServer({ key: tls.key, cert: tls.cert }, listener) : http.createServer(listener)
    this.wss = new WebSocketServer({ noServer: true })
    this.server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })
    this.server.on('secureConnection', (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })
    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/ws-echo') {
        socket.destroy()
        return
      }
      const requested = listHeaderTokens(req.headers['sec-websocket-protocol'])
      const accepted = requested.find((p) => WS_SUBPROTOCOL_ALLOWLIST.includes(p))
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.onWsConnection(ws, req, accepted)
      })
    })
  }

  static async start(opts: TargetServerOptions = {}): Promise<TargetServer> {
    const target = new TargetServer(opts.tls)
    await target.listen(opts.port ?? 0)
    return target
  }

  get port(): number { return this._port }
  get baseUrl(): string { return `${this.tls ? 'https' : 'http'}://127.0.0.1:${this._port}` }
  get wsUrl(): string { return `${this.tls ? 'wss' : 'ws'}://127.0.0.1:${this._port}` }

  ledger(): readonly TargetLedgerEntry[] { return this.entries }
  clearLedger(): void { this.entries = [] }
  build(): number { return this.currentBuild }

  bumpBuild(): number {
    this.currentBuild += 1
    const payload = `data: {"type":"reload","build":${this.currentBuild}}\n\n`
    for (const res of this.sseClients) res.write(payload)
    return this.currentBuild
  }

  async closeWebSockets(code = 1001, reason = 'fixture-close'): Promise<void> {
    const closers = [...this.wsClients].map(
      (ws) =>
        new Promise<void>((resolve) => {
          ws.once('close', () => resolve())
          ws.close(code, reason)
        }),
    )
    await Promise.all(closers)
  }

  private record(entry: Omit<TargetLedgerEntry, 'seq' | 'at'>): TargetLedgerEntry {
    const full: TargetLedgerEntry = { ...entry, seq: ++this.seq, at: Date.now() }
    this.entries.push(full)
    return full
  }

  private async listen(port: number): Promise<void> {
    const started = Date.now()
    for (;;) {
      try {
        await new Promise<void>((resolve, reject) => {
          this.server.once('error', reject)
          this.server.listen(port, '127.0.0.1', () => resolve())
        })
        break
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE' && Date.now() - started < 5000) {
          await new Promise((r) => setTimeout(r, 100))
          continue
        }
        throw err
      }
    }
    const addr = this.server.address()
    if (!addr || typeof addr === 'string') throw new Error('target-server failed to bind')
    this._port = addr.port
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname

    if (path === '/page') {
      const csp = url.searchParams.get('csp')
      const xfo = url.searchParams.get('xfo')
      const title = url.searchParams.get('title') ?? 'harness-06 target'
      if (csp) res.setHeader('content-security-policy', csp)
      if (xfo === 'deny') res.setHeader('x-frame-options', 'DENY')
      if (xfo === 'sameorigin') res.setHeader('x-frame-options', 'SAMEORIGIN')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(markerPage(title))
      return
    }

    if (path === '/echo') {
      const body = await readBody(req)
      const payload = {
        method: req.method ?? 'GET',
        path,
        query: rawQuery(url),
        bodyBase64: body.toString('base64'),
      }
      this.record({ kind: 'http', ...payload, headers: req.headers })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
      return
    }

    if (path === '/stream') {
      const chunks = Math.max(1, Math.min(100, Number(url.searchParams.get('chunks') ?? 5) || 5))
      const delayMs = Math.max(0, Math.min(2000, Number(url.searchParams.get('delayMs') ?? 10) || 0))
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      for (let i = 0; i < chunks; i++) {
        res.write(`chunk-${i}/${chunks}\n`)
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
      }
      res.end()
      return
    }

    if (path === '/hot') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(hotPage(this.currentBuild))
      return
    }

    if (path === '/hot/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(': fixture-open\n\n')
      this.sseClients.add(res)
      req.on('close', () => this.sseClients.delete(res))
      return
    }

    if (path === '/__admin/bump' && req.method === 'POST') {
      const build = this.bumpBuild()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ build }))
      return
    }

    if (path === '/ws-page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(wsPage())
      return
    }

    if (path === '/__admin/ledger') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(this.entries))
      return
    }

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found', path }))
  }

  private onWsConnection(ws: WebSocket, req: http.IncomingMessage, subprotocol: string | undefined): void {
    this.wsClients.add(ws)
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    this.record({
      kind: 'ws-open',
      path: url.pathname,
      query: rawQuery(url),
      headers: req.headers,
      subprotocol: subprotocol ?? ws.protocol ?? '',
    })
    ws.on('message', (data: RawData, isBinary: boolean) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
      this.record({ kind: 'ws-message', isBinary, bodyBase64: buf.toString('base64') })
      ws.send(buf, { binary: isBinary })
    })
    ws.on('close', (code: number, reason: Buffer) => {
      this.record({ kind: 'ws-close', code, reason: reason.toString() })
      this.wsClients.delete(ws)
    })
    ws.on('error', () => this.wsClients.delete(ws))
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    for (const ws of this.wsClients) { try { ws.terminate() } catch { /* already closed */ } }
    for (const res of this.sseClients) { try { res.end() } catch { /* closed */ } }
    this.sseClients.clear()
    for (const socket of this.sockets) { try { socket.destroy() } catch { /* closed */ } }
    await new Promise<void>((resolve) => {
      this.wss.close(() => {
        this.server.close(() => resolve())
      })
    })
  }
}

function listHeaderTokens(header: string | string[] | undefined): string[] {
  const raw = Array.isArray(header) ? header.join(',') : header ?? ''
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

/** Raw, un-normalized query string (no `?`): BROWSER-* asserts EXACT upstream inputs. */
function rawQuery(url: URL): string {
  return url.search.startsWith('?') ? url.search.slice(1) : url.search
}

export async function startTargetServer(opts: TargetServerOptions = {}): Promise<TargetServer> {
  return TargetServer.start(opts)
}
