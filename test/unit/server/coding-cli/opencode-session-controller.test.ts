import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { OpencodeSessionController } from '../../../../server/coding-cli/opencode-session-controller.js'

function makeTracker() {
  const tracker = new EventEmitter() as any
  tracker.list = vi.fn(() => [])
  return tracker
}

function makeRegistry(overrides: Partial<any> = {}) {
  const registry = new EventEmitter() as any
  registry.get = vi.fn(() => ({
    terminalId: 'term-opencode-1',
    mode: 'opencode',
    status: 'running',
    resumeSessionId: undefined,
  }))
  registry.bindSession = vi.fn(() => ({ ok: true }))
  registry.rebindSession = vi.fn(() => ({ ok: true }))
  Object.assign(registry, overrides)
  return registry
}

describe('OpencodeSessionController', () => {
  it('associates exactly one active root session while it is busy', () => {
    const tracker = makeTracker()
    const registry = makeRegistry()
    const controller = new OpencodeSessionController({ tracker, registry })
    const associated: unknown[] = []
    controller.on('associated', (event) => associated.push(event))

    tracker.emit('changed', {
      upsert: [{
        terminalId: 'term-opencode-1',
        sessionId: 'root_session',
        phase: 'busy',
        updatedAt: 1,
      }],
      remove: [],
    })

    expect(registry.bindSession).toHaveBeenCalledWith(
      'term-opencode-1',
      'opencode',
      'root_session',
      'association',
    )
    expect(associated).toEqual([{ terminalId: 'term-opencode-1', sessionId: 'root_session' }])
    controller.dispose()
  })

  it('does not repeat association for the same terminal/session pair', () => {
    const tracker = makeTracker()
    const registry = makeRegistry()
    const controller = new OpencodeSessionController({ tracker, registry })
    const associated: unknown[] = []
    controller.on('associated', (event) => associated.push(event))

    for (const updatedAt of [1, 2]) {
      tracker.emit('changed', {
        upsert: [{
          terminalId: 'term-opencode-1',
          sessionId: 'root_session',
          phase: 'busy',
          updatedAt,
        }],
        remove: [],
      })
    }

    expect(registry.bindSession).toHaveBeenCalledTimes(1)
    expect(associated).toEqual([{ terminalId: 'term-opencode-1', sessionId: 'root_session' }])
    controller.dispose()
  })

  it('does not bind live-only ambiguous activity', () => {
    const tracker = makeTracker()
    const registry = makeRegistry()
    const controller = new OpencodeSessionController({ tracker, registry })

    tracker.emit('changed', {
      upsert: [{
        terminalId: 'term-opencode-1',
        phase: 'busy',
        updatedAt: 1,
      }],
      remove: [],
    })

    expect(registry.bindSession).not.toHaveBeenCalled()
    controller.dispose()
  })

  it.each([
    {
      name: 'missing terminal',
      terminal: undefined,
      reason: 'terminal_missing_or_not_running',
      extra: {},
    },
    {
      name: 'non-OpenCode terminal',
      terminal: {
        terminalId: 'term-opencode-1',
        mode: 'codex',
        status: 'running',
        resumeSessionId: undefined,
      },
      reason: 'terminal_not_opencode',
      extra: { mode: 'codex' },
    },
    {
      name: 'stopped terminal',
      terminal: {
        terminalId: 'term-opencode-1',
        mode: 'opencode',
        status: 'exited',
        resumeSessionId: undefined,
      },
      reason: 'terminal_missing_or_not_running',
      extra: { status: 'exited' },
    },
  ])('logs rejected association requests for $name', ({ terminal, reason, extra }) => {
    const tracker = makeTracker()
    const registry = makeRegistry({
      get: vi.fn(() => terminal),
    })
    const log = { warn: vi.fn() }
    const controller = new OpencodeSessionController({ tracker, registry, log })

    tracker.emit('changed', {
      upsert: [{
        terminalId: 'term-opencode-1',
        sessionId: 'root_session',
        phase: 'busy',
        updatedAt: 1,
      }],
      remove: [],
    })

    expect(log.warn).toHaveBeenCalledWith({
      terminalId: 'term-opencode-1',
      sessionId: 'root_session',
      reason,
      ...extra,
    }, 'Rejected OpenCode association request')
    expect(registry.bindSession).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('logs rejected association with previous session context', () => {
    const tracker = makeTracker()
    const registry = makeRegistry({
      get: vi.fn(() => ({
        terminalId: 'term-opencode-1',
        mode: 'opencode',
        status: 'running',
        resumeSessionId: 'previous_session',
      })),
      rebindSession: vi.fn(() => ({ ok: false, reason: 'ambiguous-session-owner' })),
    })
    const log = { warn: vi.fn() }
    const controller = new OpencodeSessionController({ tracker, registry, log })

    tracker.emit('changed', {
      upsert: [{
        terminalId: 'term-opencode-1',
        sessionId: 'next_session',
        phase: 'busy',
        updatedAt: 1,
      }],
      remove: [],
    })

    expect(log.warn).toHaveBeenCalledWith({
      terminalId: 'term-opencode-1',
      sessionId: 'next_session',
      previousSessionId: 'previous_session',
      reason: 'ambiguous-session-owner',
    }, 'Rejected OpenCode association request')
    controller.dispose()
  })

  it('logs owner terminal id when a bind conflict exposes one', () => {
    const tracker = makeTracker()
    const registry = makeRegistry({
      bindSession: vi.fn(() => ({ ok: false, reason: 'session_already_owned', owner: 'term-owner' })),
    })
    const log = { warn: vi.fn() }
    const controller = new OpencodeSessionController({ tracker, registry, log })

    tracker.emit('changed', {
      upsert: [{
        terminalId: 'term-opencode-1',
        sessionId: 'root_session',
        phase: 'busy',
        updatedAt: 1,
      }],
      remove: [],
    })

    expect(log.warn).toHaveBeenCalledWith({
      terminalId: 'term-opencode-1',
      sessionId: 'root_session',
      reason: 'session_already_owned',
      ownerTerminalId: 'term-owner',
    }, 'Rejected OpenCode association request')
    controller.dispose()
  })
})
