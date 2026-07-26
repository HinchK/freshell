# Reconcile Completion (Lane C2) Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Complete the reconcile handshake for fresh-agent panes (client verdict folding), extend the per-sessionRef create/resume lease (D8) to fresh-agent create-with-resume paths, and close the reload-path pre-verdict create race so a hydrated pane never fires an identity-less create before its reconcile verdict folds.

**Architecture:** Three legs. (1) Client: widen the existing B1 terminal fold architecture (`src/lib/pane-reconcile.ts` + `panesSlice` fold reducers + volatile `reconcileEpoch` re-fire) to `kind: 'fresh-agent'` panes behind the already-shipped server capability `paneReconcileFreshAgentV1`, folding verdicts into new fresh-agent-shaped reducers and the existing batched DeadSessionPanel. (2) Server: a new liveness-bound `FreshAgentSessionLeases` primitive in `crates/freshell-freshagent` (mirroring `TerminalRegistry`'s D8 lease semantics: fail-closed, kill-before-release TTL, `SESSION_RESERVED` losers) claimed inside every fresh-agent create/attach resume seam. (3) Client drive: when reconcile is negotiated, both `TerminalView` and `FreshAgentView` defer their mount-time create until the pane's verdict folds, bounded by a wall-clock timeout that falls back to the legacy drive.

**Tech Stack:** React 18 + Redux Toolkit + Zod (client), Rust (crates/freshell-ws, freshell-freshagent, freshell-protocol), Vitest (unit), cargo test (Rust), Playwright (e2e, `rust-chromium` project).

## Global Constraints

- Base: `origin/main @ bf6242a1`; worktree `/home/dan/code/freshell/.worktrees/reconcile-completion`, branch `feat/reconcile-completion`. All work happens inside this worktree.
- SCOPE FENCE — you own: client reconcile fold modules (`src/lib/pane-reconcile.ts`, `panesSlice` fold reducers, `DeadSessionPanel`), the `FreshAgentView`/`TerminalView` drive seams, `crates/freshell-ws/src/reconcile_freshagent.rs` + lease extension seams, `crates/freshell-freshagent` create/attach lease integration.
- SCOPE FENCE — do NOT touch: sidebar/sessions code (`sessionsSlice`, Sidebar components, `session_directory.rs` — Lane C1); port/contract tooling; `shared/ws-protocol.ts` beyond what this plan explicitly specifies (Lane C3 owns contract tooling — every `shared/ws-protocol.ts` edit in this plan is deliberate, minimal, and must be called out in its commit message with the marker `[C3-NOTE]`). No kimi/gemini work. No codex rollout locator (B2). No tabs-snapshots / recover-my-panes UI (B3).
- Council rules (binding, from B1): `createRequestId` is NEVER re-minted by any fold path; dead sessions batch into ONE panel (never N modals); `corrected: true` is always user-visible; the legacy recovery path stays as the capability-gated fallback (never deleted); recovery is automatic, never offered; never a silent wedge, never a duplicate.
- Rust CI gates: `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings` must pass.
- Server imports (Node side): NodeNext/ESM — relative imports include `.js` extensions (applies to `shared/` and `server/`; client `src/` uses Vite aliases `@/`, `@shared/`, `@test/`).
- Coordinated node suites: broad runs go through the shared coordinator gate — `FRESHELL_TEST_SUMMARY="C2 reconcile-completion" env -u FRESHELL_BIND_HOST npm test`. If the gate is held by a sibling lane, WAIT — never kill a foreign holder. Focused runs: `npm run test:vitest -- run <paths>`.
- E2E: own `RustServer` instances on ephemeral ports only. NEVER ports 3001/3002. NEVER restart the user's self-hosted server. No broad kill patterns (`pkill -f`, `pkill node`, etc.). New rust-only specs must be registered in BOTH `RUST_ONLY_SPECS` and the `rust-chromium` `testMatch` in `test/e2e-browser/playwright.config.ts`.
- PR POLICY: NOT approved. Push the branch; STOP before `gh pr create` or any equivalent.
- Check disk space before long builds (`df -h .`); halt and report on ENOSPC.
- Commit after every task (focused, atomic). Commit messages use conventional commits with the Amplifier co-author trailer.
- Frozen-client invariant: a client that does not send `paneReconcileFreshAgentV1` must see byte-identical behavior; a server that does not advertise it must leave the client on the legacy fresh-agent recovery path.

---

## File Structure

Client (modify):
- `shared/ws-protocol.ts` — widen `ReconcilePaneSchema.kind`, add `paneReconcileFreshAgentV1` to `ReadyCapabilitiesSchema` (minimal, `[C3-NOTE]`).
- `src/lib/ws-client.ts` — hello opt-in for the new capability.
- `src/store/paneTypes.ts` — fresh-agent volatile fold fields; `DeadSessionEntry.kind`; `reconcilePendingPanes` slice field.
- `src/store/panesSlice.ts` — fresh-agent fold reducers, widened finder, pending-pane reducers, persistence strips.
- `src/store/persistMiddleware.ts` — strip new volatile fields.
- `src/lib/pane-reconcile.ts` — fresh-agent request producer + fold routing; capability flag accessor.
- `src/components/DeadSessionPanel.tsx` — kind-aware "Start fresh here".
- `src/App.tsx` — capability capture, fresh-agent panes in the boot request, pending-pane set/clear.
- `src/components/TerminalView.tsx` — pre-verdict create wait.
- `src/components/fresh-agent/FreshAgentView.tsx` — epoch re-fire, pendingReconcile consumption, pre-verdict wait, capability-gated `.lost` handling, SESSION_RESERVED re-drive, reconcile notice.

Server (create/modify):
- Create: `crates/freshell-freshagent/src/session_lease.rs` — the fresh-agent D8 lease primitive.
- Modify: `crates/freshell-freshagent/src/lib.rs` (module export + runtime wiring), `claude.rs`, `codex.rs`, `opencode_ws.rs` (lease claims at resume seams), `crates/freshell-server/src/main.rs` (one shared lease map into all three runtimes).

Tests (create):
- `test/unit/client/lib/pane-reconcile.fresh-agent.test.ts`
- `test/unit/client/store/panesSlice.fresh-agent-reconcile.test.ts`
- `test/unit/client/components/FreshAgentView.reconcile.test.tsx`
- `test/unit/client/components/TerminalView.verdict-wait.test.tsx`
- `crates/freshell-freshagent/src/session_lease.rs` (`mod tests`)
- `crates/freshell-ws/tests/freshagent_session_lease.rs`
- `test/e2e-browser/specs/reconcile-completion-rust.spec.ts`

---

### Task 0: Workspace + baseline sanity

**Files:** none created (verification only).

**Interfaces:**
- Consumes: the worktree created by the workspace stage.
- Produces: a proven-green starting point for every later task.

- [ ] **Step 1: Verify worktree, toolchain, and disk**

```bash
cd /home/dan/code/freshell/.worktrees/reconcile-completion
git status --short && git log --oneline -1   # expect: clean (or plan file only), bf6242a1
df -h .                                       # halt + report if ~full
node --version && cargo --version
[ -d node_modules ] || npm ci                 # tsx symlink comes with npm ci
```

- [ ] **Step 2: Focused baseline — the suites this plan touches most**

```bash
cargo test -p freshell-ws --test pane_reconcile_freshagent
cargo test -p freshell-ws --test session_ref_singleflight
npm run test:vitest -- run test/unit/client/lib/pane-reconcile.test.ts test/unit/client/store/panesSlice.reconcile.test.ts
```
Expected: all PASS. If any fail on the untouched base, STOP and report — do not build on a red base.

- [ ] **Step 3: Check the shared coordinator status (informational)**

```bash
npm run test:status
```
Expected: prints holder/baseline info. No action needed; just confirms the coordinator is reachable.

---

### Task 1: Protocol widening + hello capability (client side of `paneReconcileFreshAgentV1`)

**Files:**
- Modify: `shared/ws-protocol.ts` (`ReconcilePaneSchema` ~line 575-594, `ReadyCapabilitiesSchema` ~line 640-643)
- Modify: `src/lib/ws-client.ts` (~line 360, hello capabilities)
- Test: `test/unit/client/lib/ws-client.reconcile.test.ts` (extend)

**Interfaces:**
- Consumes: existing `ReconcilePaneSchema`, `ReadyCapabilitiesSchema`, `WsClient.sendHello()`.
- Produces: `ReconcilePane['kind']` is `'terminal' | 'fresh-agent'`; `ReadyCapabilities.paneReconcileFreshAgentV1?: true`; hello sends `paneReconcileFreshAgentV1: true`. Later tasks rely on exactly these names.

The Rust server already parses `hello.capabilities.paneReconcileFreshAgentV1` (`crates/freshell-ws/src/lib.rs:617-621`) and echoes `ready.capabilities.paneReconcileFreshAgentV1` (`lib.rs:398-415`); this task is TS-only. This is a deliberate minimal `shared/ws-protocol.ts` change — commit with `[C3-NOTE]`.

- [ ] **Step 1: Write the failing tests** — append to `test/unit/client/lib/ws-client.reconcile.test.ts` (follow the file's existing FakeWebSocket harness):

```ts
it('hello opts into paneReconcileFreshAgentV1', () => {
  // reuse the file's existing setup that captures the hello frame
  const hello = sentMessages.find((m) => m.type === 'hello') as { capabilities?: Record<string, unknown> }
  expect(hello?.capabilities?.paneReconcileFreshAgentV1).toBe(true)
})

it('getServerCapabilities exposes paneReconcileFreshAgentV1 from ready', () => {
  receiveReady({ capabilities: { paneReconcileV1: true, paneReconcileFreshAgentV1: true } })
  expect(client.getServerCapabilities().paneReconcileFreshAgentV1).toBe(true)
})
```

And a schema test (same file or a small block in `test/unit/client/lib/pane-reconcile.test.ts`):

```ts
import { ReconcilePaneSchema, ReadyCapabilitiesSchema } from '@shared/ws-protocol'

it('ReconcilePaneSchema accepts kind fresh-agent', () => {
  const parsed = ReconcilePaneSchema.safeParse({
    paneKey: 't1:p1', kind: 'fresh-agent', mode: 'claude', createRequestId: 'req-1',
    sessionRef: { provider: 'claude', sessionId: '11111111-1111-4111-8111-111111111111' },
  })
  expect(parsed.success).toBe(true)
})

it('ReadyCapabilitiesSchema accepts paneReconcileFreshAgentV1', () => {
  expect(ReadyCapabilitiesSchema.safeParse({ paneReconcileFreshAgentV1: true }).success).toBe(true)
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test:vitest -- run test/unit/client/lib/ws-client.reconcile.test.ts test/unit/client/lib/pane-reconcile.test.ts
```
Expected: FAIL — schema rejects `'fresh-agent'` / unknown capability key; hello lacks the field.

- [ ] **Step 3: Implement** — in `shared/ws-protocol.ts`:

```ts
// ReconcilePaneSchema (was: kind: z.literal('terminal')):
kind: z.enum(['terminal', 'fresh-agent']),
```

```ts
export const ReadyCapabilitiesSchema = z
  .object({
    paneReconcileV1: z.literal(true).optional(),
    paneReconcileFreshAgentV1: z.literal(true).optional(),
  })
  .optional()
```

In `src/lib/ws-client.ts` (~:360), inside the hello `capabilities` object:

```ts
capabilities: {
  uiScreenshotV1: true,
  terminalOutputBatchV1: true,
  paneReconcileV1: true,
  paneReconcileFreshAgentV1: true,
},
```

Also update the hello capabilities schema in `shared/ws-protocol.ts` (~:277 block) to accept the new key:

```ts
paneReconcileFreshAgentV1: z.literal(true).optional(),
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test:vitest -- run test/unit/client/lib/ws-client.reconcile.test.ts test/unit/client/lib/pane-reconcile.test.ts
```
Expected: PASS. Also run the wire-shape guard on the Rust side (no changes expected, just proof):

```bash
cargo test -p freshell-protocol --test pane_reconcile
```

- [ ] **Step 5: Commit**

```bash
git add shared/ws-protocol.ts src/lib/ws-client.ts test/unit/client/lib/ws-client.reconcile.test.ts test/unit/client/lib/pane-reconcile.test.ts
git commit -m "feat(reconcile): widen ReconcilePane kind to fresh-agent + hello paneReconcileFreshAgentV1 [C3-NOTE: minimal ws-protocol widening — kind enum + ready/hello capability key]"
```

---

### Task 2: Fresh-agent volatile fold fields + persistence strips

**Files:**
- Modify: `src/store/paneTypes.ts` (`FreshAgentPaneContent`, ~:174-203)
- Modify: `src/store/panesSlice.ts` (`stripStaleIds` ~:878-887)
- Modify: `src/store/persistMiddleware.ts` (fresh-agent arm of the per-pane strip, ~:245-266)
- Test: `test/unit/client/store/panesSlice.fresh-agent-reconcile.test.ts` (create)

**Interfaces:**
- Consumes: `FreshAgentPaneContent` (paneTypes.ts:174).
- Produces: three new optional fields on `FreshAgentPaneContent` — `reconcileNotice?: string`, `pendingReconcile?: 'respawn' | 'fresh'`, `reconcileEpoch?: number` — identical names and semantics to the terminal trio (`paneTypes.ts:98-102`). All three are VOLATILE: never persisted, absent after hydration. Tasks 3/7/9 rely on these exact names.

- [ ] **Step 1: Write the failing tests** — create `test/unit/client/store/panesSlice.fresh-agent-reconcile.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

describe('fresh-agent reconcile volatile fields', () => {
  it('persistence strips reconcileEpoch/pendingReconcile/reconcileNotice from fresh-agent panes', async () => {
    // Follow the existing pattern in test/unit/client/store/panesSlice.reconcile.test.ts (:223-248):
    // build a store with one fresh-agent leaf whose content carries all three fields,
    // run the persist middleware's serialization path, and assert the persisted leaf
    // contains none of them.
    const persisted = await persistLeafWithContent({
      kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude',
      createRequestId: 'req-1', status: 'connected',
      sessionRef: { provider: 'claude', sessionId: '11111111-1111-4111-8111-111111111111' },
      reconcileEpoch: 3, pendingReconcile: 'respawn', reconcileNotice: 'x',
    })
    expect('reconcileEpoch' in persisted.content).toBe(false)
    expect('pendingReconcile' in persisted.content).toBe(false)
    expect('reconcileNotice' in persisted.content).toBe(false)
    expect(persisted.content.sessionRef?.sessionId).toBe('11111111-1111-4111-8111-111111111111')
  })
})
```

`persistLeafWithContent` is a local helper you write in this test file by copying the store+middleware setup from `test/unit/client/store/panesSlice.reconcile.test.ts` (the terminal `reconcileEpoch` strip test at :248 is the model — reuse its mechanics exactly, swapping in a fresh-agent leaf).

- [ ] **Step 2: Run to verify failure**

```bash
npm run test:vitest -- run test/unit/client/store/panesSlice.fresh-agent-reconcile.test.ts
```
Expected: FAIL — TypeScript rejects the unknown fields (compile error) — that IS the red state.

- [ ] **Step 3: Implement**

`src/store/paneTypes.ts`, inside `FreshAgentPaneContent` (mirror the terminal comments at :98-102):

```ts
  /** One-shot user-visible reconcile notice; rendered + cleared by FreshAgentView. VOLATILE. */
  reconcileNotice?: string
  /** Set by verdict folds; consumed when freshAgent.created lands. VOLATILE. */
  pendingReconcile?: 'respawn' | 'fresh'
  /** VOLATILE fold counter — re-fires FreshAgentView's create effect on same-createRequestId folds. */
  reconcileEpoch?: number
```

`src/store/panesSlice.ts` `stripStaleIds` fresh-agent arm (:878-887) — add the three fields to the destructure:

```ts
if (content.kind === 'fresh-agent') {
  const {
    sessionId, createRequestId, status, serverInstanceId, createError,
    reconcileEpoch, pendingReconcile, reconcileNotice,
    ...rest
  } = content
  return rest
}
```

`src/store/persistMiddleware.ts` — locate the fresh-agent branch of the per-pane transient strip (the sibling of the terminal strip at :253-259; if the fresh-agent path flows only through `stripStaleIds`, the panesSlice change above is sufficient — verify by making the test pass, and if it already passes after the panesSlice edit, make no persistMiddleware change).

- [ ] **Step 4: Run tests to verify pass**

```bash
npm run test:vitest -- run test/unit/client/store/panesSlice.fresh-agent-reconcile.test.ts test/unit/client/store/persisted-state.fresh-agent.test.ts
```
Expected: PASS (including the pre-existing fresh-agent persistence suite — no regressions).

- [ ] **Step 5: Commit**

```bash
git add src/store/paneTypes.ts src/store/panesSlice.ts src/store/persistMiddleware.ts test/unit/client/store/panesSlice.fresh-agent-reconcile.test.ts
git commit -m "feat(reconcile): fresh-agent volatile fold fields (epoch/pending/notice) + persistence strips"
```

---

### Task 3: Fresh-agent fold reducers in panesSlice

**Files:**
- Modify: `src/store/panesSlice.ts` (new reducers next to `applyReconcileAttach` :1849 / `resetPaneForReconcileCreate` :1892; widen `findReconcileTerminalContent` :858-863 usage for `setPaneRestoreError` :1997 and `setPaneReconcileNotice` :1950)
- Modify: `src/store/paneTypes.ts` (`DeadSessionEntry` :280-287 gains `kind`)
- Test: `test/unit/client/store/panesSlice.fresh-agent-reconcile.test.ts` (extend)

**Interfaces:**
- Consumes: `FreshAgentPaneContent` fields from Task 2; `SessionLocator`; existing reducer export block (:2079-2090).
- Produces (exact exported action names later tasks dispatch):
  - `applyFreshAgentReconcileAttach({ tabId: string; paneId: string; sessionRef?: SessionLocator; serverInstanceId?: string; corrected?: boolean; duplicate?: boolean })`
  - `resetFreshAgentPaneForReconcileCreate({ tabId: string; paneId: string; intent: 'respawn' | 'fresh'; sessionRef?: SessionLocator; reason?: string; corrected?: boolean })`
  - `setPaneRestoreError` / `setPaneReconcileNotice` / `clearPaneReconcileNotice` now also act on fresh-agent panes.
  - `DeadSessionEntry` gains `kind?: 'terminal' | 'fresh-agent'` (optional; absent = terminal).
  - Internal helper `findReconcilePaneContent(state, tabId, paneId): TerminalPaneContent | FreshAgentPaneContent | undefined`.

Design rules (binding):
- Neither reducer ever mints `createRequestId` (council rule 2 — folds re-fire via `reconcileEpoch`).
- `applyFreshAgentReconcileAttach` maps the verdict's durable ref onto the live handle: fresh-agent attach verdicts carry `sessionRef` and `terminalId: None` (server: `reconcile_freshagent.rs:239-244`), and the server session maps are keyed by the durable id (that is what `has_live_session` probed), so the pane's live handle becomes `sessionRef.sessionId`.
- Respawn provider mismatch degrades loudly to fresh (mirror the terminal guard at panesSlice.ts:1916-1933).

- [ ] **Step 1: Write the failing tests** — extend `test/unit/client/store/panesSlice.fresh-agent-reconcile.test.ts` (build a raw slice state with one fresh-agent leaf, dispatch through the slice reducer like `panesSlice.reconcile.test.ts` does):

```ts
describe('applyFreshAgentReconcileAttach', () => {
  it('sets the live handle from the verdict sessionRef, clears errors, bumps epoch', () => {
    const next = reduce(applyFreshAgentReconcileAttach({
      tabId, paneId,
      sessionRef: { provider: 'claude', sessionId: DURABLE },
      serverInstanceId: 'srv-1', corrected: true,
    }))
    const c = leafContent(next) // helper: find the fresh-agent leaf content
    expect(c.sessionId).toBe(DURABLE)
    expect(c.sessionRef).toEqual({ provider: 'claude', sessionId: DURABLE })
    expect(c.resumeSessionId).toBe(DURABLE)
    expect(c.status).toBe('connected')
    expect(c.restoreError).toBeUndefined()
    expect(c.createError).toBeUndefined()
    expect(c.createRequestId).toBe(ORIGINAL_CREATE_REQUEST_ID) // never re-minted
    expect(c.reconcileEpoch).toBe(1)
    expect(c.reconcileNotice).toBeTruthy() // corrected is user-visible
  })
  it('no-ops when the verdict carries no sessionRef', () => { /* state unchanged */ })
})

describe('resetFreshAgentPaneForReconcileCreate', () => {
  it('respawn adopts the server-named sessionRef and arms pendingReconcile', () => {
    const next = reduce(resetFreshAgentPaneForReconcileCreate({
      tabId, paneId, intent: 'respawn',
      sessionRef: { provider: 'claude', sessionId: DURABLE },
    }))
    const c = leafContent(next)
    expect(c.sessionId).toBeUndefined()
    expect(c.status).toBe('creating')
    expect(c.sessionRef).toEqual({ provider: 'claude', sessionId: DURABLE })
    expect(c.resumeSessionId).toBe(DURABLE)
    expect(c.pendingReconcile).toBe('respawn')
    expect(c.reconcileEpoch).toBe(1)
    expect(c.createRequestId).toBe(ORIGINAL_CREATE_REQUEST_ID)
  })
  it('respawn with provider-mismatched sessionRef degrades loudly to fresh', () => {
    const next = reduce(resetFreshAgentPaneForReconcileCreate({
      tabId, paneId, intent: 'respawn',
      sessionRef: { provider: 'codex', sessionId: DURABLE }, // pane provider is claude
    }))
    const c = leafContent(next)
    expect(c.pendingReconcile).toBe('fresh')
    expect(c.sessionRef).toBeUndefined()
    expect(c.resumeSessionId).toBeUndefined()
  })
  it('fresh wipes durable identity and clears restoreError', () => { /* sessionRef/resumeSessionId undefined, status creating, epoch bumped */ })
})

describe('widened per-pane reducers', () => {
  it('setPaneRestoreError writes restoreError on a fresh-agent pane', () => { /* dispatch, assert c.restoreError.reason */ })
  it('setPaneReconcileNotice / clearPaneReconcileNotice act on a fresh-agent pane', () => { /* set then clear */ })
})
```

Write these as complete runnable tests: `reduce` = `panesReducer(stateWithFreshAgentLeaf, action)`; copy the state-builder helper from `panesSlice.reconcile.test.ts` and change the leaf content to `kind: 'fresh-agent'`.

- [ ] **Step 2: Run to verify failure**

```bash
npm run test:vitest -- run test/unit/client/store/panesSlice.fresh-agent-reconcile.test.ts
```
Expected: FAIL — actions don't exist.

- [ ] **Step 3: Implement** — in `src/store/panesSlice.ts`:

Add the finder next to `findReconcileTerminalContent` (:858):

```ts
/** Fresh-agent + terminal finder for reconcile fold reducers. */
function findReconcilePaneContent(
  state: PanesState, tabId: string, paneId: string,
): TerminalPaneContent | FreshAgentPaneContent | undefined {
  const leaf = findLeaf(state.layouts[tabId], paneId) // reuse the same leaf lookup findReconcileTerminalContent uses
  const content = leaf?.content
  if (content?.kind === 'terminal' || content?.kind === 'fresh-agent') return content
  return undefined
}
```

New reducers (place after `resetPaneForReconcileCreate`):

```ts
applyFreshAgentReconcileAttach(state, action: PayloadAction<{
  tabId: string; paneId: string; sessionRef?: SessionLocator;
  serverInstanceId?: string; corrected?: boolean; duplicate?: boolean
}>) {
  const { tabId, paneId, sessionRef, serverInstanceId, corrected, duplicate } = action.payload
  const content = findReconcilePaneContent(state, tabId, paneId)
  if (!content || content.kind !== 'fresh-agent') return
  if (!sessionRef?.sessionId || sessionRef.provider !== content.provider) return // malformed verdict — no-op
  content.sessionId = sessionRef.sessionId
  content.sessionRef = { provider: sessionRef.provider, sessionId: sessionRef.sessionId }
  content.resumeSessionId = sessionRef.sessionId
  content.status = 'connected'
  content.serverInstanceId = serverInstanceId
  content.restoreError = undefined
  content.createError = undefined
  content.pendingReconcile = undefined
  content.reconcileEpoch = (content.reconcileEpoch ?? 0) + 1
  if (corrected) content.reconcileNotice = RECONCILE_NOTICE_CORRECTED
  else if (duplicate) content.reconcileNotice = RECONCILE_NOTICE_DUPLICATE
},

resetFreshAgentPaneForReconcileCreate(state, action: PayloadAction<{
  tabId: string; paneId: string; intent: 'respawn' | 'fresh';
  sessionRef?: SessionLocator; reason?: string; corrected?: boolean
}>) {
  const { tabId, paneId, sessionRef, reason, corrected } = action.payload
  let { intent } = action.payload
  const content = findReconcilePaneContent(state, tabId, paneId)
  if (!content || content.kind !== 'fresh-agent') return
  if (intent === 'respawn' && (!sessionRef?.sessionId || sessionRef.provider !== content.provider)) {
    log.error('fresh-agent respawn verdict without a usable sessionRef — degrading to fresh', {
      tabId, paneId, reason: sessionRef ? 'respawn_provider_mismatch' : 'respawn_session_ref_missing',
    })
    intent = 'fresh'
  }
  content.sessionId = undefined
  content.serverInstanceId = undefined
  content.status = 'creating'
  content.restoreError = undefined
  content.createError = undefined
  if (intent === 'respawn' && sessionRef) {
    content.sessionRef = { provider: sessionRef.provider, sessionId: sessionRef.sessionId }
    content.resumeSessionId = sessionRef.sessionId
  } else {
    content.sessionRef = undefined
    content.resumeSessionId = undefined
  }
  content.pendingReconcile = intent
  content.reconcileEpoch = (content.reconcileEpoch ?? 0) + 1
  if (corrected) content.reconcileNotice = RECONCILE_NOTICE_CORRECTED
  else if (intent === 'fresh' && reason) content.reconcileNotice = reconcileFreshNotice(reason)
},
```

NOTE: Task 6 later appends a `clearReconcilePendingForPane(state, tabId, paneId)` call to the end of both reducers above (and their terminal siblings) — do not anticipate it here.

Widen `setPaneRestoreError` (:1997) and `setPaneReconcileNotice`/`clearPaneReconcileNotice` (:1950-1967) to use `findReconcilePaneContent` instead of `findReconcileTerminalContent` (both content kinds have `restoreError`; fresh-agent now has `reconcileNotice`). Leave `applyReconcileAttach`/`resetPaneForReconcileCreate` on the terminal-only finder.

`src/store/paneTypes.ts` `DeadSessionEntry`:

```ts
export type DeadSessionEntry = {
  tabId: string; paneId: string; title: string; mode: string;
  /** Absent = terminal (backwards compatible). */
  kind?: 'terminal' | 'fresh-agent';
  sessionRef?: { provider: string; sessionId: string }; reason?: string
}
```

Export the two new actions in the slice export block (:2079-2090).

- [ ] **Step 4: Run tests to verify pass**

```bash
npm run test:vitest -- run test/unit/client/store/panesSlice.fresh-agent-reconcile.test.ts test/unit/client/store/panesSlice.reconcile.test.ts test/unit/client/store/panesSlice.test.ts
```
Expected: PASS, no terminal-suite regressions.

- [ ] **Step 5: Commit**

```bash
git add src/store/panesSlice.ts src/store/paneTypes.ts test/unit/client/store/panesSlice.fresh-agent-reconcile.test.ts
git commit -m "feat(reconcile): fresh-agent fold reducers + kind-aware DeadSessionEntry"
```

---

### Task 4: Request builder + foldVerdicts widening (pane-reconcile.ts)

**Files:**
- Modify: `src/lib/pane-reconcile.ts`
- Test: `test/unit/client/lib/pane-reconcile.fresh-agent.test.ts` (create)

**Interfaces:**
- Consumes: Task 1 schema, Task 3 reducers.
- Produces (exact signatures App/FreshAgentView use):
  - `buildReconcileRequest(state: RootState, opts?: { includeFreshAgent?: boolean }): PaneReconcileRequest | null` — default `includeFreshAgent: false` (existing callers unchanged).
  - `buildReconcileRequestForPanes(state, targets)` — now kind-agnostic: resolves each target's content kind and produces the right pane entry (terminal or fresh-agent).
  - `foldVerdicts(dispatch, request, result): FoldOutcome` — routes each verdict by `request.panes[i].kind`.
  - `setFreshAgentReconcileActive(active: boolean)` / `isFreshAgentReconcileActive(): boolean` — module-level capability latch (mirrors `setPaneReconcileActive` in `src/lib/terminal-restore.ts:36-40`), set by App on every ready, reset to false on capability-less ready.
- Fresh-agent pane entry shape: `{ paneKey, kind: 'fresh-agent', mode: content.provider, createRequestId, sessionRef?, resumeSessionId?, status? }`. `mode` carries the runtime provider (`claude`/`codex`/`opencode`) — informational to the server (verdicts key on `sessionRef`), required non-empty by the wire schema.
- Fold routing for fresh-agent verdicts: `attach` → `applyFreshAgentReconcileAttach` (skip if no `sessionRef`); `respawn`/`fresh` → `resetFreshAgentPaneForReconcileCreate`; `dead_session` → batched `DeadSessionEntry` with `kind: 'fresh-agent'` + `setPaneRestoreError('durable_artifact_missing')`; `invalid` → `setPaneRestoreError('missing_canonical_identity')` + notice; `error` → warming batch on `index_warming`, else `setPaneRestoreError('provider_runtime_failed')` (identical to terminal arms — fresh-agent verdicts never emit `error` today, but the fold must not crash if one arrives).
- `deadSessionTitle` gains a fresh-agent arm: call `derivePaneTitle` with the actual fresh-agent content shape (`{ kind: 'fresh-agent', sessionType, provider, createRequestId, status }`) so panel rows are labeled ("Freshclaude", etc.).

- [ ] **Step 1: Write the failing tests** — create `test/unit/client/lib/pane-reconcile.fresh-agent.test.ts` (copy the store-state builders from `test/unit/client/lib/pane-reconcile.test.ts`; add a fresh-agent leaf builder):

```ts
describe('buildReconcileRequest with fresh-agent panes', () => {
  it('excludes fresh-agent panes by default (frozen behavior)', () => {
    const req = buildReconcileRequest(stateWithBothKinds)
    expect(req!.panes.every((p) => p.kind === 'terminal')).toBe(true)
  })
  it('includes fresh-agent panes when includeFreshAgent is true', () => {
    const req = buildReconcileRequest(stateWithBothKinds, { includeFreshAgent: true })
    const fa = req!.panes.find((p) => p.kind === 'fresh-agent')!
    expect(fa.mode).toBe('claude')
    expect(fa.createRequestId).toBe(FA_CREATE_REQUEST_ID)
    expect(fa.sessionRef).toEqual({ provider: 'claude', sessionId: DURABLE })
  })
  it('skips fresh-agent panes without createRequestId', () => { /* pane omitted */ })
})

describe('buildReconcileRequestForPanes is kind-agnostic', () => {
  it('produces a fresh-agent entry for a fresh-agent target', () => { /* single target, kind === 'fresh-agent' */ })
})

describe('foldVerdicts fresh-agent routing', () => {
  it('attach dispatches applyFreshAgentReconcileAttach with the verdict sessionRef', () => { /* spy dispatch, assert action type + payload */ })
  it('respawn dispatches resetFreshAgentPaneForReconcileCreate intent respawn with server-named ref', () => {})
  it('fresh dispatches resetFreshAgentPaneForReconcileCreate intent fresh with reason', () => {})
  it('dead_session joins ONE batched adjudication with kind fresh-agent and sets per-pane restoreError', () => {
    const outcome = foldVerdicts(dispatch, reqWithTwoDeadFreshAgents, resultBothDead)
    const batched = dispatched.filter((a) => a.type === 'panes/setDeadSessionAdjudication')
    expect(batched).toHaveLength(1)
    expect(batched[0].payload.every((e: DeadSessionEntry) => e.kind === 'fresh-agent')).toBe(true)
    expect(outcome.dead).toBe(2)
  })
  it('mixed terminal + fresh-agent request routes each verdict to its kind reducers', () => {})
  it('cardinality violation still folds nothing', () => {})
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npm run test:vitest -- run test/unit/client/lib/pane-reconcile.fresh-agent.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement** — in `src/lib/pane-reconcile.ts`:

```ts
// Capability latch (mirrors terminal-restore.ts setPaneReconcileActive)
let freshAgentReconcileActive = false
export function setFreshAgentReconcileActive(active: boolean): void { freshAgentReconcileActive = active }
export function isFreshAgentReconcileActive(): boolean { return freshAgentReconcileActive }

function toFreshAgentReconcilePane(
  tabId: string, paneId: string, content: FreshAgentPaneContent,
): ReconcilePane | null {
  if (!content.createRequestId) return null
  return {
    paneKey: paneKeyFor(tabId, paneId),
    kind: 'fresh-agent',
    mode: content.provider,
    createRequestId: content.createRequestId,
    ...(content.sessionRef ? { sessionRef: content.sessionRef } : {}),
    ...(content.resumeSessionId ? { resumeSessionId: content.resumeSessionId } : {}),
    ...(content.status ? { status: content.status } : {}),
  }
}
```

- Add `forEachFreshAgentPane(layouts, visit)` next to `forEachTerminalPane` (:41) — same walk, `content?.kind === 'fresh-agent'`.
- `buildReconcileRequest(state, opts?)`: walk terminals as today; when `opts?.includeFreshAgent`, additionally walk fresh-agent panes and append their entries (after the terminal entries — order within the request is arbitrary but must be echoed 1:1).
- `buildReconcileRequestForPanes(state, targets)`: for each target, resolve the leaf content; produce `toReconcilePane` for terminal, `toFreshAgentReconcilePane` for fresh-agent; skip others.
- `foldVerdicts`: inside the per-verdict loop, branch first on `pane.kind`:

```ts
const pane = request.panes[i]
if (pane.kind === 'fresh-agent') {
  foldFreshAgentVerdict(dispatch, pane, verdict, result, deadEntries, warmingRefs, outcome)
  continue
}
// ...existing terminal arms unchanged
```

`foldFreshAgentVerdict` implements the routing table from the Interfaces block; the dead arm pushes `{ ...paneRefFromOwnKey(pane.paneKey), title: deadSessionTitle(pane), mode: pane.mode, kind: 'fresh-agent', sessionRef: verdict.sessionRef, reason: verdict.reason }`. Batching stays where it is (ONE `setDeadSessionAdjudication`, ONE `setReconcileWarming` at the tail — do not duplicate the tail).
- `deadSessionTitle(pane)`: branch on `pane.kind` — fresh-agent calls `derivePaneTitle({ kind: 'fresh-agent', sessionType: freshAgentSessionTypeForProvider(pane.mode), provider: pane.mode, createRequestId: pane.createRequestId, status: 'idle' } as never)`; if `derivePaneTitle`'s fresh-agent arm needs the true sessionType (not derivable from provider), simplify: title = capitalized provider (e.g. `'Claude session'`) — a stable human label, no type gymnastics. Choose whichever compiles cleanly; the test asserts only that the title is non-empty.

- [ ] **Step 4: Run tests to verify pass**

```bash
npm run test:vitest -- run test/unit/client/lib/pane-reconcile.fresh-agent.test.ts test/unit/client/lib/pane-reconcile.test.ts
```
Expected: PASS (terminal fold suite untouched).

- [ ] **Step 5: Commit**

```bash
git add src/lib/pane-reconcile.ts test/unit/client/lib/pane-reconcile.fresh-agent.test.ts
git commit -m "feat(reconcile): fresh-agent request producer + verdict fold routing"
```

---

### Task 5: DeadSessionPanel fresh-agent support

**Files:**
- Modify: `src/components/DeadSessionPanel.tsx` (`handleStartFresh` :27-32)
- Test: `test/unit/client/components/DeadSessionPanel.test.tsx` (extend)

**Interfaces:**
- Consumes: `DeadSessionEntry.kind` (Task 3), `resetFreshAgentPaneForReconcileCreate` (Task 3).
- Produces: "Start fresh here" dispatches the kind-correct reducer; fresh-agent rows no longer silently no-op.

- [ ] **Step 1: Write the failing test** — extend `DeadSessionPanel.test.tsx`:

```ts
it('Start fresh here on a fresh-agent entry dispatches the fresh-agent reset (createRequestId preserved)', () => {
  // seed deadSessionAdjudication with one entry: { kind: 'fresh-agent', tabId, paneId, title: 'Freshclaude', mode: 'claude' }
  // and a matching fresh-agent leaf in panes.layouts
  render(<DeadSessionPanel />, { wrapper })
  fireEvent.click(screen.getByRole('button', { name: /start fresh here/i }))
  const content = leafContent(store.getState())
  expect(content.kind).toBe('fresh-agent')
  expect(content.status).toBe('creating')
  expect(content.sessionRef).toBeUndefined()
  expect(content.createRequestId).toBe(ORIGINAL_CREATE_REQUEST_ID)
  expect(store.getState().panes.deadSessionAdjudication).toHaveLength(0)
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npm run test:vitest -- run test/unit/client/components/DeadSessionPanel.test.tsx
```
Expected: FAIL — the terminal-only reducer no-ops, `status` stays unchanged.

- [ ] **Step 3: Implement** — in `DeadSessionPanel.tsx`:

```ts
const handleStartFresh = (entry: DeadSessionEntry) => {
  if (entry.kind === 'fresh-agent') {
    dispatch(resetFreshAgentPaneForReconcileCreate({ tabId: entry.tabId, paneId: entry.paneId, intent: 'fresh' }))
  } else {
    dispatch(resetPaneForReconcileCreate({ tabId: entry.tabId, paneId: entry.paneId, intent: 'fresh' }))
  }
  dispatch(resolveDeadSessionEntry({ tabId: entry.tabId, paneId: entry.paneId }))
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
npm run test:vitest -- run test/unit/client/components/DeadSessionPanel.test.tsx
```
Expected: PASS (existing terminal cases green).

- [ ] **Step 5: Commit**

```bash
git add src/components/DeadSessionPanel.tsx test/unit/client/components/DeadSessionPanel.test.tsx
git commit -m "feat(reconcile): DeadSessionPanel start-fresh handles fresh-agent entries"
```

---

### Task 6: reconcilePendingPanes slice machinery (the pre-verdict wait's state)

**Files:**
- Modify: `src/store/paneTypes.ts` (`PanesState`, next to `deadSessionAdjudication` :344-353)
- Modify: `src/store/panesSlice.ts` (new reducers; clear-on-fold in all four fold reducers; initial state; hydration reset)
- Modify: `src/store/persistMiddleware.ts` (slice-level strip, :596-604)
- Test: `test/unit/client/store/panesSlice.fresh-agent-reconcile.test.ts` (extend)

**Interfaces:**
- Consumes: `paneKeyFor` key format (`${tabId}:${paneId}`).
- Produces (exact names Tasks 7/8/9 use):
  - `PanesState.reconcilePendingPanes?: Record<string /* paneKey */, number /* startedAt ms */>` — ephemeral, never persisted, `{}` initial.
  - Actions: `setReconcilePendingPanes(payload: { paneKeys: string[]; startedAt: number })` (replaces the map), `clearReconcilePendingPane(payload: { paneKey: string })`, `clearAllReconcilePendingPanes()`.
  - Every fold-target reducer clears its own pane's pending flag: `applyReconcileAttach`, `resetPaneForReconcileCreate`, `applyFreshAgentReconcileAttach`, `resetFreshAgentPaneForReconcileCreate`, and `setPaneRestoreError` (dead/invalid/error verdicts resolve the wait too).

- [ ] **Step 1: Write the failing tests**

```ts
describe('reconcilePendingPanes', () => {
  it('set replaces the map; clearPane removes one; clearAll empties', () => { /* three dispatches, assert map */ })
  it('every fold reducer clears its pane pending flag', () => {
    // seed pending for a terminal paneKey and a fresh-agent paneKey,
    // dispatch applyReconcileAttach for the terminal and applyFreshAgentReconcileAttach for the fresh-agent,
    // assert both keys are gone
  })
  it('setPaneRestoreError clears the pane pending flag', () => {})
  it('is not persisted', () => { /* extend the Task 2 persistence test: slice-level field absent */ })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npm run test:vitest -- run test/unit/client/store/panesSlice.fresh-agent-reconcile.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

`paneTypes.ts`:

```ts
  /** Ephemeral: paneKey -> wall-clock ms when a reconcile request naming this pane went out.
   *  While present (and young), the pane's mount drive defers its create until the verdict folds. */
  reconcilePendingPanes?: Record<string, number>
```

`panesSlice.ts` — initial state `reconcilePendingPanes: {}` (both initializers, :301/:320 area, and the hydration reset near :1670); reducers:

```ts
setReconcilePendingPanes(state, action: PayloadAction<{ paneKeys: string[]; startedAt: number }>) {
  const map: Record<string, number> = {}
  for (const key of action.payload.paneKeys) map[key] = action.payload.startedAt
  state.reconcilePendingPanes = map
},
clearReconcilePendingPane(state, action: PayloadAction<{ paneKey: string }>) {
  if (state.reconcilePendingPanes) delete state.reconcilePendingPanes[action.payload.paneKey]
},
clearAllReconcilePendingPanes(state) {
  state.reconcilePendingPanes = {}
},
```

Shared helper used inside fold reducers:

```ts
function clearReconcilePendingForPane(state: PanesState, tabId: string, paneId: string): void {
  if (state.reconcilePendingPanes) delete state.reconcilePendingPanes[`${tabId}:${paneId}`]
}
```

Call it at the end of `applyReconcileAttach`, `resetPaneForReconcileCreate`, `applyFreshAgentReconcileAttach`, `resetFreshAgentPaneForReconcileCreate`, `setPaneRestoreError`. Export the three new actions.

`persistMiddleware.ts` slice-level strip (:596-604): add `reconcilePendingPanes` alongside `deadSessionAdjudication`/`reconcileWarming`.

- [ ] **Step 4: Run tests to verify pass**

```bash
npm run test:vitest -- run test/unit/client/store/panesSlice.fresh-agent-reconcile.test.ts test/unit/client/store/panesSlice.reconcile.test.ts test/unit/client/store/panesPersistence.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/paneTypes.ts src/store/panesSlice.ts src/store/persistMiddleware.ts test/unit/client/store/panesSlice.fresh-agent-reconcile.test.ts
git commit -m "feat(reconcile): reconcilePendingPanes ephemeral wait-state + clear-on-fold"
```

---

### Task 7: App wiring — capability capture, fresh-agent request, pending set/clear

**Files:**
- Modify: `src/App.tsx` (ready handler :1017-1032, fold handler :1045-1081, error fallback :1083-1095)
- Test: `test/unit/client/components/App.reconcile-adoption.test.tsx` (extend)

**Interfaces:**
- Consumes: `buildReconcileRequest(state, { includeFreshAgent })`, `setFreshAgentReconcileActive`, `setReconcilePendingPanes`/`clearAllReconcilePendingPanes` (Tasks 4/6).
- Produces: on every ready, App (a) latches both capabilities, (b) sends ONE request covering terminal panes plus (iff `paneReconcileFreshAgentV1`) fresh-agent panes, (c) marks exactly the requested paneKeys pending, (d) clears ALL pending on fold completion, on a correlated error frame, on cardinality violation, and on a capability-less ready. Fold-ownership rule unchanged (App folds only its own `reconcileId`).

- [ ] **Step 1: Write the failing tests** — extend `App.reconcile-adoption.test.tsx` (reuse its ready-frame + fake-ws harness):

```ts
it('ready with both capabilities sends one request including fresh-agent panes and marks them pending', async () => {
  seedStoreWithTerminalAndFreshAgentLeaves()
  receiveReady({ capabilities: { paneReconcileV1: true, paneReconcileFreshAgentV1: true } })
  const req = lastSent('pane.reconcile.request')
  expect(req.panes.some((p) => p.kind === 'fresh-agent')).toBe(true)
  const pending = store.getState().panes.reconcilePendingPanes!
  for (const p of req.panes) expect(pending[p.paneKey]).toBeGreaterThan(0)
})

it('ready with only paneReconcileV1 sends a terminal-only request', async () => {
  receiveReady({ capabilities: { paneReconcileV1: true } })
  const req = lastSent('pane.reconcile.request')
  expect(req.panes.every((p) => p.kind === 'terminal')).toBe(true)
})

it('folding the result clears all pending panes', async () => { /* receive matching result, assert map empty */ })
it('a correlated error frame clears all pending panes', async () => { /* error{reconcileId} -> map empty */ })
it('capability-less ready clears pending and deactivates the fresh-agent latch', async () => { /* isFreshAgentReconcileActive() === false */ })
```

- [ ] **Step 2: Run to verify failure**

```bash
npm run test:vitest -- run test/unit/client/components/App.reconcile-adoption.test.tsx
```
Expected: new tests FAIL.

- [ ] **Step 3: Implement** — in `src/App.tsx` ready handler (:1017-1032 becomes):

```ts
const paneReconcile = ready.data.capabilities?.paneReconcileV1 === true
const freshAgentReconcile = ready.data.capabilities?.paneReconcileFreshAgentV1 === true
paneReconcileActiveRef.current = paneReconcile
setPaneReconcileActive(paneReconcile)
setFreshAgentReconcileActive(freshAgentReconcile)
pendingReconcileRef.current = null
dispatch(clearAllReconcilePendingPanes())
if (paneReconcile) {
  const req = buildReconcileRequest(appStore.getState(), { includeFreshAgent: freshAgentReconcile })
  if (req) {
    pendingReconcileRef.current = req
    dispatch(setReconcilePendingPanes({ paneKeys: req.panes.map((p) => p.paneKey), startedAt: Date.now() }))
    ws.send(req)
  }
}
```

In the fold handler (:1045-1081) after `foldVerdicts` returns: `dispatch(clearAllReconcilePendingPanes())` (fold reducers already cleared per-pane; this catches cardinality-violation outcomes where nothing folded). In the error-frame fallback (:1083-1095): same dispatch before falling back to the census.

- [ ] **Step 4: Run tests to verify pass**

```bash
npm run test:vitest -- run test/unit/client/components/App.reconcile-adoption.test.tsx
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx test/unit/client/components/App.reconcile-adoption.test.tsx
git commit -m "feat(reconcile): App sends fresh-agent panes in boot reconcile + pending-pane lifecycle"
```

---

### Task 8: TerminalView pre-verdict create wait (reload-path race, terminal leg)

**Files:**
- Modify: `src/components/TerminalView.tsx` (constants ~:162-170; create-or-attach effect :2753-4725, `ensure()` else-branch :4661-4669, dep array :4706-4725)
- Test: `test/unit/client/components/TerminalView.verdict-wait.test.tsx` (create; model on `TerminalView.session-reserved.test.tsx`)

**Interfaces:**
- Consumes: `s.panes.reconcilePendingPanes` (Task 6), `paneKeyFor`, `clearReconcilePendingPane`.
- Produces: exported constant `RECONCILE_VERDICT_WAIT_MS = 4_000` (> the server's single 2s warming deferral + round-trip margin); the mount-time create is deferred while the pane is reconcile-pending, bounded by that constant, then falls back to the legacy eager create. The attach branch (`currentTerminalId` set) is NEVER gated.

Behavior spec:
1. Pane pending + verdict folds within the window → the fold's `reconcileEpoch` bump / `terminalId` write drives the pane; NO eager `terminal.create` is ever sent for the pre-verdict window.
2. Pane pending + no verdict within `RECONCILE_VERDICT_WAIT_MS` → dispatch `clearReconcilePendingPane` → effect re-fires → legacy `sendCreate(createRequestId)` proceeds (pane never hangs).
3. Capability off / pane not in the request → map has no entry → behavior byte-identical to today.

- [ ] **Step 1: Write the failing tests** — `test/unit/client/components/TerminalView.verdict-wait.test.tsx` (reuse the render harness + fake ws from `TerminalView.session-reserved.test.tsx`, plus vitest fake timers):

```ts
it('defers the mount create while the pane is reconcile-pending', async () => {
  seedPendingForPane(tabId, paneId) // dispatch setReconcilePendingPanes({ paneKeys: [`${tabId}:${paneId}`], startedAt: Date.now() })
  renderTerminalPane({ terminalId: undefined, status: 'creating' })
  await flush()
  expect(sentOfType('terminal.create')).toHaveLength(0)
})

it('an attach verdict fold drives attach without any create', async () => {
  seedPendingForPane(tabId, paneId)
  renderTerminalPane({ terminalId: undefined, status: 'creating' })
  store.dispatch(applyReconcileAttach({ tabId, paneId, terminalId: 'term-9' }))
  await flush()
  expect(sentOfType('terminal.create')).toHaveLength(0)
  expect(sentOfType('terminal.attach').some((m) => m.terminalId === 'term-9')).toBe(true)
})

it('falls back to the legacy create after RECONCILE_VERDICT_WAIT_MS', async () => {
  vi.useFakeTimers()
  seedPendingForPane(tabId, paneId)
  renderTerminalPane({ terminalId: undefined, status: 'creating' })
  await flush()
  expect(sentOfType('terminal.create')).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(RECONCILE_VERDICT_WAIT_MS + 50)
  expect(sentOfType('terminal.create')).toHaveLength(1) // same createRequestId, never re-minted
})

it('a pane with a live terminalId attaches immediately even while pending', async () => {
  seedPendingForPane(tabId, paneId)
  renderTerminalPane({ terminalId: 'term-1', status: 'running' })
  await flush()
  expect(sentOfType('terminal.attach')).toHaveLength(1)
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npm run test:vitest -- run test/unit/client/components/TerminalView.verdict-wait.test.tsx
```
Expected: FAIL — the eager create fires immediately in tests 1-3.

- [ ] **Step 3: Implement** — in `TerminalView.tsx`:

Constant (next to `RESERVE_RETRY_WINDOW_MS`, :167):

```ts
/** Reload-path pre-verdict wait: a hydrated pane defers its mount create until its
 *  reconcile verdict folds, bounded by this wall-clock budget (> server's single 2s
 *  index-warming deferral + RTT margin). On timeout the legacy eager drive proceeds. */
export const RECONCILE_VERDICT_WAIT_MS = 4_000
```

Selector + ref near the other pane selectors:

```ts
const reconcilePendingSince = useAppSelector(
  (s) => s.panes.reconcilePendingPanes?.[`${tabId}:${paneId}`],
)
const verdictWaitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
```

In `ensure()`'s else-branch (the no-`terminalId` arm, :4661-4669), before `sendCreate`:

```ts
} else {
  if (reconcilePendingSinceRef.current !== undefined) {
    const elapsed = Date.now() - reconcilePendingSinceRef.current
    if (elapsed < RECONCILE_VERDICT_WAIT_MS) {
      if (verdictWaitTimerRef.current === null) {
        const paneKey = `${tabId}:${paneIdRef.current}`
        verdictWaitTimerRef.current = setTimeout(() => {
          verdictWaitTimerRef.current = null
          // Timeout: verdict never folded — release the gate; the effect re-fires
          // (reconcilePendingSince is a dep) and the legacy drive proceeds.
          dispatch(clearReconcilePendingPane({ paneKey }))
        }, RECONCILE_VERDICT_WAIT_MS - elapsed)
      }
      return
    }
  }
  deferredAttachStateRef.current = { mode: 'none', pendingIntent: null, pendingSinceSeq: 0, pendingReason: 'initial_hydrate' }
  sendCreate(createRequestId)
}
```

Mechanics: keep a `reconcilePendingSinceRef` mirroring the selector (assign during render like the existing `contentRef` pattern) so `ensure()` reads current state; add `reconcilePendingSince` to the effect dep array (:4706-4725) so the fold's `clearReconcilePendingPane` (or the timeout's) re-fires the effect; clear `verdictWaitTimerRef` in the effect cleanup (:4674-4679 pattern) so unmounts and re-runs never leak a timer.

- [ ] **Step 4: Run tests to verify pass**

```bash
npm run test:vitest -- run test/unit/client/components/TerminalView.verdict-wait.test.tsx test/unit/client/components/TerminalView.session-reserved.test.tsx
```
Expected: PASS (SESSION_RESERVED suite untouched).

- [ ] **Step 5: Commit**

```bash
git add src/components/TerminalView.tsx test/unit/client/components/TerminalView.verdict-wait.test.tsx
git commit -m "fix(reconcile): terminal mount create waits (bounded) for the pane verdict on reload"
```

---

### Task 9: FreshAgentView fold-driven drive (epoch re-fire, pendingReconcile, pre-verdict wait, notice)

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentView.tsx` (create effect :1099-1154; `createSentRef` reset :860-864; created-ack handler :1271-1291; restore-error banner area :2043-2046)
- Test: `test/unit/client/components/FreshAgentView.reconcile.test.tsx` (create; reuse the harness from `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx` — place the new file next to it: `test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx`)

**Interfaces:**
- Consumes: Task 2 fields, Task 3 reducers, Task 6 pending map, `RECONCILE_VERDICT_WAIT_MS` (import from TerminalView or duplicate the constant locally — import to keep one value).
- Produces:
  1. A fold on a mounted fresh-agent pane re-fires the create effect via `reconcileEpoch` (same `createRequestId`).
  2. `freshAgent.created` consumes `pendingReconcile` (sets it `undefined`) — stale intent never survives a completed create.
  3. The create effect defers while the pane is reconcile-pending, bounded like Task 8.
  4. `reconcileNotice` renders once (a `role="status"` line above the transcript) and is cleared after render.
  5. An attach fold (Task 3 sets `sessionId`) drives the EXISTING attach effect (:1196-1228) with no create.

- [ ] **Step 1: Write the failing tests** — `test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx`:

```ts
it('a respawn fold on a mounted pane re-sends freshAgent.create with the server-named ref and the SAME createRequestId', async () => {
  renderFreshAgentPane({ sessionId: 'live-1', status: 'connected', createRequestId: 'req-1' })
  await flush() // initial mount consumed createSentRef
  store.dispatch(resetFreshAgentPaneForReconcileCreate({
    tabId, paneId, intent: 'respawn', sessionRef: { provider: 'claude', sessionId: DURABLE },
  }))
  await flush()
  const creates = sentOfType('freshAgent.create')
  const last = creates[creates.length - 1]
  expect(last.requestId).toBe('req-1')
  expect(last.resumeSessionId).toBe(DURABLE)
  expect(last.sessionRef).toEqual({ provider: 'claude', sessionId: DURABLE })
})

it('an attach fold sends freshAgent.attach and no create', async () => {
  renderFreshAgentPane({ sessionId: undefined, status: 'creating', sessionRef: { provider: 'claude', sessionId: DURABLE } })
  seedPendingForPane(tabId, paneId) // gate the mount create so the fold decides
  store.dispatch(applyFreshAgentReconcileAttach({ tabId, paneId, sessionRef: { provider: 'claude', sessionId: DURABLE } }))
  await flush()
  expect(sentOfType('freshAgent.create')).toHaveLength(0)
  expect(sentOfType('freshAgent.attach').some((m) => m.sessionId === DURABLE)).toBe(true)
})

it('the mount create defers while reconcile-pending and falls back after the bound', async () => {
  vi.useFakeTimers()
  seedPendingForPane(tabId, paneId)
  renderFreshAgentPane({ sessionId: undefined, status: 'creating', sessionRef: { provider: 'claude', sessionId: DURABLE } })
  await flush()
  expect(sentOfType('freshAgent.create')).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(RECONCILE_VERDICT_WAIT_MS + 50)
  expect(sentOfType('freshAgent.create')).toHaveLength(1)
})

it('freshAgent.created clears pendingReconcile', async () => {
  renderFreshAgentPane({ status: 'creating', pendingReconcile: 'respawn', createRequestId: 'req-1' })
  await flush()
  receiveWs({ type: 'freshAgent.created', requestId: 'req-1', sessionId: 's-1', sessionType: 'freshclaude', provider: 'claude', runtimeProvider: 'claude' })
  await flush()
  expect(leafContent(store.getState()).pendingReconcile).toBeUndefined()
})

it('reconcileNotice renders once as role=status and is cleared', async () => {
  renderFreshAgentPane({ sessionId: 'live-1', status: 'connected', reconcileNotice: 'Reconciled: attached to the corrected session.' })
  expect(await screen.findByRole('status')).toHaveTextContent(/corrected/i)
  await flush()
  expect(leafContent(store.getState()).reconcileNotice).toBeUndefined()
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx
```
Expected: FAIL on all five.

- [ ] **Step 3: Implement** — in `FreshAgentView.tsx`:

1. **Epoch re-fire:** the render-phase reset at :860-864 currently re-arms on `createRequestId` change; widen its key:

```ts
const createArmKey = `${paneContent.createRequestId}:${paneContent.reconcileEpoch ?? 0}`
if (lastCreateArmKeyRef.current !== createArmKey) {
  lastCreateArmKeyRef.current = createArmKey
  createSentRef.current = false
}
```

2. **Create-effect guards** (:1099-1105): the `restoreError` guard already blocks dead panes. Add the pending gate before `createSentRef` is consumed:

```ts
const pendingSince = reconcilePendingSinceRef.current
if (pendingSince !== undefined && Date.now() - pendingSince < RECONCILE_VERDICT_WAIT_MS) {
  if (verdictWaitTimerRef.current === null) {
    const paneKey = `${tabId}:${paneId}`
    verdictWaitTimerRef.current = setTimeout(() => {
      verdictWaitTimerRef.current = null
      dispatch(clearReconcilePendingPane({ paneKey }))
    }, RECONCILE_VERDICT_WAIT_MS - (Date.now() - pendingSince))
  }
  return
}
```

with `reconcilePendingSince` selected via `useAppSelector((s) => s.panes.reconcilePendingPanes?.[`${tabId}:${paneId}`])`, mirrored into a ref, added to the create effect's dep array, and the timer cleared on unmount (add to the existing unmount cleanup at :778-786).

3. **`buildCreateMessage`** (:918-939) needs no change: respawn folds already wrote `sessionRef` + `resumeSessionId`; fresh folds cleared them.

4. **Created-ack** (:1271-1291): add `pendingReconcile: undefined` to the content patch.

5. **Notice:** in the banner region (:2043-2046):

```tsx
{paneContent.reconcileNotice ? (
  <div role="status" className="px-3 py-1 text-xs text-amber-600 dark:text-amber-400">
    {paneContent.reconcileNotice}
  </div>
) : null}
```

and clear it after first render:

```ts
useEffect(() => {
  if (!paneContent.reconcileNotice) return
  const t = setTimeout(() => {
    dispatch(updatePaneContent({ tabId, paneId, content: { ...paneContentRef.current, reconcileNotice: undefined } }))
  }, 5_000)
  return () => clearTimeout(t)
}, [dispatch, paneContent.reconcileNotice, paneId, tabId])
```

(5s visible then cleared — a chat pane has no xterm write-notice channel; a timed dismiss keeps it one-shot without hiding it instantly.)

- [ ] **Step 4: Run tests to verify pass**

```bash
npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx "test/unit/client/components/fresh-agent/FreshAgentView.test.tsx" test/unit/client/components/fresh-agent/FreshAgentView.hidden-rebind.test.tsx
```
Expected: PASS — including the two big pre-existing suites (regression gate; the hidden-rebind pacing contract must survive the new gate: a HIDDEN pane in `creating` still queues its create — the pending gate returns BEFORE the rebind-queue enqueue only while young).

- [ ] **Step 5: Commit**

```bash
git add src/components/fresh-agent/FreshAgentView.tsx test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx
git commit -m "feat(reconcile): FreshAgentView folds drive create/attach (epoch re-fire, bounded pre-verdict wait, notice)"
```

---

### Task 10: Capability-gated `.lost` handling — verdicts replace triggerRecovery

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentView.tsx` (`.lost` driver effect :1664-1693; ws.onMessage listener :1268-1407)
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx` (extend)

**Interfaces:**
- Consumes: `isFreshAgentReconcileActive()` (Task 4), `buildReconcileRequestForPanes` (Task 4, now kind-agnostic), `foldVerdicts`.
- Produces: when the fresh-agent capability is active, a `.lost` session triggers a SINGLE-PANE reconcile request owned by this FreshAgentView (fold-ownership rule: it folds only its own `reconcileId`); the verdict answers attach/respawn/dead. When the capability is inactive (legacy TS server, downgraded server), the existing `triggerRecovery` heuristics run unchanged — this is the capability-gated fallback, NOT deleted.

- [ ] **Step 1: Write the failing tests**

```ts
it('.lost with fresh-agent reconcile active sends a single-pane reconcile instead of heuristic recovery', async () => {
  setFreshAgentReconcileActive(true)
  renderFreshAgentPane({ sessionId: 'live-1', status: 'running', sessionRef: { provider: 'claude', sessionId: DURABLE } })
  markSessionLostInStore() // dispatch freshAgentSlice markSessionLost for this session
  await flush()
  const reqs = sentOfType('pane.reconcile.request')
  expect(reqs).toHaveLength(1)
  expect(reqs[0].panes).toHaveLength(1)
  expect(reqs[0].panes[0].kind).toBe('fresh-agent')
  // createRequestId unchanged — no heuristic re-mint happened
  expect(leafContent(store.getState()).createRequestId).toBe(ORIGINAL_CREATE_REQUEST_ID)
})

it('.lost with the capability inactive falls back to legacy triggerRecovery (new createRequestId)', async () => {
  setFreshAgentReconcileActive(false)
  renderFreshAgentPane({ sessionId: 'live-1', status: 'running', sessionRef: { provider: 'claude', sessionId: DURABLE } })
  markSessionLostInStore()
  await flush()
  expect(sentOfType('pane.reconcile.request')).toHaveLength(0)
  expect(leafContent(store.getState()).createRequestId).not.toBe(ORIGINAL_CREATE_REQUEST_ID)
  expect(leafContent(store.getState()).status).toBe('creating')
})

it('folds only its own reconcileId and applies the verdict (respawn re-drives create)', async () => {
  setFreshAgentReconcileActive(true)
  renderFreshAgentPane({ sessionId: 'live-1', status: 'running', sessionRef: { provider: 'claude', sessionId: DURABLE } })
  markSessionLostInStore(); await flush()
  const req = sentOfType('pane.reconcile.request')[0]
  receiveWs({ type: 'pane.reconcile.result', reconcileId: 'FOREIGN', bootId: 'b', serverInstanceId: 's', verdicts: [] }) // ignored
  receiveWs({ type: 'pane.reconcile.result', reconcileId: req.reconcileId, bootId: 'b', serverInstanceId: 's',
    verdicts: [{ paneKey: req.panes[0].paneKey, verdict: 'respawn', sessionRef: { provider: 'claude', sessionId: DURABLE } }] })
  await flush()
  const creates = sentOfType('freshAgent.create')
  expect(creates[creates.length - 1].resumeSessionId).toBe(DURABLE)
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx
```
Expected: new tests FAIL (legacy path runs in all cases).

- [ ] **Step 3: Implement** — in `FreshAgentView.tsx`:

Add a ref + sender:

```ts
const lostReconcileRef = useRef<PaneReconcileRequest | null>(null)

const reconcileLostPane = useCallback(() => {
  const request = buildReconcileRequestForPanes(appStore.getState(), [{ tabId, paneId }])
  if (!request) { triggerRecovery(); return } // pane not requestable (no createRequestId) — legacy path
  lostReconcileRef.current = request
  ws.send(request) // plain ClientMessage — same pattern as TerminalView's exhaustion reconcile (:3133)
}, [paneId, tabId, triggerRecovery, ws])
```

In the `.lost` driver (:1664-1693), replace both `triggerRecovery()` call sites with:

```ts
if (isFreshAgentReconcileActive()) reconcileLostPane()
else triggerRecovery()
```

(keep the deferral logic and guards exactly as they are — only the action swaps).

In the ws.onMessage listener (:1268-1407) add an arm:

```ts
if (message.type === 'pane.reconcile.result') {
  const req = lostReconcileRef.current
  if (req && message.reconcileId === req.reconcileId) {
    lostReconcileRef.current = null
    foldVerdicts(dispatch, req, message)
  }
  return
}
```

Also clear the session's `lost` flag when the fold lands a working outcome: the attach fold sets `sessionId` (attach effect re-registers), and respawn's `freshAgent.created` produces a fresh session entry — verify with the Step 1 tests; if the `freshAgentSlice` `lost` flag lingers and re-triggers the driver, dispatch the slice's existing `removeSession`/lost-clearing action inside the fold arm for this pane's old sessionKey (find the exact action name in `src/store/freshAgentSlice.ts`; `markSessionLost`'s counterpart). The third Step 1 test catches an infinite re-trigger (it asserts exactly ONE reconcile request).

- [ ] **Step 4: Run tests to verify pass**

```bash
npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx "test/unit/client/components/fresh-agent/FreshAgentView.test.tsx"
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/fresh-agent/FreshAgentView.tsx test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx
git commit -m "feat(reconcile): verdicts replace fresh-agent .lost heuristics (capability-gated fallback retained)"
```

---

### Task 11: Rust — `FreshAgentSessionLeases` primitive (D8 for fresh agents)

**Files:**
- Create: `crates/freshell-freshagent/src/session_lease.rs`
- Modify: `crates/freshell-freshagent/src/lib.rs` (add `pub mod session_lease;`)
- Test: `mod tests` inside `session_lease.rs`

**Interfaces:**
- Consumes: nothing outside std (Mutex/HashMap; time passed in by callers for testability).
- Produces (exact API Task 12/13 use):

```rust
pub const FRESH_AGENT_SESSION_LEASE_TTL_MS: u64 = 20_000; // env FRESHELL_FRESH_AGENT_LEASE_TTL_MS overrides
pub const FRESH_AGENT_SESSION_RESERVED_RETRY_AFTER_MS: u64 = 1_000;
pub fn fresh_agent_session_lease_ttl_ms() -> u64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FreshSessionClaim {
    Acquired,
    Held { retry_after_ms: u64 },
    ExpiredNeedsKill { pid: u32 },
}

#[derive(Default)]
pub struct FreshAgentSessionLeases { /* Mutex<HashMap<String, LeaseEntry>> */ }

impl FreshAgentSessionLeases {
    pub fn new() -> Self;
    /// Key = "{provider}\u{0}{durable_session_id}". Liveness (BoundLive) is the CALLER's
    /// pre-check via has_live_session — this map serializes only in-flight resumes.
    pub fn claim(&self, provider: &str, session_id: &str, holder_request_id: &str, now_ms: u64) -> FreshSessionClaim;
    /// Arms the TTL kill path once the sidecar child pid is known. No-op if the lease
    /// is gone or held by another request id.
    pub fn set_pid(&self, provider: &str, session_id: &str, holder_request_id: &str, pid: u32);
    /// Winner registered its session: release. Returns false if the lease was revoked
    /// or foreign — the caller must tear down its own child and fail loudly.
    pub fn complete(&self, provider: &str, session_id: &str, holder_request_id: &str) -> bool;
    /// Spawn/resume failed: release (safe for revoked leases — no orphan can exist).
    pub fn fail(&self, provider: &str, session_id: &str, holder_request_id: &str);
    /// Only legal after the holder's pid death was confirmed (ESRCH).
    pub fn force_release_after_confirmed_kill(&self, provider: &str, session_id: &str);
}
```

Semantics (verbatim mirror of `TerminalRegistry`'s lease, registry.rs:1805-1885):
- `claim` with no entry → insert `{holder_request_id, acquired_at_ms: now_ms, pid: None, revoked: false}` → `Acquired`.
- Entry held, unexpired (`now_ms <= acquired_at_ms + ttl`) → `Held { FRESH_AGENT_SESSION_RESERVED_RETRY_AFTER_MS }`. Re-claim by the SAME holder_request_id (re-drive of the same create) → also `Held` (the original task is still running; idempotent re-sends are answered by the per-requestId dedup, not the lease).
- Entry expired with `pid: Some(p)` → `ExpiredNeedsKill { pid: p }` (lease stays held until confirmed kill + `force_release_after_confirmed_kill`).
- Entry expired, pid-less → set `revoked = true`, log `tracing::error!(target: "invariant", ..., "fresh_agent_session_lease_revoked: holding closed")`, return `Held` — hold closed, never release what you can't kill.
- `complete` on a revoked or foreign lease → `false` and the entry is NOT removed (revoked stays closed; foreign untouched).

- [ ] **Step 1: Write the failing tests** — `mod tests` in the new file:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    const TTL: u64 = FRESH_AGENT_SESSION_LEASE_TTL_MS;

    #[test]
    fn first_claim_acquires_second_is_held() {
        let leases = FreshAgentSessionLeases::new();
        assert_eq!(leases.claim("claude", "sid-1", "req-a", 1_000), FreshSessionClaim::Acquired);
        assert_eq!(
            leases.claim("claude", "sid-1", "req-b", 1_100),
            FreshSessionClaim::Held { retry_after_ms: FRESH_AGENT_SESSION_RESERVED_RETRY_AFTER_MS }
        );
    }

    #[test]
    fn different_sessions_and_providers_do_not_contend() {
        let leases = FreshAgentSessionLeases::new();
        assert_eq!(leases.claim("claude", "sid-1", "req-a", 0), FreshSessionClaim::Acquired);
        assert_eq!(leases.claim("claude", "sid-2", "req-b", 0), FreshSessionClaim::Acquired);
        assert_eq!(leases.claim("codex", "sid-1", "req-c", 0), FreshSessionClaim::Acquired);
    }

    #[test]
    fn winner_fail_releases_so_loser_acquires() {
        let leases = FreshAgentSessionLeases::new();
        leases.claim("codex", "sid-1", "req-a", 0);
        leases.fail("codex", "sid-1", "req-a");
        assert_eq!(leases.claim("codex", "sid-1", "req-b", 10), FreshSessionClaim::Acquired);
    }

    #[test]
    fn winner_complete_releases_and_returns_true() {
        let leases = FreshAgentSessionLeases::new();
        leases.claim("codex", "sid-1", "req-a", 0);
        assert!(leases.complete("codex", "sid-1", "req-a"));
        assert_eq!(leases.claim("codex", "sid-1", "req-b", 10), FreshSessionClaim::Acquired);
    }

    #[test]
    fn expired_with_pid_needs_kill_then_force_release_reopens() {
        let leases = FreshAgentSessionLeases::new();
        leases.claim("claude", "sid-1", "req-a", 0);
        leases.set_pid("claude", "sid-1", "req-a", 4242);
        assert_eq!(leases.claim("claude", "sid-1", "req-b", TTL + 1), FreshSessionClaim::ExpiredNeedsKill { pid: 4242 });
        // lease is still held until the kill is confirmed
        assert_eq!(leases.claim("claude", "sid-1", "req-c", TTL + 2), FreshSessionClaim::ExpiredNeedsKill { pid: 4242 });
        leases.force_release_after_confirmed_kill("claude", "sid-1");
        assert_eq!(leases.claim("claude", "sid-1", "req-b", TTL + 3), FreshSessionClaim::Acquired);
    }

    #[test]
    fn expired_pidless_is_revoked_and_held_closed_and_late_complete_fails() {
        let leases = FreshAgentSessionLeases::new();
        leases.claim("opencode", "ses-1", "req-a", 0);
        assert_eq!(
            leases.claim("opencode", "ses-1", "req-b", TTL + 1),
            FreshSessionClaim::Held { retry_after_ms: FRESH_AGENT_SESSION_RESERVED_RETRY_AFTER_MS }
        );
        assert!(!leases.complete("opencode", "ses-1", "req-a")); // revoked holder must tear down
        // fail() by the revoked holder proves no orphan exists and reopens
        leases.fail("opencode", "ses-1", "req-a");
        assert_eq!(leases.claim("opencode", "ses-1", "req-b", TTL + 2), FreshSessionClaim::Acquired);
    }

    #[test]
    fn set_pid_by_foreign_request_is_a_no_op() {
        let leases = FreshAgentSessionLeases::new();
        leases.claim("claude", "sid-1", "req-a", 0);
        leases.set_pid("claude", "sid-1", "req-INTRUDER", 999);
        // still pid-less: expiry revokes instead of ExpiredNeedsKill
        assert_eq!(
            leases.claim("claude", "sid-1", "req-b", TTL + 1),
            FreshSessionClaim::Held { retry_after_ms: FRESH_AGENT_SESSION_RESERVED_RETRY_AFTER_MS }
        );
    }
}
```

- [ ] **Step 2: Run to verify failure**

```bash
cargo test -p freshell-freshagent session_lease
```
Expected: compile FAIL (module absent) — the red state.

- [ ] **Step 3: Implement** the module per the Interfaces block. Internal shape:

```rust
use std::collections::HashMap;
use std::sync::Mutex;

struct LeaseEntry {
    holder_request_id: String,
    acquired_at_ms: u64,
    pid: Option<u32>,
    revoked: bool,
}

fn lease_key(provider: &str, session_id: &str) -> String {
    format!("{provider}\u{0}{session_id}")
}
```

`claim` logic (single lock scope):

```rust
pub fn claim(&self, provider: &str, session_id: &str, holder_request_id: &str, now_ms: u64) -> FreshSessionClaim {
    let mut map = self.inner.lock().expect("fresh-agent lease lock poisoned");
    let key = lease_key(provider, session_id);
    match map.get_mut(&key) {
        None => {
            map.insert(key, LeaseEntry {
                holder_request_id: holder_request_id.to_string(),
                acquired_at_ms: now_ms, pid: None, revoked: false,
            });
            FreshSessionClaim::Acquired
        }
        Some(lease) => {
            let expired = now_ms > lease.acquired_at_ms.saturating_add(fresh_agent_session_lease_ttl_ms());
            if !expired || lease.revoked {
                return FreshSessionClaim::Held { retry_after_ms: FRESH_AGENT_SESSION_RESERVED_RETRY_AFTER_MS };
            }
            match lease.pid {
                Some(pid) => FreshSessionClaim::ExpiredNeedsKill { pid },
                None => {
                    lease.revoked = true;
                    tracing::error!(target: "invariant", provider, session_id,
                        holder = %lease.holder_request_id,
                        "fresh_agent_session_lease_revoked: expired pid-less holder — holding closed");
                    FreshSessionClaim::Held { retry_after_ms: FRESH_AGENT_SESSION_RESERVED_RETRY_AFTER_MS }
                }
            }
        }
    }
}
```

`complete`/`fail`/`set_pid`/`force_release_after_confirmed_kill` follow directly (holder-checked; `complete` returns `false` without removing when `revoked` or foreign; `fail` removes when holder matches, even if revoked).

- [ ] **Step 4: Run tests to verify pass + gates**

```bash
cargo test -p freshell-freshagent session_lease
cargo fmt --all && cargo clippy -p freshell-freshagent --all-targets -- -D warnings
```
Expected: 7 tests PASS, clippy clean.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-freshagent/src/session_lease.rs crates/freshell-freshagent/src/lib.rs
git commit -m "feat(freshagent): per-sessionRef liveness-bound lease primitive (D8, kill-before-release TTL)"
```

---

### Task 12: Rust — lease integration at the create-resume seams (claude + codex) + SESSION_RESERVED loser

**Files:**
- Modify: `crates/freshell-freshagent/src/lib.rs` (runtime state structs gain `leases: Arc<FreshAgentSessionLeases>`; a `FreshSessionLeaseGuard` RAII helper next to `FreshAgentCreateGuard` ~:1838-1858)
- Modify: `crates/freshell-freshagent/src/claude.rs` (`handle_create` :228, claim BEFORE `spawn_sidecar` :250 when `resume_session_id` is present)
- Modify: `crates/freshell-freshagent/src/codex.rs` (`handle_create` resume branch :483-497 / `handle_create_resume` :572)
- Modify: `crates/freshell-server/src/main.rs` (construct ONE `Arc<FreshAgentSessionLeases>`, pass to all three runtime constructors — find the `fresh_codex`/`fresh_claude`/`fresh_opencode` construction sites)
- Test: `crates/freshell-ws/tests/freshagent_session_lease.rs` (create)

**Interfaces:**
- Consumes: Task 11 primitive.
- Produces:
  - Every claude/codex create-with-resume claims `(provider, resume_session_id)` before spawning; the claim happens INSIDE the existing per-`requestId` dedup guard scope, before any process spawn.
  - Loser answer: `freshAgent.create.failed { requestId, code: "SESSION_RESERVED", message: "Another resume for this session is in flight", retryable: true }` — reusing the existing create-failed frame; NO new protocol fields (deliberate: avoids a C3 wire change; the client re-drive uses a fixed floor).
  - Live-winner adopt: if `has_live_session(resume_session_id)` is already true at create time, do what the runtime already does for a live duplicate (claude/codex both register/replay against the live session) — the lease is only claimed when the session is NOT yet live.
  - RAII guard: `FreshSessionLeaseGuard { leases, provider, session_id, request_id, armed: bool }`; `Drop` calls `fail()` when still armed (spawn panic/early-return safety); `disarm()` before `complete()`.
  - `set_pid` immediately after each sidecar spawn returns a child pid; `complete` at the point the session is registered in the runtime's sessions map; `ExpiredNeedsKill{pid}` → SIGKILL that pid, poll ESRCH ≤500ms (20 × 25ms, mirroring `terminal.rs:1021-1029`), `force_release_after_confirmed_kill`, re-claim ONCE; unconfirmed → hold closed + SESSION_RESERVED.

- [ ] **Step 1: Write the failing integration test** — create `crates/freshell-ws/tests/freshagent_session_lease.rs`. Model the harness on `crates/freshell-ws/tests/freshagent_claude_attach.rs` (fresh-agent-capable server + fake sidecar spec) and the claim flow on `session_ref_singleflight.rs:125-172`. Read both files first and reuse their helpers verbatim (spawn helper, hello/ready negotiation, frame reader).

```rust
//! D8 for fresh agents: two clients resuming the SAME durable session id with
//! DIFFERENT requestIds must produce exactly one sidecar.

#[tokio::test]
async fn two_clients_same_freshagent_session_ref_yield_exactly_one_sidecar() {
    // 1. Spawn the ws test server with a SLOW fake claude sidecar (the harness's
    //    sleeper spec — spawn delay > 0 so the second create lands mid-resume).
    // 2. Connect two negotiated clients (hello with paneReconcileV1 + paneReconcileFreshAgentV1).
    // 3. Both send freshAgent.create { requestId: "req-A"/"req-B", sessionType: "freshclaude",
    //    provider: "claude", resumeSessionId: SID, sessionRef: {provider:"claude", sessionId: SID} }.
    // 4. Assert exactly ONE freshAgent.created lands; the other client receives
    //    freshAgent.create.failed { code: "SESSION_RESERVED", retryable: true }.
    // 5. Loser re-sends the SAME create after ~1s; now the session is live ->
    //    the runtime's live-session handling answers (created/replayed against the
    //    winner's session), and the fake-sidecar spawn count is STILL 1.
}

#[tokio::test]
async fn winner_dies_mid_resume_releases_the_lease_for_the_loser() {
    // Fake sidecar spec that EXITS NONZERO on create (spawn fails).
    // Client A creates (claims, spawn fails -> guard fail() releases, create.failed lands).
    // Client B creates the same sessionRef -> Acquired -> its (now-succeeding) spawn proceeds.
    // Assert client B gets freshAgent.created.
}

#[tokio::test]
async fn lease_applies_to_legacy_clients_and_retry_converges() {
    // DESIGN DECISION (implementer must honor): unlike the terminal lease, the
    // fresh-agent lease is ALWAYS ON (runtime-level, not capability-gated) because
    // the two-writers corruption it prevents is real regardless of client generation,
    // and the loser frame is an ordinary freshAgent.create.failed every client
    // generation already handles (retryable: true).
    // Test: a NON-negotiated connection (no capabilities in hello) racing a second
    // resume for the same durable id receives create.failed{SESSION_RESERVED,
    // retryable: true}; re-sending the same create after the winner binds converges
    // (created/replayed against the winner's session); sidecar spawn count stays 1.
}
```

Write these as real tests against the actual harness (the comments above are the spec for their bodies; the harness helpers give you frame send/recv). If the existing fake-sidecar spec cannot count spawns, count via the harness's sidecar-spawn log or add a per-spec temp-file argv log exactly as `session_ref_singleflight.rs`'s `sleeper_cli_spec` does.

- [ ] **Step 2: Run to verify failure**

```bash
cargo test -p freshell-ws --test freshagent_session_lease
```
Expected: FAIL — two sidecars spawn / no SESSION_RESERVED frame exists.

- [ ] **Step 3: Implement**

1. `lib.rs`: `FreshSessionLeaseGuard` (RAII; ~30 lines, mirror `SessionRefLeaseGuard` at `crates/freshell-ws/src/terminal.rs:993-1017`). Add `leases: Arc<session_lease::FreshAgentSessionLeases>` to the claude/codex/opencode runtime state structs and constructors.
2. `main.rs`: `let fresh_agent_leases = Arc::new(FreshAgentSessionLeases::new());` passed to all three constructors.
3. `claude.rs` `handle_create`: when `msg.resume_session_id` is `Some(sid)` and `!self.has_live_session(&sid).await`, run the claim loop BEFORE `spawn_sidecar` (:250):

```rust
let mut lease_guard: Option<FreshSessionLeaseGuard> = None;
if let Some(sid) = resume_session_id.as_deref() {
    if !self.has_live_session(sid).await {
        for round in 0..2u8 {
            match self.leases.claim("claude", sid, &request_id, now_ms()) {
                FreshSessionClaim::Acquired => {
                    lease_guard = Some(FreshSessionLeaseGuard::armed(self.leases.clone(), "claude", sid, &request_id));
                    break;
                }
                FreshSessionClaim::Held { retry_after_ms: _ } => {
                    self.emit_create_failed(&request_id, "SESSION_RESERVED",
                        "Another resume for this session is in flight", true).await;
                    return;
                }
                FreshSessionClaim::ExpiredNeedsKill { pid } => {
                    if round == 0 && kill_and_confirm_dead(pid).await {
                        self.leases.force_release_after_confirmed_kill("claude", sid);
                        continue;
                    }
                    tracing::error!(target: "invariant", pid, session_id = sid,
                        "fresh_agent_lease_expired_kill_unconfirmed: holding closed");
                    self.emit_create_failed(&request_id, "SESSION_RESERVED",
                        "Another resume for this session is in flight", true).await;
                    return;
                }
            }
        }
    }
}
```

`emit_create_failed` = the runtime's existing create-failed emission (find the exact helper each runtime uses for `freshAgent.create.failed`; reuse it, do not invent a new frame). `kill_and_confirm_dead(pid)` = SIGKILL + 20 × 25ms ESRCH poll (small shared fn in `session_lease.rs`, unix-gated like `registry.rs::pid_alive`). After `spawn_sidecar` returns a child handle: `self.leases.set_pid("claude", sid, &request_id, child_pid)` (only when a lease is armed). At session-registration success: `if let Some(g) = lease_guard.take() { if !g.complete_or_teardown() { /* kill own sidecar, emit create.failed INTERNAL, return */ } }`. On any failure path the guard's Drop fires `fail()`.

4. `codex.rs`: identical claim loop at :483 (before `handle_create_resume`), locator `("codex", resume_session_id)`; `set_pid` after the codex sidecar spawn inside `handle_create_resume` (:591 area); `complete` where the thread registers.

- [ ] **Step 4: Run tests to verify pass + gates**

```bash
cargo test -p freshell-ws --test freshagent_session_lease
cargo test -p freshell-ws --test pane_reconcile_freshagent
cargo test -p freshell-freshagent
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-freshagent crates/freshell-server/src/main.rs crates/freshell-ws/tests/freshagent_session_lease.rs
git commit -m "feat(freshagent): claude+codex create-resume paths claim the D8 session lease (SESSION_RESERVED losers)"
```

---

### Task 13: Rust — lease at the attach-resume seams (claude attach, codex attach, opencode attach)

**Files:**
- Modify: `crates/freshell-freshagent/src/claude.rs` (`handle_attach` :503-537 → `resume_for_attach` :541)
- Modify: `crates/freshell-freshagent/src/codex.rs` (`handle_attach` :1089 — the untracked→resume and exited→respawn arms)
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs` (`handle_attach` :839 → `resume_durable_session`)
- Test: `crates/freshell-ws/tests/freshagent_session_lease.rs` (extend)

**Interfaces:**
- Consumes: Tasks 11-12.
- Produces: every attach path that spawns/resumes (as opposed to no-op'ing on a tracked live session) claims the lease first. Losers on the ATTACH path get `freshAgent.error { code: "SESSION_RESERVED", message: ..., sessionType, provider }` (attach has no ack frame; `freshAgent.error` with a non-`INVALID_SESSION_ID` code is the established error channel and does NOT mark the session lost). Claude's in-process `self.resuming` single-flight (:517-522) stays — the lease generalizes it across connections; keep both (the inner one is cheap and covers a window the lease doesn't need to).
- Opencode: resume claims `("opencode", session_id)`; no per-session process exists, so `set_pid` is never called → a hung opencode resume resolves via the pid-less revoke-and-hold-closed rule (documented decision: the shared `opencode serve` sidecar must NEVER be killed by the lease — it hosts other sessions).

- [ ] **Step 1: Write the failing tests** — extend `freshagent_session_lease.rs`:

```rust
#[tokio::test]
async fn loser_attach_after_winner_binds_converges_to_the_live_session() {
    // Client A: freshAgent.create with resume (winner, slow spawn).
    // Client B: freshAgent.attach { sessionId: SID, sessionRef } mid-spawn ->
    //   freshAgent.error { code: "SESSION_RESERVED" } (session NOT marked lost).
    // After winner's freshAgent.created: client B re-attaches -> normal attach
    //   behavior against the live session; sidecar spawn count still 1.
}

#[tokio::test]
async fn opencode_attach_resume_is_serialized_without_touching_the_shared_sidecar() {
    // Two clients attach-resume the same durable ses_* id concurrently.
    // Exactly one resume proceeds; the loser gets freshAgent.error{SESSION_RESERVED};
    // the shared opencode serve process is never killed (assert its pid unchanged
    // via the fake's audit log / process liveness).
}
```

- [ ] **Step 2: Run to verify failure**

```bash
cargo test -p freshell-ws --test freshagent_session_lease
```
Expected: new tests FAIL.

- [ ] **Step 3: Implement** — same claim-loop shape as Task 12 at each attach seam, with the loser emission swapped to the runtime's existing `freshAgent.error` emitter (each runtime has one — find it where `INVALID_SESSION_ID` is emitted and reuse with code `"SESSION_RESERVED"`). Skip the claim entirely when the session is already tracked live (the attach no-op arm).

- [ ] **Step 4: Run tests to verify pass + gates**

```bash
cargo test -p freshell-ws --test freshagent_session_lease
cargo test -p freshell-freshagent
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-freshagent crates/freshell-ws/tests/freshagent_session_lease.rs
git commit -m "feat(freshagent): attach-resume paths claim the D8 lease (opencode shared sidecar never killed)"
```

---

### Task 14: Client — SESSION_RESERVED bounded re-drive + automatic exhaustion resolution (fresh agents)

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentView.tsx` (create.failed handler :1292-1307; new re-drive machinery mirroring `TerminalView.tsx:3122-3160`)
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx` (extend)

**Interfaces:**
- Consumes: server `freshAgent.create.failed { code: 'SESSION_RESERVED', retryable: true }` (Task 12) and `freshAgent.error { code: 'SESSION_RESERVED' }` (Task 13); single-pane reconcile + fold (Task 10 machinery).
- Produces (constants exported for tests):
  - `FRESH_AGENT_RESERVE_RETRY_WINDOW_MS = 30_000` (> 20s lease TTL + margin — same arithmetic as `TerminalView.tsx:162-168`), `FRESH_AGENT_RESERVE_RETRY_FLOOR_MS = 1_000`.
  - On `create.failed{SESSION_RESERVED}`: do NOT set `status: 'create-failed'`; open the window on first hit; `setTimeout(FLOOR)` then re-arm `createSentRef` and re-send the SAME create (same `createRequestId`). On window exhaustion: single-pane reconcile → fold (auto-resolve: winner live → `attach` verdict → silent attach; winner failed → `dead_session`/`fresh` with the visible panel/notice — council rule 8).
  - On `freshAgent.error{SESSION_RESERVED}` (attach loser): re-send the attach after `FLOOR` within the same window; exhaustion → same single-pane reconcile.

- [ ] **Step 1: Write the failing tests**

```ts
it('create.failed SESSION_RESERVED re-drives the same create after the floor', async () => {
  vi.useFakeTimers()
  renderFreshAgentPane({ status: 'creating', createRequestId: 'req-1', sessionRef: { provider: 'claude', sessionId: DURABLE } })
  await flushCreate() // first create sent
  receiveWs({ type: 'freshAgent.create.failed', requestId: 'req-1', code: 'SESSION_RESERVED', message: 'reserved', retryable: true })
  await flush()
  expect(leafContent(store.getState()).status).toBe('creating') // not create-failed
  await vi.advanceTimersByTimeAsync(FRESH_AGENT_RESERVE_RETRY_FLOOR_MS + 20)
  expect(sentOfType('freshAgent.create')).toHaveLength(2)
  expect(sentOfType('freshAgent.create')[1].requestId).toBe('req-1')
})

it('exhaustion auto-resolves via a single-pane reconcile', async () => {
  vi.useFakeTimers()
  renderFreshAgentPane({ status: 'creating', createRequestId: 'req-1', sessionRef: { provider: 'claude', sessionId: DURABLE } })
  await flushCreate()
  // hammer SESSION_RESERVED past the window
  for (let t = 0; t <= FRESH_AGENT_RESERVE_RETRY_WINDOW_MS + 2_000; t += FRESH_AGENT_RESERVE_RETRY_FLOOR_MS) {
    receiveWs({ type: 'freshAgent.create.failed', requestId: 'req-1', code: 'SESSION_RESERVED', message: 'reserved', retryable: true })
    await vi.advanceTimersByTimeAsync(FRESH_AGENT_RESERVE_RETRY_FLOOR_MS)
  }
  const reqs = sentOfType('pane.reconcile.request')
  expect(reqs.length).toBeGreaterThanOrEqual(1)
  // fold attach -> silent attach to the winner
  const req = reqs[reqs.length - 1]
  receiveWs({ type: 'pane.reconcile.result', reconcileId: req.reconcileId, bootId: 'b', serverInstanceId: 's',
    verdicts: [{ paneKey: req.panes[0].paneKey, verdict: 'attach', sessionRef: { provider: 'claude', sessionId: DURABLE } }] })
  await flush()
  expect(leafContent(store.getState()).sessionId).toBe(DURABLE)
})

it('non-reserved create.failed still lands create-failed status (regression)', async () => {
  renderFreshAgentPane({ status: 'creating', createRequestId: 'req-1' })
  await flushCreate()
  receiveWs({ type: 'freshAgent.create.failed', requestId: 'req-1', code: 'SPAWN_FAILED', message: 'x', retryable: false })
  await flush()
  expect(leafContent(store.getState()).status).toBe('create-failed')
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx
```
Expected: FAIL — SESSION_RESERVED lands `create-failed` today.

- [ ] **Step 3: Implement** — in `FreshAgentView.tsx`:

```ts
export const FRESH_AGENT_RESERVE_RETRY_WINDOW_MS = 30_000
export const FRESH_AGENT_RESERVE_RETRY_FLOOR_MS = 1_000

const reserveRedriveRef = useRef<{ windowStart: number | null; timer: ReturnType<typeof setTimeout> | null }>({ windowStart: null, timer: null })

const redriveAfterSessionReserved = useCallback(() => {
  const state = reserveRedriveRef.current
  if (state.windowStart === null) state.windowStart = Date.now()
  if (Date.now() - state.windowStart >= FRESH_AGENT_RESERVE_RETRY_WINDOW_MS) {
    reconcileLostPane() // Task 10's single-pane reconcile + fold = the auto-resolve
    return
  }
  if (state.timer !== null) return
  state.timer = setTimeout(() => {
    state.timer = null
    createSentRef.current = false        // re-arm the create effect
    lastCreateArmKeyRef.current = ''     // force the render-phase re-arm
    dispatch(updatePaneContent({ tabId, paneId, content: { ...paneContentRef.current } })) // nudge the effect
  }, FRESH_AGENT_RESERVE_RETRY_FLOOR_MS)
}, [dispatch, paneId, reconcileLostPane, tabId])
```

In the `freshAgent.create.failed` handler (:1292-1307), before the generic arm:

```ts
if (message.code === 'SESSION_RESERVED' && message.retryable) {
  redriveAfterSessionReserved()
  return // keep status 'creating' — never create-failed for a transient reservation
}
```

In `src/lib/fresh-agent-ws.ts` `freshAgent.error` projection (:325-335): leave global handling unchanged (SESSION_RESERVED ≠ INVALID_SESSION_ID so it flows to `sessionError` today) — instead intercept in FreshAgentView's ws listener: on `freshAgent.error` for this pane's session with `code === 'SESSION_RESERVED'`, call `redriveAfterSessionReserved()` (which re-arms attach via the same nudge — the attach effect keys on `sessionId` which is still set) and suppress the pane-level error banner for that code (check where `sessionErrorMessage` renders, :2046, and filter SESSION_RESERVED). Clear `reserveRedriveRef` (window + timer) on `freshAgent.created` and on unmount.

- [ ] **Step 4: Run tests to verify pass**

```bash
npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx "test/unit/client/components/fresh-agent/FreshAgentView.test.tsx"
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/fresh-agent/FreshAgentView.tsx src/lib/fresh-agent-ws.ts test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx
git commit -m "feat(reconcile): fresh-agent SESSION_RESERVED bounded re-drive + reconcile auto-resolve on exhaustion"
```

---

### Task 15: E2E — reconcile-completion spec (verdict round-trip, one sidecar, zero identity-less spawns)

**Files:**
- Create: `test/e2e-browser/specs/reconcile-completion-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (add the spec to BOTH `RUST_ONLY_SPECS` and the `rust-chromium` `testMatch` — unregistered = zero tests collected = silent false green)

**Interfaces:**
- Consumes: `RustServer` (`helpers/rust-server.ts`), `TestHarness` (`helpers/test-harness.ts`), fake fixtures `fake-claude-sidecar.mjs` (`FRESHELL_CLAUDE_SIDECAR`, `FAKE_CLAUDE_SIDECAR_LOG`) and `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs` (`FAKE_CODEX_APP_SERVER_ARG_LOG`); pane-creation helpers copied from `restore-contract-wall-rust.spec.ts:343-460` (per-spec-ownership convention: COPY, don't import).
- Produces: three e2e proofs the task spec demands. `test.describe.configure({ mode: 'serial' })` is NOT needed; each test boots its own server. Guard every test with `expect(e2eServerKind).toBe('rust')`.

Test 1 — **fresh-agent mixed-provider restart recovers via verdicts (no lost-frame on the happy path):**

```ts
test('fresh-agent mixed-provider restart recovers via reconcile verdicts', async ({ page, e2eServerKind }) => {
  expect(e2eServerKind).toBe('rust')
  const { server, info, harness } = await bootSpec(page, { /* env: FRESHELL_CLAUDE_SIDECAR + FAKE_CLAUDE_SIDECAR_LOG, fake codex app-server; setupHome enabling providers */ })
  try {
    await createFreshclaudePane(page, harness, cwd)
    await sendFreshAgentTurn(page, harness, tabId, 'hello')            // establishes durable sessionRef
    const identityBefore = await freshAgentLeafIdentity(harness)       // sessionRef.sessionId
    const reconcileCountBefore = await countSent(harness, 'pane.reconcile.request')

    await server.restartAbrupt()
    await waitForWsReady(page)

    // (a) the reconcile round-trip happened and named the fresh-agent pane
    await expect.poll(async () => {
      const reqs = (await harness.getSentWsMessages()).filter(isReconcileRequest)
      return reqs.slice(reconcileCountBefore).some((r) => r.panes.some((p) => p.kind === 'fresh-agent'))
    }, { timeout: 30_000 }).toBe(true)

    // (b) the pane converged on the SAME durable identity
    await expect.poll(async () => freshAgentLeafIdentity(harness), { timeout: 60_000 }).toBe(identityBefore)

    // (c) happy path never marked the session lost and never landed a restoreError
    const state = await harness.getState()
    expect(Object.values(state.freshAgent.sessions).some((s) => s.lost)).toBe(false)
    expect(freshAgentLeaf(await harness.getPaneLayout(tabId)).content.restoreError).toBeUndefined()
  } finally { await server.stop() }
})
```

Test 2 — **two clients, same fresh-agent sessionRef → exactly one sidecar** (one context + two pages, `multi-client.spec.ts` pattern — shared localStorage so both hydrate the SAME pane):

```ts
test('two clients resuming one fresh-agent sessionRef spawn exactly one sidecar', async ({ page, browser, e2eServerKind }) => {
  // boot; create freshclaude pane; send a turn; flushPersistence(page)
  // pageB = await page.context().newPage(); goto same URL; waitForHarness/Connection
  // server.restartAbrupt(); waitForWsReady on BOTH pages -> both fold respawn for the same sessionRef
  // STABLE-COUNT settle on the sidecar log (restore-contract-wall-rust.spec.ts:1959-1974 pattern), then:
  const resumes = (await readSidecarLog(sidecarLogPath)).slice(watermark)
    .filter((e) => e.event === 'create' && e.resumeSessionId === identity)
  expect(resumes).toHaveLength(1)
  // and both pages' panes settle attached to that identity (no wedge, no duplicate)
})
```

Test 3 — **reload storm → zero transient identity-less spawns:**

```ts
test('page.reload storm never spawns an identity-less resume', async ({ page, e2eServerKind }) => {
  // boot with fake claude TERMINAL cli (CLAUDE_CMD + FAKE_CLAUDE_ARGV_LOG) AND freshclaude sidecar fixtures
  // create one claude terminal pane + one freshclaude pane; establish identities; flushPersistence
  const watermarkArgv = (await readArgvLog(argvLogPath)).length
  const watermarkSidecar = (await readSidecarLog(sidecarLogPath)).length
  for (let i = 0; i < 3; i++) {
    await page.reload()
    await waitForWsReady(page)
    await expect.poll(() => allPanesSettled(harness), { timeout: 30_000 }).toBe(true)
  }
  // terminal: every post-watermark spawn row carries --resume <sessionId> (no identity-less row)
  const spawns = (await readArgvLog(argvLogPath)).slice(watermarkArgv)
  expect(spawns.every((e) => hasFlagPair(e.argv, '--resume', terminalSessionId))).toBe(true)
  // fresh-agent: every post-watermark sidecar create carries the resume identity
  const creates = (await readSidecarLog(sidecarLogPath)).slice(watermarkSidecar).filter((e) => e.event === 'create')
  expect(creates.every((e) => e.resumeSessionId === freshclaudeIdentity)).toBe(true)
  // and (attach-verdict happy path) reloads should not have spawned at all once live:
  expect(spawns.length).toBe(0) // the pane was LIVE across reloads — verdict says attach, not create
})
```

(If the live-across-reload terminal legitimately requires zero spawns, keep the `toBe(0)` assertion; if the first reload lands before the terminal is adopted and one identity-carrying spawn is legal, relax ONLY the count — the identity-less check (`every(hasFlagPair)`) is the non-negotiable assertion. Decide from the observed first run and document the choice in a spec comment.)

Copy `readArgvLog`/`hasFlagPair`/`readServerLogs` helpers from `restore-contract-wall-rust.spec.ts` (per-spec ownership). `readSidecarLog` parses `FAKE_CLAUDE_SIDECAR_LOG` JSONL — check the fixture header (`test/e2e-browser/fixtures/fake-claude-sidecar.mjs`) for the exact row shape and adapt field names to what it actually logs.

- [ ] **Step 1: Write the spec (all three tests) + register it in the config**

- [ ] **Step 2: Run to verify the red state** (before this branch's client code, these fail; on THIS branch they should pass — the red proof for e2e is running them once with `FRESHELL_E2E_RUST_SERVER_BIN` pointed at a bf6242a1 binary is NOT required; instead verify the spec fails when it should by temporarily asserting a nonsense identity, then removing it — cheap sanity that the assertions bite):

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium \
  specs/reconcile-completion-rust.spec.ts --workers=1 --reporter=list
```

- [ ] **Step 3: Fix anything the spec surfaces** (this is the integration shakeout — timing, helper details, fixture log shapes).

- [ ] **Step 4: Prove stability**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium \
  specs/reconcile-completion-rust.spec.ts --workers=1 --repeat-each=3 --reporter=list
```
Expected: 9/9 PASS.

- [ ] **Step 5: Commit**

```bash
git add test/e2e-browser/specs/reconcile-completion-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): reconcile-completion spec — verdict round-trip, one-sidecar lease, zero identity-less reload spawns"
```

---

### Task 16: Contract-wall pin flips + double-restart stability (6x proof)

**Files:**
- Modify (conditionally): `test/e2e-browser/specs/restore-contract-wall-rust.spec.ts` (pins at :1165, possibly :1380)
- Modify (conditionally): `test/e2e-browser/specs/reconcile-client-adoption-rust.spec.ts` (:518 flake hardening)

**Interfaces:**
- Consumes: everything landed above; the pin convention (delete the `test.fail(` line on unexpected PASS, replace the `EXPECTED-FAIL WALL PIN` comment with a dated `HISTORY:` note; NEVER widen a pin, NEVER convert to `test.fixme`).
- Produces: an honest wall — every pin that this lane's work fixes is flipped; the double-restart specs are ≥6x green.

- [ ] **Step 1: Run the freshclaude identity pin (P0.2 §2.8)** — this lane's attach-verdict + pre-verdict wait is expected to close its client gap (persistMiddleware strips `content.sessionId`; the verdict now restores it):

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium \
  specs/restore-contract-wall-rust.spec.ts -g 'freshclaude' --workers=1 --reporter=list
```
- Unexpected PASS reported by Playwright → FLIP: delete the `test.fail(...)` line at :1165 and replace its `EXPECTED-FAIL WALL PIN` comment with `// HISTORY (2026-07-26): P0.2 client gap closed by reconcile-completion (fresh-agent attach verdicts + pre-verdict create wait).` Re-run to confirm green.
- Still failing → investigate; the pin stays only if the residual cause is genuinely outside this lane's three items. Document the observed residual in the pin reason string (narrow it, never widen).

- [ ] **Step 2: Run THE RULER (:1380) and the other two pins (:1705, :1829) once** — flip any that unexpectedly pass by the same procedure; expected outcome is that they remain pinned (their blockers are P1.8/P1.9 ledger items, not C2's).

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium \
  specs/restore-contract-wall-rust.spec.ts --workers=1 --reporter=list
```

- [ ] **Step 3: Double-restart 6x proof** (the task spec's explicit requirement):

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium \
  specs/reconcile-client-adoption-rust.spec.ts -g 'double-restart' \
  --repeat-each=6 --workers=1 --reporter=list
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium \
  specs/restore-contract-wall-rust.spec.ts -g 'double-restart' \
  --repeat-each=6 --workers=1 --reporter=list
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium \
  specs/double-restart-terminal-restore-rust.spec.ts --repeat-each=6 --workers=1 --reporter=list
```
Expected: all green. If `reconcile-client-adoption-rust.spec.ts:518` flakes (the waveB ~1-in-4 suspect), apply BOTH in-repo hardening patterns and re-run the 6x proof:
1. Event-gate the second SIGKILL (replace `await page.waitForTimeout(300)` with the argv-log watermark poll from `restore-contract-wall-rust.spec.ts:2108-2112` — kill only after recovery is provably in flight).
2. Wrap the exact `running.length === liveIds.length` orphan assertion in the STABLE-COUNT settle (`restore-contract-wall-rust.spec.ts:1959-1974` — two samples ≥5s apart must agree).

Note: the pre-verdict wait (Tasks 8-9) itself removes the biggest source of double-restart nondeterminism (the pre-verdict create racing the verdict), so run the 6x proof BEFORE touching the spec — only harden if it still flakes.

- [ ] **Step 4: Commit** (whatever changed — flips and/or hardening):

```bash
git add test/e2e-browser/specs/restore-contract-wall-rust.spec.ts test/e2e-browser/specs/reconcile-client-adoption-rust.spec.ts
git commit -m "test(e2e): flip pins closed by reconcile-completion; prove double-restart 6x green"
```
(Skip the commit if genuinely nothing changed, and record the 6x-green evidence in the task report instead.)

---

### Task 17: Final gates, full-suite proof, push (STOP before PR)

**Files:** none new.

**Interfaces:**
- Consumes: everything above.
- Produces: a fully green branch pushed to origin; proof bundle for the reviewer. NO PR.

- [ ] **Step 1: Rust gates**

```bash
cd /home/dan/code/freshell/.worktrees/reconcile-completion
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```
Expected: clean, all tests pass.

- [ ] **Step 2: Lint + typecheck + coordinated node suites** (WAIT if the coordinator gate is held by a sibling lane — never kill a foreign holder):

```bash
npm run lint
FRESHELL_TEST_SUMMARY="C2 reconcile-completion final gate" env -u FRESHELL_BIND_HOST npm run check
```
Expected: lint clean (a11y rules apply to the new `role="status"` notice), typecheck clean, full coordinated suite green.

- [ ] **Step 3: E2E proof set**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium \
  specs/reconcile-completion-rust.spec.ts \
  specs/reconcile-client-adoption-rust.spec.ts \
  specs/reconcile-handshake-rust.spec.ts \
  specs/restore-contract-wall-rust.spec.ts \
  specs/freshclaude-restart-parity-rust.spec.ts \
  specs/double-restart-terminal-restore-rust.spec.ts \
  --workers=1 --reporter=list
```
Expected: all green (pins that remain are expected-fail and count as green).

- [ ] **Step 4: Push the branch and STOP**

```bash
git log --oneline origin/main..HEAD   # review the commit train
git push -u origin feat/reconcile-completion
```
Do NOT run `gh pr create` (PR creation is not approved). Report: branch name, commit list, the three e2e proofs (verdict round-trip, one-sidecar, zero identity-less spawns), the 6x double-restart evidence, and any pins flipped.

---

## Self-Review (author ran this against the spec; verdicts recorded)

**1. Spec coverage:**
- ITEM 1 (fresh-agent verdict client folding — request inclusion, fold per verdict, batched dead panel, legacy path as capability-gated fallback, B1 architecture parity): Tasks 1-7, 9, 10. Verdict mapping matches §4.3 (`attach` → plain attach, `respawn` → create-with-resume, `dead_session` → batched panel, `fresh` → clean create); the legacy `.lost`/triggerRecovery heuristics remain as the capability-gated fallback (Task 10), mirroring B1's census gating.
- ITEM 2 (fresh-agent per-sessionRef lease, SESSION_RESERVED losers, bounded re-drive + automatic exhaustion resolution, kill-before-release TTL; red tests two-clients/winner-dies/loser-attaches): Tasks 11-14. All three named red tests exist: `two_clients_same_freshagent_session_ref_yield_exactly_one_sidecar` (Task 12), `winner_dies_mid_resume_releases_the_lease_for_the_loser` (Task 12), `loser_attach_after_winner_binds_converges_to_the_live_session` (Task 13). Exhaustion auto-resolve = Task 14 (attach if bound, dead/fresh flow if winner failed).
- ITEM 3 (reload-path pre-verdict create race; bounded wait with legacy fallback; double-restart 6x proof): Tasks 6, 8, 9, 16.
- E2E block (mixed-provider restart via verdicts with WS-traffic assertion; two contexts one sidecar; reload storm zero identity-less spawns; double-restart 6x; pin flips): Tasks 15, 16.
- Deliberate scope decision (documented, not a deferral): the fresh-agent lease is ALWAYS ON at the runtime seam rather than capability-gated (Task 12 test 3 rationale) — the two-writers corruption is client-generation-independent and the loser frame is an ordinary retryable `create.failed` every client already parses; the legacy client simply retries into convergence. This is a strictly-safer superset of the terminal design and is asserted by a dedicated test.

**1b. No silent deferrals:** every requirement lands with production behavior + a proving test in this plan; fakes are used only in e2e harnesses (the repo's established deterministic-CI pattern — fake CLIs/sidecars exercised through the REAL server binary and REAL client SPA). No task leaves a stub for another lane. UNRESOLVED COVERAGE GAPS: none.

**2. Placeholder scan:** test bodies marked with `/* ... */` one-liners always sit beside at least one fully-written sibling in the same describe block that establishes the complete harness pattern; each one-liner names its exact assertion. Rust Task 12/13 integration tests specify body-by-comment against named in-repo harnesses (`freshagent_claude_attach.rs`, `session_ref_singleflight.rs:125-172`) with exact frames and assertions enumerated — the implementer's first step is reading those two files. No TBD/TODO/"similar to Task N" references remain.

**3. Type consistency check (performed):** `FreshSessionClaim` variants consistent across Tasks 11-13; `applyFreshAgentReconcileAttach`/`resetFreshAgentPaneForReconcileCreate` payloads identical in Tasks 3, 4, 5, 8, 9, 10; `reconcilePendingPanes`/`setReconcilePendingPanes({paneKeys, startedAt})`/`clearReconcilePendingPane({paneKey})` consistent across Tasks 6-9; `RECONCILE_VERDICT_WAIT_MS` defined once (Task 8) and imported in Task 9; `FRESH_AGENT_RESERVE_RETRY_*` defined in Task 14 only; capability strings `paneReconcileV1`/`paneReconcileFreshAgentV1` match the server's exact parse keys (`crates/freshell-ws/src/lib.rs:608-621`).
