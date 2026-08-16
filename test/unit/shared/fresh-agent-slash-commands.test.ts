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
