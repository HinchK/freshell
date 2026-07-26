import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WsClient, getWsClient, resetWsClientForTests } from '../../../../src/lib/ws-client'

class MockWebSocket {
  static OPEN = 1
  static instances: MockWebSocket[] = []

  readyState = MockWebSocket.OPEN
  onopen: null | (() => void) = null
  onmessage: null | ((ev: { data: string }) => void) = null
  onclose: null | ((ev: { code: number; reason: string }) => void) = null
  onerror: null | (() => void) = null
  sent: string[] = []

  constructor(_url: string) {
    MockWebSocket.instances.push(this)
  }

  send(data: any) {
    this.sent.push(String(data))
  }

  close() {
    this.onclose?.({ code: 1000, reason: '' })
  }

  _open() {
    this.onopen?.()
  }

  _message(obj: any) {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }

  _close(code: number, reason = '') {
    this.onclose?.({ code, reason })
  }
}

async function connectAndReady(c: WsClient, ready: Record<string, unknown> = {}): Promise<MockWebSocket> {
  const p = c.connect()
  const instance = MockWebSocket.instances[MockWebSocket.instances.length - 1]
  instance._open()
  instance._message({ type: 'ready', ...ready })
  await p
  return instance
}

function framesOf(instance: MockWebSocket): any[] {
  return instance.sent.map((x) => JSON.parse(x))
}

describe('WsClient pane-reconcile capability', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    MockWebSocket.instances = []
    // @ts-expect-error - test override
    globalThis.WebSocket = MockWebSocket
    localStorage.setItem('freshell.auth-token', 't')

    // Some Vitest environments provide a minimal window without timer fns.
    ;(window as any).setTimeout = globalThis.setTimeout
    ;(window as any).clearTimeout = globalThis.clearTimeout
  })

  afterEach(() => {
    resetWsClientForTests()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('hello advertises paneReconcileV1', async () => {
    const c = new WsClient('ws://example/ws')
    const p = c.connect()
    expect(MockWebSocket.instances).toHaveLength(1)
    MockWebSocket.instances[0]._open()

    const hello = JSON.parse(MockWebSocket.instances[0].sent[0])
    expect(hello.type).toBe('hello')
    expect(hello.capabilities).toMatchObject({
      uiScreenshotV1: true,
      terminalOutputBatchV1: true,
      paneReconcileV1: true,
    })

    MockWebSocket.instances[0]._message({ type: 'ready' })
    await p
  })

  it('surfaces ready.capabilities and resets them on disconnect', async () => {
    const client = getWsClient()
    expect(client.getServerCapabilities()).toEqual({})

    await connectAndReady(client, { capabilities: { paneReconcileV1: true } })
    expect(client.getServerCapabilities().paneReconcileV1).toBe(true)

    MockWebSocket.instances[0]._close(1006, 'drop')
    expect(client.getServerCapabilities().paneReconcileV1).toBeUndefined()
    expect(client.getServerCapabilities()).toEqual({})
  })

  it('suppresses the in-flight create replay when the capability is acked', async () => {
    const c = new WsClient('ws://example/ws')
    c.send({ type: 'terminal.create', requestId: 'cr-1', mode: 'shell' } as any)

    await connectAndReady(c, { capabilities: { paneReconcileV1: true } })
    MockWebSocket.instances[0]._close(1006, 'drop-after-create')

    const reconnectInstance = await connectAndReady(c, { capabilities: { paneReconcileV1: true } })
    const creates = framesOf(reconnectInstance).filter((f) => f.type === 'terminal.create')
    expect(creates).toHaveLength(0)
  })

  it('keeps the legacy replay when the server does not ack (old server)', async () => {
    const c = new WsClient('ws://example/ws')
    c.send({ type: 'terminal.create', requestId: 'cr-1', mode: 'shell' } as any)

    await connectAndReady(c, { /* no capabilities */ })
    MockWebSocket.instances[0]._close(1006, 'drop-after-create')

    const reconnectInstance = await connectAndReady(c, { /* no capabilities */ })
    const creates = framesOf(reconnectInstance).filter((f) => f.type === 'terminal.create')
    expect(creates).toHaveLength(1)
  })

  it('honors a downgraded server: capability acked on a previous socket does not suppress replay', async () => {
    const c = new WsClient('ws://example/ws')
    c.send({ type: 'terminal.create', requestId: 'cr-1', mode: 'shell' } as any)

    // First connection acks the capability.
    await connectAndReady(c, { capabilities: { paneReconcileV1: true } })
    MockWebSocket.instances[0]._close(1006, 'drop-after-create')

    // Downgraded server: reconnect ready has no capabilities. Legacy replay must fire.
    const reconnectInstance = await connectAndReady(c, { /* no capabilities */ })
    const creates = framesOf(reconnectInstance).filter((f) => f.type === 'terminal.create')
    expect(creates).toHaveLength(1)
  })

  it('flushes the pre-ready create queue even when the capability is acked', async () => {
    const c = new WsClient('ws://example/ws')
    // Queued while offline: this is a NEW user-initiated create, not a replay.
    c.send({ type: 'terminal.create', requestId: 'cr-new', mode: 'shell' } as any)

    const instance = await connectAndReady(c, { capabilities: { paneReconcileV1: true } })
    const creates = framesOf(instance).filter((f) => f.type === 'terminal.create')
    expect(creates).toEqual([
      expect.objectContaining({ type: 'terminal.create', requestId: 'cr-new' }),
    ])
  })
})
