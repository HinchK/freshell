# Session Handoff Stabilization Implementation Plan

> **For agentic workers:** Execute the eight tasks in order, with author checks and tests at each checkpoint. The user's explicit review budget replaces the usual per-task independent reviews: perform **one scoped independent code review and one verification pass**, in Task 8. This run writes and self-checks the plan only; root commits it and stops before Stage 2, independent plan review, or implementation.

## User Request

### Requested result
Write and commit an executable plan for one bounded stabilization pass and one landing PR for the Freshell session-handoff architecture reviewed at commit 7824b5aab, using the-usual. Stop immediately after plan writing and its self-check; do not begin independent plan review or implementation in this run.

### Explicit constraints
- Preserve the shared server ownership architecture and existing behavioral tests. Invest the code needed for stability and resilience; line count is not a limit.
- Plan against five shipping guarantees: mode switches preserve the exact conversation; a replacement session writer starts only after the prior writer stops; a runtime advertised as running is attachable and relinquishes ownership on exit; other devices converge after switches/reconnects and delayed requests cannot undo newer operations; failures leave understandable states with working recovery actions.
- Future execution first integrates the reviewed branch with current main in a dedicated landing worktree, preserves the original branch, and resolves conflicts before repairing findings. Use one feature PR with focused internal commits.
- Reproduce the five source-review findings before fixing them: terminal handoff publication omits terminal release bookkeeping; Codex shutdown can declare completion before owned provider writers stop; attachment retries retain an obsolete server epoch/generation across same-session recovery; Force clear can silently make no request for starting/busy panes; OpenCode placeholder attachment still emits repeated reservation errors. Disprove unsupported findings with evidence instead of changing code on assertion alone.
- Repair and consolidate existing runtime publication, confirmed shutdown, and attachment-attempt boundaries where these findings expose duplication. Do not expand into wholesale registry replacement, broad file splitting, or historical-comment cleanup.
- Make platform behavior intentional: use existing native process supervision when it can establish writer shutdown; otherwise refuse unsupported atomic handoff before stopping the current session, with a clear explanation. Preserve ordinary supported desktop behavior.
- Give Force clear an explicit contract separating stale-bookkeeping repair from stopping a potentially live writer. Missing process information must not count as proof of shutdown.
- Reuse existing tests and add only missing behavioral coverage: provider lifecycle create/resume/switch/attach/exit/kill; the five regressions; two-device switches in both directions and reconnect; same-session restart recovery; representative competing requests, failed starts, and interrupted stops; smoke coverage for each platform advertising the changed behavior.
- Put regression tests at the lowest layer that exercises the failure, and use browser tests for complete user flows without duplicating all timing permutations. Apply red/green/refactor, run focused tests during repairs, and run required broad checks and affected browser tests on the integrated final result. Preserve coverage and diagnose flaky tests.
- Bound the future code review to one independent review and one verification pass focused on the five guarantees, repaired paths, and conflict resolutions. A blocker needs a supported operation or credible failure scenario, the violated guarantee, and a reproduction, deterministic test, or concrete execution trace. No further unrestricted whole-branch or nested focused-review loops; remaining demonstrated defects receive targeted repairs and remain blockers until resolved.
- Readiness requires the five findings resolved or disproved, the acceptance matrix passing, intentional platform behavior, and no demonstrated violation of the five guarantees. Optional improvements remain follow-up work.
- This run authorizes planning only: no integration, production-code changes, independent plan review, load-bearing validation stage, PR creation, merge, or deployment. After the plan is committed, stop.
- Follow repository worktree, green-base, test-coordination, configured-backend, logging, and process-safety rules. PR creation later needs explicit approval; production deployment/restart later needs separate explicit approval containing APPROVED.

- The user granted a documentation-only exception to the green-base-before-worktree rule for this run: create the planning worktree from the tested a6c0848ef589061d633f1f1d4cf43756a01c9e11 snapshot and write/commit the plan despite the recorded base-gate failure. This exception permits documentation work only; implementation still requires a green supported base, and no additional load-bearing tests are authorized in this run.

### Accepted tradeoffs and residuals
- Unusual failures may require explicit recovery; safe, clearly reported failure is acceptable without automatic recovery from every combination of process failure, cancellation, disk error, and disconnect.
- Unsupported atomic handoff may be unavailable on a platform if it is refused before changing the running session and ordinary supported desktop behavior is preserved.
- Large file splits, wholesale comment cleanup, and replacement of every older registry may remain follow-up work.
- Review limits do not permit known conversation loss, overlapping writers, or another demonstrated shipping-guarantee violation.
- After an approved deployment, use existing structured logs to observe actual handoff/recovery failures and expand implementation when evidence identifies a missing case.

**Goal:** A user can switch a supported conversation between terminal and Fresh Agent, recover or reconnect from another device, and continue the exact conversation with one session writer and truthful, usable failure states.

**Architecture:** Keep the shared server ownership registry, operation/generation fencing, retained runtime claims, and existing handoff REST endpoint. Publish terminal targets through the existing terminal registry method, make Codex stop completion carry writer-confirmation evidence, and make fresh-agent attachment decisions explicit per recovery round. Give recovery requests immutable actions, preserve uncertain ownership until shutdown is proved, and refuse unsupported atomic mode switches before mutation.

**Tech Stack:** Rust 1.96/2021, Axum/Tokio/portable-pty, React 18/Redux Toolkit/TypeScript, Zod, Vitest, Playwright, Cargo, and the existing native Electron acceptance matrix; Node >=22.5.0.

## Global Constraints

### Authorization and evidence

This document is a future execution plan, not permission to execute it. The current run ends after its author self-check and root's documentation commit. No independent plan review, load-bearing validation, integration, implementation, PR creation, merge, or deployment is authorized now. The plan's sample code is a pre-implementation draft; integration changes line numbers, and the source tree supersedes draft code when execution begins. Task intent and the User Request remain authoritative.

The dedicated planning/landing worktree is `/home/dan/code/freshell/.worktrees/b8ke-handoff-stabilization`, branch `the-usual/b8ke-handoff-stabilization`, created from `a6c0848ef589061d633f1f1d4cf43756a01c9e11`. Reuse it for future landing; a third checkout is unnecessary. Preserve `/home/dan/code/freshell/.worktrees/b8ke-handoff` and `the-usual/b8ke-handoff` at reviewed commit `7824b5aab40b761fb500ce87c937b82d12858b69`.

The mandatory planning base gate **failed**, not passed: cloud Vitest completed 6,901 tests and source-runtime passed; the Rust freshagent phase had 903 passes and one failure, `claude::tests::approval_respond_write_failure_keeps_the_pending_entry_and_emits_the_error`, timing out while waiting for `freshAgent.error`. The receipt is `/home/dan/code/freshell/.worktrees/.the-usual-logs/b8ke-handoff-stabilization/reports/base-gate.log`. The user granted only the documentation exception recorded above. Implementation still requires a green supported current-main base. Do not repair that baseline failure in this stabilization branch without separate scope authorization, waive it, or silently substitute a backend.

Source evidence is in `workspace-baseline.md`, `plan-backend.md`, and `plan-client.md` beside that receipt. They are exploration reports, not reproductions or independent findings dispositions. Each supplied finding begins **UNASSESSED**. Reproduce it after integration before changing the implicated behavior; if already absent, retain a behavioral regression and record why it is UNSUBSTANTIATED rather than making a speculative patch.

### Work and test rules

1. All behavior work is confined to the dedicated feature worktree and one eventual feature PR targeting `main`. Refresh clean local main by fast-forward only; never reset, stash, discard, or edit unrelated work. Integration uses a two-parent merge of the reviewed commit, followed by focused repair commits. No whole-file ours/theirs conflict resolution.
2. Keep configured `FRESHELL_VITEST_BACKEND=cloud` and `FRESHELL_E2E_BACKEND=cloud`. `npm run test:vitest -- ...` is a repo-owned **local** passthrough despite that setting; required focused client receipts therefore use `npm run test:cloud -- --config=default ...`. Do not label a local run cloud coverage or switch backends silently.
3. Broad suites wait for the coordinator. Set `FRESHELL_TEST_SUMMARY`, inspect `npm run test:status` when waiting, and never kill another holder. Use `scripts/base-gate.sh test` for base checks. Build/test writers in one worktree run sequentially, with independent `node_modules`, `target`, and `dist`; no links into main or the reviewed checkout.
4. Destructive Rust/process regressions run through `scripts/sandbox-test.sh 'cargo ...'` in disposable Docker namespaces. Browser restart/kill scenarios run **only in configured cloud E2E jobs**, which already execute Playwright inside disposable Docker containers (`scripts/e2e-cloud.sh` and `docker/cloud-run/entrypoint.sh`). Do not double-wrap cloud orchestration in `sandbox-test.sh`: it drops cloud environment and authentication. Native desktop smoke uses ordinary fixture-owned lifecycle operations on disposable native CI workers, not host restart storms.
5. No live server changes. Main's production Rust server on port 3001 and its served `dist/client` are untouched. Scratch servers use existing owned ephemeral-port fixtures; do not copy production `.env` or provider data. Manual scratch operation, if required later, follows `scripts/launch-rust.sh` and repository PID checks. Production deployment/restart later needs separate explicit approval containing `APPROVED`.
6. Use existing structured logs, extending handoff/ownership events with provider, durable session ID, operation/runtime identity, epoch/generation, outcome, and reason where missing. Keep secrets and unnecessary prompt contents out of receipts. Debug logging remains off outside an intentional investigation. No new audit subsystem.
7. Preserve existing behavioral coverage; do not skip or weaken tests to clear a gate. Test assertions must exercise behavior, not match prose/config. Diagnose retries/flakes and fix their synchronization. For every receipt record command, exact commit/tree, nonzero selected/executed count, pass/fail/exit status, and log/artifact location under the ignored run directory. A filtered-out or cloud-skipped spec supplies no evidence.
8. No fresh registry replacement, broad file splitting, provider-supervision rewrite, or historical-comment cleanup. The guarantee concerns session writers, not every unrelated child process. Red/green/refactor is mandatory for reproduced code changes. The review budget is one independent code review and one verification pass in Task 8; no per-task or nested independent reviews.
9. Touched TypeScript relative imports include `.js`. Current main's backend and standalone tools remain Rust-only; MCP builds with `npm run build:tools` and runs `dist/tools/freshell-mcp/server.js`. Playwright uses project `chromium`, not the retired `rust-chromium`/`RUST_ONLY_SPECS` split. `README.md` is the end-user documentation location; this file is an agent plan.

### Intentional platform and recovery policy

Atomic terminal↔Fresh Agent handoff needs evidence that the previous session writer has stopped and that an uncommitted target can be stopped safely. The inspected implementation has Linux recorded-tree confirmation, native direct-child/PTY supervision elsewhere, and no existing non-Linux confirmation of the whole relevant writer set for a terminal mode switch. For this pass, refuse atomic mode switches on Windows/macOS **before** `begin_handoff`, generation changes, stop, spawn, ownership broadcasts, or flavor writes. Keep ordinary create/resume/attach/send/interrupt/exit/kill and native Electron launch working through their existing native lifecycle. OpenCode's shared serve daemon remains alive; its session-level abort/idle confirmation is the session boundary, never daemon death. If a supported runtime unexpectedly loses confirmation after preflight, existing post-stop fenced/timeout recovery remains required.

Use truthful refusal copy: “Switching between terminal and Fresh Agent is unavailable on this platform because Freshell cannot confirm that the previous session writer has stopped. This request did not change the conversation.” Do not claim a session is still running when none exists. Linux still refuses if required runtime evidence is unavailable; missing PID, missing map row, unreadable process data, or a completed watcher alone is not positive shutdown evidence.

Keep `POST /api/sessions/handoff`; add an explicit `action` with values `switch`, `clear-stale-bookkeeping`, and `stop-and-reopen`. Default omitted action to `switch`. A legacy `acknowledgePlatformLimitedRisk:true` request without action maps **only** to `clear-stale-bookkeeping`, regardless of current server state; contradictory explicit action plus legacy flag is BAD_REQUEST. Clear-only never calls kill or start, and cannot turn into a handoff after waiting or losing a race. It may release confirmed-dead/never-started residue, or preserve `ClearedUnverified` with a clear “shutdown unconfirmed; replacement blocked” result. Explicit “Stop and reopen” uses the existing guarded stop-and-confirm continuation and may start only after positive confirmation. User acknowledgment never substitutes for proof. Ordinary Reopen retains its busy/waiting/starting gates; recovery identity resolution is independent of those gates.

## File Responsibilities and Existing Interfaces

Line references below point to reviewed `7824b5aab` unless stated otherwise; use the named symbol after integration.

| Files | Responsibility and planned changes |
|---|---|
| `crates/freshell-freshagent/src/session_handoff.rs`, `session_handoff/tests.rs` | Existing coordinator/REST parser; terminal publication dispatch, platform preflight, explicit recovery action, and composition regressions. |
| `crates/freshell-terminal/src/registry.rs`, `pty.rs` | Preserve native terminal supervision and `commit_session_ref_ownership`; only adjust evidence at the identified handoff boundary if the reproduction needs it. No new registry. |
| `crates/freshell-freshagent/src/codex.rs`, `session_lease.rs`, inline `ownership_lane` in `lib.rs` | Codex watcher confirmation result, retained stop evidence, and local positive-death/unknown distinction. Preserve ordinary native teardown. |
| `crates/freshell-ownership/src/lib.rs` | Existing exact-ticket fenced release and cleared-unverified transition; add only action-contract assertions/necessary guarded transition correction. |
| `crates/freshell-freshagent/src/opencode_ws.rs` | One locked placeholder-versus-materialized attach classification; observation-only placeholder snapshots and guarded durable bridge attachment. |
| `src/lib/api.ts`, `src/lib/session-handoff.ts` | Explicit REST action/result types; shared canonical recovery identity; separate clear-only runner and awaited response guards. |
| `src/components/SessionHandoffErrorBanner.tsx`, `src/components/fresh-agent/FreshAgentView.tsx` | Truthful accessible recovery actions/results; round-scoped attachment decisions, retry cancellation, ready ordering. |
| `src/lib/ws-client.ts` | Suppress queued stale fresh-agent attach replay at reconnect when the regression demonstrates the bypass; views/reconcile decide the replacement attach. |
| `test/unit/client/lib/session-handoff.test.ts`, `components/SessionHandoffErrorBanner.test.tsx`, `components/fresh-agent/FreshAgentView.test.tsx`, `lib/ws-client.test.ts` | Real runner/component/transport regressions; keep existing helper ownership and fake-timer cleanup. All paths are under `test/unit/client/`. |
| `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs` | Opt-in genuine owned session-writer child with readiness/evidence handshake, extending existing native-child behavior. |
| `test/e2e-browser/specs/handoff-two-device-rust.spec.ts`, `fixtures/codex-dual-role.ts`, `fixtures/opencode-dual-role.ts` | Complete real server/SPA switch/reconnect/restart/recovery flows using existing dual-role provider fixtures. Preserve current-main Codex in-process ESM dispatch. |
| `test/integration/electron/checkout-free-runtime.test.ts` | Native packaged-runtime smoke for ordinary lifecycle and changed platform policy, using relocated runtime and owned temp home. |
| `README.md` | Concise user explanation of supported switches, clear-only versus stop/reopen, and platform refusal. Update `docs/index.html` only if final UI changes materially alter the default experience. |
| Actual merge conflicts and generated protocol outputs | Integration-only changes listed in Task 1. Regenerate with existing tooling only when the merged protocol requires it. |

Existing central interfaces to reuse:

```rust
// freshell-terminal/src/registry.rs
pub fn commit_session_ref_ownership(
    &self, locator: &SessionLocator, operation_id: &str,
    generation: u64, terminal_id: &str,
) -> freshell_ownership::CommitOutcome;
pub fn retained_ownership_fence(&self, terminal_id: &str) -> Option<(u64, u64)>;

// freshell-freshagent/src/session_handoff.rs
fn commit_live_target_with_release_evidence(
    &self, req: &HandoffRequest, operation_id: &str,
    generation: u64, owner: &OwnerIdentity,
) -> CommitOutcome;

// freshell-ownership/src/lib.rs: mutation is conditional on the exact ticket
pub fn release_fenced(
    &self, provider: &str, session_id: &str,
    operation_id: &str, generation: u64,
) -> CommitOutcome;
```

## Acceptance Map and Finding Dispositions

| Guarantee | Production outcome | Required evidence/tasks |
|---|---|---|
| G1 — exact conversation | Durable provider-qualified ID, transcript marker, and subsequent turn survive both supported switch directions and recovery. No fresh blank session substituted. | Existing provider create/resume tests; Tasks 2–6 preserve canonical IDs; Task 7 Codex/OpenCode round trips and restart flow. |
| G2 — one session writer | Target start is gated on confirmed prior-writer stop; unknown evidence blocks; clear-only never starts/stops; unsupported platforms refuse before mutation. | Task 3 real owned writer + continuation tests; Task 4 delayed clear/live/unknown tests; native pre-stop refusal/supported Linux smoke. |
| G3 — live means attachable, exit releases | Published target is alive and has release bookkeeping; killed/naturally exited target relinquishes exact claim; placeholder attach is observation-only. | Task 2 PTY commit/exit/race; Task 3 Codex natural exit/kill; Task 6 actual attach frames; Task 7 native lifecycle. |
| G4 — convergence and request ordering | Both devices adopt committed owner after switches/reconnects; same-session restart uses new fence; obsolete callbacks cannot undo newer operations. | Task 4 stale clear; Task 5 attempt/transport tests; Task 7 two-device both directions, offline reconnect, mounted restart. Preserve existing competing-operation tests. |
| G5 — understandable recovery | Starting/busy Force clear sends once, shows truthful result, and leaves replacement blocked until proof; supported explicit stop/reopen works; failures preserve identity. | Task 4 API/runner/UI behavior, failed-start/interrupted-stop tests; Task 7 recovery flow/native smoke; README and structured logs. |

Update the following rows in the ignored execution receipt, not by rewriting plan code after implementation:

| ID | Supplied source-review finding | Current disposition | Reproduction and clearing evidence |
|---|---|---|---|
| F1 | Terminal target bypasses retained release claim. | UNASSESSED | Task 2 real runner handoff, retained fence, actual exit/kill, and successful same-session reclaim. |
| F2 | Codex stop reports complete while an owned provider writer can still write. | UNASSESSED | Task 3 acknowledged owned writer writes session data, survives old stop, then is confirmed stopped before replacement after repair. An arbitrary tagged sleeper is insufficient. |
| F3 | Same-session recovery reuses obsolete attachment epoch/generation. | UNASSESSED | Task 5 real store/view, same ID with new reconcile round/boot, actual sent attach pair, and browser restart. |
| F4 | Starting/busy Force clear silently makes no request. | UNASSESSED | Task 4 original runner red test, explicit recovery green test, accessible visible result, and server action invariance. |
| F5 | OpenCode placeholder emits repeated ordinary-path reservation errors. | UNASSESSED | Task 6 strengthen actual handler test; Task 7 observed wire frames and exactly one materialization. |

Each F1–F5 must finish CLEARED or UNSUBSTANTIATED with evidence. They cannot be deferred as optional while demonstrated to violate a guarantee. Other review findings use the Scope rule below. Readiness is blocked by any failed/pending acceptance row, unproved native platform behavior, or demonstrated guarantee violation. Safe explicit failure is acceptable; pretending uncertainty is success is not.

---

### Task 1: Integrate the reviewed architecture with a green current-main base

**Files:**
- Modify: actual merge paths, especially `crates/freshell-freshagent/src/{claude.rs,codex.rs,layout_store_tests.rs,lib.rs}`, `crates/freshell-opencode/src/{lib.rs,serve.rs}`, `crates/freshell-protocol/src/lib.rs`, `crates/freshell-protocol/tests/inventory.rs`, `crates/freshell-server/src/{main.rs,network.rs}`, `crates/freshell-ws/tests/codex_sidecar_reattach_e2e.rs`, `src/components/fresh-agent/FreshAgentView.tsx`, `src/store/persistMiddleware.ts`, `test/e2e-browser/playwright.config.ts`, `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`, `test/unit/client/components/panes/PaneContainer.test.tsx`, `test/unit/client/fresh-agent-ws.test.ts`.
- Preserve live test location: `test/unit/provider-fixtures/fake-opencode-fixture.test.ts` and `test/support/stop-fixture-process.ts`; do not resurrect retired `test/unit/server/fake-opencode-fixture.test.ts`.
- Test: existing tests crossing every actual and semantic conflict, listed below.

**Interfaces:**
- Consumes: green tested `origin/main`, reviewed commit `7824b5aab40b761fb500ce87c937b82d12858b69`, and the existing planning commit.
- Produces: one two-parent integration commit on `the-usual/b8ke-handoff-stabilization` with all conflicts resolved, unchanged original branch, and current-main command/test semantics.

- [ ] **Step 1: Establish the executable precondition; preserve behavioral tests.**

This setup/integration task does not invent a failing product test: retain both sides' behavior tests before changing conflict code. In a future authorized execution, ensure main and the planning worktree are clean, fetch, and fast-forward main. If main cannot fast-forward or has unrelated dirt, stop for explicit resolution. Run from `/home/dan/code/freshell`:

```bash
git status --short --branch
git fetch origin
git merge --ff-only origin/main
FRESHELL_TEST_SUMMARY='b8ke stabilization: implementation green base' scripts/base-gate.sh test
git rev-parse origin/main
```

Expected: clean main, successful fast-forward (or already current), all base phases PASS, exact tested SHA recorded. A failed gate pauses implementation before integration; the documentation exception cannot waive it.

- [ ] **Step 2: Merge into the existing dedicated landing worktree and inspect the conflict failures.**

Run from `/home/dan/code/freshell/.worktrees/b8ke-handoff-stabilization`:

```bash
git status --short --branch
git merge --no-ff --no-edit origin/main
git merge --no-ff --no-commit 7824b5aab40b761fb500ce87c937b82d12858b69
git diff --name-only --diff-filter=U
```

Expected: first merge brings any newer tested main into the documentation branch; second merge may exit nonzero with content conflicts. This is an integration conflict receipt, not a product red test. Do not abort/discard automatically. The original worktree remains untouched. Resolve the actual conflict set, which may differ from the 17-path preview above.

- [ ] **Step 3: Resolve every conflict semantically before any finding repair.**

Read each side and its tests. Preserve these current-main behaviors in the merged source and tests, including files Git auto-merges:

1. Rust-only server/tool paths, current `chromium` project/default fixtures, current-main OpenCode fixture behavior and cleanup helper; no restored legacy Node server or removed OpenCode placeholder DB repair. Adapt the handoff spec's retired `TestServerInfo` import to current `E2eServerInfo` from `test/e2e-browser/helpers/server-fixture-support.ts`.
2. Terminal atomic `attach_with_geometry`/`attach_to_shared`, one first geometry claimant and geometry-neutral secondary attaches; retain `simultaneous_first_geometry_attaches_have_one_claimant` and `crates/freshell-ws/tests/attach_viewport_resize.rs`.
3. Codex `CodexConsumerRuntime`, accepted-before-immediate-completion, stale/idless/overlapping completion handling, live model/effort configure, and no-chime exit self-heal. Carry new fields into merged fixtures.
4. Claude/OpenCode model and `session.metadata` propagation, model-capability/limit catalogs, task delegation, tool/turn errors, reasoning duration, retry/subtask items, compact diagnostics, and Rust diff/exec routes. Preserve newer generation-fenced refresh behavior.
5. Disappeared-cwd restore repair while interactive creates still report bad cwd; server-owned machine/device identity, unknown-device rejection, per-window persistence/adoption, union tab ordering, and rollback-marker restore behavior.
6. Focus-neutral agent creates/splits, ownership-gated focus adoption and focus epochs, off-DOM screenshots, shared `sendSuppressedAwareFreshAgentFrame`, busy-state snapshot protection and content-status mirror, dismissible restore errors, live metadata including explicit-null effort, transcript/delegation preferences, and protection against old shell output reaching another conversation.
7. Cloud artifact commit stamping, origin policy transport coverage, protocol serialization behavior, and current fresh-agent contracts. If schema outputs need refreshing after source merge, run `npm run contract:generate` and retain the runtime serialization tests.

- [ ] **Step 4: Verify the integrated source compiles.**

```bash
git diff --name-only --diff-filter=U
git diff --check
npm ci --no-audit --no-fund
npm run prepare:claude-sidecar
npm run typecheck
cargo check --workspace --locked
```

Expected: no unmerged paths, no whitespace errors, successful dependency setup/typecheck/Cargo check. Resolve conflicts fully before addressing F1–F5.

- [ ] **Step 5: Refactor while green.**

Remove only duplicate imports/branches introduced by conflict resolution. Keep current-main shared suppression/configure helpers and the reviewed ownership interfaces; do not use integration as a reason to split large files or rewrite comments.

- [ ] **Step 6: Run impacted-test verification.**

The merged protocol, server wiring, runtime lifecycles, layout, and client persistence span the codebase, so this checkpoint needs the full supported suite plus targeted conflict evidence:

```bash
FRESHELL_TEST_SUMMARY='b8ke stabilization: merged baseline' npm test
scripts/sandbox-test.sh 'cargo test -p freshell-ws --locked --test attach_viewport_resize'
npm run test:cloud -- --config=default test/unit/provider-fixtures/fake-opencode-fixture.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/fresh-agent-ws.test.ts
```

Expected: all selected tests pass, with nonzero counts. If a test reveals one of the five supplied findings, record that exact reproduction and keep the integration checkpoint accurately described; do not declare it green or lose the test. Resolve unrelated integration regressions before moving on. Product red tests deliberately added in later tasks are not present yet.

- [ ] **Step 7: Commit the complete integration.**

Inspect `git status --short` and `git diff --cached --stat`; the index must contain only the reviewed merge and its conflict resolutions. Because this dedicated tree contains only the merge, stage its complete path set:

```bash
git add --all
git diff --cached --check
git commit -m "merge: integrate reviewed session handoff with current main"
git show --no-patch --format='%H %P'
git -C /home/dan/code/freshell/.worktrees/b8ke-handoff rev-parse HEAD
```

Expected: integration commit has two parents; original reviewed HEAD is still `7824b5aab40b761fb500ce87c937b82d12858b69`. Record integration SHA and conflict-preservation checklist. Subsequent tasks repair this integrated result.

### Task 2: Publish terminal targets with their real release claim

**Files:**
- Modify: `crates/freshell-freshagent/src/session_handoff.rs:3868` (`commit_live_target_with_release_evidence`).
- Test: `crates/freshell-freshagent/src/session_handoff/tests.rs:985`, terminal-exit and staged-flavor tests in that file.
- Reuse unchanged: `crates/freshell-terminal/src/registry.rs:2727` (`commit_session_ref_ownership`).

**Interfaces:**
- Consumes: existing `SessionLocator`, registry publication method, `CommitOutcome`, runner rig and staged flavor writer.
- Produces: terminal publication atomically establishes liveness and retained `(epoch,generation)` release evidence; existing Fresh Agent publication interface stays unchanged.

- [ ] **Step 1: Add the failing behavioral regression at the actual bypass.**

Extend `handoff_to_terminal_reaps_sidecar_before_target_start_and_commits_owner` after obtaining `terminal_id`, keeping every existing assertion. Add this exact retained-claim assertion:

```rust
assert_eq!(
    rig.registry.retained_ownership_fence(&terminal_id),
    Some((rig.ownership.boot_epoch(), rig.ownership.observe("claude", &sid).generation)),
    "handoff publication must retain the claim that terminal exit releases",
);
```

Add sibling `a_handoff_terminal_target_retains_its_claim_and_releases_on_exit` using the same `ENV_LOCK`, `CLAUDE_ENV_LOCK`, `FakeSidecarEnv`, `build_rig`, `establish_fresh_claude_owner`, and `handoff_req_terminal`. After successful actual handoff, kill only that terminal with `rig.registry.kill(&terminal_id)`, await `OwnershipState::Vacant` using `await_cond`, then perform another same-ID handoff/resume and assert its committed locator is still `sid`. This must exercise release, not merely inspect a private map.

Add `a_handoff_terminal_target_releases_after_natural_exit` by replacing that test's `sleeper_cli_spec` command with a test-owned script that waits for a file in its `TempDir`, then exits. Create the file only after commit; await the real PTY exit callback and Vacant/reclaim. Extend `a_handoff_target_exiting_before_the_commit_never_publishes_live` with a terminal-target case: park existing releasable `FlavorWrite::stage`, stop the watched target, release stage, and assert typed failure, no Live dead owner, no leaked claim, and same-session retry succeeds.

- [ ] **Step 2: Run and record the intended red.**

```bash
scripts/sandbox-test.sh 'cargo test -p freshell-freshagent --locked --lib session_handoff::tests::handoff_to_terminal_reaps_sidecar_before_target_start_and_commits_owner -- --exact'
scripts/sandbox-test.sh 'cargo test -p freshell-freshagent --locked --lib session_handoff::tests::a_handoff_terminal_target_retains_its_claim_and_releases_on_exit -- --exact'
```

Expected before repair: retained claim is absent and/or ownership fails to become Vacant after the actual terminal exit. If neither failure occurs, inspect the integrated publication path and record F1 UNSUBSTANTIATED with the behavioral receipt; do not apply an unnecessary patch.

- [ ] **Step 3: Replace the terminal publication arm with the existing authority.**

Replace the non-FreshAgent direct `self.ownership.commit_live` arm with:

```rust
if owner.kind == RuntimeOwnerKind::Terminal {
    let Some(terminal_id) = owner.terminal_id.as_deref() else {
        return CommitOutcome::ForeignOperation;
    };
    return self.registry.commit_session_ref_ownership(
        &SessionLocator {
            provider: req.provider.clone(),
            session_id: req.session_id.clone(),
        },
        operation_id,
        generation,
        terminal_id,
    );
}
```

Use the existing `SessionLocator` import or add its actual crate import as used elsewhere in this module. Keep the Fresh Agent stamps-lock path. Do not perform a second commit or insert a retained claim afterward. Build response/broadcast owner identity from the committed registry observation, retaining the registry's actual terminal ID/PID. A missing/dead terminal goes through the existing failed-publication cleanup and typed failure.

- [ ] **Step 4: Run the focused regressions.**

```bash
scripts/sandbox-test.sh 'cargo test -p freshell-freshagent --locked --lib session_handoff::tests::a_handoff_terminal_target'
scripts/sandbox-test.sh 'cargo test -p freshell-freshagent --locked --lib session_handoff::tests::a_handoff_target_exiting_before_the_commit_never_publishes_live -- --exact'
```

Expected: all selected terminal release/natural-exit/precommit-exit cases PASS, nonzero selected count.

- [ ] **Step 5: Refactor while green.**

Make the runner dispatch each target kind to its existing publication authority. Remove duplicate terminal publication logic only; retain Fresh Agent stamp locking and delayed-generation release checks.

- [ ] **Step 6: Run impacted-test verification.**

```bash
scripts/sandbox-test.sh 'cargo test -p freshell-freshagent --locked --lib session_handoff::tests::'
scripts/sandbox-test.sh 'cargo test -p freshell-terminal --locked'
scripts/sandbox-test.sh 'cargo test -p freshell-ws --locked --test cross_kind_liveness'
```

Expected: PASS including restored-prior release, rekeys, delayed old releases, and cross-kind attachment. Record F1's disposition with red/green/exit/reclaim evidence.

- [ ] **Step 7: Commit the task.**

```bash
git add crates/freshell-freshagent/src/session_handoff.rs crates/freshell-freshagent/src/session_handoff/tests.rs
git commit -m "fix: retain terminal ownership when publishing handoff targets"
```

### Task 3: Confirm Codex writer shutdown and refuse unsupported atomic switches before mutation

**Files:**
- Modify: `crates/freshell-freshagent/src/codex.rs:348,661,1178,3989,7957`, `session_lease.rs:146,166,222`, inline `ownership_lane` in `lib.rs:924`, `session_handoff.rs:468,3006,4112`.
- Modify/test: `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs` and existing Rust tests in the preceding modules.
- Test: `crates/freshell-freshagent/src/session_handoff/tests.rs`; preserve `crates/freshell-codex/src/sidecar_sweep.rs` identity/reuse tests.

**Interfaces:**
- Consumes: `CondemnedRuntimeIdentity`, `record_condemned_runtime_identity`, `kill_and_confirm_recorded_tree_dead`, existing `StopResult::{Reaped,AlreadyGone,NotConfirmed,PlatformLimited}`, and exact ownership stamps/tickets.
- Produces: Codex `spawn_exit_watcher(...) -> JoinHandle<StopResult>` and `CodexSession::watcher: JoinHandle<StopResult>`; callers cannot confuse watcher completion with writer shutdown. Add private process-evidence distinctions only in the repaired confirmation paths. Add `HandoffTestHooks::force_unsupported_preflight: AtomicBool` for deterministic before-stop testing, default false and separate from existing post-stop `force_platform_limited`.

- [ ] **Step 1: Reproduce a surviving owned writer, with positive readiness.**

Extend the existing `fake-native-child` branch and `spawnNativeChild` behavior in `fake-app-server.mjs`, rather than inventing a parallel provider. Add opt-in behavior fields `nativeWriterSessionFile` and `nativeWriterReadyFile`, passed to the child's `FAKE_CODEX_NATIVE_WRITER_SESSION_FILE` and `FAKE_CODEX_NATIVE_WRITER_READY_FILE`. These must point into the test's isolated provider home, and require the existing durable-write opt-in. Import `node:net`. When both fields are present, the child installs the existing SIGTERM handler first and executes this writer branch:

```js
const writerPath = process.env.FAKE_CODEX_NATIVE_WRITER_SESSION_FILE
const readyPath = process.env.FAKE_CODEX_NATIVE_WRITER_READY_FILE
if (writerPath && readyPath) {
  if (process.env.FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES !== '1') {
    throw new Error('owned writer fixture requires explicit durable writes')
  }
  fs.mkdirSync(path.dirname(writerPath), { recursive: true })
  const lock = net.createServer()
  await new Promise((resolve, reject) => {
    lock.once('error', reject)
    lock.listen(0, '127.0.0.1', resolve)
  })
  let sequence = 0
  const write = () => fs.appendFileSync(writerPath, JSON.stringify({
    type: 'event_msg',
    timestamp: new Date().toISOString(),
    payload: { type: 'agent_message', message: `owned writer ${++sequence}` },
  }) + '\n')
  write()
  const address = lock.address()
  if (!address || typeof address === 'string') throw new Error('writer lock unavailable')
  fs.writeFileSync(readyPath, JSON.stringify({ pid: process.pid, port: address.port }))
  setInterval(write, 20)
}
```

Keep the existing child keepalive after this branch. The session file is the fixture's actual session-specific rollout, with its metadata header established by the existing fake provider setup. The port is only an OS-owned exclusion witness; actual repeated writes establish that this process is a session writer. No static environment tag alone proves the failure. For `exitAfterSpawningNative`, wait for this optional ready file before exiting so the reparented-writer case has an acknowledged start. Bound that wait and surface setup failure; no arbitrary sleep as a readiness substitute.

Add `codex::tests::kill_for_handoff_confirms_the_owned_writer_stopped_before_reporting_reaped` using the module's real fake-app-server setup (`ENV_LOCK`/existing isolated environment guard, `create_real_fake_session`, explicit isolated `CODEX_HOME`, behavior JSON, actual create/resume), not a hand-inserted unrelated sleeper. Enable `spawnNativeChild`, `nativeChildIgnoresSigterm`, the two writer paths, and existing durable-write opt-in. Await ready JSON, confirm at least two appended session events, then call real `kill_for_handoff`. On `Reaped`, immediately assert the recorded PID incarnation is gone, binding the recorded loopback port succeeds, and the session file no longer grows. A before-repair survivor must remain a blocker even if the direct sidecar is gone.

Add these finite companion cases in the same module, using the same opt-in fixture: direct sidecar exits while writer remains; writer becomes reparented after acknowledged startup; watcher join fails; stop is cancelled with condemned evidence retained; successful explicit kill releases and same-session resume works. At `session_lease` helper level inject a denied/malformed process observation for a **recorded owned candidate** and assert unconfirmed, then inject positive exit and assert confirmed. Preserve existing PID reuse tests and do not interpret unreadable unrelated system processes as owned candidates.

Add runner test `unsupported_atomic_handoff_preserves_the_running_session`: declare/default the test-only `force_unsupported_preflight` field first without wiring production behavior, then exercise both terminal→fresh-agent and fresh-agent→terminal with that flag; compare owner snapshot/generation, retained claim, PID/native handle, flavor-write count, and target-start hooks before/after, then send another message/input through the unchanged prior. The red must observe an unwanted transition, not fail to compile for a missing hook. Keep the existing post-stop platform-limited/timeout tests.

- [ ] **Step 2: Run and record the intended red.**

```bash
scripts/sandbox-test.sh 'cargo test -p freshell-freshagent --locked --lib codex::tests::kill_for_handoff_confirms_the_owned_writer_stopped_before_reporting_reaped -- --exact'
scripts/sandbox-test.sh 'cargo test -p freshell-freshagent --locked --lib session_lease::tests::'
scripts/sandbox-test.sh 'cargo test -p freshell-freshagent --locked --lib session_handoff::tests::unsupported_atomic_handoff_preserves_the_running_session -- --exact'
```

Expected: old stop may return `Reaped` while the acknowledged writer can still append/holds its witness; unknown evidence may be treated as gone; preflight test detects mutation before refusal. A fixture failure to start/write is not a reproduction. If integrated Codex already confirms this writer, record the trace and F2 UNSUBSTANTIATED rather than broadening to unrelated children.

- [ ] **Step 3: Implement the single confirmed-stop boundary and preflight.**

Make these precise edits:

1. Before Codex close/signal/map removal can lose ancestry, capture the existing condemned identity and known owned candidates. Retain it until positive confirmation. The watcher owns the shutdown result: direct-child wait, existing quiet-deadman disarm and exit status, then bounded confirmed recorded-writer cleanup. Change its return and stored handle to `JoinHandle<StopResult>`. `kill_for_handoff`, `handle_kill`, `shutdown`, and natural exit all consume that result. Preserve biased requested-kill-first behavior. `JoinError`, failed wait, missing map with recorded prior, and incomplete evidence map to existing fenced/unconfirmed continuation, never `Reaped`.
2. On Linux the watcher returns `Reaped` only after direct wait plus relevant recorded writer confirmation. An unfinished bounded confirmation returns `NotConfirmed` carrying the existing continuation; retain condemned identity and operation fence until it resolves true. An abandoned continuation is handled by the existing replacement probe. Mark a lost direct sidecar exited/unattachable promptly with no completion chime; do not leave a falsely live runtime while waiting for a descendant. Release ownership/binding only under exact confirmed release evidence. `AlreadyGone` means known never-started or previously confirmed gone, not merely absent from a HashMap.
3. Keep native non-Linux ordinary teardown bounded through existing `Child`/`ChildKiller`/wait behavior. Do not run Linux `/proc` loops there or newly wedge desktop close/shutdown. Atomic handoff is pre-refused on those platforms. Any ordinary lifecycle state that remains uncertain must be visibly unavailable/fenced against replacement; ordinary confirmed direct-runtime shutdown and resume must still pass native smoke. This distinction concerns the actual writer set of that runtime, not a blanket requirement to kill every inherited child.
4. Add a local evidence enum in `session_lease.rs` and preserve unknown capture explicitly:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecordedProcessEvidence {
    SameIncarnation,
    Gone,
    Unavailable,
}
```

Have the confirmation-only probe take the recorded PID/start time and return this enum. Positive native wait, ESRCH, readable exited/zombie state, or readable different start time establishes `Gone`; permission/parse/IO error establishes `Unavailable`. Add a capture-completeness field to `CondemnedRuntimeIdentity` only if needed to retain an unreadable **owned** candidate rather than filtering it out. Confirmed-tree sweeping removes `Gone`, retains/escalates `SameIncarnation` through existing identity-safe signaling, and returns unconfirmed for `Unavailable`. Do not mass-convert unrelated historical process helpers. At `ownership_lane::partial_pid_confirmed_dead` use positive exit evidence; `.is_none()` from a lossy probe is insufficient. At handoff terminal missing-row/missing-PID branches, distinguish the existing never-spawned watch from a recorded/known prior; only the former is proof of no writer.
5. In `SessionHandoffRunner::run`, immediately after `validate_handoff_target` and before generating/claiming an operation, reject unsupported atomic actions with the typed `PLATFORM_LIMITED` response and the truthful copy in Global Constraints. Initially the concrete capability is Linux, with the test hook forcing false. Task 4's clear-only action is dispatched before this atomic-switch preflight because it never stops or starts. For supported Linux, retain runtime-specific evidence checks before stop; if evidence cannot establish capability, refuse before process/flavor mutation. Preserve stale fence validation. Do not add Windows Job Objects or a new supervisor in this pass.
6. Extend existing JSONL events at refusal/confirmation boundaries with `outcome` and an unavailable-evidence reason; keep provider/session/operation/runtime/epoch/generation. Codex's void best-effort sweep may remain for unrelated maintenance, but none of the repaired stop/publication callers may use its completion as proof.

- [ ] **Step 4: Run the focused tests.**

```bash
scripts/sandbox-test.sh 'cargo test -p freshell-freshagent --locked --lib codex::tests::kill_for_handoff_confirms_the_owned_writer_stopped_before_reporting_reaped -- --exact'
scripts/sandbox-test.sh 'cargo test -p freshell-freshagent --locked --lib session_lease::tests::'
scripts/sandbox-test.sh 'cargo test -p freshell-freshagent --locked --lib session_handoff::tests::unsupported_atomic_handoff_preserves_the_running_session -- --exact'
```

Expected: PASS; a `Reaped` result always follows actual writer death, uncertainty preserves the fence, and preflight refuses without changing the prior session. Capture process/file/port/structured-event evidence.

- [ ] **Step 5: Refactor while green.**

Consolidate Codex handoff/kill/natural-exit/shutdown onto the returned confirmation result instead of duplicating release decisions. Keep the existing publication authority from Task 2 and the existing condemned continuation machinery. Remove only duplicate proof/release code exposed by these changes. Add one runner composition test proving `TargetSpawnAttempted` cannot occur while the old fixture writer retains its port or can write; do not duplicate every Claude cancellation permutation.

- [ ] **Step 6: Run impacted-test verification.**

```bash
scripts/sandbox-test.sh 'cargo test -p freshell-freshagent --locked --lib codex::tests::'
scripts/sandbox-test.sh 'cargo test -p freshell-freshagent --locked --lib session_handoff::tests::'
scripts/sandbox-test.sh 'cargo test -p freshell-freshagent --locked --lib session_lease::tests::'
scripts/sandbox-test.sh 'cargo test -p freshell-codex --locked sidecar_sweep'
scripts/sandbox-test.sh 'cargo test -p freshell-ws --locked --test codex_sidecar_reattach_e2e'
```

Expected: PASS, including accepted-before-completion, idless completion, configure, unknown never-owned kill success, durable-close-failure preserving live state, no-chime natural exit, explicit kill release/recreate, watcher failure, detached reap timeout, and aborted handoff repair. Native acceptance remains a Task 7 readiness obligation, not an inferred result from Linux tests. Record F2's disposition.

- [ ] **Step 7: Commit the task.**

```bash
git add crates/freshell-freshagent/src/codex.rs crates/freshell-freshagent/src/session_lease.rs crates/freshell-freshagent/src/lib.rs crates/freshell-freshagent/src/session_handoff.rs crates/freshell-freshagent/src/session_handoff/tests.rs test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs
git commit -m "fix: require confirmed writer shutdown before session handoff"
```

### Task 4: Give Force clear an immutable clear-only contract and working UI

**Files:**
- Modify: `crates/freshell-freshagent/src/session_handoff.rs:146,468,4458`, `crates/freshell-ownership/src/lib.rs:1794,2948,3081` only as required for guarded transition semantics.
- Modify: `src/lib/api.ts:705,778,805`, `src/lib/session-handoff.ts:42,141`, `src/components/SessionHandoffErrorBanner.tsx`, `src/components/fresh-agent/FreshAgentView.tsx` (`FencedOwnerRecoveryActions`).
- Test: `crates/freshell-freshagent/src/session_handoff/tests.rs`, ownership module tests, `test/unit/client/lib/session-handoff.test.ts`, `test/unit/client/components/SessionHandoffErrorBanner.test.tsx`, `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`, `test/unit/client/lib/session-flavor-reopen.test.ts`.

**Interfaces:**
- Consumes: Task 3 positive/unknown confirmation, canonical pane selectors, current API error handling and exact observed fence.
- Produces: `HandoffAction::{Switch,ClearStaleBookkeeping,StopAndReopen}` on Rust `HandoffRequest`; wire values `switch`, `clear-stale-bookkeeping`, `stop-and-reopen`; and:

```ts
export async function runPaneSessionRecovery(
  appStore: AppStore,
  options: { tabId: string; paneId: string; action: 'clear-stale-bookkeeping' },
): Promise<boolean>
// Existing handoff options replace acknowledgePlatformLimitedRisk with:
// action?: 'switch' | 'stop-and-reopen'
```

`SessionHandoffRequestBody` retains its existing identity/target fields and adds the explicit action. Clear success retains existing `cleared` reason, `operationId`, and `generation`, and adds `shutdownConfirmed: boolean`; it never has an `owner`. Failure remains the existing typed result. Default a missing `shutdownConfirmed` on an older clear response to false so no client infers death from absence.

- [ ] **Step 1: Reproduce the silent request loss before changing the runner.**

In `session-handoff.test.ts`, extend the existing acknowledged Force clear invocation using `buildStore`, `seedRekeyedPane`, and the real `runPaneSessionHandoff` with only HTTP mocked. Parameterize pane statuses `creating`, `starting`, and a same-ID session record with `setSessionStatus(... status: 'running')`. Assert exactly one clear request and a visible/result state. Keep the paired ordinary Reopen test asserting zero requests while busy/waiting/starting. The Force clear assertion must fail at zero API calls before the runner split.

At the server add exact-action behavior cases through the existing handoff router using JSON request bodies, so the pre-repair tests compile before `HandoffAction` exists: clear on stale-start/stale-stop/platform-limited fence; delayed clear whose observed generation is obsolete after another operation commits; clear on Vacant; clear on Live; clear with absent PID/map but recorded prior; positive-dead residue; and explicit stop/reopen with an owned live prior. Snapshot target-start hooks, process writes, owner generation, and flavor writes before each action. Clear must never kill/start/flip flavor. Unknown may clear stale operation bookkeeping into `ClearedUnverified`, but the replacement remains blocked. Positive-dead/never-started proof may conditionally release the exact fence.

- [ ] **Step 2: Run the focused red.**

```bash
npm run test:cloud -- --config=default test/unit/client/lib/session-handoff.test.ts
scripts/sandbox-test.sh 'cargo test -p freshell-freshagent --locked --lib session_handoff::tests::'
```

Expected: the new starting/busy clear cases fail due to no request; old boolean meaning can fail the delayed-clear/action assertions. Record F4 separately from any additional demonstrated clear/shutdown defect.

- [ ] **Step 3: Implement explicit dispatch and recovery identity.**

Use this Rust enum, with parsing in the existing `handoff_handler` before `spawn_handoff`:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HandoffAction {
    Switch,
    ClearStaleBookkeeping,
    StopAndReopen,
}
```

Precise control-flow patch:

1. Parse action once. Omitted action plus legacy acknowledgment true is ClearStaleBookkeeping; omitted action otherwise is Switch. Explicit supported strings map to their variants; unknown values or contradictory legacy acknowledgment are BAD_REQUEST. Add `action` to every internal request literal (default Switch except explicit recovery tests). Remove the boolean as internal permission to reinterpret a request after examining ownership state.
2. In `run`, after auth/identity/target/fence validation, dispatch ClearStaleBookkeeping to a dedicated **method on the same runner**, `async fn clear_stale_bookkeeping(&self, req: &HandoffRequest) -> Value`, and return its result directly. It requires the current complete observed pair, observes the fenced ticket and its retained evidence, performs no process signal/start/flavor mutation, and uses the existing exact-ticket `release_fenced` only for positive dead/never-started evidence. Otherwise use the existing `force_release_platform_limited` transition to preserve prior evidence as ClearedUnverified; that method's historical name need not trigger broad renaming. Return `shutdownConfirmed:false` and a replacement-blocked message. A Live/in-progress/newer state returns a typed refusal. Vacant returns the typed `SESSION_NOT_FOUND` failure with “There is no stale bookkeeping to clear. No reopen was started.”; it neither claims shutdown nor starts a handoff. Never enter `begin_handoff` on this branch.
3. Switch uses ordinary current behavior plus Task 3 preflight; it cannot start through ClearedUnverified. StopAndReopen is the separately labeled explicit recovery operation. Reuse the existing atomic `begin_handoff_acknowledged_cleared_unverified` claim under the current observed pair, retain prior evidence in the claim, and drive Task 3's confirmed stop before any target start. Extend it to the existing recoverable fenced reasons only if necessary for the real UI path, under the same exact ticket; do not create an unguarded Vacant interval. Missing prior evidence returns typed blocked/unconfirmed, not AlreadyGone. Keep post-stop uncertainty and detached completion behavior.
4. Extract a private identity lookup in `session-handoff.ts` from `resolveReopenContext`: resolve tab, terminal/fresh-agent content, canonical provider+session ID, target metadata, route cwd, and observed fence independently of `activity.isBusy`. Keep activity and waiting checks inside the ordinary handoff entry. `runPaneSessionRecovery` sends one `requestSessionHandoff({...identityFields, action:'clear-stale-bookkeeping'})` regardless of creating/starting/busy status when canonical identity exists; it does not call the ordinary runner or recurse. Missing identity dispatches a visible unavailable error. Preserve existing backoff.
5. Before applying any awaited recovery result **or caught network error**, re-resolve pane identity and require the same provider-qualified canonical session, tab, pane, and create-request identity. A response for a replaced pane is ignored. Clear result never changes pane kind/session content or calls start. It displays either “Stale bookkeeping cleared. No reopen was started.” with confirmed shutdown, or “Stale bookkeeping cleared. Writer shutdown is unconfirmed; starting a replacement remains blocked.” with explicit Stop and reopen only when supported. Refusal/network failure shows its actual reason and a working Retry/clear action. Unsupported platform copy does not offer a start that can never be supported.
6. Route both Force clear buttons through the recovery runner. Route the separate “Stop and reopen” button through `runPaneSessionHandoff` with `action:'stop-and-reopen'`, retaining pane-race/fence guards but allowing that explicit recovery to resolve fenced busy status without pretending the session is idle. Ordinary Reopen still uses the activity gate. Remove copy claiming acknowledgment accepts overlapping writers. Extend existing structured request/result logs with action and shutdownConfirmed.

- [ ] **Step 4: Run the green API/runner/UI cases.**

Migrate the red Force clear tests to the new runner and assert the exact wire action. Add canonical alias/current-fence, typed refusal, unknown evidence, network error, and changed-pane-in-flight cases. In `FreshAgentView.test.tsx`, strengthen the existing direct Force clear test to a store-backed starting/busy pane with the **real runner** and only API mocked; click the accessible Force clear button and assert one request plus rendered result. Banner mocks alone cannot prove the faulty path. Assert the explicit Stop and reopen action is distinct.

```bash
npm run test:cloud -- --config=default test/unit/client/lib/session-handoff.test.ts test/unit/client/components/SessionHandoffErrorBanner.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/lib/session-flavor-reopen.test.ts
scripts/sandbox-test.sh 'cargo test -p freshell-freshagent --locked --lib session_handoff::tests::'
scripts/sandbox-test.sh 'cargo test -p freshell-ownership --locked'
```

Expected: PASS; clear-only semantics hold for every server state and delayed request, and ordinary busy Reopen remains disabled.

- [ ] **Step 5: Refactor while green.**

Share canonical identity/cwd/fence resolution and safe response folding between the two runners; keep eligibility and actions explicit. Keep existing typed fenced states instead of a new recovery framework. Retain the behavioral protections in `a_stale_start_fence_recovers_through_the_acknowledged_force_clear`, `the_cleared_unverified_state_requires_the_acknowledged_start`, `the_acknowledged_start_reaps_the_live_prior_before_the_new_writer`, and `the_acknowledged_start_over_an_already_dead_prior_proceeds`, updating their action contract and safe expected outcomes rather than deleting coverage.

- [ ] **Step 6: Run impacted-test verification.**

```bash
npm run test:cloud -- --config=default test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/SessionHandoffErrorBanner.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/lib/session-handoff.test.ts test/unit/client/store/selectors-runtime-owner.test.ts
npm run typecheck:client
npm run lint
scripts/sandbox-test.sh 'cargo test -p freshell-freshagent --locked --lib session_handoff::tests::'
scripts/sandbox-test.sh 'cargo test -p freshell-ownership --locked'
```

Expected: PASS, with no lost busy status, weakened delayed-request fence, or missing recovery action. Record F4 red/green and explicit server action receipts.

- [ ] **Step 7: Commit the task.**

```bash
git add crates/freshell-freshagent/src/session_handoff.rs crates/freshell-freshagent/src/session_handoff/tests.rs crates/freshell-ownership/src/lib.rs src/lib/api.ts src/lib/session-handoff.ts src/components/SessionHandoffErrorBanner.tsx src/components/fresh-agent/FreshAgentView.tsx test/unit/client/lib/session-handoff.test.ts test/unit/client/components/SessionHandoffErrorBanner.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/lib/session-flavor-reopen.test.ts
git commit -m "fix: separate clear-only session recovery from stopping writers"
```

### Task 5: Make each attachment attempt own its observation and recovery round

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentView.tsx:969,1131,1995` and reconnect/retry scheduling in that component.
- Modify when transport reproduction confirms the bypass: `src/lib/ws-client.ts` queued attach replay.
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`, `test/unit/client/lib/ws-client.test.ts`; preserve current reconcile/owner folds in `src/store/panesSlice.ts`, `freshAgentSlice.ts`, and `src/lib/fresh-agent-ws.ts`.

**Interfaces:**
- Consumes: `resolveCanonicalPaneSession`, `selectPaneOwnerFence`, `isLifecycleStartSuperseded`, existing `buildFreshAgentAttachMessage(content,cwd?,observedFence?)`, `paneContent.reconcileEpoch`, and parsed `state.connection.bootId`.
- Produces, local to the existing view module:

```ts
type AttachmentAttempt = {
  key: string
  content: FreshAgentPaneContent
  fence: ObservedOwnerFence | undefined
}
function captureAttachmentAttempt(
  state: ReturnType<AppStore['getState']>,
  content: FreshAgentPaneContent,
  previous: AttachmentAttempt | null,
  decisionSerial: number,
): AttachmentAttempt
// sendFencedFreshAgentAttach changes from content to an already captured attempt.
```

- [ ] **Step 1: Add the real store/view regression.**

Insert this test beside `fresh-agent runtime-owner divergence recovery`, using the existing helpers and importing `applyFreshAgentReconcileAttach` from the existing pane slice:

```tsx
it('same-session authoritative attach recovery sends the new round fence', async () => {
  const store = createStore()
  const sid = 'thread-attach-recovery'
  store.dispatch(initLayout({
    tabId: 'tab-1', paneId: 'pane-1',
    content: divergencePaneContent({
      sessionId: sid, sessionRef: { provider: 'codex', sessionId: sid },
    }),
  }))
  store.dispatch(applyRuntimeOwner(terminalOwnerFrame({
    sessionId: sid, ownerKind: 'fresh-agent', terminalId: undefined,
    epoch: 1, generation: 5,
  })))
  render(<Provider store={store}>
    <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
  </Provider>)
  await waitFor(() => expect(sentFreshAgentMessages('freshAgent.attach')).toHaveLength(1))
  expect(sentFreshAgentMessages('freshAgent.attach')[0]).toMatchObject({
    sessionId: sid, observedEpoch: 1, observedGeneration: 5,
  })
  act(() => {
    store.dispatch(applyRuntimeOwner(terminalOwnerFrame({
      sessionId: sid, ownerKind: 'fresh-agent', terminalId: undefined,
      epoch: 1, generation: 9,
    })))
    store.dispatch(applyFreshAgentReconcileAttach({
      tabId: 'tab-1', paneId: 'pane-1',
      sessionRef: { provider: 'codex', sessionId: sid },
      serverInstanceId: 'same-server',
    }))
  })
  await waitFor(() => expect(sentFreshAgentMessages('freshAgent.attach')).toHaveLength(2))
  expect(sentFreshAgentMessages('freshAgent.attach')[1]).toMatchObject({
    sessionId: sid, observedEpoch: 1, observedGeneration: 9,
  })
})
```

Add separate cases, preserving existing fake-timer cleanup and collecting **all** message subscriptions:

1. New boot after initial `(1,5)`: invoke reconnect callbacks before the ready handlers as the real transport does, fold `setBootId`, reset/replay owners to `(2,1)`, then same-ID reconcile verdict. Assert no post-fold attach uses `(1,5)` and the replacement attach uses `(2,1)`. Ordinary same-boot reconnect retains authority without creating a new conversation.
2. Reservation retry: initial `(1,5)`, receive retryable SESSION_RESERVED, owner advances to `(1,9)` without a new verdict. Retry must retain `(1,5)` or be consistently suppressed; after new reconcile epoch it sends `(1,9)`. Keep the existing analogous create-fence tests.
3. Hidden queued attempt A, new authorized round B, then owner becomes terminal: pumping A must not borrow B's fence or restart Fresh Agent. Assert actual sent frames and visible divergence state.
4. Initially absent observation may acquire its first present pair on retry, but never refresh a captured pair. Equal raw IDs from different providers must remain distinct.
5. Same-session `resetFreshAgentPaneForReconcileCreate` followed by created response starts a new attach decision and keeps durable history identity.
6. Transport queues a freshAgent.attach while disconnected, then receives ready with a new boot/owner. Assert the queued frame does not replay before authority fold; preserve create and terminal-input replay assertions. This case determines the necessary `ws-client.ts` edit.

- [ ] **Step 2: Run the focused red.**

```bash
npm run test:cloud -- --config=default test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/lib/ws-client.test.ts
```

Expected: same-ID reconcile sends no second attach, an explicit refresh exposes the cached old pair, and/or reconnect replays a stale queued frame before the ready fold. Keep separate assertions so missing rearm does not conceal stale capture. Record F3 from the actual frames.

- [ ] **Step 3: Capture at decision time; execute without renewing old authority.**

Implement this key/capture logic beside the current sender; reuse existing imports/types:

```ts
function attachmentAttemptKey(
  state: ReturnType<AppStore['getState']>,
  content: FreshAgentPaneContent,
  decisionSerial: number,
): string {
  const canonical = resolveCanonicalPaneSession(state, content)
  return JSON.stringify([
    canonical?.provider ?? content.provider,
    content.sessionType,
    canonical?.sessionId ?? content.sessionRef?.sessionId ?? content.sessionId ?? null,
    content.createRequestId,
    content.reconcileEpoch ?? 0,
    state.connection.bootId ?? null,
    decisionSerial,
  ])
}

function captureAttachmentAttempt(
  state: ReturnType<AppStore['getState']>,
  content: FreshAgentPaneContent,
  previous: AttachmentAttempt | null,
  decisionSerial: number,
): AttachmentAttempt {
  const key = attachmentAttemptKey(state, content, decisionSerial)
  if (previous?.key === key && previous.fence) return previous
  return { key, content, fence: selectPaneOwnerFence(state, content) }
}
```

Replace `attachFenceRef` with `attachmentAttemptRef: AttachmentAttempt | null` and a local `attachDecisionSerialRef` initialized to zero. Increment that serial only for an explicit user recovery/refresh that constitutes a new attachment decision; automatic reservation/lost-session/hidden-queue retries never increment it. A new reconcile epoch or boot already changes the key without a serial increment.

At each attach decision, capture the attempt **before** putting a callback in a queue/timer. The sender accepts that captured attempt, reads current state once, and requires: the component is mounted/connected; its current pane key/round equals `attempt.key`; the current active attempt is that attempt (so a queued callback superseded while acquiring its first fence is obsolete); and `isLifecycleStartSuperseded` is false. Then send `buildFreshAgentAttachMessage(attempt.content, resolvedCwd, attempt.fence)` through current-main `sendSuppressedAwareFreshAgentFrame` wiring. It must not re-read a new generation to upgrade an old captured attempt. Canonical alias convergence still uses the existing pane materialization/rekey fold and route cwd logic.

Include `paneContent.reconcileEpoch` and parsed boot identity in the attachment effect dependencies. On a round boundary cancel reservation/reconcile timers belonging to the old attempt, capture the new round, and let its authoritative attach verdict drive send. Timer/hidden callbacks retain the immutable attempt and fail the key/identity check if obsolete. Initially missing observations may be reacquired by the same decision's next deliberate retry; present pairs remain frozen.

Defer reconnect decision with `queueMicrotask` so synchronous ready handlers finish boot/ownership replay first. The deferred callback checks mount, connection identity, and current pending-reconcile state; use the existing bounded verdict wait/fallback rather than an unbounded hold. If the transport regression proves replay bypass, classify queued `freshAgent.attach` like existing queued terminal attach: drop its stale replay and let view/reconcile send the new deliberate attempt. Keep create/input semantics untouched.

- [ ] **Step 4: Run the focused green.**

```bash
npm run test:cloud -- --config=default test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/lib/ws-client.test.ts
```

Expected: PASS, with both rearm and new-round pair asserted, automatic retry unable to renew a prior attempt, and absent-first-observation behavior preserved.

- [ ] **Step 5: Refactor while green.**

Route every attach producer in this component through the single capture/execute boundary: initial mount, visible/hidden queue, reconnect, reservation redrive, pane refresh, and lost-session resend. Keep create's existing attempt discipline; only share a helper if both genuinely need identical logic. Do not remove fencing or replace the ownership store.

- [ ] **Step 6: Run impacted-test verification.**

```bash
npm run test:cloud -- --config=default test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/fresh-agent-ws.test.ts test/unit/client/lib/ws-client.test.ts test/unit/client/store/freshAgentSlice.runtime-owner.test.ts test/unit/client/lib/pane-reconcile.test.ts
npm run typecheck:client
npm run lint
```

Expected: PASS, preserving focus adoption, suppression, snapshot busy status, explicit-null effort, error dismissal, aliases, turn completion, and existing create retry protections. Record F3 red/green; Task 7 supplies mounted-browser restart evidence.

- [ ] **Step 7: Commit the task.**

```bash
git add src/components/fresh-agent/FreshAgentView.tsx src/lib/ws-client.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/lib/ws-client.test.ts
git commit -m "fix: renew attachment observations only for new recovery attempts"
```

### Task 6: Make OpenCode placeholder attachment observation-only

**Files:**
- Modify/test: `crates/freshell-freshagent/src/opencode_ws.rs:5028,5201,7923`.
- Preserve: materialization/alias behavior in `src/lib/fresh-agent-ws.ts` and the existing cloud-eligible handoff fixture.

**Interfaces:**
- Consumes: `FreshOpencodeState::handle_attach(&self,msg:FreshAgentAttach)`, existing session lock, `event_frame`, `snapshot_event`, `materialized_frame`, and guarded durable attach.
- Produces: a placeholder attach emits its snapshot and returns under one classification; any durable bridge restart uses the existing observed-fence adoption guard over the canonical durable ID.

- [ ] **Step 1: Strengthen the existing handler test instead of adding an unobserved duplicate.**

In `an_unfenced_mount_attach_on_a_fresh_placeholder_adopts_nothing_and_sends_still_materialize`, after create completes and **before** attach, subscribe to the real bus. Replace the single attach with two attaches and collect frames:

```rust
let mut rx = st.fresh_agent.broadcast_tx.subscribe();
st.handle_attach(attach_msg(placeholder)).await;
st.handle_attach(attach_msg(placeholder)).await;
let mut frames = Vec::<serde_json::Value>::new();
while let Ok(raw) = rx.try_recv() {
    frames.push(serde_json::from_str(&raw).expect("server JSON frame"));
}
assert_eq!(
    frames.iter().filter(|frame| {
        frame["type"] == "freshAgent.event"
            && frame["sessionId"] == placeholder
            && frame["event"]["type"] == "freshAgent.session.snapshot"
    }).count(),
    2,
    "each placeholder attach emits an observable snapshot",
);
assert!(frames.iter().all(|frame| {
    frame["type"] != "freshAgent.event"
        || frame["sessionId"] != placeholder
        || frame["event"]["type"] != "freshAgent.error"
}), "ordinary placeholder attach must not reserve a nonexistent writer: {frames:?}");
```

This asserts the actual event returned by `snapshot_event`, not source text. Keep every existing Vacant/send/materialization/alias assertion. Add the complete-observed-pair variant using the placeholder's current Vacant epoch/generation, and retain half-pair rejection. The positive two-snapshot assertion prevents a vacuous zero-error test.

- [ ] **Step 2: Run and record the intended red.**

```bash
scripts/sandbox-test.sh 'cargo test -p freshell-freshagent --locked --lib opencode_ws::tests::an_unfenced_mount_attach_on_a_fresh_placeholder_adopts_nothing_and_sends_still_materialize -- --exact'
```

Expected: repeated attach produces SESSION_RESERVED/fails positive snapshot count. If it already emits the required snapshots with no error after integration, record F5 UNSUBSTANTIATED with actual frames.

- [ ] **Step 3: Return from the locked placeholder branch before durable adoption.**

After resolving an existing `session_arc` and validating the wire fence shape, before any ownership adoption or bridge restart, lock that session and classify its `real_session_id`. For an unmaterialized row, emit and return without dropping the lock and later reclassifying it into a bridge restart:

```rust
if let Some(session_arc) = session_arc.as_ref() {
    let session = session_arc.lock().await;
    if session.real_session_id.is_none() {
        let running = session.turn_task.as_ref()
            .map(|task| !task.is_finished())
            .unwrap_or(false);
        let status = if running { "running" } else { "idle" };
        self.broadcast(&event_frame(
            &session.placeholder_id,
            snapshot_event(&session.placeholder_id, status),
        ));
        return;
    }
}
```

For a materialized row, capture its durable ID from that same classification and use it for owner lookup/adoption; all later bridge restart work stays under the existing attach guard. Preserve materialized-before-snapshot ordering when the caller addressed the old placeholder alias. An absent map row still follows existing guarded durable resume. Do not remove SESSION_RESERVED handling for actual contention or just suppress it on the client. Do not kill/restart OpenCode's shared serve daemon.

- [ ] **Step 4: Run focused green and the race case.**

Add `an_attach_racing_materialization_observes_or_adopts_once` using the existing per-session lock: hold the lock, queue attach and materialization, release it, and assert either observation-only placeholder snapshot before materialization or guarded durable attach after materialization; exactly one provider session exists and no bridge restart occurs outside a claim. Assert observable operation counts with existing `RealisticServeHttp`, not timing sleeps.

```bash
scripts/sandbox-test.sh 'cargo test -p freshell-freshagent --locked --lib opencode_ws::tests::an_unfenced_mount_attach_on_a_fresh_placeholder_adopts_nothing_and_sends_still_materialize -- --exact'
scripts/sandbox-test.sh 'cargo test -p freshell-freshagent --locked --lib opencode_ws::tests::attach_placeholder_addressed_session_emits_materialized_first -- --exact'
scripts/sandbox-test.sh 'cargo test -p freshell-freshagent --locked --lib opencode_ws::tests::a_stale_pair_existing_session_attach_refuses_typed_without_restarting_the_bridge -- --exact'
```

Expected: PASS, with two snapshots/no ordinary placeholder reservation errors and preserved stale-pair refusal/materialized ordering.

- [ ] **Step 5: Refactor while green.**

Remove redundant placeholder/materialized checks made obsolete by the early classification. Keep one observation-only branch and one guarded durable attachment path; do not add a new subsystem or restore retired OpenCode context/DB repair.

- [ ] **Step 6: Run impacted-test verification.**

```bash
scripts/sandbox-test.sh 'cargo test -p freshell-freshagent --locked --lib opencode_ws::tests::'
scripts/sandbox-test.sh 'cargo test -p freshell-opencode --locked'
npm run test:cloud -- --config=default test/unit/client/fresh-agent-ws.test.ts test/unit/provider-fixtures/fake-opencode-fixture.test.ts
```

Expected: PASS, including terminal-handoff attach refusal, first-send claim before provider mutation, aliases, durable resume/kill, and current-main fixture behaviors. Record F5 red/green; the wire browser observation follows in Task 7.

- [ ] **Step 7: Commit the task.**

```bash
git add crates/freshell-freshagent/src/opencode_ws.rs
git commit -m "fix: observe OpenCode placeholders without reserving a writer"
```

### Task 7: Prove complete browser flows and native platform behavior

**Files:**
- Modify: `test/e2e-browser/specs/handoff-two-device-rust.spec.ts`, its two dual-role fixture helpers only where required, `test/integration/electron/checkout-free-runtime.test.ts`, `README.md`.
- Preserve/run: `test/e2e-browser/specs/mcp-bridge-rust.spec.ts`, current `test/e2e-browser/playwright.config.ts` and `playwright.cloud.config.ts`, `.github/workflows/electron-build.yml` native matrix.
- Existing provider fixtures: `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`, `test/e2e-browser/fixtures/fake-codex-cli.mjs`, `fake-opencode-terminal.mjs`, and current-main fake OpenCode serve fixture. No real provider credentials are needed.

**Interfaces:**
- Consumes: Tasks 2–6 production paths; existing `RustServer`, `TestHarness`, `newDeviceContext`, `openDevicePage`, `sendComposerText`, `freshAgentDurableRef`, `waitForJsonlRow`, and actual context-menu actions.
- Produces: cloud-eligible complete-flow tests and native packaged-runtime assertions; receipts identify exact feature SHA, selected test counts, operating system/architecture, logs/traces, and workflow run URL.

- [ ] **Step 1: Add only the missing complete flows, preserving existing assertions.**

Extend the existing three handoff-spec cases and add three focused cases:

| Case | Concrete steps and required observations |
|---|---|
| Existing Codex two-device case | Keep freshcodex→CLI and terminal adoption; then use real “Reopen as Freshcodex” on A, observe B's “Session open as a Fresh Agent pane on another device” alert, click “Open as Fresh Agent here”. Assert identical provider-qualified durable ID, first-turn text retained, no duplicate session, and a second user turn completes on both devices. Compare provider operation/terminal spawn rows around B's adoption: adoption must not create a writer. |
| Existing OpenCode two-device case | Extend through “Reopen as Freshopencode” and the same B adoption flow. Assert same `ses_*`, retained first turn and successful next turn, exactly one provider session, and existing shared serve daemon remains healthy/alive with no shutdown row. |
| Existing offline/reconnect case | Keep the forward direction; take B offline and call `harness.forceDisconnect()` before A switches back. Reconnect B and assert ready owner replay converges to the fresh-agent owner and adopts that exact ID without stale-kind resurrection or extra writer creation. Offline alone does not close an existing socket. |
| `same-session restart resumes attachment and the next turn on both devices` | With the existing owned Codex server/home/port/token, open same session in two contexts and complete a distinctive turn. Keep both pages mounted; call `RustServer.restart()` and wait for a changed ready boot ID/new authority, settled attachments, same durable ref and retained marker. Send another turn and observe completion on both pages. No page reload may erase the cache being tested. This case runs only in disposable configured cloud jobs. |
| `OpenCode placeholder attaches without reservation errors and materializes once` | Observe WebSocket frames before navigation, create an unmaterialized freshopencode pane, positively observe its attach snapshot, force one real reconnect, positively observe another snapshot, then send a marker prompt. Require zero SESSION_RESERVED errors for that placeholder, exactly one session_create_requested/session_created pair in the existing OpenCode audit log, durable `ses_*`, retained marker, and enabled composer after completion. |
| `Force clear on a starting pane shows its clear-only result` | Use the real store-backed pane and real recovery runner; seed the pane's creating/starting error state through the existing TestHarness store access and intercept only the HTTP response with a typed clear result `shutdownConfirmed:false`. Click the actual Force clear control, assert exactly one outgoing request with `action:'clear-stale-bookkeeping'`, blocked replacement copy, and unchanged pane/session identity. Then provide a typed refusal/network failure on retry and assert visible usable retry. This is explicitly UI/wire coverage; Task 4's real server/process tests prove no kill/start and the subsequent confirmed stop/reopen. Do not represent this mocked response as process-shutdown evidence. |

For restart/placeholder cases add this test-only wire observer, installed before `openDevicePage` navigation, scoped to this owned server URL:

```ts
const received: Record<string, any>[] = []
page.on('websocket', (socket) => {
  if (!socket.url().startsWith(info.baseUrl.replace(/^http/, 'ws'))) return
  socket.on('framereceived', ({ payload }) => {
    try { received.push(JSON.parse(String(payload))) } catch { /* non-JSON frame */ }
  })
})
const reservedFor = (sid: string) => received.filter((frame) =>
  frame.type === 'freshAgent.event' && frame.sessionId === sid
    && frame.event?.type === 'freshAgent.error'
    && frame.event?.code === 'SESSION_RESERVED')
```

Here `info` is the current `E2eServerInfo` returned by `RustServer.start()` and `baseUrl` is its real field. Keep the filter tied to the test-owned origin. Assert nonzero completed attach/snapshot cycles before asserting zero errors. Add no browser matrix of all provider/timing permutations; competing requests, failed starts, interrupted stops, and actual surviving writers remain covered at their lowest deterministic layer.

- [ ] **Step 2: Run the complete-flow assertions in cloud.**

Tasks 2–6 supply the original red receipts; this acceptance-only task connects their fixed production paths through complete flows. Each browser assertion must positively observe its attach/turn/reconnect outcome before checking absence of duplicates/errors. Run against the repaired integrated tree: an end-to-end integration failure requires its own targeted repair, while an already passing flow needs no manufactured defect. A failing setup or zero selected tests is not meaningful evidence.

```bash
FRESHELL_TEST_SUMMARY='b8ke stabilization: complete handoff flows' npm run test:e2e -- --project=chromium test/e2e-browser/specs/handoff-two-device-rust.spec.ts
```

Expected: every case in the affected spec runs and passes in the configured cloud container. Neither restart nor process-kill cases may run on the local E2E backend. Preserve traces for retries and repair flaky synchronization. The entire spec is currently cloud-eligible; do not add it to `CLOUD_SKIP_SPECS` to pass.

- [ ] **Step 3: Add native acceptance using the existing packaged-runtime fixture.**

Extend `checkout-free-runtime.test.ts` within its existing relocated runtime/temp-home/owned-server structure. Keep its Rust/client/MCP/PTY smoke. Add a named test `preserves native provider lifecycle and enforces atomic handoff capability` with the same `runtimeRoot`, `findFreePort`, `requestJson`, `connectAuthenticatedWebSocket`, `waitForWebSocketMessage`, and owned-child cleanup helpers. The test fixture setup is concrete:

1. Copy the committed fake Codex app-server and fake Codex terminal into `emptyCwd/native-fixtures`; copy the `ws` package into that fixture directory's own `node_modules/ws` so ESM resolution is independent of the checkout. Use the existing dual-role shim content with in-process ESM import for app-server, pointing to these copied files. Set the owned server's PATH to include the bundled Node directory and `CODEX_CMD` to `node native-fixtures/codex`; this avoids whitespace splitting of native absolute paths. Keep all fixture files and provider homes inside `outsideRoot`. Do not package test fixtures into the released app.
2. Give the fake provider an explicit isolated `CODEX_HOME`, durable-write opt-in, stable per-test `threadStartThreadId`, and `recordTurns:true`. In the existing `writeFakeClaudeSdk`, preserve its model-catalog/init behavior; for native lifecycle coverage extend its returned query iterator only as needed to honor supplied resume identity and emit a completed marker turn. No real model call is substituted for test coverage.
3. Through the real authenticated WS server handlers, create a Codex Fresh Agent, send a marker, attach it on a second connection with the observed current fence, and assert exact session ID plus a completed turn/snapshot. Kill it through the real provider handler, verify native owned-process exit/release, then resume the same ID and verify another turn. Exercise natural exit using the existing fake app-server behavior and confirm the runtime is not advertised live afterward; resume again. Preserve corresponding Claude native sidecar and shell PTY lifecycle smoke.
4. Request `/api/sessions/handoff` with `action:'switch'`, exact observed pair, provider codex, same session ID, targetKind terminal, and mode codex. On Linux assert successful same-ID terminal attachment followed by reverse freshcodex switch and another turn. On Windows/macOS assert typed PLATFORM_LIMITED **and unchanged** owner/generation/session history/flavor/process, then send another turn through that prior to prove it stayed usable. Also send the unsupported request for a missing session and assert its copy does not claim a live session exists.
5. Exercise a failed start in an owned fixture instance with `CODEX_CMD` set to `node native-fixtures/missing-entry.mjs` (deliberately do not create that file): Node exits before opening the app-server listener. Assert typed failure/no falsely live runtime. Stop only that owned test server through its existing cleanup, start the healthy fixture instance with the same isolated provider home, and recover the same durable ID. This is ordinary fixture lifecycle, not a restart storm. For uncertain stop, use Task 3/4 deterministic sandbox coverage rather than porting destructive adversarial child scenarios into the native smoke.

Register WS waiters before each send so adjacent responses cannot be lost. Collect the packaged server's JSONL/stdout diagnostics and operation frames per assertion. Windows must use native bundled Node/native Rust `.exe` on the Windows workflow worker; no WSLg build or Linux cross-compilation claim. If a required ordinary lifecycle step fails because the repair over-applied Linux confirmation, fix that specific native path without enabling unsupported atomic switching.

- [ ] **Step 4: Update user instructions.**

In README's existing session usage/recovery section, explain that switching keeps the same conversation, other devices offer attachment to its current mode, Force clear repairs stale bookkeeping without stopping a writer, and Stop and reopen requires confirmed stop. State the actual platform availability and truthful refusal. Do not add another end-user markdown document. This bounded recovery UI does not change the default mock experience; only update `docs/index.html` if the final implementation introduces a significant default-view change.

Native smoke requires the focused commit/push in Step 7 so the existing `workflow_dispatch` can execute it. No PR is required for that dispatch, and no workflow is dispatched in this planning run.

- [ ] **Step 5: Refactor while green.**

Share only test helpers already duplicated by the added cases within their existing spec. Preserve Codex's in-process app-server dispatch and current-main OpenCode fixture behavior; normalize touched relative imports to `.js`. Replace timing sleeps with positive WS/provider-log/state conditions. Keep UI mock recovery evidence labeled separately from real process evidence.

- [ ] **Step 6: Run impacted-test verification.**

```bash
npm run typecheck
npm run lint
FRESHELL_TEST_SUMMARY='b8ke stabilization: affected browser acceptance' npm run test:e2e -- --project=chromium test/e2e-browser/specs/handoff-two-device-rust.spec.ts test/e2e-browser/specs/mcp-bridge-rust.spec.ts
```

Expected: PASS with nonzero selected counts and all newly added handoff cases actually executed. Append every additional materially changed browser spec from Task 1's conflict ledger. Cloud-skipped `freshopencode-restart-recovery.spec.ts` and other excluded specs cannot satisfy this row; the required restart flow is in the executed handoff spec. Native receipt follows in Step 7 after the commit. If a subsequent repair changes native code/fixtures, push and rerun the affected native workflow at that new SHA before readiness.

- [ ] **Step 7: Commit the acceptance and documentation changes before native dispatch.**

```bash
git add test/e2e-browser/specs/handoff-two-device-rust.spec.ts test/e2e-browser/fixtures/codex-dual-role.ts test/e2e-browser/fixtures/opencode-dual-role.ts test/integration/electron/checkout-free-runtime.test.ts README.md
git commit -m "test: cover session handoff recovery across devices and platforms"
```

Only if the stated significant-default-UI condition occurred, include the inspected `docs/index.html` change in this same commit. Then run native smoke on the committed feature branch:

```bash
git push -u origin the-usual/b8ke-handoff-stabilization
acceptance_sha=$(git rev-parse HEAD)
gh workflow run electron-build.yml --ref the-usual/b8ke-handoff-stabilization
gh run list --workflow electron-build.yml --branch the-usual/b8ke-handoff-stabilization --event workflow_dispatch --limit 10 --json databaseId,headSha,status,conclusion,url
native_run_id=$(gh run list --workflow electron-build.yml --branch the-usual/b8ke-handoff-stabilization --event workflow_dispatch --limit 10 --json databaseId,headSha --jq "map(select(.headSha == \"$acceptance_sha\"))[0].databaseId")
test -n "$native_run_id"
test "$native_run_id" != null
gh run watch "$native_run_id" --exit-status
gh run view "$native_run_id" --log
```

Run list/id selection again if GitHub has not yet exposed the dispatched run; do not watch a previous SHA. The push runs the normal pre-push gate. No PR is created. Use the configured `gh` account associated with `dan@danshapiro.com`; retain the repo's noreply git identity. Required receipt: feature SHA, workflow/run URL, successful `ubuntu-latest`, `windows-2022`, `macos-15-intel`, and `macos-latest` jobs, actual native lifecycle/capability test names and counts, runtime/artifact verification logs, installer artifact links. Compilation or installer existence without the new behavioral assertions is insufficient. Any unavailable/failing native row blocks readiness rather than being labeled passed. No native run is authorized during the current planning run.

### Task 8: One scoped independent review, one verification pass, and readiness for one PR

**Files:**
- Review: actual conflict resolutions and Task 2–7 touched production/tests; acceptance/finding receipts under the ignored run directory.
- Modify only if a demonstrated blocker requires it: the implicated existing files, with a deterministic regression and focused repair commit.
- No new production behavior, architecture project, PR, or deployment is introduced by this task.

**Interfaces:**
- Consumes: integrated repaired feature SHA, original reviewed SHA, tested main SHA, red/green receipts, conflict-preservation ledger, five-finding disposition table, cloud/browser/native acceptance evidence.
- Produces: one scoped independent code-review report, one verification report, final readiness/disposition receipt, and a clean pushed branch ready for a later explicitly approved PR.

- [ ] **Step 1: Assemble the bounded review packet.**

The author accounts for every five-guarantee acceptance row and F1–F5; records all actual conflicts, preserved current-main behavior, changed interfaces, source/focused test commands and their results; and includes native/cloud evidence at the applicable exact SHA. No source-only finding is labeled reproduced and no missing/skipped test is labeled coverage. No new failing test is needed merely to review; any demonstrated new defect gets its own real regression before repair.

- [ ] **Step 2: Request exactly one independent code review.**

Use one independent reviewer with the complete current User Request and this packet. Scope it to G1–G5, repaired paths, and conflict resolutions. Require every blocker to name: a supported operation or credible failure scenario, the violated guarantee, and a reproduction/deterministic test/concrete trace. The reviewer may propose a remedy, but its implementation is advisory. Do not ask for an unrestricted whole-branch audit, independent per-task reviews, or nested focused review episodes. The explicit user limit overrides the usual template and workflow loops.

- [ ] **Step 3: Give each supported finding a final disposition and make targeted repairs.**

For every demonstrated blocker, add a failing behavioral test, record the intended failure using the appropriate existing cloud/sandbox/native command, implement the smallest complete correction at the identified boundary, rerun the focused impacted set, and refactor while green. Commit each focused repair with its actual files. Do not weaken a test to accommodate the defect. Unsupported findings become UNSUBSTANTIATED with the contradictory evidence; optional/out-of-scope items follow the Scope rule and remain follow-up work. A known G1–G5 violation cannot become optional because the review budget is exhausted.

- [ ] **Step 4: Run required integrated-final checks once at the repaired result.**

Run from the clean dedicated worktree, sequentially:

```bash
npm run typecheck
npm run lint
cargo fmt --all --check
cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings
FRESHELL_TEST_SUMMARY='b8ke handoff stabilization: integrated final acceptance' npm run verify
FRESHELL_TEST_SUMMARY='b8ke handoff stabilization: final affected browser acceptance' npm run test:e2e -- --project=chromium test/e2e-browser/specs/handoff-two-device-rust.spec.ts test/e2e-browser/specs/mcp-bridge-rust.spec.ts
git diff --check
git status --short --branch
```

Expected: all required checks PASS with actual selected/executed counts and no uncommitted changes. `verify` builds client/tools/Rust and runs the coordinated supported suite, including cloud default Vitest, local source-runtime, Rust and Electron unit lanes. Native packaged-runtime smoke is the separate four-platform receipt from Task 7 and must match final behavior; rerun it after relevant repairs. Add any other actual affected browser specs from conflict resolution. Investigate retries/flakes rather than treating eventual green as sufficient. Repeat checks only for new changes, failures, or unresolved evidence; no ritual whole-suite loop.

- [ ] **Step 5: Perform the single bounded verification pass.**

The same independent reviewer verifies its reported finding dispositions, targeted fixes, and final acceptance evidence once. Its task is to confirm resolution and inspect the changed correction paths, not launch another whole-branch review. If this pass exposes a demonstrated remaining violation, it remains blocking: repair it with author-run deterministic regression and the affected checks, and record evidence. Do not spawn another independent review/verification cycle. If the evidence still cannot resolve a blocker, mark FAILED/non-converged and report the precise conflict; the review limit never licenses shipping it.

- [ ] **Step 6: Apply the readiness checklist and record residuals.**

Readiness requires all of the following:

1. F1–F5 are CLEARED or UNSUBSTANTIATED, each with reproduction/disproof and final evidence.
2. G1–G5 acceptance rows pass on the integrated result, including both switch directions, two distinct devices/reconnect, mounted same-session restart, writer confirmation, release-on-exit, explicit recovery semantics, representative competing requests/failed starts/interrupted stops, and native smoke.
3. Current-main semantic overlaps and existing behavioral coverage survive; no unresolved merge conflict or flaky acceptance remains.
4. Linux's advertised handoff and Windows/macOS pre-stop refusal plus ordinary lifecycle are actually exercised. No unsupported capability is advertised as working, and no absent native receipt is called green.
5. No demonstrated guarantee violation remains. Optional refactors/comment cleanup/unusual automatic recovery remain explicit follow-ups only. After a separately approved deployment, existing structured logs—not a new audit project—guide any later expansion.

- [ ] **Step 7: Final focused commit/push, then stop before PR creation until approved.**

All source/test fixes must already be in focused commits and the worktree clean. Record final commit and evidence in the run's ignored durable record, then:

```bash
git status --short --branch
git log --oneline --max-count=12
git push origin the-usual/b8ke-handoff-stabilization
```

Expected: normal pre-push checks pass and the clean feature branch is pushed. Present the concrete change and receipts and request explicit approval to open the **one** feature PR targeting main and later clean up its worktree. Repository instructions require this approval; execution/planning approval does not grant it. Do not run `gh pr create`, merge, or clean up the worktree before that approval. Deployment/restart is a separate later operation requiring explicit `APPROVED`; no landing step implicitly deploys production.

## Author Self-Review and Current-Run Stop

Before handing this plan to root for its documentation commit, the author checks: complete User Request appears byte-for-byte once; each explicit obligation/residual has a task or constraint; all F1–F5 start unassessed and have executable behavioral reproduction/disproof; paths and interfaces resolve to the reviewed/current-main source or are explicitly introduced; no unspecified central fixture or unsafe backend command remains; browser/native/UI-mock evidence is labeled accurately; and the scoped review/stop rules are consistent throughout. This is author self-review only. Root owns the final exact-block check, run-state entry, and documentation commit. After that commit, **stop**; do not advance to Stage 2 or independent plan review.

**Author self-review completed, 2026-09-17:** all five guarantees and supplied findings map to named tasks and observable evidence; no requirement is silently deferred. The plan contains one complete User Request, eight tasks with 56 checkbox steps, explicit future commands/expected results/commit contents, and the authoritative Turn economy policy unchanged. Targeted source checks corrected the OpenCode snapshot event to `freshAgent.session.snapshot`, the Codex environment helper to `ENV_LOCK`, and the browser server-info type to current `E2eServerInfo`. The placeholder and trailing-whitespace scans are clean; only this plan file was written. No production code, tests, integration, independent review, workflow dispatch, or deployment was executed. The base gate remains failed and implementation remains gated. Root still performs the final canonical User Request comparison and owns the commit.

# Scope rule

The User Request defines need. Deliver its Requested result and Explicit
constraints by the simplest complete means, and build only what they require.
Preserve pre-existing code and behavior unless satisfying the User Request
requires changing them.

A reviewer's suggested remedy is advisory; the finding itself is what must be
resolved.

Every substantiated finding is binding: the run may not report success until it
reaches a final disposition. Binding never requires a fix.

- `CLEARED` — fixed, with evidence: corrected, or simplified away by removing
  machinery this run introduced or materially expanded so the finding no
  longer applies.
- `UNSUBSTANTIATED` — the assessment finds the finding wrong, with the reason
  recorded.
- `OUT-OF-SCOPE` — available to Major, Minor, and Nit findings. The finding
  does not block the Requested result or an Explicit constraint. Record a
  one-line reason; the recap lists it as a suggestion.
- `OPTIONAL` — available only to Minor and Nit findings. Probably a real
  improvement, but nothing requires it. Record a two-sentence reason: one
  sentence says why it would improve the work, one says why it is not
  required. The recap lists it; it never blocks anything and may be acted on
  at any time or never.

Apply this scope as given — never rewrite the User Request to fit the work.
If no compliant clearing exists, mark the result `FAILED/non-converged` and
report the conflict.

# Turn economy

Batching changes scheduling only: preserve every call, instruction, output,
acceptance criterion, evidence item, required order, and gate. This policy is
a fixed safety boundary; orchestrators that load it apply it as written.

- INDEPENDENCE: Put ready independent calls in the same tool-call response
  only after confirming all inputs are known, no call needs another's
  result, and no call can change state another reads or writes. Treat
  uncertain independence as a dependency.
- SAFE REPORT FAN-OUT: Calls that only read shared state may batch. Each may
  also write only to its own predeclared, disjoint report path — one per
  topic under the run's reports directory — after shared directory setup. A
  shared ledger, anchor, receipt, index, Git state, or other shared artifact
  is not a disjoint report.
- MUTATION BOUNDARY: Run mutations of one worktree one at a time: one
  mutating delegate per worktree at any moment. Parallel mutators require
  isolated worktrees with independent Git state and disjoint external
  targets. Calls are dependent when either can change state the other reads
  or writes. A mutating delegate without a bounded write scope owns its
  whole worktree.
- CALL BOUNDARY: A batch combines scheduling only. Each call keeps its own
  instruction, scope, output, acceptance criteria, and evidence; do not
  widen or merge calls merely to reduce turns. Attribute every result to
  the call that produced it.
- JOIN: After a batch finishes, account for every result before any
  downstream action that depends on those results, including synthesis,
  repair, review, commit, or another gate.
- DURABILITY: Record each result in the run's durable record —
  [usual-run-contract](usual-run-contract.md) owns its schema — in the first
  response after the result lands and before reading any full report; then
  read only the sections needed. Put ready independent bookkeeping in the
  same tool-call response; never defer it to a phase-end sweep.
- REVIEW: Preserve each review's specified exact instruction, context
  isolation, and provider/model settings; wait for its verdict before
  dependent repair. When a batching assumption proves wrong or a boundary is
  violated, tighten: isolate the affected calls and run them one at a time.
