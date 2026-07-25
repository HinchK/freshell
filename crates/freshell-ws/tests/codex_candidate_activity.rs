//! G3 integration: a FRESH codex terminal (no resume id) whose candidate is
//! adopted must broadcast `codex.activity.updated` carrying the sessionId,
//! and its subsequent turn completion must carry the same sessionId.
//! Uses the activity-enabled harness (the default harness has `activity: None`).
//!
//! This binary asserts the identity upsert only; the completion payoff is
//! covered at hub level (activity.rs unit tests) and e2e level.

#[cfg(unix)]
mod common;

#[cfg(unix)]
use futures_util::{SinkExt, StreamExt};
#[cfg(unix)]
use serde_json::json;
#[cfg(unix)]
use std::time::Duration;
#[cfg(unix)]
use tokio_tungstenite::tungstenite::Message as WsMessage;

/// Fake codex: records argv to $CODEX_ARGV_CAPTURE_PATH (atomic tmp+mv) then
/// sleeps. Copied from tests/codex_candidate_persisted.rs.
#[cfg(unix)]
fn write_fake_codex() -> std::path::PathBuf {
    let script_path = std::env::temp_dir().join(format!(
        "freshell-codex-candidate-activity-fake-{}.sh",
        std::process::id()
    ));
    let script = "#!/bin/sh\n\
        printf '%s\\n' \"$@\" > \"$CODEX_ARGV_CAPTURE_PATH.tmp\"\n\
        mv \"$CODEX_ARGV_CAPTURE_PATH.tmp\" \"$CODEX_ARGV_CAPTURE_PATH\"\n\
        exec sleep 300\n";
    std::fs::write(&script_path, script).expect("write fake codex script");
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms).unwrap();
    }
    script_path
}

#[cfg(unix)]
fn codex_capture_spec() -> freshell_platform::CliCommandSpec {
    freshell_platform::CliCommandSpec {
        name: "codex".to_string(),
        label: "Codex CLI".to_string(),
        env_var: None,
        default_cmd: write_fake_codex().to_string_lossy().to_string(),
        base_args: vec![],
        base_env: std::collections::BTreeMap::new(),
        // Real codex manifest shape: resume subcommand, no createSessionArgs.
        resume_args: Some(vec!["resume".to_string(), "{{sessionId}}".to_string()]),
        create_session_args: None,
        model_args: None,
        sandbox_args: None,
        permission_mode_args: None,
    }
}

/// Send a fresh `terminal.create` (no sessionRef, no resume id) and await its
/// `terminal.created`, returning the terminalId.
#[cfg(unix)]
async fn send_create(ws: &mut common::TestWs, mode: &str) -> String {
    ws.send(WsMessage::Text(
        json!({
            "type": "terminal.create",
            "requestId": "req-codex-activity-1",
            "mode": mode,
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.create");
    let created = common::next_frame_of_type(ws, "terminal.created").await;
    created["terminalId"]
        .as_str()
        .expect("terminal.created carries terminalId")
        .to_string()
}

/// Plain candidate announce (client announcing the persisted rollout).
/// Copied from tests/codex_candidate_persisted.rs.
#[cfg(unix)]
async fn send_candidate(
    ws: &mut common::TestWs,
    terminal_id: &str,
    thread_id: &str,
    rollout_path: &str,
) {
    ws.send(WsMessage::Text(
        json!({
            "type": "terminal.codex.candidate.persisted",
            "terminalId": terminal_id,
            "candidateThreadId": thread_id,
            "rolloutPath": rollout_path,
            "capturedAt": 1_753_300_000_000i64,
        })
        .to_string(),
    ))
    .await
    .expect("send candidate");
}

/// Scan WS text frames until `pred` matches or the 10s budget elapses.
/// Non-matching frames are simply skipped (no drop-on-mismatch semantics).
#[cfg(unix)]
async fn wait_for_frame(
    ws: &mut common::TestWs,
    pred: impl Fn(&serde_json::Value) -> bool,
) -> bool {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining.max(Duration::from_millis(1)), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if pred(&value) {
                        return true;
                    }
                }
            }
            Ok(Some(Ok(_))) => {}
            _ => return false, // stream ended, ws error, or timed out
        }
    }
    false
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn adopted_candidate_identity_reaches_codex_activity() {
    const THREAD: &str = "11111111-2222-3333-4444-555555555555";

    // ---- env setup (single sequential test: this binary owns process env) ----
    // CODEX_HOME tempdir + a real rollout whose first line is
    // session_meta { payload: { id: THREAD } } (adoption guard 4 disk truth).
    let codex_home = tempfile::tempdir().expect("codex home");
    let sessions_day = codex_home
        .path()
        .join("sessions")
        .join("2026")
        .join("07")
        .join("24");
    std::fs::create_dir_all(&sessions_day).expect("sessions tree");
    std::env::set_var("CODEX_HOME", codex_home.path());
    std::env::remove_var("FRESHELL_CODEX_MANAGED_LAUNCH");
    let capture = std::env::temp_dir().join(format!(
        "codex-candidate-activity-argv-{}.txt",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&capture);
    std::env::set_var("CODEX_ARGV_CAPTURE_PATH", &capture);

    let rollout = sessions_day.join(format!("rollout-2026-07-24T12-00-00-{THREAD}.jsonl"));
    std::fs::write(
        &rollout,
        format!("{{\"timestamp\":\"2026-07-24T12:00:00.000Z\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{THREAD}\"}}}}\n"),
    )
    .unwrap();
    let rollout_path = rollout.to_string_lossy().to_string();

    let (url, registry) =
        common::spawn_server_with_specs_and_activity(vec![codex_capture_spec()]).await;
    let (mut ws, _inventory) = common::connect_and_capture_inventory(&url).await;

    // 1. Create a FRESH codex terminal (no sessionRef, no resume id).
    let terminal_id = send_create(&mut ws, "codex").await;

    // 2. Send the candidate frame (client announcing the persisted rollout).
    send_candidate(&mut ws, &terminal_id, THREAD, &rollout_path).await;

    // 3. The adopt path must now emit codex.activity.updated with sessionId.
    //    Collect frames by scanning (never drop-on-mismatch).
    let bound = wait_for_frame(&mut ws, |v| {
        v["type"] == "codex.activity.updated"
            && v["upsert"]
                .as_array()
                .map(|u| {
                    u.iter().any(|r| {
                        r["terminalId"] == terminal_id.as_str() && r["sessionId"] == THREAD
                    })
                })
                .unwrap_or(false)
    })
    .await;
    assert!(
        bound,
        "expected codex.activity.updated carrying the adopted sessionId"
    );

    registry.kill(&terminal_id);
    std::env::remove_var("CODEX_HOME");
    std::env::remove_var("CODEX_ARGV_CAPTURE_PATH");
}
