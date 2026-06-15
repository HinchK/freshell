import type { ComponentType } from 'react'
import { PROVIDER_ICONS, DefaultProviderIcon } from '@/components/icons/provider-icons'
import { isNonShellMode, getProviderLabel } from '@/lib/coding-cli-utils'
import { getFreshAgentProviderConfig } from '@/lib/fresh-agent-provider-utils'
import { resolveFreshAgentType } from '@/lib/fresh-agent-registry'
import type { FreshAgentProviderName, FreshAgentProviderSettings } from '@/lib/fresh-agent-provider-types'
import type { CodingCliProviderName } from '@/store/types'
import type { FreshAgentPaneInput, TerminalPaneInput } from '@/store/paneTypes'
import type { ClientExtensionEntry } from '@shared/extension-types'
import {
  getPairedPublicSessionType,
  resolveSessionTypeRuntimeProvider,
  type PublicSessionType,
} from '@shared/session-flavor'

export interface SessionTypeConfig {
  icon: ComponentType<{ className?: string }>
  label: string
}

export function resolveSessionTypeConfig(sessionType: string, extensions?: ClientExtensionEntry[]): SessionTypeConfig {
  const freshAgentType = resolveFreshAgentType(sessionType)
  if (freshAgentType) {
    return {
      icon: freshAgentType.icon,
      label: freshAgentType.label,
    }
  }

  // 1. Check fresh-agent providers first (they have explicit configs)
  const freshAgentProviderConfig = getFreshAgentProviderConfig(sessionType)
  if (freshAgentProviderConfig) {
    return {
      icon: freshAgentProviderConfig.icon,
      label: freshAgentProviderConfig.label,
    }
  }

  // 2. Any non-shell mode is a coding CLI provider
  if (isNonShellMode(sessionType)) {
    return {
      icon: PROVIDER_ICONS[sessionType as keyof typeof PROVIDER_ICONS] ?? DefaultProviderIcon,
      label: getProviderLabel(sessionType, extensions),
    }
  }

  // 3. Fallback for unknown types
  return {
    icon: DefaultProviderIcon,
    label: sessionType,
  }
}

export type PairedSessionTypeTarget = {
  sourceSessionType: PublicSessionType
  targetSessionType: PublicSessionType
  runtimeProvider: CodingCliProviderName
  label: string
  targetKind: 'terminal' | 'fresh-agent'
}

function cliProviderLabel(provider: CodingCliProviderName): string {
  if (provider === 'opencode') return 'OpenCode CLI'
  return `${getProviderLabel(provider)} CLI`
}

export function getPairedSessionTypeTarget(
  sessionType: string | undefined,
): PairedSessionTypeTarget | null {
  const targetSessionType = getPairedPublicSessionType(sessionType)
  if (!targetSessionType || !sessionType) return null
  const runtimeProvider = resolveSessionTypeRuntimeProvider(targetSessionType)
  if (!runtimeProvider) return null
  const targetKind = targetSessionType.startsWith('fresh') ? 'fresh-agent' : 'terminal'
  return {
    sourceSessionType: sessionType as PublicSessionType,
    targetSessionType,
    runtimeProvider,
    targetKind,
    label: targetKind === 'fresh-agent'
      ? `Reopen as ${targetSessionType}`
      : `Reopen as ${cliProviderLabel(runtimeProvider)}`,
  }
}

/**
 * Build the correct PaneContentInput for resuming a session based on its sessionType.
 * Fresh-agent sessions → kind: 'fresh-agent'
 * Terminal sessions (claude, codex) → kind: 'terminal'
 */
export function buildResumeContent(opts: {
  sessionType: string
  sessionId: string
  cwd?: string
  freshAgentProviderSettings?: FreshAgentProviderSettings
  liveTerminal?: {
    terminalId: string
    serverInstanceId: string
  }
}): TerminalPaneInput | FreshAgentPaneInput {
  const freshAgentType = resolveFreshAgentType(opts.sessionType)
  if (freshAgentType) {
    const freshAgentProviderConfig = getFreshAgentProviderConfig(opts.sessionType)
    const ps = opts.freshAgentProviderSettings
    const permissionMode = freshAgentType.settingsVisibility.permissionMode === false
      ? undefined
      : ps?.defaultPermissionMode ?? freshAgentProviderConfig?.defaultPermissionMode ?? freshAgentType.defaultPermissionMode
    return {
      kind: 'fresh-agent',
      sessionType: freshAgentType.sessionType,
      provider: freshAgentType.runtimeProvider,
      ...(freshAgentType.runtimeProvider === 'claude' ? { resumeSessionId: opts.sessionId } : {}),
      sessionRef: {
        provider: freshAgentType.runtimeProvider,
        sessionId: opts.sessionId,
      },
      initialCwd: opts.cwd,
      modelSelection: ps?.modelSelection,
      model: freshAgentType.defaultModel,
      ...(permissionMode ? { permissionMode } : {}),
      effort: ps?.effort,
    }
  }

  const freshAgentProviderConfig = getFreshAgentProviderConfig(opts.sessionType)
  if (freshAgentProviderConfig) {
    const ps = opts.freshAgentProviderSettings
    return {
      kind: 'fresh-agent',
      sessionType: freshAgentProviderConfig.name as FreshAgentProviderName,
      provider: 'claude',
      resumeSessionId: opts.sessionId,
      sessionRef: {
        provider: 'claude',
        sessionId: opts.sessionId,
      },
      initialCwd: opts.cwd,
      modelSelection: ps?.modelSelection,
      permissionMode: ps?.defaultPermissionMode ?? freshAgentProviderConfig.defaultPermissionMode,
      effort: ps?.effort,
    }
  }
  // Terminal pane (claude CLI, codex CLI, or fallback to 'claude')
  const provider: CodingCliProviderName = isNonShellMode(opts.sessionType)
    ? opts.sessionType as CodingCliProviderName
    : 'claude'
  return {
    kind: 'terminal',
    mode: provider,
    ...(opts.liveTerminal
      ? {
          terminalId: opts.liveTerminal.terminalId,
          serverInstanceId: opts.liveTerminal.serverInstanceId,
          status: 'running' as const,
        }
      : {}),
    sessionRef: {
      provider,
      sessionId: opts.sessionId,
    },
    initialCwd: opts.cwd,
  }
}
