//! P1.8 write-trigger integration tests: a REAL axum server + REAL WS client
//! (shared harness), asserting the on-disk ledger rows that identity events
//! must produce — including across a "restart" (a second PaneLedger instance
//! over the same dir; the crate-level shape of the SIGKILL wall tests).

mod common;

use common::{
    connect_and_capture_inventory, next_frame_of_type, sleeper_cli_spec, spawn_server_with_ledger,
};
use freshell_ws::pane_ledger::{PaneLedger, RetiredReason, RowState};
use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message as WsMessage;

fn unique_ledger_dir(label: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "pane-ledger-it-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&dir).expect("ledger dir");
    dir
}

/// Poll (≤5s, the spec's wall) until `check` passes — identity durability
/// must be an event-driven guarantee, not a cadence race.
fn wait_for<F: Fn() -> bool>(check: F, what: &str) {
    for _ in 0..50 {
        if check() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    panic!("timed out (5s wall) waiting for {what}");
}

#[tokio::test(flavor = "multi_thread")]
async fn claude_preallocation_writes_a_binding_row_synchronously() {
    // Red test `SIGKILL-within-5s-of-pane-creation`, crate shape: by the
    // time terminal.created is answered, the binding row is on disk — a
    // SIGKILL any moment later cannot lose the identity. (The write runs
    // in an AWAITED spawn_blocking before the reply — same guarantee,
    // off the dispatch task; V1.md.)
    let dir = unique_ledger_dir("claude-prealloc");
    let (url, registry, _ledger_arc) =
        spawn_server_with_ledger(vec![sleeper_cli_spec("claude")], &dir).await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;

    // Fresh claude create — the server pre-allocates the session UUID.
    let create = serde_json::json!({
        "type": "terminal.create",
        "requestId": "req-claude-1",
        "mode": "claude",
        "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
    });
    ws.send(WsMessage::Text(create.to_string())).await.unwrap();
    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id = created["terminalId"].as_str().unwrap().to_string();
    let session_id = created["sessionRef"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    // The row must already be durable (the create handler awaits the
    // write before answering).
    let ledger = PaneLedger::new(Some(dir.clone()));
    let row = ledger
        .load_binding("claude", &session_id)
        .expect("binding row written at create");
    assert_eq!(row.state, RowState::Bound);
    assert_eq!(row.live_terminal_id.as_deref(), Some(terminal_id.as_str()));
    assert_eq!(row.create_request_id.as_deref(), Some("req-claude-1"));
    assert_eq!(row.mode, "claude");

    // Claude NEVER gets a pending marker — no resolver exists to clear it
    // (the marker trigger is an explicit resolver allowlist; V5.md/V7.md).
    assert!(ledger.pending_for_terminal(&terminal_id).is_none());
    assert!(ledger.list_pending_raw().is_empty());

    // "Restart": a brand-new ledger instance over the same dir still
    // answers — process death cannot lose it (its construction-time index
    // load reads the on-disk rows).
    drop(ledger);
    let gen2 = PaneLedger::new(Some(dir.clone()));
    assert!(gen2.ever_bound("claude", &session_id));

    registry.kill(&terminal_id);
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn fresh_identity_bearing_pane_gets_a_pending_marker_at_spawn() {
    // Trigger (d): identity in flight (fresh codex — no resume id) ->
    // durable pending marker from spawn until resolution.
    let dir = unique_ledger_dir("codex-pending");
    let (url, registry, server_ledger) =
        spawn_server_with_ledger(vec![sleeper_cli_spec("codex")], &dir).await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;

    let create = serde_json::json!({
        "type": "terminal.create",
        "requestId": "req-codex-1",
        "mode": "codex",
        "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
    });
    ws.send(WsMessage::Text(create.to_string())).await.unwrap();
    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id = created["terminalId"].as_str().unwrap().to_string();

    // Durability: a FRESH reader instance (constructed after the write —
    // its index load scans the dir) sees the marker on disk.
    let ledger = PaneLedger::new(Some(dir.clone()));
    let marker = ledger
        .pending_for_terminal(&terminal_id)
        .expect("pending marker written at spawn");
    assert_eq!(marker.mode, "codex");

    // Observed exit IN THIS EPOCH ends the identity-in-flight window: the
    // kill path must delete the marker (spec §4.2 marker GC rule). Poll the
    // SERVER'S OWN ledger Arc — reads answer from the in-memory index, so
    // only the mutating instance observes its own later deletions.
    let kill = serde_json::json!({ "type": "terminal.kill", "terminalId": terminal_id });
    ws.send(WsMessage::Text(kill.to_string())).await.unwrap();
    wait_for(
        || server_ledger.pending_for_terminal(&terminal_id).is_none(),
        "marker deleted on observed kill",
    );

    let _ = registry; // terminal already killed
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn resume_create_writes_binding_and_kill_retires_it_closed() {
    // Trigger (a/e): a resume create (identity known at spawn) writes the
    // binding row; an explicit user kill best-effort retires it `closed` —
    // never load-bearing, but recorded.
    let dir = unique_ledger_dir("resume-retire");
    let (url, _registry, server_ledger) =
        spawn_server_with_ledger(vec![sleeper_cli_spec("codex")], &dir).await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;

    let create = serde_json::json!({
        "type": "terminal.create",
        "requestId": "req-codex-2",
        "mode": "codex",
        "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
        "sessionRef": { "provider": "codex", "sessionId": "11111111-2222-3333-4444-555555555555" },
    });
    ws.send(WsMessage::Text(create.to_string())).await.unwrap();
    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id = created["terminalId"].as_str().unwrap().to_string();

    let ledger = PaneLedger::new(Some(dir.clone()));
    let row = ledger
        .load_binding("codex", "11111111-2222-3333-4444-555555555555")
        .expect("resume create wrote the binding");
    assert_eq!(row.state, RowState::Bound);

    let kill = serde_json::json!({ "type": "terminal.kill", "terminalId": terminal_id });
    ws.send(WsMessage::Text(kill.to_string())).await.unwrap();
    // Poll the SERVER'S ledger Arc (reads are index-backed; only the
    // mutating instance observes its own later writes).
    wait_for(
        || {
            server_ledger
                .load_binding("codex", "11111111-2222-3333-4444-555555555555")
                .is_some_and(|r| {
                    r.state == RowState::Retired && r.retired_reason == Some(RetiredReason::Closed)
                })
        },
        "binding retired closed on user kill",
    );
    std::fs::remove_dir_all(&dir).ok();
}
