//! Kata 1wxv Task 1: `freshAgent.undo` / `freshAgent.redo` land contract-first —
//! until each provider leg (Tasks 2-4) replaces its refusal with a real dispatch,
//! every provider x op cell is answered ON THE REQUESTING CONNECTION with the
//! nested `freshAgent.error{UNSUPPORTED_CAPABILITY}` shape stamped `rollback:true`
//! and echoing `requestId` (so the initiating pane routes the rejection to its
//! notice banner instead of the pane error surface). Codex x redo is refused
//! PERMANENTLY (decision 5); amplifier x op cells are refused permanently
//! (no amplifier fresh-agent runtime exists). Harness: `freshagent_control_reply.rs`.

mod common;
use common::*;

use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message as WsMessage;

async fn send_json(ws: &mut TestWs, value: serde_json::Value) {
    ws.send(WsMessage::Text(value.to_string()))
        .await
        .expect("send rollback frame");
}

fn assert_rollback_refusal(
    frame: &serde_json::Value,
    session_id: &str,
    provider: &str,
    session_type: &str,
    request_id: &str,
    message: &str,
) {
    assert_eq!(
        frame["type"],
        serde_json::json!("freshAgent.event"),
        "{frame}"
    );
    assert_eq!(frame["provider"], serde_json::json!(provider), "{frame}");
    assert_eq!(frame["sessionId"], serde_json::json!(session_id), "{frame}");
    assert_eq!(
        frame["sessionType"],
        serde_json::json!(session_type),
        "{frame}"
    );
    assert_eq!(
        frame["event"]["type"],
        serde_json::json!("freshAgent.error"),
        "{frame}"
    );
    assert_eq!(
        frame["event"]["code"],
        serde_json::json!("UNSUPPORTED_CAPABILITY"),
        "{frame}"
    );
    assert_eq!(
        frame["event"]["message"],
        serde_json::json!(message),
        "{frame}"
    );
    assert_eq!(
        frame["event"]["requestId"],
        serde_json::json!(request_id),
        "{frame}"
    );
    assert_eq!(
        frame["event"]["rollback"],
        serde_json::json!(true),
        "{frame}"
    );
}

#[tokio::test]
async fn undo_is_refused_for_providers_whose_leg_has_not_landed() {
    // Kata 1wxv Tasks 2+3: the codex x undo and opencode x undo cells left this
    // matrix — they are REAL DISPATCH now (`FreshCodexState::handle_rollback` /
    // `FreshOpencodeState::handle_rollback`; an undo for an unknown session
    // answers INVALID_SESSION_ID, never the table). Claude (freshclaude +
    // kilroy) stays refused until Task 4; amplifier cells are refused
    // permanently (no amplifier fresh-agent runtime exists).
    let (url, _registry) = spawn_server().await;
    for (provider, session_type) in [("claude", "freshclaude"), ("claude", "kilroy")] {
        let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;
        send_json(
            &mut ws,
            serde_json::json!({
                "type": "freshAgent.undo", "provider": provider, "sessionId": "s-rb",
                "sessionType": session_type, "requestId": "rb-u-1",
            }),
        )
        .await;
        let frame = next_frame_of_type(&mut ws, "freshAgent.event").await;
        assert_rollback_refusal(
            &frame,
            "s-rb",
            provider,
            session_type,
            "rb-u-1",
            &format!("Undo is not supported for {session_type}"),
        );
    }
}

#[tokio::test]
async fn redo_is_refused_for_every_provider_until_its_leg_lands() {
    // The codex x redo row NEVER leaves this matrix: codex history revert is
    // destructive and codex has no redo primitive (decision 5) — the refusal
    // is PERMANENT for that cell. Kata 1wxv Task 3: the opencode x redo cell is
    // REAL DISPATCH (re-revert/unrevert), no longer refused. Claude redo stays
    // refused only until its leg lands (Task 4).
    let (url, _registry) = spawn_server().await;
    for (provider, session_type) in [
        ("claude", "freshclaude"),
        ("claude", "kilroy"),
        // PERMANENT (decision 5): codex x redo.
        ("codex", "freshcodex"),
    ] {
        let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;
        send_json(
            &mut ws,
            serde_json::json!({
                "type": "freshAgent.redo", "provider": provider, "sessionId": "s-rb",
                "sessionType": session_type, "requestId": "rb-r-1", "mode": "step",
            }),
        )
        .await;
        let frame = next_frame_of_type(&mut ws, "freshAgent.event").await;
        assert_rollback_refusal(
            &frame,
            "s-rb",
            provider,
            session_type,
            "rb-r-1",
            &format!("Redo is not supported for {session_type}"),
        );
    }
}
