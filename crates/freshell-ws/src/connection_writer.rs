//! One socket writer, independent of command dispatch. No socket I/O is awaited
//! by a handler. Readiness/mode preludes and output are admitted under ONE lock,
//! preventing a replay frame from racing ahead of its prelude. Output remains
//! FIFO within each terminal (including terminal.exit), with explicit overflow
//! gaps. Cross-terminal scheduling uses focused/visible/background byte fairness
//! (connection-local presentation interest; scheduling never edits terminal
//! bytes and never attaches, resizes, spawns, or kills execution).
//!
//! Each write leases only ONE queued frame. Output already handed to the socket
//! is still included in pressure accounting until its flush finishes. Cancelling
//! an in-progress send always terminates the socket; the started frame is NEVER
//! retried on that socket (SinkExt::send is not assumed cancellation-safe) — a
//! stop carrying a close code first lets that one started frame finish
//! (bounded), then attempts a whole Close frame, never a mixed byte stream.

use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message};
use freshell_protocol::ServerMessage;
#[path = "terminal_delivery_queue.rs"]
mod delivery;
#[path = "terminal_interest.rs"]
mod terminal_interest;
use delivery::{Delivery, DeliveryQueue, EvictedOutput, Range};
use freshell_terminal::output_queue::output_frame_meta;
use futures_util::{Sink, SinkExt};
use terminal_interest::InterestState;
use tokio::sync::{oneshot, watch, Notify};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WriterExit {
    Stopped,
    SendFailed,
    SendTimedOut,
    ControlOverflow,
    SerializationFailed,
    OutputCapacityExceeded,
}

impl WriterExit {
    pub(super) fn reason(self) -> &'static str {
        match self {
            Self::Stopped => "writer_stopped",
            Self::SendFailed => "send_error",
            Self::SendTimedOut => "writer_stalled",
            Self::ControlOverflow => "control_backpressure",
            Self::SerializationFailed => "serialization_error",
            Self::OutputCapacityExceeded => "output_capacity_exceeded",
        }
    }

    pub(super) fn close_code(self) -> Option<u16> {
        match self {
            Self::SendTimedOut | Self::ControlOverflow | Self::OutputCapacityExceeded => Some(4008),
            Self::SerializationFailed => Some(1011),
            _ => None,
        }
    }
}

#[derive(Clone)]
struct Stop {
    exit: WriterExit,
    close: Option<(u16, String)>,
}

struct Control {
    frame: Message,
    bytes: usize,
    /// Admission stamp (per-connection, strictly increasing under the queue
    /// lock): decides whether an output frame may leapfrog this control.
    seq: u64,
    /// Keepalive observes the ping's flush receipt for liveness bookkeeping
    /// (pump-gone fast detection) — deadlines are tick-counted, not timed.
    flushed: Option<oneshot::Sender<()>>,
}

/// Consecutive control leases after which a pending output frame MAY be
/// leased instead of the next control — but ONLY if that output frame was
/// admitted before the oldest pending control (its admission stamp is
/// lower). Controls normally preempt (they are how the reader's answers and
/// liveness traffic jump a backlog), and ordering-bound admissions (an
/// attach's `attach.ready`/`modes.sync` prelude vs. its replay, pushed in
/// that order under one lock) must never be reordered: the stamp check keeps
/// leapfrogging restricted to strictly-older output. An unbounded control
/// stream therefore cannot starve old output all the way to the
/// catastrophic monitor, while a prelude is never overtaken by its newer
/// replay.
const CONTROL_STREAK_LIMIT: usize = 8;

/// Minimum spacing between `ws.terminal_stream.queue_overflow_spill` events
/// per connection (responsive-terminal-restore Workstream 3 observability).
/// Under sustained eviction a single admission can evict many frames —
/// hundreds of evictions per second under incident-scale pressure — so
/// per-eviction events would flood the log; evictions inside the window are
/// folded into the next event's `suppressed` count. Identifiers and
/// measurements only.
const SPILL_EVENT_MIN_INTERVAL: Duration = Duration::from_secs(5);

/// One rate-limited spill (queue-overflow eviction) observability event.
struct SpillEvent {
    terminal_id: String,
    stream_id: String,
    from_seq: i64,
    to_seq: i64,
    suppressed: u64,
    pending_bytes: usize,
}

struct Queues {
    output: DeliveryQueue<Message>,
    interest: InterestState,
    controls: VecDeque<Control>,
    // Includes a control frame currently being flushed, not just queued frames.
    control_bytes: usize,
    in_flight_output_bytes: usize,
    /// Consecutive control frames leased since the last output frame. See
    /// `CONTROL_STREAK_LIMIT`.
    controls_since_last_output: usize,
    /// Next admission stamp. Under the same lock as the queues, so stamps
    /// are strictly increasing in true admission order.
    next_seq: u64,
    closed: bool,
    /// Successful socket sends completed on this connection (drain-progress
    /// liveness, responsive-terminal-restore Workstream 3): incremented by
    /// `finish_frame` for every frame whose send resolved Ok — output and
    /// control alike, since the pump serializes all sends. Eviction and
    /// superseded attachments reduce queued bytes WITHOUT touching this.
    completed_sends: u64,
    /// Rate-limited spill-event bookkeeping (see
    /// [`SPILL_EVENT_MIN_INTERVAL`]): when the last
    /// `ws.terminal_stream.queue_overflow_spill` event was emitted, and how
    /// many evictions have been folded into the next one since. Evictions
    /// are counted at ADMISSION time (task-007 review M2); leasing the
    /// coalesced gap later is delivery, not a spill occurrence.
    spill_last_logged: Option<std::time::Instant>,
    spill_suppressed: u64,
}

impl Queues {
    /// Rate-limited spill-event bookkeeping (task-007 review M2, landed by
    /// task-010): returns `Some` when an event should be emitted NOW (this
    /// eviction's range plus the count of evictions suppressed since the
    /// previous event), `None` when this eviction is folded into a future
    /// event. Called under the admission lock at EVICTION time — the moment
    /// the spill happens — so a connection that dies while backlogged (its
    /// coalesced gap never leased to the socket) still leaves spill evidence
    /// in the live log.
    fn note_spill(&mut self, terminal_id: &str, range: &Range) -> Option<SpillEvent> {
        let now = std::time::Instant::now();
        let due = self
            .spill_last_logged
            .is_none_or(|last| now.duration_since(last) >= SPILL_EVENT_MIN_INTERVAL);
        if !due {
            self.spill_suppressed = self.spill_suppressed.saturating_add(1);
            return None;
        }
        let suppressed = self.spill_suppressed;
        self.spill_suppressed = 0;
        self.spill_last_logged = Some(now);
        Some(SpillEvent {
            terminal_id: terminal_id.to_string(),
            stream_id: range.stream_id.clone(),
            from_seq: range.from_seq,
            to_seq: range.to_seq,
            suppressed,
            pending_bytes: self
                .output
                .pending_bytes()
                .saturating_add(self.in_flight_output_bytes),
        })
    }

    /// Map the delivery queue's admission-time eviction records through the
    /// per-connection rate limiter (task-007 review M2). Call under the
    /// admission lock immediately after `push`; emit the returned events only
    /// AFTER the lock is dropped (never hold the admission lock across a log
    /// write).
    fn take_admission_spills(&mut self, evicted: Vec<EvictedOutput>) -> Vec<SpillEvent> {
        evicted
            .into_iter()
            .filter_map(|evicted| self.note_spill(&evicted.terminal_id, &evicted.range))
            .collect()
    }
}

/// Emission-time resolver for one terminal's current restore-contract
/// replay-retention bounds (responsive-terminal-restore): installed ONLY on
/// connections whose `hello` negotiated `pacedTerminalReplayV1`, backed by
/// the registry's [`freshell_terminal::TerminalRegistry::replay_bounds`].
/// Generic over the registry so the writer's unit tests can drive the pump
/// deterministically without a PTY.
type GapBoundsSource = Arc<dyn Fn(&str) -> Option<freshell_terminal::ReplayBounds> + Send + Sync>;

struct Shared {
    queues: Mutex<Queues>,
    output_limit: usize,
    control_limit: usize,
    ready: Notify,
    stop: watch::Sender<Option<Stop>>,
    /// Restore-contract bounds for materialized `terminal.output.gap`
    /// frames: set ONLY on negotiated connections, ONCE, by the connection
    /// setup BEFORE the pump is spawned (the same pre-spawn setup rule as
    /// `enable_terminal_interest`) — a gap can never be leased before the
    /// source exists. Unset keeps gap frames byte-identical to the
    /// pre-capability wire shape.
    gap_bounds: std::sync::OnceLock<GapBoundsSource>,
}

/// A nonblocking, bounded outbox. Its Sink flush means "accepted by this
/// connection's outbox", NOT "written to the network". Only WriterPump owns
/// the actual socket. Reader supervision observes that pump's result.
#[derive(Clone)]
pub(crate) struct WriterSender {
    shared: Arc<Shared>,
}

pub(super) struct WriterPump {
    shared: Arc<Shared>,
    stop: watch::Receiver<Option<Stop>>,
    write_timeout: Duration,
}

struct NextFrame {
    /// Wire-ready frame. Gap deliveries are materialized into a
    /// `terminal.output.gap` message at lease time.
    frame: Message,
    output_bytes: usize,
    control_bytes: usize,
    flushed: Option<oneshot::Sender<()>>,
}

impl WriterSender {
    pub(super) fn new(
        output_limit: usize,
        control_limit: usize,
        write_timeout: Duration,
    ) -> (Self, WriterPump) {
        let (stop_tx, stop_rx) = watch::channel(None);
        let shared = Arc::new(Shared {
            queues: Mutex::new(Queues {
                output: DeliveryQueue::new(output_limit, metadata_limit(output_limit)),
                interest: InterestState::default(),
                controls: VecDeque::new(),
                control_bytes: 0,
                in_flight_output_bytes: 0,
                controls_since_last_output: 0,
                next_seq: 0,
                closed: false,
                completed_sends: 0,
                spill_last_logged: None,
                spill_suppressed: 0,
            }),
            output_limit: output_limit.max(1),
            control_limit: control_limit.max(1),
            ready: Notify::new(),
            stop: stop_tx,
            gap_bounds: std::sync::OnceLock::new(),
        });
        (
            Self {
                shared: Arc::clone(&shared),
            },
            WriterPump {
                shared,
                stop: stop_rx,
                write_timeout,
            },
        )
    }

    fn stop(&self, stop: Stop) {
        let mut queues = self.shared.queues.lock().expect("writer queue lock");
        if queues.closed {
            return;
        }
        queues.closed = true;
        // Publish while holding the admission lock: no later producer can be
        // accepted between closure and publication of the stop reason.
        self.shared.stop.send_replace(Some(stop));
    }

    pub(super) fn stop_without_close(&self) {
        self.stop(Stop {
            exit: WriterExit::Stopped,
            close: None,
        });
    }

    fn fail(&self, exit: WriterExit) {
        self.stop(Stop {
            exit,
            close: exit
                .close_code()
                .map(|code| (code, exit.reason().to_string())),
        });
    }

    fn push_control(
        &self,
        frame: Message,
        flushed: Option<oneshot::Sender<()>>,
        supersedes_terminal: Option<&str>,
    ) -> Result<(), WriterExit> {
        if let Message::Close(close) = frame {
            self.stop(Stop {
                exit: WriterExit::Stopped,
                close: close.map(|close| (close.code, close.reason.to_string())),
            });
            return Ok(());
        }
        // Charge a fixed per-entry allowance as well: zero-byte pings must
        // not create a count-unbounded control queue. This is a memory budget.
        // Note the worst case adds to the output cap: one connection can hold
        // up to output_limit + control_limit bytes.
        let bytes = frame_bytes(&frame).saturating_add(128);
        let mut queues = self.shared.queues.lock().expect("writer queue lock");
        if queues.closed {
            return Err(WriterExit::Stopped);
        }
        let would_exceed = bytes
            > self
                .shared
                .control_limit
                .saturating_sub(queues.control_bytes);
        // Always admit ONE frame into an empty lane, even one larger than the
        // budget itself (a screenshot frame can legitimately exceed a small
        // configured budget): an oversize single control must not close an
        // otherwise-idle connection. CONTINUED flooding still overflows —
        // admission fails while any oversize frame remains in flight.
        if would_exceed && queues.control_bytes > 0 {
            drop(queues);
            self.fail(WriterExit::ControlOverflow);
            return Err(WriterExit::ControlOverflow);
        }
        if let Some(terminal_id) = supersedes_terminal {
            queues.output.discard_terminal(terminal_id);
        }
        queues.control_bytes += bytes;
        let seq = queues.next_seq;
        queues.next_seq += 1;
        queues.controls.push_back(Control {
            frame,
            bytes,
            seq,
            flushed,
        });
        drop(queues);
        self.shared.ready.notify_one();
        Ok(())
    }

    /// Registry/screenshot callbacks use this route rather than bypassing the
    /// outbox. Prelude insertion is complete before the producer appends replay.
    pub(super) fn push_server(&self, msg: ServerMessage) -> bool {
        let supersedes = match &msg {
            ServerMessage::TerminalAttachReady(ready) => Some(ready.terminal_id.clone()),
            _ => None,
        };
        let meta = output_frame_meta(&msg);
        let exit = matches!(&msg, ServerMessage::TerminalExit(_));
        // Serialized exactly once, at admission: the delivery queue stores wire
        // frames, because byte cost and class fairness are admission-time
        // properties and scheduling treats payloads as opaque. (This supersedes
        // the typed-message queue's lease-time serialization, which measured at
        // push and re-serialized at every lease.)
        let json = match serde_json::to_string(&msg) {
            Ok(json) => json,
            Err(_) => {
                self.fail(WriterExit::SerializationFailed);
                return false;
            }
        };
        // Restore contract: a directly pushed `terminal.output.gap` (the paced
        // replay core's retention gaps) joins the OUTPUT queue as a sequenced
        // control like `terminal.exit` — see the gap arm below.
        let sequenced_gap = matches!(&msg, ServerMessage::TerminalOutputGap(_));
        if meta.is_none() && !exit && !sequenced_gap {
            return self
                .push_control(Message::Text(json.into()), None, supersedes.as_deref())
                .is_ok();
        }
        let mut queues = self.shared.queues.lock().expect("writer queue lock");
        if queues.closed {
            return false;
        }
        let seq = queues.next_seq;
        queues.next_seq += 1;
        let bytes = json.len();
        // All three queued shapes below share one admission tail: the push,
        // the admission-time spill evidence, and the notify/fail mapping.
        // Spill observability (task-007 review M2, landed by task-010):
        // evictions surface HERE — the moment they happen — including on the
        // error path (a dying connection's evictions are exactly the
        // undercounted spills the review found), and the events are emitted
        // only after the admission lock is dropped.
        let pushed = if let Some(meta) = meta {
            let range = Range {
                stream_id: meta.stream_id,
                attach_request_id: meta.attach_request_id,
                from_seq: meta.seq_start,
                to_seq: meta.seq_end,
            };
            let priority = queues.interest.priority(&meta.terminal_id);
            queues.output.push(
                &meta.terminal_id,
                priority,
                Message::Text(json.into()),
                bytes,
                Some(range),
                seq,
            )
        } else if let ServerMessage::TerminalExit(exit) = &msg {
            // Preserve final-output -> exit. It must not use the control lane.
            let priority = queues.interest.priority(&exit.terminal_id);
            // Sequenced exits are zero-weight, exactly as legacy queued them:
            // they can never force an eviction nor close the connection, and
            // they still cost one service unit per frame (count-bounded by
            // the metadata limit).
            let pushed = queues.output.push(
                &exit.terminal_id,
                priority,
                Message::Text(json.into()),
                0,
                None,
                seq,
            );
            // A dead terminal never needs its attach fallback again.
            if pushed.is_ok() {
                queues.interest.detach(&exit.terminal_id);
            }
            pushed
        } else {
            // Restore contract (responsive-terminal-restore): a
            // `terminal.output.gap` pushed DIRECTLY by the paced replay core
            // (retention loss at attach / mid-replay expiry) is sequenced
            // WITH the terminal's output — exactly the `terminal.exit`
            // zero-weight non-evictable control treatment. The control lane
            // would preempt it AHEAD of already-admitted pages, breaking
            // per-terminal sequence order (the queue's own gap markers, by
            // contrast, materialize at lease time from eviction and never
            // pass through here).
            let ServerMessage::TerminalOutputGap(gap) = &msg else {
                unreachable!("meta-less output frames are exit or gap only")
            };
            let priority = queues.interest.priority(&gap.terminal_id);
            queues.output.push(
                &gap.terminal_id,
                priority,
                Message::Text(json.into()),
                0,
                None,
                seq,
            )
        };
        let evicted = queues.output.take_evictions();
        let spills = queues.take_admission_spills(evicted);
        drop(queues);
        Self::emit_spill_events(spills);
        match pushed {
            Ok(()) => {
                self.shared.ready.notify_one();
                true
            }
            Err(_) => {
                self.fail(WriterExit::OutputCapacityExceeded);
                false
            }
        }
    }

    /// Log the rate-limited spill events collected at admission time. Must
    /// be called with the admission lock NOT held.
    fn emit_spill_events(spills: Vec<SpillEvent>) {
        for spill in spills {
            tracing::warn!(
                terminal_id = %spill.terminal_id,
                stream_id = %spill.stream_id,
                from_seq = spill.from_seq,
                to_seq = spill.to_seq,
                suppressed = spill.suppressed,
                pending_bytes = spill.pending_bytes,
                "ws.terminal_stream.queue_overflow_spill"
            );
        }
    }

    pub(super) fn enable_terminal_interest(&self) {
        self.shared
            .queues
            .lock()
            .expect("writer queue lock")
            .interest
            .enable();
    }

    /// Hidden-pane lifetime claims (responsive-terminal-restore Workstream 1):
    /// arm the connection's `terminal.interest.claimedTerminalIds` handling.
    /// Called ONCE by the connection setup when the hello negotiated
    /// `terminalLifetimeClaimV1`; a connection that never negotiated keeps
    /// its snapshots' claim fields ignored server-side.
    pub(super) fn enable_terminal_lifetime_claims(&self) {
        self.shared
            .queues
            .lock()
            .expect("writer queue lock")
            .interest
            .enable_claims();
    }

    /// Restore contract (responsive-terminal-restore): install the
    /// negotiated-connection gap-bounds source. Called ONCE by the
    /// connection setup, BEFORE the writer pump is spawned (a gap can never
    /// be leased before the source exists). The source resolves a
    /// terminal's current `head_seq`/earliest-replayable position at
    /// gap-emission time; connections that never negotiated leave the
    /// source unset and their gap frames stay byte-identical to the
    /// pre-capability wire shape.
    pub(super) fn set_paced_replay_gap_bounds(&self, source: GapBoundsSource) {
        let _ = self.shared.gap_bounds.set(source);
    }

    /// Apply one full presentation-interest snapshot. A rejected snapshot is
    /// returned without replacing the last accepted state; scheduling changes
    /// are queued-data-only (no attach, resize, spawn, or kill). On
    /// acceptance, the negotiated claim-set diff is handed back to the
    /// dispatcher, which applies it to the terminal registry (the writer owns
    /// only the connection-local interest state).
    pub(super) fn set_terminal_interest(
        &self,
        snapshot: &freshell_protocol::client_messages::TerminalInterest,
    ) -> Result<Option<terminal_interest::InterestClaimChange>, &'static str> {
        let mut queues = self.shared.queues.lock().expect("writer queue lock");
        if queues.closed {
            return Err("Connection writer is closed");
        }
        if let Some(change) = queues.interest.apply(snapshot)? {
            let Queues {
                output, interest, ..
            } = &mut *queues;
            output.update_priorities(|id| interest.priority(id));
            drop(queues);
            self.shared.ready.notify_one();
            Ok(Some(change))
        } else {
            drop(queues);
            Ok(None)
        }
    }

    /// Pre-snapshot fallback: a client that never negotiated terminalInterestV1
    /// still gets its declared `terminal.attach.priority` honored.
    pub(super) fn set_attachment_priority(&self, terminal_id: &str, background: bool) {
        let mut queues = self.shared.queues.lock().expect("writer queue lock");
        if queues.closed {
            return;
        }
        queues.interest.attach(terminal_id, background);
        let Queues {
            output, interest, ..
        } = &mut *queues;
        output.update_priorities(|id| interest.priority(id));
    }

    /// Detach drops this connection's queued delivery AND its fallback
    /// attachment priority. The next attach sets its own fallback before its
    /// replay is admitted.
    pub(super) fn discard_terminal_delivery(&self, terminal_id: &str) {
        let mut queues = self.shared.queues.lock().expect("writer queue lock");
        queues.output.discard_terminal(terminal_id);
        queues.interest.detach(terminal_id);
    }

    pub(super) fn queue_ping(&self) -> Result<oneshot::Receiver<()>, WriterExit> {
        let (tx, rx) = oneshot::channel();
        self.push_control(Message::Ping(Vec::new().into()), Some(tx), None)?;
        Ok(rx)
    }

    pub(super) fn pending_output_bytes(&self) -> usize {
        let queues = self.shared.queues.lock().expect("writer queue lock");
        queues
            .output
            .pending_bytes()
            .saturating_add(queues.in_flight_output_bytes)
    }

    /// Total successful socket sends completed on this connection (drain-
    /// progress liveness, responsive-terminal-restore Workstream 3). The
    /// catastrophic-backpressure monitor feeds its per-tick delta into its
    /// window decision: sends are the ONLY progress signal (eviction and
    /// supersede reduce queued bytes without being sends).
    pub(super) fn completed_sends(&self) -> u64 {
        self.shared
            .queues
            .lock()
            .expect("writer queue lock")
            .completed_sends
    }
}

impl Sink<Message> for WriterSender {
    type Error = WriterExit;

    fn poll_ready(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        let closed = self.shared.queues.lock().expect("writer queue lock").closed;
        Poll::Ready(if closed {
            Err(WriterExit::Stopped)
        } else {
            Ok(())
        })
    }

    fn start_send(self: Pin<&mut Self>, frame: Message) -> Result<(), Self::Error> {
        self.push_control(frame, None, None)
    }

    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn poll_close(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.stop_without_close();
        Poll::Ready(Ok(()))
    }
}

// Count-bound metadata independently of the wire-byte budget. Gap metadata
// and zero-byte sequenced controls (terminal.exit) cannot form an unbounded
// queue.
fn metadata_limit(output_limit: usize) -> usize {
    (output_limit / 64).clamp(64, 262_144)
}

fn frame_bytes(frame: &Message) -> usize {
    match frame {
        Message::Text(text) => text.len(),
        Message::Binary(data) | Message::Ping(data) | Message::Pong(data) => data.len(),
        Message::Close(Some(close)) => 2 + close.reason.len(),
        Message::Close(None) => 0,
    }
}

impl WriterPump {
    fn take_next(&self) -> Result<Option<NextFrame>, WriterExit> {
        let mut queues = self.shared.queues.lock().expect("writer queue lock");
        if queues.closed {
            return Ok(None);
        }
        let output_pending = queues.output.has_pending();
        let control_waiting = !queues.controls.is_empty();
        // Fairness never reorders a control behind output that was admitted
        // AFTER it (a prelude must stay ahead of its replay): only output
        // stamped strictly before the oldest pending control may leapfrog.
        // Gap heads carry no stamp and never leapfrog; sequenced exits DO
        // keep their admission stamp and may leapfrog a control streak —
        // admission order (and hence exit-behind-final-output within a
        // terminal) is preserved either way.
        let output_may_leapfrog = match (queues.output.front_stamp(), queues.controls.front()) {
            (Some(stamp), Some(control)) => stamp < control.seq,
            (Some(_), None) => true,
            (None, _) => false,
        };
        let take_output = output_pending
            && (!control_waiting
                || (queues.controls_since_last_output >= CONTROL_STREAK_LIMIT
                    && output_may_leapfrog));
        if take_output {
            let Some(delivery) = queues.output.pop() else {
                return Ok(None);
            };
            let (frame, bytes) = match delivery {
                Delivery::Frame { payload, bytes } => (payload, bytes),
                Delivery::Gap { terminal_id, range } => {
                    // Restore contract (responsive-terminal-restore): a
                    // negotiated connection's gap carries the terminal's
                    // CURRENT bounds, resolved at emission time. The source
                    // (registry-backed) takes the per-terminal lock, whose
                    // holders — subscriber fan-out, attach replays — acquire
                    // THIS admission lock under theirs, so resolving under
                    // the admission lock would invert the established lock
                    // order and can deadlock: release, resolve, re-acquire.
                    let bounds = match self.shared.gap_bounds.get() {
                        Some(source) => {
                            drop(queues);
                            let bounds = source(&terminal_id);
                            queues = self.shared.queues.lock().expect("writer queue lock");
                            if queues.closed {
                                // A concurrent stop won the race while the
                                // admission lock was released. The queue is
                                // dead (Drop clears it) and the pump returns
                                // via the stop watch — never lease output
                                // past a stop.
                                return Ok(None);
                            }
                            bounds
                        }
                        None => None,
                    };
                    // Spill observability (task-007 review M2) now fires at
                    // ADMISSION time, when the eviction happens — see
                    // `Queues::take_admission_spills`. Leasing the coalesced
                    // gap here is delivery, not a spill occurrence.
                    let message =
                        ServerMessage::TerminalOutputGap(freshell_protocol::TerminalOutputGap {
                            terminal_id,
                            stream_id: range.stream_id,
                            attach_request_id: range.attach_request_id,
                            from_seq: range.from_seq,
                            to_seq: range.to_seq,
                            reason: freshell_protocol::TerminalOutputGapReason::QueueOverflow,
                            head_seq: bounds.map(|b| b.head_seq),
                            oldest_retained_seq: bounds.map(|b| b.oldest_retained_seq),
                        });
                    let json = serde_json::to_string(&message)
                        .map_err(|_| WriterExit::SerializationFailed)?;
                    let bytes = json.len();
                    (Message::Text(json.into()), bytes)
                }
            };
            // The leased frame stays charged to the budget until its flush
            // finishes (or the writer dies); the rest of the backlog remains
            // queued and accounted.
            queues.in_flight_output_bytes = bytes;
            queues.output.set_reserved_bytes(bytes);
            queues.controls_since_last_output = 0;
            let next = NextFrame {
                frame,
                control_bytes: 0,
                output_bytes: bytes,
                flushed: None,
            };
            drop(queues);
            return Ok(Some(next));
        }
        if let Some(control) = queues.controls.pop_front() {
            queues.controls_since_last_output += 1;
            return Ok(Some(NextFrame {
                frame: control.frame,
                control_bytes: control.bytes,
                output_bytes: 0,
                flushed: control.flushed,
            }));
        }
        Ok(None)
    }

    fn finish_frame(&self, output_bytes: usize, control_bytes: usize) {
        let mut queues = self.shared.queues.lock().expect("writer queue lock");
        queues.control_bytes = queues.control_bytes.saturating_sub(control_bytes);
        queues.in_flight_output_bytes = queues.in_flight_output_bytes.saturating_sub(output_bytes);
        let reserved = queues.in_flight_output_bytes;
        queues.output.set_reserved_bytes(reserved);
        // Drain-progress liveness: one successful socket send just completed
        // (output or control — the pump serializes all sends, so either
        // proves the socket accepted bytes).
        queues.completed_sends = queues.completed_sends.saturating_add(1);
    }

    /// Generic over the real transport so tests can stop a flush at a precise
    /// boundary without depending on OS socket buffer sizes or wall-clock races.
    pub(super) async fn run<S>(mut self, mut socket: S) -> WriterExit
    where
        S: Sink<Message> + Unpin,
    {
        loop {
            let stop = self.stop.borrow().clone();
            if let Some(stop) = stop {
                // There is no pending send at this boundary. A bounded best-
                // effort close preserves 4009/4008 when the transport can write.
                if let Some((code, reason)) = stop.close {
                    let _ = tokio::time::timeout(
                        Duration::from_millis(250),
                        socket.send(Message::Close(Some(CloseFrame {
                            code,
                            reason: reason.into(),
                        }))),
                    )
                    .await;
                }
                return stop.exit;
            }
            let next = match self.take_next() {
                Ok(Some(next)) => next,
                Ok(None) => {
                    tokio::select! {
                        _ = self.shared.ready.notified() => {},
                        _ = self.stop.changed() => {},
                    }
                    continue;
                }
                Err(exit) => return exit,
            };
            let NextFrame {
                frame,
                output_bytes,
                control_bytes,
                flushed,
            } = next;
            // Never cancel-and-restart a send to service another frame. Stop or
            // timeout below returns from run and drops the entire socket.
            let sent = tokio::select! {
                biased;
                result = tokio::time::timeout(self.write_timeout, socket.send(frame)) => {
                    match result {
                        Ok(Ok(())) => true,
                        Ok(Err(_)) => return WriterExit::SendFailed,
                        Err(_) => return WriterExit::SendTimedOut,
                    }
                },
                _ = self.stop.changed() => false,
            };
            if !sent {
                let (exit, close) = {
                    // End the watch borrow before Drop acquires the queue lock.
                    let stop = self.stop.borrow();
                    let exit = stop
                        .as_ref()
                        .map(|stop| stop.exit)
                        .unwrap_or(WriterExit::Stopped);
                    let close = stop.as_ref().and_then(|stop| stop.close.clone());
                    (exit, close)
                };
                if let Some((code, reason)) = close {
                    // The cancelled send may have left a started frame
                    // buffered inside the transport; CONTINUING that flush is
                    // unambiguous (it resumes the same frame — this is not a
                    // retry). Only once the buffer has drained may a whole
                    // Close frame be written. Both steps are bounded; failure
                    // simply falls through to exit, and the peer sees the
                    // abnormal close that real network failure always meant.
                    let finished =
                        tokio::time::timeout(Duration::from_millis(250), socket.flush()).await;
                    if matches!(finished, Ok(Ok(()))) {
                        let _ = tokio::time::timeout(
                            Duration::from_millis(250),
                            socket.send(Message::Close(Some(CloseFrame {
                                code,
                                reason: reason.into(),
                            }))),
                        )
                        .await;
                    }
                }
                return exit;
            }
            self.finish_frame(output_bytes, control_bytes);
            if let Some(receipt) = flushed {
                let _ = receipt.send(());
            }
            // No drain-all local vector: reconsider newly admitted controls
            // between every output frame, and yield even on an always-ready sink.
            tokio::task::yield_now().await;
        }
    }
}

impl Drop for WriterPump {
    fn drop(&mut self) {
        // Also runs if the connection task aborts the writer. Stale FrameSink
        // callbacks cannot keep filling an outbox with no consumer.
        if let Ok(mut queues) = self.shared.queues.lock() {
            queues.closed = true;
            queues.controls.clear();
            queues.control_bytes = 0;
            queues.in_flight_output_bytes = 0;
            queues.controls_since_last_output = 0;
            queues.output = DeliveryQueue::new(
                self.shared.output_limit,
                metadata_limit(self.shared.output_limit),
            );
            queues.interest = InterestState::default();
        }
    }
}

struct Outstanding {
    /// Flush receipt; `None` once the ping's flush has been observed. Pure
    /// liveness bookkeeping (a Closed receipt detects a dead pump one tick
    /// early) — deadlines are never derived from it.
    receipt: Option<oneshot::Receiver<()>>,
}

/// Tracks the keepalive transaction in TICK CYCLES, not wall clock — exactly
/// the legacy `pong_since_last_ping` contract (`ws.on('pong')`,
/// ws-handler.ts:1149-1150): a ping queued at tick N must be answered before
/// tick N+1 fires, or the connection is dead. Detection lands at exactly one
/// tick boundary by construction, immune to interval-timer jitter, and
/// healthy connections emit exactly one ping per tick. At most one ping is
/// outstanding. A pong arrival while nothing is outstanding is consumed when
/// the next ping is queued and grants NO exemption (legacy's initial-flag
/// consumption has the same shape; a transport pong carries no cookie, so
/// only arrival order matters).
#[derive(Default)]
pub(super) struct Keepalive {
    outstanding: Option<Outstanding>,
    pong: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum KeepaliveError {
    TimedOut,
    Writer(WriterExit),
}

impl Keepalive {
    pub(super) fn observe_pong(&mut self) {
        self.pong = true;
    }

    pub(super) fn tick(&mut self, sender: &WriterSender) -> Result<(), KeepaliveError> {
        if let Some(outstanding) = &mut self.outstanding {
            if let Some(receipt) = &mut outstanding.receipt {
                match receipt.try_recv() {
                    Ok(()) => outstanding.receipt = None, // flush observed
                    Err(oneshot::error::TryRecvError::Empty) => {}
                    // The pump is gone without ever flushing this ping; its
                    // task result carries the precise cause
                    // (SendFailed/SendTimedOut/…) — "stopped" is the only
                    // fact this edge can know.
                    Err(oneshot::error::TryRecvError::Closed) => {
                        return Err(KeepaliveError::Writer(WriterExit::Stopped));
                    }
                }
            }
            if !self.pong {
                // One full cycle with no answer — dead peer (flushed but
                // unanswered) or a wedged socket (never even flushed:
                // controls preempt output, so a full silent cycle is never
                // the peer's fault).
                return Err(KeepaliveError::TimedOut);
            }
            self.outstanding = None; // answered within its cycle
        }
        let receipt = sender.queue_ping().map_err(KeepaliveError::Writer)?;
        self.outstanding = Some(Outstanding {
            receipt: Some(receipt),
        });
        self.pong = false;
        Ok(())
    }
}

/// A dropping connection must not detach a blocked socket-writer task.
pub(super) struct AbortWriterOnDrop(pub(super) tokio::task::AbortHandle);
impl Drop for AbortWriterOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[cfg(test)]
#[path = "connection_writer_tests.rs"]
mod tests;
