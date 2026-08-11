# Remote Status Rings Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

**Goal:** A session row in the left panel (Sidebar) that would look green ("open") or blue ("busy") on a *different* device shows a matching green/blue ring around its icon on this device — only when the session is not open on this device.

**Architecture:** Every client already pushes its open-tab registry snapshot every 5s (`tabs.sync.push`); each device now stamps each pane snapshot's opaque payload with `activity: 'busy'` when that pane is busy per the existing `resolvePaneActivity` logic (the same source as the local blue icon). Consumers derive per-session remote state from `state.tabRegistry.remoteOpen` (any busy pane → blue ring; otherwise referenced → green ring), gated on the session not being open locally (`hasTab === false`). A new periodic `tabs.sync.query` (30s) keeps remote snapshots fresh while connected. No server schema change: pane `payload` is a pass-through `z.record` on Node and (verified in Stage 2) the Rust server.

**Tech Stack:** React 18, Redux Toolkit, Tailwind CSS, Vitest + Testing Library, Playwright (e2e against the Rust server).

## Global Constraints

- Work happens only in this worktree (`.worktrees/remote-status-rings`, branch `the-usual/remote-status-rings`). Never touch the live self-hosted server (port 3001).
- Red-Green-Refactor TDD: every production change starts from a failing test run and ends green.
- Unit AND e2e coverage of new behavior (repo philosophy).
- Focused tests use `npm run test:vitest -- run <paths>` (default config covers `test/unit`; add `--config config/vitest/vitest.server.config.ts` for `test/server` / `test/integration/server`). Raw `npx vitest` is not a coordinated workflow.
- Broad runs: `npm run check` (typecheck + coordinated full suite) — must wait for the coordinator gate if held.
- Server code uses NodeNext/ESM: relative imports in `server/`/`shared/` need `.js` extensions. Client code uses `@/` alias without extensions.
- A11y: color-only cues need a non-color carrier (`data-*` attribute + tooltip/sr-only text). No lint regressions (`npm run lint`).
- No Rust code change in this plan; the Rust server must pass the new payload field through untouched (Stage 2 validated; e2e pins it).
- Commits are focused, conventional-message, and never include log files under `.worktrees/.the-usual-logs/`.

## Requirements

- **R1 — Outcome (green ring):** When a session entry would render a green icon on a different device (i.e. the session is open in a tab there) and the session is *not* open on this device, the entry's icon gets a green circle ring on this device.
- **R2 — Outcome (blue ring):** When a session entry would render a blue icon on a different device (i.e. any of its remotely-open panes is busy) and the session is *not* open on this device, the entry's icon gets a blue circle ring. Blue wins over green when both apply (mirrors local `blue > green` precedence).
- **R3 — Constraint (local wins):** A session open on this device never shows a remote ring; existing solid local coloring (blue busy / green open / grey) is unchanged. Multiple local windows of the *same* device (`sameDeviceOpen`) do not count as "a different device".
- **R4 — Outcome (liveness):** Ring state reflects remote churn while all clients stay connected — no reconnect or reload required. Producer pushes busy/idle transitions within the existing 5s sync tick; consumers re-query remote snapshots on a 30s interval (previously only on WS ready/reconnect).
- **R5 — Constraint (compatibility):** The new per-pane `payload.activity` field round-trips through both the Node and Rust servers (validate → store → query reply) with zero server code changes; the existing full test suite and sidebar render-stability contracts stay green.

---

### Task 1: Producer — stamp per-pane `activity: 'busy'` into pushed registry records

**Requirements served:** R2, R4, R5

**Behavior:**
- When this device builds its open-tab registry records (existing 5s push in `startTabRegistrySync`), each leaf pane snapshot's `payload` gains `activity: 'busy'` iff that pane is busy according to the existing `resolvePaneActivity` logic (same inputs the Sidebar uses for its blue icon). Non-busy panes omit the key (payload keeps current shape otherwise; `undefined` values are already dropped by JSON serialization and by `stripUndefinedValues` downstream).
- Closed/tombstone records are never stamped (consumers only read `remoteOpen`; keeping tombstone payloads untouched avoids confusion).
- Because `recordFingerprint` (`tabRegistrySync.ts:130-139`) and the push dedupe (`pushNow`, `:329-331`) both include `panes`, a busy→idle or idle→busy transition changes the fingerprint and ships on the next 5s tick.

**Files:**
- Modify: `src/lib/pane-activity.ts` — add exported `collectBusyPaneIds(input): Set<string>` (same input record as `collectBusySessionKeys` at `:311-383`: `{ tabs, paneLayouts, codexActivityByTerminalId, claudeActivityByTerminalId, amplifierActivityByTerminalId, opencodeActivityByTerminalId, paneRuntimeActivityByPaneId, freshAgentSessions }`), walking every tab's pane tree with the existing `resolvePaneActivity` and returning the set of busy pane ids.
- Modify: `src/lib/tab-registry-snapshot.ts` — `collectPaneSnapshots(node, serverInstanceId, paneTitles?, busyPaneIds?)` (:76-94) and `stripPanePayload(content, serverInstanceId, busy?)` (:15-74): when `busy === true`, include `activity: 'busy'` in the returned payload (applies to all pane kinds uniformly; sessions are matched consumer-side via `sessionRef`).
- Modify: `src/store/tabRegistrySync.ts` — `buildRecords` (:176-231) computes `busyPaneIds` once per call from the same state slices (`state.codexActivity?.byTerminalId`, `state.claudeActivity?.byTerminalId`, `state.amplifierActivity?.byTerminalId`, `state.opencodeActivity?.byTerminalId`, `state.paneRuntimeActivity?.byPaneId`, `state.freshAgent?.sessions`) and passes it through `buildOpenTabRegistryRecord` → `collectPaneSnapshots`. Add an optional `busyPaneIds?: ReadonlySet<string>` field to `SnapshotRecordInput` in `tab-registry-snapshot.ts` and forward it. `buildClosedTabRegistryRecord` is not passed the set.
- Test: `test/unit/client/lib/pane-activity.test.ts`, `test/unit/client/lib/tab-registry-snapshot.test.ts`, `test/unit/client/store/tabRegistrySync.test.ts`

**Interfaces:**
- Consumes: `resolvePaneActivity` (`src/lib/pane-activity.ts:117-205`), existing `collectBusySessionKeys` input shape, `RegistryPaneSnapshot.payload` (`Record<string, unknown>` free-form, `server/tabs-registry/types.ts:49-54`).
- Produces:
  - `collectBusyPaneIds(input: {...same as collectBusySessionKeys}): Set<PaneId>` (pane-activity.ts)
  - `stripPanePayload(content: PaneContent, serverInstanceId: string, busy?: boolean): Record<string, unknown>` — adds `activity?: 'busy'`
  - `collectPaneSnapshots(node, serverInstanceId, paneTitles?, busyPaneIds?: ReadonlySet<string>)`
  - `SnapshotRecordInput.busyPaneIds?: ReadonlySet<string>`
  - Pushed wire shape per pane: `{ ..., payload: { ..., activity?: 'busy' } }`

**Test cases:**
- `collectBusyPaneIds`: a tab containing one terminal pane whose codex/claude activity record has `phase === 'busy'` → set contains that paneId; a second idle pane in the same tab → absent. Empty tabs → empty set.
- `collectPaneSnapshots` with `busyPaneIds = new Set(['p1'])` → pane `p1` payload has `activity: 'busy'`; pane `p2` payload has no `activity` key.
- `buildOpenTabRegistryRecord` with `busyPaneIds` → pane payloads stamped; `buildClosedTabRegistryRecord` never stamps even if given a busy set (verify by NOT passing it: the function's signature stays without the field — assert closed record panes have no `activity` when built through `buildRecords` with busy panes present in a different open tab... simplest: assert `buildClosedTabRegistryRecord` output panes lack `activity`).
- `tabRegistrySync` (existing harness): with a busy pane in state, the records passed to `sendTabsSyncPush` contain `panes[].payload.activity === 'busy'`; after the pane goes idle, a subsequent tick pushes again (payload key removed → fingerprint changed).

- [ ] **Step 1: Write the failing behavioral test**

In `test/unit/client/lib/tab-registry-snapshot.test.ts` add: build an open record for a tab whose layout has terminal pane `p1` and pass `busyPaneIds: new Set(['p1'])`; assert `record.panes[0].payload.activity === 'busy'` and a second unlisted pane's payload lacks the key. In `test/unit/client/lib/pane-activity.test.ts` add a `collectBusyPaneIds` describe mirroring the existing `collectBusySessionKeys` fixtures: busy codex terminal pane → paneId in set; idle pane → not in set; fresh-agent busy (status `running` with live session) → in set; waiting-for-approval (pendingPermissions non-empty) → NOT in set.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/lib/tab-registry-snapshot.test.ts test/unit/client/lib/pane-activity.test.ts`

Expected: FAIL because `collectBusyPaneIds` is not exported and `payload.activity` is never stamped (missing behavior, not setup errors).

- [ ] **Step 3: Add the minimal production implementation**

Add `collectBusyPaneIds` in `src/lib/pane-activity.ts` (share the pane-walk with `collectBusySessionKeys` — extract the walk so both build on it; keep `collectBusySessionKeys` behavior identical). Thread `busyPaneIds` through `collectPaneSnapshots`/`stripPanePayload` in `tab-registry-snapshot.ts`. In `tabRegistrySync.ts` `buildRecords`, compute the set once and pass it into `buildOpenTabRegistryRecord` only.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/lib/tab-registry-snapshot.test.ts test/unit/client/lib/pane-activity.test.ts test/unit/client/store/tabRegistrySync.test.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Deduplicate the pane-tree walk between `collectBusyPaneIds` and `collectBusySessionKeys` if the initial implementation copied it; confirm no behavior change in the existing busy-session tests.

- [ ] **Step 6: Run broader verification**

Run: `npm run test:vitest -- run test/unit/client/store/tabRegistrySlice.test.ts test/unit/client/lib/tab-registry-open.test.ts`

Expected: PASS (registry neighbors unaffected).

- [ ] **Step 7: Commit the task**

```bash
git add src/lib/pane-activity.ts src/lib/tab-registry-snapshot.ts src/store/tabRegistrySync.ts test/unit/client/lib/pane-activity.test.ts test/unit/client/lib/tab-registry-snapshot.test.ts test/unit/client/store/tabRegistrySync.test.ts
git commit -m "feat(tabs-registry): stamp per-pane busy activity into pushed snapshots"
```

---

### Task 2: Freshness — periodic remote re-query (30s) in the registry sync loop

**Requirements served:** R4, R1, R2

**Behavior:**
- `startTabRegistrySync` additionally sends `tabs.sync.query` on a fixed 30s interval (new exported constant `QUERY_INTERVAL_MS = 30_000`) so `remoteOpen` stays fresh while connected. Existing query triggers (WS `ready`, reconnect, retention-days change, startup) are unchanged.
- Queries respect the existing guards: no send when `ws.state !== 'ready'`; lease-unsettled queries queue once via `queuedQuery`; the existing `latestQueryRequestId`/`pendingRequests` single-flight logic (`:294-312`, `:440-459`) dedupes replies unchanged.
- The interval is cleared by the returned teardown function.

**Files:**
- Modify: `src/store/tabRegistrySync.ts:20-22` (constant), `:472-477` (add interval beside the push interval), `:525-537` (clear in teardown)
- Test: `test/unit/client/store/tabRegistrySync.test.ts`

**Interfaces:**
- Consumes: existing `querySnapshot` closure (:294-312), `SYNC_INTERVAL_MS`/`HEARTBEAT_INTERVAL_MS` pattern (:20-21, :472-477).
- Produces: `export const QUERY_INTERVAL_MS = 30_000` from `src/store/tabRegistrySync.ts`.

**Test cases:**
- Fake timers, ws ready: advancing 30s sends exactly one additional `tabs.sync.query`; advancing 60s sends two total.
- ws not ready (`ws.state !== 'ready'`): advancing interval sends nothing.
- Teardown: after calling the returned dispose, advancing time sends no further queries.
- Existing ready/reconnect query behavior still passes (regression).

- [ ] **Step 1: Write the failing behavioral test**

In `tabRegistrySync.test.ts` (existing fake-timer harness): start the sync loop with a ready ws double, clear the boot-time `querySnapshot` call count, advance `QUERY_INTERVAL_MS` (import the new constant), assert `sendTabsSyncQuery` called exactly once.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/store/tabRegistrySync.test.ts`

Expected: FAIL because no query interval exists (no `tabs.sync.query` is sent on a timer; `QUERY_INTERVAL_MS` is not exported).

- [ ] **Step 3: Add the minimal production implementation**

Add `export const QUERY_INTERVAL_MS = 30_000` beside `SYNC_INTERVAL_MS`; add `const queryInterval = globalThis.setInterval(() => { querySnapshot() }, QUERY_INTERVAL_MS)` beside the push interval; clear it in the teardown return.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/store/tabRegistrySync.test.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

None planned — three-line change. If interval setup/teardown lines grew, mirror the existing heartbeat structure rather than introducing new mechanics.

- [ ] **Step 6: Run broader verification**

Run: `npm run test:vitest -- run test/unit/client/store/`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add src/store/tabRegistrySync.ts test/unit/client/store/tabRegistrySync.test.ts
git commit -m "feat(tabs-registry): re-query remote snapshots on a 30s interval"
```

---

### Task 3: Selector — per-session remote activity (`'busy' | 'open'`) from `remoteOpen`

**Requirements served:** R1, R2, R3

**Behavior:**
- New pure function `deriveRemoteSessionActivity(remoteOpen: RegistryTabRecord[]): Record<string, 'busy' | 'open'>` and memoized `selectRemoteSessionActivity(state: RootState)` built on it.
- For each remote record and each pane with a string-typed `payload.sessionRef` object containing non-empty `provider` and `sessionId` strings, map key `${provider}:${sessionId}` → `'open'`; if the pane's `payload.activity === 'busy'`, upgrade the key to `'busy'`. `'busy'` always wins over `'open'` across panes and across records (R2 precedence). Panes without a well-formed `sessionRef` are ignored. Empty/missing `remoteOpen` → `{}`.
- Input is only `state.tabRegistry.remoteOpen`, so same-device windows (`sameDeviceOpen`) and own-window records can never contribute (R3, server partition at `server/tabs-registry/store.ts:1240-1296`).

**Files:**
- Modify: `src/store/selectors/tabsRegistrySelectors.ts` (add export; `selectRemoteOpen` already exists at :40)
- Test: `test/unit/client/store/tabsRegistrySelectors.test.ts` (create; the existing `tabRegistrySlice.test.ts` keeps slice concerns)

**Interfaces:**
- Consumes: `RegistryTabRecord` (`@/store/tabRegistryTypes`), `selectRemoteOpen`.
- Produces:
  - `deriveRemoteSessionActivity(remoteOpen: RegistryTabRecord[] | undefined): Record<string, 'busy' | 'open'>`
  - `selectRemoteSessionActivity: (state: RootState) => Record<string, 'busy' | 'open'>` (createSelector on `selectRemoteOpen`; output reference stable between ingests so Sidebar's `useAppSelector(...)` doesn't churn)

**Test cases:**
- One remote record, terminal pane with `sessionRef {provider:'claude', sessionId:'s1'}`, no activity → `{ 'claude:s1': 'open' }`.
- Same but `payload.activity: 'busy'` → `{ 'claude:s1': 'busy' }`.
- Two records from two devices referencing the same session, one busy one not → `'busy'` (cross-device precedence).
- One record with both a busy pane and an idle pane referencing the same session → `'busy'`.
- Pane with missing/partial `sessionRef` (no provider, or empty sessionId) → key absent.
- `undefined`/empty input → `{}`.
- Pane with `activity: 'something-else'` (future value) → treated as open, not busy.

- [ ] **Step 1: Write the failing behavioral test**

Create `test/unit/client/store/tabsRegistrySelectors.test.ts` with the cases above, importing `deriveRemoteSessionActivity`/`selectRemoteSessionActivity`. Build minimal `RegistryTabRecord` literals via the existing test's record-fixture style (see `tabRegistrySlice.test.ts`).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/store/tabsRegistrySelectors.test.ts`

Expected: FAIL because both exports do not exist.

- [ ] **Step 3: Add the minimal production implementation**

Implement `deriveRemoteSessionActivity` (iterate records → panes → read `payload.sessionRef`/`payload.activity` defensively, fold with busy-wins) and `selectRemoteSessionActivity = createSelector([selectRemoteOpen], deriveRemoteSessionActivity)`.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/store/tabsRegistrySelectors.test.ts test/unit/client/store/tabRegistrySlice.test.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Extract the defensive `sessionRef` reader only if it reads cleanly; otherwise keep a single local helper inside the selectors file. No shared util unless a second consumer appears.

- [ ] **Step 6: Run broader verification**

Run: `npm run test:vitest -- run test/unit/client/store/`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add src/store/selectors/tabsRegistrySelectors.ts test/unit/client/store/tabsRegistrySelectors.test.ts
git commit -m "feat(sidebar): derive per-session remote activity from registry remoteOpen"
```

---

### Task 4: Sidebar rendering — ring around the icon, gated on not-open-locally

**Requirements served:** R1, R2, R3

**Behavior:**
- `SidebarItem` gains optional prop `remoteStatus?: 'busy' | 'open'`. When set, the existing `relative` icon wrapper (`Sidebar.tsx:1000`) additionally renders an absolutely positioned circular ring: `<span aria-hidden="true" className={cn('pointer-events-none absolute -inset-[3px] rounded-full border', remoteStatus === 'busy' ? 'border-blue-500' : 'border-success')} />`. Icon glyph/colors are unchanged (grey when not open locally — the only state where a ring can appear).
- The row button gains `data-remote-status={remoteStatus}` only when set (attribute absent otherwise, so existing e2e `data-*` pins don't churn).
- Non-color carriers (a11y): the tooltip gains a line `Busy on another device` / `Open on another device`, and the button content gains `<span className="sr-only">(busy on another device)</span>` / `(open on another device)` next to the title.
- `Sidebar` computes `remoteActivityBySessionKey` via `useAppSelector(selectRemoteSessionActivity)` and passes `remoteStatus={item.hasTab ? undefined : remoteActivityBySessionKey[sessionKey]}` at `:891-898` (R3 gate).
- `areSidebarItemPropsEqual` (:949-973) compares `remoteStatus` or rings freeze. `isSessionItemEqual` (:135-158) is intentionally untouched (state arrives as a prop, matching the existing `isBusy` pattern).

**Files:**
- Modify: `src/components/Sidebar.tsx` (:935-943 props, :949-973 comparator, :975-1008 item render + ring + sr-only, :889-898 wiring, tooltip :1038-1041)
- Test: `test/unit/client/components/SidebarItem.remote-status.test.tsx` (create), `test/unit/client/components/Sidebar.test.tsx` (gate case), keep `Sidebar.dom-stability.test.tsx` / `Sidebar.render-stability.test.tsx` green.

**Interfaces:**
- Consumes: `selectRemoteSessionActivity` (Task 3), existing `SidebarItem`/`busySessionKeySet` patterns.
- Produces: `SidebarItemProps.remoteStatus?: 'busy' | 'open'`; DOM contract `data-remote-status="busy"|"open"` (absent when no ring).

**Test cases:**
- `remoteStatus="busy"` + `hasTab: false` → ring span present with `border-blue-500`; button has `data-remote-status="busy"`; sr-only text present; icon keeps `text-muted-foreground`.
- `remoteStatus="open"` → `border-success` ring + `data-remote-status="open"`.
- No `remoteStatus` → no ring span, no `data-remote-status` attribute.
- Full `Sidebar` with `tabRegistry.remoteOpen` seeded (busy sessionRef) and the session NOT open locally → row shows `data-remote-status="busy"`; same seed but session open locally (`hasTab`) → attribute absent (R3 gate).
- Memo: re-render with only `remoteStatus` changing updates the DOM (guards the comparator edit).

- [ ] **Step 1: Write the failing behavioral test**

Create `SidebarItem.remote-status.test.tsx` copying the `renderSidebarItem` harness from `SidebarItem.running-state.test.tsx`; add the ring/data-attribute cases above. Add the gate case to `Sidebar.test.tsx` using its existing full-Sidebar store harness (seed `tabRegistry.remoteOpen` directly in the preloaded state).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/SidebarItem.remote-status.test.tsx test/unit/client/components/Sidebar.test.tsx`

Expected: FAIL because `remoteStatus` prop/ring/`data-remote-status` do not exist and the selector is not wired (missing behavior, not harness errors).

- [ ] **Step 3: Add the minimal production implementation**

Implement the prop, ring span, sr-only/tooltip text, `data-remote-status`, selector wiring with `hasTab` gate, and the comparator line, exactly per Behavior above.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/SidebarItem.remote-status.test.tsx test/unit/client/components/Sidebar.test.tsx`

Expected: PASS

- [ ] **Step 5: Refactor while green**

If the ring JSX or copy strings duplicate, lift tiny local constants (e.g. `REMOTE_STATUS_COPY`) inside `Sidebar.tsx`; no new components.

- [ ] **Step 6: Run broader verification**

Run: `npm run test:vitest -- run test/unit/client/components/ && npm run lint`

Expected: PASS (including `Sidebar.dom-stability`, `Sidebar.render-stability`, `Sidebar.mobile`, `Sidebar.perf-audit`; no new a11y lint violations).

- [ ] **Step 7: Commit the task**

```bash
git add src/components/Sidebar.tsx test/unit/client/components/SidebarItem.remote-status.test.tsx test/unit/client/components/Sidebar.test.tsx
git commit -m "feat(sidebar): remote status rings for sessions open or busy on other devices"
```

---

### Task 5: E2E pin + documentation

**Requirements served:** R1, R2, R5

**Behavior:**
- End-to-end against the real Rust server: a second raw-WS device pushes a `tabs.sync.push` snapshot whose terminal pane payload references a seeded session (`sessionRef`) with `activity: 'busy'`; after the browser page (re)loads — which triggers the query-on-`ready` consumer path — the sidebar row for that session shows `data-remote-status="busy"`. A follow-up push without `activity` + reload flips the row to `data-remote-status="open"`. A push whose records don't reference the session + reload removes the attribute. This pins Rust payload passthrough (R5) and both ring colors (R1, R2) through the real WS/store/selector/render chain.
- `AGENTS.md` "Agent Status Indicators" paragraph gains one sentence documenting the sidebar rings (green = open on another device, blue = busy on another device, only when not open locally).
- Note recorded in the plan (decided during planning): `docs/index.html`'s sidebar mock renders monochrome provider icons with no per-entry status colors, so no mock change (repo rule requires updating it only for major UI shifts).

**Files:**
- Create: `test/e2e-browser/specs/sidebar-remote-status-rings-rust.spec.ts`
- Modify: `AGENTS.md` (one sentence in the Agent Status Indicators pattern paragraph)

**Interfaces:**
- Consumes: `RustServer` + `ensureRustServerBuilt` + `TestHarness` e2e helpers (copy the boot/seed patterns verbatim from `test/e2e-browser/specs/sidebar-registry-sync-rust.spec.ts`, per that suite's per-spec-ownership convention); WS handshake (`hello` with token → `ready`) and `tabs.sync.push`/`tabs.sync.query` shapes from `shared/ws-protocol.ts:961-993`; seeded Claude session via the same `~/.claude` seeding approach the reference spec uses.
- Producer stamping (Task 1) and selector (Task 3) are exercised by their unit tests; the e2e's raw-WS second device hand-builds its push payload (that's what a real second client sends on the wire — the server contract under test is passthrough).

**Test cases:**
- Baseline: seeded session row has no `data-remote-status`.
- After remote busy push + reload: row has `data-remote-status="busy"` and a `border-blue-500` ring element.
- After remote non-busy push + reload: `data-remote-status="open"` with `border-success` ring.
- After remote push without the session + reload: attribute absent.

- [ ] **Step 1: Write the failing behavioral test**

Author the spec: ephemeral-port `RustServer`; seed one Claude session; connect the page (device A) via `bootAndConnect`; open a raw WS (device B, distinct `deviceId`) in the spec process, complete the handshake, and push crafted records; reload page A and assert the row's `data-remote-status` transitions across the four cases above.

- [ ] **Step 2: Run the newly authored spec**

Run: `npm run test:e2e:chromium -- test/e2e-browser/specs/sidebar-remote-status-rings-rust.spec.ts`

Expected: this pin is authored after Tasks 1-4 land, so the intended outcome is PASS — its RED heritage comes from the Task 1/3/4 unit failures it now locks in. If it FAILs here, that failure is meaningful: either the wire/selector/render chain is broken, or the Rust server does not pass `payload.activity` through (an R5 violation). Root-cause any failure; never loosen the assertions to force green.

- [ ] **Step 3: Add the minimal production implementation**

No new production code beyond Tasks 1-4; this task fixes only integration-level gaps the e2e exposes (expected: none; if the Rust server drops the field, that is a plan-level escalation back to the coordinator, not a local patch).

- [ ] **Step 4: Run the focused test**

Run: `npm run test:e2e:chromium -- test/e2e-browser/specs/sidebar-remote-status-rings-rust.spec.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Keep spec helpers copy-local per the suite convention; trim any dead setup copied from the reference spec.

- [ ] **Step 6: Run broader verification**

Run: `npm run check` (typecheck + coordinated full suite; wait for the coordinator gate) and re-run the e2e spec once after it.

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/sidebar-remote-status-rings-rust.spec.ts AGENTS.md
git commit -m "test(e2e): pin cross-device sidebar status rings through the Rust server"
```

---

## Verification matrix

| Requirement | Primary evidence | Additional |
|---|---|---|
| R1 | Task 3 selector cases; Task 4 open-ring unit + gate cases | Task 5 e2e open case |
| R2 | Task 1 stamping cases; Task 3 busy cases; Task 4 busy-ring cases | Task 5 e2e busy case |
| R3 | Task 4 hasTab-gate full-Sidebar case; Task 3 input-partition design | — |
| R4 | Task 1 fingerprint-change push case; Task 2 interval cases | — |
| R5 | Task 5 e2e against Rust server; Task 1/4 regression suites | `npm run check` |
