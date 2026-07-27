//! WSL-outage RCA §6.3 acceptance tests: the per-connection create rate
//! limit (legacy parity) and the cancellable restore-spawn gate. REAL axum
//! server + REAL tokio-tungstenite client, the session_identity_frames.rs
//! harness convention.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::create_limit::CreateProtectConfig;
use freshell_ws::spawn_gate::RestoreSpawnGate;
use freshell_ws::WsState;

const AUTH_TOKEN: &str = "s3cr3t-token-abcdef";

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

/// A minimal always-present CLI spec (`/bin/sh` sleeper script) so non-shell
/// creates genuinely spawn — the same recording-script convention as
/// `session_identity_frames.rs` (these tests assert on wire frames, not argv).
fn sleeper_cli_spec(name: &str) -> freshell_platform::CliCommandSpec {
    let script_path = std::env::temp_dir().join(format!(
        "freshell-restore-gate-sleeper-{name}-{}.sh",
        std::process::id()
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

/// Real server on an ephemeral loopback port with injectable protection
/// knobs. Returns (ws_url, registry, shutdown_notify, gate, shutdown_started).
async fn spawn_server(
    create_protect: CreateProtectConfig,
    gate: RestoreSpawnGate,
) -> (
    String,
    freshell_terminal::TerminalRegistry,
    std::sync::Arc<tokio::sync::Notify>,
    std::sync::Arc<RestoreSpawnGate>,
    std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
    let gate = std::sync::Arc::new(gate);
    let shutdown = std::sync::Arc::new(tokio::sync::Notify::new());
    let shutdown_started = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));
    let registry = freshell_terminal::TerminalRegistry::new();

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
            serde_json::json!({ "freshAgent": { "enabled": false } }),
        ),
        fresh_claude: freshell_freshagent::FreshClaudeState::new(Arc::clone(&broadcast_tx)),
        fresh_opencode: freshell_freshagent::FreshOpencodeState::new(
            freshell_freshagent::FreshAgentState::new(
                Arc::clone(&auth_token),
                Arc::clone(&broadcast_tx),
            ),
        ),
        registry: registry.clone(),
        tabs: freshell_ws::tabs::TabsRegistry::new(),
        screenshots: freshell_ws::screenshot::ScreenshotBroker::new(Arc::clone(&broadcast_tx)),
        terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        sessions_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        cli_commands: Arc::new(vec![
            sleeper_cli_spec("amplifier"),
            sleeper_cli_spec("claude"),
        ]),
        shutdown: std::sync::Arc::clone(&shutdown),
        ping_interval_ms: 30_000,
        hello_timeout_ms: 5_000,
        allowed_origins: Arc::new(freshell_ws::origin::default_allowed_origins()),
        ws_max_payload_bytes: 16 * 1024 * 1024,
        term09: freshell_ws::backpressure::Term09Config::default(),
        create_protect,
        spawn_gate: std::sync::Arc::clone(&gate),
        shutdown_started: std::sync::Arc::clone(&shutdown_started),
        config_fallback: None,
        amplifier_locator: None,
        opencode_locator: None,
    };

    let router = freshell_ws::router(state);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    (
        format!("ws://{addr}/ws", addr = addr),
        registry,
        shutdown,
        gate,
        shutdown_started,
    )
}

type TestWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Connect + hello, draining the handshake (`config_fallback` is None in
/// this harness, so the handshake is exactly 4 frames — the
/// `session_identity_frames.rs` convention).
async fn connect_and_hello(url: &str) -> TestWs {
    let (mut ws, _resp) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
    // Nagle OFF on the test client: the two-creates-in-flight tests send
    // back-to-back small frames that must reach the server within the first
    // create's spawn-to-settled window; Nagle + delayed ACK on loopback
    // holds the second frame for ~3ms, longer than a whole settled create.
    if let tokio_tungstenite::MaybeTlsStream::Plain(stream) = ws.get_ref() {
        stream.set_nodelay(true).expect("set_nodelay");
    }
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

    for _ in 0..4u8 {
        let _ = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("handshake message within timeout")
            .expect("stream not ended")
            .expect("no ws error");
    }
    ws
}

/// Send one text frame.
async fn send_text(ws: &mut TestWs, text: &str) {
    ws.send(WsMessage::Text(text.to_string()))
        .await
        .expect("send text frame");
}

/// Read text frames until one with `type == wanted` arrives (bounded).
async fn next_json_of_type(ws: &mut TestWs, wanted: &str) -> serde_json::Value {
    for _ in 0..20u8 {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for a {wanted} frame"))
            .expect("stream not ended")
            .expect("no ws error");
        if let WsMessage::Text(text) = &msg {
            let value: serde_json::Value = serde_json::from_str(text).expect("json frame");
            if value["type"] == serde_json::json!(wanted) {
                return value;
            }
        }
    }
    panic!("no {wanted} frame within 20 messages");
}

/// Read frames until `Message::Close(Some(frame))` arrives (bounded) — the
/// same way the `keepalive.rs`-family tests read server close codes.
async fn next_close_frame(
    ws: &mut TestWs,
) -> tokio_tungstenite::tungstenite::protocol::CloseFrame<'static> {
    for _ in 0..20u8 {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("close frame within timeout")
            .expect("stream not ended")
            .expect("no ws error");
        if let WsMessage::Close(Some(frame)) = msg {
            return frame;
        }
    }
    panic!("no close frame within 20 messages");
}

/// [`next_json_of_type`] variant that PANICS on any output-family frame
/// (`terminal.output` / `terminal.outputBatch`) while waiting. Used while
/// draining the storm's `terminal.created` replies: nothing is attached yet,
/// so output before attach would break the A21 causal invariant (create
/// never auto-attaches, registry.rs:548).
async fn next_json_of_type_failing_on_output(ws: &mut TestWs, wanted: &str) -> serde_json::Value {
    for _ in 0..40u8 {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for a {wanted} frame"))
            .expect("stream not ended")
            .expect("no ws error");
        if let WsMessage::Text(text) = &msg {
            let value: serde_json::Value = serde_json::from_str(text).expect("json frame");
            let frame_type = value["type"].as_str().unwrap_or("");
            assert!(
                frame_type != "terminal.output" && frame_type != "terminal.outputBatch",
                "output frame before any attach breaks the A21 causal invariant: {value}"
            );
            if frame_type == wanted {
                return value;
            }
        }
    }
    panic!("no {wanted} frame within 40 messages");
}

/// Plain-JSON `terminal.create` frame; a shell create needs no CLI spec.
fn create_frame(request_id: &str, restore: bool) -> String {
    if restore {
        format!(
            r#"{{"type":"terminal.create","requestId":"{request_id}","mode":"shell","shell":"system","restore":true}}"#
        )
    } else {
        format!(
            r#"{{"type":"terminal.create","requestId":"{request_id}","mode":"shell","shell":"system"}}"#
        )
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn third_non_restore_create_in_window_is_rate_limited() {
    let cfg = CreateProtectConfig {
        rate_limit: 2,
        ..CreateProtectConfig::default()
    };
    let (ws_url, registry, _shutdown, _gate, _shutdown_started) =
        spawn_server(cfg, RestoreSpawnGate::new(4, 64)).await;
    let mut client = connect_and_hello(&ws_url).await;

    // Creates 1 and 2: accepted -> terminal.created replies.
    for i in 0..2 {
        send_text(&mut client, &create_frame(&format!("req-{i}"), false)).await;
        let reply = next_json_of_type(&mut client, "terminal.created").await;
        assert_eq!(reply["requestId"], format!("req-{i}"));
    }
    // Create 3: rejected with RATE_LIMITED, and no third terminal exists.
    send_text(&mut client, &create_frame("req-2", false)).await;
    let err = next_json_of_type(&mut client, "error").await;
    assert_eq!(err["code"], "RATE_LIMITED");
    assert_eq!(err["requestId"], "req-2");

    assert_eq!(
        registry.kill_all(),
        2,
        "only the two accepted creates spawned"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn restore_creates_are_gated_and_non_restore_bypass() {
    // Zero-permit gate: any create that actually consults the gate can never
    // proceed. This is the wiring proof — if the gate were inert (the Node
    // attempt's failure mode), the restore create would succeed.
    let cfg = CreateProtectConfig {
        restore_spawn_timeout_ms: 300,
        ..CreateProtectConfig::default()
    };
    let (ws_url, registry, _shutdown, gate, _shutdown_started) =
        spawn_server(cfg, RestoreSpawnGate::new(0, 64)).await;
    let mut client = connect_and_hello(&ws_url).await;

    // Non-restore create BYPASSES the zero-permit gate and succeeds.
    send_text(&mut client, &create_frame("plain", false)).await;
    let reply = next_json_of_type(&mut client, "terminal.created").await;
    assert_eq!(reply["requestId"], "plain");

    // Restore create consults the gate, times out, fails loud.
    send_text(&mut client, &create_frame("restore-1", true)).await;
    let err = next_json_of_type(&mut client, "error").await;
    assert_eq!(err["code"], "PTY_SPAWN_FAILED");
    assert_eq!(err["requestId"], "restore-1");
    assert!(err["message"]
        .as_str()
        .expect("message")
        .contains("restore spawn slot"));
    assert_eq!(gate.timeouts(), 1);

    assert_eq!(
        registry.kill_all(),
        1,
        "only the non-restore create spawned"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn restore_create_holds_permit_until_settled() {
    // Gate with ONE permit. Two restore creates on the same connection: if
    // the permit were released at the spawn syscall (the da5d9b5c prior-art
    // shape), both would complete near-instantly regardless of order; what
    // we assert instead is the STRONGER wiring property that both complete
    // AND the gate saw a queued waiter (the second create had to wait for
    // the first create's FULL settle, not just its spawn).
    let cfg = CreateProtectConfig::default();
    let (ws_url, registry, _shutdown, gate, _shutdown_started) =
        spawn_server(cfg, RestoreSpawnGate::new(1, 64)).await;
    let mut client = connect_and_hello(&ws_url).await;

    send_text(&mut client, &create_frame("r1", true)).await;
    send_text(&mut client, &create_frame("r2", true)).await;
    let first = next_json_of_type(&mut client, "terminal.created").await;
    let second = next_json_of_type(&mut client, "terminal.created").await;
    let mut ids: Vec<String> = vec![
        first["requestId"].as_str().expect("id").to_string(),
        second["requestId"].as_str().expect("id").to_string(),
    ];
    ids.sort();
    assert_eq!(ids, vec!["r1".to_string(), "r2".to_string()]);
    assert!(
        gate.queued_total() >= 1,
        "with 1 permit, the second concurrent restore create must have queued \
         behind the first create's spawn-to-settled window"
    );
    assert_eq!(registry.kill_all(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn gated_create_racing_shutdown_leaves_no_live_pty() {
    // A10 (V3, FALSIFIED): main's registry.kill_all() snapshots the id set
    // ONCE (registry.rs:889-892) with no re-sweep; a detached gated create
    // survives the axum drain and its registry insert can land AFTER the
    // snapshot. The registry-Drop fallback does NOT hold (the PTY reader
    // thread's exit hook owns a registry Arc — terminal.rs:1047,
    // pty.rs:464/512 — circular), and the 5s watchdog exits via
    // std::process::exit(1), skipping Drops. So the gated path itself must
    // re-check the shutdown latch around handle_create.
    let cfg = CreateProtectConfig::default();
    let (ws_url, registry, _shutdown, _gate, shutdown_started) =
        spawn_server(cfg, RestoreSpawnGate::new(1, 64)).await;
    let mut client = connect_and_hello(&ws_url).await;

    // Shutdown has begun (exactly what main.rs latches before the WS
    // notify — Task 7 Step 2b) while the restore create is about to run:
    shutdown_started.store(true, std::sync::atomic::Ordering::SeqCst);
    send_text(&mut client, &create_frame("late", true)).await;

    // Give the gated task time to (wrongly) spawn and settle.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    assert_eq!(
        registry.kill_all(),
        0,
        "a create racing shutdown must not leave a live PTY"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn queued_restore_create_is_abandoned_on_disconnect_without_spawning() {
    // Zero-permit gate + long timeout: the restore create parks in the queue.
    let cfg = CreateProtectConfig {
        restore_spawn_timeout_ms: 30_000,
        ..CreateProtectConfig::default()
    };
    let (ws_url, registry, _shutdown, gate, _shutdown_started) =
        spawn_server(cfg, RestoreSpawnGate::new(0, 64)).await;
    let mut client = connect_and_hello(&ws_url).await;
    send_text(&mut client, &create_frame("doomed", true)).await;

    // Wait until the create is actually queued on the gate.
    for _ in 0..200 {
        if gate.queued_total() == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(gate.queued_total(), 1, "restore create must be queued");

    // Client disconnects while queued.
    drop(client);

    // The queued create must unblock as Cancelled — not sit out its 30s
    // timeout, and not spawn.
    for _ in 0..200 {
        if gate.cancellations() == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(
        gate.cancellations(),
        1,
        "disconnect must cancel the queued create"
    );
    assert_eq!(registry.kill_all(), 0, "no PTY may have been spawned");
}

#[tokio::test(flavor = "multi_thread")]
async fn queued_restore_creates_drain_without_spawning_on_shutdown() {
    let cfg = CreateProtectConfig {
        restore_spawn_timeout_ms: 30_000,
        ..CreateProtectConfig::default()
    };
    let (ws_url, registry, shutdown, gate, _shutdown_started) =
        spawn_server(cfg, RestoreSpawnGate::new(0, 64)).await;
    let mut client = connect_and_hello(&ws_url).await;
    send_text(&mut client, &create_frame("draining-1", true)).await;
    send_text(&mut client, &create_frame("draining-2", true)).await;

    for _ in 0..200 {
        if gate.queued_total() == 2 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(
        gate.queued_total(),
        2,
        "both restore creates must be queued"
    );

    // Server-side graceful shutdown: every connection loop closes 4009,
    // which must drain the queued creates without spawning.
    shutdown.notify_waiters();

    // The client observes the 4009 close frame.
    let close = next_close_frame(&mut client).await;
    assert_eq!(close.code, 4009_u16.into());

    for _ in 0..200 {
        if gate.cancellations() == 2 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(gate.cancellations(), 2, "shutdown must drain the queue");
    assert_eq!(registry.kill_all(), 0, "no PTY may have been spawned");
}

#[tokio::test(flavor = "multi_thread")]
async fn restore_storm_drains_bounded_with_per_terminal_ordering() {
    // N restore creates > gate limit: every create must settle with its own
    // requestId, exactly once, with no duplicate PTYs; and no terminal may
    // emit output before the client attaches (the A21 causal invariant —
    // create never auto-attaches, registry.rs:548).
    let cfg = CreateProtectConfig::default();
    let (ws_url, registry, _shutdown, gate, _shutdown_started) =
        spawn_server(cfg, RestoreSpawnGate::new(2, 64)).await;
    let mut client = connect_and_hello(&ws_url).await;

    const N: usize = 12; // > gate limit 2: forces real FIFO queueing
    for i in 0..N {
        send_text(&mut client, &create_frame(&format!("storm-{i}"), true)).await;
    }

    // Drain N terminal.created frames. While draining, FAIL on any
    // terminal.output / terminal.outputBatch frame — nothing is attached
    // yet, so output before attach would break the A21 invariant. (Use a
    // next_json_of_type variant that panics on output-family frames.)
    let mut seen = std::collections::HashMap::<String, String>::new();
    for _ in 0..N {
        let created = next_json_of_type_failing_on_output(&mut client, "terminal.created").await;
        let req = created["requestId"]
            .as_str()
            .expect("requestId")
            .to_string();
        let tid = created["terminalId"]
            .as_str()
            .expect("terminalId")
            .to_string();
        assert!(
            seen.insert(req, tid).is_none(),
            "duplicate terminal.created for one requestId"
        );
    }
    assert_eq!(seen.len(), N, "every requestId settled exactly once");
    assert!(
        seen.keys().all(|k| k.starts_with("storm-")),
        "only the storm requestIds replied"
    );
    assert!(
        gate.queued_total() >= (N as u64) - 2,
        "with 2 permits the storm must actually queue FIFO behind the gate"
    );

    // Per-terminal created -> attach -> output: attach ONE storm terminal
    // (the session_identity_frames.rs attach frame shape) and assert
    // terminal.attach.ready arrives for that terminalId — output for it may
    // only follow now.
    let attach_tid = seen
        .get("storm-0")
        .expect("storm-0 settled with a terminalId")
        .clone();
    send_text(
        &mut client,
        &serde_json::json!({
            "type": "terminal.attach",
            "terminalId": attach_tid,
            "intent": "viewport_hydrate",
            "cols": 120,
            "rows": 30,
            "attachRequestId": "att-storm-0",
        })
        .to_string(),
    )
    .await;
    let ready = next_json_of_type(&mut client, "terminal.attach.ready").await;
    assert_eq!(
        ready["terminalId"].as_str().expect("terminalId"),
        attach_tid,
        "terminal.attach.ready must arrive for the attached storm terminal"
    );

    assert_eq!(registry.kill_all(), N, "exactly N PTYs, no duplicates");
}
