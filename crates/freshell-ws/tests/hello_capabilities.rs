//! End-to-end capability-negotiation tests for the `/ws` hello→ready handshake
//! (responsive-terminal-restore Workstream 1: `pacedTerminalReplayV1`).
//!
//! These run a REAL axum server on an ephemeral loopback port (never a fixed/
//! reserved one) and a REAL tokio-tungstenite WS client, so they exercise the
//! actual `handle_socket` path: the raw-JSON `hello` capability extraction and
//! the `ready` advertisement gate — the layers an in-file
//! `build_handshake_with_capabilities` unit test cannot reach (a typo'd wire
//! key in the extraction compiles fine and silently disables negotiation).
//!
//! Backwards-compat contract under test: a hello WITHOUT the capability must
//! produce a `ready` byte-identical to today's output (no `pacedTerminalReplayV1`
//! key, no new capabilities object), on both sides of the change.

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

/// Build a `WsState`, spin up a real axum server on an ephemeral loopback port
/// (`127.0.0.1:0`, never a fixed/reserved port), and return its `ws://` URL.
async fn spawn_server() -> String {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(16).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));

    let state = WsState {
        pane_ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
        layout: Default::default(),
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        terminal_meta: Default::default(),
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-test".to_string()),
        boot_id: Arc::new("boot-test".to_string()),
        settings,
        handshake_settings: Arc::new(tokio::sync::RwLock::new(
            serde_json::from_value(test_settings_value()).expect("valid settings fixture"),
        )),
        broadcast_tx: Arc::clone(&broadcast_tx),
        auto_resume_tx: tokio::sync::mpsc::unbounded_channel().0,
        auto_resume_cancels: Default::default(),
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
        registry: freshell_terminal::TerminalRegistry::new(),
        tabs: freshell_ws::tabs::TabsRegistry::new(),
        screenshots: freshell_ws::screenshot::ScreenshotBroker::new(Arc::clone(&broadcast_tx)),
        subagent_interest: Default::default(),
        host_stats: Default::default(),
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
        shutdown_started: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        create_dedupe: std::sync::Arc::new(freshell_ws::create_dedupe::CreateDedupe::default()),
        config_fallback: None,
        opencode_locator: None,
        codex_locator: None,
        activity: None,
        session_existence: std::sync::Arc::new(freshell_ws::existence::NoIndexProbe::default()),
        reconcile_deferral_budget_ms: freshell_ws::reconcile::RECONCILE_DEFERRAL_BUDGET_MS_DEFAULT,
        fresh_agent_respawn_counts: Default::default(),
        ownership: None,
    };

    let router = freshell_ws::router(state);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    format!("ws://{addr}/ws", addr = addr)
}

type WsClient =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Send a `hello` and read the `ready` frame back as JSON (the first message
/// of the connect handshake).
async fn hello_ready(ws: &mut WsClient, capabilities: serde_json::Value) -> serde_json::Value {
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "hello",
            "token": AUTH_TOKEN,
            "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
            "capabilities": capabilities,
        })
        .to_string(),
    ))
    .await
    .expect("send hello");

    let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
        .await
        .expect("ready within timeout")
        .expect("stream not ended")
        .expect("no ws error");
    let WsMessage::Text(text) = msg else {
        panic!("expected the ready text frame, got {msg:?}");
    };
    serde_json::from_str(&text).expect("ready is JSON")
}

/// A hello WITH `pacedTerminalReplayV1: true` gets the echo advertised back in
/// `ready.capabilities` — the full negotiation rail (raw-JSON extraction →
/// handshake builder gate) at the real socket.
#[tokio::test]
async fn negotiated_hello_gets_paced_terminal_replay_echo_in_ready() {
    let url = spawn_server().await;
    let (mut ws, _resp) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("ws connect");

    let ready = hello_ready(
        &mut ws,
        serde_json::json!({ "terminalOutputBatchV1": true, "pacedTerminalReplayV1": true }),
    )
    .await;
    assert_eq!(
        ready["capabilities"],
        serde_json::json!({ "pacedTerminalReplayV1": true }),
        "a negotiated hello must get exactly the paced-replay echo: {ready}"
    );
}

/// A hello that negotiates other capabilities but NOT the paced one gets a
/// `ready.capabilities` object byte-identical to today's output — the new key
/// never leaks to a non-opting client.
#[tokio::test]
async fn non_paced_negotiation_keeps_capabilities_byte_identical() {
    let url = spawn_server().await;
    let (mut ws, _resp) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("ws connect");

    let ready = hello_ready(
        &mut ws,
        serde_json::json!({ "paneReconcileV1": true, "terminalInterestV1": true }),
    )
    .await;
    assert_eq!(
        ready["capabilities"],
        serde_json::json!({ "paneReconcileV1": true, "terminalInterestV1": true }),
        "a non-paced negotiation must keep today's capabilities shape: {ready}"
    );
}

/// The frozen client (no capabilities at all) still gets a `ready` with NO
/// capabilities object — byte-identical to the pre-capability handshake.
#[tokio::test]
async fn capability_free_hello_ready_has_no_capabilities_object() {
    let url = spawn_server().await;
    let (mut ws, _resp) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("ws connect");

    let ready = hello_ready(&mut ws, serde_json::json!({})).await;
    assert!(
        ready.get("capabilities").is_none(),
        "a capability-free hello must not change ready's shape: {ready}"
    );
}
