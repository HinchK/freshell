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

**Architecture:** One invariant in the client attach path: a pane that is not visible (`hiddenRef.current === true`) must never claim viewport geometry. Enforced at the single choke point `attachTerminal` (`src/components/TerminalView.tsx` ~2698): when hidden, the attach runs as a **geometry-neutral full replay** — `effectiveIntent = 'keepalive_delta'`, `sinceSeq` forced to `0` — independent of the caller's requested intent. This avoids three verified collisions with the naive clamp: (1) the internal re-promotion of non-viewport intents to `viewport_hydrate` (~2743-2751) is bypassed for hidden attaches; (2) the warm-delta rejection ladders in the `terminal.attach.ready` handler (4108/4143) can only fire when `sinceSeq > 0`, so forcing `sinceSeq = 0` prevents a clamp→reject→reattach loop in multi-client scenarios where `attach.ready` stamps `geometryAuthority: 'multi_client_unknown'`; (3) the client-side viewport bookkeeping (`syncGeometryEpochForViewport` ~2728, `rememberSentViewport`/`lastSentViewportRef` ~2855-2856) is skipped for hidden attaches, so a later visible-pane `terminal.resize` is not suppressed by `matchesLastSentViewport` (~1643-1650). Servers never resize for `keepalive_delta` (`registry.rs` contract) and wire replay keys off `since_seq` only, so hidden panes still warm up with the full stream. Reveal attaches of visible panes stay `viewport_hydrate`; the reveal effect's `fit+resize` must then heal geometry — because hidden attaches no longer poison the "last sent viewport" record, the reveal resize actually reaches the server.

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

### Task 1: Hide-gated attach intent (RED witness test + choke-point implementation)

**Files:**
- Delete: `crates/freshell-ws/tests/zz_probe_attach_resume_geometry.rs` (pre-plan probe; evidence retained in run logs `reports/`; it asserts only current-server contract, which stays unchanged)
- Modify: `src/components/TerminalView.tsx` (`attachTerminal` ~line 2698)
- Test: `test/unit/client/components/TerminalView.lifecycle.test.tsx` (extend existing attach-intent suite)

**Interfaces:**
- Consumes: `attachTerminal(tid: string, intent: 'viewport_hydrate' | 'keepalive_delta' | 'transport_reconnect', opts?: AttachTerminalOptions): void` and `hiddenRef.current: boolean` (both already in `TerminalView.tsx`).
- Produces: no new exported names; changes the wire frame's `intent` field for attaches sent while the pane is hidden.

- [ ] **Step 1: Write the failing behavioral test**

Add to `test/unit/client/components/TerminalView.lifecycle.test.tsx`, in the existing describe block containing the hidden-pane hydration tests (the block around line 8685 that uses `renderTerminalHarness({ hidden: true, ... })` plus `getHydrationQueue().onActiveTabReady('tab-visible-neighbor', ['tab-visible-neighbor', tabId])`). Reuse `renderTerminalHarness`, `wsMocks`, `messageHandler`, `TerminalViewFromStore`, `act`, `waitFor` exactly as those tests do. New tests:

```ts
it('hidden background hydration attach does not claim viewport geometry', async () => {
  const { store, tabId, paneId, terminalId } = await renderTerminalHarness({
    status: 'running',
    terminalId: 'term-hidden-geo-clamp',
    hidden: true,
    requestId: 'req-hidden-geo-clamp',
  })

  wsMocks.send.mockClear()
  act(() => {
    getHydrationQueue().onActiveTabReady('tab-visible-neighbor', ['tab-visible-neighbor', tabId])
  })

  await waitFor(() => {
    const attach = wsMocks.send.mock.calls
      .map(([msg]) => msg)
      .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
    expect(attach, 'a background hydration attach frame must be sent').toBeTruthy()
    expect(attach.intent, 'hidden hydration must not claim viewport geometry').toBe('keepalive_delta')
    expect(attach.priority).toBe('background')
    expect(attach.cols).toBeGreaterThan(0) // frame schema unchanged
    expect(attach.rows).toBeGreaterThan(0)
    expect(
      wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .some((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId && msg?.intent === 'viewport_hydrate'),
    ).toBe(false)
  })
})

it('reveal after hidden hydration heals geometry via a resize, not a new geometry-claiming attach', async () => {
  const { store, tabId, paneId, terminalId, rerender } = await renderTerminalHarness({
    status: 'running',
    terminalId: 'term-hidden-then-visible',
    hidden: true,
    requestId: 'req-hidden-then-visible',
  })

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

  // Contract: reveal of a pane that attached while hidden does NOT send
  // another geometry-claiming attach (deferred mode is 'live', not
  // 'waiting_for_geometry'); the existing reveal layout effect sends a
  // terminal.resize with the real fitted dims, and the hidden attach must
  // not have poisoned the suppression record (so this resize is actually
  // emitted).
  await waitFor(() => {
    expect(
      wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .some((msg) => msg?.type === 'terminal.attach'),
    ).toBe(false)
    expect(
      wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .some((msg) => msg?.type === 'terminal.resize' && msg?.terminalId === terminalId),
    ).toBe(true)
  })
})
```

(Adjust identifiers at the call edges only — e.g. if `renderTerminalHarness` returns differently named keys or needs `sessionRef`/`mode`, mirror the neighboring tests. The assertions are the contract.)

Also update the pre-existing hidden-hydration replay-gap test (~line 8685, "recreates a hidden restored OpenCode pane when background viewport hydration cannot replay startup output"): its attach predicate filters on `intent === 'viewport_hydrate' && priority === 'background'`. That encoded the old contract; change ONLY the predicate's intent to `'keepalive_delta'` so it keeps testing the recreate-on-replay-gap behavior under the new intent. The kill/recreate behavior contract of that test is unchanged. Do not weaken its assertions. Any other pre-existing test that fails for asserting hidden-pane `viewport_hydrate` must be reviewed individually: update it only if its purpose is the same (hidden-path contract), record each touched test in the task report. The "hidden split create keeps viewport_hydrate intent when reconnect fires before reveal" test (~line 4635) must be verified by reading its rerender order first: it rerenders with `hidden={false}` after the reconnect tick, so its awaited attach is sent while visible and must stay `viewport_hydrate` — if it fails, that failure is real information about stale `hiddenRef` handling; stop and escalate to the coordinator rather than loosening it.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/TerminalView.lifecycle.test.tsx`

Expected: FAIL because the hidden background-hydration attach frame carries `intent: 'viewport_hydrate'` today (the new first test fails on the intent assertion; the pre-existing replay-gap test will also fail after its predicate update — both failures are intent-level). Failure must be assertion-level, not mount/setup breakage.

- [ ] **Step 3: Add the minimal production implementation**

In `src/components/TerminalView.tsx`, inside `attachTerminal` (~line 2698), apply four coordinated edits, all gated on one boolean captured at entry. Do not touch the visible-pane paths.

```ts
// at the top of attachTerminal, right after existing early returns (~2717):
const isHiddenAttach = hiddenRef.current
```

1. **Intent + replay clamp.** Replace the initial `let effectiveIntent = intent` assignment (~2740) so that when `isHiddenAttach`, `effectiveIntent` becomes `'keepalive_delta'` and both re-promotion branches (~2743-2751) are skipped (guard them with `!isHiddenAttach`). Force full replay for hidden attaches: when `isHiddenAttach`, treat `explicitSinceSeq` as `undefined` and the checkpoint decision as not-ok for the `deltaSeq`/`sinceSeq` derivation (~2752-2753), yielding `sinceSeq === 0`. This is what prevents the warm-delta rejection ladders (which require `sinceSeq > 0`) and any clamp→reject→reattach loop. Do NOT force `clearViewportFirst` either way for hidden attaches; keep the caller's value (cosmetic on a hidden surface).
2. **Skip geometry bookkeeping for hidden attaches.** Guard with `!isHiddenAttach`: the `syncGeometryEpochForViewport(tid, cols, rows)` call (~2728) and the `rememberSentViewport(tid, cols, rows)` + `lastSentViewportRef.current = ...` pair (~2855-2856). A hidden attach never resizes server-side, so its dims must not become the "last sent viewport" that future visible resizes are suppressed against. Compute `cols`/`rows` as today (they stay in the frame — the schema is unchanged; the server ignores them for keepalive).
3. Keep `deferredAttachStateRef.current` (~2794) and `currentAttachRef.current` (~2801) recording `pendingIntent`/`intent` = the SENT intent (`effectiveIntent`), so the reveal plan and ready-handler see the true wire semantics.
4. Add a code comment on the clamp stating the invariant and why sinceSeq must be 0 and viewport bookkeeping skipped (this is the load-bearing summary of the run's evidence; reference that `resize_for_attach` resizes unconditionally for viewport_hydrate).

- [ ] **Step 3b (same task, same commit): reveal-side resize must not be suppressible.** In `flushScheduledLayout` (~1613-1658), evaluate whether, after a hidden attach with clamped bookkeeping, the reveal-time `fit+resize` can be suppressed by `matchesLastSentViewport`. The expected answer post-fix is "no" (nothing recorded while hidden; the last visible record may still be stale-equal if the visible pane's fitted dims are unchanged while the server was resized by someone... — with the stomp gone, the only resizer is THIS pane's visible client; if its last-sent record still matches the fitted dims, the suppression is CORRECT except when another client resized the PTY underneath, which the server-side contract still permits — accepted residual per the User Request). If the focused tests prove suppression still bites in the intended-heal flow, amend the reveal call to bypass suppression explicitly (the smallest change that does that, e.g. a forced resize flag on the reveal layout request), and pin it with the second lifecycle test's assertion list (add: "a terminal.resize frame with the pane's fitted dims is sent on reveal even when a previous visible attach recorded the same dims after a foreign resize changed the server geometry"). Document the chosen answer in the task report.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/TerminalView.lifecycle.test.tsx`

Expected: PASS (both new tests; the whole file stays green).

- [ ] **Step 5: Refactor while green**

Review call-site text: with the choke point in place, the background-hydration effect's explicit `'viewport_hydrate'` argument remains accurate intent-from-caller vocabulary (the clamp site handles gating); add the same one-line comment pointer at the hydration effect call site (TerminalView.tsx ~2992) to keep the invariant discoverable. No other refactor; do not touch the reveal-plan policy file.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: all client tests that cover attach intents, hydration, reveal attach, geometry epochs, and resize suppression. Enumerate them (verify with `ls test/unit/client/lib/ test/unit/client/components/ | grep -iE "attach|hydration|lifecycle|view-utils|terminal"` and include every attach/hydration/terminal-view file plus the policy file).

Run: `npm run test:vitest -- run <each enumerated file>` (one invocation with the full enumerated list).

Expected: PASS with zero failures; record the file list and counts in the task report. Any failure whose root cause is the intent change must either be an old-contract assertion (update per Step 1's rule) or a real behavior defect (stop, do not commit; escalate to the coordinator with evidence).

- [ ] **Step 7: Commit the task**

```bash
rm crates/freshell-ws/tests/zz_probe_attach_resume_geometry.rs  # untracked probe — plain rm, evidence retained in run logs
git add src/components/TerminalView.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "fix(client): hidden panes never claim viewport geometry on attach

A hidden pane's fitted dims are stale; viewport_hydrate hydration attaches
from any client applied them as the PTY size unconditionally, stomping the
visible pane's geometry (opencode TUI wrap-garbage on scroll, stale bands).
Downgrade viewport_hydrate to keepalive_delta at the attachTerminal choke
point while the pane is hidden; reveal attaches of visible panes are
unchanged and keep healing geometry."
```

---

### Task 2: Multi-client e2e regression — hidden hydration does not stomp the visible pane's PTY

**Files:**
- Test: `test/e2e-browser/multi-client.spec.ts` (extend; precedent file for cross-client PTY geometry assertions) OR a new `test/e2e-browser/attach-geometry-authority.spec.ts` if the existing file's fixture doesn't fit — verify the fixture shapes first, reuse MATRIX_SPECS conventions so it runs on both legacy and rust server projects.
- Modify: `src/lib/test-harness.ts` ONLY if the e2e cannot otherwise read the real PTY size — precedent uses `getTerminalBuffer` + typed `stty size` markers, which needs no harness change; prefer that. No production client changes in this task.

**Interfaces:**
- Consumes: Task 1's behavior; `window.__FRESHELL_TEST_HARNESS__` (`getTerminalBuffer`, `sendWsMessage`, store dispatch) as used by `multi-client.spec.ts`; Playwright matrix fixtures from `test/e2e-browser/` (follow `multi-client.spec.ts` exactly).
- Produces: an e2e spec asserting that a second client's hidden hydration attach does not change the PTY size reported by the owning pane (kernel truth via `stty size` markers read from the pane's xterm buffer).

- [ ] **Step 1: Write the failing behavioral test**

Test shape (follow `multi-client.spec.ts`'s browser-context setup helpers verbatim — same two-context creation, token wiring, and terminal creation helpers; do not invent new fixtures):

```ts
test('hidden hydration attach on client B does not change client A pane PTY size', async ({ /* matrix fixtures */ }) => {
  // 1. Client A creates a pane running a shell; fit to a distinctive size
  //    (e.g. resize the browser viewport / pane container per the file's
  //    existing helpers); record PTY size via typing
  //    `echo __AXIS__$(stty size)__` and reading the harness buffer marker.
  // 2. Ensure A's tab becomes hidden on client B: open the same session in a
  //    second browser context (client B), DO NOT select A's tab, and let the
  //    background hydration attach fire (the file's hydration wait helpers,
  //    or wait for B's inventory to contain the tab then one rendered-frame
  //    tick).
  // 3. Assert via the `stty size` marker on A that the PTY size is unchanged.
  //
  // Pre-fix this fails: B's hidden hydration sends viewport_hydrate with
  // stale dims and the PTY flips to them (probe evidence in the run's
  // reports/). Post-fix B attaches keepalive_delta (no resize).
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:e2e:local -- attach-geometry-authority` (or the exact spec-name selector; verify with `npm run test:e2e:local -- --list` first and use the resolved name)

Expected: FAIL because client B's hidden hydration attach flips the PTY away from client A's size. If the setup itself errors (context/tokens/hydration), fix the setup — the RED must be the PTY-size assertion.

Note for the implementer: if Task 1's fix lands first, this test arrives GREEN by construction; that is acceptable for Task 2 because its purpose is the durable regression pin. Record in the task report whether RED was observed (stash Task 1 HEAD~ to demonstrate RED if the reviewer wants evidence: `git stash`/checkout dance is NOT required in the default flow; documenting probe evidence from `reports/` suffices).

- [ ] **Step 3: Add the minimal production implementation**

None — Task 1's production change is the fix. This task adds only the e2e. If the e2e cannot be expressed without a tiny harness accessor, add exactly one method to `src/lib/test-harness.ts` (e.g. `getTerminalProps(terminalId)` returning xterm cols/rows) with an accompanying focused vitest addition in the harness's existing unit test file, and use it in the e2e instead of weakening the assertion.

- [ ] **Step 4: Run the focused test**

Run: the same e2e command from Step 2.

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Deduplicate any new setup code with `multi-client.spec.ts` helpers (share them via that file's existing helper module if one exists; do not create a new shared module for a single caller).

- [ ] **Step 6: Run impacted-test verification**

Run: `npm run test:e2e:local -- multi-client attach-geometry-authority` (both matrix projects that are selected by default; do not opt into cloud).

Expected: PASS for both.

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/ (changed/new spec + any harness/new helper files)
git commit -m "test(e2e): pin that hidden hydration attaches cannot stomp the visible pane's PTY size"
```

---

### Task 3: Geometry-convergence live verification against the live root-cause scenario (opencode TUI garbage)

**Files:**
- No tracked file changes; verification entry only (playwright-driven or manual harness steps against a scratch local server instance on a unique port per AGENTS.md process-safety rules).

**Interfaces:**
- Consumes: Tasks 1-2. A throwaway freshell instance started from the worktree with `NODE_ENV=development PORT=3344 npm run dev` (PID-recorded, killed afterwards), a real `opencode` TUI pane, and the test Chrome harness.

- [ ] **Step 1: Reproduce the production symptom pre-fix (sanity)**

On the scratch instance WITHOUT the fix (e.g. `git stash` of Task 1-2 in a SECOND checkout is not allowed in-repo; instead verify at base in the worktree by... — implementer: if demonstrating pre/post deltas in one worktree is awkward, SKIP this step and rely on the recorded live evidence in the run logs: wiring two clients with different window sizes against one opencode pane was already shown to produce the wrapped garbage capture `/tmp/opencode/chrome-*.png` and the ws geometry stomp from the probe run). Restate the observed pre-fix facts in the task report instead of re-producing.

- [ ] **Step 2: Post-fix convergence check**

With the fix committed: start the scratch server from the worktree (unique port 3344; record `/tmp/freshell-3344.pid`), open two window-sized contexts, run a real `opencode` TUI pane in client A at a fitted size; let client B's background hydration attach; force scrolls in A; assert via the harness buffer that the render stays intact (no wrapped-footer cascades) and that `stty size` matches A's fitted dims. Then switch visibility: select the tab in B and assert its reveal-attach heal (fresh `stty size` matches B's fitted dims after one resize tick).

- [ ] **Step 3: Tear down and record**

Kill the scratch instance with `kill "$(cat /tmp/freshell-3344.pid)" && rm -f /tmp/freshell-3344.pid`; record observed sizes and screenshots under the run's `logs_dir/reports/`; write the task report with evidence paths.

- [ ] **Step 4: No commit**

This task produces no tracked artifacts (AGENTS.md forbids committing scratch logs; the durable record is the run logs).

---

## Addon: plan scope check vs User Request

- Primary fix targets the established mechanism and satisfies "never claim viewport geometry while hidden" via the single choke point -> constraint satisfied; Node/Rust parity untouched (no server diff).
- Reveal-time convergence is explicitly pinned by Task 1's second test and Task 2's step 2 second half.
- Residuals honored: no server hardening, no fresh-agent identity work, base failures recorded not fixed.
