//! Canonical coding-agent session-name wire types (unified-agent-names plan,
//! Task 1), mirroring `shared/session-names.ts` exactly.
//!
//! * Wire enum strings are identical across TS/Rust.
//! * Rust fields are snake_case with camelCase Serde serialization.
//! * `NameRevision` is `u64` with a JS-safe integer ceiling
//!   ([`MAX_NAME_REVISION`]) — every revision/generation counter that crosses
//!   the wire to a JS client stays inside `Number.MAX_SAFE_INTEGER`.
//! * Serialization only, no logic: acceptance/rank rules live in the
//!   `freshell-server` store, not here.

use serde::{Deserialize, Serialize};

/// Monotonically allocated name revision — JS-safe on the wire.
pub type NameRevision = u64;

/// `Number.MAX_SAFE_INTEGER` (`2^53 - 1`): the hard ceiling for every
/// revision / document-generation counter serialized to a JS client.
pub const MAX_NAME_REVISION: NameRevision = 9_007_199_254_740_991;

/// The three scoped coding-agent providers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NamedProvider {
    Claude,
    Codex,
    Opencode,
}

impl NamedProvider {
    /// The exact wire string (`claude | codex | opencode`).
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Opencode => "opencode",
        }
    }

    /// Human-facing fallback label used when no directory basename exists.
    pub fn display_label(&self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::Codex => "Codex",
            Self::Opencode => "OpenCode",
        }
    }
}

/// Who asked for a name change: a human (`user`) or automation
/// (`automatic`). Default omitted intents to `automatic` on every scoped
/// create/rename route — an agent suggestion must never acquire the
/// permanence of a user's explicit rename.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NameIntent {
    User,
    Automatic,
}

/// Provenance of an accepted name. Rank order for new operations is
/// `manual > legacy_protected > freshell_ai > provider_ai > first_message >
/// directory`; `legacy_protected` is assigned ONLY by the Task 7 migration
/// and never claims human origin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NameSource {
    Manual,
    LegacyProtected,
    FreshellAi,
    ProviderAi,
    FirstMessage,
    Directory,
}

/// The single legal `legacyOrigin` value: the historic origin of a
/// migration-protected label is unknown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LegacyOrigin {
    Unknown,
}

/// Naming target: a pre-durable pending handle (`pending`), or the durable
/// provider/session identity (`session`). The session variant reuses the
/// existing structured provider/session identity — no new restore identity.
/// Keys encode as a JSON discriminated tuple (see the store's `name_ref_key`)
/// and never colon-split opaque provider session IDs.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SessionNameRef {
    #[serde(rename_all = "camelCase")]
    Pending { id: String },
    #[serde(rename_all = "camelCase")]
    Session {
        provider: NamedProvider,
        session_id: String,
    },
}

/// Which session names a tab: the source pane's canonical session name
/// (`session`), or the existing non-agent derivation (`legacy`). A tab stores
/// the relationship, never a second name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TabNameSource {
    #[serde(rename_all = "camelCase")]
    Session {
        pane_id: String,
    },
    Legacy,
}

/// One accepted name record. `manual_revision`/`renamed_at` are assigned only
/// by an actual explicit user rename; `legacy_origin` is required for (and
/// only legal on) `legacy_protected` records.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionNameRecord {
    #[serde(rename = "ref")]
    pub name_ref: SessionNameRef,
    pub name: String,
    pub source: NameSource,
    pub revision: NameRevision,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manual_revision: Option<NameRevision>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub renamed_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy_origin: Option<LegacyOrigin>,
}

/// Pending→durable redirect: late operations addressing a bound pending
/// handle resolve to the durable session record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionNameRedirect {
    pub from: SessionNameRef,
    pub to: SessionNameRef,
    pub revision: NameRevision,
}

/// Native synchronization status for a canonical name's provider writeback
/// (unified-agent-names plan, Task 3): `pending` (a bounded native series is
/// armed/underway), `synced` (a current-revision readback confirmed the
/// provider holds the exact desired name/location), `unsynced` (the finite
/// allowance is exhausted or an outcome is ambiguous/divergent), and
/// `unsupported` (a diagnosed capability failure — unsupported/archived/
/// ephemeral/missing). Display/status data only: never another name
/// authority, and never a public native path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NativeSyncStatus {
    Pending,
    Synced,
    Unsynced,
    Unsupported,
}

/// The native writeback status projected alongside a record in
/// `SessionNameUpdate`/`SessionNameUpdated`. `desired_revision` is the
/// canonical record revision the native series is projecting; the provider is
/// `synced` only with that exact revision. `location_revision` is the routing
/// evidence revision the series attempted (0 when no verified location
/// exists). `observed_current` records that a readback observed the desired
/// name while an ambiguous outcome kept the status `unsynced`. `reason` is a
/// stable machine-facing diagnostic (never a prompt or native payload).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSyncProjection {
    pub status: NativeSyncStatus,
    pub desired_revision: NameRevision,
    pub location_revision: NameRevision,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_current: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// The common response/broadcast shape for every naming operation. `changed`
/// is true only when the accepted record (text/source/revision) changed vs
/// the store's previously established state — losing automatic offers and
/// pure reads answer `changed: false` with the actual accepted winner.
/// `native_sync` (Task 3) is the additive writeback status projection;
/// status-only updates (an unchanged record whose nativeSync moved) publish
/// with `changed: false` and fold on the client by `documentGeneration`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionNameUpdate {
    pub record: SessionNameRecord,
    pub document_generation: NameRevision,
    pub redirects: Vec<SessionNameRedirect>,
    pub changed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_sync: Option<NativeSyncProjection>,
}

/// Rename request body (HTTP `PATCH /api/session-names` and the MCP-bridged
/// rename). Omitted `name_intent` defaults to `automatic`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameSessionNameRequest {
    pub target: SessionNameRef,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_intent: Option<NameIntent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub if_revision: Option<NameRevision>,
}

/// `session.name.updated` server→client broadcast payload. Published only
/// after a successful store commit/adoption, in local generation order; the
/// client folds by record and redirect revision, never arrival time.
/// `native_sync` mirrors the Task 3 status projection on the wire.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionNameUpdated {
    pub record: SessionNameRecord,
    pub document_generation: NameRevision,
    pub redirects: Vec<SessionNameRedirect>,
    pub changed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_sync: Option<NativeSyncProjection>,
}
