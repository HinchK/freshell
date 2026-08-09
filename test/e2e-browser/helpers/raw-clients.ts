/**
 * HARNESS-05 — raw HTTP and WebSocket clients for the Playwright runner.
 *
 * `RawWsClient` performs the RFC 6455 handshake and frame codec manually
 * over a real `net.Socket` so that Playwright specs can do things the
 * vendored `ws` client deliberately forbids:
 *
 *   - send MALFORMED frames (RSV bits set, unknown opcodes, unmasked client
 *     frames, a mask bit with no key, a header payload-length lie)
 *   - DELAY reads (genuine socket-level pause, creating slow consumers via
 *     real TCP backpressure) and DELAY the hello handshake
 *   - INSPECT every frame on the wire: exact wire bytes, RSV/opcode/mask
 *     bits, close codes and reasons, byte counters, terminal events
 *   - ABORT the connection abruptly (socket destroy) and observe the result
 *
 * `rawHttpRequest` is a byte-accounted HTTP/1.1 client with full
 * method/header/body control, for calling orchestration routes
 * (`/api/tabs`, `/api/panes/:id/...`) from specs without a browser page.
 *
 * The client never offers `Sec-WebSocket-Extensions`, so every peer speaks
 * uncompressed frames and wire byte counts stay deterministic.
 *
 * Fixture pair: `EchoWsFixture` (`echo-ws-fixture.ts`) — see
 * docs/plans/df1/HARNESS-05.md for the full design and audit ledger.
 */
import net from 'node:net'
import http from 'node:http'
import crypto from 'node:crypto'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'

/** RFC 6455 §5.2 opcodes. */
export const WS_OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const

export type WsOpcode = (typeof WS_OPCODE)[keyof typeof WS_OPCODE]

const WS_ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_HANDSHAKE_HEAD_BYTES = 16 * 1024
const HANDSHAKE_BODY_PREFIX_BYTES = 4096

export interface RawFrameOptions {
  /** Default true. */
  fin?: boolean
  rsv1?: boolean
  rsv2?: boolean
  rsv3?: boolean
  opcode: number
  /** Default empty. Strings are UTF-8 encoded. */
  payload?: Buffer | string
  /**
   * Default true (RFC 6455 §5.3: client frames MUST be masked). Pass false
   * to deliberately send a MALFORMED unmasked client frame.
   */
  mask?: boolean
  /** Explicit 4-byte masking key (default: cryptographically random). */
  maskKey?: Buffer
  /** MALFORMED: advertise MASK=1 but write no masking-key bytes. */
  omitMaskKey?: boolean
  /** MALFORMED knob: value written into the header length fields. Defaults
   *  to the truthful payload byte length; supply another value to lie
   *  (e.g. promise more bytes than are written). */
  declaredPayloadLength?: number
}

export interface SentFrameRecord {
  fin: boolean
  rsv1: boolean
  rsv2: boolean
  rsv3: boolean
  opcode: number
  payloadBytes: number
  /** Total bytes placed on the wire for this frame (header + key + payload). */
  wireBytes: number
  masked: boolean
  at: number
}

export interface ReceivedFrameRecord {
  fin: boolean
  rsv1: boolean
  rsv2: boolean
  rsv3: boolean
  opcode: number
  /** True when the peer masked this frame (servers normally never do). */
  masked: boolean
  payload: Buffer
  payloadBytes: number
  wireBytes: number
  at: number
}

export interface HandshakeRecord {
  status: number
  statusMessage: string
  /** Lower-cased header map. */
  headers: Record<string, string>
  rawHead: string
}

/** Thrown by `RawWsClient.connect` when the server answers a non-101. */
export class RawWsHandshakeError extends Error {
  readonly status: number
  readonly headers: Record<string, string>
  readonly bodyPrefix: string

  constructor(status: number, statusMessage: string, headers: Record<string, string>, bodyPrefix: string) {
    super(`RawWsClient: handshake rejected with HTTP ${status} ${statusMessage}`)
    this.name = 'RawWsHandshakeError'
    this.status = status
    this.headers = headers
    this.bodyPrefix = bodyPrefix
  }
}

export interface RawWsClientOptions {
  /** Extra handshake headers (e.g. `Origin`). Wins over computed defaults. */
  headers?: Record<string, string>
  /** Verify the Sec-WebSocket-Accept digest (default true). */
  validateAccept?: boolean
  /** Default true; false starts the client with reads paused. */
  autoRead?: boolean
  /** Answer peer PINGs with PONGs (default true). */
  autoReplyPing?: boolean
  /** Answer a peer CLOSE frame with our own CLOSE (default true). */
  autoReplyClose?: boolean
  /** Default 10_000. */
  handshakeTimeoutMs?: number
}

function sha1Base64(input: string): string {
  return crypto.createHash('sha1').update(input).digest('base64')
}

/** Encode one frame exactly per the caller's (possibly malformed) spec. */
function encodeFrame(options: RawFrameOptions): { wire: Buffer; record: Omit<SentFrameRecord, 'at'> } {
  const fin = options.fin ?? true
  const rsv1 = options.rsv1 ?? false
  const rsv2 = options.rsv2 ?? false
  const rsv3 = options.rsv3 ?? false
  const opcode = options.opcode
  const payload = options.payload === undefined
    ? Buffer.alloc(0)
    : Buffer.isBuffer(options.payload) ? options.payload : Buffer.from(options.payload, 'utf8')
  const declaredLength = options.declaredPayloadLength ?? payload.length
  const useMask = options.mask ?? true
  const omitMaskKey = options.omitMaskKey ?? false

  const b0 = (fin ? 0x80 : 0) | (rsv1 ? 0x40 : 0) | (rsv2 ? 0x20 : 0) | (rsv3 ? 0x10 : 0) | (opcode & 0x0f)
  const maskBit = useMask ? 0x80 : 0

  let header: Buffer
  if (declaredLength < 126) {
    header = Buffer.from([b0, maskBit | declaredLength])
  } else if (declaredLength <= 0xffff) {
    header = Buffer.alloc(4)
    header[0] = b0
    header[1] = maskBit | 126
    header.writeUInt16BE(declaredLength, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = b0
    header[1] = maskBit | 127
    header.writeBigUInt64BE(BigInt(declaredLength), 2)
  }

  let wire: Buffer
  if (useMask && !omitMaskKey) {
    const key = options.maskKey ?? crypto.randomBytes(4)
    if (key.length !== 4) throw new Error('RawWsClient: maskKey must be exactly 4 bytes')
    const masked = Buffer.from(payload)
    for (let i = 0; i < masked.length; i++) masked[i] = masked[i]! ^ key[i % 4]!
    wire = Buffer.concat([header, key, masked])
  } else {
    wire = Buffer.concat([header, payload])
  }

  return {
    wire,
    record: {
      fin, rsv1, rsv2, rsv3, opcode,
      payloadBytes: payload.length,
      wireBytes: wire.length,
      masked: useMask && !omitMaskKey,
    },
  }
}

interface ParsedHandshake {
  record: HandshakeRecord
  /** Bytes already read past the CRLFCRLF terminator (first WS data). */
  rest: Buffer
}

export class RawWsClient {
  private socket: net.Socket
  private readonly _handshake: HandshakeRecord
  private readonly options: Required<Pick<RawWsClientOptions, 'autoReplyPing' | 'autoReplyClose'>>

  private recvBuffer: Buffer = Buffer.alloc(0)
  private readonly sent: SentFrameRecord[] = []
  private readonly received: ReceivedFrameRecord[] = []
  private _peerClose: { code: number; reason: string; at: number } | null = null
  private _peerEnded = false
  private _destroyed = false
  private _socketError: Error | null = null
  private _sentClose = false
  private bytesSnapshot: { sent: number; received: number } | null = null

  private constructor(socket: net.Socket, handshake: HandshakeRecord, rest: Buffer, options: RawWsClientOptions) {
    this.socket = socket
    this._handshake = handshake
    this.options = {
      autoReplyPing: options.autoReplyPing ?? true,
      autoReplyClose: options.autoReplyClose ?? true,
    }

    this.socket.on('data', (chunk: Buffer) => this.handleData(chunk))
    this.socket.on('error', (err: Error) => {
      this._socketError = err
    })
    this.socket.on('end', () => {
      this._peerEnded = true
    })
    this.socket.on('close', () => {
      this._destroyed = true
      this.bytesSnapshot = {
        sent: this.socket.bytesWritten,
        received: this.socket.bytesRead,
      }
    })

    if (rest.length > 0) this.handleData(rest)
    if (options.autoRead === false) this.socket.pause()
  }

  /**
   * Connect to `ws://host:port/path`, perform the handshake manually, and
   * resolve once the 101 response headers have been consumed. Throws
   * `RawWsHandshakeError` on a non-101 response (the response status,
   * headers, and an immediate body prefix are preserved for assertions).
   */
  static async connect(wsUrl: string, options: RawWsClientOptions = {}): Promise<RawWsClient> {
    const url = new URL(wsUrl)
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      throw new Error(`RawWsClient: only ws:// URLs are supported (got ${url.protocol})`)
    }
    if (url.protocol === 'wss:') {
      throw new Error('RawWsClient: wss:// is not supported by the raw client (loopback tests use ws://)')
    }
    const host = url.hostname
    const port = url.port ? Number(url.port) : 80
    const path = `${url.pathname || '/'}${url.search}`
    const timeoutMs = options.handshakeTimeoutMs ?? 10_000

    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const sock = net.connect({ host, port })
      const timer = setTimeout(() => {
        sock.destroy()
        reject(new Error(`RawWsClient: TCP connect to ${host}:${port} timed out`))
      }, timeoutMs)
      sock.once('connect', () => {
        clearTimeout(timer)
        resolve(sock)
      })
      sock.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })

    const key = crypto.randomBytes(16).toString('base64')
    const headerLines = [
      `GET ${path} HTTP/1.1`,
      `Host: ${host}:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
    ]
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      headerLines.push(`${name}: ${value}`)
    }
    socket.write(headerLines.join('\r\n') + '\r\n\r\n')

    let parsed: ParsedHandshake
    try {
      parsed = await RawWsClient.readHandshakeHead(socket, timeoutMs)
    } catch (error) {
      socket.destroy()
      throw error
    }

    const { record } = parsed
    if (record.status === 101) {
      if (options.validateAccept !== false) {
        const expected = sha1Base64(key + WS_ACCEPT_GUID)
        if (record.headers['sec-websocket-accept'] !== expected) {
          socket.destroy()
          throw new RawWsHandshakeError(record.status, record.statusMessage, record.headers,
            `Sec-WebSocket-Accept mismatch: got ${record.headers['sec-websocket-accept'] ?? '<missing>'}, expected ${expected}`)
        }
      }
      return new RawWsClient(socket, record, parsed.rest, options)
    }

    // Non-101: preserve whatever body bytes already arrived, then tear down.
    const bodyPrefix = parsed.rest.subarray(0, HANDSHAKE_BODY_PREFIX_BYTES).toString('utf8')
    socket.destroy()
    throw new RawWsHandshakeError(record.status, record.statusMessage, record.headers, bodyPrefix)
  }

  private static readHandshakeHead(socket: net.Socket, timeoutMs: number): Promise<ParsedHandshake> {
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0)
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('RawWsClient: timed out waiting for handshake response head'))
      }, timeoutMs)

      function cleanup() {
        clearTimeout(timer)
        socket.off('data', onData)
        socket.off('error', onError)
        socket.off('close', onClose)
      }

      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])
        const headEnd = buffer.indexOf('\r\n\r\n')
        if (headEnd === -1) {
          if (buffer.length > MAX_HANDSHAKE_HEAD_BYTES) {
            cleanup()
            reject(new Error('RawWsClient: handshake head exceeded 16KiB without CRLFCRLF'))
          }
          return
        }
        cleanup()
        const rawHead = buffer.subarray(0, headEnd).toString('latin1')
        const rest = buffer.subarray(headEnd + 4)
        const lines = rawHead.split('\r\n')
        const statusLine = lines[0] ?? ''
        const statusMatch = statusLine.match(/^HTTP\/\d+\.\d+ (\d{3})(?: (.*))?$/)
        if (!statusMatch) {
          reject(new Error(`RawWsClient: unparseable handshake status line ${JSON.stringify(statusLine)}`))
          return
        }
        const headers: Record<string, string> = {}
        for (const line of lines.slice(1)) {
          const colon = line.indexOf(':')
          if (colon === -1) continue
          headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
        }
        resolve({
          record: {
            status: Number(statusMatch[1]),
            statusMessage: statusMatch[2] ?? '',
            headers,
            rawHead,
          },
          rest,
        })
      }
      const onError = (err: Error) => {
        cleanup()
        reject(err)
      }
      const onClose = () => {
        cleanup()
        reject(new Error('RawWsClient: socket closed before handshake completed'))
      }

      socket.on('data', onData)
      socket.on('error', onError)
      socket.on('close', onClose)
    })
  }

  // ---------------------------------------------------------------- getters

  get handshake(): HandshakeRecord {
    return this._handshake
  }

  /** Total bytes written to the socket (socket-truth). */
  get bytesSent(): number {
    return this.bytesSnapshot?.sent ?? this.socket.bytesWritten
  }

  /** Total bytes delivered from the socket to userland (socket-truth). */
  get bytesReceived(): number {
    return this.bytesSnapshot?.received ?? this.socket.bytesRead
  }

  get sentFrames(): readonly SentFrameRecord[] {
    return this.sent
  }

  get receivedFrames(): readonly ReceivedFrameRecord[] {
    return this.received
  }

  /** Set once a CLOSE frame has been received from the peer. */
  get peerClose(): { code: number; reason: string; at: number } | null {
    return this._peerClose
  }

  /** True once TCP EOF has been observed from the peer. */
  get peerEnded(): boolean {
    return this._peerEnded
  }

  get destroyed(): boolean {
    return this._destroyed
  }

  get socketError(): Error | null {
    return this._socketError
  }

  get reading(): boolean {
    return !this.socket.isPaused()
  }

  // ------------------------------------------------------------- read ctrl

  /** Stop draining the socket (genuine slow-consumer: TCP backpressure). */
  pauseReads(): void {
    this.socket.pause()
  }

  resumeReads(): void {
    this.socket.resume()
  }

  // ----------------------------------------------------------------- sends

  /**
   * Send exactly one frame per `options` and record it. Malformed variants
   * (rsv bits, unknown opcode, unmasked, missing mask key, length lies) are
   * the POINT of this API; nothing here second-guesses the caller.
   */
  sendFrame(options: RawFrameOptions): SentFrameRecord {
    if (this._destroyed) throw new Error('RawWsClient: socket destroyed')
    const { wire, record } = encodeFrame(options)
    this.socket.write(wire)
    const full: SentFrameRecord = { ...record, at: Date.now() }
    this.sent.push(full)
    if (options.opcode === WS_OPCODE.CLOSE) this._sentClose = true
    return full
  }

  sendText(text: string): SentFrameRecord {
    return this.sendFrame({ opcode: WS_OPCODE.TEXT, payload: text })
  }

  sendJson(value: unknown): SentFrameRecord {
    return this.sendText(JSON.stringify(value))
  }

  sendBinary(payload: Buffer): SentFrameRecord {
    return this.sendFrame({ opcode: WS_OPCODE.BINARY, payload })
  }

  sendPing(payload?: Buffer | string): SentFrameRecord {
    return this.sendFrame({ opcode: WS_OPCODE.PING, payload })
  }

  sendPong(payload?: Buffer | string): SentFrameRecord {
    return this.sendFrame({ opcode: WS_OPCODE.PONG, payload })
  }

  sendClose(code = 1000, reason = ''): SentFrameRecord {
    const reasonBuf = Buffer.from(reason, 'utf8')
    const payload = Buffer.alloc(2 + reasonBuf.length)
    payload.writeUInt16BE(code, 0)
    reasonBuf.copy(payload, 2)
    return this.sendFrame({ opcode: WS_OPCODE.CLOSE, payload })
  }

  /**
   * Initiate and await a graceful close handshake. Timing the hello/read
   * delays is the caller's job; this is just sendClose + bounded wait for
   * the peer's terminal response.
   */
  async closeGracefully(
    code = 1000,
    reason = '',
    timeoutMs = 5000,
  ): Promise<'peer-close' | 'tcp-end' | 'local-abort' | 'error'> {
    this.sendClose(code, reason)
    return this.waitForTerminalEvent(timeoutMs)
  }

  /** Send the Freshell `hello` handshake frame (deliberately NOT automatic,
   *  so delayed-hello tests control exactly when it goes out). */
  hello(token: string, protocolVersion: number = WS_PROTOCOL_VERSION): SentFrameRecord {
    return this.sendJson({ type: 'hello', token, protocolVersion })
  }

  // ----------------------------------------------------------------- waits

  /** Poll the received-frames ledger until `pred` matches or timeout. */
  async waitForFrame(
    pred: (frame: ReceivedFrameRecord) => boolean,
    timeoutMs: number,
    label = 'matching frame',
  ): Promise<ReceivedFrameRecord> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hit = this.received.find(pred)
      if (hit) return hit
      if (Date.now() >= deadline) {
        throw new Error(`RawWsClient: timed out after ${timeoutMs}ms waiting for ${label}`)
      }
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  /**
   * Wait for a TEXT frame whose JSON body has `.type === type` and resolve
   * with the parsed object. (Freshell server frames are JSON text frames.)
   */
  async nextJsonMessage<T = any>(type: string, timeoutMs: number): Promise<T> {
    const frame = await this.waitForFrame((f) => {
      if (f.opcode !== WS_OPCODE.TEXT) return false
      try {
        return (JSON.parse(f.payload.toString('utf8')) as { type?: unknown })?.type === type
      } catch {
        return false
      }
    }, timeoutMs, `json message type=${JSON.stringify(type)}`)
    return JSON.parse(frame.payload.toString('utf8')) as T
  }

  /**
   * Resolve after `durationMs` with the frames received during the window
   * ([] while reads are paused — the delayed-receive assertion primitive).
   */
  async collectFramesDuring(durationMs: number): Promise<ReceivedFrameRecord[]> {
    const start = this.received.length
    await new Promise((r) => setTimeout(r, durationMs))
    return this.received.slice(start)
  }

  /**
   * Resolve when the connection reaches any terminal state (peer CLOSE
   * frame, TCP EOF, local abort, or socket error), reporting which.
   */
  async waitForTerminalEvent(
    timeoutMs: number,
  ): Promise<'peer-close' | 'tcp-end' | 'local-abort' | 'error'> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (this._peerClose) return 'peer-close'
      if (this._peerEnded) return 'tcp-end'
      if (this._socketError) return 'error'
      if (this._destroyed) return 'local-abort'
      if (Date.now() >= deadline) {
        throw new Error(`RawWsClient: timed out after ${timeoutMs}ms waiting for a terminal event`)
      }
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  // ------------------------------------------------------------- teardown

  /** Abrupt teardown: destroy the socket immediately. */
  abort(): void {
    this.socket.destroy()
  }

  /** Idempotent full teardown (abort + settle). */
  async dispose(): Promise<void> {
    if (this._destroyed) {
      this.socket.removeAllListeners()
      return
    }
    this.socket.removeAllListeners('data')
    this.socket.destroy()
    const deadline = Date.now() + 2000
    while (!this._destroyed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    this.socket.removeAllListeners()
  }

  // ---------------------------------------------------------------- decode

  static text(frame: ReceivedFrameRecord): string {
    return frame.payload.toString('utf8')
  }

  static json<T = any>(frame: ReceivedFrameRecord): T {
    return JSON.parse(frame.payload.toString('utf8')) as T
  }

  // --------------------------------------------------------------- parser

  private handleData(chunk: Buffer): void {
    if (this._destroyed) return
    this.recvBuffer = this.recvBuffer.length === 0 ? chunk : Buffer.concat([this.recvBuffer, chunk])
    for (;;) {
      const parsed = this.tryParseFrame()
      if (!parsed) return
      const { frame, consumed } = parsed
      this.recvBuffer = this.recvBuffer.subarray(consumed)
      this.received.push(frame)
      this.handleControlFrame(frame)
    }
  }

  private handleControlFrame(frame: ReceivedFrameRecord): void {
    if (frame.opcode === WS_OPCODE.CLOSE && !this._peerClose) {
      const code = frame.payloadBytes >= 2 ? frame.payload.readUInt16BE(0) : 1005
      const reason = frame.payloadBytes > 2 ? frame.payload.subarray(2).toString('utf8') : ''
      this._peerClose = { code, reason, at: frame.at }
      if (this.options.autoReplyClose && !this._sentClose && !this._destroyed) {
        try {
          this.sendClose(code)
        } catch {
          // peer may already have ended the socket; close-reply is best-effort
        }
      }
      return
    }
    if (frame.opcode === WS_OPCODE.PING && this.options.autoReplyPing && !this._destroyed) {
      try {
        this.sendPong(frame.payload)
      } catch {
        // best-effort
      }
    }
  }

  /** Parse one frame from `recvBuffer`; null when more bytes are needed. */
  private tryParseFrame(): { frame: ReceivedFrameRecord; consumed: number } | null {
    const buffer = this.recvBuffer
    if (buffer.length < 2) return null

    const b0 = buffer[0]!
    const b1 = buffer[1]!
    const fin = (b0 & 0x80) !== 0
    const rsv1 = (b0 & 0x40) !== 0
    const rsv2 = (b0 & 0x20) !== 0
    const rsv3 = (b0 & 0x10) !== 0
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    const len7 = b1 & 0x7f

    let headerLength = 2
    let payloadLength: number
    if (len7 < 126) {
      payloadLength = len7
    } else if (len7 === 126) {
      headerLength = 4
      if (buffer.length < headerLength) return null
      payloadLength = buffer.readUInt16BE(2)
    } else {
      headerLength = 10
      if (buffer.length < headerLength) return null
      const big = buffer.readBigUInt64BE(2)
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`RawWsClient: received frame length ${big} exceeds safe integer range`)
      }
      payloadLength = Number(big)
    }

    const maskKeyLength = masked ? 4 : 0
    const total = headerLength + maskKeyLength + payloadLength
    if (buffer.length < total) return null

    let payload = Buffer.from(buffer.subarray(headerLength + maskKeyLength, total))
    if (masked) {
      const key = buffer.subarray(headerLength, headerLength + 4)
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ key[i % 4]!
    }

    const frame: ReceivedFrameRecord = {
      fin, rsv1, rsv2, rsv3, opcode, masked,
      payload,
      payloadBytes: payload.length,
      wireBytes: total,
      at: Date.now(),
    }
    return { frame, consumed: total }
  }
}

export type RawHttpMethod = string

export interface RawHttpRequestOptions {
  /** Default 'GET'. */
  method?: RawHttpMethod
  /** Default '/'. May include a query string. */
  path?: string
  /** Full header control: any name/value, and omission is honored. */
  headers?: Record<string, string>
  body?: string | Buffer
  /** Default 10_000. */
  timeoutMs?: number
}

export interface RawHttpResponse {
  status: number
  statusMessage: string
  httpVersion: string
  /** Folded header map (multi-values joined with ', ' as Node does). */
  headers: http.IncomingHttpHeaders
  /** Raw [name, value, name, value...] sequence as received. */
  rawHeaders: string[]
  body: Buffer
  json(): unknown
  /** Socket-truth byte deltas for this request/response. */
  bytesSent: number
  bytesReceived: number
  durationMs: number
}

/**
 * Byte-accounted raw HTTP/1.1 request (orchestration routes from specs).
 * Not yet implemented — see docs/plans/df1/HARNESS-05.md Task 4.
 */
export function rawHttpRequest(_baseUrl: string, _options: RawHttpRequestOptions = {}): Promise<RawHttpResponse> {
  throw new Error('rawHttpRequest: not implemented (HARNESS-05 Task 4)')
}
