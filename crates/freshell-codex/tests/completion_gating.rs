//! Integration pinning test for the codex **status-guarded turn completion**
//! (`adapters/codex/adapter.ts:911-928`, cited in `port/machine/specs/coding-cli.md:272,283-289`).
//!
//! `turn/completed` fires for EVERY terminal status (`completed | interrupted | failed |
//! inProgress`, `protocol.ts:104`). The UNIFIED "needs attention" edge — the T2
//! `provider.emits-completion-signal` this crate is graded on (`codex-gptmini.json`) —
//! rings for every turn END the user may not have witnessed: `completed`, `failed`, an
//! absent status (the turn ended, outcome unknown), and a NON-user `interrupted`
//! (automation/rollback-forced). Only a USER-initiated interrupt (the interrupt
//! control lane arms the per-session user-interrupt marker) and the non-terminal
//! `inProgress` stay silent — opencode's `turn_aborted` precedent. This test drives the
//! FULL status matrix in BOTH wire shapes (`params.turn.status` and flat `params.status`)
//! through [`CodexSubscription`] and asserts the routing, per status.

use serde_json::{json, Value};

use freshell_codex::{CodexAdapterEvent, CodexSubscription, CodexTurnEvent, TURN_STATUSES};

fn turn_event(thread_id: &str, params: Value) -> CodexTurnEvent {
    CodexTurnEvent {
        thread_id: thread_id.to_string(),
        turn_id: params
            .get("turnId")
            .and_then(Value::as_str)
            .map(str::to_string),
        params: params.as_object().cloned().unwrap_or_default(),
    }
}

fn chimed(events: &[CodexAdapterEvent]) -> bool {
    events
        .iter()
        .any(|e| matches!(e, CodexAdapterEvent::TurnComplete { .. }))
}

fn chime_count(events: &[CodexAdapterEvent]) -> usize {
    events
        .iter()
        .filter(|e| matches!(e, CodexAdapterEvent::TurnComplete { .. }))
        .count()
}

fn snapshotted(events: &[CodexAdapterEvent]) -> bool {
    events
        .iter()
        .any(|e| matches!(e, CodexAdapterEvent::StatusSnapshot { .. }))
}

#[test]
fn each_status_routes_the_unified_attention_edge_in_both_wire_shapes() {
    // The authoritative per-status truth table for the unified edge: every
    // turn END rings — including a NON-user `interrupted` (no marker armed: an
    // automation/rollback-forced interrupt is a turn end the user didn't
    // witness) — except the non-terminal `inProgress`.
    for &status in TURN_STATUSES {
        let expect_chime = status != "inProgress";

        // Shape A: inline `params.turn.status` (real codex-cli 0.142.x, adapter.ts:1109).
        let mut sub_inline = CodexSubscription::new("thread-1");
        let inline = sub_inline.on_turn_completed(
            &turn_event(
                "thread-1",
                json!({ "threadId": "thread-1", "turn": { "id": "t", "status": status } }),
            ),
            1_000,
        );
        assert!(
            snapshotted(&inline),
            "{status}: an idle snapshot always fires (inline)"
        );
        assert_eq!(
            chime_count(&inline),
            usize::from(expect_chime),
            "{status}: unified attention edge (inline shape)"
        );

        // Shape B: flat `params.status` (the app-server client test shape, adapter.ts:1221).
        let mut sub_flat = CodexSubscription::new("thread-1");
        let flat = sub_flat.on_turn_completed(
            &turn_event(
                "thread-1",
                json!({ "threadId": "thread-1", "turnId": "t", "status": status }),
            ),
            1_000,
        );
        assert!(
            snapshotted(&flat),
            "{status}: an idle snapshot always fires (flat)"
        );
        assert_eq!(
            chime_count(&flat),
            usize::from(expect_chime),
            "{status}: unified attention edge (flat shape)"
        );
    }

    // A USER-initiated interrupt — the interrupt control lane arms the
    // per-session user-interrupt marker before issuing `turn/interrupt` — is
    // the one `interrupted` that stays silent, in BOTH wire shapes.
    for (label, params) in [
        (
            "inline",
            json!({ "threadId": "thread-1", "turn": { "id": "t", "status": "interrupted" } }),
        ),
        (
            "flat",
            json!({ "threadId": "thread-1", "turnId": "t", "status": "interrupted" }),
        ),
    ] {
        let mut sub = CodexSubscription::new("thread-1");
        sub.arm_user_interrupt();
        let out = sub.on_turn_completed(&turn_event("thread-1", params), 1_000);
        assert!(snapshotted(&out), "{label}: an idle snapshot always fires");
        assert!(
            !chimed(&out),
            "{label}: a USER-initiated interrupt never rings: {out:?}"
        );
    }
}

#[test]
fn absent_status_emits_the_edge_and_foreign_thread_never_does() {
    let mut sub = CodexSubscription::new("thread-1");

    // No status at all → the turn still ENDED (outcome unknown): snapshot + the
    // unified edge (codex-adapter.test.ts:1180's snapshot behavior, unified).
    let empty = sub.on_turn_completed(
        &turn_event("thread-1", json!({ "threadId": "thread-1" })),
        1,
    );
    assert!(snapshotted(&empty) && chimed(&empty));

    // A completed turn on ANOTHER thread → nothing at all (adapter.ts:912).
    let foreign = sub.on_turn_completed(
        &turn_event(
            "other",
            json!({ "threadId": "other", "turn": { "status": "completed" } }),
        ),
        1,
    );
    assert!(foreign.is_empty());
}

#[test]
fn every_edge_emitting_status_advances_the_monotonic_clock() {
    // A marker-armed (USER-initiated) interrupted turn is silent and records
    // no completion — the monotonic clock is untouched.
    let mut sub = CodexSubscription::new("thread-1");
    sub.arm_user_interrupt();
    let user_interrupted = sub.on_turn_completed(
        &turn_event(
            "thread-1",
            json!({ "threadId": "thread-1", "status": "interrupted" }),
        ),
        500,
    );
    assert!(snapshotted(&user_interrupted) && !chimed(&user_interrupted));
    assert_eq!(
        sub.last_turn_complete_at(),
        None,
        "a user-armed interrupt records no completion"
    );

    // `failed` advances the per-session monotonic clock exactly like `completed`.
    let failed = sub.on_turn_completed(
        &turn_event(
            "thread-1",
            json!({ "threadId": "thread-1", "status": "failed" }),
        ),
        1_000,
    );
    assert_eq!(chime_count(&failed), 1, "failed rings the unified edge");
    assert_eq!(sub.last_turn_complete_at(), Some(1_000));

    // A same-millisecond `completed`→`failed` sequence gets strictly increasing `at`.
    let at = |events: &[CodexAdapterEvent]| match events
        .iter()
        .find(|e| matches!(e, CodexAdapterEvent::TurnComplete { .. }))
    {
        Some(CodexAdapterEvent::TurnComplete { at, .. }) => *at,
        _ => panic!("expected the unified edge"),
    };
    let completed = sub.on_turn_completed(
        &turn_event(
            "thread-1",
            json!({ "threadId": "thread-1", "status": "completed" }),
        ),
        1_000,
    );
    assert_eq!(at(&completed), 1_001, "same-ms completion is bumped +1");
    let failed_again = sub.on_turn_completed(
        &turn_event(
            "thread-1",
            json!({ "threadId": "thread-1", "status": "failed" }),
        ),
        1_000,
    );
    assert_eq!(
        at(&failed_again),
        1_002,
        "same-ms failed is bumped strictly past the completed edge"
    );
}
