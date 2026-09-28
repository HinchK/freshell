//! TERM-09: per-connection terminal-output backpressure configuration and the
//! catastrophic-backpressure monitor (legacy: `client-output-queue.ts`'
//! tunables and `broker.ts`'s `catastrophicBlocked`,
//! `TERMINAL_WS_CATASTROPHIC_BUFFERED_BYTES` / `_STALL_MS`, `constants.ts:8-16`).
//!
//! The bounded queue itself is the connection writer's byte-fair delivery
//! queue (`terminal::connection_writer`'s `terminal_delivery_queue`), with the
//! default cap exported from `freshell_terminal::output_queue`: producers
//! route output frames into it through the writer's single admission lock,
//! and the writer leases one frame at a time to the socket.
//!
//! ## Architectural mapping (why this differs from `broker.ts`)
//!
//! Legacy checks `ws.bufferedAmount` -- a value the underlying socket reports
//! WITHOUT blocking -- before every send attempt, so a stalled write is
//! observed instantly on the next flush tick. `axum`'s `WebSocket::send` has
//! no non-blocking "how much is buffered" query; the only signal is the
//! `send().await` call itself resolving (or not). This crate therefore uses
//! the writer's pending output bytes (everything queued PLUS the one frame
//! currently leased to the socket) as the OBSERVABLE proxy for
//! `bufferedAmount`: if the writer can't keep up, frames pile up there BEFORE
//! ever reaching the socket, so sustained queue pressure is the same signal
//! legacy reads off the socket directly.
//!
//! [`CatastrophicMonitor::tick`] runs on the connection's own periodic ticker
//! in its select loop. Before the writer split this ticker shared a task with
//! network writes, so a permanently blocked send could starve it; with the
//! split, the ticker is independent of socket state, and the writer's own
//! per-send timeout bounds a truly wedged send separately. Regardless of
//! whether the ticker ever fires, the queue's bound is unconditional:
//! eviction happens on every `push`, independent of whether anything is
//! currently being sent, so the "bounded server memory" half of TERM-09 holds
//! even in the worst case.
//!
//! Visible-first pacing / background throttling (legacy's
//! `TERMINAL_FOREGROUND_REPLAY_BUFFERED_PAUSE_BYTES` /
//! `TERMINAL_BACKGROUND_BUFFERED_PAUSE_BYTES` differential) lives in the
//! connection writer's byte-fair delivery queue
//! (`terminal::connection_writer`'s `terminal_delivery_queue`): focused,
//! visible, and background terminals receive roughly an 8:3:1 byte share
//! under continuous backlog, driven by the `terminalInterestV1` client's
//! presentation snapshots, with `terminal.attach.priority` as the
//! pre-snapshot fallback. This module holds the caps plus the catastrophic
//! monitor, not the scheduling.

use std::time::{Duration, Instant};

use freshell_terminal::output_queue::DEFAULT_TERMINAL_CLIENT_QUEUE_MAX_BYTES;

/// TERM-09 tunables (legacy parity: `server/terminal-stream/constants.ts`).
/// Bundled into one struct (rather than three separate `WsState` fields) to
/// keep the state surface change minimal.
#[derive(Debug, Clone, Copy)]
pub struct Term09Config {
    /// Per-connection bounded output-queue cap (legacy:
    /// `client-output-queue.ts:33` `DEFAULT_TERMINAL_CLIENT_QUEUE_MAX_BYTES`,
    /// env `TERMINAL_CLIENT_QUEUE_MAX_BYTES`).
    pub queue_max_bytes: usize,
    /// Catastrophic-backpressure threshold (legacy: `constants.ts:8-11`
    /// `TERMINAL_WS_CATASTROPHIC_BUFFERED_BYTES`, env same name).
    pub catastrophic_buffered_bytes: usize,
    /// How long the threshold must be sustained before closing (legacy:
    /// `constants.ts:13-16` `TERMINAL_WS_CATASTROPHIC_STALL_MS`, env same
    /// name).
    pub catastrophic_stall_ms: u64,
}

impl Default for Term09Config {
    fn default() -> Self {
        Self {
            queue_max_bytes: DEFAULT_TERMINAL_CLIENT_QUEUE_MAX_BYTES,
            // Responsive-terminal-restore Workstream 3: the pressure-related
            // disconnect threshold sits strictly ABOVE the spill bound (4x
            // it). Legacy shipped 16 MiB — BELOW its own 32 MiB spill bound,
            // so the disconnect fired before eviction could relieve the same
            // pressure (the production incident). Because eviction holds
            // pending bytes at or below `queue_max_bytes` (plus one
            // indivisible in-flight frame), a threshold above the spill bound
            // is unreachable by ordinary output pressure: the monitor is a
            // last-resort guard for accounting drift and an oversize
            // wedged in-flight frame, both independently bounded by the
            // per-send write timeout.
            catastrophic_buffered_bytes: 64 * 1024 * 1024,
            catastrophic_stall_ms: 10_000,
        }
    }
}

/// Per-field sanity floor for `queue_max_bytes` (env
/// `TERMINAL_CLIENT_QUEUE_MAX_BYTES`): the connection loop already widens the
/// control budget to at least 64 KiB regardless, and a queue bound below one
/// large frame's scale degenerates the metadata-limit derivation
/// (`(limit / 64).clamp(64, ..)`) rather than tuning pressure.
pub const TERM09_QUEUE_MAX_BYTES_FLOOR: usize = 64 * 1024;

/// Responsive-terminal-restore round-5 (finding 1, degenerate settings):
/// the paced-replay page-budget ceiling implied by a TERM-09 queue cap.
/// The drain-admission watermark is `queue_max_bytes / 2`
/// ([`crate::connection_writer`]'s reserve-then-admit gate), and the
/// queue's own byte cap evicts past `queue_max_bytes` — so a page larger
/// than the watermark can only admit into a fully drained queue (slow
/// but live), while a page larger than the whole cap self-spills on
/// admission. The server boot therefore CLAMPS the registry's page
/// budget to this ceiling at the one place both knobs are known
/// (`freshell-server`'s TERM-09 resolution; the ws test harness mirrors
/// the same relationship), documenting the queue-cap >= page-budget
/// relationship instead of leaving it to chance. With the defaults this
/// is a no-op (the 128 KiB page budget sits far below the 8 MiB
/// watermark); it only bites the small-queue settings — the supported
/// 64 KiB floor caps pages at 32 KiB.
///
/// The clamped budget still exceeds one realtime frame's envelope by a
/// wide margin at every valid queue setting (the 64 KiB floor's 32 KiB
/// ceiling vs the 16 KiB `MAX_REALTIME_MESSAGE_BYTES` chunk cap), so the
/// page builder's single-frame atomic page never exceeds its budget.
pub const fn paced_page_budget_ceiling(queue_max_bytes: usize) -> i64 {
    (queue_max_bytes / 2) as i64
}

/// Per-field sanity floor for `catastrophic_stall_ms` (env
/// `TERMINAL_WS_CATASTROPHIC_STALL_MS`): the monitor samples at
/// `stall / 4` (10 ms minimum), so a window below 100 ms would make the
/// last-resort disconnect decision under realistic scheduling/RTT jitter.
pub const TERM09_CATASTROPHIC_STALL_MS_FLOOR: u64 = 100;

/// Fail-fast validation error for [`Term09Config`]
/// (responsive-terminal-restore Workstream 3): a configuration that would
/// restore the spill≥disconnect inversion must refuse to boot. Each variant
/// names the offending env var(s) so the operator knows exactly what to fix.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Term09ConfigError {
    /// `catastrophic_buffered_bytes <= queue_max_bytes`: the
    /// pressure-related disconnect would fire at or before the bounded
    /// spill (eviction + gap) could relieve the same pressure.
    DisconnectNotAboveSpill {
        queue_bytes: usize,
        catastrophic_bytes: usize,
    },
    /// `queue_max_bytes` below [`TERM09_QUEUE_MAX_BYTES_FLOOR`].
    QueueMaxBytesFloor { bytes: usize },
    /// `catastrophic_stall_ms` below [`TERM09_CATASTROPHIC_STALL_MS_FLOOR`].
    CatastrophicStallMsFloor { ms: u64 },
}

impl std::fmt::Display for Term09ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match *self {
            Self::DisconnectNotAboveSpill {
                queue_bytes,
                catastrophic_bytes,
            } => write!(
                f,
                "invalid TERM-09 backpressure config: TERMINAL_WS_CATASTROPHIC_BUFFERED_BYTES \
                 ({catastrophic_bytes}) must be strictly greater than \
                 TERMINAL_CLIENT_QUEUE_MAX_BYTES ({queue_bytes}); a disconnect threshold at or \
                 below the spill bound disconnects slow clients before bounded spill (eviction \
                 + generation-scoped gap) can relieve pressure"
            ),
            Self::QueueMaxBytesFloor { bytes } => write!(
                f,
                "invalid TERM-09 backpressure config: TERMINAL_CLIENT_QUEUE_MAX_BYTES ({bytes}) \
                 is below the {TERM09_QUEUE_MAX_BYTES_FLOOR}-byte floor"
            ),
            Self::CatastrophicStallMsFloor { ms } => write!(
                f,
                "invalid TERM-09 backpressure config: TERMINAL_WS_CATASTROPHIC_STALL_MS ({ms}) \
                 is below the {TERM09_CATASTROPHIC_STALL_MS_FLOOR}-ms floor"
            ),
        }
    }
}

impl std::error::Error for Term09ConfigError {}

use crate::env_parse;

impl Term09Config {
    /// Resolve from process env, mirroring `server/terminal-stream/constants.ts`
    /// exactly (same env var names, same defaults).
    pub fn from_env() -> Self {
        let defaults = Self::default();
        Self {
            queue_max_bytes: env_parse("TERMINAL_CLIENT_QUEUE_MAX_BYTES", defaults.queue_max_bytes),
            catastrophic_buffered_bytes: env_parse(
                "TERMINAL_WS_CATASTROPHIC_BUFFERED_BYTES",
                defaults.catastrophic_buffered_bytes,
            ),
            catastrophic_stall_ms: env_parse(
                "TERMINAL_WS_CATASTROPHIC_STALL_MS",
                defaults.catastrophic_stall_ms,
            ),
        }
    }

    /// Cross-field validation, enforced fail-fast at boot wiring
    /// (`freshell-server` resolves this before constructing `WsState`):
    /// normal output pressure must reach bounded admission/spill (eviction +
    /// generation-scoped gap) STRICTLY before any pressure-related
    /// disconnect, so `catastrophic_buffered_bytes` must sit strictly above
    /// `queue_max_bytes` (equal also refuses: the disconnect would fire the
    /// moment the queue is full). Per-field sanity floors reject degenerate
    /// tunings. Test harnesses may still inject arbitrary `Term09Config`
    /// values directly into `WsState`; only the env/boot path is guarded.
    pub fn validate(&self) -> Result<(), Term09ConfigError> {
        if self.queue_max_bytes < TERM09_QUEUE_MAX_BYTES_FLOOR {
            return Err(Term09ConfigError::QueueMaxBytesFloor {
                bytes: self.queue_max_bytes,
            });
        }
        if self.catastrophic_stall_ms < TERM09_CATASTROPHIC_STALL_MS_FLOOR {
            return Err(Term09ConfigError::CatastrophicStallMsFloor {
                ms: self.catastrophic_stall_ms,
            });
        }
        if self.catastrophic_buffered_bytes <= self.queue_max_bytes {
            return Err(Term09ConfigError::DisconnectNotAboveSpill {
                queue_bytes: self.queue_max_bytes,
                catastrophic_bytes: self.catastrophic_buffered_bytes,
            });
        }
        Ok(())
    }
}

/// Fire-time evidence for ONE sustained catastrophic-backpressure
/// occurrence (task-007 review M3, landed by task-010): what the
/// `ws.terminal_stream.catastrophic_close` event needs to be diagnosable
/// from the log line alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CatastrophicFire {
    /// Completed socket sends DURING the deciding window for THIS
    /// occurrence — a per-occurrence delta, not a lifetime counter.
    /// Structurally zero (any send resets the window), so a nonzero value
    /// is accounting drift the log line exposes directly; a lifetime
    /// total cannot answer this question (a wedge-after-progress episode
    /// reads large lifetime sends while the window was send-silent).
    pub sends_in_window: u64,
}

/// Tracks whether the connection writer's pending output bytes (queued plus
/// in-flight frame) have been continuously over `catastrophic_buffered_bytes`
/// WITH ZERO successful socket sends, for the full `stall` duration
/// (responsive-terminal-restore Workstream 3). The byte threshold alone is
/// NOT a dead-socket signal — a slow-but-draining client holds a large
/// backlog while making steady send progress — so the window resets on
/// EITHER recovery below the threshold OR send progress, and firing requires
/// both conditions to hold for the whole window. Byte reductions from
/// eviction or superseded attachments do not count: they are not sends.
pub struct CatastrophicMonitor {
    threshold_bytes: usize,
    stall: Duration,
    since: Option<Instant>,
    /// Completed sends accumulated inside the CURRENT sustained window
    /// (see [`CatastrophicFire::sends_in_window`]): every tick's delta adds
    /// here while the window stays open, and any window reset (recovery or
    /// send progress) zeroes it — so at fire time it is exactly the sends
    /// that happened during the deciding window.
    window_sends: u64,
}

impl CatastrophicMonitor {
    pub fn new(threshold_bytes: usize, stall_ms: u64) -> Self {
        Self {
            threshold_bytes: threshold_bytes.max(1),
            stall: Duration::from_millis(stall_ms.max(1)),
            since: None,
            window_sends: 0,
        }
    }

    /// Call on each periodic check with the CURRENT pending-byte count and
    /// the number of SUCCESSFUL SOCKET SENDS completed since the previous
    /// tick (drain-progress liveness, responsive-terminal-restore Workstream
    /// 3). The sustained window resets when EITHER pending bytes fall below
    /// the threshold OR sends progressed: a slow-but-draining client is not
    /// a dead socket, so disconnect requires sustained bytes over threshold
    /// AND zero successful sends for the whole stall window. Byte
    /// reductions from eviction or superseded attachments do NOT count as
    /// progress — only completed sends (the caller feeds the connection
    /// writer's completed-send counter; queue-size deltas are invisible
    /// here). Fires exactly once per sustained episode (the caller closes
    /// the connection immediately on `Some`); the returned evidence carries
    /// the per-occurrence `sends_in_window` delta for the close event.
    pub fn tick(
        &mut self,
        pending_bytes: usize,
        sends_since_last_tick: u64,
    ) -> Option<CatastrophicFire> {
        if pending_bytes <= self.threshold_bytes || sends_since_last_tick > 0 {
            self.since = None;
            self.window_sends = 0;
            return None;
        }
        self.window_sends = self.window_sends.saturating_add(sends_since_last_tick);
        let since = *self.since.get_or_insert_with(Instant::now);
        if since.elapsed() < self.stall {
            return None;
        }
        // One fire per sustained episode: a caller that (against the
        // contract) kept ticking would need a full fresh window to fire
        // again, with fresh per-occurrence evidence.
        self.since = None;
        let sends_in_window = self.window_sends;
        self.window_sends = 0;
        Some(CatastrophicFire { sends_in_window })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paced_page_budget_ceiling_tracks_the_admission_watermark() {
        // Round-5 finding 1 (degenerate settings): the page-budget ceiling
        // is the queue's drain-admission watermark (queue cap / 2), so the
        // boot clamp keeps every paced page inside the reserve-then-admit
        // gate's normal grant arm — never larger than the queue itself
        // (self-spill) and never deadlocking the gate.
        assert_eq!(
            paced_page_budget_ceiling(16 * 1024 * 1024),
            8 * 1024 * 1024,
            "the default 16 MiB queue leaves the 128 KiB default budget untouched"
        );
        assert_eq!(
            paced_page_budget_ceiling(TERM09_QUEUE_MAX_BYTES_FLOOR),
            32 * 1024,
            "the supported 64 KiB queue floor caps pages at 32 KiB — the degenerate \
             default-128-KiB-page case must not self-spill a 64 KiB queue"
        );
        // The clamped budget always dwarfs one realtime frame's envelope
        // (the 16 KiB MAX_REALTIME_MESSAGE_BYTES chunk cap), so the page
        // builder's single-frame atomic page never exceeds the budget at
        // any valid queue setting.
        assert!(paced_page_budget_ceiling(TERM09_QUEUE_MAX_BYTES_FLOOR) > 16 * 1024);
    }

    #[test]
    fn the_page_floor_equals_the_terminal_crates_fragment_cap_floor() {
        // Round-2 finding F2 (cross-crate consistency pin): the terminal
        // crate clamps its fragment cap to "the smallest page budget any
        // supported queue setting can produce", computed on THIS side as
        // the ceiling at the queue floor. The two constants must agree —
        // if either drifts, the frame-fits-page invariant silently breaks
        // (a fragment cap above the floor could mint frames the page
        // builder cannot pack; a floor above the fragment clamp would
        // re-open the env-override gap).
        assert_eq!(
            paced_page_budget_ceiling(TERM09_QUEUE_MAX_BYTES_FLOOR),
            freshell_terminal::PACED_PAGE_BUDGET_FLOOR_BYTES as i64,
            "the fragment-cap floor must equal the paced page budget floor at the queue floor"
        );
    }

    #[test]
    fn term09_config_defaults_spill_before_disconnect() {
        // Responsive-terminal-restore Workstream 3: the defaults must place
        // the spill bound (eviction + gap) STRICTLY below the
        // pressure-related disconnect, sized so the production incident's
        // ~21-25 MB backlog spills gracefully instead of disconnecting.
        let cfg = Term09Config::default();
        assert_eq!(cfg.queue_max_bytes, 16 * 1024 * 1024, "spill bound: 16 MiB");
        assert_eq!(
            cfg.catastrophic_buffered_bytes,
            64 * 1024 * 1024,
            "disconnect bound: 64 MiB"
        );
        assert_eq!(cfg.catastrophic_stall_ms, 10_000);
        // The incident backlog (~21-25 MB) exceeds the spill bound (so it
        // spills) but stays far below the disconnect bound (so it survives).
        let incident_low = 21 * 1024 * 1024;
        let incident_high = 25 * 1024 * 1024;
        assert!(incident_low > cfg.queue_max_bytes);
        assert!(incident_high < cfg.catastrophic_buffered_bytes);
        cfg.validate().expect("defaults must satisfy the ordering");
    }

    #[test]
    fn validate_rejects_disconnect_at_or_below_spill() {
        // Equal refuses (strict ordering): the disconnect would fire the
        // moment the queue sits exactly full.
        let equal = Term09Config {
            queue_max_bytes: 8 * 1024 * 1024,
            catastrophic_buffered_bytes: 8 * 1024 * 1024,
            catastrophic_stall_ms: 10_000,
        };
        let err = equal.validate().expect_err("equalized pair must refuse");
        assert_eq!(
            err,
            Term09ConfigError::DisconnectNotAboveSpill {
                queue_bytes: 8 * 1024 * 1024,
                catastrophic_bytes: 8 * 1024 * 1024,
            }
        );
        // Below refuses — the restored legacy inversion (32 MB spill / 16 MB
        // disconnect) must never boot again.
        let inverted = Term09Config {
            queue_max_bytes: 32 * 1024 * 1024,
            catastrophic_buffered_bytes: 16 * 1024 * 1024,
            catastrophic_stall_ms: 10_000,
        };
        let err = inverted
            .validate()
            .expect_err("inverted pair must refuse (the incident's config)");
        let message = err.to_string();
        assert!(
            message.contains("TERMINAL_WS_CATASTROPHIC_BUFFERED_BYTES")
                && message.contains("TERMINAL_CLIENT_QUEUE_MAX_BYTES"),
            "the error must name the offending env vars: {message}"
        );
        // Strictly above passes.
        Term09Config {
            queue_max_bytes: 8 * 1024 * 1024,
            catastrophic_buffered_bytes: 8 * 1024 * 1024 + 1,
            catastrophic_stall_ms: 10_000,
        }
        .validate()
        .expect("strictly-above ordering must validate");
    }

    #[test]
    fn validate_rejects_degenerate_floors() {
        let queue_floor = Term09Config {
            queue_max_bytes: TERM09_QUEUE_MAX_BYTES_FLOOR - 1,
            catastrophic_buffered_bytes: 64 * 1024 * 1024,
            catastrophic_stall_ms: 10_000,
        };
        let err = queue_floor.validate().expect_err("queue floor");
        let message = err.to_string();
        assert!(
            message.contains("TERMINAL_CLIENT_QUEUE_MAX_BYTES"),
            "the error must name the offending env var: {message}"
        );
        let stall_floor = Term09Config {
            queue_max_bytes: 16 * 1024 * 1024,
            catastrophic_buffered_bytes: 64 * 1024 * 1024,
            catastrophic_stall_ms: TERM09_CATASTROPHIC_STALL_MS_FLOOR - 1,
        };
        let err = stall_floor.validate().expect_err("stall floor");
        let message = err.to_string();
        assert!(
            message.contains("TERMINAL_WS_CATASTROPHIC_STALL_MS"),
            "the error must name the offending env var: {message}"
        );
        // The floors themselves validate.
        Term09Config {
            queue_max_bytes: TERM09_QUEUE_MAX_BYTES_FLOOR,
            catastrophic_buffered_bytes: TERM09_QUEUE_MAX_BYTES_FLOOR + 1,
            catastrophic_stall_ms: TERM09_CATASTROPHIC_STALL_MS_FLOOR,
        }
        .validate()
        .expect("floor values must validate");
    }

    /// Env-dependent cases live in ONE test fn: `std::env::set_var` mutates
    /// whole-process state, so parallel sibling tests must not race these
    /// vars. The vars are removed on exit; no other test in this crate reads
    /// them.
    #[test]
    fn from_env_overrides_validate_at_boot_shape() {
        std::env::remove_var("TERMINAL_CLIENT_QUEUE_MAX_BYTES");
        std::env::remove_var("TERMINAL_WS_CATASTROPHIC_BUFFERED_BYTES");
        std::env::remove_var("TERMINAL_WS_CATASTROPHIC_STALL_MS");

        // Unset -> defaults, which must satisfy the ordering.
        let defaults = Term09Config::from_env();
        defaults
            .validate()
            .expect("unset env must yield valid defaults");

        // An override that inverts the ordering must fail validation.
        std::env::set_var("TERMINAL_WS_CATASTROPHIC_BUFFERED_BYTES", "1048576");
        let inverted = Term09Config::from_env();
        let err = inverted
            .validate()
            .expect_err("an inverted env override must fail validation");
        assert_eq!(
            err,
            Term09ConfigError::DisconnectNotAboveSpill {
                queue_bytes: defaults.queue_max_bytes,
                catastrophic_bytes: 1024 * 1024,
            }
        );

        // Valid overrides pass.
        std::env::remove_var("TERMINAL_WS_CATASTROPHIC_BUFFERED_BYTES");
        std::env::set_var("TERMINAL_CLIENT_QUEUE_MAX_BYTES", "2097152");
        std::env::set_var("TERMINAL_WS_CATASTROPHIC_BUFFERED_BYTES", "8388608");
        let tuned = Term09Config::from_env();
        assert_eq!(tuned.queue_max_bytes, 2 * 1024 * 1024);
        assert_eq!(tuned.catastrophic_buffered_bytes, 8 * 1024 * 1024);
        tuned
            .validate()
            .expect("ordered env overrides must validate");

        std::env::remove_var("TERMINAL_CLIENT_QUEUE_MAX_BYTES");
        std::env::remove_var("TERMINAL_WS_CATASTROPHIC_BUFFERED_BYTES");
        std::env::remove_var("TERMINAL_WS_CATASTROPHIC_STALL_MS");
    }

    #[test]
    fn catastrophic_monitor_never_fires_under_threshold() {
        let mut m = CatastrophicMonitor::new(100, 10);
        for _ in 0..5 {
            assert!(m.tick(50, 0).is_none());
            std::thread::sleep(Duration::from_millis(15));
        }
    }

    #[test]
    fn catastrophic_monitor_resets_on_recovery_before_stall_elapses() {
        let mut m = CatastrophicMonitor::new(100, 1000);
        assert!(m.tick(200, 0).is_none()); // starts the clock
        assert!(m.tick(50, 0).is_none()); // recovers immediately -> resets
        std::thread::sleep(Duration::from_millis(5));
        // Overflow again: a FRESH clock, so it must not have carried over
        // elapsed time from the first (reset) episode.
        assert!(m.tick(200, 0).is_none());
    }

    #[test]
    fn catastrophic_monitor_fires_after_sustained_overflow() {
        let mut m = CatastrophicMonitor::new(100, 20);
        assert!(m.tick(200, 0).is_none());
        std::thread::sleep(Duration::from_millis(35));
        assert!(
            m.tick(200, 0).is_some(),
            "sustained overflow past the stall duration must fire"
        );
    }

    /// Drain-progress liveness (responsive-terminal-restore Workstream 3):
    /// successful sends reset the sustained window even while pending bytes
    /// stay over the threshold — a slow-but-progressing client is not a dead
    /// socket.
    #[test]
    fn send_progress_resets_the_stall_window() {
        let mut m = CatastrophicMonitor::new(100, 40);
        assert!(m.tick(200, 0).is_none()); // starts the clock
        std::thread::sleep(Duration::from_millis(25));
        assert!(m.tick(200, 1).is_none()); // a send completed -> resets the window
        std::thread::sleep(Duration::from_millis(30));
        // 55 ms since the FIRST over-threshold tick — past the 40 ms window —
        // but only 30 ms since the progress reset: must NOT fire.
        assert!(
            m.tick(200, 0).is_none(),
            "the window must restart from the last progress, not the first tick"
        );
        // With no further progress it DOES fire after the full window.
        std::thread::sleep(Duration::from_millis(45));
        assert!(m.tick(200, 0).is_some());
    }

    /// Eviction and supersede reduce queue bytes WITHOUT a send; those byte
    /// reductions must never masquerade as drain progress. The monitor only
    /// sees completed sends, so over-threshold bytes with zero sends close on
    /// schedule no matter how the byte count wiggles.
    #[test]
    fn byte_reductions_without_sends_do_not_reset_the_window() {
        let mut m = CatastrophicMonitor::new(100, 30);
        assert!(m.tick(180, 0).is_none()); // starts the clock
        std::thread::sleep(Duration::from_millis(10));
        assert!(m.tick(150, 0).is_none()); // "eviction" shrank the count; still over, no sends
        std::thread::sleep(Duration::from_millis(10));
        assert!(m.tick(190, 0).is_none()); // refilled; still no sends
        std::thread::sleep(Duration::from_millis(15));
        assert!(
            m.tick(160, 0).is_some(),
            "over-threshold bytes with zero sends across the whole window must close"
        );
    }

    /// Task-007 review M3 (landed by task-010): the fire evidence carries
    /// `sends_in_window` — completed sends DURING the deciding window for
    /// THIS occurrence, not the caller's lifetime counter. A
    /// progress-then-wedge episode must report ZERO window sends even though
    /// sends happened before the window opened; structurally the field is
    /// always 0 at fire time (any send resets the window), so a nonzero
    /// value is accounting drift the log line exposes directly.
    #[test]
    fn fire_evidence_reports_sends_inside_the_deciding_window_not_the_lifetime() {
        let mut m = CatastrophicMonitor::new(100, 30);
        // Wedge-after-progress: sends complete while over threshold (each
        // resets the window), then a sustained zero-send window fires.
        assert!(m.tick(200, 7).is_none(), "send progress resets the window");
        std::thread::sleep(Duration::from_millis(10));
        assert!(
            m.tick(200, 4).is_none(),
            "more progress, window keeps resetting"
        );
        // The next over-threshold zero-send tick OPENS the deciding window;
        // it cannot fire yet.
        assert!(m.tick(200, 0).is_none(), "the window opens, not fires");
        std::thread::sleep(Duration::from_millis(35));
        let Some(fire) = m.tick(200, 0) else {
            panic!("the sustained zero-send window must fire");
        };
        assert_eq!(
            fire.sends_in_window, 0,
            "no sends completed inside the deciding window — the per-occurrence \
             evidence must say so directly (a lifetime counter would read 11 here)"
        );
        // A second sustained episode after the fire starts a FRESH window
        // with fresh evidence (the monitor reports one occurrence per
        // sustained episode; the caller closes the connection on fire).
        assert!(
            m.tick(200, 0).is_none(),
            "post-fire ticks open a fresh window"
        );
        std::thread::sleep(Duration::from_millis(35));
        let Some(second) = m.tick(200, 0) else {
            panic!("the second sustained window must fire too");
        };
        assert_eq!(second.sends_in_window, 0);
    }
}
