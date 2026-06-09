// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'
import WebSocket from 'ws'

const perfMocks = vi.hoisted(() => ({
  config: {
    enabled: true,
    wsPayloadWarnBytes: 16,
    rateLimitMs: 0,
  },
  logPerfEvent: vi.fn(),
  shouldLog: vi.fn(() => true),
}))

vi.mock('../../../server/perf-logger', () => ({
  getPerfConfig: () => perfMocks.config,
  logPerfEvent: perfMocks.logPerfEvent,
  shouldLog: perfMocks.shouldLog,
}))

import {
  prepareJsonMessage,
  readWebSocketBufferedAmount,
  sendJsonMessage,
  sendPreparedJsonMessage,
} from '../../../server/ws-send'

function createMockWs(overrides: Record<string, unknown> = {}) {
  const ws = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    connectionId: 'conn-test',
    send: vi.fn(),
    close: vi.fn(),
    ...overrides,
  }
  return ws as typeof ws & {
    readyState: number
    bufferedAmount: number
    connectionId?: string
    send: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  }
}

describe('ws-send', () => {
  beforeEach(() => {
    perfMocks.config.enabled = true
    perfMocks.config.wsPayloadWarnBytes = 16
    perfMocks.config.rateLimitMs = 0
    perfMocks.logPerfEvent.mockClear()
    perfMocks.shouldLog.mockClear()
    perfMocks.shouldLog.mockReturnValue(true)
  })

  it('serializes JSON once, measures serialized bytes, and reports bufferedAmount before and after send', () => {
    const ws = createMockWs()
    ws.send.mockImplementation((raw: string, cb?: (err?: Error) => void) => {
      ws.bufferedAmount += Buffer.byteLength(raw, 'utf8')
      cb?.()
    })

    const prepared = prepareJsonMessage({ type: 'unit.test', value: 'ok' })
    const result = sendPreparedJsonMessage(ws, prepared)

    expect(result.sent).toBe(true)
    expect(result.serializedApplicationJsonBytes).toBe(Buffer.byteLength(prepared.serialized, 'utf8'))
    expect(result.bufferedBefore).toBe(0)
    expect(result.bufferedAfter).toBe(Buffer.byteLength(prepared.serialized, 'utf8'))
    expect(ws.send).toHaveBeenCalledWith(prepared.serialized, expect.any(Function))
  })

  it('does not send to a closed socket', () => {
    const ws = createMockWs({ readyState: WebSocket.CLOSED })
    const result = sendJsonMessage(ws, { type: 'closed.test' })

    expect(result.sent).toBe(false)
    expect(result.reason).toBe('closed')
    expect(ws.send).not.toHaveBeenCalled()
  })

  it('closes before sending when bufferedAmount exceeds the configured backpressure limit', () => {
    const ws = createMockWs({ bufferedAmount: 2 * 1024 * 1024 + 1 })
    const result = sendJsonMessage(ws, { type: 'pressure.test' }, {
      maxBufferedAmount: 2 * 1024 * 1024,
      backpressureCloseCode: 4008,
      backpressureCloseReason: 'Backpressure',
    })

    expect(result.sent).toBe(false)
    expect(result.reason).toBe('backpressure')
    expect(ws.close).toHaveBeenCalledWith(4008, 'Backpressure')
    expect(ws.send).not.toHaveBeenCalled()
    expect(perfMocks.logPerfEvent).toHaveBeenCalledWith(
      'ws_backpressure_close',
      expect.objectContaining({
        connectionId: 'conn-test',
        bufferedBytes: 2 * 1024 * 1024 + 1,
        limitBytes: 2 * 1024 * 1024,
      }),
      'warn',
    )
  })

  it('does not send messages that exceed the serialized JSON byte budget', () => {
    const ws = createMockWs()
    const result = sendJsonMessage(ws, { type: 'budget.test', data: 'x'.repeat(64) }, {
      maxSerializedApplicationJsonBytes: 32,
    })

    expect(result.sent).toBe(false)
    expect(result.reason).toBe('oversized')
    expect(ws.send).not.toHaveBeenCalled()
  })

  it('logs ws_send_large from the ws.send callback with bufferedAmount measurements', () => {
    const ws = createMockWs({ bufferedAmount: 100 })
    ws.send.mockImplementation((raw: string, cb?: (err?: Error) => void) => {
      ws.bufferedAmount += Buffer.byteLength(raw, 'utf8')
      cb?.()
    })

    const result = sendJsonMessage(ws, { type: 'large.test', data: 'x'.repeat(32) })

    expect(result.sent).toBe(true)
    expect(perfMocks.logPerfEvent).toHaveBeenCalledWith(
      'ws_send_large',
      expect.objectContaining({
        connectionId: 'conn-test',
        messageType: 'large.test',
        payloadBytes: result.serializedApplicationJsonBytes,
        bufferedBytes: 100,
        bufferedBytesAfter: result.bufferedAfter,
        error: false,
      }),
      'warn',
    )
  })

  it('normalizes unavailable bufferedAmount reads to undefined', () => {
    expect(readWebSocketBufferedAmount({ bufferedAmount: undefined })).toBeUndefined()
    expect(readWebSocketBufferedAmount({ bufferedAmount: Number.NaN })).toBeUndefined()
  })
})
