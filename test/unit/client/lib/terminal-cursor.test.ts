import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetTerminalCursorCacheForTests,
  clearTerminalCursor,
  getCursorMapSize,
  loadTerminalCursor,
  loadTerminalSurfaceCheckpoint,
  saveTerminalCursor,
  saveTerminalSurfaceCheckpoint,
} from '@/lib/terminal-cursor'
import type { TerminalSurfaceCheckpoint } from '@/lib/terminal-surface-checkpoint'
import { TERMINAL_CURSOR_STORAGE_KEY } from '@/store/storage-keys'

function createCheckpoint(
  overrides: Partial<TerminalSurfaceCheckpoint> = {},
): TerminalSurfaceCheckpoint {
  return {
    terminalId: 'term-1',
    streamId: 'stream-1',
    serverInstanceId: 'server-a',
    surfaceEpoch: 1,
    attachRequestId: 'attach-1',
    parserAppliedSeq: 1,
    cols: 80,
    rows: 24,
    geometryEpoch: 1,
    geometryAuthority: 'single_client',
    scrollback: 5000,
    xtermVersion: '6.0.0',
    bufferType: 'normal',
    parserIdle: true,
    ...overrides,
  }
}

function loadCheckpointSeq(terminalId: string): number {
  return loadTerminalSurfaceCheckpoint(terminalId, {
    streamId: 'stream-1',
    serverInstanceId: 'server-a',
  })?.parserAppliedSeq ?? 0
}

function loadCheckpointSeqScoped(paneId: string, terminalId: string): number {
  return loadTerminalSurfaceCheckpoint(terminalId, {
    streamId: 'stream-1',
    serverInstanceId: 'server-a',
  }, { paneId })?.parserAppliedSeq ?? 0
}

describe('terminal-cursor', () => {
  beforeEach(() => {
    vi.useRealTimers()
    localStorage.clear()
    __resetTerminalCursorCacheForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('loads and saves terminal surface checkpoint sequence values', () => {
    expect(loadCheckpointSeq('term-1')).toBe(0)

    saveTerminalSurfaceCheckpoint(createCheckpoint({ parserAppliedSeq: 4 }))
    expect(loadCheckpointSeq('term-1')).toBe(4)

    saveTerminalSurfaceCheckpoint(createCheckpoint({ parserAppliedSeq: 2 }))
    expect(loadCheckpointSeq('term-1')).toBe(4)

    saveTerminalSurfaceCheckpoint(createCheckpoint({ parserAppliedSeq: 8 }))
    expect(loadCheckpointSeq('term-1')).toBe(8)
  })

  it('uses the incompatible v2 storage namespace for checkpoint records', () => {
    expect(TERMINAL_CURSOR_STORAGE_KEY).toBe('freshell.terminal-cursors.v2')
  })

  it('clears an entry when terminal exits', () => {
    saveTerminalSurfaceCheckpoint(createCheckpoint({
      terminalId: 'term-2',
      parserAppliedSeq: 11,
    }))
    expect(loadCheckpointSeq('term-2')).toBe(11)

    clearTerminalCursor('term-2')
    expect(loadCheckpointSeq('term-2')).toBe(0)
  })

  it('drops expired entries when loading from storage', () => {
    const now = Date.now()
    const fifteenDaysMs = 15 * 24 * 60 * 60 * 1000
    localStorage.setItem(TERMINAL_CURSOR_STORAGE_KEY, JSON.stringify({
      stale: {
        checkpoint: createCheckpoint({ terminalId: 'stale', parserAppliedSeq: 5 }),
        updatedAt: now - fifteenDaysMs,
      },
      fresh: {
        checkpoint: createCheckpoint({ terminalId: 'fresh', parserAppliedSeq: 9 }),
        updatedAt: now,
      },
    }))
    __resetTerminalCursorCacheForTests()

    expect(loadCheckpointSeq('stale')).toBe(0)
    expect(loadCheckpointSeq('fresh')).toBe(9)
    expect(getCursorMapSize()).toBe(1)
  })

  it('enforces max entry count by keeping most recently updated entries', () => {
    const now = Date.now()
    const payload: Record<string, { checkpoint: TerminalSurfaceCheckpoint; updatedAt: number }> = {}
    for (let i = 0; i < 520; i += 1) {
      payload[`term-${i}`] = {
        checkpoint: createCheckpoint({
          terminalId: `term-${i}`,
          parserAppliedSeq: i + 1,
        }),
        updatedAt: now - i,
      }
    }
    localStorage.setItem(TERMINAL_CURSOR_STORAGE_KEY, JSON.stringify(payload))
    __resetTerminalCursorCacheForTests()

    expect(getCursorMapSize()).toBeLessThanOrEqual(500)
    expect(loadCheckpointSeq('term-0')).toBe(1)
    expect(loadCheckpointSeq('term-519')).toBe(0)
  })

  it('remains resilient when stored payload is malformed', () => {
    localStorage.setItem(TERMINAL_CURSOR_STORAGE_KEY, '{not valid json')
    __resetTerminalCursorCacheForTests()

    expect(loadTerminalCursor('term-bad')).toBe(0)
    expect(getCursorMapSize()).toBe(0)
  })

  it('treats legacy persisted cursor records as incompatible by default', () => {
    localStorage.setItem(TERMINAL_CURSOR_STORAGE_KEY, JSON.stringify({
      'term-legacy': { seq: 12, updatedAt: Date.now() },
    }))
    __resetTerminalCursorCacheForTests()

    expect(loadTerminalCursor('term-legacy')).toBe(0)
    expect(loadTerminalSurfaceCheckpoint('term-legacy', {
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
    })).toBeNull()
  })

  it('does not let legacy cursor writes mutate a trusted checkpoint', () => {
    saveTerminalSurfaceCheckpoint(createCheckpoint({
      terminalId: 'term-legacy-write',
      parserAppliedSeq: 25,
    }))

    saveTerminalCursor('term-legacy-write', 100)

    expect(loadTerminalCursor('term-legacy-write')).toBe(0)
    expect(loadTerminalSurfaceCheckpoint('term-legacy-write', {
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
    })?.parserAppliedSeq).toBe(25)
  })

  it('does not create a trusted cursor from legacy cursor writes', () => {
    saveTerminalCursor('term-only-legacy', 100)

    expect(loadTerminalCursor('term-only-legacy')).toBe(0)
    expect(loadTerminalSurfaceCheckpoint('term-only-legacy', {
      streamId: null,
      serverInstanceId: 'legacy-cursor',
    })).toBeNull()
  })

  it('does not load a persisted checkpoint for a different server instance', () => {
    saveTerminalSurfaceCheckpoint({
      terminalId: 'term-1',
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      surfaceEpoch: 1,
      attachRequestId: 'attach-1',
      parserAppliedSeq: 25,
      cols: 80,
      rows: 24,
      geometryEpoch: 1,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      bufferType: 'normal',
      parserIdle: true,
    })

    expect(loadTerminalSurfaceCheckpoint('term-1', {
      streamId: 'stream-1',
      serverInstanceId: 'server-b',
    })).toBeNull()
  })

  it('does not load a persisted checkpoint when either side lacks a boot id', () => {
    saveTerminalSurfaceCheckpoint(createCheckpoint({
      terminalId: 'term-boot',
      serverBootId: 'boot-a',
      parserAppliedSeq: 25,
    }))

    expect(loadTerminalSurfaceCheckpoint('term-boot', {
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
    })).toBeNull()
    expect(loadTerminalSurfaceCheckpoint('term-boot', {
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      serverBootId: 'boot-b',
    })).toBeNull()
    expect(loadTerminalSurfaceCheckpoint('term-boot', {
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      serverBootId: 'boot-a',
    })?.parserAppliedSeq).toBe(25)
  })

  it('debounces localStorage persistence for rapid checkpoint updates', () => {
    vi.useFakeTimers()
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')

    saveTerminalSurfaceCheckpoint(createCheckpoint({ terminalId: 'term-rapid', parserAppliedSeq: 1 }))
    saveTerminalSurfaceCheckpoint(createCheckpoint({ terminalId: 'term-rapid', parserAppliedSeq: 2 }))
    saveTerminalSurfaceCheckpoint(createCheckpoint({ terminalId: 'term-rapid', parserAppliedSeq: 3 }))

    expect(loadCheckpointSeq('term-rapid')).toBe(3)
    expect(setItemSpy).not.toHaveBeenCalled()

    vi.advanceTimersByTime(250)
    expect(setItemSpy).toHaveBeenCalledTimes(1)

    setItemSpy.mockRestore()
  })

  describe('surface-scoped checkpoint store (sibling pane isolation)', () => {
    it('a scoped save is invisible to a different pane and to unscoped loads', () => {
      saveTerminalSurfaceCheckpoint(
        createCheckpoint({ parserAppliedSeq: 30, surfaceCoverageSeq: 30 }),
        { paneId: 'pane-a' },
      )

      // The owning pane loads its own progress.
      expect(loadTerminalSurfaceCheckpoint('term-1', {
        streamId: 'stream-1',
        serverInstanceId: 'server-a',
      }, { paneId: 'pane-a' })?.parserAppliedSeq).toBe(30)

      // A sibling pane rendering the same terminal cannot borrow it…
      expect(loadTerminalSurfaceCheckpoint('term-1', {
        streamId: 'stream-1',
        serverInstanceId: 'server-a',
      }, { paneId: 'pane-b' })).toBeNull()

      // …and neither can an unscoped (legacy) caller.
      expect(loadTerminalSurfaceCheckpoint('term-1', {
        streamId: 'stream-1',
        serverInstanceId: 'server-a',
      })).toBeNull()
    })

    it('sibling panes cannot overwrite each other\u2019s progress', () => {
      saveTerminalSurfaceCheckpoint(
        createCheckpoint({ parserAppliedSeq: 30, surfaceCoverageSeq: 30 }),
        { paneId: 'pane-a' },
      )
      saveTerminalSurfaceCheckpoint(
        createCheckpoint({ parserAppliedSeq: 4, surfaceCoverageSeq: 4 }),
        { paneId: 'pane-b' },
      )

      expect(loadCheckpointSeqScoped('pane-a', 'term-1')).toBe(30)
      expect(loadCheckpointSeqScoped('pane-b', 'term-1')).toBe(4)
      expect(getCursorMapSize()).toBe(2)
    })

    it('prevents a lower-coverage save from overwriting a higher-coverage checkpoint in the same scope', () => {
      saveTerminalSurfaceCheckpoint(
        createCheckpoint({ parserAppliedSeq: 8, surfaceCoverageSeq: 12 }),
        { paneId: 'pane-a' },
      )
      // A regressed save (e.g. a stale write racing a rebuild) must not clobber.
      saveTerminalSurfaceCheckpoint(
        createCheckpoint({ parserAppliedSeq: 5, surfaceCoverageSeq: 5 }),
        { paneId: 'pane-a' },
      )

      const loaded = loadTerminalSurfaceCheckpoint('term-1', {
        streamId: 'stream-1',
        serverInstanceId: 'server-a',
      }, { paneId: 'pane-a' })
      expect(loaded?.parserAppliedSeq).toBe(8)
      expect(loaded?.surfaceCoverageSeq).toBe(12)
    })

    it('merges a coverage-only advance with an unchanged applied position', () => {
      saveTerminalSurfaceCheckpoint(
        createCheckpoint({ parserAppliedSeq: 8, surfaceCoverageSeq: 8 }),
        { paneId: 'pane-a' },
      )
      // Filtered frames advanced coverage without moving the applied cursor.
      saveTerminalSurfaceCheckpoint(
        createCheckpoint({ parserAppliedSeq: 8, surfaceCoverageSeq: 14 }),
        { paneId: 'pane-a' },
      )

      const loaded = loadTerminalSurfaceCheckpoint('term-1', {
        streamId: 'stream-1',
        serverInstanceId: 'server-a',
      }, { paneId: 'pane-a' })
      expect(loaded?.parserAppliedSeq).toBe(8)
      expect(loaded?.surfaceCoverageSeq).toBe(14)
    })

    it('accepts a checkpoint with zero applied but positive coverage (mixed page)', () => {
      saveTerminalSurfaceCheckpoint(
        createCheckpoint({ parserAppliedSeq: 0, surfaceCoverageSeq: 9 }),
        { paneId: 'pane-a' },
      )

      const loaded = loadTerminalSurfaceCheckpoint('term-1', {
        streamId: 'stream-1',
        serverInstanceId: 'server-a',
      }, { paneId: 'pane-a' })
      expect(loaded?.parserAppliedSeq).toBe(0)
      expect(loaded?.surfaceCoverageSeq).toBe(9)
    })

    it('clearing a terminal removes every pane\u2019s scoped entry for it', () => {
      saveTerminalSurfaceCheckpoint(
        createCheckpoint({ parserAppliedSeq: 30, surfaceCoverageSeq: 30 }),
        { paneId: 'pane-a' },
      )
      saveTerminalSurfaceCheckpoint(
        createCheckpoint({ parserAppliedSeq: 4, surfaceCoverageSeq: 4 }),
        { paneId: 'pane-b' },
      )

      clearTerminalCursor('term-1')

      expect(loadCheckpointSeqScoped('pane-a', 'term-1')).toBe(0)
      expect(loadCheckpointSeqScoped('pane-b', 'term-1')).toBe(0)
      expect(getCursorMapSize()).toBe(0)
    })
  })

  it('flushes immediately when clearing a cursor with pending debounced writes', () => {
    vi.useFakeTimers()
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')

    saveTerminalSurfaceCheckpoint(createCheckpoint({ terminalId: 'term-clear', parserAppliedSeq: 7 }))
    expect(setItemSpy).not.toHaveBeenCalled()

    clearTerminalCursor('term-clear')
    expect(setItemSpy).toHaveBeenCalledTimes(1)
    expect(loadCheckpointSeq('term-clear')).toBe(0)

    vi.advanceTimersByTime(250)
    expect(setItemSpy).toHaveBeenCalledTimes(1)

    setItemSpy.mockRestore()
  })
})
