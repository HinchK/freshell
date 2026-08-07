# Parallel bug-hunt run pbh-20260807 — Run report

**Goal:** a higher-quality freshell experience — find and fix bugs a real user would fall afoul of, in the RUST implementation (`crates/`). Node `server/` was out of scope (reference only).
**Base:** origin/main @ 90fc866db. **Branch:** `pbh/20260807/integration` (worktree; no PR, no deploy — ready for review).
**Coordination:** agmsg not installed → append-only JSONL equivalent.
**Skill exercised:** `~/code/skill-parallel-development` (parallel-bug-hunt), first live run.

## Outcome — 5 user-facing bugs fixed, closed-loop, all independently reviewed PASS (+1 adjudicated already-fixed)

### F1 — freshclaude approvals/answers silently dropped  [S2/S3 · LANDED 6c5f9ad86 · review PASS]
The freshAgent WS dispatch (`crates/freshell-ws/src/terminal.rs`) routed `approval.respond`,
`question.respond`, `fork`, and `compact` into a silent `_ => true` catch-all — no handler exists in
the Rust port. A user clicking **Approve/Deny** on a tool permission, answering a question, or hitting
fork/compact got **nothing**: the pane wedged, the agent hung waiting. Fix makes these fail LOUDLY with a
visible pane error (`UNSUPPORTED_MESSAGE`) that un-wedges the pane, matching the codebase's own
"never total silence for a user action" pattern. New real-transport test (4 frames) — RED verified by
stashing the fix (all 4 time out), GREEN after. Independent review confirmed the pre-fix drop, the
non-vacuous test, and judged "fail loudly" a legitimate satisfaction (the approval channel is genuinely
out of scope in this port; faking success would be worse).

### F2 — idle reaper silently kills detached background terminals  [S1 · LANDED 082206711 · review PASS]
`TerminalRegistry::enforce_idle_kills` treated "detached" as `subscribers.is_empty()`, so a mere socket
drop — **closing the browser tab, a network blip, or the laptop sleeping** — made a running background
terminal reap-eligible and SIGKILLed it after 15 idle minutes (scrollback + session lost), while the UI
slider (min=5) can't disable it. This directly violates the tmux-like "background sessions keep running"
promise. Fix distinguishes an explicit release (user closed it from every pane) from a mere disconnect:
disconnected-but-wanted terminals now live under the existing 24h hard cap; genuine orphans still reap at
the configured threshold (no PTY leak). Three tests (RED→GREEN). Independent review confirmed no leak, the
flag resets on re-attach (not a one-way latch), and every case is bounded at 24h.

### F4 — recover-my-panes inventory silently omits a whole device  [S3 · LANDED 75f641d47 · review PASS]
`GET /api/recovery/inventory` did two separately-locked store reads; a concurrent `tabs.sync.push` at the
retention cap prunes a just-selected snapshot generation between them, and the `Missing => continue` arm
dropped the WHOLE device — a clean 200 with `recoverable:false` for a workspace fully on disk. Correlated
with restart (every window re-pushes exactly when the fresh window fetches inventory). Fix: bounded per-device
re-read that re-selects from survivors; still-incoherent → loud 500, never a silent empty. Two RED→GREEN tests.
Review confirmed it discriminates true emptiness (still 200) from churn (loud 500), retry is bounded, normal path unchanged.

### F5 — amplifier sessions freeze in history (stale recency/preview, effectively invisible)  [S3/S4 · LANDED 73ad20d6c · review PASS]
The session index re-parses only when metadata.json's (mtime,size) changes, but amplifier recency + preview come
from transcript/events sidecars — so real turns/resumes (sidecar-only appends) never refreshed, freezing the
session at first-parse and sinking it to the bottom of the recency-sorted history where the user can't find it.
Fix folds the sidecars' mtimes (stat-only) into the discovered stat so a sidecar write invalidates the cache.
RED→GREEN through the real incremental sweep. Review confirmed stat-only (no perf regression), other providers byte-identical.

### F6 — terminal.exit overtakes queued output/replay, blank exited panes  [S3 · LANDED 108f1365b · review PASS]
`TerminalExit` bypassed the per-connection output FIFO (direct channel) while output/replay were queued, and the
drain loop sends direct frames before queued output — so attaching to an exited terminal delivered ready→exit→replay,
and the client clears the pane binding on exit, dropping the replay. Result: blank exited pane / scrollback lost on
reattach to an exited terminal. Fix routes exit through the same FIFO (zero-weight, non-evictable) so output→exit
order holds unconditionally. RED→GREEN. Review confirmed no exit-loss, eviction/gap accounting intact, attach.ready ordering preserved.

### F3 — provider resume after restart  [AUDIT_WRONG — already fixed]
Candidate: codex/opencode sessions unresumable after a server restart. Adjudication found this is **not a
bug** — all providers reconstruct from disk on the cold path, with regression tests already pinning the
exact historical failure. No change made. The confirm-before-fix gate earned its keep.

## What the map found (mapping wave)
Artifacts in `map/`: promise-ledger, fan-inventory, code-mass-heatmap, territories. Top territories were
reload/reconnect, restart-recovery, provider-resume, attention truth, freshAgent WS, remote access,
terminal I/O. Severity (ratified, user-facing): S1 data-loss > S2 blocked > S3 wrong-silent > S4 confusion
> S5 annoyance; modulators (silent/irreversible/trunk-artery) escalate one level.

## Verification & safety
- All fixes verified with `cargo test` on the changed crate (green); pre-existing environmental e2e
  failures were confirmed baseline-identical (not regressions).
- Builds were serialized (one at a time) to protect the box; peak load stayed manageable.
- The live self-hosted server on :3001 was never touched; no server was started or restarted.

## Post-mortem — what this run taught (feeds skill v2)

1. **The flat-rate worker pool hung on deep, open-ended analysis.** Both the mapping and hunt
   waves launched ~13 and ~8 Kimi-via-opencode workers on "map this whole crate" / "hunt this
   territory" tasks. After 20+ minutes most had produced **zero output** — opencode's internal
   "Explore Agent" sub-tasks stalled on large crates (freshell-ws is 54k LOC). The ONLY Kimi
   workers that finished were the mechanical ones (grep/wc code-mass/churn). This **undercuts the
   skill's core economic premise** that cheap flat-rate workers do the bulk of the deep hunting.
2. **What worked was a labor split.** Reasoning/coding-tier delegates (one orchestrator-tier
   model) reliably did the map synthesis, the confirm-and-fix, and the independent reviews. The
   reliable division: **many flat-rate workers for bounded/mechanical census; a few
   reasoning-tier agents for deep analysis, fixing, and review** (a small number, so still
   affordable).
3. **Route around hung workers; don't depend on them.** Monitoring log freshness caught the
   hangs; per the no-kill rule the hung sessions were left running (they cost ~0 CPU) and their
   territory was covered by direct reads. A worker silent for many minutes with no artifact is
   hung — plan for it.
4. **High-churn map candidates are often already fixed.** F3 (provider resume) was a real
   historical bug already fixed with regression tests; attention (#614) and remote (#615) landed
   days ago. The map correctly points at where pain *was*; confirm-before-fix (AUDIT_WRONG) is
   what stops wasted or wrong changes.
5. **Serial builds kept the box safe** — no repeat of the 32-concurrent-build load spikes.

### Skill v2 changes queued
- Add **task-shaping / worker-reliability**: give flat-rate workers TIGHT, bounded, single-file
  or mechanical tasks; forbid sub-agent spawning; require incremental output ("write as you go").
- Make explicit the **tier split**: flat-rate pool for census + narrow confirmation; a small
  reasoning-tier set for deep hunt/fix/review.
- Elevate **confirm-before-fix (AUDIT_WRONG)** and **route-around-hung-workers** to first-class.
