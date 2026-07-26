//! WS-level proof for restart-resilience P0.2 slice 1: the real dispatch
//! (`terminal.rs`'s `ClientMessage::FreshAgentAttach` arm) must route a claude/kilroy
//! `freshAgent.attach` to `FreshClaudeState::handle_attach` instead of swallowing it
//! via `_ => {}`. Unit-level coverage exists in `claude.rs::tests`, but -- exactly like
//! the kill/interrupt dispatch gap before it (`freshagent_claude_kill_interrupt.rs`) --
//! it is unreachable from the wire until the dispatch arm exists. Harness duplicated
//! from that file per the repo's per-test-file convention.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::WsState;

const AUTH_TOKEN: &str = "s3cr3t-token-abcdef";

/// Serializes every test in this file that mutates process-global env vars
/// (`FRESHELL_CLAUDE_SIDECAR` / `FRESHELL_CLAUDE_NODE` / `CLAUDE_CONFIG_DIR`),
/// mirroring `freshagent_claude_kill_interrupt.rs`'s convention for the same hazard.
static CLAUDE_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

// ── fake claude sidecar (resume flavor: created + sdk.session.init + sdk.status) ──

/// A minimal scripted fake claude sidecar (no real SDK, no network, no cost) speaking
/// the SAME newline-JSON protocol `spawn_sidecar()` drives the vendored package with.
/// On `create` it replies `created`, then `sdk.session.init` echoing `resumeSessionId`
/// as the durable `cliSessionId` (resume continuity -- exactly what the real sidecar's
/// SDK init does), then `sdk.status idle`; on `shutdown` it exits.
const FAKE_CLAUDE_SIDECAR_SOURCE: &str = r#"
import readline from 'node:readline'

let counter = 0
const rl = readline.createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return
  }
  if (msg.type === 'create') {
    counter += 1
    const sessionId = `fake-claude-session-${process.pid}-${counter}`
    process.stdout.write(JSON.stringify({ type: 'created', requestId: msg.requestId, sessionId }) + '\n')
    const cliSessionId = msg.resumeSessionId || 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    process.stdout.write(JSON.stringify({ type: 'sdk.session.init', sessionId, cliSessionId, model: 'fake-model', cwd: '/tmp', tools: [] }) + '\n')
    process.stdout.write(JSON.stringify({ type: 'sdk.status', sessionId, status: 'idle' }) + '\n')
  } else if (msg.type === 'shutdown') {
    process.exit(0)
  }
})
"#;

/// A fresh temp dir holding the fake sidecar script, with `FRESHELL_CLAUDE_SIDECAR`/
/// `FRESHELL_CLAUDE_NODE` pointed at it, PLUS a seeded claude transcript store with
/// `CLAUDE_CONFIG_DIR` pointed at it. Caller must hold [`CLAUDE_ENV_LOCK`] for the
/// lifetime of the returned guard.
struct FakeClaudeResumeEnv {
    dir: std::path::PathBuf,
}
impl FakeClaudeResumeEnv {
    fn install(durable: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "freshell-fake-claude-resume-ws-{}",
            uuid_like_suffix()
        ));
        std::fs::create_dir_all(&dir).expect("create fake sidecar temp dir");
        let script = dir.join("fake-claude-sidecar.mjs");
        std::fs::write(&script, FAKE_CLAUDE_SIDECAR_SOURCE).expect("write fake sidecar");
        // Seed the transcript store: one user line carrying an EXISTING cwd ("/tmp"),
        // so the resume request goes by durable UUID + original cwd (ledger A15).
        let store = dir.join("claude-store");
        let project = store.join("projects").join("-t");
        std::fs::create_dir_all(&project).expect("create transcript project dir");
        std::fs::write(
            project.join(format!("{durable}.jsonl")),
            r#"{"type":"user","cwd":"/tmp","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#,
        )
        .expect("seed transcript");
        std::env::set_var("FRESHELL_CLAUDE_SIDECAR", &script);
        std::env::set_var("FRESHELL_CLAUDE_NODE", "node");
        std::env::set_var("CLAUDE_CONFIG_DIR", &store);
        Self { dir }
    }
}
impl Drop for FakeClaudeResumeEnv {
    fn drop(&mut self) {
        std::env::remove_var("FRESHELL_CLAUDE_SIDECAR");
        std::env::remove_var("FRESHELL_CLAUDE_NODE");
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Dependency-free unique suffix (avoids pulling in `uuid` for this test crate).
fn uuid_like_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{nanos}-{:?}", std::thread::current().id())
}

// ── server harness (duplicated from diag01_lifecycle_events.rs's convention, with
//    `freshAgent.enabled: true` so `freshAgent.create` actually dispatches) ──

fn test_settings_value() -> serde_json::Value {
    serde_json::json!({
        "ai": {},
        "codingCli": { "enabledProviders": [], "mcpServer": true, "providers": {} },
        "editor": { "externalEditor": "auto" },
        "extensions": { "disabled": [] },
        "freshAgent": { "defaultPlugins": [], "enabled": true, "providers": {} },
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

async fn spawn_server() -> String {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));

    let state = WsState {
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-test".to_string()),
        boot_id: Arc::new("boot-test".to_string()),
        settings,
        broadcast_tx: Arc::clone(&broadcast_tx),
        fresh_codex: freshell_freshagent::FreshCodexState::new(
            Arc::clone(&auth_token),
            Arc::clone(&broadcast_tx),
            serde_json::json!({ "freshAgent": { "enabled": true } }),
        ),
        fresh_claude: freshell_freshagent::FreshClaudeState::new(Arc::clone(&broadcast_tx)),
        fresh_opencode: freshell_freshagent::FreshOpencodeState::new(
            freshell_freshagent::FreshAgentState::new(
                Arc::clone(&auth_token),
                Arc::clone(&broadcast_tx),
            ),
        ),
        registry: freshell_terminal::TerminalRegistry::new(),
        tabs: freshell_ws::tabs::TabsRegistry::new(),
        screenshots: freshell_ws::screenshot::ScreenshotBroker::new(Arc::clone(&broadcast_tx)),
        terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        sessions_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        cli_commands: Arc::new(Vec::new()),
        shutdown: Arc::new(tokio::sync::Notify::new()),
        ping_interval_ms: 30_000,
        hello_timeout_ms: 5_000,
        allowed_origins: Arc::new(freshell_ws::origin::default_allowed_origins()),
        ws_max_payload_bytes: 16 * 1024 * 1024,
        term09: freshell_ws::backpressure::Term09Config::default(),
        create_protect: freshell_ws::create_limit::CreateProtectConfig::default(),
        spawn_gate: std::sync::Arc::new(freshell_ws::spawn_gate::SpawnGate::new(4, 64)),
        config_fallback: None,
        amplifier_locator: None,
        opencode_locator: None,
        activity: None,
        session_existence: std::sync::Arc::new(freshell_ws::existence::NoIndexProbe::default()),
    };

    let router = freshell_ws::router(state);
    // Ephemeral loopback port only -- NEVER the self-hosted 3001/3002 ports.
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    format!("ws://{addr}/ws")
}

type TestWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect_and_complete_handshake(url: &str) -> TestWs {
    let (mut ws, _resp) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "hello",
            "token": AUTH_TOKEN,
            "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
        })
        .to_string(),
    ))
    .await
    .expect("send hello");

    // Drain the handshake frames (ready + whatever else precedes it) until `ready`.
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("handshake message within timeout")
            .expect("stream not ended")
            .expect("no ws error");
        let WsMessage::Text(text) = msg else {
            continue;
        };
        let value: Value = serde_json::from_str(&text).unwrap();
        if value["type"] == "ready" {
            break;
        }
    }
    ws
}

async fn send_json(ws: &mut TestWs, value: &Value) {
    ws.send(WsMessage::Text(value.to_string()))
        .await
        .expect("send frame");
}

/// Drain frames until one matching `predicate` arrives (or the budget expires).
async fn await_frame(
    ws: &mut TestWs,
    budget: Duration,
    predicate: impl Fn(&Value) -> bool,
) -> Value {
    tokio::time::timeout(budget, async {
        loop {
            let msg = ws
                .next()
                .await
                .expect("stream not ended")
                .expect("no ws error");
            let WsMessage::Text(text) = msg else {
                continue;
            };
            let value: Value = serde_json::from_str(&text).unwrap();
            if predicate(&value) {
                return value;
            }
        }
    })
    .await
    .expect("expected frame did not arrive within budget")
}

/// A claude `freshAgent.attach` for a session id this server process does not track
/// (the always-true case right after a server restart) must produce the
/// `freshAgent.error{code:'INVALID_SESSION_ID'}` lost-session frame on the wire --
/// the frame the frozen client folds into `markSessionLost` -> `triggerRecovery`.
/// Before the fix the dispatch swallowed the message and NO frame ever arrived
/// (this test then fails with `await_frame` panicking on its timeout budget).
#[tokio::test]
async fn claude_attach_for_untracked_session_emits_lost_session_frame_over_ws() {
    let url = spawn_server().await;
    let mut ws = connect_and_complete_handshake(&url).await;

    send_json(
        &mut ws,
        &serde_json::json!({
            "type": "freshAgent.attach",
            "provider": "claude",
            "sessionId": "restarted-away",
            "sessionType": "freshclaude",
        }),
    )
    .await;

    let frame = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "freshAgent.event" && v["sessionId"] == "restarted-away"
    })
    .await;

    assert_eq!(frame["provider"], "claude");
    assert_eq!(frame["sessionType"], "freshclaude");
    assert_eq!(frame["event"]["type"], "freshAgent.error");
    assert_eq!(frame["event"]["code"], "INVALID_SESSION_ID");
}

/// Restart parity (Task 6): an attach for an untracked session that DOES carry a
/// durable claude UUID with a resumable transcript must be resumed in place -- the
/// server spawns a sidecar with `resumeSessionId` and emits the idle
/// `freshAgent.session.snapshot` whose `timelineSessionId` is the durable UUID (the
/// frozen client persists it unvalidated -- NEVER a nanoid), all under the CLIENT's
/// original session id. Before the fix this attach produced the lost frame instead
/// (this test then fails with `await_frame` panicking on its timeout budget).
#[tokio::test]
async fn claude_attach_with_resumable_transcript_resumes_and_emits_snapshot_over_ws() {
    let _guard = CLAUDE_ENV_LOCK.lock().await;
    let durable = "abababab-abab-4bab-8bab-abababababab";
    let _env = FakeClaudeResumeEnv::install(durable);

    let url = spawn_server().await;
    let mut ws = connect_and_complete_handshake(&url).await;

    send_json(
        &mut ws,
        &serde_json::json!({
            "type": "freshAgent.attach",
            "provider": "claude",
            "sessionId": "gone-after-restart",
            "sessionType": "freshclaude",
            "resumeSessionId": durable,
            "sessionRef": { "provider": "claude", "sessionId": durable },
        }),
    )
    .await;

    let frame = await_frame(&mut ws, Duration::from_secs(15), |v| {
        v["type"] == "freshAgent.event" && v["event"]["type"] == "freshAgent.session.snapshot"
    })
    .await;

    assert_eq!(frame["sessionId"], "gone-after-restart");
    assert_eq!(frame["sessionType"], "freshclaude");
    assert_eq!(frame["event"]["status"], "idle");
    assert_eq!(frame["event"]["timelineSessionId"], durable);
}

/// Kilroy panes ride the same claude provider arm with `sessionType: "kilroy"`; the
/// envelope must echo it (through the real serde parse of `ClientMessage`, which the
/// unit tests bypass) or the client builds the wrong session locator.
#[tokio::test]
async fn kilroy_attach_for_untracked_session_emits_lost_session_frame_over_ws() {
    let url = spawn_server().await;
    let mut ws = connect_and_complete_handshake(&url).await;

    send_json(
        &mut ws,
        &serde_json::json!({
            "type": "freshAgent.attach",
            "provider": "claude",
            "sessionId": "kilroy-was-here",
            "sessionType": "kilroy",
        }),
    )
    .await;

    let frame = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "freshAgent.event" && v["sessionId"] == "kilroy-was-here"
    })
    .await;

    assert_eq!(frame["provider"], "claude");
    assert_eq!(frame["sessionType"], "kilroy");
    assert_eq!(frame["event"]["code"], "INVALID_SESSION_ID");
}
