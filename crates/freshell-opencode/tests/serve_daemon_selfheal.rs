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
//!     respawn — the runtime self-heal (Task 4) observes BOTH loss classes;
//!   * the stale-timeout gate: a Yes-lane timeout may only discard the daemon
//!     the wedged request was ACTUALLY dispatched against — never its
//!     replacement;
//!   * the successor-sweep fence (ep2-r1 fresheyes Major): a loss cleanup
//!     still running past its running-entry take must never claim session
//!     emitters registered by the replacement daemon that cold-started in
//!     the overlap — A's late cleanup wiped B's fresh sender, and B's bridge
//!     dead-ended with no recovery trigger left.
//!
//! The crash-detected WARN (`freshagent.opencode.daemon_crash_detected`) is
//! pinned unit-side in `serve.rs` (the `config_capture` idiom), where the
//! thread-local tracing capture hosts it.

use std::sync::atomic::{AtomicBool, AtomicU16, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use freshell_opencode::events::parse_serve_event;
use freshell_opencode::serve::{
    build_prompt_body, DaemonSignal, Endpoint, EventSink, EventSource, EventStreamHandle,
    OpencodeServeManager, PortAllocator, ProcessSpawner, ServeConfig, ServeDeps, ServeError,
    ServeHttp, ServeHttpError, ServeHttpRequest, ServeHttpResponse, ServeProcess, SessionSignal,
    SpawnRequest,
};
use serde_json::json;
use tokio::sync::broadcast::error::TryRecvError;

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

/// A serve whose `kill()` PARKS until the test drops the release sender: the
/// loss cleanup stops between the running-entry take (the lock is already
/// released) and its session-emitter sweep — the exact production window in
/// which a successor daemon's cold start + bridge registration can overlap
/// the still-pending cleanup. `kill_entered` counts the park so the test can
/// wait for the cleanup to reach it.
struct LatchedKillProcess {
    exited: Arc<AtomicBool>,
    kill_entered: Arc<AtomicUsize>,
    release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
}
impl ServeProcess for LatchedKillProcess {
    fn exited(&self) -> Option<i32> {
        self.exited.load(Ordering::SeqCst).then_some(0)
    }
    fn take_fatal_startup_error(&self) -> Option<String> {
        None
    }
    fn kill(&self) {
        self.kill_entered.fetch_add(1, Ordering::SeqCst);
        // Park the cleanup; the test releases the latch by dropping its
        // sender, which ends this recv with an error. Only kill() ever
        // touches the receiver, so parking under the mutex is safe.
        // block_in_place: recv() is a BLOCKING sync wait, and a tokio
        // worker must never block directly — the worker servicing the
        // runtime's timer driver would starve every sleep/timeout on the
        // runtime (observed: the whole test freezes). block_in_place
        // hands the worker's runtime duties off first. Requires the
        // multi_thread flavor this test runs under.
        tokio::task::block_in_place(|| {
            let _ = self.release.lock().expect("latch mutex").recv();
        });
    }
}

/// Generation 1 is the latched daemon A (the test holds the release sender);
/// every later generation is a [`NeverExitsProcess`] — the replacement B,
/// which this spawner's test never loses.
struct LatchedKillSpawner {
    exited: Arc<AtomicBool>,
    kill_entered: Arc<AtomicUsize>,
    spawns: Arc<AtomicUsize>,
    /// The gen-1 latch receiver, handed to the first spawned process.
    release: std::sync::Mutex<Option<std::sync::mpsc::Receiver<()>>>,
}
impl ProcessSpawner for LatchedKillSpawner {
    fn spawn(&self, _req: SpawnRequest) -> Result<Box<dyn ServeProcess>, String> {
        let n = self.spawns.fetch_add(1, Ordering::SeqCst) + 1;
        if n == 1 {
            let release = self
                .release
                .lock()
                .expect("latch mutex")
                .take()
                .expect("the gen-1 latch receiver is present");
            Ok(Box::new(LatchedKillProcess {
                exited: self.exited.clone(),
                kill_entered: self.kill_entered.clone(),
                release: std::sync::Mutex::new(release),
            }))
        } else {
            Ok(Box::new(NeverExitsProcess {
                killed: Arc::new(AtomicUsize::new(0)),
            }))
        }
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

/// Delta-r1 review Finding 1 (the stale-timeout discard race): a Yes-lane
/// timeout may only discard the daemon the timed-out request was ACTUALLY
/// dispatched against — never its replacement. Two staggered wedged prompt
/// POSTs both capture daemon A's base (port 1); R1's timeout legitimately
/// discards A and the re-warm installs the replacement B (port 2); R2 —
/// still wedged against the dead A — then times out and must NO-OP: B
/// survives (no kill, no second `Lost`, no third spawn), the same silence
/// as a `None` take. Pre-fix, R2's timeout took+killed whichever entry was
/// CURRENT — the innocent replacement — defeating stable self-healing.
#[tokio::test]
async fn stale_request_timeout_never_discards_the_replacement_daemon() {
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
        request_timeout: Duration::from_millis(100),
        daemon_watch_interval: Duration::from_millis(5),
        re_warm_backoff_initial_ms: 10,
        re_warm_backoff_max_ms: 50,
        ..ServeConfig::default()
    };
    let manager = started_manager(deps, config).await;
    let mut signals = manager.subscribe_daemon_signals();

    // R1 dispatches against daemon A (port 1) and wedges.
    let r1_manager = manager.clone();
    let r1 = tokio::spawn(async move {
        r1_manager
            .prompt_async("ses_r1", build_prompt_body("r1", None, None), &None, None)
            .await
    });
    // Stagger: R2 still dispatches against A (well inside R1's timeout).
    tokio::time::sleep(Duration::from_millis(40)).await;
    let r2_manager = manager.clone();
    let r2 = tokio::spawn(async move {
        r2_manager
            .prompt_async("ses_r2", build_prompt_body("r2", None, None), &None, None)
            .await
    });

    // R1's timeout: A is discarded — the legitimate same-identity discard.
    let r1_err = r1
        .await
        .expect("r1 settles")
        .expect_err("the r1 prompt POST must time out");
    assert!(
        matches!(r1_err, ServeError::RequestTimeout { .. }),
        "got {r1_err:?}"
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
        "the same-identity discard must signal its loss, got {lost:?}"
    );
    assert_eq!(
        killed.load(Ordering::SeqCst),
        1,
        "the discard killed exactly the wedged daemon A"
    );
    // The re-warm installs the replacement daemon B (port 2).
    let started = tokio::time::timeout(Duration::from_secs(2), signals.recv())
        .await
        .expect("re-warm within budget")
        .expect("channel alive");
    assert!(
        matches!(started, DaemonSignal::Started),
        "the re-warm must install the replacement, got {started:?}"
    );
    assert_eq!(
        manager.base_url().await,
        Some("http://127.0.0.1:2".to_string()),
        "the replacement daemon B owns the running entry"
    );
    assert_eq!(
        spawns.load(Ordering::SeqCst),
        2,
        "exactly A and B have spawned so far"
    );

    // R2 — still wedged against the dead A — now times out.
    let r2_err = r2
        .await
        .expect("r2 settles")
        .expect_err("the r2 prompt POST must time out");
    match r2_err {
        ServeError::RequestTimeout { url, .. } => assert!(
            url.contains("127.0.0.1:1"),
            "R2 was dispatched against daemon A: {url}"
        ),
        other => panic!("expected a RequestTimeout, got {other:?}"),
    }

    // THE assertion: the stale timeout must not touch B — no kill, no second
    // Lost, no third spawn — the silence of a `None` take.
    assert_eq!(
        killed.load(Ordering::SeqCst),
        1,
        "the stale timeout must NOT kill the replacement daemon B"
    );
    assert_eq!(
        manager.base_url().await,
        Some("http://127.0.0.1:2".to_string()),
        "the replacement daemon B must survive the stale timeout"
    );
    match signals.try_recv() {
        Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {}
        other => panic!("the stale timeout must not signal a second loss, got {other:?}"),
    }
    // A sneaky deferred re-warm would have spawned by now (the ladder's
    // first rung is 10-20 ms with these knobs).
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert_eq!(
        spawns.load(Ordering::SeqCst),
        2,
        "the stale timeout must not schedule another re-warm"
    );
    assert_eq!(
        manager.base_url().await,
        Some("http://127.0.0.1:2".to_string()),
        "B is still the running daemon after the settle window"
    );
}

// ── ep2-r2 fresheyes Major: cross-generation event contamination ────────────────

/// An [`EventSource`] that RECORDS every sink it is handed (one per cold
/// start, in connect order) — the REAL per-connection dispatch closures
/// [`OpencodeServeManager`] mints at each daemon's connect, so a test can
/// dispatch a late event through the exact path the transport would,
/// carrying the CONNECTING daemon's identity. The ep2-r2 requirement: the
/// prior successor-emitter test dispatched through the generation-less
/// `dispatch_event` seam and could not observe this defect class at all.
struct RecordingEventSource {
    sinks: std::sync::Mutex<Vec<EventSink>>,
}
impl EventSource for RecordingEventSource {
    fn connect(&self, _url: String, sink: EventSink) -> Box<dyn EventStreamHandle> {
        self.sinks.lock().expect("recorded sinks mutex").push(sink);
        Box::new(NoopEventHandle)
    }
}

/// A late event from a LOST daemon generation must NEVER reach the
/// successor era (ep2-r2 fresheyes Major — cross-generation event
/// contamination, the false-chime precursor). The review's interleaving,
/// forced deterministically: daemon A is lost through the REAL watcher
/// arm (take + sweep + Lost), the re-warm installs the successor B, a
/// B-era `await_idle` is subscribed and IN FLIGHT for a durable session —
/// and only then does A's connection sink (the real dispatch closure
/// minted at A's cold start, still alive in the taken `RunningServe`'s
/// SSE-handle window) deliver a buffered `session.idle`. It must NOT
/// satisfy the successor's `await_idle` — the exact event that would
/// falsely produce `freshAgent.turn.complete` and clear busy for a
/// still-running B turn (the no-chime-on-daemon-loss contract). A
/// genuine B-era idle delivered through B's OWN sink must still satisfy
/// it (the dispatch is generation-fenced, not broken). Pre-fix, the
/// sink was generation-less: the late A event dispatched straight into
/// the shared emitter map and the successor's await resolved Ok.
#[tokio::test]
async fn a_lost_daemons_late_events_never_satisfy_the_successors_await_idle() {
    let exited = Arc::new(AtomicBool::new(false));
    let killed = Arc::new(AtomicUsize::new(0));
    let spawns = Arc::new(AtomicUsize::new(0));
    let events = Arc::new(RecordingEventSource {
        sinks: std::sync::Mutex::new(Vec::new()),
    });
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
        events: events.clone(),
    };
    let manager = started_manager(deps, selfheal_config(10, 5, 50)).await;
    let mut signals = manager.subscribe_daemon_signals();

    // Daemon A's connection sink — the REAL dispatch closure, carrying A's
    // daemon-generation identity.
    let sink_a = events
        .sinks
        .lock()
        .expect("recorded sinks mutex")
        .first()
        .expect("A's cold start connected its event stream")
        .clone();

    // Daemon A dies — the watcher arm's REAL loss path (take + sweep +
    // Lost all complete before the Lost broadcast is observable here).
    exited.store(true, Ordering::SeqCst);
    let lost = tokio::time::timeout(Duration::from_secs(2), signals.recv())
        .await
        .expect("loss signal within budget")
        .expect("channel alive");
    assert!(
        matches!(
            lost,
            DaemonSignal::Lost {
                reason: "process_exit"
            }
        ),
        "got {lost:?}"
    );
    // The re-warm installs the successor daemon B — a NEW generation with
    // its own connection sink.
    exited.store(false, Ordering::SeqCst);
    let started = tokio::time::timeout(Duration::from_secs(2), signals.recv())
        .await
        .expect("re-warm within budget")
        .expect("channel alive");
    assert!(matches!(started, DaemonSignal::Started), "got {started:?}");
    assert_eq!(
        events.sinks.lock().expect("recorded sinks mutex").len(),
        2,
        "fixture: exactly two daemon generations have connected"
    );
    let sink_b = events
        .sinks
        .lock()
        .expect("recorded sinks mutex")
        .get(1)
        .expect("B's cold start connected its event stream")
        .clone();
    let idle_event = || {
        parse_serve_event(&json!({
            "type": "session.idle",
            "properties": { "sessionID": "ses_late" }
        }))
        .expect("parseable serve event")
    };

    // B's `await_idle`, subscribed and IN FLIGHT for the durable session
    // (the successor-era registration the late event must not reach).
    let rx = manager.subscribe("ses_late");
    let idle_manager = manager.clone();
    let mut await_idle = tokio::spawn(async move {
        idle_manager
            .await_idle("ses_late", rx, Duration::from_secs(5), None)
            .await
    });
    // Let the await enter its select loop. (Broadcast buffers the event
    // for an existing subscriber either way, but a live loop makes the
    // in-flight premise unambiguous.)
    tokio::time::sleep(Duration::from_millis(50)).await;

    // THE LATE A-ERA EVENT: dispatched through A's REAL sink — after A's
    // take, with B installed and B's await_idle in flight. On the
    // pre-fix generation-less sink this buffered `session.idle`
    // satisfied the successor's await.
    sink_a(idle_event());

    // It must NOT satisfy: the await stays pending through the grace
    // window.
    match tokio::time::timeout(Duration::from_millis(300), &mut await_idle).await {
        Err(_still_pending) => {}
        Ok(Ok(Ok(()))) => panic!(
            "a late event from the LOST daemon generation satisfied the \
             successor's await_idle — the false freshAgent.turn.complete \
             precursor (ep2-r2 cross-generation contamination)"
        ),
        other => panic!("await_idle settled unexpectedly: {other:?}"),
    }

    // A GENUINE B-era idle through B's OWN sink still satisfies it — the
    // gate is a generation fence, not a broken dispatch.
    sink_b(idle_event());
    let outcome = tokio::time::timeout(Duration::from_secs(2), await_idle)
        .await
        .expect("the genuine B-era idle resolves within budget");
    assert!(
        matches!(outcome, Ok(Ok(()))),
        "the successor's own idle edge must satisfy await_idle, got {outcome:?}"
    );
}

// ── ep2-r1 fresheyes Major: A's late emitter cleanup vs. B's fresh sender ────────

/// A daemon-loss cleanup must NEVER remove session emitters registered by a
/// SUCCESSOR daemon (ep2-r1 fresheyes Major — A's late emitter cleanup wipes
/// B's fresh sender). The review's interleaving, forced deterministically:
/// daemon A is lost and its cleanup is HELD at the kill/reap step — the take
/// already happened and the `running` lock is free; while held, the
/// fenced-attach-shaped recovery cold-starts the replacement daemon B
/// (`ensure_started`, which broadcasts B's `Started` — it comes and goes
/// BEFORE A's `Lost`, exactly as in the finding) and registers a B-era
/// session sender in the SHARED emitter map (the bridge subscribe,
/// `spawn_serve_bridge`'s `manager.subscribe(&real_id)`). Releasing A's
/// cleanup must send `Lost` ONLY to A's pre-existing subscribers; B's fresh
/// sender must survive untouched and still work — a dispatch through the
/// shared map must reach its subscriber (the bridge stays live and
/// functional; no revival pass is needed). Pre-fix, A's late
/// `emit_lost_for_all` swept the WHOLE shared map — claiming B's fresh
/// sender, so B's bridge drained its closed channel and exited with no
/// recovery trigger left (the dead-ended pane this self-heal exists to
/// prevent).
///
/// Multi-thread runtime: the parked `kill()` blocks inside
/// `block_in_place`, which requires the multi_thread flavor, and the test's
/// own cold-start/registration work needs the remaining workers.
#[tokio::test(flavor = "multi_thread")]
async fn daemon_loss_cleanup_never_sweeps_a_successor_daemons_emitters() {
    let exited = Arc::new(AtomicBool::new(false));
    let kill_entered = Arc::new(AtomicUsize::new(0));
    let spawns = Arc::new(AtomicUsize::new(0));
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let deps = ServeDeps {
        spawner: Arc::new(LatchedKillSpawner {
            exited: exited.clone(),
            kill_entered: kill_entered.clone(),
            spawns: spawns.clone(),
            release: std::sync::Mutex::new(Some(release_rx)),
        }),
        http: Arc::new(HealthyHttp {
            prompt_pending: false,
        }),
        ports: Arc::new(CountingAllocator {
            next: AtomicU16::new(0),
        }),
        events: Arc::new(NoopEventSource),
    };
    // Huge backoff: A's own scheduled re-warm must stay parked for the whole
    // test window — the successor start under proof is the overlapped
    // fenced-attach-shaped `ensure_started` below, and the manager's re-warm
    // must not race it for the cold-start slot.
    let manager = started_manager(deps, selfheal_config(10, 60_000, 120_000)).await;
    let mut signals = manager.subscribe_daemon_signals();
    // A-era registration: the subscriber that was already live when A died.
    let mut rx_a = manager.subscribe("ses_a");

    // Daemon A dies; the watcher's loss path takes A out of the running slot
    // and parks at the kill/reap step.
    exited.store(true, Ordering::SeqCst);
    tokio::time::timeout(Duration::from_secs(2), async {
        while kill_entered.load(Ordering::SeqCst) < 1 {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("the loss cleanup must reach its kill/reap step within the budget");
    assert!(
        manager.base_url().await.is_none(),
        "fixture: A is already taken out of the running slot while its cleanup is parked"
    );

    // The overlapped fenced-attach shape: with A's cleanup still parked, the
    // recovery cold-starts the replacement daemon B (a NEW generation — its
    // `Started` broadcasts now, BEFORE A's `Lost`, the finding's ordering).
    let b_base = manager
        .ensure_started()
        .await
        .expect("the replacement daemon B cold-starts while A's cleanup is parked");
    assert_eq!(
        b_base, "http://127.0.0.1:2",
        "B is a cold start on the next allocator port, not the fast path"
    );
    // ... and its bridge registers the successor's session sender in the
    // SHARED emitter map.
    let mut rx_b = manager.subscribe("ses_b");

    // Release A's parked cleanup: kill/reap A, sweep the session emitters,
    // and signal the loss.
    drop(release_tx);

    let first = tokio::time::timeout(Duration::from_secs(2), signals.recv())
        .await
        .expect("a daemon signal within budget")
        .expect("channel alive");
    assert!(
        matches!(first, DaemonSignal::Started),
        "B's cold start mid-cleanup must broadcast Started first, got {first:?}"
    );
    let second = tokio::time::timeout(Duration::from_secs(2), signals.recv())
        .await
        .expect("a daemon signal within budget")
        .expect("channel alive");
    assert!(
        matches!(
            second,
            DaemonSignal::Lost {
                reason: "process_exit"
            }
        ),
        "A's released cleanup signals its loss, got {second:?}"
    );

    // A's Lost went to A's pre-existing subscriber — and cleared A's own
    // emitter (its channel closes once the swept senders drop).
    assert!(
        matches!(rx_a.try_recv(), Ok(SessionSignal::Lost)),
        "A's pre-existing subscriber must see the Lost edge"
    );
    assert!(
        matches!(rx_a.try_recv(), Err(TryRecvError::Closed)),
        "A's own emitter must be cleared from the shared map"
    );

    // THE invariant: B's sender was registered by a SUCCESSOR — A's cleanup
    // must never claim it. No Lost edge may arrive on it ...
    match rx_b.try_recv() {
        Err(TryRecvError::Empty) => {}
        other => panic!(
            "A's loss cleanup must never touch the successor daemon's fresh \
             sender — a post-take registration was swept (ep2-r1): got {other:?}"
        ),
    }
    // ... and it must still WORK: a dispatch through the shared map still
    // reaches the B-era subscriber (the bridge stays live and functional).
    manager.dispatch_event(
        parse_serve_event(&json!({
            "type": "session.idle",
            "properties": { "sessionID": "ses_b" }
        }))
        .expect("parseable serve event"),
    );
    let got = tokio::time::timeout(Duration::from_secs(2), rx_b.recv())
        .await
        .expect("the dispatch must arrive on the successor's emitter within the budget");
    assert!(
        matches!(got, Ok(SessionSignal::Event(_))),
        "the successor daemon's emitter must still deliver events, got {got:?}"
    );
    // Stability: no further daemon edges in the window (the huge backoff
    // keeps the scheduled re-warm parked).
    match signals.try_recv() {
        Err(TryRecvError::Empty) => {}
        other => panic!("no further daemon edges expected, got {other:?}"),
    }
}
