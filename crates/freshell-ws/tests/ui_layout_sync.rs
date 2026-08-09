//! AUTO-01: WS ingestion of `ui.layout.sync` (legacy `ws-handler.ts:2025-2039`).
//!
//! The connected browser UI mirrors its Redux layout via
//! `src/store/layoutMirrorMiddleware.ts`; the server ingests the mirror into
//! the shared `LayoutStore` (freshell-freshagent), normalized exactly like
//! legacy's `LayoutStore.updateFromUi`. These tests drive a REAL websocket
//! connection through the harness and assert the store's state.

mod common;

use common::{connect_and_capture_inventory, spawn_server_with_specs_and_state, TestWs};
use futures_util::SinkExt;
use serde_json::json;
use tokio_tungstenite::tungstenite::Message as WsMessage;

fn layout_sync_frame(tabs: serde_json::Value, layouts: serde_json::Value) -> serde_json::Value {
    let active_tab_id = tabs[0]["id"].clone();
    json!({
        "type": "ui.layout.sync",
        "tabs": tabs,
        "activeTabId": active_tab_id,
        "layouts": layouts,
        "activePane": { active_tab_id.as_str().unwrap_or(""): "pane_1" },
        "paneTitles": {},
        "paneTitleSetByUser": {},
        "timestamp": 1_720_000_000_000_i64,
    })
}

async fn send_json(ws: &mut TestWs, frame: serde_json::Value) {
    ws.send(WsMessage::Text(frame.to_string()))
        .await
        .expect("send");
}

#[tokio::test]
async fn ui_layout_sync_updates_the_shared_layout_store() {
    let (url, _registry, state) = spawn_server_with_specs_and_state(vec![]).await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    // Frame from the REAL client middleware shape: nested split with a legacy
    // `agent-chat` leaf that the store must normalize on ingest.
    send_json(
        &mut ws,
        layout_sync_frame(
            json!([{ "id": "tab_r", "title": "Remote" }]),
            json!({
                "tab_r": {
                    "type": "split",
                    "id": "split_1",
                    "direction": "horizontal",
                    "sizes": [60, 40],
                    "children": [
                        {
                            "type": "leaf",
                            "id": "pane_1",
                            "content": {
                                "kind": "agent-chat",
                                "provider": "claude",
                                "createRequestId": "req-1",
                                "status": "idle",
                                "resumeSessionId": "11111111-1111-4111-8111-111111111111",
                            },
                        },
                        {
                            "type": "leaf",
                            "id": "pane_2",
                            "content": { "kind": "terminal", "terminalId": "term_2", "mode": "shell" },
                        },
                    ],
                }
            }),
        ),
    )
    .await;

    // The ingest is synchronous on the read loop; send a ping so its `pong`
    // proves the sync frame was processed before we read the store.
    send_json(&mut ws, json!({ "type": "ping" })).await;
    let _pong = common::next_frame_of_type(&mut ws, "pong").await;

    let store = state.fresh_opencode.fresh_agent().layout_store().clone();
    let snap = store.get_normalized_snapshot(None);
    assert_eq!(snap["tabs"], json!([{ "id": "tab_r", "title": "Remote" }]));
    assert_eq!(snap["activeTabId"], json!("tab_r"));
    let tree = &snap["layouts"]["tab_r"];
    assert_eq!(tree["type"], json!("split"));
    assert_eq!(tree["sizes"], json!([60, 40]));
    assert!(serde_json::to_string(tree)
        .expect("serialize")
        .contains("\"fresh-agent\""));
    assert!(!serde_json::to_string(tree)
        .expect("serialize")
        .contains("\"agent-chat\""));
    assert_eq!(
        tree["children"][0]["content"]["sessionRef"],
        json!({ "provider": "claude", "sessionId": "11111111-1111-4111-8111-111111111111" })
    );
    // Derived titles seeded on ingest ("Shell" for the modeless terminal).
    assert_eq!(snap["paneTitles"]["tab_r"]["pane_2"], json!("Shell"));
    assert_eq!(snap["timestamp"], json!(1_720_000_000_000_i64));
    assert!(store.source_connection_id().is_some());
}

#[tokio::test]
async fn ui_layout_sync_last_write_wins_across_connections() {
    let (url, _registry, state) = spawn_server_with_specs_and_state(vec![]).await;
    let (mut ws_a, _i1) = connect_and_capture_inventory(&url).await;
    let (mut ws_b, _i2) = connect_and_capture_inventory(&url).await;

    send_json(
        &mut ws_a,
        layout_sync_frame(
            json!([{ "id": "tab_from_a", "title": "A" }]),
            json!({ "tab_from_a": { "type": "leaf", "id": "pane_1", "content": { "kind": "terminal" } } }),
        ),
    )
    .await;
    send_json(&mut ws_a, json!({ "type": "ping" })).await;
    let _ = common::next_frame_of_type(&mut ws_a, "pong").await;
    let store = state.fresh_opencode.fresh_agent().layout_store().clone();
    assert_eq!(store.active_tab_id().as_deref(), Some("tab_from_a"));
    let source_after_a = store.source_connection_id().expect("source recorded");

    send_json(
        &mut ws_b,
        layout_sync_frame(
            json!([{ "id": "tab_from_b", "title": "B" }]),
            json!({ "tab_from_b": { "type": "leaf", "id": "pane_1", "content": { "kind": "browser", "url": "https://docs.example.com/x", "devToolsOpen": false } } }),
        ),
    )
    .await;
    send_json(&mut ws_b, json!({ "type": "ping" })).await;
    let _ = common::next_frame_of_type(&mut ws_b, "pong").await;

    // Legacy semantics: the second client's mirror REPLACES the whole
    // snapshot; the winning connection is recorded (AUTO-14's substrate).
    let snap = store.get_normalized_snapshot(None);
    assert_eq!(snap["activeTabId"], json!("tab_from_b"));
    assert!(snap["layouts"].get("tab_from_a").is_none());
    assert_eq!(
        snap["paneTitles"]["tab_from_b"]["pane_1"],
        json!("docs.example.com")
    );
    let source_after_b = store.source_connection_id().expect("source recorded");
    assert_ne!(source_after_a, source_after_b);
}

#[tokio::test]
async fn ui_layout_sync_ingest_never_replies() {
    let (url, _registry, _state) = spawn_server_with_specs_and_state(vec![]).await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;
    send_json(
        &mut ws,
        layout_sync_frame(
            json!([{ "id": "tab_q", "title": "Q" }]),
            json!({ "tab_q": { "type": "leaf", "id": "pane_1", "content": { "kind": "terminal" } } }),
        ),
    )
    .await;
    // No frame may arrive until we provoke one (ping -> pong): legacy's
    // ui.layout.sync case `return`s without sending anything.
    send_json(&mut ws, json!({ "type": "ping" })).await;
    let pong = common::next_frame_of_type(&mut ws, "pong").await;
    assert_eq!(pong["type"], json!("pong"));
}

#[tokio::test]
async fn ui_layout_sync_is_served_back_through_rest_on_the_same_process() {
    let (url, _registry, state) = spawn_server_with_specs_and_state(vec![]).await;
    // Mount the fresh-agent REST router against the SAME FreshAgentState the
    // WS dispatch feeds — the shape freshell-server's main.rs production
    // composition has (one store per process).
    let rest_router = freshell_freshagent::router(state.fresh_opencode.fresh_agent().clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, rest_router).await;
    });

    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;
    send_json(
        &mut ws,
        layout_sync_frame(
            json!([{ "id": "tab_ws", "title": "WS-fed tab" }]),
            json!({
                "tab_ws": {
                    "type": "split",
                    "id": "split_ws",
                    "direction": "horizontal",
                    "sizes": [33, 67],
                    "children": [
                        { "type": "leaf", "id": "pane_1", "content": { "kind": "terminal", "terminalId": "term_ws", "mode": "shell" } },
                        { "type": "leaf", "id": "pane_2", "content": { "kind": "editor", "filePath": "/tmp/ws.md" } },
                    ],
                }
            }),
        ),
    )
    .await;
    send_json(&mut ws, json!({ "type": "ping" })).await;
    let _ = common::next_frame_of_type(&mut ws, "pong").await;

    // The authoritative layout is now observable over REST — browser, CLI,
    // and MCP all read THIS (AUTO-01's whole point).
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("http://{addr}/api/layout/snapshot"))
        .header("x-auth-token", common::AUTH_TOKEN)
        .send()
        .await
        .expect("GET /api/layout/snapshot");
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value =
        serde_json::from_str(&resp.text().await.expect("body text")).expect("json body");
    let data = &body["data"];
    assert_eq!(
        data["tabs"],
        json!([{ "id": "tab_ws", "title": "WS-fed tab" }])
    );
    assert_eq!(data["activeTabId"], json!("tab_ws"));
    let tree = &data["layouts"]["tab_ws"];
    assert_eq!(tree["type"], json!("split"));
    assert_eq!(tree["id"], json!("split_ws"));
    assert_eq!(tree["sizes"], json!([33, 67]));
    assert_eq!(data["activePane"]["tab_ws"], json!("pane_1"));
    assert_eq!(data["paneTitles"]["tab_ws"]["pane_1"], json!("Shell"));
    assert_eq!(data["paneTitles"]["tab_ws"]["pane_2"], json!("ws.md"));

    let resp = client
        .get(format!("http://{addr}/api/panes?tabId=tab_ws"))
        .header("x-auth-token", common::AUTH_TOKEN)
        .send()
        .await
        .expect("GET /api/panes");
    let body: serde_json::Value =
        serde_json::from_str(&resp.text().await.expect("body text")).expect("json body");
    assert_eq!(
        body["data"]["panes"],
        json!([
            { "id": "pane_1", "index": 0, "kind": "terminal", "terminalId": "term_ws", "title": "Shell", "tabId": "tab_ws" },
            { "id": "pane_2", "index": 1, "kind": "editor", "terminalId": null, "title": "ws.md", "tabId": "tab_ws" },
        ])
    );

    let resp = client
        .get(format!("http://{addr}/api/tabs"))
        .header("x-auth-token", common::AUTH_TOKEN)
        .send()
        .await
        .expect("GET /api/tabs");
    let body: serde_json::Value =
        serde_json::from_str(&resp.text().await.expect("body text")).expect("json body");
    assert_eq!(
        body["data"],
        json!({
            "tabs": [{ "id": "tab_ws", "title": "WS-fed tab", "activePaneId": "pane_1" }],
            "activeTabId": "tab_ws",
        })
    );
}
