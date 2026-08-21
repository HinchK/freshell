import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TerminalRegistry } from '../../../server/terminal-registry'
import * as fs from 'fs'
import * as pty from 'node-pty'
import { isOpencodeSubagentSession } from '../../../server/coding-cli/providers/opencode-subagent-query.js'

// This file exists SEPARATELY from terminal-registry.test.ts on purpose:
// vi.mock is file-wide. The main file's re-classification test now mocks the
// classifier constant-false (hermetic, kata ep0f); HERE we need controlled,
// deferred promise resolution to prove the out-of-order guard
// (`current.resumeSessionId === normalized` in bindSession's re-classification
// callback) drops a SLOW first classification that resolves after a SECOND
// rebind has already changed the target. Real-path classifier coverage (real
// sqlite DBs, missing/garbage DB fast paths) lives in
// test/unit/server/coding-cli/opencode-subagent-query.test.ts.
vi.mock('../../../server/coding-cli/providers/opencode-subagent-query.js', () => ({
  isOpencodeSubagentSession: vi.fn(),
}))

vi.mock('fs', () => {
  const existsSync = vi.fn()
  const statSync = vi.fn()
  const realpathSync = Object.assign(vi.fn(), { native: vi.fn() })
  return {
    existsSync,
    statSync,
    realpathSync,
    default: { existsSync, statSync, realpathSync },
  }
})

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pid: 12345,
  })),
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
  logger.child.mockReturnValue(logger)
  return { logger, sessionLifecycleLogger: logger }
})

vi.mock('../../../server/mcp/config-writer.js', () => ({
  generateMcpInjection: vi.fn(() => ({ args: [], env: {} })),
  cleanupMcpConfig: vi.fn(),
}))

const TEST_OPENCODE_SERVER = { hostname: '127.0.0.1' as const, port: 4173 }
const SLOW_SUBAGENT_ID = 'ses_slowchild00000000000000000'
const FAST_ROOT_ID = 'ses_fastroot000000000000000000'

describe('bindSession re-classification out-of-order guard', () => {
  let registry: TerminalRegistry

  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as fs.Stats)
    registry = new TerminalRegistry(undefined, 10)
  })

  afterEach(() => {
    registry.shutdown()
    vi.mocked(isOpencodeSubagentSession).mockReset()
  })

  it('a slow first classification must NOT overwrite the second target\'s answer', async () => {
    // Controlled resolution: the FIRST target's lookup is parked on a
    // deferred; the SECOND target's lookup resolves immediately (root).
    let resolveSlow!: (v: boolean) => void
    const slow = new Promise<boolean>((resolve) => {
      resolveSlow = resolve
    })
    vi.mocked(isOpencodeSubagentSession).mockImplementation((sessionId: string) =>
      sessionId === SLOW_SUBAGENT_ID ? slow : Promise.resolve(false),
    )

    const created = registry.create({
      mode: 'opencode',
      cwd: '/home/user/project',
      providerSettings: { opencodeServer: TEST_OPENCODE_SERVER },
    })

    // Two rapid rebinds: SLOW target first, FAST (root) target second.
    expect(registry.bindSession(created.terminalId, 'opencode', SLOW_SUBAGENT_ID, 'association').ok).toBe(true)
    expect(registry.bindSession(created.terminalId, 'opencode', FAST_ROOT_ID, 'association').ok).toBe(true)

    // Let the FAST classification (already resolved) flush: root -> flag cleared.
    await vi.waitFor(() => {
      expect(vi.mocked(isOpencodeSubagentSession)).toHaveBeenCalledWith(FAST_ROOT_ID)
    })
    await Promise.resolve()

    // NOW the stale first lookup finally answers "subagent". The guard must
    // drop it: resumeSessionId no longer names SLOW_SUBAGENT_ID.
    resolveSlow(true)
    await slow
    await Promise.resolve() // flush the .then() write attempt

    const term = registry.list().find((t) => t.terminalId === created.terminalId)
    expect(term?.resumeSessionId).toBe(FAST_ROOT_ID)
    expect(term?.resumeTargetIsSubagent).toBeUndefined()
  })
})
