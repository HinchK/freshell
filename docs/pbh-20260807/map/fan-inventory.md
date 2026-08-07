# Fan Inventory — pbh-20260807 (Lens 2, Rust `crates/` target)

A fan = one side facing many supposedly-interchangeable members. For each: ABOVE (dispatcher),
MEMBERS, BELOW (shared service), and ASYMMETRIES (the bug pheromone — a member handled
differently from siblings). Adjacencies listed at the end are the REAL graph edges to test.
Worker coverage for this lens hung; assembled by synthesis (fable) from direct reads.

## F1 — WS ClientMessage dispatch (the trunk fan)
- ABOVE: per-connection select loop, protocol v7 handshake, keepalive/backpressure (`freshell-ws/src/lib.rs`); the giant match in `freshell-ws/src/terminal.rs:530-940`.
- MEMBERS: 30 wire types (`freshell-protocol/src/client_messages.rs:18-80`): `terminal.*` (create/attach/input/resize/detach/kill/autoResumeCancel/codex.candidate.persisted), `freshAgent.*` (create/attach/send/interrupt/compact/approval.respond/question.respond/kill/fork), `*.activity.list` ×4, `pane.reconcile.request`, `ui.layout.sync`, `ui.screenshot.result`, `codingcli.*` ×3, hello/ping/client.diagnostic.
- BELOW: TerminalRegistry, FreshAgent state slices, activity hub, reconcile deps, broadcast bus.
- ASYMMETRIES:
  - **Declared-but-unmatched members**: the dispatch match shows NO arms for `freshAgent.approval.respond`, `freshAgent.question.respond`, `freshAgent.fork`, `freshAgent.compact`, `codingcli.*`, `ui.layout.sync` — a trailing `_` swallows them silently (terminal.rs:739 comment "`_` keeps swallowing"). If the SPA/deck sends approval.respond (promise P33/P13), it may no-op silently. TOP pheromone.
  - Interactive `terminal.create` bypasses the spawn gate but is rate-limited; `restore:true` creates bypass the rate limiter but take the gate (spawn_gate.rs:30-47, PR #552) — two doors, opposite protections.
  - `freshAgent.attach` routes codex/opencode to LIVE runtime slices but claude to a DISK adapter (survives restart; the others don't — snapshot.rs:28-37).

## F2 — Provider fan (claude / codex / opencode / amplifier / gemini / kimi)
One product promise ("agents work alike": P03, P09, P17, P30) over six members, each with a
DIFFERENT mechanism per subsystem — a fan-of-fans:
- Session locators (BELOW: pane identity binder + ledger): codex = rollout-file snapshot-diff, ENTER-anchored only (`freshell-sessions/src/codex_locator.rs`); opencode = SQLite row-diff, spawn+Enter window (`opencode_locator.rs`); amplifier = pre-created stub dirs, identity minted by launcher (`amplifier_stub.rs`); claude = pre-allocated session id at launch (claude_fresh_prealloc); gemini/kimi = none (never resumable). Managed-codex panes suppress the locator (codex_association.rs `should_arm_codex_locator`).
- Activity trackers (ABOVE: activity hub → attention bells P09/P27): claude = Stop-hook BEL; codex = BEL + rollout task events; amplifier = events.jsonl inotify tailer (attach@Start vs @Eof asymmetry); opencode = serve SSE lane (`opencode_lane.rs`); **gemini/kimi = status-inert** (activity.rs:9-11) — no bells at all for two launchable providers.
- Existence/resume validation (BELOW: `SessionExistenceProbe`): claude = transcript file across ORDERED candidate roots (CLAUDE_CONFIG_DIR > CLAUDE_HOME > ~/.claude — real CLI IGNORES CLAUDE_HOME, claude_snapshot.rs:24-29); codex = rollout path; opencode = DB by-id query; amplifier = dir presence. Fail-open rule for unknown (resume_gate.rs).
- Fresh-agent drives (ABOVE: `freshAgent.*`): codex = app-server JSON-RPC sidecar; claude = Node sidecar over stdio (the ONE sanctioned Node piece); opencode = serve REST/SSE; amplifier = NOT a fresh agent. Completion edges are status-guarded differently per provider (turn.status vs subtype==='success' vs idle edge).
- Search tiers: claude+codex file-searchable; **opencode+amplifier unsearchable** at userMessages/fullText tiers (search.rs:13-18) — P11 silently weaker for two providers.

## F3 — Spawn doors (three ways to create a PTY)
- ABOVE: WS `terminal.create` (interactive | restore), REST agent-API `/api/tabs` + `/panes/:id/split` + respawn (`freshell-freshagent/src/terminal_tabs.rs`, `pane_ops.rs`), auto-resume respawn (`freshell-ws/src/auto_resume.rs`).
- MEMBERS: the doors. BELOW: ONE shared `TerminalRegistry.create` + spawn gate + create dedupe + rate limit + MCP injection + provider settings.
- ASYMMETRIES:
  - Auto-resume covers ONLY WS-created terminals; REST/freshagent-created agent panes are explicitly out (auto_resume.rs:12-18) — same crash, different outcome by door.
  - REST door: terminal mode `shell` ONLY; claude/codex/gemini/kimi return a deliberate 400 (terminal_tabs.rs:15-20) — collides with P07 ("tab with four subagents").
  - Gate/limit treatment differs per door (see F1). Dedupe (`create_dedupe.rs`) replays `terminal.created` only while the terminal is RUNNING; after exit the same requestId spawns a NEW terminal — correct-by-legacy but surprising at the reconnect edge.

## F4 — Reconcile/existence verdict fan
- ABOVE: `pane.reconcile.request` handler (one bounded 2s deferral on `index_warming`, reconcile.rs:22-27); SPA folds verdicts (ReconcileWarmingBanner, DeadSessionPanel).
- MEMBERS: per-pane verdicts over pane kinds: terminal panes, fresh-agent panes (`reconcile_freshagent.rs`), codex-managed panes (`codex_reconcile.rs`).
- BELOW: TerminalRegistry × identity registry × pane ledger (supersededBy chains) × disk session index (1s-TTL `directory_index.rs`).
- ASYMMETRIES: three sibling reconcile modules with separate logic; MAX 200 panes → `RECONCILE_TOO_LARGE` (what does the SPA do?); the deferral runs ONCE — a >2s cold index answers warming and relies on the client to retry.

## F5 — Server→client broadcast bus
- ABOVE: every producer (registry fan-out, fresh-agent slices, activity hub, tabs sync, sessions.changed).
- MEMBERS: ~58 server message types (`freshell-protocol/src/server_messages.rs`).
- BELOW: per-connection mpsc → socket; backpressure = 16MB/10s stall → disconnect (`backpressure.rs`); restore-path Channel sink "a dead connection just drops the frames" (create_gate.rs).
- ASYMMETRIES: some producers push pre-serialized frames (fresh-agent) vs typed messages; ordering guaranteed per-terminal via seq, but cross-subsystem frames (e.g. `terminal.created` vs `freshAgent.created` vs `sessions.changed`) have no ordering contract.

## F6 — Three "tab/workspace survival" stores (interface-with-impls by accident)
- ABOVE: SPA tabs UI + tabRegistrySync + RecoveryOfferPanel.
- MEMBERS: (a) in-memory tabs registry — NO restart survival (`tabs.rs:17-27`); (b) disk tabs-persist snapshot generations (`tabs_persist.rs`) — exists but is NOT the live store; (c) pane ledger + recovery inventory — identity survival for terminals.
- ASYMMETRY: same user concept ("my open tabs"), three durability stories. mm-mass #10 flags the contradiction (P41).

## F7 — Pane-identity ledger (shared service, many writers/readers)
- ABOVE (writers): WS create/identity stamping, codex/opencode association controllers, fresh-agent `identity_sink` (server implements over the ledger), codex crash-respawn supersession (`supersedes`).
- BELOW (readers): reconcile rung 2b (supersededBy chain), recovery inventory, auto-resume identity, resume validation retire-row.
- ASYMMETRIES: binding rows keyed by sessionRef vs pending markers keyed by terminalId, never joined (G1); write failures "never block but never silent" — is the surface actually user-visible? Quarantine-per-row corruption policy.

## F8 — Remote-access networking (platform × operation matrix)
- ABOVE: Settings UI / NetworkQuickAccess → REST network routes (`freshell-server/src/network.rs`, 4.2k, 11 commits in last week).
- MEMBERS: platforms (Windows, WSL2, macOS, Linux) × operations (bind rebind `net_bind.rs`, firewall rules `freshell-platform/src/firewall.rs`, elevation `elevated.rs`, port forward `port_forward.rs`, managed ports, origins rebuild ALLOWED_ORIGINS).
- BELOW: ElevationRunner, OS firewall CLIs.
- ASYMMETRIES: WSL2 needs port-forward + firewall pair others don't; confirm-disable/confirm-firewall protocol is new; failure here can lock the user out of the server entirely (P02/P20). Newest code, thinnest docs (mm-churn #1 undocumented hotspot).

## F9 — Activity/attention above-layer (deck + tabs consume one truth)
- ABOVE: SPA attention indicators, Stream Deck status backgrounds/rings + waiting counts (P09/P13).
- MEMBERS: per-provider busy/idle/turn-complete edges (see F2), `completionSeq` reconnect seeding, NEW `terminal.idle` edge.
- BELOW: activity hub single-timer deadline scheduler (zero-polling).
- ASYMMETRIES: #614 ("truth-source-verified bells") landed AT TIP over #602/#597 — freshest semantics change in the tree; amplifier attach@Start vs @Eof; codex abort reasons.

## Real adjacencies (test these edges, not the full grid)
- F1→F2: dispatch arms call provider slices (freshAgent.* per provider).
- F3→F7: every spawn door must stamp identity/ledger the same way (claude_fresh_prealloc flag must match genuine-fresh path — resume_validation.rs:21-24).
- F2→F4: locator bindings feed existence/reconcile verdicts; a misbind surfaces as a WRONG verdict later.
- F4→F6: reconcile verdicts drive the SPA's recovery/dead-session flows against the three stores.
- F1→F5: every reply crosses the bus; backpressure disconnect re-enters F1 (reconnect).
- F9→F5: bells ride the bus; a dropped frame = a missed bell.
- F3→F2: spawn-door launch prep (resume argv, MCP inject) is per-provider.
