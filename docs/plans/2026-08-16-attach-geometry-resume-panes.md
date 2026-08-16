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

---

### Task 1: Hide-gated attach intent (wire-token clamp + suppression-record invalidation)

**Files:**
- Delete: `crates/freshell-ws/tests/zz_probe_attach_resume_geometry.rs` (pre-plan probe; evidence retained in run logs `reports/`; it asserts only the current-server contract, which stays unchanged)
- Modify: `src/components/TerminalView.tsx` (`attachTerminal` ~line 2698; the only production change)
- Test: `test/unit/client/components/TerminalView.lifecycle.test.tsx` (extend the hidden-pane attach-intent block; reuse `renderTerminalHarness`, `wsMocks`, `messageHandler`, `restoreMocks`, `getHydrationQueue().onActiveTabReady`, `reconnectHandler`, `TerminalView`/`TerminalViewFromStore` exactly as neighboring tests do)

**Interfaces:**
- Consumes: `attachTerminal(tid: string, intent: 'viewport_hydrate' | 'keepalive_delta' | 'transport_reconnect', opts?: AttachTerminalOptions): void`, `hiddenRef.current: boolean`, existing module-level helper `forgetSentViewport(tid)` (src/components/TerminalView.tsx:507), `lastSentViewportRef` (per-instance ref).
- Produces: no new exported names; only wire-frame `intent` differs for hidden clamps.

- [ ] **Step 1: Write the failing behavioral tests**

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

T3 — surface reset at clamped full replay (green-by-construction guard, protects round-1 finding-2's regression): mount hidden via T1's shape and drive one attach generation fully (attach.ready + tagged output writing `PRIOR-SURFACE-MARKER`) so the terminal surface is non-empty; then force a SECOND hidden clamped attach (exactly as the first was produced — `onActiveTabReady` again), and drive its attach.ready `{ headSeq: 6, replayFromSeq: 3, replayToSeq: 6, attachRequestId: <second attach request id> }` plus `terminal.output` `{ seqStart: 3, seqEnd: 6, data: 'CLAMPED-REPLAY-MARKER', attachRequestId: <second attach request id> }`; assert the mocked terminal write stream contains `CLAMPED-REPLAY-MARKER` exactly once AND `PRIOR-SURFACE-MARKER` exactly once (never duplicated by the replay). Every stream frame carries its attachRequestId.

Also update the pre-existing hidden replay-gap test "recreates a hidden restored OpenCode pane when background viewport hydration cannot replay startup output" (~line 8685): change ONLY its attach wait predicate from `intent === 'viewport_hydrate'` to `intent === 'keepalive_delta'` (the production recreate predicate is NOT changed — `currentAttachRef.intent` retains viewport bookkeeping; that is part of the production contract this redesign pins). Any other pre-existing assertion of a hidden wire `viewport_hydrate` gets the same single-word update under the old-contract rule; record every touched test in the task report. Visible-pane assertions (e.g. "recreates a restored OpenCode pane when visible viewport hydration cannot replay startup output" and the reconnect-before-reveal test at ~4635) must stay untouched and green.

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/TerminalView.lifecycle.test.tsx`

Expected: FAIL for T1 (wire intent is `viewport_hydrate` pre-fix), FAIL for T2 (reveal resize suppressed pre-fix because the hidden viewport_hydrate attach recorded identical dims), and FAIL for T4 (hide-then-reconnect race: stale hiddenRef leaks a `viewport_hydrate`). T3 and the reconnect-before-reveal test (~4635) must pass pre-fix — if they fail, the harness setup is wrong; fix the setup, not the assertions. The replay-gap test fails pre-fix only after its predicate update; all failure modes must be assertion-level, not setup errors.

- [ ] **Step 3: Add the minimal production implementation**

Changes live in two places in `src/components/TerminalView.tsx`.

3a. **Close the visibility-race window** (round-2 finding 3). `hiddenRef` is currently synced only in a passive effect (~1191-1199). The same file already establishes the render-synchronous precedent at ~1213-1218 ("Sync during render (not in useEffect) so refs always have latest values"). Move the `hiddenRef.current = hidden` assignment into that render-synchronous block (i.e. assign during render); keep ONLY the extra side effects (`clearHoveredUrl`, dataset cleanup on hide) in the effect. No other ref handling changes. Regression-pin this with the new test below — call it T4:

```ts
it('hide-then-immediate-reconnect still sends a geometry-neutral (keepalive) attach', async () => {
  // Pin the commit→effect window closed: with legacy passive-effect syncing,
  // a reconnect dispatched in the commit-before-effects flush observed the
  // stale visible value and emitted viewport_hydrate.
  const { store, tabId, paneId, terminalId, rerender } = await renderTerminalHarness({
    status: 'running',
    terminalId: 'term-hide-reconnect-race',
    clearSends: false,
    requestId: 'req-hide-reconnect-race',
  })
  const readPaneContent = () => {
    const layout = store.getState().panes.layouts[tabId]
    return layout && layout.type === 'leaf' && layout.content.kind === 'terminal' ? layout.content : null
  }
  wsMocks.send.mockClear()
  rerender(
    <Provider store={store}>
      <TerminalView tabId={tabId} paneId={paneId} paneContent={readPaneContent()!} hidden />
    </Provider>,
  )
  act(() => {
    reconnectHandler?.()
  })
  await waitFor(() => {
    expect(
      wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .some((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId),
    ).toBe(true)
  })
  expect(
    wsMocks.send.mock.calls
      .map(([msg]) => msg)
      .every((msg) => msg?.type !== 'terminal.attach' || msg?.intent === 'keepalive_delta'),
    'no attach may claim viewport geometry after the pane committed hidden',
  ).toBe(true)
})
```

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

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/TerminalView.lifecycle.test.tsx`

Expected: PASS (T1/T2 now green; T3 stays green; every pre-existing test in the file stays green after the allowed predicate updates).

- [ ] **Step 5: Refactor while green**

Verify no duplication crept into the attach block; keep the invariant comment within ~8 lines. No other refactor.

- [ ] **Step 6: Run impacted-test verification**

Enumerate impacted client files first: `grep -rl "viewport_hydrate\|keepalive_delta" test/unit/client/src test/unit/client 2>/dev/null | sort -u` (then keep only files that exist). Run:

```bash
npm run test:vitest -- run <each enumerated file>
npm run typecheck
npm run lint
```

Expected: all PASS. Record the enumerated file list and counts in the task report. Failures whose root cause is an old-contract hidden-viewport assertion may be updated per the Step 1 rule; anything else is a real defect — stop, do not commit, escalate.

- [ ] **Step 7: Commit the task**

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

### Task 2: e2e regression — REST-created witness tab stays geometry-neutral until reveal

**Files:**
- Test: `test/e2e-browser/specs/multi-client.spec.ts` (EXTEND — already a MATRIX_SPECS member per playwright.config.ts, so both legacy-chromium and rust-chromium run it with no config change; do NOT create a new spec file).
- No production changes in this task.

**Interfaces:**
- Consumes: existing helpers in `specs/multi-client.spec.ts`: `waitForTabWithTerminalId`, `waitForMarkedPtySize` (:154-165, marker shape `__LABEL__:<rows> <cols>` — probe text must be `echo __AXIS__:$(stty size)`), the file's `test` import/fixtures, plus page-side `window.__FRESHELL_TEST_HARNESS__` (`getSentWsMessages`, `getTerminalBuffer`, and store dispatch via the harness as other specs do).

- [ ] **Step 1: Write the failing behavioral test**

Round-2 finding 4 established: a REST-created tab broadcast arrives ACTIVE (tabsSlice addTab selects it), so the witness flow must create AND then un-select. Test flow:

1. In the page, use the harness/store to create or use an initial shell pane (existing helpers); record a `stty size` marker `__PRE__:` and keep the emitted dims.
2. REST-create the witness tab: `page.evaluate(fetch('/api/tabs', { POST, headers incl. x-auth-token, body: { mode: 'shell', name: 'geo-witness' } }))`; the broadcast makes it ACTIVE (visible) and it may attach visibly — that is expected and outside the assertion.
3. Switch the client BACK to the original tab (dispatch/tap exactly as other specs switch tabs), so the witness tab becomes hidden; then wait until the witness terminal's hydration attach fires while hidden (poll `getSentWsMessages` for `terminal.attach` frames with the witness terminalId).
4. Assert the CLAMPED attach: at least one `terminal.attach` for the witness terminalId with `intent === 'keepalive_delta'` arrives after it became hidden; and NO `terminal.attach` with `intent === 'viewport_hydrate'` for that terminalId was sent after the hidden transition. (Frames sent while it was briefly visible pre-switch are expected and excluded by the after-transition window in the log, e.g. by slicing `getSentWsMessages` at the switch dispatch.)
5. Reveal the witness tab (switch to it). Do NOT expect a new attach. Assert: a `terminal.resize` frame for the witness terminalId is emitted after reveal; capture its cols/rows.
6. Type `echo __AXIS__:$(stty size)\r` in the witness pane; `waitForMarkedPtySize('__AXIS__', ...)` and assert the reported `rows cols` EQUAL the resize frame's dims (the kernel truth matches what the client claimed — wipe-out of a hidden claim would show the stale dims instead).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:e2e:local -- specs/multi-client.spec.ts --project=legacy-chromium --project=rust-chromium`

Expected: FAIL at step 4's intent assertion (pre-fix, the hidden hydration attach for the witness terminal is `viewport_hydrate`). Setup errors → fix setup only. If Task 1 landed first the test is green-by-construction: record that and cite the unit-level RED instead.

- [ ] **Step 3: Add the minimal production implementation**

None (Task 1 covers production). Additionally, in THIS spec file, the pre-existing reconnect test that accepts `transport_reconnect | viewport_hydrate` for its hidden/background branch (round-2 finding 5): update that branch's accepted wire intent to `keepalive_delta` and update its comment rationale (which documented keepalive as a cold-reconnect marker) to the new contract: hidden/background attaches are keepalive_delta BY POLICY (they never claim geometry); visible foreground attaches remain viewport_hydrate/transport_reconnect. Record the edit in the task report.

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
git commit -m "test(e2e): pin geometry-neutral hidden hydration attach and reveal resize heal for REST-created tabs"
```

---

### Task 3: Live end-to-end verification on a scratch worktree instance

**Files:**
- No tracked file changes. Evidence (screenshots + captured dims) is written to the run logs `reports/` only.

**Interfaces:**
- Consumes: Tasks 1-2. Scratch dev instance from the worktree per repo process-safety rules: `NODE_ENV=development PORT=3344 npm run dev > /tmp/freshell-3344.log 2>&1 & echo $! > /tmp/freshell-3344.pid` from the worktree, teasing out the token, driving via a browser (the agent's browser automation).

- [ ] **Step 1: Boot + witness setup**

Verify the pid file PID belongs to the worktree (`ps -fp $(cat /tmp/freshell-3344.pid)` and confirm the cwd/command path includes the worktree). Open the dev client URL with token in the browser at a fixed window size. Create TWO panes: (a) a shell pane; (b) an opencode-mode pane via the pane picker/REST. REST-create a third shell tab, then immediately switch the client back to the shell-pane tab (the broadcast auto-selects the new tab — switch-back makes it hidden; wait for its background hydration attach, ~1-2s).

- [ ] **Step 2: Machine-checkable assertions**

(a) Shell pane: type `echo __AXIS__:$(stty size)` — marker must equal the pane's current fitted xterm dims. (b) Opencode pane: assert via buffer rows (harness) that the footer renders on ONE row and contains both `ctrl+p` and `commands` (no wrap cascade); scroll back a few pages with PgUp and assert rows stay coherent (no right-edge fragment cascade — compare before/after dumps for absence of the known garbage pattern `^ ▀+$` mid-row splits and lone `\d+%)` fragments). (c) Witness tab: assert from `getSentWsMessages` that its hidden attach was `keepalive_delta`. (d) Reveal the witness tab, assert a `terminal.resize` frame followed the reveal (a new attach is NOT expected once hydration completed), then type the stty marker and confirm its dims equal the emitted resize frame dims (not the 80x24 never-fitted defaults). Record all dims + one screenshot per assertion into `reports/live-verify-*.png|json`.

- [ ] **Step 3: Teardown + record**

Verify ownership before stopping: `ps -fp "$(cat /tmp/freshell-3344.pid)"` and confirm the process's cwd/binary is inside the worktree; only then `kill "$(cat /tmp/freshell-3344.pid)" && rm -f /tmp/freshell-3344.pid`. Write `reports/live-verify.md` with the evidence list and the assertion outcomes.

- [ ] **Step 4: No commit**

This task produces no tracked artifacts (the evidence lives in the run logs).

---

## Addon: plan scope check vs User Request

- Primary fix targets the established mechanism and satisfies "never claim viewport geometry while hidden" via the single choke point — wire intent swap to keepalive_delta — server parity untouched (no server diff).
- Reveal-time convergence is restored through suppression-record invalidation on clamped attaches, explicitly pinned by Task 1's T2 and Task 2's step 4; Task 3 verifies it live (including the opencode visual integrity a human would notice as "garbage").
- Residuals honored: no server hardening, no fresh-agent identity work, base failures recorded not fixed. Known accepted transient (validator AC): a hidden clamped replay paints over the stale hidden surface until reveal; invisible to users, verified safe.
