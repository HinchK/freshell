# Promise Ledger — pbh-20260807 (Rust `crates/` target)

One line per promise, plain user language. STATED = docs/UI copy; IMPLIED = the UI/code
lets you do it, so it must work; IMPLICIT = undocumented-but-heavy machinery users take
for granted (Lens 3 escalations from mm-mass/mm-churn). Source pointers are worktree-relative.
Human ratifies before hunt launch.

## Stated (README / UI copy)

- P01. You can organize work into tabs and panes — agents, shells, browsers, editors — as many tabs as you want. (README.md:23)
- P02. You can run freshell on one machine and use it from your laptop/phone over VPN/Tailscale. (README.md:24)
- P03. "Speak with the dead": you can resume ANY Claude, Codex, or OpenCode session from ANY device — even sessions not started in freshell. (README.md:25)
- P04. Tabs auto-name from terminal content, drag-and-drop reorder, and show per-pane type icons. (README.md:26)
- P05. Freshclaude is a rich chat alternative to the Claude CLI with full session persistence. (README.md:27)
- P06. You can add pane types / CLI integrations / services via extensions and manage them from the Extensions page. (README.md:28,167-175)
- P07. Self-configuring workspace: ask Claude/Codex to open a browser pane or create a tab with four subagents — the tmux-like API makes it work. (README.md:29)
- P08. Every pane header shows live cwd, git branch, and context usage. (README.md:30)
- P09. When a coding CLI finishes its turn you get an attention indicator (highlight/pulse/darken) that dismisses on click or typing. (README.md:31)
- P10. Right-click a session → AI-generated (Gemini) title. (README.md:32)
- P11. Sidebar search: instant local results, then deep server-side content search. (README.md:33)
- P12. Works on phones/tablets (auto-collapsing sidebar). (README.md:34)
- P13. Stream Deck: keys = tabs (repo icons + status), press to focus, long-press APPROVE/STOP agents, dials/touch strip on Deck+, auto-reconnect after unplug/replug and page reloads. (README.md:35,68-95)
- P14. First run auto-generates an AUTH_TOKEN and prints the URL to connect. (README.md:51)
- P15. On Windows, terminals default to WSL; `WINDOWS_SHELL` picks cmd/powershell instead. (README.md:57)
- P16. All keyboard shortcuts in the table work (new/close/reopen tab, prev/next, move, copy/paste/search…). (README.md:97-115)
- P17. Claude/Codex/OpenCode/Amplifier: session history + launch; Gemini/Kimi: launch only. (README.md:139-153)
- P18. Existing OpenCode work is discovered from OpenCode's own DB and resumable with no manual import. (README.md:153)
- P19. Providers/settings configurable in the Settings UI or `~/.freshell/config.json`, and they persist. (README.md:152; settings_store.rs)
- P20. Remote access can be turned on/off from the sidebar/settings, with visible status and copyable URL. (src/components/NetworkQuickAccess.tsx; crates/freshell-server/src/network.rs)

## Implied (UI affordances)

- P21. After a page reload or a network blip, everything comes back: tabs, panes, running terminals, scrollback — nothing lost, nothing duplicated. (crates/freshell-terminal/src/registry.rs:1-27; freshell-ws/src/create_dedupe.rs; src/components/ReconcileWarmingBanner.tsx)
- P22. Closing a pane/tab or disconnecting does NOT kill the process — it becomes a "background session" you can list, re-open, or kill. (crates/freshell-freshagent/src/pane_ops.rs:16-34; src/components/BackgroundSessions.tsx)
- P23. After a freshell server restart, you're OFFERED recovery of your previous workspace (never silently dropped, never auto-restored wrong). (src/components/RecoveryOfferPanel.tsx; crates/freshell-server/src/recovery_inventory.rs; freshell-ws/src/pane_ledger.rs)
- P24. A crashed coding agent restarts itself (bounded, loud, cancellable) and the banner tells you what happened. (crates/freshell-ws/src/auto_resume.rs:1-40; src/components/TerminalExitBanner.tsx)
- P25. Retries/reconnects never double-spawn: the same create request or resume never yields two terminals or two writers of one session. (freshell-ws/src/create_dedupe.rs; freshell-freshagent/src/session_lease.rs:1-19)
- P26. If a saved session is dead, you get ONE batched dialog and YOU decide per pane — nothing is auto-closed. (src/components/DeadSessionPanel.tsx)
- P27. Busy/idle/needs-attention states are truthful — no false green, no missed bells, and they survive reconnects without double-counting. (freshell-ws/src/activity.rs:1-31; commit #614)
- P28. On a cold boot, panes waiting on the session index show ONE "warming" banner with Retry — not dead panes. (src/components/ReconcileWarmingBanner.tsx; freshell-ws/src/reconcile.rs:20-27)
- P29. Resuming a session whose transcript is gone falls back to a FRESH pane with a notice — never silently wedges, never resumes the wrong thing. (freshell-ws/src/resume_validation.rs; freshell-platform/src/resume_gate.rs)
- P30. A terminal you start an agent in becomes resumable later — freshell figures out which session the CLI created and binds it to the pane. (freshell-ws/src/{codex,opencode}_association.rs; freshell-sessions/src/{codex,opencode}_locator.rs, amplifier_stub.rs)
- P31. Tabs open on your OTHER devices show up in the Tabs view and disappear when that device closes them. (freshell-ws/src/tabs.rs:1-27)
- P32. A freshclaude/freshcodex/freshopencode pane renders its transcript after reload — the pane always "shows something". (freshell-freshagent/src/snapshot.rs:9-16)
- P33. Long-press APPROVE on the deck / the approval UI actually answers the agent's pending approval. (freshell-protocol client `freshAgent.approval.respond`; README.md:70)

## Implicit (undocumented + heavy — Lens 3 escalations; see code-mass-heatmap.md)

- P34. "The server re-attaches a reconnected socket to a running PTY" — 14k+ LoC, zero user docs. (mm-mass #1)
- P35. "A reconnecting client's pane view is reconciled against server truth" (verdicts, supersession chains). (mm-mass #2)
- P36. ANTI-PROMISE, contradicts P22: a detached idle terminal is auto-killed at 15 min (agent modes: 24 h hard cap) — nowhere documented. (freshell-terminal/src/registry.rs:381,853; mm-mass #3)
- P37. "Only one terminal resumes a given session; losers get SESSION_RESERVED + retry hint." (session_lease.rs; terminal.rs:1305-1320)
- P38. "Dead sockets are quietly dropped (ping 30s / hello 5s / 16MB backpressure) and the session survives." (freshell-ws/src/lib.rs, backpressure.rs; mm-mass #6)
- P39. "Codex/claude sidecar death never fakes a completed turn; turns never duplicate-run across restart." (freshell-freshagent/src/claude.rs ADR 2.1; freshell-codex durability)
- P40. "Resume fails OPEN: an unreadable session store still tries to resume rather than refuse" — user is never told this. (freshell-platform/src/resume_gate.rs; mm-mass #7)
- P41. PARTIAL: "open tabs survive a server restart" — tabs registry is in-memory-only while a separate disk tabs-persist module exists. (freshell-ws/src/tabs.rs:17-27 vs tabs_persist.rs; mm-mass #10)

## Ratification notes
- P36 vs P22 is the ledger's sharpest internal contradiction — hunt it, then ratify which is the real promise.
- P07's REST door currently 400s agent-mode terminal tabs by design deferral (freshell-freshagent/src/terminal_tabs.rs:15-20) — ratify whether P07 is a live promise for agent modes.
