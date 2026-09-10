//! # Runtime-ownership coordinator (kata b8ke)
//!
//! One server-authoritative owner per canonical `(provider, sessionId)`,
//! shared by the terminal lane and every Fresh Agent provider. The
//! invariant: at most ONE writer may be `Starting` or `Live` for a key at
//! any moment, and every delayed lifecycle request carries the generation
//! it observed so a stale request can never recreate ownership after a
//! newer generation began.
//!
//! Design notes:
//! - Sync `std::sync::Mutex`, never held across an await; callers inject
//!   this registry exactly like `FreshAgentSessionLeases`
//!   (freshell-server/src/main.rs:318-321).
//! - The per-lane lease maps (`TerminalRegistry::session_ref_leases`,
//!   `FreshAgentSessionLeases`) remain as same-kind/TTL backstops; this
//!   registry is the CROSS-kind authority (and same-kind dedupe) whose
//!   claim happens FIRST in every lifecycle path.
//! - `generation` is per-key monotonic and never resets (Vacant keeps it),
//!   so "stale" is identity-of-generation, not wall clock.
//! - Stop path (round-1 review): `begin_stop` enters `Stopping` (blocking
//!   competing starts); the KILL happens while `Stopping`; `commit_stop`
//!   moves to `Vacant` only after the caller confirms the reap. A stop
//!   attempted during another operation's `Handoff` returns the typed
//!   `BlockedHandoff` — the caller must NOT kill. During `Starting` or
//!   `Stopping` the typed `NotLive` result carries the in-flight state and
//!   licenses NO kill: the in-flight operation (or the watchdog) owns the
//!   transition.
//! - Release fencing (round-1 review): watcher/TTL releases carry
//!   `(operation_id, generation, runtime identity)` and are no-ops on any
//!   mismatch — a delayed watcher can never erase a newer owner or an
//!   in-flight handoff. Exit-watcher events arriving while the state is
//!   `Handoff` are folded by the handoff runner (its awaited kill/reap is
//!   the single fold point); `release` is a no-op there by construction.
//! - Ticket discipline (round-1 review): create/resume claims ride an
//!   `OperationTicket` RAII guard (drop = typed fail); the
//!   `recover_stale_starts` watchdog is the backstop for leaked tickets.
//! - Boot epoch (round-2 review): fenced comparisons use `(epoch,
//!   generation)` — every registry instance mints an epoch at construction
//!   that is unique per boot BY CONSTRUCTION (never bare wall-clock
//!   milliseconds: rapid restarts or clock adjustments could reuse
//!   values). The default source mixes the once-per-process start instant
//!   (nanosecond resolution) with a per-mint process-global counter, so
//!   two mints in one process can never share an epoch (the mixing is
//!   injective per mint) and restarts separate on distinct start
//!   instants; for strict cross-restart uniqueness the host injects a
//!   persisted monotonic counter via
//!   [`RuntimeOwnershipRegistry::with_epoch`] (this crate stays I/O-free
//!   so tests never touch the filesystem). An observed pair whose epoch
//!   differs from the registry's is ALWAYS stale — a pre-restart request
//!   can never recreate ownership against a restarted registry.
//! - Watchdog cancellation (round-2 review): `recover_stale_starts` never
//!   flips a live spawn to `Vacant` underneath it — the sweep holds
//!   `Stopping` (blocking new claims), returns the operation's registered
//!   cancellation handle and partial-runtime identity, and only the host's
//!   abort → settle → kill → `commit_stop` sequence reopens the key.
//! - Every transition emits a diagnostic `tracing` event with the FULL
//!   join-critical field set (operation_id, provider/session_id, epoch,
//!   generation, old/new kind, runtime id/pid, transition, initiator,
//!   outcome, duration_ms, failure_reason) as EVENT fields
//!   (target-directive filters kill span fields; see
//!   crates/freshell-server/src/logging.rs:30-44) on the stable target
//!   `freshell_ownership`. Diagnostic, not audit-grade.
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};

/// `retry_after_ms` hint for Blocked outcomes (mirrors the lane leases).
pub const OWNERSHIP_RETRY_AFTER_MS: u64 = 1_000;

/// The once-per-process epoch seed: captured at the first registry mint
/// (nanosecond wall-clock at that instant). NOT the epoch itself — see
/// [`default_boot_epoch`].
static BOOT_SEED_NS: OnceLock<u64> = OnceLock::new();

/// Per-mint counter: distinguishes registry instances inside one process
/// BY CONSTRUCTION (the splitmix mix below is injective per mint for a
/// fixed seed, so two mints can never produce the same epoch).
static NEXT_MINT: AtomicU64 = AtomicU64::new(1);

/// Mint a boot epoch unique per registry construction (round-2 review:
/// never bare wall-clock milliseconds). Within a process the per-mint
/// counter plus the injective mix guarantees uniqueness; across restarts
/// the distinct first-mint instants separate the seeds (a collision needs
/// an exact 64-bit coincidence, ~2^-64). Hosts wanting strict
/// cross-restart uniqueness by construction inject a persisted monotonic
/// counter via [`RuntimeOwnershipRegistry::with_epoch`].
fn default_boot_epoch() -> u64 {
    let seed = *BOOT_SEED_NS.get_or_init(now_epoch_ns);
    let mint = NEXT_MINT.fetch_add(1, Ordering::Relaxed);
    mix_boot_epoch(seed, mint)
}

/// splitmix64 finalizer over the rotated seed XOR the mint counter —
/// allocation-free, avalanche-complete, and injective in `mint` for a
/// fixed `seed` (rotation, xor with the counter, the odd-constant
/// multiplies, and the xorshift mixes are all bijections on `u64`).
fn mix_boot_epoch(seed: u64, mint: u64) -> u64 {
    let mut z = seed.rotate_left(32) ^ mint;
    z = z.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

fn now_epoch_ns() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
}

/// Wall-clock milliseconds since the Unix epoch — for event `duration_ms`
/// fields ONLY (never for uniqueness; see [`default_boot_epoch`]).
fn now_epoch_ms() -> u64 {
    now_epoch_ns() / 1_000_000
}

/// The wire string for a kind (`"terminal"` | `"fresh-agent"`).
fn kind_wire(kind: &RuntimeOwnerKind) -> &'static str {
    match kind {
        RuntimeOwnerKind::Terminal => "terminal",
        RuntimeOwnerKind::FreshAgent => "fresh-agent",
    }
}

/// Runtime-identity match for the release fence: kind + terminal id (or
/// live session key) + pid must all agree with the watched runtime, and
/// the committing operation must agree (`owner.ownership_id`).
fn runtime_matches(owner: &OwnerIdentity, claim: &ReleaseClaim) -> bool {
    let Some(runtime) = claim.runtime.as_ref() else {
        return false;
    };
    owner.kind == runtime.kind
        && owner.terminal_id == runtime.terminal_id
        && owner.live_session_key == runtime.live_session_key
        && owner.pid == runtime.pid
        && owner.ownership_id.as_deref() == Some(claim.operation_id.as_str())
}

/// The generation a snapshot/replay consumer fences against (review M3):
/// for Live keys the Live STATE's own generation. A prior owner restored
/// by a failed handoff keeps its ORIGINAL generation in the Live state
/// while the record's generation was already bumped by the handoff, and
/// `begin_stop` compares stop fences against the Live state's generation —
/// so reporting the record's value for a restored key would leave a
/// snapshot-derived fence permanently stale (a StaleClaim loop: fail-closed
/// liveness corner, no safety violation). Remedy chosen over rolling the
/// record's generation back on restore: the record's generation is the
/// per-key monotonic counter (never resets — see the crate doc), and a
/// rollback would let distinct handoff eras reuse a generation number,
/// weakening the stale-request fence for every consumer. For every
/// non-Live state the record's generation always equals the state's own
/// (they are written together), so this only diverges for restored keys.
fn snapshot_generation(record: &SessionRecord) -> u64 {
    match &record.state {
        OwnershipState::Live { generation, .. } => *generation,
        _ => record.generation,
    }
}

impl OwnershipState {
    /// The recorded initiator of the in-flight operation (round-1 review
    /// observability: commit/fail/stop events emit it from the record).
    fn initiator(&self) -> Option<String> {
        match self {
            OwnershipState::Starting { initiator, .. }
            | OwnershipState::Handoff { initiator, .. }
            | OwnershipState::Stopping { initiator, .. } => Some(initiator.clone()),
            _ => None,
        }
    }

    /// The kind this state is (or is transitioning to), for old/new-kind
    /// event fields.
    fn kind(&self) -> Option<RuntimeOwnerKind> {
        match self {
            OwnershipState::Vacant => None,
            OwnershipState::Starting { kind, .. } => Some(*kind),
            OwnershipState::Live { owner, .. } => Some(owner.kind),
            OwnershipState::Handoff { to_kind, .. } => Some(*to_kind),
            OwnershipState::Stopping { owner, .. } => owner.as_ref().map(|o| o.kind),
        }
    }

    /// The record's `since_ms` (round-2 review: `Live` carries it too, so
    /// release/commit events include the terminal-transition duration the
    /// observability contract requires).
    fn since_ms(&self) -> Option<u64> {
        match self {
            OwnershipState::Vacant => None,
            OwnershipState::Live { since_ms, .. }
            | OwnershipState::Starting { since_ms, .. }
            | OwnershipState::Handoff { since_ms, .. }
            | OwnershipState::Stopping { since_ms, .. } => Some(*since_ms),
        }
    }
}

/// The delayed-request fence (round-2 review): the `(epoch, generation)`
/// pair a lifecycle request observed when it decided to act. A pair whose
/// epoch differs from the registry's boot epoch is ALWAYS stale.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObservedFence {
    pub epoch: u64,
    pub generation: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeOwnerKind {
    Terminal,
    FreshAgent,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionKey {
    pub provider: String,
    pub session_id: String,
}

impl SessionKey {
    pub fn new(provider: &str, session_id: &str) -> Self {
        Self {
            provider: provider.to_string(),
            session_id: session_id.to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnerIdentity {
    pub kind: RuntimeOwnerKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live_session_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ownership_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum OwnershipState {
    Vacant,
    Starting {
        kind: RuntimeOwnerKind,
        operation_id: String,
        generation: u64,
        initiator: String,
        since_ms: u64,
    },
    Live {
        owner: OwnerIdentity,
        generation: u64,
        since_ms: u64,
    },
    Handoff {
        prior: Option<(OwnerIdentity, u64)>,
        to_kind: RuntimeOwnerKind,
        operation_id: String,
        generation: u64,
        initiator: String,
        since_ms: u64,
    },
    Stopping {
        owner: Option<OwnerIdentity>,
        operation_id: String,
        generation: u64,
        initiator: String,
        since_ms: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BeginOutcome {
    /// The caller holds the lease; it MUST end with `commit_live` (or `fail`).
    Granted { generation: u64 },
    /// A live runtime of the SAME kind exists — adopt/attach, never spawn.
    AdoptLive {
        owner: OwnerIdentity,
        generation: u64,
    },
    /// A live runtime of the OTHER kind owns the key — typed conflict.
    OwnedByOtherKind {
        owner: OwnerIdentity,
        generation: u64,
    },
    /// A lifecycle operation is in flight (Starting/Handoff/Stopping).
    Blocked {
        state: OwnershipState,
        retry_after_ms: u64,
    },
    /// The request observed a stale fence — an older generation within the
    /// current boot epoch, or any pair from a DIFFERENT (pre-restart) epoch.
    StaleGeneration {
        current_epoch: u64,
        current_generation: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommitOutcome {
    Committed,
    StaleGeneration { current_generation: u64 },
    ForeignOperation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailVacantReason {
    /// The failed operation had no prior owner to restore.
    NoPrior,
    /// The prior runtime was reaped/confirmed dead — never record a dead
    /// runtime as Live (round-1 review).
    PriorNotLive,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FailOutcome {
    /// A Starting operation was released (key now Vacant).
    Released,
    /// A failed handoff restored the prior CONFIRMED-LIVE owner.
    RestoredPriorOwner,
    /// The key ends Vacant with the typed reason (no prior, or prior dead).
    Vacant {
        reason: FailVacantReason,
    },
    ForeignOperation,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopOutcome {
    Granted {
        generation: u64,
    },
    /// The key is not Live. When the carried state is `Vacant` the caller
    /// may still kill what it observed (idempotent — a leftover child the
    /// registry never knew) but MUST skip `commit_stop`. When the carried
    /// state is `Starting` or `Stopping` an operation is in flight and the
    /// caller MUST NOT kill — the in-flight operation (or the watchdog)
    /// owns the transition; retry after it settles (round-2 review).
    NotLive {
        state: OwnershipState,
    },
    /// An in-flight handoff owns the transition (round-1 review): the caller
    /// must NOT kill — typed, retryable after the handoff settles.
    BlockedHandoff {
        state: OwnershipState,
        retry_after_ms: u64,
    },
    /// The stop claim mismatched the current owner (kind/runtime identity,
    /// epoch, or generation — round-2 review): the caller must NOT kill.
    /// Typed, retryable after refreshing the observed fence.
    StaleClaim {
        current_epoch: u64,
        current_generation: u64,
        state: OwnershipState,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnershipSnapshot {
    /// The registry's boot epoch (round-2 review): the snapshot's
    /// generation is only meaningful fenced against this epoch.
    pub epoch: u64,
    pub generation: u64,
    pub state: OwnershipState,
}

/// The fencing claim every watcher/TTL release must carry (round-1 review):
/// the operation that committed the runtime, the generation it committed
/// under, and the runtime identity. `runtime` is `None` only for the zombie
/// `Starting`-ticket recovery (nothing spawned yet — the operation id and
/// generation fence it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseClaim {
    pub operation_id: String,
    pub generation: u64,
    pub runtime: Option<OwnerIdentity>,
}

/// The FENCED stop claim (round-2 review): `begin_stop` requires the
/// stopper's believed owner (expected kind + runtime identity, matched with
/// the `runtime_matches` discipline) and the `(epoch, generation)` it
/// observed. Any mismatch against the current `Live` record is the typed
/// `StopOutcome::StaleClaim` — the caller must NOT kill.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StopClaim {
    pub expected_kind: RuntimeOwnerKind,
    pub expected_runtime: Option<OwnerIdentity>,
    pub observed: ObservedFence,
}

/// A watchdog-recovered over-aged `Starting` ticket (round-1 review;
/// cancellation-first per round-2). `cancellation` is the abort handle the
/// operation registered; `settle` resolves once the aborted task has
/// unwound (the host awaits it, bounded); `partial_runtime` is the child
/// identity it registered once spawned (the host kills it during settle).
pub struct RecoveredStart {
    pub provider: String,
    pub session_id: String,
    pub operation_id: String,
    pub generation: u64,
    pub kind: RuntimeOwnerKind,
    pub initiator: String,
    pub cancellation: Option<Arc<dyn Fn() + Send + Sync>>,
    pub settle: Option<Box<dyn std::future::Future<Output = ()> + Send>>,
    pub partial_runtime: Option<OwnerIdentity>,
}

/// One replayed owner record for the `ready.runtimeOwners` handshake field
/// (kata b8ke reconnect-owner discovery, T1 rec A1). `owner_kind` is the
/// wire string "terminal" | "fresh-agent" | "vacant".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeOwnerReplayRecord {
    pub provider: String,
    pub session_id: String,
    /// The registry's boot epoch (round-2 review) — replayed so the client
    /// resets its generation state on epoch change instead of ignoring
    /// newer generations.
    pub epoch: u64,
    pub generation: u64,
    /// "terminal" | "fresh-agent" | "vacant"
    pub owner_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
}

/// Per-key registry record. Hand-implemented `Default` (a `Vacant` record at
/// generation 0): the boxed settle future admits no `Debug`/`Clone` derive,
/// and `OwnershipState` has no derive-able default.
struct SessionRecord {
    generation: u64,
    state: OwnershipState,
    /// The in-flight `Starting` operation's registered abort handle, settle
    /// future, and partial-runtime identity (round-2 watchdog cancellation).
    cancellation: Option<Arc<dyn Fn() + Send + Sync>>,
    settle: Option<Box<dyn std::future::Future<Output = ()> + Send>>,
    partial_runtime: Option<OwnerIdentity>,
}

impl Default for SessionRecord {
    fn default() -> Self {
        Self {
            generation: 0,
            state: OwnershipState::Vacant,
            cancellation: None,
            settle: None,
            partial_runtime: None,
        }
    }
}

/// RAII claim guard for create/resume tickets (round-1 review). Constructed
/// on `Granted`; `Drop` without `disarm()` performs the typed `fail`
/// releasing the claim, so a panicked spawn cannot wedge a session in
/// `Starting`. After a successful `commit_live` the record is `Live` and a
/// forgotten `disarm()` is a safe typed no-op (ForeignOperation).
pub struct OperationTicket {
    registry: Arc<RuntimeOwnershipRegistry>,
    provider: String,
    session_id: String,
    operation_id: String,
    kind: RuntimeOwnerKind,
    generation: u64,
    initiator: String,
    disarmed: bool,
}

impl OperationTicket {
    /// Wrap an already-`Granted` claim (the caller holds the `Granted`
    /// generation from its `begin_start`/`begin_handoff` call). This never
    /// claims by itself — pair it with the grant that minted the claim.
    pub fn new(
        registry: Arc<RuntimeOwnershipRegistry>,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        kind: RuntimeOwnerKind,
        generation: u64,
        initiator: &str,
    ) -> Self {
        Self {
            registry,
            provider: provider.to_string(),
            session_id: session_id.to_string(),
            operation_id: operation_id.to_string(),
            kind,
            generation,
            initiator: initiator.to_string(),
            disarmed: false,
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }

    /// Keep the claim alive past this guard's drop (the holder completed
    /// its `commit_live`, or transferred ownership of the claim).
    pub fn disarm(&mut self) {
        self.disarmed = true;
    }
}

impl Drop for OperationTicket {
    fn drop(&mut self) {
        if self.disarmed {
            return;
        }
        // The ticket's whole purpose is surviving a panicked holder: run
        // the typed fail inside catch_unwind so a panic WHILE unwinding
        // (e.g. a poisoned lock) cannot abort the process — a panic raised
        // during another panic's unwind aborts.
        let failed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.registry.fail(
                &self.provider,
                &self.session_id,
                &self.operation_id,
                self.generation,
                /* prior_confirmed_live: */ false,
            )
        }));
        match failed {
            Ok(outcome) => tracing::warn!(target: "freshell_ownership",
                event = "ownership.ticket.dropped_unarmed",
                operation_id = %self.operation_id,
                provider = %self.provider, session_id = %self.session_id,
                initiator = %self.initiator, kind = ?self.kind,
                epoch = self.registry.boot_epoch(), generation = self.generation,
                outcome = ?outcome, failure_reason = "TICKET_DROPPED"),
            Err(_) => tracing::error!(target: "freshell_ownership",
                event = "ownership.ticket.fail_panicked",
                operation_id = %self.operation_id,
                provider = %self.provider, session_id = %self.session_id,
                initiator = %self.initiator,
                epoch = self.registry.boot_epoch(), generation = self.generation,
                outcome = "fail_panicked", failure_reason = "TICKET_FAIL_PANICKED"),
        }
    }
}

/// The ONE server-wide runtime-ownership coordinator. Mint exactly one per
/// server boot (freshell-server::main) and inject it into every lifecycle
/// lane; the per-boot epoch is minted at construction (see
/// [`default_boot_epoch`]) and can be injected explicitly via
/// [`RuntimeOwnershipRegistry::with_epoch`] (a persisted monotonic counter
/// gives strict cross-restart uniqueness by construction).
pub struct RuntimeOwnershipRegistry {
    epoch: u64,
    inner: Mutex<HashMap<SessionKey, SessionRecord>>,
}

impl Default for RuntimeOwnershipRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl RuntimeOwnershipRegistry {
    /// Mint a registry with a default boot epoch (unique per construction;
    /// see [`default_boot_epoch`]).
    pub fn new() -> Self {
        Self::with_epoch(default_boot_epoch())
    }

    /// Mint a registry with an injected boot epoch — the host's hook for a
    /// persisted monotonic counter when strict cross-restart uniqueness is
    /// required; tests use it to simulate distinct boots.
    pub fn with_epoch(epoch: u64) -> Self {
        Self {
            epoch,
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// The boot epoch (round-2 review): fenced comparisons use
    /// `(epoch, generation)`; an observed pair from a different epoch is
    /// always stale.
    pub fn boot_epoch(&self) -> u64 {
        self.epoch
    }

    /// Atomically begin a start/attach/resume of `kind` for
    /// `(provider, session_id)`. `observed` is the `(epoch, generation)`
    /// fence a DELAYED request saw when it decided to act; `None` means the
    /// caller has no stale risk to fence (legacy unfenced senders still
    /// pass the same-kind/cross-kind checks — the coordinator closes the
    /// vacant-state race either way). `initiator` identifies the initiating
    /// client/device/lane for the transition events. Entering `Starting`
    /// increments the generation. Re-claiming a `Starting`/`Handoff` held
    /// by the SAME operation and kind is Granted (the handoff target
    /// continuation relies on this).
    #[allow(clippy::too_many_arguments)] // The plan-frozen coordinator surface (Tasks 3-10 consume it).
    pub fn begin_start(
        &self,
        provider: &str,
        session_id: &str,
        kind: RuntimeOwnerKind,
        operation_id: &str,
        observed: Option<ObservedFence>,
        initiator: &str,
        now_ms: u64,
    ) -> BeginOutcome {
        let mut inner = self.inner.lock().expect("ownership lock poisoned");
        let key = SessionKey::new(provider, session_id);
        // Fence check BEFORE creating the record: a stale request must not
        // create ownership — not even a Vacant replay entry for a key it
        // never legitimately touched.
        if let Some(fence) = observed {
            let current_generation = inner.get(&key).map_or(0, |record| record.generation);
            if fence.epoch != self.epoch || fence.generation < current_generation {
                tracing::warn!(target: "freshell_ownership",
                    event = "ownership.begin_start.stale_generation",
                    operation_id, provider, session_id, initiator,
                    observed_epoch = fence.epoch, observed_generation = fence.generation,
                    epoch = self.epoch, generation = current_generation,
                    outcome = "refused", failure_reason = "STALE_GENERATION");
                return BeginOutcome::StaleGeneration {
                    current_epoch: self.epoch,
                    current_generation,
                };
            }
        }
        let record = inner.entry(key).or_default();
        match record.state.clone() {
            OwnershipState::Vacant => {
                // Every entry into `Starting` goes through this arm, so
                // resetting the registration fields here is the single
                // choke point guaranteeing a later Starting operation can
                // never inherit its DEAD predecessor's cancellation/settle/
                // partial-runtime handles (a predecessor that exited via
                // fail/commit_live/force_release leaves them behind; only
                // the sweep takes them) — the watchdog's RecoveredStart
                // must only ever carry handles the CURRENT resident
                // registered itself.
                record.cancellation = None;
                record.settle = None;
                record.partial_runtime = None;
                record.generation += 1;
                record.state = OwnershipState::Starting {
                    kind,
                    operation_id: operation_id.to_string(),
                    generation: record.generation,
                    initiator: initiator.to_string(),
                    since_ms: now_ms,
                };
                tracing::info!(target: "freshell_ownership",
                    event = "ownership.start.begin", operation_id, provider, session_id,
                    initiator, to_kind = ?kind,
                    epoch = self.epoch, generation = record.generation, outcome = "granted");
                BeginOutcome::Granted {
                    generation: record.generation,
                }
            }
            OwnershipState::Starting {
                kind: held_kind,
                operation_id: held_op,
                generation,
                ..
            } if held_kind == kind && held_op == operation_id => {
                BeginOutcome::Granted { generation }
            }
            OwnershipState::Handoff {
                to_kind,
                operation_id: ho_op,
                generation,
                ..
            } if to_kind == kind && ho_op == operation_id => BeginOutcome::Granted { generation },
            OwnershipState::Live {
                owner, generation, ..
            } if owner.kind == kind => BeginOutcome::AdoptLive { owner, generation },
            OwnershipState::Live {
                owner, generation, ..
            } => BeginOutcome::OwnedByOtherKind { owner, generation },
            state => BeginOutcome::Blocked {
                state,
                retry_after_ms: OWNERSHIP_RETRY_AFTER_MS,
            },
        }
    }

    /// Atomically enter `Handoff` (incrementing the generation), capturing
    /// the prior live owner for restore-on-failure. Granted from `Vacant`
    /// (no prior to stop) and from `Live` of any kind; `Starting` /
    /// `Handoff` / `Stopping` block (a handoff from `Starting` is Blocked
    /// BY DESIGN — round-1 review test alignment).
    #[allow(clippy::too_many_arguments)] // The plan-frozen coordinator surface (Tasks 3-10 consume it).
    pub fn begin_handoff(
        &self,
        provider: &str,
        session_id: &str,
        to_kind: RuntimeOwnerKind,
        operation_id: &str,
        observed: Option<ObservedFence>,
        initiator: &str,
        now_ms: u64,
    ) -> BeginOutcome {
        let mut inner = self.inner.lock().expect("ownership lock poisoned");
        let key = SessionKey::new(provider, session_id);
        // Fence check BEFORE creating the record (same discipline as
        // begin_start: a stale request creates nothing).
        if let Some(fence) = observed {
            let current_generation = inner.get(&key).map_or(0, |record| record.generation);
            if fence.epoch != self.epoch || fence.generation < current_generation {
                tracing::warn!(target: "freshell_ownership",
                    event = "ownership.begin_handoff.stale_generation",
                    operation_id, provider, session_id, initiator,
                    observed_epoch = fence.epoch, observed_generation = fence.generation,
                    epoch = self.epoch, generation = current_generation,
                    outcome = "refused", failure_reason = "STALE_GENERATION");
                return BeginOutcome::StaleGeneration {
                    current_epoch: self.epoch,
                    current_generation,
                };
            }
        }
        let record = inner.entry(key).or_default();
        match record.state.clone() {
            OwnershipState::Vacant => {
                record.generation += 1;
                record.state = OwnershipState::Handoff {
                    prior: None,
                    to_kind,
                    operation_id: operation_id.to_string(),
                    generation: record.generation,
                    initiator: initiator.to_string(),
                    since_ms: now_ms,
                };
                tracing::info!(target: "freshell_ownership",
                    event = "ownership.handoff.begin", operation_id, provider, session_id,
                    initiator, to_kind = ?to_kind,
                    epoch = self.epoch, generation = record.generation, outcome = "granted");
                BeginOutcome::Granted {
                    generation: record.generation,
                }
            }
            OwnershipState::Live {
                owner, generation, ..
            } => {
                let prior = (owner.clone(), generation);
                record.generation += 1;
                record.state = OwnershipState::Handoff {
                    prior: Some(prior),
                    to_kind,
                    operation_id: operation_id.to_string(),
                    generation: record.generation,
                    initiator: initiator.to_string(),
                    since_ms: now_ms,
                };
                tracing::info!(target: "freshell_ownership",
                    event = "ownership.handoff.begin", operation_id, provider, session_id,
                    initiator, from_kind = ?owner.kind, to_kind = ?to_kind,
                    runtime_id = ?owner.terminal_id, pid = ?owner.pid,
                    epoch = self.epoch, generation = record.generation, outcome = "granted");
                BeginOutcome::Granted {
                    generation: record.generation,
                }
            }
            state => BeginOutcome::Blocked {
                state,
                retry_after_ms: OWNERSHIP_RETRY_AFTER_MS,
            },
        }
    }

    /// Commit a live runtime. Legal from this operation's `Starting`, or
    /// from this operation's `Handoff` (the target writer commit —
    /// generation retained; the handoff runner is the SINGLE commit
    /// authority, round-1 review: target paths invoked under-ticket skip
    /// their own commit). A stale generation commits nothing: the caller
    /// must tear down its own child. Stamps `ownership_id` from the
    /// committing operation (the release fence key) when the caller left
    /// it `None`.
    pub fn commit_live(
        &self,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        generation: u64,
        mut owner: OwnerIdentity,
    ) -> CommitOutcome {
        let mut inner = self.inner.lock().expect("ownership lock poisoned");
        let key = SessionKey::new(provider, session_id);
        let Some(record) = inner.get_mut(&key) else {
            return CommitOutcome::ForeignOperation;
        };
        if generation != record.generation {
            // A stale-generation commit is a typed, anticipated race
            // outcome (the delayed caller tears down its own child) —
            // warn on the crate's diagnostic target; error!/invariant is
            // reserved for genuine contract violations (e.g.
            // force_release during Handoff below).
            tracing::warn!(target: "freshell_ownership",
                event = "ownership.commit_live.stale_generation",
                operation_id, provider, session_id,
                epoch = self.epoch, generation, current_generation = record.generation,
                outcome = "refused", failure_reason = "STALE_GENERATION");
            return CommitOutcome::StaleGeneration {
                current_generation: record.generation,
            };
        }
        let initiator = record.state.initiator().unwrap_or_default();
        let old_kind = record.state.kind();
        let since_ms = record.state.since_ms();
        match record.state.clone() {
            OwnershipState::Starting {
                operation_id: op, ..
            } if op == operation_id => {}
            OwnershipState::Handoff {
                operation_id: op,
                to_kind,
                ..
            } if op == operation_id && to_kind == owner.kind => {}
            _ => return CommitOutcome::ForeignOperation,
        }
        if owner.ownership_id.is_none() {
            owner.ownership_id = Some(operation_id.to_string());
        }
        let duration_ms = since_ms
            .map(|s| now_epoch_ms().saturating_sub(s))
            .unwrap_or(0);
        record.state = OwnershipState::Live {
            owner: owner.clone(),
            generation,
            since_ms: now_epoch_ms(),
        };
        tracing::info!(target: "freshell_ownership",
            event = "ownership.live.commit", operation_id, provider, session_id,
            initiator, from_kind = ?old_kind, to_kind = ?owner.kind,
            runtime_id = ?owner.terminal_id,
            live_session_key = ?owner.live_session_key, pid = ?owner.pid,
            epoch = self.epoch, generation, duration_ms, outcome = "committed");
        CommitOutcome::Committed
    }

    /// Fail an in-flight operation: `Starting` → Vacant; `Handoff` → restore
    /// the prior owner ONLY when the caller confirms it is still live
    /// (`prior_confirmed_live: true`) — a reaped/confirmed-dead prior ends
    /// `Vacant { reason: PriorNotLive }` (never record a dead runtime as
    /// Live, round-1 review). Foreign operations are a typed no-op.
    pub fn fail(
        &self,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        generation: u64,
        prior_confirmed_live: bool,
    ) -> FailOutcome {
        let mut inner = self.inner.lock().expect("ownership lock poisoned");
        let key = SessionKey::new(provider, session_id);
        let Some(record) = inner.get_mut(&key) else {
            return FailOutcome::ForeignOperation;
        };
        if generation != record.generation {
            return FailOutcome::ForeignOperation;
        }
        let initiator = record.state.initiator().unwrap_or_default();
        match record.state.clone() {
            OwnershipState::Starting {
                operation_id: op,
                kind,
                since_ms,
                ..
            } if op == operation_id => {
                record.state = OwnershipState::Vacant;
                tracing::warn!(target: "freshell_ownership",
                    event = "ownership.start.failed", operation_id, provider, session_id,
                    initiator, from_kind = ?kind,
                    epoch = self.epoch, generation, outcome = "released",
                    duration_ms = now_epoch_ms().saturating_sub(since_ms),
                    failure_reason = "START_FAILED");
                FailOutcome::Released
            }
            OwnershipState::Handoff {
                operation_id: op,
                prior,
                to_kind,
                since_ms,
                ..
            } if op == operation_id => {
                let duration_ms = now_epoch_ms().saturating_sub(since_ms);
                match prior {
                    Some((owner, gen)) if prior_confirmed_live => {
                        record.state = OwnershipState::Live {
                            owner: owner.clone(),
                            generation: gen,
                            since_ms: now_epoch_ms(),
                        };
                        tracing::warn!(target: "freshell_ownership",
                            event = "ownership.handoff.failed", operation_id, provider, session_id,
                            initiator, from_kind = ?owner.kind, to_kind = ?to_kind,
                            runtime_id = ?owner.terminal_id, pid = ?owner.pid,
                            epoch = self.epoch, generation,
                            outcome = "restored_prior_owner", duration_ms,
                            failure_reason = "HANDOFF_FAILED");
                        FailOutcome::RestoredPriorOwner
                    }
                    _ => {
                        let reason = if prior.is_some() {
                            FailVacantReason::PriorNotLive
                        } else {
                            FailVacantReason::NoPrior
                        };
                        record.state = OwnershipState::Vacant;
                        tracing::warn!(target: "freshell_ownership",
                            event = "ownership.handoff.failed", operation_id, provider, session_id,
                            initiator, from_kind = ?prior.map(|(o, _)| o.kind), to_kind = ?to_kind,
                            epoch = self.epoch, generation, outcome = "vacant", duration_ms,
                            failure_reason = ?reason);
                        FailOutcome::Vacant { reason }
                    }
                }
            }
            _ => FailOutcome::ForeignOperation,
        }
    }

    /// Begin an explicit stop (kill): `Live` → `Stopping` (generation+1),
    /// blocking competing starts while the kill is confirmed. The KILL
    /// happens while `Stopping`; `commit_stop` moves to `Vacant` only after
    /// the caller confirms the reap (round-1 review). `NotLive` means the
    /// key is not Live (see the variant docs — in-flight states license NO
    /// kill). `BlockedHandoff` means an in-flight handoff owns the
    /// transition: the caller must NOT kill. FENCED (round-2 review): the
    /// caller carries a `StopClaim` — expected kind/runtime identity PLUS
    /// the observed `(epoch, generation)`; any mismatch (ownership moved
    /// to a different runtime, a different generation, or a pre-restart
    /// epoch) is the typed `StaleClaim` and the caller must NOT kill.
    pub fn begin_stop(
        &self,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        claim: &StopClaim,
        initiator: &str,
        now_ms: u64,
    ) -> StopOutcome {
        let mut inner = self.inner.lock().expect("ownership lock poisoned");
        let key = SessionKey::new(provider, session_id);
        let Some(record) = inner.get_mut(&key) else {
            return StopOutcome::NotLive {
                state: OwnershipState::Vacant,
            };
        };
        match record.state.clone() {
            OwnershipState::Live {
                owner, generation, ..
            } => {
                let identity_mismatch = claim.expected_kind != owner.kind
                    || claim
                        .expected_runtime
                        .as_ref()
                        .map(|expected| {
                            expected.kind != owner.kind
                                || expected.terminal_id != owner.terminal_id
                                || expected.live_session_key != owner.live_session_key
                                || expected.pid != owner.pid
                        })
                        .unwrap_or(false);
                if claim.observed.epoch != self.epoch
                    || claim.observed.generation != generation
                    || identity_mismatch
                {
                    tracing::warn!(target: "freshell_ownership",
                        event = "ownership.stop.begin", operation_id, provider, session_id,
                        initiator, from_kind = ?owner.kind, to_kind = ?claim.expected_kind,
                        runtime_id = ?owner.terminal_id, pid = ?owner.pid,
                        epoch = self.epoch, generation,
                        outcome = "refused", failure_reason = "STALE_STOP_CLAIM");
                    return StopOutcome::StaleClaim {
                        current_epoch: self.epoch,
                        // The Live STATE's generation — the exact value a
                        // refreshed stop fence must carry to satisfy
                        // begin_stop (M3: for a restored prior owner it is
                        // lower than the record's bumped generation).
                        current_generation: generation,
                        state: record.state.clone(),
                    };
                }
                record.generation += 1;
                record.state = OwnershipState::Stopping {
                    owner: Some(owner.clone()),
                    operation_id: operation_id.to_string(),
                    generation: record.generation,
                    initiator: initiator.to_string(),
                    since_ms: now_ms,
                };
                tracing::info!(target: "freshell_ownership",
                    event = "ownership.stop.begin", operation_id, provider, session_id,
                    initiator, from_kind = ?owner.kind,
                    runtime_id = ?owner.terminal_id, pid = ?owner.pid,
                    epoch = self.epoch, generation = record.generation, outcome = "granted");
                StopOutcome::Granted {
                    generation: record.generation,
                }
            }
            OwnershipState::Handoff { .. } => StopOutcome::BlockedHandoff {
                state: record.state.clone(),
                retry_after_ms: OWNERSHIP_RETRY_AFTER_MS,
            },
            state => StopOutcome::NotLive { state },
        }
    }

    /// Confirm a stop AFTER the reap: `Stopping{op}` → `Vacant` (generation
    /// preserved). Callers must only invoke this once the runtime's death
    /// is confirmed (round-1 review: never Vacant before the reap).
    pub fn commit_stop(
        &self,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        generation: u64,
    ) -> CommitOutcome {
        let mut inner = self.inner.lock().expect("ownership lock poisoned");
        let key = SessionKey::new(provider, session_id);
        let Some(record) = inner.get_mut(&key) else {
            return CommitOutcome::ForeignOperation;
        };
        if generation != record.generation {
            return CommitOutcome::StaleGeneration {
                current_generation: record.generation,
            };
        }
        match record.state.clone() {
            OwnershipState::Stopping {
                operation_id: op,
                owner,
                since_ms,
                initiator,
                ..
            } if op == operation_id => {
                let duration_ms = now_epoch_ms().saturating_sub(since_ms);
                record.state = OwnershipState::Vacant;
                tracing::info!(target: "freshell_ownership",
                    event = "ownership.stop.commit", operation_id, provider, session_id,
                    initiator, from_kind = ?owner.as_ref().map(|o| o.kind),
                    runtime_id = ?owner.as_ref().and_then(|o| o.terminal_id.clone()),
                    pid = ?owner.as_ref().and_then(|o| o.pid),
                    epoch = self.epoch, generation, outcome = "committed", duration_ms);
                CommitOutcome::Committed
            }
            _ => CommitOutcome::ForeignOperation,
        }
    }

    /// Exit-watcher hook (round-1 review: FENCED). `Live` → `Vacant` only
    /// when the record still matches the watched runtime EXACTLY — same
    /// operation id (`owner.ownership_id`), same generation, same runtime
    /// identity (kind + terminal_id/live_session_key + pid). A newer owner,
    /// a different generation, or an in-flight handoff makes this a typed
    /// no-op (the handoff runner folds exit events itself — its awaited
    /// kill/reap is the single fold point).
    pub fn release(&self, provider: &str, session_id: &str, claim: &ReleaseClaim, initiator: &str) {
        let mut inner = self.inner.lock().expect("ownership lock poisoned");
        let key = SessionKey::new(provider, session_id);
        if let Some(record) = inner.get_mut(&key) {
            if let OwnershipState::Live {
                owner,
                generation,
                since_ms,
            } = record.state.clone()
            {
                if runtime_matches(&owner, claim) && generation == claim.generation {
                    let duration_ms = now_epoch_ms().saturating_sub(since_ms);
                    record.state = OwnershipState::Vacant;
                    // Round-2 review: the released event reports the
                    // transition to Vacant CORRECTLY — `from_kind` is the
                    // released owner's kind; there is NO `to_kind` (no new
                    // runtime kind exists) — and it carries the
                    // terminal-transition `duration_ms`.
                    tracing::info!(target: "freshell_ownership",
                        event = "ownership.released", provider, session_id,
                        operation_id = %claim.operation_id, initiator,
                        from_kind = ?owner.kind,
                        runtime_id = ?owner.terminal_id, pid = ?owner.pid,
                        epoch = self.epoch, generation, duration_ms,
                        outcome = "released");
                } else {
                    tracing::warn!(target: "freshell_ownership",
                        event = "ownership.release.fenced_noop", provider, session_id,
                        operation_id = %claim.operation_id, initiator,
                        from_kind = ?owner.kind,
                        claim_generation = claim.generation, generation,
                        epoch = self.epoch,
                        outcome = "no_op", failure_reason = "RELEASE_FENCE_MISMATCH");
                }
            }
        }
    }

    /// Only after the holder's entire process tree death was confirmed
    /// (the lane TTL paths' kill-before-release contract). Round-1 review:
    /// FENCED — fires only when the current record still matches the
    /// confirmed-dead runtime (Live owner, or Stopping owner, matched on
    /// operation id + generation + runtime identity) or the claimed
    /// zombie `Starting` ticket (operation id + generation). NEVER fires
    /// during a `Handoff` (invariant log) and never erases a newer owner.
    pub fn force_release_for_confirmed_kill(
        &self,
        provider: &str,
        session_id: &str,
        claim: &ReleaseClaim,
        initiator: &str,
    ) {
        let mut inner = self.inner.lock().expect("ownership lock poisoned");
        let key = SessionKey::new(provider, session_id);
        let Some(record) = inner.get_mut(&key) else {
            return;
        };
        let matched = match record.state.clone() {
            OwnershipState::Handoff { .. } => {
                tracing::error!(target: "invariant", provider, session_id,
                    operation_id = %claim.operation_id, initiator,
                    "ownership.force_release.refused_during_handoff: the handoff runner owns the transition");
                false
            }
            OwnershipState::Live {
                owner, generation, ..
            } => runtime_matches(&owner, claim) && generation == claim.generation,
            OwnershipState::Stopping {
                owner,
                operation_id,
                generation,
                ..
            } => {
                operation_id == claim.operation_id
                    && generation == claim.generation
                    && owner
                        .map(|o| runtime_matches(&o, claim))
                        .unwrap_or(claim.runtime.is_none())
            }
            OwnershipState::Starting {
                operation_id,
                generation,
                ..
            } => {
                operation_id == claim.operation_id
                    && generation == claim.generation
                    && claim.runtime.is_none()
            }
            OwnershipState::Vacant => false,
        };
        if matched {
            let from_kind = record.state.kind();
            record.state = OwnershipState::Vacant;
            tracing::warn!(target: "freshell_ownership",
                event = "ownership.force_released", provider, session_id,
                operation_id = %claim.operation_id, initiator,
                from_kind = ?from_kind,
                epoch = self.epoch, generation = claim.generation,
                outcome = "released", failure_reason = "CONFIRMED_KILL");
        }
    }

    /// Register the in-flight `Starting` operation's abort + settle handles
    /// (round-2 review watchdog cancellation): the spawn task registers
    /// `abort` immediately after wrapping its Granted claim in an
    /// `OperationTicket` (`Arc<dyn Fn()>` — the tokio `JoinHandle::abort`
    /// is sync-callable; the crate stays tokio-free) and `settle` as a
    /// future that resolves once the (aborted) task has unwound — the lane
    /// builds it from its JoinHandle; the watchdog host `.await`s it,
    /// bounded. Fenced to the operation id + generation; a stale
    /// registration is a typed no-op.
    pub fn register_start_cancellation(
        &self,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        generation: u64,
        abort: Arc<dyn Fn() + Send + Sync>,
        settle: Box<dyn std::future::Future<Output = ()> + Send>,
    ) {
        let mut inner = self.inner.lock().expect("ownership lock poisoned");
        if let Some(record) = inner.get_mut(&SessionKey::new(provider, session_id)) {
            if let OwnershipState::Starting {
                operation_id: op,
                generation: gen,
                ..
            } = &record.state
            {
                if op == operation_id && *gen == generation {
                    record.cancellation = Some(abort);
                    record.settle = Some(settle);
                }
            }
        }
    }

    /// Register the in-flight `Starting` operation's partial-runtime
    /// identity (round-2 review): called the moment the spawn produced
    /// its child (sidecar/PTY) but before `commit_live`, so the watchdog
    /// host can kill it during settle. Fenced to the operation id +
    /// generation.
    pub fn register_partial_runtime(
        &self,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        generation: u64,
        owner: OwnerIdentity,
    ) {
        let mut inner = self.inner.lock().expect("ownership lock poisoned");
        if let Some(record) = inner.get_mut(&SessionKey::new(provider, session_id)) {
            if let OwnershipState::Starting {
                operation_id: op,
                generation: gen,
                ..
            } = &record.state
            {
                if op == operation_id && *gen == generation {
                    record.partial_runtime = Some(owner);
                }
            }
        }
    }

    /// The bounded Starting-state timeout watchdog, CANCELLATION-FIRST
    /// (round-2 review: the sweep never flips a still-running spawn to
    /// `Vacant` underneath it — that would grant a second writer while the
    /// first keeps spawning). An over-aged `Starting` record transitions to
    /// `Stopping { owner: partial_runtime, operation_id, generation, .. }`
    /// (generation preserved; new claims are Blocked during the settle
    /// window — the existing stop-path semantics), and the returned
    /// `RecoveredStart` carries the registered cancellation handle and
    /// partial-runtime identity. The HOST (Task 3's main.rs: 5s sweep, 30s
    /// max age) then aborts the operation, awaits its settle, kills the
    /// registered partial runtime if any, and finishes with `commit_stop`
    /// → `Vacant` + the typed `ownership.start.recovered` failure log.
    pub fn recover_stale_starts(&self, now_ms: u64, max_age_ms: u64) -> Vec<RecoveredStart> {
        let mut inner = self.inner.lock().expect("ownership lock poisoned");
        let mut recovered = Vec::new();
        for (key, record) in inner.iter_mut() {
            if let OwnershipState::Starting {
                kind,
                operation_id,
                generation,
                initiator,
                since_ms,
            } = record.state.clone()
            {
                if now_ms.saturating_sub(since_ms) >= max_age_ms {
                    let cancellation = record.cancellation.take();
                    let settle = record.settle.take();
                    let partial_runtime = record.partial_runtime.take();
                    record.state = OwnershipState::Stopping {
                        owner: partial_runtime.clone(),
                        operation_id: operation_id.clone(),
                        generation,
                        initiator: initiator.clone(),
                        since_ms,
                    };
                    tracing::warn!(target: "freshell_ownership",
                        event = "ownership.start.recovery_started",
                        operation_id = %operation_id,
                        provider = %key.provider, session_id = %key.session_id,
                        initiator = %initiator, from_kind = ?kind,
                        epoch = self.epoch, generation,
                        outcome = "stopping_stale_start",
                        duration_ms = now_ms.saturating_sub(since_ms),
                        failure_reason = "STARTING_TIMEOUT");
                    recovered.push(RecoveredStart {
                        provider: key.provider.clone(),
                        session_id: key.session_id.clone(),
                        operation_id,
                        generation,
                        kind,
                        initiator,
                        cancellation,
                        settle,
                        partial_runtime,
                    });
                }
            }
        }
        recovered
    }

    /// Side-effect-free read for snapshot GETs and reconcile verdicts.
    /// The reported `generation` is the fence-relevant one (see
    /// [`snapshot_generation`]): the Live state's own for Live keys.
    pub fn observe(&self, provider: &str, session_id: &str) -> OwnershipSnapshot {
        let inner = self.inner.lock().expect("ownership lock poisoned");
        match inner.get(&SessionKey::new(provider, session_id)) {
            Some(record) => OwnershipSnapshot {
                epoch: self.epoch,
                generation: snapshot_generation(record),
                state: record.state.clone(),
            },
            None => OwnershipSnapshot {
                epoch: self.epoch,
                generation: 0,
                state: OwnershipState::Vacant,
            },
        }
    }

    /// Replay every recorded key's current owner (kata b8ke): the WS
    /// handshake builder serializes this into `ready.runtimeOwners` so a
    /// device that missed a handoff broadcast (offline during handoff,
    /// lag-4008 disconnect, page reload) learns the authoritative owner on
    /// reconnect. Vacant keys replay as "vacant" to CLEAR stale divergence.
    /// Sync; the lock is never held across an await.
    pub fn snapshot_records(&self) -> Vec<RuntimeOwnerReplayRecord> {
        let inner = self.inner.lock().expect("ownership lock poisoned");
        inner
            .iter()
            .map(|(key, record)| {
                let (owner_kind, terminal_id) = match &record.state {
                    OwnershipState::Vacant => ("vacant", None),
                    OwnershipState::Live { owner, .. } => {
                        (kind_wire(&owner.kind), owner.terminal_id.clone())
                    }
                    OwnershipState::Starting { kind, .. } => (kind_wire(kind), None),
                    OwnershipState::Handoff { to_kind, .. } => (kind_wire(to_kind), None),
                    OwnershipState::Stopping { owner, .. } => match owner {
                        Some(owner) => (kind_wire(&owner.kind), owner.terminal_id.clone()),
                        None => ("vacant", None),
                    },
                };
                RuntimeOwnerReplayRecord {
                    provider: key.provider.clone(),
                    session_id: key.session_id.clone(),
                    epoch: self.epoch,
                    generation: snapshot_generation(record),
                    owner_kind: owner_kind.to_string(),
                    terminal_id,
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;

    use crate::*;

    const PROVIDER: &str = "codex";

    fn registry_with_live_terminal() -> (RuntimeOwnershipRegistry, OwnerIdentity, u64) {
        let r = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::Terminal,
            "op-1",
            None,
            "test",
            1_000,
        ) else {
            panic!("expected Granted")
        };
        let owner = OwnerIdentity {
            kind: RuntimeOwnerKind::Terminal,
            terminal_id: Some("t-1".into()),
            live_session_key: None,
            pid: Some(4242),
            ownership_id: None,
        };
        assert_eq!(
            r.commit_live(PROVIDER, "sid", "op-1", generation, owner.clone()),
            CommitOutcome::Committed
        );
        (r, owner, generation)
    }

    /// The fencing claim an exit watcher carries: the operation that
    /// committed the runtime, the generation it committed under, and the
    /// runtime identity. (commit_live stamps `ownership_id` from the
    /// operation — round-1 review.)
    fn watcher_claim(owner: &OwnerIdentity, operation_id: &str, generation: u64) -> ReleaseClaim {
        ReleaseClaim {
            operation_id: operation_id.to_string(),
            generation,
            runtime: Some(owner.clone()),
        }
    }

    /// The fenced stop claim (round-2 review): the stopper's believed owner
    /// identity plus the (epoch, generation) it observed when it decided
    /// to act.
    fn stop_claim(owner: &OwnerIdentity, epoch: u64, generation: u64) -> StopClaim {
        StopClaim {
            expected_kind: owner.kind,
            expected_runtime: Some(owner.clone()),
            observed: ObservedFence { epoch, generation },
        }
    }

    fn fresh_agent_owner(pid: u32) -> OwnerIdentity {
        OwnerIdentity {
            kind: RuntimeOwnerKind::FreshAgent,
            terminal_id: None,
            live_session_key: Some("freshcodex:sid".into()),
            pid: Some(pid),
            ownership_id: None,
        }
    }

    /// The identity `commit_live` stamps from the committing operation (the
    /// release fence key, round-1 review) — the identity observers of the
    /// live owner (AdoptLive, restore-on-failed-handoff) learn back.
    fn stamped(mut owner: OwnerIdentity, operation_id: &str) -> OwnerIdentity {
        owner.ownership_id = Some(operation_id.to_string());
        owner
    }

    /// One captured `tracing` event: the level, target, the crate-convention
    /// `event` field's value, and every visited field name. The M2/N1
    /// log-hygiene regression tests assert through this.
    #[derive(Debug, Clone)]
    struct CapturedEvent {
        level: tracing::Level,
        target: String,
        event: Option<String>,
        fields: Vec<String>,
    }

    /// A subscriber capturing every event fired on the installing thread.
    /// The crate never installs its own subscriber (the host owns the
    /// global one), so tests pin log levels and field presence through a
    /// thread-local `set_default`.
    #[derive(Clone, Default)]
    struct EventCapture {
        events: Arc<Mutex<Vec<CapturedEvent>>>,
    }

    impl EventCapture {
        fn install(&self) -> tracing::subscriber::DefaultGuard {
            tracing::subscriber::set_default(self.clone())
        }

        fn events(&self) -> Vec<CapturedEvent> {
            self.events.lock().unwrap().clone()
        }
    }

    impl tracing::Subscriber for EventCapture {
        fn enabled(&self, _metadata: &tracing::Metadata<'_>) -> bool {
            true
        }

        fn new_span(&self, _span: &tracing::span::Attributes<'_>) -> tracing::span::Id {
            tracing::span::Id::from_u64(1)
        }

        fn record(&self, _span: &tracing::span::Id, _values: &tracing::span::Record<'_>) {}

        fn record_follows_from(&self, _span: &tracing::span::Id, _follows: &tracing::span::Id) {}

        fn event(&self, event: &tracing::Event<'_>) {
            let mut visitor = EventFieldVisitor::default();
            event.record(&mut visitor);
            self.events.lock().unwrap().push(CapturedEvent {
                level: *event.metadata().level(),
                target: event.metadata().target().to_string(),
                event: visitor.event,
                fields: visitor.fields,
            });
        }

        fn enter(&self, _span: &tracing::span::Id) {}

        fn exit(&self, _span: &tracing::span::Id) {}
    }

    /// Collects every visited field name plus the `event` field's value.
    /// `record_debug` is the `Visit` trait's only required method — the
    /// typed `record_*` defaults all funnel through it — so implementing
    /// `record_debug` and `record_str` (raw string for the `event` name)
    /// sees every field the macros record.
    #[derive(Default)]
    struct EventFieldVisitor {
        event: Option<String>,
        fields: Vec<String>,
    }

    impl tracing::field::Visit for EventFieldVisitor {
        fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
            if field.name() == "event" {
                self.event = Some(format!("{value:?}"));
            }
            self.fields.push(field.name().to_string());
        }

        fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
            if field.name() == "event" {
                self.event = Some(value.to_string());
            }
            self.fields.push(field.name().to_string());
        }
    }

    #[test]
    fn concurrent_terminal_and_fresh_agent_start_yield_exactly_one_grant() {
        let r = Arc::new(RuntimeOwnershipRegistry::new());
        // Every Granted holder increments; a second concurrent grant observes >0 and fails.
        let live_holders = Arc::new(AtomicUsize::new(0));
        let violations = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for i in 0..200 {
            let r = Arc::clone(&r);
            let live_holders = Arc::clone(&live_holders);
            let violations = Arc::clone(&violations);
            handles.push(thread::spawn(move || {
                let kind = if i % 2 == 0 {
                    RuntimeOwnerKind::Terminal
                } else {
                    RuntimeOwnerKind::FreshAgent
                };
                let op = format!("op-{i}");
                if let BeginOutcome::Granted { generation } =
                    r.begin_start(PROVIDER, "sid", kind, &op, None, "stress", i as u64)
                {
                    if live_holders.fetch_add(1, Ordering::SeqCst) != 0 {
                        violations.fetch_add(1, Ordering::SeqCst);
                    }
                    for _ in 0..50 {
                        std::hint::spin_loop();
                    }
                    // Decrement BEFORE the fail (round-1 review): between fail()
                    // and a late decrement another valid grant could observe a
                    // stale nonzero count — a false double-owner violation. While
                    // the key is still Starting no other grant can happen, so
                    // decrement-then-fail has no window at all.
                    live_holders.fetch_sub(1, Ordering::SeqCst);
                    let _ = r.fail(PROVIDER, "sid", &op, generation, false);
                }
            }));
        }
        for h in handles {
            h.join().expect("worker panicked");
        }
        assert_eq!(
            violations.load(Ordering::SeqCst),
            0,
            "two writers were Granted simultaneously"
        );
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);
    }

    #[test]
    fn concurrent_handoffs_in_opposite_directions_yield_one_grant() {
        let r = Arc::new(RuntimeOwnershipRegistry::new());
        let grants = Arc::new(Mutex::new(Vec::<RuntimeOwnerKind>::new()));
        let mut handles = Vec::new();
        for i in 0..100usize {
            let r = Arc::clone(&r);
            let grants = Arc::clone(&grants);
            handles.push(thread::spawn(move || {
                let to = if i % 2 == 0 {
                    RuntimeOwnerKind::Terminal
                } else {
                    RuntimeOwnerKind::FreshAgent
                };
                if let BeginOutcome::Granted { .. } =
                    r.begin_handoff(PROVIDER, "sid", to, &format!("ho-{i}"), None, "stress", 1)
                {
                    grants.lock().unwrap().push(to);
                }
            }));
        }
        for h in handles {
            h.join().expect("worker panicked");
        }
        let grants = grants.lock().unwrap().clone();
        assert_eq!(
            grants.len(),
            1,
            "exactly one handoff may be granted, got {grants:?}"
        );
    }

    #[test]
    fn same_kind_duplicate_attach_converges_on_one_live_runtime() {
        let (r, owner, generation) = registry_with_live_terminal();
        let second = r.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::Terminal,
            "op-2",
            None,
            "test",
            2_000,
        );
        // AdoptLive returns the STORED owner — including the `ownership_id`
        // commit_live stamped from the committing operation ("op-1").
        assert_eq!(
            second,
            BeginOutcome::AdoptLive {
                owner: stamped(owner, "op-1"),
                generation
            }
        );
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Live { .. }
        ));
    }

    #[test]
    fn stop_crash_and_unfail_release_or_leave_recoverable_typed_state() {
        // Explicit stop: Live -> Stopping (kill happens while Stopping) ->
        // commit_stop -> Vacant ONLY after the confirmed reap. Never Vacant
        // before the reap (round-1 review).
        let (r, owner, live_gen) = registry_with_live_terminal();
        let gen = match r.begin_stop(
            PROVIDER,
            "sid",
            "kill-1",
            &stop_claim(&owner, r.boot_epoch(), live_gen),
            "test",
            1,
        ) {
            StopOutcome::Granted { generation } => generation,
            other => panic!("expected Granted, got {other:?}"),
        };
        // While Stopping, competing starts are Blocked — the key is not Vacant.
        assert!(matches!(
            r.begin_start(
                PROVIDER,
                "sid",
                RuntimeOwnerKind::FreshAgent,
                "op-x",
                None,
                "test",
                2
            ),
            BeginOutcome::Blocked { .. }
        ));
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Stopping { .. }
        ));
        assert_eq!(
            r.commit_stop(PROVIDER, "sid", "kill-1", gen),
            CommitOutcome::Committed
        );
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);

        // A stop attempted during another operation's Handoff is TYPED Blocked
        // and the caller must NOT kill (round-1 review).
        let (r, owner, live_gen) = registry_with_live_terminal();
        let BeginOutcome::Granted { .. } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "ho-1",
            None,
            "test",
            2,
        ) else {
            panic!()
        };
        assert!(matches!(
            r.begin_stop(
                PROVIDER,
                "sid",
                "kill-2",
                &stop_claim(&owner, r.boot_epoch(), live_gen),
                "test",
                3
            ),
            StopOutcome::BlockedHandoff { .. }
        ));
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Handoff { .. }
        ));

        // A DELAYED cross-kind kill is fenced (round-2 review): after a
        // fresh-agent owner took over, a stale fresh-agent StopClaim is the
        // typed StaleClaim and the caller must NOT kill — the terminal owner
        // survives untouched.
        let (r, _owner, _) = registry_with_live_terminal();
        let BeginOutcome::Granted { generation: g2 } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "ho-x",
            None,
            "test",
            2,
        ) else {
            panic!()
        };
        let fresh_owner = fresh_agent_owner(77);
        assert_eq!(
            r.commit_live(PROVIDER, "sid", "ho-x", g2, fresh_owner.clone()),
            CommitOutcome::Committed
        );
        let stale_terminal_kill = stop_claim(
            &OwnerIdentity {
                kind: RuntimeOwnerKind::Terminal,
                terminal_id: Some("t-1".into()),
                live_session_key: None,
                pid: Some(4242),
                ownership_id: None,
            },
            r.boot_epoch(),
            1,
        );
        assert!(
            matches!(
                r.begin_stop(
                    PROVIDER,
                    "sid",
                    "kill-late",
                    &stale_terminal_kill,
                    "test",
                    3
                ),
                StopOutcome::StaleClaim { .. }
            ),
            "a mismatched stop claim must never claim Stopping"
        );
        assert!(
            matches!(
                r.observe(PROVIDER, "sid").state,
                OwnershipState::Live { .. }
            ),
            "the stale kill must not have transitioned or killed the fresh owner"
        );

        // Crash (exit-watcher release): Live -> Vacant, generation preserved
        // (monotonic). The release carries the fencing claim — the committing
        // operation, the generation, and the runtime identity (round-1 review).
        let (r, owner, generation) = registry_with_live_terminal();
        r.release(
            PROVIDER,
            "sid",
            &watcher_claim(&owner, "op-1", generation),
            "exit-watcher",
        );
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);
        assert!(r.observe(PROVIDER, "sid").generation >= 1);

        // A DELAYED watcher cannot erase a newer owner: after a re-start under a
        // new generation, the old claim is a typed no-op (round-1 review).
        let BeginOutcome::Granted { generation: g2 } = r.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "op-new",
            None,
            "test",
            4,
        ) else {
            panic!()
        };
        let fresh_owner = fresh_agent_owner(99);
        assert_eq!(
            r.commit_live(PROVIDER, "sid", "op-new", g2, fresh_owner.clone()),
            CommitOutcome::Committed
        );
        r.release(
            PROVIDER,
            "sid",
            &watcher_claim(&owner, "op-1", generation),
            "exit-watcher",
        );
        assert!(
            matches!(
                r.observe(PROVIDER, "sid").state,
                OwnershipState::Live { .. }
            ),
            "a stale watcher release must never erase the newer owner"
        );

        // Holder panics/never completes: state stays Starting (typed Blocked for
        // the next claimant — recoverable, never a second grant) until the
        // fenced force-release (matched on operation id + generation).
        let r = RuntimeOwnershipRegistry::new();
        let g_zombie = match r.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "op-zombie",
            None,
            "test",
            1,
        ) {
            BeginOutcome::Granted { generation } => generation,
            other => panic!("expected Granted, got {other:?}"),
        };
        assert!(matches!(
            r.begin_start(
                PROVIDER,
                "sid",
                RuntimeOwnerKind::Terminal,
                "op-2",
                None,
                "test",
                2
            ),
            BeginOutcome::Blocked { .. }
        ));
        // A force-release fenced to a DIFFERENT operation is a no-op.
        r.force_release_for_confirmed_kill(
            PROVIDER,
            "sid",
            &ReleaseClaim {
                operation_id: "op-other".into(),
                generation: g_zombie,
                runtime: None,
            },
            "ttl-recovery",
        );
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Starting { .. }
        ));
        // The matched force-release recovers the zombie ticket.
        r.force_release_for_confirmed_kill(
            PROVIDER,
            "sid",
            &ReleaseClaim {
                operation_id: "op-zombie".into(),
                generation: g_zombie,
                runtime: None,
            },
            "ttl-recovery",
        );
        assert!(matches!(
            r.begin_start(
                PROVIDER,
                "sid",
                RuntimeOwnerKind::Terminal,
                "op-3",
                None,
                "test",
                3
            ),
            BeginOutcome::Granted { .. }
        ));
    }

    #[test]
    fn operation_ticket_drop_releases_a_panicked_claim_and_the_watchdog_recovers_leaked_starts() {
        // RAII (round-1 review): dropping an un-disarmed ticket performs the
        // typed fail, so a panicked spawn cannot wedge the session. The
        // ticket WRAPS a granted claim — begin first, then guard it.
        let r = Arc::new(RuntimeOwnershipRegistry::new());
        {
            let BeginOutcome::Granted { generation } = r.begin_start(
                PROVIDER,
                "sid",
                RuntimeOwnerKind::Terminal,
                "op-panic",
                None,
                "test",
                1,
            ) else {
                panic!("expected Granted")
            };
            let ticket = OperationTicket::new(
                Arc::clone(&r),
                PROVIDER,
                "sid",
                "op-panic",
                RuntimeOwnerKind::Terminal,
                generation,
                "test",
            );
            assert!(matches!(
                r.observe(PROVIDER, "sid").state,
                OwnershipState::Starting { .. }
            ));
            drop(ticket); // no disarm — the simulated panic
        }
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);
        // Watchdog backstop (round-2 review: CANCEL first, never Vacant under
        // a live spawn): a LEAKED ticket (guard never ran — e.g. a detached
        // task killed without unwind) whose spawn is STILL RUNNING crosses the
        // threshold; the sweep holds Stopping (blocking new claims), hands the
        // registered cancellation to the host, and only the host's confirmed
        // settle + commit_stop reopens the key.
        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::Terminal,
            "op-leak",
            None,
            "test",
            0,
        ) else {
            panic!()
        };
        let aborted = Arc::new(AtomicBool::new(false));
        let abort = {
            let aborted = Arc::clone(&aborted);
            Arc::new(move || aborted.store(true, Ordering::SeqCst))
        };
        r.register_start_cancellation(
            PROVIDER,
            "sid",
            "op-leak",
            generation,
            abort,
            Box::new(std::future::ready(())),
        );
        let partial = OwnerIdentity {
            kind: RuntimeOwnerKind::Terminal,
            terminal_id: Some("t-partial".into()),
            live_session_key: None,
            pid: Some(555),
            ownership_id: None,
        };
        r.register_partial_runtime(PROVIDER, "sid", "op-leak", generation, partial.clone());
        let recovered = r.recover_stale_starts(0, 0); // everything is over-aged at now=0
        assert!(recovered.iter().any(|rec| rec.provider == PROVIDER
            && rec.session_id == "sid"
            && rec.operation_id == "op-leak"));
        // Mid-settle: the key is Stopping — a second writer is Blocked.
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Stopping { .. }
        ));
        assert!(
            matches!(
                r.begin_start(
                    PROVIDER,
                    "sid",
                    RuntimeOwnerKind::FreshAgent,
                    "op-second",
                    None,
                    "test",
                    1
                ),
                BeginOutcome::Blocked { .. }
            ),
            "no second writer may be granted while the stale spawn is being cancelled"
        );
        // The host aborts, awaits settle, and commits — only then Vacant.
        let rec = recovered.into_iter().next().unwrap();
        assert!(
            rec.cancellation.is_some(),
            "the watchdog must hand the abort handle to the host"
        );
        assert_eq!(
            rec.partial_runtime,
            Some(partial),
            "the registered partial runtime must flow to the host for the settle kill"
        );
        (rec.cancellation.unwrap())();
        assert!(
            aborted.load(Ordering::SeqCst),
            "the watchdog must abort the still-running operation"
        );
        assert!(matches!(
            r.commit_stop(PROVIDER, "sid", "op-leak", generation),
            CommitOutcome::Committed
        ));
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);
        assert!(matches!(
            r.begin_start(
                PROVIDER,
                "sid",
                RuntimeOwnerKind::FreshAgent,
                "op-after",
                None,
                "test",
                2
            ),
            BeginOutcome::Granted { .. }
        ));
    }

    #[test]
    fn stale_pre_restart_fence_is_always_rejected_across_the_boot_epoch() {
        // Round-2 review + task-brief carried finding: the boot epoch is
        // unique per coordinator instance BY CONSTRUCTION, so a "restart" is
        // a second registry with its own epoch — never a fabricated epoch-1
        // in the same instance. A request carrying a PRE-RESTART pair is
        // stale even when its generation dwarfs the restarted registry's
        // fresh counters.
        let pre_restart = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation } = pre_restart.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::Terminal,
            "op-old",
            None,
            "test",
            1,
        ) else {
            panic!("expected Granted")
        };
        let pre_restart_fence = ObservedFence {
            epoch: pre_restart.boot_epoch(),
            generation,
        };
        let restarted = RuntimeOwnershipRegistry::new();
        assert!(
            restarted.boot_epoch() != pre_restart.boot_epoch(),
            "each coordinator instance must mint a distinct boot epoch by construction"
        );
        assert!(
            matches!(
                restarted.begin_start(
                    PROVIDER,
                    "sid",
                    RuntimeOwnerKind::Terminal,
                    "op-new",
                    Some(pre_restart_fence),
                    "test",
                    2
                ),
                BeginOutcome::StaleGeneration { .. }
            ),
            "a pre-restart epoch is stale regardless of generation"
        );
        assert!(
            matches!(
                restarted.begin_start(
                    PROVIDER,
                    "sid",
                    RuntimeOwnerKind::Terminal,
                    "op-new2",
                    Some(ObservedFence {
                        epoch: pre_restart.boot_epoch(),
                        generation: u64::MAX
                    }),
                    "test",
                    2
                ),
                BeginOutcome::StaleGeneration { .. }
            ),
            "a dwarfing generation cannot rescue a pre-restart epoch"
        );
        assert_eq!(
            restarted.observe(PROVIDER, "sid").state,
            OwnershipState::Vacant,
            "the stale requests must not have created ownership"
        );
        // The same-epoch rules: a NEWER generation than the record's is
        // stale; the CURRENT epoch with a not-yet-superseded generation is
        // Granted (the client observed the future it may create).
        let BeginOutcome::Granted { .. } = restarted.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::Terminal,
            "op-b",
            None,
            "test",
            1,
        ) else {
            panic!()
        };
        let stale_same_epoch = Some(ObservedFence {
            epoch: restarted.boot_epoch(),
            generation: 0,
        });
        assert!(matches!(
            restarted.begin_start(
                PROVIDER,
                "sid",
                RuntimeOwnerKind::Terminal,
                "op-c",
                stale_same_epoch,
                "test",
                2
            ),
            BeginOutcome::StaleGeneration { .. }
        ));
        let fresh_same_epoch = Some(ObservedFence {
            epoch: restarted.boot_epoch(),
            generation: 1,
        });
        // "sid2" is a FRESH key (its record's generation is 0), so the
        // fence's generation 1 is NEWER than the key's current — allowed by
        // the not-yet-superseded rule (the request observed the future it
        // may create), not the equality case.
        assert!(
            matches!(
                restarted.begin_start(
                    PROVIDER,
                    "sid2",
                    RuntimeOwnerKind::Terminal,
                    "op-d",
                    fresh_same_epoch,
                    "test",
                    2
                ),
                BeginOutcome::Granted { .. }
            ),
            "an observed generation NEWER than the key's current one is fresh, not stale"
        );
        // The TRUE equality case: "sid" is already claimed (held by op-b at
        // generation 1), and the fence observes exactly that generation.
        // The fence is fresh — it passes the staleness check — so the STATE
        // MACHINE answers, not the fence: a different operation is Blocked
        // as a second writer, and the holding operation's own re-claim is
        // Granted.
        let equal_same_epoch = Some(ObservedFence {
            epoch: restarted.boot_epoch(),
            generation: 1,
        });
        assert!(
            matches!(
                restarted.begin_start(
                    PROVIDER,
                    "sid",
                    RuntimeOwnerKind::Terminal,
                    "op-e",
                    equal_same_epoch,
                    "test",
                    2
                ),
                BeginOutcome::Blocked { .. }
            ),
            "an equal fence is fresh: the second writer is Blocked by the state machine, not fenced as stale"
        );
        let re = restarted.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::Terminal,
            "op-b",
            equal_same_epoch,
            "test",
            2,
        );
        assert!(
            matches!(re, BeginOutcome::Granted { generation: 1 }),
            "an observed generation equal to the current one is fresh, not stale"
        );
    }

    #[test]
    fn stale_generation_cannot_commit_after_a_later_generation_begins() {
        // Round-1 review: begin_handoff from Starting is Blocked BY DESIGN, so
        // this test starts from LIVE — a committed owner, then a handoff that
        // bumps the generation, then the delayed pre-handoff commit.
        let (r, _owner, _) = registry_with_live_terminal(); // Live, generation 1
        let BeginOutcome::Granted { .. } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "ho-1",
            None,
            "test",
            2,
        ) else {
            panic!()
        };
        let owner = OwnerIdentity {
            kind: RuntimeOwnerKind::Terminal,
            terminal_id: Some("t-late".into()),
            live_session_key: None,
            pid: None,
            ownership_id: None,
        };
        // A commit carrying the PRE-handoff generation is refused — the stale
        // caller must tear down its own child.
        assert_eq!(
            r.commit_live(PROVIDER, "sid", "op-slow", 1, owner),
            CommitOutcome::StaleGeneration {
                current_generation: 2
            }
        );
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Handoff { .. }
        ));
    }

    #[test]
    fn handoff_fail_restores_prior_owner_only_when_confirmed_live() {
        // Prior live owner, handoff fails BEFORE the prior was stopped — the
        // prior is confirmed still live, so it is restored (round-1 review).
        let (r, owner, _) = registry_with_live_terminal();
        let BeginOutcome::Granted { generation: g } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "ho-1",
            None,
            "test",
            2,
        ) else {
            panic!()
        };
        assert_eq!(
            r.fail(PROVIDER, "sid", "ho-1", g, /* prior_confirmed_live: */ true),
            FailOutcome::RestoredPriorOwner
        );
        // The restored prior is the STORED identity — with the
        // `ownership_id` its original commit stamped ("op-1").
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Live { owner: ref o, .. } if *o == stamped(owner.clone(), "op-1")
        ));
        // No prior: handoff fail -> Vacant{NoPrior}.
        let r = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation: g } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::Terminal,
            "ho-2",
            None,
            "test",
            1,
        ) else {
            panic!()
        };
        assert_eq!(
            r.fail(PROVIDER, "sid", "ho-2", g, false),
            FailOutcome::Vacant {
                reason: FailVacantReason::NoPrior
            }
        );
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);
        // Prior was REAPED (the runner confirmed the kill) and the target then
        // failed: restoring would record a dead runtime as Live — the key ends
        // Vacant with the typed PriorNotLive reason instead (round-1 review).
        let (r, _owner, _) = registry_with_live_terminal();
        let BeginOutcome::Granted { generation: g } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::Terminal,
            "ho-3",
            None,
            "test",
            2,
        ) else {
            panic!()
        };
        assert_eq!(
            r.fail(PROVIDER, "sid", "ho-3", g, /* prior_confirmed_live: */ false),
            FailOutcome::Vacant {
                reason: FailVacantReason::PriorNotLive
            }
        );
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);
    }

    #[test]
    fn distinct_session_refs_start_concurrently() {
        let r = RuntimeOwnershipRegistry::new();
        let a = r.begin_start(
            PROVIDER,
            "sid-a",
            RuntimeOwnerKind::Terminal,
            "op-a",
            None,
            "test",
            1,
        );
        let b = r.begin_start(
            PROVIDER,
            "sid-b",
            RuntimeOwnerKind::FreshAgent,
            "op-b",
            None,
            "test",
            1,
        );
        assert!(matches!(a, BeginOutcome::Granted { .. }));
        assert!(matches!(b, BeginOutcome::Granted { .. }));
    }

    #[test]
    fn handoff_continuation_grants_target_start_under_same_operation() {
        let r = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation: g } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::Terminal,
            "ho-1",
            None,
            "test",
            1,
        ) else {
            panic!()
        };
        // Target start under the handoff's operation_id + to_kind: granted, state stays Handoff.
        let cont = r.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::Terminal,
            "ho-1",
            None,
            "test",
            2,
        );
        assert_eq!(cont, BeginOutcome::Granted { generation: g });
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Handoff { .. }
        ));
        // A DIFFERENT operation (or wrong kind) is blocked.
        assert!(matches!(
            r.begin_start(
                PROVIDER,
                "sid",
                RuntimeOwnerKind::FreshAgent,
                "op-x",
                None,
                "test",
                3
            ),
            BeginOutcome::Blocked { .. }
        ));
    }

    #[test]
    fn same_operation_reclaim_is_granted() {
        // A lifecycle path that claims under its own operation id and then
        // re-claims under the SAME id (the handoff target continuation —
        // Task 6's runner invokes the target lane under its own operation
        // identity): that re-claim must be Granted (it is the same holder,
        // not a second writer).
        let r = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "snap-1",
            None,
            "test",
            1,
        ) else {
            panic!()
        };
        let re = r.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "snap-1",
            None,
            "test",
            2,
        );
        assert_eq!(re, BeginOutcome::Granted { generation });
        // A different op still blocked while snap-1 holds Starting.
        assert!(matches!(
            r.begin_start(
                PROVIDER,
                "sid",
                RuntimeOwnerKind::FreshAgent,
                "snap-2",
                None,
                "test",
                3
            ),
            BeginOutcome::Blocked { .. }
        ));
    }

    #[test]
    fn snapshot_records_replay_owner_state_and_released_keys_as_vacant() {
        // kata b8ke reconnect-owner discovery (T1 rec A1): the ready frame's
        // runtimeOwners payload comes from here — live owners replay with
        // their kind, released keys replay as "vacant" so replay CLEARS stale
        // divergence on reconnecting devices.
        let (r, owner, generation) = registry_with_live_terminal();
        let records = r.snapshot_records();
        assert!(records.iter().any(|rec| rec.provider == PROVIDER
            && rec.session_id == "sid"
            && rec.epoch == r.boot_epoch()
            && rec.generation == generation
            && rec.owner_kind == "terminal"));
        r.release(
            PROVIDER,
            "sid",
            &watcher_claim(&owner, "op-1", generation),
            "exit-watcher",
        );
        let records = r.snapshot_records();
        assert!(records.iter().any(|rec| rec.provider == PROVIDER
            && rec.session_id == "sid"
            && rec.generation >= generation
            && rec.owner_kind == "vacant"));
    }

    #[test]
    fn stop_during_starting_or_stopping_is_typed_notlive_and_transitions_nothing() {
        // Task-brief carried finding (round-2): begin_stop during
        // Starting/Stopping returns TYPED blocked results WITHOUT licensing
        // a kill — the in-flight operation (or the watchdog) owns the
        // transition. (Handoff is covered by the BlockedHandoff block in
        // the stop/crash/cancellation test.)
        let r = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "op-1",
            None,
            "test",
            1,
        ) else {
            panic!()
        };
        let owner = fresh_agent_owner(9);
        let claim = stop_claim(&owner, r.boot_epoch(), generation);
        assert!(
            matches!(
                r.begin_stop(PROVIDER, "sid", "kill-early", &claim, "test", 2),
                StopOutcome::NotLive { .. }
            ),
            "a stop during Starting is typed NotLive and must not license a kill"
        );
        assert!(
            matches!(
                r.observe(PROVIDER, "sid").state,
                OwnershipState::Starting { .. }
            ),
            "the refused stop must not have transitioned the in-flight start"
        );

        // Stopping: the first stop owns the reap; a second stop is typed
        // NotLive (no kill license) and the first stop still commits.
        let (r, owner, live_gen) = registry_with_live_terminal();
        let StopOutcome::Granted { generation } = r.begin_stop(
            PROVIDER,
            "sid",
            "kill-1",
            &stop_claim(&owner, r.boot_epoch(), live_gen),
            "test",
            1,
        ) else {
            panic!("expected Granted")
        };
        assert!(matches!(
            r.begin_stop(
                PROVIDER,
                "sid",
                "kill-2",
                &stop_claim(&owner, r.boot_epoch(), live_gen),
                "test",
                2
            ),
            StopOutcome::NotLive { .. }
        ));
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Stopping { .. }
        ));
        assert_eq!(
            r.commit_stop(PROVIDER, "sid", "kill-1", generation),
            CommitOutcome::Committed
        );
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);
    }

    #[test]
    fn sweep_never_hands_a_dead_operations_registration_to_a_later_start() {
        // M1 (review): the cancellation/settle/partial_runtime registration
        // fields must never outlive the Starting operation that registered
        // them. Op A registers its handles, then FAILS (Starting→Vacant);
        // op B enters Starting WITHOUT registering (the grant→register
        // window, or a register-immediately discipline violation). The
        // sweep must hand the host op B's handles — None — never dead op
        // A's (the host would abort and await the WRONG, already-settled
        // resources).
        let r = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation: g_a } = r.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::Terminal,
            "op-a",
            None,
            "test",
            1_000,
        ) else {
            panic!("expected Granted")
        };
        let aborted = Arc::new(AtomicBool::new(false));
        let abort = {
            let aborted = Arc::clone(&aborted);
            Arc::new(move || aborted.store(true, Ordering::SeqCst))
        };
        r.register_start_cancellation(
            PROVIDER,
            "sid",
            "op-a",
            g_a,
            abort,
            Box::new(std::future::ready(())),
        );
        r.register_partial_runtime(
            PROVIDER,
            "sid",
            "op-a",
            g_a,
            OwnerIdentity {
                kind: RuntimeOwnerKind::Terminal,
                terminal_id: Some("t-dead".into()),
                live_session_key: None,
                pid: Some(1111),
                ownership_id: None,
            },
        );
        assert_eq!(
            r.fail(PROVIDER, "sid", "op-a", g_a, false),
            FailOutcome::Released
        );
        // Op B enters Starting on the same key and never registers.
        let BeginOutcome::Granted { generation: g_b } = r.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "op-b",
            None,
            "test",
            1_000,
        ) else {
            panic!("expected Granted")
        };
        let recovered = r.recover_stale_starts(11_000, 5_000); // op B is over-aged
        let rec = recovered
            .iter()
            .find(|rec| rec.operation_id == "op-b")
            .expect("the sweep must recover the over-aged op-b");
        assert!(
            rec.cancellation.is_none(),
            "the sweep must not hand dead op A's abort handle to the host as op B's"
        );
        assert!(
            rec.settle.is_none(),
            "the sweep must not hand dead op A's settle future to the host as op B's"
        );
        assert!(
            rec.partial_runtime.is_none(),
            "the sweep must not hand dead op A's partial runtime to the host as op B's"
        );
        assert!(
            !aborted.load(Ordering::SeqCst),
            "nothing may have invoked the dead operation's abort handle"
        );
        // Reopen the key through the host's confirmed-stop path.
        assert_eq!(
            r.commit_stop(PROVIDER, "sid", "op-b", g_b),
            CommitOutcome::Committed
        );
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);
    }

    #[test]
    fn stale_generation_commit_live_logs_warn_not_an_invariant_error() {
        // M2 (review): a stale-generation commit_live is a typed,
        // anticipated race outcome (the delayed caller tears down its own
        // child) — the refusal must log at warn on the crate's diagnostic
        // target, NOT as an error-level `invariant` event. Error-level
        // invariant events are reserved for genuine contract violations
        // (force_release during Handoff).
        let (r, _owner, _) = registry_with_live_terminal(); // Live, generation 1
        let BeginOutcome::Granted { .. } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "ho-1",
            None,
            "test",
            2,
        ) else {
            panic!()
        };
        let capture = EventCapture::default();
        let _guard = capture.install();
        let stale_owner = OwnerIdentity {
            kind: RuntimeOwnerKind::Terminal,
            terminal_id: Some("t-late".into()),
            live_session_key: None,
            pid: None,
            ownership_id: None,
        };
        assert_eq!(
            r.commit_live(PROVIDER, "sid", "op-slow", 1, stale_owner),
            CommitOutcome::StaleGeneration {
                current_generation: 2
            }
        );
        let events = capture.events();
        assert!(
            events.iter().any(|e| e.level == tracing::Level::WARN
                && e.target == "freshell_ownership"
                && e.event.as_deref() == Some("ownership.commit_live.stale_generation")),
            "the anticipated stale refusal must warn on freshell_ownership, got {events:?}"
        );
        assert!(
            events.iter().all(|e| e.level != tracing::Level::ERROR),
            "an expected stale commit must not emit error-level events, got {events:?}"
        );
    }

    #[test]
    fn snapshot_fence_satisfies_begin_stop_after_a_failed_handoff_restore() {
        // M3 (review): a failed handoff restores the prior owner at its
        // ORIGINAL generation while the record's generation keeps the
        // handoff's bump. begin_stop compares stop fences against the Live
        // STATE's generation, so a fence derived from observe()/
        // snapshot_records() must report the Live state's generation —
        // otherwise a snapshot-fenced stopper loops on StaleClaim forever
        // (fail-closed liveness corner; no safety violation, no kill
        // licensed).
        let (r, owner, live_gen) = registry_with_live_terminal(); // Live, generation 1
        let BeginOutcome::Granted { generation: ho_gen } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "ho-1",
            None,
            "test",
            2,
        ) else {
            panic!()
        };
        assert_eq!(
            ho_gen,
            live_gen + 1,
            "the handoff bumped the record's generation above the Live state's"
        );
        assert_eq!(
            r.fail(PROVIDER, "sid", "ho-1", ho_gen, /* prior_confirmed_live: */ true),
            FailOutcome::RestoredPriorOwner
        );
        // The snapshot a stopper derives its fence from must be coherent
        // with begin_stop's comparison target: the Live state's own
        // generation (the restored prior's original).
        let snap = r.observe(PROVIDER, "sid");
        assert!(matches!(snap.state, OwnershipState::Live { .. }));
        assert_eq!(
            snap.generation, live_gen,
            "the snapshot generation for a restored-Live key is the Live state's own"
        );
        let rec = r
            .snapshot_records()
            .into_iter()
            .find(|rec| rec.provider == PROVIDER && rec.session_id == "sid")
            .expect("the restored key must replay");
        assert_eq!(
            rec.generation, live_gen,
            "the replay record's generation for a restored-Live key is the Live state's own"
        );
        // A stopper fences from the snapshot and stops the restored owner:
        // no permanent StaleClaim loop.
        let stop = r.begin_stop(
            PROVIDER,
            "sid",
            "kill-1",
            &stop_claim(&owner, rec.epoch, rec.generation),
            "test",
            3,
        );
        assert!(
            matches!(stop, StopOutcome::Granted { .. }),
            "a snapshot-derived fence must satisfy begin_stop on a restored key (got {stop:?})"
        );
        let StopOutcome::Granted { generation } = stop else {
            unreachable!("asserted Granted above")
        };
        assert_eq!(
            r.commit_stop(PROVIDER, "sid", "kill-1", generation),
            CommitOutcome::Committed
        );
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);
    }

    #[test]
    fn start_failed_event_carries_duration_ms() {
        // N1 (review): the Starting-fail observability event carries the
        // terminal-transition duration (`duration_ms`), matching the
        // Handoff-fail arm — the field is part of the event field set the
        // module's observability contract promises.
        let r = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::Terminal,
            "op-1",
            None,
            "test",
            1_000,
        ) else {
            panic!("expected Granted")
        };
        let capture = EventCapture::default();
        let _guard = capture.install();
        assert_eq!(
            r.fail(PROVIDER, "sid", "op-1", generation, false),
            FailOutcome::Released
        );
        let start_failed = capture
            .events()
            .into_iter()
            .find(|e| {
                e.target == "freshell_ownership"
                    && e.event.as_deref() == Some("ownership.start.failed")
            })
            .expect("the Starting-fail event must fire on freshell_ownership");
        assert!(
            start_failed.fields.contains(&"duration_ms".to_string()),
            "ownership.start.failed must carry duration_ms (got fields {:?})",
            start_failed.fields
        );
    }
}
