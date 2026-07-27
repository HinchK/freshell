//! Server-wide `terminal.create` requestId -> terminal dedupe guard
//! (legacy: `server/ws-handler.ts` — server-global `createdByRequestId`
//! settled cache (declaration :467, lookup :2167-2172), per-connection
//! in-flight sentinel (`ClientState`, :1166; set :2434), create-lock
//! serialization (:2159-2161)). The Rust port had no equivalent (fresh
//! UUIDs minted unconditionally, terminal.rs:748; omission self-documented
//! at :805-807), and the frozen client re-sends unanswered creates with
//! the SAME requestId on every reconnect — without this guard every
//! resend spawns a duplicate PTY and orphans the original as a detached
//! background session.
//!
//! Mechanism divergence, same wire outcome: legacy serializes duplicates
//! on the create lock and answers them from the settled cache on the NEW
//! socket. Here the map is server-global with an `InFlight` sentinel, so
//! the sentinel carries the reply path itself: cross-connection
//! duplicates register their `FrameSink` as waiters; `settle` forwards
//! the stored `terminal.created` to every waiter; every non-settled exit
//! (`clear_if_in_flight`) forwards a fail-loud error instead. A silently
//! swallowed duplicate would wedge the reconnected pane in 'creating'
//! (A2, TerminalView.tsx:3995-3999).
//!
//! Eviction semantics:
//! - failed create -> the wrapper calls `clear_if_in_flight` (legacy
//!   sentinel cleanup, ws-handler.ts:2460), which also notifies waiters
//! - killed/exited terminal -> lazily evicted at lookup time via the
//!   `is_live` probe (legacy deletes eagerly on kill,
//!   ws-handler.ts:2286/:2372)

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use freshell_protocol::{ErrorCode, ErrorMsg, ServerMessage};
use freshell_terminal::FrameSink;

// A `terminal.created` frame (~440 bytes) rides inline in both enums below.
// These are transient, once-per-create values (never bulk-stored beyond the
// small settled cache), so boxing would add indirection for no measurable
// win — and `DuplicateSettled(ServerMessage)` is the task's specified
// interface shape.
#[allow(clippy::large_enum_variant)]
enum Entry {
    /// A create with this requestId is currently gated/queued/in flight.
    InFlight {
        /// The sink of the connection running the create (it receives the
        /// reply through the normal create path — never as a waiter).
        origin: FrameSink,
        /// OTHER connections that re-sent this requestId and are owed a
        /// reply when the create settles or exits non-settled.
        waiters: Vec<FrameSink>,
    },
    /// The create settled: replay this exact `terminal.created` frame.
    Settled {
        terminal_id: String,
        created: ServerMessage,
    },
}

#[allow(clippy::large_enum_variant)] // see `Entry` above
pub enum DedupeDecision {
    /// First sighting (or stale settled entry evicted): proceed to create.
    Proceed,
    /// A create with this requestId is in flight. Same connection: dropped
    /// (the in-flight create replies on this very sink). Different
    /// connection: its sink is now a registered waiter and WILL receive
    /// the settle frame or a fail-loud error — never silence.
    DuplicateInFlight,
    /// Already settled and the terminal is live: re-send the stored
    /// `terminal.created` frame instead of spawning.
    DuplicateSettled(ServerMessage),
}

/// The fail-loud frame forwarded to waiters on a non-settled exit — the
/// same `{ code, message, requestId }` shape `send_create_error` builds
/// (Task 4 Step 5), so the frozen client's requestId match
/// (TerminalView.tsx:3995-3999) fails the pane loud and its retry ladder
/// re-drives with the same requestId (the sentinel is gone by then, so
/// the retry proceeds as a fresh create).
fn waiter_error(request_id: &str) -> ServerMessage {
    ServerMessage::Error(ErrorMsg {
        code: ErrorCode::PtySpawnFailed,
        message: "terminal.create did not complete; retry".to_string(),
        timestamp: crate::now_iso(),
        actual_session_ref: None,
        expected_session_ref: None,
        request_id: Some(request_id.to_string()),
        terminal_exit_code: None,
        terminal_id: None,
    })
}

#[derive(Default)]
pub struct CreateDedupe {
    entries: Mutex<HashMap<String, Entry>>,
}

impl CreateDedupe {
    /// Look up `request_id`. Registers an InFlight sentinel (with `sink`
    /// as origin) on `Proceed`; registers `sink` as a waiter on
    /// `DuplicateInFlight` when it belongs to a different connection
    /// (compared by `Arc::ptr_eq` — the per-connection sink is one Arc).
    pub fn begin(
        &self,
        request_id: &str,
        sink: &FrameSink,
        is_live: impl Fn(&str) -> bool,
    ) -> DedupeDecision {
        let mut map = self.entries.lock().expect("create_dedupe lock");
        match map.get_mut(request_id) {
            Some(Entry::InFlight { origin, waiters }) => {
                let already_known =
                    Arc::ptr_eq(origin, sink) || waiters.iter().any(|w| Arc::ptr_eq(w, sink));
                if !already_known {
                    waiters.push(Arc::clone(sink));
                }
                DedupeDecision::DuplicateInFlight
            }
            Some(Entry::Settled {
                terminal_id,
                created,
            }) => {
                if is_live(terminal_id) {
                    DedupeDecision::DuplicateSettled(created.clone())
                } else {
                    // Terminal was killed/exited: evict and treat as fresh.
                    let origin = Arc::clone(sink);
                    map.insert(
                        request_id.to_string(),
                        Entry::InFlight {
                            origin,
                            waiters: Vec::new(),
                        },
                    );
                    DedupeDecision::Proceed
                }
            }
            None => {
                map.insert(
                    request_id.to_string(),
                    Entry::InFlight {
                        origin: Arc::clone(sink),
                        waiters: Vec::new(),
                    },
                );
                DedupeDecision::Proceed
            }
        }
    }

    /// Record a successful create (called where `handle_create` builds and
    /// sends the `terminal.created` frame) and forward the frame to every
    /// registered waiter (non-blocking `FrameSink` call; a waiter whose
    /// connection died simply drops the frame).
    pub fn settle(&self, request_id: &str, terminal_id: &str, created: &ServerMessage) {
        let prev = self.entries.lock().expect("create_dedupe lock").insert(
            request_id.to_string(),
            Entry::Settled {
                terminal_id: terminal_id.to_string(),
                created: created.clone(),
            },
        );
        if let Some(Entry::InFlight { waiters, .. }) = prev {
            for w in waiters {
                w(created.clone());
            }
        }
    }

    /// Drop the InFlight sentinel if (and only if) the create did NOT
    /// settle — gate rejection, cancellation, shutdown abandon, or
    /// handle_create failure — and forward a fail-loud error to any
    /// registered waiters. Settled entries stay: that IS the dedupe.
    /// This is what lets the client's 2s RATE_LIMITED retry (same
    /// requestId) proceed as a fresh create.
    pub fn clear_if_in_flight(&self, request_id: &str) {
        let removed = {
            let mut map = self.entries.lock().expect("create_dedupe lock");
            if matches!(map.get(request_id), Some(Entry::InFlight { .. })) {
                map.remove(request_id)
            } else {
                None
            }
        };
        if let Some(Entry::InFlight { waiters, .. }) = removed {
            if waiters.is_empty() {
                return;
            }
            let err = waiter_error(request_id);
            for w in waiters {
                w(err.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn created_frame() -> ServerMessage {
        // Cheapest constructible variant; the guard treats it opaquely
        // (`ServerMessage` has no unit variant — same adjustment as Task 4's
        // CreateOutput test).
        ServerMessage::Pong(freshell_protocol::Pong {
            timestamp: "t".to_string(),
        })
    }

    /// A FrameSink that records every frame it is handed.
    fn recording_sink() -> (FrameSink, Arc<Mutex<Vec<ServerMessage>>>) {
        let frames = Arc::new(Mutex::new(Vec::new()));
        let recorder = Arc::clone(&frames);
        let sink: FrameSink = Arc::new(move |msg| {
            recorder.lock().expect("frames lock").push(msg);
        });
        (sink, frames)
    }

    #[test]
    fn first_begin_proceeds_and_registers_sentinel() {
        let d = CreateDedupe::default();
        let (s1, _f1) = recording_sink();
        assert!(matches!(
            d.begin("r1", &s1, |_| true),
            DedupeDecision::Proceed
        ));
        assert!(matches!(
            d.begin("r1", &s1, |_| true),
            DedupeDecision::DuplicateInFlight
        ));
    }

    #[test]
    fn settled_entry_replays_frame_while_live() {
        let d = CreateDedupe::default();
        let (s1, _f1) = recording_sink();
        let _ = d.begin("r1", &s1, |_| true);
        d.settle("r1", "t1", &created_frame());
        assert!(matches!(
            d.begin("r1", &s1, |_| true),
            DedupeDecision::DuplicateSettled(_)
        ));
    }

    #[test]
    fn dead_terminal_evicts_settled_entry() {
        let d = CreateDedupe::default();
        let (s1, _f1) = recording_sink();
        let _ = d.begin("r1", &s1, |_| true);
        d.settle("r1", "t1", &created_frame());
        assert!(matches!(
            d.begin("r1", &s1, |_| false),
            DedupeDecision::Proceed
        ));
    }

    #[test]
    fn clear_if_in_flight_removes_sentinel_but_not_settled() {
        let d = CreateDedupe::default();
        let (s1, _f1) = recording_sink();
        let _ = d.begin("r1", &s1, |_| true);
        d.clear_if_in_flight("r1");
        assert!(matches!(
            d.begin("r1", &s1, |_| true),
            DedupeDecision::Proceed
        ));
        d.settle("r1", "t1", &created_frame());
        d.clear_if_in_flight("r1");
        assert!(matches!(
            d.begin("r1", &s1, |_| true),
            DedupeDecision::DuplicateSettled(_)
        ));
    }

    #[test]
    fn cross_connection_waiter_receives_settle_frame() {
        let d = CreateDedupe::default();
        let (origin, origin_frames) = recording_sink();
        let (other, other_frames) = recording_sink();
        let _ = d.begin("r1", &origin, |_| true);
        assert!(matches!(
            d.begin("r1", &other, |_| true),
            DedupeDecision::DuplicateInFlight
        ));
        d.settle("r1", "t1", &created_frame());
        assert_eq!(
            other_frames.lock().expect("frames").len(),
            1,
            "cross-connection waiter must receive the settled frame"
        );
        assert!(
            origin_frames.lock().expect("frames").is_empty(),
            "the origin replies through the create path, never as a waiter"
        );
    }

    #[test]
    fn same_connection_duplicate_is_not_a_waiter() {
        let d = CreateDedupe::default();
        let (origin, origin_frames) = recording_sink();
        let _ = d.begin("r1", &origin, |_| true);
        let _ = d.begin("r1", &origin, |_| true);
        d.settle("r1", "t1", &created_frame());
        assert!(
            origin_frames.lock().expect("frames").is_empty(),
            "same-sink duplicates must not be double-answered"
        );
    }

    #[test]
    fn waiters_get_fail_loud_error_on_non_settled_exit() {
        let d = CreateDedupe::default();
        let (origin, _f1) = recording_sink();
        let (other, other_frames) = recording_sink();
        let _ = d.begin("r1", &origin, |_| true);
        let _ = d.begin("r1", &other, |_| true);
        d.clear_if_in_flight("r1");
        {
            let frames = other_frames.lock().expect("frames");
            assert_eq!(frames.len(), 1, "waiter must receive a fail-loud error");
            assert!(matches!(
                &frames[0],
                ServerMessage::Error(err) if err.request_id.as_deref() == Some("r1")
            ));
        }
        // Sentinel is gone: the client's retry proceeds fresh.
        assert!(matches!(
            d.begin("r1", &other, |_| true),
            DedupeDecision::Proceed
        ));
    }
}
