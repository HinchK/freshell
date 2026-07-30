# DEV-0006/S5 Behavior Catalog — what actually changed since the spec (Agent 2: Behavior Observer)

Baseline: `docs/plans/2026-07-19-dev0006-codex-launch-planning-spec.md` (last substantive update: S4 LANDED note, 2026-07-22).
Window surveyed: `git log --since=2026-07-22 -- crates/freshell-codex crates/freshell-ws crates/freshell-freshagent crates/freshell-platform port/oracle/DEVIATIONS.md` = **263 commits**.
Working-tree note: `crates/freshell-ws/src/terminal.rs`, `crates/freshell-freshagent/src/terminal_tabs.rs`, `crates/freshell-ws/src/lib.rs`, `auto_resume.rs`, `backpressure.rs`, `create_limit.rs` carry **uncommitted modifications** — cited lines in those files are against the working tree at 2026-07-30.

## A. Commit catalog (clustered; S5-relevance per cluster)

### A1. The managed-launch lane itself (freshell-codex) — FROZEN since S4
All commits since 2026-07-22 touching `crates/freshell-codex`: **7 total**.
- `6a163bd3` (07-22) S3 decision layer; `d5d6e423` (07-22) S4 inc.1 WS wiring; `5006e7d6` (07-22) S4 inc.2 REST + shutdown + e2e — the LANDED note's own commits.
- `35cf2864` (07-24) **deletes dead durability-store exports** (`default_durability_store_dir`, `DurabilityCandidate`; -114 lines in `durability.rs`). S5-relevance: HIGH — the freshell-codex durability substrate the spec assumed S5 would write into was pruned as dead code.
- `2a68d027` (07-24) deletes dead codex restore-decision machinery from `launch_plan.rs` (-447 lines). S5-relevance: MEDIUM — restore-decision path superseded by ws-side verdict/ledger machinery.
- `8ad585d2`, `b5f8ac71` — style only (clippy/fmt on `remote_proxy_relay`, tests).
**Net: zero functional additions to `launch_lifecycle.rs` / `remote_proxy*.rs` since S4.** Proxy events remain parked: `launch_lifecycle.rs:373-375` — `_events: mpsc::UnboundedReceiver<RemoteProxyEvent>` "Held (unconsumed) so the proxy's event senders stay connected for S5."

### A2. sessionRef canonicalization (07-22)
`80772ff2` (canonical sessionRef on REST resume creates + terminal frames), `daf20a9e` (ses_ prefix gate), `136b9e94` (**WS derives codex resume from sessionRef** — `terminal.rs:1172-1176` still falls back to raw `resume_session_id`). DEVIATIONS EDEV-07 (`:878`) records REST *synthesizing* sessionRef from legacy resumeSessionId. S5-relevance: HIGH — changes the resume-identity input surface both create paths feed into `plan_create`.

### A3. Codex identity via client channel, P0.3/P0.4 (07-24): `ff80d507`, `413f1b98` (rollout disk-truth verifier), `26e94220`, `a7ffe850`, `7faf197c`
Wired `terminal.codex.candidate.persisted` with four binding guards, emitting `terminal.session.associated` THEN `terminal.meta.updated` (pinned order). S5-relevance: HIGH — first landing of S5-scope behavior (binding + meta.updated for codex terminal panes), via the CLIENT channel, later retired (A5).

### A4. Activity hub + codex status lane, G3/G9 (07-24/25): `e21a6753`, `ebf804c4` (`ActivityHub::bind_codex_session`), `708dfe49`, `75ff858d` (rollout tailer + task-event folder + ownership-proof locator), `2d592afa` (rollout-reconcile lane), `71dd4830` (lane triggers: resume-create locator + candidate adoption), `5cfcb93e` (locator controller, 150ms sweep)
S5-relevance: HIGH — implements S5's "activity/turn events" concern via **disk rollout tailing**, not the proxy. `codex.activity.updated` / `terminal.turn.complete` carry sessionId for codex terminal panes today, flag OFF.

### A5. Rollout locator + candidate retirement (07-26, wave B2): `2cd9a12b` merge; `c8d59245` (extract `adopt_codex_identity` shared tail), `4767b7ec` (**retire `terminal.codex.candidate.persisted` writer — accept-and-ignore**), `857c9d48` (misbind hardening: codex adoption refuses freshagent-known thread ids), `ec4324eb`, `2eec5771` (resume reapplies settings from ledger), `642a6c73`, `8e7279fa`, `3583a1fd` (THREAD_MEMORY_LOST frame), `8c37cfd6` (REST create arms locator, P1.14)
S5-relevance: HIGH — server-side locator is now the SINGLE writer of codex terminal identity; adoption tail = identity upsert → registry meta → ledger → `associated`+`meta.updated` broadcasts → activity bind + rollout attach (`codex_identity.rs:185,229`).

### A6. Pane-identity ledger, P1.8 (07-25): `8ad550fd`, `b0adca76` (supersession), `1c0316a6` (pending markers), `f4457897`/`ed3486f6` (boot scan/GC), `20ca7ff9` (write triggers), `40e57088` (codex adoption writes ledger), `58459fe4`, `07f25282`, `aac28673`, `6927d85e` (`durability.degraded` live frame)
S5-relevance: HIGH — the durable pane→session store now exists and codex terminal panes write to it. This IS "durability binding," delivered outside the S5 slice and outside `freshell-codex`.

### A7. Session leases/guards D7/D8 (07-26/27): `88a33933` (per-sessionRef single-flight + SESSION_RESERVED), `043a9340` (refuse restore while Running owns session), `c4cdc60d`/`b35d714f`/`a3414d21` (freshagent leases), `70c43c65` (D7 on REST resume, #540), `b17c6e83` (cross-kind liveness)
S5-relevance: MEDIUM — any S5 binding/resume work must claim/respect these leases.

### A8. Spawn gate + create protection (07-25/27): `b1209db9`, `2bc1779e`, `44fdd8f3`, `6eb2a477`/`c47bb746`/`3c528e06` (restore gate), `124a917f` (SpawnGate moved to freshell-freshagent), `a00141c9`, `4428b1c4` (REST permit), `c2dc83a8` (ONE shared budget WS+REST), `ce88e23c` (boot assertion), `f3cef839` (**clean up MCP/codex side effects when spawn gate rejects a create**), `e2e9cbc3` (**D-C-REVISIT tripwire**), `b45981fa`, `c3268185` (restore-only scope)
S5-relevance: HIGH for the flag flip — the managed-launch plan now runs UNDER a spawn permit (`terminal_tabs.rs:1271`), and `D-C-REVISIT(FRESHELL_CODEX_MANAGED_LAUNCH)` markers (`launch_plan.rs:56-59`, `terminal_tabs.rs`) make the default flip a gated decision (~226s worst-case permit hold: 5 attempts × 45s SIDECAR_START_BUDGET).

### A9. Auto-resume / crash resilience (07-27/29): `5abd30f3`, `afb87d40`, `4b417ab0` (respawn seam), `6379f24f` (orchestrator), `60a8a8fa`, `2a4379c3`, `60bfdcad`, `cdb6e914`, `0690dc0e`, `544901fa` (flap breaker), `2edbbc9d`, `9a769242`
S5-relevance: MEDIUM — server-side terminal respawn now exists; S5's deferred "recovery re-plan-on-loss" (sidecar level) must compose with it, not duplicate it.

### A10. Mid-session rebind & stale identity (07-28/29): `dde20036` (codex fork drain, guarded identity move, tailer re-attach, previousSessionId), `146c5c36` (fork detection for resume-launched panes), `5c591843` (contract: previousSessionId), `971a506f`/`511440a7` (claude SessionStart signal), `0e97fa7d`/`949a136a` (opencode), `60281e25` (SESSION_IDENTITY_MISMATCH input bounce), `c12e7d71` (claude binding durable BEFORE PTY spawn), `eaa25b7d`
S5-relevance: HIGH — pane identity is now REBINDABLE mid-session; a proxy-candidate binder added by S5 would be a second writer into a system with a single-writer + supersession discipline.

### A11. Codex lane self-healing (07-29, PR #574): `18bc5443` (deadman force-reads in expire_due), `269e80e4` (Rescan forward), `c1c67464`
S5-relevance: MEDIUM — deepens the disk activity lane as the incumbent mechanism S5's proxy turn events would compete with.

### A12. DEVIATIONS.md commits since 07-22: `5006e7d6` (DEV-0006 closure_progress, 07-22), `cd66dd17` (EDEV-08), `cab6c953`, `84baac0b` (DEV-0009). **No update to DEV-0006 (:517-526) or DEV-0008 (:588-653) since 07-22** despite A3-A6 landing.

## B. Plan-doc catalog (per-doc S5-concern classification)

| Doc | S5 concern touched | Classification |
|---|---|---|
| 2026-07-24-codex-identity-claude-restore.md (P0.3/P0.4) | durable binding, `terminal.meta.updated` | **PARTIALLY IMPLEMENTS** — codex pane binding + `associated`→`meta.updated` broadcasts, via client candidate channel (since retired) |
| 2026-07-24-restart-resilience-architecture-analysis.md | durable binding (framing) | **CONFLICTS/REFRAMES** — declares codex terminal identity "never captured server-side" a P0; prescribes server-authoritative ledger + locators, NOT the proxy, as the fix; explicitly rides `terminal.meta.updated` for degradation warnings (:176) |
| 2026-07-25-pane-identity-ledger.md (P1.8/P1.10) | durable binding | **IMPLEMENTS (substrate)** — `~/.freshell/pane-ledger/` binding rows keyed on sessionRef, durable-before-answer, `durability.degraded` frame |
| 2026-07-25-codex-status-completeness.md (G3/G9) | activity/turn events | **IMPLEMENTS** — `CodexActivityTracker::bind_session` + `reconcile_rollout` + hub codex lane; notes "durability store deferred to S5 per launch_lifecycle.rs:21-28" (:77) |
| 2026-07-26-codex-rollout-locator.md (P1.12) | durable binding, meta.updated, activity | **IMPLEMENTS + SUPERSEDES** — server-side rollout locator becomes the ONE codex identity writer; retires the candidate.persisted channel; adoption tail bundles ledger+meta+activity |
| 2026-07-27-rest-spawn-gate.md | flag flip | **COMPLICATES** — managed-launch plan bounded by spawn permit; D-C decision + D-C-REVISIT tripwire required at any `FRESHELL_CODEX_MANAGED_LAUNCH` default flip (:89-123) |
| 2026-07-27-rest-resume-live-guard.md (D7/ks38) | binding/resume semantics | **ADJACENT/COMPLICATES** — REST resume refuses live-owned sessions, claims D8 lease; S5 resume binding must go through the shared predicate |
| 2026-07-28-stale-resume-identity.md | durable binding invariants | **COMPLICATES** — identity is rebindable (codex in-TUI fork via rollout lineage, claude SessionStart); rebind reuses adoption tail + ledger supersession; `previousSessionId` on `terminal.session.associated` |
| 2026-07-29-codex-lane-self-healing.md | activity/turn events | **HARDENS the pre-empting mechanism** — deadman force-read + Rescan on the disk lane |
| 2026-07-29-rust-resolve-parity-spec.md (SYNC-06) | — | **UNTOUCHED** — session resolve endpoint; its "flag flip" is the `sessionResolve` feature flag, not the managed-launch flag |

## C. DEVIATIONS.md status (as of working tree)
- **DEV-0006** (`:517-526`): status `accepted (open gap, tracked for closure)`; `closure_progress` dated 2026-07-22 (S4). Not updated since. Still states "S5 (durability/activity/terminal.meta.updated, whole-or-not) + the flag-default flip land together and CLOSE this record."
- **DEV-0008** (`:588-653`): status unchanged — "rust emits NO `terminal.meta.updated` frames" / "terminal.meta.updated open gap, tracked for closure with DEV-0006." **Stale vs code**: create-time upserts (`terminal.rs:3231/3257-3270,5116`, introduced `b9e0c1a3` 2026-07-16 — pre-dating the spec) and association-time upserts (codex `codex_identity.rs:229`, opencode `opencode_association.rs:172`) are live emitters today.
- New records since: EDEV-07 (REST synthesizes sessionRef from legacy resumeSessionId), EDEV-08 (REST mints createRequestId), DEV-0009 (idle reap). No new deviation records the partial meta.updated shipment.

## D. Goldens / flag (current anchors)
- `g_x0_codex_shipped_deviation_shape_dev_0006` — still present, **drifted** to `cli_launch_goldens.rs:738` (spec cites :623-650). G-X1 `:262`, G-X2 `:290`, G-W2 `:609`. **No G-X0→G-X1 swap.**
- `FRESHELL_CODEX_MANAGED_LAUNCH`: 24 hits / 8 files; default still OFF (`launch_plan.rs:59`); every integration test except the host-gated e2e explicitly `remove_var`s it.
