# Remote Status Rings Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

**Goal:** A session row in the left panel (Sidebar) that would look green ("open") or blue ("busy") on a *different* device shows a matching green/blue ring around its icon on this device — only when the session is not open on this device.

**Architecture:** Every client already pushes its open-tab registry snapshot every 5s (`tabs.sync.push`); each device now stamps each pane snapshot's opaque payload with `sessionKeys: string[]` (the canonical `provider:sessionId` identities, resolved by the exact same rules the local sidebar uses for its green/`hasTab` join) and `activity: 'busy'` when that pane is busy per the existing `resolvePaneActivity` logic (the same source as the local blue icon). Consumers derive per-session remote state from `state.tabRegistry.remoteOpen` (any busy pane → blue ring; otherwise referenced → green ring; legacy `sessionRef`-only snapshots still work via fallback), suppressed whenever the session is open on this device — in this window (`hasTab`) or another window of the same device (`sameDeviceOpen`). A new periodic `tabs.sync.query` (30s, with bounded single-flight re-send on stale requests) keeps remote snapshots fresh while connected. No server schema change: pane `payload` is a pass-through `z.record` on Node and (verified in Stage 2) the Rust server.

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
- **R3 — Constraint (local wins):** A session open on this device never shows a remote ring; existing solid local coloring (blue busy / green open / grey) is unchanged. "Open on this device" includes *other windows of the same device*: records the server partitions as `sameDeviceOpen` (same `deviceId`, different `clientInstanceId`) suppress the ring exactly like a locally-open tab, and never count as "a different device" that would *produce* a ring.
- **R4 — Outcome (liveness):** Ring state reflects remote churn while all clients stay connected — no reconnect or reload required. Producer pushes busy/idle transitions within the existing 5s sync tick; consumers re-query remote snapshots on a 30s interval (previously only on WS ready/reconnect).
- **R5 — Constraint (compatibility):** The new per-pane `payload.activity` field round-trips through both the Node and Rust servers (validate → store → query reply) with zero server code changes; the existing full test suite and sidebar render-stability contracts stay green.

---

### Task 1: Producer — stamp per-pane `sessionKeys` + `activity: 'busy'` into pushed registry records

**Requirements served:** R1, R2, R4, R5

**Behavior:**
- When this device builds its open-tab registry records (existing 5s push in `startTabRegistrySync`), each leaf pane snapshot's `payload` gains two fields:
  - `sessionKeys: string[]` — the canonical `provider:sessionId` identities for the pane, computed with the **same resolution rules the local sidebar uses** for its green/`hasTab` join (`collectSessionRefsFromTabs` in `src/lib/session-utils.ts:294-305`, which covers `content.sessionRef`, Claude `resumeSessionId`, Codex durability identities, and fresh-agent live-session identity — including the no-pane-`sessionRef` restore gap protected by `test/unit/client/lib/pane-activity.test.ts:242`). Stamping the keys (rather than relying consumer-side on `payload.sessionRef`, which `stripPanePayload` omits for several of those identity paths) makes the remote join exact by construction. Omitted when the pane maps to no session.
  - `activity: 'busy'` — iff that pane is busy according to the existing `resolvePaneActivity` logic (same inputs the Sidebar uses for its blue icon). Non-busy panes omit the key.
- Closed/tombstone records are never stamped with either field (consumers only read `remoteOpen`; keeping tombstone payloads untouched avoids confusion). This prohibition is enforced and tested even when a busy set is supplied to the closed builder (see test cases).
- Because `recordFingerprint` (`tabRegistrySync.ts:130-139`) and the push dedupe (`pushNow`, `:329-331`) both include `panes`, a busy→idle or idle→busy transition changes the fingerprint and ships on the next 5s tick.

**Files:**
- Modify: `src/lib/session-utils.ts` — export a per-pane session-key collector (extract from `collectSessionRefsFromTabs`' leaf logic so there is exactly one identity-resolution implementation; e.g. `collectSessionKeysFromContent(content: PaneContent, tab: Tab, freshAgentSessions?): string[]`).
- Modify: `src/lib/pane-activity.ts` — add exported `collectBusyPaneIds(input): Set<string>` (same input record as `collectBusySessionKeys` at `:311-383`: `{ tabs, paneLayouts, codexActivityByTerminalId, claudeActivityByTerminalId, amplifierActivityByTerminalId, opencodeActivityByTerminalId, paneRuntimeActivityByPaneId, freshAgentSessions }`), walking every tab's pane tree with the existing `resolvePaneActivity` and returning the set of busy pane ids.
- Modify: `src/lib/tab-registry-snapshot.ts` — `collectPaneSnapshots` (:76-94) gains an optional per-pane annotation hook argument (e.g. `annotatePayload?: (paneId: string) => { sessionKeys?: string[]; busy?: boolean }`) that `stripPanePayload`-produced payloads are augmented with: `activity: 'busy'` when `busy`, `sessionKeys` when non-empty. Threading via a hook keeps `stripPanePayload`'s per-kind whitelist intact and avoids widening its parameter list twice.
- Modify: `src/lib/tab-registry-snapshot.ts` — `SnapshotRecordInput` gains optional `busyPaneIds?: ReadonlySet<string>` and `paneSessionKeys?: ReadonlyMap<string, string[]>`; `buildOpenTabRegistryRecord` forwards both into the annotation hook.
- Modify: `src/store/tabRegistrySync.ts` — `buildRecords` (:176-231) computes `busyPaneIds` (via `collectBusyPaneIds`) and `paneSessionKeys` (via the new session-utils collector over each tab's layout) once per call from the same state slices (`state.codexActivity?.byTerminalId`, `state.claudeActivity?.byTerminalId`, `state.amplifierActivity?.byTerminalId`, `state.opencodeActivity?.byTerminalId`, `state.paneRuntimeActivity?.byPaneId`, `state.freshAgent?.sessions`) and passes them into `buildOpenTabRegistryRecord` only.
- Test: `test/unit/client/lib/pane-activity.test.ts`, `test/unit/client/lib/tab-registry-snapshot.test.ts`, `test/unit/client/lib/session-utils.test.ts`, `test/unit/client/store/tabRegistrySync.test.ts`

**Interfaces:**
- Consumes: `resolvePaneActivity` (`src/lib/pane-activity.ts:117-205`), the `collectSessionRefsFromTabs` resolution rules (`src/lib/session-utils.ts:294-305`), existing `collectBusySessionKeys` input shape, `RegistryPaneSnapshot.payload` (`Record<string, unknown>` free-form, `server/tabs-registry/types.ts:49-54`).
- Produces:
  - `collectSessionKeysFromContent(content: PaneContent, tab: Tab, freshAgentSessions?): string[]` (session-utils.ts)
  - `collectBusyPaneIds(input: {...same as collectBusySessionKeys}): Set<PaneId>` (pane-activity.ts)
  - `SnapshotRecordInput.busyPaneIds?: ReadonlySet<string>`, `SnapshotRecordInput.paneSessionKeys?: ReadonlyMap<string, string[]>`
  - Pushed wire shape per pane: `{ ..., payload: { ..., sessionKeys?: string[], activity?: 'busy' } }`

**Test cases:**
- `collectBusyPaneIds`: a tab containing one terminal pane whose codex/claude activity record has `phase === 'busy'` → set contains that paneId; a second idle pane in the same tab → absent. Empty tabs → empty set.
- Session-key collector completeness (the R1 identity join): terminal pane with `sessionRef` → its key; terminal pane with NO `sessionRef` but Claude `resumeSessionId` → `claude:<id>` key; Codex durability identity → key; fresh-agent pane with no `content.sessionRef` but a live session in `freshAgent.sessions` (the restore-gap case) → key; shell terminal → no keys (field omitted).
- `collectPaneSnapshots` with the annotation hook → busy pane payload has `activity: 'busy'` and `sessionKeys: ['claude:s1']`; idle pane payload has `sessionKeys` but no `activity`; sessionless pane has neither.
- `buildClosedTabRegistryRecord` given a NONEMPTY `busyPaneIds`/`paneSessionKeys` (pass them deliberately in the test) → closed record panes carry neither `activity` nor `sessionKeys` (the prohibition is behavioral, not "not passed").
- `tabRegistrySync` (existing harness): with a busy pane in state, the records passed to `sendTabsSyncPush` contain `panes[].payload.activity === 'busy'` and `sessionKeys`; after the pane goes idle, a subsequent tick pushes again (`activity` key removed → fingerprint changed).

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
- Queries respect the existing guards: no send when `ws.state !== 'ready'`; lease-unsettled queries queue once via `queuedQuery`.
- **New single-flight discipline** (the existing `querySnapshot` has no in-flight guard — every call allocates another request id): the interval callback skips sending while a query is outstanding (`pendingRequests.size > 0`). A bounded stale-replacement also lives inside `querySnapshot` itself, so every caller benefits: track `lastQuerySentAt`; when a query has been outstanding for longer than `QUERY_STALE_MS = 90_000` (3× interval — server unreachable or reply lost), the next call clears `pendingRequests` and sends a replacement. In-flight memory is therefore bounded to one outstanding request at all times, and a silently dead query channel self-heals within 90s.
- The interval is cleared by the returned teardown function.

**Files:**
- Modify: `src/store/tabRegistrySync.ts:20-22` (constants), `:294-312` (`querySnapshot` in-flight guard + stale replacement), `:472-477` (add interval beside the push interval), `:525-537` (clear in teardown)
- Test: `test/unit/client/store/tabRegistrySync.test.ts`

**Interfaces:**
- Consumes: existing `querySnapshot` closure (:294-312), `SYNC_INTERVAL_MS`/`HEARTBEAT_INTERVAL_MS` pattern (:20-21, :472-477).
- Produces: `export const QUERY_INTERVAL_MS = 30_000` and `export const QUERY_STALE_MS = 90_000` from `src/store/tabRegistrySync.ts`.

**Test cases:**
- Fake timers, ws ready: advancing 30s sends exactly one additional `tabs.sync.query`; with replies arriving, advancing 60s sends two total.
- Outstanding suppression: interval fires while a previous query is still outstanding (no reply) → no second query is sent.
- Stale replacement: with a query outstanding and no reply, advancing past `QUERY_STALE_MS` → a replacement query IS sent, and the old request id no longer accepts a reply (a late reply for the old id is ignored by the existing `latestQueryRequestId` check).
- ws not ready (`ws.state !== 'ready'`): advancing interval sends nothing.
- Teardown: after calling the returned dispose, advancing time sends no further queries.
- Existing ready/reconnect query behavior still passes (regression).

- [ ] **Step 1: Write the failing behavioral test**

In `tabRegistrySync.test.ts` (existing fake-timer harness): start the sync loop with a ready ws double, clear the boot-time `querySnapshot` call count, advance `QUERY_INTERVAL_MS`, assert `sendTabsSyncQuery` called exactly once; then suppress the reply, advance another interval, assert still exactly one total send; advance past `QUERY_STALE_MS`, assert the replacement send.

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

### Task 3: Selector — per-session remote activity (`'busy' | 'open'`) and same-device suppression keys

**Requirements served:** R1, R2, R3

**Behavior:**
- New pure function `deriveRemoteSessionActivity(records: RegistryTabRecord[] | undefined): Record<string, 'busy' | 'open'>`, plus memoized selectors built on it.
- Pane → session keys: read `payload.sessionKeys` when it is an array of non-empty strings (the Task 1 field — the complete identity contract); otherwise fall back to a well-formed single `payload.sessionRef` (`{provider, sessionId}` non-empty strings) so snapshots pushed by older clients still produce green rings. Map each key → `'open'`; if that pane's `payload.activity === 'busy'`, upgrade the key to `'busy'`. `'busy'` always wins over `'open'` across panes and across records (R2 precedence). Panes with no identity are ignored. Empty/missing input → `{}`.
- `selectRemoteSessionActivity = createSelector([selectRemoteOpen], deriveRemoteSessionActivity)` — fed only from `remoteOpen`, so other devices' records alone *produce* rings (R3; server partition at `server/tabs-registry/store.ts:1240-1296`). Output reference stable between snapshot ingests so `useAppSelector` doesn't churn.
- `selectSameDeviceSessionKeys = createSelector([selectSameDeviceOpen], (records) => new Set(Object.keys(deriveRemoteSessionActivity(records))))` — the R3 *suppression* set (other windows of this same device). It suppresses rings; it never produces them.
- Both slice accessors tolerate partial stores: `selectRemoteOpen`/`selectSameDeviceOpen` default via optional-chaining (`state.tabRegistry?.remoteOpen` / `?.sameDeviceOpen`), because several existing Sidebar component harnesses omit the `tabRegistry` reducer entirely — the selector must not throw there.

**Files:**
- Modify: `src/store/selectors/tabsRegistrySelectors.ts` (add exports; make the `selectRemoteOpen` input at :40 and its `sameDeviceOpen` sibling optional-chain tolerant)
- Test: `test/unit/client/store/tabsRegistrySelectors.test.ts` (create; the existing `tabRegistrySlice.test.ts` keeps slice concerns)

**Interfaces:**
- Consumes: `RegistryTabRecord` (`@/store/tabRegistryTypes`), `selectRemoteOpen`.
- Produces:
  - `deriveRemoteSessionActivity(records: RegistryTabRecord[] | undefined): Record<string, 'busy' | 'open'>`
  - `selectRemoteSessionActivity: (state: RootState) => Record<string, 'busy' | 'open'>`
  - `selectSameDeviceSessionKeys: (state: RootState) => Set<string>`

**Test cases:**
- One remote record, terminal pane with `sessionKeys: ['claude:s1']`, no activity → `{ 'claude:s1': 'open' }`.
- Same but `payload.activity: 'busy'` → `{ 'claude:s1': 'busy' }`.
- Legacy record with only `sessionRef {provider:'claude', sessionId:'s1'}` (no `sessionKeys`) → `{ 'claude:s1': 'open' }` (old-client fallback).
- `sessionKeys` present AND `sessionRef` pointing elsewhere → `sessionKeys` wins (array is the complete contract).
- Two records from two devices referencing the same session, one busy one not → `'busy'` (cross-device precedence).
- One record with both a busy pane and an idle pane referencing the same session → `'busy'`.
- One pane with multiple `sessionKeys` → every key mapped (a pane can carry explicit + resume identities).
- Pane with missing/empty `sessionKeys` and missing/partial `sessionRef` → key absent.
- `undefined`/empty input → `{}`; record with `panes` missing entirely → `{}` (defensive, harness fixtures).
- Pane with `activity: 'something-else'` (future value) → treated as open, not busy.
- `selectSameDeviceSessionKeys` over same-device records → Set of keys, including a busy one (suppression ignores busy/open distinction).
- Selectors against a partial store without the `tabRegistry` slice → `{}` / empty Set, no throw.

- [ ] **Step 1: Write the failing behavioral test**

Create `test/unit/client/store/tabsRegistrySelectors.test.ts` with the cases above, importing `deriveRemoteSessionActivity`/`selectRemoteSessionActivity`. Build minimal `RegistryTabRecord` literals via the existing test's record-fixture style (see `tabRegistrySlice.test.ts`).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/store/tabsRegistrySelectors.test.ts`

Expected: FAIL because both exports do not exist.

- [ ] **Step 3: Add the minimal production implementation**

Implement `deriveRemoteSessionActivity` (iterate records → panes → read `payload.sessionKeys` with `sessionRef` fallback, `payload.activity` defensively, fold with busy-wins), wire `selectRemoteSessionActivity` and `selectSameDeviceSessionKeys`, and make the two slice-input accessors optional-chain tolerant.

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
- `Sidebar` computes `remoteActivityBySessionKey` via `useAppSelector(selectRemoteSessionActivity)` and `sameDeviceSessionKeys` via `useAppSelector(selectSameDeviceSessionKeys)`, and passes `remoteStatus={item.hasTab || sameDeviceSessionKeys.has(sessionKey) ? undefined : remoteActivityBySessionKey[sessionKey]}` at `:891-898` (R3 gate: suppress when the session is open in this window via `hasTab`, or in another window of the same device via `sameDeviceOpen`).
- `areSidebarItemPropsEqual` (:949-973) compares `remoteStatus` or rings freeze. `isSessionItemEqual` (:135-158) is intentionally untouched (state arrives as a prop, matching the existing `isBusy` pattern).

**Files:**
- Modify: `src/components/Sidebar.tsx` (:935-943 props, :949-973 comparator, :975-1008 item render + ring + sr-only, :889-898 wiring, tooltip :1038-1041)
- Test: `test/unit/client/components/SidebarItem.remote-status.test.tsx` (create), `test/unit/client/components/Sidebar.test.tsx` (gate case), keep `Sidebar.dom-stability.test.tsx` / `Sidebar.render-stability.test.tsx` green.

**Interfaces:**
- Consumes: `selectRemoteSessionActivity` and `selectSameDeviceSessionKeys` (Task 3), existing `SidebarItem`/`busySessionKeySet` patterns.
- Produces: `SidebarItemProps.remoteStatus?: 'busy' | 'open'`; DOM contract `data-remote-status="busy"|"open"` (absent when no ring).

**Test cases:**
- `remoteStatus="busy"` + `hasTab: false` → ring span present with `border-blue-500`; button has `data-remote-status="busy"`; sr-only text present; icon keeps `text-muted-foreground`.
- `remoteStatus="open"` → `border-success` ring + `data-remote-status="open"`.
- No `remoteStatus` → no ring span, no `data-remote-status` attribute.
- Full `Sidebar` with `tabRegistry.remoteOpen` seeded (busy `sessionKeys`) and the session NOT open locally → row shows `data-remote-status="busy"`; same seed but session open locally (`hasTab`) → attribute absent (R3 gate).
- Combined same-device-plus-remote case: `tabRegistry.sameDeviceOpen` ALSO references the session while a remote device is busy → attribute absent (suppression wins over remote production).
- Partial harness tolerance: existing Sidebar harnesses that omit the `tabRegistry` reducer render unchanged (Step 6 suites stay green without harness edits — Task 3's optional-chaining makes this true).
- Memo: re-render with only `remoteStatus` changing updates the DOM (guards the comparator edit).

- [ ] **Step 1: Write the failing behavioral test**

Create `SidebarItem.remote-status.test.tsx` copying the `renderSidebarItem` harness from `SidebarItem.running-state.test.tsx`; add the ring/data-attribute cases above. Add the two gate cases to `Sidebar.test.tsx` using its existing full-Sidebar store harness (seed `tabRegistry.remoteOpen` / `tabRegistry.sameDeviceOpen` directly in the preloaded state).

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
- End-to-end against the real Rust server: a second raw-WS device pushes a `tabs.sync.push` snapshot whose terminal pane payload carries `sessionKeys: ['claude:<seeded-id>']` with `activity: 'busy'`; after the browser page (re)loads — which triggers the query-on-`ready` consumer path — the sidebar row for that session shows `data-remote-status="busy"`. A follow-up push without `activity` + reload flips the row to `data-remote-status="open"`. A push whose records don't reference the session + reload removes the attribute. This pins Rust payload passthrough (R5) and both ring colors (R1, R2) through the real WS/store/selector/render chain.
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
