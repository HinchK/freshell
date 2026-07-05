import { EventEmitter } from 'events'
import { isSubmitInput } from '../../shared/turn-complete-signal.js'
import type { TerminalTurnCompletionSnapshot } from '../../shared/ws-protocol.js'

// Failsafe: a busy terminal silent this long self-heals to idle (and completes the
// turn). Mirrors the Claude lane's deadman, but Amplifier's deadman ALSO emits a
// turn.complete because Amplifier has no other end-of-turn signal.
export const AMPLIFIER_BUSY_DEADMAN_MS = 120_000
export const AMPLIFIER_ACTIVITY_SWEEP_MS = 5_000
// Output-idle window that marks a turn complete. Amplifier has no turn-complete BEL,
// so once the first post-submit output has arrived, this much output-silence is
// treated as the end of the turn.
export const AMPLIFIER_IDLE_DEBOUNCE_MS = 2_000

export type AmplifierActivityPhase = 'idle' | 'busy'

export type AmplifierActivityRecord = {
  terminalId: string
  sessionId?: string
  phase: AmplifierActivityPhase
  updatedAt: number
}

export type AmplifierTurnCompleteEvent = {
  terminalId: string
  sessionId?: string
  at: number
  completionSeq: number
}

export type AmplifierActivityChange = {
  upsert: AmplifierActivityRecord[]
  remove: string[]
}

type TrackerLogger = {
  warn: (payload: object, message?: string) => void
}

type AmplifierTerminalActivity = {
  terminalId: string
  sessionId?: string
  phase: AmplifierActivityPhase
  updatedAt: number
  lastObservedAt: number
  lastSubmitAt?: number
  // True after a submit until the first output arrives. While true the idle-debounce
  // timer is deliberately NOT armed so pre-first-token latency cannot look like idle.
  awaitingFirstOutput: boolean
  idleTimer?: ReturnType<typeof setTimeout>
}

/**
 * Server-authoritative Amplifier turn lifecycle, keyed by terminalId.
 *
 * - A submit (whole-payload newline) marks busy, (re)arms the deadman and sets
 *   awaitingFirstOutput. It does NOT arm the idle-debounce timer yet.
 * - The first output after a submit clears awaitingFirstOutput; every output while
 *   busy (re)starts the idle-debounce timer. When that timer elapses with no further
 *   output the turn ends: phase → idle and one turn.complete is emitted.
 * - A busy terminal silent past the deadman self-heals to idle and also emits a
 *   turn.complete (Amplifier has no BEL, so the deadman is the only failsafe end).
 *
 * Unlike the Claude tracker this lane detects turn-END via OUTPUT-IDLE, not the
 * Stop-hook BEL parser.
 */
export class AmplifierActivityTracker extends EventEmitter {
  private readonly states = new Map<string, AmplifierTerminalActivity>()
  private readonly completionSeqByTerminalId = new Map<string, number>()
  private readonly latestCompletions = new Map<string, TerminalTurnCompletionSnapshot>()
  private readonly log?: TrackerLogger

  constructor(input: { log?: TrackerLogger } = {}) {
    super()
    this.log = input.log
  }

  list(): AmplifierActivityRecord[] {
    return Array.from(this.states.values()).map((state) => this.toRecord(state))
  }

  getActivity(terminalId: string): AmplifierActivityRecord | undefined {
    const state = this.states.get(terminalId)
    return state ? this.toRecord(state) : undefined
  }

  listLatestCompletions(): TerminalTurnCompletionSnapshot[] {
    return Array.from(this.latestCompletions.values())
  }

  trackTerminal(input: { terminalId: string; sessionId?: string; at: number }): void {
    const existing = this.states.get(input.terminalId)
    if (existing) {
      if (input.sessionId && existing.sessionId !== input.sessionId) {
        const previous = this.toRecord(existing)
        existing.sessionId = input.sessionId
        this.commitState(existing, previous)
      }
      return
    }
    const state: AmplifierTerminalActivity = {
      terminalId: input.terminalId,
      sessionId: input.sessionId,
      phase: 'idle',
      updatedAt: input.at,
      lastObservedAt: input.at,
      awaitingFirstOutput: false,
    }
    this.commitState(state, undefined)
  }

  bindSession(input: { terminalId: string; sessionId: string; at: number }): void {
    void input.at
    const state = this.states.get(input.terminalId)
    if (!state || state.sessionId === input.sessionId) return
    const previous = this.toRecord(state)
    state.sessionId = input.sessionId
    this.commitState(state, previous)
  }

  noteInput(input: { terminalId: string; data: string; at: number }): void {
    const state = this.states.get(input.terminalId)
    if (!state) return
    if (!isSubmitInput(input.data)) return
    const previous = this.toRecord(state)
    state.lastSubmitAt = input.at
    state.lastObservedAt = input.at
    // Turn onset: go busy and (re)arm the deadman via lastObservedAt. Wait for the
    // first output before arming the idle-debounce timer.
    state.awaitingFirstOutput = true
    this.clearIdleTimer(state)
    if (state.phase !== 'busy') {
      state.phase = 'busy'
      state.updatedAt = input.at
    }
    this.commitState(state, previous)
  }

  noteOutput(input: { terminalId: string; data: string; at: number }): void {
    const state = this.states.get(input.terminalId)
    if (!state) return
    if (state.phase !== 'busy') return
    state.lastObservedAt = input.at
    // First output after submit clears the awaiting flag; every output (re)starts the
    // idle-debounce timer so the turn ends only after output-silence.
    state.awaitingFirstOutput = false
    this.armIdleTimer(state)
  }

  private armIdleTimer(state: AmplifierTerminalActivity): void {
    this.clearIdleTimer(state)
    const terminalId = state.terminalId
    const at = state.lastObservedAt + AMPLIFIER_IDLE_DEBOUNCE_MS
    const timer = setTimeout(() => {
      this.handleIdleTimeout(terminalId, at)
    }, AMPLIFIER_IDLE_DEBOUNCE_MS)
    // Do not keep the event loop alive solely for a debounce timer.
    ;(timer as unknown as { unref?: () => void }).unref?.()
    state.idleTimer = timer
  }

  private clearIdleTimer(state: AmplifierTerminalActivity): void {
    if (state.idleTimer !== undefined) {
      clearTimeout(state.idleTimer)
      state.idleTimer = undefined
    }
  }

  private handleIdleTimeout(terminalId: string, at: number): void {
    const state = this.states.get(terminalId)
    if (!state) return
    state.idleTimer = undefined
    if (state.phase !== 'busy') return
    const previous = this.toRecord(state)
    state.phase = 'idle'
    state.awaitingFirstOutput = false
    state.updatedAt = at
    state.lastObservedAt = at
    const completion = this.recordTurnCompletion({
      terminalId: state.terminalId,
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      at,
    })
    this.commitState(state, previous)
    this.emit('turn.complete', completion)
  }

  private recordTurnCompletion(input: {
    terminalId: string
    sessionId?: string
    at: number
  }): AmplifierTurnCompleteEvent {
    const completionSeq = (this.completionSeqByTerminalId.get(input.terminalId) ?? 0) + 1
    this.completionSeqByTerminalId.set(input.terminalId, completionSeq)
    this.latestCompletions.set(input.terminalId, {
      terminalId: input.terminalId,
      at: input.at,
      completionSeq,
    })
    return {
      ...input,
      completionSeq,
    }
  }

  noteExit(input: { terminalId: string }): void {
    this.removeState(input.terminalId)
  }

  expire(at: number): void {
    for (const state of this.states.values()) {
      if (state.phase !== 'busy') continue
      const idleAgeMs = at - state.lastObservedAt
      if (idleAgeMs <= AMPLIFIER_BUSY_DEADMAN_MS) continue
      const previous = this.toRecord(state)
      this.clearIdleTimer(state)
      state.phase = 'idle'
      state.awaitingFirstOutput = false
      state.updatedAt = at
      state.lastObservedAt = at
      this.log?.warn({
        component: 'amplifier-activity-tracker',
        event: 'amplifier_activity_deadman',
        terminalId: state.terminalId,
        ageMs: idleAgeMs,
      }, 'Amplifier terminal stuck busy past deadman; clearing to idle.')
      const completion = this.recordTurnCompletion({
        terminalId: state.terminalId,
        ...(state.sessionId ? { sessionId: state.sessionId } : {}),
        at,
      })
      this.commitState(state, previous)
      this.emit('turn.complete', completion)
    }
  }

  /** Clear every per-terminal debounce timer (called on wiring dispose). */
  dispose(): void {
    for (const state of this.states.values()) {
      this.clearIdleTimer(state)
    }
  }

  private commitState(state: AmplifierTerminalActivity, previous: AmplifierActivityRecord | undefined): void {
    this.states.set(state.terminalId, state)
    const next = this.toRecord(state)
    if (!this.hasPublicChange(previous, next)) return
    this.emit('changed', { upsert: [next], remove: [] } satisfies AmplifierActivityChange)
  }

  private removeState(terminalId: string): void {
    const state = this.states.get(terminalId)
    if (!state) return
    this.clearIdleTimer(state)
    this.states.delete(terminalId)
    this.emit('changed', { upsert: [], remove: [terminalId] } satisfies AmplifierActivityChange)
  }

  private toRecord(state: AmplifierTerminalActivity): AmplifierActivityRecord {
    return {
      terminalId: state.terminalId,
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      phase: state.phase,
      updatedAt: state.updatedAt,
    }
  }

  private hasPublicChange(previous: AmplifierActivityRecord | undefined, next: AmplifierActivityRecord): boolean {
    if (!previous) return true
    return previous.phase !== next.phase || previous.sessionId !== next.sessionId
  }
}
