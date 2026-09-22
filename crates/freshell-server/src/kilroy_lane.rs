//! The shared KILROY-ONLY discrimination seam (delta-review round 4,
//! finding 1).
//!
//! Kilroy panes share the Claude runtime, so their transcripts list under
//! provider `claude` — the provider string alone can never say a session is
//! kilroy. The discriminator is the SESSION-06 metadata store's per-session
//! `sessionType` tag (the same marker the auto-title sweep already consults),
//! composed into ONE predicate every server surface answers through:
//!
//! a session is **kilroy-only** iff
//!
//! 1. the metadata store types it `kilroy` (the per-row/per-mode marker), AND
//! 2. the naming authority holds NO canonical record for it, AND
//! 3. no live terminal is currently running it in one of the six scoped
//!    modes.
//!
//! Component (2) is the plan's Global-Constraint singular-name rule: a
//! durable session opened BOTH as kilroy and through a supported mode keeps
//! ONE canonical saved name — the supported-mode record owns it, and no
//! competing kilroy record may ever be created. A kilroy-typed session that
//! already has a canonical record (a landed migration chunk, the sweep's
//! hydration, a create-lane bind) therefore answers NOT kilroy-only, and
//! every surface keeps treating it through the naming authority.
//!
//! Component (3) is the sweep's original singular-record proxy: a live
//! terminal in a scoped mode (a resumed claude/codex/opencode CLI pane, a
//! fresh scoped pane) proves the same durable session is also open through a
//! supported mode even before any record bound. It needs the TERMINAL
//! registry's mode (the identity ledger carries no mode), so callers without
//! one pass `None` and the check is skipped — documented per call site:
//!
//! * the auto-title sweep passes the live registry (its own precedent);
//! * the session rename/generate-title routes pass the live registry;
//! * the session directory passes `None` — its lane decision is dominated by
//!   component (2) anyway (a record-holding row closes its lane; a
//!   pending-only dual-mode row converges the moment the record binds);
//! * the boot-time legacy-name consolidation passes `None` — it runs before
//!   any terminal restore, so the identity ledger is empty and the live
//!   check could never fire; the record check (2) is the operative
//!   dual-mode evidence there.
//!
//! Failure policy: a naming `get` failure is NOT "no record" — the affected
//! kilroy-typed rows stay in the legacy lane for that round (the only rows
//! the check even consults), so a transient authority failure can never mint
//! the forbidden canonical record for a kilroy-only session; the next round
//! re-judges. An absent authority (`naming == None`, the degraded no-home
//! boot) is the same direction: no record evidence, legacy lane.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use freshell_freshagent::naming::SessionNaming;
use freshell_protocol::SessionNameRef;
use freshell_ws::identity::TerminalIdentityRegistry;
use serde_json::Value;

/// The SESSION-06 metadata `sessionType` of a kilroy pane.
pub(crate) const KILROY_SESSION_TYPE: &str = "kilroy";

/// One candidate row the seam judges.
pub(crate) struct KilroyLaneCandidate {
    pub provider: String,
    pub session_id: String,
    /// The session's known cwd, when the caller has one — it scopes the
    /// live-terminal match exactly like the sweep's own pass (`None` skips
    /// the cwd filter).
    pub cwd: Option<String>,
}

/// The composite metadata key `provider:sessionId` — the same shape the
/// metadata store's `get_all()` flattens to and the settings override rows
/// are keyed by.
pub(crate) fn kilroy_lane_key(provider: &str, session_id: &str) -> String {
    format!("{provider}:{session_id}")
}

/// Component (1): the metadata store's per-row/per-mode marker — the ONLY
/// evidence a session is kilroy (never the provider string).
pub(crate) fn is_kilroy_typed(entries: &HashMap<String, Value>, key: &str) -> bool {
    entries
        .get(key)
        .and_then(|entry| entry.get("sessionType"))
        .and_then(Value::as_str)
        == Some(KILROY_SESSION_TYPE)
}

/// Component (3): is any live terminal currently running this session in one
/// of the six scoped modes? Needs the terminal registry's mode (the sweep's
/// own singular-record proxy); `None` skips the check (see the module doc).
fn has_live_scoped_terminal(
    identity: &TerminalIdentityRegistry,
    registry: Option<&freshell_terminal::TerminalRegistry>,
    candidate: &KilroyLaneCandidate,
) -> bool {
    let Some(registry) = registry else {
        return false;
    };
    identity
        .find_all_by_session(
            &candidate.provider,
            &candidate.session_id,
            candidate.cwd.as_deref(),
        )
        .iter()
        .any(|matched| {
            registry
                .mode_of(&matched.terminal_id)
                .as_deref()
                .is_some_and(|mode| {
                    freshell_freshagent::naming::is_unified_agent_mode(Some(mode), None)
                })
        })
}

/// The ONE predicate: which of `candidates` are KILROY-ONLY sessions
/// (`provider:sessionId` keys)? See the module doc for the three components
/// and the failure policy. `metadata_entries` is the metadata store's
/// `get_all()` snapshot (the caller reads it once per pass/request/boot).
pub(crate) async fn kilroy_only_keys(
    metadata_entries: &HashMap<String, Value>,
    naming: Option<&Arc<dyn SessionNaming>>,
    identity: &TerminalIdentityRegistry,
    registry: Option<&freshell_terminal::TerminalRegistry>,
    candidates: &[KilroyLaneCandidate],
) -> HashSet<String> {
    // Component (1): only kilroy-typed rows of a scoped provider can ever be
    // kilroy-only — an untagged or excluded-provider row stays on whatever
    // path its provider string already selects.
    let mut typed: Vec<&KilroyLaneCandidate> = Vec::new();
    let mut typed_keys: HashSet<String> = HashSet::new();
    for candidate in candidates {
        if freshell_freshagent::naming::named_provider_for(Some(&candidate.provider), None)
            .is_none()
        {
            continue;
        }
        let key = kilroy_lane_key(&candidate.provider, &candidate.session_id);
        if !is_kilroy_typed(metadata_entries, &key) {
            continue;
        }
        if !typed_keys.insert(key) {
            continue; // dedup: one judgment per session per round
        }
        typed.push(candidate);
    }
    if typed.is_empty() {
        return HashSet::new();
    }

    // Component (2): the singular-record guard, ONE batched read for the
    // round. A get failure keeps every typed row in the legacy lane (see the
    // module doc's failure policy) — the live-terminal check below still
    // protects dual-mode rows because it never consults the store.
    let mut record_holders: HashSet<String> = HashSet::new();
    if let Some(sink) = naming {
        let refs: Vec<SessionNameRef> = typed
            .iter()
            .map(|candidate| SessionNameRef::Session {
                provider: freshell_freshagent::naming::named_provider_for(
                    Some(&candidate.provider),
                    None,
                )
                .expect("scoped above"),
                session_id: candidate.session_id.clone(),
            })
            .collect();
        match sink.get(refs).await {
            Ok(updates) => {
                for update in updates {
                    if let SessionNameRef::Session {
                        provider,
                        session_id,
                    } = update.record.name_ref
                    {
                        record_holders.insert(kilroy_lane_key(provider.as_str(), &session_id));
                    }
                }
            }
            Err(error) => {
                tracing::warn!(
                    target: "freshell_server::session_names",
                    op = "kilroy_lane_get",
                    name_ref = "-",
                    revision = 0,
                    class = %error.code(),
                    "session_names.operation_failed: the kilroy-lane record check \
                     failed; the affected kilroy-typed rows keep the legacy lane \
                     this round: {error}"
                );
            }
        }
    }

    let mut lanes = HashSet::new();
    for candidate in typed {
        let key = kilroy_lane_key(&candidate.provider, &candidate.session_id);
        if record_holders.contains(&key) {
            continue;
        }
        if has_live_scoped_terminal(identity, registry, candidate) {
            continue;
        }
        lanes.insert(key);
    }
    lanes
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The marker reads only the metadata `sessionType` (provider-agnostic
    /// by design — the scoping to the unified providers is the batch
    /// predicate's first component), and the batch predicate composes it:
    /// a kilroy-tagged scoped-provider row with no authority and no live
    /// terminals answers kilroy-only; an untagged row, an unscoped
    /// provider, and an unknown session never do.
    #[tokio::test]
    async fn the_marker_scopes_and_composes_into_the_batch_predicate() {
        let mut entries = HashMap::new();
        entries.insert(
            "claude:s1".to_string(),
            serde_json::json!({ "sessionType": "kilroy" }),
        );
        entries.insert(
            "gemini:s1".to_string(),
            serde_json::json!({ "sessionType": "kilroy" }),
        );
        entries.insert(
            "claude:s2".to_string(),
            serde_json::json!({ "sessionType": "freshclaude" }),
        );
        assert!(is_kilroy_typed(&entries, "claude:s1"));
        assert!(!is_kilroy_typed(&entries, "claude:s2"));
        assert!(!is_kilroy_typed(&entries, "claude:s3"));

        let identity = TerminalIdentityRegistry::new();
        let keys = kilroy_only_keys(
            &entries,
            None,
            &identity,
            None,
            &[
                KilroyLaneCandidate {
                    provider: "claude".into(),
                    session_id: "s1".into(),
                    cwd: None,
                },
                KilroyLaneCandidate {
                    provider: "claude".into(),
                    session_id: "s2".into(),
                    cwd: None,
                },
                KilroyLaneCandidate {
                    provider: "claude".into(),
                    session_id: "s3".into(),
                    cwd: None,
                },
                KilroyLaneCandidate {
                    provider: "gemini".into(),
                    session_id: "s1".into(),
                    cwd: None,
                },
            ],
        )
        .await;
        assert_eq!(
            keys,
            std::collections::HashSet::from(["claude:s1".to_string()])
        );
    }
}
