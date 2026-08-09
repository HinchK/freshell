# HARNESS-12 evidence — leak and resource measurements

**Checklist text:** "Add leak and resource measurements. Capture server/Tauri/provider child PIDs, handles, RSS, queue sizes, and listening ports before and after stress scenarios."
**Playwright validation:** "A repeated create/send/close/restart loop returns to a bounded resource baseline, leaves no owned process or port behind, and fails with a retained process-tree artifact if the bound is exceeded."
**Verdict: COMPLETE (Linux-host scope; Tauri collectors host-limited — see carve-out below).**

## What landed (branch `df1/harness-12-leak-metrics`)

- `test/e2e-browser/helpers/leak-metrics.ts` — the measurement harness.
  `captureResourceSnapshot(rootPids)` walks `/proc` (no `ps` subprocess): ppid-BFS
  descendant discovery (PTY/provider children keep PPID→server even after
  `setsid()`, so they are found), per-process **RSS** (`status` VmRSS),
  **handles** (`fd/` open-fd count), **threads**, **listening ports**
  (fd↔`socket:[inode]`↔`net/tcp{,6}` LISTEN-row attribution), and **queue sizes**
  (per-socket tx/rx queue bytes summed per process and per tree);
  `captureHostListeningPorts()` for "port left behind" teardown assertions;
  `diffSnapshots(before, after, bounds)` with bounded-growth rules (defaults:
  RSS +256 MiB, fds +16, processes +0, post-settle socket queue ≤ 1 MiB, no new
  listen ports — leak gates, not perf gates; absolute values ride the artifact).
  The collector is synchronous, vanish-tolerant (pids may exit mid-scan), and
  ownership-safe (reads only trees reachable from caller-supplied root pids;
  unowned sockets are never attributed).
- `test/e2e-browser/helpers/leak-metrics.test.ts` — **17/17 vitest green ×2**;
  fixture-fabricated `/proc` trees (the dispatch's required mocked-/proc unit
  coverage: stat parsing incl. parenthesized comm, RSS/threads, fd counting,
  tcp+tcp6 inode attribution/dedupe, queue bytes, ghost-pid tolerance, diff
  bounds) **plus real-wiring proofs on own processes only** (self snapshot with
  RSS>0, in-process TCP listener appears then vanishes host-wide on close,
  spawned own child discovered then gone after exact-PID kill).
- `test/e2e-browser/specs/leak-metrics.spec.ts` — the Playwright proof, routed
  through the HARNESS-02 `e2eServerKind` seam so the SAME spec gates BOTH
  `legacy-chromium` and `rust-chromium`. Serial; per iteration: REST
  `POST /api/tabs {mode:'shell'}` → mid-stress snapshot asserts the PTY child
  is a live ppid descendant with RSS>0 and the port set is exactly `[port]` →
  REST send-keys echo marker → `wait-for?pattern=` → raw-WS
  `hello`+client-shaped `terminal.attach`+`terminal.kill` (attach is required on
  legacy — its registry only `safeSend`s `terminal.exit` to attached clients,
  terminal-registry.ts:1542) awaiting the `terminal.exit` edge →
  `DELETE /api/tabs/:id`. Then: settle to the baseline live-population +
  zombie-free, full diff asserted failure-free, `restart()` re-boots to exactly
  one live process + one listener with no inherited children, and `stop()`
  leaves no owned process alive and the port freed **host-wide**
  (`captureHostListeningPorts`). Both snapshots attach to every run; on ANY
  failure a retained process-tree artifact is also written to
  `testInfo.outputPath('leak-metrics-process-tree.json')` (checklist text).
  Skips when `FRESHELL_E2E_TARGET_URL` is set (external target = not ours,
  pid −1).
- `test/e2e-browser/playwright.config.ts` — one additive MATRIX_SPECS line
  (`/leak-metrics\.spec\.ts$/`) per the control-plane anti-conflict convention.
- Plan + load-bearing audit ledger (6/6 validated): `docs/plans/df1/HARNESS-12.md`.

## Green runs (all at branch HEAD)

- `npm run test:vitest -- run test/e2e-browser/helpers/leak-metrics.test.ts --config test/e2e-browser/vitest.config.ts`
  → **17/17 passed ×2** (16.96 s, 16.14 s).
- `npx playwright test --config test/e2e-browser/playwright.config.ts --project=legacy-chromium -g "HARNESS-12" --reporter=line`
  → **3/3 passed ×2 consecutive** (22.1 s, 23.2 s).
- `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium -g "HARNESS-12" --reporter=line`
  → **3/3 passed ×2 consecutive** (37.9 s, 20.2 s).
- `npm run typecheck` clean; eslint on the new files: 0 errors (specs dir gets
  the same pre-existing "no matching configuration" warning as existing specs).

## Notable finding during TDD (fixed in-system, not by toleration)

The legacy server spawns a short-lived `git` probe per tab create that reaps
through a **zombie window**; an unlucky baseline snapshot could count it and
poison growth/settle math (one observed flake, root-caused by live capture:
`git:Z ppid=server`). Fix, pinned in the spec: settle zombie-free BEFORE taking
the baseline, compare **live (non-`Z`) process counts** for growth/settle, and
require zombie-free at final settle (so a never-reaped zombie still fails). Z
state is parsed and reported, never hidden.

## Tauri carve-out (per dispatch scope note)

The collector API is host-generic by construction — callers pass arbitrary
root-PID sets, so a desktop lane would pass the shipped Tauri app's
process-tree roots (app + WebView children + owned server child) and reuse the
entire snapshot/diff/artifact layer. The implemented backend is Linux `/proc`
only; Tauri-specific collection on this Linux box is **host-limited** (native
Windows Tauri/WebView2 lanes are HARNESS-07/08/09 scope, parked for the
Windows-desktop campaign per the kickoff decisions). A Windows backend
(Handle-count/PDH + Get-NetTCPConnection) would slot behind the same
`ResourceSnapshot` schema. No fake Tauri code was written.

## Review loop (round 1 of ≤5 — converged)

Independent fresh-eyes review (gpt-family reviewer, repo-zero-context, defect-first
rubric per the review-agent skill; FRESHPID=3030442, run against
`git diff $(git merge-base HEAD origin/df1/integration)..HEAD`): **PASSED — "No
findings."** The reviewer independently confirmed the last-`)` stat parse, the
`/proc/net/tcp{,6}` column handling, the fd↔inode ownership attribution, the
external-target skip safety, and the legacy/rust attach-before-kill flow against
the real call sites (`server/terminal-registry.ts:1542`,
`crates/freshell-ws/src/terminal.rs`, `terminal_tabs.rs`, `pane_ops.rs`). (Note:
an MCP-pane subagent dispatch was attempted first and abandoned — the MCP caller
context couldn't resolve the pane it had just created; the fresheyes detached
reviewer replaced it per the dispatch's recorded-fallback allowance.)

## Consumer guidance (stress project, TERM-22/PW-RUST follow-ons)

```ts
const before = captureResourceSnapshot([server.info.pid])
// …stress…
const after = captureResourceSnapshot([server.info.pid])
const diff = diffSnapshots(before, after, { maxRssGrowthBytes: …, allowedNewListeningPorts: [] })
// diff.failures [] or the run keeps a process-tree artifact
```

The measurement code runs inside the shared-host test env; only self-spawned
process trees are read (df1 politeness rule), no forks bombs/no >60 s soaks;
loop = 6 short-lived shells.
