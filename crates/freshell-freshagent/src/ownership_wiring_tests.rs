//! Fresh-agent-lane coordinator wiring (kata b8ke Task 3).
//!
//! Drives the SHARED claim helpers with a bare registry — no sidecar, no
//! server — proving the lane's claim/commit/fail/stop semantics map 1:1 onto
//! the coordinator states. The live-path integration (a real create/kill
//! driving the same helpers) is pinned in
//! freshell-ws/tests/cross_kind_liveness.rs.
use std::sync::Arc;

use freshell_ownership::{
    BeginOutcome, CommitOutcome, OwnershipState, RuntimeOwnerKind, StopOutcome,
};

use crate::ownership_lane::{
    begin_fresh_agent_stop, claim_fresh_agent_ownership, commit_fresh_agent_ownership,
    commit_fresh_agent_stop, fail_fresh_agent_ownership,
};

fn owner_fresh(key: &str) -> freshell_ownership::OwnerIdentity {
    freshell_ownership::OwnerIdentity {
        kind: RuntimeOwnerKind::FreshAgent,
        terminal_id: None,
        live_session_key: Some(key.to_string()),
        pid: Some(991),
        ownership_id: Some("own-1".into()),
    }
}

#[test]
fn fresh_agent_claim_then_commit_is_live_then_kill_releases() {
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    let BeginOutcome::Granted { generation } =
        claim_fresh_agent_ownership(&registry, "codex", "sid-1", "op-1", None, "test", 1)
    else {
        panic!("expected Granted")
    };
    assert_eq!(
        commit_fresh_agent_ownership(
            &registry,
            "codex",
            "sid-1",
            "op-1",
            generation,
            owner_fresh("freshcodex:sid-1")
        ),
        CommitOutcome::Committed
    );
    assert!(matches!(
        registry.observe("codex", "sid-1").state,
        OwnershipState::Live { .. }
    ));
    // Kill path (round-1 review): Live{fresh-agent} -> Stopping FIRST (the kill
    // happens while Stopping — competing starts are Blocked), then
    // commit_stop -> Vacant ONLY after the confirmed reap. Round-2 review:
    // the stop carries the FENCED claim — the lane's believed runtime
    // identity plus the (epoch, generation) its commit stamped.
    let stop_claim = freshell_ownership::StopClaim {
        expected_kind: RuntimeOwnerKind::FreshAgent,
        expected_runtime: Some(owner_fresh("freshcodex:sid-1")),
        observed: freshell_ownership::ObservedFence {
            epoch: registry.boot_epoch(),
            generation,
        },
    };
    match begin_fresh_agent_stop(
        &registry,
        "codex",
        "sid-1",
        "kill-1",
        &stop_claim,
        "test",
        2,
    ) {
        StopOutcome::Granted { generation } => {
            assert!(
                matches!(
                    claim_fresh_agent_ownership(
                        &registry, "codex", "sid-1", "op-x", None, "test", 3
                    ),
                    BeginOutcome::Blocked { .. }
                ),
                "no competing start may be granted while Stopping"
            );
            // ...the caller kills the sidecar and awaits its confirmed exit...
            assert_eq!(
                commit_fresh_agent_stop(&registry, "codex", "sid-1", "kill-1", generation),
                CommitOutcome::Committed
            );
        }
        other => panic!("expected Granted, got {other:?}"),
    }
    assert_eq!(
        registry.observe("codex", "sid-1").state,
        OwnershipState::Vacant
    );
}

#[test]
fn fresh_agent_stop_during_a_handoff_is_typed_blocked_and_does_not_kill() {
    // Round-1 review: a stop attempted during another operation's Handoff
    // returns the typed BlockedHandoff — the caller must NOT kill.
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    let BeginOutcome::Granted { generation } =
        claim_fresh_agent_ownership(&registry, "codex", "sid-4", "op-4", None, "test", 1)
    else {
        panic!()
    };
    assert_eq!(
        commit_fresh_agent_ownership(
            &registry,
            "codex",
            "sid-4",
            "op-4",
            generation,
            owner_fresh("freshcodex:sid-4")
        ),
        CommitOutcome::Committed
    );
    let BeginOutcome::Granted { .. } = registry.begin_handoff(
        "codex",
        "sid-4",
        RuntimeOwnerKind::Terminal,
        "ho-4",
        None,
        "test",
        2,
    ) else {
        panic!()
    };
    let stop_claim = freshell_ownership::StopClaim {
        expected_kind: RuntimeOwnerKind::FreshAgent,
        expected_runtime: Some(owner_fresh("freshcodex:sid-4")),
        observed: freshell_ownership::ObservedFence {
            epoch: registry.boot_epoch(),
            generation,
        },
    };
    assert!(matches!(
        begin_fresh_agent_stop(
            &registry,
            "codex",
            "sid-4",
            "kill-4",
            &stop_claim,
            "test",
            3
        ),
        StopOutcome::BlockedHandoff { .. }
    ));
    assert!(
        matches!(
            registry.observe("codex", "sid-4").state,
            OwnershipState::Handoff { .. }
        ),
        "the blocked stop must not have killed or transitioned the handoff"
    );
}

#[test]
fn fresh_agent_stop_with_a_stale_claim_is_typed_refused_and_does_not_kill() {
    // Round-2 review: a delayed fresh-agent kill whose claim no longer
    // matches the current owner (ownership moved to a terminal under a new
    // generation) is the typed StaleClaim — NO kill, no transition.
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    let BeginOutcome::Granted { generation } =
        claim_fresh_agent_ownership(&registry, "codex", "sid-5", "op-5", None, "test", 1)
    else {
        panic!()
    };
    assert_eq!(
        commit_fresh_agent_ownership(
            &registry,
            "codex",
            "sid-5",
            "op-5",
            generation,
            owner_fresh("freshcodex:sid-5")
        ),
        CommitOutcome::Committed
    );
    // Ownership moves to a terminal via a handoff.
    let BeginOutcome::Granted { generation: g2 } = registry.begin_handoff(
        "codex",
        "sid-5",
        RuntimeOwnerKind::Terminal,
        "ho-5",
        None,
        "test",
        2,
    ) else {
        panic!()
    };
    let term = freshell_ownership::OwnerIdentity {
        kind: RuntimeOwnerKind::Terminal,
        terminal_id: Some("t-5".into()),
        live_session_key: None,
        pid: None,
        ownership_id: None,
    };
    assert_eq!(
        registry.commit_live("codex", "sid-5", "ho-5", g2, term),
        CommitOutcome::Committed
    );
    // The delayed kill's fence still carries the fresh-agent generation.
    let stale = freshell_ownership::StopClaim {
        expected_kind: RuntimeOwnerKind::FreshAgent,
        expected_runtime: Some(owner_fresh("freshcodex:sid-5")),
        observed: freshell_ownership::ObservedFence {
            epoch: registry.boot_epoch(),
            generation,
        },
    };
    assert!(matches!(
        begin_fresh_agent_stop(&registry, "codex", "sid-5", "kill-5", &stale, "test", 3),
        StopOutcome::StaleClaim { .. }
    ));
    assert!(
        matches!(
            registry.observe("codex", "sid-5").state,
            OwnershipState::Live { ref owner, .. } if owner.kind == RuntimeOwnerKind::Terminal
        ),
        "the stale kill must not have transitioned or killed the terminal owner"
    );
}

#[test]
fn fresh_agent_claim_fails_typed_when_terminal_owns() {
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    let BeginOutcome::Granted { generation } = registry.begin_start(
        "codex",
        "sid-2",
        RuntimeOwnerKind::Terminal,
        "term-op",
        None,
        "test",
        1,
    ) else {
        panic!()
    };
    let t = freshell_ownership::OwnerIdentity {
        kind: RuntimeOwnerKind::Terminal,
        terminal_id: Some("t-1".into()),
        live_session_key: None,
        pid: None,
        ownership_id: None,
    };
    registry.commit_live("codex", "sid-2", "term-op", generation, t);
    // The fresh-agent lane's claim must see the typed cross-kind conflict.
    let claim = claim_fresh_agent_ownership(&registry, "codex", "sid-2", "op-2", None, "test", 2);
    assert!(matches!(claim, BeginOutcome::OwnedByOtherKind { .. }));
}

#[test]
fn fresh_agent_fail_reopens_the_key() {
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    let BeginOutcome::Granted { generation } =
        claim_fresh_agent_ownership(&registry, "opencode", "ses-3", "op-3", None, "test", 1)
    else {
        panic!()
    };
    assert_eq!(
        fail_fresh_agent_ownership(&registry, "opencode", "ses-3", "op-3", generation),
        freshell_ownership::FailOutcome::Released
    );
    let retry =
        claim_fresh_agent_ownership(&registry, "opencode", "ses-3", "op-4", None, "test", 2);
    assert!(matches!(retry, BeginOutcome::Granted { .. }));
}

/// b8ke focused episode-2 round-1 F6: the start-cancellation slot signals
/// ONLY through the recorded-incarnation path. The slot records (pid, start
/// time) at spawn; a forged MISMATCHED start time models the recycled-pid
/// shape (the original exited; an unrelated process took the id within the
/// watchdog's sweep window) — the cancellation must NEVER signal it.
/// Pre-fix the closure SIGTERMed the bare numeric pid and the unrelated
/// process died.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn the_start_cancellation_slot_never_signals_a_recycled_pid() {
    // A live "unrelated replacement" process.
    let mut unrelated = tokio::process::Command::new("sleep")
        .arg("300")
        .kill_on_drop(true)
        .spawn()
        .expect("spawn the unrelated replacement");
    let pid = unrelated.id().expect("unrelated pid");

    // The slot armed with the ORIGINAL (dead) incarnation's identity — the
    // start time forged to differ, the pid-reuse shape.
    let slot = crate::ownership_lane::sidecar_pid_cancel_slot();
    crate::ownership_lane::arm_sidecar_pid_slot(&slot, Some(pid));
    {
        let mut armed = slot.lock().expect("slot lock");
        let (recorded_pid, _) = armed.expect("the slot armed");
        assert_eq!(recorded_pid, pid);
        // Forge the mismatch: the pid now belongs to a different
        // incarnation than the one the slot recorded.
        *armed = Some((
            pid,
            crate::session_lease::recorded_start_time(Some(pid)).map(|st| st + 1),
        ));
    }
    (crate::ownership_lane::pid_slot_cancellation(&slot))();
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(
        crate::session_lease::proc_starttime(pid as i32).is_some(),
        "the recycled pid's unrelated process must NEVER be signaled by the \
         start cancellation"
    );

    // The matching-incarnation control: the recorded identity still holds
    // — the cancellation signals and the process dies.
    crate::ownership_lane::arm_sidecar_pid_slot(&slot, Some(pid));
    (crate::ownership_lane::pid_slot_cancellation(&slot))();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while crate::session_lease::proc_starttime(pid as i32).is_some() {
        assert!(
            std::time::Instant::now() < deadline,
            "the recorded incarnation was never signaled"
        );
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    let _ = unrelated.wait().await;
}

/// F6 (the post-spawn direct variant): a mismatched recorded incarnation
/// never signals; the matching one does.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn the_start_cancellation_direct_variant_verifies_the_incarnation() {
    let mut child = tokio::process::Command::new("sleep")
        .arg("300")
        .kill_on_drop(true)
        .spawn()
        .expect("spawn the child");
    let pid = child.id().expect("child pid");
    let start = crate::session_lease::recorded_start_time(Some(pid));

    // The recycled shape: the recorded start time does not match the pid's
    // current occupant — never signaled.
    let wrong = crate::ownership_lane::sidecar_pid_cancellation(Some(pid), start.map(|st| st + 1));
    wrong();
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(
        crate::session_lease::proc_starttime(pid as i32).is_some(),
        "the mismatched incarnation must never be signaled"
    );

    // The matching control.
    let right = crate::ownership_lane::sidecar_pid_cancellation(Some(pid), start);
    right();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while crate::session_lease::proc_starttime(pid as i32).is_some() {
        assert!(
            std::time::Instant::now() < deadline,
            "the matching incarnation was never signaled"
        );
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    let _ = child.wait().await;
}
