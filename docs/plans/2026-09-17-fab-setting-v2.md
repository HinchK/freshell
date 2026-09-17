# fab-setting-v2: Split-Panes Button Platform Default Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
- A Freshell setting that enables/disables the floating action button (FAB) used to add/split panes, with a clear user-facing label such as "show button to split panes". The setting defaults to true on desktop and false on mobile.

### Explicit constraints
- Use the-usual workflow.
- Setting name should be clear, like 'show button to split panes'.
- Default to true on desktop, false on mobile.

### Accepted tradeoffs and residuals
- None stated.

**Goal:** The existing Settings → Panes toggle for the floating add/split button gets the clear user-facing label "Show button to split panes", and its default flips from "off everywhere" to "on at desktop viewport width, off at mobile viewport width", with persistence, unit tests, e2e coverage, and committed screenshot baselines all following the new default.

**Architecture:** Keep the browser-local setting key `panes.floatingActionButton` exactly as the prior run landed it (no schema/key rename — the user's naming request is the user-facing label). Keep `shared/settings.ts`'s static `floatingActionButton: false` as the shared, Node/SSR-neutral default, and add an explicit, defaulted options parameter (`LocalSettingsPlatformDefaults.floatingActionButtonDefault`) to `resolveLocalSettings` and `buildLocalSettingsPatch` (following the `resolveDefaultLoggingDebug` injectable-default precedent, `src/store/settingsSlice.ts:22-32`). The client computes the platform default ONCE at boot — `resolveDefaultFloatingActionButton(isMobileDevice())` = `!isMobileDevice()` — and threads that single `localSettingsPlatformDefaults` const through every client path that can resolve or diff local settings without an explicit saved value: the settings-slice boot resolution (`loadInitialLocalSettings`), the cross-tab hydrate re-resolution (`crossTabSync.ts:283-284`), the legacy-seed bootstrap path (`App.tsx:674,692`), and the browser-preferences write-diff (`browserPreferencesPersistence.ts:115,169,283`). The default is sticky per boot: resizing across the 767px breakpoint mid-session does not re-resolve until the next reload. The persistence write-diff MUST use the same computed platform default as resolution — otherwise desktop boots silently persist spurious `floatingActionButton: true` blobs on any unrelated settings flush, which then show the FAB on later mobile boots of the same browser. After boot, the resolved `localSettings` always carry a concrete boolean that survives every reducer round-trip (`PANES_LOCAL_KEYS` whitelists the key, `pickKeys` copies own keys, `mergeLocalSettings` merges panes via `mergeDefined`), so the reducers themselves never resolve the FAB from a default and need no threading.

**Tech Stack:** TypeScript (NodeNext/ESM, `.js` relative imports), React 18 + Redux Toolkit, Zod-validated shared settings contract (`shared/settings.ts`), localStorage blob `freshell.browser-preferences.v1` (diff-vs-defaults, 500 ms debounce), Vitest + Testing Library (jsdom, desktop-ambient matchMedia mock in `test/setup/dom.ts`), Playwright (local + Cloud Run lanes), static HTML mock (`docs/index.html`).

## Global Constraints

- **Workspace:** all work and commands run in `/home/dan/code/freshell/.worktrees/fab-setting-v2` (branch `the-usual/fab-setting-v2`, base `69ae349a5`, which already contains the prior run's landed `panes.floatingActionButton` setting, default off). Line numbers in this plan are from that base; re-locate edit sites by the quoted content if lines shift.
- **TDD:** red-green-refactor for every task; never skip the test or the refactor step. Both unit and e2e coverage are required for the behavior change.
- **Test lanes:** non-interactive shells do NOT source `~/.bashrc` — every Vitest/e2e gate command below is written with the pinned prefix `FRESHELL_VITEST_BACKEND=cloud FRESHELL_E2E_BACKEND=cloud FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com`. Record the lane actually used from the run log's banner. Focused Vitest runs use `npm run test:vitest -- run <path> [<path>...]` (the repo-owned coordinator passthrough) — never raw `npx vitest`.
- **E2e budget contract (PR #785):** the `freshellPage` fixture-timeout tuple wiring is never modified. This plan adds NO `CLOUD_SKIP_SPECS` entries and NO new timeout wiring; the reworked settings.spec.ts desktop test keeps its existing `if (isCloudLaneWindowConfigured()) test.setTimeout(120_000)` declaration, and the new mobile presence test declares the same cloud budget for its fixture-less boot chain. `e2e-budget-contract.spec.ts` is untouched and stays cloud-runnable with its selection-nonvacuity pins intact.
- **Mobile means viewport width, not device.** The repo's only mobile classifier is `(max-width: 767px)` — `src/hooks/useMobile.ts` (reactive) and `src/lib/mobile-device.ts` (`isMobileDevice()`, one-shot, guarded to `false` outside browsers). There is no UA/touch/device classifier. Say it plainly in every relevant test comment: a desktop browser window narrowed below 768px counts as mobile, and that matches every existing mobile behavior in this repo. The platform default is computed once per page load from `isMobileDevice()` and is sticky for the session.
- **The setting is browser-local only.** It lives in the localStorage blob `freshell.browser-preferences.v1` and is never sent to the server; the Rust patch schema is strict and rejects the key (pinned by `test/unit/shared/settings.test.ts:684-687`). Do NOT touch `crates/`, the live self-hosted server (port 3001 — never restart it), or `~/.freshell/config.json` handling. The e2e lanes launch their own scratch servers.
- **A11y:** the renamed switch keeps `role="switch"` with an accessible name; its `aria-label` is exactly the visible row label ("Show button to split panes" — label-in-name, WCAG 2.5.3). Rows with a `description` must be selected by accessible name in tests (see the warning comment at `test/unit/client/components/SettingsView.panes.test.tsx:253-257`). The FAB component's own accessible names ("Add pane", "Split horizontally", "Split vertically") are NOT renamed — the request renames the setting's label, and renaming the button labels would balloon the blast radius with no user request behind it.
- **Impacted-test sets must include every consumer** (per the blast-radius inventory in `.the-usual-logs/fab-setting-v2/reports/plan-default-flip-blast-radius.md`): the settings-layer suites (`settingsSlice.test.ts`, `state-edge-cases.test.ts`, `browserPreferencesPersistence.test.ts`, `crossTabSync.test.ts`), the consumption suites (`PaneLayout.test.tsx`, `SettingsView.panes.test.tsx`, `editor-pane.test.tsx`), the e2e lane specs (`settings.spec.ts`, `mobile-viewport.spec.ts`, `pane-picker.spec.ts`, `screenshot-baselines.spec.ts`), and the ~18 untouched groups are explicitly re-run or argued green in each task's Step 6.
- **TypeScript NodeNext/ESM:** relative imports include `.js` extensions in test/e2e code (e.g. `'../helpers/fixtures.js'`).
- **Quality commands:** after every task also run `npm run typecheck:client && npm run lint` (pinned env prefix not needed for these two, but harmless to include). Broad repo gates go through the shared test coordinator; never kill a foreign gate holder.
- **Commits:** conventional style, one commit per task, only the listed files. The repo's git config already provides the identity `Dan Shapiro <3732858+danshapiro@users.noreply.github.com>` — never override git identity, never author as `dan@danshapiro.com`, never commit secrets. Do not push; do not open a PR without explicit user approval.
- **Plan code blocks are pre-implementation drafts.** Once execution begins, the source tree supersedes them.

---

### Task 1: Shared resolution and persistence-diff accept an explicit platform default for `panes.floatingActionButton`

Additive-only: an options parameter on `resolveLocalSettings` and `buildLocalSettingsPatch`. No caller changes behavior in this task (all ~60 existing `resolveLocalSettings(...)` zero/one-arg callers and all zero-arg `buildLocalSettingsPatch(...)` callers keep the static-base behavior), so every existing suite stays green; the platform option is exercised only by new tests.

**Files:**
- Modify: `shared/settings.ts` (new exported interface near `:270`; `resolveLocalSettings` signature and panes resolution at `:1318-1340`)
- Modify: `src/store/browserPreferencesPersistence.ts:87-118` (`buildLocalSettingsPatch` signature and the FAB diff line at `:115`)
- Test: `test/unit/shared/settings.test.ts` (new tests inside the existing `panes.floatingActionButton (browser-local)` describe at `:644-713`)

**Interfaces:**
- Consumes: existing `LocalSettingsPatch`, `defaultLocalSettings`, `mergeDefined` (`shared/settings.ts:296-305`), `assignChangedScalar` (`src/store/browserPreferencesPersistence.ts:76-85`).
- Produces: `export interface LocalSettingsPlatformDefaults { floatingActionButtonDefault?: boolean }` (shared/settings.ts); `resolveLocalSettings(patch?: LocalSettingsPatch, options?: LocalSettingsPlatformDefaults): LocalSettings`; `buildLocalSettingsPatch(localSettings: LocalSettings, options?: LocalSettingsPlatformDefaults): LocalSettingsPatch`. Task 3 consumes exactly these signatures; `resolveBrowserPreferenceSettings` gains the same passthrough in Task 3.

- [ ] **Step 1: Write the failing behavioral test**

In `test/unit/shared/settings.test.ts`, inside the `panes.floatingActionButton (browser-local)` describe (lines 644-713; `resolveLocalSettings`, `buildLocalSettingsPatch` — imported at `:17` — and `parseBrowserPreferencesRaw` are already imported), add after the existing `survives the reload path...` test (ends `:712`), before the describe's closing `})`:

```ts
    it('defaults to true when the desktop platform default is provided', () => {
      const local = resolveLocalSettings(undefined, { floatingActionButtonDefault: true })
      expect(local.panes.floatingActionButton).toBe(true)
    })

    it('defaults to false when the mobile platform default is provided', () => {
      const local = resolveLocalSettings(undefined, { floatingActionButtonDefault: false })
      expect(local.panes.floatingActionButton).toBe(false)
    })

    it('keeps an explicit value over the platform default (old default-off-era opt-ins survive the flip)', () => {
      const local = resolveLocalSettings(
        { panes: { floatingActionButton: true } },
        { floatingActionButtonDefault: false },
      )
      expect(local.panes.floatingActionButton).toBe(true)
    })

    it('persists a value that differs from the provided platform default and omits one that equals it (desktop base)', () => {
      const off = resolveLocalSettings({ panes: { floatingActionButton: false } }, { floatingActionButtonDefault: true })
      expect(buildLocalSettingsPatch(off, { floatingActionButtonDefault: true }).panes?.floatingActionButton).toBe(false)
      const on = resolveLocalSettings({ panes: { floatingActionButton: true } }, { floatingActionButtonDefault: true })
      expect(buildLocalSettingsPatch(on, { floatingActionButtonDefault: true }).panes?.floatingActionButton).toBeUndefined()
    })

    it('persists a value that differs from the provided platform default and omits one that equals it (mobile base)', () => {
      const on = resolveLocalSettings({ panes: { floatingActionButton: true } }, { floatingActionButtonDefault: false })
      expect(buildLocalSettingsPatch(on, { floatingActionButtonDefault: false }).panes?.floatingActionButton).toBe(true)
      const off = resolveLocalSettings({ panes: { floatingActionButton: false } }, { floatingActionButtonDefault: false })
      expect(buildLocalSettingsPatch(off, { floatingActionButtonDefault: false }).panes?.floatingActionButton).toBeUndefined()
    })

    it('resolves an old default-off-era blob as an explicit true even under the mobile platform default', () => {
      const raw = JSON.stringify({ settings: { panes: { floatingActionButton: true } } })
      const record = parseBrowserPreferencesRaw(raw)
      const local = resolveLocalSettings(record?.settings, { floatingActionButtonDefault: false })
      expect(local.panes.floatingActionButton).toBe(true)
    })
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `FRESHELL_VITEST_BACKEND=cloud FRESHELL_E2E_BACKEND=cloud FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com npm run test:vitest -- run test/unit/shared/settings.test.ts`

Expected: FAIL — exactly two tests fail because the option does not exist yet and is silently ignored: `defaults to true when the desktop platform default is provided` (resolves the static `false` instead of `true`) and `persists ... (desktop base)` (both halves fail against the static base: the `off` value diffs `false === false`, produces no entry, and `toBe(false)` fails; the `on` value diffs `true !== false`, produces a spurious entry, and `toBeUndefined()` fails). The other four new tests are regression guards that pass before implementation and must keep passing after: the mobile-default pin and the explicit-over-platform pin pass either way (the static default is also `false`), the mobile-base diff test passes either way (`true` already differs from the static `false`, `false` already equals it), and the old-blob pin passes because explicit patches already win today. All ten pre-existing tests in the describe stay green (their zero-arg calls are unchanged).

- [ ] **Step 3: Add the minimal production implementation**

(a) `shared/settings.ts` — insert this exported interface immediately after `SettingsDefaultsOptions` (`:270-272`):

```ts
/**
 * Platform-dependent defaults for browser-local settings. The shared layer
 * stays deterministic: every option is optional and, when omitted, the
 * static defaultLocalSettings value applies. The browser client injects
 * its boot-time platform snapshot (desktop vs mobile viewport class) so
 * resolution AND the browser-preferences write-diff share one base within
 * a boot; Node tools and zero-arg callers keep the static defaults.
 */
export interface LocalSettingsPlatformDefaults {
  /** Default for panes.floatingActionButton. Undefined = the shared
   * static default (false). Desktop clients pass true; mobile clients
   * pass false. */
  floatingActionButtonDefault?: boolean
}
```

(b) `shared/settings.ts` — change `resolveLocalSettings` (`:1318-1340`): add the defaulted parameter and use it only as the panes base default:

```ts
export function resolveLocalSettings(
  patch?: LocalSettingsPatch,
  options: LocalSettingsPlatformDefaults = {},
): LocalSettings {
  const migratedFreshAgentPatch = patch
    ? migrateLegacyFreshAgentSettingsInput(patch as Record<string, unknown>).freshAgent as FreshAgentSettingsPatchInput | undefined
    : undefined
  const freshAgentPatch = sanitizeFreshAgentLocalSettingsPatchInput(
    isRecord(migratedFreshAgentPatch) ? migratedFreshAgentPatch : {},
  )
  const panesDefaults = options.floatingActionButtonDefault === undefined
    ? defaultLocalSettings.panes
    : { ...defaultLocalSettings.panes, floatingActionButton: options.floatingActionButtonDefault }
  return {
    ...defaultLocalSettings,
    ...(hasOwn(patch, 'theme') ? { theme: patch?.theme ?? defaultLocalSettings.theme } : {}),
    ...(hasOwn(patch, 'uiScale') ? { uiScale: patch?.uiScale ?? defaultLocalSettings.uiScale } : {}),
    terminal: mergeDefined(defaultLocalSettings.terminal, patch?.terminal),
    panes: mergeDefined(panesDefaults, patch?.panes),
```

(the rest of the returned object — sidebar, freshAgent, notifications, streamDeck blocks at `:1331-1339` — is unchanged; the only edited line in the return is `panes: mergeDefined(panesDefaults, patch?.panes)`).

(c) `src/store/browserPreferencesPersistence.ts` — add the type to the existing `@shared/settings` import (line 3) and thread the option into the FAB diff. Signature and panes block (`:87-118`):

```ts
import { mergeLocalSettings, defaultLocalSettings, type LocalSettings, type LocalSettingsPatch, type LocalSettingsPlatformDefaults } from '@shared/settings'
```

```ts
export function buildLocalSettingsPatch(
  localSettings: LocalSettings,
  options: LocalSettingsPlatformDefaults = {},
): LocalSettingsPatch {
  const patch: LocalSettingsPatch = {}
```

and inside the panes block, compute the diff base once (before the first `assignChangedScalar(panes, ...)` line) and change only the FAB line:

```ts
  const panes: LocalSettingsPatch['panes'] = {}
  const panesDefaults = options.floatingActionButtonDefault === undefined
    ? defaultLocalSettings.panes
    : { ...defaultLocalSettings.panes, floatingActionButton: options.floatingActionButtonDefault }
  assignChangedScalar(panes, localSettings.panes, defaultLocalSettings.panes, 'snapThreshold')
  assignChangedScalar(panes, localSettings.panes, defaultLocalSettings.panes, 'iconsOnTabs')
  assignChangedScalar(panes, localSettings.panes, defaultLocalSettings.panes, 'tabAttentionStyle')
  assignChangedScalar(panes, localSettings.panes, defaultLocalSettings.panes, 'attentionDismiss')
  assignChangedScalar(panes, localSettings.panes, defaultLocalSettings.panes, 'sessionOpenMode')
  assignChangedScalar(panes, localSettings.panes, defaultLocalSettings.panes, 'multirowTabs')
  assignChangedScalar(panes, localSettings.panes, defaultLocalSettings.panes, 'repoIconsOnTabs')
  assignChangedScalar(panes, localSettings.panes, defaultLocalSettings.panes, 'tabBarRows')
  assignChangedScalar(panes, localSettings.panes, panesDefaults, 'floatingActionButton')
  if (Object.keys(panes).length > 0) {
    patch.panes = panes
  }
```

No other production caller changes in this task: `src/App.tsx:674`, the middleware (`:169`, `:283`), and every test caller keep calling with no options, so the diff base stays static everywhere until Task 3 threads the computed platform default.

- [ ] **Step 4: Run the focused test**

Run: `FRESHELL_VITEST_BACKEND=cloud FRESHELL_E2E_BACKEND=cloud FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com npm run test:vitest -- run test/unit/shared/settings.test.ts`

Expected: PASS (all pre-existing tests plus the six new ones).

- [ ] **Step 5: Refactor while green**

No refactor needed: two defaulted-parameter additions that follow the file's existing options-object shapes (`SettingsDefaultsOptions`), with the panes base override computed once per call.

- [ ] **Step 6: Run impacted-test verification**

`resolveLocalSettings` is the core shared resolver called by ~60 test files (zero/one-arg) and by the store, persistence, and cross-tab layers; `buildLocalSettingsPatch` is called by the persistence middleware, `App.tsx:674`, and the stream-deck/settings suites. The impacted set is the whole shared-contract suite plus the client store suites that resolve or diff settings:

Run: `FRESHELL_VITEST_BACKEND=cloud FRESHELL_E2E_BACKEND=cloud FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com npm run test:vitest -- run test/unit/shared test/unit/client/store test/unit/client/lib/browser-preferences.test.ts`

Run: `npm run typecheck:client && npm run lint`

Expected: PASS for both. (`test/unit/shared/settings.stream-deck.test.ts` uses zero-arg `buildLocalSettingsPatch` — static base, unchanged; `crossTabSync.test.ts` and `browserPreferencesPersistence.test.ts` exercise the middleware with zero-arg internal calls — unchanged in this task.)

- [ ] **Step 7: Commit the task**

```bash
git add shared/settings.ts src/store/browserPreferencesPersistence.ts test/unit/shared/settings.test.ts
git commit -m "feat(settings): platform-default option for panes.floatingActionButton resolution and diff"
```

---

### Task 2: Rename the setting's user-facing label to "Show button to split panes"

Pure string change while the default is still off (Task 3 flips the default), so every suite stays green at this task's commit and Task 3's new tests are written once with the final strings. The e2e spec titles keep the `--grep=floating` token (a repo convention uses `--grep=floating`-style focused filtering; the feature's internal name stays "floating action button").

Exact final strings (chosen once, mirrored everywhere):
- Row label: `Show button to split panes`
- Row description: `Show the floating add/split button in the corner of the pane area.` (unchanged from today — it already describes the control precisely)
- Switch `aria-label`: `Show button to split panes` (identical to the visible label — label-in-name, WCAG 2.5.3; the switch must be selected by accessible name because the row has a description, per the warning comment at `test/unit/client/components/SettingsView.panes.test.tsx:253-257`)

**Files:**
- Modify: `src/components/settings/PanesSettings.tsx:100-108`
- Test: `test/unit/client/components/SettingsView.panes.test.tsx:270-305` (two `getByRole` names at `:279`, `:295`, and the comment at `:292-294`)
- Test: `test/e2e-browser/specs/settings.spec.ts:264` (switch locator name)

**Interfaces:**
- Consumes: the existing `SettingsRow`/`Toggle` primitives (`src/components/settings/settings-controls.tsx:32-54`, `:93-126` — `<button role="switch" aria-checked={checked} aria-label={ariaLabel ?? ...}>`).
- Produces: an accessible switch named `Show button to split panes` in the Settings → Panes panel. Task 3's rewritten unit and e2e tests select the switch by exactly this name.

- [ ] **Step 1: Write the failing behavioral test**

(a) `test/unit/client/components/SettingsView.panes.test.tsx` — in the two FAB tests (lines 270-305), change the switch locator name and the explanatory comment; the assertions themselves stay default-off-correct for now:

```tsx
  it('exposes the floating add-pane button toggle as an accessible switch, unchecked by default', () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )
    switchSettingsTab('Panes')

    const toggle = screen.getByRole('switch', { name: 'Show button to split panes' })
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
    // accessible name (the Toggle sets aria-label="Show button to split
    // panes"); do not use the iconsOnTabs test's closest('div') pattern.
    const toggle = screen.getByRole('switch', { name: 'Show button to split panes' })
    fireEvent.click(toggle)

    expect(store.getState().settings.settings.panes.floatingActionButton).toBe(true)

    await act(async () => {
      vi.advanceTimersByTime(600)
    })

    expect(api.patch).not.toHaveBeenCalled()
  })
```

(b) `test/e2e-browser/specs/settings.spec.ts:264` — in the existing FAB story test (title and assertions unchanged in this task), change only the locator:

```ts
    const fabSwitch = page.getByRole('switch', { name: 'Show button to split panes' })
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `FRESHELL_VITEST_BACKEND=cloud FRESHELL_E2E_BACKEND=cloud FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com npm run test:vitest -- run test/unit/client/components/SettingsView.panes.test.tsx`

Expected: FAIL — both edited tests fail at `getByRole('switch', { name: 'Show button to split panes' })` because the production switch is still named "Toggle floating add-pane button" (no such accessible name exists yet). This is the missing behavior, not a setup accident.

Run: `FRESHELL_VITEST_BACKEND=cloud FRESHELL_E2E_BACKEND=cloud FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com npm run test:e2e:local -- --project=chromium --grep=floating`

Expected: FAIL — the e2e story test fails waiting for the `Show button to split panes` switch in the Panes settings panel (the row still carries the old label). Its default-hidden assertion still passes — the default is still off in this task.

- [ ] **Step 3: Add the minimal production implementation**

`src/components/settings/PanesSettings.tsx:100-108` — replace the row (label, aria-label; description unchanged):

```tsx
        <SettingsRow label="Show button to split panes" description="Show the floating add/split button in the corner of the pane area.">
          <Toggle
            checked={settings.panes?.floatingActionButton ?? false}
            aria-label="Show button to split panes"
            onChange={(checked) => {
              applyLocalSetting({ panes: { floatingActionButton: checked } })
            }}
          />
        </SettingsRow>
```

(`applyLocalSetting` from `src/components/SettingsView.tsx:71-73` dispatches `updateSettingsLocal` — pure local, no `/api/settings` call; the `?? false` fallback stays and is re-documented in Task 3.)

- [ ] **Step 4: Run the focused test**

Run: `FRESHELL_VITEST_BACKEND=cloud FRESHELL_E2E_BACKEND=cloud FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com npm run test:vitest -- run test/unit/client/components/SettingsView.panes.test.tsx`

Expected: PASS.

Run: `FRESHELL_VITEST_BACKEND=cloud FRESHELL_E2E_BACKEND=cloud FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com npm run test:e2e:local -- --project=chromium --grep=floating`

Expected: PASS (1 test — the whole default-off story still holds with the renamed switch).

- [ ] **Step 5: Refactor while green**

No refactor needed: one SettingsRow's strings move together with its tests, matching the file's established row and toggle-test patterns.

- [ ] **Step 6: Run impacted-test verification**

The row is rendered by every SettingsView test that opens the Panes panel; the label strings appear in exactly three files (production + the two test files edited above — verified by whole-tree grep in the blast-radius report §5). The e2e evidence must come from the configured cloud gate lane.

Run: `FRESHELL_VITEST_BACKEND=cloud FRESHELL_E2E_BACKEND=cloud FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com npm run test:vitest -- run test/unit/client/components/SettingsView`

Run: `npm run typecheck:client && npm run lint`

Run: `FRESHELL_VITEST_BACKEND=cloud FRESHELL_E2E_BACKEND=cloud FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com npm run test:e2e:cloud -- --grep=floating`

Expected: PASS for all three — the cloud run reports 1 passed (`settings.spec.ts` is not in `CLOUD_SKIP_SPECS`).

- [ ] **Step 7: Commit the task**

```bash
git add src/components/settings/PanesSettings.tsx test/unit/client/components/SettingsView.panes.test.tsx test/e2e-browser/specs/settings.spec.ts
git commit -m "feat(settings): rename split-panes button setting label for clarity"
```

---

### Task 3: Flip the default — platform-threaded boot resolution (desktop on / mobile off), coherent persistence diff, and every consumer re-pinned

This is the atomic behavior change. The client computes the platform default once at settings-slice module init and threads it through every path that can see a saved-preferences patch without an explicit FAB value; every unit and e2e pin of the old default-off story is re-pinned in the same task so each lane is green at the commit. Design facts this task relies on (all verified against the tree):

1. After boot, the resolved `localSettings` always carry a concrete `floatingActionButton` boolean, and it survives every reducer round-trip (`PANES_LOCAL_KEYS` at `shared/settings.ts:85`, `pickKeys` copies own keys at `:429-437`, `mergeLocalSettings` merges panes via `mergeDefined` at `:1359-1362`, `normalizeExtractedLocalSeed` keeps booleans at `:588-590`). So the slice reducers (`setLocalSettings`/`updateSettingsLocal`) never resolve the FAB from a default and are NOT threaded — only boot, cross-tab hydrate, the legacy-seed bootstrap path, and the write-diff are.
2. The write-diff must use the same computed platform default as boot resolution (browserPreferencesPersistence.ts:115). Without it, desktop boots diff `true` against static `false` and silently persist `floatingActionButton: true` on any unrelated flush — poisoning later mobile boots of the same browser. The exact-blob unit tests are the canaries.
3. `defaultSettings` (the exported static composite, `settingsSlice.ts:30`) keeps the static local defaults; it has no production consumer of the FAB key (whole-tree grep) and tests preload it deliberately to keep the FAB out of unrelated suites.
4. Cross-tab coherence: each browser window threads its own boot-time platform default, so a wide window (default on) and a narrowed window (default off) of the same browser each keep their own coherent answer; an explicit saved value wins in every window.
5. Sticky per boot: resizing across the 767px breakpoint mid-session does not re-resolve until the next reload — pinned by a dedicated unit test.
6. The consumption fallbacks (`settings.panes?.floatingActionButton ?? false` at `PaneLayout.tsx:63` and `PanesSettings.tsx:102`) stay `false` and are deliberately NOT separately unit-pinned: after module init the resolved store always carries a concrete boolean, so an undefined-key store state is not a real app state — the defined-value behavior (desktop default-on, explicit-disable, mobile default) is what the three PaneLayout tests pin.

**Files:**
- Modify: `src/store/settingsSlice.ts:3-24` (imports + new resolver/const), `:71-73` (`loadInitialLocalSettings`)
- Modify: `src/lib/browser-preferences.ts:212-214` (`resolveBrowserPreferenceSettings`)
- Modify: `src/store/crossTabSync.ts:7,282-284`
- Modify: `src/store/browserPreferencesPersistence.ts:3,7,87-118,161-182,280-284`
- Modify: `src/App.tsx:5,674,692`
- Modify: `src/components/panes/PaneLayout.tsx:63` (comment only — the `?? false` stays)
- Modify: `shared/settings.ts` (Step 5 refactor: extract the shared `panesDefaultsWith` helper used by `resolveLocalSettings` and `buildLocalSettingsPatch`)
- Test: `test/unit/client/store/settingsSlice.test.ts` (2 consequence fixes + 3 new tests)
- Test: `test/unit/client/store/state-edge-cases.test.ts:846-849` (1 consequence fix)
- Test: `test/unit/client/store/browserPreferencesPersistence.test.ts` (2 consequence fixes at `:42`, `:99` + 2 new direction pins)
- Test: `test/unit/client/components/panes/PaneLayout.test.tsx:1-9,381-422` (default-test flip + 2 new pins)
- Test: `test/unit/client/components/SettingsView.panes.test.tsx:270-305` (default-checked + click-direction flip on bare reducer-booted stores; `createTestStore` unchanged)
- Test: `test/integration/client/editor-pane.test.tsx:200-204` (comment only)
- Test: `test/e2e-browser/specs/settings.spec.ts:255-302` (story inversion) + new mobile presence test
- Test: `test/e2e-browser/specs/mobile-viewport.spec.ts:186-198` (one default-hidden line + comment)
- Modify: `test/e2e-browser/helpers/pane-picker.ts:14-26` (comment only)
- Test: `test/e2e-browser/specs/pane-picker.spec.ts:42-44` (comment only)

**Interfaces:**
- Consumes: Task 1's `LocalSettingsPlatformDefaults` + the option-aware `resolveLocalSettings`/`buildLocalSettingsPatch`; Task 2's switch accessible name `Show button to split panes`; `isMobileDevice()` from `src/lib/mobile-device.ts:11`; the jsdom matchMedia mock (`test/setup/dom.ts:56-102` — `__MOBILE_MATCHES__` defaults to `false` = desktop, `setMobileForTest(bool)` global helper); the e2e `freshellPage`/`page`/`serverInfo`/`harness` fixtures and `isCloudLaneWindowConfigured()` from `test/e2e-browser/helpers/*`.
- Produces: `export function resolveDefaultFloatingActionButton(isMobile: boolean): boolean` and `export const localSettingsPlatformDefaults: LocalSettingsPlatformDefaults` from `src/store/settingsSlice.ts` (desktop-true/mobile-false at module init); a settings store whose boot-resolved `localSettings.panes.floatingActionButton` is `true` at desktop width and `false` at mobile width; a persistence blob that records only explicit choices relative to the same platform default; e2e evidence for both defaults on the cloud gate lane.

- [ ] **Step 1: Write the failing behavioral tests**

(a) `test/unit/client/store/settingsSlice.test.ts` — add three tests inside the top-level `describe('settingsSlice', ...)` (after the `keeps defaultSettings exported as resolved settings` test, which ends at `:53`); the two full-equality consequence fixes happen in Step 3:

```ts
  it('resolves the panes.floatingActionButton platform default at boot: desktop true, mobile false', async () => {
    // jsdom's matchMedia mock boots desktop-ambient (test/setup/dom.ts resets
    // __MOBILE_MATCHES__ to false), so a fresh slice import resolves the
    // desktop default: the FAB setting is ON.
    const desktop = await importFreshSettingsSlice()
    expect(desktop.default(undefined, { type: 'unknown' }).localSettings.panes.floatingActionButton).toBe(true)

    // Flip the mock to mobile BEFORE the fresh import: importFreshSettingsSlice
    // resets the module registry, so the re-imported slice re-reads matchMedia
    // and resolves the mobile default: OFF. Mobile = viewport width
    // (max-width: 767px), not device class — same rule as useMobile().
    ;(globalThis as any).setMobileForTest(true)
    try {
      const mobile = await importFreshSettingsSlice()
      expect(mobile.default(undefined, { type: 'unknown' }).localSettings.panes.floatingActionButton).toBe(false)
    } finally {
      ;(globalThis as any).setMobileForTest(false)
    }
  })

  it('keeps the boot-time platform default for the rest of the session (a later resize across the mobile breakpoint does not re-resolve)', async () => {
    const { default: settingsReducer, updateSettingsLocal } = await importFreshSettingsSlice()
    const initialState = settingsReducer(undefined, { type: 'unknown' })
    expect(initialState.localSettings.panes.floatingActionButton).toBe(true) // desktop boot

    ;(globalThis as any).setMobileForTest(true)
    try {
      const state = settingsReducer(initialState, updateSettingsLocal({ theme: 'dark' }))
      expect(state.localSettings.panes.floatingActionButton).toBe(true) // still the boot answer
      expect(state.localSettings.theme).toBe('dark')
    } finally {
      ;(globalThis as any).setMobileForTest(false)
    }
  })

  it('hydrates a saved explicit false over the desktop platform default at boot', async () => {
    localStorage.setItem(BROWSER_PREFERENCES_STORAGE_KEY, JSON.stringify({
      settings: { panes: { floatingActionButton: false } },
    }))
    try {
      const { default: settingsReducer } = await importFreshSettingsSlice()
      const state = settingsReducer(undefined, { type: 'unknown' })
      expect(state.localSettings.panes.floatingActionButton).toBe(false)
    } finally {
      localStorage.removeItem(BROWSER_PREFERENCES_STORAGE_KEY)
    }
  })
```

(b) `test/unit/client/components/panes/PaneLayout.test.tsx` — extend the settings import (line 9, `import settingsReducer from '@/store/settingsSlice'`) and add the shared resolver import:

```ts
import settingsReducer, { setLocalSettings } from '@/store/settingsSlice'
import { resolveLocalSettings } from '@shared/settings'
```

Replace the two tests at `:381-422` (inside the `rendering` describe) with three:

```tsx
    it('shows the floating action button by default on desktop', async () => {
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

      // jsdom boots desktop-ambient: the panes.floatingActionButton platform
      // default is ON (desktop true / mobile false), so a default boot shows
      // the FAB with no Settings change.
      expect(screen.getByTitle('Add pane')).toBeInTheDocument()
    })

    it('hides the floating action button when the setting is explicitly disabled', async () => {
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
      store.dispatch({
        type: 'settings/updateSettingsLocal',
        payload: { panes: { floatingActionButton: false } },
      })

      renderWithStore(
        <PaneLayout tabId="tab-1" defaultContent={createTerminalContent()} />,
        store
      )

      expect(screen.queryByTitle('Add pane')).not.toBeInTheDocument()
    })

    it('hides the floating action button when the store resolved the mobile platform default', async () => {
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
      // Model a mobile boot's local settings exactly as the settings slice
      // would resolve them at mobile width (module-init is desktop-ambient in
      // this file, so the mobile default is injected through the resolution
      // option instead of matchMedia timing).
      store.dispatch(setLocalSettings(
        resolveLocalSettings(undefined, { floatingActionButtonDefault: false }),
      ))

      renderWithStore(
        <PaneLayout tabId="tab-1" defaultContent={createTerminalContent()} />,
        store
      )

      expect(screen.queryByTitle('Add pane')).not.toBeInTheDocument()
    })
```

(The `createStoreWithFab` helper at `:181-188` and its ~18 usages stay exactly as they are: dispatching `true` explicitly is a persistence-clean no-op on desktop and keeps the FAB-driving tests platform-agnostic.)

(c) `test/unit/client/components/SettingsView.panes.test.tsx` — flip the two FAB tests' default expectations. `createTestStore` is UNCHANGED (its zero-arg static resolution keeps the suite's other tests at their current bases); the two FAB tests switch to bare stores built from the real `settingsReducer`, whose module-init boot resolution is exactly the mechanism the app uses (SettingsView reads `s.settings.settings` directly and does not gate on `settings.loaded`, so a bare store renders the panel; `configureStore` and `networkReducer` are already imported at `:4`, `:7`):

```tsx
  it('exposes the floating add-pane button toggle as an accessible switch, checked by default on desktop', () => {
    const store = configureStore({
      reducer: { settings: settingsReducer, network: networkReducer },
    })
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )
    switchSettingsTab('Panes')

    // The bare store uses the real settingsReducer boot resolution; jsdom is
    // desktop-ambient, so the platform default (desktop ON) is what shows.
    const toggle = screen.getByRole('switch', { name: 'Show button to split panes' })
    expect(toggle).toBeChecked()
  })

  it('toggles the floating add-pane button locally without calling /api/settings', async () => {
    const store = configureStore({
      reducer: { settings: settingsReducer, network: networkReducer },
    })
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )
    switchSettingsTab('Panes')

    // This row has a description, so the switch must be selected by its
    // accessible name (the Toggle sets aria-label="Show button to split
    // panes"); do not use the iconsOnTabs test's closest('div') pattern.
    const toggle = screen.getByRole('switch', { name: 'Show button to split panes' })
    expect(toggle).toBeChecked()
    fireEvent.click(toggle)

    // Desktop boots ON, so the first click disables it.
    expect(store.getState().settings.settings.panes.floatingActionButton).toBe(false)

    await act(async () => {
      vi.advanceTimersByTime(600)
    })

    expect(api.patch).not.toHaveBeenCalled()
  })
```

(d) `test/unit/client/store/browserPreferencesPersistence.test.ts` — add two direction pins (copying the `multirowTabs` default-flip precedent at `:161-169`) right after that test:

```ts
  it('persists an explicit floatingActionButton=false on desktop now that the desktop default is true', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({ panes: { floatingActionButton: false } }))
    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const blob = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(blob.settings?.panes?.floatingActionButton).toBe(false)
  })

  it('does not persist floatingActionButton when it equals the boot platform default (no poisoning on unrelated flushes)', () => {
    const store = createStore()

    // An unrelated local change triggers a full diff-vs-defaults flush. The
    // store's boot state carries the desktop platform default (true), and
    // the diff base is the SAME platform default, so the FAB key must stay
    // out of the blob (this is the canary for the mobile-boot poisoning
    // class: a spurious `true` here would show the FAB on a later mobile
    // boot of the same browser).
    store.dispatch(updateSettingsLocal({ theme: 'dark' }))
    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const blob = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(blob.settings?.panes?.floatingActionButton).toBeUndefined()
  })
```

(e) `test/e2e-browser/specs/settings.spec.ts` — replace the whole FAB story test (lines 255-302) with the inverted desktop story plus the new cloud-runnable mobile presence test:

```ts
  test('floating add-pane button is visible by default on desktop, can be disabled, and persists locally', async ({ freshellPage, page, harness, serverInfo }) => {
    // One reload leg plus two settings sessions; the cloud-gated budget
    // follows the settings-persist reload-leg precedent in this file.
    if (isCloudLaneWindowConfigured()) test.setTimeout(120_000)

    // Desktop default boot (1280x720): the FAB renders without touching
    // Settings — the panes.floatingActionButton platform default is ON at
    // desktop width.
    await expect(page.getByRole('button', { name: 'Add pane' })).toBeVisible({ timeout: 10_000 })

    await openSettingsSection(page, 'Panes')
    const fabSwitch = page.getByRole('switch', { name: 'Show button to split panes' })
    await expect(fabSwitch).toHaveAttribute('aria-checked', 'true')

    // Disable: the resolved setting flips, the FAB disappears, and the
    // persisted blob (diff vs the DESKTOP platform default) records the
    // explicit false.
    await fabSwitch.click()
    await expect(fabSwitch).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByRole('button', { name: 'Add pane' })).toHaveCount(0)
    await page.waitForTimeout(PERSIST_DEBOUNCE_WAIT_MS)
    expect((await harness.getSettings()).panes.floatingActionButton).toBe(false)
    const blob = await page.evaluate(() => localStorage.getItem('freshell.browser-preferences.v1'))
    expect(JSON.parse(blob ?? '{}').settings?.panes?.floatingActionButton).toBe(false)

    // The explicit disable survives reload — the saved false wins over the
    // platform default on the next desktop boot.
    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await harness.waitForHarness()
    await harness.waitForConnection(undefined, {
      selfHealReload: isCloudLaneWindowConfigured(),
    })
    expect((await harness.getSettings()).panes.floatingActionButton).toBe(false)
    await expect(page.getByRole('button', { name: 'Add pane' })).toHaveCount(0)

    // Re-enable: true IS the desktop default, so the diff drops the key from
    // the blob and the FAB returns.
    await openSettingsSection(page, 'Panes')
    await fabSwitch.click()
    await expect(fabSwitch).toHaveAttribute('aria-checked', 'true')
    await page.waitForTimeout(PERSIST_DEBOUNCE_WAIT_MS)
    const blobOn = await page.evaluate(() => localStorage.getItem('freshell.browser-preferences.v1'))
    expect(JSON.parse(blobOn ?? '{}').settings?.panes?.floatingActionButton).toBeUndefined()
    await expect(page.getByRole('button', { name: 'Add pane' })).toBeVisible()
  })

  test('floating add-pane button is hidden by default on a mobile-width viewport', async ({ page, serverInfo, harness }) => {
    // Cloud-runnable presence-only pin for the mobile half of the default.
    // mobile-viewport.spec.ts is cloud-skipped as environment-sensitive
    // (CLOUD_SKIP_SPECS), but this test asserts presence only — the same
    // boot shape as screenshot-baselines.spec.ts's mobile layout capture,
    // which runs on the cloud lane. The boot chain here has no freshellPage
    // fixture slot, so it needs the cloud-gated body budget.
    if (isCloudLaneWindowConfigured()) test.setTimeout(120_000)

    // Boot a fresh page at phone width BEFORE goto so the platform default
    // resolves mobile at boot (sticky per boot thereafter). Mobile = viewport
    // width (max-width: 767px), not device class.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await harness.waitForHarness()
    await harness.waitForConnection(undefined, {
      selfHealReload: isCloudLaneWindowConfigured(),
    })

    // Non-vacuity: the pane area really mounts (the first tab's pane-picker
    // pane), and the mobile platform default keeps the FAB out of it. The
    // desktop story above proves the same boot chain shows the FAB at
    // desktop width, so this absence is the mobile default, not a missing
    // pane area.
    await expect(page.locator('[data-pane-root]')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('button', { name: 'Add pane' })).toHaveCount(0)
  })
```

(f) `test/e2e-browser/specs/mobile-viewport.spec.ts` — in `fresh-agent composer and region are visible on mobile viewport`, replace the comment block and dispatch at `:186-195` with a default-hidden pin followed by the same enable dispatch (the Send-vs-FAB overlap contract still needs a VISIBLE FAB, and the mobile default alone would not provide one):

```ts
    // The floating add-pane button defaults OFF at mobile viewport width
    // (panes.floatingActionButton platform default). Pin that default
    // first, then enable the setting through the test harness so this
    // mobile layout contract keeps checking the Send button against a
    // VISIBLE add-pane button.
    await expect(page.getByRole('button', { name: /^add pane$/i })).toHaveCount(0)
    await page.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'settings/updateSettingsLocal',
        payload: { panes: { floatingActionButton: true } },
      })
    })
```

- [ ] **Step 2: Run the tests and verify the intended failures**

Run: `FRESHELL_VITEST_BACKEND=cloud FRESHELL_E2E_BACKEND=cloud FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com npm run test:vitest -- run test/unit/client/store/settingsSlice.test.ts test/unit/client/components/panes/PaneLayout.test.tsx test/unit/client/components/SettingsView.panes.test.tsx test/unit/client/store/browserPreferencesPersistence.test.ts`

Expected: FAIL, for the intended reasons (missing platform-default behavior, not setup accidents):
- `settingsSlice.test.ts`: `resolves the ... platform default at boot: desktop true, mobile false` fails at the desktop expectation (the boot still resolves the static `false`); the mobile expectation passes before the flip (static `false` equals the mobile default — it is the companion pin). `keeps the boot-time platform default ... session` fails (the boot value is `false`, so it stays `false` instead of `true`). `hydrates a saved explicit false ...` passes before the flip (explicit patches already win) — it is the persistence-of-choice guard.
- `PaneLayout.test.tsx`: `shows the floating action button by default on desktop` fails (`queryByTitle`-style absence today); `hides ... explicitly disabled` and `hides ... mobile platform default` pass before the flip (everything hides today) — companion pins whose discriminating power arrives with the implementation.
- `SettingsView.panes.test.tsx`: `checked by default on desktop` fails because the bare reducer-booted store still resolves the static `false` (the switch renders unchecked); the click-direction test fails at the first `toBeChecked()` and at `toBe(false)` (the first click from the static-off base produces `true`).
- `browserPreferencesPersistence.test.ts`: `persists an explicit floatingActionButton=false on desktop now that the desktop default is true` fails (the flush diffs `false` against the static `false` and records nothing); `does not persist floatingActionButton when it equals the boot platform default` passes before the flip (boot is static `false`, diff base static `false` — it becomes discriminating only after the flip).

Run: `FRESHELL_VITEST_BACKEND=cloud FRESHELL_E2E_BACKEND=cloud FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com npm run test:e2e:local -- --project=chromium --grep=floating`

Expected: FAIL — the reworked desktop story fails at its first assertion (`Add pane` expected visible; the current default-off build hides it). The new mobile presence test passes before the flip (the FAB is hidden at every width today) — its non-vacuity comes from the desktop story in the same spec and it becomes the mobile-half pin the moment the flip lands.

- [ ] **Step 3: Add the minimal production implementation (and the consequence re-pins)**

(a) `src/store/settingsSlice.ts` — imports and the platform default. Add `type LocalSettingsPlatformDefaults` to the existing `@shared/settings` import block (lines 3-17), add the mobile-device import after line 18, and insert the resolver + const after `resolveDefaultLoggingDebug` (`:22-24`):

```ts
import { isMobileDevice } from '@/lib/mobile-device'
```

```ts
// The floating add/split button's default depends on the viewport class at
// boot: desktop (>=768px) shows it, mobile width (<768px) hides it. This is
// the repo's canonical mobile test — viewport width, not device class (a
// desktop window narrowed below 768px counts as mobile). The default is
// resolved ONCE per page load and is sticky for the session: resizing across
// the breakpoint does not re-resolve until the next reload (the same
// boot-time shape as resolveDefaultLoggingDebug). Every client path that can
// resolve or diff local settings WITHOUT an explicit saved value threads this
// same const, so resolution and the browser-preferences write-diff share one
// base within a boot. The slice reducers do NOT need it: after boot the
// resolved localSettings always carry a concrete boolean that survives every
// seed/merge round-trip (PANES_LOCAL_KEYS whitelist + pickKeys own-key copy +
// mergeLocalSettings panes merge).
export function resolveDefaultFloatingActionButton(isMobile: boolean): boolean {
  return !isMobile
}

export const localSettingsPlatformDefaults: LocalSettingsPlatformDefaults = {
  floatingActionButtonDefault: resolveDefaultFloatingActionButton(isMobileDevice()),
}
```

Thread the boot path (`:71-73`):

```ts
function loadInitialLocalSettings(): LocalSettings {
  return resolveBrowserPreferenceSettings(loadBrowserPreferencesRecord(), localSettingsPlatformDefaults)
}
```

(b) `src/lib/browser-preferences.ts` — add `type LocalSettingsPlatformDefaults` to the `@shared/settings` import (lines 1-7) and thread the passthrough (`:212-214`):

```ts
export function resolveBrowserPreferenceSettings(
  record?: BrowserPreferencesRecord,
  options: LocalSettingsPlatformDefaults = {},
): LocalSettings {
  return resolveLocalSettings(record?.settings, options)
}
```

(c) `src/store/crossTabSync.ts` — extend the settingsSlice import (line 7) and thread both hydrate resolutions (`:282-284`); each window applies its own boot-time platform default, so hydrating a blob that omits the FAB key keeps THIS window's default coherent:

```ts
import { setLocalSettings, localSettingsPlatformDefaults } from './settingsSlice'
```

```ts
  const nextSettings = pendingWriteState.settingsPatch
    ? resolveLocalSettings(mergedSettingsPatch, localSettingsPlatformDefaults)
    : resolveBrowserPreferenceSettings(parsed, localSettingsPlatformDefaults)
```

(d) `src/store/browserPreferencesPersistence.ts` — import the platform defaults (value import next to the existing type-only import at line 7) and thread them into BOTH internal diff calls so the write-diff base matches the boot resolution base:

```ts
import { localSettingsPlatformDefaults } from './settingsSlice'
import type { SettingsState } from './settingsSlice'
```

Inside `buildBrowserPreferencesRecord` (line 169):

```ts
  const settingsPatch = buildLocalSettingsPatch(state.settings.localSettings, localSettingsPlatformDefaults)
```

Inside the middleware's `settings/setLocalSettings` branch (line 283):

```ts
        const nextPatch = buildLocalSettingsPatch(action.payload as LocalSettings, localSettingsPlatformDefaults)
```

(There is no import cycle: `settingsSlice` does not import `browserPreferencesPersistence`.)

(e) `src/App.tsx` — add `localSettingsPlatformDefaults` to the settingsSlice import (line 5) and thread the legacy-seed bootstrap path so the one-time config.json migration neither poisons the blob nor clobbers the platform default:

```ts
import { setLocalSettings, setServerConfigDir, setServerSettings, localSettingsPlatformDefaults } from '@/store/settingsSlice'
```

Line 674:

```ts
              const currentLocalSettingsPatch = buildLocalSettingsPatch(appStore.getState().settings.localSettings, localSettingsPlatformDefaults)
```

Line 692:

```ts
                dispatch(setLocalSettings(resolveBrowserPreferenceSettings(nextPreferences, localSettingsPlatformDefaults)))
```

(f) `src/components/panes/PaneLayout.tsx:63` — the `?? false` fallback stays (pre-load/absent means hidden, which is safe on BOTH platforms: it equals the mobile default and a desktop pane hiding until load is the conservative choice); re-document it:

```ts
  // Post-load the resolved settings always carry a concrete boolean (the
  // store resolves the platform default at boot: desktop true / mobile
  // false); `?? false` only covers the pre-load window, where "hidden" is
  // the safe fallback on both platforms.
  const showFloatingActionButton = settings.panes?.floatingActionButton ?? false
```

(g) Consequence re-pins (tests whose expectations legitimately change with the flip):

- `test/unit/client/store/settingsSlice.test.ts:35-42` — the initial-state composite now carries the desktop platform default; the expectation gains the panes override:

```ts
    expect(state.settings).toEqual({
      ...defaultSettings,
      panes: {
        ...defaultSettings.panes,
        // jsdom boots desktop-ambient: the platform default is ON.
        floatingActionButton: true,
      },
      theme: 'dark',
      terminal: {
        ...defaultSettings.terminal,
        fontSize: 18,
      },
    })
```

- `test/unit/client/store/settingsSlice.test.ts:83-94` — the `setServerSettings` composite pin gains the same panes override after `...defaultSettings`:

```ts
    expect(state.settings).toEqual({
      ...defaultSettings,
      panes: {
        ...defaultSettings.panes,
        // jsdom boots desktop-ambient: the platform default is ON.
        floatingActionButton: true,
      },
      defaultCwd: '/workspace',
      terminal: {
        ...defaultSettings.terminal,
        scrollback: 12000,
      },
      freshAgent: {
        ...defaultSettings.freshAgent,
        defaultPlugins: [],
      },
    })
```

- `test/unit/client/store/state-edge-cases.test.ts:846-849` — same one-line panes override in the `handles setSettings with completely different structure` expectation:

```ts
          panes: {
            ...defaultSettings.panes,
            // jsdom boots desktop-ambient: the platform default is ON.
            floatingActionButton: true,
            defaultNewPane: 'shell',
          },
```

- `test/unit/client/store/browserPreferencesPersistence.test.ts:42` — the payload must carry the desktop default the way the boot path would (a zero-arg resolution now represents an *explicit* static `false`, which the platform-aware diff would rightly persist as an unrelated key):

```ts
    store.dispatch(setLocalSettings(resolveLocalSettings({
      theme: 'dark',
      terminal: {
        fontSize: 18,
      },
    }, { floatingActionButtonDefault: true })))
```

- `test/unit/client/store/browserPreferencesPersistence.test.ts:99` — same for the reset-to-defaults leg (jsdom desktop ⇒ "defaults" include the FAB):

```ts
    store.dispatch(setLocalSettings(resolveLocalSettings(undefined, { floatingActionButtonDefault: true })))
```

  Both exact-blob expectations (`:54-64`, `:103-105`) stay byte-for-byte unchanged — the FAB key must stay OUT of those blobs, which is precisely the no-poisoning property.

- `test/integration/client/editor-pane.test.tsx:200-204` — comment only (the explicit enable stays: it is a persistence-clean no-op on desktop and keeps the flows platform-agnostic):

```ts
  // The floating add-pane button's platform default is ON at desktop width
  // and OFF at mobile width (panes.floatingActionButton). Enable it
  // explicitly so this file's FAB-driven pane-creation flows keep
  // exercising their real input path regardless of the ambient default.
```

- `test/e2e-browser/helpers/pane-picker.ts:15-18` — comment only (the dispatch stays; it is required for mobile-width boots and a no-op on desktop):

```ts
    // The floating add-pane button is default-ON at desktop width and
    // default-OFF at mobile width (panes.floatingActionButton). Enable it
    // through the e2e test harness before falling back to clicking it, so
    // this branch works at any boot width and on pages with no visible
    // terminal yet.
```

- `test/e2e-browser/specs/pane-picker.spec.ts:42-44` — comment only, same story:

```ts
    // Swap the terminal pane for an editor pane so no .xterm is visible and
    // openPanePicker must take its add-pane-button fallback branch (the
    // helper enables the FAB through the test harness so the branch works
    // at any boot width).
```

- [ ] **Step 4: Run the focused tests**

Run: `FRESHELL_VITEST_BACKEND=cloud FRESHELL_E2E_BACKEND=cloud FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com npm run test:vitest -- run test/unit/client/store/settingsSlice.test.ts test/unit/client/store/state-edge-cases.test.ts test/unit/client/store/browserPreferencesPersistence.test.ts test/unit/client/components/panes/PaneLayout.test.tsx test/unit/client/components/SettingsView.panes.test.tsx test/integration/client/editor-pane.test.tsx`

Expected: PASS — all new tests, all consequence re-pins, and every untouched neighbor in those files.

Run: `FRESHELL_VITEST_BACKEND=cloud FRESHELL_E2E_BACKEND=cloud FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com npm run test:e2e:local -- --project=chromium --grep=floating`

Expected: PASS — 2 tests (the reworked desktop story and the mobile presence test, both in `settings.spec.ts`).

Run: `FRESHELL_VITEST_BACKEND=cloud FRESHELL_E2E_BACKEND=cloud FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/mobile-viewport.spec.ts test/e2e-browser/specs/pane-picker.spec.ts`

Expected: PASS — all 7 mobile-viewport tests (including the new default-hidden line inside the composer-overlap test) and all 3 pane-picker tests. (`mobile-viewport.spec.ts` is local-lane only — `CLOUD_SKIP_SPECS` at `playwright.cloud.config.ts:48` — so its pass/fail must be demonstrated on the local lane where it actually runs.)

- [ ] **Step 5: Refactor while green**

The Task 1 `panesDefaults` computation now appears in two places (`resolveLocalSettings` and `buildLocalSettingsPatch`). Extract a tiny shared helper in `shared/settings.ts` and use it from both call sites:

```ts
function panesDefaultsWith(options: LocalSettingsPlatformDefaults): LocalSettings['panes'] {
  return options.floatingActionButtonDefault === undefined
    ? defaultLocalSettings.panes
    : { ...defaultLocalSettings.panes, floatingActionButton: options.floatingActionButtonDefault }
}
```

(`resolveLocalSettings` computes `const panesDefaults = panesDefaultsWith(options)` and `buildLocalSettingsPatch` does the same; the diff line becomes `assignChangedScalar(panes, localSettings.panes, panesDefaultsWith(options), 'floatingActionButton')` — or keep the local `const` and pass it, matching the file's style.) Then re-run the Task 1 + Task 3 focused suites:

Run: `FRESHELL_VITEST_BACKEND=cloud FRESHELL_E2E_BACKEND=cloud FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com npm run test:vitest -- run test/unit/shared/settings.test.ts test/unit/client/store/browserPreferencesPersistence.test.ts`

Run: `npm run typecheck:client && npm run lint`

Expected: PASS for both — pure behavior-preserving extraction.

- [ ] **Step 6: Run impacted-test verification**

The flip changes what every store built from the real `settingsReducer` resolves at boot, and what every real-`PaneLayout` render shows. Impacted set per the blast-radius inventory:

Run: `FRESHELL_VITEST_BACKEND=cloud FRESHELL_E2E_BACKEND=cloud FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com npm run test:vitest -- run test/unit/shared test/unit/client/store test/unit/client/components/panes test/unit/client/components/SettingsView.panes.test.tsx test/integration/client test/e2e/refresh-context-menu-flow.test.tsx test/e2e/pane-context-menu-stability.test.tsx test/e2e/terminal-url-context-menu.test.tsx test/e2e/terminal-font-settings.test.tsx`

Run: `npm run typecheck:client && npm run lint`

Expected: PASS for both. Green-by-construction arguments for the untouched groups (cite in the task record): `crossTabSync.test.ts` asserts key-scoped settings and exact blobs whose FAB entries stay absent under the platform-coherent diff; `FloatingActionButton.test.tsx` is props-only; the three context-menu jsdom flows mock `FloatingActionButton` to `null` and preload `defaultSettings` (static composite); App-level jsdom suites mock `TabContent` so no real `PaneLayout` mounts; `editor-pane.test.tsx` dispatches the enable explicitly; suites that preload `defaultSettings` keep the FAB out of unrelated assertions; the shared stream-deck and settings per-key describes use zero-arg calls (static base, unchanged).

E2e lanes (the cloud lane is the gate lane; a spec in `CLOUD_SKIP_SPECS` or a filter matching nothing is not coverage):

Run: `FRESHELL_VITEST_BACKEND=cloud FRESHELL_E2E_BACKEND=cloud FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com npm run test:e2e:cloud -- --grep=floating`

Expected: PASS — 2 passed (both settings.spec.ts tests; the spec is not in `CLOUD_SKIP_SPECS`).

Cloud-viability fallback (pre-authorized; load-bearing ledger LB-1): the mobile presence test is cloud-viable by inspection evidence — a same-shape 390×844 cold boot already runs green on the cloud lane in `screenshot-baselines.spec.ts`'s `mobile layout` test under a stricter 5%-pixel comparison and a tighter 60s budget, and `waitForConnection` in-body is cloud-proven by the current settings.spec.ts reload legs. If the cloud run fails ONLY in the mobile presence test while the local run (Step 4) is green: do NOT debug cloud rendering and do NOT add any cloud-skip entry — the failure is an environment sensitivity, so delete the cloud presence test and keep the already-planned local-lane mobile pin (the default-hidden line in mobile-viewport.spec.ts's composer-overlap test), then record the coverage caveat: the cloud lane covers the desktop half of the platform default; the mobile half stays unit-pinned plus local-lane e2e-pinned. A local-lane failure, by contrast, is a real bug: fix the test/app under TDD.

Run: `FRESHELL_VITEST_BACKEND=cloud FRESHELL_E2E_BACKEND=cloud FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com npm run test:e2e:cloud -- --grep=add-pane-button`

Expected: PASS — 1 passed (the pane-picker fallback test; the helper's dispatch is now a desktop no-op and the FAB is default-visible, so the fallback click succeeds).

Run: `FRESHELL_VITEST_BACKEND=cloud FRESHELL_E2E_BACKEND=cloud FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/screenshot-baselines.spec.ts`

Expected: PASS on tolerance — the FAB adds roughly 0.3–0.5% changed pixels to the four desktop frames (`default-layout.png`, `settings-view.png`, `multiple-tabs.png`, `sidebar-collapsed.png`), well inside `maxDiffPixelRatio: 0.05` (the estimate is unmeasured arithmetic; the FAB is absolutely positioned, so non-local diffs are not expected); `auth-modal.png` shows no tab view and `mobile-layout.png` boots at 390px (mobile default ⇒ still no FAB). Record the per-test outcome. Either tolerance outcome is handled, never debugged (load-bearing ledger LB-2): if any desktop frame exceeds tolerance, pull Task 4's regeneration forward to this step immediately (regenerate via `test:e2e:update-snapshots` + the Task 4 visual checks) instead of investigating the app — the FAB addition is the expected diff. Tolerance-green is NOT sufficient either: the committed baselines must depict the default experience — Task 4 regenerates them immediately regardless.

- [ ] **Step 7: Commit the task**

```bash
git add shared/settings.ts src/store/settingsSlice.ts src/lib/browser-preferences.ts src/store/crossTabSync.ts src/store/browserPreferencesPersistence.ts src/App.tsx src/components/panes/PaneLayout.tsx test/unit/client/store/settingsSlice.test.ts test/unit/client/store/state-edge-cases.test.ts test/unit/client/store/browserPreferencesPersistence.test.ts test/unit/client/components/panes/PaneLayout.test.tsx test/unit/client/components/SettingsView.panes.test.tsx test/integration/client/editor-pane.test.tsx test/e2e-browser/specs/settings.spec.ts test/e2e-browser/specs/mobile-viewport.spec.ts test/e2e-browser/specs/pane-picker.spec.ts test/e2e-browser/helpers/pane-picker.ts
git commit -m "feat(settings): platform default for split-panes button (desktop on, mobile off)"
```

---

### Task 4: Regenerate the committed screenshot baselines to depict the default-on desktop experience

The four desktop PNG baselines now render a visible FAB at every default boot. Even where the 5% tolerance absorbs the diff (expected, per Task 3 Step 6), the committed artifacts must depict the default experience. The repo's exact baseline-regeneration mechanism is the first-class npm script `test:e2e:update-snapshots` (`package.json:83`: `playwright test --config test/e2e-browser/playwright.config.ts --update-snapshots`) — a raw Playwright invocation that always runs locally (it never dispatches through the cloud/local backend wrapper; the pinned env vars are inert for it and are kept only for command uniformity). The PNGs are committed artifacts under `test/e2e-browser/specs/screenshot-baselines.spec.ts-snapshots/` (chromium-linux platform suffix).

**Files:**
- Modify: `test/e2e-browser/specs/screenshot-baselines.spec.ts-snapshots/default-layout-chromium-linux.png`
- Modify: `test/e2e-browser/specs/screenshot-baselines.spec.ts-snapshots/settings-view-chromium-linux.png`
- Modify: `test/e2e-browser/specs/screenshot-baselines.spec.ts-snapshots/multiple-tabs-chromium-linux.png`
- Modify: `test/e2e-browser/specs/screenshot-baselines.spec.ts-snapshots/sidebar-collapsed-chromium-linux.png`
- (Any byte-identical re-capture of `auth-modal.png` / `mobile-layout.png` may also be committed — both depict no FAB by design: the auth modal shows no tab view, and the mobile-layout capture boots at 390px where the mobile default keeps the FAB hidden.)

**Interfaces:**
- Consumes: Task 3's landed default (desktop boots render the FAB); the `test:e2e:update-snapshots` script; the spec's `maxDiffPixelRatio: 0.05` comparisons.
- Produces: committed baselines that depict the new default desktop experience, green on both the local and cloud e2e lanes.

- [ ] **Step 1: Record the current (stale) comparison outcome**

Run: `FRESHELL_VITEST_BACKEND=cloud FRESHELL_E2E_BACKEND=cloud FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/screenshot-baselines.spec.ts`

Expected: PASS on tolerance or FAIL — either outcome is acceptable input to this task; record which of the four desktop baselines diffed and by how much (from the Playwright report). The decision to regenerate does not depend on the outcome: the committed PNGs must show the FAB because they are the repo's visual record of the DEFAULT experience, and a tolerance-passing stale baseline would silently stop protecting the desktop default's visual contract.

- [ ] **Step 2: Regenerate the baselines**

Run: `FRESHELL_VITEST_BACKEND=cloud FRESHELL_E2E_BACKEND=cloud FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com npm run test:e2e:update-snapshots -- --project=chromium test/e2e-browser/specs/screenshot-baselines.spec.ts`

Expected: all six baseline PNGs re-captured; the four desktop PNGs now include the FAB. Verify with `git status --short test/e2e-browser/specs/screenshot-baselines.spec.ts-snapshots/` — expect the four desktop PNGs modified; `auth-modal.png` and `mobile-layout.png` either unchanged or byte-equivalent re-captures (they depict no FAB before and after). If `git status` shows an unexpected fifth/sixth desktop-looking change, inspect the PNGs before committing — do not commit a regression you cannot explain.

- [ ] **Step 3: Verify green on the local lane**

Run: `FRESHELL_VITEST_BACKEND=cloud FRESHELL_E2E_BACKEND=cloud FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/screenshot-baselines.spec.ts`

Expected: PASS — all 6 tests against the regenerated baselines.

- [ ] **Step 4: Verify green on the cloud gate lane**

`screenshot-baselines.spec.ts` is not in `CLOUD_SKIP_SPECS` and none of its titles match `CLOUD_SKIP_TITLES` (`playwright.cloud.config.ts:72-75`), so it runs on the cloud gate lane and must end green there (font rendering differences are covered by the 5% tolerance, exactly as before the flip — the FAB is a shape/contrast feature, not fine text).

Run: `FRESHELL_VITEST_BACKEND=cloud FRESHELL_E2E_BACKEND=cloud FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com npm run test:e2e:cloud -- --grep="Screenshot Baselines"`

Expected: PASS — all 6 tests in the describe match the grep and pass on the cloud lane against the regenerated committed PNGs.

- [ ] **Step 5: Refactor while green**

No refactor needed: this task only re-captures committed binary artifacts; no source changes.

- [ ] **Step 6: Run impacted-test verification**

The impacted set is the baseline spec itself on both lanes (Steps 3 and 4) plus the static-asset sanity check:

Run: `git diff --stat -- test/e2e-browser/specs/screenshot-baselines.spec.ts-snapshots/`

Expected: exactly the expected PNG set changed (see Step 2). No other test consumes these PNGs; the editor-pane baseline (`editor-pane.spec.ts:113`) is a separate artifact untouched by the FAB (editor-pane e2e boots desktop, and its capture is scoped to the editor pane's testid container, which the FAB — a sibling of the pane area — does not overlap; verify it stays green in the full-lane run at the end of the run, not in this task).

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/screenshot-baselines.spec.ts-snapshots
git commit -m "test(e2e): regenerate screenshot baselines for default-on split-panes button"
```

---

### Task 5: Add the split-panes button to the docs/index.html static mock (default desktop experience)

Decision (explicit, per AGENTS.md's rule that the mock reflects the default experience): ADD a static, clearly-nonfunctional FAB to the mock's content area. Rationale: the mock never depicted the FAB even when it was unconditional pre-prior-run (a pre-existing gap that default-off accidentally made accurate); the new DEFAULT desktop experience shows the FAB, and the mock is the repo's static depiction of that default experience, so the gap re-opens with the flip and this task closes it. The addition is pure static HTML + CSS with no JS behavior (the mock's buttons are uniformly inert; this one gets no exception). A separate mobile variant is not needed — the mock has none, and the FAB is desktop-default.

**Files:**
- Modify: `docs/index.html:235` (CSS after the `.content { ... }` rule)
- Modify: `docs/index.html:712-713` (HTML between the tabbar's closing `</div>` and the `<!-- Welcome -->` comment)

**Interfaces:**
- Consumes: the mock's existing CSS variable conventions (`hsl(var(--foreground) / .7)` alpha-modifier style used throughout), its lucide icon mechanism (`<i data-lucide="plus" class="icon">` — the same icon the tab-add control uses at `:711`), and the real FAB's placement contract (`absolute bottom-12 right-4 z-50`, 48px circle — `src/components/panes/FloatingActionButton.tsx:19,59`).
- Produces: a static FAB element in the mock, matching the real control's placement and the default desktop experience.

- [ ] **Step 1: Write the failing check**

The mock currently lacks any FAB depiction — run and confirm the gap:

```bash
rg -n 'class="fab"|Add pane' docs/index.html
```

Expected: no `class="fab"` match (the only "Add pane" text is the unrelated fake session title at `docs/index.html:668`, "Add pane resize shortcuts"). That absence is the failure this task fixes: after Task 3 the real default desktop experience includes the FAB and the mock does not depict it.

- [ ] **Step 2: Confirm the intended failure**

The check in Step 1 is the red: the static mock of the default experience is missing a default-experience element. (This is a documentation-asset change — no test harness covers `docs/index.html`, and fabricating one is not warranted; the verification below is static and visual.)

- [ ] **Step 3: Add the minimal implementation**

(a) CSS — insert immediately after the `.content { flex: 1; min-width: 0; display: flex; flex-direction: column; position: relative; }` rule (`docs/index.html:235`):

```css
/* Floating add/split pane button — part of the default desktop experience
   (panes.floatingActionButton platform default; static mock, no JS behavior). */
.fab {
  position: absolute; bottom: 48px; right: 16px; z-index: 50;
  width: 48px; height: 48px; border-radius: 9999px;
  background: hsl(var(--foreground) / .7); color: hsl(var(--background));
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 10px 15px -3px rgb(0 0 0 / .35);
  cursor: pointer; transition: background .15s;
}
.fab:hover { background: hsl(var(--foreground) / .85); }
```

(b) HTML — insert between the tabbar's closing `</div>` (line 712) and `<!-- Welcome -->` (line 713):

```html
      <!-- Floating add/split pane button (default-on at desktop width; nonfunctional mock) -->
      <button type="button" class="fab" title="Add pane"><i data-lucide="plus" class="icon"></i></button>
```

- [ ] **Step 4: Run the focused check**

```bash
rg -n 'class="fab"|title="Add pane"' docs/index.html
```

Expected: matches for the new `.fab` CSS rule (twice: base + hover) and the new `title="Add pane"` button — and no other new "Add pane" occurrences. Optionally open `docs/index.html` in a browser and visually confirm the button renders bottom-right of the pane area on the welcome panel, styled as a translucent circle matching the mock's theme.

- [ ] **Step 5: Refactor while green**

No refactor needed: one static element plus one CSS block following the mock's existing conventions.

- [ ] **Step 6: Run impacted-test verification**

Nothing imports or tests `docs/index.html` (verified: no test references it), and the mock is not served by the app. The impacted set is the file itself:

Run: `git diff --stat -- docs/index.html`

Expected: exactly the two insertion sites changed (CSS block + one button element).

Run: `npm run typecheck:client && npm run lint`

Expected: PASS (no client/lint surface changed by this task; run to close the loop).

- [ ] **Step 7: Commit the task**

```bash
git add docs/index.html
git commit -m "docs: depict the default-on split-panes button in the static mock"
```

---

## Verification summary (user-visible outcome)

- **Clear label (explicit constraint):** the Settings → Panes switch is named `Show button to split panes` (label, description aligned, aria-label identical to the visible label — label-in-name), proven by unit tests (Task 2) and the e2e switch interaction (Tasks 2-3).
- **Default true on desktop (explicit constraint):** boot-resolution unit pin (settingsSlice.test.ts, desktop-ambient fresh import), consumption unit pin (PaneLayout shows-by-default), SettingsView checked-by-default pin, and e2e evidence on the cloud gate lane (visible at default boot in `settings.spec.ts`).
- **Default false on mobile (explicit constraint):** boot-resolution unit pin (fresh import under `setMobileForTest(true)`), consumption unit pin (PaneLayout mobile-resolved store), local-lane e2e pin (mobile-viewport.spec.ts default-hidden line), and a cloud-runnable presence-only mobile-width boot test in `settings.spec.ts` (non-vacuous via the pane-root mount plus the desktop story in the same spec). Mobile means viewport width ≤767px — a narrowed desktop window counts as mobile, matching every existing mobile behavior in the repo.
- **Persistence correctness:** the write-diff uses the same boot-time platform default as resolution (unit canaries: exact-blob tests stay FAB-free on unrelated flushes; direction pins both ways; old default-off-era explicit `true` opt-ins still resolve true), and the e2e blob legs show explicit `false` persisting across reload and the key dropping on re-enable.
- **Sticky per boot:** pinned in settingsSlice.test.ts (a mid-session matchMedia flip plus an unrelated settings update keeps the boot answer).
- **Nothing regressed:** screenshot baselines regenerated and green on local + cloud lanes; the e2e helper fallback, mobile overlap contract, editor-pane integration flows, and every unaffected asset keep working under the new default (enumerated in Task 3 Step 6 and the blast-radius report).
