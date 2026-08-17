// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import http from 'http'
import WebSocket from 'ws'
import { WS_PROTOCOL_VERSION } from '../../shared/ws-protocol'

/**
 * End-to-end wire pins for `terminal.modes.sync` through the WsHandler attach
 * ingress (plan v5 round-4 D: surfaceReset must be threaded from the validated
 * attach message into the broker). Broker-unit coverage of the projection and
 * gating lives in test/unit/server/terminal-stream/broker-modes-sync.test.ts.
 *
 * Also pins the Node dead-attach rule (plan round-3 #8): attaches to an exited
 * terminal are rejected with INVALID_TERMINAL_ID BEFORE any broker attach, so
 * no `terminal.modes.sync` may precede that error on the wire.
 */

const TEST_TIMEOUT_MS = 30_000
const HOOK_TIMEOUT_MS = 30_000

vi.setConfig({ testTimeout: TEST_TIMEOUT_MS, hookTimeout: HOOK_TIMEOUT_MS })

const ESC = '\u001b'
const MODE_PREAMBLE = `${ESC}[?1000;1002;1003;1006;2004h${ESC}[?1049h`
const EXPECTED_SYNC_DATA = `${ESC}[?1003h${ESC}[?1006h${ESC}[?1049h${ESC}[?2004h`

class FakeBuffer {
  private chunks: string[] = []

  append(chunk: string): void {
    if (!chunk) return
    this.chunks.push(chunk)
  }

  snapshot(): string {
    return this.chunks.join('')
  }
}

class FakeRegistry extends EventEmitter {
  private records = new Map<string, any>()

  create(opts: any) {
    const terminalId = `term-modes-${this.records.size + 1}`
    const record = {
      terminalId,
      createdAt: Date.now(),
      buffer: new FakeBuffer(),
      title: opts.mode === 'codex' ? 'Codex' : 'Shell',
      mode: opts.mode || 'shell',
      shell: opts.shell || 'system',
      status: 'running',
      resumeSessionId: opts.resumeSessionId,
      clients: new Set<WebSocket>(),
      suppressedOutputClients: new Set<WebSocket>(),
    }
    this.records.set(terminalId, record)
    return record
  }

  get(terminalId: string) {
    return this.records.get(terminalId) || null
  }

  attach(terminalId: string, ws: WebSocket, opts?: { suppressOutput?: boolean }) {
    const record = this.records.get(terminalId)
    if (!record) return null
    record.clients.add(ws)
    if (opts?.suppressOutput) record.suppressedOutputClients.add(ws)
    return record
  }

  detach(terminalId: string, ws: WebSocket) {
    const record = this.records.get(terminalId)
    if (!record) return false
    record.clients.delete(ws)
    record.suppressedOutputClients.delete(ws)
    return true
  }

  input(terminalId: string, _data: string) {
    return !!this.records.get(terminalId)
  }

  resize(terminalId: string, _cols: number, _rows: number) {
    return !!this.records.get(terminalId)
  }

  kill(terminalId: string) {
    const record = this.records.get(terminalId)
    if (!record) return false
    record.status = 'exited'
    return true
  }

  list() {
    return Array.from(this.records.values()).map((record) => ({
      terminalId: record.terminalId,
      title: record.title,
      mode: record.mode,
      createdAt: record.createdAt,
      status: record.status,
      hasClients: record.clients.size > 0,
      attachedClientCount: record.clients.size,
    }))
  }

  findRunningClaudeTerminalBySession(_sessionId: string) {
    return undefined
  }

  getCanonicalRunningTerminalBySession(_mode: string, _sessionId: string) {
    return undefined
  }

  repairLegacySessionOwners(_mode: string, _sessionId: string) {
    return {
      repaired: false,
      canonicalTerminalId: undefined,
      clearedTerminalIds: [] as string[],
    }
  }

  simulateOutput(terminalId: string, data: string) {
    const record = this.records.get(terminalId)
    if (!record || record.status !== 'running') return
    record.buffer.append(data)
    this.emit('terminal.output.raw', { terminalId, data, at: Date.now() })
  }
}

function listen(server: http.Server): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'object' && address) resolve({ port: address.port })
    })
  })
}

function waitForMessage(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 5_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', handler)
      reject(new Error('Timeout waiting for message'))
    }, timeoutMs)
    const handler = (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (!predicate(msg)) return
        clearTimeout(timeout)
        ws.off('message', handler)
        resolve(msg)
      } catch {
        // Ignore malformed frames in tests.
      }
    }
    ws.on('message', handler)
  })
}

async function createAuthenticatedConnection(port: number): Promise<{ ws: WebSocket; close: () => Promise<void> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  await new Promise<void>((resolve) => ws.on('open', () => resolve()))

  const readyPromise = waitForMessage(ws, (msg) => msg.type === 'ready')
  ws.send(JSON.stringify({
    type: 'hello',
    token: 'testtoken-testtoken',
    protocolVersion: WS_PROTOCOL_VERSION,
  }))
  await readyPromise

  return {
    ws,
    close: () => new Promise<void>((resolve) => {
      ws.once('close', () => resolve())
      ws.close()
    }),
  }
}

async function createTerminal(ws: WebSocket, requestId: string): Promise<string> {
  ws.send(JSON.stringify({
    type: 'terminal.create',
    requestId,
    mode: 'shell',
    shell: 'system',
  }))
  const created = await waitForMessage(ws, (msg) => msg.type === 'terminal.created' && msg.requestId === requestId)
  const terminalId = created.terminalId as string
  ws.send(JSON.stringify({
    type: 'terminal.attach',
    terminalId,
    intent: 'viewport_hydrate',
    sinceSeq: 0,
    cols: 120,
    rows: 40,
    attachRequestId: `${requestId}-attach`,
  }))
  await waitForMessage(ws, (msg) => msg.type === 'terminal.attach.ready' && msg.terminalId === terminalId)
  return terminalId
}

function sendAttach(
  ws: WebSocket,
  terminalId: string,
  opts: { attachRequestId: string; surfaceReset?: boolean },
) {
  ws.send(JSON.stringify({
    type: 'terminal.attach',
    terminalId,
    intent: 'viewport_hydrate',
    sinceSeq: 0,
    cols: 120,
    rows: 40,
    attachRequestId: opts.attachRequestId,
    ...(opts.surfaceReset !== undefined ? { surfaceReset: opts.surfaceReset } : {}),
  }))
}

describe('ws terminal.modes.sync', () => {
  let server: http.Server | undefined
  let WsHandler: any
  let handler: any
  let registry: FakeRegistry
  let port: number
  let originalNodeEnv: string | undefined
  let originalAuthToken: string | undefined

  beforeEach(async () => {
    originalNodeEnv = process.env.NODE_ENV
    originalAuthToken = process.env.AUTH_TOKEN
    process.env.NODE_ENV = 'test'
    process.env.AUTH_TOKEN = 'testtoken-testtoken'

    vi.resetModules()
    ;({ WsHandler } = await import('../../server/ws-handler'))
    server = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })
    registry = new FakeRegistry()
    handler = new WsHandler(server, registry as any)
    ;({ port } = await listen(server))
  }, HOOK_TIMEOUT_MS)

  afterEach(async () => {
    handler = undefined
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()))
      server = undefined
    }
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalNodeEnv
    if (originalAuthToken === undefined) delete process.env.AUTH_TOKEN
    else process.env.AUTH_TOKEN = originalAuthToken
  }, HOOK_TIMEOUT_MS)

  it('a surfaceReset attach receives terminal.modes.sync after ready and before replay output (f01 shape)', async () => {
    const { ws: ws1, close: close1 } = await createAuthenticatedConnection(port)
    const terminalId = await createTerminal(ws1, 'modes-sync-create')
    registry.simulateOutput(terminalId, MODE_PREAMBLE)
    registry.simulateOutput(terminalId, 'freshell prompt$ ')

    const { ws: ws2, close: close2 } = await createAuthenticatedConnection(port)
    const received: any[] = []
    ws2.on('message', (data: WebSocket.Data) => {
      try {
        received.push(JSON.parse(data.toString()))
      } catch {
        // ignore malformed frames
      }
    })

    sendAttach(ws2, terminalId, { attachRequestId: 'hydrate-sync-1', surfaceReset: true })
    await waitForMessage(
      ws2,
      (msg) => msg.type === 'terminal.output' && msg.terminalId === terminalId && msg.data.includes('freshell prompt$ '),
    )
    // Give any straggler messages a beat so the ordering snapshot is complete.
    await new Promise((resolve) => setTimeout(resolve, 50))

    const forTerminal = received.filter((msg) => msg.terminalId === terminalId)
    const readyIndex = forTerminal.findIndex((msg) => msg.type === 'terminal.attach.ready')
    const syncIndex = forTerminal.findIndex((msg) => msg.type === 'terminal.modes.sync')
    const firstOutputIndex = forTerminal.findIndex((msg) => msg.type === 'terminal.output' || msg.type === 'terminal.output.batch')

    expect(readyIndex).toBeGreaterThanOrEqual(0)
    expect(syncIndex).toBeGreaterThan(readyIndex)
    expect(firstOutputIndex).toBeGreaterThan(syncIndex)

    const ready = forTerminal[readyIndex]
    const sync = forTerminal[syncIndex]
    expect(sync).toEqual({
      type: 'terminal.modes.sync',
      terminalId,
      attachRequestId: 'hydrate-sync-1',
      streamId: ready.streamId,
      data: EXPECTED_SYNC_DATA,
    })

    await close2()
    await close1()
  })

  it('an attach without surfaceReset receives no sync over the wire (f14 shape)', async () => {
    const { ws: ws1, close: close1 } = await createAuthenticatedConnection(port)
    const terminalId = await createTerminal(ws1, 'modes-nosync-create')
    registry.simulateOutput(terminalId, MODE_PREAMBLE)

    const { ws: ws2, close: close2 } = await createAuthenticatedConnection(port)
    const received: any[] = []
    ws2.on('message', (data: WebSocket.Data) => {
      try {
        received.push(JSON.parse(data.toString()))
      } catch {
        // ignore malformed frames
      }
    })

    sendAttach(ws2, terminalId, { attachRequestId: 'hydrate-plain-1' })
    await waitForMessage(
      ws2,
      (msg) => msg.type === 'terminal.output' && msg.terminalId === terminalId && msg.data.includes('?1049h'),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(received.filter((msg) => msg.type === 'terminal.modes.sync')).toEqual([])
    expect(received.some((msg) => msg.type === 'terminal.attach.ready')).toBe(true)

    await close2()
    await close1()
  })

  it('a surfaceReset attach to an exited terminal is rejected with INVALID_TERMINAL_ID and no sync', async () => {
    const { ws: ws1, close: close1 } = await createAuthenticatedConnection(port)
    const terminalId = await createTerminal(ws1, 'modes-dead-create')
    registry.kill(terminalId)

    const received: any[] = []
    ws1.on('message', (data: WebSocket.Data) => {
      try {
        received.push(JSON.parse(data.toString()))
      } catch {
        // ignore malformed frames
      }
    })

    sendAttach(ws1, terminalId, { attachRequestId: 'hydrate-dead-1', surfaceReset: true })
    await waitForMessage(ws1, (msg) => msg.type === 'error' && msg.code === 'INVALID_TERMINAL_ID')
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(received.some((msg) => msg.type === 'terminal.modes.sync')).toBe(false)

    await close1()
  })
})
