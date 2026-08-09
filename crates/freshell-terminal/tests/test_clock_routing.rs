//! HARNESS-14 — routing proof for the `freshell-terminal` idle seam, run as
//! an INTEGRATION binary (its own process) on purpose: the shared test clock
//! is process-global, so overriding it in the crate's unit-test binary would
//! pollute parallel sibling tests (proven: an in-module version of this test
//! froze/advanced the clock under the pre-existing TTL test and turned it
//! red). With a separate process, the override is free to be total.
//!
//! Proves: `TerminalRegistry::enforce_idle_kills` follows virtual
//! `advance_ms()` steps only — frozen time never ages a terminal, and two
//! fixtures created at different frozen instants reap in deterministic
//! order. Zero wall-clock sleeps for the virtual waits.

use std::sync::{Mutex, MutexGuard};

use freshell_terminal::registry::{HeadlessTerminal, TerminalRegistry};

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

fn headless(reg: &TerminalRegistry, id: &str) {
    reg.register_headless(HeadlessTerminal {
        terminal_id: id.to_string(),
        stream_id: format!("S-{id}"),
        mode: "shell".to_string(),
        resume_session_id: None,
        create_request_id: None,
        created_at: None, // stamped from the (routed) clock
    });
}

#[test]
fn enforce_idle_kills_follows_the_shared_test_clock_when_enabled() {
    let _gate = GateGuard::enable();
    let reg = TerminalRegistry::new();
    headless(&reg, "T-frozen-A");
    reg.set_auto_kill_idle_minutes(15);

    // Frozen clock: real elapsed time is irrelevant — no reap.
    freshell_platform::clock::freeze().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(25));
    assert!(
        reg.enforce_idle_kills().is_empty(),
        "frozen time is idle-0 for a freshly created terminal"
    );

    // Cross the 15-minute threshold in one virtual step: A reaps.
    freshell_platform::clock::advance_ms(16 * 60_000).unwrap();
    assert_eq!(
        reg.enforce_idle_kills(),
        vec!["T-frozen-A".to_string()],
        "advancing the shared clock past the threshold must reap"
    );
    assert!(reg.inventory().is_empty());

    // A terminal created at a LATER frozen instant survives a step that
    // only carries it to 11 idle minutes (deterministic fixture ordering).
    freshell_platform::clock::reset().unwrap();
    freshell_platform::clock::freeze().unwrap();
    headless(&reg, "T-frozen-B");
    freshell_platform::clock::advance_ms(11 * 60_000).unwrap();
    assert!(reg.enforce_idle_kills().is_empty(), "B is 11min < 15min");
    freshell_platform::clock::advance_ms(5 * 60_000).unwrap();
    assert_eq!(reg.enforce_idle_kills(), vec!["T-frozen-B".to_string()]);
}
