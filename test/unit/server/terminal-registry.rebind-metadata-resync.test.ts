import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TerminalRegistry } from '../../../server/terminal-registry'
import { TerminalMetadataService } from '../../../server/terminal-metadata-service'
import type { CodingCliProviderName } from '../../../server/coding-cli/types'
import * as fs from 'fs'
import { isOpencodeSubagentSession } from '../../../server/coding-cli/providers/opencode-subagent-query.js'

// Node mirror of the Rust integration test
// `tui_switch_signal_reclassifies_is_subagent_in_both_directions`
// (crates/freshell-ws, opencode_signal rebind hook): the LIVE opencode rebind
// lane (TUI session switch -> opencode-session-controller promoteAssociation
// -> registry.bindSession -> 'associated' -> associateSession) must re-sync
// TerminalMetadataService's copy of resumeTargetIsSubagent in BOTH
// directions. Like terminal-registry.bind-reclassify-guard.test.ts (see its
// header for why this is a separate file), isOpencodeSubagentSession is
// mocked for controlled promise resolution.
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
const CHILD_ID = 'ses_childtarget000000000000000'
const ROOT_ID = 'ses_roottarget0000000000000000'
const SLOW_CHILD_ID = 'ses_slowchild00000000000000000'

describe('opencode rebind lane re-syncs TerminalMeta.resumeTargetIsSubagent', () => {
  let registry: TerminalRegistry
  let metadata: TerminalMetadataService

  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as fs.Stats)
    registry = new TerminalRegistry(undefined, 10)
    metadata = new TerminalMetadataService({
      git: {
        resolveCheckoutRoot: async () => '/workspace/repo',
        resolveRepoRoot: async () => '/workspace',
        resolveBranchAndDirty: async () => ({ branch: 'main', isDirty: false }),
      },
    })
    // Mirror server/index.ts wiring: bindSession's async re-classification
    // answers land on the metadata service under its sessionId-match
    // staleness guard.
    registry.on('terminal.subagent.classified', (payload) => {
      const event = payload as {
        terminalId?: string
        provider?: CodingCliProviderName
        sessionId?: string
        isSubagent?: boolean
      }
      if (!event.terminalId || !event.provider || !event.sessionId) return
      metadata.setResumeTargetIsSubagent(
        event.terminalId,
        event.provider,
        event.sessionId,
        event.isSubagent === true,
      )
    })
  })

  afterEach(() => {
    registry.shutdown()
    vi.mocked(isOpencodeSubagentSession).mockReset()
  })

  // The live lane, condensed: promoteAssociation -> bindSession (kicks the
  // async re-classification) -> emit('associated') -> the broadcast lane
  // calls associateSession SYNCHRONOUSLY in the same tick (server/index.ts
  // 'associated' handler -> broadcastTerminalSessionAssociation).
  const rebind = (terminalId: string, sessionId: string) => {
    expect(registry.bindSession(terminalId, 'opencode', sessionId, 'association').ok).toBe(true)
    metadata.associateSession(terminalId, 'opencode', sessionId)
  }

  it('re-classifies in both directions across TUI session switches', async () => {
    vi.mocked(isOpencodeSubagentSession).mockImplementation((sessionId: string) =>
      Promise.resolve(sessionId === CHILD_ID),
    )
    const created = registry.create({
      mode: 'opencode',
      cwd: '/home/user/project',
      providerSettings: { opencodeServer: TEST_OPENCODE_SERVER },
    })
    await metadata.seedFromTerminal(created)

    // root->child switch: the metadata copy must become true so the
    // fabricated live session-directory item is hidden by default.
    rebind(created.terminalId, CHILD_ID)
    await vi.waitFor(() => {
      expect(metadata.get(created.terminalId)?.resumeTargetIsSubagent).toBe(true)
    })
    expect(metadata.get(created.terminalId)?.sessionId).toBe(CHILD_ID)

    // child->root switch: associateSession alone carries the stale true
    // forward (spread + `??` merge never unsets)...
    rebind(created.terminalId, ROOT_ID)
    expect(metadata.get(created.terminalId)?.resumeTargetIsSubagent).toBe(true)
    // ...the classification answer is what must CLEAR it.
    await vi.waitFor(() => {
      expect(metadata.get(created.terminalId)?.resumeTargetIsSubagent).toBeUndefined()
    })
    expect(metadata.get(created.terminalId)?.sessionId).toBe(ROOT_ID)
  })

  it('a slow classification for a superseded target cannot clobber the newer answer', async () => {
    let resolveSlow!: (v: boolean) => void
    const slow = new Promise<boolean>((resolve) => {
      resolveSlow = resolve
    })
    vi.mocked(isOpencodeSubagentSession).mockImplementation((sessionId: string) =>
      sessionId === SLOW_CHILD_ID ? slow : Promise.resolve(false),
    )
    const created = registry.create({
      mode: 'opencode',
      cwd: '/home/user/project',
      providerSettings: { opencodeServer: TEST_OPENCODE_SERVER },
    })
    await metadata.seedFromTerminal(created)

    // Two rapid switches: SLOW child target first, fast root target second.
    rebind(created.terminalId, SLOW_CHILD_ID)
    rebind(created.terminalId, ROOT_ID)

    // Let the fast (root, already resolved) classification flush.
    await vi.waitFor(() => {
      expect(vi.mocked(isOpencodeSubagentSession)).toHaveBeenCalledWith(ROOT_ID)
    })
    await Promise.resolve()

    // NOW the stale child lookup finally answers "subagent". The guard chain
    // (registry resumeSessionId check + metadata sessionId check) must drop
    // it -- the terminal targets ROOT_ID.
    resolveSlow(true)
    await slow
    await Promise.resolve()
    await Promise.resolve()

    expect(metadata.get(created.terminalId)?.sessionId).toBe(ROOT_ID)
    expect(metadata.get(created.terminalId)?.resumeTargetIsSubagent).toBeUndefined()
  })
})
