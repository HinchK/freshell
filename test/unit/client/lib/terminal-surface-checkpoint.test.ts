import { describe, expect, it } from 'vitest'
import {
  createTerminalSurfaceCheckpoint,
  canUseCheckpointForDeltaReplay,
} from '@/lib/terminal-surface-checkpoint'

function baseCheckpoint(overrides: Record<string, unknown> = {}) {
  return createTerminalSurfaceCheckpoint({
    terminalId: 'term-1',
    streamId: 'stream-1',
    serverInstanceId: 'server-a',
    surfaceEpoch: 2,
    attachRequestId: 'attach-2',
    parserAppliedSeq: 42,
    surfaceCoverageSeq: 42,
    cols: 120,
    rows: 40,
    geometryEpoch: 3,
    geometryAuthority: 'single_client',
    scrollback: 5000,
    xtermVersion: '6.0.0',
    bufferType: 'normal',
    parserIdle: true,
    ...overrides,
  } as never)
}

function baseReplayInput(overrides: Record<string, unknown> = {}) {
  return {
    terminalId: 'term-1',
    streamId: 'stream-1',
    serverInstanceId: 'server-a',
    surfaceEpoch: 2,
    cols: 120,
    rows: 40,
    geometryEpoch: 3,
    geometryAuthority: 'single_client',
    scrollback: 5000,
    xtermVersion: '6.0.0',
    requireParserIdle: true,
    ...overrides,
  }
}

describe('terminal surface checkpoint', () => {
  it('accepts a compatible parser-applied checkpoint', () => {
    const checkpoint = createTerminalSurfaceCheckpoint({
      terminalId: 'term-1',
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      surfaceEpoch: 2,
      attachRequestId: 'attach-2',
      parserAppliedSeq: 42,
      cols: 120,
      rows: 40,
      geometryEpoch: 3,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      bufferType: 'normal',
      parserIdle: true,
    })

    expect(canUseCheckpointForDeltaReplay(checkpoint, {
      terminalId: 'term-1',
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      surfaceEpoch: 2,
      cols: 120,
      rows: 40,
      geometryEpoch: 3,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      requireParserIdle: true,
    })).toMatchObject({ ok: true, sinceSeq: 42 })
  })

  it('rejects warm delta when the current stream identity is missing even if the checkpoint is null-stream', () => {
    const checkpoint = createTerminalSurfaceCheckpoint({
      terminalId: 'term-1',
      streamId: null,
      serverInstanceId: 'server-a',
      surfaceEpoch: 2,
      attachRequestId: 'attach-2',
      parserAppliedSeq: 42,
      cols: 120,
      rows: 40,
      geometryEpoch: 3,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      bufferType: 'normal',
      parserIdle: true,
    })

    expect(canUseCheckpointForDeltaReplay(checkpoint, {
      terminalId: 'term-1',
      streamId: null,
      serverInstanceId: 'server-a',
      surfaceEpoch: 2,
      cols: 120,
      rows: 40,
      geometryEpoch: 3,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      requireParserIdle: true,
    })).toMatchObject({ ok: false, reason: 'stream_changed' })
  })

  it('rejects a checkpoint after geometry changes', () => {
    const checkpoint = createTerminalSurfaceCheckpoint({
      terminalId: 'term-1',
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      surfaceEpoch: 2,
      attachRequestId: 'attach-2',
      parserAppliedSeq: 42,
      cols: 120,
      rows: 40,
      geometryEpoch: 3,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      bufferType: 'normal',
      parserIdle: true,
    })

    expect(canUseCheckpointForDeltaReplay(checkpoint, {
      terminalId: 'term-1',
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      surfaceEpoch: 2,
      cols: 100,
      rows: 40,
      geometryEpoch: 4,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      requireParserIdle: true,
    })).toMatchObject({ ok: false, reason: 'geometry_changed' })
  })

  it('rejects a checkpoint while parser work is still in flight', () => {
    const checkpoint = createTerminalSurfaceCheckpoint({
      terminalId: 'term-1',
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      surfaceEpoch: 2,
      attachRequestId: 'attach-2',
      parserAppliedSeq: 42,
      cols: 120,
      rows: 40,
      geometryEpoch: 3,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      bufferType: 'normal',
      parserIdle: false,
    })

    expect(canUseCheckpointForDeltaReplay(checkpoint, {
      terminalId: 'term-1',
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      surfaceEpoch: 2,
      cols: 120,
      rows: 40,
      geometryEpoch: 3,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      requireParserIdle: true,
    })).toMatchObject({ ok: false, reason: 'parser_busy' })
  })

  it('rejects a checkpoint from a different server instance', () => {
    const checkpoint = createTerminalSurfaceCheckpoint({
      terminalId: 'term-1',
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      surfaceEpoch: 2,
      attachRequestId: 'attach-2',
      parserAppliedSeq: 42,
      cols: 120,
      rows: 40,
      geometryEpoch: 3,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      bufferType: 'normal',
      parserIdle: true,
    })

    expect(canUseCheckpointForDeltaReplay(checkpoint, {
      terminalId: 'term-1',
      streamId: 'stream-1',
      serverInstanceId: 'server-b',
      surfaceEpoch: 2,
      cols: 120,
      rows: 40,
      geometryEpoch: 3,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      requireParserIdle: true,
    })).toMatchObject({ ok: false, reason: 'server_changed' })
  })

  it('rejects a checkpoint when only the checkpoint has a server boot id', () => {
    const checkpoint = createTerminalSurfaceCheckpoint({
      terminalId: 'term-1',
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      serverBootId: 'boot-a',
      surfaceEpoch: 2,
      attachRequestId: 'attach-2',
      parserAppliedSeq: 42,
      cols: 120,
      rows: 40,
      geometryEpoch: 3,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      bufferType: 'normal',
      parserIdle: true,
    })

    expect(canUseCheckpointForDeltaReplay(checkpoint, {
      terminalId: 'term-1',
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      surfaceEpoch: 2,
      cols: 120,
      rows: 40,
      geometryEpoch: 3,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      requireParserIdle: true,
    })).toMatchObject({ ok: false, reason: 'server_changed' })
  })

  it('rejects a checkpoint when only the current server has a boot id', () => {
    const checkpoint = baseCheckpoint()

    expect(canUseCheckpointForDeltaReplay(checkpoint, baseReplayInput({
      serverBootId: 'boot-a',
    }))).toMatchObject({ ok: false, reason: 'server_changed' })
  })

  describe('surface coverage cursor (responsive-terminal-restore WS1/WS2)', () => {
    it('resumes from the coverage cursor past a filtered range (mixed/filtered-only pages)', () => {
      // A mixed page (filtered prefix + applied tail) leaves the strict
      // parser-applied position pinned below already-rendered content; the
      // coverage cursor is the reconstruction-safe resume position.
      const checkpoint = baseCheckpoint({ parserAppliedSeq: 0, surfaceCoverageSeq: 8 })

      expect(canUseCheckpointForDeltaReplay(checkpoint, baseReplayInput()))
        .toMatchObject({ ok: true, sinceSeq: 8 })
    })

    it('requests sinceSeq from coverage even when it runs ahead of the applied position', () => {
      const checkpoint = baseCheckpoint({ parserAppliedSeq: 5, surfaceCoverageSeq: 12 })

      expect(canUseCheckpointForDeltaReplay(checkpoint, baseReplayInput()))
        .toMatchObject({ ok: true, sinceSeq: 12 })
    })

    it('resumes a legacy checkpoint without a coverage field from its applied position', () => {
      const checkpoint = baseCheckpoint()
      delete (checkpoint as Record<string, unknown>).surfaceCoverageSeq

      expect(canUseCheckpointForDeltaReplay(checkpoint, baseReplayInput()))
        .toMatchObject({ ok: true, sinceSeq: 42 })
    })

    it('rejects a checkpoint with neither applied nor coverage progress', () => {
      const checkpoint = baseCheckpoint({ parserAppliedSeq: 0, surfaceCoverageSeq: 0 })

      expect(canUseCheckpointForDeltaReplay(checkpoint, baseReplayInput()))
        .toMatchObject({ ok: false, reason: 'no_applied_sequence' })
    })

    it('accepts a checkpoint from the same surface instance and resumes from its coverage', () => {
      const checkpoint = baseCheckpoint({
        parserAppliedSeq: 5,
        surfaceCoverageSeq: 12,
        surfaceInstanceId: 'surface-a',
      })

      expect(canUseCheckpointForDeltaReplay(checkpoint, baseReplayInput({ surfaceInstanceId: 'surface-a' })))
        .toMatchObject({ ok: true, sinceSeq: 12 })
    })

    it('rejects a checkpoint saved by a DIFFERENT surface instance (remount/reload reuse)', () => {
      const checkpoint = baseCheckpoint({ surfaceInstanceId: 'surface-previous-mount' })

      expect(canUseCheckpointForDeltaReplay(checkpoint, baseReplayInput({ surfaceInstanceId: 'surface-new-mount' })))
        .toMatchObject({ ok: false, reason: 'surface_changed' })
    })

    it('clamps a storage-corrupted coverage below the applied position up to applied (N-1)', () => {
      // A well-formed but storage-corrupted entry with coverage < applied
      // must normalize its coverage UP to the applied position: resuming
      // from below applied would re-deliver bytes the surface already
      // rendered (duplicate content). In-memory invariants keep coverage
      // >= applied in every honest shape, so the clamp only heals the
      // corrupted one.
      const checkpoint = baseCheckpoint({ parserAppliedSeq: 42, surfaceCoverageSeq: 7 })

      expect(checkpoint.surfaceCoverageSeq).toBe(42)
      expect(canUseCheckpointForDeltaReplay(checkpoint, baseReplayInput()))
        .toMatchObject({ ok: true, sinceSeq: 42 })
    })
  })

  describe('identity/geometry rejection battery (each field change rejects)', () => {
    it.each([
      ['terminal_changed', { terminalId: 'term-other' }],
      ['stream_changed', { streamId: 'stream-other' }],
      ['stream_changed', { streamId: null }],
      ['server_changed', { serverInstanceId: 'server-b' }],
      ['server_changed', { serverBootId: 'boot-a' }],
      ['surface_changed', { surfaceEpoch: 3 }],
      ['surface_changed', { surfaceInstanceId: 'surface-other' }],
      ['geometry_changed', { cols: 100 }],
      ['geometry_changed', { rows: 30 }],
      ['geometry_changed', { geometryEpoch: 4 }],
      ['geometry_authority_unknown', { geometryAuthority: 'multi_client_unknown' }],
      ['geometry_authority_unknown', { geometryAuthority: 'server_stream' }],
      ['scrollback_changed', { scrollback: 9000 }],
      ['xterm_version_changed', { xtermVersion: '5.5.0' }],
      ['parser_busy', { parserIdle: false }],
    ])('rejects on %s', (reason, checkpointOverrides) => {
      const checkpoint = baseCheckpoint(checkpointOverrides)

      expect(canUseCheckpointForDeltaReplay(checkpoint, baseReplayInput()))
        .toMatchObject({ ok: false, reason })
    })
  })
})
