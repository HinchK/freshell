import { describe, expect, it } from 'vitest'
import { createTerminalStreamIdentityTracker } from '../../../../server/terminal-stream/stream-identity'

describe('terminal stream identity', () => {
  it('keeps stream id stable across attach and detach for the same output stream', () => {
    const tracker = createTerminalStreamIdentityTracker()
    const initial = tracker.ensureStream('term-1')

    expect(tracker.ensureStream('term-1')).toBe(initial)
    tracker.recordAttach('term-1', 'attach-1')
    tracker.recordDetach('term-1', 'attach-1')

    expect(tracker.ensureStream('term-1')).toBe(initial)
  })

  it('changes stream id on pty replacement and incompatible retention loss', () => {
    const tracker = createTerminalStreamIdentityTracker()
    const initial = tracker.ensureStream('term-1')

    const afterRecovery = tracker.replaceStream('term-1', 'codex_pty_recovery')
    const afterRetentionLoss = tracker.replaceStream('term-1', 'retention_lost')

    expect(afterRecovery).not.toBe(initial)
    expect(afterRetentionLoss).not.toBe(afterRecovery)
  })
})
