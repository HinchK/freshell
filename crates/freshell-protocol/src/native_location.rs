//! Server-internal native provider acquisition/routing evidence
//! (unified-agent-names plan, Task 1).
//!
//! These types are NOT public naming identity: they never appear in a
//! client-facing wire schema, and they never create restore identity (the
//! public `SessionRef` stays the only restore contract). They carry only
//! routing/recovery inputs — never credentials or arbitrary environment
//! dumps — and persist inside the server's `session-names.json` document so
//! native metadata reads/writes can target the verified provider location
//! across restarts.
//!
//! The store assigns a `location_revision` whenever verified routing
//! evidence changes; it is independent of the visible name revision and never
//! a public identity namespace.

use serde::{Deserialize, Serialize};

/// Provider-specific verified/prospective routing location.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "provider", rename_all = "camelCase")]
pub enum NativeLocation {
    /// Claude: the selected absolute config root plus transcript routing
    /// evidence (transcript path, project directory key, original transcript
    /// cwd, optional effective project-key override).
    #[serde(rename_all = "camelCase")]
    Claude {
        config_root: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        transcript_path: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        project_directory_key: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        transcript_cwd: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        effective_project_key_override: Option<String>,
    },
    /// Codex: the initialized app-server `codexHome`, native thread ID,
    /// optional selected rollout path and persistence evidence.
    #[serde(rename_all = "camelCase")]
    Codex {
        codex_home: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        native_thread_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        rollout_path: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        persistence_evidence: Option<String>,
    },
    /// OpenCode: effective database path, native session ID, original
    /// directory and optional owned local endpoint.
    #[serde(rename_all = "camelCase")]
    Opencode {
        database_path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        native_session_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        original_directory: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        owned_local_endpoint: Option<String>,
    },
}

/// What kind of evidence produced the acquisition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeEvidenceKind {
    IndexedFile,
    SelectedTranscript,
    InitializedRuntime,
    PersistedMetadata,
}

/// Whether the acquisition is verified durable routing or merely prospective.
/// Only `Verified` evidence can authorize a pending→durable name binding; a
/// successful start or a bare name-set acknowledgement is always
/// `Prospective` until existing provider durability checks establish
/// persistence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativePersistence {
    Prospective,
    Verified,
}

/// One acquired native routing fact about a naming target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAcquisition {
    pub location: NativeLocation,
    pub evidence: NativeEvidenceKind,
    pub persistence: NativePersistence,
}
