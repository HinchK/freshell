import { describe, it, expect } from 'vitest'
import reducer, {
  recordTerminalExit, recordAutoResumeRecovering, foldTerminalReplacement,
  clearTerminalLifecycle, recordAutoResumeSettled, clearRecoveringNotices,
  selectExitRecordFrom, selectActiveNoticeFrom,
  selectLastTerminalIdFrom, selectExitRecord, selectActiveNotice,
  selectResumeCycles,
} from '@/store/terminalLifecycleSlice'

const empty = reducer(undefined, { type: '@@init' })

describe('terminalLifecycleSlice', () => {
  it('records an exit code + lastTerminalId per paneId', () => {
    const s = reducer(empty, recordTerminalExit({ paneId: 'p1', terminalId: 't1', exitCode: 1, at: 1000 }))
    expect(selectExitRecordFrom(s, 'p1')).toEqual({ exitCode: 1, at: 1000 })
    expect(selectLastTerminalIdFrom(s, 'p1')).toBe('t1') // frame-matching key survives TerminalView clearing its own terminalId
  })

  it('selectActiveNoticeFrom returns the notice with no TTL — settles are frame-driven', () => {
    // znhn item 3: the 30s TTL guessing apparatus is deleted; a notice stays
    // active until a settle/replaced frame (or reconnect backstop) clears it.
    const s = reducer(empty, recordAutoResumeRecovering({ paneId: 'p1', attempt: 1, maxAttempts: 2, exitCode: 1, at: 0 }))
    expect(selectActiveNoticeFrom(s, 'p1')?.kind).toBe('recovering')
  })

  it('recordAutoResumeSettled clears the notice and records resumeCycles', () => {
    let s = reducer(empty, recordAutoResumeRecovering({ paneId: 'p1', attempt: 1, maxAttempts: 2, exitCode: 1, at: 1000 }))
    s = reducer(s, recordAutoResumeSettled({ paneId: 'p1', resumeCycles: 3 }))
    expect(selectActiveNoticeFrom(s, 'p1')).toBeUndefined()
    expect(selectResumeCycles({ terminalLifecycle: s }, 'p1')).toBe(3)
  })

  it('clearRecoveringNotices clears every recovering notice (D-3 reconnect backstop)', () => {
    let s = reducer(empty, recordAutoResumeRecovering({ paneId: 'p1', attempt: 1, maxAttempts: 2, exitCode: 1, at: 1000 }))
    s = reducer(s, recordAutoResumeRecovering({ paneId: 'p2', attempt: 2, maxAttempts: 2, exitCode: 137, at: 1000 }))
    s = reducer(s, recordTerminalExit({ paneId: 'p3', terminalId: 't3', exitCode: 1, at: 1000 }))
    s = reducer(s, recordAutoResumeSettled({ paneId: 'p4', resumeCycles: 5 }))
    s = reducer(s, clearRecoveringNotices())
    expect(selectActiveNoticeFrom(s, 'p1')).toBeUndefined()
    expect(selectActiveNoticeFrom(s, 'p2')).toBeUndefined()
    // exit + settle records are untouched — only notices clear.
    expect(selectExitRecordFrom(s, 'p3')).toEqual({ exitCode: 1, at: 1000 })
    expect(selectResumeCycles({ terminalLifecycle: s }, 'p4')).toBe(5)
  })

  it('recordTerminalExit clears prior settle state (stale resumeCycles cannot leak into a later crash banner)', () => {
    let s = reducer(empty, recordAutoResumeSettled({ paneId: 'p1', resumeCycles: 5 }))
    s = reducer(s, recordTerminalExit({ paneId: 'p1', terminalId: 't1', exitCode: 1, at: 2 }))
    expect(selectResumeCycles({ terminalLifecycle: s }, 'p1')).toBeUndefined()
  })

  it('foldTerminalReplacement clears the notice (the persistent crash trace replaces the resumed strip)', () => {
    // znhn item 1: the 'resumed' notice kind is retired — the dismissible
    // crash trace on pane content is the post-resume indicator.
    let s = reducer(empty, recordTerminalExit({ paneId: 'p1', terminalId: 't1', exitCode: 1, at: 1000 }))
    s = reducer(s, recordAutoResumeRecovering({ paneId: 'p1', attempt: 1, maxAttempts: 2, exitCode: 1, at: 1000 }))
    s = reducer(s, foldTerminalReplacement({ paneId: 'p1', newTerminalId: 't2', exitCode: 1, attempt: 1, maxAttempts: 2, at: 2000 }))
    expect(selectExitRecordFrom(s, 'p1')).toBeUndefined() // pane is alive again — no error bar
    expect(selectActiveNoticeFrom(s, 'p1')).toBeUndefined()
    expect(selectLastTerminalIdFrom(s, 'p1')).toBe('t2')
  })

  it('a replacement clears prior settle state (stale resumeCycles cannot leak into a later crash banner)', () => {
    // Pairs with the recordTerminalExit pin above (validated A15): nothing
    // else ever deletes the settle state, and the REST-door relaunch/
    // reconcile never advances lastTerminalId.
    let s = reducer(empty, recordAutoResumeSettled({ paneId: 'p1', resumeCycles: 5 }))
    s = reducer(s, foldTerminalReplacement({ paneId: 'p1', newTerminalId: 't2', exitCode: 1, attempt: 1, maxAttempts: 2, at: 2000 }))
    expect(selectResumeCycles({ terminalLifecycle: s }, 'p1')).toBeUndefined()
  })

  it('a later exit clears any active notice (exhaustion must not be masked by a stale strip)', () => {
    let s = reducer(empty, recordAutoResumeRecovering({ paneId: 'p1', attempt: 1, maxAttempts: 2, exitCode: 1, at: 1000 }))
    s = reducer(s, recordTerminalExit({ paneId: 'p1', terminalId: 't2', exitCode: 1, at: 2000 }))
    expect(selectActiveNoticeFrom(s, 'p1')).toBeUndefined()
    expect(selectExitRecordFrom(s, 'p1')).toEqual({ exitCode: 1, at: 2000 })
  })

  it('selectors tolerate a root store without the slice (partial test stores must not crash)', () => {
    // Regression pin: 44 pre-existing client test files build partial Redux
    // stores (no terminalLifecycle reducer) and render TerminalView, which
    // calls these selectors on every render. They must degrade to undefined,
    // mirroring the paneRuntimeActivity defensive-access convention.
    const bare = {} as Parameters<typeof selectExitRecord>[0]
    expect(selectExitRecord(bare, 'p1')).toBeUndefined()
    expect(selectActiveNotice(bare, 'p1')).toBeUndefined()
    expect(selectResumeCycles(bare, 'p1')).toBeUndefined()
    expect(selectExitRecordFrom(undefined, 'p1')).toBeUndefined()
    expect(selectLastTerminalIdFrom(undefined, 'p1')).toBeUndefined()
    expect(selectActiveNoticeFrom(undefined, 'p1')).toBeUndefined()
  })

  it('clearTerminalLifecycle wipes the pane entry', () => {
    let s = reducer(empty, recordTerminalExit({ paneId: 'p1', terminalId: 't1', exitCode: 7, at: 1 }))
    s = reducer(s, clearTerminalLifecycle({ paneId: 'p1' }))
    expect(selectExitRecordFrom(s, 'p1')).toBeUndefined()
    expect(selectLastTerminalIdFrom(s, 'p1')).toBeUndefined()
  })
})
