# Recovery Offer Phone Fixes Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

**Goal:** A brand-new device (e.g. a phone on first login) must never be
interrupted by the "Restore N panes from server memory?" recovery dialog while
other clients are still connected to the server — and when the dialog IS
legitimately shown, it must fit phone-sized viewports with a scrollable pane
list and always-reachable action buttons.

**Architecture:** Two independent fixes. (1) Server-side (Rust): track which
tab-registry clients are currently connected over the WebSocket
(socket-truthful — stamped on `tabs.sync.push`, cleared on connection
teardown); the `GET /api/recovery/inventory` handler returns the empty,
non-recoverable inventory whenever any client OTHER than the requester is
connected. Rationale: while other clients are live, nothing has been lost —
the recovery offer exists for browser loss / server restart, not to interrupt
fresh devices with other machines' layouts. (2) Client: restructure
`RecoveryOfferPanel` to the repo's established tall-modal pattern
(`DeadSessionPanel.tsx`:`max-h-[80vh] flex flex-col` + internal
`overflow-y-auto flex-1 min-h-0` scroll region + footer outside the scroll
region). E2E pins both fixes.

**Tech Stack:** Rust (axum, tokio) crates `freshell-server` + `freshell-ws`;
React 18 + TypeScript client; Vitest + RTL; cargo test; Playwright e2e
(rust-chromium project).

## Global Constraints

- The production server is the Rust server; the inventory route exists ONLY
  there (the Node/legacy server 404s it and the client already stays quiet on
  fetch failure — do not touch the legacy server).
- Do not change `tabs.sync.push`/`tabs.sync.query`/`tabs.sync.client.retire`
  wire semantics, the sidebar status-ring behavior, or snapshot persistence
  formats. The connected-client structure is process-local memory only.
- All client-visible responses keep the existing JSON shape
  (`{recoverable, contentId, device, otherDevices, ledgerOnly}`), consumed in
  `src/lib/recovery/types.ts`.
- Existing e2e semantics pinned and preserved: with NO other client connected,
  offers appear exactly as today (`recover-my-panes-rust.spec.ts` scenarios
  1–3, `sidebar-registry-sync-rust.spec.ts` case-d).
- Server uses NodeNext/ESM for TS; relative imports must include `.js`.
- Commits focused per task; user identity per repo git config (never override).

## Requirements

- **R1 — Outcome:** A fresh browser/device booting with empty storage receives
  NO recovery offer while any OTHER client is connected (`recoverable:false`).
  This covers content of every kind: foreign device unions AND `ledgerOnly`
  rows (the incident response contained 19 panes + 301 ledgerOnly rows — the
  whole offer is gated, not just the union part). The requester itself is
  never treated as "other" even when it is already connected/stamped (a
  pending-offer re-fetch from an already-connected browser must still work).
- **R2 — Outcome (preserve):** When no other client is connected, offers
  appear exactly as before: post-restart first boot, and sole-browser loss
  without restart (D7 live-note flow). Existing e2e scenarios pass unchanged.
- **R3 — Outcome:** When the offer IS shown, the dialog fits within a
  390x844-class viewport: the pane list scrolls internally and the
  `Not now`/`Restore` buttons are always visible and clickable; the body
  scroll-lock behavior is unchanged.
- **R4 — Constraint:** No changes to tab-registry sync semantics, ring
  status, persistence formats, or the legacy Node server. No new settings.
- **R5 — Evidence:** Rust unit/route tests for the gate and the connected-set
  structure; client component tests asserting the scroll-region structure;
  new e2e scenario proving R1 (connected ⇒ no offer, then after disconnect ⇒
  offer) and a phone-viewport e2e proving R3; the three existing recovery
  scenarios (R2) green; final full local verification (`npm test`,
  `cargo test -p freshell-server`, focused e2e) green on the final HEAD.

---

### Task 1: Rust server — connected-client tracking + inventory gating

**Requirements served:** R1, R2, R4, R5

**Behavior:**
- The server tracks which `clientInstanceId`s currently have a live WS
  connection that has pushed tab-registry state: stamp `(connectionId →
  clientInstanceId)` on each validated `tabs.sync.push` (the frame requires a
  non-empty `clientInstanceId` today — reuse that validation point), and drop
  the connection's stamps at WS teardown (the same teardown block that calls
  `LayoutStore::remove_client`).
- `GET /api/recovery/inventory`: after auth, BEFORE reading snapshots: if the
  live set minus the request's `clientInstanceId` is non-empty, return 200 with
  the canonical empty inventory (`{"recoverable":false,"contentId":"<digest of
  no substance>","device":null,"otherDevices":[],"ledgerOnly":[]}` — built by
  calling `build_inventory(vec![], vec![], HashSet::new())` so the contentId
  semantics stay exactly one code path). When nobody else is connected,
  behavior is byte-identical to today.
- A client that reconnects is re-stamped by its next push (first push fires on
  WS ready — seconds); a momentarily-disconnected desktop may briefly allow an
  offer — acceptable ("decline is cheap", and dismissal dedupes by contentId),
  recorded as a deliberate trade-off.
- Document the resolved residual in `docs/plans/2026-07-26-recover-my-panes.md`
  (the `:43` "second machine still connected … decline is cheap" paragraph):
  replaced by the connectedness gate description.

**Files:**
- Create: `crates/freshell-ws/src/connected_clients.rs` — `#[derive(Clone, Default)]
  pub struct ConnectedTabClients { inner: Arc<Mutex<HashMap<u64, HashSet<String>>>> }`
  with `note_push(&self, conn_id: u64, client_instance_id: &str)`,
  `remove_connection(&self, conn_id: u64)`, `live_client_ids(&self) -> HashSet<String>`.
  Export from `crates/freshell-ws/src/lib.rs` (`pub mod connected_clients;`).
- Modify: `crates/freshell-ws/src/lib.rs` (WsState field
  `pub connected_clients: ConnectedTabClients` next to the other shared
  handles ~:96-382), `crates/freshell-ws/src/terminal.rs` (`handle_tabs_push`
  ~:5090-5107 — stamp after the clientInstanceId validation ~:5171-5173 using
  the handler's connection id; teardown block ~:579-615 — call
  `connected_clients.remove_connection(conn_id)` beside `remove_client`).
- Modify: `crates/freshell-server/src/recovery_inventory.rs` —
  `RecoveryInventoryState` gains `pub connected: ConnectedTabClients`;
  `inventory_handler` gates after auth; update stale doc comment (registry now
  constructed at `main.rs:389`, not `:249`).
- Modify: `crates/freshell-server/src/main.rs` (~:1615-1625 merge) — pass the
  shared `ConnectedTabClients` (constructed once where the other shared state
  is built) into both the `WsState` construction (~:1011) and
  `RecoveryInventoryState`.
- Modify: `crates/freshell-server/src/recovery_inventory_tests.rs` — new tests
  (see below); existing tests construct `test_state(...)` — extend the helper
  to accept (or default to) an empty `ConnectedTabClients` so existing tests
  keep passing unchanged in behavior.
- Modify: `docs/plans/2026-07-26-recover-my-panes.md` — residual text update.

**Interfaces:**
- Consumes: WS push/teardown sites, `build_inventory(unions, bindings, live)`
  (existing, unchanged), `is_authed`.
- Produces: `ConnectedTabClients` (public, Clone); the gated handler. No
  response-shape change; no new query params.

**Test cases:**
- `ConnectedTabClients`: note/remove round-trip; two connections for the same
  client — removing one keeps the client live; removing the only connection
  clears it; `live_client_ids` unions across connections.
- Route: seeded foreign union + live set `{other-client}` + requester `me` →
  200, `recoverable:false`, `device:null`, `otherDevices:[]`,
  `ledgerOnly:[]` (seed a ledgerOnly-eligible binding row too, proving rows
  are gated as well).
- Route: same seed but live set `{me}` (only requester connected) →
  `recoverable:true` with the union offered (matches today's response).
- Route: same seed, empty live set → unchanged legacy behavior.

- [ ] **Step 1: Write the failing behavioral test**

Add to `recovery_inventory_tests.rs`: the three route tests above (extend
`test_state` helper minimally) and the `ConnectedTabClients` unit tests in the
new module (`#[cfg(test)]` in `connected_clients.rs`, matching crate
conventions). The route tests must fail today because the gate does not exist
(suppressed-case test gets `recoverable:true`).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-server recovery_inventory` and
`cargo test -p freshell-ws connected_clients`

Expected: FAIL — the suppressed-case route test observes
`recoverable:true` (no gate), and the unit tests fail to compile (no module);
both failures are for the missing behavior only.

- [ ] **Step 3: Add the minimal production implementation**

Create `connected_clients.rs`; add `pub mod connected_clients;` + WsState
field; stamp in `handle_tabs_push` after the non-empty validation; clear in
the teardown block; gate in `inventory_handler` (early return via
`Json(build_inventory(vec![], vec![], HashSet::new()))`); wire through
`main.rs` (one instance, cloned into `WsState` and `RecoveryInventoryState`);
extend `RecoveryInventoryState`; fix the stale doc comment; update the
plan-doc residual.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-server recovery_inventory` and
`cargo test -p freshell-ws connected_clients`

Expected: PASS (all new + existing tests in both filters).

- [ ] **Step 5: Refactor while green**

Verify the stamp/clear sit at exactly one call site each; no duplication;
log nothing new (this path is hot — no per-push logging).

- [ ] **Step 6: Run broader verification**

Run: `cargo test -p freshell-server` and `cargo test -p freshell-ws`
Expected: PASS
Run: `cargo clippy -p freshell-server -p freshell-ws -- -D warnings`
Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ws/src/connected_clients.rs crates/freshell-ws/src/lib.rs crates/freshell-ws/src/terminal.rs crates/freshell-server/src/recovery_inventory.rs crates/freshell-server/src/recovery_inventory_tests.rs crates/freshell-server/src/main.rs docs/plans/2026-07-26-recover-my-panes.md
git commit -m "fix(server): suppress recovery inventory offers while other clients are connected"
```

### Task 2: Client — scrollable RecoveryOfferPanel dialog

**Requirements served:** R3, R5

**Behavior:**
- The dialog never exceeds the viewport; the pane list is the only scrolling
  region; header (title + device label), the live note, and the footer buttons
  stay outside the scroll region; backdrop click, Escape, focus trap, body
  scroll-lock, and all testids (`recovery-offer-panel`, `recovery-decline`,
  `recovery-accept`, `recovery-live-note`) behave exactly as today.

**Files:**
- Modify: `src/components/RecoveryOfferPanel.tsx` — dialog div gains
  `max-h-[80vh] flex flex-col`; the `<ul>` gains `overflow-y-auto flex-1
  min-h-0` (keep its existing `mt-3 ... space-y-1` classes). Mirror the
  `DeadSessionPanel.tsx` structure (:55/:62) exactly: title/`<p>` outside, one
  scrolling `<ul>`, footer outside.
- Test: `test/unit/client/components/RecoveryOfferPanel.test.tsx` — add
  structural assertions (below).

**Interfaces:**
- Consumes/produces nothing new (pure presentational change).

**Test cases:**
- Inventory with many panes renders every `<li>` (no truncation), the `<ul>`
  carries `overflow-y-auto flex-1 min-h-0`, the dialog (`role="dialog"`)
  carries `max-h-[80vh] flex flex-col`.
- `recovery-decline` and `recovery-accept` are NOT descendants of the
  scrolling `<ul>` (reachable without scrolling within it).
- Existing 10 tests in the file keep passing (scroll-lock, focus trap,
  backdrop, Escape, accept/decline flows).

- [ ] **Step 1: Write the failing behavioral test**

Add the structural test to `RecoveryOfferPanel.test.tsx` (pattern: render with
a fabricated multi-pane inventory via the existing `api.get` mock approach in
that file; query `screen.getByRole('dialog')` and its `<ul>`; assert classes
and non-descendance of the buttons).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/RecoveryOfferPanel.test.tsx`
Expected: FAIL — the dialog lacks `max-h-[80vh]`/scroll classes today (no
other failure reason).

- [ ] **Step 3: Add the minimal production implementation**

Apply the two class changes in `RecoveryOfferPanel.tsx`.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/RecoveryOfferPanel.test.tsx test/unit/client/components/RecoveryOfferPanel.persisted-boot.test.tsx`
Expected: PASS

- [ ] **Step 5: Refactor while green**

None expected beyond matching the DeadSessionPanel pattern verbatim; confirm
no other modal regression via the same file's suite.

- [ ] **Step 6: Run broader verification**

Run: `npm run test:vitest -- run test/unit/client`
Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add src/components/RecoveryOfferPanel.tsx test/unit/client/components/RecoveryOfferPanel.test.tsx
git commit -m "fix(client): make recovery offer dialog fit small viewports with internal scroll"
```

### Task 3: E2E — pin suppression-while-connected and phone-viewport containment

**Requirements served:** R1, R2, R3, R5

**Behavior (both scenarios join the serial
`test/e2e-browser/specs/recover-my-panes-rust.spec.ts`, owning the same
RustServer, appended after scenario 3):**

- **Scenario 4 (R1 pin):** context A boots, creates a tab containing a
  UNIQUE needle record (use browser-pane URL `https://example.org` — never
  used elsewhere in this file) and waits for a snapshot generation containing
  it (`waitForSnapshotContaining`). A STAYS OPEN. Fresh context B boots with a
  response listener capturing the `GET /api/recovery/inventory` response:
  assert HTTP 200 AND `recoverable === false` AND the panel never appears
  (`toHaveCount(0)` evaluated only after the captured response resolved —
  bounded wait, no blind retry). Then close B AND close A (the suite's
  no-overlapping-contexts invariant: the gate suppresses offers while ANY
  other client is connected, so both must be gone); poll the endpoint with an
  authed probe (`page.request.get` of
  `/api/recovery/inventory?clientInstanceId=probe-s4&bootAgoMs=0`) until
  `recoverable === true` (30s budget — teardown may lag the close); finally
  boot fresh context C and REQUIRE the panel (reuse
  `openFreshContextWithOffer`), decline it, close C. This proves suppression
  was connectedness, not data loss, and R2's re-appearance.
- **Teardown-lag guard (applies wherever a required offer follows a context
  close with NO server restart):** after `ctxC.close()` (end of scenario 2)
  before scenario 3's context-D boot, and after `ctxD.close()` before context
  E's boot, and before scenario 5's phone boot, poll the probe endpoint until
  `recoverable === true` (30s). Reuse one file-local helper
  (e.g. `waitForRecoverable`). Restart-based transitions (scenario 1) need no
  guard — restart clears the set. Scenarios 1–3 keep every existing assertion
  byte-identical; the guard additions are wait-only.
- **Scenario 5 (R3 pin):** a populating context creates 20 tabs (the pane
  records may be plain picker tabs — pickers are snapshotted records per
  SESSION-05 evidence) using the UI control
  `getByRole('button', { name: 'New shell tab' })` (idiom donor:
  `automation-layout-rust.spec.ts:143`; tab-count progress observable via
  `harness.getTabCount()`), then wait for persistence with a records-count
  fs-poll (newest generation for that context's client has ≥ 20 records —
  read the JSON gen files like `waitForSnapshotContaining` does). Close the
  context. Boot a fresh context with
  `browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } })`:
  panel visible; dialog bounding box fits within 390x844; the `<ul>` has
  `scrollHeight > clientHeight` (internal scrolling exists — with a footer
  outside it, the buttons' bounding boxes lie inside the viewport); clicking
  `recovery-decline` succeeds (Playwright actionability = real reachability,
  this is the user-level phone proof).
- No changes to the shared auto-decline watcher (it stays correct: offers in
  other specs either still occur when nothing else is connected, or are
  legitimately suppressed — the watcher is tolerant either way).
- Verified-by-reading (load-bearing stage): no hard offer assertions exist
  while another context is connected anywhere in the suite (recover scenarios
  1–3 all close each context before the next boots;
  `sidebar-registry-sync-rust` case-d closes its context before
  restartAbrupt; all other consumers use tolerant declines). If Task 3's
  implementer finds this changed, adapt per R2's precedence: existing
  semantics win, report the conflict back instead of weakening assertions.

**Files:**
- Modify: `test/e2e-browser/specs/recover-my-panes-rust.spec.ts` (append
  scenarios, reuse its helpers; add a records-count fs poll helper local to
  the file).

**Interfaces:**
- Consumes: `openFreshContextWithOffer`, `waitForSnapshotContaining`,
  `FRESH_CONTEXT_OPTIONS`, `connect`, `traceInventoryFailures` (same file).
- Produces: scenario 4 + 5; nothing exported.

**Test cases:**
- Connected context open ⇒ `recoverable:false`, no panel (R1).
- Same content after disconnect ⇒ `recoverable:true`, panel appears (R2).
- 390x844 viewport with 20+ panes ⇒ dialog within viewport, list scrolls
  internally, decline clickable (R3).

- [ ] **Step 1: Write the failing behavioral test**

Write scenarios 4 and 5 in full.

- [ ] **Step 2: Run the test and verify the intended failure**

Run (from the worktree):
`npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/recover-my-panes-rust.spec.ts -g "scenario 4"`
Expected: FAIL — scenario 4's response assertion sees `recoverable:true`
(gate absent), proving the test observes the missing behavior. Scenario 5's
containment assertions likewise fail on the uncapped dialog.

- [ ] **Step 3: Add the minimal production implementation**

None — production changes landed in Tasks 1–2; if Task 3 runs first
(task-order independent), scenarios are red until those land. Run after Tasks
1 and 2.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/recover-my-panes-rust.spec.ts`
Expected: PASS — all five scenarios (budget: up to 600s for the cold release
build, scenarios ~2-4 min each).

- [ ] **Step 5: Refactor while green**

Keep helpers file-local; match the file's existing comment/donor-citation
conventions.

- [ ] **Step 6: Run broader verification**

Run: `npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/sidebar-registry-sync-rust.spec.ts test/e2e-browser/specs/sidebar-remote-status-rings-rust.spec.ts`
Expected: PASS (the other specs with recovery-offer entanglement).

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/recover-my-panes-rust.spec.ts
git commit -m "test(e2e): pin recovery-offer suppression while connected and phone-viewport containment"
```

### Task 4: Final verification of the whole delta

**Requirements served:** R5

- [ ] Run, in the worktree on the FINAL committed HEAD, and record receipts
  (command, commit, exit code, counts) in the execution ledger:
  1. `npm run check` (typecheck + coordinated full vitest suite) — PASS
  2. `cargo test -p freshell-server -p freshell-ws` — PASS
  3. `cargo clippy -p freshell-server -p freshell-ws -- -D warnings` — PASS
  4. `npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/recover-my-panes-rust.spec.ts` — PASS (5 scenarios)
  5. `npm run lint` (a11y gate on changed client file) — PASS
- [ ] Docs decisions recorded in the ledger: `docs/index.html` not updated
  (internal recovery dialog, not part of the default-experience mock — repo
  rule requires mock updates only for major user-facing changes);
  `docs/plans/2026-07-26-recover-my-panes.md` residual updated in Task 1.
  Commit only if the ledger lives in the worktree (it does not — receipts are
  recorded in the run logs; no commit expected for this task unless code
  changes are required).

## Notes / deliberate trade-offs (recorded, not blocking)

- A momentarily-disconnected OTHER client (mid-reconnect, pre-first-push) can
  briefly allow an offer; dismissal is deduped by contentId. Residual of the
  socket-truthful design chosen over time-based heuristics (time heuristics
  were rejected: the durable registry survives restarts and its 30-min TTL
  would suppress legitimate offers minutes after a crash).
- ledgerOnly is gated together with unions (the incident's wall was mostly
  301 stale ledger rows). The 30-day ledger-row pile and never-aging stale
  device dirs are separate cleanup opportunities, recorded as out-of-scope
  findings — not addressed here.
- Cross-device offers (recover the laptop's layout from the desktop) cease to
  exist as an interruption; that was the documented "over-offer" the user
  rejected. Sidebar rings remain the cross-device awareness surface.
