export type TerminalBufferType = 'normal' | 'alternate' | 'unknown'
export type TerminalGeometryAuthority = 'single_client' | 'server_stream' | 'multi_client_unknown'

export type TerminalSurfaceCheckpoint = {
  terminalId: string
  streamId: string | null
  serverInstanceId: string
  serverBootId?: string
  surfaceEpoch: number
  /**
   * Per-surface-instance discriminator (responsive-terminal-restore WS2,
   * reload contract): the id of the exact xterm surface instance that
   * rendered this checkpoint (mount-stable AND recreation-stable — a
   * remount or an in-mount renderer recreation mints a fresh instance id).
   * A same-pane REMOUNT re-enters with the same store key and a colliding
   * surface epoch (both mounts restart the epoch at 0), so the epoch alone
   * cannot tell the mounts apart; the instance id does. Validated on load
   * and merge-gated on save so a stale previous-mount entry can neither be
   * resumed past the new surface's rendered position nor poison the new
   * mount's saves. Absent on legacy entries persisted before the field
   * existed (an id-carrying caller rejects those — one honest full hydrate
   * after upgrade, then saves carry ids).
   */
  surfaceInstanceId?: string
  attachRequestId: string
  parserAppliedSeq: number
  /**
   * Surface-coverage cursor (responsive-terminal-restore WS1/WS2):
   * reconstruction-safe contiguous coverage of the stream on this surface —
   * applied frames AND fully-consumed null-screen-effect filtered frames
   * advance it; unknown mutations, lost ranges, and locally-unapplied
   * ranges pin it. Distinct from the strict `parserAppliedSeq`, which never
   * advances across a filtered or lost range. Optional for legacy
   * checkpoints persisted before the field existed (they resume from their
   * applied position).
   */
  surfaceCoverageSeq?: number
  cols: number
  rows: number
  geometryEpoch: number
  geometryAuthority: TerminalGeometryAuthority
  scrollback: number
  xtermVersion: string
  bufferType: TerminalBufferType
  parserIdle: boolean
}

export type CheckpointDeltaReplayInput = {
  terminalId: string
  streamId: string | null
  serverInstanceId: string
  serverBootId?: string
  surfaceEpoch: number
  /** The CURRENT surface instance's id — must match the checkpoint's (see
   * TerminalSurfaceCheckpoint.surfaceInstanceId). */
  surfaceInstanceId?: string
  cols: number
  rows: number
  geometryEpoch: number
  geometryAuthority: TerminalGeometryAuthority
  scrollback: number
  xtermVersion: string
  requireParserIdle: boolean
}

export type CheckpointDeltaReplayDecision =
  | { ok: true; sinceSeq: number }
  | {
      ok: false
      reason:
        | 'missing_checkpoint'
        | 'terminal_changed'
        | 'stream_changed'
        | 'server_changed'
        | 'surface_changed'
        | 'geometry_changed'
        | 'geometry_authority_unknown'
        | 'scrollback_changed'
        | 'xterm_version_changed'
        | 'parser_busy'
        | 'no_applied_sequence'
    }

function normalizeNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

/**
 * Normalized coverage position of a checkpoint. Zero coverage is "no
 * contiguous coverage information beyond the applied position" (e.g. a
 * rendered tail with a lost prefix): the resume position falls back to the
 * strict applied position, exactly the pre-cursor behavior. A POSITIVE
 * coverage is the reconstruction-safe resume position (it runs ahead of
 * applied past null-screen-effect filtered ranges).
 */
function coverageSeqOf(checkpoint: TerminalSurfaceCheckpoint): number {
  const coverage = checkpoint.surfaceCoverageSeq
  if (typeof coverage !== 'number' || !Number.isFinite(coverage) || coverage <= 0) {
    return checkpoint.parserAppliedSeq
  }
  return Math.floor(coverage)
}

function normalizeCheckpoint(input: TerminalSurfaceCheckpoint): TerminalSurfaceCheckpoint {
  const parserAppliedSeq = normalizeNonNegativeInteger(input.parserAppliedSeq)
  const surfaceCoverageSeq = input.surfaceCoverageSeq
  return {
    ...input,
    streamId: input.streamId ?? null,
    surfaceEpoch: normalizeNonNegativeInteger(input.surfaceEpoch),
    parserAppliedSeq,
    // Coverage is normalized against the applied position: absent → the
    // applied position (legacy resume behavior); present → clamped to ≥ 0
    // and UP to the applied position (N-1) — an honest shape always has
    // coverage ≥ applied (applied bytes are rendered bytes), so the clamp
    // only heals a storage-corrupted entry and never moves a real cursor.
    // It is intentionally NOT clamped down to parserAppliedSeq — the
    // coverage cursor legitimately runs AHEAD of applied past
    // null-screen-effect filtered ranges.
    surfaceCoverageSeq: typeof surfaceCoverageSeq === 'number' && Number.isFinite(surfaceCoverageSeq)
      ? Math.max(parserAppliedSeq, Math.floor(surfaceCoverageSeq))
      : parserAppliedSeq,
    cols: normalizeNonNegativeInteger(input.cols),
    rows: normalizeNonNegativeInteger(input.rows),
    geometryEpoch: normalizeNonNegativeInteger(input.geometryEpoch),
    scrollback: normalizeNonNegativeInteger(input.scrollback),
  }
}

function normalizeReplayInput(input: CheckpointDeltaReplayInput): CheckpointDeltaReplayInput {
  return {
    ...input,
    streamId: input.streamId ?? null,
    surfaceEpoch: normalizeNonNegativeInteger(input.surfaceEpoch),
    cols: normalizeNonNegativeInteger(input.cols),
    rows: normalizeNonNegativeInteger(input.rows),
    geometryEpoch: normalizeNonNegativeInteger(input.geometryEpoch),
    scrollback: normalizeNonNegativeInteger(input.scrollback),
  }
}

export function createTerminalSurfaceCheckpoint(
  input: TerminalSurfaceCheckpoint,
): TerminalSurfaceCheckpoint {
  return normalizeCheckpoint(input)
}

export function canUseCheckpointForDeltaReplay(
  checkpoint: TerminalSurfaceCheckpoint | null | undefined,
  input: CheckpointDeltaReplayInput,
): CheckpointDeltaReplayDecision {
  if (!checkpoint) return { ok: false, reason: 'missing_checkpoint' }

  const current = normalizeReplayInput(input)
  const saved = normalizeCheckpoint(checkpoint)

  if (saved.terminalId !== current.terminalId) {
    return { ok: false, reason: 'terminal_changed' }
  }
  // Stream identity is required for v2 delta replay. A missing/null stream id
  // is a protocol failure, not a compatible legacy identity.
  if (!saved.streamId || !current.streamId) {
    return { ok: false, reason: 'stream_changed' }
  }
  if (saved.streamId !== current.streamId) {
    return { ok: false, reason: 'stream_changed' }
  }
  if (
    saved.serverInstanceId !== current.serverInstanceId
    || (saved.serverBootId ?? null) !== (current.serverBootId ?? null)
  ) {
    return { ok: false, reason: 'server_changed' }
  }
  if (saved.surfaceEpoch !== current.surfaceEpoch) {
    return { ok: false, reason: 'surface_changed' }
  }
  // Surface-instance discriminator (WS2 reload contract): a checkpoint from
  // a different surface instance (page reload / pane remount / renderer
  // recreation) never resumes onto this surface — its claimed progress
  // describes bytes this surface never rendered.
  if ((saved.surfaceInstanceId ?? null) !== (current.surfaceInstanceId ?? null)) {
    return { ok: false, reason: 'surface_changed' }
  }
  if (
    saved.cols !== current.cols
    || saved.rows !== current.rows
    || saved.geometryEpoch !== current.geometryEpoch
  ) {
    return { ok: false, reason: 'geometry_changed' }
  }
  if (
    saved.geometryAuthority === 'multi_client_unknown'
    || current.geometryAuthority === 'multi_client_unknown'
    || saved.geometryAuthority !== current.geometryAuthority
  ) {
    return { ok: false, reason: 'geometry_authority_unknown' }
  }
  if (saved.scrollback !== current.scrollback) {
    return { ok: false, reason: 'scrollback_changed' }
  }
  if (saved.xtermVersion !== current.xtermVersion) {
    return { ok: false, reason: 'xterm_version_changed' }
  }
  if (current.requireParserIdle && !saved.parserIdle) {
    return { ok: false, reason: 'parser_busy' }
  }
  // Eligibility is fulfilled by the COVERAGE cursor (`no_applied_sequence`'s
  // role: never resume a surface from nothing). The strict applied check's
  // integrity role is preserved by the both-zero rejection below: applied>0
  // alone remains a legacy fallback position, and coverage>0 with applied=0
  // is a legitimately covered surface (a filtered prefix renders nothing but
  // is fully accounted).
  if (saved.parserAppliedSeq <= 0 && coverageSeqOf(saved) <= 0) {
    return { ok: false, reason: 'no_applied_sequence' }
  }

  // Delta resumes request their since position from the COVERAGE cursor —
  // never from the strict applied position a filter pinned below
  // already-rendered content.
  return { ok: true, sinceSeq: coverageSeqOf(saved) }
}
