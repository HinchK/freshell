//! Manager-level daemon-loss self-heal (the 2026-09-20 incident's silent half):
//! a shared `opencode serve` daemon that dies on its own must not leave a
//! poisoned running entry forever.
//!
//! Pins the Task 3 machinery end-to-end through fully-faked IO (NO real serve,
//! NO live API calls — the `serve_health_bounded.rs` / `serve_idle_edge.rs`
//! conventions):
//!   * the daemon exit watcher: an unrequested process exit clears the running
//!     entry, emits `SessionSignal::Lost` for in-flight turns, broadcasts
//!     `DaemonSignal::Lost { reason: "process_exit" }`, and schedules a re-warm;
//!   * the re-warm retry loop: a FAILED re-warm attempt retries (never strands
//!     the daemon absent), and the automatic respawn BACKS OFF exponentially
//!     (no spawn storm);
//!   * the requested-discard arm: a Yes-lane timeout discard also signals
//!     `DaemonSignal::Lost` (its reason) and schedules the same backoff-guarded
//!     respawn — the runtime self-heal (Task 4) observes BOTH loss classes.
//!
//! The crash-detected WARN (`freshagent.opencode.daemon_crash_detected`) is
//! pinned unit-side in `serve.rs` (the `config_capture` idiom), where the
//! thread-local tracing capture hosts it.

use std::sync::atomic::{AtomicBool, AtomicU16, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use freshell_opencode::serve::{
    build_prompt_body, DaemonSignal, Endpoint, EventSink, EventSource, EventStreamHandle,
    OpencodeServeManager, PortAllocator, ProcessSpawner, ServeConfig, ServeDeps, ServeError,
    ServeHttp, ServeHttpError, ServeHttpRequest, ServeHttpResponse, ServeProcess, SessionSignal,
    SpawnRequest,
};

// ── injected fakes ───────────────────────────────────────────────────────────────

/// `/global/health` answers healthy; `/prompt_async` NEVER resolves when
/// `prompt_pending` (the Yes-lane timeout discard driver); everything else a
/// benign 200 `{}`.
struct HealthyHttp {
    prompt_pending: bool,
}
impl ServeHttp for HealthyHttp {
    fn request<'a>(
        &'a self,
        req: ServeHttpRequest,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<ServeHttpResponse, ServeHttpError>> + Send + 'a,
        >,
    > {
        if req.url.contains("/prompt_async") && self.prompt_pending {
            // A genuine wedge: the response NEVER resolves — only the caller's
            // per-request bound can settle it (the discard driver).
            return Box::pin(async {
                std::future::pending::<()>().await;
                unreachable!()
            });
        }
        Box::pin(async { Ok(ServeHttpResponse::new(200, b"{}".to_vec())) })
    }
}

/// Per-generation health scripting: probes to a port in `fail_ports` NEVER
/// resolve (the wedged shape — that generation's bounded health wait fails as
/// `NotHealthy`); every other request is healthy/benign. Ports come from
/// [`CountingAllocator`], so port number == spawn generation.
struct GenerationHealthHttp {
    fail_ports: Vec<u16>,
}
impl ServeHttp for GenerationHealthHttp {
    fn request<'a>(
        &'a self,
        req: ServeHttpRequest,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<ServeHttpResponse, ServeHttpError>> + Send + 'a,
        >,
    > {
        let wedged = req.url.contains("/global/health")
            && self
                .fail_ports
                .iter()
                .any(|port| req.url.contains(&format!(":{port}/")));
        if wedged {
            return Box::pin(async {
                std::future::pending::<()>().await;
                unreachable!()
            });
        }
        Box::pin(async { Ok(ServeHttpResponse::new(200, b"{}".to_vec())) })
    }
}

/// Hand out ports 1, 2, 3, … — one per cold start, so the spawn generation is
/// addressable in the URL (see [`GenerationHealthHttp`]).
struct CountingAllocator {
    next: AtomicU16,
}
impl PortAllocator for CountingAllocator {
    fn allocate(&self) -> Result<Endpoint, String> {
        let port = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        Ok(Endpoint {
            hostname: "127.0.0.1".into(),
            port,
        })
    }
}

/// A serve that never exits; `kill()` counts.
struct NeverExitsProcess {
    killed: Arc<AtomicUsize>,
}
impl ServeProcess for NeverExitsProcess {
    fn exited(&self) -> Option<i32> {
        None
    }
    fn take_fatal_startup_error(&self) -> Option<String> {
        None
    }
    fn kill(&self) {
        self.killed.fetch_add(1, Ordering::SeqCst);
    }
}

/// A serve whose "exit" is test-controlled: `exited()` reports `Some(0)` once
/// the shared flag is set (and stays Some — the dead daemon stays dead).
struct FlagExitProcess {
    exited: Arc<AtomicBool>,
    killed: Arc<AtomicUsize>,
}
impl ServeProcess for FlagExitProcess {
    fn exited(&self) -> Option<i32> {
        self.exited.load(Ordering::SeqCst).then_some(0)
    }
    fn take_fatal_startup_error(&self) -> Option<String> {
        None
    }
    fn kill(&self) {
        self.killed.fetch_add(1, Ordering::SeqCst);
    }
}

/// A serve that "dies" immediately after every successful start: the FIRST
/// `exited()` consult is `None` (the readiness wait's liveness check — the
/// health probe answers healthy on that same iteration), every later consult
/// reports the exit. Each instance serves exactly one spawn generation, so
/// every generation is healthy-then-dead one watch interval later.
struct DieAfterHealthProcess {
    exited_consults: AtomicUsize,
}
impl ServeProcess for DieAfterHealthProcess {
    fn exited(&self) -> Option<i32> {
        let n = self.exited_consults.fetch_add(1, Ordering::SeqCst) + 1;
        (n >= 2).then_some(0)
    }
    fn take_fatal_startup_error(&self) -> Option<String> {
        None
    }
    fn kill(&self) {}
}

/// Hands every generation a [`FlagExitProcess`] sharing the flag/counters.
struct FlagExitSpawner {
    exited: Arc<AtomicBool>,
    killed: Arc<AtomicUsize>,
    spawns: Arc<AtomicUsize>,
}
impl ProcessSpawner for FlagExitSpawner {
    fn spawn(&self, _req: SpawnRequest) -> Result<Box<dyn ServeProcess>, String> {
        self.spawns.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(FlagExitProcess {
            exited: self.exited.clone(),
            killed: self.killed.clone(),
        }))
    }
}

/// Hands every generation a fresh [`DieAfterHealthProcess`].
struct DieAfterHealthSpawner {
    spawns: Arc<AtomicUsize>,
}
impl ProcessSpawner for DieAfterHealthSpawner {
    fn spawn(&self, _req: SpawnRequest) -> Result<Box<dyn ServeProcess>, String> {
        self.spawns.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(DieAfterHealthProcess {
            exited_consults: AtomicUsize::new(0),
        }))
    }
}

/// Scripted topology: generation 1 is a test-controlled [`FlagExitProcess`]
/// (the healthy daemon the watcher arms on); every later generation is a
/// [`NeverExitsProcess`] — the later generations fail/succeed via the scripted
/// HTTP health, never via their own exit.
struct GenerationSpawner {
    first: Arc<AtomicBool>,
    killed: Arc<AtomicUsize>,
    spawns: Arc<AtomicUsize>,
}
impl ProcessSpawner for GenerationSpawner {
    fn spawn(&self, _req: SpawnRequest) -> Result<Box<dyn ServeProcess>, String> {
        let n = self.spawns.fetch_add(1, Ordering::SeqCst) + 1;
        if n == 1 {
            Ok(Box::new(FlagExitProcess {
                exited: self.first.clone(),
                killed: self.killed.clone(),
            }))
        } else {
            Ok(Box::new(NeverExitsProcess {
                killed: self.killed.clone(),
            }))
        }
    }
}

/// Hands every generation a [`NeverExitsProcess`]; kills/spawns counted.
struct NeverExitsSpawner {
    killed: Arc<AtomicUsize>,
    spawns: Arc<AtomicUsize>,
}
impl ProcessSpawner for NeverExitsSpawner {
    fn spawn(&self, _req: SpawnRequest) -> Result<Box<dyn ServeProcess>, String> {
        self.spawns.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(NeverExitsProcess {
            killed: self.killed.clone(),
        }))
    }
}

struct NoopEventHandle;
impl EventStreamHandle for NoopEventHandle {}

struct NoopEventSource;
impl EventSource for NoopEventSource {
    fn connect(&self, _url: String, _sink: EventSink) -> Box<dyn EventStreamHandle> {
        Box::new(NoopEventHandle)
    }
}

/// The Task 3 self-heal knobs: a tiny watch interval and a tiny backoff.
fn selfheal_config(watch_ms: u64, backoff_initial_ms: u64, backoff_max_ms: u64) -> ServeConfig {
    ServeConfig {
        daemon_watch_interval: Duration::from_millis(watch_ms),
        re_warm_backoff_initial_ms: backoff_initial_ms,
        re_warm_backoff_max_ms: backoff_max_ms,
        ..ServeConfig::default()
    }
}

async fn started_manager(deps: ServeDeps, config: ServeConfig) -> OpencodeServeManager {
    let mgr = OpencodeServeManager::new(deps, config);
    mgr.ensure_started()
        .await
        .expect("healthy fake serve starts");
    mgr
}

// ── tests ──────────────────────────────────────────────────────────────────────

/// A daemon that dies on its own must not leave a poisoned running entry
/// forever (the 2026-09-20 incident's silent half): the watcher clears the
/// entry, emits Lost for in-flight turns, signals daemon loss, and schedules
/// the backoff-guarded respawn.
#[tokio::test]
async fn unrequested_daemon_exit_clears_running_emits_lost_and_signals() {
    let exited = Arc::new(AtomicBool::new(false));
    let killed = Arc::new(AtomicUsize::new(0));
    let spawns = Arc::new(AtomicUsize::new(0));
    let deps = ServeDeps {
        spawner: Arc::new(FlagExitSpawner {
            exited: exited.clone(),
            killed: killed.clone(),
            spawns: spawns.clone(),
        }),
        http: Arc::new(HealthyHttp {
            prompt_pending: false,
        }),
        ports: Arc::new(CountingAllocator {
            next: AtomicU16::new(0),
        }),
        events: Arc::new(NoopEventSource),
    };
    let manager = started_manager(deps, selfheal_config(10, 5, 50)).await;
    // Subscribe BEFORE the daemon dies: tokio broadcast does NOT replay
    // history to late subscribers, so a post-loss subscribe would miss the
    // edge (the contract Task 4's level-triggered design depends on).
    let mut signals = manager.subscribe_daemon_signals();
    let mut idle = manager.subscribe("ses_a");

    exited.store(true, Ordering::SeqCst); // the daemon "exits"

    let signal = tokio::time::timeout(Duration::from_secs(2), signals.recv())
        .await
        .expect("loss signal within budget")
        .expect("channel alive");
    assert!(
        matches!(
            signal,
            DaemonSignal::Lost {
                reason: "process_exit"
            }
        ),
        "an unrequested daemon exit must signal Lost{{process_exit}}, got {signal:?}"
    );
    assert!(
        manager.base_url().await.is_none(),
        "the dead daemon's running entry must be cleared"
    );
    assert!(
        matches!(idle.try_recv(), Ok(SessionSignal::Lost)),
        "in-flight session subscribers must see the Lost edge"
    );
    assert!(
        killed.load(Ordering::SeqCst) >= 1,
        "the already-exited daemon is still kill()ed for /proc-reaper parity"
    );
}

/// Crash-loop guard: the automatic re-warm must BACK OFF exponentially, not
/// spawn-storm. A daemon that dies immediately after every successful start
/// drives a continuous loss→re-warm cycle; within the 700 ms window the
/// observed spawn count must show the 50→100→200→400 ms escalation (a
/// non-backed-off loop would spawn dozens; no re-warm at all would strand the
/// count at 1).
#[tokio::test]
async fn daemon_loss_re_warm_backs_off_exponentially() {
    let spawns = Arc::new(AtomicUsize::new(0));
    let deps = ServeDeps {
        spawner: Arc::new(DieAfterHealthSpawner {
            spawns: spawns.clone(),
        }),
        http: Arc::new(HealthyHttp {
            prompt_pending: false,
        }),
        ports: Arc::new(CountingAllocator {
            next: AtomicU16::new(0),
        }),
        events: Arc::new(NoopEventSource),
    };
    // The manager binding stays alive for the window: its watcher/re-warm
    // tasks hold their own Arc clones, but keeping the binding makes the
    // driving ownership explicit.
    let _manager = started_manager(deps, selfheal_config(5, 50, 400)).await;

    tokio::time::sleep(Duration::from_millis(700)).await;
    let observed = spawns.load(Ordering::SeqCst);
    assert!(
        (2..=6).contains(&observed),
        "re-warm must respawn (>= 2) AND back off exponentially (<= 6) — \
         observed {observed} spawns in 700 ms with 50 ms initial / 400 ms max backoff"
    );
}

/// A FAILED re-warm attempt must RETRY (the loop), never strand the daemon
/// permanently absent: spawn #1 is healthy and exits on demand; the re-warm's
/// spawns #2 and #3 fail their bounded health waits; spawn #4 is healthy. The
/// daemon must eventually come back, having spawned at least 4 times.
#[tokio::test]
async fn a_failed_re_warm_retries_until_the_daemon_starts() {
    let spawns = Arc::new(AtomicUsize::new(0));
    let first_exited = Arc::new(AtomicBool::new(false));
    let killed = Arc::new(AtomicUsize::new(0));
    let deps = ServeDeps {
        spawner: Arc::new(GenerationSpawner {
            first: first_exited.clone(),
            killed: killed.clone(),
            spawns: spawns.clone(),
        }),
        http: Arc::new(GenerationHealthHttp {
            fail_ports: vec![2, 3],
        }),
        ports: Arc::new(CountingAllocator {
            next: AtomicU16::new(0),
        }),
        events: Arc::new(NoopEventSource),
    };
    let config = ServeConfig {
        health_timeout: Duration::from_millis(40),
        health_probe_timeout: Duration::from_millis(10),
        health_retry_interval: Duration::from_millis(5),
        daemon_watch_interval: Duration::from_millis(5),
        re_warm_backoff_initial_ms: 10,
        re_warm_backoff_max_ms: 50,
        ..ServeConfig::default()
    };
    let manager = started_manager(deps, config).await;
    let mut signals = manager.subscribe_daemon_signals();

    first_exited.store(true, Ordering::SeqCst); // the healthy daemon "exits"
    let signal = tokio::time::timeout(Duration::from_secs(2), signals.recv())
        .await
        .expect("loss signal within budget")
        .expect("channel alive");
    assert!(
        matches!(
            signal,
            DaemonSignal::Lost {
                reason: "process_exit"
            }
        ),
        "got {signal:?}"
    );

    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if manager.base_url().await.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the re-warm loop must eventually succeed (fail, fail, then healthy)");
    assert!(
        spawns.load(Ordering::SeqCst) >= 4,
        "the failed re-warm attempts must be retried — observed {} spawns \
         (initial + 2 failed re-warms + success)",
        spawns.load(Ordering::SeqCst)
    );
}

/// A discard (the intentional kill path) must ALSO signal daemon loss (with
/// its reason) and schedule the re-warm, so the runtime self-heal (Task 4)
/// observes the requested-loss class the same as the crash class. Driven
/// through `prompt_async` — a deliberate `DiscardOnTimeout::Yes` lane.
#[tokio::test]
async fn discard_running_signals_daemon_loss_and_schedules_re_warm() {
    let spawns = Arc::new(AtomicUsize::new(0));
    let killed = Arc::new(AtomicUsize::new(0));
    let deps = ServeDeps {
        spawner: Arc::new(NeverExitsSpawner {
            killed: killed.clone(),
            spawns: spawns.clone(),
        }),
        http: Arc::new(HealthyHttp {
            prompt_pending: true,
        }),
        ports: Arc::new(CountingAllocator {
            next: AtomicU16::new(0),
        }),
        events: Arc::new(NoopEventSource),
    };
    let config = ServeConfig {
        request_timeout: Duration::from_millis(50),
        daemon_watch_interval: Duration::from_millis(5),
        re_warm_backoff_initial_ms: 20,
        re_warm_backoff_max_ms: 100,
        ..ServeConfig::default()
    };
    let manager = started_manager(deps, config).await;
    let mut signals = manager.subscribe_daemon_signals();

    let err = manager
        .prompt_async(
            "ses_discard",
            build_prompt_body("hi", None, None),
            &None,
            None,
        )
        .await
        .expect_err("the prompt POST must time out");
    assert!(
        matches!(err, ServeError::RequestTimeout { .. }),
        "got {err:?}"
    );

    let lost = tokio::time::timeout(Duration::from_secs(2), signals.recv())
        .await
        .expect("loss signal within budget")
        .expect("channel alive");
    assert!(
        matches!(
            lost,
            DaemonSignal::Lost {
                reason: "request_timeout"
            }
        ),
        "a discard must signal its reason, got {lost:?}"
    );
    let respawned = tokio::time::timeout(Duration::from_secs(2), signals.recv())
        .await
        .expect("re-warm within budget")
        .expect("channel alive");
    assert!(
        matches!(respawned, DaemonSignal::Started),
        "the discard's scheduled re-warm must respawn the daemon, got {respawned:?}"
    );
    assert!(
        spawns.load(Ordering::SeqCst) >= 2,
        "a respawn happened after the backoff (observed {} spawns)",
        spawns.load(Ordering::SeqCst)
    );
    assert!(
        manager.base_url().await.is_some(),
        "the re-warmed daemon serves again"
    );
}
