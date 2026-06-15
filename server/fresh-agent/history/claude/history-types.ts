import type { ChatMessage } from '../../../session-history-loader.js'
import type { ClaudeFreshAgentHistoryCanonicalTurn } from './history-ledger.js'
import type {
  FreshAgentThreadTurnBodyQuery as SharedFreshAgentThreadTurnBodyQuery,
  FreshAgentThreadTurnsQuery as SharedFreshAgentThreadTurnsQuery,
} from '../../../../shared/read-models.js'

export type ClaudeFreshAgentHistoryPageQuery = SharedFreshAgentThreadTurnsQuery
export type ClaudeFreshAgentHistoryTurnBodyQuery = SharedFreshAgentThreadTurnBodyQuery

export type ClaudeFreshAgentHistoryItem = {
  turnId: string
  messageId: string
  ordinal: number
  source: ClaudeFreshAgentHistoryCanonicalTurn['source']
  sessionId: string
  role: ChatMessage['role']
  summary: string
  timestamp?: string
}

export type ClaudeFreshAgentHistoryPage = {
  sessionId: string
  latestTurnId: string | null
  items: ClaudeFreshAgentHistoryItem[]
  nextCursor: string | null
  revision: number
  /** When includeBodies is requested, maps turnId to full turn body. */
  bodies?: Record<string, ClaudeFreshAgentHistoryTurn>
}

export type ClaudeFreshAgentHistoryTurn = {
  sessionId: string
  turnId: string
  messageId: string
  ordinal: number
  source: ClaudeFreshAgentHistoryCanonicalTurn['source']
  message: ChatMessage
}
