//! Mid-session rebind: a bound codex pane whose CLI forks via in-TUI /resume
//! (new rollout, forked_from_id == bound id) must be rebound end-to-end.
//! Contract under test (incident 2026-07-27, session 019fa60f -> 019fa613):
//!   1. terminal.session.associated arrives with sessionRef.sessionId == NEW
//!      id AND previousSessionId == OLD id.
//!   2. registry meta resume_session_id == NEW id.
//!
//! Harness copied from codex_locator_activity.rs (the adoption-flow
//! precedent): real server, real socket, real PTY running a fake codex
//! binary, locator rooted at a tempdir sessions tree.

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

/// Fake codex: just parks the PTY (identity comes from the rollout files the
/// test writes into the locator's sessions root, never from the binary).
#[cfg(unix)]
fn write_fake_codex() -> std::path::PathBuf {
    let script_path = std::env::temp_dir().join(format!(
        "freshell-codex-fork-rebind-fake-{}.sh",
        std::process::id()
    ));
    let script = "#!/bin/sh\nexec sleep 300\n";
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
fn codex_spec() -> freshell_platform::CliCommandSpec {
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
            "requestId": "req-codex-fork-rebind-1",
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

/// Scan WS text frames until the next `terminal.session.associated` for
/// `terminal_id` arrives (10 s budget), returning the parsed frame.
/// Non-matching frames are simply skipped (no drop-on-mismatch semantics).
#[cfg(unix)]
async fn next_associated_frame(
    ws: &mut common::TestWs,
    terminal_id: &str,
    label: &str,
) -> serde_json::Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining.max(Duration::from_millis(1)), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if value["type"] == "terminal.session.associated"
                        && value["terminalId"] == terminal_id
                    {
                        return value;
                    }
                }
            }
            Ok(Some(Ok(_))) => {}
            other => panic!("[{label}] ws ended/errored/timed out awaiting associated: {other:?}"),
        }
    }
    panic!("[{label}] no terminal.session.associated frame for {terminal_id} within 10s");
}

/// The session_meta first line, exactly the shape the real codex CLI writes
/// (fork-shaped when `forked_from` is set: forked_from_id + thread_source
/// "user" -- the verified 019fa613 USER-fork child shape from Task 3/4).
#[cfg(unix)]
fn session_meta_line(thread_id: &str, cwd: &str, forked_from: Option<&str>) -> String {
    let mut payload = json!({ "id": thread_id, "session_id": thread_id, "cwd": cwd });
    if let Some(f) = forked_from {
        payload["forked_from_id"] = json!(f);
        payload["originator"] = json!("codex-tui");
        payload["thread_source"] = json!("user");
        payload["source"] = json!("cli");
    }
    json!({
        "timestamp": "2026-07-24T12:00:00.000Z",
        "type": "session_meta",
        "payload": payload,
    })
    .to_string()
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn in_tui_fork_rebinds_the_pane_identity() {
    const OLD: &str = "019fa60f-aaaa-4bbb-8ccc-000000000001";
    const NEW: &str = "019fa613-dddd-4eee-8fff-000000000002";

    // ---- env setup (single sequential test: this binary owns process env) ----
    let codex_home = tempfile::tempdir().expect("codex home");
    let sessions_root = codex_home.path().join("sessions");
    let sessions_day = sessions_root.join("2026").join("07").join("27");
    std::fs::create_dir_all(&sessions_day).expect("sessions tree");
    std::env::set_var("CODEX_HOME", codex_home.path());
    std::env::remove_var("FRESHELL_CODEX_MANAGED_LAUNCH");

    // 1. Spawn server with codex locator rooted at the temp sessions dir.
    let (url, registry) = common::spawn_server_with_specs_activity_and_codex_locator(
        vec![codex_spec()],
        &sessions_root,
    )
    .await;
    let (mut ws, _inventory) = common::connect_and_capture_inventory(&url).await;

    // 2. Create a fresh codex terminal (fake codex spec). The create arms the
    //    locator server-side.
    let terminal_id = send_create(&mut ws, "codex").await;

    // 2a. First Enter: takes the FIRST-submit re-snapshot and opens the 2 s
    //     adoption window -- the rollout must NOT exist yet.
    common::send_input(&mut ws, &terminal_id, "\r").await;
    // 2b. Let that first window resolve with zero candidates (2 s deadline +
    //     150 ms sweep, with margin).
    tokio::time::sleep(Duration::from_secs(3)).await;
    // 2c. NOW write rollout A (id = OLD; payload.cwd matches the pane's cwd).
    let cwd = std::env::temp_dir().to_string_lossy().to_string();
    let rollout_a = sessions_day.join(format!("rollout-2026-07-27T12-00-00-{OLD}.jsonl"));
    std::fs::write(
        &rollout_a,
        format!("{}\n", session_meta_line(OLD, &cwd, None)),
    )
    .unwrap();
    // 2d. Second Enter re-opens the resolved window WITHOUT re-snapshotting;
    //     rollout A is deterministically the sole new candidate.
    common::send_input(&mut ws, &terminal_id, "\r").await;

    // 2e. Drain until the adoption broadcast (existing behavior).
    let adopted = next_associated_frame(&mut ws, &terminal_id, "adoption").await;
    assert_eq!(
        adopted["sessionRef"]["sessionId"], OLD,
        "adoption must bind the OLD id first"
    );

    // 3. Drive Enter again (opens the fork-scan window), then write rollout B
    //    with payload.id == NEW and payload.forked_from_id == OLD.
    common::send_input(&mut ws, &terminal_id, "\r").await;
    let rollout_b = sessions_day.join(format!("rollout-2026-07-27T12-05-00-{NEW}.jsonl"));
    std::fs::write(
        &rollout_b,
        format!("{}\n", session_meta_line(NEW, &cwd, Some(OLD))),
    )
    .unwrap();

    // 4. The rebind broadcast: sessionRef.sessionId == NEW, and the frame
    //    names the identity it superseded.
    let rebound = next_associated_frame(&mut ws, &terminal_id, "fork-rebind").await;
    assert_eq!(
        rebound["sessionRef"]["sessionId"], NEW,
        "rebind must move the pane to the fork child"
    );
    assert_eq!(
        rebound["previousSessionId"], OLD,
        "rebind must carry previousSessionId == the superseded id"
    );

    // 5. Registry meta followed the move.
    let row = registry
        .identity_probe_rows()
        .into_iter()
        .find(|r| r.terminal_id == terminal_id)
        .expect("registry row for the pane");
    assert_eq!(
        row.resume_session_id.as_deref(),
        Some(NEW),
        "registry meta resume_session_id must be the NEW id"
    );

    registry.kill(&terminal_id);
    std::env::remove_var("CODEX_HOME");
}
