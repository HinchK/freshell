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

// ── dual-role codex fake (kata b8ke Task 5; the codex_sidecar_reattach_e2e.rs
//    pattern, self-contained here) ──────────────────────────────────────────
//
// `CODEX_CMD` points at a node dispatcher: argv containing `app-server`
// (the freshcodex sidecar spawn) routes to the committed fake app-server
// fixture; anything else (a terminal TUI launch) just stays alive. Two
// spawn-count surfaces, both per-instance:
// - the dispatcher logs EVERY invocation's argv (`sidecar_spawn_rows` —
//   only app-server spawns reach it in this harness);
// - the fixture appends every `thread/*` operation with its thread id to
//   the durable op ledger (`thread_op_rows` — `thread/start`,
//   `thread/resume`, ...).

struct DualRoleCodexFake {
    dir: std::path::PathBuf,
}

impl DualRoleCodexFake {
    fn install() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "freshell-cross-kind-codex-fake-{}",
            uuid_like_suffix()
        ));
        std::fs::create_dir_all(&dir).expect("create codex fake temp dir");
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs")
            .canonicalize()
            .expect("fake-app-server fixture exists");
        let dispatcher = dir.join("dispatcher.mjs");
        let script = format!(
            "#!/usr/bin/env node\n\
             import fs from 'node:fs'\n\
             const args = process.argv.slice(2)\n\
             if (process.env.FAKE_CODEX_DISPATCHER_LOG) {{\n\
               fs.appendFileSync(process.env.FAKE_CODEX_DISPATCHER_LOG, \
             JSON.stringify({{ pid: process.pid, argv: args }}) + '\\n')\n\
             }}\n\
             if (args.includes('app-server')) {{\n\
               await import('file://{}')\n\
             }} else {{\n\
               setInterval(() => undefined, 1000)\n\
             }}\n",
            fixture.display()
        );
        std::fs::write(&dispatcher, script).expect("write codex dispatcher");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&dispatcher).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&dispatcher, perms).expect("chmod codex dispatcher");
        }
        std::env::set_var("CODEX_CMD", format!("node {}", dispatcher.display()));
        // The fixture's durable thread-op ledger: every `thread/*` method
        // appends {method, threadId, params, ...} — the no-spawn watermark.
        let behavior = serde_json::json!({
            "appendThreadOperationLogPath": dir.join("thread-ops.jsonl"),
        });
        std::env::set_var("FAKE_CODEX_APP_SERVER_BEHAVIOR", behavior.to_string());
        std::env::set_var(
            "FAKE_CODEX_DISPATCHER_LOG",
            dir.join("dispatcher-log.jsonl"),
        );
        Self { dir }
    }

    fn rows_from(&self, file: &str) -> Vec<Value> {
        let Ok(raw) = std::fs::read_to_string(self.dir.join(file)) else {
            return Vec::new();
        };
        raw.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str::<Value>(l).expect("log row parses"))
            .collect()
    }

    /// Every app-server role the dispatcher routed to the fixture — the
    /// sidecar spawn count.
    fn sidecar_spawn_rows(&self) -> Vec<Value> {
        self.rows_from("dispatcher-log.jsonl")
            .into_iter()
            .filter(|row| {
                row["argv"]
                    .as_array()
                    .is_some_and(|argv| argv.iter().any(|a| a == "app-server"))
            })
            .collect()
    }

    /// The fixture's durable `thread/*` op ledger (method + threadId) — the
    /// `thread/resume`-never-happens surface the side-effect-free GET
    /// contract asserts against.
    fn thread_op_rows(&self) -> Vec<Value> {
        self.rows_from("thread-ops.jsonl")
    }
}

impl Drop for DualRoleCodexFake {
    fn drop(&mut self) {
        // Reap every process the dispatcher spawned (the managed-launch
        // sidecars a mode-codex terminal create plans, and the explicit
        // freshAgent.create's sidecar — none of them outlive the fake): the
        // fixture has no SIGTERM handler, so a plain kill terminates it.
        // Read BEFORE the dir removal below consumes the log.
        for row in self.rows_from("dispatcher-log.jsonl") {
            if let Some(pid) = row["pid"].as_u64() {
                #[cfg(unix)]
                {
                    let _ = std::process::Command::new("kill")
                        .arg(pid.to_string())
                        .status();
                }
                let _ = pid; // non-unix: nothing to do (this suite is unix-shaped anyway)
            }
        }
        for var in [
            "CODEX_CMD",
            "FAKE_CODEX_APP_SERVER_BEHAVIOR",
            "FAKE_CODEX_DISPATCHER_LOG",
        ] {
            std::env::remove_var(var);
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
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

/// Shared construction for both harness shapes in this file: the `WsState`
/// with BOTH kinds live (a sleeper terminal CLI spec per requested mode AND
/// the fresh-agent runtimes, freshAgent enabled), the terminal-liveness
/// probe joined over the identity registry, and the kata b8ke Task 3/4
/// ownership coordinator minted HERE and injected into every fresh state,
/// the registry, and the WsState (exactly like `main.rs`). Returns the
/// state, the registry, and the opencode slice's inner `FreshAgentState`
/// (the snapshot REST door needs it — `main.rs`'s `SnapshotState::new`
/// shape).
async fn build_ws_state(
    cli_commands: Vec<freshell_platform::CliCommandSpec>,
) -> (
    WsState,
    freshell_terminal::TerminalRegistry,
    freshell_freshagent::FreshAgentState,
) {
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
    let mut fresh_opencode =
        freshell_freshagent::FreshOpencodeState::new(fresh_agent_state.clone());
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
        cli_commands: Arc::new(cli_commands),
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

    (state, registry, fresh_agent_state)
}

/// Server with BOTH kinds live: a sleeper `claude` terminal CLI spec AND the
/// fresh-agent runtimes (freshAgent enabled). Returns the ws URL, the registry,
/// and the `WsState` clone (kata b8ke Task 3: the shared ownership
/// coordinator is minted HERE, exactly like `main.rs` injects it).
async fn spawn_server() -> (String, freshell_terminal::TerminalRegistry, WsState) {
    let (state, registry, _fresh_agent_state) =
        build_ws_state(vec![sleeper_cli_spec("claude")]).await;

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

/// kata b8ke Task 5: the merged harness — the WS door AND the snapshot REST
/// door (`GET /api/fresh-agent/threads/...`) on ONE axum app over the SAME
/// state slices (main.rs's router-merge shape), with BOTH a `claude` and a
/// `codex` sleeper terminal spec so a `mode:"codex"` terminal create
/// genuinely spawns a Running PTY (the `rest_claude_identity.rs`
/// spawn_merged_server pattern).
struct MergedHarness {
    base_url: String,
    ws: TestWs,
    ws_state: WsState,
}

async fn spawn_merged_server() -> MergedHarness {
    let cli_commands = Arc::new(vec![sleeper_cli_spec("claude"), sleeper_cli_spec("codex")]);
    let (state, registry, fresh_agent_state) =
        build_ws_state(cli_commands.iter().cloned().collect()).await;

    // The snapshot REST door shares the WS door's state slices (main.rs's
    // `SnapshotState::new` wiring: same auth token, same codex/claude
    // clones, the opencode slice's inner FreshAgentState).
    let snapshot_state = freshell_freshagent::SnapshotState::new(
        Arc::new(AUTH_TOKEN.to_string()),
        state.fresh_codex.clone(),
        fresh_agent_state.clone(),
        state.fresh_claude.clone(),
    );
    // kata b8ke Task 6: the handoff runner — the SAME fresh states, registry,
    // coordinator, broadcast bus, and CLI specs (main.rs's mint shape; the
    // REST spawn state additionally wired with the registry + specs the
    // terminal-target pipeline needs).
    let ownership = state.ownership.clone().expect("coordinator wired");
    let handoff_runner = Arc::new(freshell_freshagent::SessionHandoffRunner::new(
        Arc::new(AUTH_TOKEN.to_string()),
        state.broadcast_tx.clone(),
        ownership,
        registry.clone(),
        state.fresh_codex.clone(),
        state.fresh_claude.clone(),
        state.fresh_opencode.clone(),
        fresh_agent_state
            .with_ownership(state.ownership.clone().expect("coordinator wired"))
            .with_terminal_registry(registry.clone())
            .with_cli_commands(Arc::clone(&cli_commands)),
        Arc::clone(&cli_commands),
    ));
    let app = freshell_ws::router(state.clone())
        .merge(freshell_freshagent::snapshot::router(snapshot_state))
        .merge(freshell_freshagent::session_handoff::handoff_router(
            handoff_runner,
        ));

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let ws_url = format!("ws://{addr}/ws");
    let ws = connect(&ws_url).await;
    MergedHarness {
        base_url: format!("http://{addr}"),
        ws,
        ws_state: state,
    }
}

/// A parsed minimal HTTP GET response: `(status, JSON body)` — the
/// `rest_claude_identity.rs::raw_post_tabs` raw-TcpStream pattern, GET
/// flavor, for the snapshot REST door the merged harness serves.
async fn http_get_json(base_url: &str, path: &str) -> (u16, serde_json::Value) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let host = base_url
        .strip_prefix("http://")
        .expect("base_url is http://{addr}");
    let request = format!(
        "GET {path} HTTP/1.1\r\n\
         Host: {host}\r\n\
         x-auth-token: {token}\r\n\
         Connection: close\r\n\
         \r\n",
        token = AUTH_TOKEN,
    );
    let mut stream = tokio::net::TcpStream::connect(host)
        .await
        .expect("connect to merged server");
    stream
        .write_all(request.as_bytes())
        .await
        .expect("write HTTP GET");
    let mut raw = Vec::new();
    tokio::time::timeout(Duration::from_secs(15), stream.read_to_end(&mut raw))
        .await
        .expect("HTTP response within deadline")
        .expect("read HTTP response");
    let text = String::from_utf8(raw).expect("utf8 HTTP response");
    let (head, response_body) = text
        .split_once("\r\n\r\n")
        .expect("HTTP header/body separator");
    let status: u16 = head
        .split_whitespace()
        .nth(1)
        .expect("status code in status line")
        .parse()
        .expect("numeric status code");
    let json = serde_json::from_str(response_body.trim()).unwrap_or(serde_json::Value::Null);
    (status, json)
}

/// A parsed minimal HTTP POST response: `(status, JSON body)` — the GET
/// helper's POST twin (same raw-TcpStream pattern), for the handoff REST
/// endpoint the merged harness serves (kata b8ke Task 6).
async fn http_post_json(
    base_url: &str,
    path: &str,
    body: &serde_json::Value,
) -> (u16, serde_json::Value) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let host = base_url
        .strip_prefix("http://")
        .expect("base_url is http://{addr}");
    let payload = body.to_string();
    let request = format!(
        "POST {path} HTTP/1.1\r\n\
         Host: {host}\r\n\
         x-auth-token: {token}\r\n\
         content-type: application/json\r\n\
         content-length: {len}\r\n\
         Connection: close\r\n\
         \r\n\
         {payload}",
        token = AUTH_TOKEN,
        len = payload.len(),
    );
    let mut stream = tokio::net::TcpStream::connect(host)
        .await
        .expect("connect to merged server");
    stream
        .write_all(request.as_bytes())
        .await
        .expect("write HTTP POST");
    let mut raw = Vec::new();
    tokio::time::timeout(Duration::from_secs(35), stream.read_to_end(&mut raw))
        .await
        .expect("HTTP response within deadline")
        .expect("read HTTP response");
    let text = String::from_utf8(raw).expect("utf8 HTTP response");
    let (head, response_body) = text
        .split_once("\r\n\r\n")
        .expect("HTTP header/body separator");
    let status: u16 = head
        .split_whitespace()
        .nth(1)
        .expect("status code in status line")
        .parse()
        .expect("numeric status code");
    let json = serde_json::from_str(response_body.trim()).unwrap_or(serde_json::Value::Null);
    (status, json)
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

    // N1 (Task 4 review, applied): event-sourced union assertion — every PTY
    // SPAWN for the raced session is counted through the registry's activity
    // tap, so a sub-cadence two-writer transient (spawn + teardown landing
    // between sampler iterations) can no longer evade the check: the spawn
    // itself is the violation, sampled or not.
    let pty_spawns = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    {
        let pty_spawns = Arc::clone(&pty_spawns);
        let sid_for_tap = sid.clone();
        registry.set_activity_observer(Arc::new(move |event| {
            if let freshell_terminal::registry::ActivityEvent::Created {
                mode,
                resume_session_id,
                ..
            } = &event
            {
                if mode == "claude" && resume_session_id.as_deref() == Some(sid_for_tap.as_str()) {
                    pty_spawns.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
            }
        }));
    }

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
    // N1 (Task 4 review, applied): the event-sourced union — PTY spawns PLUS
    // sidecar creates — may never exceed 1 either. This is cadence-
    // independent: even a transient second writer that spawned and was torn
    // down between two sampler iterations leaves its Created event behind.
    let sidecar_creates = sidecar
        .create_rows()
        .iter()
        .filter(|r| r["msg"]["resumeSessionId"].as_str() == Some(sid.as_str()))
        .count();
    assert!(
        pty_spawns.load(std::sync::atomic::Ordering::SeqCst) + sidecar_creates <= 1,
        "the union of SPAWNED writers (PTY spawns + sidecar creates) may never exceed 1"
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

// ── kata b8ke Task 4 review M1 (fix): total coordinator coverage ───────────
//
// The Adopt arm claims nothing (a live same-kind terminal owner exists — the
// registry lease's BoundElsewhere or the D7 refusal handles it). Three narrow
// windows can then leave a live terminal writer with NO coordinator record:
// 1. The Adopt-seen owner DIES after the claim but before the lease/D7 gate —
//    the lease acquires and the create spawns anyway, holding no claim, so the
//    settle previously skipped the coordinator commit (the key stayed Vacant
//    while the new terminal lived).
// 2. A LATER owner legitimately claims the freed key while that create is
//    spawning — the settle must never clobber it.
// 3. A Granted claim attaches through BoundElsewhere to a binding holder that
//    never committed (the shape-1 leftover): the attach previously returned
//    with the claim typed-failed while the attached terminal lived.
//
// Determinism: the "owner death" in these tests is injected through the
// registry's activity tap — the Created event fires inside the spawn's blocking
// task, i.e. AFTER the door's claim but strictly BEFORE the settle — where the
// phantom owner's fenced release runs. claim < Created < settle is the
// handler's own control flow, so no timing races.

/// M1 shape 1: the same-kind Adopt→death→acquire interleaving. The create's
/// claim sees a Live TERMINAL owner (Adopt — the arm that claims nothing);
/// that owner dies after the claim but before the settle, and the registry
/// lease then acquires, so the create spawns anyway. The settle must COMMIT
/// ownership for the surviving terminal — previously it skipped the commit
/// whenever the create held no claim, leaving the key Vacant while the
/// terminal lived (a fresh-agent create for the same key would be Granted:
/// the two-writer door).
#[tokio::test]
async fn same_kind_adopt_death_acquire_settle_commits_the_surviving_terminal() {
    let (url, registry, ws_state) = spawn_server().await;
    let ownership = ws_state.ownership.clone().expect("coordinator wired");
    let sid = format!("adopt-gap-{}", uuid::Uuid::new_v4());

    // The pre-existing same-kind writer the Adopt arm will see: a Live
    // TERMINAL owner for (claude, sid).
    let phantom_op = "op-adopt-gap-phantom";
    let freshell_ownership::BeginOutcome::Granted { generation } = ownership.begin_start(
        "claude",
        &sid,
        freshell_ownership::RuntimeOwnerKind::Terminal,
        phantom_op,
        None,
        "test",
        1_000,
    ) else {
        panic!("expected Granted")
    };
    let phantom = freshell_ownership::OwnerIdentity {
        kind: freshell_ownership::RuntimeOwnerKind::Terminal,
        terminal_id: Some("t-adopt-gap-phantom".into()),
        live_session_key: None,
        pid: None,
        ownership_id: None,
    };
    assert_eq!(
        ownership.commit_live("claude", &sid, phantom_op, generation, phantom.clone()),
        freshell_ownership::CommitOutcome::Committed
    );
    // commit_live stamps ownership_id from the committing operation.
    let mut stored_phantom = phantom.clone();
    stored_phantom.ownership_id = Some(phantom_op.to_string());

    // The mid-handler death: when the create's real spawn inserts the new
    // terminal row (Created), release the phantom exactly as its exit
    // watcher would (fenced claim) — the key is Vacant by the settle.
    {
        let ownership = ownership.clone();
        let sid = sid.clone();
        registry.set_activity_observer(Arc::new(move |event| {
            if let freshell_terminal::registry::ActivityEvent::Created {
                mode,
                resume_session_id,
                ..
            } = &event
            {
                if mode == "claude" && resume_session_id.as_deref() == Some(sid.as_str()) {
                    ownership.release(
                        "claude",
                        &sid,
                        &freshell_ownership::ReleaseClaim {
                            operation_id: phantom_op.to_string(),
                            generation,
                            runtime: Some(stored_phantom.clone()),
                        },
                        "test/adopt-gap",
                    );
                }
            }
        }));
    }

    let mut ws = connect(&url).await;
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create", "requestId": "adopt-gap-1", "mode": "claude",
            "shell": "system", "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    let created = await_frame(&mut ws, Duration::from_secs(20), |v| {
        (v["type"] == "terminal.created" || v["type"] == "error") && v["requestId"] == "adopt-gap-1"
    })
    .await;
    assert_eq!(
        created["type"], "terminal.created",
        "the gap create itself must succeed: {created}"
    );
    let survivor = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();

    match ownership.observe("claude", &sid).state {
        freshell_ownership::OwnershipState::Live { owner, .. } => {
            assert_eq!(
                owner.terminal_id.as_deref(),
                Some(survivor.as_str()),
                "the settle must commit the SURVIVING terminal, not the dead phantom"
            );
        }
        other => panic!("the settle must record the surviving terminal's ownership, got {other:?}"),
    }
    // Cross-kind protection is restored with it: a fresh-agent start on the
    // key is typed-refused (pre-fix this was Granted — the two-writer door).
    assert!(
        matches!(
            ownership.begin_start(
                "claude",
                &sid,
                freshell_ownership::RuntimeOwnerKind::FreshAgent,
                "op-after-adopt-gap",
                None,
                "test",
                2_000,
            ),
            freshell_ownership::BeginOutcome::OwnedByOtherKind { .. }
        ),
        "a recorded terminal owner must fence a competing fresh-agent start"
    );
}

/// M1 shape 2 (fence coherence): a LATER owner that legitimately claimed
/// while the key was Vacant (the phantom's release landed mid-spawn, then a
/// fresh-agent start claimed the freed key) must NEVER be clobbered by the
/// settle's late claim. The late claim must answer OwnedByOtherKind instead
/// of Granted, and the just-spawned terminal — now an unowned writer — must
/// be handled per the stale-teardown path: killed, confirmed, error reply,
/// the later owner left untouched.
#[tokio::test]
async fn settle_late_claim_never_clobbers_a_later_owner_and_tears_the_spawn_down() {
    let (url, registry, ws_state) = spawn_server().await;
    let ownership = ws_state.ownership.clone().expect("coordinator wired");
    let sid = format!("later-owner-{}", uuid::Uuid::new_v4());

    let phantom_op = "op-later-owner-phantom";
    let freshell_ownership::BeginOutcome::Granted { generation } = ownership.begin_start(
        "claude",
        &sid,
        freshell_ownership::RuntimeOwnerKind::Terminal,
        phantom_op,
        None,
        "test",
        1_000,
    ) else {
        panic!("expected Granted")
    };
    let phantom = freshell_ownership::OwnerIdentity {
        kind: freshell_ownership::RuntimeOwnerKind::Terminal,
        terminal_id: Some("t-later-owner-phantom".into()),
        live_session_key: None,
        pid: None,
        ownership_id: None,
    };
    assert_eq!(
        ownership.commit_live("claude", &sid, phantom_op, generation, phantom.clone()),
        freshell_ownership::CommitOutcome::Committed
    );
    let mut stored_phantom = phantom.clone();
    stored_phantom.ownership_id = Some(phantom_op.to_string());

    // On Created (mid-spawn): the phantom dies AND a fresh-agent owner
    // legitimately claims the freed key — the later owner the settle's late
    // claim must not clobber.
    {
        let ownership = ownership.clone();
        let sid = sid.clone();
        registry.set_activity_observer(Arc::new(move |event| {
            if let freshell_terminal::registry::ActivityEvent::Created {
                mode,
                resume_session_id,
                ..
            } = &event
            {
                if mode == "claude" && resume_session_id.as_deref() == Some(sid.as_str()) {
                    ownership.release(
                        "claude",
                        &sid,
                        &freshell_ownership::ReleaseClaim {
                            operation_id: phantom_op.to_string(),
                            generation,
                            runtime: Some(stored_phantom.clone()),
                        },
                        "test/later-owner",
                    );
                    if let freshell_ownership::BeginOutcome::Granted { generation } = ownership
                        .begin_start(
                            "claude",
                            &sid,
                            freshell_ownership::RuntimeOwnerKind::FreshAgent,
                            "op-later-fresh",
                            None,
                            "test",
                            2_000,
                        )
                    {
                        let later = freshell_ownership::OwnerIdentity {
                            kind: freshell_ownership::RuntimeOwnerKind::FreshAgent,
                            terminal_id: None,
                            live_session_key: Some("freshclaude:sid".into()),
                            pid: Some(4242),
                            ownership_id: None,
                        };
                        let _ = ownership.commit_live(
                            "claude",
                            &sid,
                            "op-later-fresh",
                            generation,
                            later,
                        );
                    }
                }
            }
        }));
    }

    let mut ws = connect(&url).await;
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create", "requestId": "later-owner-1", "mode": "claude",
            "shell": "system", "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    let frame = await_frame(&mut ws, Duration::from_secs(20), |v| {
        (v["type"] == "terminal.created" || v["type"] == "error")
            && v["requestId"] == "later-owner-1"
    })
    .await;
    assert_eq!(
        frame["type"], "error",
        "the unowned spawn must be torn down and refused, not created: {frame}"
    );
    assert!(
        frame["message"]
            .as_str()
            .unwrap_or_default()
            .contains("killed"),
        "the refusal must name the teardown: {frame}"
    );
    // The spawned terminal is dead — no live PTY for the session.
    assert_eq!(
        live_pty_count_for_session(&registry, "claude", &sid),
        0,
        "the unowned spawn must be killed and confirmed"
    );
    // The later owner survives untouched.
    match ownership.observe("claude", &sid).state {
        freshell_ownership::OwnershipState::Live { owner, .. } => {
            assert_eq!(
                owner.kind,
                freshell_ownership::RuntimeOwnerKind::FreshAgent,
                "the later owner must survive the losing settle"
            );
        }
        other => panic!("the later owner must survive the losing settle, got {other:?}"),
    }
}

/// M1 shape 3: the BoundElsewhere-attach-to-uncommitted-terminal shape. A
/// Granted claim that attaches through the registry lease's BoundElsewhere
/// names a binding holder that never committed through the coordinator (a
/// committed holder would have answered AdoptLive at the claim above).
/// Previously the attach returned with the claim typed-failed while the
/// attached terminal kept living with NO coordinator record. The settle must
/// commit the claim FOR the attached terminal.
#[tokio::test]
async fn bound_elsewhere_attach_commits_ownership_for_the_unclaimed_holder() {
    let (url, registry, ws_state) = spawn_server().await;
    let ownership = ws_state.ownership.clone().expect("coordinator wired");
    let sid = format!("attach-gap-{}", uuid::Uuid::new_v4());

    // 1. A normal create establishes the holder: committed Live + bound.
    let mut ws_a = connect(&url).await;
    send_json(
        &mut ws_a,
        &json!({
            "type": "terminal.create", "requestId": "attach-src-1", "mode": "claude",
            "shell": "system", "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    let created = await_frame(&mut ws_a, Duration::from_secs(20), |v| {
        v["type"] == "terminal.created" && v["requestId"] == "attach-src-1"
    })
    .await;
    let holder = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    assert!(
        matches!(
            ownership.observe("claude", &sid).state,
            freshell_ownership::OwnershipState::Live { .. }
        ),
        "the source create must commit its holder"
    );

    // 2. The uncommitted-live state: the holder's coordinator record is
    //    released (its exact fenced exit-watcher claim, from the retained
    //    claim) while the terminal LIVES and keeps the registry binding —
    //    the state the shape-1 gap leaves behind, reproduced deterministically.
    let retained = registry
        .retained_ownership_claim(&holder)
        .expect("the committed holder retains its claim");
    ownership.release(
        "claude",
        &sid,
        &freshell_ownership::ReleaseClaim {
            operation_id: retained.operation_id.clone(),
            generation: retained.generation,
            runtime: Some(freshell_ownership::OwnerIdentity {
                kind: freshell_ownership::RuntimeOwnerKind::Terminal,
                terminal_id: Some(retained.terminal_id.clone()),
                live_session_key: None,
                pid: retained.pid,
                ownership_id: Some(retained.operation_id.clone()),
            }),
        },
        "test/attach-gap",
    );
    assert!(
        matches!(
            ownership.observe("claude", &sid).state,
            freshell_ownership::OwnershipState::Vacant
        ),
        "the test state is the gap: a live bound terminal with a Vacant key"
    );

    // 3. A second (negotiated) create for the same key: Granted (the key is
    //    Vacant) → the lease answers BoundElsewhere → attach. The settle
    //    must commit the claim FOR the attached holder.
    let mut ws_b = connect(&url).await;
    send_json(
        &mut ws_b,
        &json!({
            "type": "terminal.create", "requestId": "attach-gap-2", "mode": "claude",
            "shell": "system", "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    let attached = await_frame(&mut ws_b, Duration::from_secs(20), |v| {
        (v["type"] == "terminal.created" || v["type"] == "error")
            && v["requestId"] == "attach-gap-2"
    })
    .await;
    assert_eq!(
        attached["type"], "terminal.created",
        "the attach create must succeed: {attached}"
    );
    assert_eq!(
        attached["terminalId"].as_str(),
        Some(holder.as_str()),
        "the attach must name the existing holder"
    );

    match ownership.observe("claude", &sid).state {
        freshell_ownership::OwnershipState::Live { owner, .. } => {
            assert_eq!(
                owner.terminal_id.as_deref(),
                Some(holder.as_str()),
                "the attach settle must record the ATTACHED terminal's ownership"
            );
        }
        other => {
            panic!("the attach settle must commit coverage for the live holder, got {other:?}")
        }
    }
}

// ── kata b8ke Task 5: the side-effect-free snapshot GET ────────────────────

/// kata b8ke Task 5: a snapshot GET while a TERMINAL owns the session must be
/// side-effect-free — zero sidecar spawns, typed 409 with the owner fields.
#[tokio::test]
async fn snapshot_get_never_spawns_while_a_terminal_owns_the_session() {
    let _guard = ENV_LOCK.lock().await;
    let codex_fake = DualRoleCodexFake::install();
    let mut h = spawn_merged_server().await;
    let sid = format!("snap-term-{}", uuid::Uuid::new_v4());
    // Terminal owner first (mode codex — the sleeper spec spawns a real
    // Running PTY that claims Live{Terminal} through the coordinator).
    send_json(
        &mut h.ws,
        &json!({
            "type": "terminal.create", "requestId": "snap-t1", "mode": "codex",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "codex", "sessionId": sid },
        }),
    )
    .await;
    let _ = await_frame(&mut h.ws, Duration::from_secs(20), |v| {
        v["type"] == "terminal.created" && v["requestId"] == "snap-t1"
    })
    .await;
    assert!(
        matches!(
            h.ws_state
                .fresh_codex
                .ownership_snapshot("codex", &sid)
                .state,
            freshell_ownership::OwnershipState::Live { .. }
        ),
        "the terminal create must commit Live{{Terminal}} first"
    );

    let watermark = codex_fake.thread_op_rows().len();
    let spawn_watermark = codex_fake.sidecar_spawn_rows().len();
    let (status, body) = http_get_json(
        &h.base_url,
        &format!("/api/fresh-agent/threads/freshcodex/codex/{sid}"),
    )
    .await;
    assert_eq!(
        status, 409,
        "owned sessions answer the typed 409, got {status}: {body}"
    );
    assert_eq!(body["code"], "RESTORE_UNAVAILABLE", "typed code: {body}");
    assert_eq!(
        body["ownerKind"], "terminal",
        "the owner kind is named: {body}"
    );
    assert!(
        body["ownerGeneration"].as_u64().is_some(),
        "the owner generation is named: {body}"
    );
    assert!(
        body["message"]
            .as_str()
            .is_some_and(|m| m.contains(&sid) && m.contains("still running on the server.")),
        "the frozen refusal text names the session: {body}"
    );
    let rows = codex_fake.thread_op_rows();
    assert_eq!(
        rows.len(),
        watermark,
        "snapshot GET must not spawn or resume a sidecar: {rows:?}"
    );
    assert_eq!(
        codex_fake.sidecar_spawn_rows().len(),
        spawn_watermark,
        "the GET window spawned no app-server (the terminal create's managed-launch \
         sidecar predates the watermark): {:?}",
        codex_fake.sidecar_spawn_rows()
    );
}

/// kata b8ke Task 5 (round-2 review — the intended behavior change): a
/// snapshot GET for a VACANT untracked session NEVER spawns — 200 with the
/// EMPTY snapshot and owner state, zero app-server invocations, and the
/// coordinator stays Vacant. Cold resume happens ONLY through the explicit
/// lifecycle commands (the fenced `freshAgent.create` below proves the
/// coverage moved, not vanished).
#[tokio::test]
async fn snapshot_get_for_a_vacant_untracked_session_never_spawns() {
    let _guard = ENV_LOCK.lock().await;
    let codex_fake = DualRoleCodexFake::install();
    let mut h = spawn_merged_server().await;
    let sid = format!("snap-cold-{}", uuid::Uuid::new_v4());
    let watermark = codex_fake.thread_op_rows().len();
    let spawn_watermark = codex_fake.sidecar_spawn_rows().len();
    let (status, body) = http_get_json(
        &h.base_url,
        &format!("/api/fresh-agent/threads/freshcodex/codex/{sid}"),
    )
    .await;
    assert_eq!(
        status, 200,
        "vacant untracked sessions answer 200 with the empty snapshot, got {status}: {body}"
    );
    assert_eq!(
        body["sessionType"], "freshcodex",
        "the snapshot facts are stamped: {body}"
    );
    assert_eq!(body["threadId"], sid, "the requested id is echoed: {body}");
    assert_eq!(body["turns"], Value::Array(vec![]), "empty rows: {body}");
    assert_eq!(
        body["extensions"]["codex"]["ownerKind"], "vacant",
        "the additive owner-state fields name the vacant key: {body}"
    );
    let rows = codex_fake.thread_op_rows();
    assert_eq!(
        rows.len(),
        watermark,
        "the GET must not spawn, resume, or otherwise touch a sidecar — no thread/resume row: {rows:?}"
    );
    assert_eq!(
        codex_fake.sidecar_spawn_rows().len(),
        spawn_watermark,
        "the GET window spawned no app-server: {:?}",
        codex_fake.sidecar_spawn_rows()
    );
    // The coordinator is untouched: still Vacant, no claim recorded.
    let snap = h.ws_state.fresh_codex.ownership_snapshot("codex", &sid);
    assert_eq!(
        snap.state,
        freshell_ownership::OwnershipState::Vacant,
        "a read-only GET must not create ownership, got {:?}",
        snap.state
    );
    // The explicit lifecycle rebind is the ONLY cold resume: a fenced
    // freshAgent.create resumes the session (the fake ledger grows exactly
    // one thread/resume for the id), proving the coverage moved, not vanished.
    send_json(
        &mut h.ws,
        &json!({
            "type": "freshAgent.create", "requestId": "snap-cold-2",
            "sessionType": "freshcodex", "provider": "codex", "cwd": "/tmp",
            "sessionRef": { "provider": "codex", "sessionId": sid },
        }),
    )
    .await;
    let _ = await_frame(&mut h.ws, Duration::from_secs(20), |v| {
        v["type"] == "freshAgent.created" && v["requestId"] == "snap-cold-2"
    })
    .await;
    let rows = codex_fake.thread_op_rows();
    assert!(
        rows.iter().any(|r| r["method"] == "thread/resume"
            && r["threadId"].as_str() == Some(sid.as_str())),
        "the explicit freshAgent.create — not the GET — performed the resume: {rows:?}"
    );
}

// ── kata b8ke Task 6: the atomic handoff endpoint (end-to-end) ──────────────

/// End-to-end fresh→terminal handoff over the real REST endpoint against the
/// in-process server with both kinds live: the old sidecar is reaped, the
/// coordinator flips Live{FreshAgent} → Live{Terminal}, both
/// `session.runtimeOwner` transitions broadcast on the WS (the committed
/// frame carrying the boot epoch, the true previousKind, and the owning
/// terminal id), and a subsequent `freshAgent.create` for the session is
/// typed-refused with the terminal owner.
#[tokio::test]
async fn fresh_agent_to_terminal_handoff_is_atomic_and_broadcast() {
    let _guard = ENV_LOCK.lock().await;
    let sidecar = FakeSidecarEnv::install(); // SYNC at base — no .await
    let mut h = spawn_merged_server().await;
    let sid = format!("ho-e2e-{}", uuid::Uuid::new_v4());
    // Fresh owner.
    send_json(
        &mut h.ws,
        &json!({
            "type": "freshAgent.create", "requestId": "ho-f1",
            "sessionType": "freshclaude", "provider": "claude",
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    let _ = await_frame(&mut h.ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("freshAgent.created")
            && v.get("requestId").and_then(|r| r.as_str()) == Some("ho-f1")
    })
    .await;
    assert!(
        matches!(
            h.ws_state
                .fresh_claude
                .ownership_snapshot("claude", &sid)
                .state,
            freshell_ownership::OwnershipState::Live { .. }
        ),
        "the fresh owner must be Live before the handoff"
    );

    // Handoff to terminal via REST.
    let (status, body) = http_post_json(
        &h.base_url,
        "/api/sessions/handoff",
        &json!({
            "provider": "claude", "sessionId": sid, "targetKind": "terminal",
            "mode": "claude", "deviceId": "test-device-a",
        }),
    )
    .await;
    assert_eq!(status, 200, "{}", body);
    assert_eq!(body["ok"], serde_json::json!(true), "{}", body);
    let terminal_id = body["owner"]["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();

    // The coordinator is Live{Terminal} for (claude, sid).
    let snap = h.ws_state.fresh_claude.ownership_snapshot("claude", &sid);
    assert!(
        matches!(snap.state, freshell_ownership::OwnershipState::Live { ref owner, .. }
            if owner.terminal_id.as_deref() == Some(terminal_id.as_str())),
        "expected Live terminal owner naming the spawned terminal, got {:?}",
        snap.state
    );

    // Both broadcast transitions arrived on the WS.
    let _started = await_frame(&mut h.ws, Duration::from_secs(10), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("session.runtimeOwner")
            && v.get("transition").and_then(|t| t.as_str()) == Some("handoff-started")
    })
    .await;
    let committed = await_frame(&mut h.ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("session.runtimeOwner")
            && v.get("transition").and_then(|t| t.as_str()) == Some("handoff-committed")
    })
    .await;
    assert_eq!(
        committed.get("terminalId").and_then(|t| t.as_str()),
        Some(terminal_id.as_str())
    );
    // Round-2 review: the frame carries the boot epoch and the true
    // previousKind (the prior fresh-agent kind).
    assert!(committed.get("epoch").and_then(|e| e.as_u64()).unwrap_or(0) >= 1);
    assert_eq!(
        committed.get("previousKind").and_then(|k| k.as_str()),
        Some("fresh-agent")
    );

    // A subsequent freshAgent.create for the session is typed-refused with
    // the terminal owner (Task 3's lane claim; the claude snapshot GET is a
    // disk read and is not the refusal surface).
    send_json(
        &mut h.ws,
        &json!({
            "type": "freshAgent.create", "requestId": "ho-f2",
            "sessionType": "freshclaude", "provider": "claude",
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    let refused = await_frame(&mut h.ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("freshAgent.create.failed")
            && v.get("requestId").and_then(|r| r.as_str()) == Some("ho-f2")
    })
    .await;
    assert_eq!(
        refused.get("ownerKind").and_then(|k| k.as_str()),
        Some("terminal"),
        "the refusal names the terminal owner: {refused}"
    );
    let _ = sidecar;
}
