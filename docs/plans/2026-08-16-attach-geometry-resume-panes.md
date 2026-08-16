# Attach Geometry Authority for Hidden Panes Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Fix the freshell root cause behind broken mouse scrolling and garbage rendering in opencode CLI panes: the PTY geometry of a terminal pane must track the pane that is actually being viewed, not any hidden/background client. Today any client whose pane is hidden can attach with `viewport_hydrate` and the server applies that geometry unconditionally, stomping the visible pane's PTY size; nothing converges back until the visible pane happens to emit a new resize. The visible symptoms are opencode TUI full-width frames wrapping into diagonal garbage on scroll-triggered repaints (PTY wider than the view) and dead/stale regions (PTY narrower).

### Explicit constraints
- Root cause mechanism is established and the fix must target it: client-side background/hidden hydration attaches (`src/components/TerminalView.tsx` background-hydration effect) send `viewport_hydrate` with stale-fitted dimensions; the server's `resize_for_attach` applies `viewport_hydrate` geometry unconditionally (`crates/freshell-terminal/src/registry.rs`); multi-client stomp confirmed by a live ws-level probe (`Some((120,30,1))` → client A hydrate `100x29` → `Some((100,29,1))` → client B hidden-shape hydrate `124x31` → `Some((124,31,2))` while A attached).
- Preserve Node/Rust server parity: no server behavior change in the primary fix.
- Panes that are not visible must never claim viewport geometry; enforce at one central client choke point (TerminalView's `attachTerminal`), not by patching individual call sites.
- Reveal-time convergence must survive: when a hidden pane becomes visible, its reveal attach (`viewport_hydrate` with real fitted dims) plus the existing reveal layout effect (`fit+resize`) must keep healing geometry. No regression to reveal-attach planning (`src/lib/terminal-attach-policy.ts` behavior).
- Red-green-refactor TDD; unit + e2e coverage; repo rules in AGENTS.md apply: worktree-branch only, focused commits, no merge/push/PR creation.

### Accepted tradeoffs and residuals
- The server keeps the permissive `viewport_hydrate` contract (Node parity is preserved). A future server-side "hydrate applies geometry only when no other socket is attached" hardening is an optional follow-up and is out of scope.
- Pre-existing base failures are recorded in the baseline ledger and are not blocking: `network::tests::concurrent_configure_and_disable_serialize_to_a_consistent_end_state` (environment-dependent 500 vs 200, reproduces at base in isolation) and `test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts` full-suite load flakes (100ms ws timeouts; the file passes in isolation, 261/261).
- The explorer-reported separate gap — fresh-agent panes never register canonical identity in the WS identity registry (their identity sink writes only the PaneLedger) — is out of scope for this fix.
- The user's "scrolls a few lines then stops / doesn't scroll" variant is consistent with the same geometry mismatch (scrollbox shrinks to a few rows when PTY rows are smaller than the viewport); the shared-cause fix resolves it.

**Goal:** A terminal pane's PTY size is always governed by the visible client; hidden/background-hydration attaches replay scrollback without ever resizing the PTY.

**Architecture (v3, after plan-review round 1):** One invariant in the client attach path: a pane that is not visible must never claim viewport geometry on the wire. Enforced at the single choke point `attachTerminal` (`src/components/TerminalView.tsx` ~2698) with a **wire-token-only swap**: when `intent === 'viewport_hydrate'` while `hiddenRef.current` is true, the sent frame carries `intent: 'keepalive_delta'` while ALL client-side bookkeeping retains viewport-hydrate semantics (sinceSeq 0, `resetParserAppliedSurface`, viewport clear, `currentAttachRef.intent`/`deferredAttachStateRef.pendingIntent` unchanged) — so the replay path, the replay-gap recreate predicate, the rejection ladders, and reveal planning are all byte-for-byte unaffected, and the server simply never resizes (`registry.rs`: `KeepaliveDelta => false`; attach replay keys off `since_seq` only — validator A/C/B confirmed). Alongside the swap, the hidden-clamped attach **invalidates the this-client suppression records** (`lastSentViewportRef.current = null; forgetSentViewport(tid)` — the helper already exists at src/components/TerminalView.tsx:507) so the next visible-pane fit+resize is never suppressed by dims the server never applied (validator D falsified "no-op is enough"; this restores reveal-time convergence without touching suppression semantics for any existing flow). No new flags, no predicate broadening, no force-resize path, and no changes to natural `keepalive_delta`/`transport_reconnect` attaches.

**Tech Stack:** React 18 / TypeScript client (xterm.js), Vitest + Testing Library (`test/unit/client/components/`), Playwright e2e (`test/e2e-browser/`), Rust ws/terminal crates only for the evidence probe (no Rust change).

## Global Constraints

- Server uses NodeNext/ESM; relative imports must include `.js` extensions. (No server change expected; applies to any touched TS.)
- Never reduce test coverage, mark tests as skip, or simplify tests to pass.
- Test runs must use repo-owned paths: `npm run test:vitest -- run <files>` for focused vitest; `cargo test -p <crate>` for Rust; `npm test` full coordinated suite only at the gate; Playwright e2e via `npm run test:e2e:local -- <spec>` (local backend; cloud requires user opt-in).
- Vitest has a shared coordinator gate; broad runs wait for it (`npm run test:status`).
- Work strictly inside the worktree `/home/dan/code/freshell/.worktrees/attach-geometry-resume-panes` on branch `the-usual/attach-geometry-resume-panes`; commit focused changes with conventional messages; do not push, merge, or open PRs.
- Follow existing code style in touched files; add no dependencies.
- The probe file `crates/freshell-ws/tests/zz_probe_attach_resume_geometry.rs` is pre-plan evidence, not part of the implementation; Task 1 deletes it (its assertions are superseded by the plan's own tests).
- Broad verification gate (round-3 finding 6): after all implementation tasks, the orchestrator's end-of-execution gate runs `npm run check` (typecheck + coordinated full suite) AND `cargo test --workspace --exclude freshell-tauri`. A failure counts as a ledger-recorded pre-existing failure only with a base_ref reproduction receipt (baseline ledger already carries the two known base failures' identifiers/receipts); otherwise it blocks execution completion.

---

### Task 1: Hide-gated attach intent (wire-token clamp + suppression-record invalidation)

**Files:**
- Delete: `crates/freshell-ws/tests/zz_probe_attach_resume_geometry.rs` (pre-plan probe; evidence retained in run logs `reports/`; it asserts only the current-server contract, which stays unchanged)
- Modify: `src/components/TerminalView.tsx` (`attachTerminal` ~line 2698; the only production change)
- Test: `test/unit/client/components/TerminalView.lifecycle.test.tsx` (extend the hidden-pane attach-intent block; reuse `renderTerminalHarness`, `wsMocks`, `messageHandler`, `restoreMocks`, `getHydrationQueue().onActiveTabReady`, `reconnectHandler`, `TerminalView`/`TerminalViewFromStore` exactly as neighboring tests do)

**Interfaces:**
- Consumes: `attachTerminal(tid: string, intent: 'viewport_hydrate' | 'keepalive_delta' | 'transport_reconnect', opts?: AttachTerminalOptions): void`, `hiddenRef.current: boolean`, existing module-level helper `forgetSentViewport(tid)` (src/components/TerminalView.tsx:507), `lastSentViewportRef` (per-instance ref).
- Produces: no new exported names; only wire-frame `intent` differs for hidden clamps.

- [x] **Step 1: Write the failing behavioral tests**

Add three tests to the hidden-pane attach-intent block of `test/unit/client/components/TerminalView.lifecycle.test.tsx`.

T1 — wire pin (RED witness):

```ts
it('a pane hidden at mount hydrates in background with a geometry-neutral keepalive attach', async () => {
  const { terminalId, tabId } = await renderTerminalHarness({
    status: 'running',
    terminalId: 'term-hidden-mount-geo-neutral',
    hidden: true,
    clearSends: false,
    requestId: 'req-hidden-mount-geo-neutral',
  })

  wsMocks.send.mockClear()
  act(() => {
    getHydrationQueue().onActiveTabReady('tab-visible-neighbor', ['tab-visible-neighbor', tabId])
  })

  await waitFor(() => {
    const attach = wsMocks.send.mock.calls
      .map(([msg]) => msg)
      .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
    expect(attach, 'background hydration must send an attach').toBeTruthy()
    expect(attach.intent).toBe('keepalive_delta')
    expect(attach.priority).toBe('background')
    expect(attach.sinceSeq).toBe(0)
    expect(attach.cols).toBeGreaterThan(0)
    expect(attach.rows).toBeGreaterThan(0)
  })
  expect(
    wsMocks.send.mock.calls
      .map(([msg]) => msg)
      .some((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId && msg?.intent === 'viewport_hydrate'),
  ).toBe(false)
})
```

T2 — heal path (validator-D sequence; pre-fix the resize is suppressed, post-fix it is emitted). Mount-hidden-directly shape (proven by the file's existing hidden-mount tests — no visible→hidden flip, which produces no hidden attach):

```ts
it('reveal after a clamped hidden attach emits terminal.resize even when fitted dims are unchanged', async () => {
  // Mounting hidden + hydration trigger produces, PRE-FIX, a wire
  // viewport_hydrate attach whose dims are the never-fitted xterm defaults —
  // the same numeric dims the reveal-fit will compute in jsdom (stable
  // fixture) — so the reveal resize is swallowed by matchesLastSentViewport
  // pre-fix. Post-fix the clamped attach invalidates the suppression record
  // and the resize is emitted. This is the RED witness for the heal path.
  const { store, tabId, paneId, terminalId, rerender } = await renderTerminalHarness({
    status: 'running',
    terminalId: 'term-hidden-heal-suppression',
    hidden: true,
    clearSends: false,
    requestId: 'req-hidden-heal-suppression',
  })

  wsMocks.send.mockClear()
  act(() => {
    getHydrationQueue().onActiveTabReady('tab-visible-neighbor', ['tab-visible-neighbor', tabId])
  })
  await waitFor(() => {
    expect(
      wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .some((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId && msg?.intent === 'keepalive_delta'),
    ).toBe(true)
  })

  wsMocks.send.mockClear()
  rerender(
    <Provider store={store}>
      <TerminalViewFromStore tabId={tabId} paneId={paneId} hidden={false} />
    </Provider>,
  )

  await waitFor(() => {
    expect(
      wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .some((msg) => msg?.type === 'terminal.resize' && msg?.terminalId === terminalId),
    ).toBe(true)
  })
  // No NEW attach on reveal (deferred mode is 'live'); the resize is the heal.
  expect(
    wsMocks.send.mock.calls
      .map(([msg]) => msg)
      .filter((msg) => msg?.type === 'terminal.attach'),
  ).toHaveLength(0)
})
```

T3 — surface reset at clamped full replay (protects round-1 finding-2 against a bookkeeping-degraded implementation; runs green-by-construction on the correct one): mount hidden via T1's shape and drive ONE full attach generation so the mocked surface is non-empty (`term.write` receives `PRIOR-SURFACE-MARKER` once); assert the mocked `term.clear` was called for that attach (clearViewportFirst viewport bookkeeping). Then force a SECOND hidden clamped attach (`onActiveTabReady` again) with its own `attachRequestId` on every frame: attach.ready `{ headSeq: 6, replayFromSeq: 3, replayToSeq: 6 }` and output `{ seqStart: 3, seqEnd: 6, data: 'CLAMPED-REPLAY-MARKER' }`. Assert: (a) the second attach ALSO invoked `term.clear` — proves client bookkeeping kept viewport-hydrate surface-reset semantics under the wire-keepalive token (this FAILS if someone downgrades internal bookkeeping to keepalive semantics, which skips the clear branch); (b) `PRIOR-SURFACE-MARKER` appears exactly once and `CLAMPED-REPLAY-MARKER` exactly once across all `term.write` mock calls.

Also update the pre-existing hidden replay-gap test "recreates a hidden restored OpenCode pane when background viewport hydration cannot replay startup output" (~line 8685): change ONLY its attach wait predicate from `intent === 'viewport_hydrate'` to `intent === 'keepalive_delta'` (the production recreate predicate is NOT changed — `currentAttachRef.intent` retains viewport bookkeeping; that is part of the production contract this redesign pins). Any other pre-existing assertion of a hidden wire `viewport_hydrate` gets the same single-word update under the old-contract rule; record every touched test in the task report. Visible-pane assertions (e.g. "recreates a restored OpenCode pane when visible viewport hydration cannot replay startup output" and the reconnect-before-reveal test at ~4635) must stay untouched and green.

- [x] **Step 2: Run the tests and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/TerminalView.lifecycle.test.tsx`

Expected: FAIL for T1 (wire intent is `viewport_hydrate` pre-fix), FAIL for T2 (reveal resize suppressed pre-fix because the hidden viewport_hydrate attach recorded identical dims), and FAIL for T4 (hide-then-reconnect race: stale hiddenRef leaks a `viewport_hydrate`). T3 and the reconnect-before-reveal test (~4635) must pass pre-fix — if they fail, the harness setup is wrong; fix the setup, not the assertions. The replay-gap test fails pre-fix only after its predicate update; all failure modes must be assertion-level, not setup errors.

- [x] **Step 3: Add the minimal production implementation**

Changes live in two places in `src/components/TerminalView.tsx`.

3a. **Close the visibility-race window** (round-2 finding 3, round-3 finding 1). `hiddenRef` is currently synced only in a passive effect (~1191-1199). Move the assignment to a **commit-phase layout effect** (`useLayoutEffect`): a layout effect runs synchronously with the commit, before any passive effect and before any separately-scheduled external callback can observe stale visibility — unlike render-phase writes, it cannot leak visibility from an uncommitted/superseded render (round-3's catching of the earlier render-sync proposal). Net change: convert the existing sync to `useLayoutEffect(() => { hiddenRef.current = hidden; ...existing extra side effects unchanged... }, [hidden, paneId])` (imports already include the hooks; keep the effect's cleanup extras as-is). No new T4 race test: act-wrapped rerender flushes passive effects in the harness, so no unit test can witness the window (round-3 finding 2); the change is a defensive commit-phase sync validated by the whole lifecycle suite staying green, and the residual theoretical window is recorded as an accepted residual.

3b. **The clamp in `attachTerminal`** (~2698):

1. After the re-promotion block computes `effectiveIntent` (~2740-2751), compute the wire intent:

```ts
// Geometry authority invariant (attach-geometry-resume-panes): a pane that
// is not visible must never CLAIM viewport geometry on the wire — servers
// resize the PTY unconditionally for viewport_hydrate regardless of who
// else is attached, so a hidden hydrating tab stamps stale/never-fitted
// dims over the visible pane's size. The swap is wire-token-only: all
// bookkeeping keeps viewport_hydrate semantics (sinceSeq 0, surface reset,
// currentAttachRef/deferredAttachState intents); keepalive_delta is
// replay-identical (replay keys off since_seq) and never resizes.
const hiddenViewportAttach = effectiveIntent === 'viewport_hydrate' && hiddenRef.current
const wireIntent = hiddenViewportAttach ? 'keepalive_delta' : effectiveIntent
```

2. Use `wireIntent` (not `effectiveIntent`) in the `ws.send(buildTerminalAttachMessage({ ... }))` call. Do NOT change `deferredAttachStateRef.current.pendingIntent`, `currentAttachRef.current.intent`, seq-state handling, or any clearing.

3. Immediately after the `rememberSentViewport(tid, cols, rows)` / `lastSentViewportRef.current = ...` pair (~2855-2856):

```ts
if (hiddenViewportAttach) {
  // The server did not apply these dims; do not let them suppress the next
  // visible-pane resize (reveal-time heal path).
  forgetSentViewport(tid)
  lastSentViewportRef.current = null
}
```

No other edits. In particular: do not touch the re-promotion conditions, the rejection ladders, the gap predicate, the reveal effect, or requestTerminalLayout.

- [x] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/TerminalView.lifecycle.test.tsx`

Expected: PASS (T1/T2 now green; T3 stays green; every pre-existing test in the file stays green after the allowed predicate updates).

- [x] **Step 5: Refactor while green**

Verify no duplication crept into the attach block; keep the invariant comment within ~8 lines. No other refactor.

- [x] **Step 6: Run impacted-test verification**

Enumerate impacted client files first: `grep -rl "viewport_hydrate\|keepalive_delta" test/unit/client/src test/unit/client 2>/dev/null | sort -u` (then keep only files that exist). Run:

```bash
npm run test:vitest -- run <each enumerated file>
npm run typecheck
npm run lint
```

Expected: all PASS. Record the enumerated file list and counts in the task report. Failures whose root cause is an old-contract hidden-viewport assertion may be updated per the Step 1 rule; anything else is a real defect — stop, do not commit, escalate.

- [x] **Step 7: Commit the task**

```bash
rm crates/freshell-ws/tests/zz_probe_attach_resume_geometry.rs
git add src/components/TerminalView.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "fix(client): hidden panes never claim viewport geometry on the wire

A hidden/background-hydrating tab attached with viewport_hydrate and stale
(or never-fitted) dims; servers resize the PTY unconditionally for that
intent, stomping the visible pane's geometry (opencode TUI wrap-garbage on
scroll, dead regions). Swap the wire intent to keepalive_delta for such
attaches — replay-identical, resize-free — and invalidate this client's
suppression records so reveal-time fit+resize actually reaches the server.
Client-side bookkeeping keeps viewport_hydrate semantics, so the replay-gap
recreate predicate and reveal planning are unchanged."
```

---

### Task 2: e2e regression — reload-restored background tab stays geometry-neutral until reveal

**Files:**
- Test: `test/e2e-browser/specs/multi-client.spec.ts` (EXTEND — already a MATRIX_SPECS member per playwright.config.ts, so both legacy-chromium and rust-chromium run it with no config change; do NOT create a new spec file).
- No production changes in this task.

**Interfaces:**
- Consumes: existing helpers in `specs/multi-client.spec.ts` (`waitForTabWithTerminalId`, `waitForMarkedPtySize` (:154-165 — marker shape `__LABEL__:<rows> <cols>`), the file's `test` import/fixtures), the reload/persist-restore flow precedent from `test/e2e-browser/specs/rest-tab-persistence.spec.ts` (reuse its restore helpers/patterns verbatim where applicable), plus page-side `window.__FRESHELL_TEST_HARNESS__` (`getSentWsMessages`, `getTerminalBuffer`) and store dispatch as used by other specs.

- [ ] **Step 1: Write the failing behavioral test**

Deterministic mount-hidden shape via reload restore (round-3 findings 4-5: the REST-create flow auto-selects and then never re-hydrates, so it could never demonstrate the hidden attach; the boot-time path is the production shape behind the 80x24 stale-dims fleet). Test flow:

1. In a fresh page, create TWO shell tabs (existing helpers): T-A (leave active) and T-B. Close/navigate-away and reload the page in the SAME context so both tabs restore from persistence; after boot ONLY T-A is active/visible and T-B's pane mounts hidden.
2. Poll `getSentWsMessages` for `terminal.attach` frames naming T-B's terminalId after boot. Assert: at least one such attach arrived with `intent === 'keepalive_delta'` and `priority === 'background'`, and NO attach with `intent === 'viewport_hydrate'` for T-B's terminalId was sent while it was hidden.
3. Switch to T-B. Do NOT expect a new attach. Assert a `terminal.resize` frame for T-B's terminalId follows the reveal; capture its cols/rows.
4. In T-B, type `echo __AXIS__:$(stty size)\r`; `waitForMarkedPtySize('__AXIS__', ...)` and assert the kernel-reported `rows cols` EQUAL the resize frame's dims (a hidden-clamp failure would leave kernel dims at the stale/never-fitted values instead).

If the reload-restore helper flow in `rest-tab-persistence.spec.ts` cannot supply T-B's terminalId at boot, get it from the harness/store dispatch state in-page; never resurrect a REST-create-empty-window shape.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:e2e:local -- specs/multi-client.spec.ts --project=legacy-chromium --project=rust-chromium`

Expected: FAIL at step 2's intent assertion (pre-fix hidden hydration attaches viewport_hydrate). Setup errors → fix setup only. If Task 1 landed first, the test is green-by-construction; record that and cite the unit RED witnesses.

- [ ] **Step 3: Add the minimal production implementation**

None (Task 1 covers production). Additionally, update the pre-existing reconnect test in THIS spec file (round-2 finding 5): its hidden/background branch's accepted wire intent becomes `keepalive_delta` with an updated comment ("hidden/background attaches are keepalive_delta BY POLICY — they never claim geometry; visible foreground attaches remain viewport_hydrate/transport_reconnect"). Record the edit in the task report.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:e2e:local -- specs/multi-client.spec.ts --project=legacy-chromium --project=rust-chromium`

Expected: PASS on both projects, including the updated pre-existing reconnect test.

- [ ] **Step 5: Refactor while green**

Reuse the file's helper patterns; no new infrastructure.

- [ ] **Step 6: Run impacted-test verification**

Run: `npm run test:e2e:local -- specs/multi-client.spec.ts --project=legacy-chromium --project=rust-chromium`

Expected: PASS (whole file, both projects).

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/multi-client.spec.ts
git commit -m "test(e2e): pin geometry-neutral boot-time background hydration and reveal resize heal for restored tabs"
```

---

### Task 3: Live end-to-end verification on a scratch worktree instance

**Files:**
- No tracked file changes. Evidence (screenshots + captured dims) is written to the run logs `reports/` only.

**Interfaces:**
- Consumes: Tasks 1-2. Scratch dev instance from the worktree per repo process-safety rules: `NODE_ENV=development PORT=3344 npm run dev > /tmp/freshell-3344.log 2>&1 & echo $! > /tmp/freshell-3344.pid` from the worktree, teasing out the token, driving via a browser (the agent's browser automation).

- [ ] **Step 1: Boot + witness setup**

Verify the pid file PID belongs to the worktree (`ps -fp $(cat /tmp/freshell-3344.pid)` and confirm the cwd/command path includes the worktree). Open the dev client URL with token in the browser at a fixed window size. Create TWO panes: (a) a shell pane T-A (leave active); (b) an opencode-mode pane (T-OC) via the pane picker/REST; (c) a second shell tab T-B. Then RELOAD the page (same context): persisted tabs restore, T-A active/visible, T-B hidden — the boot-time mount-hidden hydration shape.

- [ ] **Step 2: Machine-checkable assertions**

(a) Shell pane: type `echo __AXIS__:$(stty size)` — marker must equal the pane's current fitted xterm dims. (b) Opencode pane: assert via buffer rows (harness) that the footer renders on ONE row and contains both `ctrl+p` and `commands` (no wrap cascade); scroll back a few pages with PgUp and assert rows stay coherent (no right-edge fragment cascade — compare before/after dumps for absence of the known garbage pattern `^ ▀+$` mid-row splits and lone `\d+%)` fragments). (c) Witness tab T-B: assert from `getSentWsMessages` that its boot hydration attach was `keepalive_delta` with `priority: 'background'` and no `viewport_hydrate` frames named T-B's terminalId while hidden. (d) Reveal T-B, assert a `terminal.resize` frame followed the reveal (a new attach is NOT expected once hydration completed), then type the stty marker and confirm its dims equal the emitted resize frame dims (not the 80x24 never-fitted defaults). (e) The opencode pane T-OC (visible): footer renders on ONE row containing both `ctrl+p` and `commands`; PgUp-scroll a few pages and confirm no right-edge wrap-cascade fragments (compare row dumps; absence of lone `\d+%)` cells and row-split footer). Record all dims + one screenshot per assertion into the run logs dir `/home/dan/code/freshell/.worktrees/.the-usual-logs/attach-geometry-resume-panes/reports/live-verify-*.png|json` (outside the tracked worktree — never commit these).

- [ ] **Step 3: Teardown + record**

Verify ownership before stopping: `ps -fp "$(cat /tmp/freshell-3344.pid)"` and confirm the process's cwd/binary is inside the worktree; only then `kill "$(cat /tmp/freshell-3344.pid)" && rm -f /tmp/freshell-3344.pid`. Write `/home/dan/code/freshell/.worktrees/.the-usual-logs/attach-geometry-resume-panes/reports/live-verify.md` with the evidence list and the assertion outcomes.

- [ ] **Step 4: No commit**

This task produces no tracked artifacts (the evidence lives in the run logs).

---

## Addon: plan scope check vs User Request

- Primary fix targets the established mechanism and satisfies "never claim viewport geometry while hidden" via the single choke point — wire intent swap to keepalive_delta — server parity untouched (no server diff).
- Reveal-time convergence is restored through suppression-record invalidation on clamped attaches, explicitly pinned by Task 1's T2 and Task 2's step 4; Task 3 verifies it live (including the opencode visual integrity a human would notice as "garbage").
- Residuals honored: no server hardening, no fresh-agent identity work, base failures recorded not fixed. Known accepted transient (validator AC): a hidden clamped replay paints over the stale hidden surface until reveal; invisible to users, verified safe.
