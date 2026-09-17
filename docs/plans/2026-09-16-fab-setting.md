# FAB Setting (panes.floatingActionButton) Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Add a user-configurable setting that controls whether the pane layout's floating action button (FAB) is shown, with the FAB disabled (not shown) by default.

### Explicit constraints
- The new setting's default must be off (FAB hidden) for all users unless they enable it.

### Accepted tradeoffs and residuals
- None stated.

**Goal:** Users can show or hide the pane layout's floating add/split button through a Settings → Panes toggle, and the button is hidden for every user until they explicitly enable it.

**Architecture:** Add a browser-local boolean `panes.floatingActionButton` to the existing `LocalSettings` tier, following the repo's canonical local-boolean pattern (`panes.repoIconsOnTabs`, commit `2130c907f`): the key must land in all four `shared/settings.ts` sites (`PANES_LOCAL_KEYS`, the `LocalSettings['panes']` type, the `normalizeExtractedLocalSeed` panes block, and `defaultLocalSettings.panes`) plus the `buildLocalSettingsPatch` diff writer, or it is silently dropped from persistence. Gate `PaneLayout`'s currently unconditional `<FloatingActionButton>` render on the resolved setting, expose a `Toggle` row in `PanesSettings`, and adapt every test/e2e/browser-use asset that assumed an always-visible FAB. No Rust/server changes — the FAB is a pure per-browser UI preference and the server patch schema already rejects local keys.

**Tech Stack:** TypeScript, React 18, Redux Toolkit (client); Zod-validated shared settings contract (`shared/settings.ts`); localStorage blob `freshell.browser-preferences.v1` (diff-vs-defaults, 500 ms debounce); Vitest + Testing Library (jsdom unit/integration); Playwright (e2e — cloud lane is this run's gate, plus a local-lane-only spec); Python browser_use smoke/demo scripts.

## Global Constraints

From the worktree's `AGENTS.md` (read it in full; the below are the values every task must honor):

- **Workspace:** all work and all commands run in `/home/dan/code/freshell/.worktrees/fab-setting` (branch `the-usual/fab-setting`, base `6ee5cf4b2905c1fef7de462abd2499561e9e8e67`). Line numbers in this plan are from that base; re-locate edit sites by the quoted content if lines shift.
- **TDD:** red-green-refactor for every task; never skip the test or the refactor step. Both unit and e2e coverage are required.
- **Focused tests:** `npm run test:vitest -- run <path> [<path>...]` (repo-owned passthrough). Never raw `npx vitest`. Focused task verification does not need backend pinning.
- **Gate lanes:** this run's e2e gate lane is CLOUD (`npm run test:e2e:cloud ...`). A spec sitting in `CLOUD_SKIP_SPECS` (`test/e2e-browser/playwright.cloud.config.ts`) or a filter that matched no tests is not coverage. `mobile-viewport.spec.ts` is cloud-skipped (local-lane only) — adapt it and prove it locally.
- **Quality commands:** after each task also run `npm run typecheck:client` and `npm run lint` (eslint over `src`, includes jsx-a11y). Broad repo gates go through the shared test coordinator (`npm test` / `npm run check`); never kill a foreign gate holder.
- **A11y:** every interactive element needs an accessible name. The new `Toggle` carries an explicit `aria-label` (rows with a `description` need it — see the warning comment at `test/unit/client/components/SettingsView.panes.test.tsx:253-257`). New Playwright interactions use accessible names (`getByRole`); the pre-existing `.xterm` locator in `pane-picker.ts` is grandfathered.
- **ESM/NodeNext:** relative imports in TypeScript test/e2e code need `.js` extensions (e.g. `'../helpers/pane-picker.js'`).
- **No server changes:** this is a browser-local setting. Do not touch `crates/`, `~/.freshell/config.json` handling, or the live self-hosted server (port 3001) — never restart it; the e2e lanes launch their own scratch servers.
- **Commits:** conventional style (`feat(settings): ...`, `test(e2e): ...`), one commit per task, only the listed files. The repo's git config already provides the identity `Dan Shapiro <3732858+danshapiro@users.noreply.github.com>` — never author as `dan@danshapiro.com`. Do not create or open a PR without explicit user approval; do not push behavior changes to `main`.
- **docs/index.html:** no change — the static mock never depicted the FAB (verified by exploration; the only "Add pane" text there is an unrelated fake session title at `docs/index.html:668`).
- **Plan code blocks are pre-implementation drafts.** Once execution begins, the source tree supersedes them.

---

### Task 1: Add the browser-local `panes.floatingActionButton` setting to the shared contract and persistence writer (default off)

**Files:**
- Modify: `shared/settings.ts:85` (PANES_LOCAL_KEYS), `shared/settings.ts:208-217` (`LocalSettings['panes']` type), `shared/settings.ts:578-586` (`normalizeExtractedLocalSeed` panes block), `shared/settings.ts:899-908` (`defaultLocalSettings.panes`)
- Modify: `src/store/browserPreferencesPersistence.ts:114` (`buildLocalSettingsPatch` panes block)
- Test: `test/unit/shared/settings.test.ts` (new describe after the `panes.repoIconsOnTabs` block at line 639, plus two imports)

**Interfaces:**
- Consumes: existing `LocalSettingsPatch` / `resolveLocalSettings` / `mergeLocalSettings` / `extractLegacyLocalSettingsSeed` / `composeResolvedSettings` / `buildServerSettingsPatchSchema` machinery in `shared/settings.ts` (all generic — no per-key edits needed anywhere else).
- Produces: `LocalSettings['panes'].floatingActionButton: boolean`; `defaultLocalSettings.panes.floatingActionButton === false`; `ResolvedSettings.panes.floatingActionButton` (via the `panes: { ...server.panes, ...local.panes }` spread); a `settings/updateSettingsLocal` payload `{ panes: { floatingActionButton: boolean } }` that survives the store's `normalizeLocalPatch` and the persisted-blob read path; localStorage blob `freshell.browser-preferences.v1` gains `{"settings":{"panes":{"floatingActionButton":true}}}` only when the value differs from the default.

- [ ] **Step 1: Write the failing behavioral test**

In `test/unit/shared/settings.test.ts`, add two imports after the existing `@shared/settings` import block (lines 1-15):

```ts
import { buildLocalSettingsPatch } from '@/store/browserPreferencesPersistence'
import { parseBrowserPreferencesRaw } from '@/lib/browser-preferences'
```

Then insert this describe immediately after the `panes.repoIconsOnTabs (browser-local)` describe's closing `})` (line 639) and before `describe('panes.tabBarRows (browser-local)', ...)`:

```ts
  describe('panes.floatingActionButton (browser-local)', () => {
    it('defaults to false', () => {
      const local = resolveLocalSettings(undefined)
      expect(local.panes.floatingActionButton).toBe(false)
    })

    it('applies a boolean patch', () => {
      const local = resolveLocalSettings({ panes: { floatingActionButton: true } })
      expect(local.panes.floatingActionButton).toBe(true)
    })

    it('merges patches preserving other pane keys', () => {
      const merged = mergeLocalSettings(
        { panes: { iconsOnTabs: false } },
        { panes: { floatingActionButton: true } },
      )
      expect(merged.panes?.iconsOnTabs).toBe(false)
      expect(merged.panes?.floatingActionButton).toBe(true)
    })

    it('preserves floatingActionButton when extracting the legacy local settings seed', () => {
      expect(extractLegacyLocalSettingsSeed({
        panes: {
          floatingActionButton: true,
        },
      } as Record<string, unknown>)).toEqual({
        panes: {
          floatingActionButton: true,
        },
      })
    })

    it('rejects non-boolean floatingActionButton in legacy seed extraction', () => {
      expect(extractLegacyLocalSettingsSeed({
        panes: {
          floatingActionButton: 'yes',
        },
      } as Record<string, unknown>)).toEqual(undefined)
    })

    it('is rejected by the server patch schema (stays local)', () => {
      const schema = buildServerSettingsPatchSchema()
      expect(schema.safeParse({ panes: { floatingActionButton: true } }).success).toBe(false)
    })

    it('includes floatingActionButton in composed resolved settings', () => {
      const resolved = composeResolvedSettings(
        createDefaultServerSettings({ loggingDebug: false }),
        resolveLocalSettings({ panes: { floatingActionButton: true } }),
      )
      expect(resolved.panes.floatingActionButton).toBe(true)
    })

    it('persists a non-default value through the browser-preferences diff', () => {
      const resolved = resolveLocalSettings({ panes: { floatingActionButton: true } })
      const patch = buildLocalSettingsPatch(resolved)
      expect(patch.panes?.floatingActionButton).toBe(true)
    })

    it('produces no persisted patch entry at the default value', () => {
      const patch = buildLocalSettingsPatch(resolveLocalSettings({}))
      expect(patch.panes?.floatingActionButton).toBeUndefined()
    })

    it('survives the reload path: a parsed browser-preferences record preserves floatingActionButton', () => {
      const raw = JSON.stringify({ settings: { panes: { floatingActionButton: true } } })
      const record = parseBrowserPreferencesRaw(raw)
      expect(record?.settings?.panes?.floatingActionButton).toBe(true)
    })
  })
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/shared/settings.test.ts`

Expected: FAIL — four tests in the new block fail because the key does not exist anywhere yet: `defaults to false` resolves to `undefined` (no default); `preserves ... legacy local settings seed` and `survives the reload path` return `undefined` (`pickKeys(raw.panes, PANES_LOCAL_KEYS)` drops the unknown key, so the whole panes section normalizes away); `persists ... browser-preferences diff` produces no `patch.panes.floatingActionButton` (no writer line). The other six tests pass at this point — `applies a boolean patch` and `includes ... composed resolved settings` because `resolveLocalSettings` merges panes via generic `mergeDefined` (shared/settings.ts:1325) and `composeResolvedSettings` spreads `local.panes` (1431-1434), so an unknown key flows through at runtime (Vitest does not typecheck); `merges patches...`, `rejects non-boolean...`, `is rejected by the server patch schema`, and `produces no persisted patch entry...` because the generic merge, the drop-either-way normalization, the strict server schema, and the missing writer trivially satisfy them. Those six are regression guards, not red drivers.

- [ ] **Step 3: Add the minimal production implementation**

Five edits.

1. `shared/settings.ts:85` — add the key to the panes local-key list (this one list drives both the legacy-seed pick and the `stripLocalSettings` server-patch strip):

```ts
const PANES_LOCAL_KEYS = ['snapThreshold', 'iconsOnTabs', 'tabAttentionStyle', 'attentionDismiss', 'sessionOpenMode', 'multirowTabs', 'repoIconsOnTabs', 'tabBarRows', 'floatingActionButton'] as const
```

2. `shared/settings.ts:216` — add the type field inside `LocalSettings['panes']` (after `tabBarRows: number`):

```ts
    floatingActionButton: boolean
```

3. `shared/settings.ts` — inside `normalizeExtractedLocalSeed`'s panes block, insert after the `normalizedTabBarRows` `if` block (lines 579-586) and before `if (Object.keys(panes).length > 0)`. Without this edit the key is silently dropped from every store update AND every persisted-blob read (`settingsSlice.normalizeLocalPatch` and `browser-preferences.ts normalizeRecord` both round-trip through this function):

```ts
    if (typeof patch.panes.floatingActionButton === 'boolean') {
      panes.floatingActionButton = patch.panes.floatingActionButton as boolean
    }
```

4. `shared/settings.ts:907` — add the default (this is the explicit-constraint edit: default OFF) inside `defaultLocalSettings.panes`, after `tabBarRows: TAB_BAR_ROWS_DEFAULT,`:

```ts
    floatingActionButton: false,
```

5. `src/store/browserPreferencesPersistence.ts` — add the persist-writer line in `buildLocalSettingsPatch`'s panes block, after the `tabBarRows` `assignChangedScalar` (line 114):

```ts
  assignChangedScalar(panes, localSettings.panes, defaultLocalSettings.panes, 'floatingActionButton')
```

No other production code needs edits: `resolveLocalSettings`/`mergeLocalSettings` merge panes generically via `mergeDefined`, `composeResolvedSettings` spreads `local.panes`, and the strict Zod server schemas (`panes: z.object({ defaultNewPane: ... }).strict()`) reject the new key automatically. Older stored blobs are safe in both directions: a blob lacking the key resolves to the `false` default, and an older client reading a newer blob drops the unknown key via `pickKeys` — no migration needed.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/shared/settings.test.ts`

Expected: PASS (all existing tests plus the ten new ones).

- [ ] **Step 5: Refactor while green**

No refactor needed: the change is five additive lines following the exact shape of the neighboring `repoIconsOnTabs`/`tabBarRows` entries, and the new tests mirror the established per-key describe pattern.

- [ ] **Step 6: Run impacted-test verification**

`shared/settings.ts` is a core shared contract; the impacted set is everything that resolves, merges, persists, or renders settings state: the whole shared-contract suite, the settings store tests, and the SettingsView tests that compose resolved settings.

Run: `npm run test:vitest -- run test/unit/shared test/unit/client/store test/unit/client/components/SettingsView.panes.test.tsx`

Run: `npm run typecheck:client && npm run lint`

Expected: PASS for both (typecheck proves the new optional-key typing is consistent across the client).

- [ ] **Step 7: Commit the task**

```bash
git add shared/settings.ts src/store/browserPreferencesPersistence.ts test/unit/shared/settings.test.ts
git commit -m "feat(settings): add panes.floatingActionButton browser-local setting (default off)"
```

---

### Task 2: Gate the FAB render on the setting (hidden by default)

**Files:**
- Modify: `src/components/panes/PaneLayout.tsx:62,70-74`
- Test: `test/unit/client/components/panes/PaneLayout.test.tsx:179` (new helper), `:372-392` (replace one test), `:398,443,482,509,539,569,599,625` (store swaps), `:662,743` (helper-body swaps)
- Test: `test/integration/client/editor-pane.test.tsx:199` (one dispatch in `createTestStore`)

**Interfaces:**
- Consumes: Task 1's `ResolvedSettings.panes.floatingActionButton` (readable at `s.settings.settings.panes.floatingActionButton`; `PaneLayout` already subscribes via `const settings = useAppSelector((s) => s.settings.settings)` at `PaneLayout.tsx:20`) and the `settings/updateSettingsLocal` action (`{ type: 'settings/updateSettingsLocal', payload: { panes: { floatingActionButton: true } } }`).
- Produces: `PaneLayout` renders `<FloatingActionButton>` only when the resolved setting is true; the FAB's accessible names stay `Add pane` / `Split horizontally` / `Split vertically` (relied upon by Tasks 3-4).

- [ ] **Step 1: Write the failing behavioral test**

In `test/unit/client/components/panes/PaneLayout.test.tsx`:

(a) Add a store helper immediately after `renderWithStore` (after line 179), mirroring the file's existing dispatch-injection pattern (`createStoreWithDefaultNewPane` at lines 658-668 uses the server analog `settings/previewServerSettingsPatch`):

```tsx
function createStoreWithFab(initialPanesState: Partial<PanesState> = {}) {
  const store = createStore(initialPanesState)
  store.dispatch({
    type: 'settings/updateSettingsLocal',
    payload: { panes: { floatingActionButton: true } },
  })
  return store
}
```

(b) Replace the single test `it('renders FloatingActionButton', ...)` (lines 372-392, inside the `rendering` describe) with these two tests:

```tsx
    it('hides the floating action button by default', async () => {
      const existingPaneId = 'pane-1'
      const store = createStore({
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: existingPaneId,
            content: createTerminalContent(),
          },
        },
        activePane: { 'tab-1': existingPaneId },
      })

      renderWithStore(
        <PaneLayout tabId="tab-1" defaultContent={createTerminalContent()} />,
        store
      )

      // The FAB is opt-in via the panes.floatingActionButton local setting.
      expect(screen.queryByTitle('Add pane')).not.toBeInTheDocument()
    })

    it('renders the floating action button when the setting is enabled', async () => {
      const existingPaneId = 'pane-1'
      const store = createStoreWithFab({
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: existingPaneId,
            content: createTerminalContent(),
          },
        },
        activePane: { 'tab-1': existingPaneId },
      })

      renderWithStore(
        <PaneLayout tabId="tab-1" defaultContent={createTerminalContent()} />,
        store
      )

      expect(screen.getByTitle('Add pane')).toBeInTheDocument()
    })
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/panes/PaneLayout.test.tsx`

Expected: FAIL — exactly one test, `hides the floating action button by default`, fails because `PaneLayout` currently renders `<FloatingActionButton>` unconditionally (line 70-74), so `queryByTitle('Add pane')` finds it. `renders the floating action button when the setting is enabled` and all pre-existing FAB-clicking tests still pass at this point (the gate does not exist yet).

- [ ] **Step 3: Add the minimal production implementation**

(a) `src/components/panes/PaneLayout.tsx` — derive the flag after `effectiveZoom` (after line 62) and wrap the render:

```tsx
  // Invalid/stale zoom IDs use the normal layout, including its dividers.
  const effectiveZoom = resolveSurfaceZoom(collectSurfaceLeaves(layout), zoomedPaneId)
  const showFloatingActionButton = settings.panes?.floatingActionButton ?? false
```

```tsx
      {showFloatingActionButton && (
        <FloatingActionButton
          onAdd={handleAddPane}
          onSplitHorizontal={() => handleSplit('horizontal')}
          onSplitVertical={() => handleSplit('vertical')}
        />
      )}
```

(replacing the bare `<FloatingActionButton ... />` at lines 70-74; the `?? false` mirrors the component's existing defensive `settings.panes?.defaultNewPane` style).

(b) `test/unit/client/components/panes/PaneLayout.test.tsx` — keep the ~15 pre-existing FAB-driving tests exercising their real input path by enabling the FAB in their store setup. All edits are `createStore(` → `createStoreWithFab(` on the store-creation line of exactly these tests (each anchored by its `it(...)` title; the call bodies are otherwise unchanged):

- `splits active pane when adding terminal` (store at :398)
- `uses horizontal split when container is wider than tall` (:443)
- `uses horizontal split for 2 panes regardless of container dimensions` (:482)
- `sets new pane as active after adding` (:509)
- `splits active pane when adding browser` (:539)
- `creates picker pane when FAB is clicked` (:569)
- `adds pane even when no active pane is set (falls back to first leaf)` (:599)
- `handles rapid add operations` (:625)
- In the helper bodies of BOTH `createStoreWithDefaultNewPane` copies (first at :658-668, second at :739-749): change `const store = createStore(panesState)` → `const store = createStoreWithFab(panesState)`. These helpers are used inside two DESCRIBES titled `FAB + button respects defaultNewPane setting` (:670, :693, :715 are the per-case tests inside the first, e.g. `creates shell terminal when defaultNewPane is "shell"`) and `split buttons respect defaultNewPane setting` (:751, :774, :797, :820, :842 are the per-case tests inside the second), which click the FAB's hover-revealed split buttons.

No other test in this file queries the FAB (verified by exploration: `hidden prop propagation`, `layout initialization`, `malformed persistence`, and the other `rendering` tests never touch it).

(c) `test/integration/client/editor-pane.test.tsx` — its `createTestStore` (lines 190-201) has no settings preload, so the four tests that click `getByRole('button', { name: /add pane/i })` (the helper `selectEditorFromPicker` at :203-208 used by `can add editor pane via FAB` :260 and `displays editor toolbar with path input` :292, and by `integrates with terminal and editor panes in split view` :636 via its call site :665; the direct click at :570 used by `maintains editor state when splitting panes` :537) would fail under the new default. Add the enable dispatch inside the helper so every store it builds renders the FAB exactly as before this change:

```ts
const createTestStore = () => {
  const store = configureStore({
    reducer: {
      panes: panesReducer,
      tabs: tabsReducer,
      settings: settingsReducer,
      connection: connectionReducer,
    },
  })
  store.dispatch(setStatus('ready'))
  // The floating add-pane button is opt-in (panes.floatingActionButton,
  // default off); enable it so this file's FAB-driven pane-creation flows
  // keep exercising their real input path.
  store.dispatch({
    type: 'settings/updateSettingsLocal',
    payload: { panes: { floatingActionButton: true } },
  })
  return store
}
```

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/panes/PaneLayout.test.tsx test/integration/client/editor-pane.test.tsx`

Expected: PASS — the two new tests plus all adapted tests.

- [ ] **Step 5: Refactor while green**

No refactor needed: the production change is one derived boolean plus a conditional wrapper; the test adaptations use one new helper that mirrors the file's established dispatch-injection pattern.

- [ ] **Step 6: Run impacted-test verification**

The gate changes what every test that renders a real `PaneLayout` sees. Impacted set: the whole panes component directory, the integration tests that render pane layouts, and the jsdom e2e flows that mount `PaneLayout` (they mock the FAB module to null, but they still render the gated parent):

Run: `npm run test:vitest -- run test/unit/client/components/panes test/integration/client test/e2e/refresh-context-menu-flow.test.tsx test/e2e/pane-context-menu-stability.test.tsx test/e2e/terminal-url-context-menu.test.tsx`

Run: `npm run typecheck:client && npm run lint`

Expected: PASS. (`FloatingActionButton.test.tsx` renders the component directly with props and is unaffected by the gate; the three flow tests mock `FloatingActionButton` to null; `pane-split-independence.test.tsx` dispatches Redux actions with no UI.)

- [ ] **Step 7: Commit the task**

```bash
git add src/components/panes/PaneLayout.tsx test/unit/client/components/panes/PaneLayout.test.tsx test/integration/client/editor-pane.test.tsx
git commit -m "feat(panes): gate floating action button behind panes.floatingActionButton"
```

---

### Task 3: Expose the toggle in Settings → Panes, with user-story e2e coverage

**Files:**
- Modify: `src/components/settings/PanesSettings.tsx:98` (new SettingsRow after the "Repo icons on tabs" row)
- Test: `test/unit/client/components/SettingsView.panes.test.tsx:268` (two new tests before the file's closing `})`)
- Test: `test/e2e-browser/specs/settings.spec.ts:253` (new test after the "Expand thinking..." test, before the describe's closing `})`)

**Interfaces:**
- Consumes: Task 1's setting and Task 2's gate; the existing `SettingsSectionProps.applyLocalSetting` (dispatches `settings/updateSettingsLocal`) and the `Toggle`/`SettingsRow` primitives from `src/components/settings/settings-controls.tsx`.
- Produces: an accessible switch with `aria-label="Toggle floating add-pane button"` in the Settings → Panes panel (row label "Floating add-pane button"), whose state is `settings.panes.floatingActionButton`. Tasks 4's specs and any future consumer select it by that accessible name.

- [ ] **Step 1: Write the failing behavioral test**

(a) In `test/unit/client/components/SettingsView.panes.test.tsx`, insert after the `toggles repo icons on tabs locally without calling /api/settings` test (ends at line 268), before the describe's closing `})`:

```tsx
  it('exposes the floating add-pane button toggle as an accessible switch, unchecked by default', () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )
    switchSettingsTab('Panes')

    const toggle = screen.getByRole('switch', { name: 'Toggle floating add-pane button' })
    expect(toggle).not.toBeChecked()
  })

  it('toggles the floating add-pane button locally without calling /api/settings', async () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )
    switchSettingsTab('Panes')

    // This row has a description, so the switch must be selected by its
    // accessible name (the Toggle sets aria-label="Toggle floating add-pane
    // button"); do not use the iconsOnTabs test's closest('div') pattern.
    const toggle = screen.getByRole('switch', { name: 'Toggle floating add-pane button' })
    fireEvent.click(toggle)

    expect(store.getState().settings.settings.panes.floatingActionButton).toBe(true)

    await act(async () => {
      vi.advanceTimersByTime(600)
    })

    expect(api.patch).not.toHaveBeenCalled()
  })
```

(b) In `test/e2e-browser/specs/settings.spec.ts`, insert this test after the `Expand thinking and Expand tools switches persist locally and reset to defaults` test (line 253), before the describe's closing `})`. It proves the full user story on the lane this run gates with (cloud) — default hidden, toggle on, persisted across reload, visible, toggle off, hidden again:

```ts
  test('floating add-pane button is hidden by default, can be enabled, and persists locally', async ({ freshellPage, page, harness, serverInfo }) => {
    // Two reload legs plus two settings sessions; the cloud-gated budget
    // follows the Expand thinking reload-leg precedent in this file.
    if (isCloudLaneWindowConfigured()) test.setTimeout(120_000)

    // The FAB is opt-in: a default boot never renders it.
    await expect(page.getByRole('button', { name: 'Add pane' })).toHaveCount(0)

    await openSettingsSection(page, 'Panes')
    const fabSwitch = page.getByRole('switch', { name: 'Toggle floating add-pane button' })
    await expect(fabSwitch).toHaveAttribute('aria-checked', 'false')

    // Opt in; the resolved setting and the persisted blob (diff-vs-defaults)
    // both carry the key.
    await fabSwitch.click()
    await expect(fabSwitch).toHaveAttribute('aria-checked', 'true')
    await page.waitForTimeout(PERSIST_DEBOUNCE_WAIT_MS)
    expect((await harness.getSettings()).panes.floatingActionButton).toBe(true)
    const blob = await page.evaluate(() => localStorage.getItem('freshell.browser-preferences.v1'))
    expect(JSON.parse(blob ?? '{}').settings?.panes?.floatingActionButton).toBe(true)

    // The opt-in persists across reload and the FAB is visible on the next
    // boot (tabs/panes restore from localStorage; the 10s timeout rides
    // out the restore).
    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await harness.waitForHarness()
    await harness.waitForConnection(undefined, {
      selfHealReload: isCloudLaneWindowConfigured(),
    })
    expect((await harness.getSettings()).panes.floatingActionButton).toBe(true)
    await expect(page.getByRole('button', { name: 'Add pane' })).toBeVisible({ timeout: 10_000 })

    // Resetting to the default drops the key from the blob, and the next
    // boot renders without the FAB again.
    await openSettingsSection(page, 'Panes')
    await fabSwitch.click()
    await expect(fabSwitch).toHaveAttribute('aria-checked', 'false')
    await page.waitForTimeout(PERSIST_DEBOUNCE_WAIT_MS)
    const blobOff = await page.evaluate(() => localStorage.getItem('freshell.browser-preferences.v1'))
    expect(JSON.parse(blobOff ?? '{}').settings?.panes?.floatingActionButton).toBeUndefined()

    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await harness.waitForHarness()
    await harness.waitForConnection(undefined, {
      selfHealReload: isCloudLaneWindowConfigured(),
    })
    await expect(page.getByRole('button', { name: 'Add pane' })).toHaveCount(0)
  })
```

(`settings.spec.ts` is not in `CLOUD_SKIP_SPECS`, so this test runs on the cloud gate lane; the `--grep=floating` token below matches only this test — verified unique across `test/e2e-browser`.)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/SettingsView.panes.test.tsx`

Expected: FAIL — both new tests fail at `getByRole('switch', { name: 'Toggle floating add-pane button' })` because no such switch exists yet.

Run: `npm run test:e2e:local -- --project=chromium --grep=floating`

Expected: FAIL — the new e2e test fails waiting for the `Toggle floating add-pane button` switch in the Panes settings panel (the row does not exist). Its first assertion (FAB count 0) passes — Task 2 already delivered the default-off gate.

- [ ] **Step 3: Add the minimal production implementation**

`src/components/settings/PanesSettings.tsx` — insert after the "Repo icons on tabs" `SettingsRow` (closes at line 98), before the "Tab completion indicator" row:

```tsx
        <SettingsRow label="Floating add-pane button" description="Show the floating add/split button in the corner of the pane area.">
          <Toggle
            checked={settings.panes?.floatingActionButton ?? false}
            aria-label="Toggle floating add-pane button"
            onChange={(checked) => {
              applyLocalSetting({ panes: { floatingActionButton: checked } })
            }}
          />
        </SettingsRow>
```

This mirrors the `repoIconsOnTabs` block (lines 90-98) with `?? false` for the off default. `applyLocalSetting` (from `SettingsView.tsx:71-73`) dispatches `updateSettingsLocal`, and the browser-preferences middleware already persists that action type — no other wiring is needed.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/SettingsView.panes.test.tsx`

Expected: PASS.

Run: `npm run test:e2e:local -- --project=chromium --grep=floating`

Expected: PASS (1 test).

- [ ] **Step 5: Refactor while green**

No refactor needed: one SettingsRow following the file's established row pattern; tests follow the file's established toggle-test pattern.

- [ ] **Step 6: Run impacted-test verification**

The new row changes the Panes settings panel every `SettingsView` test renders. The e2e evidence must come from the configured gate lane (cloud), per the AGENTS.md PR rule.

Run: `npm run test:vitest -- run test/unit/client/components/SettingsView`

Run: `npm run typecheck:client && npm run lint`

Run: `npm run test:e2e:cloud -- --grep=floating`

Expected: PASS for all three — the cloud run reports 1 passed (the new spec; the local run in Step 4 proved the same test locally).

- [ ] **Step 7: Commit the task**

```bash
git add src/components/settings/PanesSettings.tsx test/unit/client/components/SettingsView.panes.test.tsx test/e2e-browser/specs/settings.spec.ts
git commit -m "feat(settings): floating add-pane button toggle in Panes settings with e2e coverage"
```

---

### Task 4: Adapt the Playwright helper fallback and the mobile-viewport contract to the default-off FAB

**Files:**
- Modify: `test/e2e-browser/helpers/pane-picker.ts:14-16` (FAB fallback branch)
- Test: `test/e2e-browser/specs/pane-picker.spec.ts:37` (new test before the describe's closing `})`)
- Modify: `test/e2e-browser/specs/mobile-viewport.spec.ts:186` (harness dispatch before the overlap check)

**Interfaces:**
- Consumes: Tasks 1-3 behavior; the e2e page-global test harness `window.__FRESHELL_TEST_HARNESS__` (installed on every `?e2e=1` page by `src/lib/test-harness.ts`; its `dispatch` is the live store dispatch — `src/lib/test-harness.ts:19,130` — so `window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'settings/updateSettingsLocal', payload: { panes: { floatingActionButton: true } } })` flips the FAB immediately because `PaneLayout` re-renders on settings changes; in-page dispatch precedent: `mobile-viewport.spec.ts:145`).
- Produces: `openPanePicker`'s no-terminal fallback remains functional under the default-off FAB (it enables the FAB through the harness, then clicks it); the mobile-viewport Send-button/add-pane overlap contract keeps exercising a visible FAB; a new cloud-runnable spec proves the fallback path.

- [ ] **Step 1: Write the failing behavioral test**

In `test/e2e-browser/specs/pane-picker.spec.ts`, insert before the describe's closing `})` (after the `creates a shell pane when a shell option is selected` test):

```ts
  test('openPanePicker uses the add-pane-button fallback when no terminal is visible', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()

    // Swap the terminal pane for an editor pane so no .xterm is visible and
    // openPanePicker must take its add-pane-button fallback branch (the FAB
    // is opt-in; the adapted helper enables it through the test harness).
    const tabId = await harness.getActiveTabId()
    expect(tabId).toBeTruthy()
    const layout = await harness.getPaneLayout(tabId!)
    expect(layout?.type).toBe('leaf')
    const paneId = layout.id as string
    await page.evaluate(({ currentTabId, currentPaneId }) => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'panes/updatePaneContent',
        payload: {
          tabId: currentTabId,
          paneId: currentPaneId,
          content: {
            kind: 'editor',
            filePath: null,
            language: null,
            readOnly: false,
            content: '',
            viewMode: 'source',
            wordWrap: true,
          },
        },
      })
    }, { currentTabId: tabId!, currentPaneId: paneId })
    await expect(page.locator('.xterm')).toHaveCount(0, { timeout: 10_000 })

    const picker = await openPanePicker(page)
    await expect(picker.getByRole('button', { name: /^Editor$/i })).toBeVisible()
  })
```

(The `panes/updatePaneContent` dispatch STYLE mirrors `mobile-viewport.spec.ts:143-167` (which dispatches a fresh-agent payload there); the editor content SHAPE comes from `PaneLayout.tsx:36` / the `EditorPaneContent` defaults at `paneTypes.ts:146-160`. The title deliberately contains the unique token `add-pane-button` for the focused cloud run below — no other spec title in `test/e2e-browser` contains it.)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/pane-picker.spec.ts`

Expected: FAIL — the new test fails inside `openPanePicker`'s fallback branch: with no visible `.xterm`, the helper clicks `getByRole('button', { name: /add pane/i })`, which no longer exists under the default-off FAB (Task 2), so the click times out and the picker never appears. The two pre-existing tests in the file pass (they drive the context-menu branch).

Run: `npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/mobile-viewport.spec.ts`

Expected: FAIL — `fresh-agent composer and region are visible on mobile viewport` fails at `await expect(addPaneButton).toBeVisible()` (line 187) because the FAB is hidden by default. This is the pre-existing red this task's third edit clears; the spec's other five tests pass. (This spec is in `CLOUD_SKIP_SPECS` — it only ever runs locally.)

- [ ] **Step 3: Add the minimal production implementation**

(a) `test/e2e-browser/helpers/pane-picker.ts` — replace the fallback `else` branch (lines 14-16) so it enables the opt-in FAB through the harness before clicking it:

```ts
  } else {
    // The floating add-pane button is opt-in (panes.floatingActionButton,
    // default off). Enable it through the e2e test harness before falling
    // back to clicking it, so this branch keeps working on pages with no
    // visible terminal yet.
    await page.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'settings/updateSettingsLocal',
        payload: { panes: { floatingActionButton: true } },
      })
    })
    await page.getByRole('button', { name: /add pane/i }).click()
  }
```

(The harness dispatch is a no-op on non-e2e pages; this helper is only used by e2e specs. No current spec reaches this branch at runtime — the `freshellPage` fixture pre-selects a shell via `selectShellFromPicker` (`helpers/fixtures.ts:316-326`), which never calls `openPanePicker`, and spec-owned pages wait for `.xterm` first — which is exactly why Step 1's test drives it deliberately.)

(b) `test/e2e-browser/specs/mobile-viewport.spec.ts` — in `fresh-agent composer and region are visible on mobile viewport`, insert immediately before the `const addPaneButton = page.getByRole('button', { name: /^add pane$/i })` line (line 186), using the same in-page dispatch style as the test's own `updatePaneContent` dispatch:

```ts
    // The floating add-pane button is opt-in (panes.floatingActionButton,
    // default off). Enable it through the test harness so this mobile
    // layout contract keeps checking the Send button against a VISIBLE
    // add-pane button.
    await page.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'settings/updateSettingsLocal',
        payload: { panes: { floatingActionButton: true } },
      })
    })
```

Do not change the overlap assertion itself (lines 186-192) — the point is to keep exercising a visible FAB, the pre-change contract. The FAB-only comments in `restore-contract-wall-rust.spec.ts:1512-1519` and `amplifier-restore-rust.spec.ts:106-110` are historical incident records whose reasoning (the `.xterm` probe hitting a hidden tab) is unchanged — leave them.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/pane-picker.spec.ts`

Expected: PASS (3 tests).

Run: `npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/mobile-viewport.spec.ts`

Expected: PASS (6 tests).

- [ ] **Step 5: Refactor while green**

No refactor needed: both edits are small in-page dispatches following each file's established harness-dispatch style; the helper change restores its exact pre-change behavior for every scenario it was designed for.

- [ ] **Step 6: Run impacted-test verification**

`openPanePicker` is used by ~43 spec files (~66 call sites), all of which take the context-menu or early-return branches and are unaffected by the fallback edit: the edit is additive inside the fallback `else` branch, which those consumers cannot reach (the `freshellPage` fixture pre-selects a shell via `selectShellFromPicker` and specs wait for `.xterm`, so they take the byte-identical context-menu branch). NOTE (whole-branch review M-1): the coordinated full-suite gate this run uses (`npm test`) contains NO Playwright phase — there is no broad e2e lane run in this run's gate; the backstop for the helper change is the static-unreachability argument above plus the directly affected specs proven green on their configured lanes (the focused cloud runs in this task's Step 6). Task-level impacted verification: the directly changed/added specs on the cloud lane (the gate lane), plus the local-only mobile spec.

Run: `npm run test:e2e:cloud -- --grep=add-pane-button`

Expected: PASS — 1 passed (the new fallback test; `pane-picker.spec.ts` is not in `CLOUD_SKIP_SPECS`).

Run: `npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/mobile-viewport.spec.ts`

Expected: PASS — per AGENTS.md, the mobile spec's pass/fail must be demonstrated on the local lane where it actually runs; it can never be cloud evidence.

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/helpers/pane-picker.ts test/e2e-browser/specs/pane-picker.spec.ts test/e2e-browser/specs/mobile-viewport.spec.ts
git commit -m "test(e2e): adapt pane-picker fallback and mobile viewport spec to default-off FAB"
```

---

### Task 5: Adapt the browser_use smoke and demo scripts to the default-off FAB

**Files:**
- Modify: `test/browser_use/smoke_freshell.py` (readiness gate :403-405,:415-417; prompts :95,:105,:170; new `right_click` action after the `double_click` registration :623-649)
- Modify: `test/browser_use/demo_synth.py` (readiness gate :221-227; prompts :692,:700; new `register_right_click` after `register_insert_text` :241-274; registration call in `run_agent_task` :500-502)

**Interfaces:**
- Consumes: the default-off DOM contract produced by Tasks 1-3 — at a default boot there is no `button[aria-label="Add pane"]` (proven by Task 2's hidden-by-default unit test and Task 3's e2e `toHaveCount(0)`), while `[data-pane-root]` (`PaneLayout.tsx:65`) always mounts with the tab view; the terminal right-click context menu item "Split horizontally" (`src/components/context-menu/menu-defs.ts:512`) is the default-experience pane-split path, and Freshell's context menu opens from a document-level capture `contextmenu` listener (`src/components/context-menu/ContextMenuProvider.tsx:1311`), so a synthetic bubbling `contextmenu` MouseEvent opens it.
- Produces: a `right_click` browser_use action in both scripts (same registration pattern as the existing `double_click`/`insert_text` CDP actions), readiness gates keyed on `[data-pane-root]`, and prompts that drive pane splitting through the context menu instead of the FAB.

These scripts are manually-run smokes (`npm run smoke:browser-use`; the `browser_use` Python package is not installed in this workspace), so their verification here is syntax + static-contract checks; a full run needs the external browser_use environment and a live server.

- [ ] **Step 1: Write the failing check**

The failure already exists on paper: run the following and observe that both scripts hard-require an element the app no longer renders by default:

```bash
rg -n 'Add pane' test/browser_use/smoke_freshell.py test/browser_use/demo_synth.py
```

Expected: matches at `smoke_freshell.py:95,105,170` (prompt instructions to click the FAB), `:415` (readiness gate `has_add_pane = ... button[aria-label="Add pane"]`, a required conjunct of the 30 s bootstrap gate — under the new default this gate times out with "App did not bootstrap auth/render in time"), and `demo_synth.py:221-227` (same gate), `:692,700` (prompt instructions). Task 2's `hides the floating action button by default` test and Task 3's e2e `toHaveCount(0)` prove the required selector is gone from the default DOM, so these gates and instructions fail as written — that contradiction is this task's red.

- [ ] **Step 2: Confirm the intended failure statically**

The scripts' bootstrap gates fail under the new default for the exact missing-affordance reason above (their required selector no longer exists in the default boot DOM). A live red run requires the external browser_use environment, so the contradiction above — plus the Task 2/3 proofs that the selector is gone — is the failure evidence for this task.

- [ ] **Step 3: Add the minimal production implementation**

(a) `smoke_freshell.py` — readiness gate (lines 402-419). Change the comment at line 405 from `# - terminal view rendered (Add Pane button present)` to `# - terminal view rendered (pane layout present)` and swap the selector conjunct:

```python
        has_pane_root = await page.evaluate("() => !!document.querySelector('[data-pane-root]')")
        has_connected = await page.evaluate("() => !!document.querySelector('[title=\"Connected\"]')")
        if auth_present and token_removed and has_pane_root and has_connected:
```

`[data-pane-root]` is the same render-proof the FAB used to provide (the FAB rendered inside that very div, `PaneLayout.tsx:65`) without depending on terminal attach.

(b) `smoke_freshell.py` — prompt instructions. Replace the three FAB-click lines with context-menu splits:

- Line 95: `      - Do it one pane at a time: right_click a terminal pane, click "Split horizontally" in the menu, then pick ONE shell type in the picker.`
- Line 105: `    - Use right_click on a terminal pane, then "Split horizontally", to split, then pick the pane type in the new pane chooser.`
- Line 170: `      - Split once (right_click a terminal pane, then "Split horizontally") to get another picker.`

(c) `smoke_freshell.py` — register a `right_click` action immediately after the `double_click` registration (after line 649), mirroring its DOM.resolveNode + Runtime.callFunctionOn shape:

```python
  class RightClickAction(BaseModel):
    index: int

  @tools.registry.action("Right-click an element by index (dispatches a contextmenu MouseEvent).", param_model=RightClickAction)
  async def right_click(params: RightClickAction, browser_session):  # type: ignore[no-untyped-def]
    try:
      element = await browser_session.get_element_by_index(params.index)
      if element is None:
        return ActionResult(error=f"Element index {params.index} not found")
      cdp_session = await browser_session.get_or_create_cdp_session(target_id=None, focus=True)
      sid = cdp_session.session_id
      resolved = await cdp_session.cdp_client.send.DOM.resolveNode(
        params={"backendNodeId": element.backend_node_id}, session_id=sid,
      )
      object_id = resolved["object"]["objectId"]
      await cdp_session.cdp_client.send.Runtime.callFunctionOn(
        params={
          "objectId": object_id,
          "functionDeclaration": "function() { const r = this.getBoundingClientRect(); this.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, button: 2, clientX: r.left + Math.max(1, r.width / 2), clientY: r.top + Math.max(1, r.height / 2)})); }",
          "returnByValue": True,
        },
        session_id=sid,
      )
      memory = f"Right-clicked element at index {params.index}"
      return ActionResult(extracted_content=memory, long_term_memory=memory)
    except Exception as e:
      return ActionResult(error=f"Failed to right-click: {type(e).__name__}: {e}")
```

(d) `demo_synth.py` — readiness gate (lines 221-227), same swap:

```python
            has_pane_root = await page.evaluate(
                "() => !!document.querySelector('[data-pane-root]')"
            )
            has_connected = await page.evaluate(
                "() => !!document.querySelector('[title=\"Connected\"]')"
            )
            if auth_present and token_removed and has_pane_root and has_connected:
```

(e) `demo_synth.py` — add a `register_right_click` module-level function immediately after `register_insert_text` (after line 274), following that function's local-import style:

```python
def register_right_click(tools):
    """Register a CDP right-click action (dispatches a contextmenu MouseEvent)."""
    from browser_use.agent.views import ActionResult
    from pydantic import BaseModel

    class RightClickAction(BaseModel):
        index: int

    @tools.registry.action(
        "Right-click an element by index (dispatches a contextmenu MouseEvent).",
        param_model=RightClickAction,
    )
    async def right_click(params: RightClickAction, browser_session):
        try:
            element = await browser_session.get_element_by_index(params.index)
            if element is None:
                return ActionResult(error=f"Element index {params.index} not found")
            cdp_session = await browser_session.get_or_create_cdp_session(
                target_id=None, focus=True
            )
            sid = cdp_session.session_id
            resolved = await cdp_session.cdp_client.send.DOM.resolveNode(
                params={"backendNodeId": element.backend_node_id}, session_id=sid,
            )
            object_id = resolved["object"]["objectId"]
            await cdp_session.cdp_client.send.Runtime.callFunctionOn(
                params={
                    "objectId": object_id,
                    "functionDeclaration": "function() { const r = this.getBoundingClientRect(); this.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, button: 2, clientX: r.left + Math.max(1, r.width / 2), clientY: r.top + Math.max(1, r.height / 2)})); }",
                    "returnByValue": True,
                },
                session_id=sid,
            )
            memory = f"Right-clicked element at index {params.index}"
            return ActionResult(extracted_content=memory, long_term_memory=memory)
        except Exception as e:
            return ActionResult(
                error=f"Failed to right-click: {type(e).__name__}: {e}"
            )
```

and register it in `run_agent_task` right after `register_insert_text(tools, timeline=timeline)` (line 500):

```python
    register_right_click(tools)
```

(f) `demo_synth.py` — prompt instructions in `STEP3_TASK`:

- Line 692: `1) Right-click the Claude Code terminal pane (use the right_click action) and click "Split horizontally" in the menu to add a new pane.`
- Line 700: `5) Right-click the shell terminal pane (right_click action) and click "Split horizontally" again.`

Both scripts keep driving the DEFAULT experience this way (the smoke is a default-experience QA pass; seeding the FAB preference into the driven profile would silently stop testing the default).

- [ ] **Step 4: Run the focused test**

Run: `python3 -m py_compile test/browser_use/smoke_freshell.py test/browser_use/demo_synth.py && echo COMPILE_OK`

Expected: `COMPILE_OK` (both scripts compile).

- [ ] **Step 5: Refactor while green**

No refactor needed: both scripts gain one action registration that mirrors their existing CDP action verbatim in style; the gate/prompt edits are line-level swaps.

- [ ] **Step 6: Run impacted-test verification**

These scripts are outside the Vitest/Playwright gates; the impacted set is the scripts themselves plus the repo's lint/typecheck surface (unchanged — Python is not covered by either):

Run: `rg -n 'Add pane' test/browser_use/smoke_freshell.py test/browser_use/demo_synth.py`

Expected: no matches (every FAB dependency is gone).

Run: `rg -n 'data-pane-root|right_click' test/browser_use/smoke_freshell.py test/browser_use/demo_synth.py`

Expected: matches showing the new readiness-gate selector and the `right_click` registration/action references in both files.

Run: `npm run typecheck:client && npm run lint`

Expected: PASS (no client/lint surface changed by this task; run to close the loop).

A full live smoke (`npm run smoke:browser-use`) requires the external browser_use environment and a running Freshell instance; if that environment is available to the implementer, run it once as the final proof, otherwise record the static verification above.

- [ ] **Step 7: Commit the task**

```bash
git add test/browser_use/smoke_freshell.py test/browser_use/demo_synth.py
git commit -m "test(browser-use): adapt smoke and demo scripts to default-off floating button"
```

---

## Verification summary (user-visible outcome)

- **Default off (the explicit constraint):** `defaultLocalSettings.panes.floatingActionButton === false` (Task 1 unit), FAB absent at default render (Task 2 unit), switch unchecked by default (Task 3 unit), FAB `toHaveCount(0)` at a real default boot (Task 3 e2e on the cloud gate lane).
- **User-configurable:** Settings → Panes → "Floating add-pane button" switch flips `settings.panes.floatingActionButton` locally with no `/api/settings` call (Task 3 unit + e2e), and the FAB appears/disappears accordingly (Task 2 unit shown-when-enabled; Task 3 e2e visible-after-enable and absent-after-reset).
- **Persistence:** blob diff-vs-defaults round-trips (Task 1 unit incl. the reload-path pin; Task 3 e2e blob + reload legs).
- **Nothing regressed:** ~15 PaneLayout unit tests, 4 editor-pane integration tests, the mobile-viewport overlap contract, the shared pane-picker helper, and both browser_use scripts all keep working under the new default.
