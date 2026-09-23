//! The `freshAgent.create` WS lane must never SILENTLY swallow a create
//! while the shared `settings.freshAgent.enabled` gate is off. The dispatch
//! gate (`terminal.rs`'s `FreshAgentCreate` arm) previously dropped the
//! frame with no reply of any kind, so every programmatic driver (the
//! native session-names contract runner, any agent bridging the raw WS
//! protocol) hung its pending create forever with zero attribution —
//! observed end-to-end in the native smoke: the server logged nothing, the
//! client saw no frame past the handshake broadcasts, and the leg died as
//! `frame freshAgent.created timeout`. The refusal rides the raw-layer
//! envelope precedent: `freshAgent.create.failed` carries the requestId, so
//! the pending create rejects with a machine-readable reason instead of
//! parking forever.

mod common;

use common::{connect_and_capture_inventory, next_frame_of_type, spawn_server};
use futures_util::SinkExt;
use serde_json::json;
use tokio_tungstenite::tungstenite::Message as WsMessage;

/// Send a freshAgent.create against the DEFAULT harness server (its
/// `fresh_codex` state boots with `freshAgent.enabled = false`) and return
/// the refusal frame. The frame shape is the real client's
/// (`FreshAgentView.tsx`): requestId + sessionType + provider + cwd.
async fn send_create_expect_refusal(provider: &str, session_type: &str) -> serde_json::Value {
    let (ws_url, _registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&ws_url).await;
    ws.send(WsMessage::Text(
        json!({
            "type": "freshAgent.create",
            "requestId": format!("req-disabled-{provider}"),
            "sessionType": session_type,
            "provider": provider,
            "cwd": "/tmp/freshell-disabled-refusal",
        })
        .to_string(),
    ))
    .await
    .expect("send freshAgent.create");
    next_frame_of_type(&mut ws, "freshAgent.create.failed").await
}

#[tokio::test(flavor = "multi_thread")]
async fn disabled_gate_answers_a_codex_create_refusal_not_silence() {
    let frame = send_create_expect_refusal("codex", "freshcodex").await;
    assert_eq!(
        frame["code"],
        json!("FRESH_AGENT_DISABLED"),
        "frame: {frame}"
    );
    assert_eq!(frame["requestId"], json!("req-disabled-codex"));
    // Legacy parity (`ws-handler.ts:3334`): the disabled-gate rejection is
    // retryable (flipping the setting makes the same create succeed).
    assert_eq!(frame["retryable"], json!(true));
}

#[tokio::test(flavor = "multi_thread")]
async fn disabled_gate_answers_a_claude_create_refusal_not_silence() {
    let frame = send_create_expect_refusal("claude", "freshclaude").await;
    assert_eq!(
        frame["code"],
        json!("FRESH_AGENT_DISABLED"),
        "frame: {frame}"
    );
    assert_eq!(frame["requestId"], json!("req-disabled-claude"));
}
