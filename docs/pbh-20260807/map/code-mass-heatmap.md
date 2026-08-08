# Code-Mass Heatmap — pbh-20260807 (Lens 3, Rust `crates/` target)

Concerns ranked by volume × churn, tagged documented/undocumented. Undocumented+heavy =
IMPLICIT PROMISE (added to the ledger as P34-P41). Merged from worker artifacts
`/tmp/pbh-20260807/map/mm-mass.md` + `mm-churn.md` (good coverage) with synthesis
verification (`git log --name-only -400 -- crates/` re-count matched worker numbers).

Crate LOC: freshell-ws 54.3k · freshell-server 36.4k · freshagent 27.4k · sessions 15.7k ·
codex 12.8k · platform 11k · terminal 10.3k · activity 8.5k · tauri 5.7k · protocol 3.6k ·
opencode 2.8k. Churn by crate (6 mo): ws 446 > server 316 > freshagent 188 > terminal 92 =
sessions 92 > platform 76 > codex 48. Top-churn files: terminal.rs (119), main.rs (117),
ws/lib.rs (68), registry.rs (48, highest fix-ratio 22/50), terminal_tabs.rs (45).

| Rank | Concern | Mass (non-test LoC) | Churn | Docs | Implicit promise |
|---|---|---|---|---|---|
| 1 | Multi-client reconnect / detach-attach background PTY (registry.rs + ws/terminal.rs + identity/pane-ledger) | >14k | very high (119+48) | **UNDOC** (module docs only) | P34 "server re-attaches a reconnected socket to a running PTY" |
| 2 | Fresh-agent drives + per-session lease (freshagent codex/claude/opencode_ws + session_lease) | >20k | high (188/crate) | PARTIAL (README provider table) | P37 "one session, one live resumed terminal" |
| 3 | Activity / turn-completion / attention truth (ws/activity.rs 6.8k + freshell-activity 8.5k + lanes/signals) | >17k | high; **#614 at tip** | UNDOC at behavior level | P27 reconnect re-sync w/o double-count; truthful bells |
| 4 | Session-directory index / resume resolve / existence (sessions 15.7k + server existence/resolve/session_directory) | >11k | med (12+ each) | PARTIAL; fail-open rule UNDOC | P40 "resume fails open"; sessions appear in history |
| 5 | Remote-access networking (server network.rs 4.2k + net_bind + managed_ports + platform firewall/elevated/port_forward) | ~7k | **hottest last 7 days** (11+3+3), merged at tip | **UNDOC** (plans only) — #1 churn-vs-docs gap | P02/P20 "remote access works and can be safely toggled" |
| 6 | Codex remote-proxy / sidecar continuity (freshell-codex 12.8k: remote_proxy*, durability, launch_lifecycle) | >6k | low-med (48) | UNDOC | P39 "codex turns never duplicate-run / auto-resume across restart" |
| 7 | Auto-resume + respawn caps + **idle auto-kill** (auto_resume.rs 2k + respawn in terminal.rs + registry reaper) | >3k | med (12), reaper changed at tip (24h cap) | UNDOC — README silent on both | P24 bounded-loud auto-resume; **P36 anti-promise: detached idle terminal killed @15min** |
| 8 | Reconcile verdict handshake (reconcile.rs 1.2k + reconcile_freshagent + codex_reconcile) | ~2k | med (9) | UNDOC (plans only) | P35 "pane view reconciled against server truth" |
| 9 | Settings/config persistence (settings_store.rs 3.6k) | ~3.6k | med (14) | **DOC** — recently remediated (R2/R3/R4) | P19 holds; treat as regression-watch only |
| 10 | Tabs-sync in-memory vs disk persistence (tabs.rs + tabs_persist* ~2.5k) | ~2.5k | low | UNDOC + **internally contradictory** | P41 "open tabs survive restart" — only partially true |
| 11 | WS survival mechanics (ws/lib.rs 1.1k: hello timeout, ping, backpressure disconnect) | ~1.3k | high (68) | UNDOC (env knobs absent from README) | P38 "dead socket dropped quietly; session survives" |
| 12 | Windows/WSL path + files handling (server files.rs, platform path.rs/detect.rs) | ~3k | rising (5 last wk, windows-path-files) | PARTIAL (README:57) | P15 Windows/WSL terminals just work |
| 13 | Origin/auth policy (ws/origin.rs, SAFE-01..03, rate_limit) | ~1k | low-med | thin | P14 token auth works; P02 browser origins accepted |
| 14 | Tauri desktop shell (freshell-tauri) | 5.7k | very low | UNDOC | desktop app parity — **dark, see territories** |
| 15 | Extensions registry + extension server lifecycle (server/extensions.rs + extension.server.* frames) | ~2k | low | DOC (README:167-175) | P06 — **dark, no worker touched it** |

## Undocumented + heavy = richest hunting ground (Lens 3 verdict)
1. Reconnect/background-session cluster (#1) — biggest mass, biggest implicit promise (P34), plus the P36/P22 contradiction with the reaper (#7).
2. Remote-access networking (#5) — newest, hottest, thinnest-documented; blast radius = user locked out of their own server.
3. Attention truth (#3) — semantics rewritten at the tip commit (#614) over two earlier reworks; perceptual, user-facing by definition.
4. Fresh-agent lease/drives (#2) — 20k LoC guarding "never two writers of one transcript"; only the happy surface is documented.
5. Session index / resolve (#4) — bugs here = sessions silently missing from history or refusing to resume (P03, the headline README promise).
