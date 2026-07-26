//! `paneReconcileFreshAgentV1` capability wire tests — raw-WS
//! (tokio-tungstenite) integration against an in-process axum server, on the
//! `pane_reconcile.rs` harness convention (ephemeral loopback ports, never a
//! fixed one).
//!
//! Covered here (Task 11 — capability negotiation only):
//! * negotiation — `hello.capabilities.paneReconcileFreshAgentV1` → echoed in
//!   `ready.capabilities` (typed `ReadyCapabilities`, omitted when absent).
//! * frozen-client protection — a connection WITHOUT the capability keeps the
//!   pre-existing verdict for `kind: "fresh-agent"`: `invalid` /
//!   `unsupported_kind` (the permanent regression guard).
//!
//! Task 13 extends this file with the fresh-agent verdict derivation tests.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::WsState;

const AUTH_TOKEN: &str = "s3cr3t-token-abcdef";

fn test_settings_value() -> serde_json::Value {
    serde_json::json!({
        "ai": {},
        "codingCli": { "enabledProviders": [], "mcpServer": true, "providers": {} },
        "editor": { "externalEditor": "auto" },
        "extensions": { "disabled": [] },
        "freshAgent": { "defaultPlugins": [], "enabled": false, "providers": {} },
        "logging": { "debug": false },
        "network": { "configured": true, "host": "127.0.0.1" },
        "panes": { "defaultNewPane": "ask" },
        "safety": { "autoKillIdleMinutes": 15 },
        "sidebar": {
            "autoGenerateTitles": true,
            "excludeFirstChatMustStart": false,
            "excludeFirstChatSubstrings": []
        },
        "terminal": { "scrollback": 10000 }
    })
}

struct Server {
    url: String,
    // Shared-registry handles, donor-shaped: Task 13's derivation tests seed
    // generations through these; Task 11's negotiation tests don't need to.
    #[allow(dead_code)]
    registry: freshell_terminal::TerminalRegistry,
    #[allow(dead_code)]
    identity: freshell_ws::identity::TerminalIdentityRegistry,
}

/// Real axum server on an ephemeral loopback port. Returns handles to the
/// SHARED registry + identity registry so tests can seed generations
/// deterministically (the §9.1 headless convention).
async fn spawn_server() -> Server {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));
    let registry = freshell_terminal::TerminalRegistry::new();
    let identity = freshell_ws::identity::TerminalIdentityRegistry::new();

    let state = WsState {
        pane_ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
        identity: identity.clone(),
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-test".to_string()),
        boot_id: Arc::new("boot-test".to_string()),
        settings,
        broadcast_tx: Arc::clone(&broadcast_tx),
        fresh_codex: freshell_freshagent::FreshCodexState::new(
            Arc::clone(&auth_token),
            Arc::clone(&broadcast_tx),
            serde_json::json!({ "freshAgent": { "enabled": false } }),
        ),
        fresh_claude: freshell_freshagent::FreshClaudeState::new(Arc::clone(&broadcast_tx)),
        fresh_opencode: freshell_freshagent::FreshOpencodeState::new(
            freshell_freshagent::FreshAgentState::new(
                Arc::clone(&auth_token),
                Arc::clone(&broadcast_tx),
            ),
        ),
        registry: registry.clone(),
        tabs: freshell_ws::tabs::TabsRegistry::new(),
        screenshots: freshell_ws::screenshot::ScreenshotBroker::new(Arc::clone(&broadcast_tx)),
        terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        sessions_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        cli_commands: Arc::new(Vec::new()),
        shutdown: Arc::new(tokio::sync::Notify::new()),
        ping_interval_ms: 30_000,
        hello_timeout_ms: 5_000,
        allowed_origins: Arc::new(freshell_ws::origin::default_allowed_origins()),
        ws_max_payload_bytes: 16 * 1024 * 1024,
        term09: freshell_ws::backpressure::Term09Config::default(),
        create_protect: freshell_ws::create_limit::CreateProtectConfig::default(),
        spawn_gate: std::sync::Arc::new(freshell_ws::spawn_gate::SpawnGate::new(4, 64)),
        config_fallback: None,
        amplifier_locator: None,
        opencode_locator: None,
        activity: None,
        session_existence: std::sync::Arc::new(freshell_ws::existence::NoIndexProbe::default()),
    };

    let router = freshell_ws::router(state);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    Server {
        url: format!("ws://{addr}/ws"),
        registry,
        identity,
    }
}

type TestWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Connect + hello (negotiating `paneReconcileV1` / `paneReconcileFreshAgentV1`
/// per the flags), consuming the 4-frame handshake. Returns the socket and the
/// parsed `ready` frame.
async fn connect(
    url: &str,
    pane_reconcile_v1: bool,
    fresh_agent_v1: bool,
) -> (TestWs, serde_json::Value) {
    let (mut ws, _resp) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
    let mut hello = serde_json::json!({
        "type": "hello",
        "token": AUTH_TOKEN,
        "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
    });
    hello["capabilities"] = serde_json::json!({
        "paneReconcileV1": pane_reconcile_v1,
        "paneReconcileFreshAgentV1": fresh_agent_v1,
    });
    ws.send(WsMessage::Text(hello.to_string()))
        .await
        .expect("send hello");

    let mut ready = serde_json::Value::Null;
    for _ in 0..4u8 {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("handshake message within timeout")
            .expect("stream not ended")
            .expect("no ws error");
        if let WsMessage::Text(text) = &msg {
            let value: serde_json::Value = serde_json::from_str(text).expect("json frame");
            if value["type"] == serde_json::json!("ready") {
                ready = value;
            }
        }
    }
    assert!(!ready.is_null(), "handshake must contain ready");
    (ws, ready)
}

/// Read text frames until one with `type == wanted` arrives (bounded).
async fn next_frame_of_type(ws: &mut TestWs, wanted: &str) -> serde_json::Value {
    for _ in 0..30u8 {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for a {wanted} frame"))
            .expect("stream not ended")
            .expect("no ws error");
        if let WsMessage::Text(text) = &msg {
            let value: serde_json::Value = serde_json::from_str(text).expect("json frame");
            if value["type"] == serde_json::json!(wanted) {
                return value;
            }
        }
    }
    panic!("no {wanted} frame within 30 messages");
}

/// Send a `pane.reconcile.request` for `panes` and return the result's
/// `verdicts` array.
async fn reconcile_request(ws: &mut TestWs, panes: serde_json::Value) -> serde_json::Value {
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "pane.reconcile.request",
            "reconcileId": "rec-fa",
            "panes": panes,
        })
        .to_string(),
    ))
    .await
    .expect("send reconcile request");
    let result = next_frame_of_type(ws, "pane.reconcile.result").await;
    result["verdicts"].clone()
}

// --- negotiation ---------------------------------------------------------------

#[tokio::test]
async fn ready_echoes_fresh_agent_capability_when_negotiated() {
    let server = spawn_server().await;
    let (_ws, ready) = connect(&server.url, true, true).await;
    assert_eq!(
        ready["capabilities"]["paneReconcileFreshAgentV1"],
        serde_json::json!(true)
    );
}

// --- frozen-client protection (permanent regression guard) ----------------------

#[tokio::test]
async fn without_the_capability_fresh_agent_kind_stays_invalid_unsupported() {
    let server = spawn_server().await;
    let (mut ws, _ready) = connect(&server.url, true, false).await; // frozen-client shape
    let verdicts = reconcile_request(
        &mut ws,
        serde_json::json!([{
            "paneKey": "p1", "kind": "fresh-agent",
            "sessionRef": {"provider": "claude", "sessionId": "s-1"}
        }]),
    )
    .await;
    assert_eq!(verdicts[0]["verdict"], "invalid");
    assert_eq!(verdicts[0]["reason"], "unsupported_kind");
}
