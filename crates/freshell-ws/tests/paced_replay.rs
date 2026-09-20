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

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::WsState;

// ── capturing tracing layer (dev-only test facility). PROCESS-GLOBAL by
// deliberate choice (the diag01_lifecycle_events.rs `global_capture` /
// invariants.rs e08g pattern, extended with `record_u64` so the paced
// events' u64 fields — `page_bytes`, `pages` — are captured too): a
// thread-local `set_default` capture is UNSOUND for callsites shared with
// sibling tests running in parallel — tracing-core caches each callsite's
// Interest process-wide on first registration, and a subscriber-less
// sibling thread executing a shared emission site first (e.g.
// `credit_on_a_non_negotiated_connection_is_inert` firing the
// `non_negotiated` callsite) caches `Interest::never`, so a thread-local
// capture then never sees its OWN thread's emissions (kata 59nb). One
// global subscriber sees every thread's events; every read below MUST
// filter by the per-test-unique `terminal_id` because ALL tests in this
// binary share the vec. ─────────────────────────────────────────────────

use std::sync::Mutex;
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, SubscriberExt};
use tracing_subscriber::Layer;

#[derive(Debug, Clone, Default)]
struct CapturedEvent {
    message: String,
    fields: BTreeMap<String, String>,
}

#[derive(Default)]
struct FieldVisitor {
    message: String,
    fields: BTreeMap<String, String>,
}

impl Visit for FieldVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        let rendered = format!("{value:?}");
        if field.name() == "message" {
            self.message = rendered;
        } else {
            self.fields.insert(field.name().to_string(), rendered);
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message = value.to_string();
        } else {
            self.fields
                .insert(field.name().to_string(), value.to_string());
        }
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.fields
            .insert(field.name().to_string(), value.to_string());
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.fields
            .insert(field.name().to_string(), value.to_string());
    }
}

struct CaptureLayer {
    events: Arc<Mutex<Vec<CapturedEvent>>>,
}

impl<S: Subscriber> Layer<S> for CaptureLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut visitor = FieldVisitor::default();
        event.record(&mut visitor);
        self.events
            .lock()
            .expect("capture lock")
            .push(CapturedEvent {
                message: visitor.message,
                fields: visitor.fields,
            });
    }
}

/// Process-global capture for this test binary (first caller installs;
/// `get_or_init` is the synchronization). This binary installs no other
/// global subscriber; `.expect()` turns any future second installer into an
/// immediate diagnosable panic instead of a silently-empty capture.
fn global_capture() -> Arc<Mutex<Vec<CapturedEvent>>> {
    static EVENTS: std::sync::OnceLock<Arc<Mutex<Vec<CapturedEvent>>>> = std::sync::OnceLock::new();
    Arc::clone(EVENTS.get_or_init(|| {
        let events = Arc::new(Mutex::new(Vec::new()));
        let layer = CaptureLayer {
            events: Arc::clone(&events),
        };
        let subscriber = tracing_subscriber::registry().with(layer);
        tracing::subscriber::set_global_default(subscriber)
            .expect("this test binary installs exactly one global subscriber");
        events
    }))
}

/// Poll the capture until an event for THIS test's terminal (the vec is
/// shared by every test in the binary — the unique `terminal_id` is the
/// per-test discriminator) with this message AND `fields[field] == value`
/// lands (or the 5s deadline passes). The `ws.restore.credit` events share
/// one message name, so the verdict `status` field is the selector.
async fn wait_for_restore_event(
    events: &Arc<Mutex<Vec<CapturedEvent>>>,
    terminal_id: &str,
    message: &str,
    field: &str,
    value: &str,
) -> Option<CapturedEvent> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        {
            let captured = events.lock().unwrap();
            if let Some(found) = captured.iter().find(|e| {
                e.message == message
                    && e.fields.get("terminal_id").map(String::as_str) == Some(terminal_id)
                    && e.fields.get(field).map(String::as_str) == Some(value)
            }) {
                return Some(found.clone());
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// [`wait_for_restore_event`] without the extra field selector — for the
/// one-event-per-terminal messages (`ws.restore.paced_start`,
/// `ws.restore.paced_complete`).
async fn wait_for_restore_event_of_terminal(
    events: &Arc<Mutex<Vec<CapturedEvent>>>,
    terminal_id: &str,
    message: &str,
) -> Option<CapturedEvent> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        {
            let captured = events.lock().unwrap();
            if let Some(found) = captured.iter().find(|e| {
                e.message == message
                    && e.fields.get("terminal_id").map(String::as_str) == Some(terminal_id)
            }) {
                return Some(found.clone());
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

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

/// Read the next JSON frame, or `None` if no frame at all arrives within
/// `window`. A keepalive Ping/Pong landing INSIDE the window is NOT
/// silence — the burst-complete heuristic treats only text frames as
/// signal, so a server ping mid-read cannot truncate a page read (the
/// 30s ping interval makes this rare vs the ~1-2s bursts, but the harness
/// must not depend on that timing).
async fn next_json_or_timeout(ws: &mut WsClient, window: Duration) -> Option<serde_json::Value> {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return None;
        }
        match tokio::time::timeout(remaining, ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                return Some(serde_json::from_str(&text).expect("frame is JSON"));
            }
            // Control frames never count as the burst's end: keep waiting
            // for text until the window actually elapses.
            Ok(Some(Ok(WsMessage::Ping(_) | WsMessage::Pong(_)))) => continue,
            _ => return None,
        }
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

/// Send `terminal.attach` WITHOUT an `attachRequestId` — the uncorrelated
/// legacy shape: even a negotiated connection falls back to the inline
/// full-replay path (credits cannot be correlated without a generation key).
async fn attach_without_arid(ws: &mut WsClient, terminal_id: &str) {
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.attach",
            "terminalId": terminal_id,
            "intent": "viewport_hydrate",
            "cols": 80,
            "rows": 24,
            "sinceSeq": 0,
        })
        .to_string(),
    ))
    .await
    .expect("send arid-less terminal.attach");
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

/// The LEGACY (non-paced) attach burst: the ready frame (matched by
/// terminalId — this attach carries no `attachRequestId` to match) plus
/// every output frame the server sends spontaneously (the full inline
/// replay), read to the first quiet gap after the ready.
async fn legacy_attach_inline_replay(
    ws: &mut WsClient,
    terminal_id: &str,
) -> (serde_json::Value, Vec<serde_json::Value>) {
    let mut ready = None;
    let mut outputs = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        match next_json_or_timeout(ws, Duration::from_millis(400)).await {
            None => {
                if ready.is_some() {
                    break; // the inline burst is complete
                }
                continue;
            }
            Some(value) => match value.get("type").and_then(|v| v.as_str()) {
                Some("terminal.attach.ready")
                    if value.get("terminalId").and_then(|v| v.as_str()) == Some(terminal_id) =>
                {
                    ready = Some(value);
                }
                Some("terminal.output") | Some("terminal.output.batch") => outputs.push(value),
                _ => {}
            },
        }
    }
    let ready = ready.expect("attach.ready never arrived");
    (ready, outputs)
}

/// One attach's full spontaneous burst, collecting EVERY frame type: the
/// ready (matched by `attachRequestId`), all `terminal.output` frames, and
/// any `terminal.output.gap` frames separately. The gap bucket is the
/// mixed-version matrix pin: a NON-NEGOTIATED attach must never produce a
/// `replay_window_exceeded` gap — today's silent retained-tail behavior is
/// the old-client contract.
async fn attach_burst_collecting_gaps(
    ws: &mut WsClient,
    terminal_id: &str,
    arid: &str,
) -> (
    serde_json::Value,
    Vec<serde_json::Value>,
    Vec<serde_json::Value>,
) {
    attach(ws, terminal_id, arid).await;
    let mut ready = None;
    let mut outputs = Vec::new();
    let mut gaps = Vec::new();
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
                Some("terminal.output.gap") => gaps.push(value),
                _ => {}
            },
        }
    }
    let ready = ready.expect("attach.ready never arrived");
    (ready, outputs, gaps)
}

/// The covered seq set of a frame list: every seq in [seqStart, seqEnd].
fn covered_seqs(frames: &[serde_json::Value]) -> std::collections::BTreeSet<i64> {
    frames
        .iter()
        .flat_map(|f| {
            let start = f["seqStart"].as_i64().unwrap_or(0);
            let end = f["seqEnd"].as_i64().unwrap_or(0);
            start..=end
        })
        .collect()
}

/// The concatenated output data of a frame list, in receive (seq) order.
fn concatenated_data(frames: &[serde_json::Value]) -> String {
    frames
        .iter()
        .map(|f| f["data"].as_str().unwrap_or(""))
        .collect()
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

/// The binding supersede rule covers EVERY successful re-attach, not just
/// the paced one: an arid-less LEGACY re-attach (the negotiated fallback
/// shape) must also cancel the connection's previous paced session for the
/// terminal — a credit for the superseded generation must produce NOTHING
/// (no `terminal.output`, no `terminal.output.batch`), and the connection
/// must keep working afterwards.
#[tokio::test]
async fn legacy_reattach_cancels_the_stale_paced_session() {
    let ring = 512 * 1024;
    let url = spawn_server(ring).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-legacy-supersede").await;
    flood_until_complete(&url, &mut driver, &terminal_id, 400).await;

    // Generation 1: the paced attach starts a session whose first page is
    // a bounded prefix (the session is ACTIVE, mid-replay).
    let mut paced = connect(&url).await;
    hello(&mut paced, true).await;
    let (ready1, page1) = paced_attach_first_page(&mut paced, &terminal_id, "attach-gen-1").await;
    let last1 = page1
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .expect("gen-1 first page");
    assert!(
        last1 < ready1["headSeq"].as_i64().unwrap(),
        "the session is mid-replay (supersede-able)"
    );

    // The arid-less LEGACY re-attach: the whole window replays inline.
    attach_without_arid(&mut paced, &terminal_id).await;
    let (ready2, outputs) = legacy_attach_inline_replay(&mut paced, &terminal_id).await;
    assert!(
        ready2
            .get("attachRequestId")
            .and_then(|v| v.as_str())
            .is_none(),
        "the re-attach carried no attachRequestId: {ready2}"
    );
    let head = ready2["headSeq"].as_i64().unwrap();
    let max_seq = outputs
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .unwrap_or(0);
    assert_eq!(
        max_seq, head,
        "the legacy re-attach replays the whole window inline"
    );

    // The superseded generation's credit (its arid + in-window consumedSeq):
    // it must be ignored — no output frame of ANY kind may be produced.
    credit(&mut paced, &terminal_id, "attach-gen-1", last1).await;
    let stale = next_json_or_timeout(&mut paced, Duration::from_millis(1500)).await;
    let is_output_frame = |v: &serde_json::Value| {
        matches!(
            v.get("type").and_then(|t| t.as_str()),
            Some("terminal.output") | Some("terminal.output.batch")
        )
    };
    assert!(
        stale.as_ref().map(|v| !is_output_frame(v)).unwrap_or(true),
        "a credit for the session superseded by the legacy re-attach must \
         produce nothing, got {stale:?}"
    );

    // The connection is not wedged by the cancel: live output keeps
    // flowing to the re-attached (legacy) subscriber.
    let marker = "FLOOD-DONE-MARKER";
    send_input(&mut driver, &terminal_id, &flood_command(30, marker)).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let (acc, _) = drain_until_marker(&mut paced, marker, deadline).await;
    assert!(
        acc.contains(marker),
        "live output flows normally after the superseded credit"
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

/// The `ws.restore.*` observability contract, pinned end-to-end on the real
/// dispatch: `ws.restore.paced_start` carries its identifiers/measurements
/// (including `maxReplayBytes`), `ws.restore.paced_complete` closes the
/// session, and all FOUR `ws.restore.credit` verdicts (accepted /
/// stale_generation / beyond_window / non_negotiated) are emitted with their
/// status field — and NO event ever carries terminal CONTENT (identifiers
/// and measurements only).
#[tokio::test]
async fn restore_observability_events_are_emitted_content_free() {
    let events = global_capture();
    let ring = 512 * 1024;
    let url = spawn_server(ring).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-observability").await;
    flood_until_complete(&url, &mut driver, &terminal_id, 100).await;

    // The negotiated attach carries a maxReplayBytes request (the TERM-07
    // seam) — it must ride the paced_start event.
    let mut paced = connect(&url).await;
    hello(&mut paced, true).await;
    paced
        .send(WsMessage::Text(
            serde_json::json!({
                "type": "terminal.attach",
                "terminalId": terminal_id,
                "intent": "viewport_hydrate",
                "cols": 80,
                "rows": 24,
                "attachRequestId": "attach-ev",
                "sinceSeq": 0,
                "maxReplayBytes": 262144,
            })
            .to_string(),
        ))
        .await
        .expect("send attach with maxReplayBytes");
    let (ready, page1) = paced_attach_first_page(&mut paced, &terminal_id, "attach-ev").await;
    let head = ready["headSeq"].as_i64().expect("headSeq");
    let last_seq = page1
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .expect("first page");
    let page_bytes: u64 = page1.iter().map(|f| f.to_string().len() as u64).sum();

    // paced_start: identifiers + measurements, maxReplayBytes included.
    let start_ev =
        wait_for_restore_event_of_terminal(&events, &terminal_id, "ws.restore.paced_start")
            .await
            .expect("ws.restore.paced_start is emitted on the negotiated attach");
    assert_eq!(
        start_ev.fields.get("attach_request_id").map(String::as_str),
        Some("attach-ev")
    );
    assert_eq!(
        start_ev.fields.get("requested_since").map(String::as_str),
        Some("0")
    );
    assert_eq!(
        start_ev.fields.get("effective_since").map(String::as_str),
        Some("0")
    );
    assert_eq!(
        start_ev.fields.get("target").map(String::as_str),
        Some(head.to_string().as_str()),
        "target is the attach-time head"
    );
    assert_eq!(
        start_ev.fields.get("max_replay_bytes").map(String::as_str),
        Some("Some(262144)"),
        "the TERM-07 seam value rides the event (Debug of Option<i64>)"
    );
    assert_eq!(
        start_ev.fields.get("page_bytes").map(String::as_str),
        Some(page_bytes.to_string().as_str()),
        "page_bytes is the first page's real serialized size"
    );

    // beyond_window: a consumedSeq past the last-sent page's end is ignored.
    credit(&mut paced, &terminal_id, "attach-ev", last_seq + 100_000).await;
    let beyond = wait_for_restore_event(
        &events,
        &terminal_id,
        "ws.restore.credit",
        "status",
        "beyond_window",
    )
    .await
    .expect("the beyond-window credit is observed");
    assert_eq!(
        beyond.fields.get("terminal_id").map(String::as_str),
        Some(terminal_id.as_str())
    );
    assert_eq!(
        beyond
            .fields
            .get("consumed_seq")
            .and_then(|v| v.parse::<i64>().ok()),
        Some(last_seq + 100_000)
    );

    // stale_generation: a credit for an attachRequestId no active session
    // holds is a stale generation.
    credit(&mut paced, &terminal_id, "attach-bogus", last_seq).await;
    let stale = wait_for_restore_event(
        &events,
        &terminal_id,
        "ws.restore.credit",
        "status",
        "stale_generation",
    )
    .await
    .expect("the stale-generation credit is observed");
    assert_eq!(
        stale.fields.get("terminal_id").map(String::as_str),
        Some(terminal_id.as_str())
    );

    // accepted: a valid credit produces the next page...
    credit(&mut paced, &terminal_id, "attach-ev", last_seq).await;
    let accepted = wait_for_restore_event(
        &events,
        &terminal_id,
        "ws.restore.credit",
        "status",
        "accepted",
    )
    .await
    .expect("the valid credit is observed as accepted");
    assert_eq!(
        accepted
            .fields
            .get("consumed_seq")
            .and_then(|v| v.parse::<i64>().ok()),
        Some(last_seq)
    );
    // ...and the page actually arrives (the event describes real behavior).
    let next = next_json(&mut paced).await;
    assert_eq!(next["type"], "terminal.output");

    // Drive the session to completion; the tail drains un-credited and the
    // registry's atomic clear completes the session.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let mut credited = next["seqEnd"].as_i64().unwrap_or(last_seq);
    credit(&mut paced, &terminal_id, "attach-ev", credited).await;
    while tokio::time::Instant::now() < deadline {
        let Some(value) = next_json_or_timeout(&mut paced, Duration::from_secs(5)).await else {
            break;
        };
        if value.get("type").and_then(|v| v.as_str()) == Some("terminal.output") {
            let end = value["seqEnd"].as_i64().unwrap_or(0);
            if end > credited {
                credited = end;
                credit(&mut paced, &terminal_id, "attach-ev", end).await;
            }
        }
    }
    let complete =
        wait_for_restore_event_of_terminal(&events, &terminal_id, "ws.restore.paced_complete")
            .await
            .expect("ws.restore.paced_complete closes the session");
    assert_eq!(
        complete.fields.get("attach_request_id").map(String::as_str),
        Some("attach-ev")
    );
    assert_eq!(
        complete.fields.get("last_seq").map(String::as_str),
        Some(credited.to_string().as_str()),
        "last_seq is the session's final cursor"
    );
    assert!(
        complete
            .fields
            .get("pages")
            .and_then(|v| v.parse::<u64>().ok())
            .is_some_and(|pages| pages >= 2),
        "pages counts every page the session produced"
    );

    // non_negotiated: a credit from a connection that never negotiated the
    // paced capability is inert and observed as such.
    credit(&mut driver, &terminal_id, "attach-ev", 0).await;
    let non_negotiated = wait_for_restore_event(
        &events,
        &terminal_id,
        "ws.restore.credit",
        "status",
        "non_negotiated",
    )
    .await
    .expect("the non-negotiated connection's credit is observed as inert");
    assert_eq!(
        non_negotiated.fields.get("terminal_id").map(String::as_str),
        Some(terminal_id.as_str())
    );

    // Identifiers/measurements only: NO terminal content ever leaks into a
    // ws.restore.* event for this terminal (the flood payload and its
    // marker must be absent from every event field).
    let captured = events.lock().unwrap();
    for event in captured.iter().filter(|e| {
        e.message.starts_with("ws.restore.")
            && e.fields.get("terminal_id").map(String::as_str) == Some(terminal_id.as_str())
    }) {
        for (name, value) in &event.fields {
            assert!(
                !value.contains("STREAMDATA") && !value.contains("FLOOD-DONE-MARKER"),
                "terminal content leaked into ws.restore.{name}={value}"
            );
        }
    }
}

// ── Mixed-version compatibility matrix (responsive-terminal-restore,
// task-008): old client → new server on the real socket ──────────────────

/// Old client → new server, ATTACH on large scrollback (matrix cell 1): a
/// non-negotiated attach sees the FULL inline replay in one unprompted
/// burst — far beyond one paced page budget, so pacing provably never
/// engaged — with NO new ready fields, NO gap frames, contiguous coverage,
/// and a raw credit send that is inert (observed as
/// `ws.restore.credit status=non_negotiated`, producing nothing).
#[tokio::test]
async fn non_negotiated_attach_on_large_scrollback_stays_legacy_inline_and_credits_are_inert() {
    let events = global_capture();
    let ring = 512 * 1024;
    let url = spawn_server(ring).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-legacy-large").await;
    // ~64KB of scrollback: many 4KB pages had pacing (wrongly) engaged.
    flood_until_complete(&url, &mut driver, &terminal_id, 700).await;

    let mut plain = connect(&url).await;
    hello(&mut plain, false).await;
    let (ready, outputs, gaps) =
        attach_burst_collecting_gaps(&mut plain, &terminal_id, "attach-legacy-large").await;

    // NO new ready fields for the non-negotiated connection.
    assert!(
        ready.get("oldestRetainedSeq").is_none(),
        "an old client's attach.ready must not gain contract fields: {ready}"
    );
    assert!(
        ready.get("replayResetReason").is_none(),
        "an old client's attach.ready must not carry a reset reason: {ready}"
    );
    let head = ready["headSeq"].as_i64().expect("headSeq");

    // The whole window arrived unprompted: contiguous coverage to the head,
    // and the burst is far beyond one page budget (no pages, no credit gate).
    let burst_bytes: usize = outputs.iter().map(|f| f.to_string().len()).sum();
    assert!(
        burst_bytes as i64 > PAGE_BUDGET,
        "the unprompted burst ({burst_bytes}B) must exceed one page budget \
         ({PAGE_BUDGET}B) — a paced first page would have been bounded"
    );
    let seqs = covered_seqs(&outputs);
    assert_eq!(
        seqs.iter().min(),
        Some(&1),
        "the inline replay starts at the window baseline"
    );
    assert_eq!(
        seqs.iter().max(),
        Some(&head),
        "the inline replay reaches the head ({head})"
    );
    let mut contiguous: Vec<i64> = seqs.iter().copied().collect();
    contiguous.dedup();
    assert_eq!(
        contiguous.len() as i64,
        head,
        "the inline replay is contiguous with no holes"
    );
    assert!(
        gaps.is_empty(),
        "an old client's attach burst must contain no gap frames: {gaps:?}"
    );

    // The raw credit send: inert. Observed as the non_negotiated verdict...
    credit(&mut plain, &terminal_id, "attach-legacy-large", head).await;
    let _inert = wait_for_restore_event(
        &events,
        &terminal_id,
        "ws.restore.credit",
        "status",
        "non_negotiated",
    )
    .await
    .expect("a non-negotiated connection's credit must be classified non_negotiated");

    // ...and it produces nothing.
    let after = next_json_or_timeout(&mut plain, Duration::from_millis(1200)).await;
    assert!(
        after
            .as_ref()
            .map(|v| v.get("type").and_then(|t| t.as_str()) != Some("terminal.output"))
            .unwrap_or(true),
        "an inert credit must produce no output, got {after:?}"
    );

    // Live output keeps flowing after the inert credit (the connection is
    // not wedged by the refused pacing machinery).
    let marker = "FLOOD-DONE-MARKER";
    send_input(&mut driver, &terminal_id, &flood_command(30, marker)).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let (acc, _) = drain_until_marker(&mut plain, marker, deadline).await;
    assert!(
        acc.contains(marker),
        "live output flows normally after an inert credit"
    );
}

/// Old client + retention loss → NO new gap (matrix cell 2): a
/// non-negotiated attach whose `sinceSeq` predates the retained history
/// receives the retained tail SILENTLY — today's behavior, never the
/// negotiated `replay_window_exceeded` gap — on a real server with an
/// evicted ring.
#[tokio::test]
async fn non_negotiated_attach_after_retention_loss_gets_the_retained_tail_silently() {
    let ring = 12 * 1024;
    let url = spawn_server(ring).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-legacy-evict").await;
    flood_until_complete(&url, &mut driver, &terminal_id, 100).await;

    // Evict the ring front: a non-negotiated evictor drives a bigger flood
    // to completion (its own inline replay + live tail observe the marker).
    let mut evictor = connect(&url).await;
    hello(&mut evictor, false).await;
    attach(&mut evictor, &terminal_id, "attach-evictor-legacy").await;
    let marker2 = "FLOOD-DONE-MARKER";
    send_input(&mut driver, &terminal_id, &flood_command(400, marker2)).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let (acc, _) = drain_until_marker(&mut evictor, marker2, deadline).await;
    assert!(acc.contains(marker2), "the evicting flood completes");
    drop(evictor);

    // The old client attaches with sinceSeq 0 — predating the retained ring.
    let mut plain = connect(&url).await;
    hello(&mut plain, false).await;
    let (ready, outputs, gaps) =
        attach_burst_collecting_gaps(&mut plain, &terminal_id, "attach-legacy-evict").await;

    // THE matrix pin: no `replay_window_exceeded` may reach an old client —
    // the retention loss is reported the way today's server does: silently.
    assert!(
        gaps.is_empty(),
        "an old client must never receive the newly introduced retention gap: {gaps:?}"
    );
    assert!(
        ready.get("oldestRetainedSeq").is_none(),
        "an old client's attach.ready must not gain contract fields: {ready}"
    );
    let head = ready["headSeq"].as_i64().expect("headSeq");
    let replay_from = ready["replayFromSeq"].as_i64().expect("replayFromSeq");
    assert!(
        replay_from > 1,
        "the fixture must have evicted the ring front: {ready}"
    );

    // The retained tail arrives silently: exactly [replay_from, head],
    // starting at the ring front, contiguous, no phantom pre-eviction bytes.
    let seqs = covered_seqs(&outputs);
    assert!(!seqs.is_empty(), "there is a retained tail to deliver");
    assert_eq!(
        seqs.iter().min(),
        Some(&replay_from),
        "the silent tail starts at the ring front: {ready}"
    );
    assert_eq!(
        seqs.iter().max(),
        Some(&head),
        "the silent tail reaches the head"
    );
    let mut contiguous: Vec<i64> = seqs.iter().copied().collect();
    contiguous.dedup();
    assert_eq!(
        contiguous.len() as i64,
        head - replay_from + 1,
        "the silent tail is contiguous with no holes"
    );

    // Live output continues after the silent retained tail (no stall).
    let marker3 = "FLOOD-DONE-MARKER";
    send_input(&mut driver, &terminal_id, &flood_command(30, marker3)).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let (acc, _) = drain_until_marker(&mut plain, marker3, deadline).await;
    assert!(
        acc.contains(marker3),
        "live output flows normally after the silent retained tail"
    );
}

/// Mixed connections on ONE terminal (matrix cell 4): a negotiated client and
/// a non-negotiated client attached to the SAME terminal simultaneously —
/// the negotiated one gets paced pages (credit-gated), the non-negotiated
/// one gets the legacy inline replay; no cross-talk in either direction, and
/// both converge to the SAME frame content (identical seq coverage and
/// identical concatenated data — equality modulo pacing/batching shape).
#[tokio::test]
async fn mixed_negotiated_and_legacy_attachments_converge_without_cross_talk() {
    let events = global_capture();
    let ring = 512 * 1024;
    let url = spawn_server(ring).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-mixed").await;
    flood_until_complete(&url, &mut driver, &terminal_id, 400).await;

    // The negotiated client attaches first: one bounded page, mid-replay.
    let mut paced = connect(&url).await;
    hello(&mut paced, true).await;
    let (paced_ready, page1) =
        paced_attach_first_page(&mut paced, &terminal_id, "attach-mix-paced").await;
    let head = paced_ready["headSeq"].as_i64().expect("headSeq");
    let last1 = page1
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .expect("the first page covers something");
    assert!(
        last1 < head,
        "the negotiated session is mid-replay (head {head})"
    );

    // The legacy twin attaches to the SAME terminal while the paced session
    // is mid-replay: the FULL window arrives inline, immediately.
    let mut legacy = connect(&url).await;
    hello(&mut legacy, false).await;
    let (legacy_ready, legacy_outputs, legacy_gaps) =
        attach_burst_collecting_gaps(&mut legacy, &terminal_id, "attach-mix-legacy").await;
    assert!(
        legacy_gaps.is_empty(),
        "the legacy twin must see no gap frames: {legacy_gaps:?}"
    );
    assert!(
        legacy_ready.get("oldestRetainedSeq").is_none(),
        "the legacy twin's ready must stay pre-contract: {legacy_ready}"
    );
    let legacy_seqs = covered_seqs(&legacy_outputs);
    assert_eq!(
        legacy_seqs.iter().max(),
        Some(&head),
        "the legacy twin gets the whole window inline"
    );

    // No cross-talk, direction 1: the other connection's attach must NOT
    // cancel the negotiated session — its credit still produces its page...
    credit(&mut paced, &terminal_id, "attach-mix-paced", last1).await;
    let next = next_json(&mut paced).await;
    assert_eq!(
        next["type"], "terminal.output",
        "the negotiated session survives the legacy attach: {next}"
    );
    assert_eq!(next["attachRequestId"], "attach-mix-paced");

    // No cross-talk, direction 2: while the negotiated session withholds,
    // the legacy attach must not leak pages to it (the next unprompted
    // frame on the negotiated side is only the one its own credit bought).
    let mut paced_frames = page1.clone();
    let next_end = next["seqEnd"].as_i64().unwrap_or(last1);
    paced_frames.push(next);
    let mut credited = next_end;
    // Credit every consumed frame's end — a page may span several frames
    // (or one atomic over-budget frame per page), and the NEXT page is
    // produced only on a credit inside the delivered window.
    credit(&mut paced, &terminal_id, "attach-mix-paced", credited).await;
    let mut saw_head = credited >= head;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while tokio::time::Instant::now() < deadline {
        let Some(value) = next_json_or_timeout(&mut paced, Duration::from_secs(5)).await else {
            assert!(
                saw_head,
                "the paced replay stalled before its target (head {head}, credited {credited})"
            );
            break;
        };
        if value.get("type").and_then(|v| v.as_str()) != Some("terminal.output") {
            continue;
        }
        assert_eq!(
            value["attachRequestId"], "attach-mix-paced",
            "only the negotiated session's own pages arrive: {value}"
        );
        let end = value["seqEnd"].as_i64().unwrap_or(0);
        saw_head |= end >= head;
        paced_frames.push(value);
        if end > credited {
            credited = end;
            credit(&mut paced, &terminal_id, "attach-mix-paced", end).await;
        }
    }
    let complete =
        wait_for_restore_event_of_terminal(&events, &terminal_id, "ws.restore.paced_complete")
            .await
            .expect("the negotiated session reaches paced_complete");
    assert_eq!(
        complete.fields.get("attach_request_id").map(String::as_str),
        Some("attach-mix-paced")
    );

    // Convergence: identical seq coverage and identical concatenated data —
    // the paced side (pages, credit-gated) and the legacy side (one inline
    // burst) delivered the same terminal content, modulo pacing shape.
    let paced_seqs = covered_seqs(&paced_frames);
    assert_eq!(paced_seqs, legacy_seqs, "both sides cover the same seqs");
    assert_eq!(
        paced_seqs.iter().min(),
        Some(&1),
        "both sides cover from the window baseline"
    );
    assert_eq!(
        paced_seqs.iter().max(),
        Some(&head),
        "both sides reach the head"
    );
    let paced_data = concatenated_data(&paced_frames);
    let legacy_data = concatenated_data(&legacy_outputs);
    assert_eq!(
        paced_data, legacy_data,
        "both sides delivered byte-identical content"
    );
}
