/**
 * HARNESS-05 — a deterministic echo/error WebSocket fixture owned by a test.
 *
 * Binds an ephemeral loopback port and speaks a tiny command protocol so
 * specs can prove raw-client capabilities WITHOUT involving either real
 * Freshell server (Rust protocol semantics are proven by later items; the
 * checklist acceptance here is helper behavior):
 *
 *   - any TEXT/BINARY frame that does not match a command → echoed verbatim
 *     (same opcode, same payload bytes)
 *   - text `close:<code>:<reason>` → server initiates a close handshake with
 *     exactly that code/reason
 *   - text `flood:<count>:<size>` → server sends <count> TEXT frames whose
 *     payload is `flood:<i>:` x-padded to <size> bytes (if <size> is smaller
 *     than the prefix, the prefix wins and the frame is longer than <size>;
 *     tests always use comfortably larger sizes)
 *   - text `drop` → the underlying TCP connection is destroyed abruptly
 *     (`ws.terminate()`), with NO close frame
 *
 * The fixture NEVER sends a frame unprompted, so every inbound frame a test
 * observes is attributable to a command the test sent.
 *
 * Every connection gets a ledger entry (open/close/close-code/reason/frame
 * count/errors). Per-connection `ws.on('error')` handlers are attached
 * deliberately: raw-client tests intentionally send protocol-violating
 * frames, and an unhandled ws 'error' event would crash the test process
 * (verified during the HARNESS-05 load-bearing probes). Errors are recorded
 * into the ledger instead.
 */
import { WebSocketServer, WebSocket, type RawData } from 'ws'

export interface EchoConnectionLedgerEntry {
  id: number
  openedAt: number
  closedAt: number | null
  closeCode: number | null
  closeReason: string | null
  framesReceived: number
  errors: string[]
}

export class EchoWsFixture {
  private wss: WebSocketServer
  private readonly ledger: EchoConnectionLedgerEntry[] = []
  private readonly live = new Set<WebSocket>()
  private nextConnectionId = 1
  private stopped = false

  private constructor(wss: WebSocketServer) {
    this.wss = wss
  }

  static async start(): Promise<EchoWsFixture> {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((resolve, reject) => {
      wss.on('listening', () => resolve())
      wss.on('error', reject)
    })
    const fixture = new EchoWsFixture(wss)
    wss.on('connection', (ws) => fixture.handleConnection(ws))
    return fixture
  }

  get port(): number {
    const address = this.wss.address()
    if (!address || typeof address === 'string') {
      throw new Error('EchoWsFixture: server has no port (not started?)')
    }
    return address.port
  }

  get wsUrl(): string {
    return `ws://127.0.0.1:${this.port}/`
  }

  get connections(): readonly EchoConnectionLedgerEntry[] {
    return this.ledger
  }

  private handleConnection(ws: WebSocket): void {
    const entry: EchoConnectionLedgerEntry = {
      id: this.nextConnectionId++,
      openedAt: Date.now(),
      closedAt: null,
      closeCode: null,
      closeReason: null,
      framesReceived: 0,
      errors: [],
    }
    this.ledger.push(entry)
    this.live.add(ws)

    ws.on('error', (err) => {
      // Expected path for deliberately-malformed client frames (LB-1).
      entry.errors.push(String(err?.message ?? err))
    })

    ws.on('close', (code, reason) => {
      entry.closedAt = Date.now()
      entry.closeCode = code
      entry.closeReason = reason.toString()
      this.live.delete(ws)
    })

    ws.on('message', (data: RawData, isBinary: boolean) => {
      entry.framesReceived += 1
      const text = isBinary ? '' : String(data)

      const closeMatch = text.match(/^close:(\d+):([\s\S]*)$/)
      if (closeMatch) {
        ws.close(Number(closeMatch[1]), closeMatch[2])
        return
      }

      if (text === 'drop') {
        ws.terminate()
        return
      }

      const floodMatch = text.match(/^flood:(\d+):(\d+)$/)
      if (floodMatch) {
        const count = Number(floodMatch[1])
        const size = Number(floodMatch[2])
        for (let i = 0; i < count; i++) {
          const payload = `flood:${i}:`.padEnd(size, 'x')
          try {
            ws.send(payload)
          } catch (err) {
            entry.errors.push(String((err as Error)?.message ?? err))
          }
        }
        return
      }

      try {
        ws.send(data, { binary: isBinary })
      } catch (err) {
        entry.errors.push(String((err as Error)?.message ?? err))
      }
    })
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    for (const ws of this.live) {
      try {
        ws.terminate()
      } catch {
        // already gone
      }
    }
    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve())
      // wss.close's callback only fires once the underlying server has
      // closed; terminated sockets may keep it pending briefly.
    })
  }
}
