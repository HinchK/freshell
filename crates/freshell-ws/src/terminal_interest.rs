//! Connection-local presentation interest. It changes delivery order only.
//! Omitted terminals in an authoritative snapshot are background terminals;
//! before the first snapshot, the existing attach.priority is the fallback.
//!
//! Hidden-pane lifetime claims (responsive-terminal-restore Workstream 1)
//! ride the same snapshots on the negotiated `claimedTerminalIds` field: the
//! connection-local diff (`InterestClaimChange`) is handed back to the
//! dispatcher, which applies it to the terminal registry. The claim never
//! changes delivery priority — only `focused`/`visible` do.

use super::delivery::Priority;
use freshell_protocol::client_messages::TerminalInterest;
use std::collections::{BTreeMap, BTreeSet};

pub(super) const MAX_INTEREST_TERMINALS: usize = 1024;
const MAX_SAFE_REVISION: u64 = 9_007_199_254_740_991;

/// One applied snapshot's claim-set diff (negotiated connections only): the
/// ids this connection newly claims and the ids its previous snapshot
/// claimed that this one no longer does (the explicit withdrawal).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct InterestClaimChange {
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

impl InterestClaimChange {
    pub(crate) fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty()
    }
}

#[derive(Default)]
pub(super) struct InterestState {
    enabled: bool,
    revision: Option<u64>,
    focused: Option<String>,
    visible: BTreeSet<String>,
    attachments: BTreeMap<String, Priority>,
    /// The connection negotiated `terminalLifetimeClaimV1`: its snapshots may
    /// carry `claimedTerminalIds` (hidden-pane lifetime claims). Without it
    /// the field is ignored server-side (validated nowhere, applied nowhere).
    claims_enabled: bool,
    /// The last ACCEPTED claim set (superseded snapshot-by-snapshot).
    claimed: BTreeSet<String>,
}

impl InterestState {
    pub(super) fn enable(&mut self) {
        self.enabled = true;
    }
    pub(super) fn enable_claims(&mut self) {
        self.claims_enabled = true;
    }
    pub(super) fn priority(&self, terminal_id: &str) -> Priority {
        if self.revision.is_some() {
            if self.focused.as_deref() == Some(terminal_id) {
                Priority::Focused
            } else if self.visible.contains(terminal_id) {
                Priority::Visible
            } else {
                Priority::Background
            }
        } else {
            self.attachments
                .get(terminal_id)
                .copied()
                .unwrap_or(Priority::Visible)
        }
    }
    /// Pre-snapshot fallback priority. Once a snapshot revision is
    /// authoritative the map is never consulted, so attach writes nothing.
    /// The cap is a memory bound, not a security boundary: on overflow the
    /// entry is skipped (that terminal then classifies as the Visible default
    /// — the pre-feature behavior) instead of killing the connection.
    /// Entries are pruned on detach and on exit admission, so steady-state
    /// size tracks live terminals.
    pub(super) fn attach(&mut self, terminal_id: &str, background: bool) {
        if self.revision.is_some() {
            return;
        }
        if !self.attachments.contains_key(terminal_id)
            && self.attachments.len() >= MAX_INTEREST_TERMINALS
        {
            tracing::warn!(terminal_id, "ws.interest.fallback_cap_reached");
            return;
        }
        self.attachments.insert(
            terminal_id.to_string(),
            if background {
                Priority::Background
            } else {
                Priority::Visible
            },
        );
    }
    pub(super) fn detach(&mut self, terminal_id: &str) {
        self.attachments.remove(terminal_id);
    }
    /// Apply one snapshot. `Ok(Some(change))` = accepted (the caller applies
    /// `change` to the terminal registry and recomputes delivery priorities);
    /// `Ok(None)` = stale revision, nothing changed; `Err` = rejected without
    /// replacing the last accepted state.
    pub(super) fn apply(
        &mut self,
        snapshot: &TerminalInterest,
    ) -> Result<Option<InterestClaimChange>, &'static str> {
        if !self.enabled {
            return Err("terminalInterestV1 was not negotiated");
        }
        if snapshot.revision == 0 || snapshot.revision > MAX_SAFE_REVISION {
            return Err("Invalid terminal interest revision");
        }
        if snapshot.visible_terminal_ids.len() > MAX_INTEREST_TERMINALS {
            return Err("Too many visible terminal identifiers");
        }
        let valid_id = |id: &str| !id.is_empty() && id.encode_utf16().count() <= 512;
        if !snapshot.visible_terminal_ids.iter().all(|id| valid_id(id))
            || snapshot
                .focused_terminal_id
                .as_deref()
                .is_some_and(|id| !valid_id(id))
        {
            return Err("Invalid terminal interest identifier");
        }
        let visible: BTreeSet<String> = snapshot.visible_terminal_ids.iter().cloned().collect();
        if snapshot
            .focused_terminal_id
            .as_ref()
            .is_some_and(|id| !visible.contains(id))
        {
            return Err("Focused terminal must be visible");
        }
        // Claim-set validation runs only for a connection that negotiated the
        // capability: a non-negotiated sender's field is ignored entirely
        // (robustness — the client gates it send-side, the server must not
        // depend on that).
        let claimed_input = match (&self.claims_enabled, &snapshot.claimed_terminal_ids) {
            (true, Some(claimed)) => {
                if claimed.len() > MAX_INTEREST_TERMINALS {
                    return Err("Too many claimed terminal identifiers");
                }
                if !claimed.iter().all(|id| valid_id(id)) {
                    return Err("Invalid terminal interest identifier");
                }
                Some(claimed)
            }
            _ => None,
        };
        if self
            .revision
            .is_some_and(|revision| snapshot.revision <= revision)
        {
            return Ok(None);
        }
        self.revision = Some(snapshot.revision);
        self.focused.clone_from(&snapshot.focused_terminal_id);
        self.visible = visible;
        // Latest snapshot's claim set wins per connection: `Some(set)`
        // supersedes; `None` carries no claim information and leaves the last
        // accepted set standing.
        let mut change = InterestClaimChange::default();
        if let Some(claimed) = claimed_input {
            let next: BTreeSet<String> = claimed.iter().cloned().collect();
            for id in next.difference(&self.claimed) {
                change.added.push(id.clone());
            }
            for id in self.claimed.difference(&next) {
                change.removed.push(id.clone());
            }
            self.claimed = next;
        }
        Ok(Some(change))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn snapshot(revision: u64, focused: Option<&str>, visible: &[&str]) -> TerminalInterest {
        TerminalInterest {
            revision,
            focused_terminal_id: focused.map(str::to_string),
            visible_terminal_ids: visible.iter().map(|s| s.to_string()).collect(),
            claimed_terminal_ids: None,
        }
    }
    fn applied() -> InterestClaimChange {
        InterestClaimChange::default()
    }
    #[test]
    fn requires_negotiation() {
        assert!(InterestState::default()
            .apply(&snapshot(1, None, &[]))
            .is_err());
    }
    #[test]
    fn existing_attach_priority_is_honored_without_new_client() {
        let mut state = InterestState::default();
        state.attach("a", true);
        assert_eq!(state.priority("a"), Priority::Background);
        state.attach("a", false);
        assert_eq!(state.priority("a"), Priority::Visible);
    }
    #[test]
    fn full_snapshot_is_authoritative_and_newer_revision_wins() {
        let mut state = InterestState::default();
        state.enable();
        assert_eq!(
            state.apply(&snapshot(3, Some("a"), &["a", "b"])),
            Ok(Some(applied()))
        );
        assert_eq!(state.priority("a"), Priority::Focused);
        assert_eq!(state.priority("b"), Priority::Visible);
        assert_eq!(state.priority("c"), Priority::Background);
        assert_eq!(state.apply(&snapshot(2, Some("b"), &["b"])), Ok(None));
        assert_eq!(state.priority("a"), Priority::Focused);
        assert_eq!(state.apply(&snapshot(4, None, &[])), Ok(Some(applied())));
        assert_eq!(state.priority("a"), Priority::Background);
    }
    #[test]
    fn priority_does_not_allocate_terminal_output_or_transfer_connections() {
        let mut first = InterestState::default();
        first.enable();
        first
            .apply(&snapshot(1, Some("not-attached"), &["not-attached"]))
            .unwrap();
        assert!(first.attachments.is_empty());
        let second = InterestState::default();
        assert_eq!(second.priority("not-attached"), Priority::Visible);
    }
    #[test]
    fn rejects_malformed_snapshot_without_replacing_previous_state() {
        let mut state = InterestState::default();
        state.enable();
        state.apply(&snapshot(1, Some("a"), &["a"])).unwrap();
        for invalid in [
            snapshot(0, None, &[]),
            snapshot(MAX_SAFE_REVISION + 1, None, &[]),
            snapshot(2, Some("b"), &["a"]),
            snapshot(2, None, &[""]),
        ] {
            assert!(state.apply(&invalid).is_err());
            assert_eq!(state.priority("a"), Priority::Focused);
        }
    }
    #[test]
    fn detach_prunes_fallback_and_snapshot_does_not_override_live_identity() {
        let mut state = InterestState::default();
        state.attach("old", true);
        state.detach("old");
        assert!(state.attachments.is_empty());
        state.enable();
        state.apply(&snapshot(1, Some("old"), &["old"])).unwrap();
        assert_eq!(state.priority("replacement"), Priority::Background);
    }

    // ── Hidden-pane lifetime claims (responsive-terminal-restore WS1) ──

    fn claimed_snapshot(
        revision: u64,
        focused: Option<&str>,
        visible: &[&str],
        claimed: Option<&[&str]>,
    ) -> TerminalInterest {
        TerminalInterest {
            revision,
            focused_terminal_id: focused.map(str::to_string),
            visible_terminal_ids: visible.iter().map(|s| s.to_string()).collect(),
            claimed_terminal_ids: claimed.map(|ids| ids.iter().map(|s| s.to_string()).collect()),
        }
    }

    #[test]
    fn claims_require_the_connection_negotiation() {
        // A connection that did NOT negotiate terminalLifetimeClaimV1 has its
        // claimedTerminalIds ignored server-side: the snapshot still applies
        // for delivery priority, but the claim diff stays empty (no claim is
        // recorded, so nothing can ever be withdrawn either).
        let mut state = InterestState::default();
        state.enable();
        assert_eq!(
            state.apply(&claimed_snapshot(1, None, &[], Some(&["T"]))),
            Ok(Some(InterestClaimChange {
                added: vec![],
                removed: vec![]
            }))
        );
        assert!(state.claimed.is_empty());
    }

    #[test]
    fn claim_snapshot_supersedes_previous_claim_set_per_connection() {
        let mut state = InterestState::default();
        state.enable();
        state.enable_claims();
        // First snapshot claims T and U.
        assert_eq!(
            state.apply(&claimed_snapshot(1, None, &[], Some(&["T", "U"]))),
            Ok(Some(InterestClaimChange {
                added: vec!["T".to_string(), "U".to_string()],
                removed: vec![]
            }))
        );
        // A later snapshot claiming only U withdraws T (latest wins).
        assert_eq!(
            state.apply(&claimed_snapshot(2, None, &[], Some(&["U"]))),
            Ok(Some(InterestClaimChange {
                added: vec![],
                removed: vec!["T".to_string()]
            }))
        );
        // An empty claim set withdraws everything.
        assert_eq!(
            state.apply(&claimed_snapshot(3, None, &[], Some(&[]))),
            Ok(Some(InterestClaimChange {
                added: vec![],
                removed: vec!["U".to_string()]
            }))
        );
        // A snapshot with NO claim field carries no claim information: the
        // previous (now-empty) set stands and the diff is empty.
        assert_eq!(
            state.apply(&claimed_snapshot(4, None, &[], None)),
            Ok(Some(InterestClaimChange {
                added: vec![],
                removed: vec![]
            }))
        );
    }

    #[test]
    fn stale_snapshots_do_not_apply_claims() {
        let mut state = InterestState::default();
        state.enable();
        state.enable_claims();
        assert_eq!(
            state.apply(&claimed_snapshot(5, None, &[], Some(&["T"]))),
            Ok(Some(InterestClaimChange {
                added: vec!["T".to_string()],
                removed: vec![]
            }))
        );
        // A STALE revision (5 <= 5) claiming U must be ignored entirely.
        assert_eq!(
            state.apply(&claimed_snapshot(5, None, &[], Some(&["U"]))),
            Ok(None)
        );
        // The accepted claim set still says T only.
        assert_eq!(
            state.apply(&claimed_snapshot(6, None, &[], Some(&["T"]))),
            Ok(Some(InterestClaimChange {
                added: vec![],
                removed: vec![]
            }))
        );
    }

    #[test]
    fn invalid_claim_snapshots_are_rejected_without_replacing_previous_state() {
        let mut state = InterestState::default();
        state.enable();
        state.enable_claims();
        state
            .apply(&claimed_snapshot(1, None, &[], Some(&["T"])))
            .unwrap();
        // Empty id and an oversized claim list are both invalid.
        assert!(state
            .apply(&claimed_snapshot(2, None, &[], Some(&[""])))
            .is_err());
        let too_many_valid_ids: Vec<String> = (0..=MAX_INTEREST_TERMINALS)
            .map(|i| format!("t-{i}"))
            .collect();
        let too_many_refs: Vec<&str> = too_many_valid_ids.iter().map(String::as_str).collect();
        assert!(state
            .apply(&claimed_snapshot(3, None, &[], Some(&too_many_refs)))
            .is_err());
        // Rejected snapshots did not disturb the accepted claim set.
        assert_eq!(
            state.apply(&claimed_snapshot(4, None, &[], Some(&["T"]))),
            Ok(Some(InterestClaimChange {
                added: vec![],
                removed: vec![]
            }))
        );
    }
}
