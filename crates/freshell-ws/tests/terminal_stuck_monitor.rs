//! Wedge-backstop Task 3: the stuck-monitor driver seams in `freshell-ws`.
//!
//! Cross-crate discipline (plan Task 3): the wedged row state — meaningful
//! clock stale past the window WHILE raw output stays fresh — is only
//! constructible through the registry crate's in-file test helpers
//! (`feed`/`backdate_last_activity`), NOT via this crate's public API, so
//! these tests drive the PURE frame seam with constructed transitions. The
//! sweep itself is pinned by Task 1's in-file suite; the end-to-end flag
//! (sweep → broadcast → card) is the e2e's job. What THIS file pins is the
//! wire shape the monitor broadcasts and the env contract that seeds its
//! window.

use freshell_ws::broadcast_stuck_frame;

#[test]
fn stuck_frames_serialize_both_directions() {
    let (tx, mut rx) = tokio::sync::broadcast::channel(64);
    broadcast_stuck_frame(
        &freshell_terminal::StuckTransition {
            terminal_id: "T".into(),
            mode: "opencode".into(),
            stuck: true,
            at: 123,
        },
        &tx,
    );
    let first = rx.try_recv().unwrap();
    assert!(first.contains("\"type\":\"terminal.stuck\""));
    assert!(first.contains("\"stuck\":true"));
    assert!(first.contains("\"terminalId\":\"T\""));
    assert!(first.contains("\"at\":123"));

    broadcast_stuck_frame(
        &freshell_terminal::StuckTransition {
            terminal_id: "T".into(),
            mode: "opencode".into(),
            stuck: false,
            at: 456,
        },
        &tx,
    );
    let clear = rx.try_recv().unwrap();
    assert!(clear.contains("\"stuck\":false"));
}

#[test]
fn stuck_window_env_contract_defaults_parses_and_passes_disable_sentinels() {
    // The env contract mirrors `auto_kill_idle_minutes`' disable semantics,
    // NOT the freshcodex `filter(|ms| *ms > 0)` one: any parseable integer
    // is used AS-IS — 0/negative are valid DISABLE sentinels the registry
    // sweep reads, not fall-back triggers. Only unset/unparseable falls
    // back to the documented 2h default.
    std::env::remove_var("FRESHELL_TERMINAL_STUCK_WINDOW_MS");
    assert_eq!(
        freshell_ws::stuck_window_ms_from_env(),
        freshell_terminal::DEFAULT_STUCK_WINDOW_MS,
        "unset env must keep the documented default"
    );
    std::env::set_var("FRESHELL_TERMINAL_STUCK_WINDOW_MS", "12345");
    assert_eq!(freshell_ws::stuck_window_ms_from_env(), 12345);
    std::env::set_var("FRESHELL_TERMINAL_STUCK_WINDOW_MS", "0");
    assert_eq!(
        freshell_ws::stuck_window_ms_from_env(),
        0,
        "0 is the documented disable sentinel — passed through, not defaulted"
    );
    std::env::set_var("FRESHELL_TERMINAL_STUCK_WINDOW_MS", "-1");
    assert_eq!(
        freshell_ws::stuck_window_ms_from_env(),
        -1,
        "negative disables too — passed through, not defaulted"
    );
    std::env::set_var("FRESHELL_TERMINAL_STUCK_WINDOW_MS", "not-a-number");
    assert_eq!(
        freshell_ws::stuck_window_ms_from_env(),
        freshell_terminal::DEFAULT_STUCK_WINDOW_MS,
        "unparseable falls back to the default"
    );
    std::env::remove_var("FRESHELL_TERMINAL_STUCK_WINDOW_MS");
}
