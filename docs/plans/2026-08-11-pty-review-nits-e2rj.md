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
deleted. Because the existing sink test's `echo` child emits a single
frame (verified — see "Validated baselines" below), Task 1 also adds one
new `#[cfg(unix)]` multi-frame test (~41 KB payload) so the seq-order
safety net actually exercises cross-frame ordering. Nit 2 adds one
attribute line to a test that hardcodes `/bin/sh`.

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

## Validated baselines (load-bearing validation, 2026-08-11)

These facts were verified by running/inspecting in THIS worktree (ledger:
`.worktrees/.the-usual-logs/pty-review-nits-e2rj/load-bearing-ledger.md`);
the implementer can rely on them:

- Local toolchain is rustc/cargo **1.96.0** — byte-identical to the CI pin,
  so local fmt/clippy verdicts predict CI. No `rust-toolchain{,.toml}` file.
- Baseline `cargo test -p freshell-terminal` is green (176+2+1+1 passed,
  0 failed, no flakes), including all 4 `pty::tests`.
- `cargo fmt --all --check` and `cargo clippy --workspace --all-targets --
  -D warnings` are green pre-change, as are CI's feature-gated clippy runs
  for `freshell-codex`/`freshell-opencode` — so Task 1's write-mode
  `cargo fmt --all` cannot touch files outside the edited region, and any
  new lint is attributable to this change.
- Seq contract (replay_ring.rs:125-147; framing.rs tests :178-180,
  :212-214): every `TerminalOutput` frame has `seq_start == seq_end`, and
  seqs are strictly contiguous (+1, never reset) in sink-delivery order.
  The plan's monotonic (`>=`) assertions are therefore safe on correct
  code — they are deliberately weaker than the contract (order is the
  property the refactor must preserve; the test stays valid if the seq
  convention ever changes).
- **Falsified assumption (plan adjusted):** the existing echo test's child
  output (`SINK_ONLY_MARKER\r\n`, 18 bytes) deterministically arrives as
  ONE frame (single 8192-byte read; 20/20 probe runs), so a seq-order
  assertion there is vacuous by itself. Hence Task 1 Step 3 adds a
  multi-frame ordering test whose ~41 KB payload cannot fit in one read of
  the hardcoded 8192-byte reader buffer (pty.rs:505) — guaranteeing >= 6
  frames regardless of the env-tunable fragment budget
  (`TERMINAL_STREAM_BATCH_MAX_BYTES`).

---

### Task 1: By-value sink forwarding in the `emit` closure (Nit 1)

**Files:**
- Modify: `crates/freshell-terminal/src/pty.rs:479-501` (the `emit` closure
  inside `spawn_reader`)
- Test: `crates/freshell-terminal/src/pty.rs:665-730` (strengthen the
  existing test `spawn_with_sink_does_not_accumulate_captured_messages` with
  a seq-order assertion), plus ADD one new `#[cfg(unix)]` test
  `spawn_with_sink_delivers_multi_frame_output_in_seq_order` immediately
  after it (the multi-frame ordering net — see Step 3)

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
strengthen the safety net FIRST (Steps 2-3), confirm green, then refactor
under that net, and confirm green again. The net has two parts because
load-bearing validation FALSIFIED the assumption that the existing echo
test emits multiple frames (it deterministically emits exactly one, so an
ordering assertion there is vacuous by itself): Step 2 adds the cheap
seq-order assertion to the existing sink test (documents the property at
the primary sink test; guards it if that test ever multi-frames), and
Step 3 adds one new multi-frame test whose ~41 KB payload guarantees >= 6
frames, so cross-frame ordering — the property the refactor must
preserve — is genuinely exercised. This stays within "do not
over-engineer": one new test, modeled line-for-line on the existing one.

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

The verified seq contract (see "Validated baselines") is stronger than
these assertions — every frame has `seq_start == seq_end`, strictly
contiguous +1 — but the assertions deliberately check only monotonicity:
order preservation is the property the refactor must protect, and the
test stays valid if the seq convention ever changes. Note this test's
child emits exactly ONE frame (verified), so the loop is near-vacuous
here; it documents the property at the primary sink test and guards it
if this test ever multi-frames. The real cross-frame net is Step 3.

- [ ] **Step 3: Add the multi-frame seq-order test (the real ordering net)**

In `crates/freshell-terminal/src/pty.rs`, immediately AFTER the closing
brace of `spawn_with_sink_does_not_accumulate_captured_messages` (and
before `spawn_missing_bare_name_returns_not_found_error`), insert this new
test (modeled line-for-line on the existing sink test):

```rust
    /// By-value forwarding must preserve production order across MANY
    /// frames. The echo test above emits a single frame (its 18-byte
    /// output arrives in one 8192-byte read), which makes ordering
    /// assertions vacuous there — so this test forces ~41 KB of output,
    /// which cannot fit in one fill of the reader's hardcoded 8192-byte
    /// buffer, guaranteeing multiple frames regardless of the
    /// env-tunable fragment budget.
    #[cfg(unix)]
    #[test]
    fn spawn_with_sink_delivers_multi_frame_output_in_seq_order() {
        let spec = SpawnSpec {
            program: "/bin/sh".into(),
            args: vec![
                "-c".into(),
                // 512 lines x 79 chars (+ \r\n via the pty) ~= 41 KB.
                "i=0; while [ \"$i\" -lt 512 ]; do echo 0123456789012345678901234567890123456789012345678901234567890123456789012345678; i=$((i+1)); done"
                    .into(),
            ],
            env_overrides: BTreeMap::new(),
            cwd: None,
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
        };
        let mut env = BTreeMap::new();
        env.insert("PATH".to_string(), "/usr/bin:/bin".to_string());
        env.insert(
            "HOME".to_string(),
            std::env::temp_dir().to_string_lossy().into_owned(),
        );

        let sink_messages: Arc<Mutex<Vec<ServerMessage>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_clone = Arc::clone(&sink_messages);
        let sink: MessageSink = Box::new(move |message| {
            sink_clone.lock().expect("sink mutex").push(message);
        });

        let (exit_tx, exit_rx) = std::sync::mpsc::channel();
        let on_exit: ExitHook = Box::new(move |code| {
            let _ = exit_tx.send(code);
        });

        // Bound to `_terminal` (NOT `let _ = ...`, which drops immediately
        // and would kill the child mid-stream): keep the terminal alive
        // until the assertions complete.
        let _terminal = PtyTerminal::spawn_with_sink(
            &spec,
            &env,
            "t-seq-order",
            "s-seq-order",
            None,
            Some(sink),
            Some(on_exit),
        )
        .expect("spawn succeeds");

        // The exit hook fires on the reader thread only after every
        // produced byte has been framed and emitted.
        exit_rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("child exits");

        let streamed = sink_messages.lock().expect("sink mutex");
        let mut frames = 0usize;
        let mut last_seq_end = i64::MIN;
        for message in streamed.iter() {
            if let ServerMessage::TerminalOutput(frame) = message {
                frames += 1;
                assert!(
                    frame.seq_end >= frame.seq_start,
                    "frame seq range inverted: {}..{}",
                    frame.seq_start,
                    frame.seq_end
                );
                assert!(
                    frame.seq_start >= last_seq_end,
                    "sink frames arrived out of seq order: seq_start {} after seq_end {}",
                    frame.seq_start,
                    last_seq_end
                );
                last_seq_end = frame.seq_end;
            }
        }
        assert!(
            frames >= 2,
            "expected multi-frame output to exercise cross-frame ordering, got {frames} frame(s)"
        );
    }
```

Notes for the implementer:
- `#[cfg(unix)]` from birth: the test hardcodes `/bin/sh` (same reason
  Task 2 gates the existing test; idiom already at pty.rs:381). Task 2
  does NOT touch this test.
- The `>= 2` frame-count assertion is what makes the ordering loop
  non-vacuous: ~41 KB cannot arrive in one 8192-byte read, so >= 6 frames
  are guaranteed by construction (kernel pty buffers are far smaller than
  41 KB). Do not shrink the payload below ~17 KB.

- [ ] **Step 4: Run both safety-net tests — confirm they pass (net established)**

```bash
cargo test -p freshell-terminal pty::tests::spawn_with_sink_does_not_accumulate_captured_messages -- --exact --nocapture
cargo test -p freshell-terminal pty::tests::spawn_with_sink_delivers_multi_frame_output_in_seq_order -- --exact --nocapture
```

Expected: PASS (1 passed, 0 failed, each). The current code already
delivers in order — these assertions' job is to fail loudly if the
refactor in Step 5 ever breaks ordering. If the multi-frame test fails
its `frames >= 2` assertion here (pre-refactor), STOP: the frame-forcing
payload is not working as validated — do not proceed to the refactor on a
vacuous net.

- [ ] **Step 5: Refactor the `emit` closure to forward by value**

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

- [ ] **Step 6: Run the pty test module — all green**

```bash
cargo test -p freshell-terminal pty::tests -- --nocapture
```

Expected: PASS — 5 passed, 0 failed (the 4 baseline tests plus the new
multi-frame test from Step 3). The strengthened sink test proves the sink
still receives `TerminalOutput` frames and that `captured_messages()`
stays empty with a sink wired; the multi-frame test proves by-value
forwarding preserves cross-frame seq order.

- [ ] **Step 7: Format and lint the change**

```bash
cargo fmt --all
cargo clippy -p freshell-terminal --all-targets -- -D warnings
```

Expected: fmt makes no unexpected changes beyond the edited region; clippy
exits 0 with no warnings. (The workspace-wide CI-parity clippy run happens
in Task 2 Step 3 as the final gate.)

- [ ] **Step 8: Commit**

```bash
git -C /home/dan/code/freshell/.worktrees/pty-review-nits-e2rj add crates/freshell-terminal/src/pty.rs
git -C /home/dan/code/freshell/.worktrees/pty-review-nits-e2rj commit -m "perf(terminal): forward sink messages by value in pty reader hot path

The emit closure cloned every ServerMessage for the sink and then dropped
the originals — one redundant deep copy of each output frame's data String
per frame, in the hottest path in the terminal server. Sink and capture
destinations are mutually exclusive (capture is gated on sink absence), so
restructure as if/else and iterate by value; delete the now-redundant
capture_enabled flag. Strengthens the sink gate test with a seq-order
assertion and adds a cfg(unix) multi-frame (~41 KB) ordering test so
in-order forwarding is pinned by a non-vacuous test (the echo test's
single frame cannot exercise cross-frame order).

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
- Consumes: nothing from Task 1 beyond the updated test count (the tasks
  touch different regions of the same file; Task 1 added assertion lines
  inside this test's body and one NEW test after it, but did not touch
  this test's attributes — and the new test is already `#[cfg(unix)]`
  from birth, so Task 2 must not touch it).
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
  code (~line 381) and on Task 1's new multi-frame test, so this matches
  established style.

- [ ] **Step 2: Run the pty test module — the test must still run on Linux**

```bash
cargo test -p freshell-terminal pty::tests -- --nocapture
```

Expected: PASS — 5 passed, 0 failed (4 baseline tests + Task 1's
multi-frame test), and the output MUST still list
`pty::tests::spawn_with_sink_does_not_accumulate_captured_messages` as an
executed test (i.e., the cfg gate did not accidentally exclude it on this
unix platform). If only 4 tests run, the attribute was misplaced — stop and
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
