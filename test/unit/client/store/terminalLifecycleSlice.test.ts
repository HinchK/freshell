import { describe, it, expect } from 'vitest'
import reducer, {
  recordTerminalExit, recordAutoResumeRecovering, foldTerminalReplacement,
  clearTerminalLifecycle, recordAutoResumeSettled, clearRecoveringNotices,
  selectExitRecordFrom, selectActiveNoticeFrom,
  selectLastTerminalIdFrom, selectExitRecord, selectActiveNotice,
  selectResumeCycles,
  recordTerminalStuck, clearTerminalStuck, clearTerminalStuckIfOtherTerminal,
  selectStuckEntryFrom, selectStuckEntry,
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

  // ── Wedge-backstop stuck entries (LB-8) ──

  it('records a stuck entry keyed by paneId with the flagged terminalId, and clears it', () => {
    let s = reducer(empty, recordTerminalStuck({ paneId: 'p1', terminalId: 't1', at: 100 }))
    expect(selectStuckEntryFrom(s, 'p1')).toEqual({ at: 100, terminalId: 't1' })
    s = reducer(s, clearTerminalStuck({ paneId: 'p1' }))
    expect(selectStuckEntryFrom(s, 'p1')).toBeUndefined()
  })

  it('clearTerminalStuckIfOtherTerminal deletes only when the stored terminalId differs (the adoption clear)', () => {
    let s = reducer(empty, recordTerminalStuck({ paneId: 'p1', terminalId: 'T0', at: 100 }))
    // Adopting the SAME terminal keeps the flag (it refers to this terminal).
    s = reducer(s, clearTerminalStuckIfOtherTerminal({ paneId: 'p1', terminalId: 'T0' }))
    expect(selectStuckEntryFrom(s, 'p1')).toEqual({ at: 100, terminalId: 'T0' })
    // Adopting a DIFFERENT terminal clears the stale flag.
    s = reducer(s, clearTerminalStuckIfOtherTerminal({ paneId: 'p1', terminalId: 'T1' }))
    expect(selectStuckEntryFrom(s, 'p1')).toBeUndefined()
  })

  it('recordTerminalExit drops the stuck entry (the flag cannot outlive the dead process)', () => {
    let s = reducer(empty, recordTerminalStuck({ paneId: 'p1', terminalId: 't1', at: 100 }))
    s = reducer(s, recordTerminalExit({ paneId: 'p1', terminalId: 't1', exitCode: 1, at: 200 }))
    expect(selectStuckEntryFrom(s, 'p1')).toBeUndefined()
  })

  it('clearTerminalLifecycle drops the stuck entry (relaunch discards stale presentation state)', () => {
    let s = reducer(empty, recordTerminalStuck({ paneId: 'p1', terminalId: 't1', at: 100 }))
    s = reducer(s, clearTerminalLifecycle({ paneId: 'p1' }))
    expect(selectStuckEntryFrom(s, 'p1')).toBeUndefined()
  })

  it('foldTerminalReplacement clears a stale flag keyed on newTerminalId, but keeps an entry naming the new terminal itself', () => {
    // The ordinary shape: the flag belongs to the OLD terminal.
    let s = reducer(empty, recordTerminalStuck({ paneId: 'p1', terminalId: 't0', at: 100 }))
    s = reducer(s, foldTerminalReplacement({ paneId: 'p1', newTerminalId: 't1', exitCode: 1, attempt: 1, maxAttempts: 2, at: 200 }))
    expect(selectStuckEntryFrom(s, 'p1')).toBeUndefined()
    // Defensive belt: a replacement frame naming the flagged terminal keeps
    // the flag (never flag-swallowing).
    let s2 = reducer(empty, recordTerminalStuck({ paneId: 'p2', terminalId: 't9', at: 300 }))
    s2 = reducer(s2, foldTerminalReplacement({ paneId: 'p2', newTerminalId: 't9', exitCode: 0, attempt: 1, maxAttempts: 2, at: 400 }))
    expect(selectStuckEntryFrom(s2, 'p2')).toEqual({ at: 300, terminalId: 't9' })
  })

  it('the stuck reducers tolerate a state materialized before stuckAtByPaneId existed (partial preloaded test stores)', () => {
    // Pre-existing harnesses preload `terminalLifecycle: { byPaneId: {...} }`
    // — writes and deletes on the missing key must not crash.
    const legacy = { byPaneId: {} } as Parameters<typeof reducer>[0]
    let s = reducer(legacy, recordTerminalStuck({ paneId: 'p1', terminalId: 't1', at: 1 }))
    expect(selectStuckEntryFrom(s, 'p1')).toEqual({ at: 1, terminalId: 't1' })
    s = reducer(s, recordTerminalExit({ paneId: 'p1', terminalId: 't1', exitCode: 0, at: 2 }))
    expect(selectStuckEntryFrom(s, 'p1')).toBeUndefined()
    s = reducer(s, clearTerminalStuckIfOtherTerminal({ paneId: 'p9', terminalId: 't9' }))
    expect(selectStuckEntryFrom(s, 'p9')).toBeUndefined()
    s = reducer(s, clearTerminalStuck({ paneId: 'p9' }))
    s = reducer(s, foldTerminalReplacement({ paneId: 'p8', newTerminalId: 't8', exitCode: 0, attempt: 1, maxAttempts: 2, at: 3 }))
    expect(s).toBeDefined()
  })

  it('selectStuckEntry tolerates an absent slice state', () => {
    expect(selectStuckEntry({} as never, 'p1')).toBeUndefined()
    expect(selectStuckEntryFrom(undefined, 'p1')).toBeUndefined()
  })
})
