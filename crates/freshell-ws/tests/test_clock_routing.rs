//! HARNESS-14 — routing proofs for the `freshell-ws` seams, run as an
//! INTEGRATION binary (its own process) on purpose: the shared test clock is
//! process-global, so overriding it inside the crate's unit-test binary
//! pollutes parallel siblings (proven RED against the pre-existing
//! `devicecount_excludes_devices...` TTL test before this split).
//!
//! Proves:
//!  1. the 7-day device-display TTL (`tabs.rs` `diagnostic_counts`) follows
//!     virtual `advance_ms()` — a device pushed BEFORE a virtual 8-day step
//!     expires; one pushed AFTER (same real instant) survives;
//!  2. the terminal.create rate window (`create_limit.rs` `epoch_ms()`)
//!     never drains on real time while frozen, and frees instantly on one
//!     virtual step past the window.
//!
//! Zero wall-clock sleeps for the virtual waits.

use std::sync::{Mutex, MutexGuard};

use freshell_ws::create_limit::{epoch_ms, CreateRateLimiter};
use freshell_ws::tabs::TabsRegistry;
use serde_json::{json, Value};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// Serialize + scope the process-global override within THIS binary.
static LOCK: Mutex<()> = Mutex::new(());

struct GateGuard {
    _guard: MutexGuard<'static, ()>,
}

impl GateGuard {
    fn enable() -> Self {
        let guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
        freshell_platform::clock::set_enabled_override_for_tests(Some(true));
        freshell_platform::clock::reset().expect("override enabled");
        Self { _guard: guard }
    }
}

impl Drop for GateGuard {
    fn drop(&mut self) {
        let _ = freshell_platform::clock::reset();
        freshell_platform::clock::set_enabled_override_for_tests(None);
    }
}

fn open_record(tab_key: &str, tab_name: &str, updated_at: i64) -> Value {
    // Same envelope shape as the in-crate tests' helper.
    json!({
        "tabKey": tab_key,
        "tabId": tab_key,
        "tabName": tab_name,
        "status": "open",
        "revision": 1,
        "updatedAt": updated_at,
        "createdAt": updated_at,
        "paneCount": 1,
        "titleSetByUser": true,
        "panes": [],
    })
}

#[test]
fn device_display_ttl_follows_the_shared_test_clock() {
    let _gate = GateGuard::enable();
    let reg = TabsRegistry::new();

    freshell_platform::clock::freeze().unwrap();
    reg.replace_client_snapshot(
        "srv-1",
        "device-old",
        "Old Device",
        "client-1",
        1,
        vec![open_record("t-old", "old tab", 1)],
    )
    .expect("push accepted");

    // Eight virtual days pass with no real elapsed time...
    freshell_platform::clock::advance_ms(8 * DAY_MS).unwrap();

    // ...then a second device registers at the NEW virtual now.
    reg.replace_client_snapshot(
        "srv-1",
        "device-new",
        "New Device",
        "client-2",
        1,
        vec![open_record("t-new", "new tab", 1)],
    )
    .expect("push accepted");

    let (_record_count, device_count) = reg.diagnostic_counts();
    assert_eq!(
        device_count, 1,
        "after a virtual 8-day step, only the post-step device survives the 7-day TTL"
    );
}

#[test]
fn create_rate_window_follows_the_shared_test_clock() {
    let _gate = GateGuard::enable();
    freshell_platform::clock::freeze().unwrap();

    let mut l = CreateRateLimiter::new(1, 10_000);
    assert!(l.try_acquire(epoch_ms()));
    assert!(
        !l.try_acquire(epoch_ms()),
        "frozen time: the second acquire is inside the window forever"
    );
    // Real elapsed time inside the window must not drain it (frozen).
    std::thread::sleep(std::time::Duration::from_millis(20));
    assert!(!l.try_acquire(epoch_ms()), "still frozen — no drain");

    freshell_platform::clock::advance_ms(10_001).unwrap();
    assert!(
        l.try_acquire(epoch_ms()),
        "a virtual step past the window must free the slot"
    );
}
