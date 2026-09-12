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
//!   transition. A stop abandoned before the kill (runtime confirmed still
//!   alive) unwinds via `abort_stop` — `Stopping` → `Live` at the owner's
//!   pre-stop generation (Task 4 review F1: every granted stop reaches
//!   commit or abort; nothing strands).
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
/// (the splitmix mix below is injective per mint for a fixed seed, so
/// distinct mints stay unique PRE-mask; the JSON-safety mask at the mint
/// makes residual collisions a negligible 53-bit coincidence, and
/// [`RuntimeOwnershipRegistry::with_epoch`] remains the
/// construction-uniqueness guarantee).
static NEXT_MINT: AtomicU64 = AtomicU64::new(1);

/// The JSON wire-safety bound every browser client imposes on the epoch:
/// IEEE-754 doubles represent integers EXACTLY only up to 2^53-1, and the
/// client's ready-frame schema (zod v4 `.int()`) enforces exactly this
/// range. The default mint masks its output into the range so the epoch
/// survives the JS JSON.parse round trip verbatim — both directions: the
/// `ready.runtimeOwners` / `session.runtimeOwner` frames the client folds,
/// and any `observedEpoch` fence the client sends back (a full-64-bit
/// value would round to a DIFFERENT integer and poison every fence
/// comparison). Explicitly injected epochs ([`RuntimeOwnershipRegistry::with_epoch`])
/// stay unconstrained by contract.
const EPOCH_JSON_SAFE_MASK: u64 = (1u64 << 53) - 1;

/// Mint a boot epoch unique per registry construction (round-2 review:
/// never bare wall-clock milliseconds). Within a process the per-mint
/// counter plus the injective mix guarantees uniqueness; across restarts
/// the distinct first-mint instants separate the seeds (a collision needs
/// an exact 53-bit coincidence after the JSON-safety mask below — the
/// splitmix avalanche keeps the masked outputs uniform). Hosts wanting
/// strict cross-restart uniqueness by construction inject a persisted
/// monotonic counter via [`RuntimeOwnershipRegistry::with_epoch`].
fn default_boot_epoch() -> u64 {
    let seed = *BOOT_SEED_NS.get_or_init(now_epoch_ns);
    let mint = NEXT_MINT.fetch_add(1, Ordering::Relaxed);
    mix_boot_epoch(seed, mint) & EPOCH_JSON_SAFE_MASK
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
/// for Live keys the Live STATE's own generation. A stop abandoned with
/// the runtime still alive (`abort_stop`) restores the PRE-STOP Live
/// generation while the record's generation was already bumped by the
/// stop, and every fence comparison — begin_stop's stale-claim check and
/// begin_start/begin_handoff's stale-generation check (M3-R) — uses the
/// Live state's generation, so reporting the record's value for such a
/// key would leave a snapshot-derived fence permanently stale (a
/// StaleGeneration/StaleClaim loop: fail-closed liveness corner, no
/// safety violation). The failed-HANDOFF restore does NOT straddle: it
/// writes the record's current generation (whole-branch review M-1 — the
/// handoff broadcasts carried it to every client, whose monotonic folds
/// cannot regress), so `abort_stop`'s restore is the one deliberate
/// straddle this helper papers over. Chosen over rolling the record's
/// generation back on any restore: the record's generation is the per-key
/// monotonic counter (never resets — see the crate doc), and a rollback
/// would let distinct eras reuse a generation number, weakening the
/// stale-request fence for every consumer. For every non-Live state the
/// record's generation always equals the state's own (they are written
/// together).
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
            | OwnershipState::Stopping { initiator, .. }
            | OwnershipState::Fenced { initiator, .. } => Some(initiator.clone()),
            OwnershipState::Aliased { .. } => None,
            _ => None,
        }
    }

    /// The kind this state is (or is transitioning to), for old/new-kind
    /// event fields.
    fn kind(&self) -> Option<RuntimeOwnerKind> {
        match self {
            OwnershipState::Vacant | OwnershipState::Aliased { .. } => None,
            OwnershipState::Starting { kind, .. } => Some(*kind),
            OwnershipState::Live { owner, .. } => Some(owner.kind),
            OwnershipState::Handoff { to_kind, .. } => Some(*to_kind),
            OwnershipState::Stopping { owner, .. } => owner.as_ref().map(|o| o.kind),
            OwnershipState::Fenced { prior, .. } => prior.as_ref().map(|(owner, _)| owner.kind),
        }
    }

    /// b8ke focused episode-2 round-2 F2: the operation id of the
    /// in-flight transition this state represents — the correlation key a
    /// lane-side adoption can compare against its runtime's recorded
    /// owning operation (`None` for the settled states Vacant/Live).
    pub fn operation_id(&self) -> Option<&str> {
        match self {
            OwnershipState::Vacant
            | OwnershipState::Live { .. }
            | OwnershipState::Aliased { .. } => None,
            OwnershipState::Starting { operation_id, .. }
            | OwnershipState::Handoff { operation_id, .. }
            | OwnershipState::Stopping { operation_id, .. }
            | OwnershipState::Fenced { operation_id, .. } => Some(operation_id.as_str()),
        }
    }

    /// The record's `since_ms` (round-2 review: `Live` carries it too, so
    /// release/commit events include the terminal-transition duration the
    /// observability contract requires).
    fn since_ms(&self) -> Option<u64> {
        match self {
            OwnershipState::Vacant | OwnershipState::Aliased { .. } => None,
            OwnershipState::Live { since_ms, .. }
            | OwnershipState::Starting { since_ms, .. }
            | OwnershipState::Handoff { since_ms, .. }
            | OwnershipState::Stopping { since_ms, .. }
            | OwnershipState::Fenced { since_ms, .. } => Some(*since_ms),
        }
    }

    /// The `Handoff` state's captured prior owner plus the generation it held
    /// when it went Live (kata b8ke Task 6): the handoff runner's stop
    /// source — the identity to stop. The captured generation is the
    /// PRIOR's own (historical); a restore resumes at the RECORD's current
    /// generation instead (whole-branch review M-1), so the runner must
    /// not use this value as a restore fence. `None` for every other state
    /// (only `Handoff` carries a prior; a Vacant-entered handoff captures
    /// `None` too).
    pub fn prior_owner(&self) -> Option<(OwnerIdentity, u64)> {
        match self {
            OwnershipState::Handoff { prior, .. } => prior.clone(),
            _ => None,
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
        /// The generation the owner held when the stop began (Task 4 review
        /// F1): `abort_stop` restores `Live` at THIS generation — the fence
        /// baseline a pre-stop observer (retained stamp, snapshot) still
        /// carries. `None` for the watchdog's zombie-`Starting` synthesis
        /// (no prior Live era — not abortable to `Live`).
        prior_generation: Option<u64>,
        operation_id: String,
        generation: u64,
        initiator: String,
        since_ms: u64,
    },
    /// b8ke focused round-2 review (R2-1/R2-3): the TYPED fenced state —
    /// the prior runtime's death is UNCONFIRMED and no in-flight operation
    /// remains that could ever settle it, so the key blocks EVERY new
    /// writer until [`RuntimeOwnershipRegistry::release_fenced`] clears it
    /// (ONLY a caller that confirmed the prior's death by a bounded
    /// identity/pid probe or a watcher event may invoke it). The fail-open
    /// to plain `Vacant` the round-1 fix shipped for a lost watcher is
    /// REMOVED: it licensed a second writer over a possibly-live prior.
    /// `PlatformLimited` fences have no probe that can ever confirm (the
    /// descendant-tree walk is Linux-only), so they persist for the boot
    /// epoch — the documented tradeoff (the operator can still kill the
    /// leftover processes by other means; the server restart mints a new
    /// epoch). `begin_stop` answers the typed `NotLive{Fenced}` for this
    /// state: the caller must NOT kill (the fence owns the transition).
    Fenced {
        prior: Option<(OwnerIdentity, u64)>,
        reason: FenceReason,
        operation_id: String,
        generation: u64,
        initiator: String,
        since_ms: u64,
    },
    /// b8ke focused episode-2 round-3 F1/F3: this key's session was
    /// RE-KEYED — ownership moved to the client-visible new durable id
    /// ([`RuntimeOwnershipRegistry::commit_live_rekey`] /
    /// [`RuntimeOwnershipRegistry::rekey_live`]). The coordinator itself
    /// is the single source of truth for old→new resolution: a stale wire
    /// id landing here resolves to the canonical key through
    /// [`RuntimeOwnershipRegistry::resolve_canonical`] (walked to the
    /// fixpoint — never a bounded-link cap), and the record replays as
    /// VACANT to clients (the old key holds no writer; stale divergence
    /// clears). The lane-side process-local alias maps are NOT
    /// load-bearing: every lifecycle path resolves through the registry.
    Aliased {
        to: String,
        /// The rekey's own generation (preserved for fence arithmetic).
        generation: u64,
    },
}

/// Why a key sits in [`OwnershipState::Fenced`] (b8ke focused round-2
/// review). Typed on the state so every Blocked refusal carries the
/// machine-readable reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FenceReason {
    /// The detached reap-confirmation watcher itself failed (its
    /// confirmation future was lost — a JoinError) while the prior's death
    /// stayed unconfirmed. A replacement watcher clears the fence only once
    /// its bounded recorded-identity probe confirms death.
    WatcherFailed,
    /// Non-Linux teardown: the direct child's awaited exit is the portable
    /// floor, but the descendant-tree verification requires `/proc` —
    /// confirmation is IMPOSSIBLE on this platform, so nothing clears the
    /// fence within this boot epoch (the documented tradeoff).
    PlatformLimited,
    /// b8ke delta round-2 F2: the stale-Starting watchdog could not confirm
    /// the start operation's death (a blocked/hung start, an unregistered
    /// settle, or an unconfirmable partial reap). The fence's recovery
    /// paths: the operation's OWN unwind (its ticket's typed `fail` —
    /// [`RuntimeOwnershipRegistry::fail`] releases exactly this reason),
    /// a confirmed-death probe ([`Self::release_fenced`]), or the lane
    /// teardown paths. Never force-clearable (the r4 acknowledged
    /// force-clear matches only `PlatformLimited`): a possibly-live start
    /// is never an operator-acknowledged risk.
    StaleStart,
}

impl FenceReason {
    /// The wire string for the reconnect-replay fields (b8ke focused
    /// round-3 review R3-5) — the same kebab-case spelling the serde
    /// derive emits.
    pub fn wire_str(&self) -> &'static str {
        match self {
            FenceReason::WatcherFailed => "watcher-failed",
            FenceReason::PlatformLimited => "platform-limited",
            FenceReason::StaleStart => "stale-start",
        }
    }
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

/// Outcome of [`RuntimeOwnershipRegistry::abort_stop`] (Task 4 review F1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AbortStopOutcome {
    /// The stop was rolled back; the key is `Live` again (the owner restored
    /// at its pre-stop generation).
    Aborted,
    /// The carried generation no longer matches the record.
    StaleGeneration { current_generation: u64 },
    /// The record is not this operation's restorable `Stopping` (moved on,
    /// or a watchdog-synthesized stop with no prior Live era).
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

/// Outcome of the typed fence transitions (b8ke focused round-2 review):
/// [`RuntimeOwnershipRegistry::fence_unconfirmed_handoff`] and
/// [`RuntimeOwnershipRegistry::fence_unconfirmed_stop`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FenceOutcome {
    /// The record moved into [`OwnershipState::Fenced`] with the typed
    /// reason — every begin is now Blocked.
    Fenced,
    /// The record moved on (a foreign operation id or generation, or the
    /// state is no longer the expected in-flight one) — the typed no-op.
    ForeignOperation,
}

/// Outcome of [`RuntimeOwnershipRegistry::force_release_platform_limited`]
/// (b8ke focused round-3 review R3-4): the typed operator recovery for a
/// `Fenced{PlatformLimited}` key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForceReleaseOutcome {
    /// The fence cleared — the record is `Vacant` at the same generation;
    /// the caller's explicit retry may proceed.
    Released,
    /// The key is not a `Fenced{PlatformLimited}` record (anything else —
    /// including `WatcherFailed` fences, whose bounded probe can still
    /// confirm; the state rides along for the typed refusal).
    NotPlatformLimited { state: OwnershipState },
    /// The observation is stale (a different boot epoch, or an older
    /// generation than the fenced record) — refresh and retry.
    StaleObservation {
        current_epoch: u64,
        current_generation: u64,
    },
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
    /// b8ke focused episode-2 round-2 F6: the stale age at recovery — the
    /// `Starting` record's own `since_ms`, so the transition logs carry the
    /// required duration on every outcome.
    pub since_ms: u64,
    pub cancellation: Option<Arc<dyn Fn() + Send + Sync>>,
    pub settle: Option<Box<dyn std::future::Future<Output = ()> + Send>>,
    pub partial_runtime: Option<OwnerIdentity>,
}

/// One `Fenced{StaleStart}` record for the watchdog's confirmed-death
/// probe (b8ke focused episode-2 round-2 F5) — see
/// [`RuntimeOwnershipRegistry::stale_start_fences`].
#[derive(Debug, Clone)]
pub struct StaleStartFence {
    pub provider: String,
    pub session_id: String,
    pub operation_id: String,
    pub generation: u64,
    /// The fenced prior's recorded pid — the probe's target. `None` (no
    /// recorded runtime identity) resolves through the kind-aware
    /// liveness check instead.
    pub prior_pid: Option<u32>,
    /// b8ke focused episode-2 round-3 F8: the fencing initiator + the
    /// fenced prior's kind — the release record's schema fields.
    pub initiator: String,
    pub prior_kind: Option<RuntimeOwnerKind>,
    /// b8ke focused episode-2 post-cap F4: the fenced operation's
    /// settle/cancellation state — `Some(true)`: the registering guard
    /// dropped (the operation concluded); `Some(false)`: registered but
    /// still in flight; `None`: NO registration ever armed (the
    /// PID-less pre-registration shape — unprobe-able, the fence HOLDS).
    pub settle_fired: Option<bool>,
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
    /// b8ke focused round-3 review R3-5: the replayed state's truth.
    /// `Fenced` marks a record whose `owner_kind` names the FENCED PRIOR —
    /// NOT a live owner. A reconnecting device must never fold such a
    /// record as a committed owner (the pre-fix replay licensed a false
    /// "handoff-committed" fold after PLATFORM_LIMITED/WATCHER_FAILED — no
    /// divergence, no recovery UI). `reason` carries the typed fence reason
    /// when fenced.
    pub state: ReplayOwnerState,
    /// The typed fence reason (`state == Fenced` only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// b8ke focused episode-2 post-cap F5: the CANONICAL id this key was
    /// re-keyed to (`Aliased` keys only, wire-additive). The replayed
    /// owner_kind/state/generation are the CANONICAL record's — the
    /// server resolves the fixpoint — so a cross-device pane holding the
    /// pre-rekey id folds the authoritative owner state (never a
    /// permanent "vacant"), and `aliasOf` carries the navigation to the
    /// canonical key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias_of: Option<String>,
}

/// The replayed record's truth for fenced and in-progress keys (b8ke
/// focused round-3 review R3-5; round-4 R4-6 widened the in-progress
/// states).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReplayOwnerState {
    /// The named owner is the committed live owner (a vacant key's
    /// `owner_kind: "vacant"` carries its own truth).
    Live,
    /// The record is FENCED: `owner_kind` names the fenced prior (not a
    /// live owner); the key blocks every new writer pending typed
    /// recovery. See `RuntimeOwnerReplayRecord::reason`.
    Fenced,
    /// b8ke focused round-4 review R4-6: a runtime of `owner_kind` is
    /// SPAWNING but not yet committed live — an in-progress lifecycle
    /// transition, never committed ownership (no attach/polling resume).
    Starting,
    /// b8ke focused round-4 review R4-6: a handoff owns the transition —
    /// `owner_kind` names the TARGET kind (the handoff-started
    /// broadcast's owner), pending the prior's confirmed reap and the
    /// target's commit.
    Handoff,
    /// b8ke focused round-4 review R4-6: the prior owner (`owner_kind`)
    /// is being STOPPED — the key's live era is ending; the record is an
    /// in-progress transition, never committed ownership.
    Stopping,
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
    /// b8ke focused episode-2 post-cap F4: the SENDER-side settle signal —
    /// the registering lane's guard sets this flag on Drop (the operation
    /// concluded/unwound), independent of whether anyone ever polls the
    /// boxed settle future. The stale-start probe requires it for PID-less
    /// fence release: "the operation's settle/cancellation has concluded"
    /// is probe-able HERE, never inferred from registration absence.
    settle_fired: Option<Arc<std::sync::atomic::AtomicBool>>,
    partial_runtime: Option<OwnerIdentity>,
}

impl Default for SessionRecord {
    fn default() -> Self {
        Self {
            generation: 0,
            state: OwnershipState::Vacant,
            cancellation: None,
            settle: None,
            settle_fired: None,
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

    /// b8ke focused episode-2 round-2 F1: the ticket's coordinator key —
    /// the key the claim was minted under (the claude lane's commit
    /// derives its registry key from the ticket, never a caller-passed
    /// wire id, so a claim minted under a resolved/aliased key commits
    /// under the same key).
    pub fn session_id(&self) -> &str {
        &self.session_id
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
            // The coherent fence baseline (M3-R): the same value a
            // snapshot-derived fence carries, so refreshing from
            // observe()/snapshot_records() converges on restored keys.
            let current_generation = inner.get(&key).map_or(0, snapshot_generation);
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
            // b8ke focused episode-2 round-3 F3: a superseded (re-keyed)
            // id is NEVER directly claimable — the caller resolves to the
            // canonical key first (`resolve_canonical`); a direct begin
            // under the old id would fork ownership beside the live
            // re-keyed runtime. Typed Blocked so the caller learns to
            // resolve.
            OwnershipState::Aliased { to, generation } => {
                tracing::warn!(target: "freshell_ownership",
                    event = "ownership.begin.on_aliased_key",
                    operation_id, provider, session_id,
                    aliased_to = %to, epoch = self.epoch, generation,
                    outcome = "refused", failure_reason = "REKEYED_ALIAS_KEY");
                BeginOutcome::Blocked {
                    state: OwnershipState::Aliased { to, generation },
                    retry_after_ms: OWNERSHIP_RETRY_AFTER_MS,
                }
            }
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
            // The coherent fence baseline (M3-R): the same value a
            // snapshot-derived fence carries, so refreshing from
            // observe()/snapshot_records() converges on restored keys.
            let current_generation = inner.get(&key).map_or(0, snapshot_generation);
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
            // b8ke focused episode-2 round-3 F3: as begin_start — a
            // superseded id refuses typed; resolve to the canonical key.
            OwnershipState::Aliased { to, generation } => {
                tracing::warn!(target: "freshell_ownership",
                    event = "ownership.handoff.on_aliased_key",
                    operation_id, provider, session_id,
                    aliased_to = %to, epoch = self.epoch, generation,
                    outcome = "refused", failure_reason = "REKEYED_ALIAS_KEY");
                BeginOutcome::Blocked {
                    state: OwnershipState::Aliased { to, generation },
                    retry_after_ms: OWNERSHIP_RETRY_AFTER_MS,
                }
            }
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

    /// b8ke focused episode-2 round-2 F1: atomically RE-KEY a live claim —
    /// commit the start's `Starting{op}` record under a NEW canonical
    /// session id while vacating the old key, in ONE lock scope (never
    /// both-Live, never both-Vacant; no window in which either key holds a
    /// half-committed record). The claude rollback's fork re-key uses this
    /// to move ownership to the durable id the CLIENT now sees (the
    /// materialization replaced the pane's sessionRef) — one source of
    /// truth: every later lifecycle operation on the new id finds the
    /// owner; the old key replays Vacant so stale divergence clears.
    ///
    /// Refused typed exactly like [`Self::commit_live`]: a foreign record
    /// under either key, or a stale generation, is the caller's
    /// teardown path — never a partial move.
    pub fn commit_live_rekey(
        &self,
        provider: &str,
        old_session_id: &str,
        new_session_id: &str,
        operation_id: &str,
        generation: u64,
        mut owner: OwnerIdentity,
    ) -> CommitOutcome {
        let mut inner = self.inner.lock().expect("ownership lock poisoned");
        let old_key = SessionKey::new(provider, old_session_id);
        // Validation pass (immutable reads — the mutation below cannot
        // interleave with any of these checks).
        let initiator;
        let since_ms;
        {
            let Some(record) = inner.get(&old_key) else {
                return CommitOutcome::ForeignOperation;
            };
            if generation != record.generation {
                tracing::warn!(target: "freshell_ownership",
                    event = "ownership.commit_live_rekey.stale_generation",
                    operation_id, provider,
                    old_session_id, new_session_id,
                    epoch = self.epoch, generation, current_generation = record.generation,
                    outcome = "refused", failure_reason = "STALE_GENERATION");
                return CommitOutcome::StaleGeneration {
                    current_generation: record.generation,
                };
            }
            initiator = record.state.initiator().unwrap_or_default();
            since_ms = record.state.since_ms();
            match &record.state {
                OwnershipState::Starting {
                    operation_id: op, ..
                } if op == operation_id => {}
                _ => return CommitOutcome::ForeignOperation,
            }
            // A record already present under the NEW key means a competitor
            // claimed the client-visible id in the claim window — the typed
            // refusal; the caller tears its runtime down. Never overwrite.
            if inner
                .get(&SessionKey::new(provider, new_session_id))
                .is_some()
            {
                tracing::error!(target: "invariant",
                    event = "ownership.commit_live_rekey.target_occupied",
                    operation_id, provider, old_session_id, new_session_id,
                    epoch = self.epoch, generation,
                    outcome = "refused", failure_reason = "FOREIGN_TARGET_KEY");
                return CommitOutcome::ForeignOperation;
            }
        }
        if owner.ownership_id.is_none() {
            owner.ownership_id = Some(operation_id.to_string());
        }
        // THE MOVE (still one lock scope): old key → Aliased{to: new} (the
        // coordinator's own old→new resolution record), new key →
        // Live{owner} at the same generation.
        let new_key = SessionKey::new(provider, new_session_id);
        let new_record = SessionRecord {
            generation,
            state: OwnershipState::Live {
                owner: owner.clone(),
                generation,
                since_ms: now_epoch_ms(),
            },
            ..SessionRecord::default()
        };
        let duration_ms = since_ms
            .map(|start| now_epoch_ms().saturating_sub(start))
            .unwrap_or(0);
        if let Some(record) = inner.get_mut(&old_key) {
            record.state = OwnershipState::Aliased {
                to: new_session_id.to_string(),
                generation,
            };
        }
        inner.insert(new_key, new_record);
        tracing::info!(target: "freshell_ownership",
            event = "ownership.live.commit_rekey", operation_id, provider,
            old_session_id, new_session_id,
            initiator, from_kind = ?owner.kind,
            to_kind = ?owner.kind,
            runtime_id = ?owner.terminal_id,
            live_session_key = ?owner.live_session_key, pid = ?owner.pid,
            epoch = self.epoch, generation, duration_ms,
            outcome = "rekeyed_committed",
            "the start's record moved to the client-visible durable id in one \
             atomic step — the old key is Aliased, the new key is Live");
        CommitOutcome::Committed
    }

    /// b8ke focused episode-2 round-3 F1: re-key an ALREADY-LIVE record —
    /// the normal Claude rollback shape whose lane claim observes the
    /// existing `Live{FreshAgent}` owner and answers Adopt with NO ticket.
    /// The coordinator record (and its writer identity) moves old→new in
    /// ONE atomic registry step: never both-Live, never both-Vacant; the
    /// old key becomes `Aliased{to: new}` (the registry's own resolution
    /// record). A record already present under the NEW key refuses typed —
    /// never an overwrite. Full transition schema (finding 8): from_kind,
    /// to_kind, runtime id/pid, duration.
    #[allow(clippy::too_many_arguments)] // the rekey field set (expected identity + replacement owner)
    pub fn rekey_live(
        &self,
        provider: &str,
        old_session_id: &str,
        new_session_id: &str,
        expected_live_session_key: &str,
        new_owner: OwnerIdentity,
        initiator: &str,
    ) -> CommitOutcome {
        let mut inner = self.inner.lock().expect("ownership lock poisoned");
        let old_key = SessionKey::new(provider, old_session_id);
        // b8ke focused episode-2 post-cap F1: EXPECTED-OWNER VERIFICATION.
        // The move happens ONLY for the lane's own runtime — the old record
        // must be Live, held by this lane's kind, keyed by THIS session's
        // map key. A terminal handoff that committed inside the rollback
        // window (a different owner identity or kind) refuses typed; the
        // caller tears down. The old owner's dead pid is NEVER carried: the
        // caller supplies the REPLACEMENT runtime's identity (the current
        // sidecar pid + ONE consistent operation id that the retained
        // stamp reuses, so exit/crash release matches).
        let (old_owner, since_ms) = {
            let Some(record) = inner.get(&old_key) else {
                return CommitOutcome::ForeignOperation;
            };
            match record.state.clone() {
                OwnershipState::Live {
                    owner, since_ms, ..
                } => {
                    if owner.kind != new_owner.kind
                        || owner.live_session_key.as_deref() != Some(expected_live_session_key)
                    {
                        tracing::error!(target: "invariant",
                            event = "ownership.rekey_live.expected_owner_mismatch",
                            provider, old_session_id, new_session_id,
                            expected_live_session_key,
                            observed_kind = ?owner.kind,
                            observed_live_session_key = ?owner.live_session_key,
                            epoch = self.epoch,
                            outcome = "refused",
                            failure_reason = "FOREIGN_LIVE_OWNER");
                        return CommitOutcome::ForeignOperation;
                    }
                    (owner, since_ms)
                }
                _ => return CommitOutcome::ForeignOperation,
            }
        };
        if inner.contains_key(&SessionKey::new(provider, new_session_id)) {
            tracing::error!(target: "invariant",
                event = "ownership.rekey_live.target_occupied",
                provider, old_session_id, new_session_id,
                epoch = self.epoch,
                outcome = "refused", failure_reason = "FOREIGN_TARGET_KEY");
            return CommitOutcome::ForeignOperation;
        }
        // b8ke F1: the rekey is a GENERATION-INCREMENTING transition — the
        // moved record's generation is one past the old Live era's, so a
        // concurrent stale-generation observer is refused by arithmetic,
        // not luck.
        let duration_ms = now_epoch_ms().saturating_sub(since_ms);
        let old_generation = inner.get(&old_key).map(|r| r.generation).unwrap_or(0);
        let new_generation = old_generation + 1;
        if let Some(record) = inner.get_mut(&old_key) {
            record.generation = new_generation;
            record.state = OwnershipState::Aliased {
                to: new_session_id.to_string(),
                generation: new_generation,
            };
        }
        let new_key = SessionKey::new(provider, new_session_id);
        let new_record = SessionRecord {
            generation: new_generation,
            state: OwnershipState::Live {
                owner: new_owner.clone(),
                generation: new_generation,
                since_ms: now_epoch_ms(),
            },
            ..SessionRecord::default()
        };
        inner.insert(new_key, new_record);
        tracing::info!(target: "freshell_ownership",
            event = "ownership.live.rekey_live", provider,
            old_session_id, new_session_id, initiator,
            from_kind = ?old_owner.kind, to_kind = ?new_owner.kind,
            runtime_id = ?new_owner.terminal_id,
            live_session_key = ?new_owner.live_session_key, pid = ?new_owner.pid,
            epoch = self.epoch, generation = new_generation, duration_ms,
            outcome = "rekeyed_committed",
            "the LIVE record moved to the client-visible durable id in one \
             atomic step — expected-owner verified, generation incremented, \
             the old key is Aliased, the new key carries the REPLACEMENT identity");
        CommitOutcome::Committed
    }

    /// b8ke focused episode-2 round-3 F3: resolve a wire session id to its
    /// CANONICAL coordinator key — the id itself, unless its record is
    /// `Aliased` (the durable re-key residue the coordinator itself
    /// owns). Walked to the FIXPOINT — never a bounded link cap — with a
    /// visited guard so a corrupt cycle terminates at the first repeat.
    pub fn resolve_canonical(&self, provider: &str, session_id: &str) -> String {
        let inner = self.inner.lock().expect("ownership lock poisoned");
        let mut current = session_id.to_string();
        let mut visited = std::collections::HashSet::new();
        loop {
            if !visited.insert(current.clone()) {
                break;
            }
            let aliased_to = match inner.get(&SessionKey::new(provider, &current)) {
                Some(record) => match &record.state {
                    OwnershipState::Aliased { to, .. } => Some(to.clone()),
                    _ => None,
                },
                None => None,
            };
            match aliased_to {
                Some(next) => current = next,
                None => break,
            }
        }
        current
    }

    /// Fail an in-flight operation: `Starting` → Vacant; `Handoff` → restore
    /// the prior owner ONLY when the caller confirms it is still live
    /// (`prior_confirmed_live: true`) — restored at the RECORD's CURRENT
    /// (handoff-bumped) generation, a FORWARD bump of the Live state that
    /// never rolls the record's monotonic counter back, so every fence
    /// family converges on one value: the handoff broadcasts the clients'
    /// monotonic folds hold (they cannot regress), the wire pairs those
    /// clients send, and the lane stamps/claims the host repairs
    /// (whole-branch review M-1 — a restored Live state at the prior's
    /// ORIGINAL generation wedged every wire-fenced kill from a client
    /// that folded the handoff frames in a StaleClaim loop until a
    /// reconnect). A reaped/confirmed-dead prior ends
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
                    Some((owner, _)) if prior_confirmed_live => {
                        // Whole-branch review M-1: the Live state resumes at
                        // the RECORD's current generation (== the handoff's,
                        // fence-checked above) — NOT the prior's original.
                        // The handoff broadcasts carried this generation to
                        // every client and their same-epoch monotonic folds
                        // cannot regress, so any lower Live generation
                        // would wedge every wire-fenced kill (begin_stop's
                        // exact match) in a StaleClaim loop until a
                        // reconnect. The record's own counter is untouched
                        // (never a rollback).
                        let restored_generation = record.generation;
                        record.state = OwnershipState::Live {
                            owner: owner.clone(),
                            generation: restored_generation,
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
            // b8ke focused episode-2 round-1 F1: a Fenced record — ANY
            // reason, including the watchdog's StaleStart — is NEVER
            // released by this generic fail. The delta-r2 arm cleared a
            // StaleStart fence merely because the operation's ticket
            // dropped, but a handler unwind proves only that the handler
            // cannot COMMIT; it does not prove the detached sidecar or its
            // descendants died. The strict release discipline is the only
            // path: a CONFIRMED-death probe invoking [`Self::release_fenced`]
            // (or the lane teardowns), never a stray fail — never plain
            // Vacant over an unconfirmed runtime.
            _ => FailOutcome::ForeignOperation,
        }
    }

    /// b8ke focused round-2 review R2-1: fail an in-flight `Handoff` whose
    /// DETACHED reap watcher was lost (its confirmation future failed — a
    /// JoinError) to the TYPED [`OwnershipState::Fenced`] state carrying
    /// [`FenceReason::WatcherFailed`] — NEVER plain `Vacant` (the round-1
    /// fail-open licensed a second writer over a possibly-live prior).
    /// The key stays fenced — every competing begin is Blocked with the
    /// typed in-flight answer — until the caller's replacement watcher
    /// confirms the prior's death (a bounded recorded-identity probe) and
    /// invokes [`Self::release_fenced`]. The captured prior identity
    /// (with the generation it held Live) rides the state so the probe has
    /// its kill target. Fenced exactly like [`Self::fail`]: a foreign
    /// operation/generation is the typed no-op.
    pub fn fence_unconfirmed_handoff(
        &self,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        generation: u64,
        reason: FenceReason,
    ) -> FenceOutcome {
        let mut inner = self.inner.lock().expect("ownership lock poisoned");
        let key = SessionKey::new(provider, session_id);
        let Some(record) = inner.get_mut(&key) else {
            return FenceOutcome::ForeignOperation;
        };
        if generation != record.generation {
            return FenceOutcome::ForeignOperation;
        }
        let initiator = record.state.initiator().unwrap_or_default();
        match record.state.clone() {
            OwnershipState::Handoff {
                operation_id: op,
                prior,
                ..
            } if op == operation_id => {
                let duration_ms = now_epoch_ms()
                    .saturating_sub(record.state.since_ms().unwrap_or(now_epoch_ms()));
                record.state = OwnershipState::Fenced {
                    prior,
                    reason,
                    operation_id: op,
                    generation,
                    initiator: initiator.clone(),
                    since_ms: now_epoch_ms(),
                };
                tracing::error!(target: "freshell_ownership",
                    event = "ownership.handoff.fenced_unconfirmed", operation_id, provider, session_id,
                    initiator, epoch = self.epoch, generation, duration_ms,
                    fence_reason = ?reason, outcome = "fenced",
                    failure_reason = "UNCONFIRMED_PRIOR_DEATH",
                    "the reap confirmation failed without confirming the prior's death — \
                     the key is fenced (blocked for every new writer) until confirmed death \
                     releases it; never a fail-open to Vacant");
                FenceOutcome::Fenced
            }
            _ => FenceOutcome::ForeignOperation,
        }
    }

    /// b8ke focused round-2 review R2-2: an explicit stop whose teardown
    /// could not confirm the prior runtime tree's death (a bounded
    /// platform-limited confirmation) moves `Stopping{op}` to the TYPED
    /// [`OwnershipState::Fenced`] state — never `commit_stop`'s `Vacant`.
    /// The key stays fenced until confirmed death releases it (on
    /// non-Linux nothing can — the documented tradeoff).
    pub fn fence_unconfirmed_stop(
        &self,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        generation: u64,
        reason: FenceReason,
    ) -> FenceOutcome {
        let mut inner = self.inner.lock().expect("ownership lock poisoned");
        let key = SessionKey::new(provider, session_id);
        let Some(record) = inner.get_mut(&key) else {
            return FenceOutcome::ForeignOperation;
        };
        if generation != record.generation {
            return FenceOutcome::ForeignOperation;
        }
        let initiator = record.state.initiator().unwrap_or_default();
        match record.state.clone() {
            OwnershipState::Stopping {
                operation_id: op,
                owner,
                prior_generation,
                ..
            } if op == operation_id => {
                let prior =
                    owner.map(|o| (o, prior_generation.unwrap_or(generation.saturating_sub(1))));
                let duration_ms = now_epoch_ms()
                    .saturating_sub(record.state.since_ms().unwrap_or(now_epoch_ms()));
                record.state = OwnershipState::Fenced {
                    prior,
                    reason,
                    operation_id: op,
                    generation,
                    initiator: initiator.clone(),
                    since_ms: now_epoch_ms(),
                };
                tracing::error!(target: "freshell_ownership",
                    event = "ownership.stop.fenced_unconfirmed", operation_id, provider, session_id,
                    initiator, epoch = self.epoch, generation, duration_ms,
                    fence_reason = ?reason, outcome = "fenced",
                    failure_reason = "UNCONFIRMED_PRIOR_DEATH",
                    "the stop's teardown could not confirm the prior's death — the key is \
                     fenced (blocked for every new writer) until confirmed death releases it");
                FenceOutcome::Fenced
            }
            _ => FenceOutcome::ForeignOperation,
        }
    }

    /// b8ke focused round-2 review: `Fenced{op}` → `Vacant` (generation
    /// preserved). The caller MUST have CONFIRMED the fenced prior's death
    /// (a bounded identity/pid probe or a watcher event) before invoking —
    /// this is the ONLY transition that reopens a fenced key, and it is
    /// never taken on faith. Fenced on (operation_id, generation) exactly
    /// like [`Self::commit_stop`].
    pub fn release_fenced(
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
            OwnershipState::Fenced {
                operation_id: op,
                prior,
                reason,
                since_ms,
                ..
            } if op == operation_id => {
                let duration_ms = now_epoch_ms().saturating_sub(since_ms);
                // F8: capture the fencing initiator BEFORE the record clears.
                let fencing_initiator = record.state.initiator();
                record.state = OwnershipState::Vacant;
                tracing::info!(target: "freshell_ownership",
                    event = "ownership.fenced.released", operation_id, provider, session_id,
                    from_kind = ?prior.as_ref().map(|(o, _)| o.kind),
                    to_kind = ?prior.as_ref().map(|(o, _)| o.kind),
                    runtime_id = ?prior.as_ref().and_then(|(o, _)| o.terminal_id.clone()),
                    pid = ?prior.as_ref().and_then(|(o, _)| o.pid),
                    initiator = ?fencing_initiator,
                    epoch = self.epoch, generation, duration_ms,
                    fence_reason = ?reason, outcome = "released_on_confirmed_death");
                CommitOutcome::Committed
            }
            _ => CommitOutcome::ForeignOperation,
        }
    }

    /// b8ke focused round-3 review R3-4: the typed operator recovery for a
    /// `Fenced{PlatformLimited}` key — the bounded path that keeps the
    /// session from being permanently disabled on non-Linux hosts. The
    /// b8ke focused episode-2 round-2 F5: enumerate the live
    /// `Fenced{StaleStart}` records — the watchdog's CONFIRMED-DEATH
    /// PROBE input. The stale-start sweep itself never revisits fenced
    /// records (it only recovers `Starting`), so a fence created before
    /// its runtime's reap evidence existed would otherwise be permanent:
    /// the host re-probes each fence's recorded prior pid every sweep and
    /// releases through [`Self::release_fenced`] ONLY on confirmed death
    /// (the pid is GONE — no signal is ever sent, so a recycled pid's
    /// unrelated occupant is safe: a LIVE pid, whatever its incarnation,
    /// keeps the fence held).
    pub fn stale_start_fences(&self) -> Vec<StaleStartFence> {
        let inner = self.inner.lock().expect("ownership lock poisoned");
        let mut out = Vec::new();
        for (key, record) in inner.iter() {
            if let OwnershipState::Fenced {
                prior,
                reason: FenceReason::StaleStart,
                operation_id,
                generation,
                initiator,
                ..
            } = &record.state
            {
                out.push(StaleStartFence {
                    provider: key.provider.clone(),
                    session_id: key.session_id.clone(),
                    operation_id: operation_id.clone(),
                    generation: *generation,
                    prior_pid: prior.as_ref().and_then(|(owner, _)| owner.pid),
                    initiator: initiator.clone(),
                    prior_kind: prior.as_ref().map(|(owner, _)| owner.kind),
                    settle_fired: record
                        .settle_fired
                        .as_ref()
                        .map(|f| f.load(std::sync::atomic::Ordering::SeqCst)),
                });
            }
        }
        out
    }

    /// non-Linux teardown semantics: the direct child's awaited exit WAS
    /// confirmed (the portable floor); only the DESCENDANT-tree
    /// verification is platform-limited. An EXPLICIT operator action — a
    /// handoff retry carrying a FRESH observed fence (the recovery UI's
    /// Retry refreshes the pair from the runtime-owner record) — may
    /// therefore force-clear the fence, and the log records the limitation
    /// honestly (the descendant tree is UNVERIFIED, not confirmed dead).
    /// Every other shape is the typed refusal: a `WatcherFailed` fence (a
    /// bounded probe can still confirm it), any non-fenced state, and a
    /// stale/mismatched observation (a different epoch, or an older
    /// generation than the fenced record) — the default path stays fenced.
    pub fn force_release_platform_limited(
        &self,
        provider: &str,
        session_id: &str,
        observed: ObservedFence,
        initiator: &str,
    ) -> ForceReleaseOutcome {
        let mut inner = self.inner.lock().expect("ownership lock poisoned");
        let key = SessionKey::new(provider, session_id);
        let Some(record) = inner.get_mut(&key) else {
            return ForceReleaseOutcome::NotPlatformLimited {
                state: OwnershipState::Vacant,
            };
        };
        let current_generation = snapshot_generation(record);
        if observed.epoch != self.epoch || observed.generation != current_generation {
            tracing::warn!(target: "freshell_ownership",
                event = "ownership.fenced.force_release_platform_limited",
                provider, session_id, initiator,
                observed_epoch = observed.epoch, observed_generation = observed.generation,
                epoch = self.epoch, current_generation,
                outcome = "refused", failure_reason = "STALE_OBSERVATION",
                "the force-clear's observed fence is stale — refresh and retry");
            return ForceReleaseOutcome::StaleObservation {
                current_epoch: self.epoch,
                current_generation,
            };
        }
        match record.state.clone() {
            OwnershipState::Fenced {
                reason: reason @ (FenceReason::PlatformLimited | FenceReason::StaleStart),
                operation_id,
                prior,
                since_ms,
                ..
            } => {
                // b8ke focused episode-2 round-3 F7: the acknowledged
                // operator force-clear accepts BOTH fence reasons. A
                // PID-less StaleStart fence is a SUPPORTED production
                // shape (the opencode lane registers no per-session pid
                // and no settle/cancellation future) — without this
                // recovery path those fences were permanent and every
                // retryable lifecycle op on the session blocked until a
                // server restart. The operator's acknowledged risk is
                // documented identically: the recorded runtime identity
                // could not be CONFIRMED dead (no pid to probe / the
                // recorded tree unreadable on this platform), so
                // surviving processes are the operator's acknowledged
                // risk — never a silent licensing.
                let duration_ms = now_epoch_ms().saturating_sub(since_ms);
                record.state = OwnershipState::Vacant;
                tracing::warn!(target: "freshell_ownership",
                    event = "ownership.fenced.force_released_unconfirmable",
                    provider, session_id, initiator,
                    fenced_operation_id = %operation_id,
                    from_kind = ?prior.as_ref().map(|(o, _)| o.kind),
                    runtime_id = ?prior.as_ref().and_then(|(o, _)| o.terminal_id.clone()),
                    pid = ?prior.as_ref().and_then(|(o, _)| o.pid),
                    epoch = self.epoch, generation = record.generation, duration_ms,
                    fence_reason = ?reason,
                    outcome = "force_released_on_operator_action",
                    "an explicit acknowledged operator force-clear released an \
                     UNCONFIRMABLE fence (PlatformLimited or PID-less StaleStart): the \
                     recorded runtime identity could not be confirmed dead — surviving \
                     processes are the operator's acknowledged risk, recorded honestly, \
                     never a confirmed reap");
                ForceReleaseOutcome::Released
            }
            state => ForceReleaseOutcome::NotPlatformLimited { state },
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
                        // begin_stop (M3: for a stop-abandoned restore it
                        // can be lower than the record's bumped generation;
                        // a failed-handoff restore no longer straddles —
                        // whole-branch M-1).
                        current_generation: generation,
                        state: record.state.clone(),
                    };
                }
                record.generation += 1;
                record.state = OwnershipState::Stopping {
                    owner: Some(owner.clone()),
                    // The PRE-stop Live generation — `abort_stop`'s restore
                    // target (Task 4 review F1: a stop abandoned with the
                    // runtime still alive must unwind to a fence-coherent
                    // `Live`, never the bumped record generation).
                    prior_generation: Some(generation),
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

    /// Abort a GRANTED stop whose kill was abandoned BEFORE the reap (Task 4
    /// review F1): the stopper began, then exited without killing — the
    /// runtime is CONFIRMED still alive (e.g. the terminal lane's durable
    /// ledger close failed cleanly and the kill deliberately left the
    /// terminal running). `Stopping{op}` → `Live`, restoring the captured
    /// owner at its PRE-STOP generation so every fence a pre-stop observer
    /// carries (retained stamp, snapshot) stays coherent — unlike the
    /// failed-handoff restore, which writes the record's CURRENT generation
    /// because the handoff broadcasts carried it to every client
    /// (whole-branch review M-1); the stop path broadcasts nothing at the
    /// bumped generation, so the pre-stop fences are the ones observers
    /// hold. Neither restore ever rolls the record's monotonic counter
    /// back. Fenced on (operation_id, generation) exactly like
    /// `commit_stop`; a watchdog-synthesized `Stopping` (no prior Live era)
    /// is a typed `ForeignOperation` no-op — the host's abort/settle/commit
    /// owns that transition.
    pub fn abort_stop(
        &self,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        generation: u64,
    ) -> AbortStopOutcome {
        let mut inner = self.inner.lock().expect("ownership lock poisoned");
        let key = SessionKey::new(provider, session_id);
        let Some(record) = inner.get_mut(&key) else {
            return AbortStopOutcome::ForeignOperation;
        };
        if generation != record.generation {
            return AbortStopOutcome::StaleGeneration {
                current_generation: record.generation,
            };
        }
        let initiator = record.state.initiator().unwrap_or_default();
        match record.state.clone() {
            OwnershipState::Stopping {
                owner: Some(owner),
                prior_generation: Some(prior_generation),
                operation_id: op,
                since_ms,
                ..
            } if op == operation_id => {
                let duration_ms = now_epoch_ms().saturating_sub(since_ms);
                record.state = OwnershipState::Live {
                    owner: owner.clone(),
                    generation: prior_generation,
                    since_ms: now_epoch_ms(),
                };
                tracing::warn!(target: "freshell_ownership",
                    event = "ownership.stop.aborted", operation_id, provider, session_id,
                    initiator, from_kind = ?owner.kind,
                    runtime_id = ?owner.terminal_id, pid = ?owner.pid,
                    epoch = self.epoch, generation, restored_generation = prior_generation,
                    outcome = "restored_live", duration_ms,
                    failure_reason = "STOP_ABANDONED_RUNTIME_ALIVE");
                AbortStopOutcome::Aborted
            }
            _ => AbortStopOutcome::ForeignOperation,
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
            // b8ke focused round-2 review: a fenced key reopens ONLY via
            // `release_fenced` after ITS OWN probe confirms the prior's
            // death — the fenced record's operation id is the fencing
            // (handoff/stop) operation, which no lane TTL claim carries.
            OwnershipState::Fenced { .. } => false,
            OwnershipState::Vacant | OwnershipState::Aliased { .. } => false,
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
    #[allow(clippy::too_many_arguments)] // the registration field set (+ the e2 post-cap settle flag)
    pub fn register_start_cancellation(
        &self,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        generation: u64,
        abort: Arc<dyn Fn() + Send + Sync>,
        settle: Box<dyn std::future::Future<Output = ()> + Send>,
        settle_fired: Option<Arc<std::sync::atomic::AtomicBool>>,
    ) -> bool {
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
                    record.settle_fired = settle_fired;
                    return true;
                }
            }
        }
        // b8ke focused episode-2 post-cap F6: the registration DECLINED —
        // the caller must know (a loudly-logged no-cancellation, never a
        // silent fence-bait). Reachable when the wire id was a superseded
        // alias (pre-fix the helper registered against the ALIASED key)
        // or the operation already moved on.
        false
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
                        // A zombie-`Starting` synthesis has no prior Live
                        // era — the host's abort/settle/commit owns this
                        // transition; `abort_stop` is a typed no-op here.
                        prior_generation: None,
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
                        since_ms,
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
    ///
    /// b8ke focused round-3 review R3-5: a FENCED record replays its
    /// truth — `state: "fenced"` + the typed reason, with `owner_kind`
    /// naming the fenced PRIOR (the owner the handoff-failed frames
    /// already named on every device). The client folds a fenced record as
    /// the typed recovery state (handoff-failed + reason), NEVER as a
    /// committed live owner.
    ///
    /// b8ke focused round-4 review R4-6: the in-progress lifecycle states
    /// (`Starting`/`Handoff`/`Stopping`) replay as their OWN states —
    /// a reconnecting device folds them as transition-in-progress, never
    /// as committed live ownership.
    /// b8ke focused episode-2 post-cap F5: the replay fields for one
    /// state — shared by the direct replay arms and the ALIASED key's
    /// canonical resolution (the old key replays exactly what the
    /// canonical record would).
    fn replay_fields_for(
        state: &OwnershipState,
    ) -> (
        &'static str,
        Option<String>,
        ReplayOwnerState,
        Option<String>,
    ) {
        match state {
            OwnershipState::Vacant | OwnershipState::Aliased { .. } => {
                ("vacant", None, ReplayOwnerState::Live, None)
            }
            OwnershipState::Live { owner, .. } => (
                kind_wire(&owner.kind),
                owner.terminal_id.clone(),
                ReplayOwnerState::Live,
                None,
            ),
            OwnershipState::Starting { kind, .. } => {
                (kind_wire(kind), None, ReplayOwnerState::Starting, None)
            }
            OwnershipState::Handoff { to_kind, .. } => {
                (kind_wire(to_kind), None, ReplayOwnerState::Handoff, None)
            }
            OwnershipState::Stopping { owner, .. } => match owner {
                Some(owner) => (
                    kind_wire(&owner.kind),
                    owner.terminal_id.clone(),
                    ReplayOwnerState::Stopping,
                    None,
                ),
                None => ("vacant", None, ReplayOwnerState::Stopping, None),
            },
            OwnershipState::Fenced {
                prior,
                reason: fence_reason,
                ..
            } => {
                let wire_reason = Some(fence_reason.wire_str().to_string());
                match prior {
                    Some((owner, _)) => (
                        kind_wire(&owner.kind),
                        owner.terminal_id.clone(),
                        ReplayOwnerState::Fenced,
                        wire_reason,
                    ),
                    None => ("vacant", None, ReplayOwnerState::Fenced, wire_reason),
                }
            }
        }
    }

    /// b8ke focused episode-2 post-cap F5: the fixpoint alias walk under
    /// the caller's already-held lock (the public `resolve_canonical`
    /// re-locks; this one is for `snapshot_records`'s single pass).
    fn resolve_canonical_locked(
        inner: &std::collections::HashMap<SessionKey, SessionRecord>,
        provider: &str,
        session_id: &str,
    ) -> String {
        let mut current = session_id.to_string();
        let mut visited = std::collections::HashSet::new();
        loop {
            if !visited.insert(current.clone()) {
                break;
            }
            let aliased_to = match inner.get(&SessionKey::new(provider, &current)) {
                Some(record) => match &record.state {
                    OwnershipState::Aliased { to, .. } => Some(to.clone()),
                    _ => None,
                },
                None => None,
            };
            match aliased_to {
                Some(next) => current = next,
                None => break,
            }
        }
        current
    }

    pub fn snapshot_records(&self) -> Vec<RuntimeOwnerReplayRecord> {
        let inner = self.inner.lock().expect("ownership lock poisoned");
        inner
            .iter()
            .map(|(key, record)| {
                // b8ke focused episode-2 post-cap F5: an ALIASED key
                // replays the CANONICAL record's resolved truth (the
                // server walks the fixpoint) plus `alias_of` — the old key
                // is never a permanent "vacant" for a stale pane; it folds
                // the authoritative owner state and can navigate to the
                // canonical id.
                let alias_of = match &record.state {
                    OwnershipState::Aliased { to, .. } => {
                        Some(Self::resolve_canonical_locked(&inner, &key.provider, to))
                    }
                    _ => None,
                };
                let (owner_kind, terminal_id, replay_state, reason) = match &record.state {
                    // b8ke focused episode-2 post-cap F5: an ALIASED key
                    // replays the CANONICAL record's resolved truth (the
                    // server walks the fixpoint) plus `alias_of` — the old
                    // key is never a permanent "vacant" for a stale pane;
                    // it folds the authoritative owner state and can
                    // navigate to the canonical id.
                    OwnershipState::Aliased { to, .. } => {
                        match inner.get(&SessionKey::new(&key.provider, to)) {
                            Some(resolved) => Self::replay_fields_for(&resolved.state),
                            // The canonical record is absent (post-restart
                            // residue): the honest vacant truth.
                            None => ("vacant", None, ReplayOwnerState::Live, None),
                        }
                    }
                    _ => Self::replay_fields_for(&record.state),
                };
                // An aliased key replays the CANONICAL record's
                // generation too (the old key's own generation is the
                // rekey-era residue; the authoritative number is the
                // canonical record's).
                let (generation, resolved_alias_of) = match (&record.state, &alias_of) {
                    (OwnershipState::Aliased { to, .. }, _) => (
                        inner
                            .get(&SessionKey::new(&key.provider, to))
                            .map(snapshot_generation)
                            .unwrap_or_else(|| snapshot_generation(record)),
                        alias_of,
                    ),
                    _ => (snapshot_generation(record), None),
                };
                RuntimeOwnerReplayRecord {
                    provider: key.provider.clone(),
                    session_id: key.session_id.clone(),
                    epoch: self.epoch,
                    generation,
                    owner_kind: owner_kind.to_string(),
                    terminal_id,
                    state: replay_state,
                    reason,
                    alias_of: resolved_alias_of,
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

    /// kata b8ke (Task 11 e2e red): the DEFAULT boot epoch must stay inside
    /// the JSON-safe integer range. Every browser client parses the epoch
    /// as an IEEE-754 double (JSON.parse) — and the ready-frame schema's
    /// zod v4 `.int()` enforces exactly this bound — so a full-64-bit epoch
    /// is either silently dropped from `ready.runtimeOwners` (the array's
    /// `.catch(undefined)` swallows the whole replay) or rounds to a
    /// DIFFERENT integer in any `observedEpoch` fence the client sends
    /// back, poisoning every fence comparison. Injected epochs
    /// (`with_epoch`) stay unconstrained by contract.
    #[test]
    fn default_boot_epoch_fits_the_json_safe_integer_range() {
        for _ in 0..64 {
            assert!(
                default_boot_epoch() <= 9_007_199_254_740_991,
                "the default boot epoch must survive the JS double/zod safe-int round trip"
            );
        }
    }

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

    /// kata b8ke Task 6: the handoff runner reads the captured prior (and its
    /// pre-handoff Live generation) off the `Handoff` state — and only there.
    #[test]
    fn prior_owner_is_the_handoff_states_captured_prior_and_its_generation() {
        let (r, owner, live_gen) = registry_with_live_terminal();
        let BeginOutcome::Granted { .. } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "ho-1",
            None,
            "test",
            2_000,
        ) else {
            panic!("expected Granted")
        };
        let snap = r.observe(PROVIDER, "sid");
        assert_eq!(
            snap.state.prior_owner(),
            Some((stamped(owner, "op-1"), live_gen)),
            "the Handoff state carries the pre-handoff Live owner and ITS generation"
        );
        // Every other state carries no prior (Vacant before any claim; the
        // Live and Starting states of a fresh key).
        assert_eq!(OwnershipState::Vacant.prior_owner(), None);
        let r2 = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation } = r2.begin_start(
            PROVIDER,
            "other",
            RuntimeOwnerKind::Terminal,
            "op-a",
            None,
            "test",
            1,
        ) else {
            panic!("expected Granted")
        };
        let _ = r2.commit_live(
            PROVIDER,
            "other",
            "op-a",
            generation,
            fresh_agent_owner(4321),
        );
        assert_eq!(
            r2.observe(PROVIDER, "other").state.prior_owner(),
            None,
            "Live is not a handoff — no prior"
        );
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
            None,
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

    /// b8ke focused episode-2 round-3 F1: `rekey_live` — the Adopt-path
    /// move the claude rollback's NORMAL live-rollback takes (its lane
    /// claim observes the existing Live{FreshAgent} owner and answers
    /// Adopt with NO ticket; pre-e2r3 the lane helper reported success
    /// without doing ANYTHING, leaving ownership + stamp under the old id
    /// while the client pane carried the new id — the deterministic
    /// split identity). The Live record moves old→new atomically; the
    /// old key becomes Aliased{to: new}; an occupied target key refuses
    /// typed; a non-Live old key refuses typed.
    #[test]
    fn rekey_live_moves_the_live_record_and_refuses_typed() {
        let r = RuntimeOwnershipRegistry::new();
        // A LIVE owner under the old id (the post-Adopt rollback shape).
        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            "old-live",
            RuntimeOwnerKind::FreshAgent,
            "op-original",
            None,
            "test",
            0,
        ) else {
            panic!()
        };
        let owner = OwnerIdentity {
            kind: RuntimeOwnerKind::FreshAgent,
            terminal_id: None,
            live_session_key: Some("map-key".into()),
            pid: Some(4321),
            ownership_id: None,
        };
        assert!(matches!(
            r.commit_live(PROVIDER, "old-live", "op-original", generation, owner),
            CommitOutcome::Committed
        ));

        // THE MOVE (e2 post-cap F1 contract): the expected owner verifies
        // (kind + THIS session's map key); the REPLACEMENT identity lands
        // under the new id — the CURRENT pid (9999), ONE consistent
        // operation id the retained stamp reuses — and the generation
        // INCREMENTS (a stale-generation observer is refused by
        // arithmetic).
        let replacement = OwnerIdentity {
            kind: RuntimeOwnerKind::FreshAgent,
            terminal_id: None,
            live_session_key: Some("map-key".into()),
            pid: Some(9999),
            ownership_id: Some("rekey-op-1".into()),
        };
        assert!(matches!(
            r.rekey_live(
                PROVIDER,
                "old-live",
                "new-live",
                "map-key",
                replacement.clone(),
                "test-rekey"
            ),
            CommitOutcome::Committed
        ));
        let observed_new = r.observe(PROVIDER, "new-live");
        match observed_new.state {
            OwnershipState::Live {
                owner: moved,
                generation: live_gen,
                ..
            } => {
                // Identities MUST match the replacement — never the dead
                // old pid, never a fabricated operation id.
                assert_eq!(moved.kind, RuntimeOwnerKind::FreshAgent);
                assert_eq!(moved.live_session_key.as_deref(), Some("map-key"));
                assert_eq!(moved.pid, Some(9999));
                assert_eq!(moved.ownership_id.as_deref(), Some("rekey-op-1"));
                assert_eq!(
                    live_gen,
                    generation + 1,
                    "the rekey increments the generation"
                );
            }
            other => panic!("expected Live under the new id, got {other:?}"),
        }
        assert!(matches!(
            r.observe(PROVIDER, "old-live").state,
            OwnershipState::Aliased { to, .. } if to == "new-live"
        ));
        assert_eq!(r.resolve_canonical(PROVIDER, "old-live"), "new-live");

        // e2 post-cap F1: a subsequent KILL succeeds against the moved
        // record — the stop claim's expected runtime MATCHES (the
        // replacement identity), the typed stop proceeds.
        let stop_claim = StopClaim {
            expected_kind: RuntimeOwnerKind::FreshAgent,
            expected_runtime: Some(replacement.clone()),
            observed: ObservedFence {
                epoch: r.boot_epoch(),
                generation: generation + 1,
            },
        };
        match r.begin_stop(PROVIDER, "new-live", "test-kill", &stop_claim, "test", 0) {
            StopOutcome::Granted {
                generation: stop_gen,
            } => {
                assert!(matches!(
                    r.commit_stop(PROVIDER, "new-live", "test-kill", stop_gen),
                    CommitOutcome::Committed
                ));
            }
            other => panic!("the kill after rekey must be granted, got {other:?}"),
        }
        assert!(matches!(
            r.observe(PROVIDER, "new-live").state,
            OwnershipState::Vacant
        ));

        // e2 post-cap F1: EXIT-AFTER-REKEY releases. A SECOND live owner
        // under a fresh old key (the first old key is Aliased-retired —
        // begin refuses typed on a superseded id by design), then the
        // normal sidecar-exit path (force_release with the RETAINED
        // STAMP's operation id + runtime identity — the stamp and the
        // record share the SAME consistent rekey identity) must release
        // the owner.
        let replacement_2 = OwnerIdentity {
            kind: RuntimeOwnerKind::FreshAgent,
            terminal_id: None,
            live_session_key: Some("map-key-2".into()),
            pid: Some(1111),
            ownership_id: Some("rekey-op-2".into()),
        };
        let BeginOutcome::Granted { generation: g2 } = r.begin_start(
            PROVIDER,
            "old-live-b",
            RuntimeOwnerKind::FreshAgent,
            "op-original-2",
            None,
            "test",
            0,
        ) else {
            panic!()
        };
        assert!(matches!(
            r.commit_live(
                PROVIDER,
                "old-live-b",
                "op-original-2",
                g2,
                OwnerIdentity {
                    kind: RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some("map-key-2".into()),
                    pid: Some(4321),
                    ownership_id: None,
                }
            ),
            CommitOutcome::Committed
        ));
        assert!(matches!(
            r.rekey_live(
                PROVIDER,
                "old-live-b",
                "new-live-2",
                "map-key-2",
                replacement_2.clone(),
                "test-rekey-2"
            ),
            CommitOutcome::Committed
        ));
        let exit_release = ReleaseClaim {
            operation_id: "rekey-op-2".to_string(),
            generation: g2 + 1,
            runtime: Some(replacement_2.clone()),
        };
        r.force_release_for_confirmed_kill(PROVIDER, "new-live-2", &exit_release, "claude-exit");
        assert!(
            matches!(
                r.observe(PROVIDER, "new-live-2").state,
                OwnershipState::Vacant
            ),
            "the exit/crash release after rekey must release the moved owner — \
             the stamp id and the record ownership_id are ONE identity"
        );

        // An OCCUPIED target key refuses typed — never an overwrite.
        let r2 = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation: ga } = r2.begin_start(
            PROVIDER,
            "old-2",
            RuntimeOwnerKind::FreshAgent,
            "op-a",
            None,
            "test",
            0,
        ) else {
            panic!()
        };
        let owner_a = OwnerIdentity {
            kind: RuntimeOwnerKind::FreshAgent,
            terminal_id: None,
            live_session_key: Some("map-a".into()),
            pid: None,
            ownership_id: None,
        };
        assert!(matches!(
            r2.commit_live(PROVIDER, "old-2", "op-a", ga, owner_a),
            CommitOutcome::Committed
        ));
        let BeginOutcome::Granted { generation: gb } = r2.begin_start(
            PROVIDER,
            "target-2",
            RuntimeOwnerKind::Terminal,
            "op-b",
            None,
            "test",
            1,
        ) else {
            panic!()
        };
        let owner_b = OwnerIdentity {
            kind: RuntimeOwnerKind::Terminal,
            terminal_id: Some("t-b".into()),
            live_session_key: None,
            pid: None,
            ownership_id: None,
        };
        assert!(matches!(
            r2.commit_live(PROVIDER, "target-2", "op-b", gb, owner_b),
            CommitOutcome::Committed
        ));
        assert!(matches!(
            r2.rekey_live(
                PROVIDER,
                "old-2",
                "target-2",
                "map-a",
                OwnerIdentity {
                    kind: RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some("map-a".into()),
                    pid: Some(7777),
                    ownership_id: Some("rekey-op-x".into()),
                },
                "test-rekey"
            ),
            CommitOutcome::ForeignOperation
        ));
        match r2.observe(PROVIDER, "target-2").state {
            OwnershipState::Live { owner, .. } => {
                assert_eq!(owner.kind, RuntimeOwnerKind::Terminal);
            }
            other => panic!("the foreign target must keep its owner, got {other:?}"),
        }

        // e2 post-cap F1: the EXPECTED-OWNER verification — a different
        // live session key under the old id (a foreign runtime this lane
        // does not own) refuses typed.
        let r4 = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation: g4 } = r4.begin_start(
            PROVIDER,
            "old-4",
            RuntimeOwnerKind::FreshAgent,
            "op-4",
            None,
            "test",
            0,
        ) else {
            panic!()
        };
        assert!(matches!(
            r4.commit_live(
                PROVIDER,
                "old-4",
                "op-4",
                g4,
                OwnerIdentity {
                    kind: RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some("foreign-map".into()),
                    pid: Some(4),
                    ownership_id: None,
                }
            ),
            CommitOutcome::Committed
        ));
        assert!(matches!(
            r4.rekey_live(
                PROVIDER,
                "old-4",
                "new-4",
                "this-lanes-map-key",
                OwnerIdentity {
                    kind: RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some("this-lanes-map-key".into()),
                    pid: Some(5),
                    ownership_id: Some("rekey-op-4".into()),
                },
                "test-rekey"
            ),
            CommitOutcome::ForeignOperation
        ));
        // And a TERMINAL owner under the old id (the handoff-committed-
        // in-the-window shape) refuses too.
        let r5 = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation: g5 } = r5.begin_start(
            PROVIDER,
            "old-5",
            RuntimeOwnerKind::Terminal,
            "op-5",
            None,
            "test",
            0,
        ) else {
            panic!()
        };
        assert!(matches!(
            r5.commit_live(
                PROVIDER,
                "old-5",
                "op-5",
                g5,
                OwnerIdentity {
                    kind: RuntimeOwnerKind::Terminal,
                    terminal_id: Some("t-5".into()),
                    live_session_key: None,
                    pid: Some(5),
                    ownership_id: None,
                }
            ),
            CommitOutcome::Committed
        ));
        assert!(matches!(
            r5.rekey_live(
                PROVIDER,
                "old-5",
                "new-5",
                "any-map-key",
                OwnerIdentity {
                    kind: RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some("any-map-key".into()),
                    pid: Some(6),
                    ownership_id: Some("rekey-op-5".into()),
                },
                "test-rekey"
            ),
            CommitOutcome::ForeignOperation
        ));

        // A NON-LIVE (absent) old key refuses typed.
        let r3 = RuntimeOwnershipRegistry::new();
        assert!(matches!(
            r3.rekey_live(
                PROVIDER,
                "absent",
                "anywhere",
                "map-key",
                OwnerIdentity {
                    kind: RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some("map-key".into()),
                    pid: None,
                    ownership_id: None,
                },
                "test-rekey"
            ),
            CommitOutcome::ForeignOperation
        ));
    }

    /// b8ke focused episode-2 round-2 F1: the atomic re-key — a start's
    /// `Starting{op}` record under the OLD key moves to the NEW key as
    /// `Live{owner}` in ONE registry step: never both-Live, never
    /// both-Vacant, no half-moved record. The claude rollback's fork uses
    /// this to put ownership under the client-visible new durable id; the
    /// old key replays Vacant so stale divergence clears. A foreign record
    /// under the TARGET key is the typed refusal — never an overwrite.
    #[test]
    fn commit_live_rekey_moves_the_record_atomically() {
        let r = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            "old-id",
            RuntimeOwnerKind::FreshAgent,
            "op-rekey",
            None,
            "test",
            0,
        ) else {
            panic!()
        };
        let owner = OwnerIdentity {
            kind: RuntimeOwnerKind::FreshAgent,
            terminal_id: None,
            live_session_key: Some("map-key".into()),
            pid: Some(4242),
            ownership_id: None,
        };
        assert!(matches!(
            r.commit_live_rekey(
                PROVIDER,
                "old-id",
                "new-id",
                "op-rekey",
                generation,
                owner.clone()
            ),
            CommitOutcome::Committed
        ));
        // The move (e2r3 contract): old key Aliased{to: new} — the
        // coordinator's OWN old→new resolution record; new key
        // Live{FreshAgent} at the same generation — never both-Live,
        // never both-Vacant.
        assert!(matches!(
            r.observe(PROVIDER, "old-id").state,
            OwnershipState::Aliased { to, .. } if to == "new-id"
        ));
        // The fixpoint resolution walks the alias to the canonical key.
        assert_eq!(r.resolve_canonical(PROVIDER, "old-id"), "new-id");
        assert_eq!(r.resolve_canonical(PROVIDER, "new-id"), "new-id");
        match r.observe(PROVIDER, "new-id").state {
            OwnershipState::Live {
                owner: observed, ..
            } => {
                assert_eq!(observed.kind, RuntimeOwnerKind::FreshAgent);
                assert_eq!(observed.live_session_key.as_deref(), Some("map-key"));
                assert_eq!(observed.pid, Some(4242));
            }
            other => panic!("expected Live under the new id, got {other:?}"),
        }
        // The Aliased key replays writer-VACANT to clients (stale
        // divergence clears) and the new key is the sole authoritative
        // record.
        let records = r.snapshot_records();
        assert!(records.iter().any(|rec| rec.session_id == "new-id"
            && rec.owner_kind == "fresh-agent"
            && rec.state == ReplayOwnerState::Live));
        // e2 post-cap F5: the ALIASED old key replays the CANONICAL
        // record's resolved truth + `alias_of` — never a bare vacant that
        // strands a stale pane.
        let old_key_rec = records
            .iter()
            .find(|rec| rec.session_id == "old-id")
            .expect("the aliased old key replays");
        assert_eq!(old_key_rec.alias_of.as_deref(), Some("new-id"));
        assert_eq!(old_key_rec.owner_kind, "fresh-agent");
        assert_eq!(old_key_rec.state, ReplayOwnerState::Live);

        // A foreign record under the TARGET key refuses — never an
        // overwrite; the caller tears its runtime down.
        let r2 = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation: g2 } = r2.begin_start(
            PROVIDER,
            "old-2",
            RuntimeOwnerKind::FreshAgent,
            "op-rekey-2",
            None,
            "test",
            0,
        ) else {
            panic!()
        };
        let BeginOutcome::Granted {
            generation: foreign,
        } = r2.begin_start(
            PROVIDER,
            "new-2",
            RuntimeOwnerKind::Terminal,
            "op-foreign",
            None,
            "test",
            1,
        )
        else {
            panic!()
        };
        let foreign_owner = OwnerIdentity {
            kind: RuntimeOwnerKind::Terminal,
            terminal_id: Some("t-foreign".into()),
            live_session_key: None,
            pid: None,
            ownership_id: None,
        };
        assert!(matches!(
            r2.commit_live(PROVIDER, "new-2", "op-foreign", foreign, foreign_owner),
            CommitOutcome::Committed
        ));
        assert!(matches!(
            r2.commit_live_rekey(PROVIDER, "old-2", "new-2", "op-rekey-2", g2, owner),
            CommitOutcome::ForeignOperation
        ));
        // The foreign target record is UNTOUCHED.
        match r2.observe(PROVIDER, "new-2").state {
            OwnershipState::Live { owner, .. } => {
                assert_eq!(owner.kind, RuntimeOwnerKind::Terminal);
            }
            other => panic!("the foreign target must keep its owner, got {other:?}"),
        }
    }

    /// b8ke focused episode-2 round-1 F1: the watchdog's UNCONFIRMED
    /// StaleStart fence is NEVER released by the operation's own unwind —
    /// the ticket's typed `fail` proves only that the handler cannot
    /// commit, NOT that the detached sidecar or its descendants died (the
    /// delta-r2 arm cleared it to Vacant, licensing a second writer over
    /// an unconfirmed runtime). The STRICT release discipline is the only
    /// path: a CONFIRMED-death probe invoking `release_fenced` (or the
    /// lane teardowns); the unwind's `fail` is the typed no-op.
    #[test]
    fn a_watchdog_fence_survives_the_operations_unwind_and_releases_only_on_confirmed_death() {
        let r = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "op-watchdog",
            None,
            "test",
            0,
        ) else {
            panic!()
        };
        // The watchdog sweep: Starting → Stopping (nothing registered —
        // the blocked-before-partial-registration shape).
        let recovered = r.recover_stale_starts(0, 0);
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].operation_id, "op-watchdog");
        // The watchdog's UNCONFIRMED arm: Stopping → Fenced typed StaleStart.
        assert!(matches!(
            r.fence_unconfirmed_stop(
                PROVIDER,
                "sid",
                "op-watchdog",
                generation,
                FenceReason::StaleStart
            ),
            FenceOutcome::Fenced
        ));
        // THE OPERATION UNWINDS (the ticket's Drop performs exactly this
        // fail): the unwind is NOT a confirmed runtime death — the fence
        // HOLDS (the pre-e2r1 arm released it to Vacant over the
        // unconfirmed runtime).
        assert!(matches!(
            r.fail(PROVIDER, "sid", "op-watchdog", generation, false),
            FailOutcome::ForeignOperation
        ));
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Fenced {
                reason: FenceReason::StaleStart,
                ..
            }
        ));
        // A foreign fail (a different operation / generation) never
        // releases it either.
        assert!(matches!(
            r.fail(PROVIDER, "sid", "op-foreign", generation, false),
            FailOutcome::ForeignOperation
        ));
        assert!(matches!(
            r.fail(PROVIDER, "sid", "op-watchdog", generation + 1, false),
            FailOutcome::ForeignOperation
        ));
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Fenced { .. }
        ));
        // THE ONLY RELEASE: a confirmed-death probe invoking release_fenced
        // — never a stray fail, never plain Vacant over the unconfirmed
        // runtime.
        assert!(matches!(
            r.release_fenced(PROVIDER, "sid", "op-watchdog", generation),
            CommitOutcome::Committed
        ));
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);
        // The recovered key reopens for a new writer.
        assert!(matches!(
            r.begin_start(
                PROVIDER,
                "sid",
                RuntimeOwnerKind::Terminal,
                "op-after",
                None,
                "test",
                1
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

    /// b8ke focused round-2 review R2-1: a lost detached reap watcher must
    /// leave the TYPED FENCED state — NEVER the round-1 fail-open to
    /// `Vacant`. While fenced, every begin (start/handoff) is Blocked and a
    /// stop is the typed `NotLive` (the caller must not kill); ONLY
    /// [`RuntimeOwnershipRegistry::release_fenced`] — the confirmed-death
    /// caller — reopens the key (after which a create is Granted again). A
    /// foreign operation/generation is the typed no-op, and a wrong
    /// generation on the release is the typed stale refusal.
    #[test]
    fn watcher_lost_fences_the_handoff_until_confirmed_death_releases() {
        let (r, _owner, _) = registry_with_live_terminal();
        let BeginOutcome::Granted { generation: g } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "ho-wf",
            None,
            "test",
            2,
        ) else {
            panic!()
        };
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Handoff { .. }
        ));
        // The watcher was lost: the key is FENCED with the typed reason —
        // never Vacant, never restored.
        assert_eq!(
            r.fence_unconfirmed_handoff(PROVIDER, "sid", "ho-wf", g, FenceReason::WatcherFailed),
            FenceOutcome::Fenced
        );
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Fenced {
                reason: FenceReason::WatcherFailed,
                ..
            }
        ));
        // While fenced: a create is BLOCKED (the round-1 fail-open granted
        // it — the defect this test pins), a handoff is BLOCKED, and a stop
        // is the typed NotLive (no kill).
        assert!(matches!(
            r.begin_start(
                PROVIDER,
                "sid",
                RuntimeOwnerKind::Terminal,
                "fence-probe-create",
                None,
                "test",
                3,
            ),
            BeginOutcome::Blocked { .. }
        ));
        assert!(matches!(
            r.begin_handoff(
                PROVIDER,
                "sid",
                RuntimeOwnerKind::Terminal,
                "fence-probe-handoff",
                None,
                "test",
                4,
            ),
            BeginOutcome::Blocked { .. }
        ));
        assert!(matches!(
            r.begin_stop(
                PROVIDER,
                "sid",
                "fence-probe-stop",
                &StopClaim {
                    expected_kind: RuntimeOwnerKind::Terminal,
                    expected_runtime: None,
                    observed: ObservedFence {
                        epoch: r.boot_epoch(),
                        generation: g
                    },
                },
                "test",
                5,
            ),
            StopOutcome::NotLive { .. }
        ));
        // The fenced key does NOT release through the generic fail (an
        // unarmed ticket drop is the typed no-op) — only release_fenced.
        assert_eq!(
            r.fail(PROVIDER, "sid", "ho-wf", g, false),
            FailOutcome::ForeignOperation
        );
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Fenced { .. }
        ));
        // A stale generation on the release is the typed refusal.
        assert_eq!(
            r.release_fenced(PROVIDER, "sid", "ho-wf", g + 1),
            CommitOutcome::StaleGeneration {
                current_generation: g
            }
        );
        // Confirmed death releases: the key reopens and a create succeeds.
        assert_eq!(
            r.release_fenced(PROVIDER, "sid", "ho-wf", g),
            CommitOutcome::Committed
        );
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);
        assert!(matches!(
            r.begin_start(
                PROVIDER,
                "sid",
                RuntimeOwnerKind::FreshAgent,
                "post-fence-create",
                None,
                "test",
                6,
            ),
            BeginOutcome::Granted { .. }
        ));

        // Foreign operation id: the typed no-op (the record moved on).
        let (r, _owner, _) = registry_with_live_terminal();
        let BeginOutcome::Granted { generation: g } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "ho-wf-2",
            None,
            "test",
            2,
        ) else {
            panic!()
        };
        assert_eq!(
            r.fence_unconfirmed_handoff(
                PROVIDER,
                "sid",
                "ho-foreign",
                g,
                FenceReason::WatcherFailed
            ),
            FenceOutcome::ForeignOperation
        );
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Handoff { .. }
        ));
    }

    /// b8ke focused round-2 review R2-2/R2-3: an explicit stop whose
    /// teardown cannot confirm the prior's death fences `Stopping` with
    /// the typed reason (never `commit_stop`'s Vacant), and — for the
    /// platform-limited reason — the fence is terminal for the epoch
    /// (nothing can confirm on that platform; the documented tradeoff).
    #[test]
    fn unconfirmed_stop_fences_the_key_typed() {
        let (r, owner, generation) = registry_with_live_terminal();
        let StopOutcome::Granted { generation: g } = r.begin_stop(
            PROVIDER,
            "sid",
            "kill-pl",
            &StopClaim {
                expected_kind: RuntimeOwnerKind::Terminal,
                expected_runtime: Some(owner.clone()),
                observed: ObservedFence {
                    epoch: r.boot_epoch(),
                    generation,
                },
            },
            "test",
            7,
        ) else {
            panic!()
        };
        assert_eq!(
            r.fence_unconfirmed_stop(PROVIDER, "sid", "kill-pl", g, FenceReason::PlatformLimited),
            FenceOutcome::Fenced
        );
        // The fenced record carries the PRIOR owner (the unconfirmed
        // runtime, stamped with its committing operation id) — a snapshot
        // consumer still sees the fence, and a create is Blocked until a
        // confirmed death releases it.
        let stamped_prior = stamped(owner, "op-1");
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Fenced {
                ref prior,
                reason: FenceReason::PlatformLimited,
                ..
            } if prior.as_ref().map(|(o, _)| o) == Some(&stamped_prior)
        ));
        assert!(matches!(
            r.begin_start(
                PROVIDER,
                "sid",
                RuntimeOwnerKind::Terminal,
                "pl-probe-create",
                None,
                "test",
                8,
            ),
            BeginOutcome::Blocked { .. }
        ));
        // The stop commit no longer applies (the record moved past
        // Stopping): the fence owns the transition now.
        assert_eq!(
            r.commit_stop(PROVIDER, "sid", "kill-pl", g),
            CommitOutcome::ForeignOperation
        );
        // Confirmed death still releases the fence (the one legal reopen).
        assert_eq!(
            r.release_fenced(PROVIDER, "sid", "kill-pl", g),
            CommitOutcome::Committed
        );
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);
    }

    /// b8ke focused round-3 review R3-4: the typed operator force-clear
    /// for a PlatformLimited fence. An explicit retry carrying a FRESH
    /// observed fence releases the record to Vacant (the limitation
    /// recorded honestly); a WatcherFailed fence is NOT force-releasable
    /// (its bounded probe can still confirm); a stale observation and any
    /// non-fenced state are the typed refusals — the default path stays
    /// fenced.
    #[test]
    fn force_release_platform_limited_is_the_typed_fenced_recovery() {
        // A PlatformLimited fence from a stop.
        let (r, owner, generation) = registry_with_live_terminal();
        let StopOutcome::Granted { generation: g } = r.begin_stop(
            PROVIDER,
            "sid",
            "kill-pl2",
            &StopClaim {
                expected_kind: RuntimeOwnerKind::Terminal,
                expected_runtime: Some(owner.clone()),
                observed: ObservedFence {
                    epoch: r.boot_epoch(),
                    generation,
                },
            },
            "test",
            7,
        ) else {
            panic!()
        };
        assert_eq!(
            r.fence_unconfirmed_stop(PROVIDER, "sid", "kill-pl2", g, FenceReason::PlatformLimited),
            FenceOutcome::Fenced
        );
        // A stale observation (an older generation) is the typed refusal.
        assert_eq!(
            r.force_release_platform_limited(
                PROVIDER,
                "sid",
                ObservedFence {
                    epoch: r.boot_epoch(),
                    generation: g - 1,
                },
                "operator",
            ),
            ForceReleaseOutcome::StaleObservation {
                current_epoch: r.boot_epoch(),
                current_generation: g,
            }
        );
        // A foreign epoch is the typed refusal too.
        assert!(matches!(
            r.force_release_platform_limited(
                PROVIDER,
                "sid",
                ObservedFence {
                    epoch: r.boot_epoch() + 1,
                    generation: g,
                },
                "operator",
            ),
            ForceReleaseOutcome::StaleObservation { .. }
        ));
        // THE R3-4 recovery: the fresh observed fence force-clears — the
        // record reopens Vacant at the SAME generation (the caller's
        // retry proceeds).
        assert_eq!(
            r.force_release_platform_limited(
                PROVIDER,
                "sid",
                ObservedFence {
                    epoch: r.boot_epoch(),
                    generation: g,
                },
                "operator",
            ),
            ForceReleaseOutcome::Released
        );
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);
        assert_eq!(r.observe(PROVIDER, "sid").generation, g);
        assert!(matches!(
            r.begin_start(
                PROVIDER,
                "sid",
                RuntimeOwnerKind::Terminal,
                "post-force-create",
                None,
                "test",
                8,
            ),
            BeginOutcome::Granted { .. }
        ));

        // A WatcherFailed fence is NOT force-releasable: its bounded
        // replacement probe can still confirm death.
        let (r, _owner, _generation) = registry_with_live_terminal();
        let BeginOutcome::Granted { generation: g } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "ho-wf-pl",
            None,
            "test",
            2,
        ) else {
            panic!()
        };
        assert_eq!(
            r.fence_unconfirmed_handoff(PROVIDER, "sid", "ho-wf-pl", g, FenceReason::WatcherFailed),
            FenceOutcome::Fenced
        );
        let refused = r.force_release_platform_limited(
            PROVIDER,
            "sid",
            ObservedFence {
                epoch: r.boot_epoch(),
                generation: g,
            },
            "operator",
        );
        assert!(
            matches!(
                &refused,
                ForceReleaseOutcome::NotPlatformLimited { state }
                    if matches!(state, OwnershipState::Fenced { .. })
            ),
            "a WatcherFailed fence must not force-clear: {refused:?}"
        );
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Fenced { .. }
        ));

        // A non-fenced key is the typed NotPlatformLimited refusal.
        let (r, _owner, _) = registry_with_live_terminal();
        assert!(matches!(
            r.force_release_platform_limited(
                PROVIDER,
                "sid",
                ObservedFence {
                    epoch: r.boot_epoch(),
                    generation: 1,
                },
                "operator",
            ),
            ForceReleaseOutcome::NotPlatformLimited { .. }
        ));
        // And an unknown key likewise.
        assert!(matches!(
            r.force_release_platform_limited(
                PROVIDER,
                "never-existed",
                ObservedFence {
                    epoch: r.boot_epoch(),
                    generation: 0,
                },
                "operator",
            ),
            ForceReleaseOutcome::NotPlatformLimited { .. }
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
            && rec.owner_kind == "terminal"
            && rec.state == ReplayOwnerState::Live
            && rec.reason.is_none()));
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
            && rec.owner_kind == "vacant"
            && rec.state == ReplayOwnerState::Live));

        // b8ke focused round-3 review R3-5: a FENCED record replays its
        // truth — `state: "fenced"` with the typed reason and the fenced
        // PRIOR's kind — never a plain live owner (the pre-fix replay
        // licensed a false committed-owner fold on reconnecting devices
        // after PLATFORM_LIMITED/WATCHER_FAILED).
        let (r, _owner, _) = registry_with_live_terminal();
        let BeginOutcome::Granted { generation: g } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "ho-fence-replay",
            None,
            "test",
            2,
        ) else {
            panic!()
        };
        assert_eq!(
            r.fence_unconfirmed_handoff(
                PROVIDER,
                "sid",
                "ho-fence-replay",
                g,
                FenceReason::PlatformLimited,
            ),
            FenceOutcome::Fenced
        );
        let records = r.snapshot_records();
        let fenced = records
            .iter()
            .find(|rec| rec.session_id == "sid")
            .expect("the fenced key replays");
        assert_eq!(fenced.state, ReplayOwnerState::Fenced);
        assert_eq!(fenced.reason.as_deref(), Some("platform-limited"));
        assert_eq!(fenced.owner_kind, "terminal", "the fenced PRIOR's kind");
        assert_eq!(fenced.generation, g);
    }

    /// b8ke focused round-4 review R4-6: in-progress lifecycle states
    /// replay AS WHAT THEY ARE — a reconnecting device must never fold a
    /// `Starting`/`Handoff`/`Stopping` record as committed live ownership
    /// (the pre-fix replay serialized all three as `Live`, licensing a
    /// false "handoff-committed" fold and resumed polling/actions mid
    /// transition).
    #[test]
    fn snapshot_records_replay_in_progress_lifecycle_states_truthfully() {
        // Starting: a fresh-agent runtime is spawning (no prior).
        let r = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { .. } = r.begin_start(
            PROVIDER,
            "sid-starting",
            RuntimeOwnerKind::FreshAgent,
            "op-starting",
            None,
            "test",
            1,
        ) else {
            panic!("expected Granted")
        };
        // Handoff: a live terminal owner is being taken over to fresh-agent.
        let (r2, _owner, _gen) = registry_with_live_terminal();
        let BeginOutcome::Granted { .. } = r2.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "op-handoff",
            None,
            "test",
            2,
        ) else {
            panic!("expected Granted")
        };
        // Stopping: the live owner of a third key is being stopped.
        let r3 = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation: g3 } = r3.begin_start(
            PROVIDER,
            "sid-stopping",
            RuntimeOwnerKind::Terminal,
            "op-stop-start",
            None,
            "test",
            3,
        ) else {
            panic!("expected Granted")
        };
        let owner3 = OwnerIdentity {
            kind: RuntimeOwnerKind::Terminal,
            terminal_id: Some("t-3".into()),
            live_session_key: None,
            pid: Some(4242),
            ownership_id: None,
        };
        assert_eq!(
            r3.commit_live(
                PROVIDER,
                "sid-stopping",
                "op-stop-start",
                g3,
                owner3.clone()
            ),
            CommitOutcome::Committed
        );
        let StopOutcome::Granted { .. } = r3.begin_stop(
            PROVIDER,
            "sid-stopping",
            "op-stopping",
            &stop_claim(&owner3, r3.boot_epoch(), g3),
            "test",
            4,
        ) else {
            panic!("expected Granted")
        };

        let starting = r
            .snapshot_records()
            .into_iter()
            .find(|rec| rec.session_id == "sid-starting")
            .expect("the Starting key replays");
        assert_eq!(starting.state, ReplayOwnerState::Starting);
        assert_eq!(starting.owner_kind, "fresh-agent");
        assert!(starting.reason.is_none());

        let handoff = r2
            .snapshot_records()
            .into_iter()
            .find(|rec| rec.session_id == "sid")
            .expect("the Handoff key replays");
        assert_eq!(handoff.state, ReplayOwnerState::Handoff);
        // The Handoff record's kind names the TARGET (the handoff-started
        // broadcast's owner kind — cross-device consistency).
        assert_eq!(handoff.owner_kind, "fresh-agent");

        let stopping = r3
            .snapshot_records()
            .into_iter()
            .find(|rec| rec.session_id == "sid-stopping")
            .expect("the Stopping key replays");
        assert_eq!(stopping.state, ReplayOwnerState::Stopping);
        // The Stopping record's kind names the PRIOR being stopped.
        assert_eq!(stopping.owner_kind, "terminal");
    }

    /// Task 4 review F1 (fix): a GRANTED stop abandoned before the kill (the
    /// runtime confirmed still alive) must roll back to `Live` at the
    /// owner's PRE-STOP generation — deliberately a DIFFERENT value than
    /// the failed-handoff restore (whole-branch review M-1): that restore
    /// forward-bumps to the record's current generation (the handoff
    /// broadcasts carried it to every client), while the stop path
    /// broadcasts nothing at the bumped generation, so the pre-stop one is
    /// what observers hold — the one remaining deliberate record≠Live
    /// straddle (`snapshot_generation`'s Live arm exists for it). A fenced
    /// retry carrying the retained/snapshot baseline is Granted again (no
    /// StaleClaim liveness corner), and the aborted stop is consumed (a
    /// late commit is foreign).
    #[test]
    fn abort_stop_restores_the_live_owner_at_its_pre_stop_generation() {
        let (r, owner, live_gen) = registry_with_live_terminal();
        let StopOutcome::Granted {
            generation: stop_gen,
        } = r.begin_stop(
            PROVIDER,
            "sid",
            "kill-1",
            &stop_claim(&owner, r.boot_epoch(), live_gen),
            "test",
            2_000,
        )
        else {
            panic!("expected Granted")
        };
        assert!(
            stop_gen > live_gen,
            "begin_stop bumps the record generation entering Stopping"
        );
        // Mid-stop: the wedge shape — a competing start is Blocked.
        assert!(matches!(
            r.begin_start(
                PROVIDER,
                "sid",
                RuntimeOwnerKind::FreshAgent,
                "op-x",
                None,
                "test",
                3_000
            ),
            BeginOutcome::Blocked { .. }
        ));
        assert_eq!(
            r.abort_stop(PROVIDER, "sid", "kill-1", stop_gen),
            AbortStopOutcome::Aborted
        );
        match r.observe(PROVIDER, "sid").state {
            OwnershipState::Live {
                owner: restored,
                generation,
                ..
            } => {
                assert_eq!(restored, stamped(owner.clone(), "op-1"));
                assert_eq!(
                    generation, live_gen,
                    "the restored Live keeps the owner's PRE-stop generation"
                );
            }
            other => panic!("abort must restore Live, got {other:?}"),
        }
        // RR-1 (re-review): the straddle is deliberate and typed — after
        // the abort restore, observe()/snapshot_records() must report the
        // Live STATE's (pre-stop) generation while the record keeps the
        // current (bumped) one. This is the only remaining record≠Live
        // divergence and the sole reason `snapshot_generation`'s Live arm
        // exists; a regression returning the record's generation
        // unconditionally would re-expose the snapshot-fenced StaleClaim
        // wedge in this corner (stop abandoned, runtime alive).
        let snap = r.observe(PROVIDER, "sid");
        assert_eq!(
            snap.generation, live_gen,
            "observe() must report the Live state's pre-stop generation, not the record's bumped one"
        );
        let replay = r
            .snapshot_records()
            .into_iter()
            .find(|rec| rec.provider == PROVIDER && rec.session_id == "sid")
            .expect("the aborted key must replay");
        assert_eq!(
            replay.generation, live_gen,
            "snapshot_records() must fence at the pre-stop generation"
        );
        // The record's own generation is still the bumped stop generation
        // (the per-key monotonic counter never rolls back) — the straddle
        // is real, and only a fence reporting the RECORD's value sees it.
        assert_eq!(
            r.commit_stop(PROVIDER, "sid", "kill-1", stop_gen + 1),
            CommitOutcome::StaleGeneration {
                current_generation: stop_gen
            },
            "the record keeps the bumped stop generation while the Live state holds the pre-stop one"
        );
        // The aborted stop is consumed: a late commit for it is foreign.
        assert_eq!(
            r.commit_stop(PROVIDER, "sid", "kill-1", stop_gen),
            CommitOutcome::ForeignOperation
        );
        // Fence coherence: a retry carrying the PRE-stop observed pair (the
        // retained stamp's baseline — equivalently, the snapshot-derived
        // `observe()` generation asserted above) is Granted — never a
        // StaleClaim loop — and that retry still commits normally.
        let StopOutcome::Granted {
            generation: retry_gen,
        } = r.begin_stop(
            PROVIDER,
            "sid",
            "kill-2",
            &stop_claim(&owner, r.boot_epoch(), snap.generation),
            "test",
            4_000,
        )
        else {
            panic!("expected Granted on the post-abort retry")
        };
        assert!(matches!(
            r.commit_stop(PROVIDER, "sid", "kill-2", retry_gen),
            CommitOutcome::Committed
        ));
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);
    }

    /// Task 4 review F1 (fix): `abort_stop` is fenced exactly like
    /// `commit_stop` — a foreign operation id or a stale generation is a
    /// typed no-op that changes nothing — and a watchdog-synthesized
    /// `Stopping` (zombie `Starting`, no prior Live era) is NEVER
    /// restorable: the host's abort/settle/commit owns that transition.
    #[test]
    fn abort_stop_is_fenced_and_never_restores_a_zombie_watchdog_stop() {
        let (r, owner, live_gen) = registry_with_live_terminal();
        let StopOutcome::Granted {
            generation: stop_gen,
        } = r.begin_stop(
            PROVIDER,
            "sid",
            "kill-1",
            &stop_claim(&owner, r.boot_epoch(), live_gen),
            "test",
            2_000,
        )
        else {
            panic!("expected Granted")
        };
        assert_eq!(
            r.abort_stop(PROVIDER, "sid", "kill-other", stop_gen),
            AbortStopOutcome::ForeignOperation
        );
        assert_eq!(
            r.abort_stop(PROVIDER, "sid", "kill-1", stop_gen + 7),
            AbortStopOutcome::StaleGeneration {
                current_generation: stop_gen
            }
        );
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Stopping { .. }
        ));
        // The no-ops changed nothing: the original stop still aborts.
        assert_eq!(
            r.abort_stop(PROVIDER, "sid", "kill-1", stop_gen),
            AbortStopOutcome::Aborted
        );
        // An unknown key is foreign.
        assert_eq!(
            r.abort_stop(PROVIDER, "sid-unknown", "kill-1", stop_gen),
            AbortStopOutcome::ForeignOperation
        );

        // The watchdog's zombie-Starting synthesis: abort is foreign, the
        // host's commit still works, and post-commit abort stays foreign.
        let r2 = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation } = r2.begin_start(
            PROVIDER,
            "sid-2",
            RuntimeOwnerKind::Terminal,
            "op-z",
            None,
            "test",
            1_000,
        ) else {
            panic!("expected Granted")
        };
        let recovered = r2.recover_stale_starts(10_000, 0);
        assert_eq!(recovered.len(), 1, "the zombie start is swept");
        assert_eq!(
            r2.abort_stop(PROVIDER, "sid-2", "op-z", generation),
            AbortStopOutcome::ForeignOperation,
            "a watchdog-synthesized stop has no prior Live era to restore"
        );
        assert!(matches!(
            r2.observe(PROVIDER, "sid-2").state,
            OwnershipState::Stopping { .. }
        ));
        assert!(matches!(
            r2.commit_stop(PROVIDER, "sid-2", "op-z", generation),
            CommitOutcome::Committed
        ));
        assert_eq!(
            r2.abort_stop(PROVIDER, "sid-2", "op-z", generation),
            AbortStopOutcome::ForeignOperation
        );
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
            None,
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
    fn handoff_restore_carries_the_record_generation_so_client_fences_converge() {
        // Whole-branch review M-1: the handoff broadcasts carry the HANDOFF
        // generation to every client, and the client fold is same-epoch
        // monotonic — it never regresses. A prior restored by a failed
        // handoff must therefore hold the RECORD's current (handoff)
        // generation: otherwise a wire-fenced kill from a client holding
        // the folded broadcast pair (epoch, N+1) fails begin_stop's
        // exact-generation match in a typed StaleClaim loop ("refresh and
        // retry" re-sends the same stale pair) until a reconnect replays
        // the truth.
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
        assert_eq!(ho_gen, live_gen + 1);
        assert_eq!(
            r.fail(PROVIDER, "sid", "ho-1", ho_gen, /* prior_confirmed_live: */ true),
            FailOutcome::RestoredPriorOwner
        );
        // Coherence: the record's generation and the restored Live state's
        // are ONE value (no straddle) — observe() reports it.
        let snap = r.observe(PROVIDER, "sid");
        assert!(matches!(snap.state, OwnershipState::Live { .. }));
        assert_eq!(
            snap.generation, ho_gen,
            "the restored Live key holds the record's (handoff) generation"
        );
        // The exact M-1 wedge: a kill fenced at the HANDOFF generation —
        // the pair every client folded from the broadcasts — must be
        // Granted (pre-fix: a permanent StaleClaim loop, fail-closed).
        let stop = r.begin_stop(
            PROVIDER,
            "sid",
            "kill-1",
            &stop_claim(&owner, snap.epoch, ho_gen),
            "test",
            3,
        );
        assert!(
            matches!(stop, StopOutcome::Granted { .. }),
            "a handoff-generation fence must satisfy begin_stop on a restored key (got {stop:?})"
        );
        let StopOutcome::Granted { generation } = stop else {
            unreachable!("asserted Granted above")
        };
        assert_eq!(
            r.commit_stop(PROVIDER, "sid", "kill-1", generation),
            CommitOutcome::Committed
        );
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);
        // Task 1's invariant: the per-key monotonic counter never resets —
        // the next transition bumps beyond the stop's generation.
        let BeginOutcome::Granted { generation: next } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::Terminal,
            "ho-2",
            None,
            "test",
            4,
        ) else {
            panic!()
        };
        assert!(
            next > generation,
            "the per-key counter stays monotonic across the restore (next {next}, stop {generation})"
        );
    }

    #[test]
    fn snapshot_fence_satisfies_begin_stop_after_a_failed_handoff_restore() {
        // M3 (review) + whole-branch M-1: a failed handoff restores the
        // prior owner at the RECORD's current generation (the handoff's
        // bump — the handoff broadcasts carried it to every client, whose
        // monotonic folds hold it and cannot regress). The snapshot must
        // report that same coherent value — otherwise a snapshot-fenced
        // stopper loops on StaleClaim forever (fail-closed liveness
        // corner; no safety violation, no kill licensed).
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
        // with begin_stop's comparison target: the restored key's ONE
        // generation (the record's current — the handoff's bump).
        let snap = r.observe(PROVIDER, "sid");
        assert!(matches!(snap.state, OwnershipState::Live { .. }));
        assert_eq!(
            snap.generation, ho_gen,
            "the snapshot generation for a restored-Live key is the record's (handoff) generation"
        );
        let rec = r
            .snapshot_records()
            .into_iter()
            .find(|rec| rec.provider == PROVIDER && rec.session_id == "sid")
            .expect("the restored key must replay");
        assert_eq!(
            rec.generation, ho_gen,
            "the replay record's generation for a restored-Live key is the record's (handoff) generation"
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
    fn snapshot_fence_satisfies_begin_start_and_handoff_after_a_failed_handoff_restore() {
        // M3-R (re-review of M3's remedy): begin_start/begin_handoff
        // compared fences against the RECORD's generation, which a failed
        // handoff leaves bumped above the restored Live state's own — so
        // a snapshot-fenced start/handoff was permanently StaleGeneration
        // on restored keys (refreshing from the snapshot loops). All fence
        // comparisons must use the same coherent baseline. Post whole-
        // branch M-1 the restored key's Live state IS the record's current
        // generation, so the baselines coincide by construction — the
        // test still pins the coherence.
        let (r, _owner, live_gen) = registry_with_live_terminal(); // Live, generation 1
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
        assert_eq!(ho_gen, live_gen + 1);
        assert_eq!(
            r.fail(PROVIDER, "sid", "ho-1", ho_gen, /* prior_confirmed_live: */ true),
            FailOutcome::RestoredPriorOwner
        );
        // The fence a snapshot consumer derives: snapshot_records reports
        // the restored key's ONE coherent generation.
        let rec = r
            .snapshot_records()
            .into_iter()
            .find(|rec| rec.provider == PROVIDER && rec.session_id == "sid")
            .expect("the restored key must replay");
        assert_eq!(
            rec.generation, ho_gen,
            "the replay record's generation for a restored-Live key is the record's (handoff) generation"
        );
        // begin_start: the state machine allows AdoptLive for the same
        // kind — the snapshot fence must not be StaleGeneration.
        let start = r.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::Terminal,
            "op-2",
            Some(ObservedFence {
                epoch: rec.epoch,
                generation: rec.generation,
            }),
            "test",
            3,
        );
        assert!(
            matches!(start, BeginOutcome::AdoptLive { .. }),
            "a snapshot-derived fence must satisfy begin_start on a restored key (got {start:?})"
        );
        // begin_handoff: granted from Live of any kind.
        let handoff = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "ho-2",
            Some(ObservedFence {
                epoch: rec.epoch,
                generation: rec.generation,
            }),
            "test",
            4,
        );
        assert!(
            matches!(handoff, BeginOutcome::Granted { .. }),
            "a snapshot-derived fence must satisfy begin_handoff on a restored key (got {handoff:?})"
        );
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
