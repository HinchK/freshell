//! Real socket protocol coverage without provider binaries or PTY processes.
mod common;
use common::TestWs;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

async fn receive(ws: &mut TestWs, kind: &str) -> Value {
    tokio::time::timeout(common::FRAME_BUDGET, async {
        loop {
            match ws
                .next()
                .await
                .expect("socket remains open")
                .expect("valid frame")
            {
                Message::Text(text) => {
                    let value: Value = serde_json::from_str(&text).expect("JSON");
                    if value["type"] == kind {
                        return value;
                    }
                    assert_ne!(value["type"], "error", "unexpected error: {value}");
                }
                Message::Ping(bytes) => {
                    ws.send(Message::Pong(bytes)).await.unwrap();
                }
                Message::Close(_) => panic!("unexpected close"),
                _ => {}
            }
        }
    })
    .await
    .expect("bounded frame receive")
}
async fn connect(url: &str, opt_in: bool) -> (TestWs, Value) {
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    let mut hello = json!({"type":"hello","token":common::AUTH_TOKEN,
        "protocolVersion":freshell_protocol::WS_PROTOCOL_VERSION});
    if opt_in {
        hello["capabilities"] = json!({"terminalInterestV1":true});
    }
    ws.send(Message::Text(hello.to_string())).await.unwrap();
    let ready = receive(&mut ws, "ready").await;
    receive(&mut ws, "terminal.inventory").await;
    (ws, ready)
}

/// Connect with an explicit hello capability set (for the lifetime-claim
/// negotiation shapes).
async fn connect_with_capabilities(url: &str, capabilities: Value) -> (TestWs, Value) {
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    let hello = json!({"type":"hello","token":common::AUTH_TOKEN,
        "protocolVersion":freshell_protocol::WS_PROTOCOL_VERSION,
        "capabilities": capabilities});
    ws.send(Message::Text(hello.to_string())).await.unwrap();
    let ready = receive(&mut ws, "ready").await;
    receive(&mut ws, "terminal.inventory").await;
    (ws, ready)
}

/// Send `terminal.create` (shell) and return the created terminalId.
async fn create_shell_terminal(ws: &mut TestWs, request_id: &str) -> String {
    send(
        ws,
        json!({"type":"terminal.create","requestId":request_id,
            "mode":"shell","shell":"system"}),
    )
    .await;
    let deadline = tokio::time::Instant::now() + common::FRAME_BUDGET;
    while tokio::time::Instant::now() < deadline {
        let value = tokio::time::timeout(common::FRAME_BUDGET, ws.next())
            .await
            .expect("socket remains open")
            .expect("valid frame")
            .expect("frame ok");
        let Message::Text(text) = value else { continue };
        let parsed: Value = serde_json::from_str(&text).expect("JSON");
        if parsed["type"] == "terminal.created" && parsed["requestId"] == request_id {
            return parsed["terminalId"]
                .as_str()
                .expect("terminalId")
                .to_string();
        }
    }
    panic!("terminal.created never arrived");
}

/// Fence: the pong for a ping proves the preceding typed dispatch finished.
async fn fence_with_ping(ws: &mut TestWs) {
    send(ws, json!({"type":"ping"})).await;
    receive(ws, "pong").await;
}
async fn send(ws: &mut TestWs, value: Value) {
    ws.send(Message::Text(value.to_string())).await.unwrap();
}

#[tokio::test]
async fn capability_is_advertised_only_to_opted_in_connection() {
    let (url, _) = common::spawn_server_with_specs(vec![]).await;
    let (_old, old_ready) = connect(&url, false).await;
    assert!(old_ready["capabilities"]["terminalInterestV1"].is_null());
    let (_new, new_ready) = connect(&url, true).await;
    assert_eq!(new_ready["capabilities"]["terminalInterestV1"], true);
}
#[tokio::test]
async fn accepted_snapshot_never_creates_or_attaches_a_terminal() {
    let (url, registry) = common::spawn_server_with_specs(vec![]).await;
    let (mut ws, _) = connect(&url, true).await;
    send(
        &mut ws,
        json!({"type":"terminal.interest","revision":1,
        "focusedTerminalId":"not-a-terminal","visibleTerminalIds":["not-a-terminal"]}),
    )
    .await;
    send(&mut ws, json!({"type":"ping"})).await;
    receive(&mut ws, "pong").await; // fences the preceding typed dispatch
    assert!(registry.directory().is_empty());
}
#[tokio::test]
async fn unnegotiated_interest_is_rejected_without_disconnecting() {
    let (url, _) = common::spawn_server_with_specs(vec![]).await;
    let (mut ws, _) = connect(&url, false).await;
    send(
        &mut ws,
        json!({"type":"terminal.interest","revision":1,
        "focusedTerminalId":null,"visibleTerminalIds":[]}),
    )
    .await;
    assert_eq!(receive(&mut ws, "error").await["code"], "INVALID_MESSAGE");
    send(&mut ws, json!({"type":"ping"})).await;
    receive(&mut ws, "pong").await;
}
#[tokio::test]
async fn malformed_and_stale_snapshots_have_bounded_non_destructive_handling() {
    let (url, _) = common::spawn_server_with_specs(vec![]).await;
    let (mut ws, _) = connect(&url, true).await;
    send(
        &mut ws,
        json!({"type":"terminal.interest","revision":2,
        "focusedTerminalId":"A","visibleTerminalIds":["A"]}),
    )
    .await;
    send(
        &mut ws,
        json!({"type":"terminal.interest","revision":1,
        "focusedTerminalId":null,"visibleTerminalIds":[]}),
    )
    .await;
    send(&mut ws, json!({"type":"ping"})).await;
    receive(&mut ws, "pong").await;
    send(
        &mut ws,
        json!({"type":"terminal.interest","revision":3,
        "focusedTerminalId":"B","visibleTerminalIds":["A"]}),
    )
    .await;
    assert_eq!(receive(&mut ws, "error").await["code"], "INVALID_MESSAGE");
    send(&mut ws, json!({"type":"ping"})).await;
    receive(&mut ws, "pong").await;
}

// ── Hidden-pane lifetime claims (responsive-terminal-restore WS1) ──

/// A negotiated connection's `claimedTerminalIds` round-trips into the
/// registry: the claim clears `released_by_client` WITHOUT attaching (no
/// subscriber exists — no replay was ever granted).
#[tokio::test]
async fn claimed_ids_round_trip_and_apply_without_attaching() {
    let (url, registry) = common::spawn_server_with_specs(vec![]).await;
    let (mut ws, ready) = connect_with_capabilities(
        &url,
        json!({"terminalInterestV1":true,"terminalLifetimeClaimV1":true}),
    )
    .await;
    assert_eq!(ready["capabilities"]["terminalLifetimeClaimV1"], true);

    let tid = create_shell_terminal(&mut ws, "req-claim-1").await;
    assert_eq!(
        registry.claim_state(&tid),
        Some(freshell_terminal::ClaimState {
            claimers: 0,
            released_by_client: true
        })
    );

    send(
        &mut ws,
        json!({"type":"terminal.interest","revision":1,
        "focusedTerminalId":null,"visibleTerminalIds":[],
        "claimedTerminalIds":[&tid]}),
    )
    .await;
    fence_with_ping(&mut ws).await;

    assert_eq!(
        registry.claim_state(&tid),
        Some(freshell_terminal::ClaimState {
            claimers: 1,
            released_by_client: false
        }),
        "the negotiated claim must mark the terminal wanted"
    );
    // No attach ever happened: zero subscribers.
    assert!(!registry
        .directory()
        .iter()
        .any(|d| d.terminal_id == tid && d.has_clients));

    registry.kill(&tid);
}

/// The latest snapshot's claim set wins per connection: a superseding
/// snapshot that omits the id is the explicit withdrawal (release restores
/// fast-reap eligibility).
#[tokio::test]
async fn superseded_snapshot_withdraws_the_previous_claim() {
    let (url, registry) = common::spawn_server_with_specs(vec![]).await;
    let (mut ws, _) = connect_with_capabilities(
        &url,
        json!({"terminalInterestV1":true,"terminalLifetimeClaimV1":true}),
    )
    .await;
    let tid = create_shell_terminal(&mut ws, "req-claim-2").await;

    send(
        &mut ws,
        json!({"type":"terminal.interest","revision":1,
        "focusedTerminalId":null,"visibleTerminalIds":[],
        "claimedTerminalIds":[&tid]}),
    )
    .await;
    fence_with_ping(&mut ws).await;
    assert_eq!(
        registry
            .claim_state(&tid)
            .map(|s| (s.claimers, s.released_by_client)),
        Some((1, false))
    );

    // Supersede: revision 2 no longer claims the id.
    send(
        &mut ws,
        json!({"type":"terminal.interest","revision":2,
        "focusedTerminalId":null,"visibleTerminalIds":[],
        "claimedTerminalIds":[]}),
    )
    .await;
    fence_with_ping(&mut ws).await;
    assert_eq!(
        registry
            .claim_state(&tid)
            .map(|s| (s.claimers, s.released_by_client)),
        Some((0, true)),
        "withdrawal via the latest snapshot must restore fast-reap eligibility"
    );

    registry.kill(&tid);
}

/// Claims from a connection that did NOT negotiate the capability are
/// ignored server-side (the client gates send-side; the server must be
/// robust on its own).
#[tokio::test]
async fn claims_from_an_unnegotiated_connection_are_ignored() {
    let (url, registry) = common::spawn_server_with_specs(vec![]).await;
    let (mut ws, _) = connect(&url, true).await; // terminalInterestV1 only
    let tid = create_shell_terminal(&mut ws, "req-claim-3").await;

    send(
        &mut ws,
        json!({"type":"terminal.interest","revision":1,
        "focusedTerminalId":null,"visibleTerminalIds":[],
        "claimedTerminalIds":[&tid]}),
    )
    .await;
    fence_with_ping(&mut ws).await;
    assert_eq!(
        registry
            .claim_state(&tid)
            .map(|s| (s.claimers, s.released_by_client)),
        Some((0, true)),
        "a non-negotiated connection's claim field must be ignored"
    );

    registry.kill(&tid);
}
