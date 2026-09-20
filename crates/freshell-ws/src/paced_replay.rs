//! Responsive-terminal-restore Workstream 1 — the connection-side pacing
//! coordinator for negotiated (`pacedTerminalReplayV1`) terminal replay.
//!
//! The registry owns the page reads ([`freshell_terminal::TerminalRegistry`]
//! `attach`'s paced start, `next_replay_page`, `next_paced_tail_page`) and
//! the per-subscriber deferral; THIS module owns the session state the wire
//! protocol needs: the fixed catch-up target, the production cursor, the
//! credited-consumed window that gates continuation credits, and the
//! drive loop that turns a valid [`TerminalReplayCredit`] into the next
//! page (or the negotiated retention gap + continuation, or the tail drain
//! that completes the session).
//!
//! Credit rules (all under the connection's negotiated capability; ignored
//! otherwise): a credit whose `attachRequestId` does not match the ACTIVE
//! session is a stale generation (superseded or completed — ignored); a
//! `consumedSeq` outside `(credited, page_end]` is out of window (ignored —
//! no double-grant, no phantom grant past the last-sent page). A valid
//! credit produces exactly ONE further replay page, so at most ONE
//! unacknowledged page per (connection, terminal) exists at any time. Gap
//! rounds continue within the same credit until a frame-carrying page is
//! produced — an accepted credit always makes byte progress, never a
//! zero-progress demand for more credit.
//!
//! When the cursor reaches the target, the accumulated live range
//! `(target, head]` drains as ordinary delivery (pages, not credit-gated)
//! and the registry clears the deferral ATOMICALLY when the ring is
//! drained — live output can never overtake an un-sent page.

use std::collections::HashMap;

use freshell_protocol::{
    ServerMessage, TerminalOutputGap, TerminalOutputGapReason, TerminalReplayCredit,
};
use freshell_terminal::{FrameSink, PacedPage, PacedSessionDesc, PacedTailPage, TerminalRegistry};

/// One active paced replay session for a (connection, terminal). Owned by
/// the connection's dispatch loop; a re-attach replaces it, a detach or
/// socket drop discards it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PacedSession {
    pub terminal_id: String,
    pub stream_id: String,
    /// The attach generation this session serves — the stale-credit key.
    pub attach_request_id: String,
    /// FIXED catch-up target: the head at attach time. Ongoing output never
    /// extends it (frames past the target are tail delivery).
    pub target: i64,
    /// The retention-adjusted baseline the session started from.
    pub effective_since: i64,
    /// Highest credited consumed seq (starts at the baseline; the
    /// double-grant guard).
    pub credited: i64,
    /// Production cursor: the last seq sent in a page.
    pub page_end: i64,
    /// Pages produced so far (observability).
    pub pages: u64,
}

impl PacedSession {
    /// Adopt the registry's attach-time session description (the first page
    /// was produced under the attach lock and is sunk by the caller).
    pub(crate) fn from_desc(desc: PacedSessionDesc) -> Self {
        let started = desc.page_end > desc.effective_since;
        Self {
            terminal_id: desc.terminal_id,
            stream_id: desc.stream_id,
            attach_request_id: desc.attach_request_id,
            target: desc.target,
            effective_since: desc.effective_since,
            credited: desc.effective_since,
            page_end: desc.page_end,
            pages: u64::from(started),
        }
    }
}

/// The per-connection session table (at most one session per terminal).
#[derive(Default)]
pub(crate) struct PacedSessions {
    inner: HashMap<String, PacedSession>,
}

impl PacedSessions {
    /// Install (or replace — the re-attach supersede) a session.
    pub(crate) fn insert(&mut self, session: PacedSession) {
        self.inner.insert(session.terminal_id.clone(), session);
    }

    pub(crate) fn get_mut(&mut self, terminal_id: &str) -> Option<&mut PacedSession> {
        self.inner.get_mut(terminal_id)
    }

    /// Cancel one terminal's session (`terminal.detach`).
    pub(crate) fn cancel(&mut self, terminal_id: &str) {
        self.inner.remove(terminal_id);
    }

    pub(crate) fn remove(&mut self, terminal_id: &str) -> Option<PacedSession> {
        self.inner.remove(terminal_id)
    }
}

/// The verdict for one inbound credit (observability's status field).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CreditVerdict {
    Accepted,
    StaleGeneration,
    BeyondWindow,
    NonNegotiated,
}

impl CreditVerdict {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::StaleGeneration => "stale_generation",
            Self::BeyondWindow => "beyond_window",
            Self::NonNegotiated => "non_negotiated",
        }
    }
}

/// Validate one credit against the session and, when valid, advance the
/// credited cursor (the grant). Pure — the drive loop does the producing.
pub(crate) fn validate_credit(
    session: &mut PacedSession,
    credit: &TerminalReplayCredit,
) -> CreditVerdict {
    if session.attach_request_id != credit.attach_request_id {
        return CreditVerdict::StaleGeneration;
    }
    if credit.consumed_seq <= session.credited || credit.consumed_seq > session.page_end {
        return CreditVerdict::BeyondWindow;
    }
    session.credited = credit.consumed_seq;
    CreditVerdict::Accepted
}

/// The negotiated retention gap for an `Expired` read: the exact lost
/// interval plus the task-2 bounds fields, stamped with the session's
/// generation.
fn retention_gap(
    session: &PacedSession,
    lost_from: i64,
    lost_to: i64,
    head_seq: i64,
    oldest_retained_seq: i64,
) -> ServerMessage {
    ServerMessage::TerminalOutputGap(TerminalOutputGap {
        terminal_id: session.terminal_id.clone(),
        stream_id: session.stream_id.clone(),
        attach_request_id: Some(session.attach_request_id.clone()),
        from_seq: lost_from,
        to_seq: lost_to,
        reason: TerminalOutputGapReason::ReplayWindowExceeded,
        head_seq: Some(head_seq),
        oldest_retained_seq: Some(oldest_retained_seq),
    })
}

/// The outcome of driving a session one round (attach start or one valid
/// credit).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DriveOutcome {
    /// A replay page is outstanding (uncredited); the session waits for the
    /// next credit.
    Active,
    /// The session completed: the tail drained and the registry cleared the
    /// deferral (the `ws.restore.paced_complete` event is emitted here).
    Completed,
    /// The terminal (or the connection's subscriber) disappeared — the
    /// session is cancelled; the registry has no deferral left to clear.
    Gone,
}

/// Produce the next page for a session after a valid credit (or drain the
/// tail when the cursor reached the target). Exactly one replay page per
/// credit; `Expired` rounds emit the negotiated retention gap and continue
/// within the same credit until a frame-carrying page exists. The tail
/// drains without credit and completes the session when the registry's
/// atomic clear fires (`CaughtUp`).
pub(crate) fn drive_session(
    registry: &TerminalRegistry,
    conn_id: u64,
    sink: &FrameSink,
    session: &mut PacedSession,
    budget: i64,
) -> DriveOutcome {
    // Replay phase: page (target, ...] toward the fixed target.
    if session.page_end < session.target {
        loop {
            match registry.next_replay_page(
                &session.terminal_id,
                conn_id,
                session.page_end,
                session.target,
                budget,
            ) {
                PacedPage::Frames {
                    messages, end_seq, ..
                } => {
                    for message in messages {
                        sink(message);
                    }
                    session.page_end = end_seq;
                    session.pages += 1;
                    if session.page_end < session.target {
                        return DriveOutcome::Active;
                    }
                    break; // cursor reached the target -> tail
                }
                PacedPage::Done => break,
                PacedPage::Expired {
                    lost_from,
                    lost_to,
                    resume_from,
                    head_seq,
                    oldest_retained_seq,
                } => {
                    sink(retention_gap(
                        session,
                        lost_from,
                        lost_to,
                        head_seq,
                        oldest_retained_seq,
                    ));
                    tracing::info!(
                        terminal_id = %session.terminal_id,
                        lost_from,
                        lost_to,
                        resume_from,
                        "ws.restore.paced_expired"
                    );
                    session.page_end = resume_from;
                    continue;
                }
                PacedPage::Gone => {
                    tracing::warn!(
                        terminal_id = %session.terminal_id,
                        attach_request_id = %session.attach_request_id,
                        "ws.restore.paced_gone"
                    );
                    return DriveOutcome::Gone;
                }
            }
        }
    }
    // Tail phase: ordinary delivery of the accumulated live range; the
    // registry clears the deferral atomically when the ring is drained.
    loop {
        match registry.next_paced_tail_page(&session.terminal_id, conn_id, session.page_end, budget)
        {
            PacedTailPage::Frames {
                messages, end_seq, ..
            } => {
                for message in messages {
                    sink(message);
                }
                session.page_end = end_seq;
                session.pages += 1;
            }
            PacedTailPage::Expired {
                lost_from,
                lost_to,
                resume_from,
                head_seq,
                oldest_retained_seq,
            } => {
                sink(retention_gap(
                    session,
                    lost_from,
                    lost_to,
                    head_seq,
                    oldest_retained_seq,
                ));
                tracing::info!(
                    terminal_id = %session.terminal_id,
                    lost_from,
                    lost_to,
                    resume_from,
                    "ws.restore.paced_expired"
                );
                session.page_end = resume_from;
            }
            PacedTailPage::CaughtUp => {
                tracing::info!(
                    terminal_id = %session.terminal_id,
                    attach_request_id = %session.attach_request_id,
                    last_seq = session.page_end,
                    pages = session.pages,
                    "ws.restore.paced_complete"
                );
                return DriveOutcome::Completed;
            }
            PacedTailPage::Gone => {
                tracing::warn!(
                    terminal_id = %session.terminal_id,
                    attach_request_id = %session.attach_request_id,
                    "ws.restore.paced_gone"
                );
                return DriveOutcome::Gone;
            }
        }
    }
}

/// Begin one negotiated session after a paced attach: sink the first page
/// (produced under the attach lock; sunk now that it is released), emit
/// `ws.restore.paced_start`, and — ONLY when the first page already reached
/// the target — run the initial tail drain (an attach with a short or empty
/// replay completes without ever needing a credit). A first page that is a
/// bounded prefix leaves the session ACTIVE with exactly ONE outstanding
/// page: the next page is produced on the first credit, never before.
pub(crate) fn start_session(
    registry: &TerminalRegistry,
    conn_id: u64,
    sink: &FrameSink,
    sessions: &mut PacedSessions,
    start: freshell_terminal::PacedAttachStart,
    requested_since_seq: i64,
    max_replay_bytes: Option<i64>,
) {
    let page_bytes = start.session.page_bytes;
    let mut session = PacedSession::from_desc(start.session);
    for message in start.first_page {
        sink(message);
    }
    tracing::info!(
        terminal_id = %session.terminal_id,
        attach_request_id = %session.attach_request_id,
        requested_since = requested_since_seq,
        effective_since = session.effective_since,
        target = session.target,
        page_bytes,
        max_replay_bytes = ?max_replay_bytes,
        "ws.restore.paced_start"
    );
    if session.page_end >= session.target {
        let budget = registry.paced_page_max_bytes();
        match drive_session(registry, conn_id, sink, &mut session, budget) {
            // The tail drain never returns Active — but if it somehow did,
            // keeping the session installed is the safe arm (the next credit
            // drives it) rather than dropping live-ordering state.
            DriveOutcome::Active => sessions.insert(session),
            DriveOutcome::Completed | DriveOutcome::Gone => {}
        }
    } else {
        // The first page is the one outstanding, uncredited page.
        sessions.insert(session);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session_fixture() -> PacedSession {
        PacedSession {
            terminal_id: "T".into(),
            stream_id: "S".into(),
            attach_request_id: "arid-1".into(),
            target: 100,
            effective_since: 10,
            credited: 10,
            page_end: 50,
            pages: 1,
        }
    }

    fn credit(arid: &str, consumed_seq: i64) -> TerminalReplayCredit {
        TerminalReplayCredit {
            terminal_id: "T".into(),
            stream_id: "S".into(),
            attach_request_id: arid.into(),
            consumed_seq,
        }
    }

    #[test]
    fn valid_credit_advances_the_credited_cursor() {
        let mut session = session_fixture();
        assert_eq!(
            validate_credit(&mut session, &credit("arid-1", 50)),
            CreditVerdict::Accepted
        );
        assert_eq!(session.credited, 50);
        // The production position stays at the last-sent page end.
        assert_eq!(session.page_end, 50);
    }

    #[test]
    fn stale_generation_credit_is_ignored() {
        let mut session = session_fixture();
        assert_eq!(
            validate_credit(&mut session, &credit("arid-old", 50)),
            CreditVerdict::StaleGeneration
        );
        assert_eq!(session.credited, 10, "a stale credit grants nothing");
    }

    #[test]
    fn duplicate_and_beyond_window_credits_are_ignored() {
        let mut session = session_fixture();
        // Beyond the last-sent page's end.
        assert_eq!(
            validate_credit(&mut session, &credit("arid-1", 51)),
            CreditVerdict::BeyondWindow
        );
        // At-or-below the already-credited cursor (double grant).
        assert_eq!(
            validate_credit(&mut session, &credit("arid-1", 10)),
            CreditVerdict::BeyondWindow
        );
        assert_eq!(session.credited, 10);
        // A VALID credit still works after the ignored ones.
        assert_eq!(
            validate_credit(&mut session, &credit("arid-1", 50)),
            CreditVerdict::Accepted
        );
    }

    #[test]
    fn partial_consumption_within_the_page_window_grants_once() {
        let mut session = session_fixture();
        // consumedSeq inside (credited, page_end] — valid; production
        // continues from the last-sent end, so no frame is ever re-sent.
        assert_eq!(
            validate_credit(&mut session, &credit("arid-1", 30)),
            CreditVerdict::Accepted
        );
        assert_eq!(session.credited, 30);
        assert_eq!(
            validate_credit(&mut session, &credit("arid-1", 30)),
            CreditVerdict::BeyondWindow,
            "the same value cannot grant twice"
        );
        assert_eq!(
            validate_credit(&mut session, &credit("arid-1", 50)),
            CreditVerdict::Accepted
        );
    }

    #[test]
    fn session_adoption_counts_the_first_page() {
        let desc = PacedSessionDesc {
            terminal_id: "T".into(),
            stream_id: "S".into(),
            attach_request_id: "a".into(),
            target: 9,
            effective_since: 3,
            page_end: 7,
            page_bytes: 123,
        };
        let session = PacedSession::from_desc(desc);
        assert_eq!(session.credited, 3, "crediting starts at the baseline");
        assert_eq!(session.page_end, 7);
        assert_eq!(session.pages, 1);

        // An attach with nothing to replay starts with no pages.
        let empty = PacedSessionDesc {
            page_end: 3,
            effective_since: 3,
            ..PacedSessionDesc {
                terminal_id: "T".into(),
                stream_id: "S".into(),
                attach_request_id: "a".into(),
                target: 3,
                effective_since: 3,
                page_end: 3,
                page_bytes: 0,
            }
        };
        assert_eq!(PacedSession::from_desc(empty).pages, 0);
    }
}
