//! P1.9 (D3) source-order pin: claude's preallocated identity becomes
//! OBSERVABLE at PTY spawn (`--session-id` in argv, logged synchronously by
//! the e2e fakes), so its durable ledger write must PRECEDE the spawn.
//! Reordering these reopens the SIGKILL-within-5s recovery hole
//! (restore-contract-wall `SIGKILL-within-5s-of-pane-creation`).

#[test]
fn claude_binding_write_precedes_pty_spawn_in_handle_create() {
    let src = include_str!("terminal.rs");
    let write = src.find("PIN2_CLAUDE_PRE_SPAWN_BINDING").expect(
        "pre-spawn claude binding block (PIN2_CLAUDE_PRE_SPAWN_BINDING) missing from terminal.rs",
    );
    let spawn = src
        .find("PIN2_PTY_SPAWN_ANCHOR")
        .expect("PTY spawn anchor (PIN2_PTY_SPAWN_ANCHOR) missing from terminal.rs");
    assert!(
        write < spawn,
        "claude durable binding write must stay BEFORE the PTY spawn: durability precedes observability"
    );
}
