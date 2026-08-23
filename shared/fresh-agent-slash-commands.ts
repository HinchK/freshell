import type { FreshAgentSessionType } from './fresh-agent.js'

export type FreshAgentSlashCommandAction = 'new' | 'compact' | 'fork' | 'model' | 'undo' | 'redo'

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
  {
    name: 'undo',
    description: 'Roll back the last turn (conversation only — files stay as they are)',
    action: 'undo',
  },
  {
    name: 'redo',
    description: 'Restore the last rolled-back turn',
    action: 'redo',
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
  // /redo is CAPABILITY-FILTERED out of the freshcodex catalog (kata 1wxv
  // decision 5 — codex is undo-only; no "show then reject"). The server-side
  // codex×redo refusal stays as the permanent wire backstop.
  freshcodex: [...BASE_COMMANDS.filter((command) => command.name !== 'redo'), MODEL_COMMAND],
  freshopencode: [...BASE_COMMANDS, MODEL_COMMAND],
} as const satisfies Record<FreshAgentSessionType, readonly FreshAgentSlashCommand[]>

/**
 * kata 1wxv (r3 correction 8): the reserved names the COMPOSER intercepts
 * before catalog resolution — a typed `/undo` or `/redo` is NEVER sent to the
 * model as text, even where the catalog filtered it out (freshcodex `/redo`
 * gets the pinned unsupported notice instead). Exported so composer + view +
 * tests share one source.
 */
export const RESERVED_ROLLBACK_SLASH_NAMES = ['undo', 'redo'] as const

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
