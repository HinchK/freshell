# Reconciliation Handshake Phase 3 — Client Adoption Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Activate the ~1,400 dormant server lines of the pane-reconcile handshake by making the client send `capabilities.paneReconcileV1` and fold server verdicts, delete the `retry` verdict from the wire (server absorbs `index_warming` with a bounded deferral), and close D8 with a server-side per-`sessionRef` single-flight lease so two clients sharing a session can never mint two PTYs.

**Architecture:** Server-first: reshape the verdict wire (delete `retry`, add `error{index_warming|provider_unavailable}`, bounded single deferral), add a sessionRef-level liveness-bound lease alongside the existing `createRequestId` keyed-create single-flight, then adopt on the client — a new `src/lib/pane-reconcile.ts` module builds `pane.reconcile.request` from persisted panes and folds `pane.reconcile.result` verdicts into existing pane reducers, with the legacy `clearDeadTerminals` census kept as the capability-gated fallback.

**Tech Stack:** Rust (crates/freshell-ws, crates/freshell-protocol, tokio, tokio-tungstenite tests), TypeScript/React 18/Redux Toolkit (Vite client), Zod (`shared/ws-protocol.ts`), Vitest + Testing Library, Playwright (`test/e2e-browser`, rust-chromium project).

## Global Constraints

Every task's requirements implicitly include this section.

**Repo / process rules:**
- Work ONLY in the worktree `/home/dan/code/freshell/.worktrees/reconcile-client-adoption` (branch from `origin/main@2dfbba58`). All `cd` in this plan means that directory.
- PR policy for this branch: **NOT approved.** Push the branch, STOP before `gh pr create` or any equivalent. Final deliverable is branch + red→green proof.
- NEVER restart the user's self-hosted Freshell server. NEVER use broad kill patterns (`pkill -f`, `pkill node`, ...). Only kill PIDs you spawned and recorded.
- E2E servers: own `RustServer` instances via `test/e2e-browser/helpers/rust-server.ts`, ephemeral ports (the helper picks a free port) — NEVER ports 3001/3002.
- Broad coordinated test runs go through the shared coordinator gate: set `FRESHELL_TEST_SUMMARY="B1 reconcile client adoption: <what>"`. If another agent holds the gate, WAIT (3 sibling lanes run concurrently). Use `npm run test:status` to inspect. Focused runs use `npm run test:vitest -- run <path>`.
- CI-required Rust checks: `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings` must pass.
- Server-side TS uses NodeNext/ESM — relative imports include `.js` extensions; client `src/` follows existing import style (no extension, `@/` alias).
- Disk is ~78GB free — halt and report on any ENOSPC.
- Commit messages end with the Amplifier attribution block:
  `🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)` + `Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>`.

**Scope fence (sibling lanes are working concurrently on other branches):**
- You own: `src/lib/ws-client.ts`, client verdict folding (`App.tsx` recovery region + new `src/lib/pane-reconcile.ts` + minimal support edits in `panesSlice.ts` / `paneTypes.ts` / `terminal-restore.ts` / `TerminalView.tsx` / `shared/ws-protocol.ts` + the new `DeadSessionPanel` component), `crates/freshell-ws/src/reconcile.rs`, `crates/freshell-ws/src/existence.rs` (+ the concrete probe in `crates/freshell-server/src/existence.rs` for warming/provider-unavailable), `crates/freshell-ws/src/terminal.rs` create/reconcile paths, `crates/freshell-ws/src/registry.rs` reservation, and the ledger WRITE at respawn-winner bind (the wave-A ledger API).
- Do NOT touch: `codex_candidate.rs` / rollout locator (Lane B2), `tabs_snapshots.rs` + tabs-snapshot recovery UI (Lane B3), `freshell-freshagent` crates + fresh-agent verdict support (Lane B4). `reconcile.rs` keeps rejecting `kind: fresh-agent` (`reconcile.rs:169` `unsupported_kind`) this slice — keep edits near that dispatch match-arm minimal and tight (B4 merges a new arm there; expect a trivial merge conflict). No kimi/gemini work.

**Council-gated behavioral invariants (from the restart-resilience analysis §4.3 — every rule here is binding):**
1. Verdict folds: `attach` → plain attach (NO recreate, NO new `createRequestId`), `respawn` → create-with-resume using the server-named `sessionRef`, `fresh` → clean create, `dead_session` → loud per-pane breadcrumb + ONE batched adjudication panel listing all dead panes (never N modals).
2. `createRequestId` is NEVER re-minted by any reconcile fold path (it is the keyed-create dedupe key; "Start fresh here" reuses the same id).
3. `retry` verdict does not exist on the wire. `index_warming` is absorbed server-side: bounded deferral (2s budget, SINGLE deferral), then a loud `error` verdict with `reason: "index_warming"` + a client-side manual retry affordance — never a fake `fresh`/`dead_session`, never an unbounded await.
4. A known provider with no home on this machine is NOT warming — it gets `error` with `reason: "provider_unavailable"`, immediately (no deferral).
5. Under a post-restart storm, warming notices batch into ONE banner ("Waiting for session index — N panes"), same anti-N-modal rule as `dead_session`.
6. Multi-client single-flight is per `sessionRef`, not just per `createRequestId`. The first respawn winner binds `sessionRef → new terminalId` (registry + ledger); every other client's reconcile/create for the same `sessionRef` — regardless of `createRequestId` — receives `attach {terminalId}` to the winner.
7. The sessionRef reservation is a liveness-bound LEASE: released on spawn complete (bind), spawn fail (error), or holder connection death; a wall-clock TTL (~2× spawn budget) backstops a hung holder. TTL expiry is KILL-BEFORE-RELEASE: kill the holder's in-flight spawn and confirm death before releasing; if the kill cannot be confirmed, the lease is NOT released (fail loud, hold closed).
8. Losers get an `error` frame `{code: SESSION_RESERVED, retryAfterMs}`; the client retries via a bounded re-drive loop whose total window exceeds the lease TTL + margin. Exhaustion resolves AUTOMATICALLY against current state: binding exists → silently attach; winner failed → dead_session/fresh-recovery flow with a visible notice. Never a dead button, never a silent wedge, never a duplicate.
9. A ≥2-live-PTYs-per-sessionRef backstop detector alarms (ERROR-level invariant log).
10. `corrected: true` on any verdict is ALWAYS user-visible (a pane notice), never a silent identity switch. `duplicate` on an attach verdict is a non-destructive "duplicate detected and ignored" notice; the client is never switched off its live terminal (I6).
11. The legacy `clearDeadTerminals` census path remains as the fallback when the server does not ack the capability (legacy TS server) — capability-gated branch, NOT deletion.
12. `dead_session` is a UI state, not a deletion: nothing is auto-closed, disk is never touched, and every terminal verdict has an exit affordance ("Start fresh here" reusing the same `createRequestId` / "Close pane") (I5/I7).
13. Recovery is automatic, never offered: when the server knows enough to act, act; choices are only for genuinely dead sessions.
14. Launch-time `INVALID_TERMINAL_ID` gets a bounded retry (F9) — same bounded re-drive machinery as SESSION_RESERVED — because attach verdicts racing terminal exit would otherwise funnel into a permanent-error dead-end.

**Named red tests this plan must land (spec-mandated):** `warming-never-completes` (Task 2), `restart-storm-all-panes-warming` (Task 13), `two-clients-same-sessionRef` exactly-1-PTY (Task 6 + pin flip Task 14), `winner-dies-mid-claim` (Task 5), `winner-hangs-mid-claim` (Task 5), `loser-exhausts-then-holder-fails` (Task 12).

**Wire surface after this plan (for reference in every task):**
- `hello.capabilities.paneReconcileV1: true` (client opt-in); `ready.capabilities: {paneReconcileV1: true}` emitted iff hello opted in.
- `pane.reconcile.request`: `{type, reconcileId, panes[]}`; pane = `{paneKey (opaque), kind: "terminal", mode, createRequestId (required), terminalId?, serverInstanceId?, sessionRef?{provider,sessionId}, resumeSessionId?, status?}`; cap 200 → error `RECONCILE_TOO_LARGE`.
- `pane.reconcile.result`: `{type, reconcileId, bootId, serverInstanceId, verdicts[]}`; verdict = `{paneKey, verdict, terminalId?, sessionRef?, corrected?: true, reason?, duplicate?}`.
- Verdict enum (6): `attach | respawn | fresh | dead_session | invalid | error` (`retry` deleted; `retryAfterMs` no longer appears on verdicts).
- Error frames: existing `RECONCILE_TOO_LARGE`/`RECONCILE_UNAVAILABLE` + new `SESSION_RESERVED` with additive `retryAfterMs` field on the error frame; reconcile-scoped errors carry the `reconcileId` in `ErrorMsg.requestId`.

---

## File Structure

**Rust (server):**
- Modify: `crates/freshell-protocol/src/` (locate with `rg -n "enum ReconcileVerdict" crates/`) — verdict enum reshape, `ErrorMsg.retryAfterMs`, `SESSION_RESERVED` code.
- Modify: `crates/freshell-ws/src/reconcile.rs` — verdict derivation: `error` reasons, sessionRef-level attach, keep the `unsupported_kind` arm untouched.
- Modify: `crates/freshell-ws/src/existence.rs` — `SessionExistence::ProviderUnavailable` variant.
- Modify: `crates/freshell-server/src/existence.rs` — concrete probe returns `ProviderUnavailable` when a known provider's session root is missing.
- Modify: `crates/freshell-ws/src/registry.rs` — sessionRef lease + binding map + duplicate-PTY detector.
- Modify: `crates/freshell-ws/src/terminal.rs` — bounded warming deferral in `handle_pane_reconcile`; lease acquire/release in the create path; ledger `record_binding` at winner bind.
- Modify: `crates/freshell-ws/tests/pane_reconcile.rs` — updated retry-era tests + warming tests.
- Create: `crates/freshell-ws/tests/session_ref_singleflight.rs` — D8 wire-level tests.

**Client:**
- Modify: `shared/ws-protocol.ts` — the two frame schemas + ready capabilities.
- Modify: `src/store/paneTypes.ts` — `reconcileNotice`, `pendingReconcile` fields.
- Modify: `src/store/panesSlice.ts` — `applyReconcileAttach`, `resetPaneForReconcileCreate`, dead-session/warming aggregation state.
- Create: `src/lib/pane-reconcile.ts` — request builder + verdict folding + cardinality invariant.
- Modify: `src/lib/ws-client.ts` — hello capability, ready-capabilities capture, in-flight-create replay suppression.
- Modify: `src/App.tsx` — send request on ready-with-capability, fold results, gate legacy census.
- Modify: `src/lib/terminal-restore.ts` — bypass arm/peek latch when capability active.
- Modify: `src/components/TerminalView.tsx` — verdict-driven create args, SESSION_RESERVED + INVALID_TERMINAL_ID bounded retry, exhaustion auto-resolve, reconcile notices.
- Create: `src/components/DeadSessionPanel.tsx` — the ONE batched adjudication panel.
- Create: `src/components/ReconcileWarmingBanner.tsx` — the ONE warming banner (small; may be folded into App if <40 lines, implementer's call, but it must remain a single banner).

**Tests (client/e2e):**
- Create: `test/unit/lib/pane-reconcile.test.ts`, `test/unit/store/panesSlice.reconcile.test.ts`, `test/unit/lib/ws-client.reconcile.test.ts`, `test/unit/App.reconcile-adoption.test.tsx`, `test/unit/components/DeadSessionPanel.test.tsx`, `test/unit/components/TerminalView.session-reserved.test.tsx`.
- Modify: `test/e2e-browser/specs/restore-contract-wall-rust.spec.ts` — flip the P1.7 pin (:1877-1880), update the double-restart guard (:2042).
- Create: `test/e2e-browser/specs/reconcile-client-adoption-rust.spec.ts`.

---

### Task 1: Baseline verification

**Files:** none modified (verification only; no commit).

**Interfaces:**
- Consumes: the worktree at `/home/dan/code/freshell/.worktrees/reconcile-client-adoption` (created by the workspace stage from `origin/main@2dfbba58`).
- Produces: recorded proof the base is green so later failures are attributable to this lane.

- [ ] **Step 1: Confirm base commit and node_modules**

```bash
cd /home/dan/code/freshell/.worktrees/reconcile-client-adoption
git log --oneline -1        # expect: 2dfbba58 Merge pull request #536 ...
ls node_modules/.bin/vitest # if missing: npm ci
ls node_modules/tsx/dist/loader.mjs  # if missing after npm ci: ln -s ../node_modules/tsx node_modules/tsx (needed by freshell-ws MCP-injector tests)
```

- [ ] **Step 2: Rust baseline**

```bash
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings
cargo test -p freshell-ws
```
Expected: all green (2dfbba58 is a merged main state).

- [ ] **Step 3: Focused client baseline (cheap sanity, not the coordinated suite)**

```bash
npm run test:vitest -- run test/unit/lib/terminal-restore.test.ts test/unit/store/panesSlice.test.ts
```
Expected: PASS. (The full coordinated suite runs in Task 15; the workspace stage already verified base green.)

- [ ] **Step 4: Record baseline evidence** — paste the three command tails into your task report. No commit.

---

### Task 2: Server — delete `retry` from the wire; `error{index_warming}` + bounded single deferral

**Files:**
- Modify: `crates/freshell-protocol/src/` (locate: `rg -n "enum ReconcileVerdict" crates/` and `rg -n "retryAfterMs" crates/freshell-protocol/`)
- Modify: `crates/freshell-ws/src/reconcile.rs` (retry emission site :249-253; `RETRY_AFTER_MS` const :24)
- Modify: `crates/freshell-ws/src/terminal.rs` (`handle_pane_reconcile` :1911)
- Modify: `crates/freshell-ws/src/lib.rs` or wherever `WsState` config lives (add deferral budget knob; locate: `rg -n "struct WsState" crates/freshell-ws/src/`)
- Test: `crates/freshell-ws/tests/pane_reconcile.rs`

**Interfaces:**
- Consumes: `derive_verdicts(&ReconcileDeps<'_>, &[ReconcilePane]) -> Vec<PaneVerdict>` (`reconcile.rs:37`), `SessionExistence::{Present,Absent,Unknown}` (`existence.rs`), `handle_pane_reconcile(request, ws_tx, state) -> bool` (`terminal.rs:1911`), test helpers `spawn_server()`, `connect(url, pane_reconcile_v1)`, `next_frame_of_type` in `tests/pane_reconcile.rs`.
- Produces: `ReconcileVerdict::Error` (wire `"error"`) replacing `ReconcileVerdict::Retry`; verdict `reason: "index_warming"`; `WsState.reconcile_deferral_budget_ms: u64` (default `2000`, settable in tests); `handle_pane_reconcile` performs at most ONE deferral then re-derives once. Later tasks (3, 4, 6, 7) rely on the `Error` variant and the budget knob.

- [ ] **Step 1: Write the failing tests** — in `crates/freshell-ws/tests/pane_reconcile.rs`, following the file's existing helper pattern (`spawn_server`, `connect`, `next_frame_of_type`, fake existence probe). Also UPDATE the existing "honest unknowns → retry" test (design-doc test 9.1.6) to the new expectation — do not leave a test asserting `"retry"`.

```rust
/// warming-never-completes (council red test): a probe pinned to Unknown
/// forever must yield error{index_warming} after ONE bounded deferral —
/// never a hang, never a fake fresh/dead_session.
#[tokio::test]
async fn warming_never_completes_yields_error_index_warming() {
    // Server with deferral budget shrunk for tests (50ms) and the default
    // NoIndexProbe (always Unknown for known providers).
    let server = spawn_server_with(|state| state.reconcile_deferral_budget_ms = 50).await;
    let mut ws = connect(&server.url, true).await;
    let started = std::time::Instant::now();
    ws.send_json(reconcile_request_with_session_ref("claude", "sess-1")).await;
    let result = next_frame_of_type(&mut ws, "pane.reconcile.result").await;
    assert!(started.elapsed() < std::time::Duration::from_secs(2), "bounded, single deferral");
    let v = &result["verdicts"][0];
    assert_eq!(v["verdict"], "error");
    assert_eq!(v["reason"], "index_warming");
    assert!(v.get("retryAfterMs").is_none(), "retry is deleted from the wire");
}

/// The deferral is real: index warms during the wait -> the SECOND derivation
/// answers with the warm verdict, not error.
#[tokio::test]
async fn warming_resolves_during_deferral_rederives() {
    // Fake probe: first call Unknown, subsequent calls Absent (never observed
    // -> per existing rules the verdict for a never-observed identity is
    // fresh{identity_never_observed}).
    let probe = FlippingProbe::new(vec![SessionExistence::Unknown, SessionExistence::Absent]);
    let server = spawn_server_with_probe(probe, |state| state.reconcile_deferral_budget_ms = 50).await;
    let mut ws = connect(&server.url, true).await;
    ws.send_json(reconcile_request_with_session_ref("claude", "sess-2")).await;
    let result = next_frame_of_type(&mut ws, "pane.reconcile.result").await;
    assert_ne!(result["verdicts"][0]["verdict"], "error");
}
```

Write `FlippingProbe` (implements `SessionExistenceProbe`, pops from a Vec, repeats last) and the `spawn_server_with`/`spawn_server_with_probe` variants next to the existing helpers — copy the existing `spawn_server`/`headless()` bodies and add the closure/probe parameters. If the existing harness already supports probe injection (design says "SessionExistence is a test fake per §5.1"), reuse it instead of duplicating.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cargo test -p freshell-ws --test pane_reconcile warming
```
Expected: FAIL — compile error (no `spawn_server_with`) or assertion failure on `"retry"` verdict.

- [ ] **Step 3: Implement**

(a) Protocol crate — reshape the enum (keep serde snake_case):

```rust
#[serde(rename_all = "snake_case")]
pub enum ReconcileVerdict {
    Attach,
    Respawn,
    Fresh,
    DeadSession,
    Invalid,
    /// Terminal per-pane error state (replaces the deleted `retry`):
    /// reason is one of "index_warming" | "provider_unavailable".
    Error,
}
```
Delete the `Retry` variant and remove `retry_after_ms` from `PaneVerdict` (grep all uses: `rg -n "Retry|retry_after_ms" crates/`). Keep `retryAfterMs` support on `ErrorMsg` OUT of this task (Task 6 adds it as an additive error-frame field).

(b) `reconcile.rs:249-253` — replace the retry emission:

```rust
SessionExistence::Unknown => pane_verdict(pane, ReconcileVerdict::Error)
    .with_reason("index_warming"),
```
(Adapt to the file's local constructor style — the existing arm at :249 shows it.) Delete the now-unused `RETRY_AFTER_MS` const at `reconcile.rs:24`, or repurpose it as `pub const RECONCILE_DEFERRAL_BUDGET_MS_DEFAULT: u64 = 2000;`.

(c) `WsState` — add `pub reconcile_deferral_budget_ms: u64` initialized to `RECONCILE_DEFERRAL_BUDGET_MS_DEFAULT` wherever `WsState` is constructed (grep constructors).

(d) `terminal.rs` `handle_pane_reconcile` (:1911) — bounded single deferral:

```rust
let mut verdicts = derive_verdicts(&deps, &request.panes);
let warming = |vs: &[PaneVerdict]| vs.iter().any(|v|
    matches!(v.verdict, ReconcileVerdict::Error)
        && v.reason.as_deref() == Some("index_warming"));
if warming(&verdicts) {
    // SINGLE deferral: release any locks held for derivation, wait the
    // budget once, re-derive once. Never loop.
    tokio::time::sleep(Duration::from_millis(state.reconcile_deferral_budget_ms)).await;
    verdicts = derive_verdicts(&rebuild_deps(&state), &request.panes);
}
// send pane.reconcile.result as before
```
IMPORTANT: `derive_verdicts` is a pure read over `ReconcileDeps { registry, identity, existence }` — make sure no registry/identity lock is held across the `sleep` (rebuild the deps after the await; the existing call site shows how they are built).

- [ ] **Step 4: Run the full crate test suite**

```bash
cargo test -p freshell-ws
```
Expected: PASS, including the two new tests and all updated retry-era tests. If any other test in the workspace references `Retry` (grep first), update it to the new semantics in this task.

- [ ] **Step 5: fmt + clippy + commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
git add -A crates/
git commit -m "feat(ws): delete retry verdict; bounded index-warming deferral yields error{index_warming}"
```

---

### Task 3: Server — `error{provider_unavailable}` for a known provider with no home

**Files:**
- Modify: `crates/freshell-ws/src/existence.rs` (enum + `NoIndexProbe` :76)
- Modify: `crates/freshell-server/src/existence.rs` (`IndexExistenceProbe` cold peek :81)
- Modify: `crates/freshell-ws/src/reconcile.rs`
- Test: `crates/freshell-ws/tests/pane_reconcile.rs`

**Interfaces:**
- Consumes: `SessionExistence` enum, `SessionExistenceProbe` trait (`crates/freshell-ws/src/existence.rs`), `ReconcileVerdict::Error` (Task 2), `FlippingProbe`/probe-injection helpers (Task 2).
- Produces: `SessionExistence::ProviderUnavailable` variant; verdict `error{reason:"provider_unavailable"}` emitted with NO deferral. Client Task 9 folds this reason.

- [ ] **Step 1: Write the failing tests**

```rust
/// A known provider with no home on this machine is NOT warming — it gets
/// the honest provider_unavailable label, immediately (no 2s deferral).
#[tokio::test]
async fn provider_unavailable_is_immediate_and_honest() {
    let probe = FixedProbe::new(SessionExistence::ProviderUnavailable);
    // Deliberately LARGE budget: proves no deferral happens for this reason.
    let server = spawn_server_with_probe(probe, |state| state.reconcile_deferral_budget_ms = 30_000).await;
    let mut ws = connect(&server.url, true).await;
    let started = std::time::Instant::now();
    ws.send_json(reconcile_request_with_session_ref("codex", "sess-9")).await;
    let result = next_frame_of_type(&mut ws, "pane.reconcile.result").await;
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
    let v = &result["verdicts"][0];
    assert_eq!(v["verdict"], "error");
    assert_eq!(v["reason"], "provider_unavailable");
}
```

Plus a unit test in `crates/freshell-server/src/existence.rs` `#[cfg(test)]`: build an `IndexExistenceProbe` over a temp dir where the provider's session root does NOT exist → probe returns `ProviderUnavailable` (not `Unknown`); where the root exists but is cold → `Unknown` (unchanged). Read the existing probe code at `crates/freshell-server/src/existence.rs:81` first — reuse whatever path-resolution helper it already has for the provider session root.

- [ ] **Step 2: Run to verify failure**

```bash
cargo test -p freshell-ws --test pane_reconcile provider_unavailable
cargo test -p freshell-server existence
```
Expected: FAIL — `ProviderUnavailable` variant doesn't exist.

- [ ] **Step 3: Implement**
  - `existence.rs`: add `ProviderUnavailable` to `SessionExistence`. `NoIndexProbe` behavior unchanged (still `Unknown` for known providers — test harnesses keep warming semantics).
  - `crates/freshell-server/src/existence.rs`: before the cold-peek `Unknown` return, check the provider's session root directory; if the provider is known but its root does not exist on disk → return `SessionExistence::ProviderUnavailable`.
  - `reconcile.rs`: add the match arm next to the Task-2 arm:

```rust
SessionExistence::ProviderUnavailable => pane_verdict(pane, ReconcileVerdict::Error)
    .with_reason("provider_unavailable"),
```
  - The Task-2 `warming()` predicate in `terminal.rs` already only defers on `index_warming` — verify, don't widen.

- [ ] **Step 4: Run tests**

```bash
cargo test -p freshell-ws && cargo test -p freshell-server
```
Expected: PASS.

- [ ] **Step 5: fmt + clippy + commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
git add -A crates/
git commit -m "feat(ws): provider_unavailable existence state yields immediate honest error verdict"
```

---

### Task 4: Server — sessionRef-level attach in verdict derivation + duplicate-PTY backstop detector

**Files:**
- Modify: `crates/freshell-ws/src/registry.rs`
- Modify: `crates/freshell-ws/src/reconcile.rs`
- Test: `crates/freshell-ws/tests/pane_reconcile.rs` and `registry.rs` `#[cfg(test)]`

**Interfaces:**
- Consumes: the identity registry (`ReconcileDeps.identity`) mapping live terminals ↔ `SessionLocator` (stamping landed in commit 80772ff2 — locate the live lookup with `rg -n "SessionLocator" crates/freshell-ws/src/identity.rs crates/freshell-ws/src/registry.rs`).
- Produces: `TerminalRegistry::live_terminal_for_session_ref(&SessionLocator) -> Option<String>`; `derive_verdicts` returns `attach{terminalId}` for a pane claiming a `sessionRef` that a live terminal already carries, regardless of `createRequestId`; `TerminalRegistry::alarm_if_duplicate_session_ref(&SessionLocator)` ERROR-logs when ≥2 live PTYs carry one sessionRef. Task 5/6 use both.

- [ ] **Step 1: Write the failing tests**

```rust
/// Cross-client attach: a live terminal spawned under createRequestId A and
/// bound to sessionRef S answers a reconcile claim from createRequestId B
/// (a different client) with attach{terminalId of A's terminal}.
#[tokio::test]
async fn different_create_request_id_same_session_ref_gets_attach_to_winner() {
    let server = spawn_server_default().await;
    // Seed: headless terminal live in the registry, identity-stamped with
    // sessionRef {claude, sess-x} (the existing tests seed identity directly
    // — copy that seeding pattern).
    let tid = seed_live_terminal_with_identity(&server, "claude", "sess-x").await;
    let mut ws = connect(&server.url, true).await;
    ws.send_json(reconcile_request(vec![pane_claim("cr-OTHER", Some(("claude", "sess-x")))])).await;
    let result = next_frame_of_type(&mut ws, "pane.reconcile.result").await;
    let v = &result["verdicts"][0];
    assert_eq!(v["verdict"], "attach");
    assert_eq!(v["terminalId"], tid);
}
```

And a registry unit test: seed two live terminals stamped with the same sessionRef → `alarm_if_duplicate_session_ref` returns `true` (and, by inspection, emits `tracing::error!` with target `"invariant"` and message containing `duplicate_pty_for_session_ref`); with one live terminal → `false`.

- [ ] **Step 2: Run to verify failure**

```bash
cargo test -p freshell-ws --test pane_reconcile different_create_request_id
cargo test -p freshell-ws duplicate_session_ref
```
Expected: FAIL (today derivation keys on `createRequestId` only — `newest_live_by_create_request_id`).

- [ ] **Step 3: Implement**
  - `registry.rs`:

```rust
/// Live terminal currently identity-stamped with this sessionRef, if any.
pub fn live_terminal_for_session_ref(&self, locator: &SessionLocator) -> Option<String> { /* scan live rows joined with identity */ }

/// D8 backstop: >=2 live PTYs carrying one sessionRef is the two-writers
/// corruption shape. Alarm loudly; never kill silently.
pub fn alarm_if_duplicate_session_ref(&self, locator: &SessionLocator) -> bool {
    let live = /* count live terminals stamped with locator */;
    if live >= 2 {
        tracing::error!(target: "invariant",
            provider = %locator.provider, session_id = %locator.session_id, live,
            "duplicate_pty_for_session_ref: >=2 live PTYs share one sessionRef");
        return true;
    }
    false
}
```
Where identity lives (registry rows vs the separate identity registry) — follow how `derive_verdicts`' existing rows resolve identity today (`ReconcileDeps.identity`); put the lookup where the data actually is and expose it through whichever of the two structs `ReconcileDeps` already carries.
  - `reconcile.rs`: in the per-pane derivation for `kind: terminal`, BEFORE the existing `createRequestId`-keyed resolution: if the pane claims a `sessionRef` and `live_terminal_for_session_ref` returns `Some(tid)` → verdict `attach{terminalId: tid, sessionRef: <server's ref>}`, with `corrected: true` iff the client's claimed `sessionRef`/`terminalId` disagreed with the server's truth (follow the existing corrected-computation pattern used by the current attach arm). Do NOT touch the `unsupported_kind` arm at :169.

- [ ] **Step 4: Run tests**

```bash
cargo test -p freshell-ws
```
Expected: PASS (all existing decision-table tests still green — the new branch only fires when a live terminal carries the claimed ref, which previously produced `attach` via the createRequestId path or a wrong `respawn`; if any existing test asserted `respawn` in that situation, that test was pinning D8 itself — update it and say so in the commit).

- [ ] **Step 5: fmt + clippy + commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
git add -A crates/
git commit -m "feat(ws): sessionRef-level attach in verdict derivation + duplicate-PTY invariant alarm"
```

---

### Task 5: Server — sessionRef liveness-bound lease in the registry

**Files:**
- Modify: `crates/freshell-ws/src/registry.rs`
- Test: `crates/freshell-ws/src/registry.rs` `#[cfg(test)]` (unit level; wire level is Task 6)

**Interfaces:**
- Consumes: `TerminalRegistry` internals (existing `keyed_create_inflight` pattern at `registry.rs:1599-1608` is the shape to mirror), `SessionLocator`.
- Produces (exact API Task 6 calls):

```rust
pub const SESSION_REF_LEASE_TTL_MS: u64 = 20_000; // ~2x the 10s spawn budget
pub const SESSION_RESERVED_RETRY_AFTER_MS: u64 = 1_000;

pub enum SessionRefClaim {
    Acquired,
    Held { retry_after_ms: u64 },
    /// TTL expired on a holder with a recorded child: caller must kill pid,
    /// CONFIRM death, then call force_release_after_confirmed_kill and re-claim.
    ExpiredNeedsKill { pid: u32 },
    BoundElsewhere { terminal_id: String },
}

impl TerminalRegistry {
    pub fn claim_session_ref(&self, locator: &SessionLocator, holder_create_request_id: &str, holder_conn: u64, now_ms: u64) -> SessionRefClaim;
    pub fn set_session_ref_lease_pid(&self, locator: &SessionLocator, holder_create_request_id: &str, pid: u32);
    /// Spawn succeeded: record binding, release lease, run the duplicate alarm.
    /// Returns false if the lease was revoked while spawning (caller must kill
    /// its own child and fail the create loudly).
    pub fn complete_session_ref_claim(&self, locator: &SessionLocator, holder_create_request_id: &str, terminal_id: &str) -> bool;
    pub fn fail_session_ref_claim(&self, locator: &SessionLocator, holder_create_request_id: &str);
    /// Connection death: release this conn's leases. Returns (locator_key, pid)
    /// pairs whose in-flight children the caller must kill (kill-before-release
    /// applies: entries WITH a pid are returned still-held; caller kills,
    /// confirms, then calls force_release_after_confirmed_kill).
    pub fn release_session_ref_leases_for_conn(&self, conn: u64) -> Vec<(SessionLocator, Option<u32>)>;
    pub fn force_release_after_confirmed_kill(&self, locator: &SessionLocator);
}
```

Semantics (council-gated, restated as code truths):
- `claim_session_ref` checks, in order: live binding (`live_terminal_for_session_ref`, Task 4) → `BoundElsewhere`; a held, unexpired lease → `Held{SESSION_RESERVED_RETRY_AFTER_MS}`; a held lease past `acquired_at_ms + SESSION_REF_LEASE_TTL_MS` → if it has a pid, `ExpiredNeedsKill{pid}`; if it has NO pid (holder hung pre-spawn), set `revoked = true` on the lease, log ERROR, and return `Held{...}` — hold closed, never release what you can't kill.
- A lease whose holder later calls `complete_session_ref_claim` while `revoked` gets `false` back.
- Leases released on `complete` (bind), `fail`, or conn cleanup (pid-less entries release immediately; pid-carrying entries follow kill-before-release via the returned Vec).

- [ ] **Step 1: Write the failing unit tests** (in `registry.rs` `#[cfg(test)]`, `now_ms` passed explicitly so no sleeping):

```rust
#[test]
fn second_claim_while_held_is_reserved() {
    let reg = test_registry();
    let s = locator("claude", "s1");
    assert!(matches!(reg.claim_session_ref(&s, "cr-A", 1, 1000), SessionRefClaim::Acquired));
    assert!(matches!(reg.claim_session_ref(&s, "cr-B", 2, 1500), SessionRefClaim::Held { .. }));
}

#[test]
fn completed_claim_yields_bound_elsewhere() {
    let reg = test_registry();
    let s = locator("claude", "s1");
    reg.claim_session_ref(&s, "cr-A", 1, 1000);
    assert!(reg.complete_session_ref_claim(&s, "cr-A", "term-1"));
    match reg.claim_session_ref(&s, "cr-B", 2, 2000) {
        SessionRefClaim::BoundElsewhere { terminal_id } => assert_eq!(terminal_id, "term-1"),
        other => panic!("expected BoundElsewhere, got {other:?}"),
    }
}

/// winner-dies-mid-claim (council red test): holder conn death releases the
/// pid-less lease; the loser's next claim wins.
#[test]
fn winner_dies_mid_claim_releases_lease() {
    let reg = test_registry();
    let s = locator("claude", "s1");
    reg.claim_session_ref(&s, "cr-A", 1, 1000);
    let to_kill = reg.release_session_ref_leases_for_conn(1);
    assert!(to_kill.iter().all(|(_, pid)| pid.is_none()));
    assert!(matches!(reg.claim_session_ref(&s, "cr-B", 2, 1500), SessionRefClaim::Acquired));
}

/// winner-hangs-mid-claim (council red test): TTL expiry with a recorded
/// child pid demands kill-before-release; confirmed kill releases; a pid-less
/// hung holder is revoked and HELD CLOSED, never released.
#[test]
fn winner_hangs_mid_claim_ttl_is_kill_before_release() {
    let reg = test_registry();
    let s = locator("claude", "s1");
    reg.claim_session_ref(&s, "cr-A", 1, 1000);
    reg.set_session_ref_lease_pid(&s, "cr-A", 4242);
    let late = 1000 + SESSION_REF_LEASE_TTL_MS + 1;
    match reg.claim_session_ref(&s, "cr-B", 2, late) {
        SessionRefClaim::ExpiredNeedsKill { pid } => assert_eq!(pid, 4242),
        other => panic!("expected ExpiredNeedsKill, got {other:?}"),
    }
    reg.force_release_after_confirmed_kill(&s);
    assert!(matches!(reg.claim_session_ref(&s, "cr-B", 2, late + 1), SessionRefClaim::Acquired));
}

#[test]
fn hung_holder_without_pid_is_revoked_and_held_closed() {
    let reg = test_registry();
    let s = locator("claude", "s1");
    reg.claim_session_ref(&s, "cr-A", 1, 1000);
    let late = 1000 + SESSION_REF_LEASE_TTL_MS + 1;
    assert!(matches!(reg.claim_session_ref(&s, "cr-B", 2, late), SessionRefClaim::Held { .. }));
    // The revoked holder's late completion is rejected.
    assert!(!reg.complete_session_ref_claim(&s, "cr-A", "term-late"));
}
```
(`test_registry()`/`locator()` helpers: copy the construction pattern from the existing registry tests — `rg -n "fn test" crates/freshell-ws/src/registry.rs`.)

- [ ] **Step 2: Run to verify failure**

```bash
cargo test -p freshell-ws claim_session_ref -- --nocapture || cargo test -p freshell-ws session_ref
```
Expected: FAIL — compile errors (API absent).

- [ ] **Step 3: Implement** the lease per the Produces block: a `Mutex<HashMap<String /* "provider\u{0}sessionId" */, SessionRefLease>>` next to `keyed_create_inflight`, plus `session_ref_bindings: Mutex<HashMap<String, String>>` (locator → terminalId) consulted by `claim_session_ref` alongside `live_terminal_for_session_ref` (a binding whose terminal is no longer live must NOT yield `BoundElsewhere` — check liveness before answering, so a dead winner doesn't strand losers).

- [ ] **Step 4: Run tests**

```bash
cargo test -p freshell-ws
```
Expected: PASS.

- [ ] **Step 5: fmt + clippy + commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
git add -A crates/
git commit -m "feat(ws): sessionRef liveness-bound lease with TTL kill-before-release semantics"
```

---

### Task 6: Server — create-path lease integration, `SESSION_RESERVED` error, ledger write at winner bind

**Files:**
- Modify: `crates/freshell-protocol/src/` (add `SESSION_RESERVED` error code + additive `retryAfterMs: Option<u64>` on `ErrorMsg`, `skip_serializing_if = "Option::is_none"`)
- Modify: `crates/freshell-ws/src/terminal.rs` (create path around the `KeyedCreateGuard` at :907 and adopt loop :937-976; connection-close cleanup site)
- Test: Create `crates/freshell-ws/tests/session_ref_singleflight.rs`

**Interfaces:**
- Consumes: Task 5 lease API; `KeyedCreateGuard` (`terminal.rs:907`); pane-ledger write API from wave A — `record_binding(&BindingWrite) -> io::Result<()>` with `BindingWrite { provider, session_id, terminal_id, mode, cwd, create_request_id, now_ms }` (locate the handle the inventory-stamping read path already uses: `rg -n "record_binding\|pane_ledger\|lookup_by_session" crates/`).
- Produces: on a `paneReconcileV1`-negotiated connection, a `terminal.create` carrying a resume `sessionRef` runs the lease discipline; losers receive `error{code: SESSION_RESERVED, requestId: <createRequestId>, retryAfterMs: 1000}`; the winner's successful spawn binds sessionRef→terminalId in registry AND ledger. Non-negotiated (frozen legacy) connections are byte-for-byte unchanged.

- [ ] **Step 1: Write the failing wire-level tests** in the new `tests/session_ref_singleflight.rs` (copy the helper mod from `tests/pane_reconcile.rs`):

```rust
/// two-clients-same-sessionRef (council red test): two negotiated
/// connections, DIFFERENT createRequestIds, same sessionRef resume ->
/// exactly one PTY; the loser is reserved then attaches to the winner.
#[tokio::test]
async fn two_clients_same_session_ref_yield_exactly_one_pty() {
    let server = spawn_server_default().await;
    let mut a = connect(&server.url, true).await;
    let mut b = connect(&server.url, true).await;
    a.send_json(terminal_create_resume("cr-A", "claude", "sess-dup")).await;
    b.send_json(terminal_create_resume("cr-B", "claude", "sess-dup")).await;
    // One connection gets terminal.created (spawn); collect both outcomes.
    let (created, other) = race_created_and_error(&mut a, &mut b).await;
    let tid = created["terminalId"].as_str().unwrap().to_string();
    // The other either got SESSION_RESERVED then, on re-send, terminal.created
    // for the SAME terminalId (adopt/attach), or adopted immediately.
    if other["type"] == "error" {
        assert_eq!(other["code"], "SESSION_RESERVED");
        assert!(other["retryAfterMs"].as_u64().unwrap() >= 1);
        // re-send after the hint
        resend_create_and_expect_created_for(&mut a, &mut b, &tid).await;
    } else {
        assert_eq!(other["terminalId"], tid);
    }
    assert_eq!(server.live_pty_count_for_session("claude", "sess-dup").await, 1);
}

/// Legacy connections (no capability) never see SESSION_RESERVED — the
/// frozen-client create path is byte-for-byte unchanged.
#[tokio::test]
async fn legacy_connection_create_path_unchanged() {
    let server = spawn_server_default().await;
    let mut legacy = connect(&server.url, false).await;
    legacy.send_json(terminal_create_resume("cr-L", "claude", "sess-legacy")).await;
    let created = next_frame_of_type(&mut legacy, "terminal.created").await;
    assert!(created["terminalId"].is_string());
}

/// Winner bind writes the ledger: after the winner's terminal.created,
/// lookup_by_session resolves sessionRef -> that terminalId.
#[tokio::test]
async fn winner_bind_writes_ledger_binding() {
    let server = spawn_server_default().await;
    let mut a = connect(&server.url, true).await;
    a.send_json(terminal_create_resume("cr-A", "claude", "sess-led")).await;
    let created = next_frame_of_type(&mut a, "terminal.created").await;
    let resolved = server.ledger_lookup("claude", "sess-led").await;
    assert_eq!(resolved.as_deref(), Some(created["terminalId"].as_str().unwrap()));
}
```
Helper notes: `terminal_create_resume` builds the same `terminal.create` JSON the client sends for resume (copy field names from an existing create-with-resume test or `shared/ws-protocol.ts` `TerminalCreateSchema:301` — it is `.strict()`, so it IS the wire truth). `live_pty_count_for_session` / `ledger_lookup` are small test accessors — expose them via the existing test-server handle pattern (the harness owns the state). Headless mode (`headless()`) keeps spawns cheap.

- [ ] **Step 2: Run to verify failure**

```bash
cargo test -p freshell-ws --test session_ref_singleflight
```
Expected: FAIL — today both creates spawn (two PTYs), no SESSION_RESERVED code exists.

- [ ] **Step 3: Implement**
  - Protocol: add `SESSION_RESERVED` to the error-code enum; add `retry_after_ms: Option<u64>` (wire `retryAfterMs`) to `ErrorMsg`.
  - `terminal.rs` create path (inside the negotiated branch that already hosts the keyed-create adopt loop :937-976):
    1. If the create carries a resume `sessionRef` (provider + sessionId resolvable from the create body): `claim_session_ref(...)` with the connection's id and `now_ms`.
    2. `BoundElsewhere{terminal_id}` → emit `terminal.created` for that existing terminal (mirror the adopt loop's emission — attach to the winner, spawn nothing).
    3. `Held{retry_after_ms}` → send `error{SESSION_RESERVED, requestId: create.request_id, retryAfterMs}`; do not spawn; do not charge the rate limiter (adopt precedent: `create_protection.rs:250`).
    4. `ExpiredNeedsKill{pid}` → kill the pid (SIGKILL), confirm death by polling `kill(pid, 0)` for ESRCH up to 500ms; confirmed → `force_release_after_confirmed_kill` then re-claim and proceed; NOT confirmed → treat as `Held` + `tracing::error!` (hold closed).
    5. `Acquired` → proceed to spawn; immediately after the PTY child exists call `set_session_ref_lease_pid`; on success call `complete_session_ref_claim` — if it returns `false` (revoked), kill the just-spawned child, confirm, and answer the create with a plain error (fail loud); on spawn failure call `fail_session_ref_claim`.
    6. On `complete_session_ref_claim == true`, write the ledger binding (best-effort, NEVER blocks the create):

```rust
if let Err(e) = ledger.record_binding(&BindingWrite {
    provider, session_id, terminal_id, mode, cwd, create_request_id, now_ms,
}) {
    tracing::error!(target: "invariant", error = %e,
        "pane-ledger record_binding failed at respawn-winner bind");
}
```
  - Connection-close cleanup (find where the ws connection teardown already releases per-conn resources): call `release_session_ref_leases_for_conn(conn)`; for returned pid-carrying entries, kill + confirm + `force_release_after_confirmed_kill` (same discipline as step 4).

- [ ] **Step 4: Run tests**

```bash
cargo test -p freshell-ws
```
Expected: PASS including `create_protection.rs` and `pane_reconcile.rs` suites.

- [ ] **Step 5: fmt + clippy + commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
git add -A crates/
git commit -m "feat(ws): per-sessionRef single-flight on the create path with SESSION_RESERVED + ledger bind (closes D8 server-side)"
```

---

### Task 7: Client — protocol schemas + pane content fields

**Files:**
- Modify: `shared/ws-protocol.ts` (ClientMessageSchema union :569, ServerMessage union :988)
- Modify: `src/store/paneTypes.ts` (`TerminalPaneContent` :68-97)
- Test: Create `test/unit/shared/ws-protocol.reconcile.test.ts`

**Interfaces:**
- Consumes: existing Zod patterns in `shared/ws-protocol.ts` (`HelloSchema:267`, `TerminalCreateSchema:301`).
- Produces (exact names later tasks import from `shared/ws-protocol.ts`):
  - `ReconcileSessionRefSchema` (`{provider: string, sessionId: string}` — reuse an existing sessionRef schema if one exists: `rg -n "sessionRef" shared/ws-protocol.ts` first),
  - `ReconcilePaneSchema`, `PaneReconcileRequestSchema` (+ in `ClientMessageSchema` union), types `ReconcilePane`, `PaneReconcileRequest`,
  - `PaneVerdictSchema` with `verdict: z.enum(['attach','respawn','fresh','dead_session','invalid','error'])`, `PaneReconcileResultSchema`, types `PaneVerdict`, `PaneReconcileResultMessage` (+ in the `ServerMessage` union),
  - `ReadyCapabilitiesSchema = z.object({ paneReconcileV1: z.literal(true).optional() }).optional()` merged into the ready message type,
  - error-frame type gains optional `retryAfterMs?: number` and the `SESSION_RESERVED` code string.
  - `TerminalPaneContent` gains: `reconcileNotice?: string` and `pendingReconcile?: 'respawn' | 'fresh'`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import {
  PaneReconcileRequestSchema,
  PaneReconcileResultSchema,
  ClientMessageSchema,
} from '@/../shared/ws-protocol' // match the repo's existing import path for shared/

describe('pane.reconcile schemas', () => {
  const request = {
    type: 'pane.reconcile.request',
    reconcileId: 'rec-1',
    panes: [{
      paneKey: 'tab1:paneA', kind: 'terminal', mode: 'claude',
      createRequestId: 'cr-1', terminalId: 'term-1',
      sessionRef: { provider: 'claude', sessionId: 's-1' }, status: 'running',
    }],
  }
  it('parses a valid request and accepts it in the client union', () => {
    expect(PaneReconcileRequestSchema.parse(request)).toBeTruthy()
    expect(ClientMessageSchema.safeParse(request).success).toBe(true)
  })
  it('rejects >200 panes', () => {
    const big = { ...request, panes: Array.from({ length: 201 }, (_, i) => ({ ...request.panes[0], paneKey: `t:${i}` })) }
    expect(PaneReconcileRequestSchema.safeParse(big).success).toBe(false)
  })
  it('parses a result with the 6-verdict enum and no retry', () => {
    const result = {
      type: 'pane.reconcile.result', reconcileId: 'rec-1', bootId: 'b1', serverInstanceId: 'srv1',
      verdicts: [
        { paneKey: 'tab1:paneA', verdict: 'attach', terminalId: 'term-1', corrected: true },
        { paneKey: 'tab1:paneB', verdict: 'error', reason: 'index_warming' },
      ],
    }
    expect(PaneReconcileResultSchema.parse(result)).toBeTruthy()
    expect(PaneReconcileResultSchema.safeParse({ ...result, verdicts: [{ paneKey: 'x', verdict: 'retry' }] }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npm run test:vitest -- run test/unit/shared/ws-protocol.reconcile.test.ts
```
Expected: FAIL — exports don't exist.

- [ ] **Step 3: Implement** the schemas per the Produces block (follow the file's existing style; the request schema mirrors the Rust wire exactly — field names camelCase, `panes: z.array(ReconcilePaneSchema).max(200)`). Add the two `TerminalPaneContent` fields with doc comments:

```ts
/** One-shot user-visible reconcile notice (corrected identity, fresh-by-reason, duplicate ignored). Rendered then cleared by TerminalView. */
reconcileNotice?: string
/** Set by verdict folding; consumed by TerminalView when it sends terminal.create. 'respawn' = create-with-resume from sessionRef; 'fresh' = clean create. */
pendingReconcile?: 'respawn' | 'fresh'
```
Check `normalizePaneContent` (`panesSlice.ts:61`) — if it whitelists fields, add both.

- [ ] **Step 4: Run tests**

```bash
npm run test:vitest -- run test/unit/shared/ws-protocol.reconcile.test.ts test/unit/store/panesSlice.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/ws-protocol.ts src/store/paneTypes.ts src/store/panesSlice.ts test/unit/shared/ws-protocol.reconcile.test.ts
git commit -m "feat(protocol): pane.reconcile client schemas, ready capabilities, reconcile pane fields"
```

---

### Task 8: Client — panesSlice reducers for verdict folding

**Files:**
- Modify: `src/store/panesSlice.ts`
- Test: Create `test/unit/store/panesSlice.reconcile.test.ts`

**Interfaces:**
- Consumes: `TerminalPaneContent` fields from Task 7; existing helpers in `panesSlice.ts` for locating a pane's content by `(tabId, paneId)` (see how `clearTerminalContentForRecreate` :544-568 walks the layout — reuse its lookup, NOT its body).
- Produces (exported actions later tasks dispatch):
  - `applyReconcileAttach({tabId, paneId, terminalId, serverInstanceId?, sessionRef?, corrected?, duplicate?})`
  - `resetPaneForReconcileCreate({tabId, paneId, intent: 'respawn'|'fresh', sessionRef?, reason?, corrected?})`
  - `setPaneReconcileNotice({tabId, paneId, notice})` / `clearPaneReconcileNotice({tabId, paneId})`
  - `setDeadSessionAdjudication(entries: DeadSessionEntry[])` / `resolveDeadSessionEntry({tabId, paneId})` / `clearDeadSessionAdjudication()` — non-persisted state field `deadSessionAdjudication: DeadSessionEntry[]` where `DeadSessionEntry = {tabId, paneId, title: string, mode: string, sessionRef?: {provider, sessionId}, reason?: string}`
  - `setReconcileWarming({count, paneRefs: {tabId, paneId}[]})` / `clearReconcileWarming()` — non-persisted field `reconcileWarming: {count: number, paneRefs: {tabId: string, paneId: string}[]} | null`
- CRITICAL: none of these reducers may mint a `createRequestId`. `resetPaneForReconcileCreate` PRESERVES the existing `createRequestId` (this is the load-bearing difference from `clearTerminalContentForRecreate`, which mints — D4).

- [ ] **Step 1: Write the failing tests** (copy store-construction boilerplate from `test/unit/store/panesSlice.test.ts`):

```ts
describe('reconcile reducers', () => {
  it('applyReconcileAttach sets terminalId/status without touching createRequestId', () => {
    const state = stateWithTerminalPane({ createRequestId: 'cr-keep', terminalId: undefined, status: 'creating' })
    const next = panesReducer(state, applyReconcileAttach({ tabId: 'tab1', paneId: 'p1', terminalId: 'term-9', serverInstanceId: 'srv-2', sessionRef: { provider: 'claude', sessionId: 's1' } }))
    const c = terminalContent(next, 'tab1', 'p1')
    expect(c.terminalId).toBe('term-9')
    expect(c.status).toBe('running')
    expect(c.createRequestId).toBe('cr-keep')   // council rule: never re-minted
    expect(c.restoreError).toBeUndefined()
  })
  it('applyReconcileAttach with corrected sets a visible notice', () => {
    const next = panesReducer(stateWithTerminalPane({}), applyReconcileAttach({ tabId: 'tab1', paneId: 'p1', terminalId: 't', corrected: true }))
    expect(terminalContent(next, 'tab1', 'p1').reconcileNotice).toMatch(/corrected/i)
  })
  it('resetPaneForReconcileCreate(respawn) clears handles, keeps createRequestId, sets server-named sessionRef', () => {
    const state = stateWithTerminalPane({ createRequestId: 'cr-keep', terminalId: 'dead', streamId: 'st', sessionRef: { provider: 'claude', sessionId: 'client-guess' } })
    const next = panesReducer(state, resetPaneForReconcileCreate({ tabId: 'tab1', paneId: 'p1', intent: 'respawn', sessionRef: { provider: 'claude', sessionId: 'server-truth' } }))
    const c = terminalContent(next, 'tab1', 'p1')
    expect(c.terminalId).toBeUndefined(); expect(c.streamId).toBeUndefined()
    expect(c.status).toBe('creating')
    expect(c.createRequestId).toBe('cr-keep')
    expect(c.sessionRef).toEqual({ provider: 'claude', sessionId: 'server-truth' })
    expect(c.pendingReconcile).toBe('respawn')
  })
  it('resetPaneForReconcileCreate(fresh) clears session identity and notes the reason', () => {
    const state = stateWithTerminalPane({ createRequestId: 'cr-keep', sessionRef: { provider: 'claude', sessionId: 'gone' }, resumeSessionId: 'gone' })
    const next = panesReducer(state, resetPaneForReconcileCreate({ tabId: 'tab1', paneId: 'p1', intent: 'fresh', reason: 'identity_never_observed' }))
    const c = terminalContent(next, 'tab1', 'p1')
    expect(c.sessionRef).toBeUndefined(); expect(c.resumeSessionId).toBeUndefined()
    expect(c.pendingReconcile).toBe('fresh')
    expect(c.reconcileNotice).toMatch(/identity_never_observed/)
  })
  it('dead-session adjudication is one batched list', () => {
    let s = panesReducer(undefined, setDeadSessionAdjudication([
      { tabId: 't1', paneId: 'p1', title: 'a', mode: 'claude' },
      { tabId: 't1', paneId: 'p2', title: 'b', mode: 'codex' },
    ]))
    expect(s.deadSessionAdjudication).toHaveLength(2)
    s = panesReducer(s, resolveDeadSessionEntry({ tabId: 't1', paneId: 'p1' }))
    expect(s.deadSessionAdjudication).toHaveLength(1)
  })
})
```
(Write `stateWithTerminalPane`/`terminalContent` helpers in the test using the slice's real initializers; the existing `panesSlice.test.ts` shows how a layout with a terminal pane is seeded.)

- [ ] **Step 2: Run to verify failure**

```bash
npm run test:vitest -- run test/unit/store/panesSlice.reconcile.test.ts
```
Expected: FAIL — actions don't exist.

- [ ] **Step 3: Implement** the reducers per the Produces block. Notice copy (exact strings, reused by later tasks/tests):
  - corrected: `Session identity corrected by server — this pane now points at its live session.`
  - duplicate: `A duplicate terminal for this session was detected and ignored.`
  - fresh with reason: `` `Started fresh (${reason}).` ``
  Ensure `deadSessionAdjudication` and `reconcileWarming` are stripped from persistence (check `persistMiddleware.ts:484`'s strip list — it already strips `restoreFallbackAttemptsByPane`; add these two the same way).

- [ ] **Step 4: Run tests**

```bash
npm run test:vitest -- run test/unit/store/panesSlice.reconcile.test.ts test/unit/store/panesSlice.test.ts test/unit/store/createRequestIdStability.test.ts
```
Expected: PASS (the stability suite proves we didn't regress P1.6).

- [ ] **Step 5: Commit**

```bash
git add src/store/panesSlice.ts src/store/persistMiddleware.ts test/unit/store/panesSlice.reconcile.test.ts
git commit -m "feat(store): reconcile verdict fold reducers - attach/reset without createRequestId re-mint, batched dead-session state"
```

---

### Task 9: Client — `pane-reconcile.ts` (request builder + verdict folding + cardinality invariant)

**Files:**
- Create: `src/lib/pane-reconcile.ts`
- Test: Create `test/unit/lib/pane-reconcile.test.ts`

**Interfaces:**
- Consumes: Task 7 schemas/types; Task 8 actions; the pane-tree walk — reuse/extract the logic of `collectTerminalPaneTargets` (`App.tsx:811`) rather than re-deriving it (either import it if exported, or move it into this module and re-export for App).
- Produces (exact exports):

```ts
export function buildReconcileRequest(state: RootState): PaneReconcileRequest | null
export function buildReconcileRequestForPanes(state: RootState, targets: {tabId: string, paneId: string}[]): PaneReconcileRequest | null
export interface FoldOutcome { attached: number; respawned: number; fresh: number; dead: number; warming: number; invalid: number; cardinalityViolation: boolean }
export function foldVerdicts(dispatch: AppDispatch, request: PaneReconcileRequest, result: PaneReconcileResultMessage): FoldOutcome
export function paneKeyFor(tabId: string, paneId: string): string   // `${tabId}:${paneId}`
```
- Rules: panes without a terminal content or without `createRequestId` are skipped; >200 panes → `console.error` breadcrumb + first 200 sent; `foldVerdicts` FIRST checks cardinality (`verdicts.length === request.panes.length` AND every `paneKey` matches 1:1) — on violation it dispatches NOTHING except the outcome flag (the caller falls back to the legacy census, Task 11); `paneKey` is parsed back via the request's own pane list (index paneKey→{tabId,paneId} from the request, never by string-splitting server input).

- [ ] **Step 1: Write the failing tests**

```ts
describe('buildReconcileRequest', () => {
  it('collects terminal panes with paneKey tab:pane and required createRequestId', () => {
    const state = storeStateWith2TerminalPanes() // helper: seed via real reducers
    const req = buildReconcileRequest(state)!
    expect(req.type).toBe('pane.reconcile.request')
    expect(req.panes).toHaveLength(2)
    expect(req.panes[0].paneKey).toBe(paneKeyFor('tab1', 'p1'))
    expect(req.panes[0].createRequestId).toBeTruthy()
    expect(req.panes[0].kind).toBe('terminal')
  })
  it('returns null with no terminal panes', () => {
    expect(buildReconcileRequest(emptyState())).toBeNull()
  })
})

describe('foldVerdicts', () => {
  it('dispatches the right action per verdict', () => {
    const { req, dispatch, dispatched } = foldHarness([
      ['attach',       { terminalId: 'T1' }],
      ['respawn',      { sessionRef: { provider: 'claude', sessionId: 's' } }],
      ['fresh',        { reason: 'identity_never_observed' }],
      ['dead_session', { sessionRef: { provider: 'codex', sessionId: 'gone' } }],
      ['error',        { reason: 'index_warming' }],
    ])
    const outcome = foldVerdicts(dispatch, req, resultFor(req, dispatched.verdicts))
    expect(outcome).toMatchObject({ attached: 1, respawned: 1, fresh: 1, dead: 1, warming: 1, cardinalityViolation: false })
    expect(dispatched.types).toContain(applyReconcileAttach.type)
    expect(dispatched.types).toContain(resetPaneForReconcileCreate.type)
    expect(dispatched.types).toContain(setDeadSessionAdjudication.type)
    expect(dispatched.types).toContain(setReconcileWarming.type)
  })
  it('dead sessions are batched into ONE setDeadSessionAdjudication dispatch (never N)', () => {
    const { req, dispatch, dispatched } = foldHarnessAllDead(3)
    foldVerdicts(dispatch, req, deadResultFor(req))
    expect(dispatched.countOf(setDeadSessionAdjudication.type)).toBe(1)
    expect(dispatched.lastPayloadOf(setDeadSessionAdjudication.type)).toHaveLength(3)
  })
  it('cardinality violation folds NOTHING and flags the caller', () => {
    const { req, dispatch, dispatched } = foldHarness([['attach', { terminalId: 'T1' }]])
    const short = { ...resultFor(req, []), verdicts: [] }
    const outcome = foldVerdicts(dispatch, req, short)
    expect(outcome.cardinalityViolation).toBe(true)
    expect(dispatched.types).toHaveLength(0)
  })
  it('error{provider_unavailable} becomes a per-pane restoreError, not warming', () => {
    const { req, dispatch, dispatched } = foldHarness([['error', { reason: 'provider_unavailable' }]])
    const outcome = foldVerdicts(dispatch, req, resultFor(req, dispatched.verdicts))
    expect(outcome.warming).toBe(0)
    // folded via the existing restoreError rendering path
  })
})
```
(Build `foldHarness` with a recording dispatch; seed state through real reducers so paneKeys resolve.)

- [ ] **Step 2: Run to verify failure**

```bash
npm run test:vitest -- run test/unit/lib/pane-reconcile.test.ts
```
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement.** Fold mapping (complete):
  - `attach` → `applyReconcileAttach({..., terminalId, serverInstanceId: result.serverInstanceId, sessionRef, corrected, duplicate})`
  - `respawn` → `resetPaneForReconcileCreate({..., intent: 'respawn', sessionRef: verdict.sessionRef, corrected})`
  - `fresh` → `resetPaneForReconcileCreate({..., intent: 'fresh', reason: verdict.reason})`
  - `dead_session` → collect `{tabId, paneId, title, mode, sessionRef, reason}`; after the loop, ONE `setDeadSessionAdjudication(all)`; ALSO set the per-pane loud breadcrumb via the existing restoreError shape (dispatch the existing action that sets `content.restoreError` — locate with `rg -n "restoreError" src/store/panesSlice.ts` and reuse; if only reachable via another reducer, extend `resetPaneForReconcileCreate`-style with a small `setPaneRestoreError` reducer in Task 8's file — keep it in panesSlice).
  - `invalid` → per-pane restoreError with `reason` (loud, non-destructive) + count in outcome.
  - `error` + `reason === 'index_warming'` → collect; after loop ONE `setReconcileWarming({count, paneRefs})`.
  - `error` + `reason === 'provider_unavailable'` → per-pane restoreError `PROVIDER_UNAVAILABLE`.

- [ ] **Step 4: Run tests**

```bash
npm run test:vitest -- run test/unit/lib/pane-reconcile.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pane-reconcile.ts test/unit/lib/pane-reconcile.test.ts src/store/panesSlice.ts
git commit -m "feat(client): pane-reconcile module - request builder, verdict folding, cardinality invariant"
```

---

### Task 10: Client — ws-client capability + ready-capabilities + replay suppression

**Files:**
- Modify: `src/lib/ws-client.ts` (hello :343, ready handling in `handleIncomingMessage` :148, replay :195-205)
- Test: Create `test/unit/lib/ws-client.reconcile.test.ts`

**Interfaces:**
- Consumes: `getWsClient()` (:643), `resetWsClientForTests()` (:652), `receiveMessageForTest` (:631) — the existing test seams.
- Produces: hello carries `paneReconcileV1: true`; `getWsClient().getServerCapabilities(): {paneReconcileV1?: true}` (empty object until a ready with capabilities arrives; RESET on disconnect so a downgraded server is honored); when `paneReconcileV1` was acked on the CURRENT socket's ready, the blind `inFlightCreates` replay is skipped (verdicts, not resends, decide — `preReadyCreateQueue` flush is unchanged: those are new user-initiated creates).

- [ ] **Step 1: Write the failing tests** (drive with `resetWsClientForTests` + `receiveMessageForTest`; mock the WebSocket the way existing ws-client tests do — `rg -l "resetWsClientForTests" test/` and copy the newest pattern):

```ts
it('hello advertises paneReconcileV1', () => {
  const sent = captureHello()  // helper: mock ws, trigger onopen, parse first frame
  expect(sent.capabilities).toMatchObject({ uiScreenshotV1: true, terminalOutputBatchV1: true, paneReconcileV1: true })
})
it('surfaces ready.capabilities and resets them on disconnect', () => {
  const client = getWsClient()
  receiveReady({ capabilities: { paneReconcileV1: true } })
  expect(client.getServerCapabilities().paneReconcileV1).toBe(true)
  simulateDisconnect()
  expect(client.getServerCapabilities().paneReconcileV1).toBeUndefined()
})
it('suppresses the in-flight create replay when the capability is acked', () => {
  seedInFlightCreate('cr-1')
  const frames = reconnectAndCollectFrames({ capabilities: { paneReconcileV1: true } })
  expect(frames.filter(f => f.type === 'terminal.create')).toHaveLength(0)
})
it('keeps the legacy replay when the server does not ack (old server)', () => {
  seedInFlightCreate('cr-1')
  const frames = reconnectAndCollectFrames({ /* no capabilities */ })
  expect(frames.filter(f => f.type === 'terminal.create')).toHaveLength(1)
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npm run test:vitest -- run test/unit/lib/ws-client.reconcile.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement**
  - `:343`: `capabilities: { uiScreenshotV1: true, terminalOutputBatchV1: true, paneReconcileV1: true },`
  - In the `ready` branch of `handleIncomingMessage`: `this.serverCapabilities = msg.capabilities ?? {}` BEFORE the replay block; clear it in the disconnect path (`onDisconnect`/`scheduleReconnect` entry).
  - Wrap the `inFlightCreates` replay (:195-205): `if (!this.serverCapabilities.paneReconcileV1) { /* existing replay */ }`.
  - Add `getServerCapabilities()` accessor.

- [ ] **Step 4: Run tests** (new + any existing ws-client/bootstrap suites)

```bash
npm run test:vitest -- run test/unit/lib/ws-client.reconcile.test.ts test/unit/App.ws-bootstrap.test.tsx
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ws-client.ts test/unit/lib/ws-client.reconcile.test.ts
git commit -m "feat(client): advertise paneReconcileV1, surface ready capabilities, gate blind create replay"
```

---

### Task 11: Client — App wiring: send request on ready, fold results, gate the legacy census; terminal-restore bypass

**Files:**
- Modify: `src/App.tsx` (ReadyMessageSchema :149; inventory census block :1018-1091)
- Modify: `src/lib/terminal-restore.ts`
- Test: Create `test/unit/App.reconcile-adoption.test.tsx`; Modify `test/unit/lib/terminal-restore.test.ts`

**Interfaces:**
- Consumes: Task 9 `buildReconcileRequest`/`foldVerdicts`, Task 10 capabilities, Task 8 actions.
- Produces: on every `ready` whose `capabilities.paneReconcileV1 === true`: `setPaneReconcileActive(true)` + build & send `pane.reconcile.request` + register the one-shot result fold (matched on `reconcileId`); the destructive census (`clearDeadTerminals` + restore-arming walk) runs ONLY when the capability is absent (`setLiveTerminalIds` + `setServerRestarted(false)` stay unconditional); cardinality violation → `console.error` + run the legacy census once for THIS inventory cycle (fail-safe); `terminal-restore.ts` exports `setPaneReconcileActive(v: boolean)` and, when active, `consumeTerminalRestoreRequestId` / `consumeTerminalFreshRecoveryRequest` report not-armed.

- [ ] **Step 1: Write the failing tests.** App-level: copy the store/ws mocking scaffold from `test/unit/App.ws-bootstrap.test.tsx` (it already boots App against a scripted ws).

```ts
it('sends pane.reconcile.request after ready-with-capability and does NOT run the census', async () => {
  seedPersistedTerminalPane({ createRequestId: 'cr-1' })
  const { sentFrames, dispatched } = await bootAppWithReady({ capabilities: { paneReconcileV1: true } })
  await receiveInventory({ liveTerminalIds: [] })
  expect(sentFrames.some(f => f.type === 'pane.reconcile.request')).toBe(true)
  expect(dispatched.types).not.toContain(clearDeadTerminals.type)
  expect(dispatched.types).toContain(setLiveTerminalIds.type) // non-destructive part stays
})
it('runs the legacy census when the server does not ack the capability', async () => {
  seedPersistedTerminalPane({ createRequestId: 'cr-1' })
  const { sentFrames, dispatched } = await bootAppWithReady({ /* no capabilities */ })
  await receiveInventory({ liveTerminalIds: [] })
  expect(sentFrames.some(f => f.type === 'pane.reconcile.request')).toBe(false)
  expect(dispatched.types).toContain(clearDeadTerminals.type)
})
it('folds a matching pane.reconcile.result', async () => {
  seedPersistedTerminalPane({ createRequestId: 'cr-1' })
  const { sentFrames, dispatched } = await bootAppWithReady({ capabilities: { paneReconcileV1: true } })
  const req = sentFrames.find(f => f.type === 'pane.reconcile.request')!
  await receiveServerFrame(attachResultFor(req, 'term-77'))
  expect(dispatched.types).toContain(applyReconcileAttach.type)
})
it('cardinality violation falls back to the census, loudly', async () => {
  seedPersistedTerminalPane({ createRequestId: 'cr-1' })
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const { sentFrames, dispatched } = await bootAppWithReady({ capabilities: { paneReconcileV1: true } })
  const req = sentFrames.find(f => f.type === 'pane.reconcile.request')!
  await receiveServerFrame({ type: 'pane.reconcile.result', reconcileId: req.reconcileId, bootId: 'b', serverInstanceId: 's', verdicts: [] })
  await receiveInventory({ liveTerminalIds: [] })
  expect(errSpy).toHaveBeenCalled()
  expect(dispatched.types).toContain(clearDeadTerminals.type)
})
```
`terminal-restore.test.ts` additions: after `setPaneReconcileActive(true)`, `addTerminalRestoreRequestId('cr-x')` then `consumeTerminalRestoreRequestId('cr-x')` → falsy; after `setPaneReconcileActive(false)` the latch behaves as before.

- [ ] **Step 2: Run to verify failure**

```bash
npm run test:vitest -- run test/unit/App.reconcile-adoption.test.tsx test/unit/lib/terminal-restore.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement**
  - `App.tsx` ready handler: extend the local `ReadyMessageSchema` (:149) with the optional capabilities object; then:

```ts
const paneReconcile = ready.capabilities?.paneReconcileV1 === true
paneReconcileActiveRef.current = paneReconcile
setPaneReconcileActive(paneReconcile)
if (paneReconcile) {
  const req = buildReconcileRequest(store.getState())
  if (req) {
    pendingReconcileRef.current = req
    getWsClient().send(req)
  }
}
```
  - Message handler: on `pane.reconcile.result` with `reconcileId === pendingReconcileRef.current?.reconcileId` → `const outcome = foldVerdicts(dispatch, pendingReconcileRef.current, msg)`; clear the ref; if `outcome.cardinalityViolation` → `console.error('[reconcile] cardinality violation — falling back to legacy census')` + `paneReconcileActiveRef.current = false` + `setPaneReconcileActive(false)` (re-set true on the next ready).
  - Census block (:1018-1091): wrap ONLY the destructive part (`clearDeadTerminals` dispatch + the `addTerminalRestoreRequestId`/`addTerminalFreshRecoveryRequestId` walk) in `if (!paneReconcileActiveRef.current) { ... }`.
  - `terminal-restore.ts`:

```ts
let paneReconcileActive = false
export function setPaneReconcileActive(v: boolean): void { paneReconcileActive = v }
// first line of consumeTerminalRestoreRequestId and consumeTerminalFreshRecoveryRequest:
if (paneReconcileActive) return undefined  // (or false — match each fn's return type)
```

- [ ] **Step 4: Run tests**

```bash
npm run test:vitest -- run test/unit/App.reconcile-adoption.test.tsx test/unit/lib/terminal-restore.test.ts test/unit/App.ws-bootstrap.test.tsx test/unit/App.restart-signals.test.tsx
```
Expected: PASS (existing App suites prove the legacy path is intact).

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/lib/terminal-restore.ts test/unit/App.reconcile-adoption.test.tsx test/unit/lib/terminal-restore.test.ts
git commit -m "feat(client): reconcile on ready-with-capability; census becomes the capability-gated fallback (F3/F4)"
```

---

### Task 12: Client — TerminalView: verdict-driven create, SESSION_RESERVED + INVALID_TERMINAL_ID bounded retry, exhaustion auto-resolve

**Files:**
- Modify: `src/components/TerminalView.tsx` (create send site :2789-2825; error-frame handling — locate with `rg -n "INVALID_TERMINAL_ID" src/`)
- Test: Create `test/unit/components/TerminalView.session-reserved.test.tsx`

**Interfaces:**
- Consumes: `pendingReconcile`/`reconcileNotice` (Task 7/8), `getCreateSessionStateFromRef` (`src/components/terminal-view-utils.ts:9`), `buildReconcileRequestForPanes` + `foldVerdicts` (Task 9), `writeLocalXtermNotice` (:909), server error frames `{code: 'SESSION_RESERVED', requestId, retryAfterMs}` (Task 6).
- Produces:
  - Create args: when `pendingReconcile === 'respawn'` → resume args come from `content.sessionRef` (the server-named ref — precedence over any other inference) with `restore: true`; when `'fresh'` → no resume fields; field cleared when `terminal.created` arrives.
  - `RESERVE_RETRY_WINDOW_MS = 30_000` (> lease TTL 20s + margin, council rule) and `RESERVE_RETRY_FLOOR_MS = 250`: on `SESSION_RESERVED` matching this pane's `createRequestId`, re-send the same `terminal.create` after `max(retryAfterMs, floor)`, until the window is spent.
  - Exhaustion auto-resolve: after the window, send `buildReconcileRequestForPanes(state, [thisPane])` and fold the single verdict — binding exists → attach silently; winner failed → dead_session/fresh flow with visible notice. Never a permanent error, never a dead button. (This is the client half of `loser-exhausts-then-holder-fails`.)
  - F9: launch-time `INVALID_TERMINAL_ID` for this pane → bounded retry (5 attempts, 500ms apart) through the same re-drive helper before surfacing `status:'error'`.
  - `reconcileNotice` rendered once via `writeLocalXtermNotice` after attach, then `clearPaneReconcileNotice`.

- [ ] **Step 1: Write the failing tests** (fake timers; mock ws-client send; copy mounting scaffold from `test/unit/components/TerminalView.restore-flag-persistence.test.tsx`):

```ts
it('respawn create uses the server-named sessionRef with restore:true', () => {
  mountPane({ pendingReconcile: 'respawn', sessionRef: { provider: 'claude', sessionId: 'server-truth' }, status: 'creating', createRequestId: 'cr-1' })
  const create = lastSentOfType('terminal.create')
  expect(create.restore).toBe(true)
  expect(resumeIdentityOf(create)).toMatchObject({ provider: 'claude', sessionId: 'server-truth' })
})
it('SESSION_RESERVED re-drives the same create after retryAfterMs, same createRequestId', async () => {
  mountPane({ pendingReconcile: 'respawn', status: 'creating', createRequestId: 'cr-1' })
  receiveError({ code: 'SESSION_RESERVED', requestId: 'cr-1', retryAfterMs: 1000 })
  expect(countSentOfType('terminal.create')).toBe(1)
  await vi.advanceTimersByTimeAsync(1000)
  expect(countSentOfType('terminal.create')).toBe(2)
  expect(lastSentOfType('terminal.create').requestId).toBe('cr-1') // never re-minted
})
/// loser-exhausts-then-holder-fails (council red test, client half):
it('exhaustion auto-resolves via a single-pane reconcile — never a wedge', async () => {
  mountPane({ pendingReconcile: 'respawn', status: 'creating', createRequestId: 'cr-1' })
  // keep answering SESSION_RESERVED past the 30s window
  autoRespondErrors({ code: 'SESSION_RESERVED', requestId: 'cr-1', retryAfterMs: 1000 })
  await vi.advanceTimersByTimeAsync(31_000)
  expect(lastSentOfType('pane.reconcile.request')).toBeTruthy()
  // holder failed -> server answers dead_session; assert the fold ran and a notice is visible
  receiveServerFrame(deadSessionResultForLastRequest())
  expect(paneShowsRestoreErrorCard()).toBe(true)
})
it('INVALID_TERMINAL_ID at launch is retried bounded (F9), not a permanent error', async () => {
  mountPane({ status: 'creating', createRequestId: 'cr-1', terminalId: 'term-stale' })
  receiveError({ code: 'INVALID_TERMINAL_ID', terminalId: 'term-stale' })
  await vi.advanceTimersByTimeAsync(500)
  expect(countSentOfType('terminal.create')).toBeGreaterThanOrEqual(2)
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npm run test:vitest -- run test/unit/components/TerminalView.session-reserved.test.tsx
```
Expected: FAIL.

- [ ] **Step 3: Implement.** One small internal helper owns both retries:

```ts
// Bounded re-drive: SESSION_RESERVED honors the server hint inside a 30s
// window (> lease TTL + margin); INVALID_TERMINAL_ID gets 5 x 500ms.
// On exhaustion: single-pane reconcile -> fold (auto-resolve, council rule 8).
```
At the create site, resume-arg precedence: `pendingReconcile === 'respawn'` → `getCreateSessionStateFromRef(content.sessionRef)` result wins; `'fresh'` → omit resume fields entirely. Clear `pendingReconcile` on `terminal.created`. After attach, if `content.reconcileNotice` → `writeLocalXtermNotice(term, content.reconcileNotice)` + dispatch `clearPaneReconcileNotice`.

- [ ] **Step 4: Run tests**

```bash
npm run test:vitest -- run test/unit/components/TerminalView.session-reserved.test.tsx test/unit/components/TerminalView.restore-flag-persistence.test.tsx
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/TerminalView.tsx test/unit/components/TerminalView.session-reserved.test.tsx
git commit -m "feat(client): verdict-driven create args; bounded SESSION_RESERVED/INVALID_TERMINAL_ID re-drive with auto-resolve exhaustion"
```

---

### Task 13: Client — DeadSessionPanel (ONE batched panel) + warming banner (ONE banner)

**Files:**
- Create: `src/components/DeadSessionPanel.tsx`
- Create: `src/components/ReconcileWarmingBanner.tsx`
- Modify: `src/App.tsx` (render both near the existing modal/banner region)
- Test: Create `test/unit/components/DeadSessionPanel.test.tsx` (covers both components)

**Interfaces:**
- Consumes: `deadSessionAdjudication` / `reconcileWarming` state + `resolveDeadSessionEntry` / `clearDeadSessionAdjudication` / `clearReconcileWarming` / `resetPaneForReconcileCreate` (Task 8); pane-close action (locate the existing close-pane dispatch: `rg -n "closePane" src/store/panesSlice.ts`); `buildReconcileRequestForPanes` (Task 9).
- Produces: `DeadSessionPanel` — a single `role="dialog"` (aria-label "Dead sessions") listing ALL entries with per-row semantic `<button>`s **Start fresh here** (dispatch `resetPaneForReconcileCreate({intent:'fresh'})` — same `createRequestId`, I7) and **Close pane**, plus **Dismiss** (keeps per-pane restoreError cards; nothing auto-closed). `ReconcileWarmingBanner` — one `role="status"` banner: `Waiting for session index — N pane(s)` + **Retry now** button that re-sends a reconcile request for exactly the warming panes. A11y rules from AGENTS.md apply (semantic buttons, aria-labels, no div-onClick).

- [ ] **Step 1: Write the failing tests**

```ts
/// F11-human: one panel, never N modals.
it('renders ONE dialog listing all dead panes', () => {
  renderWithStore({ deadSessionAdjudication: [entry('p1'), entry('p2'), entry('p3')] })
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(screen.getAllByRole('button', { name: /start fresh here/i })).toHaveLength(3)
})
it('Start fresh dispatches a fresh reset preserving createRequestId and removes the row', async () => {
  const { store } = renderWithStore({ deadSessionAdjudication: [entry('p1')] })
  await userEvent.click(screen.getByRole('button', { name: /start fresh here/i }))
  expect(dispatchedTypes(store)).toContain(resetPaneForReconcileCreate.type)
  expect(store.getState().panes.deadSessionAdjudication).toHaveLength(0)
})
it('renders nothing when the list is empty', () => {
  renderWithStore({ deadSessionAdjudication: [] })
  expect(screen.queryByRole('dialog')).toBeNull()
})
/// restart-storm-all-panes-warming (council red test, client half):
it('N warming panes produce exactly ONE banner with the count', () => {
  renderWithStore({ reconcileWarming: { count: 7, paneRefs: sevenRefs() } })
  expect(screen.getAllByRole('status')).toHaveLength(1)
  expect(screen.getByRole('status')).toHaveTextContent(/waiting for session index/i)
  expect(screen.getByRole('status')).toHaveTextContent(/7/)
})
it('Retry now re-sends a reconcile request for exactly the warming panes', async () => {
  renderWithStore({ reconcileWarming: { count: 2, paneRefs: [ref('p1'), ref('p2')] } })
  await userEvent.click(screen.getByRole('button', { name: /retry now/i }))
  const req = lastSentOfType('pane.reconcile.request')
  expect(req.panes).toHaveLength(2)
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npm run test:vitest -- run test/unit/components/DeadSessionPanel.test.tsx
```
Expected: FAIL.

- [ ] **Step 3: Implement** both components per the Produces block (shadcn/ui dialog + Tailwind, matching neighboring components' style) and mount them in `App.tsx` beside the existing modal region (`rg -n "AuthRequiredModal" src/App.tsx` — render adjacent).

- [ ] **Step 4: Run tests + lint (a11y is CI-gated)**

```bash
npm run test:vitest -- run test/unit/components/DeadSessionPanel.test.tsx
npm run lint
```
Expected: PASS, no new a11y violations.

- [ ] **Step 5: Commit**

```bash
git add src/components/DeadSessionPanel.tsx src/components/ReconcileWarmingBanner.tsx src/App.tsx test/unit/components/DeadSessionPanel.test.tsx
git commit -m "feat(client): batched dead-session adjudication panel + single warming banner with manual retry"
```

---

### Task 14: E2E — new adoption spec, flip the P1.7 pin, update the double-restart guard

**Files:**
- Create: `test/e2e-browser/specs/reconcile-client-adoption-rust.spec.ts`
- Modify: `test/e2e-browser/specs/restore-contract-wall-rust.spec.ts` (:1877-1880 pin; :2042 guard)

**Interfaces:**
- Consumes: `RustServer` (`test/e2e-browser/helpers/rust-server.ts` — `start()`, `restart()`, `restartAbrupt()`, `stop()`, `info {port, baseUrl, wsUrl, token, homeDir}`); the wall spec's existing fixture-session + `browser.newContext()` patterns (read the wall spec's two-clients test at :1867-1961 and its fixture setup before writing anything).
- Produces: e2e proof that verdicts drive recovery end-to-end with the real SPA; the flipped pin (an unexpected PASS of a `test.fail` is a hard suite failure, so the pin MUST be deleted in the same commit that makes it pass — this task, after Tasks 2-13 are merged into the branch).

- [ ] **Step 1: Flip the pin.** Delete the `test.fail(e2eServerKind === 'rust', 'P1.7 (D8): ...')` line at `restore-contract-wall-rust.spec.ts:1877-1880` (delete the pin line only — never widen it). The test body (`expect(respawns.length).toBe(1)` at :1961) now must pass against the adopted client + leased server.

- [ ] **Step 2: Update the double-restart guard** at :2042. It currently pins observed legacy behavior ("OBSERVE-THEN-PIN … paneReconcileV1 never sent"). Rewrite its expectation to the adopted reality: the client DOES send `pane.reconcile.request` after each ready, and after a double restart mid-reconcile the panes converge (each persisted pane ends with exactly one live terminal; assert via `/api/terminals` as the wall spec already does). Keep the test's name and scenario; change only the assertions that encoded the legacy observation.

- [ ] **Step 3: Write the new spec** `reconcile-client-adoption-rust.spec.ts` with three scenarios (own `RustServer` per test group, real SPA pages via `page.goto(server.info.baseUrl + '/?token=' + server.info.token)` — copy the wall spec's boot helper):

```ts
test('restart with mixed pane types: verdicts drive recovery, census never destroys', async ({ browser }) => {
  // 1. Boot SPA; create a shell pane and a fake-CLI pane with a fixture
  //    session file in the server home (copy the wall spec's fixture helper).
  // 2. server.restart()
  // 3. Assert: shell pane comes back live (fresh/respawn per contract — it
  //    renders a working terminal, no restoreError); CLI pane resumes with
  //    the SAME sessionRef (assert resume args via /api/terminals);
  //    pane count unchanged (nothing destroyed by census — F3 closed).
})
test('dead sessions surface as ONE batched adjudication panel', async ({ browser }) => {
  // 1. Two fake-CLI panes with fixture session files; verify both live.
  // 2. server.stop({ preserveHome }); delete both session files from the
  //    server home; server.start() (same home).
  // 3. Assert: exactly one [role=dialog] listing both panes; click
  //    "Start fresh here" on the first -> that pane becomes a live terminal
  //    (same createRequestId observable via /api/terminals row count for the
  //    pane: exactly 1); second entry still listed; nothing auto-closed.
})
test('double-restart mid-reconcile converges with no duplicates', async ({ browser }) => {
  // 1. Boot SPA with 2 CLI panes (fixture sessions).
  // 2. server.restartAbrupt(); wait ~300ms into the reconcile window;
  //    server.restartAbrupt() again.
  // 3. Assert: within the recovery timeout every pane settles to a live
  //    terminal or an explicit labeled state (no permanent 'creating' wedge),
  //    and /api/terminals shows exactly one live PTY per createRequestId.
})
```
These comments are the scenario contract; the bodies must be real Playwright code following the wall spec's helpers (settle-loops, `expect.poll` on `/api/terminals`). Robust additional experiments (e.g. killing one browser context mid-retry) are encouraged as extra tests, not replacements.

- [ ] **Step 4: Run the touched e2e suites**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium \
  test/e2e-browser/specs/reconcile-client-adoption-rust.spec.ts
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium \
  test/e2e-browser/specs/restore-contract-wall-rust.spec.ts
```
Expected: new spec PASS; wall spec PASS including the unpinned two-clients test (this is the headline red→green) and the rewritten double-restart guard. Iterate here until green — this task is the integration proof of the whole lane.

- [ ] **Step 5: Commit**

```bash
git add test/e2e-browser/specs/
git commit -m "test(e2e): reconcile client adoption proofs; flip P1.7 D8 pin - two clients one sessionRef now yields exactly 1 PTY"
```

---

### Task 15: Final verification, full suites, push (STOP before PR)

**Files:** none new (fixes only if gates fail).

**Interfaces:**
- Consumes: everything above.
- Produces: green full gates; pushed branch; red→green report. NO PR.

- [ ] **Step 1: Rust gates**

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```
Expected: all PASS.

- [ ] **Step 2: Coordinated JS suite** (waits politely on the shared gate; 3 sibling lanes run concurrently — WAIT, never kill a foreign holder)

```bash
FRESHELL_TEST_SUMMARY="B1 reconcile client adoption: full-suite gate before push" env -u NODE_ENV npm test
```
Expected: PASS (default + server configs).

- [ ] **Step 3: E2E rust project** (at minimum the two touched specs; run the full rust project if time allows)

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium
```
Expected: PASS, including the formerly-pinned two-clients test.

- [ ] **Step 4: Push the branch — and STOP**

```bash
git push -u origin HEAD
```
Do NOT run `gh pr create` (not approved). Report: branch name, commit list, and the red→green proof for each named council red test (`warming-never-completes`, `restart-storm-all-panes-warming`, `two-clients-same-sessionRef`, `winner-dies-mid-claim`, `winner-hangs-mid-claim`, `loser-exhausts-then-holder-fails`) plus the flipped P1.7 pin.

---

## Self-Review Notes (spec coverage map)

| Spec requirement | Covering task(s) |
|---|---|
| Client sends `capabilities.paneReconcileV1` | 10 |
| Reconcile request on reconnect/restart with persisted panes | 9, 11 |
| attach → plain attach, no recreate, no new createRequestId | 8, 9 (tests pin it) |
| respawn → create-with-resume from server-named sessionRef | 8, 9, 12 |
| fresh → clean create | 8, 9 |
| dead_session → loud breadcrumb + ONE batched panel (F11-human) | 9, 13, 14 |
| corrected:true → user-visible notice, never silent | 8 (notice), 12 (render), 4 (server emit) |
| Legacy census as capability-gated fallback, not deleted | 11, 14 (guard rewrite proves old-server path) |
| retry verdict DELETED from wire | 2 |
| Bounded warming deferral (2s, single) then loud error{INDEX_WARMING} + manual retry | 2 (server), 13 (retry affordance) |
| PROVIDER_UNAVAILABLE for known provider w/o home | 3 |
| Warming storm → ONE banner | 13 (`restart-storm-all-panes-warming`) |
| Red test warming-never-completes | 2 |
| SessionRef-level single-flight; winner binds registry + ledger; others attach | 4, 5, 6 |
| Liveness-bound lease, TTL kill-before-release, hold-closed on unconfirmed kill | 5, 6 |
| Losers: SESSION_RESERVED + retryAfterMs; client window > TTL + margin | 6, 12 |
| Exhaustion auto-resolves (attach silently / dead-fresh with notice) | 12 (`loser-exhausts-then-holder-fails`) |
| ≥2-live-PTYs-per-sessionRef alarm | 4 |
| Red tests two-clients-same-sessionRef / winner-dies / winner-hangs | 6, 5, 5 (+ e2e 14) |
| F9 INVALID_TERMINAL_ID bounded retry (council: ships in this slice) | 12 |
| Flip P1.7 pins | 14 |
| E2E: mixed restart / two contexts one sessionRef / dead-session panel / double restart | 14 (two-contexts = the unpinned wall test) |
| B4 conflict kept tight (reconcile.rs dispatch arm untouched) | 2, 3, 4 (explicit non-goals) |

No unresolved coverage gaps.
