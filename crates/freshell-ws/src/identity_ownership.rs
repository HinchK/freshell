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

/// b8ke ext r14 F1: the held authority for an identity adoption/rebind —
/// the claim phase's artifact, carried across the caller's identity
/// registry / terminal-metadata / awaited durable pane-ledger writes and
/// consumed by the commit phase (or dropped by the fail phase — a binding
/// failure unwinds with NO committed owner).
pub(crate) enum IdentityAuthority {
    /// A Granted `Starting` ticket on the (new) canonical key — the
    /// adoption's claim from a non-Live key; the commit commits it Live.
    Ticket(freshell_ownership::OperationTicket),
    /// A live same-kind incumbent re-adopt (the key already names THIS
    /// terminal): the ext-r12 attach guard holds the window across the
    /// caller's writes — a handoff or stop begin inside answers the typed
    /// Blocked outcome.
    AdoptGuard(freshell_ownership::AttachGuard),
    /// A REBIND whose new key granted a Starting ticket, with the OLD
    /// key's Live record guarded through the window (the atomic commit
    /// rekeys old→new).
    RebindTicket {
        ticket: freshell_ownership::OperationTicket,
        old_key_guard: freshell_ownership::AttachGuard,
    },
    /// A REBIND whose new key already names this terminal (the idempotent
    /// re-adopt), with the OLD key guarded through the window.
    RebindAdopt {
        adopt_guard: freshell_ownership::AttachGuard,
        old_key_guard: freshell_ownership::AttachGuard,
    },
    /// No coordinator wired: the legacy proceed (nothing to commit).
    Unwired,
}

/// b8ke ext r14 F1: the CLAIM phase — the association lane's coordinator
/// authority is acquired BEFORE any identity home mutates and held across
/// the caller's registry/metadata/durable-binding writes (the ext-r11
/// order committed Live and broadcast FIRST, so a handoff could acquire
/// the supposedly-complete owner, reap it, and install another writer
/// while the association task kept writing stale bindings, and a durable
/// write failure could not unwind the committed owner). Returns the held
/// authority, or `None` (logged) when the coordinator refuses — the
/// caller aborts with NOTHING mutated.
///
/// `previous_session_id: Some(old)` marks a REBIND: the claim covers the
/// NEW key (a Granted ticket from a non-Live key, or this terminal's own
/// live incumbent re-adopt), and the OLD key's Live record is protected
/// by the ext-r12 attach guard through the window (a stop or handoff on
/// the old key mid-rebind answers Blocked typed — never a reap of the
/// writer while the new key's fate is pending).
pub(crate) async fn coordinator_begin_identity(
    state: &WsState,
    provider: &str,
    terminal_id: &str,
    session_id: &str,
    previous_session_id: Option<&str>,
) -> Option<IdentityAuthority> {
    let Some(ownership) = state.ownership.as_ref() else {
        return Some(IdentityAuthority::Unwired);
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
    // b8ke ext r14 F2: a REBIND also holds authority over the OLD key —
    // its Live record is the writer's current owner, and the ext-r12
    // guard blocks a stop/handoff on it through the rebind's window.
    let mut old_key_guard = None;
    if let Some(old_session_id) = previous_session_id {
        if old_session_id != session_id {
            old_key_guard = match ownership.begin_attach_guard(
                provider,
                old_session_id,
                &format!("{operation_id}-old"),
                None,
                initiator,
            ) {
                freshell_ownership::AttachGuardOutcome::Armed(guard) => Some(*guard),
                freshell_ownership::AttachGuardOutcome::Refused { state, .. } => {
                    tracing::warn!(target: "freshell_ws::identity_ownership",
                        provider = %provider, session_id = %old_session_id,
                        terminal_id = %terminal_id, state = ?state,
                        "identity_association_refused: the rebind's old key entered a \
                         transition — the rebind mutates nothing"
                    );
                    return None;
                }
                freshell_ownership::AttachGuardOutcome::StaleGeneration { .. } => {
                    tracing::warn!(target: "freshell_ws::identity_ownership",
                        provider = %provider, session_id = %old_session_id,
                        terminal_id = %terminal_id,
                        "identity_association_refused: the rebind's old-key fence is \
                         stale — the rebind mutates nothing"
                    );
                    return None;
                }
            };
        }
    }
    let mut authority = match freshell_freshagent::ownership_lane::begin_terminal_lane_claim(
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
        freshell_freshagent::ownership_lane::TerminalLaneClaim::Granted(ticket) => {
            IdentityAuthority::Ticket(ticket)
        }
        // Unwired is unreachable here (the ownership Option was Some) —
        // treat it as the legacy no-op allow.
        freshell_freshagent::ownership_lane::TerminalLaneClaim::Unwired => {
            IdentityAuthority::Unwired
        }
        freshell_freshagent::ownership_lane::TerminalLaneClaim::Adopt => {
            // The coordinator already holds a live same-kind owner. THIS
            // terminal re-adopting its own live record is the idempotent
            // allow; any other live owner refuses fail-closed (the
            // caller's identity guards should have caught it; the
            // coordinator is the authority).
            let snapshot = ownership.observe(provider, session_id);
            match &snapshot.state {
                freshell_ownership::OwnershipState::Live { owner, .. }
                    if owner.kind == freshell_ownership::RuntimeOwnerKind::Terminal
                        && owner.terminal_id.as_deref() == Some(terminal_id) =>
                {
                    // b8ke ext r14 F1: the re-adopt proceeds under the
                    // ext-r12 guard (held authority across the caller's
                    // writes).
                    match ownership.begin_attach_guard(
                        provider,
                        session_id,
                        &format!("{operation_id}-readopt"),
                        None,
                        initiator,
                    ) {
                        freshell_ownership::AttachGuardOutcome::Armed(guard) => {
                            IdentityAuthority::AdoptGuard(*guard)
                        }
                        freshell_ownership::AttachGuardOutcome::Refused { state, .. } => {
                            tracing::warn!(target: "freshell_ws::identity_ownership",
                                provider = %provider, session_id = %session_id,
                                terminal_id = %terminal_id, state = ?state,
                                "identity_association_refused: the re-adopt's key entered \
                                 a transition — the adoption mutates nothing"
                            );
                            return None;
                        }
                        freshell_ownership::AttachGuardOutcome::StaleGeneration { .. } => {
                            tracing::warn!(target: "freshell_ws::identity_ownership",
                                provider = %provider, session_id = %session_id,
                                terminal_id = %terminal_id,
                                "identity_association_refused: the re-adopt's fence is \
                                 stale — the adoption mutates nothing"
                            );
                            return None;
                        }
                    }
                }
                other => {
                    tracing::warn!(target: "freshell_ws::identity_ownership",
                        provider = %provider, session_id = %session_id,
                        terminal_id = %terminal_id, state = ?other,
                        "identity_association_refused: the canonical key already \
                         has a live owner — the adoption/rebind mutates nothing"
                    );
                    return None;
                }
            }
        }
        freshell_freshagent::ownership_lane::TerminalLaneClaim::Refused(outcome) => {
            tracing::warn!(target: "freshell_ws::identity_ownership",
                provider = %provider, session_id = %session_id,
                terminal_id = %terminal_id, outcome = ?outcome,
                "identity_association_refused: the ownership coordinator refused \
                 the identity claim — the adoption/rebind mutates nothing"
            );
            return None;
        }
    };
    // Splice the old-key guard into the authority so its Drop closes
    // the old key's window with the commit.
    if let Some(guard) = old_key_guard {
        authority = match authority {
            IdentityAuthority::Ticket(ticket) => IdentityAuthority::RebindTicket {
                ticket,
                old_key_guard: guard,
            },
            IdentityAuthority::AdoptGuard(adopt_guard) => IdentityAuthority::RebindAdopt {
                adopt_guard,
                old_key_guard: guard,
            },
            // Unwired cannot occur (the ownership Option was Some); a
            // refused claim returned above.
            other => other,
        };
    }
    Some(authority)
}

/// b8ke ext r14 F1: the FAIL phase — the caller's identity/metadata/
/// durable-binding writes failed: the held authority unwinds (the
/// ticket's typed fail restores the key; the guards' Drop close the
/// windows) with NO committed owner and NO broadcast.
pub(crate) fn coordinator_fail_identity(authority: IdentityAuthority) {
    match authority {
        // The RAII Drop performs the typed fail / the guard release.
        IdentityAuthority::Ticket(_) => {}
        IdentityAuthority::AdoptGuard(_) => {}
        IdentityAuthority::RebindTicket { .. } => {}
        IdentityAuthority::RebindAdopt { .. } => {}
        IdentityAuthority::Unwired => {}
    }
}

/// b8ke ext r14 F1: the COMMIT phase — the callers' identity registry,
/// terminal-metadata, and awaited durable pane-ledger writes have ALL
/// landed (under the held authority); NOW the owner commits and the
/// authoritative frames broadcast. A handoff acquiring the owner after
/// this point finds the binding already durable — no stale-binding
/// writes after a reap. Returns `false` when the commit went stale (the
/// coordinator moved on across the caller's writes) — the identity homes
/// hold a binding for a terminal the coordinator does not name (the
/// stale-teardown discipline owns it; logged loudly).
///
/// b8ke ext r14 F2: a REBIND's commit is the ATOMIC coordinator move —
/// the new key's Starting claim commits Live while the OLD key's
/// Live{Terminal} record becomes Aliased in ONE coordinator lock scope
/// (never the interval where both keys name the writer), and the
/// registry's retained claim is REKEYED in one registry scope (the old
/// claim removed as the new is inserted — the kill/exit selection can
/// never pick a stale old claim).
///
/// b8ke ext r14 F3: the old key's `released` broadcast carries the
/// VACANT owner shape (ownerKind "vacant", no terminal id) — the shape
/// the client's convergence clears on (a terminal-owner frame on a
/// superseded key left old-key Fresh Agent panes presenting "opened as
/// CLI elsewhere" with a direct-attach action pointing at a terminal
/// that had moved to a different session).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn coordinator_commit_identity(
    state: &WsState,
    authority: IdentityAuthority,
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
    let locator = freshell_protocol::SessionLocator {
        provider: provider.to_string(),
        session_id: session_id.to_string(),
    };
    match authority {
        IdentityAuthority::Unwired => true,
        IdentityAuthority::AdoptGuard(guard) => {
            // The idempotent re-adopt: the record already names this
            // terminal — nothing to commit; the guard closes with the
            // scope and the frame refreshes the authoritative owner.
            drop(guard);
            let snapshot = ownership.observe(provider, session_id);
            broadcast_owner_frame(
                state,
                provider,
                session_id,
                terminal_id,
                &operation_id,
                snapshot.generation,
                "handoff-committed",
            );
            true
        }
        IdentityAuthority::RebindAdopt {
            adopt_guard,
            old_key_guard,
        } => {
            // The idempotent re-adopt of the NEW key (already ours); the
            // old key still needs its atomic release.
            drop(adopt_guard);
            let released = rebind_release_old_key(
                state,
                ownership,
                provider,
                terminal_id,
                session_id,
                previous_session_id,
                &operation_id,
                initiator,
            );
            drop(old_key_guard);
            released
        }
        IdentityAuthority::Ticket(mut ticket) => {
            // The adoption's commit: the registry's own API (the retained
            // claim + the ext-r9 commit-time liveness check).
            let outcome = state.registry.commit_session_ref_ownership(
                &locator,
                ticket.operation_id(),
                ticket.generation(),
                terminal_id,
            );
            match outcome {
                freshell_ownership::CommitOutcome::Committed => {
                    ticket.disarm();
                    let snapshot = ownership.observe(provider, session_id);
                    // b8ke ext r22 F2: the commit-side ownership stamp — the
                    // row's delayed-write fence baseline advances to THIS
                    // commit's pair, so a delayed pre-teardown binding write
                    // (an older pair) refuses typed and the newer owner's
                    // recovery row survives.
                    if let Err(err) = state.pane_ledger.stamp_owner_pair(
                        provider,
                        session_id,
                        snapshot.epoch,
                        snapshot.generation,
                    ) {
                        tracing::warn!(target: "freshell_ws::identity_ownership",
                            provider = %provider, session_id = %session_id,
                            error = %err,
                            "identity_association_stamp_owner_pair_failed: the row's \
                             ownership stamp refresh failed (the fence baseline is \
                             stale until the next successful stamp)"
                        );
                    }
                    broadcast_owner_frame(
                        state,
                        provider,
                        session_id,
                        terminal_id,
                        &operation_id,
                        snapshot.generation,
                        "handoff-committed",
                    );
                    true
                }
                stale => {
                    tracing::error!(target: "invariant",
                        provider = %provider, session_id = %session_id,
                        terminal_id = %terminal_id, stale = ?stale,
                        "identity_association_commit_stale: the coordinator moved on \
                         while the learned identity committed — the adoption mutates \
                         nothing (the stale-teardown discipline owns the bound terminal)"
                    );
                    false
                }
            }
        }
        IdentityAuthority::RebindTicket {
            mut ticket,
            old_key_guard,
        } => {
            // b8ke ext r14 F2: the REBIND's ATOMIC commit — the new key's
            // Starting claim commits Live while the old key's Live
            // record becomes Aliased in ONE coordinator lock scope, and
            // the registry's retained claim is rekeyed in one registry
            // scope (the old removed as the new is inserted).
            let old_locator = freshell_protocol::SessionLocator {
                provider: provider.to_string(),
                session_id: previous_session_id
                    .expect("the rebind authority requires a previous id")
                    .to_string(),
            };
            let (outcome, _removed_old_claim) = state.registry.commit_session_ref_ownership_rekey(
                &old_locator,
                &locator,
                ticket.operation_id(),
                ticket.generation(),
                terminal_id,
            );
            drop(old_key_guard);
            match outcome {
                freshell_ownership::CommitOutcome::Committed => {
                    ticket.disarm();
                    // The new key's authoritative owner frame.
                    let snapshot = ownership.observe(provider, session_id);
                    // b8ke ext r22 F2: the commit-side ownership stamp — the
                    // row's delayed-write fence baseline advances to THIS
                    // rekey commit's pair (the delayed-write fence).
                    if let Err(err) = state.pane_ledger.stamp_owner_pair(
                        provider,
                        session_id,
                        snapshot.epoch,
                        snapshot.generation,
                    ) {
                        tracing::warn!(target: "freshell_ws::identity_ownership",
                            provider = %provider, session_id = %session_id,
                            error = %err,
                            "identity_association_stamp_owner_pair_failed: the row's \
                             ownership stamp refresh failed (the fence baseline is \
                             stale until the next successful stamp)"
                        );
                    }
                    broadcast_owner_frame(
                        state,
                        provider,
                        session_id,
                        terminal_id,
                        &operation_id,
                        snapshot.generation,
                        "handoff-committed",
                    );
                    // The old key's VACANT release frame (F3): the old
                    // session's CLI owner is GONE — the client clears the
                    // divergence card for the old key (the alias chain
                    // resolves the canonical NEW record for navigation).
                    broadcast_vacant_frame(
                        state,
                        provider,
                        old_locator.session_id.as_str(),
                        &operation_id,
                    );
                    true
                }
                stale => {
                    tracing::error!(target: "invariant",
                        provider = %provider, session_id = %session_id,
                        terminal_id = %terminal_id, stale = ?stale,
                        "identity_rebind_commit_stale: the coordinator moved on while \
                         the rebind committed — the rebind's ownership did not move (the \
                         stale-teardown discipline owns the bound terminal)"
                    );
                    false
                }
            }
        }
    }
}

/// b8ke ext r14 F2: the rebind's old-key release for the ADOPT-armed
/// shape (the new key already names this terminal idempotently; the old
/// key still holds a Live record naming it). The old record is verified
/// (THIS terminal) and released under the coordinator lock — the
/// registry's retained claim for the old key is removed in the same
/// step.
#[allow(clippy::too_many_arguments)] // the release field set (the keys + the identities + the op)
fn rebind_release_old_key(
    state: &WsState,
    ownership: &std::sync::Arc<freshell_ownership::RuntimeOwnershipRegistry>,
    provider: &str,
    terminal_id: &str,
    session_id: &str,
    previous_session_id: Option<&str>,
    operation_id: &str,
    initiator: &str,
) -> bool {
    let Some(old_session_id) = previous_session_id else {
        return true;
    };
    if old_session_id == session_id {
        return true;
    }
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
                    .unwrap_or_else(|| operation_id.to_string()),
                generation: *generation,
                runtime: Some(owner.clone()),
            };
            ownership.release(provider, old_session_id, &claim, initiator);
            tracing::info!(target: "freshell_ws::identity_ownership",
                provider = %provider, old_session_id = %old_session_id,
                new_session_id = %session_id, terminal_id = %terminal_id,
                "identity_rebind_old_key_released: the superseded canonical \
                 key released in the same step as the move"
            );
            // The old key's retained claim is removed (the rebind moved
            // it — the kill/exit selection must never find it).
            state
                .registry
                .remove_retained_session_ref_claim(&freshell_protocol::SessionLocator {
                    provider: provider.to_string(),
                    session_id: old_session_id.to_string(),
                });
            // b8ke ext r14 F3: the VACANT release frame under the old key.
            broadcast_vacant_frame(state, provider, old_session_id, operation_id);
            true
        }
        other => {
            tracing::warn!(target: "freshell_ws::identity_ownership",
                provider = %provider, old_session_id = %old_session_id,
                terminal_id = %terminal_id, state = ?other,
                "identity_rebind_old_key_mismatch: the old canonical key's \
                 record does not name this terminal — left untouched"
            );
            false
        }
    }
}

/// b8ke ext r14 F3: the VACANT owner frame — `ownerKind: "vacant"`, no
/// terminal id — the shape the client's convergence CLEARS on. The rebind's
/// old-key release and any superseded-key vacancy broadcast this shape (a
/// terminal-owner frame on a released key left old-key Fresh Agent panes
/// presenting the divergence card with a direct-attach action long after
/// the writer moved).
pub(crate) fn broadcast_vacant_frame(
    state: &WsState,
    provider: &str,
    session_id: &str,
    operation_id: &str,
) {
    let Some(ownership) = state.ownership.as_ref() else {
        return;
    };
    let frame = serde_json::to_string(&ServerMessage::SessionRuntimeOwner(
        freshell_protocol::SessionRuntimeOwner {
            provider: provider.to_string(),
            session_id: session_id.to_string(),
            epoch: ownership.boot_epoch(),
            generation: ownership.observe(provider, session_id).generation,
            owner_kind: "vacant".into(),
            previous_kind: None,
            terminal_id: None,
            operation_id: operation_id.to_string(),
            transition: "released".to_string(),
            reason: None,
            fenced: None,
            alias_of: None,
        },
    ))
    .unwrap_or_default();
    let _ = state.broadcast_tx.send(frame);
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
