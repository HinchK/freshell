# Agent Auto-Resume & REST Spawn-Gate Council Follow-Ups (katas znhn + bccd) — Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Implement both council follow-up katas as one batch — kata `znhn` (persistent crash trace, flap-loop circuit breaker + cancel affordance, settle frames for guard-aborted auto-resumes, uncancellable spawn-gate acquire, Relaunch copy) and kata `bccd` (Retry-After on the 429, deterministic burst-test pin, cancel-sender pin superseded by construction, opencode sidecar cold-start gating, D-C revisit tripwire).

**Architecture:** Server-side, the auto-resume hub (`crates/freshell-ws/src/auto_resume.rs`) gains a settle frame (a new `RuntimeStatus::Exited` on the existing `terminal.status` broadcast) emitted on every silent settle path, a cross-reset flap circuit breaker (rolling-window cycle counter in the hub's attempts map), and a user-cancel door (new client message `terminal.autoResumeCancel`). Client-side, the 30s notice-TTL guessing apparatus is deleted (frames are now deterministic), the ephemeral "resumed" strip is replaced by a **persistent, dismissible crash trace stored on pane content** (persists automatically — pane-content persistence is a denylist), and the exit banner gains cancel/dismiss affordances plus honest copy. The spawn gate gains `acquire_uncancellable` (the dummy-channel wart moves into the gate), the REST 429 gains `Retry-After`, and the opencode sidecar cold-start acquires a permit.

**Tech Stack:** Rust (axum, tokio, serde; crates `freshell-ws`, `freshell-freshagent`, `freshell-protocol`, `freshell-terminal`, `freshell-server`, `freshell-codex`), React + Redux Toolkit + TypeScript client, Vitest unit tests, Playwright e2e (`rust-chromium` project), frozen WS contract (`port/contract/*.json` + Rust inventory pins).

## Global Constraints

- Worktree: `/home/dan/code/freshell/.worktrees/znhn-bccd-followups`, branch `feat/znhn-bccd-followups`, based on `origin/main` @ `d2388a09` or newer. All paths below are relative to the worktree root.
- **Frozen contract rule:** any change to `shared/ws-protocol.ts` or `crates/freshell-protocol/src/*` requires `npm run contract:generate` and committing the regenerated `port/contract/ws-protocol.schema.json`, `port/contract/ws-server-messages.schema.json`, `port/contract/ws-message-inventory.json` **plus** the Rust pins (`CLIENT_MESSAGE_TYPES`/`SERVER_MESSAGE_TYPES` arrays and the hardcoded counts in `crates/freshell-protocol/tests/inventory.rs`) **in the same commit**. `npm run test:port` must be green. Additive changes do NOT bump `WS_PROTOCOL_VERSION` (precedent: commits `60bfdcad`, `eef9b344` — version stayed at 7).
- The `reason` field on notice frames is presentational prose and must NEVER be parsed by the client — all client rendering reads typed fields (pinned by `test/unit/client/components/TerminalView.exitBanner.test.tsx:393-425`).
- The spawn-gate tracing target stays the literal string `"freshell_ws::spawn_gate"` (e2e log greps depend on it).
- Ports: e2e servers use kernel-ephemeral ports (`RustServer` helper) — **NEVER 3001/3002**. The user's LIVE server runs on 3002: never restart it, never use broad kill patterns (`pkill -f freshell` etc. is forbidden), no synthetic load on this shared host.
- A11y: real `<button>` elements with `aria-label`; `npm run lint` (eslint + jsx-a11y) must be clean. Vitest globals are OFF — explicit `cleanup()` in `afterEach`.
- `npm test` goes through the host-wide test coordinator: run `npm run test:status` first and WAIT if the gate is held. Canonical invocation: `FRESHELL_TEST_SUMMARY='znhn+bccd follow-ups' env -u FRESHELL_BIND_HOST npm test`.
- TDD red-first for every step; one focused commit per task. README.md stays the only end-user markdown doc (plan docs under `docs/plans/` are working docs and fine).
- **NO PR** — push the branch and stop; landing happens outside this workflow.
- Rust toolchain is pinned at 1.96.0 in CI; `cargo fmt --check` and `cargo clippy --workspace --all-targets -- -D warnings` are gates.

---

## Design Notes (read before Task 1 — decisions locked at plan time)

### D-1. Settle frame shape (znhn item 3)

`RuntimeStatus` gains a third variant `Exited` (serialized `"exited"`), carried on the **existing** `terminal.status` frame — no new server frame type, so `SERVER_MESSAGE_TYPES` stays at 57. `TerminalStatus` already has optional `reason`/`exitCode`/`attempt`/`maxAttempts` fields; it gains one optional `resumeCycles` (breaker settles only). The frame is broadcast with the OLD (crashed) terminal id — the client already matches old ids via `selectLastTerminalIdFrom` (`TerminalView.tsx:4357`). Every settle path for agent-mode events emits it (uniform "every settle is loud"); the clean-exit settle frame is harmless client-side (no notice exists; the alert condition requires a non-zero exit record).

### D-2. Flap circuit breaker thresholds (znhn item 2)

A **bounded circuit breaker**, not escalating backoff: the hub is fully serialized (one task; a backoff sleep delays every pane's resume — `auto_resume.rs:213-217`), so per-pane escalating sleeps of 30s+ would starve all other panes. Chosen semantics: a **cycle** = one successful auto-resume (a `terminal.replaced` emission). Cycles are recorded per `createRequestId` with wall-clock timestamps, pruned to a rolling window at each crash, and **never reset by healthy generations** (that is the cross-reset bound the council asked for — it also bounds the out-of-band-`kill` resurrection loop, which is indistinguishable from a crash). Defaults: **5 cycles per rolling hour** (`AUTO_RESUME_DEFAULT_MAX_CYCLES = 5`, `AUTO_RESUME_DEFAULT_CYCLE_WINDOW_MS = 3_600_000`), env-overridable (`FRESHELL_AUTO_RESUME_MAX_CYCLES`, `FRESHELL_AUTO_RESUME_CYCLE_WINDOW_MS`) for e2e. When a crash arrives with cycles ≥ max, `decide` settles `flap_circuit_breaker`; the settle frame carries `resumeCycles` and the client renders "`<mode>` crashed N times — auto-resume paused". Relaunch stays available; a re-crash after manual relaunch re-settles immediately until the window drains — bounded and loud, never infinite and silent (user ruling). For e2e testability two more knobs become env-overridable: the hub healthy-lifetime (`FRESHELL_AUTO_RESUME_HEALTHY_LIFETIME_MS`, default 30_000) and the registry respawn liveness window (`FRESHELL_RESPAWN_LIVENESS_WINDOW_MS`, wired in `main.rs` through the existing `pub fn set_respawn_liveness_window_ms` setter, `registry.rs:743`) — without the latter, sub-30s flap cycles trip the registry generation cap (3) before the breaker can ever fire.

### D-3. Persistent crash trace replaces the ephemeral "resumed" strip (znhn item 1)

The trace lives on **pane content** (`TerminalPaneContent.crashTrace`) because pane-content persistence is a **denylist** (`stripTransientSessionFields` spreads `...rest`) — a new field persists automatically, no `persistMiddleware` change, no `PANES_SCHEMA_VERSION` bump (schemas use `.passthrough()`; absent = safe `undefined`). The ephemeral `terminalLifecycle` slice cannot host it (slice-level persistence is an allowlist that deliberately excludes it). The `kind: 'resumed'` notice is retired — `foldTerminalReplacement` now clears the notice and the trace is the post-resume indicator. The trace renders as `role="status"` + `data-testid="crash-trace"` (NOT `role="alert"` — four e2e tests assert `getByRole('alert')).toHaveCount(0)` on the happy path). With settle frames on every path (D-1) and terminal.exit already clearing notices, the recovering notice is fully frame-driven, so **both halves of the 30s TTL apparatus are deleted** (selector filter + `TerminalView` re-render timer + the `AUTO_RESUME_NOTICE_TTL_MS` constant).

### D-4. Cancel affordance flow (znhn item 2)

New client message `terminal.autoResumeCancel { terminalId }` (the OLD terminal id from the recovering frame). The WS handler (a) inserts the id into a new `WsState.auto_resume_cancels` set and (b) **broadcasts the settle frame immediately** (reason `"auto-resume cancelled"`) so the notice clears on click, not after the backoff sleep. The hub's post-sleep guard consumes the flag first (`take_cancel`) and settles silently (log only — the frame already went out). A cancel with no pending resume leaves a small string in the set (bounded: one entry per click, consumed on the next crash of that id or never) — accepted. The Rust `ClientMessage` match is exhaustive with no catch-all, so the new variant, its handler, the `WsState` field, protocol pins, and the Node-server case arm (`server/ws-handler.ts` `default:` sends `UNKNOWN_MESSAGE` — a no-op arm is required) all land in ONE commit (Task 8).

### D-5. Retry-After (bccd item 1)

`Retry-After: <secs>` header (the council's ask, HTTP convention) **plus** a `retryAfterMs` body field (house convention — session-lease `SESSION_RESERVED`; the MCP bridge surfaces only `message` text, so the prose hint stays too). Value: the gate wait bound `rest_gate.timeout` (default 10s) — the queue drains within roughly one timeout window; no other duration exists at the rejection point. Scope: the 429 (`SPAWN_QUEUE_FULL`) only, per the kata. `spawn_gate_error_response` gains a `retry_after: Duration` parameter and becomes `pub(crate)` (Task 4 reuses it).

### D-6. Deterministic burst-test pin (bccd item 2)

The flaky `queued_total() >= 8` is replaced by **pre-holding the gate's single permit before firing the burst**: while the budget is fully held, the fast path cannot fire, so `queued_total()` reaches **exactly 16** (deterministic), and **zero** requests may complete (`!h.is_finished()`) — that pins max-in-flight ≤ budget without probabilistic counters. This mirrors the established re-acquire precedent (`abort_burst_rest_creates_stay_gated...`, `terminal_tabs.rs:4104`). No gate instrumentation is added: a peak-in-flight gauge would require changing `acquire`'s return type to an RAII newtype across ~15 call/test sites — YAGNI.

### D-7. Opencode sidecar cold-start gating (bccd item 4) — DECISION: gate it

The sidecar cold-start is a REST-reachable process fork; the gate's semantics are "one server-wide budget for every fork door". The cold-start arm of `send_keys` (`crates/freshell-freshagent/src/lib.rs:1586-1596`) acquires **one** permit via `acquire_uncancellable` around `manager.create_session(...)` (which runs `ensure_started` = spawn + bounded health wait). Warm sends take the `durable_id` branch and never touch the gate. Singleton-ness (double-mutex single-flight) means at most one fork ever happens; the permit is held across a bounded wait — the known hazard (holding a permit while blocked on the `running` mutex held by a permit-less WS caller) is deadlock-free and bounded, accepted. The **WS** materialize door (`opencode_ws.rs:542`) stays ungated with a deliberate code comment: council D-D ruled on REST-reachable forks, and the shared singleton bounds it — recorded in the kata comment (Task 13).

### D-8. Cancel-sender pin test (bccd item 3) — superseded by construction

After Task 1 the REST door holds **no cancel sender at all** — `acquire_uncancellable` owns the never-fired sender inside the gate, so the "one character from total REST outage" refactor hazard is impossible by construction. Instead of pinning a sender's lifetime, Task 1 pins the new API's semantics: an uncancellable acquire queues and completes, times out as `Timeout` (never `Cancelled`), rejects `QueueFull` loudly, and `cancellations()` stays 0.

### D-9. Relaunch-mid-respawn orphan race (znhn item 6) — resolved structurally

The race's UI trigger was the notice TTL: with `FRESHELL_AUTO_RESUME_DELAYS_MS > 30000` the recovering notice expired before the backoff finished, exposing the alert bar (with Relaunch) while a respawn was still planned. Tasks 6+9 delete the TTL and make the notice frame-driven, so the alert bar can no longer appear while a resume is pending, at any delay value. A unit test pins this (Task 9, step 1), and the residual server-side ordering (REST-door relaunch during backoff) remains covered by the existing `session_owned_live` guard — which now also emits a settle frame. Kata comment records the resolution (Task 13).

### D-10. Patience window honesty (znhn item 1b)

One sentence appended to `docs/plans/2026-07-27-agent-crash-resilience.md` §D-5 (line ~67, the schedule bullet): the total patience window is ~12s (2s + 10s backoff plus spawn time), so outage-class causes (provider down, expired auth) exhaust the budget and settle loudly — by design, auto-resume survives crashes, not outages.

---

## File Structure

| File | Change | Task |
|---|---|---|
| `crates/freshell-freshagent/src/spawn_gate.rs` | Modify: add `acquire_uncancellable` + 3 pin tests | 1 |
| `crates/freshell-freshagent/src/terminal_tabs.rs` | Modify: migrate REST acquire; `spawn_gate_error_response` signature + `pub(crate)` + Retry-After; D-C marker; burst test rewrite; 429 header test | 1, 2, 3 |
| `crates/freshell-ws/src/terminal.rs` | Modify: migrate respawn acquire; `terminal.autoResumeCancel` match arm + handler | 1, 8 |
| `crates/freshell-codex/src/launch_plan.rs` | Modify: D-C marker on flag doc comment | 2 |
| `docs/plans/2026-07-27-rest-spawn-gate.md` | Modify: D-C tripwire note | 2 |
| `crates/freshell-freshagent/src/lib.rs` | Modify: gate opencode cold-start in `send_keys`; tests | 4 |
| `crates/freshell-freshagent/src/opencode_ws.rs` | Modify: deliberate-ungated comment | 4 |
| `crates/freshell-protocol/src/server_messages.rs` | Modify: `RuntimeStatus::Exited`, `TerminalStatus.resume_cycles` | 5 |
| `crates/freshell-protocol/src/client_messages.rs` | Modify: `TerminalAutoResumeCancel` variant + struct, `CLIENT_MESSAGE_TYPES` 29→30 | 8 |
| `crates/freshell-protocol/tests/roundtrip.rs` | Modify: settle-frame + cancel roundtrip tests | 5, 8 |
| `crates/freshell-protocol/tests/inventory.rs` | Modify: hardcoded counts 29→30, 86→87 | 8 |
| `shared/ws-protocol.ts` | Modify: status union + `resumeCycles`; cancel message schema + union | 5, 8 |
| `port/contract/*.json` (3 files) | Regenerate via `npm run contract:generate` | 5, 8 |
| `server/ws-handler.ts` | Modify: no-op case arm for `terminal.autoResumeCancel` | 8 |
| `crates/freshell-ws/src/auto_resume.rs` | Modify: `emit_settled` + `take_cancel` on driver; `HubConfig`; `ResumeHistory`; breaker in `decide`; hub loop; env fns; tests | 6, 7, 8 |
| `crates/freshell-ws/src/lib.rs` | Modify: `WsState.auto_resume_cancels` field | 8 |
| `crates/freshell-ws/tests/common/mod.rs` | Modify: `WsState` literals gain the new field | 8 |
| `crates/freshell-server/src/main.rs` | Modify: `FRESHELL_RESPAWN_LIVENESS_WINDOW_MS` wiring | 7 |
| `src/store/terminalLifecycleSlice.ts` | Modify: delete TTL; `recordAutoResumeSettled`; `settle` field; `foldTerminalReplacement` clears notice; narrow notice kind | 9, 10 |
| `src/components/TerminalView.tsx` | Modify: delete TTL timer; settle-frame handling; cancel/dismiss/relaunch wiring; crash-trace dispatch; banner props | 9, 10, 11 |
| `src/components/TerminalExitBanner.tsx` | Modify: cancel button; crash-trace branch; breaker + relaunch copy | 9, 10, 11 |
| `src/store/paneTypes.ts` | Modify: `CrashTrace` type + `crashTrace` field | 10 |
| `src/store/panesSlice.ts` | Modify: `setPaneCrashTrace` / `clearPaneCrashTrace` reducers + exports | 10 |
| `docs/plans/2026-07-27-agent-crash-resilience.md` | Modify: patience-window sentence in §D-5 | 10 |
| `test/unit/client/store/terminalLifecycleSlice.test.ts` | Modify | 9, 10 |
| `test/unit/client/components/TerminalView.exitBanner.test.tsx` | Modify | 9, 10, 11 |
| `test/unit/client/components/TerminalExitBanner.test.tsx` | Modify | 9, 10, 11 |
| `test/unit/client/store/panesPersistence.test.ts` | Modify: crash-trace round-trip | 10 |
| `test/e2e-browser/fixtures/fake-crashing-claude-cli.mjs` | Modify: `FAKE_CRASH_LIVE_MS` flap mode | 12 |
| `test/e2e-browser/specs/agent-crash-autoresume-rust.spec.ts` | Modify: 3 new tests | 12 |

Anything not in this table is out of scope. Scope check: the two katas share the spawn gate (znhn item 4 IS the enabler for bccd items 2–4) and the auto-resume protocol work is one coherent chain — one plan, strictly ordered tasks, each independently testable.

---

### Task 0: Workspace verification + baseline

**Files:** none created — verification only.

**Interfaces:**
- Consumes: the prepared worktree at `/home/dan/code/freshell/.worktrees/znhn-bccd-followups` on branch `feat/znhn-bccd-followups`.
- Produces: a verified-green baseline all later tasks build on.

- [ ] **Step 1: Verify worktree, branch, and base**

```bash
cd /home/dan/code/freshell/.worktrees/znhn-bccd-followups
git fetch origin main
git merge-base --is-ancestor origin/main HEAD && echo OK-BASE
git rev-parse --abbrev-ref HEAD   # expect: feat/znhn-bccd-followups
```
Expected: `OK-BASE` and the branch name. If the branch is behind origin/main, `git merge origin/main` (expect fast-forward/no conflicts).

- [ ] **Step 2: Node deps + tsx**

```bash
[ -d node_modules ] || npm ci
npx tsx --version
```
Expected: a tsx version prints. If `npx tsx` fails but `node_modules/.bin/tsx` exists, symlink it onto PATH usage is NOT needed — invoke via `npx`.

- [ ] **Step 3: Rust + client baseline compile and targeted baseline tests**

```bash
cargo build --workspace 2>&1 | tail -3
cargo test -p freshell-freshagent spawn_gate 2>&1 | tail -5
cargo test -p freshell-ws auto_resume 2>&1 | tail -5
npx vitest run test/unit/client/components/TerminalView.exitBanner.test.tsx test/unit/client/store/terminalLifecycleSlice.test.ts 2>&1 | tail -5
```
Expected: all green. (Full-suite gates run in Task 13; `npm test` is coordinator-gated so don't run it here.)

- [ ] **Step 4: Commit** — nothing to commit (verification only). If a merge commit was created in Step 1, it stands alone.

---

### Task 1: `SpawnGate::acquire_uncancellable` + migrate both dummy-channel callers (znhn 4, bccd 3)

**Files:**
- Modify: `crates/freshell-freshagent/src/spawn_gate.rs` (API + tests, after `acquire` at `:113-187`, tests mod at `:206`)
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs:1052-1067` (REST door)
- Modify: `crates/freshell-ws/src/terminal.rs:2903-2921` (auto-resume respawn door)

**Interfaces:**
- Consumes: `SpawnGate::acquire(&self, timeout: Duration, cancel: &mut watch::Receiver<bool>) -> Result<OwnedSemaphorePermit, SpawnGateError>` (existing).
- Produces: `pub async fn acquire_uncancellable(&self, timeout: Duration) -> Result<OwnedSemaphorePermit, SpawnGateError>` — used by Tasks 3 and 4.

- [ ] **Step 1: Write the failing pin tests** — add to `mod tests` in `spawn_gate.rs` (the module already has `cancel_pair()` at `:212` and uses `Arc`, `Duration`, `tokio::time::sleep`):

```rust
    #[tokio::test]
    async fn acquire_uncancellable_waits_for_a_permit_and_never_cancels() {
        let gate = Arc::new(SpawnGate::new(1, 64));
        let (_tx, mut rx) = cancel_pair();
        let held = gate
            .acquire(Duration::from_secs(1), &mut rx)
            .await
            .expect("holder");
        let g2 = Arc::clone(&gate);
        let waiter =
            tokio::spawn(async move { g2.acquire_uncancellable(Duration::from_secs(5)).await });
        // Deterministic queue barrier (established idiom in this module).
        for _ in 0..200 {
            if gate.queued_total() == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(gate.queued_total(), 1, "uncancellable waiter must queue");
        drop(held);
        assert!(waiter.await.unwrap().is_ok(), "waiter acquires after release");
        assert_eq!(gate.cancellations(), 0, "Cancelled must be unreachable");
    }

    #[tokio::test]
    async fn acquire_uncancellable_times_out_as_timeout_not_cancelled() {
        let gate = SpawnGate::new(1, 64);
        let (_tx, mut rx) = cancel_pair();
        let _held = gate
            .acquire(Duration::from_secs(1), &mut rx)
            .await
            .expect("holder");
        let err = gate
            .acquire_uncancellable(Duration::from_millis(50))
            .await
            .unwrap_err();
        assert_eq!(err, SpawnGateError::Timeout);
        assert_eq!(gate.timeouts(), 1);
        assert_eq!(gate.cancellations(), 0);
    }

    #[tokio::test]
    async fn acquire_uncancellable_rejects_queue_full_loudly() {
        let gate = SpawnGate::new(0, 0);
        let err = gate
            .acquire_uncancellable(Duration::from_millis(50))
            .await
            .unwrap_err();
        assert_eq!(err, SpawnGateError::QueueFull);
        assert_eq!(gate.queue_rejections(), 1);
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p freshell-freshagent spawn_gate::tests::acquire_uncancellable`
Expected: COMPILE FAIL — `no method named acquire_uncancellable`.

- [ ] **Step 3: Implement the API** — in `spawn_gate.rs`, directly below `acquire`:

```rust
    /// Acquire a spawn permit with no caller-side cancellation (kata znhn
    /// item 4). Two doors have no connection whose death should cancel the
    /// wait — the REST door and the auto-resume respawn door. They used to
    /// mint never-fired watch channels at every call site; that wart belongs
    /// to the gate. The never-fired sender now lives HERE, held across the
    /// acquire, so `Cancelled` is unreachable by construction (kata bccd
    /// item 3: no caller-side sender exists to drop). The timeout still
    /// bounds the wait.
    pub async fn acquire_uncancellable(
        &self,
        timeout: Duration,
    ) -> Result<OwnedSemaphorePermit, SpawnGateError> {
        let (_cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
        self.acquire(timeout, &mut cancel_rx).await
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p freshell-freshagent spawn_gate`
Expected: all tests PASS (8 existing + 3 new).

- [ ] **Step 5: Migrate the REST door** — in `terminal_tabs.rs`, inside `spawn_terminal_pane`'s `Some(rest_gate)` arm (`:1052-1067`), delete the dummy-channel line (`let (_cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);`) and replace the acquire; the comment shrinks accordingly. Result:

```rust
        Some(rest_gate) => {
            // Uncancellable acquire (kata znhn item 4): REST has no
            // connection whose death should cancel the wait — the gate owns
            // that semantics now. If the HTTP request is dropped while
            // QUEUED, axum drops this future and the gate's queue-slot guard
            // reclaims the slot — nothing has been spawned yet.
            match rest_gate.gate.acquire_uncancellable(rest_gate.timeout).await {
                Ok(permit) => Some(permit),
```
Keep the `Err(err)` arm (stub GC + `return Err(spawn_gate_error_response(err))`) byte-identical.

- [ ] **Step 6: Migrate the respawn door** — in `crates/freshell-ws/src/terminal.rs:2903-2921`, delete the `let (_respawn_cancel_tx, mut respawn_cancel_rx) = ...` line, trim the second paragraph of the comment (the dummy-channel explanation) down to `// Uncancellable acquire (kata znhn item 4): auto-resume is server-initiated with no connection to die; the timeout still bounds the wait.`, and change the call:

```rust
    let _spawn_permit = match state
        .spawn_gate
        .acquire_uncancellable(std::time::Duration::from_millis(
            state.create_protect.spawn_timeout_ms,
        ))
        .await
    {
```
Error arm unchanged.

- [ ] **Step 7: Run affected suites**

Run: `cargo test -p freshell-freshagent && cargo test -p freshell-ws auto_resume_respawn && cargo fmt --check && cargo clippy -p freshell-freshagent -p freshell-ws --all-targets -- -D warnings`
Expected: PASS (the `respawn_is_rejected_loud_when_spawn_gate_queue_is_full` integration test still passes — its 64 queue-filler tasks may keep their own senders; optionally migrate them to `acquire_uncancellable` for consistency).

- [ ] **Step 8: Commit**

```bash
git add crates/freshell-freshagent/src/spawn_gate.rs crates/freshell-freshagent/src/terminal_tabs.rs crates/freshell-ws/src/terminal.rs crates/freshell-ws/tests/auto_resume_respawn.rs
git commit -m "feat(spawn-gate): acquire_uncancellable owns the never-fired cancel wart (znhn#4, bccd#3)"
```

---

### Task 2: Retry-After on the 429 + D-C revisit tripwire (bccd 1, bccd 5)

**Files:**
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs` (`spawn_gate_error_response` at `:581-611`, its call site `:1077`, test `queue_cap_exceeded_rest_create_is_429_spawn_queue_full` at `:3913`, D-C marker at `:1271`)
- Modify: `crates/freshell-codex/src/launch_plan.rs:51-55` (flag doc comment)
- Modify: `docs/plans/2026-07-27-rest-spawn-gate.md` (§D-C, `:97-119`)

**Interfaces:**
- Consumes: `crate::fail_json_code(StatusCode, &str, String) -> Response` (lib.rs:1336); `RestSpawnGate { gate, timeout }`.
- Produces: `pub(crate) fn spawn_gate_error_response(err: SpawnGateError, retry_after: std::time::Duration) -> Response` — reused by Task 4. 429 body gains `retryAfterMs: number`; 429 response gains `Retry-After: <secs>` header.

- [ ] **Step 1: Extend the failing test** — in `queue_cap_exceeded_rest_create_is_429_spawn_queue_full` (`terminal_tabs.rs:3913`), after the existing status/code assertions, add assertions on the header and body field. The test configures its gate timeout via `state.set_spawn_gate(gate, <duration>)`; assert against that same duration (if the test uses `Duration::from_secs(30)`, expect `"30"` and `30000`):

```rust
        assert_eq!(
            response.headers().get(axum::http::header::RETRY_AFTER).map(|v| v.to_str().unwrap()),
            Some("30"),
            "429 must carry a machine-readable Retry-After (bccd item 1)"
        );
        assert_eq!(body["retryAfterMs"], 30_000);
```
(Adapt the two literals to the timeout the test actually configures; if the current test helper returns only `(status, body)`, extend the helper or use the underlying `Response` directly for this test.)

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p freshell-freshagent queue_cap_exceeded`
Expected: FAIL — no `retry-after` header / no `retryAfterMs` field (or compile error from the helper change).

- [ ] **Step 3: Implement** — change `spawn_gate_error_response` (`:581-611`) to:

```rust
/// REST mapping of a spawn-gate rejection (WS analogue:
/// `spawn_gate_error_parts` in freshell-ws/src/terminal.rs).
/// QueueFull -> 429 with Retry-After (bccd item 1): header for HTTP
/// convention + `retryAfterMs` body field (house convention, session-lease
/// SESSION_RESERVED). The retry guidance ALSO stays in the MESSAGE because
/// the MCP bridge (server/mcp/freshell-tool.ts) surfaces only message text.
/// Timeout -> 503: spawn capacity unavailable right now.
/// Body key is `code`+`message` (never `error`).
pub(crate) fn spawn_gate_error_response(
    err: crate::spawn_gate::SpawnGateError,
    retry_after: std::time::Duration,
) -> Response {
    match err {
        crate::spawn_gate::SpawnGateError::QueueFull => {
            let secs = retry_after.as_secs().max(1);
            (
                StatusCode::TOO_MANY_REQUESTS,
                [(axum::http::header::RETRY_AFTER, axum::http::HeaderValue::from(secs))],
                Json(json!({
                    "status": "error",
                    "code": "SPAWN_QUEUE_FULL",
                    "message": "Too many concurrent terminal spawns; retry shortly",
                    "retryAfterMs": retry_after.as_millis() as u64,
                })),
            )
                .into_response()
        }
        crate::spawn_gate::SpawnGateError::Timeout => crate::fail_json_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "SPAWN_TIMEOUT",
            "Timed out waiting for a terminal spawn slot".to_string(),
        ),
        // Unreachable since acquire_uncancellable (znhn item 4): no cancel
        // sender exists on this door at all. Mapped like Timeout so an
        // impossible arm still fails safe.
        crate::spawn_gate::SpawnGateError::Cancelled => crate::fail_json_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "SPAWN_TIMEOUT",
            "Timed out waiting for a terminal spawn slot".to_string(),
        ),
    }
}
```
Update the call site at `:1077`: `return Err(spawn_gate_error_response(err, rest_gate.timeout));`. Fix any other call sites the compiler reports the same way (pass the gate timeout in scope).

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p freshell-freshagent`
Expected: PASS.

- [ ] **Step 5: D-C tripwire markers (doc-only, no test)** — add above the codex managed-launch block at `terminal_tabs.rs:1271` (immediately above the `// DEV-0006 S4 inc.2 (FLAG-GATED, default OFF — council fence):` comment):

```rust
        // D-C-REVISIT(FRESHELL_CODEX_MANAGED_LAUNCH): this plan runs UNDER
        // the held spawn permit — plan_create_with_retry can hold it ~226s
        // worst case (5 × SIDECAR_START_BUDGET 45s + 1s backoff) vs the 10s
        // permit wait. Accepted while the flag defaults OFF. If the default
        // ever flips ON, the permit-hold duration MUST be revisited (likely
        // a separate sidecar budget covering both doors). Decision record:
        // docs/plans/2026-07-27-rest-spawn-gate.md §D-C.
```

Append to the flag's doc comment in `launch_plan.rs:51-55` (above `pub const FRESHELL_CODEX_MANAGED_LAUNCH_ENV`):

```rust
/// D-C-REVISIT(FRESHELL_CODEX_MANAGED_LAUNCH): flipping this default ON must
/// revisit the ~226s REST permit-hold (grep for D-C-REVISIT; decision in
/// docs/plans/2026-07-27-rest-spawn-gate.md §D-C).
```

Append one line at the end of the D-C section in `docs/plans/2026-07-27-rest-spawn-gate.md` (after `:119`):

```markdown
> Tripwire (added 2026-07-29, kata bccd item 5): grep `D-C-REVISIT(FRESHELL_CODEX_MANAGED_LAUNCH)` — marker comments sit at the REST call site (`terminal_tabs.rs`) and on the flag const (`launch_plan.rs`) so the default flip cannot ship without hitting this decision.
```

- [ ] **Step 6: Gates + commit**

Run: `cargo fmt --check && cargo clippy -p freshell-freshagent -p freshell-codex --all-targets -- -D warnings && cargo test -p freshell-freshagent`
Expected: PASS.

```bash
git add crates/freshell-freshagent/src/terminal_tabs.rs crates/freshell-codex/src/launch_plan.rs docs/plans/2026-07-27-rest-spawn-gate.md
git commit -m "feat(rest): Retry-After on SPAWN_QUEUE_FULL 429 + D-C revisit tripwire (bccd#1, bccd#5)"
```

---

### Task 3: Deterministic burst-test pin (bccd 2)

**Files:**
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs:3973-4013` (`fifteen_plus_rest_create_burst_is_bounded_and_all_complete`)

**Interfaces:**
- Consumes: `SpawnGate::acquire_uncancellable` (Task 1), the test-local `post(router, path, body)` helper, `state_with_registry()`, and the existing test's request payload + per-terminal `registry.kill(...)` cleanup (KEEP those parts byte-identical).
- Produces: nothing new — a deterministic test.

- [ ] **Step 1: Rewrite the test (red first — prove the new mechanics compile and the old assertion is gone).** Replace ONLY the gate setup, burst-launch and assertion mechanics; keep the existing payload construction, response-success assertions, and terminal cleanup from the current body:

```rust
    #[tokio::test(flavor = "multi_thread")]
    async fn fifteen_plus_rest_create_burst_is_bounded_and_all_complete() {
        // Deterministic pin (kata bccd item 2, council enn3): pre-holding the
        // single permit forces EVERY burst request through the queue —
        // queued_total() reaches exactly 16 (the fast path cannot fire while
        // the budget is held), and ZERO requests may complete while the
        // budget is exhausted. That pins max-in-flight <= budget without the
        // probabilistic `queued_total >= 8` lower bound (the fast path skips
        // the counter). Mirrors the re-acquire precedent at
        // `abort_burst_rest_creates_stay_gated...`.
        let state = state_with_registry();
        let registry = state.terminal_registry.clone().unwrap();
        let gate = Arc::new(crate::spawn_gate::SpawnGate::new(1, 64));
        state.set_spawn_gate(Arc::clone(&gate), std::time::Duration::from_secs(30));
        let router = app(state);

        let held = gate
            .acquire_uncancellable(std::time::Duration::from_secs(1))
            .await
            .expect("test pre-hold of the single permit");

        let mut handles = Vec::new();
        for _ in 0..16 {
            let r = router.clone();
            handles.push(tokio::spawn(async move {
                // KEEP the existing post(...) payload from the current test.
                post(r, "/api/tabs", /* existing body */).await
            }));
        }

        // Every request must queue behind the held permit — exact, not
        // probabilistic.
        for _ in 0..600 {
            if gate.queued_total() == 16 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert_eq!(
            gate.queued_total(),
            16,
            "all 16 burst requests must queue while the permit is held"
        );
        assert!(
            handles.iter().all(|h| !h.is_finished()),
            "no request may complete while the budget is fully held (max-in-flight <= budget)"
        );

        drop(held);
        // KEEP the existing completion assertions + registry.kill cleanup:
        // every request returns 200 and every spawned terminal is killed.
        for h in handles {
            /* existing per-response assertions + cleanup */
        }
    }
```

- [ ] **Step 2: Run to verify it fails/compiles honestly**

Run: `cargo test -p freshell-freshagent fifteen_plus_rest_create_burst -- --nocapture`
Expected: PASS once wired correctly (this task is a test rewrite; "red" here is the intermediate compile failures while splicing — the meaningful gate is Step 3).

- [ ] **Step 3: Determinism check — run it 10×**

Run: `for i in $(seq 10); do cargo test -p freshell-freshagent fifteen_plus_rest_create_burst || break; done`
Expected: 10/10 PASS.

- [ ] **Step 4: Commit**

```bash
git add crates/freshell-freshagent/src/terminal_tabs.rs
git commit -m "test(rest): burst test pins max-in-flight <= budget deterministically (bccd#2)"
```

---

### Task 4: Gate the opencode sidecar cold-start (bccd 4)

**Files:**
- Modify: `crates/freshell-freshagent/src/lib.rs` (`send_keys` cold-start arm at `:1583-1596`; inline tests near `:2694`)
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs` (comment near `:542`)

**Interfaces:**
- Consumes: `FreshAgentState::spawn_gate() -> Option<RestSpawnGate>` (`lib.rs:310`), `acquire_uncancellable` (Task 1), `pub(crate) spawn_gate_error_response(err, retry_after)` (Task 2), test harness `FreshAgentState::set_manager_for_test` (`lib.rs:536`) + `NoopSpawner`/`FakeAllocator`/`NoopEventSource`, template test `rest_send_keys_materialization_records_binding` (`lib.rs:2694`).
- Produces: the cold-start fork consults the shared spawn gate; rejection returns the same 429/503 envelopes as the create door.

- [ ] **Step 1: Write the failing tests** — inline in `lib.rs`'s test module, modeled byte-for-byte on the harness of `rest_send_keys_materialization_records_binding` (`:2694` — same state/pane/router setup, `timeout: 0`, no real `opencode` binary):

```rust
    #[tokio::test]
    async fn opencode_cold_start_send_keys_is_gated_and_queue_full_is_429() {
        // Same setup as rest_send_keys_materialization_records_binding, but
        // the gate has zero permits and zero queue slots: the cold-start
        // (no durable_id) send-keys must be rejected BY THE GATE before any
        // sidecar work happens.
        // <copy the state/pane/manager/router setup from :2694>
        state.set_spawn_gate(
            Arc::new(crate::spawn_gate::SpawnGate::new(0, 0)),
            std::time::Duration::from_millis(50),
        );
        // <issue the same send-keys request as :2694 against a pane WITHOUT durable_id>
        assert_eq!(status, 429);
        assert_eq!(body["code"], "SPAWN_QUEUE_FULL");
        assert!(body["retryAfterMs"].is_u64());
    }

    #[tokio::test]
    async fn opencode_cold_start_queues_behind_the_held_spawn_permit() {
        // Gate (1, 64) with the permit pre-held by the test: the cold-start
        // send-keys must QUEUE (queued_total == 1) and complete only after
        // release — proof the fork door actually flows through the gate.
        // <same setup as :2694>
        let gate = Arc::new(crate::spawn_gate::SpawnGate::new(1, 64));
        state.set_spawn_gate(Arc::clone(&gate), std::time::Duration::from_secs(5));
        let held = gate
            .acquire_uncancellable(std::time::Duration::from_secs(1))
            .await
            .unwrap();
        let task = tokio::spawn(/* the send-keys request future */);
        for _ in 0..200 {
            if gate.queued_total() == 1 { break; }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert_eq!(gate.queued_total(), 1, "cold start must wait on the gate");
        drop(held);
        let response = task.await.unwrap();
        // <same success assertion as :2694>
    }
```
Also assert in the second test (or a third, if cleaner) that a pane **with** `durable_id` (warm path) does NOT consult the gate: with the permit held, the warm send-keys response must not be 429/503-`SPAWN_TIMEOUT`.

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p freshell-freshagent opencode_cold_start`
Expected: FAIL — cold start currently never touches the gate (first test gets a non-429; second never queues).

- [ ] **Step 3: Implement** — in `send_keys` (`lib.rs`), inside the cold-start `else` arm (`:1586`), immediately before `manager.create_session(...)`:

```rust
            // bccd item 4 (council enn3 D-D follow-up): the sidecar
            // cold-start is a REST-reachable process fork — it must consult
            // the same server-wide spawn gate as every other fork door.
            // Singleton double-mutex single-flight means at most one fork
            // ever happens, so this is a single-permit acquire held only
            // across the cold-start (spawn + bounded health wait). Warm
            // sends take the durable_id branch and never reach this arm.
            let _spawn_permit = match state.spawn_gate() {
                Some(g) => match g.gate.acquire_uncancellable(g.timeout).await {
                    Ok(permit) => Some(permit),
                    Err(err) => {
                        return crate::terminal_tabs::spawn_gate_error_response(err, g.timeout)
                    }
                },
                None => None, // unwired (unit-test states) = legacy ungated
            };
```
(The permit drops at the end of the `else` block — after `create_session` returns.) Ensure `spawn_gate_error_response` is reachable: Task 2 made it `pub(crate)`; if `terminal_tabs` is not already a visible module path, adjust to the crate's actual module layout (compiler-guided).

Add the deliberate-scope comment in `opencode_ws.rs` at the materialize cold-start (`:542` area):

```rust
        // Deliberately ungated (bccd item 4 scope): council D-D ruled on
        // REST-reachable forks; this WS materialize path shares the same
        // single-flighted singleton manager, so at most one sidecar fork
        // exists server-wide. Revisit if the WS door grows fork fan-out.
```

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p freshell-freshagent && cargo fmt --check && cargo clippy -p freshell-freshagent --all-targets -- -D warnings`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-freshagent/src/lib.rs crates/freshell-freshagent/src/opencode_ws.rs
git commit -m "feat(opencode): sidecar cold-start acquires a spawn-gate permit (bccd#4)"
```

---

### Task 5: Frozen-contract widening — `RuntimeStatus::Exited` + `resumeCycles` (znhn 3 protocol half)

**Files:**
- Modify: `crates/freshell-protocol/src/server_messages.rs` (`RuntimeStatus` at `:247`, `TerminalStatus` at `:1102`)
- Modify: `crates/freshell-protocol/tests/roundtrip.rs`
- Modify: `shared/ws-protocol.ts:766-795` (`TerminalStatusMessage`)
- Regenerate: `port/contract/ws-protocol.schema.json`, `port/contract/ws-server-messages.schema.json`, `port/contract/ws-message-inventory.json`

**Interfaces:**
- Consumes: existing `TerminalStatus` / `RuntimeStatus` types.
- Produces (used by Tasks 6–9): `RuntimeStatus::Exited` (wire literal `"exited"`); `TerminalStatus.resume_cycles: Option<i64>` (wire `resumeCycles?: number`); TS `TerminalStatusMessage.status: 'running' | 'recovering' | 'exited'` + `resumeCycles?: number`.

- [ ] **Step 1: Write the failing roundtrip test** — in `crates/freshell-protocol/tests/roundtrip.rs`, mirroring the file's existing style:

```rust
#[test]
fn terminal_status_exited_settle_frame_roundtrips() {
    let msg = ServerMessage::TerminalStatus(TerminalStatus {
        status: RuntimeStatus::Exited,
        terminal_id: "t1".into(),
        attempt: None,
        max_attempts: None,
        exit_code: None,
        reason: Some("pane_closed".into()),
        resume_cycles: Some(3),
    });
    let json = serde_json::to_value(&msg).unwrap();
    assert_eq!(json["type"], "terminal.status");
    assert_eq!(json["status"], "exited");
    assert_eq!(json["resumeCycles"], 3);
    assert!(json.get("attempt").is_none(), "None fields are skip-serialized");
    let back: ServerMessage = serde_json::from_value(json).unwrap();
    assert_eq!(back, msg);
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p freshell-protocol --test roundtrip terminal_status_exited`
Expected: COMPILE FAIL — no variant `Exited`, no field `resume_cycles`.

- [ ] **Step 3: Implement the Rust side** — `server_messages.rs`:

```rust
/// Live terminal runtime status (`running | recovering | exited`).
/// `exited` is the auto-resume SETTLE frame (kata znhn item 3): broadcast
/// with the OLD terminal id whenever a planned auto-resume settles without a
/// replacement (guard-abort, retries exhausted, flap circuit breaker, user
/// cancel) so the client clears the recovering notice on a FRAME, never on
/// a timer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeStatus {
    Running,
    Recovering,
    Exited,
}
```

and add to `TerminalStatus` (after `reason`):

```rust
    /// Flap-circuit-breaker settle frames only: successful auto-resumes
    /// inside the rolling window. The client renders the "crashed N times"
    /// banner from this FIELD — `reason` prose is presentational and must
    /// never be parsed (council 7w4h/xkhx).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_cycles: Option<i64>,
```

Then fix every `TerminalStatus { ... }` construction site the compiler reports (e.g. `emit_recovering` in `crates/freshell-ws/src/auto_resume.rs:600` and tests) by adding `resume_cycles: None`.

- [ ] **Step 4: Implement the TS side** — `shared/ws-protocol.ts`:

```ts
export type TerminalStatusMessage = {
  type: 'terminal.status'
  terminalId: string
  status: 'running' | 'recovering' | 'exited'
  reason?: string
  attempt?: number
  /** Auto-resume 'recovering' frames only: the bounded retry budget. The
   * client renders attempt/maxAttempts from these FIELDS — `reason` prose is
   * purely presentational and must never be parsed (council 7w4h/xkhx). */
  maxAttempts?: number
  /** Auto-resume 'recovering' frames only: the crashed generation's exit code. */
  exitCode?: number
  /** Flap-circuit-breaker settle frames ('exited') only: successful
   * auto-resumes inside the rolling window — the typed source for the
   * "crashed N times" banner. */
  resumeCycles?: number
}
```
If `terminal.status` has a Zod schema alongside the type (server-message schemas are generated — check `generate-ws-contract.ts` inputs), widen it identically.

- [ ] **Step 5: Regenerate contract + run pins**

```bash
npm run contract:generate
git diff --stat port/contract   # expect the server-messages schema (and possibly inventory) changed
cargo test -p freshell-protocol
npm run test:port
```
Expected: all PASS. `SERVER_MESSAGE_TYPES` stays `[&str; 57]` (no new frame type); `WS_PROTOCOL_VERSION` stays 7.

- [ ] **Step 6: Full workspace compile check + commit**

Run: `cargo test --workspace 2>&1 | tail -5 && cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings`
Expected: PASS (all `TerminalStatus` construction sites updated).

```bash
git add crates/freshell-protocol shared/ws-protocol.ts port/contract crates/freshell-ws
git commit -m "feat(protocol): RuntimeStatus::Exited settle frame + resumeCycles field (znhn#3)"
```

---

### Task 6: Server emits settle frames on every silent settle path (znhn 3)

**Files:**
- Modify: `crates/freshell-ws/src/auto_resume.rs` (trait `AutoResumeDriver` at `:327-377`, `WsAutoResumeDriver` impl at `:391+`, hub body `:218-306`, `FakeDriver` at `:966-1065`, hub tests `:1078+`)

**Interfaces:**
- Consumes: `RuntimeStatus::Exited` + `resume_cycles` (Task 5); existing `log_settled`, `broadcast_tx`.
- Produces (used by Tasks 7–9, 12): trait method `fn emit_settled(&self, terminal_id: &str, reason: &str, resume_cycles: Option<u32>)`; every settle path for agent-mode events broadcasts `terminal.status { status: 'exited', terminalId: <old id>, reason, resumeCycles? }`.

- [ ] **Step 1: Write the failing hub tests** — extend `FakeDriver` state with `settled_frames: Mutex<Vec<(String, String, Option<u32>)>>` (terminal_id, reason, resume_cycles) recorded by a new `emit_settled` impl, then add:

```rust
    #[tokio::test]
    async fn guard_abort_emits_a_settle_frame() {
        // pane_closed guard-abort must broadcast the settle frame so the
        // client clears the recovering notice deterministically (znhn #3).
        // <same setup as pane_closed_during_backoff_settles_pane_closed (:1204)>
        // ...after drain():
        let settled = driver.settled_frames();
        assert_eq!(settled, vec![("t1".to_string(), "pane_closed".to_string(), None)]);
    }

    #[tokio::test]
    async fn retries_exhausted_emits_a_settle_frame() {
        // <same setup as second_crash_uses_second_delay_then_exhausts (:1097)>
        // ...final crash exhausts:
        let settled = driver.settled_frames();
        assert!(settled.iter().any(|(t, r, _)| t == "t1" && r == "retries_exhausted"));
    }
```
Also update the existing guard/settle tests (`live_session_owner_aborts_resume_silently`, `pane_closed_during_backoff_settles_pane_closed`, `lost_lease_claim_aborts_resume`, `failed_respawn_settles_loudly`, `lost_lease_completion_settles_without_replaced_frame`, `cap_exhausted_and_no_identity_and_clean_and_shell_settle_without_respawn`) to assert the settle frame IS emitted for agent-mode settles and is NOT emitted for `shell` mode.

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p freshell-ws auto_resume`
Expected: COMPILE FAIL — trait has no `emit_settled`.

- [ ] **Step 3: Implement** —

Trait addition (`AutoResumeDriver`):

```rust
    /// Broadcast the settle frame — `terminal.status { status: 'exited' }`
    /// for the OLD terminal id (znhn item 3). Every agent-mode settle emits
    /// it: the client clears the recovering notice on a FRAME, never on a
    /// timer. `resume_cycles` is Some only for flap-circuit-breaker settles.
    fn emit_settled(&self, terminal_id: &str, reason: &str, resume_cycles: Option<u32>);
```

`WsAutoResumeDriver` impl (next to `emit_recovering`):

```rust
    fn emit_settled(&self, terminal_id: &str, reason: &str, resume_cycles: Option<u32>) {
        let msg = freshell_protocol::ServerMessage::TerminalStatus(freshell_protocol::TerminalStatus {
            status: freshell_protocol::RuntimeStatus::Exited,
            terminal_id: terminal_id.to_string(),
            attempt: None,
            max_attempts: None,
            exit_code: None,
            reason: Some(reason.to_string()),
            resume_cycles: resume_cycles.map(i64::from),
        });
        match serde_json::to_string(&msg) {
            Ok(json) => {
                let _ = self.state.broadcast_tx.send(json);
            }
            Err(err) => {
                tracing::error!(terminal_id, error = %err, "terminal.auto_resume.settled_frame_serialize_failed");
            }
        }
    }
```

Hub body: at **every** `driver.log_settled(...)` site (`:240` decide-settle inside the `ev.mode != "shell"` guard, `:264` pre-respawn guard, `:268` session_lease_held, `:295` lease_completion_lost, `:301` respawn_failed), add `driver.emit_settled(&ev.terminal_id, <same reason>, None);` immediately before the `log_settled` call. (Task 7 threads a real `resume_cycles` value into the breaker settle; Task 8 adds the one settle site that must NOT emit.)

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p freshell-ws auto_resume && cargo test -p freshell-ws --test auto_resume_e2e`
Expected: PASS (the integration e2e asserts frames on a real broadcast channel — if it asserts an exact frame sequence, extend it to accept/assert the new settle frame on the exhaustion path).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/src/auto_resume.rs crates/freshell-ws/tests
git commit -m "feat(auto-resume): settle frames on every silent settle path (znhn#3)"
```

---

### Task 7: Flap-loop circuit breaker (znhn 2 server half)

**Files:**
- Modify: `crates/freshell-ws/src/auto_resume.rs` (constants `:19-28`, env fns near `:106`, `CrashContext`/`decide` `:44-104`, hub `:143-306`, tests)
- Modify: `crates/freshell-server/src/main.rs` (registry window env wiring, near the `set_auto_kill_idle_minutes` precedent at `:291`)

**Interfaces:**
- Consumes: `emit_settled` (Task 6); `pub fn set_respawn_liveness_window_ms` (`freshell-terminal/src/registry.rs:743`, already exists).
- Produces (used by Tasks 11–12): settle reason `"flap_circuit_breaker"` with `resume_cycles: Some(n)`; env knobs `FRESHELL_AUTO_RESUME_MAX_CYCLES`, `FRESHELL_AUTO_RESUME_CYCLE_WINDOW_MS`, `FRESHELL_AUTO_RESUME_HEALTHY_LIFETIME_MS`, `FRESHELL_RESPAWN_LIVENESS_WINDOW_MS`; `pub(crate) struct HubConfig`; `pub(crate) struct ResumeHistory { attempts: u32, cycles: Vec<i64> }`.

- [ ] **Step 1: Write the failing `decide` tests** (pure, same style as `:696-838`):

```rust
    #[test]
    fn flap_circuit_breaker_settles_when_cycles_reach_max() {
        let ctx = CrashContext {
            exit_code: 1,
            mode: "claude",
            create_request_id: Some("cr1"),
            has_resumable_identity: true,
            lifetime_ms: i64::MAX, // healthy — attempts would reset
            prior_attempts: 0,
            cap_exhausted: false,
            recent_cycles: 5,
            max_cycles: 5,
        };
        assert_eq!(
            decide(&ctx, &[2_000, 10_000], AUTO_RESUME_HEALTHY_LIFETIME_MS),
            AutoResumeDecision::SettleExited { reason: "flap_circuit_breaker" }
        );
    }

    #[test]
    fn cycles_below_max_still_resume_even_when_healthy_reset_applies() {
        let ctx = CrashContext { recent_cycles: 4, max_cycles: 5, lifetime_ms: i64::MAX, prior_attempts: 0, exit_code: 1, mode: "claude", create_request_id: Some("cr1"), has_resumable_identity: true, cap_exhausted: false };
        assert_eq!(
            decide(&ctx, &[2_000, 10_000], AUTO_RESUME_HEALTHY_LIFETIME_MS),
            AutoResumeDecision::Resume { attempt: 1, delay_ms: 2_000 }
        );
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p freshell-ws auto_resume::tests::flap_circuit`
Expected: COMPILE FAIL — no such fields/signature.

- [ ] **Step 3: Implement policy + config** —

Constants + env fns (next to `AUTO_RESUME_HEALTHY_LIFETIME_MS`):

```rust
/// Flap circuit breaker (kata znhn item 2, user ruling: bounded-and-loud,
/// never infinite-and-silent). A "cycle" is one SUCCESSFUL auto-resume.
/// Cycles are pruned to a rolling window at each crash and are NEVER reset
/// by healthy generations — that is the cross-reset bound (it also bounds
/// the out-of-band `kill` resurrection loop). When a crash arrives with
/// cycles >= max, settle exited instead of resuming; Relaunch stays
/// available.
pub(crate) const AUTO_RESUME_DEFAULT_MAX_CYCLES: u32 = 5;
pub(crate) const AUTO_RESUME_DEFAULT_CYCLE_WINDOW_MS: i64 = 3_600_000;

fn env_parse<T: std::str::FromStr + PartialOrd + Default>(name: &str, default: T) -> T {
    std::env::var(name)
        .ok()
        .and_then(|raw| raw.trim().parse::<T>().ok())
        .filter(|v| *v > T::default())
        .unwrap_or(default)
}

pub(crate) fn auto_resume_max_cycles() -> u32 {
    env_parse("FRESHELL_AUTO_RESUME_MAX_CYCLES", AUTO_RESUME_DEFAULT_MAX_CYCLES)
}
pub(crate) fn auto_resume_cycle_window_ms() -> i64 {
    env_parse("FRESHELL_AUTO_RESUME_CYCLE_WINDOW_MS", AUTO_RESUME_DEFAULT_CYCLE_WINDOW_MS)
}
/// e2e knob: shrinking this lets tests exercise healthy-reset flap loops in
/// milliseconds. Production default matches the frozen 30s semantics.
pub(crate) fn auto_resume_healthy_lifetime_ms() -> i64 {
    env_parse("FRESHELL_AUTO_RESUME_HEALTHY_LIFETIME_MS", AUTO_RESUME_HEALTHY_LIFETIME_MS)
}
```
(If the generic `env_parse` fights the type system, write three small concrete fns instead — same behavior: `>0` or default.)

Hub config + history:

```rust
#[derive(Debug, Clone)]
pub(crate) struct HubConfig {
    pub delays: Vec<u64>,
    pub healthy_lifetime_ms: i64,
    pub max_cycles: u32,
    pub cycle_window_ms: i64,
}

impl HubConfig {
    pub(crate) fn from_env() -> Self {
        Self {
            delays: auto_resume_delays(),
            healthy_lifetime_ms: auto_resume_healthy_lifetime_ms(),
            max_cycles: auto_resume_max_cycles(),
            cycle_window_ms: auto_resume_cycle_window_ms(),
        }
    }
}

/// Per-createRequestId resume history. `attempts` is the consecutive
/// fast-fail budget (reset by a healthy generation); `cycles` is the
/// wall-clock record of every successful auto-resume, pruned to the rolling
/// window — deliberately NOT reset by healthy generations.
#[derive(Debug, Default, Clone)]
pub(crate) struct ResumeHistory {
    pub attempts: u32,
    pub cycles: Vec<i64>,
}
```

`decide` changes: `CrashContext` gains `pub recent_cycles: u32, pub max_cycles: u32`; signature becomes `decide(ctx: &CrashContext<'_>, delays: &[u64], healthy_lifetime_ms: i64)`; insert after the identity checks and **before** `cap_exhausted`:

```rust
    if ctx.recent_cycles >= ctx.max_cycles {
        return AutoResumeDecision::SettleExited { reason: "flap_circuit_breaker" };
    }
```
and replace the `AUTO_RESUME_HEALTHY_LIFETIME_MS` use in the healthy-reset with the `healthy_lifetime_ms` parameter.

Hub changes:
- `spawn_hub_with_driver(driver, rx, cfg: HubConfig)` (was `delays: Vec<u64>`); `run_hub_body(driver, rx, cfg: &HubConfig, attempts: &mut HashMap<String, ResumeHistory>)`. `spawn_auto_resume_hub` builds `HubConfig::from_env()`; `spawn_auto_resume_hub_with_delays` builds `HubConfig { delays, ..HubConfig::from_env() }`.
- Per event (when `create_request_id` is present): prune + read before deciding —

```rust
                let now = crate::terminal::now_ms(); // or the module's existing now-ms helper
                let (prior_attempts, recent_cycles) = match &ev.create_request_id {
                    Some(k) => {
                        let h = attempts.entry(k.clone()).or_default();
                        h.cycles.retain(|t| now - *t <= cfg.cycle_window_ms);
                        (h.attempts, h.cycles.len() as u32)
                    }
                    None => (0, 0),
                };
```
- Eviction branch (`:242-246`): **reset attempts only, keep cycles** — replace `attempts.remove(k)` with `if let Some(h) = attempts.get_mut(k) { h.attempts = 0; }` (the existing "never evicted on exhaustion" posture is preserved; cycles must survive healthy resets by design).
- Attempt write (`:251`): `attempts.entry(key.clone()).or_default().attempts = attempt;`
- Breaker settle: in the settle branch, thread the count — `driver.emit_settled(&ev.terminal_id, reason, if reason == "flap_circuit_breaker" { Some(recent_cycles) } else { None });`
- On successful respawn (the `emit_replaced` arm): `attempts.entry(key.clone()).or_default().cycles.push(crate::terminal::now_ms());` (re-fetch the entry — the earlier borrow ended before the awaits).

`main.rs` registry window wiring (near `:291`):

```rust
    // e2e knob (kata znhn item 2): sub-second flap cycles would trip the
    // registry generation cap (3 per 30s liveness window) before the hub's
    // circuit breaker can ever fire. Production default unchanged.
    if let Some(ms) = std::env::var("FRESHELL_RESPAWN_LIVENESS_WINDOW_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .filter(|v| *v > 0)
    {
        registry.set_respawn_liveness_window_ms(ms);
        tracing::info!(ms, "respawn_liveness_window_override");
    }
```

- [ ] **Step 4: Write + run the failing hub tests, then make green** — update all existing hub tests to the `HubConfig` signature (use a helper `fn test_cfg(delays: Vec<u64>) -> HubConfig { HubConfig { delays, healthy_lifetime_ms: AUTO_RESUME_HEALTHY_LIFETIME_MS, max_cycles: AUTO_RESUME_DEFAULT_MAX_CYCLES, cycle_window_ms: AUTO_RESUME_DEFAULT_CYCLE_WINDOW_MS } }`), then add:

```rust
    #[tokio::test]
    async fn flap_loop_trips_the_circuit_breaker_and_settles_loud() {
        // 3 healthy flap cycles (lifetime >= healthy: attempts reset each
        // time — today this loops forever), then crash #4 must settle with
        // the breaker reason + typed cycle count, and respawn nothing.
        let (driver, tx, handle) = /* FakeDriver harness as in :1078 */;
        // cfg: max_cycles 3, healthy_lifetime_ms 1 (every lifetime is "healthy")
        for _ in 0..3 {
            tx.send(crash_event_with_lifetime(60_000)).unwrap();
            // drain: expect recovering + replaced
        }
        tx.send(crash_event_with_lifetime(60_000)).unwrap();
        // drain: expect NO recovering, NO replaced
        let settled = driver.settled_frames();
        assert_eq!(settled.last().unwrap(), &("t1".to_string(), "flap_circuit_breaker".to_string(), Some(3)));
        assert_eq!(driver.respawn_count(), 3, "no 4th respawn");
    }

    #[tokio::test]
    async fn cycle_window_prunes_old_cycles_and_the_loop_may_continue() {
        // cfg: max_cycles 2, cycle_window_ms 1 — every prior cycle is stale
        // by the time the next crash arrives, so the breaker never trips.
        // 4 crash/resume rounds all succeed (4 replaced frames, no breaker).
    }

    #[tokio::test]
    async fn healthy_generations_reset_attempts_but_never_cycles() {
        // Interleave: fast-fail crash (attempt 1) → healthy crash (attempts
        // reset) → verify the successful resumes still accumulated cycles by
        // tripping the breaker at the configured max.
    }
```
(Write the bodies against the existing `FakeDriver` helpers — `drain()`, the crash-event constructor, and frame accessors are at `:893-1076`; follow `healthy_generation_resets_attempts` (`:1145`) for the event/lifetime idiom. FakeDriver gains a `respawn_count()` helper if one doesn't already exist.)

Run: `cargo test -p freshell-ws auto_resume`
Expected: FAIL first (missing helpers/logic), then PASS after wiring per Step 3.

- [ ] **Step 5: Full crate + workspace check**

Run: `cargo test -p freshell-ws && cargo test -p freshell-server 2>&1 | tail -3 && cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-ws/src/auto_resume.rs crates/freshell-server/src/main.rs
git commit -m "feat(auto-resume): flap-loop circuit breaker — bounded and loud (znhn#2)"
```

---

### Task 8: `terminal.autoResumeCancel` — protocol + server handling (znhn 2 cancel half)

**Files:**
- Modify: `crates/freshell-protocol/src/client_messages.rs` (enum `:17+`, `CLIENT_MESSAGE_TYPES` `:84-114`)
- Modify: `crates/freshell-protocol/tests/inventory.rs` (`:33`, `:38` — hardcoded `29`s → `30`; total `86` → `87`)
- Modify: `crates/freshell-protocol/tests/roundtrip.rs`
- Modify: `shared/ws-protocol.ts` (new schema + `ClientMessageSchema` union at `:654`)
- Modify: `server/ws-handler.ts` (case arm before the `default:` at `:3786`)
- Modify: `crates/freshell-ws/src/lib.rs` (`WsState` field), `crates/freshell-ws/src/terminal.rs` (match arm `:520+` + handler), `crates/freshell-ws/src/auto_resume.rs` (`take_cancel` on driver + hub guard + FakeDriver), `crates/freshell-ws/tests/common/mod.rs` (WsState literals)
- Regenerate: `port/contract/*.json`

**Interfaces:**
- Consumes: `emit_settled`/settle frame (Tasks 5–6); dispatch pattern of `handle_client_text` (`terminal.rs:483-520`, exhaustive match, arms return `bool`); `handle_kill(kill: TerminalKill, ws_tx: &mut WsSink, state: &WsState) -> bool` (`:3847`) as the shape template.
- Produces (used by Tasks 9, 12): client→server message `{ type: 'terminal.autoResumeCancel', terminalId: string }`; on receipt the server broadcasts the settle frame immediately (reason `"auto-resume cancelled"`) and the hub's pending resume aborts silently; `WsState.auto_resume_cancels: Arc<std::sync::Mutex<std::collections::HashSet<String>>>`; driver method `fn take_cancel(&self, terminal_id: &str) -> bool`.

- [ ] **Step 1: Write the failing protocol tests** —

`roundtrip.rs`:

```rust
#[test]
fn terminal_auto_resume_cancel_roundtrips() {
    let json = serde_json::json!({"type": "terminal.autoResumeCancel", "terminalId": "t1"});
    let msg: ClientMessage = serde_json::from_value(json.clone()).unwrap();
    match &msg {
        ClientMessage::TerminalAutoResumeCancel(c) => assert_eq!(c.terminal_id, "t1"),
        other => panic!("wrong variant: {other:?}"),
    }
    assert_eq!(serde_json::to_value(&msg).unwrap(), json);
}
```

Run: `cargo test -p freshell-protocol --test roundtrip terminal_auto_resume_cancel` — expect COMPILE FAIL.

- [ ] **Step 2: Implement the protocol crate** — `client_messages.rs`:

```rust
/// znhn item 2: the user opts out of an in-flight auto-resume ("stop
/// trying, leave it dead"). Carries the OLD (crashed) terminal id — the
/// same id the recovering `terminal.status` frame was broadcast with.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAutoResumeCancel {
    pub terminal_id: String,
}
```
Enum variant (in the `#[serde(tag = "type")]` enum, matching neighbors' style):

```rust
    #[serde(rename = "terminal.autoResumeCancel")]
    TerminalAutoResumeCancel(TerminalAutoResumeCancel),
```
`CLIENT_MESSAGE_TYPES` becomes `[&str; 30]` with `"terminal.autoResumeCancel"` inserted alphabetically (between `terminal.attach` and `terminal.codex.candidate.persisted`). Update `inventory.rs` hardcoded counts: `29` → `30` (both sites) and the combined `86` → `87`.

- [ ] **Step 3: Implement the Rust server handling** —

`crates/freshell-ws/src/lib.rs` — add to `WsState`:

```rust
    /// Pending user cancels for planned auto-resumes, keyed by the OLD
    /// (crashed) terminal id (znhn item 2). Inserted by the WS handler,
    /// consumed by the hub's post-sleep guard. Bounded: one entry per
    /// cancel click, removed on consumption.
    pub auto_resume_cancels: std::sync::Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
```
Fix every `WsState { ... }` literal the compiler reports (production wiring in `freshell-server/src/main.rs`, harness literals in `crates/freshell-ws/tests/common/mod.rs:157,233,313,390,475,556,636,718`, and any unit-test literals) with `auto_resume_cancels: Default::default(),`.

`crates/freshell-ws/src/terminal.rs` — match arm (the enum match at `:520` is exhaustive; place near the `terminal.kill` arm at `:696`):

```rust
        ClientMessage::TerminalAutoResumeCancel(cancel) => {
            handle_auto_resume_cancel(cancel, state);
            true
        }
```
Handler (near `handle_kill`):

```rust
/// znhn item 2: flag the pending resume for the hub's post-sleep guard AND
/// settle the client IMMEDIATELY — the notice must clear on click, not
/// after the backoff sleep completes. The hub consumes the flag and settles
/// silently (this frame is the loud half).
fn handle_auto_resume_cancel(cancel: TerminalAutoResumeCancel, state: &WsState) {
    state
        .auto_resume_cancels
        .lock()
        .expect("auto_resume_cancels lock")
        .insert(cancel.terminal_id.clone());
    let msg = freshell_protocol::ServerMessage::TerminalStatus(freshell_protocol::TerminalStatus {
        status: freshell_protocol::RuntimeStatus::Exited,
        terminal_id: cancel.terminal_id.clone(),
        attempt: None,
        max_attempts: None,
        exit_code: None,
        reason: Some("auto-resume cancelled".to_string()),
        resume_cycles: None,
    });
    if let Ok(json) = serde_json::to_string(&msg) {
        let _ = state.broadcast_tx.send(json);
    }
    tracing::info!(terminal_id = %cancel.terminal_id, "terminal.auto_resume.user_cancelled");
}
```
(Import `TerminalAutoResumeCancel` alongside the other client-message imports.)

`auto_resume.rs` — trait method + impls + hub guard:

```rust
    /// Consume a pending user cancel for this terminal id (znhn item 2).
    fn take_cancel(&self, terminal_id: &str) -> bool;
```
`WsAutoResumeDriver`: `self.state.auto_resume_cancels.lock().expect("auto_resume_cancels lock").remove(terminal_id)`.
`FakeDriver`: a `Mutex<HashSet<String>>` + test helper `set_cancelled(&self, terminal_id: &str)`.
Hub: FIRST post-sleep guard (before `pre_respawn_guard`):

```rust
                    if driver.take_cancel(&ev.terminal_id) {
                        // The cancel handler already broadcast the settle
                        // frame — log only, no second frame.
                        driver.log_settled(&ev.terminal_id, "user_cancelled");
                        continue;
                    }
```

- [ ] **Step 4: Write + run the failing hub test, then green** —

```rust
    #[tokio::test]
    async fn user_cancel_during_backoff_aborts_the_respawn_silently() {
        // Crash schedules a resume; the cancel lands during the backoff.
        // The hub must consume the flag, respawn NOTHING, and emit NO
        // settle frame of its own (the WS handler's immediate frame is the
        // loud half).
        // <FakeDriver harness>; driver.set_cancelled("t1") BEFORE sending
        // the crash event (the flag is checked post-sleep).
        // after drain(): respawn_count == 0; settled_frames() is EMPTY;
        // log records contain ("t1", "user_cancelled").
    }
```
Run: `cargo test -p freshell-ws auto_resume && cargo test -p freshell-protocol`
Expected: PASS.

- [ ] **Step 5: TS + Node side + contract regen** —

`shared/ws-protocol.ts` (mirror the `terminal.detach` schema's exact style, and add to the `ClientMessageSchema` union at `:654`):

```ts
export const TerminalAutoResumeCancelSchema = z.object({
  type: z.literal('terminal.autoResumeCancel'),
  /** The OLD (crashed) terminal id from the recovering notice frame. */
  terminalId: z.string(),
})
export type TerminalAutoResumeCancelMessage = z.infer<typeof TerminalAutoResumeCancelSchema>
```

`server/ws-handler.ts` — a case arm above the `default:` (`:3786`):

```ts
      case 'terminal.autoResumeCancel':
        // Rust-only feature: agent auto-resume lives in freshell-ws. The
        // Node server has no auto-resume hub — accept and ignore so a valid
        // client message never triggers UNKNOWN_MESSAGE.
        break
```

```bash
npm run contract:generate
cargo test -p freshell-protocol
npm run test:port
```
Expected: PASS — inventory JSON now lists 30 client types.

- [ ] **Step 6: Full gates + commit (ONE commit — protocol change + pins together)**

Run: `cargo test --workspace 2>&1 | tail -5 && cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings && npx vitest run --config config/vitest/vitest.port.config.ts 2>&1 | tail -3`
Expected: PASS.

```bash
git add crates/freshell-protocol crates/freshell-ws shared/ws-protocol.ts server/ws-handler.ts port/contract
git commit -m "feat(auto-resume): terminal.autoResumeCancel — user opts out of an in-flight resume (znhn#2)"
```

---

### Task 9: Client — frame-driven notices, TTL deletion, cancel button (znhn 2+3+6 client half)

**Files:**
- Modify: `src/store/terminalLifecycleSlice.ts`
- Modify: `src/components/TerminalView.tsx` (TTL timer `:603-619`, `terminal.status` handler `:4353-4390`, banner mount `:5333-5356`)
- Modify: `src/components/TerminalExitBanner.tsx`
- Modify: `test/unit/client/store/terminalLifecycleSlice.test.ts`, `test/unit/client/components/TerminalView.exitBanner.test.tsx`, `test/unit/client/components/TerminalExitBanner.test.tsx`

**Interfaces:**
- Consumes: settle frame `terminal.status { status: 'exited', terminalId, resumeCycles? }` (Tasks 5–8); `terminal.autoResumeCancel` send (Task 8); `WsClient.send(msg: unknown)` (`src/lib/ws-client.ts:681`; TerminalView already holds `const ws = useMemo(() => getWsClient(), [])` at `:622` and calls e.g. `ws.send({ type: 'terminal.detach', terminalId: tid })` at `:2889`; tests mock it via the hoisted `wsMocks.send`).
- Produces (used by Tasks 10–12): slice action `recordAutoResumeSettled({ paneId, resumeCycles?, at })`; `PaneLifecycleEntry.settle?: { resumeCycles?: number; at: number }`; selector `selectResumeCycles(root, paneId)`; `TerminalExitBannerProps.onCancelAutoResume`; NO TTL anywhere (constant, selector filter, and re-render timer all deleted).

- [ ] **Step 1: Write the failing tests** —

Replace the TTL-degradation test (`TerminalView.exitBanner.test.tsx:363-391`) with the frame-driven pair (this is ALSO the znhn item 6 pin — the alert can never appear while a resume is pending, at any delay value):

```tsx
  it('keeps the recovering notice up indefinitely without a settle frame (no timer degradation — znhn#6 pin)', async () => {
    vi.useFakeTimers()
    // seed: lifecycle { lastTerminalId: 'term-crashed', exit: { exitCode: 1, at: Date.now() },
    //   notice: { kind: 'recovering', attempt: 1, maxAttempts: 2, exitCode: 1, at: Date.now() } }, status 'exited'
    await act(async () => {
      vi.advanceTimersByTime(120_000)
    })
    expect(screen.getByText('claude crashed (exit 1) — auto-resuming, attempt 1/2')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    vi.useRealTimers()
  })

  it('clears the recovering notice the moment the settle frame arrives', async () => {
    // same seed; then:
    await act(async () => {
      messageHandler!({ type: 'terminal.status', terminalId: 'term-crashed', status: 'exited', reason: 'pane_closed' })
    })
    expect(screen.queryByText(/auto-resuming/)).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent('process exited (code 1)')
  })

  it('cancel button sends terminal.autoResumeCancel with the old terminal id', async () => {
    // same recovering seed; then:
    fireEvent.click(screen.getByRole('button', { name: 'Cancel auto-resume for claude' }))
    expect(wsMocks.send).toHaveBeenCalledWith({ type: 'terminal.autoResumeCancel', terminalId: 'term-crashed' })
  })
```
(Use the file's existing `makeStore`/`renderPane` harness at `:27-185`; explicit `cleanup()` stays in `afterEach`.)

Slice tests (`terminalLifecycleSlice.test.ts`): replace the TTL-expiry case with:

```ts
  it('selectActiveNoticeFrom returns the notice with no TTL — settles are frame-driven', () => { /* seed notice with at: 0; expect returned regardless of now */ })
  it('recordAutoResumeSettled clears the notice and records resumeCycles', () => { /* dispatch; expect entry.notice undefined, entry.settle = { resumeCycles: 3, at } */ })
```

Banner test (`TerminalExitBanner.test.tsx`): the recovering-notice case now also asserts the cancel button (`getByRole('button', { name: 'Cancel auto-resume for claude' })`).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/unit/client/components/TerminalView.exitBanner.test.tsx test/unit/client/store/terminalLifecycleSlice.test.ts test/unit/client/components/TerminalExitBanner.test.tsx`
Expected: FAIL (no cancel button, TTL still active, no `recordAutoResumeSettled`).

- [ ] **Step 3: Implement the slice** — `terminalLifecycleSlice.ts`:
- Delete `export const AUTO_RESUME_NOTICE_TTL_MS = 30_000`.
- `PaneLifecycleEntry` gains `settle?: { resumeCycles?: number; at: number }`.
- New reducer:

```ts
    // Settle frame (terminal.status status:'exited') — the deterministic
    // replacement for the old 30s TTL guess (znhn item 3).
    recordAutoResumeSettled(
      state,
      action: PayloadAction<{ paneId: string; resumeCycles?: number; at: number }>
    ) {
      const entry = (state.byPaneId[action.payload.paneId] ??= {})
      delete entry.notice
      entry.settle = {
        at: action.payload.at,
        ...(action.payload.resumeCycles !== undefined
          ? { resumeCycles: action.payload.resumeCycles }
          : {}),
      }
    },
```
- TTL removal in the selector (and drop the dead `now` params):

```ts
export const selectActiveNoticeFrom = (s: TerminalLifecycleState | undefined, paneId: string) =>
  s?.byPaneId[paneId]?.notice
export const selectActiveNotice = (root: { terminalLifecycle?: TerminalLifecycleState }, paneId: string) =>
  selectActiveNoticeFrom(root.terminalLifecycle, paneId)
export const selectResumeCycles = (root: { terminalLifecycle?: TerminalLifecycleState }, paneId: string) =>
  root.terminalLifecycle?.byPaneId[paneId]?.settle?.resumeCycles
```
- Export `recordAutoResumeSettled` with the other actions.

- [ ] **Step 4: Implement TerminalView + banner** —
- Delete the TTL re-render block (`TerminalView.tsx:603-619`: the `setNoticeExpiryTick` state + effect) and the `AUTO_RESUME_NOTICE_TTL_MS` import; change `selectActiveNotice(s, paneId, Date.now())` → `selectActiveNotice(s, paneId)`.
- In the `terminal.status` handler (`:4353-4390`), after `statusMine` is computed, add:

```tsx
        if (statusMine && msg.status === 'exited') {
          dispatch(
            recordAutoResumeSettled({
              paneId: paneIdRef.current,
              resumeCycles: msg.resumeCycles,
              at: Date.now(),
            })
          )
        }
```
(Guard the existing `updateContent({ status })`/`updateTab({ status })` branch so a settle frame for a dead old terminal doesn't touch live content — it already only fires when `msg.terminalId === tid`, which is cleared on exit; verify and leave as-is.)
- Banner wiring: pass `onCancelAutoResume` at the mount (`:5333-5356`):

```tsx
            onCancelAutoResume={() => {
              const lastTid = selectLastTerminalIdFrom(
                appStore.getState().terminalLifecycle,
                paneId
              )
              if (lastTid) ws.send({ type: 'terminal.autoResumeCancel', terminalId: lastTid })
            }}
```
- `TerminalExitBanner.tsx`: add `onCancelAutoResume: () => void` to props; the notice branch becomes:

```tsx
  if (notice) {
    return (
      <div
        role="status"
        className="flex items-center justify-between gap-2 border-t border-amber-500/30 bg-amber-500/15 px-3 py-1.5 text-sm text-amber-600 dark:text-amber-400"
      >
        <span>
          {mode} crashed (exit {notice.exitCode}) — auto-resuming, attempt {notice.attempt}/{notice.maxAttempts}
        </span>
        <button
          type="button"
          aria-label={`Cancel auto-resume for ${mode}`}
          className="shrink-0 rounded border border-amber-500/40 px-2 py-0.5 text-xs font-medium hover:bg-amber-500/20"
          onClick={onCancelAutoResume}
        >
          Stop
        </button>
      </div>
    )
  }
```
(The `verb` ternary disappears here — Task 10 retires the `'resumed'` kind; until Task 10 lands, keep the ternary if any test still exercises `'resumed'`.)

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/unit/client/components/TerminalView.exitBanner.test.tsx test/unit/client/store/terminalLifecycleSlice.test.ts test/unit/client/components/TerminalExitBanner.test.tsx && npm run lint 2>&1 | tail -3`
Expected: PASS, lint clean.

- [ ] **Step 6: Commit**

```bash
git add src/store/terminalLifecycleSlice.ts src/components/TerminalView.tsx src/components/TerminalExitBanner.tsx test/unit/client
git commit -m "feat(client): frame-driven auto-resume notices — delete the 30s TTL, add cancel (znhn#2,#3,#6)"
```

---

### Task 10: Persistent crash trace on pane content (znhn 1)

**Files:**
- Modify: `src/store/paneTypes.ts:71-103` (`TerminalPaneContent`)
- Modify: `src/store/panesSlice.ts` (reducers near `setPaneReconcileNotice`/`clearPaneReconcileNotice` at `:2080-2096`, exports at `:2236-2237`)
- Modify: `src/store/terminalLifecycleSlice.ts` (`foldTerminalReplacement`)
- Modify: `src/components/TerminalView.tsx` (`terminal.replaced` handler `:4392-4423`, `showExitBanner` `:5209-5215`, banner mount)
- Modify: `src/components/TerminalExitBanner.tsx`
- Modify: `test/unit/client/store/panesPersistence.test.ts`, `test/unit/client/components/TerminalView.exitBanner.test.tsx`, `test/unit/client/components/TerminalExitBanner.test.tsx`, `test/unit/client/store/terminalLifecycleSlice.test.ts`
- Modify: `docs/plans/2026-07-27-agent-crash-resilience.md` (§D-5, one sentence)

**Interfaces:**
- Consumes: `terminal.replaced` frame (existing); denylist persistence (`stripTransientSessionFields` — do NOT add `crashTrace` there); `findReconcileTerminalContent(state, paneId)` traversal helper (`panesSlice.ts:618`).
- Produces (used by Tasks 11–12): `export type CrashTrace = { exitCode: number; resumedAtMs: number }` in `paneTypes.ts`; `TerminalPaneContent.crashTrace?: CrashTrace`; actions `setPaneCrashTrace({ paneId, crashTrace })` and `clearPaneCrashTrace({ paneId })`; banner props `crashTrace: CrashTrace | null`, `onDismissCrashTrace: () => void`; trace UI = `role="status"` + `data-testid="crash-trace"`, copy `"{mode} crashed (exit {N}) & auto-resumed at {HH:MM}"`, dismiss button aria-label `` `Dismiss ${mode} crash notice` ``.

- [ ] **Step 1: Write the failing tests** —

`panesPersistence.test.ts` (follow the file's existing round-trip idiom at `:207`/`:362`):

```ts
  it('crashTrace persists across a panes round-trip (denylist keeps new fields)', () => {
    // seed a terminal pane whose content includes
    //   crashTrace: { exitCode: 1, resumedAtMs: 1_753_760_220_000 }
    // run the same persist -> load cycle as the durable-identity test at :362
    // expect the loaded pane content to still carry the exact crashTrace
  })
```

`TerminalView.exitBanner.test.tsx`:

```tsx
  it('terminal.replaced writes a persistent crash trace onto pane content and shows the trace strip', async () => {
    // seed: recovering notice for 'term-crashed', pane status 'running'
    await act(async () => {
      messageHandler!({ type: 'terminal.replaced', oldTerminalId: 'term-crashed', newTerminalId: 'term-new', exitCode: 1, attempt: 1, maxAttempts: 2 })
    })
    const trace = screen.getByTestId('crash-trace')
    expect(trace).toHaveTextContent(/claude crashed \(exit 1\) & auto-resumed at \d{2}:\d{2}/)
    expect(trace).toHaveAttribute('role', 'status')
    expect(screen.queryByRole('alert')).toBeNull()
    // and the store now carries it on pane CONTENT (persisted home):
    // walk store.getState().panes... leaf content.crashTrace === { exitCode: 1, resumedAtMs: <number> }
  })

  it('dismissing the crash trace clears it from pane content', async () => {
    // seed pane content with crashTrace directly via makeStore
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss claude crash notice' }))
    expect(screen.queryByTestId('crash-trace')).toBeNull()
  })
```

`terminalLifecycleSlice.test.ts`:

```ts
  it('foldTerminalReplacement clears the notice (the persistent crash trace replaces the resumed strip)', () => {
    // seed entry with a recovering notice; dispatch foldTerminalReplacement;
    // expect entry.notice undefined, entry.exit undefined, lastTerminalId advanced
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/unit/client/store/panesPersistence.test.ts test/unit/client/components/TerminalView.exitBanner.test.tsx test/unit/client/store/terminalLifecycleSlice.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** —

`paneTypes.ts` (above `TerminalPaneContent`):

```ts
/** Persistent crash trace (kata znhn item 1): "crashed & auto-resumed" —
 * survives reload (pane-content persistence is a denylist) until the user
 * dismisses it or the pane closes. */
export type CrashTrace = {
  /** Exit code of the crashed generation. */
  exitCode: number
  /** Wall-clock ms when the auto-resume succeeded. */
  resumedAtMs: number
}
```
Field on `TerminalPaneContent` (after `reconcileEpoch`):

```ts
  /** znhn item 1: persisted deliberately — do NOT add to
   * stripTransientSessionFields. Absent on old layouts = no trace. */
  crashTrace?: CrashTrace
```

`panesSlice.ts` (mirror `setPaneReconcileNotice`/`clearPaneReconcileNotice` at `:2080-2096` exactly, same traversal helper):

```ts
    // znhn item 1: persistent crash trace — written on terminal.replaced,
    // cleared only by user dismissal (pane close deletes the pane node).
    setPaneCrashTrace(
      state,
      action: PayloadAction<{ paneId: string; crashTrace: CrashTrace }>
    ) {
      const content = findReconcileTerminalContent(state, action.payload.paneId)
      if (content) content.crashTrace = action.payload.crashTrace
    },
    clearPaneCrashTrace(state, action: PayloadAction<{ paneId: string }>) {
      const content = findReconcileTerminalContent(state, action.payload.paneId)
      if (content && content.crashTrace) delete content.crashTrace
    },
```
(Match the helper's real signature — if `clearPaneReconcileNotice` calls it differently, copy that call shape.) Export both actions at `:2236-2237` alongside the others; import `CrashTrace` from `./paneTypes`.

`terminalLifecycleSlice.ts` — in `foldTerminalReplacement`, replace the `kind: 'resumed'` notice assignment with `delete e.notice` (keep the `delete e.exit` + `lastTerminalId` advance). Narrow `AutoResumeNotice.kind` to `'recovering'` and update any test-harness types that referenced `'resumed'`.

`TerminalView.tsx` — in the `terminal.replaced` handler (`:4392-4423`), after `foldTerminalReplacement(...)`:

```tsx
          dispatch(
            setPaneCrashTrace({
              paneId: paneIdRef.current,
              crashTrace: { exitCode: msg.exitCode, resumedAtMs: Date.now() },
            })
          )
```
`showExitBanner` (`:5209-5215`) gains the trace condition:

```tsx
  const showExitBanner = Boolean(
    isAgentPane && (
      activeNotice ||
      terminalContent.crashTrace ||
      (terminalContent.status === 'exited' && (exitRecord ? exitRecord.exitCode !== 0 : true)) ||
      (terminalContent.status === 'error' && exitRecord && exitRecord.exitCode !== 0)
    )
  )
```
Banner mount gains:

```tsx
            crashTrace={terminalContent.crashTrace ?? null}
            settledDead={
              (terminalContent.status === 'exited' && (exitRecord ? exitRecord.exitCode !== 0 : true)) ||
              (terminalContent.status === 'error' && Boolean(exitRecord && exitRecord.exitCode !== 0))
            }
            onDismissCrashTrace={() => dispatch(clearPaneCrashTrace({ paneId }))}
```
(Hoist the two settled-dead sub-expressions into a `const settledDead = ...` used by both `showExitBanner` and the prop — DRY.)

`TerminalExitBanner.tsx` — new props + third branch (precedence: notice → alert → trace):

```tsx
import type { AutoResumeNotice } from '../store/terminalLifecycleSlice'
import type { CrashTrace } from '../store/paneTypes'

export interface TerminalExitBannerProps {
  mode: string
  exitCode: number | null
  notice: AutoResumeNotice | null
  crashTrace: CrashTrace | null
  settledDead: boolean
  onRelaunch: () => void
  onCancelAutoResume: () => void
  onDismissCrashTrace: () => void
}
```
After the notice branch, wrap the existing alert in `if (settledDead) { ...existing alert JSX... }`, then:

```tsx
  if (crashTrace) {
    const d = new Date(crashTrace.resumedAtMs)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return (
      <div
        role="status"
        data-testid="crash-trace"
        className="flex items-center justify-between gap-2 border-t border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-sm text-amber-600 dark:text-amber-400"
      >
        <span>
          {mode} crashed (exit {crashTrace.exitCode}) &amp; auto-resumed at {hh}:{mm}
        </span>
        <button
          type="button"
          aria-label={`Dismiss ${mode} crash notice`}
          className="shrink-0 rounded border border-amber-500/40 px-2 py-0.5 text-xs font-medium hover:bg-amber-500/20"
          onClick={onDismissCrashTrace}
        >
          Dismiss
        </button>
      </div>
    )
  }
  return null
```

`docs/plans/2026-07-27-agent-crash-resilience.md` — append one bullet to §D-5 (after the schedule bullet at `:67`):

```markdown
- Patience-window honesty (council 7w4h/xkhx follow-up): the total patience window is ~12s of backoff (2s + 10s) plus spawn time — outage-class causes (provider down, expired auth) will exhaust the budget and settle loudly. By design: auto-resume survives crashes, not outages.
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/unit/client && npm run lint 2>&1 | tail -3`
Expected: PASS (fix any collateral in `TerminalExitBanner.test.tsx` — the pure-component tests now need the new required props; add `crashTrace: null, settledDead: true/false, onCancelAutoResume: () => {}, onDismissCrashTrace: () => {}` to their prop fixtures).

- [ ] **Step 5: Commit**

```bash
git add src/store src/components docs/plans/2026-07-27-agent-crash-resilience.md test/unit/client
git commit -m "feat(client): persistent dismissible crash trace on pane content (znhn#1)"
```

---

### Task 11: Honest banner copy — Relaunch + circuit-breaker (znhn 5 + znhn 2 client tail)

**Files:**
- Modify: `src/components/TerminalExitBanner.tsx` (alert branch)
- Modify: `src/components/TerminalView.tsx` (banner mount props)
- Modify: `test/unit/client/components/TerminalExitBanner.test.tsx`, `test/unit/client/components/TerminalView.exitBanner.test.tsx`

**Interfaces:**
- Consumes: `selectResumeCycles(root, paneId)` (Task 9); `resetPaneForReconcileCreate`'s provider-match rule (`panesSlice.ts:1960-1976` — Relaunch resumes the same conversation ONLY when `sessionRef.provider === content.mode`, else it loudly degrades to fresh).
- Produces: banner props `resumeCycles: number | null`, `canResume: boolean`; alert copy `"{mode} crashed {N} times — auto-resume paused"` when `resumeCycles != null`; button text `"Relaunch — resumes this conversation"` when `canResume`, plain `"Relaunch"` otherwise; aria-label stays `` `Relaunch ${mode} session` `` (e2e locators depend on it).

- [ ] **Step 1: Write the failing tests** (`TerminalExitBanner.test.tsx`):

```tsx
  it('says the relaunch resumes the same conversation when the sessionRef matches', () => {
    render(<TerminalExitBanner mode="claude" exitCode={1} notice={null} crashTrace={null} settledDead resumeCycles={null} canResume onRelaunch={noop} onCancelAutoResume={noop} onDismissCrashTrace={noop} />)
    const btn = screen.getByRole('button', { name: 'Relaunch claude session' })
    expect(btn).toHaveTextContent('Relaunch — resumes this conversation')
  })

  it('keeps plain Relaunch copy when no matching sessionRef exists (degrades to fresh)', () => {
    // canResume={false} → text exactly 'Relaunch'
  })

  it('renders the circuit-breaker banner from the typed resumeCycles field', () => {
    // resumeCycles={5} → alert text 'claude crashed 5 times — auto-resume paused'
  })
```
And in `TerminalView.exitBanner.test.tsx`: a settle frame with `resumeCycles: 3` followed by the alert asserting `'claude crashed 3 times — auto-resume paused'`; plus a case asserting `canResume` derives from the seeded `sessionRef` (`withSessionRef: true` in the harness's `makeStore`).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/unit/client/components/TerminalExitBanner.test.tsx test/unit/client/components/TerminalView.exitBanner.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** — `TerminalExitBanner.tsx` props gain `resumeCycles: number | null` and `canResume: boolean`; the alert branch becomes:

```tsx
  if (settledDead) {
    return (
      <div
        role="alert"
        className="flex items-center justify-between gap-2 border-t border-destructive/30 bg-destructive/15 px-3 py-1.5 text-sm text-destructive"
      >
        <span>
          {resumeCycles != null
            ? `${mode} crashed ${resumeCycles} times — auto-resume paused`
            : `process exited${exitCode !== null ? ` (code ${exitCode})` : ''}`}
        </span>
        <button
          type="button"
          aria-label={`Relaunch ${mode} session`}
          className="shrink-0 rounded border border-destructive/40 px-2 py-0.5 text-xs font-medium hover:bg-destructive/20"
          onClick={onRelaunch}
        >
          {canResume ? 'Relaunch — resumes this conversation' : 'Relaunch'}
        </button>
      </div>
    )
  }
```
`TerminalView.tsx` mount:

```tsx
            resumeCycles={useAppSelectorValue /* see below */}
            canResume={Boolean(
              terminalContent.sessionRef && terminalContent.sessionRef.provider === terminalContent.mode
            )}
```
where the cycles value comes from a top-level `const resumeCycles = useAppSelector((s) => selectResumeCycles(s, paneId)) ?? null` next to the existing `exitRecord`/`activeNotice` selectors (hooks stay top-level — never inline in JSX).

- [ ] **Step 4: Run to verify pass + lint**

Run: `npx vitest run test/unit/client && npm run lint 2>&1 | tail -3`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components test/unit/client
git commit -m "feat(client): honest Relaunch copy + circuit-breaker banner (znhn#5, znhn#2)"
```

---

### Task 12: E2E — crash trace survives reload, breaker banner, cancel clears immediately

**Files:**
- Modify: `test/e2e-browser/fixtures/fake-crashing-claude-cli.mjs` (flap mode)
- Modify: `test/e2e-browser/specs/agent-crash-autoresume-rust.spec.ts` (3 new tests; adjust any copy assertions the earlier tasks changed)

**Interfaces:**
- Consumes: `bootRig(prefix, behaviorEnv)` (`spec:144-160` — owns a `RustServer` on an ephemeral port, installs the fake CLI, seeds `FRESHELL_AUTO_RESUME_DELAYS_MS: '100,200'` which `behaviorEnv` may override), `createClaudePane`, `autoResumeNotice(page)` (`spec:177`), `readArgvLog`, `teardownRig`, `connect(page, info)`; env knobs from Task 7; the reload-flush gotcha (persist is 500ms-debounced; `page.reload()` fires `pagehide` which flushes).
- Produces: green e2e coverage for the three headline behaviors; fixture env `FAKE_CRASH_LIVE_MS`.

- [ ] **Step 1: Fixture flap mode** — in `fake-crashing-claude-cli.mjs`, in the `always` behavior branch, honor a new env:

```js
// FAKE_CRASH_LIVE_MS=N — with FAKE_CRASH_MODE=always: stay alive N ms, then
// exit 1 (a "healthy flap": long enough to reset the retry budget when the
// server's healthy-lifetime knob is shrunk below N).
const liveMs = Number(process.env.FAKE_CRASH_LIVE_MS || '0')
if (liveMs > 0) {
  setTimeout(() => process.exit(1), liveMs)
  // keep the event loop alive exactly like the SURVIVE path does
} else {
  process.exit(1)
}
```
(Splice into the fixture's existing structure — reuse its existing "stay alive" mechanism from the `once`/SURVIVE path rather than inventing a new one.)

- [ ] **Step 2: Write the three tests** (append to the `test.describe` in `agent-crash-autoresume-rust.spec.ts`, following the rig/teardown pattern of the existing four):

```ts
  test('a persistent crash trace survives reload and is dismissible', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    test.setTimeout(240_000)
    let rig: Rig | undefined
    try {
      rig = await bootRig('trace', { FAKE_CRASH_MODE: 'once' })
      await createClaudePane(page, rig.info)

      const trace = page.getByTestId('crash-trace')
      await expect(trace).toBeVisible({ timeout: 30_000 })
      await expect(trace).toHaveText(/claude crashed \(exit 1\) & auto-resumed at \d{2}:\d{2}/)
      await expect(page.getByRole('alert')).toHaveCount(0)

      // The morning-user scenario: the trace survives a reload.
      await page.reload()
      await connect(page, rig.info)
      await expect(page.getByTestId('crash-trace')).toBeVisible({ timeout: 30_000 })

      // Dismiss → gone, and STAYS gone across another reload.
      await page.getByRole('button', { name: 'Dismiss claude crash notice' }).click()
      await expect(page.getByTestId('crash-trace')).toHaveCount(0)
      await page.reload()
      await connect(page, rig.info)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      await expect(page.getByTestId('crash-trace')).toHaveCount(0)
    } finally {
      await teardownRig(rig)
    }
  })

  test('a flap loop trips the circuit breaker: settles with the crashed-N-times banner', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    test.setTimeout(240_000)
    let rig: Rig | undefined
    try {
      rig = await bootRig('flap', {
        FAKE_CRASH_MODE: 'always',
        FAKE_CRASH_LIVE_MS: '1000',
        FRESHELL_AUTO_RESUME_DELAYS_MS: '100,200',
        // Each 1s generation counts as "healthy" (budget resets — the
        // forever-loop precondition) and stays under the registry window so
        // the generation cap never preempts the breaker.
        FRESHELL_AUTO_RESUME_HEALTHY_LIFETIME_MS: '500',
        FRESHELL_RESPAWN_LIVENESS_WINDOW_MS: '500',
        FRESHELL_AUTO_RESUME_MAX_CYCLES: '3',
      })
      await createClaudePane(page, rig.info)

      const alert = page.getByRole('alert').filter({ hasText: 'claude crashed 3 times — auto-resume paused' })
      await expect(alert).toBeVisible({ timeout: 60_000 })

      // Bounded: 1 original + 3 auto-resumes, then nothing more.
      await expect(async () => {
        expect((await readArgvLog(rig!.argvLog)).length).toBe(4)
      }).toPass({ timeout: 15_000 })
      await page.waitForTimeout(3_000)
      expect((await readArgvLog(rig.argvLog)).length, 'breaker must stay open').toBe(4)
      await expect(page.getByRole('button', { name: 'Relaunch claude session' })).toBeVisible()
    } finally {
      await teardownRig(rig)
    }
  })

  test('cancel clears the recovering notice immediately and no respawn happens', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    test.setTimeout(240_000)
    let rig: Rig | undefined
    try {
      // Long backoff = a wide window where the OLD behavior would have lied
      // for 30s (znhn#3) and no window at all for the alert bar (znhn#6).
      rig = await bootRig('cancel', { FAKE_CRASH_MODE: 'always', FRESHELL_AUTO_RESUME_DELAYS_MS: '8000,8000' })
      await createClaudePane(page, rig.info)

      await expect(autoResumeNotice(page)).toBeVisible({ timeout: 30_000 })
      await page.getByRole('button', { name: 'Cancel auto-resume for claude' }).click()

      // Settle frame, not TTL: the notice clears within seconds, the loud
      // alert takes its place.
      await expect(autoResumeNotice(page)).toHaveCount(0, { timeout: 3_000 })
      await expect(page.getByRole('alert').filter({ hasText: 'process exited (code 1)' })).toBeVisible({ timeout: 5_000 })

      // The planned respawn was guard-aborted: still only 1 invocation.
      await page.waitForTimeout(10_000)
      expect((await readArgvLog(rig.argvLog)).length, 'cancel must abort the planned respawn').toBe(1)
    } finally {
      await teardownRig(rig)
    }
  })
```

- [ ] **Step 3: Reconcile the four existing tests with the new UI** — run the whole spec and fix assertions that the feature legitimately changed (expected: the `once` test's resumed-strip expectations now match the crash trace via the `/auto-resum/` status filter; the Relaunch test's button locator is by aria-label and unchanged; alert-count-0 assertions hold because the trace is `role="status"`). Do NOT weaken assertions — update copy expectations only where this plan changed the copy.

- [ ] **Step 4: Run**

```bash
cargo build --release -p freshell-server
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium test/e2e-browser/specs/agent-crash-autoresume-rust.spec.ts
```
Expected: all 7 tests PASS (4 existing + 3 new), each on its own ephemeral-port server.

- [ ] **Step 5: Commit**

```bash
git add test/e2e-browser
git commit -m "test(e2e): crash trace survives reload; breaker banner; cancel clears immediately (znhn#1,#2,#3)"
```

---

### Task 13: Full gates, kata comments, push (NO PR)

**Files:** none beyond incidental fixes surfaced by the gates.

**Interfaces:**
- Consumes: everything above.
- Produces: a pushed branch `feat/znhn-bccd-followups`; kata comments recording the decisions; NO PR.

- [ ] **Step 1: Rust gates**

```bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```
Expected: all PASS.

- [ ] **Step 2: Node gates (coordinator-aware)**

```bash
npm run test:status   # if the gate is HELD, wait and re-check — do not bypass
FRESHELL_TEST_SUMMARY='znhn+bccd follow-ups' env -u FRESHELL_BIND_HOST npm test
npm run test:port
npm run lint
```
Expected: all PASS.

- [ ] **Step 3: Release build + e2e lane (ephemeral ports only)**

```bash
cargo build --release -p freshell-server
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium \
  test/e2e-browser/specs/agent-crash-autoresume-rust.spec.ts \
  test/e2e-browser/specs/rest-spawn-gate-rust.spec.ts \
  test/e2e-browser/specs/restore-contract-wall-rust.spec.ts
```
Expected: all PASS; the restore-contract-wall must stay green with ZERO `test.fail()` pins (it currently has zero — closed by PR #577; do not add any).

- [ ] **Step 4: Kata comments (decision record)**

```bash
kata comment znhn -m "Follow-ups landed on feat/znhn-bccd-followups: (1) persistent crash trace on pane content — survives reload, dismissible, role=status data-testid=crash-trace; patience-window sentence added to crash-resilience plan D-5. (2) flap circuit breaker: 5 successful auto-resumes per createRequestId per rolling hour (FRESHELL_AUTO_RESUME_MAX_CYCLES / _CYCLE_WINDOW_MS), settles 'flap_circuit_breaker' with typed resumeCycles + 'crashed N times — auto-resume paused' banner; cancel button on the recovering notice sends terminal.autoResumeCancel (settle frame emitted immediately). Escalating backoff rejected: the hub is serialized, long sleeps would starve other panes. (3) settle frame = RuntimeStatus 'exited' on terminal.status, emitted on EVERY silent settle path; client 30s TTL apparatus deleted. (4) SpawnGate::acquire_uncancellable added, both dummy-channel callers migrated. (5) Relaunch copy: 'Relaunch — resumes this conversation' when sessionRef.provider matches (copy stays plain 'Relaunch' on the provider-mismatch degrade path). (6) orphan race resolved structurally: with the TTL gone the alert bar cannot appear while a resume is pending at ANY delay value — pinned by the no-timer-degradation unit test; the in-flight window is covered by the session_owned_live guard which now also emits a settle frame."

kata comment bccd -m "Follow-ups landed on feat/znhn-bccd-followups: (1) 429 SPAWN_QUEUE_FULL now carries Retry-After header + retryAfterMs body field (value = gate wait bound, default 10s). (2) burst test deflaked: test pre-holds the single permit, so queued_total()==16 exactly and zero requests may complete while the budget is held — pins max-in-flight <= budget deterministically. (3) cancel-sender pin superseded BY CONSTRUCTION: acquire_uncancellable (znhn#4) owns the never-fired sender inside the gate, so no caller-side sender exists to drop; semantics pinned by acquire_uncancellable_waits_for_a_permit_and_never_cancels / _times_out_as_timeout_not_cancelled / _rejects_queue_full_loudly. (4) opencode sidecar cold-start now acquires a single spawn-gate permit in the REST send-keys cold path (rejection reuses the 429/503 envelopes); the WS materialize door stays deliberately ungated (D-D ruled on REST-reachable forks; single-flighted singleton bounds it — comment in opencode_ws.rs). (5) D-C tripwire: grep D-C-REVISIT(FRESHELL_CODEX_MANAGED_LAUNCH) — markers at the REST call site + the flag const, note appended to the rest-spawn-gate plan doc."
```

- [ ] **Step 5: Push the branch — NO PR**

```bash
git log --oneline origin/main..HEAD   # review: one focused commit per task
git push -u origin feat/znhn-bccd-followups
```
Expected: branch pushed. Do NOT open a PR — landing happens outside this workflow with the final review verdict.

---

## Self-Review (performed at plan time)

**1. Spec coverage — every kata item has a covering task:**

| Item | Task(s) | Production outcome proved by |
|---|---|---|
| znhn 1 crash trace + patience sentence | 10 (+12) | e2e: trace visible after auto-resume, survives reload, dismissible; doc sentence in crash-resilience plan D-5 |
| znhn 2 circuit breaker + cancel affordance | 7, 8, 9, 11 (+12) | e2e: breaker banner after 3 flaps, argv log pinned at 4; cancel clears notice <3s and respawn count stays 1 |
| znhn 3 settle frame for guard-aborts (deletes TTL apparatus) | 5, 6, 9 | hub tests: settle frame on every silent path; client tests: no timer degradation + frame-driven clear; e2e cancel test exercises the settle frame end-to-end |
| znhn 4 acquire_uncancellable + migrate both callers | 1 | gate unit pins; both call sites migrated (compile-verified; REST + respawn suites green) |
| znhn 5 Relaunch copy | 11 | component tests incl. the provider-mismatch degrade path (copy stays honest) |
| znhn 6 orphan race (evaluate-and-decide) | 9 (pin test), 13 (kata comment) | resolved structurally by TTL deletion — D-9 records the reasoning |
| bccd 1 Retry-After on 429 | 2 | REST unit test asserts header + retryAfterMs |
| bccd 2 burst-test deflake → deterministic max-in-flight pin | 3 | rewritten test, 10× determinism run |
| bccd 3 cancel-sender pin | 1 (superseded — D-8) | new-API semantics pinned instead; kata comment records the supersession |
| bccd 4 sidecar cold-start gating (evaluate-and-decide) | 4 | DECIDED: gate it (D-7); tests pin 429-when-full and queue-behind-held-permit; WS door deliberately out of scope with comment |
| bccd 5 D-C revisit tripwire | 2 | grep-able markers at both sites + plan-doc note |
| Cross-cutting: contract regen + both pins same-commit | 5, 8 | `test:port`, `cargo test -p freshell-protocol`, restore-contract-wall zero pins (13) |

No item is deferred; both evaluate-and-decide items (znhn 6, bccd 4) are decided and implemented/pinned in-plan. **No unresolved coverage gaps.**

**1b. No silent deferrals:** every user-facing behavior lands with a production path and an e2e or integration proof (table above). The only test doubles are the established ones (FakeDriver for hub logic — production driver covered by `auto_resume_e2e.rs` + Playwright; NoopSpawner for the sidecar gate rejection — the gate rejection fires before any spawn, and the queue-behind-permit test proves the door is on the gate). The WS-door opencode cold-start is a deliberate, documented scope decision (council D-D ruled on REST), not a silent deferral — recorded in code comment + kata comment.

**2. Placeholder scan:** the remaining `<copy the ... setup from :2694>` / "KEEP the existing payload" markers in Tasks 3 and 4 are deliberate **splice anchors into existing test bodies quoted by line number** — the implementer copies working in-repo code rather than this plan duplicating (and drifting from) it; every NEW behavior has complete code. Test skeletons in Tasks 6–7 name their exact harness templates by line. No "TBD"/"add error handling"/"similar to Task N" anywhere.

**3. Type consistency check (cross-task):**
- `acquire_uncancellable(timeout: Duration) -> Result<OwnedSemaphorePermit, SpawnGateError>` — defined Task 1, consumed Tasks 3, 4 with matching signatures. ✓
- `spawn_gate_error_response(err, retry_after: Duration)` `pub(crate)` — Task 2 defines, Task 4 consumes with `(err, g.timeout)`. ✓
- `TerminalStatus.resume_cycles: Option<i64>` / TS `resumeCycles?: number` — Task 5 defines; Task 6 `emit_settled(resume_cycles: Option<u32>)` maps via `i64::from`; Task 8 handler passes `None`; Task 9 reads `msg.resumeCycles`; Task 11 renders it. ✓
- `recordAutoResumeSettled({ paneId, resumeCycles?, at })` + `selectResumeCycles` — Task 9 defines, Task 11 consumes. ✓
- `CrashTrace { exitCode, resumedAtMs }` — Task 10 defines; banner + e2e (`crash-trace` testid, `Dismiss ${mode} crash notice`) consume the same names. ✓
- Cancel wire: `{ type: 'terminal.autoResumeCancel', terminalId }` identical in Rust serde rename (Task 8), TS schema (Task 8), client send (Task 9), e2e button flow (Task 12). ✓
- Env knob names identical across Task 7 (definitions) and Task 12 (e2e rig): `FRESHELL_AUTO_RESUME_MAX_CYCLES`, `FRESHELL_AUTO_RESUME_CYCLE_WINDOW_MS`, `FRESHELL_AUTO_RESUME_HEALTHY_LIFETIME_MS`, `FRESHELL_RESPAWN_LIVENESS_WINDOW_MS`. ✓
- Banner props evolve across Tasks 9→10→11 (each task lists the full prop set it leaves behind); final shape: `{ mode, exitCode, notice, crashTrace, settledDead, resumeCycles, canResume, onRelaunch, onCancelAutoResume, onDismissCrashTrace }`. ✓

**Known ordering hazards handled:** Task 5 (server-side enum widening) compiles workspace-wide because `ClientMessage` is untouched there; the exhaustive client-message match means the new variant + handler + WsState field + pins all land atomically in Task 8. The `'resumed'` notice kind survives until Task 10 retires it, so Task 9 keeps the verb ternary if any test still needs it (noted inline).

