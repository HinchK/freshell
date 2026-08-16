import type { FreshAgentSessionType } from './fresh-agent.js'

export type FreshAgentSlashCommandAction = 'new' | 'compact' | 'fork' | 'model'

export type FreshAgentSlashCommand = {
  name: string
  description: string
  action: FreshAgentSlashCommandAction
  aliases?: readonly string[]
  /** Requires the matching capability flag in the thread snapshot to be true. */
  requiresCapability?: 'fork'
}

const BASE_COMMANDS = [
  {
    name: 'new',
    description: 'Start a new conversation in this pane',
    action: 'new',
    aliases: ['reset', 'restart'],
  },
  {
    name: 'compact',
    description: 'Ask the agent to compact its current conversation context',
    action: 'compact',
    aliases: ['compress', 'summarize-context'],
  },
  {
    name: 'fork',
    description: 'Fork this conversation into a new session from this point',
    action: 'fork',
    aliases: ['branch'],
    requiresCapability: 'fork',
  },
] as const satisfies readonly FreshAgentSlashCommand[]

/**
 * Opens the model + thinking selector dialog. Only providers with a real
 * per-model catalog get it: freshopencode (probed) and freshcodex (static
 * table). freshclaude/kilroy keep the simple settings-popover model list.
 */
const MODEL_COMMAND = {
  name: 'model',
  description: 'Choose model and thinking level',
  action: 'model',
} as const satisfies FreshAgentSlashCommand

export const FRESH_AGENT_SLASH_COMMANDS_BY_SESSION_TYPE = {
  freshclaude: BASE_COMMANDS,
  kilroy: BASE_COMMANDS,
  freshcodex: [...BASE_COMMANDS, MODEL_COMMAND],
  freshopencode: [...BASE_COMMANDS, MODEL_COMMAND],
} as const satisfies Record<FreshAgentSessionType, readonly FreshAgentSlashCommand[]>

export function getFreshAgentSlashCommands(sessionType: FreshAgentSessionType): readonly FreshAgentSlashCommand[] {
  return FRESH_AGENT_SLASH_COMMANDS_BY_SESSION_TYPE[sessionType]
}

export function resolveFreshAgentSlashCommand(
  sessionType: FreshAgentSessionType,
  rawName: string,
): FreshAgentSlashCommand | undefined {
  const normalized = rawName.replace(/^\//, '').trim().toLowerCase()
  if (!normalized) return undefined
  return getFreshAgentSlashCommands(sessionType).find((command) => (
    command.name === normalized || command.aliases?.includes(normalized)
  ))
}
