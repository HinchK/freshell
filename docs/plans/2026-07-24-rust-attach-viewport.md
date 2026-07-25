# Rust Attach-Time Viewport Resize (TERM-07 geometry) Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Make the Rust WebSocket server apply the `cols`/`rows` carried in every `terminal.attach` message to the PTY before attach/replay, matching the Node broker's semantics, so PTYs no longer stay stuck at the 120x30 spawn default.

**Architecture:** Add one new registry method (`TerminalRegistry::resize_for_attach`) in `freshell-terminal` that atomically samples the *pre-attach* subscriber set, evaluates Node's `shouldResize` condition per attach intent, and applies the geometry. Port Node's **first-record-no-bump** epoch semantics (a `has_client_geometry` flag on `TerminalShared`, consulted by both `resize` and `resize_for_attach`): the first client-supplied geometry is recorded and applied **without** bumping `geometry_epoch`, exactly like Node's `recordTerminalGeometry` with `hasPreviousGeometry=false` (`broker.ts:666-686`) — the frozen client resets its epoch baseline to 1 on fresh mount (`TerminalView.tsx:631, 974`) and compares persisted checkpoint epochs (`terminal-surface-checkpoint.ts:123`), so an extra first bump would invalidate warm-delta replay on every remount. Wire the resize into `freshell-ws::handle_attach` *before* `registry.attach(...)`, guarded by the same session-identity check Node's `resizeIfSessionMatches` applies. Add a small `geometry()` accessor so tests can assert real registry state.

**Tech Stack:** Rust (cargo workspace: `freshell-terminal`, `freshell-ws`, `freshell-protocol`), tokio + tokio-tungstenite integration tests, portable-pty.

## Global Constraints

- **Rust side only.** Do NOT modify the client (`src/`), the Node server (`server/`), or `shared/ws-protocol.ts`. The React/TS frontend is frozen.
- **Wire shape is immutable** (WS_PROTOCOL_VERSION=7). The fix works entirely within the existing `terminal.attach { terminalId, intent, cols, rows, attachRequestId, expectedSessionRef, ... }` shape already parsed in `crates/freshell-protocol/src/client_messages.rs:234-251`. No protocol struct changes.
- **TDD is mandatory** (repo AGENTS.md): Red-Green-Refactor for every task; run the failing test before implementing.
- **Parity reference is the shipped Node code**, `server/terminal-stream/broker.ts:347-397` and `server/terminal-registry.ts` `resizeIfSessionMatches` — not the aspirational doc `docs/superpowers/plans/2026-03-04-option-c-attach-viewport.md` (that doc mandates an unconditional resize-before-replay; the shipped Node code is *conditional* on intent and resizes after `registry.attach` but before the ready frame. The doc is stale — verified against the worktree. Replicate the code).
- Work on branch `fix/rust-attach-viewport` in this worktree (`.worktrees/rust-attach-viewport`). Frequent, focused commits.
- **Never** restart the self-hosted Freshell server; **never** create a PR (requires explicit user approval); **never** use broad kill patterns.
- Rust checks are NOT gated by the JS coordinator (`npm test` gate is Vitest-only). Run `cargo test -p freshell-terminal`, `cargo test -p freshell-ws`, `cargo fmt --all --check`, and `cargo clippy -p freshell-terminal -p freshell-ws --all-targets -- -D warnings` locally.
- **Recorded baseline (validated 2026-07-24 on this worktree's HEAD, before any change) — every "expected: pass" gate in this plan means "no NEW failures vs this baseline":**
  - `cargo test -p freshell-terminal`: green (108+2+1 passed; WSL-live tests ignored by design).
  - `cargo fmt --all --check`: green.
  - `cargo test -p freshell-ws`: RED with exactly two pre-existing failures — (1) `codex_session_ref_resume` fails with `PTY_SPAWN_FAILED: Unable to resolve MCP dependency "tsx"` because this worktree lacks `node_modules/` (environmental; optionally run `npm ci` in the worktree root to restore it — that is the only sanctioned fix, do not chase it in Rust code); (2) `session_identity_frames::fresh_claude_create_frames_carry_preallocated_session_ref` times out deterministically (pre-existing on HEAD, reproduced 3/3, unrelated to this fix — do NOT attempt to fix it here). All other freshell-ws test targets are green.
  - `cargo clippy -p freshell-terminal -p freshell-ws --all-targets -- -D warnings`: RED with 6 pre-existing errors, all in `freshell-platform` (a path dependency this plan never touches; newer-clippy lints). Gate: zero clippy diagnostics in `freshell-terminal`/`freshell-ws` code; the 6 `freshell-platform` errors are baseline and out of scope.
- This change is a **parity fix** (Rust converging on Node behavior), not a deviation from the TS original — no `port/oracle/DEVIATIONS.md` entry is needed.

---

## Context: the bug and the reference semantics

**Bug:** `handle_attach` (`crates/freshell-ws/src/terminal.rs:1749-1777`) forwards only `terminal_id`, `attach_request_id`, `since_seq`, the batch capability, and the canonical `session_ref` to `TerminalRegistry::attach`. It **drops `cols`, `rows`, `intent`, and `expected_session_ref`**. The client sends geometry exactly once, in `terminal.attach`, and deliberately suppresses a follow-up `terminal.resize` for the same geometry — so the PTY stays at `DEFAULT_COLS`/`DEFAULT_ROWS` = 120x30 (`crates/freshell-platform/src/spawn.rs:102-103`) until some later layout change happens to differ.

**Node reference** (`server/terminal-stream/broker.ts:347-397`, verbatim condition):

```ts
const shouldResize = intent === 'viewport_hydrate'
  || (
    intent === 'transport_reconnect'
    && (!hasOtherAttachedSockets || Boolean(existingAttachment))
  )
```

- `hasOtherAttachedSockets` = any socket in the **pre-attach** client set other than this one.
- `existingAttachment` = this same socket already had an attachment record for this terminal.
- `keepalive_delta` never resizes.
- The resize goes through `registry.resizeIfSessionMatches(terminalId, cols, rows, expectedSessionRef)`: session-identity mismatch → no mutation; identical cols/rows → `unchanged` with no PTY syscall; else set cols/rows + `pty.resize()` (errors swallowed).
- Geometry is recorded **before** `terminal.attach.ready` is emitted, so the ready frame carries post-resize epoch/authority.

**Rust epoch/authority mapping (validated against the frozen client — one bookkeeping change IS needed):**
- **Epoch (first-record-no-bump; this was validated and the original "no changes needed" claim was wrong):** Node's `recordTerminalGeometry` (`broker.ts:666-686`) never bumps the epoch on the **first-ever** geometry record (`hasPreviousGeometry` starts false; spawn dims never count — broker geometry state is absent at creation, `broker.ts:692-697`; epoch starts at 1, `broker.ts:695`). The frozen client depends on this: a fresh mount/reload resets its epoch baseline to 1 (`TerminalView.tsx:631, 974`) and compares the *persisted* checkpoint epoch against it (`terminal-surface-checkpoint.ts:123`). If Rust bumped on the first attach-applied geometry, every remount/reload would see `geometry_changed` and force a full hydrate — a warm-delta-replay regression vs both Node and current Rust. Task 2 therefore adds `has_client_geometry: bool` to `TerminalShared`, consulted by **both** `resize` and `resize_for_attach`: the first client-supplied geometry is recorded/applied without a bump; later real changes bump. Recording rules replicate Node exactly (verified): a record happens for both applied and unchanged-dims outcomes whenever the resize is allowed (Node records on `'resized'` AND `'unchanged'` — attach path `broker.ts:387-392`, resize path `ws-handler.ts:2995`), but a skipped attach (`shouldResize=false`) never records (`broker.ts:373`). Two unreachable-in-practice divergences, accepted and documented: Node normalizes dims (`max(2, floor)`) but the frozen client pre-normalizes before sending (`TerminalView.tsx:2446-2447`), so Rust keeps its `handle_resize`-style clamp; and Node's `recordResize` no-ops for a `terminal.resize` arriving before any attach (no broker state yet, `broker.ts:656`) while unified Rust would record — the frozen client only resizes terminals it has attached.
- Rust already keeps `cols`/`rows`/`geometry_epoch` on `TerminalShared` (`registry.rs:211-214`); `resize` bumps the epoch only on a real change (`registry.rs:991`) — that is the established Rust epoch model (Node keeps its epoch in the broker instead, but the client-visible contract is the same: epoch changes only when geometry actually changes, and `attach.ready` reports the post-resize value).
- `geometry_authority` is *derived* in Rust (`subscribers.len() >= 2 → multi_client_unknown`, `registry.rs:240-246`) and is computed during `attach` — i.e. after our new pre-attach resize — which yields exactly the value Node records (`hasOtherAttachedSockets ? 'multi_client_unknown' : 'single_client'`). No stored-authority field is needed.
- Because our resize runs before `registry.attach` builds `TerminalAttachReady`, the ready frame automatically stamps the post-resize `geometry_epoch` — same ordering as Node.

**Lock-ordering constraint (why the resize is a separate call before `attach`, not inside it):** `resize` takes the registry lock then the per-terminal lock; `attach` drops the registry lock and then holds the per-terminal lock for its whole critical section, and never retains the `TerminalHandle` (so it has no `PtyTerminal`). Calling any resize from inside `attach` would deadlock. Running `resize_for_attach` *before* `attach` also means the subscriber map it samples is exactly Node's pre-attach client set — `attach` inserts the subscriber (overwriting any prior entry for the same `conn_id`, destroying the "existing attachment" evidence), so the sampling MUST happen before that insert.

**Known, accepted divergence (documented, not silent):** on session-identity mismatch Node *also* detaches and fails the whole attach with a `session_identity_mismatch` result. The spec for this fix requires only that a mismatched `expectedSessionRef` does not resize (matching `resizeIfSessionMatches`'s no-mutation guarantee); Rust's attach today has no failure channel at all (`AttachOutcome { found: bool }`, and even unknown-terminal attaches are silent no-ops). Changing attach failure semantics is a separate parity item outside this fix — here, a mismatch skips the resize and the attach proceeds as it does today.

**Additional known, accepted divergences (documented, not silent; all validated against the shipped code):**
- **Duplicate re-attach:** Node short-circuits a duplicate attach (same socket + same `activeAttachRequestId`, `broker.ts:343-346`) into a `'duplicate'` result *before* any resize consideration; Rust has no attach-request bookkeeping, so a duplicated attach message re-evaluates `resize_for_attach`. The observable outcome coincides: a duplicated attach carries the same geometry, so the registry returns `Unchanged` (no PTY syscall, no epoch change). Accepted rather than adding new stateful bookkeeping.
- **Codex identity timing (pre-existing identity-registry gaps, not guard defects):** Node's canonical identity for a codex terminal is gated on durability (`terminal-registry.ts:193-201`) while Rust seeds create-time resume ids ungated; and Rust has no fresh-codex late identity binding (`terminal.rs:1438-1447` defers it). The guard consumes whatever `session_ref_for` returns; shell-terminal behavior (what this fix's tests pin) is exact parity. Closing the codex gaps is a separate identity-registry item.
- **`'not_running'` result mapping:** Node's `resizeIfSessionMatches` can also return `'not_running'` (`terminal-registry.ts:4027`), which the broker collapses into a `'missing'` attach result (`broker.ts:382-386`). Rust models it as the distinct `AttachResizeStatus::NotRunning`, which `handle_attach` ignores just like every other status; no client-visible difference for this fix.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `crates/freshell-terminal/src/registry.rs` | Modify | Add `pub fn geometry(...)` accessor; add `has_client_geometry` flag to `TerminalShared` + first-record-no-bump in `resize` (update the existing epoch test); add `AttachResizeStatus` enum + `pub fn resize_for_attach(...)`; new unit tests in the existing `#[cfg(test)]` module |
| `crates/freshell-ws/src/terminal.rs` | Modify (`handle_attach`, ~line 1749) | Apply attach geometry via `resize_for_attach` before `registry.attach`, guarded by `attach_geometry_identity_ok`; unit tests for the guard |
| `crates/freshell-ws/tests/attach_viewport_resize.rs` | Create | Integration tests: real WS server + real PTY; asserts registry geometry AND kernel-level PTY size (`stty size`) |
| `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md` | Modify (~line 221) | Annotate TERM-07 progress (geometry/intent portion) |

No other files change. (`registry.rs` is already >3200 lines; adding two small methods follows the established single-registry-file pattern — do not restructure it.)

---

### Task 1: `TerminalRegistry::geometry()` accessor

**Files:**
- Modify: `crates/freshell-terminal/src/registry.rs` (impl block containing `pub fn resize`, ~line 978; tests in the existing `#[cfg(test)]` module at the bottom of the file, near `resize_updates_geometry_epoch_only_on_change` ~line 2549)

**Interfaces:**
- Consumes: existing private `TerminalShared { cols: u16, rows: u16, geometry_epoch: i64 }` and `TerminalRegistry.inner`.
- Produces: `pub fn geometry(&self, terminal_id: &str) -> Option<(u16, u16, i64)>` — `(cols, rows, geometry_epoch)`, `None` for unknown ids. Tasks 2, 3, and 4 use this in tests.

- [ ] **Step 1: Write the failing test**

Add to the existing `#[cfg(test)]` module in `registry.rs` (same module where `insert_headless` and `collector()` already live — copy the surrounding style of `resize_updates_geometry_epoch_only_on_change`):

```rust
    #[test]
    fn geometry_reports_cols_rows_epoch() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S"); // headless default: 120x30, epoch 1
        assert_eq!(reg.geometry("T"), Some((120, 30, 1)));

        assert_eq!(reg.geometry("nope"), None);
    }
```

(Epoch behavior under `resize` is deliberately NOT pinned here — Task 2 changes it to Node's first-record-no-bump semantics and pins it there.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p freshell-terminal geometry_reports_cols_rows_epoch`
Expected: compile error — `no method named 'geometry' found for struct 'TerminalRegistry'` (a compile failure IS the red state here).

- [ ] **Step 3: Write minimal implementation**

Add next to `pub fn resize` in `registry.rs`:

```rust
    /// Current geometry bookkeeping as `(cols, rows, geometry_epoch)`; `None`
    /// for an unknown terminal id. Test/diagnostic seam for the TERM-07
    /// attach-time resize (the values `attach.ready` stamps come from here).
    pub fn geometry(&self, terminal_id: &str) -> Option<(u16, u16, i64)> {
        let shared = {
            let inner = self.inner.lock().expect("registry lock");
            inner
                .terminals
                .get(terminal_id)
                .map(|h| Arc::clone(&h.shared))
        };
        shared.map(|shared| {
            let s = shared.lock().expect("terminal lock");
            (s.cols, s.rows, s.geometry_epoch)
        })
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p freshell-terminal geometry_reports_cols_rows_epoch`
Expected: `test ... geometry_reports_cols_rows_epoch ... ok`

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-terminal/src/registry.rs
git commit -m "feat(rust): add TerminalRegistry::geometry() accessor"
```

---

### Task 2: First-record-no-bump epoch semantics (`has_client_geometry`)

**Why (validated):** Node never bumps the geometry epoch on the first-ever geometry record (`recordTerminalGeometry`, `broker.ts:666-686`; broker geometry state is absent at creation, `broker.ts:692-697`), and the frozen client's remount baseline depends on it (`TerminalView.tsx:631, 974`; `terminal-surface-checkpoint.ts:123`). Rust must match BEFORE attach-time resizes start happening, or every remount forces a full hydrate. See the epoch mapping in the Context section.

**Files:**
- Modify: `crates/freshell-terminal/src/registry.rs` (`TerminalShared` struct ~line 211-214; `pub fn resize` ~line 981-997; existing test `resize_updates_geometry_epoch_only_on_change` ~line 2550; new tests in the existing `#[cfg(test)]` module)

**Interfaces:**
- Consumes: `geometry()` from Task 1.
- Produces: private field `TerminalShared.has_client_geometry: bool` (false at construction; set whenever a client-geometry event is recorded). `resize` (this task) and `resize_for_attach` (Task 3) consult it: the first record applies dims without an epoch bump; later real changes bump.

- [ ] **Step 1: Write the failing tests**

Add to the existing `#[cfg(test)]` module in `registry.rs`:

```rust
    #[test]
    fn first_client_geometry_records_without_epoch_bump() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S"); // 120x30, epoch 1, no client geometry yet
        // First client-supplied geometry: applied + recorded, NO epoch bump
        // (Node recordTerminalGeometry: hasPreviousGeometry=false => no bump,
        // broker.ts:666-686; spawn dims never count, broker.ts:692-697).
        reg.resize("T", 100, 40);
        assert_eq!(reg.geometry("T"), Some((100, 40, 1)));
        // Second real change: bumps.
        reg.resize("T", 90, 35);
        assert_eq!(reg.geometry("T"), Some((90, 35, 2)));
    }

    #[test]
    fn unchanged_first_geometry_still_counts_as_recorded() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        // Node records geometry on 'unchanged' results too (ws-handler.ts:2995
        // records for both 'resized' and 'unchanged'), so the NEXT change bumps.
        reg.resize("T", 120, 30); // dims equal the spawn default: records, no change
        assert_eq!(reg.geometry("T"), Some((120, 30, 1)));
        reg.resize("T", 95, 41);
        assert_eq!(reg.geometry("T"), Some((95, 41, 2)));
    }
```

And UPDATE the existing test `resize_updates_geometry_epoch_only_on_change` (~line 2550) to the new contract — replace its body with:

```rust
    #[test]
    fn resize_updates_geometry_epoch_only_on_change() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        assert_eq!(reg.geometry("T"), Some((120, 30, 1)));
        reg.resize("T", 100, 40); // first record: applied, no bump
        assert_eq!(reg.geometry("T"), Some((100, 40, 1)));
        reg.resize("T", 100, 40); // identical dims: no bump
        assert_eq!(reg.geometry("T"), Some((100, 40, 1)));
        reg.resize("T", 90, 35); // subsequent real change: bump
        assert_eq!(reg.geometry("T"), Some((90, 35, 2)));
    }
```

(If the existing body asserts via internals rather than `geometry()`, still replace it with the above — `geometry()` exists from Task 1.)

- [ ] **Step 2: Run tests to verify the red drivers fail (and the pin passes)**

Run all three:
- `cargo test -p freshell-terminal first_client_geometry`
- `cargo test -p freshell-terminal resize_updates`
- `cargo test -p freshell-terminal unchanged_first_geometry`

Expected:
- `first_client_geometry_records_without_epoch_bump` FAILS with an assertion error (actual epoch 2 where 1 is expected) — today's `resize` bumps on the first change. RED DRIVER.
- `resize_updates_geometry_epoch_only_on_change` (updated body) FAILS the same way (epoch 2 where 1 is expected after the first record). RED DRIVER.
- `unchanged_first_geometry_still_counts_as_recorded` PASSES even before the implementation: `resize("T",120,30)` hits the current unchanged-dims early return (epoch stays 1) and `resize("T",95,41)` bumps 1→2. It is NOT a red driver — it is a regression pin that would fail under a wrong implementation of this task (one that skips setting `has_client_geometry` on the unchanged-dims path, so the next change would not bump). Do not expect it to fail; do not skip it.

This is the red state for the two drivers (no compile error: these tests only use APIs that already exist after Task 1).

- [ ] **Step 3: Write minimal implementation**

1. Add the field to `TerminalShared` (next to `cols`/`rows`/`geometry_epoch`, ~line 211-214):

```rust
    /// TERM-07 parity with Node's `hasPreviousGeometry` (`broker.ts:666-686`):
    /// false until the first client-supplied geometry is recorded. The first
    /// record applies dims WITHOUT bumping `geometry_epoch` (spawn defaults
    /// never count as a prior record); later real changes bump.
    has_client_geometry: bool,
```

2. Initialize `has_client_geometry: false` at every `TerminalShared { ... }` construction site — the compiler will list them (the spawn/create path and the `register_headless` path).

3. In `pub fn resize` (~line 981-997): after acquiring the terminal-shared lock and BEFORE the unchanged-dims early return (~line 986-988), insert:

```rust
        let first_record = !s.has_client_geometry;
        s.has_client_geometry = true;
```

and change the bump line (~line 991) from `s.geometry_epoch += 1;` to:

```rust
        if !first_record {
            s.geometry_epoch += 1;
        }
```

Everything else in `resize` (dims set, PTY resize performed after the terminal lock is released) stays as-is.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-terminal`
Expected: no new failures vs the recorded baseline, including the two new tests and the updated `resize_updates_geometry_epoch_only_on_change`. If any OTHER pre-existing test pinned an epoch value that this change renumbers, update that test's expectation to the new contract (first record = no bump) — do not weaken its other assertions.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-terminal/src/registry.rs
git commit -m "fix(rust): port Node first-record-no-bump geometry epoch semantics (TERM-07)"
```

---

### Task 3: `TerminalRegistry::resize_for_attach()` — intent-conditional pre-attach resize

**Files:**
- Modify: `crates/freshell-terminal/src/registry.rs` (new enum near `AttachOutcome` ~line 456; new method next to `pub fn resize` ~line 978; unit tests in the existing `#[cfg(test)]` module)

**Interfaces:**
- Consumes: `TerminalAttachIntent` from `freshell-protocol` (the crate already depends on it — `crates/freshell-terminal/Cargo.toml:13` has `freshell-protocol = { path = "../freshell-protocol" }`; if `use freshell_protocol::TerminalAttachIntent;` doesn't resolve, use the same import path prefix the file already uses for `SessionLocator`). Also `TerminalRunStatus` (already imported — `attach` compares `s.status == TerminalRunStatus::Exited`), private `TerminalShared.subscribers`, Task 2's `TerminalShared.has_client_geometry`, `TerminalHandle.pty`, `PtyTerminal::resize`, and Task 1's `geometry()` plus the existing `pub fn finish_pty_exit` seam (registry.rs:1112) in tests.
- Produces (Task 4 calls this):

```rust
pub enum AttachResizeStatus { Resized, Unchanged, Skipped, NotRunning, Missing }

pub fn resize_for_attach(
    &self,
    terminal_id: &str,
    conn_id: u64,
    intent: TerminalAttachIntent,
    cols: u16,
    rows: u16,
) -> AttachResizeStatus
```

- [ ] **Step 1: Write the failing tests**

Add to the existing `#[cfg(test)]` module in `registry.rs`. `TerminalAttachIntent` needs importing inside the test module too (match the module's existing import style):

```rust
    #[test]
    fn resize_for_attach_viewport_hydrate_applies_first_geometry_without_bump() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S"); // 120x30, epoch 1
        let out = reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 95, 41);
        assert_eq!(out, AttachResizeStatus::Resized);
        // First-ever client geometry: applied, epoch NOT bumped (Node
        // first-record-no-bump, broker.ts:666-686).
        assert_eq!(reg.geometry("T"), Some((95, 41, 1)));
    }

    #[test]
    fn resize_for_attach_second_change_bumps_epoch() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 95, 41);
        let out = reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 100, 50);
        assert_eq!(out, AttachResizeStatus::Resized);
        assert_eq!(reg.geometry("T"), Some((100, 50, 2)));
    }

    #[test]
    fn resize_for_attach_unchanged_geometry_records_but_does_not_bump() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let out = reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 120, 30);
        assert_eq!(out, AttachResizeStatus::Unchanged);
        assert_eq!(reg.geometry("T"), Some((120, 30, 1)));
        // Node records geometry on 'unchanged' results too (broker.ts:387-392),
        // so the next real change must bump.
        let out = reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 95, 41);
        assert_eq!(out, AttachResizeStatus::Resized);
        assert_eq!(reg.geometry("T"), Some((95, 41, 2)));
    }

    #[test]
    fn resize_for_attach_keepalive_delta_never_resizes_or_records() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let out = reg.resize_for_attach("T", 1, TerminalAttachIntent::KeepaliveDelta, 95, 41);
        assert_eq!(out, AttachResizeStatus::Skipped);
        assert_eq!(reg.geometry("T"), Some((120, 30, 1)));
        // A skipped attach must NOT count as a geometry record (Node's forced
        // 'unchanged' at broker.ts:373 never records): the next applied
        // geometry is still the FIRST record, so no bump.
        let out = reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 95, 41);
        assert_eq!(out, AttachResizeStatus::Resized);
        assert_eq!(reg.geometry("T"), Some((95, 41, 1)));
    }

    #[test]
    fn resize_for_attach_transport_reconnect_applies_when_alone() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        // No subscribers at all -> no other attached sockets -> resize.
        let out = reg.resize_for_attach("T", 1, TerminalAttachIntent::TransportReconnect, 95, 41);
        assert_eq!(out, AttachResizeStatus::Resized);
        assert_eq!(reg.geometry("T"), Some((95, 41, 1)));
    }

    #[test]
    fn resize_for_attach_transport_reconnect_skips_when_other_socket_attached() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let (sink, _seen) = collector();
        reg.attach("T", 1, sink, Some("a".into()), 0, false, None); // conn 1 is attached
        // conn 2 reconnects with another socket attached and no prior attachment of its own.
        let out = reg.resize_for_attach("T", 2, TerminalAttachIntent::TransportReconnect, 95, 41);
        assert_eq!(out, AttachResizeStatus::Skipped);
        assert_eq!(reg.geometry("T"), Some((120, 30, 1)));
    }

    #[test]
    fn resize_for_attach_transport_reconnect_applies_when_same_conn_reattaches() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let (sink1, _seen1) = collector();
        let (sink2, _seen2) = collector();
        reg.attach("T", 1, sink1, Some("a".into()), 0, false, None);
        reg.attach("T", 2, sink2, Some("b".into()), 0, false, None);
        // conn 2 already has an attachment -> resize even though conn 1 is also attached
        // (Node: existingAttachment wins over hasOtherAttachedSockets).
        let out = reg.resize_for_attach("T", 2, TerminalAttachIntent::TransportReconnect, 95, 41);
        assert_eq!(out, AttachResizeStatus::Resized);
        // First-ever geometry record: no epoch bump.
        assert_eq!(reg.geometry("T"), Some((95, 41, 1)));
    }

    #[test]
    fn resize_for_attach_missing_terminal() {
        let reg = TerminalRegistry::new();
        let out = reg.resize_for_attach("nope", 1, TerminalAttachIntent::ViewportHydrate, 95, 41);
        assert_eq!(out, AttachResizeStatus::Missing);
    }

    #[test]
    fn resize_for_attach_exited_terminal_not_running() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        // finish_pty_exit flips a headless terminal to Exited while RETAINING
        // the record (registry.rs:1112) -- the same seam the existing test
        // attach_to_already_exited_terminal_delivers_synthetic_exit uses.
        assert!(reg.finish_pty_exit("T", 7));
        let out = reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 95, 41);
        assert_eq!(out, AttachResizeStatus::NotRunning);
        assert_eq!(reg.geometry("T"), Some((120, 30, 1)));
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-terminal resize_for_attach`
Expected: compile error — `AttachResizeStatus` / `resize_for_attach` not found (red state).

- [ ] **Step 3: Write minimal implementation**

Add the enum near `AttachOutcome` (~line 456):

```rust
/// Outcome of the attach-time geometry application (TERM-07;
/// `broker.ts:358-397` `shouldResize` + `resizeIfSessionMatches` parity).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachResizeStatus {
    /// Geometry changed: cols/rows updated, epoch bumped, PTY resized.
    Resized,
    /// Geometry already matched: no epoch bump, no PTY syscall (Node `unchanged`).
    Unchanged,
    /// The intent/subscriber condition said not to resize (Node `shouldResize` false).
    Skipped,
    /// Terminal is not running (Node `not_running`): no mutation.
    NotRunning,
    /// Unknown terminal id (Node `missing`).
    Missing,
}
```

Add the method next to `pub fn resize` (same registry-lock-then-terminal-lock order as `resize` — this method MUST be called before `attach`, never from inside it; see the lock-ordering note in the Context section):

```rust
    /// TERM-07: apply the `terminal.attach`-supplied viewport geometry BEFORE
    /// the broker attach/replay, replicating Node's `shouldResize`
    /// (`broker.ts:358-362`): `viewport_hydrate` always resizes;
    /// `transport_reconnect` resizes only when no OTHER socket is attached or
    /// this same connection is re-attaching; `keepalive_delta` never resizes.
    /// Node samples the client set PRE-attach, so call this before `attach`
    /// inserts the subscriber (the insert would also destroy the
    /// "existing attachment" evidence for the same `conn_id`).
    /// Epoch semantics match `resize` (Task 2): the first-ever client
    /// geometry record never bumps; later real changes bump. A record also
    /// happens on unchanged dims when the resize is allowed, but never when
    /// the intent condition skips it (Node `broker.ts:373, 387-392`).
    pub fn resize_for_attach(
        &self,
        terminal_id: &str,
        conn_id: u64,
        intent: TerminalAttachIntent,
        cols: u16,
        rows: u16,
    ) -> AttachResizeStatus {
        let inner = self.inner.lock().expect("registry lock");
        let Some(handle) = inner.terminals.get(terminal_id) else {
            return AttachResizeStatus::Missing;
        };
        {
            let mut s = handle.shared.lock().expect("terminal lock");
            let has_other_attached = s.subscribers.keys().any(|k| *k != conn_id);
            let existing_attachment = s.subscribers.contains_key(&conn_id);
            let should_resize = match intent {
                TerminalAttachIntent::ViewportHydrate => true,
                TerminalAttachIntent::TransportReconnect => {
                    !has_other_attached || existing_attachment
                }
                TerminalAttachIntent::KeepaliveDelta => false,
            };
            if !should_resize {
                return AttachResizeStatus::Skipped;
            }
            if s.status != TerminalRunStatus::Running {
                return AttachResizeStatus::NotRunning;
            }
            // Node records geometry for BOTH 'resized' and 'unchanged' results
            // when shouldResize is true (broker.ts:387-392); a skipped attach
            // never records (broker.ts:373). The first-ever record applies
            // dims WITHOUT bumping the epoch (recordTerminalGeometry,
            // broker.ts:666-686) -- the same rule `resize` follows since Task 2.
            let first_record = !s.has_client_geometry;
            s.has_client_geometry = true;
            if s.cols == cols && s.rows == rows {
                return AttachResizeStatus::Unchanged;
            }
            s.cols = cols;
            s.rows = rows;
            if !first_record {
                s.geometry_epoch += 1;
            }
        }
        if let Some(pty) = handle.pty.as_ref() {
            pty.resize(cols, rows);
        }
        AttachResizeStatus::Resized
    }
```

Add the `TerminalAttachIntent` import at the top of `registry.rs` alongside the existing `freshell_protocol` imports.

Note: the `NotRunning` branch IS unit-tested (`resize_for_attach_exited_terminal_not_running` above) via the existing `pub fn finish_pty_exit` seam (registry.rs:1112), which flips a headless terminal to `Exited` while retaining its record — the same seam the existing test `attach_to_already_exited_terminal_delivers_synthetic_exit` uses. No new test scaffolding is needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-terminal`
Expected: no new failures vs the recorded baseline — including the 9 new `resize_for_attach_*` tests and all pre-existing tests (especially the Task-2-updated `resize_updates_geometry_epoch_only_on_change`).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-terminal/src/registry.rs
git commit -m "feat(rust): intent-conditional attach-time resize in TerminalRegistry (TERM-07 geometry)"
```

---

### Task 4: Wire attach geometry into `handle_attach` with the session-identity guard (integration-test first)

**Files:**
- Create: `crates/freshell-ws/tests/attach_viewport_resize.rs`
- Modify: `crates/freshell-ws/src/terminal.rs:1749-1777` (`handle_attach`) + a new `#[cfg(test)]` test module for the guard

**Interfaces:**
- Consumes: `TerminalRegistry::resize_for_attach(terminal_id, conn_id, intent, cols, rows)` and `TerminalRegistry::geometry(terminal_id) -> Option<(u16, u16, i64)>` from Tasks 1-3; `TerminalAttach { cols: i64, rows: i64, intent: TerminalAttachIntent, expected_session_ref: Option<SessionLocator>, ... }` from `freshell-protocol`; `state.identity.session_ref_for(&str) -> Option<SessionLocator>` (already called in `handle_attach`).
- Produces: private fn `attach_geometry_identity_ok(expected: Option<&SessionLocator>, canonical: Option<&SessionLocator>) -> bool` in `crates/freshell-ws/src/terminal.rs` (internal only; nothing later depends on it).

- [ ] **Step 1: Write the failing integration tests**

Create `crates/freshell-ws/tests/attach_viewport_resize.rs`. Integration test files in this repo are self-contained (no shared test crate) — build the harness by copying from the two existing files.

IMPORTANT (verified against the worktree): the two donor files declare DIFFERENT `TestWs` types (term09_output_queue.rs:100 uses `WebSocketStream<tokio::net::TcpStream>` via raw `client_async`; session_identity_frames.rs:150-151 uses `WebSocketStream<MaybeTlsStream<TcpStream>>` via `connect_async`), and term09's `spawn_server` has signature `async fn spawn_server(term09: Term09Config) -> String` (takes an argument, returns no registry). Never mix helpers from the two files without retyping. Therefore:

1. From `crates/freshell-ws/tests/session_identity_frames.rs` copy: the `use` header, the `TestWs` type alias (lines 150-151), `test_settings_value()` (line 29), `async fn spawn_server() -> (String, freshell_terminal::TerminalRegistry)` (lines 90-147: it ALREADY returns the registry; use it verbatim, no modification needed; `TerminalRegistry` is `Clone` with an `Arc` inside, registry.rs:403-405, so the returned handle observes the live server's state), and `connect_and_capture_inventory(url: &str) -> (TestWs, serde_json::Value)` (line 156). Copy `sleeper_cli_spec` (line 53) only if the copied `test_settings_value`/`spawn_server` reference it; dead copied helpers fail clippy `-D warnings`. From `term09_output_queue.rs` copy `create_shell_terminal` (line ~175) and `drain_until_marker_or_deadline` (line ~258), changing their `ws: &mut TestWs` parameter to the adopted `TestWs` alias (their bodies only use `send`/`next` and compile unchanged). Do NOT copy term09's `TestWs` alias, `spawn_server`, `connect_plain`/`connect_and_complete_handshake`/`complete_handshake`, or its fixed-80x24 `attach` helper (we define a parameterized one below), and do not copy helpers you don't use (dead code fails clippy `-D warnings`).
Then add these helpers:

```rust
async fn attach_with(
    ws: &mut TestWs,
    terminal_id: &str,
    attach_request_id: &str,
    intent: &str,
    cols: u16,
    rows: u16,
    expected_session_ref: Option<serde_json::Value>,
) {
    let mut msg = serde_json::json!({
        "type": "terminal.attach",
        "terminalId": terminal_id,
        "intent": intent,
        "cols": cols,
        "rows": rows,
        "attachRequestId": attach_request_id,
    });
    if let Some(sr) = expected_session_ref {
        msg["expectedSessionRef"] = sr;
    }
    ws.send(WsMessage::Text(msg.to_string()))
        .await
        .expect("send terminal.attach");
}

async fn wait_for_attach_ready(ws: &mut TestWs, attach_request_id: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(5), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
                    continue;
                };
                if value.get("type").and_then(|v| v.as_str()) == Some("terminal.attach.ready")
                    && value.get("attachRequestId").and_then(|v| v.as_str())
                        == Some(attach_request_id)
                {
                    return;
                }
            }
            Ok(Some(Ok(_))) => {}
            other => panic!("expected terminal.attach.ready, got {other:?}"),
        }
    }
    panic!("terminal.attach.ready never arrived for {attach_request_id}");
}

async fn send_input(ws: &mut TestWs, terminal_id: &str, data: &str) {
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.input",
            "terminalId": terminal_id,
            "data": data,
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.input");
}
```

And these three tests:

```rust
#[tokio::test]
async fn viewport_hydrate_attach_resizes_pty_to_attached_geometry() {
    let (url, registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;
    let terminal_id = create_shell_terminal(&mut ws, "req-geo-1").await;
    assert_eq!(
        registry.geometry(&terminal_id),
        Some((120, 30, 1)),
        "spawn default before attach"
    );

    attach_with(&mut ws, &terminal_id, "att-geo-1", "viewport_hydrate", 95, 41, None).await;
    wait_for_attach_ready(&mut ws, "att-geo-1").await;
    assert_eq!(
        registry.geometry(&terminal_id),
        Some((95, 41, 1)),
        "attach applies the first client geometry WITHOUT bumping the epoch (Node first-record-no-bump)"
    );

    // Kernel ground truth: ask the PTY itself. `stty size` prints `rows cols`.
    // The shell's echo of the typed command contains the literal `$(stty size)`,
    // so the expanded marker below can only come from real command output.
    send_input(&mut ws, &terminal_id, "echo __GEO__$(stty size)__\r").await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    let (acc, _gap, _closed) =
        drain_until_marker_or_deadline(&mut ws, "__GEO__41 95__", deadline).await;
    assert!(
        acc.contains("__GEO__41 95__"),
        "PTY must report the attached geometry (41 rows, 95 cols); got output: {acc}"
    );
}

#[tokio::test]
async fn mismatched_expected_session_ref_does_not_resize() {
    let (url, registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;
    let terminal_id = create_shell_terminal(&mut ws, "req-geo-2").await;

    // A plain shell terminal has no canonical session identity, so an explicit
    // expectation cannot match -> the resize must be skipped (Node
    // resizeIfSessionMatches: no mutation on session_identity_mismatch).
    attach_with(
        &mut ws,
        &terminal_id,
        "att-geo-2",
        "viewport_hydrate",
        95,
        41,
        Some(serde_json::json!({"provider": "codex", "sessionId": "bogus-session"})),
    )
    .await;
    wait_for_attach_ready(&mut ws, "att-geo-2").await;
    assert_eq!(
        registry.geometry(&terminal_id),
        Some((120, 30, 1)),
        "mismatched expectedSessionRef must not resize or bump the epoch"
    );
}

#[tokio::test]
async fn transport_reconnect_resizes_only_without_other_sockets_or_when_reattaching() {
    let (url, registry) = spawn_server().await;
    let (mut ws_a, _inventory_a) = connect_and_capture_inventory(&url).await;
    let terminal_id = create_shell_terminal(&mut ws_a, "req-geo-3").await;

    // A alone: transport_reconnect resizes (no other attached sockets).
    // First-ever geometry record: no epoch bump (Node first-record-no-bump).
    attach_with(&mut ws_a, &terminal_id, "att-a-1", "transport_reconnect", 95, 41, None).await;
    wait_for_attach_ready(&mut ws_a, "att-a-1").await;
    assert_eq!(registry.geometry(&terminal_id), Some((95, 41, 1)));

    // B reconnect-attaches while A is attached and B has no prior attachment:
    // must NOT resize (Node: hasOtherAttachedSockets && !existingAttachment).
    let (mut ws_b, _inventory_b) = connect_and_capture_inventory(&url).await;
    attach_with(&mut ws_b, &terminal_id, "att-b-1", "transport_reconnect", 100, 50, None).await;
    wait_for_attach_ready(&mut ws_b, "att-b-1").await;
    assert_eq!(
        registry.geometry(&terminal_id),
        Some((95, 41, 1)),
        "reconnect with another socket attached and no prior attachment: skip"
    );

    // B re-attaches (existing attachment): resizes despite A being attached.
    // Second geometry record: this one bumps the epoch.
    attach_with(&mut ws_b, &terminal_id, "att-b-2", "transport_reconnect", 100, 50, None).await;
    wait_for_attach_ready(&mut ws_b, "att-b-2").await;
    assert_eq!(
        registry.geometry(&terminal_id),
        Some((100, 50, 2)),
        "re-attach by the same connection: apply; the second record bumps the epoch"
    );
}
```

If the copied harness's connect helper has a different name/signature (e.g. it returns a tuple), adapt the call sites — keep the helper bodies verbatim otherwise.

- [ ] **Step 2: Run the integration tests to verify they fail**

Run: `cargo test -p freshell-ws --test attach_viewport_resize`
Expected: FAIL — `viewport_hydrate_attach_resizes_pty_to_attached_geometry` panics at the `Some((95, 41, 1))` assertion with actual `Some((120, 30, 1))` (geometry untouched: nothing calls `resize_for_attach` yet), and `transport_reconnect_...` fails the same way. `mismatched_expected_session_ref_does_not_resize` may already pass (it asserts the status quo) — that is fine; it pins the guard against regression.

- [ ] **Step 3: Write the guard's failing unit tests**

At the bottom of `crates/freshell-ws/src/terminal.rs` (add a new module if none exists; if the file already has a `#[cfg(test)]` module, extend it):

```rust
#[cfg(test)]
mod attach_geometry_tests {
    use super::attach_geometry_identity_ok;
    use freshell_protocol::SessionLocator;

    fn locator(provider: &str, session_id: &str) -> SessionLocator {
        SessionLocator {
            provider: provider.to_string(),
            session_id: session_id.to_string(),
        }
    }

    #[test]
    fn no_expectation_always_ok() {
        assert!(attach_geometry_identity_ok(None, None));
        assert!(attach_geometry_identity_ok(None, Some(&locator("codex", "s1"))));
    }

    #[test]
    fn matching_expectation_ok() {
        let expected = locator("codex", "s1");
        let canonical = locator("codex", "s1");
        assert!(attach_geometry_identity_ok(Some(&expected), Some(&canonical)));
    }

    #[test]
    fn differing_expectation_mismatch() {
        let expected = locator("codex", "s1");
        let canonical = locator("codex", "s2");
        assert!(!attach_geometry_identity_ok(Some(&expected), Some(&canonical)));
    }

    #[test]
    fn expectation_against_no_identity_mismatch() {
        let expected = locator("codex", "s1");
        assert!(!attach_geometry_identity_ok(Some(&expected), None));
    }
}
```

(If `SessionLocator`'s import path differs, match the path `terminal.rs` already uses for it.)

Run: `cargo test -p freshell-ws attach_geometry_tests`
Expected: compile error — `attach_geometry_identity_ok` not found (red state).

- [ ] **Step 4: Implement the guard and the `handle_attach` wiring**

In `crates/freshell-ws/src/terminal.rs`, replace the body of `handle_attach` (keep its existing doc comment, and keep the existing `// STATE-SYNC FIX 1 increment 2a ...` comment attached to the `session_ref` resolution):

```rust
fn handle_attach(
    attach: TerminalAttach,
    state: &WsState,
    conn_id: u64,
    conn_sink: &FrameSink,
    terminal_output_batch_v1: bool,
) {
    // STATE-SYNC FIX 1 increment 2a: stamp the canonical identity onto
    // `attach.ready` from the shared identity registry (create-time
    // resume ids AND locator-associated ids both live there); the
    // registry crate is identity-agnostic, so it's resolved here.
    let canonical_session_ref = state.identity.session_ref_for(&attach.terminal_id);

    // TERM-07 (`broker.ts:358-397` parity): apply the attach-supplied viewport
    // geometry to the PTY BEFORE attach/replay. The intent + pre-attach
    // subscriber condition lives in `resize_for_attach`; the session-identity
    // guard (Node `resizeIfSessionMatches`) lives here because this crate owns
    // the identity registry. This MUST run before `registry.attach`: attach's
    // subscriber insert would destroy the pre-attach evidence the condition
    // needs, and resizing under attach's per-terminal lock would deadlock.
    if attach_geometry_identity_ok(
        attach.expected_session_ref.as_ref(),
        canonical_session_ref.as_ref(),
    ) {
        let cols = attach.cols.clamp(0, u16::MAX as i64) as u16;
        let rows = attach.rows.clamp(0, u16::MAX as i64) as u16;
        state
            .registry
            .resize_for_attach(&attach.terminal_id, conn_id, attach.intent, cols, rows);
    }

    state.registry.attach(
        &attach.terminal_id,
        conn_id,
        Arc::clone(conn_sink),
        attach.attach_request_id.clone(),
        attach.since_seq.unwrap_or(0),
        terminal_output_batch_v1,
        canonical_session_ref,
    );
}

/// Node's `resizeIfSessionMatches` identity guard
/// (`server/terminal-registry.ts:3890-3903` `buildSessionIdentityMismatchResult`):
/// no guard when the client sent no `expectedSessionRef`; when it did, the
/// resize applies only if the terminal's canonical session identity matches.
/// A terminal with no canonical identity cannot match an explicit expectation.
fn attach_geometry_identity_ok(
    expected: Option<&SessionLocator>,
    canonical: Option<&SessionLocator>,
) -> bool {
    match (expected, canonical) {
        (None, _) => true,
        (Some(e), Some(c)) => e == c,
        (Some(_), None) => false,
    }
}
```

The `cols`/`rows` clamping mirrors the existing `handle_resize` (`terminal.rs:1779-1785`) exactly. If `SessionLocator` is not already imported in `terminal.rs`, add it to the existing `freshell_protocol` import list.

- [ ] **Step 5: Run all the new tests to verify they pass**

Run: `cargo test -p freshell-ws --test attach_viewport_resize`
Expected: all 3 integration tests PASS.

Run: `cargo test -p freshell-ws attach_geometry_tests`
Expected: all 4 guard unit tests PASS.

- [ ] **Step 6: Run the full affected suites to verify no regressions**

Run: `cargo test -p freshell-terminal && cargo test -p freshell-ws`
Expected: no NEW failures vs the recorded baseline (see Global Constraints: `codex_session_ref_resume` and `session_identity_frames::fresh_claude_create_frames_carry_preallocated_session_ref` are pre-existing reds unless `npm ci` was run). In particular the pre-existing `term09_output_queue` and `pane_reconcile` tests attach with `viewport_hydrate` 80x24 — their terminals will now actually resize to 80x24 (a first record: no epoch bump) — and `session_identity_frames` attaches with 120x30 (equal to the spawn default: `Unchanged`, no syscall). None of them assert against cols/rows/geometry_epoch (verified). If one fails, read its assertion before touching anything and fix forward within these semantics.

- [ ] **Step 7: Commit**

```bash
git add crates/freshell-ws/src/terminal.rs crates/freshell-ws/tests/attach_viewport_resize.rs
git commit -m "fix(rust): apply attach-time viewport geometry before replay (TERM-07 geometry parity)"
```

---

### Task 5: Checklist annotation + full verification pass

**Files:**
- Modify: `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md:221-222`

**Interfaces:**
- Consumes: the completed Tasks 1-4.
- Produces: nothing code-level; documentation + final green verification.

- [ ] **Step 1: Annotate TERM-07 (do NOT tick the box)**

TERM-07 covers intent, priority, replay budget, geometry, and request correlation; this fix delivers only the geometry/intent portion (`priority` and `maxReplayBytes` are still dropped by `handle_attach`), so the item is not fully satisfied and the checkbox stays unchecked. The current item at lines 221-222 reads:

```
- [ ] **TERM-07 — Honor attach intent, priority, replay budget, geometry, and request correlation.** Implement viewport hydration, keepalive delta, transport reconnect, foreground/background policy, `maxReplayBytes`, rows/columns, and `attachRequestId`.
  - **Playwright validation (`PW-RUST`):** Parameterize every intent with unique request IDs, two sizes/priorities, and small replay budget; assert correlated replies/effective sequence, foreground size ownership, background nonresize, reconnect geometry, and bounded suffix plus gap notice.
```

Insert a progress sub-bullet directly under the first line (between it and the Playwright bullet):

```
  - **2026-07-24 partial:** attach-time geometry now applied — `registry.resize_for_attach()` replicates Node's `shouldResize` intent condition + `resizeIfSessionMatches` identity guard before attach/replay, and Node's first-record-no-bump geometry-epoch semantics are ported (`has_client_geometry` on `TerminalShared`, consulted by both `resize` and `resize_for_attach`) (see `docs/plans/2026-07-24-rust-attach-viewport.md`; covered by `crates/freshell-ws/tests/attach_viewport_resize.rs`). Still open: `priority` policy and `maxReplayBytes`.
```

- [ ] **Step 2: Full verification pass**

Run each and confirm:

```bash
cargo test -p freshell-terminal        # expected: all pass
cargo test -p freshell-ws              # expected: no NEW failures vs baseline (two known pre-existing reds; see Global Constraints)
cargo fmt --all --check                # expected: no diff
cargo clippy -p freshell-terminal -p freshell-ws --all-targets -- -D warnings   # expected: zero diagnostics in freshell-terminal/freshell-ws code; the 6 pre-existing freshell-platform errors are baseline (command may exit nonzero because of them alone)
```

If `fmt` reports a diff in files this plan touched, run `cargo fmt --all` and include the result in the commit. If clippy flags the new code (e.g. dead copied test helpers), fix minimally (delete unused helpers rather than `#[allow]`).

No JS/Vitest run is required: no file under `src/`, `server/`, or `shared/` changed (verify with `git diff --stat origin/main...HEAD` — only `crates/` and `docs/plans/` paths should appear).

- [ ] **Step 3: Commit**

```bash
git add docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md
git commit -m "docs: annotate TERM-07 geometry progress in parity checklist"
```

If Step 2 produced formatting fixes, commit those separately first:

```bash
git add -u crates/
git commit -m "style(rust): cargo fmt for attach viewport changes"
```

---

## Self-Review (performed at plan-writing time; re-run after load-bearing validation on 2026-07-24)

**Validation updates (2026-07-24):** every load-bearing assumption of this plan was verified against the worktree (evidence ledger: `.worktrees/.the-usual-logs/rust-attach-viewport/load-bearing-ledger.md`). Three falsified assumptions changed the plan: (1) the original "no epoch bookkeeping changes needed" claim was wrong — Node's first-record-no-bump epoch rule is client-visible (remount warm-delta replay), so Task 2 was added and every epoch assertion renumbered; (2) the original harness recipe would not have compiled (term09's `spawn_server(Term09Config) -> String` and divergent `TestWs` types between donor files) — Task 4 now sources the harness from `session_identity_frames.rs`; (3) the Rust baseline is not fully green — the recorded baseline in Global Constraints rescopes every gate to "no NEW failures". A fourth falsified sub-claim ("`NotRunning` is untestable, no seam exists") reversed: the `finish_pty_exit` seam exists and that branch is now unit-tested. One accepted divergence added (duplicate re-attach; see Context). Lock-ordering, subscriber-set equivalence, the interleaving window, identity-guard semantics, derived authority, and the `stty` marker technique were all verified (the probe ran 6/6 against `/bin/bash -l` and `/bin/sh`).

**Spec coverage:**
1. *Resize before attach/replay, `viewport_hydrate` + Node's exact `transport_reconnect` condition* → Task 3 (condition verbatim from `broker.ts:358-362`, incl. `existingAttachment` — verified against the shipped worktree code) + Task 4 (ordering: before `registry.attach`, hence before ready/replay).
2. *Session identity like `resizeIfSessionMatches`* → Task 4 guard (`attach_geometry_identity_ok`), mismatch = no mutation — verified against `terminalMatchesExpectedSession` (`terminal-session-identity.ts:17-25`: no-identity terminal + explicit expectation IS a mismatch, exactly the `(Some, None) => false` arm); Node's additional detach-and-fail is explicitly documented as out of scope in the Context section (Rust attach has no failure channel today and the spec's required test is "mismatched session ref does not resize").
3. *Geometry epoch/authority consistency* → Task 2 ports Node's first-record-no-bump epoch rule (validated as client-visible); Task 3 applies the same rule in `resize_for_attach`; ordering guarantees `attach.ready` stamps post-resize values; authority analysis in Context (derived authority verified sufficient — the client never reads `replayResetReason` and every divergent case forces the client's own full-hydrate backstop). Epoch assertions in unit + integration tests.
4. *TDD with a failing test asserting ACTUAL PTY geometry* → Task 4 Step 1 test 1 uses `stty size` inside the PTY (kernel ground truth; technique validated 6/6 in a standalone PTY probe against the shell the server actually spawns), red before the fix; all four spec-listed cases covered (hydrate applies; reconnect conditional both ways; mismatch no-resize; epoch semantics).
5. *Run relevant suites / repo checks* → Task 4 Step 6 + Task 5 Step 2 (cargo test both crates, fmt, clippy — all gated as "no NEW failures vs the recorded baseline"; JS gate not required for Rust-only diff, with a verification command).
6. *TERM-07 tick/annotate* → Task 5 annotates without ticking (item not fully satisfied — priority/maxReplayBytes remain).
7. *No client / Node server changes; never restart server; no PR* → Global Constraints.

**No silent deferrals:** the acceptance outcome (PTY actual size equals attached geometry via the Rust server, no client changes) is proven by a real end-to-end test (real WS server, real shell PTY, `stty size`) — no stubs or mocks stand in for it. The consciously-excluded behaviors (attach-abort on identity mismatch; duplicate re-attach short-circuit; codex identity-timing gaps; `priority`/`maxReplayBytes`) are not required by this spec and are recorded loudly (Context section; unchecked TERM-07 with annotation), not silently dropped.

**Placeholder scan:** every code step contains complete code; harness reuse instructions name exact source files, functions, verified signatures, and line anchors rather than "similar to". No untested branches remain in the new code (the `NotRunning` branch is tested via the existing `finish_pty_exit` seam).

**Type consistency:** `geometry()` returns `Option<(u16, u16, i64)>` and every assertion uses `Some((u16, u16, i64))` literals; `resize_for_attach(&self, &str, u64, TerminalAttachIntent, u16, u16) -> AttachResizeStatus` matches all call sites (Task 3 tests, Task 4 `handle_attach`); `has_client_geometry: bool` is private state touched only by `resize`/`resize_for_attach`; `attach_geometry_identity_ok(Option<&SessionLocator>, Option<&SessionLocator>) -> bool` matches its tests and call site; `SessionLocator { provider: String, session_id: String }` matches the protocol struct (verified); `finish_pty_exit(&self, &str, i64) -> bool` matches its test call (verified at registry.rs:1112); `connect_and_capture_inventory(&str) -> (TestWs, serde_json::Value)` matches the destructuring call sites (verified at session_identity_frames.rs:156).
