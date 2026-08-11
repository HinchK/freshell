/**
 * Pure reducer for Amplifier's `events.jsonl` lifecycle records.
 *
 * Implements the events-lane transition table of
 * docs/plans/2026-07-08-amplifier-session-durability-plan.md §6, restricted to
 * record inputs (PTY submit/output/exit and the submit-grace timer live in the
 * tracker; Phase 2). Imitates `opencode-ownership-reducer.ts`: no I/O, no
 * timers — `(state, record) -> { state, effects }`.
 *
 * Contract facts this encodes (plan §2):
 * - `prompt:submit` is the ONLY input that (re)enters busy (E2/E5).
 * - Turn-end boundary SET (2026-08-10 amendment): `prompt:complete` (E2/E3),
 *   `session:end` while busy (E7), and `orchestrator:complete` with a null
 *   `data.parent_id` (provider-error turns never write `prompt:complete`).
 *   The FIRST boundary record ends the turn; later ones land at idle and are
 *   ignored, which also makes orphan/duplicate turn-end records legal (E7/E3).
 * - `session:resume` never implies a phase change (E7).
 * - Transitions key on event TYPE only; timestamps are carried through for
 *   `at` fields but never used to order or gate transitions (E3).
 * - Schema gate: `amplifier.log`, major version 1 (E10); anything else
 *   degrades the lane once and the reducer goes inert.
 * - `session:fork` / `session:start` with a `parent_id` are subagent
 *   indicators (plan §2 last rows) — observed in state, never effects.
 */

export type AmplifierLifecyclePhase = 'idle' | 'busy'

export type AmplifierParsedRecord = {
  ts?: string
  lvl?: string
  schema?: { name?: string; ver?: string }
  event: string
  session_id?: string
  data?: {
    parent_id?: string | null
    raw?: Record<string, unknown>
    [key: string]: unknown
  } | null
  [key: string]: unknown
}

export type AmplifierReducerState = {
  phase: AmplifierLifecyclePhase
  /** Sticky: set by a schema-gate failure; the reducer ignores all further records. */
  degraded: boolean
  /** True once a subagent indicator was seen (`session:fork`, or `session:start` with `parent_id`). */
  subagent: boolean
  /** First `session_id` observed on any record. */
  sessionId?: string
}

export type AmplifierReducerEffect =
  | { kind: 'turn.began'; at?: string }
  | { kind: 'turn.completed'; at?: string }
  | { kind: 'session.identified'; sessionId?: string; cwd: string }
  | { kind: 'lane.degrade'; reason: AmplifierSchemaGateFailure }

export type AmplifierSchemaGateFailure =
  | 'schema_missing'
  | 'schema_name_mismatch'
  | 'schema_version_unsupported'

export type AmplifierReducerResult = {
  state: AmplifierReducerState
  effects: AmplifierReducerEffect[]
}

export const AMPLIFIER_LOG_SCHEMA_NAME = 'amplifier.log'
export const AMPLIFIER_LOG_SCHEMA_MAJOR = 1

export function createAmplifierReducerState(): AmplifierReducerState {
  return { phase: 'idle', degraded: false, subagent: false }
}

/**
 * Schema gate (plan §6, E10): accept `amplifier.log` major version 1;
 * anything else is a lane-degrade reason.
 */
export function checkAmplifierRecordSchema(
  record: AmplifierParsedRecord,
): AmplifierSchemaGateFailure | undefined {
  const schema = record.schema
  if (!schema || typeof schema !== 'object') return 'schema_missing'
  if (schema.name !== AMPLIFIER_LOG_SCHEMA_NAME) return 'schema_name_mismatch'
  const major = Number.parseInt(String(schema.ver ?? '').split('.')[0] ?? '', 10)
  if (!Number.isInteger(major) || major !== AMPLIFIER_LOG_SCHEMA_MAJOR) {
    return 'schema_version_unsupported'
  }
  return undefined
}

function isSubagentIndicator(record: AmplifierParsedRecord): boolean {
  if (record.event === 'session:fork') return true
  if (record.event === 'session:start') {
    const parentId = record.data?.parent_id
    return typeof parentId === 'string' && parentId.length > 0
  }
  return false
}

function sessionConfigCwd(record: AmplifierParsedRecord): string | undefined {
  const raw = record.data?.raw
  if (!raw || typeof raw !== 'object') return undefined
  const workingDir = raw.working_dir
  if (typeof workingDir === 'string' && workingDir.length > 0) return workingDir
  const projectDir = raw.project_dir
  if (typeof projectDir === 'string' && projectDir.length > 0) return projectDir
  return undefined
}

export function reduceAmplifierEvent(
  state: AmplifierReducerState,
  record: AmplifierParsedRecord,
): AmplifierReducerResult {
  if (state.degraded) {
    return { state, effects: [] }
  }

  const schemaFailure = checkAmplifierRecordSchema(record)
  if (schemaFailure) {
    return {
      state: { ...state, degraded: true },
      effects: [{ kind: 'lane.degrade', reason: schemaFailure }],
    }
  }

  let next = state
  if (!next.sessionId && typeof record.session_id === 'string' && record.session_id.length > 0) {
    next = { ...next, sessionId: record.session_id }
  }
  if (isSubagentIndicator(record) && !next.subagent) {
    next = { ...next, subagent: true }
  }

  switch (record.event) {
    case 'prompt:submit': {
      // The only input that (re)enters busy (E2/E5). busy -> busy is a
      // confirm, not a new turn: no duplicate turn.began.
      if (next.phase === 'busy') return { state: next, effects: [] }
      return {
        state: { ...next, phase: 'busy' },
        effects: [{ kind: 'turn.began', at: record.ts }],
      }
    }
    case 'prompt:complete':
    case 'session:end': {
      // Turn-end boundaries (E2/E3; session:end = turn ended by quit/hangup,
      // E7). At idle they are just more non-prompt:submit records: ignored
      // (orphan/duplicate session:end is legal — E7 continue-attach, E3
      // out-of-order tail).
      if (next.phase !== 'busy') return { state: next, effects: [] }
      return {
        state: { ...next, phase: 'idle' },
        effects: [{ kind: 'turn.completed', at: record.ts }],
      }
    }
    case 'orchestrator:complete': {
      // Turn-end boundary (2026-08-10 stuck-busy fix,
      // docs/plans/2026-08-10-amplifier-stuck-busy.md). On provider-error
      // turns the CLI writes `provider:error` then `orchestrator:complete`
      // and NEVER writes `prompt:complete` (verified against real session
      // logs: 27/27 error turns; the stuck session ended exactly there), so
      // without this case a pane stays busy forever. This is NOT a
      // fabricated completion (the deadman policy stands): it is a real,
      // unambiguous turn-end record written by the CLI itself.
      //
      // Exactly-once: on healthy turns `orchestrator:complete` precedes
      // `prompt:complete` (724/724 observed; structural in the CLI source —
      // the orchestrator always emits it before the app-cli can write
      // `prompt:complete`), so this record ends the turn and the later
      // `prompt:complete` lands at idle and is swallowed by the phase guard
      // below. Known accepted tradeoff: ~0.06% of observed turns (3/4,718,
      // full-corpus census) carry a stray mid-turn `orchestrator:complete`
      // that the turn recovers from — that now yields one early completion
      // instead of an eternally stuck-busy pane. No payload field (not even
      // `status`: observed strays were success×2 / error×1) distinguishes
      // the stray, so transitions still key on event TYPE only (E3): no
      // `status` gate.
      //
      // Sub-agent guard: delegated sub-agent sessions write their OWN
      // events.jsonl and root-file records always carry `data.parent_id`
      // null, so a non-null parent_id here can only be a sub-agent record —
      // it must never end the root session's turn (source-verified:
      // parent_id is session-scoped, stamped on every child-session record;
      // this guard is cheap defense-in-depth).
      if (typeof record.data?.parent_id === 'string' && record.data.parent_id.length > 0) {
        return { state: next, effects: [] }
      }
      if (next.phase !== 'busy') return { state: next, effects: [] }
      return {
        state: { ...next, phase: 'idle' },
        effects: [{ kind: 'turn.completed', at: record.ts }],
      }
    }
    case 'session:config': {
      const cwd = sessionConfigCwd(record)
      if (!cwd) return { state: next, effects: [] }
      return {
        state: next,
        effects: [{ kind: 'session.identified', sessionId: record.session_id, cwd }],
      }
    }
    case 'session:resume':
      // Resume does not imply busy; no phase change (E7).
      return { state: next, effects: [] }
    default:
      // Everything else (session:start, execution:*, provider:*, llm:*,
      // tool:*, content_block:*, cleanup:*, and orchestrator:* other than
      // orchestrator:complete, ...) never changes phase. Post-complete
      // background naming events are covered here (E2): never a new turn.
      return { state: next, effects: [] }
  }
}
