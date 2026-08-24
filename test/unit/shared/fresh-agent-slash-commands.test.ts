import { describe, expect, it } from 'vitest'

import {
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
