//! Responsive-terminal-restore Workstream 1 — the connection-side pacing
//! coordinator for negotiated (`pacedTerminalReplayV1`) terminal replay.
//!
//! The registry owns the page reads ([`freshell_terminal::TerminalRegistry`]
//! `attach`'s paced start, `next_replay_page`, `complete_paced_tail`) and
//! the per-subscriber deferral; THIS module owns the session state the wire
//! protocol needs: the fixed catch-up target, the production cursor, the
//! credited-consumed window that gates continuation credits, and the two
//! execution sites that turn a valid [`TerminalReplayCredit`] into the
//! next page — the CREDITED replay phase (inline, one page per credit,
//! dispatcher-owned) and the UN-CREDITED drain (a spawned task that pages
//! the accumulated live range toward a FIXED target captured once at
//! drain start, so the connection dispatcher stays free to service input
//! and other panes for the drain's whole duration).
//!
//! Credit rules (all under the connection's negotiated capability; ignored
//! otherwise): a credit whose `attachRequestId` does not match the ACTIVE
//! session is a stale generation (superseded, completed, or DRAINING —
//! ignored); a `consumedSeq` outside `(credited, page_end]` is out of
//! window (ignored — no double-grant, no phantom grant past the last-sent
//! page). The grant is STRICTLY page-end: an in-window value below the
//! page end is a partial consumption report (observed as
//! `partial_consumption`, grants nothing — the prior batch is not yet
//! fully consumed); only `consumedSeq == page_end` produces exactly ONE
//! further replay page, so at most ONE unacknowledged page per
//! (connection, terminal) exists at any time and per-pane
//! unacknowledged replay stays bounded by one page budget. Gap rounds
//! continue within the same credit until a frame-carrying page is
//! produced — an accepted credit always makes byte progress, never a
//! zero-progress demand for more credit.
//!
//! When the replay cursor reaches the fixed attach-time target, the
//! accumulated live range drains as ordinary delivery (pages, not
//! credit-gated) in the SPAWNED drain task toward a FIXED target — the
//! head captured ONCE when the drain starts, NEVER re-captured. When
//! that target is covered, the COMPLETION BOUNDARY B is captured ONCE
//! under the same hold (the registry records it on the subscriber —
//! `TargetCovered`), and the staged post-target remainder pages toward
//! B and ONLY B through the bounded post-target handoff — the boundary
//! NEVER moves again, so a producer appending at-or-above drain speed
//! cannot postpone completion (the moving-head chase is structurally
//! gone: no completion-path code reads the terminal's current head
//! after completion start). The completing hold clears the deferral
//! atomically with its delivery, and the frames the producer staged
//! past B flow through the normal live fan-out path in that same hold.
//! Retention overrunning the handoff cursor mid-handoff is the plan:146
//! bounded-baseline exit: the registry sinks the exact bounds-carrying
//! gap (ordered ahead of everything), sweeps the retained window through
//! the normal live path, clears the deferral, and the session COMPLETES
//! AT THE RING FRONT — the paged handoff never resumes toward the
//! unreachable boundary. Between pages the drain task holds a
//! RESERVATION on the connection queue's admission capacity
//! (reserve-then-admit, round-5): the reservation accounts for the page
//! it is about to admit and for every other concurrent pane drain's
//! in-flight reservation, so the un-credited drain is bounded by the
//! connection queue's REAL consumption and can never self-spill its own
//! unconsumed pages.

use std::collections::HashMap;
use std::sync::Arc;

use freshell_protocol::{
    ServerMessage, TerminalOutputGap, TerminalOutputGapReason, TerminalReplayCredit,
};
use freshell_terminal::{
    FrameSink, PacedPage, PacedSessionDesc, PacedTailCompletion, TerminalRegistry,
};

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
    /// In-window but below the last-sent page's end: honest consumption
    /// progress the server records as an observation, but the prior batch
    /// is not fully consumed, so it grants nothing.
    PartialConsumption,
    StaleGeneration,
    BeyondWindow,
    NonNegotiated,
}

impl CreditVerdict {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::PartialConsumption => "partial_consumption",
            Self::StaleGeneration => "stale_generation",
            Self::BeyondWindow => "beyond_window",
            Self::NonNegotiated => "non_negotiated",
        }
    }
}

/// Validate one credit against the session and, when valid, advance the
/// credited cursor (the grant). Pure — the drive loop does the producing.
///
/// The grant is STRICTLY page-end: only a `consumed_seq` equal to the
/// last-sent page's end produces the next page (the plan's credit rule —
/// "Credit is granted only after the prior batch is consumed in order").
/// An in-window value below the page end is a partial-consumption report:
/// observed (`partial_consumption`), inert — at most ONE unacknowledged
/// page per (connection, terminal) exists at any time, so per-pane
/// unacknowledged replay stays bounded by one page budget.
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
    if credit.consumed_seq < session.page_end {
        return CreditVerdict::PartialConsumption;
    }
    session.credited = credit.consumed_seq;
    CreditVerdict::Accepted
}

/// The negotiated retention gap for an `Expired` read: the exact lost
/// interval plus the task-2 bounds fields, stamped with the session's
/// generation.
fn retention_gap(
    terminal_id: &str,
    stream_id: &str,
    attach_request_id: &str,
    lost_from: i64,
    lost_to: i64,
    head_seq: i64,
    oldest_retained_seq: i64,
) -> ServerMessage {
    ServerMessage::TerminalOutputGap(TerminalOutputGap {
        terminal_id: terminal_id.to_string(),
        stream_id: stream_id.to_string(),
        attach_request_id: Some(attach_request_id.to_string()),
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
    /// The credited replay phase is DONE — the fixed attach-time target is
    /// covered. The caller hands the session to the spawned drain task
    /// ([`spawn_paced_drain`]); the un-credited drain never runs on the
    /// connection dispatcher.
    DrainReady,
    /// The terminal (or the connection's subscriber) disappeared — the
    /// session is cancelled; the registry has no deferral left to clear.
    Gone,
}

/// Produce the next page for a session after a valid credit (or drain the
/// tail when the cursor reached the target). Exactly one replay page per
/// credit; `Expired` rounds emit the negotiated retention gap and continue
/// within the same credit until a frame-carrying page exists. The tail
/// drains without credit toward the FIXED head captured at tail-start
/// (never the moving current head — a producing terminal cannot postpone
/// completion indefinitely, and the drain's per-connection work stays
/// bounded), then completes through budget-bounded pages: the staged
/// remainder pages at the same page budget (never a full-suffix batch),
/// the deferral clears only at the completing verdict, and a retention
/// advance past the drain cursor reports the exact bounds-carrying gap
/// and resumes from the ring front so live frames can neither jump the
/// pages nor be lost.
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
                        &session.terminal_id,
                        &session.stream_id,
                        &session.attach_request_id,
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
    DriveOutcome::DrainReady
}

/// Spawn the session's UN-CREDITED drain (the accumulated live range after
/// the credited replay covered its fixed target). The drain runs OFF the
/// connection dispatcher — a sustained producer can hold it open through
/// real backpressure for as long as the client takes to consume the
/// backlog, and the dispatcher must keep servicing input, other panes,
/// and control traffic meanwhile (the inline-drain structure this
/// replaces monopolized the dispatcher for the drain's whole duration,
/// starving same-connection input).
///
/// The drain target is the head captured ONCE at drain start — NEVER
/// re-captured. When the target is covered, the registry's
/// `TargetCovered` verdict captures the COMPLETION BOUNDARY B ONCE under
/// that hold (recorded on the subscriber) and the staged post-target
/// remainder pages toward B and ONLY B through the bounded post-target
/// handoff (`handoff_paced_tail`) — page-budget-sized per lock hold, the
/// lock released between chunks, the same admission-reserved loop. The
/// completing hold clears the deferral atomically with its delivery and
/// the frames staged past B flow through the normal live fan-out path in
/// that hold; a retention overrun past the handoff cursor mid-handoff is
/// the plan:146 bounded-baseline exit (`GapCompleted`): the exact
/// bounds-carrying gap is sunk (ordered ahead of everything), the
/// retained window sweeps through the normal live path, and the session
/// COMPLETES AT THE RING FRONT — never a resumption toward the
/// unreachable boundary. No completion or handoff path ever bulk-clones
/// a retained suffix or admits pages outside the page budget; a
/// sustained producer can never turn the drain into a moving-head
/// chase. Between pages the task holds a RESERVATION on the connection
/// queue's admission capacity (round-5 finding 1, reserve-then-admit):
/// the grant accounts for the page about to be admitted and for every
/// other concurrent pane drain's in-flight reservation — the sink
/// itself admits without yielding and evicts past the byte limit, so
/// the reservation is what bounds the drain and keeps it from
/// self-spilling its own unconsumed pages. `cancel` fires on the
/// connection's teardown (any exit reason), bounding the task's
/// lifetime with the connection's own.
///
/// Page order, the deferral contract, and lock discipline are preserved:
/// the session leaves `PacedSessions` when it enters the drain (credits
/// during the drain are stale generations — observed, inert), only this
/// task produces the drain's pages (single producer, ascending seq), the
/// registry's per-terminal lock is never held across pages, and the
/// generation guard inside `TerminalRegistry::complete_paced_tail` /
/// `TerminalRegistry::handoff_paced_tail` refuses the drain the moment a
/// re-attach supersedes its attach generation (the off-dispatch drain can
/// race the dispatcher's re-attach handling; the guard makes that race
/// inert).
pub(crate) fn spawn_paced_drain(
    registry: TerminalRegistry,
    conn_id: u64,
    writer: crate::terminal::WsSink,
    sink: FrameSink,
    mut session: PacedSession,
    budget: i64,
    mut cancel: tokio::sync::watch::Receiver<bool>,
) {
    tokio::spawn(async move {
        let terminal_id = session.terminal_id.clone();
        let stream_id = session.stream_id.clone();
        let attach_request_id = session.attach_request_id.clone();
        // The FIXED drain target: captured ONCE, never reassigned.
        let drain_target = match registry.replay_bounds(&terminal_id) {
            Some(bounds) => bounds.head_seq,
            None => {
                tracing::warn!(
                    terminal_id = %terminal_id,
                    attach_request_id = %attach_request_id,
                    "ws.restore.paced_gone"
                );
                return;
            }
        };
        // The drain's two phases share ONE gated loop: paging toward the
        // FIXED target, then — once it is covered — the bounded post-target
        // handoff toward the terminal's current head. The phase never
        // re-captures the drain target.
        //
        // RESERVE-THEN-ADMIT (round-5 finding 1): every page and every
        // handoff chunk reserves its full budget under the connection
        // queue's own lock BEFORE the registry builds and sinks it, so the
        // reservation accounts for the page about to be admitted AND for
        // every other concurrent pane drain's in-flight reservation — the
        // concurrent wakes can no longer each admit a full page on top of
        // the same pre-admission backlog. The permit is held across the
        // whole iteration (the page's bytes become real backlog before
        // the release; an iteration that sinks a retention gap instead
        // releases the reservation unused). The server boot clamps the
        // page budget to the connection queue's admission ceiling, so the
        // grant is always reachable — and the gate itself can never
        // deadlock whatever the budget (a page larger than the watermark
        // admits into a fully drained queue).
        let admission_bytes = budget.max(0) as usize;
        let mut handing_off = false;
        loop {
            // The RAII permit is held to the END of the loop body (dropped
            // at each `return` inside the match and after the match for
            // continuing arms): its only role is the reservation's
            // lifetime, hence the underscore binding.
            let _permit = tokio::select! {
                permit = writer.reserve_drain_admission(admission_bytes) => {
                    match permit {
                        Some(permit) => permit,
                        None => {
                            // The writer pump is gone; the cancel path owns
                            // the exit.
                            return;
                        }
                    }
                }
                _ = cancel.changed() => {
                    tracing::debug!(
                        terminal_id = %terminal_id,
                        attach_request_id = %attach_request_id,
                        "ws.restore.paced_drain_cancelled"
                    );
                    return;
                }
            };
            let verdict = if handing_off {
                registry.handoff_paced_tail(
                    &terminal_id,
                    conn_id,
                    &attach_request_id,
                    session.page_end,
                    budget,
                )
            } else {
                registry.complete_paced_tail(
                    &terminal_id,
                    conn_id,
                    &attach_request_id,
                    session.page_end,
                    drain_target,
                    budget,
                )
            };
            match verdict {
                PacedTailCompletion::Handoff {
                    end_seq,
                    serialized_bytes,
                } => {
                    tracing::debug!(
                        terminal_id = %terminal_id,
                        end_seq,
                        serialized_bytes,
                        "ws.restore.paced_tail_page"
                    );
                    session.page_end = end_seq;
                    session.pages += 1;
                }
                PacedTailCompletion::TargetCovered {
                    end_seq,
                    serialized_bytes,
                } => {
                    // THE FIXED TARGET IS COVERED — COMPLETION START (never
                    // re-captured): the registry recorded the completion
                    // boundary B (the head under this hold) on the
                    // subscriber; the staged post-target remainder now pages
                    // toward B and ONLY B through the bounded handoff
                    // (page-budget-sized chunks, gated, lock released
                    // between them) — never a bulk re-fan, never a moving
                    // current-head target.
                    tracing::debug!(
                        terminal_id = %terminal_id,
                        attach_request_id = %attach_request_id,
                        end_seq,
                        serialized_bytes,
                        "ws.restore.paced_target_covered"
                    );
                    session.page_end = end_seq;
                    session.pages += 1;
                    handing_off = true;
                }
                PacedTailCompletion::Expired {
                    lost_from,
                    lost_to,
                    resume_from,
                    head_seq,
                    oldest_retained_seq,
                } => {
                    // DRAIN-PHASE retention overrun (before the target was
                    // covered): the exact bounds-carrying gap, then continue
                    // toward the still-FIXED target from the resumed front.
                    // (Mid-handoff overruns take the plan:146 exit below —
                    // the paged handoff never resumes.)
                    sink(retention_gap(
                        &terminal_id,
                        &stream_id,
                        &attach_request_id,
                        lost_from,
                        lost_to,
                        head_seq,
                        oldest_retained_seq,
                    ));
                    tracing::info!(
                        terminal_id = %terminal_id,
                        lost_from,
                        lost_to,
                        resume_from,
                        "ws.restore.paced_expired"
                    );
                    session.page_end = resume_from;
                }
                PacedTailCompletion::GapCompleted {
                    lost_from,
                    lost_to,
                    end_seq,
                    serialized_bytes: _,
                } => {
                    // THE plan:146 BOUNDED-BASELINE EXIT (mid-handoff
                    // retention overrun): the registry already sank the
                    // exact bounds-carrying gap (ordered ahead of the
                    // swept retained window) and CLEARED the deferral in
                    // the same hold — the session COMPLETES AT THE RING
                    // FRONT with the gap recorded; the paged handoff never
                    // resumes toward the unreachable boundary, and the
                    // client's bounded baseline recovery owns the post-gap
                    // state.
                    tracing::info!(
                        terminal_id = %terminal_id,
                        attach_request_id = %attach_request_id,
                        lost_from,
                        lost_to,
                        last_seq = end_seq,
                        pages = session.pages + 1,
                        "ws.restore.paced_expired"
                    );
                    session.page_end = session.page_end.max(end_seq);
                    session.pages += 1;
                    tracing::info!(
                        terminal_id = %terminal_id,
                        attach_request_id = %attach_request_id,
                        last_seq = session.page_end,
                        pages = session.pages,
                        "ws.restore.paced_complete"
                    );
                    return;
                }
                PacedTailCompletion::CaughtUp => {
                    // The ring drained at or below the cursor (a quiet or
                    // slower terminal): the registry's atomic clear already
                    // fired inside the page read.
                    tracing::info!(
                        terminal_id = %terminal_id,
                        attach_request_id = %attach_request_id,
                        last_seq = session.page_end,
                        pages = session.pages,
                        "ws.restore.paced_complete"
                    );
                    return;
                }
                PacedTailCompletion::Completed { end_seq, .. } => {
                    // The completing hold: the chunk covered the FIXED
                    // boundary B, everything staged past it flowed through
                    // the normal live fan-out path in the same hold, and
                    // the deferral cleared atomically with that delivery.
                    session.page_end = session.page_end.max(end_seq);
                    session.pages += 1;
                    tracing::info!(
                        terminal_id = %terminal_id,
                        attach_request_id = %attach_request_id,
                        last_seq = session.page_end,
                        pages = session.pages,
                        "ws.restore.paced_complete"
                    );
                    return;
                }
                PacedTailCompletion::Gone => {
                    tracing::warn!(
                        terminal_id = %terminal_id,
                        attach_request_id = %attach_request_id,
                        "ws.restore.paced_gone"
                    );
                    return;
                }
            }
        }
    });
}

/// Begin one negotiated session after a paced attach: sink the first page
/// (produced under the attach lock; sunk now that it is released), emit
/// `ws.restore.paced_start`, and — when the first page already reached the
/// target — hand the session straight to the spawned drain (an attach with
/// a short or empty replay drains to completion without ever needing a
/// credit, still OFF the dispatcher). A first page that is a bounded
/// prefix leaves the session ACTIVE with exactly ONE outstanding page:
/// the next page is produced on the first credit, never before.
#[allow(clippy::too_many_arguments)]
pub(crate) fn start_session(
    registry: &TerminalRegistry,
    conn_id: u64,
    sink: &FrameSink,
    sessions: &mut PacedSessions,
    start: freshell_terminal::PacedAttachStart,
    requested_since_seq: i64,
    max_replay_bytes: Option<i64>,
    writer: crate::terminal::WsSink,
    cancel: tokio::sync::watch::Receiver<bool>,
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
            DriveOutcome::Active => {
                // The replay phase still has window left (the drive cannot
                // return Active from a covered target — the safe arm keeps
                // the session credited-phase-active).
                sessions.insert(session);
            }
            DriveOutcome::DrainReady => {
                spawn_paced_drain(
                    registry.clone(),
                    conn_id,
                    writer,
                    Arc::clone(sink),
                    session,
                    registry.paced_page_max_bytes(),
                    cancel,
                );
            }
            DriveOutcome::Gone => {}
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
    fn partial_page_credit_grants_nothing_until_the_page_end() {
        let mut session = session_fixture();
        // A mid-page consumption report is honest progress, but the prior
        // batch is not fully consumed: the plan's credit rule ("Credit is
        // granted only after the prior batch is consumed in order") means
        // it must NOT produce the next page — at most ONE unacknowledged
        // page may exist per (connection, terminal).
        assert_eq!(
            validate_credit(&mut session, &credit("arid-1", 30)),
            CreditVerdict::PartialConsumption
        );
        assert_eq!(session.credited, 10, "a partial credit advances nothing");
        assert_eq!(session.page_end, 50, "a partial credit grants no page");
        // Repeated partial reports (coalesced client ticks) stay inert.
        assert_eq!(
            validate_credit(&mut session, &credit("arid-1", 40)),
            CreditVerdict::PartialConsumption
        );
        assert_eq!(session.credited, 10);
        // The page-end value is the grant.
        assert_eq!(
            validate_credit(&mut session, &credit("arid-1", 50)),
            CreditVerdict::Accepted
        );
        assert_eq!(session.credited, 50);
        // The same value cannot grant twice (the double-grant guard).
        assert_eq!(
            validate_credit(&mut session, &credit("arid-1", 50)),
            CreditVerdict::BeyondWindow
        );
        assert_eq!(session.credited, 50);
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
