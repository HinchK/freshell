import type { FreshAgentTurn } from '@shared/fresh-agent-contract'
import { freshAgentTurnText, getFreshAgentDisplayTurnKey } from '@shared/fresh-agent-turns'

export type CheckpointEntry = { id: string; ts: number; label: string; requestId?: string; turnId?: string }

export const CHECKPOINT_LABEL_LIMIT = 120

export function checkpointLabelForText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return (flat || 'checkpoint').slice(0, CHECKPOINT_LABEL_LIMIT)
}

function turnLabel(turn: FreshAgentTurn): string {
  return checkpointLabelForText(freshAgentTurnText(turn) || '')
}

function hasDirectCheckpoint(checkpoints: readonly CheckpointEntry[], turn: FreshAgentTurn): boolean {
  const turnId = getFreshAgentDisplayTurnKey(turn)
  if (checkpoints.some((entry) => entry.turnId === turnId)) return true
  const requestId = (turn as FreshAgentTurn & { requestId?: unknown }).requestId
  return typeof requestId === 'string'
    && requestId.length > 0
    && checkpoints.some((entry) => entry.requestId === requestId)
}

/**
 * Match a user turn to its checkpoint. Checkpoints are created at send time
 * with the outgoing text as label, so the k-th user turn bearing a given label
 * corresponds to the k-th oldest checkpoint with that label. Returns null when
 * no checkpoint matches (e.g. turns sent before this feature existed).
 */
export function pickCheckpointForTurn(
  checkpoints: readonly CheckpointEntry[],
  turns: readonly FreshAgentTurn[],
  target: FreshAgentTurn,
): CheckpointEntry | null {
  if (target.role !== 'user') return null
  const targetTurnId = getFreshAgentDisplayTurnKey(target)
  const directTurnIdMatch = checkpoints.find((entry) => entry.turnId === targetTurnId)
  if (directTurnIdMatch) return directTurnIdMatch

  const targetRequestId = (target as FreshAgentTurn & { requestId?: unknown }).requestId
  if (typeof targetRequestId === 'string' && targetRequestId) {
    const requestIdMatch = checkpoints.find((entry) => entry.requestId === targetRequestId)
    if (requestIdMatch) return requestIdMatch
  }

  const label = turnLabel(target)
  if (!label) return null

  let ordinal = 0
  for (const turn of turns) {
    if (turn.role !== 'user') continue
    if (turnLabel(turn) === label) {
      if (turn.id === target.id) break
      if (hasDirectCheckpoint(checkpoints, turn)) continue
      ordinal += 1
    }
  }

  // git log order is newest-first; we need oldest-first to index by ordinal.
  const matches = checkpoints
    .filter((entry) => entry.label === label && entry.turnId === undefined)
    .slice()
    .reverse()
  return matches[ordinal] ?? null
}
