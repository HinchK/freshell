//! TERM-07 attach-time viewport geometry parity (`broker.ts:358-397`):
//! `terminal.attach` carries the client's viewport `cols`/`rows` and, per
//! Node's intent-conditional `shouldResize` + `resizeIfSessionMatches`, the
//! server applies that geometry to the PTY BEFORE attach/replay. These tests
//! drive a REAL axum server + REAL tokio-tungstenite client + REAL PTY and
//! assert both the registry-visible geometry (`TerminalRegistry::geometry`)
//! and the kernel-level PTY size (`stty size` inside the shell).

mod common;
use common::*;

use std::time::Duration;

#[tokio::test]
async fn viewport_hydrate_attach_resizes_pty_to_attached_geometry() {
    let (url, registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;
    let terminal_id = create_shell_terminal(&mut ws, "req-geo-1").await;
    assert_eq!(
        registry.geometry(&terminal_id),
        Some((120, 30, 1)),
        "spawn default before attach"
    );

    attach_with(
        &mut ws,
        &terminal_id,
        "att-geo-1",
        "viewport_hydrate",
        95,
        41,
        None,
    )
    .await;
    wait_for_attach_ready(&mut ws, "att-geo-1").await;
    assert_eq!(
        registry.geometry(&terminal_id),
        Some((95, 41, 1)),
        "attach applies the first client geometry WITHOUT bumping the epoch (Node first-record-no-bump)"
    );

    // Kernel ground truth: ask the PTY itself. `stty size` prints `rows cols`.
    // The shell's echo of the typed command contains the literal `$(stty size)`,
    // so the expanded marker below can only come from real command output.
    send_input(&mut ws, &terminal_id, "echo __GEO__$(stty size)__\r").await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    let (acc, _gap, _closed) =
        drain_until_marker_or_deadline(&mut ws, "__GEO__41 95__", deadline).await;
    assert!(
        acc.contains("__GEO__41 95__"),
        "PTY must report the attached geometry (41 rows, 95 cols); got output: {acc}"
    );
}

#[tokio::test]
async fn mismatched_expected_session_ref_does_not_resize() {
    let (url, registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;
    let terminal_id = create_shell_terminal(&mut ws, "req-geo-2").await;

    // A plain shell terminal has no canonical session identity, so an explicit
    // expectation cannot match -> the resize must be skipped (Node
    // resizeIfSessionMatches: no mutation on session_identity_mismatch).
    attach_with(
        &mut ws,
        &terminal_id,
        "att-geo-2",
        "viewport_hydrate",
        95,
        41,
        Some(serde_json::json!({"provider": "codex", "sessionId": "bogus-session"})),
    )
    .await;
    wait_for_attach_ready(&mut ws, "att-geo-2").await;
    assert_eq!(
        registry.geometry(&terminal_id),
        Some((120, 30, 1)),
        "mismatched expectedSessionRef must not resize or bump the epoch"
    );
}

#[tokio::test]
async fn transport_reconnect_resizes_only_without_other_sockets_or_when_reattaching() {
    let (url, registry) = spawn_server().await;
    let (mut ws_a, _inventory_a) = connect_and_capture_inventory(&url).await;
    let terminal_id = create_shell_terminal(&mut ws_a, "req-geo-3").await;

    // A alone: transport_reconnect resizes (no other attached sockets).
    // First-ever geometry record: no epoch bump (Node first-record-no-bump).
    attach_with(
        &mut ws_a,
        &terminal_id,
        "att-a-1",
        "transport_reconnect",
        95,
        41,
        None,
    )
    .await;
    wait_for_attach_ready(&mut ws_a, "att-a-1").await;
    assert_eq!(registry.geometry(&terminal_id), Some((95, 41, 1)));

    // B reconnect-attaches while A is attached and B has no prior attachment:
    // must NOT resize (Node: hasOtherAttachedSockets && !existingAttachment).
    let (mut ws_b, _inventory_b) = connect_and_capture_inventory(&url).await;
    attach_with(
        &mut ws_b,
        &terminal_id,
        "att-b-1",
        "transport_reconnect",
        100,
        50,
        None,
    )
    .await;
    wait_for_attach_ready(&mut ws_b, "att-b-1").await;
    assert_eq!(
        registry.geometry(&terminal_id),
        Some((95, 41, 1)),
        "reconnect with another socket attached and no prior attachment: skip"
    );

    // B re-attaches (existing attachment): resizes despite A being attached.
    // Second geometry record: this one bumps the epoch.
    attach_with(
        &mut ws_b,
        &terminal_id,
        "att-b-2",
        "transport_reconnect",
        100,
        50,
        None,
    )
    .await;
    wait_for_attach_ready(&mut ws_b, "att-b-2").await;
    assert_eq!(
        registry.geometry(&terminal_id),
        Some((100, 50, 2)),
        "re-attach by the same connection: apply; the second record bumps the epoch"
    );
}
