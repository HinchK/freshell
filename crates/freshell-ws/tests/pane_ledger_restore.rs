//! P1.8 read-side integration tests, exercised across server "generations"
//! sharing one ledger dir. Honesty (V7.md/V9.md): Read 1 (inventory
//! stamping) has NO production window today and its test FABRICATES one;
//! Read 3's ledger rung is production-reachable only via the orphaned
//! in-flight-create replay shape until P1.6 — comments on each test say
//! which. Read 2 (`ever_observed`) is live from day one.

mod common;
use common::*;

use freshell_ws::pane_ledger::BindingWrite;

fn unique_ledger_dir(label: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "pane-ledger-read-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&dir).expect("ledger dir");
    dir
}

#[tokio::test(flavor = "multi_thread")]
async fn inventory_stamping_falls_back_to_ledger_bound_rows() {
    // Authority chain (spec §4.2 precedence): in-memory registry first,
    // ledger bound rows second. HONESTY (V7.md / A21): this window is
    // FABRICATED — in production today, in-memory identity is written
    // adjacent to every ledger write and survives retirement, so a live
    // terminal with a ledger row but no in-memory identity does not occur;
    // the mainline consumer of this read arrives with Phase 3 / P1.13
    // (REST-created panes). The seam is pinned here so that consumer lands
    // on tested ground.
    let dir = unique_ledger_dir("stamp");
    let (url, registry, server_ledger) =
        spawn_server_with_ledger(vec![sleeper_cli_spec("codex")], &dir).await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;

    // Fresh codex: no in-memory identity entry is seeded at create.
    let create = serde_json::json!({
        "type": "terminal.create",
        "requestId": "req-stamp-1",
        "mode": "codex",
        "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
    });
    use futures_util::SinkExt;
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        create.to_string(),
    ))
    .await
    .unwrap();
    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id = created["terminalId"].as_str().unwrap().to_string();
    assert!(
        created.get("sessionRef").is_none(),
        "fresh codex has no create-time identity (precondition)"
    );

    // FABRICATE the window (see the test-top comment): seed a bound row for
    // this terminal WITHOUT the in-memory identity upsert that production
    // always performs alongside it. Written through the SERVER'S OWN Arc —
    // with the write-through index, only the server instance's writes are
    // visible to its own reads.
    server_ledger
        .record_binding(&BindingWrite {
            provider: "codex",
            session_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            terminal_id: &terminal_id,
            mode: "codex",
            cwd: None,
            create_request_id: Some("req-stamp-1"),
            now_ms: 1_000,
        })
        .unwrap();

    // A NEW connection's handshake inventory row must now be stamped from
    // the ledger (in-memory identity is still absent).
    let (_ws2, inventory) = connect_and_capture_inventory(&url).await;
    let row = inventory["terminals"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["terminalId"] == terminal_id.as_str())
        .expect("terminal in inventory");
    assert_eq!(row["sessionRef"]["provider"], "codex");
    assert_eq!(
        row["sessionRef"]["sessionId"],
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    );

    registry.kill(&terminal_id);
    std::fs::remove_dir_all(&dir).ok();
}
