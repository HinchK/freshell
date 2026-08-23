import { describe, expect, it } from 'vitest'

import {
  getFreshAgentSlashCommands,
  resolveFreshAgentSlashCommand,
} from '@shared/fresh-agent-slash-commands'

describe('fresh-agent slash commands: /model', () => {
  it('registers /model for freshopencode and freshcodex only', () => {
    expect(getFreshAgentSlashCommands('freshopencode').map((command) => command.name)).toContain('model')
    expect(getFreshAgentSlashCommands('freshcodex').map((command) => command.name)).toContain('model')
    // freshclaude/kilroy keep the simple settings-popover model list
    expect(getFreshAgentSlashCommands('freshclaude').map((command) => command.name)).not.toContain('model')
    expect(getFreshAgentSlashCommands('kilroy').map((command) => command.name)).not.toContain('model')
  })

  it('resolves /model to the model action', () => {
    expect(resolveFreshAgentSlashCommand('freshopencode', '/model')).toMatchObject({
      name: 'model',
      action: 'model',
    })
    expect(resolveFreshAgentSlashCommand('freshcodex', 'model')).toMatchObject({
      name: 'model',
      action: 'model',
    })
    expect(resolveFreshAgentSlashCommand('freshclaude', '/model')).toBeUndefined()
  })
})

describe('fresh-agent slash commands: /undo + /redo (kata 1wxv decision 8)', () => {
  it('registers /undo for every session type, with no aliases', () => {
    for (const sessionType of ['freshclaude', 'kilroy', 'freshcodex', 'freshopencode'] as const) {
      const undo = getFreshAgentSlashCommands(sessionType).find((c) => c.name === 'undo')
      expect(undo?.action).toBe('undo')
      expect(undo?.aliases).toBeUndefined()
    }
  })
  it('registers /redo for claude/opencode session types only — freshcodex is undo-only (decision 5: no redo affordance appears, never "show then reject")', () => {
    for (const sessionType of ['freshclaude', 'kilroy', 'freshopencode'] as const) {
      const redo = getFreshAgentSlashCommands(sessionType).find((c) => c.name === 'redo')
      expect(redo?.action).toBe('redo')
      expect(redo?.aliases).toBeUndefined()
    }
    expect(getFreshAgentSlashCommands('freshcodex').find((c) => c.name === 'redo')).toBeUndefined()
    expect(resolveFreshAgentSlashCommand('freshcodex', '/redo')?.action).not.toBe('redo')
  })
  it('resolves both commands where registered', () => {
    expect(resolveFreshAgentSlashCommand('freshclaude', '/undo')?.action).toBe('undo')
    expect(resolveFreshAgentSlashCommand('freshopencode', 'redo')?.action).toBe('redo')
  })
  // Reserved names (r2; seam corrected r3 correction 8): the CATALOG filtering above only
  // governs the menu. /undo and /redo are additionally reserved at the COMPOSER's submit
  // path (pre-catalog-resolution — a seam runSlashCommand could never provide, since the
  // filtered catalog omits capability-false commands and unresolved names fall through to
  // model text), so a TYPED '/redo' on freshcodex is intercepted with the pinned notice
  // instead of falling through to the model — the composer/view-level tests live in Task 6.
})
