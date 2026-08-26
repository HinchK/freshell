# MCP Focus Neutrality Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

**Goal:** Agent/MCP/REST-driven tab and pane creation must never change which
tab or pane the user has focused; focus changes only via the explicit select
commands (`select-tab` / `select-pane`).

**Architecture:** Client-side fix in three layers. (1) `addTab` and
`splitPane` reducers gain an `activate?: boolean` flag (default: activate;
one bootstrap exception), and `handleUiCommand` marks the server-broadcast
`tab.create`/`pane.split` arms as non-activating while leaving the explicit
`tab.select`/`pane.select` arms untouched. (2) Every pane-content mount-time
DOM focus site (terminal, browser URL bar, editor, pane picker, directory
picker) is gated on `focusEligible` (`!hidden && activePane === node.id`), so
background-created panes mount quietly without stealing keyboard focus.
(3) `captureUiScreenshot`'s `restoreFocus` is hardened so it never resurrects
deleted tabs/panes and honestly reports `restoredFocus:false`. No server or
wire changes are needed: both servers (Node and Rust) broadcast identical
`ui.command` frames to every client, and `payload` is free-form in the frozen
schema — the `activate` flag lives only in *client* action payloads, never on
the wire.

**Tech Stack:** React 18 + Redux Toolkit client, Vitest + Testing Library for
unit/component tests, Playwright e2e against the owned RustServer wall harness.

## Global Constraints

- Worktree: `/home/dan/code/freshell/.worktrees/mcp-focus-neutrality`;
  branch `the-usual/mcp-focus-neutrality`; base `f2c7ef7a` (origin/main).
  All commands run from the worktree root.
- **Env sanitization is mandatory** for every test/build command in this run
  (we run inside a live Freshell pane and leaked vars break tests, e.g.
  `FRESHELL_BIND_HOST` poisons `test/unit/vite-config.test.ts`). Prefix every
  command with:
  `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL`
- Focused unit/component test command shape:
  `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run test:vitest -- run <files...> --config config/vitest/vitest.config.ts`
- E2E command shape (Rust-only specs):
  `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium <spec-basename>`
  The wall harness boots its OWN RustServer on an ephemeral port — never touch
  the live self-hosted server (port 3001).
- **No changes under `server/` or `crates/`.** This is a client-only behavior
  change; it deploys via `scripts/launch-rust.sh --client-only` + browser
  refresh, no server restart. The frozen WS contract
  (`port/contract/ws-server-messages.schema.json:3205-3221`, `"payload": true`)
  is untouched.
- Default-`true` semantics preserve every local/user-driven flow (tab-bar "+",
  pane "+", picker, keyboard shortcuts, drag-splits): all existing reducer and
  component tests must keep passing unchanged. The only behavior change is for
  server-broadcast creates and background-mounted panes.
- Conventional commits, one per task. Never force-push. Do NOT open a PR
  without explicit user approval.
- Repository rule: root `AGENTS.md` MUST be updated (Task 5) since this
  changes documented behavior; `docs/index.html` needs no change (invisible
  in the mock).

## Current behavior / root-cause evidence

All line numbers verified in the worktree at base `f2c7ef7a`.

1. **Redux activation (the primary steal).** The `addTab` reducer
   unconditionally sets `state.activeTabId = id` (`src/store/tabsSlice.ts:323`);
   the `splitPane` reducer unconditionally sets
   `state.activePane[tabId] = newPaneId` (`src/store/panesSlice.ts:1199`).
   Agent-driven creation arrives client-side as broadcast `ui.command`
   messages folded in `handleUiCommand` (`src/lib/ui-commands.ts:68-141`):
   `tab.create` → `addTab(...)` (L79-108), `pane.split` → `splitPane(...)`
   (L115-122). The explicit-focus verbs already exist: `tab.select` →
   `setActiveTab` (L109-110); `pane.select` → `setActiveTab` +
   `setActivePane` (L125-127). Server emission points: Node REST
   `server/agent-api/router.ts` (tab.create at :700/:771-785/:796-810,
   pane.split at :1280/:~1373) via `broadcastUiCommand`
   (`server/ws-handler.ts:3896-3898`, fans out to ALL sockets via `broadcast()`
   at :3879-3885); Rust `crates/freshell-freshagent/src/lib.rs:1856-1876`
   (broadcast_tab_create) and `pane_ops.rs` (select_pane/:339-382,
   tab.select/:~404). MCP funnels through the same REST surface
   (`server/mcp/freshell-tool.ts`: new-tab :655-681, split-pane :725-738,
   select-tab :697-703, select-pane :752-755) — fixing the client's fold fixes
   REST and MCP together.
2. **DOM focus steal (secondary).** All tab contents stay mounted behind the
   `.tab-hidden` CSS class. Mount-time focus sites that ignore visibility:
   - `TerminalView.tsx:1711-1713` — `flushScheduledLayout` runs
     `if (shouldFocus) term.focus()` ungated, fed by
     `requestTerminalLayout({ fit: true, focus: true })` at mount (:2300).
     (The OTHER focus effect at :1275-1285 IS gated by
     `shouldFocusActiveTerminal = !hidden && activeTabId === tabId &&
     activePaneId === paneId` at :1272 — do not touch it.)
   - `PanePicker.tsx:211-214` — unconditional container focus on mount.
   - `EditorPane.tsx:295-298` — `handleEditorMount` unconditionally calls
     `editor.focus()`.
   - `BrowserPane.tsx:435-441` — focuses the URL input when `url` is empty.
   - `DirectoryPicker.tsx:77-80` — unconditional input focus+select on mount.
   The threading seam is `PaneContainer.tsx`: `renderContent` is called once
   at :548 from the leaf branch with `hidden` and `activePane` both in scope
   (:525 `isActive={activePane === node.id}`).
3. **Screenshot restore (adjacent hardening).** `restoreFocus`
   (`src/lib/ui-screenshot.ts:293-320`, module-private) dispatches
   `setActivePane`/`setActiveTab` toward snapshot ids without checking the
   target still exists — a tab/pane deleted mid-capture gets resurrected as a
   stale `activePane`/`activeTabId` entry, blanking the work area.

## Stage-2 load-bearing validation — results (2026-08-25)

Validators dispatched one-assumption-per-subagent; full evidence in
`.worktrees/.the-usual-logs/mcp-focus-neutrality/load-bearing-ledger.md`.

1. **CONFIRMED with correction:** `handleUiCommand` (fed by WS frames only)
   is the single fold; every Node `ui.command` emission arm is agent-surface
   (`server/agent-api/router.ts` callers of `broadcastUiCommand`
   `server/ws-handler.ts:3896-3898`; `screenshot.capture` unicast at :1121-1130).
   No client code folds HTTP-response `uiCommand` payloads (`src/` has zero
   camelCase `uiCommand` references). Correction: the Rust server DOES embed
   `uiCommand` in HTTP responses (`crates/freshell-freshagent/src/terminal_tabs.rs:311,2293`)
   but only via `create_terminal_or_content_tab_deferred` (:181-186), which
   has ZERO callers (the `POST /api/tabs-sync/restore` consumer was never
   implemented) — unreachable dead code, irrelevant to this change.
2. **REVISED (plan updated):** hidden-pane-rebind-rust was NOT the only
   steal-reliant spec. Validator found three more: restore-contract-wall-rust
   (:2326-2331, :573ff), git-badges-rust (:194-196), sidebar-registry-sync-rust
   (case-c :339-341). All repairs are now in Task 1 Step 6.
3. **CONFIRMED:** no test asserts activation as the outcome of a ui.command
   tab.create/pane.split fold (`ui-commands.test.ts` asserts action types;
   `tabsPersistence.test.ts:488-514` asserts persistence outcomes only; server
   ws tests touch screenshot.capture only).
4. **CONFIRMED with FreshAgentView note:** the four gated components render
   ONLY via PaneContainer renderContent (no modal/onboarding callers), direct
   test renders get the default `focusEligible=true`, and no pre-existing test
   asserts focus behavior in hidden/non-active state. FreshAgentView needs no
   prop: it self-gates via `isActivePane = !hidden && activeTabId === tabId &&
   activePaneId === paneId` (FreshAgentView.tsx:652-658) and its focus effect
   early-returns when inactive (:2277-2291).

---

### Task 1: Focus-neutral Redux activation — `activate` flag + `ui.command` fold + e2e repair

**Files:**
- Modify: `src/store/tabsSlice.ts` (AddTabPayload at :274-290; addTab reducer at :296-324)
- Modify: `src/store/panesSlice.ts` (splitPane at :1163-1213)
- Modify: `src/lib/ui-commands.ts` (tab.create arm :79-108; pane.split arm :115-122)
- Test: `test/unit/client/store/tabsSlice.test.ts` (extend `describe('addTab')`, :56+)
- Test: `test/unit/client/store/panesSlice.test.ts` (extend `describe('splitPane')`, :612+)
- Test: `test/unit/client/ui-commands.test.ts` (192-line dispatch-capture file; extend + append integration describe)
- Test (repair, same commit): `test/e2e-browser/specs/hidden-pane-rebind-rust.spec.ts` (:230-232 and :329-332), `test/e2e-browser/specs/restore-contract-wall-rust.spec.ts` (:2326-2331 and :573ff), `test/e2e-browser/specs/git-badges-rust.spec.ts` (:194-196), `test/e2e-browser/specs/sidebar-registry-sync-rust.spec.ts` (case-c, before :339)

**Interfaces:**
- Consumes: existing reducers `addTab`, `splitPane`; existing `handleUiCommand` command arms; existing `revealTab(page, harness, tabId)` helper in the e2e spec (:190-200).
- Produces: `AddTabPayload.activate?: boolean`; `splitPane` payload `activate?: boolean`. Semantics: omitted/`true` = current activating behavior; `false` = insert without touching `activeTabId` / `activePane[tabId]`, EXCEPT `addTab` still activates when it creates the very first tab (bootstrap edge: `App.tsx` has no other promoter, so an empty-tabs client fed a silent create would otherwise show nothing).

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/client/store/tabsSlice.test.ts`, inside `describe('addTab')`:

```ts
    it('activate: false does not change the active tab', () => {
      let state = tabsReducer(initialState, addTab({ title: 'One' }))
      const firstActiveId = state.activeTabId
      state = tabsReducer(state, addTab({ title: 'Two', activate: false }))

      expect(state.tabs).toHaveLength(2)
      expect(state.activeTabId).toBe(firstActiveId)
    })

    it('activate: false still activates when this is the first tab (bootstrap edge)', () => {
      const state = tabsReducer(initialState, addTab({ title: 'Only', activate: false }))
      expect(state.tabs).toHaveLength(1)
      expect(state.activeTabId).toBe(state.tabs[0].id)
    })
```

Add to `test/unit/client/store/panesSlice.test.ts`, inside `describe('splitPane')`:

```ts
    it('activate: false keeps the current active pane', () => {
      let state = panesReducer(
        initialState,
        initLayout({ tabId: 'tab-1', content: { kind: 'terminal', mode: 'shell' } })
      )
      const originalPaneId = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).id

      state = panesReducer(
        state,
        splitPane({
          tabId: 'tab-1',
          paneId: originalPaneId,
          direction: 'horizontal',
          newPaneId: 'pane-new',
          newContent: { kind: 'terminal', mode: 'claude' },
          activate: false,
        })
      )

      const split = state.layouts['tab-1'] as Extract<PaneNode, { type: 'split' }>
      expect(split.type).toBe('split')
      expect((split.children[1] as Extract<PaneNode, { type: 'leaf' }>).id).toBe('pane-new')
      expect(state.activePane['tab-1']).toBe(originalPaneId)
      // Zoom-clear and title bookkeeping stay unconditional (layout invariants, not focus):
      expect(state.paneTitles['tab-1']['pane-new']).toBeDefined()
    })
```

Add to `test/unit/client/ui-commands.test.ts` (inside the existing `describe('handleUiCommand')`):

```ts
  it('tab.create dispatches addTab with activate: false (agent actions must not steal focus)', () => {
    const actions: any[] = []
    const dispatch = (action: any) => { actions.push(action); return action }

    handleUiCommand({ type: 'ui.command', command: 'tab.create', payload: { id: 't1', title: 'Alpha' } }, dispatch)

    expect(actions[0].type).toBe('tabs/addTab')
    expect(actions[0].payload.activate).toBe(false)
  })

  it('pane.split dispatches splitPane with activate: false', () => {
    const actions: any[] = []
    const dispatch = (action: any) => { actions.push(action); return action }

    handleUiCommand({
      type: 'ui.command',
      command: 'pane.split',
      payload: { tabId: 't1', paneId: 'p1', direction: 'horizontal', newPaneId: 'p2', newContent: { kind: 'terminal', mode: 'shell' } },
    }, dispatch)

    expect(actions[0].type).toBe('panes/splitPane')
    expect(actions[0].payload.newPaneId).toBe('p2')
    expect(actions[0].payload.activate).toBe(false)
  })
```

Append a new integration describe at the END of `test/unit/client/ui-commands.test.ts` (folding real reducers proves the whole wire→state path, mirroring `tabsPersistence.test.ts`'s makeStore pattern at :35-55):

```ts
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '../../../src/store/tabsSlice'
import panesReducer from '../../../src/store/panesSlice'

describe('ui.command focus neutrality through a real Redux store', () => {
  function makeUiStore() {
    return configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
      middleware: (getDefault) => getDefault({ serializableCheck: false }),
      preloadedState: {
        tabs: {
          tabs: [{
            id: 'tab-A',
            createRequestId: 'req-A',
            title: 'Tab A',
            status: 'running' as const,
            mode: 'shell' as const,
            shell: 'system' as const,
            createdAt: 1,
          }],
          activeTabId: 'tab-A',
          renameRequestTabId: null,
        },
        panes: {
          layouts: {
            'tab-A': { type: 'leaf' as const, id: 'pane-A1', content: { kind: 'terminal' as const, mode: 'shell' as const, status: 'running' as const, terminalId: 'term-A1' } },
          },
          activePane: { 'tab-A': 'pane-A1' },
          paneTitles: { 'tab-A': { 'pane-A1': 'Tab A' } },
          paneTitleSetByUser: {},
          renameRequestTabId: null,
          renameRequestPaneId: null,
          zoomedPane: {},
          refreshRequestsByPane: {},
        },
      } as any,
    })
  }

  it('tab.create never activates; explicit tab.select still does', () => {
    const store = makeUiStore()
    handleUiCommand({ type: 'ui.command', command: 'tab.create', payload: { id: 'tab-B', title: 'Agent tab' } }, store.dispatch)
    expect(store.getState().tabs.tabs.map((t) => t.id)).toEqual(['tab-A', 'tab-B'])
    expect(store.getState().tabs.activeTabId).toBe('tab-A')

    handleUiCommand({ type: 'ui.command', command: 'tab.select', payload: { id: 'tab-B' } }, store.dispatch)
    expect(store.getState().tabs.activeTabId).toBe('tab-B')
  })

  it('pane.split never activates; explicit pane.select still does', () => {
    const store = makeUiStore()
    handleUiCommand({
      type: 'ui.command',
      command: 'pane.split',
      payload: { tabId: 'tab-A', paneId: 'pane-A1', direction: 'horizontal', newPaneId: 'pane-A2', newContent: { kind: 'terminal', mode: 'shell' } },
    }, store.dispatch)
    expect(store.getState().panes.layouts['tab-A'].type).toBe('split')
    expect(store.getState().panes.activePane['tab-A']).toBe('pane-A1')

    handleUiCommand({ type: 'ui.command', command: 'pane.select', payload: { tabId: 'tab-A', paneId: 'pane-A2' } }, store.dispatch)
    expect(store.getState().panes.activePane['tab-A']).toBe('pane-A2')
    expect(store.getState().tabs.activeTabId).toBe('tab-A')
  })
})
```

(Place the three new imports at the top of the file with the existing imports; the `as any` on preloadedState relaxes full-state-shape friction, matching existing test-file conventions.)

- [ ] **Step 2: Run the tests and verify the intended failures**

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run test:vitest -- run test/unit/client/store/tabsSlice.test.ts test/unit/client/store/panesSlice.test.ts test/unit/client/ui-commands.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL, exactly:
- tabsSlice `activate: false does not change the active tab` — reducer ignores `activate` today, so `activeTabId` becomes the new tab.
- panesSlice `activate: false keeps the current active pane` — `activePane['tab-1']` becomes `pane-new` today.
- ui-commands `payload.activate` `toBe(false)` ×2 — `activate` is `undefined` today (and TypeScript may flag the unknown `activate` option in test code until the payload types change in Step 3; vitest runs regardless).
- integration describe: both `never activates` assertions fail (activation happens today).

Expected PASS already (pins, keep passing before AND after): the tabsSlice bootstrap-edge test (reducer always activates today) and all pre-existing tests in these files.

- [ ] **Step 3: Add the minimal production implementation**

`src/store/tabsSlice.ts` — extend the payload type (after `titleSetByUser?: boolean` at :289):

```ts
  /**
   * Server-driven creates (ui.command tab.create) pass activate:false so an
   * agent/MCP action never steals the user's focus. Local creates omit the
   * flag and keep the historical auto-activation. Bootstrap exception: the
   * very first tab always becomes active — nothing else promotes it.
   */
  activate?: boolean
```

and gate the activation at :322-323:

```ts
      state.tabs.push(tab)
      if (payload.activate !== false || state.tabs.length === 1) {
        state.activeTabId = id
      }
```

(`state.tabs.length === 1` after push means the list was empty before push — this is the "very first tab" bootstrap edge.)

`src/store/panesSlice.ts` — extend the splitPane payload type (:1165-1171) and destructure (:1173):

```ts
      action: PayloadAction<{
        tabId: string
        paneId: string
        direction: 'horizontal' | 'vertical'
        newContent: PaneContentInput
        newPaneId?: string
        /** ui.command pane.split passes false — agent-driven splits never steal focus-in-tab. */
        activate?: boolean
      }>
```

```ts
      const { tabId, paneId, direction, newContent, newPaneId: providedPaneId, activate } = action.payload
```

and gate the focus move at :1199 (zoom-clear at :1202-1204 and pane-title init at :1207-1210 remain unconditional — they are layout invariants, not focus):

```ts
      if (newRoot) {
        state.layouts[tabId] = newRoot
        if (activate !== false) {
          state.activePane[tabId] = newPaneId
        }
```

`src/lib/ui-commands.ts` — in the `tab.create` arm (:80-89) add one line to the addTab object:

```ts
      dispatch(addTab({
        id: msg.payload.id,
        title: msg.payload.title,
        mode: msg.payload.mode,
        shell: msg.payload.shell,
        initialCwd: msg.payload.initialCwd,
        sessionRef: msg.payload.sessionRef,
        resumeSessionId: msg.payload.resumeSessionId,
        status: msg.payload.status,
        activate: false,
      }))
```

and in the `pane.split` arm (:116-122) add one line:

```ts
      return dispatch(splitPane({
        tabId: msg.payload.tabId,
        paneId: msg.payload.paneId,
        direction: msg.payload.direction,
        newContent: msg.payload.newContent,
        newPaneId: msg.payload.newPaneId,
        activate: false,
      }))
```

The `tab.select` (:109-110) and `pane.select` (:125-127) arms are deliberately NOT touched: explicit focus verbs keep activating.

- [ ] **Step 4: Run the focused tests**

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run test:vitest -- run test/unit/client/store/tabsSlice.test.ts test/unit/client/store/panesSlice.test.ts test/unit/client/ui-commands.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS (all new tests green; all pre-existing tests in these files still green).

- [ ] **Step 5: Refactor while green**

No extraction warranted: each gate is a 3-line `if` with a comment; the
duplication across two reducers is structural, not semantic (different state
keys, different bootstrap rules). Keep the gates inline.

- [ ] **Step 6: Impacted-test verification + repair the e2e spec that relied on the steal**

Impacted set: every consumer of the two reducers and of `handleUiCommand`.
That is the store suite, the persistence fold (`tabsPersistence.test.ts:484-501`,
which folds `ui.command{tab.create}` through a real store and keeps passing
because insertion is unchanged), and the screenshot suite.

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run typecheck`
Expected: PASS (the optional-flag change is backward compatible).

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run test:vitest -- run test/unit/client/store test/unit/client/ui-commands.test.ts test/unit/client/ui-screenshot.test.ts --config config/vitest/vitest.config.ts`
Expected: PASS.

E2E repair (REQUIRED in this commit — Task 1's fold change turns the old
steal into failures in four spec files; load-bearing validator #2 located
every site). The repair pattern is uniform: after a REST create that a test
relied on for activation, add an explicit user-equivalent reveal (tab-strip
click, `[data-context="tab"][data-tab-id="..."]` — the DOM hook from
`hidden-pane-rebind-rust.spec.ts`'s revealTab comment at :187-189 and the
verbatim idiom at `reconnect-revive-rust.spec.ts:188`).

**Repair 1** — `hidden-pane-rebind-rust.spec.ts`, two sites, using this spec's
existing `revealTab` helper (:190-200).

Site 1 (:229-232), replace:

```ts
      // Hide it: a second tab becomes active.
      await createTabViaRest(info, { mode: 'shell', cwd: os.tmpdir() })
      await harness.waitForTabCount(2)
      await expect.poll(async () => harness.getActiveTabId(), { timeout: 15_000 }).not.toBe(hiddenTabId)
```

with:

```ts
      // Hide it: a second tab becomes active. REST creates are focus-neutral
      // (agent-driven creates must not steal user focus), so hiding requires an
      // explicit user-equivalent reveal (tab-strip click) — that replaces the
      // activation the create used to perform implicitly.
      const shellTabId = await createTabViaRest(info, { mode: 'shell', cwd: os.tmpdir() })
      await harness.waitForTabCount(2)
      await revealTab(page, harness, shellTabId)
      await expect.poll(async () => harness.getActiveTabId(), { timeout: 15_000 }).not.toBe(hiddenTabId)
```

Site 2 (:329-332), replace:

```ts
      // Hide it behind a new shell tab.
      await createTabViaRest(info, { mode: 'shell', cwd: os.tmpdir() })
      await harness.waitForTabCount(2)
      await expect.poll(async () => harness.getActiveTabId(), { timeout: 15_000 }).not.toBe(freshTabId)
```

with:

```ts
      // Hide it behind a new shell tab (explicit reveal — REST creates are
      // focus-neutral now; see site 1 above).
      const shellTabId = await createTabViaRest(info, { mode: 'shell', cwd: os.tmpdir() })
      await harness.waitForTabCount(2)
      await revealTab(page, harness, shellTabId)
      await expect.poll(async () => harness.getActiveTabId(), { timeout: 15_000 }).not.toBe(freshTabId)
```

**Repair 2** — `restore-contract-wall-rust.spec.ts`, two site groups (this
spec has no revealTab helper; use the tab-strip click idiom directly).

Site A (:2326-2331, the hidden-pane-rebind wall entry), replace:

```ts
      // Second tab becomes active; the first is now hidden.
      await createTabViaRest(info, { mode: 'shell', cwd: os.tmpdir() })
      await harness.waitForTabCount(2)
      await expect
        .poll(async () => harness.getActiveTabId(), { timeout: 15_000 })
        .not.toBe(hiddenTabId)
```

with:

```ts
      // Second tab becomes active; the first is now hidden. REST creates are
      // focus-neutral (agent-driven creates must not steal user focus), so the
      // switch requires an explicit reveal — a user-equivalent tab-strip click.
      const secondTabId = await createTabViaRest(info, { mode: 'shell', cwd: os.tmpdir() })
      await harness.waitForTabCount(2)
      await page.locator(`[data-context="tab"][data-tab-id="${secondTabId}"]`).click()
      await expect
        .poll(async () => harness.getActiveTabId(), { timeout: 15_000 })
        .not.toBe(hiddenTabId)
```

Site B (:573, 'shell terminal: SIGKILL restore yields a fresh shell in
initialCwd') — the test interacts with the new tab via `.xterm` clicks at
:587 and :612, which require the new tab active. Insert the reveal right
after the tab-count poll (:574-576) and before the terminalId poll (:578):

```ts
      // REST creates are focus-neutral; reveal the new tab explicitly
      // (user-equivalent tab-strip click) before driving its terminal.
      await page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`).click()
      await expect.poll(async () => harness.getActiveTabId(), { timeout: 10_000 }).toBe(tabId)
```

(The pre-existing `.xterm` `.last()` selectors keep working: the new tab is
appended last in DOM order and is now active+visible, exactly as the implicit
activation arranged before.)

**Repair 3** — `git-badges-rust.spec.ts` :194-196 (test 'a REST-created shell
tab (POST /api/tabs {cwd}) shows a git badge (seedFromTerminal parity)'). The
pane-visibility assertion requires the REST-created tab active. Insert
between the tab-strip text assertion (:194) and the paneShell assertion (:195):

```ts
      // REST creates are focus-neutral; reveal the tab explicitly (user-
      // equivalent tab-strip click) before asserting its pane is visible.
      await page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`).click()
```

**Repair 4** — `sidebar-registry-sync-rust.spec.ts` case-c ('case-c: fresh
codex terminal collapses to a single green row'), before the `.xterm`
interactions at :339-341. The test REST-creates the codex tab at :308-314
(binding `restTabId`) and later types Enter into its PTY. Insert right after
the prompt-gate poll block (ends :332):

```ts
    // REST creates are focus-neutral; reveal the codex tab explicitly (user-
    // equivalent tab-strip click) before driving its terminal.
    await page.locator(`[data-context="tab"][data-tab-id="${restTabId}"]`).click()
    await expect.poll(async () => harness.getActiveTabId(), { timeout: 10_000 }).toBe(restTabId)
```

Run the five repaired tests in three invocations (`-g` applies to every spec
basename in the same run, so the unfiltered hidden-pane spec goes alone):

```bash
env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium hidden-pane-rebind-rust
env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium git-badges-rust sidebar-registry-sync-rust -g "a REST-created shell tab|case-c: fresh codex terminal collapses"
env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium restore-contract-wall-rust -g "hidden-pane rebind: a background tab pane must rebind without being revealed|shell terminal: SIGKILL restore yields a fresh shell in initialCwd"
```

Expected: PASS for all five repaired tests (the reveals have the same
semantic effect the implicit activation had, so every discriminating poll
downstream is untouched).

- [ ] **Step 7: Commit the task**

```bash
git add src/store/tabsSlice.ts src/store/panesSlice.ts src/lib/ui-commands.ts test/unit/client/store/tabsSlice.test.ts test/unit/client/store/panesSlice.test.ts test/unit/client/ui-commands.test.ts test/e2e-browser/specs/hidden-pane-rebind-rust.spec.ts test/e2e-browser/specs/restore-contract-wall-rust.spec.ts test/e2e-browser/specs/git-badges-rust.spec.ts test/e2e-browser/specs/sidebar-registry-sync-rust.spec.ts
git commit -m "feat(client): focus-neutral agent-driven tab/pane creation

addTab/splitPane gain activate?:boolean (default activate; addTab still
activates the very first tab). handleUiCommand folds server-broadcast
tab.create/pane.split with activate:false while the explicit tab.select/
pane.select verbs keep activating. hidden-pane-rebind-rust e2e repaired: its
tab-hiding step now uses an explicit reveal (REST create no longer activates)."
```

### Task 2: Gate mount-time DOM focus on pane focus eligibility

**Files:**
- Modify: `src/components/panes/PaneContainer.tsx` (leaf branch ~:515-549; PickerWrapper :585-593 & call sites :793-814; renderContent :817-907)
- Modify: `src/components/panes/BrowserPane.tsx` (props :14-20; destructure :176-182; effect :435-441)
- Modify: `src/components/panes/EditorPane.tsx` (props :129-138; destructure; handleEditorMount :295-298)
- Modify: `src/components/panes/PanePicker.tsx` (props :66-72; destructure :74; mount effect :211-214)
- Modify: `src/components/panes/DirectoryPicker.tsx` (props :8-16; destructure :47-56; mount effect :77-80)
- Modify: `src/components/TerminalView.tsx` (add ref at :1272 area; gate :1711)
- Test: `test/unit/client/components/panes/DirectoryPicker.test.tsx` (render helper at top; existing selection test pins default)
- Test: `test/unit/client/components/panes/BrowserPane.test.tsx` (renderBrowserPane helper)
- Test: `test/unit/client/components/panes/EditorPane.test.tsx` (monaco mock :23-36 gains onMount support)
- Test: `test/unit/client/components/panes/PanePicker.test.tsx` (renderPicker helper :120-136 + auto-focus describe :675-681)
- Test (create): `test/unit/client/components/TerminalView.focusGate.test.tsx`

**Interfaces:**
- Consumes: nothing from Task 1 (independent layer; either can land first).
- Produces: optional prop `focusEligible?: boolean` (default `true`) on `BrowserPane`, `EditorPane`, `PanePicker`, `DirectoryPicker`, and on the local `PickerWrapper`. `PaneContainer` computes `focusEligible = !hidden && activePane === node.id` per leaf and passes it down. After this task, mounting any of these pane kinds in a hidden tab or non-active pane never moves DOM focus.

- [ ] **Step 1: Write the failing tests**

(a) `test/unit/client/components/panes/DirectoryPicker.test.tsx` — append a describe. `renderDirectoryPicker` already spreads prop overrides onto the component, so `focusEligible` flows without helper changes:

```tsx
  describe('focus gating', () => {
    it('focuses and selects the input by default (focusEligible omitted)', async () => {
      renderDirectoryPicker({ defaultCwd: '/tmp/work' })
      const input = screen.getByLabelText('Starting directory for Claude') as HTMLInputElement
      await waitFor(() => expect(input).toHaveFocus())
      await waitFor(() => expect(input.selectionEnd).toBe('/tmp/work'.length))
    })

    it('does not focus the input when focusEligible is false', async () => {
      renderDirectoryPicker({ defaultCwd: '/tmp/work', focusEligible: false })
      const input = screen.getByLabelText('Starting directory for Claude') as HTMLInputElement
      await waitFor(() => expect(input.value).toBe('/tmp/work'))
      expect(input).not.toHaveFocus()
    })
  })
```

(b) `test/unit/client/components/panes/BrowserPane.test.tsx` — append a describe (`renderBrowserPane` spreads overrides; the URL input has `placeholder="Enter URL..."`, BrowserPane.tsx:522):

```tsx
  describe('focus gating', () => {
    it('focuses the URL input for an empty-url pane that owns focus (default)', () => {
      renderBrowserPane({ url: '' })
      expect(screen.getByPlaceholderText('Enter URL...')).toHaveFocus()
    })

    it('does not focus the URL input when focusEligible is false', () => {
      renderBrowserPane({ url: '', focusEligible: false })
      expect(screen.getByPlaceholderText('Enter URL...')).not.toHaveFocus()
    })
  })
```

(c) `test/unit/client/components/panes/PanePicker.test.tsx` — extend the `renderPicker` helper's props bag (:120-136) with `focusEligible` and pass it through, then extend the existing `auto-focus on mount` describe (:675-681):

```tsx
function renderPicker(
  overrides?: Parameters<typeof createStore>[0],
  props?: { onSelect?: ReturnType<typeof vi.fn>; onCancel?: ReturnType<typeof vi.fn>; isOnlyPane?: boolean; focusEligible?: boolean }
) {
  const store = createStore(overrides)
  const onSelect = props?.onSelect ?? vi.fn()
  const onCancel = props?.onCancel ?? vi.fn()
  const isOnlyPane = props?.isOnlyPane ?? false
  const focusEligible = props?.focusEligible ?? true
  render(
    <Provider store={store}>
      <PanePicker onSelect={onSelect} onCancel={onCancel} isOnlyPane={isOnlyPane} focusEligible={focusEligible} />
    </Provider>
  )
  return { onSelect, onCancel, store }
}
```

```tsx
  describe('auto-focus on mount', () => {
    it('focuses the picker container on mount', () => {
      renderPicker()
      const container = getContainer()
      expect(container).toHaveFocus()
    })

    it('does not focus the picker container when focusEligible is false', () => {
      renderPicker(undefined, { focusEligible: false })
      expect(getContainer()).not.toHaveFocus()
    })
  })
```

(d) `test/unit/client/components/panes/EditorPane.test.tsx` — the current Monaco mock (:23-36) never calls `onMount`, so `handleEditorMount` never runs in jsdom. Extend the mock behind a hoisted control flag (default off ⇒ existing tests behave exactly as before):

```tsx
const monacoMountControl = vi.hoisted(() => ({
  enabled: false,
  focus: vi.fn(),
}))

vi.mock('@monaco-editor/react', () => {
  const MonacoMock = ({ value, onChange, theme, onMount }: any) => {
    useEffect(() => {
      if (monacoMountControl.enabled) {
        onMount?.(
          { focus: monacoMountControl.focus, getValue: () => '', setValue: () => {}, updateOptions: () => {}, getModel: () => null } as any,
          {} as any,
        )
      }
    }, [])
    return (
      <textarea
        data-testid="monaco-mock"
        data-theme={theme}
        value={value}
        onChange={(e: any) => onChange?.(e.target.value)}
      />
    )
  }
  return {
    default: MonacoMock,
    Editor: MonacoMock,
  }
})
```

(add `import { useEffect } from 'react'` at the top of the file). Append:

```tsx
  describe('focus gating', () => {
    beforeEach(() => {
      monacoMountControl.focus.mockClear()
    })

    afterEach(() => {
      monacoMountControl.enabled = false
    })

    it('focuses the editor on mount for the pane owning focus (default)', async () => {
      monacoMountControl.enabled = true
      render(
        <Provider store={store}>
          <EditorPane paneId="pane-1" tabId="tab-1" filePath="/test.ts" language="typescript" readOnly={false} content="const x = 1" viewMode="source" />
        </Provider>
      )
      await waitFor(() => expect(screen.getByTestId('monaco-mock')).toBeInTheDocument())
      await waitFor(() => expect(monacoMountControl.focus).toHaveBeenCalled())
    })

    it('does not focus the editor on mount when focusEligible is false', async () => {
      monacoMountControl.enabled = true
      render(
        <Provider store={store}>
          <EditorPane paneId="pane-1" tabId="tab-1" filePath="/test.ts" language="typescript" readOnly={false} content="const x = 1" viewMode="source" focusEligible={false} />
        </Provider>
      )
      await waitFor(() => expect(screen.getByTestId('monaco-mock')).toBeInTheDocument())
      await new Promise((r) => setTimeout(r, 50))
      expect(monacoMountControl.focus).not.toHaveBeenCalled()
    })
  })
```

(e) Create `test/unit/client/components/TerminalView.focusGate.test.tsx`: copy the harness verbatim from `TerminalView.urlClick.test.tsx` lines 1-157 (imports incl. `screen`/`fireEvent` may be pruned out; keep: wsMocks + `getWsClient` mock, `useNotificationSound` mock, `openExternalUrl` stub mock, `terminal-themes` mock, `MockTerminal` class — it already has `focus = vi.fn()` and pushes instances into `terminalInstances` —, `@xterm/addon-fit` mock, xterm.css stub, `MockResizeObserver`, `paneContent`, `createStore`). Change ONLY `createStore`: add an options parameter

```ts
function createStore(opts: { activeTabId?: string | null; activePaneId?: string; settings?: Partial<AppSettings> } = {}) {
  const mergedSettings = { ...defaultSettings, ...opts.settings, terminal: { ...defaultSettings.terminal, ...opts.settings?.terminal } }
```

and in `preloadedState` set `activeTabId: opts.activeTabId === undefined ? 'tab-1' : opts.activeTabId` and `activePane: { 'tab-1': opts.activePaneId ?? 'pane-1' }`. Then:

```tsx
describe('TerminalView scheduled-focus gate (agent focus neutrality)', () => {
  beforeEach(() => {
    terminalInstances.length = 0
    registeredLinkProviders.length = 0
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('focuses the terminal on mount when the pane owns focus (pin: user default preserved)', async () => {
    const store = createStore()
    render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} hidden={false} />
      </Provider>
    )
    await waitFor(() => expect(terminalInstances).toHaveLength(1))
    await waitFor(() => expect(terminalInstances[0].focus).toHaveBeenCalled())
  })

  it('never focuses a terminal that mounts in a hidden tab', async () => {
    const store = createStore()
    render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} hidden />
      </Provider>
    )
    await waitFor(() => expect(terminalInstances).toHaveLength(1))
    await act(async () => { await new Promise((r) => setTimeout(r, 150)) })
    expect(terminalInstances[0].focus).not.toHaveBeenCalled()
  })

  it('never focuses a terminal when another pane holds tab focus', async () => {
    const store = createStore({ activePaneId: 'pane-other' })
    render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} hidden={false} />
      </Provider>
    )
    await waitFor(() => expect(terminalInstances).toHaveLength(1))
    await act(async () => { await new Promise((r) => setTimeout(r, 150)) })
    expect(terminalInstances[0].focus).not.toHaveBeenCalled()
  })
})
```

(The positive pin doubles as harness validation: if IT fails pre-change, the scheduler flush never fired — debug the harness, not the gate.)

- [ ] **Step 2: Run the tests and verify the intended failures**

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run test:vitest -- run test/unit/client/components/panes/DirectoryPicker.test.tsx test/unit/client/components/panes/BrowserPane.test.tsx test/unit/client/components/panes/PanePicker.test.tsx test/unit/client/components/panes/EditorPane.test.tsx test/unit/client/components/TerminalView.focusGate.test.tsx --config config/vitest/vitest.config.ts`

Expected: FAIL, exactly —
- DirectoryPicker/BrowserPane/PanePicker/EditorPane: the `focusEligible is false` tests fail (focus happens unconditionally today; the prop is unknown/ignored).
- TerminalView.focusGate: the two `never focuses` tests fail (`flushScheduledLayout`'s focus is ungated today).
Expected PASS already (pins): every default-omitted focus test (proves today’s user-flow autofocus).

- [ ] **Step 3: Add the minimal production implementation**

`src/components/panes/PaneContainer.tsx`:
- In the leaf branch of `renderNode`, immediately before the `return (<Pane ... >` (~:521), add:

```tsx
    // focusEligible: this pane may auto-focus DOM when it mounts. Requires the
    // VISIBLE tab (!hidden) AND this tab's active pane. Agent-created tabs land
    // hidden (Task 1 keeps Redux activeTabId on the user's tab), so their panes
    // mount without stealing keyboard focus.
    const focusEligible = !hidden && activePane === node.id
```

- Change the renderContent call (:548) to `{renderContent(tabId, node.id, node.content, isOnlyPane, hidden, focusEligible)}`.
- Extend `renderContent` (:817-823): add a 6th parameter `focusEligible = true`, and forward it in three arms:

```tsx
// browser arm:
        <BrowserPane
          paneId={paneId}
          tabId={tabId}
          browserInstanceId={content.browserInstanceId}
          url={content.url}
          devToolsOpen={content.devToolsOpen}
          focusEligible={focusEligible}
        />
// editor arm:
          <EditorPane
            paneId={paneId}
            tabId={tabId}
            filePath={content.filePath}
            language={content.language}
            readOnly={content.readOnly}
            content={content.content}
            viewMode={content.viewMode}
            wordWrap={content.wordWrap}
            focusEligible={focusEligible}
          />
// picker arm:
        <PickerWrapper
          tabId={tabId}
          paneId={paneId}
          isOnlyPane={isOnlyPane}
          focusEligible={focusEligible}
        />
```

- `PickerWrapper` (:585-593): add `focusEligible = true` to its destructured props and `focusEligible?: boolean` to its inline type; forward it to BOTH the `DirectoryPicker` (:793-803) and `PanePicker` (:806-814) JSX.

(Terminal and fresh-agent arms need no prop: TerminalView self-derives eligibility in-component; FreshAgentView already self-gates.)

`src/components/panes/BrowserPane.tsx`:
- `BrowserPaneProps` (:14-20): add `focusEligible?: boolean`.
- Destructure (:176-182): add `focusEligible = true`.
- Gate the mount effect (:435-441):

```tsx
  useEffect(() => {
    // Focus the URL input only when there's no initial URL (user just created a
    // new browser pane) AND this pane owns focus. Background-mounted browser
    // panes (agent-created hidden tabs) must not steal keyboard focus.
    if (focusEligible && !url && inputRef.current) {
      inputRef.current.focus()
    }
  }, [url, focusEligible])
```

`src/components/panes/EditorPane.tsx`:
- `EditorPaneProps` (:129-138): add `focusEligible?: boolean`.
- Destructure: add `focusEligible = true`.
- `handleEditorMount` (:295-298):

```tsx
  function handleEditorMount(editor: Monaco.editor.IStandaloneCodeEditor) {
    editorRef.current = editor
    if (focusEligible) editor.focus()
  }
```

`src/components/panes/PanePicker.tsx`:
- `PanePickerProps` (:66-72): add `focusEligible?: boolean`.
- Destructure (:74): add `focusEligible = true`.
- Mount effect (:211-214):

```tsx
  // Auto-focus the container when the picker owns focus, so keyboard shortcuts
  // work immediately; background-mounted pickers must not steal DOM focus.
  useEffect(() => {
    if (focusEligible) containerRef.current?.focus()
  }, [focusEligible])
```

`src/components/panes/DirectoryPicker.tsx`:
- `DirectoryPickerProps` (:8-16): add `focusEligible?: boolean`.
- Destructure: add `focusEligible = true`.
- Mount effect (:77-80):

```tsx
  useEffect(() => {
    if (!focusEligible) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusEligible])
```

(The dependency arrays gain `focusEligible` deliberately: when the user brings
a hidden picker/pane to the active position, it autofocuses then — the
original "so shortcuts work immediately" intent, now scoped to the pane that
actually owns focus.)

`src/components/TerminalView.tsx`:
- Declare the eligibility ref next to the other render-synced refs (near the
  render-sync block at :1261-1266):

```ts
  const shouldFocusActiveTerminalRef = useRef(false)
```

  and immediately after the derivation at :1272:

```ts
  const shouldFocusActiveTerminal = !hidden && activeTabId === tabId && activePaneId === paneId
  shouldFocusActiveTerminalRef.current = shouldFocusActiveTerminal
```

- Gate the scheduled flush focus (:1711-1713):

```ts
    if (shouldFocus && shouldFocusActiveTerminalRef.current) {
      term.focus()
    }
```

(`flushScheduledLayout` is a useCallback; refs are dep-free, so the existing
dependency array needs no change. The OTHER focus effect at :1275-1285 already
gates on `shouldFocusActiveTerminal` — no change.)

- [ ] **Step 4: Run the focused tests**

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run test:vitest -- run test/unit/client/components/panes/DirectoryPicker.test.tsx test/unit/client/components/panes/BrowserPane.test.tsx test/unit/client/components/panes/PanePicker.test.tsx test/unit/client/components/panes/EditorPane.test.tsx test/unit/client/components/TerminalView.focusGate.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS (new gates green; all pins green).

- [ ] **Step 5: Refactor while green**

No shared abstraction: each site gates a different focus mechanism (xterm
focus, monaco focus, input focus, container focus) with slightly different
intent comments. A shared `useFocusEligible` hook would add indirection
without removing logic; keep the gates inline.

- [ ] **Step 6: Impacted-test verification**

Impacted: all pane-component suites, PaneContainer/PaneLayout suites, every
TerminalView suite, and typecheck (prop changes touch public component props —
`focusEligible` is optional so all existing call sites remain valid).

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run typecheck`
Expected: PASS.

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run test:vitest -- run test/unit/client/components --config config/vitest/vitest.config.ts`
Expected: PASS. Pay particular attention to: `PaneContainer.test.tsx`,
`PaneLayout.test.tsx`, `PaneContainer.createContent.test.tsx` (they exercise
renderContent indirectly), and all `TerminalView.*` files.

- [ ] **Step 7: Commit the task**

```bash
git add src/components/panes/PaneContainer.tsx src/components/panes/BrowserPane.tsx src/components/panes/EditorPane.tsx src/components/panes/PanePicker.tsx src/components/panes/DirectoryPicker.tsx src/components/TerminalView.tsx test/unit/client/components/panes/BrowserPane.test.tsx test/unit/client/components/panes/DirectoryPicker.test.tsx test/unit/client/components/panes/EditorPane.test.tsx test/unit/client/components/panes/PanePicker.test.tsx test/unit/client/components/TerminalView.focusGate.test.tsx
git commit -m "feat(client): gate mount-time DOM focus on pane focus eligibility

PaneContainer computes focusEligible = !hidden && activePane === node.id and
threads it to BrowserPane/EditorPane/PickerWrapper (PanePicker +
DirectoryPicker). TerminalView gates the scheduled flush term.focus() on a
render-synced shouldFocusActiveTerminal ref. Background-mounted panes (agent-
created hidden tabs) no longer steal keyboard focus; defaults preserve all
user-flow autofocus."
```

### Task 3: Harden screenshot `restoreFocus` against mid-capture deletions

**Files:**
- Modify: `src/lib/ui-screenshot.ts` (`FocusSnapshot` type :38-41; `restoreFocus` :293-320; `nodeContainsPane` helper already at :280-284)
- Test: `test/unit/client/ui-screenshot.test.ts` (existing file, 421 lines; reducers + `configureStore` already imported at :6-16; append a new describe)

**Interfaces:**
- Consumes: nothing from Tasks 1-2 (independent hardening).
- Produces: `restoreFocus` becomes exported (directly unit-testable) and
  `FocusSnapshot` becomes an exported type. Visible behavior change: a capture
  whose original focus target was deleted mid-capture now reports
  `restoredFocus:false` instead of resurrecting the dead id into Redux state.

- [ ] **Step 1: Write the failing tests**

Add imports to `test/unit/client/ui-screenshot.test.ts` (the file already
imports `tabsReducer`, `panesReducer`, `configureStore`):

```ts
import { captureUiScreenshot, restoreFocus } from '../../../src/lib/ui-screenshot'
import { setActiveTab, removeTab } from '@/store/tabsSlice'
import { splitPane, closePane } from '@/store/panesSlice'
```

(replace the existing single-name `captureUiScreenshot` import). Append this describe:

```ts
describe('restoreFocus deleted-target hardening', () => {
  function createFocusStore() {
    return configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
      middleware: (getDefault) => getDefault({ serializableCheck: false }),
      preloadedState: {
        tabs: {
          tabs: [
            { id: 'tab-1', createRequestId: 'req-1', title: 'One', status: 'running' as const, mode: 'shell' as const, shell: 'system' as const, createdAt: 1 },
            { id: 'tab-2', createRequestId: 'req-2', title: 'Two', status: 'running' as const, mode: 'shell' as const, shell: 'system' as const, createdAt: 2 },
          ],
          activeTabId: 'tab-1',
          renameRequestTabId: null,
        },
        panes: {
          layouts: {
            'tab-1': { type: 'leaf' as const, id: 'pane-1', content: { kind: 'terminal' as const, mode: 'shell' as const, status: 'running' as const, terminalId: 'term-1' } },
            'tab-2': { type: 'leaf' as const, id: 'pane-2', content: { kind: 'terminal' as const, mode: 'shell' as const, status: 'running' as const, terminalId: 'term-2' } },
          },
          activePane: { 'tab-1': 'pane-1', 'tab-2': 'pane-2' },
          paneTitles: { 'tab-1': { 'pane-1': 'One' }, 'tab-2': { 'pane-2': 'Two' } },
          paneTitleSetByUser: {},
          renameRequestTabId: null,
          renameRequestPaneId: null,
          zoomedPane: {},
          refreshRequestsByPane: {},
        },
      } as any,
    })
  }

  it('restores a still-valid snapshot and reports success (pin)', async () => {
    const store = createFocusStore()
    store.dispatch(setActiveTab('tab-2')) // simulate the capture switching away
    const spy = vi.spyOn(store, 'dispatch')
    const ok = await restoreFocus(
      { dispatch: store.dispatch, getState: store.getState },
      { activeTabId: 'tab-1', activePaneByTab: {} },
      new Set(),
    )
    expect(ok).toBe(true)
    expect(store.getState().tabs.activeTabId).toBe('tab-1')
    expect(spy.mock.calls.map(([a]) => (a as any)?.type)).toContain('tabs/setActiveTab')
  })

  it('restores a still-valid pane focus and reports success (pin)', async () => {
    const store = createFocusStore()
    store.dispatch(splitPane({ tabId: 'tab-2', paneId: 'pane-2', direction: 'horizontal', newContent: { kind: 'terminal', mode: 'shell' }, newPaneId: 'pane-2b' }))
    // activePane['tab-2'] is now 'pane-2b' (splits activate by default);
    // the snapshot says pane-2 owned focus.
    const ok = await restoreFocus(
      { dispatch: store.dispatch, getState: store.getState },
      { activeTabId: 'tab-1', activePaneByTab: { 'tab-2': 'pane-2' } },
      new Set(['tab-2']),
    )
    expect(ok).toBe(true)
    expect(store.getState().panes.activePane['tab-2']).toBe('pane-2')
  })

  it('never dispatches setActiveTab for a tab deleted mid-capture (reports false)', async () => {
    const store = createFocusStore()
    store.dispatch(setActiveTab('tab-2'))
    store.dispatch(removeTab('tab-1'))
    const spy = vi.spyOn(store, 'dispatch') // spy AFTER setup: only restore dispatches are observed
    const ok = await restoreFocus(
      { dispatch: store.dispatch, getState: store.getState },
      { activeTabId: 'tab-1', activePaneByTab: {} },
      new Set(),
    )
    expect(ok).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('never dispatches setActivePane for a pane deleted mid-capture (reports false)', async () => {
    const store = createFocusStore()
    store.dispatch(closePane({ tabId: 'tab-2', paneId: 'pane-2' }))
    const spy = vi.spyOn(store, 'dispatch')
    const ok = await restoreFocus(
      { dispatch: store.dispatch, getState: store.getState },
      { activeTabId: 'tab-1', activePaneByTab: { 'tab-2': 'pane-2' } },
      new Set(['tab-2']),
    )
    expect(ok).toBe(false)
    const setPaneCalls = spy.mock.calls.filter(([a]) => (a as any)?.type === 'panes/setActivePane')
    expect(setPaneCalls).toHaveLength(0)
  })
})
```

(vi, describe, it, expect are already imported at the top of the file.)

- [ ] **Step 2: Run the tests and verify the intended failures**

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run test:vitest -- run test/unit/client/ui-screenshot.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL, exactly —
- tab-deleted test: today `restoreFocus` dispatches `tabs/setActiveTab` into the dead id (spy records it) and returns truthy.
- pane-deleted test: today `restoreFocus` either dispatches `panes/setActivePane` toward the dead pane (spy records it) or returns `true` (if `closePane` left a stale `activePane` entry). At least one assertion must fail — both failure shapes are the bug.
Expected PASS already (pins): the two restore-success pin tests prove current behavior for live targets.

- [ ] **Step 3: Add the minimal production implementation**

In `src/lib/ui-screenshot.ts`, export the snapshot type and replace `restoreFocus` (currently :293-320):

```ts
export type FocusSnapshot = {
  activeTabId: string | null
  activePaneByTab: Record<string, string>
}
```

```ts
export async function restoreFocus(ctx: RuntimeContext, before: FocusSnapshot, paneTabsToRestore: Set<string>): Promise<boolean> {
  try {
    for (const tabId of paneTabsToRestore) {
      const originalPaneId = before.activePaneByTab[tabId]
      if (!originalPaneId) continue
      const state = ctx.getState()
      // A pane/tab deleted mid-capture can never receive focus back:
      // dispatching the restore would resurrect a dead activePane entry and
      // blank the tab's work area. A capture whose focus target vanished
      // cannot honestly report restoredFocus — return false instead.
      if (!state.tabs.tabs.some((t) => t.id === tabId)) return false
      if (!nodeContainsPane(state.panes.layouts[tabId], originalPaneId)) return false
      if (state.panes.activePane[tabId] !== originalPaneId) {
        ctx.dispatch(setActivePane({ tabId, paneId: originalPaneId }))
      }
    }

    if (before.activeTabId) {
      const state = ctx.getState()
      if (!state.tabs.tabs.some((t) => t.id === before.activeTabId)) return false
      if (state.tabs.activeTabId !== before.activeTabId) {
        ctx.dispatch(setActiveTab(before.activeTabId))
      }
    }

    await afterPaint()

    const after = ctx.getState()
    if (before.activeTabId && after.tabs.activeTabId !== before.activeTabId) return false
    for (const tabId of paneTabsToRestore) {
      const originalPaneId = before.activePaneByTab[tabId]
      if (!originalPaneId) continue
      if (after.panes.activePane[tabId] !== originalPaneId) return false
    }
    return true
  } catch {
    return false
  }
}
```

(Delete the now-duplicated unexported `type FocusSnapshot` declaration; the exported one replaces it. `snapshotFocus`'s return type is already `FocusSnapshot` — no change needed there.)

- [ ] **Step 4: Run the focused test**

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run test:vitest -- run test/unit/client/ui-screenshot.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

No extraction: the existence checks are 2 lines each with distinct guards;
a shared `exists(...)` predicate would earn nothing. Keep inline.

- [ ] **Step 6: Impacted-test verification**

Consumers of `ui-screenshot.ts`: only `src/lib/ui-commands.ts` (screenshot.capture
arm) — covered by `ui-commands.test.ts`. The export additions are additive;
`captureUiScreenshot` behavior for live targets is pinned.

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run typecheck`
Expected: PASS.

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run test:vitest -- run test/unit/client/ui-screenshot.test.ts test/unit/client/ui-commands.test.ts --config config/vitest/vitest.config.ts`
Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add src/lib/ui-screenshot.ts test/unit/client/ui-screenshot.test.ts
git commit -m "fix(client): screenshot restoreFocus never resurrects deleted tabs/panes

restoreFocus now verifies snapshot targets still exist (tab present, pane in
layout via nodeContainsPane) before dispatching setActivePane/setActiveTab,
and reports restoredFocus:false when a target vanished mid-capture instead of
reviving a dead id that would blank the work area. restoreFocus +
FocusSnapshot exported for direct unit tests."
```

### Task 4: E2E — MCP/REST focus-neutrality spec + registration

**Files:**
- Test (create): `test/e2e-browser/specs/mcp-focus-neutrality-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (rust-chromium `testMatch` list, :353-383)

**Interfaces:**
- Consumes: Task 1 (the Redux-level behavior the spec asserts) and Task 2
  (the DOM-focus assertions). Helpers copied per this suite's
  per-spec-ownership convention (see header comment in
  `hidden-pane-rebind-rust.spec.ts:26-27`).
- Produces: e2e coverage of the user story end-to-end: REST-driven
  creates/splits leave the user's focus untouched client-side (Redux +
  `document.activeElement`), and the explicit select routes still move focus.

- [ ] **Step 1: Write the failing behavioral test**

Create `test/e2e-browser/specs/mcp-focus-neutrality-rust.spec.ts`:

```ts
/**
 * MCP/REST FOCUS NEUTRALITY -- e2e proof that agent-surface mutations never
 * steal the user's focus. REST-driven POST /api/tabs and POST
 * /api/panes/:id/split must leave the client's active tab, per-tab active
 * pane, and document.activeElement untouched; the explicit routes
 * POST /api/tabs/:id/select and POST /api/panes/:id/select remain the only
 * agent-surface focus moves.
 *
 * Rust-only: registered in the rust-chromium project only, matching its donor
 * (hidden-pane-rebind-rust.spec.ts) — the helpers boot an owned RustServer on
 * an ephemeral port. Helpers are COPIED from hidden-pane-rebind-rust.spec.ts,
 * not imported, per this suite's per-spec-ownership convention.
 */
import { test, expect } from '../helpers/fixtures.js'
import { RustServer, type TestServerInfo } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import type { Page } from '@playwright/test'
import os from 'node:os'

/** Dismiss the initial pane-type picker by choosing the first visible shell. */
async function selectShellIfPickerShowing(page: Page): Promise<void> {
  const picker = page.getByRole('toolbar', { name: /pane type picker/i }).last()
  if (!(await picker.isVisible().catch(() => false))) return
  for (const name of ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']) {
    const option = picker.getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
    if (await option.isVisible().catch(() => false)) {
      await option.click({ force: true })
      return
    }
  }
}

/** Boot an owned RustServer, navigate, and wait for harness + WS. */
async function bootWall(page: Page): Promise<{ server: RustServer; info: TestServerInfo; harness: TestHarness }> {
  const server = new RustServer({})
  const info = await server.start()
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  return { server, info, harness }
}

function restApiHeaders(info: TestServerInfo): Record<string, string> {
  return { 'x-auth-token': info.token, 'content-type': 'application/json' }
}

/** POST /api/tabs; returns the created tabId (envelope is {status,data}). */
async function createTabViaRest(info: TestServerInfo, body: object): Promise<string> {
  const res = await fetch(`${info.baseUrl}/api/tabs`, {
    method: 'POST',
    headers: restApiHeaders(info),
    body: JSON.stringify(body),
  })
  const payload = await res.json()
  expect(res.ok, `POST /api/tabs: ${JSON.stringify(payload)}`).toBe(true)
  const tabId = payload?.data?.tabId
  expect(tabId, 'POST /api/tabs envelope data.tabId').toBeTruthy()
  return tabId as string
}

/** Pane id currently holding document.activeElement (null when focus is outside panes). */
async function focusedPaneId(page: Page): Promise<string | null> {
  return page.evaluate(
    () => document.activeElement?.closest('[data-pane-id]')?.getAttribute('data-pane-id') ?? null,
  )
}

test.describe('MCP/REST focus neutrality', () => {
  test.setTimeout(120_000)

  test('REST create/split never steal focus; explicit select routes do', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const { server, harness, info } = await bootWall(page)
    try {
      await selectShellIfPickerShowing(page)
      const tabA = (await harness.getActiveTabId())!
      expect(tabA).toBeTruthy()

      // --- 1: REST tab create does NOT activate (the discriminating assertion:
      // on unfixed code activeTabId flips to the new tab atomically with the
      // fold, and waitForTabCount(2) proves the fold already ran).
      const tabB = await createTabViaRest(info, { mode: 'shell', cwd: os.tmpdir() })
      await harness.waitForTabCount(2)
      expect(await harness.getActiveTabId()).toBe(tabA)

      // DOM focus must not land in the background tab either (the new tab's
      // pane stays mounted-but-hidden; TerminalView/picker effects must not
      // have run .focus()).
      const stateAfterB = await harness.getState()
      const paneB = stateAfterB.panes.layouts[tabB]?.id
      expect(paneB).toBeTruthy()
      expect(await focusedPaneId(page)).not.toBe(paneB)

      // --- 2: explicit REST tab.select activates.
      const selRes = await fetch(`${info.baseUrl}/api/tabs/${tabB}/select`, {
        method: 'POST', headers: restApiHeaders(info), body: '{}',
      })
      expect(selRes.ok).toBe(true)
      await expect.poll(() => harness.getActiveTabId(), { timeout: 10_000 }).toBe(tabB)

      // --- 3: another REST create still does not activate.
      await createTabViaRest(info, { mode: 'shell', cwd: os.tmpdir() })
      await harness.waitForTabCount(3)
      expect(await harness.getActiveTabId()).toBe(tabB)

      // --- 4: REST pane.split does not change tab B's active pane.
      const originalActivePane = (await harness.getState()).panes.activePane[tabB]
      expect(originalActivePane).toBeTruthy()
      const splitRes = await fetch(`${info.baseUrl}/api/panes/${originalActivePane}/split`, {
        method: 'POST',
        headers: restApiHeaders(info),
        body: JSON.stringify({ direction: 'horizontal', mode: 'shell' }),
      })
      const splitPayload = await splitRes.json()
      expect(splitRes.ok, `POST /api/panes/:id/split: ${JSON.stringify(splitPayload)}`).toBe(true)
      await expect
        .poll(async () => (await harness.getState()).panes.layouts[tabB]?.type, { timeout: 10_000 })
        .toBe('split')
      expect((await harness.getState()).panes.activePane[tabB]).toBe(originalActivePane)

      // ... nor steal DOM focus (the new pane mounts visible but non-active in
      // the now-active tab B).
      const newPaneId = (await harness.getState()).panes.layouts[tabB].children[1].id
      expect(await focusedPaneId(page)).not.toBe(newPaneId)

      // --- 5: explicit REST pane.select activates the new pane (and keeps tab B active).
      const paneSelRes = await fetch(`${info.baseUrl}/api/panes/${newPaneId}/select`, {
        method: 'POST', headers: restApiHeaders(info), body: '{}',
      })
      expect(paneSelRes.ok).toBe(true)
      await expect
        .poll(async () => (await harness.getState()).panes.activePane[tabB], { timeout: 10_000 })
        .toBe(newPaneId)
      expect(await harness.getActiveTabId()).toBe(tabB)
    } finally {
      await server.stop()
    }
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run (this task is NOT written RED against the unfixed base — Task 1 has already
landed its Redux behavior; treat this as a protective spec): `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium mcp-focus-neutrality-rust`

Expected: PASS on the Task-1+2 tree. (Sanity: `git stash` of Task 1's
`ui-commands.ts` change must flip section 1's `toBe(tabA)` assertion to a
failure — verify by reading the code path, no re-run on unfixed base required:
`addTab` activates unconditionally BEFORE Task 1's gate.)

- [ ] **Step 3: Add registration (no production code)**

In `test/e2e-browser/playwright.config.ts`, rust-chromium `testMatch` (:353-383), append after the mcp-qa-smoke entry:

```ts
        // MCP/REST focus neutrality: agent-surface creates/splits must not
        // change client focus (Redux active tab/pane nor DOM focus); only the
        // explicit select routes may. Rust-only by convention (owned-wall
        // harness, same as hidden-pane-rebind-rust).
        /mcp-focus-neutrality-rust\.spec\.ts$/,
```

Cloud legality: the spec uses ONLY shell-mode terminals — no external CLIs —
so it must NOT be added to `CLOUD_SKIP_SPECS` in
`test/e2e-browser/playwright.cloud.config.ts`. Verify it is absent
(grep for `mcp-focus-neutrality` in that file; expect no matches).

- [ ] **Step 4: Run the focused tests**

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium mcp-focus-neutrality-rust hidden-pane-rebind-rust`
Expected: PASS for both specs (new coverage green; repaired spec still green).

- [ ] **Step 5: Refactor while green**

No shared helper extraction: this suite deliberately copies helpers per-spec
(per-spec-ownership convention) so one spec's helper drift can't break
another. Keep as-is.

- [ ] **Step 6: Impacted-test verification**

Task 4 adds a spec and a testMatch entry only — no runtime code. The impacted
set is the two rust specs just run plus a typecheck of the config file.

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/mcp-focus-neutrality-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): MCP/REST focus-neutrality coverage (rust)

New rust-only spec proves REST tab create + pane split leave the client's
active tab, per-tab active pane, and document.activeElement untouched, while
the explicit tab/pane select routes still move focus. Registered in
rust-chromium testMatch (cloud-legal: shell-mode only, not in
CLOUD_SKIP_SPECS)."
```

### Task 5: Documentation — MCP tool text, orchestration skill, parity addendum, AGENTS.md

**Files:**
- Modify: `server/mcp/freshell-tool.ts` (TOOL/INSTRUCTIONS/HELP_TEXT — this text ships to every MCP agent)
- Modify: `.agents/skills/freshell-orchestration/SKILL.md`
- Modify: `docs/plans/2026-07-18-agent-api-mcp-parity-spec.md` (dated addendum after the fold table at :106-119 — do NOT rewrite its history)
- Modify: `AGENTS.md` (root; mandatory repo convention for behavior changes)
- NOT modified: `docs/index.html` — the behavior difference is invisible in a static mock (no user-visible chrome changes).

**Interfaces:**
- Consumes: behavior shipped by Tasks 1-4.
- Produces: agent-facing documentation matching the new contract, so MCP
  agents learn "creates are focus-neutral; select explicitly to move focus".

- [ ] **Step 1: Write the verification test**

Text-only + comment edits are doc changes; per the development philosophy,
trivial doc changes need no RED cycle — but the MCP tool text is executable
surface area, so its existing unit suite is the gate (see Step 4).

- [ ] **Step 2: Run the test and verify the current pass**

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run test:vitest -- run test/unit/server/mcp/freshell-tool.test.ts --config config/vitest/vitest.config.ts`
Expected: PASS (baseline before edits).

- [ ] **Step 3: Make the documentation edits**

`server/mcp/freshell-tool.ts` — add this bullet to the `KEY GOTCHAS` section of TOOL/INSTRUCTIONS (and mirror a one-liner into HELP_TEXT near `select-tab`):

```
**Focus neutrality:** new-tab, split-pane, and every pane/tab creation are focus-neutral — they never change which tab or pane the user is looking at. Use select-tab / select-pane when you explicitly intend to move the user's focus. send-keys, capture-pane, and wait-for all target panes without moving focus.
```

`.agents/skills/freshell-orchestration/SKILL.md` — add a short section (near the tab/pane focus documentation):

```
## Focus neutrality

All creation commands (new-tab, split-pane, MCP/REST creates) are focus-neutral: they never move the user's active tab or active pane, and background-created panes never steal DOM focus. Focus moves ONLY via explicit select-tab / select-pane (REST: POST /api/tabs/:id/select, POST /api/panes/:id/select). When scripting multi-pane work, select explicitly before measuring focus-dependent behavior.
```

`docs/plans/2026-07-18-agent-api-mcp-parity-spec.md` — insert after the fold table (:106-119):

```
### Addendum 2026-08-25 — focus neutrality

The fold table above describes the original behavior, where ui.command
tab.create/pane.split ACTIVATED the new tab/pane on every client. As of
2026-08-25 the create/split folds are focus-neutral: handleUiCommand passes
activate:false into addTab/splitPane, so they never change the user's active
tab or per-tab active pane (bootstrap exception: the client's very first tab
still activates). Focus changes remain exclusive to the explicit verbs
(tab.select, pane.select, tabs.next/prev). Screenshot capture still moves and
auto-restores focus, and now reports restoredFocus:false when a snapshot
target was deleted mid-capture instead of resurrecting dead ids. See
docs/plans/2026-08-25-mcp-focus-neutrality.md.
```

`AGENTS.md` (root) — append one sentence to the **Fresh-Agent Orchestration** paragraph:

```
Agent-driven tab/pane creation is focus-neutral by contract: server-broadcast ui.command create/split folds carry activate:false into addTab/splitPane and never change the user's active tab/pane — focus moves only via the explicit select-tab/select-pane verbs.
```

- [ ] **Step 4: Run the focused tests**

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run typecheck`
Expected: PASS (`freshell-tool.ts` is TypeScript — string edits typecheck trivially).

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run test:vitest -- run test/unit/server/mcp/freshell-tool.test.ts --config config/vitest/vitest.config.ts`
Expected: PASS (suite exercises tool actions/params, not the doc strings).

Run: `env -u FRESHELL_BIND_HOST -u FRESHELL_PANE_ID -u FRESHELL_TAB_ID -u FRESHELL_TERMINAL_ID -u FRESHELL_TOKEN -u FRESHELL_URL npm run lint`
Expected: PASS (a11y lint is CI-required before merge; unrelated to the doc edits but cheap to confirm).

- [ ] **Step 5: Refactor while green**

N/A — documentation only.

- [ ] **Step 6: Impacted-test verification**

Doc-only task; the typecheck + mcp tool suite above is the complete impacted set.

- [ ] **Step 7: Commit the task**

```bash
git add server/mcp/freshell-tool.ts .agents/skills/freshell-orchestration/SKILL.md docs/plans/2026-07-18-agent-api-mcp-parity-spec.md AGENTS.md
git commit -m "docs: document agent focus neutrality (MCP tool, orchestration skill, parity addendum, AGENTS)"
```

## Out of scope (recorded, not fixed here)

- **Server-side layout mirrors self-activate on create/split**
  (`server/…/layout-store` and `crates/freshell-…/layout_store.rs:446-465`):
  these feed only agent target resolution / `GET /api/tabs` snapshots, never
  the user's client focus. Unchanged by design.
- **tab.close/pane.close neighbor focus fallback** — picking a sibling on
  deletion is inherent to the deleted target disappearing. Unchanged.
- **Rust screenshot.capture broadcasts `ui.screenshot` to ALL clients while
  Node targets the requesting socket** (`crates/freshell-ws/src/screenshot.rs:159-185`)
  — pre-existing divergence, recorded as a known issue.
- **Node `broadcast()` sends ui.command frames to unauthenticated sockets too**
  (`server/ws-handler.ts:3879-3885`) — pre-existing surface note, recorded.
- **`test/unit/vite-config.test.ts` env fragility** — the suite inherits
  `FRESHELL_BIND_HOST` from a live Freshell pane; mitigated run-side by the
  mandatory env-sanitize prefix in Global Constraints, not by code here.

<!-- PLAN-END -->
