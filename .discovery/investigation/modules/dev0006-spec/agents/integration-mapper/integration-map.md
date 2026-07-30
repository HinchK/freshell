# S5 (DEV-0006/DEV-0008) Integration Map — WHERE/WHY

Agent 3: INTEGRATION MAPPER. Repo `/home/dan/code/freshell`, branch `main` (HEAD ~7abe9bff).
**Working-tree caveat:** `crates/freshell-ws/src/terminal.rs`, `crates/freshell-ws/src/lib.rs`,
`crates/freshell-ws/src/auto_resume.rs`, `crates/freshell-freshagent/src/terminal_tabs.rs` (and
several client files) carry UNCOMMITTED modifications — every line number cited in those files is
against the working tree, not a commit. All other cites are committed state.

Spec: `docs/plans/2026-07-19-dev0006-codex-launch-planning-spec.md` (§5 Slice 5 at :204-206; S4
LANDED note at :169-198; S5 follow-ups 1-4 at :184-198).

---

## 1. Proxy → lifecycle: where captured events flow today, and where they dead-end

**Producer.** `crates/freshell-codex/src/remote_proxy.rs`:
- Event stream type: `RemoteProxyEvent` enum — `Candidate`, `ThreadStarted`, `ThreadLifecycle`,
  `ThreadLifecycleLoss`, `TurnStarted`, `TurnCompleted`, `RepairTrigger`
  (`remote_proxy.rs:184-193`). One ordered mpsc per proxy instead of legacy's six closure sets
  (design note :175-183).
- `CodexRemoteProxy::start()` returns `(Self, mpsc::UnboundedReceiver<RemoteProxyEvent>)`
  (`remote_proxy.rs:211-256`); relay hub sends via `events_tx` (`:545,:563,:658`).
- `require_candidate_persistence` is recorded on the proxy for "the S5 identity gate"
  (`remote_proxy.rs:262-267`) but is **not enforced** — the relay never holds frames; legacy's
  identity gate (`markCandidatePersisted`/pause/resume, held-frame drain) is deliberately
  unported (`remote_proxy.rs:269-271` close() note; `launch_lifecycle.rs:21-25` module docs).
- `candidate_capture_timeout` repair trigger is OMITTED (`remote_proxy.rs:160-162`) — it belongs
  to the deferred identity gate.

**Carrier.** `crates/freshell-codex/src/launch_lifecycle.rs`:
- `CodexLaunchPlanner::plan_create` starts the real proxy and returns
  `CodexTerminalLaunch { session_id, remote_ws_url, plan, sidecar, events }`
  (`launch_lifecycle.rs:259-320`; `events` field doc'd "The proxy's typed event stream (S5's
  seam)" at `:210-211`).

**THE DEAD-END (S5's tap point).** `CodexTerminalLaunchManager::adopt` moves the receiver into
`AdoptedTerminalLaunch { sidecar, _events }` where it is **held, unconsumed**, purely "so the
proxy's event senders stay connected for S5" (`launch_lifecycle.rs:372-376`, insert at
`:423-438`). No task ever reads it. Every captured candidate / turn / lifecycle event a managed
codex pane produces today is buffered into that channel and dropped when the terminal exits
(`notify_terminal_exit` :450-457 → teardown worker :476-486). **S5 = replace `_events` with a
consumer task keyed by terminal_id.**

**Other explicitly deferred-to-S5 seams** (`launch_lifecycle.rs:21-35` module docs):
- runtime RPC surface (`readThreadTurn`/`listThreadTurns`/`watchPath`/`unwatchPath`) — the
  `CodexLaunchRuntime` trait (`:78-94`) is shaped to grow them;
- `onFsChanged` + lifecycle-loss handler merging; `failedSidecarShutdowns` bookkeeping;
- `update_ownership_metadata` records **in memory only**
  (`SpawnedCodexAppServerRuntime::adopted_metadata`, `:543-547,:660-668`) — "legacy writes the
  durability store's ownership record; that store IS S5" (`:26-28`);
- recovery re-plan-on-loss (`recovery.planCreate`) deferred per spec risk fence (`:29-35`);
- `CodexLaunchPlan.binding_reason` is computed (S3) but has **no consumer** — spec S5 follow-up 3
  (spec :193-195): the Rust registry has no `sessionBindingReason` sink yet.

## 2. Lifecycle → registry / meta: the paths S5 should reuse

**The single canonical identity write tail already exists** —
`crates/freshell-ws/src/codex_identity.rs`:
- `adopt_codex_identity(state, CodexAdoption{terminal_id, thread_id, rollout_path, cwd})`
  (`codex_identity.rs:60-74`) with hijack/misbind guards `codex_claim_refused`
  (`:128-179`): retired-INCLUSIVE bound-elsewhere (ledger A8), freshagent live-session and
  ledger-row rejects (B2xB4).
- `rebind_codex_identity` for mid-session forks (`:81-123`; D7 live-owner guard, A13
  new-id-unowned guard).
- `apply_codex_identity` (`:186-227`) executes the **PINNED load-bearing order**:
  `identity.upsert` → `registry.set_meta` → durable pane ledger
  (`pane_ledger::ledger_resolve_identity`, awaited, fsync-before-announce) → broadcast
  `terminal.session.associated` THEN `terminal.meta.updated` → activity hub
  (`hub.bind_codex_session` + `hub.attach_codex_rollout`). "Do not reorder" (`:182-185`).
- Broadcast shape: `broadcast_terminal_session_associated` (`:238-277`) emits both frames;
  provider-parameterized (codex + claude share it; opencode has the byte-identical sibling
  `opencode_association.rs:172`).

**Protocol layer:** `crates/freshell-protocol/src/server_messages.rs:121,:195`
(`terminal.meta.updated` variant); `common.rs:205` (`TerminalMetaRecord` in
`terminal.inventory.terminalMeta[]` and `terminal.meta.updated.upsert[]`).

**The identity homes:**
- In-memory identity registry: `identity.rs:134-150` `session_ref_for(terminal_id) →
  Option<SessionLocator>` (canonical wire sessionRef; survives retirement,
  `identity.rs:310-318` test).
- Terminal registry meta: `registry.set_meta(..., provider, session_id)`
  (`codex_identity.rs:198-204`; create-time at `terminal.rs:2386-2392`).
- Durable pane ledger: `pane_ledger.rs:8-18` — **binding rows keyed on sessionRef**
  (provider, sessionId), terminalId secondary; pending markers keyed on terminalId, never
  promoted; `bound_session_ref_for_terminal` (`:686`).
- Inventory read joins both: `lib.rs:475-484` fills `terminal.session_ref` from identity registry
  first, pane ledger second (UNCOMMITTED file).

**Create-time meta slice (DEV-0008 partial, landed):** `terminal_meta_record_for_create`
(`terminal.rs:3230-3254`, docs :3197-3229 — git enrichment + token usage deliberately NOT
ported), seeded + broadcast at `terminal.rs:2456-2488` and `broadcast_terminal_meta_created`
(`terminal.rs:3261-3269`, matching `ws-handler.ts:3682-3695`).

**How other CLI modes bind durable identity (the precedents S5 mirrors):**
- **opencode**: `opencode_association.rs` locator + `terminal.meta.updated` tail (`:6,:172`).
- **claude**: server-preallocated session id at create (`terminal.rs:1662,:1666` mint UUID) +
  claude signal rebind through the SAME shared broadcaster (`codex_identity.rs:229-237`).
- **codex today (unmanaged)**: server-side rollout locator (area 3 below).
- **amplifier**: launcher-assigned stub identity (`terminal.rs:2324-2326` GC path).

**Activity events:** hub is `crates/freshell-ws/src/activity.rs` (one per process; module docs
:1-30). Codex lane: `bind_codex_session` (`activity.rs:257-258` → `HubEvent::CodexBind` handled
:473) and `attach_codex_rollout` (`:277`). The tracker itself is
`crates/freshell-activity/src/codex.rs` — the **PTY lane** (submit→pending, BEL→turn.complete
deduped per turn) plus the rollout-reconcile lane, with a cross-lane one-shot BEL-swallow dedupe
because "the PTY and rollout key spaces are disjoint clock domains" (`codex.rs:1-36`, esp.
:30-36, `swallow_next_bel` :124-125,:486-487).

## 3. Restore / resume without managed launch — what a born-with-it binding short-circuits

**Resume derivation (WS create, UNCOMMITTED terminal.rs):** `terminal.rs:1626-1710` — sessionRef
(provider==mode) → legacy `resumeSessionId` → ledger ladder; pinned by
`tests/codex_session_ref_resume.rs:1-28` (2026-07-22 incident: codex ignored sessionRef).
Ledger restore ladder incl. tombstone revive: `terminal.rs:~3185-3194`
("gc_expired tombstone revived by restore"). REST twin enforces the raw-resume reject
(`terminal_tabs.rs:124-129` per spec §2.1; WS accepts raw — spec fence says flag, don't change).

**Fresh-pane inference (the codex rollout locator, landed per
`docs/plans/2026-07-26-codex-rollout-locator.md`):**
- Armed at create for FRESH codex panes only: `codex_association::maybe_arm`
  (`codex_association.rs:33-47`), called post-spawn on the blocking pool
  (`terminal.rs:2405-2450`; A5 Enter-anchored ordering note :2410-2415).
- Every Enter: `note_possible_submit` (`codex_association.rs:57-87`) — re-snapshot + open
  correlation window; **unconditionally** opens the fork-scan window (`:69-78`).
- Sweep: `drain_and_associate` (`:93-`) → `CodexLocator::tick`
  (`crates/freshell-sessions/src/codex_locator.rs:322` — sole clean match → `Located` + disarm)
  → `adopt_codex_identity`.
- Resume panes get `watch_fork` instead (`terminal.rs:2441-2447`; in-TUI /resume fork,
  incident 2026-07-27; `tick_forks` `codex_locator.rs:508`) → `rebind_codex_identity`
  (pinned end-to-end by `tests/codex_fork_rebind.rs:1-17`).
- Self-healing hardening (2026-07-29-codex-lane-self-healing.md): Rescan handling + busy-deadman
  ForceRead on the rollout tailer lane (`freshell-activity/src/codex.rs` deviation 3).

**Short-circuit point:** S5's candidate arrives from `thread/start` **before any rollout-file
inference can fire** (candidate at RPC response vs locator at first-Enter + fs walk). For managed
panes the whole Enter-anchored inference chain (arm → snapshot → submit window → tick walk) is
redundant — but `maybe_arm` (`terminal.rs:2428-2434`) is not managed-launch-aware, so with the
flag ON both sources run. The adoption tail is idempotent for the SAME (terminal, thread) pair
(`codex_identity.rs:133-135` "same-terminal re-adopt allowed"), so the race is benign only if
both sources resolve the same thread id; S5 should either suppress `maybe_arm`/`watch_fork` for
managed panes or explicitly `locator.disarm` at candidate-bind (disarm API:
`codex_locator.rs:263`).

**Auto-resume respawn (crash path)** plans the managed launch **identically** via the shared
`plan_codex_managed_launch` (`terminal.rs:1094-1143`, "Extracted ... so the auto-resume respawn
seam (Task 4) plans identically" :1102-1105) and adopts at `terminal.rs:2977-2987` — so S5's
consumer must attach on BOTH the create and the respawn adopt sites (or, better, inside
`CodexTerminalLaunchManager::adopt` itself).

## 4. Exit / crash: what S5's binding must survive

**PTY exit hook** (`build_pty_exit_hook`, `terminal.rs:1321-1360`, order is load-bearing):
`cleanup_mcp_config` → `finish_pty_exit` → **`CodexTerminalLaunchManager::global()
.notify_terminal_exit(terminal_id)`** (`:1336-1337`; detaches the adopted launch — including the
`_events` receiver — and queues sidecar+proxy teardown, sync-safe from the PTY thread,
`launch_lifecycle.rs:450-457,:476-486`) → `identity.retire` (`:1338`) → ledger
`delete_pending` (`:1346`) → locator disarms (`:1349-1354`) → CrashEvent send.
REST twin: `terminal_tabs.rs:1439-1440` (UNCOMMITTED file).

**Consequences for S5:**
- The event stream **dies with the pane** — teardown drops the receiver. A binding must be
  durable **before** exit: the identity registry survives retirement
  (`identity.rs:310-318`), and the pane-ledger binding row is the durable resume-invocation
  record (`pane_ledger.rs:8-13`). Both are written by `apply_codex_identity` — so binding
  through that tail is sufficient.
- **Crash + auto-resume** (`auto_resume.rs:1-38`, docs; 2026-07-27-agent-crash-resilience.md):
  a NEW sidecar + NEW proxy + NEW events channel is planned per respawn generation
  (same createRequestId, `terminal.rs:2952-2953`); resume plans carry `session_id`, so the fresh
  proxy's `thread/resume` traffic must re-confirm — S5's consumer must re-attach per adoption,
  and the same-terminal idempotent re-adopt guard makes rebinding safe. Note: Rust passes
  `generation: 0` at every adopt site (`terminal.rs:2376,:2981`; `terminal_tabs.rs:1589`) —
  legacy incremented generation on recovery re-plans; ownership-metadata generations are a
  latent S5 concern.
- **Server shutdown**: `main.rs:1197-1206` — manager `shutdown()` runs AFTER
  `registry.kill_all()`; idempotent double-teardown by design
  (`launch_lifecycle.rs:459-474`).
- **Sidecar leak defense**: `/proc` ownership reaper `reap_owned_codex_sidecars` runs on
  spawn-failure, teardown, and never-listened paths
  (`launch_lifecycle.rs:636-643,:671-680`); ownership id minted per runtime (`:599`).
- REST/freshagent-created panes are **outside auto-resume** (`auto_resume.rs:12-17`) but inside
  managed-launch teardown (their own exit hook calls `notify_terminal_exit`).

## 5. Legacy reference (frozen Node `server/`) — the parity target

**Candidate/turn consumption** — `server/terminal-registry.ts:1893-1966`
(`registerCodexSidecarLifecycle`, subscribed when the sidecar is published):
- `sidecar.onCandidate` (`:1909-1917`) → `persistCodexCandidate` (`:2339,:2425` serialized) →
  durability store (`coding-cli/codex-app-server/durability-store.ts`); persist failure →
  `failCodexFreshIdentity('candidate_persist_failed')`.
- `onTurnStarted`/`onTurnCompleted` (`:1920-1943`) → emit registry events
  `codex.turn.started`/`codex.turn.completed` + durability turn-state/rollout-proof handling.
- `onRepairTrigger` (`:1945-1959`): `candidate_capture_timeout` → failCodexFreshIdentity;
  `proxy_close`/`proxy_error` → `handleCodexLifecycleLoss`; else durability proof.
- `onFsChanged` (`:1962-1966`) → `handleCodexRolloutFsChanged` → proof; rollout watch armed via
  the sidecar RPC `watchPath` (`armCodexRolloutWatch`, `:1975-2005`).

**sessionRef mint** — durability → `bindSession(terminalId,'codex', durableThreadId,
'association')` (`terminal-registry.ts:2987`; rollout-proof variant `:2904`), `bindSession`
itself at `:4740-4810` emitting `'terminal.session.bound'`; wire shape from
`buildTerminalSessionRef` (`:190`, used in directory snapshots `:4300`);
`recoverableForRestore` keys on it (`:1502`). `sessionBindingReason` consumers:
`:1581` (claude start), `:1676-1679` (codexUnconfirmedInputAt on resume).

**Activity** — `coding-cli/codex-activity-wiring.ts:50-91`: tracker `bindTerminal` on
`terminal.session.bound` (provider codex); `onTurnStarted/Completed` on the
`codex.turn.started/completed` registry events; wired at `server/index.ts:251`, fanned at
`:550-553`. `CodexActivityTracker.onTurnStarted/onTurnCompleted`
(`codex-activity-tracker.ts:238,:248`) with explicit triple-source dedupe ("the live BEL, JSONL
reconcile, and the app-server onTurnCompleted cannot" double-fire, `:438`).

**Meta/durability fan-out** — `ws-handler.ts:3842-3850` `broadcastTerminalMetaUpdated`
(plain broadcast, not authenticated-only); codex durability frames
`terminal.codex.durability.updated` (`ws-handler.ts:597-602,:660`); create wiring + adopt +
`publishCodexSidecar` (`ws-handler.ts:2532-2605`) — **publish is what arms the subscription**;
Rust has no publish step (the mpsc receiver exists from plan time), so S5's consumer replaces
publish+subscribe with "spawn the drain task at adopt".

## 6. Composition effects / conflicts (post-Jul-22 resilience work vs S5)

- **C1 — Dual identity source (locator vs proxy candidate).** Both feed
  `adopt_codex_identity`. Benign when ids agree (idempotent same-terminal re-adopt), but the
  locator keeps walking the sessions tree per Enter for managed panes (waste + one more writer).
  S5 should suppress/disarm the locator lane for managed panes (area 3).
- **C2 — Dual fork-rebind driver.** Locator fork lane (`watch_fork`/`tick_forks`, pinned by
  `tests/codex_fork_rebind.rs`) vs the proxy's fork side-effects
  (`remote_proxy_side_effects.rs`: fork-response candidate, fork-request rewrite). Legacy's full
  `codexForkHandoff` state machine (`terminal-registry.ts:2040-2060`) is UNPORTED; the landed
  locator fork lane already covers the user-visible incident. S5 can *simplify* by treating
  proxy fork candidates as ordinary rebind inputs into `rebind_codex_identity` (guards D7/A13
  already arbitrate) — or ignore them and keep the locator lane authoritative. Porting
  codexForkHandoff wholesale would duplicate a solved problem.
- **C3 — Triple-source turn events.** PTY BEL lane + rollout reconcile lane already need a
  cross-lane dedupe (`freshell-activity/src/codex.rs:30-36` swallow_next_bel). Proxy
  TurnStarted/TurnCompleted is a THIRD clock domain; legacy dedupes all three
  (`codex-activity-tracker.ts:438`). S5 must extend the tracker's dedupe surface, not just call
  a new entry point — otherwise double `terminal.turn.complete` chimes.
- **C4 — The pane ledger IS the durability store (simplification).** Legacy's
  durability-store/proof machinery persisted candidates for restore identity. In Rust, the
  sessionRef-keyed pane ledger + identity registry + `apply_codex_identity` tail already provide
  durable-before-announce identity with hijack guards. S5's minimal whole-slice = drain
  `RemoteProxyEvent::Candidate` → `adopt_codex_identity` (mint sessionRef, meta.updated, activity
  bind all fall out for free) + turn events → tracker. Rollout-proof RPC
  (`watchPath`/`readThreadTurn`) may be unnecessary given the rollout tailer lane already proves
  liveness from the file.
- **C5 — Unenforced `require_candidate_persistence`.** The proxy records but does not gate
  (area 1). Legacy held TUI frames until the candidate persisted (identity gate) and repaired on
  `candidate_capture_timeout`. If S5 ships binding without the gate, a crash in the
  candidate→ledger window can produce a running-but-unrestorable pane — the exact class council's
  whole-or-not fence targets (spec §6, DEVIATIONS.md:608 rejected partial).
- **C6 — Reconcile/rebind + D8 lease.** `reconcile.rs:142-215` consults identity + ledger +
  `live_terminal_for_session_ref`; the create-time D8 sessionRef lease
  (`terminal.rs:1160-1214`) claims only body-carried ids. Candidate-derived ids are
  later-resolved ("freshly minted or single-source ... claim nothing", `terminal.rs:1164-1166`)
  — S5 binding via the tail composes cleanly; no lease changes needed.
- **C7 — REST spawn gate (D-C tripwire).** Managed plan runs UNDER the held REST spawn permit —
  ~226s worst case vs 10s waits (`terminal_tabs.rs:1271-1277`;
  `docs/plans/2026-07-27-rest-spawn-gate.md:91-115`). Marker comments
  `D-C-REVISIT(FRESHELL_CODEX_MANAGED_LAUNCH)` at the REST call site and on the flag const
  (`launch_plan.rs:56-58`) exist precisely so the flip cannot ship without resolving this.
- **C8 — binding_reason has no home.** S3 computes it; Rust registry lacks a
  `sessionBindingReason` column and its legacy consumers (codexUnconfirmedInputAt,
  claude start/resume). Spec S5 follow-up 3 says wire it with the durability binding.

## 7. Flag-flip blast radius (`FRESHELL_CODEX_MANAGED_LAUNCH` default OFF → ON)

**Definition:** `launch_plan.rs:59` (const), `codex_managed_launch_enabled` — exact `"1"` only
(`launch_plan.rs:63-66`); D-C-REVISIT doc `:56-58`.

**Runtime consumers (all flip behavior):**
- WS create: `terminal.rs:1040-1042` (gate fn), `:1106-1143` (plan; env read :1113),
  `:2014-2031` (handle_create call), `:2374-2383` (adopt), `:2332-2336` (discard on failed
  create). [UNCOMMITTED file]
- Auto-resume respawn: same helper; discard `:2925-2929,:2966-2972`; adopt `:2977-2987`.
- REST create: `terminal_tabs.rs:1288-1310` (plan), `:1312-1319` (resumeSessionId echo,
  router.ts:177 parity), `:1347-1356` (provider-settings strip + proxy URL into
  `CliLaunchInputs`), `:1548-1549` (discard), `:1588-1590` (adopt), `:1439-1440` (exit hook).
  [UNCOMMITTED file]
- Server shutdown: `main.rs:1204-1206`.

**Behavior deltas when ON:** every codex terminal create (WS + REST + crash respawn) spawns a
codex app-server child + loopback proxy; argv gains the `--remote <proxyWs> -c
features.apps=false` 4-tuple first; codex model/sandbox/permissionMode leave argv and route
through the plan; `features.apps` forced off; every codex pane's TUI traffic transits the proxy.

**Goldens/tests pinned to flag-OFF shape:**
- `cli_launch_goldens.rs:731-738` `g_x0_codex_shipped_deviation_shape_dev_0006` — RETIRE at
  flip; promote G-X1 (`:260-262`) + G-X2 resume (`:288`) as live-path pins.
- `tests/codex_managed_launch_e2e.rs` — OFF-control leg (`:266` remove_var) + ON leg (`:301`
  set "1"): after the flip "remove_var" means ON, so the control leg's meaning inverts; the test
  must pin OFF explicitly or drop the control.
- **Fake-codex integration tests that assume plain-CLI spawn** (they `remove_var` the flag,
  i.e. rely on default OFF): `tests/codex_fork_rebind.rs:351,:501,:588,:702`,
  `tests/codex_locator_activity.rs:151`, `tests/codex_session_ref_resume.rs:282`,
  `tests/codex_candidate_inert.rs:136`. After a default flip these would attempt a REAL managed
  plan: `SpawnedCodexAppServerRuntime` would exec the fake `codex` script with
  `app-server --listen ...` argv and probe-dial for up to 45s × 5 attempts
  (`launch_lifecycle.rs:64,:626-649`) — hangs/timeouts, not just assertion drift. They must set
  the flag to non-"1" explicitly (or gain a fake app-server harness).
- DEVIATIONS records flip: `port/oracle/DEVIATIONS.md:526-527` (DEV-0006 → closed at flip) and
  the DEV-0008 record ("terminal.meta.updated open gap, tracked for closure with DEV-0006",
  `DEVIATIONS.md:603-655`).

**Operational deltas:** REST permit-hold hazard (C7); +2 processes per codex pane
(app-server child; proxy is in-process tasks); teardown/reap load on exit storms; any proxy relay
bug now sits on the critical path of every codex terminal.
