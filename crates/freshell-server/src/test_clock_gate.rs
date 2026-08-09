//! HARNESS-14 test-only helper: serialize + scope the process-global
//! shared test-clock override (`freshell_platform::clock`) for this
//! crate's test binary.
//!
//! `TestClockGate::enable(state)` installs the override (on or forced-off),
//! resets the clock, and holds a crate-wide lock so parallel tests cannot
//! interleave gate flips. Drop resets the clock and clears the override.
//! Poison-tolerant: a panicking sibling cannot cascade the clock suites.

use std::sync::{Mutex, MutexGuard};

use freshell_platform::clock;

static LOCK: Mutex<()> = Mutex::new(());

pub struct TestClockGate {
    _guard: MutexGuard<'static, ()>,
}

impl TestClockGate {
    pub fn enable() -> Self {
        Self::locked(true)
    }

    pub fn locked(enabled_state: bool) -> Self {
        let guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
        clock::set_enabled_override_for_tests(Some(enabled_state));
        if enabled_state {
            clock::reset().expect("override just enabled");
        }
        Self { _guard: guard }
    }
}

impl Drop for TestClockGate {
    fn drop(&mut self) {
        clock::set_enabled_override_for_tests(Some(true));
        let _ = clock::reset();
        clock::set_enabled_override_for_tests(None);
    }
}
