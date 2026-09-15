# Pane Title Recovery (Choice B) Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Implement the user-selected product behavior (Choice B — window sovereignty) plus both approved upgrades and the approved title-loss repairs, via the the-usual workflow:
1. Local-first boot: on refresh, a window keeps its own local persisted layout whenever it is healthy; the server-side rebuild runs only when the local persisted layout is absent, corrupted, stale, or from a different machine.
2. Upgrade 1 — own-snapshot rebuild: when a rebuild does happen, the recovery inventory request includes the window's own last durable snapshot (reserved bootstrap exclusion-id prefix), and the rebuild preserves original tab/pane ids from the inventory records.
3. Upgrade 2 — cache health checks: the persisted layout envelope is stamped with the machine id, and the boot classifies the local layout as absent/corrupt/foreign/stale/healthy before deciding keep-vs-rebuild.
4. Level-based title delivery: fold terminal.inventory terminal titles into pane titles on every connection, and mirror session-directory session titles into open panes via sessionRef — always with setByUser:false so user-set pane titles keep precedence.
5. Hydrate recency guard: cross-window pane-title hydration applies incoming pane titles only when the incoming layout is strictly newer (layout persistedAt meta), mirroring the tabs winner pattern; user-set pane titles always survive.

### Explicit constraints
- Run via the the-usual workflow; the Stage 5 delta review cap is 15 rounds (user-approved) instead of the default 5.
- Item 3 of the original fix plan (multi-client union restore) is dropped: its premise was refuted on current main.
- Respect the rename scope contract (docs/development/rename-scope-contract.md): pane/tab renames stay layout-local; only explicit session renames (`PATCH /api/sessions/:key`) are durable; every server-derived title fold in this run uses setByUser:false and never writes terminal/session overrides.
- TDD red/green/refactor with unit and e2e coverage per repo rules; work happens in the dedicated worktree `the-usual/pane-title-recovery` at base `bab7d5189`; no merge, push, PR creation, deploy, or production restart without explicit user approval.
- The user's Choice B decision supersedes the parallel branch `fix/machine-reload-workspace-wipe`'s "recoverable inventory always replaces" gate. This run may reuse that branch's design ideas (its chooser-marker machinery) and the `bd4315881` rebuild recipe from `the-usual/retire-node-server-v2` (cherry-pick `-x` with attribution, or reimplement), but must not modify the parallel worktrees or branches.
- Files already over the 1000-line cap (`port/AGENTS.md:81`): App.tsx (2270), panesSlice.ts (2825), TerminalView.tsx (5798) — new logic goes in new modules; additions to over-cap files are limited to minimal wiring, and one extraction (Task 7) shrinks panesSlice.
- No Rust server changes are planned: every fix is client-side (the inventory route already accepts arbitrary exclusion-id strings). If a server change turns out to be necessary, stop and re-plan before making it.

### Accepted tradeoffs and residuals
- Choice B cost (accepted by the user): two windows on the same machine can keep divergent arrangements indefinitely; the machine's latest state reaches a window only when that window rebuilds. A chooser re-pick of the same machine keeps a healthy local layout.
- Staleness is layout-blob-granular: a local layout older than the stale threshold (this plan pins 7 days) rebuilds.
- The hydrate recency guard compares whole-blob persistedAt (no per-pane-title timestamps exist); same granularity as the tabs path's first tiebreak. Per-title recency remains a residual.
- Per-pane titles and user-set flags are still not forwarded through the recovery plan (original item 1, excluded): rebuilt panes rely on the runtime title folds (Tasks 5-6) and derived defaults.
- On a rebuild, split geometry still resets to the flat chain and the last restored tab activates (pre-existing rebuild behavior, unchanged in this run).

**Goal:** A Freshell window keeps its exact workspace — tabs, pane titles, splits, focused tab — across every refresh while its local state is healthy, and whenever a rebuild does happen it restores the best possible state: own last snapshot included, ids preserved, titles re-folded from live server data.

**Architecture:** A new pure health-classification module (`layout-health.ts`) reads the persisted layout envelope (now stamped with its machine id by the persist middleware) and classifies it absent/corrupt/foreign/stale/healthy. The boot path in `App.tsx` consults it: healthy keeps local state and skips the inventory fetch entirely; anything else rebuilds through `restoreMachineWorkspace`, which now (a) requests the inventory with a reserved `machine-bootstrap:` exclusion-id prefix so the window's own last snapshot is included, and (b) builds plans with `preserveIdsForMachine` so tab/pane ids survive. Two runtime title folds repair titles on any path: `terminal.inventory` rows fold terminal titles into panes on every connect, and a sessions middleware mirrors session-directory titles into panes by sessionRef — both through the existing `setByUser:false`-guarded actions. Cross-window hydration gains the tabs-style persistedAt recency guard, with the pane-metadata merge extracted to its own module.

**Tech Stack:** TypeScript client (React/Redux Toolkit, Vitest jsdom via `npm run test:vitest`), Playwright e2e (owned `RustServer` fixture, rust-chromium project, local + cloud lanes). No Rust source changes.

## Global Constraints

- **Focused client tests:** `npm run test:vitest -- run <paths>` (repo-owned passthrough; auto-routes client paths to the default jsdom config). Never raw `npx vitest`.
- **Type/lint gates:** `npm run typecheck` and `npm run lint` must pass before the full-suite gate (CI requirement; eslint jsx-a11y).
- **E2e registration:** every new rust-only spec (Task 4's `local-first-reload-rust.spec.ts` and Task 8's `pane-title-folds-rust.spec.ts`) must be added to BOTH `RUST_ONLY_SPECS` (~test/e2e-browser/playwright.config.ts:187) AND the `rust-chromium` project's `testMatch` (~:430-660). A spec registered in only one list is a known past-bug class. Run locally with `bash scripts/e2e-cloud.sh run --local --project=rust-chromium <spec-path>`; the new specs must be cloud-runnable (editor panes, a default-shell terminal pane, and store dispatches only — no external coding-CLI binaries, not added to `CLOUD_SKIP_SPECS`).
- **Cloud-lane env (non-login shells):** verify with `printenv` and export explicitly when unset: `FRESHELL_VITEST_BACKEND=cloud`, `FRESHELL_E2E_BACKEND=cloud`, `GCLOUD_IDENT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com`. Local lanes never need GCP identity.
- **Full-suite gate:** coordinated `npm test` (waits on the shared coordinator; check `npm run test:status` first, never kill a foreign holder). Set `FRESHELL_TEST_SUMMARY="pane-title-recovery end-of-execution gate"`.
- **1000-line cap:** new logic in new modules (`src/lib/recovery/layout-health.ts`, `src/lib/terminal-inventory-titles.ts`, `src/store/sessionTitleMirror.ts`, `src/store/hydrate-pane-metadata-merge.ts`); over-cap files receive wiring-only edits.
- **No Docker test sandbox needed:** all tests use jsdom/localStorage or the owned `RustServer` Playwright fixture (process-safe by construction).
- **E2e fresh-context boot rule:** a fresh browser context against a server with existing machines boots into the machine chooser (known pre-existing `recover-my-panes-rust.spec.ts` scenario-1 hang; receipt at `.worktrees/.the-usual-logs/machine-reload-wipe-fix/recover-my-panes-preexisting-receipt.md`). New specs use an owned `RustServer` with a fresh `FRESHELL_HOME` (auto-creates the machine, no chooser) and never rely on that pre-existing spec passing.
- **Rename scope contract:** all new title writes flow through `updatePaneTitle`-family actions with `setByUser: false`; no fetch/PATCH to sessions/terminals from any new code path.
- **Conventional focused commits** per task; never commit unrelated files.

## Verified ground truth

All facts below were verified against the worktree at `bab7d5189` by five explorer reports under `/home/dan/code/freshell/.worktrees/.the-usual-logs/pane-title-recovery/reports/` — `plan-boot-restore.md` (boot/restore/persist map, in-flight branch diffs), `plan-title-pipelines.md` (title lifecycle), `plan-inventory-union.md` (item-3 refutation, rebuild-route facts), `plan-test-infra.md` (test patterns), `workspace-baseline.md` (commands/env/readiness). Key facts the tasks depend on:

> **Delta round 3 remediation (post-review):** the layout envelope is no
> longer the origin-wide `freshell.layout.v3` key. It is now PER WINDOW —
> `freshell.layout.v3.<layoutWindowId>` (a DEDICATED sessionStorage id,
> `freshell.layout-window-id.v1`, separate from the tab-registry client
> id), with one-time LEGACY adoption
> (`storage-migration.ts` copies the bare legacy key byte-identically into
> a window's derived key on its first post-change boot and NEVER deletes
> the legacy key), per-window `.bak` / fresh-agent-centralization /
> pre-migration-evidence side channels, an install-time staleness hydrate
> in `installCrossTabSync`, and terminal-content lifecycle invariants
> (non-empty envelope-wide-unique createRequestId, TerminalStatus-union
> status, non-empty mode) in the health classifier. Where the sketches
> below say `LAYOUT_STORAGE_KEY` / `freshell.layout.v3`, read the window's
> per-window key (`src/store/window-layout-keys.ts`).

- `restoreMachineWorkspace` (src/lib/machine-workspace.ts:47-77) is called unconditionally by `resolveMachineBeforeTransport` (src/App.tsx:805-863, call at :831) and always dispatches `clearTabsForMachine` + `clearPanesForMachine` + `clearTabRegistryLocalClosed` before rebuilding from `buildRecoveryPlan` — whose `paneTitles` is always `{}` (build-recovery-plan.ts:359).
- The persisted envelope — the window's per-window key `freshell.layout.v3.<layoutWindowId>` (version 4; delta round 3, previously the origin-wide `freshell.layout.v3`) — is written by `persistMiddleware.flush()` (persistMiddleware.ts:630-639) with a top-level `persistedAt`; `parsePersistedLayoutRaw` (persistedState.ts:525-558) is passthrough-tolerant but reconstructs a fixed shape, so a new `machineId` field must be surfaced explicitly. `clearTabsForMachine` sets `userClosedTabsIntent=true` (persistMiddleware.ts:739-747) making an empty restore destructively overwrite the cache.
- Slices rehydrate from localStorage at module eval, BEFORE the App effect — so the health classification reads the same envelope the slices just rehydrated.
- `updatePaneTitleByTerminalId` and `updatePaneTitleBySessionRef` already exist (panesSlice.ts:2212/2242) with the `setByUser:false` user-set guard; `terminal.inventory` is sent on every connection (crates/freshell-ws/src/lib.rs:614-622) with rows carrying `title` (server_messages.rs:1125), and the sole client handler (App.tsx:1419-1470) ignores it.
- Session-directory rows (`SessionDirectoryItem`, shared/read-models.ts:51-86) carry `sessionId`, `provider`, `title?` and arrive via `/api/session-directory` fetches triggered by `sessions.changed` broadcasts; the sessions slice normalizes them under `state.sessions.windows[surface].projects` (sessionsSlice.ts:66-96).
- `mergeHydratedPaneMetadata` (panesSlice.ts:578-648, module-private, dispatched only by `hydratePanes`) lets an incoming non-user-set title overwrite a newer local one whenever the incoming layout wins; the `HydratePanesMeta` timestamps (`localLayoutPersistedAt`/`remoteLayoutPersistedAt`, panesSlice.ts:37-40) are already dispatched by crossTabSync.ts:213-218 but unused there. Tabs solve this with `pickHydratedTabWinner` (tabsSlice.ts:115-128) + `reconcileHydratedTabTitle` (:137-142).
- The boot flow renders the chooser while `machineIdentity.status !== 'ready'`; the chooser handlers (App.tsx:550-566) persist the selection then `window.location.reload()`. plan-boot-restore.md §7A maps the parallel branch's one-shot chooser-signal design; this run deliberately does NOT adopt it — the round-3 simplified foreign rule (an unstamped envelope is legacy data assumed local and can never classify foreign) removes the need for any active-pick signal, and Task 2's stamp backfill makes unstamped a one-boot transitional state. §7A remains background only. The `bd4315881` rebuild recipe (`machine-bootstrap:` exclusion prefix + `preserveIdsForMachine`) is mapped in §7B — client-side only, no Rust changes.
- The recover-my-panes e2e donor idioms (owned `RustServer`, generation-file fs-polls, harness dispatch seam `window.__FRESHELL_TEST_HARNESS__`) are mapped in plan-test-infra.md §5-6.

---

## Load-bearing corrections (Stage 2 — the executor must honor these)

Evidence: `reports/load-bearing-finder.md` (LB-IDs) in the run's logs dir. These corrections amend the task sketches; where a sketch and this section disagree, this section wins.

1. **LB-05 (HIGH — silent trap, fix INSIDE Task 1):** `src/store/storage-migration.ts` `migratePersistedLayout()` (~:386-430) rewrites `freshell.layout.v3` on essentially every boot (each flush removes the fresh-agent commit marker at persistMiddleware.ts:641-645, so the preserve-guard at storage-migration.ts:432-437 always fails) using a FIXED top-level literal that drops unknown fields — it would strip Task 1's `machineId` stamp BEFORE the classifier reads it, making upgrade 2 silently non-functional and the accepted tradeoff (same-machine re-pick keeps a healthy layout) false. Task 1 MUST also modify `storage-migration.ts` to carry the top-level `machineId` through the migration payload (a string on the parsed raw — the same treatment `persistedAt` gets) and add a pin that a flushed stamped envelope survives `runStorageMigration()` (extend `test/unit/client/store/storage-migration.test.ts` — the exact existing filename, verified in this worktree).
2. **LB-04:** the machineIdentity slice field is `selectedMachine` (`machineIdentitySlice.ts:7-14`) — Task 1's `selectStampMachineId` reads `state.machineIdentity.selectedMachine.id` (set by `setMachineRestoring` BEFORE the classification runs).
3. **LB-02 (residual, documented):** with two windows where the rebuilding one sat idle >15 min, the A15 fence drops its own generations; the bootstrap rebuild then restores the sibling's newer snapshot (same machine). That is the accepted multi-window tradeoff, not a regression.
4. **LB-06:** `fetchSessionWindow` is a hand-rolled thunk — there is NO `sessions/fetchSessionWindow/fulfilled` action. Task 6's red test must land rows via the REAL commit action: `sessions/commitSessionWindowVisibleRefresh` (payload `{ surface, projects, ... }` per sessionsThunks.ts:610-629) or `sessions/setProjects`. All session mutations are `sessions/`-prefixed (sessionsSlice.ts:321-322), so the middleware trigger design is sound.
5. **LB-07:** Task 4's sketch corrected to the real APIs: the owned server is `new RustServer(options)` + `await server.start()` (rust-server.ts:319/:337 — there is NO `RustServerHandle.spawn`); `connect` and the generation-file fs-poll `(clientInstanceId, minRecords, timeoutMs)` over `path.join(info.homeDir, '.freshell', 'tabs-snapshots')` are donor-spec-local (recover-my-panes-rust.spec.ts:210-211, :452-494) — copy them into the new spec; read the page's clientInstanceId from `sessionStorage['freshell.tabs.client-instance-id.v1']`; `ensureRustServerBuilt` is synchronous.
6. **LB-08 (coverage-critical):** Task 4 must NOT clear sessionStorage via `addInitScript` — an init script (even a once-guarded `sessionStorage.clear()`) cannot survive a reload (each reload is a new document/window, so the guard resets and the clear runs on EVERY load), minting a fresh clientInstanceId each time, which would let Scenario 2 pass even if the `machine-bootstrap:` prefix regressed (false green). Resolution: NO `addInitScript` at all in Task 4's scenarios — a fresh Playwright context starts with EMPTY storage, so there is nothing to clear, and the natural reload then preserves the clientInstanceId, making the prefix load-bearing for the spec's outcome. (Task 7's Scenario 3 later adds ONE deliberate, SEEDING init script to that spec — it writes the captured machine-selection localStorage keys and never touches sessionStorage/clientInstanceId; see the Task 7 Step 6 note for why that seeding kind is exempt from this rule.)
7. **LB-11:** Task 4 Step 5's first verification command needs `--project=chromium` (without it, `--list` enumerates all projects and the grep count can never be 0).
8. **LB-16:** the root store setup is `src/store/store.ts` (configureStore :51; middleware chain :85-102) — Task 6 modifies and commits THAT file, not `src/store/index.ts`.
9. **LB-17 (real helper names for the test sketches):** `App.machine-identity.test.tsx` has NO `renderAppWithMachineApi`/`waitForMachineReady`/`exposeChooserHandlers` — its real style is a module-level `createStore()` + `render(<App .../>)` + `waitFor(...)` against the `mocks.restoreMachineWorkspace`/`mocks.startTabRegistrySync` refs (:49-51, :114-224), and `MachineChooser` is NOT mocked (drive the real dialog); the existing pin at :222-224 is the one Task 2 updates. `machine-workspace.test.ts`'s real helpers: `createStore()`, `inventoryFor(machineId)`, `addForeignWorkspace(store)` (assert via the imported, mocked `getRecoveryInventory`). `build-recovery-plan.test.ts`'s real builders: `inv(panes, ledgerOnly?)` (:11), `pane(over?)` (:7), `leavesOf(node)` (:17).
10. **LB-14 (watch-item):** the new specs' persistence polls are content-based and bounded like the donor's fs-polls (not cloud-skipped); watch the mandated cloud-lane runs for `rest-tab-persistence`-class timing sensitivity and prefer generous bounded timeouts.

---

### Task 1: Persisted-layout machine-id stamp + health classification module

**Files:**
- Create: `src/lib/recovery/layout-health.ts`
- Create: `test/unit/client/lib/recovery/layout-health.test.ts`
- Modify: `src/store/persistMiddleware.ts:630-639` (stamp write in `flush()`)
- Modify: `src/store/persistedState.ts:525-558` (`parsePersistedLayoutRaw` surfaces `machineId`)
- Modify: `src/store/storage-migration.ts:386-430` (`migratePersistedLayout` carries the top-level `machineId` through — LB-05, without this the stamp is stripped at every boot before the classifier reads it)
- Test: extend `test/unit/client/store/tabsPersistence.test.ts` (stamp round-trip pin)
- Test: extend `test/unit/client/store/storage-migration.test.ts` (a flushed stamped envelope survives `runStorageMigration()` — the LB-05 pin; exact filename verified in this worktree)

**Interfaces:**
- Consumes: the window's per-window layout key via `getWindowLayoutKey()` (`src/store/window-layout-keys.ts`, delta round 3 — previously `LAYOUT_STORAGE_KEY` from `src/store/storage-keys.ts`), `getSelectedMachineId()` (`src/lib/machine-identity.ts:89-100`), `parsePersistedLayoutRaw`, and `isWellFormedPaneTree` (`src/store/paneTreeValidation.ts:133` — the SAME well-formedness predicate the persist/load path uses; it is already exported from its own module, so panesSlice.ts needs no new export and must not grow).
- Produces (used by Task 2):
  - `export type PersistedLayoutHealth = 'absent' | 'corrupt' | 'foreign' | 'stale' | 'healthy'`
  - `export const STALE_LAYOUT_MS = 7 * 24 * 60 * 60 * 1000`
  - `export function classifyPersistedLayoutHealth(resolvedMachineId: string, opts?: { now?: number; storage?: Storage }): PersistedLayoutHealth`
  - `ParsedPersistedLayout` gains `machineId?: string`.

- [ ] **Step 1: Write the failing behavioral test**

Create `test/unit/client/lib/recovery/layout-health.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from 'vitest'
import { classifyPersistedLayoutHealth, STALE_LAYOUT_MS } from '@/lib/recovery/layout-health'
import { MACHINE_ID_STORAGE_KEY } from '@/store/storage-keys'

const NOW = 1_760_000_000_000

// Delta round 3 (e3r1 finding 3 correction): seed the window's per-window
// key — derived from the IMMUTABLE layout-window-id (sessionStorage
// freshell.layout-window-id.v1), NOT the tab-registry client id.
const WINDOW_ID = 'client-health-tests'
const LAYOUT_STORAGE_KEY = `freshell.layout.v3.${WINDOW_ID}`

function seedEnvelope(raw: unknown): void {
  sessionStorage.setItem('freshell.layout-window-id.v1', WINDOW_ID)
  localStorage.setItem(LAYOUT_STORAGE_KEY, typeof raw === 'string' ? raw : JSON.stringify(raw))
}

function healthyEnvelope(machineId: string, persistedAt = NOW): Record<string, unknown> {
  return {
    persistedAt,
    version: 4,
    machineId,
    tabs: { activeTabId: 'tab-a', tabs: [{ id: 'tab-a', title: 'A', createdAt: NOW, updatedAt: NOW }] },
    panes: {
      layouts: { 'tab-a': { type: 'leaf', id: 'pane-a', content: { kind: 'editor', filePath: '/tmp/a.md', language: null, readOnly: false, content: '', viewMode: 'source', wordWrap: true } } },
      activePane: { 'tab-a': 'pane-a' },
      paneTitles: { 'tab-a': { 'pane-a': 'A notes' } },
      paneTitleSetByUser: { 'tab-a': { 'pane-a': true } },
    },
    tombstones: [],
  }
}

describe('classifyPersistedLayoutHealth', () => {
  beforeEach(() => { localStorage.clear() })

  it('returns absent when no layout is persisted', () => {
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('absent')
  })

  it('returns absent when the envelope parses but holds zero tabs and zero panes', () => {
    seedEnvelope({ persistedAt: NOW, version: 4, tabs: { activeTabId: null, tabs: [] }, panes: { layouts: {}, activePane: {}, paneTitles: {}, paneTitleSetByUser: {} }, tombstones: [] })
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('absent')
  })

  it('returns corrupt when the stored envelope does not parse', () => {
    seedEnvelope('{ not json')
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('returns corrupt when any persisted layout tree is malformed (valid tab + broken pane tree)', () => {
    const envelope = healthyEnvelope('machine-1')
    envelope.panes = {
      ...(envelope.panes as Record<string, unknown>),
      layouts: { 'tab-a': {} },   // {} fails isWellFormedPaneTree — the loader drops it and rehydrates a default pane
    }
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('returns corrupt when parse-level salvage dropped an invalid tab (one valid tab + one invalid tab in the raw)', () => {
    const envelope = healthyEnvelope('machine-1')
    const tabsSection = envelope.tabs as { activeTabId: string; tabs: Array<Record<string, unknown>> }
    tabsSection.tabs = [
      ...tabsSection.tabs,
      { title: 'missing id' },   // fails zTab — salvageTabs drops it while the valid tab survives parsing
    ]
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('returns corrupt when a persisted tab has no matching layout entry (the loader reconstructs a default pane)', () => {
    const envelope = healthyEnvelope('machine-1')
    ;(envelope.panes as Record<string, unknown>).layouts = {}
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('returns corrupt when a layout entry names a nonexistent tab (the loader drops the orphaned layout)', () => {
    const envelope = healthyEnvelope('machine-1')
    const panes = envelope.panes as { layouts: Record<string, unknown> }
    panes.layouts['tab-ghost'] = { type: 'leaf', id: 'pane-ghost', content: { kind: 'editor', filePath: '/tmp/ghost.md', language: null, readOnly: false, content: '', viewMode: 'source', wordWrap: true } }
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('returns corrupt when a non-empty-tabs envelope has no valid activeTabId (the loader silently substitutes the first tab, tabsSlice.ts:260-265)', () => {
    const envelope = healthyEnvelope('machine-1')
    const tabsSection = envelope.tabs as { activeTabId: string | null }
    tabsSection.activeTabId = 'tab-does-not-exist'   // dangling: not among the parsed tab ids
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('returns corrupt when activePane names a pane that is not a leaf of that tab\u2019s layout (dangling focus)', () => {
    const envelope = healthyEnvelope('machine-1')
    const panes = envelope.panes as { activePane: Record<string, string> }
    panes.activePane['tab-a'] = 'pane-not-in-layout'
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('returns corrupt when a tab\u2019s activePane entry is missing entirely', () => {
    const envelope = healthyEnvelope('machine-1')
    const panes = envelope.panes as { activePane: Record<string, string> }
    delete panes.activePane['tab-a']
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('corrupt')
  })

  it('returns foreign when the stamp names a different machine', () => {
    seedEnvelope(healthyEnvelope('machine-OTHER'))
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('foreign')
  })

  it('returns healthy when the stamp matches and the layout is fresh', () => {
    seedEnvelope(healthyEnvelope('machine-1'))
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('healthy')
  })

  it('returns stale when persistedAt is older than STALE_LAYOUT_MS', () => {
    seedEnvelope(healthyEnvelope('machine-1', NOW - STALE_LAYOUT_MS - 1))
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('stale')
  })

  it('treats an unstamped (legacy) envelope as healthy — never foreign — so a same-machine chooser re-pick keeps the layout', () => {
    // The accepted tradeoff pinned as a test: the re-pick persists its
    // selection before the reload (App.tsx:557-560), so resolution sees
    // remembered == resolved; the envelope is unstamped legacy data assumed
    // local, classifies healthy, and the layout is KEPT (no rebuild).
    localStorage.setItem(MACHINE_ID_STORAGE_KEY, 'machine-1')
    const envelope = healthyEnvelope('machine-1')
    delete envelope.machineId
    seedEnvelope(envelope)
    expect(classifyPersistedLayoutHealth('machine-1', { now: NOW })).toBe('healthy')
  })
})
```

Also add a persist round-trip pin in `test/unit/client/store/tabsPersistence.test.ts`, following its existing fixture idioms: after a store action and a `flush()`, the raw `freshell.layout.v3` JSON contains `machineId` equal to the machine identity slice's current machine id (and `undefined`-absent when no machine is known and no selection is remembered — assert the field is omitted, not `null`).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/lib/recovery/layout-health.test.ts`

Expected: FAIL — the module `@/lib/recovery/layout-health` does not exist (import error), and no `machineId` field is written by `flush()`.

- [ ] **Step 3: Add the minimal production implementation**

In `src/store/persistedState.ts`, extend `parsePersistedLayoutRaw` (~:541-557) to read the envelope's top-level `machineId` when present (a string) and include it on the returned `ParsedPersistedLayout`. Old envelopes stay valid — they parse unstamped; do not add a schema rejection.

In `src/store/persistMiddleware.ts` `flush()` (~:630-639), add one field to `layoutPayload`:

```typescript
const layoutPayload = {
  persistedAt: Date.now(),
  version: LAYOUT_SCHEMA_VERSION,
  machineId: selectStampMachineId(state),   // NEW
  tabs: { /* unchanged */ },
  panes: persistablePanesSection,
  tombstones,
}
```

with a small module-local helper (fallback chain so pre-ready flushes still stamp):

```typescript
/** Machine id for the persisted-layout stamp: the resolved machine when
 * known, else the remembered selection (the same localStorage key the
 * chooser writes), else undefined (envelope stays unstamped). */
function selectStampMachineId(state: RootState): string | undefined {
  const known = (state as { machineIdentity?: { machine?: { id?: string } } })?.machineIdentity?.machine?.id
  if (typeof known === 'string' && known) return known
  try {
    return getSelectedMachineId() ?? undefined
  } catch {
    return undefined
  }
}
```

(Adjust the machineIdentity slice field names to the actual slice shape in `src/store/machineIdentitySlice.ts` — keep the fallback semantics exactly.)

Create `src/lib/recovery/layout-health.ts`:

```typescript
import { parsePersistedLayoutRaw, type ParsedPersistedLayout } from '@/store/persistedState'
import { isWellFormedPaneTree } from '@/store/paneTreeValidation'
import { LAYOUT_STORAGE_KEY } from '@/store/storage-keys'

/** A local layout older than this rebuilds from the server instead of being
 * kept. 7 days is far beyond any terminal lifetime (15-minute default idle
 * timeout), so it only triggers for genuinely abandoned layouts. */
export const STALE_LAYOUT_MS = 7 * 24 * 60 * 60 * 1000

export type PersistedLayoutHealth = 'absent' | 'corrupt' | 'foreign' | 'stale' | 'healthy'

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

/** Leaf pane ids of a (already well-formedness-checked) layout tree.
 * Module-local: paneTreeValidation.ts exports no leaf collector (only
 * hasPaneTreeShape :127, isWellFormedPaneTree :133, validatePaneTree :141),
 * and panesSlice's collectLeaves/collectLeafPaneIds are module-private. */
function collectLeafIdsOf(node: unknown, into: Set<string> = new Set()): Set<string> {
  const n = node as { type?: string; id?: string; children?: unknown[] } | null
  if (!n || typeof n !== 'object') return into
  if (n.type === 'leaf') {
    if (typeof n.id === 'string') into.add(n.id)
    return into
  }
  for (const child of n.children ?? []) collectLeafIdsOf(child, into)
  return into
}

/** Classify the persisted layout envelope for the machine this boot
 * resolved. Reads only localStorage; no network.
 *
 * - absent:   nothing usable is persisted.
 * - corrupt:  the envelope exists but does not parse, parse-level salvage
 *             dropped invalid tab rows, a layout tree is malformed,
 *             referential integrity is broken (a layout entry without its
 *             tab, or a tab without its layout entry), or an active
 *             reference is missing/dangling (activeTabId not a parsed tab
 *             while tabs are non-empty; activePane[tabId] absent or not a
 *             leaf of that tab's layout).
 * - foreign: IFF the envelope is STAMPED and the stamp names a different
 *            machine. An unstamped envelope is legacy (pre-stamp) data
 *            assumed local — it can NEVER classify foreign, so a
 *            same-machine chooser re-pick keeps a healthy unstamped
 *            layout; Task 2's stamp backfill makes unstamped a one-boot
 *            transitional state.
 *            Accepted migration residual: a pre-migration envelope that
 *            actually belonged to a different machine (an origin remap
 *            before the first boot of this code) is mis-kept for one boot
 *            under this rule; the backfill then stamps it with the
 *            resolved machine id, so every later boot classifies correctly.
 * - stale:   older than STALE_LAYOUT_MS.
 * - healthy: everything else — the window keeps its local layout. */
export function classifyPersistedLayoutHealth(
  resolvedMachineId: string,
  opts: { now?: number; storage?: Storage } = {},
): PersistedLayoutHealth {
  const storage = opts.storage ?? safeStorage()
  const now = opts.now ?? Date.now()
  let raw: string | null = null
  try {
    raw = storage?.getItem(LAYOUT_STORAGE_KEY) ?? null
  } catch {
    return 'absent'
  }
  if (raw === null) return 'absent'
  let parsed: ParsedPersistedLayout | null = null
  try {
    parsed = parsePersistedLayoutRaw(raw)
  } catch {
    parsed = null
  }
  if (!parsed) return 'corrupt'
  // A shallowly-parsed envelope whose layout trees fail the loader's
  // well-formedness predicate would rehydrate as DEFAULT panes (the load
  // path drops malformed trees), silently losing the saved layout — that is
  // a corrupt layout, not a healthy one. Same predicate the loader uses
  // (paneTreeValidation.ts). Bounded residual: pane CONTENT payload
  // sanitization (loaders replace invalid content with safe defaults) stays
  // out of scope — only tree well-formedness is classified here.
  for (const layout of Object.values(parsed.panes?.layouts ?? {})) {
    if (!isWellFormedPaneTree(layout)) return 'corrupt'
  }
  // Parse-level salvage drops rows SILENTLY (persistedState.ts salvageTabs
  // :88-102 — one structurally-invalid tab is dropped while the rest parse),
  // so a parsed result can be healthy-looking while the loader actually
  // discarded part of the workspace. One extra JSON.parse of the same raw
  // tells us how many tabs the loader SAW; if the parsed result kept fewer,
  // salvage dropped rows → corrupt.
  let rawTabCount: number | undefined
  try {
    const rawEnvelope = JSON.parse(raw) as { tabs?: { tabs?: unknown[] } }
    rawTabCount = Array.isArray(rawEnvelope?.tabs?.tabs) ? rawEnvelope.tabs.tabs.length : undefined
  } catch {
    rawTabCount = undefined   // unreachable here: JSON.parse already succeeded inside parsePersistedLayoutRaw
  }
  if (rawTabCount !== undefined && rawTabCount !== (parsed.tabs?.tabs?.length ?? 0)) {
    return 'corrupt'
  }
  // Referential integrity, BOTH directions — verified against the actual
  // loaders: a layout entry whose tabId is not among the parsed tabs is
  // DROPPED at load (cleanOrphanedLayouts, panesSlice.ts:328-371, called
  // from loadInitialPanesState at :418), and a tab whose id has NO layout
  // entry gets a RECONSTRUCTED default pane on mount (PaneLayout.tsx:18-27:
  // the mount effect dispatches initLayout with TabContent's defaultContent
  // when s.panes.layouts[tabId] is missing). Either way the saved
  // arrangement is silently lost — corrupt, not healthy. Accepted residual:
  // a flush landing in the transient window between addTab and its
  // initLayout classifies 'corrupt' and forces a rebuild; that path is safe
  // (upgrade 1 rebuilds from the window's own snapshot with preserved ids).
  const parsedTabIds = new Set(
    (parsed.tabs?.tabs ?? [])
      .map((t) => (t as { id?: unknown })?.id)
      .filter((id): id is string => typeof id === 'string'),
  )
  const layoutTabIds = Object.keys(parsed.panes?.layouts ?? {})
  for (const layoutTabId of layoutTabIds) {
    if (!parsedTabIds.has(layoutTabId)) return 'corrupt'
  }
  for (const tabId of parsedTabIds) {
    if (!layoutTabIds.includes(tabId)) return 'corrupt'
  }
  const tabCount = parsed.tabs?.tabs?.length ?? 0
  const paneCount = Object.keys(parsed.panes?.layouts ?? {}).length
  if (tabCount === 0 && paneCount === 0) return 'absent'
  // Active-reference validation (non-empty tabs). Persisted shape verified
  // against the real writer/reader: activeTabId lives at tabs.activeTabId
  // (persistMiddleware.ts:634 writes `state.tabs?.activeTabId ?? null`;
  // persistedState.ts:545 reads it back), and activePane lives at
  // panes.activePane as Record<tabId, paneId> (flushed inside the state.panes
  // spread at persistMiddleware.ts:608-628; read at persistedState.ts:551).
  // A legitimate flush NEVER produces a non-empty-tabs envelope without both
  // references: every in-memory writer keeps them valid — tabsSlice removeTab
  // re-points activeTabId to a surviving tab (tabsSlice.ts:363-371) and
  // hydrateTabs re-points to a merged tab (:427-435); panesSlice initLayout
  // sets activePane[tabId] to the layout's leaf (:1242), restoreLayout via
  // findFirstLeafId (:1258), resetLayout (:1280), splitPane (:1411), addPane
  // (:1502), closePane re-points to a surviving sibling leaf (:1466-1476),
  // cleanOrphanedLayouts removes entries with their layouts (:325-371), and
  // the hydrate merge validates candidates against the layout's leaf ids
  // (pickHydratedActivePane, :599-606). The zod schema fields are optional
  // only for legacy tolerance (persistedState.ts:52/:218) — v2/v3 writers
  // always maintained the invariant. The loaders do NOT heal loudly: an
  // invalid activeTabId is SILENTLY replaced with the first tab
  // (tabsSlice.ts:260-265) and activePane loads through unvalidated
  // (panesSlice.ts:402), so a damaged envelope would otherwise classify
  // healthy and silently lose the saved focus. Missing or dangling → corrupt.
  if (tabCount > 0) {
    const activeTabId = parsed.tabs?.activeTabId
    if (typeof activeTabId !== 'string' || !parsedTabIds.has(activeTabId)) return 'corrupt'
    for (const tabId of parsedTabIds) {
      const activePaneId = parsed.panes?.activePane?.[tabId]
      if (typeof activePaneId !== 'string') return 'corrupt'
      const layout = parsed.panes?.layouts?.[tabId]
      if (!layout || !collectLeafIdsOf(layout).has(activePaneId)) return 'corrupt'
    }
  }
  // Foreign IFF stamped AND the stamp names a different machine. Unstamped
  // = legacy (pre-stamp) data assumed local — never foreign (a same-machine
  // chooser re-pick keeps a healthy unstamped layout; Task 2's backfill then
  // stamps it so the next boot is unambiguous).
  const stamp = parsed.machineId
  if (typeof stamp === 'string' && stamp && stamp !== resolvedMachineId) return 'foreign'
  const persistedAt = typeof parsed.persistedAt === 'number' ? parsed.persistedAt : 0
  if (now - persistedAt > STALE_LAYOUT_MS) return 'stale'
  return 'healthy'
}
```

(If `parsePersistedLayoutRaw` returns `null` rather than throwing on corruption, keep the try/catch anyway — both shapes classify as corrupt. If `ParsedPersistedLayout` already exposes `persistedAt` under a different field name, use that field.)

In `src/store/storage-migration.ts` `migratePersistedLayout()` (~:386-430), add the stamp to the fixed top-level rewrite payload — preserve `machineId` when the parsed raw carries a string one, the same treatment `persistedAt` already gets (LB-05: without this, the every-boot rewrite strips the stamp before `classifyPersistedLayoutHealth` runs):

```typescript
// in the re-serialized payload literal:
machineId: typeof parsed.machineId === 'string' && parsed.machineId ? parsed.machineId : undefined,
```

(omit the field when absent — never write `null`; confirm the exact local variable name for the parsed raw in that function.)

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/lib/recovery/layout-health.test.ts test/unit/client/store/tabsPersistence.test.ts test/unit/client/store/storage-migration.test.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Keep the classification pure (no store access, no network). If the stamp logic or the `ParsedPersistedLayout` extension duplicated something that belongs in persistedState.ts, consolidate there.

- [ ] **Step 6: Run impacted-test verification**

Impacted: everything that round-trips the persisted envelope — tabsPersistence, persistedState, storage-migration, persist empty-guard, boot-state, panesPersistence.

Run: `npm run test:vitest -- run test/unit/client/store/tabsPersistence.test.ts test/unit/client/store/persistedState.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/persistTabsEmptyGuard.test.ts test/unit/client/lib/recovery/boot-state.test.ts test/unit/client/lib/recovery/layout-health.test.ts`

Expected: PASS (no existing test asserts the exact envelope field set; if one does, extend it minimally with the new optional field rather than loosening it).

- [ ] **Step 7: Commit the task**

```bash
git add src/lib/recovery/layout-health.ts src/store/persistedState.ts src/store/persistMiddleware.ts src/store/storage-migration.ts test/unit/client/lib/recovery/layout-health.test.ts test/unit/client/store/tabsPersistence.test.ts test/unit/client/store/storage-migration.test.ts
git commit -m "feat(client): stamp the persisted layout with its machine id and classify layout health"
```

---

### Task 2: Local-first boot gate — keep a healthy local layout (Choice B)

**Files:**
- Modify: `src/App.tsx:805-863` (the gate inside `resolveMachineBeforeTransport`: classify → stamp backfill → keep-vs-rebuild; the chooser handlers at `:550-566` are NOT touched — current main stays)
- Modify: `src/lib/recovery/layout-health.ts` (add `backfillPersistedLayoutMachineId` — the one-shot stamp backfill, Task 1's module)
- Modify: `src/lib/machine-workspace.ts` (`RestoreMachineWorkspaceOptions` gains `reason`)
- Test: `test/unit/client/components/App.machine-identity.test.tsx`, `test/unit/client/lib/recovery/layout-health.test.ts` (backfill unit tests), `test/unit/client/lib/machine-workspace.test.ts`

**Interfaces:**
- Consumes: `classifyPersistedLayoutHealth` from Task 1.
- Produces: `backfillPersistedLayoutMachineId(resolvedMachineId: string, storage?: Storage): boolean` in `layout-health.ts` (stamps an unstamped-but-parseable raw envelope with the resolved machine id; `true` when it wrote); `RestoreMachineWorkspaceOptions = { reason?: 'absent' | 'corrupt' | 'foreign' | 'stale' }` in `machine-workspace.ts` (the rebuild recipe itself is still the current one; Task 3 upgrades it).

- [ ] **Step 1: Write the failing behavioral tests**

Red test A — the stamp backfill (append to `test/unit/client/lib/recovery/layout-health.test.ts`, reusing its `seedEnvelope`/`healthyEnvelope`/`beforeEach` localStorage-clear idioms; the fixture's tabs/panes/active references are the healthy shape, only `machineId` varies):

```typescript
import { backfillPersistedLayoutMachineId } from '@/lib/recovery/layout-health'

describe('backfillPersistedLayoutMachineId', () => {
  beforeEach(() => { localStorage.clear() })

  it('stamps a healthy legacy (unstamped) envelope once machine identity resolves — with NO store action dispatched', () => {
    // The boot moment the finding pins: identity resolved, persist
    // middleware not dirty (machine-resolution actions never mark
    // tabsDirty/panesDirty, persistMiddleware.ts:719-751), so nothing else
    // would ever restamp a terminal-free healthy layout.
    const envelope = healthyEnvelope('machine-1')
    delete envelope.machineId
    seedEnvelope(envelope)
    const rawBefore = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY)!) as Record<string, unknown>
    expect(backfillPersistedLayoutMachineId('machine-1')).toBe(true)
    const stamped = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY)!) as { machineId?: string }
    expect(stamped.machineId).toBe('machine-1')
    // everything else is preserved — no layout mutation:
    expect(stamped.tabs).toEqual(rawBefore.tabs)
    expect(stamped.panes).toEqual(rawBefore.panes)
    expect(stamped.persistedAt).toEqual(rawBefore.persistedAt)
  })

  it('does not rewrite an already-stamped envelope (idempotent — content byte-identical)', () => {
    seedEnvelope(healthyEnvelope('machine-1'))
    const before = localStorage.getItem(LAYOUT_STORAGE_KEY)
    expect(backfillPersistedLayoutMachineId('machine-1')).toBe(false)
    expect(localStorage.getItem(LAYOUT_STORAGE_KEY)).toBe(before)   // no write at all
  })

  it('leaves an unparseable envelope alone (no write, no throw)', () => {
    seedEnvelope('{ not json')
    expect(backfillPersistedLayoutMachineId('machine-1')).toBe(false)
    expect(localStorage.getItem(LAYOUT_STORAGE_KEY)).toBe('{ not json')
  })
})
```

Red test B — the gate (extend the harness in `test/unit/client/components/App.machine-identity.test.tsx`, which already mocks `@/lib/machine-workspace`'s `restoreMachineWorkspace` as a spy and pins restore-before-`startTabRegistrySync`):

```typescript
// Mock the Task 1 module so the App test controls the classification
// independently of localStorage seeding. The factory MUST also stub
// backfillPersistedLayoutMachineId — the App gate imports both from this
// module, so a classify-only mock breaks the import:
vi.mock('@/lib/recovery/layout-health', () => ({
  classifyPersistedLayoutHealth: vi.fn(() => 'healthy'),
  backfillPersistedLayoutMachineId: vi.fn(() => false),
}))
import { classifyPersistedLayoutHealth, backfillPersistedLayoutMachineId } from '@/lib/recovery/layout-health'

it('keeps a healthy local workspace: no restore call, backfill stamps, straight to ready', async () => {
  vi.mocked(classifyPersistedLayoutHealth).mockReturnValue('healthy')
  renderAppWithMachineApi()      // existing harness helper for the machines API
  await waitForMachineReady()
  expect(restoreMachineWorkspaceMock).not.toHaveBeenCalled()
  // classify FIRST, then backfill — the gate calls the backfill once with
  // the resolved machine id (after classification, before any rebuild):
  expect(backfillPersistedLayoutMachineId).toHaveBeenCalledTimes(1)
  expect(backfillPersistedLayoutMachineId).toHaveBeenCalledWith(expect.any(String))
  expect(startTabRegistrySyncMock).toHaveBeenCalled()
})

it('rebuilds for an unhealthy layout and passes the health as the reason', async () => {
  vi.mocked(classifyPersistedLayoutHealth).mockReturnValue('corrupt')
  renderAppWithMachineApi()
  await waitForMachineReady()
  expect(restoreMachineWorkspaceMock).toHaveBeenCalledTimes(1)
  expect(restoreMachineWorkspaceMock).toHaveBeenCalledWith(
    expect.anything(), expect.any(String), { reason: 'corrupt' },
  )
  // order pin: restore still precedes tab-registry sync on rebuild boots
  expect(restoreMachineWorkspaceMock.mock.invocationCallOrder[0])
    .toBeLessThan(startTabRegistrySyncMock.mock.invocationCallOrder[0])
})
```

(Adapt helper names — `renderAppWithMachineApi`, `waitForMachineReady` — to this suite's existing helpers per LB-17.)

Red test C — reason param (append to `test/unit/client/lib/machine-workspace.test.ts`): for each reason value, the restore still fetches with the plain client id (unchanged until Task 3), runs the clears, and returns the plan count.

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/App.machine-identity.test.tsx test/unit/client/lib/recovery/layout-health.test.ts test/unit/client/lib/machine-workspace.test.ts`

Expected: FAIL — `backfillPersistedLayoutMachineId` does not exist (import error in layout-health.test.ts), App does not import `classifyPersistedLayoutHealth`/`backfillPersistedLayoutMachineId` (the module mock is unused so the gate tests fail), and no `reason` is passed.

- [ ] **Step 3: Add the minimal production implementation**

`src/lib/recovery/layout-health.ts` — add the stamp backfill (Task 1's module; it owns envelope parsing):

```typescript
/** One-shot stamp backfill. Machine resolution dispatches no tabs/panes
 * action, so the persist middleware's dirty flags never fire
 * (persistMiddleware.ts:534 returns early; :719-751 dirties only tabs/,
 * panes/, tabRecency/, and turnCompletion changes) — a healthy legacy
 * (unstamped) envelope could stay unstamped indefinitely (e.g. a
 * terminal-free layout dispatches nothing on boot). Write the resolved
 * machine id into the RAW envelope directly: parse only as the gate
 * (parses AND lacks machineId), mutate the raw object, ONE synchronous
 * setItem — localStorage writes are all-or-nothing per key, the atomic
 * equivalent of the server side's temp-file+rename; there is no shared
 * atomic-write utility in the client to reuse (verified — only prose uses
 * "atomic" in src/). NO layout mutation (never write the reconstructed
 * ParsedPersistedLayout back — that would normalize/rewrite fields), no
 * full reflush, no broadcast, no store dispatch. Idempotent within a
 * boot: an already-stamped or unparseable envelope writes nothing. */
export function backfillPersistedLayoutMachineId(
  resolvedMachineId: string,
  storage: Storage = safeStorage(),
): boolean {
  if (!resolvedMachineId || !storage) return false
  let raw: string | null = null
  try {
    raw = storage.getItem(LAYOUT_STORAGE_KEY)
  } catch {
    return false
  }
  if (raw === null) return false
  let parsed: ParsedPersistedLayout | null = null
  try {
    parsed = parsePersistedLayoutRaw(raw)
  } catch {
    parsed = null
  }
  if (!parsed) return false
  if (typeof parsed.machineId === 'string' && parsed.machineId) return false
  let rawEnvelope: { machineId?: string }
  try {
    rawEnvelope = JSON.parse(raw)
  } catch {
    return false
  }
  if (typeof rawEnvelope.machineId === 'string' && rawEnvelope.machineId) return false
  rawEnvelope.machineId = resolvedMachineId
  try {
    storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(rawEnvelope))
    return true
  } catch {
    return false
  }
}
```

`src/lib/machine-workspace.ts`:

```typescript
export type RestoreMachineWorkspaceReason = 'absent' | 'corrupt' | 'foreign' | 'stale'

export type RestoreMachineWorkspaceOptions = {
  /** Why this boot is rebuilding instead of keeping the local layout. */
  reason?: RestoreMachineWorkspaceReason
}
```

(`restoreMachineWorkspace` accepts the option and records it; its body is otherwise unchanged in this task — the rebuild recipe upgrade is Task 3.)

`src/App.tsx` — imports: add `classifyPersistedLayoutHealth` and `backfillPersistedLayoutMachineId` (both from `@/lib/recovery/layout-health`). In `resolveMachineBeforeTransport`, replace the unconditional restore block:

```typescript
dispatch(setMachineRestoring(resolution.machine))
dispatch(setTabRegistryDeviceMeta({
  deviceId: resolution.machine.id,
  deviceLabel: resolution.machine.label,
}))
// Local-first (Choice B): a healthy local layout IS this window's newest
// truth — keep it and skip the inventory entirely. Only an absent,
// corrupt, stale, or foreign layout rebuilds from the server.
const layoutHealth = classifyPersistedLayoutHealth(resolution.machine.id)
// Stamp backfill — classify FIRST, then backfill (AFTER the health gate
// reads the envelope). Unstamped is a one-boot transitional state: this
// is the only deterministic restamp for a terminal-free healthy layout.
// One call site covers both resolution paths — the bootstrap success
// path AND a chooser selection (a pick persists the selection and
// reloads; the next boot's resolution lands here). Safe on every
// classification outcome: absent/corrupt envelopes no-op inside the
// helper, and a rebuilt envelope is restamped by its own flush.
backfillPersistedLayoutMachineId(resolution.machine.id)
if (layoutHealth !== 'healthy') {
  await restoreMachineWorkspace(appStore, resolution.machine.id, { reason: layoutHealth })
  if (cancelled) return false
}
dispatch(setMachineReady({ machine: resolution.machine, mode: 'server-managed' }))
return true
```

The chooser handlers (`:550-566`) are NOT modified in this task — they already persist the selection and reload; the post-pick boot backfills through the call site above.

Update the suite's existing "restore happens BEFORE startTabRegistrySync" pin to the new semantics from Red test B (restore-before-sync only on rebuild boots; healthy boots go straight to ready).

- [ ] **Step 4: Run the focused tests**

Run: `npm run test:vitest -- run test/unit/client/components/App.machine-identity.test.tsx test/unit/client/lib/recovery/layout-health.test.ts test/unit/client/lib/machine-workspace.test.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

If `resolveMachineBeforeTransport` became hard to read, extract the keep-vs-rebuild decision into one named function (App.tsx-local or `machine-workspace.ts`, e.g. `shouldRebuildLocalWorkspace(health)`); the classification and the backfill stay in `layout-health.ts`. Keep App.tsx additions to wiring only.

- [ ] **Step 6: Run impacted-test verification**

Impacted: every consumer of the boot sequence and the restore contract — App boot suites, machine-workspace, layout-health (classifier + backfill), storage-migration (the backfilled envelope's `machineId` must survive `runStorageMigration()` — the LB-05 pin already covers the shape), RecoveryOfferPanel suites (`hadPersistedLayoutAtBoot` offer is user-invoked for lost-browser-state and must remain untouched), crossTabSync installation, persist empty-guard.

Run: `npm run test:vitest -- run test/unit/client/components/App.machine-identity.test.tsx test/unit/client/components/RecoveryOfferPanel.test.tsx test/unit/client/components/RecoveryOfferPanel.persisted-boot.test.tsx test/unit/client/lib/machine-workspace.test.ts test/unit/client/lib/recovery/layout-health.test.ts test/unit/client/store/storage-migration.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/store/persistTabsEmptyGuard.test.ts`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add src/App.tsx src/lib/recovery/layout-health.ts src/lib/machine-workspace.ts test/unit/client/components/App.machine-identity.test.tsx test/unit/client/lib/recovery/layout-health.test.ts test/unit/client/lib/machine-workspace.test.ts
git commit -m "feat(machine-identity): keep a healthy local workspace on reload and backfill the machine-id stamp; rebuild only when the layout is absent, corrupt, stale, or foreign"
```

---

### Task 3: Own-snapshot rebuild — bootstrap exclusion prefix + preserved ids (upgrade 1)

**Files:**
- Modify: `src/lib/machine-workspace.ts` (bootstrap exclusion id + pass `preserveIdsForMachine`)
- Modify: `src/lib/recovery/build-recovery-plan.ts` (`BuildRecoveryPlanOptions`)
- Test: `test/unit/client/lib/machine-workspace.test.ts`, `test/unit/client/lib/recovery/build-recovery-plan.test.ts`

**Interfaces:**
- Consumes: Task 2's `RestoreMachineWorkspaceOptions`.
- Produces: `export interface BuildRecoveryPlanOptions { preserveIdsForMachine?: string }` and `buildRecoveryPlan(inv, options?)` in build-recovery-plan.ts; module-local `MACHINE_BOOTSTRAP_RECOVERY_EXCLUSION_PREFIX = 'machine-bootstrap:'` in machine-workspace.ts.

- [ ] **Step 1: Write the failing behavioral tests**

Red test A — own-snapshot inclusion (append to `test/unit/client/lib/machine-workspace.test.ts`, using its existing mocked-`@/lib/api` + mocked `getCurrentTabRegistryClientInstanceId` → `'client-machine-test'` harness):

```typescript
it('requests the machine-bootstrap inventory so the window\u2019s own last snapshot is included', async () => {
  const { store, api } = buildRestoreHarness()   // existing harness helpers in this suite
  await restoreMachineWorkspace(store, 'machine-1', { reason: 'corrupt' })
  expect(api.getRecoveryInventory).toHaveBeenCalledWith(
    'machine-bootstrap:client-machine-test',    // reserved prefix, not the raw client id
    expect.any(Number),
    { machineId: 'machine-1' },
  )
})
```

Red test B — preserved ids (append to `test/unit/client/lib/recovery/build-recovery-plan.test.ts`; fixtures follow the file's hand-built `RecoveryInventory` style):

```typescript
describe('buildRecoveryPlan preserveIdsForMachine', () => {
  const inv = inventoryWithTabs('machine-1', [{
    tabKey: 'machine-1:tab-keep', tabName: 'Keep',
    panes: [restorablePane({ paneId: 'pane-keep', kind: 'terminal', mode: 'shell', cwd: '/tmp' })],
  }])

  it('preserveIdsForMachine keeps the inventory\u2019s tab ids and pane ids', () => {
    const [plan] = buildRecoveryPlan(inv, { preserveIdsForMachine: 'machine-1' })
    expect(plan.tabId).toBe('tab-keep')
    expect(collectLeafPaneIds(plan.layout)).toEqual(['pane-keep'])
  })

  it('preserveIdsForMachine throws loudly on a foreign tab key', () => {
    const foreign = inventoryWithTabs('machine-1', [{
      tabKey: 'machine-OTHER:tab-x', tabName: 'X',
      panes: [restorablePane({ paneId: 'pane-x', kind: 'terminal', mode: 'shell', cwd: '/tmp' })],
    }])
    expect(() => buildRecoveryPlan(foreign, { preserveIdsForMachine: 'machine-1' }))
      .toThrow(/does not belong to machine/)
  })

  it('without options, ids are still re-minted (recovery-offer contract unchanged)', () => {
    const [plan] = buildRecoveryPlan(inv)
    expect(plan.tabId).not.toBe('tab-keep')
    expect(collectLeafPaneIds(plan.layout)).not.toContain('pane-keep')
  })
})
```

(`inventoryWithTabs`/`restorablePane`/`collectLeafPaneIds` are either existing helpers in that suite or small local builders added to the test file in the file's literal-fixture style.)

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/lib/machine-workspace.test.ts test/unit/client/lib/recovery/build-recovery-plan.test.ts`

Expected: FAIL — the inventory is called with the raw client id, and `buildRecoveryPlan` takes no options (TS error at the call site; ids re-minted at runtime).

- [ ] **Step 3: Add the minimal production implementation**

Preferred path: `git cherry-pick -x bd4315881` (brings the mapped recipe with attribution), then resolve the conflict with Task 2's options param so BOTH live: the bootstrap prefix + `preserveIdsForMachine` AND the `reason` option. If the cherry-pick does not apply cleanly, apply this equivalent code:

`src/lib/machine-workspace.ts`:

```typescript
const MACHINE_BOOTSTRAP_RECOVERY_EXCLUSION_PREFIX = 'machine-bootstrap:'

export async function restoreMachineWorkspace(
  store: MachineWorkspaceStore,
  machineId: string,
  options: RestoreMachineWorkspaceOptions = {},
): Promise<{ restoredTabs: number }> {
  // The recovery endpoint treats clientInstanceId as an opaque exclusion
  // key. The general recovery offer passes the real id so it cannot offer
  // the page its own already-loaded state. Machine bootstrap is different:
  // a rebuild WANTS the window's own last durable snapshot included, and a
  // reload keeps the same sessionStorage id. A reserved, non-client prefix
  // therefore includes that window's last snapshot without changing the
  // normal recovery-offer contract.
  const bootstrapExclusionId = `${MACHINE_BOOTSTRAP_RECOVERY_EXCLUSION_PREFIX}${getCurrentTabRegistryClientInstanceId()}`
  const inventory = await getRecoveryInventory(
    bootstrapExclusionId,
    Math.max(0, Date.now() - bootCapturedAtMs),
    { machineId },
  )
  assertInventoryIsScopedToMachine(inventory, machineId)
  const plans = inventory.recoverable
    ? buildRecoveryPlan(inventory, { preserveIdsForMachine: machineId })
    : []
  // clears + plan loop + armTerminalRestores: unchanged from current main
}
```

`src/lib/recovery/build-recovery-plan.ts`:

```typescript
export interface BuildRecoveryPlanOptions {
  /** Machine bootstrap replaces the local cache with this same machine's
   * durable workspace. Preserve its tab and pane ids so reload does not
   * break references or turn every existing tab into a newly-created one.
   * The opt-in keeps the user-invoked recovery offer's deliberate
   * reminting behavior unchanged. */
  preserveIdsForMachine?: string
}

function preservedTabId(tabKey: string, machineId: string): string {
  const prefix = `${machineId}:`
  const tabId = tabKey.startsWith(prefix) ? tabKey.slice(prefix.length) : ''
  if (!tabId) throw new Error(`Recovery tab key ${tabKey} does not belong to machine ${machineId}`)
  return tabId
}

function leaf(content: PaneContent, paneId?: string): PaneNode {
  return { type: 'leaf', id: paneId ?? nanoid(), content }
}
```

and in the plan mapping, when `options.preserveIdsForMachine` is set: `leaf(content, p.paneId)` for each restorable pane and `tabId: preservedTabId(t.tabKey, options.preserveIdsForMachine)` instead of `nanoid()`.

- [ ] **Step 4: Run the focused tests**

Run: `npm run test:vitest -- run test/unit/client/lib/machine-workspace.test.ts test/unit/client/lib/recovery/build-recovery-plan.test.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

None expected — the code is already minimal. If the cherry-pick path was used, verify the `(cherry picked from commit ...)` attribution line survived.

- [ ] **Step 6: Run impacted-test verification**

Impacted: every `buildRecoveryPlan` consumer — machine-workspace tests, `RecoveryOfferPanel` suites (behavior must be UNCHANGED for the user-invoked offer: no options passed, ids re-minted), boot-state/main-import-order (import-time only).

Run: `npm run test:vitest -- run test/unit/client/lib/machine-workspace.test.ts test/unit/client/lib/recovery/build-recovery-plan.test.ts test/unit/client/components/RecoveryOfferPanel.test.tsx test/unit/client/components/RecoveryOfferPanel.persisted-boot.test.tsx`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add src/lib/machine-workspace.ts src/lib/recovery/build-recovery-plan.ts test/unit/client/lib/machine-workspace.test.ts test/unit/client/lib/recovery/build-recovery-plan.test.ts
git commit -m "feat(recovery): machine bootstrap includes the window's own snapshot and preserves tab/pane ids"
```

---

### Task 4: E2e — reload keeps a healthy workspace; a corrupt envelope rebuilds from the own snapshot

**Files:**
- Create: `test/e2e-browser/specs/local-first-reload-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (`RUST_ONLY_SPECS` ~:187 AND the `rust-chromium` project `testMatch` ~:430-660 — BOTH lists)

**Interfaces:**
- Consumes: the owned `RustServer` fixture + `ensureRustServerBuilt` (`helpers/rust-server.ts`), the `connect` + generation-file fs-poll idioms from `recover-my-panes-rust.spec.ts`, and the harness dispatch seam `window.__FRESHELL_TEST_HARNESS__` (`helpers/test-harness.ts`).
- Produces: the e2e pin for Tasks 1-3 (no production code in this task).

- [ ] **Step 1: Write the e2e spec (and register it in BOTH config lists)**

Create `test/e2e-browser/specs/local-first-reload-rust.spec.ts`:

```typescript
import { test, expect } from '../helpers/fixtures.js'
import { ensureRustServerBuilt, RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import fs from 'node:fs'
import path from 'node:path'

/**
 * LOCAL-FIRST RELOAD (the-usual/pane-title-recovery, Choice B):
 *
 * 1. A reload of a window whose local layout is HEALTHY keeps the local
 *    workspace exactly — tab ids, order, titles, pane titles, active tab —
 *    with no server-side rebuild (no re-minting).
 * 2. A reload after the local envelope is CORRUPTED rebuilds from the
 *    machine-bootstrap inventory, which (upgrade 1) includes the window's
 *    own last pushed snapshot with PRESERVED tab and pane ids.
 *
 * Cloud-runnable by construction: editor panes (no PTY, no CLI binaries),
 * owned fresh RustServer (fresh FRESHELL_HOME auto-creates the machine —
 * never the chooser), explicit tab/pane ids dispatched through the harness.
 */
test.describe('local-first machine workspace', () => {
  test.describe.configure({ mode: 'serial' })

  let server: RustServer
  let serverInfo: Awaited<ReturnType<RustServer['start']>>

  /** Machine-selection storage payload captured from Scenario 1 (the first
   * serial test): the remembered-selection localStorage entries
   * ('freshell.machine-id.v1' + 'freshell.machine-selections.v1',
   * storage-keys.ts:17-18). Scenario 3 (Task 7 Step 6) opens a FRESH
   * per-test context against this already-existing machine; a first
   * navigation there would open the machine chooser (machine-identity.ts:
   * 216-222: no remembered selection + machines present → chooser) and never
   * connect, so Scenario 3 seeds this payload into its context BEFORE first
   * navigation. Serial mode guarantees Scenario 1 ran first. */
  let machineSelectionStorage: Record<string, string> | undefined

  test.beforeAll(async () => {
    ensureRustServerBuilt()   // synchronous (rust-server.ts:92, returns the binary path — LB-07)
    server = new RustServer({/* fresh FRESHELL_HOME + ephemeral port per the fixture's options */})
    serverInfo = await server.start()
  })
  test.afterAll(async () => { await server?.stop() })

  const TABS = [
    { id: 'tab-mango', title: 'Mango', file: '/tmp/mango.md', pane: 'tab-mango-pane', paneTitle: 'Mango notes' },
    { id: 'tab-apple', title: 'Apple', file: '/tmp/apple.md', pane: 'tab-apple-pane', paneTitle: 'Apple notes' },
  ]

  /** Spec-LOCAL fs-poll (the donor idiom, recover-my-panes-rust.spec.ts:452-494,
   * per LB-07 — there is NO TestHarness method of this name; TestHarness's
   * real methods are only waitForHarness/waitForConnection/waitForTabCount/
   * getState/... per helpers/test-harness.ts): read every generation file
   * under the server home's tabs-snapshots dir, keep only the given
   * clientInstanceId's, rank newest by (snapshotRevision, capturedAt) — the
   * server's own per-client monotonic ordering — and insist the newest
   * generation has >= minRecords records. Bounded, 500ms poll interval. */
  async function waitForNewestGenerationRecordCount(
    clientInstanceId: string,
    minRecords: number,
    timeoutMs = 30_000,
  ): Promise<void> {
    const snapshotsDir = path.join(serverInfo.homeDir, '.freshell', 'tabs-snapshots')
    const deadline = Date.now() + timeoutMs
    let lastObserved = 0
    while (Date.now() < deadline) {
      const devices = await fs.readdir(snapshotsDir).catch(() => [] as string[])
      for (const device of devices) {
        const deviceDir = path.join(snapshotsDir, device)
        const files = (await fs.readdir(deviceDir).catch(() => [] as string[]))
          .filter((f) => f.endsWith('.json'))
        let newest: { revision: number; capturedAt: number; count: number } | null = null
        for (const f of files) {
          const raw = await fs.readFile(path.join(deviceDir, f), 'utf8').catch(() => '')
          let doc: any = null
          try { doc = JSON.parse(raw) } catch { continue }
          if (doc?.clientInstanceId !== clientInstanceId) continue
          const revision = Number(doc?.snapshotRevision ?? 0)
          const capturedAt = Number(doc?.capturedAt ?? 0)
          const count = Array.isArray(doc?.records) ? doc.records.length : 0
          if (!newest || revision > newest.revision || (revision === newest.revision && capturedAt > newest.capturedAt)) {
            newest = { revision, capturedAt, count }
          }
        }
        if (newest) {
          lastObserved = Math.max(lastObserved, newest.count)
          if (newest.count >= minRecords) return
        }
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error(
      `No persisted generation for client ${clientInstanceId} reached ${minRecords} records `
      + `within ${timeoutMs}ms (last observed: ${lastObserved})`,
    )
  }

  test('reload keeps a healthy local workspace exactly; corrupt envelope rebuilds from own snapshot with preserved ids', async ({ page }) => {
    // NO addInitScript at all: a fresh Playwright context starts with EMPTY
    // storage, so there is nothing to clear — and any init script (even a
    // once-guarded clear) cannot survive a reload (each reload is a new
    // document), so it would run on every load and mint a fresh
    // clientInstanceId, letting Scenario 2 pass even if the
    // machine-bootstrap prefix regressed (the LB-08 false green). With no
    // init script the natural reload PRESERVES the clientInstanceId, which
    // makes the `machine-bootstrap:` prefix load-bearing for Scenario 2.
    // LB-07: `connect` is donor-spec-local — navigate directly instead.
    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    const harness = new TestHarness(page)
    await harness.waitForHarness()
    await harness.waitForConnection()

    // Capture the resolved machine-selection storage payload at spec scope
    // (see the machineSelectionStorage declaration): the boot has resolved
    // and persisted the auto-created machine by now (resolveMachineIdentity
    // → persistSelectedMachineId, machine-identity.ts:208/:217-218).
    machineSelectionStorage = await page.evaluate(() => {
      const out: Record<string, string> = {}
      for (const key of ['freshell.machine-id.v1', 'freshell.machine-selections.v1']) {
        const value = localStorage.getItem(key)
        if (value !== null) out[key] = value
      }
      return out
    })

    // Fresh home auto-created a machine AND an auto shell tab — remove it.
    await harness.waitForTabCount(1)
    await page.evaluate(() => {
      const state = window.__FRESHELL_TEST_HARNESS__?.getState()
      const autoId = state?.tabs?.tabs?.[0]?.id
      // tabs/removeTab takes the BARE tab-id string (tabsSlice.ts:354-355,
      // PayloadAction<string>) — not an { id } object.
      if (autoId) window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'tabs/removeTab', payload: autoId })
    })

    for (const t of TABS) {
      await page.evaluate((t) => {
        window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'tabs/addTab', payload: { id: t.id, title: t.title } })
        window.__FRESHELL_TEST_HARNESS__?.dispatch({
          type: 'panes/initLayout',
          payload: {
            tabId: t.id, paneId: t.pane,
            content: { kind: 'editor', filePath: t.file, language: null, readOnly: false, content: '', viewMode: 'source', wordWrap: true },
          },
        })
        window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'panes/updatePaneTitle', payload: { tabId: t.id, paneId: t.pane, title: t.paneTitle, setByUser: true } })
      }, t)
    }
    await page.evaluate((id) => window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'tabs/setActiveTab', payload: id }), 'tab-mango')

    // Wait until the registry pushed generations AND the persisted envelope
    // carries the stamp + both tabs (fs-poll generation files under the
    // server home; localStorage poll for freshell.layout.v3). The page's
    // clientInstanceId lives in sessionStorage (storage-keys.ts:20 — the
    // natural reload preserves it, which is what makes the
    // `machine-bootstrap:` prefix load-bearing in Scenario 2).
    const clientInstanceId = await page.evaluate(() => sessionStorage.getItem('freshell.tabs.client-instance-id.v1'))
    await waitForNewestGenerationRecordCount(clientInstanceId, 2)
    await waitForPersistedEnvelope(page, (env) =>
      typeof env.machineId === 'string' && env.machineId.length > 0 && env.tabs?.tabs?.length === 2)

    // ── Scenario 1: healthy reload keeps everything ────────────────
    await page.reload()
    await harness.waitForHarness()
    await harness.waitForConnection()
    const kept = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.getState())
    expect(kept.tabs.tabs.map((t: { id: string }) => t.id)).toEqual(['tab-mango', 'tab-apple'])
    expect(kept.tabs.tabs.map((t: { title: string }) => t.title)).toEqual(['Mango', 'Apple'])
    expect(kept.tabs.activeTabId).toBe('tab-mango')
    expect(kept.panes.paneTitles['tab-mango']['tab-mango-pane']).toBe('Mango notes')
    expect(kept.panes.paneTitles['tab-apple']['tab-apple-pane']).toBe('Apple notes')
    expect(kept.panes.paneTitleSetByUser['tab-mango']['tab-mango-pane']).toBe(true)
    expect(JSON.stringify(kept.panes.layouts['tab-mango'])).toContain('tab-mango-pane')

    // ── Scenario 2: corrupt envelope → bootstrap rebuild, ids preserved ──
    await page.evaluate(() => localStorage.setItem('freshell.layout.v3', '{corrupted-by-e2e'))
    await page.reload()
    await harness.waitForHarness()
    await harness.waitForConnection()
    const rebuilt = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.getState())
    expect(rebuilt.tabs.tabs.map((t: { id: string }) => t.id).sort()).toEqual(['tab-apple', 'tab-mango'])
    expect(rebuilt.tabs.tabs.map((t: { title: string }) => t.title).sort()).toEqual(['Apple', 'Mango'])
    expect(JSON.stringify(rebuilt.panes.layouts['tab-mango'])).toContain('tab-mango-pane')
    expect(JSON.stringify(rebuilt.panes.layouts['tab-apple'])).toContain('tab-apple-pane')
  })
})

/** Bounded node-side poll for the persisted envelope to satisfy the
 * predicate: evaluate a plain JSON.parse read each round (no serialized
 * predicate, no `new Function`), assert the predicate in node, keep the
 * poll bounded (10s default) with a clear timeout error. */
async function waitForPersistedEnvelope(
  page: import('playwright').Page,
  predicate: (env: Record<string, unknown>) => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const env = await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('freshell.layout.v3') ?? 'null') } catch { return null }
    })
    if (env && predicate(env)) return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`persisted envelope did not satisfy the predicate within ${timeoutMs}ms`)
}
```

Registration (both lists — per the known past-bug class):

```typescript
// RUST_ONLY_SPECS (~:187): add
/local-first-reload-rust\.spec\.ts/,
// rust-chromium project testMatch (~:430-660): append the same regex to the array.
```

- [ ] **Step 2: Non-vacuity receipt — run the spec at the base commit and EXPECT FAIL**

Task 4 runs after Tasks 1-3 implement the behavior, so an "expected FAIL on current main" run in THIS worktree is unreachable. Prove the spec is non-vacuous in a THROWAWAY git worktree at the plan's base_ref `bab7d5189`:

```bash
SCRATCH="$(mktemp -d /tmp/freshell-pane-title-nonvacuity.XXXXXX)"
git worktree add --detach "$SCRATCH" bab7d5189
# The scratch tree starts bare. Reuse the real worktree's installed deps and
# already-built server binary (Tasks 1-3 add no dependencies and no Rust
# code, so base and worktree tooling are identical):
ln -s "$(pwd)/node_modules" "$SCRATCH/node_modules"
cp test/e2e-browser/specs/local-first-reload-rust.spec.ts "$SCRATCH/test/e2e-browser/specs/"
# Then apply the SAME two registration edits (RUST_ONLY_SPECS ~:187 AND the
# rust-chromium testMatch ~:430-660) to the scratch copy's
# test/e2e-browser/playwright.config.ts.
```

Run the spec from the scratch tree, reusing the built binary through the fixture's fail-closed override (`FRESHELL_E2E_RUST_SERVER_BIN`, helpers/rust-server.ts:93):

```bash
( cd "$SCRATCH" && FRESHELL_E2E_RUST_SERVER_BIN="<real-worktree>/target/release/freshell-server" \
  bash scripts/e2e-cloud.sh run --local --project=rust-chromium test/e2e-browser/specs/local-first-reload-rust.spec.ts )
```

Expected: FAIL — Scenario 1's `kept` assertions fail (at base the reload clears and re-mints the workspace: fresh nanoid tab ids, derived-default pane titles, re-minted active tab) and Scenario 2 fails (no `machine-bootstrap:` prefix, ids re-minted). Record the receipt (command + failure summary) at `.worktrees/.the-usual-logs/pane-title-recovery/reports/local-first-reload-nonvacuity-receipt.md`.

Then remove the throwaway — verify the path is the scratch dir (never the real worktree) before forcing:

```bash
[ -n "$SCRATCH" ] && [ "$SCRATCH" != "$(pwd)" ] && git worktree remove --force "$SCRATCH"
```

- [ ] **Step 3: Run the spec in the REAL worktree — EXPECT PASS (it pins landed Tasks 1-3)**

Run: `bash scripts/e2e-cloud.sh run --local --project=rust-chromium test/e2e-browser/specs/local-first-reload-rust.spec.ts`

Expected: PASS (both scenarios). This is not a red-first step — the red was recorded in Step 2's receipt; this run pins the landed Tasks 1-3 behavior. No new production code: if it fails for harness reasons (auto-tab timing, generation-file polling, envelope polling), fix the SPEC, not production code. (The `waitForPersistedEnvelope` helper in the sketch is the bounded node-side poll itself — keep it that way; `new Function` serialization is not acceptable in the final spec.)

- [ ] **Step 4: Refactor while green**

Keep poll helpers inside the spec file (other runs own the shared helper files).

- [ ] **Step 5: Run impacted-test verification**

The config edit affects e2e collection only. Verify the spec is registered in BOTH lists: the match-all `chromium` project must NOT collect it, and `rust-chromium` must:

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts --project=chromium --list 2>/dev/null | grep -c 'local-first-reload' || true`

Expected: 0

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium --list | grep 'local-first-reload'`

Expected: at least one listed test.

- [ ] **Step 6: Commit the task**

```bash
git add test/e2e-browser/specs/local-first-reload-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): pin local-first reload — healthy layout kept exactly, corrupt envelope rebuilt from the own snapshot"
```

---

### Task 5: Fold terminal.inventory titles into pane titles on every connect

**Files:**
- Create: `src/lib/terminal-inventory-titles.ts`
- Create: `test/unit/client/lib/terminal-inventory-titles.test.ts`
- Modify: `src/App.tsx:1419-1470` (one call inside the existing `terminal.inventory` handler)
- Test: create `test/unit/client/components/App.inventory-title-fold.test.tsx` (wiring pin, same harness family as App.machine-identity.test.tsx)

**Interfaces:**
- Consumes: `updatePaneTitleByTerminalId` (panesSlice.ts:2206, existing, `setByUser:false`-guarded), the WS `TerminalInventoryMessage.terminals[]` rows (shared/ws-protocol.ts:1587-1606).
- Produces: `export function foldTerminalInventoryTitles(store: { getState: () => RootState; dispatch: (a: unknown) => unknown }, terminals: Array<{ terminalId?: string; title?: string }> | undefined): number`

- [ ] **Step 1: Write the failing behavioral tests**

Create `test/unit/client/lib/terminal-inventory-titles.test.ts` (real reducers in a configureStore; `terminalLeaf` builder idiom from panesSlice.test.ts):

```typescript
import { configureStore } from '@reduxjs/toolkit'
import { describe, expect, it } from 'vitest'
import { foldTerminalInventoryTitles } from '@/lib/terminal-inventory-titles'
import { addTab, type Tab } from '@/store/tabsSlice'       // exact exports per slice
import { initLayout, panesSlice, updatePaneTitle } from '@/store/panesSlice'

function seedTerminalPane(store: ReturnType<typeof buildStore>, tabId: string, paneId: string, terminalId: string) {
  store.dispatch(addTab({ id: tabId, title: tabId }))
  store.dispatch(initLayout({
    tabId, paneId,
    content: { kind: 'terminal', mode: 'shell', shell: 'wsl', terminalId, createRequestId: `cr-${terminalId}`, status: 'running' },   // 'running' — a real TerminalStatus (src/store/types.ts:1) for an anchored pane, per paneSessionTitleSync.test.ts's terminal fixtures
  }))
}

function buildStore() {
  return configureStore({ reducer: { tabs: tabsReducer, panes: panesSlice.reducer } })
}

describe('foldTerminalInventoryTitles', () => {
  it('writes the inventory title into the matching pane (auto source, not user-set)', () => {
    const store = buildStore()
    seedTerminalPane(store, 'tab-1', 'pane-1', 't-9')
    const n = foldTerminalInventoryTitles(store, [{ terminalId: 't-9', title: 'Renamed by sweep' }])
    expect(n).toBe(1)
    expect(store.getState().panes.paneTitles['tab-1']['pane-1']).toBe('Renamed by sweep')
    expect(store.getState().panes.paneTitleSetByUser['tab-1']?.['pane-1']).toBeFalsy()
  })

  it('never overwrites a user-set pane title (and does not count it as a fold)', () => {
    const store = buildStore()
    seedTerminalPane(store, 'tab-1', 'pane-1', 't-9')
    store.dispatch(updatePaneTitle({ tabId: 'tab-1', paneId: 'pane-1', title: 'My own name', setByUser: true }))
    expect(foldTerminalInventoryTitles(store, [{ terminalId: 't-9', title: 'Sweep title' }])).toBe(0)
    expect(store.getState().panes.paneTitles['tab-1']['pane-1']).toBe('My own name')
  })

  it('skips rows without a title and terminals with no matching pane', () => {
    const store = buildStore()
    seedTerminalPane(store, 'tab-1', 'pane-1', 't-9')
    expect(foldTerminalInventoryTitles(store, [{ terminalId: 't-9' }, { terminalId: 't-unknown', title: 'X' }])).toBe(0)
  })

  it('does not dispatch when the pane title already equals the inventory title', () => {
    const store = buildStore()
    seedTerminalPane(store, 'tab-1', 'pane-1', 't-9')
    store.dispatch(updatePaneTitle({ tabId: 'tab-1', paneId: 'pane-1', title: 'Same', setByUser: false }))
    const before = store.getState()
    expect(foldTerminalInventoryTitles(store, [{ terminalId: 't-9', title: 'Same' }])).toBe(0)
    expect(store.getState().panes).toBe(before.panes)
  })

  it('folds every differing row in one call', () => {
    const store = buildStore()
    seedTerminalPane(store, 'tab-a', 'pane-a', 't-a-9')
    seedTerminalPane(store, 'tab-b', 'pane-b', 't-b-9')
    store.dispatch(updatePaneTitle({ tabId: 'tab-a', paneId: 'pane-a', title: 'A title', setByUser: false }))
    const n = foldTerminalInventoryTitles(store, [
      { terminalId: 't-a-9', title: 'A title' },
      { terminalId: 't-b-9', title: 'B title' },
    ])
    expect(n).toBe(1)
    expect(store.getState().panes.paneTitles['tab-b']['pane-b']).toBe('B title')
  })
})
```

Wiring pin (`test/unit/client/components/App.inventory-title-fold.test.tsx`, same harness idiom as App.machine-identity.test.tsx): render the App with a terminal pane mounted, push a fake `terminal.inventory` WS frame (`terminals: [{ terminalId: <that terminal>, title: 'From inventory' }]`) through the mocked WS client's `onMessage`, and assert `getState().panes.paneTitles` picked the title up with the user-set flag falsy.

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/lib/terminal-inventory-titles.test.ts test/unit/client/components/App.inventory-title-fold.test.tsx`

Expected: FAIL — the module does not exist (import error) and the wiring test finds no title fold.

- [ ] **Step 3: Add the minimal production implementation**

Create `src/lib/terminal-inventory-titles.ts`:

```typescript
import { updatePaneTitleByTerminalId } from '@/store/panesSlice'
import type { RootState } from '@/store'

type FoldStore = { getState: () => RootState; dispatch: (action: unknown) => unknown }
type InventoryRow = { terminalId?: string; title?: string }

/** Does any pane bound to this terminal hold a title that differs?
 * Carries the owning tabId through the walk so the title comparison can
 * read paneTitles[tabId][paneId]. A pane whose user-set flag is true is
 * NEVER a fold target — treat it as NOT differing so the fold count only
 * reports real folds and no no-op dispatch fires for it on every refresh. */
function paneTitleDiffersForTerminal(panes: RootState['panes'], terminalId: string, title: string): boolean {
  for (const [tabId, layout] of Object.entries(panes.layouts ?? {})) {
    if (!layout) continue
    const walk = (node: unknown): boolean => {
      if (!node || typeof node !== 'object') return false
      const n = node as { type?: string; id?: string; content?: { kind?: string; terminalId?: string }; children?: unknown[] }
      if (n.type === 'leaf') {
        if (n.content?.kind === 'terminal' && n.content.terminalId === terminalId) {
          if (panes.paneTitleSetByUser?.[tabId]?.[n.id ?? '']) return false
          if (((panes.paneTitles?.[tabId]?.[n.id ?? '']) ?? '') !== title) return true
        }
        return false
      }
      return (n.children ?? []).some(walk)
    }
    if (walk(layout)) return true
  }
  return false
}

/**
 * Fold terminal.inventory rows' titles into pane titles. The server sends
 * the inventory on EVERY connection, so this closes the refresh hole where
 * the edge-triggered terminal.title.updated push was missed and nothing
 * re-delivered the current registry title. All writes go through
 * updatePaneTitleByTerminalId with setByUser:false — user renames stick.
 * Returns the number of dispatched folds (churn-free: rows whose panes
 * already hold the title dispatch nothing, and user-set panes are skipped
 * entirely so they are never dispatched or counted).
 */
export function foldTerminalInventoryTitles(store: FoldStore, terminals: InventoryRow[] | undefined): number {
  let dispatched = 0
  for (const row of terminals ?? []) {
    const terminalId = row?.terminalId
    const title = row?.title
    if (!terminalId || !title) continue
    if (!paneTitleDiffersForTerminal(store.getState().panes, terminalId, title)) continue
    store.dispatch(updatePaneTitleByTerminalId({ terminalId, title, setByUser: false }))
    dispatched += 1
  }
  return dispatched
}
```

`src/App.tsx` — inside the existing `terminal.inventory` handler (~:1419-1470), after `patchSessionRunningStateFromTerminalMeta` (~:1459-1462), add one line:

```typescript
foldTerminalInventoryTitles(appStore, msg.terminals)
```

(one import + one call — wiring only; App.tsx must grow by no more than those two lines.)

- [ ] **Step 4: Run the focused tests**

Run: `npm run test:vitest -- run test/unit/client/lib/terminal-inventory-titles.test.ts test/unit/client/components/App.inventory-title-fold.test.tsx`

Expected: PASS

- [ ] **Step 5: Refactor while green**

If panesSlice.ts already has an exportable terminal-walk helper (`findPaneIdByTerminalId`, :432-441), prefer exporting and reusing it over the local walk (one-line export; panesSlice must not grow logic). Keep the churn guard in this module either way.

- [ ] **Step 6: Run impacted-test verification**

Impacted: App terminal.inventory handler consumers, the paneSessionTitleSync/tab-pane-title-sync families (same actions, different triggers), TerminalView title tests (unchanged path).

Run: `npm run test:vitest -- run test/unit/client/lib/terminal-inventory-titles.test.ts test/unit/client/store/paneSessionTitleSync.test.ts test/unit/client/store/tab-pane-title-sync.test.ts test/unit/client/components/App.machine-identity.test.tsx`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add src/lib/terminal-inventory-titles.ts src/App.tsx test/unit/client/lib/terminal-inventory-titles.test.ts test/unit/client/components/App.inventory-title-fold.test.tsx
git commit -m "feat(client): fold terminal inventory titles into pane titles on connect"
```

---

### Task 6: Mirror session-directory titles into open panes by sessionRef

**Files:**
- Create: `src/store/sessionTitleMirror.ts`
- Create: `test/unit/client/store/sessionTitleMirror.test.ts`
- Create: `test/unit/client/store/sessionTitleMirror.registration.test.ts` (production-store registration pin)
- Modify: `src/store/panesSlice.ts` (`updatePaneTitleBySessionRef` :2242-2262 — extended to update ALL matching panes in every tab, not only the first per tab; line-neutral in the over-cap file: it swaps the single-match `findPaneIdBySessionRef` call for a walk over the existing `collectLeaves` helper, :495+, with the same per-pane user-set guard — no net growth)
- Modify: `src/store/sessionsSlice.ts` (`commitWindowPayload` :227-244 — stamp every inserted-or-updated committed row with the per-row `fetchSeq` counter, the row-freshness field the mirror keys on; retained rows keep their old stamps)
- Modify: `src/store/types.ts` (`CodingCliSession`, ending at :124, gains the optional client-side field `fetchSeq?: number` — never sent to the server, never persisted)
- Modify: `src/store/store.ts` (the root `configureStore` at :51 and its middleware concat chain at :85-102 — LB-16: NOT `src/store/index.ts`; add the middleware to the existing chain)

**Interfaces:**
- Consumes: `updatePaneTitleBySessionRef` (panesSlice.ts:2236, existing, `setByUser:false`-guarded; matches fresh-agent panes by `provider`+`sessionId` and terminal panes by `content.sessionRef` — Task 6 ALSO extends this action to update ALL matching panes in every tab; today it updates only the FIRST matching pane per tab via `findPaneIdBySessionRef`, :448-461), sessions slice state (`state.sessions.windows[surface].projects[]` rows carrying `sessionId`/`provider`/`title?`/`lastActivityAt`, sessionsSlice.ts:66-96; every committed row also carries the per-row client-side fetch stamp `fetchSeq` — a monotonic store-level counter (module-local in sessionsSlice.ts) stamped at the shared window-commit reducer `commitWindowPayload` (sessionsSlice.ts:234-243): each committed row that does not already carry a numeric `fetchSeq` gets the next counter value, so rows freshly fetched in a commit are strictly newer than rows RETAINED from an earlier fetch (the deep-page silent-refresh merge, sessionsThunks.ts:602-609, passes the previous window's row objects through unchanged — sessionsThunks.ts:184-204 — and the stamp field rides on the row object through both carry paths: normalizeProjects' reference pass-through at sessionsSlice.ts:43-64 or its `...session` spread at :80-83; no existing per-row field reflects fetch recency — `SessionDirectoryItem` carries only activity times `lastActivityAt`/`createdAt`, shared/read-models.ts:51-86, and `revision`/`snapshotSeq` are page-level, not per-row — hence the client-side counter) — which the row-selection rule below keys on; surfaces are `'sidebar' | 'history' | 'bootstrap'` per sessionsThunks.ts:27), and the pane-binding action types `panes/initLayout`, `panes/updatePaneContent`, `panes/mergePaneContent`, `panes/materializeFreshAgentSession`, `panes/reconcileTerminalSessionRefByTerminalId`, `panes/splitPane`, `panes/addPane`, `panes/restoreLayout`, `panes/hydratePanes` (all verified against panesSlice.ts — slice name `'panes'` at :1217; reducers at :1220/:1735/:1835/:1803/:2260 and splitPane :1302, addPane :1364, restoreLayout :1242, hydratePanes :2076; real binding paths: REST/MCP agent split via ui-commands.ts:119-127, sidebar split-open via Sidebar.tsx:551-562, tab-registry reconstruction via tab-registry-open.ts:278-280, machine-bootstrap/recovery-offer rebuild via machine-workspace.ts:95 + RecoveryOfferPanel.tsx:165, cross-window hydration via crossTabSync.ts:206-219).
- Produces: `export const sessionTitleMirrorMiddleware: Middleware` (registered once in the store setup).

- [ ] **Step 1: Write the failing behavioral test**

Create `test/unit/client/store/sessionTitleMirror.test.ts` (real reducers: tabs, panes, sessions; seed a fresh-agent pane the way `paneSessionTitleSync.test.ts` and `panesSlice.fresh-agent-reconcile.test.ts` do):

```typescript
import { configureStore } from '@reduxjs/toolkit'
import { describe, expect, it } from 'vitest'
import { sessionTitleMirrorMiddleware } from '@/store/sessionTitleMirror'
// exact slice exports per repo: tabsReducer, panesSlice.reducer, sessionsReducer

function buildStore() {
  return configureStore({
    reducer: { tabs: tabsReducer, panes: panesSlice.reducer, sessions: sessionsReducer },
    middleware: (gDM) => gDM().concat(sessionTitleMirrorMiddleware),
  })
}

function seedFreshAgentPane(store: ReturnType<typeof buildStore>, sessionId: string, provider = 'opencode') {
  store.dispatch(addTab({ id: 'tab-z', title: 'ZZ probe' }))
  store.dispatch(initLayout({
    tabId: 'tab-z', paneId: 'pane-z',
    content: { kind: 'fresh-agent', provider, sessionId, sessionType: 'code', sessionRef: { provider, sessionId } },
  }))
}

function landSessionRow(store: ReturnType<typeof buildStore>, row: {
  surface: string; sessionId: string; provider: string; title?: string; lastActivityAt?: number
}) {
  // LB-06: fetchSessionWindow is a hand-rolled thunk — there is NO
  // 'sessions/fetchSessionWindow/fulfilled' action. Land rows via the REAL
  // commit action the thunk dispatches (sessionsThunks.ts:610-629):
  store.dispatch({
    type: 'sessions/commitSessionWindowVisibleRefresh',
    payload: /* { surface: row.surface, projects: [{ ...project fields..., sessions: [{ ...row, lastActivityAt }] }] } — mirror the exact builder payload from sessionsThunks.ts:610-629 */,
  })
}

describe('sessionTitleMirrorMiddleware', () => {
  it('mirrors a session-directory title into a matching fresh-agent pane (the MCP-created-pane symptom)', () => {
    const store = buildStore()
    seedFreshAgentPane(store, 'sess-1')
    landSessionRow(store, { surface: 'sidebar', sessionId: 'sess-1', provider: 'opencode', title: 'ZZ probe summarize' })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('ZZ probe summarize')
    expect(store.getState().panes.paneTitleSetByUser['tab-z']?.['pane-z']).toBeFalsy()
  })

  it('never overwrites a user-set pane title', () => {
    const store = buildStore()
    seedFreshAgentPane(store, 'sess-1')
    store.dispatch(updatePaneTitle({ tabId: 'tab-z', paneId: 'pane-z', title: 'My name', setByUser: true }))
    landSessionRow(store, { surface: 'sidebar', sessionId: 'sess-1', provider: 'opencode', title: 'Directory title' })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('My name')
  })

  it('skips rows without a title and ignores non-sessions actions', () => {
    const store = buildStore()
    seedFreshAgentPane(store, 'sess-1')
    landSessionRow(store, { surface: 'sidebar', sessionId: 'sess-1', provider: 'opencode' })   // no title
    store.dispatch({ type: 'settings/updated', payload: {} })
    const title = store.getState().panes.paneTitles['tab-z']?.['pane-z']
    expect(title).toBeUndefined()   // still the derived default is NOT stored — initLayout seeds derived; assert whatever initLayout seeded, unchanged
  })

  it('does not re-dispatch when the mirrored title already equals the pane title', () => {
    const store = buildStore()
    seedFreshAgentPane(store, 'sess-1')
    landSessionRow(store, { surface: 'sidebar', sessionId: 'sess-1', provider: 'opencode', title: 'Same title' })
    const before = store.getState()
    landSessionRow(store, { surface: 'sidebar', sessionId: 'sess-1', provider: 'opencode', title: 'Same title' })
    expect(store.getState().panes).toBe(before.panes)
  })

  it('a row RETAINED from an older fetch does not beat a fresher row another window fetched later (the deep-page retention case)', () => {
    // The reviewer's window-freshness failure: the sidebar fetched the row
    // FIRST (old title), History fetched it fresher LATER (new title, same
    // lastActivityAt — a title override does not advance activity time),
    // and THEN the sidebar ran a deep-page silent refresh whose fresh page-1
    // did NOT include the session — the merged window RETAINED the old row
    // (sessionsThunks.ts:602-609) while commitWindowPayload stamped the
    // whole merged window with fresh lastLoadedAt/resultVersion
    // (sessionsSlice.ts:231-233). Under per-WINDOW arbitration that
    // retained old-title row would now win and regress the pane title;
    // under per-ROW fetchSeq the retained row keeps its OLD stamp and
    // History's fresher row keeps winning.
    const store = buildStore()
    seedFreshAgentPane(store, 'sess-1')
    landSessionRow(store, { surface: 'sidebar', sessionId: 'sess-1', provider: 'opencode', title: 'Retained sidebar title', lastActivityAt: 2_000 })
    landSessionRow(store, { surface: 'history', sessionId: 'sess-1', provider: 'opencode', title: 'Fresh history title', lastActivityAt: 2_000 })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('Fresh history title')
    // The later sidebar refresh: its payload is the merged window the real
    // thunk builds — the retained row carries its existing fetchSeq because
    // mergeProjects passes the previous window's row OBJECTS through
    // (sessionsThunks.ts:184-204). Simulate the merged payload faithfully
    // by committing the previous window's projects as-is.
    const retainedProjects = store.getState().sessions.windows['sidebar'].projects
    store.dispatch({
      type: 'sessions/commitSessionWindowVisibleRefresh',
      payload: { surface: 'sidebar', projects: retainedProjects },
    })
    // The window-level stamps are now the freshest of all three commits;
    // the retained row must STILL lose to History's row.
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('Fresh history title')
  })

  it('equal-activity rows fetched fresh by both windows: the later-fetched row wins (History holds the newer title)', () => {
    // No fake timers needed: fetchSeq is a monotonic counter keyed to commit
    // order, not wall-clock, so dispatch order IS freshness order.
    const store = buildStore()
    seedFreshAgentPane(store, 'sess-1')
    landSessionRow(store, { surface: 'sidebar', sessionId: 'sess-1', provider: 'opencode', title: 'Older sidebar title', lastActivityAt: 2_000 })
    landSessionRow(store, { surface: 'history', sessionId: 'sess-1', provider: 'opencode', title: 'Newer history title', lastActivityAt: 2_000 })
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('Newer history title')
  })

  it('titles a pane created AFTER its directory row is already loaded (the missed-ordering symptom)', () => {
    const store = buildStore()
    landSessionRow(store, { surface: 'sidebar', sessionId: 'sess-1', provider: 'opencode', title: 'ZZ probe summarize' })
    seedFreshAgentPane(store, 'sess-1')   // the pane arrives AFTER the row — panes/initLayout must re-fire the mirror
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('ZZ probe summarize')
    expect(store.getState().panes.paneTitleSetByUser['tab-z']?.['pane-z']).toBeFalsy()
  })

  it('a splitPane that binds a new pane to an already-landed session row mirrors the split pane (REST/MCP split binding path)', () => {
    const store = buildStore()
    seedFreshAgentPane(store, 'sess-1')
    landSessionRow(store, { surface: 'sidebar', sessionId: 'sess-1', provider: 'opencode', title: 'ZZ probe summarize' })
    // Split the fresh-agent pane the way the REST/MCP split path does
    // (ui-commands.ts pane.split → panes/splitPane), with the new pane
    // carrying a COPIED sessionRef bound to the same session:
    store.dispatch({
      type: 'panes/splitPane',
      payload: {
        tabId: 'tab-z', paneId: 'pane-z', direction: 'horizontal', newPaneId: 'pane-z-split',
        newContent: { kind: 'fresh-agent', provider: 'opencode', sessionId: 'sess-1', sessionType: 'code', sessionRef: { provider: 'opencode', sessionId: 'sess-1' } },
      },
    })
    // splitPane must be a mirror trigger: the directory row already landed,
    // so ONLY the split action can re-fire the fold for the new pane.
    expect(store.getState().panes.paneTitles['tab-z']['pane-z-split']).toBe('ZZ probe summarize')
    expect(store.getState().panes.paneTitleSetByUser['tab-z']?.['pane-z-split']).toBeFalsy()
  })

  it('mirrors into EVERY pane bound to the same session (two panes in one tab; the churn guard then rests)', () => {
    const store = buildStore()
    seedFreshAgentPane(store, 'sess-1')
    store.dispatch({
      type: 'panes/splitPane',
      payload: {
        tabId: 'tab-z', paneId: 'pane-z', direction: 'horizontal', newPaneId: 'pane-z-2',
        newContent: { kind: 'fresh-agent', provider: 'opencode', sessionId: 'sess-1', sessionType: 'code', sessionRef: { provider: 'opencode', sessionId: 'sess-1' } },
      },
    })
    landSessionRow(store, { surface: 'sidebar', sessionId: 'sess-1', provider: 'opencode', title: 'Both mirror' })
    // updatePaneTitleBySessionRef must update ALL matching panes, not just
    // the first match in the tab:
    expect(store.getState().panes.paneTitles['tab-z']['pane-z']).toBe('Both mirror')
    expect(store.getState().panes.paneTitles['tab-z']['pane-z-2']).toBe('Both mirror')
    // churn guard then rests: once every bound pane holds the title, a
    // re-landed identical row dispatches nothing.
    const before = store.getState()
    landSessionRow(store, { surface: 'sidebar', sessionId: 'sess-1', provider: 'opencode', title: 'Both mirror' })
    expect(store.getState().panes).toBe(before.panes)
  })
})
```

(Note: the third assertion must be pinned against whatever `initLayout` actually seeded for the fresh-agent pane — read the state and assert it did NOT change, rather than hard-coding a derived label.)

Registration pin (`test/unit/client/store/sessionTitleMirror.registration.test.ts`, new file — the production `src/store/store.ts` registration is otherwise untested): import the PRODUCTION store singleton — `import { store } from '@/store'` (`src/store/index.ts` re-exports `export * from './store'`; the singleton is `store` at store.ts:51, the real `configureStore` whose middleware chain Task 6 just extended) — in a jsdom environment whose localStorage starts EMPTY (fresh per test file; do not seed storage before import — the slices rehydrate at module eval). Seed a fresh-agent pane by dispatching the real `addTab` + `initLayout` action creators through THAT store, dispatch the real `commitSessionWindowVisibleRefresh` action creator (exported from `@/store/sessionsSlice`, :677) with a `{ surface: 'sidebar', projects: [{ projectPath, sessions: [{ sessionId, provider, title, lastActivityAt }] }] }` payload, and assert `store.getState().panes.paneTitles` mirrored the title — proving the middleware is registered in the production chain, not just hand-installed in test stores.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/store/sessionTitleMirror.test.ts test/unit/client/store/sessionTitleMirror.registration.test.ts`

Expected: FAIL — the module does not exist (import error, both suites).

- [ ] **Step 3: Add the minimal production implementation**

Create `src/store/sessionTitleMirror.ts`:

```typescript
import type { Middleware } from '@reduxjs/toolkit'
import { updatePaneTitleBySessionRef } from '@/store/panesSlice'
import type { RootState } from '@/store'

type TitledSessionRow = {
  provider: string
  sessionId: string
  title: string
  surface: string
  fetchSeq: number
}

/** Collect every session row that currently has a title, DEDUPED by
 * `${provider}:${sessionId}`: the same session can sit in several retained
 * windows (e.g. sidebar AND history), and a later refresh of a window does
 * NOT mean its rows are fresh — the deep-page silent refresh RETAINS older
 * rows (sessionsThunks.ts:602-609 merges the fresh page-1 over the stored
 * window; deeper rows survive as the SAME objects, sessionsThunks.ts:184-204)
 * while `commitWindowPayload` stamps the whole merged window with fresh
 * lastLoadedAt/resultVersion (sessionsSlice.ts:231-233). So the winner is
 * picked by per-ROW freshness, NOT by window stamps and NOT by row activity
 * (a title override does not touch `lastActivityAt`): the greatest
 * per-row `fetchSeq` — a monotonic client-side counter stamped at the
 * commit reducer on every inserted-or-updated row (rows the merge retained
 * keep their old stamps: the field lives on the row object and both carry
 * paths preserve it — the merge passes the same objects, and
 * normalizeProjects either passes references through (sessionsSlice.ts:43-64)
 * or spreads `...session` (:80-83)). No existing per-row field reflects
 * fetch recency (`SessionDirectoryItem` carries only activity times,
 * shared/read-models.ts:51-86; `revision`/`snapshotSeq` are page-level) —
 * hence the client-side counter. Tie (e.g. both rows unstamped → 0) →
 * deterministic surface order. Row shape and nesting
 * (windows[surface].projects[] → sessions[]) per sessionsSlice.ts:66-96;
 * surfaces are 'sidebar' | 'history' | 'bootstrap' (sessionsThunks.ts:27).
 * Adjust field names to the real normalized state, not to this sketch. */
const SURFACE_ORDER = ['sidebar', 'history', 'bootstrap']

function collectTitledSessionRows(sessions: RootState['sessions']): TitledSessionRow[] {
  const byKey = new Map<string, TitledSessionRow>()
  const windows = (sessions as unknown as { windows?: Record<string, { projects?: Array<Record<string, unknown>> }> })?.windows ?? {}
  for (const [surface, window] of Object.entries(windows)) {
    for (const project of window?.projects ?? []) {
      const sessionsList = (project?.sessions ?? []) as Array<Record<string, unknown>>
      for (const session of sessionsList) {
        const provider = session?.provider
        const sessionId = session?.sessionId
        const title = session?.title
        if (typeof provider === 'string' && typeof sessionId === 'string' && typeof title === 'string' && title) {
          const fetchSeq = typeof session?.fetchSeq === 'number' ? session.fetchSeq : 0
          const candidate: TitledSessionRow = { provider, sessionId, title, surface, fetchSeq }
          const key = `${provider}:${sessionId}`
          const existing = byKey.get(key)
          const fresherRow =
            !existing ||
            candidate.fetchSeq > existing.fetchSeq ||
            (candidate.fetchSeq === existing.fetchSeq &&
              SURFACE_ORDER.indexOf(candidate.surface) < SURFACE_ORDER.indexOf(existing.surface))
          if (fresherRow) {
            byKey.set(key, candidate)
          }
        }
      }
    }
  }
  return [...byKey.values()]
}

/** Any pane bound to this session holding a different title? Matches the
 * same rule updatePaneTitleBySessionRef's reducer uses (fresh-agent
 * provider+sessionId; terminal content.sessionRef — panesSlice.ts:448-461).
 * A pane whose user-set flag is true is NEVER a fold target — treat it as
 * NOT differing so no no-op dispatch fires for it on every refresh. */
function sessionTitleDiffers(panes: RootState['panes'], provider: string, sessionId: string, title: string): boolean {
  for (const [tabId, layout] of Object.entries(panes.layouts ?? {})) {
    if (!layout) continue
    const walk = (node: unknown): boolean => {
      if (!node || typeof node !== 'object') return false
      const n = node as { type?: string; id?: string; content?: Record<string, unknown>; children?: unknown[] }
      if (n.type === 'leaf') {
        const c = n.content ?? {}
        const matches =
          (c.kind === 'fresh-agent' && c.provider === provider && c.sessionId === sessionId) ||
          (typeof c.sessionRef === 'object' && c.sessionRef !== null &&
            ((c.sessionRef as Record<string, unknown>).provider === provider) &&
            ((c.sessionRef as Record<string, unknown>).sessionId === sessionId))
        if (matches) {
          if (panes.paneTitleSetByUser?.[tabId]?.[n.id ?? '']) return false
          if (((panes.paneTitles?.[tabId]?.[n.id ?? '']) ?? '') !== title) return true
        }
        return false
      }
      return (n.children ?? []).some(walk)
    }
    if (walk(layout)) return true
  }
  return false
}

/** Pane-binding actions that can introduce or re-bind a sessionRef AFTER
 * its directory row is already loaded (the MCP/REST-created-pane symptom:
 * the row lands via sessions/*, the pane arrives later via panes/*).
 * Exact generated action-type strings, verified against panesSlice.ts
 * (slice name 'panes'; reducers initLayout :1226, updatePaneContent :1741,
 * materializeFreshAgentSession :1809, mergePaneContent :1841,
 * reconcileTerminalSessionRefByTerminalId :2265, splitPane :1308,
 * addPane :1370, restoreLayout :1248, hydratePanes :2082). Real binding
 * paths for the four additions: panes/splitPane — REST/MCP agent split
 * (ui-commands.ts:119-127); panes/addPane — sidebar split-open
 * (Sidebar.tsx:551-562) and tab-registry reconstruction
 * (tab-registry-open.ts:278-280); panes/restoreLayout — the
 * machine-bootstrap/recovery-offer rebuild plan loops
 * (machine-workspace.ts:95, RecoveryOfferPanel.tsx:165);
 * panes/hydratePanes — cross-window hydration (crossTabSync.ts:206-219). */
const SESSION_BINDING_PANE_ACTIONS = new Set([
  'panes/initLayout',
  'panes/updatePaneContent',
  'panes/mergePaneContent',
  'panes/materializeFreshAgentSession',
  'panes/reconcileTerminalSessionRefByTerminalId',
  'panes/splitPane',
  'panes/addPane',
  'panes/restoreLayout',
  'panes/hydratePanes',
])

/**
 * Session-directory titles are the canonical names for agent sessions, but
 * only the composer flow ever folded them into panes — MCP/REST-created
 * panes stayed on derived defaults forever. This middleware folds titled
 * session rows into their open panes after every sessions-state change AND
 * after the pane-binding actions above (a pane created after its row is
 * loaded must still get titled — the missed-ordering case), through
 * updatePaneTitleBySessionRef with setByUser:false (rename scope
 * contract: user renames stick; nothing durable is written; no dispatch
 * when the title already matches).
 */
export const sessionTitleMirrorMiddleware: Middleware = (store) => (next) => (action) => {
  const result = next(action)
  const type = (action as { type?: unknown })?.type
  const fires =
    (typeof type === 'string' && type.startsWith('sessions/')) ||
    (typeof type === 'string' && SESSION_BINDING_PANE_ACTIONS.has(type))
  if (fires) {
    const state = store.getState() as RootState
    for (const row of collectTitledSessionRows(state.sessions)) {
      if (!sessionTitleDiffers(state.panes, row.provider, row.sessionId, row.title)) continue
      store.dispatch(updatePaneTitleBySessionRef({
        provider: row.provider, sessionId: row.sessionId, title: row.title, setByUser: false,
      }))
    }
  }
  return result
}
```

Register the middleware in `src/store/store.ts`'s existing middleware concat chain (:85-102); ordering is free — it only reads sessions state and writes panes actions, so it has no ordering constraints with persistMiddleware.

Also add the per-row fetch stamp the mirror keys on — `src/store/sessionsSlice.ts`, in the shared window-commit reducer `commitWindowPayload` (:227-244; both `commitSessionWindowReplacement` :383-402 and `commitSessionWindowVisibleRefresh` :403-426 funnel through it, so every fetch-fresh land is stamped):

```typescript
// module scope in sessionsSlice.ts:
let sessionRowFetchSeq = 0

// in commitWindowPayload, immediately after
// `window.projects = normalizeProjects(payload.projects)` (:231):
window.projects = window.projects.map((project) => ({
  ...project,
  sessions: (project.sessions ?? []).map((row) =>
    typeof (row as { fetchSeq?: unknown }).fetchSeq === 'number'
      ? row                                        // RETAINED row — keeps its old stamp
      : { ...row, fetchSeq: ++sessionRowFetchSeq }, // inserted-or-updated row (freshly fetched)
  ),
}))
```

Why "already carries a numeric fetchSeq ⇒ keep" is the right inserted-or-updated test: fresh server rows never carry the field (it is client-side only, `CodingCliSession.fetchSeq?` in src/store/types.ts — `SessionDirectoryItem` has no such field, shared/read-models.ts:51-86), while rows the deep-page merge retained arrive as the SAME objects with their stamps (sessionsThunks.ts:184-204), and even the defensive normalize path preserves the field via its `...session` spread (sessionsSlice.ts:80-83). Add the optional `fetchSeq?: number` to `CodingCliSession` (src/store/types.ts) — client-side only, never sent to the server, never persisted.

Also extend the ACTION `updatePaneTitleBySessionRef` in `src/store/panesSlice.ts` (:2242-2262): replace the per-tab `findPaneIdBySessionRef` single-match call (:448-461) with a walk over the existing `collectLeaves` helper (:495+) that updates EVERY matching pane — fresh-agent `provider`+`sessionId`, terminal `content.sessionRef` — in every tab, keeping the same per-pane `setByUser === false` user-set guard. Keep `updatePaneTitleByTerminalId` unchanged (out of scope). Line-neutral in the over-cap file (one helper call swapped for another walk; no net growth). Beyond the mirror's two-panes-one-tab case, this also fixes the same-session cascade for session renames: `applySessionRenameCascade` (titleSync.ts:42) dispatches this action, and today a second pane bound to the same session in any tab keeps the stale title. No existing test pins the first-match-only behavior (paneSessionTitleSync.test.ts:26-45 seeds one pane per session), so the extension is additive-green there.

- [ ] **Step 4: Run the focused tests**

Run: `npm run test:vitest -- run test/unit/client/store/sessionTitleMirror.test.ts test/unit/client/store/sessionTitleMirror.registration.test.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

If the sessions slice exposes an existing selector over titled rows, use it instead of the local collector. Keep the middleware churn-free (no dispatch when titles already match) and O(rows × panes)-bounded.

- [ ] **Step 6: Run impacted-test verification**

Impacted: sessions suites (the middleware reads sessions and writes panes; the `fetchSeq` stamping touches `commitWindowPayload` — sessionsSlice/sessionsThunks suites pin commit behavior, including the deep-page merge retention), paneSessionTitleSync family (also the action extension's consumers), sidebar click-driven folds (Sidebar.tsx:492 — unchanged; the mirror must not fight it since both write the same title).

Run: `npm run test:vitest -- run test/unit/client/store/sessionTitleMirror.test.ts test/unit/client/store/sessionsSlice.test.ts test/unit/client/store/sessionsThunks.test.ts test/unit/client/store/paneSessionTitleSync.test.ts test/unit/client/store/panesSlice.test.ts`

Expected: PASS (if an existing sessionsSlice/sessionsThunks pin asserts exact row object equality, extend it minimally with the new optional field rather than loosening it)

- [ ] **Step 7: Commit the task**

```bash
git add src/store/sessionTitleMirror.ts src/store/panesSlice.ts src/store/sessionsSlice.ts src/store/types.ts src/store/store.ts test/unit/client/store/sessionTitleMirror.test.ts test/unit/client/store/sessionTitleMirror.registration.test.ts
git commit -m "feat(client): mirror session-directory titles into open agent panes by sessionRef"
```

---

### Task 7: Cross-window pane-title hydration recency guard (mergeHydratedPaneMetadata)

**Files:**
- Create: `src/store/hydrate-pane-metadata-merge.ts` (the extracted pure merge function)
- Modify: `src/store/panesSlice.ts` (import the extracted merge; delete the private copy; pass `action.meta` through from `hydratePanes` — panesSlice must SHRINK, not grow)
- Test: `test/unit/client/store/panesSlice.test.ts` (extend the `hydratePanes` describe; the two existing pins at :2876/:2939 are the anchors)
- Test: modify `test/e2e-browser/specs/local-first-reload-rust.spec.ts` (append the cross-window recency scenario; the spec Task 4 created — its registration in BOTH config lists is already in place)

**Interfaces:**
- Consumes: `HydratePanesMeta` (`panesSlice.ts:37-40` — `localLayoutPersistedAt?`/`remoteLayoutPersistedAt?`, already dispatched by crossTabSync.ts:213-218), the tabs winner pattern (`pickHydratedTabWinner`, tabsSlice.ts:115-128) and its title reconcile analogue (`reconcileHydratedTabTitle`, tabsSlice.ts:137-142).
- Produces: `export function mergeHydratedPaneMetadata(state, incoming, layouts, incomingLayoutTabIds, meta?: HydratePanesMeta)` in the new module, imported by panesSlice. Behavior contract (tabs-style per-pane reconcile):
  - Recency BASE selection: meta absent (or present with NEITHER timestamp numeric) → the legacy layout-side base (incoming titles are the base when the incoming layout won); meta present (either timestamp is a number) → the incoming side is the base iff `(remoteLayoutPersistedAt ?? Number.NEGATIVE_INFINITY) > (localLayoutPersistedAt ?? Number.NEGATIVE_INFINITY)` — the tabs-exact coalesced comparison (`pickHydratedTabWinner`, tabsSlice.ts:115-128): a KNOWN remote beats a MISSING local (a newly received tab's incoming metadata applies), a known local beats a missing remote, and a numeric tie keeps LOCAL (conservative — never clobber on ambiguity).
  - Per-PANE reconciliation, applied on that base for every pane: if exactly one side's pane is user-set, that side's title wins AND its flag lands true; if both sides are user-set, the base (recency/layout winner) side's title stands with the flag true; otherwise the base source's title, with the flag = (either side's flag). Incoming user-set titles are therefore NEVER dropped, and a user-set flag can never freeze the wrong text — "user-set pane titles always survive" holds on both sides.

- [ ] **Step 1: Write the failing behavioral tests**

Append to the `hydratePanes` describe in `test/unit/client/store/panesSlice.test.ts`, next to the existing pins at :2876 (`crossTabMeta(now - 60_000, now)` helper at :2697):

```typescript
it('an older incoming layout no longer overwrites newer local pane titles even when the incoming layout wins', () => {
  // local: tab with a split layout, one pane holding a NEWER non-user-set title
  // incoming: same tab id, layout that wins the merge (incomingLayoutTabIds),
  //           paneTitles carrying an OLDER title, crossTabMeta(local=now, remote=now-60_000)
  const state = hydratePanesWith({
    local: localStateWithPaneTitle('tab-1', 'pane-1', 'Newer local title', { userSet: false }),
    incoming: incomingWithPaneTitles('tab-1', { 'pane-1': 'Older remote title' }),
    meta: crossTabMeta(Date.now(), Date.now() - 60_000),   // LOCAL is newer
  })
  expect(state.paneTitles['tab-1']['pane-1']).toBe('Newer local title')
})

it('a newer incoming layout still applies incoming titles for tabs it won', () => {
  const state = hydratePanesWith({
    local: localStateWithPaneTitle('tab-1', 'pane-1', 'Older local title', { userSet: false }),
    incoming: incomingWithPaneTitles('tab-1', { 'pane-1': 'Newer remote title' }),
    meta: crossTabMeta(Date.now() - 60_000, Date.now()),   // REMOTE is newer
  })
  expect(state.paneTitles['tab-1']['pane-1']).toBe('Newer remote title')
})

it('user-set local pane titles survive regardless of recency', () => {
  const state = hydratePanesWith({
    local: localStateWithPaneTitle('tab-1', 'pane-1', 'My frozen title', { userSet: true }),
    incoming: incomingWithPaneTitles('tab-1', { 'pane-1': 'Newer remote title' }),
    meta: crossTabMeta(Date.now() - 60_000, Date.now()),   // remote newer — user-set still wins
  })
  expect(state.paneTitles['tab-1']['pane-1']).toBe('My frozen title')
})

it('an incoming USER-SET title survives when the incoming layout wins (remote newer)', () => {
  const state = hydratePanesWith({
    local: localStateWithPaneTitle('tab-1', 'pane-1', 'Older local title', { userSet: false }),
    incoming: incomingWithPaneTitles('tab-1', { 'pane-1': 'Remote chosen name' }, { userSet: true }),
    meta: crossTabMeta(Date.now() - 60_000, Date.now()),   // remote newer — incoming user-set title + flag land
  })
  expect(state.paneTitles['tab-1']['pane-1']).toBe('Remote chosen name')
  expect(state.paneTitleSetByUser['tab-1']['pane-1']).toBe(true)
})

it('an incoming USER-SET title survives even when the local layout is preserved (remote older)', () => {
  const state = hydratePanesWith({
    local: localStateWithPaneTitle('tab-1', 'pane-1', 'Newer local title', { userSet: false }),
    incoming: incomingWithPaneTitles('tab-1', { 'pane-1': 'Remote chosen name' }, { userSet: true }),
    meta: crossTabMeta(Date.now(), Date.now() - 60_000),   // local newer — layout stays local, but the incoming USER-SET title still wins
  })
  expect(state.paneTitles['tab-1']['pane-1']).toBe('Remote chosen name')
  expect(state.paneTitleSetByUser['tab-1']['pane-1']).toBe(true)
})

it('both sides user-set: the recency winner\'s title stands, flag true', () => {
  const state = hydratePanesWith({
    local: localStateWithPaneTitle('tab-1', 'pane-1', 'Local mine', { userSet: true }),
    incoming: incomingWithPaneTitles('tab-1', { 'pane-1': 'Remote mine' }, { userSet: true }),
    meta: crossTabMeta(Date.now() - 60_000, Date.now()),   // remote newer — the incoming user-set title stands
  })
  expect(state.paneTitles['tab-1']['pane-1']).toBe('Remote mine')
  expect(state.paneTitleSetByUser['tab-1']['pane-1']).toBe(true)
})

it('keeps the legacy merge when no hydrate meta is provided', () => {
  const state = hydratePanesWith({
    local: localStateWithPaneTitle('tab-1', 'pane-1', 'Newer local title', { userSet: false }),
    incoming: incomingWithPaneTitles('tab-1', { 'pane-1': 'Older remote title' }),
    meta: undefined,
  })
  expect(state.paneTitles['tab-1']['pane-1']).toBe('Older remote title')   // current behavior preserved
})

it('a known remote timestamp beats a MISSING local stamp: a newly received tab\'s incoming titles apply (tabs-exact coalesced comparison)', () => {
  // The missing-local case the tabs contract already gets right
  // (pickHydratedTabWinner: known remote > missing local). tab-2 is NEW to
  // this window (its incoming layout wins by absence of a local one); the
  // meta carries a real remoteLayoutPersistedAt but NO localLayoutPersistedAt
  // (this window has not flushed its own envelope yet). The incoming title
  // must apply — pass the meta as an explicit literal; the suite's
  // crossTabMeta helper types both fields as numbers.
  const state = hydratePanesWith({
    local: localStateWithPaneTitle('tab-1', 'pane-1', 'Older local title', { userSet: false }),
    incoming: incomingWithPaneTitles('tab-2', { 'pane-2': 'Newly received title' }),
    meta: { localLayoutPersistedAt: undefined, remoteLayoutPersistedAt: Date.now() },
  })
  expect(state.paneTitles['tab-2']['pane-2']).toBe('Newly received title')
})
```

(`hydratePanesWith`/`localStateWithPaneTitle`/`incomingWithPaneTitles` wrap the hand-built `PanesState` + hydrate action idioms already used by the :2876/:2939 tests — reuse their builders so the fixtures produce an incoming layout that actually wins (`incomingLayoutTabIds`), and extend `incomingWithPaneTitles` with the optional `{ userSet }` arg shown above so the incoming side can seed `paneTitleSetByUser`.)

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/store/panesSlice.test.ts`

Expected: FAIL — the older-incoming-layout test fails (an older incoming layout currently overwrites the newer local title whenever the incoming layout wins), the incoming-user-set/local-preserved test fails (the current merge drops the incoming USER-SET title when the local layout is preserved while its flag still merges — freezing the wrong local text as user-set), AND the missing-local-stamp test fails (the current both-must-be-number rule treats a KNOWN remote as not-newer-than a MISSING local, so a newly received tab's incoming titles are dropped); the remaining new tests are contract pins that already pass and must KEEP passing, as must all pre-existing suite members.

- [ ] **Step 3: Add the minimal production implementation**

Extract the current `mergeHydratedPaneMetadata` (panesSlice.ts:572-642) VERBATIM into `src/store/hydrate-pane-metadata-merge.ts`, exporting it plus the meta type if needed, and add the recency rule:

```typescript
import type { HydratePanesMeta } from '@/store/panesSlice'   // or move the type here and re-export

/** Tabs-style per-PANE title/flag reconcile — the `reconcileHydratedTabTitle`
 * analogue (tabsSlice.ts:137-142). A user-set title ALWAYS survives, and a
 * user-set flag never freezes the wrong text:
 *  - base side already user-set → it stands (covers both-user-set: the base
 *    is the recency/layout winner, so its title stands) with the flag true;
 *  - exactly one side user-set  → that side's title wins, flag true;
 *  - neither user-set           → the base side's title, flag = either side's flag. */
function reconcilePaneTitle(
  local: { title?: string; userSet?: boolean } | undefined,
  incoming: { title?: string; userSet?: boolean } | undefined,
  base: { title?: string; userSet?: boolean },
): { title?: string; userSet?: boolean } {
  if (base.userSet) return base
  const userSide = local?.userSet ? local : incoming?.userSet ? incoming : undefined
  if (userSide) return { title: userSide.title, userSet: true }
  return { title: base.title, userSet: !!(local?.userSet || incoming?.userSet) }
}

export function mergeHydratedPaneMetadata(
  state: Pick<PanesState, 'paneTitles' | 'paneTitleSetByUser'>,
  incoming: HydratePanesPayload,
  layouts: Record<string, PaneNode>,
  incomingLayoutTabIds: Set<string>,
  meta?: HydratePanesMeta,
): { activePane: ...; paneTitles: ...; paneTitleSetByUser: ... } {
  // Tabs winner pattern (tabsSlice.ts pickHydratedTabWinner :115-128) for the
  // TITLE BASE — the SAME coalesced comparison the tabs path uses, not a
  // both-must-be-number rule: meta counts as present when EITHER timestamp
  // is a number, and a KNOWN remote beats a MISSING local (a newly received
  // tab's incoming metadata applies) while a numeric tie keeps LOCAL
  // (conservative — never clobber on ambiguity). No meta (or neither
  // timestamp numeric) → legacy behavior (the incoming side is the base
  // when the incoming layout won).
  const metaPresent =
    meta !== undefined &&
    (typeof meta.remoteLayoutPersistedAt === 'number' || typeof meta.localLayoutPersistedAt === 'number')
  const remoteStrictlyNewer = metaPresent
    ? (meta!.remoteLayoutPersistedAt ?? Number.NEGATIVE_INFINITY) >
      (meta!.localLayoutPersistedAt ?? Number.NEGATIVE_INFINITY)
    : false

  for (const [tabId, layout] of Object.entries(layouts)) {
    const localLayoutPreserved = !incomingLayoutTabIds.has(tabId)
    const incomingIsBase = !metaPresent
      ? !localLayoutPreserved                        // legacy: incoming layout won → incoming base
      : !localLayoutPreserved && remoteStrictlyNewer // recency-guarded: an older remote is never the base
    const baseTitles = incomingIsBase ? incoming.paneTitles : state.paneTitles
    const baseFlags = incomingIsBase ? incoming.paneTitleSetByUser : state.paneTitleSetByUser
    // ... rest of the current merge body, but each pane's title/flag decision
    // goes through reconcilePaneTitle(
    //   { title: state.paneTitles?.[tabId]?.[paneId], userSet: state.paneTitleSetByUser?.[tabId]?.[paneId] },
    //   { title: incoming.paneTitles?.[tabId]?.[paneId], userSet: incoming.paneTitleSetByUser?.[tabId]?.[paneId] },
    //   { title: baseTitles?.[tabId]?.[paneId], userSet: baseFlags?.[tabId]?.[paneId] },
    // ) instead of copying the base side unconditionally. The existing
    // local-user-set re-application is subsumed by reconcilePaneTitle's
    // exactly-one-side-user-set arm; keep every other part of the merge
    // (active pane, layouts, tabId iteration) unchanged.
  }
}
```

(The exact `state`/return types come from the moved function — move it as-is, change only the `preferredTitleSource` selection and the added parameter. In `panesSlice.ts`, delete the private copy, import the moved function, and pass `action.meta` from `hydratePanes` at the call site (~:2121). panesSlice.ts must net-SHRINK by roughly the moved function's size.)

- [ ] **Step 4: Run the focused tests**

Run: `npm run test:vitest -- run test/unit/client/store/panesSlice.test.ts`

Expected: PASS (new pins + all 5000-line suite members)

- [ ] **Step 5: Refactor while green**

With the merge extracted, confirm the module boundary is clean: `hydrate-pane-metadata-merge.ts` is pure (no store import), typed over the slice's own types, and panesSlice's `hydratePanes` remains its only caller.

- [ ] **Step 6: Extend `local-first-reload-rust.spec.ts` with the cross-window recency scenario (e2e pin)**

Add a third serial test to the spec Task 4 created — extending the existing file is cleaner than a new spec, and its registration in BOTH config lists is already in place. Two pages in ONE browser context drive the real cross-tab hydrate channel (storage events + BroadcastChannel, crossTabSync.ts:301-370); the two-pages-one-context idiom is `const page2 = await page.context().newPage()` (multi-client.spec.ts:198-199 — read it and layout-sync-authoritative.spec.ts first, as this plan's verification did).

CRITICAL context hurdle: this test runs serially AFTER Scenarios 1-2, so the owned server already has a machine — and the `page` fixture is a FRESH per-test context with no remembered selection. Its first navigation would open the machine chooser (machine-identity.ts:216-222: `getSelectedMachineId` finds nothing and `machines.length > 0` → `{ kind: 'chooser' }`) and `waitForConnection` would time out — the scenario was unreachable as first sketched. The fix mirrors the donor idiom (multi-client.spec.ts:195-209, the 'two browser tabs share the same server' test): ONE shared context — `page1 = await context.newPage()` (:198) boots FIRST (:201) and its boot persists the machine selection into the shared localStorage, then `page2 = await context.newPage()` (:199) navigates (:202) and resolves the SAVED machine without the chooser (:205-206). The donor's second page inherits the selection from the first page's boot inside one context; a fresh context has no such boot, so seed it: `addInitScript` writes the machine-selection payload Task 4's Scenario 1 captured at spec scope (`machineSelectionStorage`) into localStorage BEFORE the first navigation. This is a SEEDING init script, not the clearing kind LB-08 forbids — it writes the same value the boot itself would persist, on every load, idempotently; it does not touch sessionStorage or the clientInstanceId.

```typescript
test('an older persisted layout from a second page does not clobber a newer local pane title', async ({ page }) => {
  // Establish the remembered machine in this FRESH context BEFORE first
  // navigation (see the donor-idiom note above): seed the payload Scenario 1
  // captured, then boot page1 — it resolves the seeded machine (kind
  // 'selected', machine-identity.ts:191-214) with NO chooser.
  test.skip(!machineSelectionStorage, 'Scenario 1 must have captured the machine-selection payload')
  await page.addInitScript((payload) => {
    for (const [key, value] of Object.entries(payload)) localStorage.setItem(key, value)
  }, machineSelectionStorage)

  await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()

  // Remove the auto-created shell tab first (Task 4's idiom: read the tab id
  // from the harness state, dispatch tabs/removeTab with the BARE id).
  await harness.waitForTabCount(1)
  await page.evaluate(() => {
    const state = window.__FRESHELL_TEST_HARNESS__?.getState()
    const autoId = state?.tabs?.tabs?.[0]?.id
    if (autoId) window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'tabs/removeTab', payload: autoId })
  })

  // Seed the workspace (Task 4's dispatch idiom: one tab + editor pane).
  await page.evaluate(() => {
    window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'tabs/addTab', payload: { id: 'tab-mango', title: 'Mango' } })
    window.__FRESHELL_TEST_HARNESS__?.dispatch({
      type: 'panes/initLayout',
      payload: {
        tabId: 'tab-mango', paneId: 'tab-mango-pane',
        content: { kind: 'editor', filePath: '/tmp/mango.md', language: null, readOnly: false, content: '', viewMode: 'source', wordWrap: true },
      },
    })
  })
  await waitForPersistedEnvelope(page, (env) =>
    typeof env.machineId === 'string' && env.machineId.length > 0 && env.tabs?.tabs?.length === 1)

  // page2 opens in the SAME context (shared localStorage — the donor's
  // `page.context().newPage()` idiom, multi-client.spec.ts:199) and
  // rehydrates the envelope; it resolves the same saved machine (the
  // donor's second-page mechanism, :202/:205-206) — no init script needed.
  const page2 = await page.context().newPage()
  await page2.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
  const harness2 = new TestHarness(page2)
  await harness2.waitForHarness(); await harness2.waitForConnection()

  // page2 sets a NEWER non-user-set pane title and forces an immediate
  // flush (the donor's flushPersistedLayout idiom, multi-client.spec.ts:
  // 177-185: dispatch 'persist/flushNow'), then poll the shared envelope
  // until it carries the new title — capturing its persistedAt as tLocal
  // (page2's local stamp).
  await page2.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.dispatch({
    type: 'panes/updatePaneTitle',
    payload: { tabId: 'tab-mango', paneId: 'tab-mango-pane', title: 'Newer local title', setByUser: false },
  }))
  await page2.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' }))
  const tLocal = await waitForPersistedEnvelopeTitled(page, 'Newer local title')

  // Let page1's response settle BEFORE staging: page2's flush fires a
  // storage event on page1, whose crossTabSync hydrates and schedules its
  // own debounced reflush — wait that cycle out so the staged write below
  // is the LAST envelope write.
  await page.waitForTimeout(2_000)

  // Stage the STALE remote: from page1, mutate the shared localStorage
  // envelope in place — same JSON, the pane title reverted, persistedAt
  // 60s OLDER than page2's local stamp. page1's write fires a storage
  // event on page2 only — the real crossTabSync path hydrates page2 with
  // remoteLayoutPersistedAt < localLayoutPersistedAt.
  // Envelope shape verified against the real writer/reader:
  //  - paneTitles live at panes.paneTitles (persistMiddleware.ts:625-654
  //    writes `panes: persistablePanesSection` — the state.panes spread
  //    minus volatile fields; parsed at persistedState.ts:553). The old
  //    sketch's top-level `env.paneTitles` dereferenced undefined and
  //    threw — fixed.
  //  - persistedAt is TOP-LEVEL (persistMiddleware.ts:647, read at
  //    persistedState.ts:557).
  //  - the storage key literal 'freshell.layout.v3' matches
  //    LAYOUT_STORAGE_KEY (storage-keys.ts:2/:25).
  //  - Task 1's machineId is TOP-LEVEL; the staging touches ONLY the
  //    title and persistedAt, so the stamp (and everything else) is
  //    preserved.
  await page.evaluate((tLocal) => {
    const env = JSON.parse(localStorage.getItem('freshell.layout.v3') ?? '{}')
    env.panes.paneTitles['tab-mango']['tab-mango-pane'] = 'Stale from page1'
    env.persistedAt = tLocal - 60_000
    localStorage.setItem('freshell.layout.v3', JSON.stringify(env))
  }, tLocal)

  // Bounded settle for the storage-event hydration, then ONE hard read (not a
  // poll — a poll could sample before the hydrate lands and false-pass).
  await page2.waitForTimeout(2_000)
  const title = await page2.evaluate(() =>
    window.__FRESHELL_TEST_HARNESS__?.getState()?.panes?.paneTitles?.['tab-mango']?.['tab-mango-pane'])
  expect(title).toBe('Newer local title')
})

/** Bounded poll until the shared envelope's pane title equals the given
 * value; resolves the envelope's persistedAt (the writer's stamp — tLocal
 * for the page2 flush this scenario tracks). Node-side predicate over one
 * plain JSON.parse read per round (same shape as waitForPersistedEnvelope). */
async function waitForPersistedEnvelopeTitled(
  page: import('playwright').Page,
  expectedTitle: string,
  timeoutMs = 10_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const persistedAt = await page.evaluate((title) => {
      try {
        const env = JSON.parse(localStorage.getItem('freshell.layout.v3') ?? 'null')
        if (env?.panes?.paneTitles?.['tab-mango']?.['tab-mango-pane'] === title
          && typeof env.persistedAt === 'number') {
          return env.persistedAt
        }
        return null
      } catch { return null }
    }, expectedTitle)
    if (typeof persistedAt === 'number') return persistedAt
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`persisted envelope did not carry the pane title '${expectedTitle}' within ${timeoutMs}ms`)
}
```

The failure mode this scenario pins: with the seeded context both pages connect; when the recency guard is missing, the incoming layout wins the merge for its tab id and the incoming title clobbers page2's newer local title (the read returns 'Stale from page1'). With Task 7 it PASSES (remote not strictly newer → local base; per-pane reconcile keeps the non-user-set local title). The full production path is exercised — real storage-event hydration with real `localLayoutPersistedAt`/`remoteLayoutPersistedAt` meta. (A standalone at-base red is unreachable: the spec is serial and Scenario 1's Task-4 red gates the run — so the Step 2 unit reds are this task's recorded red evidence, and the Task 4 Step 2 throwaway receipt documents the spec-level red. The direct stale-envelope write is the deterministic staging of an interleaved older flush — a real flush from page1 would stamp Date.now() and be newer, not older.)

Then run it: `bash scripts/e2e-cloud.sh run --local --project=rust-chromium test/e2e-browser/specs/local-first-reload-rust.spec.ts` — Expected: PASS (all three scenarios; the first two unchanged from Task 4).

- [ ] **Step 7: Run impacted-test verification**

Impacted: every `hydratePanes` consumer — panesSlice suites, `paneCloseGate.test.ts`, `panesPersistence.test.ts`, `createRequestIdStability.test.ts`, `crossTabSync.test.ts` (14 refs), and the component suites that dispatch hydrate actions.

Run: `npm run test:vitest -- run test/unit/client/store/panesSlice.test.ts test/unit/client/store/paneCloseGate.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/createRequestIdStability.test.ts test/unit/client/store/crossTabSync.test.ts`

Expected: PASS

- [ ] **Step 8: Commit the task**

```bash
git add src/store/hydrate-pane-metadata-merge.ts src/store/panesSlice.ts test/unit/client/store/panesSlice.test.ts test/e2e-browser/specs/local-first-reload-rust.spec.ts
git commit -m "fix(panes): cross-window pane-title hydration respects layout recency and preserves user-set titles on both sides"
```

---

### Task 8: E2e — pane-title delivery folds (terminal inventory + session-directory mirror)

**Files:**
- Create: `test/e2e-browser/specs/pane-title-folds-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (`RUST_ONLY_SPECS` ~:187 AND the `rust-chromium` project `testMatch` ~:430-660 — BOTH lists, same past-bug class as Task 4)

**Interfaces:**
- Consumes: the owned `RustServer` fixture + its `setupHome` hook (`helpers/rust-server.ts` — populates the isolated HOME before boot), `ensureRustServerBuilt`, the harness dispatch seam `window.__FRESHELL_TEST_HARNESS__`, the authenticated-REST idiom (`fetch` + `x-auth-token` header, layout-sync-authoritative.spec.ts:43-50), and the fake-session seeding idioms (recover-my-panes-rust.spec.ts:1479-1512 JSONL seed; session-directory-matrix.spec.ts's `setupHome` shapes at :114-297 — read both first, as this plan's verification did).
- Produces: the e2e pins for Tasks 5-6 (no production code in this task).

- [ ] **Step 1: Write the e2e spec — two scenarios**

Create `test/e2e-browser/specs/pane-title-folds-rust.spec.ts` (owned `RustServer`, fresh `FRESHELL_HOME`, `test.describe.configure({ mode: 'serial' })`, one owned server per scenario so Scenario B's seeded home never sees Scenario A's terminal):

**Scenario A — terminal.inventory title fold (Task 5's story):**
1. Boot the owned server; navigate; harness + connection; remove the auto-created shell tab (Task 4's idiom: read the tab id from the harness state, dispatch `tabs/removeTab` with the BARE id payload).
2. Create a shell terminal pane via harness dispatch: `tabs/addTab` + `panes/initLayout` with `content: { kind: 'terminal', mode: 'shell', createRequestId: 'cr-t8-a', status: 'creating' }` (`'creating'` is a real `TerminalStatus` — 'creating' | 'running' | 'recovering' | 'exited' | 'error', src/store/types.ts:1; the WS-flap create re-drive also requires it, TerminalView.tsx:5284-5285); poll the harness state until the pane content carries a real `terminalId` (the mounted pane's TerminalView drives `terminal.create` from the createRequestId when the content has no terminalId, TerminalView.tsx:5391-5443; the WS `terminal.created` fold writes it).
3. Rename the terminal over REST — the auto-title sweep is structurally blind to terminal renames, and the PATCH broadcasts `terminals.changed` (terminals.rs:1011, :1056-1060), NOT `terminal.title.updated`, so the live `terminal.title.updated` pane-title fold (TerminalView.tsx:4775-4781) never fires for this rename — the inventory fold is the ONLY delivery: `PATCH /api/terminals/<terminalId>` with body `{ "titleOverride": "Renamed via REST" }` and header `x-auth-token` (route verified: handler `patch_terminal` at crates/freshell-server/src/terminals.rs:908-1013, route registration `/api/terminals/{terminal_id}` PATCH at :102-111; `TerminalPatchSchema`'s string field is `titleOverride`, validated at :951-956 with max 500 chars at :75; the PATCH write-throughs the registry title at :1005-1007, which is what the inventory rows read).
4. `page.reload()`; wait harness + connection (the server sends `terminal.inventory` on every connect).
5. Assert `panes.paneTitles[tabId][paneId] === 'Renamed via REST'` and `paneTitleSetByUser` falsy.
   At base this FAILS: nothing folds the inventory title into pane titles, so the pane keeps its derived default.

**Scenario B — session-directory title mirror (Task 6's story):**
1. Boot a second owned `RustServer` with the `setupHome` hook seeding a Claude session row the recover-my-panes way (verified idiom, recover-my-panes-rust.spec.ts:1479-1512):

```typescript
const SEED_SESSION_ID = 'sess-t8-b'
const SEED_PROJECT = 't8-mirror-probe'
server = new RustServer({
  setupHome: async (homeDir) => {
    const sessionDir = path.join(homeDir, '.claude', 'projects', SEED_PROJECT)
    fs.mkdirSync(sessionDir, { recursive: true })
    const lines = [
      // system/init line: { type: 'system', subtype: 'init', session_id, uuid, timestamp, cwd: <homeDir>/<SEED_PROJECT>, git: {...} }
      // then TWO user/assistant turn pairs — a single-user-message session is
      // flagged isNonInteractive and hidden by the directory (the recover-my-panes
      // note at :1478-1480); copy the exact seededLines shape from :1495-1512.
    ]
    fs.writeFileSync(path.join(sessionDir, `${SEED_SESSION_ID}.jsonl`), lines.join('\n') + '\n')
  },
})
```

2. Navigate; wait harness + connection; remove the auto-created shell tab FIRST (Task 4's idiom: read the tab id from the harness state, dispatch `tabs/removeTab` with the BARE id payload — the fresh home auto-creates a shell tab whose layout would otherwise own the pane tree); poll the harness state until the seeded row appears in the sessions window (`sessions.windows.sidebar.projects[].sessions[]` — the App fetches `/api/session-directory` and the server's live watcher indexes the seeded file without a restart, per the recover-my-panes/auto-title precedences).
3. Create the pane PROPERLY — `panes/initLayout` no-ops when `state.layouts[tabId]` already exists (panesSlice.ts:1227), so it can never claim the auto shell tab's layout, and an initLayout for a tab id that was never added would orphan the layout (the loader drops it; the pane never mounts). So: `tabs/addTab` with an explicit id (`{ id: 'tab-mirror', title: 'Mirror probe' }`), then `panes/initLayout` with `{ tabId: 'tab-mirror', paneId: 'pane-mirror', content: { kind: 'fresh-agent', provider: 'claude', sessionId: SEED_SESSION_ID, sessionType: 'freshclaude', sessionRef: { provider: 'claude', sessionId: SEED_SESSION_ID } } }` — the normalized fresh-agent content shape (layout-sync-authoritative.spec.ts:345-351), whose provider+sessionId match the seeded session row.
4. Assert the pane title mirrors the session-directory row's `title` (read the actual row title from the harness sessions state — for a Claude row the directory derives it from the seeded project path — do not hard-code), with `paneTitleSetByUser` falsy.
   At base this FAILS: an MCP/REST-created pane never receives the directory title (the exact symptom Task 6 fixes).

Cloud-runnable by construction: no external coding-CLI binaries (Scenario A's pane is a default shell; Scenario B's pane is a store-dispatched fresh-agent pane against a seeded, non-running session — nothing spawns). Registration (BOTH lists — the known past-bug class):

```typescript
// RUST_ONLY_SPECS (~:187): add
/pane-title-folds-rust\.spec\.ts$/,
// rust-chromium project testMatch (~:430-660): append the same regex.
```

- [ ] **Step 2: Run the spec in the real worktree — EXPECT PASS (it pins landed Tasks 5-6)**

Run: `bash scripts/e2e-cloud.sh run --local --project=rust-chromium test/e2e-browser/specs/pane-title-folds-rust.spec.ts`

Expected: PASS (both scenarios). Not red-first: Tasks 5-6 are landed and unit-green; the scenario texts record the at-base failure modes (for a recorded red, reuse Task 4 Step 2's throwaway-receipt mechanism at base). If it fails for harness reasons, fix the SPEC, not production code.

- [ ] **Step 3: Refactor while green**

Keep poll helpers inside the spec file (other runs own the shared helper files); keep each scenario on its own owned server.

- [ ] **Step 4: Run impacted-test verification**

The config edit affects e2e collection only. Verify registration in BOTH lists (Task 4 Step 5's checks, adapted):

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts --project=chromium --list 2>/dev/null | grep -c 'pane-title-folds' || true`

Expected: 0

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium --list | grep 'pane-title-folds'`

Expected: at least one listed test.

- [ ] **Step 5: Commit the task**

```bash
git add test/e2e-browser/specs/pane-title-folds-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): pin pane-title delivery folds — terminal inventory titles and session-directory mirror"
```

---

## End-of-execution verification (after all tasks)

**Coverage decision:** every task has BOTH unit and e2e coverage, per the repo rule. Spec map: `local-first-reload-rust.spec.ts` (Task 4) covers Tasks 1-3 (healthy reload keeps the workspace exactly; corrupt envelope rebuilds from the own snapshot with preserved ids) and — via its Scenario 3 extension (Task 7 Step 6) — the cross-window pane-title recency guard; `pane-title-folds-rust.spec.ts` (Task 8) covers Task 5 (terminal.inventory title fold after a REST terminal rename + reload) and Task 6 (session-directory title mirrored into a harness-dispatched fresh-agent pane). The session-directory seeding mechanism (fake-CLI session files under the owned server's isolated home — `recover-my-panes-rust.spec.ts` fixtures / `session-directory-matrix.spec.ts`'s `setupHome`) makes the Task 6 lane cloud-runnable without live coding-CLI binaries. The LB-14 watch-item stays: watch the mandated cloud-lane runs for `rest-tab-persistence`-class timing sensitivity in the new specs' bounded persistence polls.

1. `npm run typecheck` — Expected: PASS
2. `npm run lint` — Expected: PASS
3. Coordinated full suite with the shared gate (check `npm run test:status` first; set `FRESHELL_TEST_SUMMARY="pane-title-recovery end-of-execution gate"`; export the cloud env vars if unset — see Global Constraints): `npm test` — Expected: PASS excluding any ledger-recorded pre-existing failures (none expected: the base was green at `bab7d5189`; the known `recover-my-panes-rust.spec.ts` scenario-1 failure is in the separate e2e lane, not this suite)
4. E2e on the configured backend: BOTH new specs must pass on the local rust lane (already run in Tasks 4/7/8) AND the cloud lane before any PR is proposed: with `FRESHELL_E2E_BACKEND=cloud` and `GCLOUD_IDENT` exported, run the cloud lane filtered to `local-first-reload-rust.spec.ts` (including Task 7's Scenario 3) and to `pane-title-folds-rust.spec.ts` — Expected: PASS for both, and confirm neither spec is in `CLOUD_SKIP_SPECS`.


