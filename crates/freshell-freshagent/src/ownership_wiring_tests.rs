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
