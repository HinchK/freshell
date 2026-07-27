# Dedupe Cache Follow-ups Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Land the two recorded follow-ups from the WSL crash-hardening merge: bound the unbounded settled create-dedupe cache in `crates/freshell-ws`, and make the one timing-sensitive test in the restore/dedupe acceptance suite deterministic — without weakening any dedupe semantics or test assertion.

**Architecture:** The settled cache (`CreateDedupe` in `crates/freshell-ws/src/create_dedupe.rs`) gains a TTL + oldest-first cap using the crate's established house patterns: an injectable `now_ms: i64` parameter (as in `create_limit.rs:116` and `invariants.rs:51`) and prune-on-access (as in `CreateRateLimiter`), with **no new dependencies**. The racy acceptance test `restore_create_holds_permit_until_settled` is replaced by two deterministic tests: an acceptance test where the test itself holds the gate's single permit (structural queueing, no wall-clock race), plus a unit test in `create_gate.rs` pinning the "permit released only after the create settles" ordering via a tiny extracted `hold_permit_across` helper.

**Tech Stack:** Rust (edition 2021), tokio, cargo test/fmt/clippy. No new crates.

## Verification of the reported issues (already performed — do not redo)

Both issues were re-verified against this worktree's checked-out branch (`fix/dedupe-cache-followups` @ `f065cf58`, the merge of `feat/rust-wsl-crash-hardening`) before this plan was written:

1. **Unbounded settled cache: CONFIRMED.** `CreateDedupe { entries: Mutex<HashMap<String, Entry>> }` (`crates/freshell-ws/src/create_dedupe.rs:91-94`). `settle()` unconditionally inserts an `Entry::Settled` (`create_dedupe.rs:154-160`) on every successful create (sole production caller: `terminal.rs:1312-1315`, reached by both the inline and gated-restore create paths). The only `remove` (`create_dedupe.rs:178`) is guarded to `InFlight` (`:177` — doc: *"Settled entries stay: that IS the dedupe"*). No capacity constant, no TTL, no timestamp stored, no background reaper, no `retain`/`clear`/`shrink` anywhere. The lazy displacement (`create_dedupe.rs:121-134`) fires only when the *same* requestId is re-sent AND the terminal is not live — and `is_live` is `registry.exists()` (`registry.rs:903-909`), which stays `true` for naturally-exited-but-retained terminals (`registry.rs:911-915`), so it only ever catches *killed* terminals. Growth: one immortal ~440-byte entry per successful create for the server process lifetime.
2. **Timing-sensitive test: CONFIRMED, exactly one.** `restore_create_holds_permit_until_settled` (`crates/freshell-ws/tests/restore_spawn_gate.rs:341-370`) contains no sleep but is a pure unsynchronized wall-clock race: its `gate.queued_total() >= 1` assertion holds only if the `r2` frame reaches the server while `r1` still holds the single permit — a few-millisecond window. The harness's own Nagle comment (`tests/restore_spawn_gate.rs:165-171`) documents that ~3 ms of extra latency exceeds a whole settled create. It fails toward **false-FAIL** under load. Every other sleep in the suite is a bounded poll tick, a negative-assertion window (fails toward false-PASS), or semantically required — out of scope.

If an implementer finds either finding no longer true (e.g. a bound already added), STOP that task and report instead of changing anything.

## Global Constraints

- **Base:** all work on the current worktree branch `fix/dedupe-cache-followups` (based on `f065cf58`, the crash-hardening merge) — NOT `main`. Worktree: `/home/dan/code/freshell/.worktrees/rust-tauri-port/.worktrees/dedupe-cache-followups`.
- **No new dependencies** — no workspace deps, no crate deps, no dev-deps. Hand-roll in house style (`create_limit.rs` / `spawn_gate.rs` are the templates).
- **Frozen read-only paths:** `server/`, `shared/`, `src/`, `dist/client`. Touch only `crates/` + `docs/plans/` + `port/oracle/DEVIATIONS.md`.
- **Process safety:** never broad-kill; only signal PIDs the tests spawned; never bind ports 3001/3002 (user's live freshell runs on :3001).
- **Quality gates (delta vs baseline, never absolute green):** `cargo fmt --all -- --check` clean; `cargo clippy --workspace --all-targets` with no NEW warnings vs the baseline recorded in Task 1 Step 1; `cargo test -p freshell-ws` with no NEW failures vs baseline. Two failures are known-allowed by name: `codex_session_ref_resume::codex_create_derives_resume_from_session_ref` (environmental — no `node_modules` in this worktree) and `session_identity_frames::fresh_claude_create_frames_carry_preallocated_session_ref` (pre-existing defect).
- **TDD:** Red-Green-Refactor for every task; never skip the failing-test step.
- **Commits:** Conventional Commits with crate scope, ASCII subject, bullet body, a `Verification:` paragraph naming the exact commands run, and the Amplifier footer — via four separate `-m` args. Explicit `git add <paths>`, never `-A`. No PR (port campaign rule).
- **Build note:** this worktree has no `target/`; the first cargo invocation is a cold full build — budget long timeouts (10+ minutes).
- **Wire-visible deviation rule:** the cache bound is a deliberate divergence from the legacy Node server (whose `createdByRequestId` settled cache in `server/ws-handler.ts` is process-lifetime). It requires a `port/oracle/DEVIATIONS.md` entry + pinning test (Task 2 Step 5).

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `crates/freshell-ws/src/create_dedupe.rs` (331 lines) | Modify | The bounding change lives here entirely: timestamped settled entries, settle-order queue, TTL + cap prune, updated inline unit tests. |
| `crates/freshell-ws/src/terminal.rs` (2,619 lines — **surgical edits only**, file is over the size waiver) | Modify (2 call sites) | Pass wall-clock `now_ms()` into `begin()` (~`:487-492`) and `settle()` (~`:1312-1315`). |
| `crates/freshell-ws/src/create_gate.rs` | Modify | Extract `hold_permit_across` permit-scope helper + new `#[cfg(test)]` unit test pinning release-after-settle. |
| `crates/freshell-ws/tests/restore_spawn_gate.rs` | Modify (1 test) | Replace the racy settled-hold test with the deterministic test-held-permit version. |
| `port/oracle/DEVIATIONS.md` | Modify (append) | Record the deliberate bounded-cache divergence from legacy. |

No new files. No module split (new behavior stays out of `terminal.rs` per the size waiver; `create_dedupe.rs` stays well under 1K lines).

---

### Task 1: TTL-bound the settled dedupe cache

Settled entries expire `SETTLED_TTL_MS` after they settle. Strategy justification (recorded here so reviewers don't re-litigate): a settled entry exists so a **reconnecting client's re-send of a recently settled create** gets the original `terminal.created` replayed instead of spawning a second terminal. The frozen client's retry ladder re-sends within ~2 seconds; reconnect/restore storms play out over seconds to minutes. A TTL of **30 minutes** is orders of magnitude beyond any real reconnect window while making entries mortal on a long-lived server. TTL alone doesn't bound a burst *within* one window, so Task 2 adds a hard cap as a backstop. LRU crates (`lru`, `moka`, `hashlink`) are ruled out: zero cache crates anywhere in the workspace/lockfile as direct deps, and repo policy is hand-rolled small mechanisms with no new dependency edges. The house pattern is prune-on-access with an injectable `now_ms` parameter (`create_limit.rs:116`, `invariants.rs:51`) — no background reaper needed.

**Explicit post-eviction semantics (spec requirement):** a duplicate arriving AFTER its settled entry was evicted finds no entry, gets `DedupeDecision::Proceed`, and runs as a **fresh create — spawning a NEW terminal** and replying with the same requestId but a new terminalId. This is the same observable outcome the code already produces for the killed-terminal displacement path, and it is unreachable in practice inside any real reconnect window (30 min TTL). It is pinned by `duplicate_after_ttl_eviction_proceeds_as_fresh_create` below. The "duplicates never spawn a second terminal" guarantee holds for the full TTL/cap window.

**Files:**
- Modify: `crates/freshell-ws/src/create_dedupe.rs` (struct at `:91-94`, `Entry` at `:41-56`, `begin` at `:101-147`, `settle` at `:153-166`, `clear_if_in_flight` at `:174-192`, tests mod at `:195-331`)
- Modify: `crates/freshell-ws/src/terminal.rs:487-492` (begin call) and `:1312-1315` (settle call)
- Test: inline `#[cfg(test)] mod tests` in `crates/freshell-ws/src/create_dedupe.rs`

**Interfaces:**
- Consumes: `crate::terminal::now_ms() -> i64` (already `pub(crate)`, `terminal.rs:85-88`); `FrameSink` (`freshell_terminal`); `ServerMessage` (`freshell_protocol`).
- Produces (later tasks rely on these exact shapes):
  - `pub fn begin(&self, request_id: &str, sink: &FrameSink, is_live: impl Fn(&str) -> bool, now_ms: i64) -> DedupeDecision`
  - `pub fn settle(&self, request_id: &str, terminal_id: &str, created: &ServerMessage, now_ms: i64)`
  - `pub fn clear_if_in_flight(&self, request_id: &str)` (unchanged signature)
  - `const SETTLED_TTL_MS: i64` (module-private, visible to inline tests)
  - Private `struct Inner { entries: HashMap<String, Entry>, settled_order: VecDeque<(String, i64)> }` behind `CreateDedupe { inner: Mutex<Inner> }`; `Inner::prune_settled(&mut self, now_ms: i64)` (Task 2 extends this fn).

- [ ] **Step 1: Record the quality-gate baseline (before any change)**

Run (long timeout — cold build):

```bash
cd /home/dan/code/freshell/.worktrees/rust-tauri-port/.worktrees/dedupe-cache-followups
cargo clippy --workspace --all-targets 2>&1 | tee /tmp/dedupe-followups-baseline-clippy.txt | grep -c "^warning"
cargo test -p freshell-ws 2>&1 | tee /tmp/dedupe-followups-baseline-test.txt | tail -30
```

Expected: clippy completes (previously recorded baseline: ~60 warnings); tests complete with at most the two known-allowed failures named in Global Constraints. These files are the comparison baseline for every later task. If other tests fail at baseline, note their names — they are pre-existing, not yours to fix, but they must not be *joined* by new ones.

- [ ] **Step 2: Verify the issue still exists (halt condition)**

Run:

```bash
grep -n "settled_at_ms\|SETTLED_TTL\|SETTLED_MAX\|VecDeque" crates/freshell-ws/src/create_dedupe.rs
```

Expected: **no matches.** If any match, the cache has already been bounded — STOP this task and report instead of changing anything.

- [ ] **Step 3: Write the failing tests**

In `crates/freshell-ws/src/create_dedupe.rs`, inside the existing `#[cfg(test)] mod tests` (after the `recording_sink` helper), add a shared time origin and four new tests:

```rust
    /// Arbitrary wall-clock origin for injectable-now tests.
    const T0: i64 = 1_000_000;

    #[test]
    fn settled_entry_replays_until_ttl_boundary() {
        let d = CreateDedupe::default();
        let (s, _f) = recording_sink();
        let _ = d.begin("r1", &s, |_| true, T0);
        d.settle("r1", "t1", &created_frame(), T0);
        // One ms before expiry: still replayed.
        assert!(matches!(
            d.begin("r1", &s, |_| true, T0 + SETTLED_TTL_MS - 1),
            DedupeDecision::DuplicateSettled(_)
        ));
    }

    #[test]
    fn duplicate_after_ttl_eviction_proceeds_as_fresh_create() {
        let d = CreateDedupe::default();
        let (s, _f) = recording_sink();
        let _ = d.begin("r1", &s, |_| true, T0);
        d.settle("r1", "t1", &created_frame(), T0);
        // At/after expiry the entry is gone even though the terminal is
        // live: the duplicate re-enters the normal create lifecycle (a
        // fresh create spawns a NEW terminal, same requestId, new
        // terminalId). This is the explicit post-eviction contract.
        assert!(matches!(
            d.begin("r1", &s, |_| true, T0 + SETTLED_TTL_MS),
            DedupeDecision::Proceed
        ));
        // ...and it is a real InFlight sentinel again: a duplicate from
        // another connection queues as a waiter instead of replaying.
        let (other, _f2) = recording_sink();
        assert!(matches!(
            d.begin("r1", &other, |_| true, T0 + SETTLED_TTL_MS),
            DedupeDecision::DuplicateInFlight
        ));
    }

    #[test]
    fn settle_prunes_entries_past_ttl() {
        let d = CreateDedupe::default();
        let (s, _f) = recording_sink();
        let _ = d.begin("r1", &s, |_| true, T0);
        d.settle("r1", "t1", &created_frame(), T0);
        let _ = d.begin("r2", &s, |_| true, T0 + SETTLED_TTL_MS);
        d.settle("r2", "t2", &created_frame(), T0 + SETTLED_TTL_MS);
        let inner = d.inner.lock().expect("lock");
        assert_eq!(
            inner.entries.len(),
            1,
            "expired r1 must be physically evicted on the next settle"
        );
        assert!(inner.entries.contains_key("r2"));
        assert_eq!(inner.settled_order.len(), 1);
    }

    #[test]
    fn prune_skips_stale_queue_rows_for_resettled_ids() {
        let d = CreateDedupe::default();
        let (s, _f) = recording_sink();
        // Settle r1 at T0, displace it (dead terminal), re-settle at T0+TTL/2.
        let _ = d.begin("r1", &s, |_| true, T0);
        d.settle("r1", "t1", &created_frame(), T0);
        let later = T0 + SETTLED_TTL_MS / 2;
        assert!(matches!(
            d.begin("r1", &s, |_| false, later),
            DedupeDecision::Proceed
        ));
        d.settle("r1", "t1b", &created_frame(), later);
        // Past T0's expiry but not later's: pruning (triggered by a fresh
        // settle) pops the stale T0 queue row but must NOT evict the
        // re-settled entry.
        let probe = T0 + SETTLED_TTL_MS;
        let _ = d.begin("r9", &s, |_| true, probe);
        d.settle("r9", "t9", &created_frame(), probe);
        assert!(matches!(
            d.begin("r1", &s, |_| true, probe),
            DedupeDecision::DuplicateSettled(_)
        ));
    }
```

Also update the seven existing tests in the same mod — every `d.begin(...)` gains `, T0` as a final argument and every `d.settle(...)` gains `, T0` as a final argument. The seven tests (all in `create_dedupe.rs:218-330`): `first_begin_proceeds_and_registers_sentinel`, `settled_entry_replays_frame_while_live`, `dead_terminal_evicts_settled_entry`, `clear_if_in_flight_removes_sentinel_but_not_settled`, `cross_connection_waiter_receives_settle_frame`, `same_connection_duplicate_is_not_a_waiter`, `waiters_get_fail_loud_error_on_non_settled_exit`. Example — `clear_if_in_flight_removes_sentinel_but_not_settled` fully updated:

```rust
    #[test]
    fn clear_if_in_flight_removes_sentinel_but_not_settled() {
        let d = CreateDedupe::default();
        let (s1, _f1) = recording_sink();
        let _ = d.begin("r1", &s1, |_| true, T0);
        d.clear_if_in_flight("r1");
        assert!(matches!(
            d.begin("r1", &s1, |_| true, T0),
            DedupeDecision::Proceed
        ));
        d.settle("r1", "t1", &created_frame(), T0);
        d.clear_if_in_flight("r1");
        assert!(matches!(
            d.begin("r1", &s1, |_| true, T0),
            DedupeDecision::DuplicateSettled(_)
        ));
    }
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cargo test -p freshell-ws create_dedupe`
Expected: **compile error** — `begin`/`settle` do not yet take `now_ms`, and `SETTLED_TTL_MS` / `inner` / `settled_order` do not exist. A compile failure is the RED state for a signature-changing step.

- [ ] **Step 5: Implement TTL expiry**

In `crates/freshell-ws/src/create_dedupe.rs`:

(a) Change the imports line `use std::collections::HashMap;` to:

```rust
use std::collections::{HashMap, VecDeque};
```

(b) Add the TTL constant above `enum Entry`:

```rust
/// How long a settled create stays replayable to a duplicate requester.
/// The frozen client's same-requestId retry ladder re-sends within ~2 s and
/// reconnect/restore storms play out over seconds to minutes; 30 minutes is
/// orders of magnitude beyond any real reconnect window while keeping
/// settled entries mortal on a long-lived server.
const SETTLED_TTL_MS: i64 = 30 * 60 * 1000;
```

(c) Add a timestamp field to the `Settled` variant (`Entry` at `:41-56`):

```rust
    /// The create settled: replay this exact `terminal.created` frame.
    Settled {
        terminal_id: String,
        created: ServerMessage,
        /// Injected wall-clock settle time (epoch ms) — drives TTL expiry.
        settled_at_ms: i64,
    },
```

(d) Replace the `CreateDedupe` struct (`:91-94`) with:

```rust
#[derive(Default)]
struct Inner {
    entries: HashMap<String, Entry>,
    /// Settle-order queue driving eviction (oldest first): one
    /// `(request_id, settled_at_ms)` row pushed per `settle()`. A row whose
    /// map entry was since displaced or re-settled (timestamp mismatch) is
    /// stale bookkeeping — prune pops and skips it.
    settled_order: VecDeque<(String, i64)>,
}

impl Inner {
    /// Evict settled entries that aged past `SETTLED_TTL_MS`, oldest first.
    fn prune_settled(&mut self, now_ms: i64) {
        while let Some((_, settled_at)) = self.settled_order.front() {
            if now_ms - *settled_at < SETTLED_TTL_MS {
                break;
            }
            let (id, settled_at) = self
                .settled_order
                .pop_front()
                .expect("front() checked above");
            if let Some(Entry::Settled { settled_at_ms, .. }) = self.entries.get(&id) {
                if *settled_at_ms == settled_at {
                    self.entries.remove(&id);
                }
            }
        }
    }
}

#[derive(Default)]
pub struct CreateDedupe {
    inner: Mutex<Inner>,
}
```

(e) Replace `begin()` (`:101-147`) with (structure identical to the original, plus the `now_ms` param, the `inner` lock, and the expiry check):

```rust
    pub fn begin(
        &self,
        request_id: &str,
        sink: &FrameSink,
        is_live: impl Fn(&str) -> bool,
        now_ms: i64,
    ) -> DedupeDecision {
        let mut inner = self.inner.lock().expect("create_dedupe lock");
        match inner.entries.get_mut(request_id) {
            Some(Entry::InFlight { origin, waiters }) => {
                let already_known =
                    Arc::ptr_eq(origin, sink) || waiters.iter().any(|w| Arc::ptr_eq(w, sink));
                if !already_known {
                    waiters.push(Arc::clone(sink));
                }
                DedupeDecision::DuplicateInFlight
            }
            Some(Entry::Settled {
                terminal_id,
                created,
                settled_at_ms,
            }) => {
                let expired = now_ms - *settled_at_ms >= SETTLED_TTL_MS;
                if !expired && is_live(terminal_id) {
                    DedupeDecision::DuplicateSettled(created.clone())
                } else {
                    // Terminal killed/exited, or the settled entry aged out
                    // of the dedupe window: evict and treat as fresh.
                    let origin = Arc::clone(sink);
                    inner.entries.insert(
                        request_id.to_string(),
                        Entry::InFlight {
                            origin,
                            waiters: Vec::new(),
                        },
                    );
                    DedupeDecision::Proceed
                }
            }
            None => {
                inner.entries.insert(
                    request_id.to_string(),
                    Entry::InFlight {
                        origin: Arc::clone(sink),
                        waiters: Vec::new(),
                    },
                );
                DedupeDecision::Proceed
            }
        }
    }
```

Preserve the original doc comments on `begin()` verbatim, amending any sentence that claims settled entries live forever.

(f) Replace `settle()` (`:153-166`) with (waiters still invoked WITHOUT the lock held, as before):

```rust
    pub fn settle(
        &self,
        request_id: &str,
        terminal_id: &str,
        created: &ServerMessage,
        now_ms: i64,
    ) {
        let waiters = {
            let mut inner = self.inner.lock().expect("create_dedupe lock");
            let prev = inner.entries.insert(
                request_id.to_string(),
                Entry::Settled {
                    terminal_id: terminal_id.to_string(),
                    created: created.clone(),
                    settled_at_ms: now_ms,
                },
            );
            inner
                .settled_order
                .push_back((request_id.to_string(), now_ms));
            inner.prune_settled(now_ms);
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

Preserve `settle()`'s original doc comment, adding: `/// Also prunes settled entries older than SETTLED_TTL_MS (prune-on-access; no background task).`

(g) In `clear_if_in_flight()` (`:174-192`), only the lock line changes — replace:

```rust
            let mut map = self.entries.lock().expect("create_dedupe lock");
```

with:

```rust
            let mut inner = self.inner.lock().expect("create_dedupe lock");
            let map = &mut inner.entries;
```

(the rest of the fn body keeps using `map` unchanged). Amend its doc line *"Settled entries stay: that IS the dedupe"* to *"Settled entries stay (until TTL/cap eviction): that IS the dedupe."*

(h) Update the two production call sites in `crates/freshell-ws/src/terminal.rs` (surgical, two lines):
- The `begin` dispatch (~`:487-492`): add `now_ms()` as the fourth argument after the `|tid| state.registry.exists(tid)` closure (the free fn `now_ms()` is defined in this same file at `:85-88`).
- The `settle` call (~`:1312-1315`): `.settle(&dedupe_request_id, &dedupe_terminal_id, &created, now_ms())`.

(i) Update the module doc comment (`create_dedupe.rs:1-27`): find the sentences describing settled-entry lifetime/lazy eviction and amend so the doc states: settled entries are retained for replay for a bounded window — each expires `SETTLED_TTL_MS` after settling (Task 2 adds the `SETTLED_MAX` cap sentence); within the window a duplicate replays the original `terminal.created` and never spawns a second terminal; after eviction a re-sent requestId is indistinguishable from a fresh create and spawns a new terminal, which is unreachable in practice because the window is sized far beyond any real reconnect/retry storm. Also update the sizing comment above `#[allow(clippy::large_enum_variant)]` (`:35-40`): change "small settled cache" to "bounded settled cache".

- [ ] **Step 6: Verify no other callers were missed**

Run: `cargo check -p freshell-ws --all-targets && cargo check --workspace --all-targets`
Expected: clean compile. If any other `begin(`/`settle(` caller errors, add `crate::terminal::now_ms()` (or a local `now_ms()`) as the final argument there too — but per the verified survey there are exactly two production call sites, both in `terminal.rs`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `cargo test -p freshell-ws create_dedupe`
Expected: PASS — 11 tests (7 updated + 4 new).

- [ ] **Step 8: Format, lint, and full-crate delta check**

Run:

```bash
cargo fmt --all
cargo clippy -p freshell-ws --all-targets 2>&1 | grep -c "^warning"
cargo test -p freshell-ws 2>&1 | tail -30
```

Expected: `cargo fmt --all -- --check` is clean afterward; clippy warning count <= the Step 1 baseline count (no NEW warnings); test failures are only the known-allowed names from Step 1.

- [ ] **Step 9: Commit**

```bash
git add crates/freshell-ws/src/create_dedupe.rs crates/freshell-ws/src/terminal.rs
git commit \
  -m "fix(freshell-ws): expire settled create-dedupe entries after a TTL" \
  -m "- Follow-up from the crash-hardening reviews: the settled requestId cache grew one immortal ~440-byte entry per successful create for the server lifetime
- Entry::Settled now carries settled_at_ms (injected now_ms parameter, house pattern from create_limit.rs); begin() treats entries older than SETTLED_TTL_MS (30 min) as evicted; settle() prunes expired entries oldest-first via a settle-order queue (prune-on-access, no background task, no new deps)
- Post-eviction contract made explicit and pinned: a duplicate after expiry proceeds as a fresh create (new terminal, same requestId) - unreachable inside any real reconnect window" \
  -m "Verification: cargo test -p freshell-ws create_dedupe (11 passed); cargo test -p freshell-ws; cargo fmt --all -- --check; cargo clippy -p freshell-ws --all-targets (no new warnings; no new failures vs recorded baseline)." \
  -m "$(printf '\xf0\x9f\xa4\x96 Generated with [Amplifier](https://github.com/microsoft/amplifier)\n\nCo-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>')"
```

---

### Task 2: Cap the settled dedupe cache (oldest-first eviction) and record the deviation

TTL alone still allows unbounded growth *within* one 30-minute window under a pathological create rate (the requestId key space is client-controlled). Add a hard cap: `SETTLED_MAX = 4096` settled entries, evicting oldest-settled first. Bound justification: at ~440 bytes per retained frame that is < 2 MiB worst case, while 4096 recent creates inside one TTL window is far beyond any legitimate restore storm (the gate + rate limiter throttle real clients well below that). Eviction order is settle-time FIFO — settled entries are never "refreshed" by replay because a duplicate's relevance window is anchored to the original create, so FIFO is equivalent to LRU here at zero extra bookkeeping.

**Files:**
- Modify: `crates/freshell-ws/src/create_dedupe.rs` (constant, `Inner::prune_settled`, module doc, new test)
- Modify: `port/oracle/DEVIATIONS.md` (append entry)
- Test: inline `#[cfg(test)] mod tests` in `crates/freshell-ws/src/create_dedupe.rs`

**Interfaces:**
- Consumes: `Inner`, `Entry::Settled { settled_at_ms }`, `prune_settled(&mut self, now_ms: i64)`, `const SETTLED_TTL_MS: i64`, test helpers `created_frame()` / `recording_sink()` / `const T0: i64` — all from Task 1.
- Produces: `const SETTLED_MAX: usize = 4096;` (module-private); `prune_settled` now also enforces the cap.

- [ ] **Step 1: Write the failing test**

Add to the tests mod in `crates/freshell-ws/src/create_dedupe.rs`:

```rust
    #[test]
    fn settled_cache_is_capped_evicting_oldest_first() {
        let d = CreateDedupe::default();
        let (s, _f) = recording_sink();
        // Settle SETTLED_MAX + 10 distinct requestIds at the same instant
        // (same instant so TTL cannot be what evicts).
        for i in 0..(SETTLED_MAX + 10) {
            let rid = format!("r{i}");
            let _ = d.begin(&rid, &s, |_| true, T0);
            d.settle(&rid, &format!("t{i}"), &created_frame(), T0);
        }
        {
            let inner = d.inner.lock().expect("lock");
            assert_eq!(inner.entries.len(), SETTLED_MAX);
            assert_eq!(inner.settled_order.len(), SETTLED_MAX);
        }
        // Oldest evicted: r0's duplicate proceeds as a fresh create (the
        // explicit post-eviction contract, same as TTL expiry).
        assert!(matches!(
            d.begin("r0", &s, |_| true, T0),
            DedupeDecision::Proceed
        ));
        // Newest retained: the most recent id still replays.
        let last = format!("r{}", SETTLED_MAX + 9);
        assert!(matches!(
            d.begin(&last, &s, |_| true, T0),
            DedupeDecision::DuplicateSettled(_)
        ));
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p freshell-ws create_dedupe`
Expected: **compile error** — `SETTLED_MAX` not defined. (After Step 3's constant exists but before the prune change, the test would FAIL on `assert_eq!(inner.entries.len(), SETTLED_MAX)` with left = 4106.)

- [ ] **Step 3: Implement the cap**

(a) Add below `SETTLED_TTL_MS` in `create_dedupe.rs`:

```rust
/// Hard cap on retained settled entries (oldest-first eviction) — backstop
/// for pathological create rates within one TTL window. The requestId key
/// space is client-controlled, so TTL alone is not a bound. At ~440 bytes
/// per retained terminal.created frame this is < 2 MiB worst case.
const SETTLED_MAX: usize = 4096;
```

(b) Replace `Inner::prune_settled` (from Task 1) with:

```rust
    /// Evict settled entries that aged past `SETTLED_TTL_MS`, then enforce
    /// `SETTLED_MAX` — both oldest-settled first. Stale queue rows (map
    /// entry displaced or re-settled since; timestamp mismatch) are popped
    /// and skipped without touching the map.
    fn prune_settled(&mut self, now_ms: i64) {
        loop {
            let evict = match self.settled_order.front() {
                None => false,
                Some((_, settled_at)) => {
                    now_ms - *settled_at >= SETTLED_TTL_MS
                        || self.settled_order.len() > SETTLED_MAX
                }
            };
            if !evict {
                break;
            }
            let (id, settled_at) = self
                .settled_order
                .pop_front()
                .expect("front() checked above");
            if let Some(Entry::Settled { settled_at_ms, .. }) = self.entries.get(&id) {
                if *settled_at_ms == settled_at {
                    self.entries.remove(&id);
                }
            }
        }
    }
```

(Known, accepted imprecision: stale queue rows inflate `settled_order.len()` until popped, so the cap can transiently evict slightly earlier than a perfect live-entry count would — eviction is still strictly oldest-first and the semantics degrade gracefully. Stale rows only arise from the rare displace-then-resettle path.)

(c) Extend the module doc sentence from Task 1 Step 5(i) to mention the cap: "...and the cache holds at most `SETTLED_MAX` settled entries, evicting oldest-settled first."

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-ws create_dedupe`
Expected: PASS — 12 tests.

- [ ] **Step 5: Record the deviation from legacy**

Read `port/oracle/DEVIATIONS.md` first and match its existing entry format exactly. Append an entry with this content (adapted to the file's format):

> **Bounded settled create-dedupe cache.** Legacy Node (`server/ws-handler.ts` `createdByRequestId` settled cache, ~`:467`) retains settled create replies for the process lifetime. The Rust port bounds the equivalent `CreateDedupe` settled cache: entries expire 30 minutes after settling (`SETTLED_TTL_MS`) and at most 4096 are retained (`SETTLED_MAX`, oldest-first). Wire-visible only for a duplicate `terminal.create` re-sent after eviction, which then spawns a fresh terminal instead of replaying the original `terminal.created` — unreachable inside any real reconnect/retry window. Deliberate fix (reviewer-adjudicated follow-up to the crash-hardening merge: unbounded server-lifetime growth). Pinning tests: `create_dedupe::tests::duplicate_after_ttl_eviction_proceeds_as_fresh_create`, `create_dedupe::tests::settled_cache_is_capped_evicting_oldest_first`.

- [ ] **Step 6: Format, lint, delta check**

Run:

```bash
cargo fmt --all
cargo clippy -p freshell-ws --all-targets 2>&1 | grep -c "^warning"
cargo test -p freshell-ws 2>&1 | tail -30
```

Expected: no new clippy warnings vs `/tmp/dedupe-followups-baseline-clippy.txt`; only known-allowed test failures.

- [ ] **Step 7: Commit**

```bash
git add crates/freshell-ws/src/create_dedupe.rs port/oracle/DEVIATIONS.md
git commit \
  -m "fix(freshell-ws): cap the settled create-dedupe cache (oldest-first)" \
  -m "- SETTLED_MAX 4096 backstops the TTL: the requestId key space is client-controlled, so TTL alone is not a bound; ~440 bytes/frame keeps worst case under 2 MiB
- FIFO-by-settle-time eviction (equivalent to LRU here: replay never refreshes an entry's relevance window); stale queue rows from displace-then-resettle are skipped by timestamp guard
- Deliberate divergence from legacy's process-lifetime createdByRequestId cache recorded in port/oracle/DEVIATIONS.md with pinning tests" \
  -m "Verification: cargo test -p freshell-ws create_dedupe (12 passed); cargo test -p freshell-ws; cargo fmt --all -- --check; cargo clippy -p freshell-ws --all-targets (no new warnings; no new failures vs recorded baseline)." \
  -m "$(printf '\xf0\x9f\xa4\x96 Generated with [Amplifier](https://github.com/microsoft/amplifier)\n\nCo-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>')"
```

---

### Task 3: Make the settled-hold acceptance test deterministic

Replace the wall-clock race in `restore_create_holds_permit_until_settled` with structural synchronization: the test acquires the gate's single permit itself (the server's real `Arc<RestoreSpawnGate>` is already returned by `spawn_server`), sends both restore creates, and bounded-polls the gate counter until both are observably queued — only then releases. Every original assertion is preserved and one is strengthened: both creates settle with their own requestId (unchanged), `queued_total()` is now asserted `== 2` (was `>= 1`, and was racy), and exactly two PTYs exist (unchanged). A permit-leak check is added (post-settle re-acquire succeeds). The "permit held until settled, not just spawn" discrimination — which the racy original only covered probabilistically (its `queued_total` counter increments on ANY failed try_acquire, so it never structurally distinguished settle-hold from spawn-hold) — moves to a deterministic unit test in Task 4. An injected virtual clock was evaluated and rejected: `start_paused` implies a current-thread runtime and auto-advances on idle, incompatible with this suite's `multi_thread` flavor and real TCP/PTY I/O; the flake source is I/O latency, not a timer.

**Files:**
- Modify: `crates/freshell-ws/tests/restore_spawn_gate.rs:341-370` (the one test; nothing else in the suite)
- Test: same file (this task IS a test change)

**Interfaces:**
- Consumes (all already in `tests/restore_spawn_gate.rs`): `spawn_server(cfg, gate) -> (ws_url, registry, shutdown, Arc<RestoreSpawnGate>, shutdown_started)` (`:75-153`); `connect_and_hello(&ws_url)` (`:161-191`); `send_text` (`:194-198`); `next_json_of_type` (`:201-216`); `create_frame(request_id, restore)` (`:264-274`); `RestoreSpawnGate::new(permits, queue)` and `RestoreSpawnGate::acquire(timeout, &mut watch::Receiver<bool>)` (public — same call shape as the unit test at `src/spawn_gate.rs:222-227`); `queued_total()` accessor (`src/spawn_gate.rs:159-173`).
- Produces: the renamed test `restore_creates_queue_behind_held_permit_and_both_settle` (Task 4's suite run relies on it passing).

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

### Task 4: Deterministically pin the spawn-to-settled permit scope (unit level)

The racy original test's residual value was probabilistic protection against the `da5d9b5c` prior-art bug shape (permit released at the PTY spawn instead of after settle). Task 3's structural rework cannot observe that ordering from outside the server. Pin it deterministically at the unit level: extract the permit-scoped tail of `spawn_gated_restore_create` into a tiny generic helper `hold_permit_across(permit, work)` and unit-test that the permit is dropped only after `work` completes, using a oneshot-parked work future and a drop-observable guard. No behavior change: the helper preserves the exact "run the whole settled create, then drop the permit" ordering of the current code (`create_gate.rs:137-167`).

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

### Task 5: Final verification sweep

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
Expected: failing tests (if any) are exactly a subset of the baseline failures recorded in Task 1 Step 1 (the two known-allowed names in Global Constraints). Test count is baseline + 6 new (4 TTL + 1 cap + 1 permit-scope) with 1 renamed acceptance test.

- [ ] **Step 4: Fix-or-report**

If any gate fails: fix minimally, re-run Steps 1-3, and commit the fix with the appropriate `fix(freshell-ws):`/`style(freshell-ws):`/`test(freshell-ws):` scope and a `Verification:` paragraph. If a failure cannot be attributed to this branch's changes, report it as pre-existing with evidence (baseline file line) rather than papering over it.

---

## Self-Review (completed by the plan author)

**1. Spec coverage:**
- "Verify first, then fix" (follow-up 1) → verification recorded in "Verification of the reported issues" + re-checked as Task 1 Step 2 halt condition. Covered.
- "Bound the cache while preserving dedupe semantics" → Tasks 1-2; replay-within-window pinned by updated existing tests + `settled_entry_replays_until_ttl_boundary`; never-double-spawn within window unchanged (`begin` still returns `DuplicateSettled`/`DuplicateInFlight`). Covered.
- "Justify the strategy and the bound" → Task 1 preamble (TTL choice, house patterns, no-deps policy) + Task 2 preamble (cap size arithmetic, FIFO-equals-LRU argument). Covered.
- "Duplicate after eviction: explicit and tested" → Task 1 preamble contract + `duplicate_after_ttl_eviction_proceeds_as_fresh_create` + cap-eviction `r0` assertion + DEVIATIONS.md entry. Covered.
- "Find the timing-sensitive test, replace timing dependence with deterministic mechanism, no weakened assertions" → Task 3 (identified at `tests/restore_spawn_gate.rs:341-370`; RED reproduction; structural test-held-permit rework; assertions preserved, one strengthened) + Task 4 (the probabilistic held-until-settled residue made deterministic at unit level). Covered.
- "Repo conventions, TDD, fmt+clippy clean, no new failures, minimal surface" → Global Constraints + per-task RED steps + Task 5 sweep; change surface is 4 source files + DEVIATIONS.md. Covered.

**1b. No silent deferrals:** No stubs, mocks-standing-in-for-behavior, TODOs, or deferred requirements. The only test double (`DropFlag` in Task 4) observes a production-equivalent ownership property and is complemented by the real-gate acceptance test; `created_frame()`'s `Pong` stand-in is the module's pre-existing opaque-payload convention. No UNRESOLVED COVERAGE GAPS.

**2. Placeholder scan:** One intentional elision — Task 4 Step 3(b) says "(existing comment verbatim)" for the A10 comment block: that is an instruction to preserve existing file content unchanged, with the surrounding code given in full, not a placeholder for new content. All other steps carry complete code/commands.

**3. Type consistency:** `now_ms: i64` everywhere (matches `terminal.rs::now_ms() -> i64`); `SETTLED_TTL_MS: i64` / `SETTLED_MAX: usize` consistent between Tasks 1-2 and their tests; `settled_order: VecDeque<(String, i64)>` consistent across `Inner`, `prune_settled`, and the size assertions; `begin`/`settle` signatures identical in Task 1 Interfaces, implementation, call sites, and all tests; Task 3's renamed test matches the name referenced in Task 4's comment and both commit messages; `hold_permit_across<G, F>` signature identical in Task 4 Interfaces, test, and implementation.
