# ANALYSIS-2 — pbh-20260807 (post late-harvest)

Analyst: fable. Supersedes any earlier analysis written before the deep workers delivered.

**Reframe (ground truth from this run):** the original 1-hour budget was mis-sized, not the
workers. Deep flat-rate map workers legitimately take ~5–5.6 h; hunts ~3+ h. The four deep maps
and one hunt that "ran long" delivered the highest-density artifacts of the run. Everything
below treats the late artifacts as first-class primary sources.

Sources (all complete): mm-mass, mm-churn (mechanical, ~30–40 min); mp-promise-docs,
mp-promise-ui (promise ledgers, ~4.8–5.3 h); mf-server, mf-ws (fan inventories, ~5.2–5.6 h);
h-freshagent-ws (hunt, ~3.2 h). Deduped against FIX-LOG.md F1–F8 (F3 adjudicated already-fixed).

Scope: Rust `crates/` + the claude sidecar `.mjs` inside crates/. Node `server/` out of scope
(read only as parity oracle). Oracle: user-facing (blocked / wrong-silent / confusion /
data-loss). Severity S1 data-loss > S2 blocked > S3 wrong-silent > S4 confusion > S5 annoyance;
silent / irreversible / trunk-artery escalate one level (shown as `S3→S2` etc.).

---

## 1. New findings inventory (NOT already fixed), ranked by severity × confidence

Confidence legend: **V** = worker-verified with file:line citations; **C** = candidate,
needs confirmation (mechanism cited, user-path or enforcement not yet proven).

### Tier 1 — fix/confirm first

**N1 — freshclaude Stop/Interrupt is a silent no-op** — `S2→S1-band` (blocked, escalated: silent) — **V** — h-freshagent-ws F1
- Symptom: user clicks Stop (or presses Esc, or long-press STOP on Stream Deck) mid-turn; the agent keeps running to completion, burning tokens, with zero feedback.
- Mechanism: `FreshClaudeState::handle_interrupt` (freshell-freshagent/src/claude.rs:649-653) writes `{"type":"interrupt"}` to sidecar stdin, but the sidecar dispatch `switch(req.type)` (freshell-claude-sidecar/index.mjs:279-284) has cases only for create/send/shutdown — interrupt falls to `default` and is logged-and-dropped; `handleInterrupt` (index.mjs:257) is dead code. Rust side sends no confirmation frame by design, so nothing surfaces.
- Fix shape: one-line `case 'interrupt': handleInterrupt(req); break`. Smallest fix in the inventory; do it first.

**N2 — freshclaude permission modes ("Default (ask)" / "Plan mode: no edits until approved") may be silently non-enforced** — `S3→S2, potentially S1` — **C** (cross-artifact synthesis; confirm before fixing) — mp-promise-ui × mf-ws A1 mitigating-facts
- Symptom: user selects "Default (ask)" or "Plan mode (read-only, *Research and propose; no edits until approved*)" (FreshAgentSettingsButton.tsx:52-324); agent edits files anyway, with no approval card — because there IS no approval channel in this port.
- Mechanism: the claude sidecar **auto-allows every `canUseTool`** and only surfaces `sdk.turn.waiting` (index.mjs:219-227, cited by mf-ws); provider snapshots advertise `approvals:false, questions:false`. If plan-mode exit / edit-tool gating depends on `canUseTool` (rather than being fully SDK-internal), the hard "no edits until approved" promise is broken silently and irreversibly (files change). Confirm: does the SDK enforce `permissionMode=plan` independent of the auto-allow callback? If not, this is the worst live finding in the run.

**N3 — WS layer serves a BOOT-FROZEN settings snapshot; reconnect silently reverts live settings** — `S3→S2` (wrong-silent, escalated: silent + trunk-artery) — **V** — mf-server F1
- Symptom: (a) user edits provider model/permissionMode/sandbox or defaultCwd in Settings, dialog says saved, **new panes still launch with boot-time values** until restart; (b) any WS auto-reconnect pushes the boot-era `settings.updated` frame and the SPA wholesale-applies it (App.tsx:1151-1153) — the UI **silently reverts** the user's patched settings for the rest of the server lifetime.
- Mechanism: `WsState.settings: Arc<ServerSettings>` frozen at boot (main.rs:200/769; lib.rs:99-100); terminal.create reads it (terminal.rs:1085-1099, :1151, :2022, :3139); PATCH fan-out live-pushes only 3 knobs (settings_store.rs:1630-1651). Legacy re-reads live per connect/create. Also frozen: `config_fallback` notice (main.rs:212) — mid-session config.json corruption never reaches clients.

**N4 — SO_REUSEPORT on the boot listener removes the EADDRINUSE fail-fast → split-brain double-server** — `S3→S2` (wrong-silent, escalated: silent + near-undiagnosable) — **V** (mechanism; trigger requires a second instance) — mf-server F6
- Symptom: accidentally start a second freshell-server on the same port (systemd + manual run, two terminals) → both bind successfully; kernel load-balances TCP flows across two processes with separate registries/settings; panes and terminals appear, vanish, and reappear per reconnect. Only signal: one PaneLedger ERROR log line.
- Mechanism: every listener created SO_REUSEADDR+SO_REUSEPORT, default-on (net_bind.rs:31-35, :52-56; main.rs:920-921, :1404-1409). Legacy Node fails loudly EADDRINUSE.

### Tier 2 — verified wrong-silent (S3)

**N5 — Project color feature is dead end-to-end** — `S3` — **V** — mf-server F5
- Symptom: user sets a project color (HistoryView / context menu) → accepted, nothing happens, forever `#6b7280`. No error (ContextMenuProvider.tsx:613-622 swallows).
- Mechanism: `PUT /api/project-colors` has no route in crates/ (JSON-404 fallback), AND the Rust directory payload never carries `color` at all.

**N6 — Overview "Generate summary with AI" button silently does nothing** — `S3` — **V** — mf-server F5
- Symptom: Sparkles button shown ungated (OverviewView.tsx:424), click → unhandled rejection, button pulses, no summary, no error.
- Mechanism: `POST /api/ai/terminals/{id}/summary` unported. (Context-menu variant is correctly `aiEnabled`-gated; the Overview path is not.)

**N7 — One global 300-token rate bucket shared by the BrowserPane proxy and all `/api/*` (incl. unauthenticated)** — `S3` — **V** (mechanism) — mf-server F8
- Symptom: open a dev server in a BrowserPane → hundreds of module requests stream through `/api/proxy/http/...`, draining the same bucket bootstrap/settings/terminals need → app-wide 429s mid-interaction. On a 0.0.0.0 bind, an unauthenticated LAN scanner can starve the real user (legacy was per-IP).

**N8 — `availableClis`/platform payload computed once at boot** — `S3` — **V** — mf-server F2
- Symptom: install claude/codex while freshell is running → PanePicker never shows it until server restart (legacy detects live per request).

**N9 — Tabs registry is in-memory only despite a disk tabs-persist module** — `S3` — **C** — mm-mass Concern #10
- Symptom: after a server restart, TabsView ("All your tabs across devices") loses tabs from devices not currently connected (e.g., your phone/closed laptop) until each device reconnects and re-pushes; the "pull tab from another device" promise fails silently post-restart.
- Mechanism: tabs.rs is explicitly in-memory-only (tabs.rs:1-25) while tabs_persist.rs writes disk snapshots used by a *different* consumer (recovery inventory). Confirm the post-restart TabsView behavior; three "survival" modules have three different durabilities.

**N10 — "Agent MCP server" settings toggle promises a capability the Rust port doesn't ship** — `S3` — **C** — mp-promise-docs (AdvancedSettings.tsx:66-77 × mcp_inject.rs:16-30)
- Symptom: toggle says "Expose Freshell as an MCP tool to coding agents... create tabs, send keys, screenshots" (default ON; NetworkQuickAccess shows "Agent MCP server: On") — but `mcp_inject.rs:16-30` notes Rust ships **no MCP server binary yet**. README's headline "self-configuring workspace" (README.md:29) silently doesn't work on the Rust server. Confirm what mcp_inject actually injects and whether agents get any tools.

### Tier 3 — verified confusion (S4)

**N11 — /fork offered by codex/opencode capability snapshots, then refused UNSUPPORTED** — `S4` — **V** — mf-ws A1 (residual after F1; do not re-report the silent-drop itself)
- Snapshots advertise `fork:true` (codex.rs:3091; freshagent lib.rs:1344) while dispatch answers `freshAgent.error{UNSUPPORTED_MESSAGE}`; opencode_ws.rs:25/32 even documents fork/compact as out-of-scope while its snapshot still advertises fork. Fix = stop advertising, or implement.

**N12 — Disabled provider's sessions keep appearing in the History sidebar** — `S4` — **V** — mf-server F3
- `session_directory` never filters by `codingCli.enabledProviders` (session_directory.rs:388-399) while `resolve` does (resolve.rs:645-662) — disable a provider, its sessions stay listed (and the 2 s sweep keeps broadcasting their churn) while resume hides them.

**N13 — User-set `sessionType` tags never shown in History** — `S4` — **V** — mf-server F4
- Metadata overlay applied by resolve but not by the directory; session_metadata.rs:114-119 admits the read-side join is "not ported yet."

**N14 — FreshAgentCreate silently gated when `freshAgent.enabled=false`** — `S4` — **V** (low reachability) — mf-ws A2
- No reply at all (terminal.rs:720) vs legacy's `FRESH_CLIENTS_DISABLED{retryable:true}`; pane sits "creating" until the 10 s client backstop. Siblings (Attach/Send/Interrupt/Kill) aren't gated at all — "disabled" only blocks create, inconsistently.

**N15 — BrowserPane on remote deployments: port-forward unported, misleading error** — `S4` — **V** — mf-server F5
- `POST/DELETE /api/proxy/forward*` deliberately unported (proxy.rs:33-35), reachable exactly on LAN/remote deployments; user sees `Failed to connect to localhost:PORT` when nothing was dialed.

**N16 — Proxy percent-decodes the upstream path before re-interpolating** — `S4` — **V** (edge-case reachability) — mf-server F9
- `%23` → `#` truncates the upstream path silently (Vite `/@fs/` with `C#Demo` 404s); `%2F` changes path semantics; failures mislabeled `502 Failed to connect`.

**N17 — freshagent REST auth is header-only; every other router accepts header OR cookie** — `S4` — **V** (low reachability today) — mf-server F7
- Any cookie-only browser-context consumer 401s on `/api/tabs`, `/api/panes/*`, `/api/fresh-agent/*` while succeeding everywhere else. Claims parity with a middleware that accepts both.

### Tier 4 — noted (S5 / doc-gap / deliberate-but-flagged)

- **N18** TerminalAutoResumeCancel unknown-id: silent no-op vs TerminalKill's loud INVALID_TERMINAL_ID (mf-ws A5; documented deliberate) — `S5`.
- **N19** `FreshAgentCreate` with `provider:None` parses then vanishes in `_ => {}` (mf-ws A3) — no frozen-client exposure; protocol-hygiene item for the amplifier-arm cleanup.
- **N20** HOME-less fallback splits three ways, incl. hidden CWD-relative `.freshell/` (mf-server F10) — rare corner, `S5`.
- **N21** Doc gaps that manufacture surprise (mm-mass): idle auto-kill of *explicitly detached* shells at the configured threshold (post-F2 this is the intended residual, but README never warns "background session ≠ immortal"), auto-resume backoff/cycle-cap behavior, fail-open resume when the session store is unreadable. Cheap README fixes, real confusion reducers.
- **A6/A7** (mf-ws) input/attach identity-guard fail-open/fail-closed asymmetry and note_possible_submit ordering: deliberate and commented; recorded as regression-fragile invariants for future test-pinning, not bugs.

### Explicit dedupe notes
- The approval/question/fork/compact **silent drop** is F1 (fixed → loud). h-freshagent-ws independently re-adjudicated it as designed post-fix behavior. Only the *advertised-capability mismatch* (N11) and the *enforcement consequence* of auto-allow (N2) are new.
- mm-mass Concern #3/#1 (idle reaper vs background session) is F2 (fixed); only the doc-gap residual (N21) remains.
- mm-mass Concern #7's fail-open resume, and provider resume-after-restart, are F3 territory (adjudicated already-fixed); only the "user never told why" doc gap survives (N21).

---

## 2. Coverage map

### Real coverage (delivered artifacts)

| Territory | Worker(s) | Depth |
|---|---|---|
| Whole-tree mechanical census (mass, churn, doc-tagging) | mm-mass, mm-churn | Full, shallow-by-design |
| Stated promises (README/docs/settings) | mp-promise-docs | Full ledger |
| Implied promises (all UI copy) | mp-promise-ui | Full ledger |
| freshell-server routers / HTTP / auth / orchestration fans | mf-server | Deep (10 asymmetries + healthy-fan negative results) |
| freshell-ws message dispatch fan (`handle_client_text` + siblings) | mf-ws | Deep (8 asymmetries, full layer map) |
| freshAgent WS above-side (T6: create/send/interrupt/kill/control) | h-freshagent-ws | Hunted, 1 confirmed finding |

### Dark ground (14 workers never delivered — target the next wave here)

Map (7): **mf-freshagent** (the largest crate cluster: codex.rs 7.3k, terminal_tabs.rs 6.2k,
claude.rs, opencode_ws.rs, session_lease — below-side of every fresh-agent op; would confirm N2),
**mf-sessions** (directory_index 3.9k, locators, resolve — History/resume correctness backbone),
**mf-terminal-activity** (registry.rs 5.3k — highest fix-density file in the tree — + activity.rs
6.8k + freshell-activity), **mf-platform-tauri** (elevation, port_forward, platform network —
half of the remote-access surface), **mf-protocol-seams** (client/server message parity; mf-ws
already found dead members, more likely), **mr-wiring**, **mr-reload**.

Hunt (7): **h-remote** (network.rs 4.2k + net_bind + managed_ports — mm-churn's **#1
churn-vs-docs gap**, newest code, merged at tip, widest blast radius; would also adjudicate N4),
**h-attention** (attention-bell cluster #614, the tip commit, third rework of the semantics —
mm-churn's most-likely-live-regression call), **h-crashed-resume** (auto_resume.rs 2k — F8-adjacent
but the breaker/settle machine itself is unexamined), **h-restart-recovery** (partially covered by
F4's fix; the recovery-offer flow end-to-end is not), **h-reload**, **h-idle-reaper** (mostly
retired by F2), **h-provider-resume** (retired by F3 adjudication).

Coverage math: map 6/13 delivered (mechanical 2/2, deep 4/11), hunt 1/8. The delivered set skews
heavily toward the WS/server *above-side*; the provider *below-side* (freshagent internals),
the terminal registry, sessions indexing, and everything remote/attention is dark.

---

## 3. Corrected timing model — "size the box to the work"

Ground truth (launch → artifact):

| Class | Workers | Durations | Delivery |
|---|---|---|---|
| Mechanical census | mm-mass, mm-churn | 30 m, 37 m | 2/2 (100%) |
| Deep flat-rate map (promise ledger / fan inventory) | mp-promise-ui, mf-server, mp-promise-docs, mf-ws | 4 h 47 m – 5 h 36 m | 4/11 (36%) |
| Hunt | h-freshagent-ws | 3 h 13 m | 1/8 (12.5%) |

All workers self-exited; none were killed. Reading: the completers are the ones that ignored the
1-hour framing and did the actual work; the 14 non-deliverers most plausibly exited around a
budget they couldn't fit, leaving **nothing** because artifact-writing was end-loaded. Two
correction levers, in order of importance:

1. **Budget honestly.** Mechanical ≈ 0.5–0.75 h. Deep flat-rate map ≈ **5–6 h** (harvest window
   6–7 h). Hunt ≈ **3–4 h** (harvest window 4–5 h). Tell workers the real budget; a worker told
   "1 hour" that needs five will either rush garbage or exit empty.
2. **Write-as-you-go artifacts.** Require incremental section flushes so a worker that dies at
   70% still leaves 70% of an artifact. This run's non-deliverers yielded exactly zero despite
   burning (collectively) tens of worker-hours.

**Properly-sized overnight run** (assume launch 22:00):
- 22:00 — launch everything at once: mechanical + deep maps + hunts (hunts on known candidates
  needn't wait for maps; a second hunt tranche can be re-targeted at T+1 h off the mechanical output).
- 22:45 — check-in #1: harvest mechanical (expect 100%); re-target/launch tranche-2 hunts.
- 02:00 (T+4 h) — check-in #2: harvest hunts (expect the first completions T+3–4 h).
- 05:00 (T+7 h) — check-in #3: harvest deep maps (expect completions T+5–6.5 h); sweep partial
  artifacts from anything silent; anything with no partial by T+7 h is dead.
- Expected delivery with honest budgets + incremental writes: plan for **70–80%** on deep/hunt
  classes (vs 36%/12.5% under the mis-sized box). To land N artifacts, launch ⌈1.4 × N⌉ workers.
- Three human/analyst touch points total (T+45 m, T+4 h, T+7 h); analysis pass at T+7 h.

The lesson is not "workers are too slow" — a 5.5-hour mf-server delivered 10 ranked, cited,
partially legacy-adjudicated findings plus negative results. That is the correct unit cost for
that artifact. The box was wrong.

---

## 4. Recommended next wave

### Fix first (from this inventory, before or alongside the wave)
1. **N1** interrupt-drop — one-line sidecar dispatch case + a red/green sidecar test. Trivial, S2, silent.
2. **N2** permission-mode enforcement — *confirm first* (30-min hunt-lite: does SDK plan-mode hold under auto-allow `canUseTool`?). If broken: highest-severity live bug in the run.
3. **N3** WS boot-frozen settings — re-read the live store at handshake + terminal.create (mirrors legacy); kills both the stale-launch and the silent-revert-on-reconnect.
4. **N5 + N6** dead SPA routes — either port `PUT /api/project-colors` + `POST /api/ai/terminals/{id}/summary` or gate the UI affordances; today both fail silently.
5. **N4** REUSEPORT — default off for the boot listener (keep for rebind), restoring fail-fast.

### Worker wave (dark ground, priority order)

| # | Territory | Class | Budget | Why now |
|---|---|---|---|---|
| 1 | h-remote: network.rs/net_bind/managed_ports/elevation + N4 adjudication | hunt | 3–4 h | #1 churn-vs-docs gap, newest code at tip, remote-access blast radius |
| 2 | h-attention: #614 bell cluster (activity.rs, freshell-activity/idle.rs) | hunt | 3–4 h | tip commit, third semantic rework, perceptual/user-facing failure class |
| 3 | mf-freshagent: provider adapters below-side + session_lease | deep map | 5–6 h | largest unmapped cluster; below-side of N1/N2/N11; feeds tranche-2 hunts |
| 4 | h-crashed-resume: auto_resume.rs breaker/settle + respawn caps | hunt | 3–4 h | 2k-LoC state machine, only F8-adjacent edges examined |
| 5 | mf-sessions: directory_index/locators/resolve | deep map | 5–6 h | History/resume backbone, thin docs, F5/F7 both lived here |
| 6 | h-tabs-restart: confirm N9 (TabsView after restart) + N10 (MCP toggle) | hunt-lite | 1–2 h | two cheap confirmations that upgrade C→V or retire |
| 7 | mf-terminal-activity: registry.rs + activity hub | deep map | 5–6 h | highest fix-density file; post-F2/F6 the residual invariants deserve a map |

Launch 1–7 together at 22:00 with honest budgets and write-as-you-go mandates; expect ~5 of 7 to
deliver; harvest per the §3 schedule. mf-protocol-seams / mr-wiring / mr-reload stay parked for
wave 3 unless wave-2 maps point at them.
