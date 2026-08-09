/**
 * HARNESS-14 (legacy half) — routing proof that `server/terminal-registry.ts`'s
 * lifecycle/idle math (`createdAt`, `lastActivityAt`, `enforceIdleKills` ...)
 * follows the shared, env-gated test clock (`server/test-clock.ts`), so a
 * boot with `FRESHELL_TEST_CLOCK=1` can advance past the idle threshold in
 * one virtual step instead of wall-clock sleeps. Mirrors the crate-level
 * proof `enforce_idle_kills_follows_the_shared_test_clock_when_enabled` in
 * `crates/freshell-terminal/src/registry.rs`.
 *
 * Uses REAL timers deliberately: every wait here is virtual
 * (`advanceTestClockMs`), which is exactly the property under test.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { vi } from 'vitest'

const mockPtyProcess = vi.hoisted(() => {
  const createMockPty = () => {
    const emitter = new EventEmitter()
    return {
      pid: Math.floor(Math.random() * 100000) + 1000,
      cols: 120,
      rows: 30,
      process: 'mock-shell',
      onData: vi.fn((handler: (data: string) => void) => {
        emitter.on('data', handler)
        return { dispose: () => emitter.off('data', handler) }
      }),
      onExit: vi.fn((handler: (e: { exitCode: number; signal?: number }) => void) => {
        emitter.on('exit', handler)
        return { dispose: () => emitter.off('exit', handler) }
      }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      _emitExit: (exitCode: number, signal?: number) => emitter.emit('exit', { exitCode, signal }),
    }
  }
  return { createMockPty, instances: [] as ReturnType<typeof createMockPty>[] }
})

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    const pty = mockPtyProcess.createMockPty()
    mockPtyProcess.instances.push(pty)
    return pty
  }),
}))

vi.mock('../../../server/logger', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  }
  ;(logger.child as ReturnType<typeof vi.fn>).mockReturnValue(logger)
  return { logger, sessionLifecycleLogger: logger }
})

import { TerminalRegistry } from '../../../server/terminal-registry'
import { defaultSettings, type AppSettings } from '../../../server/config-store'
import {
  __setTestClockEnabledOverrideForTests,
  advanceTestClockMs,
  freezeTestClock,
  resetTestClock,
} from '../../../server/test-clock'

function clockTestSettings(): AppSettings {
  return {
    ...defaultSettings,
    safety: { autoKillIdleMinutes: 1 },
  } as AppSettings
}

describe('terminal-registry follows the shared test clock (HARNESS-14)', () => {
  afterEach(() => {
    __setTestClockEnabledOverrideForTests(true)
    resetTestClock()
    __setTestClockEnabledOverrideForTests(null)
  })

  it('frozen time never idles a terminal out; a virtual step past the threshold reaps it', async () => {
    __setTestClockEnabledOverrideForTests(true)
    resetTestClock()
    freezeTestClock()

    const registry = new TerminalRegistry(clockTestSettings())
    const term = registry.create({ mode: 'shell' })
    // Never attached: reap-eligible orphan on BOTH servers (see the e2e
    // probe spec for the over-the-wire version of this scenario).
    expect(term.status).toBe('running')

    // Frozen clock: REAL elapsed time must not count toward idleness.
    await new Promise((r) => setTimeout(r, 50))
    await registry.enforceIdleKillsForTest()
    expect(term.status).toBe('running')

    // One virtual step past the 1-minute threshold reaps it (kill() marks
    // exited ahead of the (mocked) pty exit event).
    advanceTestClockMs(61_000)
    await registry.enforceIdleKillsForTest()
    expect(term.status).toBe('exited')
  })

  it('two fixtures created at different frozen instants reap in deterministic order', async () => {
    __setTestClockEnabledOverrideForTests(true)
    resetTestClock()
    freezeTestClock()

    const registry = new TerminalRegistry(clockTestSettings()) // 1 minute
    const a = registry.create({ mode: 'shell' })
    advanceTestClockMs(30_000) // A now 30s old
    const b = registry.create({ mode: 'shell' })
    advanceTestClockMs(31_000) // A 61s, B 31s
    await registry.enforceIdleKillsForTest()
    expect(a.status, 'A (61s idle) must reap first').toBe('exited')
    expect(b.status, 'B (31s idle) must survive').toBe('running')
    advanceTestClockMs(31_000) // B 62s
    await registry.enforceIdleKillsForTest()
    expect(b.status).toBe('exited')
  })
})
