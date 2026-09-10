//! Atomic session handoff (kata b8ke Task 6): one server-authoritative
//! operation that moves a canonical `(provider, sessionId)` between the
//! terminal lane and a fresh-agent runtime — enter Handoff (generation+1) →
//! broadcast → stop prior runtime → await confirmed reap → start/attach
//! target under the retained lease (under-ticket mode — no double commit) →
//! commit Live(targetKind) → broadcast owner identity. Failures are typed,
//! retryable, and restore the prior owner or leave Vacant; never a blank
//! session, never a second writer.
//!
//! Runs on a DETACHED task (the settle-task precedent, `terminal_tabs.rs`)
//! so a client disconnect cannot half-orphan it; an RAII guard fails the
//! coordinator entry if the task is cancelled or panics mid-flight — and
//! reaps a spawned-but-uncommitted target runtime (round-1 review:
//! cancellation-safety across the target-spawn window).
//!
//! Layering: `freshell-freshagent` never imports `freshell-ws`; the runner
//! holds clones of the three fresh states plus the shared terminal registry
//! and coordinator, minted in `freshell-server::main`.
use std::sync::Arc;

use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use freshell_ownership::{
    BeginOutcome, CommitOutcome, FailOutcome, ObservedFence, OwnerIdentity, RuntimeOwnerKind,
    RuntimeOwnershipRegistry,
};
use serde_json::{json, Value};
use tokio::sync::oneshot;

/// The REST route this module serves.
pub(crate) const HANDOFF_ROUTE: &str = "/api/sessions/handoff";

/// Test-only injection (rides the constructor, never env — the
/// `spawn_auto_resume_hub_with_schedules` precedent). `events` records the
/// runner's step order (Reaped/TargetStarted) for ordering assertions.
pub struct HandoffTestHooks {
    /// Park the runner right after the coordinator enter (before the stop).
    pub pause_after_enter: Option<tokio::sync::Notify>,
    /// Short-circuit `stop_runtime` to `ReapTimeout` WITHOUT issuing any
    /// kill — the deterministic reap-timeout test path (the prior stays
    /// exactly as alive as the test made it). Atomic so a test can clear it
    /// for the retry assertion.
    pub force_reap_timeout: std::sync::atomic::AtomicBool,
    /// Make the NEXT `start_target` fail before spawning anything.
    pub fail_target_spawn_once: std::sync::atomic::AtomicBool,
    /// Ordered step labels ("Reaped", "TargetStarted") — test assertions.
    pub events: std::sync::Mutex<Vec<&'static str>>,
}

impl Default for HandoffTestHooks {
    fn default() -> Self {
        Self {
            pause_after_enter: None,
            force_reap_timeout: std::sync::atomic::AtomicBool::new(false),
            fail_target_spawn_once: std::sync::atomic::AtomicBool::new(false),
            events: std::sync::Mutex::new(Vec::new()),
        }
    }
}

impl HandoffTestHooks {
    fn record(&self, step: &'static str) {
        self.events.lock().expect("handoff hooks lock").push(step);
    }
}

/// The handoff request (the `POST /api/sessions/handoff` body, parsed).
pub struct HandoffRequest {
    pub provider: String,
    pub session_id: String,
    pub target_kind: RuntimeOwnerKind,
    /// fresh-agent target: freshcodex | freshopencode | freshclaude | kilroy
    /// (round-2 review: ALL fresh-agent session types — kilroy rides the
    /// claude lane, so the flavor is a param there).
    pub session_type: Option<String>,
    /// terminal target CLI mode (validated against the registered specs).
    pub mode: Option<String>,
    pub cwd: Option<String>,
    pub tab_id: Option<String>,
    pub pane_id: Option<String>,
    pub observed_epoch: Option<u64>,
    pub observed_generation: Option<u64>,
    pub device_id: Option<String>,
}

/// The lanes' `kill_for_handoff` answer. The reap TIMEOUT itself is the
/// runner's concern (it bounds the whole kill future with
/// [`SessionHandoffRunner::reap_timeout_ms`]) — the lanes answer only what
/// they directly observed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StopResult {
    /// The runtime is confirmed gone (awaited watcher/teardown).
    Reaped,
    /// There was no live runtime under this id (idempotent stop).
    AlreadyGone,
}

/// Why a prior runtime's stop could not be confirmed reaped.
enum StopOutcomePriv {
    /// The runtime is confirmed gone (awaited reap, or it never existed).
    Reaped,
    /// The exit was not observed within the handoff's reap timeout. This
    /// proves ONLY that — liveness is re-probed separately (round-2 review).
    ReapTimeout,
}

/// The server-wide atomic handoff runner. Minted in `freshell-server::main`
/// with the SAME fresh states, registry, coordinator, broadcast bus, and CLI
/// specs every other lane holds.
pub struct SessionHandoffRunner {
    auth_token: Arc<String>,
    broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    ownership: Arc<RuntimeOwnershipRegistry>,
    registry: freshell_terminal::TerminalRegistry,
    fresh_codex: crate::FreshCodexState,
    fresh_claude: crate::FreshClaudeState,
    /// The opencode lane (its sessions map + the shared serve handle).
    fresh_opencode: crate::FreshOpencodeState,
    /// The REST surface's fully-wired state — the terminal target spawn
    /// pipeline (`terminal_tabs::spawn_terminal_pane_with_handoff`) needs its
    /// registry/CLI-spec wiring.
    fresh_agent: crate::FreshAgentState,
    cli_commands: Arc<Vec<freshell_platform::CliCommandSpec>>,
    reap_timeout_ms: u64,
    test_hooks: Option<Arc<HandoffTestHooks>>,
}

impl SessionHandoffRunner {
    #[allow(clippy::too_many_arguments)] // the main.rs mint; mirrors the other state wirings
    pub fn new(
        auth_token: Arc<String>,
        broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
        ownership: Arc<RuntimeOwnershipRegistry>,
        registry: freshell_terminal::TerminalRegistry,
        fresh_codex: crate::FreshCodexState,
        fresh_claude: crate::FreshClaudeState,
        fresh_opencode: crate::FreshOpencodeState,
        fresh_agent: crate::FreshAgentState,
        cli_commands: Arc<Vec<freshell_platform::CliCommandSpec>>,
    ) -> Self {
        Self {
            auth_token,
            broadcast_tx,
            ownership,
            registry,
            fresh_codex,
            fresh_claude,
            fresh_opencode,
            fresh_agent,
            cli_commands,
            reap_timeout_ms: 10_000,
            test_hooks: None,
        }
    }

    pub fn with_reap_timeout_ms(mut self, ms: u64) -> Self {
        self.reap_timeout_ms = ms;
        self
    }

    pub fn with_test_hooks(mut self, hooks: Arc<HandoffTestHooks>) -> Self {
        self.test_hooks = Some(hooks);
        self
    }

    /// Spawn the DETACHED handoff. Returns a CANCELLATION-CAPABLE handle:
    /// `completion` is the HTTP reply channel (dropping it never cancels the
    /// operation — a disconnected client cannot half-orphan it);
    /// `task` is the detached JoinHandle — `abort()` cancels deterministically
    /// (the RAII guard then fails the coordinator entry and reaps an
    /// uncommitted target runtime).
    pub fn spawn_handoff(self: &Arc<Self>, req: HandoffRequest) -> HandoffHandle {
        let (tx, rx) = oneshot::channel();
        let runner = Arc::clone(self);
        let task = tokio::spawn(async move {
            let result = runner.run(req).await;
            // Err (dropped receiver) is fine: the operation is detached.
            let _ = tx.send(result);
        });
        HandoffHandle {
            completion: rx,
            task,
        }
    }

    /// The atomic sequence. See the module doc; every failure branch is a
    /// typed, retryable JSON body and leaves the coordinator in a coherent
    /// state (restored prior, or Vacant — never a stranded Handoff).
    async fn run(self: &Arc<Self>, req: HandoffRequest) -> Value {
        let operation_id = format!("handoff-{}", uuid::Uuid::new_v4());
        let initiator = req.device_id.clone().unwrap_or_else(|| "rest".into());
        let began = std::time::Instant::now();
        // 1. Atomically enter Handoff (+generation). The fence pair is
        // (epoch, generation) — a pre-restart pair is always stale; a half
        // pair is not a fence; neither-sent is legacy-unfenced.
        let observed = match (req.observed_epoch, req.observed_generation) {
            (Some(epoch), Some(generation)) => Some(ObservedFence { epoch, generation }),
            _ => None,
        };
        let entered = self.ownership.begin_handoff(
            &req.provider,
            &req.session_id,
            req.target_kind,
            &operation_id,
            observed,
            &initiator,
            now_ms(),
        );
        let generation = match entered {
            BeginOutcome::Granted { generation } => generation,
            BeginOutcome::StaleGeneration {
                current_generation, ..
            } => {
                return typed_failure(
                    "STALE_GENERATION",
                    "observed ownership fence is stale; refresh and retry",
                    false,
                    current_generation,
                )
            }
            // `begin_handoff` grants from Vacant AND from Live of any kind, so
            // AdoptLive/OwnedByOtherKind are unreachable arms — mapped to the
            // same typed, retryable in-flight answer rather than unwrapped.
            BeginOutcome::Blocked { .. }
            | BeginOutcome::AdoptLive { .. }
            | BeginOutcome::OwnedByOtherKind { .. } => {
                let generation = self
                    .ownership
                    .observe(&req.provider, &req.session_id)
                    .generation;
                return typed_failure(
                    "HANDOFF_IN_PROGRESS",
                    "a lifecycle operation is in flight; retry after it settles",
                    true,
                    generation,
                );
            }
        };
        let mut guard = HandoffGuard {
            runner: Arc::clone(self),
            provider: req.provider.clone(),
            session_id: req.session_id.clone(),
            operation_id: operation_id.clone(),
            generation,
            // Flipped false once the awaited reap confirms the prior died; set
            // from the POSITIVE re-probe on a reap timeout (round-2 review).
            prior_still_live: true,
            target_runtime: None,
            disarmed: false,
        };
        // The prior owner captured at enter (the stop/restore source).
        let prior = self
            .ownership
            .observe(&req.provider, &req.session_id)
            .state
            .prior_owner();
        let prior_kind = prior.as_ref().map(|(owner, _)| owner.kind);
        // 2. Broadcast the transition (all devices stop old-kind scheduling).
        // Every frame carries the boot epoch; the started frame's
        // previousKind is the prior owner's kind (round-2 review).
        self.broadcast_owner(
            &req,
            "handoff-started",
            Some(req.target_kind),
            None,
            &operation_id,
            generation,
            prior_kind,
            None,
        );
        if let Some(hooks) = self.test_hooks.as_ref() {
            if let Some(pause) = hooks.pause_after_enter.as_ref() {
                let _ = pause.notified().await;
            }
        }
        // 3+4. Stop the prior runtime and await confirmed reap (bounded).
        // Exit-watcher events arriving DURING Handoff are folded HERE:
        // `release` is fenced to a no-op in Handoff state (Task 1), so this
        // awaited kill/reap is the single fold point.
        if let Some((owner, _)) = prior.as_ref() {
            match self.stop_runtime(&req, owner, &initiator).await {
                StopOutcomePriv::Reaped => {
                    guard.prior_still_live = false; // the runner folded the exit event
                    if let Some(hooks) = self.test_hooks.as_ref() {
                        hooks.record("Reaped");
                    }
                }
                StopOutcomePriv::ReapTimeout => {
                    // Round-2 review: a reap timeout proves ONLY that the exit
                    // was not observed in time — it does NOT imply the prior
                    // runtime is still live. POSITIVE re-probe before any
                    // restore: confirmed live -> restore (its fenced exit
                    // watcher releases the key once it actually dies — no
                    // permanent wedge); unconfirmable -> end Vacant with the
                    // typed REAP_TIMEOUT (retryable, recoverable — never
                    // record a dead runtime as Live).
                    let prior_live = self.probe_prior_live(&req, owner).await;
                    guard.prior_still_live = prior_live;
                    let _ = guard.disarm_and_fail();
                    // Failure-broadcast truth (round-2 review): the frame
                    // carries the ACTUAL resulting state — the restored prior
                    // owner with its kind/runtime identity, or Vacant — plus
                    // previousKind and the typed reason.
                    self.broadcast_failure_truth(
                        &req,
                        &operation_id,
                        generation,
                        prior_kind,
                        "REAP_TIMEOUT",
                    );
                    let outcome = if prior_live {
                        "reap_timeout_restored_prior"
                    } else {
                        "reap_timeout_vacant"
                    };
                    self.log_transition(
                        TransitionLog {
                            operation_id: &operation_id,
                            provider: &req.provider,
                            session_id: &req.session_id,
                            initiator: &initiator,
                            epoch: self.ownership.boot_epoch(),
                            generation,
                            live_session_key: owner.live_session_key.as_deref(),
                            from_kind: prior_kind,
                            to_kind: Some(req.target_kind),
                            runtime_id: owner.terminal_id.as_deref(),
                            pid: owner.pid,
                            outcome,
                            duration_ms: began.elapsed().as_millis() as u64,
                            failure_reason: Some("REAP_TIMEOUT"),
                            stale: None,
                        },
                        "ownership.handoff.done",
                        TransitionLevel::Warn,
                    );
                    let detail = if prior_live {
                        "prior runtime re-probed live and restored; retry after it exits"
                    } else {
                        "prior runtime unconfirmable after reap timeout; session left Vacant — retry to reopen"
                    };
                    return typed_failure("REAP_TIMEOUT", detail, true, generation);
                }
            }
        }
        // 5. Start/attach the target UNDER the handoff's ticket (single
        // commit authority — the target paths skip their own commit and
        // surface the identity; THIS runner performs the one commit_live).
        if let Some(hooks) = self.test_hooks.as_ref() {
            if hooks
                .fail_target_spawn_once
                .swap(false, std::sync::atomic::Ordering::SeqCst)
            {
                // The prior was reaped: the key must end Vacant, NOT restore
                // the dead prior (round-1 review).
                let _ = guard.disarm_and_fail();
                self.broadcast_failure_truth(
                    &req,
                    &operation_id,
                    generation,
                    prior_kind,
                    "TARGET_SPAWN_FAILED",
                );
                self.log_transition(
                    TransitionLog {
                        operation_id: &operation_id,
                        provider: &req.provider,
                        session_id: &req.session_id,
                        initiator: &initiator,
                        epoch: self.ownership.boot_epoch(),
                        generation,
                        live_session_key: None,
                        from_kind: prior_kind,
                        to_kind: Some(req.target_kind),
                        runtime_id: None,
                        pid: None,
                        outcome: "target_spawn_failed",
                        duration_ms: began.elapsed().as_millis() as u64,
                        failure_reason: Some("TARGET_SPAWN_FAILED"),
                        stale: None,
                    },
                    "ownership.handoff.done",
                    TransitionLevel::Warn,
                );
                return typed_failure(
                    "TARGET_SPAWN_FAILED",
                    "target runtime failed to start (session id preserved)",
                    true,
                    generation,
                );
            }
        }
        match self.start_target(&req, &operation_id, generation).await {
            Ok(owner) => {
                // The cancellation-safety window: a spawned-but-uncommitted
                // target is reaped by the guard if the runner is aborted
                // before the commit (round-1 review).
                guard.target_runtime = Some(owner.clone());
                // 6. THE single commit Live(targetKind) + broadcast owner
                // identity.
                match self.ownership.commit_live(
                    &req.provider,
                    &req.session_id,
                    &operation_id,
                    generation,
                    owner.clone(),
                ) {
                    CommitOutcome::Committed => {
                        guard.disarm();
                        // Retain the lane stamp for a FRESH target so the
                        // lane's later kill/exit-watcher paths keep working
                        // (the stamp matches the just-committed Live record
                        // exactly — same operation id, generation, runtime).
                        if owner.kind == RuntimeOwnerKind::FreshAgent {
                            self.retain_fresh_target_stamp(&req, &operation_id, generation, &owner);
                        }
                        self.broadcast_owner(
                            &req,
                            "handoff-committed",
                            Some(owner.kind),
                            owner.terminal_id.clone(),
                            &operation_id,
                            generation,
                            prior_kind,
                            None,
                        );
                        self.log_transition(
                            TransitionLog {
                                operation_id: &operation_id,
                                provider: &req.provider,
                                session_id: &req.session_id,
                                initiator: &initiator,
                                epoch: self.ownership.boot_epoch(),
                                generation,
                                live_session_key: owner.live_session_key.as_deref(),
                                from_kind: prior_kind,
                                to_kind: Some(owner.kind),
                                runtime_id: owner.terminal_id.as_deref(),
                                pid: owner.pid,
                                outcome: "committed",
                                duration_ms: began.elapsed().as_millis() as u64,
                                failure_reason: None,
                                stale: None,
                            },
                            "ownership.handoff.done",
                            TransitionLevel::Info,
                        );
                        json!({
                            "ok": true,
                            "operationId": operation_id,
                            "generation": generation,
                            "owner": owner_json(&owner, &req),
                        })
                    }
                    // A stale/foreign commit (the ownership moved mid-handoff)
                    // must REAP the uncommitted target runtime — it has no
                    // owner record — then fail typed (round-1 review).
                    stale @ (CommitOutcome::StaleGeneration { .. }
                    | CommitOutcome::ForeignOperation) => {
                        self.reap_uncommitted_target(&req, &owner).await;
                        let _ = guard.disarm_and_fail();
                        self.broadcast_failure_truth(
                            &req,
                            &operation_id,
                            generation,
                            prior_kind,
                            "STALE_GENERATION",
                        );
                        let current = self
                            .ownership
                            .observe(&req.provider, &req.session_id)
                            .generation;
                        self.log_transition(
                            TransitionLog {
                                operation_id: &operation_id,
                                provider: &req.provider,
                                session_id: &req.session_id,
                                initiator: &initiator,
                                epoch: self.ownership.boot_epoch(),
                                generation,
                                live_session_key: owner.live_session_key.as_deref(),
                                from_kind: prior_kind,
                                to_kind: Some(owner.kind),
                                runtime_id: owner.terminal_id.as_deref(),
                                pid: owner.pid,
                                outcome: "stale_commit_reaped_target",
                                duration_ms: began.elapsed().as_millis() as u64,
                                failure_reason: Some("STALE_GENERATION"),
                                stale: Some(&stale),
                            },
                            "ownership.handoff.done",
                            TransitionLevel::Error,
                        );
                        typed_failure(
                            "STALE_GENERATION",
                            "ownership moved during handoff; the uncommitted target was reaped",
                            false,
                            current,
                        )
                    }
                }
            }
            Err((code, detail)) => {
                // 7. Typed recoverable state — the prior was reaped, so the
                // key ends Vacant (never restore a dead runtime as Live).
                let _ = guard.disarm_and_fail();
                self.broadcast_failure_truth(
                    &req,
                    &operation_id,
                    generation,
                    prior_kind,
                    "TARGET_SPAWN_FAILED",
                );
                self.log_transition(
                    TransitionLog {
                        operation_id: &operation_id,
                        provider: &req.provider,
                        session_id: &req.session_id,
                        initiator: &initiator,
                        epoch: self.ownership.boot_epoch(),
                        generation,
                        live_session_key: None,
                        from_kind: prior_kind,
                        to_kind: Some(req.target_kind),
                        runtime_id: None,
                        pid: None,
                        outcome: "target_spawn_failed",
                        duration_ms: began.elapsed().as_millis() as u64,
                        failure_reason: Some(&code),
                        stale: None,
                    },
                    "ownership.handoff.done",
                    TransitionLevel::Warn,
                );
                typed_failure("TARGET_SPAWN_FAILED", &detail, true, generation)
            }
        }
    }

    /// Round-2 review: a POSITIVE liveness re-probe of the prior runtime (a
    /// reap timeout does NOT imply liveness). Terminal priors: the registry
    /// row's Running status (the same join `live_session_owner` uses); fresh
    /// priors: the lane's `has_live_session` probe (the same probe the D7
    /// guard uses).
    async fn probe_prior_live(&self, req: &HandoffRequest, owner: &OwnerIdentity) -> bool {
        match owner.kind {
            RuntimeOwnerKind::Terminal => owner
                .terminal_id
                .as_deref()
                .map(|tid| {
                    self.registry.probe(tid).is_some_and(|row| {
                        row.status == freshell_protocol::TerminalRunStatus::Running
                    })
                })
                .unwrap_or(false),
            RuntimeOwnerKind::FreshAgent => match req.provider.as_str() {
                "codex" => self.fresh_codex.has_live_session(&req.session_id).await,
                "claude" => self.fresh_claude.has_live_session(&req.session_id).await,
                "opencode" => self.fresh_opencode.has_live_session(&req.session_id).await,
                _ => false,
            },
        }
    }

    /// Round-2 review (failure-broadcast truth): AFTER `disarm_and_fail`,
    /// observe the ACTUAL resulting state and broadcast it — the restored
    /// prior owner with its kind/runtime identity, or Vacant — plus
    /// previousKind and the typed reason. Remote panes converge on the owner
    /// that really exists, never the requested target, and the
    /// same-generation corrective frame supersedes the handoff-started
    /// transition record on every device (the client fold never drops it —
    /// Task 8).
    fn broadcast_failure_truth(
        &self,
        req: &HandoffRequest,
        operation_id: &str,
        generation: u64,
        previous_kind: Option<RuntimeOwnerKind>,
        reason: &str,
    ) {
        let snap = self.ownership.observe(&req.provider, &req.session_id);
        let (owner_kind, terminal_id) = match snap.state {
            freshell_ownership::OwnershipState::Live { ref owner, .. } => {
                (Some(owner.kind), owner.terminal_id.clone())
            }
            _ => (None, None), // Vacant (or a foreign record): broadcast vacant
        };
        self.broadcast_owner(
            req,
            "handoff-failed",
            owner_kind,
            terminal_id,
            operation_id,
            generation,
            previous_kind,
            Some(reason),
        );
    }

    /// Round-1 review: reap a target runtime whose commit was refused
    /// (stale/foreign) — no owner record points at it, so leaving it running
    /// would be an untracked second writer. Terminal targets: registry kill
    /// (the immediate SIGKILL-and-reap) + confirmed death. Fresh targets:
    /// the same lane teardown the prior stop uses.
    async fn reap_uncommitted_target(&self, req: &HandoffRequest, owner: &OwnerIdentity) {
        match owner.kind {
            RuntimeOwnerKind::Terminal => {
                if let Some(terminal_id) = owner.terminal_id.as_deref() {
                    if self.registry.kill(terminal_id) {
                        let _ = tokio::time::timeout(
                            std::time::Duration::from_millis(self.reap_timeout_ms),
                            await_terminal_dead(&self.registry, terminal_id),
                        )
                        .await;
                    }
                }
            }
            RuntimeOwnerKind::FreshAgent => {
                let _ = self
                    .stop_runtime(req, owner, "handoff-runner-stale-commit")
                    .await;
            }
        }
    }

    /// Stop the prior runtime and await the CONFIRMED reap (bounded by
    /// `reap_timeout_ms`). Terminal priors: the registry group-kill +
    /// dead-poll (the `kill_session_ref_holder_and_confirm` discipline);
    /// fresh priors: the lane's `kill_for_handoff` teardown (never the shared
    /// opencode serve). `force_reap_timeout` (test hook) short-circuits
    /// BEFORE any kill is issued.
    async fn stop_runtime(
        &self,
        req: &HandoffRequest,
        owner: &OwnerIdentity,
        initiator: &str,
    ) -> StopOutcomePriv {
        if let Some(hooks) = self.test_hooks.as_ref() {
            if hooks
                .force_reap_timeout
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return StopOutcomePriv::ReapTimeout;
            }
        }
        let budget = std::time::Duration::from_millis(self.reap_timeout_ms);
        match owner.kind {
            RuntimeOwnerKind::Terminal => {
                let Some(terminal_id) = owner.terminal_id.as_deref() else {
                    return StopOutcomePriv::Reaped; // no runtime identity: nothing to stop
                };
                if !self.registry.kill(terminal_id) {
                    // Already gone (killed/exited elsewhere): the row is dead.
                    return StopOutcomePriv::Reaped;
                }
                match tokio::time::timeout(budget, await_terminal_dead(&self.registry, terminal_id))
                    .await
                {
                    Ok(()) => StopOutcomePriv::Reaped,
                    Err(_) => StopOutcomePriv::ReapTimeout,
                }
            }
            RuntimeOwnerKind::FreshAgent => {
                let kill: std::pin::Pin<Box<dyn std::future::Future<Output = StopResult> + Send>> =
                    match req.provider.as_str() {
                        "codex" => Box::pin(
                            self.fresh_codex
                                .kill_for_handoff(&req.session_id, initiator),
                        ),
                        "claude" => Box::pin(
                            self.fresh_claude
                                .kill_for_handoff(&req.session_id, initiator),
                        ),
                        "opencode" => Box::pin(
                            self.fresh_opencode
                                .opencode_kill_for_handoff(&req.session_id, initiator),
                        ),
                        _ => return StopOutcomePriv::Reaped,
                    };
                match tokio::time::timeout(budget, kill).await {
                    // The lane teardown awaited its own watcher — the confirmed
                    // reap. AlreadyGone is the same truth (nothing to stop).
                    Ok(StopResult::Reaped | StopResult::AlreadyGone) => StopOutcomePriv::Reaped,
                    // The bounded kill future itself did not finish in time.
                    Err(_) => StopOutcomePriv::ReapTimeout,
                }
            }
        }
    }

    /// Start/attach the target UNDER-TICKET — the target paths skip their own
    /// coordinator commit (Tasks 3/4 under-ticket mode) and return the
    /// `OwnerIdentity`; THIS runner performs the single `commit_live`.
    /// Session-ID preservation (round-1 review scope): a returned runtime
    /// that does not serve the canonical `(provider, req.session_id)` is a
    /// `TARGET_SPAWN_FAILED` — never accept a respawned-new-thread runtime
    /// as handoff success, never mint a new session id.
    async fn start_target(
        &self,
        req: &HandoffRequest,
        operation_id: &str,
        generation: u64,
    ) -> Result<OwnerIdentity, (String, String)> {
        match req.target_kind {
            RuntimeOwnerKind::Terminal => {
                let mode = req.mode.clone().unwrap_or_else(|| req.provider.clone());
                let body = json!({
                    "mode": mode,
                    "cwd": req.cwd,
                    "sessionRef": { "provider": req.provider, "sessionId": req.session_id },
                });
                let tab_id = req
                    .tab_id
                    .clone()
                    .unwrap_or_else(|| format!("handoff-tab-{}", uuid::Uuid::new_v4()));
                let pane_id = req
                    .pane_id
                    .clone()
                    .unwrap_or_else(|| format!("handoff-pane-{}", uuid::Uuid::new_v4()));
                let token = crate::terminal_tabs::HandoffToken {
                    operation_id: operation_id.to_string(),
                    generation,
                };
                let spawned = crate::terminal_tabs::spawn_terminal_pane_with_handoff(
                    &self.fresh_agent,
                    &body,
                    &tab_id,
                    &pane_id,
                    Some(&token),
                )
                .await
                .map_err(|resp| ("terminal spawn failed".to_string(), format!("{resp:?}")))?;
                // Session-ID preservation: the spawned pane must carry the
                // canonical sessionRef — a gate-fired mint (a stale resume
                // id healed into a fresh one) is a handoff FAILURE, never a
                // silently-blank new session.
                let echoed = spawned
                    .pane_content
                    .get("sessionRef")
                    .and_then(|v| v.get("sessionId"))
                    .and_then(Value::as_str);
                if echoed != Some(req.session_id.as_str()) {
                    let _ = self.registry.kill(&spawned.terminal_id);
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_millis(self.reap_timeout_ms),
                        await_terminal_dead(&self.registry, &spawned.terminal_id),
                    )
                    .await;
                    return Err((
                        "terminal spawn did not preserve the session id".to_string(),
                        format!("expected sessionRef {}, got {:?}", req.session_id, echoed),
                    ));
                }
                let owner = spawned.owner_identity.unwrap_or_else(|| OwnerIdentity {
                    kind: RuntimeOwnerKind::Terminal,
                    terminal_id: Some(spawned.terminal_id.clone()),
                    live_session_key: None,
                    pid: self.registry.pid_of(&spawned.terminal_id),
                    ownership_id: None,
                });
                if let Some(hooks) = self.test_hooks.as_ref() {
                    hooks.record("TargetStarted");
                }
                Ok(owner)
            }
            RuntimeOwnerKind::FreshAgent => match req.session_type.as_deref() {
                Some("freshcodex") | None => {
                    self.fresh_codex
                        .resume_for_handoff(
                            &req.session_id,
                            req.cwd.as_deref(),
                            operation_id,
                            generation,
                        )
                        .await
                }
                Some("freshopencode") => {
                    self.fresh_opencode
                        .opencode_resume_for_handoff(
                            &req.session_id,
                            req.cwd.as_deref(),
                            operation_id,
                            generation,
                        )
                        .await
                }
                // Round-2 review: BOTH claude-lane flavors — the flavor is a
                // param (claude.rs), so a kilroy session resumes as kilroy
                // (the created/owner frames keep the flavor) and a freshclaude
                // session as freshclaude. Never map by provider alone.
                Some("freshclaude") => {
                    self.fresh_claude
                        .resume_for_handoff(
                            "freshclaude",
                            &req.session_id,
                            req.cwd.as_deref(),
                            operation_id,
                            generation,
                        )
                        .await
                }
                Some("kilroy") => {
                    self.fresh_claude
                        .resume_for_handoff(
                            "kilroy",
                            &req.session_id,
                            req.cwd.as_deref(),
                            operation_id,
                            generation,
                        )
                        .await
                }
                Some(other) => Err(("unsupported sessionType".to_string(), other.to_string())),
            },
        }
    }

    /// Retain the fresh target's lane stamp after the runner's `commit_live`
    /// (single commit authority): the stamp the lane's later kill/exit-watcher
    /// paths build their fenced claims from, matching the committed Live
    /// record exactly (same operation id, generation, runtime identity).
    fn retain_fresh_target_stamp(
        &self,
        req: &HandoffRequest,
        operation_id: &str,
        generation: u64,
        owner: &OwnerIdentity,
    ) {
        let mut stamped = owner.clone();
        if stamped.ownership_id.is_none() {
            stamped.ownership_id = Some(operation_id.to_string());
        }
        let stamp = crate::ownership_lane::OwnershipStamp {
            epoch: self.ownership.boot_epoch(),
            generation,
            operation_id: operation_id.to_string(),
            owner: stamped,
        };
        let stamps = match req.provider.as_str() {
            "codex" => &self.fresh_codex.ownership_stamps,
            "claude" => &self.fresh_claude.ownership_stamps,
            _ => &self.fresh_opencode.fresh_agent().ownership_stamps,
        };
        stamps
            .lock()
            .expect("ownership stamps lock")
            .insert(req.session_id.clone(), stamp);
    }

    /// Every frame carries the boot epoch, `previousKind` (the transition's
    /// from-kind when one exists), and — on failure frames — the typed
    /// `reason`. `owner_kind: None` broadcasts "vacant".
    #[allow(clippy::too_many_arguments)] // the uniform broadcast field set (round-2 review)
    fn broadcast_owner(
        &self,
        req: &HandoffRequest,
        transition: &str,
        owner_kind: Option<RuntimeOwnerKind>,
        terminal_id: Option<String>,
        operation_id: &str,
        generation: u64,
        previous_kind: Option<RuntimeOwnerKind>,
        reason: Option<&str>,
    ) {
        let frame = serde_json::to_string(&freshell_protocol::ServerMessage::SessionRuntimeOwner(
            freshell_protocol::SessionRuntimeOwner {
                provider: req.provider.clone(),
                session_id: req.session_id.clone(),
                epoch: self.ownership.boot_epoch(),
                generation,
                owner_kind: match owner_kind {
                    Some(RuntimeOwnerKind::Terminal) => "terminal".into(),
                    Some(RuntimeOwnerKind::FreshAgent) => "fresh-agent".into(),
                    None => "vacant".into(),
                },
                previous_kind: previous_kind.map(|k| match k {
                    RuntimeOwnerKind::Terminal => "terminal".to_string(),
                    RuntimeOwnerKind::FreshAgent => "fresh-agent".to_string(),
                }),
                terminal_id,
                operation_id: operation_id.to_string(),
                transition: transition.to_string(),
                reason: reason.map(str::to_string),
            },
        ))
        .unwrap_or_default();
        let _ = self.broadcast_tx.send(frame);
    }

    /// The Step-5 refactor: one emission point so every
    /// `ownership.handoff.done` outcome line carries the same full field set
    /// (operation id, provider/session id, generation, kinds, runtime id/pid,
    /// initiator, duration, outcome, typed failure reason).
    fn log_transition(&self, log: TransitionLog<'_>, event: &'static str, level: TransitionLevel) {
        log.emit(event, level);
    }
}

/// The uniform `ownership.handoff.done` field set (the Step-5 refactor's
/// single source): every outcome line is built through this struct so the
/// join-critical fields can never drift between branches.
struct TransitionLog<'a> {
    operation_id: &'a str,
    provider: &'a str,
    session_id: &'a str,
    initiator: &'a str,
    epoch: u64,
    generation: u64,
    live_session_key: Option<&'a str>,
    from_kind: Option<RuntimeOwnerKind>,
    to_kind: Option<RuntimeOwnerKind>,
    runtime_id: Option<&'a str>,
    pid: Option<u32>,
    outcome: &'a str,
    duration_ms: u64,
    failure_reason: Option<&'a str>,
    stale: Option<&'a CommitOutcome>,
}

/// The emission level for [`TransitionLog`] (committed is info; recoverable
/// failures warn; contract violations — a stale commit — error).
enum TransitionLevel {
    Info,
    Warn,
    Error,
}

impl TransitionLog<'_> {
    /// Emit the event with the uniform field set on the crate's stable
    /// ownership target (event fields, never span fields).
    fn emit(self, event: &'static str, level: TransitionLevel) {
        // Every arm carries the IDENTICAL field set (plus failure_reason on
        // the failure arms) — the observability contract's requirement.
        match level {
            TransitionLevel::Error => tracing::error!(
                target: "freshell_ownership",
                event,
                operation_id = self.operation_id,
                provider = self.provider,
                session_id = self.session_id,
                initiator = self.initiator,
                epoch = self.epoch,
                generation = self.generation,
                live_session_key = ?self.live_session_key,
                from_kind = ?self.from_kind,
                to_kind = ?self.to_kind,
                runtime_id = ?self.runtime_id,
                pid = ?self.pid,
                outcome = self.outcome,
                duration_ms = self.duration_ms,
                failure_reason = self.failure_reason.unwrap_or(""),
                stale = ?self.stale,
                "handoff terminal transition"
            ),
            TransitionLevel::Warn => tracing::warn!(
                target: "freshell_ownership",
                event,
                operation_id = self.operation_id,
                provider = self.provider,
                session_id = self.session_id,
                initiator = self.initiator,
                epoch = self.epoch,
                generation = self.generation,
                live_session_key = ?self.live_session_key,
                from_kind = ?self.from_kind,
                to_kind = ?self.to_kind,
                runtime_id = ?self.runtime_id,
                pid = ?self.pid,
                outcome = self.outcome,
                duration_ms = self.duration_ms,
                failure_reason = self.failure_reason.unwrap_or(""),
                stale = ?self.stale,
                "handoff terminal transition"
            ),
            TransitionLevel::Info => tracing::info!(
                target: "freshell_ownership",
                event,
                operation_id = self.operation_id,
                provider = self.provider,
                session_id = self.session_id,
                initiator = self.initiator,
                epoch = self.epoch,
                generation = self.generation,
                live_session_key = ?self.live_session_key,
                from_kind = ?self.from_kind,
                to_kind = ?self.to_kind,
                runtime_id = ?self.runtime_id,
                pid = ?self.pid,
                outcome = self.outcome,
                duration_ms = self.duration_ms,
                failure_reason = self.failure_reason.unwrap_or(""),
                "handoff terminal transition"
            ),
        }
    }
}

/// Poll the registry's sync dead-probe at the 25ms cadence until the row is
/// gone or no longer Running (the tokio-free registry keeps the predicate
/// sync; the awaitable loop lives here).
async fn await_terminal_dead(registry: &freshell_terminal::TerminalRegistry, terminal_id: &str) {
    while !registry.terminal_is_dead(terminal_id) {
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

/// RAII: fail the coordinator entry if the handoff task is cancelled or
/// panics before commit (armed + not disarmed => fail on Drop) — the
/// `FreshSessionLeaseGuard` drop-discipline precedent. Round-1 review: the
/// guard TRACKS whether the prior runtime is still live — the runner sets
/// `prior_still_live = false` once its awaited kill/reap confirms the prior's
/// death (the runner folds exit-watcher events; they are no-ops in Handoff
/// state by Task 1's fence). `fail` restores the prior ONLY when
/// `prior_still_live` is true; otherwise the key ends Vacant — never a dead
/// runtime recorded as Live. On a reap TIMEOUT the runner does NOT assume
/// liveness either way — it sets `prior_still_live` from the POSITIVE
/// re-probe before failing, and an exit watcher arriving after the boundary
/// still releases/repairs the key (a restored prior is a normal Live
/// record; its fenced watcher fires on the real exit — no permanent wedge).
/// `target_runtime`: a spawned-but-uncommitted target runtime is REAPED on
/// Drop (the cancellation-safety window between spawn and commit).
struct HandoffGuard {
    runner: Arc<SessionHandoffRunner>,
    provider: String,
    session_id: String,
    operation_id: String,
    generation: u64,
    prior_still_live: bool,
    target_runtime: Option<OwnerIdentity>,
    disarmed: bool,
}

impl HandoffGuard {
    fn disarm(&mut self) {
        self.disarmed = true;
    }

    fn disarm_and_fail(&mut self) -> FailOutcome {
        self.disarmed = true;
        self.runner.ownership.fail(
            &self.provider,
            &self.session_id,
            &self.operation_id,
            self.generation,
            self.prior_still_live,
        )
    }
}

impl Drop for HandoffGuard {
    fn drop(&mut self) {
        if self.disarmed {
            return;
        }
        let _ = self.disarm_and_fail();
        // Cancellation/panic mid-flight: a spawned-but-uncommitted target
        // runtime has no owner record — reap it on a detached task (Drop is
        // sync; the lanes' teardowns are async). The fresh lanes' teardown
        // and the registry kill are both idempotent, so racing an explicit
        // reap is harmless. `Handle::try_current` guards the shutdown edge:
        // during runtime teardown the drop runs with no reactor — nothing
        // can be spawned (the OS reaps the children with the process).
        if let Some(target) = self.target_runtime.take() {
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                let runner = Arc::clone(&self.runner);
                let provider = self.provider.clone();
                let session_id = self.session_id.clone();
                handle.spawn(async move {
                    let req = HandoffRequest {
                        provider,
                        session_id,
                        target_kind: target.kind,
                        session_type: None,
                        mode: None,
                        cwd: None,
                        tab_id: None,
                        pane_id: None,
                        observed_epoch: None,
                        observed_generation: None,
                        device_id: Some("handoff-guard-cleanup".into()),
                    };
                    runner.reap_uncommitted_target(&req, &target).await;
                });
            }
        }
    }
}

/// The cancellation-capable spawn handle. `completion` is the HTTP reply
/// channel (dropping it never cancels the operation); `task` is the detached
/// JoinHandle — `abort()` cancels deterministically (the HandoffGuard Drop
/// then fails the coordinator entry and reaps an uncommitted target).
pub struct HandoffHandle {
    pub completion: oneshot::Receiver<Value>,
    pub task: tokio::task::JoinHandle<()>,
}

impl HandoffHandle {
    pub fn abort(&self) {
        self.task.abort();
    }
}

fn typed_failure(code: &str, message: &str, retryable: bool, generation: u64) -> Value {
    json!({
        "ok": false,
        "error": {
            "code": code,
            "message": message,
            "retryable": retryable,
            "ownerGeneration": generation,
        }
    })
}

fn owner_json(owner: &OwnerIdentity, req: &HandoffRequest) -> Value {
    match owner.kind {
        RuntimeOwnerKind::Terminal => json!({
            "kind": "terminal",
            "terminalId": owner.terminal_id,
            "mode": req.mode.clone().unwrap_or_else(|| req.provider.clone()),
        }),
        RuntimeOwnerKind::FreshAgent => json!({
            "kind": "fresh-agent",
            "sessionId": req.session_id,
            "sessionType": req.session_type.clone().unwrap_or_else(|| "freshcodex".into()),
            "provider": req.provider,
        }),
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `POST /api/sessions/handoff` — mounted in `freshell-server::main` beside
/// the other REST routers. The handler validates, parses, and awaits the
/// detached task's oneshot with a bounded HTTP timeout (the operation
/// itself outlives the request; the endpoint keeps ONLY the completion
/// receiver — the exposed JoinHandle stays available to the runner's host).
pub fn handoff_router(runner: Arc<SessionHandoffRunner>) -> Router {
    Router::new()
        .route(HANDOFF_ROUTE, post(handoff_handler))
        .with_state(runner)
}

async fn handoff_handler(
    State(runner): State<Arc<SessionHandoffRunner>>,
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    if !crate::authorized(&headers, &runner.auth_token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "ok": false,
                "error": { "code": "BAD_REQUEST", "message": "unauthorized", "retryable": false }
            })),
        );
    }
    let Some(provider) = body
        .get("provider")
        .and_then(Value::as_str)
        .map(String::from)
    else {
        return typed_bad_request("body must carry a string `provider`");
    };
    let Some(session_id) = body
        .get("sessionId")
        .and_then(Value::as_str)
        .map(String::from)
    else {
        return typed_bad_request("body must carry a string `sessionId`");
    };
    let target_kind = match body.get("targetKind").and_then(Value::as_str) {
        Some("terminal") => RuntimeOwnerKind::Terminal,
        Some("fresh-agent") => RuntimeOwnerKind::FreshAgent,
        _ => {
            return typed_bad_request("targetKind must be \"terminal\" or \"fresh-agent\"");
        }
    };
    let session_type = body
        .get("sessionType")
        .and_then(Value::as_str)
        .map(String::from);
    if target_kind == RuntimeOwnerKind::FreshAgent {
        match session_type.as_deref() {
            Some("freshcodex" | "freshopencode" | "freshclaude" | "kilroy") | None => {}
            Some(other) => {
                return typed_bad_request(&format!(
                    "sessionType must be freshcodex | freshopencode | freshclaude | kilroy, got {other:?}"
                ));
            }
        }
    }
    let mode = body.get("mode").and_then(Value::as_str).map(String::from);
    if target_kind == RuntimeOwnerKind::Terminal {
        // A handoff's terminal target must be a REGISTERED session-bearing
        // CLI mode (never "shell" — a plain shell owns no canonical session).
        let mode_ref = mode.as_deref().unwrap_or(provider.as_str());
        if !runner.cli_commands.iter().any(|spec| spec.name == mode_ref) {
            return typed_bad_request(&format!(
                "unknown CLI mode {mode_ref:?} (a handoff terminal target must be a registered coding-CLI mode)"
            ));
        }
    }
    let req = HandoffRequest {
        provider,
        session_id,
        target_kind,
        session_type,
        mode,
        cwd: body.get("cwd").and_then(Value::as_str).map(String::from),
        tab_id: body.get("tabId").and_then(Value::as_str).map(String::from),
        pane_id: body.get("paneId").and_then(Value::as_str).map(String::from),
        observed_epoch: body.get("observedEpoch").and_then(Value::as_u64),
        observed_generation: body.get("observedGeneration").and_then(Value::as_u64),
        device_id: body
            .get("deviceId")
            .and_then(Value::as_str)
            .map(String::from),
    };
    // The reply rides the handle's oneshot with a bounded HTTP timeout; the
    // operation itself is detached and outlives the request.
    let handle = runner.spawn_handoff(req);
    let mut completion = handle.completion;
    match tokio::time::timeout(std::time::Duration::from_secs(30), &mut completion).await {
        Ok(Ok(value)) => {
            let ok = value.get("ok").and_then(Value::as_bool).unwrap_or(false);
            (
                if ok {
                    StatusCode::OK
                } else {
                    StatusCode::CONFLICT
                },
                Json(value),
            )
        }
        _ => (
            StatusCode::CONFLICT,
            Json(json!({
                "ok": false,
                "error": {
                    "code": "HANDOFF_IN_PROGRESS",
                    "message": "handoff still in flight; the operation continues server-side",
                    "retryable": true
                }
            })),
        ),
    }
}

fn typed_bad_request(message: &str) -> (StatusCode, Json<Value>) {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({
            "ok": false,
            "error": { "code": "BAD_REQUEST", "message": message, "retryable": false }
        })),
    )
}

#[cfg(test)]
mod tests;
