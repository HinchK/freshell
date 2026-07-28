# Sidebar Filter Follow-ups Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Three follow-ups to the sidebar repo-filter feature (PR #553): rename the default repo option to "All repos", fix the disruptive live-update jump/re-sort behavior at its root cause, and add a "coding agent" filter dropdown that mirrors the repo filter's UX and test conventions.

**Architecture:** All three changes live in the established repo-filter architecture: pure helpers in `src/store/selectors/sidebarSelectors.ts`, component-local (never persisted) `useState` wiring in `src/components/Sidebar.tsx`, and the four-layer test convention (pure-helper unit tests → Sidebar component tests → `test/e2e/*.test.tsx` jsdom flow tests → non-persistence lock + `docs/index.html` mock). The jumpiness fix emulates the main page (`HistoryView`), whose calm is structural: an always-mounted scroll container and a data window that never shrinks under the user. We fix both structural defects in the sidebar (conditional scroll container; live refresh truncating the paginated window to page 1) plus add a deterministic sort tie-break. This is the PREFERRED root-cause fix from the spec; the blunt fallback (no-scroll + 30–60s throttle) is NOT needed and is not implemented.

**Tech Stack:** React 18 + TypeScript, Redux Toolkit, Vitest + Testing Library (jsdom), Tailwind classes, lucide-react icons.

## Global Constraints

- Repo dropdown default option visible text must be exactly `All repos` (value stays `all`; behavior unchanged).
- Agent dropdown default option visible text must be exactly `All agents` (value `all`).
- Both filters are deliberately component-local `useState` — NEVER persisted (no localStorage, no Redux settings); a browser refresh resets them. Locked by test.
- Agent filter ANDs with BOTH the repo filter and the text search.
- Jumpiness fix must be root-cause (preserve scroll position structurally, stable ordering, no window truncation) — do NOT implement the throttle fallback.
- TDD Red-Green-Refactor for every task; never skip the failing-test run.
- Focused test runs use `npm run test:vitest -- --run <file>` (never raw `npx vitest`). The `--run` flag is MANDATORY: the coordinator passes default-config invocations straight to vitest, which enters watch mode when stdin is a TTY and `CI` is unset — the command then hangs forever, indistinguishable from a broken test (verified live). Broad runs use `npm run check` (shared coordinator gate).
- Commits must use git identity `Dan Shapiro <3732858+danshapiro@users.noreply.github.com>`.
- Icon-only buttons must carry `aria-label` (eslint-plugin-jsx-a11y is a CI gate).
- Update `docs/index.html` static UI mock for user-facing sidebar changes.
- Do NOT run `gh pr create` (needs explicit user approval).
- README.md is the only end-user markdown doc — do not create other user-facing docs.
- Work on the worktree branch `feat/sidebar-filter-followups` in `/home/dan/code/freshell/.worktrees/sidebar-filter-followups`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/components/Sidebar.tsx` (966 lines) | Modify | Option label rename; hoist scroll container; agent dropdown + clear-x + empty state wiring |
| `src/store/selectors/sidebarSelectors.ts` (786 lines) | Modify | Sort tie-break; new pure agent-filter helpers (`ALL_AGENTS`, `AgentFilterOption`, `filterSessionItemsByAgent`, `collectAgentFilterOptions`) |
| `src/store/sessionsThunks.ts` (812 lines) | Modify | Depth-preserving silent refresh (merge fresh page 1 over the loaded window instead of replacing) |
| `test/unit/client/components/Sidebar.test.tsx` | Modify | Label assertion update; scroll-container mount-stability test; agent-filter component tests; agent non-persistence lock |
| `test/unit/client/store/sessionsThunks.test.ts` | Modify | Truncation-prevention tests for the silent refresh |
| `test/unit/client/store/selectors/sidebarSelectors.test.ts` | Modify | Sort tie-break tests |
| `test/unit/client/store/sidebar-agent-filter.test.ts` | Create | Pure agent-filter helper unit tests (mirrors `sidebar-repo-filter.test.ts`) |
| `test/e2e/sidebar-agent-filter-flow.test.tsx` | Create | jsdom flow test: agent filter, clear-x, AND with repo filter + committed server search |
| `docs/index.html` | Modify | Static mock: `All repos` label; new disabled agent select |

Background facts every task relies on (verified against `main` @ `6537d65c`):

- `SidebarSessionItem` (`sidebarSelectors.ts:14-48`) has `provider: CodingCliProviderName` (open string) and `sessionType: string` which **defaults to `provider`** (`sessionType: session.sessionType || provider`, `sidebarSelectors.ts:252`). Every item has a non-empty `sessionType` — there is no `undefined` bucket (unlike `repoPath`). The agent filter keys on `sessionType` because it is the field that already drives each row's icon/label via `resolveSessionTypeConfig` and distinguishes `freshclaude` from `claude`.
- The repo filter pipeline: `localFilteredItems` (memoized selector output) → `repoOptions = collectRepoFilterOptions(localFilteredItems, repoFilter)` → `computedItems = filterSessionItemsByRepo(...)` → `sortedItems = useStableArray(computedItems, isSessionItemEqual)` (`Sidebar.tsx:319-340`). The agent filter slots into the same chain.
- List rows are keyed `` `${item.provider}:${item.sessionId}` `` and rendered inside `<div ref={listRef} data-testid="sidebar-session-list">` (`Sidebar.tsx:817-848`).
- "E2E" for sidebar filters means Vitest+jsdom flow tests in `test/e2e/` (run by default vitest config / `npm test`), NOT Playwright (`test/e2e-browser/` has no filter coverage — do not add any there).

---

### Task 1: Rename repo dropdown default option label to "All repos"

**Files:**
- Modify: `test/unit/client/components/Sidebar.test.tsx:2358-2362`
- Modify: `src/components/Sidebar.tsx:721`
- Modify: `docs/index.html:614`

**Interfaces:**
- Consumes: existing repo dropdown (`aria-label="Repo filter"`, sentinel `ALL_REPOS = 'all'` from `@/store/selectors/sidebarSelectors`).
- Produces: visible default option text `All repos` (value unchanged: `all`). Tasks 6-9 rely on this exact label existing so the agent dropdown's `All agents` label is parallel.

- [ ] **Step 1: Make the existing label assertion fail (Red)**

In `test/unit/client/components/Sidebar.test.tsx`, inside `describe('Repo filter dropdown')`, the first test (`'renders the repo dropdown defaulting to All with one option per repo'`, line ~2351) asserts option text. Update the test name and the expected label:

```tsx
      it('renders the repo dropdown defaulting to All repos with one option per repo', async () => {
        const store = createTestStore({ projects: repoProjects })
        const { getByRole } = renderSidebar(store, [])
        await act(() => vi.advanceTimersByTime(100))

        const select = getByRole('combobox', { name: /repo filter/i }) as HTMLSelectElement
        expect(select).toHaveValue('all')
        expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
          'All repos',
          'repo-alpha',
          'repo-beta',
        ])
        expect(Array.from(select.options).map((o) => o.value)).toEqual([
          'all',
          '/home/user/repo-alpha',
          '/home/user/repo-beta',
        ])
      })
```

(This is the ONLY test in the repo coupled to the literal label text — verified by repo-wide grep: the other two hits of `'All'` are the source line itself and an unrelated `TabsView.tsx` filter.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- --run test/unit/client/components/Sidebar.test.tsx -t "renders the repo dropdown defaulting to All repos"`
Expected: FAIL — received `'All'`, expected `'All repos'`.

- [ ] **Step 3: Change the option label**

In `src/components/Sidebar.tsx` line 721, change:

```tsx
              <option value={ALL_REPOS}>All</option>
```

to:

```tsx
              <option value={ALL_REPOS}>All repos</option>
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm run test:vitest -- --run test/unit/client/components/Sidebar.test.tsx test/e2e/sidebar-repo-filter-flow.test.tsx test/unit/client/store/sidebar-repo-filter.test.ts`
Expected: PASS (all — the e2e/helper suites assert option *values*, not the label).

- [ ] **Step 5: Update the static UI mock**

In `docs/index.html` line 614, change `<option>All</option>` to `<option>All repos</option>` (inside the `<select aria-label="Repo filter" disabled ...>` block at line 613).

- [ ] **Step 6: Commit**

```bash
git add test/unit/client/components/Sidebar.test.tsx src/components/Sidebar.tsx docs/index.html
git commit -m "fix(sidebar): rename repo filter default option label to 'All repos'"
```

---

### Task 2: Always-mounted session-list scroll container (jump fix, part 1)

The scroll element (`overflow-y-auto`, `data-testid="sidebar-session-list"`) currently lives INSIDE the `showBlockingLoad ? ... : sortedItems.length === 0 ? ... : <scroller>` ternary (`Sidebar.tsx:786-851`). Any transient zero-row state — very likely while a repo/agent filter is selected during a live refresh — unmounts the scroller, permanently destroying scroll position and going inert for backfill (`listRef.current` becomes null). The main page (`HistoryView.tsx:181`) keeps its scroll container unconditional with the empty state rendered inside it. Emulate that.

**Files:**
- Modify: `test/unit/client/components/Sidebar.test.tsx` (new test in `describe('Repo filter dropdown')`; extend the sessionsSlice import)
- Modify: `src/components/Sidebar.tsx:786-851`

**Interfaces:**
- Consumes: `commitSessionWindowVisibleRefresh` action from `@/store/sessionsSlice` (already exported); existing `repoProjects` fixture, `createTestStore`, `renderSidebar` helpers in `Sidebar.test.tsx`.
- Produces: structural contract used by Tasks 3 and 7 — the element with `data-testid="sidebar-session-list"` is ALWAYS mounted while the Session List section renders; loading/empty content renders inside it.

- [ ] **Step 1: Write the failing mount-stability test**

In `test/unit/client/components/Sidebar.test.tsx`, first extend the sessionsSlice import (lines 11-14) to include the visible-refresh action:

```tsx
import sessionsReducer, {
  commitSessionWindowReplacement,
  commitSessionWindowVisibleRefresh,
  setSessionWindowLoading,
} from '@/store/sessionsSlice'
```

Then add this test at the end of `describe('Repo filter dropdown')` (after the non-persistence test at ~line 2627):

```tsx
    it('keeps the scroll container mounted when a refresh transiently empties the filtered list', async () => {
      const store = createTestStore({ projects: repoProjects })
      const { getByRole, getByTestId } = renderSidebar(store, [])
      await act(() => vi.advanceTimersByTime(100))

      fireEvent.change(getByRole('combobox', { name: /repo filter/i }), {
        target: { value: '/home/user/repo-beta' },
      })
      expect(screen.getByText('Beta session one')).toBeInTheDocument()
      const containerBefore = getByTestId('sidebar-session-list')

      // A live refresh commits a page-1 window with no repo-beta sessions:
      // the filtered list is transiently empty.
      await act(async () => {
        store.dispatch(commitSessionWindowVisibleRefresh({
          surface: 'sidebar',
          projects: [repoProjects[0]],
          totalSessions: 2,
          hasMore: false,
        }))
      })

      // Empty state renders INSIDE the still-mounted scroll container.
      expect(screen.getByText('No sessions in selected repo')).toBeInTheDocument()
      expect(getByTestId('sidebar-session-list')).toBe(containerBefore)

      // The next refresh restores repo-beta rows into the SAME container
      // instance (scroll position survives in a real browser).
      await act(async () => {
        store.dispatch(commitSessionWindowVisibleRefresh({
          surface: 'sidebar',
          projects: repoProjects,
          totalSessions: 3,
          hasMore: false,
        }))
      })
      expect(screen.getByText('Beta session one')).toBeInTheDocument()
      expect(getByTestId('sidebar-session-list')).toBe(containerBefore)
    })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- --run test/unit/client/components/Sidebar.test.tsx -t "keeps the scroll container mounted when a refresh transiently empties"`
Expected: FAIL — `getByTestId('sidebar-session-list')` throws while the empty state is showing (today the container is unmounted when `sortedItems.length === 0`).

- [ ] **Step 3: Hoist the scroll container**

In `src/components/Sidebar.tsx`, replace the entire `{/* Session List */}` inner ternary (lines 786-851) so the scroller wraps every state. The result (all inner content is the EXISTING code, only the wrapping changes — the `sortedItems.map` body at 824-846 is unchanged):

```tsx
      {/* Session List */}
      <div className="flex flex-1 min-h-0 flex-col">
        <div className="flex-1 min-h-0 px-2">
          <div
            ref={listRef}
            data-testid="sidebar-session-list"
            className="h-full overflow-y-auto"
            onScroll={handleListScroll}
          >
            {showBlockingLoad ? (
              <div
                className="flex items-center justify-center py-8"
                data-testid={hasRequestedQuery ? 'search-loading' : undefined}
              >
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                <span className="ml-2 text-sm text-muted-foreground">
                  {hasRequestedQuery ? 'Searching...' : 'Loading sessions...'}
                </span>
              </div>
            ) : sortedItems.length === 0 ? (
              showDeepSearchPending ? (
                <div className="flex items-center justify-center py-8" role="status" aria-live="polite">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
                  <span className="ml-2 text-sm text-muted-foreground">Scanning files...</span>
                </div>
              ) : (
                <div className="px-2 py-8 text-center text-sm text-muted-foreground">
                  {repoFilter !== ALL_REPOS
                    ? 'No sessions in selected repo'
                    : visibleQuery && visibleSearchTier !== 'title'
                    ? 'No results found'
                    : visibleQuery
                    ? 'No matching sessions'
                    : 'No sessions yet'}
                </div>
              )
            ) : (
              <div ref={listContentRef}>
                {sortedItems.map((item) => {
                  const sessionKey = `${item.provider}:${item.sessionId}`
                  const isActive = computeIsActive({
                    isRunning: item.isRunning,
                    runningTerminalId: item.runningTerminalId,
                    sessionKey,
                    activeSessionKey,
                    activeTerminalId,
                  })

                  return (
                    <div key={sessionKey} className="pb-0.5">
                      <SidebarItem
                        item={item}
                        isActiveTab={isActive}
                        isBusy={busySessionKeySet.has(sessionKey)}
                        showProjectBadge={settings.sidebar?.showProjectBadges}
                        onClick={() => handleItemClick(item)}
                        timestampTick={timestampTick}
                      />
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
```

Bonus effect (intentional): `listRef.current` is now non-null in the empty state, so the viewport backfill (`getListMetrics`/`maybeBackfillViewport`, `Sidebar.tsx:532-599`) can recover from a transient-empty filtered list instead of going inert. This cannot fetch-storm: the backfill walk is a bounded sequential page walk (monotonic cursor, terminated by server `hasMore`), and a truly-empty window is inert via the cursor-null guard. Known PRE-EXISTING edge, deliberately out of scope for this plan: a persistently FAILING append retries with no backoff (`window.error` is never consulted by the backfill effect) — this task merely extends that pathology's reachability to the empty state; do not attempt to fix it here.

- [ ] **Step 4: Run the sidebar suites to verify pass and catch structural-contract fallout**

Run: `npm run test:vitest -- --run test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.dom-stability.test.tsx test/unit/client/components/Sidebar.render-stability.test.tsx test/e2e/sidebar-repo-filter-flow.test.tsx test/e2e/sidebar-refresh-dom-stability.test.tsx test/e2e/sidebar-search-flow.test.tsx`
Expected: the new test PASSES. If any pre-existing test fails, it can only be because it asserted the OLD structure (e.g. `queryByTestId('sidebar-session-list')` absent during loading/empty, or `search-loading` as a sibling of the container). Update ONLY such assertions to the new contract (container always mounted; loading/empty content inside it) — do not weaken any other assertion. The mount-stability tests ("keeps ... mounted") assert presence and should pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add test/unit/client/components/Sidebar.test.tsx src/components/Sidebar.tsx
git commit -m "fix(sidebar): keep session-list scroll container mounted across empty/loading states"
```

---

### Task 3: Depth-preserving silent refresh — stop the truncate/re-paginate churn (jump fix, part 2)

Root cause of "updates every few seconds, jumps to top, re-sorts": every WS `sessions.changed` triggers `queueActiveSessionWindowRefresh` → `refreshVisibleSessionWindowSilently`, whose browse path fetches page 1 only (`limit: 50`, `sessionsThunks.ts:431-435`) and commits it via `commitSessionWindowVisibleRefresh`, which REPLACES the window (`commitWindowPayload`, `sessionsSlice.ts:139-155`). Pages 2..N loaded by infinite scroll / viewport backfill are discarded; the backfill effect (keyed on `lastLoadedAt`) immediately re-appends them. The row count sawtooths; content shrink clamps `scrollTop` to 0; re-appends re-sort in front of the user. A selected repo filter amplifies this because its visible rows come from the deeper pages. The main page never truncates because it never grows past page 1 — the sidebar equivalent is: a silent refresh must never shrink the loaded window.

Fix: merge the fresh page 1 OVER the existing window (fresh wins for overlapping sessions; previously loaded deeper sessions retained) and keep the deeper pagination cursor + `hasMore`, so backfill has nothing to re-walk.

Companion change (same task, steps 4-6): because the merge deliberately stops the silent refresh from removing vanished sessions, and refresh-replace is today the ONLY mechanism that removes a deleted session from sidebar state (verified: no targeted removal action is ever dispatched in production), a client-initiated delete would otherwise leave the deleted row visibly in place — it sorts by recency, not "below page 1". Fix: a small `removeSessionFromProjects` reducer dispatched from both delete flows, so deletes propagate immediately and don't depend on refresh semantics at all. Sessions deleted EXTERNALLY (another client/server-side) that sit in a deeper-than-page-1 window still linger until a window rebuild — an accepted, documented residual (rare case; the alternative full replace reintroduces the exact churn this task removes).

**Files:**
- Modify: `src/store/sessionsThunks.ts:431-446` (browse path of `refreshVisibleSessionWindowSilently`)
- Modify: `src/store/sessionsSlice.ts` (new `removeSessionFromProjects` reducer + export)
- Modify: `src/components/context-menu/ContextMenuProvider.tsx:506-542` (delete flow dispatch)
- Modify: `src/components/HistoryView.tsx:111-116` (delete flow dispatch)
- Test: `test/unit/client/store/sessionsThunks.test.ts` (two new tests inside `describe('sessionsThunks')`)
- Test: `test/unit/client/store/sessionsSlice.test.ts` (new `describe('removeSessionFromProjects')`)
- Test: `test/unit/client/components/ContextMenuProvider.test.tsx` (delete-flow wiring test)
- Test: `test/e2e/open-tab-session-sidebar-visibility.test.tsx` (one assertion updated to the new refresh contract — see Step 7)

**Interfaces:**
- Consumes: module-private `mergeProjects(existing, incoming)` (`sessionsThunks.ts:142-179` — keeps `existing`'s session objects, appends `incoming` sessions not already present, keyed by provider:sessionId) and `countSessions(projects)` (same file, already used at line 542). Both are in scope at line 431. NOTE: `sessionsSlice.ts` also exports an unrelated Redux action named `mergeProjects` — do not touch it.
- Produces: refresh commit payload semantics relied on by the sidebar backfill effect (`Sidebar.tsx:581-591`): after a silent browse refresh, `windows.sidebar.projects` is a superset of what was loaded, and `oldestLoadedTimestamp`/`oldestLoadedSessionId`/`hasMore` still describe the deepest loaded point.

- [ ] **Step 1: Write the failing truncation test**

Add to `test/unit/client/store/sessionsThunks.test.ts`, inside `describe('sessionsThunks')` (place after the test `'keeps a visible refresh committable when requested state drifts again but the visible result set identity is unchanged'`, ~line 1235). The file's harness already provides `createStoreWithSessions`, the mocked `fetchSidebarSessionsSnapshot` vi.fn, and `queueActiveSessionWindowRefresh`:

```ts
  it('preserves deeper loaded pages when a live refresh returns only page 1 (no truncation)', async () => {
    const pageOneProject = {
      projectPath: '/tmp/project-a',
      sessions: [{
        provider: 'claude',
        sessionId: 'session-new',
        projectPath: '/tmp/project-a',
        lastActivityAt: 5_000,
        title: 'Newest session',
      }],
    }
    const deepProject = {
      projectPath: '/tmp/project-b',
      sessions: [{
        provider: 'claude',
        sessionId: 'session-old',
        projectPath: '/tmp/project-b',
        lastActivityAt: 1_000,
        title: 'Old paginated session',
      }],
    }
    const store = createStoreWithSessions({
      activeSurface: 'sidebar',
      projects: [pageOneProject, deepProject],
      lastLoadedAt: 5_000,
      windows: {
        sidebar: {
          projects: [pageOneProject, deepProject],
          lastLoadedAt: 5_000,
          query: '',
          searchTier: 'title',
          appliedQuery: '',
          appliedSearchTier: 'title',
          loading: false,
          // The user (or viewport backfill) paginated past page 1:
          hasMore: false,
          oldestLoadedTimestamp: 1_000,
          oldestLoadedSessionId: 'claude:session-old',
        },
      },
    })

    // The live refresh only ever fetches page 1 (limit 50) — it does not
    // contain the deeper session, and its cursor points at the fresh page.
    fetchSidebarSessionsSnapshot.mockResolvedValue({
      projects: [{
        ...pageOneProject,
        sessions: [{
          ...pageOneProject.sessions[0],
          title: 'Newest session (refreshed)',
          lastActivityAt: 6_000,
        }],
      }],
      totalSessions: 1,
      oldestIncludedTimestamp: 6_000,
      oldestIncludedSessionId: 'claude:session-new',
      hasMore: true,
    })

    await store.dispatch(queueActiveSessionWindowRefresh() as any)

    const windowState = store.getState().sessions.windows.sidebar
    const allSessions = windowState.projects.flatMap((p: any) => p.sessions)
    // Fresh page-1 data wins for overlapping sessions...
    expect(allSessions.find((s: any) => s.sessionId === 'session-new')?.title)
      .toBe('Newest session (refreshed)')
    // ...and previously paginated deeper sessions are NOT dropped.
    expect(allSessions.some((s: any) => s.sessionId === 'session-old')).toBe(true)
    // The cursor + hasMore still describe the deepest loaded point, so the
    // viewport backfill does not re-walk pages after every refresh.
    expect(windowState.oldestLoadedTimestamp).toBe(1_000)
    expect(windowState.oldestLoadedSessionId).toBe('claude:session-old')
    expect(windowState.hasMore).toBe(false)
    expect(windowState.totalSessions).toBe(2)
  })

  it('replaces the window on refresh when no deeper pages were loaded', async () => {
    const staleProject = {
      projectPath: '/tmp/project-a',
      sessions: [{
        provider: 'claude',
        sessionId: 'session-stale',
        projectPath: '/tmp/project-a',
        lastActivityAt: 5_000,
        title: 'Stale session',
      }],
    }
    const store = createStoreWithSessions({
      activeSurface: 'sidebar',
      projects: [staleProject],
      lastLoadedAt: 5_000,
      windows: {
        sidebar: {
          projects: [staleProject],
          lastLoadedAt: 5_000,
          query: '',
          searchTier: 'title',
          appliedQuery: '',
          appliedSearchTier: 'title',
          loading: false,
          hasMore: true,
          // Only page 1 was ever loaded — cursor sits at the newest page.
          oldestLoadedTimestamp: 5_000,
          oldestLoadedSessionId: 'claude:session-stale',
        },
      },
    })

    const freshProjects = [{
      projectPath: '/tmp/project-c',
      sessions: [{
        provider: 'claude',
        sessionId: 'session-fresh',
        projectPath: '/tmp/project-c',
        lastActivityAt: 3_000,
        title: 'Fresh session',
      }],
    }]
    fetchSidebarSessionsSnapshot.mockResolvedValue({
      projects: freshProjects,
      totalSessions: 1,
      oldestIncludedTimestamp: 3_000,
      oldestIncludedSessionId: 'claude:session-fresh',
      hasMore: false,
    })

    await store.dispatch(queueActiveSessionWindowRefresh() as any)

    const windowState = store.getState().sessions.windows.sidebar
    const allSessions = windowState.projects.flatMap((p: any) => p.sessions)
    // Plain replace: deletions/archival propagate when nothing deeper is at stake.
    expect(allSessions.map((s: any) => s.sessionId)).toEqual(['session-fresh'])
    expect(windowState.oldestLoadedTimestamp).toBe(3_000)
    expect(windowState.oldestLoadedSessionId).toBe('claude:session-fresh')
    expect(windowState.hasMore).toBe(false)
    expect(windowState.totalSessions).toBe(1)
  })
```

- [ ] **Step 2: Run tests to verify the first fails**

Run: `npm run test:vitest -- --run test/unit/client/store/sessionsThunks.test.ts -t "preserves deeper loaded pages"`
Expected: FAIL — `session-old` is dropped (window replaced by page 1) and `oldestLoadedTimestamp` becomes `6_000`.

Run: `npm run test:vitest -- --run test/unit/client/store/sessionsThunks.test.ts -t "replaces the window on refresh when no deeper pages"`
Expected: PASS already (documents the unchanged replace path — keep it as a pin).

- [ ] **Step 3: Implement the depth-preserving merge**

In `src/store/sessionsThunks.ts`, replace the browse-path block of `refreshVisibleSessionWindowSilently` (lines 431-446, the `fetchSidebarSessionsSnapshot` call and the `commitData({...})` after the search paths) with:

```ts
    const response = await fetchSidebarSessionsSnapshot({
      limit: 50,
      signal: controller.signal,
      ...visibilityOpts,
    })
    const nextProjects = Array.isArray(response) ? response : (response?.projects ?? [])
    // A silent refresh must never shrink the loaded window. The sidebar may
    // have paginated past page 1 (infinite scroll / viewport backfill);
    // replacing N loaded pages with page 1 makes the visible row count
    // sawtooth every few seconds, clamps scrollTop to 0 and re-sorts under
    // the user, then forces the backfill to re-walk the same pages. When the
    // existing window is deeper than the fresh page, merge the fresh page
    // over it (fresh session objects win for overlaps; deeper sessions are
    // retained) and keep the deeper cursor + hasMore so backfill stays idle.
    const prevWindow = getState().sessions.windows?.[surface]
    const prevOldestTimestamp = prevWindow?.oldestLoadedTimestamp
    const freshOldestTimestamp = response?.oldestIncludedTimestamp
    const hasDeeperWindow =
      typeof prevOldestTimestamp === 'number' &&
      prevOldestTimestamp > 0 &&
      typeof freshOldestTimestamp === 'number' &&
      freshOldestTimestamp > 0 &&
      prevOldestTimestamp < freshOldestTimestamp
    const projects = hasDeeperWindow
      ? mergeProjects(nextProjects, prevWindow?.projects ?? [])
      : nextProjects
    commitData({
      surface,
      projects,
      totalSessions: hasDeeperWindow ? countSessions(projects) : response?.totalSessions,
      oldestLoadedTimestamp: hasDeeperWindow
        ? prevOldestTimestamp
        : response?.oldestIncludedTimestamp,
      oldestLoadedSessionId: hasDeeperWindow
        ? prevWindow?.oldestLoadedSessionId
        : response?.oldestIncludedSessionId,
      hasMore: hasDeeperWindow ? prevWindow?.hasMore : response?.hasMore,
      query: identity.query,
      searchTier: identity.searchTier,
    })
```

Notes for the implementer:
- `mergeProjects(existing, incoming)` keeps `existing`'s session objects and appends `incoming` sessions not already present — passing the FRESH page as `existing` is deliberate: fresh data wins for overlapping sessions, deeper (old-window-only) sessions are appended.
- `countSessions` already exists in this file (used at line 542 for the search-append merge). Committing the merged count is safe: `windows.*.totalSessions` has no functional readers in `src/` (pagination gates on `hasMore` + cursor), and the search-append path already commits `countSessions(...)`.
- Staleness contract (be precise — the merge NEVER removes anything): a session that vanished from the server keeps its place in the merged window — at whatever position its recency sorts it, including the top — until a window rebuild (initial load, search apply→clear, or a replace-path refresh). Client-initiated deletes are therefore propagated explicitly by Steps 4-6 below; only EXTERNAL deletions can linger, which is the accepted residual. Archive flags on deeper-than-page-1 sessions may likewise lag until rebuild (minor: fresh page 1 covers recent archives).
- Boundary tie: when `prevOldestTimestamp === freshOldestTimestamp`, `hasDeeperWindow` is false and the window is replaced. Accepted: ms-epoch equality at the exact boundary is improbable, and the worst case is a single truncate/backfill cycle (one-time churn, self-healing).
- Do not touch the search paths (lines 388-429) — search refreshes already rebuild the full result set.
- Do NOT reuse `syncAllWindowsFromTopLevel`/`applySessionsPatch` for anything in this task: `syncWindowProjectsFromTopLevel` REPLACES a window's projects with the (possibly shallower) top-level array — the exact truncation this task eliminates. That machinery is dormant in production (never dispatched from `src/`).

- [ ] **Step 4: Write the failing deletion-propagation tests (Red)**

(a) In `test/unit/client/store/sessionsSlice.test.ts`, add `removeSessionFromProjects` to the sessionsSlice import list (lines 4-16; `setProjects` and `commitSessionWindowVisibleRefresh` are already imported — add any that are missing), then insert this new describe after the `applySessionsPatch` describe closes (line 510, immediately before `describe('toggleProjectExpanded'` at line 512):

```ts
  describe('removeSessionFromProjects', () => {
    it('removes the session from top-level projects and every window and prunes empty project groups', () => {
      const projects = [
        {
          projectPath: '/p1',
          sessions: [
            { provider: 'claude', sessionId: 's1', projectPath: '/p1', lastActivityAt: 2 },
            { provider: 'codex', sessionId: 's2', projectPath: '/p1', lastActivityAt: 1 },
          ],
        },
        {
          projectPath: '/p2',
          sessions: [{ provider: 'claude', sessionId: 's3', projectPath: '/p2', lastActivityAt: 3 }],
        },
      ]
      let state = sessionsReducer(undefined, setProjects(projects as any))
      state = sessionsReducer(state, commitSessionWindowVisibleRefresh({
        surface: 'sidebar',
        projects,
        totalSessions: 3,
        hasMore: true,
        oldestLoadedTimestamp: 1,
        oldestLoadedSessionId: 'codex:s2',
      } as any))

      // Removing one session leaves its project — and the window's pagination
      // cursor — intact, in both top-level projects and the sidebar window.
      let next = sessionsReducer(state, removeSessionFromProjects({ provider: 'claude', sessionId: 's1' }))
      const windowSessions = next.windows.sidebar.projects.flatMap((p: any) => p.sessions)
      expect(windowSessions.map((s: any) => `${s.provider}:${s.sessionId}`)).toEqual(['codex:s2', 'claude:s3'])
      expect(next.projects.flatMap((p: any) => p.sessions).some((s: any) => s.sessionId === 's1')).toBe(false)
      expect(next.windows.sidebar.oldestLoadedTimestamp).toBe(1)
      expect(next.windows.sidebar.hasMore).toBe(true)

      // Removing a project's last session prunes the empty group everywhere.
      next = sessionsReducer(next, removeSessionFromProjects({ provider: 'claude', sessionId: 's3' }))
      expect(next.projects.map((p: any) => p.projectPath)).toEqual(['/p1'])
      expect(next.windows.sidebar.projects.map((p: any) => p.projectPath)).toEqual(['/p1'])
    })
  })
```

(b) In `test/unit/client/components/ContextMenuProvider.test.tsx` (describe `'ContextMenuProvider'`, line 616; `api.delete` is already mocked to resolve at lines 57/71), add one wiring test for the sidebar-session delete flow. No existing test exercises delete, so mirror the harness idioms of the existing rename-session test in the same file (menu invocation on a sidebar-session target, modal interaction): trigger `Delete session`, confirm the modal, then assert (1) `api.delete` was called with `/api/sessions/<encoded provider:sessionId>` and (2) the session is gone from BOTH `store.getState().sessions.projects` and `store.getState().sessions.windows.sidebar.projects` without waiting for any refresh to resolve. Bounded judgment: reuse the file's existing store/render/menu helpers exactly as the neighboring tests do — only the action under test and the two store assertions are new.

- [ ] **Step 5: Run tests to verify they fail**

Run: `npm run test:vitest -- --run test/unit/client/store/sessionsSlice.test.ts -t "removeSessionFromProjects"`
Expected: FAIL — `removeSessionFromProjects` is not exported from `@/store/sessionsSlice`.

Run: `npm run test:vitest -- --run test/unit/client/components/ContextMenuProvider.test.tsx -t "delete"`
Expected: FAIL — the deleted session is still present in store state (nothing removes it today).

- [ ] **Step 6: Implement the reducer and wire the delete flows**

(a) In `src/store/sessionsSlice.ts`, add the reducer after `setProjectExpanded` (after line 498, before the `},` that closes `reducers` at line 499) — it deliberately mirrors `patchSessionRunningStateFromTerminalMeta`'s iterate-top-level-AND-every-window model (lines 401-414), applying to search windows too, and leaves cursors/`hasMore`/`totalSessions` untouched (removal does not change window depth):

```ts
    removeSessionFromProjects: (state, action: PayloadAction<{ provider?: string; sessionId: string }>) => {
      const key = sessionKey(action.payload)
      const removeFrom = (projects: ProjectGroup[]) =>
        projects
          .map((project) => ({
            ...project,
            sessions: (project.sessions || []).filter((s) => sessionKey(s) !== key),
          }))
          .filter((project) => project.sessions.length > 0)
      state.projects = removeFrom(state.projects || [])
      if (state.windows) {
        for (const window of Object.values(state.windows)) {
          if (!window) continue
          window.projects = removeFrom(window.projects || [])
        }
      }
    },
```

Then add `removeSessionFromProjects` to the action re-export list (after `setProjectExpanded,` at line 520). `sessionKey` (lines 29-31) and `PayloadAction` are already in scope.

(b) In `src/components/context-menu/ContextMenuProvider.tsx`: extend the line 17 import to `import { removeSessionFromProjects, setProjectExpanded } from '@/store/sessionsSlice'`, and in `deleteSession`'s `onConfirm` (lines 532-534) dispatch the removal between the API call and the refresh:

```tsx
          const compositeKey = `${provider || info.session.provider || 'claude'}:${sessionId}`
          await api.delete(`/api/sessions/${encodeURIComponent(compositeKey)}`)
          // The depth-preserving silent refresh (this task) no longer removes
          // vanished sessions — propagate the delete explicitly and immediately.
          dispatch(removeSessionFromProjects({ provider: provider || info.session.provider, sessionId }))
          await dispatch(refreshActiveSessionWindow() as any)
```

(c) In `src/components/HistoryView.tsx`: extend the line 4 import to `import { removeSessionFromProjects, toggleProjectExpanded } from '@/store/sessionsSlice'`, and in `deleteSession` (lines 111-116) dispatch the removal after `api.delete`, before `refresh()`:

```ts
    await api.delete(`/api/sessions/${encodeURIComponent(compositeKey)}`)
    dispatch(removeSessionFromProjects({ provider, sessionId }))
    await refresh()
```

- [ ] **Step 7: Update the one pinned-contract e2e assertion, then run the suites**

`test/e2e/open-tab-session-sidebar-visibility.test.tsx` line 800, inside the test `'keeps the loaded sidebar visible during an invalidation burst and queues at most one follow-up refresh'` (lines 688-802), currently pins the OLD replace semantics: its fixture preloads a sidebar window with `oldestLoadedTimestamp: 10` and resolves a fresh snapshot with `oldestIncludedTimestamp: 11` — exactly the `hasDeeperWindow` configuration this task turns into a merge — and asserts `expect(screen.queryByText('Recent Session')).not.toBeInTheDocument()`. Under the new, deliberate contract a silent refresh never shrinks a deeper-than-fresh-page window, so `Recent Session` is now retained (until a window rebuild). Update ONLY line 800 to:

```tsx
    // Depth-preserving refresh contract (see refreshVisibleSessionWindowSilently):
    // a silent refresh never shrinks a deeper-than-fresh-page window, so the
    // previously loaded session is retained alongside the fresh page.
    expect(screen.getAllByText('Recent Session').length).toBeGreaterThan(0)
```

Every other assertion in that test (burst coalescing at lines 773/801, `Older Open Session` appearing, `Recent Session` staying visible mid-refresh) is the test's actual purpose and MUST remain unchanged. Do not touch the sibling test at lines 559-686 (its fresh cursor `1` < prev `10` is not deeper → replace path → passes unchanged).

Then run:
`npm run test:vitest -- --run test/unit/client/store/sessionsThunks.test.ts test/unit/client/store/sessionsSlice.test.ts test/unit/client/store/sidebar-staleness.test.ts test/unit/client/components/ContextMenuProvider.test.tsx test/e2e/sidebar-refresh-dom-stability.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx`
Expected: PASS (all new tests, the updated e2e pin, and all existing refresh/coalescing tests — the thunk change only affects the browse commit payload, not identity gating, coalescing, or loading-state handling; `sidebar-staleness.test.ts` still passes because its fixture has no pagination cursor → replace path).

- [ ] **Step 8: Commit**

```bash
git add src/store/sessionsThunks.ts src/store/sessionsSlice.ts src/components/context-menu/ContextMenuProvider.tsx src/components/HistoryView.tsx test/unit/client/store/sessionsThunks.test.ts test/unit/client/store/sessionsSlice.test.ts test/unit/client/components/ContextMenuProvider.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx
git commit -m "fix(sidebar): depth-preserving live refresh with immediate delete propagation"
```

---

### Task 4: Deterministic sort tie-break (jump fix, part 3)

`sortSessionItems` (`sidebarSelectors.ts:634-714`) sorts on live fields (`ratchetedActivity ?? timestamp`) with no stable tie-break, so equal-timestamp rows can swap order across recomputes (input order follows the server's re-ordered projects). Add a provider+sessionId tie-break so identical data always yields identical order.

**Files:**
- Modify: `src/store/selectors/sidebarSelectors.ts:634-714` (`sortSessionItems`)
- Test: `test/unit/client/store/selectors/sidebarSelectors.test.ts` (inside `describe('sortSessionItems')`, line ~997)

**Interfaces:**
- Consumes: `createSessionItem(overrides: Partial<SidebarSessionItem>): SidebarSessionItem` factory already defined at the top of the test file (line 13).
- Produces: stable ordering guarantee relied on (implicitly) by `useStableArray` in `Sidebar.tsx:340` — identical input data now always produces identical order, so no spurious row moves.

- [ ] **Step 1: Write the failing tie-break test**

Add inside `describe('sortSessionItems', ...)` in `test/unit/client/store/selectors/sidebarSelectors.test.ts`:

```ts
    describe('tie-breaking', () => {
      it('breaks equal-timestamp ties deterministically by provider + sessionId', () => {
        const items = [
          createSessionItem({ id: 'b', sessionId: 'bbb', timestamp: 1000 }),
          createSessionItem({ id: 'c', sessionId: 'ccc', timestamp: 1000 }),
          createSessionItem({ id: 'a', sessionId: 'aaa', timestamp: 1000 }),
        ]

        const activityOrder = sortSessionItems(items, 'activity')
        const activityReversed = sortSessionItems([...items].reverse(), 'activity')
        const recencyReversed = sortSessionItems([...items].reverse(), 'recency')

        // Same data in any input order yields the same output order.
        expect(activityOrder.map((i) => i.sessionId)).toEqual(['aaa', 'bbb', 'ccc'])
        expect(activityReversed.map((i) => i.sessionId)).toEqual(['aaa', 'bbb', 'ccc'])
        expect(recencyReversed.map((i) => i.sessionId)).toEqual(['aaa', 'bbb', 'ccc'])
      })
    })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- --run test/unit/client/store/selectors/sidebarSelectors.test.ts -t "breaks equal-timestamp ties"`
Expected: FAIL — with equal timestamps, V8's stable sort preserves input order, so the reversed input yields `['ccc', 'bbb', 'aaa']` (or similar input-order-dependent result).

- [ ] **Step 3: Add the tie-break comparator**

In `src/store/selectors/sidebarSelectors.ts`, inside `sortSessionItems` (line 634), add one helper immediately after the `archived` partition (line 642) and thread it into EVERY time-based comparator return in the function:

```ts
  const compareBySessionKey = (a: SidebarSessionItem, b: SidebarSessionItem) =>
    a.provider.localeCompare(b.provider) || a.sessionId.localeCompare(b.sessionId)
```

Then apply the exact transformation `return <timeExpr>` → `return <timeExpr> || compareBySessionKey(a, b)` to each comparator in this function. The two named comparators become:

```ts
  const compareByRecency = (a: SidebarSessionItem, b: SidebarSessionItem) =>
    b.timestamp - a.timestamp || compareBySessionKey(a, b)
  const compareByActivity = (a: SidebarSessionItem, b: SidebarSessionItem) => {
    const aHasRatcheted = typeof a.ratchetedActivity === 'number'
    const bHasRatcheted = typeof b.ratchetedActivity === 'number'
    if (aHasRatcheted !== bHasRatcheted) return aHasRatcheted ? -1 : 1
    const aTime = a.ratchetedActivity ?? a.timestamp
    const bTime = b.ratchetedActivity ?? b.timestamp
    return bTime - aTime || compareBySessionKey(a, b)
  }
```

And the inline `withTabs` sort in the `'activity'` branch becomes:

```ts
      withTabs.sort((a, b) => {
        const aTime = a.ratchetedActivity ?? a.timestamp
        const bTime = b.ratchetedActivity ?? b.timestamp
        return bTime - aTime || compareBySessionKey(a, b)
      })
```

Apply the same `|| compareBySessionKey(a, b)` suffix to the `withoutTabs` inline sort and to any other `b.timestamp - a.timestamp` / `bTime - aTime` comparator return remaining inside `sortSessionItems` (e.g. the `'project'` mode's within-group recency comparison, if present). Do not change any non-time comparison (e.g. project-name `localeCompare` ordering) other than appending the tie-break after it if it is the final comparison of a comparator.

- [ ] **Step 4: Run tests to verify pass**

Run: `npm run test:vitest -- --run test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/sidebar-staleness.test.ts test/unit/client/components/Sidebar.test.tsx`
Expected: PASS. If an existing sort test pinned an equal-timestamp order that relied on input order, update that expectation to the deterministic provider+sessionId order (this is the intended behavior change; nothing else may change).

- [ ] **Step 5: Commit**

```bash
git add src/store/selectors/sidebarSelectors.ts test/unit/client/store/selectors/sidebarSelectors.test.ts
git commit -m "fix(sidebar): deterministic tie-break in session sort comparators"
```

---

### Task 5: Pure agent-filter helpers with unit tests

**Files:**
- Create: `test/unit/client/store/sidebar-agent-filter.test.ts`
- Modify: `src/store/selectors/sidebarSelectors.ts` (add exports immediately after `collectRepoFilterOptions`, line ~565)

**Interfaces:**
- Consumes: `SidebarSessionItem.sessionType: string` (always non-empty; defaults to `provider`).
- Produces (used verbatim by Tasks 6-9):
  - `export const ALL_AGENTS = 'all'`
  - `export interface AgentFilterOption { value: string; label: string }`
  - `export function filterSessionItemsByAgent(items: SidebarSessionItem[], agentFilter: string): SidebarSessionItem[]` — identity fast-path (same array reference) when `agentFilter === ALL_AGENTS`, else keeps items with `item.sessionType === agentFilter`.
  - `export function collectAgentFilterOptions(items: SidebarSessionItem[], selected: string, getLabel: (sessionType: string) => string): AgentFilterOption[]` — dedupes `sessionType`s, retains a non-ALL `selected` even if absent, labels via `getLabel`, sorts by label then value.

- [ ] **Step 1: Write the failing unit tests**

Create `test/unit/client/store/sidebar-agent-filter.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  ALL_AGENTS,
  collectAgentFilterOptions,
  filterSessionItemsByAgent,
  type SidebarSessionItem,
} from '@/store/selectors/sidebarSelectors'

function createItem(overrides: Partial<SidebarSessionItem>): SidebarSessionItem {
  return {
    id: 'session-claude-test',
    sessionId: 'test',
    provider: 'claude',
    sessionType: 'claude',
    title: 'Test Session',
    hasTitle: true,
    timestamp: 1000,
    hasTab: false,
    isRunning: false,
    ...overrides,
  }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

describe('filterSessionItemsByAgent', () => {
  it('returns the same array reference for ALL_AGENTS', () => {
    const items = [createItem({ sessionType: 'claude' })]
    expect(filterSessionItemsByAgent(items, ALL_AGENTS)).toBe(items)
  })

  it('filters items to the selected sessionType', () => {
    const items = [
      createItem({ id: '1', sessionId: 's1', sessionType: 'claude' }),
      createItem({ id: '2', sessionId: 's2', sessionType: 'codex' }),
      createItem({ id: '3', sessionId: 's3', sessionType: 'freshclaude' }),
    ]
    expect(filterSessionItemsByAgent(items, 'codex').map((i) => i.id)).toEqual(['2'])
    expect(filterSessionItemsByAgent(items, 'freshclaude').map((i) => i.id)).toEqual(['3'])
  })

  it('returns an empty array when no items match', () => {
    const items = [createItem({ sessionType: 'claude' })]
    expect(filterSessionItemsByAgent(items, 'opencode')).toEqual([])
  })
})

describe('collectAgentFilterOptions', () => {
  it('dedupes agent kinds and sorts by label', () => {
    const items = [
      createItem({ id: '1', sessionId: 's1', sessionType: 'codex' }),
      createItem({ id: '2', sessionId: 's2', sessionType: 'claude' }),
      createItem({ id: '3', sessionId: 's3', sessionType: 'claude' }),
    ]
    expect(collectAgentFilterOptions(items, ALL_AGENTS, capitalize)).toEqual([
      { value: 'claude', label: 'Claude' },
      { value: 'codex', label: 'Codex' },
    ])
  })

  it('labels options through the provided getLabel function', () => {
    const items = [createItem({ sessionType: 'codex' })]
    const options = collectAgentFilterOptions(items, ALL_AGENTS, () => 'Codex CLI')
    expect(options).toEqual([{ value: 'codex', label: 'Codex CLI' }])
  })

  it('retains the current selection even when its rows are absent', () => {
    const items = [createItem({ sessionType: 'claude' })]
    const options = collectAgentFilterOptions(items, 'codex', capitalize)
    expect(options.map((o) => o.value)).toEqual(['claude', 'codex'])
  })

  it('does not add a retention entry for ALL_AGENTS', () => {
    const options = collectAgentFilterOptions([], ALL_AGENTS, capitalize)
    expect(options).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- --run test/unit/client/store/sidebar-agent-filter.test.ts`
Expected: FAIL — module has no export `ALL_AGENTS` / `collectAgentFilterOptions` / `filterSessionItemsByAgent`.

- [ ] **Step 3: Implement the helpers**

In `src/store/selectors/sidebarSelectors.ts`, immediately after `collectRepoFilterOptions` (after line ~565), add:

```ts
// 'all' cannot collide with a real sessionType in practice; mirrors ALL_REPOS.
export const ALL_AGENTS = 'all'

export interface AgentFilterOption {
  value: string
  label: string
}

export function filterSessionItemsByAgent(
  items: SidebarSessionItem[],
  agentFilter: string,
): SidebarSessionItem[] {
  if (agentFilter === ALL_AGENTS) return items
  return items.filter((item) => item.sessionType === agentFilter)
}

export function collectAgentFilterOptions(
  items: SidebarSessionItem[],
  selected: string,
  getLabel: (sessionType: string) => string,
): AgentFilterOption[] {
  const types = new Set<string>()
  for (const item of items) {
    if (item.sessionType) types.add(item.sessionType)
  }
  if (selected !== ALL_AGENTS) types.add(selected)
  return [...types]
    .map((value) => ({ value, label: getLabel(value) }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value))
}
```

(`getLabel` is injected rather than hardcoded because label resolution needs the extensions registry from Redux state — the pure helper stays state-free, mirroring how `collectRepoFilterOptions` uses the module's `getProjectName`.)

- [ ] **Step 4: Run tests to verify pass**

Run: `npm run test:vitest -- --run test/unit/client/store/sidebar-agent-filter.test.ts test/unit/client/store/sidebar-repo-filter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/selectors/sidebarSelectors.ts test/unit/client/store/sidebar-agent-filter.test.ts
git commit -m "feat(sidebar): add pure agent-filter helpers (ALL_AGENTS, filter, options)"
```

---

### Task 6: Agent dropdown in the Sidebar — filters and ANDs with the repo filter

**Files:**
- Modify: `src/components/Sidebar.tsx` (imports; state near line 237; memo chain at 319-340; JSX after the repo-filter block ending line 738)
- Test: `test/unit/client/components/Sidebar.test.tsx` (new `describe('Agent filter dropdown')` after the repo-filter describe block)

**Interfaces:**
- Consumes: Task 5 exports; `resolveSessionTypeConfig(sessionType, extensions?): { icon, label }` from `@/lib/session-type-utils` (already imported in Sidebar.tsx line 11); `s.extensions?.entries` Redux state (`ClientExtensionEntry[]`); `createTestStore` (which preloads extensions entries labeled `Claude CLI` / `Codex CLI`).
- Produces: `<select aria-label="Agent filter">` with first option text `All agents` / value `all`; component-local state `agentFilter`/`setAgentFilter` initialized to `ALL_AGENTS`; `computedItems` = repo-filter output further filtered by agent. Tasks 7-9 depend on these exact handles.

- [ ] **Step 1: Write the failing component tests**

In `test/unit/client/components/Sidebar.test.tsx`, add a new describe block immediately after `describe('Repo filter dropdown')` closes:

```tsx
    describe('Agent filter dropdown', () => {
      const agentProjects: ProjectGroup[] = [
        {
          projectPath: '/home/user/repo-alpha',
          sessions: [
            {
              provider: 'claude',
              sessionId: sessionId('agent-alpha-claude'),
              projectPath: '/home/user/repo-alpha',
              lastActivityAt: Date.now() - 1000,
              title: 'Alpha claude session',
              cwd: '/home/user/repo-alpha',
            },
            {
              provider: 'codex',
              sessionId: sessionId('agent-alpha-codex'),
              projectPath: '/home/user/repo-alpha',
              lastActivityAt: Date.now() - 2000,
              title: 'Alpha codex session',
              cwd: '/home/user/repo-alpha',
            },
          ],
        },
        {
          projectPath: '/home/user/repo-beta',
          sessions: [
            {
              provider: 'codex',
              sessionId: sessionId('agent-beta-codex'),
              projectPath: '/home/user/repo-beta',
              lastActivityAt: Date.now() - 3000,
              title: 'Beta codex session',
              cwd: '/home/user/repo-beta',
            },
          ],
        },
      ]

      it('renders the agent dropdown defaulting to All agents with one option per agent kind', async () => {
        const store = createTestStore({ projects: agentProjects })
        const { getByRole } = renderSidebar(store, [])
        await act(() => vi.advanceTimersByTime(100))

        const select = getByRole('combobox', { name: /agent filter/i }) as HTMLSelectElement
        expect(select).toHaveValue('all')
        // Labels come from the extensions registry (createTestStore preloads
        // 'Claude CLI' / 'Codex CLI'), sorted by label.
        expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
          'All agents',
          'Claude CLI',
          'Codex CLI',
        ])
        expect(Array.from(select.options).map((o) => o.value)).toEqual([
          'all',
          'claude',
          'codex',
        ])
      })

      it('filters the list to the selected agent', async () => {
        const store = createTestStore({ projects: agentProjects })
        const { getByRole } = renderSidebar(store, [])
        await act(() => vi.advanceTimersByTime(100))

        fireEvent.change(getByRole('combobox', { name: /agent filter/i }), {
          target: { value: 'codex' },
        })

        expect(screen.getByText('Alpha codex session')).toBeInTheDocument()
        expect(screen.getByText('Beta codex session')).toBeInTheDocument()
        expect(screen.queryByText('Alpha claude session')).not.toBeInTheDocument()
      })

      it('ANDs with the repo filter', async () => {
        const store = createTestStore({ projects: agentProjects })
        const { getByRole } = renderSidebar(store, [])
        await act(() => vi.advanceTimersByTime(100))

        fireEvent.change(getByRole('combobox', { name: /repo filter/i }), {
          target: { value: '/home/user/repo-alpha' },
        })
        fireEvent.change(getByRole('combobox', { name: /agent filter/i }), {
          target: { value: 'codex' },
        })

        expect(screen.getByText('Alpha codex session')).toBeInTheDocument()
        expect(screen.queryByText('Alpha claude session')).not.toBeInTheDocument()
        expect(screen.queryByText('Beta codex session')).not.toBeInTheDocument()
      })

      it('does not render the dropdown when no sessions are loaded', async () => {
        const store = createTestStore({ projects: [] })
        const { queryByRole } = renderSidebar(store, [])
        await act(() => vi.advanceTimersByTime(100))

        expect(queryByRole('combobox', { name: /agent filter/i })).not.toBeInTheDocument()
      })
    })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- --run test/unit/client/components/Sidebar.test.tsx -t "Agent filter dropdown"`
Expected: FAIL — no combobox named "Agent filter" exists.

- [ ] **Step 3: Wire the agent filter into Sidebar**

In `src/components/Sidebar.tsx`:

(a) Extend the sidebarSelectors import (lines 15-21):

```tsx
import {
  ALL_AGENTS,
  ALL_REPOS,
  collectAgentFilterOptions,
  collectRepoFilterOptions,
  filterSessionItemsByAgent,
  filterSessionItemsByRepo,
  makeSelectSortedSessionItems,
  type SidebarSessionItem,
} from '@/store/selectors/sidebarSelectors'
```

(b) Add state directly below the `repoFilter` state (line ~237):

```tsx
  // Agent filter is deliberately component-local and never persisted:
  // a browser refresh must reset it to 'all' (spec requirement).
  const [agentFilter, setAgentFilter] = useState<string>(ALL_AGENTS)
```

(c) Extend the memo chain (lines 319-340). Add an extensions subscription and the agent options/filter between `repoOptions` and `computedItems`, and thread the agent filter into `computedItems`:

```tsx
  const extensionEntries = useAppSelector((s) => s.extensions?.entries)
  // Options come from the PRE-filter list so every agent kind stays listed
  // while one is selected; the current selection is retained even if its
  // rows are temporarily absent, keeping the controlled select valid.
  const agentOptions = useMemo(
    () => collectAgentFilterOptions(
      localFilteredItems,
      agentFilter,
      (sessionType) => resolveSessionTypeConfig(sessionType, extensionEntries).label,
    ),
    [localFilteredItems, agentFilter, extensionEntries],
  )
  // ANDs: selector pipeline (visibility + applied search + sort) → repo → agent.
  const computedItems = useMemo(
    () => filterSessionItemsByAgent(
      filterSessionItemsByRepo(localFilteredItems, repoFilter),
      agentFilter,
    ),
    [localFilteredItems, repoFilter, agentFilter],
  )
```

(`resolveSessionTypeConfig` is already imported at line 11. The existing `repoOptions` memo and the `sortedItems = useStableArray(computedItems, isSessionItemEqual)` line stay exactly as they are.)

(d) Add the dropdown JSX immediately AFTER the repo-filter block (after line 738's closing `)}`), inside the `{/* Search */}` section, mirroring the repo filter exactly:

```tsx
        {agentOptions.length > 0 && (
          <div className="mt-2 flex items-center gap-1">
            <select
              aria-label="Agent filter"
              value={agentFilter}
              onChange={(e) => setAgentFilter(e.target.value || ALL_AGENTS)}
              className="min-w-0 flex-1 h-7 px-2 text-xs bg-muted/50 border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border"
            >
              <option value={ALL_AGENTS}>All agents</option>
              {agentOptions.map((option) => (
                <option key={option.value} value={option.value} title={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        )}
```

(The clear-x button is Task 7.)

- [ ] **Step 4: Run tests to verify pass**

Run: `npm run test:vitest -- --run test/unit/client/components/Sidebar.test.tsx`
Expected: PASS — all new agent tests plus the full existing Sidebar suite (repo-filter tests use `{ name: /repo filter/i }` queries, so the second combobox does not collide).

- [ ] **Step 5: Commit**

```bash
git add src/components/Sidebar.tsx test/unit/client/components/Sidebar.test.tsx
git commit -m "feat(sidebar): agent filter dropdown that ANDs with repo filter and search"
```

---

### Task 7: Agent clear-x button and agent-aware empty state

**Files:**
- Modify: `src/components/Sidebar.tsx` (agent dropdown block from Task 6; empty-state ternary inside the scroll container from Task 2)
- Test: `test/unit/client/components/Sidebar.test.tsx` (`describe('Agent filter dropdown')`)

**Interfaces:**
- Consumes: Task 6's `agentFilter`/`setAgentFilter` and dropdown block; Task 2's relocated empty-state div; `createDeferred` and `mockSearchSessions` already in the test file's harness.
- Produces: clear button `aria-label="Clear agent filter"`; empty-state string `No sessions for selected agent` (repo message takes precedence when both filters are active).

- [ ] **Step 1: Write the failing tests**

Add to `describe('Agent filter dropdown')`:

```tsx
      it('shows a clear (x) button only while an agent is selected and it resets to All agents', async () => {
        const store = createTestStore({ projects: agentProjects })
        const { getByRole, queryByLabelText, getByLabelText } = renderSidebar(store, [])
        await act(() => vi.advanceTimersByTime(100))

        expect(queryByLabelText('Clear agent filter')).not.toBeInTheDocument()

        fireEvent.change(getByRole('combobox', { name: /agent filter/i }), {
          target: { value: 'codex' },
        })
        expect(screen.queryByText('Alpha claude session')).not.toBeInTheDocument()

        fireEvent.click(getByLabelText('Clear agent filter'))

        expect(getByRole('combobox', { name: /agent filter/i })).toHaveValue('all')
        expect(screen.getByText('Alpha claude session')).toBeInTheDocument()
        expect(queryByLabelText('Clear agent filter')).not.toBeInTheDocument()
      })

      it('keeps the selected agent option and shows an agent-aware empty state when a search empties the window', async () => {
        const searchRequest = createDeferred<any>()
        vi.mocked(mockSearchSessions).mockReturnValueOnce(searchRequest.promise)

        const store = createTestStore({ projects: agentProjects })
        const { getByRole, getByPlaceholderText } = renderSidebar(store, [])
        await act(() => vi.advanceTimersByTime(100))

        fireEvent.change(getByRole('combobox', { name: /agent filter/i }), {
          target: { value: 'codex' },
        })

        fireEvent.change(getByPlaceholderText('Search...'), { target: { value: 'zeta' } })
        await act(async () => {
          vi.advanceTimersByTime(300)
          await Promise.resolve()
        })
        await act(async () => {
          searchRequest.resolve({ results: [], tier: 'title', query: 'zeta', totalScanned: 0 })
          await Promise.resolve()
        })

        // Selection survives the (empty) search commit and remains a valid option.
        const select = getByRole('combobox', { name: /agent filter/i }) as HTMLSelectElement
        expect(select).toHaveValue('codex')
        expect(Array.from(select.options).map((o) => o.value)).toContain('codex')

        // Empty state names the agent filter as a possible cause.
        expect(screen.getByText('No sessions for selected agent')).toBeInTheDocument()
      })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- --run test/unit/client/components/Sidebar.test.tsx -t "Agent filter dropdown"`
Expected: the two new tests FAIL (no `Clear agent filter` button; empty state says `No matching sessions` instead of the agent-aware string).

- [ ] **Step 3: Implement clear-x and empty state**

(a) In the agent dropdown block from Task 6, add the clear button after `</select>` (inside the same flex row), mirroring the repo clear-x exactly:

```tsx
            {agentFilter !== ALL_AGENTS ? (
              <button
                aria-label="Clear agent filter"
                onClick={() => setAgentFilter(ALL_AGENTS)}
                className="p-0.5 min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
```

(b) In the empty-state div (now inside the always-mounted scroll container from Task 2), insert the agent branch after the repo branch:

```tsx
                <div className="px-2 py-8 text-center text-sm text-muted-foreground">
                  {repoFilter !== ALL_REPOS
                    ? 'No sessions in selected repo'
                    : agentFilter !== ALL_AGENTS
                    ? 'No sessions for selected agent'
                    : visibleQuery && visibleSearchTier !== 'title'
                    ? 'No results found'
                    : visibleQuery
                    ? 'No matching sessions'
                    : 'No sessions yet'}
                </div>
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm run test:vitest -- --run test/unit/client/components/Sidebar.test.tsx`
Expected: PASS (full file).

- [ ] **Step 5: Commit**

```bash
git add src/components/Sidebar.tsx test/unit/client/components/Sidebar.test.tsx
git commit -m "feat(sidebar): agent filter clear-x and agent-aware empty state"
```

---

### Task 8: Agent filter non-persistence lock + static UI mock

**Files:**
- Modify: `test/unit/client/components/Sidebar.test.tsx` (`describe('Agent filter dropdown')`)
- Modify: `docs/index.html` (after the repo-filter mock select, line ~618)

**Interfaces:**
- Consumes: Task 6/7 wiring; the localStorage byte-snapshot + same-store-remount technique from the repo non-persistence test (`Sidebar.test.tsx:2597-2627`).
- Produces: locked guarantee that the agent selection never touches localStorage or Redux.

- [ ] **Step 1: Write the failing (behavior-locking) test**

Add as the last test of `describe('Agent filter dropdown')`:

```tsx
      it('never persists the selection: localStorage untouched and a fresh mount resets to All agents', async () => {
        const snapshotLocalStorage = () => {
          const entries: Record<string, string | null> = {}
          for (let i = 0; i < window.localStorage.length; i++) {
            const key = window.localStorage.key(i) as string
            entries[key] = window.localStorage.getItem(key)
          }
          return JSON.stringify(entries)
        }

        const store = createTestStore({ projects: agentProjects })
        const first = renderSidebar(store, [])
        await act(() => vi.advanceTimersByTime(100))

        const before = snapshotLocalStorage()
        fireEvent.change(first.getByRole('combobox', { name: /agent filter/i }), {
          target: { value: 'codex' },
        })
        expect(screen.queryByText('Alpha claude session')).not.toBeInTheDocument()
        expect(snapshotLocalStorage()).toBe(before)

        // Remount against the SAME store: client-side "browser refresh".
        // If the selection leaked into Redux or storage, it would survive this.
        cleanup()
        const second = renderSidebar(store, [])
        await act(() => vi.advanceTimersByTime(100))

        expect(second.getByRole('combobox', { name: /agent filter/i })).toHaveValue('all')
        expect(screen.getByText('Alpha claude session')).toBeInTheDocument()
        expect(screen.getByText('Alpha codex session')).toBeInTheDocument()
      })
```

- [ ] **Step 2: Run test — expect PASS (lock, not bug-fix)**

Run: `npm run test:vitest -- --run test/unit/client/components/Sidebar.test.tsx -t "never persists the selection: localStorage untouched and a fresh mount resets to All agents"`
Expected: PASS immediately (the Task 6 implementation is already component-local `useState`). This test is a regression lock, mirroring `ddedf75a`. If it FAILS, the Task 6 implementation leaked state — fix that, do not weaken the test.

- [ ] **Step 3: Add the static mock**

In `docs/index.html`, immediately after the repo-filter mock `</select>` (line ~618), add:

```html
          <select aria-label="Agent filter" disabled style="width:100%;margin-top:6px;height:24px;font-size:11px;background:hsl(0 0% 14%);color:hsl(0 0% 60%);border:0;border-radius:6px;padding:0 6px">
            <option>All agents</option>
            <option>Claude</option>
            <option>Codex</option>
            <option>Opencode</option>
          </select>
```

- [ ] **Step 4: Commit**

```bash
git add test/unit/client/components/Sidebar.test.tsx docs/index.html
git commit -m "test(sidebar): lock agent filter non-persistence; add agent dropdown to UI mock"
```

---

### Task 9: E2E flow coverage for the agent filter

Mirror `test/e2e/sidebar-repo-filter-flow.test.tsx` (the established "e2e" convention for this feature — Vitest+jsdom flow tests rendering the real Sidebar against a real Redux store with only `@/lib/api` and `@/lib/ws-client` mocked; runs under `npm test`).

**Files:**
- Create: `test/e2e/sidebar-agent-filter-flow.test.tsx`

**Interfaces:**
- Consumes: the full harness of `test/e2e/sidebar-repo-filter-flow.test.tsx` (imports lines 1-37, mocks, its local `createStore`, `renderSidebar`, `beforeEach`/`afterEach` with `_resetSessionWindowThunkState` — copy them verbatim into the new file); Tasks 6-7 UI handles. NOTE: this e2e store has NO extensions reducer, so labels fall back to `getProviderLabel`'s capitalization: `Claude` / `Codex`.
- Produces: end-to-end lock on filter, clear-x, and three-way ANDing (agent × repo × committed server search).

- [ ] **Step 1: Create the flow test (Red)**

Create `test/e2e/sidebar-agent-filter-flow.test.tsx`. Copy the ENTIRE harness from `test/e2e/sidebar-repo-filter-flow.test.tsx` — the import block (lines 1-37), the `vi.mock('@/lib/ws-client', ...)` and `vi.mock('@/lib/api', ...)` blocks, the local `createStore` helper, the `renderSidebar` helper, and the `beforeEach`/`afterEach` (including `_resetSessionWindowThunkState()` and the default `mockFetchSnapshot` empty-page resolution) — changing only the top-level describe name to `'sidebar agent filter flow (e2e)'`. Then replace the fixture + tests with:

```tsx
  const browseProjects: ProjectGroup[] = [
    {
      projectPath: '/home/user/repo-alpha',
      sessions: [
        {
          provider: 'claude',
          sessionId: 'session-alpha-claude',
          projectPath: '/home/user/repo-alpha',
          lastActivityAt: 3_000,
          title: 'Alpha claude session',
        },
        {
          provider: 'codex',
          sessionId: 'session-alpha-codex',
          projectPath: '/home/user/repo-alpha',
          lastActivityAt: 2_000,
          title: 'Alpha codex session',
        },
      ],
    },
    {
      projectPath: '/home/user/repo-beta',
      sessions: [
        {
          provider: 'codex',
          sessionId: 'session-beta-codex',
          projectPath: '/home/user/repo-beta',
          lastActivityAt: 1_000,
          title: 'Beta codex session',
        },
      ],
    },
  ]

  function createBrowseStore() {
    vi.mocked(mockFetchSnapshot).mockResolvedValue({
      projects: browseProjects,
      totalSessions: 3,
      oldestIncludedTimestamp: 1_000,
      oldestIncludedSessionId: 'codex:session-beta-codex',
      hasMore: false,
    })
    return createStore({
      projects: browseProjects,
      sessions: {
        activeSurface: 'sidebar',
        projects: browseProjects,
        lastLoadedAt: 1_000,
        windows: {
          sidebar: {
            projects: browseProjects,
            lastLoadedAt: 1_000,
            query: '',
            searchTier: 'title',
            appliedQuery: '',
            appliedSearchTier: 'title',
            loading: false,
            hasMore: false,
            oldestLoadedTimestamp: 1_000,
            oldestLoadedSessionId: 'codex:session-beta-codex',
          },
        },
      },
    })
  }

  it('agent dropdown filters browse results and the clear-x restores them', async () => {
    const store = createBrowseStore()
    renderSidebar(store)
    await act(() => vi.advanceTimersByTime(100))

    expect(screen.getByText('Alpha claude session')).toBeInTheDocument()
    expect(screen.getByText('Alpha codex session')).toBeInTheDocument()

    const select = screen.getByRole('combobox', { name: /agent filter/i }) as HTMLSelectElement
    expect(select).toHaveValue('all')
    // No extensions registry in this store -> capitalized fallback labels.
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      'All agents',
      'Claude',
      'Codex',
    ])
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      'all',
      'claude',
      'codex',
    ])

    fireEvent.change(select, { target: { value: 'codex' } })
    expect(screen.getByText('Alpha codex session')).toBeInTheDocument()
    expect(screen.getByText('Beta codex session')).toBeInTheDocument()
    expect(screen.queryByText('Alpha claude session')).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Clear agent filter'))
    expect(select).toHaveValue('all')
    expect(screen.getByText('Alpha claude session')).toBeInTheDocument()
  })

  it('agent filter ANDs with the repo filter and a committed server search', async () => {
    const store = createBrowseStore()
    vi.mocked(mockSearchSessions).mockResolvedValue({
      results: [
        {
          provider: 'claude',
          sessionId: 'session-alpha-claude',
          projectPath: '/home/user/repo-alpha',
          title: 'Alpha claude deploy notes',
          lastActivityAt: 3_000,
          archived: false,
        },
        {
          provider: 'codex',
          sessionId: 'session-alpha-codex',
          projectPath: '/home/user/repo-alpha',
          title: 'Alpha codex deploy notes',
          lastActivityAt: 2_000,
          archived: false,
        },
        {
          provider: 'codex',
          sessionId: 'session-beta-codex',
          projectPath: '/home/user/repo-beta',
          title: 'Beta codex deploy notes',
          lastActivityAt: 1_000,
          archived: false,
        },
      ],
      tier: 'title',
      query: 'deploy',
      totalScanned: 3,
    })
    renderSidebar(store)
    await act(() => vi.advanceTimersByTime(100))

    fireEvent.change(screen.getByRole('combobox', { name: /repo filter/i }), {
      target: { value: '/home/user/repo-alpha' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: /agent filter/i }), {
      target: { value: 'codex' },
    })
    fireEvent.change(screen.getByPlaceholderText('Search...'), {
      target: { value: 'deploy' },
    })
    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })

    // All three filters AND: only the alpha-repo codex search hit survives.
    expect(screen.getByText('Alpha codex deploy notes')).toBeInTheDocument()
    expect(screen.queryByText('Alpha claude deploy notes')).not.toBeInTheDocument()
    expect(screen.queryByText('Beta codex deploy notes')).not.toBeInTheDocument()

    // Both selections survive the search commit.
    expect(screen.getByRole('combobox', { name: /agent filter/i })).toHaveValue('codex')
    expect(screen.getByRole('combobox', { name: /repo filter/i })).toHaveValue('/home/user/repo-alpha')
  })
```

- [ ] **Step 2: Run to verify (should pass; failures indicate wiring bugs)**

Run: `npm run test:vitest -- --run test/e2e/sidebar-agent-filter-flow.test.tsx`
Expected: PASS. If a test fails, the Task 6/7 wiring has a real bug (e.g. filter not composing with the applied search) — fix `Sidebar.tsx`, not the test. Also run the sibling: `npm run test:vitest -- --run test/e2e/sidebar-repo-filter-flow.test.tsx` — Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/sidebar-agent-filter-flow.test.tsx
git commit -m "test(e2e): sidebar agent filter flow coverage (filter, clear, AND with repo + search)"
```

---

### Task 10: Full-suite verification

**Files:** none new — verification only (plus any fixes it forces).

- [ ] **Step 1: Run the full gate**

Run: `npm run check` (goes through the shared test coordinator; do not use raw `npx vitest`).
Expected: lint (including jsx-a11y), typecheck, and the full Vitest suite all green.

- [ ] **Step 2: Fix anything red, atomically**

If failures surface, fix them and commit each fix separately with a focused message (e.g. `fix(sidebar): <specific issue>`). Do not weaken tests to get to green — the only acceptable assertion updates are the ones explicitly called out in Tasks 2, 3 and 4 (structural contract / depth-preserving refresh contract at open-tab-session-sidebar-visibility line 800 / deterministic tie order).

- [ ] **Step 3: Confirm clean tree**

Run: `git status --short` → empty. `git log --oneline origin/main..HEAD` → one commit per completed task, in order.

---

## Self-Review (performed while writing this plan)

**1. Spec coverage:**
- Rename 'All' → 'All repos' (visible text only) → Task 1. ✓
- Live-update jumpiness, PREFERRED root-cause fix, "emulate the main page": HistoryView's calm is structural — unconditional scroll container (Task 2 mirrors `HistoryView.tsx:181`), no self-inflicted window truncation (Task 3 makes the sidebar's refresh depth-preserving, matching the main page's "nothing to lose" property, and pairs the merge with immediate delete propagation so it never masks a user's delete), stable ordering (Task 4). "Investigate why selecting a repo makes it worse" — answered and encoded in Tasks 2/3: the client-side filter draws its visible rows from deeper pages, so truncation deletes what's on screen and transient-empty unmounts the scroller. Fallback (scroll-freeze + 30-60s throttle) intentionally NOT implemented per spec ("only if a clean root-cause fix is not feasible" — it is feasible). ✓
- Agent dropdown: defaults to 'All agents' (Task 6), populated from loaded sessions' agent kinds (`sessionType`, which defaults to `provider` — covers claude/codex/opencode/freshclaude/etc., i.e. "whatever kinds the session data exposes"; there is no `'terminal'` sessionType on sidebar rows — shell terminals surface as fallback rows whose `sessionType` is still a provider name, so they filter consistently), filters the list (Task 6), ANDs with repo + text search (Tasks 6, 9), clear-x (Task 7), NOT persisted + locked by test (Task 8), same UX conventions (identical classes/aria patterns). ✓
- "Existing patterns" conventions: pure helpers + unit tests (Task 5), sidebar component tests (Tasks 6-8), e2e coverage where the repo filter has it (Task 9 — `test/e2e/*.test.tsx` jsdom flow, the repo filter's actual e2e surface; it has no Playwright coverage, so none is added), non-persistence locked by test (Task 8), `docs/index.html` mock (Tasks 1, 8). ✓

**1b. No silent deferrals:** No stubs, mocks-as-product, or deferred behavior. All test mocks (`@/lib/api`, `@/lib/ws-client`) are the repo's established component/flow test seams, not stand-ins for unimplemented behavior; production behavior is exercised through the real component + real Redux store + real thunks/reducers. Task 3 pairs the depth-preserving merge with an explicit `removeSessionFromProjects` dispatch in both delete flows (Steps 4-6), so client-initiated deletions propagate immediately and do not depend on refresh semantics; the accepted, documented residual (surfaced by load-bearing validation) is that EXTERNALLY-deleted sessions in a deeper-than-page-1 window linger — at their sorted position — until a window rebuild. One existing e2e assertion pinned the old replace-refresh semantics; it is updated with explicit justification in Task 3 Step 7 (a deliberate contract change, not a weakened test). No UNRESOLVED COVERAGE GAPS.

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N" placeholders. Bounded judgment instructions exist by design: Task 2 Step 4 and Task 4 Step 4 tell the implementer exactly which kind of pre-existing assertion may be updated and to what contract; Task 3 Step 4(b) fixes the wiring test's assertion contract while allowing reuse of the named file's existing harness idioms, and Task 3 Step 7 names the single e2e assertion (file, line, exact replacement) that changes with the refresh contract; Task 4 Step 3 gives an exact mechanical transformation rule for the two unquoted comparators. Task 9 copies a named existing harness verbatim with an exact list of what to copy and the one allowed change.

**3. Type consistency:** `ALL_AGENTS`/`AgentFilterOption`/`filterSessionItemsByAgent(items, agentFilter)`/`collectAgentFilterOptions(items, selected, getLabel)` are defined once (Task 5) and consumed with identical signatures in Tasks 6-9. `compareBySessionKey` exists only within Task 4's `sortSessionItems`. `commitSessionWindowVisibleRefresh` payload fields used in tests match `SessionWindowCommitPayload` (`sessionsSlice.ts:124-137`). `removeSessionFromProjects({ provider?, sessionId })` is defined once (Task 3 Step 6) and dispatched with the same payload shape from `ContextMenuProvider.tsx` and `HistoryView.tsx`; it reuses the in-file `sessionKey` helper so its `provider || 'claude'` fallback matches both delete flows' composite-key construction. `getByRole('combobox', { name: /agent filter/i })` matches `aria-label="Agent filter"`; labels differ intentionally between component tests (`Claude CLI`, from `createTestStore`'s extensions entries) and e2e tests (`Claude`, capitalization fallback — that store has no extensions reducer), both flowing through `resolveSessionTypeConfig` → `getProviderLabel`.
