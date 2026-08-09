# HARNESS-12 — Leak and Resource Measurements Implementation Plan

> df1 worker item HARNESS-12 (pre-claimed, assignee df1-harness-12-leak-metrics).
> Checklist row (docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md:64):
> "Add leak and resource measurements. Capture server/Tauri/provider child PIDs,
> handles, RSS, queue sizes, and listening ports before and after stress scenarios."
> Playwright validation: "A repeated create/send/close/restart loop returns to a
> bounded resource baseline, leaves no owned process or port behind, and fails with
> a retained process-tree artifact if the bound is exceeded."

**Goal:** A reusable, unit-tested, `/proc`-backed measurement helper for the
e2e-browser harness that snapshots an owned server's process tree (descendant PIDs,
per-process RSS / open-fd handle counts / threads / TCP socket queue bytes /
listening ports), diffs before/after snapshots against bounded-growth rules, and is
proven by a MATRIX_SPECS-registered Playwright spec that runs a bounded
create→send→close×N + restart + stop loop on both the legacy Node server and the
Rust server.

**Architecture:**
- New item-scoped collector `test/e2e-browser/helpers/leak-metrics.ts`. Pure
  synchronous Node against a `procRoot` (default `/proc`, injectable so unit tests
  run fully fixture-driven off a fabricated proc tree — the prompt demands the
  collector logic be unit-tested in vitest with mocked /proc, leaving only wiring
  to the e2e proof). No `ps` subprocess: descendant discovery parses
  `<pid>/stat` ppid chains, so fixture tests need no process spawning.
- New item-scoped spec `test/e2e-browser/specs/leak-metrics.spec.ts` routed through
  the existing HARNESS-02 `e2eServerKind` seam (`helpers/fixtures.ts` worker-scoped
  `testServer`), so the SAME spec runs on legacy-chromium and rust-chromium. It
  drives the real REST (`/api/tabs`, `/api/panes/:id/send-keys`, `/api/panes/:id/
  wait-for`, `DELETE /api/tabs/:id`) and a raw WS `hello`+`terminal.kill` (the
  canonical server-side PTY reap path — verified: `DELETE /api/tabs/:id`
  deliberately does NOT kill terminals on either server; `tcp`/`pane_ops.rs` doc
  comment says the terminal "keeps running ... exactly like the legacy closeTab").
- One additive line in MATRIX_SPECS in the shared
  `test/e2e-browser/playwright.config.ts` (per control-plane README anti-conflict
  convention). No other shared-file edits.

**Tauri scope (per dispatch scope note):** the collector is host-generic by
construction — it takes arbitrary root PID sets, and a Tauri lane would pass the
shipped app's process-tree roots (app + WebView children + owned server child). The
implemented backend is Linux `/proc` only; a Windows handle/port collector is
host-limited to the Windows desktop campaign (HARNESS-07/09 lanes) and is annotated
as such in the evidence file. No fake Tauri code is written.

**Tech stack:** TypeScript (NodeNext/ESM, `.js` relative imports), vitest (helper
unit tests, `test/e2e-browser/vitest.config.ts` already includes
`helpers/**/*.test.ts`), Playwright (matrix legs).

## Global Constraints

- Bounded, polite stress: loop = 6 iterations, no soaks > 60 s, read /proc of
  ONLY self-spawned processes; all kills are exact-PID edits via the OWNED server
  fixtures (never touch ports 3001/3002/17871/17872/17874).
- Shared-host safety: skip entirely when `FRESHELL_E2E_TARGET_URL` is set (external
  target has `pid: -1` and is not ours to measure or stop).
- Server harvests must never make the default `testServer` fixture non-idempotent:
  the spec's explicit `stop()` test must tolerate the fixture's own teardown
  `stop()` (both owned fixtures already no-op a second stop).
- `expect.poll` for all async settles (never bare sleeps) except Playwright's own
  built-in auto-retry.
- Legacy-chromium is a genuine parity-control leg (identical REST/WS surface), not
  a KNOWN DIVERGENCE.

## File Structure

- Create: `test/e2e-browser/helpers/leak-metrics.ts` — collector + diff/bounds.
- Test:   `test/e2e-browser/helpers/leak-metrics.test.ts` — fixture-based vitest.
- Create: `test/e2e-browser/specs/leak-metrics.spec.ts` — the Playwright proof.
- Modify: `test/e2e-browser/playwright.config.ts` — MATRIX_SPECS append (1 line +
  comment), at the end of the MATRIX_SPECS array before `]`.
- Create: `docs/plans/df1-evidence/HARNESS-12.md` — evidence/annotation.

### Task 1: collector core (snapshot capture, fixture-driven)

**Files:**
- Create: `test/e2e-browser/helpers/leak-metrics.ts`
- Test: `test/e2e-browser/helpers/leak-metrics.test.ts`

**Interfaces:**
- Produces (frozen — Tasks 2–4 and the spec rely on these exact names):

```ts
export interface CaptureOptions { procRoot?: string }
export interface SocketQueueBytes { rxBytes: number; txBytes: number }
export interface ProcessSnapshot {
  pid: number; ppid: number; comm: string; state: string
  rssBytes: number | null; threads: number | null; fdCount: number | null
  listeningPorts: number[]; socketQueue: SocketQueueBytes
}
export interface ResourceSnapshot {
  capturedAt: string; rootPids: number[]
  processCount: number; totalRssBytes: number; totalFdCount: number; totalThreads: number
  totalSocketQueue: SocketQueueBytes; listeningPorts: number[]; processes: ProcessSnapshot[]
}
export function captureResourceSnapshot(rootPids: number[], opts?: CaptureOptions): ResourceSnapshot
export function captureHostListeningPorts(opts?: CaptureOptions): number[]
```

- [ ] **Step 1: failing tests** — write fixture tests for:
  - descendant discovery via `stat` ppid chains (1000=root server, 1001 child of
    1000, 1002 grandchild of 1001; 2000 unrelated ppid 9 excluded),
  - `comm` containing spaces AND parentheses (e.g. `(bash (login))`) parsed via
    LAST `)`,
  - RSS/Threads from `status` (`VmRSS: 51200 kB` → 52428800 bytes; `Threads: 8`),
  - `fdCount` from `fd/` readdir length; real `socket:[inode]` symlinks in tmp fd
    dirs map to fabricated `net/tcp` rows (state `0A` LISTEN → port from hex
    local_address; `01` ESTABLISHED rows contribute rx/tx queue bytes only),
  - a pid dir whose `stat` is missing/unreadable is excluded (mid-scan vanish
    tolerance), and `fd/` `EACCES`/ENOENT → `fdCount: null` (not a crash),
  - snapshot `processes` sorted by pid; totals are sums; `listeningPorts` is the
    sorted deduped union.
- [ ] **Step 2: run to RED** —
  `npm run test:vitest -- run test/e2e-browser/helpers/leak-metrics.test.ts --config test/e2e-browser/vitest.config.ts`
  Expected: FAIL (module does not exist / stubs).
- [ ] **Step 3: implement** the collector (stat parser via `lastIndexOf(')')`;
  BFS over the ppid map seeded with the root pids present in the map; per-pid
  status/fd reads with per-pid try/catch vanish tolerance; `net/tcp`+`net/tcp6`
  merge keyed by inode — `parseNetTcp` skips the header line, `parts[1]`
  local_address hex port after the final `:`, `parts[3]` state, `parts[4]`
  `tx:rx` hex queues, `parts[9]` inode; LISTEN = state `0A`).
- [ ] **Step 4: run to GREEN** (same command).
- [ ] **Step 5: commit** `feat(e2e): HARNESS-12 leak-metrics collector core`.

### Task 2: diff + bounds + host-wide port helper

**Files:**
- Modify: `test/e2e-browser/helpers/leak-metrics.ts`
- Test: `test/e2e-browser/helpers/leak-metrics.test.ts`

**Interfaces:**
- Produces:

```ts
export interface SnapshotBounds {
  maxRssGrowthBytes?: number        // default 256 MiB
  maxFdGrowth?: number              // default 16
  maxProcessGrowth?: number         // default 0
  maxTotalSocketQueueBytes?: number // default 1 MiB (post-settle queue bound)
  allowedNewListeningPorts?: number[] // default []
}
export interface SnapshotDiff {
  failures: string[]
  newListeningPorts: number[]; lostListeningPorts: number[]
  rssGrowthBytes: number; fdGrowth: number; processGrowth: number
  processGrowthPids: number[]
}
export function diffSnapshots(before: ResourceSnapshot, after: ResourceSnapshot, bounds?: SnapshotBounds): SnapshotDiff
```

- [ ] **Step 1: failing tests** —
  - port growth flagged unless in `allowedNewListeningPorts`; port loss recorded
    in `lostListeningPorts` but is NOT itself a failure (restart loss is asserted
    separately with `captureHostListeningPorts`);
  - RSS growth ≤ bound passes, > bound fails; negative growth passes;
  - `processGrowth > 0` fails at default bound with offending pids listed;
  - post-settle queue bound: after totalSocketQueue rx+tx > 1 MiB fails;
  - fd growth > 16 fails.
- [ ] **Step 2:** RED. **Step 3:** implement. **Step 4:** GREEN.
- [ ] **Step 5: commit** `feat(e2e): HARNESS-12 snapshot diff/bounds`.

### Task 3: real-wiring unit tests (no mocks, own processes only)

**Files:**
- Test: `test/e2e-browser/helpers/leak-metrics.test.ts`

- [ ] **Step 1: failing tests** (these are wiring proofs against the REAL `/proc`):
  - `captureResourceSnapshot([process.pid])` contains this vitest process with
    `rssBytes > 0`, `threads >= 1`, `fdCount > 0`;
  - a real in-process `net.createServer().listen(0, '127.0.0.1')` appears in the
    snapshot's `listeningPorts` while listening and disappears from
    `captureHostListeningPorts()` output after `close()` (proves the port is not
    left behind);
  - a spawned own child (`spawn(sleepPath, ['30'])`) appears as a descendant and
    vanishes after exact-PID `SIGKILL` + settle poll.
- [ ] **Step 2:** RED only for genuinely-missing pieces (expected: pass once
  Task 1/2 land — record outcome; if any fail, fix the collector). **Step 3–4**
  as needed. **Step 5: commit** `test(e2e): HARNESS-12 real-/proc wiring proofs`.

### Task 4: the Playwright proof (MATRIX-registered)

**Files:**
- Create: `test/e2e-browser/specs/leak-metrics.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (MATRIX_SPECS append, additive)

Serper's `describe.configure({ mode: 'serial' })`; module-scope
`test.skip(externalTargetConfigured(), …)` inside each test (the default
worker-scoped `testServer` fixture from `helpers/fixtures.ts` routes legacy/rust
via the project `e2eServerKind`; no fresh page is needed — this spec is REST+WS
only, which counts as Playwright validation per the checklist's own shorthand).

Sequence (single test, serial, to keep a deterministic baseline; plus a stop
test):

1. `before = captureResourceSnapshot([testServer.info.pid])`; assert
   `before.listeningPorts` deep-equals `[serverInfo.port]` (exactly one listener).
2. Loop 6×: POST `/api/tabs` `{mode:'shell', cwd: os.tmpdir()}` →
   `{tabId,paneId,terminalId}`; mid-loop `captureResourceSnapshot` asserts the
   snapshot now SHOWS a new descendant (processCount > before's — the "captures
   provider/PTY child PIDs" half of the deliverable, asserted live); POST
   `/api/panes/:id/send-keys` `echo H12-<i>` + ENTER literal; GET
   `/api/panes/:id/wait-for?pattern=H12-<i>` until matched; raw-WS
   `hello`(`{type:'hello', protocolVersion:7, token}`, wait `ready`) → send
   `{type:'terminal.kill', terminalId}` → close WS; DELETE `/api/tabs/:id`.
3. Settle: `expect.poll(() => captureResourceSnapshot([pid]).processCount, …)`
   → `before.processCount` (15 s, 250 ms).
4. `after = captureResourceSnapshot([pid])`; `diff = diffSnapshots(before, after)`;
   **always** `testInfo.attach('leak-metrics-snapshots', {body: JSON.stringify({before, after, diff})})`
   and, on failure, ALSO write the retained process-tree artifact to
   `testInfo.outputPath('leak-metrics-process-tree.json')` containing snapshots +
   diff (the checklist's "retained process-tree artifact"); assert
   `diff.failures` is empty.
5. Test 2 (`restart`): `testServer.restart()`; poll health; assert fresh
   snapshot of the NEW pid has `listeningPorts === [port]` and `processCount === 1`
   (no inherited PTYs across the restart).
6. Test 3 (`stop leaves nothing`): record pid+port, `await testServer.stop()`,
   `expect.poll` pid-not-alive (kill(pid,0) → ESRCH) and
   `captureHostListeningPorts()` excludes the port; attach the final artifact.
   Both owned fixtures tolerate the teardown's second `stop()`.

Registration: append to MATRIX_SPECS:

```ts
  // HARNESS-12 — leak/resource measurement gate: bounded create/send/close loop
  // + restart + stop returns to a bounded baseline (no port/fd/process/RSS/queue
  // growth) on BOTH server kinds. See leak-metrics.spec.ts and
  // docs/plans/df1-evidence/HARNESS-12.md.
  /leak-metrics\.spec\.ts$/,
```

- [ ] **Step 1:** author spec (it is self-failing on the NOT-yet-registered leg —
  run pre-registration leg to prove the spec executes); **Step 2:** register;
  **Step 3:** run each leg ≥2 consecutive greens (pw lease; Rust binary via
  cargo-lease build or the fixture's own `ensureRustServerBuilt`).
- [ ] **Step 4: commit** `test(e2e): HARNESS-12 create/send/close/restart leak gate`.

### Task 5: evidence + wrap-up

- [ ] Write `docs/plans/df1-evidence/HARNESS-12.md`: what landed, checklist-text
  mirror, unit + e2e green commands w/ outputs, the Tauri host-limited carve-out
  annotation, bounds rationale (leak gate, not perf gate; absolute values retained
  in the attached artifact for the stress project's future tighter limits).
- [ ] `npm run typecheck` clean; helper vitest file green ×2; matrix legs green ×2.
- [ ] Final commit; df1ctl update state=review.

## Load-bearing assumptions (audit targets for Phase 2)

1. Legacy Node-pty children and Rust portable-pty children are both /proc
   descendants of the respective server process (ppid walk sees them). — VERIFY
   at Task 4 with the mid-loop assertion; falisafe: switch descendant discovery
   to the PGID/setsid caveats documented in rust-server.ts.
2. `POST /api/tabs {mode:'shell'}` on BOTH servers returns `{terminalId}` (legacy
   `router.ts:791/816`; rust `terminal_tabs.rs` ~2230/2045 both embed terminalId).
3. WS `{type:'terminal.kill', terminalId}` reaps the PTY on both servers
   (legacy `ws-handler.ts:3073`; rust `crates/freshell-ws/src/terminal.rs:4482`).
4. Neither server spawns persistent background helper processes at steady state
   (provider discovery uses scans / short-lived probes), so post-settle
   `processCount === 1` is a valid strict assertion; if a persistent helper is
   discovered, baseline is captured AFTER boot settle and growth is asserted
   relative to it instead (the diff API already supports that).
5. Both owned fixtures' `stop()` is safely callable twice.
6. `wait-for?pattern=` works on REST-created terminal panes on both kinds
   (legacy `router.ts:959` `resolvePaneToTerminal` path; rust mirrors it).
