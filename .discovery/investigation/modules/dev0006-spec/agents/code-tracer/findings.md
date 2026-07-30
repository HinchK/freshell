# DEV-0006 spec — Code-Tracer findings (Agent 1: HOW)

Investigated: /home/dan/code/freshell, branch `main`, 2026-07-30. HEAD `5bf73dbb`.
Spec: `docs/plans/2026-07-19-dev0006-codex-launch-planning-spec.md` (anchored against
worktree `.worktrees/rust-tauri-port` @ `8e7482e1`; that worktree still exists at
`/home/dan/code/freshell/.worktrees/rust-tauri-port`, but everything below is traced against
**this repo's main working tree**, which has absorbed the port work plus much more).

**Uncommitted-diff caveat:** working tree has uncommitted mods in
`crates/freshell-ws/src/terminal.rs` (hunks @3862, @3921 — auto-resume-cancel/kill path, NOT
the codex-launch regions), `crates/freshell-ws/src/lib.rs` (hunks @48 env_parse helper, @109
doc comment — not codex), `crates/freshell-freshagent/src/terminal_tabs.rs` (hunks @34
imports, @592 `spawn_gate_error_response`, net −11 lines — so committed line numbers for
regions BELOW ~line 600 in that file are ~+11 vs. the working-tree numbers cited here).
All line numbers below are **working-tree** numbers.

---

## 1. Slice 1 — envelope scan + side-effect extraction: PORTED, with tests

- `crates/freshell-codex/src/remote_proxy_envelope.rs` (599 lines):
  - `scan_json_rpc_envelope` — :88
  - `MAX_FULL_PARSE_BYTES` :27, `MAX_RAW_FORWARD_BYTES` :31, `MAX_SCANNED_TOKEN_BYTES` :35
  - unit tests `mod tests` :261
- `crates/freshell-codex/src/remote_proxy_side_effects.rs` (1521 lines):
  - `extract_thread_start_response_candidate` :356
  - `extract_fork_response_candidate` :382
  - `extract_thread_started_notification_side_effects` :454
  - `extract_turn_notification_event` :494
  - `extract_thread_lifecycle_event` :559
  - `extract_fs_changed_repair_trigger` :612
  - `rewrite_thread_fork_request_exclude_turns` :667
  - `normalize_thread_fork_response_for_tui` :726
  - `mod tests` :781 (fixture/table tests incl. fork round-trip :789-795, byte-limit tests)
- Bonus not in the spec: `crates/freshell-codex/src/json_scan.rs` (730 lines) — a shared
  byte-scanning engine consolidating the two hand-rolled TS scanners (module doc :1-12
  explains the deliberate merge and the one preserved divergence in number-token bounding).

## 2. Slice 2 — remote proxy: EXISTS, tested

- `crates/freshell-codex/src/remote_proxy.rs` (1409 lines):
  - `CodexRemoteProxyOptions` :93 (`new(upstream_ws_url, require_candidate_persistence)` :107)
  - `CodexRemoteProxy` :199; `start()` :211 → `(Self, mpsc::UnboundedReceiver<RemoteProxyEvent>)`;
    `ws_url()` :258; `require_candidate_persistence()` :265; `close()` :272
  - Subscription hooks: NOT six `on*` closure sets — deliberately collapsed into ONE ordered
    event stream, `enum RemoteProxyEvent` :185 (`Candidate`, `ThreadStarted`,
    `ThreadLifecycle`, `ThreadLifecycleLoss`, `TurnStarted`, `TurnCompleted`,
    `RepairTrigger`); design rationale doc :175-183.
  - `TurnEventParams` :145, `ThreadLifecycleLossEvent` :155, `RemoteProxyRepairTrigger` :163
    (ProxyClose/ProxyError/FsChanged; `candidate_capture_timeout` deliberately omitted).
  - Tests: `mod tests` :1352 + integration `crates/freshell-codex/tests/remote_proxy_relay.rs`
    (17 test fns).

## 3. Slice 3 — launch planner + sidecar lifecycle: EXISTS, split pure/IO

- Pure half `crates/freshell-codex/src/launch_plan.rs` (792 lines):
  - `CodexLaunchPlanInput` :172; `CodexLaunchPlan` :183 — **fields differ from spec's sketch**:
    the PURE plan is `{session_id :186, binding_reason :188, proxy_required :193,
    require_candidate_persistence :197, runtime_cwd :200, model, sandbox, approval_policy}`.
    `remote_ws_url` + `sidecar` live on the IO-side `CodexTerminalLaunch` instead (see below).
  - `plan_codex_launch` :211 (binding_reason computed :216-222); retry policy
    `plan_codex_launch_retry` :357, `CODEX_INITIAL_LAUNCH_ATTEMPTS` = 5 :36,
    `CODEX_INITIAL_LAUNCH_RETRY_DELAY_MS` :39; `codex_remote_args` :261 (the `--remote`
    4-tuple + loopback validation); `codex_sidecar_spawn_spec` :321;
    `CODEX_MANAGED_REMOTE_CONFIG_ARGS` :33. `mod tests` :374 (decision-table tests incl.
    empty-string-resume TS-falsiness :406).
- IO half `crates/freshell-codex/src/launch_lifecycle.rs` (682 lines):
  - `CodexLaunchSidecar` :134 — `adopt(terminal_id, generation)` :167, `shutdown()` :180
  - `CodexTerminalLaunch` :202 — `{session_id, remote_ws_url, plan, sidecar, events}` (the
    `planCreate` return shape; `events` is the proxy stream "unconsumed until S5")
  - `CodexLaunchPlanner` :228 — `plan_create` :259, `plan_create_with_retry` :327,
    `shutdown` :358 (refuses new plans after shutdown, `CODEX_LAUNCH_PLANNER_SHUTDOWN_MESSAGE` :55)
  - Integration tests: `crates/freshell-codex/tests/launch_lifecycle.rs` (16 test fns).

## 4. Slice 4 — wiring: ALL LANDED

- `CodexTerminalLaunchManager` — `launch_lifecycle.rs:382`; **YES, process singleton**:
  `global()` :399-406 (static `OnceLock`, real `SpawnedCodexAppServerRuntime` factory,
  mirroring `server/index.ts` one-planner-per-process). `adopt` :423, `discard` :443,
  `notify_terminal_exit` :450 (sync-safe, teardown worker), `shutdown` :465.
- `SpawnedCodexAppServerRuntime` — `launch_lifecycle.rs:504` (`new` :520, `with_command` :531,
  argv/env from `codex_sidecar_spawn_spec`).
- WS branch `crates/freshell-ws/src/terminal.rs`:
  - gate `codex_create_uses_managed_launch` :1040 (doc :1036-1039)
  - `plan_codex_managed_launch` :1106-1150ish (env read :1113, `::global()` call :1135)
  - `handle_create` branch :2004-2030; **`codex_remote_ws_url` assignment :2031-2032**
    (`codex_launch.as_ref().map(|l| l.remote_ws_url.clone())`)
  - failed-spawn `discard` :2332-2336; post-create `adopt(terminal_id, launch, 0)` :2375-2384
  - exit-hook `notify_terminal_exit` :1336-1337
  - the same wiring is duplicated in the auto-resume respawn seam (discard :2925-2929,
    adopt :2980-2988) — NOT in the spec (post-spec feature).
- REST branch `crates/freshell-freshagent/src/terminal_tabs.rs`:
  - gate fn :530 (doc :524-529); plan branch :1279-1311 (env read :1289,
    `::global().plan_create_with_retry(..., CODEX_INITIAL_LAUNCH_ATTEMPTS)` :1298-1304)
  - `router.ts:177` resumeSessionId echo :1313-1320 (`codex_effective_resume_session_id`, fn :621)
  - model/sandbox/permissionMode strip when managed :1346-1352;
    `codex_remote_ws_url` :1353-1358; exit-hook `notify_terminal_exit` :1445-1450;
    failed-create `discard` :1565-1572; `adopt` :1585-1596
- main.rs shutdown owner: `crates/freshell-server/src/main.rs:1197-1206`
  (`CodexTerminalLaunchManager::global().shutdown().await` :1204-1206, after
  `registry.kill_all()`, mirrors `server/index.ts:981-1049`).
- e2e: `crates/freshell-ws/tests/codex_managed_launch_e2e.rs` — EXISTS, 358 lines,
  `#[ignore = "host-gated e2e ..."]` :260, flag-OFF control + flag-ON `--remote` 4-tuple +
  live TUI→proxy→fake-app-server relay (flag set :301, cleaned :266/:355).

## 5. The gate — FRESHELL_CODEX_MANAGED_LAUNCH: default STILL OFF

- Const: `crates/freshell-codex/src/launch_plan.rs:59` (`FRESHELL_CODEX_MANAGED_LAUNCH_ENV`),
  predicate `codex_managed_launch_enabled` :64-66 — **only the exact string `"1"` enables**;
  unset/anything else = OFF. `D-C-REVISIT` marker :56-58 (flip must revisit REST permit-hold,
  decision in `docs/plans/2026-07-27-rest-spawn-gate.md` §D-C).
- Read sites: WS `terminal.rs:1113`; REST `terminal_tabs.rs:1289`. No other flags gate it —
  predicate is exactly `mode == "codex" && flag == "1"` (terminal.rs:1040-1042,
  terminal_tabs.rs:530-532).

## 6. Goldens — G-X0 STILL LIVE; G-X1/G-X2/G-W2 present (line ranges drifted)

`crates/freshell-platform/src/cli_launch_goldens.rs`:
- `g_x0_codex_shipped_deviation_shape_dev_0006` :731-758 (fn :738) — present, live, doc still
  says "REPLACED by G-X1 when wired". Spec's anchor 623-650 → **MOVED to 731-758**.
- `g_x1_codex_live_fresh` :260-286 (fn :262); `g_x2_codex_live_resume` :288-307 (fn :290);
  `g_x3_codex_no_app_server_model_sandbox` :311; `g_w2_codex_ws_url_validation` :607-639 (fn :609).

## 7. binding_reason — COMPUTED, still NO consumer

- Producer: `plan_codex_launch` computes it (`launch_plan.rs:216-222`); field
  `CodexLaunchPlan.binding_reason` :188; enum `CodexSessionBindingReason` :137 with
  wire-string test :414; `get_codex_session_binding_reason` :154 (port of
  `codex-launch-config.ts:22-28`).
- Carried onto `CodexTerminalLaunch.plan` (`launch_lifecycle.rs:207-209`, "for the S5
  consumers") — but **dropped at adoption**: `AdoptedTerminalLaunch` keeps only
  `{sidecar, _events}` (`launch_lifecycle.rs:373-376`, insert :428-435).
- Consumers: grep for `session_binding_reason|sessionBindingReason|binding_reason` across
  `crates/freshell-ws`, `crates/freshell-freshagent`, `crates/freshell-terminal` (non-test):
  **ZERO** — only a doc-comment mention (`freshell-platform/src/cli_launch.rs:84`). The Rust
  registry has no `sessionBindingReason` field. S4-review follow-up #3 remains open.
- Legacy consumers for contrast: `ws-handler.ts:2587`, `router.ts:742,1183,1340,1577`.

## 8. S5 targets — proxy-fed path ABSENT, but a parallel (locator-based) subsystem LANDED

- Proxy candidates → durable sessionRef: **NOT consumed.** The proxy event receiver is held
  as the literally-named `_events` field (`launch_lifecycle.rs:375`, `:434`) purely so the
  senders stay connected; comment at `CodexTerminalLaunch` :202-211 says "unconsumed until S5".
- However, since the spec was written a DIFFERENT identity lane landed (Lane B2, server-side
  rollout locator — NOT proxy-based):
  - `crates/freshell-ws/src/codex_identity.rs` — `adopt_codex_identity` :60 binds a verified
    codex thread id into identity store/registry/pane ledger and emits
    `terminal.session.associated` + `terminal.meta.updated` (:229-260); module doc :1-5 says
    the client candidate channel is RETIRED (accept-and-ignore pinned by
    `crates/freshell-ws/tests/codex_candidate_inert.rs`).
  - `crates/freshell-ws/src/codex_association.rs`, `codex_reconcile.rs`, and
    `WsState.codex_locator` (`lib.rs:296-306`, `freshell_sessions::codex_locator`).
- Activity tracking: **EXISTS** — new crate `crates/freshell-activity` whose `codex` module is
  an explicit port of `server/coding-cli/codex-activity-tracker.ts` "(PTY lane)"
  (`freshell-activity/src/lib.rs:14`); hub `crates/freshell-ws/src/activity.rs`,
  `WsState.activity` (`lib.rs:307-313`). PTY/rollout-driven, not proxy-turn-event-driven.
- `terminal.meta.updated` emission: **EXISTS** — protocol variant
  `freshell-protocol/src/server_messages.rs:121-122`; broadcast helper
  `terminal.rs:3256-3262` (DEV-0008 comment :3198); create-time slice :4939-5116;
  emitters `codex_identity.rs:258`, `opencode_association.rs:194`.
- Legacy anchors (main-branch server/, Jul-8): `server/coding-cli/codex-activity-tracker.ts`
  (21,100 bytes); `server/ws-handler.ts:3842` `broadcastTerminalMetaUpdated` (older citations
  of :3682-3695 have drifted here).
- Net: DEV-0008-shape functionality exists via the locator lane; the SPEC's S5 ("consume the
  PROXY's candidates") is still not done, and DEVIATIONS DEV-0006/DEV-0008 both remain open.

## 9. spawn_sidecar duplication — STILL DUPLICATED

`crates/freshell-freshagent/src/codex.rs` (now 7275 lines): `spawn_sidecar` :1959-2050ish
still builds its own `tokio::process::Command` (:1986-2000) with its own
`CODEX_MANAGED_CONFIG_ARGS` const :79; zero references to `codex_sidecar_spawn_spec` or
`SpawnedCodexAppServerRuntime` in that file. S4-review follow-up #1 (spawn-helper
unification) remains open. Spec anchor `codex.rs:1343-1449` → **MOVED to :1959+**.

## 10. Raw-resume handling — unchanged asymmetry, anchors moved

- REST reject: `terminal_tabs.rs` — `INVALID_RAW_CODEX_RESUME_MESSAGE` const :65,
  reject in `requested_resume_session_id_for_mode` :117-135 (throw :127-131), called from
  `derive_resume_identity` :491-509. Spec anchor :124-129 → **MOVED to :127-131**.
- WS acceptance: `terminal.rs` has NO occurrence of `INVALID_RAW_CODEX_RESUME`; codex resume
  id is derived sessionRef-first with a raw `create.resume_session_id` fallback
  :1668-1682 (comment documents the 2026-07-22 sessionRef-resume incident; pinned by
  `tests/codex_session_ref_resume.rs`). Spec anchor :779-782 → **MOVED to ~:1668-1682**.
  Legacy-reject alignment still NOT done (consistent with the spec's fence).

## 11. DEVIATIONS.md + coding-cli.md

- `port/oracle/DEVIATIONS.md` DEV-0006: **:517-527** (record extended: `closure_progress` line
  :526 describing S4 landed dark; `status` :527 = "accepted (open gap … mechanism landed dark
  behind FRESHELL_CODEX_MANAGED_LAUNCH; S5 + flag flip close it)"). Spec anchor 517-526 →
  now 517-527.
- DEV-0008: **:588-653** (partial-port REJECTED note :609; close-with-DEV-0006 :644-646;
  `status` :652-653 = "accepted (terminals.changed parity CLOSED; terminal.meta.updated open
  gap, tracked for closure with DEV-0006)"). NOTE: code now emits `terminal.meta.updated`
  (item 8) — the record text may lag the code; flag for the other agents.
- `port/machine/specs/coding-cli.md` §4e: header at **:380**, note runs :380-388 — spec anchor
  380-387 still VALID.

---

## §7 anchor table — old → new

### Legacy (`server/` on main, Jul-8 — NOT the frozen worktree snapshot the spec used)

| Spec anchor | Status | Current location |
|---|---|---|
| `coding-cli/codex-launch-config.ts:22-28` getCodexSessionBindingReason | VALID | :22-28 |
| `coding-cli/codex-managed-config.ts:1-4` | VALID | :1-4 |
| `coding-cli/codex-app-server/restore-decision.ts:32-77` | VALID | plan :32, resolve :67-76 |
| `launch-planner.ts:125-175,221-316` | VALID (approx) | `planCreate` :125, shutdown :177, adopt-guard :227, sidecar adopt :236 |
| `remote-proxy.ts` ~52 KB (unported) | VALID size (52,046 B) — but **now PORTED** (item 2) |
| `{json-rpc-envelope,json-rpc-side-effects}.ts` (unported) | exist; **now PORTED** (item 1) |
| `ws-handler.ts:928-950` planCodexLaunch | MOVED | fn :970-990 (planCodexLaunchWithRetry call :986) |
| `ws-handler.ts:2438-2519` WS create wiring | MOVED | ~:2528-2612 (requestedCodexResumeSessionId :2528, plan :2533-2539, binding :2587, adopt :2601, publish :2605) |
| `agent-api/router.ts:160-195` | VALID | :161-193 |
| `router.ts:737-749` | VALID | :737 (planner threading), :742 (binding reason) |
| `router.ts:1175` / `:1335` / `:1572-1584` | VALID | :1175, :1335, :1572-1585 (binding :1577; also :1183, :1340) |
| `terminal-registry.ts:295-307` argv assembly | VALID (approx) | codexAppServer branch :305-317, `remoteArgs.push('--remote', …)` :316 |
| `index.ts:322-326` display-id → chat adapter | MOVED | :366-368 (`getCodexDisplayIdSecret` :366, `displayIdSecret` :368) |
| `index.ts:359-365` launch planner ctor | MOVED | :403 (`new CodexLaunchPlanner(...)`), consumed :409, :463, :1240 |

### Port (`crates/`)

| Spec anchor | Status | Current location |
|---|---|---|
| `freshell-ws/src/terminal.rs:779-782` raw resume | MOVED | :1668-1682 (sessionRef-first + raw fallback) |
| `terminal.rs:800` codex settings strip | MOVED | `cli_provider_settings` :1078-1094 (codex → `(None,None,None)` :1086-1088) |
| `terminal.rs:831-835` `codex_remote_ws_url = None` | REPLACED | managed-launch branch :2004-2030; assignment :2031-2032 (now `Some(plan url)` when flag ON) |
| `freshell-freshagent/src/terminal_tabs.rs:90-129` | MOVED | :62-135 (const :65, reject fn :117-135) |
| `terminal_tabs.rs:566-609` REST gap | REPLACED | gate :524-532; plan+wire :1271-1358 |
| `cli_launch_goldens.rs:623-650` G-X0 | MOVED | :731-758 (fn :738) |
| `freshell-codex/src/lib.rs` client core | VALID | :1-80; now also exports `json_scan`, `launch_lifecycle`, `launch_plan`, `remote_proxy`, `remote_proxy_envelope`, `remote_proxy_side_effects` |
| `freshell-freshagent/src/codex.rs:79` CODEX_MANAGED_CONFIG_ARGS | VALID | :79 |
| `codex.rs:1343-1449` spawn_sidecar | MOVED | :1959-~2050 (call sites :608, :700, :1595, :1810, :2348) |
| `port/machine/specs/coding-cli.md:380-387` §4e | VALID | :380-388 |
| `port/oracle/DEVIATIONS.md:517-526` | EXTENDED | :517-527 |
