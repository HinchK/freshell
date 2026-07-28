# createRequestId Key Stabilization Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Make `createRequestId` a stable pane identity key: the client preserves it across hydrate/reload, the Rust REST ingress mints one for every terminal pane it creates, and the tabs-snapshot pipeline persists it end-to-end (client snapshot builder → wire → Rust validator → `pane_to_create_body`), with old snapshots that lack the field remaining valid.

**Architecture:** Three thin, independent seams. (1) Client: `normalizePaneContent` in `src/store/panesSlice.ts` gains a `previous`-content fallback for `createRequestId` — the exact pattern already proven for `browserInstanceId` — so hydrate never re-mints when a local key exists; the boot-path fallback mint at `src/store/persistMiddleware.ts:229` (`content.createRequestId || nanoid()`) already preserves-when-present and stays as the genuinely-absent (legacy-migration) mint, locked by a new test. (2) Rust REST ingress: `spawn_terminal_pane` in `crates/freshell-freshagent/src/terminal_tabs.rs` accepts a caller-supplied `createRequestId` (else mints a `Uuid::new_v4().simple()`), stamps it into the terminal registry (the `create_request_id` parameter already exists — it currently receives `None`), and emits it in the terminal `paneContent`; this one pipeline covers `POST /api/tabs`, `POST /api/panes/:id/split`, AND `POST /api/panes/:id/respawn` (rotation-on-respawn is intentional legacy parity). (3) Snapshots: the client snapshot builder emits `payload.createRequestId`, the snapshot validator is deliberately left UNCHANGED — its unknown-field tolerance already round-trips the string, and because write-accept and read share `validate_generation`, ANY strict check there would make one wrong-typed on-disk value render the whole device (and the device listing) unreadable; Task 4 locks the tolerance with tests instead, and `pane_to_create_body` passes it through into the restore create body, which the Task-3 ingress then honors — so snapshot-restored panes keep their original key.

**Tech Stack:** TypeScript/React/Redux Toolkit client (vitest, jsdom), Rust workspace crates `freshell-freshagent` / `freshell-ws` / `freshell-server` (cargo test, axum + tower oneshot test style), Playwright e2e against an owned `RustServer` instance.

## Global Constraints

- Work ONLY inside the worktree `/home/dan/code/freshell/.worktrees/createrequestid-stabilization` (branch based on `origin/main @ c491aee0`). All relative paths below are relative to this worktree root.
- **Scope fence (owned files):** `src/store/panesSlice.ts` + persisted-state hydrate path, `src/store/persistMiddleware.ts` (behavior locked by test; no code change expected), `src/lib/tab-registry-snapshot.ts`, `crates/freshell-ws/src/tabs_persist_validation_tests.rs` (new; `tabs_persist_tests.rs` is Lane A6's to modify — do not touch it) + a 3-line `#[cfg(test)]` test-module registration at the end of `crates/freshell-ws/src/tabs_persist_validation.rs` (`tabs_persist.rs` itself is at 999 lines against the 1,000-line cap, `port/AGENTS.md:81` — do not add lines to it), `crates/freshell-server/src/tabs_snapshots.rs` `pane_to_create_body` (+ its test files), `crates/freshell-freshagent` pane-create ingress (`terminal_tabs.rs`, `pane_ops.rs` tests only), plus two port-parity bookkeeping docs written in Task 7 only: `port/oracle/DEVIATIONS.md` (append one EDEV entry) and `port/contract/nondeterministic-fields.md` (one table-row edit).
- **Do NOT touch:** `crates/freshell-ws/src/tabs_persist.rs` caps/eviction (Lane A6 owns it), `src/components/TerminalView.tsx` / `src/components/fresh-agent/FreshAgentView.tsx` reconnect handlers (Lane A4), `crates/freshell-freshagent` `claude.rs`/`snapshot.rs` (Lane A2), `crates/freshell-terminal/src/registry.rs` (Lane A5 — we only pass a value to its existing `create_request_id` parameter, with ONE documented exception: Task 3 makes `fn probe_create_request_id` `pub` (`registry.rs:1578`) — a one-word visibility change, no behavior change — so `freshell-freshagent` tests can assert the registry stamp; Lane A5 (scrollback-persistence) owns this file and is appending a 10th trailing `scrollback` param to `TerminalRegistry::create`, so whichever lane lands second takes a small mechanical rebase here), `crates/freshell-ws/src/reconcile.rs`. No kimi/gemini/opencode-fresh-agent changes.
- **Do NOT change recreate semantics:** `clearTerminalContentForRecreate` (`panesSlice.ts:525-548`), `restartFreshAgentCreate` (`:1448`), `stripStaleIds`/`normalizeRestoredTree` (`:812-846`, the `restoreLayout` fresh-identity path), and the `FreshAgentView` new-session/fork mints are **intentional per-recreate mints**. They must keep rotating the key. The existing suites (`panesSlice.test.ts`, `crossTabSync.test.ts`, `terminal-restore.test.ts`) already assert this rotation and serve as the regression gate.
- Red-Green-Refactor TDD for every change. Frequent, focused, atomic commits.
- Broad npm suites (`npm test`, `npm run check`, `npm run test:unit`) go through the shared coordinator gate: check `npm run test:status` first; if another agent holds the gate, **WAIT — never kill a foreign holder** (5 sibling lanes run concurrently). Set `FRESHELL_TEST_SUMMARY="lane A1 createRequestId <phase>"` on every gated run. Focused vitest runs (`npm run test:vitest -- run <files> --config config/vitest/vitest.config.ts`) and `cargo test` and Playwright e2e are NOT gated.
- E2E: own `RustServer` instances via `test/e2e-browser/helpers/rust-server.ts` fixtures only — ephemeral ports, **NEVER 3001/3002**. New specs are new files; the `playwright.config.ts` append must be minimal (5 sibling lanes also append — trivial conflicts there are expected and fine).
- NEVER restart the user's self-hosted server. NEVER use broad kill patterns. Disk has ~36 GB free — on ENOSPC, halt and report; do not delete anything outside this worktree.
- `port/AGENTS.md:81` imposes a 1,000-line-per-file limit on Rust files. `crates/freshell-server/src/tabs_snapshots.rs` is currently **exactly 1000 lines** — Task 5 pairs its addition with an extraction using the file's established `#[path]`-sibling pattern.
- Rust CI gates: `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings` must pass.
- **PR policy: NOT approved.** Push the branch, STOP before `gh pr create`, report branch + red→green proof.
- README.md is the only end-user markdown doc; this plan under `docs/plans/` is a working/agent doc. Do not create other markdown docs.
- The campaign plan `/home/dan/code/freshell/docs/plans/2026-07-24-restart-resilience-architecture-analysis.md` is UNTRACKED in the main checkout — never commit it or copy it into this worktree.

### Deviation-budget bookkeeping (reconciliation-handshake design §13)

The design doc's frozen-client deviation budget (8 files) must be re-counted at Phase-3 adoption, and this lane's client-file spend must be booked against it. **This lane modifies exactly two production client files:** `src/store/panesSlice.ts` and `src/lib/tab-registry-snapshot.ts`. Note for the re-count: the campaign plan names `persistMiddleware.ts:229` as the hydrate re-mint, but that site is a fallback (`content.createRequestId || nanoid()`) that already preserves-when-present and is retained unchanged as the genuinely-absent legacy-migration mint (required by `isWellFormedPaneTree`, which drops trees missing the field — `src/store/paneTreeValidation.ts:41`); the effective hydrate re-mint lives in `normalizePaneContent` (`panesSlice.ts:78-80`, `:118`, `:161`) and is fixed there. Task 1 locks the `persistMiddleware.ts` preserve behavior with a test so the "no re-mint on hydrate" guarantee is proven at both sites.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/store/panesSlice.ts` | Modify (3 small edits in `normalizePaneContent`) | Inherit `previous` pane's `createRequestId` instead of minting when incoming content lacks one (terminal + fresh-agent), mirroring the existing `browserInstanceId` pattern |
| `test/unit/client/store/createRequestIdStability.test.ts` | Create | New unit suite: hydrate inherit, boot round-trip preserve, new-pane mint |
| `src/lib/tab-registry-snapshot.ts` | Modify (`stripPanePayload`) | Emit `createRequestId` into terminal + fresh-agent snapshot payloads |
| `test/unit/client/lib/tab-registry-snapshot.test.ts` | Modify | RED anchor (strict `toEqual` payloads) + new field assertions |
| `crates/freshell-freshagent/src/terminal_tabs.rs` | Modify (`spawn_terminal_pane`, 3 edits + tests) | REST ingress accepts-or-mints `createRequestId`, stamps registry, emits in `paneContent` (covers `/api/tabs`, `/api/panes/:id/split`, and `/api/panes/:id/respawn`) |
| `crates/freshell-freshagent/src/pane_ops.rs` | Modify (tests only) | BOTH the split-path broadcast test and the respawn rotation test are extended to assert the key (production code unchanged — split and respawn delegate to `spawn_terminal_pane`) |
| `crates/freshell-terminal/src/registry.rs` | Modify (1 word) | `probe_create_request_id` becomes `pub` so freshell-freshagent tests can assert the registry stamp (documented fence exception) |
| `crates/freshell-ws/src/tabs_persist_validation.rs` | Modify (3-line `#[cfg(test)]` module registration at EOF only) | Register the new sibling test file. NOT in `tabs_persist.rs`: that file is 999/1,000 lines (`port/AGENTS.md:81` cap), so registration lives in this 563-line `#[path]` child instead — validator logic untouched, caps/eviction untouched (Lane A6 owns those) |
| `crates/freshell-ws/src/tabs_persist_validation_tests.rs` | Create | Behavior locks: string round-trips, absent-still-valid, wrong-type-never-poisons-the-device (NO validator code change — see Task 4 rationale) |
| `crates/freshell-server/src/tabs_snapshots.rs` | Modify | Replace inline `pane_to_create_body` with `#[path]`-sibling module include (1,000-line limit) |
| `crates/freshell-server/src/tabs_snapshots_create_body.rs` | Create | `pane_to_create_body` moved verbatim + `createRequestId` passthrough |
| `crates/freshell-server/src/tabs_snapshots_restore_tests.rs` | Modify | Unit tests: create body carries / omits the key |
| `test/e2e-browser/specs/createrequestid-stabilization-rust.spec.ts` | Create | E2E: REST-created pane has a server-minted key; reload preserves it |
| `test/e2e-browser/playwright.config.ts` | Modify (2 appends) | Register the rust-only spec |

**Interface contract shared by all tasks (the wire/persist field):** the pane identity key is the JSON field `createRequestId` (camelCase, non-empty string), carried **inside the pane payload / paneContent object** (`payload.createRequestId` in registry snapshots and tabs-snapshots; `paneContent.createRequestId` in `ui.command{tab.create}` / `pane.split` payloads; `createRequestId` in the `POST /api/tabs` / split request body). Server-minted values are `Uuid::new_v4().simple()` (32 lowercase hex chars); client-minted values are 21-char nanoids. Absence of the field is always legal on read (backward compat).

---

### Task 0: Baseline — confirm the suites are green before changing anything

**Files:** none (verification only)

**Interfaces:**
- Consumes: the worktree as created by the workspace stage.
- Produces: a recorded green baseline that later red→green proof is measured against.

- [ ] **Step 1: Confirm worktree + branch**

Run:
```bash
cd /home/dan/code/freshell/.worktrees/createrequestid-stabilization
git status --short && git branch --show-current && git log --oneline -1
```
Expected: clean tree (this plan file may be present/committed), a feature branch (e.g. `feat/createrequestid-stabilization`), tip at or descended from `c491aee0`. If the branch is somehow `main`, create the feature branch now: `git checkout -b feat/createrequestid-stabilization`.

- [ ] **Step 2: Check the coordinator gate, then run the base suite**

Run:
```bash
npm run test:status
```
If another agent holds the gate, WAIT (re-check periodically); do not kill anything. Then:
```bash
FRESHELL_TEST_SUMMARY="lane A1 createRequestId baseline" npm test
```
Expected: PASS (exit 0). If the baseline is red, HALT and report — do not build on a red base.

- [ ] **Step 3: Rust baseline for the three crates we touch**

Run:
```bash
cargo test -p freshell-freshagent -p freshell-ws -p freshell-server
```
Expected: PASS.

---

### Task 1: Client — hydrate preserves `createRequestId` (inherit `previous` ONLY on the hydrate path, mint everywhere else)

**Files:**
- Modify: `src/store/panesSlice.ts:61-64` (`normalizePaneContent` signature — new opt-in `options` param), `:66-91` (terminal branch, mint at `:78-80`), `:106-175` (fresh-agent branches, mint sites at `:118` and `:161`), `:373-378` (`normalizePaneTree` leaf call — the single hydrate-scoped opt-in site)
- Create: `test/unit/client/store/createRequestIdStability.test.ts`

**Interfaces:**
- Consumes: `normalizePaneContent(rawInput, previous?: PaneContent, options?: { inheritCreateRequestId?: boolean })` — the `previous` parameter is already threaded in by `normalizePaneTree` (`panesSlice.ts:373-378`: `normalizePaneContent(node.content, previousLeaf?.content)`) and already used for `browserInstanceId` stability (`:92-101`). `hydratePanes` reducer (`:1559`) calls `normalizePaneTree(mergedNode, localNode)` (`:1575`) and `normalizePaneTree(state.layouts[tabId])` (`:1587`); `normalizePaneTree` has NO other production callers (verified), so it is the hydrate-only seam.
- Produces: hydrate semantics all later tasks rely on — ON THE HYDRATE PATH ONLY, a pane whose incoming content carries `createRequestId` keeps it; a pane whose incoming content lacks it inherits the local (previous) same-kind pane's key; only a pane with neither gets a fresh `nanoid()`. EVERY OTHER `previous`-passing caller keeps today's mint-when-absent behavior — in particular `updatePaneContent` (`panesSlice.ts:1323`) still MINTS for key-less same-kind content, which the resume/repair dispatchers depend on for rotation (`src/store/tabsSlice.ts:668` `repairExistingTabLayout` and `src/components/context-menu/ContextMenuProvider.tsx:949` reopen-in-pane both dispatch `buildResumeContent` output, which never carries `createRequestId`; TerminalView's create effect is keyed on `terminalContent?.createRequestId` — `TerminalView.tsx:4416,4453` — so an inherited/unchanged key there would never drive the resume create). Class-B rotation sites are untouched (they set the field explicitly on `input`, so input-wins precedence preserves their behavior).

- [ ] **Step 1: Write the failing tests**

Create `test/unit/client/store/createRequestIdStability.test.ts` with exactly this content (preamble copied from the house style in `test/unit/client/store/panesPersistence.test.ts` — the localStorage mock MUST be installed before slice imports, and the three cache resets in `beforeEach` are required because the vitest config uses `sequence: { shuffle: true }`):

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'

// Mock localStorage BEFORE importing slices
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { store = {} },
  }
})()

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

import tabsReducer from '../../../../src/store/tabsSlice'
import panesReducer, { hydratePanes, initLayout, updatePaneContent } from '../../../../src/store/panesSlice'
import {
  loadPersistedPanes,
  persistMiddleware,
  resetPersistFlushListenersForTests,
  resetPersistedPanesCacheForTests,
  resetPersistedLayoutCacheForTests,
} from '../../../../src/store/persistMiddleware'

function makeStore() {
  return configureStore({
    reducer: { tabs: tabsReducer, panes: panesReducer },
    middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
  })
}

describe('createRequestId stability across hydrate', () => {
  beforeEach(() => {
    localStorageMock.clear()
    vi.clearAllMocks()
    vi.useFakeTimers()
    resetPersistFlushListenersForTests()
    resetPersistedPanesCacheForTests()
    resetPersistedLayoutCacheForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('hydratePanes inherits the local createRequestId when the incoming terminal pane lacks one', () => {
    const store = makeStore()
    store.dispatch(initLayout({
      tabId: 'tab1',
      content: {
        kind: 'terminal', mode: 'shell', shell: 'system',
        status: 'running', createRequestId: 'stable-key-1',
      } as any,
    }))
    const paneId = (store.getState().panes.layouts['tab1'] as any).id

    // Incoming (remote) copy of the SAME pane, but the field was dropped by
    // the producer. status:'exited' biases mergeTerminalState toward the
    // incoming node (exit state propagates from remote — crossTabSync.test.ts
    // 'propagates exit state from remote even when local has terminalId').
    store.dispatch(hydratePanes({
      layouts: {
        tab1: {
          type: 'leaf', id: paneId,
          content: { kind: 'terminal', mode: 'shell', shell: 'system', status: 'exited' },
        },
      },
      activePane: { tab1: paneId },
      paneTitles: {},
      paneTitleSetByUser: {},
    } as any))

    const leaf = store.getState().panes.layouts['tab1'] as any
    expect(leaf.content.createRequestId).toBe('stable-key-1')
  })

  it('hydratePanes inherits the local createRequestId when the incoming fresh-agent pane lacks one', () => {
    const store = makeStore()
    store.dispatch(initLayout({
      tabId: 'tab2',
      content: {
        kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude',
        status: 'idle', createRequestId: 'stable-key-fa',
      } as any,
    }))
    const paneId = (store.getState().panes.layouts['tab2'] as any).id

    store.dispatch(hydratePanes({
      layouts: {
        tab2: {
          type: 'leaf', id: paneId,
          content: { kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude', status: 'idle' },
        },
      },
      activePane: { tab2: paneId },
      paneTitles: {},
      paneTitleSetByUser: {},
    } as any))

    const leaf = store.getState().panes.layouts['tab2'] as any
    expect(leaf.content.createRequestId).toBe('stable-key-fa')
  })

  it('boot hydrate preserves the persisted createRequestId byte-for-byte (lock-in)', () => {
    const store1 = makeStore()
    store1.dispatch(initLayout({
      tabId: 'tab3',
      content: {
        kind: 'terminal', mode: 'shell', shell: 'system',
        status: 'running', createRequestId: 'persisted-key-3',
      } as any,
    }))
    vi.runAllTimers() // flush persist debounce to localStorage

    // Simulate a fresh page load: reset the module caches, re-read storage.
    resetPersistedPanesCacheForTests()
    resetPersistedLayoutCacheForTests()
    const persisted = loadPersistedPanes()
    const leaf = (persisted as any).layouts['tab3']
    expect(leaf.content.createRequestId).toBe('persisted-key-3')
  })

  it('a genuinely new pane (no persisted key, no previous) mints a createRequestId', () => {
    const store = makeStore()
    store.dispatch(initLayout({ tabId: 'tab4', content: { kind: 'terminal', mode: 'shell' } as any }))
    const leaf = store.getState().panes.layouts['tab4'] as any
    expect(typeof leaf.content.createRequestId).toBe('string')
    expect(leaf.content.createRequestId.length).toBeGreaterThan(0)
  })

  it('updatePaneContent MINTS a fresh key for key-less same-kind content (resume-path rotation preserved)', () => {
    const store = makeStore()
    store.dispatch(initLayout({
      tabId: 'tab5',
      content: {
        kind: 'terminal', mode: 'shell', shell: 'system',
        status: 'running', createRequestId: 'rotate-me-5',
      } as any,
    }))
    const paneId = (store.getState().panes.layouts['tab5'] as any).id

    // Mirrors the resume/repair dispatchers (tabsSlice.ts:668
    // repairExistingTabLayout; ContextMenuProvider.tsx:949 reopen-in-pane):
    // buildResumeContent output never carries createRequestId, and those
    // paths RELY on the reducer minting a fresh key so TerminalView's create
    // effect (keyed on terminalContent?.createRequestId) re-fires and drives
    // the resume create. The hydrate-scoped inherit must NOT leak here.
    store.dispatch(updatePaneContent({
      tabId: 'tab5',
      paneId,
      content: {
        kind: 'terminal', mode: 'claude',
        sessionRef: { provider: 'claude', sessionId: 'sess-resume-5' },
      } as any,
    }))

    const leaf = store.getState().panes.layouts['tab5'] as any
    expect(typeof leaf.content.createRequestId).toBe('string')
    expect(leaf.content.createRequestId.length).toBeGreaterThan(0)
    expect(leaf.content.createRequestId).not.toBe('rotate-me-5')
  })
})
```

- [ ] **Step 2: Run the new suite to verify the inherit tests fail**

Run:
```bash
npm run test:vitest -- run test/unit/client/store/createRequestIdStability.test.ts --config config/vitest/vitest.config.ts
```
Expected: the two "inherits the local createRequestId" tests FAIL — received value is a fresh 21-char nanoid, expected `'stable-key-1'` / `'stable-key-fa'`. Tests 3 and 4 should already PASS (they lock existing behavior). Test 5 (updatePaneContent rotation) must PASS both BEFORE and AFTER Step 3 — it locks the mint-on-key-less-update behavior the resume paths depend on; if it fails after Step 3, the inheritance leaked out of the hydrate seam. If an inherit test unexpectedly PASSES, `mergeTerminalState` kept the local node wholesale for that shape — investigate `mergeTerminalState` (`panesSlice.ts` around `:678`) and adjust the incoming leaf so the merge selects the incoming node before proceeding; do not skip the RED confirmation.

- [ ] **Step 3: Implement the hydrate-scoped `previous` inheritance (opt-in flag, threaded only from `normalizePaneTree`)**

In `src/store/panesSlice.ts`, make exactly four edits. The inheritance is gated on a new opt-in `options.inheritCreateRequestId` flag so it can ONLY fire on the hydrate path — `normalizePaneTree` is the single opt-in site, and it is reachable only from the `hydratePanes` reducer (`:1575`, `:1587`). Every other `previous`-passing caller (`updatePaneContent` `:1323`, `mergePaneContent` `:1400`, `buildMaterializedFreshAgentContent` `:574`, `restartFreshAgentCreate` `:1445`) passes no options and keeps today's mint-when-absent behavior — required by the resume/repair rotation dependency at `tabsSlice.ts:668` and `ContextMenuProvider.tsx:949`.

Edit 1 — signature. Change the function signature (`:61-64`) from:

```ts
function normalizePaneContent(
  rawInput: PaneContentInput | PaneContent | Record<string, unknown>,
  previous?: PaneContent,
): PaneContent {
```

to:

```ts
function normalizePaneContent(
  rawInput: PaneContentInput | PaneContent | Record<string, unknown>,
  previous?: PaneContent,
  options?: { inheritCreateRequestId?: boolean },
): PaneContent {
```

Edit 2 — terminal branch. At the top of the `if (input.kind === 'terminal') {` block (immediately after the `const mode = ...` line at `:67`), add:

```ts
    const previousCreateRequestId =
      options?.inheritCreateRequestId && previous?.kind === 'terminal'
        ? previous.createRequestId
        : undefined
```

and change the `createRequestId` property in the terminal return object (`:78-80`) from:

```ts
      createRequestId: typeof input.createRequestId === 'string' && input.createRequestId
        ? input.createRequestId
        : nanoid(),
```

to:

```ts
      createRequestId: typeof input.createRequestId === 'string' && input.createRequestId
        ? input.createRequestId
        : previousCreateRequestId || nanoid(),
```

Edit 3 — fresh-agent branches. At the top of the `if (input.kind === 'fresh-agent') {` block (immediately after `const rawFreshAgent = input as Record<string, unknown>` at `:107`), add:

```ts
    const previousCreateRequestId =
      options?.inheritCreateRequestId && previous?.kind === 'fresh-agent'
        ? previous.createRequestId
        : undefined
```

and change BOTH fresh-agent mint sites — the `restoreError` branch (`:118`) and the main branch (`:161`) — from (identical text at both sites, indentation differs):

```ts
        createRequestId: input.createRequestId || nanoid(),
```

to (this also lands the A4a-N1 hardening: the terminal branch already guards with `typeof ... === 'string'`, the fresh-agent branches did not — a non-string truthy legacy value now re-mints instead of leaking a non-string key into `TerminalPaneContent`/`FreshAgentPaneContent.createRequestId: string`):

```ts
        createRequestId: typeof input.createRequestId === 'string' && input.createRequestId
          ? input.createRequestId
          : previousCreateRequestId || nanoid(),
```

(At `:161` the property sits at 6-space indent — keep the continuation lines aligned to local style.)

Edit 4 — the single opt-in site. In `normalizePaneTree`'s leaf branch, change (`:373-378`):

```ts
  if (node.type === 'leaf') {
    const previousLeaf = previousValid ? findLeaf(previousValid, node.id) : null
    const normalizedLeaf: Extract<PaneNode, { type: 'leaf' }> = {
      ...node,
      content: normalizePaneContent(node.content, previousLeaf?.content),
    }
```

to:

```ts
  if (node.type === 'leaf') {
    const previousLeaf = previousValid ? findLeaf(previousValid, node.id) : null
    const normalizedLeaf: Extract<PaneNode, { type: 'leaf' }> = {
      ...node,
      // Hydrate-scoped: normalizePaneTree is reachable ONLY from hydratePanes,
      // so this is the one place a key-less incoming pane may inherit the
      // previous (local) same-kind pane's createRequestId instead of minting.
      // updatePaneContent et al. pass no options and keep minting — the
      // resume/repair rotation contract (tabsSlice.ts repairExistingTabLayout,
      // ContextMenuProvider reopen-in-pane) depends on that.
      content: normalizePaneContent(node.content, previousLeaf?.content, { inheritCreateRequestId: true }),
    }
```

Do NOT touch `clearTerminalContentForRecreate`, `restartFreshAgentCreate`, `stripStaleIds`, `normalizeRestoredTree`, or `persistMiddleware.ts` — the Class-B sites set the field explicitly on `input` (input-wins precedence preserves them), `stripStaleIds` calls `normalizePaneContent(...)` with NO `previous` argument (`:846`), so `restoreLayout` keeps its fresh-identity semantics, and no caller other than `normalizePaneTree` passes `options`, so `updatePaneContent`/`mergePaneContent` keep today's mint semantics byte-for-byte.

- [ ] **Step 4: Run the new suite to verify it passes**

Run:
```bash
npm run test:vitest -- run test/unit/client/store/createRequestIdStability.test.ts --config config/vitest/vitest.config.ts
```
Expected: 5 passed.

- [ ] **Step 5: Run the neighboring suites (Class-B regression gate + hydrate/persist coverage)**

Run:
```bash
npm run test:vitest -- run \
  test/unit/client/store/panesPersistence.test.ts \
  test/unit/client/store/panesSlice.test.ts \
  test/unit/client/store/crossTabSync.test.ts \
  test/unit/lib/terminal-restore.test.ts \
  --config config/vitest/vitest.config.ts
```
Expected: all PASS. These suites assert the intentional rotation semantics (`clearDeadTerminals`, `clearTerminalLiveHandles`, `restartFreshAgentCreate`, restore-armed set) — if any fail, the fallback leaked into a Class-B path; fix the implementation, not the tests.

- [ ] **Step 6: Typecheck and commit**

Run:
```bash
npm run typecheck:client
git add src/store/panesSlice.ts test/unit/client/store/createRequestIdStability.test.ts
git commit -m "fix(client): hydrate inherits previous createRequestId instead of re-minting"
```

---

### Task 2: Client — snapshot builder persists `createRequestId`

**Files:**
- Modify: `src/lib/tab-registry-snapshot.ts:15-68` (`stripPanePayload`)
- Test: `test/unit/client/lib/tab-registry-snapshot.test.ts`

**Interfaces:**
- Consumes: `PaneContent` (terminal and fresh-agent variants carry `createRequestId: string`).
- Produces: `stripPanePayload` returns `payload.createRequestId: string | undefined` for `terminal` and `fresh-agent` kinds. `RegistryPaneSnapshot.payload` is `z.record(z.string(), z.unknown())` (`src/store/tabRegistryTypes.ts`) — **no Zod schema change is needed**. Tasks 4 and 5 consume this field server-side as `payload.createRequestId`.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/client/lib/tab-registry-snapshot.test.ts`, inside the existing `describe('collectPaneSnapshots', ...)` block:

```ts
  it('persists createRequestId in terminal and fresh-agent pane payloads', () => {
    const terminalNode: PaneNode = {
      type: 'leaf',
      id: 'pane-term',
      content: {
        kind: 'terminal',
        createRequestId: 'req-stable-term',
        status: 'running',
        mode: 'shell',
        shell: 'system',
        terminalId: 'term-1',
        serverInstanceId: 'server-1',
      },
    }
    const termSnapshots = collectPaneSnapshots(terminalNode, 'server-1')
    expect(termSnapshots[0].payload.createRequestId).toBe('req-stable-term')

    const freshAgentNode: PaneNode = {
      type: 'leaf',
      id: 'pane-fa',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-stable-fa',
        status: 'idle',
      } as any,
    }
    const faSnapshots = collectPaneSnapshots(freshAgentNode, 'server-1')
    expect(faSnapshots[0].payload.createRequestId).toBe('req-stable-fa')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npm run test:vitest -- run test/unit/client/lib/tab-registry-snapshot.test.ts --config config/vitest/vitest.config.ts
```
Expected: the new test FAILS with `payload.createRequestId` being `undefined` (the payload objects currently omit the field).

- [ ] **Step 3: Implement — emit the field in `stripPanePayload`**

In `src/lib/tab-registry-snapshot.ts`, add `createRequestId` as the first property of the `terminal` and `fresh-agent` case returns:

```ts
    case 'terminal':
      return {
        createRequestId: content.createRequestId,
        mode: content.mode,
        shell: content.shell,
        sessionRef: content.sessionRef,
        codexDurability: content.mode === 'codex' ? content.codexDurability : undefined,
        liveTerminal: content.terminalId
          ? {
              terminalId: content.terminalId,
              serverInstanceId: content.serverInstanceId ?? serverInstanceId,
            }
          : undefined,
        initialCwd: content.initialCwd,
      }
```

and:

```ts
    case 'fresh-agent':
      return {
        createRequestId: content.createRequestId,
        provider: content.provider,
        ...
```
(leave every other property of both cases exactly as it is today; browser/editor/extension/picker cases unchanged).

- [ ] **Step 4: Run the file's full suite; update the strict-equality RED anchors**

Run:
```bash
npm run test:vitest -- run test/unit/client/lib/tab-registry-snapshot.test.ts --config config/vitest/vitest.config.ts
```
Expected: the new test PASSES; the pre-existing `collectPaneSnapshots` tests that use strict `toEqual` on the whole payload now FAIL (e.g. the codex-durability test's expected payload lacks `createRequestId: 'req-codex'`). Update each failing expectation by adding the `createRequestId` value from that test's input content (e.g. add `createRequestId: 'req-codex',` to the expected payload object). Re-run until all pass. Do NOT weaken `toEqual` to `toMatchObject` — the strictness is the file's regression armor.

- [ ] **Step 5: Run the registry round-trip neighbors**

Run:
```bash
npm run test:vitest -- run \
  test/unit/client/lib/tab-registry-snapshot.test.ts \
  test/unit/client/tab-registry-fresh-agent-migration.test.ts \
  --config config/vitest/vitest.config.ts
```
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run:
```bash
npm run typecheck:client
git add src/lib/tab-registry-snapshot.ts test/unit/client/lib/tab-registry-snapshot.test.ts
git commit -m "feat(client): persist createRequestId in tab-registry pane snapshots"
```

---

### Task 3: Rust — REST ingress mints and stamps `createRequestId` (covers `/api/tabs`, `/api/panes/:id/split`, AND `/api/panes/:id/respawn` — all three delegate to `spawn_terminal_pane`)

**Files:**
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs` — `spawn_terminal_pane` (`:574`; edits near `:609`, `:866-878`, `:947-954`) + new tests in the in-file `#[cfg(test)] mod tests` (`:1463+`)
- Modify: `crates/freshell-freshagent/src/pane_ops.rs` — tests only (`mod tests` at `:941+`)
- Modify: `crates/freshell-terminal/src/registry.rs` — one-word visibility change: `fn probe_create_request_id` -> `pub fn` (`registry.rs:1578`)

**Interfaces:**
- Consumes: request body field `createRequestId` (optional non-empty string — supplied by Task 5's restore path, absent for ordinary REST callers); `TerminalRegistry::create(&spec, &env, terminal_id, stream_id, &mode, resume_session_id: Option<&str>, create_request_id: Option<&str>, ring_max_bytes: Option<i64>, on_exit)` — the 7th positional argument already exists (`crates/freshell-terminal/src/registry.rs:678-690`); `TerminalRegistry::probe_create_request_id(&self, terminal_id: &str) -> Option<String>` (`registry.rs:1578`) for test assertions. NOTE: `probe_create_request_id` is currently PRIVATE (`fn probe_create_request_id(&self, terminal_id: &str) -> Option<String>`, `registry.rs:1578` — no `pub`); Task 3's tests in `freshell-freshagent` cannot call it as-is. Task 3 must change it to `pub fn` in `crates/freshell-terminal/src/registry.rs` (doc comment "A terminal's stamped `createRequestId`, if any." already present; internal caller at `registry.rs:1478` unaffected).
- Produces: every terminal pane spawned via REST has a `create_request_id` stamped atomically in the registry AND a `"createRequestId"` string in its `paneContent` (which flows into the `ui.command{tab.create}` payload, the `pane.split` `newContent`, the `pane.attach` respawn `content`, and thence the client store and persisted layout). Minted format: `Uuid::new_v4().simple().to_string()` (32 hex chars — same idiom as the fresh-agent path at `lib.rs:1288`). `spawn_terminal_pane` has exactly THREE production callers, all covered for free by this one edit: `create_terminal_tab` (`terminal_tabs.rs:1030`), `split_pane` (`pane_ops.rs:156`), and `respawn_pane` (`pane_ops.rs:716`). **Rotation-on-respawn is intentional legacy parity**: the Node server's respawn handler mints a fresh key per respawn (`server/agent-api/router.ts:1602`, `createRequestId: nanoid()` in the broadcast content), and rotation is REQUIRED for correctness — respawn detaches (never kills) the old terminal, and reconcile/adopt resolves panes via `newest_live_by_create_request_id` (`crates/freshell-ws/src/terminal.rs:899-931`), so the pane's key must track the REPLACEMENT terminal, not the orphaned old one. A respawn body MAY carry `createRequestId` (accept-or-mint applies uniformly); a caller passing one accepts the adopt-by-key semantics that implies. Browser/editor panes are out of scope (reconciliation v1 is terminal-only).

- [ ] **Step 0: Sibling-lane drift check (cheap, read-only)**

Run:
```bash
for w in /home/dan/code/freshell/.worktrees/*/; do echo "== $w"; git -C "$w" diff --name-only origin/main...HEAD 2>/dev/null; done
```
Check whether any sibling lane has landed changes to `crates/freshell-terminal/src/registry.rs` (Lane A5's 10th `scrollback` param — if present, add the extra trailing arg at the Task 3 call site), `crates/freshell-ws/src/tabs_persist_tests.rs` / `tabs_persist_validation.rs`, or `src/store/panesSlice.ts`. As of plan validation (2026-07-25) all five sibling branches were plan-doc-only.

- [ ] **Step 1: Write the failing tests**

First, make the probe accessor public so the tests compile: in `crates/freshell-terminal/src/registry.rs:1578` change `fn probe_create_request_id(&self, terminal_id: &str) -> Option<String>` to `pub fn probe_create_request_id(...)` — no other change (internal caller at `registry.rs:1478` unaffected).

In `crates/freshell-freshagent/src/terminal_tabs.rs`'s existing `#[cfg(test)] mod tests` module, add two `#[tokio::test]` functions modeled on the module's existing HTTP tests (use the module's local `state_with_registry()` / `app(state)` / `post(...)` / `body_json(...)` helpers and broadcast-bus subscription exactly as the neighboring real-PTY tests do — read `split_terminal_pane_spawns_real_pty_and_broadcasts_pane_split` in `pane_ops.rs:1103` for the subscribe-and-drain pattern):

```rust
    #[tokio::test]
    async fn rest_create_terminal_tab_mints_and_stamps_create_request_id() {
        let state = state_with_registry();
        let mut rx = state.bus.subscribe();
        let router = app(state.clone());

        let (status, body) = post(
            router,
            "/api/tabs",
            serde_json::json!({ "mode": "shell" }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "create failed: {body}");

        // Drain the broadcast bus for the ui.command{tab.create} frame.
        let mut pane_content = None;
        while let Ok(msg) = rx.try_recv() {
            if let ServerMessage::UiCommand(cmd) = &msg {
                if cmd.command == "tab.create" {
                    pane_content = cmd
                        .payload
                        .as_ref()
                        .and_then(|p| p.get("paneContent"))
                        .cloned();
                }
            }
        }
        let pane_content = pane_content.expect("no tab.create broadcast");
        let crid = pane_content
            .get("createRequestId")
            .and_then(serde_json::Value::as_str)
            .expect("paneContent.createRequestId missing");
        assert_eq!(crid.len(), 32, "expected Uuid::simple format, got {crid:?}");
        assert!(crid.chars().all(|c| c.is_ascii_hexdigit()));

        // The registry row was stamped with the SAME key (atomic insert).
        let terminal_id = pane_content
            .get("terminalId")
            .and_then(serde_json::Value::as_str)
            .expect("paneContent.terminalId missing");
        assert_eq!(
            state.terminals.probe_create_request_id(terminal_id).as_deref(),
            Some(crid),
        );
    }

    #[tokio::test]
    async fn rest_create_honors_caller_supplied_create_request_id() {
        let state = state_with_registry();
        let mut rx = state.bus.subscribe();
        let router = app(state.clone());

        let (status, body) = post(
            router,
            "/api/tabs",
            serde_json::json!({ "mode": "shell", "createRequestId": "crid-fixed-key" }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "create failed: {body}");

        let mut pane_content = None;
        while let Ok(msg) = rx.try_recv() {
            if let ServerMessage::UiCommand(cmd) = &msg {
                if cmd.command == "tab.create" {
                    pane_content = cmd
                        .payload
                        .as_ref()
                        .and_then(|p| p.get("paneContent"))
                        .cloned();
                }
            }
        }
        let pane_content = pane_content.expect("no tab.create broadcast");
        assert_eq!(
            pane_content.get("createRequestId").and_then(serde_json::Value::as_str),
            Some("crid-fixed-key"),
        );
        let terminal_id = pane_content
            .get("terminalId")
            .and_then(serde_json::Value::as_str)
            .expect("paneContent.terminalId missing");
        assert_eq!(
            state.terminals.probe_create_request_id(terminal_id).as_deref(),
            Some("crid-fixed-key"),
        );
    }
```

Adapt mechanics (broadcast receiver type, `try_recv` vs the module's drain helper, `state.bus` vs `state.broadcast` field name, whether the frame arrives synchronously or needs the module's existing await/poll idiom, real-PTY fixtures like `recording_cli_spec`) to match the neighboring tests in the SAME module — the assertions above are the contract; the plumbing must follow local convention. If shell spawn in tests needs the module's fake-CLI/PATH fixture (see `pane_ops.rs` `create_shell_tab` helper for how existing tests create shell tabs), reuse it.

In `crates/freshell-freshagent/src/pane_ops.rs`'s `mod tests`, extend the EXISTING test `split_terminal_pane_spawns_real_pty_and_broadcasts_pane_split` (`:1103`) with one additional assertion where it inspects the `pane.split` `ui.command` payload:

```rust
        let crid = msg["payload"]["newContent"]["createRequestId"]
            .as_str()
            .expect("split newContent.createRequestId missing");
        assert_eq!(crid.len(), 32);
```

Also extend the EXISTING test `respawn_pane_replaces_terminal_in_place_and_broadcasts_pane_attach` (`pane_ops.rs:1738`) with the rotation assertions. Two insertions:

Insertion 1 — immediately AFTER this existing block (the `pane.attach` content check):

```rust
        assert_eq!(
            msg["payload"]["content"]["terminalId"],
            json!(new_terminal_id)
        );
```

add:

```rust
        // Task 3: respawn ROTATES the pane key — the broadcast content carries
        // a fresh server-minted 32-hex createRequestId. Intentional legacy
        // parity (router.ts:1602 mints per respawn) and required so
        // reconcile's newest_live_by_create_request_id resolves the pane to
        // the REPLACEMENT terminal, not the detached old one.
        let crid = msg["payload"]["content"]["createRequestId"]
            .as_str()
            .expect("respawn content.createRequestId missing");
        assert_eq!(crid.len(), 32, "expected Uuid::simple format, got {crid:?}");
        assert!(crid.chars().all(|c| c.is_ascii_hexdigit()));
```

Insertion 2 — immediately AFTER this existing block (which already binds `registry`):

```rust
        let registry = state.terminal_registry.clone().unwrap();
        assert!(registry.is_running(&old_terminal_id));
        assert!(registry.is_running(&new_terminal_id));
```

and BEFORE the trailing `registry.kill(...)` lines, add:

```rust
        // The NEW terminal's registry row was stamped with the SAME key
        // (atomic insert) — the old terminal keeps its own lineage.
        assert_eq!(
            registry.probe_create_request_id(&new_terminal_id).as_deref(),
            Some(crid),
        );
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cargo test -p freshell-freshagent create_request_id -- --nocapture
cargo test -p freshell-freshagent split_terminal_pane_spawns_real_pty_and_broadcasts_pane_split
```
Expected: FAIL — `paneContent.createRequestId missing` (the field is not emitted today) and `probe_create_request_id` returns `None` (registry receives `None` today).

- [ ] **Step 3: Implement — three edits in `spawn_terminal_pane`**

Edit 1 — accept-or-mint. In `spawn_terminal_pane` (`terminal_tabs.rs:574`), immediately after the `cwd` binding (`:609`), insert:

```rust
    // Stable pane identity key (reconciliation-handshake design §5.5,
    // precondition 2): honor a caller-supplied key (snapshot restore passes
    // the captured one through `pane_to_create_body`), else mint one so every
    // REST-created terminal pane is keyed. Same Uuid::simple idiom as the
    // fresh-agent path (lib.rs `create_tab`).
    let create_request_id = body
        .get("createRequestId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().simple().to_string());
```

Edit 2 — stamp the registry. At the `registry.create(...)` call (`:866-878`), replace the first `None` argument and its deferral comment:

```rust
        resume_session_id.as_deref(),
        // REST ingress mints no createRequestId (reconciliation design §5.5
        // precondition 2 — booked for the Phase-3 adoption change).
        None,
        None,
        on_exit,
```

with:

```rust
        resume_session_id.as_deref(),
        Some(create_request_id.as_str()),
        None,
        on_exit,
```

When rewriting the `registry.create` call (`terminal_tabs.rs:866-878`, signature `registry.rs:679-690`), name the positional `Option` args with inline comments so the next lane can rebase mechanically:

```rust
        resume_session_id.as_deref(),
        Some(create_request_id.as_str()), // create_request_id: REST accept-or-mint key (this task)
        None,                             // ring_max_bytes: registry default
        on_exit,
```

NOTE: Lane A5 (scrollback persistence) appends a 10th trailing `scrollback` parameter to `TerminalRegistry::create` — whichever lane lands second takes a one-line mechanical rebase at this call site; the named-arg comments above are there to make that rebase unambiguous.

Edit 3 — emit into `paneContent`. In the terminal `pane_content` construction (`:947-954`), add the field to the `json!` literal:

```rust
    let mut pane_content = json!({
        "kind": "terminal",
        "terminalId": terminal_id,
        "createRequestId": create_request_id,
        "status": "running",
        "mode": mode,
        "shell": shell_str.clone().unwrap_or_else(|| "system".to_string()),
        "initialCwd": cwd,
    });
```

(If the borrow checker complains about `create_request_id` being moved into `json!` while still borrowed at edit 2's call site, use `create_request_id.clone()` in the `json!` — the registry borrow ends before this point in the current code, so a plain move should compile.)

No `pane_ops.rs` production change: terminal splits delegate to `spawn_terminal_pane` and inherit all three edits.

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cargo test -p freshell-freshagent
```
Expected: PASS, including both new tests and the extended split test.

- [ ] **Step 5: Format, lint, commit**

Run:
```bash
cargo fmt --all
cargo clippy -p freshell-freshagent --all-targets -- -D warnings
git add crates/freshell-freshagent/src/terminal_tabs.rs crates/freshell-freshagent/src/pane_ops.rs crates/freshell-terminal/src/registry.rs
git commit -m "feat(freshagent): REST pane-create ingress mints and stamps createRequestId"
```

---

### Task 4: Rust — lock snapshot-pipeline tolerance for `createRequestId` (tests only; NO validator change)

**Files:**
- Modify: `crates/freshell-ws/src/tabs_persist_validation.rs` (3-line `#[cfg(test)]` module registration appended at end of file — the file is 563 lines today; ZERO validator-logic change. This file is a `#[path]` child of `tabs_persist` — registered at `tabs_persist.rs:96-97` as `#[path = "tabs_persist_validation.rs"] mod validation;` — so a test module declared here is a descendant of `tabs_persist` and keeps `pub(crate)`/private visibility)
- Create: `crates/freshell-ws/src/tabs_persist_validation_tests.rs`
- Do NOT modify: `crates/freshell-ws/src/tabs_persist.rs` (it is 999 lines — appending even a 3-line registration there would break the ≤1,000-line cap, `port/AGENTS.md:81`, that this plan treats as binding; its caps/eviction code is also Lane-A6-owned), `crates/freshell-ws/src/tabs_persist_tests.rs` (Lane A6 co-edits it — our tests live in the new sibling file to avoid merge conflicts)

**Why NO strict check (read this before "improving" anything):** the write-accept path (`validate_incoming_generation`, `tabs_persist.rs:104`) and the read path (`read_generation_file`, `tabs_persist.rs:108`) share ONE `validate_generation`. Any type check added there is therefore also a READ check, and the read blast radius is catastrophic: `all_generations_parsed` (`tabs_persist.rs:265-292`) propagates the first invalid file with `?`, so ONE wrong-typed field in ONE generation file makes `read_device_union`, `read_device_overview`, `read_generation`, and `read_generations_union_by_ids` return `Err` for the ENTIRE device — and `list_snapshot_devices` (`tabs_persist.rs:297-330`) reads one file per device dir, so it Errs for ALL devices on the server. Historical user disks are unauditable, and a wrong-typed value could plausibly exist (e.g. written through a pre-Task-4 server's unknown-field tolerance). Meanwhile strictness buys nothing: every consumer of the field already drops non-strings safely (`pane_to_create_body`'s `.filter(|v| v.is_string())` — Task 5 — and the Task-3 REST ingress), and the validator's existing unknown-field tolerance means string values already round-trip write→read unchanged with zero code change (write path is insert-only stamping: `terminal.rs:2262-2297`, `tabs.rs:133-142`; `persist_generation` serializes records verbatim: `tabs_persist.rs:788-796`; `validate_generation` never mutates). So this task LOCKS that tolerance with tests instead of adding validation. Enforcement of the field's type lives at the consumers, where a bad value costs one pane its identity key — not a device its entire snapshot history.

**Interfaces:**
- Consumes: `persist_generation` (`tabs_persist.rs:770`, `pub(crate)`), `read_device_union` (`:544`), `list_snapshot_devices` (`:297`), `validate_incoming_generation` (`:104`, `pub(crate)`), `TabsRegistry::with_persist_dir` + `replace_client_snapshot` (`crates/freshell-ws/src/tabs.rs:121-129`) — all reachable via `use super::super::*;` / `use crate::tabs::TabsRegistry;` from the test module, which is a grandchild of `tabs_persist` (declared inside its `validation` child, hence the double `super`).
- Produces: locked guarantees the rest of the plan builds on — (a) a string `payload.createRequestId` on terminal + fresh-agent panes round-trips push→persist→read unchanged (what Task 2 writes, Task 5 reads); (b) absence stays valid (legacy snapshots readable); (c) a wrong-typed value NEVER makes a generation — let alone the device — unreadable (read succeeds, value passes through verbatim; consumers drop it).

- [ ] **Step 1: Write the behavior-locking tests**

This is a tests-only task locking CURRENT behavior, so there is no red→green cycle: all three tests are expected to pass immediately. If any test FAILS, that is a discovery that the tolerance assumption is wrong — HALT and report; do not "fix" production code to make them pass.

Create `crates/freshell-ws/src/tabs_persist_validation_tests.rs` with exactly this content:

```rust
//! Behavior locks for `createRequestId` in persisted tabs-snapshot pane
//! payloads (Lane A1 Task 4). These tests intentionally add NO validator
//! strictness: `validate_generation` is shared by the write-accept AND read
//! paths, and one strict read failure poisons the whole device
//! (`all_generations_parsed` propagates the first `Err`) plus the cross-device
//! listing (`list_snapshot_devices`). Tolerance here is a design decision —
//! see the Task 4 rationale in
//! docs/plans/2026-07-25-createrequestid-stabilization.md. Sibling file to
//! `tabs_persist_tests.rs` (co-owned by Lane A6, hence the separate file);
//! helper shapes are mirrored from there. Registered from
//! `tabs_persist_validation.rs` (a `#[path]` child of `tabs_persist`) because
//! `tabs_persist.rs` sits at 999 lines against the 1,000-line cap
//! (port/AGENTS.md:81) — hence the double `super` below.

use super::super::*; // grandparent = tabs_persist (this mod lives under its `validation` child)
use crate::tabs::TabsRegistry;
use serde_json::{json, Value};

fn open_record(tab_key: &str, tab_name: &str, updated_at: i64) -> Value {
    json!({ "tabKey": tab_key, "tabId": tab_key, "tabName": tab_name, "status": "open",
            "revision": updated_at, "updatedAt": updated_at, "paneCount": 0, "panes": [] })
}

/// Direct deterministic write (explicit captured_at + revision) — bypasses the
/// WS-handler write gate on purpose, simulating a file that is ALREADY on disk
/// (legacy server, foreign writer, historical corpus).
fn put(
    dir: &std::path::Path,
    device: &str,
    client: &str,
    rev: i64,
    captured: i64,
    recs: Vec<Value>,
) {
    persist_generation(dir, "srv-1", device, "Dev", client, rev, &recs, captured);
}

fn keyed_panes(terminal_key: Value, fresh_key: Value) -> Value {
    json!([
        { "paneId": "terminal", "kind": "terminal",
          "payload": { "mode": "shell", "shell": "system",
                       "createRequestId": terminal_key } },
        { "paneId": "fresh", "kind": "fresh-agent",
          "payload": { "sessionType": "freshclaude", "provider": "claude",
                       "createRequestId": fresh_key } }
    ])
}

#[test]
fn pane_create_request_id_string_round_trips_push_to_read_unchanged() {
    // Full production write pipeline (registry push -> persist_generation),
    // then the fail-loud read path. The field must survive verbatim.
    let dir = tempfile::tempdir().unwrap();
    let reg = TabsRegistry::with_persist_dir(dir.path().to_path_buf());
    let mut record = open_record("dev:t", "t", 1);
    record["panes"] = keyed_panes(
        json!("a3f2b8d07a98b5fb2f4af05baf580000"), // server-mint shape (32 hex)
        json!("req-fa-1"),                         // client nanoid shape
    );
    reg.replace_client_snapshot("srv-1", "dev", "Dev", "client-1", 1, vec![record])
        .unwrap();
    let union = read_device_union(dir.path(), "dev")
        .expect("read io")
        .expect("one generation");
    let panes = &union["records"][0]["panes"];
    assert_eq!(
        panes[0]["payload"]["createRequestId"],
        "a3f2b8d07a98b5fb2f4af05baf580000"
    );
    assert_eq!(panes[1]["payload"]["createRequestId"], "req-fa-1");
    // And the shared write-accept validator (same validate_generation as the
    // read path) accepts a generation carrying the string field.
    let candidate = json!({
        "deviceId": "dev", "deviceLabel": "Dev", "clientInstanceId": "client-1",
        "serverInstanceId": "srv-1", "snapshotRevision": 1, "capturedAt": 0,
        "records": union["records"],
    });
    assert!(validate_incoming_generation(&candidate).is_ok());
}

#[test]
fn legacy_snapshots_without_create_request_id_stay_valid() {
    let dir = tempfile::tempdir().unwrap();
    let mut record = open_record("dev:legacy", "legacy", 1);
    record["panes"] = json!([
        { "paneId": "terminal", "kind": "terminal",
          "payload": { "mode": "shell", "shell": "system" } },
        { "paneId": "fresh", "kind": "fresh-agent",
          "payload": { "sessionType": "freshclaude", "provider": "claude" } }
    ]);
    put(dir.path(), "dev", "c1", 1, 1000, vec![record]);
    assert!(
        read_device_union(dir.path(), "dev").unwrap().is_some(),
        "snapshots predating createRequestId must remain readable"
    );
}

#[test]
fn wrong_typed_create_request_id_never_poisons_the_device() {
    // THE load-bearing lock: a wrong-typed key on disk (historical corpus,
    // foreign writer, version skew) must NOT convert into device-wide — or
    // via list_snapshot_devices, server-wide — snapshot unreadability. If this
    // test ever goes red because someone added a type check to
    // validate_generation, that check is on the READ path too: remove it.
    let dir = tempfile::tempdir().unwrap();
    let mut record = open_record("dev:t", "t", 1);
    record["panes"] = keyed_panes(json!(42), json!(true));
    put(dir.path(), "dev", "c1", 1, 1000, vec![record]);
    let union = read_device_union(dir.path(), "dev")
        .expect("wrong-typed createRequestId must NOT make the device unreadable")
        .expect("generation present");
    // Current (locked) behavior: the unknown field passes through verbatim —
    // nothing strips it; the CONSUMERS (pane_to_create_body, REST ingress)
    // drop non-strings, so the only cost is that one pane loses key identity.
    let panes = &union["records"][0]["panes"];
    assert_eq!(panes[0]["payload"]["createRequestId"], 42);
    assert_eq!(panes[1]["payload"]["createRequestId"], true);
    assert!(list_snapshot_devices(dir.path()).is_ok());
}
```

- [ ] **Step 2: Register the sibling test module**

In `crates/freshell-ws/src/tabs_persist_validation.rs`, append at the very end of the file (after the closing `}` at `:563` — the file is 563 lines today, so this lands it at 566):

```rust
#[cfg(test)]
#[path = "tabs_persist_validation_tests.rs"]
mod validation_tests;
```

Why HERE and not `tabs_persist.rs`: `tabs_persist.rs` is 999 lines and `port/AGENTS.md:81` caps files at 1,000 — appending the registration there would break the cap this plan treats as binding (cf. Task 5's extraction for exactly this reason). `tabs_persist_validation.rs` is itself a `#[path]` child of `tabs_persist` (`tabs_persist.rs:96-97`: `#[path = "tabs_persist_validation.rs"] mod validation;`), so the test module lands at `tabs_persist::validation::validation_tests` — still a descendant of `tabs_persist`, which is what keeps `pub(crate)` items reachable and makes Step 1's `use super::super::*;` resolve. The nested `#[path]` resolves relative to the directory containing `tabs_persist_validation.rs` (`src/`), so it finds the new sibling file. This is a `#[cfg(test)]`-gated module declaration ONLY — zero validator-logic change, honoring this task's NO-validator-change rule. Repo precedent for a sibling test file registering another sibling to respect the cap: `crates/freshell-server/src/tabs_snapshots_tests.rs:987`. It does not touch the caps/eviction logic Lane A6 owns, and it keeps `tabs_persist_tests.rs` untouched (Lane A6 co-edits that file).

- [ ] **Step 3: Run the new tests**

Run:
```bash
cargo test -p freshell-ws --lib validation_tests
```
Expected: 3 passed (behavior locks — green immediately; a failure is a finding, not a fixture bug — HALT and report). Then confirm the neighbors still pass:
```bash
cargo test -p freshell-ws --lib -- semantically_corrupt corrupt_generation_file
```
Expected: `semantically_corrupt_generation_files_fail_loud` and `corrupt_generation_file_reads_as_error_not_absence` still PASS (the fail-loud model for GENUINE corruption is unchanged; we added tolerance locks, not tolerance code).

- [ ] **Step 4: Format, lint, commit**

Run:
```bash
cargo fmt --all
cargo clippy -p freshell-ws --all-targets -- -D warnings
git add crates/freshell-ws/src/tabs_persist_validation.rs crates/freshell-ws/src/tabs_persist_validation_tests.rs
git commit -m "test(ws): lock snapshot read/write tolerance for pane createRequestId"
```

---

### Task 5: Rust — `pane_to_create_body` emits `createRequestId` (with 1,000-line-limit extraction)

**Files:**
- Create: `crates/freshell-server/src/tabs_snapshots_create_body.rs`
- Modify: `crates/freshell-server/src/tabs_snapshots.rs` (`:177-249` — remove the inline function, add the `#[path]` include; the file is exactly 1000 lines today and `port/AGENTS.md:81` caps files at 1000, so the addition is paired with this extraction using the file's own established sibling pattern, cf. `#[path = "tabs_snapshots_tests.rs"] mod tests;` at `:998-1000`)
- Test: `crates/freshell-server/src/tabs_snapshots_restore_tests.rs`

**Interfaces:**
- Consumes: snapshot pane `Value`s whose `payload.createRequestId` is an optional string (written by Task 2's client builder; Task 4 locks that the persistence pipeline round-trips it and tolerates wrong types — this function's `.filter(|v| v.is_string())` is the actual type gate). Callers of `pane_to_create_body(tab_name: Option<&Value>, pane: &Value) -> Result<Value, &'static str>`: the restore loop (`tabs_snapshots.rs:564-596`) and the restore-projection validator (`tabs_snapshots_marker.rs:458`, via `super::pane_to_create_body` — the `use` re-export below keeps that path resolving).
- Produces: for `kind == "terminal"`, the create body carries `createRequestId` when the payload has a string one, omitted otherwise — consumed by Task 3's `spawn_terminal_pane` accept-or-mint, so snapshot-restored panes keep their captured key and legacy panes get a freshly minted one.

- [ ] **Step 1: Write the failing test**

In `crates/freshell-server/src/tabs_snapshots_restore_tests.rs`, next to `create_body_carries_full_terminal_state_including_codex_durability` (`:583`), add:

```rust
#[test]
fn create_body_carries_create_request_id_and_omits_when_absent() {
    // Captured key passes through (P1.6: snapshot-restored panes keep identity).
    let pane = json!({ "paneId": "p1", "kind": "terminal", "payload": {
        "mode": "shell", "shell": "system",
        "createRequestId": "crid-from-snapshot"
    }});
    let body = pane_to_create_body(None, &pane).unwrap();
    assert_eq!(body["createRequestId"], "crid-from-snapshot");

    // Legacy snapshot without the field: body omits it entirely (the REST
    // ingress mints a fresh key in that case — never emit null/empty).
    let legacy = json!({ "paneId": "p2", "kind": "terminal", "payload": {
        "mode": "shell", "shell": "system"
    }});
    let legacy_body = pane_to_create_body(None, &legacy).unwrap();
    assert!(legacy_body.get("createRequestId").is_none());

    // Wrong-typed field is dropped, not an error (same tolerance as shell/cwd).
    let wrong = json!({ "paneId": "p3", "kind": "terminal", "payload": {
        "mode": "shell", "createRequestId": 42
    }});
    let wrong_body = pane_to_create_body(None, &wrong).unwrap();
    assert!(wrong_body.get("createRequestId").is_none());
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cargo test -p freshell-server create_body_carries_create_request_id -- --nocapture
```
Expected: FAIL — `body["createRequestId"]` is `null` (the passthrough does not exist yet).

- [ ] **Step 3: Implement — extraction + passthrough**

Create `crates/freshell-server/src/tabs_snapshots_create_body.rs` containing the `pane_to_create_body` function moved VERBATIM from `tabs_snapshots.rs:177-249` (doc comment included), with two changes: visibility becomes `pub(crate)`, and the terminal arm gains the passthrough. Full file content:

```rust
//! `pane_to_create_body` — extracted from `tabs_snapshots.rs` to honor the
//! 1,000-line file cap (port/AGENTS.md) when the createRequestId passthrough
//! was added. Included via `#[path]` from `tabs_snapshots.rs`, matching the
//! sibling pattern used by `tabs_snapshots_marker.rs` / `tabs_snapshots_tests.rs`.

use serde_json::{json, Value};

/// Map a snapshot pane to its `POST /api/tabs` body. Invalid session identity
/// fails before spawn; unsupported kinds are skips. Captured terminal, browser,
/// and editor options pass through to the restored pane.
pub(crate) fn pane_to_create_body(
    tab_name: Option<&Value>,
    pane: &Value,
) -> Result<Value, &'static str> {
    let payload = pane.get("payload").cloned().unwrap_or_else(|| json!({}));
    let kind = pane.get("kind").and_then(Value::as_str).unwrap_or("");
    let name = tab_name.cloned().unwrap_or(Value::Null);
    match kind {
        "terminal" => {
            let mode = payload
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or("shell");
            let mut b = json!({ "mode": mode, "name": name });
            if let Some(cwd) = payload.get("initialCwd").filter(|v| v.is_string()) {
                b["cwd"] = cwd.clone();
            }
            if let Some(shell) = payload.get("shell").filter(|v| v.is_string()) {
                b["shell"] = shell.clone();
            }
            // Stable pane identity key (reconciliation design §5.5): restore
            // re-creates the pane under its CAPTURED key so server-side state
            // keyed on it survives; absent on legacy snapshots (the REST
            // ingress mints one in that case).
            if let Some(crid) = payload.get("createRequestId").filter(|v| v.is_string()) {
                b["createRequestId"] = crid.clone();
            }
            if let Some(cd) = payload.get("codexDurability").filter(|v| v.is_object()) {
                if mode == "codex" {
                    b["codexDurability"] = cd.clone();
                }
            }
            // Present identity must be nonempty and match the terminal mode.
            if let Some(sref) = payload.get("sessionRef").filter(|v| !v.is_null()) {
                let ok = sref.is_object()
                    && sref.get("provider").and_then(Value::as_str) == Some(mode)
                    && sref
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .is_some_and(|s| !s.is_empty());
                if !ok {
                    return Err("session-identity-mismatch");
                }
                b["sessionRef"] = sref.clone();
            }
            Ok(b)
        }
        "browser" => match payload.get("url").and_then(Value::as_str) {
            Some(url) => {
                let mut b = json!({ "browser": url, "name": name });
                if let Some(dt) = payload.get("devToolsOpen").filter(|v| v.is_boolean()) {
                    b["devToolsOpen"] = dt.clone();
                }
                Ok(b)
            }
            None => Err("missing-url"),
        },
        "editor" => match payload.get("filePath") {
            Some(file_path) if file_path.is_string() || file_path.is_null() => {
                let mut b = json!({ "editor": file_path, "name": name });
                if let Some(lang) = payload.get("language").filter(|v| v.is_string()) {
                    b["language"] = lang.clone();
                }
                if let Some(ro) = payload.get("readOnly").filter(|v| v.is_boolean()) {
                    b["readOnly"] = ro.clone();
                }
                if let Some(vm) = payload.get("viewMode").filter(|v| v.is_string()) {
                    b["viewMode"] = vm.clone();
                }
                if let Some(ww) = payload.get("wordWrap").filter(|v| v.is_boolean()) {
                    b["wordWrap"] = ww.clone();
                }
                Ok(b)
            }
            _ => Err("missing-filePath"),
        },
        _ => Err("unsupported-kind"),
    }
}
```

IMPORTANT: before writing the file, diff the browser/editor arms above against the current `tabs_snapshots.rs:177-249` and copy the CURRENT text verbatim if it differs in any detail — the only intended delta versus today's code is the `createRequestId` block and the `pub(crate)` visibility.

In `crates/freshell-server/src/tabs_snapshots.rs`, replace the entire inline function (`:177-249`, including its doc comment) with:

```rust
#[path = "tabs_snapshots_create_body.rs"]
mod tabs_snapshots_create_body;
use tabs_snapshots_create_body::pane_to_create_body;
```

The `use` alias keeps `super::pane_to_create_body` resolving from the `#[path]`-included children (`tabs_snapshots_marker.rs:458` and the test modules, which import via `use super::*;`).

- [ ] **Step 4: Run tests to verify they pass, and verify the line cap**

Run:
```bash
cargo test -p freshell-server
wc -l crates/freshell-server/src/tabs_snapshots.rs
```
Expected: all tests PASS (the new one plus the existing `create_body_carries_full_terminal_state_including_codex_durability` and the end-to-end `restore_round_trips_non_default_pane_state_to_the_client`); `tabs_snapshots.rs` is now well under 1000 lines and the new sibling is far under it too.

- [ ] **Step 5: Format, lint, commit**

Run:
```bash
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
git add crates/freshell-server/src/tabs_snapshots.rs crates/freshell-server/src/tabs_snapshots_create_body.rs crates/freshell-server/src/tabs_snapshots_restore_tests.rs
git commit -m "feat(server): snapshot restore carries createRequestId into pane create bodies"
```

---

### Task 6: E2E — REST-created pane is keyed; reload preserves the key

**Files:**
- Create: `test/e2e-browser/specs/createrequestid-stabilization-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (two minimal appends: `RUST_ONLY_SPECS` at `:81-114` AND the `rust-chromium` project's `testMatch` at `:167-253` — missing the first makes the match-all `chromium` project run it under the `'legacy'` server default and fail; every registry entry carries a why-comment per the file's convention)

**Interfaces:**
- Consumes: `test/e2e-browser/helpers/fixtures.js` (`test as base`, `expect`, worker-scoped `testServer` → `serverInfo: { baseUrl, token, port, ... }` with ephemeral ports — never 3001/3002), `helpers/test-harness.js` `TestHarness` (`waitForHarness`, `waitForConnection`, `getPaneLayout(tabId)`, `dispatch`), the REST envelope `{status, data}` with `x-auth-token` auth, localStorage key `freshell.layout.v3`, and the server-mint format from Task 3 (32 hex chars — discriminates a server-minted key from a client-side 21-char nanoid fallback, which is what makes these tests prove the server behavior rather than the client's own mint).
- Produces: end-to-end proof of both spec acceptance criteria: "REST-created pane has one" and "reload page → same createRequestId per pane".

- [ ] **Step 1: Write the spec**

Create `test/e2e-browser/specs/createrequestid-stabilization-rust.spec.ts`:

```ts
/**
 * Lane A1 (P1.6, restart-resilience campaign): createRequestId key
 * stabilization. Rust-only: the mint under test lives in the Rust REST
 * ingress (crates/freshell-freshagent spawn_terminal_pane).
 *
 * Proves, end to end:
 *  1. A pane created via POST /api/tabs carries a SERVER-minted
 *     createRequestId (32-hex Uuid::simple — a client-side fallback mint
 *     would be a 21-char nanoid, so the format assertion discriminates).
 *  2. A full page reload hydrates the SAME createRequestId (no re-mint).
 */
import os from 'node:os'
import { test as base, expect } from '../helpers/fixtures.js'
import { TestHarness } from '../helpers/test-harness.js'

const test = base

function unwrapData(body: any): any {
  return body && typeof body === 'object' && 'data' in body ? body.data : body
}

async function createTab(
  baseUrl: string,
  token: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; tabId?: string; paneId?: string; body: any }> {
  const res = await fetch(`${baseUrl}/api/tabs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-auth-token': token },
    body: JSON.stringify(payload),
  })
  const rawBody = await res.json().catch(() => undefined)
  const data = unwrapData(rawBody) as { tabId?: string; paneId?: string } | undefined
  return { status: res.status, tabId: data?.tabId, paneId: data?.paneId, body: rawBody }
}

function collectTerminalCreateRequestIds(node: any, out: string[] = []): string[] {
  if (!node) return out
  if (node.type === 'leaf') {
    if (node.content?.kind === 'terminal' && typeof node.content.createRequestId === 'string') {
      out.push(node.content.createRequestId)
    }
    return out
  }
  collectTerminalCreateRequestIds(node.children?.[0], out)
  collectTerminalCreateRequestIds(node.children?.[1], out)
  return out
}

test.describe('createRequestId stabilization (rust REST ingress + reload)', () => {
  test('REST-created terminal pane carries a server-minted createRequestId', async ({ page, e2eServerKind, serverInfo }) => {
    expect(e2eServerKind).toBe('rust')
    const { baseUrl, token } = serverInfo

    // Connect the browser FIRST: the server broadcasts ui.command{tab.create}
    // over the live WS connection when a tab is created via REST.
    await page.goto(`${baseUrl}/?token=${token}&e2e=1`)
    const harness = new TestHarness(page)
    await harness.waitForHarness()
    await harness.waitForConnection()

    const created = await createTab(baseUrl, token, {
      mode: 'shell', cwd: os.tmpdir(), name: 'crid-rest-tab',
    })
    expect(created.status, `POST /api/tabs failed: ${JSON.stringify(created.body)}`).toBe(200)
    expect(created.tabId).toBeTruthy()

    await expect
      .poll(async () => collectTerminalCreateRequestIds(await harness.getPaneLayout(created.tabId!)), {
        timeout: 15_000,
      })
      .toHaveLength(1)

    const [key] = collectTerminalCreateRequestIds(await harness.getPaneLayout(created.tabId!))
    // 32 lowercase hex = Uuid::new_v4().simple() minted by the Rust REST
    // ingress; a 21-char nanoid here would mean the client minted a fallback
    // key because the server sent none.
    expect(key).toMatch(/^[0-9a-f]{32}$/)
  })

  test('page reload hydrates the same createRequestId for the pane', async ({ page, e2eServerKind, serverInfo }) => {
    expect(e2eServerKind).toBe('rust')
    const { baseUrl, token } = serverInfo

    await page.goto(`${baseUrl}/?token=${token}&e2e=1`)
    const harness = new TestHarness(page)
    await harness.waitForHarness()
    await harness.waitForConnection()

    const created = await createTab(baseUrl, token, {
      mode: 'shell', cwd: os.tmpdir(), name: 'crid-reload-tab',
    })
    expect(created.status).toBe(200)
    expect(created.tabId).toBeTruthy()

    await expect
      .poll(async () => collectTerminalCreateRequestIds(await harness.getPaneLayout(created.tabId!)), {
        timeout: 15_000,
      })
      .toHaveLength(1)
    const [keyBefore] = collectTerminalCreateRequestIds(await harness.getPaneLayout(created.tabId!))
    expect(keyBefore).toMatch(/^[0-9a-f]{32}$/)

    // Defeat the persist debounce before reloading (house pattern).
    await page.evaluate(() => {
      (window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
    })
    const layoutRaw = await page.evaluate(() => localStorage.getItem('freshell.layout.v3'))
    expect(layoutRaw, 'layout must be persisted before reload').toBeTruthy()
    expect(layoutRaw).toContain(keyBefore)

    await page.reload({ waitUntil: 'domcontentloaded' })
    await harness.waitForHarness()
    await harness.waitForConnection()

    await expect
      .poll(async () => collectTerminalCreateRequestIds(await harness.getPaneLayout(created.tabId!)), {
        timeout: 15_000,
      })
      .toHaveLength(1)
    const [keyAfter] = collectTerminalCreateRequestIds(await harness.getPaneLayout(created.tabId!))
    expect(keyAfter, 'reload must hydrate the SAME pane identity key, not re-mint').toBe(keyBefore)
  })
})
```

If `e2eServerKind` is not directly destructurable in this fixture setup, copy the exact destructuring used by `specs/rest-tab-persistence.spec.ts:529` (`async ({ page, e2eServerKind, serverInfo, testServer })`) — that spec is the direct pattern source for this one.

- [ ] **Step 2: Register the spec in `playwright.config.ts` (two appends)**

In `test/e2e-browser/playwright.config.ts`, append to `RUST_ONLY_SPECS` (`:81-114`):

```ts
  // Lane A1 (P1.6): createRequestId stabilization — asserts the Rust REST
  // ingress mints the key (Uuid::simple format), so it must run against the
  // rust server only.
  /createrequestid-stabilization-rust\.spec\.ts$/,
```

and append the same regex + comment to the `rust-chromium` project's `testMatch` array (`:167-253`). Keep both appends at the END of their arrays to minimize conflict surface with the 5 sibling lanes (trivial adjacent-line conflicts are expected and fine).

- [ ] **Step 3: Run the spec**

Run:
```bash
npm run test:e2e -- --project=rust-chromium createrequestid-stabilization-rust
```
Expected: 2 passed. Notes: the e2e `globalSetup` runs `npm run build:client && npm run build:server` first, and `RustServer.start()` builds `target/release/freshell-server` if missing — the first run can take several minutes. The fixture asserts its own ephemeral port (`expect(info.port).not.toBe(3001)` is the house invariant); never point this spec at 3001/3002 or any running server.

- [ ] **Step 4: Commit**

```bash
git add test/e2e-browser/specs/createrequestid-stabilization-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): createRequestId survives reload and is server-minted for REST panes"
```

---

### Task 7: Full verification, push branch, STOP (no PR)

**Files:** Modify `port/oracle/DEVIATIONS.md` (append EDEV-08), `port/contract/nondeterministic-fields.md` (one row) — otherwise verification + push only

**Interfaces:**
- Consumes: all prior tasks' commits.
- Produces: a pushed branch with red→green proof; explicitly NO pull request.

- [ ] **Step 1: Sibling-lane drift re-check (cheap, read-only)**

Run:
```bash
for w in /home/dan/code/freshell/.worktrees/*/; do echo "== $w"; git -C "$w" diff --name-only origin/main...HEAD 2>/dev/null; done
```
Check whether any sibling lane has landed changes to `crates/freshell-terminal/src/registry.rs` (Lane A5's 10th `scrollback` param — if present, add the extra trailing arg at the Task 3 call site), `crates/freshell-ws/src/tabs_persist_tests.rs` / `tabs_persist_validation.rs`, or `src/store/panesSlice.ts`. As of plan validation (2026-07-25) all five sibling branches were plan-doc-only.

- [ ] **Step 2: Rust gates**

Run:
```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p freshell-freshagent -p freshell-ws -p freshell-server -p freshell-terminal
```
Expected: all PASS (freshell-terminal included as the consumer of the now-populated `create_request_id` — we changed no code there, this proves it).

- [ ] **Step 3: Coordinated client/server suites (gate-aware)**

Run:
```bash
npm run test:status   # if the gate is held by another agent, WAIT — do not kill
npm run typecheck
FRESHELL_TEST_SUMMARY="lane A1 createRequestId final verification" npm test
```
Expected: PASS.

- [ ] **Step 4: E2E re-run**

Run:
```bash
npm run test:e2e -- --project=rust-chromium createrequestid-stabilization-rust
```
Expected: 2 passed.

- [ ] **Step 5: Port-parity bookkeeping (DEVIATIONS ledger + nondeterministic-fields inventory)**

Task 3 made the Rust server emit `paneContent.createRequestId` in `ui.command{tab.create}` /
`pane.split` broadcasts where the legacy Node server emits none (verified: no parity gate
diffs these payloads — V5 report — but `port/AGENTS.md:34-37` requires every deliberate
old-vs-new divergence to be logged in `port/oracle/DEVIATIONS.md` with an objective defect
criterion and a pinning positive test, which now exists and is green as of Steps 2-4).
Two docs-only edits; do NOT touch any other port/ file.

Edit 1 — append to `port/oracle/DEVIATIONS.md` immediately AFTER the last line of EDEV-07
(its `- user_impact:` paragraph ending `...with its session identity intact.`, currently
line 854) and BEFORE the `<!--\nTemplate:` comment block, exactly this entry:

```markdown

### EDEV-08 — REST pane create MINTS a stable `createRequestId` into the broadcast pane content (pane-identity stabilization)
- what_differs: `POST /api/tabs` (terminal path) and `POST /api/panes/:id/split` (which
  shares `spawn_terminal_pane`) now accept-or-mint a `createRequestId`
  (`Uuid::new_v4().simple()`, 32 lowercase hex; a caller-supplied key — the snapshot-restore
  path via `pane_to_create_body` — is honored verbatim) and emit it in the broadcast pane
  content: `ui.command{tab.create}` `payload.paneContent.createRequestId` and
  `ui.command{pane.split}` `payload.newContent.createRequestId`
  (`crates/freshell-freshagent/src/terminal_tabs.rs`, `spawn_terminal_pane`), with the same
  key stamped atomically into the terminal registry (`TerminalRegistry::create`'s existing
  `create_request_id` parameter). Legacy emits NO `createRequestId` in either payload
  (`server/agent-api/router.ts:762-789` tab.create terminal paneContent, `:1360-1380`
  pane.split newContent) — the frozen client then mints its own substitute nanoid on receipt
  (`src/store/panesSlice.ts:78-79`). Parity nuance, `ui.command{pane.attach}`: `POST
  /api/panes/:id/respawn` delegates to the same shared pipeline (`pane_ops.rs`), so its
  `pane.attach` `content` now carries the key too — there legacy ALREADY mints one
  (`router.ts:1602` respawn, `:1646` terminal-attach, `createRequestId: nanoid()`), so
  pane.attach moves TOWARD parity (both sides keyed; value format differs, uuid-simple vs
  nanoid — both opaque ids the oracle normalizer masks,
  `port/oracle/harness/normalize.ts:77` `createRequestId: ID('RID')`). The fresh-agent
  tab.create path already carried the key on BOTH sides (`router.ts:558/:578`; the rust
  fresh-agent create) — unchanged. Wire-contract safe: the frozen `ui.command` payload is
  free-form (`port/contract/ws-server-messages.schema.json:2856-2874`, `"payload": true`);
  absence of the field stays legal on read everywhere (backward compat).
- why_intentional: Rust is the better side — the legacy keyless broadcast is the root cause
  of pane-identity correlation loss (restart-resilience campaign P1.6 /
  reconciliation-handshake design §5.5 precondition 2): a REST-created pane never receives a
  server-known identity key, the client's substitute nanoid is re-minted on hydrate, so
  panes cannot be re-identified across reload/restore and server state keyed on
  `create_request_id` (terminal registry) can never match a client pane. Minting
  server-side — and honoring the captured key on snapshot restore — makes the key stable
  end-to-end with ZERO legacy-server changes and no client schema change.
- evidence: RED-first unit coverage in `crates/freshell-freshagent/src/terminal_tabs.rs`
  (`rest_create_terminal_tab_mints_and_stamps_create_request_id`,
  `rest_create_honors_caller_supplied_create_request_id`) and the extended split assertion
  in `crates/freshell-freshagent/src/pane_ops.rs`
  (`split_terminal_pane_spawns_real_pty_and_broadcasts_pane_split`) plus the extended
  respawn rotation test (`respawn_pane_replaces_terminal_in_place_and_broadcasts_pane_attach`,
  also `pane_ops.rs`); e2e pin:
  `test/e2e-browser/specs/createrequestid-stabilization-rust.spec.ts` (the 32-hex
  server-mint discriminator + reload-preserves-key). Legacy shape:
  `server/agent-api/router.ts:762-789` / `:1360-1380` (no key), `:1602` / `:1646`
  (pane.attach, keyed).
- user_impact: A REST-created terminal pane keeps ONE stable identity key from creation
  through reload/restore — the precondition for reconciliation-phase dedupe/adoption —
  instead of a fresh client-minted key per hydrate; snapshot-restored panes are re-created
  under their captured key.
```

Edit 2 — in `port/contract/nondeterministic-fields.md`, update the `createRequestId` row
(currently line 45). REPLACE:

```
| `createRequestId` | pane create correlation | ui.layout.sync (`layouts[*].content`) |
```

WITH:

```
| `createRequestId` | pane create correlation | ui.layout.sync (`layouts[*].content`), ui.command{tab.create} (`paneContent`) / {pane.split} (`newContent`) / {pane.attach} (`content`) — rust-only for tab.create/pane.split, see DEVIATIONS EDEV-08 |
```

(Payload key names differ per command — `paneContent` / `newContent` / `content` — so the
row names each rather than a single blanket `(paneContent)`.)

Then verify nothing else changed and commit the two docs:

```bash
git status --short   # expect ONLY the two port/ docs modified
git add port/oracle/DEVIATIONS.md port/contract/nondeterministic-fields.md
git commit -m "docs(port): log EDEV-08 createRequestId broadcast divergence + inventory row"
```

- [ ] **Step 6: Push the branch and STOP**

Run:
```bash
git log --oneline origin/main..HEAD
git push -u origin "$(git branch --show-current)"
```
Then STOP. Do NOT run `gh pr create` — PR creation is not approved for this lane. Report: the branch name, the commit list, and the red→green proof per task (each task's Step-2 failing run and Step-4/5 passing run).

---

## Non-goals (explicit boundaries, per the scope fence — not silent deferrals)

These are behaviors the spec assigns to OTHER lanes or explicitly excludes; each is listed with why excluding it is safe, not a coverage gap of this plan:

- **Registry-reopen ("Open copy"/"Reopen") key preservation** (`sanitizePaneSnapshot` in `src/components/TabsView.tsx:111`): outside this lane's owned files. Reopen creates a NEW pane from a registry record; the design doc frames `createRequestId` as a create-dedupe/reservation key, so a new create minting a new key there is coherent. This lane's requirement — snapshot builder → wire → validator → `pane_to_create_body` — is fully covered by Tasks 2, 4, 5.
- **`restoreLayout` fresh-identity semantics** (`stripStaleIds`/`normalizeRestoredTree`): intentional rotation, preserved unchanged (Task 1 passes no `previous` through that path; existing suites guard it).
- **Keyed-create dedupe/adoption at REST ingress**: the WS path's adopt-on-duplicate-key logic (`crates/freshell-ws/src/terminal.rs:900-926`) is not replicated for REST in this slice; REST only mints/accepts and stamps. Dedupe joins on the key belong to the reconciliation Phase-3 work this lane is a precondition for.
- **`clearTerminalContentForRecreate` per-recreate mint**: intentional by the task spec; untouched; guarded by existing `panesSlice`/`crossTabSync` suites and the `App.tsx:1050-1075` recovery-path matching it feeds.
- **Browser/editor pane keys**: reconciliation v1 is terminal-only (`client_messages.rs` "v1: `terminal` only"); fresh-agent keys are persisted (Tasks 2/4) because the REST fresh-agent path already mints them, but `pane_to_create_body` emits the key only for the terminal arm it supports.
- **Documented inferences (design docs are silent; validated 2026-07-25):** (a) Registry-reopen and `restoreLayout` fresh-identity semantics are an INFERENCE, not a doc ruling — neither the campaign doc nor the reconciliation-handshake design mentions those sites; the reading is supported indirectly (key is 'unique per pane, stable across terminal generations' — handshake §5.5 Assumption 6; cross-device session continuity is `sessionRef`'s job per campaign D8). (b) The campaign doc (D4) actually names `clearTerminalContentForRecreate`'s re-mint the 'most consequential' defect — leaving it untouched here rests on the campaign assigning its retirement to P1.7/F3, not this lane. (c) Fresh-agent key persistence (Tasks 2/4) is justified at CAMPAIGN granularity: P1.6 is framed as a precondition ('for anything joining on the key') with campaign-level readers P1.13 (fresh-agent verdicts) and P1.9 (recover-my-panes); the letter of §4.1.6 'nothing ships dormant' is slice-granular, so this exemption is recorded explicitly rather than implied.

## Self-Review (performed while writing; recorded for the plan reviewer)

1. **Spec coverage:** Fix 1 (hydrate preserves; mint only when genuinely absent) → Task 1 (+ lock-in test for the `persistMiddleware.ts:229` preserve-when-present behavior). Fix 2 (REST ingress mints; returned/persisted wherever pane records flow: registry stamp + paneContent broadcast + split path) → Task 3. Fix 3 (snapshot pipeline end-to-end: builder → wire → tolerance-locked persistence → `pane_to_create_body`; old snapshots stay valid; wrong types never poison a device) → Tasks 2, 4, 5. TDD red-first with client unit, rust unit, and both named e2e criteria → Tasks 1-6. Repo rules (worktree, baseline green, gate, ports, PR stop) → Tasks 0 and 7 + Global Constraints.
2. **No silent deferrals:** every excluded behavior is listed under Non-goals with the owning lane or design rationale; none is a user-facing requirement of THIS spec. The e2e discriminator (32-hex vs nanoid) ensures the "REST pane has a key" outcome is proven as production server behavior, not a client-side stub key.
3. **Placeholder scan:** every code step contains the actual code; the two "match local convention" notes (Task 3 broadcast-drain mechanics, Task 4 fixture arity) point at named, quoted, existing tests in the SAME file as the source of truth rather than leaving behavior undefined.
4. **Type consistency:** the field is `createRequestId` (camelCase) in every JSON surface; Rust-side snake_case `create_request_id` only for the existing registry parameter; `payload.createRequestId` placement is used consistently by Task 2 (writer), Task 4 (persistence tolerance locks), Task 5 (reader); Task 5 emits body-level `createRequestId` which Task 3 reads from the request body — one producer/consumer pair per hop, names verified against each task's Interfaces block.
5. **Load-bearing validation (Stage 2):** the plan was hardened against a validated assumption ledger (see workflow logs `load-bearing-ledger.md`): respawn is a third covered `spawn_terminal_pane` caller with rotation documented as intentional legacy parity; Task 1's inheritance is hydrate-scoped (opt-in flag) because `updatePaneContent` resume/repair paths RELY on mint-when-absent rotation; Task 4 adds NO strict validator check (a shared read-path type check would make one wrong-typed persisted field render ALL device snapshots unreadable) and its tests live in a new file to avoid Lane A6's planned co-edit of `tabs_persist_tests.rs`; the Rust-only emission divergence is booked as EDEV-08 per port/AGENTS.md.
