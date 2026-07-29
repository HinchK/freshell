# Silent Input Loss Across Server Restart (kata dtfn) Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Input typed across a server restart either ARRIVES (in order, byte-exact) or the user SEES that it didn't — never silent loss.

**Architecture:** Two-sided fix for a proven root cause. Server (Rust): `terminal.input` to an unknown terminalId currently vanishes into a pure no-op (`registry.rs:1148`) with no wire reply, and `terminal.attach` to an unknown id silently discards `AttachOutcome{found:false}` (`terminal.rs:3172-3180`) — both get wire replies (`terminal.input.blocked{reason:unknown_terminal}` and `error{INVALID_TERMINAL_ID}` respectively). Client (TS): the three loss windows (blind reconnect replay of queued input; keystrokes fired at the pre-restart id before staleness is detected; keystrokes silently dropped by `if (!tid) return` while un-anchored) are closed by filtering `terminal.input` out of the reconnect replay and buffering keystrokes in a bounded per-pane ring that flushes after the pane's next anchor (`terminal.created` / current-generation `terminal.attach.ready`), with a visible xterm notice on overflow/timeout/terminal-gone.

**Tech Stack:** Rust (axum/tokio, `freshell-ws`, `freshell-terminal`, `freshell-protocol`), TypeScript/React (`ws-client.ts`, `TerminalView.tsx`), Vitest, Playwright (rust-chromium project), frozen WS contract (`shared/ws-protocol.ts` → `npm run contract:generate` → `port/contract/*.json` → Rust pin tests).

The diagnosis in the kata is proven at the raw-WS protocol level. The RED tests in Tasks 3–5 double as the load-bearing verification of its claims (silence today); do not re-litigate the diagnosis.

## Global Constraints

- Worktree: `/home/dan/code/freshell/.worktrees/silent-input-loss`, branch `fix/silent-input-loss`, based on current `origin/main` (e28d0910 or newer — verify with `git fetch` in Task 1). ALL commands below run from the worktree root unless stated.
- NEVER use ports 3001/3002 (the user's LIVE server runs on 3002). The e2e fixture picks ephemeral ports itself and asserts `port !== 3001`; never override that.
- NEVER restart the user's server. NEVER use broad kill patterns (`pkill -f freshell` etc.). The e2e fixture kills only its own pid-verified processes.
- Coordinated test runs: check `npm run test:status` first; if another holder is active, WAIT (never kill a foreign holder). Full suite: `FRESHELL_TEST_SUMMARY="silent-input-loss: <what>" env -u FRESHELL_BIND_HOST npm test`. Single vitest files: `npm run test:vitest -- run --config config/vitest/vitest.config.ts <file>` (never raw `npx vitest`).
- Contract-change ritual (Task 2 only): edit `shared/ws-protocol.ts` → `npm run contract:generate` → commit the regenerated `port/contract/*.json` in the SAME commit as the Rust enum + TS client changes. This change adds a REASON, not a message type: inventory counts 29/57/86 are unchanged. `npm run test:port` and `cargo test -p freshell-protocol --locked` must be green in that commit.
- Gates before push: `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, coordinated `npm test`, `npm run test:port`, `npm run lint`, and the e2e specs listed in Task 11 (release server build happens via the Playwright globalSetup).
- PR POLICY: do NOT create a PR. Push the branch and stop.
- README.md is the only end-user markdown doc; this plan under `docs/plans/` is a working/agent doc (allowed). Do not create other new `.md` files.
- Red-Green-Refactor. One focused commit per task.
- Do NOT build on any scratch worktree from the investigation (`.worktrees/debug-dtfn` does not exist; nothing to reuse).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `shared/ws-protocol.ts:858-862` | Modify | Add `'unknown_terminal'` to the `terminal.input.blocked` reason union (single source of truth) |
| `port/contract/ws-server-messages.schema.json` | Regenerate | Frozen outbound schema (via `npm run contract:generate`; never hand-edit) |
| `port/contract/ws-protocol.schema.json`, `port/contract/ws-message-inventory.json` | Regenerate (no-op diff expected) | Same generator run; commit whatever it writes |
| `crates/freshell-protocol/src/server_messages.rs:260-269` | Modify | Add `UnknownTerminal` variant to `TerminalInputBlockedReason` |
| `crates/freshell-protocol/tests/roundtrip.rs` | Modify | Round-trip + frozen-schema conformance test for the new reason |
| `crates/freshell-terminal/src/registry.rs` | Modify | `input()` returns `InputOutcome{found}`; `#[must_use]` on `InputOutcome` and `AttachOutcome`; unit tests |
| `crates/freshell-freshagent/src/terminal_tabs.rs:1687` | Modify | Second `registry.input()` caller (REST send-keys): consume the outcome, warn on not-found |
| `crates/freshell-ws/src/terminal.rs` | Modify | `TerminalInput` arm emits `terminal.input.blocked{unknown_terminal}` on not-found; `handle_attach` returns the `error{INVALID_TERMINAL_ID}` frame on `found:false`; doc-comment fixes; pure-builder unit tests |
| `crates/freshell-ws/tests/unknown_terminal_reply.rs` | Create | WS integration tests: input→blocked frame; attach→error frame; live-input round-trip guard |
| `src/lib/ws-client.ts:294-296` | Modify | Filter `terminal.input` out of the blind reconnect replay |
| `test/unit/client/lib/ws-client.test.ts` | Modify | RED test for the replay filter |
| `src/components/TerminalView.tsx` | Modify | `unknown_terminal` notice string; pending-input ring buffer (gate in `sendInput`, flush on anchors, discard+notice on terminal states/overflow/timeout) |
| `test/unit/client/components/TerminalView.lifecycle.test.tsx` | Modify | Client tests: notice for `unknown_terminal`; buffer/flush byte-exact; overflow; timeout; exit-discard; attach-error recovery pin |
| `src/App.tsx` | Modify | Firewall-command effect: readiness-gated deferral (reactive `connection.status` dep + synchronous `isReady` check) |
| `test/unit/client/components/App.firewall-command.test.tsx` | Create | Pin: firewall command defers while un-ready, sends exactly once after ready |
| `test/e2e-browser/specs/silent-input-loss-rust.spec.ts` | Create | The discriminating e2e scenario as a spec |
| `test/e2e-browser/playwright.config.ts` | Modify | Register the new spec in `RUST_ONLY_SPECS` / rust-chromium `testMatch` |
| `test/e2e-browser/specs/harness-01-rust-server.spec.ts:197-240` | Modify | Replace the 3-attempt marker retry with a deterministic new-terminalId anchor wait |

Design invariants locked in here:

1. **The buffer lives in TerminalView, not ws-client.** ws-client has no pane concept (fields keyed only by `requestId`/`terminalId`); TerminalView knows the pane, the old/new tid, and the anchor events. ws-client's only change is dropping `terminal.input` from the blind replay (defense in depth — with the TerminalView gate, input should rarely reach `pendingMessages` at all). Validation (ledger A7) found two user-origin senders that bypass `sendInput`: the Shift+Enter raw `terminal.input` frame (`TerminalView.tsx:2126-2133`) and the firewall-command effect (`App.tsx:1497-1509`) — Task 7 folds the first through `sendInput` and defers the second on readiness (a reactive `connection.status` dependency plus the synchronous `isReady` check, Task 7 item 12) with its own pin test, so neither can be silently discarded by Task 6's filter.
2. **Buffer raw `data` strings, never pre-built messages.** `buildTerminalInputMessage` snapshots `expectedSessionRef` at build time (`terminal-view-utils.ts:56`); a stale snapshot flushed at the new terminal would draw `SESSION_IDENTITY_MISMATCH`. Rebuild each frame at flush time.
3. **Anchors that flush:** `terminal.created` for this pane's `requestId` (`TerminalView.tsx:4045`) and current-generation `terminal.attach.ready` for the current tid (`TerminalView.tsx:3838`, gated by `isCurrentAttachMessage`). **Terminal states that discard (with a visible notice):** `terminal.exit` (:4246), `failLaunch` (:3072), `settleCleanRestoreStartupExit` (:3101), `SESSION_IDENTITY_MISMATCH` (:4375 — identity change). **Recovery states that hold:** launch retry/redrive (:3158/:3240) and the INVALID_TERMINAL_ID recovery branches (:4577/:4639). **Flush placement (ledger A11):** in the `terminal.created` handler the flush runs AFTER the created `sessionRef` is folded into `contentRef` (:4046-4066), so rebuilt frames carry the NEW identity (flushing at :4045 would snapshot the pre-create ref — vacuous against the Rust server, which never reads `expected_session_ref` on input, but wrong for Node parity and future-proofing). **Notices must survive the anchor (ledger A15):** `attachTerminal` calls `term.clear()` on the restart path (:2581, forced by the checkpoint-invalid fallback :2545-2552) and `terminal.created` re-hydrates (:4106) — a loss notice written while un-anchored gets wiped; Task 7 therefore also RECORDS the notice and re-writes it after the next anchor's clear, using the same deferred-notice pattern the codebase already uses for `reconcileNotice` (:4110-4116, :4787-4791).
4. **`awaitingAnchor` closes loss window 2.** From the moment the connection leaves `'ready'` until the pane's next anchor, `sendInput` buffers even though `terminalIdRef` is still set — the old id is unverified and may be dead. This is what makes the e2e marker arrive byte-exact instead of half-blocked/half-flushed. The latch is set on an observed status TRANSITION away from `'ready'` (the sync effect compares against the previously observed status), never on the status VALUE alone: a pane that mounts under a static non-ready status has the synchronous `ws.isReady === false` arm (invariant 9) covering it while the transport is actually down, and initial-connect pre-anchor sends match pre-fix behavior, backstopped by Task 4's `unknown_terminal` reply and Task 5's attach error. (This also keeps the sibling TerminalView test suites — which preload constant statuses into their stores — out of the latch by construction.)
5. **Synthetic input is droppable, not bufferable.** DECRQM/OSC auto-replies and scroll-translation answer the OLD terminal's output; replaying them into a NEW pty would inject garbage. Those call sites pass `{ droppable: true }` and are silently dropped when not immediately sendable (their pre-fix behavior). The droppable set is THREE call sites (ledger A13): the DECRQM/OSC reply path (:1598), scroll translation (:1169), AND the request-mode bypass responder (:1884 → `request-mode-bypass.ts:256`), which emits synthetic DECRPM reports — buffering those would flush mode-report garbage into the new pty. Residual (accepted): xterm.js-core auto-replies (DA/CPR) enter `onData` indistinguishably from keystrokes; while un-anchored the dead terminal produces no output to answer, so exposure is negligible, and post-anchor replay-triggered replies are pre-existing behavior untouched by this plan.
6. **The attach error must carry `requestId: attachRequestId` + `terminalId`** — the client's acceptance gate (`TerminalView.tsx:4442-4451`) requires both to match the current attach generation. Message text `"Terminal not running"` for Node parity (`server/ws-handler.ts:2730-2735`).
7. **Attach-error blast radius (studied per call site before enabling the error):** all eleven attach call sites funnel into the single INVALID_TERMINAL_ID handler (`TerminalView.tsx:4442-4661`). Verdicts: transport_reconnect (:4727) → branch-5 recovery, desirable (this is the TS-server behavior the Rust port lost); hidden rebind (:2786/:2793) and reveal (:2762) → safe (branch 5 while hidden re-enters background hydration); `terminal.created` attach (:4106) → bounded launch-retry ladder, safe; refresh (:2708), attach.ready re-attaches (:3903/:3938), load-more (:4922) → safe; quarantine-repair re-attach (`attachTerminalRef.current?.(...)` at :884, surfaced by validation — ledger A4) → safe (its poll gate :868-878 self-cancels and every recovery branch runs `clearQuarantineRepair`); reconcile-verdict attach (:4777) → highest risk (branch 5 mints a new createRequestId after a just-folded verdict) — but the error only fires when the server genuinely lacks the terminal, in which case recreating is correct. No flow depends on silence; none needs restructuring. Task 8 pins the recovery path in a unit test; Task 11 re-runs the hidden-pane-rebind and reconcile e2e specs as the regression wall.
8. **Exited-but-still-registered terminals keep `found:true`** (registry `attach` synthesizes `terminal.exit`; registry `input` still bumps activity). Only ids absent from the registry (never created, or killed/removed, or pre-restart) are `found:false`. (Deliberate divergence, ledger A22: the Node reference ALSO errors on attach to exited-but-registered terminals (`ws-handler.ts:2738+`); the Rust port keeps registry semantics — `found:true` + synthetic exit — and only the unknown-id case errors.)
9. **The send gate reads transport readiness synchronously (ledger A8).** `WebSocket.onclose` flips the ws client's `_state` synchronously (`ws-client.ts:504`) but the Redux→React status refs lag at least a task; a keystroke in that gap would pass a ref-only gate, land in `pendingMessages`, and be silently discarded by Task 6's filter — NEW loss on a mere transport blip (pre-fix, that frame was actually delivered). `sendInput`'s gate therefore consults the client's synchronous `isReady` getter (`ws-client.ts:389`) as its ONLY transport arm, written `ws.isReady === false` — deliberate on both counts. No direct Redux-status arm: production statuses are `'disconnected' | 'connecting' | 'ready'` (`'connected'` is a WsClient-internal state, never dispatched to the store), and whenever the socket is genuinely down `isReady` is already false, so a status arm adds nothing in production while breaking the component test fleet (four sibling TerminalView suites preload a constant `'connected'` into their stores; the Redux status instead feeds the transition-latched `awaitingAnchorRef`, invariant 4). The `=== false` comparison: none of the seven TerminalView suites that assert sent `terminal.input` frames put `isReady` on their minimal ws mocks (`{ send, connect, onMessage, onReconnect }`), so an absent getter must read as ready — in production the getter always returns a boolean, making `=== false` exactly `!ws.isReady`. Task 7 pins the race with a close-race test constructed so the `isReady` arm is the ONLY arm that can buffer.
10. **Input capture and notice visibility above the buffer (ledger A2, A14).** (a) The `status:'creating'` blocking overlay (:5011) gets `pointer-events-none` — it is `absolute inset-0`, and a mid-window click would blur xterm and silently kill `onData` delivery (the e2e's exact click-then-type gesture; loss ABOVE the buffer layer). (b) The `terminal.input.blocked` handler matches `terminalIdRef.current` only, and the recovery paths clear that ref (:3158/:3240) — a backstop frame for the just-dead id would be silently dropped; Task 7 keeps a `lastKnownTerminalIdRef` (set whenever the pane gets a defined tid, NOT cleared by recovery) and the blocked handler also matches it.

---

### Task 1: Workspace baseline (deps + base-green)

**Files:**
- No source changes. No commit (unless `node_modules/tsx` symlink work leaves nothing to commit anyway — it is gitignored).

**Interfaces:**
- Consumes: fresh worktree at `origin/main`.
- Produces: a workspace where `npm test`, `cargo test`, and Playwright can run; confirmed-green baseline.

- [ ] **Step 1: Confirm base is current origin/main**

```bash
cd /home/dan/code/freshell/.worktrees/silent-input-loss
git fetch origin
git log --oneline -1 origin/main
git log --oneline -1 HEAD
git merge-base --is-ancestor origin/main HEAD && echo BASE-OK || echo BASE-STALE
```

Expected: `BASE-OK` — `origin/main` (e28d0910 or newer) is an ancestor of HEAD. HEAD will NOT equal origin/main: the branch already carries the plan-doc commits, and that is fine. If `BASE-STALE` (origin/main has moved past this branch's base): `git merge origin/main` (a plain merge, NOT `--ff-only` — the branch has its own commits, so fast-forward is impossible), resolve any conflicts, and re-run the ancestor check before proceeding.

- [ ] **Step 2: Install node deps + tsx symlink (worktree quirk)**

```bash
ls node_modules/tsx >/dev/null 2>&1 && echo TSX-OK || { npm ci && ln -s ../node_modules/tsx node_modules/tsx 2>/dev/null; echo TSX-FIXED; }
node_modules/.bin/vitest --version
```

Expected: both commands succeed. The symlink matters: the Rust `freshell-ws` MCP injector spawns `node --import <repoRoot>/node_modules/tsx/...`; without it, ~14 `cargo test -p freshell-ws` PTY-spawn tests fail for one environmental reason.

- [ ] **Step 3: Baseline Rust tests for the crates this plan touches**

```bash
cargo test -p freshell-protocol --locked
cargo test -p freshell-terminal
cargo test -p freshell-ws
```

Expected: all green. (Use a generous timeout; `freshell-ws` spawns real PTYs.)

- [ ] **Step 4: Baseline coordinated JS suite**

```bash
npm run test:status   # WAIT if another holder is active
FRESHELL_TEST_SUMMARY="silent-input-loss: baseline before any changes" env -u FRESHELL_BIND_HOST npm test
```

Expected: green. If the baseline is red, STOP and report — do not build on a red base.

---

### Task 2: Protocol contract extension — `unknown_terminal` input-blocked reason

**Files:**
- Modify: `shared/ws-protocol.ts:858-862`
- Regenerate: `port/contract/ws-server-messages.schema.json` (+ the other two artifacts, expected no-op)
- Modify: `crates/freshell-protocol/src/server_messages.rs:260-269`
- Modify: `crates/freshell-protocol/tests/roundtrip.rs` (new test)
- Modify: `src/components/TerminalView.tsx:287-309` (local reason union + switch arm)
- Test: `crates/freshell-protocol/tests/roundtrip.rs`, `test/unit/client/components/TerminalView.lifecycle.test.tsx`, `npm run test:port`

**Interfaces:**
- Consumes: existing `TerminalInputBlocked { reason: TerminalInputBlockedReason, terminal_id: String }` (`server_messages.rs:971-976`), wire shape `{"type":"terminal.input.blocked","reason":"<snake_case>","terminalId":"<id>"}`.
- Produces: `TerminalInputBlockedReason::UnknownTerminal` (wire `"unknown_terminal"`) for Task 4's emitter; client notice copy `'Input not sent: the terminal no longer exists on the server.'` rendered by the existing `terminal.input.blocked` handler (`TerminalView.tsx:4329-4344`).

- [ ] **Step 1: Write the failing Rust round-trip test**

Append to `crates/freshell-protocol/tests/roundtrip.rs` (it already has the `server_roundtrip(wire, type_name)` helper that validates against the frozen schema and panics `FIDELITY GAP` on nonconformance):

```rust
#[test]
fn terminal_input_blocked_unknown_terminal_roundtrips_and_conforms() {
    // Silent-loss fix (kata dtfn): the first Rust emitter of
    // `terminal.input.blocked` uses this reason for input to an unknown id.
    let wire = r#"{"type":"terminal.input.blocked","reason":"unknown_terminal","terminalId":"t1"}"#;
    match server_roundtrip(wire, "terminal.input.blocked") {
        ServerMessage::TerminalInputBlocked(b) => {
            assert_eq!(b.reason, TerminalInputBlockedReason::UnknownTerminal);
            assert_eq!(b.terminal_id, "t1");
        }
        other => panic!("expected TerminalInputBlocked, got {other:?}"),
    }
}
```

Add `TerminalInputBlockedReason` to the file's existing `use freshell_protocol::{...}` import list.

- [ ] **Step 2: Run it to verify it fails**

```bash
cargo test -p freshell-protocol --locked terminal_input_blocked_unknown_terminal
```

Expected: FAIL — first a compile error (`UnknownTerminal` not found); after Step 3's Rust-enum half, a `FIDELITY GAP` panic until the frozen schema is regenerated in Step 4. Both failure shapes are the RED we want.

- [ ] **Step 3: Add the variant on both sides of the contract**

`crates/freshell-protocol/src/server_messages.rs:260-269` — append the variant:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalInputBlockedReason {
    CodexIdentityPending,
    CodexIdentityCaptureTimeout,
    CodexIdentityUnavailable,
    CodexRecoveryPending,
    CodexCleanExitDecisionPending,
    CodexLifecycleLossPending,
    /// Silent-loss fix (kata dtfn): `terminal.input` named a terminalId the
    /// registry does not have (never created, killed, or pre-restart). The
    /// reference answers `error{INVALID_TERMINAL_ID}` (`ws-handler.ts:2991-3002`);
    /// the port uses this richer frame, which the client already renders as a
    /// visible xterm notice.
    UnknownTerminal,
}
```

`shared/ws-protocol.ts:858-862` — extend the inline union:

```ts
export type TerminalInputBlockedMessage = {
  type: 'terminal.input.blocked'
  terminalId: string
  reason: 'codex_identity_pending' | 'codex_identity_capture_timeout' | 'codex_identity_unavailable' | 'codex_recovery_pending' | 'codex_clean_exit_decision_pending' | 'codex_lifecycle_loss_pending' | 'unknown_terminal'
}
```

- [ ] **Step 4: Regenerate the frozen contract**

```bash
npm run contract:generate
git diff --stat -- port/contract
```

Expected: `ws-server-messages.schema.json` changes (the `reason` enum gains `"unknown_terminal"`); the other two files unchanged or whitespace-stable. Never hand-edit these JSONs.

- [ ] **Step 5: Widen the client's local reason union + exhaustive switch**

`src/components/TerminalView.tsx:287-309`. The local `TerminalInputBlockedReason` type duplicates the wire union — add `| 'unknown_terminal'` to it, and add the arm to the closed switch:

```ts
function terminalInputBlockedNotice(reason: TerminalInputBlockedReason): string {
  switch (reason) {
    case 'codex_identity_pending':
      return 'Input not sent: Codex is still saving restore state. Try again in a moment.'
    case 'codex_recovery_pending':
      return 'Input not sent: Codex is still reconnecting. Try again in a moment.'
    case 'codex_clean_exit_decision_pending':
      return 'Input not sent: Codex is checking whether the session is still active. Try again in a moment.'
    case 'codex_lifecycle_loss_pending':
      return 'Input not sent: Codex is resolving a worker disconnect. Try again in a moment.'
    case 'codex_identity_capture_timeout':
      return 'Input not sent: Codex did not provide restore state before startup timed out. Start a new Codex pane or resume inside Codex.'
    case 'codex_identity_unavailable':
      return 'Input not sent: Codex did not provide restorable session state. Start a new Codex pane or resume inside Codex.'
    case 'unknown_terminal':
      return 'Input not sent: the terminal no longer exists on the server.'
  }
}
```

- [ ] **Step 6: Write the client notice test**

In `test/unit/client/components/TerminalView.lifecycle.test.tsx`, next to the existing `'shows feedback when Codex input is blocked by the restore identity gate'` test (~:3033), add (same setup helpers — `setupThemeTerminal`, `messageHandler`, `terminalInstances`, `expectTerminalWriteContaining` are already in this file):

```ts
  it('shows feedback when input is blocked because the terminal no longer exists', async () => {
    const { store, tabId, paneId, paneContent } = setupThemeTerminal({
      terminalId: 'term-gone',
      status: 'running',
      mode: 'shell',
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
      expect(terminalInstances.length).toBeGreaterThan(0)
    })

    act(() => {
      messageHandler!({
        type: 'terminal.input.blocked',
        terminalId: 'term-gone',
        reason: 'unknown_terminal',
      })
    })

    const term = terminalInstances[0]
    expectTerminalWriteContaining(term, 'Input not sent: the terminal no longer exists on the server.')
  })
```

- [ ] **Step 7: Run everything this contract change gates**

```bash
cargo test -p freshell-protocol --locked
npm run test:port
npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/components/TerminalView.lifecycle.test.tsx
npm run typecheck
```

Expected: all PASS. (`ws contract freeze` tests pass because the committed JSON now matches a fresh regeneration; inventory counts 29/57/86 are untouched — a reason is not a message type. `ZOD_BACKED_SERVER_MESSAGES` is a test-side cross-check list in `test/unit/port/ws-contract-freeze.test.ts:21` — not a generator input; `terminal.input.blocked` is not in it, so it stays untouched — ledger A3.)

- [ ] **Step 8: Commit (one atomic contract commit — TS source + regenerated JSON + Rust enum + tests + client copy together)**

```bash
git add shared/ws-protocol.ts port/contract crates/freshell-protocol src/components/TerminalView.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "feat(protocol): add unknown_terminal terminal.input.blocked reason (kata dtfn)"
```

---

### Task 3: Registry — `input()` reports found/not-found

**Files:**
- Modify: `crates/freshell-terminal/src/registry.rs` (struct near :586, `input()` at :1131-1160, existing tests at :3697-3711/:4019/:4077)
- Modify: `crates/freshell-ws/src/terminal.rs:633-635` (transitional `let _ =`)
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs:1687`
- Test: `crates/freshell-terminal/src/registry.rs` unit tests

**Interfaces:**
- Consumes: existing `AttachOutcome { pub found: bool }` (`registry.rs:586-592`) as the shape precedent; test helpers `insert_headless`, `collector` (`registry.rs:2695-2768`).
- Produces: `pub struct InputOutcome { pub found: bool }` (`#[must_use]`, derives `Debug, Clone, Copy, PartialEq, Eq`) and `pub fn input(&self, terminal_id: &str, data: &[u8]) -> InputOutcome`. Task 4 branches on `.found`; the freshagent caller warns on `!found`.

- [ ] **Step 1: Write the failing unit tests**

In the registry test module (next to `attach_to_unknown_terminal_reports_not_found` at `registry.rs:3010`):

```rust
    #[test]
    fn input_to_unknown_terminal_reports_not_found() {
        // Silent-loss fix (kata dtfn): the None branch used to be a pure no-op.
        let reg = TerminalRegistry::new();
        let out = reg.input("nope", b"lost bytes");
        assert!(!out.found);
    }

    #[test]
    fn input_to_headless_terminal_reports_found() {
        // Headless => no PTY write, but the terminal EXISTS: found must be true
        // (the activity bump in input_write_resets_the_idle_reap_clock depends
        // on headless input still counting).
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let out = reg.input("T", b"ls\n");
        assert!(out.found);
    }
```

- [ ] **Step 2: Run to verify failure**

```bash
cargo test -p freshell-terminal input_to_unknown_terminal_reports_not_found
```

Expected: FAIL to compile (`input()` returns `()`, no `.found`). Compile-failure is the RED here.

- [ ] **Step 3: Implement `InputOutcome` and the new return**

Add next to `AttachOutcome` (`registry.rs` ~:594):

```rust
/// Outcome of [`TerminalRegistry::input`]: whether the terminal existed (the
/// bytes were written to its PTY when one is attached; headless terminals
/// still count as found and take the activity bump). `false` mirrors the
/// reference's unknown-id input reply (`server/ws-handler.ts:2991-3002`) —
/// the WS layer answers `terminal.input.blocked{reason:unknown_terminal}`,
/// the REST send-keys path logs a warning.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[must_use]
pub struct InputOutcome {
    pub found: bool,
}
```

Replace `input()` (`registry.rs:1131-1160`) with (note the doc comment loses its now-false trailing `No wire reply.`, and the overloaded `None => false` is disentangled into `(found, tapped_mode)`):

```rust
    /// `terminal.input` write path (`terminal-registry.ts:3867-3894`): write bytes to
    /// the PTY; bump `lastActivityAt` and the DEV-0009 meaningful-activity reap clock.
    /// Unknown terminal => `InputOutcome { found: false }` (kata dtfn: previously a
    /// silent no-op; the caller now replies on the wire).
    pub fn input(&self, terminal_id: &str, data: &[u8]) -> InputOutcome {
        let (found, tapped_mode) = {
            let mut inner = self.inner.lock().expect("registry lock");
            match inner.terminals.get_mut(terminal_id) {
                Some(handle) => {
                    if let Some(pty) = handle.pty.as_mut() {
                        let _ = pty.write_input(data);
                    } else {
                        // Headless rows have no PTY to receive bytes. Unreachable in
                        // production today (`register_headless` has no production
                        // callers — ledger A16), but never let input vanish without
                        // a trace (kata dtfn).
                        tracing::warn!(terminal_id, "input_to_headless_terminal_dropped");
                    }
                    let mut s = handle.shared.lock().expect("terminal lock");
                    let now = now_ms();
                    s.last_activity_at = now;
                    // User keystrokes are always meaningful (DEV-0009).
                    s.last_meaningful_activity_at = now;
                    (true, s.mode != "shell")
                }
                None => (false, false),
            }
        };
        // TERM-15/TERM-16 tap (outside the registry lock): CLI-mode input
        // feeds submit detection. Shell terminals skip it entirely.
        if tapped_mode {
            self.notify_activity(ActivityEvent::Input {
                terminal_id: terminal_id.to_string(),
                data: String::from_utf8_lossy(data).into_owned(),
                at: now_ms(),
            });
        }
        InputOutcome { found }
    }
```

If `InputOutcome` is not automatically re-exported, mirror however `AttachOutcome` is exported from the crate (check `crates/freshell-terminal/src/lib.rs` — add `InputOutcome` beside `AttachOutcome` in the same `pub use`).

- [ ] **Step 4: Update every caller (the `#[must_use]` will point at them)**

1. `crates/freshell-ws/src/terminal.rs:633-635` — transitional until Task 4 branches on it:

```rust
            // Outcome consumed for real in the next commit (kata dtfn):
            let _ = state
                .registry
                .input(&input.terminal_id, input.data.as_bytes());
```

2. `crates/freshell-freshagent/src/terminal_tabs.rs:1687` — the REST agent-API send-keys path (adapt the variable names to the surrounding code, which calls `registry.input(&terminal_id, text.as_bytes());` in statement position):

```rust
        let outcome = registry.input(&terminal_id, text.as_bytes());
        if !outcome.found {
            tracing::warn!(terminal_id = %terminal_id, "send_keys_to_unknown_terminal");
        }
```

3. Existing registry tests at `registry.rs:3698` (`reg.input("T", b"ls\n");`), `:4019` (`reg.input("T-act", b"\r");`), `:4077` (`reg.input("T-shell", b"\r");`) — make each assert the outcome, e.g. `assert!(reg.input("T", b"ls\n").found);`.

- [ ] **Step 5: Run tests + workspace compile**

```bash
cargo test -p freshell-terminal
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: both new tests PASS, all existing registry tests PASS, clippy clean (no unused-`must_use` warnings anywhere).

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-terminal crates/freshell-ws/src/terminal.rs crates/freshell-freshagent
git commit -m "refactor(terminal): registry input() reports found/not-found (kata dtfn)"
```

---

### Task 4: WS server — unknown-id `terminal.input` answers `terminal.input.blocked`

**Files:**
- Modify: `crates/freshell-ws/src/terminal.rs` (module doc :17, `TerminalInput` arm :622-654, imports :61-66, new pure builder + unit test)
- Create: `crates/freshell-ws/tests/unknown_terminal_reply.rs`
- Test: both of the above

**Interfaces:**
- Consumes: `InputOutcome` from Task 3; `TerminalInputBlockedReason::UnknownTerminal` from Task 2; `send(ws_tx, &msg).await -> bool` (`terminal.rs:75`); WS test harness `spawn_server`, `connect_and_capture_inventory`, `create_shell_terminal`, `attach_with`, `wait_for_attach_ready`, `send_input`, `next_frame_of_type`, `drain_until_marker_or_deadline` (`crates/freshell-ws/tests/common/mod.rs`).
- Produces: wire behavior — `terminal.input` for an unknown id draws `{"type":"terminal.input.blocked","reason":"unknown_terminal","terminalId":<id>}` on the same socket; pure `fn unknown_terminal_input_blocked(terminal_id: &str) -> ServerMessage` (unit-tested builder).

- [ ] **Step 1: Write the failing WS integration test**

Create `crates/freshell-ws/tests/unknown_terminal_reply.rs`:

```rust
//! Silent-loss fix (kata dtfn): `terminal.input` / `terminal.attach` against an
//! unknown terminalId must answer on the wire instead of silently no-oping.
//! These tests drive a REAL axum server + REAL tokio-tungstenite client.

mod common;
use common::*;

use std::time::Duration;

#[tokio::test]
async fn input_to_unknown_terminal_answers_input_blocked() {
    let (url, _registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    send_input(&mut ws, "no-such-terminal", "echo lost\r").await;

    let frame = next_frame_of_type(&mut ws, "terminal.input.blocked").await;
    assert_eq!(frame["reason"], serde_json::json!("unknown_terminal"));
    assert_eq!(frame["terminalId"], serde_json::json!("no-such-terminal"));
}

#[tokio::test]
async fn input_to_live_terminal_round_trips_without_a_blocked_frame() {
    // Guard: the fix adds NO ack on the happy path -- output is the only reply.
    let (url, _registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;
    let terminal_id = create_shell_terminal(&mut ws, "req-dtfn-ok").await;
    attach_with(&mut ws, &terminal_id, "att-dtfn-ok", "viewport_hydrate", 120, 30, None).await;
    wait_for_attach_ready(&mut ws, "att-dtfn-ok").await;

    send_input(&mut ws, &terminal_id, "echo __DTFN__alive__\r").await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    let (acc, _gap, _closed) =
        drain_until_marker_or_deadline(&mut ws, "__DTFN__alive__", deadline).await;
    assert!(
        acc.contains("__DTFN__alive__"),
        "live input must still round-trip; got output: {acc}"
    );
}
```

(If the compiler flags unused imports, drop them — mirror `attach_viewport_resize.rs`'s import set.)

- [ ] **Step 2: Run to verify the RED**

```bash
cargo test -p freshell-ws --test unknown_terminal_reply
```

Expected: `input_to_unknown_terminal_answers_input_blocked` FAILS with `no terminal.input.blocked frame within 20 messages` / timeout — this is the wire-level proof of the diagnosed silence. The round-trip test PASSES.

- [ ] **Step 3: Implement the emitter**

In `crates/freshell-ws/src/terminal.rs`:

1. Extend the `freshell_protocol` import at :61-66 with `TerminalInputBlocked, TerminalInputBlockedReason`.
2. Update the module doc line :17 from `//! terminal.input   -> registry.input()  (pty.write; no wire reply)` to `//! terminal.input   -> registry.input()  (pty.write; terminal.input.blocked{unknown_terminal} on unknown id)`.
3. Add the pure builder next to `invalid_dims_error` (~:3213), same testable-pure-fn pattern:

```rust
/// The `terminal.input.blocked{reason:unknown_terminal}` frame for a
/// `terminal.input` whose terminalId is not in the registry (kata dtfn: this
/// used to be TOTAL SILENCE). The reference answers
/// `error{INVALID_TERMINAL_ID,'Terminal not running'}` (`ws-handler.ts:2991-3002`);
/// the port uses the richer input-blocked frame the client already renders as
/// a visible xterm notice (`TerminalView.tsx` terminalInputBlockedNotice).
fn unknown_terminal_input_blocked(terminal_id: &str) -> ServerMessage {
    ServerMessage::TerminalInputBlocked(TerminalInputBlocked {
        reason: TerminalInputBlockedReason::UnknownTerminal,
        terminal_id: terminal_id.to_string(),
    })
}
```

4. Rewrite the `TerminalInput` arm (:622-654). Keep the existing Lane-B2 comment and the codex `note_possible_submit` await exactly where they are (the codex seam must still run before the write); branch on the outcome; run the amplifier/opencode seams only on the found path (both are documented no-ops for unknown terminals anyway):

```rust
        ClientMessage::TerminalInput(input) => {
            // Lane B2: MUST complete before the Enter reaches the PTY — the
            // codex locator's FIRST-submit re-snapshot has to finish before
            // codex can materialize the rollout this very Enter triggers
            // (else the pane's own file could land in the snapshot and be
            // permanently excluded). Sound here: this socket task processes
            // frames sequentially, and the enclosing handler is already
            // async. Non-submit data returns immediately; only the first
            // Enter of an armed codex pane scans (7-9 ms warm — A6).
            crate::codex_association::note_possible_submit(state, &input.terminal_id, &input.data)
                .await;
            let outcome = state
                .registry
                .input(&input.terminal_id, input.data.as_bytes());
            if !outcome.found {
                // Silent-loss fix (kata dtfn): an unknown terminalId used to
                // produce TOTAL SILENCE — no error, no ack — so keystrokes
                // racing a server restart vanished. Answer with the
                // input-blocked frame the client renders as a visible notice.
                return send(ws_tx, &unknown_terminal_input_blocked(&input.terminal_id)).await;
            }
            // Restore-across-restart fix: an armed amplifier terminal's first
            // Enter/submit opens the locator's Enter↔session-dir correlation
            // window. No-ops for every other terminal/mode (never armed) and
            // for non-submit-shaped input.
            crate::amplifier_association::note_possible_submit(
                state,
                &input.terminal_id,
                &input.data,
            );
            // Restore-across-restart fix (opencode): sibling seam for an
            // armed opencode terminal's first Enter/submit. No-ops for every
            // other terminal/mode and for non-submit-shaped input.
            crate::opencode_association::note_possible_submit(
                state,
                &input.terminal_id,
                &input.data,
            );
            true
        }
```

5. Add the builder unit test to the existing `#[cfg(test)]` module that holds `invalid_dims_error_serializes_as_invalid_message` (~:4534-4569):

```rust
    /// Kata dtfn: the unknown-id input reply serializes to the exact frozen
    /// wire shape the client's input-blocked handler consumes.
    #[test]
    fn unknown_terminal_input_blocked_serializes_the_wire_shape() {
        let msg = unknown_terminal_input_blocked("t-gone");
        let json = serde_json::to_value(&msg).expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({
                "type": "terminal.input.blocked",
                "reason": "unknown_terminal",
                "terminalId": "t-gone",
            })
        );
    }
```

- [ ] **Step 4: Run to verify GREEN**

```bash
cargo test -p freshell-ws --test unknown_terminal_reply
cargo test -p freshell-ws unknown_terminal_input_blocked_serializes_the_wire_shape
cargo test -p freshell-ws
```

Expected: all PASS (the full `-p freshell-ws` run guards the arm rewrite against the 33 existing integration binaries).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws
git commit -m "fix(server): answer terminal.input.blocked for input to an unknown terminal (kata dtfn)"
```

---

### Task 5: WS server — unknown-id `terminal.attach` answers `error{INVALID_TERMINAL_ID}`

**Files:**
- Modify: `crates/freshell-ws/src/terminal.rs` (`handle_attach` :3135-3181, its call site :614-621)
- Modify: `crates/freshell-terminal/src/registry.rs` (`#[must_use]` on `AttachOutcome`, doc comment)
- Modify: `crates/freshell-ws/tests/unknown_terminal_reply.rs` (new test)
- Test: same files

**Interfaces:**
- Consumes: `AttachOutcome{found}` (already returned by `registry.attach`, currently discarded); `ErrorMsg`/`ErrorCode::InvalidTerminalId` construction pattern from `handle_kill` (`terminal.rs:3289-3300`); `crate::now_iso()`.
- Produces: `fn handle_attach(...) -> Option<ServerMessage>` (None = attached; Some = the error frame for the async call site to `send`). Wire behavior: attach to an unknown id draws `error{code:"INVALID_TERMINAL_ID", message:"Terminal not running", requestId:<attachRequestId>, terminalId:<id>}`. Exited-but-registered terminals still return `found:true` + synthetic `terminal.exit` (unchanged).

- [ ] **Step 1: Write the failing WS integration test**

Append to `crates/freshell-ws/tests/unknown_terminal_reply.rs`:

```rust
#[tokio::test]
async fn attach_to_unknown_terminal_answers_invalid_terminal_id() {
    let (url, _registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    attach_with(
        &mut ws,
        "no-such-terminal",
        "att-dtfn-unknown",
        "transport_reconnect",
        120,
        30,
        None,
    )
    .await;

    let frame = next_frame_of_type(&mut ws, "error").await;
    assert_eq!(frame["code"], serde_json::json!("INVALID_TERMINAL_ID"));
    assert_eq!(frame["terminalId"], serde_json::json!("no-such-terminal"));
    // The client's attach-error acceptance gate (TerminalView.tsx:4442-4451)
    // requires requestId === the attach generation's attachRequestId.
    assert_eq!(frame["requestId"], serde_json::json!("att-dtfn-unknown"));
    assert_eq!(frame["message"], serde_json::json!("Terminal not running"));
}
```

- [ ] **Step 2: Run to verify the RED**

```bash
cargo test -p freshell-ws --test unknown_terminal_reply attach_to_unknown_terminal_answers_invalid_terminal_id
```

Expected: FAIL with `no error frame within 20 messages` / timeout — the second wire-level silence proof.

- [ ] **Step 3: Implement — return the frame from `handle_attach`, send at the async call site**

This mirrors the repo's `kill_and_broadcast`/`handle_kill` split (sync core returns, async half sends). In `crates/freshell-ws/src/terminal.rs`:

1. `handle_attach` (:3135-3181): change the signature and tail. Keep the body (identity stamp, TERM-07 resize, registry.attach call) unchanged except for consuming the outcome; fix the doc-comment parenthetical at :3140 which documents behavior the port had lost:

```rust
/// `terminal.attach` — resolve the terminal in the shared registry and attach THIS
/// connection to it: the registry enqueues `terminal.attach.ready`, replays the
/// scrollback (seq-ordered, stamped with this attach's id + `source:'replay'`), and
/// registers the connection so live output fans out — all onto `conn_sink`, which
/// the select loop drains to the socket. Attaching to an unknown terminal returns
/// the reference's `error{INVALID_TERMINAL_ID, "Terminal not running"}` frame for
/// the caller to send (`ws-handler.ts:2730-2735`; restored by kata dtfn — the SPA's
/// recovery ladder recreates the pane). `None` = attached.
fn handle_attach(
    attach: TerminalAttach,
    state: &WsState,
    conn_id: u64,
    conn_sink: &FrameSink,
    terminal_output_batch_v1: bool,
) -> Option<ServerMessage> {
```

and replace the final `state.registry.attach(...)` statement (:3172-3180) with:

```rust
    let outcome = state.registry.attach(
        &attach.terminal_id,
        conn_id,
        Arc::clone(conn_sink),
        attach.attach_request_id.clone(),
        attach.since_seq.unwrap_or(0),
        terminal_output_batch_v1,
        canonical_session_ref,
    );
    if outcome.found {
        return None;
    }
    // Kata dtfn: `AttachOutcome{found:false}` was silently discarded here,
    // wedging any attach against an unknown id (stale pre-restart id, typo'd
    // id, raced kill+attach). Restore the documented INVALID_TERMINAL_ID
    // parity; requestId = attachRequestId so the client's attach-generation
    // gate accepts it (attachRequestIds live in the `pane:N:nanoid` namespace,
    // never colliding with createRequestIds — see ws-client's
    // clearTrackedCreate-on-error behavior).
    Some(ServerMessage::Error(ErrorMsg {
        code: ErrorCode::InvalidTerminalId,
        message: "Terminal not running".to_string(),
        timestamp: crate::now_iso(),
        actual_session_ref: None,
        expected_session_ref: None,
        request_id: attach.attach_request_id,
        retry_after_ms: None,
        terminal_id: Some(attach.terminal_id),
        terminal_exit_code: None,
    }))
}
```

2. The call site (:614-621):

```rust
        ClientMessage::TerminalAttach(attach) => {
            if terminal_dims_in_range(attach.cols, attach.rows) {
                match handle_attach(attach, state, conn_id, conn_sink, terminal_output_batch_v1) {
                    Some(err) => send(ws_tx, &err).await,
                    None => true,
                }
            } else {
                send(ws_tx, &invalid_dims_error(attach.cols, attach.rows)).await
            }
        }
```

3. `crates/freshell-terminal/src/registry.rs` — add `#[must_use]` to `AttachOutcome` (:586-592) so the discard can never silently return (the compiler now guards the invariant this task restores):

```rust
/// Outcome of an [`TerminalRegistry::attach`]: whether the terminal existed (the
/// `attach.ready` + replay were enqueued to the caller's sink) — `false` draws the
/// reference's `INVALID_TERMINAL_ID` reply (attach to an unknown terminal; an
/// exited-but-still-registered terminal is `found: true` + a synthetic exit).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[must_use]
pub struct AttachOutcome {
    pub found: bool,
}
```

If clippy flags any other statement-position `attach(...)` call (tests), consume it with an assertion (`assert!(reg.attach(...).found);`) — the existing `attach_to_unknown_terminal_reports_not_found` test at :3011 already binds it.

- [ ] **Step 4: Run to verify GREEN**

```bash
cargo test -p freshell-ws --test unknown_terminal_reply
cargo test -p freshell-ws
cargo test -p freshell-terminal
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: all PASS. Pay attention to the existing attach-flow integration binaries (`attach_viewport_resize`, `term09_output_queue`, …) — they attach to LIVE terminals and must be unaffected.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws crates/freshell-terminal
git commit -m "fix(server): answer INVALID_TERMINAL_ID for attach to an unknown terminal (kata dtfn)"
```

---

### Task 6: Client — drop queued `terminal.input` from the blind reconnect replay

**Files:**
- Modify: `src/lib/ws-client.ts:294-296`
- Test: `test/unit/client/lib/ws-client.test.ts`

**Interfaces:**
- Consumes: existing guards `isTerminalInputMessage` (`ws-client.ts:83`) and `isTerminalAttachMessage` (:99); the replay block in `handleIncomingMessage`'s ready arm (:294-322).
- Produces: on reconnect, `pendingMessages` replay excludes BOTH `terminal.attach` and `terminal.input`. TerminalView (Task 7) owns delivering buffered input after re-anchor; this filter is the belt-and-braces guard against input that slipped into the ws queue.

- [ ] **Step 1: Write the failing test**

In `test/unit/client/lib/ws-client.test.ts`, inside the same `describe` that holds `'drops queued terminal.attach messages on reconnect so recovery only attaches once'` (:426), add:

```ts
  it('drops queued terminal.input on reconnect instead of replaying it against a stale terminalId', async () => {
    const c = new WsClient('ws://example/ws')

    const p1 = c.connect()
    MockWebSocket.instances[0]._open()
    MockWebSocket.instances[0]._message({ type: 'ready' })
    await p1
    MockWebSocket.instances[0]._close(1006, 'server restart')

    // Typed while the socket was down: the old terminalId is baked in and the
    // restarted server has never heard of it -- replaying is silent loss.
    c.send({ type: 'terminal.input', terminalId: 'term-old', data: 'echo lost\r' })

    const p2 = c.connect()
    MockWebSocket.instances[1]._open()
    MockWebSocket.instances[1]._message({ type: 'ready' })
    await p2

    const inputs = MockWebSocket.instances[1].sent
      .map((x) => JSON.parse(x))
      .filter((m) => m.type === 'terminal.input')
    expect(inputs).toEqual([])
  })
```

- [ ] **Step 2: Run to verify failure**

```bash
npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/lib/ws-client.test.ts -t 'drops queued terminal.input on reconnect'
```

Expected: FAIL — the input IS replayed today (`inputs` has one entry).

- [ ] **Step 3: Implement the filter**

`src/lib/ws-client.ts:294-296` — extend the existing reconnect filter:

```ts
      // Reconnect replay must not blind-fire terminal.attach (recovery
      // re-attaches deliberately) NOR terminal.input (kata dtfn: the queued
      // frames carry the PRE-restart terminalId; the server answers
      // terminal.input.blocked{unknown_terminal} at best, and the bytes are
      // gone. TerminalView buffers un-anchored keystrokes and flushes them
      // after the pane's next anchor instead).
      const pendingMessages = isReconnect
        ? this.pendingMessages.filter(
            (queued) => !isTerminalAttachMessage(queued) && !isTerminalInputMessage(queued),
          )
        : this.pendingMessages
```

Safety note (ledger A8): this filter is loss-free ONLY because Task 7's `sendInput` gate also consults the ws client's synchronous `isReady` (design invariant 9) — user input can no longer reach `pendingMessages` in the gap between the socket's close event and the Redux status propagation. Task 7 Step 1 pins that race.

- [ ] **Step 4: Run to verify pass (whole file — the neighboring queue/replay tests must stay green)**

```bash
npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/lib/ws-client.test.ts
```

Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ws-client.ts test/unit/client/lib/ws-client.test.ts
git commit -m "fix(client): never blind-replay queued terminal.input on reconnect (kata dtfn)"
```

---

### Task 7: Client — buffered queue-until-anchored input in TerminalView

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/App.tsx` (item 12 — firewall-command deferral)
- Test: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Test (create): `test/unit/client/components/App.firewall-command.test.tsx` (item 12's pin)

**Interfaces:**
- Consumes: `terminalIdRef`, `contentRef`, `termRef`, `writeLocalXtermNotice(term, data)` (:977-1021), `buildTerminalInputMessage(content, terminalId, data)` (`terminal-view-utils.ts:46`), the `connectionStatus` value TerminalView already selects from Redux (`state.connection.status`, selected at :546 near the top of the component body, feeding `showInlineOfflineStatus` at :4932 — reuse that binding, do not add a second selector), `INPUT_BLOCKED_NOTICE_THROTTLE_MS`, anchor handlers `terminal.created` (:3998-4115) and `terminal.attach.ready` (:3838, `isCurrentAttachMessage`-gated), terminal-state sites `failLaunch` (:3072), `settleCleanRestoreStartupExit` (:3101), `terminal.exit` (:4227-4248), `SESSION_IDENTITY_MISMATCH` (:4366-4382).
- Produces: `sendInput(data: string, opts?: { droppable?: boolean })` — same callback identity/usage for all existing callers (the second arg is optional); internal helpers `bufferPendingInput(data)`, `flushPendingInput(tid)`, `discardPendingInput(reason)`, `notifyPendingInputLoss(reason)`; ref `awaitingAnchorRef`. Task 8's test and the e2e spec rely on: keystrokes buffered while un-anchored flush IN ORDER, one `terminal.input` frame per buffered chunk, against the flush-time tid.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/client/components/TerminalView.lifecycle.test.tsx`. First, a typing seam: the suite mocks `@xterm/xterm` wholesale and collects instances in `terminalInstances`; keystrokes enter via the `term.onData(handler)` registration. Locate the existing Terminal mock at the top of the file and confirm how `onData` is recorded (it is a `vi.fn()` on the mocked instance); then add this helper next to the other file-local helpers, adapting the accessor to the mock's actual shape if it differs:

```ts
function fireData(term: any, data: string) {
  const handler = term.onData.mock.calls.at(-1)?.[0]
  expect(handler, 'xterm onData handler must be registered').toBeTruthy()
  act(() => handler(data))
}
```

Then the tests (all use the file's existing `setupThemeTerminal`, `messageHandler`, `sentMessages`, `terminalInstances`, `expectTerminalWriteContaining`):

```ts
  it('buffers keystrokes typed while un-anchored and flushes them byte-exact after terminal.created', async () => {
    // Pane mid-recreate: no terminalId yet (the old silent-drop window).
    const { store, tabId, paneId, paneContent } = setupThemeTerminal({
      terminalId: undefined,
      status: 'creating',
      mode: 'shell',
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
      expect(terminalInstances.length).toBeGreaterThan(0)
    })
    const term = terminalInstances[0]

    fireData(term, 'echo dtfn-')
    fireData(term, 'marker')
    fireData(term, '\r')

    // Nothing sent yet -- buffered, not dropped, not fired at a stale id.
    expect(sentMessages().filter((m) => m?.type === 'terminal.input')).toEqual([])

    // The pane anchors: terminal.created with this pane's createRequestId.
    const createMsg = sentMessages().find((m) => m?.type === 'terminal.create')
    expect(createMsg).toBeTruthy()
    act(() => {
      messageHandler!({
        type: 'terminal.created',
        requestId: createMsg.requestId,
        terminalId: 'term-new',
      })
    })

    const inputs = sentMessages().filter(
      (m) => m?.type === 'terminal.input' && m.terminalId === 'term-new',
    )
    expect(inputs.map((m) => m.data)).toEqual(['echo dtfn-', 'marker', '\r'])
  })

  it('surfaces a visible notice when the pending-input buffer overflows', async () => {
    const { store, tabId, paneId, paneContent } = setupThemeTerminal({
      terminalId: undefined,
      status: 'creating',
      mode: 'shell',
    })
    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )
    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
      expect(terminalInstances.length).toBeGreaterThan(0)
    })
    const term = terminalInstances[0]

    for (let i = 0; i < 257; i++) fireData(term, 'x') // cap is 256 chunks

    expectTerminalWriteContaining(term, 'too much was typed while the terminal was reconnecting')
    expect(sentMessages().filter((m) => m?.type === 'terminal.input')).toEqual([])
  })

  it('surfaces a visible notice when buffered input times out un-anchored', async () => {
    const { store, tabId, paneId, paneContent } = setupThemeTerminal({
      terminalId: undefined,
      status: 'creating',
      mode: 'shell',
    })
    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )
    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
      expect(terminalInstances.length).toBeGreaterThan(0)
    })
    const term = terminalInstances[0]

    vi.useFakeTimers()
    try {
      fireData(term, 'doomed keystrokes')
      act(() => {
        vi.advanceTimersByTime(30_001)
      })
      expectTerminalWriteContaining(term, 'the terminal did not reconnect in time')
    } finally {
      vi.useRealTimers()
    }
  })

  it('discards buffered input with a visible notice when the terminal exits', async () => {
    const { store, tabId, paneId, paneContent } = setupThemeTerminal({
      terminalId: 'term-exiting',
      status: 'running',
      mode: 'shell',
    })
    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )
    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
      expect(terminalInstances.length).toBeGreaterThan(0)
    })
    const term = terminalInstances[0]

    // Force the send gate to BUFFER while terminalIdRef is STILL SET: drop
    // the mock's synchronous `isReady` (the same controllable seam the
    // close-race test below adds to the suite's ws mock). Buffering before
    // the exit is what makes the exit-discard path observable -- an exit
    // sent first would clear the tid and a later duplicate exit is swallowed
    // by the handler's `msg.terminalId === tid` gate.
    setWsIsReady(false)
    fireData(term, 'typed at a corpse')
    // RED pre-fix on THIS assertion too: pre-fix sendInput sends whenever
    // tid is set, so a terminal.input frame appears here before the fix.
    expect(sentMessages().filter((m) => m?.type === 'terminal.input')).toEqual([])

    // terminal.exit for the still-set tid passes the handler's
    // `msg.terminalId === tid` gate and hits the discard site (Step 3
    // item 8): discardPendingInput('terminal_gone') drops the buffer and
    // writes the visible notice (design invariant 3).
    act(() => {
      messageHandler!({ type: 'terminal.exit', terminalId: 'term-exiting', exitCode: 0 })
    })
    expectTerminalWriteContaining(term, 'Input not sent')
    expect(sentMessages().filter((m) => m?.type === 'terminal.input')).toEqual([])
  })
```

Note on the last test: it pins the exit-discard path NON-vacuously — the notice assertion (`'Input not sent'`, the shared prefix of every loss notice) fails pre-fix, and the no-frames assertion fails pre-fix as well because pre-fix `sendInput` sends whenever tid is set. Do NOT drive the discard with a duplicate `terminal.exit` after the tid is cleared (the `msg.terminalId === tid` gate swallows it — the discard never fires and the test would pass vacuously), and do NOT substitute the fake-timer timeout (that pins the timeout notice, a different path already covered by the previous test). The contract being pinned: **typed-at-a-corpse bytes are never sent and never silently vanish — the exit-state discard itself surfaces the notice.**

Two more RED tests (validation findings — ledger A8, A15):

```ts
  it('buffers keystrokes when the socket is already closed but the status ref still says ready (close race)', async () => {
    // Ledger A8: onclose flips WsClient._state synchronously; Redux/refs lag a
    // task. A keystroke in that gap must BUFFER, not enter ws-client's
    // pendingMessages (where the Task 6 filter would silently discard it).
    // Seam: the suite's ws mock must expose a controllable synchronous
    // `isReady` (add it to the mock, defaulting true, matching ws-client.ts:389).
    const { store, tabId, paneId, paneContent } = setupThemeTerminal({
      terminalId: 'term-live',
      status: 'running',
      mode: 'shell',
    })
    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )
    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
      expect(terminalInstances.length).toBeGreaterThan(0)
    })
    const term = terminalInstances[0]

    // Socket dead (the race window). Construction makes the isReady arm the
    // ONLY arm that can buffer here: terminalIdRef is set (so `!tid` is cold)
    // and the store's preloaded status is STATIC -- it never transitions, so
    // the sync effect never latches awaitingAnchorRef. Delete the
    // `ws.isReady === false` arm from the gate and this test fails (the frame
    // is sent). That is the pin for design invariant 9 / ledger A8.
    setWsIsReady(false) // however the mock exposes the control

    fireData(term, 'echo raced\r')
    expect(sentMessages().filter((m) => m?.type === 'terminal.input')).toEqual([])
  })

  it('re-writes the loss notice after the pane re-anchors (term.clear survival)', async () => {
    // Ledger A15: the anchor's term.clear()/re-hydrate wipes notices written
    // while un-anchored; the deferred re-write must land AFTER the anchor.
    const { store, tabId, paneId, paneContent } = setupThemeTerminal({
      terminalId: undefined,
      status: 'creating',
      mode: 'shell',
    })
    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )
    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
      expect(terminalInstances.length).toBeGreaterThan(0)
    })
    const term = terminalInstances[0]

    vi.useFakeTimers()
    try {
      fireData(term, 'doomed')
      act(() => {
        vi.advanceTimersByTime(30_001) // timeout -> immediate notice write
      })
      const writesBeforeAnchor = term.write.mock.calls.length

      const createMsg = sentMessages().find((m) => m?.type === 'terminal.create')
      act(() => {
        messageHandler!({
          type: 'terminal.created',
          requestId: createMsg.requestId,
          terminalId: 'term-new',
        })
      })
      // The notice is written AGAIN after the anchor (post-clear), so it
      // survives the hydrate wipe.
      const noticeWritesAfterAnchor = term.write.mock.calls
        .slice(writesBeforeAnchor)
        .filter((c: any[]) => String(c[0]).includes('did not reconnect in time'))
      expect(noticeWritesAfterAnchor.length).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })
```

(Adapt `setWsIsReady` and the `term.write.mock` accessor to the suite's actual mock shapes — the contracts asserted are exact: race-window keystrokes buffer instead of entering the ws queue; loss notices are re-written after the anchor's clear.)

- [ ] **Step 2: Run to verify failure**

```bash
npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/components/TerminalView.lifecycle.test.tsx -t 'buffers keystrokes typed while un-anchored'
```

Expected: FAIL — today `sendInput`'s `if (!tid) return` drops the keystrokes; after the anchor, `inputs` is `[]`.

- [ ] **Step 3: Implement the buffer**

All in `src/components/TerminalView.tsx`.

1. Module-level constants, next to `INPUT_BLOCKED_NOTICE_THROTTLE_MS` and `terminalInputBlockedNotice` (~:287):

```ts
// Silent-loss fix (kata dtfn): bounds for the per-pane pending-input buffer.
// Small on purpose -- this holds human keystrokes across a reconnect window,
// not bulk pastes of arbitrary size.
const PENDING_INPUT_MAX_CHUNKS = 256
const PENDING_INPUT_MAX_BYTES = 16 * 1024
const PENDING_INPUT_TIMEOUT_MS = 30_000

type PendingInputLossReason = 'overflow' | 'timeout' | 'terminal_gone'

const PENDING_INPUT_LOSS_NOTICE: Record<PendingInputLossReason, string> = {
  overflow:
    'Input not sent: too much was typed while the terminal was reconnecting. Retype it once the prompt is back.',
  timeout:
    'Input not sent: the terminal did not reconnect in time. Retype it once the prompt is back.',
  terminal_gone: 'Input not sent: the terminal went away before it could be delivered.',
}
```

2. Refs, next to `lastInputBlockedNoticeRef` (~:669):

```ts
  // Kata dtfn: keystrokes typed while the pane is un-anchored (no terminalId,
  // transport not ready, or post-disconnect before the next anchor) are held
  // here and flushed IN ORDER after the pane's next anchor. Raw data strings
  // only -- frames are re-built at flush time so expectedSessionRef reflects
  // the flush-time content (terminal-view-utils.ts snapshots it at build time).
  const pendingInputRef = useRef<{
    chunks: string[]
    bytes: number
    timer: ReturnType<typeof setTimeout> | null
  }>({ chunks: [], bytes: 0, timer: null })
  const lastPendingInputNoticeRef = useRef<{ reason: string; at: number } | null>(null)
  // Ledger A15: a loss notice written while un-anchored is wiped by the next
  // anchor's term.clear()/re-hydrate. Record it here and re-write it after the
  // anchor (the reconcileNotice deferred pattern, :4110-4116).
  const pendingLossNoticeRef = useRef<string | null>(null)
  // Ledger A2: the terminal.input.blocked backstop must stay visible even when
  // the frame carries the pane's JUST-DEAD id (recovery clears terminalIdRef).
  // Set whenever the pane acquires a defined tid; never cleared by recovery.
  const lastKnownTerminalIdRef = useRef<string | undefined>(undefined)
  // True from any observed connection-status TRANSITION away from 'ready'
  // until the pane's next anchor: the current terminalId is unverified (the
  // server may have restarted) and input must buffer rather than fire at a
  // possibly-dead id. Transition-latched, NOT value-latched: a pane mounted
  // under a static non-ready status must not latch (while the transport is
  // actually down, the gate's synchronous `ws.isReady === false` arm buffers),
  // and the sibling TerminalView suites preload constant statuses.
  const awaitingAnchorRef = useRef(false)
  // Previous observed status for the transition detection; seeded with the
  // mount-time value so the sync effect's first run can never latch.
  const connectionStatusRef = useRef<string>(connectionStatus)
```

3. Sync effect. TerminalView already selects the connection status from Redux at :546, near the top of the component body (it feeds `showInlineOfflineStatus` at :4932) — the refs above and this effect both sit below it, so reuse that `connectionStatus` binding; no new selector is needed:

```ts
  useEffect(() => {
    const prev = connectionStatusRef.current
    connectionStatusRef.current = connectionStatus
    if (connectionStatus !== 'ready' && prev !== connectionStatus) {
      // Kata dtfn: a TRANSITION away from 'ready' (production statuses:
      // 'disconnected' | 'connecting' | 'ready') is a transport loss -- the
      // pane's terminalId is unverified until the next anchor
      // (terminal.created / current-generation attach.ready). The status
      // VALUE alone never latches: the ref is seeded with the mount-time
      // status, so the first run is a no-op by construction (see the ref
      // comment; design invariants 4 and 9).
      awaitingAnchorRef.current = true
    }
  }, [connectionStatus])
```

4. Helpers, defined after `writeLocalXtermNotice` (:1021) and before `sendInput`:

```ts
  const notifyPendingInputLoss = useCallback((reason: PendingInputLossReason) => {
    log.warn('pending_input_dropped', { tabId, paneId: paneIdRef.current, reason })
    const now = Date.now()
    const previous = lastPendingInputNoticeRef.current
    if (previous && previous.reason === reason && now - previous.at < INPUT_BLOCKED_NOTICE_THROTTLE_MS) {
      return
    }
    lastPendingInputNoticeRef.current = { reason, at: now }
    // Write NOW for immediate feedback, and RECORD for a post-anchor re-write:
    // the next anchor's term.clear()/re-hydrate would otherwise wipe it
    // (ledger A15; design invariant 3).
    pendingLossNoticeRef.current = `\r\n[${PENDING_INPUT_LOSS_NOTICE[reason]}]\r\n`
    const term = termRef.current
    if (term) {
      writeLocalXtermNotice(term, pendingLossNoticeRef.current)
    }
  }, [tabId, writeLocalXtermNotice])

  const discardPendingInput = useCallback((reason: 'timeout' | 'terminal_gone') => {
    const buf = pendingInputRef.current
    if (buf.timer !== null) {
      clearTimeout(buf.timer)
      buf.timer = null
    }
    if (buf.chunks.length === 0) return
    buf.chunks = []
    buf.bytes = 0
    notifyPendingInputLoss(reason)
  }, [notifyPendingInputLoss])

  const bufferPendingInput = useCallback((data: string) => {
    const buf = pendingInputRef.current
    if (
      buf.chunks.length >= PENDING_INPUT_MAX_CHUNKS
      || buf.bytes + data.length > PENDING_INPUT_MAX_BYTES
    ) {
      // Overflow: refuse the NEW keystroke VISIBLY. Dropping the oldest would
      // be silent loss of already-accepted bytes -- the design goal is
      // "arrives byte-exact, or the user SEES that it didn't".
      notifyPendingInputLoss('overflow')
      return
    }
    buf.chunks.push(data)
    buf.bytes += data.length
    if (buf.timer === null) {
      buf.timer = setTimeout(() => {
        buf.timer = null
        discardPendingInput('timeout')
      }, PENDING_INPUT_TIMEOUT_MS)
    }
  }, [notifyPendingInputLoss, discardPendingInput])

  const flushPendingInput = useCallback((tid: string) => {
    awaitingAnchorRef.current = false
    const buf = pendingInputRef.current
    if (buf.timer !== null) {
      clearTimeout(buf.timer)
      buf.timer = null
    }
    if (buf.chunks.length === 0) return
    const chunks = buf.chunks
    buf.chunks = []
    buf.bytes = 0
    for (const data of chunks) {
      // One frame per buffered chunk, re-built at flush time (fresh
      // expectedSessionRef for the NEW terminal identity).
      ws.send(buildTerminalInputMessage(contentRef.current, tid, data))
    }
  }, [ws])
```

5. Replace `sendInput` (:1147-1154). Keep the existing attention-clearing comment above it:

```ts
  const sendInput = useCallback((data: string, opts?: { droppable?: boolean }) => {
    const tid = terminalIdRef.current
    // Ledger A8 / design invariant 9: the `ws.isReady` getter is the SYNCHRONOUS
    // transport truth -- the socket's close event flips it immediately, while
    // Redux-fed state lags a task. Without this arm, a keystroke in that gap
    // would land in ws-client's pendingMessages and be silently discarded by
    // Task 6's reconnect filter. `ws` here is the WsClient instance itself
    // (`const ws = useMemo(() => getWsClient(), [])`, :588) and `isReady` is
    // a GETTER (`get isReady()`, ws-client.ts:389) -- read it as a property,
    // never call it. The explicit `=== false` is deliberate: only a transport
    // KNOWN to be down buffers. In production it is exactly `!ws.isReady`
    // (the getter always returns a boolean); in the component test fleet it
    // keeps the sibling suites' minimal ws mocks ({ send, connect, onMessage,
    // onReconnect } -- no isReady) on their existing pass-through behavior.
    // There is intentionally NO direct Redux-status arm: the status feeds the
    // transition-latched awaitingAnchorRef instead (invariants 4 and 9).
    if (!tid || awaitingAnchorRef.current || ws.isReady === false) {
      if (opts?.droppable) {
        // Synthetic replies (DECRQM/OSC auto-answers, scroll translation)
        // answer the OLD terminal's output -- replaying them into a NEW pty
        // would inject garbage. Dropping them here is their pre-fix behavior.
        return
      }
      // Kata dtfn: never drop user keystrokes on the floor. Buffer until the
      // pane re-anchors; overflow/timeout surfaces a visible notice.
      bufferPendingInput(data)
      return
    }
    flushPendingInput(tid) // defensive ordering if a flush anchor raced us
    ws.send(buildTerminalInputMessage(contentRef.current, tid, data))
  }, [ws, bufferPendingInput, flushPendingInput])
```

6. Mark the synthetic call sites droppable — the DECRQM/OSC-52 reply path (:1598), the scroll-translation path (`translateScrollLinesToInput`, :1169), AND the request-mode bypass responder registration (:1884 → `request-mode-bypass.ts:256`, which emits synthetic DECRPM reports; ledger A13 — buffering it would flush mode-report garbage into the NEW pty) pass `{ droppable: true }` as the second argument. At the two direct-call sites (:1598, `translateScrollLinesToInput`) that is a literal second argument; at :1884 `sendInput` is passed as a function REFERENCE into `registerTerminalRequestModeBypass(term, sendInput, …)` — there is no argument position there, so pass a wrapper instead: `(d) => sendInput(d, { droppable: true })`. The user-input call sites (`term.onData` :2033, keybar/paste :1689, ESC :2103) stay as-is.

7. Flush at the anchors:
   - In the `terminal.created` handler, AFTER the created `sessionRef` is folded into `contentRef` (:4046-4066), not immediately at :4045: `flushPendingInput(newId)` (ledger A11 — rebuilt frames must snapshot the NEW identity; the Rust server ignores `expected_session_ref` on input, but flushing pre-fold would break Node parity and invariant 2's own rationale). Also set `lastKnownTerminalIdRef.current = newId` next to the tid assignment.
   - In the `terminal.attach.ready` handler (the `isCurrentAttachMessage`-gated arm starting :3838), after the attach is accepted for the current generation: `if (typeof msg.terminalId === 'string' && msg.terminalId === terminalIdRef.current) { lastKnownTerminalIdRef.current = msg.terminalId; flushPendingInput(msg.terminalId) }`.
   - At BOTH anchors, after the anchor's clear/hydrate has run (the same place `reconcileNotice` is written — :4110-4116 / :4787-4791 pattern): if `pendingLossNoticeRef.current` is set, `writeLocalXtermNotice(term, pendingLossNoticeRef.current)` and clear the ref (ledger A15 — the anchor's `term.clear()` wipes notices written while un-anchored).

8. Discard at the terminal states (each site already clears `terminalIdRef`):
   - `terminal.exit` handler (:4227-4248), next to `terminalIdRef.current = undefined`: `discardPendingInput('terminal_gone')`.
   - `failLaunch` (:3072 vicinity): `discardPendingInput('terminal_gone')`.
   - `settleCleanRestoreStartupExit` (:3101 vicinity): `discardPendingInput('terminal_gone')`.
   - `SESSION_IDENTITY_MISMATCH` handler (:4366-4382, identity change): `discardPendingInput('terminal_gone')`.
   - Recovery clears (:3158, :3240, :4577, :4639, :2977) get NO discard — the buffer holds for the next anchor.

9. Unmount hygiene: in the big effect's cleanup (where `unsubReconnect` etc. are disposed), clear the timer silently:

```ts
      const pendingBuf = pendingInputRef.current
      if (pendingBuf.timer !== null) {
        clearTimeout(pendingBuf.timer)
        pendingBuf.timer = null
      }
```

10. Add `flushPendingInput` / `discardPendingInput` to whichever effect dependency arrays the `react-hooks/exhaustive-deps` lint demands — all new callbacks are stable `useCallback`s, so this changes no behavior.

11. Fold the Shift+Enter raw sender through the gate (ledger A7): the raw `terminal.input` frame built at :2126-2133 bypasses `sendInput` entirely — replace it with a `sendInput(<same data>)` call so Shift+Enter input buffers like every other keystroke instead of being queued and silently discarded by Task 6's filter.

12. Gate the firewall-command sender (ledger A7): the effect at `App.tsx:1493-1509` sends a `terminal.input` frame and clears `pendingFirewallCommand` unconditionally — and `WsClient.send` can queue it un-ready or silently drop it (early return on `intentionalClose`, `ws-client.ts:674`; oldest-eviction at the queue cap, :717-722), after which the self-clear has already destroyed the only retry state. No buffering machinery needed — deferral via the existing pending state is sufficient — but the deferral needs a REACTIVE readiness signal. Three coordinated changes:

    - In `src/App.tsx`, add `const connectionStatus = useAppSelector((state) => state.connection.status)` next to the component's existing connection selector (`state.connection.lastError`, :177). App.tsx does not currently select the status, and the effect's deps `[pendingFirewallCommand, paneLayouts]` contain nothing reactive to readiness — gating on the non-reactive `ws.isReady` getter alone would strand the command forever (nothing re-fires the effect when readiness returns).
    - In the effect: before the `ws.send`, early-return — leaving `pendingFirewallCommand` SET — unless `connectionStatus === 'ready' && ws.isReady !== false` (`isReady` is a getter — property read, never a call; the synchronous check covers invariant 9's close race where Redux still says 'ready'). Append `connectionStatus` to the dependency array — THAT is the deferral mechanism: the status flip back to `'ready'` re-runs the effect and the still-pending command sends then. (Residual, accepted: if `isReady` alone is false while the status still reads 'ready', the send waits for the next status change; every disconnect/reconnect cycle produces one — App.tsx itself dispatches `setStatus` through 'disconnected'/'connecting'/'ready' at :1430-1457.)
    - Pin it in a NEW file `test/unit/client/components/App.firewall-command.test.tsx` (a new file, not `App.test.tsx` — the pin needs its own `SettingsView` mock and `vi.mock` is file-scoped). Clone the `App.test.tsx` harness preamble: the ws-client mock with the live `get isReady()` getter over mutable `wsState` (:41-65), the Sidebar stub whose 'Go settings' button drives `onNavigate('settings')` (:118-120), the `TabContent` stub (:135-137), and `createTestStore()`/`renderApp()` (:193-269 — real reducers + explicit `preloadedState`) — but REPLACE its `SettingsView` stub (which drops the `onFirewallTerminal` prop) with one that forwards it onto a button:

```tsx
vi.mock('@/components/SettingsView', () => ({
  default: ({ onFirewallTerminal }: { onFirewallTerminal?: (c: { tabId: string; command: string }) => void }) => (
    <button
      type="button"
      data-testid="fire-firewall"
      onClick={() => onFirewallTerminal?.({ tabId: 'tab-fw', command: 'sudo ufw allow 8022' })}
    >
      fire
    </button>
  ),
}))
```

    The RED test — fails pre-fix, because today the effect sends immediately regardless of readiness:

```tsx
  it('defers the firewall command while un-ready and sends it exactly once after ready', async () => {
    // createTestStore adjusted for this test: preload connection.status
    // 'connecting' (a real pre-ready production status) and keep
    // wsState.isReady = false; preload panes.layouts['tab-fw'] as a ROOT
    // LEAF with a terminalId -- the effect reads only paneLayouts[tabId]
    // (:1500-1502):
    //   { type: 'leaf', id: 'pane-fw', content: { kind: 'terminal',
    //     mode: 'shell', shell: 'system', createRequestId: 'req-fw',
    //     status: 'running', terminalId: 'term-fw' } }
    const store = createTestStore()
    renderApp(store)
    fireEvent.click(screen.getByTitle('Go settings'))
    // SettingsView is lazy (App.tsx:110) -- findBy waits out the Suspense.
    fireEvent.click(await screen.findByTestId('fire-firewall'))

    // Guard: the harness must actually be un-ready here.
    expect(store.getState().connection.status).not.toBe('ready')
    // RED pre-fix: today the effect has already sent, un-ready.
    expect(mockSend).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'terminal.input' }))

    act(() => {
      wsState.isReady = true
      store.dispatch(setStatus('ready')) // import { setStatus } from '@/store/connectionSlice'
    })
    await waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith({ type: 'terminal.input', terminalId: 'term-fw', data: 'sudo ufw allow 8022\n' })
    })
    expect(mockSend.mock.calls.filter((c) => c[0]?.type === 'terminal.input')).toHaveLength(1)
  })
```

    Plus a happy-path pin in the same file (preload status `'ready'` and `wsState.isReady = true` from the start → the frame sends immediately, exactly once). Adapt the store-preload plumbing to the cloned harness's actual shape; the contracts asserted are exact: no `terminal.input` frame before readiness, exactly one after.

13. Make the `status:'creating'` overlay click-transparent (ledger A14 / invariant 10a): add `pointer-events-none` to the absolute-inset overlay at :5011 so a mid-recreate click cannot blur xterm and kill `onData` delivery (loss above the buffer). The overlay is informational; it must not eat interaction.

14. Widen the `terminal.input.blocked` match (ledger A2 / invariant 10b): the handler at :4329 matches `msg.terminalId === terminalIdRef.current` only — extend it to also accept `msg.terminalId === lastKnownTerminalIdRef.current`, so the server backstop stays visible when the frame arrives for the pane's just-dead id after a recovery path cleared `terminalIdRef` (:3158/:3240).

- [ ] **Step 4: Run to verify GREEN (full file + full client-component sweep + lint + typecheck)**

```bash
npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/components/TerminalView.lifecycle.test.tsx
npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/components/App.firewall-command.test.tsx
npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/components
npm run lint
npm run typecheck
```

Expected: all PASS. The component sweep guards the `sendInput` signature change and the new effect deps against the other TerminalView suites — and it stays green BY CONSTRUCTION of the gate: the `ws.isReady === false` arm treats the sibling suites' isReady-less ws mocks (`{ send, connect, onMessage, onReconnect }`) as ready, and `awaitingAnchorRef` latches only on status TRANSITIONS, so the constant preloaded store fixtures (`'connected'` in keyboard :163/:215/:275, mobile-viewport :109, codex-identity :185; `'ready'` in osc52 :222, scroll-input-policy :166, touch-scroll-input-policy :155) never latch and their `terminal.input` send assertions keep passing.

- [ ] **Step 5: Commit**

```bash
git add src/components/TerminalView.tsx src/App.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/App.firewall-command.test.tsx
git commit -m "fix(client): buffer un-anchored keystrokes, flush after re-anchor, defer firewall command until ready (kata dtfn)"
```

---

### Task 8: Client — pin the attach-error recovery path end to end (unit)

**Files:**
- Test: `test/unit/client/components/TerminalView.lifecycle.test.tsx` (test-only task)

**Interfaces:**
- Consumes: Task 5's new attach-error frame shape; Task 7's buffer; the suite's `reconnectHandler`, `withCurrentAttachRequestId` + `latestAttachRequestIdByTerminal` machinery (this is how injected attach errors satisfy the acceptance gate `requestId === currentAttachRef.requestId && terminalId` match — reuse it, don't reinvent it).
- Produces: a regression pin that the newly-loud attach error routes into the EXISTING branch-5 recovery (new create, `status:'creating'`) and that keystrokes typed after the error flush to the recovered terminal — the full window-2→window-3 client story, guarding the waves A–D recovery flows (transport_reconnect re-attach, hidden rebind, reconcile attach) that now receive an error frame where silence existed.

- [ ] **Step 1: Write the test (it should pass immediately if Tasks 5–7 are correct — it is a pin, not a RED)**

```ts
  it('recovers from a post-restart attach error and delivers buffered keystrokes to the recreated terminal', async () => {
    const { store, tabId, paneId, paneContent } = setupThemeTerminal({
      terminalId: 'term-pre-restart',
      status: 'running',
      mode: 'shell',
    })
    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )
    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
      expect(reconnectHandler).not.toBeNull()
      expect(terminalInstances.length).toBeGreaterThan(0)
    })
    const term = terminalInstances[0]

    // Server restarted; transport reconnects; the pane re-attaches its OLD id.
    act(() => {
      reconnectHandler!()
    })
    const attach = sentMessages()
      .filter((m) => m?.type === 'terminal.attach' && m.terminalId === 'term-pre-restart')
      .at(-1)
    expect(attach).toBeTruthy()

    // The restarted Rust server now answers loudly (kata dtfn, Task 5).
    act(() => {
      messageHandler!({
        type: 'error',
        code: 'INVALID_TERMINAL_ID',
        message: 'Terminal not running',
        requestId: attach.attachRequestId,
        terminalId: 'term-pre-restart',
        timestamp: new Date().toISOString(),
      })
    })

    // Branch-5 recovery: pane re-creates (a fresh terminal.create goes out).
    const create = sentMessages().filter((m) => m?.type === 'terminal.create').at(-1)
    expect(create).toBeTruthy()

    // Keystrokes typed in the recovery window buffer (tid is cleared)...
    fireData(term, 'echo survived\r')
    expect(
      sentMessages().filter((m) => m?.type === 'terminal.input' && m.terminalId === 'term-pre-restart'),
    ).toEqual([])

    // ...and flush, in order, to the recreated terminal.
    act(() => {
      messageHandler!({
        type: 'terminal.created',
        requestId: create.requestId,
        terminalId: 'term-post-restart',
      })
    })
    const flushed = sentMessages().filter(
      (m) => m?.type === 'terminal.input' && m.terminalId === 'term-post-restart',
    )
    expect(flushed.map((m) => m.data)).toEqual(['echo survived\r'])
  })
```

If the injected error is swallowed, check the suite's `withCurrentAttachRequestId` wrapper first — it may rewrite `requestId` for you; align the injected frame with however the existing INVALID_TERMINAL_ID tests in this file inject theirs.

- [ ] **Step 2: Run it**

```bash
npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/components/TerminalView.lifecycle.test.tsx -t 'recovers from a post-restart attach error'
```

Expected: PASS. If it fails, the failure is a REAL defect in Tasks 5–7 (most likely: the attach error not passing the acceptance gate, or the flush anchor not firing) — fix the product code, not the test.

- [ ] **Step 3: Run the neighboring recovery suites (attach-error blast-radius guard)**

```bash
npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/components/TerminalView.hidden-rebind.test.tsx test/unit/client/components/TerminalView.launchRetry.test.tsx test/unit/client/components/TerminalView.verdict-wait.test.tsx test/unit/client/components/TerminalView.session-reserved.test.tsx
```

Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "test(client): pin attach-error recovery + buffered flush across restart (kata dtfn)"
```

---

### Task 9: E2E — the discriminating restart scenario as a spec

**Files:**
- Create: `test/e2e-browser/specs/silent-input-loss-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (spec registration)

**Interfaces:**
- Consumes: `RustServer` (owned release-binary fixture, ephemeral port, isolated HOME, `restart()` keeps home/port/token — verified, ledger A19), `TestHarness` (`getPaneLayout`, `getActiveTabId`, `getTerminalBuffer`), `TerminalHelper` (`terminal-helpers.ts`); the shared pane-picker helpers `openPanePicker` + `clickFirstVisibleShellOption` from `test/e2e-browser/helpers/pane-picker.ts` (verified to exist — ledger A19; compose these instead of copying harness-01's local fn).
- Produces: the binding production proof of the design goal: input typed at the reconnect-before-reattach moment arrives byte-exact after restart.

- [ ] **Step 1: Write the spec**

`test/e2e-browser/specs/silent-input-loss-rust.spec.ts`:

```ts
/**
 * Kata dtfn: typed input during the pane-recreate window after a server
 * restart was SILENTLY LOST (head-truncated commands). This spec types a
 * marker at the exact reconnect-before-reattach moment -- the discriminating
 * scenario from the diagnosis -- and asserts the FULL marker arrives
 * byte-for-byte in the recreated terminal. The client buffers un-anchored
 * keystrokes and flushes them after the pane's next anchor, so the design
 * guarantee here is ARRIVAL (the visible input-loss notice is the fallback
 * for overflow/timeout paths, covered by unit tests).
 */
import { randomUUID } from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { TerminalHelper } from '../helpers/terminal-helpers.js'

import { openPanePicker, clickFirstVisibleShellOption } from '../helpers/pane-picker.js'

async function selectFirstShellFromPicker(page: Page): Promise<void> {
  // Shared helpers (ledger A19); adapt to their actual signatures.
  await openPanePicker(page)
  await clickFirstVisibleShellOption(page)
}

async function waitForWsReady(page: Page, timeoutMs = 60_000): Promise<void> {
  await expect(async () => {
    const status = await page.evaluate(
      () => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState(),
    )
    expect(status).toBe('ready')
  }).toPass({ timeout: timeoutMs })
}

test.describe('silent input loss across restart (kata dtfn)', () => {
  test.setTimeout(180_000)

  test('input typed in the reconnect-before-reattach window arrives byte-exact', async ({ page }) => {
    const server = new RustServer({ verbose: false })
    const info = await server.start()
    expect(info.port).not.toBe(3001)
    expect(info.port).not.toBe(3002)

    try {
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      const terminal = new TerminalHelper(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await selectFirstShellFromPicker(page)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      const tabId = (await harness.getActiveTabId())!
      await expect
        .poll(async () => (await harness.getPaneLayout(tabId))?.content?.terminalId ?? null, {
          timeout: 20_000,
        })
        .not.toBeNull()
      const terminalIdBefore = (await harness.getPaneLayout(tabId))?.content?.terminalId as string

      // Prove the pane is live pre-restart.
      const preMarker = `DTFN-PRE-${randomUUID()}`
      await terminal.executeCommand(`echo ${preMarker}`)
      await terminal.waitForOutput(preMarker, { timeout: 20_000, terminalId: terminalIdBefore })

      // --- Restart, then type at the exact reconnect-before-reattach moment:
      // ws is ready again, but the pane has NOT re-anchored (old terminalId
      // is dead on the new server; no terminal.created yet).
      await server.restart()
      await waitForWsReady(page)

      const marker = `DTFN-POST-${randomUUID()}`
      await page.locator('.xterm').first().click()
      await page.keyboard.type(`echo ${marker}`)
      await page.keyboard.press('Enter')

      // Deterministic anchor wait: pane recreates with a NEW terminalId.
      // 60s, not 30s: post-restart recreate has documented slow-path history
      // under parallel-worker load (ledger A23; 402e3ed3 bumped waits to 60s).
      await expect
        .poll(async () => {
          const tid = (await harness.getPaneLayout(tabId))?.content?.terminalId ?? null
          return tid && tid !== terminalIdBefore ? tid : null
        }, { timeout: 60_000 })
        .not.toBeNull()
      const terminalIdAfter = (await harness.getPaneLayout(tabId))?.content?.terminalId as string

      // The buffered keystrokes flush after the anchor: the marker output
      // must appear -- and the ECHOED COMMAND LINE must be intact too (the
      // historical failure truncated the head: "command not found" from a
      // marker-uuid tail).
      await expect
        .poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalIdAfter)
          return typeof buffer === 'string' && buffer.includes(marker)
        }, { timeout: 60_000 })
        .toBe(true)
      const buffer = (await harness.getTerminalBuffer(terminalIdAfter)) ?? ''
      expect(buffer).toContain(`echo ${marker}`)
      expect(buffer).not.toContain('command not found')
    } finally {
      await server.stop()
    }
  })
})
```

Verify the pane-picker helpers' actual export names/signatures before use (ledger A19 confirmed `openPanePicker` + `clickFirstVisibleShellOption` exist in `helpers/pane-picker.ts`); the post-restart `.xterm` click is safe because Task 7 made the 'creating' overlay `pointer-events-none` (invariant 10a) — without that fix the click would blur xterm and the typed marker would never reach `onData`.

- [ ] **Step 2: Register the spec**

```bash
grep -n "RUST_ONLY_SPECS\|rust-chromium" test/e2e-browser/playwright.config.ts | head -20
```

Add `'silent-input-loss-rust.spec.ts'` to the `RUST_ONLY_SPECS` array (and to the rust-chromium project's `testMatch` list if that is maintained separately), matching how `hidden-pane-rebind-rust.spec.ts` is registered. Verify:

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium --list 2>/dev/null | grep silent-input-loss
```

Expected: the new test is listed.

- [ ] **Step 3: Run it**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium silent-input-loss-rust.spec.ts
```

Expected: PASS (globalSetup builds the client + release server; allow ~10 min on first run). If the marker is missing: check the timing assumption first — the `page.keyboard.type` must complete before the pane anchors for the test to be discriminating; if the pane anchors too fast on this machine, insert the typing BEFORE `waitForWsReady` returns (typing while the socket is down exercises the same buffer path and is strictly harder).

- [ ] **Step 4: Commit**

```bash
git add test/e2e-browser/specs/silent-input-loss-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): input typed across restart arrives byte-exact (kata dtfn)"
```

---

### Task 10: Replace the harness-01 retry loop with a deterministic anchor wait

**Files:**
- Modify: `test/e2e-browser/specs/harness-01-rust-server.spec.ts` (capture before :150; replace :197-240)

**Interfaces:**
- Consumes: the fixed product behavior (Tasks 4–7); the repo-canonical `expect.poll` new-terminalId pattern (`restore-contract-wall-rust.spec.ts:609-616`).
- Produces: harness-01 asserts the FIRST post-restart round-trip succeeds — the retry loop that papered over kata dtfn is gone.

- [ ] **Step 1: Capture the pre-restart terminalId**

Insert immediately BEFORE the `// --- (3) restart the SAME owned server ... ---` comment (line ~150):

```ts
        const tabId = (await harness.getActiveTabId())!
        const terminalIdBefore = (await harness.getPaneLayout(tabId))?.content?.terminalId as string
        expect(terminalIdBefore).toBeTruthy()
```

- [ ] **Step 2: Replace lines 197-240 (the DEFLAKE comment, the 3-attempt loop, and the `if (!roundTripped) throw` block)**

Keep the existing diagnostic `catch` block (lines 241-261) exactly as-is; the replacement re-uses it around a SINGLE attempt:

```ts
        // Deterministic post-restart gate (kata dtfn fix): wait for the pane
        // to re-anchor (new terminalId via terminal.created) before typing.
        // The former 3-attempt marker retry papered over silently-lost input
        // during the recreate window; with the buffered-input fix the FIRST
        // attempt must round-trip.
        const terminalIdAfter: string = await expect
          .poll(async () => {
            const tid = (await harness.getPaneLayout(tabId))?.content?.terminalId ?? null
            return tid && tid !== terminalIdBefore ? tid : null
          }, { timeout: 30_000 })
          .not.toBeNull()
          .then(async () => (await harness.getPaneLayout(tabId))?.content?.terminalId as string)

        const marker2 = `HARNESS01-POST-RESTART-${randomUUID()}`
        try {
          await terminal.executeCommand(`echo ${marker2}`)
          await terminal.waitForOutput(marker2, { timeout: 30_000, terminalId: terminalIdAfter })
```

(The explicit `terminalId: terminalIdAfter` matters: with no id, `waitForOutput` reads the FIRST registered buffer, which can be the stale pre-restart one.) Confirm nothing after line 261 references the deleted `roundTripped` / `attemptErrors` bindings (`grep -n 'roundTripped\|attemptErrors' test/e2e-browser/specs/harness-01-rust-server.spec.ts` → no hits).

- [ ] **Step 3: Run harness-01**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium harness-01-rust-server.spec.ts
```

Expected: PASS on the first post-restart attempt.

- [ ] **Step 4: Commit**

```bash
git add test/e2e-browser/specs/harness-01-rust-server.spec.ts
git commit -m "test(e2e): deterministic post-restart anchor wait replaces harness-01 retry loop (kata dtfn)"
```

---

### Task 11: Full gates, regression wall, push (no PR)

**Files:**
- No planned source changes (fix-forward commits only if a gate fails).

**Interfaces:**
- Consumes: everything above.
- Produces: a pushed `fix/silent-input-loss` branch with all gates green. NO PR — landing happens outside this workflow.

- [ ] **Step 1: Rust gates**

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Expected: all green. (Long: the workspace test run spawns real PTYs.)

- [ ] **Step 2: Contract + JS gates**

```bash
npm run test:port
npm run lint
npm run test:status   # WAIT if a holder is active
FRESHELL_TEST_SUMMARY="silent-input-loss: full suite after kata dtfn fix" env -u FRESHELL_BIND_HOST npm test
```

Expected: all green. `test:port` re-proves the frozen contract (no pin changes beyond Task 2's committed regen).

- [ ] **Step 3: E2E regression wall (release build via globalSetup; ephemeral ports only — never 3001/3002)**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium \
  silent-input-loss-rust.spec.ts \
  harness-01-rust-server.spec.ts \
  restore-contract-wall-rust.spec.ts \
  hidden-pane-rebind-rust.spec.ts \
  reconcile-client-adoption-rust.spec.ts \
  reconcile-completion-rust.spec.ts \
  reconcile-handshake-rust.spec.ts
```

Expected: all PASS. `restore-contract-wall-rust` pins the per-pane restore contracts (no pin changes expected); `hidden-pane-rebind` + the reconcile trio are the attach-error behavior-change risk surface (design invariant 7). If a reconcile spec fails on a duplicate create/attach round after the new attach error, the fix belongs in the affected client flow (per the spec: fix THAT flow rather than restoring the silent sink) — treat it as a real defect, diagnose against the branch-5/verdict interaction documented in Task 8, and commit the fix with its own red-first test.

- [ ] **Step 4: Push the branch and STOP (no PR)**

```bash
git log --oneline origin/main..HEAD
git push -u origin fix/silent-input-loss
```

Expected: the task-by-task commit ladder from this plan; push succeeds. Do NOT open a PR.

---

## Self-Review (performed while writing; recorded for the plan reviewer)

**1. Spec coverage.**
- Server input silence (`terminal.rs:622-654` + `registry.rs:1148`) → Tasks 3–4.
- Adjacent attach regression (`registry.rs:971-988` outcome discarded at `terminal.rs:3172-3180`; stale parity doc at :3140/:588) → Task 5 (incl. doc fixes).
- Contract ritual for the new `unknown_terminal` reason (TS source + regen + BOTH pins in one commit; `test:port` green) → Task 2.
- Client loss window 1 (blind replay of queued input, `ws-client.ts:294-302`) → Task 6 (filter) + Task 7 (buffer catches what would have queued).
- Client loss window 2 (keystrokes at the old id before staleness detection) → Task 7's `awaitingAnchorRef` (buffers from transport loss until the next anchor) + the server's `unknown_terminal` reply as the wire-level backstop for any frame that still reaches a dead id.
- Client loss window 3 (`if (!tid) return`) → Task 7's buffer, flushed at `terminal.created`/attach.ready, discarded-with-notice on exit/failLaunch/clean-exit/identity-change, overflow/timeout → notice.
- Attach-call-site study before enabling the error (waves A–D machinery) → design invariant 7 (all eleven sites triaged with verdicts) + Task 8 unit pin + Task 11 e2e wall; no flow was found to depend on silence.
- Tests demanded by the spec: Rust input-blocked RED (Task 4 Step 2), attach InvalidTerminalId RED (Task 5 Step 2), registry found/not-found unit (Task 3), replay-filter client test (Task 6), byte-exact flush (Task 7/8), overflow/timeout notices (Task 7), the discriminating e2e scenario (Task 9), harness-01 retry-loop replacement (Task 10), restore-contract-wall + hidden-pane-rebind + reconcile e2e (Task 11).
- Repo rules: worktree from origin/main + base green (Task 1), gates list (Task 11), ephemeral ports / never 3001/3002 / never restart the user's server / no broad kills (Global Constraints), push-no-PR (Task 11 Step 4).

**1b. No silent deferrals.** Every user-facing requirement lands on a production outcome proven without stubs: the wire replies are proven by real-server WS integration tests (Tasks 4–5), the client behavior by vitest against the real component (mocked transport is the established suite pattern, backed by the real-browser/real-server e2e in Task 9 that proves the end-to-end arrival guarantee in production wiring). No stub stands in for required behavior; no requirement was moved to known-limitations/future-work. No UNRESOLVED COVERAGE GAPs.

**2. Placeholder scan.** No copy-directive placeholders remain (Task 9 composes the shared `pane-picker.ts` helpers directly). Three "adapt to the harness's actual shape" notes (Task 7 Step 1 `fireData`, Task 7 item 12's App-harness clone, Task 8 Step 1 error-injection) each come with complete working code plus the named in-file mechanism to align with; the contracts being asserted are fully specified.

**3. Load-bearing validation (Stage 2) — findings applied.** 23 assumptions surfaced, 21 validated (ledger: `.worktrees/.the-usual-logs/silent-input-loss/load-bearing-ledger.md`). Falsified → fixed in this plan: A2 (stale-id blocked frames were silently dropped → `lastKnownTerminalIdRef` match, Task 7 item 14 / invariant 10b); A7 (two `sendInput`-bypassing user senders: Shift+Enter :2126-2133 and firewall App.tsx:1493-1509 → Task 7 items 11-12 / invariant 1, the firewall deferral pinned in `App.firewall-command.test.tsx`); A8 (close-race: ref-lagged gate would feed Task 6's filter NEW silent loss → synchronous `ws.isReady` getter in the gate + race test, invariant 9); A13 (request-mode-bypass DECRPM sender was left bufferable → droppable, invariant 5); A15 (anchor's `term.clear()` wipes pre-anchor loss notices → deferred re-write via the reconcileNotice pattern, invariant 3 + Task 7 item 7 + survival test); A23 (harness-01's retry loop also absorbed slow-recreate flake → 60s budgets in Tasks 9-10). Verified corrections folded in: 11th attach call site (quarantine repair :884, invariant 7); flush placement after the sessionRef fold :4066 (A11); `ZOD_BACKED_SERVER_MESSAGES` is a test-side list (Task 2); pane-picker helpers exist (Task 9); creating-overlay `pointer-events-none` (A14, invariant 10a); headless-input warn (A16, Task 3). Accepted residuals (recorded in the ledger with alternatives considered): in-flight frame loss on a dying socket (browser-level, needs an ack protocol — out of scope); TUI-CLI early-input TCSAFLUSH behavior (bash proven 60/60 byte-intact; TUIs unverified); xterm-core DA/CPR auto-replies entering `onData` (output-quiet while un-anchored; post-anchor behavior pre-existing). Re-check of 1b after these edits: every new requirement (race gate, deferred notice, stray-sender folding incl. the firewall deferral, overlay fix) lands on production code with a pinning test in Tasks 6-9 — no stubs, no deferrals.

**4. Type consistency.** `InputOutcome{found}` defined in Task 3, consumed as `outcome.found` in Task 4 and the freshagent caller. `handle_attach(...) -> Option<ServerMessage>` defined and consumed in Task 5. `sendInput(data, opts?: {droppable?: boolean})`, `bufferPendingInput(data)`, `flushPendingInput(tid)`, `discardPendingInput('timeout'|'terminal_gone')`, `notifyPendingInputLoss('overflow'|'timeout'|'terminal_gone')` used consistently across Task 7's steps and Task 8's test. Wire strings consistent throughout: `terminal.input.blocked` / `unknown_terminal` / `INVALID_TERMINAL_ID` / `"Terminal not running"`.
