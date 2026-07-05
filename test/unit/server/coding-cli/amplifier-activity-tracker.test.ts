import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AMPLIFIER_BUSY_DEADMAN_MS,
  AMPLIFIER_IDLE_DEBOUNCE_MS,
  AmplifierActivityTracker,
  type AmplifierActivityChange,
  type AmplifierTurnCompleteEvent,
} from '../../../../server/coding-cli/amplifier-activity-tracker'

function setup() {
  const tracker = new AmplifierActivityTracker()
  const changes: AmplifierActivityChange[] = []
  const completions: AmplifierTurnCompleteEvent[] = []
  tracker.on('changed', (c: AmplifierActivityChange) => changes.push(c))
  tracker.on('turn.complete', (e: AmplifierTurnCompleteEvent) => completions.push(e))
  return { tracker, changes, completions }
}

describe('AmplifierActivityTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts idle on track and goes busy on submit', () => {
    const { tracker } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
  })

  it('does not start a turn on multiline paste', () => {
    const { tracker } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: 'line one\nline two', at: 2000 })
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
  })

  it('holds busy while output streams (each output restarts the idle-debounce)', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    tracker.noteOutput({ terminalId: 't1', data: 'thinking...', at: 2500 })
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
    // Output arriving just before the debounce elapses restarts the timer.
    vi.advanceTimersByTime(AMPLIFIER_IDLE_DEBOUNCE_MS - 1)
    tracker.noteOutput({ terminalId: 't1', data: 'more', at: 4499 })
    vi.advanceTimersByTime(AMPLIFIER_IDLE_DEBOUNCE_MS - 1)
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
    expect(completions).toHaveLength(0)
  })

  it('completes a turn on output-idle and emits exactly one turn.complete', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    tracker.noteOutput({ terminalId: 't1', data: 'thinking...', at: 2500 })
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
    // AMPLIFIER_IDLE_DEBOUNCE_MS of silence after the last output ends the turn.
    vi.advanceTimersByTime(AMPLIFIER_IDLE_DEBOUNCE_MS)
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    expect(completions).toHaveLength(1)
    expect(completions[0]).toMatchObject({ terminalId: 't1', completionSeq: 1 })
    expect(tracker.listLatestCompletions()).toHaveLength(1)
    expect(tracker.listLatestCompletions()[0]).toMatchObject({ terminalId: 't1', completionSeq: 1 })
  })

  it('does not go idle before the first output arrives after a submit', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    // No output yet: the idle-debounce timer is never armed, so pre-first-token
    // latency (even well past the debounce) must NOT end the turn.
    vi.advanceTimersByTime(AMPLIFIER_IDLE_DEBOUNCE_MS * 5)
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
    expect(completions).toHaveLength(0)
  })

  it('self-heals a stuck-busy terminal after the deadman and completes the turn', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    // No output ever arrives, so the idle-debounce timer is never armed. The deadman
    // sweep is the only failsafe end-of-turn and it also emits a completion.
    tracker.expire(2000 + AMPLIFIER_BUSY_DEADMAN_MS + 1)
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    expect(completions).toHaveLength(1)
    expect(completions[0]).toMatchObject({ terminalId: 't1', completionSeq: 1 })
  })

  it('output refreshes liveness so the deadman does not fire on an active turn', () => {
    const { tracker } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    tracker.noteOutput({ terminalId: 't1', data: 'progress', at: 2000 + AMPLIFIER_BUSY_DEADMAN_MS })
    tracker.expire(2000 + AMPLIFIER_BUSY_DEADMAN_MS + 1)
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
  })

  it('emits sequential completions across turns and carries the bound sessionId', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.bindSession({ terminalId: 't1', sessionId: 's-1', at: 1000 })
    // Turn 1
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    tracker.noteOutput({ terminalId: 't1', data: 'a', at: 2100 })
    vi.advanceTimersByTime(AMPLIFIER_IDLE_DEBOUNCE_MS)
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    // Turn 2
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 5000 })
    tracker.noteOutput({ terminalId: 't1', data: 'b', at: 5100 })
    vi.advanceTimersByTime(AMPLIFIER_IDLE_DEBOUNCE_MS)
    expect(completions.map((completion) => completion.completionSeq)).toEqual([1, 2])
    expect(completions.every((completion) => completion.sessionId === 's-1')).toBe(true)
  })

  it('removes state on exit and emits a removal', () => {
    const { tracker, changes } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteExit({ terminalId: 't1' })
    expect(tracker.getActivity('t1')).toBeUndefined()
    expect(changes.at(-1)).toEqual({ upsert: [], remove: ['t1'] })
  })

  it('list() reflects current records', () => {
    const { tracker } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    expect(tracker.list()).toEqual([{ terminalId: 't1', phase: 'busy', updatedAt: 2000 }])
  })

  it('attaches sessionId via bindSession', () => {
    const { tracker } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.bindSession({ terminalId: 't1', sessionId: 's-1', at: 1500 })
    expect(tracker.getActivity('t1')?.sessionId).toBe('s-1')
  })
})
