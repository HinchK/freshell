import type { FreshAgentRuntimeProvider, FreshAgentSessionType } from './fresh-agent.js'

export type FreshAgentThinkingOption = {
  value: string
  label: string
}

export type FreshAgentModelOption = {
  value: string
  label: string
  thinkingEfforts?: readonly string[]
  defaultEffort?: string
}

export const FRESHCODEX_DEFAULT_MODEL = 'gpt-5.5'
export const FRESHCODEX_DEFAULT_EFFORT = 'xhigh'

export const FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE = {
  freshclaude: [
    {
      value: 'claude-opus-4-6',
      label: 'Claude Opus 4.6',
      thinkingEfforts: ['low', 'medium', 'high', 'max'],
      defaultEffort: 'max',
    },
  ],
  freshcodex: [
    {
      value: FRESHCODEX_DEFAULT_MODEL,
      label: 'GPT-5.5',
      thinkingEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
      defaultEffort: FRESHCODEX_DEFAULT_EFFORT,
    },
    {
      value: 'gpt-5.4-flash',
      label: 'GPT-5.4 Flash',
      thinkingEfforts: ['none', 'minimal', 'low', 'medium', 'high'],
      defaultEffort: 'high',
    },
    {
      value: 'gpt-5.3-codex-spark',
      label: 'GPT-5.3 Codex Spark',
      thinkingEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
      defaultEffort: FRESHCODEX_DEFAULT_EFFORT,
    },
  ],
  kilroy: [
    {
      value: 'claude-opus-4-6',
      label: 'Claude Opus 4.6',
      thinkingEfforts: ['low', 'medium', 'high', 'max'],
      defaultEffort: 'max',
    },
  ],
  freshopencode: [
    {
      value: 'opencode',
      label: 'Opencode',
      thinkingEfforts: ['low', 'medium', 'high', 'max'],
      defaultEffort: 'max',
    },
  ],
} as const satisfies Record<FreshAgentSessionType, readonly FreshAgentModelOption[]>

export const FRESHCODEX_MODEL_OPTIONS = FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE.freshcodex

function defaultModelForSession(sessionType: FreshAgentSessionType): FreshAgentModelOption | undefined {
  return FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE[sessionType]?.[0]
}

export function resolveFreshAgentModelOption(
  sessionType: FreshAgentSessionType,
  model: string | undefined,
): FreshAgentModelOption | undefined {
  const options = FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE[sessionType] ?? []
  return options.find((option) => option.value === model) ?? defaultModelForSession(sessionType)
}

export function normalizeFreshcodexModel(model: string | undefined): string {
  const option = FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE.freshcodex.find((candidate) => candidate.value === model)
  return option?.value ?? FRESHCODEX_DEFAULT_MODEL
}

export function normalizeFreshAgentModel(
  sessionType: FreshAgentSessionType,
  provider: FreshAgentRuntimeProvider,
  model: string | undefined,
): string | undefined {
  if (provider === 'codex') {
    return normalizeFreshcodexModel(model)
  }
  return model ?? defaultModelForSession(sessionType)?.value
}

export function getFreshAgentThinkingOptions(
  sessionType: FreshAgentSessionType,
  provider: FreshAgentRuntimeProvider,
  model: string | undefined,
): readonly FreshAgentThinkingOption[] {
  const normalizedModel = normalizeFreshAgentModel(sessionType, provider, model)
  const modelOption = resolveFreshAgentModelOption(sessionType, normalizedModel)
  return (modelOption?.thinkingEfforts ?? []).map((value) => ({ value, label: value }))
}

export function normalizeFreshAgentEffort(
  sessionType: FreshAgentSessionType,
  provider: FreshAgentRuntimeProvider,
  model: string | undefined,
  effort: string | undefined,
): string | undefined {
  const options = getFreshAgentThinkingOptions(sessionType, provider, model)
  if (effort && options.some((option) => option.value === effort)) {
    return effort
  }
  const normalizedModel = normalizeFreshAgentModel(sessionType, provider, model)
  const modelOption = resolveFreshAgentModelOption(sessionType, normalizedModel)
  if (modelOption?.defaultEffort && options.some((option) => option.value === modelOption.defaultEffort)) {
    return modelOption.defaultEffort
  }
  return options[options.length - 1]?.value
}
