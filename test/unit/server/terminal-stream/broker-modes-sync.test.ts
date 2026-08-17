// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalStreamBroker } from '../../../../server/terminal-stream/broker'
import { createMockWs, FakeBrokerRegistry, type MockWs } from '../../../helpers/ws-backpressure'

/**
 * Broker-level pins for `terminal.modes.sync` emission (plan v5 §2):
 * - emitted ONLY on attaches marked surfaceReset === true, regardless of intent
 * - strictly ordered after `terminal.attach.ready` and before any replay/live
 *   output on that socket, with zero awaits between ready and sync
 * - skipped when attachRequestId is absent (client fails closed without one)
 * - skipped when the synthesized projection is empty
 * - seq-less control plane: no seqStart/seqEnd fields
 * - tracker rebirth on 'terminal.stream.replaced' (keyed to (terminalId,
 *   streamId) — old-stream projection dies, new stream's bytes repopulate)
 *
 * Oracle fixtures f14 (surfaceReset false) and f15 (empty tracker) map to the
 * two skip-unit tests below.
 */

const loggerMocks = vi.hoisted(() => {
  const logger = {
    child: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  logger.child.mockReturnValue(logger)
  return { logger }
})

vi.mock('../../../../server/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../server/logger')>()
  return {
    ...actual,
    logger: loggerMocks.logger,
    sessionLifecycleLogger: loggerMocks.logger,
  }
})

const ESC = '\u001b'
const MODE_PREAMBLE = `${ESC}[?1003h${ESC}[?1006h${ESC}[?1049h${ESC}[?2004h`

function payloadSends(ws: MockWs): any[] {
  return ws.send.mock.calls.map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
}

function describeAttach(
  name: string,
  run: (ctx: {
    registry: FakeBrokerRegistry
    broker: TerminalStreamBroker
    terminalId: string
  }) => Promise<void> | void,
) {
  it(name, async () => {
    const registry = new FakeBrokerRegistry()
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    const terminalId = `term-modes-${Math.random().toString(36).slice(2, 10)}`
    registry.createTerminal(terminalId)
    try {
      await run({ registry, broker, terminalId })
    } finally {
      broker.close()
    }
  })
}

describe('TerminalStreamBroker terminal.modes.sync', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    loggerMocks.logger.debug.mockClear()
    loggerMocks.logger.info.mockClear()
    loggerMocks.logger.warn.mockClear()
    loggerMocks.logger.error.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describeAttach('emits ready < sync < replay with exact payload on a surfaceReset attach', async ({ registry, broker, terminalId }) => {
    registry.emit('terminal.output.raw', { terminalId, data: MODE_PREAMBLE, at: Date.now() })
    registry.emit('terminal.output.raw', { terminalId, data: 'app-banner\r\n', at: Date.now() })

    const ws = createMockWs()
    const result = await broker.attach(
      ws as any,
      terminalId,
      'viewport_hydrate',
      80,
      24,
      0,
      'req-sync-1',
      undefined,
      'foreground',
      false,
      true,
    )
    expect(result).toBe('attached')

    // Zero awaits between ready and sync: both must already be on the wire,
    // with NO replay output yet (replay flushes on a later macrotask).
    const immediate = payloadSends(ws)
    const ready = immediate.find((msg) => msg.type === 'terminal.attach.ready')
    const sync = immediate.find((msg) => msg.type === 'terminal.modes.sync')
    expect(ready).toBeTruthy()
    expect(sync).toBeTruthy()
    expect(immediate.some((msg) => msg.type === 'terminal.output' || msg.type === 'terminal.output.batch')).toBe(false)

    expect(immediate.indexOf(ready)).toBeLessThan(immediate.indexOf(sync))
    expect(sync).toEqual({
      type: 'terminal.modes.sync',
      terminalId,
      attachRequestId: 'req-sync-1',
      streamId: ready.streamId,
      data: `${ESC}[?1003h${ESC}[?1006h${ESC}[?1049h${ESC}[?2004h`,
    })
    // Control-plane: seq fields must not leak onto the sync frame.
    expect(sync.seqStart).toBeUndefined()
    expect(sync.seqEnd).toBeUndefined()

    // Replay flushes later and still carries the seeded bytes (sync consumed
    // nothing from the ring).
    vi.advanceTimersByTime(5)
    const afterFlush = payloadSends(ws)
    const replayOutputs = afterFlush.filter((msg) => msg.type === 'terminal.output' || msg.type === 'terminal.output.batch')
     expect(replayOutputs.length).toBeGreaterThan(0)
    expect(afterFlush.indexOf(sync)).toBeLessThan(afterFlush.indexOf(replayOutputs[0]))
  })

  describeAttach('skips sync when surfaceReset is false (oracle f14)', async ({ registry, broker, terminalId }) => {
    registry.emit('terminal.output.raw', { terminalId, data: MODE_PREAMBLE, at: Date.now() })

    const ws = createMockWs()
    const result = await broker.attach(
      ws as any,
      terminalId,
      'viewport_hydrate',
      80,
      24,
      0,
      'req-no-sync-1',
      undefined,
      'foreground',
      false,
      false,
    )
    expect(result).toBe('attached')
    expect(payloadSends(ws).some((msg) => msg.type === 'terminal.modes.sync')).toBe(false)
    expect(payloadSends(ws).some((msg) => msg.type === 'terminal.attach.ready')).toBe(true)
  })

  describeAttach('skips sync when surfaceReset is absent', async ({ registry, broker, terminalId }) => {
    registry.emit('terminal.output.raw', { terminalId, data: MODE_PREAMBLE, at: Date.now() })

    const ws = createMockWs()
    await broker.attach(ws as any, terminalId, 'viewport_hydrate', 80, 24, 0, 'req-no-sync-2')
    expect(payloadSends(ws).some((msg) => msg.type === 'terminal.modes.sync')).toBe(false)
  })

  describeAttach('skips sync on an empty projection even with surfaceReset (oracle f15)', async ({ registry, broker, terminalId }) => {
    registry.emit('terminal.output.raw', { terminalId, data: 'plain text only\r\n', at: Date.now() })

    const ws = createMockWs()
    await broker.attach(
      ws as any,
      terminalId,
      'viewport_hydrate',
      80,
      24,
      0,
      'req-empty-sync',
      undefined,
      'foreground',
      false,
      true,
    )
    expect(payloadSends(ws).some((msg) => msg.type === 'terminal.modes.sync')).toBe(false)
  })

  describeAttach('skips sync when the attach has no attachRequestId (server emission guard)', async ({ registry, broker, terminalId }) => {
    registry.emit('terminal.output.raw', { terminalId, data: MODE_PREAMBLE, at: Date.now() })

    const ws = createMockWs()
    await broker.attach(ws as any, terminalId, 'viewport_hydrate', 80, 24, 0, undefined, undefined, 'foreground', false, true)
    expect(payloadSends(ws).some((msg) => msg.type === 'terminal.attach.ready')).toBe(true)
    expect(payloadSends(ws).some((msg) => msg.type === 'terminal.modes.sync')).toBe(false)
  })

  describeAttach('emission keys on surfaceReset regardless of intent (keepalive_delta included)', async ({ registry, broker, terminalId }) => {
    registry.emit('terminal.output.raw', { terminalId, data: MODE_PREAMBLE, at: Date.now() })

    const ws = createMockWs()
    await broker.attach(
      ws as any,
      terminalId,
      'keepalive_delta',
      80,
      24,
      0,
      'req-keepalive-sync',
      undefined,
      'background',
      false,
      true,
    )
    const sync = payloadSends(ws).find((msg) => msg.type === 'terminal.modes.sync')
    expect(sync?.data).toBe(`${ESC}[?1003h${ESC}[?1006h${ESC}[?1049h${ESC}[?2004h`)
  })

  describeAttach('attachWithExpectedSession threads surfaceReset identically', async ({ registry, broker, terminalId }) => {
    registry.emit('terminal.output.raw', { terminalId, data: `${ESC}[?1003h`, at: Date.now() })

    const ws = createMockWs()
    await broker.attachWithExpectedSession(
      ws as any,
      terminalId,
      'viewport_hydrate',
      80,
      24,
      0,
      undefined,
      'req-expected-session-sync',
      undefined,
      'foreground',
      false,
      true,
    )
    const sync = payloadSends(ws).find((msg) => msg.type === 'terminal.modes.sync')
    expect(sync?.data).toBe(`${ESC}[?1003h`)
    expect(sync?.attachRequestId).toBe('req-expected-session-sync')
  })

  describeAttach('stream replacement resets the projection; only post-replacement bytes re-arm it', async ({ registry, broker, terminalId }) => {
    registry.emit('terminal.output.raw', { terminalId, data: MODE_PREAMBLE, at: Date.now() })
    registry.emit('terminal.stream.replaced', { terminalId, reason: 'codex_pty_recovery' })

    // The new (silent) process has emitted nothing: no retrospective truth may
    // leak from the old stream's retained frames into a fresh-surface attach.
    const wsSilent = createMockWs()
    await broker.attach(
      wsSilent as any,
      terminalId,
      'viewport_hydrate',
      80,
      24,
      0,
      'req-after-replace-silent',
      undefined,
      'foreground',
      false,
      true,
    )
    expect(payloadSends(wsSilent).some((msg) => msg.type === 'terminal.modes.sync')).toBe(false)

    registry.emit('terminal.output.raw', { terminalId, data: `${ESC}[?1002h`, at: Date.now() })

    const wsNew = createMockWs()
    await broker.attach(
      wsNew as any,
      terminalId,
      'viewport_hydrate',
      80,
      24,
      0,
      'req-after-replace-new',
      undefined,
      'foreground',
      false,
      true,
    )
    const sync = payloadSends(wsNew).find((msg) => msg.type === 'terminal.modes.sync')
    expect(sync?.data).toBe(`${ESC}[?1002h`)
  })

  describeAttach('a duplicate attachRequestId still suppresses the whole attach (no repeated sync)', async ({ registry, broker, terminalId }) => {
    registry.emit('terminal.output.raw', { terminalId, data: MODE_PREAMBLE, at: Date.now() })

    const ws = createMockWs()
    await broker.attach(ws as any, terminalId, 'viewport_hydrate', 80, 24, 0, 'req-dup', undefined, 'foreground', false, true)
    const sendsAfterFirst = payloadSends(ws).length

    const second = await broker.attach(ws as any, terminalId, 'viewport_hydrate', 80, 24, 0, 'req-dup', undefined, 'foreground', false, true)
    expect(second).toBe('duplicate')
    expect(payloadSends(ws).length).toBe(sendsAfterFirst)
  })

  describeAttach('terminal exit drops broker state (tracker dies with the terminal state)', async ({ registry, broker, terminalId }) => {
    registry.emit('terminal.output.raw', { terminalId, data: MODE_PREAMBLE, at: Date.now() })
    registry.emit('terminal.exit', { terminalId })

    // A re-created terminal of the same id starts from a default projection:
    // nothing from the dead terminal may survive the state drop.
    registry.emit('terminal.output.raw', { terminalId, data: `${ESC}[?1002h`, at: Date.now() })

    const ws = createMockWs()
    await broker.attach(ws as any, terminalId, 'viewport_hydrate', 80, 24, 0, 'req-after-exit', undefined, 'foreground', false, true)
    const sync = payloadSends(ws).find((msg) => msg.type === 'terminal.modes.sync')
    expect(sync?.data).toBe(`${ESC}[?1002h`)
  })
})
