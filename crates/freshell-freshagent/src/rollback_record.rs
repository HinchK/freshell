//! Kata 1wxv Task 1: the durable rollback record (`RollbackRecord`), rollback
//! request normalization (`RollbackRequest`), pinned refusal/notice copy, and
//! the three rollback frame builders (requesting-sink error, requesting-sink
//! ack, broadcast). The pane ledger stores these rows payload-OPAQUE; the
//! schema lives here (see `docs/plans/2026-08-22-freshagent-undo-redo.md` —
//! "Durable rollback record").

use freshell_protocol::{
    AgentProvider, FreshAgentEvent, FreshAgentRedo, FreshAgentUndo, RollbackMode, ServerMessage,
    SessionType,
};
use serde_json::{json, Value};

/// Schema version gate for stored rollback rows: a row written with any other
/// version answers `None` from `PaneIdentitySink::load_rollback` (never
/// silently reinterpreted — the pane-ledger LEDGER_VERSION precedent).
pub const ROLLBACK_RECORD_VERSION: u32 = 1;

/// Server `BUSY_TURN` copy, shared by all providers.
pub const ROLLBACK_BUSY_MESSAGE: &str = "Rollback is not supported while a turn is running — queue a steer message or wait for the turn to finish.";
/// Client-visible `REDO_UNAVAILABLE` copy: a submission after the undo
/// permanently retired redo (decision 5).
pub const REDO_DESTROYED_MESSAGE: &str =
    "Redo is no longer available — a message submitted after the undo permanently retired it.";
pub const REDO_EMPTY_MESSAGE: &str = "Nothing to redo.";
pub const UNDO_EMPTY_MESSAGE: &str = "Nothing to roll back.";
/// Server `INTERNAL_ERROR` copy for a rollback-record PRE-WRITE failure — the
/// provider history is NEVER mutated on this path (durable-BEFORE-mutation).
pub const LEDGER_WRITE_REFUSAL_COPY: &str =
    "Undo is unavailable right now — the rollback record could not be saved. Try again.";
/// Server `UNSUPPORTED_CAPABILITY` copy when the codex app-server pre-dates
/// `thread/revert` (unknown-method/`-32601` or a missing method shape).
pub const CODEX_OLD_CLI_COPY: &str = "Rollback requires a newer Codex CLI (codex ≥0.149). Check the freshcodex sidecar logs for the exact error.";
/// Server `UNSUPPORTED_CAPABILITY` copy when the opencode serve pre-dates the
/// revert/unrevert routes (404/unknown route).
pub const OPENCODE_OLD_CLI_COPY: &str = "Rollback requires a newer OpenCode CLI (opencode ≥1.18). Check the serve logs for the exact error.";
/// Server `UNSUPPORTED_CAPABILITY` copy when the codex thread predates this
/// feature (LBC-1): `thread/revert` refuses legacy threads
/// (`-32600 "only supports paginated threads"`).
pub const CODEX_LEGACY_THREAD_COPY: &str =
    "Undo is unavailable for this session — it was started before conversation rollback support (codex threads created earlier use the legacy history format). Start a new session to undo.";
/// Server `REDO_UNAVAILABLE` copy when the claude chain-root original's
/// transcript moved since the undo (tip/LCP validity contract).
pub const REDO_REMOVED_HISTORY_COPY: &str =
    "Redo is no longer available — the original conversation's history changed since the undo.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RollbackDirection {
    Undo,
    Redo,
}

/// The REQUEST-level mode (server-resolved): a frame with `mode` absent
/// means `Step` (the zod/serde schema carries the raw `Option`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RollbackModeReq {
    Step,
    ToTurn,
}

/// Wall-clock ms — every op (rollback, redo, destroy) stamps
/// `last_op_at_ms`/`at_ms` with it (the record doubles as the snapshot
/// revision floor).
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The normalized rollback operation the provider handlers consume —
/// direction resolved, mode defaulted, request id carried through to the
/// requesting-sink frames.
#[derive(Debug, Clone, PartialEq)]
pub struct RollbackRequest {
    pub direction: RollbackDirection,
    pub mode: RollbackModeReq,
    pub turn_id: Option<String>,
    pub session_id: String,
    pub session_type: SessionType,
    pub provider: AgentProvider,
    pub request_id: String,
    pub cwd: Option<String>,
}

fn request_mode(mode: Option<RollbackMode>) -> RollbackModeReq {
    match mode {
        Some(RollbackMode::ToTurn) => RollbackModeReq::ToTurn,
        Some(RollbackMode::Step) | None => RollbackModeReq::Step,
    }
}

impl RollbackRequest {
    pub fn from_undo(m: FreshAgentUndo) -> Self {
        Self {
            direction: RollbackDirection::Undo,
            mode: request_mode(m.mode),
            turn_id: m.turn_id,
            session_id: m.session_id,
            session_type: m.session_type,
            provider: m.provider,
            request_id: m.request_id,
            cwd: m.cwd,
        }
    }

    pub fn from_redo(m: FreshAgentRedo) -> Self {
        Self {
            direction: RollbackDirection::Redo,
            mode: request_mode(m.mode),
            turn_id: m.turn_id,
            session_id: m.session_id,
            session_type: m.session_type,
            provider: m.provider,
            request_id: m.request_id,
            cwd: m.cwd,
        }
    }
}

/// One rollback op's marker payload: the removed display turns (verbatim
/// `FreshAgentTurn` JSON — `rolledBack` is stamped at READ time, not stored)
/// plus the composer-refill prompt.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackEntry {
    pub removed_turns: Vec<Value>,
    /// Plain text of the first removed USER turn — the composer-refill payload.
    pub prompt_text: String,
    pub at_ms: i64,
}

/// The durable record (decision 10's record), keyed `(provider, sessionId)`.
/// `entries` is the UNION of every epoch's rolled-back turns (frozen
/// prior-epoch markers first, in original conversation order); it is NEVER
/// dropped by an epoch reset, a send, or `destroy_redo`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackRecord {
    pub version: u32,
    /// Revision floor (wall-clock ms of the last rollback op).
    pub last_op_at_ms: i64,
    /// Any new submission (send/steer/queue firing) sets this: redo
    /// permanently dies (decision 5), the marker bucket survives (decision 6).
    pub redo_destroyed: bool,
    /// Redo availability STAMPED AT WRITE TIME by the provider handler —
    /// never derived at read (stored at write time; never entries-derived).
    pub can_redo: bool,
    /// Claude fork-chain root (the session retaining full history). None for
    /// codex/opencode.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_session_id: Option<String>,
    /// Claude redo-validity anchor: the raw-chain tip uuid of the ORIGINAL
    /// transcript recorded at undo time. None for codex/opencode and for a
    /// fresh record.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_tip_uuid: Option<String>,
    /// Removed display turns as verbatim FreshAgentTurn JSON.
    pub entries: Vec<RollbackEntry>,
}

impl RollbackRecord {
    pub fn empty(now_ms: i64) -> Self {
        Self {
            version: ROLLBACK_RECORD_VERSION,
            last_op_at_ms: now_ms,
            redo_destroyed: false,
            can_redo: false,
            original_session_id: None,
            original_tip_uuid: None,
            entries: Vec::new(),
        }
    }

    /// The STORED bit only — never entries-derived (claude keeps entries
    /// empty by design).
    pub fn can_redo(&self) -> bool {
        self.can_redo
    }

    /// Stamps the stored bit + lifts last_op_at_ms. Provider handlers compute
    /// the value per the record semantics and write it at op time.
    pub fn set_can_redo(&mut self, value: bool, now_ms: i64) {
        self.can_redo = value;
        self.last_op_at_ms = now_ms;
    }

    /// Decision 5: sets redo_destroyed AND clears the stored can_redo bit;
    /// markers survive.
    pub fn destroy_redo(&mut self, now_ms: i64) {
        self.redo_destroyed = true;
        self.can_redo = false;
        self.last_op_at_ms = now_ms;
    }

    /// Appends this op's removed-turn slice (the marker-union rule — frozen
    /// prior-epoch markers precede the current epoch's, both in conversation
    /// order) + lifts last_op_at_ms.
    pub fn push_entry(&mut self, entry: RollbackEntry, now_ms: i64) {
        self.entries.push(entry);
        self.last_op_at_ms = now_ms;
    }
}

// The envelope stamp helpers — `agent_provider_wire`/`session_type_wire` in
// the ws crate are not visible here; the enums' lowercase serde names are the
// wire strings, restated once (they are frozen-contract strings).
fn agent_provider_wire(provider: AgentProvider) -> &'static str {
    match provider {
        AgentProvider::Claude => "claude",
        AgentProvider::Codex => "codex",
        AgentProvider::Opencode => "opencode",
        AgentProvider::Amplifier => "amplifier",
    }
}

fn session_type_wire(session_type: SessionType) -> &'static str {
    match session_type {
        SessionType::Freshclaude => "freshclaude",
        SessionType::Freshcodex => "freshcodex",
        SessionType::Kilroy => "kilroy",
        SessionType::Freshopencode => "freshopencode",
    }
}

/// The shared `freshAgent.event` envelope: `event` rides opaquely inside;
/// top-level provider/sessionType/sessionId are the locator the client
/// requires (the codex `emit_fresh_agent_error` precedent).
fn rollback_envelope(op: &RollbackRequest, live_session_id: &str, event: Value) -> ServerMessage {
    ServerMessage::FreshAgentEvent(FreshAgentEvent {
        event,
        provider: agent_provider_wire(op.provider).to_string(),
        session_id: live_session_id.to_string(),
        session_type: session_type_wire(op.session_type).to_string(),
    })
}

/// `freshAgent.event{freshAgent.error{code,message,requestId,rollback:true}}`
/// stamped from `op`. The `rollback:true` stamp routes the client to the
/// notice channel, not the pane error surface.
pub fn rollback_error_frame(op: &RollbackRequest, code: &str, message: &str) -> ServerMessage {
    rollback_envelope(
        op,
        &op.session_id,
        json!({
            "type": "freshAgent.error",
            "sessionId": op.session_id,
            "code": code,
            "message": message,
            "requestId": op.request_id,
            "rollback": true,
        }),
    )
}

/// Requesting-sink ack (only the initiating pane's connection):
/// `freshAgent.rolledBack` (undo) / `freshAgent.redone` (redo), carrying the
/// removed prompt for the composer refill (broadcasts never carry it, so
/// other devices' composers are untouched).
pub fn rollback_ack_frame(
    op: &RollbackRequest,
    live_session_id: &str,
    removed_prompt_text: Option<&str>,
    removed_turn_ids: &[String],
    can_redo: bool,
    new_session_id: Option<&str>,
) -> ServerMessage {
    let mut event = match op.direction {
        RollbackDirection::Undo => json!({
            "type": "freshAgent.rolledBack",
            "requestId": op.request_id,
            "sessionId": live_session_id,
            "direction": "undo",
            "mode": match op.mode {
                RollbackModeReq::Step => "step",
                RollbackModeReq::ToTurn => "toTurn",
            },
            "removedTurnIds": removed_turn_ids,
            "canRedo": can_redo,
        }),
        RollbackDirection::Redo => {
            let mut event = json!({
                "type": "freshAgent.redone",
                "requestId": op.request_id,
                "sessionId": live_session_id,
                "direction": "redo",
                "canRedo": can_redo,
            });
            if let Some(last) = removed_turn_ids.last() {
                event["restoredThroughTurnId"] = json!(last);
            }
            event
        }
    };
    if let RollbackDirection::Undo = op.direction {
        if let Some(prompt) = removed_prompt_text {
            event["removedPromptText"] = json!(prompt);
        }
    }
    if let Some(new_session_id) = new_session_id {
        event["newSessionId"] = json!(new_session_id);
    }
    rollback_envelope(op, live_session_id, event)
}

/// Broadcast (every connection incl. the requester; converges sibling clients
/// per decision 10; carries no prompt text so other devices' composers are
/// untouched). Undo additionally carries `revokeAttention:true` (attention
/// revoke for undone turns only, never chimes).
pub fn rollback_broadcast_frame(
    op: &RollbackRequest,
    live_session_id: &str,
    removed_turn_ids: &[String],
    can_redo: bool,
) -> ServerMessage {
    let event = match op.direction {
        RollbackDirection::Undo => json!({
            "type": "freshAgent.session.rolledBack",
            "sessionId": live_session_id,
            "removedTurnIds": removed_turn_ids,
            "canRedo": can_redo,
            "revokeAttention": true,
        }),
        RollbackDirection::Redo => {
            let mut event = json!({
                "type": "freshAgent.session.redone",
                "sessionId": live_session_id,
                "canRedo": can_redo,
            });
            if let Some(last) = removed_turn_ids.last() {
                event["restoredThroughTurnId"] = json!(last);
            }
            event
        }
    };
    rollback_envelope(op, live_session_id, event)
}

/// Decision 5: any new submission (send/steer/queue firing) permanently
/// destroys redo — the redo-capable CHAIN STATE only; `entries` (the r3 marker
/// union) is NEVER touched and survives with the "rolled back" marker per
/// decision 6. AWAITED before the prompt goes out. A write failure is
/// returned — callers `tracing::warn!` it but never block the send and never
/// emit a user-facing event (providers degrade gracefully: opencode natively
/// deletes the reverted tail on send; claude's redo path re-validates the
/// recorded tip). No-op returns when there is no record, nothing redo-capable
/// to destroy, or redo is already destroyed.
pub async fn destroy_redo_on_submit(
    sink: &Option<crate::identity_sink::SharedPaneIdentitySink>,
    provider: &str,
    live_id: &str,
    now_ms: i64,
) -> Option<std::io::Error> {
    let sink = sink.as_ref()?;
    let mut record = sink.load_rollback(provider, live_id)?;
    if record.redo_destroyed || (record.entries.is_empty() && record.original_session_id.is_none())
    {
        return None;
    }
    record.destroy_redo(now_ms); // sets redo_destroyed + clears can_redo; entries untouched (r3)
    sink.record_rollback(provider, live_id, record).await.err()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity_sink::PaneIdentitySink;

    fn entry(id_suffix: &str) -> RollbackEntry {
        RollbackEntry {
            removed_turns: vec![
                serde_json::json!({ "id": format!("t{id_suffix}"), "turnId": format!("t{id_suffix}"), "summary": "s", "items": [] }),
            ],
            prompt_text: format!("prompt{id_suffix}"),
            at_ms: 100,
        }
    }

    #[test]
    fn can_redo_is_a_stored_bit_and_destroy_aware() {
        let mut record = RollbackRecord::empty(50);
        assert!(!record.can_redo(), "a fresh record has nothing to redo");
        record.set_can_redo(true, 60);
        assert!(
            record.can_redo(),
            "the provider-stamped bit is the only source (stored at write time; never entries-derived)"
        );
        record.destroy_redo(70);
        assert!(!record.can_redo(), "destroyed redo never revives");
        assert!(!record.can_redo, "destroy also clears the stored bit");
        assert_eq!(
            record.last_op_at_ms, 70,
            "every op lifts the revision floor"
        );
    }

    #[test]
    fn record_round_trips_through_json() {
        let mut record = RollbackRecord::empty(50);
        record.original_session_id = Some("orig-uuid".into());
        record.original_tip_uuid = Some("tip-uuid".into());
        record.push_entry(entry("1"), 60);
        record.set_can_redo(true, 61);
        let v = serde_json::to_value(&record).expect("serialize");
        let back: RollbackRecord = serde_json::from_value(v).expect("deserialize");
        assert_eq!(record, back);
    }

    // ── destroy_redo_on_submit (kata 1wxv decision 5) ───────────────────────

    fn fake_sink_with(
        provider: &str,
        session_id: &str,
        record: RollbackRecord,
    ) -> std::sync::Arc<crate::identity_sink::FakeIdentitySink> {
        let sink = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        sink.rollbacks
            .lock()
            .unwrap()
            .insert((provider.to_string(), session_id.to_string()), record);
        sink
    }

    #[tokio::test]
    async fn destroy_redo_on_submit_marks_redo_destroyed_and_keeps_the_markers() {
        let sink = fake_sink_with("codex", "s1", {
            let mut r = RollbackRecord::empty(50);
            r.push_entry(entry("1"), 60);
            r.set_can_redo(true, 61);
            r
        });
        let shared: crate::identity_sink::SharedPaneIdentitySink = sink.clone();
        let outcome = destroy_redo_on_submit(&Some(shared), "codex", "s1", 100).await;
        assert!(
            outcome.is_none(),
            "a live write answers no error: {outcome:?}"
        );
        let record = sink.load_rollback("codex", "s1").expect("record survives");
        assert!(
            record.redo_destroyed,
            "decision 5: the submission killed redo"
        );
        assert!(
            !record.can_redo(),
            "destroy also clears the stored can_redo bit"
        );
        assert_eq!(
            record.last_op_at_ms, 100,
            "the destroy lifts the revision floor"
        );
        assert_eq!(
            record.entries.len(),
            1,
            "decision 6: the r3 marker union is NEVER touched by a destroy"
        );
    }

    #[tokio::test]
    async fn destroy_redo_on_submit_is_a_no_op_without_a_record_or_with_nothing_to_destroy() {
        let sink = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        let shared: crate::identity_sink::SharedPaneIdentitySink = sink.clone();
        let outcome = destroy_redo_on_submit(&Some(shared), "codex", "s-absent", 100).await;
        assert!(outcome.is_none());
        assert!(
            sink.rollbacks.lock().unwrap().is_empty(),
            "no phantom rollback row is written for a session that never rolled back"
        );

        // An empty FRESH record (e.g. claude pre-first-undo shape) is also a no-op.
        let sink = fake_sink_with("codex", "s-empty", RollbackRecord::empty(50));
        let shared: crate::identity_sink::SharedPaneIdentitySink = sink.clone();
        let outcome = destroy_redo_on_submit(&Some(shared), "codex", "s-empty", 100).await;
        assert!(outcome.is_none());
        let record = sink.load_rollback("codex", "s-empty").expect("record");
        assert!(!record.redo_destroyed, "nothing to destroy — untouched");
        assert_eq!(record.last_op_at_ms, 50, "a no-op lifts nothing");
    }

    #[tokio::test]
    async fn destroy_redo_on_submit_is_idempotent_once_destroyed() {
        let sink = fake_sink_with("codex", "s2", {
            let mut r = RollbackRecord::empty(50);
            r.push_entry(entry("1"), 60);
            r.destroy_redo(70);
            r
        });
        let shared: crate::identity_sink::SharedPaneIdentitySink = sink.clone();
        let outcome = destroy_redo_on_submit(&Some(shared), "codex", "s2", 100).await;
        assert!(outcome.is_none());
        let record = sink.load_rollback("codex", "s2").expect("record");
        assert!(
            record.redo_destroyed && record.last_op_at_ms == 70,
            "a second destroy is a true no-op (no rewrite, no restamp)"
        );
    }
}
