//! Tests for the pure recovery-inventory builder (B3/P1.9 Task 1).

use super::*;
use freshell_protocol::SessionLocator;
use freshell_ws::pane_ledger::{BindingRow, RetiredReason, RowState, LEDGER_VERSION};
use serde_json::json;
use std::collections::HashSet;

fn no_live() -> HashSet<(String, String)> {
    HashSet::new()
}

fn live(pairs: &[(&str, &str)]) -> HashSet<(String, String)> {
    pairs
        .iter()
        .map(|(p, s)| (p.to_string(), s.to_string()))
        .collect()
}

fn union_doc(device: &str, captured_at: u64, panes: serde_json::Value) -> serde_json::Value {
    json!({
        "deviceId": device, "deviceLabel": format!("label-{device}"), "capturedAt": captured_at,
        "records": [{ "tabKey": "k1", "tabId": "t1", "tabName": "work", "revision": 1,
                      "updatedAt": captured_at, "paneCount": 1, "panes": panes }]
    })
}

/// (state, retired_reason, superseded_by) parts for constructing a `BindingRow`.
type StateParts = (RowState, Option<RetiredReason>, Option<SessionLocator>);

fn bound() -> StateParts {
    (RowState::Bound, None, None)
}

fn retired_closed() -> StateParts {
    (RowState::Retired, Some(RetiredReason::Closed), None)
}

fn retired_gc_expired() -> StateParts {
    (RowState::Retired, Some(RetiredReason::GcExpired), None)
}

fn retired_superseded_by(provider: &str, session_id: &str) -> StateParts {
    (
        RowState::Retired,
        Some(RetiredReason::Superseded),
        Some(SessionLocator {
            provider: provider.to_string(),
            session_id: session_id.to_string(),
        }),
    )
}

fn binding_row_at(
    provider: &str,
    session_id: &str,
    state_parts: StateParts,
    updated_at: i64,
) -> BindingRow {
    let (state, retired_reason, superseded_by) = state_parts;
    BindingRow {
        ledger_version: LEDGER_VERSION,
        provider: provider.to_string(),
        session_id: session_id.to_string(),
        mode: provider.to_string(),
        cwd: Some("/x".to_string()),
        live_terminal_id: None,
        create_request_id: None,
        created_at: 1000,
        updated_at,
        last_observed_at: updated_at,
        state,
        retired_reason,
        superseded_by,
    }
}

fn binding_row(provider: &str, session_id: &str, state_parts: StateParts) -> BindingRow {
    binding_row_at(provider, session_id, state_parts, 1000)
}

#[test]
fn empty_inputs_not_recoverable() {
    let out = build_inventory(vec![], vec![], no_live());
    assert_eq!(out["recoverable"], false);
    assert!(out["device"].is_null());
    assert_eq!(out["ledgerOnly"].as_array().unwrap().len(), 0);
}

#[test]
fn newest_device_wins_others_summarized() {
    let old = DeviceUnion {
        device_id: "dev0".into(),
        union_doc: union_doc(
            "dev0",
            500,
            json!([{ "paneId": "p0", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let new = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc(
            "dev1",
            1000,
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell", "initialCwd": "/w"} }]),
        ),
    };
    let out = build_inventory(vec![old, new], vec![], no_live());
    assert_eq!(out["recoverable"], true);
    assert_eq!(out["device"]["deviceId"], "dev1");
    assert_eq!(out["device"]["tabs"][0]["panes"][0]["cwd"], "/w");
    assert_eq!(out["device"]["tabs"][0]["panes"][0]["live"], false);
    assert_eq!(out["otherDevices"][0]["deviceId"], "dev0");
    assert_eq!(out["otherDevices"][0]["paneCount"], 1);
}

#[test]
fn ledger_bound_row_overrides_snapshot_claim_via_superseded_chain() {
    // snapshot says S1; ledger: S1 retired(superseded -> S2), S2 bound
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc(
            "dev1",
            1000,
            json!([{ "paneId": "p1", "kind": "terminal",
                     "payload": { "mode": "claude", "sessionRef": { "provider": "claude", "sessionId": "S1" } } }]),
        ),
    };
    let bindings = vec![
        binding_row("claude", "S1", retired_superseded_by("claude", "S2")),
        binding_row("claude", "S2", bound()),
    ];
    let out = build_inventory(vec![d], bindings, no_live());
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(pane["ledgerState"], "bound");
    assert_eq!(pane["sessionRef"]["sessionId"], "S2"); // ledger identity beat the snapshot claim
    assert_eq!(out["ledgerOnly"].as_array().unwrap().len(), 0); // S2 is referenced, not ledger-only
}

#[test]
fn closed_row_strips_resume_gc_expired_keeps_snapshot_ref_unknown_passes_through() {
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc(
            "dev1",
            1000,
            json!([
                { "paneId": "p1", "kind": "terminal", "payload": { "mode": "claude", "sessionRef": { "provider": "claude", "sessionId": "CLOSED" } } },
                { "paneId": "p2", "kind": "terminal", "payload": { "mode": "codex",  "sessionRef": { "provider": "codex",  "sessionId": "EXPIRED" } } },
                { "paneId": "p3", "kind": "fresh-agent", "payload": { "sessionRef": { "provider": "freshclaude", "sessionId": "NOROW" } } }
            ]),
        ),
    };
    let bindings = vec![
        binding_row("claude", "CLOSED", retired_closed()),
        binding_row("codex", "EXPIRED", retired_gc_expired()),
    ];
    let out = build_inventory(vec![d], bindings, no_live());
    let panes = out["device"]["tabs"][0]["panes"].as_array().unwrap();
    assert_eq!(panes[0]["ledgerState"], "closed");
    assert!(panes[0]["sessionRef"].is_null());
    assert_eq!(panes[1]["ledgerState"], "gc_expired");
    assert_eq!(panes[1]["sessionRef"]["sessionId"], "EXPIRED");
    assert_eq!(panes[2]["ledgerState"], "unknown");
    assert_eq!(panes[2]["sessionRef"]["sessionId"], "NOROW");
}

#[test]
fn unreferenced_bound_rows_become_ledger_only() {
    let out = build_inventory(vec![], vec![binding_row("codex", "C9", bound())], no_live());
    assert_eq!(out["recoverable"], true);
    assert_eq!(out["ledgerOnly"][0]["sessionId"], "C9");
}

#[test]
fn bound_row_referenced_by_non_primary_device_is_not_ledger_only() {
    // A4: a two-device steady state must not report the OTHER device's sessions as orphaned.
    let newer = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc(
            "dev1",
            1000,
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        ),
    };
    let older = DeviceUnion {
        device_id: "dev0".into(),
        union_doc: union_doc(
            "dev0",
            500,
            json!([{ "paneId": "p0", "kind": "terminal",
                     "payload": { "mode": "codex", "sessionRef": { "provider": "codex", "sessionId": "C9" } } }]),
        ),
    };
    let out = build_inventory(
        vec![newer, older],
        vec![binding_row("codex", "C9", bound())],
        no_live(),
    );
    assert_eq!(out["device"]["deviceId"], "dev1"); // dev0 is NON-primary
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        0,
        "C9 is referenced by dev0's union - not orphaned"
    );
}

#[test]
fn live_effective_ref_marks_pane_live_and_live_rows_never_ledger_only() {
    // D7: pane resolves (via ledger chain) to S2, which a Running terminal owns;
    // a second live bound row C9 is referenced by no pane.
    let d = DeviceUnion {
        device_id: "dev1".into(),
        union_doc: union_doc(
            "dev1",
            1000,
            json!([{ "paneId": "p1", "kind": "terminal",
                     "payload": { "mode": "claude", "sessionRef": { "provider": "claude", "sessionId": "S1" } } }]),
        ),
    };
    let bindings = vec![
        binding_row("claude", "S1", retired_superseded_by("claude", "S2")),
        binding_row("claude", "S2", bound()),
        binding_row("codex", "C9", bound()),
    ];
    let out = build_inventory(
        vec![d],
        bindings,
        live(&[("claude", "S2"), ("codex", "C9")]),
    );
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(pane["live"], true);
    assert_eq!(pane["sessionRef"]["sessionId"], "S2"); // ref still reported; the CLIENT strips it (Task 4, D7)
    assert_eq!(
        out["ledgerOnly"].as_array().unwrap().len(),
        0,
        "live bound rows are excluded from ledgerOnly"
    );
}

#[test]
fn content_id_is_stable_and_input_sensitive() {
    let a = build_inventory(vec![], vec![binding_row("codex", "C9", bound())], no_live());
    let b = build_inventory(vec![], vec![binding_row("codex", "C9", bound())], no_live());
    let c = build_inventory(vec![], vec![binding_row("codex", "C8", bound())], no_live());
    assert_eq!(a["contentId"], b["contentId"]);
    assert_ne!(a["contentId"], c["contentId"]);
}

#[test]
fn content_id_ignores_timestamp_churn() {
    // A5/A6: heartbeat re-pushes bump capturedAt/updatedAt every <=5 min - dismissal must survive.
    let doc = |captured_at| {
        union_doc(
            "dev1",
            captured_at,
            json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell"} }]),
        )
    };
    let a = build_inventory(
        vec![DeviceUnion {
            device_id: "dev1".into(),
            union_doc: doc(1000),
        }],
        vec![binding_row_at("codex", "C9", bound(), 1000)],
        no_live(),
    );
    let b = build_inventory(
        vec![DeviceUnion {
            device_id: "dev1".into(),
            union_doc: doc(2000),
        }],
        vec![binding_row_at("codex", "C9", bound(), 2000)],
        no_live(),
    );
    assert_eq!(
        a["contentId"], b["contentId"],
        "bumping only capturedAt/updatedAt must not change contentId"
    );
}

#[test]
fn stale_clients_generations_are_dropped() {
    // A15: any client silent >15 min (heartbeat is 5 min) is closed or rotated - drop it.
    let t_max: u64 = 100_000_000;
    let gens = vec![
        json!({"generationId": "gA", "clientInstanceId": "fresh", "capturedAt": t_max}),
        json!({"generationId": "gB", "clientInstanceId": "fresh", "capturedAt": t_max - 60_000}),
        json!({"generationId": "gC", "clientInstanceId": "stale", "capturedAt": t_max - 16 * 60 * 1000}),
        json!({"generationId": "gD", "clientInstanceId": "me",    "capturedAt": t_max}),
    ];
    // boot cutoff AFTER every push: the A16 concurrent-client rule drops nothing here.
    let ids = select_foreign_recent_generation_ids(&gens, "me", t_max + 1);
    assert!(ids.contains(&"gA".to_string()) && ids.contains(&"gB".to_string()));
    assert!(
        !ids.contains(&"gC".to_string()),
        "stale rotated client must not resurrect closed tabs"
    );
    assert!(
        !ids.contains(&"gD".to_string()),
        "requester's own generations are excluded"
    );
}

#[test]
fn concurrent_fresh_windows_generations_are_dropped() {
    // A16/D2: a client whose ENTIRE retained history postdates the requester's boot is a
    // concurrently-opened fresh window (junk auto shell tab) - it must never demote the
    // genuinely lost device by winning primary-device selection.
    let boot: u64 = 100_000_000;
    let gens = vec![
        json!({"generationId": "gJ1", "clientInstanceId": "sibling-window", "capturedAt": boot + 2_000}),
        json!({"generationId": "gJ2", "clientInstanceId": "sibling-window", "capturedAt": boot + 300_000}),
        json!({"generationId": "gR",  "clientInstanceId": "lost",           "capturedAt": boot - 30_000}),
    ];
    let ids = select_foreign_recent_generation_ids(&gens, "me", boot);
    assert!(
        ids.contains(&"gR".to_string()),
        "pre-boot client is real lost data - kept"
    );
    assert!(
        !ids.contains(&"gJ1".to_string()) && !ids.contains(&"gJ2".to_string()),
        "post-boot-only client is a concurrent fresh window - dropped"
    );
}
