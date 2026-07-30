# REST Codex Terminal Identity Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `subagent-driven-development` or `executing-plans` to implement this plan
> task-by-task. Preserve the RED evidence before production edits, use a fresh
> implementer for each task, and run spec and quality review after every task.

**Goal:** Fix the duplicate History-sidebar row caused by an explicitly resumed
Codex terminal created through `POST /api/tabs`: the terminal registry row, the
shared in-memory terminal identity, the durable pane-ledger binding, and the
browser's cached terminal-directory row must converge on the same terminal and
session through the create's ordered invalidation sequence.

**Architecture:** Add an atomic publication primitive to
`TerminalRegistry`. It inserts the new terminal row and invokes a synchronous,
in-memory identity hook while holding the registry lock, then opens a
per-create exit gate. No inventory reader, `Created` activity observer, or exit
retirement can observe the row between insertion and identity publication.
Durable pane-ledger I/O remains a separate awaited future outside the registry
lock. The existing injected identity bridge will expose an async ownership
preflight, synchronous publication, and awaited typed durability phases. The
REST path will use the new authority behavior only for a validated, nonempty,
explicit Codex `sessionRef`; it will not infer authority from
`resumeSessionId`. After settlement, ordinary delivery will mirror the
WebSocket create order: `ui.command`, unconditional shared-revision
`terminals.changed`, then canonical `terminal.meta.updated` when identity was
published. Deferred delivery omits the `ui.command` broadcast but emits the
same invalidations before returning the targeted command. The WebSocket path
will move its existing in-memory identity upsert into the same atomic
publication primitive, closing the same latent race without changing its
identity rules.

**Persistence claim:** An awaited successful pane-ledger write is reloaded
after a normal process/server restart. This plan does not claim that the first
write survives every power-loss, filesystem, controller-cache, or storage
failure scenario.

**Tech stack:** Rust 2021, Axum, Tokio, `freshell-terminal`,
`freshell-freshagent`, `freshell-server`, `freshell-ws`, React 18, Redux
Toolkit, Vitest, Testing Library.

## Global Constraints

- Work only in
  `/home/dan/code/freshell/.worktrees/rest-terminal-session-identity` on branch
  `fix/rest-terminal-session-identity`, forked from
  `4c04dc9c1d5bd603ac6bb00540cfbafed675a78b`.
- The exact base suite is already green: 9,585 tests passed, 27 skipped, and
  zero failed. Preserve that evidence in the final report.
- Use red/green/refactor TDD. The combined route regression in Task 1 must run
  and produce the exact runtime RED tuple before any production wiring changes.
- Scope the new REST authority rule to `mode == "codex"` plus the already
  validated, explicit, nonempty `accepted_session_ref` whose provider is
  `"codex"`.
- Do not derive authoritative identity from raw `resumeSessionId`, from the
  existing pane-payload promotion heuristic, from locator output, or from a
  CLI extension manifest.
- Do not change pending-marker behavior, Claude/OpenCode/Amplifier identity
  semantics, extension/provider identity semantics, or sidebar selector
  semantics. The one intentional cross-mode parity change is an unconditional
  `terminals.changed` after every successful REST terminal create.
- Preserve existing pane payload compatibility: the pre-existing
  `resumeSessionId`-to-`paneContent.sessionRef` promotion may remain for UI
  payloads, but it must not enter the new authoritative publication path.
- `freshell-freshagent` must not depend on `freshell-ws`; the existing injected
  bridge remains the crate-cycle boundary.
- Synchronous publication must do no filesystem I/O, must not await, and must
  not re-enter `TerminalRegistry`. Pane-ledger I/O must remain on
  `spawn_blocking` and outside the registry lock.
- A durable write degradation or I/O error must not kill a successfully
  spawned terminal or turn its REST response into an error. It must return
  HTTP 200 and broadcast exactly one `durability.degraded` frame with a
  machine-distinct reason.
- Protect an already-live fresh Codex owner. Check exact liveness immediately
  before spawn; when live, do not publish terminal identity and do not
  overwrite its `paneKind:"fresh-agent"` row.
- Preserve D7/D8 single-writer protection, spawn-gate ownership, managed Codex
  adoption, locator arming, create dedupe, restore-key replay, pane/tab
  bookkeeping, and PTY group-kill discipline.
- Do not touch live port 3002, production state, the preserved evidence bundle,
  or user processes.
- Do not create a PR, merge, deploy, restart the production server, or remove
  the worktree without separate explicit user approval.

## Load-Bearing Validation Ledger

The load-bearing finder, strategist, validators, and controller checked the
plan against the current code and the preserved incident shape. These results
are requirements, not suggestions.

| ID | Assumption tested | Evidence / cheapest reliable method | Verdict | Plan consequence |
| --- | --- | --- | --- | --- |
| LB-1 | The duplicate is only a client-selector problem. | Inspected `POST /api/tabs`, `/api/terminals`, `TerminalIdentityRegistry`, `PaneLedger`, and `sidebarSelectors`. The pane had `codex:<session>` while the live directory row lacked `sessionRef`, so the selector correctly emitted its documented `codex:terminal:<terminal>` fallback. | **Falsified** | Fix the server publication path; do not patch selector dedupe. |
| LB-2 | An identity upsert after `TerminalRegistry::create` is sufficiently ordered. | Inspected `TerminalRegistry::create`: it inserts the row, increments revision, drops the registry lock, logs/notifies `Created`, and returns before caller-owned identity work. A concurrent directory/inventory read can observe the row first. | **Falsified** | Add atomic row-plus-identity publication under the registry lock. |
| LB-3 | The existing PTY exit hook cannot outrun post-create identity publication. | Inspected `PtyTerminal::spawn_with_sink` and current REST/WS exit hooks. An immediately exiting child can call retirement before the caller publishes identity, leaving a later upsert incorrectly live. | **Falsified** | Add a per-create exit gate and deterministic instant-exit regression. |
| LB-4 | A raw `resumeSessionId` is equivalent authority to a validated explicit `sessionRef`. | Inspected `derive_resume_identity` and the separate pane-payload promotion heuristic. Raw resume values have compatibility and provider-specific meanings not covered by this incident's acceptance proof. | **Falsified** | Gate the new authority path strictly to explicit accepted Codex `sessionRef`; preserve payload behavior without using it as authority. |
| LB-5 | The incident requires pending markers or changes for providers other than Codex. | Preserved evidence and route/code inspection identify an explicit recovered Codex session. No pending, Claude, OpenCode, Amplifier, or extension failure is needed to reproduce it. | **Falsified** | Delete pending/provider expansion from scope and add negative contract tests. |
| LB-6 | Rewriting the old pane-ledger owner is always safe. | Inspected `PaneLedger::record_binding`: it will replace a row keyed by `(provider,sessionId)`, including a `paneKind:"fresh-agent"` row. A stale terminal owner should be replaced, but an actually-live fresh Codex owner must not be. | **Conditionally verified** | Add a weak fresh-Codex liveness seam and typed `LiveFreshAgentOwner` degradation; preserve the live fresh-agent row. |
| LB-7 | A disabled ledger is indistinguishable from a successful durable write. | `PaneLedger::is_enabled` exists, while current disabled writes return `Ok(())`. | **Falsified** | Return typed `Degraded(LedgerUnavailable)` instead of calling it durable. |
| LB-8 | Awaiting `record_binding` proves only an in-memory update. | `PaneLedger` writes the row file before its write-through index; constructing a new ledger over the same temporary root reloads it. | **Verified for restart persistence** | Add enabled-ledger disk-reload coverage. Do not promise universal power-loss durability. |
| LB-9 | The browser needs a selector patch to recover a cached unidentified terminal row. | Inspected `terminal-invalidation-handler`, `fetchTerminalDirectoryWindow`, and the directory reducer. `terminals.changed` plus `terminal.meta.updated` debounce to one refresh; the GET accepts the cached revision but still returns current items, and non-append replacement removes the stale row even when the derived revision is unchanged. | **Verified false** | Emit unconditional `terminals.changed` for every successful REST terminal create, add canonical metadata only when identity is published, add a real Redux/App same-revision cached-row regression, and leave selectors unchanged. |
| LB-10 | Deferred restore delivery can skip terminal invalidations because no `ui.command` is broadcast. | Inspected `create_terminal_or_content_tab_deferred`: the UI command is returned to a targeted delivery path, so unrelated live clients otherwise receive no create signal. | **Falsified** | Emit canonical metadata and `terminals.changed` for both broadcast and deferred delivery before the HTTP response. |
| LB-11 | This fix can make terminal-vs-fresh-agent admission fully atomic. | The terminal registry lock, async fresh-agent session maps, and pane-ledger lock are separate domains. A weak liveness check can protect an owner already live at the check, but a concurrent cross-kind create can begin after it. | **Falsified / out of incident scope** | Document the residual concurrent cross-kind admission race; do not claim it is solved here. |

### Resulting scope corrections

1. The original plan's raw-resume canonicalization, new pending-marker writes,
   provider-wide behavior, and selector fallback were removed.
2. The exact combined route regression moved ahead of all production changes.
3. Atomic registry publication and an early-exit gate became prerequisites.
4. Durability became a typed outcome rather than `Ok(()) == durable`.
5. Live fresh-agent ownership became a protected degradation case.
6. Browser invalidation and same-revision replacement became an integration
   acceptance test.
7. `terminals.changed` became unconditional for successful REST terminal
   creates; canonical metadata remains conditional on published identity.

## File Map

- Modify `crates/freshell-terminal/src/registry.rs`: atomic create publication
  API, internal exit gate, deterministic concurrency tests.
- Modify `crates/freshell-ws/src/terminal.rs`: move its existing create-time
  identity upsert into the atomic publication hook; keep durable work outside
  the registry lock.
- Modify `crates/freshell-ws/src/pane_ledger.rs` and its tests: guarded terminal
  binding result that preserves an actually-live fresh-agent owner.
- Modify `crates/freshell-freshagent/src/identity_sink.rs`: add the narrow
  terminal publication/durability bridge types without changing existing
  fresh-agent binding or pending contracts.
- Modify `crates/freshell-freshagent/src/lib.rs`: expose the injected bridge to
  terminal-tab settlement, share `terminals_revision`, and expose an opaque
  weak Codex-liveness handle where needed.
- Modify `crates/freshell-freshagent/src/terminal_tabs.rs`: strict explicit
  Codex gate, atomic publish hook, awaited durable phase, exit retirement,
  canonical metadata/invalidation broadcasts, and focused route tests.
- Modify `crates/freshell-server/src/identity_sink.rs`: real shared-registry and
  pane-ledger adapter, combined route regression, disabled/live-owner/error
  tests, and disk-reload assertion.
- Modify `crates/freshell-server/src/main.rs`: inject the shared identity,
  shared terminal revision, pane ledger, and weak fresh-Codex liveness seam.
- Modify `test/unit/client/components/App.ws-bootstrap.test.tsx` or add one
  narrowly named App integration test beside it: cached duplicate-to-one-row
  invalidation regression using the real Redux store, thunk, reducer, handler,
  and selector.
- Do not modify `src/store/selectors/sidebarSelectors.ts`.

---

### Task 1: Pin the exact combined-route failure before production changes

**Files:**

- Test only: `crates/freshell-server/src/identity_sink.rs`

**Purpose:** Reproduce the incident through the real REST create route and real
terminal-directory projection before any new API or wiring can accidentally
make the test green.

- [ ] **Step 1: Build one real in-process route harness**

In the existing server identity-sink test module, merge
`freshell_freshagent::router` and `terminals::router` around the same:

- `TerminalRegistry`
- `TerminalIdentityRegistry`
- temporary, enabled `PaneLedger`
- `SettingsStore`
- broadcast bus
- shared terminal revision
- current `LedgerIdentitySink`

Use a temporary recording CLI script that remains alive until cleanup. Do not
use the live server, the user's home, or the preserved evidence directory.

- [ ] **Step 2: Seed the stale owner and POST the exact recovered Codex shape**

Seed:

```rust
ledger.record_binding(&BindingWrite {
    provider: "codex",
    session_id: "thread-restored",
    terminal_id: "term-old",
    mode: "codex",
    cwd: Some(temp_dir),
    create_request_id: Some("old-create"),
    now_ms: 1,
})?;
```

Then POST:

```json
{
  "mode": "codex",
  "cwd": "<temporary directory>",
  "createRequestId": "create-restored",
  "sessionRef": {
    "provider": "codex",
    "sessionId": "thread-restored"
  }
}
```

Capture the returned terminal ID, GET `/api/terminals?priority=visible`, and
reduce the three authoritative observations to:

```rust
(
    directory_session_ref_for(&returned_terminal_id),
    identity.session_ref_for(&returned_terminal_id),
    ledger_live_terminal_id("codex", "thread-restored"),
)
```

The final expectation is `(Some(codex_ref), Some(codex_ref),
returned_terminal_id)`.

- [ ] **Step 3: Run and preserve the genuine RED**

Run:

```bash
cargo test -p freshell-server identity_sink::tests::rest_codex_create_publishes_one_identity_across_directory_memory_and_disk -- --exact --nocapture
```

Before any production change, the assertion must reach runtime and report the
actual tuple exactly as:

```text
(None, None, term-old)
```

If it fails to compile, fails in harness setup, or produces a different tuple,
fix only the test harness and rerun. Save the exact command and assertion
output in the task report. Do not commit a failing test by itself; keep it
uncommitted for the production tasks that make it green.

---

### Task 2: Add atomic terminal publication and the per-create exit gate

**Files:**

- Modify and test: `crates/freshell-terminal/src/registry.rs`

**Interfaces:**

- Existing `TerminalRegistry::create` remains source-compatible and delegates
  to a new atomic-publication variant.
- The new variant accepts a synchronous one-shot publication hook over the
  just-inserted terminal's immutable publication fields.
- The hook cannot await, perform I/O, or re-enter the registry.

- [ ] **Step 1: Write deterministic publication-order tests**

Add tests that control two threads with barriers/channels rather than sleeps:

1. `create_with_publication_hides_inventory_until_publication_completes`
   blocks inside the publication hook, starts an inventory read on another
   thread, and proves the read cannot return the terminal until the hook marks
   identity published and the registry lock is released.
2. `create_with_publication_opens_exit_gate_after_identity_publication`
   launches an immediately exiting fixture, records ordered events from the
   publication and exit hooks, and requires
   `row_inserted -> identity_published -> exit_retired`, never retirement
   first.
3. `create_delegates_to_atomic_publication_without_behavior_change` pins the
   legacy wrapper's ordinary create result, revision, and exit behavior.

- [ ] **Step 2: Run the tests and preserve RED**

Run each filter separately:

```bash
cargo test -p freshell-terminal registry::tests::create_with_publication_hides_inventory_until_publication_completes -- --exact --nocapture
cargo test -p freshell-terminal registry::tests::create_with_publication_opens_exit_gate_after_identity_publication -- --exact --nocapture
cargo test -p freshell-terminal registry::tests::create_delegates_to_atomic_publication_without_behavior_change -- --exact --nocapture
```

Expected: compile failures for the missing API, followed by the intended
ordering failures as the minimal skeleton is introduced.

- [ ] **Step 3: Implement the primitive**

Introduce a narrow value such as:

```rust
pub struct TerminalPublication<'a> {
    pub terminal_id: &'a str,
    pub mode: &'a str,
    pub resume_session_id: Option<&'a str>,
    pub create_request_id: Option<&'a str>,
    pub cwd: Option<&'a str>,
    pub created_at: i64,
}
```

and a method named for its guarantee, for example:

```rust
pub fn create_with_publication<F>(
    &self,
    /* existing create inputs */,
    publish: F,
) -> io::Result<()>
where
    F: FnOnce(TerminalPublication<'_>);
```

Implementation order:

1. Create a per-create `Arc<(Mutex<GateState>, Condvar)>`.
2. Wrap the caller's PTY exit hook so it waits for the gate to become
   `Published` before running retirement/cleanup.
3. Spawn the PTY.
4. Lock `RegistryInner`.
5. Insert the row.
6. Invoke `publish` synchronously while still holding `RegistryInner`.
7. Increment the registry revision.
8. Mark the exit gate `Published` and notify waiters.
9. Drop `RegistryInner`.
10. Release create reservations, log `terminal.created`, and fire
    `ActivityEvent::Created`.

Because all inventory/probe/directory readers take `RegistryInner`, no public
row can escape between steps 5 and 6. Opening the exit gate before releasing
the registry lock ensures an early exit may block briefly but can never retire
before publication.

Keep spawn-failure cleanup and reservation release unchanged. `create` must
delegate with a no-op publisher; do not duplicate the spawn implementation.

- [ ] **Step 4: Reach GREEN and refactor**

Run:

```bash
cargo test -p freshell-terminal registry::tests::create_with_publication_hides_inventory_until_publication_completes -- --exact --nocapture
cargo test -p freshell-terminal registry::tests::create_with_publication_opens_exit_gate_after_identity_publication -- --exact --nocapture
cargo test -p freshell-terminal registry::tests::create_delegates_to_atomic_publication_without_behavior_change -- --exact --nocapture
cargo test -p freshell-terminal --all-targets
cargo fmt --check
cargo clippy -p freshell-terminal --all-targets -- -D warnings
```

Refactor only after GREEN. Re-run the same commands.

- [ ] **Step 5: Commit the primitive**

```bash
git add crates/freshell-terminal/src/registry.rs
git commit -m "fix: publish terminal state atomically"
```

---

### Task 3: Bridge and wire strict REST Codex identity and durability

**Files:**

- Modify and test: `crates/freshell-freshagent/src/identity_sink.rs`
- Modify and test: `crates/freshell-freshagent/src/codex.rs`
- Modify and test: `crates/freshell-freshagent/src/lib.rs`
- Modify and test: `crates/freshell-freshagent/src/terminal_tabs.rs`
- Modify and test: `crates/freshell-ws/src/pane_ledger.rs`
- Modify and test: `crates/freshell-ws/src/pane_ledger_tests.rs`
- Modify and test: `crates/freshell-server/src/identity_sink.rs`
- Modify: `crates/freshell-server/src/main.rs`

**Interfaces:**

Keep existing `record_pending`, `record_binding(FreshAgentBindingUpsert)`, and
`SinkWrite<io::Result<()>>` unchanged. Add a separate terminal-only contract:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalPaneBinding {
    pub provider: String,
    pub session_id: String,
    pub terminal_id: String,
    pub mode: String,
    pub cwd: Option<String>,
    pub create_request_id: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalBindingDegradation {
    LedgerUnavailable,
    LiveFreshAgentOwner,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalBindingDurability {
    Durable,
    Degraded(TerminalBindingDegradation),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalBindingPreflight {
    Publish,
    Degraded(TerminalBindingDegradation),
}

pub type TerminalBindingCheck = Pin<
    Box<dyn Future<Output = io::Result<TerminalBindingPreflight>> + Send + 'static>
>;

pub type TerminalBindingWrite = Pin<
    Box<dyn Future<Output = io::Result<TerminalBindingDurability>> + Send + 'static>
>;
```

Extend `PaneIdentitySink` with distinct phases:

```rust
fn preflight_terminal_binding(&self, binding: &TerminalPaneBinding)
    -> TerminalBindingCheck;
fn publish_terminal_identity(&self, binding: &TerminalPaneBinding);
fn persist_terminal_binding(&self, binding: TerminalPaneBinding) -> TerminalBindingWrite;
fn retire_terminal_identity(&self, terminal_id: &str);
```

`preflight_terminal_binding` is the async exact-liveness check and runs
immediately before spawn. `publish_terminal_identity` and
`retire_terminal_identity` are synchronous, memory-only calls.
`persist_terminal_binding` is the only new terminal filesystem path and is
called only after `TerminalBindingPreflight::Publish`.

Add one pure scope gate used only for the new authoritative REST path:

```rust
fn explicit_rest_codex_binding(
    mode: &str,
    accepted_session_ref: Option<&SessionLocator>,
) -> Option<SessionLocator> {
    let session_ref = accepted_session_ref?;
    (mode == "codex"
        && session_ref.provider == "codex"
        && !session_ref.session_id.is_empty())
        .then(|| session_ref.clone())
}
```

Use the actual validated value without trimming, rewriting, or accepting a raw
fallback. Existing request validation remains the authority that produces
`accepted_session_ref`.

- [ ] **Step 1: Write bridge and adapter RED tests**

Add tests for:

1. The fake sink records preflight, publication, durability request, and
   retirement as separate events.
2. The real adapter synchronously upserts
   `TerminalIdentityRegistry` before returning.
3. An enabled ledger seeded with stale terminal owner `term-old` returns
   `Durable`, names `term-new`, and a newly constructed `PaneLedger` over the
   same root reloads `term-new`.
4. A disabled ledger returns
   `Degraded(LedgerUnavailable)` and is never reported as durable.
5. A target row with `paneKind:"fresh-agent"` plus an actually-live Codex
   liveness probe returns preflight
   `Degraded(LiveFreshAgentOwner)`, never publishes terminal identity, never
   invokes persistence, and remains byte/field-equivalent to the fresh-agent
   row.
6. The same stale fresh-agent row with a non-live/expired weak probe may be
   replaced by the terminal binding.
7. A deterministic filesystem/test-writer error returns `Err`, not a typed
   degradation.
8. Retirement after publication marks the shared identity retired without
   deleting the durable binding.
9. The real REST route synchronously publishes an explicit accepted Codex
   binding before the new terminal becomes visible.
10. Raw Codex resume, non-Codex `sessionRef`, and extension mode never call
    the new terminal publication or durability methods.
11. Disabled ledger, live fresh owner, and actual write error each return HTTP
    200 and exactly one distinct `durability.degraded` frame.

- [ ] **Step 2: Run bridge tests and preserve RED**

Run filters separately:

```bash
cargo test -p freshell-freshagent identity_sink::tests -- --nocapture
cargo test -p freshell-ws pane_ledger_tests::terminal_binding_preserves_live_fresh_agent_owner -- --exact --nocapture
cargo test -p freshell-server identity_sink::tests::terminal_binding_reports_disabled_ledger -- --exact --nocapture
cargo test -p freshell-server identity_sink::tests::terminal_binding_reloads_after_restart -- --exact --nocapture
cargo test -p freshell-server identity_sink::tests::terminal_binding_preserves_live_fresh_codex_owner -- --exact --nocapture
cargo test -p freshell-freshagent terminal_tabs::tests::rest_explicit_codex_session_ref_publishes_before_terminal_visibility -- --exact --nocapture
cargo test -p freshell-freshagent terminal_tabs::tests::rest_raw_codex_resume_does_not_enter_authoritative_binding_path -- --exact --nocapture
cargo test -p freshell-freshagent terminal_tabs::tests::rest_disabled_ledger_returns_200_and_one_ledger_unavailable_frame -- --exact --nocapture
```

Expected: missing types/methods and then the current silent-disabled/overwrite
behavior.

- [ ] **Step 3: Add the weak fresh-Codex liveness seam**

Expose an opaque handle from `FreshCodexState` that weakly references its
session map and can asynchronously answer whether a given Codex thread is
actually tracked live. The server adapter must retain only the weak handle, so
the durability bridge cannot extend the runtime's lifetime.

Immediately before spawn for `codex:<session>`:

1. Inspect whether the existing row is a fresh-agent row.
2. If so, upgrade and query the weak Codex liveness handle.
3. If the owner is actually live, return
   `Degraded(LiveFreshAgentOwner)`; the caller must make both the atomic
   publisher and durable writer no-ops.
4. If the weak handle is expired or reports not live, return `Publish` and
   allow stale-row replacement after spawn.

The liveness await occurs before registry create and before any
`spawn_blocking` disk I/O. Do not hold a Tokio mutex across blocking I/O.

This protects an owner already live at the check. It does not make a terminal
create and a concurrently starting fresh-agent create one atomic admission
transaction; retain that residual risk in the final report.

- [ ] **Step 4: Implement the real adapter**

`LedgerIdentitySink` receives:

- the shared `PaneLedger`
- the shared `TerminalIdentityRegistry`
- the weak fresh-Codex liveness handle

`preflight_terminal_binding` checks only the exact existing fresh-agent owner
and live runtime described above. An expired/not-live owner returns
`Publish`. A live owner returns
`Degraded(LiveFreshAgentOwner)`.
`publish_terminal_identity` calls `TerminalIdentityRegistry::upsert` only.
`retire_terminal_identity` calls `TerminalIdentityRegistry::retire` only.
`persist_terminal_binding`:

1. Returns `Degraded(LedgerUnavailable)` immediately when
   `!ledger.is_enabled()`.
2. Uses `spawn_blocking` to write a terminal `BindingWrite`.
3. Maps a successful enabled write to `Durable`.
4. Propagates `JoinError` and filesystem failures as `io::Error`.

The route must never call `publish_terminal_identity` or
`persist_terminal_binding` after a degraded preflight.

Do not record or delete pending markers in any of these methods.

Wire the shared identity and weak liveness handle in `main.rs`; retain the same
adapter instance for existing fresh-agent sink consumers. Add a loud boot
assertion that the REST terminal identity bridge was injected.

- [ ] **Step 5: Wire the strict REST publication and durability phases**

In `settle_gated_create`:

1. Compute `explicit_rest_codex_binding` once from `mode` and
   `accepted_session_ref`.
2. Build one `TerminalPaneBinding` from that exact locator, terminal ID, cwd,
   mode, create request ID, and event timestamp.
3. Immediately before spawn, await `preflight_terminal_binding`. An
   ineligible request behaves as today. `Publish` authorizes the next two
   phases. `Degraded(LiveFreshAgentOwner)` records the one degradation outcome
   and authorizes neither phase.
4. Pass a synchronous publisher to
   `TerminalRegistry::create_with_publication`. The publisher calls
   `publish_terminal_identity` only for a `Publish` binding. For every
   ineligible or preflight-degraded shape it is a no-op.
5. Capture the bridge in the existing exit hook only for a published binding;
   after `finish_pty_exit`, call `retire_terminal_identity`.
6. Complete existing adoption, meta, locator, D8 winner, pane, and tab
   settlement unchanged.
7. Await `persist_terminal_binding` outside all registry locks and only after
   the create has won settlement, and only for a published binding.

Never call `record_pending` or reuse the pane-payload promotion result.

Map the durability result once:

- `Durable`: no warning frame.
- `Degraded(LedgerUnavailable)`: structured warning plus exactly one
  `durability.degraded{reason:"pane_ledger_unavailable"}`.
- preflight `Degraded(LiveFreshAgentOwner)`: structured invariant warning plus
  exactly one
  `durability.degraded{reason:"live_fresh_agent_owner"}`.
- `Err`: structured error plus exactly one
  `durability.degraded{reason:"ledger_write_failed"}`.

All four branches continue with the successfully spawned terminal and HTTP
200. The route is the sole user-visible failure surface; the adapter must not
broadcast a second warning.

- [ ] **Step 6: Turn the Task 1 regression GREEN and verify the bridge**

Run:

```bash
cargo test -p freshell-freshagent identity_sink::tests -- --nocapture
cargo test -p freshell-freshagent codex::tests::weak_liveness_handle_tracks_runtime_without_owning_it -- --exact --nocapture
cargo test -p freshell-freshagent terminal_tabs::tests::rest_explicit_codex_session_ref_publishes_before_terminal_visibility -- --exact --nocapture
cargo test -p freshell-freshagent terminal_tabs::tests::rest_explicit_codex_early_exit_retires_after_publication -- --exact --nocapture
cargo test -p freshell-freshagent terminal_tabs::tests::rest_raw_codex_resume_does_not_enter_authoritative_binding_path -- --exact --nocapture
cargo test -p freshell-freshagent terminal_tabs::tests::rest_disabled_ledger_returns_200_and_one_ledger_unavailable_frame -- --exact --nocapture
cargo test -p freshell-freshagent terminal_tabs::tests::rest_live_fresh_owner_returns_200_and_one_live_owner_frame -- --exact --nocapture
cargo test -p freshell-freshagent terminal_tabs::tests::rest_ledger_error_returns_200_and_one_write_failed_frame -- --exact --nocapture
cargo test -p freshell-ws pane_ledger_tests::terminal_binding_preserves_live_fresh_agent_owner -- --exact --nocapture
cargo test -p freshell-ws pane_ledger_tests::terminal_binding_replaces_stale_fresh_agent_owner -- --exact --nocapture
cargo test -p freshell-server identity_sink::tests -- --nocapture
cargo test -p freshell-server identity_sink::tests::rest_codex_create_publishes_one_identity_across_directory_memory_and_disk -- --exact --nocapture
cargo fmt --check
cargo clippy -p freshell-freshagent -p freshell-ws -p freshell-server --all-targets -- -D warnings
```

Require the Task 1 tuple to be fully green:

- `/api/terminals` returns the new terminal with
  `sessionRef:{provider:"codex",sessionId:"thread-restored"}`.
- `TerminalIdentityRegistry::session_ref_for(new_id)` returns the same locator.
- The live ledger object names `new_id`, not `term-old`.
- A newly constructed `PaneLedger` over the same temporary root reloads
  `new_id`.
- The HTTP response is 200.

Refactor only after GREEN, then rerun all commands in this step.

- [ ] **Step 7: Commit the strict bridge and REST core**

```bash
git add crates/freshell-freshagent/src/identity_sink.rs \
  crates/freshell-freshagent/src/codex.rs \
  crates/freshell-freshagent/src/lib.rs \
  crates/freshell-freshagent/src/terminal_tabs.rs \
  crates/freshell-ws/src/pane_ledger.rs \
  crates/freshell-ws/src/pane_ledger_tests.rs \
  crates/freshell-server/src/identity_sink.rs \
  crates/freshell-server/src/main.rs
git commit -m "fix: publish REST Codex terminal identity"
```

---

### Task 4: Broadcast REST convergence and migrate WebSocket publication

**Files:**

- Modify and test: `crates/freshell-freshagent/src/lib.rs`
- Modify and test: `crates/freshell-freshagent/src/terminal_tabs.rs`
- Modify and test: `crates/freshell-ws/src/terminal.rs`
- Modify and test: `crates/freshell-server/src/identity_sink.rs`
- Modify: `crates/freshell-server/src/main.rs`

- [ ] **Step 1: Write event-order and WebSocket atomic-publication RED tests**

Using the fake bridge and recording CLI, add:

1. `rest_explicit_codex_create_broadcasts_ui_then_changed_then_meta_before_response`
   pins normal-delivery parity with WebSocket create.
2. `rest_explicit_codex_deferred_create_broadcasts_changed_then_meta_before_response_without_broadcasting_ui_command`
   pins deferred restore delivery.
3. `rest_degraded_binding_still_broadcasts_one_invalidation_sequence`
   proves degradation does not skip or duplicate convergence frames.
4. `rest_ineligible_create_broadcasts_changed_without_canonical_meta` proves
   raw resume and non-Codex creates gain only terminal-directory invalidation,
   not new identity semantics.
5. A WebSocket create-publication regression proves inventory/probe cannot
   observe an identity-bearing created row without the matching identity.
6. A WebSocket instant-exit regression proves retirement follows publication.
7. Existing WS durable binding and pending-marker tests continue to pin their
   current behavior.

- [ ] **Step 2: Run focused RED commands separately**

```bash
cargo test -p freshell-freshagent terminal_tabs::tests::rest_explicit_codex_create_broadcasts_ui_then_changed_then_meta_before_response -- --exact --nocapture
cargo test -p freshell-freshagent terminal_tabs::tests::rest_explicit_codex_deferred_create_broadcasts_changed_then_meta_before_response_without_broadcasting_ui_command -- --exact --nocapture
cargo test -p freshell-ws terminal::tests::create_publication_is_atomic_with_identity -- --exact --nocapture
cargo test -p freshell-ws terminal::tests::instant_exit_retires_after_create_publication -- --exact --nocapture
```

Expected: REST event-order failures and missing WS use of the new publication
API. If the WS module path differs, discover it with
`cargo test -p freshell-ws -- --list`; continue using one valid filter per
command.

- [ ] **Step 3: Broadcast canonical metadata and invalidation before delivery**

Inject the same `Arc<AtomicI64>` used by `WsState` and `TerminalsState` into
`FreshAgentState` via `with_shared_terminals_revision` or its existing
post-construction setter pattern.

For every successful REST terminal create, regardless of mode, durability
outcome, and `broadcast`/deferred UI delivery:

1. For ordinary delivery, broadcast `ui.command{tab.create}`.
2. Increment the shared terminal revision and broadcast
   `terminals.changed{revision}`.
3. Only when terminal identity was atomically published, build
   `TerminalMetaRecord` from the exact `TerminalPaneBinding` and broadcast
   `terminal.meta.updated{upsert:[record],remove:[]}`.
4. For deferred delivery, put `uiCommand` in the response and do not broadcast
   it.
5. Return the HTTP response.

This mirrors WebSocket create ordering for ordinary delivery and lets the
invalidation frames coalesce into one browser refresh. `terminals.changed` is
the intentional cross-mode parity fix; canonical metadata remains strictly
limited to the successfully published explicit Codex binding. A live-owner
preflight degradation therefore emits `terminals.changed` but no terminal
metadata claim.

- [ ] **Step 4: Move WebSocket's existing in-memory upsert into atomic publication**

The WebSocket path already decides which create has a `create_meta_record`.
Keep that decision and all durable/pending rules unchanged, but:

1. Build the existing meta record before calling the registry.
2. Pass its identity upsert as the synchronous
   `create_with_publication` hook.
3. Remove the post-create duplicate `state.identity.upsert`.
4. Keep the existing pane-ledger binding/pending `spawn_blocking` work after
   create returns and outside the registry lock.
5. Keep the existing `terminal.created`, `terminal.meta.updated`, and
   `terminals.changed` wire semantics.

Add a WS regression proving an inventory/probe cannot observe an
identity-bearing created row without the matching identity and that an
instant exit retires only after publication.

- [ ] **Step 5: Extend the combined regression through the delivery boundary**

Rerun:

```bash
cargo test -p freshell-server identity_sink::tests::rest_codex_create_publishes_one_identity_across_directory_memory_and_disk -- --exact --nocapture
```

Require all of:

- `/api/terminals` returns the new terminal with
  `sessionRef:{provider:"codex",sessionId:"thread-restored"}`.
- `TerminalIdentityRegistry::session_ref_for(new_id)` returns the same locator.
- The live ledger object names `new_id`, not `term-old`.
- A newly constructed `PaneLedger` over the same temporary root reloads
  `new_id`.
- The HTTP response is 200.
- The broadcast sequence contains canonical metadata and a shared positive
  terminal revision before the UI create delivery.

- [ ] **Step 6: Run focused GREEN and crate tests**

Run each filter group independently:

```bash
cargo test -p freshell-freshagent identity_sink::tests -- --nocapture
cargo test -p freshell-freshagent terminal_tabs::tests -- --nocapture
cargo test -p freshell-ws terminal::tests::create_publication -- --nocapture
cargo test -p freshell-server identity_sink::tests -- --nocapture
cargo test -p freshell-freshagent --all-targets
cargo test -p freshell-ws --all-targets
cargo test -p freshell-server --all-targets
cargo fmt --check
cargo clippy -p freshell-terminal -p freshell-freshagent -p freshell-ws -p freshell-server --all-targets -- -D warnings
```

If the WS test module uses a different exact path, discover it with
`cargo test -p freshell-ws -- --list` and run one valid filter at a time. Do not
pass two Cargo test filters in one command.

- [ ] **Step 7: Commit convergence and WebSocket migration**

```bash
git add crates/freshell-freshagent/src/lib.rs \
  crates/freshell-freshagent/src/terminal_tabs.rs \
  crates/freshell-ws/src/terminal.rs \
  crates/freshell-server/src/identity_sink.rs \
  crates/freshell-server/src/main.rs
git commit -m "fix: broadcast terminal identity convergence"
```

---

### Task 5: Prove a cached browser row converges without selector changes

**Files:**

- Test only: `test/unit/client/components/App.ws-bootstrap.test.tsx`, or a new
  narrowly scoped App integration test beside it
- Do not modify `src/store/selectors/sidebarSelectors.ts`

**Purpose:** Protect the exact user-visible failure after the server is fixed:
the browser may already have cached the new terminal as unidentified before it
receives the create's invalidations.

- [ ] **Step 1: Write the real Redux/App integration regression**

Use the existing App WebSocket/API harness with the real:

- configured Redux store
- `createTerminalInvalidationHandler`
- `fetchTerminalDirectoryWindow`
- terminal-directory reducer
- `makeSelectSortedSessionItems`
- sidebar/App rendering path

Seed:

1. An open pane/tab named `gf ui` with
   `sessionRef = codex:thread-restored` and `terminalId = term-new`.
2. A cached sidebar terminal-directory window at revision `1700` whose same
   running `term-new` row has no `sessionRef`.
3. Session data that makes the selector initially expose both the real
   `codex:thread-restored` row and the synthetic
   `codex:terminal:term-new` fallback.

Then deliver back-to-back:

```json
{
  "type": "terminals.changed",
  "revision": 12
}
```

and:

```json
{
  "type": "terminal.meta.updated",
  "upsert": [{
    "terminalId": "term-new",
    "provider": "codex",
    "sessionId": "thread-restored",
    "updatedAt": 1700
  }],
  "remove": []
}
```

Mock the single ensuing
`GET /api/terminals?priority=visible&revision=1700` to return current
`term-new` with the canonical `sessionRef` but the same derived directory
revision `1700`.

- [ ] **Step 2: Preserve RED if the integration test exposes a real delivery gap**

Run:

```bash
npm run test:vitest -- run test/unit/client/components/App.ws-bootstrap.test.tsx
```

The expected current primitives already support convergence. If the test is
RED, determine whether the App harness omitted the real invalidation path
before changing production code. Production selector changes are forbidden.
Only a proven App/invalidation delivery defect may be fixed, and such a defect
must be reported to the controller before expanding the task.

- [ ] **Step 3: Assert coalescing and convergence**

After advancing the real debounce boundary:

- exactly one terminal-directory request was issued for the two invalidations
- the request carried cached revision `1700`
- a same-revision response was accepted
- the Redux directory window replaced the unidentified cached row
- `makeSelectSortedSessionItems` contains exactly one session key for the
  terminal, `codex:thread-restored`
- the rendered sidebar contains one `gf ui`, not two
- no selector fallback logic was modified

- [ ] **Step 4: Run client-focused verification**

```bash
npm run test:vitest -- run test/unit/client/components/App.ws-bootstrap.test.tsx
npm run test:vitest -- run test/unit/client/lib/terminal-invalidation-handler.test.ts
npm run test:vitest -- run test/unit/client/store/selectors/sidebarSelectors.test.ts
```

- [ ] **Step 5: Commit the regression**

```bash
git add test/unit/client/components/App.ws-bootstrap.test.tsx
git commit -m "test: cover REST Codex sidebar convergence"
```

If a new test file was chosen, add that exact file instead.

---

### Task 6: Whole-branch verification and handoff

**Files:**

- Verify only. Change implementation files solely for failures caused by this
  branch, using a focused fix commit with its covering test.

- [ ] **Step 1: Run focused regressions with valid single filters**

```bash
cargo test -p freshell-terminal registry::tests::create_with_publication -- --nocapture
cargo test -p freshell-freshagent identity_sink::tests -- --nocapture
cargo test -p freshell-freshagent terminal_tabs::tests -- --nocapture
cargo test -p freshell-server identity_sink::tests -- --nocapture
npm run test:vitest -- run test/unit/client/components/App.ws-bootstrap.test.tsx
npm run test:vitest -- run test/unit/client/lib/terminal-invalidation-handler.test.ts
npm run test:vitest -- run test/unit/client/store/selectors/sidebarSelectors.test.ts
```

Do not combine `identity_sink::tests` and `terminal_tabs::tests` as two Cargo
filters; Cargo accepts one test-name filter.

- [ ] **Step 2: Run Rust workspace quality gates**

```bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --all-targets
```

- [ ] **Step 3: Run repository checks through the shared coordinator**

```bash
npm run test:status
FRESHELL_TEST_SUMMARY='verify REST Codex terminal identity publication branch' npm run check
npm run lint
```

Wait for the coordinator if another holder owns it. Do not kill or bypass a
foreign holder.

- [ ] **Step 4: Audit scope and residual risk**

```bash
git status --short
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git log --oneline --decorate origin/main..HEAD
```

Require:

- no uncommitted changes
- no selector modification
- no pending/provider/extension behavior changes
- no live-server or production artifacts
- focused commits only

Record the deliberate residual risk: an already-live fresh Codex owner is
protected, but a terminal create and fresh-agent create that begin
concurrently across their separate admission domains are not made one atomic
transaction by this incident fix.

- [ ] **Step 5: Run the usual final reviews**

1. Request a broad code review over `origin/main...HEAD` and resolve all
   actionable findings.
2. Run Fresh Eyes on the complete delta up to five times, fixing and committing
   findings between rounds.
3. Stop only on a serious data-loss/confusion risk. If round five does not
   pass, report that loudly and do not imply readiness.
4. After the final fix, rerun the covering focused tests and every affected
   broad gate.

- [ ] **Step 6: Preserve the branch and worktree**

Do not open a PR, merge, deploy, restart port 3002, or remove the worktree.
Report:

- branch and worktree
- base and head SHAs
- focused commits
- Task 1 RED tuple
- load-bearing corrections
- plan Fresh Eyes rounds
- task review results
- final-delta Fresh Eyes rounds
- exact verification commands and outcomes
- the concurrent cross-kind residual risk
- readiness for explicit PR approval

## Acceptance Summary

1. Before production edits, the combined route test proves the incident as
   `(None, None, term-old)`.
2. A validated explicit REST Codex `sessionRef` is published atomically with
   its terminal registry row.
3. An immediate child exit cannot retire before publication.
4. `/api/terminals`, the shared identity registry, and a disk-reloaded
   pane ledger all name the returned terminal and Codex session after a
   durable result.
5. Disabled ledger, live fresh-agent owner, and real write error each preserve
   HTTP 200 and emit exactly one distinct degradation frame.
6. A live fresh Codex ledger owner is not overwritten.
7. Raw resume IDs and all non-Codex/provider/extension paths retain their
   existing authoritative behavior.
8. Every successful REST terminal create publishes a shared-revision
   invalidation; published explicit Codex identity also emits canonical
   metadata. Both ordinary and deferred flows emit their required
   invalidations before the HTTP response.
9. The WebSocket path uses the same atomic in-memory publication primitive
   while retaining its existing durable/pending rules.
10. The real App/Redux flow replaces a cached unidentified same-revision row,
    coalesces the two invalidations into one fetch, and renders one `gf ui`
    without a selector patch.
11. All changes are committed locally, fully verified, reviewed, and left
    undeployed with no PR.
