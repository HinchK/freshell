//! Silent-drop fix (bug-hunt pbh-20260807): the fresh-agent control frames the
//! frozen client really sends -- `freshAgent.approval.respond` (Approve/Deny
//! click), `freshAgent.question.respond` (question answer), `freshAgent.fork`
//! and `freshAgent.compact` -- used to fall into the typed dispatch's silent
//! `_ => true` catch-all (`terminal.rs`) and vanish: no reply, no log, and the
//! pane hung waiting forever. They must now answer on the wire with the
//! `freshAgent.error` event shape the client renders as a visible pane error
//! (`fresh-agent-ws.ts:333-342`) instead of being dropped.
//!
//! These tests drive a REAL axum server + REAL tokio-tungstenite client (same
//! harness as `unknown_terminal_reply.rs`, the kata-dtfn precedent). On the
//! pre-fix dispatch every test here times out waiting for ANY reply frame.

mod common;
use common::*;

use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message as WsMessage;

async fn send_json(ws: &mut TestWs, value: serde_json::Value) {
    ws.send(WsMessage::Text(value.to_string()))
        .await
        .expect("send control frame");
}

/// Assert the `freshAgent.event` reply wraps a visible (non-lost-session)
/// `freshAgent.error` for `session_id`.
fn assert_visible_error(frame: &serde_json::Value, session_id: &str, provider: &str) {
    assert_eq!(frame["provider"], serde_json::json!(provider));
    assert_eq!(frame["sessionId"], serde_json::json!(session_id));
    assert_eq!(
        frame["event"]["type"],
        serde_json::json!("freshAgent.error")
    );
    assert_eq!(frame["event"]["sessionId"], serde_json::json!(session_id));
    // Any code OTHER than INVALID_SESSION_ID renders as a visible pane error
    // client-side (`sessionError`); INVALID_SESSION_ID would instead mark the
    // session lost and trigger recovery, which this is not.
    assert_eq!(
        frame["event"]["code"],
        serde_json::json!("UNSUPPORTED_MESSAGE")
    );
    assert!(
        frame["event"]["message"]
            .as_str()
            .expect("error message is a string")
            .contains("not supported"),
        "the error must name the unsupported control frame: {frame}"
    );
}

#[tokio::test]
async fn approval_respond_answers_with_a_visible_fresh_agent_error() {
    let (url, _registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    // The exact frame shape FreshAgentView.tsx:2339 sends on an Approve click.
    send_json(
        &mut ws,
        serde_json::json!({
            "type": "freshAgent.approval.respond",
            "provider": "claude",
            "sessionId": "ses-approve-1",
            "sessionType": "freshclaude",
            "decision": { "approved": true, "scope": "once" },
            "requestId": "perm-1",
        }),
    )
    .await;

    let frame = next_frame_of_type(&mut ws, "freshAgent.event").await;
    assert_visible_error(&frame, "ses-approve-1", "claude");
}

#[tokio::test]
async fn question_respond_answers_with_a_visible_fresh_agent_error() {
    let (url, _registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    // FreshAgentView.tsx:2462's answer frame (requestId may be a number).
    send_json(
        &mut ws,
        serde_json::json!({
            "type": "freshAgent.question.respond",
            "provider": "claude",
            "sessionId": "ses-question-1",
            "sessionType": "freshclaude",
            "answers": { "q1": "yes" },
            "requestId": 42,
        }),
    )
    .await;

    let frame = next_frame_of_type(&mut ws, "freshAgent.event").await;
    assert_visible_error(&frame, "ses-question-1", "claude");
}

#[tokio::test]
async fn fork_answers_with_a_visible_fresh_agent_error() {
    let (url, _registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    // FreshAgentView.tsx:1080's fork frame.
    send_json(
        &mut ws,
        serde_json::json!({
            "type": "freshAgent.fork",
            "provider": "codex",
            "sessionId": "ses-fork-1",
            "sessionType": "freshcodex",
            "requestId": "fork-req-1",
        }),
    )
    .await;

    let frame = next_frame_of_type(&mut ws, "freshAgent.event").await;
    assert_visible_error(&frame, "ses-fork-1", "codex");
}

#[tokio::test]
async fn compact_answers_with_a_visible_fresh_agent_error() {
    let (url, _registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    // FreshAgentView.tsx:1100's compact frame.
    send_json(
        &mut ws,
        serde_json::json!({
            "type": "freshAgent.compact",
            "provider": "claude",
            "sessionId": "ses-compact-1",
            "sessionType": "freshclaude",
        }),
    )
    .await;

    let frame = next_frame_of_type(&mut ws, "freshAgent.event").await;
    assert_visible_error(&frame, "ses-compact-1", "claude");
}

#[tokio::test]
async fn handled_control_frames_still_reach_their_dispatch_arms() {
    // Guard: the interception must not swallow a HANDLED sibling -- `ping`
    // (the simplest round-trip control frame) still answers `pong`.
    let (url, _registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    send_json(&mut ws, serde_json::json!({ "type": "ping" })).await;
    let frame = next_frame_of_type(&mut ws, "pong").await;
    assert!(frame["timestamp"].is_string(), "pong carries a timestamp");
}
