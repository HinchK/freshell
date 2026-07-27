# Dedupe Cache Follow-ups Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Land the two recorded follow-ups from the WSL crash-hardening merge: bound the unbounded settled create-dedupe cache in `crates/freshell-ws`, and make the one timing-sensitive test in the restore/dedupe acceptance suite deterministic — without weakening any dedupe semantics or test assertion.

**Architecture:** The settled cache (`CreateDedupe` in `crates/freshell-ws/src/create_dedupe.rs`) becomes **liveness-anchored** (legacy parity): a settled entry lives exactly as long as its terminal is running. `settle()` gains an `is_running` closure and prunes dead entries on access (house prune-on-access pattern, as in `CreateRateLimiter`); `begin()`'s existing liveness closure is tightened from `registry.exists()` to a corrected `TerminalRegistry::is_running()` that reads `TerminalRunStatus` (the existing method at `registry.rs:1112` is presence-only and must be fixed — see Task 1). **No new dependencies, no clock injection, no constants** — an originally drafted TTL+cap design was falsified during pre-execution load-bearing validation (the frozen client re-sends persisted requestIds at arbitrary delay; see Task 1 preamble). The racy acceptance test `restore_create_holds_permit_until_settled` is replaced by two deterministic tests: an acceptance test where the test itself holds the gate's single permit (structural queueing, no wall-clock race), plus a unit test in `create_gate.rs` pinning the "permit released only after the create settles" ordering via a tiny extracted `hold_permit_across` helper.

**Tech Stack:** Rust (edition 2021), tokio, cargo test/fmt/clippy. No new crates.

## Verification of the reported issues (already performed — do not redo)

Both issues were re-verified against this worktree's checked-out branch (`fix/dedupe-cache-followups` @ `f065cf58`, the merge of `feat/rust-wsl-crash-hardening`) before this plan was written:

1. **Unbounded settled cache: CONFIRMED.** `CreateDedupe { entries: Mutex<HashMap<String, Entry>> }` (`crates/freshell-ws/src/create_dedupe.rs:91-94`). `settle()` unconditionally inserts an `Entry::Settled` (`create_dedupe.rs:154-160`) on every successful create (sole production caller: `terminal.rs:1312-1315`, reached by both the inline and gated-restore create paths). The only `remove` (`create_dedupe.rs:178`) is guarded to `InFlight` (`:177` — doc: *"Settled entries stay: that IS the dedupe"*). No capacity constant, no TTL, no timestamp stored, no background reaper, no `retain`/`clear`/`shrink` anywhere. The lazy displacement (`create_dedupe.rs:121-134`) fires only when the *same* requestId is re-sent AND the terminal is not live — and `is_live` is `registry.exists()` (`registry.rs:903-909`), which stays `true` for naturally-exited-but-retained terminals (`registry.rs:911-915`), so it only ever catches *killed* terminals. Growth: one immortal ~440-byte entry per successful create for the server process lifetime.
2. **Timing-sensitive test: CONFIRMED, exactly one.** `restore_create_holds_permit_until_settled` (`crates/freshell-ws/tests/restore_spawn_gate.rs:341-370`) contains no sleep but is a pure unsynchronized wall-clock race: its `gate.queued_total() >= 1` assertion holds only if the `r2` frame reaches the server while `r1` still holds the single permit — a few-millisecond window. The harness's own Nagle comment (`tests/restore_spawn_gate.rs:165-171`) documents that ~3 ms of extra latency exceeds a whole settled create. It fails toward **false-FAIL** under load. Every other sleep in the suite is a bounded poll tick, a negative-assertion window (fails toward false-PASS), or semantically required — out of scope.

**Pre-execution load-bearing validation (Stage 2) addendum:** the plan's originally drafted fix (30-min TTL + 4096 cap) was validated against the frozen client and legacy server before execution and **falsified**: (a) the frozen client persists `createRequestId` in localStorage pane layouts and re-sends it on every reconnect until the pane anchors (`src/lib/terminal-restore.ts:28-33`, `src/components/TerminalView.tsx:4334-4342`), so duplicates can arrive at arbitrary delay while the terminal is live; (b) legacy's real dedupe structure is the process-wide `createdTerminalByRequestId` (`server/ws-handler.ts:564`), pruned eagerly at terminal exit (`:580-587`) — liveness-anchored, not process-lifetime (the per-connection map at `:467` dies with the socket); (c) the Rust registry retains naturally-exited terminals indefinitely (`registry.rs:927-967`; no port of legacy's `MAX_TERMINALS`/`reapExitedTerminals`), so eviction must anchor to RUNNING status, not `exists()`. The plan below reflects the corrected, legacy-parity design. Known pre-existing divergences surfaced by validation (recorded as out-of-scope follow-ups, NOT to be changed here): Rust replays a stored `terminal.created` frame without legacy's `expectedSessionKey` gate (`ws-handler.ts:904-909`); the Rust port lacks legacy's terminal-population bounds (`MAX_TERMINALS` 50 / `MAX_EXITED_TERMINALS` 200 / `reapExitedTerminals`).

If an implementer finds either finding no longer true (e.g. a bound already added), STOP that task and report instead of changing anything.

## Global Constraints

- **Base:** all work on the current worktree branch `fix/dedupe-cache-followups` (based on `f065cf58`, the crash-hardening merge) — NOT `main`. Worktree: `/home/dan/code/freshell/.worktrees/rust-tauri-port/.worktrees/dedupe-cache-followups`.
- **No new dependencies** — no workspace deps, no crate deps, no dev-deps. Hand-roll in house style (`create_limit.rs` / `spawn_gate.rs` are the templates).
- **Frozen read-only paths:** `server/`, `shared/`, `src/`, `dist/client`. Touch only `crates/` + `docs/plans/`.
- **Process safety:** never broad-kill; only signal PIDs the tests spawned; never bind ports 3001/3002 (user's live freshell runs on :3001).
- **Quality gates (delta vs baseline, never absolute green):** `cargo fmt --all -- --check` clean; `cargo clippy --workspace --all-targets` with no NEW warnings vs the baseline recorded in Task 1 Step 1; `cargo test -p freshell-ws` with no NEW failures vs baseline. Two failures are known-allowed by name: `codex_session_ref_resume::codex_create_derives_resume_from_session_ref` (environmental — no `node_modules` in this worktree) and `session_identity_frames::fresh_claude_create_frames_carry_preallocated_session_ref` (pre-existing defect).
- **TDD:** Red-Green-Refactor for every task; never skip the failing-test step.
- **Commits:** Conventional Commits with crate scope, ASCII subject, bullet body, a `Verification:` paragraph naming the exact commands run, and the Amplifier footer — via four separate `-m` args. Explicit `git add <paths>`, never `-A`. No PR (port campaign rule).
- **Build note:** this worktree has no `target/`; the first cargo invocation is a cold full build — budget long timeouts. (Measured during pre-execution validation with a warm `~/.cargo` cache: ~25 s for the freshell-ws test target, zero downloads. Still budget 10+ minutes in case the cache is cold.)
- **Parity note (replaces the earlier wire-visible-deviation rule):** liveness-anchored eviction MATCHES legacy's model (`createdTerminalByRequestId` pruned at terminal exit, `server/ws-handler.ts:580-587`), so **no new `port/oracle/DEVIATIONS.md` entry is required** — this change removes an undocumented divergence (replay-after-exit via `exists()`) rather than adding one. The pre-existing divergences listed in the verification addendum above are recorded follow-ups, out of scope.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `crates/freshell-ws/src/create_dedupe.rs` (331 lines) | Modify | The bounding change: `settle()` gains an `is_running` closure and prunes dead entries on access; doc updates; updated + new inline unit tests. |
| `crates/freshell-terminal/src/registry.rs` | Modify (1 method + 1 test) | Fix the presence-only `is_running()` body (`:1112-1119`) to read `TerminalRunStatus::Running`; pin with a unit test on an exited-retained terminal. |
| `crates/freshell-ws/src/terminal.rs` (2,619 lines — **surgical edits only**, file is over the size waiver) | Modify (2 call sites) | Swap `begin()`'s closure to `is_running` (`:488-492`); pass the closure into `settle()` (`:1313-1315`). |
| `crates/freshell-ws/src/create_gate.rs` | Modify | Extract `hold_permit_across` permit-scope helper + new `#[cfg(test)]` unit test pinning release-after-settle. |
| `crates/freshell-ws/tests/restore_spawn_gate.rs` | Modify (1 test) | Replace the racy settled-hold test with the deterministic test-held-permit version. |

No new files. No module split (new behavior stays out of `terminal.rs` per the size waiver; `create_dedupe.rs` stays well under 1K lines).

---

### Task 1: Anchor settled dedupe entries to terminal liveness (bounded, legacy parity)

A settled entry now lives exactly as long as its terminal is **running** — the legacy model. Strategy justification (recorded here so reviewers don't re-litigate; validated during the pre-execution load-bearing review): the originally drafted fix (30-min TTL + 4096 cap) was **falsified** before execution. The frozen client persists `createRequestId` inside pane layouts (localStorage via persistMiddleware; `src/lib/terminal-restore.ts:28-33`) and re-sends the SAME requestId on every reconnect/restart "for as many interrupted restore rounds as it takes to anchor" (`src/components/TerminalView.tsx:4334-4342`, whose comment relies on the invariant that the re-send "cannot spawn a duplicate terminal"). A pane persisted as `{status:'creating', createRequestId}` (reply lost in transit, or processed inside the 500 ms persist debounce before a crash) can therefore re-send its requestId at ARBITRARY delay — laptop closed overnight — so **any fixed time window can double-spawn a terminal beside the live original**, weakening dedupe vs legacy. Legacy Node's actual model (verified in `server/ws-handler.ts`): the process-wide `createdTerminalByRequestId` map (`:564`) is pruned eagerly when the terminal exits (`:580-587`, registered `:650`, fires for ALL exit categories) and lazily on registry miss (`:914-921`) — dedupe anchored to terminal running-lifetime, with **no time limit**, bounded by the running-terminal count. This task adopts the same anchor: prune-on-access at `settle()` (house pattern — no background task, no new deps, no clock injection) removes every settled entry whose terminal is no longer running, so after each successful create the cache holds at most one entry per running terminal plus in-flight creates. No immortal entries; the confirmed leak (one immortal ~0.5 KB entry per successful create, forever) is gone.

This also FIXES an unintended superset vs legacy: the current liveness closure is `registry.exists()`, which stays `true` for naturally-exited-but-retained terminals (`crates/freshell-terminal/src/registry.rs:911-921`), so today a duplicate replays `terminal.created` for an already-exited terminal — legacy never replays for an exited terminal (eager delete at exit). Anchoring to running-status matches legacy exactly.

**Explicit post-eviction semantics (spec requirement):** a duplicate arriving after its terminal stopped running finds no settled entry (or a displaceable one), gets `DedupeDecision::Proceed`, and runs as a **fresh create — spawning a NEW terminal** with the same requestId and a new terminalId. This is exactly legacy's post-exit behavior, and it is already pinned by the existing `dead_terminal_evicts_settled_entry` test (whose closure semantics this task makes real at the call site). The "duplicates never spawn a second terminal" guarantee holds for the terminal's whole running lifetime — strictly stronger than any fixed window.

**CRITICAL naming trap (validated):** `TerminalRegistry::is_running` ALREADY EXISTS at `crates/freshell-terminal/src/registry.rs:1112-1119` but is presence-only (`terminals.contains_key(...)` — semantically identical to `exists()`). Wiring it up unmodified would compile and change NOTHING. Step 5(a) fixes its body to check `TerminalRunStatus::Running`. Its only current callers are 5 registry unit tests, none exercising exited-retained terminals (verified), so they keep passing.

**Files:**
- Modify: `crates/freshell-terminal/src/registry.rs` (fix `is_running` body at `:1112-1119` + doc comment at `:1111`; extend/adjust the exited-retained unit test near `:1995`)
- Modify: `crates/freshell-ws/src/create_dedupe.rs` (`settle` at `:153-166` gains a liveness closure + prune; doc updates; tests mod at `:195-331`)
- Modify: `crates/freshell-ws/src/terminal.rs:491` (begin closure: `exists` -> `is_running`) and `:1313-1315` (settle call gains the closure)
- Test: inline `#[cfg(test)]` mods in `create_dedupe.rs` and `registry.rs`

**Interfaces:**
- Consumes: `TerminalRunStatus { Running, Exited }` (`crates/freshell-protocol/src/server_messages.rs:214-218`); the private `TerminalShared.status` field (`registry.rs:202`); the established lock-inner -> clone-shared -> read-status pattern at `registry.rs:457-466`; `FrameSink` (`freshell_terminal`); `ServerMessage` (`freshell_protocol`).
- Produces (later tasks rely on these exact shapes):
  - `pub fn is_running(&self, terminal_id: &str) -> bool` on `TerminalRegistry` (existing name, corrected body: `true` only while status is `Running`; map-miss => `false`)
  - `pub fn begin(&self, request_id: &str, sink: &FrameSink, is_running: impl Fn(&str) -> bool) -> DedupeDecision` (signature unchanged from today; parameter renamed from `is_live`, semantics now "running")
  - `pub fn settle(&self, request_id: &str, terminal_id: &str, created: &ServerMessage, is_running: impl Fn(&str) -> bool)` (new final parameter)
  - `pub fn clear_if_in_flight(&self, request_id: &str)` (unchanged)
  - `CreateDedupe { entries: Mutex<HashMap<String, Entry>> }` (struct unchanged — no Inner wrapper, no VecDeque, no timestamps, no constants)

- [ ] **Step 1: Record the quality-gate baseline (before any change)**

Run (first cargo invocation on this worktree is a cold build; with a warm `~/.cargo` it measured ~25 s during pre-execution validation, but budget long timeouts anyway):

```bash
cd /home/dan/code/freshell/.worktrees/rust-tauri-port/.worktrees/dedupe-cache-followups
cargo clippy --workspace --all-targets 2>&1 | tee /tmp/dedupe-followups-baseline-clippy.txt | grep -c "^warning"
cargo test -p freshell-ws 2>&1 | tee /tmp/dedupe-followups-baseline-test.txt | tail -30
cargo test -p freshell-terminal 2>&1 | tee /tmp/dedupe-followups-baseline-terminal-test.txt | tail -15
```

Expected: clippy completes with a NON-ZERO baseline count (pre-existing warnings exist in freshell-ws lib, freshell-platform, freshell-freshagent — verified); tests complete with at most the two known-allowed freshell-ws failures named in Global Constraints. These files are the comparison baseline for every later task. If other tests fail at baseline, note their names — they are pre-existing, not yours to fix, but they must not be *joined* by new ones.

- [ ] **Step 2: Verify the issue still exists (halt condition)**

Run:

```bash
grep -n "is_running\|retain" crates/freshell-ws/src/create_dedupe.rs
sed -n '1108,1122p' crates/freshell-terminal/src/registry.rs
```

Expected: **no matches** for the grep, and the `sed` output shows `is_running` implemented via `contains_key` (presence-only). If the grep matches or `is_running` already checks run-status, the cache has already been bounded — STOP this task and report instead of changing anything.

- [ ] **Step 3: Write the failing tests**

(a) In `crates/freshell-terminal/src/registry.rs`, locate the existing unit test near `:1995` whose comment documents that naturally-exited terminals are retained (it observes presence via `exists()`/`is_running` after a natural exit). Extend it (or add a sibling test `is_running_false_for_exited_retained_terminal` reusing that test's exact spawn-and-wait-for-exit harness) so that after the natural exit is observed it asserts:

```rust
        assert!(
            registry.exists(&id),
            "exited terminal record is retained for restore"
        );
        assert!(
            !registry.is_running(&id),
            "is_running must go false at natural exit even though the record is retained"
        );
```

If any pre-existing assertion in that test pins the old presence-only `is_running` semantics for an exited terminal, update it to the corrected semantics with a comment — that flip is the intended behavior change of this task.

(b) In `crates/freshell-ws/src/create_dedupe.rs`, inside the existing `#[cfg(test)] mod tests` (after the `recording_sink` helper), add two new tests:

```rust
    #[test]
    fn settle_prunes_entries_for_non_running_terminals() {
        let d = CreateDedupe::default();
        let (s, _f) = recording_sink();
        let _ = d.begin("r1", &s, |_| true);
        d.settle("r1", "t1", &created_frame(), |_| true);
        // t1's terminal has since exited: the next successful create's
        // settle sweeps its entry out (prune-on-access; legacy parity with
        // ws-handler's eager delete-at-exit).
        let _ = d.begin("r2", &s, |_| true);
        d.settle("r2", "t2", &created_frame(), |tid| tid != "t1");
        let map = d.entries.lock().expect("lock");
        assert_eq!(
            map.len(),
            1,
            "entry for the exited terminal must be physically evicted on the next settle"
        );
        assert!(map.contains_key("r2"));
    }

    #[test]
    fn prune_keeps_running_and_in_flight_entries() {
        let d = CreateDedupe::default();
        let (s, _f) = recording_sink();
        let _ = d.begin("r1", &s, |_| true);
        d.settle("r1", "t1", &created_frame(), |_| true);
        let _ = d.begin("r2", &s, |_| true); // still in flight
        let _ = d.begin("r3", &s, |_| true);
        d.settle("r3", "t3", &created_frame(), |_| true); // prune runs; all running
        {
            let map = d.entries.lock().expect("lock");
            assert_eq!(
                map.len(),
                3,
                "running settled entries and in-flight sentinels survive the prune"
            );
        }
        // r1 still replays after the prune.
        assert!(matches!(
            d.begin("r1", &s, |_| true),
            DedupeDecision::DuplicateSettled(_)
        ));
    }
```

Also update the seven existing tests in the same mod — every `d.settle(...)` call gains `, |_| true` as a final argument (or `|_| false` where a test's scenario needs the pruned outcome — none of the existing seven does; they all pass `|_| true`). `d.begin(...)` calls are unchanged (same arity as today). The seven tests (all in `create_dedupe.rs:218-330`): `first_begin_proceeds_and_registers_sentinel`, `settled_entry_replays_frame_while_live`, `dead_terminal_evicts_settled_entry`, `clear_if_in_flight_removes_sentinel_but_not_settled`, `cross_connection_waiter_receives_settle_frame`, `same_connection_duplicate_is_not_a_waiter`, `waiters_get_fail_loud_error_on_non_settled_exit`.

- [ ] **Step 4: Run tests to verify they fail**

Run:

```bash
cargo test -p freshell-terminal is_running
cargo test -p freshell-ws create_dedupe
```

Expected: the registry assertion **FAILS** (presence-only `is_running` returns `true` for the exited-retained terminal), and freshell-ws hits a **compile error** — `settle` does not yet take a closure. A compile failure is the RED state for a signature-changing step.

- [ ] **Step 5: Implement liveness-anchored eviction**

(a) In `crates/freshell-terminal/src/registry.rs`, fix `is_running` (`:1112-1119`): replace its `contains_key` body following the established pattern at `registry.rs:457-466` (lock the registry inner map, clone the terminal's `TerminalShared` handle, read its `status` under that handle's own lock) and return `status == TerminalRunStatus::Running`; a map miss returns `false`. Update the doc comment at `:1111` to:

```rust
    /// True only while the terminal's PTY is still running. Unlike
    /// `exists()`, this goes false when the terminal exits naturally, even
    /// though the record is retained (restore/replay can still see it via
    /// `exists()`). Drives create-dedupe eviction: legacy parity with the
    /// Node server's delete-at-exit requestId pruning.
```

(This is deliberately an instruction to mirror existing in-file code at `:457-466` rather than a fabricated snippet — the reaper there already does exactly this lock-clone-read-status sequence; reuse its field and lock names verbatim.)

(b) In `crates/freshell-ws/src/create_dedupe.rs`, replace `settle()` (`:153-166`) with (waiters still invoked WITHOUT the lock held, as before):

```rust
    pub fn settle(
        &self,
        request_id: &str,
        terminal_id: &str,
        created: &ServerMessage,
        is_running: impl Fn(&str) -> bool,
    ) {
        let waiters = {
            let mut map = self.entries.lock().expect("create_dedupe lock");
            let prev = map.insert(
                request_id.to_string(),
                Entry::Settled {
                    terminal_id: terminal_id.to_string(),
                    created: created.clone(),
                },
            );
            // Prune-on-access (house pattern; no background task): a settled
            // entry lives exactly as long as its terminal is running -- the
            // legacy liveness-anchored model. Entries for exited or killed
            // terminals are swept on every successful create's settle.
            map.retain(|_, e| match e {
                Entry::InFlight { .. } => true,
                Entry::Settled { terminal_id, .. } => is_running(terminal_id),
            });
            match prev {
                Some(Entry::InFlight { waiters, .. }) => waiters,
                _ => Vec::new(),
            }
        };
        for w in waiters {
            w(created.clone());
        }
    }
```

Preserve `settle()`'s original doc comment, adding: `/// Also prunes settled entries whose terminal is no longer running (prune-on-access; no background task).`

(c) In `begin()` (`:101-147`): rename the `is_live` parameter to `is_running` (body structure unchanged — the existing `Settled` arm already displaces and returns `Proceed` when the closure is false, which is exactly the post-eviction contract). Amend its doc comments: any sentence claiming settled entries live forever now states they live while their terminal is running; the displacement comment ("Terminal killed...") becomes "Terminal exited or killed: evict and treat as fresh (legacy delete-at-exit parity)."

(d) In `clear_if_in_flight()` (`:174-192`): no code change. Amend its doc line *"Settled entries stay: that IS the dedupe"* to *"Settled entries stay while their terminal runs: that IS the dedupe (legacy parity)."*

(e) Update the two production call sites in `crates/freshell-ws/src/terminal.rs` (surgical, two lines):
- The `begin` dispatch (`:488-492`): change the closure `|tid| state.registry.exists(tid)` to `|tid| state.registry.is_running(tid)`.
- The `settle` call (`:1313-1315`): `.settle(&dedupe_request_id, &dedupe_terminal_id, &created, |tid| state.registry.is_running(tid))`.

(f) Update the module doc comment (`create_dedupe.rs:1-27`): find the sentences describing settled-entry lifetime/lazy eviction and amend so the doc states: settled entries are retained for replay for exactly as long as their terminal is running (legacy parity with the Node server's delete-at-exit requestId pruning); eviction is lazy — `settle()` prunes all dead entries on access and `begin()` displaces per-id — with no background task; within a terminal's running lifetime a duplicate replays the original `terminal.created` and never spawns a second terminal; after the terminal stops running a re-sent requestId is indistinguishable from a fresh create and spawns a new terminal, exactly as legacy behaves after terminal exit. Also update the sizing comment above `#[allow(clippy::large_enum_variant)]` (`:35-40`): change "small settled cache" to "liveness-bounded settled cache".

- [ ] **Step 6: Verify no other callers were missed**

Run: `cargo check -p freshell-ws --all-targets && cargo check --workspace --all-targets`
Expected: clean compile. The `settle` arity change surfaces any missed caller as a compile error — per the verified survey there are exactly two production call sites, both in `terminal.rs`, and only `settle`'s changes shape.

- [ ] **Step 7: Run tests to verify they pass**

Run:

```bash
cargo test -p freshell-terminal
cargo test -p freshell-ws create_dedupe
```

Expected: PASS — freshell-terminal including the corrected `is_running` test (the 5 pre-existing `is_running` callers keep passing: none exercises exited-retained); freshell-ws `create_dedupe` shows 9 tests (7 updated + 2 new).

- [ ] **Step 8: Format, lint, and full-crate delta check**

Run:

```bash
cargo fmt --all
cargo clippy --workspace --all-targets 2>&1 | grep -c "^warning"
cargo test -p freshell-ws 2>&1 | tail -30
```

Expected: `cargo fmt --all -- --check` is clean afterward; clippy warning count <= the Step 1 baseline count (no NEW warnings); test failures are only the known-allowed names from Step 1.

- [ ] **Step 9: Commit**

```bash
git add crates/freshell-ws/src/create_dedupe.rs crates/freshell-ws/src/terminal.rs crates/freshell-terminal/src/registry.rs
git commit \
  -m "fix(freshell-ws): anchor settled create-dedupe entries to terminal liveness" \
  -m "- Follow-up from the crash-hardening reviews: the settled requestId cache grew one immortal ~0.5 KB entry per successful create for the server process lifetime
- Eviction now matches legacy's model (ws-handler.ts createdTerminalByRequestId is pruned at terminal exit, not by time): settle() prunes entries for non-running terminals via retain (prune-on-access, no background task, no new deps), and the begin() liveness closure is tightened from registry.exists() (which stays true for exited-retained terminals) to a corrected registry.is_running() that reads TerminalRunStatus
- A fixed TTL+cap design was validated and rejected pre-execution: the frozen client persists createRequestId in localStorage and re-sends it on every reconnect until the pane anchors, so any time-based eviction could double-spawn a terminal beside the live original - weaker dedupe than legacy
- Cache is now structurally bounded: after every settle it holds at most one entry per running terminal plus in-flight creates; post-eviction duplicates proceed as fresh creates, exactly legacy's post-exit behavior" \
  -m "Verification: cargo test -p freshell-terminal (is_running exited-retained test); cargo test -p freshell-ws create_dedupe (9 passed); cargo test -p freshell-ws; cargo fmt --all -- --check; cargo clippy --workspace --all-targets (no new warnings; no new failures vs recorded baseline)." \
  -m "$(printf '\xf0\x9f\xa4\x96 Generated with [Amplifier](https://github.com/microsoft/amplifier)\n\nCo-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>')"
```

---

### Task 2: Make the settled-hold acceptance test deterministic

Replace the wall-clock race in `restore_create_holds_permit_until_settled` with structural synchronization: the test acquires the gate's single permit itself (the server's real `Arc<RestoreSpawnGate>` is already returned by `spawn_server`), sends both restore creates, and bounded-polls the gate counter until both are observably queued — only then releases. Every original assertion is preserved and one is strengthened: both creates settle with their own requestId (unchanged), `queued_total()` is now asserted `== 2` (was `>= 1`, and was racy), and exactly two PTYs exist (unchanged). A permit-leak check is added (post-settle re-acquire succeeds). The "permit held until settled, not just spawn" discrimination — which the racy original only covered probabilistically (its `queued_total` counter increments on ANY failed try_acquire, so it never structurally distinguished settle-hold from spawn-hold) — moves to a deterministic unit test in Task 3. An injected virtual clock was evaluated and rejected: `start_paused` implies a current-thread runtime and auto-advances on idle, incompatible with this suite's `multi_thread` flavor and real TCP/PTY I/O; the flake source is I/O latency, not a timer.

**Files:**
- Modify: `crates/freshell-ws/tests/restore_spawn_gate.rs:341-370` (the one test; nothing else in the suite)
- Test: same file (this task IS a test change)

**Interfaces:**
- Consumes (all already in `tests/restore_spawn_gate.rs`): `spawn_server(cfg, gate) -> (ws_url, registry, shutdown, Arc<RestoreSpawnGate>, shutdown_started)` (`:75-153`); `connect_and_hello(&ws_url)` (`:161-191`); `send_text` (`:194-198`); `next_json_of_type` (`:201-216`); `create_frame(request_id, restore)` (`:264-274`); `RestoreSpawnGate::new(permits, queue)` and `RestoreSpawnGate::acquire(timeout, &mut watch::Receiver<bool>)` (public — same call shape as the unit test at `src/spawn_gate.rs:222-227`); `queued_total()` accessor (`src/spawn_gate.rs:159-173`).
- Produces: the renamed test `restore_creates_queue_behind_held_permit_and_both_settle` (Task 3's suite run relies on it passing).

- [ ] **Step 1: RED — deterministically demonstrate the race in the existing test**

In `crates/freshell-ws/tests/restore_spawn_gate.rs`, inside `restore_create_holds_permit_until_settled` (`:341-370`), TEMPORARILY insert between the two `send_text` calls:

```rust
    // TEMP (RED evidence): simulate ~5ms of load-induced latency on frame 2.
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
```

Run:

```bash
cargo test -p freshell-ws --test restore_spawn_gate -- --exact restore_create_holds_permit_until_settled
```

Expected: **FAIL** — panic on the `gate.queued_total() >= 1` assertion ("with 1 permit, the second concurrent restore create must have queued..."), because the first create settles inside the 5 ms and the second never queues. This is the flake mechanism made reproducible (the harness's own Nagle comment at `:165-171` documents that ~3 ms suffices). Then **remove the temporary sleep**. If the test unexpectedly PASSES with the sleep in place, investigate before proceeding — the premise of this task would be wrong.

- [ ] **Step 2: Replace the test**

First confirm the acquire signature: `grep -n "pub async fn acquire" crates/freshell-ws/src/spawn_gate.rs` — expect a `Duration` timeout plus a `&mut tokio::sync::watch::Receiver<bool>` cancel param (the same pair the unit test at `src/spawn_gate.rs:222-227` passes). Then replace the entire test at `:341-370` with:

```rust
#[tokio::test(flavor = "multi_thread")]
async fn restore_creates_queue_behind_held_permit_and_both_settle() {
    // Deterministic rework of the former settled-hold race: the TEST holds
    // the gate's single permit while both restore creates arrive, so "the
    // second create had to queue" is structural instead of a race against
    // the first create's few-ms spawn-to-settled window (see the Nagle
    // comment in connect_and_hello). All original assertions preserved:
    // both settle with their own requestId, the gate queued (now == 2,
    // strictly stronger than the old >= 1), and exactly two PTYs exist.
    // The "permit held until settled, not just spawn" ordering is pinned
    // deterministically by create_gate's unit test
    // permit_released_only_after_work_completes.
    let cfg = CreateProtectConfig::default();
    let (ws_url, registry, _shutdown, gate, _shutdown_started) =
        spawn_server(cfg, RestoreSpawnGate::new(1, 64)).await;
    let mut client = connect_and_hello(&ws_url).await;

    // Hold the only permit so both creates MUST queue.
    let (_cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
    let permit = gate
        .acquire(std::time::Duration::from_secs(5), &mut cancel_rx)
        .await
        .expect("test acquires the gate's only permit");

    send_text(&mut client, &create_frame("r1", true)).await;
    send_text(&mut client, &create_frame("r2", true)).await;

    // Bounded poll (suite idiom, cf. the disconnect test): both creates
    // observably queued behind the held permit.
    for _ in 0..400 {
        if gate.queued_total() >= 2 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(
        gate.queued_total(),
        2,
        "with the only permit held by the test, both restore creates must queue"
    );

    // Release: with 1 permit the creates now run strictly one at a time.
    drop(permit);

    let first = next_json_of_type(&mut client, "terminal.created").await;
    let second = next_json_of_type(&mut client, "terminal.created").await;
    let mut ids: Vec<String> = vec![
        first["requestId"].as_str().expect("id").to_string(),
        second["requestId"].as_str().expect("id").to_string(),
    ];
    ids.sort();
    assert_eq!(ids, vec!["r1".to_string(), "r2".to_string()]);

    // Permit-leak check: once both creates settled, the permit must be
    // re-acquirable (released at settle, not retained).
    let reacquired = gate
        .acquire(std::time::Duration::from_secs(5), &mut cancel_rx)
        .await;
    assert!(
        reacquired.is_ok(),
        "gate permit must be free again once both creates settled"
    );
    drop(reacquired);

    assert_eq!(registry.kill_all(), 2);
}
```

(If the confirmed `acquire` signature differs in its cancel-receiver type, construct whatever `cancel_pair()`-equivalent the unit tests use — the shape of the test is unchanged.)

- [ ] **Step 3: Run the new test to verify it passes**

Run:

```bash
cargo test -p freshell-ws --test restore_spawn_gate -- --exact restore_creates_queue_behind_held_permit_and_both_settle
```

Expected: PASS.

- [ ] **Step 4: Determinism proof — repeat run**

Run:

```bash
for i in $(seq 1 20); do
  cargo test -p freshell-ws --test restore_spawn_gate -- --exact restore_creates_queue_behind_held_permit_and_both_settle \
    || { echo "FAILED on iteration $i"; break; }
done
```

Expected: 20/20 PASS (compilation is cached after the first run; ~seconds per iteration). This suite spawns only its own `/bin/sh` PTYs and kills only its own registry, so host execution is within the sandbox carve-out.

- [ ] **Step 5: Run the whole suite**

Run: `cargo test -p freshell-ws --test restore_spawn_gate`
Expected: all 12 tests PASS. Confirm the old name is fully gone: `grep -c "restore_create_holds_permit_until_settled" crates/freshell-ws/tests/restore_spawn_gate.rs` outputs `0`.

- [ ] **Step 6: Format, lint**

Run: `cargo fmt --all && cargo clippy -p freshell-ws --all-targets 2>&1 | grep -c "^warning"`
Expected: no new warnings vs baseline.

- [ ] **Step 7: Commit**

```bash
git add crates/freshell-ws/tests/restore_spawn_gate.rs
git commit \
  -m "test(freshell-ws): make the restore-gate settled-hold test deterministic" \
  -m "- restore_create_holds_permit_until_settled was an unsynchronized wall-clock race: its queued_total >= 1 assertion held only if frame 2 beat the first create's few-ms spawn-to-settled window (the harness's Nagle comment documents ~3ms sufficing to flip it) - false-FAIL under load
- Reworked as restore_creates_queue_behind_held_permit_and_both_settle: the test holds the gate's single permit while both creates arrive (structural queueing), then releases; assertions preserved and strengthened (queued_total == 2, both settle with own requestId, exactly 2 PTYs, plus a permit-leak re-acquire check)
- Virtual clock rejected: start_paused conflicts with multi_thread + real TCP/PTY I/O; the held-until-settled ordering moves to a deterministic create_gate unit test (follow-up commit)" \
  -m "Verification: RED reproduced via temporary 5ms inter-frame delay (queued_total assertion tripped); new test 20/20 repeat runs; cargo test -p freshell-ws --test restore_spawn_gate; cargo fmt --all -- --check; cargo clippy -p freshell-ws --all-targets (no new warnings)." \
  -m "$(printf '\xf0\x9f\xa4\x96 Generated with [Amplifier](https://github.com/microsoft/amplifier)\n\nCo-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>')"
```

---

### Task 3: Deterministically pin the spawn-to-settled permit scope (unit level)

The racy original test's residual value was probabilistic protection against the `da5d9b5c` prior-art bug shape (permit released at the PTY spawn instead of after settle). Task 2's structural rework cannot observe that ordering from outside the server. Pin it deterministically at the unit level: extract the permit-scoped tail of `spawn_gated_restore_create` into a tiny generic helper `hold_permit_across(permit, work)` and unit-test that the permit is dropped only after `work` completes, using a oneshot-parked work future and a drop-observable guard. No behavior change: the helper preserves the exact "run the whole settled create, then drop the permit" ordering of the current code (`create_gate.rs:137-167`).

**Files:**
- Modify: `crates/freshell-ws/src/create_gate.rs` (helper fn + rewire the tail of `spawn_gated_restore_create` at `:137-167`; add `#[cfg(test)] mod tests` if the file has none)
- Test: inline `#[cfg(test)] mod tests` in `crates/freshell-ws/src/create_gate.rs`

**Interfaces:**
- Consumes: the existing tail of `spawn_gated_restore_create` (`create_gate.rs:137-167`): `CreateOutput::Channel(&sink)`, `crate::terminal::handle_create(create, &mut out, &state).await`, `state.create_dedupe.clear_if_in_flight(&request_id)`, the `shutdown_started` post-check, `drop(permit)`.
- Produces: `async fn hold_permit_across<G, F>(permit: G, work: F) where F: std::future::Future<Output = ()>` (module-private; visible to inline tests via `use super::*`).

- [ ] **Step 1: Write the failing test**

At the end of `crates/freshell-ws/src/create_gate.rs`, add (or extend, if a `#[cfg(test)] mod tests` already exists — check first with `grep -n "mod tests" crates/freshell-ws/src/create_gate.rs`):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    /// Stand-in for the gate permit whose release is observable.
    struct DropFlag(Arc<AtomicBool>);
    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    /// Pins the spawn-to-settled permit scope deterministically: the permit
    /// must stay held while the create work is still running (the da5d9b5c
    /// prior-art bug released it at the spawn syscall) and be released once
    /// the work - which ends at settle - completes. The work future is
    /// parked on a oneshot, so "mid-create" is a synchronization point, not
    /// a timing window.
    #[tokio::test]
    async fn permit_released_only_after_work_completes() {
        let released = Arc::new(AtomicBool::new(false));
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let flag = DropFlag(Arc::clone(&released));
        let task = tokio::spawn(hold_permit_across(flag, async move {
            let _ = rx.await;
        }));
        tokio::task::yield_now().await;
        assert!(
            !released.load(Ordering::SeqCst),
            "permit must be held while the create is still running"
        );
        tx.send(()).expect("release the parked work");
        task.await.expect("task");
        assert!(
            released.load(Ordering::SeqCst),
            "permit must be released once the work (settle) completes"
        );
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p freshell-ws --lib create_gate`
Expected: **compile error** — `cannot find function hold_permit_across in this scope`.

- [ ] **Step 3: Implement the helper and rewire the permit scope**

(a) Add above `spawn_gated_restore_create` in `create_gate.rs`:

```rust
/// Run `work` (the whole settled-create section: handle_create through the
/// shutdown post-check) while holding `permit`, releasing it only after
/// `work` completes. Extracted so the spawn-to-settled permit scope - the
/// ordering the da5d9b5c prior art got wrong by releasing at the spawn
/// syscall - is deterministically unit-testable instead of being pinned
/// only by a wall-clock race in the acceptance suite.
async fn hold_permit_across<G, F>(permit: G, work: F)
where
    F: std::future::Future<Output = ()>,
{
    work.await;
    drop(permit);
}
```

(b) Rewire the tail of `spawn_gated_restore_create` (`:137-167`). The current code is:

```rust
        let mut out = CreateOutput::Channel(&sink);
        let request_id = create.request_id.clone();
        let _ = crate::terminal::handle_create(create, &mut out, &state).await;
        // Covers create failure: no-op when handle_create settled the entry,
        // drops the InFlight sentinel (failing waiters loud) when it did not.
        state.create_dedupe.clear_if_in_flight(&request_id);
        // A10 shutdown-race post-check (V3): ...
        if state
            .shutdown_started
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            let killed = state.registry.kill_all();
            tracing::info!(
                target: "freshell_ws::spawn_gate",
                request_id = %request_id,
                killed,
                "restore_create_settled_during_shutdown_reaped"
            );
        }
        drop(permit);
    });
```

Replace it with (keep every existing comment, including the multi-line "Permit held across the WHOLE async create..." comment above this block and the full A10 comment, verbatim):

```rust
        let request_id = create.request_id.clone();
        hold_permit_across(permit, async {
            let mut out = CreateOutput::Channel(&sink);
            let _ = crate::terminal::handle_create(create, &mut out, &state).await;
            // Covers create failure: no-op when handle_create settled the entry,
            // drops the InFlight sentinel (failing waiters loud) when it did not.
            state.create_dedupe.clear_if_in_flight(&request_id);
            // A10 shutdown-race post-check (V3): ... (existing comment verbatim)
            if state
                .shutdown_started
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                let killed = state.registry.kill_all();
                tracing::info!(
                    target: "freshell_ws::spawn_gate",
                    request_id = %request_id,
                    killed,
                    "restore_create_settled_during_shutdown_reaped"
                );
            }
        })
        .await;
    });
```

The async block borrows `sink`/`state`/`request_id` and moves `create`; it is awaited inline (not spawned), so non-`'static` borrows are fine. The explicit `drop(permit)` line is deleted — the helper owns that release.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
cargo test -p freshell-ws --lib create_gate
cargo test -p freshell-ws --test restore_spawn_gate
```

Expected: the new unit test PASSES; all 12 acceptance tests still PASS (the rewire is behavior-preserving — same ordering, same permit lifetime).

- [ ] **Step 5: Format, lint**

Run: `cargo fmt --all && cargo clippy -p freshell-ws --all-targets 2>&1 | grep -c "^warning"`
Expected: no new warnings vs baseline.

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-ws/src/create_gate.rs
git commit \
  -m "refactor(freshell-ws): unit-testable spawn-to-settled permit scope" \
  -m "- Extract hold_permit_across(permit, work): runs the whole settled-create section, releasing the permit only after it completes - identical ordering and permit lifetime to the previous inline drop(permit)
- New deterministic unit test permit_released_only_after_work_completes parks the work on a oneshot and observes the guard's drop, pinning the held-until-settled ordering (da5d9b5c early-release regression shape) that the old acceptance test only covered probabilistically" \
  -m "Verification: cargo test -p freshell-ws --lib create_gate; cargo test -p freshell-ws --test restore_spawn_gate (12 passed); cargo fmt --all -- --check; cargo clippy -p freshell-ws --all-targets (no new warnings)." \
  -m "$(printf '\xf0\x9f\xa4\x96 Generated with [Amplifier](https://github.com/microsoft/amplifier)\n\nCo-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>')"
```

---

### Task 4: Final verification sweep

Workspace-wide delta check against the Task 1 Step 1 baseline. This task produces no code change unless a gate fails; it exists so the branch tip is verified as a whole, not just per-task.

**Files:**
- None (verification only; conditional fixes commit under the scope they belong to)

**Interfaces:**
- Consumes: `/tmp/dedupe-followups-baseline-clippy.txt`, `/tmp/dedupe-followups-baseline-test.txt` from Task 1 Step 1 (if missing, the known-allowed failure names in Global Constraints are the fallback baseline).

- [ ] **Step 1: Format check**

Run: `cargo fmt --all -- --check`
Expected: no output, exit 0.

- [ ] **Step 2: Clippy delta**

Run:

```bash
cargo clippy --workspace --all-targets 2>&1 | tee /tmp/dedupe-followups-final-clippy.txt | grep -c "^warning"
diff <(grep "^warning" /tmp/dedupe-followups-baseline-clippy.txt | sort) \
     <(grep "^warning" /tmp/dedupe-followups-final-clippy.txt | sort) | grep "^>" || echo "NO NEW WARNINGS"
```

Expected: `NO NEW WARNINGS`.

- [ ] **Step 3: Test delta**

Run: `cargo test -p freshell-ws 2>&1 | tail -40`
Expected: failing tests (if any) are exactly a subset of the baseline failures recorded in Task 1 Step 1 (the two known-allowed names in Global Constraints). Test count is baseline + 3 new in freshell-ws (2 dedupe-prune + 1 permit-scope) with 1 renamed acceptance test; also run `cargo test -p freshell-terminal` — baseline + 1 new/extended `is_running` exited-retained test, no new failures.

- [ ] **Step 4: Fix-or-report**

If any gate fails: fix minimally, re-run Steps 1-3, and commit the fix with the appropriate `fix(freshell-ws):`/`style(freshell-ws):`/`test(freshell-ws):` scope and a `Verification:` paragraph. If a failure cannot be attributed to this branch's changes, report it as pre-existing with evidence (baseline file line) rather than papering over it.

---

## Self-Review (completed by the plan author; re-run after the Stage-2 load-bearing rewrite)

**1. Spec coverage:**
- "Verify first, then fix" (follow-up 1) → verification recorded in "Verification of the reported issues" (+ Stage-2 validation addendum) + re-checked as Task 1 Step 2 halt condition. Covered.
- "Bound the cache while preserving dedupe semantics" → Task 1: liveness-anchored eviction bounds the cache structurally (≤ one entry per running terminal + in-flight after every settle, pinned by `settle_prunes_entries_for_non_running_terminals`) while replay-during-running-lifetime is pinned by the updated existing tests + `prune_keeps_running_and_in_flight_entries`; never-double-spawn while the terminal runs is UNCHANGED and now time-unlimited (`begin` still returns `DuplicateSettled`/`DuplicateInFlight`) — strictly stronger than any TTL window. Covered.
- "Justify the strategy and the bound" → Task 1 preamble: legacy-parity rationale with validated evidence (frozen-client persisted-requestId re-send path; legacy delete-at-exit model at `ws-handler.ts:580-587`; registry retention facts), house prune-on-access pattern, no-deps policy, and the falsified TTL+cap alternative recorded with reasons. Covered.
- "Duplicate after eviction: explicit and tested" → Task 1 preamble contract (post-eviction duplicate = fresh create = legacy post-exit behavior) + existing `dead_terminal_evicts_settled_entry` (made real at the call site by the corrected `is_running`) + the registry exited-retained test. No DEVIATIONS entry needed — the change matches legacy (Parity note in Global Constraints). Covered.
- "Find the timing-sensitive test, replace timing dependence with deterministic mechanism, no weakened assertions" → Task 2 (identified at `tests/restore_spawn_gate.rs:341-370`; RED reproduction — validated 11/11 deterministic on this host; structural test-held-permit rework; assertions preserved, one strengthened) + Task 3 (the probabilistic held-until-settled residue made deterministic at unit level; rewire compile-validated pre-execution). Covered.
- "Repo conventions, TDD, fmt+clippy clean, no new failures, minimal surface" → Global Constraints + per-task RED steps + Task 4 sweep; change surface is 5 source files (4 in freshell-ws, 1 method + 1 test in freshell-terminal). Covered.

**1b. No silent deferrals:** No stubs, mocks-standing-in-for-behavior, TODOs, or deferred requirements. The only test double (`DropFlag` in Task 3) observes a production-equivalent ownership property and is complemented by the real-gate acceptance test; `created_frame()`'s `Pong` stand-in is the module's pre-existing opaque-payload convention. The pre-existing divergences and missing population-bound ports listed in the verification addendum are explicitly recorded as OUT-OF-SCOPE follow-ups (surfaced to the user in the final report), not silent deferrals of this plan's requirements. No UNRESOLVED COVERAGE GAPS.

**2. Placeholder scan:** Two intentional elisions, both instructions to mirror existing file content rather than placeholders for new content: Task 1 Step 5(a) directs the `is_running` body to reuse the registry's own lock-clone-read-status sequence at `registry.rs:457-466` verbatim (field/lock names live in that file; fabricating them here would be less reliable than pointing at the validated pattern), and Task 3 Step 3(b) says "(existing comment verbatim)" for the A10 comment block. All other steps carry complete code/commands.

**3. Type consistency:** `is_running: impl Fn(&str) -> bool` identical across `begin`/`settle` in Task 1 Interfaces, implementation, both `terminal.rs` call sites, and all tests; `settle`'s 5-parameter shape identical in Interfaces, Step 5(b), Step 5(e), and every test call; `TerminalRegistry::is_running(&self, terminal_id: &str) -> bool` consistent between Interfaces, Step 5(a), and the registry test; no `now_ms`/TTL/cap symbols remain anywhere in the plan; Task 2's renamed test `restore_creates_queue_behind_held_permit_and_both_settle` matches the name referenced in Task 3's test comment and both commit messages; `hold_permit_across<G, F>` signature identical in Task 3 Interfaces, test, and implementation (compile-validated pre-execution).
