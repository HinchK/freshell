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
    /// Park the runner after the TERMINAL prior's registry kill is ISSUED but
    /// before the dead-poll confirms it (round-3 review I-1: the prior-reap
    /// window's abort-test hold; terminal arm only — the fresh arm's hold is
    /// the lane-side `handoff_kill_pause` seam on `FreshClaudeState`).
    pub pause_after_terminal_prior_kill: Option<tokio::sync::Notify>,
    /// Park the under-ticket terminal-target SETTLE after it publishes the
    /// spawned terminal (round-3 review I-1: the target-spawn window's
    /// abort-test hold). The runner embeds this into the `HandoffSpawnWatch`
    /// it hands the settle.
    pub pause_in_target_spawn: Option<std::sync::Arc<tokio::sync::Notify>>,
    /// The runner deposits the terminal-target spawn watch here at
    /// `start_target` entry, so a test can observe the settle's publication
    /// deterministically.
    pub spawn_watch_slot: std::sync::Mutex<Option<crate::terminal_tabs::HandoffSpawnWatch>>,
    /// Short-circuit `stop_runtime` to `ReapTimeout` WITHOUT issuing any
    /// kill — the deterministic reap-timeout test path (the prior stays
    /// exactly as alive as the test made it). Atomic so a test can clear it
    /// for the retry assertion.
    pub force_reap_timeout: std::sync::atomic::AtomicBool,
    /// b8ke focused review FR6: abort the detached reap-confirmation task
    /// at the NEXT watcher spawn — the injected REAL JoinError (cancelled)
    /// the watcher's fail-open typed release is tested against. Atomic so
    /// a test can arm it once.
    pub abort_reap_confirmation_once: std::sync::atomic::AtomicBool,
    /// Make the NEXT `start_target` fail before spawning anything.
    pub fail_target_spawn_once: std::sync::atomic::AtomicBool,
    /// Ordered step labels ("Reaped", "TargetStarted") — test assertions.
    pub events: std::sync::Mutex<Vec<&'static str>>,
}

impl Default for HandoffTestHooks {
    fn default() -> Self {
        Self {
            pause_after_enter: None,
            pause_after_terminal_prior_kill: None,
            pause_in_target_spawn: None,
            spawn_watch_slot: std::sync::Mutex::new(None),
            force_reap_timeout: std::sync::atomic::AtomicBool::new(false),
            abort_reap_confirmation_once: std::sync::atomic::AtomicBool::new(false),
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
pub(crate) enum StopResult {
    /// The runtime is confirmed gone (awaited watcher/teardown).
    Reaped,
    /// There was no live runtime under this id (idempotent stop).
    AlreadyGone,
    /// b8ke focused review FR3: the lane's bounded confirmation window
    /// expired with the runtime tree still alive — NEVER a reap, never a
    /// silent success. Carries the detached continuation that keeps
    /// escalating and resolves `true` only once death is finally
    /// confirmed; the runner fences the key (the F3 machinery), broadcasts
    /// the failure frame, and its watcher releases on this future. A lost
    /// continuation is covered by the watcher's typed fenced state +
    /// replacement probe (round-2 review R2-1).
    NotConfirmed {
        confirmation: std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + 'static>>,
    },
    /// b8ke focused round-2 review R2-3: a non-Linux teardown confirmed the
    /// direct child's awaited exit (the portable floor) but CANNOT verify
    /// the descendant tree (`/proc` is Linux-only) — the typed
    /// platform-limited stop answer. It must NEVER satisfy the handoff's
    /// confirmed-reap requirement: the runner fences the key with the typed
    /// [`freshell_ownership::FenceReason::PlatformLimited`] reason (a new
    /// writer cannot start; the session remains recoverable — the operator
    /// can still kill leftover processes by other means), the documented
    /// tradeoff being that nothing on that platform can confirm the
    /// descendant death, so the fence persists for the boot epoch.
    PlatformLimited,
}

impl std::fmt::Debug for StopResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StopResult::Reaped => f.write_str("Reaped"),
            StopResult::AlreadyGone => f.write_str("AlreadyGone"),
            StopResult::NotConfirmed { .. } => f.write_str("NotConfirmed { .. }"),
            StopResult::PlatformLimited => f.write_str("PlatformLimited"),
        }
    }
}

/// The detached reap watcher's answer (b8ke focused round-2 review):
/// `Confirmed` — the prior runtime's death was positively confirmed (the
/// lane teardown's own watcher, the registry dead-poll, or the replacement
/// probe); `PlatformLimited` — the teardown completed but its platform
/// cannot confirm the descendant tree (R2-3: fences, never releases);
/// `Lost` — the confirmation future itself failed (R2-1: fences with the
/// typed WatcherFailed reason and spawns the replacement probe).
pub(crate) enum ReapAnswer {
    Confirmed,
    PlatformLimited,
    Lost,
}

/// Why a prior runtime's stop could not be confirmed reaped.
enum StopOutcomePriv {
    /// The runtime is confirmed gone (awaited reap, or it never existed).
    Reaped,
    /// The exit was not observed within the handoff's reap timeout. This
    /// proves ONLY that — liveness is re-probed separately (round-2 review).
    ///
    /// b8ke delta review F3: `fenced` distinguishes the two shapes.
    /// `false` — the FORCE test hook short-circuited BEFORE any kill was
    /// issued (the prior is untouched): the round-2 re-probe semantics
    /// decide restore-vs-Vacant. `true` — a REAL timeout (or a lane's typed
    /// [`StopResult::NotConfirmed`], b8ke focused FR3): the kill WAS
    /// issued and its confirmation continues DETACHED (the teardown future
    /// was spawned, never dropped; a NotConfirmed lane carries its own
    /// escalation continuation); the key stays fenced in Handoff until
    /// the watcher confirms death — a probe that reads the lane's
    /// sessions map cannot see a map-evicted-but-alive runtime, so the
    /// probe must NOT decide anything here. b8ke focused FR5: this arm
    /// implies the `handoff-failed` frame was ALREADY broadcast by
    /// `stop_runtime`, strictly before the watcher existed — the caller
    /// never re-broadcasts it.
    ReapTimeout { fenced: bool },
    /// b8ke focused round-2 review R2-3: the lane answered
    /// [`StopResult::PlatformLimited`] — the child's awaited exit is the
    /// portable floor but the descendant tree is unverifiable on that
    /// platform. The caller fences the key with the typed PlatformLimited
    /// reason and answers the typed retryable failure; a new writer can
    /// never start against the unconfirmable prior.
    PlatformLimitedFenced,
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
        // b8ke delta review F5: the provider↔target validation — BEFORE the
        // coordinator enter, so a mismatched target never stops the prior
        // runtime or bumps the generation. The HTTP handler already refuses
        // mismatches with the typed 400 pre-spawn; this re-check covers
        // direct `spawn_handoff` callers with the same rule.
        if let Err(reason) = validate_handoff_target(
            &req.provider,
            req.target_kind,
            req.session_type.as_deref(),
            req.mode.as_deref(),
            &self.cli_commands,
        ) {
            let generation = self
                .ownership
                .observe(&req.provider, &req.session_id)
                .generation;
            tracing::warn!(target: "freshell_ownership",
                event = "ownership.handoff.refused_pre_stop",
                provider = %req.provider, session_id = %req.session_id,
                epoch = self.ownership.boot_epoch(), generation,
                outcome = "validation_failed", failure_reason = "BAD_REQUEST",
                "a mismatched handoff target was refused before any coordinator state change: {reason}");
            return typed_failure("BAD_REQUEST", &reason, false, generation);
        }
        // b8ke delta review F5: resolve an ABSENT sessionType to the
        // provider's canonical type when unambiguous (codex → freshcodex,
        // opencode → freshopencode), so the dispatch, the response, and
        // the owner frames all name the lane the request actually targets
        // — never a silent freshcodex default under a foreign provider's
        // key. (An ambiguous absent type — claude — was refused above.)
        let mut req = req;
        if req.target_kind == RuntimeOwnerKind::FreshAgent && req.session_type.is_none() {
            if let Some(canonical) =
                canonical_session_types(&req.provider).filter(|list| list.len() == 1)
            {
                req.session_type = Some(canonical[0].to_string());
            }
        }
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
            // b8ke focused round-3 review R3-4: the TYPED operator
            // recovery for a PlatformLimited fence. An explicit handoff
            // retry carrying a FRESH observed fence (the recovery UI's
            // Retry refreshes the pair from the runtime-owner record) is
            // the operator action that force-clears the fence — the
            // non-Linux semantics make it honest: the direct child's
            // awaited exit WAS confirmed; only the descendant verification
            // is platform-limited, and the force-clear records that
            // limitation. The DEFAULT path stays fenced (a fence-less
            // retry, any create/attach, a WatcherFailed fence whose
            // bounded probe can still confirm).
            BeginOutcome::Blocked {
                state:
                    freshell_ownership::OwnershipState::Fenced {
                        reason: freshell_ownership::FenceReason::PlatformLimited,
                        ..
                    },
                ..
            } if observed.is_some() => {
                let forced = self.ownership.force_release_platform_limited(
                    &req.provider,
                    &req.session_id,
                    observed.expect("the guarded arm carries the fence"),
                    &initiator,
                );
                match forced {
                    freshell_ownership::ForceReleaseOutcome::Released => {
                        tracing::info!(target: "freshell_ownership",
                            event = "ownership.handoff.force_cleared_platform_limited",
                            operation_id = %operation_id, provider = %req.provider, session_id = %req.session_id,
                            epoch = self.ownership.boot_epoch(),
                            "an explicit retry force-cleared a PlatformLimited fence; \
                             the handoff re-enters");
                        // Re-enter: the force-clear preserved the record's
                        // generation, so the retry's observed fence still
                        // satisfies the stale check and the handoff grants
                        // from the now-Vacant key.
                        match self.ownership.begin_handoff(
                            &req.provider,
                            &req.session_id,
                            req.target_kind,
                            &operation_id,
                            observed,
                            &initiator,
                            now_ms(),
                        ) {
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
                            _ => {
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
                        }
                    }
                    freshell_ownership::ForceReleaseOutcome::NotPlatformLimited { state } => {
                        let generation = self
                            .ownership
                            .observe(&req.provider, &req.session_id)
                            .generation;
                        tracing::warn!(target: "freshell_ownership",
                            event = "ownership.handoff.force_clear_refused",
                            operation_id = %operation_id, provider = %req.provider, session_id = %req.session_id,
                            state = ?state,
                            "the fenced retry's force-clear was refused — the key stays fenced");
                        return typed_failure(
                            "SESSION_FENCED",
                            "the session is fenced pending recovery; retry with a fresh \
                             observation or confirm the prior runtime is dead",
                            true,
                            generation,
                        );
                    }
                    freshell_ownership::ForceReleaseOutcome::StaleObservation {
                        current_epoch,
                        current_generation,
                    } => {
                        let _ = current_epoch;
                        return typed_failure(
                            "STALE_GENERATION",
                            "observed ownership fence is stale; refresh and retry",
                            false,
                            current_generation,
                        );
                    }
                }
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
        // The prior owner captured at enter (the stop source) — WITH its
        // Live generation (historical; a restore fences at the RECORD's
        // current generation instead — whole-branch M-1). Read before the
        // guard so the guard carries it.
        let prior = self
            .ownership
            .observe(&req.provider, &req.session_id)
            .state
            .prior_owner();
        let prior_kind = prior.as_ref().map(|(owner, _)| owner.kind);
        let mut guard = HandoffGuard {
            runner: Arc::clone(self),
            provider: req.provider.clone(),
            session_id: req.session_id.clone(),
            operation_id: operation_id.clone(),
            generation,
            prior: prior.clone(),
            // Flipped false once the awaited reap confirms the prior died;
            // set from the POSITIVE re-probe on a reap timeout (round-2
            // review).
            prior_still_live: prior.is_some(),
            prior_stop: PriorStopPhase::NotIssued,
            target_kind: req.target_kind,
            target_runtime: None,
            target_spawn_watch: None,
            target_spawn_begun: false,
            disarmed: false,
        };
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
        // awaited kill/reap is the single fold point. The phase marks the
        // kill as IN FLIGHT across the await — an abort landing inside it
        // must re-probe before any restore (round-3 review I-1).
        if let Some((owner, _)) = prior.as_ref() {
            guard.prior_stop = PriorStopPhase::KillInFlight;
            match self
                .stop_runtime(&req, owner, &initiator, &operation_id, generation)
                .await
            {
                StopOutcomePriv::Reaped => {
                    guard.prior_stop = PriorStopPhase::Reaped;
                    guard.prior_still_live = false; // the runner folded the exit event
                    if let Some(hooks) = self.test_hooks.as_ref() {
                        hooks.record("Reaped");
                    }
                }
                StopOutcomePriv::ReapTimeout { fenced: true } => {
                    // b8ke delta review F3: a REAL reap timeout — the kill
                    // was issued and its confirmation runs DETACHED (the
                    // watcher owns the coordinator release). The caller gets
                    // the typed retryable failure NOW; the key does NOT go
                    // Vacant and the prior is NOT restored (the detached
                    // teardown is still killing it — a probe that reads the
                    // lane's map cannot see a map-evicted-but-alive
                    // runtime). It stays fenced in Handoff until the
                    // watcher confirms death, then releases to Vacant.
                    // b8ke focused review FR5: the `handoff-failed` frame was
                    // ALREADY broadcast inside `stop_runtime`, strictly
                    // before the watcher was spawned — never again here (a
                    // second send could only ever trail the watcher's
                    // corrective `released`).
                    guard.disarm(); // the watcher performs the release
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
                            outcome: "reap_timeout_fenced_pending_reap",
                            duration_ms: began.elapsed().as_millis() as u64,
                            failure_reason: Some("REAP_TIMEOUT"),
                            stale: None,
                        },
                        "ownership.handoff.done",
                        TransitionLevel::Warn,
                    );
                    return typed_failure(
                        "REAP_TIMEOUT",
                        "the prior runtime's reap is still being confirmed; the session stays \
                         fenced until the prior is confirmed dead — retry after it settles",
                        true,
                        generation,
                    );
                }
                StopOutcomePriv::PlatformLimitedFenced => {
                    // b8ke focused round-2 review R2-3: the lane's teardown
                    // confirmed the direct child's awaited exit but cannot
                    // verify the descendant tree on this platform — NEVER a
                    // confirmed reap. The failure frame (reason
                    // PLATFORM_LIMITED) was already broadcast inside
                    // `stop_runtime`; here the key moves to the TYPED
                    // `Fenced{PlatformLimited}` state: every new writer is
                    // Blocked (never a second writer over a possibly-live
                    // descendant), the session stays recoverable (the
                    // durable history is untouched; the operator can kill
                    // leftover processes by other means), and — the
                    // documented tradeoff — nothing on this platform can
                    // ever confirm the descendant death, so the fence
                    // persists for the boot epoch.
                    guard.disarm(); // the fenced state replaces the Handoff
                    let fenced = self.ownership.fence_unconfirmed_handoff(
                        &req.provider,
                        &req.session_id,
                        &operation_id,
                        generation,
                        freshell_ownership::FenceReason::PlatformLimited,
                    );
                    debug_assert!(matches!(fenced, freshell_ownership::FenceOutcome::Fenced));
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
                            outcome: "reap_platform_limited_fenced",
                            duration_ms: began.elapsed().as_millis() as u64,
                            failure_reason: Some("PLATFORM_LIMITED"),
                            stale: None,
                        },
                        "ownership.handoff.done",
                        TransitionLevel::Error,
                    );
                    return typed_failure(
                        "PLATFORM_LIMITED",
                        "the prior runtime's teardown cannot confirm the descendant tree on \
                         this platform; the session stays fenced (no new writer can start) \
                         and remains recoverable",
                        true,
                        generation,
                    );
                }
                StopOutcomePriv::ReapTimeout { fenced: false } => {
                    // Round-2 review: a reap timeout proves ONLY that the exit
                    // was not observed in time — it does NOT imply the prior
                    // runtime is still live. POSITIVE re-probe before any
                    // restore: confirmed live -> restore (its fenced exit
                    // watcher releases the key once it actually dies — no
                    // permanent wedge); unconfirmable -> end Vacant with the
                    // typed REAP_TIMEOUT (retryable, recoverable — never
                    // record a dead runtime as Live).
                    let prior_live = self
                        .probe_prior_live(&req.provider, &req.session_id, owner)
                        .await;
                    guard.prior_still_live = prior_live;
                    let fail_outcome = guard.disarm_and_fail();
                    // Round-3 review I-1 (claim repairs) + whole-branch M-1:
                    // a restored prior — fresh (whose retained stamp the lane
                    // kill may have taken) or terminal (whose retained claim
                    // still fences at its commit generation) — must have its
                    // lane claims brought to the RESTORED generation (the
                    // handoff's — `fail` restores the record's current), or
                    // its later exit/kill paths can never release the record.
                    if prior_live && matches!(fail_outcome, FailOutcome::RestoredPriorOwner) {
                        self.repair_restored_prior_claims(
                            &req.provider,
                            &req.session_id,
                            owner,
                            generation,
                        );
                    }
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
        // Round-3 review I-1 (target-spawn window): for a terminal target,
        // arm the guard-visible spawn watch BEFORE the await — an abort
        // landing anywhere inside `start_target` leaves the settle running
        // detached, and the guard's cleanup needs the watch to find (and
        // reap) the terminal it publishes.
        let mut target_spawn_watch = None;
        if req.target_kind == RuntimeOwnerKind::Terminal {
            let watch = crate::terminal_tabs::HandoffSpawnWatch::new(
                self.test_hooks
                    .as_ref()
                    .and_then(|hooks| hooks.pause_in_target_spawn.clone()),
            );
            if let Some(hooks) = self.test_hooks.as_ref() {
                *hooks.spawn_watch_slot.lock().expect("spawn watch slot") = Some(watch.clone());
            }
            guard.target_spawn_watch = Some(watch.clone());
            target_spawn_watch = Some(watch);
        }
        guard.target_spawn_begun = true;
        match self
            .start_target(&req, &operation_id, generation, target_spawn_watch)
            .await
        {
            Ok(owner) => {
                // The cancellation-safety window: a spawned-but-uncommitted
                // target is reaped by the guard if the runner is aborted
                // before the commit (round-1 review). The precise identity
                // supersedes the spawn watch (no further await precedes the
                // commit, so no abort can land between them).
                guard.target_runtime = Some(owner.clone());
                guard.target_spawn_watch = None;
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
                        self.reap_uncommitted_target(&req, &owner, &operation_id, generation)
                            .await;
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
    /// reap timeout does NOT imply liveness — and neither does an abort
    /// inside the prior-kill await, round-3 review I-1). Terminal priors:
    /// the registry row's Running status (the same join
    /// `live_session_owner` uses); fresh priors: the lane's
    /// `has_live_session` probe (the same probe the D7 guard uses).
    async fn probe_prior_live(
        &self,
        provider: &str,
        session_id: &str,
        owner: &OwnerIdentity,
    ) -> bool {
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
            RuntimeOwnerKind::FreshAgent => match provider {
                "codex" => self.fresh_codex.has_live_session(session_id).await,
                "claude" => self.fresh_claude.has_live_session(session_id).await,
                "opencode" => self.fresh_opencode.has_live_session(session_id).await,
                _ => false,
            },
        }
    }

    /// Round-3 review I-1 + whole-branch review M-1 (the claim repairs): a
    /// prior the abort/reap-timeout path is RESTORING as Live resumes at
    /// the RECORD's current (handoff) generation, so every lane-side
    /// fenced claim must be brought to that same generation or the prior's
    /// later kill/exit paths could never match the restored record. Fresh
    /// priors: re-retain the lane stamp (the lane kill may have taken it —
    /// the insert overwrites either way; a real teardown timeout can leave
    /// the runtime alive with its stamp gone). Terminal priors: bump the
    /// registry's retained claim. The repaired claims match the restored
    /// record exactly (same owner identity, the restored generation, the
    /// prior's committing operation id), so the lanes' later
    /// kill/exit-watcher release paths keep working — a taken stamp can
    /// never permanently block repair.
    fn repair_restored_prior_claims(
        &self,
        provider: &str,
        session_id: &str,
        owner: &OwnerIdentity,
        restored_generation: u64,
    ) {
        match owner.kind {
            RuntimeOwnerKind::FreshAgent => {
                let Some(operation_id) = owner.ownership_id.clone() else {
                    // No committing operation id on the identity: no fenced claim
                    // can ever match it (commit_live stamps one) — nothing to
                    // repair against.
                    return;
                };
                let stamp = crate::ownership_lane::OwnershipStamp {
                    epoch: self.ownership.boot_epoch(),
                    generation: restored_generation,
                    operation_id,
                    owner: owner.clone(),
                };
                let stamps = match provider {
                    "codex" => &self.fresh_codex.ownership_stamps,
                    "claude" => &self.fresh_claude.ownership_stamps,
                    _ => &self.fresh_opencode.fresh_agent().ownership_stamps,
                };
                stamps
                    .lock()
                    .expect("ownership stamps lock")
                    .insert(session_id.to_string(), stamp);
                tracing::warn!(target: "freshell_ownership",
                    event = "ownership.handoff.stamp_repaired",
                    provider, session_id,
                    generation = restored_generation,
                    outcome = "stamp_retained",
                    "handoff restored a live prior; its lane stamp must fence at the restored generation");
            }
            RuntimeOwnerKind::Terminal => {
                let Some(terminal_id) = owner.terminal_id.as_deref() else {
                    // A Live terminal owner always carries its terminal id
                    // (commit_session_ref_ownership stamps it) — nothing to
                    // repair against without one.
                    return;
                };
                let repaired = self
                    .registry
                    .repair_restored_prior_ownership(terminal_id, restored_generation);
                tracing::warn!(target: "freshell_ownership",
                    event = "ownership.handoff.terminal_claim_repaired",
                    provider, session_id, terminal_id,
                    generation = restored_generation,
                    outcome = if repaired { "claim_bumped" } else { "no_claim_to_repair" },
                    "handoff restored a live terminal prior; its retained claim must fence \
                     at the restored generation");
            }
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
    /// the same lane teardown the prior stop uses (a REAL timeout there
    /// detaches the confirmation the same way — the watcher's coordinator
    /// release is the op/generation-fenced no-op it should be for a target
    /// that never committed).
    async fn reap_uncommitted_target(
        self: &Arc<Self>,
        req: &HandoffRequest,
        owner: &OwnerIdentity,
        operation_id: &str,
        generation: u64,
    ) {
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
                    .stop_runtime(
                        req,
                        owner,
                        "handoff-runner-stale-commit",
                        operation_id,
                        generation,
                    )
                    .await;
            }
        }
    }

    /// A minimal synthetic request for the cleanup paths (the Drop cannot
    /// reach the original — only the pieces `reap_uncommitted_target`'s
    /// stop dispatch reads are needed).
    fn cleanup_request(
        &self,
        provider: &str,
        session_id: &str,
        kind: RuntimeOwnerKind,
    ) -> HandoffRequest {
        HandoffRequest {
            provider: provider.to_string(),
            session_id: session_id.to_string(),
            target_kind: kind,
            session_type: None,
            mode: None,
            cwd: None,
            tab_id: None,
            pane_id: None,
            observed_epoch: None,
            observed_generation: None,
            device_id: Some("handoff-guard-cleanup".into()),
        }
    }

    /// Round-3 review I-1: the abort/panic cleanup's coordinator half, run
    /// on the Drop's detached task. b8ke focused round-3 review R3-6: the
    /// UNCOMMITTED-TARGET reap runs FIRST — the record stays in this
    /// operation's `Handoff` (every competing begin Blocked with the typed
    /// in-flight answer) until the fresh target's `NotConfirmed`
    /// continuation settles (or a bounded kill confirms) — the record never
    /// goes plain-Vacant while an uncommitted target may live. THEN the
    /// prior half: re-probe the prior's liveness (KillInFlight — the
    /// reap-timeout discipline: a dying prior is never restored as Live;
    /// a confirmed-live one is restored WITH its lane claims repaired to
    /// the restored generation) or use the guard's known value
    /// (NotIssued/Reaped), and fail accordingly. An UNCONFIRMED or
    /// PLATFORM-LIMITED target reap never fails to plain Vacant — the key
    /// fences typed (recoverable) instead.
    async fn abort_cleanup(self: &Arc<Self>, payload: AbortPayload, decision: AbortFailDecision) {
        let AbortPayload {
            provider,
            session_id,
            operation_id,
            generation,
            prior,
            ..
        } = &payload;
        let target_outcome = self.abort_reap_uncommitted_target(&payload).await;
        let confirmed_live = match prior.as_ref() {
            Some((owner, _)) => {
                let live = match decision {
                    AbortFailDecision::Probe => {
                        self.probe_prior_live(provider, session_id, owner).await
                    }
                    AbortFailDecision::Known(live) => live,
                };
                match target_outcome {
                    UncommittedTargetOutcome::Reaped | UncommittedTargetOutcome::NothingToDo => {
                        let outcome = self.ownership.fail(
                            provider,
                            session_id,
                            operation_id,
                            *generation,
                            live,
                        );
                        if live && matches!(outcome, FailOutcome::RestoredPriorOwner) {
                            self.repair_restored_prior_claims(
                                provider,
                                session_id,
                                owner,
                                *generation,
                            );
                        }
                    }
                    UncommittedTargetOutcome::PlatformLimited => {
                        // R3-6 + the round-2 R2-3 discipline: the target's
                        // descendant tree is unverifiable on this platform —
                        // fence typed (a new writer can never start against
                        // the unconfirmable target), never plain Vacant.
                        let fenced = self.ownership.fence_unconfirmed_handoff(
                            provider,
                            session_id,
                            operation_id,
                            *generation,
                            freshell_ownership::FenceReason::PlatformLimited,
                        );
                        tracing::error!(target: "freshell_ownership",
                            event = "ownership.handoff.abort_fenced_platform_limited",
                            operation_id = %operation_id, provider = %provider, session_id = %session_id,
                            epoch = self.ownership.boot_epoch(), generation,
                            outcome = ?fenced,
                            "the aborted handoff's uncommitted target could not be \
                             confirmed dead on this platform — the key fences typed");
                    }
                    UncommittedTargetOutcome::Unconfirmed => {
                        // R3-6 fail-closed: the escalation continuation was
                        // lost or resolved unconfirmed — a live unowned
                        // writer may remain, so the key fences typed rather
                        // than reopening.
                        let fenced = self.ownership.fence_unconfirmed_handoff(
                            provider,
                            session_id,
                            operation_id,
                            *generation,
                            freshell_ownership::FenceReason::WatcherFailed,
                        );
                        tracing::error!(target: "freshell_ownership",
                            event = "ownership.handoff.abort_fenced_unconfirmed_target",
                            operation_id = %operation_id, provider = %provider, session_id = %session_id,
                            epoch = self.ownership.boot_epoch(), generation,
                            outcome = ?fenced,
                            "the aborted handoff's uncommitted target reap never confirmed \
                             death — the key fences typed (never plain Vacant)");
                    }
                }
                live
            }
            None => {
                match target_outcome {
                    UncommittedTargetOutcome::Reaped | UncommittedTargetOutcome::NothingToDo => {
                        let _ = self.ownership.fail(
                            provider,
                            session_id,
                            operation_id,
                            *generation,
                            false,
                        );
                    }
                    UncommittedTargetOutcome::PlatformLimited
                    | UncommittedTargetOutcome::Unconfirmed => {
                        let _ = self.ownership.fence_unconfirmed_handoff(
                            provider,
                            session_id,
                            operation_id,
                            *generation,
                            freshell_ownership::FenceReason::WatcherFailed,
                        );
                    }
                }
                false
            }
        };
        tracing::warn!(target: "freshell_ownership",
            event = "ownership.handoff.abort_settled",
            operation_id = %operation_id, provider = %provider, session_id = %session_id,
            epoch = self.ownership.boot_epoch(), generation,
            outcome = if confirmed_live { "restored_prior_owner" } else { "vacant" },
            target_reap = ?target_outcome,
            failure_reason = "RUNNER_ABORTED",
            "handoff runner aborted inside the prior-reap window; liveness re-probed before restore");
    }

    /// Round-3 review I-1: the abort/panic cleanup's target half — reap the
    /// uncommitted target runtime so no live unowned writer survives:
    /// (a) the KNOWN identity (the spawn returned but the commit never
    ///     happened — round-1 review's window),
    /// (b) the in-flight terminal settle (the spawn await was dropped; the
    ///     settle runs detached to completion — wait for its settlement,
    ///     then reap the terminal it published, with the registry
    ///     sessionRef sweep as the backstop),
    /// (c) a fresh target's registered session (the dropped resume skipped
    ///     its in-function cleanup — the lane kill is idempotent and only
    ///     reached once `start_target` was entered, so the reaped prior can
    ///     never be its victim).
    ///
    /// b8ke focused round-3 review R3-6: the fresh-lane kill's answer is
    /// FULLY consumed — a `NotConfirmed` continuation is AWAITED (the
    /// caller's coordinator record stays fenced in `Handoff` while it
    /// runs), a `PlatformLimited` answer is never a confirmed reap, and
    /// only `Reaped`/`AlreadyGone` release the lane lease. The returned
    /// outcome tells the cleanup's coordinator half whether the record may
    /// fail (Reaped/NothingToDo) or must fence typed instead.
    async fn abort_reap_uncommitted_target(
        self: &Arc<Self>,
        payload: &AbortPayload,
    ) -> UncommittedTargetOutcome {
        let AbortPayload {
            provider,
            session_id,
            operation_id,
            generation,
            target_kind,
            target_spawn_begun,
            target,
            spawn_watch,
            ..
        } = payload;
        if let Some(target) = target.as_ref() {
            let req = self.cleanup_request(provider, session_id, target.kind);
            self.reap_uncommitted_target(&req, target, operation_id, *generation)
                .await;
        }
        if let Some(watch) = spawn_watch.as_ref() {
            watch.wait_settled().await;
            if let Some(terminal_id) = watch.published_terminal() {
                self.kill_and_confirm_terminal(&terminal_id).await;
            }
            // Backstop: any registry row still holding the canonical
            // sessionRef UNDER THIS HANDOFF'S PROVIDER is an uncommitted
            // spawn for this handoff — reap it. b8ke delta review F6: the
            // row must ALSO match the provider (the registry-row join every
            // sessionRef lookup uses: `mode == provider`) — an opaque-id
            // collision across providers must never abort an unrelated
            // terminal.
            for entry in self.registry.directory() {
                if entry.mode == provider.as_str()
                    && entry.resume_session_id.as_deref() == Some(session_id.as_str())
                {
                    self.kill_and_confirm_terminal(&entry.terminal_id).await;
                }
            }
        }
        if *target_spawn_begun && *target_kind == RuntimeOwnerKind::FreshAgent {
            let initiator = "handoff-guard-cleanup";
            let result = match provider.as_str() {
                "codex" => {
                    self.fresh_codex
                        .kill_for_handoff(session_id, initiator)
                        .await
                }
                "claude" => {
                    self.fresh_claude
                        .kill_for_handoff(session_id, initiator)
                        .await
                }
                "opencode" => {
                    self.fresh_opencode
                        .opencode_kill_for_handoff(session_id, initiator)
                        .await
                }
                _ => return UncommittedTargetOutcome::Unconfirmed,
            };
            let reaped = match result {
                StopResult::Reaped | StopResult::AlreadyGone => true,
                // R3-6: a platform-limited teardown (the direct child's
                // awaited exit is the portable floor, the descendant tree is
                // unverifiable) must never count as the confirmed reap of
                // the uncommitted target — the caller fences typed.
                StopResult::PlatformLimited => {
                    return UncommittedTargetOutcome::PlatformLimited;
                }
                // R3-6: the lane's escalation continuation IS the
                // confirmation — await it (the coordinator record stays
                // fenced in Handoff while it runs). A lost/unconfirmed
                // continuation never reopens the key.
                StopResult::NotConfirmed { confirmation } => confirmation.await,
            };
            if reaped {
                // The aborted resume's lease guard dropped ARMED with its
                // kill handle set (the child existed), so the lease is held
                // for TTL recovery — but the teardown we just awaited IS
                // the confirmed tree death, so the precise release applies
                // and the typed RETRYABLE failure stays honestly retryable.
                self.release_fresh_lane_lease(provider, session_id);
                UncommittedTargetOutcome::Reaped
            } else {
                UncommittedTargetOutcome::Unconfirmed
            }
        } else {
            UncommittedTargetOutcome::NothingToDo
        }
    }

    /// Release a fresh lane's held sessionRef lease after a CONFIRMED tree
    /// kill (the `force_release_after_confirmed_kill` contract). No-op for
    /// unknown providers (nothing was reaped).
    fn release_fresh_lane_lease(&self, provider: &str, session_id: &str) {
        match provider {
            "codex" => self
                .fresh_codex
                .leases()
                .force_release_after_confirmed_kill(provider, session_id),
            "claude" => self
                .fresh_claude
                .leases()
                .force_release_after_confirmed_kill(provider, session_id),
            "opencode" => self
                .fresh_opencode
                .leases
                .force_release_after_confirmed_kill(provider, session_id),
            _ => {}
        }
    }

    /// Registry kill + bounded confirmed death (the runner's reap shape).
    async fn kill_and_confirm_terminal(&self, terminal_id: &str) {
        if self.registry.kill(terminal_id) {
            let _ = tokio::time::timeout(
                std::time::Duration::from_millis(self.reap_timeout_ms),
                await_terminal_dead(&self.registry, terminal_id),
            )
            .await;
        }
    }

    /// Stop the prior runtime and await the CONFIRMED reap (bounded by
    /// `reap_timeout_ms`). Terminal priors: the registry group-kill +
    /// dead-poll (the `kill_session_ref_holder_and_confirm` discipline);
    /// fresh priors: the lane's `kill_for_handoff` teardown (never the shared
    /// opencode serve). `force_reap_timeout` (test hook) short-circuits
    /// BEFORE any kill is issued.
    ///
    /// b8ke delta review F3: a REAL timeout (the kill issued, the death
    /// delayed past the budget) must NOT drop the in-flight teardown —
    /// `tokio::select!` polls the confirmation WITHOUT consuming it, so the
    /// timeout branch hands the still-running teardown to a DETACHED
    /// watcher and reports the fenced timeout. The watcher owns the
    /// coordinator release from there ([`Self::spawn_reap_confirmation_watcher`]).
    ///
    /// b8ke focused review FR5: every fenced branch broadcasts the
    /// `handoff-failed` frame BEFORE spawning the detached watcher — the
    /// broadcast is a synchronous channel send on THIS task, so no
    /// `released` frame can ever precede the failure frame on the bus (a
    /// same-generation client fold would otherwise latch the stale
    /// prior-owner frame over the corrective release).
    ///
    /// b8ke focused review FR3: a lane answering
    /// [`StopResult::NotConfirmed`] (its bounded tree-death confirmation
    /// window expired with the runtime still alive) takes the SAME fenced
    /// path — the carried continuation is the watcher's confirmation.
    async fn stop_runtime(
        self: &Arc<Self>,
        req: &HandoffRequest,
        owner: &OwnerIdentity,
        initiator: &str,
        operation_id: &str,
        generation: u64,
    ) -> StopOutcomePriv {
        if let Some(hooks) = self.test_hooks.as_ref() {
            if hooks
                .force_reap_timeout
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return StopOutcomePriv::ReapTimeout { fenced: false };
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
                // Round-3 review I-1 (prior-reap window): the kill is now
                // ISSUED (SIGKILL sent) but unconfirmed — the abort-window
                // test's deterministic hold parks HERE, inside the window
                // where a dropped runner must re-probe before any restore.
                if let Some(hooks) = self.test_hooks.as_ref() {
                    if let Some(pause) = hooks.pause_after_terminal_prior_kill.as_ref() {
                        let _ = pause.notified().await;
                    }
                }
                let mut confirm = std::pin::pin!(await_terminal_dead(&self.registry, terminal_id));
                tokio::select! {
                    () = &mut confirm => StopOutcomePriv::Reaped,
                    _ = tokio::time::sleep(budget) => {
                        // The SIGKILL was issued; the row's death is merely
                        // unobserved. Keep polling DETACHED (the watcher
                        // releases the fenced key once the row is dead) — the
                        // failure frame FIRST (FR5), strictly before the
                        // watcher exists.
                        self.broadcast_fenced_reap_timeout(req, owner, operation_id, generation);
                        let registry = self.registry.clone();
                        let tid = terminal_id.to_string();
                        self.spawn_reap_confirmation_watcher(
                            req,
                            operation_id,
                            generation,
                            initiator,
                            owner,
                            "REAP_TIMEOUT",
                            async move {
                                await_terminal_dead(&registry, &tid).await;
                                // The registry row is dead — confirmed.
                                ReapAnswer::Confirmed
                            },
                        );
                        StopOutcomePriv::ReapTimeout { fenced: true }
                    }
                }
            }
            RuntimeOwnerKind::FreshAgent => {
                // The teardown future must be 'static: the timeout branch
                // SPAWNS it (never drops it mid-sequence) — each lane is
                // cheaply-cloneable state owning its own copies of the ids.
                let session_id = req.session_id.clone();
                let initiator = initiator.to_string();
                let mut kill: std::pin::Pin<
                    Box<dyn std::future::Future<Output = StopResult> + Send>,
                > = match req.provider.as_str() {
                    "codex" => {
                        let lane = self.fresh_codex.clone();
                        let initiator = initiator.clone();
                        Box::pin(
                            async move { lane.kill_for_handoff(&session_id, &initiator).await },
                        )
                    }
                    "claude" => {
                        let lane = self.fresh_claude.clone();
                        let initiator = initiator.clone();
                        Box::pin(
                            async move { lane.kill_for_handoff(&session_id, &initiator).await },
                        )
                    }
                    "opencode" => {
                        let lane = self.fresh_opencode.clone();
                        let initiator = initiator.clone();
                        Box::pin(async move {
                            lane.opencode_kill_for_handoff(&session_id, &initiator)
                                .await
                        })
                    }
                    _ => return StopOutcomePriv::Reaped,
                };
                // `select!` polls the pinned teardown WITHOUT consuming it:
                // in budget → the lane teardown awaited its own watcher (the
                // confirmed reap; AlreadyGone is the same truth); over
                // budget → the still-running teardown is SPAWNED (never
                // dropped) and the key is fenced until its watcher settles.
                // A lane answering `NotConfirmed` (its bounded window could
                // not confirm the tree's death — b8ke focused FR3) takes the
                // same fenced path with the lane's own continuation as the
                // confirmation; the failure frame is broadcast BEFORE the
                // watcher exists in every arm (b8ke focused FR5).
                tokio::select! {
                    result = &mut kill => match result {
                        // The lane teardown awaited its own watcher — the confirmed
                        // reap. AlreadyGone is the same truth (nothing to stop).
                        StopResult::Reaped | StopResult::AlreadyGone => StopOutcomePriv::Reaped,
                        // b8ke focused round-2 review R2-3: a platform-limited
                        // teardown (non-Linux: the direct child's awaited exit
                        // is the portable floor, the descendant tree is
                        // unverifiable) must NOT satisfy confirmed-reap — the
                        // failure frame (reason PLATFORM_LIMITED) precedes the
                        // fence, and the caller answers the typed failure. No
                        // watcher: nothing on that platform can ever confirm
                        // the descendant death.
                        StopResult::PlatformLimited => {
                            self.broadcast_fenced_stop_refusal(
                                req, owner, operation_id, generation, "PLATFORM_LIMITED",
                            );
                            StopOutcomePriv::PlatformLimitedFenced
                        }
                        StopResult::NotConfirmed { confirmation } => {
                            self.broadcast_fenced_reap_timeout(req, owner, operation_id, generation);
                            self.spawn_reap_confirmation_watcher(
                                req,
                                operation_id,
                                generation,
                                &initiator,
                                owner,
                                "REAP_TIMEOUT",
                                async move {
                                    if confirmation.await {
                                        ReapAnswer::Confirmed
                                    } else {
                                        ReapAnswer::Lost
                                    }
                                },
                            );
                            StopOutcomePriv::ReapTimeout { fenced: true }
                        }
                    },
                    _ = tokio::time::sleep(budget) => {
                        self.broadcast_fenced_reap_timeout(req, owner, operation_id, generation);
                        let confirmation = tokio::spawn(kill);
                        let hooks = self.test_hooks.clone();
                        self.spawn_reap_confirmation_watcher(
                            req,
                            operation_id,
                            generation,
                            &initiator,
                            owner,
                            "REAP_TIMEOUT",
                            async move {
                                // b8ke focused FR6's test seam: the armed hook
                                // aborts the spawned teardown task — a REAL
                                // JoinError (cancelled) surfaces through the
                                // await, exercising the watcher's typed fenced
                                // state + replacement probe (round-2 R2-1).
                                // Never armed in production.
                                if let Some(hooks) = hooks.as_ref() {
                                    if hooks.abort_reap_confirmation_once.swap(
                                        false,
                                        std::sync::atomic::Ordering::SeqCst,
                                    ) {
                                        confirmation.abort();
                                    }
                                }
                                // b8ke focused round-2 review: the spawned
                                // teardown's COMPLETED answer is confirmed
                                // death ONLY for Reaped/AlreadyGone — a
                                // completed-but-PlatformLimited answer fences
                                // (R2-3), and a NotConfirmed answer's own
                                // escalation continuation IS the confirmation.
                                // A JoinError (the teardown task panicked or
                                // was cancelled) is `Lost`: death is
                                // UNCONFIRMED, the watcher fences with the
                                // typed WatcherFailed reason and the
                                // replacement probe settles it (R2-1).
                                match confirmation.await {
                                    Ok(StopResult::Reaped) | Ok(StopResult::AlreadyGone) => {
                                        ReapAnswer::Confirmed
                                    }
                                    Ok(StopResult::PlatformLimited) => ReapAnswer::PlatformLimited,
                                    Ok(StopResult::NotConfirmed { confirmation }) => {
                                        if confirmation.await {
                                            ReapAnswer::Confirmed
                                        } else {
                                            ReapAnswer::Lost
                                        }
                                    }
                                    Err(_) => ReapAnswer::Lost,
                                }
                            },
                        );
                        StopOutcomePriv::ReapTimeout { fenced: true }
                    }
                }
            }
        }
    }

    /// b8ke focused review FR5: the fenced reap-timeout failure frame,
    /// broadcast from the runner's OWN task strictly BEFORE any detached
    /// watcher is spawned. The frame's truth: the PRIOR is still the
    /// fenced owner (its kind/runtime identity) — never the target kind,
    /// never a lie about vacancy. The watcher's `released` frame supersedes
    /// it once death is confirmed.
    fn broadcast_fenced_reap_timeout(
        &self,
        req: &HandoffRequest,
        owner: &OwnerIdentity,
        operation_id: &str,
        generation: u64,
    ) {
        let prior_kind = Some(owner.kind);
        self.broadcast_owner(
            req,
            "handoff-failed",
            prior_kind,
            owner.terminal_id.clone(),
            operation_id,
            generation,
            prior_kind,
            Some("REAP_TIMEOUT"),
        );
    }

    /// b8ke focused round-2 review R2-3: the platform-limited stop's fenced
    /// failure frame — the same FR5 truth (the PRIOR still owns the fenced
    /// key) with the typed PLATFORM_LIMITED reason.
    fn broadcast_fenced_stop_refusal(
        &self,
        req: &HandoffRequest,
        owner: &OwnerIdentity,
        operation_id: &str,
        generation: u64,
        reason: &str,
    ) {
        let prior_kind = Some(owner.kind);
        self.broadcast_owner(
            req,
            "handoff-failed",
            prior_kind,
            owner.terminal_id.clone(),
            operation_id,
            generation,
            prior_kind,
            Some(reason),
        );
    }

    /// b8ke delta review F3: the detached reap-confirmation watcher for a
    /// REAL reap timeout (kill issued, death delayed past the runner's
    /// budget). The key stays fenced in `Handoff` — every competing
    /// begin (start/handoff/stop) is Blocked with the typed in-flight
    /// answer, so no new writer can start while the old runtime's death is
    /// unconfirmed — until `confirmation` resolves
    /// [`ReapAnswer::Confirmed`] (the lane teardown's own watcher for
    /// fresh priors; the registry dead-probe for terminal priors), then
    /// the key releases to Vacant, the corrective `released` broadcast
    /// supersedes the fenced `handoff-failed` frame, and the uniform
    /// done-line logs the settlement. A retry during the fence is
    /// typed-refused; after the release it succeeds.
    ///
    /// b8ke focused round-2 review R2-1: a `Lost` resolution (the
    /// confirmation future itself failed — the spawned teardown
    /// JoinError'd, or a NotConfirmed continuation was lost) NEVER
    /// fail-opens the key: the watcher moves it to the TYPED
    /// `Fenced{WatcherFailed}` state and spawns the REPLACEMENT watcher
    /// whose bounded recorded-identity probe re-issues the death
    /// confirmation (the terminal registry dead-poll; each fresh lane's
    /// condemn-record kill-and-confirm) — only that probe's `Confirmed`
    /// answer releases the fence. There is no path from here to plain
    /// Vacant.
    ///
    /// b8ke focused round-2 review R2-3: a `PlatformLimited` resolution
    /// (the teardown completed but its platform cannot verify the
    /// descendant tree) fences with the typed `PlatformLimited` reason
    /// and spawns nothing — no probe on that platform can ever confirm,
    /// so the fence persists for the boot epoch (the documented
    /// tradeoff; the session stays recoverable and the operator can kill
    /// leftover processes by other means).
    #[allow(clippy::too_many_arguments)] // the watcher field set (the spawn-call shape it has always had)
    fn spawn_reap_confirmation_watcher(
        self: &Arc<Self>,
        req: &HandoffRequest,
        operation_id: &str,
        generation: u64,
        initiator: &str,
        prior: &OwnerIdentity,
        release_reason: &'static str,
        confirmation: impl std::future::Future<Output = ReapAnswer> + Send + 'static,
    ) {
        let runner = Arc::clone(self);
        let provider = req.provider.clone();
        let session_id = req.session_id.clone();
        let operation_id = operation_id.to_string();
        let initiator = initiator.to_string();
        let prior = prior.clone();
        let prior_kind = Some(prior.kind);
        let broadcast_req = self.cleanup_request(&provider, &session_id, req.target_kind);
        let settled = std::time::Instant::now();
        tokio::spawn(async move {
            match confirmation.await {
                ReapAnswer::Lost => {
                    // R2-1: the confirmation future was lost — FENCE with
                    // the typed WatcherFailed reason (never a fail-open to
                    // Vacant), then re-spawn the replacement watcher whose
                    // bounded recorded-identity probe settles the fence
                    // ONLY on confirmed death.
                    let outcome = runner.ownership.fence_unconfirmed_handoff(
                        &provider,
                        &session_id,
                        &operation_id,
                        generation,
                        freshell_ownership::FenceReason::WatcherFailed,
                    );
                    if !matches!(outcome, freshell_ownership::FenceOutcome::Fenced) {
                        // The record moved on (a foreign op/generation, or
                        // already settled) — the typed no-op; nothing on the
                        // bus (a stale-generation frame would be dropped by
                        // the clients' monotonic fold anyway).
                        tracing::warn!(target: "freshell_ownership",
                            event = "ownership.handoff.reap_watcher_failed_foreign",
                            operation_id = %operation_id, provider = %provider, session_id = %session_id,
                            epoch = runner.ownership.boot_epoch(), generation,
                            outcome = "foreign_noop", failure_reason = "WATCHER_FAILED",
                            "the watcher-failed fence landed after the coordinator record moved on");
                        return;
                    }
                    // The fence's corrective frame: the truth is unchanged
                    // from the REAP_TIMEOUT `handoff-failed` frame already
                    // on the bus (the prior still owns the fenced key), so
                    // no new frame here — only the done-line.
                    runner.log_transition(
                        TransitionLog {
                            operation_id: &operation_id,
                            provider: &provider,
                            session_id: &session_id,
                            initiator: &initiator,
                            epoch: runner.ownership.boot_epoch(),
                            generation,
                            live_session_key: prior.live_session_key.as_deref(),
                            from_kind: prior_kind,
                            to_kind: None,
                            runtime_id: prior.terminal_id.as_deref(),
                            pid: prior.pid,
                            outcome: "reap_watcher_failed_fenced",
                            duration_ms: settled.elapsed().as_millis() as u64,
                            failure_reason: Some("WATCHER_FAILED"),
                            stale: None,
                        },
                        "ownership.handoff.done",
                        TransitionLevel::Error,
                    );
                    // The replacement probe — same watcher shape, settling
                    // ONLY on a positive death confirmation (it loops the
                    // bounded lane/registry probe until then; it can never
                    // resolve Lost or PlatformLimited).
                    let replacement =
                        runner.prior_death_reconfirmation(&provider, &session_id, &prior);
                    runner.spawn_reap_confirmation_watcher(
                        &broadcast_req,
                        &operation_id,
                        generation,
                        &initiator,
                        &prior,
                        "WATCHER_FAILED",
                        replacement,
                    );
                    // The replacement watcher owns the release from here —
                    // this watcher's job ended with the fence (falling
                    // through would run the Confirmed-release code below and
                    // immediately reopen the key it just fenced).
                    return;
                }
                ReapAnswer::PlatformLimited => {
                    // R2-3: the teardown completed but the platform cannot
                    // verify the descendant tree — fence with the typed
                    // PlatformLimited reason and settle for the epoch.
                    let outcome = runner.ownership.fence_unconfirmed_handoff(
                        &provider,
                        &session_id,
                        &operation_id,
                        generation,
                        freshell_ownership::FenceReason::PlatformLimited,
                    );
                    if !matches!(outcome, freshell_ownership::FenceOutcome::Fenced) {
                        tracing::warn!(target: "freshell_ownership",
                            event = "ownership.handoff.reap_platform_limited_foreign",
                            operation_id = %operation_id, provider = %provider, session_id = %session_id,
                            epoch = runner.ownership.boot_epoch(), generation,
                            outcome = "foreign_noop", failure_reason = "PLATFORM_LIMITED",
                            "the platform-limited fence landed after the coordinator record moved on");
                        return;
                    }
                    runner.log_transition(
                        TransitionLog {
                            operation_id: &operation_id,
                            provider: &provider,
                            session_id: &session_id,
                            initiator: &initiator,
                            epoch: runner.ownership.boot_epoch(),
                            generation,
                            live_session_key: prior.live_session_key.as_deref(),
                            from_kind: prior_kind,
                            to_kind: None,
                            runtime_id: prior.terminal_id.as_deref(),
                            pid: prior.pid,
                            outcome: "reap_platform_limited_fenced",
                            duration_ms: settled.elapsed().as_millis() as u64,
                            failure_reason: Some("PLATFORM_LIMITED"),
                            stale: None,
                        },
                        "ownership.handoff.done",
                        TransitionLevel::Error,
                    );
                    // b8ke focused round-3 R3-3: the fence is TERMINAL on
                    // this platform — RETURN, exactly like the Lost arm.
                    // Falling through would run the Confirmed-release code
                    // below, reopening the key (and broadcasting
                    // `released`) over a descendant tree nobody ever
                    // confirmed dead — the fail-open the delayed-crossing
                    // test pins.
                    return;
                }
                ReapAnswer::Confirmed => {}
            }
            // The confirmation IS the observed death (the lane teardown
            // awaited its own watcher; the registry row is dead; the
            // replacement probe kill-and-confirmed): release the fenced
            // key — never restore a dead runtime as Live. The subject is
            // either the original `Handoff` (`fail`) or — for the
            // replacement watcher — the `Fenced` record itself
            // (`release_fenced`); a foreign op/gen on either path is the
            // typed no-op.
            let released = match runner.ownership.fail(
                &provider,
                &session_id,
                &operation_id,
                generation,
                false,
            ) {
                freshell_ownership::FailOutcome::Vacant { .. } => true,
                _ => matches!(
                    runner.ownership.release_fenced(
                        &provider,
                        &session_id,
                        &operation_id,
                        generation,
                    ),
                    freshell_ownership::CommitOutcome::Committed
                ),
            };
            if !released {
                // The record moved on (a foreign op/generation, or already
                // settled) — log it and say nothing on the bus (a
                // stale-generation frame would be dropped by the clients'
                // monotonic fold anyway).
                tracing::warn!(target: "freshell_ownership",
                    event = "ownership.handoff.reap_settled_foreign",
                    operation_id = %operation_id, provider = %provider, session_id = %session_id,
                    epoch = runner.ownership.boot_epoch(), generation,
                    outcome = "foreign_noop", failure_reason = "REAP_TIMEOUT",
                    "the detached reap settled after the coordinator record moved on");
                return;
            }
            // The corrective frame: the key is vacant now (the fenced
            // handoff-failed frame said the prior still owned it — the
            // same-generation fold applies this one).
            runner.broadcast_owner(
                &broadcast_req,
                "released",
                None,
                None,
                &operation_id,
                generation,
                prior_kind,
                Some(release_reason),
            );
            runner.log_transition(
                TransitionLog {
                    operation_id: &operation_id,
                    provider: &provider,
                    session_id: &session_id,
                    initiator: &initiator,
                    epoch: runner.ownership.boot_epoch(),
                    generation,
                    live_session_key: prior.live_session_key.as_deref(),
                    from_kind: prior_kind,
                    to_kind: None,
                    runtime_id: prior.terminal_id.as_deref(),
                    pid: prior.pid,
                    outcome: "reap_timeout_settled_vacant",
                    duration_ms: settled.elapsed().as_millis() as u64,
                    failure_reason: Some(release_reason),
                    stale: None,
                },
                "ownership.handoff.done",
                TransitionLevel::Warn,
            );
        });
    }

    /// b8ke focused round-2 review R2-1: the replacement death confirmation
    /// for a `Fenced{WatcherFailed}` key — a BOUNDED probe of the recorded
    /// prior identity that re-issues the kill where the lost teardown left
    /// it and resolves [`ReapAnswer::Confirmed`] ONLY once death is
    /// positively confirmed. Terminal priors: the registry dead-poll of the
    /// recorded terminal id. Fresh priors: the lane's own recorded-identity
    /// kill-and-confirm (claude/codex: the condemned (pid, tag) tree sweep;
    /// opencode: the condemned daemon-side turn abort), with a full lane
    /// teardown re-run for a session the cancelled kill never reached.
    /// Never resolves anything but `Confirmed` — it loops (bounded steps,
    /// fail-closed) until death is proven.
    fn prior_death_reconfirmation(
        self: &Arc<Self>,
        provider: &str,
        session_id: &str,
        prior: &OwnerIdentity,
    ) -> impl std::future::Future<Output = ReapAnswer> + Send + 'static {
        let registry = self.registry.clone();
        let fresh_claude = self.fresh_claude.clone();
        let fresh_codex = self.fresh_codex.clone();
        let fresh_opencode = self.fresh_opencode.clone();
        let provider = provider.to_string();
        let session_id = session_id.to_string();
        let prior = prior.clone();
        async move {
            let mut logged_wait = false;
            loop {
                match prior.kind {
                    RuntimeOwnerKind::Terminal => {
                        if let Some(tid) = prior.terminal_id.as_deref() {
                            await_terminal_dead(&registry, tid).await;
                            return ReapAnswer::Confirmed;
                        }
                        // A Live terminal owner always carries its
                        // terminal id; None is unreachable — stay
                        // fail-closed (the fence holds).
                    }
                    RuntimeOwnerKind::FreshAgent => {
                        let confirmed = match provider.as_str() {
                            "claude" => fresh_claude.confirm_fenced_prior_dead(&session_id).await,
                            "codex" => fresh_codex.confirm_fenced_prior_dead(&session_id).await,
                            "opencode" => {
                                fresh_opencode.confirm_fenced_prior_dead(&session_id).await
                            }
                            _ => false,
                        };
                        if confirmed {
                            return ReapAnswer::Confirmed;
                        }
                    }
                }
                if !logged_wait {
                    logged_wait = true;
                    tracing::warn!(target: "freshell_ownership",
                        event = "ownership.handoff.replacement_probe_waiting",
                        provider = %provider, session_id = %session_id,
                        runtime_id = ?prior.terminal_id, pid = ?prior.pid,
                        "the replacement death probe has not yet confirmed the fenced prior's \
                         death — the key stays fenced (fail-closed) while the probe retries");
                }
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
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
        target_spawn_watch: Option<crate::terminal_tabs::HandoffSpawnWatch>,
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
                    watch: target_spawn_watch
                        .unwrap_or_else(|| crate::terminal_tabs::HandoffSpawnWatch::new(None)),
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

/// The prior-stop phase at abort time (round-3 review I-1 — the
/// cancellation-safety windows). The Drop's restore discipline keys off it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PriorStopPhase {
    /// The stop was never issued (the abort landed before the kill await):
    /// the prior is untouched — restore it directly (test 5's window; its
    /// retained stamp is intact, and the restore repairs it FORWARD to the
    /// restored generation so the exit watcher still releases —
    /// whole-branch M-1).
    NotIssued,
    /// The stop was issued but its confirmed reap was lost to the abort:
    /// re-probe prior liveness BEFORE any restore (the reap-timeout
    /// discipline) — a dying prior is never restored as Live; a
    /// confirmed-live one is restored WITH its lane claims (fresh stamp /
    /// terminal retained claim) repaired to the restored generation (the
    /// lane kill already took the stamp).
    KillInFlight,
    /// Confirmed reaped (or there never was a prior): never restore — the
    /// runner folded the exit; the key ends Vacant.
    Reaped,
}

/// The Drop's detached abort payload (round-3 review I-1): everything the
/// cleanup needs, moved out of the guard when the task is cancelled or
/// panics mid-flight.
struct AbortPayload {
    provider: String,
    session_id: String,
    operation_id: String,
    generation: u64,
    prior: Option<(OwnerIdentity, u64)>,
    target_kind: RuntimeOwnerKind,
    target_spawn_begun: bool,
    target: Option<OwnerIdentity>,
    spawn_watch: Option<crate::terminal_tabs::HandoffSpawnWatch>,
}

/// b8ke focused round-3 review R3-6: what the abort cleanup's
/// uncommitted-target reap established — the coordinator half's ending
/// keys off it (fail to the probed prior/Vacant, or fence typed).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UncommittedTargetOutcome {
    /// No target cleanup was owed (nothing spawned/begun), or the reap
    /// confirmed the target's death — the record may fail.
    NothingToDo,
    /// The target's death was confirmed (lane teardown awaited, terminal
    /// dead-poll, or AlreadyGone idempotence) — the record may fail.
    Reaped,
    /// The lane's teardown confirmed the direct child's awaited exit but
    /// cannot verify the descendant tree (non-Linux) — never a confirmed
    /// reap; the record fences typed instead of failing.
    PlatformLimited,
    /// The escalation continuation was lost or resolved unconfirmed — a
    /// live unowned writer may remain; the record fences typed instead of
    /// failing.
    Unconfirmed,
}

/// How the abort cleanup decides the prior's liveness for its `fail`:
/// `Probe` re-probes (the KillInFlight window — the kill was issued but
/// its confirmation was lost to the abort); `Known` carries the guard's
/// already-settled value (NotIssued: the untouched prior; Reaped: never
/// restore a dead runtime).
#[derive(Debug, Clone, Copy)]
enum AbortFailDecision {
    Probe,
    Known(bool),
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
/// Round-3 review I-1: the phase refines the abort semantics — a kill
/// issued but unconfirmed (`KillInFlight`) defers the restore decision to
/// the Drop's detached cleanup (re-probe, then restore-only-a-confirmed-
/// live prior, repairing the lane claims — the fresh stamp the lane kill
/// took, the terminal's retained claim — to the restored generation).
/// `target_runtime`: a spawned-but-uncommitted target runtime is REAPED on
/// Drop (the cancellation-safety window between spawn and commit);
/// `target_spawn_watch`/`target_spawn_begun` cover the window INSIDE the
/// spawn await itself (an in-flight settle, or a fresh resume that already
/// registered its session).
struct HandoffGuard {
    runner: Arc<SessionHandoffRunner>,
    provider: String,
    session_id: String,
    operation_id: String,
    generation: u64,
    /// The prior owner captured at enter, WITH its Live generation
    /// (historical — the stop source; the restore's claim repairs fence at
    /// the record's current generation instead, whole-branch M-1).
    prior: Option<(OwnerIdentity, u64)>,
    prior_still_live: bool,
    prior_stop: PriorStopPhase,
    target_kind: RuntimeOwnerKind,
    target_runtime: Option<OwnerIdentity>,
    target_spawn_watch: Option<crate::terminal_tabs::HandoffSpawnWatch>,
    /// `true` once `start_target` was entered — gates the fresh-lane
    /// uncommitted-session sweep (never before: the prior may still be
    /// live on that lane).
    target_spawn_begun: bool,
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

    /// The target-half payload: the given target identity + spawn watch in
    /// place of the guard's own (already-taken) ones.
    fn abort_payload_with(
        &self,
        target: Option<OwnerIdentity>,
        spawn_watch: Option<crate::terminal_tabs::HandoffSpawnWatch>,
    ) -> AbortPayload {
        AbortPayload {
            provider: self.provider.clone(),
            session_id: self.session_id.clone(),
            operation_id: self.operation_id.clone(),
            generation: self.generation,
            prior: self.prior.clone(),
            target_kind: self.target_kind,
            target_spawn_begun: self.target_spawn_begun,
            target,
            spawn_watch,
        }
    }
}

impl Drop for HandoffGuard {
    fn drop(&mut self) {
        if self.disarmed {
            return;
        }
        let reactor = tokio::runtime::Handle::try_current();
        // b8ke focused round-3 review R3-6: whenever an uncommitted-target
        // cleanup is owed, the global fail is DEFERRED into the detached
        // cleanup — the record stays in this operation's `Handoff` (every
        // competing begin Blocked with the typed in-flight answer) until
        // the target's reap settles (the NotConfirmed continuation, or a
        // bounded kill). Only when NOTHING is owed (or no reactor exists —
        // runtime shutdown, nothing can run) does the sync fail below run.
        let target = self.target_runtime.take();
        let spawn_watch = self.target_spawn_watch.take();
        let owes_target_cleanup = target.is_some()
            || spawn_watch.is_some()
            || (self.target_spawn_begun && self.target_kind == RuntimeOwnerKind::FreshAgent);
        if let Ok(handle) = &reactor {
            if matches!(self.prior_stop, PriorStopPhase::KillInFlight) || owes_target_cleanup {
                // Round-3 review I-1 (prior-reap window): the kill was
                // issued but its confirmed reap was lost to the abort —
                // the detached cleanup re-probes the prior's liveness
                // first (a dying prior is never restored as Live) and
                // repairs the lane claims on a confirmed-live restore.
                let decision = match self.prior_stop {
                    PriorStopPhase::KillInFlight => AbortFailDecision::Probe,
                    PriorStopPhase::NotIssued => AbortFailDecision::Known(self.prior_still_live),
                    PriorStopPhase::Reaped => AbortFailDecision::Known(false),
                };
                let runner = Arc::clone(&self.runner);
                let payload = self.abort_payload_with(target, spawn_watch);
                self.disarmed = true;
                handle.spawn(async move {
                    runner.abort_cleanup(payload, decision).await;
                });
                return;
            }
        }
        // Sync fail: NotIssued restores the untouched prior (true); Reaped
        // never restores (false); KillInFlight with NO reactor (runtime
        // shutdown — nothing can be spawned) fails CLOSED to Vacant — never
        // restore a possibly-dying prior, and the OS reaps the children
        // with the process anyway.
        if matches!(self.prior_stop, PriorStopPhase::KillInFlight) {
            self.prior_still_live = false;
        }
        let fail_outcome = self.disarm_and_fail();
        // Whole-branch M-1 (the claim repairs): a SYNC-path restore must
        // also bring the lane claims (fresh stamp / terminal retained
        // claim) to the restored generation — the untouched prior's own
        // stamp still fences at its COMMIT generation, which the restored
        // record (at the handoff generation) no longer holds, so its
        // later kill/exit paths would never match without the repair.
        if matches!(fail_outcome, FailOutcome::RestoredPriorOwner) {
            if let Some((owner, _)) = self.prior.as_ref() {
                self.runner.repair_restored_prior_claims(
                    &self.provider,
                    &self.session_id,
                    owner,
                    self.generation,
                );
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
        // Round-3 review N-2: the typed code now matches the status (the
        // plan sketch's "BAD_REQUEST" read oddly for a 401).
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "ok": false,
                "error": { "code": "UNAUTHORIZED", "message": "unauthorized", "retryable": false }
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
    // b8ke delta review F7: a half-sent observed pair (exactly one of
    // epoch/generation) is the typed invalid-fence refusal — never a silent
    // downgrade to the unfenced legacy path. No handoff is spawned.
    let observed_epoch = body.get("observedEpoch").and_then(Value::as_u64);
    let observed_generation = body.get("observedGeneration").and_then(Value::as_u64);
    if let Err(err) = crate::ownership_lane::wire_fence(observed_epoch, observed_generation) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "ok": false,
                "error": { "code": err.code(), "message": err.message(), "retryable": false }
            })),
        );
    }
    let session_type = body
        .get("sessionType")
        .and_then(Value::as_str)
        .map(String::from);
    let mode = body.get("mode").and_then(Value::as_str).map(String::from);
    // b8ke delta review F5: the provider↔target validation, refused
    // PRE-SPAWN — a sessionType that is not one of the provider's canonical
    // fresh-agent types (or an ambiguous absent one), or a terminal mode
    // that does not match the provider, is a typed 400: the prior runtime is
    // never stopped, the coordinator never touched.
    if let Err(reason) = validate_handoff_target(
        &provider,
        target_kind,
        session_type.as_deref(),
        mode.as_deref(),
        &runner.cli_commands,
    ) {
        return typed_bad_request(&reason);
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
        observed_epoch,
        observed_generation,
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

/// The provider's canonical fresh-agent session types — the lane derivation
/// (`model_capabilities`'s `SessionType::runtime_provider` mapping, the same
/// one every lane and model-capability surface uses): freshcodex rides the
/// codex lane, freshopencode the opencode lane, and BOTH claude flavors
/// (freshclaude, kilroy) ride the claude lane.
pub(crate) fn canonical_session_types(provider: &str) -> Option<&'static [&'static str]> {
    match provider {
        "codex" => Some(&["freshcodex"]),
        "opencode" => Some(&["freshopencode"]),
        "claude" => Some(&["freshclaude", "kilroy"]),
        _ => None,
    }
}

/// b8ke delta review F5: validate the request's target against its provider
/// BEFORE any coordinator state change (the HTTP handler refuses pre-spawn
/// with the typed 400; [`SessionHandoffRunner::run`] re-checks at entry for
/// direct `spawn_handoff` callers). (a) a fresh-agent target's `sessionType`
/// must be one of the provider's canonical types — an ABSENT sessionType
/// resolves only when unambiguous (claude is two flavors: rejected — the
/// safer choice, consistent with the lane derivation that never maps a
/// claude session by provider alone); (b) a terminal target's `mode` must
/// be the provider's own CLI mode (the registry-row join every sessionRef
/// lookup uses: `mode == provider`) and a registered session-bearing mode.
/// A mismatch never stops the prior runtime, never bumps the generation,
/// and never spawns a blank wrong-provider CLI.
pub(crate) fn validate_handoff_target(
    provider: &str,
    target_kind: RuntimeOwnerKind,
    session_type: Option<&str>,
    mode: Option<&str>,
    cli_commands: &[freshell_platform::CliCommandSpec],
) -> Result<(), String> {
    match target_kind {
        RuntimeOwnerKind::FreshAgent => {
            let Some(canonical) = canonical_session_types(provider) else {
                return Err(format!(
                    "provider {provider:?} has no fresh-agent lane (expected codex | claude | opencode)"
                ));
            };
            match session_type {
                Some(st) if canonical.contains(&st) => Ok(()),
                Some(st) => Err(format!(
                    "sessionType {st:?} is not a {provider:?} fresh-agent session type \
                     (expected one of {canonical:?})"
                )),
                None if canonical.len() == 1 => Ok(()), // unambiguous: the provider's single flavor
                None => Err(format!(
                    "provider {provider:?} has multiple fresh-agent session types {canonical:?}; \
                     sessionType is required"
                )),
            }
        }
        RuntimeOwnerKind::Terminal => {
            let mode_ref = mode.unwrap_or(provider);
            if mode_ref != provider {
                return Err(format!(
                    "terminal mode {mode_ref:?} does not match provider {provider:?} (a handoff \
                     terminal target must run the provider's own CLI mode)"
                ));
            }
            if !cli_commands.iter().any(|spec| spec.name == mode_ref) {
                return Err(format!(
                    "unknown CLI mode {mode_ref:?} (a handoff terminal target must be a \
                     registered coding-CLI mode)"
                ));
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests;
