//! TERM-04 — `terminal.create` requestId dedupe, NON-RESTORE path, at the WS
//! wire boundary (real axum server, real PTYs, real tokio-tungstenite clients).
//!
//! The restore-path legs live in `restore_spawn_gate.rs`
//! (`same_requestid_resend_returns_existing_terminal`,
//! `resend_on_new_connection_*`); the guard's branch-level truths live in the
//! unit tests of `crates/freshell-ws/src/create_dedupe.rs`. This file closes
//! the remaining acceptance gap: the acceptance semantics are path-agnostic,
//! and the plain (non-restore) create path — inline `handle_create`,
//! `begin()` -> spawn -> `settle()`/`clear_if_in_flight` — had no end-to-end
//! dedupe proof of its own. Coverage map (checklist: retry, reconnect,
//! delayed responses, two clients):
//!
//! - `plain_resend_same_connection_replays_settled_terminal` — retry on the
//!   same socket after settlement: replay, no respawn (the reply is a
//!   `terminal.created`, so a RATE_LIMITED error frame would fail the await —
//!   dedupe preceding the limiter is what makes this leg deterministic).
//! - `plain_resend_on_new_connection_replays_settled_terminal` — the lost
//!   response: the first client's `terminal.created` arrived but its pane is
//!   gone (socket dropped); the reconnect + second-client resend of the same
//!   requestId must be answered with the SAME terminalId and exactly one PTY
//!   must exist. (The pure in-flight-window waiter race is pinned by
//!   `restore_spawn_gate.rs`'s deliberately-unawaited pair and the unit
//!   suite's waiter tests; here the settled window is deterministic.)
//!
//! Contract note (legacy parity, `create_dedupe.rs` header): the replay
//! obligation holds while the first terminal is RUNNING; after an exit, a
//! re-sent requestId is indistinguishable from a fresh create and spawns a
//! new terminal. Both resend tests therefore assert the liveness
//! precondition explicitly so a dead-shell flake can never masquerade as a
//! dedupe violation.

mod common;

use common::{
    connect_and_capture_inventory, create_shell_terminal, next_frame_of_type,
    spawn_server_with_create_protect_probes,
};
use freshell_ws::create_limit::CreateProtectConfig;
use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message as WsMessage;

/// The plain (non-restore) create frame — the shape the frozen client mints
/// first (TerminalView.tsx); identical bytes on every resend.
async fn send_plain_create(ws: &mut common::TestWs, request_id: &str) {
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": request_id,
            "mode": "shell",
            "shell": "system",
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.create");
}

#[tokio::test(flavor = "multi_thread")]
async fn plain_resend_same_connection_replays_settled_terminal() {
    let (ws_url, registry, _gate) =
        spawn_server_with_create_protect_probes(CreateProtectConfig::default()).await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&ws_url).await;

    let tid = create_shell_terminal(&mut ws, "d-plain").await;

    // Explicit liveness precondition (see the module contract note): replay
    // is owed only while the original terminal runs.
    assert!(
        registry.is_pty_running(&tid),
        "test precondition: the original terminal must still be running"
    );

    // Blind resend on the same socket (the frozen client's retry ladder
    // fires the identical frame until answered). Must replay the settled
    // create — same terminalId — and must NOT trip the rate limiter (dedupe
    // precedes it) or spawn a second PTY.
    send_plain_create(&mut ws, "d-plain").await;
    let second = next_frame_of_type(&mut ws, "terminal.created").await;
    assert_eq!(second["requestId"], "d-plain");
    assert_eq!(
        second["terminalId"], tid,
        "same-requestId resend on one connection must replay the settled terminal"
    );
    assert_eq!(registry.kill_all(), 1, "exactly one PTY for one requestId");
}

#[tokio::test(flavor = "multi_thread")]
async fn plain_resend_on_new_connection_replays_settled_terminal() {
    let (ws_url, registry, _gate) =
        spawn_server_with_create_protect_probes(CreateProtectConfig::default()).await;

    let (mut c1, _inventory) = connect_and_capture_inventory(&ws_url).await;
    let tid = create_shell_terminal(&mut c1, "d-xconn").await;
    // The lost-response shape: the pane that asked is gone; its
    // terminal.created may have arrived or not — the server keeps no
    // per-connection debt. Only the requestId identity survives.
    drop(c1);

    // Explicit liveness precondition (see the module contract note): replay
    // is owed only while the original terminal runs.
    assert!(
        registry.is_pty_running(&tid),
        "test precondition: the original terminal must still be running"
    );

    // The reconnect — and simultaneously the two-client shape: a different
    // connection re-sends the identical create.
    let (mut c2, _inventory) = connect_and_capture_inventory(&ws_url).await;
    let tid2 = create_shell_terminal(&mut c2, "d-xconn").await;
    assert_eq!(
        tid2, tid,
        "a settled plain create must replay its terminal.created on a new connection"
    );

    // The second connection's OWN resend still dedupes (the replay path is
    // connection-neutral — the settled entry is server-global, legacy
    // `createdTerminalByRequestId` parity).
    send_plain_create(&mut c2, "d-xconn").await;
    let third = next_frame_of_type(&mut c2, "terminal.created").await;
    assert_eq!(third["terminalId"], tid);

    assert_eq!(
        registry.kill_all(),
        1,
        "exactly one PTY across reconnect + second client + repeat resend"
    );
}

/// Sanity guard for the harness wiring: an unrelated requestId is a DISTINCT
/// create (no over-dedupe). Two different requestIds → two terminals.
#[tokio::test(flavor = "multi_thread")]
async fn different_requestids_spawn_distinct_terminals() {
    let (ws_url, registry, _gate) =
        spawn_server_with_create_protect_probes(CreateProtectConfig::default()).await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&ws_url).await;

    let t1 = create_shell_terminal(&mut ws, "d-distinct-1").await;
    let t2 = create_shell_terminal(&mut ws, "d-distinct-2").await;
    assert_ne!(t1, t2, "distinct requestIds must never share a terminal");
    assert_eq!(registry.kill_all(), 2, "both distinct creates spawn");
}
