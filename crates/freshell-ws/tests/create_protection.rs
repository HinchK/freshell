//! Integration tests for the per-connection `terminal.create` rate limit
//! (legacy parity: `server/ws-handler.ts:2376-2389`).
//!
//! These run a REAL axum server (ephemeral loopback port) via the shared
//! harness and REAL `tokio-tungstenite` WS clients, exercising the actual
//! limiter wired into `crate::terminal::handle_create`, not a mock.

mod common;

use std::time::Duration;

use freshell_ws::create_limit::CreateProtectConfig;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message as WsMessage;

type TestWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Connect + hello, consuming exactly the 4-frame handshake (this harness
/// has `config_fallback: None`, so the handshake is exactly 4 frames).
async fn connect_and_hello(url: &str) -> TestWs {
    let (mut ws, _resp) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "hello",
            "token": common::AUTH_TOKEN,
            "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
        })
        .to_string(),
    ))
    .await
    .expect("send hello");
    consume_handshake(&mut ws).await;
    ws
}

/// Identical to [`connect_and_hello`] except the hello negotiates
/// `paneReconcileV1` (an OBJECT, not an array) — the shape from the
/// negotiating connect helper in `tests/pane_reconcile.rs:130-162`.
async fn connect_and_hello_pane_reconcile_v1(url: &str) -> TestWs {
    let (mut ws, _resp) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "hello",
            "token": common::AUTH_TOKEN,
            "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
            "capabilities": { "paneReconcileV1": true },
        })
        .to_string(),
    ))
    .await
    .expect("send hello");
    consume_handshake(&mut ws).await;
    ws
}

async fn consume_handshake(ws: &mut TestWs) {
    for _ in 0..4u8 {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("handshake message within timeout")
            .expect("stream not ended")
            .expect("no ws error");
        assert!(matches!(msg, WsMessage::Text(_)));
    }
}

/// Send one terminal.create WITHOUT awaiting a reply (the parked-restore
/// pin needs a create that observably produces no frame).
async fn send_create(ws: &mut TestWs, request_id: &str, restore: bool) {
    let mut msg = serde_json::json!({
        "type": "terminal.create",
        "requestId": request_id,
        "mode": "shell",
        "shell": "system",
    });
    if restore {
        msg["restore"] = serde_json::json!(true);
    }
    ws.send(WsMessage::Text(msg.to_string()))
        .await
        .expect("send terminal.create");
}

/// Send one terminal.create; return the first error/created frame whose
/// requestId matches.
async fn send_create_and_await_reply(
    ws: &mut TestWs,
    request_id: &str,
    restore: bool,
) -> serde_json::Value {
    let mut msg = serde_json::json!({
        "type": "terminal.create",
        "requestId": request_id,
        "mode": "shell",
        "shell": "system",
    });
    if restore {
        msg["restore"] = serde_json::json!(true);
    }
    ws.send(WsMessage::Text(msg.to_string()))
        .await
        .expect("send terminal.create");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(5), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
                    continue;
                };
                let ty = value.get("type").and_then(|v| v.as_str());
                let rid = value.get("requestId").and_then(|v| v.as_str());
                if (ty == Some("terminal.created") || ty == Some("error"))
                    && rid == Some(request_id)
                {
                    return value;
                }
            }
            Ok(Some(Ok(_))) => {}
            other => panic!("expected reply for {request_id}, got {other:?}"),
        }
    }
    panic!("no reply for {request_id}");
}

#[tokio::test]
async fn eleventh_create_is_rate_limited_with_exact_wire_shape() {
    // Long window so the test cannot flake on elapsed time.
    let cfg = CreateProtectConfig {
        rate_limit: 3,
        rate_window_ms: 600_000,
        ..Default::default()
    };
    let url = common::spawn_server_with_create_protect(cfg).await;
    let mut ws = connect_and_hello(&url).await;

    for i in 0..3 {
        let reply = send_create_and_await_reply(&mut ws, &format!("cr-ok-{i}"), false).await;
        assert_eq!(
            reply["type"], "terminal.created",
            "create {i} within limit succeeds: {reply}"
        );
    }
    let rejected = send_create_and_await_reply(&mut ws, "cr-over", false).await;
    // The exact contract the frozen client ladder matches on
    // (TerminalView.tsx:3995-3996) + the generated schema's
    // additionalProperties:false key set.
    assert_eq!(rejected["type"], "error");
    assert_eq!(rejected["code"], "RATE_LIMITED");
    assert_eq!(rejected["message"], "Too many terminal.create requests");
    assert_eq!(rejected["requestId"], "cr-over");
    assert!(rejected["timestamp"].is_string());
    let mut keys: Vec<&str> = rejected
        .as_object()
        .unwrap()
        .keys()
        .map(|k| k.as_str())
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec!["code", "message", "requestId", "timestamp", "type"]
    );
}

#[tokio::test]
async fn restore_creates_bypass_and_do_not_record() {
    let cfg = CreateProtectConfig {
        rate_limit: 2,
        rate_window_ms: 600_000,
        ..Default::default()
    };
    let url = common::spawn_server_with_create_protect(cfg).await;
    let mut ws = connect_and_hello(&url).await;

    let r1 = send_create_and_await_reply(&mut ws, "cr-n1", false).await;
    assert_eq!(r1["type"], "terminal.created");

    // 5 restore creates: none may be RATE_LIMITED (shell-mode restore does
    // not hit the claude-only P0.4 restore wall, so these plain-succeed).
    for i in 0..5 {
        let r = send_create_and_await_reply(&mut ws, &format!("cr-restore-{i}"), true).await;
        assert_ne!(
            r["code"], "RATE_LIMITED",
            "restore create {i} must bypass: {r}"
        );
        assert_eq!(
            r["type"], "terminal.created",
            "restore shell create {i} succeeds: {r}"
        );
    }

    // Budget untouched by the 5 restores: one non-restore slot remains.
    let r2 = send_create_and_await_reply(&mut ws, "cr-n2", false).await;
    assert_eq!(r2["type"], "terminal.created", "restores recorded nothing");
    let r3 = send_create_and_await_reply(&mut ws, "cr-n3", false).await;
    assert_eq!(
        r3["code"], "RATE_LIMITED",
        "third non-restore create exceeds limit 2"
    );
}

#[tokio::test]
async fn gate_at_concurrency_one_never_breaks_a_restore_storm() {
    let cfg = CreateProtectConfig {
        spawn_concurrency: 1,
        spawn_queue_cap: 64,
        spawn_timeout_ms: 30_000,
        ..Default::default()
    };
    let url = common::spawn_server_with_create_protect(cfg).await;

    // Two connections firing interleaved restore creates: every one must
    // succeed (restore bypasses the RATE limit but NOT the gate).
    let mut ws_a = connect_and_hello(&url).await;
    let mut ws_b = connect_and_hello(&url).await;
    for i in 0..4 {
        let ra = send_create_and_await_reply(&mut ws_a, &format!("cr-a-{i}"), true).await;
        assert_eq!(ra["type"], "terminal.created", "conn A create {i}: {ra}");
        let rb = send_create_and_await_reply(&mut ws_b, &format!("cr-b-{i}"), true).await;
        assert_eq!(rb["type"], "terminal.created", "conn B create {i}: {rb}");
    }
}

#[tokio::test]
async fn zero_permit_gate_parks_restore_create_until_disconnect_cancels() {
    // spawn_concurrency: 0 => the harness builds a 0-permit semaphore
    // (legal: only from_env treats 0 as "fall back to default"; the test
    // harness passes 0 straight through to SpawnGate::new).
    // acquire_unbounded() can therefore never succeed: a create that
    // consults the gate queues (under the 64-cap) until its cancel watch
    // fires.
    //
    // RESTORE-ONLY gate scope (user decision, PR #552) stands: only
    // restore:true creates consult the gate; interactive (non-restore)
    // creates bypass it entirely for an instant create. The restore-side
    // CONSEQUENCE changed with graceful restore/resume S1 (the D-GATE-SOFT
    // generalization): a parked restore create queues until cancel
    // (disconnect/shutdown) instead of dying loud at the gate timeout.
    let cfg = CreateProtectConfig {
        spawn_concurrency: 0,
        spawn_queue_cap: 64,
        ..Default::default()
    };
    let (url, registry, gate) = common::spawn_server_with_create_protect_probes(cfg).await;
    let mut ws = connect_and_hello(&url).await;

    // restore:true is exempt from the RATE limit but goes THROUGH the gate:
    // it parks on the 0-permit queue...
    send_create(&mut ws, "cr-gate-parked", true).await;
    for _ in 0..200 {
        if gate.queued_total() == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(
        gate.queued_total(),
        1,
        "restore create must park on the zero-permit gate"
    );
    // ...and NO frame arrives within a short quiet-drain window (queued,
    // not rejected).
    let quiet = tokio::time::timeout(Duration::from_millis(300), ws.next()).await;
    assert!(
        quiet.is_err(),
        "a parked restore create must produce no frame: {quiet:?}"
    );

    // Non-restore creates BYPASS the gate: instant create even with zero
    // permits.
    let plain = send_create_and_await_reply(&mut ws, "cr-gate-bypass", false).await;
    assert_eq!(
        plain["type"], "terminal.created",
        "non-restore creates bypass the gate for an instant create: {plain}"
    );

    // Disconnect: the parked restore create is cancelled without spawning.
    drop(ws);
    for _ in 0..200 {
        if gate.cancellations() == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        gate.cancellations(),
        1,
        "disconnect must cancel the parked restore create"
    );
    assert_eq!(
        registry.kill_all(),
        1,
        "only the bypassing non-restore create spawned"
    );
}

/// Pins the Placement decision: the paneReconcileV1 dedupe/adopt branch
/// (terminal.rs:908-927, early return :926) runs BEFORE the limiter check,
/// so an adoptable duplicate create is neither checked nor charged even
/// when the budget is exhausted (legacy dedupe-first ordering).
#[tokio::test]
async fn adopted_duplicate_create_is_never_charged_or_rejected() {
    let cfg = CreateProtectConfig {
        rate_limit: 2,
        rate_window_ms: 600_000,
        ..Default::default()
    };
    let url = common::spawn_server_with_create_protect(cfg).await;
    // paneReconcileV1-negotiated connection: identical to connect_and_hello
    // except the hello adds `"capabilities":{"paneReconcileV1":true}`.
    let mut ws = connect_and_hello_pane_reconcile_v1(&url).await;

    // Two charged creates exhaust the budget; capture the first terminalId.
    let created = send_create_and_await_reply(&mut ws, "cr-dup", false).await;
    assert_eq!(created["type"], "terminal.created");
    let original_id = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    let filler = send_create_and_await_reply(&mut ws, "cr-fill", false).await;
    assert_eq!(filler["type"], "terminal.created");

    // Prove the budget is exhausted: a FRESH requestId is rejected.
    let over = send_create_and_await_reply(&mut ws, "cr-over", false).await;
    assert_eq!(
        over["code"], "RATE_LIMITED",
        "fresh create over limit rejects: {over}"
    );

    // The duplicate-requestId re-send (the reconnect re-drive shape) must
    // ADOPT the live terminal — never RATE_LIMITED, never a new spawn —
    // because the adopt branch returns before the limiter is consulted.
    // (Adoption is registry-wide by create_request_id and same-socket safe:
    // registry.newest_live_by_create_request_id, freshell-terminal
    // registry.rs:1516-1521.)
    let adopted = send_create_and_await_reply(&mut ws, "cr-dup", false).await;
    assert_eq!(
        adopted["type"], "terminal.created",
        "adopt, not rate limit: {adopted}"
    );
    assert_eq!(
        adopted["terminalId"],
        original_id.as_str(),
        "same live terminal adopted"
    );
}
