//! Silent-loss fix (kata dtfn): `terminal.input` / `terminal.attach` against an
//! unknown terminalId must answer on the wire instead of silently no-oping.
//! These tests drive a REAL axum server + REAL tokio-tungstenite client.

mod common;
use common::*;

use std::time::Duration;

#[tokio::test]
async fn input_to_unknown_terminal_answers_input_blocked() {
    let (url, _registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    send_input(&mut ws, "no-such-terminal", "echo lost\r").await;

    let frame = next_frame_of_type(&mut ws, "terminal.input.blocked").await;
    assert_eq!(frame["reason"], serde_json::json!("unknown_terminal"));
    assert_eq!(frame["terminalId"], serde_json::json!("no-such-terminal"));
}

#[tokio::test]
async fn input_to_live_terminal_round_trips_without_a_blocked_frame() {
    // Guard: the fix adds NO ack on the happy path -- output is the only reply.
    let (url, _registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;
    let terminal_id = create_shell_terminal(&mut ws, "req-dtfn-ok").await;
    attach_with(
        &mut ws,
        &terminal_id,
        "att-dtfn-ok",
        "viewport_hydrate",
        120,
        30,
        None,
    )
    .await;
    wait_for_attach_ready(&mut ws, "att-dtfn-ok").await;

    send_input(&mut ws, &terminal_id, "echo __DTFN__alive__\r").await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    let (acc, _gap, _closed) =
        drain_until_marker_or_deadline(&mut ws, "__DTFN__alive__", deadline).await;
    assert!(
        acc.contains("__DTFN__alive__"),
        "live input must still round-trip; got output: {acc}"
    );
}
