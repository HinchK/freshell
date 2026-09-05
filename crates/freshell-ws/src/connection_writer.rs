//! One socket writer, independent of command dispatch. No socket I/O is awaited
//! by a handler. Readiness/mode preludes and output are admitted under ONE lock,
//! preventing a replay frame from racing ahead of its prelude. Output remains
//! FIFO (including terminal.exit), with the existing explicit overflow gaps.
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
use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame, Message};
use freshell_protocol::ServerMessage;
use freshell_terminal::output_queue::{output_frame_meta, OutputQueue};
use futures_util::{Sink, SinkExt};
use tokio::sync::{oneshot, watch, Notify};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WriterExit {
    Stopped,
    SendFailed,
    SendTimedOut,
    ControlOverflow,
    SerializationFailed,
}

impl WriterExit {
    pub(super) fn reason(self) -> &'static str {
        match self {
            Self::Stopped => "writer_stopped",
            Self::SendFailed => "send_error",
            Self::SendTimedOut => "writer_stalled",
            Self::ControlOverflow => "control_backpressure",
            Self::SerializationFailed => "serialization_error",
        }
    }

    pub(super) fn close_code(self) -> Option<u16> {
        match self {
            Self::SendTimedOut | Self::ControlOverflow => Some(4008),
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
    // Keepalive observes the ping's flush receipt for liveness bookkeeping;
    // the keepalive DEADLINE is anchored at the tick that queued the ping
    // (see Keepalive), not at this receipt.
    flushed: Option<oneshot::Sender<Instant>>,
}

/// Consecutive control leases after which a pending output frame MUST be
/// leased instead. Controls normally preempt (they are how the reader's
/// answers and liveness traffic jump a backlog), but an unbounded control
/// stream must not starve output all the way to the catastrophic monitor.
const CONTROL_STREAK_LIMIT: usize = 8;

struct Queues {
    output: OutputQueue,
    controls: VecDeque<Control>,
    // Includes a control frame currently being flushed, not just queued frames.
    control_bytes: usize,
    in_flight_output_bytes: usize,
    /// Consecutive control frames leased since the last output frame. See
    /// `CONTROL_STREAK_LIMIT`.
    controls_since_last_output: usize,
    closed: bool,
}

struct Shared {
    queues: Mutex<Queues>,
    output_limit: usize,
    control_limit: usize,
    ready: Notify,
    stop: watch::Sender<Option<Stop>>,
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
    frame: Message,
    output_bytes: usize,
    control_bytes: usize,
    flushed: Option<oneshot::Sender<Instant>>,
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
                output: OutputQueue::new(output_limit),
                controls: VecDeque::new(),
                control_bytes: 0,
                in_flight_output_bytes: 0,
                controls_since_last_output: 0,
                closed: false,
            }),
            output_limit: output_limit.max(1),
            control_limit: control_limit.max(1),
            ready: Notify::new(),
            stop: stop_tx,
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
        flushed: Option<oneshot::Sender<Instant>>,
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
        let bytes = frame_bytes(&frame).saturating_add(128);
        let mut queues = self.shared.queues.lock().expect("writer queue lock");
        if queues.closed {
            return Err(WriterExit::Stopped);
        }
        if bytes
            > self
                .shared
                .control_limit
                .saturating_sub(queues.control_bytes)
        {
            drop(queues);
            self.fail(WriterExit::ControlOverflow);
            return Err(WriterExit::ControlOverflow);
        }
        if let Some(terminal_id) = supersedes_terminal {
            queues.output.discard_terminal(terminal_id);
        }
        queues.control_bytes += bytes;
        queues.controls.push_back(Control {
            frame,
            bytes,
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
        let json = match serde_json::to_string(&msg) {
            Ok(json) => json,
            Err(_) => {
                self.fail(WriterExit::SerializationFailed);
                return false;
            }
        };
        if meta.is_none() && !exit {
            return self
                .push_control(Message::Text(json.into()), None, supersedes.as_deref())
                .is_ok();
        }
        let mut queues = self.shared.queues.lock().expect("writer queue lock");
        if queues.closed {
            return false;
        }
        if let Some(meta) = meta {
            queues.output.push(msg, json.len(), meta);
        } else {
            // Preserve final-output -> exit. It must not use the control lane.
            queues.output.push_sequenced(msg);
        }
        drop(queues);
        self.shared.ready.notify_one();
        true
    }

    pub(super) fn queue_ping(&self) -> Result<oneshot::Receiver<Instant>, WriterExit> {
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
        let control_wins = !queues.controls.is_empty()
            && (!output_pending || queues.controls_since_last_output < CONTROL_STREAK_LIMIT);
        if control_wins {
            let control = queues
                .controls
                .pop_front()
                .expect("control_wins implies a queued control");
            queues.controls_since_last_output += 1;
            return Ok(Some(NextFrame {
                frame: control.frame,
                control_bytes: control.bytes,
                output_bytes: 0,
                flushed: control.flushed,
            }));
        }
        let Some((msg, bytes)) = queues.output.pop_front() else {
            return Ok(None);
        };
        queues.controls_since_last_output = 0;
        let json = serde_json::to_string(&msg).map_err(|_| WriterExit::SerializationFailed)?;
        queues.in_flight_output_bytes = bytes;
        Ok(Some(NextFrame {
            frame: Message::Text(json.into()),
            output_bytes: bytes,
            control_bytes: 0,
            flushed: None,
        }))
    }

    fn finish_frame(&self, output_bytes: usize, control_bytes: usize) {
        let mut queues = self.shared.queues.lock().expect("writer queue lock");
        queues.control_bytes = queues.control_bytes.saturating_sub(control_bytes);
        queues.in_flight_output_bytes = queues.in_flight_output_bytes.saturating_sub(output_bytes);
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
                let _ = receipt.send(Instant::now());
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
            queues.output = OutputQueue::new(self.shared.output_limit);
        }
    }
}

struct Outstanding {
    /// Flush receipt; `None` once the ping's flush has been confirmed (the
    /// deadline stays anchored at `queued_at` regardless).
    receipt: Option<oneshot::Receiver<Instant>>,
    /// Tick time at which the ping was queued. Tick-aligned by construction,
    /// so an unanswered ping is detected at exactly the next tick one
    /// interval later — the legacy one-unanswered-cycle contract
    /// (`ws.on('pong')`, ws-handler.ts:1149-1150), with no idle full-cycle
    /// window in between.
    queued_at: Instant,
}

/// Tracks the keepalive transaction: at most one outstanding ping, answered
/// by any pong (a direct transport reply carries no ping cookie, so a pong
/// observed before the flush receipt is still retained as the answer).
///
/// The deadline is anchored at the tick that QUEUED the ping, not at its
/// flush receipt: anchoring on the flush would slide detection by almost a
/// full extra interval whenever the flush lands an epsilon after its tick.
/// A ping still unflushed one full interval after its tick means the socket
/// could not emit a single control frame for an entire cycle — the writer's
/// per-send stall deadline bounds that case separately, and the keepalive
/// kill is the earlier, legacy-shaped remediation.
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

    pub(super) fn tick(
        &mut self,
        sender: &WriterSender,
        now: Instant,
        interval: Duration,
    ) -> Result<(), KeepaliveError> {
        if let Some(outstanding) = &mut self.outstanding {
            if let Some(receipt) = &mut outstanding.receipt {
                match receipt.try_recv() {
                    // Flush confirmed; the deadline stays anchored at
                    // `queued_at`, so this receipt is liveness bookkeeping
                    // only (no timeout relief for a late flush).
                    Ok(_) => outstanding.receipt = None,
                    Err(oneshot::error::TryRecvError::Empty) => {}
                    // The pump is gone without ever flushing this ping; its
                    // task result carries the precise cause
                    // (SendFailed/SendTimedOut/…) — here it can only mean
                    // "no flush receipt will arrive".
                    Err(oneshot::error::TryRecvError::Closed) => {
                        return Err(KeepaliveError::Writer(WriterExit::Stopped));
                    }
                }
            }
        }
        if let Some(outstanding) = &self.outstanding {
            if self.pong {
                // Answered within its cycle (possibly before the flush
                // receipt — a pong needs no cookie): retire it and queue the
                // next ping below; healthy connections emit one per tick.
                self.outstanding = None;
                self.pong = false;
            } else if now.saturating_duration_since(outstanding.queued_at) >= interval {
                // One full cycle, no pong — dead peer (flushed but
                // unanswered) or a wedged socket (never flushed).
                return Err(KeepaliveError::TimedOut);
            } else {
                // Within the outstanding ping's cycle: wait for its pong;
                // never stack a second ping.
                return Ok(());
            }
        }
        let receipt = sender.queue_ping().map_err(KeepaliveError::Writer)?;
        self.outstanding = Some(Outstanding {
            receipt: Some(receipt),
            queued_at: now,
        });
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
