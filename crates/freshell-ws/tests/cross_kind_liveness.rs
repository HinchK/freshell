//! Task 13b (V7, binding): the terminal and fresh-agent resume domains are NOT
//! disjoint -- "Reopen as freshclaude / Claude CLI" makes the same `(provider,
//! sessionId)` reachable from BOTH kinds. Each side must see the other's live
//! sessions, or two lease maps both report "working" on one JSONL (the
//! one-writer doctrine's "silently wrong").
//!
//! Two directions, two guards:
//! 1. A `freshAgent.create` resuming S while a live terminal PTY owns S is refused
//!    and spawns ZERO sidecars. Post-ejh6 (Task 7) the refusal code depends on the
//!    carrier: a legacy/dual-carrier create (`resumeSessionId` present) is rejected
//!    at the raw-Value ejh6 guard with `freshAgent.create.failed { code:
//!    "FRESH_AGENT_CREATE_FAILED" }` + frozen text, while a sessionRef-ONLY create
//!    reaches the typed cross-kind live-guard and is refused with
//!    `freshAgent.create.failed { code: "SESSION_RESERVED", retryable: true }`
//!    (the terminal may be closing -- retryable).
//! 2. A `terminal.create` whose wire sessionRef names S while a live sidecar owns S
//!    is refused with the D7 guard's EXISTING rejection frame
//!    (`error { code: "RESTORE_UNAVAILABLE" }`), same as a live PTY.
//!
//! Harness: the lease-suite fake claude sidecar (request-log knob) + the common
//! sleeper CLI spec so terminal claude creates genuinely spawn a Running PTY.
//! Run via `scripts/sandbox-test.sh` per the destructive-suite convention of the
//! sibling lease suite (shared file-level ruling; these tests kill nothing).

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::WsState;

const AUTH_TOKEN: &str = "s3cr3t-token-abcdef";

/// Serializes the tests in this file: they mutate process-global env vars
/// (`FRESHELL_CLAUDE_SIDECAR` / `FAKE_SIDECAR_*`).
static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

// ── fake claude sidecar (request-log knob only; duplicated per-file per convention) ──

const FAKE_CLAUDE_SIDECAR_SOURCE: &str = r#"
import readline from 'node:readline'
import fs from 'node:fs'

const logPath = process.env.FAKE_SIDECAR_REQUEST_LOG || ''
function logReq(msg) {
  if (!logPath) return
  try { fs.appendFileSync(logPath, JSON.stringify({ pid: process.pid, msg }) + '\n') } catch {}
}

let counter = 0
const rl = readline.createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try { msg = JSON.parse(trimmed) } catch { return }
  logReq(msg)
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

struct FakeSidecarEnv {
    dir: std::path::PathBuf,
}

impl FakeSidecarEnv {
    fn install() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "freshell-cross-kind-liveness-{}",
            uuid_like_suffix()
        ));
        std::fs::create_dir_all(&dir).expect("create fake sidecar temp dir");
        let script = dir.join("fake-claude-sidecar.mjs");
        std::fs::write(&script, FAKE_CLAUDE_SIDECAR_SOURCE).expect("write fake sidecar");
        std::env::set_var("FRESHELL_CLAUDE_SIDECAR", &script);
        std::env::set_var("FRESHELL_CLAUDE_NODE", "node");
        std::env::set_var("FAKE_SIDECAR_REQUEST_LOG", dir.join("requests.jsonl"));
        Self { dir }
    }

    fn create_rows(&self) -> Vec<Value> {
        let Ok(raw) = std::fs::read_to_string(self.dir.join("requests.jsonl")) else {
            return Vec::new();
        };
        raw.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str::<Value>(l).expect("request log row parses"))
            .filter(|r| r["msg"]["type"] == "create")
            .collect()
    }
}

impl Drop for FakeSidecarEnv {
    fn drop(&mut self) {
        for var in [
            "FRESHELL_CLAUDE_SIDECAR",
            "FRESHELL_CLAUDE_NODE",
            "FAKE_SIDECAR_REQUEST_LOG",
        ] {
            std::env::remove_var(var);
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn uuid_like_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{nanos}-{:?}", std::thread::current().id())
}

/// Sleeper CLI spec (duplicated from `tests/common/mod.rs` -- this file needs its own
/// server builder because the shared one disables `freshAgent.enabled`).
fn sleeper_cli_spec(name: &str) -> freshell_platform::CliCommandSpec {
    // DEFLAKE (f3wp refresh): the path must be unique PER CALL, not per
    // process. Both tests in this binary build a `claude` spec, so a
    // `{name}-{pid}`-only path is SHARED between them -- and test 2's
    // `fs::write` then races test 1's still-running PTY spawn: Linux holds
    // deny-write on a file while it is being `execve`d, so under load the
    // write fails with ETXTBSY ("Text file busy"). A fresh per-call path
    // (nanos + thread id) can never collide with an in-flight exec.
    let script_path = std::env::temp_dir().join(format!(
        "freshell-cross-kind-sleeper-{name}-{}-{}.sh",
        std::process::id(),
        uuid_like_suffix()
    ));
    std::fs::write(&script_path, "#!/bin/sh\nexec sleep 30\n").expect("write sleeper script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms).unwrap();
    }
    freshell_platform::CliCommandSpec {
        name: name.to_string(),
        label: format!("{name}-label"),
        env_var: None,
        default_cmd: script_path.to_string_lossy().to_string(),
        base_args: vec![],
        base_env: std::collections::BTreeMap::new(),
        resume_args: Some(vec!["--resume".to_string(), "{{sessionId}}".to_string()]),
        create_session_args: Some(vec![
            "--session-id".to_string(),
            "{{sessionId}}".to_string(),
        ]),
        model_args: None,
        sandbox_args: None,
        permission_mode_args: None,
    }
}

/// DEFLAKE (f3wp refresh): two `sleeper_cli_spec` calls in one process must
/// never share a script path. With a `{name}-{pid}`-only path, test 2's
/// `fs::write` races test 1's still-in-flight `execve` of the SAME file --
/// Linux denies writes to a file mid-exec, so under load the write fails with
/// `ETXTBSY` ("Text file busy", observed 2026-07-28 under the f3wp 10x load).
#[test]
fn sleeper_cli_spec_paths_are_unique_per_call() {
    let first = sleeper_cli_spec("claude");
    let second = sleeper_cli_spec("claude");
    assert_ne!(
        first.default_cmd, second.default_cmd,
        "same-name specs in one process must not share a script path -- \
         a shared path lets a later write race an earlier spawn's execve (ETXTBSY)"
    );
}

fn test_settings_value() -> serde_json::Value {
    json!({
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

/// Server with BOTH kinds live: a sleeper `claude` terminal CLI spec AND the
/// fresh-agent runtimes (freshAgent enabled). Returns the ws URL, the registry,
/// and the `WsState` clone (kata b8ke Task 3: the shared ownership
/// coordinator is minted HERE, exactly like `main.rs` injects it).
async fn spawn_server() -> (String, freshell_terminal::TerminalRegistry, WsState) {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));
    let registry = freshell_terminal::TerminalRegistry::new();
    let identity = freshell_ws::identity::TerminalIdentityRegistry::new();

    // The terminal-liveness probe the fresh-agent runtimes consult (Task 13b) --
    // the SAME join the D7 create-rung guard performs (identity owner + registry row).
    let terminal_liveness: freshell_freshagent::TerminalLivenessProbe = {
        let identity = identity.clone();
        let registry = registry.clone();
        Arc::new(move |provider: &str, session_id: &str| {
            let identity_owner_live =
                identity
                    .find_by_session(provider, session_id)
                    .is_some_and(|owner| {
                        registry.probe(&owner.terminal_id).is_some_and(|r| {
                            r.status == freshell_protocol::TerminalRunStatus::Running
                        })
                    });
            identity_owner_live
                || registry.directory().into_iter().any(|entry| {
                    entry.mode == provider
                        && entry.resume_session_id.as_deref() == Some(session_id)
                        && entry.status == freshell_protocol::TerminalRunStatus::Running
                })
        })
    };

    let mut fresh_claude = freshell_freshagent::FreshClaudeState::new(Arc::clone(&broadcast_tx));
    fresh_claude.set_terminal_liveness(Arc::clone(&terminal_liveness));
    let mut fresh_codex = freshell_freshagent::FreshCodexState::new(
        Arc::clone(&auth_token),
        Arc::clone(&broadcast_tx),
        json!({ "freshAgent": { "enabled": true } }),
    );
    fresh_codex.set_terminal_liveness(Arc::clone(&terminal_liveness));
    let fresh_agent_state = freshell_freshagent::FreshAgentState::new(
        Arc::clone(&auth_token),
        Arc::clone(&broadcast_tx),
    );
    let mut fresh_opencode = freshell_freshagent::FreshOpencodeState::new(fresh_agent_state);
    fresh_opencode.set_terminal_liveness(Arc::clone(&terminal_liveness));

    // kata b8ke Task 3: mint the ONE ownership coordinator and inject it into
    // every fresh state (mirrors main.rs — the cross-kind authority the lanes
    // claim through).
    let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    fresh_codex.set_ownership(Arc::clone(&ownership));
    fresh_claude.set_ownership(Arc::clone(&ownership));
    fresh_opencode.set_ownership(Arc::clone(&ownership));
    // kata b8ke Task 4: the SAME coordinator reaches the terminal lane — the
    // registry (release-only integration) and the WsState (the create/kill
    // claims + the ready-frame owner replay).
    let registry = registry.with_ownership(Arc::clone(&ownership));

    let state = WsState {
        layout: Default::default(),
        terminal_meta: Default::default(),
        pane_ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
        identity,
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
        fresh_codex,
        fresh_claude,
        fresh_opencode,
        registry: registry.clone(),
        tabs: freshell_ws::tabs::TabsRegistry::new(),
        screenshots: freshell_ws::screenshot::ScreenshotBroker::new(Arc::clone(&broadcast_tx)),
        subagent_interest: Default::default(),
        host_stats: Default::default(),
        terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        sessions_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        cli_commands: Arc::new(vec![sleeper_cli_spec("claude")]),
        shutdown: Arc::new(tokio::sync::Notify::new()),
        ping_interval_ms: 30_000,
        hello_timeout_ms: 5_000,
        allowed_origins: Arc::new(freshell_ws::origin::default_allowed_origins()),
        ws_max_payload_bytes: 16 * 1024 * 1024,
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
        ownership: Some(Arc::clone(&ownership)),
    };

    let router = freshell_ws::router(state.clone());
    // Ephemeral loopback port only -- NEVER the self-hosted 3001/3002 ports.
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    (format!("ws://{addr}/ws"), registry, state)
}

type TestWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(url: &str) -> TestWs {
    let (mut ws, _resp) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
    let hello = json!({
        "type": "hello",
        "token": AUTH_TOKEN,
        "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
        "capabilities": { "paneReconcileV1": true, "paneReconcileFreshAgentV1": true },
    });
    ws.send(WsMessage::Text(hello.to_string()))
        .await
        .expect("send hello");
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

/// Soft-timeout twin of [`await_frame`] (which returns `Value` and PANICS on
/// timeout): returns `None` when the budget elapses (or the stream ends)
/// without a matching frame — the race test's polling loops need a
/// non-panicking bounded wait (kata b8ke Task 4, round-1 review).
async fn try_await_frame(
    ws: &mut TestWs,
    budget: Duration,
    predicate: impl Fn(&Value) -> bool,
) -> Option<Value> {
    tokio::time::timeout(budget, async {
        loop {
            let msg = ws.next().await?.expect("no ws error");
            let WsMessage::Text(text) = msg else { continue };
            let value: Value = serde_json::from_str(&text).unwrap();
            if predicate(&value) {
                return Some(value);
            }
        }
    })
    .await
    .ok()
    .flatten()
}

/// [`connect`] variant that RETURNS the ready frame (connect consumes and
/// discards it — a test that must inspect `ready` uses this; kata b8ke Task 4,
/// round-1 review).
async fn connect_and_capture_ready(url: &str) -> (TestWs, Value) {
    let (mut ws, _resp) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
    let hello = json!({
        "type": "hello",
        "token": AUTH_TOKEN,
        "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
        "capabilities": { "paneReconcileV1": true, "paneReconcileFreshAgentV1": true },
    });
    ws.send(WsMessage::Text(hello.to_string()))
        .await
        .expect("send hello");
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("handshake message within timeout")
            .expect("stream not ended")
            .expect("no ws error");
        let WsMessage::Text(text) = msg else { continue };
        let value: Value = serde_json::from_str(&text).unwrap();
        if value["type"] == "ready" {
            return (ws, value); // the captured ready frame
        }
    }
}

/// [`connect`] variant that NEVER negotiates capabilities (kata b8ke Task 4,
/// round-2 review): the hello carries the protocol version but NO
/// `capabilities` object — the hand-rolled-script shape. The server still
/// authenticates it (token + exact protocol-version match); this connection
/// simply never enters the `paneReconcileV1` gate.
async fn connect_raw(url: &str) -> TestWs {
    let (mut ws, _resp) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
    let hello = json!({
        "type": "hello",
        "token": AUTH_TOKEN,
        "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
    });
    ws.send(WsMessage::Text(hello.to_string()))
        .await
        .expect("send hello");
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("handshake message within timeout")
            .expect("stream not ended")
            .expect("no ws error");
        let WsMessage::Text(text) = msg else { continue };
        let value: Value = serde_json::from_str(&text).unwrap();
        if value["type"] == "ready" {
            return ws;
        }
    }
}

/// The live-PTY count for a session (copied from
/// `session_ref_singleflight.rs`'s `live_pty_count_for_session`): the
/// identity-probe join the race test's UNION sampler consumes.
fn live_pty_count_for_session(
    registry: &freshell_terminal::TerminalRegistry,
    mode: &str,
    session_id: &str,
) -> usize {
    registry
        .identity_probe_rows()
        .into_iter()
        .filter(|row| {
            row.mode == mode
                && row.status == freshell_protocol::TerminalRunStatus::Running
                && row.resume_session_id.as_deref() == Some(session_id)
        })
        .count()
}

// ── the red tests ────────────────────────────────────────────────────────────────────

/// Direction 1 (V7 scenario B): a live terminal PTY owns `(claude, S)`; a
/// `freshAgent.create { resumeSessionId: S }` must be refused and spawn ZERO
/// sidecars. Post-ejh6 (Task 7) the refusal fires at the raw-Value ejh6 guard
/// (the create carries the legacy field) BEFORE the typed dispatch reaches the
/// SESSION_RESERVED cross-kind guard, so the code is
/// `FRESH_AGENT_CREATE_FAILED` + frozen text.
#[tokio::test]
async fn freshagent_resume_is_refused_while_a_terminal_pty_owns_the_session() {
    let _guard = ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();

    let (url, _registry, _ws_state) = spawn_server().await;
    let mut ws = connect(&url).await;

    // 1. A fresh claude terminal reaches Running, owning preallocated session S.
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create",
            "requestId": "req-term-owner-1",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
        }),
    )
    .await;
    let created = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "terminal.created" && v["requestId"] == "req-term-owner-1"
    })
    .await;
    let session_id = created["sessionRef"]["sessionId"]
        .as_str()
        .expect("fresh claude terminal carries a sessionRef")
        .to_string();

    // 2. A fresh-agent resume of the SAME session id (the "Reopen as freshclaude"
    //    abort-path shape) must be refused -- never a second writer on S's JSONL.
    send_json(
        &mut ws,
        &json!({
            "type": "freshAgent.create",
            "requestId": "req-fa-cross-1",
            "sessionType": "freshclaude",
            "provider": "claude",
            "cwd": "/tmp",
            "resumeSessionId": session_id,
            "sessionRef": { "provider": "claude", "sessionId": session_id },
        }),
    )
    .await;
    let failed = await_frame(&mut ws, Duration::from_secs(10), |v| {
        (v["type"] == "freshAgent.create.failed" || v["type"] == "freshAgent.created")
            && v["requestId"] == "req-fa-cross-1"
    })
    .await;
    assert_eq!(
        failed["type"], "freshAgent.create.failed",
        "a live terminal PTY owns {session_id}: the fresh-agent resume must be refused, got {failed}"
    );
    // ejh6: the legacy field is rejected at the door BEFORE the SESSION_RESERVED
    // cross-kind guard fires (the raw-Value ejh6 guard's freshAgent.create arm
    // runs first). The code is FRESH_AGENT_CREATE_FAILED + frozen text, not
    // SESSION_RESERVED.
    assert_eq!(failed["code"], "FRESH_AGENT_CREATE_FAILED");
    assert_eq!(
        failed["message"],
        "Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."
    );

    // 3. ZERO sidecar spawns.
    assert!(
        env.create_rows().is_empty(),
        "no sidecar may spawn while the terminal owns the session: {:?}",
        env.create_rows()
    );
}

/// Direction 1, sessionRef-only variant (whole-branch review finding 1): the ejh6
/// retarget of the test above left the STILL-REACHABLE production path unpinned --
/// a `freshAgent.create` carrying ONLY `sessionRef` (no legacy `resumeSessionId`)
/// passes the raw-Value ejh6 guard, reaches the typed dispatch, and must be
/// refused by the Task 13b cross-kind live-guard with
/// `freshAgent.create.failed { code: "SESSION_RESERVED", retryable: true }` and
/// ZERO sidecar spawns (the terminal may be closing -- retryable).
#[tokio::test]
async fn freshagent_session_ref_resume_is_refused_while_a_terminal_pty_owns_the_session() {
    let _guard = ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();

    let (url, _registry, _ws_state) = spawn_server().await;
    let mut ws = connect(&url).await;

    // 1. A fresh claude terminal reaches Running, owning preallocated session S.
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create",
            "requestId": "req-term-owner-2",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
        }),
    )
    .await;
    let created = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "terminal.created" && v["requestId"] == "req-term-owner-2"
    })
    .await;
    let session_id = created["sessionRef"]["sessionId"]
        .as_str()
        .expect("fresh claude terminal carries a sessionRef")
        .to_string();

    // 2. A sessionRef-ONLY fresh-agent resume of the SAME session id carries no
    //    legacy field, so it passes the raw-Value ejh6 guard and must be refused
    //    by the cross-kind live-guard -- never a second writer on S's JSONL.
    send_json(
        &mut ws,
        &json!({
            "type": "freshAgent.create",
            "requestId": "req-fa-cross-2",
            "sessionType": "freshclaude",
            "provider": "claude",
            "cwd": "/tmp",
            "sessionRef": { "provider": "claude", "sessionId": session_id },
        }),
    )
    .await;
    let failed = await_frame(&mut ws, Duration::from_secs(10), |v| {
        (v["type"] == "freshAgent.create.failed" || v["type"] == "freshAgent.created")
            && v["requestId"] == "req-fa-cross-2"
    })
    .await;
    assert_eq!(
        failed["type"], "freshAgent.create.failed",
        "a live terminal PTY owns {session_id}: the sessionRef-only resume must be refused, got {failed}"
    );
    assert_eq!(failed["code"], "SESSION_RESERVED");
    assert_eq!(
        failed["retryable"],
        serde_json::json!(true),
        "the terminal may be closing -- the cross-kind refusal must be retryable: {failed}"
    );

    // 3. ZERO sidecar spawns.
    assert!(
        env.create_rows().is_empty(),
        "no sidecar may spawn while the terminal owns the session: {:?}",
        env.create_rows()
    );
}

/// Direction 2: a live freshclaude sidecar owns `(claude, S)`; a `terminal.create`
/// whose wire sessionRef names S must be refused with the D7 guard's existing
/// rejection frame (`RESTORE_UNAVAILABLE`) and spawn no PTY.
#[tokio::test]
async fn terminal_create_is_refused_while_a_live_sidecar_owns_the_session() {
    let _guard = ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();

    let durable = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
    let (url, registry, _ws_state) = spawn_server().await;
    let mut ws = connect(&url).await;

    // 1. A fresh-agent resume of S goes live (the fake sidecar answers `created`).
    //    (ejh6 Task 7: sessionRef-only -- a legacy `resumeSessionId` carry is now
    //    rejected at the raw-Value guard, which would break this setup create.)
    send_json(
        &mut ws,
        &json!({
            "type": "freshAgent.create",
            "requestId": "req-fa-owner-1",
            "sessionType": "freshclaude",
            "provider": "claude",
            "cwd": "/tmp",
            "sessionRef": { "provider": "claude", "sessionId": durable },
        }),
    )
    .await;
    await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "freshAgent.created" && v["requestId"] == "req-fa-owner-1"
    })
    .await;
    assert_eq!(env.create_rows().len(), 1, "the sidecar owns S now");

    // 2. A terminal.create restoring the SAME session id (the D7 direct
    //    wire-sessionRef rung) must be refused -- the sidecar is the one writer.
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create",
            "requestId": "req-term-cross-1",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "restore": true,
            "sessionRef": { "provider": "claude", "sessionId": durable },
        }),
    )
    .await;
    let frame = await_frame(&mut ws, Duration::from_secs(10), |v| {
        (v["type"] == "error" || v["type"] == "terminal.created")
            && v["requestId"] == "req-term-cross-1"
    })
    .await;
    assert_eq!(
        frame["type"], "error",
        "a live sidecar owns {durable}: terminal.create must be refused, got {frame}"
    );
    assert_eq!(frame["code"], "RESTORE_UNAVAILABLE");
    assert!(
        frame["message"]
            .as_str()
            .is_some_and(|m| m.contains(durable)),
        "message must name the live session: {frame}"
    );

    // 3. No PTY spawned `claude --resume S`.
    assert!(
        !registry.directory().into_iter().any(|entry| {
            entry.mode == "claude" && entry.resume_session_id.as_deref() == Some(durable)
        }),
        "no terminal may own {durable} -- the sidecar is the one writer"
    );
}

/// Reconnect-revive Task 7 (cross-kind arm): when the D7 refusal fires
/// because a live FRESH-AGENT sidecar owns the session, no terminal id exists
/// to name -- the refusal must OMIT `liveTerminalId` entirely
/// (`#[serde(skip_serializing_if)]`; the field is additive and absent keeps
/// every other error frame byte-identical for frozen clients). The revival
/// arm stays inert: this refusal still dead-ends by design.
#[tokio::test]
async fn d7_cross_kind_refusal_omits_live_terminal_id() {
    let _guard = ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();

    let durable = "abababab-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
    let (url, registry, _ws_state) = spawn_server().await;
    let mut ws = connect(&url).await;

    // 1. A fresh-agent resume of S goes live (the fake sidecar answers `created`).
    send_json(
        &mut ws,
        &json!({
            "type": "freshAgent.create",
            "requestId": "req-fa-owner-d7",
            "sessionType": "freshclaude",
            "provider": "claude",
            "cwd": "/tmp",
            "sessionRef": { "provider": "claude", "sessionId": durable },
        }),
    )
    .await;
    await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "freshAgent.created" && v["requestId"] == "req-fa-owner-d7"
    })
    .await;
    assert_eq!(env.create_rows().len(), 1, "the sidecar owns S now");

    // 2. The D7 cross-kind refusal: RESTORE_UNAVAILABLE, message names the
    //    session, and NO liveTerminalId (no terminal owns the session).
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create",
            "requestId": "req-term-cross-d7",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "restore": true,
            "sessionRef": { "provider": "claude", "sessionId": durable },
        }),
    )
    .await;
    let frame = await_frame(&mut ws, Duration::from_secs(10), |v| {
        (v["type"] == "error" || v["type"] == "terminal.created")
            && v["requestId"] == "req-term-cross-d7"
    })
    .await;
    assert_eq!(
        frame["type"], "error",
        "a live sidecar owns {durable}: terminal.create must be refused, got {frame}"
    );
    assert_eq!(frame["code"], "RESTORE_UNAVAILABLE");
    assert!(
        frame["message"]
            .as_str()
            .is_some_and(|m| m.contains(durable)),
        "message must name the live session: {frame}"
    );
    assert!(
        frame.get("liveTerminalId").is_none(),
        "the cross-kind arm has no terminal id to name and must omit the field: {frame}"
    );

    // 3. No PTY spawned `claude --resume S`.
    assert!(
        !registry.directory().into_iter().any(|entry| {
            entry.mode == "claude" && entry.resume_session_id.as_deref() == Some(durable)
        }),
        "no terminal may own {durable} -- the sidecar is the one writer"
    );
}

/// kata b8ke Task 3: a real freshclaude create/kill drives the shared
/// coordinator — Live{FreshAgent} while alive, Vacant after the awaited kill.
#[tokio::test]
async fn fresh_agent_create_and_kill_drive_the_shared_coordinator() {
    let _guard = ENV_LOCK.lock().await;
    let sidecar = FakeSidecarEnv::install(); // SYNC at base — no .await
    let (url, _registry, ws_state) = spawn_server().await;
    let mut ws = connect(&url).await;
    let sid = format!("coord-{}", uuid::Uuid::new_v4());
    send_json(
        &mut ws,
        &json!({
            "type": "freshAgent.create", "requestId": "req-coord-1",
            "sessionType": "freshclaude", "provider": "claude",
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    let _created = await_frame(&mut ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("freshAgent.created")
    })
    .await;
    let snap = ws_state.fresh_claude.ownership_snapshot("claude", &sid);
    assert!(
        matches!(snap.state, freshell_ownership::OwnershipState::Live { .. }),
        "expected Live fresh-agent owner, got {:?}",
        snap.state
    );
    send_json(
        &mut ws,
        &json!({
            "type": "freshAgent.kill", "sessionId": sid,
            "sessionType": "freshclaude", "provider": "claude",
        }),
    )
    .await;
    let _killed = await_frame(&mut ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("freshAgent.killed")
            && v.get("sessionId").and_then(|s| s.as_str()) == Some(sid.as_str())
    })
    .await;
    let snap = ws_state.fresh_claude.ownership_snapshot("claude", &sid);
    assert_eq!(
        snap.state,
        freshell_ownership::OwnershipState::Vacant,
        "kill must release ownership only after the confirmed reap"
    );
    let _ = sidecar;
}

/// kata b8ke Task 4: the two-writers START race. Both creates are sent
/// back-to-back with NO sequencing (the genuine-race pattern from
/// session_ref_singleflight.rs); whichever wins, exactly one runtime may
/// exist for the session and the loser must have a TYPED answer.
#[tokio::test]
async fn concurrent_terminal_and_fresh_agent_start_same_session_ref_yield_one_writer() {
    let _guard = ENV_LOCK.lock().await;
    let sidecar = FakeSidecarEnv::install(); // SYNC at base — no .await
    let (url, registry, _ws_state) = spawn_server().await;
    let sid = format!("race-{}", uuid::Uuid::new_v4());
    let mut ws_term = connect(&url).await;
    let mut ws_fresh = connect(&url).await;

    // Fire both with zero awaits between the sends.
    let term_req = "race-term-1";
    let fresh_req = "race-fresh-1";
    let term_frame = json!({
        "type": "terminal.create", "requestId": term_req, "mode": "claude",
        "shell": "system", "cwd": std::env::temp_dir().to_string_lossy(),
        "sessionRef": { "provider": "claude", "sessionId": sid },
    });
    let fresh_frame = json!({
        "type": "freshAgent.create", "requestId": fresh_req,
        "sessionType": "freshclaude", "provider": "claude",
        "sessionRef": { "provider": "claude", "sessionId": sid },
    });
    let send_term = send_json(&mut ws_term, &term_frame);
    let send_fresh = send_json(&mut ws_fresh, &fresh_frame);
    let ((), ()) = tokio::join!(send_term, send_fresh);

    // The UNION sampler (round-1 review): fresh sidecar creates PLUS terminal
    // PTYs for the session — the one-writer invariant is over the UNION, not
    // two separate <=1 assertions (one sidecar + one PTY would pass those).
    let live_writers = || {
        let creates = sidecar
            .create_rows()
            .iter()
            .filter(|r| r["msg"]["resumeSessionId"].as_str() == Some(sid.as_str()))
            .count();
        let ptys = live_pty_count_for_session(&registry, "claude", &sid);
        creates + ptys
    };

    // Wait until BOTH requests have a terminal answer (created OR typed error),
    // sampling the union across the interleaving.
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let mut term_answered = false;
    let mut fresh_answered = false;
    while std::time::Instant::now() < deadline && !(term_answered && fresh_answered) {
        if !term_answered {
            if let Some(frame) = try_await_frame(&mut ws_term, Duration::from_millis(250), |v| {
                let t = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
                t == "terminal.created" || t == "error"
            })
            .await
            {
                if frame.get("requestId").and_then(|r| r.as_str()) == Some(term_req) {
                    term_answered = true;
                }
            }
        }
        if !fresh_answered {
            if let Some(frame) = try_await_frame(&mut ws_fresh, Duration::from_millis(250), |v| {
                let t = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
                t == "freshAgent.created" || t == "freshAgent.create.failed"
            })
            .await
            {
                if frame.get("requestId").and_then(|r| r.as_str()) == Some(fresh_req) {
                    fresh_answered = true;
                }
            }
        }
        assert!(
            live_writers() <= 1,
            "the UNION of live writers (sidecars + PTYs) may never exceed 1 mid-race"
        );
    }
    assert!(
        term_answered && fresh_answered,
        "both requests must receive a typed answer"
    );

    // Final settle: the union is still at most one (the loser was typed, and
    // any loser-side runtime was torn down — not left running).
    assert!(
        live_writers() <= 1,
        "exactly one runtime may survive the race"
    );
}

/// kata b8ke Task 4: the fresh-agent→terminal refusal carries the typed
/// owner fields (additive; frozen text untouched).
#[tokio::test]
async fn terminal_create_refusal_names_the_fresh_agent_owner_kind_and_generation() {
    let _guard = ENV_LOCK.lock().await;
    let _sidecar = FakeSidecarEnv::install(); // SYNC at base — no .await
    let (url, _registry, _ws_state) = spawn_server().await;
    let mut ws = connect(&url).await;
    let sid = format!("typed-owner-{}", uuid::Uuid::new_v4());
    // Establish a live freshclaude owner first.
    send_json(
        &mut ws,
        &json!({
            "type": "freshAgent.create", "requestId": "own-1",
            "sessionType": "freshclaude", "provider": "claude",
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    let _ = await_frame(&mut ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("freshAgent.created")
    })
    .await;
    // Competing terminal create is refused with the additive typed fields.
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create", "requestId": "ref-1", "mode": "claude",
            "shell": "system", "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    let err = await_frame(&mut ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("error")
            && v.get("requestId").and_then(|r| r.as_str()) == Some("ref-1")
    })
    .await;
    assert_eq!(
        err.get("code").and_then(|c| c.as_str()),
        Some("RESTORE_UNAVAILABLE")
    );
    // Frozen text untouched.
    assert!(err
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .contains("is still running on the server."));
    // NEW additive typed fields:
    assert_eq!(
        err.get("ownerKind").and_then(|k| k.as_str()),
        Some("fresh-agent")
    );
    assert!(
        err.get("ownerGeneration")
            .and_then(|g| g.as_u64())
            .unwrap_or(0)
            >= 1
    );
}

/// kata b8ke Task 4 (round-2 review): the terminal coordinator claim is
/// UNGATED — a connection that NEVER negotiates paneReconcileV1 still goes
/// through the coordinator. With a live fresh-agent owner, its
/// terminal.create is refused with the same frozen D7 text and the typed
/// owner fields; and on a VACANT key its create CLAIMS through the
/// coordinator (a second create from a negotiated connection is
/// typed-refused) — the vacant-state race is closed for non-negotiated
/// senders too, not just via the check-then-act D7 probe.
#[tokio::test]
async fn non_negotiated_terminal_create_is_coordinator_fenced() {
    let _guard = ENV_LOCK.lock().await;
    let _sidecar = FakeSidecarEnv::install(); // SYNC at base — no .await
    let (url, _registry, _ws_state) = spawn_server().await;
    let sid = format!("raw-{}", uuid::Uuid::new_v4());
    // A negotiated connection establishes the fresh owner.
    let mut ws_owner = connect(&url).await;
    send_json(
        &mut ws_owner,
        &json!({
            "type": "freshAgent.create", "requestId": "raw-own-1",
            "sessionType": "freshclaude", "provider": "claude",
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    let _ = await_frame(&mut ws_owner, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("freshAgent.created")
    })
    .await;
    // The NON-NEGOTIATED connection's create is coordinator-fenced.
    let mut ws_raw = connect_raw(&url).await;
    send_json(
        &mut ws_raw,
        &json!({
            "type": "terminal.create", "requestId": "raw-ref-1", "mode": "claude",
            "shell": "system", "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    let err = await_frame(&mut ws_raw, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("error")
            && v.get("requestId").and_then(|r| r.as_str()) == Some("raw-ref-1")
    })
    .await;
    assert_eq!(
        err.get("code").and_then(|c| c.as_str()),
        Some("RESTORE_UNAVAILABLE")
    );
    assert!(
        err.get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("")
            .contains("is still running on the server."),
        "frozen D7 text preserved"
    );
    assert_eq!(
        err.get("ownerKind").and_then(|k| k.as_str()),
        Some("fresh-agent")
    );
    // The vacant-state half: a non-negotiated create on a FRESH key claims
    // through the coordinator and COMMITS the terminal owner. (A negotiated
    // second create would ATTACH through the registry lease's
    // BoundElsewhere arm — same-mode multi-device attachment is pinned
    // behavior — so the claim's visibility is observed the two ways a
    // non-negotiated sender sees it: the frozen D7 refusal carrying the
    // coordinator-recorded owner fields, and the ready-frame owner replay.)
    let sid_b = format!("raw-b-{}", uuid::Uuid::new_v4());
    let mut ws_raw_b = connect_raw(&url).await;
    send_json(
        &mut ws_raw_b,
        &json!({
            "type": "terminal.create", "requestId": "raw-b-1", "mode": "claude",
            "shell": "system", "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": sid_b },
        }),
    )
    .await;
    let _ = await_frame(&mut ws_raw_b, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("terminal.created")
    })
    .await;
    // The raw connection's committed claim is authoritative: a fresh
    // connection's ready frame replays the terminal owner for sid_b.
    let (ws_replay, ready_b) = connect_and_capture_ready(&url).await;
    let owners_b = ready_b
        .get("runtimeOwners")
        .and_then(|v| v.as_array())
        .expect("runtimeOwners present");
    assert!(
        owners_b.iter().any(|o| {
            o.get("sessionId").and_then(|s| s.as_str()) == Some(sid_b.as_str())
                && o.get("ownerKind").and_then(|k| k.as_str()) == Some("terminal")
        }),
        "the raw connection's claim must be recorded: {ready_b}"
    );
    drop(ws_replay);
    // A second NON-NEGOTIATED create for the same key is refused by the D7
    // guard, and the refusal's typed owner fields name the TERMINAL owner
    // the raw connection committed (from the coordinator's record).
    let mut ws_raw_c = connect_raw(&url).await;
    send_json(
        &mut ws_raw_c,
        &json!({
            "type": "terminal.create", "requestId": "raw-b-2", "mode": "claude",
            "shell": "system", "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": sid_b },
        }),
    )
    .await;
    let refused = await_frame(&mut ws_raw_c, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("error")
            && v.get("requestId").and_then(|r| r.as_str()) == Some("raw-b-2")
    })
    .await;
    assert_eq!(
        refused.get("code").and_then(|c| c.as_str()),
        Some("RESTORE_UNAVAILABLE")
    );
    assert_eq!(
        refused.get("ownerKind").and_then(|k| k.as_str()),
        Some("terminal")
    );
    assert!(
        refused.get("liveTerminalId").is_some(),
        "the terminal owner is nameable for revival: {refused}"
    );
}

/// kata b8ke Task 4 (reconnect owner discovery, T1 rec A3): a NEW
/// connection's `ready` frame replays current runtime-owner state, so a
/// device that missed the handoff broadcast (offline during handoff,
/// lag-4008 disconnect, page reload) learns the authoritative owner from the
/// handshake alone. NOTE (round-1 review): `connect` CONSUMES and discards
/// the ready frame — the replay assertions use `connect_and_capture_ready`
/// (the capture variant added above), never a second wait for a frame that
/// was already read.
#[tokio::test]
async fn ready_frame_replays_current_runtime_owners() {
    let _guard = ENV_LOCK.lock().await;
    let _sidecar = FakeSidecarEnv::install(); // SYNC at base — no .await
    let (url, _registry, _ws_state) = spawn_server().await;
    let mut ws = connect(&url).await;
    let sid = format!("replay-{}", uuid::Uuid::new_v4());
    send_json(
        &mut ws,
        &json!({
            "type": "freshAgent.create", "requestId": "replay-1",
            "sessionType": "freshclaude", "provider": "claude",
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    let _ = await_frame(&mut ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("freshAgent.created")
    })
    .await;
    // A SECOND connection (the "reloaded/reconnected device"): the ready
    // frame itself carries the owner — no broadcast needed.
    let (ws_b, ready) = connect_and_capture_ready(&url).await;
    let owners = ready
        .get("runtimeOwners")
        .and_then(|v| v.as_array())
        .expect("runtimeOwners present when the registry is injected");
    assert!(
        owners.iter().any(|o| {
            o.get("provider").and_then(|p| p.as_str()) == Some("claude")
                && o.get("sessionId").and_then(|s| s.as_str()) == Some(sid.as_str())
                && o.get("ownerKind").and_then(|k| k.as_str()) == Some("fresh-agent")
                && o.get("epoch").and_then(|e| e.as_u64()).unwrap_or(0) >= 1
                && o.get("generation").and_then(|g| g.as_u64()).unwrap_or(0) >= 1
        }),
        "each replay record carries the boot epoch (round-2 review)"
    );
    // Kill releases the key: a THIRD connection's ready replays it as
    // "vacant" — the divergence-clearing half of the replay.
    send_json(
        &mut ws,
        &json!({
            "type": "freshAgent.kill", "sessionId": sid,
            "sessionType": "freshclaude", "provider": "claude",
        }),
    )
    .await;
    let _ = await_frame(&mut ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("freshAgent.killed")
            && v.get("sessionId").and_then(|s| s.as_str()) == Some(sid.as_str())
    })
    .await;
    let (ws_c, ready_c) = connect_and_capture_ready(&url).await;
    let owners_c = ready_c
        .get("runtimeOwners")
        .and_then(|v| v.as_array())
        .expect("runtimeOwners present");
    assert!(
        owners_c.iter().any(|o| {
            o.get("sessionId").and_then(|s| s.as_str()) == Some(sid.as_str())
                && o.get("ownerKind").and_then(|k| k.as_str()) == Some("vacant")
        }),
        "released keys must replay as vacant so replay clears stale divergence"
    );
    drop(ws_b);
    drop(ws_c);
}
