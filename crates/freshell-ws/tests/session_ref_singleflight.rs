//! D8 per-sessionRef single-flight wire tests (council rules 6/7/8): on a
//! `paneReconcileV1`-negotiated connection, a `terminal.create` carrying a
//! resume `sessionRef` runs the lease discipline — exactly one PTY per
//! sessionRef; losers get `error{code: SESSION_RESERVED, retryAfterMs}` or
//! attach to the winner's terminal. Frozen (non-negotiated) connections are
//! byte-for-byte unchanged.
//!
//! Harness: `mod common;` + `spawn_server_with_specs(vec![sleeper_cli_spec
//! ("claude")])` — real resume-create→live-PTY round trips (the verified
//! recipe from `claude_restore_unavailable.rs`). SessionIds are
//! canonical-UUID-shaped throughout (the claude restore gate rejects
//! non-UUID pre-spawn, and D8 tests must stay valid under it).

mod common;

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message as WsMessage;

use common::{sleeper_cli_spec, spawn_server_with_specs, TestWs, AUTH_TOKEN};

/// Connect + hello (optionally negotiating `paneReconcileV1`), consuming the
/// 4-frame handshake (same shape as `tests/pane_reconcile.rs::connect`).
async fn connect(url: &str, pane_reconcile_v1: bool) -> TestWs {
    let (mut ws, _resp) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
    let mut hello = serde_json::json!({
        "type": "hello",
        "token": AUTH_TOKEN,
        "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
    });
    if pane_reconcile_v1 {
        hello["capabilities"] = serde_json::json!({ "paneReconcileV1": true });
    }
    ws.send(WsMessage::Text(hello.to_string()))
        .await
        .expect("send hello");
    for _ in 0..4u8 {
        tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("handshake message within timeout")
            .expect("stream not ended")
            .expect("no ws error");
    }
    ws
}

/// The same `terminal.create` JSON the client sends for a sessionRef resume
/// (field names per `shared/ws-protocol.ts` `TerminalCreateSchema` — it is
/// `.strict()`, so it IS the wire truth).
fn terminal_create_resume(request_id: &str, mode: &str, session_id: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "terminal.create",
        "requestId": request_id,
        "mode": mode,
        "shell": "system",
        "sessionRef": { "provider": mode, "sessionId": session_id },
    })
}

async fn send_json(ws: &mut TestWs, value: serde_json::Value) {
    ws.send(WsMessage::Text(value.to_string()))
        .await
        .expect("send frame");
}

/// Read frames until a `terminal.created` or `error` for `request_id`
/// arrives (broadcast frames like `terminals.changed` are skipped).
async fn next_created_or_error(ws: &mut TestWs, request_id: &str) -> serde_json::Value {
    for _ in 0..40u8 {
        let msg = tokio::time::timeout(Duration::from_secs(10), ws.next())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for created/error for {request_id}"))
            .expect("stream not ended")
            .expect("no ws error");
        if let WsMessage::Text(text) = &msg {
            let value: serde_json::Value = serde_json::from_str(text).expect("json frame");
            let ty = value["type"].as_str().unwrap_or_default();
            if (ty == "terminal.created" || ty == "error")
                && value["requestId"] == serde_json::json!(request_id)
            {
                return value;
            }
        }
    }
    panic!("no terminal.created/error for {request_id} within 40 messages");
}

/// Count live PTYs carrying `session_id` via the registry-row join
/// (`identity_probe_rows`): `mode` + `resume_session_id` + Running.
fn live_pty_count_for_session(
    registry: &freshell_terminal::TerminalRegistry,
    mode: &str,
    session_id: &str,
) -> usize {
    registry
        .identity_probe_rows()
        .into_iter()
        .filter(|row| {
            row.mode == mode
                && row.status == freshell_protocol::TerminalRunStatus::Running
                && row.resume_session_id.as_deref() == Some(session_id)
        })
        .count()
}

/// The registry's sessionRef→terminalId binding map (recorded at winner bind).
fn registry_binding_for(
    registry: &freshell_terminal::TerminalRegistry,
    mode: &str,
    session_id: &str,
) -> Option<String> {
    registry.bound_terminal_for_session_ref(&freshell_protocol::SessionLocator {
        provider: mode.to_string(),
        session_id: session_id.to_string(),
    })
}

/// two-clients-same-sessionRef (council red test): two negotiated
/// connections, DIFFERENT createRequestIds, same sessionRef resume ->
/// exactly one PTY; the loser is reserved then attaches to the winner.
#[tokio::test]
async fn two_clients_same_session_ref_yield_exactly_one_pty() {
    const SESS_DUP: &str = "11111111-1111-4111-8111-111111111111";
    let (url, registry) = spawn_server_with_specs(vec![sleeper_cli_spec("claude")]).await;
    let mut a = connect(&url, true).await;
    let mut b = connect(&url, true).await;
    send_json(&mut a, terminal_create_resume("cr-A", "claude", SESS_DUP)).await;
    send_json(&mut b, terminal_create_resume("cr-B", "claude", SESS_DUP)).await;

    let fa = next_created_or_error(&mut a, "cr-A").await;
    let fb = next_created_or_error(&mut b, "cr-B").await;
    // Exactly one connection wins the spawn; identify winner and other.
    let (created, other, loser_is_b) = if fa["type"] == serde_json::json!("terminal.created") {
        (fa, fb, true)
    } else {
        (fb, fa, false)
    };
    assert_eq!(
        created["type"],
        serde_json::json!("terminal.created"),
        "at least one create must win: {created}"
    );
    let tid = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();

    if other["type"] == serde_json::json!("error") {
        // Loser path: reserved now, adopts the winner on re-send.
        assert_eq!(other["code"], serde_json::json!("SESSION_RESERVED"));
        let retry_after = other["retryAfterMs"].as_u64().expect("retryAfterMs");
        assert!(retry_after >= 1);
        tokio::time::sleep(Duration::from_millis(retry_after)).await;
        let (loser_ws, loser_req) = if loser_is_b {
            (&mut b, "cr-B")
        } else {
            (&mut a, "cr-A")
        };
        send_json(
            loser_ws,
            terminal_create_resume(loser_req, "claude", SESS_DUP),
        )
        .await;
        let readopt = next_created_or_error(loser_ws, loser_req).await;
        assert_eq!(
            readopt["type"],
            serde_json::json!("terminal.created"),
            "re-send after retryAfterMs must adopt the winner: {readopt}"
        );
        assert_eq!(readopt["terminalId"], serde_json::json!(tid.clone()));
    } else {
        // Loser adopted immediately (winner already bound).
        assert_eq!(other["terminalId"], serde_json::json!(tid.clone()));
    }

    assert_eq!(
        live_pty_count_for_session(&registry, "claude", SESS_DUP),
        1,
        "exactly one live PTY per sessionRef"
    );
    registry.kill_all();
}

/// df1 wrap-review r2 pin: a sessionRef ADOPTION is a successful create —
/// it must SETTLE the server-wide `create_dedupe` entry so a later
/// same-requestId resend replays the settled frame instead of re-entering
/// `handle_create`. Before the fix, the `session_ref_attached` early
/// return skipped `create_dedupe.settle`: the caller's
/// `clear_if_in_flight` dropped the still-InFlight sentinel (erroring any
/// cross-connection waiters with PTY_SPAWN_FAILED) and — worst case — a
/// blind same-requestId resend on a NON-negotiated (frozen) connection
/// re-entered `handle_create` with `pane_reconcile_v1 == false` and
/// SPAWNED A DUPLICATE PTY. (The §5.4 keyed adopt early return shares the
/// identical settle discipline — its remaining seed is REST-stamped
/// registry rows, and both returns were fixed together.) The sequence
/// here is fully serialized — winner awaited before the attacher sends —
/// so no reservation race is involved.
#[tokio::test]
async fn session_ref_adoption_settles_dedupe_for_later_legacy_resends() {
    const SESS_SETTLE: &str = "22222222-2222-4222-8222-222222222222";
    let (url, registry) = spawn_server_with_specs(vec![sleeper_cli_spec("claude")]).await;

    // The winner spawns the session's PTY under requestId "wr-win".
    let mut winner = connect(&url, true).await;
    send_json(
        &mut winner,
        terminal_create_resume("wr-win", "claude", SESS_SETTLE),
    )
    .await;
    let created = next_created_or_error(&mut winner, "wr-win").await;
    assert_eq!(
        created["type"],
        serde_json::json!("terminal.created"),
        "{created}"
    );
    let tid = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();

    // The attacher: SAME sessionRef, fresh requestId "wr-attach" — the
    // claim reports BoundElsewhere and the attach path names the winner's
    // terminal (no second spawn).
    let mut attacher = connect(&url, true).await;
    send_json(
        &mut attacher,
        terminal_create_resume("wr-attach", "claude", SESS_SETTLE),
    )
    .await;
    let attached = next_created_or_error(&mut attacher, "wr-attach").await;
    assert_eq!(
        attached["type"],
        serde_json::json!("terminal.created"),
        "{attached}"
    );
    assert_eq!(attached["terminalId"], serde_json::json!(tid.clone()));

    // Post-fix, "wr-attach" is SETTLED to the winner's terminal: the frozen
    // client's blind same-requestId resend on reconnect replays the frame.
    let mut legacy = connect(&url, false).await;
    send_json(
        &mut legacy,
        terminal_create_resume("wr-attach", "claude", SESS_SETTLE),
    )
    .await;
    let replayed = next_created_or_error(&mut legacy, "wr-attach").await;
    assert_eq!(
        replayed["type"],
        serde_json::json!("terminal.created"),
        "a settled adoption must replay its terminal.created, not error: {replayed}"
    );
    assert_eq!(
        replayed["terminalId"],
        serde_json::json!(tid.clone()),
        "the legacy resend must name the adopted terminal, never a fresh PTY"
    );

    assert_eq!(
        live_pty_count_for_session(&registry, "claude", SESS_SETTLE),
        1,
        "exactly one live PTY for the session across winner + attach + resend"
    );
    assert_eq!(
        registry.kill_all(),
        1,
        "no duplicate spawn anywhere in the flow"
    );
}

/// Legacy connections (no capability) never see SESSION_RESERVED — the
/// frozen-client create path is byte-for-byte unchanged.
#[tokio::test]
async fn legacy_connection_create_path_unchanged() {
    const SESS_LEGACY: &str = "22222222-2222-4222-8222-222222222222";
    let (url, registry) = spawn_server_with_specs(vec![sleeper_cli_spec("claude")]).await;
    let mut legacy = connect(&url, false).await;
    send_json(
        &mut legacy,
        terminal_create_resume("cr-L", "claude", SESS_LEGACY),
    )
    .await;
    let created = next_created_or_error(&mut legacy, "cr-L").await;
    assert_eq!(created["type"], serde_json::json!("terminal.created"));
    assert!(created["terminalId"].is_string());
    // The legacy path never touches the lease/binding machinery.
    assert_eq!(registry_binding_for(&registry, "claude", SESS_LEGACY), None);
    registry.kill_all();
}

/// Winner bind populates the REGISTRY binding map: after the winner's
/// `terminal.created`, the binding map answers with that terminalId (the
/// NEW behavior this task adds; the pane-ledger write is pre-existing
/// create-path behavior and not asserted here).
#[tokio::test]
async fn winner_bind_populates_registry_binding() {
    const SESS_LED: &str = "33333333-3333-4333-8333-333333333333";
    let (url, registry) = spawn_server_with_specs(vec![sleeper_cli_spec("claude")]).await;
    let mut a = connect(&url, true).await;
    send_json(&mut a, terminal_create_resume("cr-A", "claude", SESS_LED)).await;
    let created = next_created_or_error(&mut a, "cr-A").await;
    assert_eq!(created["type"], serde_json::json!("terminal.created"));
    let tid = created["terminalId"].as_str().expect("terminalId");
    assert_eq!(
        registry_binding_for(&registry, "claude", SESS_LED).as_deref(),
        Some(tid),
        "the registry binding map must answer for this sessionRef"
    );
    registry.kill_all();
}
