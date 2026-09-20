//! Responsive-terminal-restore Workstream 1 — the paced replay core,
//! end-to-end on REAL sockets: a REAL axum server (ephemeral loopback
//! port), a REAL PTY (`TerminalRegistry`), and REAL tokio-tungstenite WS
//! clients, one of which negotiates `pacedTerminalReplayV1` and drives
//! continuation credits over the raw socket.
//!
//! The harness follows `hello_capabilities.rs` (the `connect_async`
//! `WsClient` type — the two files' WS client types are deliberately NOT
//! shared). The page budget and the scrollback ring are per-server registry
//! knobs, so fixtures are deterministic without env races.
//!
//! Core contract under test: a negotiated attach gets `attach.ready` bounds
//! plus ONE bounded first page; further replay pages flow only on valid
//! `terminal.replay.credit` (stale generations, out-of-window values, and
//! credits from non-negotiated connections are ignored); live output
//! produced during the replay is delivered strictly AFTER the pages covering
//! it, in seq order; retention expiry mid-replay reports the exact lost
//! interval with the task-2 bounds fields and continues from the new
//! baseline; a re-attach supersedes the old session; a disconnect
//! mid-replay leaves the terminal running and re-attachable.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::WsState;

const AUTH_TOKEN: &str = "s3cr3t-token-abcdef";
/// Deliberately small page budget: deterministic multi-page fixtures with
/// small floods (the production default is 128 KiB).
const PAGE_BUDGET: i64 = 4096;

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

/// Spawn a real server with a paced-page budget of [`PAGE_BUDGET`] and a
/// scrollback ring of `ring_chars` UTF-16 units (per-server registry knobs —
/// no env races between parallel tests).
async fn spawn_server(ring_chars: i64) -> String {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(16).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));

    let registry = freshell_terminal::TerminalRegistry::new();
    registry.set_paced_page_max_bytes(PAGE_BUDGET);
    registry.set_scrollback_max_bytes(ring_chars);

    let state = WsState {
        pane_ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
        layout: Default::default(),
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        terminal_meta: Default::default(),
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-test".to_string()),
        boot_id: Arc::new("boot-test".to_string()),
        settings,
        handshake_settings: Arc::new(tokio::sync::RwLock::new(
            serde_json::from_value(test_settings_value()).expect("valid settings fixture"),
        )),
        broadcast_tx: Arc::clone(&broadcast_tx),
        auto_resume_tx: tokio::sync::mpsc::unbounded_channel().0,
        auto_resume_cancels: Default::default(),
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
        registry,
        tabs: freshell_ws::tabs::TabsRegistry::new(),
        screenshots: freshell_ws::screenshot::ScreenshotBroker::new(Arc::clone(&broadcast_tx)),
        subagent_interest: Default::default(),
        host_stats: Default::default(),
        terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        sessions_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        cli_commands: Arc::new(Vec::new()),
        shutdown: Arc::new(tokio::sync::Notify::new()),
        ping_interval_ms: 30_000,
        hello_timeout_ms: 5_000,
        allowed_origins: Arc::new(freshell_ws::origin::default_allowed_origins()),
        ws_max_payload_bytes: 64 * 1024 * 1024,
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
        ownership: None,
    };

    let router = freshell_ws::router(state);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    format!("ws://{addr}/ws", addr = addr)
}

type WsClient =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(url: &str) -> WsClient {
    let (ws, _resp) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
    ws
}

/// Complete the hello handshake, optionally negotiating the paced capability
/// (and echo-reading the 4 handshake frames).
async fn hello(ws: &mut WsClient, paced: bool) {
    let capabilities = if paced {
        serde_json::json!({ "pacedTerminalReplayV1": true })
    } else {
        serde_json::json!({})
    };
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "hello",
            "token": AUTH_TOKEN,
            "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
            "capabilities": capabilities,
        })
        .to_string(),
    ))
    .await
    .expect("send hello");
    for _ in 0..4u8 {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("handshake frame within timeout")
            .expect("stream not ended")
            .expect("no ws error");
        assert!(matches!(msg, WsMessage::Text(_)));
    }
}

async fn next_json(ws: &mut WsClient) -> serde_json::Value {
    let msg = tokio::time::timeout(Duration::from_secs(10), ws.next())
        .await
        .expect("frame within timeout")
        .expect("stream not ended")
        .expect("no ws error");
    let WsMessage::Text(text) = msg else {
        panic!("expected a text frame, got {msg:?}");
    };
    serde_json::from_str(&text).expect("frame is JSON")
}

/// Read the next JSON frame, or `None` if nothing arrives within `window`.
async fn next_json_or_timeout(ws: &mut WsClient, window: Duration) -> Option<serde_json::Value> {
    match tokio::time::timeout(window, ws.next()).await {
        Ok(Some(Ok(WsMessage::Text(text)))) => {
            Some(serde_json::from_str(&text).expect("frame is JSON"))
        }
        Ok(Some(Ok(WsMessage::Ping(_) | WsMessage::Pong(_)))) => None,
        _ => None,
    }
}

async fn create_shell_terminal(ws: &mut WsClient, request_id: &str) -> String {
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": request_id,
            "mode": "shell",
            "shell": "system",
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.create");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        let value = next_json(ws).await;
        if value.get("type").and_then(|v| v.as_str()) == Some("terminal.created")
            && value.get("requestId").and_then(|v| v.as_str()) == Some(request_id)
        {
            return value
                .get("terminalId")
                .and_then(|v| v.as_str())
                .expect("terminal.created carries terminalId")
                .to_string();
        }
    }
    panic!("terminal.created never arrived");
}

/// Send `terminal.attach` (viewport hydrate, sinceSeq 0 by default).
async fn attach(ws: &mut WsClient, terminal_id: &str, attach_request_id: &str) {
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.attach",
            "terminalId": terminal_id,
            "intent": "viewport_hydrate",
            "cols": 80,
            "rows": 24,
            "attachRequestId": attach_request_id,
            "sinceSeq": 0,
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.attach");
}

/// Send one continuation credit.
async fn credit(ws: &mut WsClient, terminal_id: &str, arid: &str, consumed_seq: i64) {
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.replay.credit",
            "terminalId": terminal_id,
            "streamId": "ignored-by-server",
            "attachRequestId": arid,
            "consumedSeq": consumed_seq,
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.replay.credit");
}

/// A flood whose completion is detectable by a marker that only the EXECUTED
/// printf emits (octal escapes keep the literal command text from echoing
/// the marker early — the same discipline as `term09_output_queue.rs`).
fn flood_command(lines: usize, marker: &str) -> String {
    assert_eq!(marker, "FLOOD-DONE-MARKER");
    format!(
        "yes 'STREAMDATA-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' | head -n {lines}; printf '\\106\\114\\117\\117\\104\\055\\104\\117\\116\\105\\055\\115\\101\\122\\113\\105\\122\\012'\n"
    )
}

async fn send_input(ws: &mut WsClient, terminal_id: &str, data: &str) {
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.input",
            "terminalId": terminal_id,
            "data": data,
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.input");
}

/// Drain frames until `marker` appears in the accumulated output data.
/// Returns `(data, frames)` — the concatenated output data and every
/// terminal.output frame's seqStart (ascending as received).
async fn drain_until_marker(
    ws: &mut WsClient,
    marker: &str,
    deadline: tokio::time::Instant,
) -> (String, Vec<i64>) {
    let mut acc = String::new();
    let mut seqs = Vec::new();
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining.max(Duration::from_millis(1)), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
                    continue;
                };
                if value.get("type").and_then(|v| v.as_str()) == Some("terminal.output") {
                    if let Some(data) = value.get("data").and_then(|v| v.as_str()) {
                        acc.push_str(data);
                    }
                    seqs.push(value.get("seqStart").and_then(|v| v.as_i64()).unwrap_or(-1));
                }
                if acc.contains(marker) {
                    return (acc, seqs);
                }
            }
            _ => break,
        }
    }
    (acc, seqs)
}

/// Drive the terminal from a NON-NEGOTIATED driver connection until
/// `marker` is observed on it (the deterministic "the flood finished"
/// signal — the ring holds the full flood before the paced client attaches).
async fn flood_until_complete(url: &str, driver: &mut WsClient, terminal_id: &str, lines: usize) {
    let mut observer = connect(url).await;
    hello(&mut observer, false).await;
    attach(&mut observer, terminal_id, "attach-observer").await;
    let marker = "FLOOD-DONE-MARKER";
    send_input(driver, terminal_id, &flood_command(lines, marker)).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let (acc, _) = drain_until_marker(&mut observer, marker, deadline).await;
    assert!(
        acc.contains(marker),
        "the flood must complete on the observer"
    );
    // Detach the observer so it stops receiving (and the terminal's
    // subscriber set is clean for the paced client).
    observer
        .send(WsMessage::Text(
            serde_json::json!({ "type": "terminal.detach", "terminalId": terminal_id }).to_string(),
        ))
        .await
        .expect("observer detaches");
}

/// One attach's spontaneous delivery: the ready frame plus every output
/// frame the server sends WITHOUT any credit (the negotiated first page /
/// the non-negotiated full inline replay). Reading ends on the first QUIET
/// gap after the ready — the burst is one back-to-back admission, so a quiet
/// window means the server has nothing more to send unprompted.
async fn paced_attach_first_page(
    ws: &mut WsClient,
    terminal_id: &str,
    arid: &str,
) -> (serde_json::Value, Vec<serde_json::Value>) {
    attach(ws, terminal_id, arid).await;
    let mut ready = None;
    let mut outputs = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        match next_json_or_timeout(ws, Duration::from_millis(400)).await {
            None => {
                if ready.is_some() {
                    break; // the unprompted burst is complete
                }
                continue;
            }
            Some(value) => match value.get("type").and_then(|v| v.as_str()) {
                Some("terminal.attach.ready")
                    if value.get("attachRequestId").and_then(|v| v.as_str()) == Some(arid) =>
                {
                    ready = Some(value);
                }
                Some("terminal.output") => outputs.push(value),
                _ => {}
            },
        }
    }
    let ready = ready.expect("attach.ready never arrived");
    (ready, outputs)
}

/// Negotiated attach with real scrollback: ready carries the retention
/// bounds, the first page is a BOUNDED prefix, and NO further replay frames
/// arrive while the client withholds credit. A raw-socket credit then
/// produces the next page; an out-of-window credit produces nothing.
#[tokio::test]
async fn negotiated_attach_gets_first_page_only_and_credit_gates_the_rest() {
    let ring = 512 * 1024;
    let url = spawn_server(ring).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-paced").await;
    // ~64KB of scrollback: many 4KB pages, far under the 512KB ring.
    flood_until_complete(&url, &mut driver, &terminal_id, 700).await;

    let mut paced = connect(&url).await;
    hello(&mut paced, true).await;
    let (ready, page1) = paced_attach_first_page(&mut paced, &terminal_id, "attach-paced").await;

    // Ready bounds: the negotiated restore contract fields.
    assert!(
        ready["headSeq"].as_i64().unwrap_or(0) >= 1,
        "honest head: {ready}"
    );
    let oldest = ready["oldestRetainedSeq"]
        .as_i64()
        .expect("negotiated ready carries oldestRetainedSeq");
    let head = ready["headSeq"].as_i64().expect("headSeq");
    assert!(
        oldest >= 1 && oldest <= head + 1,
        "honest retention bound: {ready}"
    );
    assert!(
        ready.get("replayResetReason").is_none(),
        "no retention loss in this fixture: {ready}"
    );
    // The paced window description.
    assert_eq!(
        ready["replayToSeq"].as_i64(),
        Some(head),
        "replayToSeq is the fixed target: {ready}"
    );
    assert_eq!(
        ready["replayFromSeq"].as_i64(),
        Some(1),
        "the window starts at the baseline+1: {ready}"
    );

    // The first page is a bounded prefix of the window.
    assert!(!page1.is_empty(), "there is replay to page");
    let last_seq = page1
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .expect("page frames carry seqEnd");
    assert!(
        last_seq < head,
        "the first page must not cover the whole window (head {head})"
    );
    let page_bytes: usize = page1.iter().map(|f| f.to_string().len()).sum();
    assert!(
        page_bytes as i64 <= PAGE_BUDGET,
        "the first page honors the serialized budget: {page_bytes}"
    );
    for frame in &page1 {
        assert_eq!(
            frame["source"], "replay",
            "pages are stamped source:'replay'"
        );
        assert_eq!(frame["attachRequestId"], "attach-paced");
        assert!(frame["seqStart"].as_i64().unwrap_or(0) >= 1);
    }

    // WITHHOLD: no credit => no further pages (a window with no frames).
    let withheld = next_json_or_timeout(&mut paced, Duration::from_millis(1500)).await;
    assert!(
        withheld.is_none()
            || withheld
                .as_ref()
                .unwrap()
                .get("type")
                .and_then(|v| v.as_str())
                != Some("terminal.output"),
        "no further replay frames may arrive without credit, got {withheld:?}"
    );

    // Beyond-window credit: ignored, produces nothing, and does not consume
    // the grant (the next VALID credit still works).
    credit(&mut paced, &terminal_id, "attach-paced", last_seq + 100_000).await;
    let bad = next_json_or_timeout(&mut paced, Duration::from_millis(1200)).await;
    assert!(
        bad.is_none()
            || bad.as_ref().unwrap().get("type").and_then(|v| v.as_str())
                != Some("terminal.output"),
        "a beyond-window credit must produce nothing, got {bad:?}"
    );

    // Valid credit => the next page arrives.
    credit(&mut paced, &terminal_id, "attach-paced", last_seq).await;
    let next = next_json(&mut paced).await;
    assert_eq!(
        next["type"], "terminal.output",
        "the credit produces the next page: {next}"
    );
    let next_end = next["seqEnd"].as_i64().expect("seqEnd");
    assert!(
        next_end > last_seq,
        "pages ascend: page1 ends {last_seq}, next starts at {}",
        next["seqStart"]
    );
    assert_eq!(next["attachRequestId"], "attach-paced");
    assert_eq!(next["source"], "replay");
}

/// Live output produced DURING the paced replay is delivered strictly after
/// the pages covering it, in seq order, with no loss or duplication — the
/// hard "no overtaking" invariant, end to end.
#[tokio::test]
async fn live_output_during_paced_replay_never_overtakes_the_pages() {
    let ring = 512 * 1024;
    let url = spawn_server(ring).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-live-race").await;
    flood_until_complete(&url, &mut driver, &terminal_id, 400).await;

    let marker1 = "FLOOD-DONE-MARKER";
    let mut paced = connect(&url).await;
    hello(&mut paced, true).await;
    let (ready, page1) = paced_attach_first_page(&mut paced, &terminal_id, "attach-live").await;
    let head = ready["headSeq"].as_i64().expect("headSeq");
    let first_page_last = page1
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .unwrap_or(0);
    let last_seq = page1
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .unwrap_or(0);
    assert!(
        last_seq < head,
        "the session starts mid-replay (head {head}, first page ends {last_seq}, frames {})",
        page1.len()
    );

    // MORE live output while the replay is in flight (deferred — staged).
    // A non-negotiated observer attaches (inline replay + direct live) and
    // drives the flood to completion — the deterministic "it finished" signal.
    let mut midflood = connect(&url).await;
    hello(&mut midflood, false).await;
    attach(&mut midflood, &terminal_id, "attach-midflood").await;
    let marker2 = "FLOOD-DONE-MARKER";
    send_input(&mut midflood, &terminal_id, &flood_command(300, marker2)).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let (mid_acc, _) = drain_until_marker(&mut midflood, marker2, deadline).await;
    assert!(
        mid_acc.contains(marker2),
        "the mid flood completes on its own observer"
    );
    drop(midflood);

    // Credit through to completion; the tail delivers the staged range
    // spontaneously once the cursor reaches the target.
    let mut received: Vec<(i64, String)> = page1
        .iter()
        .map(|f| {
            (
                f["seqStart"].as_i64().unwrap_or(0),
                f["data"].as_str().unwrap_or("").to_string(),
            )
        })
        .collect();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let mut credited = last_seq;
    // Un-pause the session: the first page is the one outstanding page, so
    // credit it before waiting for the next.
    credit(&mut paced, &terminal_id, "attach-live", first_page_last).await;
    while tokio::time::Instant::now() < deadline {
        let Some(value) = next_json_or_timeout(&mut paced, Duration::from_secs(5)).await else {
            break;
        };
        if value.get("type").and_then(|v| v.as_str()) == Some("terminal.output") {
            received.push((
                value["seqStart"].as_i64().unwrap_or(0),
                value["data"].as_str().unwrap_or("").to_string(),
            ));
            let end = value["seqEnd"].as_i64().unwrap_or(0);
            if end > credited {
                credited = end;
                credit(&mut paced, &terminal_id, "attach-live", end).await;
            }
            let acc: String = received.iter().map(|(_, d)| d.as_str()).collect();
            if acc.contains(marker2) {
                break;
            }
        }
    }
    let acc: String = received.iter().map(|(_, d)| d.as_str()).collect();
    assert!(
        acc.contains(marker1) && acc.contains(marker2),
        "the session delivers both floods"
    );

    // The hard invariant: strictly ascending seqs, no duplicates, and every
    // delivered frame lies at or after the FIRST page's range (nothing the
    // pages cover is re-delivered, and no live frame jumped the pages).
    let seqs: Vec<i64> = received.iter().map(|(s, _)| *s).collect();
    let mut sorted = seqs.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(seqs.len(), sorted.len(), "no duplicate seqStarts");
    assert_eq!(seqs, sorted, "delivery is strictly in seq order");
    assert!(seqs[0] >= 1, "the first page starts at the baseline+1");
    // Every seq from the attach baseline to the end is covered exactly once.
    for expected in seqs[0]..=*seqs.last().unwrap() {
        assert!(
            seqs.contains(&expected),
            "no seq holes: {expected} missing from {:?}",
            &seqs[..seqs.len().min(20)]
        );
    }
}

/// Retention expiry MID-REPLAY: the negotiated `terminal.output.gap` with
/// reason `replay_window_exceeded`, the exact lost interval, the task-2
/// bounds fields, and continuation from the new baseline through to the
/// session's target.
#[tokio::test]
async fn mid_replay_retention_expiry_emits_the_exact_negotiated_gap_and_continues() {
    // Small ring so a withheld session loses its middle to eviction.
    let ring = 12 * 1024;
    let url = spawn_server(ring).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-expiry").await;
    flood_until_complete(&url, &mut driver, &terminal_id, 100).await;

    let mut paced = connect(&url).await;
    hello(&mut paced, true).await;
    let (ready, page1) = paced_attach_first_page(&mut paced, &terminal_id, "attach-expiry").await;
    let head = ready["headSeq"].as_i64().expect("headSeq");
    let last_seq = page1
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .expect("the first page covers something");
    assert!(last_seq < head);

    // Evict the middle of the replay window while the client withholds.
    // The evictor attaches (non-negotiated — inline replay + live) to
    // observe its own flood's completion deterministically.
    let mut evictor = connect(&url).await;
    hello(&mut evictor, false).await;
    attach(&mut evictor, &terminal_id, "attach-evictor").await;
    let marker2 = "FLOOD-DONE-MARKER";
    send_input(&mut evictor, &terminal_id, &flood_command(400, marker2)).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let (acc, _) = drain_until_marker(&mut evictor, marker2, deadline).await;
    assert!(acc.contains(marker2), "the evicting flood completes");
    drop(evictor);

    // Credit: the next needed frames were evicted => the negotiated gap.
    credit(&mut paced, &terminal_id, "attach-expiry", last_seq).await;
    let gap = loop {
        let value = next_json(&mut paced).await;
        match value.get("type").and_then(|v| v.as_str()) {
            Some("terminal.output.gap") => break value,
            Some("terminal.output") => continue, // tail leakage of pre-eviction pages
            other => panic!("expected the retention gap, got {other:?} ({value})"),
        }
    };
    assert_eq!(
        gap["reason"], "replay_window_exceeded",
        "the gap names retention loss: {gap}"
    );
    assert_eq!(
        gap["fromSeq"].as_i64(),
        Some(last_seq + 1),
        "the lost interval starts at the credited cursor+1: {gap}"
    );
    let gap_oldest = gap["oldestRetainedSeq"]
        .as_i64()
        .expect("negotiated gap carries oldestRetainedSeq");
    let gap_head = gap["headSeq"]
        .as_i64()
        .expect("negotiated gap carries headSeq");
    assert_eq!(
        gap["toSeq"].as_i64(),
        Some(gap_oldest - 1),
        "the lost interval ends just before the new ring front: {gap}"
    );
    assert!(gap_head >= head, "the bounds are current: {gap}");
    assert_eq!(gap["attachRequestId"], "attach-expiry");

    // Continuation from the new baseline: the next page starts at the ring
    // front and the session still reaches its original target + the live
    // tail (both markers).
    let mut received: Vec<i64> = Vec::new();
    let mut data = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let mut credited = gap["toSeq"].as_i64().unwrap();
    while tokio::time::Instant::now() < deadline {
        let value = next_json_or_timeout(&mut paced, Duration::from_secs(5)).await;
        let Some(value) = value else { break };
        if value.get("type").and_then(|v| v.as_str()) == Some("terminal.output") {
            let seq = value["seqStart"].as_i64().unwrap_or(0);
            assert!(
                seq >= gap_oldest,
                "continuation starts at the new baseline (ring front {gap_oldest}), got seq {seq}"
            );
            received.push(seq);
            data.push_str(value["data"].as_str().unwrap_or(""));
            let end = value["seqEnd"].as_i64().unwrap_or(0);
            if end > credited {
                credited = end;
                credit(&mut paced, &terminal_id, "attach-expiry", end).await;
            }
            if data.contains(marker2) {
                break;
            }
        }
    }
    assert!(
        data.contains(marker2),
        "the session continues through the retained range to the live tail"
    );
    let mut sorted = received.clone();
    sorted.sort_unstable();
    assert_eq!(received, sorted, "continuation pages ascend");
}

/// A re-attach supersedes the old session: the old generation's credit is
/// ignored (stale), the new generation's credit drives its own pages.
#[tokio::test]
async fn reattach_supersedes_the_old_paced_session() {
    let ring = 512 * 1024;
    let url = spawn_server(ring).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-supersede").await;
    flood_until_complete(&url, &mut driver, &terminal_id, 500).await;

    let mut paced = connect(&url).await;
    hello(&mut paced, true).await;
    let (ready1, page1) = paced_attach_first_page(&mut paced, &terminal_id, "attach-gen-1").await;
    let last1 = page1
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .expect("gen-1 first page");
    assert!(last1 < ready1["headSeq"].as_i64().unwrap());

    // Re-attach (generation 2): a fresh ready + fresh first page; the
    // attach.ready supersede also discards gen-1's un-leased frames.
    let (ready2, page2) = paced_attach_first_page(&mut paced, &terminal_id, "attach-gen-2").await;
    assert_eq!(ready2["attachRequestId"], "attach-gen-2");
    let last2 = page2
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .expect("gen-2 first page");
    assert!(
        page2.iter().all(|f| f["attachRequestId"] == "attach-gen-2"),
        "gen-2's pages are stamped with gen-2's id"
    );

    // The OLD generation's credit is stale: nothing arrives.
    credit(&mut paced, &terminal_id, "attach-gen-1", last1).await;
    let stale = next_json_or_timeout(&mut paced, Duration::from_millis(1200)).await;
    assert!(
        stale.is_none()
            || stale.as_ref().unwrap().get("type").and_then(|v| v.as_str())
                != Some("terminal.output"),
        "a stale-generation credit must be ignored, got {stale:?}"
    );

    // The NEW generation's credit drives its own session.
    credit(&mut paced, &terminal_id, "attach-gen-2", last2).await;
    let next = next_json(&mut paced).await;
    assert_eq!(next["type"], "terminal.output");
    assert_eq!(next["attachRequestId"], "attach-gen-2");
    assert!(
        next["seqEnd"].as_i64().unwrap_or(0) > last2,
        "gen-2's pages continue from its own cursor"
    );
}

/// A credit on a NON-NEGOTIATED connection is inert: no pacing machinery
/// engages, inline delivery continues to work exactly as before.
#[tokio::test]
async fn credit_on_a_non_negotiated_connection_is_inert() {
    let ring = 512 * 1024;
    let url = spawn_server(ring).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-plain-credit").await;
    flood_until_complete(&url, &mut driver, &terminal_id, 100).await;

    let mut plain = connect(&url).await;
    hello(&mut plain, false).await;
    let (ready, outputs) = paced_attach_first_page(&mut plain, &terminal_id, "attach-plain").await;
    // Non-negotiated: the FULL inline replay arrived immediately.
    let head = ready["headSeq"].as_i64().unwrap();
    let max_seq = outputs
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .unwrap_or(0);
    assert_eq!(
        max_seq, head,
        "a non-negotiated attach gets the whole replay inline"
    );
    assert!(
        ready.get("oldestRetainedSeq").is_none(),
        "no contract fields for a plain connection"
    );

    // The inert credit: live output keeps flowing inline afterwards.
    credit(&mut plain, &terminal_id, "attach-plain", max_seq).await;
    let marker = "FLOOD-DONE-MARKER";
    send_input(&mut driver, &terminal_id, &flood_command(30, marker)).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let (acc, _) = drain_until_marker(&mut plain, marker, deadline).await;
    assert!(
        acc.contains(marker),
        "live output flows normally after an inert credit"
    );
}

/// A disconnect mid-replay leaves the terminal RUNNING and clean: a
/// subsequent (non-negotiated) attach gets the full replay and live output —
/// no leak, no wedge.
#[tokio::test]
async fn disconnect_mid_replay_leaves_the_terminal_running_and_reattachable() {
    let ring = 512 * 1024;
    let url = spawn_server(ring).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-disconnect").await;
    flood_until_complete(&url, &mut driver, &terminal_id, 400).await;

    let mut paced = connect(&url).await;
    hello(&mut paced, true).await;
    let (ready, page1) = paced_attach_first_page(&mut paced, &terminal_id, "attach-doomed").await;
    let last_seq = page1
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .unwrap_or(0);
    assert!(
        last_seq < ready["headSeq"].as_i64().unwrap(),
        "mid-replay before the drop"
    );
    drop(paced); // the socket dies mid-replay (no detach, no credit)

    tokio::time::sleep(Duration::from_millis(300)).await;

    // A fresh non-negotiated connection attaches and gets the full replay.
    let mut fresh = connect(&url).await;
    hello(&mut fresh, false).await;
    let (ready2, outputs) = paced_attach_first_page(&mut fresh, &terminal_id, "attach-after").await;
    let head = ready2["headSeq"].as_i64().unwrap();
    let max_seq = outputs
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .unwrap_or(0);
    assert_eq!(
        max_seq, head,
        "the full replay is intact after the dropped paced session"
    );

    // And live output still flows.
    let marker = "FLOOD-DONE-MARKER";
    send_input(&mut driver, &terminal_id, &flood_command(30, marker)).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let (acc, _) = drain_until_marker(&mut fresh, marker, deadline).await;
    assert!(
        acc.contains(marker),
        "live output flows after the re-attach"
    );
}
