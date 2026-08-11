# pty.rs Review Nits (PR #634 Adversarial Review) Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Fix two confirmed, non-blocking review nits in
`crates/freshell-terminal/src/pty.rs` from PR #634's adversarial review: (1)
remove a redundant per-frame clone in the reader-thread sink hot path, and (2)
add `#[cfg(unix)]` to a unix-only test.

**Architecture:** Both changes live in a single file. Nit 1 restructures the
`emit` closure inside `spawn_reader` from two independent `if` blocks into an
`if/else`, so the sink branch can consume the `Vec<ServerMessage>` by value
(the `MessageSink` type already takes `ServerMessage` by value — the clone is
pure waste). The two destinations are mutually exclusive by construction
(`capture_enabled = sink.is_none()`), so the `if/else` shape makes that
exclusivity visible to the borrow checker and lets `capture_enabled` be
deleted. Nit 2 adds one attribute line to a test that hardcodes `/bin/sh`.

**Tech Stack:** Rust (workspace toolchain; CI pins 1.96.0), `cargo test`,
`cargo fmt`, `cargo clippy`. Crate `freshell-terminal` is deliberately
tokio-free; its tests are plain `#[test]` functions using
`Arc<Mutex<Vec<ServerMessage>>>` sinks and `std::sync::mpsc` exit hooks.

## Global Constraints

- Scope: modify ONLY `crates/freshell-terminal/src/pty.rs`. No other source
  file changes.
- Do NOT modify `.kata.toml` (kata task id: e2rj; task closure happens
  outside this run).
- `cargo test -p freshell-terminal` must pass after each task.
- CI lint gates (from `.github/workflows/rust-clippy.yml`, toolchain pinned
  to 1.96.0): `cargo fmt --all --check` and
  `cargo clippy --workspace --all-targets -- -D warnings` must both pass.
- `-D warnings` implication: after the Nit 1 refactor, `capture_enabled`
  would be an unused variable if left behind — it MUST be deleted as part of
  the refactor (this is compile-blocking, not style).
- Preserve behavior exactly: sink receives every framed message in the SAME
  seq order it is produced (single producer, in-order forwarding); with a
  sink wired, the in-memory capture stays empty.
- Do not run `gh pr create` or restart any live server; commits stay on the
  worktree branch (`the-usual/pty-review-nits-e2rj` in
  `/home/dan/code/freshell/.worktrees/pty-review-nits-e2rj`).
- README.md is the only end-user markdown doc; this plan under `docs/plans/`
  is a working/agent doc. Do not create other markdown docs.

---

### Task 1: By-value sink forwarding in the `emit` closure (Nit 1)

**Files:**
- Modify: `crates/freshell-terminal/src/pty.rs:479-501` (the `emit` closure
  inside `spawn_reader`)
- Test: `crates/freshell-terminal/src/pty.rs:665-730` (strengthen the
  existing test `spawn_with_sink_does_not_accumulate_captured_messages` with
  a seq-order assertion)

**Interfaces:**
- Consumes: `MessageSink = Box<dyn FnMut(ServerMessage) + Send>`
  (`pty.rs:46`) — already takes `ServerMessage` by value, so no signature
  change anywhere. `ServerMessage::TerminalOutput(TerminalOutput)` where
  `TerminalOutput` has `pub seq_start: i64` and `pub seq_end: i64`
  (`crates/freshell-protocol/src/server_messages.rs:1033-1043`).
- Produces: nothing new — internal refactor of a private closure. Task 2
  does not depend on this task.

**TDD note (why there is no RED step):** This is a behavior-preserving
performance refactor — no observable behavior changes, so no test can fail
before the change. The TDD-for-refactoring discipline applies instead:
strengthen the safety net FIRST (add a seq-ordering assertion to the
existing sink test, proving in-order delivery — the property the refactor
must preserve), confirm green, then refactor under that net, and confirm
green again. The strengthened assertion is the cheap coverage upgrade the
spec asked for ("if a cheap additional assertion can strengthen coverage of
by-value forwarding order, add it") — it goes into the existing test rather
than a new test, per "do not over-engineer".

- [ ] **Step 1: Baseline — run the pty test module and confirm it is green**

Run (from the worktree root `/home/dan/code/freshell/.worktrees/pty-review-nits-e2rj`):

```bash
cargo test -p freshell-terminal pty::tests -- --nocapture
```

Expected: PASS — 4 tests run, 0 failed
(`build_child_env_strips_and_overrides`,
`spawn_bare_name_shadowed_by_cwd_directory_runs_real_path_binary`,
`spawn_with_sink_does_not_accumulate_captured_messages`,
`spawn_missing_bare_name_returns_not_found_error`).

If this baseline is not green, STOP and report — do not proceed on a broken
baseline.

- [ ] **Step 2: Strengthen the existing sink test with a seq-order assertion**

In `crates/freshell-terminal/src/pty.rs`, inside
`spawn_with_sink_does_not_accumulate_captured_messages`, immediately AFTER
the existing "sink must receive the child's terminal.output frames"
assertion (currently ends at line 722) and BEFORE the
`let captured = terminal.captured_messages();` line (currently line 723),
insert:

```rust
        // By-value forwarding must preserve production order: the reader
        // thread is the single producer, so frames must arrive at the sink
        // with non-decreasing seq ranges.
        let mut last_seq_end = i64::MIN;
        for message in streamed.iter() {
            if let ServerMessage::TerminalOutput(frame) = message {
                assert!(
                    frame.seq_start >= last_seq_end,
                    "sink frames arrived out of seq order: seq_start {} after seq_end {}",
                    frame.seq_start,
                    last_seq_end
                );
                assert!(
                    frame.seq_end >= frame.seq_start,
                    "frame seq range inverted: {}..{}",
                    frame.seq_start,
                    frame.seq_end
                );
                last_seq_end = frame.seq_end;
            }
        }
```

The assertions deliberately assume only monotonicity (non-decreasing), not a
specific starting value or inclusive/exclusive `seq_end` convention — they
hold under either convention and any starting seq.

- [ ] **Step 3: Run the strengthened test — confirm it passes (safety net established)**

```bash
cargo test -p freshell-terminal pty::tests::spawn_with_sink_does_not_accumulate_captured_messages -- --exact --nocapture
```

Expected: PASS (1 passed, 0 failed). The current code already delivers in
order — this assertion's job is to fail loudly if the refactor in Step 4
ever breaks ordering.

- [ ] **Step 4: Refactor the `emit` closure to forward by value**

In `crates/freshell-terminal/src/pty.rs`, inside `spawn_reader`, replace the
current block (lines 479-501):

```rust
    // With a live sink wired (production), forward each framed message to it in
    // the SAME seq order it is produced (single producer). Without a sink
    // (harness/capture mode), append to the in-memory capture instead. Never
    // both: `captured` is unread in production and accumulating there was an
    // unbounded write-only leak for the terminal's whole life.
    let capture_enabled = sink.is_none();
    let mut emit = move |messages: Vec<ServerMessage>| {
        if messages.is_empty() {
            return;
        }
        if let Some(sink) = sink.as_mut() {
            for message in &messages {
                sink(message.clone());
            }
        }
        if capture_enabled {
            captured
                .lock()
                .expect("captured mutex")
                .messages
                .extend(messages);
        }
    };
```

with:

```rust
    // With a live sink wired (production), forward each framed message to it in
    // the SAME seq order it is produced (single producer). Without a sink
    // (harness/capture mode), append to the in-memory capture instead. Never
    // both: `captured` is unread in production and accumulating there was an
    // unbounded write-only leak for the terminal's whole life.
    let mut emit = move |messages: Vec<ServerMessage>| {
        if messages.is_empty() {
            return;
        }
        if let Some(sink) = sink.as_mut() {
            // Production: the sink takes `ServerMessage` by value, so hand
            // the frames over by value — cloning here was a redundant deep
            // copy of every output frame's `data` String in the hot path.
            for message in messages {
                sink(message);
            }
        } else {
            // Harness/capture mode (no sink): the capture owns the frames.
            captured
                .lock()
                .expect("captured mutex")
                .messages
                .extend(messages);
        }
    };
```

Notes for the implementer:
- `capture_enabled` (old line 484) is DELETED — the `else` branch is
  reachable exactly when `sink.is_none()`, which is what `capture_enabled`
  encoded. Leaving it would fail CI's `-D warnings` as an unused variable.
- Do NOT change the `spawn_reader` signature — `mut sink: Option<MessageSink>`
  stays `mut` (needed for `sink.as_mut()`).
- The `if/else` shape is what makes by-value iteration compile: the borrow
  checker sees `messages` is moved in exactly one branch.
- Both call sites of `emit` (`pty.rs:512` and `:523`) pass freshly built
  rvalue `Vec`s and never reuse them — no caller change needed.

- [ ] **Step 5: Run the pty test module — all green**

```bash
cargo test -p freshell-terminal pty::tests -- --nocapture
```

Expected: PASS — 4 passed, 0 failed. The strengthened sink test proves the
sink still receives `TerminalOutput` frames, in seq order, and that
`captured_messages()` stays empty with a sink wired.

- [ ] **Step 6: Format and lint the change**

```bash
cargo fmt --all
cargo clippy -p freshell-terminal --all-targets -- -D warnings
```

Expected: fmt makes no unexpected changes beyond the edited region; clippy
exits 0 with no warnings. (The workspace-wide CI-parity clippy run happens
in Task 2 Step 3 as the final gate.)

- [ ] **Step 7: Commit**

```bash
git -C /home/dan/code/freshell/.worktrees/pty-review-nits-e2rj add crates/freshell-terminal/src/pty.rs
git -C /home/dan/code/freshell/.worktrees/pty-review-nits-e2rj commit -m "perf(terminal): forward sink messages by value in pty reader hot path

The emit closure cloned every ServerMessage for the sink and then dropped
the originals — one redundant deep copy of each output frame's data String
per frame, in the hottest path in the terminal server. Sink and capture
destinations are mutually exclusive (capture is gated on sink absence), so
restructure as if/else and iterate by value; delete the now-redundant
capture_enabled flag. Strengthens the sink gate test with a seq-order
assertion so in-order forwarding is pinned by a test.

From PR #634 adversarial review (nit 1, kata e2rj)."
```

---

### Task 2: `#[cfg(unix)]` on the unix-only sink test (Nit 2)

**Files:**
- Modify: `crates/freshell-terminal/src/pty.rs:670` (attribute block of
  `spawn_with_sink_does_not_accumulate_captured_messages`; line number is
  pre-Task-1 — after Task 1 the test body is ~20 lines longer, but the
  attribute location is found by the test name, not the line number)

**Interfaces:**
- Consumes: nothing from Task 1 (the tasks touch different regions of the
  same file; Task 1 added assertion lines inside this test's body but did
  not touch its attributes).
- Produces: nothing — test-only hygiene change.

**TDD note:** This is test-only hygiene (an attribute on an existing test) —
there is no production behavior to drive test-first. Verification is that
the test remains compiled-in and green on Linux (this repo's dev/CI
platform), and the module still builds cleanly under the CI lint gates.

- [ ] **Step 1: Add the `#[cfg(unix)]` attribute**

In `crates/freshell-terminal/src/pty.rs`, find the test
`spawn_with_sink_does_not_accumulate_captured_messages` and add
`#[cfg(unix)]` directly above its `#[test]` attribute (below the doc
comment), changing:

```rust
    /// The in-memory capture is a HARNESS seam, not a production buffer.
    /// When a live `sink` is wired (the production path,
    /// `TerminalRegistry::create`), NOTHING may accumulate in `captured`:
    /// before the gate it grew unboundedly for the terminal's whole life
    /// (a multi-GB write-only leak on long-lived terminals).
    #[test]
    fn spawn_with_sink_does_not_accumulate_captured_messages() {
```

to:

```rust
    /// The in-memory capture is a HARNESS seam, not a production buffer.
    /// When a live `sink` is wired (the production path,
    /// `TerminalRegistry::create`), NOTHING may accumulate in `captured`:
    /// before the gate it grew unboundedly for the terminal's whole life
    /// (a multi-GB write-only leak on long-lived terminals).
    #[cfg(unix)]
    #[test]
    fn spawn_with_sink_does_not_accumulate_captured_messages() {
```

Scope notes for the implementer (do NOT expand the change):
- This is a consistency/intent fix, not a Windows-clean fix: the test module
  already contains unconditional unix-only content nearby (the
  `write_marker_script` helper at ~line 607 uses
  `std::os::unix::fs::PermissionsExt` and writes a `#!/bin/sh` script), so
  the module as a whole does not compile on Windows regardless. Gating that
  helper is out of scope for this nit — leave it alone.
- The `#[cfg(unix)]` attribute idiom already appears in this file's non-test
  code (~line 381), so this matches established style.

- [ ] **Step 2: Run the pty test module — the test must still run on Linux**

```bash
cargo test -p freshell-terminal pty::tests -- --nocapture
```

Expected: PASS — 4 passed, 0 failed, and the output MUST still list
`pty::tests::spawn_with_sink_does_not_accumulate_captured_messages` as an
executed test (i.e., the cfg gate did not accidentally exclude it on this
unix platform). If only 3 tests run, the attribute was misplaced — stop and
fix.

- [ ] **Step 3: Full-crate tests plus CI-parity fmt/clippy gates**

```bash
cargo test -p freshell-terminal
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: all `freshell-terminal` tests (unit + integration, e.g.
`t1_golden_repro`, `batch_wire_golden`) pass with 0 failed; `cargo fmt
--all --check` exits 0 with no diff; workspace clippy exits 0 with no
warnings. These are exactly the gates CI runs
(`.github/workflows/rust-clippy.yml`; CI pins toolchain 1.96.0 — if the
local toolchain differs and clippy reports lints CI would not, fix them
anyway so both pass).

- [ ] **Step 4: Commit**

```bash
git -C /home/dan/code/freshell/.worktrees/pty-review-nits-e2rj add crates/freshell-terminal/src/pty.rs
git -C /home/dan/code/freshell/.worktrees/pty-review-nits-e2rj commit -m "test(terminal): gate unix-only pty sink test with #[cfg(unix)]

spawn_with_sink_does_not_accumulate_captured_messages hardcodes /bin/sh;
gate it for hygiene/consistency with the file's existing cfg(unix) usage.
The surrounding test module already carries ungated unix-only helpers, so
this is intent documentation, not a new platform break.

From PR #634 adversarial review (nit 2, kata e2rj)."
```
