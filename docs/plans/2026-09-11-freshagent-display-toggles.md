# Fresh-Agent Display Defaults & Toggles Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Fresh-agent panes show thinking blocks and tool blocks by default, with user-facing toggles to enable/disable each (both default on).

### Explicit constraints
- Run this work with the-usual.
- Repo rules: work in a worktree; TDD with unit and e2e coverage; never open a PR without explicit user approval.

### Accepted tradeoffs and residuals
- None stated.

**Goal:** Fresh-agent panes render thinking blocks and expanded tool-block activity strips by default, and Settings → Coding Agents exposes a "Fresh agent display" group with a Show thinking toggle and a Show tools toggle (both on by default, browser-local).

**Architecture:** The display plumbing already exists end-to-end (transcript item kinds, `paneContent.X ?? globalX` resolution, diff-vs-defaults localStorage persistence) — only the defaults and the settings UI are missing. Flip the two browser-local defaults in `defaultLocalSettings.freshAgent` (`shared/settings.ts`) plus the two matching selector fallbacks in `FreshAgentView`, revive the toggle UI that commit `b29f7133a` removed (as a second `SettingsSection` inside `CodingAgentsSettings`, wired through `applyLocalSetting` exactly like "Sound on completion" in `PanesSettings`), re-pin the tests that assert the old defaults, and adapt the e2e describes that assume collapsed/hidden-by-default rendering. No Node-server or Rust changes: display settings are client-local, stripped from every server settings surface, and the Rust server never resolves them. Diff-based persistence (`assignChangedScalar`) makes the flip reach existing browsers with no migration: under the old defaults an explicit `false` was never persistable, so no stored record can pin the off state.

**Tech Stack:** React 18 + Redux Toolkit (client), Zod-validated shared settings contract (`shared/settings.ts`), Vitest (unit/integration), Playwright (e2e, local + Cloud Run backends).

## Global Constraints

- Both new toggles are **browser-local settings**: write via `applyLocalSetting({ freshAgent: { ... } })` only — never a server PATCH. Pinned by `test/unit/shared/settings.test.ts:258-271` (`freshAgent.showThinking/showTools/showTimecodes` are rejected by the server patch schema).
- `showTimecodes` stays `false` and gets **no toggle** — the request covers thinking + tools only.
- Do **not** flip the `FreshAgentTranscript` component prop defaults (`showThinking = true`, `showTools = false`, `src/components/fresh-agent/FreshAgentTranscript.tsx:944-945`). They are inert in production (`FreshAgentView` always passes effective values) and flipping `showTools` there cascades ~15–20 unit-test breaks for no user-visible gain.
- Every toggle carries an explicit `aria-label` (repo a11y rules; `Toggle`'s fallback label is generic).
- E2e assertions must live in cloud-runnable specs: `fresh-agent.spec.ts` and `settings.spec.ts` are NOT in `CLOUD_SKIP_SPECS` (`test/e2e-browser/playwright.cloud.config.ts:30-77`); `fresh-agent-centralization-smoke.spec.ts` is excluded and does not count as coverage.
- Focused unit runs use the repo-owned passthrough: `npm run test:vitest -- run <paths>`. Focused e2e runs use `scripts/e2e-cloud.sh run --local --project=chromium <spec>` (and `--cloud` variants must export `GCLOUD_ROBOT_HOME=$HOME/.codex/skills/gcloud-robot`, required for the cloud identity ladder).
- Baseline exception (pre-existing, reproduced + attributed, see run-state baseline ledger): `test/e2e/agent-cli-flow.test.ts > cli e2e flow > renames the active tab when only a new name is provided` is flaky under 4-shard cloud load at base_ref `2e05dd9e2` — it passes focused at the same commit and does not overlap this run's change surface. If it fails in this branch's gates, cite the ledger; do not "fix" it inside this run.
- Commits use the repo's conventional style (`feat(...)`, `test(...)`, `docs(...)`) and the repo-provided git identity; never commit to `main`.

---

### Task 1: Flip the shared fresh-agent display defaults and re-pin the settings/persistence unit tests

**Files:**
- Modify: `shared/settings.ts:920-924` (`defaultLocalSettings.freshAgent`)
- Test: `test/unit/shared/settings.test.ts:673-690`
- Test: `test/unit/client/store/browserPreferencesPersistence.test.ts:192-291`

**Interfaces:**
- Consumes: `LocalSettings['freshAgent'] = { showThinking: boolean; showTools: boolean; showTimecodes: boolean }` (`shared/settings.ts:229-233`), the diff-vs-defaults persistence (`assignChangedScalar`, `src/store/browserPreferencesPersistence.ts:76-85`, freshAgent block `:132-138`).
- Produces: new canonical defaults `showThinking: true, showTools: true, showTimecodes: false` — every later task builds on these defaults resolving through `resolveLocalSettings`/`composeResolvedSettings`.

- [ ] **Step 1: Write the failing behavioral test**

Update the two default pins in `test/unit/shared/settings.test.ts` (describe `deprecated fresh-agent font scale is dropped`) to the new defaults:

```ts
    it('resolves the default fresh-agent settings without a fontScale key', () => {
      expect(resolveLocalSettings(undefined).freshAgent).toEqual({
        showThinking: true,
        showTools: true,
        showTimecodes: false,
      })
    })

    it('drops a canonical freshAgent.fontScale regardless of value', () => {
      for (const value of [1.75, 5, 'big']) {
        expect(resolveLocalSettings({ freshAgent: { fontScale: value } } as never).freshAgent).toEqual({
          showThinking: true,
          showTools: true,
          showTimecodes: false,
        })
      }
    })
```

In `test/unit/client/store/browserPreferencesPersistence.test.ts`, rewrite the four default-dependent tests to pin the NEW diff-vs-default semantics (opt-outs persist; values equal to the new defaults do not), and fix the fontScale-rehydration test so it keeps proving a real persisted record (dispatch a non-default value):

```ts
  it('persists a freshAgent opt-out to browser preferences', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({
      freshAgent: { showThinking: false },
    }))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const bp = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(bp.settings.freshAgent).toEqual({ showThinking: false })
    expect(bp.settings.freshAgent.showTools).toBeUndefined()
    expect(bp.settings.freshAgent.showTimecodes).toBeUndefined()
    expect(bp.settings.agentChat).toBeUndefined()
  })

  it('persists all three freshAgent toggles when each deviates from its default', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({
      freshAgent: { showThinking: false, showTools: false, showTimecodes: true },
    }))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const bp = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(bp.settings.freshAgent).toEqual({
      showThinking: false,
      showTools: false,
      showTimecodes: true,
    })
    expect(bp.settings.agentChat).toBeUndefined()
  })

  it('does not persist freshAgent values that equal the defaults', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({
      freshAgent: { showThinking: true, showTools: true, showTimecodes: false },
    }))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const bp = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(bp.settings?.freshAgent).toBeUndefined()
    expect(bp.settings?.agentChat).toBeUndefined()
  })

  it('round-trips freshAgent opt-outs through localStorage', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({
      freshAgent: { showThinking: false, showTools: false },
    }))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const saved = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(saved.settings.freshAgent).toEqual({ showThinking: false, showTools: false })
    expect(saved.settings.agentChat).toBeUndefined()

    const rehydrated = resolveLocalSettings(saved.settings)
    expect(rehydrated.freshAgent.showThinking).toBe(false)
    expect(rehydrated.freshAgent.showTools).toBe(false)
    expect(rehydrated.freshAgent.showTimecodes).toBe(false)
    expect('agentChat' in rehydrated).toBe(false)
  })
```

And in `drops legacy freshAgent.fontScale records when rehydrating old preferences` (:274-291), change the dispatched value from `{ showTools: true }` to `{ showTools: false }` and the assertion from `.toBe(true)` to `.toBe(false)` (keeps proving a real persisted record rehydrates, not the default):

```ts
    store.dispatch(updateSettingsLocal({
      freshAgent: { showTools: false },
    }))
    // ... unchanged middle ...
    expect(rehydrated.freshAgent.showTools).toBe(false)
    expect('fontScale' in rehydrated.freshAgent).toBe(false)
    expect('agentChat' in rehydrated).toBe(false)
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/shared/settings.test.ts test/unit/client/store/browserPreferencesPersistence.test.ts`

Expected: FAIL — the settings pins expect `showThinking: true`/`showTools: true` but the defaults are still `false`; the persistence fixtures expect `{ showThinking: false }` to persist but it still equals the default and is dropped.

- [ ] **Step 3: Add the minimal production implementation**

In `shared/settings.ts:920-924`, flip the two defaults (`showTimecodes` unchanged):

```ts
  freshAgent: {
    showThinking: true,
    showTools: true,
    showTimecodes: false,
  },
```

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/shared/settings.test.ts test/unit/client/store/browserPreferencesPersistence.test.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

No refactor needed — a single constant change; the sanitizers and merge machinery are value-agnostic.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: every test that resolves, persists, or migrates local settings — the whole `settings.test.ts` and `browserPreferencesPersistence.test.ts` (already run), plus the settings slice and preference-migration suites that consume the defaults indirectly:

Run: `npm run test:vitest -- run test/unit/client/store/settingsSlice.test.ts test/unit/client/browser-preferences.fresh-agent-settings.test.ts test/unit/client/store/persisted-state.fresh-agent.test.ts`

Expected: PASS (these pin explicit values and shapes, not the flipped defaults — `settingsSlice.test.ts:83-95` asserts a shape-agnostic spread; the migration suites use explicit `true`/`false` inputs that remain non-default or explicitly preserved).

- [ ] **Step 7: Commit the task**

```bash
git add shared/settings.ts test/unit/shared/settings.test.ts test/unit/client/store/browserPreferencesPersistence.test.ts
git commit -m "feat(settings): default fresh-agent thinking and tool display on"
```

---

### Task 2: FreshAgentView default fallbacks and default-visibility unit test

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentView.tsx:584-595` (the two selector fallbacks)
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx` (new test beside the precedence test at :709)
- Modify: `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx` (stale comments at :2017-2020, :2097-2100, :2177-2180, :2220-2222)

**Interfaces:**
- Consumes: Task 1's flipped defaults resolving through the store (`settingsSlice` resolves `defaultLocalSettings` at init); the per-pane override precedence `paneContent.showThinking ?? globalShowThinking` (`FreshAgentView.tsx:596-598`).
- Produces: effective defaults observable in `FreshAgentView` rendering — thinking rows visible and activity strips mounted expanded when neither pane overrides nor explicit settings exist.

- [ ] **Step 1: Write the failing behavioral test**

Add to `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`, directly after the `honors pane display overrides ahead of global fresh-agent settings` test (:709-773), mirroring its fixture shape but with NO settings dispatch and NO pane overrides:

```tsx
  it('shows thinking rows and expanded activity details by default', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
      status: 'idle',
      summary: 'Display summary',
      capabilities: { send: true, interrupt: true, fork: false },
      turns: [{
        id: 'turn-defaults', turnId: 'turn-defaults', role: 'assistant',
        timestamp: '2026-06-15T12:34:56.000Z',
        model: 'claude-opus-4-6',
        summary: 'used tools',
        items: [
          { id: 'think-defaults', kind: 'thinking', text: 'default-visible thinking' },
          {
            id: 'tool-defaults', kind: 'tool_use', toolUseId: 'call-defaults',
            name: 'Bash', input: { command: 'npm run display-check' },
          },
        ],
      }],
    })

    render(
      <Provider store={store}>
        <FreshAgentView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={{
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: 'req-defaults',
            sessionId: CLAUDE_THREAD_ID,
            status: 'connected',
          }}
        />
      </Provider>,
    )

    await waitFor(() => {
      // showTools defaults on: the activity strip mounts EXPANDED, so the
      // tool call detail renders with no click.
      expect(screen.getByText('npm run display-check')).toBeInTheDocument()
    })
    // showThinking defaults on: the Thinking disclosure renders.
    expect(screen.getByRole('button', { name: 'Thinking' })).toBeInTheDocument()
  })
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx -t 'shows thinking rows and expanded activity details by default'`

Expected: FAIL — with the old defaults, thinking items are filtered out (no `Thinking` button) and the strip mounts collapsed (no `npm run display-check` text in the document).

- [ ] **Step 3: Add the minimal production implementation**

In `src/components/fresh-agent/FreshAgentView.tsx:584-595`, flip the two fallbacks to match the new defaults (the `showTimecodes` fallback stays `?? false`):

```ts
  const globalShowThinking = useAppSelector(
    (state) => state.settings.settings.freshAgent?.showThinking
      ?? true,
  )
  const globalShowTools = useAppSelector(
    (state) => state.settings.settings.freshAgent?.showTools
      ?? true,
  )
```

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`

Expected: PASS (including the existing precedence test :709, which sets globals and overrides explicitly and must stay green).

- [ ] **Step 5: Refactor while green**

Update the now-false "production default showThinking=false" comments in `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx` (:2017-2020, :2097-2100, :2177-2180, :2220-2222) to state that production defaults are on and these tests pass explicit `showThinking={false}` to exercise the opt-out path. No production refactor needed.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: every fresh-agent component test that renders transcripts through `FreshAgentView` or `FreshAgentTranscript` (default-driven rendering):

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/`

Expected: PASS (transcript tests pass explicit props; mobile/item-card tests use text-only or item-level fixtures).

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/FreshAgentView.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx
git commit -m "feat(fresh-agent): show thinking and expanded tool details by default"
```

---

### Task 3: Settings UI toggles (Coding Agents → "Fresh agent display") with unit tests and docs mock

**Files:**
- Modify: `src/components/settings/CodingAgentsSettings.tsx` (add `applyLocalSetting` to the destructured props; add a second `SettingsSection`)
- Test: `test/unit/client/components/SettingsView.agent-chat.test.tsx` (:42-45 absence pins + one new test)
- Modify: `docs/index.html:993-1050` (mock switches, on)

**Interfaces:**
- Consumes: Task 1's defaults (`settings.freshAgent.showThinking/showTools` resolve true); `SettingsSectionProps.applyLocalSetting` (already passed to every section by `SettingsView.tsx:93-98`); `SettingsRow`/`Toggle` from `src/components/settings/settings-controls.tsx:32-54,93-126`.
- Produces: two `role="switch"` controls named `Show thinking` and `Show tools` under Settings → Coding Agents, persisting via `applyLocalSetting` (browser-local).

- [ ] **Step 1: Write the failing behavioral test**

In `test/unit/client/components/SettingsView.agent-chat.test.tsx`:

(a) Replace the absence pins at :42-45 in `renders compact rows for CLI and Fresh coding agents`:

```tsx
    // Display toggles revived (defaults on); the timecodes toggle and the
    // font-size control are NOT revived (out of scope).
    expect(screen.getByRole('switch', { name: 'Show thinking' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Show tools' })).toBeInTheDocument()
    expect(screen.queryByText('Show timecodes & model')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Fresh agent font size')).not.toBeInTheDocument()
```

(b) Add a new test in the same describe:

```tsx
  it('toggles fresh-agent display settings locally without calling the server', () => {
    const store = createSettingsViewStore()
    renderSettingsView(store)
    switchSettingsTab('Coding Agents')

    const thinkingToggle = screen.getByRole('switch', { name: 'Show thinking' })
    expect(thinkingToggle).toHaveAttribute('aria-checked', 'true')
    const toolsToggle = screen.getByRole('switch', { name: 'Show tools' })
    expect(toolsToggle).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(thinkingToggle)
    expect(store.getState().settings.settings.freshAgent.showThinking).toBe(false)
    expect(store.getState().settings.settings.freshAgent.showTools).toBe(true)
    expect(api.patch).not.toHaveBeenCalled()

    fireEvent.click(toolsToggle)
    expect(store.getState().settings.settings.freshAgent.showTools).toBe(false)
    expect(api.patch).not.toHaveBeenCalled()
  })
```

(`api` is already mocked at the top of the file, `:11-19`; the pattern — local toggle, no `/api/settings` call — is `SettingsView.behavior.test.tsx:317-338`.)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/SettingsView.agent-chat.test.tsx`

Expected: FAIL — no `Show thinking`/`Show tools` switches exist yet.

- [ ] **Step 3: Add the minimal production implementation**

In `src/components/settings/CodingAgentsSettings.tsx`:

1. Change the import line to include `SettingsRow`: `import { SettingsSection, SettingsRow, Toggle } from './settings-controls'`
2. Add `applyLocalSetting` to the destructured props: `export default function CodingAgentsSettings({ settings, applyLocalSetting, applyServerSetting }: SettingsSectionProps) {`
3. Wrap the existing `<SettingsSection id="coding-agents" ...>` in a fragment and append the new section after it:

```tsx
  return (
    <>
      <SettingsSection id="coding-agents" title="Coding Agents">
        {/* ...existing rows unchanged... */}
      </SettingsSection>
      <SettingsSection
        title="Fresh agent display"
        description="What fresh-agent panes show by default"
      >
        <SettingsRow label="Show thinking">
          <Toggle
            checked={settings.freshAgent?.showThinking ?? true}
            onChange={(checked) => {
              applyLocalSetting({ freshAgent: { showThinking: checked } })
            }}
            aria-label="Show thinking"
          />
        </SettingsRow>
        <SettingsRow label="Show tools">
          <Toggle
            checked={settings.freshAgent?.showTools ?? true}
            onChange={(checked) => {
              applyLocalSetting({ freshAgent: { showTools: checked } })
            }}
            aria-label="Show tools"
          />
        </SettingsRow>
      </SettingsSection>
    </>
  )
```

Update the docs mock `docs/index.html` — inside `#settings-panel-agents` (:993-1050), after the `settings-agent-list` div, add a section using the exact mock row pattern (`settings-row`/`settings-label`/`settings-control settings-switch-wrap`/`settings-switch on`, as at :985-988 and :1073):

```html
              <div class="settings-section">
                <h2>Fresh agent display</h2>
                <p class="settings-section-desc">What fresh-agent panes show by default</p>
                <div class="settings-list">
                  <div class="settings-row">
                    <div class="settings-label"><div class="settings-label-title">Show thinking</div></div>
                    <div class="settings-control settings-switch-wrap">
                      <button class="settings-switch on" type="button" role="switch" aria-checked="true" aria-label="Show thinking"></button>
                    </div>
                  </div>
                  <div class="settings-row">
                    <div class="settings-label"><div class="settings-label-title">Show tools</div></div>
                    <div class="settings-control settings-switch-wrap">
                      <button class="settings-switch on" type="button" role="switch" aria-checked="true" aria-label="Show tools"></button>
                    </div>
                  </div>
                </div>
              </div>
```

(Match the exact wrapper classes of neighboring sections — mirror `settings-panel-panes` at :1052-1059; if the mock's section wrapper differs, copy the nearest section's structure verbatim and only swap title/desc/rows.)

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/SettingsView.agent-chat.test.tsx`

Expected: PASS

- [ ] **Step 5: Refactor while green**

None — the section mirrors the removed `b29f7133a^` `WorkspaceSettings.tsx:265-300` markup (verified via `git show b29f7133a^:src/components/settings/WorkspaceSettings.tsx`) under its post-refactor home.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: all SettingsView section tests (the shell re-renders; section-split files per `settings-view-test-utils.tsx:251-252`) plus lint (a11y):

Run: `npm run test:vitest -- run test/unit/client/components/SettingsView.agent-chat.test.tsx test/unit/client/components/SettingsView.behavior.test.tsx test/unit/client/components/SettingsView.appearance.test.tsx` (plus every other `test/unit/client/components/SettingsView.*.test.tsx` file present)

Expected: PASS. Then run `npm run lint` — expected: PASS (no new a11y violations; both toggles carry explicit `aria-label`s).

- [ ] **Step 7: Commit the task**

```bash
git add src/components/settings/CodingAgentsSettings.tsx test/unit/client/components/SettingsView.agent-chat.test.tsx docs/index.html
git commit -m "feat(settings): add fresh-agent display toggles to Coding Agents"
```

---

### Task 4: E2E — adapt default-rendering describes and add default-visibility + toggle coverage

**Files:**
- Modify: `test/e2e-browser/specs/fresh-agent.spec.ts` (:1645-1667, :1669-1682, :1748-1785, :1787-1818; one new test)
- Modify: `test/e2e-browser/specs/settings.spec.ts` (one new test)

**Interfaces:**
- Consumes: Tasks 1–3 (defaults resolve through the e2e harness's fresh store; the settings toggles exist under Coding Agents). The seeding helpers `seedCollapsePane` (:1596-1643) and `seedFoldablePane` (:1686-1746) create panes with NO display overrides, so effective values now come from the flipped defaults: strips mount EXPANDED (`initialExpanded={showTools}`, `FreshAgentTranscript.tsx:865`) and thinking/reasoning rows render.
- Produces: cloud-runnable e2e proof of the new defaults and the toggles.

- [ ] **Step 1: Run the now-broken default-assuming describes and verify the intended failure**

Tasks 1–3 changed the default rendering these describes assume. Observe the red this run must repair before adapting:

Run: `export GCLOUD_ROBOT_HOME="$HOME/.codex/skills/gcloud-robot"; scripts/e2e-cloud.sh run --local --project=chromium test/e2e-browser/specs/fresh-agent.spec.ts --grep "activity line collapse|foldable echo captions"`

Expected: FAIL — the three store-default tests (:1645, :1669, :1748) expect collapsed summaries / need an expand click, but strips now mount expanded; :1787's expand clicks now collapse the strips.

- [ ] **Step 2: Write the new tests**

(a) New default-visibility test in `fresh-agent.spec.ts` (inside the `activity line collapse` describe, reusing `seedCollapsePane`):

```ts
  test('shows thinking rows and expanded activity details by default', async ({ freshellPage: _freshellPage, page, terminal }) => {
    await seedCollapsePane(page, terminal, 'defaults-thread', [
      { id: 'turn-user', turnId: 'turn-user', role: 'user', summary: 'read files',
        items: [{ id: 'item-user', kind: 'text', text: 'read these files' }] },
      {
        id: 'turn-mixed', turnId: 'turn-mixed', role: 'assistant', summary: 'thought and read',
        items: [
          { id: 'think-mixed', kind: 'thinking', text: 'weighing which files to read first' },
          { id: 'tool-mixed', kind: 'tool_use', toolUseId: 'c-mixed', name: 'Read', input: { file_path: 'src/a.ts' } },
        ],
      },
    ])
    const pane = page.locator('[data-context="fresh-agent"]').last()
    await expect(pane).toBeVisible({ timeout: 10_000 })
    const strip = pane.getByRole('region', { name: 'Activity strip' }).first()
    // showTools defaults on: the strip mounts EXPANDED without any click.
    await expect(strip.getByRole('button', { name: 'Toggle activity details' })).toHaveAttribute('aria-expanded', 'true')
    await expect(strip.getByRole('button', { name: 'Read tool call' })).toHaveCount(1)
    await expect(pane.getByText('src/a.ts')).toBeVisible()
    // showThinking defaults on: the Thinking disclosure renders.
    const thinking = strip.getByRole('button', { name: 'Thinking' })
    await expect(thinking).toBeVisible()
    await thinking.click()
    await expect(strip.getByText('weighing which files to read first')).toBeVisible()
  })
```

(b) New toggle test in `settings.spec.ts` (mirrors the cursor-blink pattern at :79-128 plus a localStorage assertion):

```ts
  test('fresh agent display toggles persist locally', async ({ freshellPage, page, harness, serverInfo }) => {
    await openSettingsSection(page, 'Coding Agents')

    const thinkingRow = page.getByText('Show thinking')
    await expect(thinkingRow).toBeVisible()
    const thinkingToggle = thinkingRow.locator('..').getByRole('switch')
    await expect(thinkingToggle).toHaveAttribute('aria-checked', 'true')

    await thinkingToggle.click()
    await page.waitForTimeout(600) // browser-preferences persist debounce is 500ms
    expect((await harness.getSettings()).freshAgent.showThinking).toBe(false)

    // Opt-outs persist across reload; the blob holds ONLY the non-default value.
    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await harness.waitForHarness()
    await harness.waitForConnection()
    expect((await harness.getSettings()).freshAgent.showThinking).toBe(false)
    const blob = await page.evaluate(() => localStorage.getItem('freshell.browser-preferences.v1'))
    const parsed = JSON.parse(blob ?? '{}')
    expect(parsed.settings?.freshAgent?.showThinking).toBe(false)
    expect(parsed.settings?.freshAgent?.showTools).toBeUndefined()
  })
```

- [ ] **Step 3: Adapt the broken tests**

No production code in this task. Adapt the four default-assuming tests in `fresh-agent.spec.ts`:

1. `collapses adjacent same-role tool turns into one accumulating activity line (3 + 2 = 5)` (:1645-1667) — strips now mount expanded. Replace the collapsed-summary + expand-click flow with a collapse round-trip that also pins the new default:

```ts
    const pane = page.locator('[data-context="fresh-agent"]').last()
    await expect(pane).toBeVisible({ timeout: 10_000 })
    const strips = pane.getByRole('region', { name: 'Activity strip' })
    await expect(strips).toHaveCount(1)
    // New default: the strip mounts EXPANDED — tool detail rows render with no click.
    await expect(pane.getByRole('button', { name: 'Read tool call' })).toHaveCount(5)
    const toggle = pane.getByRole('button', { name: 'Toggle activity details' })
    // Collapse still accumulates the line into one summary.
    await toggle.click()
    await expect(strips.first()).toContainText('5 tools used')
    await toggle.click()
    await expect(pane.getByRole('button', { name: 'Read tool call' })).toHaveCount(5)
    await expect(pane.getByText('src/a.ts')).toBeVisible()
    await expect(pane.getByText('src/e.ts')).toBeVisible()
    // A merged line's fork affordance resolves to the line's LAST contributing turn.
    const lineArticle = pane.locator('article[data-turn-index="1"]')
    await lineArticle.hover()
    await lineArticle.getByRole('button', { name: 'Fork conversation from here' }).click()
    const forkFrame = ((await harness.getSentWsMessages()) as any[]).find((m) => m?.type === 'freshAgent.fork')
    expect(forkFrame?.input?.atTurnId).toBe('turn-b')
```

2. `an intervening message keeps two tool lines separate` (:1669-1682) — assert the two strips' expanded rows, then collapse each to pin the summary:

```ts
    const pane = page.locator('[data-context="fresh-agent"]').last()
    await expect(pane).toBeVisible({ timeout: 10_000 })
    const strips = pane.getByRole('region', { name: 'Activity strip' })
    await expect(strips).toHaveCount(2)
    // New default: expanded mounts — each line shows its single tool row.
    await expect(strips.nth(0).getByRole('button', { name: 'Read tool call' })).toHaveCount(1)
    await expect(strips.nth(1).getByRole('button', { name: 'Read tool call' })).toHaveCount(1)
    await strips.nth(0).getByRole('button', { name: 'Toggle activity details' }).click()
    await strips.nth(1).getByRole('button', { name: 'Toggle activity details' }).click()
    await expect(strips.nth(0)).toContainText('1 tool used')
    await expect(strips.nth(1)).toContainText('1 tool used')
```

3. `an echo caption folds into the expanded activity line when a later turn supersedes it` (:1748-1785) — the strip is already expanded, so the click at :1778 would now COLLAPSE it. Remove that click; the expansion-only caption assertions then run against the mounted-expanded strip:

```ts
    // (delete the line: await pane.getByRole('button', { name: 'Toggle activity details' }).click()
    //  — the strip mounts expanded under the new showTools default)
    const caption = pane.getByTestId('fresh-agent-activity-caption')
    await expect(caption).toHaveCount(1)
    await expect(caption).toContainText('Considering options')
    await expect(pane.getByText('src/b.ts')).toBeVisible()
```

4. `authored prose never folds` (:1787-1818) — strips mount expanded, so the two expand clicks at :1815-1816 would now COLLAPSE the strips and make the trailing caption-count assertion vacuous. Delete both `Toggle activity details` click lines; the `fresh-agent-activity-caption` count-0 assertion then runs against the EXPANDED strips and stays meaningful. Then pin the thinking-by-default behavior in this authored shape: the prose lives in the showThinking-gated reasoning row, whose `FreshAgentThinkingRow` disclosure starts collapsed — expand it and assert the prose, exactly as the `ensureThinkingExpanded` helper (:1210-1221) does. Add after the existing tail-caption assertion:

```ts
    // New default: showThinking renders the authored reasoning row; its
    // disclosure starts collapsed — expand and assert the prose.
    const stripTwo = pane.getByRole('region', { name: 'Activity strip' }).nth(1)
    const thinking = stripTwo.getByRole('button', { name: 'Thinking' })
    await expect(thinking).toBeVisible()
    await thinking.click()
    await expect(stripTwo.getByText('Pausing to plan the next step').first()).toBeVisible()
```

- [ ] **Step 4: Run the focused test**

Run: `export GCLOUD_ROBOT_HOME="$HOME/.codex/skills/gcloud-robot"; scripts/e2e-cloud.sh run --local --project=chromium test/e2e-browser/specs/fresh-agent.spec.ts test/e2e-browser/specs/settings.spec.ts`

Expected: PASS — all adapted + new tests green locally.

- [ ] **Step 5: Refactor while green**

None — the adaptations keep each describe's original intent (collapse accumulation, line separation, fold boundary) while pinning the expanded-by-default mount.

- [ ] **Step 6: Run impacted-test verification**

Cloud lane (the configured e2e backend; required before any PR):

Run: `export GCLOUD_ROBOT_HOME="$HOME/.codex/skills/gcloud-robot"; scripts/e2e-cloud.sh run --project=chromium test/e2e-browser/specs/fresh-agent.spec.ts test/e2e-browser/specs/settings.spec.ts`

Expected: PASS (neither spec is in `CLOUD_SKIP_SPECS`). Then the full coordinated suite gate per the repo's documented procedure (`npm test` through the coordinator) — the pre-existing flaky base test documented in the run-state baseline ledger does not count against this run if it recurs.

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/fresh-agent.spec.ts test/e2e-browser/specs/settings.spec.ts
git commit -m "test(e2e): pin fresh-agent display defaults and settings toggles"
```

---

## Verification summary (user-visible outcome)

- Fresh profile, fresh-agent pane with thinking + tool items → Thinking disclosure and expanded tool detail visible with zero clicks (Task 2 unit, Task 4 e2e).
- Settings → Coding Agents → "Fresh agent display" → two switches, on by default; toggling off hides thinking rows / collapses strips; opt-outs persist per browser across reloads (Tasks 1+3 unit, Task 4 e2e).
- Existing browsers flip on with no migration (Task 1 persistence semantics); per-pane overrides still win (existing precedence test stays green).

## Notes for reviewers

- The 9 hard-breaking default-pinned tests and the extra absence-pin test (`SettingsView.agent-chat.test.tsx:42-45`) are all updated inside the tasks that flip the corresponding behavior — none are skipped or weakened; the persistence fixtures are re-based on the new defaults so they still prove the diff-vs-default contract.
- Per-pane popover toggles (`FreshAgentSettingsButton`) were considered and deliberately left out — the request covers "a toggle" per setting, and per-pane overrides already exist via the agent API. Listed as an optional follow-up in the recap, not built here.
