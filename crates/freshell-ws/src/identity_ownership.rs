//! b8ke ext r11 F1: the coordinator step for terminal identities learned
//! AFTER process creation. Four lanes adopt or rebind a live terminal's
//! canonical session id without touching the coordinator — the codex
//! locator adoption (`codex_identity::adopt_codex_identity`), the codex
//! fork rebind (`codex_identity::rebind_codex_identity`), the opencode
//! locator adoption (`opencode_association::drain_and_associate`), and the
//! opencode/claude SessionStart signal rebinds (`apply_opencode_signal` /
//! `apply_claude_signal`). Pre-r11 those paths only updated the identity
//! homes, so the REAL terminal writer ran while the canonical coordinator
//! key was VACANT (a later Fresh Agent lifecycle op saw no prior owner and
//! could not stop-and-confirm-reap it), and a rebind left the OLD key
//! live under the moved writer.
//!
//! Every lane now routes through [`coordinator_commit_identity`] — the
//! ext-r6 learned-identity discipline applied at the association boundary:
//! claim `Live{Terminal}` under the learned canonical key through the
//! shared coordinator (an idempotent Adopt of THIS terminal's own live
//! owner proceeds; every other outcome — a foreign owner, a competing
//! fresh-agent owner, or an in-flight lifecycle transition — refuses
//! typed, fail-closed, and NOTHING mutates), commit under the terminal
//! registry's own `commit_session_ref_ownership` (which also stamps the
//! retained claim + verifies the row is still Running — the ext-r9 F2
//! liveness contract), broadcast the authoritative owner frame
//! (`handoff-committed`, the adopt-commits-Live shape), and on a REBIND
//! release the superseded old key in the SAME step (`released` under the
//! old key — never a stale-live old key after the writer moved).

use crate::terminal::now_ms;
use crate::WsState;
use freshell_protocol::ServerMessage;

/// Claim + commit `Live{Terminal}` for a terminal's learned canonical
/// session id. `previous_session_id: Some(old)` marks a REBIND — the old
/// canonical key is released in the same step. Returns `true` when the
/// identity move may proceed (the key is ours); `false` refuses the whole
/// adoption/rebind BEFORE any identity home mutates (fail-closed — the
/// caller's guards already ran; this is the coordinator authority).
pub(crate) async fn coordinator_commit_identity(
    state: &WsState,
    provider: &str,
    terminal_id: &str,
    session_id: &str,
    previous_session_id: Option<&str>,
) -> bool {
    let Some(ownership) = state.ownership.as_ref() else {
        return true;
    };
    let is_rebind = previous_session_id.is_some();
    let operation_id = if is_rebind {
        format!("assoc-rebind-{terminal_id}")
    } else {
        format!("assoc-adopt-{terminal_id}")
    };
    let initiator = if is_rebind {
        "ws-identity-association/rebind"
    } else {
        "ws-identity-association/adopt"
    };
    let mut ticket = match freshell_freshagent::ownership_lane::begin_terminal_lane_claim(
        &state.ownership,
        provider,
        session_id,
        &operation_id,
        // No observed fence: the association lane holds no prior wire
        // observation for the learned id (it did not come from a create).
        None,
        initiator,
        now_ms().max(0) as u64,
    ) {
        freshell_freshagent::ownership_lane::TerminalLaneClaim::Granted(ticket) => Some(ticket),
        // Unwired is unreachable here (the ownership Option was Some) —
        // treat it as the legacy no-op allow.
        freshell_freshagent::ownership_lane::TerminalLaneClaim::Unwired => None,
        freshell_freshagent::ownership_lane::TerminalLaneClaim::Adopt => {
            // The coordinator already holds a live same-kind owner. THIS
            // terminal re-adopting its own live record is the idempotent
            // allow (nothing to commit — the record already names this
            // terminal); any other live owner refuses fail-closed (the
            // caller's identity guards should have caught it; the
            // coordinator is the authority).
            let snapshot = ownership.observe(provider, session_id);
            match &snapshot.state {
                freshell_ownership::OwnershipState::Live { owner, .. }
                    if owner.kind == freshell_ownership::RuntimeOwnerKind::Terminal
                        && owner.terminal_id.as_deref() == Some(terminal_id) =>
                {
                    None
                }
                other => {
                    tracing::warn!(target: "freshell_ws::identity_ownership",
                        provider = %provider, session_id = %session_id,
                        terminal_id = %terminal_id, state = ?other,
                        "identity_association_refused: the canonical key already \\
                         has a live owner — the adoption/rebind mutates nothing"
                    );
                    return false;
                }
            }
        }
        freshell_freshagent::ownership_lane::TerminalLaneClaim::Refused(outcome) => {
            tracing::warn!(target: "freshell_ws::identity_ownership",
                provider = %provider, session_id = %session_id,
                terminal_id = %terminal_id, outcome = ?outcome,
                "identity_association_refused: the ownership coordinator refused \\
                 the identity claim — the adoption/rebind mutates nothing"
            );
            return false;
        }
    };

    // The commit: the registry's own API (the retained claim + the ext-r9
    // commit-time liveness check live there; the association lanes gate on
    // a Running row, so the check passes).
    let locator = freshell_protocol::SessionLocator {
        provider: provider.to_string(),
        session_id: session_id.to_string(),
    };
    let committed = match ticket.as_mut() {
        // The Adopt idempotent arm: the record already names this terminal.
        None => true,
        Some(ticket) => {
            let outcome = state.registry.commit_session_ref_ownership(
                &locator,
                ticket.operation_id(),
                ticket.generation(),
                terminal_id,
            );
            match outcome {
                freshell_ownership::CommitOutcome::Committed => {
                    ticket.disarm();
                    true
                }
                stale => {
                    tracing::error!(target: "invariant",
                        provider = %provider, session_id = %session_id,
                        terminal_id = %terminal_id, stale = ?stale,
                        "identity_association_commit_stale: the coordinator moved on \\
                         while the learned identity committed — the adoption/rebind \\
                         mutates nothing"
                    );
                    return false;
                }
            }
        }
    };
    debug_assert!(committed, "a disarmed/adopted commit is always committed");

    // THE AUTHORITATIVE OWNER FRAME (the adopt-commits-Live shape): the
    // committed terminal owner under the canonical key, so every device
    // holding a matching sessionRef pane folds the new owner.
    let snapshot = ownership.observe(provider, session_id);
    let generation = snapshot.generation;
    broadcast_owner_frame(
        state,
        provider,
        session_id,
        terminal_id,
        &operation_id,
        generation,
        "handoff-committed",
    );

    // The REBIND's old-key release — the SAME step as the move, never a
    // stale-live old key after the writer moved. The old record must name
    // THIS terminal (Guard 1 confirmed the registry ownership); a record
    // naming anything else is a pre-existing mismatch this lane does not
    // own — log and leave it (the release claim discipline).
    if let Some(old_session_id) = previous_session_id {
        if old_session_id != session_id {
            let old_snapshot = ownership.observe(provider, old_session_id);
            match &old_snapshot.state {
                freshell_ownership::OwnershipState::Live {
                    owner, generation, ..
                } if owner.kind == freshell_ownership::RuntimeOwnerKind::Terminal
                    && owner.terminal_id.as_deref() == Some(terminal_id) =>
                {
                    let claim = freshell_ownership::ReleaseClaim {
                        operation_id: owner
                            .ownership_id
                            .clone()
                            .unwrap_or_else(|| operation_id.clone()),
                        generation: *generation,
                        runtime: Some(owner.clone()),
                    };
                    let released = ownership.release(provider, old_session_id, &claim, initiator);
                    tracing::info!(target: "freshell_ws::identity_ownership",
                        provider = %provider, old_session_id = %old_session_id,
                        new_session_id = %session_id, terminal_id = %terminal_id,
                        released = ?released,
                        "identity_rebind_old_key_released: the superseded canonical \\
                         key released in the same step as the move"
                    );
                    broadcast_owner_frame(
                        state,
                        provider,
                        old_session_id,
                        terminal_id,
                        &operation_id,
                        *generation,
                        "released",
                    );
                }
                other => {
                    tracing::warn!(target: "freshell_ws::identity_ownership",
                        provider = %provider, old_session_id = %old_session_id,
                        terminal_id = %terminal_id, state = ?other,
                        "identity_rebind_old_key_mismatch: the old canonical key's \\
                         record does not name this terminal — left untouched"
                    );
                }
            }
        }
    }
    true
}

/// The owner frame broadcast (the `broadcast_owner` shape the handoff
/// runner uses, adapted to the WS state's broadcast bus).
fn broadcast_owner_frame(
    state: &WsState,
    provider: &str,
    session_id: &str,
    terminal_id: &str,
    operation_id: &str,
    generation: u64,
    transition: &str,
) {
    let Some(ownership) = state.ownership.as_ref() else {
        return;
    };
    let frame = serde_json::to_string(&ServerMessage::SessionRuntimeOwner(
        freshell_protocol::SessionRuntimeOwner {
            provider: provider.to_string(),
            session_id: session_id.to_string(),
            epoch: ownership.boot_epoch(),
            generation,
            owner_kind: "terminal".into(),
            previous_kind: None,
            terminal_id: Some(terminal_id.to_string()),
            operation_id: operation_id.to_string(),
            transition: transition.to_string(),
            reason: None,
            fenced: None,
            alias_of: None,
        },
    ))
    .unwrap_or_default();
    let _ = state.broadcast_tx.send(frame);
}

/// The Adopt-outcome helper for tests: whether the coordinator holds a live
/// terminal owner for the id naming THIS terminal.
#[cfg(test)]
pub(crate) fn holds_live_terminal_owner(
    ownership: &std::sync::Arc<freshell_ownership::RuntimeOwnershipRegistry>,
    provider: &str,
    session_id: &str,
    terminal_id: &str,
) -> bool {
    match ownership.observe(provider, session_id).state {
        freshell_ownership::OwnershipState::Live { owner, .. } => {
            owner.kind == freshell_ownership::RuntimeOwnerKind::Terminal
                && owner.terminal_id.as_deref() == Some(terminal_id)
        }
        _ => false,
    }
}
