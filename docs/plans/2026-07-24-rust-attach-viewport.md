# Rust Attach-Time Viewport Resize (TERM-07 geometry) Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Make the Rust WebSocket server apply the `cols`/`rows` carried in every `terminal.attach` message to the PTY before attach/replay, matching the Node broker's semantics, so PTYs no longer stay stuck at the 120x30 spawn default.

**Architecture:** Add one new registry method (`TerminalRegistry::resize_for_attach`) in `freshell-terminal` that atomically samples the *pre-attach* subscriber set, evaluates Node's `shouldResize` condition per attach intent, and applies the geometry with the existing epoch semantics. Wire it into `freshell-ws::handle_attach` *before* `registry.attach(...)`, guarded by the same session-identity check Node's `resizeIfSessionMatches` applies. Add a small `geometry()` accessor so tests can assert real registry state.

**Tech Stack:** Rust (cargo workspace: `freshell-terminal`, `freshell-ws`, `freshell-protocol`), tokio + tokio-tungstenite integration tests, portable-pty.

## Global Constraints

- **Rust side only.** Do NOT modify the client (`src/`), the Node server (`server/`), or `shared/ws-protocol.ts`. The React/TS frontend is frozen.
- **Wire shape is immutable** (WS_PROTOCOL_VERSION=7). The fix works entirely within the existing `terminal.attach { terminalId, intent, cols, rows, attachRequestId, expectedSessionRef, ... }` shape already parsed in `crates/freshell-protocol/src/client_messages.rs:234-251`. No protocol struct changes.
- **TDD is mandatory** (repo AGENTS.md): Red-Green-Refactor for every task; run the failing test before implementing.
- **Parity reference is the shipped Node code**, `server/terminal-stream/broker.ts:347-397` and `server/terminal-registry.ts` `resizeIfSessionMatches` — not the aspirational doc `docs/superpowers/plans/2026-03-04-option-c-attach-viewport.md` (that doc says "unconditional resize"; shipped Node code is *conditional* on intent. Replicate the code).
- Work on branch `fix/rust-attach-viewport` in this worktree (`.worktrees/rust-attach-viewport`). Frequent, focused commits.
- **Never** restart the self-hosted Freshell server; **never** create a PR (requires explicit user approval); **never** use broad kill patterns.
- Rust checks are NOT gated by the JS coordinator (`npm test` gate is Vitest-only). Run `cargo test -p freshell-terminal`, `cargo test -p freshell-ws`, `cargo fmt --all --check`, and `cargo clippy -p freshell-terminal -p freshell-ws --all-targets -- -D warnings` locally.
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

**Rust epoch/authority mapping (why no bookkeeping changes are needed):**
- Rust already keeps `cols`/`rows`/`geometry_epoch` on `TerminalShared` (`registry.rs:211-214`); `resize` bumps the epoch only on a real change (`registry.rs:991`) — that is the established Rust epoch model (Node keeps its epoch in the broker instead, but the client-visible contract is the same: epoch changes only when geometry actually changes, and `attach.ready` reports the post-resize value).
- `geometry_authority` is *derived* in Rust (`subscribers.len() >= 2 → multi_client_unknown`, `registry.rs:240-246`) and is computed during `attach` — i.e. after our new pre-attach resize — which yields exactly the value Node records (`hasOtherAttachedSockets ? 'multi_client_unknown' : 'single_client'`). No stored-authority field is needed.
- Because our resize runs before `registry.attach` builds `TerminalAttachReady`, the ready frame automatically stamps the post-resize `geometry_epoch` — same ordering as Node.

**Lock-ordering constraint (why the resize is a separate call before `attach`, not inside it):** `resize` takes the registry lock then the per-terminal lock; `attach` drops the registry lock and then holds the per-terminal lock for its whole critical section, and never retains the `TerminalHandle` (so it has no `PtyTerminal`). Calling any resize from inside `attach` would deadlock. Running `resize_for_attach` *before* `attach` also means the subscriber map it samples is exactly Node's pre-attach client set — `attach` inserts the subscriber (overwriting any prior entry for the same `conn_id`, destroying the "existing attachment" evidence), so the sampling MUST happen before that insert.

**Known, accepted divergence (documented, not silent):** on session-identity mismatch Node *also* detaches and fails the whole attach with a `session_identity_mismatch` result. The spec for this fix requires only that a mismatched `expectedSessionRef` does not resize (matching `resizeIfSessionMatches`'s no-mutation guarantee); Rust's attach today has no failure channel at all (`AttachOutcome { found: bool }`, and even unknown-terminal attaches are silent no-ops). Changing attach failure semantics is a separate parity item outside this fix — here, a mismatch skips the resize and the attach proceeds as it does today.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `crates/freshell-terminal/src/registry.rs` | Modify | Add `pub fn geometry(...)` accessor; add `AttachResizeStatus` enum + `pub fn resize_for_attach(...)`; new unit tests in the existing `#[cfg(test)]` module |
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
- Produces: `pub fn geometry(&self, terminal_id: &str) -> Option<(u16, u16, i64)>` — `(cols, rows, geometry_epoch)`, `None` for unknown ids. Tasks 2 and 3 use this in tests.

- [ ] **Step 1: Write the failing test**

Add to the existing `#[cfg(test)]` module in `registry.rs` (same module where `insert_headless` and `collector()` already live — copy the surrounding style of `resize_updates_geometry_epoch_only_on_change`):

```rust
    #[test]
    fn geometry_reports_cols_rows_epoch() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S"); // headless default: 120x30, epoch 1
        assert_eq!(reg.geometry("T"), Some((120, 30, 1)));

        reg.resize("T", 100, 40);
        assert_eq!(reg.geometry("T"), Some((100, 40, 2)));

        assert_eq!(reg.geometry("nope"), None);
    }
```

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

### Task 2: `TerminalRegistry::resize_for_attach()` — intent-conditional pre-attach resize

**Files:**
- Modify: `crates/freshell-terminal/src/registry.rs` (new enum near `AttachOutcome` ~line 456; new method next to `pub fn resize` ~line 978; unit tests in the existing `#[cfg(test)]` module)

**Interfaces:**
- Consumes: `TerminalAttachIntent` from `freshell-protocol` (the crate already depends on it — `crates/freshell-terminal/Cargo.toml:13` has `freshell-protocol = { path = "../freshell-protocol" }`; if `use freshell_protocol::TerminalAttachIntent;` doesn't resolve, use the same import path prefix the file already uses for `SessionLocator`). Also `TerminalRunStatus` (already imported — `attach` compares `s.status == TerminalRunStatus::Exited`), private `TerminalShared.subscribers`, `TerminalHandle.pty`, `PtyTerminal::resize`, and Task 1's `geometry()` in tests.
- Produces (Task 3 calls this):

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
    fn resize_for_attach_viewport_hydrate_applies_geometry_and_bumps_epoch() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S"); // 120x30, epoch 1
        let out = reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 95, 41);
        assert_eq!(out, AttachResizeStatus::Resized);
        assert_eq!(reg.geometry("T"), Some((95, 41, 2)));
    }

    #[test]
    fn resize_for_attach_unchanged_geometry_does_not_bump_epoch() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let out = reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 120, 30);
        assert_eq!(out, AttachResizeStatus::Unchanged);
        assert_eq!(reg.geometry("T"), Some((120, 30, 1)));
    }

    #[test]
    fn resize_for_attach_keepalive_delta_never_resizes() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let out = reg.resize_for_attach("T", 1, TerminalAttachIntent::KeepaliveDelta, 95, 41);
        assert_eq!(out, AttachResizeStatus::Skipped);
        assert_eq!(reg.geometry("T"), Some((120, 30, 1)));
    }

    #[test]
    fn resize_for_attach_transport_reconnect_applies_when_alone() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        // No subscribers at all -> no other attached sockets -> resize.
        let out = reg.resize_for_attach("T", 1, TerminalAttachIntent::TransportReconnect, 95, 41);
        assert_eq!(out, AttachResizeStatus::Resized);
        assert_eq!(reg.geometry("T"), Some((95, 41, 2)));
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
        assert_eq!(reg.geometry("T"), Some((95, 41, 2)));
    }

    #[test]
    fn resize_for_attach_missing_terminal() {
        let reg = TerminalRegistry::new();
        let out = reg.resize_for_attach("nope", 1, TerminalAttachIntent::ViewportHydrate, 95, 41);
        assert_eq!(out, AttachResizeStatus::Missing);
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
    /// Epoch semantics match `resize`: bump only on a real change.
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
            if s.cols == cols && s.rows == rows {
                return AttachResizeStatus::Unchanged;
            }
            s.cols = cols;
            s.rows = rows;
            s.geometry_epoch += 1;
        }
        if let Some(pty) = handle.pty.as_ref() {
            pty.resize(cols, rows);
        }
        AttachResizeStatus::Resized
    }
```

Add the `TerminalAttachIntent` import at the top of `registry.rs` alongside the existing `freshell_protocol` imports.

Note: there is no dedicated unit test for the `NotRunning` branch — the test seams (`insert_headless`) only produce `Running` terminals and no seam exists to mark one exited. The branch is a direct transcription of Node's `not_running` guard and is one line; do not build new test scaffolding for it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-terminal`
Expected: all tests pass, including the 7 new `resize_for_attach_*` tests and all pre-existing tests (especially `resize_updates_geometry_epoch_only_on_change`).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-terminal/src/registry.rs
git commit -m "feat(rust): intent-conditional attach-time resize in TerminalRegistry (TERM-07 geometry)"
```

---

### Task 3: Wire attach geometry into `handle_attach` with the session-identity guard (integration-test first)

**Files:**
- Create: `crates/freshell-ws/tests/attach_viewport_resize.rs`
- Modify: `crates/freshell-ws/src/terminal.rs:1749-1777` (`handle_attach`) + a new `#[cfg(test)]` test module for the guard

**Interfaces:**
- Consumes: `TerminalRegistry::resize_for_attach(terminal_id, conn_id, intent, cols, rows)` and `TerminalRegistry::geometry(terminal_id) -> Option<(u16, u16, i64)>` from Tasks 1-2; `TerminalAttach { cols: i64, rows: i64, intent: TerminalAttachIntent, expected_session_ref: Option<SessionLocator>, ... }` from `freshell-protocol`; `state.identity.session_ref_for(&str) -> Option<SessionLocator>` (already called in `handle_attach`).
- Produces: private fn `attach_geometry_identity_ok(expected: Option<&SessionLocator>, canonical: Option<&SessionLocator>) -> bool` in `crates/freshell-ws/src/terminal.rs` (internal only; nothing later depends on it).

- [ ] **Step 1: Write the failing integration tests**

Create `crates/freshell-ws/tests/attach_viewport_resize.rs`. Integration test files in this repo are self-contained (no shared test crate) — build the harness by copying, verbatim, from the two existing files:

1. From `crates/freshell-ws/tests/term09_output_queue.rs` copy: the `use` header and `TestWs` type alias, `test_settings_value()` (line ~24), `spawn_server(...)` (line ~44), `connect_plain`/`connect_and_complete_handshake`/`complete_handshake` (lines ~104-173), `create_shell_terminal` (line ~175), and `drain_until_marker_or_deadline` (line ~258). Do NOT copy its fixed-80x24 `attach` helper (we define a parameterized one below) and do not copy helpers you don't use (dead code fails clippy `-D warnings`).
2. Modify the copied `spawn_server` to also return the registry, exactly the pattern `crates/freshell-ws/tests/session_identity_frames.rs:90-147` uses: bind the registry to a local (`let registry = ...` wherever the copied code constructs the `TerminalRegistry` that goes into `WsState`), pass `registry.clone()` into the `WsState` field (`TerminalRegistry` is `Clone` — `Arc` inside), and change the return to `(String, freshell_terminal::TerminalRegistry)` returning `(url, registry)`. Consult `session_identity_frames.rs` if the copied construction differs.

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
    let mut ws = connect_and_complete_handshake(&url).await;
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
        Some((95, 41, 2)),
        "attach applies geometry and bumps the epoch once"
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
    let mut ws = connect_and_complete_handshake(&url).await;
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
    let mut ws_a = connect_and_complete_handshake(&url).await;
    let terminal_id = create_shell_terminal(&mut ws_a, "req-geo-3").await;

    // A alone: transport_reconnect resizes (no other attached sockets).
    attach_with(&mut ws_a, &terminal_id, "att-a-1", "transport_reconnect", 95, 41, None).await;
    wait_for_attach_ready(&mut ws_a, "att-a-1").await;
    assert_eq!(registry.geometry(&terminal_id), Some((95, 41, 2)));

    // B reconnect-attaches while A is attached and B has no prior attachment:
    // must NOT resize (Node: hasOtherAttachedSockets && !existingAttachment).
    let mut ws_b = connect_and_complete_handshake(&url).await;
    attach_with(&mut ws_b, &terminal_id, "att-b-1", "transport_reconnect", 100, 50, None).await;
    wait_for_attach_ready(&mut ws_b, "att-b-1").await;
    assert_eq!(
        registry.geometry(&terminal_id),
        Some((95, 41, 2)),
        "reconnect with another socket attached and no prior attachment: skip"
    );

    // B re-attaches (existing attachment): resizes despite A being attached.
    attach_with(&mut ws_b, &terminal_id, "att-b-2", "transport_reconnect", 100, 50, None).await;
    wait_for_attach_ready(&mut ws_b, "att-b-2").await;
    assert_eq!(
        registry.geometry(&terminal_id),
        Some((100, 50, 3)),
        "re-attach by the same connection: apply and bump epoch"
    );
}
```

If the copied harness's connect helper has a different name/signature (e.g. it returns a tuple), adapt the call sites — keep the helper bodies verbatim otherwise.

- [ ] **Step 2: Run the integration tests to verify they fail**

Run: `cargo test -p freshell-ws --test attach_viewport_resize`
Expected: FAIL — `viewport_hydrate_attach_resizes_pty_to_attached_geometry` panics at the `Some((95, 41, 2))` assertion with actual `Some((120, 30, 1))` (geometry untouched), and `transport_reconnect_...` fails the same way. `mismatched_expected_session_ref_does_not_resize` may already pass (it asserts the status quo) — that is fine; it pins the guard against regression.

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
Expected: everything green — in particular the pre-existing `term09_output_queue`, `session_identity_frames`, `codex_session_ref_resume`, and `pane_reconcile` integration tests (they attach with `viewport_hydrate` 80x24; their terminals will now actually resize to 80x24, which none of them assert against — if one fails, read its assertion before touching anything and fix forward within these semantics).

- [ ] **Step 7: Commit**

```bash
git add crates/freshell-ws/src/terminal.rs crates/freshell-ws/tests/attach_viewport_resize.rs
git commit -m "fix(rust): apply attach-time viewport geometry before replay (TERM-07 geometry parity)"
```

---

### Task 4: Checklist annotation + full verification pass

**Files:**
- Modify: `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md:221-222`

**Interfaces:**
- Consumes: the completed Tasks 1-3.
- Produces: nothing code-level; documentation + final green verification.

- [ ] **Step 1: Annotate TERM-07 (do NOT tick the box)**

TERM-07 covers intent, priority, replay budget, geometry, and request correlation; this fix delivers only the geometry/intent portion (`priority` and `maxReplayBytes` are still dropped by `handle_attach`), so the item is not fully satisfied and the checkbox stays unchecked. The current item at lines 221-222 reads:

```
- [ ] **TERM-07 — Honor attach intent, priority, replay budget, geometry, and request correlation.** Implement viewport hydration, keepalive delta, transport reconnect, foreground/background policy, `maxReplayBytes`, rows/columns, and `attachRequestId`.
  - **Playwright validation (`PW-RUST`):** Parameterize every intent with unique request IDs, two sizes/priorities, and small replay budget; assert correlated replies/effective sequence, foreground size ownership, background nonresize, reconnect geometry, and bounded suffix plus gap notice.
```

Insert a progress sub-bullet directly under the first line (between it and the Playwright bullet):

```
  - **2026-07-24 partial:** attach-time geometry now applied — `registry.resize_for_attach()` replicates Node's `shouldResize` intent condition + `resizeIfSessionMatches` identity guard before attach/replay (see `docs/plans/2026-07-24-rust-attach-viewport.md`; covered by `crates/freshell-ws/tests/attach_viewport_resize.rs`). Still open: `priority` policy and `maxReplayBytes`.
```

- [ ] **Step 2: Full verification pass**

Run each and confirm:

```bash
cargo test -p freshell-terminal        # expected: all pass
cargo test -p freshell-ws              # expected: all pass
cargo fmt --all --check                # expected: no diff
cargo clippy -p freshell-terminal -p freshell-ws --all-targets -- -D warnings   # expected: clean
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

## Self-Review (performed at plan-writing time)

**Spec coverage:**
1. *Resize before attach/replay, `viewport_hydrate` + Node's exact `transport_reconnect` condition* → Task 2 (condition, verbatim from `broker.ts:358-362`, incl. `existingAttachment`) + Task 3 (ordering: before `registry.attach`, hence before ready/replay).
2. *Session identity like `resizeIfSessionMatches`* → Task 3 guard (`attach_geometry_identity_ok`), mismatch = no mutation; Node's additional detach-and-fail is explicitly documented as out of scope in the Context section (it is broker attach-failure semantics, not `resizeIfSessionMatches` semantics; Rust attach has no failure channel today and the spec's required test is "mismatched session ref does not resize").
3. *Geometry epoch/authority consistency* → Task 2 reuses the existing bump-only-on-change epoch model; ordering guarantees `attach.ready` stamps post-resize values; authority analysis in Context explains why no stored-authority change is needed. Epoch assertions in unit + integration tests.
4. *TDD with a failing test asserting ACTUAL PTY geometry* → Task 3 Step 1 test 1 uses `stty size` inside the PTY (kernel ground truth), red before the fix; all four spec-listed cases covered (hydrate applies; reconnect conditional both ways; mismatch no-resize; epoch bumps).
5. *Run relevant suites / repo checks* → Task 3 Step 6 + Task 4 Step 2 (cargo test both crates, fmt, clippy; JS gate not required for Rust-only diff, with a verification command).
6. *TERM-07 tick/annotate* → Task 4 annotates without ticking (item not fully satisfied — priority/maxReplayBytes remain).
7. *No client / Node server changes; never restart server; no PR* → Global Constraints.

**No silent deferrals:** the acceptance outcome (PTY actual size equals attached geometry via the Rust server, no client changes) is proven by a real end-to-end test (real WS server, real shell PTY, `stty size`) — no stubs or mocks stand in for it. The two consciously-excluded behaviors (attach-abort on identity mismatch; `priority`/`maxReplayBytes`) are not required by this spec and are recorded loudly (Context section; unchecked TERM-07 with annotation), not silently dropped.

**Placeholder scan:** every code step contains complete code; harness reuse instructions name exact source files, functions, and line anchors rather than "similar to". One deliberate non-test: the `NotRunning` branch (no seam exists; documented in Task 2 Step 3).

**Type consistency:** `geometry()` returns `Option<(u16, u16, i64)>` and every assertion uses `Some((u16, u16, i64))` literals; `resize_for_attach(&self, &str, u64, TerminalAttachIntent, u16, u16) -> AttachResizeStatus` matches all call sites (Task 2 tests, Task 3 `handle_attach`); `attach_geometry_identity_ok(Option<&SessionLocator>, Option<&SessionLocator>) -> bool` matches its tests and call site; `SessionLocator { provider: String, session_id: String }` matches the protocol struct.
