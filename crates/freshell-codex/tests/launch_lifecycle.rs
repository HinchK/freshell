//! DEV-0006 S4 — lifecycle glue tests for [`freshell_codex::launch_lifecycle`]:
//! the launch planner + sidecar lifecycle (`launch-planner.ts:108-316`) that turns the
//! S3 pure decisions ([`freshell_codex::launch_plan`]) into a running app-server
//! sidecar + S2 remote proxy, and the terminal-keyed manager both terminal-create
//! paths (WS + REST) wire through.
//!
//! Real sockets throughout (loopback, ephemeral only — never 3001/3002). The planner
//! tests inject a fake runtime (a loopback WS listener standing in for the spawned
//! app-server) but always drive the REAL `CodexRemoteProxy`; the spawn integration
//! test at the bottom spawns the committed fake app-server fixture
//! (`test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`) via node and
//! proves the fake-TUI → proxy → app-server relay end to end.
#![cfg(feature = "real-transport")]

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::net::TcpListener;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{accept_async, connect_async};

use freshell_codex::launch_lifecycle::{
    CodexLaunchError, CodexLaunchPlanner, CodexLaunchRuntime, CodexRuntimeReady,
    CodexTerminalLaunchManager, LaunchClass, SpawnedCodexAppServerRuntime,
    CODEX_LAUNCH_PLANNER_SHUTDOWN_MESSAGE, CODEX_SIDECAR_NOT_ADOPTABLE_MESSAGE,
};
use freshell_codex::launch_plan::{codex_remote_args, CodexLaunchPlanInput};
use freshell_codex::BoxFuture;

const RECV_TIMEOUT: Duration = Duration::from_secs(10);

// ── fake runtime: a loopback WS echo listener standing in for the app-server ──────

struct FakeRuntime {
    ws_url: String,
    ensure_ready_calls: Mutex<Vec<Option<String>>>,
    fail_ensure_ready: AtomicBool,
    shutdown_calls: AtomicU32,
    ownership_updates: Mutex<Vec<(String, u64)>>,
}

impl FakeRuntime {
    /// Bind a real loopback WS listener that accepts connections and echoes text
    /// frames back — enough upstream for the REAL proxy to dial and relay against.
    async fn start() -> Arc<FakeRuntime> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let ws_url = format!("ws://{}:{}", addr.ip(), addr.port());
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let Ok(ws) = accept_async(stream).await else {
                        return;
                    };
                    let (mut sink, mut source) = ws.split();
                    while let Some(Ok(msg)) = source.next().await {
                        if let Message::Text(text) = msg {
                            if sink.send(Message::Text(text)).await.is_err() {
                                break;
                            }
                        }
                    }
                });
            }
        });
        Arc::new(FakeRuntime {
            ws_url,
            ensure_ready_calls: Mutex::new(Vec::new()),
            fail_ensure_ready: AtomicBool::new(false),
            shutdown_calls: AtomicU32::new(0),
            ownership_updates: Mutex::new(Vec::new()),
        })
    }
}

impl CodexLaunchRuntime for FakeRuntime {
    fn ensure_ready(
        &self,
        cwd: Option<String>,
    ) -> BoxFuture<'_, Result<CodexRuntimeReady, String>> {
        Box::pin(async move {
            self.ensure_ready_calls.lock().unwrap().push(cwd);
            if self.fail_ensure_ready.load(Ordering::SeqCst) {
                return Err("fake runtime: ensureReady failed".to_string());
            }
            Ok(CodexRuntimeReady {
                ws_url: self.ws_url.clone(),
            })
        })
    }

    fn update_ownership_metadata(
        &self,
        terminal_id: String,
        generation: u64,
    ) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            self.ownership_updates
                .lock()
                .unwrap()
                .push((terminal_id, generation));
            Ok(())
        })
    }

    fn shutdown(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            self.shutdown_calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
    }
}

fn planner_for(runtime: Arc<FakeRuntime>) -> CodexLaunchPlanner {
    CodexLaunchPlanner::new(Box::new(move || {
        runtime.clone() as Arc<dyn CodexLaunchRuntime>
    }))
}

// ── planCreate fresh/resume knobs (launch-planner.ts:125-163) ─────────────────────

#[tokio::test]
async fn fresh_plan_starts_a_real_proxy_with_candidate_persistence_on() {
    let runtime = FakeRuntime::start().await;
    let planner = planner_for(runtime.clone());
    let launch = planner
        .plan_create(&CodexLaunchPlanInput {
            cwd: Some("/repo/one"),
            ..Default::default()
        })
        .await
        .unwrap();

    // Fresh: no sessionId (launch-planner.ts:158-163); the proxy URL — not the
    // runtime's — is what the TUI is pointed at (spec §1.3 step 3).
    assert_eq!(launch.session_id, None);
    assert_ne!(launch.remote_ws_url, runtime.ws_url);
    assert!(launch.remote_ws_url.starts_with("ws://127.0.0.1:"));
    // The 4-tuple gate accepts the minted URL (terminal-registry.ts:295-307).
    assert!(codex_remote_args(&launch.remote_ws_url).is_ok());
    // ensureReady got the create cwd (launch-planner.ts:153).
    assert_eq!(
        runtime.ensure_ready_calls.lock().unwrap().as_slice(),
        &[Some("/repo/one".to_string())]
    );
    // requireCandidatePersistence: legacy fresh leaves the PROXY default (true,
    // remote-proxy.ts:140) — the Rust planner passes the plan's value EXPLICITLY
    // (review note 2: no shadow default at the proxy layer).
    assert_eq!(
        launch.sidecar.require_candidate_persistence().await,
        Some(true)
    );

    launch.sidecar.shutdown().await.unwrap();
}

#[tokio::test]
async fn resume_plan_sets_session_id_and_disables_candidate_persistence() {
    let runtime = FakeRuntime::start().await;
    let planner = planner_for(runtime.clone());
    let launch = planner
        .plan_create(&CodexLaunchPlanInput {
            cwd: Some("/repo/resume"),
            resume_session_id: Some("thread-ready"),
            ..Default::default()
        })
        .await
        .unwrap();

    assert_eq!(launch.session_id.as_deref(), Some("thread-ready"));
    // requireCandidatePersistence=false on resume (launch-planner.ts:140).
    assert_eq!(
        launch.sidecar.require_candidate_persistence().await,
        Some(false)
    );
    launch.sidecar.shutdown().await.unwrap();
}

#[tokio::test]
async fn relay_works_through_the_planned_proxy() {
    // The plan's remote_ws_url accepts a TUI connection and relays to the upstream:
    // fake TUI → REAL proxy → fake runtime (echo) → back.
    let runtime = FakeRuntime::start().await;
    let planner = planner_for(runtime.clone());
    let launch = planner
        .plan_create(&CodexLaunchPlanInput::default())
        .await
        .unwrap();

    let (mut tui, _) = connect_async(&launch.remote_ws_url).await.unwrap();
    let frame = json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}});
    tui.send(Message::Text(frame.to_string())).await.unwrap();
    let echoed = timeout(RECV_TIMEOUT, tui.next())
        .await
        .expect("timed out waiting for the relayed frame")
        .expect("proxy closed before relaying")
        .unwrap();
    assert_eq!(echoed, Message::Text(frame.to_string()));

    launch.sidecar.shutdown().await.unwrap();
}

// ── plan-failure teardown (launch-planner.ts:164-175) ─────────────────────────────

#[tokio::test]
async fn planning_error_tears_the_sidecar_down_and_surfaces_the_error() {
    let runtime = FakeRuntime::start().await;
    runtime.fail_ensure_ready.store(true, Ordering::SeqCst);
    let planner = planner_for(runtime.clone());
    let err = planner
        .plan_create(&CodexLaunchPlanInput::default())
        .await
        .unwrap_err();
    match err {
        CodexLaunchError::Failed(message) => {
            assert!(message.contains("ensureReady failed"), "{message}");
        }
        other => panic!("expected Failed, got {other:?}"),
    }
    // Cleanup-on-plan-failure: the sidecar (runtime) was shut down.
    assert_eq!(runtime.shutdown_calls.load(Ordering::SeqCst), 1);
}

// ── shutdown rejects new plans (launch-planner.ts:197-201) ────────────────────────

#[tokio::test]
async fn planner_shutdown_rejects_new_plans_with_the_legacy_message() {
    let runtime = FakeRuntime::start().await;
    let planner = planner_for(runtime.clone());
    planner.shutdown().await;
    let err = planner
        .plan_create(&CodexLaunchPlanInput::default())
        .await
        .unwrap_err();
    match err {
        CodexLaunchError::Failed(message) => {
            assert_eq!(message, CODEX_LAUNCH_PLANNER_SHUTDOWN_MESSAGE);
        }
        other => panic!("expected Failed, got {other:?}"),
    }
}

#[tokio::test]
async fn planner_shutdown_tears_down_unadopted_sidecars() {
    let runtime = FakeRuntime::start().await;
    let planner = planner_for(runtime.clone());
    let _launch = planner
        .plan_create(&CodexLaunchPlanInput::default())
        .await
        .unwrap();
    planner.shutdown().await;
    assert_eq!(runtime.shutdown_calls.load(Ordering::SeqCst), 1);
}

// ── adopt (launch-planner.ts:238-244) ─────────────────────────────────────────────

#[tokio::test]
async fn adopt_transfers_ownership_out_of_the_planner() {
    let runtime = FakeRuntime::start().await;
    let planner = planner_for(runtime.clone());
    let launch = planner
        .plan_create(&CodexLaunchPlanInput::default())
        .await
        .unwrap();

    launch.sidecar.adopt("term-1", 0).await.unwrap();
    assert_eq!(
        runtime.ownership_updates.lock().unwrap().as_slice(),
        &[("term-1".to_string(), 0)]
    );

    // An adopted sidecar is the TERMINAL's; planner.shutdown() must not tear it down
    // (adopt removes it from activeSidecars, launch-planner.ts:242-243).
    planner.shutdown().await;
    assert_eq!(runtime.shutdown_calls.load(Ordering::SeqCst), 0);

    launch.sidecar.shutdown().await.unwrap();
    assert_eq!(runtime.shutdown_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn adopt_after_sidecar_shutdown_is_rejected_with_the_legacy_message() {
    let runtime = FakeRuntime::start().await;
    let planner = planner_for(runtime.clone());
    let launch = planner
        .plan_create(&CodexLaunchPlanInput::default())
        .await
        .unwrap();
    launch.sidecar.shutdown().await.unwrap();
    let err = launch.sidecar.adopt("term-1", 0).await.unwrap_err();
    assert_eq!(err, CODEX_SIDECAR_NOT_ADOPTABLE_MESSAGE);
}

#[tokio::test]
async fn sidecar_shutdown_is_idempotent() {
    let runtime = FakeRuntime::start().await;
    let planner = planner_for(runtime.clone());
    let launch = planner
        .plan_create(&CodexLaunchPlanInput::default())
        .await
        .unwrap();
    launch.sidecar.shutdown().await.unwrap();
    launch.sidecar.shutdown().await.unwrap();
    assert_eq!(runtime.shutdown_calls.load(Ordering::SeqCst), 1);
}

// ── retry (launch-retry.ts:16-50; asymmetric budget, review note 5) ───────────────

#[tokio::test]
async fn retry_gives_up_after_the_attempt_budget_on_transient_failures() {
    let runtime = FakeRuntime::start().await;
    runtime.fail_ensure_ready.store(true, Ordering::SeqCst);
    let planner = planner_for(runtime.clone());
    let err = planner
        .plan_create_with_retry(
            &CodexLaunchPlanInput::default(),
            3,
            /* retry_delay_ms */ 1,
        )
        .await
        .unwrap_err();
    assert!(matches!(err, CodexLaunchError::Failed(_)));
    // One ensureReady per attempt: the budget is honored.
    assert_eq!(runtime.ensure_ready_calls.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn retry_never_retries_configuration_errors() {
    let runtime = FakeRuntime::start().await;
    let planner = planner_for(runtime.clone());
    let err = planner
        .plan_create_with_retry(
            &CodexLaunchPlanInput {
                sandbox: Some("full-yolo"),
                ..Default::default()
            },
            5,
            1,
        )
        .await
        .unwrap_err();
    assert!(matches!(err, CodexLaunchError::Config(_)));
    // The config error fails BEFORE any runtime IO (launch-retry.ts:35).
    assert_eq!(runtime.ensure_ready_calls.lock().unwrap().len(), 0);
}

// ── the terminal-keyed manager (the shared seam both create paths wire through) ───

#[tokio::test]
async fn manager_adopts_by_terminal_id_and_tears_down_on_exit() {
    let runtime = FakeRuntime::start().await;
    let factory_runtime = runtime.clone();
    let manager = CodexTerminalLaunchManager::new(Box::new(move || {
        factory_runtime.clone() as Arc<dyn CodexLaunchRuntime>
    }));

    let launch = manager
        .plan_create_with_retry_uncancellable(
            &CodexLaunchPlanInput::default(),
            5,
            LaunchClass::Interactive,
        )
        .await
        .unwrap();
    let remote_ws_url = launch.remote_ws_url.clone();
    manager.adopt("term-42", launch, 0).await.unwrap();
    assert_eq!(
        runtime.ownership_updates.lock().unwrap().as_slice(),
        &[("term-42".to_string(), 0)]
    );

    // The proxy stays up while the terminal lives.
    assert!(connect_async(&remote_ws_url).await.is_ok());

    // PTY exit (the sync exit hook) → async teardown of proxy + sidecar.
    manager.notify_terminal_exit("term-42");
    let deadline = tokio::time::Instant::now() + RECV_TIMEOUT;
    loop {
        if runtime.shutdown_calls.load(Ordering::SeqCst) == 1 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "sidecar was never torn down after terminal exit"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn manager_discard_tears_down_an_unadopted_plan() {
    let runtime = FakeRuntime::start().await;
    let factory_runtime = runtime.clone();
    let manager = CodexTerminalLaunchManager::new(Box::new(move || {
        factory_runtime.clone() as Arc<dyn CodexLaunchRuntime>
    }));
    let launch = manager
        .plan_create_with_retry_uncancellable(
            &CodexLaunchPlanInput::default(),
            5,
            LaunchClass::Interactive,
        )
        .await
        .unwrap();
    manager.discard(launch).await;
    assert_eq!(runtime.shutdown_calls.load(Ordering::SeqCst), 1);
}

/// discard_sync must tear the sidecar down (asynchronously) without the
/// caller awaiting — the seam Task 4's RAII guard uses from Drop.
#[tokio::test(flavor = "multi_thread")]
async fn discard_sync_tears_down_an_unadopted_plan() {
    let runtime = FakeRuntime::start().await;
    let factory_runtime = runtime.clone();
    let manager = CodexTerminalLaunchManager::with_plan_budget(
        Box::new(move || factory_runtime.clone() as std::sync::Arc<dyn CodexLaunchRuntime>),
        2,
        std::time::Duration::from_secs(30),
        64,
    );
    let launch = manager
        .plan_create_with_retry_uncancellable(
            &CodexLaunchPlanInput::default(),
            1,
            LaunchClass::Interactive,
        )
        .await
        .expect("plan");
    manager.discard_sync(launch);
    // Teardown is fire-and-forget: poll for the shutdown.
    for _ in 0..200 {
        if runtime
            .shutdown_calls
            .load(std::sync::atomic::Ordering::SeqCst)
            == 1
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(
        runtime
            .shutdown_calls
            .load(std::sync::atomic::Ordering::SeqCst),
        1,
        "discard_sync must shut the sidecar down"
    );
}

/// A8 (V4): `tokio::spawn` panics with no ambient runtime, and discard_sync
/// is called from Drop — where a panic is a double-panic abort during
/// unwind. Plan on a locally-built runtime, tear the runtime down, then
/// call discard_sync from plain (non-tokio) test context: pre-hardening
/// this PANICS ("there is no reactor running"); post-hardening it must
/// degrade to best-effort kill / log-and-leak.
#[test] // deliberately NOT #[tokio::test]
fn discard_sync_outside_runtime_context_does_not_panic() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("local runtime");
    let (manager, launch) = rt.block_on(async {
        let runtime = FakeRuntime::start().await;
        let factory_runtime = runtime.clone();
        let manager = CodexTerminalLaunchManager::with_plan_budget(
            Box::new(move || factory_runtime.clone() as std::sync::Arc<dyn CodexLaunchRuntime>),
            2,
            std::time::Duration::from_secs(30),
            64,
        );
        let launch = manager
            .plan_create_with_retry_uncancellable(
                &CodexLaunchPlanInput::default(),
                1,
                LaunchClass::Interactive,
            )
            .await
            .expect("plan");
        (manager, launch)
    });
    rt.shutdown_timeout(std::time::Duration::from_secs(5));
    // No ambient runtime here: must not panic (teardown is best-effort).
    manager.discard_sync(launch);
}

#[tokio::test]
async fn manager_shutdown_tears_down_adopted_and_unadopted_and_rejects_new_plans() {
    // main.rs graceful-shutdown wiring (inc.2): `manager.shutdown()` mirrors legacy's
    // close-time `codexLaunchPlanner.shutdown()` — the planner stops accepting plans
    // and tears down its unadopted sidecars — PLUS the adopted (terminal-owned)
    // launches the Rust manager keys, since server exit ends those terminals too.
    let runtime = FakeRuntime::start().await;
    let factory_runtime = runtime.clone();
    let manager = CodexTerminalLaunchManager::new(Box::new(move || {
        factory_runtime.clone() as Arc<dyn CodexLaunchRuntime>
    }));

    // One adopted launch + one unadopted plan.
    let adopted = manager
        .plan_create_with_retry_uncancellable(
            &CodexLaunchPlanInput::default(),
            5,
            LaunchClass::Interactive,
        )
        .await
        .unwrap();
    manager.adopt("term-live", adopted, 0).await.unwrap();
    let _unadopted = manager
        .plan_create_with_retry_uncancellable(
            &CodexLaunchPlanInput::default(),
            5,
            LaunchClass::Interactive,
        )
        .await
        .unwrap();

    manager.shutdown().await;
    // Both sidecars (two FakeRuntime instances? no — one shared runtime, one
    // shutdown call per sidecar) torn down: 2 runtime shutdowns.
    assert_eq!(runtime.shutdown_calls.load(Ordering::SeqCst), 2);

    // New plans are rejected with the legacy planner-shutdown message.
    let err = manager
        .plan_create_with_retry_uncancellable(
            &CodexLaunchPlanInput::default(),
            5,
            LaunchClass::Interactive,
        )
        .await
        .unwrap_err();
    match err {
        CodexLaunchError::Failed(message) => {
            assert_eq!(message, CODEX_LAUNCH_PLANNER_SHUTDOWN_MESSAGE);
        }
        other => panic!("expected Failed, got {other:?}"),
    }
}

#[tokio::test]
async fn manager_exit_for_unknown_terminal_is_a_noop() {
    let runtime = FakeRuntime::start().await;
    let factory_runtime = runtime.clone();
    let manager = CodexTerminalLaunchManager::new(Box::new(move || {
        factory_runtime.clone() as Arc<dyn CodexLaunchRuntime>
    }));
    manager.notify_terminal_exit("never-created");
}

// ── D-C-R sidecar planning budget (S5.e precondition) ─────────────────────────────

/// A [`FakeRuntime`]-shaped runtime whose `ensure_ready` blocks on a shared
/// [`tokio::sync::Notify`] so plans stay in flight until the test releases
/// them — the knob that keeps budget permits occupied.
struct BlockingRuntime {
    release: Arc<tokio::sync::Notify>,
}

impl CodexLaunchRuntime for BlockingRuntime {
    fn ensure_ready(
        &self,
        cwd: Option<String>,
    ) -> BoxFuture<'_, Result<CodexRuntimeReady, String>> {
        Box::pin(async move {
            self.release.notified().await;
            // Released: stand up the file's real loopback echo upstream so
            // the plan completes against a real socket.
            let inner = FakeRuntime::start().await;
            inner.ensure_ready(cwd).await
        })
    }

    fn update_ownership_metadata(
        &self,
        _terminal_id: String,
        _generation: u64,
    ) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move { Ok(()) })
    }

    fn shutdown(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move { Ok(()) })
    }
}

fn blocking_test_runtime_factory() -> (
    freshell_codex::launch_lifecycle::CodexRuntimeFactory,
    Arc<tokio::sync::Notify>,
) {
    let release = Arc::new(tokio::sync::Notify::new());
    let factory_release = release.clone();
    let factory: freshell_codex::launch_lifecycle::CodexRuntimeFactory = Box::new(move || {
        Arc::new(BlockingRuntime {
            release: factory_release.clone(),
        }) as Arc<dyn CodexLaunchRuntime>
    });
    (factory, release)
}

#[tokio::test]
async fn third_concurrent_plan_fails_fast_on_the_sidecar_budget() {
    let (blocking_runtime_factory, release) = blocking_test_runtime_factory();
    let manager = std::sync::Arc::new(
        freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::with_plan_budget(
            blocking_runtime_factory,
            2,
            std::time::Duration::from_millis(200),
            64,
        ),
    );
    let input = freshell_codex::launch_plan::CodexLaunchPlanInput::default();
    let m1 = manager.clone();
    let a = tokio::spawn(async move {
        m1.plan_create_with_retry_uncancellable(
            &CodexLaunchPlanInput::default(),
            1,
            LaunchClass::Interactive,
        )
        .await
    });
    let m2 = manager.clone();
    let b = tokio::spawn(async move {
        m2.plan_create_with_retry_uncancellable(
            &CodexLaunchPlanInput::default(),
            1,
            LaunchClass::Interactive,
        )
        .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await; // both hold the budget
    let third = manager
        .plan_create_with_retry_uncancellable(&input, 1, LaunchClass::Interactive)
        .await;
    let err = third.expect_err("third concurrent plan must fail fast on the budget");
    assert!(
        err.to_string().contains("planning budget exhausted"),
        "{err}"
    );
    release.notify_waiters();
    let _ = a.await;
    let _ = b.await;
}

// ── graceful restore/resume S1 (P2): restore-class plans queue, never die ─────────

/// Graceful restore/resume S1 (P2): a runtime that counts CONCURRENT
/// `ensure_ready` bodies and sleeps, so "max plan concurrency <= budget"
/// is observable without wall-clock racing. All trait methods other than
/// `ensure_ready` are copied from [`FakeRuntime`]'s impl (delegate to an
/// inner FakeRuntime started on demand, exactly like BlockingRuntime does).
struct CountingRuntime {
    in_flight: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    peak: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    plan_delay: std::time::Duration,
}

impl CodexLaunchRuntime for CountingRuntime {
    fn ensure_ready(
        &self,
        cwd: Option<String>,
    ) -> BoxFuture<'_, Result<CodexRuntimeReady, String>> {
        Box::pin(async move {
            use std::sync::atomic::Ordering;
            let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(now, Ordering::SeqCst);
            tokio::time::sleep(self.plan_delay).await;
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            let inner = FakeRuntime::start().await;
            inner.ensure_ready(cwd).await
        })
    }

    fn update_ownership_metadata(
        &self,
        _terminal_id: String,
        _generation: u64,
    ) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move { Ok(()) })
    }

    fn shutdown(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move { Ok(()) })
    }
}

/// The mandate's unit pin: 8 restore-class plans on a 2-permit budget with a
/// wait FAR smaller than the drain time — all 8 succeed (no wall-clock
/// death), and observed plan concurrency never exceeds 2.
#[tokio::test(flavor = "multi_thread")]
async fn eight_restore_class_plans_queue_and_drain_without_error() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let in_flight = std::sync::Arc::new(AtomicUsize::new(0));
    let peak = std::sync::Arc::new(AtomicUsize::new(0));
    let (rt_in, rt_peak) = (in_flight.clone(), peak.clone());
    let factory: freshell_codex::launch_lifecycle::CodexRuntimeFactory = Box::new(move || {
        std::sync::Arc::new(CountingRuntime {
            in_flight: rt_in.clone(),
            peak: rt_peak.clone(),
            plan_delay: std::time::Duration::from_millis(200),
        }) as std::sync::Arc<dyn CodexLaunchRuntime>
    });
    // wait = 200ms: 8 plans / 2 permits * 200ms = ~800ms of queueing.
    // Interactive would die; Restore must drain.
    let manager = std::sync::Arc::new(
        freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::with_plan_budget(
            factory,
            2,
            std::time::Duration::from_millis(200),
            64,
        ),
    );
    let mut handles = Vec::new();
    for _ in 0..8 {
        let m = manager.clone();
        handles.push(tokio::spawn(async move {
            let (_cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
            m.plan_create_with_retry(
                &CodexLaunchPlanInput::default(),
                1,
                freshell_codex::launch_lifecycle::LaunchClass::Restore,
                &mut cancel_rx,
            )
            .await
        }));
    }
    for h in handles {
        let launch = h
            .await
            .expect("join")
            .expect("restore-class plan must never die on the budget");
        manager.discard(launch).await;
    }
    let seen_peak = peak.load(Ordering::SeqCst);
    assert!(
        seen_peak <= 2,
        "plan concurrency bound violated: {seen_peak}"
    );
}

/// Cancel-aware queueing: a restore-class waiter parked on a zero-permit
/// budget unblocks as Cancelled the moment the watch fires.
#[tokio::test]
async fn restore_class_plan_wait_cancels_when_the_watch_fires() {
    let (factory, _release) = blocking_test_runtime_factory();
    let manager = std::sync::Arc::new(
        freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::with_plan_budget(
            factory,
            0,
            std::time::Duration::from_millis(50),
            64,
        ),
    );
    let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
    let m = manager.clone();
    let waiter = tokio::spawn(async move {
        m.plan_create_with_retry(
            &CodexLaunchPlanInput::default(),
            1,
            freshell_codex::launch_lifecycle::LaunchClass::Restore,
            &mut cancel_rx,
        )
        .await
    });
    // Let the waiter park (0 permits => it can only be waiting or done-wrong).
    for _ in 0..200 {
        if manager.plan_queue_depth() == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(manager.plan_queue_depth(), 1, "waiter must be queued");
    cancel_tx.send(true).expect("fire cancel");
    let err = waiter
        .await
        .expect("join")
        .expect_err("cancel must unblock the queued restore-class plan");
    assert!(
        matches!(
            err,
            freshell_codex::launch_lifecycle::CodexLaunchError::Cancelled
        ),
        "{err}"
    );
    assert_eq!(
        manager.plan_queue_depth(),
        0,
        "queue slot reclaimed on cancel"
    );
}

/// The backpressure backstop: restore-class waiters beyond the queue cap
/// fail loud as QueueFull (the WS door maps this to RATE_LIMITED).
#[tokio::test(flavor = "multi_thread")]
async fn restore_class_queue_overflow_fails_loud_as_queue_full() {
    let (factory, release) = blocking_test_runtime_factory();
    // 1 permit, cap 1: holder + one queued waiter fill the system.
    let manager = std::sync::Arc::new(
        freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::with_plan_budget(
            factory,
            1,
            std::time::Duration::from_millis(50),
            1,
        ),
    );
    let m1 = manager.clone();
    let holder = tokio::spawn(async move {
        let (_tx, mut c) = tokio::sync::watch::channel(false);
        m1.plan_create_with_retry(
            &CodexLaunchPlanInput::default(),
            1,
            freshell_codex::launch_lifecycle::LaunchClass::Restore,
            &mut c,
        )
        .await
    });
    // Let the holder take the permit (it parks inside ensure_ready).
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let m2 = manager.clone();
    let queued = tokio::spawn(async move {
        let (_tx, mut c) = tokio::sync::watch::channel(false);
        m2.plan_create_with_retry(
            &CodexLaunchPlanInput::default(),
            1,
            freshell_codex::launch_lifecycle::LaunchClass::Restore,
            &mut c,
        )
        .await
    });
    for _ in 0..200 {
        if manager.plan_queue_depth() == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(
        manager.plan_queue_depth(),
        1,
        "one waiter queued at the cap"
    );
    // Third arrival overflows the cap.
    let (_tx3, mut c3) = tokio::sync::watch::channel(false);
    let err = manager
        .plan_create_with_retry(
            &CodexLaunchPlanInput::default(),
            1,
            freshell_codex::launch_lifecycle::LaunchClass::Restore,
            &mut c3,
        )
        .await
        .expect_err("overflow past the plan queue cap must fail loud");
    assert!(
        matches!(
            err,
            freshell_codex::launch_lifecycle::CodexLaunchError::QueueFull
        ),
        "{err}"
    );
    // Drain: release the parked plans (BlockingRuntime parks on a Notify;
    // the queued waiter parks again after the holder finishes, so notify twice).
    release.notify_waiters();
    let launch = holder.await.expect("join").expect("holder plan completes");
    manager.discard(launch).await;
    release.notify_waiters();
    let launch2 = queued.await.expect("join").expect("queued plan completes");
    manager.discard(launch2).await;
}

// ── the spawn integration leg: real child + real proxy + fake TUI ─────────────────

fn fake_app_server_command() -> String {
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs");
    format!("node {}", fixture.display())
}

#[tokio::test]
async fn spawned_runtime_launches_the_app_server_and_relays_through_the_proxy() {
    let tmp = std::env::temp_dir().join(format!("freshell-codex-s4-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let runtime = Arc::new(SpawnedCodexAppServerRuntime::with_command(
        fake_app_server_command(),
    ));
    let spawn_runtime = runtime.clone();
    let planner = CodexLaunchPlanner::new(Box::new(move || {
        spawn_runtime.clone() as Arc<dyn CodexLaunchRuntime>
    }));

    let launch = planner
        .plan_create(&CodexLaunchPlanInput {
            cwd: Some(tmp.to_str().unwrap()),
            ..Default::default()
        })
        .await
        .expect("plan_create against the spawned fake app-server");

    // The TUI argv 4-tuple accepts the minted proxy URL.
    let args = codex_remote_args(&launch.remote_ws_url).unwrap();
    assert_eq!(args[0], "--remote");
    assert_eq!(args[2], "-c");
    assert_eq!(args[3], "features.apps=false");

    // Fake TUI dials the proxy and completes an initialize round trip against the
    // real (spawned) app-server through the relay.
    let (mut tui, _) = connect_async(&launch.remote_ws_url).await.unwrap();
    tui.send(Message::Text(
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}).to_string(),
    ))
    .await
    .unwrap();
    let reply = loop {
        let msg = timeout(RECV_TIMEOUT, tui.next())
            .await
            .expect("timed out waiting for the initialize reply through the proxy")
            .expect("proxy closed before replying")
            .unwrap();
        if let Message::Text(text) = msg {
            let value: serde_json::Value = serde_json::from_str(&text).unwrap();
            if value.get("id") == Some(&json!(1)) {
                break value;
            }
        }
    };
    assert!(reply.get("result").is_some(), "initialize failed: {reply}");

    // Teardown kills the spawned child.
    let pid = runtime.child_pid().await.expect("child pid");
    launch.sidecar.shutdown().await.unwrap();
    let deadline = tokio::time::Instant::now() + RECV_TIMEOUT;
    loop {
        if !std::path::Path::new(&format!("/proc/{pid}")).exists() {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "spawned app-server (pid {pid}) survived sidecar shutdown"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

// ────── S5.c persistence plumbing (mark_candidate_persisted, fail_candidate_capture) ──────

#[tokio::test]
async fn mark_candidate_persisted_is_a_noop_for_unknown_terminals() {
    let runtime = FakeRuntime::start().await;
    let factory_runtime = runtime.clone();
    let manager = CodexTerminalLaunchManager::new(Box::new(move || {
        factory_runtime.clone() as Arc<dyn CodexLaunchRuntime>
    }));
    // Must not panic, hang, or error for a terminal that was never adopted.
    manager.mark_candidate_persisted("no-such-terminal").await;
    manager
        .fail_candidate_capture("no-such-terminal", "test refusal")
        .await;
    // Observe the no-op: create and adopt a real launch, verify calling the
    // no-op methods on unknown terminals does not affect it (observable: the
    // adopted launch can still be shut down cleanly).
    let planner_runtime = runtime.clone();
    let planner = CodexLaunchPlanner::new(Box::new(move || {
        planner_runtime.clone() as Arc<dyn CodexLaunchRuntime>
    }));
    let launch = planner
        .plan_create(&CodexLaunchPlanInput::default())
        .await
        .expect("plan_create");
    manager
        .adopt("known-terminal", launch, 0)
        .await
        .expect("adopt");
    // Calling operations on other unknown terminals is still a no-op.
    manager.mark_candidate_persisted("still-unknown").await;
    manager
        .fail_candidate_capture("still-unknown", "test")
        .await;
    // The adopted terminal is unaffected (observable: manager can shut down cleanly).
    manager.shutdown().await;
}
