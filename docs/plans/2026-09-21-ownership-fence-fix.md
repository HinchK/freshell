# Ownership Fence Fix Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Freshell sessions claimed by terminal-lane panes (plain CLI TUI panes, e.g. codex or claude mode) must never wedge behind a stale ownership fence. Specifically: (a) the server broadcasts `session.runtimeOwner` whenever the terminal lane commits ownership to Live — at the create settle point and the attach claim point — carrying the commit's own (epoch, generation) pair; (b) when the client receives a typed stale-fence refusal (a create/attach/kill claim refused because its observed generation is stale), it folds the refusal's current (ownerEpoch, ownerGeneration) pair into its runtimeOwners fence so the next attempt uses the fresh pair instead of looping on the same stale pair; (c) a pane the client just created never attaches with its own pre-create fence — the create response's committed owner pair (added to `terminal.created` if missing) folds into the fence before the queued attach fires.

### Explicit constraints
- Work via the the-usual workflow (isolated worktree, committed plan, load-bearing validation, independent Fresh Eyes reviews, red/green/refactor TDD).
- Full unit-test and e2e coverage of the new behavior; never skip the refactor step.
- Feature branch in `.worktrees/` created from `origin/main`; never commit behavior changes to `main`; no PR creation without explicit user approval (preparing, committing, and pushing the branch is fine; stop before `gh pr create`).
- Broadcast frames carry the transition's own committed (epoch, generation) pair, never a re-observed current generation (the established r32 F2 discipline).
- TypeScript uses NodeNext/ESM: relative imports must include `.js` extensions.
- Never restart the self-hosted production server; process safety: no broad kill patterns; destructive test suites only inside the Docker sandbox via `scripts/sandbox-test.sh`.
- Broad repo-supported test runs go through the shared coordinator gate (`npm test`, `npm run check`, and zero-argument `test:unit`/`test:integration`/`test:server` are coordinated); use `npm run test:vitest -- ...` for direct focused Vitest work.
- The pre-push gate and required rust-gate CI apply on push (cargo fmt, typecheck, clippy, targeted cargo test for changed crates and dependents).

### Accepted tradeoffs and residuals
- Out of scope (explicit follow-ups, not this run): the fresh-agent handoff spawn failure root cause ("codex resume failed" after the ~8s readiness gate), and throttling the freshAgent.session.changed broadcast flood.
- Deploying the fix to the live self-hosted server requires separate explicit user approval; this run only builds and tests on the branch.
- The required self-heal is the fence fold on typed refusals (the fresh pair is then used by the next attempt); no new bounded-retry subsystem is required.

**Goal:** A session claimed by any terminal-lane pane (codex/claude/etc. CLI TUI) stays attachable, closable, and reopenable by every connected client without a page reload: every terminal-lane commit-to-Live broadcasts its committed owner pair, the create response carries that pair so the creating pane's first attach is born fresh, and any typed stale-fence refusal teaches the client the current pair.

**Architecture:** Four server layers change. (1) Protocol: `TerminalCreated` and `TerminalKilled` gain additive skip-None owner fields (frozen-client parity — omitted fields keep legacy frames byte-identical). (2) freshell-ws: the two `handle_create` commit sites (create settle ~terminal.rs:5632, attach claim ~:3905), the auto-resume respawn settle (auto_resume.rs:1175), and the REST rung (freshell-freshagent/terminal_tabs.rs:884) each broadcast `session.runtimeOwner` (ownerKind `terminal`, transition `handoff-committed`, the claim ticket's own committed pair — r32 F2) right after a successful commit; the create paths also thread that pair into the `terminal.created` frame. (3) freshell-ws refusal arms: the create stale arms and the kill stale-refusal arms populate `ownerEpoch`/`ownerGeneration` (the attach arms already do). (4) Client: the `terminal.created` handler folds the committed pair into `runtimeOwners` before the queued attach fires (fix c); a new merge-only reducer action `applyRuntimeOwnerFenceRefresh` folds refusal pairs into the existing record (preserving ownerKind/transition — fix b), wired into the TerminalView create-scoped error branch, a new attach-scoped branch, the kill-ack failure result, and the fresh-agent-ws `createFailed` fold. The existing broadcast fold (`applyRuntimeOwner`) already consumes the new server frames unchanged.

**Tech Stack:** Rust workspace (freshell-protocol, freshell-ownership, freshell-ws, freshell-freshagent; tokio broadcast bus; serde camelCase), React 18 + Redux Toolkit client (freshAgentSlice, selectors/runtimeOwner.ts), shared/ws-protocol.ts TS wire types, Vitest + Testing Library, Playwright e2e, cargo test.

## Global Constraints

- TDD red/green/refactor per task; the focused commands below are the verification vehicles. Never skip the refactor step. The worktree has no `target/` — the first cargo build is cold; that is expected, not a failure.
- Frozen-client parity for every wire addition: `Option` + `#[serde(skip_serializing_if = "Option::is_none")]`; `None` values must keep the frame byte-identical to the pre-change shape. Mirror the discipline comments at terminal.rs:6696-6710 and 2781-2790.
- r32 F2 discipline for every new broadcast: the frame carries THE COMMIT'S OWN (epoch, generation) — captured from the claim ticket before the consuming `commit()` call — never `ownership.observe(...)`. The only broadcast helper used is `broadcast_owner_frame` (identity_ownership.rs:799-826), never the `_if_authoritative` variant (that one re-observes, r39 shape).
- Transition value for all new terminal-lane commit broadcasts: `"handoff-committed"` (the r29 F1 precedent already uses it for ordinary fresh-agent creates; the client TS whitelist at shared/ws-protocol.ts:1690 needs no change).
- Refusal folds are merge-only: the client updates only (epoch, generation, updatedAt) of an EXISTING runtimeOwners record, preserving ownerKind/transition/terminalId/aliasOf; when no record exists the fold is a no-op (a refusal corrects a fence the client believed it had; records repopulate via broadcasts/created-fold/ready replay). Same monotonic gate as `applyRuntimeOwner` (same-epoch older generation drops; different epoch wins).
- The r35 automatic re-drive contract stays intact (test at TerminalView.lifecycle.test.tsx:3602): automatic re-drives of the same request keep the captured per-request pair; the refusal fold updates the store observed by the NEXT decision (user Retry/reconcileEpoch bump re-captures fresh, a new attach re-selects at send time).
- TypeScript imports: the touched client files use explicit `.js` extensions on relative imports (see src/lib/fresh-agent-ws.ts:5-37); new imports follow file-local convention.
- Test coordination: the focused commands below (narrowed cargo selectors, `npm run test:vitest -- run <file>`) are delegated — NOT coordinator-gated. The full-suite gate at the end of execution runs `npm test` from this worktree (coordinated; set `FRESHELL_TEST_SUMMARY`; foreign holders are waited on, never killed). E2E runs local (FRESHELL_E2E_BACKEND unset in non-interactive shells → local default).
- Process safety: never restart the self-hosted production server on port 3001; this worktree's builds/tests are safe (the production-server prebuild guard exempts linked worktrees, scripts/prebuild-guard.ts:144-147); no broad kill patterns ever.
- No docs/index.html update (not a user-facing UI change).
- Reference reports (context, not authority): `.worktrees/.the-usual-logs/ownership-fence-fix/reports/plan-server-broadcast-sites.md`, `plan-client-fence-machinery.md`, `plan-regression-vehicle.md`, `workspace-baseline.md`.

---

### Task 1: Server — `terminal.created` carries the committed owner pair, and the create settle point broadcasts it

**Files:**
- Modify: `crates/freshell-protocol/src/server_messages.rs` (`TerminalCreated` struct ~:1219)
- Modify: `crates/freshell-ws/src/terminal.rs` (create settle ~:5618-5700)
- Test: `crates/freshell-protocol/src/server_messages.rs` (round-trip tests near the TerminalCreated/ready serialization tests ~:1716-1960)
- Test: `crates/freshell-ws/tests/cross_kind_liveness.rs` (new test next to `a_stale_generation_attach_is_refused_typed` ~:6605)

**Interfaces:**
- Consumes: `broadcast_owner_frame(state, provider, session_id, terminal_id, operation_id, generation, transition)` (identity_ownership.rs:799-826); `OperationTicket::operation_id()/generation()` (freshell-ownership/src/lib.rs:1028/1041, callable before `commit()` consumes the claim).
- Produces: `TerminalCreated { owner_kind: Option<String>, owner_epoch: Option<u64>, owner_generation: Option<u64> }` (camelCase `ownerKind`/`ownerEpoch`/`ownerGeneration`, skip-None) — populated only when a claim committed under a wired coordinator; Tasks 2, 5 consume it.

- [ ] **Step 1: Write the failing behavioral test**

Protocol round-trip (extend the existing serialization tests; find the TerminalCreated round-trip test or add one beside the `session_runtime_owner` round-trips at server_messages.rs:1716-1800):

```rust
#[test]
fn terminal_created_round_trips_the_additive_owner_pair_and_omits_it_when_none() {
    let with_owner = ServerMessage::TerminalCreated(TerminalCreated {
        // ...existing required fields verbatim from the struct...
        owner_kind: Some("terminal".into()),
        owner_epoch: Some(7),
        owner_generation: Some(3),
    });
    let json = serde_json::to_string(&with_owner).unwrap();
    assert!(json.contains(r#""ownerKind":"terminal""#), "{json}");
    assert!(json.contains(r#""ownerEpoch":7"#), "{json}");
    assert!(json.contains(r#""ownerGeneration":3"#), "{json}");
    let back: ServerMessage = serde_json::from_str(&json).unwrap();
    assert_eq!(back, with_owner);

    let legacy = ServerMessage::TerminalCreated(TerminalCreated {
        // ...same required fields...
        owner_kind: None,
        owner_epoch: None,
        owner_generation: None,
    });
    let legacy_json = serde_json::to_string(&legacy).unwrap();
    assert!(!legacy_json.contains("ownerKind"), "{legacy_json}");
    assert!(!legacy_json.contains("ownerEpoch"), "{legacy_json}");
    assert!(!legacy_json.contains("ownerGeneration"), "{legacy_json}");
}
```

Integration (cross_kind_liveness.rs — new test; mirror the create portion of `a_stale_generation_attach_is_refused_typed` :6605-6696: handshake, `terminal.create` carrying a `sessionRef`, await settle):

```rust
#[tokio::test]
async fn a_terminal_lane_create_settle_broadcasts_the_committed_owner_pair_and_rides_the_created_frame() {
    let h = spawn_server().await; // same harness as a_stale_generation_attach_is_refused_typed
    let mut ws = connect(&h.base_url).await;
    // ...handshake + terminal.create with sessionRef exactly as at :6620-6646...
    let created = /* the terminal.created frame captured per the file's await_frame helpers */;
    let ownership = h.ws_state.ownership.as_ref().expect("ownership wired");
    let current = ownership.observe(&PROVIDER, &SESSION_ID);
    // (fix c) the created frame carries the commit's own pair
    assert_eq!(created["ownerKind"], "terminal");
    assert_eq!(created["ownerEpoch"], json!(current.epoch));
    assert_eq!(created["ownerGeneration"], json!(current.generation));
    // (fix a) the broadcast fanned out to this same socket with the committed pair
    let frame = await_owner_transition(&h, &SESSION_ID, "handoff-committed").await;
    assert_eq!(frame["ownerKind"], "terminal");
    assert_eq!(frame["terminalId"], created["terminalId"]);
    assert_eq!(frame["epoch"], json!(current.epoch));
    assert_eq!(frame["generation"], json!(current.generation));
    assert!(!frame["operationId"].as_str().unwrap_or("").is_empty());
}
```

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-protocol terminal_created_round_trips`
Run: `cargo test -p freshell-ws --test cross_kind_liveness a_terminal_lane_create_settle_broadcasts`

Expected: FAIL because `TerminalCreated` has no owner fields (compile error in the protocol test) and the settle point emits no broadcast / no created-frame pair (integration asserts fail).

- [ ] **Step 3: Add the minimal production implementation**

(a) `TerminalCreated` (server_messages.rs ~:1219) — add after `session_ref`:

```rust
    /// b8ke fence-heal: the committed owner pair when THIS create's claim
    /// committed Live{Terminal} under a wired coordinator (additive,
    /// skip-None frozen-client parity — omitted fields keep the frame
    /// byte-identical to the pre-feature shape). Lets the creating client
    /// fold the fresh fence before its queued attach fires.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_epoch: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_generation: Option<u64>,
```

Add `owner_kind: None, owner_epoch: None, owner_generation: None` to every other `TerminalCreated` literal (the compiler enumerates them).

(b) terminal.rs create settle (~5618) — capture the pair before the consuming commit, broadcast after the success log, thread the pair to the created literal (~5669):

```rust
    let mut committed_owner: Option<(String, u64)> = None;
    if let Some(ownership_claim) = terminal_ownership.take() {
        let locator = ownership_claim.locator.clone();
        // b8ke fence-heal: the claim's OWN pair, captured before the
        // consuming commit (r32 F2 — never a re-observation).
        let owner_operation_id = ownership_claim.ticket.operation_id().to_string();
        let owner_generation = ownership_claim.ticket.generation();
        match ownership_claim.commit(&terminal_id) {
            Ok(()) => {
                tracing::info!(
                    terminal_id = %terminal_id,
                    provider = %locator.provider,
                    session_id = %locator.session_id,
                    "session_ref.ownership_committed (terminal lane)"
                );
                // b8ke fence-heal: EVERY commit-to-Live broadcasts the
                // authoritative owner record — the r29 F1 invariant,
                // extended to the terminal lane. Pre-fix this settle
                // committed Live with NO broadcast, so every connected
                // client kept its pre-create observed fence until a page
                // reload and the pane's queued attach / later kills and
                // recreates were refused typed ("moved to a newer
                // runtime; refresh and retry").
                crate::identity_ownership::broadcast_owner_frame(
                    state,
                    &locator.provider,
                    &locator.session_id,
                    &terminal_id,
                    &owner_operation_id,
                    owner_generation,
                    "handoff-committed",
                );
                committed_owner = Some((owner_operation_id, owner_generation));
            }
            Err(outcome) => { /* existing stale arm unchanged */ }
        }
    }
```

(c) Thread into the `TerminalCreated` literal (~5669):

```rust
    // b8ke fence-heal: the created frame carries the commit's own pair so
    // the creating pane's first attach is born fresh (fix c); None when no
    // claim committed or the coordinator is unwired (frozen-client parity).
    let owner_trio: Option<(&str, u64, u64)> = match (&committed_owner, state.ownership.as_ref()) {
        (Some((_, gen)), Some(ownership)) => Some(("terminal", ownership.boot_epoch(), *gen)),
        _ => None,
    };
    // ...in the literal:
        owner_kind: owner_trio.map(|(kind, _, _)| kind.to_string()),
        owner_epoch: owner_trio.map(|(_, epoch, _)| epoch),
        owner_generation: owner_trio.map(|(_, _, gen)| gen),
```

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-protocol terminal_created_round_trips && cargo test -p freshell-ws --test cross_kind_liveness a_terminal_lane_create_settle_broadcasts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Extract nothing new — `broadcast_owner_frame` is the shared helper. Keep the settle-point comment block tight (one b8ke fence-heal comment, not three). Rerun both focused tests.

- [ ] **Step 6: Run impacted-test verification**

Impacted: protocol serialization tests for TerminalCreated/ready frames (`cargo test -p freshell-protocol` — full crate, small), the freshell-ws create-path tests asserting `terminal.created` frames (`cargo test -p freshell-ws --test session_identity_frames`, `cargo test -p freshell-ws --test cross_kind_liveness`), and `cargo test -p freshell-ws --lib` (terminal.rs in-crate tests). Client behavior is unchanged in this task (wire is additive; the client TS type lands in Task 5).

Run: `cargo test -p freshell-protocol && cargo test -p freshell-ws --test session_identity_frames && cargo test -p freshell-ws --test cross_kind_liveness && cargo test -p freshell-ws --lib`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-protocol/src/server_messages.rs crates/freshell-ws/src/terminal.rs crates/freshell-ws/tests/cross_kind_liveness.rs
git commit -m "feat(ws): terminal-lane create settle broadcasts its committed owner pair and rides it on terminal.created"
```

---

### Task 2: Server — the attach claim point (BoundElsewhere create) gets the same broadcast + created-frame pair

**Files:**
- Modify: `crates/freshell-ws/src/terminal.rs` (attach-claim commit ~:3866-3940)
- Test: `crates/freshell-ws/tests/cross_kind_liveness.rs` (extend `bound_elsewhere_attach_commits_ownership_for_the_unclaimed_holder` ~:2875)

**Interfaces:**
- Consumes: Task 1's `TerminalCreated` owner fields; `broadcast_owner_frame`; the pre-commit ticket capture pattern from Task 1.
- Produces: the attach-claim create (`BoundElsewhere` arm) also emits the broadcast and carries the pair on its created frame — the same observable contract as Task 1.

- [ ] **Step 1: Write the failing behavioral test**

Extend `bound_elsewhere_attach_commits_ownership_for_the_unclaimed_holder` (~:2875) — after its existing settle-commit assertion, add:

```rust
    // b8ke fence-heal: the attach-claim commit also broadcasts its own
    // committed pair and rides it on the created frame.
    let frame = await_owner_transition(&h, &SESSION_ID, "handoff-committed").await;
    assert_eq!(frame["ownerKind"], "terminal");
    assert_eq!(frame["terminalId"], json!(attached_terminal_id));
    assert_eq!(frame["epoch"], json!(current.epoch));
    assert_eq!(frame["generation"], json!(current.generation));
    assert_eq!(created["ownerKind"], "terminal");
    assert_eq!(created["ownerEpoch"], json!(current.epoch));
    assert_eq!(created["ownerGeneration"], json!(current.generation));
```

(adapt `created`/`current`/`attached_terminal_id` to the test's existing bindings; `current` from `h.ws_state.ownership` observe, as in Task 1).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-ws --test cross_kind_liveness bound_elsewhere_attach`

Expected: FAIL — no broadcast, created frame has no owner fields.

- [ ] **Step 3: Add the minimal production implementation**

At the BoundElsewhere arm (~3866): the `TerminalCreated` literal is built BEFORE the commit (~3866-3880), so capture the pair from the claim BEFORE `.commit()` (~3905), then broadcast in the Ok arm (~3911):

```rust
    // before the literal + commit: capture the claim's own pair (r32 F2)
    let owner_operation_id = ownership_claim.ticket.operation_id().to_string();
    let owner_generation = ownership_claim.ticket.generation();
    // ...TerminalCreated literal gains (when state.ownership is wired, as in Task 1):
        owner_kind: Some("terminal".into()), /* + epoch/generation via the same owner_trio pattern */
    // ...commit:
    match ownership_claim.commit(&terminal_id) {
        Ok(()) => {
            tracing::info!( /* existing log unchanged */ );
            crate::identity_ownership::broadcast_owner_frame(
                state, &locator.provider, &locator.session_id,
                &terminal_id, &owner_operation_id, owner_generation,
                "handoff-committed",
            );
        }
        /* existing arms unchanged */
    }
```

Follow Task 1's `owner_trio` pattern for populating the literal only when the coordinator is wired. Note: the literal here is constructed before the commit but SENT after (out.send at ~3939), so the captured pre-commit pair is the committed pair.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-ws --test cross_kind_liveness bound_elsewhere_attach`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Unify the capture+broadcast with Task 1's shape if a 3-line local closure removes duplication without hiding the r32 F2 comments; otherwise leave the two sites explicit. Rerun.

- [ ] **Step 6: Run impacted-test verification**

Impacted: the cross_kind attach matrix (`a_queued_attach_mid_handoff_is_refused_typed_no_restamp`, `a_current_attach_succeeds_and_restamps`, `an_attach_while_a_fresh_agent_owns_answers_the_typed_fresh_owner_conflict`, `an_attach_while_a_different_terminal_owns_answers_the_typed_other_terminal_conflict`) and the in-crate lib.

Run: `cargo test -p freshell-ws --test cross_kind_liveness attach && cargo test -p freshell-ws --lib`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ws/src/terminal.rs crates/freshell-ws/tests/cross_kind_liveness.rs
git commit -m "feat(ws): terminal-lane attach-claim commit broadcasts its committed owner pair"
```

---

### Task 3: Server — the auto-resume respawn settle and the REST rung broadcast their commits

**Files:**
- Modify: `crates/freshell-ws/src/auto_resume.rs` (respawn settle commit ~:1175, inside `complete_claim`)
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs` (REST rung commit ~:3138; claim commit method at ~:872-889)
- Test: `crates/freshell-ws/src/auto_resume.rs` (in-crate `mod tests` at :1453)
- Test: `crates/freshell-freshagent/src/terminal_tabs.rs` (in-crate tests — the broadcast-capture pattern `let mut rx = state.broadcast_tx.subscribe()` already exists at :3879+)

**Interfaces:**
- Consumes: `broadcast_owner_frame` (freshell-ws, auto-resume site holds `state: &WsState`); the freshagent crate's own emission shape (lib.rs:1146-1167) for the REST rung (`FreshAgentState.broadcast_tx`, lib.rs:1917; `RestOwnershipClaim.ticket` at terminal_tabs.rs:866-890, ticket fields readable pre-commit).
- Produces: every remaining terminal-lane commit-to-Live site emits the same `session.runtimeOwner` frame — the "EVERY ownership transition BROADCASTS" invariant holds for the terminal lane.

- [ ] **Step 1: Write the failing behavioral tests**

auto_resume.rs in-crate test (extend `mod tests` at :1453; capture with the same broadcast-channel pattern as identity_ownership's `race_state` :858-915 — the hub's `state` is a cloned `WsState`):

```rust
#[tokio::test]
async fn a_completed_respawn_claim_broadcasts_its_committed_owner_pair() {
    // Seed the hub + a parked pending_ownership claim exactly as the existing
    // complete_claim tests in this module do (see the nearest existing test
    // for the hub/parking fixture), with a broadcast receiver subscribed
    // BEFORE the commit; drive complete_claim to the commit; then:
    let frame = /* drain rx for type=="session.runtimeOwner" && sessionId==SID */;
    assert_eq!(frame["ownerKind"], "terminal");
    assert_eq!(frame["transition"], "handoff-committed");
    assert_eq!(frame["generation"], json!(committed_generation));
    assert_eq!(frame["epoch"], json!(ownership.boot_epoch()));
    assert_eq!(frame["terminalId"], json!(new_terminal_id));
}
```

terminal_tabs.rs in-crate test (REST rung; mirror the drain pattern at :3879 and the freshagent precedent `a_normal_create_broadcasts_the_committed_owner_record` codex.rs:23301-23356):

```rust
#[tokio::test]
async fn a_rest_rung_commit_broadcasts_its_committed_owner_pair() {
    // state_with_bus-style fixture with broadcast receiver subscribed before the
    // commit; drive the RestOwnershipClaim commit path (or spawn_terminal_pane_
    // with_handoff's settle under the same fixtures the neighboring REST tests
    // use); then assert the frame:
    assert_eq!(frame["ownerKind"], "terminal");
    assert_eq!(frame["transition"], "handoff-committed");
    assert_eq!(frame["generation"], json!(ticket_generation));
    assert_eq!(frame["terminalId"], json!(terminal_id));
}
```

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-ws --lib auto_resume::tests::a_completed_respawn_claim`
Run: `cargo test -p freshell-freshagent --lib a_rest_rung_commit_broadcasts`

Expected: FAIL — no frame on the bus for either site.

- [ ] **Step 3: Add the minimal production implementation**

auto_resume.rs `complete_claim` (~1175): capture `claim.ticket.operation_id()/generation()` before the `commit_session_ref_ownership` call, then on `Committed`:

```rust
        // b8ke fence-heal: the respawn settle is a terminal-lane commit-to-Live —
        // it broadcasts its own committed pair (r29 F1 invariant / r32 F2 pair).
        crate::identity_ownership::broadcast_owner_frame(
            &self.state,
            &claim.locator.provider,
            &claim.locator.session_id,
            &new_terminal_id,
            &owner_operation_id,
            owner_generation,
            "handoff-committed",
        );
```

terminal_tabs.rs REST rung (~3138 Ok arm): the crate cannot call freshell-ws's helper; construct the same frame in-crate exactly as freshagent lib.rs:1146-1167 does, but with terminal-owner fields:

```rust
                    // b8ke fence-heal: the REST rung's commit-to-Live broadcasts
                    // its own committed pair (r29 F1 invariant / r32 F2 pair),
                    // mirroring broadcast_owner_frame's terminal-Live shape.
                    let frame = freshell_protocol::ServerMessage::SessionRuntimeOwner(
                        freshell_protocol::SessionRuntimeOwner {
                            provider: claim_locator.provider.clone(),
                            session_id: claim_locator.session_id.clone(),
                            epoch: /* coordinator boot_epoch reachable via the registry/ownership handle the claim committed through */,
                            generation: owner_generation,
                            owner_kind: "terminal".into(),
                            previous_kind: None,
                            terminal_id: Some(terminal_id.clone()),
                            operation_id: owner_operation_id,
                            transition: "handoff-committed".into(),
                            reason: None,
                            fenced: None,
                            alias_of: None,
                        },
                    );
                    if let Ok(frame) = serde_json::to_string(&frame) {
                        let _ = state.broadcast_tx.send(frame);
                    }
```

(Capture `owner_operation_id`/`owner_generation` from `claim.ticket` before `claim.commit(...)`; obtain `boot_epoch` from the same ownership registry handle the claim's commit path uses — if `RestOwnershipClaim` does not already carry it, add a `boot_epoch: u64` field captured at claim-mint time, which keeps the frame construction self-contained and honest.)

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-ws --lib auto_resume::tests::a_completed_respawn_claim && cargo test -p freshell-freshagent --lib a_rest_rung_commit_broadcasts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

If the two freshagent emission sites (lib.rs:1146 fresh-agent lane + this one) now share a builder shape, extract nothing unless a `terminal_owner_frame(...)` free function in freshagent removes real duplication; keep r32 F2 comments at both sites. Rerun.

- [ ] **Step 6: Run impacted-test verification**

Impacted: auto_resume's existing tests (`cargo test -p freshell-ws --lib auto_resume`), the REST create/resume tests (`cargo test -p freshell-freshagent --lib terminal_tabs` or the crate's test filter for the REST rung tests), and cross_kind_liveness (no behavior change expected there).

Run: `cargo test -p freshell-ws --lib auto_resume && cargo test -p freshell-freshagent --lib && cargo test -p freshell-ws --test cross_kind_liveness`

Expected: PASS (freshell-freshagent --lib is a large but delegate-able focused lane; if runtime is prohibitive, narrow to the terminal_tabs + lib ownership tests and note the broad run for the end-of-execution gate)

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ws/src/auto_resume.rs crates/freshell-freshagent/src/terminal_tabs.rs
git commit -m "feat(ws,freshagent): auto-resume and REST-rung terminal commits broadcast their owner pair"
```

---

### Task 4: Server — typed stale refusals carry the current pair (create stale arms + kill refusals)

**Files:**
- Modify: `crates/freshell-protocol/src/server_messages.rs` (`TerminalKilled` struct — additive trio, skip-None)
- Modify: `crates/freshell-ws/src/terminal.rs` (create stale arms ~:3711-3737, ~:3789-3805, learned-claim refusals ~:4516-4529; kill refusal arms ~:7839-7890)
- Test: `crates/freshell-ws/tests/cross_kind_liveness.rs` (extend `a_stale_generation_attach_is_refused_typed` ~:6605 to pin the attach-refusal pair; new create-refusal test)
- Test: `crates/freshell-ws/src/terminal.rs` (in-crate kill tests near `kill_whose_row_was_already_reaped_commits_the_granted_stop` ~:9402 / `state_with_live_terminal_owner` ~:9284)

**Interfaces:**
- Consumes: `BeginOutcome::StaleGeneration { current_epoch, current_generation }` (freshell-ownership/src/lib.rs:474-478); `StopOutcome::StaleClaim { current_epoch, current_generation, state }` (the kill lane's refusal carries the current pair and the owner state — verify exact field names in freshell-ownership/src/lib.rs); the ErrorMsg additive trio (server_messages.rs:674-688) already present on the wire.
- Produces: every terminal-lane typed stale refusal (create, attach, kill) carries `ownerEpoch`/`ownerGeneration` of the coordinator's current pair — the server half of fix (b) (the attach arms already comply; this task pins + completes). Task 6 consumes the kill ack trio.

- [ ] **Step 1: Write the failing behavioral tests**

(a) Extend `a_stale_generation_attach_is_refused_typed` (~:6682-6695) — pin what already holds:

```rust
    // b8ke fence-heal: the refusal carries the coordinator's CURRENT pair so
    // the client can refresh its fence (fix b server contract).
    assert_eq!(refused["ownerEpoch"], json!(current.epoch));
    assert_eq!(refused["ownerGeneration"], json!(current.generation));
```

(b) New test in the same file — a create refused with a stale observed generation carries the current pair (model: send `terminal.create` with `sessionRef` + an `observedGeneration` behind `current.generation` — seed the session Live first exactly as :6634-6646 does, then create with the stale pair):

```rust
#[tokio::test]
async fn a_stale_generation_create_refusal_carries_the_current_pair() {
    // ...seed Live exactly as a_stale_generation_attach_is_refused_typed :6634-6661...
    let refused = /* terminal.create with observedEpoch/observedGeneration one generation behind; capture the error frame */;
    assert_eq!(refused["code"], "SESSION_RESERVED");
    assert_eq!(refused["ownerEpoch"], json!(current.epoch));
    assert_eq!(refused["ownerGeneration"], json!(current.generation));
}
```

(c) In-crate kill refusal test (extend the `state_with_live_terminal_owner` fixture tests near :9402): drive a kill with a stale claim fence; assert the refusal ack/error carries the trio. For the `TerminalKilled{success:false}` ack shape assert `ownerEpoch`/`ownerGeneration`/`ownerKind` fields; for the Error-shape arm assert the ErrorMsg trio.

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-ws --test cross_kind_liveness a_stale_generation && cargo test -p freshell-ws --test cross_kind_liveness a_stale_generation_create_refusal && cargo test -p freshell-ws --lib kill`

Expected: (a) PASS already (pin); (b),(c) FAIL — create/kill refusals carry no pair.

- [ ] **Step 3: Add the minimal production implementation**

(a) `TerminalKilled` (server_messages.rs): add the additive trio (owner_kind/owner_epoch/owner_generation, Option + skip-None, same doc discipline as Task 1). Fix every literal with `None`.

(b) Create stale arms — populate from the outcome's own current pair (do NOT route through `terminal_owner_fields_from_outcome`, which returns None for StaleGeneration by design; freshagent lib.rs:1743-1767):
- wire-claim Adopt arm (~3711-3737): `AttachGuardOutcome::StaleGeneration { current_epoch, current_generation }` is in scope at the match — set `owner_epoch: Some(current_epoch), owner_generation: Some(current_generation)` on the frame.
- wire-claim Refused arm (~3789-3805): `BeginOutcome::StaleGeneration { current_epoch, current_generation }` likewise.
- learned-claim refusal arm (~4516-4529): the same StaleGeneration values in scope; set the pair (leave the non-stale outcomes without owner fields, as today).
- `send_create_error` gains an `owner: Option<TerminalOwnerFields>` parameter only if needed; prefer threading the pair explicitly at these three arms mirroring how `send_create_error_with_owner` (:6701-6730) builds frames.

(c) Kill refusal arms (~7839-7890): the `StaleClaim` outcome carries the current pair (and the owner state) — populate `owner_epoch`/`owner_generation` (and `owner_kind` from the state's owner kind where the enum provides it) on BOTH the `TerminalKilled{success:false}` ack and the Error arm. Other kill arms unchanged.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-ws --test cross_kind_liveness a_stale_generation && cargo test -p freshell-ws --lib kill`

Expected: PASS

- [ ] **Step 5: Refactor while green**

If three create arms now hand-build the pair, a one-line local helper `fn stale_pair_fields(current_epoch: u64, current_generation: u64) -> TerminalOwnerFields` (in terminal.rs, next to the existing helpers) removes the repetition — add it only if it keeps each arm's match values visible. Rerun.

- [ ] **Step 6: Run impacted-test verification**

Impacted: all freshell-ws refusal-matrix tests (cross_kind_liveness attach/create/kill families), protocol round-trips for TerminalKilled, in-crate terminal.rs kill tests, and the freshagent REST refusal tests that mirror create refusals (`terminal_create_refusal_names_the_fresh_agent_owner_kind_and_generation` at cross_kind_liveness.rs:2217).

Run: `cargo test -p freshell-protocol && cargo test -p freshell-ws --test cross_kind_liveness && cargo test -p freshell-ws --lib`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-protocol/src/server_messages.rs crates/freshell-ws/src/terminal.rs crates/freshell-ws/tests/cross_kind_liveness.rs
git commit -m "feat(ws): typed stale refusals carry the coordinator's current owner pair (create/kill arms + TerminalKilled trio)"
```

---

### Task 5: Client — the `terminal.created` fold makes a just-created pane's first attach born fresh (fix c)

**Files:**
- Modify: `shared/ws-protocol.ts` (`TerminalCreatedMessage` ~:1214-1225 — additive optional trio)
- Modify: `src/components/TerminalView.tsx` (created handler ~:4625-4777; fold before the queued attach at ~:4748-4752)
- Test: `test/unit/client/components/TerminalView.lifecycle.test.tsx` (sibling of the attach-after-created test ~:1852-1915; helpers `setupTypedPane` :3443+, `runtimeOwnerFrame` :3428-3441, `sentMessages()` :347)

**Interfaces:**
- Consumes: Task 1's `terminal.created` owner trio; `applyRuntimeOwner` (src/store/freshAgentSlice.ts:676-695 — full record replace, monotonic gate, key `${provider}:${sessionId}`); the created handler's `sessionRef` (frame identity for the fold key).
- Produces: a just-created pane's queued attach carries the create's committed pair — Task 7's e2e proves the end-to-end story.

- [ ] **Step 1: Write the failing behavioral test**

Sibling of `'sends a viewport attach after terminal.created without issuing a second resize'` (:1852-1915) in TerminalView.lifecycle.test.tsx:

```ts
it('folds the created frame owner pair so the queued attach is born fresh over a stale record', async () => {
  const { messageHandler, sentMessages } = await setupTypedPane({
    seed: {
      // a STALE pre-create record for the pane's sessionRef: gen 3
      ...runtimeOwnerFrame({ provider: 'codex', sessionId: TYPED_SESSION_ID, generation: 3 }),
    },
  })
  messageHandler!({
    type: 'terminal.created',
    requestId: 'req-b8ke',
    terminalId: 'tid-new-1',
    createdAt: Date.now(),
    sessionRef: { provider: 'codex', sessionId: TYPED_SESSION_ID, startedAt: 0 },
    ownerKind: 'terminal',
    ownerEpoch: 9,
    ownerGeneration: 6,
  })
  const attach = sentMessages().find((m: any) => m.type === 'terminal.attach')!
  expect(attach.observedEpoch).toBe(9)
  expect(attach.observedGeneration).toBe(6) // the committed pair, NOT the stale 3
  // and the store record advanced:
  const rec = store.getState().freshAgent.runtimeOwners[`codex:${TYPED_SESSION_ID}`]
  expect(rec.generation).toBe(6)
})
```

(adapt to the harness's actual setup API — `setupTypedPane` returns the store + messageHandler + sentMessages per :3443-3502.)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/TerminalView.lifecycle.test.tsx`

Expected: FAIL — `ownerKind`/`ownerEpoch`/`ownerGeneration` are not on the TS type (compile/type error) and the attach carries the stale pair 3 (or no pair semantics), the store record stays at generation 3.

- [ ] **Step 3: Add the minimal production implementation**

(a) shared/ws-protocol.ts `TerminalCreatedMessage` (~:1214-1225) — add:

```ts
  /** b8ke fence-heal: the create's committed owner pair (additive, absent on legacy servers). */
  ownerKind?: 'terminal'
  ownerEpoch?: number
  ownerGeneration?: number
```

(b) TerminalView.tsx created handler — after the sessionRef/association fold (~4708) and BEFORE the background-hydration registration / queued attach (~4748-4752):

```ts
      // b8ke fence-heal (fix c): the create's OWN committed pair, folded
      // BEFORE the queued attach fires — the first attach is born fresh
      // even when the store still holds a stale pre-create record. The
      // frame omits the trio on legacy servers and identity-less spawns.
      if (
        msg.sessionRef
        && msg.ownerKind
        && typeof msg.ownerEpoch === 'number'
        && typeof msg.ownerGeneration === 'number'
      ) {
        appStore.dispatch(applyRuntimeOwner({
          type: 'session.runtimeOwner',
          provider: msg.sessionRef.provider,
          sessionId: msg.sessionRef.sessionId,
          epoch: msg.ownerEpoch,
          generation: msg.ownerGeneration,
          ownerKind: msg.ownerKind,
          terminalId: msg.terminalId,
          operationId: `terminal-created:${msg.terminalId}`,
          transition: 'handoff-committed',
        } as SessionRuntimeOwnerMessage))
      }
```

(the dispatch pattern follows the file's existing `appStore.dispatch(applyRuntimeOwner(...))` usages — check the import list and how App folds the same message type; `applyRuntimeOwner` takes the `SessionRuntimeOwnerMessage` payload verbatim).

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/TerminalView.lifecycle.test.tsx`

Expected: PASS (both the new sibling and the existing :1852 test — which injects a created frame WITHOUT the trio and must keep behaving identically).

- [ ] **Step 5: Refactor while green**

None expected — one guarded fold. Verify no double-fold hazard with the Task 1 broadcast (identical pair, monotonic gate makes the second fold a no-op) by rerunning the focused test.

- [ ] **Step 6: Run impacted-test verification**

Impacted: all TerminalView lifecycle tests, the freshAgentSlice fold tests, the ready-replay fold tests (fresh-agent-ws.test.ts:901+), and PaneContainer/TabBar fence consumers (unchanged code paths, but they share the store).

Run: `npm run test:vitest -- run test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/store/freshAgentSlice.runtime-owner.test.ts test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/TabBar.test.tsx`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add shared/ws-protocol.ts src/components/TerminalView.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "feat(client): fold terminal.created owner pair before the queued attach (fresh first attach)"
```

---

### Task 6: Client — typed stale refusals refresh the fence (merge-only fold, all claim scopes) (fix b)

**Files:**
- Modify: `src/store/freshAgentSlice.ts` (new action `applyRuntimeOwnerFenceRefresh` next to `applyRuntimeOwner` ~:676-695)
- Modify: `src/store/freshAgentTypes.ts` (no type change expected — the action payload is inline; extend only if the pattern requires)
- Create: `src/lib/owner-fence-heal.ts` (the shared fold helper)
- Modify: `shared/ws-protocol.ts` (`TerminalKilledMessage` — additive trio, mirroring Task 4's wire)
- Modify: `src/components/TerminalView.tsx` (create-scoped error branch ~:5135-5159; NEW attach-scoped branch; kill failure paths)
- Modify: `src/lib/kill-ack.ts` (propagate the pair off refusal results ~:116-159)
- Modify: `src/components/TabBar.tsx` (close-tab kill fold ~:411-433)
- Modify: `src/lib/fresh-agent-ws.ts` (`createFailed` fold ~:208-228)
- Test: `test/unit/client/store/freshAgentSlice.runtime-owner.test.ts`, `test/unit/client/lib/fresh-agent-ws.test.ts`, `test/unit/client/lib/kill-ack.test.ts`, `test/unit/client/lib/terminal-kill.test.ts`, `test/unit/client/components/TerminalView.lifecycle.test.tsx`, `test/unit/client/components/panes/PaneContainer.test.tsx`

**Interfaces:**
- Consumes: Task 4's refusal pairs (create arms, kill acks) and the already-present attach-refusal pair; `resolveCanonicalPaneSession` (src/store/selectors/runtimeOwner.ts:143-148) for pane→(provider, sessionId) resolution; the r35 per-request capture (`requestFenceRef`) left untouched.
- Produces: `applyRuntimeOwnerFenceRefresh({ provider, sessionId, epoch, generation })` (merge-only, monotonic gate); `foldRefusalFencePair(dispatch, identity, frame)` in `src/lib/owner-fence-heal.ts` returning whether a fold happened. Task 7's e2e proves the wedge is gone end-to-end.

- [ ] **Step 1: Write the failing behavioral tests**

(a) Reducer tests (freshAgentSlice.runtime-owner.test.ts, using the file's `baseFrame`/`reducerWith` helpers :9-23):

```ts
describe('applyRuntimeOwnerFenceRefresh (b8ke fence-heal)', () => {
  it('merges the fresh pair into an existing record, preserving ownerKind/transition', () => {
    const state = reducerWith(baseFrame({ provider: 'codex', sessionId: 's1', generation: 3, ownerKind: 'terminal', transition: 'handoff-committed' }))
    const next = reducer(state, applyRuntimeOwnerFenceRefresh({ provider: 'codex', sessionId: 's1', epoch: baseFrame().epoch, generation: 6 }))
    const rec = next.runtimeOwners['codex:s1']
    expect(rec.generation).toBe(6)
    expect(rec.ownerKind).toBe('terminal')
    expect(rec.transition).toBe('handoff-committed')
  })
  it('is a no-op when no record exists', () => {
    const next = reducer(reducerWith(undefined), applyRuntimeOwnerFenceRefresh({ provider: 'codex', sessionId: 'missing', epoch: 1, generation: 5 }))
    expect(next.runtimeOwners['codex:missing']).toBeUndefined()
  })
  it('drops a same-epoch older generation and honors a new epoch', () => {
    // existing gen 6, refresh gen 5 same epoch -> unchanged;
    // refresh (epoch+1, gen 1) -> applied (epoch change wins)
  })
})
```

(b) Dispatch-path test (fresh-agent-ws.test.ts, `runtime-owner folds` describe :901+): a `freshAgent.create.failed` frame carrying `ownerEpoch`/`ownerGeneration` (+ provider/sessionId) folds the pair into a seeded stale runtimeOwners record.

(c) TerminalView.lifecycle.test.tsx siblings of the r35 test (:3602-3655):
- create-scoped: inject the SESSION_RESERVED refusal WITH the trio; assert the automatic re-drive still carries the ORIGINAL pair (r35 intact — that test's frame has no trio, so it stays green unchanged) AND the store record now holds the refusal pair; then a user Retry-launch (reconcileEpoch bump) re-captures the FRESH pair.
- attach-scoped (NEW branch): inject `error { code: 'SESSION_RESERVED', terminalId: <pane terminalId>, ownerEpoch, ownerGeneration, message: '...stale observed generation...' }` (no requestId); assert the store fold and that the next `terminal.attach` send carries the fresh pair.

(d) kill-ack.test.ts: a `TerminalKilled { success: false, ownerEpoch, ownerGeneration }` ack and an error-frame failure both surface the pair on the await result; terminal-kill/PaneContainer tests: after a refused close-kill carrying the pair, the next close attempt sends the fresh pair (seed the store record, assert the second `freshAgent.kill`/`terminal.kill` frame).

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/store/freshAgentSlice.runtime-owner.test.ts test/unit/client/lib/kill-ack.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/lib/terminal-kill.test.ts`

Expected: FAIL — `applyRuntimeOwnerFenceRefresh` does not exist; kill-ack results carry no pair; the attach-scoped refusal is silently dropped (the wedge).

- [ ] **Step 3: Add the minimal production implementation**

(a) freshAgentSlice.ts — next to `applyRuntimeOwner`:

```ts
    /**
     * b8ke fence-heal (fix b): merge a typed stale-refusal's CURRENT
     * (epoch, generation) into the EXISTING runtimeOwners record —
     * ownerKind/transition/terminalId/aliasOf are preserved (the refusal
     * corrects the fence pair only; it must not fabricate or clear owner
     * identity). No record → no-op (nothing to correct; broadcasts,
     * the created-frame fold, or the ready replay repopulate records).
     * Same monotonic gate as applyRuntimeOwner: same-epoch older drops,
     * a different epoch always wins.
     */
    applyRuntimeOwnerFenceRefresh(state, action: PayloadAction<{ provider: string; sessionId: string; epoch: number; generation: number }>) {
      const { provider, sessionId, epoch, generation } = action.payload
      const key = `${provider}:${sessionId}`
      const existing = state.runtimeOwners[key]
      if (!existing) return
      if (existing.epoch === epoch && generation < existing.generation) return
      state.runtimeOwners[key] = { ...existing, epoch, generation, updatedAt: Date.now() }
    },
```

(b) `src/lib/owner-fence-heal.ts` (new):

```ts
import { applyRuntimeOwnerFenceRefresh } from '@/store/freshAgentSlice.js'

export type RefusalFencePair = { ownerEpoch?: number; ownerGeneration?: number }
export type SessionIdentity = { provider: string; sessionId: string } | undefined

/** Fold a typed refusal's current pair into the pane's runtimeOwners record.
 * Returns true when a fold was dispatched. Merge-only by construction. */
export function foldRefusalFencePair(
  dispatch: (action: ReturnType<typeof applyRuntimeOwnerFenceRefresh>) => void,
  identity: SessionIdentity,
  pair: RefusalFencePair,
): boolean {
  if (!identity) return false
  if (typeof pair.ownerEpoch !== 'number' || typeof pair.ownerGeneration !== 'number') return false
  dispatch(applyRuntimeOwnerFenceRefresh({
    provider: identity.provider,
    sessionId: identity.sessionId,
    epoch: pair.ownerEpoch,
    generation: pair.ownerGeneration,
  }))
  return true
}
```

(c) TerminalView.tsx error subscription:
- In the create-scoped typed branch (~5135-5159), after the existing launch-failure fold:

```ts
        foldRefusalFencePair(
          dispatch,
          resolveCanonicalPaneSession(appStore.getState(), contentRef.current ?? {}),
          msg,
        )
```

- New attach-scoped branch (ahead of the catch-all, keyed on the pane's own terminal, no requestId):

```ts
      // b8ke fence-heal (fix b): the attach-scoped typed refusal (no
      // requestId, terminalId set) previously matched NO branch — the pane
      // silently never attached (the wedge). Fold the current pair so the
      // next attach (send-time fence read) is fresh.
      } else if (!msg.requestId && msg.terminalId && msg.terminalId === terminalIdRef.current) {
        foldRefusalFencePair(
          dispatch,
          resolveCanonicalPaneSession(appStore.getState(), contentRef.current ?? {}),
          msg,
        )
      }
```

- TerminalView's own kill failure paths: fold from the await result's pair with the same identity helper.

(d) kill-ack.ts: lift `ownerEpoch`/`ownerGeneration` off the `TerminalKilled{success:false}` ack and the correlated error frame onto the failure result (`{ ok: false, ownerEpoch?, ownerGeneration? }`); add the trio to `TerminalKilledMessage` in shared/ws-protocol.ts (additive optional, mirroring Task 4's Rust trio).

(e) TabBar.tsx close-tab kill (~:411-433) and PaneContainer's kill consumers: on a failure result carrying the pair, `foldRefusalFencePair` with the target's sessionRef identity.

(f) fresh-agent-ws.ts `createFailed` (~:208-228): after the existing `pendingCreateFailures` fold, dispatch `applyRuntimeOwnerFenceRefresh` keyed by the frame's own provider/sessionId when the trio is present.

- [ ] **Step 4: Run the focused tests**

Run: `npm run test:vitest -- run test/unit/client/store/freshAgentSlice.runtime-owner.test.ts test/unit/client/lib/kill-ack.test.ts test/unit/client/lib/terminal-kill.test.ts test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx`

Expected: PASS

- [ ] **Step 5: Refactor while green**

All refusal paths now route through `foldRefusalFencePair`; collapse any duplicated guard logic into it (it is the single guard). Rerun the focused set.

- [ ] **Step 6: Run impacted-test verification**

Impacted: the full typed-refusal/fence surface — TerminalView lifecycle suite, PaneContainer, TabBar, BackgroundSessions, fresh-agent suites, ws-client tests, selectors tests. This is effectively the client fence surface; run:

Run: `npm run test:vitest -- run test/unit/client/store test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/lib/kill-ack.test.ts test/unit/client/lib/terminal-kill.test.ts test/unit/client/lib/session-handoff.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/TabBar.test.tsx`

Expected: PASS (this broad-but-still-narrowed lane is delegated, not coordinator-gated)

- [ ] **Step 7: Commit the task**

```bash
git add src/store/freshAgentSlice.ts src/lib/owner-fence-heal.ts src/components/TerminalView.tsx src/lib/kill-ack.ts src/components/TabBar.tsx src/lib/fresh-agent-ws.ts shared/ws-protocol.ts test/unit/client
git commit -m "feat(client): typed stale refusals refresh the runtimeOwners fence (merge-only, create/attach/kill scopes)"
```

---

### Task 7: E2E — the no-reload reopen regression + affected-spec verification

**Files:**
- Modify: `test/e2e-browser/specs/restore-contract-wall-rust.spec.ts` (new sibling test next to the codex sessionRef-resume test ~:797)
- Test: run the affected ownership specs (restore-contract-wall, handoff-two-device, reconnect-revive, sidebar-click-resume)

**Interfaces:**
- Consumes: the spec's existing `bootWall` harness, the dual-role fake codex on `CODEX_CMD`, the seeded sidebar session, and `RustServer` helpers (`server.restartAbrupt()` NOT needed for the new leg — no restart is involved).
- Produces: the end-to-end proof of the User Request: after a session-resuming terminal-lane create, the same page (no reload) can close and reopen the session and the reopened pane attaches and round-trips input. Pre-fix this wedged behind the stale fence.

- [ ] **Step 1: Write the failing e2e test**

New sibling test in restore-contract-wall-rust.spec.ts (model the resume-create on the :797 test's first half — fake CLI, seeded session, sidebar click, resumed-marker buffer assertion):

```ts
test('codex terminal: close and reopen a resumed session without a page reload converges', async ({ page }) => {
  const wall = await bootWall(/* same fixtures as the :797 test */)
  // 1. open the seeded session from the sidebar (terminal-lane resume create)
  await page.getByRole('button', { name: /* seeded session row label */ }).click()
  await expect(page.getByTestId('terminal-0')).toContainText(/* resumed marker */, { timeout: 30_000 })
  // 2. close the tab (kill path), then reopen THE SAME session from the
  //    sidebar — NO page reload in between.
  await page.getByRole('button', { name: /* close tab */ }).click()
  await page.getByRole('button', { name: /* seeded session row label */ }).click()
  // 3. the reopened pane attaches and round-trips input (pre-fix: the
  //    stale-fence wedge loops typed refusals and never attaches)
  await expect(page.getByTestId('terminal-0')).toContainText(/* resumed marker */, { timeout: 30_000 })
  await page.keyboard.type('echo fence-heal-e2e\n')
  await expect(page.getByTestId('terminal-0')).toContainText('fence-heal-e2e', { timeout: 30_000 })
})
```

(adapt selectors to the spec's existing helpers — mirror the :797 test's selector idioms exactly; the fake CLI echoes stdin per fixtures/fake-codex-cli.mjs.)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `scripts/e2e-cloud.sh run --local --project=chromium test/e2e-browser/specs/restore-contract-wall-rust.spec.ts --grep="without a page reload"`

Expected: FAIL on the reopen step (the pane never attaches) when run against a pre-fix server build — run this step only if the server binary predates Tasks 1-6; after Tasks 1-6 the Rust server binary for the e2e is rebuilt by the harness (`cargo build --release -p freshell-server`, helpers/rust-server.ts), so execute this step BEFORE Task 1's changes are reverted — i.e., in practice: if the full branch is already built, instead demonstrate the red by checking out `base_ref` server behavior is already known (the incident), and treat the post-fix green as the regression proof. Record honestly in the task report which path was taken.

- [ ] **Step 3: Add any production implementation this test demands**

None expected — Tasks 1-6 are the implementation. If the test reveals a further gap (e.g. the reopen path still hits a refusal loop), fix it under the same TDD discipline as a focused follow-up inside this task and record it.

- [ ] **Step 4: Run the focused test**

Run: `scripts/e2e-cloud.sh run --local --project=chromium test/e2e-browser/specs/restore-contract-wall-rust.spec.ts`

Expected: PASS (the whole spec, including pre-existing tests)

- [ ] **Step 5: Refactor while green**

Keep the new test minimal and aligned with the spec's helper idioms; no fixture changes unless the fake CLI needs an echo affordance it lacks (check fixtures/fake-codex-cli.mjs first).

- [ ] **Step 6: Run impacted-test verification (affected e2e specs on the configured backend)**

Per AGENTS.md, affected e2e specs must pass on the configured backend (local, non-interactive default). The ownership/resume spec family:

Run: `scripts/e2e-cloud.sh run --local --project=chromium test/e2e-browser/specs/restore-contract-wall-rust.spec.ts test/e2e-browser/specs/handoff-two-device-rust.spec.ts test/e2e-browser/specs/reconnect-revive-rust.spec.ts test/e2e-browser/specs/sidebar-click-resume.spec.ts`

Expected: PASS. NOTE: `sidebar-click-resume.spec.ts:104` carries a `test.fail` pin (TERM-22 "click-resume never assigns terminalId") — if this run turns that leg green post-fix, REMOVE the `test.fail` pin in this task and note it; if it is still red, leave the pin and record it as out-of-scope follow-up (its failure may predate this fix).

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/restore-contract-wall-rust.spec.ts test/e2e-browser/specs/sidebar-click-resume.spec.ts
git commit -m "test(e2e): no-reload close/reopen of a resumed terminal session converges (fence-heal regression)"
```

---

## Post-execution gate (not a plan task; owned by the workflow)

After every task completes and reviews pass, run the full-suite gate once from this worktree:

```bash
FRESHELL_TEST_SUMMARY="the-usual ownership-fence-fix final gate" npm test
```

Pass criterion: green excluding ledger-recorded pre-existing failures (the baseline at base_ref 855dae72 was fully green, so any new failure is attributable to this branch). The gate is coordinator-gated; wait on any foreign holder. `cargo fmt` + `npm run typecheck:client` + clippy must also be clean (pre-push gate parity; the pre-push hook runs on push).

## Plan self-review record

- Spec coverage: (a) → Tasks 1-3 (create settle, attach claim, completeness sites auto-resume/REST under "whenever the terminal lane commits"); (b) → Task 4 (server pair on refusals) + Task 6 (client merge-only fold wired to all claim scopes); (c) → Task 1/2 (created pair) + Task 5 (client fold before the queued attach); e2e coverage → Task 7; unit coverage → per-task focused tests (Rust protocol/ws/freshagent + client store/lib/component suites).
- r32 F2 discipline: all broadcasts use the claim ticket's pre-commit pair via `broadcast_owner_frame` / the freshagent in-crate equivalent; never `observe()`. The `_if_authoritative` variant is explicitly forbidden for these sites.
- r35 contract preserved: automatic re-drives keep the captured pair (the fold updates the store for the NEXT decision only); the pinned test at TerminalView.lifecycle.test.tsx:3602 models a refusal WITHOUT owner fields and stays green unchanged; new siblings assert the fold.
- Frozen-client parity: all wire additions are Option + skip-None; legacy arms unchanged; `transition: "handoff-committed"` reuse avoids the client whitelist change.
- No silent deferrals: the merge-only no-record no-op is a documented residual (records repopulate via broadcast/created/ready replay), not a stub; the fresh-agent kill-refusal frame pair (freshAgent.killed) is OUT OF SCOPE per the User Request's terminal-lane framing — recorded as an out-of-scope suggestion.
- Operational: no migrations; no production restart (server binary changes deploy only with explicit approval); no docs/index.html change (not user-facing UI); the worktree stays clean of untracked litter for cloud-run parity.
