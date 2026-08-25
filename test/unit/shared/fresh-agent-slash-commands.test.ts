import { describe, expect, it } from 'vitest'

import type { FreshAgentSessionCommand } from '@shared/fresh-agent-contract'
import {
  buildFreshAgentSlashCommandMenu,
  getFreshAgentSlashCommands,
  resolveFreshAgentSlashCommand,
} from '@shared/fresh-agent-slash-commands'

describe('fresh-agent slash commands: /model', () => {
  it('registers /model for all four fresh-agent session types', () => {
    expect(getFreshAgentSlashCommands('freshopencode').map((command) => command.name)).toContain('model')
    expect(getFreshAgentSlashCommands('freshcodex').map((command) => command.name)).toContain('model')
    expect(getFreshAgentSlashCommands('freshclaude').map((command) => command.name)).toContain('model')
    expect(getFreshAgentSlashCommands('kilroy').map((command) => command.name)).toContain('model')
  })

  it('resolves /model to the model action for every session type', () => {
    expect(resolveFreshAgentSlashCommand('freshopencode', '/model')).toMatchObject({
      name: 'model',
      action: 'model',
    })
    expect(resolveFreshAgentSlashCommand('freshcodex', 'model')).toMatchObject({
      name: 'model',
      action: 'model',
    })
    expect(resolveFreshAgentSlashCommand('freshclaude', '/model')).toMatchObject({
      name: 'model',
      action: 'model',
    })
    expect(resolveFreshAgentSlashCommand('kilroy', '/model')).toMatchObject({
      name: 'model',
      action: 'model',
    })
  })
})

describe('buildFreshAgentSlashCommandMenu', () => {
  const statics = getFreshAgentSlashCommands('freshclaude')

  it('returns the statics verbatim and an empty session group for an empty or absent catalog', () => {
    for (const catalog of [undefined, []]) {
      const menu = buildFreshAgentSlashCommandMenu(statics, catalog)
      expect(menu.action).toBe(statics)
      expect(menu.session).toEqual([])
    }
  })

  it('groups provider rows under kind session with fields preserved verbatim', () => {
    const catalog: FreshAgentSessionCommand[] = [
      { name: 'review', description: 'Review the diff', argumentHint: '[path]', aliases: ['rev'] },
      { name: 'commit', description: '' },
    ]
    const menu = buildFreshAgentSlashCommandMenu(statics, catalog)
    expect(menu.action).toBe(statics)
    expect(menu.session).toEqual([
      { kind: 'session', name: 'review', description: 'Review the diff', argumentHint: '[path]', aliases: ['rev'] },
      { kind: 'session', name: 'commit', description: '' },
    ])
    expect(menu.session[1]).not.toHaveProperty('argumentHint')
    expect(menu.session[1]).not.toHaveProperty('aliases')
  })

  it('dedupes session rows within the kind by case-insensitive canonical name (first wins)', () => {
    const catalog: FreshAgentSessionCommand[] = [
      { name: 'review', description: 'SDK review' },
      { name: 'Review', description: 'duplicate casing dropped' },
      { name: 'REVIEW', description: 'third casing dropped' },
    ]
    const menu = buildFreshAgentSlashCommandMenu(statics, catalog)
    expect(menu.session).toEqual([
      { kind: 'session', name: 'review', description: 'SDK review' },
    ])
  })

  it('lets cross-kind collisions survive: a session row named like a static action stays in the session group', () => {
    const menu = buildFreshAgentSlashCommandMenu(statics, [
      { name: 'compact', description: 'SDK-side compact' },
    ])
    expect(menu.action.some((command) => command.name === 'compact')).toBe(true)
    expect(menu.session).toEqual([
      { kind: 'session', name: 'compact', description: 'SDK-side compact' },
    ])
  })

  it('keeps a session row whose name collides with a static alias', () => {
    // static 'compact' carries alias 'compress'; the provider's 'compress' must survive.
    expect(statics.some((command) => command.aliases?.includes('compress'))).toBe(true)
    const menu = buildFreshAgentSlashCommandMenu(statics, [
      { name: 'compress', description: 'SDK-side compress' },
    ])
    expect(menu.session).toEqual([
      { kind: 'session', name: 'compress', description: 'SDK-side compress' },
    ])
  })
})
