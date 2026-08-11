//! Task 13 (AUTO-01 spine): `ui.layout.sync` ingestion.
//!
//! A REAL `/ws` connection (the `session_identity_frames.rs` harness
//! convention) sends the client's layout mirror frame; the socket loop's
//! `ClientMessage::UiLayoutSync` dispatch arm must REPLACE that CONNECTION'S
//! server-side `LayoutStore` snapshot (`update_from_ui`) -- the port of the
//! dedicated `case 'ui.layout.sync'` arm's `this.layoutStore.updateFromUi(m,
//! ws.connectionId || 'unknown')` (`server/ws-handler.ts:2024-2027`).
//! Intentional divergence: the store keeps one snapshot PER connection
//! (Node keeps a single last-writer-wins snapshot), so by-id agent-API
//! operations resolve pane/tab ids from EVERY connected client. A closed
//! connection's snapshot is marked STALE and RETAINED (never primary while a
//! live client exists) — the client's layout mirror is change-gated and never
//! re-syncs on a silent reconnect, so hard eviction would leave that client's
//! ids unresolvable for an unbounded window. A stale entry is dropped only
//! when a live sync covers every one of its pane ids (lossless supersede).
//!
//! No reply frame exists (Node sends none), so a `ping`/`pong` round-trip on
//! the SAME connection is the ordering barrier: the serve loop dispatches
//! inbound frames sequentially, so by the time `pong` arrives the layout
//! frame sent before the `ping` has been fully ingested.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_freshagent::layout_store::LayoutStore;
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

/// Real axum server on an ephemeral loopback port. Returns the ws URL, the
/// http base URL (the fresh-agent REST router is merged in, sharing the SAME
/// layout store — the `freshell-server` wiring), plus the `LayoutStore`
/// handle cloned into `WsState::layout` (the store is `Arc`-backed, so
/// asserting on this handle observes the socket path's ingestion).
async fn spawn_server() -> (String, String, LayoutStore) {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));
    let layout = LayoutStore::default();

    // The REST agent surface (`PATCH /api/panes/:id` etc.) sharing the same
    // layout store, exactly like `freshell-server/src/main.rs`'s wiring.
    let rest_state = freshell_freshagent::FreshAgentState::new(
        Arc::clone(&auth_token),
        Arc::clone(&broadcast_tx),
    )
    .with_layout(layout.clone());
    let rest_router = freshell_freshagent::router(rest_state);

    let state = WsState {
        layout: layout.clone(),
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        terminal_meta: Default::default(),
        pane_ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
        auto_resume_tx: tokio::sync::mpsc::unbounded_channel().0,
        auto_resume_cancels: Default::default(),
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
        registry: freshell_terminal::TerminalRegistry::new(),
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
        shutdown_started: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        create_dedupe: std::sync::Arc::new(freshell_ws::create_dedupe::CreateDedupe::default()),
        config_fallback: None,
        opencode_locator: None,
        codex_locator: None,
        activity: None,
        session_existence: std::sync::Arc::new(freshell_ws::existence::NoIndexProbe::default()),
        reconcile_deferral_budget_ms: freshell_ws::reconcile::RECONCILE_DEFERRAL_BUDGET_MS_DEFAULT,
        fresh_agent_respawn_counts: Default::default(),
    };

    let router = freshell_ws::router(state).merge(rest_router);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    (
        format!("ws://{addr}/ws", addr = addr),
        format!("http://{addr}", addr = addr),
        layout,
    )
}

type TestWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Connect + hello, draining the 4-frame handshake (`config_fallback` is None
/// in this harness): ready -> settings.updated -> perf.logging ->
/// terminal.inventory.
async fn connect_and_hello(url: &str) -> TestWs {
    let (mut ws, _resp) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "hello",
            "token": AUTH_TOKEN,
            "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
        })
        .to_string(),
    ))
    .await
    .expect("send hello");
    let inventory = next_frame_of_type(&mut ws, "terminal.inventory").await;
    assert!(
        !inventory.is_null(),
        "handshake must contain terminal.inventory"
    );
    ws
}

/// Read text frames until one with `type == wanted` arrives (bounded).
async fn next_frame_of_type(ws: &mut TestWs, wanted: &str) -> serde_json::Value {
    for _ in 0..20u8 {
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
    panic!("no {wanted} frame within 20 messages");
}

/// **RED for Task 13**: a `ui.layout.sync` client frame must populate the
/// shared server-side `LayoutStore` -- `has_snapshot()` flips true,
/// `list_tabs()` reflects the payload's tab rows + active tab, and the source
/// connection id is stamped. No reply frame is asserted because none exists
/// (the `pong` barrier proves dispatch completed).
#[tokio::test]
async fn ui_layout_sync_frame_populates_the_shared_layout_store() {
    let (url, _http, layout) = spawn_server().await;
    let mut ws = connect_and_hello(&url).await;
    assert!(
        !layout.has_snapshot(),
        "harness sanity: the store starts empty"
    );

    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "ui.layout.sync",
            "tabs": [{"id": "t1", "title": "Work"}],
            "activeTabId": "t1",
            "layouts": {"t1": {"type": "leaf", "id": "p1", "content": {
                "kind": "terminal", "mode": "shell",
                "createRequestId": "r1", "status": "running"
            }}},
            "activePane": {"t1": "p1"},
            "paneTitles": {},
            "paneTitleSetByUser": {},
            "timestamp": 123
        })
        .to_string(),
    ))
    .await
    .expect("send ui.layout.sync");

    // Ordering barrier: the serve loop dispatches this connection's frames
    // sequentially, so the pong proves the layout frame was handled.
    ws.send(WsMessage::Text(
        serde_json::json!({ "type": "ping" }).to_string(),
    ))
    .await
    .expect("send ping");
    next_frame_of_type(&mut ws, "pong").await;

    assert!(
        layout.has_snapshot(),
        "ui.layout.sync must REPLACE the shared layout snapshot"
    );
    let (tabs, active) = layout.list_tabs();
    assert_eq!(tabs.len(), 1, "one tab row: {tabs:?}");
    assert_eq!(tabs[0]["id"], serde_json::json!("t1"));
    assert_eq!(tabs[0]["title"], serde_json::json!("Work"));
    assert_eq!(tabs[0]["activePaneId"], serde_json::json!("p1"));
    assert_eq!(active.as_deref(), Some("t1"));
    assert!(
        layout.source_connection_id().is_some(),
        "ingestion must stamp the source connection id"
    );
}

/// Send one `ui.layout.sync` frame (single tab/pane) on an open connection and
/// barrier on ping/pong so ingestion is proven complete.
async fn sync_single_pane(ws: &mut TestWs, tab_id: &str, pane_id: &str, ts: i64) {
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "ui.layout.sync",
            "tabs": [{"id": tab_id, "title": format!("Tab {tab_id}")}],
            "activeTabId": tab_id,
            "layouts": {tab_id: {"type": "leaf", "id": pane_id, "content": {
                "kind": "terminal", "mode": "shell",
                "createRequestId": format!("r-{pane_id}"), "status": "running"
            }}},
            "activePane": {tab_id: pane_id},
            "paneTitles": {},
            "paneTitleSetByUser": {},
            "timestamp": ts
        })
        .to_string(),
    ))
    .await
    .expect("send ui.layout.sync");
    ws.send(WsMessage::Text(
        serde_json::json!({ "type": "ping" }).to_string(),
    ))
    .await
    .expect("send ping");
    next_frame_of_type(ws, "pong").await;
}

/// Multi-client layout store (the cross-client pane-rename fix): two REAL WS
/// connections sync DIFFERENT layouts (pane/tab ids are client-local); the
/// REST agent surface must resolve pane ids from the NON-last-writer
/// connection, and a closed connection's snapshot must be RETAINED as stale
/// (silent-reconnect window) until a live sync covers all of its pane ids.
/// This intentionally diverges from Node's single last-writer-wins snapshot
/// (`server/agent-api/layout-store.ts`).
///
/// The disconnect phase is sequenced around POSITIVE barriers: conn-1 is
/// re-synced LAST so it is primary, and the close is proven processed by the
/// primary flipping to conn-2 (stale-never-primary) plus
/// `stale_entry_count() == 1` — only then is retention asserted. A bare
/// "`p1` still resolvable" check alone would pass vacuously before the server
/// even processed the close.
#[tokio::test]
async fn two_client_syncs_coexist_rest_resolves_non_primary_ids_and_disconnect_retains_stale() {
    let (url, http, layout) = spawn_server().await;

    let mut ws1 = connect_and_hello(&url).await;
    sync_single_pane(&mut ws1, "t1", "p1", 100).await;
    let mut ws2 = connect_and_hello(&url).await;
    sync_single_pane(&mut ws2, "t2", "p2", 200).await; // ws2 = last writer

    // REST rename of ws1's pane (the NON-last-writer) must succeed.
    let client = reqwest::Client::new();
    let resp = client
        .patch(format!("{http}/api/panes/p1"))
        .header("x-auth-token", AUTH_TOKEN)
        .header("content-type", "application/json")
        .body(serde_json::json!({ "name": "Cross Client" }).to_string())
        .send()
        .await
        .expect("PATCH /api/panes/p1");
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value =
        serde_json::from_str(&resp.text().await.expect("body")).expect("json body");
    assert_eq!(
        body["data"]["tabId"],
        serde_json::json!("t1"),
        "pane id from the non-last-writer connection must resolve: {body}"
    );
    assert_eq!(body["data"]["paneId"], serde_json::json!("p1"));

    // Primary (default) reads still answer from the last writer.
    let (tabs, active) = layout.list_tabs();
    assert_eq!(tabs.len(), 1, "list_tabs reads the primary snapshot only");
    assert_eq!(tabs[0]["id"], serde_json::json!("t2"));
    assert_eq!(active.as_deref(), Some("t2"));

    // (1) Re-sync conn-1 LAST so it becomes the primary: `list_tabs()`
    // answering t1 is the precondition the disconnect barrier flips.
    sync_single_pane(&mut ws1, "t1", "p1", 300).await;
    let (tabs, _) = layout.list_tabs();
    assert_eq!(
        tabs[0]["id"],
        serde_json::json!("t1"),
        "conn-1's re-sync must make it the primary"
    );

    // (2) Close conn-1 and wait for the POSITIVE disconnect-processed
    // barriers: its entry goes stale, and — stale-never-primary — the primary
    // flips back to conn-2's t2 (poll: disconnect handling is async).
    ws1.close(None).await.expect("close ws1");
    drop(ws1);
    let mut disconnect_processed = false;
    for _ in 0..100u8 {
        let (tabs, _) = layout.list_tabs();
        if layout.stale_entry_count() == 1 && tabs[0]["id"] == serde_json::json!("t2") {
            disconnect_processed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        disconnect_processed,
        "the close must mark conn-1's entry stale and flip the primary to t2"
    );

    // (3) Retention: the disconnected client's ids still resolve (the
    // silent-reconnect window).
    assert!(
        layout.get_pane_snapshot("p1").is_some(),
        "a closed connection's snapshot must be retained as stale"
    );

    // (4) A THIRD connection (the reconnected client) syncs conn-1's EXACT
    // layout — covering all of the stale entry's pane ids — which supersedes
    // it losslessly. (conn-2's sync never contains p1, so under the subset
    // rule it must NOT be the superseder.)
    let mut ws3 = connect_and_hello(&url).await;
    sync_single_pane(&mut ws3, "t1", "p1", 400).await;
    let mut superseded = false;
    for _ in 0..100u8 {
        if layout.stale_entry_count() == 0 {
            superseded = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        superseded,
        "a live sync covering every stale pane id must evict the stale entry"
    );
    assert_eq!(layout.client_entry_count(), 2, "conn-2 + conn-3 remain");

    // Both surviving connections' ids keep resolving; the reconnected client
    // is the last writer, so default reads answer t1.
    assert!(layout.get_pane_snapshot("p1").is_some());
    assert!(layout.get_pane_snapshot("p2").is_some());
    let (tabs, _) = layout.list_tabs();
    assert_eq!(tabs[0]["id"], serde_json::json!("t1"));
}
