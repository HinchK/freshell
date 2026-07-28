# Restore-Locations Repo Filter Dropdown Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Add a second dropdown to the sidebar session-search UI that defaults to "All", lists every repo we have restorable session locations for, and filters the results to the selected repo — AND-composed with the existing search settings, never persisted.

**Architecture:** The sidebar (`src/components/Sidebar.tsx`) renders session rows produced by `makeSelectSortedSessionItems` (`src/store/selectors/sidebarSelectors.ts`), which already AND-composes visibility settings + applied server-side search. We add a `repoPath` field to `SidebarSessionItem` (always the repo root, independent of the worktree-grouping display setting), two exported pure functions (`filterSessionItemsByRepo`, `collectRepoFilterOptions`), and a component-local `useState('all')` repo filter applied client-side between the selector output and `useStableArray`. A native `<select>` (the codebase convention — see the existing "Search tier" select) plus a conditional clear-`x` button (copying the existing "Clear search" button pattern) form the UI.

**Tech Stack:** React 18 + Redux Toolkit, TypeScript, native `<select>`, lucide-react `X` icon, Vitest + @testing-library/react (jsdom).

## Target-Surface Assumption (read first)

The literal string "restore location" appears nowhere in this codebase. The spec's "restore-locations search UI" is interpreted as **the sidebar session search UI in `src/components/Sidebar.tsx`** because it is the only surface matching every clue in the spec:

- It is *the* search UI of the app; clicking a result **restores/resumes** a coding-agent session at its location.
- It has **exactly one existing dropdown** (the "Search tier" `<select>` at `Sidebar.tsx:690-706`), so "add a **second** dropdown" reads literally.
- It has the app's only `x`-clear idiom (the "Clear search" button at `Sidebar.tsx:679-686`).
- Every result carries a repo path (`projectPath` / `ProjectGroup.projectPath`).

Validated by code inspection (load-bearing check): the Sidebar is the only surface matching all four clues jointly — TabsView clicks pull tab-registry records (no repo field, no session resume), HistoryView has zero dropdowns and no x-clear idiom. Caveat verified: not literally *every* result carries a repo path — fallback/live-terminal rows can lack one; the design below handles them explicitly.

## Global Constraints

- The repo selection must **NOT** be persisted: no `localStorage`, no persisted Redux state, no `settings.sidebar.*` (everything under `settings.sidebar` is persisted to `~/.freshell/config.json`), no `sessions.windows.sidebar` mirroring. Component-local `useState` only. Browser refresh must reset it to "All".
- Dropdown default value and default option label: exactly `All` (sentinel value `'all'`, matching the `FilterMode`/`ScopeMode` precedent in `TabsView.tsx:45-46`).
- Clearing via the `x` button resets the dropdown to "All".
- The repo filter **ANDs** with all other search settings (visibility settings, applied server-side search, tier) — it composes with them, never replaces them.
- Dropdown options = all repos that have **loaded** restorable session locations (repo **roots**, even when the sidebar's worktree-grouping display setting is `'worktree'`). This windowed-options semantics is a deliberate, recorded decision — see the "Windowed options" design note below. Repo-root fidelity is enforced by the Task 1 composite gate and carries two recorded upstream residuals (search-mode `checkoutPath` omission; opencode cwd-derived project paths) — see the "`repoPath` semantics" design note.
- Coverage per AGENTS.md: **unit AND e2e** — the repo's e2e tier for UI controls is a Vitest flow test under `test/e2e/` (Task 5). `npm run test:unit` does NOT execute `test/e2e/` files; the final gate therefore runs the default client config workload (`npm run test:client`).
- A11y (CI gate via `npm run lint` + eslint-plugin-jsx-a11y): `aria-label` on the new select ("Repo filter") and on the icon-only clear button ("Clear repo filter").
- TDD per AGENTS.md: Red-Green-Refactor for every task; run the failing test before implementing.
- Commits: focused and atomic; use the repository's configured commit identity per AGENTS.md (`Dan Shapiro <3732858+danshapiro@users.noreply.github.com>`). Never run `gh pr create` (the workflow handles integration).
- Test runs go through the coordinated runner: `npm run test:vitest -- run <file> --config config/vitest/vitest.config.ts` (never raw `npx vitest`).
- README.md is the only end-user markdown doc; this plan under `docs/plans/` is a working doc. Do not create other markdown docs.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/store/selectors/sidebarSelectors.ts` | Modify | Add `repoPath` to `SidebarSessionItem`; populate it in `buildSessionItems`; export `ALL_REPOS`, `RepoFilterOption`, `filterSessionItemsByRepo`, `collectRepoFilterOptions` |
| `src/components/Sidebar.tsx` | Modify | `repoFilter` local state, options/filter memos, dropdown + clear-`x` markup, repo-aware empty state |
| `test/unit/client/store/sidebar-repo-filter.test.ts` | Create | Unit tests for the two pure functions |
| `test/unit/client/components/Sidebar.test.tsx` | Modify | New `describe('Repo filter dropdown')` component tests; small `createTestStore` extension (`sidebarSettings` override) |
| `docs/index.html` | Modify | Add the new dropdown to the nonfunctional UI mock (AGENTS.md convention for user-visible UI changes) |
| `test/e2e/sidebar-repo-filter-flow.test.tsx` | Create | Vitest e2e flow test (AGENTS.md requires unit AND e2e coverage; this is the repo's e2e tier for UI controls) |

Design notes locked in here:

- **`repoPath` semantics:** For session rows built from `ProjectGroup`s, `repoPath = project.projectPath` regardless of the `worktreeGrouping` display setting (which rewrites `item.projectPath` to the worktree checkout path) — EXCEPT for server-fabricated live-terminal rows and the literal `'unknown'` group path, which Task 1 gates out. Verified by code inspection: the server session directory injects one item per non-shell live terminal not deduped against the index (`server/session-directory/service.ts:141-148`) with `projectPath = checkoutRoot || repoRoot || cwd || 'terminal:<id>'` (`service.ts:114`) — a worktree checkout path, a bare cwd, or a literal `terminal:<id>`, never a repo-root-collapsed path. These injected rows come in TWO variants (`service.ts:128` sets `liveTerminalOnly: !meta.sessionId`): **(A)** sessionId-less terminals get `liveTerminalOnly: true` and `sessionId = 'terminal:<id>'`; **(B)** terminals that already carry a real `sessionId` but are not yet in the CLI index (the normal race for a freshly started coding session — recurring in worktree-based workflows) get `liveTerminalOnly: false`, so a `liveTerminalOnly`-only gate would miss them. Variant B is identified by `checkoutPath === projectPath`: `buildLiveTerminalSessionItem` sets both fields from `meta.checkoutRoot` (`service.ts:114,120`), while the indexer structurally suppresses `checkoutPath` whenever it would equal `projectPath` (`server/coding-cli/session-indexer.ts:992-999`), so the equality is guaranteed for injected rows with a cwd and impossible for indexed rows. Task 1 therefore gates with a composite predicate: `liveTerminalOnly === true`, OR `sessionId.startsWith('terminal:')` (belt-and-braces equivalent of variant A that also covers client-built live rows), OR `checkoutPath === projectPath` (variant B), OR group path `'unknown'` (the literal emitted for cwd-less indexed claude/codex/amplifier sessions). Fallback rows (`pushFallbackItem`), client-built live-terminal rows, and both server-injected variants therefore all have `repoPath === undefined`: they never contribute dropdown options and are hidden when a specific repo is selected. Recorded residual limitations (accepted; the additive upgrade path — a server-side `repoPath` field on the session-directory DTO — would eliminate both): (i) during an applied search the `checkoutPath`-equality term is inert because the search-result mapping omits `checkoutPath` (`src/lib/api.ts:709-728`, a pre-existing omission that already degrades worktree-grouping display in search mode); the other gate terms still apply there. (ii) `project.projectPath` is repo-root-collapsed by the claude/codex/amplifier providers (`resolveGitRepoRoot`), but the opencode provider resolves it to the raw session cwd (`server/coding-cli/providers/opencode.ts:348-350`), so an opencode session started in a worktree or subdirectory contributes that path as its "repo" option — indistinguishable client-side, accepted as an upstream limitation. This is the honest reading of "all the repos that we have restore locations for".
- **Filter seam:** in-component, between the selector output (`localFilteredItems`) and `useStableArray`. The selector pipeline (`visibility → appliedSearch → filter → sort`) runs first, so the repo filter ANDs with everything by construction. `repoPath` is not rendered by `SidebarItem`, and membership is recomputed from fresh selector output each render, so `areSessionItemsEqual`/`isSessionItemEqual` need no change.
- **Options list:** derived from the *pre-repo-filter* items so all repos stay listed while one is selected; the currently selected repo is retained as an option even if a live search temporarily empties its rows (otherwise the controlled `<select>` would render blank).
- **Windowed options (decision, verified):** the session window is paginated at *session* granularity — the server flattens all sessions, sorts by recency, and slices the top N (`server/session-directory/service.ts:240,281`; client page cap 50, `src/lib/api.ts:670`). So the dropdown lists repos present in the **loaded** window: repos whose sessions are all outside it appear only as more pages load (scroll) or via search (which scans the full index). During an active search, a committed search *replaces* the window's projects (`sessionsSlice.ts:143`), so options narrow to repos in the search results plus the retained selection; clearing the search refetches page 1 (not the pre-search window). This is deliberate: every option always corresponds to rows the user can see (no dead options that filter to an unexplained empty list), and no server change is needed. Alternatives considered and rejected for this iteration: a full-index repo aggregate in the session-directory response (`codingCliIndexer.getProjects()` is in memory server-side — the additive upgrade path if complete option coverage is later required) would create options whose selection strands the user on an empty list, because an empty filtered list unmounts the list container and suppresses backfill (see next note); full server-side repo filtering would touch the search and pagination surfaces shared with other views.
- **Known interaction (no task, by design — verified by code trace):** the viewport backfill has three triggers (scroll handler, a mount/update effect keyed on `sortedItems.length`/cursors/`hasMore`/`loading`, and a ResizeObserver — `Sidebar.tsx:~544-578`), all keyed off the *rendered* list. A repo-filter-shrunken-but-nonempty list makes the effect fetch subsequent pages sequentially until `hasMore` is false — bounded (worst case `ceil(remaining/50)` fetches; guards: `loading` flag, in-flight ref + 15s failsafe, strictly advancing server cursor — no livelock). An **empty** filtered list unmounts the list container, so backfill goes fully inert (older matches are then unreachable until the filter is cleared — accepted UX asymmetry, no behavior change made). Under jsdom, quiet mounts are inert because `maybeBackfillViewport` returns when `clientHeight <= 0` and the setup ResizeObserver is a no-op stub — the existing suite proves zero append calls on quiet mounts. Backfill IS unit-testable via the existing geometry-mocking idiom (`Object.defineProperty` on `clientHeight`/`scrollHeight` + `fireEvent.scroll`); no new backfill test is added because the behavior is verified bounded and unchanged. Test-author caveat: `handleListScroll` has no `clientHeight` guard — the new tests must not fire scroll events on stores seeded with `hasMore` + cursors.

---

### Task 1: `repoPath` field + pure repo-filter functions (selector layer)

**Files:**
- Modify: `src/store/selectors/sidebarSelectors.ts` (interface at lines 14-41, session-item construction at ~line 226, new functions after `filterSessionItems` at ~line 505)
- Test: `test/unit/client/store/sidebar-repo-filter.test.ts` (create)

**Interfaces:**
- Consumes: existing `SidebarSessionItem` interface, private `getProjectName(projectPath: string): string` helper (line 69), `ProjectGroup.projectPath`.
- Produces (relied on by Tasks 2-6):
  - `SidebarSessionItem.repoPath?: string` — repo root; `undefined` on fallback rows, server-fabricated live-terminal rows (both variants — see the "`repoPath` semantics" design note), and `'unknown'` group paths.
  - `export const ALL_REPOS = 'all'`
  - `export interface RepoFilterOption { value: string; label: string }`
  - `export function filterSessionItemsByRepo(items: SidebarSessionItem[], repoFilter: string): SidebarSessionItem[]`
  - `export function collectRepoFilterOptions(items: SidebarSessionItem[], selected: string): RepoFilterOption[]` — deduped, label-sorted; retains `selected` as an option when it is not `ALL_REPOS` and absent from `items`.

- [ ] **Step 1: Write the failing unit tests**

Create `test/unit/client/store/sidebar-repo-filter.test.ts` with exactly:

```typescript
import { describe, it, expect } from 'vitest'
import {
  ALL_REPOS,
  collectRepoFilterOptions,
  filterSessionItemsByRepo,
  type SidebarSessionItem,
} from '@/store/selectors/sidebarSelectors'

function makeItem(id: string, overrides?: Partial<SidebarSessionItem>): SidebarSessionItem {
  return {
    id: `session-claude-${id}`,
    sessionId: id,
    provider: 'claude',
    sessionType: 'claude',
    title: `Session ${id}`,
    timestamp: 0,
    hasTab: false,
    isRunning: false,
    hasTitle: true,
    ...overrides,
  }
}

describe('filterSessionItemsByRepo', () => {
  const items = [
    makeItem('a1', { repoPath: '/home/user/repo-alpha', projectPath: '/home/user/repo-alpha' }),
    makeItem('a2', { repoPath: '/home/user/repo-alpha', projectPath: '/home/user/repo-alpha/.worktrees/x' }),
    makeItem('b1', { repoPath: '/home/user/repo-beta', projectPath: '/home/user/repo-beta' }),
    makeItem('orphan', { projectPath: '/tmp/some-cwd' }),
  ]

  it('returns the same array when the filter is ALL_REPOS', () => {
    expect(filterSessionItemsByRepo(items, ALL_REPOS)).toBe(items)
  })

  it('keeps only items whose repoPath matches the selected repo', () => {
    const result = filterSessionItemsByRepo(items, '/home/user/repo-alpha')
    expect(result.map((i) => i.sessionId)).toEqual(['a1', 'a2'])
  })

  it('hides items without a repoPath when a specific repo is selected', () => {
    const result = filterSessionItemsByRepo(items, '/home/user/repo-beta')
    expect(result.map((i) => i.sessionId)).toEqual(['b1'])
  })
})

describe('collectRepoFilterOptions', () => {
  it('dedupes repo paths and sorts options by leaf-directory label', () => {
    const items = [
      makeItem('b1', { repoPath: '/home/user/zeta-repo' }),
      makeItem('a1', { repoPath: '/home/user/alpha-repo' }),
      makeItem('a2', { repoPath: '/home/user/alpha-repo' }),
    ]
    expect(collectRepoFilterOptions(items, ALL_REPOS)).toEqual([
      { value: '/home/user/alpha-repo', label: 'alpha-repo' },
      { value: '/home/user/zeta-repo', label: 'zeta-repo' },
    ])
  })

  it('ignores items without a repoPath', () => {
    const items = [
      makeItem('a1', { repoPath: '/home/user/alpha-repo' }),
      makeItem('orphan', { projectPath: '/tmp/some-cwd' }),
    ]
    expect(collectRepoFilterOptions(items, ALL_REPOS)).toEqual([
      { value: '/home/user/alpha-repo', label: 'alpha-repo' },
    ])
  })

  it('retains the selected repo as an option even when no loaded item belongs to it', () => {
    const items = [makeItem('a1', { repoPath: '/home/user/alpha-repo' })]
    expect(collectRepoFilterOptions(items, '/home/user/zeta-repo')).toEqual([
      { value: '/home/user/alpha-repo', label: 'alpha-repo' },
      { value: '/home/user/zeta-repo', label: 'zeta-repo' },
    ])
  })

  it('does not inject an extra option when the selection is ALL_REPOS', () => {
    expect(collectRepoFilterOptions([], ALL_REPOS)).toEqual([])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
npm run test:vitest -- run test/unit/client/store/sidebar-repo-filter.test.ts --config config/vitest/vitest.config.ts
```
Expected: FAIL — the module has no exported member `ALL_REPOS` / `filterSessionItemsByRepo` / `collectRepoFilterOptions` (TypeScript/ESM export errors).

- [ ] **Step 3: Implement the field and the pure functions**

In `src/store/selectors/sidebarSelectors.ts`:

3a. In the `SidebarSessionItem` interface (lines 14-41), directly after the line `projectPath?: string`, add:

```typescript
  // Repo root (ProjectGroup.projectPath) — independent of the worktreeGrouping
  // display setting. Undefined for fallback rows, for server-fabricated
  // live-terminal rows (both variants: liveTerminalOnly / 'terminal:<id>'
  // sessionIds, and sessionId-bearing-but-unindexed rows identified by
  // checkoutPath === projectPath), and for the literal 'unknown' group path —
  // none of which carry a repo root.
  repoPath?: string
```

3b. Directly above the `buildSessionItems` function, add a private helper (`ProjectGroup` is already the type of the projects consumed in this file; import it from `@/store/types` only if it is not already in scope):

```typescript
// Rows whose group path is NOT a repo root get repoPath: undefined.
// Server-fabricated live-terminal rows (buildLiveTerminalSessionItem in
// server/session-directory/service.ts) use checkoutRoot || cwd || 'terminal:<id>'
// — never repo-root-collapsed — in two variants: sessionId-less rows
// (liveTerminalOnly: true, sessionId 'terminal:<id>') and
// sessionId-bearing-but-unindexed rows (liveTerminalOnly: false), which are
// identified by checkoutPath === projectPath: the indexer suppresses
// checkoutPath whenever it would equal projectPath
// (server/coding-cli/session-indexer.ts), so that equality holds only for
// fabricated rows. 'unknown' is the literal group path of cwd-less indexed
// sessions. See the "repoPath semantics" design note in the plan.
function resolveRepoPath(
  session: ProjectGroup['sessions'][number],
  groupProjectPath: string,
): string | undefined {
  if (session.liveTerminalOnly) return undefined
  if (session.sessionId.startsWith('terminal:')) return undefined
  if (session.checkoutPath && session.checkoutPath === session.projectPath) return undefined
  if (groupProjectPath === 'unknown') return undefined
  return groupProjectPath
}
```

Then, in `buildSessionItems`, in the session-item construction (the `const item: SidebarSessionItem = {` block at ~line 219, inside the `for (const session of project.sessions || [])` loop), directly after the line `projectPath: effectivePath,`, add:

```typescript
        repoPath: resolveRepoPath(session, project.projectPath),
```

The composite gate is required: a `liveTerminalOnly`-only gate misses server-injected rows whose terminal already carries a real `sessionId` but is not yet in the CLI index — `service.ts:128` sets `liveTerminalOnly: !meta.sessionId`, and `toItems` (`service.ts:141-148`) injects every non-shell live terminal not deduped against the index, so those rows arrive with `liveTerminalOnly: false` and a worktree-checkout/bare-cwd group path (see the `repoPath` semantics design note). The gate's observable behavior — including the sessionId-bearing variant — is locked by a component test in Task 2 Step 2 (a selector-level unit test would need the full memoized-selector fixture for no extra coverage).

Leave `pushFallbackItem` (~line 253) and the live-terminal item construction (~line 468) untouched — their `repoPath` remains `undefined` by design.

3c. Directly after the closing brace of the private `filterSessionItems` function (~line 505), add:

```typescript
export const ALL_REPOS = 'all'

export interface RepoFilterOption {
  value: string
  label: string
}

export function filterSessionItemsByRepo(
  items: SidebarSessionItem[],
  repoFilter: string,
): SidebarSessionItem[] {
  if (repoFilter === ALL_REPOS) return items
  return items.filter((item) => item.repoPath === repoFilter)
}

export function collectRepoFilterOptions(
  items: SidebarSessionItem[],
  selected: string,
): RepoFilterOption[] {
  const paths = new Set<string>()
  for (const item of items) {
    if (item.repoPath) paths.add(item.repoPath)
  }
  if (selected !== ALL_REPOS) paths.add(selected)
  return [...paths]
    .map((value) => ({ value, label: getProjectName(value) }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value))
}
```

(`getProjectName` is the existing private helper at line 69: `getLeafDirectoryName(projectPath) ?? projectPath`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
npm run test:vitest -- run test/unit/client/store/sidebar-repo-filter.test.ts --config config/vitest/vitest.config.ts
```
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck:client`
Expected: exits 0, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/store/selectors/sidebarSelectors.ts test/unit/client/store/sidebar-repo-filter.test.ts
git commit -m "feat(sidebar): add repoPath to session items and pure repo-filter helpers"
```

---

### Task 2: Repo dropdown in the sidebar — options, "All" default, filtering

**Files:**
- Modify: `src/components/Sidebar.tsx` (state at ~line 228, selector-output wiring at ~lines 307-315, search-controls markup at ~lines 658-706)
- Modify: `test/unit/client/components/Sidebar.test.tsx` (extend `createTestStore` options at ~lines 64-113; add new `describe` after the `describe('Search tier toggle')` block that ends at ~line 2307)

**Interfaces:**
- Consumes (from Task 1): `ALL_REPOS`, `filterSessionItemsByRepo(items, repoFilter)`, `collectRepoFilterOptions(items, selected)`, `SidebarSessionItem.repoPath`.
- Produces (relied on by Tasks 3-6):
  - Local state `const [repoFilter, setRepoFilter] = useState<string>(ALL_REPOS)` in the `Sidebar` component.
  - Memo `repoOptions: RepoFilterOption[]` derived from the pre-filter item list.
  - A native `<select aria-label="Repo filter">` rendered whenever `repoOptions.length > 0`, first option `<option value={ALL_REPOS}>All</option>`.
  - Test-helper option `sidebarSettings?: Partial<(typeof defaultSettings)['sidebar']>` on `createTestStore`.

- [ ] **Step 1: Extend the `createTestStore` helper (test infrastructure, needed by the failing tests)**

In `test/unit/client/components/Sidebar.test.tsx`:

1a. In the `createTestStore` options type (the object type starting at ~line 64), after the line `sessionOpenMode?: 'tab' | 'split'`, add:

```typescript
  sidebarSettings?: Partial<(typeof defaultSettings)['sidebar']>
```

1b. In the `preloadedState.settings.settings.sidebar` object (~lines 106-109), which currently reads:

```typescript
          sidebar: {
            ...defaultSettings.sidebar,
            sortMode: options?.sortMode ?? 'activity',
            showProjectBadges: options?.showProjectBadges ?? true,
            hideEmptySessions: false,
          },
```

change it to (spread the override last):

```typescript
          sidebar: {
            ...defaultSettings.sidebar,
            sortMode: options?.sortMode ?? 'activity',
            showProjectBadges: options?.showProjectBadges ?? true,
            hideEmptySessions: false,
            ...options?.sidebarSettings,
          },
```

- [ ] **Step 2: Write the failing component tests**

In `test/unit/client/components/Sidebar.test.tsx`, immediately after the closing `})` of `describe('Search tier toggle', ...)` (~line 2307), add:

```tsx
  describe('Repo filter dropdown', () => {
    const repoProjects: ProjectGroup[] = [
      {
        projectPath: '/home/user/repo-alpha',
        sessions: [
          {
            sessionId: sessionId('alpha-1'),
            projectPath: '/home/user/repo-alpha',
            lastActivityAt: Date.now() - 1000,
            title: 'Alpha session one',
            cwd: '/home/user/repo-alpha',
          },
          {
            sessionId: sessionId('alpha-2'),
            projectPath: '/home/user/repo-alpha',
            lastActivityAt: Date.now() - 2000,
            title: 'Alpha session two',
            cwd: '/home/user/repo-alpha',
          },
        ],
      },
      {
        projectPath: '/home/user/repo-beta',
        sessions: [
          {
            sessionId: sessionId('beta-1'),
            projectPath: '/home/user/repo-beta',
            lastActivityAt: Date.now() - 3000,
            title: 'Beta session one',
            cwd: '/home/user/repo-beta',
          },
        ],
      },
    ]

    it('renders the repo dropdown defaulting to All with one option per repo', async () => {
      const store = createTestStore({ projects: repoProjects })
      const { getByRole } = renderSidebar(store, [])
      await act(() => vi.advanceTimersByTime(100))

      const select = getByRole('combobox', { name: /repo filter/i }) as HTMLSelectElement
      expect(select).toHaveValue('all')
      expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
        'All',
        'repo-alpha',
        'repo-beta',
      ])
      expect(Array.from(select.options).map((o) => o.value)).toEqual([
        'all',
        '/home/user/repo-alpha',
        '/home/user/repo-beta',
      ])
    })

    it('shows all sessions by default and filters the list to the selected repo', async () => {
      const store = createTestStore({ projects: repoProjects })
      const { getByRole } = renderSidebar(store, [])
      await act(() => vi.advanceTimersByTime(100))

      expect(screen.getByText('Alpha session one')).toBeInTheDocument()
      expect(screen.getByText('Beta session one')).toBeInTheDocument()

      fireEvent.change(getByRole('combobox', { name: /repo filter/i }), {
        target: { value: '/home/user/repo-beta' },
      })

      expect(screen.getByText('Beta session one')).toBeInTheDocument()
      expect(screen.queryByText('Alpha session one')).not.toBeInTheDocument()
      expect(screen.queryByText('Alpha session two')).not.toBeInTheDocument()
    })

    it('does not render the dropdown when no repos are loaded', async () => {
      const store = createTestStore({ projects: [] })
      const { queryByRole } = renderSidebar(store, [])
      await act(() => vi.advanceTimersByTime(100))

      expect(queryByRole('combobox', { name: /repo filter/i })).not.toBeInTheDocument()
    })

    it('lists repo roots (not worktree checkout paths) in worktree grouping mode and still filters by repo', async () => {
      const store = createTestStore({
        sidebarSettings: { worktreeGrouping: 'worktree' },
        projects: [
          {
            projectPath: '/home/user/repo-alpha',
            sessions: [
              {
                sessionId: sessionId('wt-1'),
                projectPath: '/home/user/repo-alpha',
                checkoutPath: '/home/user/repo-alpha/.worktrees/feature-x',
                lastActivityAt: Date.now() - 1000,
                title: 'Worktree session',
                cwd: '/home/user/repo-alpha/.worktrees/feature-x',
              },
            ],
          },
        ],
      })
      const { getByRole } = renderSidebar(store, [])
      await act(() => vi.advanceTimersByTime(100))

      const select = getByRole('combobox', { name: /repo filter/i }) as HTMLSelectElement
      expect(Array.from(select.options).map((o) => o.value)).toEqual([
        'all',
        '/home/user/repo-alpha',
      ])

      fireEvent.change(select, { target: { value: '/home/user/repo-alpha' } })
      expect(screen.getByText('Worktree session')).toBeInTheDocument()
    })

    it('excludes server-fabricated live-terminal rows from the repo options (both variants)', async () => {
      const store = createTestStore({
        projects: [
          ...repoProjects,
          {
            projectPath: 'terminal:t-123',
            sessions: [
              {
                sessionId: sessionId('live-1'),
                projectPath: 'terminal:t-123',
                lastActivityAt: Date.now() - 500,
                title: 'Live terminal row',
                liveTerminalOnly: true,
              },
            ],
          },
          {
            // sessionId-bearing but not-yet-indexed live terminal in a worktree:
            // liveTerminalOnly is false, but checkoutPath === projectPath (an
            // equality the indexer never emits) marks it server-fabricated.
            projectPath: '/home/user/repo-alpha/.worktrees/live-wt',
            sessions: [
              {
                sessionId: sessionId('live-2'),
                projectPath: '/home/user/repo-alpha/.worktrees/live-wt',
                checkoutPath: '/home/user/repo-alpha/.worktrees/live-wt',
                lastActivityAt: Date.now() - 600,
                title: 'Unindexed live session',
                liveTerminalOnly: false,
                isRunning: true,
              },
            ],
          },
        ],
      })
      const { getByRole } = renderSidebar(store, [])
      await act(() => vi.advanceTimersByTime(100))

      const select = getByRole('combobox', { name: /repo filter/i }) as HTMLSelectElement
      expect(Array.from(select.options).map((o) => o.value)).toEqual([
        'all',
        '/home/user/repo-alpha',
        '/home/user/repo-beta',
      ])

      fireEvent.change(select, { target: { value: '/home/user/repo-alpha' } })
      expect(screen.queryByText('Live terminal row')).not.toBeInTheDocument()
      expect(screen.queryByText('Unindexed live session')).not.toBeInTheDocument()
    })
  })
```

(If TypeScript rejects the `sidebarSettings: { worktreeGrouping: 'worktree' }` literal, use `{ worktreeGrouping: 'worktree' as const }` — the settings type is a string union.)

- [ ] **Step 3: Run the new tests to verify they fail**

Run:
```bash
npm run test:vitest -- run test/unit/client/components/Sidebar.test.tsx --config config/vitest/vitest.config.ts -t "Repo filter"
```
Expected: 4 of the 5 new tests FAIL, each with `Unable to find an accessible element with the role "combobox" and name /repo filter/i`. The fifth — `'does not render the dropdown when no repos are loaded'` — passes vacuously before implementation (its `queryByRole(...).not.toBeInTheDocument()` assertion already holds while the dropdown does not exist); it is the negative boundary that only goes red if the dropdown later over-renders. Red gate: exactly 4 failures, all with the missing-combobox error.

- [ ] **Step 4: Implement the dropdown in `Sidebar.tsx`**

4a. Extend the existing import from `'@/store/selectors/sidebarSelectors'` near the top of `src/components/Sidebar.tsx` (it already imports `makeSelectSortedSessionItems`) to also import `ALL_REPOS`, `collectRepoFilterOptions`, and `filterSessionItemsByRepo`.

4b. Directly after the line `const [searchTier, setSearchTier] = useState<typeof requestedSearchTier>(requestedSearchTier)` (~line 228), add:

```tsx
  // Repo filter is deliberately component-local and never persisted:
  // a browser refresh must reset it to 'all' (spec requirement).
  const [repoFilter, setRepoFilter] = useState<string>(ALL_REPOS)
```

4c. Replace the two lines at ~lines 307-308:

```tsx
  const localFilteredItems = useAppSelector((state) => selectSortedItems(state, terminals, ''))
  const computedItems = useMemo(() => localFilteredItems, [localFilteredItems])
```

with:

```tsx
  const localFilteredItems = useAppSelector((state) => selectSortedItems(state, terminals, ''))
  // Options come from the PRE-repo-filter list so every repo stays listed while
  // one is selected; the current selection is retained even if its rows are
  // temporarily absent (e.g. mid-search), keeping the controlled select valid.
  const repoOptions = useMemo(
    () => collectRepoFilterOptions(localFilteredItems, repoFilter),
    [localFilteredItems, repoFilter],
  )
  // ANDs with the selector pipeline (visibility + applied search + sort),
  // which has already run inside selectSortedItems.
  const computedItems = useMemo(
    () => filterSessionItemsByRepo(localFilteredItems, repoFilter),
    [localFilteredItems, repoFilter],
  )
```

(The following line `const sortedItems = useStableArray(computedItems, isSessionItemEqual)` at ~line 315 stays unchanged.)

4d. In the search-controls JSX, between the closing `</div>` of the relative search-input wrapper and the `{localQuery && (` tier-select block (i.e. immediately before `{localQuery && (` at ~line 690), insert:

```tsx
        {repoOptions.length > 0 && (
          <div className="mt-2 flex items-center gap-1">
            <select
              aria-label="Repo filter"
              value={repoFilter}
              onChange={(e) => setRepoFilter(e.target.value || ALL_REPOS)}
              className="min-w-0 flex-1 h-7 px-2 text-xs bg-muted/50 border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border"
            >
              <option value={ALL_REPOS}>All</option>
              {repoOptions.map((option) => (
                <option key={option.value} value={option.value} title={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        )}
```

Placement check: this sits inside the `{/* Search */}` `<div className="px-3 pb-3">` container, as a sibling *after* the `<div className="relative">` input wrapper and *before* the `{localQuery && (...)}` tier block — so the repo dropdown is always visible (it filters results even without a text query), while the tier select keeps its query-only visibility.

- [ ] **Step 5: Run the new tests to verify they pass**

Run:
```bash
npm run test:vitest -- run test/unit/client/components/Sidebar.test.tsx --config config/vitest/vitest.config.ts -t "Repo filter"
```
Expected: PASS (5 tests).

- [ ] **Step 6: Fix the two known badge-test collisions, then run the whole Sidebar suite**

Verified by a scan of all Sidebar test suites (unit + jsdom-e2e siblings): every existing combobox query is name-qualified, there are no snapshots or DOM-shape/count assertions the new select can break — EXCEPT two project-badge tests (at ~lines 1964 and 1988 of `test/unit/client/components/Sidebar.test.tsx`) that assert on the bare text `my-awesome-project`, which now ALSO renders as the repo dropdown's option label (leaf-dir of the seeded `/home/user/my-awesome-project`). The markup is correct; those two queries are under-scoped. Fix them by scoping to the session list (the `within` idiom already used at ~lines 282-283; import `within` from `@testing-library/react` if not already imported):

```tsx
// was: expect(screen.getByText('my-awesome-project')).toBeInTheDocument()
expect(within(screen.getByTestId('sidebar-session-list')).getByText('my-awesome-project')).toBeInTheDocument()

// was: expect(screen.queryByText('my-awesome-project')).not.toBeInTheDocument()
expect(within(screen.getByTestId('sidebar-session-list')).queryByText('my-awesome-project')).not.toBeInTheDocument()
```

Then run:
```bash
npm run test:vitest -- run test/unit/client/components/Sidebar.test.tsx --config config/vitest/vitest.config.ts
```
Expected: PASS — no other regressions. (All other existing tests seed `projects`, so the new dropdown appears in them; none assert on an exhaustive combobox list. If any OTHER unexpected failure names the repo select: when the failing query is an under-scoped text/role query colliding with an option label, scope the query as above; otherwise fix the markup, not the test.)

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck:client`
Expected: exits 0.

- [ ] **Step 8: Commit**

```bash
git add src/components/Sidebar.tsx test/unit/client/components/Sidebar.test.tsx
git commit -m "feat(sidebar): repo filter dropdown with All default that filters session results"
```

---

### Task 3: Clear-`x` button resets the dropdown to "All"

**Files:**
- Modify: `src/components/Sidebar.tsx` (the repo-dropdown block added in Task 2)
- Test: `test/unit/client/components/Sidebar.test.tsx` (extend `describe('Repo filter dropdown')`)

**Interfaces:**
- Consumes: `repoFilter` / `setRepoFilter` state and the dropdown markup from Task 2; the lucide-react `X` icon (already imported in `Sidebar.tsx` for the "Clear search" button).
- Produces: a conditional `<button aria-label="Clear repo filter">` rendered only while `repoFilter !== ALL_REPOS`; clicking it sets the filter back to `ALL_REPOS`.

- [ ] **Step 1: Write the failing tests**

Inside `describe('Repo filter dropdown', ...)` in `test/unit/client/components/Sidebar.test.tsx`, add (reusing the `repoProjects` fixture from Task 2):

```tsx
    it('shows no clear button while the dropdown is on All', async () => {
      const store = createTestStore({ projects: repoProjects })
      const { queryByRole } = renderSidebar(store, [])
      await act(() => vi.advanceTimersByTime(100))

      expect(queryByRole('button', { name: /clear repo filter/i })).not.toBeInTheDocument()
    })

    it('clear button resets the repo filter to All and restores the full list', async () => {
      const store = createTestStore({ projects: repoProjects })
      const { getByRole, queryByRole } = renderSidebar(store, [])
      await act(() => vi.advanceTimersByTime(100))

      fireEvent.change(getByRole('combobox', { name: /repo filter/i }), {
        target: { value: '/home/user/repo-alpha' },
      })
      expect(screen.queryByText('Beta session one')).not.toBeInTheDocument()

      fireEvent.click(getByRole('button', { name: /clear repo filter/i }))

      expect(getByRole('combobox', { name: /repo filter/i })).toHaveValue('all')
      expect(screen.getByText('Beta session one')).toBeInTheDocument()
      expect(screen.getByText('Alpha session one')).toBeInTheDocument()
      expect(queryByRole('button', { name: /clear repo filter/i })).not.toBeInTheDocument()
    })
```

- [ ] **Step 2: Run to verify they fail**

Run:
```bash
npm run test:vitest -- run test/unit/client/components/Sidebar.test.tsx --config config/vitest/vitest.config.ts -t "Repo filter"
```
Expected: FAIL — `Unable to find an accessible element with the role "button" and name /clear repo filter/i` in the second new test (first new test passes trivially; 1 failure).

- [ ] **Step 3: Implement the clear button**

In `src/components/Sidebar.tsx`, inside the repo-dropdown `<div className="mt-2 flex items-center gap-1">` added in Task 2, directly after the closing `</select>`, add (this copies the existing "Clear search" button pattern at ~lines 679-686, including its mobile touch-target classes):

```tsx
            {repoFilter !== ALL_REPOS ? (
              <button
                aria-label="Clear repo filter"
                onClick={() => setRepoFilter(ALL_REPOS)}
                className="p-0.5 min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
```

- [ ] **Step 4: Run to verify they pass**

Run:
```bash
npm run test:vitest -- run test/unit/client/components/Sidebar.test.tsx --config config/vitest/vitest.config.ts -t "Repo filter"
```
Expected: PASS (7 tests in the describe).

- [ ] **Step 5: Commit**

```bash
git add src/components/Sidebar.tsx test/unit/client/components/Sidebar.test.tsx
git commit -m "feat(sidebar): clear (x) button resets repo filter to All"
```

---

### Task 4: AND-composition with other search settings, selection retention, repo-aware empty state

**Files:**
- Modify: `src/components/Sidebar.tsx` (empty-state ternary at ~lines 744-749)
- Test: `test/unit/client/components/Sidebar.test.tsx` (extend `describe('Repo filter dropdown')`)

**Interfaces:**
- Consumes: `repoFilter` state, `ALL_REPOS`, `repoOptions` retention behavior (built into `collectRepoFilterOptions(items, selected)` in Task 1); existing empty-state variables `visibleQuery` and `visibleSearchTier`; test helpers `createDeferred`, `mockSearchSessions`.
- Produces: repo-aware empty-state copy — exact string `No sessions in selected repo` — rendered when the list is empty and `repoFilter !== ALL_REPOS`.

- [ ] **Step 1: Write the failing tests**

Inside `describe('Repo filter dropdown', ...)`, add:

```tsx
    it('ANDs with visibility settings instead of replacing them', async () => {
      const store = createTestStore({
        sidebarSettings: { showSubagents: false },
        projects: [
          {
            projectPath: '/home/user/repo-alpha',
            sessions: [
              {
                sessionId: sessionId('alpha-main'),
                projectPath: '/home/user/repo-alpha',
                lastActivityAt: Date.now() - 1000,
                title: 'Alpha main session',
              },
              {
                sessionId: sessionId('alpha-sub'),
                projectPath: '/home/user/repo-alpha',
                lastActivityAt: Date.now() - 2000,
                title: 'Alpha subagent session',
                isSubagent: true,
              },
            ],
          },
          {
            projectPath: '/home/user/repo-beta',
            sessions: [
              {
                sessionId: sessionId('beta-main'),
                projectPath: '/home/user/repo-beta',
                lastActivityAt: Date.now() - 3000,
                title: 'Beta main session',
              },
            ],
          },
        ],
      })
      const { getByRole } = renderSidebar(store, [])
      await act(() => vi.advanceTimersByTime(100))

      // Visibility setting hides the subagent before any repo filtering.
      expect(screen.getByText('Alpha main session')).toBeInTheDocument()
      expect(screen.queryByText('Alpha subagent session')).not.toBeInTheDocument()

      fireEvent.change(getByRole('combobox', { name: /repo filter/i }), {
        target: { value: '/home/user/repo-alpha' },
      })

      // Repo filter composes (AND): subagent stays hidden, other repo drops out.
      expect(screen.getByText('Alpha main session')).toBeInTheDocument()
      expect(screen.queryByText('Alpha subagent session')).not.toBeInTheDocument()
      expect(screen.queryByText('Beta main session')).not.toBeInTheDocument()
    })

    it('coexists with the search tier dropdown while a query is active', async () => {
      const store = createTestStore({ projects: repoProjects })
      const { getByRole, getByPlaceholderText } = renderSidebar(store, [])
      await act(() => vi.advanceTimersByTime(100))

      fireEvent.change(getByPlaceholderText('Search...'), { target: { value: 'alpha' } })

      expect(getByRole('combobox', { name: /search tier/i })).toBeInTheDocument()
      expect(getByRole('combobox', { name: /repo filter/i })).toBeInTheDocument()
    })

    it('keeps the selected repo option and shows a repo-aware empty state when a search empties the window', async () => {
      const searchRequest = createDeferred<any>()
      vi.mocked(mockSearchSessions).mockReturnValueOnce(searchRequest.promise)

      const store = createTestStore({ projects: repoProjects })
      const { getByRole, getByPlaceholderText } = renderSidebar(store, [])
      await act(() => vi.advanceTimersByTime(100))

      fireEvent.change(getByRole('combobox', { name: /repo filter/i }), {
        target: { value: '/home/user/repo-alpha' },
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
      const select = getByRole('combobox', { name: /repo filter/i }) as HTMLSelectElement
      expect(select).toHaveValue('/home/user/repo-alpha')
      expect(Array.from(select.options).map((o) => o.value)).toContain('/home/user/repo-alpha')

      // Empty state names the repo filter as a possible cause.
      expect(screen.getByText('No sessions in selected repo')).toBeInTheDocument()
    })
```

- [ ] **Step 2: Run to verify the expected failures**

Run:
```bash
npm run test:vitest -- run test/unit/client/components/Sidebar.test.tsx --config config/vitest/vitest.config.ts -t "Repo filter"
```
Expected: the AND test and the coexistence test PASS already (behavior established in Tasks 1-2 — they are regression locks); the empty-state test FAILS with `Unable to find an element with the text: No sessions in selected repo` (current copy shows `No matching sessions`).

- [ ] **Step 3: Implement the repo-aware empty state**

In `src/components/Sidebar.tsx`, the empty-state block (~lines 744-749) currently reads:

```tsx
        <div className="px-2 py-8 text-center text-sm text-muted-foreground">
          {visibleQuery && visibleSearchTier !== 'title'
            ? 'No results found'
            : visibleQuery
            ? 'No matching sessions'
            : 'No sessions yet'}
        </div>
```

Change it to:

```tsx
        <div className="px-2 py-8 text-center text-sm text-muted-foreground">
          {repoFilter !== ALL_REPOS
            ? 'No sessions in selected repo'
            : visibleQuery && visibleSearchTier !== 'title'
            ? 'No results found'
            : visibleQuery
            ? 'No matching sessions'
            : 'No sessions yet'}
        </div>
```

- [ ] **Step 4: Run to verify all pass**

Run:
```bash
npm run test:vitest -- run test/unit/client/components/Sidebar.test.tsx --config config/vitest/vitest.config.ts -t "Repo filter"
```
Expected: PASS (10 tests in the describe).

- [ ] **Step 5: Run the whole Sidebar suite**

Run:
```bash
npm run test:vitest -- run test/unit/client/components/Sidebar.test.tsx --config config/vitest/vitest.config.ts
```
Expected: PASS — in particular the pre-existing empty-state expectations still pass because they never set a repo filter (`repoFilter` stays `'all'`).

- [ ] **Step 6: Commit**

```bash
git add src/components/Sidebar.tsx test/unit/client/components/Sidebar.test.tsx
git commit -m "feat(sidebar): repo filter composes with search settings and gets repo-aware empty state"
```

---

### Task 5: E2E flow test (`test/e2e/`, the AGENTS.md e2e gate)

AGENTS.md requires "both unit test & e2e coverage of everything"; the repo's e2e tier for UI controls is a Vitest flow test under `test/e2e/` (jsdom, real store/thunks/reducers, mocked `@/lib/api` + `@/lib/ws-client`) — modeled on `test/e2e/sidebar-search-flow.test.tsx`. Note: `test/e2e/` files run under the default client config (`config/vitest/vitest.config.ts` excludes only `test/e2e-browser/**` and `test/e2e-electron/**`), NOT under `npm run test:unit` — so this file is exercised by the individual coordinated-runner command below and by the `npm run test:client` gate in Task 6. The default config uses `sequence.shuffle: true`; each test must be fully self-contained.

**Files:**
- Create: `test/e2e/sidebar-repo-filter-flow.test.tsx`

**Interfaces:**
- Consumes: the complete feature from Tasks 1-4 (dropdown, filtering, clear button, AND-composition). No new production code.

- [ ] **Step 1: Write the flow test**

Create `test/e2e/sidebar-repo-filter-flow.test.tsx`. Copy the header block (imports, `vi.mock('@/lib/ws-client')`, `vi.mock('@/lib/api')`, `createStore`, `renderSidebar`, and the `beforeEach`/`afterEach` bodies) from `test/e2e/sidebar-search-flow.test.tsx` lines 1-173 verbatim (omit `createDeferred` and `getSidebarSessionOrder`, which this file does not use), renaming the describe to `'sidebar repo filter flow (e2e)'`, then add these two tests inside the describe:

```tsx
  const browseProjects: ProjectGroup[] = [
    {
      projectPath: '/home/user/repo-alpha',
      sessions: [{
        provider: 'claude',
        sessionId: 'session-alpha-1',
        projectPath: '/home/user/repo-alpha',
        lastActivityAt: 2_000,
        title: 'Alpha session',
      }],
    },
    {
      projectPath: '/home/user/repo-beta',
      sessions: [{
        provider: 'claude',
        sessionId: 'session-beta-1',
        projectPath: '/home/user/repo-beta',
        lastActivityAt: 1_000,
        title: 'Beta session',
      }],
    },
  ]

  function createBrowseStore() {
    vi.mocked(mockFetchSnapshot).mockResolvedValue({
      projects: browseProjects,
      totalSessions: 2,
      oldestIncludedTimestamp: 1_000,
      oldestIncludedSessionId: 'claude:session-beta-1',
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
            oldestLoadedSessionId: 'claude:session-beta-1',
          },
        },
      },
    })
  }

  it('repo dropdown filters browse results and the clear-x restores them', async () => {
    const store = createBrowseStore()
    renderSidebar(store)
    await act(() => vi.advanceTimersByTime(100))

    expect(screen.getByText('Alpha session')).toBeInTheDocument()
    expect(screen.getByText('Beta session')).toBeInTheDocument()

    const select = screen.getByRole('combobox', { name: /repo filter/i }) as HTMLSelectElement
    expect(select).toHaveValue('all')
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      'all',
      '/home/user/repo-alpha',
      '/home/user/repo-beta',
    ])

    fireEvent.change(select, { target: { value: '/home/user/repo-beta' } })
    expect(screen.getByText('Beta session')).toBeInTheDocument()
    expect(screen.queryByText('Alpha session')).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Clear repo filter'))
    expect(select).toHaveValue('all')
    expect(screen.getByText('Alpha session')).toBeInTheDocument()
    expect(screen.getByText('Beta session')).toBeInTheDocument()
  })

  it('repo filter ANDs with a committed server search and the selection survives the commit', async () => {
    vi.mocked(mockSearchSessions).mockResolvedValue({
      results: [
        {
          sessionId: 'session-alpha-hit',
          provider: 'claude',
          projectPath: '/home/user/repo-alpha',
          title: 'Alpha deploy notes',
          matchedIn: 'title',
          lastActivityAt: 3_000,
          archived: false,
        },
        {
          sessionId: 'session-beta-hit',
          provider: 'claude',
          projectPath: '/home/user/repo-beta',
          title: 'Beta deploy notes',
          matchedIn: 'title',
          lastActivityAt: 2_500,
          archived: false,
        },
      ],
      tier: 'title',
      query: 'deploy',
      totalScanned: 5,
    })

    const store = createBrowseStore()
    renderSidebar(store)
    await act(() => vi.advanceTimersByTime(100))

    const select = screen.getByRole('combobox', { name: /repo filter/i }) as HTMLSelectElement
    fireEvent.change(select, { target: { value: '/home/user/repo-alpha' } })
    expect(screen.queryByText('Beta session')).not.toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'deploy' } })
    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })

    expect(mockSearchSessions).toHaveBeenCalledWith(expect.objectContaining({
      query: 'deploy',
      tier: 'title',
    }))

    // Search results committed (window replaced); repo filter still ANDs on top.
    expect(screen.getByText('Alpha deploy notes')).toBeInTheDocument()
    expect(screen.queryByText('Beta deploy notes')).not.toBeInTheDocument()

    // Selection survived the window replacement and remains a valid option.
    expect(select).toHaveValue('/home/user/repo-alpha')
    expect(Array.from(select.options).map((o) => o.value)).toContain('/home/user/repo-alpha')
  })
```

(If the commit needs an extra microtask to render, follow the sibling file's idiom and add a second `await Promise.resolve()` inside the same `act` block — do not lengthen timers.)

- [ ] **Step 2: Run it**

Run:
```bash
npm run test:vitest -- run test/e2e/sidebar-repo-filter-flow.test.tsx --config config/vitest/vitest.config.ts
```
Expected: PASS (2 tests) immediately — the feature is complete after Tasks 1-4; this file is the e2e regression lock AGENTS.md requires. If it FAILS, fix the production code or the store seeding (compare against `sidebar-search-flow.test.tsx`), not the assertions.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/sidebar-repo-filter-flow.test.tsx
git commit -m "test(e2e): sidebar repo filter flow coverage (filter, clear, AND with server search)"
```

---

### Task 6: Non-persistence proof, UI mock update, full verification

**Files:**
- Test: `test/unit/client/components/Sidebar.test.tsx` (extend `describe('Repo filter dropdown')`)
- Modify: `docs/index.html` (sidebar mock, `.sb-search` block at ~lines 602-607)

**Interfaces:**
- Consumes: everything from Tasks 1-5. No new production code exports — this task proves the non-persistence requirement and finishes conventions.

- [ ] **Step 1: Write the failing/locking non-persistence test**

Inside `describe('Repo filter dropdown', ...)`, add:

```tsx
    it('never persists the selection: localStorage untouched and a fresh mount resets to All', async () => {
      const snapshotLocalStorage = () => {
        const entries: Record<string, string | null> = {}
        for (let i = 0; i < window.localStorage.length; i++) {
          const key = window.localStorage.key(i) as string
          entries[key] = window.localStorage.getItem(key)
        }
        return JSON.stringify(entries)
      }

      const store = createTestStore({ projects: repoProjects })
      const first = renderSidebar(store, [])
      await act(() => vi.advanceTimersByTime(100))

      const before = snapshotLocalStorage()
      fireEvent.change(first.getByRole('combobox', { name: /repo filter/i }), {
        target: { value: '/home/user/repo-alpha' },
      })
      expect(screen.queryByText('Beta session one')).not.toBeInTheDocument()
      expect(snapshotLocalStorage()).toBe(before)

      // Remount against the SAME store: client-side "browser refresh".
      // If the selection leaked into Redux or storage, it would survive this.
      cleanup()
      const second = renderSidebar(store, [])
      await act(() => vi.advanceTimersByTime(100))

      expect(second.getByRole('combobox', { name: /repo filter/i })).toHaveValue('all')
      expect(screen.getByText('Beta session one')).toBeInTheDocument()
      expect(screen.getByText('Alpha session one')).toBeInTheDocument()
    })
```

(`cleanup` is already imported at the top of the file. If the suite's `afterEach` interferes, this test is still self-contained — `cleanup()` is idempotent.)

- [ ] **Step 2: Run it**

Run:
```bash
npm run test:vitest -- run test/unit/client/components/Sidebar.test.tsx --config config/vitest/vitest.config.ts -t "never persists"
```
Expected: PASS immediately — the implementation (plain `useState`) was built non-persistent from Task 2. This test is the regression lock the spec demands; if it FAILS, persistence leaked in somewhere and must be removed (do not adjust the test).

- [ ] **Step 3: Update the nonfunctional UI mock (AGENTS.md convention for user-visible UI changes)**

In `docs/index.html`, the sidebar search mock currently reads (~lines 602-607):

```html
      <div class="sb-search">
        <div class="sb-search-wrap">
          <i data-lucide="search" class="icon"></i>
          <input type="text" placeholder="Search coding agents, tabs, projects…" readonly>
        </div>
      </div>
```

Change it to:

```html
      <div class="sb-search">
        <div class="sb-search-wrap">
          <i data-lucide="search" class="icon"></i>
          <input type="text" placeholder="Search coding agents, tabs, projects…" readonly>
        </div>
        <select aria-label="Repo filter" disabled style="width:100%;margin-top:6px;height:24px;font-size:11px;background:hsl(0 0% 14%);color:hsl(0 0% 60%);border:0;border-radius:6px;padding:0 6px">
          <option>All</option>
          <option>freshell</option>
          <option>api-server</option>
          <option>freshell-web</option>
        </select>
      </div>
```

(The mock is static/readonly; the repo names mirror the mock's existing session metadata. Open `docs/index.html` in a browser to eyeball that the dropdown renders under the search box without breaking the sidebar layout.)

- [ ] **Step 4: Full verification**

Run each; all must succeed:

```bash
npm run test:vitest -- run test/unit/client/store/sidebar-repo-filter.test.ts --config config/vitest/vitest.config.ts
npm run test:vitest -- run test/unit/client/components/Sidebar.test.tsx --config config/vitest/vitest.config.ts
npm run test:vitest -- run test/e2e/sidebar-repo-filter-flow.test.tsx --config config/vitest/vitest.config.ts
npm run typecheck:client
npm run lint
```
Expected: all PASS / exit 0 (lint includes the jsx-a11y gate — the `aria-label`s on the select and icon-only button satisfy it).

Then the coordinated client workload (may wait on the shared test gate). This is `test:client`, not `test:unit`, because `test:unit` runs only `test/unit/` and would never execute the Task 5 e2e flow test:

```bash
FRESHELL_TEST_SUMMARY="repo filter dropdown in sidebar search" npm run test:client
```
Expected: PASS with no regressions.

- [ ] **Step 5: Commit**

```bash
git add test/unit/client/components/Sidebar.test.tsx docs/index.html
git commit -m "test(sidebar): lock repo filter non-persistence; add repo dropdown to UI mock"
```

---

## Load-Bearing Validation Record (post-planning hardening)

Ten load-bearing assumptions were surfaced and validated (ledger: `.worktrees/.the-usual-logs/restore-locations-repo-filter/load-bearing-ledger.md`). Verified: backfill boundedness (A5), jsdom test inertness (A6), `projectPath` byte-identity across snapshot/search/append (A7). Falsified and fixed in this plan: window-derived options are NOT full-repo coverage (A2 — recorded as the deliberate "Windowed options" decision with documented rationale and upgrade path); server-fabricated live-terminal rows — both the `liveTerminalOnly` variant and the sessionId-bearing-but-unindexed variant surfaced by fresheyes review — would have produced bogus repo options (A3 — Task 1 composite gate + Task 2 test); two existing badge tests collide with the new option label (A8 — Task 2 Step 6 scoping fix); zero e2e coverage violated AGENTS.md (A10 — new Task 5 + `test:client` gate). Accepted decisions: Sidebar as the target surface (A1 — verified only joint clue match), hiding cwd-only rows under a specific repo (A4 — `terminalMeta.repoRoot` plumbing rejected as async-optional coupling), search-narrowed options (A9 — consistent with the windowed-options decision).

## Self-Review Record

Checked the plan against the spec from a fresh read (re-run after the load-bearing fixes):

1. **Spec coverage:**
   - "second dropdown … defaults to 'All'" → Task 2 (Steps 2/4; test asserts `toHaveValue('all')` and first option label `All`).
   - "populated with all the repos that we have restore locations for" → Task 1 (`repoPath` = repo root, composite-gated against server-fabricated live-terminal rows — both variants — and `'unknown'` paths; `collectRepoFilterOptions`) + Task 2 option-list tests, including the worktree-grouping-mode test proving options are repo roots, the two-variant live-terminal-exclusion test, and the "no repos → no dropdown" boundary. Scope is the loaded window per the recorded "Windowed options" decision.
   - "Selecting a repo filters the results to only locations from that repo" → Task 2 filtering test; Task 1 pure-function tests.
   - "ANDs with the other search settings (compose, not replace)" → filter applied *after* the full selector pipeline (visibility + applied search + tier + sort); Task 4 tests: AND-with-visibility-settings, coexistence with the tier dropdown during an active query, and AND-with-live-server-search (search commit while repo selected).
   - "'x' (clear) on the dropdown resets it to 'All'" → Task 3 (conditional button, reset behavior, hidden while on All).
   - "must NOT be persisted … refresh resets to 'All'" → component-local `useState` only (Global Constraints forbid `settings.sidebar.*`, `localStorage`, and window-state mirroring); Task 6 regression lock (localStorage snapshot + same-store remount resets to All).
2. **1b — no silent deferrals:** No stubs, mocks-as-behavior, or deferred requirements. Every user-facing behavior has a production implementation task and an observable test. The only mocked pieces in tests are the pre-existing suite-level WS/API mocks, and Task 4's live-search test exercises the real thunk/reducer path through them. No UNRESOLVED COVERAGE GAPS.
3. **Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N" items; every code step shows the code; every run step names the command and expected outcome.
4. **Type consistency:** `ALL_REPOS`/`RepoFilterOption`/`filterSessionItemsByRepo(items, repoFilter)`/`collectRepoFilterOptions(items, selected)` defined in Task 1 are used with identical names/signatures in Tasks 2-6; `repoFilter: string` state matches the functions' `string` params; `sidebarSettings` helper option defined in Task 2 Step 1 before its uses in Tasks 2 and 4.
