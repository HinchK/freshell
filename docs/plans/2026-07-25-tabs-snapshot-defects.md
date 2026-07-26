# Tabs-Snapshot Store Defect Fixes Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Fix three verified fail-loud violations in the server-side tabs-snapshot store (`~/.freshell/tabs-snapshots/`): corrupt device dirs being evicted first, oversize snapshots vanishing silently behind an `accepted:true` ack, and nondeterministic first-json-wins device-id discovery — plus cheap coverage for the orphan-`.tmp` reaper, `PERSIST_LOCK` poisoning, and the empty-push skip.

**Architecture:** All fixes live in `crates/freshell-ws` (the Rust WS server). A new `#[path]`-included sibling module `tabs_persist_retention.rs` takes the device-cap eviction code (the parent file sits at 999 of the repo's 1,000-line limit). `persist_generation` gains an honest `PersistOutcome` return, which flows through `PushAck` → `TabsSyncAck` as optional `persisted`/`persistReason` wire fields (omitted on success, so pre-change acks stay byte-identical). The frozen SPA client tolerates this (verified: it has NO `tabs.sync.ack` handler and no runtime validation of server→client messages); the frozen JSON-Schema contract under `port/contract/` is regenerated additively.

**Tech Stack:** Rust (toolchain 1.96.0, `cargo test -p freshell-ws` / `-p freshell-protocol`), `tempfile` tempdirs for filesystem integration tests, `tracing` + a thread-local capture layer for invariant-alarm assertions, TypeScript shared protocol types + `npm run contract:generate`.

## Global Constraints

- Base: forked from `origin/main` at `c491aee0` (the merge-base). The branch HEAD additionally carries this plan's `docs:` commits, and `origin/main` may have advanced past the base — Task 8 Step 3's pre-push drift check handles that; all line anchors below are stated against `c491aee0`. Work ONLY inside the worktree `/home/dan/code/freshell/.worktrees/tabs-snapshot-defects`, branch `fix/tabs-snapshot-defects`. All relative paths below are relative to that worktree root.
- SCOPE FENCE (Lane A6 of a 6-lane wave): you own `crates/freshell-ws/src/tabs_persist.rs`, the new `crates/freshell-ws/src/tabs_persist_retention.rs`, minimal ack construction in `crates/freshell-ws/src/tabs.rs` + `crates/freshell-ws/src/terminal.rs`, `crates/freshell-protocol/src/server_messages.rs` (one struct), `crates/freshell-protocol/tests/roundtrip.rs`, `shared/ws-protocol.ts` (one type), the regenerated `port/contract/ws-server-messages.schema.json`, and tests. Do NOT touch `crates/freshell-ws/src/tabs_persist_validation.rs`, `crates/freshell-server/src/tabs_snapshots.rs` (`pane_to_create_body` / restore endpoint — Lane A1 / kata h9vt own those), or client `src/` (READ-only for the ack schema). No kimi/gemini.
- CROSS-LANE COORDINATION (verified during load-bearing validation by inspecting the sibling lanes' plans — see the ledger at `.worktrees/.the-usual-logs/tabs-snapshot-defects/load-bearing-ledger.md`): sibling lanes DO touch files this lane edits. Lane `createrequestid-stabilization` owns `tabs_persist_validation.rs` and also appends tests to `tabs_persist_tests.rs`; lane `pane-identity-ledger` modifies `server_messages.rs` (new `durability.degraded` variant, WITHOUT regenerating the frozen contract), `invariants.rs`, and `terminal.rs`; lane `scrollback-persistence` modifies `terminal.rs` (`handle_create`). Consequences: (1) keep this lane's edits to those files minimal and append-only where possible; trivial textual merge conflicts at integration are expected and fine; (2) the contract regen in Task 5 is merge-order-dependent — Task 8 Step 3 now REQUIRES a pre-push drift check (rebase + re-run `npm run contract:generate` + re-verify if any owned file or `port/contract/*` moved on origin/main).
- Empty-push skip (`tabs.rs:205-214`): semantics stay EXACTLY as-is (the design question belongs to kata h9vt). We only add ack-shape test coverage.
- Repo file-size limit: 1,000 lines per file (`port/AGENTS.md`). `tabs_persist.rs` is at 999 — net growth must go to the sibling module.
- Rust tests are ungated: `cargo test -p freshell-ws` runs freely. Broad npm runs (`npm test`, `npm run check`) go through the shared coordinator gate: check `npm run test:status` first; if another agent holds the gate, WAIT (5 sibling lanes run concurrently — never kill a foreign holder). Set `FRESHELL_TEST_SUMMARY="..."` for broad runs. VERIFIED (ledger A9): coordinator state is keyed on the git common dir, so the gate IS shared across worktrees; `test:status` is a pure read; targeted `npm run test:vitest -- <file>` is a passthrough that never takes the gate.
- NPM TOOLING IN THE WORKTREE — no install step needed (VERIFIED, ledger A10): the worktree has no `node_modules`, but node/npm resolution falls through to the parent checkout's `/home/dan/code/freshell/node_modules` (the worktree nests under it), and the contract generator is `__dirname`-relative, so `npm run contract:generate` run from the worktree root reads the WORKTREE's `shared/ws-protocol.ts` and writes the WORKTREE's `port/contract/`. Do NOT run `npm install`/`npm ci` in the worktree. Lockfiles are byte-identical to main's.
- Quality gates mirroring CI: `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings` must pass before push.
- Commits: Conventional-Commit style with scope (e.g. `fix(ws): ...`). Match the co-author trailer convention visible in `git log -5 --format=%B` (the repo appends an Amplifier trailer).
- NEVER restart the user's self-hosted server; NEVER bind ports 3001/3002; NEVER use broad kill patterns. Disk has ~36 GB free — halt on ENOSPC.
- PR POLICY: NOT approved. Push the branch, STOP before `gh pr create`, report branch + proof.
- E2E: a browser pushing an oversize layout is hard to arrange; the campaign spec explicitly accepts unit/integration coverage here. All tests below run over the real filesystem (tempdir), following the file's existing test patterns.
- Client follow-up (explicitly out of scope per spec): the SPA has no `tabs.sync.ack` handler, so surfacing `persisted:false` in the UI requires client work. Note it in the final report as follow-up; do NOT edit client `src/`.

---

## Verified Defect Anatomy (evidence, with line anchors at base c491aee0)

1. **DEFECT 1 — corrupt device dir evicted FIRST.** `enforce_device_cap` (`tabs_persist.rs:946-995`) scores each device dir by its newest `capturedAt` using `.ok()?`-swallowing reads; a dir whose files are ALL corrupt yields an empty iterator → `.max()` → `.unwrap_or(0)` → score 0 → sorted ascending → `dirs.remove(0)` evicts it first. The dir most in need of forensic recovery is destroyed first.
2. **DEFECT 2 — oversize snapshots vanish silently.** `persist_generation` (`tabs_persist.rs:769-853`, returns `()`) skips generations whose pretty-JSON exceeds `MAX_SNAPSHOT_BYTES = 1_048_576` (`:797-802`) with a WARN + `return Ok(())` from its inner closure — indistinguishable from success. The sole production caller (`tabs.rs:234-245` inside `replace_client_snapshot`) ignores everything and returns `PushAck { accepted: true, .. }` unconditionally.
3. **DEFECT 3 — first-json-wins device-id.** `list_snapshot_devices_locked` (`tabs_persist.rs:300-330`) reads the raw `deviceId` from whatever `*.json` the OS's `read_dir` returns first (`:313-316` `.find(...)`) — a half-migrated/hand-edited dir yields nondeterministic identity.

Wire-compat facts (verified): the SPA parses server messages with `JSON.parse(...) as ServerMessage` (`src/lib/ws-client.ts:348-356`, no zod, no runtime validation — documented at `shared/ws-protocol.ts:1-8`), and has NO `tabs.sync.ack` handler at all (`src/store/tabRegistrySync.ts:433-465` handles only `ready`, `tabs.sync.snapshot`, `error`). Extra ack fields cannot break the frozen client. The one artifact that must move in lockstep is `port/contract/ws-server-messages.schema.json` (`tabs.sync.ack` has `additionalProperties: false`), auto-generated from `shared/ws-protocol.ts` by `npm run contract:generate` and byte-for-byte drift-guarded by `test/unit/port/ws-contract-freeze.test.ts`. This is an additive, optional-field, server→client contract change explicitly directed by the campaign task (P2.17 defect 2: "add an honest field ... if the client tolerates unknown fields" — tolerance verified above); record that justification in the Task 5 commit message.

**"Invariant counter" convention:** this crate's established invariant-alarm idiom is NOT an atomic counter — it is a greppable snake_case tracing event on `target: "freshell_ws::invariants"` (see `crates/freshell-ws/src/invariants.rs:47,89`, the `terminal_identity_unresolved`-class convention the campaign doc names), tested via the thread-local capture layer in `invariants.rs` (`mod capture`). A process-global atomic would be flaky under cargo's multi-threaded test runner; the thread-local subscriber is parallel-safe. All new alarms below follow that convention.

**Size-cap policy decision (spec asked us to evaluate):** keep `MAX_SNAPSHOT_BYTES = 1_048_576`. Each record is tab/pane metadata (~1–2 KB per tab), so 1 MiB accommodates hundreds of tabs; the store's documented hard bound (~2.5 GiB = 64 devices × 40 files × 1 MiB) depends on it. Honesty is the fix; the cap is policy and stays.

---

## File Structure

| File | Role in this plan |
|---|---|
| `crates/freshell-ws/src/tabs_persist_retention.rs` | **Create.** Device-cap eviction (`enforce_device_cap` moved here, then rewritten) + `PersistOutcome`. `#[path]`-included child of `tabs_persist` (same trick as `tabs_persist_validation.rs`), so `use super::*` sees the parent's private items. |
| `crates/freshell-ws/src/tabs_persist.rs` | **Modify.** Delete moved code; `persist_generation` returns `PersistOutcome`; oversize branch alarms loudly; `list_snapshot_devices_locked` becomes verify-all-agree. |
| `crates/freshell-ws/src/tabs_persist_tests.rs` | **Modify.** New integration tests (real tempdir filesystem). Already 1,239 lines — the repo's existing practice keeps this sibling test file growing, so add here. |
| `crates/freshell-ws/src/invariants.rs` | **Modify (test-only visibility).** Make the capture harness `pub(crate)` so `tabs_persist_tests.rs` and `terminal.rs` tests can assert alarms. |
| `crates/freshell-ws/src/tabs.rs` | **Modify (minimal).** `PushAck` gains `persisted`/`persist_reason`; `replace_client_snapshot` maps `PersistOutcome` into them. |
| `crates/freshell-ws/src/terminal.rs` | **Modify (minimal).** `tabs_push_response` maps the two new fields; new ack tests in the existing `tabs_push_validation_tests` module. |
| `crates/freshell-protocol/src/server_messages.rs` | **Modify.** `TabsSyncAck` gains two optional serde fields (`skip_serializing_if`). |
| `crates/freshell-protocol/tests/roundtrip.rs` | **Modify.** New `tabs.sync.ack` schema-conformance roundtrip test. |
| `shared/ws-protocol.ts` | **Modify.** `TabsSyncAckMessage` gains two optional fields. |
| `port/contract/ws-server-messages.schema.json` | **Regenerated** by `npm run contract:generate` — never hand-edited. |

---

### Task 1: Baseline + extract eviction into `tabs_persist_retention.rs` (pure move)

**Files:**
- Create: `crates/freshell-ws/src/tabs_persist_retention.rs`
- Modify: `crates/freshell-ws/src/tabs_persist.rs` (delete lines ~942–995, add module include)

**Interfaces:**
- Produces: `mod retention` inside `tabs_persist`, exposing `pub(super) fn enforce_device_cap(root: &Path, target_dir: &Path) -> std::io::Result<()>` — identical behavior to today (the rewrite is Task 3).

- [ ] **Step 1: Verify the baseline is green**

Run (from the worktree root):
```bash
cd /home/dan/code/freshell/.worktrees/tabs-snapshot-defects
git merge-base --is-ancestor c491aee0 HEAD && echo BASE-OK   # expect: BASE-OK
git log --oneline c491aee0..HEAD   # expect: only this plan's docs commits (docs: ...); no code commits yet
cargo test -p freshell-ws
cargo test -p freshell-protocol
npm run test:status
```
Expected: both cargo suites PASS. `npm run test:status` shows the coordinator/baseline status — if it reports a green baseline for the current base, proceed; if it is stale/unknown, run the gated suite per AGENTS.md (`FRESHELL_TEST_SUMMARY="lane A6 baseline check" npm test`) and WAIT if another agent holds the gate. If the baseline is red for reasons unrelated to this lane, HALT and report.

- [ ] **Step 2: Create the new sibling module with `enforce_device_cap` moved verbatim**

Create `crates/freshell-ws/src/tabs_persist_retention.rs` with exactly this content (the function body is byte-identical to the one currently at `tabs_persist.rs:946-995`; only `fn` → `pub(super) fn` changes):

```rust
//! Device-directory retention: the device-count cap and its eviction policy.
//!
//! Split out of `tabs_persist.rs` (which sits at the repo's 1,000-line file
//! limit) following the `tabs_persist_validation.rs` precedent. Included from
//! `tabs_persist.rs` via `#[path]`, so `super::*` is the `tabs_persist`
//! module and this child can use its private items.

use super::*;

/// Enforce MAX_SNAPSHOT_DEVICES before a write. New targets reserve one slot;
/// existing targets also repair a previously over-cap root. Lease-protected
/// restores and the write target are never candidates. If no eligible victim
/// remains, fail with `WouldBlock` rather than creating another directory.
pub(super) fn enforce_device_cap(root: &Path, target_dir: &Path) -> std::io::Result<()> {
    let target_exists = target_dir.exists();
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err),
    };
    let mut dirs: Vec<(i64, PathBuf)> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .map(|p| {
            let newest = std::fs::read_dir(&p)
                .into_iter()
                .flatten()
                .flatten()
                .map(|f| f.path())
                .filter(|f| f.extension().is_some_and(|x| x == "json"))
                .filter_map(|f| {
                    serde_json::from_str::<Value>(&std::fs::read_to_string(&f).ok()?)
                        .ok()?
                        .get("capturedAt")
                        .and_then(Value::as_i64)
                })
                .max()
                .unwrap_or(0);
            (newest, p)
        })
        .collect();
    let mut device_count = dirs.len();
    let allowed_before_write = if target_exists {
        MAX_SNAPSHOT_DEVICES
    } else {
        MAX_SNAPSHOT_DEVICES.saturating_sub(1)
    };
    dirs.retain(|(_, path)| path != target_dir && !restore_protects(path));
    while device_count > allowed_before_write {
        if dirs.is_empty() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::WouldBlock,
                "snapshot device cap is exhausted: all eviction candidates are protected by active restores; retry the tabs-sync push",
            ));
        }
        dirs.sort_by_key(|(c, _)| *c);
        let (_, victim) = dirs.remove(0);
        remove_dir_all_logged(&victim)?;
        device_count -= 1;
    }
    Ok(())
}
```

IMPORTANT: before writing the file, diff the body above against the current `enforce_device_cap` in `tabs_persist.rs` (`sed -n '942,995p' crates/freshell-ws/src/tabs_persist.rs`) and use the file's exact bytes if they differ in whitespace/comments — this step is a pure move.

- [ ] **Step 3: Replace the function in `tabs_persist.rs` with the module include**

In `crates/freshell-ws/src/tabs_persist.rs`, delete the entire `enforce_device_cap` function INCLUDING its doc comment (the block currently at lines ~942–995) and put in its place:

```rust
#[path = "tabs_persist_retention.rs"]
mod retention;
use retention::enforce_device_cap;
```

Do not change the call site (`enforce_device_cap(dir, &device_dir)?;` inside `persist_generation`) — the `use` keeps the bare name resolving.

- [ ] **Step 4: Run the tests to prove the move changed nothing**

Run: `cargo test -p freshell-ws`
Expected: PASS — identical test set to Step 1, including `device_cap_evicts_least_recently_written_device`, `device_delete_failure_does_not_create_over_cap_directory`, and `all_lease_protected_devices_make_new_write_retryable_without_exceeding_cap`.

Also run: `cargo fmt --all --check && cargo clippy -p freshell-ws --all-targets -- -D warnings`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/src/tabs_persist.rs crates/freshell-ws/src/tabs_persist_retention.rs
git commit -m "refactor(ws): extract device-cap eviction into tabs_persist_retention module

Pure move: tabs_persist.rs sits at the 1,000-line repo limit and the
upcoming defect fixes need room. No behavior change."
```

---

### Task 2: `PersistOutcome` — persist_generation stops lying (defect 2, storage half)

**Files:**
- Modify: `crates/freshell-ws/src/tabs_persist_retention.rs` (add `PersistOutcome`)
- Modify: `crates/freshell-ws/src/tabs_persist.rs` (`persist_generation` signature + body)
- Modify: `crates/freshell-ws/src/invariants.rs` (capture harness visibility, test-only)
- Modify: `crates/freshell-ws/src/tabs.rs` (one line at the call site)
- Test: `crates/freshell-ws/src/tabs_persist_tests.rs`

**Interfaces:**
- Consumes: Task 1's `retention` module.
- Produces: `#[must_use] pub(crate) enum PersistOutcome { Persisted, Skipped { reason: &'static str }, Failed { reason: String } }`, re-exported as `crate::tabs_persist::PersistOutcome`; `persist_generation(...) -> PersistOutcome` (same 8 parameters, unchanged order); invariant alarm event name `tabs_snapshot_dropped_oversize` on target `freshell_ws::invariants`; `crate::invariants::capture::capture()` visible crate-wide under `cfg(test)`.

- [ ] **Step 1: Hoist the invariants capture harness to crate visibility (test infra)**

VERIFIED (load-bearing validation, ledger A1): `mod capture` (invariants.rs:120) is currently nested INSIDE the private `#[cfg(test)] mod tests` (invariants.rs:100), so the path `crate::invariants::capture` does NOT exist today — a visibility keyword alone is not enough. Do a mechanical hoist:

1. Move the entire `mod capture { ... }` block (~lines 120–198) OUT of `mod tests` to `invariants.rs` top level, declared as:

```rust
#[cfg(test)]
pub(crate) mod capture {
```

2. Re-point the two intra-`mod tests` references to it (`capture::CapturedEvent` uses at ~:200 and ~:285) — `use super::capture;` at the top of `mod tests` keeps them compiling unchanged.
3. Ensure `capture()`, `CapturedEvent`, and its `target` / `message` fields are at least `pub(crate)` (`target`/`message` are already `pub`; verified).

The module's `use` statements are self-contained, so the hoist is mechanical. Run `cargo test -p freshell-ws invariants` to prove the existing invariants tests still pass. No production code changes.

- [ ] **Step 2: Write the failing tests**

Append to `crates/freshell-ws/src/tabs_persist_tests.rs`:

```rust
#[test]
fn oversize_drop_returns_skipped_and_fires_invariant_alarm() {
    // Campaign fail-loud: an oversize drop must be an ERROR-class invariant
    // alarm and an honest non-Persisted outcome — never a silent WARN + Ok.
    let (events, _guard) = crate::invariants::capture::capture();
    let dir = tempfile::tempdir().unwrap();
    let big = "x".repeat(MAX_SNAPSHOT_BYTES + 10);
    let mut rec = open_record("dev:t1", "big", 1);
    rec["blob"] = json!(big);
    let outcome =
        persist_generation(dir.path(), "srv-1", "dev", "Dev", "c1", 1, &[rec], 1000);
    assert_eq!(outcome, PersistOutcome::Skipped { reason: "oversize" });
    let events = events.lock().unwrap();
    assert!(
        events.iter().any(|e| e.target == "freshell_ws::invariants"
            && e.message.contains("tabs_snapshot_dropped_oversize")),
        "oversize drop must fire the invariant alarm, got: {events:?}"
    );
}

#[test]
fn successful_persist_returns_persisted() {
    let dir = tempfile::tempdir().unwrap();
    let outcome = persist_generation(
        dir.path(),
        "srv-1",
        "dev",
        "Dev",
        "c1",
        1,
        &[open_record("dev:t1", "t", 1)],
        1000,
    );
    assert_eq!(outcome, PersistOutcome::Persisted);
    assert_eq!(list_generations(dir.path(), "dev", "c1").len(), 1);
}
```

(If the capture harness exposes different field/accessor names, adapt the two assertion lines to them — the contract is: an event on target `freshell_ws::invariants` whose message contains `tabs_snapshot_dropped_oversize`.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test -p freshell-ws oversize_drop_returns_skipped -- --nocapture`
Expected: FAIL to COMPILE — `persist_generation` returns `()` and `PersistOutcome` does not exist. A compile failure is the RED state here; record it.

- [ ] **Step 4: Implement `PersistOutcome` and the honest return**

(a) In `crates/freshell-ws/src/tabs_persist_retention.rs`, add at the top (after `use super::*;`):

```rust
/// The honest result of one persistence attempt. `tabs.sync.push` surfaces
/// non-persistence on the ack (`persisted:false` + reason) instead of
/// silently ACKing (campaign fail-loud principle, P2.17 defect 2).
#[must_use]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PersistOutcome {
    /// The generation was durably written.
    Persisted,
    /// Deliberately not written (policy: oversize or malformed identifiers).
    Skipped { reason: &'static str },
    /// The write was attempted and failed (io error / cap unenforceable).
    Failed { reason: String },
}
```

(b) In `crates/freshell-ws/src/tabs_persist.rs`, next to the existing `use retention::enforce_device_cap;` add:

```rust
pub(crate) use retention::PersistOutcome;
```

(c) Change `persist_generation`:
- Signature: `) {` → `) -> PersistOutcome {` (keep all 8 parameters, `pub(crate)`, and the `#[allow(clippy::too_many_arguments)]`).
- Inner closure type: `let write = || -> std::io::Result<()> {` → `let write = || -> std::io::Result<PersistOutcome> {`.
- The two early identifier bail-outs (~lines 782–787, currently `return Ok(());`): the empty/uncontainable `device_id` one becomes `return Ok(PersistOutcome::Skipped { reason: "invalid-device-id" });` and the un-encodable `client_instance_id` one becomes `return Ok(PersistOutcome::Skipped { reason: "invalid-client-instance-id" });` (keep any logging they already do).
- The oversize branch (currently WARN + `return Ok(())`) becomes:

```rust
        let bytes = serde_json::to_vec_pretty(&snapshot)?;
        if bytes.len() > MAX_SNAPSHOT_BYTES {
            tracing::error!(target: "freshell_ws::invariants",
                device_id = %device_id, bytes = bytes.len(), max = MAX_SNAPSHOT_BYTES,
                "tabs_snapshot_dropped_oversize: generation exceeds MAX_SNAPSHOT_BYTES; nothing was persisted and the ack will carry persisted:false");
            return Ok(PersistOutcome::Skipped { reason: "oversize" });
        }
```

(Delete the old `tabs_snapshot_skipped_oversize` WARN — one loud event, not two.)
- The closure's final `Ok(())` becomes `Ok(PersistOutcome::Persisted)`.
- The tail of the function becomes:

```rust
    match with_persist_lock(write) {
        Ok(outcome) => outcome,
        Err(err) => {
            tracing::warn!(target: "freshell_ws::tabs", device_id = %device_id, dir = %dir.display(),
                error = %err, "tabs_snapshot_persist_failed: generation not written");
            PersistOutcome::Failed { reason: err.to_string() }
        }
    }
```

Also update the doc comment's "never an Err" sentence to: "Best-effort w.r.t. the push (a failed snapshot never fails a tabs push) but HONEST: every non-write returns a non-`Persisted` outcome that the ack surfaces."

(d) Fix the two now-must_use call sites that don't consume the outcome yet:
- `crates/freshell-ws/src/tabs.rs` (~line 235): `crate::tabs_persist::persist_generation(` → `let _ = crate::tabs_persist::persist_generation(` with the comment line above it: `// Outcome is wired onto the ack in the ack-plumbing change; explicitly discarded until PushAck carries it.`
- `crates/freshell-ws/src/tabs_persist_tests.rs` `put()` helper (~line 32) and the direct thread calls in `concurrent_pushes_same_and_different_devices_stay_consistent` (~line 800): prefix each bare `persist_generation(...)` statement with `let _ = `.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p freshell-ws`
Expected: PASS, including both new tests and the untouched incumbent `oversize_snapshot_is_skipped_not_written` (disk semantics unchanged).

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-ws/src/tabs_persist.rs crates/freshell-ws/src/tabs_persist_retention.rs \
        crates/freshell-ws/src/tabs_persist_tests.rs crates/freshell-ws/src/invariants.rs \
        crates/freshell-ws/src/tabs.rs
git commit -m "feat(ws): persist_generation returns honest PersistOutcome; oversize drop alarms loudly

Defect 2 (storage half, campaign P2.17): an oversize generation was
WARN + Ok(()) — indistinguishable from success. Now it is an ERROR-class
invariant alarm (tabs_snapshot_dropped_oversize) and a Skipped outcome.
The 1 MiB cap itself is kept: records are ~1-2KB/tab metadata and the
store's 2.5 GiB hard bound depends on it. Honesty is the fix."
```

---

### Task 3: Corrupt device dirs are exempt from cap eviction (defect 1)

**Files:**
- Modify: `crates/freshell-ws/src/tabs_persist_retention.rs` (rewrite `enforce_device_cap`, add `scan_device_dir`)
- Test: `crates/freshell-ws/src/tabs_persist_tests.rs`

**Interfaces:**
- Consumes: `PersistOutcome` (Task 2), `put()` / `open_record()` / `device_dir_for()` test helpers, `crate::invariants::capture::capture()`.
- Produces: same `pub(super) fn enforce_device_cap(root: &Path, target_dir: &Path) -> std::io::Result<()>` signature; invariant alarms `tabs_snapshot_corrupt_dir_exempt_from_eviction` and `tabs_snapshot_device_cap_unenforceable`; eviction WARN `tabs_snapshot_device_evicted`.

- [ ] **Step 1: Write the failing tests**

Append to `crates/freshell-ws/src/tabs_persist_tests.rs`:

```rust
// Corrupt every generation file in a device dir (defect-1 fixtures) and
// return the dir path.
fn corrupt_all_files(dir: &std::path::Path, device: &str) -> std::path::PathBuf {
    let ddir = device_dir_for(dir, device).unwrap();
    for path in std::fs::read_dir(&ddir).unwrap().flatten().map(|e| e.path()) {
        if path.extension().is_some_and(|x| x == "json") {
            std::fs::write(&path, b"{ not valid json").unwrap();
        }
    }
    ddir
}

#[test]
fn corrupt_device_dir_is_exempt_from_cap_eviction() {
    // Fail-loud: a dir with >=1 unreadable file is forensic evidence and must
    // NEVER be the eviction victim. The oldest CLEAN dir evicts instead.
    // (Old scoring gave an all-corrupt dir capturedAt=0 -> evicted FIRST.)
    let (events, _guard) = crate::invariants::capture::capture();
    let dir = tempfile::tempdir().unwrap();
    for n in 0..MAX_SNAPSHOT_DEVICES {
        let dev = format!("dev-{n:03}");
        put(
            dir.path(),
            &dev,
            "c1",
            1,
            1000 + n as i64,
            vec![open_record(&format!("{dev}:t"), "t", 1)],
        );
    }
    // dev-001 is nearly the oldest AND fully corrupt: the old code evicts it
    // first (score 0). It must survive; clean oldest dev-000 evicts instead.
    let corrupt_dir = corrupt_all_files(dir.path(), "dev-001");

    put(
        dir.path(),
        "dev-new",
        "c1",
        1,
        9000,
        vec![open_record("dev-new:t", "new", 1)],
    );

    assert!(corrupt_dir.exists(), "corrupt dir must be exempt from eviction");
    assert!(
        !device_dir_for(dir.path(), "dev-000").unwrap().exists(),
        "the oldest CLEAN dir must be the victim instead"
    );
    assert!(
        device_dir_for(dir.path(), "dev-new").unwrap().exists(),
        "the new write must land"
    );
    let events = events.lock().unwrap();
    assert!(
        events.iter().any(|e| e.target == "freshell_ws::invariants"
            && e.message.contains("tabs_snapshot_corrupt_dir_exempt_from_eviction")),
        "exempting a corrupt dir must be loud, got: {events:?}"
    );
}

#[test]
fn cap_unenforceable_fails_the_write_and_preserves_all_evidence() {
    // When every candidate holds unreadable files, refuse to evict: fail the
    // incoming write loudly rather than destroy evidence.
    let (events, _guard) = crate::invariants::capture::capture();
    let dir = tempfile::tempdir().unwrap();
    for n in 0..MAX_SNAPSHOT_DEVICES {
        let dev = format!("dev-{n:03}");
        put(
            dir.path(),
            &dev,
            "c1",
            1,
            1000 + n as i64,
            vec![open_record(&format!("{dev}:t"), "t", 1)],
        );
        corrupt_all_files(dir.path(), &dev);
    }
    let outcome = persist_generation(
        dir.path(),
        "srv-1",
        "dev-new",
        "Dev",
        "c1",
        1,
        &[open_record("dev-new:t", "new", 1)],
        9000,
    );
    assert!(
        matches!(outcome, PersistOutcome::Failed { .. }),
        "unenforceable cap must fail the incoming write, got {outcome:?}"
    );
    assert!(
        !device_dir_for(dir.path(), "dev-new").unwrap().exists(),
        "no new dir may be created past the cap"
    );
    let surviving = std::fs::read_dir(dir.path())
        .unwrap()
        .flatten()
        .filter(|e| e.path().is_dir())
        .count();
    assert_eq!(surviving, MAX_SNAPSHOT_DEVICES, "no corrupt dir may be destroyed");
    let events = events.lock().unwrap();
    assert!(
        events.iter().any(|e| e
            .message
            .contains("tabs_snapshot_device_cap_unenforceable")),
        "must alarm loudly: {events:?}"
    );
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-ws corrupt_device_dir_is_exempt -- --nocapture && cargo test -p freshell-ws cap_unenforceable_fails -- --nocapture`
Expected: both FAIL. The first fails on `corrupt_dir.exists()` (the corrupt dir was evicted first). The second fails on the `PersistOutcome::Failed` match (the corrupt dirs get evicted, the write succeeds).

- [ ] **Step 3: Rewrite `enforce_device_cap` with corruption-aware scoring**

In `crates/freshell-ws/src/tabs_persist_retention.rs`, replace the whole `enforce_device_cap` function (keep `PersistOutcome` above it) with:

```rust
/// One device dir's health for eviction scoring.
struct DeviceDirHealth {
    /// Max `capturedAt` over cleanly-parseable files (`i64::MIN` when the dir
    /// holds no parseable generation at all, e.g. an empty dir).
    newest: i64,
    /// Files (or the dir listing itself) that failed to read, parse, or carry
    /// an i64 `capturedAt`.
    unreadable: usize,
    path: PathBuf,
}

fn scan_device_dir(path: PathBuf) -> DeviceDirHealth {
    let mut newest = i64::MIN;
    let mut unreadable = 0usize;
    match std::fs::read_dir(&path) {
        // An unlistable dir is unreadable evidence, not an empty dir.
        Err(_) => unreadable += 1,
        Ok(entries) => {
            for f in entries.flatten().map(|e| e.path()) {
                if !f.extension().is_some_and(|x| x == "json") {
                    continue;
                }
                let captured = std::fs::read_to_string(&f)
                    .ok()
                    .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                    .and_then(|v| v.get("capturedAt").and_then(Value::as_i64));
                match captured {
                    Some(c) => newest = newest.max(c),
                    None => unreadable += 1,
                }
            }
        }
    }
    DeviceDirHealth { newest, unreadable, path }
}

/// Enforce MAX_SNAPSHOT_DEVICES before a write. New targets reserve one slot;
/// existing targets also repair a previously over-cap root. Lease-protected
/// restores, the write target, and — fail-loud, campaign P2.17 defect 1 —
/// any dir holding unreadable generation files are never candidates: corrupt
/// dirs are forensic evidence, not the cheapest victim. If no cleanly
/// parseable victim remains, fail the incoming write with `WouldBlock`
/// rather than destroying evidence or creating another directory.
pub(super) fn enforce_device_cap(root: &Path, target_dir: &Path) -> std::io::Result<()> {
    let target_exists = target_dir.exists();
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err),
    };
    let dirs: Vec<DeviceDirHealth> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .map(scan_device_dir)
        .collect();
    let mut device_count = dirs.len();
    let allowed_before_write = if target_exists {
        MAX_SNAPSHOT_DEVICES
    } else {
        MAX_SNAPSHOT_DEVICES.saturating_sub(1)
    };
    if device_count <= allowed_before_write {
        return Ok(());
    }
    // Under eviction pressure only: classify candidates. Corrupt dirs are
    // exempt AND loud (bounded: this only logs while over-cap).
    let mut corrupt_exempt = 0usize;
    let mut candidates: Vec<(i64, PathBuf)> = Vec::new();
    for d in dirs {
        if d.path == *target_dir || restore_protects(&d.path) {
            continue;
        }
        if d.unreadable > 0 {
            corrupt_exempt += 1;
            tracing::error!(target: "freshell_ws::invariants",
                path = %d.path.display(), unreadable = d.unreadable,
                "tabs_snapshot_corrupt_dir_exempt_from_eviction: device dir holds unreadable generation files; exempting it from cap eviction to preserve forensic evidence");
            continue;
        }
        candidates.push((d.newest, d.path));
    }
    candidates.sort_by_key(|(c, _)| *c);
    let mut candidates = candidates.into_iter();
    while device_count > allowed_before_write {
        let Some((_, victim)) = candidates.next() else {
            tracing::error!(target: "freshell_ws::invariants",
                root = %root.display(), corrupt_exempt,
                "tabs_snapshot_device_cap_unenforceable: no cleanly-parseable eviction candidate remains; failing the incoming write instead of destroying evidence");
            return Err(std::io::Error::new(
                std::io::ErrorKind::WouldBlock,
                "snapshot device cap is exhausted: remaining candidates are protected by active restores or hold unreadable (corrupt) generations; refusing to evict",
            ));
        };
        tracing::warn!(target: "freshell_ws::tabs", path = %victim.display(),
            "tabs_snapshot_device_evicted: device cap reached; evicting the least-recently-written clean device dir");
        remove_dir_all_logged(&victim)?;
        device_count -= 1;
    }
    Ok(())
}
```

Behavior notes locked in by this code: (a) corrupt/protected/target dirs still COUNT toward `device_count` (matching the existing lease-protected precedent, so the `WouldBlock` branch stays reachable); (b) an empty clean dir scores `i64::MIN` and evicts first — it holds no evidence; (c) `WouldBlock` is kept as the error kind so the existing retryable-push contract (`all_lease_protected_devices_make_new_write_retryable_without_exceeding_cap`) is unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p freshell-ws`
Expected: PASS — both new tests, plus the three incumbent cap tests (`device_cap_evicts_least_recently_written_device`, `device_delete_failure_does_not_create_over_cap_directory`, `all_lease_protected_devices_make_new_write_retryable_without_exceeding_cap`) all green.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/src/tabs_persist_retention.rs crates/freshell-ws/src/tabs_persist_tests.rs
git commit -m "fix(ws): exempt corrupt device dirs from snapshot cap eviction

Defect 1 (campaign P2.17): .ok()?-swallowed scoring gave an all-corrupt
device dir capturedAt=0 and evicted it FIRST — destroying exactly the
evidence most in need of forensic recovery. Corrupt dirs are now exempt
and loud; eviction only ever removes cleanly-parseable dirs; when that
makes the cap unenforceable the incoming write fails loudly instead."
```

---

### Task 4: The ack stops lying — `persisted`/`persistReason` (defect 2, wire half)

**Files:**
- Modify: `crates/freshell-ws/src/tabs.rs` (`PushAck` + `replace_client_snapshot` mapping)
- Modify: `crates/freshell-protocol/src/server_messages.rs` (`TabsSyncAck`, ~lines 805-811)
- Modify: `crates/freshell-ws/src/terminal.rs` (`tabs_push_response` mapping, ~lines 2158-2164)
- Test: `crates/freshell-ws/src/terminal.rs` (existing `mod tabs_push_validation_tests`, ~lines 2315-2431)

**Interfaces:**
- Consumes: `crate::tabs_persist::PersistOutcome` and `crate::tabs_persist::MAX_SNAPSHOT_BYTES` (Task 2).
- Produces: `PushAck { accepted: bool, open_records: i64, closed_records: i64, persisted: Option<bool>, persist_reason: Option<String> }`; wire struct `TabsSyncAck` with optional `persisted` / `persist_reason` fields serializing as `persisted` / `persistReason` and OMITTED when `None`. Semantics: `Some(false)` + reason only when a persistence ATTEMPT did not durably write; `None`/`None` when persisted normally OR when persistence was not attempted by design (empty push, persistence disabled) — `accepted` semantics unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `mod tabs_push_validation_tests` in `crates/freshell-ws/src/terminal.rs` (copy the frame shape from the module's existing `custom_extension_mode_push_is_accepted_and_persisted` test at ~line 2372 — that exact shape is known-accepted by push validation):

```rust
    #[tokio::test]
    async fn oversize_push_acks_persisted_false_with_reason() {
        let snapshots = tempfile::tempdir().unwrap();
        let tabs = crate::tabs::TabsRegistry::with_persist_dir(snapshots.path().to_path_buf());
        // Inflate via tabName (a plain validated string field) so the frame
        // stays schema-valid while the persisted document exceeds the cap.
        let big = "x".repeat(crate::tabs_persist::MAX_SNAPSHOT_BYTES + 10);
        let frame = serde_json::json!({
            "type": "tabs.sync.push",
            "deviceId": "dev-1",
            "deviceLabel": "Device 1",
            "clientInstanceId": "client-1",
            "snapshotRevision": 1,
            "records": [{
                "tabKey": "dev-1:tab-1",
                "tabId": "tab-1",
                "tabName": big,
                "status": "open",
                "revision": 1,
                "updatedAt": 1,
                "paneCount": 1,
                "panes": [{
                    "paneId": "pane-1",
                    "kind": "terminal",
                    "payload": {
                        "mode": "acme-custom-cli",
                        "shell": "system",
                        "sessionRef": {
                            "provider": "acme-custom-cli",
                            "sessionId": "session-1"
                        }
                    }
                }]
            }]
        });

        match tabs_push_response(&frame, tabs, "srv-test".to_string()).await {
            TabsPushResponse::Ack(message) => match *message {
                ServerMessage::TabsSyncAck(ack) => {
                    assert!(ack.accepted, "accepted semantics must not change");
                    assert_eq!(ack.persisted, Some(false), "the ack must stop lying");
                    assert_eq!(ack.persist_reason.as_deref(), Some("oversize"));
                }
                other => panic!("unexpected acknowledgement frame: {other:?}"),
            },
            TabsPushResponse::Error(error) => {
                panic!("oversize push must still be accepted: {error}")
            }
        }
        assert!(
            crate::tabs_persist::read_generation(snapshots.path(), "dev-1", 0)
                .unwrap()
                .is_none(),
            "oversize generation must not be written"
        );
    }

    #[tokio::test]
    async fn normal_push_ack_omits_persist_fields_on_the_wire() {
        // Wire-compat: when the write succeeds the ack must stay byte-identical
        // to the pre-change shape (fields OMITTED, not null) for the frozen
        // client and contract.
        let snapshots = tempfile::tempdir().unwrap();
        let tabs = crate::tabs::TabsRegistry::with_persist_dir(snapshots.path().to_path_buf());
        let frame = serde_json::json!({
            "type": "tabs.sync.push",
            "deviceId": "dev-1",
            "deviceLabel": "Device 1",
            "clientInstanceId": "client-1",
            "snapshotRevision": 1,
            "records": [{
                "tabKey": "dev-1:tab-1",
                "tabId": "tab-1",
                "tabName": "small",
                "status": "open",
                "revision": 1,
                "updatedAt": 1,
                "paneCount": 1,
                "panes": [{
                    "paneId": "pane-1",
                    "kind": "terminal",
                    "payload": {
                        "mode": "acme-custom-cli",
                        "shell": "system",
                        "sessionRef": {
                            "provider": "acme-custom-cli",
                            "sessionId": "session-1"
                        }
                    }
                }]
            }]
        });
        match tabs_push_response(&frame, tabs, "srv-test".to_string()).await {
            TabsPushResponse::Ack(message) => {
                let wire = serde_json::to_value(&*message).unwrap();
                assert_eq!(wire["type"], "tabs.sync.ack");
                assert_eq!(wire["accepted"], true);
                assert!(
                    wire.get("persisted").is_none(),
                    "persisted must be omitted on the wire when the write succeeded: {wire}"
                );
                assert!(wire.get("persistReason").is_none(), "{wire}");
            }
            TabsPushResponse::Error(error) => panic!("must be accepted: {error}"),
        }
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-ws oversize_push_acks -- --nocapture && cargo test -p freshell-ws normal_push_ack_omits -- --nocapture`
Expected: FAIL to COMPILE — `TabsSyncAck` has no `persisted` field. That is the RED state.

- [ ] **Step 3: Implement the plumbing (three hops)**

(a) `crates/freshell-protocol/src/server_messages.rs` (~lines 805-811) — extend the struct:

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabsSyncAck {
    pub accepted: bool,
    pub closed_records: i64,
    pub open_records: i64,
    /// `false` when the accepted push was NOT durably persisted (fail-loud
    /// honesty, campaign P2.17). Omitted when persisted normally or when
    /// persistence was skipped by design (empty push, persistence disabled),
    /// keeping pre-change acks byte-identical on the wire.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persisted: Option<bool>,
    /// Machine-readable reason accompanying `persisted:false`
    /// (e.g. "oversize"). Serializes as `persistReason`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persist_reason: Option<String>,
}
```

(serde treats a missing `Option` field as `None` on deserialize — no `#[serde(default)]` needed.)

(b) `crates/freshell-ws/src/tabs.rs` — extend `PushAck` (~lines 79-84):

```rust
/// The result of a `tabs.sync.push` (`tabs.sync.ack` payload).
pub struct PushAck {
    pub accepted: bool,
    pub open_records: i64,
    pub closed_records: i64,
    /// `Some(false)` when a persistence attempt did not durably write
    /// (oversize, invalid ids, io failure, cap unenforceable). `None` when
    /// persisted normally or when persistence was not attempted by design
    /// (empty push, persistence disabled — kata h9vt owns those semantics).
    pub persisted: Option<bool>,
    /// Machine-readable reason accompanying `persisted: Some(false)`.
    pub persist_reason: Option<String>,
}
```

and replace the `let _ = ...persist_generation(...)` block from Task 2 (~lines 233-251) with:

```rust
        drop(state); // release the registry mutex before filesystem I/O
        let mut persisted = None;
        let mut persist_reason = None;
        if let Some((dir, records)) = persist_input {
            match crate::tabs_persist::persist_generation(
                &dir,
                server_instance_id,
                device_id,
                device_label,
                client_instance_id,
                snapshot_revision,
                &records,
                now,
            ) {
                crate::tabs_persist::PersistOutcome::Persisted => {}
                crate::tabs_persist::PersistOutcome::Skipped { reason } => {
                    persisted = Some(false);
                    persist_reason = Some(reason.to_string());
                }
                crate::tabs_persist::PersistOutcome::Failed { reason } => {
                    persisted = Some(false);
                    persist_reason = Some(reason);
                }
            }
        }

        Ok(PushAck {
            accepted: true,
            open_records: open_count,
            closed_records: closed_count,
            persisted,
            persist_reason,
        })
```

Then run `grep -n "PushAck {" crates/freshell-ws/src/` and set `persisted: None, persist_reason: None` at any OTHER construction site the grep reveals (registry tests construct expectations in some suites).

(c) `crates/freshell-ws/src/terminal.rs` `tabs_push_response` (~lines 2158-2164) — map through:

```rust
        Ok(ack) => TabsPushResponse::Ack(Box::new(ServerMessage::TabsSyncAck(
            freshell_protocol::TabsSyncAck {
                accepted: ack.accepted,
                open_records: ack.open_records,
                closed_records: ack.closed_records,
                persisted: ack.persisted,
                persist_reason: ack.persist_reason,
            },
        ))),
```

Also fix any other `TabsSyncAck { ... }` literal the compiler reports (add the two fields as `None`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-ws && cargo test -p freshell-protocol`
Expected: PASS — both new tests plus all incumbent ack tests (`custom_extension_mode_push_is_accepted_and_persisted` etc.).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/src/tabs.rs crates/freshell-ws/src/terminal.rs \
        crates/freshell-protocol/src/server_messages.rs
git commit -m "feat(ws): surface persistence outcome on tabs.sync.ack (persisted/persistReason)

Defect 2 (wire half, campaign P2.17): the push ack said accepted:true even
when the generation was silently dropped. The ack now carries
persisted:false + reason on any failed/skipped persistence attempt;
fields are omitted on success so pre-change acks stay byte-identical.
accepted semantics unchanged. Verified: the frozen SPA has no
tabs.sync.ack handler and no runtime validation of server messages."
```

---

### Task 5: Contract honesty — shared TS type, regenerated schema, roundtrip proof

**Files:**
- Modify: `shared/ws-protocol.ts` (~lines 819-824, `TabsSyncAckMessage`)
- Modify: `crates/freshell-protocol/tests/roundtrip.rs`
- Regenerate: `port/contract/ws-server-messages.schema.json` (via `npm run contract:generate` — never hand-edit)

**Interfaces:**
- Consumes: `TabsSyncAck` with optional fields (Task 4).
- Produces: `TabsSyncAckMessage` with `persisted?: boolean` and `persistReason?: string`; regenerated frozen schema whose `tabs.sync.ack` entry lists both optional properties (still `additionalProperties: false`, neither in `required`); a Rust roundtrip test pinning conformance.

- [ ] **Step 1: Write the failing roundtrip test**

In `crates/freshell-protocol/tests/roundtrip.rs`, add the test below in the file's wire-string helper style. The helper's actual contract (verified at ~line 63) is `fn server_roundtrip(wire: &str, type_name: &str) -> ServerMessage`: it deserializes the wire JSON string, asserts the re-serialization is structurally identical to the input, then validates it against `outbound_schema()["messages"][type_name]` — so `type_name` must be the exact wire discriminant string `"tabs.sync.ack"`. (This test compiles only after Task 4 added the two optional fields to the Rust `TabsSyncAck` struct — Task 4 is a hard prerequisite.)

```rust
#[test]
fn tabs_sync_ack_roundtrips_with_and_without_persist_fields() {
    // Success shape: fields omitted — byte-identical to today's ack on the wire.
    let base = r#"{"type":"tabs.sync.ack","accepted":true,"closedRecords":0,"openRecords":3}"#;
    match server_roundtrip(base, "tabs.sync.ack") {
        ServerMessage::TabsSyncAck(ack) => {
            assert_eq!(ack.persisted, None);
            assert_eq!(ack.persist_reason, None);
        }
        other => panic!("expected TabsSyncAck, got {other:?}"),
    }
    // The honest-failure shape must conform to the frozen contract too.
    let failed = r#"{"type":"tabs.sync.ack","accepted":true,"closedRecords":0,"openRecords":3,"persisted":false,"persistReason":"oversize"}"#;
    match server_roundtrip(failed, "tabs.sync.ack") {
        ServerMessage::TabsSyncAck(ack) => {
            assert_eq!(ack.persisted, Some(false));
            assert_eq!(ack.persist_reason.as_deref(), Some("oversize"));
        }
        other => panic!("expected TabsSyncAck, got {other:?}"),
    }
}
```

(Match the file's existing tests for the `match`/panic idiom; the two round-trip assertions inside the helper pass because `skip_serializing_if` omits `None` fields in the first frame and emits both `Some` fields in the second.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p freshell-protocol tabs_sync_ack_roundtrips -- --nocapture`
Expected: FAIL — the second `server_roundtrip` call fails the helper's schema-conformance assertion, because the committed frozen schema's `tabs.sync.ack` entry has `"additionalProperties": false` and does not yet know `persisted`/`persistReason`. (The first call, with the fields omitted, succeeds before that panic — deserialization and round-trip equality pass for both frames; only the second frame's schema check can fire.) If the test PASSES outright, the schema was not being enforced — stop and investigate before proceeding.

- [ ] **Step 3: Extend the shared TS type and regenerate the contract**

In `shared/ws-protocol.ts` (~lines 819-824):

```typescript
export type TabsSyncAckMessage = {
  type: 'tabs.sync.ack'
  accepted: boolean
  openRecords: number
  closedRecords: number
  /** false when the accepted push was NOT durably persisted (fail-loud honesty). Omitted on success. */
  persisted?: boolean
  /** machine-readable reason accompanying persisted:false (e.g. "oversize") */
  persistReason?: string
}
```

Then regenerate (this is the ONLY way the schema file changes):

```bash
npm run contract:generate
git diff --stat port/contract/
```
Expected: `port/contract/ws-server-messages.schema.json` changed; the `tabs.sync.ack` entry now includes `persisted` and `persistReason` under `properties` and NOT under `required`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cargo test -p freshell-protocol
npm run test:status
```
Then run the contract freeze test (VERIFIED, ledger A9: `npm run test:vitest` is a coordinator PASSTHROUGH — it never takes the gate, so no WAIT is needed for this targeted run; only broad `npm test` acquires the gate):
```bash
FRESHELL_TEST_SUMMARY="lane A6: tabs.sync.ack optional persisted/persistReason contract regen" \
  npm run test:vitest -- test/unit/port/ws-contract-freeze.test.ts
```
Expected: cargo roundtrip PASS (both shapes); freeze test PASS (committed schema matches regeneration byte-for-byte).

- [ ] **Step 5: Commit**

```bash
git add shared/ws-protocol.ts port/contract/ crates/freshell-protocol/tests/roundtrip.rs
git commit -m "feat(protocol): add optional persisted/persistReason to tabs.sync.ack contract

Additive, optional, server->client-only contract change directed by
campaign P2.17 defect 2 (honest oversize-drop signal). Client tolerance
verified: the SPA has no tabs.sync.ack handler and performs no runtime
validation of server messages (shared/ws-protocol.ts design contract).
Schema regenerated via npm run contract:generate; a new roundtrip test
pins conformance of both ack shapes."
```

---

### Task 6: Deterministic device-id discovery — verify-all-agree (defect 3)

**Files:**
- Modify: `crates/freshell-ws/src/tabs_persist.rs` (`list_snapshot_devices_locked`, ~lines 300-330)
- Test: `crates/freshell-ws/src/tabs_persist_tests.rs`

**Interfaces:**
- Consumes: existing `read_generation_file` (fail-loud reader), test helpers.
- Produces: same `pub fn list_snapshot_devices(dir: &Path) -> std::io::Result<Vec<String>>` signature and same error-on-corrupt-file semantics (the incumbent test `corrupt_generation_file_reads_as_error_not_absence` must stay green); NEW: conflicting `deviceId`s within one dir → `Err(InvalidData)` whose message contains `tabs_snapshot_device_identity_conflict`, plus the invariant alarm of the same name. Design choice (from the spec's two options): verify-all-agree with loud error — it is stricter than newest-wins and matches the store's existing fail-loud read policy; the read cost (≤40 files × ≤64 dirs on an infrequent REST listing path) is acceptable.

- [ ] **Step 1: Write the failing tests**

Append to `crates/freshell-ws/src/tabs_persist_tests.rs`:

```rust
#[test]
fn mixed_device_id_dir_is_a_loud_error_not_first_file_wins() {
    // Defect 3: identity used to come from whatever *.json read_dir returned
    // first — nondeterministic for a half-migrated/hand-edited dir. Now every
    // generation must agree, or the read fails loudly.
    let (events, _guard) = crate::invariants::capture::capture();
    let dir = tempfile::tempdir().unwrap();
    put(dir.path(), "dev", "c1", 1, 1000, vec![open_record("dev:t", "t", 1)]);
    // Hand-craft a second, fully VALID generation in the same dir whose
    // embedded deviceId disagrees.
    let ddir = device_dir_for(dir.path(), "dev").unwrap();
    let existing = std::fs::read_dir(&ddir)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .find(|p| p.extension().is_some_and(|x| x == "json"))
        .unwrap();
    let mut doc: Value =
        serde_json::from_str(&std::fs::read_to_string(&existing).unwrap()).unwrap();
    doc["deviceId"] = json!("dev-other");
    std::fs::write(
        ddir.join("zzz-imposter.json"),
        serde_json::to_vec_pretty(&doc).unwrap(),
    )
    .unwrap();

    let err = list_snapshot_devices(dir.path())
        .expect_err("conflicting deviceIds in one dir must be an error");
    assert!(
        err.to_string().contains("tabs_snapshot_device_identity_conflict"),
        "{err}"
    );
    let events = events.lock().unwrap();
    assert!(
        events.iter().any(|e| e.target == "freshell_ws::invariants"
            && e.message.contains("tabs_snapshot_device_identity_conflict")),
        "identity conflict must alarm loudly: {events:?}"
    );
}

#[test]
fn agreeing_multi_generation_dir_lists_exactly_one_device_id() {
    // Regression guard for the fix: reading ALL files (not just the first)
    // must still dedupe agreeing generations to one id.
    let dir = tempfile::tempdir().unwrap();
    put(dir.path(), "dev", "c1", 1, 1000, vec![open_record("dev:t", "a", 1)]);
    put(dir.path(), "dev", "c2", 1, 2000, vec![open_record("dev:t2", "b", 1)]);
    assert_eq!(devices(dir.path()), vec!["dev".to_string()]);
}
```

- [ ] **Step 2: Run tests to verify the RED one fails**

Run: `cargo test -p freshell-ws mixed_device_id_dir -- --nocapture`
Expected: FAIL on `expect_err` — today the call returns `Ok` with whichever file's id `read_dir` yielded first. (`agreeing_multi_generation_dir_lists_exactly_one_device_id` may already pass — keep it as a pinning test.)

- [ ] **Step 3: Rewrite `list_snapshot_devices_locked`**

In `crates/freshell-ws/src/tabs_persist.rs`, replace the body of `list_snapshot_devices_locked` (keep the `pub fn list_snapshot_devices` wrapper and its doc comment; update the doc's "first readable *.json" claim to the new contract):

```rust
/// The RAW device ids that have at least one persisted generation. Every
/// generation in a device dir must agree on `deviceId` (verify-all-agree):
/// a half-migrated or hand-edited dir is an ERROR, never a nondeterministic
/// first-file-wins identity. Sorted + deduped. FAIL-LOUD: a missing root is
/// absence (`Ok(empty)`); an unreadable dir, a corrupt device file, or an
/// identity conflict is an ERROR (`Err`).
pub fn list_snapshot_devices(dir: &Path) -> std::io::Result<Vec<String>> {
    with_persist_lock(|| list_snapshot_devices_locked(dir))
}
fn list_snapshot_devices_locked(dir: &Path) -> std::io::Result<Vec<String>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };
    let mut ids: Vec<String> = Vec::new();
    for entry in entries {
        let dpath = entry?.path();
        if !dpath.is_dir() {
            continue;
        }
        let mut dir_id: Option<String> = None;
        for p in std::fs::read_dir(&dpath)?.flatten().map(|f| f.path()) {
            if !p.extension().is_some_and(|x| x == "json") {
                continue;
            }
            let v = read_generation_file(&p)?;
            let id = v
                .get("deviceId")
                .and_then(Value::as_str)
                .expect("validated deviceId")
                .to_string();
            match &dir_id {
                None => dir_id = Some(id),
                Some(existing) if *existing == id => {}
                Some(existing) => {
                    tracing::error!(target: "freshell_ws::invariants",
                        dir = %dpath.display(), first = %existing, conflicting = %id,
                        "tabs_snapshot_device_identity_conflict: generations in one device dir disagree on deviceId; refusing to guess an identity");
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!(
                            "tabs_snapshot_device_identity_conflict: {} holds generations with conflicting deviceIds ({existing} vs {id})",
                            dpath.display()
                        ),
                    ));
                }
            }
        }
        if let Some(id) = dir_id {
            ids.push(id);
        }
    }
    ids.sort();
    ids.dedup();
    Ok(ids)
}
```

Blast radius note: the only production consumer is the REST snapshot surface in `crates/freshell-server/src/tabs_snapshots.rs`, which already handles `Err` (that fail-loud path is pinned by `corrupt_generation_file_reads_as_error_not_absence`). No changes there. (Cross-lane check, ledger A3: the sibling lane owning that file only extracts `pane_to_create_body`, never touches `list_snapshot_devices`, and its new tests use single-deviceId fixtures — compatible.)

Line-budget contingency (ledger A15): `tabs_persist.rs` must stay ≤1,000 lines after this rewrite (~+17 net). If it would exceed the limit, move `list_snapshot_devices_locked` into `tabs_persist_retention.rs` (same `use super::*` pattern) instead of trimming elsewhere.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p freshell-ws && cargo test -p freshell-server`
Expected: PASS — including the incumbent `corrupt_generation_file_reads_as_error_not_absence` (corrupt file still `Err` via `read_generation_file`) and the cross-crate `tabs_snapshots` suite.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/src/tabs_persist.rs crates/freshell-ws/src/tabs_persist_tests.rs
git commit -m "fix(ws): deterministic device-id discovery via verify-all-agree

Defect 3 (campaign P2.17): device identity came from whatever *.json
read_dir returned first — nondeterministic for half-migrated or
hand-edited dirs. Every generation in a dir must now agree on deviceId;
disagreement is a loud InvalidData error + invariant alarm, never a guess."
```

---

### Task 7: Coverage sweep — persist-lock poison recovery + empty-push ack shape

**Files:**
- Test: `crates/freshell-ws/src/tabs_persist_tests.rs` (poison test)
- Test: `crates/freshell-ws/src/terminal.rs` `mod tabs_push_validation_tests` (empty-push ack test)

**Interfaces:**
- Consumes: `with_persist_lock` (pub), the ack fields from Task 4.
- Produces: pinned behavior only — no production code changes in this task.

**Sweep audit results (recorded here so the reviewer can check the reasoning):**
- Orphan-`.tmp` reaper (`sweep_orphan_tmp`): ALREADY covered by three tests — `orphan_tmp_is_reaped_before_cap_math` (tests:840), `restore_marker_in_flight_temp_survives_the_sweep_while_stray_tmp_is_reaped` (tests:874), and `concurrent_pushes_same_and_different_devices_stay_consistent` (tests:781, asserts `tmp_count == 0` after 24 threads). No new test needed.
- `PERSIST_LOCK` poisoning: `with_persist_lock` is poison-tolerant by design (`.lock().unwrap_or_else(|p| p.into_inner())`) but has ZERO poison-path coverage. Cheap to add — added below.
- Empty-push skip (`tabs.rs:205-214`): disk semantics covered by `empty_snapshot_does_not_overwrite_last_good_generation` (tests:438); the ACK shape of an empty push was never asserted, and Task 4's fields make it newly meaningful. Added below. NO semantic change (kata h9vt owns that design question).

- [ ] **Step 1: Write the two tests**

(a) Append to `crates/freshell-ws/src/tabs_persist_tests.rs`:

```rust
#[test]
fn persist_lock_recovers_from_poison() {
    // `with_persist_lock` is documented poison-tolerant: a panic while
    // persisting must not wedge all future pushes/restores. NOTE: this
    // deliberately poisons the process-global PERSIST_LOCK; every later
    // acquisition goes through the same into_inner() recovery, which is
    // exactly the property under test.
    let _ = std::thread::spawn(|| {
        with_persist_lock(|| panic!("deliberately poison PERSIST_LOCK"))
    })
    .join();
    let value = with_persist_lock(|| 42);
    assert_eq!(value, 42, "a poisoned persist lock must still be acquirable");
    // And a real write still works end-to-end after poisoning.
    let dir = tempfile::tempdir().unwrap();
    let outcome = persist_generation(
        dir.path(),
        "srv-1",
        "dev",
        "Dev",
        "c1",
        1,
        &[open_record("dev:t", "t", 1)],
        1000,
    );
    assert_eq!(outcome, PersistOutcome::Persisted);
}
```

(b) Add to `mod tabs_push_validation_tests` in `crates/freshell-ws/src/terminal.rs`:

```rust
    #[tokio::test]
    async fn empty_push_ack_is_unchanged_and_omits_persist_fields() {
        // The empty-push skip is BY DESIGN (wipe/unload protection) and its
        // semantics belong to kata h9vt — pin that it is NOT reported as a
        // persistence failure and the ack shape is byte-identical to before.
        let snapshots = tempfile::tempdir().unwrap();
        let tabs = crate::tabs::TabsRegistry::with_persist_dir(snapshots.path().to_path_buf());
        let frame = serde_json::json!({
            "type": "tabs.sync.push",
            "deviceId": "dev-1",
            "deviceLabel": "Device 1",
            "clientInstanceId": "client-1",
            "snapshotRevision": 1,
            "records": []
        });
        match tabs_push_response(&frame, tabs, "srv-test".to_string()).await {
            TabsPushResponse::Ack(message) => {
                let wire = serde_json::to_value(&*message).unwrap();
                assert_eq!(wire["type"], "tabs.sync.ack");
                assert_eq!(wire["accepted"], true);
                assert_eq!(wire["openRecords"], 0);
                assert!(
                    wire.get("persisted").is_none(),
                    "by-design empty-push skip must not read as a persistence failure: {wire}"
                );
                assert!(wire.get("persistReason").is_none(), "{wire}");
            }
            TabsPushResponse::Error(error) => panic!("empty push must be accepted: {error}"),
        }
        assert!(
            crate::tabs_persist::list_snapshot_devices(snapshots.path())
                .unwrap()
                .is_empty(),
            "empty push must not create a persisted generation"
        );
    }
```

(If push validation turns out to reject `"records": []` at the wire layer, that would contradict the registry-level behavior pinned at `tabs_persist_tests.rs:438` — investigate before changing anything, and fall back to asserting `PushAck { persisted: None, .. }` via a direct `replace_client_snapshot(..., vec![])` call in `tabs.rs`'s test module instead. Do NOT change wire validation.)

- [ ] **Step 2: Run the tests**

Run: `cargo test -p freshell-ws persist_lock_recovers -- --nocapture && cargo test -p freshell-ws empty_push_ack -- --nocapture`
Expected: PASS on first run — these pin EXISTING behavior (poison tolerance and the ack shape Task 4 defined). If either fails, the production code has a real bug: stop and fix it within this task's scope before committing.

Then the full crate: `cargo test -p freshell-ws`
Expected: PASS (the poison test coexists with the concurrency test because every acquisition path is poison-tolerant).

- [ ] **Step 3: Commit**

```bash
git add crates/freshell-ws/src/tabs_persist_tests.rs crates/freshell-ws/src/terminal.rs
git commit -m "test(ws): pin persist-lock poison recovery and empty-push ack shape

Sweep from campaign P2.17: the orphan-.tmp reaper already has three
tests; PERSIST_LOCK poison tolerance and the empty-push ack shape had
none. No semantic changes (empty-push design belongs to kata h9vt)."
```

---

### Task 8: Final verification, quality gates, push (NO PR)

**Files:** none (verification only)

**Interfaces:**
- Consumes: everything above.
- Produces: pushed branch `fix/tabs-snapshot-defects` + proof transcript for the report.

- [ ] **Step 1: Full Rust verification**

```bash
cd /home/dan/code/freshell/.worktrees/tabs-snapshot-defects
cargo test -p freshell-ws
cargo test -p freshell-protocol
cargo test -p freshell-server
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
```
Expected: all PASS / clean. (Toolchain is pinned to 1.96.0; clippy mirrors the `rust-clippy.yml` CI gate.)

- [ ] **Step 2: Coordinated JS suite (contract freeze + legacy tabs tests)**

```bash
npm run test:status
```
If another agent holds the gate, WAIT (poll `npm run test:status`; 5 sibling lanes run concurrently — never kill a foreign holder). Then:
```bash
FRESHELL_TEST_SUMMARY="lane A6 tabs-snapshot defect fixes: full suite (contract regen touched port/contract)" npm test
```
Expected: PASS — in particular `test/unit/port/ws-contract-freeze.test.ts` (schema regenerated in Task 5) and `test/server/ws-tabs-registry.test.ts` (its ack assertions use subset-matching `toMatchObject`, unaffected by the new optional fields).

- [ ] **Step 3: Pre-push drift check (REQUIRED — sibling lanes touch shared files)**

Sibling lanes verifiably edit `terminal.rs`, `server_messages.rs`, `invariants.rs`, and `tabs_persist_tests.rs`, and one adds a `ServerMessage` variant WITHOUT regenerating the frozen contract (ledger A2, falsified). Before pushing:

```bash
git fetch origin
git log --name-only c491aee0..origin/main -- crates/freshell-ws/src crates/freshell-protocol shared/ws-protocol.ts port/contract
```
- If EMPTY intersection with this lane's files: proceed to Step 4.
- If anything owned/shared moved on main: `git rebase origin/main`, resolve conflicts (expect trivial append conflicts in `tabs_persist_tests.rs`; distinct regions in `terminal.rs`), re-run `npm run contract:generate` (the regenerated schema must include BOTH lanes' changes — the byte-for-byte freeze test enforces this), then re-run Step 1 and Step 2 in full before pushing.

- [ ] **Step 4: Push the branch and STOP**

```bash
git log --oneline origin/main..HEAD   # expect the 7 commits from Tasks 1-7 (+ the plan commits)
git push -u origin fix/tabs-snapshot-defects
```
PR POLICY: NOT approved. Do NOT run `gh pr create`. Report: the branch name, the commit list, and the Step 1–2 proof (test/clippy/fmt output summaries), plus these verified follow-up notes: (1) client follow-up — the SPA has no `tabs.sync.ack` handler; surfacing `persisted:false` in the UI is future client work; (2) deployment latency (ledger A6) — the live self-hosted server is the Rust binary `~/.local/bin/freshell-prod` (verified via process/strings inspection), a pre-fix build, so these fixes stay latent until it is rebuilt/redeployed (do NOT restart it yourself); (3) the authorizing lane spec lives in the wave session log, not the repo — quote its defect-2 remedy language in the eventual PR description.

---

## Self-Review Record

- **Spec coverage:** Defect 1 → Tasks 1+3 (exempt corrupt dirs, loud logs, clean-only eviction, fail-the-write when unenforceable). Defect 2 → Tasks 2+4+5 (honest outcome, ERROR-not-WARN, invariant alarm per the crate's `terminal_identity_unresolved`-class convention, wire-compat-verified ack field, contract regen, cap-policy decision recorded). Defect 3 → Task 6 (verify-all-agree with loud error — one of the spec's two sanctioned options). Sweep (reaper/PERSIST_LOCK/empty-push) → Task 7 with audit rationale. Red-first per defect: Tasks 2, 3, 4, 5, 6 each observe RED before GREEN. E2E: spec explicitly accepts unit/integration coverage here; all tests use real tempdir filesystems and the real push handler path (`tabs_push_response`), no mocks or fakes anywhere in this plan.
- **No silent deferrals:** the only deferred items are ones the spec itself defers — the kata h9vt empty-push/use-it-or-remove-it decision (explicitly out of scope) and client UI consumption of `persisted:false` (spec: "note it as follow-up — do not edit"), recorded in Task 8's report step. No UNRESOLVED COVERAGE GAPs.
- **Load-bearing validation addendum (Stage 2):** 15 assumptions surfaced; 10 verified, 2 falsified, 3 deferred-with-fallbacks (ledger: `.worktrees/.the-usual-logs/tabs-snapshot-defects/load-bearing-ledger.md`). Falsified + fixed here: (A1) the invariants capture module is nested inside `#[cfg(test)] mod tests` — Task 2 Step 1 rewritten from "visibility tweak" to a mechanical hoist; (A2) sibling lanes DO edit `terminal.rs`/`server_messages.rs`/`invariants.rs`/`tabs_persist_tests.rs` and one adds an unregenerated ServerMessage variant — coordination constraint added and Task 8 gained a mandatory pre-push drift check (rebase + contract re-regen + re-verify). Verified findings folded in: targeted `test:vitest` is coordinator-passthrough (Task 5 Step 4 wording), worktree npm needs no install (Global Constraints note), oracle corpora carry no `tabs.sync` traffic so the ack change cannot break equivalence suites, spec sanction confirmed verbatim for the contract change / cap outage mode / verify-all-agree / E2E exemption, live server confirmed Rust (report note). Re-review of edited tasks (incl. item 1b): no new coverage gaps, no silent deferrals introduced; interfaces and step numbering stay consistent (Task 8 steps renumbered 1-4; drift-check step consumes only read-only git + existing regen command).
- **Type consistency check:** `PersistOutcome::{Persisted, Skipped{reason: &'static str}, Failed{reason: String}}` used identically in Tasks 2, 3, 4, 7; `PushAck.persisted: Option<bool>` / `persist_reason: Option<String>` (Task 4) map to `TabsSyncAck.persisted` / `persist_reason` (serde camelCase → `persisted`/`persistReason`) which match `TabsSyncAckMessage.persisted?`/`persistReason?` (Task 5); `enforce_device_cap(root, target_dir) -> io::Result<()>` signature unchanged across Tasks 1 and 3.
