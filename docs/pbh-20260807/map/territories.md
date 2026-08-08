# Ranked Territories — pbh-20260807 (Rust `crates/` target)

Rank = user-proximity × breadth-or-mass × asymmetry-smell. Each entry: which lenses lit it
(L1 promises / L2 fans / L3 mass-churn), which promises flow through it, and the asymmetry
that makes it smell. Scope rule for every hunter: **Node `server/` + `*.ts` server code is
NOT territory and produces NO findings** (reference-only for ambiguous contracts).

## Ranked list

### T1 — Reload/reconnect trunk artery (L1+L2+L3) — P21, P25, P28, P34, P35, P38
WS handshake → attach/replay → create-dedupe replay → reconcile verdicts, the path every user
crosses every session. Asymmetries: dedupe replays only while terminal RUNNING; reconcile's
ONE 2s deferral vs minutes-long cold index; restore-path frame sink silently drops on dead
connection. Biggest mass (heatmap #1) + top churn files (terminal.rs 119, lib.rs 68).

### T2 — Server-restart recovery & the three survival stores (L1+L3) — P23, P31, P41, P26
Pane ledger + recovery inventory + RecoveryOfferPanel vs in-memory tabs registry vs disk
tabs-persist. Asymmetry: one user concept ("my workspace comes back"), three different
durability stories; tabs registry documented in-code as lossy while a disk module exists.
Data-loss class if the recovery offer is wrong or missing.

### T3 — Provider resume members: "speak with the dead" (L1+L2) — P03, P17, P18, P29, P37, P40
Resume any claude/codex/opencode(/amplifier) session from history or pasted id, from any
device. 4 members × 4 distinct mechanisms (file / rollout / sqlite / stub); fail-open gate;
SESSION_RESERVED lease losers; ResumeSessionDialog's bounded warming retries. The README's
headline promise.

### T4 — Idle reaper vs background-session promise (L2+L3) — P22, P36 (contradiction), P24
registry.rs idle auto-kill (15 min detached; agent modes 24h hard cap, changed AT TIP) vs
"PTY KEEPS RUNNING — background session" + BackgroundSessions UI. Highest fix-density file
(22/50). A detached shell silently dies at 15 min: wrong-silent/data-loss candidate #1.

### T5 — Attention/busy-idle truth (L1+L2+L3) — P09, P27, P13 (deck reads it)
Activity hub + per-provider trackers + completionSeq reconnect seeding; #614 rewrote bell
semantics at the tip commit over #602/#597. Asymmetries: gemini/kimi status-inert; amplifier
tailer attach@Start vs @Eof; BEL-in-escape-sequence parsing. False green / missed bell =
perceptual, every user, every day.

### T6 — freshAgent WS surface, above-side (L1+L2) — P05, P32, P33
Dispatch arms exist for create/attach/send/interrupt/kill — but `approval.respond`,
`question.respond`, `fork`, `compact` (and `codingcli.*`, `ui.layout.sync`) fall into the
silent `_` arm. Plus snapshot asymmetry: claude reads disk (survives restart), codex/opencode
ask live runtime (post-restart 404 → FRESH_AGENT_LOST_SESSION?). Freshclaude chat + deck
approvals ride here.

### T7 — Remote-access networking (L1+L3) — P02, P20, P14
network.rs + net_bind + managed_ports + platform firewall/elevated/port_forward. Newest code
in the tree, hottest churn (last 7 days), thinnest docs, merged at tip. Failure = user locked
out of their own server, or firewall/elevation prompts misbehave. Platform×operation matrix
asymmetries (WSL2 port-forward pair).

### T8 — Crashed-agent auto-resume (L2+L3) — P24, P37, P39
auto_resume.rs breaker (2 retries, cycle cap, healthy-lifetime reset) + respawn generation
caps + TerminalExitBanner copy. Asymmetry: only WS-created terminals auto-resume; REST/agent-
API-created agent panes crash dead silently. Codex crash-respawn supersession chains join here.

### T9 — Session directory/history + search + resolve (L1+L3) — P03, P11, P17, P28
directory_index incremental per-file cache (mtime/size; cached EXCLUSIONS), locators' parse
rules, resume_resolve precedence ladder, warming states. Bug = session silently missing from
history / unresumable / search silently weaker for opencode+amplifier (documented gap — does
the UI say so?).

### T10 — Terminal-pane session association (L2) — P30, P03
codex snapshot-diff (Enter-anchored, first-submit re-snapshot ordering precondition) and
opencode row-diff (cwd+window match) locators + association controllers. Misbind = pane
resumes SOMEONE ELSE'S session later: wrong-silent, hard for a user to even diagnose.

### T11 — Agent-API / self-configuring workspace (L1+L2) — P07, P22, P25
REST /api/tabs, send-keys, capture, wait-for, split/close/select + MCP inject. Known
asymmetries: terminal mode `shell` only (400 for agent modes — is P07 then false?); REST
send_keys opencode continuity fix (AGENT-08) claimed fixed — verify; REST door takes spawn
gate unlike interactive WS.

### T12 — Freshclaude/fresh-agent members, below-side (L2) — P05, P39
Per-provider drives: claude Node sidecar (death is completion-safe), codex app-server
(interrupt RPC, durability), opencode serve (health-probe cold start, idle edge). Leases,
kill-before-release, ExpiredNeedsKill "held closed forever" path — a wedged session key means
the user can NEVER resume that session until restart.

### T13 — Spawn doors above-side: create storms & protections (L2) — P21, P25, P01
Spawn gate FIFO/queue-cap/timeout vs rate limiter vs dedupe, per door. A ~20-tab reload storm
must drain in order; interactive create must stay instant; queue-full/timeout errors must be
loud and recoverable in the UI.

### T14 — Windows/WSL platform seams (L1+L3) — P15
files.rs windows-path handling (fresh churn), platform detect/path/spawn, WSL_DISTRO,
WINDOWS_SHELL fallbacks. Blocked/confusion class for the whole Windows user population.

## Dark-territory note (no territory covers these — assign one dark agent or accept residual)
- **freshell-tauri (5.7k)** — desktop shell: no worker artifact, no territory. README even says Stream Deck is NOT supported in the desktop app; what else diverges? DARK.
- **Extensions lifecycle** (server/extensions.rs + extension.server.* frames; P06 stated in README) — DARK.
- **freshell-server long tail**: updater.rs, proxy.rs, checkpoints.rs, screenshots.rs, repo_icon*, diag/logging, rate_limit.rs, instance_id.rs, shutdown_forensics.rs — DARK (low churn, but updater+proxy are user-reachable).
- **freshell-api (1 file)** — trivial, accept residual.
- **Emergent long-running whole-system issues** (memory growth, ledger growth, scrollback caps over days) — named residual, no single owner.

## Proposed severity matrix (for human ratification)
| Rank | Class | Definition (user-observable) | Examples here |
|---|---|---|---|
| S1 | **data-loss** | Work/session/transcript irrecoverably gone or overwritten | idle reaper kills detached shell w/ unsaved state; double-writer corrupts transcript; recovery offer discards panes |
| S2 | **blocked** | User cannot proceed; no in-UI workaround | can't connect after remote-access toggle; resume permanently SESSION_RESERVED; pane wedged in 'creating' |
| S3 | **wrong-silent** | Wrong result presented as truth, no signal | pane bound to someone else's session; false "completed" turn; stale tab list shown as live |
| S4 | **confusion** | Misleading/undocumented state with a recovery path | dead pane with no explanation; bell that shouldn't have fired; ghost device tabs until restart |
| S5 | **annoyance** | Friction, delay, cosmetic | extra warming retries; flicker; duplicate notifications |
Modulators (escalate one level, cap S1): **silent**, **irreversible**, **trunk-artery** (hits every session). Priority = severity × confidence; report unique root causes only.

## Recommended first hunt wave (8 territories; ~one agent each, T1 gets above+below pair)
1. **T1** reload/reconnect artery (2 agents: above = dispatch/dedupe/replay; below = reconcile/registry agreement)
2. **T4** idle reaper vs background sessions (the ledger's sharpest contradiction)
3. **T3** provider resume members ("speak with the dead" — the headline promise)
4. **T5** attention truth (tip-commit semantics, deck depends on it)
5. **T6** freshAgent WS above-side (silently-swallowed members + post-restart snapshots)
6. **T7** remote-access networking (newest + hottest + lockout blast radius)
7. **T2** restart recovery / three survival stores
8. **T8** crashed-agent auto-resume (incl. the REST-door exclusion)
Plus: 1 dark-territory agent (tauri + extensions + server long tail) when pool allows.
Held for wave 2: T9, T10, T11, T12, T13, T14.
