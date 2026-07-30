# S5 Integration Findings — numbered (Agent 3: INTEGRATION MAPPER)

Evidence base: `integration-map.md` (same directory). Uncommitted working-tree files:
`crates/freshell-ws/src/terminal.rs`, `crates/freshell-ws/src/lib.rs`,
`crates/freshell-ws/src/auto_resume.rs`, `crates/freshell-freshagent/src/terminal_tabs.rs` —
lines cited there are working-tree, not committed.

## A. Where S5 plugs in

**F1 — The single tap point is the held-and-dropped events receiver.**
`CodexTerminalLaunch.events` (`launch_lifecycle.rs:210-211`) carries every
`RemoteProxyEvent` (`remote_proxy.rs:185-193`); at adopt time it is parked unconsumed in
`AdoptedTerminalLaunch._events` (`launch_lifecycle.rs:372-376,:430-436`) and dropped by the
teardown worker on exit. S5 = spawn a per-terminal drain task at
`CodexTerminalLaunchManager::adopt` (covers all three adopt call sites: WS create
`terminal.rs:2374-2383`, auto-resume respawn `terminal.rs:2977-2987`, REST
`terminal_tabs.rs:1588-1590` — hooking the manager once beats hooking three call sites).
Problem: the manager lives in `freshell-codex` and cannot see `WsState`; spec follow-up 2
(spec :190-192) already recommends threading it via `WsState`/`FreshAgentState` DI in S5.

**F2 — The binding write path already exists; reuse it whole.**
`RemoteProxyEvent::Candidate` → `codex_identity::adopt_codex_identity`
(`codex_identity.rs:60-74`) gives S5, for free and in the pinned order
(`apply_codex_identity`, `:186-227`): identity registry upsert, registry meta, durable
sessionRef-keyed pane-ledger row (fsync-before-announce), `terminal.session.associated` +
`terminal.meta.updated` broadcasts, and activity-hub bind (`bind_codex_session` /
`attach_codex_rollout`, `activity.rs:257,:277`) — plus the hijack/misbind guards
(`codex_claim_refused`, `:128-179`). The Rust pane ledger IS the functional equivalent of
legacy's durability store (`pane_ledger.rs:8-13` "the resume-invocation record"). S5 should NOT
port `durability-store.ts`/`durability-proof.ts` wholesale.

**F3 — Turn events map to existing tracker seams, but need a third-lane dedupe.**
Legacy: proxy turn events → registry `codex.turn.started/completed` →
`CodexActivityTracker.onTurnStarted/onTurnCompleted` (`terminal-registry.ts:1920-1943`,
`codex-activity-wiring.ts:90-91`, `codex-activity-tracker.ts:238,:248`), with explicit
BEL/JSONL/app-server triple dedupe (`codex-activity-tracker.ts:438`). Rust tracker
(`freshell-activity/src/codex.rs`) currently dedupes TWO lanes (PTY BEL + rollout reconcile,
`swallow_next_bel` `:30-36,:124-125`). Wiring proxy TurnCompleted directly would double-chime
`terminal.turn.complete`; the tracker's dedupe surface must grow a third clock domain.

**F4 — `terminal.meta.updated` parity target is already satisfied by F2's tail.**
Frame + broadcast shape landed (`server_messages.rs:121`;
`codex_identity.rs:258-276`; create-time slice `terminal.rs:2456-2488,:3230-3269`). What DEV-0008
still lacks for codex panes is the association-time trigger — exactly the candidate bind. Git
enrichment / token usage remain deliberately unported (DEV-0008 record,
`DEVIATIONS.md:603-655`) — S5 does not need them to close the record as adjudicated (closure =
"port ... terminal.meta.updated WHEN the coding-CLI ... session-association subsystem is
ported", `DEVIATIONS.md:645-650`).

## B. Overlaps / conflicts (composition effects)

**F5 — Locator-vs-proxy dual identity source (needs an explicit decision).**
The landed codex rollout locator (2026-07-26 plan; `codex_association.rs:33-47,:57-87`;
armed at `terminal.rs:2405-2450`) will keep running Enter-anchored inference for managed panes.
Same-terminal re-adopt is idempotent (`codex_identity.rs:133-135`), so agreement is benign, but
S5 should suppress arming (or `locator.disarm`, `codex_locator.rs:263`) when a managed launch
exists — otherwise two writers race for first-bind and the locator does wasted fs walks per
Enter. Risk if unaddressed: a foreign same-cwd rollout appearing in the submit window could
bind BEFORE the proxy candidate lands (locator sole-match wins the race), producing a wrong
binding the candidate then cannot correct (bound-elsewhere guard refuses... note the guard
refuses claims bound to OTHER terminals, not corrections of THIS terminal — the candidate would
overwrite via re-adopt only if ids differ, which `identity.upsert` allows; semantics here need a
deliberate rule, not an accident).

**F6 — Fork handling: prefer the landed locator fork lane; don't port codexForkHandoff.**
Proxy side-effects include fork-response candidates + fork-request rewrite
(`remote_proxy_side_effects.rs`); legacy has a whole `codexForkHandoff` state machine
(`terminal-registry.ts:2040-2060`). Rust already solves the user-visible incident with
`watch_fork`/`tick_forks` → `rebind_codex_identity` (D7/A13 guards), pinned by
`tests/codex_fork_rebind.rs`. S5 can treat proxy fork candidates as ordinary rebind inputs or
ignore them; porting fork-handoff would duplicate a solved problem and add a second rebind
driver.

**F7 — `require_candidate_persistence` is recorded but unenforced (whole-or-not hazard).**
Proxy never holds frames or times out capture (`remote_proxy.rs:160-162,:262-271`;
`launch_lifecycle.rs:21-25`). Legacy gates relay on persist and fails identity on
`candidate_capture_timeout` (`terminal-registry.ts:1911-1917,:1946-1951`). If S5 ships binding
without the gate, a crash inside the candidate→ledger window yields a running-but-unrestorable
pane — the exact "confidently divergent vs honestly absent" class council rejected
(`DEVIATIONS.md:608`). S5 must either port the gate or get an explicit adjudicated waiver.

**F8 — `binding_reason` / ownership metadata have no consumers (S5 leftovers by design).**
`CodexLaunchPlan.binding_reason` computed but unconsumed (spec :193-195);
`update_ownership_metadata` records in memory only (`launch_lifecycle.rs:26-28,:660-668`);
generation is hardcoded 0 at every adopt site (vs legacy's per-recovery increments). Legacy
consumers: `sessionBindingReason` drives claude start/resume + `codexUnconfirmedInputAt`
(`terminal-registry.ts:1581,:1676-1679`). Scope these consciously into or out of S5.

**F9 — Reconcile/rebind/lease machinery composes cleanly — no change needed.**
Candidate-derived ids claim no D8 lease (later-resolved identities "claim nothing",
`terminal.rs:1160-1182`); reconcile (`reconcile.rs:142-215`) and inventory
(`lib.rs:475-484`) read the same identity registry + ledger the F2 tail writes; restore resume
derivation (`terminal.rs:1626-1710`, pinned by `tests/codex_session_ref_resume.rs`) picks the
binding up automatically on the next restore. This is the payoff of binding through the shared
tail: the resume button, rebind salvage, and stale-resume work all consume sessionRef homes S5
merely populates earlier.

## C. Flag-flip blast radius (`FRESHELL_CODEX_MANAGED_LAUNCH` → default ON)

**F10 — Runtime consumers (complete list).**
Flag def + gate: `launch_plan.rs:56-66` (exact `"1"`; D-C-REVISIT marker). WS:
`terminal.rs:1040-1042,:1106-1143,:2014-2031` + adopt/discard `:2332-2336,:2374-2383` +
respawn `:2925-2929,:2966-2987`. REST: `terminal_tabs.rs:526,:1288-1319,:1347-1356,
:1439-1440,:1548-1549,:1588-1590`. Shutdown: `main.rs:1204-1206`. Effects when ON: every codex
create/respawn spawns app-server child + proxy; argv gains the `--remote` 4-tuple;
model/sandbox/permissionMode leave argv; `features.apps` forced off; all codex TUI traffic
transits the proxy.

**F11 — Goldens/tests pinned to flag-OFF shape.**
- Retire `g_x0_codex_shipped_deviation_shape_dev_0006` (`cli_launch_goldens.rs:731-738`);
  promote G-X1 (`:260-262`) / G-X2 (`:288`) as live-path pins.
- `tests/codex_managed_launch_e2e.rs`: OFF-control leg (`:266`) inverts meaning post-flip.
- **Silent breakers**: fake-codex integration tests that `remove_var` the flag and assume plain
  CLI spawn — `codex_fork_rebind.rs:351,:501,:588,:702`, `codex_locator_activity.rs:151`,
  `codex_session_ref_resume.rs:282`, `codex_candidate_inert.rs:136`. Post-flip these would run a
  REAL managed plan against a fake `codex` script (exec'd with `app-server --listen` argv) and
  hang through 5×45s probe budgets (`launch_lifecycle.rs:64,:626-649`). They must pin the flag
  OFF explicitly or gain a fake app-server harness.
- Records: `DEVIATIONS.md:526-527` (DEV-0006 closes at flip) + DEV-0008 record (closes with it).

**F12 — Operational hazard gated on the flip: REST spawn-permit hold.**
Managed planning runs UNDER the held REST spawn permit: ~226s worst case vs 10s waits at every
other door (`terminal_tabs.rs:1271-1277`; `docs/plans/2026-07-27-rest-spawn-gate.md:91-115`).
The `D-C-REVISIT(FRESHELL_CODEX_MANAGED_LAUNCH)` tripwire markers exist so the flip cannot ship
without resolving this (likely a separate sidecar budget covering both doors).

**F13 — WS raw-resume asymmetry stays a fenced follow-up.**
WS accepts raw codex `resumeSessionId` where legacy REST rejects
(`terminal_tabs.rs:124-129` enforces; spec §2.1 + §6 fence: flag, don't silently change). The
flip does not change this, but S5 review should re-confirm the fence.
