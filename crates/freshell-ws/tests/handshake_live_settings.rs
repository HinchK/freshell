//! CFG-12 server-surface proof: a real `/ws` connect handshake resolves the
//! LIVE server-settings tree PER CONNECTION (legacy parity:
//! `server/index.ts:415-427`'s `handshakeSnapshotProvider` awaits
//! `configStore.getSettings()` on every hello; `ws-handler.ts:1815-1845`
//! sends that tree as `settings.updated`).
//!
//! Before CFG-12 the port emitted a boot-frozen `WsState.settings` snapshot in
//! every handshake, so a `PATCH /api/settings`-committed value (e.g.
//! `defaultCwd`) never reached a client that (re)connected after the patch --
//! and the client's last-write-wins application of the handshake frame erased
//! the correct value `/api/bootstrap` had already delivered (the e2e red at
//! `settings-persistence-split.spec.ts`'s defaultCwd leg).

mod common;

use std::time::Duration;

use futures_util::SinkExt;
use futures_util::StreamExt;
use tokio_tungstenite::tungstenite::Message as WsMessage;

/// Connect + hello, then scan the ordered handshake frames for
/// `settings.updated` (bounded; the clean handshake is 4 frames:
/// ready -> settings.updated -> perf.logging -> terminal.inventory).
async fn connect_and_capture_settings_updated(url: &str) -> (common::TestWs, serde_json::Value) {
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

    for _ in 0..8u8 {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("handshake message within timeout")
            .expect("stream not ended")
            .expect("no ws error");
        if let WsMessage::Text(text) = &msg {
            let value: serde_json::Value = serde_json::from_str(text).expect("json frame");
            if value["type"] == serde_json::json!("settings.updated") {
                return (ws, value);
            }
        }
    }
    panic!("handshake must contain settings.updated");
}

#[tokio::test]
async fn second_connection_handshake_carries_settings_written_after_first_connection() {
    let (url, _registry, live_settings) =
        common::spawn_server_with_specs_and_shared_settings(vec![]).await;

    // Connection 1 resolves the tree as of its hello: no `defaultCwd` yet
    // (the shared fixture tree has none).
    let (ws1, first) = connect_and_capture_settings_updated(&url).await;
    assert!(
        first["settings"].get("defaultCwd").is_none(),
        "pre-write handshake must not invent a defaultCwd: {first}"
    );

    // The PATCH-committed write lands in the SAME live tree the handshake
    // resolves (freshell-server wires `SettingsStore::shared_settings_lock()`
    // in here; one lock, no copies, no caching layer).
    live_settings.write().await.default_cwd = Some("/tmp/cfg12-live".to_string());

    // Connection 2 (a reload/reconnect) resolves the LIVE tree.
    let (_ws2, second) = connect_and_capture_settings_updated(&url).await;
    assert_eq!(
        second["settings"]["defaultCwd"],
        serde_json::json!("/tmp/cfg12-live"),
        "a later connection's settings.updated must carry the live tree: {second}"
    );

    drop(ws1);
}
