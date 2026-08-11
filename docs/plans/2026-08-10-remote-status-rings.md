# Remote Status Rings Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

**Goal:** A session row in the left panel (Sidebar) that would look green ("open") or blue ("busy") on a *different* device shows a matching green/blue ring around its icon on this device — only when the session is not open on this device.

**Architecture:** Every client already pushes its open-tab registry snapshot every 5s (`tabs.sync.push`). Each device now stamps each pane snapshot's opaque payload with `sessionKeys: string[]` (ALL of the pane's canonical `provider:sessionId` identities — explicit `sessionRef`, Claude `resumeSessionId`, Codex durability, live fresh-agent identity — resolved by the exact same rules the local sidebar uses) and `busySessionKeys: string[]` (the ONE effective busy identity for the pane, following the same explicit-first resolution as `collectBusySessionKeys`; usually empty or a single key — never every alias, so remote colors match the producing device exactly). Consumers derive per-session remote state from `state.tabRegistry.remoteOpen` (key in any pane's `busySessionKeys` → blue ring; else referenced via `sessionKeys` or the legacy `sessionRef` fallback → green ring; blue wins). Suppression: no ring when the session is open on THIS device — canonically resolved local keys (current window, including the live fresh-agent restore-gap identity that `hasTab` alone misses) or another window of the same device (`sameDeviceOpen`). A new periodic `tabs.sync.query` (30s; interval skips while a query is outstanding, with bounded stale replacement; reconnect/ready/retention triggers always supersede immediately) keeps remote snapshots fresh while connected. No server schema change: pane `payload` is a pass-through `z.record` on Node and (validated in Stage 2) the Rust server.

**Tech Stack:** React 18, Redux Toolkit, Tailwind CSS, Vitest + Testing Library, Playwright (e2e against the Rust server).

## Global Constraints

- Work happens only in this worktree (`.worktrees/remote-status-rings`, branch `the-usual/remote-status-rings`). Never touch the live self-hosted server (port 3001).
- Red-Green-Refactor TDD: every production change starts from a failing test run and ends green.
- Unit AND e2e coverage of new behavior (repo philosophy).
- Focused tests use `npm run test:vitest -- run <paths>` (default config covers `test/unit`; add `--config config/vitest/vitest.server.config.ts` for `test/server` / `test/integration/server`). Raw `npx vitest` is not a coordinated workflow.
- Broad runs: `npm run check` (typecheck + coordinated full suite) — must wait for the coordinator gate if held.
- Server code uses NodeNext/ESM: relative imports in `server/`/`shared/` need `.js` extensions. Client code uses `@/` alias without extensions.
- A11y: color-only cues need a non-color carrier (`data-*` attribute + tooltip/sr-only text). No lint regressions (`npm run lint`).
- No Rust code change in this plan; the Rust server must pass the new payload fields through untouched (validated; both e2e and a Node WS round-trip test pin it).
- Commits are focused, conventional-message, and never include log files under `.worktrees/.the-usual-logs/`.

## Requirements

- **R1 — Outcome (green ring):** When a session entry would render a green icon on a different device (i.e. the session is open in a tab there) and the session is *not* open on this device, the entry's icon gets a green circle ring on this device. Every identity form that turns the icon green locally on the producing device must produce the ring: explicit `sessionRef`, Claude `resumeSessionId`, Codex durability, live fresh-agent restore-gap identity, AND the `terminal:` fallback identity the Sidebar fabricates for running non-shell terminals without canonical session metadata (green via `collectTerminalPaneTitles`). Deliberately excluded: layout-less transient tab fallback (`buildTabFallbackLocator`) — such a tab produces no registry record on any device today (the push path skips tabs without layouts), so no device could ever observe it; covering it would require a tab-level payload mechanism this plan intentionally avoids.
- **R2 — Outcome (blue ring):** When a session entry would render a blue icon on a different device (any of its remotely-open panes busy) and the session is *not* open on this device, the entry's icon gets a blue circle ring. Blue wins over green when both apply (mirrors local `blue > green` precedence). Alias identities of the busy pane that are NOT the effective busy identity stay green, matching the producing device.
- **R3 — Constraint (local wins):** A session open on this device never shows a remote ring; existing solid local coloring (blue busy / green open / grey) is unchanged. "Open on this device" is canonically resolved: the current window's session keys including the live fresh-agent restore-gap identity (a superset of what `hasTab` sees), plus records the server partitions as `sameDeviceOpen` (same `deviceId`, different `clientInstanceId`). `sameDeviceOpen` records suppress rings and never produce them.
- **R4 — Outcome (liveness):** Ring state reflects remote churn while all clients stay connected — no reconnect or reload required. Producer pushes busy/idle transitions within the existing 5s sync tick; consumers re-query remote snapshots on a 30s interval (previously only on WS ready/reconnect). Existing event-driven query behavior (ready/reconnect/retention-change must take prompt effect) is preserved: event triggers supersede any outstanding query immediately.
- **R5 — Constraint (compatibility):** The new per-pane payload fields (`sessionKeys`, `busySessionKeys`) round-trip through both the Node and Rust servers (validate → store → query reply) with zero server code changes; the existing full test suite and sidebar render-stability contracts stay green.

---

### Task 1: Producer — stamp per-pane `sessionKeys` + `busySessionKeys` into pushed registry records

**Requirements served:** R1, R2, R4, R5

**Behavior:**
- When this device builds its open-tab registry records (existing 5s push in `startTabRegistrySync`), each leaf pane snapshot's `payload` gains:
  - `sessionKeys: string[]` — every canonical identity of the pane, resolved with the same rules the local sidebar uses for its green/`hasTab` join: `extractSessionLocators(content)` (`src/lib/session-utils.ts:107` — explicit `sessionRef`, Claude `resumeSessionId`, Codex durability, fresh-agent `resumeSessionId`) UNION the live fresh-agent canonical key from `resolveFreshAgentSessionKey(content, liveSession)` (`src/lib/pane-activity.ts`) when a live session exists UNION, for terminal panes matching the Sidebar's fallback-row predicate (running non-shell terminals without canonical session metadata — read the exact predicate and fabricated row key at `sidebarSelectors.ts:496-524`), that fallback row's session key so remote devices ring the `terminal:` row green too. Omitted when empty (shell terminals, browsers, editors, pickers).
  - `busySessionKeys: string[]` — present only when the pane is busy per `resolvePaneActivity` (same inputs the Sidebar blue icon uses); holds the pane's ONE effective busy identity: `resolveFreshAgentSessionKey(content, liveSession)` for fresh-agent panes, `resolveTerminalSessionKey(content, tab.sessionRef, tab.resumeSessionId, tab.mode)` for terminal panes — mirroring `collectBusySessionKeys` per-entry logic exactly. Omitted when not busy.
- Closed/tombstone records are never stamped with either field, even when a nonempty annotation map is passed to the closed builder (tested behaviorally, see cases).
- Because `recordFingerprint` (`tabRegistrySync.ts:130-139`) and the push dedupe (`pushNow`, `:329-331`) both include `panes`, a busy→idle or idle→busy transition changes the fingerprint and ships on the next 5s tick.

**Files:**
- Modify: `src/lib/session-utils.ts` — export the currently-private `extractSessionLocators` (:107) unchanged (no logic edit), so the identity collector and tests can consume it directly.
- Modify: `src/lib/pane-activity.ts` — new export `collectPaneIdentityActivity(input): Map<string, { sessionKeys: string[]; busySessionKeys: string[] }>` (input record identical to `collectBusySessionKeys`' at `:311-383`: `{ tabs, paneLayouts, codexActivityByTerminalId, claudeActivityByTerminalId, amplifierActivityByTerminalId, opencodeActivityByTerminalId, paneRuntimeActivityByPaneId, freshAgentSessions }`). One walk per tab/layout computing both fields per leaf pane. Layout-less tabs contribute nothing (records are never built for them — `buildRecords` skips `!layout`; see R1's exclusion note).
- Modify: `src/lib/tab-registry-snapshot.ts` — `collectPaneSnapshots` (:76-94) gains optional `annotatePayload?: (paneId: string) => { sessionKeys?: string[]; busySessionKeys?: string[] } | undefined`, merged onto the `stripPanePayload` result. `SnapshotRecordInput` gains `paneIdentityActivity?: ReadonlyMap<string, { sessionKeys: string[]; busySessionKeys: string[] }>`; `buildOpenTabRegistryRecord` forwards it via the hook; `buildClosedTabRegistryRecord` accepts but ignores it.
- Modify: `src/store/tabRegistrySync.ts` — `buildRecords` (:176-231) computes the map once per call from the state slices (`state.codexActivity?.byTerminalId`, `state.claudeActivity?.byTerminalId`, `state.amplifierActivity?.byTerminalId`, `state.opencodeActivity?.byTerminalId`, `state.paneRuntimeActivity?.byPaneId`, `state.freshAgent?.sessions`) and passes it to `buildOpenTabRegistryRecord` per tab.
- Test: `test/unit/client/lib/pane-activity.test.ts`, `test/unit/client/lib/tab-registry-snapshot.test.ts`, `test/unit/client/lib/session-utils.test.ts`, `test/unit/client/store/tabRegistrySync.test.ts`

**Interfaces:**
- Consumes: `resolvePaneActivity` (:117-205), `resolveFreshAgentSessionKey`/`resolveTerminalSessionKey` (same file), `extractSessionLocators` (`session-utils.ts:107`, exported by this task), the Sidebar fallback-row predicate + key format (`sidebarSelectors.ts:496-524`), `collectBusySessionKeys` (same file; also consumed by Task 4's suppression union), `makeFreshAgentSessionKey` (`@shared/fresh-agent`; live-session lookup pattern at `pane-activity.ts` collectBusySessionKeys), `collectPaneEntries` (`@/lib/pane-utils`).
- Produces:
  - `collectPaneIdentityActivity(input): Map<PaneId, { sessionKeys: string[]; busySessionKeys: string[] }>` — panes with neither key may be absent from the map.
  - `SnapshotRecordInput.paneIdentityActivity?: ReadonlyMap<string, { sessionKeys: string[]; busySessionKeys: string[] }>`
  - Wire shape per pane: `{ ..., payload: { ..., sessionKeys?: string[], busySessionKeys?: string[] } }`

**Test cases:**
- `collectPaneIdentityActivity` busy: busy codex terminal pane (`phase: 'busy'`) → `busySessionKeys [<effective key>]`; idle second pane → no `busySessionKeys`. Fresh-agent busy (`status:'running'` live session) → busy key via live canonical identity. Waiting-for-approval (pendingPermissions non-empty) → NOT busy. Empty tabs → empty map.
- `collectPaneIdentityActivity` identity completeness: terminal with explicit `sessionRef` → key; terminal with NO `sessionRef` but Claude `resumeSessionId` → `claude:<id>`; Codex durability identity → key; fresh-agent with no `content.sessionRef` but live session in `freshAgentSessions` (restore gap) → canonical live key in `sessionKeys`; shell terminal → absent.
- Alias correctness (the round-2 mis-color finding): terminal pane with explicit `sessionRef` A AND Claude `resumeSessionId` B, busy → `sessionKeys` contains A and B but `busySessionKeys` is `[A]` only (effective identity).
- Snapshot stamping: via `buildOpenTabRegistryRecord` with the map → busy pane payload has `sessionKeys` and `busySessionKeys`; sessionless pane has neither.
- Closed builder given a NONEMPTY map → closed record panes carry neither field.
- `tabRegistrySync` harness: busy pane in state → pushed records contain `payload.busySessionKeys`; after the pane goes idle, a subsequent tick pushes again (key removed → fingerprint changed).

- [ ] **Step 1: Write the failing behavioral test**

Add: (a) the `collectPaneIdentityActivity` describe to `pane-activity.test.ts` (mirroring the existing `collectBusySessionKeys` fixtures, incl. the `terminal:` fallback stamping case); (b) the stamping cases to `tab-registry-snapshot.test.ts` including the alias-correctness and closed-builder cases; (c) the wiring cases to `tabRegistrySync.test.ts` — pushed records carry `payload.sessionKeys`/`payload.busySessionKeys` for a busy pane, and an idle→busy transition re-pushes on the next 5s tick (fingerprint changes); (d) one `session-utils.test.ts` assertion that `extractSessionLocators` is exported (import smoke is enough; its behavior is already covered there).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/lib/pane-activity.test.ts test/unit/client/lib/tab-registry-snapshot.test.ts test/unit/client/store/tabRegistrySync.test.ts test/unit/client/lib/session-utils.test.ts`

Expected: FAIL because `collectPaneIdentityActivity` is not exported, `extractSessionLocators` is private, and no stamping/threading exists (missing behavior, not setup errors).

- [ ] **Step 3: Add the minimal production implementation**

Export `extractSessionLocators` in `session-utils.ts`; implement `collectPaneIdentityActivity` in `pane-activity.ts` (including the `terminal:` fallback key per the Sidebar predicate); thread the annotation hook through `collectPaneSnapshots`/`SnapshotRecordInput`/`buildOpenTabRegistryRecord`; compute the map in `buildRecords` and pass it per tab. Closed builder explicitly ignores the map.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/lib/pane-activity.test.ts test/unit/client/lib/tab-registry-snapshot.test.ts test/unit/client/store/tabRegistrySync.test.ts test/unit/client/lib/session-utils.test.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

If the new walk duplicates `collectBusySessionKeys`' per-entry logic, extract the shared per-pane resolution so both call it; confirm the existing busy-session and restore-gap tests stay green.

- [ ] **Step 6: Run broader verification**

Run: `npm run test:vitest -- run test/unit/client/store/tabRegistrySlice.test.ts test/unit/client/lib/tab-registry-open.test.ts test/unit/client/lib/session-utils.test.ts`

Expected: PASS (registry/session neighbors unaffected).

- [ ] **Step 7: Commit the task**

```bash
git add src/lib/session-utils.ts src/lib/pane-activity.ts src/lib/tab-registry-snapshot.ts src/store/tabRegistrySync.ts test/unit/client/lib/session-utils.test.ts test/unit/client/lib/pane-activity.test.ts test/unit/client/lib/tab-registry-snapshot.test.ts test/unit/client/store/tabRegistrySync.test.ts
git commit -m "feat(tabs-registry): stamp per-pane session keys and busy identity into pushed snapshots"
```

---

### Task 2: Freshness — periodic remote re-query with correct trigger precedence

**Requirements served:** R4, R1, R2

**Behavior:**
- `startTabRegistrySync` sends `tabs.sync.query` on a fixed 30s interval (new exported `QUERY_INTERVAL_MS = 30_000`) so `remoteOpen` stays fresh while connected.
- **Trigger precedence (preserves existing event behavior):**
  - Event triggers — WS `ready`, reconnect, retention-days change, startup — ALWAYS send immediately, superseding any outstanding request: clear `pendingRequests`, assign the new latest id, send, and stamp `lastQuerySentAt`. (An outstanding request whose socket died must not delay the reconnect query; today those triggers already supersede freely.)
  - The interval trigger NEVER overlaps: if `pendingRequests` is non-empty AND `lastQuerySentAt` is younger than `QUERY_STALE_MS = 90_000` (3× interval, exported), skip; if the outstanding query is stale (server unreachable / reply lost), clear `pendingRequests` and send a replacement. In-flight memory is bounded to one outstanding request, and a silently dead query channel self-heals within 90s.
- `querySnapshot` today has no in-flight guard (`:294-312` allocates a new id per call); the guard lives at the call sites as specified above (interval skips/supersedes deliberately, event triggers supersede deliberately) with `lastQuerySentAt` maintained in the single send path.
- No send when `ws.state !== 'ready'`; lease-unsettled queries keep the existing `queuedQuery` behavior. Interval cleared by the returned teardown.

**Files:**
- Modify: `src/store/tabRegistrySync.ts:20-22` (constants), `:294-312` (`querySnapshot` send path + `lastQuerySentAt`), reconnect/ready/retention call sites (`:359-367`, `:433-437`, `:467-470`, `:479-490`, `:522`) marked supersede, `:472-477` (new interval), `:525-537` (teardown)
- Test: `test/unit/client/store/tabRegistrySync.test.ts`

**Interfaces:**
- Consumes: existing `querySnapshot` closure, `SYNC_INTERVAL_MS`/`HEARTBEAT_INTERVAL_MS` pattern, the `latestQueryRequestId` reply gate (`:440-459`).
- Produces: `export const QUERY_INTERVAL_MS = 30_000` and `export const QUERY_STALE_MS = 90_000` from `src/store/tabRegistrySync.ts`.

**Test cases:**
- Fake timers, ws ready, boot query settled (test feeds a matching `tabs.sync.snapshot` reply for the boot request id, clearing `pendingRequests`): advance 30s → exactly one additional query; reply and advance 30s → another.
- Interval suppression: with the boot (or a prior interval) query left outstanding, advance 30s → NO additional query.
- Stale replacement: with a query outstanding and `lastQuerySentAt` older than `QUERY_STALE_MS`, interval fires → exactly one replacement query; a late reply for the old id is ignored (existing `latestQueryRequestId` gate).
- Reconnect supersede: with a query outstanding, trigger reconnect → a new query is sent IMMEDIATELY (no 90s wait) and `pendingRequests` holds only the new id.
- ws not ready: interval fires → nothing sent. Teardown: no further interval queries.
- Existing ready/retention-change query tests keep passing unchanged (regression proof for trigger precedence).

- [ ] **Step 1: Write the failing behavioral test**

In `tabRegistrySync.test.ts` (fake-timer harness with a scripted WS double that can reply to specific request ids): settle the boot query, clear the mock, then the interval/suppression/stale/reconnect cases above.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/store/tabRegistrySync.test.ts`

Expected: FAIL because no query interval exists and no supersede/stale mechanics are exported (`QUERY_INTERVAL_MS` undefined).

- [ ] **Step 3: Add the minimal production implementation**

Add the constants; add `lastQuerySentAt`; split the query call sites into supersede (event triggers: clear then send) vs interval (skip-if-outstanding, stale-replace); wire the interval and teardown.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/store/tabRegistrySync.test.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

If the supersede vs stale logic grew twice, factor the single send path (`sendQueryNow`) so every trigger shares id allocation, pending bookkeeping, and the `latestQueryRequestId` update; keep behavior identical.

- [ ] **Step 6: Run broader verification**

Run: `npm run test:vitest -- run test/unit/client/store/`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add src/store/tabRegistrySync.ts test/unit/client/store/tabRegistrySync.test.ts
git commit -m "feat(tabs-registry): re-query remote snapshots on a 30s interval with trigger precedence"
```

---

### Task 3: Selector — per-session remote activity (`'busy' | 'open'`) and suppression key sets

**Requirements served:** R1, R2, R3

**Behavior:**
- New pure function `deriveRemoteSessionActivity(records: RegistryTabRecord[] | undefined): Record<string, 'busy' | 'open'>`, plus memoized selectors built on it.
- Key extraction per pane (defensive against unknown payload shapes):
  - Busy keys: every string in `payload.busySessionKeys` (array of non-empty strings) → `'busy'`.
  - Open keys: every string in `payload.sessionKeys` (array of non-empty strings) → `'open'`; when `sessionKeys` is absent, a legacy well-formed single `payload.sessionRef` (`{provider, sessionId}` non-empty strings) → `'open'` (snapshots from older clients still yield green rings; they can never yield blue, which old clients cannot express).
  - `'busy'` wins over `'open'` across panes and records (R2 precedence). Panes with no identity contribute nothing. Empty/missing input → `{}`.
- `selectRemoteSessionActivity = createSelector([selectRemoteOpen], deriveRemoteSessionActivity)` — fed only from `remoteOpen`, so only genuinely different devices produce rings (server partition, `server/tabs-registry/store.ts:1240-1296`).
- `selectSameDeviceSessionKeys = createSelector([selectSameDeviceOpen], (records) => new Set(Object.keys(deriveRemoteSessionActivity(records))))` — the R3 *suppression* set (other windows of this same device). Suppresses; never produces.
- Both slice accessors tolerate partial stores: `state.tabRegistry?.remoteOpen` / `?.sameDeviceOpen` with empty defaults (several existing Sidebar component harnesses omit the `tabRegistry` reducer — selectors must not throw there).

**Files:**
- Modify: `src/store/selectors/tabsRegistrySelectors.ts` (add exports; make the `selectRemoteOpen` input at :40 and its `sameDeviceOpen` sibling optional-chain tolerant)
- Test: `test/unit/client/store/tabsRegistrySelectors.test.ts` (create; the existing `tabRegistrySlice.test.ts` keeps slice concerns)

**Interfaces:**
- Consumes: `RegistryTabRecord` (`@/store/tabRegistryTypes`), `selectRemoteOpen`, `selectSameDeviceOpen`.
- Produces:
  - `deriveRemoteSessionActivity(records: RegistryTabRecord[] | undefined): Record<string, 'busy' | 'open'>`
  - `selectRemoteSessionActivity: (state: RootState) => Record<string, 'busy' | 'open'>`
  - `selectSameDeviceSessionKeys: (state: RootState) => Set<string>`

**Test cases:**
- One remote record, pane `sessionKeys: ['claude:s1']`, no busy → `{ 'claude:s1': 'open' }`.
- Pane with `busySessionKeys: ['claude:s1']` (and `sessionKeys` containing aliases A=s1, B=s2) → `{ 'claude:s1': 'busy', 'claude:s2': 'open' }` — alias stays green (round-2 mis-color regression).
- Legacy record with only `sessionRef {provider:'claude', sessionId:'s1'}` → `{ 'claude:s1': 'open' }`.
- `sessionKeys` present AND differing `sessionRef` → `sessionKeys` authoritative (array wins).
- Two devices referencing the same session, one busy → `'busy'`.
- Pane with missing/empty keys and missing/partial `sessionRef` → no key. `undefined`/empty input → `{}`. Record missing `panes` → `{}`.
- `selectSameDeviceSessionKeys` → Set of all keys incl. busy ones (suppression ignores color).
- Selectors against a store without the `tabRegistry` slice → `{}` / empty Set, no throw.

- [ ] **Step 1: Write the failing behavioral test**

Create `test/unit/client/store/tabsRegistrySelectors.test.ts` with the cases above, importing `deriveRemoteSessionActivity`/`selectRemoteSessionActivity`/`selectSameDeviceSessionKeys`. Build minimal `RegistryTabRecord` literals via the existing record-fixture style (see `tabRegistrySlice.test.ts`).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/store/tabsRegistrySelectors.test.ts`

Expected: FAIL because the exports do not exist.

- [ ] **Step 3: Add the minimal production implementation**

Implement `deriveRemoteSessionActivity` (iterate records → panes → collect `busySessionKeys`/`sessionKeys`/`sessionRef`-fallback defensively, fold busy-wins), wire the two selectors, make the slice inputs optional-chain tolerant.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/store/tabsRegistrySelectors.test.ts test/unit/client/store/tabRegistrySlice.test.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Extract the defensive payload-key readers into one local helper inside the selectors file only if it reads cleanly; no shared util until a second consumer exists.

- [ ] **Step 6: Run broader verification**

Run: `npm run test:vitest -- run test/unit/client/store/`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add src/store/selectors/tabsRegistrySelectors.ts test/unit/client/store/tabsRegistrySelectors.test.ts
git commit -m "feat(sidebar): derive per-session remote activity and same-device suppression keys from registry"
```

---

### Task 4: Sidebar rendering — ring around the icon, canonically gated on not-open-on-this-device

**Requirements served:** R1, R2, R3

**Behavior:**
- `SidebarItem` gains optional prop `remoteStatus?: 'busy' | 'open'`. When set, the existing `relative` icon wrapper (`Sidebar.tsx:1000`) additionally renders `<span aria-hidden="true" className={cn('pointer-events-none absolute -inset-[3px] rounded-full border', remoteStatus === 'busy' ? 'border-blue-500' : 'border-success')} />`. Icon glyph/colors unchanged (grey when not open locally — the only state where a ring can appear).
- The row button gains `data-remote-status={remoteStatus}` only when set (absent otherwise — existing e2e `data-*` pins don't churn).
- Non-color carriers (a11y): tooltip gains a line `Busy on another device` / `Open on another device`; button content gains `<span className="sr-only">(busy on another device)</span>` / `(open on another device)` next to the title.
- Suppression (R3): `Sidebar` builds `localSessionKeys` = keys of `collectSessionRefsFromTabs(tabs, panes)` UNION the per-pane `sessionKeys`/`busySessionKeys` from `collectPaneIdentityActivity` (Task 1) UNION the existing `collectBusySessionKeys` output. All three are required together: refs cover layout/tab fallbacks; the identity collector covers the fresh-agent restore-gap canonical identity that `hasTab` misses; `collectBusySessionKeys` covers local busy identities no identity collector emits (e.g. an OpenCode/Amplifier terminal whose busy key comes from `resumeSessionId`, which `extractSessionLocators` only honors for Claude) — without it a ring could appear around a locally blue entry. All via one memoized `useAppSelector`; plus `sameDeviceSessionKeys` via `useAppSelector(selectSameDeviceSessionKeys)`. Passes `remoteStatus={localSessionKeys.has(sessionKey) || sameDeviceSessionKeys.has(sessionKey) ? undefined : remoteActivityBySessionKey[sessionKey]}` at `:891-898`, with `remoteActivityBySessionKey` from `useAppSelector(selectRemoteSessionActivity)`.
- `areSidebarItemPropsEqual` (:949-973) compares `remoteStatus` or rings freeze. `isSessionItemEqual` (:135-158) intentionally untouched (prop, matching the `isBusy` pattern).

**Files:**
- Modify: `src/components/Sidebar.tsx` (:935-943 props, :949-973 comparator, :975-1008 item render + ring + sr-only, :889-898 wiring + the two new selectors + local-key memo, tooltip :1038-1041)
- Test: `test/unit/client/components/SidebarItem.remote-status.test.tsx` (create), `test/unit/client/components/Sidebar.test.tsx` (gate cases — its `createTestStore` harness must register the real `tabRegistry` reducer so seeded `remoteOpen`/`sameDeviceOpen` state reaches the selectors; extend the harness reducer map or add a dedicated complete store in the new cases. Keep the existing partial-store harnesses untouched — Task 3's tolerance keeps them green). Keep `Sidebar.dom-stability.test.tsx` / `Sidebar.render-stability.test.tsx` green.

**Interfaces:**
- Consumes: `selectRemoteSessionActivity`, `selectSameDeviceSessionKeys` (Task 3); `collectPaneIdentityActivity` (Task 1) + `collectSessionRefsFromTabs` (`session-utils.ts`) for the local suppression set.
- Produces: `SidebarItemProps.remoteStatus?: 'busy' | 'open'`; DOM contract `data-remote-status="busy"|"open"` (absent when no ring).

**Test cases:**
- `remoteStatus="busy"` + `hasTab: false` → ring span with `border-blue-500`; `data-remote-status="busy"`; sr-only text; icon keeps `text-muted-foreground`.
- `remoteStatus="open"` → `border-success` ring + `data-remote-status="open"`.
- No `remoteStatus` → no ring span, no attribute.
- Full Sidebar (tabRegistry reducer registered): `remoteOpen` seeded busy key, session NOT open locally → `data-remote-status="busy"`.
- Local suppression: same seed but session open in a local tab via `sessionRef` → attribute absent.
- Restore-gap suppression: fresh-agent pane open locally whose canonical live identity (from seeded `freshAgent.sessions`) differs from its stale `resumeSessionId`; remoteOpen busy on the LIVE canonical key → attribute absent (the round-2 hasTab-gap case); also the idle variant (remote merely open on the live key) → absent.
- Same-device suppression: session present in `sameDeviceOpen` while a remote device reports it busy → attribute absent.
- Local busy-identity suppression: an OpenCode terminal pane whose effective busy key comes from `resumeSessionId` (busy via `collectBusySessionKeys`, absent from `sessionKeys`) while a remote record carries that same key → attribute absent (round-3 union case).
- Partial-store tolerance: a Sidebar render WITHOUT the tabRegistry reducer → renders fine, no rings (selector defaults).
- Memo: re-render with only `remoteStatus` changing updates the DOM (guards the comparator edit).

- [ ] **Step 1: Write the failing behavioral test**

Create `SidebarItem.remote-status.test.tsx` copying the `renderSidebarItem` harness from `SidebarItem.running-state.test.tsx`; add the ring/data-attribute cases. Add the four full-Sidebar gate cases (registering the tabRegistry reducer in `Sidebar.test.tsx`'s store harness) and the restore-gap cases.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/SidebarItem.remote-status.test.tsx test/unit/client/components/Sidebar.test.tsx`

Expected: FAIL because `remoteStatus`/ring/`data-remote-status`/selector wiring do not exist (missing behavior, not harness errors — if the harness fails to seed registry state, fix the harness registration first and keep the failing assertions behavioral).

- [ ] **Step 3: Add the minimal production implementation**

Implement the prop, ring span, sr-only/tooltip text, `data-remote-status`, both selector hooks, the local suppression memo, and the comparator line, exactly per Behavior above.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/SidebarItem.remote-status.test.tsx test/unit/client/components/Sidebar.test.tsx`

Expected: PASS

- [ ] **Step 5: Refactor while green**

If ring JSX/copy duplicates, lift tiny local constants (e.g. `REMOTE_STATUS_COPY`) inside `Sidebar.tsx`; no new components.

- [ ] **Step 6: Run broader verification**

Run: `npm run test:vitest -- run test/unit/client/components/ && npm run lint`

Expected: PASS (including `Sidebar.dom-stability`, `Sidebar.render-stability`, `Sidebar.mobile`, `Sidebar.perf-audit`; no new a11y lint violations).

- [ ] **Step 7: Commit the task**

```bash
git add src/components/Sidebar.tsx test/unit/client/components/SidebarItem.remote-status.test.tsx test/unit/client/components/Sidebar.test.tsx
git commit -m "feat(sidebar): remote status rings for sessions open or busy on other devices"
```

---

### Task 5: E2E pin (Rust), Node WS round-trip pin, documentation

**Requirements served:** R1, R2, R5

**Behavior:**
- End-to-end against the real Rust server: a second raw-WS device (`deviceId: 'e2e-device-b'`) pushes `tabs.sync.push` snapshots whose terminal pane payload carries `sessionKeys: ['claude:<seeded-id>']` plus `busySessionKeys` for the busy case. Push discipline (round-2/3 findings): a push helper assigns monotonically increasing `snapshotRevision` values (1, 2, 3… — Rust treats a duplicate revision as idempotent replay) and, since `tabs.sync.ack` carries NO revision field (only `accepted` + record counts — verified against `shared/ws-protocol.ts` and the Rust `TabsSyncAck`), it awaits the NEXT successful ack whose `accepted` is true and whose record count matches the push before proceeding; pushes are strictly sequential so this is unambiguous. Reload-driven assertions: baseline no `data-remote-status` → busy push + reload → `data-remote-status="busy"` + `border-blue-500` ring → open push (no busy field) + reload → `"open"` + `border-success` → push without the session + reload → attribute absent. Pins Rust payload passthrough (R5) and both colors through the real WS/store/selector/render chain.
- The e2e also covers the two core behaviors reloads cannot prove (round-3 finding): (a) **R4 no-reload liveness** — after establishing the baseline, push busy + await ack, then WITHOUT reloading assert the row gains `data-remote-status="busy"` within one query interval plus slack (expect timeout ≈ 45s; the consumer's 30s periodic query is the path under test — do not reconnect or reload the page for this case); (b) **R3 suppression** — with a remote busy push installed: open the seeded session locally on the page (sidebar click) and assert the attribute disappears; then close it and add a SECOND raw-WS client claiming the page's `deviceId` (read from localStorage) with a distinct `clientInstanceId` — its records partition into `sameDeviceOpen` — and assert its busy push produces NO ring (same-device records never produce rings).
- Node-side R5 pin (round-2 finding — only Rust was covered): extend the existing push/query scenario in `test/server/ws-tabs-registry.test.ts` (server config suite): push a record whose pane payload contains `sessionKeys` and `busySessionKeys`, query from a different `deviceId`, assert both fields arrive byte-identical in `remoteOpen`.
- `AGENTS.md` "Agent Status Indicators" paragraph gains one sentence documenting the sidebar rings (green = open on another device, blue = busy on another device, suppressed when open on this device).
- Planning-time note (already decided): `docs/index.html`'s sidebar mock renders monochrome provider icons with no per-entry status colors, so no mock change (repo rule requires it only for major UI shifts).

**Files:**
- Create: `test/e2e-browser/specs/sidebar-remote-status-rings-rust.spec.ts`
- Modify: `test/server/ws-tabs-registry.test.ts` (round-trip pin)
- Modify: `AGENTS.md` (one sentence in the Agent Status Indicators pattern paragraph)

**Interfaces:**
- Consumes: `RustServer` + `ensureRustServerBuilt` + `TestHarness` e2e helpers (copy boot/seed patterns verbatim from `test/e2e-browser/specs/sidebar-registry-sync-rust.spec.ts` per the suite's per-spec-ownership convention); WS handshake from Stage-2 evidence: bare `ws://` connect then in-band `{type:'hello', token, protocolVersion:7}` → `ready`; `tabs.sync.push`/`tabs.sync.ack`/`tabs.sync.snapshot` shapes (`shared/ws-protocol.ts:961-993`); the `ws` npm package (runtime dependency, `package.json:129`; raw-WS precedent in `safe03-origin-matrix.spec.ts`).
- Producer stamping (Task 1) and selector (Task 3) are unit-covered; the e2e's raw second device hand-builds the wire payload (the server contract under test is passthrough + the consumer chain).

**Test cases:**
- E2E: baseline → busy → open → absent across reloads (revision-bumped, ack-awaited pushes) — pins R5 on Rust.
- E2E: no-reload periodic-query liveness (≤45s assertion window) — pins R4.
- E2E: R3 suppression — locally-open session shows no ring; crafted same-device record produces no ring — pins R3.
- Node WS: `sessionKeys`/`busySessionKeys` round-trip byte-identical through push → query as another device (in `ws-tabs-registry.test.ts`) — pins R5 on Node.

- [ ] **Step 1: Author the pin tests**

Author the Node round-trip case (fast loop), then the e2e spec with the revision/ack push helper. Both are regression pins over behavior Tasks 1-4 plus a contract (opaque payload passthrough) that already holds today: they lock R5 against future server-side schema tightening rather than drive new production code, so a RED step does not apply — verify each assertion is non-vacuous by confirming the queried payload genuinely shows the fields (print/inspect once during authoring, not in committed code).

- [ ] **Step 2: Run the new tests**

Run: `npm run test:vitest -- run test/server/ws-tabs-registry.test.ts --config config/vitest/vitest.server.config.ts` and `npm run test:e2e:chromium -- test/e2e-browser/specs/sidebar-remote-status-rings-rust.spec.ts`

Expected: Node round-trip PASSES (fields pass through — regression-proofs R5). E2E PASSES if Tasks 1-4 integrated correctly; any failure is meaningful (broken consumer chain or Rust passthrough violation) — root-cause, never loosen assertions.

- [ ] **Step 3: Fix only genuine integration gaps**

No new production code is planned here. If the e2e exposes an integration defect, fix it with the smallest correct change and its own unit test.

- [ ] **Step 4: Add the documentation**

One `AGENTS.md` sentence per Behavior above.

- [ ] **Step 5: Run broader verification**

Run: `npm run check` (typecheck + coordinated full suite; wait for the coordinator gate) and re-run both new specs after it.

Expected: PASS

- [ ] **Step 6: Commit the task**

```bash
git add test/e2e-browser/specs/sidebar-remote-status-rings-rust.spec.ts test/server/ws-tabs-registry.test.ts AGENTS.md
git commit -m "test(registry): pin cross-device sidebar status rings (Rust e2e + Node WS round-trip)"
```

---

## Verification matrix

| Requirement | Primary evidence | Additional |
|---|---|---|
| R1 | Task 1 identity-completeness cases; Task 3 open cases; Task 4 open-ring + gate cases | Task 5 e2e open case |
| R2 | Task 1 busy + alias-correctness cases; Task 3 busy/alias cases; Task 4 busy-ring cases | Task 5 e2e busy case |
| R3 | Task 4 local/restore-gap/same-device suppression cases; Task 3 partition design + same-device set | — |
| R4 | Task 1 fingerprint push case; Task 2 interval/suppression/stale/reconnect cases | — |
| R5 | Task 5 Rust e2e + Node WS round-trip pin | `npm run check`; Task 4 regression suites |
