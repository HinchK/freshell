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
//! E2R3 (the third sharpening of the natural-exit transition): the
//! session's PHASE-TRANSITION decision — "extend the credited phase
//! with a staged exit" vs "transfer to the uncredited tail drain" vs
//! "arm at session start" — is ATOMIC with respect to exit staging.
//! [`TerminalRegistry::paced_exit_transition`] reads the staged-exit
//! state and the frozen head under ONE registry lock hold and returns
//! the decision; every drive site applies it idempotently. The
//! load-bearing site is [`settle_exit_transition`], the POST-DRIVE
//! disposition that commits extend-vs-transfer: an exit staged during
//! the drive — after the pre-arm's read, inside the pre-fix
//! check-then-act window — is absorbed by the disposition's own atomic
//! read, the credited phase extends, and terminal.exit rides the
//! credit acknowledging the page that reaches the frozen head. An exit
//! staged strictly after the disposition's transfer confirmation is
//! the drain's documented uncredited tail content: the atomicity
//! boundary is exactly the transfer decision.
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
    /// The session's page budget (round-2 finding F3): the clamped
    /// effective bound (`min(requested replayPageBytes, registry cap)`)
    /// recorded at attach — credits, the tail drain, and the exit drain
    /// all page at this SAME bound; nothing re-reads the registry cap.
    pub page_budget: i64,
    /// E2R1 finding 1: when the terminal EXITS NATURALLY while this
    /// session is still in its credited phase, the registry STAGES the
    /// exit on the subscriber and the credited phase extends ONCE
    /// through the terminal's final head — captured at the staging (the
    /// head is frozen by the exit; there is no moving-head chase). The
    /// deferred final output then pages ONLY on the client's
    /// continuation credits, and the session's completing verdict (the
    /// drain's CaughtUp hold) delivers the staged exit after the last
    /// page. `None` while the terminal lives: the ordinary fixed-target
    /// semantics (frames past the target are tail delivery).
    pub exit_head: Option<i64>,
    /// Pages produced so far (observability).
    pub pages: u64,
}

impl PacedSession {
    /// The credited phase's paging target: the fixed attach-time head,
    /// extended once through the terminal's final head when a staged
    /// exit armed the extension.
    pub(crate) fn phase_target(&self) -> i64 {
        match self.exit_head {
            Some(exit_head) => self.target.max(exit_head),
            None => self.target,
        }
    }

    /// Arm the staged-exit extension (idempotent, monotone): the
    /// terminal's final head becomes part of the credited phase's
    /// paging target, so the deferred final output pages only on
    /// credits.
    pub(crate) fn arm_staged_exit(&mut self, exit_head: i64) {
        self.exit_head = Some(match self.exit_head {
            Some(armed) => armed.max(exit_head),
            None => exit_head,
        });
    }

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
            page_budget: desc.page_budget,
            exit_head: None,
            pages: u64::from(started),
        }
    }
}

/// E2R2 finding (the exit-arming race), invariant 1 — the PRE-ARM:
/// arming always precedes driving, at every drive site (the credit
/// path, the attach start, and the notify arm), so the drive pages
/// toward the extended phase target immediately. The registry is the
/// authority for a staged natural exit: the staging happens under the
/// terminal lock BEFORE the connection's notify hook fires, so this
/// query observes it regardless of the notify's dispatch order.
///
/// E2R3: the arm reads the transition decision under ONE registry
/// lock hold ([`TerminalRegistry::paced_exit_transition`] — the staged
/// exit and the frozen head together); the pre-fix shape read them in
/// two separate holds. The arm is a HINT, never a transition
/// commitment: it only ever EXTENDS the session (monotone, idempotent),
/// and the disposition ([`settle_exit_transition`]) re-decides
/// atomically after the drive — so an exit this read missed because it
/// staged inside the credit's window is absorbed by the disposition's
/// own read. Because the arm precedes the drive, an arm that extends
/// the phase target beyond the credited cursor is always followed by a
/// drive that produces the next page: no state can exist where the
/// target exceeds the credited cursor and no page was just emitted
/// (the pre-fix drive-then-arm ordering kept such sessions with
/// nothing outstanding, permanently wedging the final output and
/// terminal.exit — nothing outstanding means no credit can ever
/// come).
///
/// Returns `true` when THIS call armed (observability).
pub(crate) fn arm_staged_exit_from_registry(
    registry: &TerminalRegistry,
    conn_id: u64,
    session: &mut PacedSession,
) -> bool {
    if session.exit_head.is_some() {
        // Already armed — the notify, the start, or an earlier arm won
        // the race; the frozen head never moves and a second arm is
        // inert.
        return false;
    }
    let Some(exit_head) = registry
        .paced_exit_transition(&session.terminal_id, conn_id)
        .exit_head
    else {
        return false;
    };
    session.arm_staged_exit(exit_head);
    tracing::info!(
        terminal_id = %session.terminal_id,
        attach_request_id = %session.attach_request_id,
        exit_head,
        "ws.restore.paced_exit_armed"
    );
    true
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
    /// The credit carries the current attach generation but the WRONG
    /// stream id (round-2 finding F4): stream identity is part of the
    /// continuation contract, so this is not the session's credit. A
    /// distinct verdict from the stale generation — the generation is
    /// current; the STREAM is foreign.
    StreamMismatch,
    BeyondWindow,
    NonNegotiated,
}

impl CreditVerdict {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::PartialConsumption => "partial_consumption",
            Self::StaleGeneration => "stale_generation",
            Self::StreamMismatch => "stream_mismatch",
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
    // Round-2 finding F4: stream identity is a required part of the
    // continuation contract — a credit whose stream id does not match the
    // session's stream belongs to a different stream's story, not this
    // session, and must never page for it (no grant, wire shape unchanged).
    if session.stream_id != credit.stream_id {
        return CreditVerdict::StreamMismatch;
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
///
/// E2R1 finding 1: the replay phase pages toward the session's PHASE
/// TARGET — the fixed attach-time head, extended once through the
/// terminal's final head when a natural exit staged behind the
/// still-armed session (see [`PacedSession::exit_head`]). The deferred
/// final output therefore pages ONLY on the client's continuation
/// credits, and the exit sequences behind the session's credited
/// completion.
pub(crate) fn drive_session(
    registry: &TerminalRegistry,
    conn_id: u64,
    sink: &FrameSink,
    session: &mut PacedSession,
    budget: i64,
) -> DriveOutcome {
    // Replay phase: page (page_end, ...] toward the phase target.
    let phase_target = session.phase_target();
    if session.page_end < phase_target {
        loop {
            match registry.next_replay_page(
                &session.terminal_id,
                conn_id,
                session.page_end,
                phase_target,
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
                    if session.page_end < phase_target {
                        return DriveOutcome::Active;
                    }
                    break; // cursor reached the phase target -> tail
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

/// E2R3 — the disposition a drive site commits from the ATOMIC
/// transition decision (see [`settle_exit_transition`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TransitionDisposition {
    /// Keep the session in the credited phase: a page is outstanding, or
    /// the extended phase still has window left to page on the client's
    /// continuation credits.
    Stay,
    /// Hand the session to the uncredited tail drain
    /// ([`spawn_paced_drain`]) — the atomic decision confirmed no
    /// staged exit, or the armed exit head is fully acknowledged (the
    /// drain's completing verdict delivers the staged exit after
    /// everything the client already acknowledged).
    Transfer,
    /// The terminal (or the connection's subscriber) disappeared —
    /// cancel the session; the registry has no deferral left to clear.
    Gone,
}

/// E2R3 — THE ATOMIC TRANSITION DISPOSITION. The phase-transition
/// decision — "extend the credited phase with a staged exit" vs
/// "transfer to the uncredited tail drain" — is committed HERE, from
/// ONE registry lock hold
/// ([`TerminalRegistry::paced_exit_transition`]: the staged-exit state
/// and the frozen head read together) AFTER the drive produced its
/// pages.
///
/// THE LOCK-SCOPE MAP (decided under the lock vs applied after):
/// - UNDER the decision's hold: the staged-exit state and the frozen
///   head are read, and the decision value — extend, or the
///   atomically-confirmed absence of a staged exit — leaves the lock
///   WITH the read. No window exists in which a concurrently staged
///   exit can change which transition is correct.
/// - AFTER the hold (idempotent application, safe against concurrent
///   staging: an armed head is FROZEN by the exit, and the unarmed
///   transfer's boundary IS the decision): the session arms, the
///   wedge-guard may emit the extended phase's next page, the session
///   stays in the table, or it moves to the spawned drain. The
///   terminal lock is never held across the application — pages are
///   built under the drive's own per-page holds and sunk outside them,
///   exactly as before.
///
/// WHY THE DECISION SITS AFTER THE DRIVE: the disposition must be
/// settled from state that accounts for the drive's own pages, and
/// the staging that matters is whatever happened-before THIS
/// decision's hold — including an exit staged DURING the drive, after
/// the pre-arm's read (the pre-fix check-then-act window: the arm read
/// "no exit", the drive ran, the exit staged, and the disposition then
/// decided from the stale read and transferred the session to the
/// drain, which dumped the remaining suffix and delivered
/// terminal.exit without the acknowledging credit). An exit staged
/// before the hold is absorbed here: the phase extends and the exit
/// rides the credit acknowledging the page reaching the frozen head.
/// An exit staged strictly after the hold is post-decision — at the
/// transfer site it is the drain's documented uncredited tail content.
/// The atomicity boundary is exactly this decision.
///
/// The armed dispositions, in drive-site order:
/// - `Gone` from the drive: the registry owns the teardown — cancel.
/// - an uncredited page outstanding (`credited < page_end`): STAY —
///   including the page that just reached the armed exit head; the
///   removal rides the credit that acknowledges it (E2R2 invariant
///   2), and the next credit's drive pages toward the extended target.
/// - all-acknowledged cursor with the armed head AHEAD
///   (`credited == page_end < exit_head`): THE WEDGE GUARD — the
///   extension outgrew everything outstanding, so the drive MUST
///   produce the extended phase's next page NOW (no state may exist
///   where the target exceeds the credited cursor and no page is
///   outstanding — nothing outstanding means no credit can ever come;
///   the guard emits at most the ONE page every drive site emits per
///   credit).
/// - armed, all acknowledged, head covered
///   (`credited == page_end >= exit_head`): TRANSFER — the spawned
///   drain's CaughtUp hold delivers the staged exit after everything
///   the client already acknowledged; the acknowledging credit is the
///   one being processed, so the exit rides it.
///
/// The unarmed disposition is the drive's own outcome — the ordinary
/// semantics, byte-identical to the pre-E2R3 dispatch (Active → stay,
/// DrainReady → transfer, Gone → cancel) — and the atomically
/// confirmed no-staged-exit is what makes the transfer safe: no
/// happened-before staging was missed.
pub(crate) fn settle_exit_transition(
    registry: &TerminalRegistry,
    conn_id: u64,
    sink: &FrameSink,
    session: &mut PacedSession,
    drive_outcome: DriveOutcome,
) -> TransitionDisposition {
    let transition = registry.paced_exit_transition(&session.terminal_id, conn_id);
    let Some(exit_head) = transition.exit_head else {
        // (b) No exit staged — atomically confirmed under the
        // decision's lock hold. Any staging after this hold is
        // post-transfer tail content (the drain's documented
        // uncredited semantics).
        return match drive_outcome {
            DriveOutcome::Active => TransitionDisposition::Stay,
            DriveOutcome::DrainReady => TransitionDisposition::Transfer,
            DriveOutcome::Gone => TransitionDisposition::Gone,
        };
    };
    // (a) A staged exit is visible UNDER THIS HOLD: the credited phase
    // extends through the frozen head — idempotent, monotone.
    session.arm_staged_exit(exit_head);
    if drive_outcome == DriveOutcome::Gone {
        return TransitionDisposition::Gone;
    }
    if session.credited < session.page_end {
        // An uncredited page is outstanding — including the page that
        // just reached the armed exit head: the exit rides the credit
        // that acknowledges it, never the drive that emitted it.
        return TransitionDisposition::Stay;
    }
    if session.page_end < exit_head {
        // THE WEDGE GUARD: the extension outgrew an all-acknowledged
        // cursor — the drive must produce the extended phase's next
        // page now.
        return match drive_session(registry, conn_id, sink, session, session.page_budget) {
            DriveOutcome::Active => TransitionDisposition::Stay,
            DriveOutcome::DrainReady if session.credited < session.page_end => {
                TransitionDisposition::Stay
            }
            DriveOutcome::DrainReady => TransitionDisposition::Transfer,
            DriveOutcome::Gone => TransitionDisposition::Gone,
        };
    }
    // Armed, everything emitted is acknowledged, and the frozen head
    // is covered: the spawned drain's CaughtUp hold delivers the
    // staged exit now, after everything the client already
    // acknowledged — the acknowledging credit is the one being
    // processed, so the exit rides it.
    TransitionDisposition::Transfer
}

/// The drain's per-iteration admission reservation (E2R1 finding 2b):
/// the reservation must account what the drain can actually admit. A
/// page packs within the session's budget, but the page builder always
/// includes the window's FIRST frame even when it alone exceeds the
/// budget — the ATOMIC single-frame page — so a sub-cap budget (a
/// client's small `replayPageBytes` request) can still admit a page up
/// to the fragment-cap ceiling. Reserving only the requested budget let
/// concurrent pane drains each be granted against the same
/// just-under-watermark backlog and each admit a full atomic page on
/// top of it, overbooking the admission gate and self-spilling the
/// connection's own queued pages. The reservation is therefore
/// max(session budget, the atomic page ceiling); a budget at-or-above
/// the ceiling (every supported default) reserves exactly the budget,
/// byte-identical to the pre-fix behavior.
pub(crate) fn drain_admission_bytes(page_budget: i64) -> usize {
    let atomic_ceiling = freshell_terminal::paced_atomic_page_serialized_ceiling() as i64;
    page_budget.max(atomic_ceiling).max(0) as usize
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
        // handoff chunk reserves its admission bytes under the connection
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
        // admits into a fully drained queue). E2R1 finding 2b: the
        // reserved bytes are [`drain_admission_bytes`] — max(budget, the
        // atomic page ceiling) — because a sub-cap budget can still admit
        // the builder's atomic single-frame page, and a reservation of
        // only the requested bytes under-books exactly that page.
        let admission_bytes = drain_admission_bytes(budget);
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
                    reason,
                } => {
                    // THE plan:146 BOUNDED-BASELINE EXIT (mid-handoff
                    // retention overrun): the registry already sank the
                    // exact bounds-carrying gap (ordered ahead of the
                    // swept retained window) and CLEARED the deferral in
                    // the same hold — the session COMPLETES AT THE RING
                    // FRONT with the gap recorded; the paged handoff never
                    // resumes toward the unreachable boundary, and the
                    // client's bounded baseline recovery owns the post-gap
                    // state. Round-5 finding 3: the event carries the
                    // MANDATORY gap-exit reason so production diagnostics
                    // distinguish a genuine unfetchable retention overrun
                    // (`retention_overrun`) from the ordinary fetchable
                    // fixed-boundary residual exit
                    // (`handoff_boundary_residual`).
                    tracing::info!(
                        terminal_id = %terminal_id,
                        attach_request_id = %attach_request_id,
                        reason = reason.as_str(),
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
/// `ws.restore.paced_start`, and settle the start's phase transition —
/// ATOMICALLY with respect to exit staging (E2R3). The start's arm
/// reads the transition decision under ONE registry lock hold, so an
/// exit staged during the attach is seen in the SAME decision; when the
/// arm extends an all-acknowledged cursor (the empty-first-page state),
/// the start's drive settles the disposition through
/// [`settle_exit_transition`]: the extended phase's first page is
/// produced NOW (the wedge guard), and the session stays credited-phase
/// active. When the first page already covered the target and nothing
/// is staged, the session hands straight to the spawned drain (a short
/// or empty replay drains to completion without ever needing a credit,
/// still OFF the dispatcher). A first page that is a bounded prefix
/// leaves the session ACTIVE with exactly ONE outstanding page: the
/// next page is produced on the first credit, never before.
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
        page_budget = session.page_budget,
        page_bytes,
        max_replay_bytes = ?max_replay_bytes,
        "ws.restore.paced_start"
    );
    // E2R3: the start's ATOMIC arm/decide — ONE registry lock hold
    // reads the staged-exit state; an exit staged during the attach is
    // seen HERE, in the same decision (the notify arm and the first
    // credit's disposition are later, also-atomic re-decisions).
    // Arming precedes every branch below, so no branch can hand an
    // armed session to the uncredited drain by accident of ordering.
    arm_staged_exit_from_registry(registry, conn_id, &mut session);
    if session.page_end < session.phase_target() && session.credited < session.page_end {
        // A bounded first page is outstanding: the credited phase
        // continues on the client's credits — no transition is
        // committed at start (the next drive site's disposition is
        // atomic).
        sessions.insert(session);
        return;
    }
    // The target is covered (with any extension), or the arm extended
    // an all-acknowledged cursor with the frozen head ahead (the
    // wedge-guard state: the drive MUST produce the extended phase's
    // next page now). Either way the disposition is settled from the
    // ATOMIC decision after the drive.
    let budget = session.page_budget;
    let outcome = drive_session(registry, conn_id, sink, &mut session, budget);
    match settle_exit_transition(registry, conn_id, sink, &mut session, outcome) {
        TransitionDisposition::Stay => {
            sessions.insert(session);
        }
        TransitionDisposition::Transfer => {
            spawn_paced_drain(
                registry.clone(),
                conn_id,
                writer,
                Arc::clone(sink),
                session,
                budget,
                cancel,
            );
        }
        TransitionDisposition::Gone => {}
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
            page_budget: 4096,
            exit_head: None,
            pages: 1,
        }
    }

    #[test]
    fn staged_exit_extends_the_credited_phase_once_and_monotonically() {
        // E2R1 finding 1: a natural exit behind a still-credited session
        // extends the credited phase's paging target ONCE through the
        // terminal's final head — the deferred final output pages only
        // on credits. The extension is idempotent and monotone (a credit
        // that raced ahead of the notify must not shrink or duplicate
        // it), and while no exit is staged the phase target stays the
        // ordinary fixed attach-time head.
        let mut session = session_fixture();
        assert_eq!(
            session.phase_target(),
            100,
            "no staged exit: the phase target is the fixed attach-time head"
        );
        session.arm_staged_exit(140);
        assert_eq!(
            session.phase_target(),
            140,
            "the staged exit extends the phase target to the terminal's final head"
        );
        session.arm_staged_exit(120);
        assert_eq!(
            session.phase_target(),
            140,
            "a stale re-arm never shrinks the extension (monotone)"
        );
        session.arm_staged_exit(160);
        assert_eq!(
            session.phase_target(),
            160,
            "only the terminal's frozen head moves it — and it is frozen by death"
        );
    }

    fn credit(arid: &str, consumed_seq: i64) -> TerminalReplayCredit {
        credit_with_stream("S", arid, consumed_seq)
    }

    fn credit_with_stream(stream_id: &str, arid: &str, consumed_seq: i64) -> TerminalReplayCredit {
        TerminalReplayCredit {
            terminal_id: "T".into(),
            stream_id: stream_id.into(),
            attach_request_id: arid.into(),
            consumed_seq,
        }
    }

    #[test]
    fn drain_admission_never_under_reserves_for_an_atomic_page() {
        // E2R1 finding 2(b): a sub-cap page budget can still admit the
        // page builder's ATOMIC single-frame result (a frame larger than
        // the request forms its own page, bounded by the fragment-cap
        // ceiling), so the reservation must cover that ceiling —
        // reserving only the request under-books the admission gate for
        // exactly the pages that exceed it, and concurrent drains then
        // overbook the gate (the ws sub-cap canary's queue_overflow RED).
        let ceiling = freshell_terminal::paced_atomic_page_serialized_ceiling() as i64;
        assert!(
            drain_admission_bytes(2048) >= ceiling as usize,
            "a sub-cap budget reserves at least the atomic page ceiling \
             (got {})",
            drain_admission_bytes(2048)
        );
        assert_eq!(
            drain_admission_bytes(128 * 1024),
            128 * 1024,
            "a budget at-or-above the ceiling reserves the budget (the supported default)"
        );
        assert_eq!(
            drain_admission_bytes(ceiling),
            ceiling as usize,
            "at the ceiling the reservation is the ceiling"
        );
        assert_eq!(
            drain_admission_bytes(0),
            ceiling as usize,
            "a degenerate zero budget still reserves the atomic ceiling \
             (its pages are single frames, each bounded by the ceiling)"
        );
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
    fn wrong_stream_credit_with_the_current_generation_grants_nothing() {
        // Round-2 finding F4: the continuation contract keys on stream
        // identity as well as the attach generation — a credit carrying the
        // CURRENT attachRequestId but the WRONG stream id is not this
        // session's credit and must grant nothing (the stale-generation
        // guard is otherwise incomplete: the arid matches, so without this
        // check the credit would page for a session it does not belong to).
        let mut session = session_fixture();
        assert_eq!(
            validate_credit(
                &mut session,
                &credit_with_stream("OTHER-STREAM", "arid-1", 50)
            ),
            CreditVerdict::StreamMismatch
        );
        assert_eq!(session.credited, 10, "a wrong-stream credit grants nothing");
        // The matching-stream credit still grants after the ignored one.
        assert_eq!(
            validate_credit(&mut session, &credit("arid-1", 50)),
            CreditVerdict::Accepted
        );
        assert_eq!(session.credited, 50);
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
            page_budget: 4096,
            page_bytes: 123,
        };
        let session = PacedSession::from_desc(desc);
        assert_eq!(session.credited, 3, "crediting starts at the baseline");
        assert_eq!(session.page_end, 7);
        assert_eq!(
            session.page_budget, 4096,
            "the session carries the attach's effective page budget"
        );
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
                page_budget: 4096,
                page_bytes: 0,
            }
        };
        assert_eq!(PacedSession::from_desc(empty).pages, 0);
    }
}
