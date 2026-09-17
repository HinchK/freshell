//! Injected session-naming interface (unified-agent-names plan, Task 1).
//!
//! The name authority lives in `freshell-server`'s `SessionNames` store; this
//! crate (and `freshell-ws`, which already depends on it) consume the store
//! through this trait so fresh-agent/WS code never depends on the server
//! crate. Reuses the project's boxed-future style (the `SinkWrite` idiom in
//! `identity_sink.rs`, itself citing `freshell-opencode`/`freshell-codex`) —
//! no `async-trait` dependency.
//!
//! Acceptance/rank/persistence policy is owned by the implementing store; a
//! rename answer ALWAYS reports the actual accepted winner (including an
//! unchanged winner when an automatic suggestion loses).

use std::future::Future;
use std::pin::Pin;

use freshell_protocol::native_location::NativeAcquisition;
use freshell_protocol::session_names::{
    NameIntent, NameRevision, NamedProvider, SessionNameRecord, SessionNameRef, SessionNameUpdate,
};

/// Every naming operation's completion future.
pub type NameFuture<T> = Pin<Box<dyn Future<Output = Result<T, NameError>> + Send + 'static>>;

/// The naming authority surface consumed by WS/fresh-agent composition
/// (Task 2 wires the real store into `FreshAgentState`/`WsState`).
pub trait SessionNaming: Send + Sync {
    /// Resolve refs (following pending→durable redirects) to their current
    /// records. Unknown refs are omitted; this is a pure read.
    fn get(&self, refs: Vec<SessionNameRef>) -> NameFuture<Vec<SessionNameUpdate>>;

    /// Admit a pre-durable naming handle with an immediate fallback name
    /// (directory basename, else provider label) at directory rank.
    /// Idempotent: re-ensuring a bound handle resolves its durable record.
    fn ensure_pending(&self, input: PendingNameInput) -> NameFuture<SessionNameUpdate>;

    /// Atomically transfer a pending record onto its verified durable
    /// provider/session identity (rejecting prospective evidence).
    fn bind_pending(&self, input: BindNameInput) -> NameFuture<SessionNameUpdate>;

    /// Rename with intent. `user` is the explicit human boundary (manual
    /// source); `automatic` is an agent suggestion (provider_ai rank that can
    /// never freeze a name). Optional `if_revision` is compare-and-set.
    fn rename(&self, input: RenameNameInput) -> NameFuture<SessionNameUpdate>;

    /// Fold server-side coding-agent session activity: first-message
    /// fallback upgrade plus generation-eligibility arming.
    fn activity(&self, input: NameActivity) -> NameFuture<SessionNameUpdate>;

    /// Fold a native provider title observation with its provenance.
    fn observe_native(&self, input: NativeNameObservation) -> NameFuture<SessionNameUpdate>;

    /// Retain native routing evidence (verified or prospective) for a target
    /// WITHOUT binding a pending handle to durable identity.
    fn record_acquisition(
        &self,
        target: SessionNameRef,
        acquisition: NativeAcquisition,
    ) -> NameFuture<SessionNameUpdate>;
}

/// `ensure_pending` input: the pre-durable handle plus provider/cwd used for
/// the immediate directory-basename fallback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingNameInput {
    pub handle: String,
    pub provider: NamedProvider,
    pub cwd: Option<String>,
}

/// `bind_pending` input. `acquisition` must carry `Verified` persistence —
/// prospective evidence (a bare thread/start ack) is rejected as ambiguous.
#[derive(Debug, Clone, PartialEq)]
pub struct BindNameInput {
    pub pending: SessionNameRef,
    pub target: SessionNameRef,
    pub acquisition: NativeAcquisition,
}

/// `rename` input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenameNameInput {
    pub target: SessionNameRef,
    pub name: String,
    pub intent: NameIntent,
    pub if_revision: Option<NameRevision>,
}

/// Why activity arrived. `AcceptedUserMessage`/`IndexUserMessage` may carry a
/// first user message (fallback upgrade input); `Opened`/`Resumed` arm an
/// unattempted generation series only when a first message exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NameActivityReason {
    AcceptedUserMessage,
    IndexUserMessage,
    Opened,
    Resumed,
}

/// One activity event. `event_id` is the existing provider/event message id
/// (duplicate delivery folds through the series' input fingerprint, never a
/// new event store).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NameActivity {
    pub target: SessionNameRef,
    pub mode: String,
    pub event_id: String,
    pub reason: NameActivityReason,
    pub first_user_message: Option<String>,
    pub cwd: Option<String>,
}

/// Provenance of a native title observation. `OwnWrite` is an echo of
/// Freshell's own supported write (provenance only — never promoted); the
/// provider-native surface carries no reliable human/AI intent, so
/// `Snapshot`/`ProviderAi` fold as automatic candidates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeNameOrigin {
    Snapshot,
    ProviderAi,
    OwnWrite,
}

/// One native title observation, carrying the store-assigned location
/// revision it was observed at (an old-location observation can never mark
/// the current location synchronized).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeNameObservation {
    pub target: SessionNameRef,
    pub title: String,
    pub origin: NativeNameOrigin,
    pub location_revision: NameRevision,
    pub event_id: Option<String>,
}

/// The naming failure classes with their HTTP mappings (plan "Name acceptance,
/// storage, and publication" §6): 400 / 404 / 409 / 409 / 503 / 503 / 503.
/// `Conflict` carries the current accepted record so editors can surface the
/// concurrent winner instead of an invisible overwrite.
#[derive(Debug)]
pub enum NameError {
    /// Blank/oversize name, or a malformed naming target (HTTP 400).
    InvalidName(String),
    /// Unknown rename/read target (HTTP 404).
    NotFound(String),
    /// Ambiguous acquisition/binding — e.g. prospective bind evidence
    /// (HTTP 409).
    IdentityAmbiguous(String),
    /// Compare-and-set revision mismatch (HTTP 409); carries the accepted
    /// record at the time of the check.
    Conflict {
        message: String,
        current: Option<SessionNameRecord>,
    },
    /// Durable document read/write/parse failure with old state intact
    /// (HTTP 503).
    Persistence(String),
    /// A replacement may or may not have committed; nothing is published
    /// until durability reconciliation succeeds (HTTP 503).
    CommitUncertain(String),
    /// The cross-process document lock stayed busy past its bounded retry
    /// budget, or failed in a non-contention way (HTTP 503).
    LockUnavailable(String),
}

impl NameError {
    /// The HTTP status the naming routes map this class to.
    pub fn http_status(&self) -> u16 {
        match self {
            Self::InvalidName(_) => 400,
            Self::NotFound(_) => 404,
            Self::IdentityAmbiguous(_) | Self::Conflict { .. } => 409,
            Self::Persistence(_) | Self::CommitUncertain(_) | Self::LockUnavailable(_) => 503,
        }
    }

    /// Stable machine-readable code for route payloads/logs.
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidName(_) => "NAME_INVALID",
            Self::NotFound(_) => "NAME_NOT_FOUND",
            Self::IdentityAmbiguous(_) => "NAME_IDENTITY_AMBIGUOUS",
            Self::Conflict { .. } => "NAME_REVISION_CONFLICT",
            Self::Persistence(_) => "NAME_PERSISTENCE_FAILED",
            Self::CommitUncertain(_) => "NAME_COMMIT_UNCERTAIN",
            Self::LockUnavailable(_) => "NAME_LOCK_UNAVAILABLE",
        }
    }
}

impl std::fmt::Display for NameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidName(m) => write!(f, "invalid name: {m}"),
            Self::NotFound(m) => write!(f, "naming target not found: {m}"),
            Self::IdentityAmbiguous(m) => write!(f, "naming identity ambiguous: {m}"),
            Self::Conflict { message, .. } => write!(f, "naming revision conflict: {message}"),
            Self::Persistence(m) => write!(f, "naming persistence failure: {m}"),
            Self::CommitUncertain(m) => write!(f, "naming commit uncertain: {m}"),
            Self::LockUnavailable(m) => write!(f, "naming lock unavailable: {m}"),
        }
    }
}

impl std::error::Error for NameError {}
