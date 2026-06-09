import { randomUUID } from 'node:crypto'

export type TerminalStreamReplacementReason =
  | 'new_pty_session'
  | 'codex_pty_recovery'
  | 'retention_lost'
  | 'server_restart_incompatible_retention'

export type TerminalStreamIdentityTracker = {
  ensureStream: (terminalId: string) => string
  getStream: (terminalId: string) => string | undefined
  recordAttach: (terminalId: string, attachRequestId?: string) => string
  recordDetach: (terminalId: string, attachRequestId?: string) => string | undefined
  replaceStream: (terminalId: string, reason: TerminalStreamReplacementReason) => string
  forgetStream: (terminalId: string) => void
}

type StreamState = {
  streamId: string
  generation: number
  attachedRequestIds: Set<string>
  lastReplacementReason?: TerminalStreamReplacementReason
}

export function createTerminalStreamIdentityTracker(): TerminalStreamIdentityTracker {
  const streams = new Map<string, StreamState>()

  const mintStreamId = (terminalId: string, generation: number) => (
    `${terminalId}:stream:${generation}:${randomUUID()}`
  )

  const ensureState = (terminalId: string): StreamState => {
    let state = streams.get(terminalId)
    if (!state) {
      state = {
        streamId: mintStreamId(terminalId, 1),
        generation: 1,
        attachedRequestIds: new Set(),
        lastReplacementReason: 'new_pty_session',
      }
      streams.set(terminalId, state)
    }
    return state
  }

  return {
    ensureStream(terminalId) {
      return ensureState(terminalId).streamId
    },
    getStream(terminalId) {
      return streams.get(terminalId)?.streamId
    },
    recordAttach(terminalId, attachRequestId) {
      const state = ensureState(terminalId)
      if (attachRequestId) {
        state.attachedRequestIds.add(attachRequestId)
      }
      return state.streamId
    },
    recordDetach(terminalId, attachRequestId) {
      const state = streams.get(terminalId)
      if (!state) return undefined
      if (attachRequestId) {
        state.attachedRequestIds.delete(attachRequestId)
      }
      return state.streamId
    },
    replaceStream(terminalId, reason) {
      const state = ensureState(terminalId)
      state.generation += 1
      state.streamId = mintStreamId(terminalId, state.generation)
      state.attachedRequestIds.clear()
      state.lastReplacementReason = reason
      return state.streamId
    },
    forgetStream(terminalId) {
      streams.delete(terminalId)
    },
  }
}
