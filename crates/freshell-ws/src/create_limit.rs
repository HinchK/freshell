//! Server-side `terminal.create` protection knobs + the per-connection
//! sliding-window rate limiter (legacy parity: `server/ws-handler.ts:240-241,
//! 2376-2389`).
//!
//! Legacy limiter semantics reproduced EXACTLY:
//! - default 10 creates per 10_000 ms sliding window, per WS connection
//! - env `TERMINAL_CREATE_RATE_LIMIT` / `TERMINAL_CREATE_RATE_WINDOW_MS`
//! - prune predicate is strict: a timestamp survives while `now - t < window`
//! - a REJECTED create consumes no budget (timestamps push on accept only)
//! - `restore:true` creates bypass the limiter entirely (the CALLER enforces
//!   the bypass; this type is bypass-agnostic) — they are bounded by the
//!   [`crate::spawn_gate::RestoreSpawnGate`] instead.
//!
//! Deliberate env-parsing divergence from legacy: legacy is
//! `Number(env || default)`, which silently DISABLES the limiter on an
//! unparseable value and blocks ALL creates on `'0'`. We sanitize instead:
//! unset, unparseable, zero, or negative -> default.
//!
//! The restore-spawn-gate knobs (WSL-outage RCA §6.3 hardening, no legacy
//! analogue on this branch — see [`crate::spawn_gate`]) live in the same
//! config struct to keep the `WsState` surface change to two fields.

use std::collections::VecDeque;

#[derive(Debug, Clone, Copy)]
pub struct CreateProtectConfig {
    /// Max accepted non-restore `terminal.create` per window, per connection.
    pub rate_limit: usize,
    /// Sliding-window length, ms.
    pub rate_window_ms: u64,
    /// Server-wide max concurrent restore-flagged creates (gate permits).
    pub restore_spawn_concurrency: usize,
    /// Max restore creates queued waiting on the gate before failing loud.
    pub restore_spawn_queue_cap: usize,
    /// Max wait for a gate permit before failing loud, ms. Must stay far
    /// below the frozen client's ~38s RATE_LIMITED retry-ladder patience.
    pub restore_spawn_timeout_ms: u64,
}

impl Default for CreateProtectConfig {
    fn default() -> Self {
        Self {
            rate_limit: 10,
            rate_window_ms: 10_000,
            restore_spawn_concurrency: 4,
            restore_spawn_queue_cap: 64,
            restore_spawn_timeout_ms: 10_000,
        }
    }
}

/// Sanitizing env parse (same shape as the private helpers in
/// `crate::backpressure`): unset, unparseable, zero, or negative -> default.
fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|&v| v > 0)
        .unwrap_or(default)
}

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&v| v > 0)
        .unwrap_or(default)
}

impl CreateProtectConfig {
    /// Resolve from process env. Rate-limit names mirror legacy
    /// (`server/ws-handler.ts:240-241`); the restore-spawn names are the
    /// spec's `TERMINAL_RESTORE_SPAWN_*` family.
    pub fn from_env() -> Self {
        let d = Self::default();
        Self {
            rate_limit: env_usize("TERMINAL_CREATE_RATE_LIMIT", d.rate_limit),
            rate_window_ms: env_u64("TERMINAL_CREATE_RATE_WINDOW_MS", d.rate_window_ms),
            restore_spawn_concurrency: env_usize(
                "TERMINAL_RESTORE_SPAWN_CONCURRENCY",
                d.restore_spawn_concurrency,
            ),
            restore_spawn_queue_cap: env_usize(
                "TERMINAL_RESTORE_SPAWN_QUEUE_CAP",
                d.restore_spawn_queue_cap,
            ),
            restore_spawn_timeout_ms: env_u64(
                "TERMINAL_RESTORE_SPAWN_TIMEOUT_MS",
                d.restore_spawn_timeout_ms,
            ),
        }
    }
}

/// Per-connection sliding window of accept timestamps (epoch ms). One
/// instance per WS connection, constructed in `terminal::run` — fresh/empty
/// on reconnect, exactly like legacy `ClientState.terminalCreateTimestamps`.
#[derive(Debug)]
pub struct CreateRateLimiter {
    timestamps: VecDeque<u64>,
    limit: usize,
    window_ms: u64,
}

impl CreateRateLimiter {
    pub fn new(limit: usize, window_ms: u64) -> Self {
        Self {
            timestamps: VecDeque::new(),
            limit,
            window_ms,
        }
    }

    /// Prune expired entries (strict `now - t < window` survival, legacy
    /// parity), then either reject (recording NOTHING) or record-and-accept.
    pub fn try_acquire(&mut self, now_ms: u64) -> bool {
        while let Some(&oldest) = self.timestamps.front() {
            if now_ms.saturating_sub(oldest) < self.window_ms {
                break;
            }
            self.timestamps.pop_front();
        }
        if self.timestamps.len() >= self.limit {
            return false;
        }
        self.timestamps.push_back(now_ms);
        true
    }
}

/// Wall-clock epoch milliseconds for limiter stamping.
pub fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_up_to_limit_then_rejects() {
        let mut l = CreateRateLimiter::new(10, 10_000);
        for _ in 0..10 {
            assert!(l.try_acquire(0));
        }
        assert!(
            !l.try_acquire(0),
            "11th create in the window must be rejected"
        );
    }

    #[test]
    fn rejection_consumes_no_budget() {
        let mut l = CreateRateLimiter::new(2, 10_000);
        assert!(l.try_acquire(0));
        assert!(l.try_acquire(0));
        assert!(!l.try_acquire(1_000));
        assert!(!l.try_acquire(2_000));
        // At t=10_000 both accepted stamps (t=0) expire (strict `<`). If the
        // two REJECTIONS had been recorded, capacity would still be 0.
        assert!(l.try_acquire(10_000));
        assert!(l.try_acquire(10_000));
    }

    #[test]
    fn prune_boundary_is_strict_legacy_parity() {
        // Legacy keeps `now - t < windowMs`: at exactly `window` the stamp expires.
        let mut l = CreateRateLimiter::new(1, 10_000);
        assert!(l.try_acquire(0));
        assert!(
            !l.try_acquire(9_999),
            "at now-t=9_999 the stamp still counts"
        );
        assert!(l.try_acquire(10_000), "at now-t=10_000 the stamp is pruned");
    }

    #[test]
    fn window_slides_per_entry() {
        let mut l = CreateRateLimiter::new(2, 10_000);
        assert!(l.try_acquire(0));
        assert!(l.try_acquire(5_000));
        assert!(!l.try_acquire(9_999));
        // t=0 expired at 10_000; t=5_000 still live; one slot free.
        assert!(l.try_acquire(10_000));
        assert!(!l.try_acquire(10_001), "5_000 and 10_000 both in window");
    }

    #[test]
    fn config_defaults() {
        let c = CreateProtectConfig::default();
        assert_eq!(c.rate_limit, 10);
        assert_eq!(c.rate_window_ms, 10_000);
        assert_eq!(c.restore_spawn_concurrency, 4);
        assert_eq!(c.restore_spawn_queue_cap, 64);
        assert_eq!(c.restore_spawn_timeout_ms, 10_000);
    }

    #[test]
    fn config_from_env_overrides_and_zero_falls_back() {
        // `std::env::set_var` mutates whole-process state; this is the ONLY
        // test in this binary touching these five names, and it restores them.
        let names = [
            "TERMINAL_CREATE_RATE_LIMIT",
            "TERMINAL_CREATE_RATE_WINDOW_MS",
            "TERMINAL_RESTORE_SPAWN_CONCURRENCY",
            "TERMINAL_RESTORE_SPAWN_QUEUE_CAP",
            "TERMINAL_RESTORE_SPAWN_TIMEOUT_MS",
        ];
        for n in names {
            std::env::remove_var(n);
        }
        let d = CreateProtectConfig::default();

        // unset -> defaults
        let c = CreateProtectConfig::from_env();
        assert_eq!(c.rate_limit, d.rate_limit);
        assert_eq!(c.restore_spawn_concurrency, d.restore_spawn_concurrency);

        // valid positive override takes effect
        std::env::set_var("TERMINAL_CREATE_RATE_LIMIT", "20");
        std::env::set_var("TERMINAL_CREATE_RATE_WINDOW_MS", "20000");
        std::env::set_var("TERMINAL_RESTORE_SPAWN_CONCURRENCY", "8");
        std::env::set_var("TERMINAL_RESTORE_SPAWN_QUEUE_CAP", "128");
        std::env::set_var("TERMINAL_RESTORE_SPAWN_TIMEOUT_MS", "20000");
        let c = CreateProtectConfig::from_env();
        assert_eq!(c.rate_limit, 20);
        assert_eq!(c.rate_window_ms, 20_000);
        assert_eq!(c.restore_spawn_concurrency, 8);
        assert_eq!(c.restore_spawn_queue_cap, 128);
        assert_eq!(c.restore_spawn_timeout_ms, 20_000);

        // '0' and garbage -> fallback to default
        for n in names {
            std::env::set_var(n, "0");
        }
        let c = CreateProtectConfig::from_env();
        assert_eq!(c.restore_spawn_concurrency, d.restore_spawn_concurrency);
        for n in names {
            std::env::set_var(n, "not-a-number");
        }
        let c = CreateProtectConfig::from_env();
        assert_eq!(c.rate_limit, d.rate_limit);

        for n in names {
            std::env::remove_var(n);
        }
    }

    #[test]
    fn epoch_ms_returns_nonzero() {
        assert!(epoch_ms() > 0);
    }
}
