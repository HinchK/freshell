import type { CodingCliProviderName } from '../../shared/ws-protocol.js'

export type SessionBindingReason = 'start' | 'resume' | 'association'
export type SessionUnbindReason = 'exit' | 'rebind' | 'stale_owner' | 'repair_duplicate'

export type TerminalInputRawEvent = {
  terminalId: string
  data: string
  at: number
}

export type TerminalOutputRawEvent = {
  terminalId: string
  data: string
  at: number
}

export type TerminalSessionBoundEvent = {
  terminalId: string
  provider: CodingCliProviderName
  sessionId: string
  reason: SessionBindingReason
  /**
   * Present ONLY on a server-authoritative mid-session rebind (e.g. codex fork
   * handoff). Names the session id this binding supersedes so the
   * terminal.session.associated fanout can carry it as previousSessionId.
   */
  previousSessionId?: string
}

export type TerminalSessionUnboundEvent = {
  terminalId: string
  provider: CodingCliProviderName
  sessionId: string
  reason: SessionUnbindReason
}

export type CodexTurnStartedEvent = {
  terminalId: string
  at: number
}

export type CodexTurnCompletedEvent = {
  terminalId: string
  at: number
}
