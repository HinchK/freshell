# Atomic Cross-Device Session Handoff (kata b8ke) Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Fix kata b8ke: make Fresh Agent to terminal-CLI session handoff atomic and cross-device safe in Freshell. One server-authoritative runtime owner with a generation counter per canonical (provider, sessionId) shared by terminal and all Fresh Agent providers; atomic server-side handoff (block competing lifecycle operations, broadcast the transition, confirm old-runtime reap before starting the new writer, typed recoverable failures); side-effect-free snapshot GETs; cross-device convergence of panes holding the same sessionRef; pane recovery through an authoritative registry with typed ownership responses.

### Explicit constraints
- Single runtime ownership coordinator keyed by canonical (provider, sessionId) must cover ownership check through spawn/resume, durable binding, registration, and final ownership commit for ALL terminal and Fresh Agent create/attach/resume, explicit kill, crash recovery, REST/MCP operations, and compatibility cold-start paths.
- Handoff sequence: atomically enter Handoff and increment generation; block or return typed result to competing lifecycle operations; broadcast transition; stop prior runtime and await confirmed reap; start/attach target runtime retaining the lease; commit Live(targetKind) and broadcast owner identity; on failure restore prior owner or end in a typed recoverable state — never silently start a blank session.
- Delayed lifecycle requests carry observed generation; old-generation requests cannot recreate runtime ownership.
- Snapshot GET must be side-effect-free (no spawn/resume); cold resume only via explicit lifecycle command; any temporary compatibility path must use the shared coordinator and must not spawn when another kind owns or is transitioning.
- Device panes are observers of one global runtime: on handoff every matching sessionRef pane stops old-kind polling and either attaches to the new owner or shows a clear "opened as CLI elsewhere" state with a direct attach action; same-mode multi-device attachment remains supported.
- respawn-pane must resolve through LayoutStore or one authoritative pane registry and work for browser-created/error panes, returning typed ownership responses rather than "pane not found".
- REST, browser, and MCP creation paths cannot bypass the coordinator.
- A sessionRef-only restored pane (no content.sessionId) must perform the correct lifecycle handoff/kill using sessionRef.sessionId.
- Structured JSONL logs at every coordinator transition: operationId, provider/session ID, generation, old/new runtime kind, runtime ID/PID, transition, initiating client/device, outcome, duration, typed failure reason — diagnostic, not audit-grade.
- Non-goals: do not weaken active-writer refusal; do not fix with retries or longer delays; do not delete/replace provider history; do not start blank sessions when exact resume fails; do not add audit-grade history or viewer refcounts.
- Test matrix (red/green/refactor, behavior-exercising, not text-assertions): coordinator unit tests (concurrent terminal-vs-fresh-agent start, concurrent opposite handoffs, same-kind attach convergence, stop/crash/cancellation/panic release or typed recoverable state, stale generation cannot commit, property/stress test asserting max one simultaneous writer, distinct sessionRefs start concurrently); deterministic Rust integration races (snapshot paused after initial lookup then handoff; terminal creation paused after precheck then fresh-agent attach; queued snapshot before React cleanup; old-runtime reap timeout — no early target start; target spawn failure — no blank session, session ID preserved, owner restored or Vacant with typed error; browser disconnect mid-handoff; coordinator cancellation/panic plus sidecar crash) extending crates/freshell-ws/tests/cross_kind_liveness.rs; client unit/integration tests (sessionRef-only handoff for codex and opencode; runtime-owner transition event stops old-kind scheduling immediately; stale scheduled callback cannot issue lifecycle-start for old generation; typed terminal-owned/fresh-owned/handoff-in-progress/reap-timeout/spawn-failure results render recoverable states with attach/retry actions; remote-device handoff updates matching sessionRef panes without affecting unrelated panes; same-mode multi-device attachment; snapshot GET contract test proving it never spawns/resumes a sidecar) updating the FreshAgentView no-AbortSignal coverage at test/unit/client/components/fresh-agent/FreshAgentView.test.tsx:6933-6947; two-BrowserContext Playwright e2e with different persisted device IDs/localStorage for a Codex scenario and an OpenCode scenario plus offline/reconnect, replacing or extending test/e2e-browser/specs/reconcile-completion-rust.spec.ts:394-470 (two pages in one context are NOT sufficient); REST/MCP recovery parity tests (browser-created pane via LayoutStore, forced launch failure, respawn in place with mode/cwd/sessionRef; pane that never populated pane_tabs; REST/MCP/browser all call the same coordinator; ownership conflict returns typed owner/handoff info; no recovery path changes session ID or launches an empty conversation); observability assertions on the structured log fields.
- Affected e2e specs must actually pass on the configured FRESHELL_E2E_BACKEND (cloud) and not be filtered by CLOUD_SKIP_SPECS.
- OpenCode constraint: the shared `opencode serve` daemon must remain healthy — it is not the per-session writer and must not be killed; OpenCode handoff must not change session ID or stop the shared server.
- Production deployment/restart of the live port-3001 Rust server requires separate explicit approval containing the word APPROVED (out of scope for this run).
- Repo workflow: all changes stay on this worktree branch; landing via PR targeting main requires explicit user approval before PR creation.
- Test backend policy: cloud is the configured backend; never silently fall back to local; local substitution only if cloud is unfixable AND the user explicitly approves.

### Accepted tradeoffs and residuals
- A compatibility cold-start path may remain temporarily if it goes through the shared coordinator and cannot spawn when another kind owns or is transitioning the session.
- Production deployment of this change is outside this run's scope (separately approved).
- Client scheduler cancellation is not required; server-side generation fencing is the required safety net even if client improvements land.

**Goal:** Reopening the same durable Codex/OpenCode session as a terminal CLI — from any device, at any moment, including while another device holds a Fresh Agent pane for it — is one atomic server-side operation that reaps the old writer first, preserves the exact session identity, converges every pane on every device, and never yields two writers, a blank session, or a dead-end failure.

**Architecture:** A new tokio-free leaf crate `freshell-ownership` holds one server-wide coordinator: a sync state machine keyed by canonical `(provider, sessionId)` with states Vacant/Starting/Live/Handoff/Stopping and a monotonic per-key generation. Every terminal and Fresh Agent lifecycle path (WS create, REST spawn, auto-resume, snapshot compat cold-start, kills, crash recovery) claims/commits/releases through it; the existing per-lane lease maps remain as same-kind/TTL backstops, and the coordinator replaces the two mirrored check-then-act probes as the cross-kind race authority. A `SessionHandoffRunner` (in `freshell-freshagent`, holding clones of the three fresh states plus the terminal registry, minted in `freshell-server::main`) implements the atomic handoff sequence behind `POST /api/sessions/handoff`, running on a detached task with an RAII coordinator guard, broadcasting additive `session.runtimeOwner` frames. Clients fold those broadcasts into a `runtimeOwners` store, derive per-pane owner divergence via selectors (no pane mutation), stop old-kind polling/scheduling, render typed recoverable states with attach/retry actions, and send `observedGeneration` on delayed lifecycle requests so the server stale-rejects them.

**Tech Stack:** Rust workspace (new crate `freshell-ownership`; `freshell-terminal`, `freshell-freshagent`, `freshell-ws`, `freshell-protocol`, `freshell-server`), tokio broadcast bus, axum REST, `tracing` JSONL events; React 18 + Redux Toolkit client (`shared/ws-protocol.ts` additive types); Vitest, Playwright e2e with two BrowserContexts and fake provider CLIs.

## Global Constraints

- **Worktree discipline:** all work stays on branch `the-usual/b8ke-handoff` in `/home/dan/code/freshell/.worktrees/b8ke-handoff`. Never push to `origin/main`; PR creation requires explicit user approval.
- **Rust layering (hard):** `freshell-freshagent` must never import `freshell-ws` (documented cycle guard; `crates/freshell-freshagent/Cargo.toml`, `spawn_gate.rs:46-49`). `freshell-terminal` is tokio-free by design (std `sync::Mutex` only). `freshell-ownership` is a leaf depending on no workspace crate. Cross-crate seams follow the established injection idioms (`TerminalLivenessProbe` closure built in `main.rs:507-526`, `set_session_leases` at `main.rs:318-321`, `with_session_identity` wiring at `main.rs:441-463`).
- **Lock discipline:** the coordinator lock is a leaf lock — never held across an `.await`, acquired and released within one method. Existing documented lock orders (registry `leases → bindings`, `registry.rs:2236-2249`; opencode sessions-map never held across a per-session lock, `opencode_ws.rs:100-115`) must not be violated.
- **Frozen wire contract:** the refusal text `Session <sid> is still running on the server.` is byte-frozen (`terminal.rs:3217`) — typed results ride ADDITIVE fields only. All new wire surface (`session.runtimeOwner`, `ErrorMessage.ownerKind`/`ownerGeneration`, `observedGeneration` on `terminal.create`/`freshAgent.create`, `ready.runtimeOwners`) is additive-optional, so `WS_PROTOCOL_VERSION` stays **10** (the current version, `shared/ws-version.ts:24`; this plan's earlier "stays 8" was stale — corrected per the T3/T4 validation reports): no new client message is awaited for a correlated server reply (the handoff request/reply is REST, like `setSessionMetadata` before it; the `pane.opened.result` precedent covers additive types the client never awaits). After editing `shared/ws-protocol.ts`, run `npm run contract:generate`, commit the regenerated `port/contract/` artifacts, and mirror the shapes in `crates/freshell-protocol/src/{server_messages,client_messages}.rs` — INCLUDING the Rust-side inventory expectations, not just the TS freeze (validated counts per `.worktrees/.the-usual-logs/b8ke-handoff/reports/load-bearing-validator-T4.md`): the base is 64 frozen types in `SERVER_MESSAGE_TYPES` + 1 extension variant (`durability.degraded`) = 65 enum variants (the module doc's "63 discriminants" is stale); adding `session.runtimeOwner` via the frozen route makes 65 frozen types / 66 variants, `SERVER_MESSAGE_TYPES` grows `[&str; 64]` → `[&str; 65]`, and `crates/freshell-protocol/tests/inventory.rs` count assertions go 64 → 65 in BOTH spots (the json `serverToClient` count and `actual.len()`) with the combined surface 104 → 105 (both the `all.len()` and the json assertion). The freeze test `test/unit/port/ws-contract-freeze.test.ts` runs under `config/vitest/vitest.port.config.ts` — the default vitest config EXCLUDES `test/unit/port/**`. The gated Rust-side T2 equivalence tests deep-equal the wire-type set (`shapes.wsServerMessageTypes`): `session.runtimeOwner` is broadcast ONLY on handoff transitions (handoff-started/committed/failed — never on fresh creates or releases), so the oracle's create/send flow never observes it and the differential stays green (the T4 report's chosen mitigation).
- **Capability-gate preservation:** the WS terminal coordinator claim sits inside the existing `paneReconcileV1` D8 gate (`terminal.rs:2908`) so legacy connections keep byte-for-byte current probe-based behavior. The fresh-agent lane and the REST lane claim unconditionally (the fresh lease is always-on today; REST callers are programmatic). Do not silently change legacy-connection behavior. **Scope ruling (validated by T3, `.worktrees/.the-usual-logs/b8ke-handoff/reports/load-bearing-validator-T3.md`):** this satisfies "ALL terminal create paths use the coordinator" under the production-scope reading — every connectable client negotiates `paneReconcileV1` (the shipped client advertises it on every `onopen`, `ws-client.ts:518-524`, and the server's exact protocol-version match at hello, `freshell-ws/src/lib.rs:647`, means every version-10 speaker is necessarily post-capability); the only non-negotiating sender possible is a hand-rolled token-holding script, which still hits the ungated D7 probe refusal — the pre-kata status quo, within the good-faith threat model. The Node server's coordinator-less REST/MCP surfaces are dev-only frozen legacy, outside this kata's blast radius.
- **MCP scope (validated by T3):** "REST, browser, and MCP creation paths cannot bypass the coordinator" is satisfied at the Rust REST surface — every MCP lifecycle verb in `server/mcp/freshell-tool.ts` is an HTTP call to `FRESHELL_URL` (`server/mcp/http-client.ts:16` defaults to `http://localhost:3001`, the Rust server's own port, and the Rust server injects that env into every terminal it spawns, `terminal.rs:5265-5295`), so MCP verbs inherit coordinator coverage transitively from Tasks 4/10. Do not claim MCP parity for a dev-mode `FRESHELL_URL` pointed at the Node server.
- **NodeNext/ESM:** server/shared TS relative imports need `.js` extensions. Path aliases `@/` → `src/`, `@test/` → `test/`.
- **OpenCode invariant:** never kill or restart the shared `opencode serve` daemon during handoff; never record a kill handle on an opencode lease (`opencode_ws.rs:131-136`); handoff must not change the session id. Codex is the opposite (per-session owned sidecar, kill handles, crash-respawn legitimately mints a new thread id) — generations key on the canonical durable `(provider, sessionId)`, never on runtime identity.
- **Testing discipline:** red/green/refactor; tests exercise behavior, never assert prose/config text. Focused runs: `cargo test -p <crate> <filter>` and `npm run test:vitest -- run <paths> --config config/vitest/vitest.config.ts` (client unit) or `--config config/vitest/vitest.server.config.ts` (Node server tests). The `freshagent_session_lease.rs` suite is destructive and must run via `npm run test:sandbox -- "cargo test -p freshell-ws --test freshagent_session_lease"`. Broad gates only in Task 12. Fake-sidecar env knobs are process-global: every new test using them takes its file's existing `ENV_LOCK`.
- **Worktree test prerequisite (validated by T4):** the b8ke worktree starts WITHOUT `node_modules`, and every cargo suite that spawns claude-mode terminals fails there with `PTY_SPAWN_FAILED` regardless of code state — the MCP inject step resolves `<repo_root>/node_modules/tsx/dist/loader.mjs` (`crates/freshell-platform/src/mcp_inject.rs:131-160`; the two pre-existing claude-owner `cross_kind_liveness` tests are red in a bare worktree and green from main, root-caused by T4). Before the first server-side task that runs such suites (Task 3 Step 0), provision `node_modules` in the worktree (`npm install`); re-confirm whenever a fresh worktree is cut.
- **Cloud backend policy:** cloud is the configured backend; never silently fall back to local. All cloud commands in this run export `GCLOUD_ROBOT_HOME=/home/dan/.codex/skills/gcloud-robot` and `FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com` (run-state decision, 2026-09-09). New e2e specs run on fakes only (`CODEX_CMD`/`OPENCODE_CMD` dual-role shims) and must NOT be added to `CLOUD_SKIP_SPECS`.
- **A11y:** new UI cards follow the fresh-agent stuck-card pattern (`role="alert"`, real `<button>`s with `aria-label`s; `FreshAgentView.tsx:2808-2833`). `npm run lint` must stay clean.
- **Logging:** coordinator events use `tracing` with stable `target: "freshell_ownership"` and ALL join-critical fields as event fields (never span fields — span enrichment dies under target-directive `RUST_LOG` filters; `crates/freshell-server/src/logging.rs:30-44`). Diagnostic, not audit-grade.
- **Process safety:** never broad-kill; never restart the live port-3001 Rust server (out of scope for this run; requires a separate explicit "APPROVED").
- **Docs:** `docs/index.html` gets a mock for the user-facing "opened as CLI elsewhere" pane state (Task 9).

---

### Task 1: `freshell-ownership` coordinator crate (state machine + generation fencing)

**Files:**
- Create: `crates/freshell-ownership/Cargo.toml`
- Create: `crates/freshell-ownership/src/lib.rs` (implementation + full in-src test module)

The workspace root uses `members = ["crates/*"]`, so the crate joins the workspace automatically. It must stay tokio-free and depend on no workspace crate.

**Interfaces:**
- Consumes: nothing (leaf).
- Produces (used by Tasks 3-10):
  - `RuntimeOwnerKind { Terminal, FreshAgent }` (serde kebab-case: `"terminal"`/`"fresh-agent"`)
  - `SessionKey { provider: String, session_id: String }` + `SessionKey::new(&str, &str)`
  - `OwnerIdentity { kind: RuntimeOwnerKind, terminal_id: Option<String>, live_session_key: Option<String>, pid: Option<u32>, ownership_id: Option<String> }`
  - `OwnershipState { Vacant, Starting{kind, operation_id, generation, since_ms}, Live{owner, generation}, Handoff{prior: Option<(OwnerIdentity, u64)>, to_kind, operation_id, generation, since_ms}, Stopping{owner: Option<OwnerIdentity>, operation_id, generation, since_ms} }`
  - `BeginOutcome { Granted{generation}, AdoptLive{owner, generation}, OwnedByOtherKind{owner, generation}, Blocked{state, retry_after_ms}, StaleGeneration{current_generation} }`
  - `CommitOutcome { Committed, StaleGeneration{current_generation}, ForeignOperation }`
  - `FailOutcome { Released, RestoredPriorOwner, Vacant, ForeignOperation }`
  - `StopOutcome { Granted{generation}, NotLive{state} }`
  - `OwnershipSnapshot { generation: u64, state: OwnershipState }`
  - `RuntimeOwnershipRegistry::{new, begin_start, begin_handoff, commit_live, fail, begin_stop, commit_stop, release, force_release_for_confirmed_kill, observe, snapshot_records}` — signatures in Step 3
  - `RuntimeOwnerReplayRecord { provider: String, session_id: String, generation: u64, owner_kind: String, terminal_id: Option<String> }` (`owner_kind` is the wire string `"terminal" | "fresh-agent" | "vacant"`)
  - `RuntimeOwnershipRegistry::snapshot_records(&self) -> Vec<RuntimeOwnerReplayRecord>` — the reconnect-owner replay source (kata b8ke, T1 recommendation A1): one record per key in the map; `Live`/`Starting` map to their kind, `Handoff` to the in-flight target kind, `Stopping` to the stopping owner's kind, and `Vacant` entries replay as `"vacant"` so a reconnecting device can CLEAR stale divergence, not just learn owners. The record set is bounded by the distinct sessions claimed since server boot (restarts clear it) — self-hosted scale, no pruning window needed (recorded decision).
  - `pub const OWNERSHIP_RETRY_AFTER_MS: u64 = 1_000`

- [ ] **Step 1: Write the failing behavioral tests**

Create `crates/freshell-ownership/src/lib.rs` with the full type definitions and `todo!()` method bodies (so the crate compiles and the tests fail at runtime on the missing behavior), plus this test module:

```rust
#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;

    use crate::*;

    const PROVIDER: &str = "codex";

    fn registry_with_live_terminal() -> (RuntimeOwnershipRegistry, OwnerIdentity, u64) {
        let r = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation } =
            r.begin_start(PROVIDER, "sid", RuntimeOwnerKind::Terminal, "op-1", None, 1_000)
        else { panic!("expected Granted") };
        let owner = OwnerIdentity {
            kind: RuntimeOwnerKind::Terminal,
            terminal_id: Some("t-1".into()),
            live_session_key: None,
            pid: Some(4242),
            ownership_id: None,
        };
        assert_eq!(
            r.commit_live(PROVIDER, "sid", "op-1", generation, owner.clone()),
            CommitOutcome::Committed
        );
        (r, owner, generation)
    }

    #[test]
    fn concurrent_terminal_and_fresh_agent_start_yield_exactly_one_grant() {
        let r = Arc::new(RuntimeOwnershipRegistry::new());
        // Every Granted holder increments; a second concurrent grant observes >0 and fails.
        let live_holders = Arc::new(AtomicUsize::new(0));
        let violations = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for i in 0..200 {
            let r = Arc::clone(&r);
            let live_holders = Arc::clone(&live_holders);
            let violations = Arc::clone(&violations);
            handles.push(thread::spawn(move || {
                let kind = if i % 2 == 0 {
                    RuntimeOwnerKind::Terminal
                } else {
                    RuntimeOwnerKind::FreshAgent
                };
                let op = format!("op-{i}");
                match r.begin_start(PROVIDER, "sid", kind, &op, None, i as u64) {
                    BeginOutcome::Granted { generation } => {
                        if live_holders.fetch_add(1, Ordering::SeqCst) != 0 {
                            violations.fetch_add(1, Ordering::SeqCst);
                        }
                        for _ in 0..50 {
                            std::hint::spin_loop();
                        }
                        let _ = r.fail(PROVIDER, "sid", &op, generation);
                        live_holders.fetch_sub(1, Ordering::SeqCst);
                    }
                    _ => {}
                }
            }));
        }
        for h in handles {
            h.join().expect("worker panicked");
        }
        assert_eq!(violations.load(Ordering::SeqCst), 0, "two writers were Granted simultaneously");
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);
    }

    #[test]
    fn concurrent_handoffs_in_opposite_directions_yield_one_grant() {
        let r = Arc::new(RuntimeOwnershipRegistry::new());
        let grants = Arc::new(Mutex::new(Vec::<RuntimeOwnerKind>::new()));
        let mut handles = Vec::new();
        for i in 0..100usize {
            let r = Arc::clone(&r);
            let grants = Arc::clone(&grants);
            handles.push(thread::spawn(move || {
                let to = if i % 2 == 0 {
                    RuntimeOwnerKind::Terminal
                } else {
                    RuntimeOwnerKind::FreshAgent
                };
                if let BeginOutcome::Granted { .. } =
                    r.begin_handoff(PROVIDER, "sid", to, &format!("ho-{i}"), None, 1)
                {
                    grants.lock().unwrap().push(to);
                }
            }));
        }
        for h in handles {
            h.join().expect("worker panicked");
        }
        let grants = grants.lock().unwrap().clone();
        assert_eq!(grants.len(), 1, "exactly one handoff may be granted, got {grants:?}");
    }

    #[test]
    fn same_kind_duplicate_attach_converges_on_one_live_runtime() {
        let (r, owner, generation) = registry_with_live_terminal();
        let second = r.begin_start(PROVIDER, "sid", RuntimeOwnerKind::Terminal, "op-2", None, 2_000);
        assert_eq!(second, BeginOutcome::AdoptLive { owner, generation });
        assert!(matches!(r.observe(PROVIDER, "sid").state, OwnershipState::Live { .. }));
    }

    #[test]
    fn stop_crash_and_unfail_release_or_leave_recoverable_typed_state() {
        // Explicit stop: Live -> Stopping -> commit_stop -> Vacant.
        let (r, _owner, _) = registry_with_live_terminal();
        let gen = match r.begin_stop(PROVIDER, "sid", "kill-1", 1) {
            StopOutcome::Granted { generation } => generation,
            other => panic!("expected Granted, got {other:?}"),
        };
        assert_eq!(r.commit_stop(PROVIDER, "sid", "kill-1", gen), CommitOutcome::Committed);
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);

        // Crash (exit-watcher release): Live -> Vacant, generation preserved (monotonic).
        let (r, _, _) = registry_with_live_terminal();
        r.release(PROVIDER, "sid", RuntimeOwnerKind::Terminal);
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);
        assert!(r.observe(PROVIDER, "sid").generation >= 1);

        // Holder panics/never completes: state stays Starting (typed Blocked for the
        // next claimant — recoverable, never a second grant) until force-release.
        let r = RuntimeOwnershipRegistry::new();
        let _ = r.begin_start(PROVIDER, "sid", RuntimeOwnerKind::FreshAgent, "op-zombie", None, 1);
        assert!(matches!(
            r.begin_start(PROVIDER, "sid", RuntimeOwnerKind::Terminal, "op-2", None, 2),
            BeginOutcome::Blocked { .. }
        ));
        r.force_release_for_confirmed_kill(PROVIDER, "sid");
        assert!(matches!(
            r.begin_start(PROVIDER, "sid", RuntimeOwnerKind::Terminal, "op-3", None, 3),
            BeginOutcome::Granted { .. }
        ));
    }

    #[test]
    fn stale_generation_cannot_commit_after_a_later_generation_begins() {
        let r = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation: g1 } =
            r.begin_start(PROVIDER, "sid", RuntimeOwnerKind::Terminal, "op-slow", None, 1)
        else { panic!() };
        // A handoff bumps the generation while op-slow is in flight.
        let BeginOutcome::Granted { .. } =
            r.begin_handoff(PROVIDER, "sid", RuntimeOwnerKind::FreshAgent, "ho-1", None, 2)
        else { panic!() };
        let owner = OwnerIdentity {
            kind: RuntimeOwnerKind::Terminal,
            terminal_id: Some("t-late".into()),
            live_session_key: None,
            pid: None,
            ownership_id: None,
        };
        // The stale starter's commit is refused — it must tear down its own child.
        assert_eq!(
            r.commit_live(PROVIDER, "sid", "op-slow", g1, owner),
            CommitOutcome::StaleGeneration { current_generation: g1 + 1 }
        );
        assert!(matches!(r.observe(PROVIDER, "sid").state, OwnershipState::Handoff { .. }));
    }

    #[test]
    fn handoff_fail_restores_prior_owner_or_vacant() {
        // Prior live owner, handoff fails before the prior was stopped.
        let (r, owner, _) = registry_with_live_terminal();
        let BeginOutcome::Granted { generation: g } =
            r.begin_handoff(PROVIDER, "sid", RuntimeOwnerKind::FreshAgent, "ho-1", None, 2)
        else { panic!() };
        assert_eq!(r.fail(PROVIDER, "sid", "ho-1", g), FailOutcome::RestoredPriorOwner);
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Live { ref o, .. } if *o == owner
        ));
        // No prior: handoff fail -> Vacant.
        let r = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation: g } =
            r.begin_handoff(PROVIDER, "sid", RuntimeOwnerKind::Terminal, "ho-2", None, 1)
        else { panic!() };
        assert_eq!(r.fail(PROVIDER, "sid", "ho-2", g), FailOutcome::Vacant);
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);
    }

    #[test]
    fn distinct_session_refs_start_concurrently() {
        let r = RuntimeOwnershipRegistry::new();
        let a = r.begin_start(PROVIDER, "sid-a", RuntimeOwnerKind::Terminal, "op-a", None, 1);
        let b = r.begin_start(PROVIDER, "sid-b", RuntimeOwnerKind::FreshAgent, "op-b", None, 1);
        assert!(matches!(a, BeginOutcome::Granted { .. }));
        assert!(matches!(b, BeginOutcome::Granted { .. }));
    }

    #[test]
    fn handoff_continuation_grants_target_start_under_same_operation() {
        let r = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation: g } =
            r.begin_handoff(PROVIDER, "sid", RuntimeOwnerKind::Terminal, "ho-1", None, 1)
        else { panic!() };
        // Target start under the handoff's operation_id + to_kind: granted, state stays Handoff.
        let cont = r.begin_start(PROVIDER, "sid", RuntimeOwnerKind::Terminal, "ho-1", None, 2);
        assert_eq!(cont, BeginOutcome::Granted { generation: g });
        assert!(matches!(r.observe(PROVIDER, "sid").state, OwnershipState::Handoff { .. }));
        // A DIFFERENT operation (or wrong kind) is blocked.
        assert!(matches!(
            r.begin_start(PROVIDER, "sid", RuntimeOwnerKind::FreshAgent, "op-x", None, 3),
            BeginOutcome::Blocked { .. }
        ));
    }

    #[test]
    fn same_operation_reclaim_is_granted() {
        // The snapshot compat cold-start (Task 5) claims under its own operation id,
        // then the shared ensure path re-claims under the SAME id: that re-claim
        // must be Granted (it is the same holder, not a second writer).
        let r = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation } =
            r.begin_start(PROVIDER, "sid", RuntimeOwnerKind::FreshAgent, "snap-1", None, 1)
        else { panic!() };
        let re = r.begin_start(PROVIDER, "sid", RuntimeOwnerKind::FreshAgent, "snap-1", None, 2);
        assert_eq!(re, BeginOutcome::Granted { generation });
        // A different op still blocked while snap-1 holds Starting.
        assert!(matches!(
            r.begin_start(PROVIDER, "sid", RuntimeOwnerKind::FreshAgent, "snap-2", None, 3),
            BeginOutcome::Blocked { .. }
        ));
    }

    #[test]
    fn snapshot_records_replay_owner_state_and_released_keys_as_vacant() {
        // kata b8ke reconnect-owner discovery (T1 rec A1): the ready frame's
        // runtimeOwners payload comes from here — live owners replay with
        // their kind, released keys replay as "vacant" so replay CLEARS stale
        // divergence on reconnecting devices.
        let (r, _owner, generation) = registry_with_live_terminal();
        let records = r.snapshot_records();
        assert!(records.iter().any(|rec|
            rec.provider == PROVIDER && rec.session_id == "sid"
                && rec.generation == generation && rec.owner_kind == "terminal"));
        r.release(PROVIDER, "sid", RuntimeOwnerKind::Terminal);
        let records = r.snapshot_records();
        assert!(records.iter().any(|rec|
            rec.provider == PROVIDER && rec.session_id == "sid"
                && rec.generation >= generation && rec.owner_kind == "vacant"));
    }
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-ownership`

Expected: FAIL — every test panics on `todo!()` inside the registry methods (the missing state-machine behavior, not a setup accident). First confirm the crate compiles as a workspace member with `cargo check -p freshell-ownership`.

- [ ] **Step 3: Add the minimal production implementation**

`crates/freshell-ownership/Cargo.toml`:

```toml
# freshell-ownership — the ONE server-wide runtime-ownership coordinator.
#
# Leaf crate (no workspace deps, tokio-free): a sync state machine keyed by
# canonical (provider, sessionId) with monotonic per-key generations. The
# terminal lane and every fresh-agent provider claim/commit/release through
# the single instance minted in freshell-server::main. Async orchestration
# (kills, reap awaits, spawns) lives in the callers; this crate only owns
# the atomic transitions.
[package]
name = "freshell-ownership"
version = "0.1.0"
description = "Server-authoritative runtime-ownership coordinator for canonical (provider, sessionId): one writer, generation fencing, atomic handoff state."
edition.workspace = true
rust-version.workspace = true
publish.workspace = true

[dependencies]
serde = { workspace = true }
tracing = "0.1"
```

`crates/freshell-ownership/src/lib.rs` (implementation above the test module):

```rust
//! # Runtime-ownership coordinator (kata b8ke)
//!
//! One server-authoritative owner per canonical `(provider, sessionId)`,
//! shared by the terminal lane and every Fresh Agent provider. The
//! invariant: at most ONE writer may be `Starting` or `Live` for a key at
//! any moment, and every delayed lifecycle request carries the generation
//! it observed so a stale request can never recreate ownership after a
//! newer generation began.
//!
//! Design notes:
//! - Sync `std::sync::Mutex`, never held across an await; callers inject
//!   this registry exactly like `FreshAgentSessionLeases`
//!   (freshell-server/src/main.rs:318-321).
//! - The per-lane lease maps (`TerminalRegistry::session_ref_leases`,
//!   `FreshAgentSessionLeases`) remain as same-kind/TTL backstops; this
//!   registry is the CROSS-kind authority (and same-kind dedupe) whose
//!   claim happens FIRST in every lifecycle path.
//! - `generation` is per-key monotonic and never resets (Vacant keeps it),
//!   so "stale" is identity-of-generation, not wall clock.
//! - Every transition logs a diagnostic `tracing` event with join fields
//!   as EVENT fields (target-directive filters kill span fields; see
//!   crates/freshell-server/src/logging.rs:30-44).
use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// `retry_after_ms` hint for Blocked outcomes (mirrors the lane leases).
pub const OWNERSHIP_RETRY_AFTER_MS: u64 = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeOwnerKind {
    Terminal,
    FreshAgent,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionKey {
    pub provider: String,
    pub session_id: String,
}

impl SessionKey {
    pub fn new(provider: &str, session_id: &str) -> Self {
        Self { provider: provider.to_string(), session_id: session_id.to_string() }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnerIdentity {
    pub kind: RuntimeOwnerKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live_session_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ownership_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum OwnershipState {
    Vacant,
    Starting { kind: RuntimeOwnerKind, operation_id: String, generation: u64, since_ms: u64 },
    Live { owner: OwnerIdentity, generation: u64 },
    Handoff {
        prior: Option<(OwnerIdentity, u64)>,
        to_kind: RuntimeOwnerKind,
        operation_id: String,
        generation: u64,
        since_ms: u64,
    },
    Stopping { owner: Option<OwnerIdentity>, operation_id: String, generation: u64, since_ms: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BeginOutcome {
    /// The caller holds the lease; it MUST end with `commit_live` (or `fail`).
    Granted { generation: u64 },
    /// A live runtime of the SAME kind exists — adopt/attach, never spawn.
    AdoptLive { owner: OwnerIdentity, generation: u64 },
    /// A live runtime of the OTHER kind owns the key — typed conflict.
    OwnedByOtherKind { owner: OwnerIdentity, generation: u64 },
    /// A lifecycle operation is in flight (Starting/Handoff/Stopping).
    Blocked { state: OwnershipState, retry_after_ms: u64 },
    /// The request observed an older generation than the current record.
    StaleGeneration { current_generation: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommitOutcome {
    Committed,
    StaleGeneration { current_generation: u64 },
    ForeignOperation,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FailOutcome {
    /// A Starting operation was released (key now Vacant).
    Released,
    /// A failed handoff restored the prior live owner.
    RestoredPriorOwner,
    /// A failed handoff had no prior owner (key now Vacant).
    Vacant,
    ForeignOperation,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopOutcome {
    Granted { generation: u64 },
    NotLive { state: OwnershipState },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnershipSnapshot {
    pub generation: u64,
    pub state: OwnershipState,
}

/// One replayed owner record for the `ready.runtimeOwners` handshake field
/// (kata b8ke reconnect-owner discovery, T1 rec A1). `owner_kind` is the
/// wire string "terminal" | "fresh-agent" | "vacant".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeOwnerReplayRecord {
    pub provider: String,
    pub session_id: String,
    pub generation: u64,
    pub owner_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
}

fn kind_wire(kind: &RuntimeOwnerKind) -> String {
    match kind {
        RuntimeOwnerKind::Terminal => "terminal".into(),
        RuntimeOwnerKind::FreshAgent => "fresh-agent".into(),
    }
}

#[derive(Debug, Clone)]
struct SessionRecord {
    generation: u64,
    state: OwnershipState,
}

#[derive(Default)]
pub struct RuntimeOwnershipRegistry {
    inner: Mutex<HashMap<SessionKey, SessionRecord>>,
}

impl RuntimeOwnershipRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn record<'a>(
        inner: &'a mut HashMap<SessionKey, SessionRecord>,
        key: SessionKey,
    ) -> &'a mut SessionRecord {
        inner.entry(key).or_insert(SessionRecord { generation: 0, state: OwnershipState::Vacant })
    }

    /// Atomically begin a start/attach/resume of `kind` for
    /// `(provider, session_id)`. `observed_generation` is the generation a
    /// DELAYED request saw when it decided to act; `None` means the caller
    /// has no stale risk to fence. Entering `Starting` increments the
    /// generation. Re-claiming a `Starting`/`Handoff` held by the SAME
    /// operation and kind is Granted (the snapshot compat cold-start and
    /// the handoff target continuation both rely on this).
    pub fn begin_start(
        &self,
        provider: &str,
        session_id: &str,
        kind: RuntimeOwnerKind,
        operation_id: &str,
        observed_generation: Option<u64>,
        now_ms: u64,
    ) -> BeginOutcome {
        let mut inner = self.inner.lock().expect("ownership lock poisoned");
        let key = SessionKey::new(provider, session_id);
        let record = Self::record(&mut inner, key);
        if let Some(observed) = observed_generation {
            if observed < record.generation {
                tracing::warn!(target: "freshell_ownership",
                    event = "ownership.begin_start.stale_generation",
                    operation_id, provider, session_id,
                    observed_generation = observed, generation = record.generation);
                return BeginOutcome::StaleGeneration { current_generation: record.generation };
            }
        }
        match record.state.clone() {
            OwnershipState::Vacant => {
                record.generation += 1;
                record.state = OwnershipState::Starting {
                    kind,
                    operation_id: operation_id.to_string(),
                    generation: record.generation,
                    since_ms: now_ms,
                };
                tracing::info!(target: "freshell_ownership",
                    event = "ownership.start.begin", operation_id, provider, session_id,
                    kind = ?kind, generation = record.generation);
                BeginOutcome::Granted { generation: record.generation }
            }
            OwnershipState::Starting { kind: held_kind, operation_id: held_op, generation, .. }
                if held_kind == kind && held_op == operation_id =>
            {
                BeginOutcome::Granted { generation }
            }
            OwnershipState::Handoff { to_kind, operation_id: ho_op, generation, .. }
                if to_kind == kind && ho_op == operation_id =>
            {
                BeginOutcome::Granted { generation }
            }
            OwnershipState::Live { owner, generation } if owner.kind == kind => {
                BeginOutcome::AdoptLive { owner, generation }
            }
            OwnershipState::Live { owner, generation } => {
                BeginOutcome::OwnedByOtherKind { owner, generation }
            }
            state => BeginOutcome::Blocked { state, retry_after_ms: OWNERSHIP_RETRY_AFTER_MS },
        }
    }

    /// Atomically enter `Handoff` (incrementing the generation), capturing
    /// the prior live owner for restore-on-failure. Granted from `Vacant`
    /// (no prior to stop) and from `Live` of any kind; `Starting` /
    /// `Handoff` / `Stopping` block.
    pub fn begin_handoff(
        &self,
        provider: &str,
        session_id: &str,
        to_kind: RuntimeOwnerKind,
        operation_id: &str,
        observed_generation: Option<u64>,
        now_ms: u64,
    ) -> BeginOutcome {
        let mut inner = self.inner.lock().expect("ownership lock poisoned");
        let key = SessionKey::new(provider, session_id);
        let record = Self::record(&mut inner, key);
        if let Some(observed) = observed_generation {
            if observed < record.generation {
                return BeginOutcome::StaleGeneration { current_generation: record.generation };
            }
        }
        match record.state.clone() {
            OwnershipState::Vacant => {
                record.generation += 1;
                record.state = OwnershipState::Handoff {
                    prior: None,
                    to_kind,
                    operation_id: operation_id.to_string(),
                    generation: record.generation,
                    since_ms: now_ms,
                };
                tracing::info!(target: "freshell_ownership",
                    event = "ownership.handoff.begin", operation_id, provider, session_id,
                    to_kind = ?to_kind, generation = record.generation);
                BeginOutcome::Granted { generation: record.generation }
            }
            OwnershipState::Live { owner, generation } => {
                let prior = (owner.clone(), generation);
                record.generation += 1;
                record.state = OwnershipState::Handoff {
                    prior: Some(prior),
                    to_kind,
                    operation_id: operation_id.to_string(),
                    generation: record.generation,
                    since_ms: now_ms,
                };
                tracing::info!(target: "freshell_ownership",
                    event = "ownership.handoff.begin", operation_id, provider, session_id,
                    from_kind = ?owner.kind, to_kind = ?to_kind,
                    runtime_id = ?owner.terminal_id, pid = ?owner.pid,
                    generation = record.generation);
                BeginOutcome::Granted { generation: record.generation }
            }
            OwnershipState::Starting { .. } | OwnershipState::Handoff { .. }
            | OwnershipState::Stopping { .. } =>
                BeginOutcome::Blocked { state: record.state.clone(), retry_after_ms: OWNERSHIP_RETRY_AFTER_MS },
        }
    }

    /// Commit a live runtime. Legal from this operation's `Starting`, or
    /// from this operation's `Handoff` (the target writer commit —
    /// generation retained). A stale generation commits nothing: the
    /// caller must tear down its own child.
    pub fn commit_live(
        &self,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        generation: u64,
        owner: OwnerIdentity,
    ) -> CommitOutcome {
        let mut inner = self.inner.lock().expect("ownership lock poisoned");
        let key = SessionKey::new(provider, session_id);
        let Some(record) = inner.get_mut(&key) else {
            return CommitOutcome::ForeignOperation;
        };
        if generation != record.generation {
            tracing::error!(target: "invariant", provider, session_id, operation_id,
                generation, current_generation = record.generation,
                "ownership.commit_live.stale_generation: caller must tear down its child");
            return CommitOutcome::StaleGeneration { current_generation: record.generation };
        }
        match record.state.clone() {
            OwnershipState::Starting { operation_id: op, .. } if op == operation_id => {}
            OwnershipState::Handoff { operation_id: op, to_kind, .. }
                if op == operation_id && to_kind == owner.kind => {}
            _ => return CommitOutcome::ForeignOperation,
        }
        record.state = OwnershipState::Live { owner: owner.clone(), generation };
        tracing::info!(target: "freshell_ownership",
            event = "ownership.live.commit", operation_id, provider, session_id,
            kind = ?owner.kind, runtime_id = ?owner.terminal_id,
            live_session_key = ?owner.live_session_key, pid = ?owner.pid,
            generation);
        CommitOutcome::Committed
    }

    /// Fail an in-flight operation: `Starting` → Vacant; `Handoff` →
    /// restore the prior owner (if any) or Vacant. Foreign operations are
    /// a typed no-op.
    pub fn fail(
        &self,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        generation: u64,
    ) -> FailOutcome {
        let mut inner = self.inner.lock().expect("ownership lock poisoned");
        let key = SessionKey::new(provider, session_id);
        let Some(record) = inner.get_mut(&key) else { return FailOutcome::ForeignOperation };
        if generation != record.generation {
            return FailOutcome::ForeignOperation;
        }
        match record.state.clone() {
            OwnershipState::Starting { operation_id: op, .. } if op == operation_id => {
                record.state = OwnershipState::Vacant;
                FailOutcome::Released
            }
            OwnershipState::Handoff { operation_id: op, prior, .. } if op == operation_id => {
                match prior {
                    Some((owner, gen)) => {
                        record.state = OwnershipState::Live { owner, generation: gen };
                        FailOutcome::RestoredPriorOwner
                    }
                    None => {
                        record.state = OwnershipState::Vacant;
                        FailOutcome::Vacant
                    }
                }
            }
            _ => FailOutcome::ForeignOperation,
        }
    }

    /// Begin an explicit stop (kill): `Live` → `Stopping` (generation+1),
    /// blocking competing starts while the kill is confirmed. `NotLive`
    /// means the caller should still perform its own kill, but skip
    /// `commit_stop` (an in-flight handoff owns the transition).
    pub fn begin_stop(
        &self,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        now_ms: u64,
    ) -> StopOutcome {
        let mut inner = self.inner.lock().expect("ownership lock poisoned");
        let key = SessionKey::new(provider, session_id);
        let Some(record) = inner.get_mut(&key) else {
            return StopOutcome::NotLive { state: OwnershipState::Vacant };
        };
        match record.state.clone() {
            OwnershipState::Live { owner, .. } => {
                record.generation += 1;
                record.state = OwnershipState::Stopping {
                    owner: Some(owner),
                    operation_id: operation_id.to_string(),
                    generation: record.generation,
                    since_ms: now_ms,
                };
                StopOutcome::Granted { generation: record.generation }
            }
            OwnershipState::Vacant => StopOutcome::NotLive { state: OwnershipState::Vacant },
            state => StopOutcome::NotLive { state },
        }
    }

    /// Confirm a stop: `Stopping{op}` → `Vacant` (generation preserved).
    pub fn commit_stop(
        &self,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        generation: u64,
    ) -> CommitOutcome {
        let mut inner = self.inner.lock().expect("ownership lock poisoned");
        let key = SessionKey::new(provider, session_id);
        let Some(record) = inner.get_mut(&key) else { return CommitOutcome::ForeignOperation };
        if generation != record.generation {
            return CommitOutcome::StaleGeneration { current_generation: record.generation };
        }
        match record.state.clone() {
            OwnershipState::Stopping { operation_id: op, .. } if op == operation_id => {
                record.state = OwnershipState::Vacant;
                tracing::info!(target: "freshell_ownership",
                    event = "ownership.stop.commit", operation_id, provider, session_id, generation);
                CommitOutcome::Committed
            }
            _ => CommitOutcome::ForeignOperation,
        }
    }

    /// Exit-watcher hook: `Live{kind}` → `Vacant`, idempotent, any other
    /// state is a no-op (a handoff or stop owns the transition).
    pub fn release(&self, provider: &str, session_id: &str, kind: RuntimeOwnerKind) {
        let mut inner = self.inner.lock().expect("ownership lock poisoned");
        let key = SessionKey::new(provider, session_id);
        if let Some(record) = inner.get_mut(&key) {
            if let OwnershipState::Live { owner, generation } = record.state.clone() {
                if owner.kind == kind {
                    record.state = OwnershipState::Vacant;
                    tracing::info!(target: "freshell_ownership",
                        event = "ownership.released", provider, session_id,
                        kind = ?kind, generation);
                }
            }
        }
    }

    /// Only after the holder's entire process tree death was confirmed
    /// (the lane TTL paths' kill-before-release contract).
    pub fn force_release_for_confirmed_kill(&self, provider: &str, session_id: &str) {
        let mut inner = self.inner.lock().expect("ownership lock poisoned");
        if let Some(record) = inner.get_mut(&SessionKey::new(provider, session_id)) {
            record.state = OwnershipState::Vacant;
        }
    }

    /// Side-effect-free read for snapshot GETs and reconcile verdicts.
    pub fn observe(&self, provider: &str, session_id: &str) -> OwnershipSnapshot {
        let inner = self.inner.lock().expect("ownership lock poisoned");
        match inner.get(&SessionKey::new(provider, session_id)) {
            Some(record) => OwnershipSnapshot { generation: record.generation, state: record.state.clone() },
            None => OwnershipSnapshot { generation: 0, state: OwnershipState::Vacant },
        }
    }

    /// Replay every recorded key's current owner (kata b8ke): the WS
    /// handshake builder serializes this into `ready.runtimeOwners` so a
    /// device that missed a handoff broadcast (offline during handoff,
    /// lag-4008 disconnect, page reload) learns the authoritative owner on
    /// reconnect. Vacant keys replay as "vacant" to CLEAR stale divergence.
    /// Sync; the lock is never held across an await.
    pub fn snapshot_records(&self) -> Vec<RuntimeOwnerReplayRecord> {
        let inner = self.inner.lock().expect("ownership lock poisoned");
        inner
            .iter()
            .map(|(key, record)| {
                let (owner_kind, terminal_id) = match &record.state {
                    OwnershipState::Vacant => ("vacant".to_string(), None),
                    OwnershipState::Live { owner, .. } => {
                        (kind_wire(&owner.kind), owner.terminal_id.clone())
                    }
                    OwnershipState::Starting { kind, .. } => (kind_wire(kind), None),
                    OwnershipState::Handoff { to_kind, .. } => (kind_wire(to_kind), None),
                    OwnershipState::Stopping { owner, .. } => match owner {
                        Some(owner) => (kind_wire(&owner.kind), owner.terminal_id.clone()),
                        None => ("vacant".to_string(), None),
                    },
                };
                RuntimeOwnerReplayRecord {
                    provider: key.provider.clone(),
                    session_id: key.session_id.clone(),
                    generation: record.generation,
                    owner_kind,
                    terminal_id,
                }
            })
            .collect()
    }
}
```

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-ownership`

Expected: PASS (all coordinator unit tests green).

- [ ] **Step 5: Refactor while green**

No refactor needed — a single-purpose leaf crate with one file and a colocated test module follows the repo's in-src convention.

- [ ] **Step 6: Run impacted-test verification**

This crate has no consumers yet; the impacted set is the workspace compile plus the crate itself.

Run: `cargo check --workspace && cargo test -p freshell-ownership`

Expected: PASS (workspace still compiles — no other crate references the new one yet).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ownership Cargo.lock
git commit -m "feat(ownership): add freshell-ownership coordinator crate with generation fencing"
```

---

### Task 2: Wire-protocol additions — `session.runtimeOwner` broadcast, typed owner fields, `observedGeneration`

**Files:**
- Modify: `shared/ws-protocol.ts` (`ServerMessage` union ~1581-1639; `ErrorMessage` ~1066-1080; `ReadyMessage` ~1047-1059; `TerminalCreateSchema` ~465-480; `FreshAgentCreateSchema` in the client→server union ~751-902)
- Regenerate: `port/contract/ws-protocol.schema.json`, `port/contract/ws-message-inventory.json`, `port/contract/ws-server-messages.schema.json` (via `npm run contract:generate`)
- Modify: `crates/freshell-protocol/src/server_messages.rs` (new variant + struct; `ErrorMessage` fields; `Ready.runtime_owners` + `RuntimeOwnerReplay` struct; `SERVER_MESSAGE_TYPES` const + module-doc count)
- Modify: `crates/freshell-protocol/tests/inventory.rs` (count assertions 64→65 / 104→105, per the Global Constraints regen procedure)
- Modify: `crates/freshell-protocol/src/client_messages.rs` (`TerminalCreate.observed_generation`, `FreshAgentCreate.observed_generation`)
- Test: in-src round-trip tests in `crates/freshell-protocol/src/{server_messages,client_messages}.rs`; `test/unit/port/ws-contract-freeze.test.ts` (runs under `config/vitest/vitest.port.config.ts` — the default config excludes `test/unit/port/**`)

**Interfaces:**
- Consumes: Task 1 `RuntimeOwnerKind` serde shape (`"terminal"`/`"fresh-agent"`).
- Produces (used by Tasks 3-9):
  - TS `SessionRuntimeOwnerMessage = { type: 'session.runtimeOwner'; provider: string; sessionId: string; generation: number; ownerKind: 'terminal' | 'fresh-agent' | 'vacant'; previousKind?: 'terminal' | 'fresh-agent'; terminalId?: string; operationId: string; transition: 'handoff-started' | 'handoff-committed' | 'handoff-failed' | 'released'; reason?: string }` (member of `ServerMessage`)
  - TS `ErrorMessage` gains `ownerKind?: 'terminal' | 'fresh-agent'` and `ownerGeneration?: number`
  - TS `ReadyMessage` gains `runtimeOwners?: Array<{ provider: string; sessionId: string; generation: number; ownerKind: 'terminal' | 'fresh-agent' | 'vacant'; terminalId?: string }>` (omit-when-empty; frozen-client inert — the `buildId`/`bootId` doctrine; the reconnect-owner replay, T1 rec A2)
  - TS `TerminalCreateSchema` and `FreshAgentCreateSchema` gain `observedGeneration: z.number().int().nonnegative().optional()`
  - Rust `ServerMessage::SessionRuntimeOwner(SessionRuntimeOwner)`; `ErrorMessage { owner_kind: Option<String>, owner_generation: Option<u64> }`; `Ready { runtime_owners: Option<Vec<RuntimeOwnerReplay>> }` with the protocol-local `RuntimeOwnerReplay { provider, session_id, generation, owner_kind, terminal_id }`; `TerminalCreate { observed_generation: Option<u64> }`; `FreshAgentCreate { observed_generation: Option<u64> }`

- [ ] **Step 1: Write the failing behavioral tests**

Append to the test module in `crates/freshell-protocol/src/server_messages.rs`:

```rust
#[test]
fn session_runtime_owner_frame_round_trips_with_the_frozen_tag() {
    let msg = ServerMessage::SessionRuntimeOwner(SessionRuntimeOwner {
        provider: "codex".into(),
        session_id: "01a0828d".into(),
        generation: 7,
        owner_kind: "terminal".into(),
        previous_kind: Some("fresh-agent".into()),
        terminal_id: Some("t-91".into()),
        operation_id: "handoff-abc".into(),
        transition: "handoff-committed".into(),
        reason: None,
    });
    let json = serde_json::to_string(&msg).expect("serialize");
    assert!(json.contains(r#""type":"session.runtimeOwner""#), "wire tag must be exact: {json}");
    let back: ServerMessage = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(back, msg);
}

#[test]
fn error_message_accepts_additive_owner_fields_without_changing_the_frozen_text() {
    let msg = ServerMessage::Error(Error {
        // Fill ONLY the fields the existing Error struct defines, plus the two
        // new additive ones; keep the frozen message text byte-for-byte.
        code: ErrorCode::RestoreUnavailable,
        message: "Session 01a0828d is still running on the server.".into(),
        request_id: Some("req-1".into()),
        retry_after_ms: None,
        live_terminal_id: None,
        owner_kind: Some("fresh-agent".into()),
        owner_generation: Some(7),
    });
    let json = serde_json::to_string(&msg).expect("serialize");
    assert!(json.contains(r#""ownerKind":"fresh-agent""#));
    assert!(json.contains("is still running on the server."));
    let back: ServerMessage = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(back, msg);
}

#[test]
fn ready_frame_round_trips_additive_runtime_owners() {
    // kata b8ke reconnect-owner discovery (T1 rec A2): the ready frame
    // replays current runtime-owner state; omit-when-empty keeps legacy
    // frames byte-identical. Match `Ready`'s real field set
    // (server_messages.rs:902-920: timestamp/boot_id/server_instance_id/
    // build_id/capabilities).
    let msg = ServerMessage::Ready(Ready {
        timestamp: "2026-09-09T00:00:00Z".into(),
        boot_id: Some("boot-1".into()),
        server_instance_id: Some("inst-1".into()),
        build_id: None,
        capabilities: None,
        runtime_owners: Some(vec![RuntimeOwnerReplay {
            provider: "codex".into(),
            session_id: "01a0828d".into(),
            generation: 4,
            owner_kind: "terminal".into(),
            terminal_id: Some("t-91".into()),
        }]),
    });
    let json = serde_json::to_string(&msg).expect("serialize");
    assert!(json.contains(r#""runtimeOwners":"#), "wire tag must be exact: {json}");
    let back: ServerMessage = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(back, msg);
    let legacy = ServerMessage::Ready(Ready {
        timestamp: "2026-09-09T00:00:00Z".into(),
        boot_id: Some("boot-1".into()),
        server_instance_id: Some("inst-1".into()),
        build_id: None,
        capabilities: None,
        runtime_owners: None,
    });
    let legacy_json = serde_json::to_string(&legacy).expect("serialize");
    assert!(!legacy_json.contains("runtimeOwners"),
        "omit-when-empty keeps legacy ready frames byte-identical: {legacy_json}");
}
```

And to the test module in `crates/freshell-protocol/src/client_messages.rs`:

```rust
#[test]
fn terminal_create_and_fresh_agent_create_accept_observed_generation() {
    let json = r#"{"type":"terminal.create","requestId":"r1","mode":"codex","shell":"system","observedGeneration":4}"#;
    let msg: ClientMessage = serde_json::from_str(json).expect("parse");
    match msg {
        ClientMessage::TerminalCreate(c) => assert_eq!(c.observed_generation, Some(4)),
        other => panic!("wrong variant: {other:?}"),
    }
    // Omitted field still parses (additive-optional, old clients unaffected).
    let json_legacy = r#"{"type":"terminal.create","requestId":"r2","mode":"codex","shell":"system"}"#;
    assert!(serde_json::from_str::<ClientMessage>(json_legacy).is_ok());
}
```

(Match the two structs' real existing field sets — `TerminalCreate` is at `client_messages.rs:275`; `FreshAgentCreate` nearby. The tests pin wire tags and additive-optional parsing only.)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-protocol session_runtime_owner_frame_round_trips error_message_accepts_additive_owner_fields ready_frame_round_trips terminal_create_and_fresh_agent_create_accept_observed_generation`

Expected: FAIL — compile errors: `SessionRuntimeOwner`, `owner_kind`, `owner_generation`, `observed_generation`, `RuntimeOwnerReplay`, `runtime_owners` do not exist yet. That missing-surface failure is the intended red.

- [ ] **Step 3: Add the minimal production implementation**

`shared/ws-protocol.ts` — add near `FreshAgentServerMessage` (~1620):

```ts
export type SessionRuntimeOwnerMessage = {
  type: 'session.runtimeOwner'
  provider: string
  sessionId: string
  generation: number
  ownerKind: 'terminal' | 'fresh-agent' | 'vacant'
  previousKind?: 'terminal' | 'fresh-agent'
  terminalId?: string
  operationId: string
  transition: 'handoff-started' | 'handoff-committed' | 'handoff-failed' | 'released'
  reason?: string
}
```

Add `| SessionRuntimeOwnerMessage` to the `ServerMessage` union. Extend `ErrorMessage` with `ownerKind?: 'terminal' | 'fresh-agent'` and `ownerGeneration?: number`. Extend `TerminalCreateSchema` and `FreshAgentCreateSchema` with `observedGeneration: z.number().int().nonnegative().optional()`. Then regenerate the contract:

```bash
npm run contract:generate
```

`crates/freshell-protocol/src/server_messages.rs` — mirror the generated schema:

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionRuntimeOwner {
    pub provider: String,
    pub session_id: String,
    pub generation: u64,
    /// "terminal" | "fresh-agent" | "vacant"
    pub owner_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    pub operation_id: String,
    /// "handoff-started" | "handoff-committed" | "handoff-failed" | "released"
    pub transition: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}
```

plus `#[serde(rename = "session.runtimeOwner")] SessionRuntimeOwner(SessionRuntimeOwner),` in the `ServerMessage` enum, and the two additive optional fields on `ErrorMessage` (`owner_kind`, `owner_generation`, both `#[serde(skip_serializing_if = "Option::is_none")]`, camelCase per the struct's existing `rename_all`). In `client_messages.rs`, add `#[serde(default, skip_serializing_if = "Option::is_none")] pub observed_generation: Option<u64>` to `TerminalCreate` and `FreshAgentCreate` (both already camelCase-renamed at struct level).

`ReadyMessage` (both sides) — the reconnect-owner replay (kata b8ke, T1 rec A2; chosen over a follow-up broadcast batch or a query endpoint because the one frame every reconnect is guaranteed to process closes all three miss windows — offline-during-handoff, lag-4008, page reload — with zero extra round-trips): in `shared/ws-protocol.ts`, extend `ReadyMessage` (~:1047-1059) with

```ts
  /** kata b8ke: current runtime-owner state for every recorded
   *  (provider, sessionId) — replayed so a device that missed a handoff
   *  broadcast (offline, lag-4008, reload) learns the authoritative owner
   *  from the handshake alone. Omitted from the wire when empty. */
  runtimeOwners?: Array<{
    provider: string
    sessionId: string
    generation: number
    ownerKind: 'terminal' | 'fresh-agent' | 'vacant'
    terminalId?: string
  }>
```

and in `crates/freshell-protocol/src/server_messages.rs`, extend `Ready` (~:902-920) with the additive field plus its protocol-local payload struct (`freshell-protocol` stays serde-only with no workspace deps — the emission site converts from `freshell_ownership::RuntimeOwnerReplayRecord`):

```rust
    /// kata b8ke reconnect-owner discovery: current runtime-owner state for
    /// every recorded (provider, sessionId), so a device that missed a
    /// handoff broadcast (offline, lag-4008, page reload) learns the
    /// authoritative owner from the handshake alone. Omitted when None
    /// (frozen-client inertness — same rule as `boot_id`/`build_id`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_owners: Option<Vec<RuntimeOwnerReplay>>,
```

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeOwnerReplay {
    pub provider: String,
    pub session_id: String,
    pub generation: u64,
    /// "terminal" | "fresh-agent" | "vacant"
    pub owner_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
}
```

(The Node legacy server may omit the field — it is optional.)

Rust-side inventory expectations (per the Global Constraints regen procedure, validated by T4): append `"session.runtimeOwner"` to `SERVER_MESSAGE_TYPES` and grow the const `[&str; 64]` → `[&str; 65]`; correct the module doc's discriminant count to the post-change reality (65 frozen types, 66 enum variants including the `durability.degraded` extension — the doc's current "63" is stale); in `crates/freshell-protocol/tests/inventory.rs`, update `serverToClient` 64 → 65 in BOTH spots (the json `count` assertion and `actual.len()`) and the combined surface 104 → 105 (the `all.len()` assertion and the json assertion).

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-ownership && cargo test -p freshell-protocol && npm run test:vitest -- run test/unit/port/ws-contract-freeze.test.ts --config config/vitest/vitest.port.config.ts`

Expected: PASS — round-trips green (including the inventory count tests at 65/105); the freeze test green against the regenerated committed artifacts (the port config is the one that includes `test/unit/port/**`; the default vitest config excludes it).

- [ ] **Step 5: Refactor while green**

None needed — additive types only. Confirm `WS_PROTOCOL_VERSION` stays **10** (current version, `shared/ws-version.ts`; no bump — nothing new is awaited; the new broadcast is fire-and-forget, folded reactively like `freshAgent.turn.complete`, and the ready replay is an additive-optional field on an existing frame, the `buildId`/`bootId` doctrine).

- [ ] **Step 6: Run impacted-test verification**

Impacted: every consumer of `ServerMessage`/`ClientMessage` parsing (compile-level) and the contract surface.

Run: `cargo check --workspace && npm run test:vitest -- run test/unit/port --config config/vitest/vitest.port.config.ts`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add shared/ws-protocol.ts port/contract crates/freshell-protocol
git commit -m "feat(protocol): session.runtimeOwner broadcast + typed owner fields + observedGeneration"
```

### Task 3: Coordinator wiring I — single instance + Fresh Agent lane (codex/claude/opencode)

**Files:**
- Modify: `crates/freshell-freshagent/Cargo.toml` (dep on `freshell-ownership`)
- Modify: `crates/freshell-freshagent/src/lib.rs` (`FreshAgentState` gains `ownership` + `with_ownership`; `pub mod ownership_lane`; module registration for the new test file)
- Modify: `crates/freshell-freshagent/src/codex.rs`, `crates/freshell-freshagent/src/claude.rs`, `crates/freshell-freshagent/src/opencode_ws.rs` (claim/commit/fail/kill/release at the anchors below)
- Modify: `crates/freshell-ws/Cargo.toml` (dep on `freshell-ownership` — for the reconcile guard below; Task 4 then only adds the `WsState` field)
- Modify: `crates/freshell-ws/src/reconcile_freshagent.rs` (owner-aware respawn-counter guard in `build_snapshot`)
- Modify: `crates/freshell-server/src/main.rs` (mint ONE `RuntimeOwnershipRegistry` next to `fresh_agent_leases` :318-321; inject everywhere)
- Test: `crates/freshell-freshagent/src/ownership_wiring_tests.rs` (new `#[path]` module)
- Test: `crates/freshell-ws/tests/cross_kind_liveness.rs` (one new test on the existing harness)

**Interfaces:**
- Consumes: Task 1 registry API; Task 2 `FreshAgentCreate.observed_generation`.
- Produces:
  - `freshell_freshagent::ownership_lane::{claim_fresh_agent_ownership, commit_fresh_agent_ownership, fail_fresh_agent_ownership, stop_fresh_agent_ownership}` (signatures in Step 3).
  - `FreshAgentState::with_ownership(Arc<RuntimeOwnershipRegistry>) -> Self`; `FreshCodexState::set_ownership(...)`, `FreshClaudeState::set_ownership(...)`, `FreshOpencodeState::set_ownership(...)` (Option-injected: `None` = every pre-existing test unchanged).
  - `ownership_snapshot(&self, provider, session_id) -> freshell_ownership::OwnershipSnapshot` convenience on each fresh state (Vacant/0 default when un-injected) — Tasks 5-7 assert through it, and Task 3's reconcile guard reads it.
  - The reconcile respawn-counter guard: `reconcile_freshagent::build_snapshot` consults the coordinator (via each fresh state's `ownership_snapshot`) when building presence facts — when the key is `Live{Terminal}` or any transition state (`Starting`/`Handoff`/`Stopping`), the respawn ANSWER does not burn the per-pane respawn counter (the `freshAgent.create` it arms would be typed-refused by the coordinator anyway), so reconnecting divergent panes can never march toward a false `dead_session{respawn_exhausted}`. The VERDICT shape is unchanged (frozen-client compatible); the client-side divergence gate lives in Task 8.

- [ ] **Step 0: Provision the worktree test environment**

Run: `npm install` (in the worktree root)

Expected: `node_modules/` exists in the worktree. Rust integration suites that spawn claude-mode terminals (every `cross_kind_liveness` test) resolve the MCP `tsx` loader through `<repo_root>/node_modules/tsx/dist/loader.mjs` (`crates/freshell-platform/src/mcp_inject.rs:131-160`); without it every such create fails with `PTY_SPAWN_FAILED` regardless of code state (validated by T4: the two pre-existing claude-owner `cross_kind_liveness` tests are red in a bare worktree and green from main — `node_modules` provisioning is the remedy). One-time per worktree; skip if `node_modules/tsx/dist/loader.mjs` already resolves.

- [ ] **Step 1: Write the failing behavioral tests**

New file `crates/freshell-freshagent/src/ownership_wiring_tests.rs` (registered in `lib.rs` as `#[cfg(test)] #[path = "ownership_wiring_tests.rs"] mod ownership_wiring_tests;`):

```rust
//! Fresh-agent-lane coordinator wiring (kata b8ke Task 3).
//!
//! Drives the SHARED claim helpers with a bare registry — no sidecar, no
//! server — proving the lane's claim/commit/fail/stop semantics map 1:1 onto
//! the coordinator states. The live-path integration (a real create/kill
//! driving the same helpers) is pinned in
//! freshell-ws/tests/cross_kind_liveness.rs.
use std::sync::Arc;

use freshell_ownership::{BeginOutcome, CommitOutcome, OwnershipState, RuntimeOwnerKind};

use crate::ownership_lane::{
    claim_fresh_agent_ownership, commit_fresh_agent_ownership, fail_fresh_agent_ownership,
    stop_fresh_agent_ownership,
};

fn owner_fresh(key: &str) -> freshell_ownership::OwnerIdentity {
    freshell_ownership::OwnerIdentity {
        kind: RuntimeOwnerKind::FreshAgent,
        terminal_id: None,
        live_session_key: Some(key.to_string()),
        pid: Some(991),
        ownership_id: Some("own-1".into()),
    }
}

#[test]
fn fresh_agent_claim_then_commit_is_live_then_kill_releases() {
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    let BeginOutcome::Granted { generation } =
        claim_fresh_agent_ownership(&registry, "codex", "sid-1", "op-1", None, 1)
    else { panic!("expected Granted") };
    assert_eq!(
        commit_fresh_agent_ownership(&registry, "codex", "sid-1", "op-1", generation, owner_fresh("freshcodex:sid-1")),
        CommitOutcome::Committed
    );
    assert!(matches!(
        registry.observe("codex", "sid-1").state,
        OwnershipState::Live { .. }
    ));
    // Kill path: Live{fresh-agent} -> Stopping -> Vacant.
    stop_fresh_agent_ownership(&registry, "codex", "sid-1", "kill-1", 2);
    assert_eq!(registry.observe("codex", "sid-1").state, OwnershipState::Vacant);
}

#[test]
fn fresh_agent_claim_fails_typed_when_terminal_owns() {
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    let BeginOutcome::Granted { generation } =
        registry.begin_start("codex", "sid-2", RuntimeOwnerKind::Terminal, "term-op", None, 1)
    else { panic!() };
    let t = freshell_ownership::OwnerIdentity {
        kind: RuntimeOwnerKind::Terminal,
        terminal_id: Some("t-1".into()),
        live_session_key: None,
        pid: None,
        ownership_id: None,
    };
    registry.commit_live("codex", "sid-2", "term-op", generation, t);
    // The fresh-agent lane's claim must see the typed cross-kind conflict.
    let claim = claim_fresh_agent_ownership(&registry, "codex", "sid-2", "op-2", None, 2);
    assert!(matches!(claim, BeginOutcome::OwnedByOtherKind { .. }));
}

#[test]
fn fresh_agent_fail_reopens_the_key() {
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    let BeginOutcome::Granted { generation } =
        claim_fresh_agent_ownership(&registry, "opencode", "ses-3", "op-3", None, 1)
    else { panic!() };
    assert_eq!(
        fail_fresh_agent_ownership(&registry, "opencode", "ses-3", "op-3", generation),
        freshell_ownership::FailOutcome::Released
    );
    let retry = claim_fresh_agent_ownership(&registry, "opencode", "ses-3", "op-4", None, 2);
    assert!(matches!(retry, BeginOutcome::Granted { .. }));
}
```

And in `crates/freshell-ws/tests/cross_kind_liveness.rs` (following the file's existing `ENV_LOCK` + `FakeSidecarEnv` discipline; extend `spawn_server` to also return a `WsState` clone the way `tests/common/mod.rs::spawn_server_with_specs_hub_and_state` does — the file hand-builds `WsState`, so add the clone to its return tuple, and mint ONE `RuntimeOwnershipRegistry` in the harness injected exactly like `main.rs` — `set_ownership` on the three fresh states, plus `WsState.ownership` from Task 4 on — so the coordinator is live for these tests):

```rust
/// kata b8ke Task 3: a real freshclaude create/kill drives the shared
/// coordinator — Live{FreshAgent} while alive, Vacant after the awaited kill.
#[tokio::test]
async fn fresh_agent_create_and_kill_drive_the_shared_coordinator() {
    let _env = ENV_LOCK.lock().await;
    let sidecar = FakeSidecarEnv::install().await;
    let (server, url) = spawn_server().await;
    let ws = connect(url).await;
    let sid = format!("coord-{}", uuid::Uuid::new_v4());
    send_json(&ws, json!({
        "type": "freshAgent.create", "requestId": "req-coord-1",
        "sessionType": "freshclaude", "provider": "claude",
        "sessionRef": { "provider": "claude", "sessionId": sid },
    })).await;
    let _created = await_frame(&ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("freshAgent.created")
    }).await.expect("created");
    let snap = server.ws_state.fresh_claude.ownership_snapshot("claude", &sid);
    assert!(matches!(snap.state, freshell_ownership::OwnershipState::Live { .. }),
        "expected Live fresh-agent owner, got {:?}", snap.state);
    send_json(&ws, json!({
        "type": "freshAgent.kill", "sessionId": sid,
        "sessionType": "freshclaude", "provider": "claude",
    })).await;
    let _killed = await_frame(&ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("freshAgent.killed")
            && v.get("sessionId").and_then(|s| s.as_str()) == Some(sid.as_str())
    }).await.expect("killed");
    let snap = server.ws_state.fresh_claude.ownership_snapshot("claude", &sid);
    assert_eq!(snap.state, freshell_ownership::OwnershipState::Vacant,
        "kill must release ownership");
    let _ = sidecar;
}
```

And in `crates/freshell-ws/src/reconcile_freshagent.rs`'s in-src `mod tests` — the owner-aware respawn-counter guard (kata b8ke reconnect convergence, T1 rec A6):

```rust
#[test]
fn respawn_counter_does_not_burn_when_the_coordinator_owns_elsewhere() {
    use freshell_ownership::{OwnershipState, RuntimeOwnerKind};
    fn owner_of(kind: RuntimeOwnerKind) -> freshell_ownership::OwnerIdentity {
        freshell_ownership::OwnerIdentity {
            kind,
            terminal_id: Some("t-1".into()),
            live_session_key: None,
            pid: None,
            ownership_id: None,
        }
    }
    // Live same-kind (fresh-agent): respawn still burns (a same-kind rebind).
    assert!(!respawn_burn_skipped(&OwnershipState::Live {
        owner: owner_of(RuntimeOwnerKind::FreshAgent), generation: 1,
    }));
    // Live cross-kind (terminal): the armed create is typed-refused — no burn.
    assert!(respawn_burn_skipped(&OwnershipState::Live {
        owner: owner_of(RuntimeOwnerKind::Terminal), generation: 2,
    }));
    // A lifecycle transition in flight: no burn.
    assert!(respawn_burn_skipped(&OwnershipState::Handoff {
        prior: None, to_kind: RuntimeOwnerKind::Terminal,
        operation_id: "ho-1".into(), generation: 3, since_ms: 0,
    }));
    // Vacant: normal respawn accounting.
    assert!(!respawn_burn_skipped(&OwnershipState::Vacant));
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-freshagent ownership_wiring && cargo test -p freshell-ws --test cross_kind_liveness fresh_agent_create_and_kill && cargo test -p freshell-ws respawn_counter_does_not_burn`

Expected: FAIL — compile errors first (`ownership_lane`, `set_ownership`, `ownership_snapshot`, `respawn_burn_skipped` missing); once the module exists with `todo!()` wiring, the integration test fails at the `Live` assertion (`observe()` returns Vacant after `freshAgent.created` because the create path does not claim yet — the behavioral red) and the guard test fails while `respawn_burn_skipped` is unimplemented.

- [ ] **Step 3: Add the minimal production implementation**

1. `crates/freshell-freshagent/Cargo.toml`: add `freshell-ownership = { path = "../freshell-ownership" }`.

2. `crates/freshell-freshagent/src/lib.rs` — new module + injection plumbing:

```rust
use freshell_ownership::RuntimeOwnershipRegistry;

/// One call shape for every fresh-agent provider's coordinator claim. The
/// claim happens FIRST (before the provider lease) at every lifecycle entry
/// point — the coordinator is the cross-kind authority; the provider lease
/// stays as the same-kind/TTL backstop.
pub mod ownership_lane {
    use std::sync::Arc;

    use freshell_ownership::{
        BeginOutcome, CommitOutcome, FailOutcome, OwnerIdentity, RuntimeOwnershipRegistry,
        RuntimeOwnerKind, StopOutcome,
    };

    pub fn claim_fresh_agent_ownership(
        registry: &Arc<RuntimeOwnershipRegistry>,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        observed_generation: Option<u64>,
        now_ms: u64,
    ) -> BeginOutcome {
        registry.begin_start(
            provider, session_id, RuntimeOwnerKind::FreshAgent,
            operation_id, observed_generation, now_ms,
        )
    }

    pub fn commit_fresh_agent_ownership(
        registry: &Arc<RuntimeOwnershipRegistry>,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        generation: u64,
        owner: OwnerIdentity,
    ) -> CommitOutcome {
        registry.commit_live(provider, session_id, operation_id, generation, owner)
    }

    pub fn fail_fresh_agent_ownership(
        registry: &Arc<RuntimeOwnershipRegistry>,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        generation: u64,
    ) -> FailOutcome {
        registry.fail(provider, session_id, operation_id, generation)
    }

    /// Kill path: Live{fresh-agent} -> Stopping -> Vacant after confirmed
    /// exit. NotLive (e.g. an in-flight handoff owns the transition) still
    /// proceeds with the provider's own kill; the handoff drives the final
    /// state.
    pub fn stop_fresh_agent_ownership(
        registry: &Arc<RuntimeOwnershipRegistry>,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        now_ms: u64,
    ) {
        if let StopOutcome::Granted { generation } =
            registry.begin_stop(provider, session_id, operation_id, now_ms)
        {
            let _ = registry.commit_stop(provider, session_id, operation_id, generation);
        }
    }
}
```

Add to `FreshAgentState` (and mirror the field+setter on `FreshCodexState`, `FreshClaudeState`, `FreshOpencodeState`, following `set_session_leases`'s exact shape — all `Option`-injected so every pre-existing test is unchanged):

```rust
    /// The ONE server-wide runtime-ownership coordinator (kata b8ke),
    /// wired from freshell-server::main next to `fresh_agent_leases`.
    /// `None` (every pre-existing test) = the lane skips coordinator
    /// bookkeeping and keeps its current probe-based behavior only.
    pub(crate) ownership: Option<Arc<RuntimeOwnershipRegistry>>,

    pub fn with_ownership(
        mut self,
        ownership: Arc<RuntimeOwnershipRegistry>,
    ) -> Self {
        self.ownership = Some(ownership);
        self
    }
```

plus `ownership_snapshot(&self, provider: &str, session_id: &str) -> freshell_ownership::OwnershipSnapshot` on each state (delegating to the injected registry; `Vacant`/0 default when `None`).

3. Wire the claim points. At each anchor below, insert the coordinator claim IMMEDIATELY BEFORE the existing `FreshAgentSessionLeases` claim (coordinator first — it closes the cross-kind window), and thread `(operation_id, generation)` through to the commit/fail points:

- `codex.rs` `ensure_session_resumable` (~:4266, right after the terminal-liveness precheck :4259-4265): extend the signature with two parameters — `observed_generation: Option<u64>` and `handoff: Option<(&str /*operation_id*/, u64 /*generation*/)>`; every existing caller passes `(None, None)`. Claim with `operation_id = &resume_request_id`. On `OwnedByOtherKind`/`Blocked` → return `ResumeSessionError::Reserved` (existing typed variant — same wire behavior). On `Granted { generation }` → proceed to the existing fresh lease claim. On the handoff continuation (`handoff` is `Some`), skip the claim — the runner already holds it.
- `codex.rs` commit: at the `register_live_session` call sites inside `ensure_session_resumable` (~:4478-4500) and the create-resume lane (`handle_create`/`handle_create_resume`, ~:931-1025) → `commit_fresh_agent_ownership(..., OwnerIdentity { kind: FreshAgent, live_session_key: <sessions-map key>, pid: <sidecar child pid>, ownership_id })`. On `StaleGeneration`/`ForeignOperation` → tear down the just-registered session exactly like the existing `commit_session_claim`-refusal path (kill sidecar, no binding) plus `tracing::error!(target: "invariant", ...)`.
- `codex.rs` fail: wherever the fresh lease `fail()` fires in those flows → `fail_fresh_agent_ownership`.
- `codex.rs` `handle_kill` (~:2837): `stop_fresh_agent_ownership(..., &format!("kill-{}", session_id), now_ms())` BEFORE the existing kill body (its NotLive branch is safe mid-handoff).
- `codex.rs` `ensure_session_alive` (~:3160-3264) and `handle_attach` (~:2971): same claim/commit pattern (crash recovery claims too — the crash-respawn's NEW thread id is a NEW canonical key; the old key is released by the exit watcher).
- `claude.rs`: the three lease-claim regions (:729-770, :2783, :3674), `handle_kill` (:1160), `handle_attach` (:3628) — identical shape (provider `"claude"`).
- `opencode_ws.rs`: `resume_durable_session` claim (~:2868-2895, after the refusal precheck :2862-2866), commit where the durable row registers; `handle_kill` (~:1234) via `stop_fresh_agent_ownership` (never touching the shared serve); `handle_attach` re-key commit (~:2804-2808); the `lib.rs` send-keys placeholder→durable materialization commits `Live{FreshAgent}` for the minted `ses_*` id (provider `"opencode"`). OpenCode passes `pid: None` and NEVER a kill handle.
- Every exit watcher that today calls `leases.clear_binding(...)` on natural exit also calls `registry.release(provider, sid, RuntimeOwnerKind::FreshAgent)` (codex exit watcher in `register_live_session` ~:4601-4665; claude and opencode equivalents).

4. `crates/freshell-server/src/main.rs` — mint the ONE instance and inject (follow the `fresh_agent_leases` block :318-321 verbatim):

```rust
    // kata b8ke: the ONE server-wide runtime-ownership coordinator shared
    // by the terminal lane and every fresh-agent provider.
    let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    fresh_codex_state.set_ownership(Arc::clone(&ownership));
    fresh_claude_state.set_ownership(Arc::clone(&ownership));
    fresh_opencode_state.set_ownership(Arc::clone(&ownership));
```

and thread it into the `FreshAgentState` builder chain (`.with_ownership(Arc::clone(&ownership))`) where the REST state is constructed (~:343). The `WsState` field is added in Task 4.

5. `crates/freshell-ws/src/reconcile_freshagent.rs` — the owner-aware respawn-counter guard (kata b8ke reconnect convergence, T1 rec A6): extract the burn-skip decision into a pure file-local helper,

```rust
/// kata b8ke: skip the respawn-counter burn when the coordinator shows the
/// key owned by the OTHER kind or transitioning — the freshAgent.create the
/// respawn verdict arms would be typed-refused anyway, and burning would let
/// reconnect loops march a divergent pane toward a false
/// `dead_session{respawn_exhausted}`.
fn respawn_burn_skipped(state: &freshell_ownership::OwnershipState) -> bool {
    use freshell_ownership::OwnershipState;
    matches!(
        state,
        OwnershipState::Live { owner, .. }
            if owner.kind == freshell_ownership::RuntimeOwnerKind::Terminal
    ) || matches!(
        state,
        OwnershipState::Starting { .. } | OwnershipState::Handoff { .. } | OwnershipState::Stopping { .. }
    )
}
```

and consult it in `build_snapshot` beside the presence probes (:126-128): read the ownership snapshot per pane via the provider's fresh state (`state.fresh_codex` / `state.fresh_claude` / `state.fresh_opencode` `.ownership_snapshot(&sref.provider, &session_id)` — the Task 3 accessor; `freshell-ws` gains the `freshell-ownership` dep in this task's Cargo.toml edit). In the respawn-counter match (~:169-198), when `respawn_burn_skipped(&snapshot.state)` the `respawn_exhausted` fact computes `false` with NO `*c += 1` burn. The verdict itself keeps today's shape (frozen-client compatible) — the client-side divergence gate is Task 8's. (Optional hardening, recorded NOT chosen: stamping additive `ownerKind`/`ownerGeneration`/`terminalId` fields on the verdict — the Task 8 gate keys on its ready-replay-fed store instead, keeping this task's wire surface unchanged.)

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-freshagent ownership_wiring && cargo test -p freshell-ws --test cross_kind_liveness fresh_agent_create_and_kill && cargo test -p freshell-ws respawn_counter_does_not_burn`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Collapse any repeated claim/commit boilerplate that crept into the three providers into `ownership_lane` helpers. Confirm no lock is held across an await at any insertion point (coordinator methods are sync and short).

- [ ] **Step 6: Run impacted-test verification**

Impacted: every fresh-agent lifecycle suite that shares these paths.

Run: `cargo test -p freshell-freshagent && cargo test -p freshell-ws --test cross_kind_liveness --test codex_session_ref_resume --test freshagent_claude_attach && cargo test -p freshell-ws respawn_counter && npm run test:sandbox -- "cargo test -p freshell-ws --test freshagent_session_lease"`

Expected: PASS (the lease suite runs via the destructive sandbox; the last command before it covers the reconcile-guard unit test in the lib target).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent crates/freshell-ws/src/reconcile_freshagent.rs crates/freshell-ws/Cargo.toml crates/freshell-server/src/main.rs Cargo.lock
git commit -m "feat(ownership): wire fresh-agent lane claims/commits through the coordinator"
```

---

### Task 4: Coordinator wiring II — terminal lane (WS D8, REST rung, auto-resume, registry release) + the cross-kind start race test

**Files:**
- Modify: `crates/freshell-terminal/Cargo.toml` (dep on `freshell-ownership`)
- Modify: `crates/freshell-terminal/src/registry.rs` (optional injected coordinator; `release` at `kill()` :1587 and `finish_pty_exit`; force-release twin)
- Modify: `crates/freshell-ws/Cargo.toml` (dep on `freshell-ownership` — added in Task 3 for the reconcile guard; confirm present)
- Modify: `crates/freshell-ws/src/lib.rs` (`WsState.ownership: Option<Arc<RuntimeOwnershipRegistry>>`; ready-frame owner replay in `build_handshake_with_capabilities` :555-627)
- Modify: `crates/freshell-ws/src/terminal.rs` (D8 block :2901-3008 coordinator claim; D7 refusal :3165-3221 additive owner fields; kill paths)
- Modify: `crates/freshell-ws/src/auto_resume.rs` (claim_session :527-547)
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs` (REST D8 rung :1323-1373; settle task :1376-1419; 409 envelope :671-690 owner fields; refusal :2170-2177)
- Modify: `crates/freshell-server/src/main.rs` (inject into `WsState` + `TerminalRegistry`)
- Test: `crates/freshell-ws/tests/cross_kind_liveness.rs` (three new tests: the start race, the typed-owner refusal, the ready-frame owner replay)

**Interfaces:**
- Consumes: Task 1 registry; Task 2 `ErrorMessage.ownerKind`/`ownerGeneration` + `TerminalCreate.observed_generation`; Task 3's injected instance.
- Produces:
  - `TerminalRegistry::with_ownership(Arc<RuntimeOwnershipRegistry>) -> Self` (release-only integration — the registry never claims).
  - `WsState.ownership: Option<Arc<RuntimeOwnershipRegistry>>` (Task 6's WS probes and Task 7's pause hook live beside it).
  - The reconnect-owner replay: every `ready` frame built by `build_handshake_with_capabilities` carries `runtimeOwners` (from `ownership.snapshot_records()`) whenever the registry is injected — omit-when-empty; hand-built test `WsState`s without ownership keep byte-identical handshakes. A device that missed a handoff broadcast (offline during handoff, lag-4008 disconnect, page reload) learns the authoritative owner from the handshake alone (T1 rec A3).
  - The REST 409 envelope gains `"ownerKind"` / `"ownerGeneration"` keys when the coordinator knows the owner.
  - `terminal_tabs::HandoffToken { operation_id: String, generation: u64 }` + `spawn_terminal_pane_with_handoff(state, body, tab_id, pane_id, handoff: Option<&HandoffToken>)` (consumed by Task 6; the public `spawn_terminal_pane` delegates with `None`).

- [ ] **Step 1: Write the failing behavioral tests**

In `crates/freshell-ws/tests/cross_kind_liveness.rs`:

```rust
/// kata b8ke Task 4: the two-writers START race. Both creates are sent
/// back-to-back with NO sequencing (the genuine-race pattern from
/// session_ref_singleflight.rs); whichever wins, exactly one runtime may
/// exist for the session and the loser must have a TYPED answer.
#[tokio::test]
async fn concurrent_terminal_and_fresh_agent_start_same_session_ref_yield_one_writer() {
    let _env = ENV_LOCK.lock().await;
    let sidecar = FakeSidecarEnv::install().await;
    let (server, url) = spawn_server().await;
    let sid = format!("race-{}", uuid::Uuid::new_v4());
    let ws_term = connect(url.clone()).await;
    let ws_fresh = connect(url).await;

    let watermark = sidecar.create_rows().await.len();

    // Fire both with zero awaits between the sends.
    let term_req = "race-term-1";
    let fresh_req = "race-fresh-1";
    let send_term = send_json(&ws_term, json!({
        "type": "terminal.create", "requestId": term_req, "mode": "claude",
        "sessionRef": { "provider": "claude", "sessionId": sid },
    }));
    let send_fresh = send_json(&ws_fresh, json!({
        "type": "freshAgent.create", "requestId": fresh_req,
        "sessionType": "freshclaude", "provider": "claude",
        "sessionRef": { "provider": "claude", "sessionId": sid },
    }));
    let ((), ()) = tokio::join!(send_term, send_fresh);

    // Wait until BOTH requests have a terminal answer (created OR typed error).
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let mut term_answered = false;
    let mut fresh_answered = false;
    while std::time::Instant::now() < deadline && !(term_answered && fresh_answered) {
        if !term_answered {
            if let Some(frame) = await_frame(&ws_term, Duration::from_millis(250), |v| {
                let t = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
                t == "terminal.created" || t == "error"
            }).await {
                if frame.get("requestId").and_then(|r| r.as_str()) == Some(term_req) {
                    term_answered = true;
                }
            }
        }
        if !fresh_answered {
            if let Some(frame) = await_frame(&ws_fresh, Duration::from_millis(250), |v| {
                let t = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
                t == "freshAgent.created" || t == "freshAgent.create.failed"
            }).await {
                if frame.get("requestId").and_then(|r| r.as_str()) == Some(fresh_req) {
                    fresh_answered = true;
                }
            }
        }
    }
    assert!(term_answered && fresh_answered, "both requests must receive a typed answer");
    assert!(term_answered || fresh_answered);

    // Exactly one sidecar create for the durable id — never two.
    let rows = sidecar.create_rows().await;
    let creates = rows[watermark.min(rows.len())..]
        .iter()
        .filter(|r| r.msg.as_ref().and_then(|m| m.resumeSessionId.as_ref()) == Some(&sid))
        .count();
    assert!(creates <= 1, "at most one fresh sidecar may exist, saw {creates}");
    // Exactly one PTY row bound to the sessionRef (or none, if fresh won).
    let pty = server.ws_state.registry.session_ref_pty_count("claude", &sid);
    assert!(pty <= 1, "at most one terminal may own the session, saw {pty}");
}
```

(Adapt helper names to the file's real ones: `sidecar.create_rows()` is `create_rows(&sidecar_log)` here; add a tiny `session_ref_pty_count` probe on `TerminalRegistry` — or reuse the `identity_probe_rows()` join that `session_ref_singleflight.rs`'s `live_pty_count_for_session` uses, copying that helper in. If `spawn_server` does not return the `WsState` clone, extend it now — Task 3's test already required it.)

```rust
/// kata b8ke Task 4: the fresh-agent→terminal refusal carries the typed
/// owner fields (additive; frozen text untouched).
#[tokio::test]
async fn terminal_create_refusal_names_the_fresh_agent_owner_kind_and_generation() {
    let _env = ENV_LOCK.lock().await;
    let _sidecar = FakeSidecarEnv::install().await;
    let (server, url) = spawn_server().await;
    let ws = connect(url).await;
    let sid = format!("typed-owner-{}", uuid::Uuid::new_v4());
    // Establish a live freshclaude owner first.
    send_json(&ws, json!({
        "type": "freshAgent.create", "requestId": "own-1",
        "sessionType": "freshclaude", "provider": "claude",
        "sessionRef": { "provider": "claude", "sessionId": sid },
    })).await;
    let _ = await_frame(&ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("freshAgent.created")
    }).await.expect("created");
    // Competing terminal create is refused with the additive typed fields.
    send_json(&ws, json!({
        "type": "terminal.create", "requestId": "ref-1", "mode": "claude",
        "sessionRef": { "provider": "claude", "sessionId": sid },
    })).await;
    let err = await_frame(&ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("error")
            && v.get("requestId").and_then(|r| r.as_str()) == Some("ref-1")
    }).await.expect("typed refusal");
    assert_eq!(err.get("code").and_then(|c| c.as_str()), Some("RESTORE_UNAVAILABLE"));
    // Frozen text untouched.
    assert!(err.get("message").and_then(|m| m.as_str()).unwrap_or("")
        .contains("is still running on the server."));
    // NEW additive typed fields:
    assert_eq!(err.get("ownerKind").and_then(|k| k.as_str()), Some("fresh-agent"));
    assert!(err.get("ownerGeneration").and_then(|g| g.as_u64()).unwrap_or(0) >= 1);
    let _ = server;
}
```

```rust
/// kata b8ke Task 4 (reconnect owner discovery, T1 rec A3): a NEW
/// connection's `ready` frame replays current runtime-owner state, so a
/// device that missed the handoff broadcast (offline during handoff,
/// lag-4008 disconnect, page reload) learns the authoritative owner from the
/// handshake alone.
#[tokio::test]
async fn ready_frame_replays_current_runtime_owners() {
    let _env = ENV_LOCK.lock().await;
    let sidecar = FakeSidecarEnv::install().await;
    let (server, url) = spawn_server().await;
    let ws = connect(url.clone()).await;
    let sid = format!("replay-{}", uuid::Uuid::new_v4());
    send_json(&ws, json!({
        "type": "freshAgent.create", "requestId": "replay-1",
        "sessionType": "freshclaude", "provider": "claude",
        "sessionRef": { "provider": "claude", "sessionId": sid },
    })).await;
    let _ = await_frame(&ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("freshAgent.created")
    }).await.expect("created");
    // A SECOND connection (the "reloaded/reconnected device"): the ready
    // frame itself carries the owner — no broadcast needed.
    let ws_b = connect(url).await;
    let ready = await_frame(&ws_b, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("ready")
    }).await.expect("ready");
    let owners = ready.get("runtimeOwners").and_then(|v| v.as_array())
        .expect("runtimeOwners present when the registry is injected");
    assert!(owners.iter().any(|o|
        o.get("provider").and_then(|p| p.as_str()) == Some("claude")
            && o.get("sessionId").and_then(|s| s.as_str()) == Some(sid.as_str())
            && o.get("ownerKind").and_then(|k| k.as_str()) == Some("fresh-agent")
            && o.get("generation").and_then(|g| g.as_u64()).unwrap_or(0) >= 1));
    // Kill releases the key: a THIRD connection's ready replays it as
    // "vacant" — the divergence-clearing half of the replay.
    send_json(&ws, json!({
        "type": "freshAgent.kill", "sessionId": sid,
        "sessionType": "freshclaude", "provider": "claude",
    })).await;
    let _ = await_frame(&ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("freshAgent.killed")
            && v.get("sessionId").and_then(|s| s.as_str()) == Some(sid.as_str())
    }).await.expect("killed");
    let ws_c = connect(url).await;
    let ready_c = await_frame(&ws_c, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("ready")
    }).await.expect("ready");
    let owners_c = ready_c.get("runtimeOwners").and_then(|v| v.as_array())
        .expect("runtimeOwners present");
    assert!(owners_c.iter().any(|o|
        o.get("sessionId").and_then(|s| s.as_str()) == Some(sid.as_str())
            && o.get("ownerKind").and_then(|k| k.as_str()) == Some("vacant")),
        "released keys must replay as vacant so replay clears stale divergence");
    let _ = server;
    let _ = sidecar;
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-ws --test cross_kind_liveness concurrent_terminal_and_fresh_agent terminal_create_refusal_names ready_frame_replays`

Expected: FAIL — the typed-owner test fails on the missing `ownerKind`/`ownerGeneration` fields; the race test observes either two sidecar creates or a missing typed answer (the pre-coordinator race is the red); the ready-replay test fails on the absent `runtimeOwners` field (reconnect owner discovery is the missing behavior).

- [ ] **Step 3: Add the minimal production implementation**

1. `crates/freshell-terminal/Cargo.toml`: add `freshell-ownership = { path = "../freshell-ownership" }`. In `registry.rs`, add `ownership: Option<std::sync::Arc<freshell_ownership::RuntimeOwnershipRegistry>>` (default `None` in `new`) + `with_ownership(...)`. In `kill()` (~:1587, after the binding-prune at :1617-1620) and `finish_pty_exit`, resolve the terminal's `SessionLocator` (already recorded on the terminal row at create/association time — the same locator the D8 claim used) and call `ownership.release(&locator.provider, &locator.session_id, RuntimeOwnerKind::Terminal)`. Beside the registry's own `force_release_after_confirmed_kill` (~:2405-2410), also call the coordinator's `force_release_for_confirmed_kill`.

2. `crates/freshell-ws`: the `freshell-ownership` dep is already present (Task 3 added it for the reconcile guard); add `pub ownership: Option<Arc<freshell_ownership::RuntimeOwnershipRegistry>>` to `WsState` (default `None`; `main.rs` sets it — the `Option` keeps every hand-built test `WsState` compiling unchanged).

3. `terminal.rs` D8 block (:2901-3008), inside the existing `pane_reconcile_v1` gate (:2908), BEFORE `registry.claim_session_ref(...)` (:2914-2919):

```rust
    // kata b8ke: coordinator claim FIRST — the cross-kind authority. The
    // registry lease below remains the same-kind/TTL backstop.
    let ownership_ticket = state.ownership.as_ref().and_then(|ownership| {
        let operation_id = format!("term-create-{}", create.request_id);
        match ownership.begin_start(
            &locator.provider, &locator.session_id,
            freshell_ownership::RuntimeOwnerKind::Terminal,
            &operation_id,
            create.observed_generation,
            now_ms(),
        ) {
            BeginOutcome::Granted { generation } => Some((operation_id, generation)),
            BeginOutcome::AdoptLive { .. } => None, // same-kind live: BoundElsewhere path handles attach
            BeginOutcome::OwnedByOtherKind { owner, generation } => {
                // Same refusal shape as the D7 guard, now with the typed owner fields.
                Some(send_create_error_with_owner(
                    &create, owner, generation, /* existing frozen text + live_terminal_id: None */
                ))
                // (i.e. fall through to the existing RESTORE_UNAVAILABLE emission
                //  with owner_kind/owner_generation added — see below.)
            }
            BeginOutcome::Blocked { state: blocked, .. } => { /* SESSION_RESERVED-style, retryable, owner fields when live */ }
            BeginOutcome::StaleGeneration { .. } => { /* typed stale refusal, retryable: false */ }
        }
    });
```

(Implement `send_create_error_with_owner` as a thin extension of the existing `send_create_error_with_live_terminal` (:3214-3221) that adds `ownerKind`/`ownerGeneration` to the frame — keep the frozen message and the `live_terminal_id: Some`-for-terminal-owners behavior exactly.)

Thread `(operation_id, generation)` into the existing `SessionRefLeaseGuard` (:2174-2198) — it gains `ownership: Option<Arc<RuntimeOwnershipRegistry>>`, `operation_id`, `generation` fields — so its existing complete/fail arms also call `commit_live` (with `OwnerIdentity { kind: Terminal, terminal_id, pid }` — the pid via `set_session_ref_lease_pid`'s twin) and `fail` at the same points the registry lease completes/fails. The D7 guard's fresh-agent arm (:3183-3189) stays as the fast path; the coordinator claim closes its race. The D7 refusal and `send_session_reserved` loser path (:2238-2256) add `ownerKind`/`ownerGeneration` from `ownership.observe(...)` when available (absent when `state.ownership` is `None` — legacy byte-for-byte).

4. `auto_resume.rs` `claim_session` (:527-547): same claim/commit/fail around the existing registry claim; the crash-recovery respawn carries the observed generation from the crash event (the terminal row's last-known coordinator generation).

5. `terminal_tabs.rs` REST D8 rung (:1323-1373): same coordinator claim before `registry.claim_session_ref` — UNCONDITIONAL (REST callers are programmatic; no capability gate). The settle task (:1376-1419) commits/fails with the terminal owner identity. The 409 envelope helper `fail_json_restore_unavailable` (:671-690) gains `"ownerKind"`/`"ownerGeneration"` keys when the coordinator knows the owner; the refusal emission (:2170-2177) passes them. Add the handoff-continuation variant used by Task 6:

```rust
/// The handoff runner's spawn token: when Some, the D8 rung's coordinator
/// claim recognizes the in-flight Handoff (same operation_id, to_kind
/// Terminal) as a Granted continuation instead of a conflict, and the D7
/// rung is satisfied by the already-confirmed reap.
pub(crate) struct HandoffToken {
    pub operation_id: String,
    pub generation: u64,
}

pub(crate) async fn spawn_terminal_pane_with_handoff(
    state: &FreshAgentState,
    body: &Value,
    tab_id: &str,
    pane_id: &str,
    handoff: Option<&HandoffToken>,
) -> Result<TerminalSpawnResult, Response> {
    // identical body to spawn_terminal_pane, with the coordinator claim at the
    // D8 rung passing handoff.map(|t| (t.operation_id.as_str(), t.generation))
    // as the operation identity instead of minting a fresh one.
}

pub(crate) async fn spawn_terminal_pane(...) -> ... { // existing signature unchanged
    spawn_terminal_pane_with_handoff(state, body, tab_id, pane_id, None).await
}
```

6. `crates/freshell-server/src/main.rs`: `registry = registry.with_ownership(Arc::clone(&ownership));` and set `ws_state.ownership = Some(Arc::clone(&ownership));` at the existing wiring site (~:441-463).

7. `crates/freshell-ws/src/lib.rs` — the ready-frame owner replay (kata b8ke, T1 rec A3): in `build_handshake_with_capabilities` (:555-627), compute the replay BEFORE the `messages` vec and set it on the `Ready` construction:

```rust
    // kata b8ke reconnect-owner discovery: replay current runtime-owner state
    // on EVERY handshake — a device that missed a handoff broadcast (offline
    // during handoff, lag-4008 disconnect, page reload) learns the
    // authoritative owner from ready alone. Omit-when-empty keeps hand-built
    // test states (no injected registry) byte-identical.
    let runtime_owners = state.ownership.as_ref().map(|ownership| {
        ownership
            .snapshot_records()
            .into_iter()
            .map(|rec| freshell_protocol::RuntimeOwnerReplay {
                provider: rec.provider,
                session_id: rec.session_id,
                generation: rec.generation,
                owner_kind: rec.owner_kind,
                terminal_id: rec.terminal_id,
            })
            .collect::<Vec<_>>()
    });
```

(assign `runtime_owners` in the `Ready { ... }` literal; `None` when the registry is not injected).

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-ws --test cross_kind_liveness`

Expected: PASS (the five pre-existing tests — per the T4 base-validated run — plus Task 3's coordinator test and this task's three new ones).

- [ ] **Step 5: Refactor while green**

Extract the WS/REST claim blocks into one shared helper in `crates/freshell-freshagent/src/ownership_lane.rs` (`claim_terminal_ownership`) so both crates share the shape (`freshell-ws` already depends on `freshell-freshagent`). Keep the D7 emission single-sourced.

- [ ] **Step 6: Run impacted-test verification**

Impacted: the whole terminal create/restore/kill family and the REST spawn family.

Run: `cargo test -p freshell-terminal && cargo test -p freshell-ws --test session_ref_singleflight --test restore_spawn_gate --test restore_storm --test restore_plan_queue_cap --test claude_restore_unavailable --test rest_claude_identity --test rest_locator_identity --test rest_ws_shared_gate && cargo test -p freshell-freshagent terminal_tabs`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-terminal crates/freshell-ws crates/freshell-freshagent crates/freshell-server/src/main.rs Cargo.lock
git commit -m "feat(ownership): wire terminal lane through the coordinator; close cross-kind start race"
```

### Task 5: Side-effect-free snapshot GET + coordinator-gated compat cold-start

**Files:**
- Modify: `crates/freshell-freshagent/src/codex.rs` (`snapshot_runtime_for` :4121-4144; `get_snapshot` :4005-4010)
- Modify: `crates/freshell-freshagent/src/snapshot.rs` (route handler threads the observed generation; typed 409 mapping)
- Test: `crates/freshell-ws/tests/cross_kind_liveness.rs` (two new tests; requires merging the freshagent router into the harness)

**Interfaces:**
- Consumes: Task 3 injected `FreshCodexState.ownership` and the extended `ensure_session_resumable(observed_generation, handoff)` parameters; Task 1 `OwnershipState`.
- Produces:
  - `FreshCodexState::get_snapshot` becomes read-only for untracked sessions EXCEPT the compat cold-start, which claims through the coordinator (Granted only when Vacant) and carries the observed generation so a concurrent handoff stale-rejects it.
  - A typed 409 body for owned/transitioning sessions: `{ "code": "RESTORE_UNAVAILABLE", "ownerKind": "terminal" | "fresh-agent", "ownerGeneration": N, "message": "Session <sid> is still running on the server." }` (frozen text preserved).
  - `snapshot.rs` accepts `?observedGeneration=` (optional query param; the client starts sending it in Task 8).

**Validated impact (T4, `.worktrees/.the-usual-logs/b8ke-handoff/reports/load-bearing-validator-T4.md`):** the ownership-`None` escape hatch below is confirmed — all 122 base snapshot tests are green at base with hand-built ownership-`None` states (they construct via `state_with_bus()`/`snapshot_state()`-style helpers and keep the legacy-ensure branch byte-for-byte; `cargo test -p freshell-freshagent snapshot` = 122 passed, 0 failed), and the t2-codex oracle never exercises the REST GET (its `freshAgent.session.snapshot` baseline entry is the WS push on auto-subscribe). If `get_snapshot`'s signature grows the `observed_generation` parameter, the 15 in-src `st.get_snapshot(...)` call sites plus the `snapshot.rs` route call site gain the argument (compiler-guided, mechanical — pass `None` everywhere except the route's query-param read).

- [ ] **Step 1: Write the failing behavioral tests**

First extend the `cross_kind_liveness.rs` harness: merge `freshell_freshagent::router(fresh_agent_state)` onto the same axum app (the `rest_claude_identity.rs::spawn_merged_server` pattern, ~:166+) and add a small `http_get_json_status(&server, path) -> u16` helper (raw `TcpStream` HTTP GET with the auth header, copied from that file's `raw_post_tabs`).

```rust
/// kata b8ke Task 5: a snapshot GET while a TERMINAL owns the session must
/// be side-effect-free — zero sidecar spawns, typed 409.
#[tokio::test]
async fn snapshot_get_never_spawns_while_a_terminal_owns_the_session() {
    let _env = ENV_LOCK.lock().await;
    let sidecar = FakeSidecarEnv::install().await;
    let (server, url) = spawn_server().await;
    let ws = connect(url).await;
    let sid = format!("snap-term-{}", uuid::Uuid::new_v4());
    // Terminal owner first.
    send_json(&ws, json!({
        "type": "terminal.create", "requestId": "snap-t1", "mode": "claude",
        "sessionRef": { "provider": "claude", "sessionId": sid },
    })).await;
    let _ = await_frame(&ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("terminal.created")
    }).await.expect("terminal created");

    let watermark = sidecar.create_rows().await.len();
    let status = http_get_json_status(&server, &format!("/api/fresh-agent/threads/freshclaude/claude/{sid}")).await;
    assert_eq!(status, 409, "owned sessions answer typed 409, got {status}");
    let rows = sidecar.create_rows().await;
    assert_eq!(rows.len(), watermark, "snapshot GET must not spawn a sidecar");
}

/// kata b8ke Task 5 (compat tradeoff): a snapshot GET for an UNTRACKED
/// historical session cold-starts ONLY through the coordinator when the key
/// is Vacant (existing behavior preserved), and the coordinator records the
/// resulting live fresh-agent owner.
#[tokio::test]
async fn snapshot_get_cold_start_goes_through_the_coordinator_only_when_vacant() {
    let _env = ENV_LOCK.lock().await;
    let sidecar = FakeSidecarEnv::install().await;
    let (server, url) = spawn_server().await;
    let sid = format!("snap-cold-{}", uuid::Uuid::new_v4());
    let status = http_get_json_status(&server, &format!("/api/fresh-agent/threads/freshclaude/claude/{sid}")).await;
    assert_eq!(status, 200, "vacant historical sessions still cold-start (compat path)");
    let rows = sidecar.create_rows().await;
    assert!(rows.iter().any(|r| r.msg.as_ref().and_then(|m| m.resumeSessionId.as_ref()) == Some(&sid)),
        "compat cold-start resumed exactly the requested session");
    // The coordinator now records the live fresh-agent owner.
    let snap = server.ws_state.fresh_claude.ownership_snapshot("claude", &sid);
    assert!(matches!(snap.state, freshell_ownership::OwnershipState::Live { .. }),
        "compat cold-start must commit ownership, got {:?}", snap.state);
    let _ = url;
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-ws --test cross_kind_liveness snapshot_get_never_spawns snapshot_get_cold_start`

Expected: FAIL — the terminal-owned GET currently returns 200 (the spawn path resurrects a sidecar: `rows.len() > watermark`); the cold-start test's `Live` assertion fails (no claim today). Both reds are the missing behavior.

- [ ] **Step 3: Add the minimal production implementation**

Restructure `codex.rs::snapshot_runtime_for` (:4121-4144):

```rust
async fn snapshot_runtime_for(
    &self,
    thread_id: &str,
    cwd: Option<&str>,
    observed_generation: Option<u64>,
) -> Result<(CodexClient, bool), CodexSnapshotError> {
    // Tracked + alive: serve from the live runtime (unchanged behavior).
    if let Some(client) = self.live_client_for(thread_id).await {
        return Ok((client, self.active_turn_present(thread_id).await));
    }
    // Untracked: SIDE-EFFECT-FREE contract (kata b8ke). The compat cold-start
    // may spawn ONLY when the coordinator says Vacant, and it carries the
    // generation observed at this GET's entry so a concurrent handoff
    // stale-rejects it before any spawn.
    let ownership = self.ownership_snapshot(PROVIDER, thread_id);
    match ownership.state {
        OwnershipState::Vacant => {
            // Compat path (accepted tradeoff): one explicit coordinator claim.
            let op = format!("snapshot-coldstart-{}", uuid::Uuid::new_v4());
            let registry = self.ownership_registry(); // Option<Arc<...>> accessor
            let Some(registry) = registry else {
                // Un-injected (pre-existing tests): keep the legacy direct ensure.
                return self.ensure_session_resumable(thread_id, cwd, None, None)
                    .await
                    .map(|s| (s.client, false))
                    .map_err(CodexSnapshotError::from);
            };
            match freshell_ownership::BeginOutcome::from_registry_claim(
                registry.begin_start(PROVIDER, thread_id,
                    freshell_ownership::RuntimeOwnerKind::FreshAgent, &op,
                    observed_generation, now_epoch_ms()),
            ) {
                Granted { generation } => {
                    // The ensure path's own coordinator claim re-claims under the
                    // SAME op (Task 1's same-operation re-claim) — one writer.
                    let result = self
                        .ensure_session_resumable(thread_id, cwd, Some((&op, generation)), None)
                        .await;
                    match result {
                        Ok(resumed) => Ok((resumed.client, false)),
                        Err(e) => {
                            let _ = registry.fail(PROVIDER, thread_id, &op, generation);
                            Err(CodexSnapshotError::from(e))
                        }
                    }
                }
                OwnedByOtherKind { owner, generation } =>
                    Err(CodexSnapshotError::ReservedByOwner {
                        owner_kind: owner.kind, generation,
                    }),
                Blocked { generation, .. } =>
                    Err(CodexSnapshotError::HandoffInProgress { generation }),
                StaleGeneration { current_generation } =>
                    Err(CodexSnapshotError::StaleGeneration { current_generation }),
                _ => Err(CodexSnapshotError::Reserved),
            }
        }
        OwnershipState::Live { owner, generation } =>
            // A live owner we cannot serve locally (fresh or terminal):
            // read-only typed refusal — never spawn on top of an owner.
            Err(CodexSnapshotError::ReservedByOwner { owner_kind: owner.kind, generation }),
        OwnershipState::Handoff { generation, .. }
        | OwnershipState::Starting { generation, .. }
        | OwnershipState::Stopping { generation, .. } =>
            Err(CodexSnapshotError::HandoffInProgress { generation }),
    }
}
```

(Translate the sketch to the compiler's reality: `BeginOutcome` is matched directly, not via a `from_registry_claim` constructor; `ensure_session_resumable`'s `Ok` variant already returns the resumed session — map fields accordingly. Add the two new `CodexSnapshotError` variants `ReservedByOwner { owner_kind: RuntimeOwnerKind, generation: u64 }` and `HandoffInProgress { generation: u64 }` — plus `StaleGeneration { current_generation: u64 }` if the GET wants to distinguish it from Reserved.)

`snapshot.rs` route handler (:99-127): read `?observedGeneration=` (optional, `u64`), pass it into `get_snapshot`, and map the new error variants to the typed 409 envelope with the frozen message text (reuse the shape of `fail_json_restore_unavailable` from `terminal_tabs.rs:671-690`, adding `ownerKind`/`ownerGeneration`).

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-ws --test cross_kind_liveness snapshot_get && cargo test -p freshell-ownership`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Fold the `ReservedByOwner`/`HandoffInProgress` → 409 mapping into one `snapshot_error_response` helper in `snapshot.rs` (claude/opencode GETs are already read-only; only codex had the side effect).

- [ ] **Step 6: Run impacted-test verification**

Impacted: codex snapshot behavior tests (in-src `codex.rs` tests, `snapshot.rs` route tests) and the existing snapshot flows that rely on cold starts still working.

Run: `cargo test -p freshell-freshagent snapshot && cargo test -p freshell-ws --test cross_kind_liveness`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent
git commit -m "feat(snapshot): side-effect-free snapshot GET with coordinator-gated compat cold-start"
```

---

### Task 6: Atomic handoff — `SessionHandoffRunner` + `POST /api/sessions/handoff` + broadcasts + observability

**Files:**
- Create: `crates/freshell-freshagent/src/session_handoff.rs` (runner + router + request/result types + in-src tests)
- Modify: `crates/freshell-freshagent/src/lib.rs` (module + `handoff_router` re-export; `uuid` is already a dependency)
- Modify: `crates/freshell-freshagent/src/codex.rs`, `claude.rs`, `opencode_ws.rs` (the `*_for_handoff` resume/kill entry points the runner calls — thin wrappers over the existing paths with the handoff continuation)
- Modify: `crates/freshell-server/src/main.rs` (mint runner, mount `handoff_router` beside the other routers at :1603-1604)
- Test: `crates/freshell-freshagent/src/session_handoff.rs` (`mod tests`), `crates/freshell-ws/tests/cross_kind_liveness.rs` (one end-to-end test)

**Interfaces:**
- Consumes: Tasks 1-5 (coordinator, protocol frame, wired lanes, `spawn_terminal_pane_with_handoff`, `ensure_session_resumable(handoff)`).
- Produces:
  - `POST /api/sessions/handoff` body: `{ provider: string, sessionId: string, targetKind: "terminal" | "fresh-agent", sessionType?: string, mode?: string, cwd?: string, tabId?: string, paneId?: string, observedGeneration?: number, deviceId?: string }`
  - 200: `{ ok: true, operationId: string, generation: number, owner: { kind: "terminal", terminalId: string, mode: string } | { kind: "fresh-agent", sessionId: string, sessionType: string, provider: string } }`
  - 4xx typed: `{ ok: false, error: { code: "HANDOFF_IN_PROGRESS" | "REAP_TIMEOUT" | "TARGET_SPAWN_FAILED" | "STALE_GENERATION" | "SESSION_NOT_FOUND" | "BAD_REQUEST", message: string, retryable: boolean, ownerKind?: string, ownerGeneration?: number } }`
  - `SessionHandoffRunner::new(...)` / `with_reap_timeout_ms(u64)` / `with_test_hooks(Arc<HandoffTestHooks>)`; `HandoffTestHooks { pause_after_enter: Option<tokio::sync::Notify>, force_reap_timeout: bool, fail_target_spawn_once: AtomicBool }`
  - Broadcasts `session.runtimeOwner` at handoff-started / handoff-committed / handoff-failed.
  - On the fresh states: `resume_for_handoff(&self, session_id, cwd, operation_id, generation) -> Result<OwnerIdentity, (String, String)>` and `kill_for_handoff(&self, session_id, initiator) -> StopResult` for codex/claude; opencode equivalents on `FreshAgentState` (`opencode_resume_for_handoff`, `opencode_kill_for_handoff`).

- [ ] **Step 1: Write the failing behavioral tests**

In-src tests in `session_handoff.rs` (file-local `static ENV_LOCK: tokio::sync::Mutex<()>` + the inline fake claude sidecar env pattern copied from `cross_kind_liveness.rs::FakeSidecarEnv` — the fake source is a ~30-line JS string; copy it verbatim; drive the router with `tower::oneshot` the `pane_ops_tests.rs` way). The six required cases:

```rust
// 1. Happy path ordering: the old sidecar is reaped BEFORE the target
//    terminal spawns; commit is Live{Terminal}; the broadcast frames arrive.
#[tokio::test]
async fn handoff_to_terminal_reaps_sidecar_before_target_start_and_commits_owner() {
    // Setup: freshclaude session live (fake sidecar); runner with fresh states +
    // registry + coordinator; a subscribed broadcast receiver.
    // Act: runner.spawn_handoff(HandoffRequest { provider: "claude", session_id: sid,
    //     target_kind: Terminal, mode: Some("claude"), device_id: Some("dev-a"), .. }) -> rx.
    // Assert: rx.await -> ok:true, owner.terminal_id set, mode "claude";
    //         coordinator observe() == Live{Terminal, terminal_id};
    //         broadcast frames: session.runtimeOwner handoff-started then
    //         handoff-committed (terminalId == owner.terminalId);
    //         the sidecar create log has exactly ONE row for sid and its pid is gone
    //         (sidecar log rows carry pid; the kill is awaited before spawn — also
    //         assert the runner's hook event log ordering: Reaped < TargetStarted).
}

// 2. Target spawn failure: no blank session, session id preserved, Vacant + typed.
#[tokio::test]
async fn handoff_target_spawn_failure_leaves_vacant_with_typed_error() {
    // hooks.fail_target_spawn_once = true (the runner's start_target returns Err
    // without spawning — or point MODE at a nonexistent binary).
    // Assert: response { ok:false, error.code: "TARGET_SPAWN_FAILED", retryable: true };
    //         coordinator observe() == Vacant; the sessionId echoed in the body
    //         is UNCHANGED; no fresh session row exists; no PTY row for sid.
}

// 3. Reap timeout: no early target start; typed REAP_TIMEOUT; prior restored.
#[tokio::test]
async fn handoff_reap_timeout_returns_typed_and_does_not_start_target_early() {
    // hooks.force_reap_timeout = true (runner's stop_runtime short-circuits to
    // ReapTimeout after the injected deadline).
    // Assert: response { ok:false, error.code: "REAP_TIMEOUT", retryable: true };
    //         coordinator observe() == Live{prior fresh-agent owner} (restored);
    //         NO terminal spawn happened (hook event log empty of TargetStarted);
    //         a retry after clearing the hook succeeds.
}

// 4. Detached completion: dropping the reply receiver mid-handoff cannot
//    strand the operation; the detached task still reaches Live{target}.
#[tokio::test]
async fn handoff_continues_to_consistency_when_client_disconnects() {
    // hooks.pause_after_enter = Some(Notify); rx dropped immediately after spawn.
    // Unpark; await the runner's completion via the hook/broadcast; assert
    // coordinator Live{Terminal} and the handoff-committed broadcast fired.
}

// 5. Guard fail: aborting the handoff task restores prior owner or Vacant —
//    zero or one owner, never a stranded Handoff.
#[tokio::test]
async fn handoff_task_abort_leaves_zero_or_one_owner() {
    // hooks.pause_after_enter; keep the JoinHandle; abort() it.
    // Assert: observe() is Live{prior} or Vacant (never Handoff/Starting);
    //         a fresh begin_start Granted afterward.
}

// 6. opencode: handoff never kills the shared serve and never changes the id.
#[tokio::test]
async fn opencode_handoff_keeps_shared_serve_alive_and_session_id_stable() {
    // OPENCODE_CMD fake serve (the in-src mini HTTP pattern from
    // freshell-opencode's serve tests, or the e2e fixture via a temp script);
    // establish a durable ses_* session; handoff opencode -> terminal and back.
    // Assert: the serve manager instance is the SAME before/after (no restart,
    //         no kill — probe health via the existing bounded health check);
    //         the ses_* id is unchanged in every coordinator record and response.
}
```

(Write each body fully at execution time following this crate's proven in-src fake-env idioms; the six names and their asserted outcomes above are the required coverage set — typed bodies, coordinator snapshots, hook-event ordering.)

And in `cross_kind_liveness.rs` (merged-router harness from Task 5; add `http_post_json` alongside the GET helper):

```rust
/// kata b8ke Task 6: end-to-end fresh→terminal handoff over the real REST
/// endpoint against the in-process server with both kinds live.
#[tokio::test]
async fn fresh_agent_to_terminal_handoff_is_atomic_and_broadcast() {
    let _env = ENV_LOCK.lock().await;
    let sidecar = FakeSidecarEnv::install().await;
    let (server, url) = spawn_server().await;
    let ws = connect(url).await;
    let sid = format!("ho-e2e-{}", uuid::Uuid::new_v4());
    // Fresh owner.
    send_json(&ws, json!({
        "type": "freshAgent.create", "requestId": "ho-f1",
        "sessionType": "freshclaude", "provider": "claude",
        "sessionRef": { "provider": "claude", "sessionId": sid },
    })).await;
    let _ = await_frame(&ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("freshAgent.created")
    }).await.expect("created");
    // Handoff to terminal via REST.
    let resp = http_post_json(&server, "/api/sessions/handoff", json!({
        "provider": "claude", "sessionId": sid, "targetKind": "terminal",
        "mode": "claude", "deviceId": "test-device-a",
    })).await;
    assert_eq!(resp.status, 200, "{}", resp.body);
    let body: serde_json::Value = serde_json::from_str(&resp.body).unwrap();
    assert_eq!(body["ok"], serde_json::json!(true));
    let terminal_id = body["owner"]["terminalId"].as_str().expect("terminalId").to_string();
    // The coordinator is Live{Terminal} for (claude, sid).
    let snap = server.ws_state.ownership.as_ref().unwrap().observe("claude", &sid);
    assert!(matches!(snap.state, freshell_ownership::OwnershipState::Live { ref owner, .. }
        if owner.terminal_id.as_deref() == Some(terminal_id.as_str())));
    // Both broadcast transitions arrived on the WS.
    let _started = await_frame(&ws, Duration::from_secs(10), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("session.runtimeOwner")
            && v.get("transition").and_then(|t| t.as_str()) == Some("handoff-started")
    }).await.expect("handoff-started broadcast");
    let committed = await_frame(&ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("session.runtimeOwner")
            && v.get("transition").and_then(|t| t.as_str()) == Some("handoff-committed")
    }).await.expect("handoff-committed broadcast");
    assert_eq!(committed.get("terminalId").and_then(|t| t.as_str()), Some(terminal_id.as_str()));
    // A subsequent snapshot GET is typed 409 (terminal owns) — Task 5's contract.
    let status = http_get_json_status(&server, &format!("/api/fresh-agent/threads/freshclaude/claude/{sid}")).await;
    assert_eq!(status, 409);
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-freshagent session_handoff && cargo test -p freshell-ws --test cross_kind_liveness fresh_agent_to_terminal_handoff`

Expected: FAIL — compile errors first (module/endpoint missing); with `todo!()` stubs, the tests fail on the missing handoff behavior (404 route / no broadcasts / coordinator stays Live{FreshAgent}).

- [ ] **Step 3: Add the minimal production implementation**

`crates/freshell-freshagent/src/session_handoff.rs` core (full logic — the `#[cfg(test)] mod tests` sits at the bottom):

```rust
//! Atomic session handoff (kata b8ke): one server-authoritative operation
//! that moves a canonical (provider, sessionId) between the terminal lane and
//! a fresh-agent runtime — enter Handoff (generation+1) → broadcast → stop
//! prior runtime → await confirmed reap → start/attach target under the
//! retained lease → commit Live(target) → broadcast owner identity. Failures
//! are typed, retryable, and restore the prior owner or leave Vacant; never a
//! blank session. Runs on a DETACHED task (the settle-task precedent,
//! terminal_tabs.rs:1376-1419) so a client disconnect cannot half-orphan it;
//! an RAII guard fails the coordinator entry if the task is cancelled or
//! panics mid-flight.
use std::sync::Arc;

use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use freshell_ownership::{BeginOutcome, CommitOutcome, OwnerIdentity, RuntimeOwnerKind};
use serde_json::{json, Value};
use tokio::sync::oneshot;

/// Test-only injection (rides the constructor, never env — the
/// spawn_auto_resume_hub_with_schedules precedent).
pub struct HandoffTestHooks {
    /// Park the runner right after the coordinator enter (before the stop).
    pub pause_after_enter: Option<tokio::sync::Notify>,
    pub force_reap_timeout: bool,
    pub fail_target_spawn_once: std::sync::atomic::AtomicBool,
}

pub struct HandoffRequest {
    pub provider: String,
    pub session_id: String,
    pub target_kind: RuntimeOwnerKind,
    /// fresh-agent target: freshcodex | freshopencode | freshclaude.
    pub session_type: Option<String>,
    /// terminal target CLI mode (validated against cli_commands).
    pub mode: Option<String>,
    pub cwd: Option<String>,
    pub tab_id: Option<String>,
    pub pane_id: Option<String>,
    pub observed_generation: Option<u64>,
    pub device_id: Option<String>,
}

pub struct SessionHandoffRunner {
    auth_token: Arc<String>,
    broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    ownership: Arc<freshell_ownership::RuntimeOwnershipRegistry>,
    registry: freshell_terminal::TerminalRegistry,
    fresh_codex: crate::FreshCodexState,
    fresh_claude: crate::FreshClaudeState,
    fresh_agent: crate::FreshAgentState,
    cli_commands: Arc<Vec<freshell_platform::CliCommandSpec>>,
    reap_timeout_ms: u64,
    test_hooks: Option<Arc<HandoffTestHooks>>,
}

enum StopResult { Reaped, ReapTimeout, AlreadyGone }

impl SessionHandoffRunner {
    pub fn new(
        auth_token: Arc<String>,
        broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
        ownership: Arc<freshell_ownership::RuntimeOwnershipRegistry>,
        registry: freshell_terminal::TerminalRegistry,
        fresh_codex: crate::FreshCodexState,
        fresh_claude: crate::FreshClaudeState,
        fresh_agent: crate::FreshAgentState,
        cli_commands: Arc<Vec<freshell_platform::CliCommandSpec>>,
    ) -> Self {
        Self { auth_token, broadcast_tx, ownership, registry, fresh_codex, fresh_claude,
               fresh_agent, cli_commands, reap_timeout_ms: 10_000, test_hooks: None }
    }

    pub fn with_reap_timeout_ms(mut self, ms: u64) -> Self { self.reap_timeout_ms = ms; self }
    pub fn with_test_hooks(mut self, hooks: Arc<HandoffTestHooks>) -> Self {
        self.test_hooks = Some(hooks); self
    }

    /// Spawn the detached handoff; the HTTP reply rides a oneshot. Dropping
    /// the receiver (client gone) never cancels the operation.
    pub fn spawn_handoff(self: &Arc<Self>, req: HandoffRequest) -> oneshot::Receiver<Value> {
        let (tx, rx) = oneshot::channel();
        let runner = Arc::clone(self);
        tokio::spawn(async move {
            let result = runner.run(req).await;
            // Err (dropped receiver) is fine: the operation is detached.
            let _ = tx.send(result);
        });
        rx
    }

    async fn run(&self, req: HandoffRequest) -> Value {
        let operation_id = format!("handoff-{}", uuid::Uuid::new_v4());
        let initiator = req.device_id.clone().unwrap_or_else(|| "rest".into());
        let began = std::time::Instant::now();
        // 1. Atomically enter Handoff (+generation).
        let entered = self.ownership.begin_handoff(
            &req.provider, &req.session_id, req.target_kind, &operation_id,
            req.observed_generation, now_ms(),
        );
        let generation = match entered {
            BeginOutcome::Granted { generation } => generation,
            BeginOutcome::AdoptLive { owner, generation } =>
                return json!({ "ok": true, "operationId": operation_id, "generation": generation,
                               "owner": owner_json(&owner, &req) }),
            BeginOutcome::StaleGeneration { current_generation } =>
                return typed_failure("STALE_GENERATION", "observed generation is stale", false, current_generation),
            BeginOutcome::Blocked { .. } | BeginOutcome::OwnedByOtherKind { .. } => {
                let generation = self.ownership.observe(&req.provider, &req.session_id).generation;
                return typed_failure("HANDOFF_IN_PROGRESS", "a lifecycle operation is in flight", true, generation);
            }
        };
        let mut guard = HandoffGuard {
            ownership: Arc::clone(&self.ownership),
            provider: req.provider.clone(),
            session_id: req.session_id.clone(),
            operation_id: operation_id.clone(),
            generation,
            disarmed: false,
        };
        // 2. Broadcast the transition (all devices stop old-kind polling).
        self.broadcast_owner(&req, "handoff-started", req.target_kind, None, &operation_id, generation);
        if let Some(hooks) = self.test_hooks.as_ref() {
            if let Some(pause) = hooks.pause_after_enter.as_ref() {
                let _ = pause.notified().await;
            }
        }
        // 3+4. Stop the prior runtime and await confirmed reap (bounded).
        let prior = self.ownership.observe(&req.provider, &req.session_id)
            .state.prior_owner(); // Some((OwnerIdentity, u64)) captured at enter
        if let Some((owner, _)) = prior.as_ref() {
            match self.stop_runtime(&req, owner, &initiator).await {
                StopResult::Reaped | StopResult::AlreadyGone => {}
                StopResult::ReapTimeout => {
                    // Restore the prior record; the exit watcher releases it
                    // naturally once the dying runtime actually exits.
                    let _ = guard.disarm_and_fail();
                    tracing::warn!(target: "freshell_ownership",
                        event = "ownership.handoff.done", operation_id,
                        provider = %req.provider, session_id = %req.session_id,
                        generation, outcome = "reap_timeout",
                        duration_ms = began.elapsed().as_millis() as u64,
                        initiator = %initiator, failure = "REAP_TIMEOUT");
                    return typed_failure("REAP_TIMEOUT",
                        "prior runtime did not confirm exit in time", true, generation);
                }
            }
        }
        // 5. Start/attach the target under the retained lease.
        if let Some(hooks) = self.test_hooks.as_ref() {
            if hooks.fail_target_spawn_once.swap(false, std::sync::atomic::Ordering::SeqCst) {
                let _ = guard.disarm_and_fail();
                return typed_failure("TARGET_SPAWN_FAILED",
                    "target runtime failed to start (session id preserved)", true, generation);
            }
        }
        match self.start_target(&req, &operation_id, generation).await {
            Ok(owner) => {
                // 6. Commit Live(targetKind) + broadcast owner identity.
                if self.ownership.commit_live(&req.provider, &req.session_id,
                    &operation_id, generation, owner.clone()) == CommitOutcome::Committed
                {
                    guard.disarm();
                    self.broadcast_owner(&req, "handoff-committed", owner.kind,
                        owner.terminal_id.clone(), &operation_id, generation);
                    tracing::info!(target: "freshell_ownership",
                        event = "ownership.handoff.done", operation_id,
                        provider = %req.provider, session_id = %req.session_id,
                        generation, outcome = "committed",
                        duration_ms = began.elapsed().as_millis() as u64,
                        initiator = %initiator);
                    return json!({ "ok": true, "operationId": operation_id,
                        "generation": generation, "owner": owner_json(&owner, &req) });
                }
                typed_failure("STALE_GENERATION", "ownership moved during handoff", false, generation)
            }
            Err((code, detail)) => {
                // 7. Typed recoverable state — the prior was reaped, so Vacant.
                let _ = guard.disarm_and_fail();
                tracing::warn!(target: "freshell_ownership",
                    event = "ownership.handoff.done", operation_id,
                    provider = %req.provider, session_id = %req.session_id,
                    generation, outcome = "target_spawn_failed",
                    duration_ms = began.elapsed().as_millis() as u64,
                    initiator = %initiator, failure = %code);
                typed_failure("TARGET_SPAWN_FAILED", &detail, true, generation)
            }
        }
    }

    async fn stop_runtime(&self, req: &HandoffRequest, owner: &OwnerIdentity, initiator: &str)
        -> StopResult
    {
        if let Some(hooks) = self.test_hooks.as_ref() {
            if hooks.force_reap_timeout {
                return StopResult::ReapTimeout;
            }
        }
        match owner.kind {
            RuntimeOwnerKind::Terminal => {
                // Registry group-kill + confirm (never raw SIGKILL) — the same
                // discipline as kill_session_ref_holder_and_confirm
                // (freshell-ws/src/terminal.rs:2218-2234).
                let Some(terminal_id) = owner.terminal_id.as_deref() else {
                    return StopResult::AlreadyGone;
                };
                if !self.registry.kill(terminal_id) {
                    return StopResult::AlreadyGone;
                }
                // Bounded reap confirmation.
                match tokio::time::timeout(
                    std::time::Duration::from_millis(self.reap_timeout_ms),
                    self.registry.wait_terminal_dead(terminal_id),
                ).await {
                    Ok(true) => StopResult::Reaped,
                    _ => StopResult::ReapTimeout,
                }
            }
            RuntimeOwnerKind::FreshAgent => match req.provider.as_str() {
                "codex" => self.fresh_codex.kill_for_handoff(&req.session_id, initiator).await,
                "claude" => self.fresh_claude.kill_for_handoff(&req.session_id, initiator).await,
                "opencode" => self.fresh_agent.opencode_kill_for_handoff(&req.session_id, initiator).await,
                _ => StopResult::AlreadyGone,
            },
        }
    }

    async fn start_target(&self, req: &HandoffRequest, operation_id: &str, generation: u64)
        -> Result<OwnerIdentity, (String, String)>
    {
        match req.target_kind {
            RuntimeOwnerKind::Terminal => {
                let body = json!({
                    "mode": req.mode.clone().unwrap_or_else(|| req.provider.clone()),
                    "cwd": req.cwd,
                    "sessionRef": { "provider": req.provider, "sessionId": req.session_id },
                });
                let tab_id = req.tab_id.clone()
                    .unwrap_or_else(|| format!("handoff-tab-{}", uuid::Uuid::new_v4()));
                let pane_id = req.pane_id.clone()
                    .unwrap_or_else(|| format!("handoff-pane-{}", uuid::Uuid::new_v4()));
                let token = crate::terminal_tabs::HandoffToken {
                    operation_id: operation_id.to_string(),
                    generation,
                };
                let spawned = crate::terminal_tabs::spawn_terminal_pane_with_handoff(
                    &self.fresh_agent, &body, &tab_id, &pane_id, Some(&token),
                ).await.map_err(|resp| ("terminal spawn failed".to_string(), format!("{resp:?}")))?;
                Ok(OwnerIdentity {
                    kind: RuntimeOwnerKind::Terminal,
                    terminal_id: Some(spawned.terminal_id),
                    live_session_key: None,
                    pid: None,
                    ownership_id: None,
                })
            }
            RuntimeOwnerKind::FreshAgent => match req.session_type.as_deref().unwrap_or("freshcodex") {
                "freshcodex" => self.fresh_codex
                    .resume_for_handoff(&req.session_id, req.cwd.as_deref(), operation_id, generation).await,
                "freshopencode" => self.fresh_agent
                    .opencode_resume_for_handoff(&req.session_id, req.cwd.as_deref(), operation_id, generation).await,
                "freshclaude" => self.fresh_claude
                    .resume_for_handoff(&req.session_id, req.cwd.as_deref(), operation_id, generation).await,
                other => Err(("unsupported sessionType".to_string(), other.to_string())),
            },
        }
    }

    fn broadcast_owner(&self, req: &HandoffRequest, transition: &str,
                       owner_kind: RuntimeOwnerKind, terminal_id: Option<String>,
                       operation_id: &str, generation: u64) {
        let frame = serde_json::to_string(&freshell_protocol::ServerMessage::SessionRuntimeOwner(
            freshell_protocol::SessionRuntimeOwner {
                provider: req.provider.clone(),
                session_id: req.session_id.clone(),
                generation,
                owner_kind: match owner_kind {
                    RuntimeOwnerKind::Terminal => "terminal".into(),
                    RuntimeOwnerKind::FreshAgent => "fresh-agent".into(),
                },
                previous_kind: None,
                terminal_id,
                operation_id: operation_id.to_string(),
                transition: transition.to_string(),
                reason: None,
            },
        )).unwrap_or_default();
        let _ = self.broadcast_tx.send(frame);
    }
}

/// RAII: fail the coordinator entry if the handoff task is cancelled or
/// panics before commit (armed + not disarmed => fail on Drop) — the
/// FreshSessionLeaseGuard drop-discipline precedent (lib.rs:2886-2901).
struct HandoffGuard {
    ownership: Arc<freshell_ownership::RuntimeOwnershipRegistry>,
    provider: String,
    session_id: String,
    operation_id: String,
    generation: u64,
    disarmed: bool,
}

impl HandoffGuard {
    fn disarm(&mut self) { self.disarmed = true; }
    fn disarm_and_fail(&mut self) -> freshell_ownership::FailOutcome {
        self.disarmed = true;
        self.ownership.fail(&self.provider, &self.session_id, &self.operation_id, self.generation)
    }
}

impl Drop for HandoffGuard {
    fn drop(&mut self) {
        if !self.disarmed {
            let _ = self.disarm_and_fail();
        }
    }
}

fn typed_failure(code: &str, message: &str, retryable: bool, generation: u64) -> Value {
    json!({ "ok": false, "error": {
        "code": code, "message": message, "retryable": retryable,
        "ownerGeneration": generation,
    }})
}

fn owner_json(owner: &OwnerIdentity, req: &HandoffRequest) -> Value {
    match owner.kind {
        RuntimeOwnerKind::Terminal => json!({
            "kind": "terminal",
            "terminalId": owner.terminal_id,
            "mode": req.mode.clone().unwrap_or_else(|| req.provider.clone()),
        }),
        RuntimeOwnerKind::FreshAgent => json!({
            "kind": "fresh-agent",
            "sessionId": req.session_id,
            "sessionType": req.session_type.clone().unwrap_or_else(|| "freshcodex".into()),
            "provider": req.provider,
        }),
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `POST /api/sessions/handoff` — mounted in freshell-server::main beside
/// the freshagent router. The handler validates, parses, and awaits the
/// detached task's oneshot with a bounded HTTP timeout (the operation itself
/// outlives the request).
pub fn handoff_router(runner: Arc<SessionHandoffRunner>) -> Router {
    Router::new()
        .route("/api/sessions/handoff", post(handoff_handler))
        .layer(axum::middleware::from_fn_with_state(
            runner.auth_token.clone(),
            crate::auth_middleware, // the same token gate the freshagent router uses
        ))
        .with_state(runner)
}

async fn handoff_handler(
    State(runner): State<Arc<SessionHandoffRunner>>,
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    if !crate::pane_ops::authorized(&headers, &runner.auth_token) {
        return (StatusCode::UNAUTHORIZED, Json(json!({
            "ok": false, "error": { "code": "BAD_REQUEST", "message": "unauthorized", "retryable": false }
        })));
    }
    let Some(provider) = body.get("provider").and_then(|v| v.as_str()).map(String::from) else {
        return typed_bad_request("body must carry a string `provider`");
    };
    let Some(session_id) = body.get("sessionId").and_then(|v| v.as_str()).map(String::from) else {
        return typed_bad_request("body must carry a string `sessionId`");
    };
    let Some(target_kind) = match body.get("targetKind").and_then(|v| v.as_str()) {
        Some("terminal") => Some(RuntimeOwnerKind::Terminal),
        Some("fresh-agent") => Some(RuntimeOwnerKind::FreshAgent),
        _ => None,
    } else {
        return typed_bad_request("targetKind must be \"terminal\" or \"fresh-agent\"");
    };
    let session_type = body.get("sessionType").and_then(|v| v.as_str()).map(String::from);
    let mode = body.get("mode").and_then(|v| v.as_str()).map(String::from);
    if target_kind == RuntimeOwnerKind::Terminal {
        let mode_ref = mode.as_deref().unwrap_or(provider.as_str());
        if !runner.cli_commands.iter().any(|spec| spec.mode == mode_ref) {
            return typed_bad_request(&format!("unknown CLI mode {mode_ref:?}"));
        }
    }
    let req = HandoffRequest {
        provider,
        session_id,
        target_kind,
        session_type,
        mode,
        cwd: body.get("cwd").and_then(|v| v.as_str()).map(String::from),
        tab_id: body.get("tabId").and_then(|v| v.as_str()).map(String::from),
        pane_id: body.get("paneId").and_then(|v| v.as_str()).map(String::from),
        observed_generation: body.get("observedGeneration").and_then(|v| v.as_u64()),
        device_id: body.get("deviceId").and_then(|v| v.as_str()).map(String::from),
    };
    // The reply rides a oneshot with a bounded HTTP timeout; the operation
    // itself is detached and outlives the request (test 4 pins this).
    let mut rx = runner.spawn_handoff(req);
    match tokio::time::timeout(std::time::Duration::from_secs(30), &mut rx).await {
        Ok(Ok(value)) => {
            let ok = value.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
            (if ok { StatusCode::OK } else { StatusCode::CONFLICT }, Json(value))
        }
        _ => (StatusCode::CONFLICT, Json(json!({
            "ok": false, "error": { "code": "HANDOFF_IN_PROGRESS",
                "message": "handoff still in flight; the operation continues server-side",
                "retryable": true }
        }))),
    }
}

fn typed_bad_request(message: &str) -> (StatusCode, Json<Value>) {
    (StatusCode::BAD_REQUEST, Json(json!({
        "ok": false, "error": { "code": "BAD_REQUEST", "message": message, "retryable": false }
    })))
}
```

(Match `CliCommandSpec`'s real mode field name — `freshell_platform::CliCommandSpec` — and reuse the freshagent router's existing `authorized` helper import path, `pane_ops::authorized`, rather than inventing a middleware; adjust to the compiler's reality. `terminal_tabs.rs`'s mode resolution is the precedent for the cli_commands check.)

Supporting pieces:
- `OwnershipState::prior_owner()` — a small accessor on the `Handoff` variant returning `Option<(OwnerIdentity, u64)>` (Task 1 file; add a unit test).
- `TerminalRegistry::wait_terminal_dead(terminal_id)` — a bounded awaitable liveness probe (poll the registry row's status at 25ms until `Exited` or gone; the `finish_pty_exit` row retention makes this observable). Add an in-src registry test.
- The fresh states' `kill_for_handoff` / `resume_for_handoff` / `opencode_*_for_handoff` wrappers: thin pub(crate) methods that call the EXISTING kill/resume paths (`handle_kill`-shaped logic for one session; `ensure_session_resumable(handoff)` for resume) and return `StopResult` / `Result<OwnerIdentity, (String, String)>`. For opencode the kill NEVER touches the shared serve; the resume goes through `resume_durable_session` with the handoff continuation.
- `crates/freshell-server/src/main.rs`: mint the runner where all instances exist (after the `FreshAgentState` construction ~:343, using the same `fresh_codex_state`/`fresh_claude_state` clones `WsState` holds, the registry, the coordinator, the broadcast bus, and the cli commands), and merge `freshell_freshagent::session_handoff::handoff_router(runner)` into the app at :1603-1604.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-freshagent session_handoff && cargo test -p freshell-ws --test cross_kind_liveness fresh_agent_to_terminal_handoff`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Fold the repeated `tracing::info!/warn!` transition logs into a `log_transition(...)` helper inside `session_handoff.rs` so every outcome line carries the same field set (operationId, provider/sessionId, generation, kinds, runtime id/pid, initiator, duration, outcome, failure).

- [ ] **Step 6: Run impacted-test verification**

Impacted: REST surface construction (main.rs app wiring) and everything touching the fresh states' new pub methods.

Run: `cargo test -p freshell-freshagent && cargo test -p freshell-ws --test cross_kind_liveness --test rest_claude_identity && cargo check -p freshell-server`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent crates/freshell-server/src/main.rs crates/freshell-terminal Cargo.lock
git commit -m "feat(handoff): atomic server-side session handoff endpoint + typed failures + observability"
```

### Task 7: Deterministic pause-hook race suite (snapshot paused, terminal create paused, queued snapshot)

**Files:**
- Modify: `crates/freshell-freshagent/src/codex.rs` (snapshot pause hook: `FreshCodexState::snapshot_pause: Option<Arc<dyn Fn(&str) + Send + Sync>>` + `set_snapshot_pause_for_tests`; called in `snapshot_runtime_for` after the initial lookup, before the compat decision)
- Modify: `crates/freshell-freshagent/src/claude.rs` (same hook for the freshclaude snapshot path if its GET shares the ensure pattern; the claude snapshot is a disk read + live overlay, so the hook belongs on the codex lane only — verify and place accordingly)
- Modify: `crates/freshell-ws/src/terminal.rs` (terminal-create pause hook: `WsState::terminal_create_pause: Option<Arc<dyn Fn(&str) + Send + Sync>>` + `set_terminal_create_pause_for_tests`; called in `handle_create` after the D7 precheck, before the D8 coordinator claim — the notify-sends, the test receives and blocks)
- Modify: `crates/freshell-ws/tests/cross_kind_liveness.rs` (the seven deterministic race tests)
- Test: the new race tests in `cross_kind_liveness.rs`

**Interfaces:**
- Consumes: Tasks 3-6 (wired lanes, side-effect-free GET, handoff runner + `HandoffTestHooks.pause_after_enter`).
- Produces: the two test-only pause seams above (injected `Arc<dyn Fn>` closures — the `TerminalLivenessProbe` idiom; never env vars) and the seven deterministic races the kata requires.

- [ ] **Step 1: Write the failing behavioral tests**

The seven races in `cross_kind_liveness.rs` (each takes `ENV_LOCK`; hooks are set on the in-process state before connecting; the fake claude sidecar provides spawn-countable runtimes; the handoff endpoint drives handoffs — Task 6's merged harness):

```rust
/// R1: pause a snapshot GET after its initial lookup, begin the
/// fresh→terminal handoff, then release the snapshot. The released GET
/// must NOT spawn/register a replacement sidecar (stale generation), and
/// the terminal becomes the sole owner.
#[tokio::test]
async fn race_snapshot_paused_after_lookup_cannot_resurrect_during_handoff() {
    let _env = ENV_LOCK.lock().await;
    let sidecar = FakeSidecarEnv::install().await;
    let (server, url) = spawn_server().await;
    let ws = connect(url).await;
    let sid = format!("r1-{}", uuid::Uuid::new_v4());
    // Fresh owner live for sid (create + await created — helper factored from
    // the Task 6 test).
    let _fresh = establish_freshclaude_session(&ws, &sid).await;
    let watermark = sidecar.create_rows().await.len();
    // Park the snapshot GET after its lookup (tokio mpsc oneshot pair).
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
    let entered = Arc::new(tokio::sync::Notify::new());
    server.ws_state.fresh_claude.set_snapshot_pause_for_tests(Arc::new({
        let entered = Arc::clone(&entered);
        move |_thread_id| { entered.notify_waiters(); }
    }));
    // Fire the GET in the background, wait until it is parked inside the hook.
    let get_server = server.clone_for_http();
    let get_task = tokio::spawn(async move {
        http_get_json_status(&get_server, &format!("/api/fresh-agent/threads/freshclaude/claude/{sid}")).await
    });
    entered.notified().await;
    // Begin the fresh→terminal handoff (it must proceed: the GET holds NO lease).
    let resp = http_post_json(&server, "/api/sessions/handoff", json!({
        "provider": "claude", "sessionId": sid, "targetKind": "terminal",
        "mode": "claude", "deviceId": "race-r1",
    })).await;
    assert_eq!(resp.status, 200, "{}", resp.body);
    // Release the parked snapshot.
    let _ = release_tx.send(());
    let status = get_task.await.expect("get task");
    // The stale GET is typed-refused (never a sidecar spawn, never 200-with-resurrection).
    assert_eq!(status, 409, "released stale snapshot must be typed 409");
    let rows = sidecar.create_rows().await;
    let creates = rows[watermark.min(rows.len())..].iter()
        .filter(|r| r.msg.as_ref().and_then(|m| m.resumeSessionId.as_ref()) == Some(&sid)).count();
    assert_eq!(creates, 0, "no replacement sidecar may be spawned by the stale GET");
    // The terminal is the sole owner.
    let snap = server.ws_state.ownership.as_ref().unwrap().observe("claude", &sid);
    assert!(matches!(snap.state, freshell_ownership::OwnershipState::Live { ref owner, .. }
        if owner.kind == freshell_ownership::RuntimeOwnerKind::Terminal));
    let _ = release_rx;
}

/// R2: pause terminal creation after its precheck, attempt fresh-agent
/// attach/resume, then release both. One winner; the loser gets a typed
/// owner/handoff result.
#[tokio::test]
async fn race_terminal_create_paused_after_precheck_vs_fresh_attach_one_winner() {
    let _env = ENV_LOCK.lock().await;
    let sidecar = FakeSidecarEnv::install().await;
    let (server, url) = spawn_server().await;
    let ws_a = connect(url.clone()).await;
    let ws_b = connect(url).await;
    let sid = format!("r2-{}", uuid::Uuid::new_v4());
    // Park terminal.create after the precheck.
    let entered = Arc::new(tokio::sync::Notify::new());
    server.ws_state.set_terminal_create_pause_for_tests(Arc::new({
        let entered = Arc::clone(&entered);
        move |_request_id| { entered.notify_waiters(); }
    }));
    send_json(&ws_a, json!({
        "type": "terminal.create", "requestId": "r2-t1", "mode": "claude",
        "sessionRef": { "provider": "claude", "sessionId": sid },
    })).await;
    entered.notified().await;
    // While parked, the fresh attach claims — it must WIN (the parked terminal
    // hold no coordinator lease yet; the claim happens after the pause).
    send_json(&ws_b, json!({
        "type": "freshAgent.create", "requestId": "r2-f1",
        "sessionType": "freshclaude", "provider": "claude",
        "sessionRef": { "provider": "claude", "sessionId": sid },
    })).await;
    let _ = await_frame(&ws_b, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("freshAgent.created")
    }).await.expect("fresh wins while terminal parked");
    // Unpark the terminal: its claim now hits Live{FreshAgent} — typed refusal.
    server.ws_state.set_terminal_create_pause_for_tests(Arc::new(|_| {}));
    let err = await_frame(&ws_a, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("error")
            && v.get("requestId").and_then(|r| r.as_str()) == Some("r2-t1")
    }).await.expect("typed loser answer");
    assert_eq!(err.get("code").and_then(|c| c.as_str()), Some("RESTORE_UNAVAILABLE"));
    assert_eq!(err.get("ownerKind").and_then(|k| k.as_str()), Some("fresh-agent"));
    // Exactly one runtime: one sidecar create, zero PTY rows for sid.
    let rows = sidecar.create_rows().await;
    assert!(rows.iter().any(|r| r.msg.as_ref().and_then(|m| m.resumeSessionId.as_ref()) == Some(&sid)));
    assert_eq!(server.ws_state.registry.session_ref_pty_count("claude", &sid), 0);
}

/// R3: a snapshot queued before "React cleanup" (server-side analog: a
/// snapshot GET that entered before the handoff began and is released after
/// the handoff COMMITTED) cannot reclaim.
#[tokio::test]
async fn race_queued_snapshot_before_cleanup_is_fenced_by_generation() {
    // Identical to R1 but release the parked GET only AFTER the handoff has
    // fully committed (await the handoff-committed broadcast first). Assert
    // the same: 409, zero post-watermark sidecar creates for sid, terminal owner.
}

/// R4: old-runtime reap timeout — no target writer starts early; the session
/// stays recoverable (Live{prior}); a retry after the runtime actually dies
/// succeeds. Uses the runner's force_reap_timeout hook (Task 6).
#[tokio::test]
async fn race_reap_timeout_no_early_target_start_and_recoverable() {
    // hooks.force_reap_timeout = true; drive handoff; assert typed REAP_TIMEOUT;
    // assert NO terminal spawn (PTY count 0); assert coordinator Live{prior fresh};
    // clear the hook; the sidecar is killed by the failed handoff's stop attempt
    // (or kill it via freshAgent.kill); retry the handoff; assert 200 committed.
}

/// R5: target spawn failure — no blank session, session id preserved, owner
/// restored or Vacant with typed error. Uses fail_target_spawn_once.
#[tokio::test]
async fn race_target_spawn_failure_no_blank_session_id_preserved() {
    // Fresh owner; handoff to terminal with fail_target_spawn_once; assert
    // typed TARGET_SPAWN_FAILED; assert body echoes the SAME sessionId;
    // assert coordinator Vacant (prior was reaped); assert zero PTY rows and
    // exactly one sidecar create (the ORIGINAL — no second writer).
}

/// R6: browser disconnect mid-handoff — the server-side operation reaches a
/// consistent state (detached completion; Task 6 test 4 pinned the unit
// behavior; here it is the HTTP reality: drop the request mid-handoff via
// the pause hook + a client that aborts the connection; then assert the
// coordinator reaches Live{Terminal} and a follow-up snapshot GET is 409).
#[tokio::test]
async fn race_browser_disconnect_mid_handoff_reaches_consistent_state() {
    // pause_after_enter; fire the HTTP request from a task and drop/abort it
    // (e.g. wrap reqwest with a timeout that fires, or drop the connection by
    // dropping the client); unpause; poll the coordinator until Live{Terminal};
    // assert the follow-up GET is 409 and a competing create is typed-refused.
}

/// R7: coordinator cancellation/panic plus sidecar crash — abort the
/// handoff task at the pause point; assert zero untracked runtime and zero
/// or one authoritative owner; then crash the sidecar (freshAgent.kill) and
/// assert the key returns to Vacant and a new claim succeeds.
#[tokio::test]
async fn race_coordinator_cancellation_and_sidecar_crash_leave_consistent_state() {
    // pause_after_enter; spawn the handoff via the runner handle exposed on the
    // test server state; abort the JoinHandle; assert observe() is Live{prior}
    // or Vacant (never Handoff); freshAgent.kill the sidecar; assert Vacant;
    // a new terminal.create Granted.
}
```

(Write the four `// …` bodies fully at execution time — they follow R1/R2's exact mechanics with the stated release points and assertions. R4-R7 reuse Task 6's `HandoffTestHooks`; expose a test setter on the merged harness's runner.)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-ws --test cross_kind_liveness race_`

Expected: FAIL — compile errors for the missing pause hooks first; with hooks stubbed as no-ops, R1/R3 fail on the resurrecting GET (200 + a second sidecar create), R2 fails on the untyped loser or double runtime, R4-R7 fail on the missing typed outcomes/ordering.

- [ ] **Step 3: Add the minimal production implementation**

1. Snapshot pause hook — `crates/freshell-freshagent/src/codex.rs`:

```rust
    /// Test-only seam (kata b8ke): called in `snapshot_runtime_for` AFTER the
    /// initial lookup and BEFORE the compat cold-start decision, so tests can
    /// park a GET mid-flight and prove generation fencing. Never set in
    /// production. The TerminalLivenessProbe injection idiom.
    pub fn set_snapshot_pause_for_tests(
        &mut self,
        hook: Arc<dyn Fn(&str) + Send + Sync>,
    ) {
        self.snapshot_pause = Some(hook);
    }
```

and in `snapshot_runtime_for`, immediately after the live-client lookup: `if let Some(hook) = self.snapshot_pause.as_ref() { hook(thread_id); }`.

2. Terminal-create pause hook — `crates/freshell-ws/src/terminal.rs`: `WsState` gains `pub(crate) terminal_create_pause: Option<Arc<dyn Fn(&str) + Send + Sync>>` (+ `pub fn set_terminal_create_pause_for_tests(...)`), called in `handle_create` after the D7 guard, before the D8 coordinator claim.

3. Nothing else — the races are tests over existing Task 3-6 behavior made deterministic by the two hooks.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-ws --test cross_kind_liveness`

Expected: PASS (the full file: the four original refusals, Tasks 3-6 additions, and the seven races).

- [ ] **Step 5: Refactor while green**

Factor the repeated "establish freshclaude session + watermark + count creates for sid" helpers into small file-local fns (`establish_freshclaude_session`, `sidecar_creates_for`) mirroring the file's existing helper style.

- [ ] **Step 6: Run impacted-test verification**

Impacted: the whole cross-kind suite plus the pause-hook hosts compile-check.

Run: `cargo test -p freshell-ws --test cross_kind_liveness && cargo check -p freshell-freshagent && npm run test:sandbox -- "cargo test -p freshell-ws --test freshagent_session_lease"`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/codex.rs crates/freshell-ws/src/terminal.rs crates/freshell-ws/tests/cross_kind_liveness.rs
git commit -m "test(handoff): deterministic pause-hook race suite for cross-kind ownership"
```

---

### Task 8: Client — runtime-owner broadcast fold, pane convergence, scheduler/rebind fencing

**Files:**
- Modify: `src/store/freshAgentSlice.ts` (state `runtimeOwners: Record<string, RuntimeOwnerRecord>` + `applyRuntimeOwner` reducer, generation-monotonic)
- Create: `src/store/selectors/runtimeOwner.ts` (`selectPaneOwnerDivergence` + `selectSessionRuntimeOwner`)
- Modify: `src/App.tsx` (explicit `session.runtimeOwner` case in the `ws.onMessage` chain ~1022-1540, before the fresh-agent catch-all at :1539; ready fold dispatching `applyRuntimeOwner` for each `ready.runtimeOwners` entry in the ready handler ~:1104-1123, BEFORE `buildReconcileRequest`)
- Modify: `src/lib/pane-reconcile.ts` (`foldVerdicts`/`foldFreshAgentVerdict` divergence gate on the `respawn`/`fresh` arms)
- Modify: `src/lib/fresh-agent-ws.ts` (nothing structural — the fold lives in the slice; keep `handleFreshAgentMessage` untouched if the dispatch happens in App)
- Modify: `src/components/fresh-agent/FreshAgentView.tsx` (poll effect :2508-2515 + snapshot effect :2055-2334 gate on divergence; create effect :1557-1635 sends `observedGeneration` and re-checks before send)
- Modify: `src/lib/fresh-agent-snapshot-scheduler.ts` (no signature change — fencing is result-application guards per the run-closure contract)
- Test: `test/unit/client/store/freshAgentSlice.runtime-owner.test.ts` (new), `test/unit/client/store/selectors-runtime-owner.test.ts` (new), `test/unit/client/lib/fresh-agent-ws.test.ts` (new cases), `test/unit/client/lib/pane-reconcile.fresh-agent.test.ts` (new cases — the reconcile divergence gate), `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx` (new cases beside the pinned no-AbortSignal test at :6933-6947)

**Interfaces:**
- Consumes: Task 2 `SessionRuntimeOwnerMessage`.
- Produces:
  - `RuntimeOwnerRecord = { provider: string; sessionId: string; generation: number; ownerKind: 'terminal' | 'fresh-agent' | 'vacant'; terminalId?: string; updatedAt: number }` keyed `${provider}:${sessionId}`.
  - `selectPaneOwnerDivergence(state, { paneKind, provider?, sessionRef?, sessionId? }): { ownerKind: 'terminal' | 'fresh-agent'; terminalId?: string; generation: number } | null` — null when the canonical session has no owner record, the record is `vacant`, or the owner kind MATCHES the pane kind (same-mode attachment stays untouched).
  - FreshAgentView's create message carries `observedGeneration` (from the record at effect time) — `buildCreateMessage` (:1205-1227) gains the field.
  - The ready fold (kata b8ke reconnect-owner discovery, T1 rec A4): every `ready.runtimeOwners` entry dispatches `applyRuntimeOwner` BEFORE the pane-reconcile request is built and sent — a device that missed the handoff broadcast (offline during handoff, lag-4008, page reload) converges on its very first post-reconnect reconcile. The reducer is generation-monotonic, so replay interleaved with live broadcasts is safe.
  - The reconcile divergence gate (T1 rec A5): `foldFreshAgentVerdict`'s `respawn`/`fresh` arms skip `resetFreshAgentPaneForReconcileCreate` when `selectPaneOwnerDivergence` is non-null for that pane (key on `sessionRef.sessionId`) — the pane keeps its identity and renders the Task 9 divergence card instead of re-arming a stale-kind create; the fold still reports handled (firing the caller's `onVerdictFolded` → `ws.cancelCreate`, App.tsx:1207) so the pre-verdict create hold is retracted, not flushed at the `RECONCILE_VERDICT_WAIT_MS` bound.
  - Task 9 consumes: the selector + `requestSessionHandoff` (Task 9 adds the API call).

- [ ] **Step 1: Write the failing behavioral tests**

`test/unit/client/store/freshAgentSlice.runtime-owner.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createStore } from 'redux'
import { applyRuntimeOwner } from '@/store/freshAgentSlice'

const baseFrame = (overrides: Record<string, unknown> = {}) => ({
  type: 'session.runtimeOwner' as const,
  provider: 'codex',
  sessionId: 'sid-1',
  generation: 3,
  ownerKind: 'terminal' as const,
  operationId: 'handoff-1',
  transition: 'handoff-committed' as const,
  ...overrides,
})

describe('freshAgentSlice runtimeOwners fold', () => {
  it('applies a runtime-owner frame keyed by provider:sessionId', () => {
    const state = reducerWith(applyRuntimeOwner(baseFrame({ terminalId: 't-9', generation: 4 })))
    expect(state.freshAgent.runtimeOwners['codex:sid-1']).toMatchObject({
      ownerKind: 'terminal', terminalId: 't-9', generation: 4,
    })
  })

  it('ignores frames older than the recorded generation (monotonic)', () => {
    const state = reducerWith(
      applyRuntimeOwner(baseFrame({ generation: 5 })),
      applyRuntimeOwner(baseFrame({ generation: 3, transition: 'handoff-started' })),
    )
    expect(state.freshAgent.runtimeOwners['codex:sid-1'].generation).toBe(5)
  })

  it('records vacant owners (released) so divergence clears', () => {
    const state = reducerWith(
      applyRuntimeOwner(baseFrame({ generation: 5 })),
      applyRuntimeOwner(baseFrame({ generation: 6, ownerKind: 'vacant', transition: 'released' })),
    )
    expect(state.freshAgent.runtimeOwners['codex:sid-1'].ownerKind).toBe('vacant')
  })
})
```

`test/unit/client/store/selectors-runtime-owner.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { selectPaneOwnerDivergence } from '@/store/selectors/runtimeOwner'

describe('selectPaneOwnerDivergence', () => {
  it('diverges a fresh-agent pane whose session is terminal-owned', () => {
    const state = stateWithRuntimeOwner({ provider: 'codex', sessionId: 'sid-1',
      ownerKind: 'terminal', terminalId: 't-1', generation: 4 })
    expect(selectPaneOwnerDivergence(state, {
      paneKind: 'fresh-agent', provider: 'codex',
      sessionRef: { provider: 'codex', sessionId: 'sid-1' }, // sessionRef-only restored pane
    })).toEqual({ ownerKind: 'terminal', terminalId: 't-1', generation: 4 })
  })

  it('returns null for same-kind owners (same-mode multi-device attachment)', () => {
    const state = stateWithRuntimeOwner({ provider: 'codex', sessionId: 'sid-1',
      ownerKind: 'fresh-agent', generation: 4 })
    expect(selectPaneOwnerDivergence(state, {
      paneKind: 'fresh-agent', provider: 'codex',
      sessionRef: { provider: 'codex', sessionId: 'sid-1' },
    })).toBeNull()
  })

  it('keys on sessionRef.sessionId when content.sessionId is absent', () => {
    const state = stateWithRuntimeOwner({ provider: 'opencode', sessionId: 'ses-1',
      ownerKind: 'terminal', terminalId: 't-2', generation: 2 })
    expect(selectPaneOwnerDivergence(state, {
      paneKind: 'fresh-agent', provider: 'opencode',
      sessionRef: { provider: 'opencode', sessionId: 'ses-1' }, sessionId: undefined,
    })).toEqual({ ownerKind: 'terminal', terminalId: 't-2', generation: 2 })
  })

  it('returns null for unrelated panes (no matching record)', () => {
    const state = stateWithRuntimeOwner({ provider: 'codex', sessionId: 'sid-1',
      ownerKind: 'terminal', terminalId: 't-1', generation: 4 })
    expect(selectPaneOwnerDivergence(state, {
      paneKind: 'fresh-agent', provider: 'codex',
      sessionRef: { provider: 'codex', sessionId: 'sid-OTHER' },
    })).toBeNull()
  })
})
```

New cases in `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx` (in the scheduler describe block, beside the pinned no-AbortSignal test at :6933-6947 — keep that test passing UNCHANGED):

```ts
  it('runtime-owner transition stops old-kind snapshot scheduling immediately (no abort signal involved)', async () => {
    // Render a freshcodex pane (schedulerPaneContent pattern) with a live snapshot flow.
    // Dispatch applyRuntimeOwner({ provider:'codex', sessionId, generation:1,
    //   ownerKind:'terminal', terminalId:'t-1', transition:'handoff-committed' }).
    // Advance fake timers past SNAPSHOT_DEBOUNCE_MS and the 3s poll window with the
    // pane busy (so the poll effect would otherwise fire).
    // Assert getFreshAgentThreadSnapshot call count does NOT grow for this session.
  })

  it('stale scheduled callback cannot issue lifecycle-start for an old generation', async () => {
    // Seed the pane sessionRef-only (no sessionId) so the create effect arms a
    // rebind; BEFORE it fires, dispatch applyRuntimeOwner with generation 2
    // (terminal-owned). Assert NO freshAgent.create is sent (the ws send mock
    // records zero creates for this pane) — the pre-send generation check
    // suppressed it, and the pane shows the Task 9 divergence card instead.
  })

  it('same-mode multi-device attachment keeps polling (same-kind owner does not diverge)', async () => {
    // Dispatch applyRuntimeOwner ownerKind:'fresh-agent' for the pane's session;
    // assert snapshot scheduling CONTINUES (call count grows).
  })
```

`test/unit/client/lib/fresh-agent-ws.test.ts` (or App-level integration test if the dispatch lives there):

```ts
  it('session.runtimeOwner frames dispatch applyRuntimeOwner', () => {
    // Feed handleServerMessage (the App fold path) a session.runtimeOwner frame;
    // assert the store's runtimeOwners record was written keyed provider:sessionId.
  })

  it('ready frame carrying runtimeOwners populates the store before pane effects', () => {
    // Feed the App ready-fold path a ready frame with runtimeOwners:
    //   [{ provider: 'codex', sessionId: 'sid-r', generation: 2,
    //      ownerKind: 'terminal', terminalId: 't-3' }].
    // Assert: the store's runtimeOwners['codex:sid-r'] is written BEFORE the
    //   pane.reconcile request is built and sent (fold ordering), and a
    //   sessionRef-only fresh-agent pane for sid-r does NOT arm a
    //   freshAgent.create (the pre-send divergence check suppresses it).
  })
```

`test/unit/client/lib/pane-reconcile.fresh-agent.test.ts` (the fresh-agent fold's existing suite) — the reconcile divergence gate (kata b8ke, T1 rec A5):

```ts
  it('reconcile respawn verdict does not reset a divergent pane', () => {
    // Store with a runtimeOwners record: terminal owns the pane's
    // sessionRef.sessionId (generation 4). Fold a respawn verdict for that
    // pane through foldVerdicts with getOwnerDivergence wired to the
    // selector.
    // Assert: resetFreshAgentPaneForReconcileCreate was NOT dispatched
    //   (pane keeps content.sessionId/status — no stale-kind re-arm);
    //   onVerdictFolded fired for the pane's createRequestId (the held
    //   create is retracted via ws.cancelCreate, not flushed);
    //   the pane's reconcile-pending cleared.
  })

  it('respawn verdict still resets when the owner kind matches or is unknown', () => {
    // Same verdict with ownerKind 'fresh-agent' (same-kind owner) and with
    // no runtimeOwners record at all: resetFreshAgentPaneForReconcileCreate
    // dispatched exactly as today (legacy behavior preserved).
  })
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/store/freshAgentSlice.runtime-owner.test.ts test/unit/client/store/selectors-runtime-owner.test.ts test/unit/client/lib/pane-reconcile.fresh-agent.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL — module-not-found for the new selector file, the missing slice state, and the divergence-gate cases failing on the un-gated respawn arms (the missing behavior).

- [ ] **Step 3: Add the minimal production implementation**

`src/store/freshAgentSlice.ts` (additive state + reducer; follow the slice's existing action shapes):

```ts
export type RuntimeOwnerRecord = {
  provider: string
  sessionId: string
  generation: number
  ownerKind: 'terminal' | 'fresh-agent' | 'vacant'
  terminalId?: string
  updatedAt: number
}

// state: runtimeOwners: Record<string, RuntimeOwnerRecord> (default {})
export const applyRuntimeOwner = createAction<SessionRuntimeOwnerMessage>('freshAgent/applyRuntimeOwner')

// reducer arm:
builder.addCase(applyRuntimeOwner, (state, action) => {
  const f = action.payload
  const key = `${f.provider}:${f.sessionId}`
  const existing = state.runtimeOwners[key]
  if (existing && f.generation < existing.generation) return // monotonic
  state.runtimeOwners[key] = {
    provider: f.provider,
    sessionId: f.sessionId,
    generation: f.generation,
    ownerKind: f.ownerKind,
    ...(f.terminalId !== undefined ? { terminalId: f.terminalId } : {}),
    updatedAt: Date.now(),
  }
})
```

`src/store/selectors/runtimeOwner.ts`:

```ts
import type { RootState } from '@/store'
import type { SessionLocator } from '@/shared/ws-protocol'

export type PaneOwnerDivergence = {
  ownerKind: 'terminal' | 'fresh-agent'
  terminalId?: string
  generation: number
}

export type PaneOwnerIdentityInput = {
  paneKind: 'fresh-agent' | 'terminal'
  provider?: string
  sessionRef?: SessionLocator
  sessionId?: string
}

export function selectSessionRuntimeOwner(
  state: RootState,
  provider: string,
  sessionId: string,
): RuntimeOwnerRecord | undefined {
  return state.freshAgent?.runtimeOwners?.[`${provider}:${sessionId}`]
}

export function selectPaneOwnerDivergence(
  state: RootState,
  pane: PaneOwnerIdentityInput,
): PaneOwnerDivergence | null {
  const provider = pane.sessionRef?.provider ?? pane.provider
  const sessionId = pane.sessionRef?.sessionId ?? pane.sessionId
  if (!provider || !sessionId) return null
  const record = state.freshAgent?.runtimeOwners?.[`${provider}:${sessionId}`]
  if (!record || record.ownerKind === 'vacant') return null
  if (record.ownerKind === pane.paneKind) return null
  return {
    ownerKind: record.ownerKind,
    ...(record.terminalId !== undefined ? { terminalId: record.terminalId } : {}),
    generation: record.generation,
  }
}
```

`src/App.tsx` — add the explicit case in the `ws.onMessage` chain (before the `handleFreshAgentMessage` catch-all at :1539):

```ts
      case 'session.runtimeOwner':
        dispatch(applyRuntimeOwner(msg))
        break
```

And in the ready handler (kata b8ke reconnect-owner discovery, T1 rec A4) — fold the replayed owners BEFORE `buildReconcileRequest` is built and sent (~:1104-1123, ahead of the `paneReconcile` block):

```ts
            // kata b8ke: fold the server's owner replay BEFORE the reconcile
            // request is built — the respawn fold (pane-reconcile) gates on
            // this store state, so a device that missed the handoff broadcast
            // converges on its very first post-reconnect reconcile.
            for (const owner of ready.data.runtimeOwners ?? []) {
              dispatch(applyRuntimeOwner({
                type: 'session.runtimeOwner',
                provider: owner.provider,
                sessionId: owner.sessionId,
                generation: owner.generation,
                ownerKind: owner.ownerKind,
                ...(owner.terminalId !== undefined ? { terminalId: owner.terminalId } : {}),
                operationId: 'ready-replay',
                transition: owner.ownerKind === 'vacant' ? 'released' : 'handoff-committed',
              }))
            }
```

`src/lib/pane-reconcile.ts` — the reconcile divergence gate (kata b8ke, T1 rec A5): `foldVerdicts`'s optional `opts` gains `getOwnerDivergence?: (pane) => PaneOwnerDivergence | null` (App wires it to `selectPaneOwnerDivergence(appStore.getState(), {...})`; the module stays store-agnostic like its `dispatch` param), and `foldFreshAgentVerdict`'s `respawn`/`fresh` arms consult it BEFORE dispatching:

```ts
    case 'respawn':
    case 'fresh': {
      // kata b8ke: a terminal-owned (or otherwise divergent) session must
      // NOT re-arm a stale-kind freshAgent.create after reconnect — the pane
      // keeps its identity and renders the divergence card instead. Key on
      // the canonical session (verdict.sessionRef ?? pane.sessionRef).
      if (getOwnerDivergence?.(pane)) {
        // Handled WITHOUT the reset: the caller's onVerdictFolded fires, so
        // the held create is retracted (ws.cancelCreate) rather than flushed
        // at the RECONCILE_VERDICT_WAIT_MS bound.
        if (verdict.verdict === 'respawn') outcome.respawned++
        else outcome.fresh++
        return true
      }
      // ...existing resetFreshAgentPaneForReconcileCreate dispatch...
    }
```

`src/components/fresh-agent/FreshAgentView.tsx`:
- Poll effect (:2508-2515): add `const ownerDivergence = useAppSelector((s) => selectPaneOwnerDivergence(s, { paneKind: 'fresh-agent', provider: paneContent.provider, sessionRef: paneContent.sessionRef, sessionId: paneContent.sessionId }))` near the other selectors; early-return in the poll effect when `ownerDivergence !== null`.
- Snapshot effect (:2055-2334): at the top, `if (ownerDivergenceRef.current) return` — read via a ref kept in sync with the selector so the identity-deps discipline (:2311-2316) is not disturbed; the result guard `isStaleSnapshotRequest()` (:2068-2073) also treats a divergence flip as stale.
- Create/rebind effect (:1557-1635): capture `const observedGeneration = selectSessionRuntimeOwner(appStore.getState(), provider, sessionId)?.generation` at effect start; pass it into `buildCreateMessage` (:1205-1227 adds `...(observedGeneration !== undefined ? { observedGeneration } : {})`); immediately before `send`, re-read the store and skip the send when a divergence with a generation `>=` the captured one now exists (the server-side fence is the backstop — Task 2/4 wiring).
- The snapshot GET call (`getFreshAgentThreadSnapshot` at :2283) adds `observedGeneration` to the query bag when present (Task 5's `?observedGeneration=` param).

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/store/freshAgentSlice.runtime-owner.test.ts test/unit/client/store/selectors-runtime-owner.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/lib/pane-reconcile.fresh-agent.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS — including the UNCHANGED no-AbortSignal pin at :6933-6947 (the scheduler keeps its no-signal contract; fencing is result-application + pre-send checks, never cancellation).

- [ ] **Step 5: Refactor while green**

Centralize the pane's canonical-session derivation (`sessionRef?.sessionId ?? sessionId` + provider) in one small helper inside `runtimeOwner.ts` if it appears in more than two places.

- [ ] **Step 6: Run impacted-test verification**

Impacted: every FreshAgentView test (the huge file), fresh-agent-ws tests, panes/tabs slices that share the message fold.

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/lib/pane-reconcile.fresh-agent.test.ts test/unit/client/store --config config/vitest/vitest.config.ts`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add src/store/selectors/runtimeOwner.ts src/store/freshAgentSlice.ts src/App.tsx src/lib/pane-reconcile.ts src/components/fresh-agent/FreshAgentView.tsx test/unit/client
git commit -m "feat(client): runtime-owner convergence, scheduler fencing, generation-carrying lifecycle"
```

### Task 9: Client — atomic reopen handoff (sessionRef-aware) + typed failure cards + docs

**Files:**
- Modify: `src/lib/api.ts` (`requestSessionHandoff` + Zod `SessionHandoffResultSchema`)
- Modify: `src/components/context-menu/ContextMenuProvider.tsx` (the `reopenPaneAsSessionTargetAction` kill-legs :1040-1061 replaced by one awaited handoff call; failure keeps the pane)
- Modify: `src/components/TerminalView.tsx` (typed launch-failure card beside the existing create-error fold :4943-5005; `sendCreate` :3264-3329 sends `observedGeneration`)
- Modify: `src/components/fresh-agent/FreshAgentView.tsx` ("opened as CLI elsewhere" card when `ownerDivergence.ownerKind === 'terminal'`)
- Create: `src/components/TerminalLaunchFailureCard.tsx` (typed card, a11y pattern of the stuck card)
- Modify: `src/store/paneTypes.ts` (`TerminalPaneContent.launchFailure?: LaunchFailure`; `FreshAgentPaneContent.handoffError?: HandoffError` — both volatile)
- Modify: `src/store/persistMiddleware.ts` (`stripTransientSessionFields` :245-271 strips both new fields)
- Modify: `src/store/panesSlice.ts` (setters for the two volatile fields — or reuse `updatePaneContent` merges)
- Modify: `docs/index.html` (mock of the "opened as CLI elsewhere" pane state)
- Test: `test/unit/client/components/ContextMenuProvider.test.tsx` (sessionRef-only codex :1173-1243 + opencode :1245+ cases), `test/unit/client/components/TerminalView.lifecycle.test.tsx`, `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx` (divergence card), `test/unit/client/lib/api.test.ts` (handoff result schema) if that file exists — otherwise co-locate the schema test with the api mock tests.

**Interfaces:**
- Consumes: Task 8 `selectPaneOwnerDivergence` / `selectSessionRuntimeOwner`; Task 6 REST contract.
- Produces:
  - `requestSessionHandoff(body: SessionHandoffRequestBody): Promise<SessionHandoffResult>` (typed union: `{ ok: true; owner: ...; generation: number; operationId: string } | { ok: false; error: { code: SessionHandoffErrorCode; message: string; retryable: boolean; ownerKind?: 'terminal' | 'fresh-agent'; ownerGeneration?: number } }`)
  - `LaunchFailure = { code: 'SESSION_RESERVED' | 'RESTORE_UNAVAILABLE' | 'HANDOFF_IN_PROGRESS' | 'REAP_TIMEOUT' | 'TARGET_SPAWN_FAILED' | 'STALE_GENERATION' | 'LAUNCH_FAILED'; message: string; retryable: boolean; ownerKind?: 'terminal' | 'fresh-agent'; terminalId?: string; observedGeneration?: number }`
  - `HandoffError = { code: SessionHandoffErrorCode; message: string; retryable: boolean; generation: number }`

- [ ] **Step 1: Write the failing behavioral tests**

In `test/unit/client/components/ContextMenuProvider.test.tsx` — extend the sessionRef-only FreshCodex case (:1173-1243; note the file path has NO `context-menu/` segment) and the FreshOpenCode case (:1245+):

```ts
  it('sessionRef-only freshcodex pane reopens as CLI via one awaited handoff using sessionRef.sessionId', async () => {
    // Seed a pane with kind fresh-agent, sessionType freshcodex, provider codex,
    // sessionRef { provider:'codex', sessionId:'sid-ref-only' }, NO content.sessionId.
    // Mock api.requestSessionHandoff to resolve { ok:true, owner:{ kind:'terminal',
    //   terminalId:'t-77', mode:'codex' }, generation:2, operationId:'handoff-x' }.
    // Invoke the reopen action (target codex CLI).
    // Assert: requestSessionHandoff was called ONCE with
    //   { provider:'codex', sessionId:'sid-ref-only', targetKind:'terminal',
    //     mode:'codex', ... } — sessionId taken from sessionRef, NOT undefined.
    // Assert: NO sendFreshAgentKillAndAwait / sendTerminalKillAndAwait was sent
    //   (the server performs the kill inside the handoff).
    // Assert: the pane content swapped to kind terminal with
    //   sessionRef { provider:'codex', sessionId:'sid-ref-only' } and
    //   liveTerminal { terminalId:'t-77' } — the attach path, not a fresh create.
  })

  it('freshopencode sessionRef-only pane reopens as CLI via the handoff (opencode twin)', async () => {
    // Same shape for a freshopencode pane; owner terminalId t-88, mode opencode;
    // assert the swapped content is a terminal pane with mode 'opencode' +
    // liveTerminal { terminalId:'t-88' } and the same ses_ id in sessionRef.
  })

  it('handoff failure keeps the pane and surfaces the typed error', async () => {
    // requestSessionHandoff resolves { ok:false, error:{ code:'REAP_TIMEOUT',
    //   message:'prior runtime did not confirm exit in time', retryable:true,
    //   ownerGeneration:3 } }.
    // Assert: updatePaneContent was NOT dispatched (pane unchanged);
    //   the pane gained handoffError { code:'REAP_TIMEOUT', retryable:true };
    //   a Retry action re-invokes requestSessionHandoff with the same identity.
  })
```

In `test/unit/client/components/TerminalView.lifecycle.test.tsx` (the create-error region ~3315/3408):

```ts
  it('typed fresh-owner refusal renders a recoverable card with attach and retry actions', async () => {
    // Send the pane's create error frame: { code:'RESTORE_UNAVAILABLE',
    //   message:'Session X is still running on the server.', ownerKind:'fresh-agent',
    //   ownerGeneration:4 }.
    // Assert: pane role="alert" card is rendered with accessible name matching
    //   /open(ed)? as a fresh agent/i and buttons "Retry launch" + "Open as Fresh Agent".
    // Assert: the xterm notice still contains the frozen "[Launch failed]" text
    //   (byte-frozen wire text preserved alongside the card).
    // Click "Retry launch" -> a new terminal.create with the same sessionRef.
  })

  it('typed handoff-in-progress refusal renders a retryable card', async () => {
    // error frame { code:'SESSION_RESERVED', retryable:true, ownerKind:'terminal',
    //   ownerGeneration:2 } -> card with "Retry launch"; no attach button (no liveTerminalId).
  })
```

In `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`:

```ts
  it('divergent pane renders the opened-as-CLI-elsewhere card with a direct attach action', async () => {
    // Render a freshcodex pane; dispatch applyRuntimeOwner({ ownerKind:'terminal',
    //   terminalId:'t-5', generation:2, ... }) for its session.
    // Assert: role="alert" card "This conversation is open as a terminal on another device"
    //   (or the repo's final wording) with an "Attach here" button.
    // Click "Attach here" -> updatePaneContent dispatched with kind terminal +
    //   liveTerminal { terminalId:'t-5' } + the same sessionRef.
  })
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --config config/vitest/vitest.config.ts`

Expected: FAIL — `requestSessionHandOut`/`requestSessionHandoff` does not exist (the ContextMenu tests fail on the un-mocked/missing API or fall through to the legacy kill legs which the tests assert were NOT sent); the card tests fail on missing `role="alert"` elements and missing `launchFailure` typing.

- [ ] **Step 3: Add the minimal production implementation**

1. `src/lib/api.ts`:

```ts
export const SessionHandoffResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    operationId: z.string(),
    generation: z.number().int().nonnegative(),
    owner: z.union([
      z.object({ kind: z.literal('terminal'), terminalId: z.string(), mode: z.string() }),
      z.object({ kind: z.literal('fresh-agent'), sessionId: z.string(), sessionType: z.string(), provider: z.string() }),
    ]),
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.enum(['HANDOFF_IN_PROGRESS', 'REAP_TIMEOUT', 'TARGET_SPAWN_FAILED', 'STALE_GENERATION', 'SESSION_NOT_FOUND', 'BAD_REQUEST']),
      message: z.string(),
      retryable: z.boolean(),
      ownerKind: z.enum(['terminal', 'fresh-agent']).optional(),
      ownerGeneration: z.number().int().nonnegative().optional(),
    }),
  }),
])
export type SessionHandoffResult = z.infer<typeof SessionHandoffResultSchema>
export type SessionHandoffRequestBody = {
  provider: string
  sessionId: string
  targetKind: 'terminal' | 'fresh-agent'
  sessionType?: string
  mode?: string
  cwd?: string
  tabId?: string
  paneId?: string
  observedGeneration?: number
  deviceId?: string
}

export async function requestSessionHandoff(body: SessionHandoffRequestBody): Promise<SessionHandoffResult> {
  const raw = await requestJson('/api/sessions/handoff', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return SessionHandoffResultSchema.parse(raw)
}
```

(Follow `api.ts`'s existing fetch/auth helper conventions — `getFreshAgentThreadSnapshot` at :423-444 is the sibling shape; reuse the module's `request`/auth plumbing rather than a raw `requestJson` if that is the house style.)

2. `src/components/context-menu/ContextMenuProvider.tsx` — replace the kill-legs (:1040-1061) and wire the awaited handoff:

```ts
    // kata b8ke: ONE atomic server-side handoff replaces the client-orchestrated
    // kill → swap sequence. The server stops the prior runtime, awaits the
    // confirmed reap, starts the target under the retained coordinator lease,
    // and commits/broadcasts the new owner. The sessionId comes from the
    // sessionRef-aware target — content.sessionId is NOT required.
    const handoff = await requestSessionHandoff({
      provider: latest.target.provider,
      sessionId: latest.target.sessionId,
      targetKind: latest.target.targetSessionType === 'terminal' ? 'terminal' : 'fresh-agent',
      sessionType: latest.target.targetSessionType === 'terminal'
        ? undefined
        : latest.target.targetSessionType,
      mode: latest.target.targetSessionType === 'terminal'
        ? latest.target.provider
        : undefined,
      cwd: resolvedCwd ?? undefined,
      tabId: latest.target.tabId,
      paneId: latest.target.paneId,
      observedGeneration: selectSessionRuntimeOwner(
        appStore.getState(), latest.target.provider, latest.target.sessionId,
      )?.generation,
      deviceId: appStore.getState().tabRegistry?.deviceId,
    })
    if (!handoff.ok) {
      dispatch(paneActions.setPaneHandoffError({
        tabId: latest.target.tabId, paneId: latest.target.paneId,
        error: { code: handoff.error.code, message: handoff.error.message,
                 retryable: handoff.error.retryable, generation: handoff.error.ownerGeneration ?? 0 },
      }))
      return
    }
    dispatch(updatePaneContent({
      tabId: latest.target.tabId,
      paneId: latest.target.paneId,
      content: handoff.owner.kind === 'terminal'
        ? {
            kind: 'terminal',
            createRequestId: latest.content.createRequestId,
            mode: handoff.owner.mode,
            sessionRef: { provider: latest.target.provider, sessionId: latest.target.sessionId },
            liveTerminal: { terminalId: handoff.owner.terminalId },
            status: 'connected',
          }
        : buildResumeContent({
            sessionType: latest.target.targetSessionType,
            sessionId: latest.target.sessionId,
            cwd: resolvedCwd,
            freshAgentProviderSettings: latest.providerSettings,
          }),
    }))
```

(Keep the `setSessionMetadata` REST leg (:997-1015) BEFORE the handoff exactly as-is — durable metadata first; keep its failure abort. Delete the now-dead `sendTerminalKillAndAwait`/`sendFreshAgentKillAndAwait` legs and their imports if nothing else in the file uses them. The `sessionMetadataByKey` update (:1074-1085) stays.)

3. `src/store/paneTypes.ts` — the two volatile fields + `src/store/panesSlice.ts` setters (`setPaneHandoffError`, `setPaneLaunchFailure`) merging into the pane content without clobbering identity fields; `src/store/persistMiddleware.ts` strips both in `stripTransientSessionFields` (:245-271).

4. `src/components/TerminalLaunchFailureCard.tsx`:

```tsx
import type { LaunchFailure } from '@/store/paneTypes'

/** Typed recoverable launch-failure card (kata b8ke) — the stuck-card pattern
 * (role="alert", real buttons, aria-labels). Rendered by TerminalView when
 * the pane carries a typed launchFailure; the xterm notice text still
 * happens for the frozen wire-text contract. */
export function TerminalLaunchFailureCard({ failure, onRetry, onAttach, onOpenFresh }: {
  failure: LaunchFailure
  onRetry: () => void
  onAttach?: () => void
  onOpenFresh?: () => void
}) {
  return (
    <div role="alert" aria-label={`Launch failed: ${failure.code}`} className="...">
      <p>{failureTitle(failure)}</p>
      {failure.terminalId !== undefined && (
        <button type="button" aria-label="Attach to the running session" onClick={onAttach}>
          Attach to running session
        </button>
      )}
      {failure.retryable && (
        <button type="button" aria-label="Retry launch" onClick={onRetry}>Retry launch</button>
      )}
      {failure.ownerKind === 'fresh-agent' && (
        <button type="button" aria-label="Open as Fresh Agent" onClick={onOpenFresh}>
          Open as Fresh Agent
        </button>
      )}
    </div>
  )
}

function failureTitle(failure: LaunchFailure): string {
  switch (failure.ownerKind ?? failure.code) {
    case 'fresh-agent': return 'This session is open as a Fresh Agent pane on the server.'
    case 'terminal': return 'This session is running in a terminal on the server.'
    default: return failure.message
  }
}
```

`src/components/TerminalView.tsx` — in the create-error fold (:4952-5005): for frames carrying `ownerKind`/`ownerGeneration` (or the codes SESSION_RESERVED/RESTORE_UNAVAILABLE), set `launchFailure` on the pane (typed) in ADDITION to the existing xterm notice; render `<TerminalLaunchFailureCard>` above the terminal surface when `content.launchFailure` is present. Actions: `onAttach` → `applyReattachToLiveTerminal` (existing reducer, :4963-4977's path); `onRetry` → clear `launchFailure` + re-send create (the `redriveAfterSessionReserved`/:3296-3301 machinery); `onOpenFresh` → `updatePaneContent` fresh-agent resume content for the pane's sessionRef. `sendCreate` (:3264-3329) adds `observedGeneration` from `selectSessionRuntimeOwner` at send time.

5. `src/components/fresh-agent/FreshAgentView.tsx` — the "opened as CLI elsewhere" card, rendered when `ownerDivergence?.ownerKind === 'terminal'` (Task 8's selector):

```tsx
    {ownerDivergence?.ownerKind === 'terminal' && (
      <div role="alert" aria-label="Session open as a terminal on another device" className="...">
        <p>This conversation is open as a terminal on another device.</p>
        <button
          type="button"
          aria-label="Attach the terminal here"
          onClick={() => dispatch(updatePaneContent({
            tabId, paneId,
            content: {
              kind: 'terminal',
              createRequestId: paneContent.createRequestId,
              mode: paneContent.provider,
              sessionRef: paneContent.sessionRef,
              ...(ownerDivergence.terminalId !== undefined
                ? { liveTerminal: { terminalId: ownerDivergence.terminalId } }
                : {}),
              status: 'connected',
            },
          }))}
        >
          Attach here
        </button>
      </div>
    )}
```

Plus the `handoffError` banner (from the ContextMenu failure path) with a Retry button that re-invokes the same handoff.

6. `docs/index.html` — add a static mock of a fresh-agent pane showing the "This conversation is open as a terminal on another device." card with the Attach here button (matching the file's existing mock-card style).

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --config config/vitest/vitest.config.ts && npm run lint`

Expected: PASS (lint green — the new cards are semantic buttons with aria-labels).

- [ ] **Step 5: Refactor while green**

Extract the terminal-resume-content construction shared by the ContextMenu success path and the FreshAgentView attach action into one helper in `src/lib/session-type-utils.ts` (beside `buildResumeContent`).

- [ ] **Step 6: Run impacted-test verification**

Impacted: the whole context-menu + terminal + fresh-agent view trees and the persist round-trip tests.

Run: `npm run test:vitest -- run test/unit/client --config config/vitest/vitest.config.ts`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add src/lib/api.ts src/components/context-menu/ContextMenuProvider.tsx src/components/TerminalView.tsx src/components/TerminalLaunchFailureCard.tsx src/components/fresh-agent/FreshAgentView.tsx src/store/paneTypes.ts src/store/panesSlice.ts src/store/persistMiddleware.ts docs/index.html test/unit/client
git commit -m "feat(client): atomic reopen handoff + typed launch-failure recovery cards"
```

---

### Task 10: respawn-pane via LayoutStore + typed ownership responses + attach_pane + REST/MCP parity

**Files:**
- Modify: `crates/freshell-freshagent/src/pane_ops.rs` (`respawn_pane` :721-774 LayoutStore fallback + typed bodies; `attach_pane` :792-811 implemented via the `session_identity` seam)
- Modify: `crates/freshell-freshagent/src/layout_store.rs` (a `find_pane_tab(&self, pane_id) -> Option<String>` lookup over per-client snapshots — primary-first, most-recent-first; mirrors `resolve_pane_target`'s existing resolution order)
- Test: `crates/freshell-freshagent/src/pane_ops_tests.rs` (three new tower-oneshot cases)
- Test: `crates/freshell-ws/tests/rest_claude_identity.rs` (one merged-harness parity test: REST + WS + browser-shaped paths consult the one coordinator)
- Test: `test/e2e-browser/specs/mcp-bridge-rust.spec.ts` (respawn-pane + ownership-conflict cases through the MCP stdio binary)
- Test: `test/unit/server/mcp/freshell-tool.test.ts` — NO changes expected (the Node MCP tool proxies REST verbatim; if its mocked contract asserts exact request bodies, they are unchanged) — run it to confirm.

**Interfaces:**
- Consumes: Task 4's coordinator-wired `spawn_terminal_pane` D8 rung (typed 409s) + injected `session_identity: Arc<dyn SessionIdentityLookup>` (already on `FreshAgentState`, wired in `main.rs:441-463`); Task 3's `ownership_snapshot`.
- Produces:
  - `POST /api/panes/:id/respawn` resolves the pane via `pane_tabs` FIRST, then `LayoutStore::find_pane_tab` (browser-created/error panes work in place); both miss → typed `404 { code: "PANE_NOT_FOUND", message }`; ownership conflicts surface the typed 409 envelope with `ownerKind`/`ownerGeneration`.
  - `POST /api/panes/:id/attach` body `{ sessionRef: { provider, sessionId } }`: coordinator observes; terminal-owned → resolves the `terminalId` via `SessionIdentityLookup::terminal_for_session`, broadcasts `ui.command{pane.attach}` with terminal content carrying `liveTerminal`, `200 { ok: true, terminalId }`; other owner/transition → typed 409 owner info. The deferral comment (:776-811) is replaced — the `SessionIdentityLookup` seam (registry.rs:675-678) IS the TerminalIdentityRegistry read surface, wired across the crate boundary exactly for this purpose.

**Respawn data-path rulings (validated by T6, `.worktrees/.the-usual-logs/b8ke-handoff/reports/load-bearing-validator-T6.md`):** LayoutStore snapshots verbatim-retain every well-formed leaf including error panes — terminal panes carry `mode`/`sessionRef`/`initialCwd`/`status` (incl. `create-failed`)/`restoreError` as raw JSON, fresh-agent panes carry `sessionType`/`provider`/`sessionRef`/`status`, and a restore-FAILED pane stays resolvable with its error content folded in (pinned by `layout_store_tests.rs:1038-1106`; base-exact suite 45/45 green). Two quantified residuals are compensated by the typed `PANE_NOT_FOUND` 404 BY DESIGN — no additional machinery: (1) the layout-mirror debounce window (≤200ms steady-state / ≤1s first-sync after page load; a create-then-immediately-respawn race may miss the store — note a FAILED pane re-syncs ~200ms after its error status lands, since the failure fold itself triggers the mirror); (2) no re-sync after a silent WS reconnect or a server restart with a quiescent browser (the mirror is change-gated on `lastPayload`; a page reload always re-sends). Reconstruction keys on `sessionRef`/`initialCwd` — NEVER `resumeSessionId` (persistence strips it on reload, `stripTransientSessionFields`, persistMiddleware.ts:245-270). Under this task's caller-supplies-fields design that ruling is inert; if a later task reads reconstruction fields from the LayoutStore pane content instead, it must read `initialCwd` (not `cwd`) and `sessionRef`.

- [ ] **Step 1: Write the failing behavioral tests**

In `crates/freshell-freshagent/src/pane_ops_tests.rs` (tower-oneshot in-process style of the file):

```rust
#[tokio::test]
async fn respawn_resolves_a_browser_created_pane_through_the_layout_store() {
    // Build a FreshAgentState with a LayoutStore; simulate a browser sync:
    // state.layout.update_from_ui(&ui_layout_sync_with_pane(pane_id, tab_id), "client-a").
    // pane_tabs has NO entry for pane_id.
    // POST /api/panes/{pane_id}/respawn { mode: "claude",
    //   sessionRef: { provider: "claude", sessionId: "sid-r10" }, cwd }.
    // Force a successful spawn (fake claude CLI spec wired like the existing
    // respawn tests).
    // Assert: 200 { terminalId } — recovery occurred IN PLACE (no 404), and the
    // broadcast ui.command{pane.attach} carries the same tabId/paneId.
}

#[tokio::test]
async fn respawn_for_a_pane_that_never_populated_pane_tabs_is_typed_not_found() {
    // No pane_tabs entry, no LayoutStore entry.
    // POST respawn -> 404 with body { "code": "PANE_NOT_FOUND", ... } (typed JSON,
    // not the legacy bare "pane not found" string envelope).
}

#[tokio::test]
async fn respawn_ownership_conflict_returns_typed_owner_info() {
    // pane_tabs entry exists; the sessionRef is owned by a live fresh-agent
    // runtime (seed the coordinator: begin_start + commit_live FreshAgent).
    // POST respawn { mode: "codex", sessionRef: {...} } -> 409 envelope with
    // { code: "RESTORE_UNAVAILABLE", ownerKind: "fresh-agent", ownerGeneration: N }.
    // Assert: NO terminal spawned (registry row count unchanged) and the
    // sessionId is echoed unchanged in the envelope's message.
}

#[tokio::test]
async fn attach_pane_binds_a_terminal_owned_session_and_broadcasts_pane_attach() {
    // Seed: a terminal owns (provider, sid) — registry row + coordinator
    // Live{Terminal} + session_identity wired (the file's existing
    // with_session_identity test wiring).
    // POST /api/panes/{pane_id}/attach { sessionRef: { provider, sessionId } }.
    // Assert: 200 { ok: true, terminalId }; a ui.command{pane.attach} broadcast
    // carrying terminal content with liveTerminal { terminalId } for the pane.
}

#[tokio::test]
async fn attach_pane_for_a_fresh_owned_session_returns_typed_owner_info() {
    // Seed Live{FreshAgent} ownership. POST attach -> 409 { code:
    // "RESTORE_UNAVAILABLE", ownerKind: "fresh-agent", ownerGeneration } —
    // never a blind rebind, never "not implemented".
}
```

In `crates/freshell-ws/tests/rest_claude_identity.rs` (the merged REST+WS harness):

```rust
/// kata b8ke Task 10: REST, WS, and browser-shaped creation all consult the
/// ONE coordinator — a fresh-agent owner established via WS makes BOTH the
/// REST POST /api/tabs terminal spawn AND a respawn of a browser-created
/// pane answer the SAME typed conflict, and neither spawns a second runtime.
#[tokio::test]
async fn rest_ws_and_browser_paths_share_the_one_coordinator() {
    // spawn_merged_server; establish a live freshclaude owner over WS for sid;
    // REST POST /api/tabs { mode: "claude", sessionRef: { claude, sid } } ->
    //   409 RESTORE_UNAVAILABLE with ownerKind fresh-agent;
    // sync a browser layout containing a pane for the same sessionRef
    //   (ui.layout.sync over WS), then REST POST /api/panes/{pane}/respawn ->
    //   409 with the same ownerKind/ownerGeneration;
    // assert zero PTY rows for sid and exactly one sidecar create.
}
```

In `test/e2e-browser/specs/mcp-bridge-rust.spec.ts` (add cases to the existing MCP stdio drive of the Rust server):

```ts
test('respawn-pane recovers a browser-created pane in place through the coordinator', async ({ ... }) => {
  // Boot RustServer with the fake claude CLI; create a terminal pane via the
  // browser page; force a launch failure (point MODE at a failing binary via
  // a second server or kill the terminal); then via McpStdioClient:
  //   respawn-pane { target: <paneId>, mode: 'claude', cwd,
  //                  sessionRef: { provider: 'claude', sessionId: <exact id> } }.
  // Assert the tool result reports success and the pane recovered IN PLACE
  // (same paneId, terminalId present, session id UNCHANGED — no blank session).
})

test('ownership conflict through MCP returns typed owner info', async ({ ... }) => {
  // A live fresh-agent owner for sid; MCP respawn-pane with the same
  // sessionRef -> the tool result carries the typed REST 409 body fields
  // (ownerKind fresh-agent, ownerGeneration) — not "pane not found".
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-freshagent pane_ops && cargo test -p freshell-ws --test rest_claude_identity rest_ws_and_browser`

Expected: FAIL — respawn returns the bare "pane not found" for LayoutStore panes (404, untyped body); attach returns the 400 deferral; the parity test sees untyped conflicts.

- [ ] **Step 3: Add the minimal production implementation**

1. `crates/freshell-freshagent/src/layout_store.rs`:

```rust
    /// kata b8ke: paneId → owning tabId across per-client snapshots —
    /// primary-first, most-recent-first (the `resolve_pane_target`
    /// resolution order). REST-minted panes resolve via `pane_tabs`
    /// first; this covers browser-created/error panes that live only in
    /// layout syncs.
    pub fn find_pane_tab(&self, pane_id: &str) -> Option<String> {
        let inner = self.inner.lock().expect("layout store lock");
        for client in &inner.clients {
            if let Some(tab_id) = client_has_pane(client, pane_id) {
                return Some(tab_id);
            }
        }
        None
    }
```

(`client_has_pane` walks the client's layout tree — reuse the pane-walk helpers `resolve_pane_target` already uses.)

2. `pane_ops.rs::respawn_pane` (:738-746) — replace the bare miss:

```rust
    let tab_id = state
        .pane_tabs
        .lock()
        .expect("pane_tabs mutex")
        .get(&pane_id)
        .cloned()
        .or_else(|| state.layout.find_pane_tab(&pane_id))
        .or_else(|| {
            // Record pane_id for the typed 404 below before giving up.
            None
        });
    let Some(tab_id) = tab_id else {
        return fail_json_typed(StatusCode::NOT_FOUND, "PANE_NOT_FOUND",
            &format!("pane {pane_id} not found in the pane registry or any synced layout"));
    };
```

(`fail_json_typed` = the JSON envelope `{ "code": ..., "message": ... }` — follow `fail_json_restore_unavailable`'s envelope shape from `terminal_tabs.rs:671-690`. The spawn itself already consults the coordinator via Task 4's D8 rung, producing the typed 409s.)

3. `pane_ops.rs::attach_pane` (:792-811) — implement:

```rust
pub(crate) async fn attach_pane(
    State(state): State<FreshAgentState>,
    Path(pane_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }
    // Body: { sessionRef: { provider, sessionId } } (typed 400 otherwise).
    let Some((provider, session_id)) = parse_session_ref(&body) else {
        return fail_json_typed(StatusCode::BAD_REQUEST, "BAD_REQUEST",
            "body must carry sessionRef { provider, sessionId }");
    };
    // The coordinator decides; the identity seam resolves the terminal.
    let snap = state.ownership_snapshot(&provider, &session_id);
    match snap.state {
        OwnershipState::Live { ref owner, generation }
            if owner.kind == RuntimeOwnerKind::Terminal =>
        {
            let Some(terminal_id) = owner.terminal_id.clone().or_else(|| {
                state.session_identity.as_ref()
                    .and_then(|lookup| lookup.terminal_for_session(&provider, &session_id))
            }) else {
                return fail_json_typed(StatusCode::CONFLICT, "RESTORE_UNAVAILABLE",
                    "terminal owner recorded without a resolvable terminal id");
            };
            // Broadcast the pane-attach content (terminal pane with liveTerminal).
            state.broadcast(&ServerMessage::UiCommand(UiCommand {
                command: "pane.attach".to_string(),
                payload: Some(json!({ "tabId": <tab from pane_tabs/layout>, "paneId": pane_id,
                    "content": { "kind": "terminal", "mode": <mode from the terminal row>,
                                 "sessionRef": { "provider": provider, "sessionId": session_id },
                                 "liveTerminal": { "terminalId": terminal_id },
                                 "status": "connected" } })),
            }));
            ok_json(json!({ "ok": true, "terminalId": terminal_id }), "pane attached")
        }
        OwnershipState::Live { ref owner, generation } =>
            fail_json_typed_with_owner(StatusCode::CONFLICT, &provider, &session_id, owner, generation),
        OwnershipState::Vacant =>
            fail_json_typed(StatusCode::CONFLICT, "SESSION_NOT_OWNED",
                "no live runtime owns this session; respawn instead"),
        _ => fail_json_typed(StatusCode::CONFLICT, "HANDOFF_IN_PROGRESS",
            "a lifecycle operation is in flight for this session"),
    }
}
```

(The terminal's `mode` comes from the registry row via the existing terminal-content plumbing used by `spawn_terminal_pane`'s pane_content construction; the tabId resolves via `pane_tabs` then `layout.find_pane_tab`, typed 404 if neither. Replace the deferral doc comment :776-791 with the seam rationale: `SessionIdentityLookup` (registry.rs:675-678) is the wired read surface of the ws-owned identity registry — the documented cross-crate answer to the old circular-dependency note.)

4. e2e: add the two MCP cases to `mcp-bridge-rust.spec.ts` following its existing `McpStdioClient` patterns (helpers/mcp-stdio-client.ts).

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-freshagent pane_ops && cargo test -p freshell-ws --test rest_claude_identity`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Unify `fail_json_typed`/`fail_json_typed_with_owner` with the existing `fail_json_restore_unavailable` envelope helper so every ownership-conflict door (WS error frame, REST 409, MCP-proxied body) shares one JSON shape.

- [ ] **Step 6: Run impacted-test verification**

Impacted: pane_ops route consumers, MCP tool unit tests (frozen Node tree — confirm unchanged), and the REST e2e family.

Run: `cargo test -p freshell-freshagent && npm run test:vitest -- run test/unit/server/mcp --config config/vitest/vitest.config.ts && bash scripts/e2e-cloud.sh run --local --project=rust-chromium test/e2e-browser/specs/mcp-bridge-rust.spec.ts`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/pane_ops.rs crates/freshell-freshagent/src/layout_store.rs crates/freshell-freshagent/src/pane_ops_tests.rs crates/freshell-ws/tests/rest_claude_identity.rs test/e2e-browser/specs/mcp-bridge-rust.spec.ts
git commit -m "feat(panes): LayoutStore-backed respawn + attach + REST/MCP ownership parity"
```

### Task 11: Two-device Playwright e2e — Codex + OpenCode + offline/reconnect

**Files:**
- Create: `test/e2e-browser/fixtures/opencode-dual-role.ts` (dual-role opencode shim, the `codex-dual-role.ts` pattern)
- Create: `test/e2e-browser/specs/handoff-two-device-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (register the spec in `RUST_ONLY_SPECS` (:187) AND the `rust-chromium` `testMatch` (:450 region) — both, or it silently runs zero tests)
- Modify: `docker/cloud-run/test-durations.txt` (add `handoff-two-device-rust.spec.ts:240`)
- Test: the spec itself (three tests); NOT added to `CLOUD_SKIP_SPECS` in `test/e2e-browser/playwright.cloud.config.ts`

**Interfaces:**
- Consumes: `RustServer` + `TestHarness` (helpers, including `forceDisconnect()` at helpers/test-harness.ts:36-59 — required for the offline scenario below), `installDualRoleCodexCli` (fixtures/codex-dual-role.ts — routes `app-server` argv to the fake app-server, everything else to a terminal fake), `installRecoveryOfferAutoDeclineOnContext` (helpers/recovery-offer.ts — manual `browser.newContext()` bypasses the fixture's auto-decline; adopt it directly), the localStorage key `freshell.device-id.v2` (two contexts ⇒ two durable device ids for free).
- Produces: the kata's two-BrowserContext proof. `reconcile-completion-rust.spec.ts:394-470` stays (it proves same-kind single-flight; the kata's "replacing or extending" is satisfied by this sibling spec adding the two-device cross-kind coverage).

**Validated foundations (T2, `.worktrees/.the-usual-logs/b8ke-handoff/reports/load-bearing-validator-T2.md` — probe-proven, cite rather than re-derive):**
- OpenCode dual-role shim: one `OPENCODE_CMD` binary dispatching on the `serve` positional token serves BOTH lanes — serve boot + `/global/health`, durable `ses_*` minting via `POST /session`, terminal `--session` resume of the EXACT serve-created id, and the shared serve daemon still healthy after the terminal lane's full lifecycle (probe A: A1-A9 all PASS). The dispatch key MUST be the `serve` positional token: the serve lane always spawns `serve` as argv[0] (`crates/freshell-opencode/src/transport.rs:229-237`), while the terminal lane's pinned argv goldens (G-O1/G-O3, `cli_launch_goldens.rs`) have NO positional subcommand — `--port` appears in BOTH lanes and is NOT a valid dispatch key.
- Codex cross-lane durable resume: two independent fake app-server processes sharing one `CODEX_HOME` with `FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES=1` — `thread/start` mints the durable rollout, `thread/resume` echoes the SAME id cross-process, and the shared `appendThreadOperationLogPath` ledger records exactly one start + one resume for the id (probe B). Crash-respawn mints a NEW thread id and rebinds the OLD canonical lease key to the new live key (`codex.rs:3617-3625`); the exit watcher reopens the key on both kill and crash — recovery is never lease-blocked.
- Fake-fidelity caveats (do NOT assert behaviors the fakes don't model): the fake app-server has NO writer-lock modeling (real codex 0.147.0 rejects cross-connection `thread/resume` with -32600; the fake never does) and NO rollout-existence check on resume (`thread/resume` echoes unconditionally; durable gating is the Rust-side `CODEX_HOME/sessions` scan). The "reap the old writer BEFORE starting the new one" ordering is therefore assertable ONLY on the coordinator (server-side `freshell_ownership` log events), never via provider refusal; durability assertions key on the rollout file + thread-op ledger rows, not fake refusals.

- [ ] **Step 1: Write the failing behavioral tests**

`test/e2e-browser/fixtures/opencode-dual-role.ts` (mirror of codex-dual-role.ts):

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// The serve role targets the DB-realistic dual-role fake (fake-opencode.cjs —
// corrected per the T2 validation: the originally sketched
// fake-opencode-server.mjs does not exist at this path, and the in-memory
// providers/fake-opencode-server.mjs is NOT usable through the Rust
// ServeManager). fake-opencode.cjs HAS /global/health (fake-opencode.cjs:716-719
// — the ServeManager health probe requires it, serve.rs:775-778), POST /session
// (durable ses_http_* rows in opencode.db), and the FAKE_OPENCODE_AUDIT_LOG
// ledger (launch/shutdown rows — the daemon-health assertion surface). It is
// the fake all 13 existing freshopencode Rust e2e specs point OPENCODE_CMD at.
export const FAKE_OPENCODE_SERVE = path.resolve(
  __dirname, 'fake-opencode.cjs',
)

/**
 * Install a DUAL-ROLE `opencode` binary into `binDir`: argv containing
 * `serve` routes to the fake serve daemon (HTTP+SSE); everything else execs
 * the given terminal fake (`terminalSource`, an .mjs path). Required by
 * kata b8ke's two-device OpenCode scenario: the shared `opencode serve`
 * daemon and the terminal `opencode` TUI are BOTH selected through
 * OPENCODE_CMD, so one shim must serve both roles.
 */
export async function installDualRoleOpencodeCli(
  binDir: string,
  terminalSource: string,
): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, 'opencode')
  const script = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const argv = process.argv.slice(2)
if (argv.includes('serve')) {
  const result = spawnSync(process.execPath, [${JSON.stringify(FAKE_OPENCODE_SERVE)}, ...argv], { stdio: 'inherit', env: process.env })
  process.exit(result.status ?? 1)
}
const result = spawnSync(process.execPath, [${JSON.stringify(terminalSource)}, ...argv], { stdio: 'inherit', env: process.env })
process.exit(result.status ?? 1)
`
  await fs.writeFile(target, script, 'utf-8')
  await fs.chmod(target, 0o755)
  return target
}
```

`test/e2e-browser/specs/handoff-two-device-rust.spec.ts` (helpers copied per the e2e suite's per-spec-ownership convention — donors: `reconcile-completion-rust.spec.ts` (bootSpec/seedSpecConfig/waitForWsReady/flushPersistence/layout walkers), `settings-split-rust.spec.ts` (two-context pattern), `codex-status-completeness-rust.spec.ts` (dual-role codex)):

```ts
/**
 * HANDOFF TWO-DEVICE (kata b8ke) — the cross-device atomic handoff proof.
 *
 * Two SEPARATE BrowserContexts (distinct localStorage ⇒ distinct durable
 * `freshell.device-id.v2` device ids — two pages in one context are NOT
 * sufficient, they share device identity). Codex scenario via the dual-role
 * CODEX_CMD shim (fake app-server + fake terminal), OpenCode scenario via
 * the dual-role OPENCODE_CMD shim, plus offline/reconnect.
 *
 * Rust-only: registered in RUST_ONLY_SPECS + rust-chromium testMatch.
 * Cloud-legal by design (fake CLIs only — never added to CLOUD_SKIP_SPECS).
 */
import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { installRecoveryOfferAutoDeclineOnContext } from '../helpers/recovery-offer.js'
import { installDualRoleCodexCli } from '../fixtures/codex-dual-role.js'
import { installDualRoleOpencodeCli } from '../fixtures/opencode-dual-role.js'
// ... fs/os/path helpers, per-spec copies of the donor helpers.

test.setTimeout(240_000)

test.describe('Session handoff across two devices (rust only)', () => {
  test('codex: reopen-as-CLI on desktop converges the phone pane and never double-writes', async ({ browser, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    // Two contexts = two devices.
    const desktop = await browser.newContext()
    const phone = await browser.newContext()
    for (const ctx of [desktop, phone]) installRecoveryOfferAutoDeclineOnContext(ctx)
    // Boot the RustServer with the dual-role codex shim (CODEX_CMD) + seeded
    // config (providers: ['codex'], freshAgent: true) + FAKE_CODEX_APP_SERVER
    // durable writes enabled; capture the app-server request log path.
    // (Use the page fixture's e2eServerKind contract: create the server via
    //  createE2eServerHandle with construct options, then pages in each context.)

    // 1. Open the same durable session as FreshCodex on phone and desktop:
    //    desktop creates the freshcodex pane, sends a turn, captures the durable
    //    ref (identity) from the pane state; phone opens the SAME session from
    //    the sidebar (sessions list) — freshcodex pane with the same sessionRef.
    // 2. Select "Reopen as Codex CLI" on DESKTOP (context menu item,
    //    getByRole('menuitem', { name: /reopen as codex cli/i })).
    // 3. Assert: desktop's pane is now a terminal pane whose sessionRef
    //    .sessionId === identity (exact thread id preserved; harness pane state).
    // 4. Assert: no "[Launch failed]" text in desktop's terminal buffer.
    // 5. Assert: phone's matching fresh-agent pane shows the
    //    "open as a terminal" role="alert" card (converged; polling stopped).
    // 6. Wait BEYOND the snapshot debounce + poll windows (settle-count: two
    //    samples >= 5s apart agree) — then assert the app-server request log
    //    shows NO post-handmark fresh-agent resume for the identity (no
    //    sidecar resurrection) and exactly one managed-proxy resume for it.
    // 7. Assert: exactly one runtime owner — the coordinator's log line
    //    (FRESHELL_LOG_DIR rust-server.jsonl: event ownership.handoff.done
    //    outcome committed, one row for this session) and zero
    //    ownership.commit_live StaleGeneration invariants for it.
  })

  test('opencode: reopen-as-CLI keeps the shared serve daemon healthy and the ses_ id stable', async ({ browser, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    // Same two-context setup with the dual-role OPENCODE_CMD shim (fake serve
    // daemon + fake terminal). Both devices hold freshopencode panes for the
    // same ses_* session; desktop reopens as opencode CLI.
    // Assert: exact session resumption (desktop's terminal pane sessionRef
    // .sessionId === the original ses_*, phone's pane converged with the card);
    // the shared serve daemon is STILL the same process (audit/argv log pids:
    // exactly one serve launch row, its pid alive); no duplicate session and
    // no failed terminal pane.
  })

  test('offline/reconnect: a disconnected device converges on reconnect without recreating its stale flavor', async ({ browser, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    // Codex shims. Phone goes offline (phone.setOffline(true)) AND drops its
    // WebSocket (await harness.forceDisconnect() on the phone page) BEFORE
    // the handoff. setOffline ALONE is a context-scoped network blackhole
    // that does NOT close an established WebSocket (probe-proven by T5: the
    // socket stays OPEN, offline-window frames arrive LATE via TCP
    // retransmit, and the server's 4008 closes are backpressure-driven — so
    // no reconnect ever occurs and a bare waitForWsReady would be vacuous).
    // Desktop completes the reopen-as-CLI; wait past the debounce;
    // phone.setOffline(false) → the client's reconnect backoff lands a REAL
    // reconnect. Assert an actual ready-cycle (observe the
    // getWsReadyState()/lastReadyAt transition via the test harness — the
    // forceDisconnect helper already waits on exactly that — do not trust
    // waitForWsReady alone).
    // Assert: the phone's pane reads the authoritative owner from the
    // ready.runtimeOwners replay (the "open as a terminal" card appears; NO
    // freshAgent.create is sent after reconnect — the app-server log count
    // for the identity is stable across the reconnect settle window, and the
    // reconcile respawn fold refused to reset the divergent pane); the phone
    // CAN attach (card's Attach here button lands a terminal pane with the
    // same terminalId). Settle windows must tolerate or explicitly rule out
    // late retransmitted frames from the offline window.
  })
})
```

(Write the three bodies fully at execution time using the donor helpers; every wait uses the settle-count two-samples idiom, never fixed sleeps; every spawn assertion counts fake-binary log rows with pids — the established one-writer proof.)

Registration — `test/e2e-browser/playwright.config.ts`: add `'handoff-two-device-rust.spec.ts'` to `RUST_ONLY_SPECS` (:187) and the matching regex to the `rust-chromium` project's `testMatch` (:450 region, `/handoff-two-device-rust\.spec\.ts$/`). `docker/cloud-run/test-durations.txt`: add `handoff-two-device-rust.spec.ts:240`.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `bash scripts/e2e-cloud.sh run --local --project=rust-chromium test/e2e-browser/specs/handoff-two-device-rust.spec.ts`

Expected: FAIL — before Task 9's client work lands this spec cannot pass (the context-menu path still client-orchestrates; no convergence card exists). Within this task's execution order (after Tasks 8-10), the failure mode at red time is the missing dual-role opencode fixture / missing registration (spec runs zero tests — check the runner's test count, not just the exit code) or the first behavioral assertion (no card on the phone, double sidecar).

- [ ] **Step 3: Add the minimal production implementation**

No production code — this task is fixtures + spec + registration. If a behavioral gap surfaces (e.g., the sidebar lacks an accessible open action for a session on device B), fix the production surface in the owning task's file with its own red/green cycle rather than working around it in the spec.

- [ ] **Step 4: Run the focused test**

Run: `bash scripts/e2e-cloud.sh run --local --project=rust-chromium test/e2e-browser/specs/handoff-two-device-rust.spec.ts`

Expected: PASS — 3 tests, with a visible nonzero test count in the runner output (registration proof).

- [ ] **Step 5: Refactor while green**

Deduplicate the per-spec helper copies only if a second consumer appears; per the suite's per-spec-ownership convention, copies are fine.

- [ ] **Step 6: Run impacted-test verification**

Impacted: the rust-chromium project's spec set shape (registration) and the donors' helpers (unchanged).

Run: `bash scripts/e2e-cloud.sh run --local --project=rust-chromium test/e2e-browser/specs/handoff-two-device-rust.spec.ts test/e2e-browser/specs/reconcile-completion-rust.spec.ts test/e2e-browser/specs/mcp-bridge-rust.spec.ts`

Expected: PASS (the new spec plus its closest neighbors).

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/fixtures/opencode-dual-role.ts test/e2e-browser/specs/handoff-two-device-rust.spec.ts test/e2e-browser/playwright.config.ts docker/cloud-run/test-durations.txt
git commit -m "test(e2e): two-device handoff specs (codex/opencode) with offline reconnect"
```

---

### Task 12: Final verification — coordinated gates, cloud e2e, lint, formatting

**Files:**
- Modify: only what fixes a gate failure (each fix gets its own red/green cycle in the owning file)

**Interfaces:**
- Consumes: everything above.
- Produces: the green final-gate record (the kata's "final verification" section).

- [ ] **Step 1: Focused pre-flight (already green per tasks — re-confirm cheaply)**

Run: `cargo test -p freshell-ownership && cargo test -p freshell-freshagent && cargo test -p freshell-ws --test cross_kind_liveness`

Expected: PASS.

- [ ] **Step 2: Rust workspace + formatting**

Run: `cargo fmt --all -- --check && cargo test --workspace`

Expected: PASS (format clean; the full workspace suite green). If `cargo fmt` reports drift, run `cargo fmt --all` and commit the formatting separately with message `style: rustfmt`.

- [ ] **Step 3: Coordinated full Node suite + typecheck**

Run: `FRESHELL_TEST_SUMMARY="b8ke final gate" npm run check`

Expected: PASS (typecheck + coordinated default/server vitest configs). Waits for the shared coordinator gate if another agent holds it — never kills a foreign holder.

- [ ] **Step 4: Client lint (a11y)**

Run: `npm run lint`

Expected: PASS (the new cards are semantic buttons with aria-labels).

- [ ] **Step 5: Affected e2e on the CONFIGURED backend (cloud)**

Run: `GCLOUD_ROBOT_HOME=/home/dan/.codex/skills/gcloud-robot FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com FRESHELL_TEST_SUMMARY="b8ke e2e cloud gate" bash scripts/e2e-cloud.sh run --cloud --project=rust-chromium test/e2e-browser/specs/handoff-two-device-rust.spec.ts test/e2e-browser/specs/reconcile-completion-rust.spec.ts test/e2e-browser/specs/mcp-bridge-rust.spec.ts`

Expected: PASS with a nonzero succeeded-count for `handoff-two-device-rust.spec.ts` (verify in the job's execution status/logs that all 3 tests ran — a spec filtered by `CLOUD_SKIP_SPECS` or a filter matching no tests is NOT coverage). Confirm `grep -c handoff-two-device-rust test/e2e-browser/playwright.cloud.config.ts` is 0 (not skipped).

- [ ] **Step 6: Commit any residual fixes**

```bash
git status --short
# If (and only if) gate fixes were needed:
git add -A && git commit -m "fix: final-gate adjustments for b8ke handoff"
```

- [ ] **Step 7: Hand off for review**

The worktree is clean and every gate green; the branch `the-usual/b8ke-handoff` is ready for the the-usual review stages. Do NOT push or open a PR without explicit user approval.

---

## Observability contract (reference for Tasks 3-6)

Every coordinator transition logs one `tracing` event on `target: "freshell_ownership"` with the join fields as EVENT fields (the `ws.terminal.create.settled` companion pattern):

| Field | Source |
|---|---|
| `operation_id` | every begin/commit/fail/stop/release/handoff event |
| `provider`, `session_id` | every event |
| `generation` | every event (the record's generation after the transition) |
| `kind` / `from_kind` / `to_kind` | begin/commit events |
| `runtime_id` (`terminal_id`), `live_session_key`, `pid` | commit events |
| `transition` (`event` dotted name) | every event (`ownership.start.begin`, `ownership.live.commit`, `ownership.handoff.begin`, `ownership.handoff.done`, `ownership.stop.commit`, `ownership.released`, `ownership.begin_start.stale_generation`) |
| `initiator` / `outcome` / `duration_ms` / `failure` | handoff runner events |
| invariant violations | `tracing::error!(target: "invariant", ...)` — the existing lease-violation idiom (`registry.rs:2278-2284`, `session_lease.rs:294-296`) |

Assertions live in the Task 6/7 tests via the in-process capturing layer (`diag01_lifecycle_events.rs:20-75` pattern — asserts exactly what the production JsonLayer writes, including dual-carrier event fields). No audit-grade history, no viewer refcounts.

## Coverage map (kata test matrix → tasks)

1. Coordinator unit tests (concurrent terminal-vs-fresh start, opposite handoffs, same-kind attach convergence, stop/crash/cancellation/panic, stale generation commit, max-one-writer stress, distinct sessionRefs) → **Task 1**.
2. Deterministic Rust integration races (snapshot paused, terminal create paused, queued snapshot, reap timeout, target spawn failure, browser disconnect, cancellation/panic + sidecar crash) extending `cross_kind_liveness.rs` → **Tasks 6-7** (plus the outcome-normalized race in **Task 4**).
3. Client unit/integration tests (sessionRef-only handoff codex+opencode; owner transition stops old-kind scheduling; stale scheduled callback cannot lifecycle-start; typed terminal-owned/fresh-owned/handoff-in-progress/reap-timeout/spawn-failure recoverable states with attach/retry; remote-device handoff updates matching panes only; same-mode multi-device; snapshot GET never spawns) updating the FreshAgentView no-AbortSignal coverage at :6933-6947 → **Tasks 5, 8, 9** (the wire-level "never spawns" proof is Task 5's `snapshot_get_never_spawns_while_a_terminal_owns_the_session`).
4. Two-BrowserContext Playwright e2e (codex, opencode, offline/reconnect) → **Task 11**.
5. REST/MCP recovery parity (browser-created pane via LayoutStore, forced launch failure, respawn in place; pane never in pane_tabs; REST/MCP/browser share the coordinator; typed ownership conflict; no recovery changes session id or launches an empty conversation) → **Tasks 4, 10** (+ Task 6's session-id-preserved typed failures).
6. Observability assertions on the structured log fields → **Tasks 3, 6, 7** + the reference table above.
7. Affected e2e specs pass on the configured cloud backend, not in CLOUD_SKIP_SPECS → **Task 12 Step 5**.
8. Reconnect owner discovery (missed-broadcast recovery: offline during handoff, lag-4008 disconnect, page reload; a terminal-owned session must not re-arm a stale-kind freshAgent.create after reconnect) → **Tasks 1-4** (registry `snapshot_records` + `ready.runtimeOwners` wire type + handshake emission + ready-replay integration test), **Task 3** (owner-aware respawn-counter guard), **Task 8** (ready fold + reconcile divergence gate + tests), **Task 11** (offline/reconnect e2e). Validated by T1 (recommendations A1-A7, `.worktrees/.the-usual-logs/b8ke-handoff/reports/load-bearing-validator-T1.md`).

## Self-review record

- The dispatcher-authored User Request block appears verbatim exactly once, above the planner-owned Goal/Architecture/Tech Stack; every explicit constraint maps to a task (coverage map) and every accepted residual is honored (compat cold-start → Task 5 behind the coordinator; deployment out of scope → Task 12 stops before any restart; client cancellation not required → Task 8 fences server-side, scheduler keeps its no-signal contract).
- No stubs, mocks, or test seams are left without a later production task replacing them: the pause hooks (Task 7) are permanent test-only seams in the `TerminalLivenessProbe` injection idiom, not behavior stubs; the fake CLIs are the repo's established e2e provider doubles.
- Known deliberate divergences, each asserted rather than hidden: snapshot GET cold-start remains (accepted tradeoff, coordinator-gated, Task 5); the WS terminal claim rides the existing `paneReconcileV1` gate (legacy connections keep today's probe-based protection — Task 4).
- Every command is a focused repo-owned path except Task 12's coordinated gates; destructive suites route through `scripts/sandbox-test.sh`; cloud commands carry the run-state identity pins.
- Load-bearing validation amendments applied 2026-09-09 (validator reports at `.worktrees/.the-usual-logs/b8ke-handoff/reports/`, cited at each decision site): reconnect owner discovery integrated per T1 recs A1-A6 (`snapshot_records` → `ready.runtimeOwners` → handshake emission → App ready fold → reconcile divergence gate + server-side respawn-counter guard); protocol facts corrected per T3/T4 (version 10 not 8, frozen inventory 64→65 + inventory.rs 104→105, freeze tests run under the port config, handoff-only broadcast scope keeps the T2 wire-type-set differential green); the opencode serve fake corrected to `fixtures/fake-opencode.cjs` per T2 (probe-proven: serve boot + health + ses_* stability + cross-lane resume + daemon survival), with the codex fake-fidelity caveats recorded (no writer-lock, no rollout-existence check — ordering assertable only on the coordinator); offline e2e pairs `setOffline` with `harness.forceDisconnect()` per T5 (setOffline alone blackholes without closing the WS); respawn data-path rulings recorded per T6 (typed PANE_NOT_FOUND compensates the debounce window and server-restart no-re-sync; reconstruction keys on sessionRef/initialCwd, never resumeSessionId); worktree `node_modules` prerequisite added per T4 (Task 3 Step 0); capability-gate and MCP scope rulings recorded per T3 (production-scope reading; MCP coverage at the Rust REST surface).

