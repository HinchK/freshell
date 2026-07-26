# Reconcile Completion (Lane C2) Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Complete the reconcile handshake for fresh-agent panes (client verdict folding), extend the per-sessionRef create/resume lease (D8) to fresh-agent create-with-resume paths, and close the reload-path pre-verdict create race so a hydrated pane never fires an identity-less create before its reconcile verdict folds.

**Architecture:** Three legs. (1) Client: widen the existing B1 terminal fold architecture (`src/lib/pane-reconcile.ts` + `panesSlice` fold reducers + volatile `reconcileEpoch` re-fire) to `kind: 'fresh-agent'` panes behind the already-shipped server capability `paneReconcileFreshAgentV1`, folding verdicts into new fresh-agent-shaped reducers and the existing batched DeadSessionPanel. (2) Server: a new liveness-bound `FreshAgentSessionLeases` primitive in `crates/freshell-freshagent` (mirroring `TerminalRegistry`'s D8 lease semantics: fail-closed, kill-before-release TTL, `SESSION_RESERVED` losers) claimed inside every fresh-agent create/attach resume seam. (3) Create-hold: when reconcile is negotiated, the ws-client SENDER holds pane creates (`terminal.create`/`freshAgent.create`) per pane until that pane's verdict folds or a wall-clock bound elapses — this sender-level hold is the authoritative gate (mount-time creates are flushed from `preReadyCreateQueue` inside ws-client's own ready handling, BEFORE any App/Redux handler runs — ws-client.ts:184-189 vs :253-265 — so no Redux-map gate can close the race); `TerminalView` and `FreshAgentView` layer a view-level deferral on top for effect-ordering and UX.

**Tech Stack:** React 18 + Redux Toolkit + Zod (client), Rust (crates/freshell-ws, freshell-freshagent, freshell-protocol), Vitest (unit), cargo test (Rust), Playwright (e2e, `rust-chromium` project).

## Global Constraints

- Base: `origin/main @ bf6242a1`; worktree `/home/dan/code/freshell/.worktrees/reconcile-completion`, branch `feat/reconcile-completion`. All work happens inside this worktree.
- SCOPE FENCE — you own: client reconcile fold modules (`src/lib/pane-reconcile.ts`, `panesSlice` fold reducers, `DeadSessionPanel`), the ws-client create-hold seam (`src/lib/ws-client.ts`), the `FreshAgentView`/`TerminalView` drive seams, the `freshAgentSlice` `lost`-flag reducers, `crates/freshell-ws/src/reconcile_freshagent.rs` + lease extension seams, `crates/freshell-freshagent` create/attach lease integration + claude durable→live resolution, the terminal create-rung D7 guard seam in `crates/freshell-ws/src/terminal.rs` (cross-kind liveness probe injection ONLY), and the `crates/freshell-server/src/main.rs` wiring for the shared lease map + cross-kind probes.
- SCOPE FENCE — do NOT touch: sidebar/sessions code (`sessionsSlice`, Sidebar components, `session_directory.rs` — Lane C1); port/contract tooling; `shared/ws-protocol.ts` beyond what this plan explicitly specifies (Lane C3 owns contract tooling — every `shared/ws-protocol.ts` edit in this plan is deliberate, minimal, and must be called out in its commit message with the marker `[C3-NOTE]`). No kimi/gemini work. No codex rollout locator (B2). No tabs-snapshots / recover-my-panes UI (B3).
- Council rules (binding, from B1): `createRequestId` is NEVER re-minted by any fold path; dead sessions batch into ONE panel (never N modals); `corrected: true` is always user-visible; the legacy recovery path stays as the capability-gated fallback (never deleted); recovery is automatic, never offered; never a silent wedge, never a duplicate.
- Rust CI gates: `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings` must pass.
- Server imports (Node side): NodeNext/ESM — relative imports include `.js` extensions (applies to `shared/` and `server/`; client `src/` uses Vite aliases `@/`, `@shared/`, `@test/`).
- Coordinated node suites: broad runs go through the shared coordinator gate — `FRESHELL_TEST_SUMMARY="C2 reconcile-completion" env -u FRESHELL_BIND_HOST npm test`. If the gate is held by a sibling lane, WAIT — never kill a foreign holder. Focused runs: `npm run test:vitest -- run <paths>`.
- E2E: own `RustServer` instances on ephemeral ports only. NEVER ports 3001/3002. NEVER restart the user's self-hosted server. No broad kill patterns (`pkill -f`, `pkill node`, etc.). New rust-only specs must be registered in BOTH `RUST_ONLY_SPECS` and the `rust-chromium` `testMatch` in `test/e2e-browser/playwright.config.ts`.
- PR POLICY: NOT approved. Push the branch; STOP before `gh pr create` or any equivalent.
- Check disk space before long builds (`df -h .`); halt and report on ENOSPC.
- Commit after every task (focused, atomic). Commit messages use conventional commits with the Amplifier co-author trailer.
- Frozen-client invariant (AMENDED — see Validated decisions below): a client that does not send `paneReconcileFreshAgentV1` must see byte-identical behavior, WITH ONE EXPLICIT CARVE-OUT: a legacy client racing a resume against the always-on fresh-agent lease may receive `freshAgent.create.failed` / `freshAgent.error` frames with code `SESSION_RESERVED` that do not exist on base. Validation (V4) proved legacy clients have NO auto-retry — `retryable` feeds only a manual Retry button (FreshAgentView.tsx:2019-2040), attach losers get a persistent banner with no retry affordance, and hidden panes die silently. This visible, human-recoverable stall is accepted in exchange for preventing silent JSONL two-writer corruption (the D8 doctrine). FLAGGED FOR CAMPAIGN-OWNER RATIFICATION. A server that does not advertise the capability must still leave the client on the legacy fresh-agent recovery path.

---

## Validated decisions (load-bearing review)

A load-bearing-assumption validation pass ran over this plan (ledger + full evidence: `/home/dan/code/freshell/.worktrees/.the-usual-logs/reconcile-completion/load-bearing-ledger.md` and `reports/V1..V9-validation.md`). Three decisions are recorded here loudly:

1. **Pre-verdict wait shape (bounded wall-clock + legacy-eager fallback) has NO recorded campaign sanction** (V8: exhaustive search — no sanction, no prohibition; commit 6e59828f sanctions the lane assignment, not the shape). Alternatives were evaluated: pure server-side enforcement cannot stop an identity-less fresh create (no sessionRef to lease); an unbounded wait violates the recorded constraint "bounded … never an unbounded await" (§4.3). The bounded wait — upgraded per V2's falsification from a Redux-map gate to a sender-level hold in ws-client (Task 6b) — is the only candidate consistent with every recorded constraint, and its worst case degrades to today's behavior WITH the new server lease as backstop. FLAGGED FOR CAMPAIGN-OWNER RATIFICATION.
2. **The 4s verdict-wait bound is unmeasured** (no reload-verdict latency evidence exists). Deferred with graceful degradation: a wrong constant degrades to today's behavior and is a one-line retune; Task 15's e2e runs produce the first real latency evidence.
3. **The frozen-client invariant is formally AMENDED** (see Global Constraints above): the always-on fresh-agent lease may hand legacy clients `SESSION_RESERVED` frames they recover from only via the manual Retry affordance (V4 proved no auto-retry exists). A visible, human-recoverable stall is accepted over silent JSONL two-writer corruption. FLAGGED FOR CAMPAIGN-OWNER RATIFICATION.

---

## File Structure

Client (modify):
- `shared/ws-protocol.ts` — widen `ReconcilePaneSchema.kind`, add `paneReconcileFreshAgentV1` to `ReadyCapabilitiesSchema` (minimal, `[C3-NOTE]`).
- `src/lib/ws-client.ts` — hello opt-in for the new capability; sender-level pre-verdict create hold (`RECONCILE_VERDICT_WAIT_MS`, `setReconcilePendingCreates`, `clearReconcileCreateHold`, `cancelCreate` widened to held creates).
- `src/store/paneTypes.ts` — fresh-agent volatile fold fields; `DeadSessionEntry.kind`; `reconcilePendingPanes` slice field.
- `src/store/panesSlice.ts` — fresh-agent fold reducers, widened finder, pending-pane reducers, persistence strips.
- `src/store/persistMiddleware.ts` — strip new volatile fields.
- `src/store/freshAgentSlice.ts` — `clearSessionLost` reducer (the `markSessionLost` counterpart).
- `src/lib/pane-reconcile.ts` — fresh-agent request producer + fold routing; capability flag accessor.
- `src/components/DeadSessionPanel.tsx` — kind-aware "Start fresh here".
- `src/App.tsx` — capability capture, fresh-agent panes in the boot request, pending-pane set/clear.
- `src/components/TerminalView.tsx` — pre-verdict create wait.
- `src/components/fresh-agent/FreshAgentView.tsx` — epoch re-fire, pendingReconcile consumption, pre-verdict wait, capability-gated `.lost` handling, SESSION_RESERVED re-drive, reconcile notice.

Server (create/modify):
- Create: `crates/freshell-freshagent/src/session_lease.rs` — the fresh-agent D8 lease primitive.
- Modify: `crates/freshell-freshagent/src/lib.rs` (module export + runtime wiring), `claude.rs` (durable→live attach/send resolution + adopt arm + synchronous cli_index insert + lease claims), `codex.rs` (adopt arm + `finish_create` eviction guard + lease claims), `opencode_ws.rs` (lease claims + bounded `get_session`), `crates/freshell-ws/src/terminal.rs` (cross-kind liveness probe in the D7 create-rung guard ONLY), `crates/freshell-server/src/main.rs` (one shared lease map + cross-kind liveness probes into all three runtimes and the terminal guard).

Tests (create):
- `test/unit/client/lib/pane-reconcile.fresh-agent.test.ts`
- `test/unit/client/store/panesSlice.fresh-agent-reconcile.test.ts`
- `test/unit/client/components/FreshAgentView.reconcile.test.tsx`
- `test/unit/client/components/TerminalView.verdict-wait.test.tsx`
- `crates/freshell-freshagent/src/session_lease.rs` (`mod tests`)
- `crates/freshell-ws/tests/freshagent_session_lease.rs` (plus harness-extension work in `crates/freshell-ws/tests/freshagent_claude_attach.rs`'s fake-sidecar seam and a new ws-level fake `opencode serve`)
- `crates/freshell-ws/tests/cross_kind_liveness.rs`
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

The Rust server already parses `hello.capabilities.paneReconcileFreshAgentV1` (`crates/freshell-ws/src/lib.rs:617-621`) and echoes `ready.capabilities.paneReconcileFreshAgentV1` (`lib.rs:398-415`); this task is TS-only. This is a deliberate minimal `shared/ws-protocol.ts` change — commit with `[C3-NOTE]`. Cross-lane interplay (verified both sides, V8): lane C3's `contract:generate` CI gate may need a regen after this edit — C3's plan carries an explicit "Lane C2 coordination check" task (port-contract-reconcile plan :816-824), so no action here beyond the `[C3-NOTE]` marker.

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

NOTE (red-gate honesty): the `getServerCapabilities` test above is GREEN on base
— ws-client stores `msg.capabilities ?? {}` raw with no Zod parse
(`src/lib/ws-client.ts:158`), and vitest does not typecheck — so it is regression
coverage only, NOT part of this task's red gate. The red gate is the `hello`
test plus the two schema tests below.

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

it('ReadyCapabilitiesSchema preserves paneReconcileFreshAgentV1 through parsing', () => {
  const parsed = ReadyCapabilitiesSchema.safeParse({ paneReconcileV1: true, paneReconcileFreshAgentV1: true })
  expect(parsed.success).toBe(true)
  // Load-bearing assertion: Zod non-strict objects STRIP unknown keys — they do
  // NOT reject (see the comment at shared/ws-protocol.ts:274-276). So
  // `.success` is true even on base and proves nothing. App consumes the
  // Zod-PARSED ready.data.capabilities (src/App.tsx:1022); if the key is
  // stripped, the feature silently never activates. Assert the key SURVIVES:
  expect(parsed.success ? parsed.data?.paneReconcileFreshAgentV1 : undefined).toBe(true)
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test:vitest -- run test/unit/client/lib/ws-client.reconcile.test.ts test/unit/client/lib/pane-reconcile.test.ts
```
Expected: FAIL — three red tests, each for its own reason: (1) `ReconcilePaneSchema` rejects `kind: 'fresh-agent'` (today it is `z.literal('terminal')`); (2) the key-survival assertion fails because Zod non-strict objects STRIP the unknown `paneReconcileFreshAgentV1` key — they do NOT reject it — so `parsed.data.paneReconcileFreshAgentV1` is `undefined` on base while `.success` is true; (3) the hello test fails because hello lacks the field. The `getServerCapabilities` test is expected GREEN here (regression coverage only — see the note in Step 1).

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
- Modify: `src/store/panesSlice.ts` (`normalizePaneContent` fresh-agent branch :118-205 — BOTH returned object literals; `stripStaleIds` ~:869-890)
- NO change: `src/store/persistMiddleware.ts` — its kind-agnostic `stripTransientSessionFields` (:245-268) ALREADY applies to `kind === 'fresh-agent'` and ALREADY strips `pendingReconcile`/`reconcileNotice`/`reconcileEpoch` (the "A19: reconcile fold state is volatile — never persisted" destructure at :254-257).
- Test: `test/unit/client/store/panesSlice.fresh-agent-reconcile.test.ts` (create)

The gaps on base are BOTH in `panesSlice.ts`: (a) `normalizePaneContent`'s fresh-agent branch fully ENUMERATES its output fields with no rest spread — in both returned literals, the restoreError early return (:129-160) and the main return (:174-204) — so the three fold fields are silently DROPPED by every normalization: `initLayout` (:933), `updatePaneContent` (:1378), `hydratePanes` (:407), and the `restoreLayout` path (:900). Without fixing (a), fold state written by Task 3's reducers is wiped by the next unrelated content patch (the created-ack patch, `freshAgent.session.materialized` patches, Task 14's nudge), a `corrected` notice can vanish before rendering, and Task 9's store-backed harness (which seeds via `initLayout`) can never seed the fields at all. (b) `stripStaleIds` does not strip the trio on restore — invisible today only because (a) drops them anyway; once (a) is fixed, (b) becomes the sole strip point on the restore path. (Contrast the terminal branch, which preserves the same trio at panesSlice.ts:98-102 — that parity was done for B1 and is what this task mirrors.)

**Interfaces:**
- Consumes: `FreshAgentPaneContent` (paneTypes.ts:174).
- Produces: three new optional fields on `FreshAgentPaneContent` — `reconcileNotice?: string`, `pendingReconcile?: 'respawn' | 'fresh'`, `reconcileEpoch?: number` — identical names and semantics to the terminal trio (`paneTypes.ts:98-102`). All three are VOLATILE: never persisted, absent after hydration. Tasks 3/7/9 rely on these exact names.

- [ ] **Step 1: Write the failing tests** — create `test/unit/client/store/panesSlice.fresh-agent-reconcile.test.ts`:

The RED gate targets gap (a): `normalizePaneContent`'s fresh-agent branch drops the trio on the live paths. The restore-strip test is NOT the red gate — it is GREEN on base, but for the WRONG reason (normalize drops the trio before `stripStaleIds` matters); after Step 3 it becomes load-bearing because `stripStaleIds` is then the sole strip point on the restore path. Model reducer mechanics on the existing `stripStaleIds` fresh-agent test at `test/unit/client/store/panesSlice.test.ts:4238-4292` ("strips stale fresh-agent runtime identity while preserving durable resume options") — plain `panesReducer(...)`, no store/middleware needed (note `restoreLayout` early-returns if the tab already has a layout, which the model test's `initialState` handles; pre-Step-3, seed the trio with the same `as`-cast trick the model uses — the fields land on the type in Step 3):

```ts
import { describe, expect, it } from 'vitest'

describe('fresh-agent reconcile volatile fields', () => {
  it('the fold trio survives initLayout normalization on fresh-agent leaves (RED gate)', () => {
    // RED on base: normalizePaneContent's fresh-agent branch enumerates its
    // output fields (no rest spread) and silently drops all three.
    const state = panesReducer(initialState, initLayout({
      tabId: 'tab-1', paneId: 'pane-1',
      content: {
        kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude',
        createRequestId: 'req-1', status: 'connected',
        reconcileEpoch: 3, pendingReconcile: 'respawn', reconcileNotice: 'x',
      } as PaneContentInput,
    }))
    const content = leafContent(state, 'tab-1')
    expect(content.reconcileEpoch).toBe(3)
    expect(content.pendingReconcile).toBe('respawn')
    expect(content.reconcileNotice).toBe('x')
  })

  it('the fold trio survives updatePaneContent normalization (live patch path, RED gate)', () => {
    // RED on base for the same reason. This is the path the created-ack patch,
    // session.materialized patches, and Task 14's nudge flow through (:1378) —
    // preserving here is what stops unrelated patches wiping fold state.
    let state = panesReducer(initialState, initLayout({
      tabId: 'tab-1', paneId: 'pane-1',
      content: { kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude', createRequestId: 'req-1', status: 'connected' },
    }))
    state = panesReducer(state, updatePaneContent({
      tabId: 'tab-1', paneId: 'pane-1',
      content: {
        ...leafContent(state, 'tab-1'),
        reconcileEpoch: 1, pendingReconcile: 'fresh', reconcileNotice: 'n',
      } as PaneContentInput,
    }))
    const content = leafContent(state, 'tab-1')
    expect(content.reconcileEpoch).toBe(1)
    expect(content.pendingReconcile).toBe('fresh')
    expect(content.reconcileNotice).toBe('n')
  })

  it('restoreLayout strips reconcileEpoch/pendingReconcile/reconcileNotice from fresh-agent leaves', () => {
    // GREEN ON BASE — but vacuously (normalizePaneContent drops the trio before
    // stripStaleIds is even consulted). NOT part of the red gate. After Step 3
    // preserves the trio in normalizePaneContent, THIS test is what proves the
    // stripStaleIds edit: it is then the only thing keeping volatile fold state
    // out of restored layouts. Copy the reducer mechanics from
    // panesSlice.test.ts:4238-4292 exactly, adding the three fold fields to the
    // restored leaf's content (same `as PaneNode` cast as the model):
    const state = panesReducer(initialState, restoreLayout({
      tabId: 'tab-1',
      layout: leafWith({
        kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude',
        createRequestId: 'req-1', status: 'connected',
        sessionRef: { provider: 'claude', sessionId: '11111111-1111-4111-8111-111111111111' },
        reconcileEpoch: 3, pendingReconcile: 'respawn', reconcileNotice: 'x',
      }),
    }))
    const content = restoredLeafContent(state, 'tab-1')
    expect('reconcileEpoch' in content).toBe(false)
    expect('pendingReconcile' in content).toBe(false)
    expect('reconcileNotice' in content).toBe(false)
    expect(content.sessionRef?.sessionId).toBe('11111111-1111-4111-8111-111111111111')
  })

  it('persistence strips reconcileEpoch/pendingReconcile/reconcileNotice from fresh-agent panes', async () => {
    // GREEN ON BASE — regression coverage only, NOT part of the red gate.
    // persistMiddleware's kind-agnostic stripTransientSessionFields (:245-268)
    // already strips these three fields for fresh-agent panes (A19 destructure).
    // Follow the terminal reconcileEpoch strip test at
    // test/unit/client/store/panesSlice.reconcile.test.ts:214-251 (real store +
    // persistMiddleware, mocked localStorage, fake timers) with a fresh-agent leaf.
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

`leafWith`/`leafContent`/`restoredLeafContent` are trivial local helpers copied from the model test's mechanics (`leafContent(state, tabId)` reads the leaf's content back out of `state.layouts[tabId]`, throwing unless it is a fresh-agent leaf); `persistLeafWithContent` is a local helper copying the store+middleware setup from `test/unit/client/store/panesSlice.reconcile.test.ts:214-251` with a fresh-agent leaf swapped in.

- [ ] **Step 2: Run to verify failure**

```bash
npm run test:vitest -- run test/unit/client/store/panesSlice.fresh-agent-reconcile.test.ts
```
Expected: the two SURVIVAL tests (`initLayout` and `updatePaneContent`) FAIL at runtime — `normalizePaneContent`'s fresh-agent branch enumerates its output fields with no rest spread, so the seeded trio is dropped and the equality assertions fail. That is the red state. (vitest does not typecheck, so the not-yet-declared fields cause no compile error.) The `restoreLayout` strip test PASSES on base — vacuously, because normalize drops the trio before `stripStaleIds` matters; it becomes load-bearing after Step 3. The persistence test PASSES on base — regression coverage, not the gate.

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

(Do the paneTypes edit FIRST — it makes the `input.reconcileNotice`/`input.pendingReconcile`/`input.reconcileEpoch` reads below typecheck; the fields propagate automatically to `FreshAgentPaneInput` (:234) and the `PaneContent` union.)

`src/store/panesSlice.ts` `normalizePaneContent` fresh-agent branch — add the trio to BOTH returned object literals: the main return (insert after the `...(pendingLocalEcho ? { pendingLocalEcho } : {})` line at :203, before the closing `}` at :204) AND the restoreError early return (same trailing position, after :159, before the `}` at :160). Mirror the terminal branch's exact style for these same three fields (:98-102) — direct typed-guard assignment with `undefined` fallback, no `previous` merge:

```ts
      reconcileNotice: typeof input.reconcileNotice === 'string' ? input.reconcileNotice : undefined,
      pendingReconcile: input.pendingReconcile === 'respawn' || input.pendingReconcile === 'fresh'
        ? input.pendingReconcile
        : undefined,
      reconcileEpoch: typeof input.reconcileEpoch === 'number' ? input.reconcileEpoch : undefined,
```

This is the load-bearing edit of the task: it makes fold state survive every live normalization — `initLayout` (:933, also the path Task 9's store-backed test harness seeds through), `updatePaneContent` (:1378 — the created-ack patch, `session.materialized` patches, and Task 14's nudge), and `hydratePanes` (:407) — so a `corrected` reconcileNotice or an armed `pendingReconcile` is never wiped by an unrelated content patch (the binding "corrected is always user-visible" rule depends on this). Terminal precedent: the same trio in the same function, added for B1.

`src/store/panesSlice.ts` `stripStaleIds` fresh-agent arm (~:869-890) — add the three fields to the destructure (with the normalize edit above in place, this becomes the SOLE strip point on the `restoreLayout` path — `stripStaleIds` runs before `normalizePaneContent` in `normalizeRestoredTree` (:900), so fields stripped here never reach the preserving literals):

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

`src/store/persistMiddleware.ts` — make NO change. There is no separate fresh-agent branch: the single kind-agnostic `stripTransientSessionFields` (:245-268) already covers `kind === 'fresh-agent'` and already strips `pendingReconcile`/`reconcileNotice`/`reconcileEpoch` (A19 destructure at :254-257). The persistence test in Step 1 proves this and guards it as a regression. (The serialization path flows only through `stripTransientSessionFields`; `stripStaleIds` sits only on the `restoreLayout` restore path — the two are disjoint.)

- [ ] **Step 4: Run tests to verify pass**

```bash
npm run test:vitest -- run test/unit/client/store/panesSlice.fresh-agent-reconcile.test.ts test/unit/client/store/persisted-state.fresh-agent.test.ts
```
Expected: PASS (including the pre-existing fresh-agent persistence suite — no regressions).

- [ ] **Step 5: Commit**

```bash
git add src/store/paneTypes.ts src/store/panesSlice.ts test/unit/client/store/panesSlice.fresh-agent-reconcile.test.ts
git commit -m "feat(reconcile): fresh-agent volatile fold fields survive normalization; stripped on restore + persist"
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
- `applyFreshAgentReconcileAttach` maps the verdict's durable ref onto the live handle: fresh-agent attach verdicts carry `sessionRef` and `terminalId: None` (server: `reconcile_freshagent.rs:239-244`). Writing the DURABLE ref is valid for all three providers BECAUSE: codex keys its live sessions by the durable threadId end-to-end (codex.rs:104-105, :860-879); opencode dual-keys by placeholder AND durable `ses_*` id (opencode_ws.rs:95-99); and claude — whose live sessions are keyed by a sidecar-minted placeholder (claude.rs:310-320), making `attach{durable}` a silent no-op (claude.rs:512-513) and `send{durable}` a `SESSION_NOT_FOUND` (claude.rs:451-455) on base — gains server-side durable→live resolution in Task 10b (attach rebind via `cli_index` + ack, send fallback). The client fold does NOT need per-provider branching; it depends on Task 10b landing.
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
  - `foldVerdicts(dispatch, request, result, opts?: { onVerdictFolded?: (createRequestId: string) => void }): FoldOutcome` — routes each verdict by `request.panes[i].kind`; the optional hook fires once per successfully-folded pane (all kinds) with that pane's `createRequestId`, so callers can retract a held/queued create at the sender (Task 6b passes `ws.cancelCreate`; the existing terminal fold callers pass nothing and are unchanged).
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
  it('onVerdictFolded fires once per folded pane with its createRequestId (and not on cardinality violation)', () => {})
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

### Task 6: reconcilePendingPanes slice machinery (view-level pre-verdict wait state)

> **GATE PLACEMENT (binding, per validation V2):** this Redux map is the VIEW-LEVEL layer only — it defers the view effects and owns the per-pane timeout UX. It is provably NOT sufficient to close the reload race: ws-client flushes its `preReadyCreateQueue` inside its own ready handling, strictly BEFORE dispatching `ready` to App's handler (ws-client.ts:184-189 vs :253-265), so mount-queued creates are on the wire before any Redux mark can land. The authoritative gate is the SENDER-LEVEL hold in ws-client (Task 6b). Both layers share `RECONCILE_VERDICT_WAIT_MS` (defined in Task 6b).

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

### Task 6b: ws-client sender-level pre-verdict create hold (the AUTHORITATIVE gate)

**Files:**
- Modify: `src/lib/ws-client.ts` (ready handling :151-219, `preReadyCreateQueue` flush :183-189, `send()` :564-603, `cancelCreate` :136-149)
- Test: `test/unit/client/lib/ws-client.reconcile.test.ts` (extend — reuse its FakeWebSocket harness)

**Interfaces:**
- Consumes: the existing `preReadyCreateQueue`/`inFlightCreates` machinery and `cancelCreate` (ws-client.ts:136-149 — already deletes from both maps atomically, so retraction-before-flush needs no new queue machinery).
- Produces (exact names Tasks 7/8/9 use):
  - `export const RECONCILE_VERDICT_WAIT_MS = 4_000` (> the server's single 2s warming deferral + round-trip margin) — the ONE definition; Tasks 8/9 import it from here.
  - `setReconcilePendingCreates(requestIds: string[])` — narrows the hold to exactly the createRequestIds named in the boot reconcile request; held creates NOT in the set are released (sent) immediately.
  - `clearReconcileCreateHold()` — ends the hold: flushes any still-held creates (legacy fallback for cardinality gaps and the timeout path), cancels the hold timer.
  - `cancelCreate(requestId)` — widened to ALSO delete from the held-creates map (the fold's retraction hook).
- Hold semantics (the race-closer, per V2):
  1. When `ready` acks `paneReconcileV1`, the flush loop at :183-189 does NOT `sendNow` pane creates (`terminal.create`/`freshAgent.create`, per `isCreateMessage` :83-89); it moves them into `heldCreates: Map<requestId, msg>` instead. Non-create `pendingMessages` flush unchanged (:196-199).
  2. While the hold is active, `send()` of a create message is held too (mount effects that commit after ready): before `setReconcilePendingCreates` arrives, hold ALL creates; after, hold only requestIds in the pending set.
  3. A hold timer starts at ready: after `RECONCILE_VERDICT_WAIT_MS`, `clearReconcileCreateHold()` fires — every still-held create flushes (bounded, never a silent wedge — legacy-eager fallback).
  4. Fold integration (Task 7): App passes `foldVerdicts` the hook `(id) => ws.cancelCreate(id)` — every folded pane's STALE held create is retracted (attach: pane attaches instead; respawn/fresh: the fold's epoch bump re-fires the view effect, which re-sends the SAME requestId with the fold-corrected fields — sent immediately, hold over for that id). After folding, App calls `clearReconcileCreateHold()`.
  5. Capability-less ready / reconnect close: hold state fully reset (creates re-enter via the normal `preReadyCreateQueue` path on the next connection).
  6. When `paneReconcileV1` is NOT acked, behavior is byte-identical to today (the :183-189 flush runs unmodified).

- [ ] **Step 1: Write the failing tests** — extend `ws-client.reconcile.test.ts`:

```ts
it('holds queued pane creates on ready when paneReconcileV1 is acked (nothing on the wire)', () => {
  client.send({ type: 'terminal.create', requestId: 'req-t' })
  client.send({ type: 'freshAgent.create', requestId: 'req-f' })
  receiveReady({ capabilities: { paneReconcileV1: true } })
  expect(wireOfType('terminal.create')).toHaveLength(0)
  expect(wireOfType('freshAgent.create')).toHaveLength(0)
})

it('setReconcilePendingCreates releases creates OUTSIDE the pending set immediately', () => {
  // queue req-a + req-b, ready, then setReconcilePendingCreates(['req-a'])
  // -> req-b on the wire, req-a still held
})

it('cancelCreate retracts a held create (attach-fold path) — it never reaches the wire', () => {
  // hold req-a; client.cancelCreate('req-a'); clearReconcileCreateHold()
  // -> zero terminal.create frames for req-a
})

it('flushes remaining held creates after RECONCILE_VERDICT_WAIT_MS (legacy fallback)', () => {
  vi.useFakeTimers()
  // hold req-a; advance RECONCILE_VERDICT_WAIT_MS + 50 -> req-a on the wire, same requestId
})

it('without paneReconcileV1 the pre-ready flush is byte-identical (regression)', () => {
  // ready WITHOUT capabilities (or without paneReconcileV1) -> create flushed
  // immediately. NOTE: this is a NEW test — the existing test at :140-150 is
  // the capability-ACKED case (see Step 1b), not this capability-less case.
})
```

- [ ] **Step 1b: Flip the pinned capability-acked flush test** — the EXISTING test at `test/unit/client/lib/ws-client.reconcile.test.ts:140-150` ("flushes the pre-ready create queue even when the capability is acked") pins the OLD behavior this task deliberately reverses: it queues a pre-ready `terminal.create`, sends `ready` WITH `capabilities.paneReconcileV1: true`, and asserts the create IS on the wire. Under the new hold semantics that create moves to `heldCreates` instead (and the file uses fake timers, so the `RECONCILE_VERDICT_WAIT_MS` fallback never fires on its own) — the test MUST be updated in the same commit or Step 4 cannot go green. Rewrite it to assert the NEW contract (this also retires the base design decision documented at ws-client.ts:202-205 — that comment is updated in Step 3):

```ts
it('holds the pre-ready create queue when the capability is acked; timeout fallback flushes it', () => {
  // (was: "flushes the pre-ready create queue even when the capability is acked")
  // queue a pre-ready terminal.create; receiveReady with paneReconcileV1: true
  // -> NOT on the wire (held);
  // vi.advanceTimersByTime(RECONCILE_VERDICT_WAIT_MS + 50)
  // -> on the wire with the SAME requestId (legacy fallback, never a silent wedge)
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npm run test:vitest -- run test/unit/client/lib/ws-client.reconcile.test.ts
```
Expected: FAIL — creates flush immediately today (that flush-before-handler ordering is exactly the falsified race).

- [ ] **Step 3: Implement** per the Hold semantics block. Keep the changes inside `WsClient`: a `heldCreates` map + `reconcileHoldActive` flag + `reconcileHoldPendingSet: Set<string> | null` + one timer. Branch the :183-189 flush loop on `serverCapabilities.paneReconcileV1`; branch `send()`'s post-ready create path on the hold state; extend `cancelCreate` (:136-149) with `this.heldCreates.delete(requestId)`. Update the now-obsolete design comment at ws-client.ts:202-205 ("The preReadyCreateQueue flush above is unchanged...") to describe the new hold behavior. The reconnect blind-replay suppression at :204-214 is untouched.

- [ ] **Step 4: Run tests to verify pass**

```bash
npm run test:vitest -- run test/unit/client/lib/
```
Expected: PASS, including every pre-existing ws-client suite in that directory (no regression to the capability-LESS flush; the capability-ACKED flush test at :140-150 was deliberately flipped to the hold contract in Step 1b — it must pass in its updated form).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ws-client.ts test/unit/client/lib/ws-client.reconcile.test.ts
git commit -m "fix(reconcile): sender-level pre-verdict create hold in ws-client (closes the reload create race)"
```

---

### Task 7: App wiring — capability capture, fresh-agent request, pending set/clear

**Files:**
- Modify: `src/App.tsx` (ready handler :1017-1032, fold handler :1045-1081, error fallback :1083-1095)
- Test: `test/unit/client/components/App.reconcile-adoption.test.tsx` (extend)

**Interfaces:**
- Consumes: `buildReconcileRequest(state, { includeFreshAgent })`, `setFreshAgentReconcileActive`, `setReconcilePendingPanes`/`clearAllReconcilePendingPanes` (Tasks 4/6), and the ws-client hold API (Task 6b: `setReconcilePendingCreates`, `clearReconcileCreateHold`, `cancelCreate`).
- Produces: on every ready, App (a) latches both capabilities, (b) sends ONE request covering terminal panes plus (iff `paneReconcileFreshAgentV1`) fresh-agent panes, (c) marks exactly the requested paneKeys pending in Redux AND narrows the ws-client hold to exactly the requested createRequestIds (`ws.setReconcilePendingCreates`), (d) clears ALL pending (Redux map AND ws hold) on fold completion, on a correlated error frame, on cardinality violation, and on a capability-less ready. Fold-ownership rule unchanged (App folds only its own `reconcileId`). The fold passes `foldVerdicts` the hook `(id) => ws.cancelCreate(id)` so every folded pane's stale held create is retracted at the sender BEFORE the hold clears.

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
it('ready narrows the ws-client hold to the requested createRequestIds', async () => {
  // spy on ws.setReconcilePendingCreates; assert called with req.panes.map(p => p.createRequestId)
})
it('folding retracts each folded pane at the sender then clears the hold', async () => {
  // spy on ws.cancelCreate + ws.clearReconcileCreateHold; receive matching result;
  // assert cancelCreate called once per folded pane's createRequestId, clearReconcileCreateHold called after
})
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
    ws.setReconcilePendingCreates(req.panes.map((p) => p.createRequestId)) // narrow the Task 6b sender hold
    ws.send(req)
  } else {
    ws.clearReconcileCreateHold() // nothing to reconcile — release any held creates immediately
  }
} else {
  ws.clearReconcileCreateHold()
}
```

In the fold handler (:1045-1081): call `foldVerdicts(dispatch, req, result, { onVerdictFolded: (id) => ws.cancelCreate(id) })` so every folded pane's stale held create is retracted at the sender; after it returns, `dispatch(clearAllReconcilePendingPanes())` AND `ws.clearReconcileCreateHold()` (fold reducers already cleared per-pane Redux flags; these catch cardinality-violation outcomes where nothing folded). In the error-frame fallback (:1083-1095): same two calls before falling back to the census.

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
- Modify: `src/components/TerminalView.tsx` (constants ~:162-170; create-or-attach effect :2753-4725, `ensure()` else-branch :4661-4669, dep array :4706-4725; reconnect re-drive handler :4546-4577)
- Test: `test/unit/client/components/TerminalView.verdict-wait.test.tsx` (create; model on `TerminalView.session-reserved.test.tsx`)

**Interfaces:**
- Consumes: `s.panes.reconcilePendingPanes` (Task 6), `paneKeyFor`, `clearReconcilePendingPane`, `RECONCILE_VERDICT_WAIT_MS` (IMPORT from `src/lib/ws-client.ts` — defined once in Task 6b; do not redefine).
- Produces: the mount-time create is deferred while the pane is reconcile-pending, bounded by `RECONCILE_VERDICT_WAIT_MS`, then falls back to the legacy eager create. NOTE (V2): this view-level gate is defense-in-depth + the owner of the per-pane timeout that releases the Redux pending flag — the race itself is closed by the Task 6b sender hold. The attach branch (`currentTerminalId` set) is NEVER gated. ALSO (V3 caveat): the reconnect re-drive at :4576 (`sendCreate(current.createRequestId)` inside the `ws.onReconnect` handler) fires ungated today on a mid-window WS flap — it must consult the pending map too.

Behavior spec:
1. Pane pending + verdict folds within the window → the fold's `reconcileEpoch` bump / `terminalId` write drives the pane; NO eager `terminal.create` is ever sent for the pre-verdict window.
2. Pane pending + no verdict within `RECONCILE_VERDICT_WAIT_MS` → dispatch `clearReconcilePendingPane` → effect re-fires → legacy `sendCreate(createRequestId)` proceeds (pane never hangs).
3. Capability off / pane not in the request → map has no entry → behavior byte-identical to today.
4. Mid-window WS flap: the reconnect re-drive (:4571-4576, guard `!current.terminalId && current.status === 'creating'`) skips `sendCreate` while the pane is reconcile-pending and young — the post-flap reconcile round-trip (or the bounded timeout) drives the pane instead.

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

it('a mid-window reconnect does NOT fire the ungated re-drive while the pane is reconcile-pending', async () => {
  // V3 caveat: the onReconnect handler at :4576 sends terminal.create for a hydrated
  // status:'creating' pane. Seed pending, render, fire the harness's reconnect callback,
  // assert zero terminal.create; then clear the pending flag, fire reconnect again,
  // assert the legacy re-drive proceeds (same createRequestId).
  seedPendingForPane(tabId, paneId)
  renderTerminalPane({ terminalId: undefined, status: 'creating' })
  fireWsReconnect()
  await flush()
  expect(sentOfType('terminal.create')).toHaveLength(0)
  store.dispatch(clearReconcilePendingPane({ paneKey: `${tabId}:${paneId}` }))
  fireWsReconnect()
  await flush()
  expect(sentOfType('terminal.create')).toHaveLength(1)
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npm run test:vitest -- run test/unit/client/components/TerminalView.verdict-wait.test.tsx
```
Expected: FAIL — the eager create fires immediately in tests 1-3.

- [ ] **Step 3: Implement** — in `TerminalView.tsx`:

Import the constant (defined ONCE in Task 6b):

```ts
import { RECONCILE_VERDICT_WAIT_MS } from '@/lib/ws-client'
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

Reconnect re-drive gate (V3 caveat) — in the `ws.onReconnect` handler (:4546-4577), guard the `sendCreate(current.createRequestId)` call at :4576:

```ts
if (
  reconcilePendingSinceRef.current !== undefined
  && Date.now() - reconcilePendingSinceRef.current < RECONCILE_VERDICT_WAIT_MS
) {
  return // pane is reconcile-pending: the post-flap reconcile (or the bounded timeout) drives it
}
sendCreate(current.createRequestId)
```

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
- Consumes: Task 2 fields AND Task 2's `normalizePaneContent` fresh-agent preservation — the store-backed harness seeds pane content via `store.dispatch(initLayout(...))`, which normalizes at panesSlice.ts:933; without Task 2's normalize change any seeded `pendingReconcile`/`reconcileNotice`/`reconcileEpoch` would be silently dropped before the component ever saw it. Also Task 3 reducers, Task 6 pending map, `RECONCILE_VERDICT_WAIT_MS` (import from `src/lib/ws-client.ts` — the one Task 6b definition).
- Produces:
  1. A fold on a mounted fresh-agent pane re-fires the create effect via `reconcileEpoch` (same `createRequestId`).
  2. `freshAgent.created` consumes `pendingReconcile` (sets it `undefined`) — stale intent never survives a completed create.
  3. The create effect defers while the pane is reconcile-pending, bounded like Task 8 (view-level layer; the sender hold of Task 6b is the authoritative gate).
  4. `reconcileNotice` renders once (a `role="status"` line above the transcript) and is cleared after render.
  5. An attach fold (Task 3 sets `sessionId`) drives the EXISTING attach effect (:1196-1228) with no create — AND the `freshAgent.attach` frame it sends carries the durable id in `resumeSessionId` and `sessionRef`, not only `sessionId`: claude's `attach_durable_id` reads ONLY `msg.resume_session_id`/`msg.session_ref`, never `msg.session_id` (claude.rs:866-872), so an attach carrying the durable only in `sessionId` answers `lost_session_frame` even for a resumable session (V1 finding N-V1-2).

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
  const attach = sentOfType('freshAgent.attach').find((m) => m.sessionId === DURABLE)!
  expect(attach).toBeTruthy()
  // claude's attach_durable_id reads ONLY resumeSessionId/sessionRef (claude.rs:866-872):
  // the durable MUST ride those fields or a resumable session answers lost_session_frame.
  expect(attach.resumeSessionId).toBe(DURABLE)
  expect(attach.sessionRef).toEqual({ provider: 'claude', sessionId: DURABLE })
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

it('a HIDDEN pane composes with the pending gate: nothing enqueues pre-verdict, the fold-driven create enqueues via the rebind queue', async () => {
  // A12 composition coverage (the one interaction no existing suite touches):
  // hidden pane + pending seeded -> the create effect returns BEFORE the
  // hiddenRef enqueue branch (:1136-1145), so the rebind queue stays empty;
  // dispatch resetFreshAgentPaneForReconcileCreate (fold) -> pending cleared,
  // epoch bumps, effect re-fires -> the create ENQUEUES (not direct-send) and
  // the queue's pacing contract (<=4 un-acked) still governs it.
  vi.useFakeTimers()
  seedPendingForPane(tabId, paneId)
  renderFreshAgentPane({ sessionId: undefined, status: 'creating', hidden: true, sessionRef: { provider: 'claude', sessionId: DURABLE } })
  await flush()
  expect(sentOfType('freshAgent.create')).toHaveLength(0) // nothing enqueued, nothing sent
  store.dispatch(resetFreshAgentPaneForReconcileCreate({ tabId, paneId, intent: 'respawn', sessionRef: { provider: 'claude', sessionId: DURABLE } }))
  await flush()
  await vi.advanceTimersByTimeAsync(100) // rebind-queue pacing tick
  expect(sentOfType('freshAgent.create')).toHaveLength(1) // enqueued then paced out, same createRequestId
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx
```
Expected: FAIL on all six. Note the seeding dependency: the `freshAgent.created clears pendingReconcile` and `reconcileNotice renders once` tests only reach the component because Task 2's `normalizePaneContent` change lets the harness's `initLayout` seed carry `pendingReconcile`/`reconcileNotice` into the store — with that in place they fail for the RIGHT reason on this task's base (the created-ack patch does not yet clear `pendingReconcile`; nothing renders a `role="status"` notice yet). If either is unexpectedly GREEN here, suspect Task 2's normalize edit was skipped — HALT and re-check, do not weaken the assertions.

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

3b. **Attach message carries the durable ref:** in the attach effect (:1196-1228), extend the `freshAgent.attach` frame with `resumeSessionId: content.resumeSessionId` and `sessionRef: content.sessionRef` when present (claude reads the durable ONLY from those fields — `attach_durable_id`, claude.rs:866-872; codex/opencode ignore the extras harmlessly).

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
- Modify: `src/store/freshAgentSlice.ts` (new `clearSessionLost` reducer next to `markSessionLost` :461-467)
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx` (extend)

**Interfaces:**
- Consumes: `isFreshAgentReconcileActive()` (Task 4), `buildReconcileRequestForPanes` (Task 4, now kind-agnostic), `foldVerdicts`.
- Produces: when the fresh-agent capability is active, a `.lost` session triggers a SINGLE-PANE reconcile request owned by this FreshAgentView (fold-ownership rule: it folds only its own `reconcileId`); the verdict answers attach/respawn/dead. When the capability is inactive (legacy TS server, downgraded server), the existing `triggerRecovery` heuristics run unchanged — this is the capability-gated fallback, NOT deleted.
- New action `clearSessionLost(locator)` — the `markSessionLost` counterpart. REQUIRED, not optional (V3 falsified A11): no clearing counterpart exists in `freshAgentSlice.ts` (only `sessionCreated` :236 on the create-ack path and `materializeSession` :353 clear `lost`; the attach-path reducers `sessionInit`/`sessionSnapshotReceived` never touch it), and `removeSession` (:469-473) is DESTRUCTIVE — it deletes the whole session record including transcript state. An attach fold where the durable id == the old sessionId would otherwise leave `lost=true` on the same key forever and re-trigger the driver (a reconcile loop).

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

it('an attach verdict for the SAME durable-as-sessionId clears the lost flag (no reconcile loop)', async () => {
  // V3: the attach-path reducers never clear lost; when durable == old sessionId the
  // same session entry keeps lost=true and the driver re-fires (loop). The fold arm
  // must dispatch clearSessionLost for the pane's session.
  setFreshAgentReconcileActive(true)
  renderFreshAgentPane({ sessionId: DURABLE, status: 'running', sessionRef: { provider: 'claude', sessionId: DURABLE } })
  markSessionLostInStore(); await flush()
  const req = sentOfType('pane.reconcile.request')[0]
  receiveWs({ type: 'pane.reconcile.result', reconcileId: req.reconcileId, bootId: 'b', serverInstanceId: 's',
    verdicts: [{ paneKey: req.panes[0].paneKey, verdict: 'attach', sessionRef: { provider: 'claude', sessionId: DURABLE } }] })
  await flush()
  expect(sessionInStore(store.getState(), DURABLE).lost).toBe(false) // clearSessionLost landed
  expect(sentOfType('pane.reconcile.request')).toHaveLength(1)       // and no second reconcile fired
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

Add the clearing reducer in `src/store/freshAgentSlice.ts` (next to `markSessionLost` :461-467; same locator-keyed lookup):

```ts
/** markSessionLost's counterpart: a reconcile fold produced a working outcome —
 *  neutralize the lost flag WITHOUT destroying the session record
 *  (removeSession :469-473 deletes transcript/status state — never use it here). */
clearSessionLost(state, action: PayloadAction<SessionLocatorPayload>) {
  const session = state.sessions[sessionKeyFor(action.payload)] // reuse markSessionLost's key derivation
  if (session) session.lost = false
},
```

Export it (:624 export block). Dispatch it in the fold arm above, right after `foldVerdicts(dispatch, req, message)`, for this pane's CURRENT session locator — this covers the attach-where-durable==old-sessionId case, where the same session entry would otherwise keep `lost: true` forever and re-trigger the driver (respawn folds are already safe: the reset clears `sessionId`, and the later `freshAgent.created` runs `sessionCreated` → `lost = false`, freshAgentSlice.ts:236). The Step 1 tests catch both the lingering flag (new fourth test) and an infinite re-trigger (both assert exactly ONE reconcile request).

- [ ] **Step 4: Run tests to verify pass**

```bash
npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx "test/unit/client/components/fresh-agent/FreshAgentView.test.tsx"
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/fresh-agent/FreshAgentView.tsx src/store/freshAgentSlice.ts test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx
git commit -m "feat(reconcile): verdicts replace fresh-agent .lost heuristics (clearSessionLost + capability-gated fallback retained)"
```

---

### Task 10b: Rust — claude durable→live resolution (attach rebind + ack, send routing)

**Files:**
- Modify: `crates/freshell-freshagent/src/claude.rs` (`handle_attach` :503-537, `handle_send` :451-455, consumer envelope stamping :626-628/:695-707)
- Test: `crates/freshell-ws/tests/freshagent_claude_attach.rs` (extend — the fake-sidecar harness already exercises exactly these seams)

**Why this task exists (V1, binding):** claude keys live sessions by a sidecar-minted placeholder nanoid (`claude.rs:310-320`), while the reconcile attach verdict names the DURABLE ref (`reconcile_freshagent.rs:239-244` — `has_live_session` probed THROUGH `cli_index` to a different key, `claude.rs:484-489`). On base, the Task 3 fold therefore strands the pane: `attach{durable}` on a live session is a silent no-op — no frame, no rebind (`claude.rs:512-513`) — and `send{durable}` misses the map → `SESSION_NOT_FOUND` broadcast (`claude.rs:451-455`), while live events keep broadcasting under the placeholder key (`claude.rs:626-628`). Codex (durable threadId keys, codex.rs:104-105) and opencode (dual-keyed, opencode_ws.rs:95-99) need nothing.

**Interfaces:**
- Consumes: the existing `cli_index` (durable UUID → sessions-map key), `attach_durable_id` (`claude.rs:866-872` — reads `resume_session_id`/`session_ref` only; Task 9's client change guarantees the attach frame carries them).
- Produces:
  1. `handle_send`: on a sessions-map miss, resolve `msg.session_id` through `cli_index` and route to the live session (no more `SESSION_NOT_FOUND` for a durable id that `cli_index` maps).
  2. `handle_attach` attach-to-live arm (the `claude.rs:512-513` early-return): instead of a silent no-op, REBIND — alias the sessions map so the durable id resolves to the same live session record, and flip the session's broadcast id to the durable id (store the broadcast id ON the session record as a shared mutable handle read per-envelope by the consumer, replacing the captured map-key param at :695-707) so the pane keyed on the durable receives events.
  3. Attach-to-live ACK: after rebinding, emit the session's current state to the attaching connection using the SAME frames the attach-resume path already broadcasts (status/snapshot envelopes), stamped with the durable id — the client's attach must observe success, never silence.
  4. `kill`/detach and every other map consumer keep working under BOTH keys (alias, don't move — in-flight consumers hold the placeholder key).

- [ ] **Step 1: Write the failing tests** — extend `freshagent_claude_attach.rs` (its fake sidecar emits `sdk.session.init` with `cliSessionId = resumeSessionId || '44444444-…'` — see :51 — so `cli_index` maps the durable id):

```rust
#[tokio::test]
async fn attach_by_durable_id_on_a_live_session_rebinds_and_acks() {
    // 1. freshAgent.create (no resume) -> created names placeholder P; wait for
    //    sdk.session.init so cli_index[durable] = P.
    // 2. Second connection: freshAgent.attach { sessionId: DURABLE,
    //    resumeSessionId: DURABLE, sessionRef: {provider:"claude", sessionId: DURABLE} }.
    // 3. Assert: at least one frame arrives on the attaching connection stamped
    //    sessionId == DURABLE (the ack — today: silence, the falsifying no-op).
    // 4. Assert: NO second sidecar spawned (the fake's spawn count stays 1).
}

#[tokio::test]
async fn send_by_durable_id_routes_to_the_live_session() {
    // Same setup; freshAgent.send { sessionId: DURABLE, ... }.
    // Assert: no freshAgent.error { code: "SESSION_NOT_FOUND" }; the fake sidecar
    // receives the send line (its request log records it).
    // (Depends on the Task 12 Step 1a log knob if written after; a temp-file
    //  request log on the inline fake is ~5 lines JS either way.)
}

#[tokio::test]
async fn events_after_durable_rebind_are_stamped_with_the_durable_id() {
    // After the rebind, drive the fake to emit an sdk.status event; assert the
    // envelope's sessionId is DURABLE (broadcast stamp flipped, claude.rs:626-628).
}
```

- [ ] **Step 2: Run to verify failure**

```bash
cargo test -p freshell-ws --test freshagent_claude_attach
```
Expected: the three new tests FAIL (silent no-op / SESSION_NOT_FOUND / placeholder-stamped envelopes); the pre-existing tests stay green (`handle_attach_tracked_session_broadcasts_nothing` at claude.rs:1233-1242 pins the TRACKED-key no-op, which is untouched — the new arm fires only on the cli_index-resolved durable path).

- [ ] **Step 3: Implement** per the Produces block. Keep the decision-table doc at `claude.rs:499` in sync (the durable-in-cli_index row changes from "no-op" to "rebind + ack"). In-crate unit tests that pin the old silent no-op (`claude.rs:1401-1412`) must be updated to pin the NEW contract — update them in the same commit, never delete.

- [ ] **Step 4: Run tests to verify pass + gates**

```bash
cargo test -p freshell-ws --test freshagent_claude_attach
cargo test -p freshell-freshagent claude
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
```
Expected: PASS. (Host-run is fine: this suite kills nothing by pid — the sandbox rule bites in Tasks 12/13.)

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-freshagent/src/claude.rs crates/freshell-ws/tests/freshagent_claude_attach.rs
git commit -m "fix(freshagent): claude durable->live resolution - attach rebind + ack, send routes via cli_index"
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
    ExpiredNeedsKill { pid: u32, ownership_id: String },
    /// A completed winner's LIVE session owns this durable id (binding map hit,
    /// answered under the same lock) — the caller must ADOPT, never spawn.
    BoundLive { live_session_key: String },
}

#[derive(Default)]
pub struct FreshAgentSessionLeases { /* Mutex<Inner { leases: HashMap<String, LeaseEntry>, bindings: HashMap<String, String> }> — ONE lock over both maps */ }

impl FreshAgentSessionLeases {
    pub fn new() -> Self;
    /// Key = "{provider}\u{0}{durable_session_id}". Checks the BINDINGS map FIRST,
    /// under the same lock as the lease map — the under-the-lock TOCTOU re-check.
    /// Caller pre-checks via has_live_session are a fast path ONLY, never the defense
    /// (V5 proved miss->win->release->duplicate-spawn is constructible without this).
    pub fn claim(&self, provider: &str, session_id: &str, holder_request_id: &str, now_ms: u64) -> FreshSessionClaim;
    /// Arms the TTL kill path once the sidecar child pid AND its ownership tag are
    /// known (the tag drives the Task 12 tree-kill sweep — a bare pid misses the
    /// SDK-spawned grandchild writer). No-op if the lease is gone or foreign.
    pub fn set_kill_handle(&self, provider: &str, session_id: &str, holder_request_id: &str, pid: u32, ownership_id: &str);
    /// Winner registered its session: insert bindings[key] = live_session_key and
    /// remove the lease IN THE SAME LOCK SCOPE (registry.rs:1931-1940: releasing
    /// first and binding under a separate lock opens a no-lease/no-binding window
    /// -> a second spawn). Returns false if the lease was revoked or foreign — the
    /// caller must tear down its own child and fail loudly (no binding recorded).
    pub fn complete(&self, provider: &str, session_id: &str, holder_request_id: &str, live_session_key: &str) -> bool;
    /// Spawn/resume failed: release (safe for revoked leases — no orphan can exist).
    pub fn fail(&self, provider: &str, session_id: &str, holder_request_id: &str);
    /// The bound live session exited: session exit watchers MUST call this or the
    /// durable id stays adopt-only forever.
    pub fn clear_binding(&self, provider: &str, session_id: &str);
    /// Only legal after the holder's ENTIRE process tree death was confirmed
    /// (Task 12: child kill + ownership sweep empty). Also clears any binding.
    pub fn force_release_after_confirmed_kill(&self, provider: &str, session_id: &str);
}
```

Semantics (mirror of `TerminalRegistry`'s lease INCLUDING its binding closure — registry.rs:1805-1885 and the TOCTOU fix at registry.rs:1819-1844: "A loser preempted across the winner's register -> complete window arrives here after complete removed the winner's lease — seeing no lease — while only the bindings map records the winner. Re-check bindings WHILE HOLDING the leases lock"):
- `claim`: FIRST, under the lock, `bindings.get(key)` → `Some(live)` ⇒ `BoundLive { live_session_key }` (never `Acquired` after a completed winner — this closes V5's interleaving 1). Then:
- No lease entry → insert `{holder_request_id, acquired_at_ms: now_ms, kill_handle: None, revoked: false}` → `Acquired`.
- Entry held, unexpired (`now_ms <= acquired_at_ms + ttl`) → `Held { FRESH_AGENT_SESSION_RESERVED_RETRY_AFTER_MS }`. Re-claim by the SAME holder_request_id (re-drive of the same create) → also `Held` (the original task is still running; idempotent re-sends are answered by the per-requestId dedup, not the lease).
- Entry expired with a kill handle → `ExpiredNeedsKill { pid, ownership_id }` (lease stays held until the Task 12 tree-kill confirms + `force_release_after_confirmed_kill`).
- Entry expired, handle-less → set `revoked = true`, log `tracing::error!(target: "invariant", ..., "fresh_agent_session_lease_revoked: holding closed")`, return `Held` — hold closed, never release what you can't kill.
- `complete` on a revoked or foreign lease → `false` and the entry is NOT removed (revoked stays closed; foreign untouched); on success the binding insert + lease removal happen in ONE lock scope.

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
    fn winner_complete_records_binding_and_loser_claim_answers_bound_live() {
        // THE TOCTOU PIN (registry.rs:1819-1844's exact window, no threads needed):
        // a loser preempted across the winner's register -> complete window must see
        // BoundLive — NEVER Acquired — after complete removed the winner's lease.
        let leases = FreshAgentSessionLeases::new();
        leases.claim("codex", "sid-1", "req-a", 0);
        assert!(leases.complete("codex", "sid-1", "req-a", "live-key-1"));
        assert_eq!(
            leases.claim("codex", "sid-1", "req-b", 10),
            FreshSessionClaim::BoundLive { live_session_key: "live-key-1".into() }
        );
    }

    #[test]
    fn clear_binding_reopens_after_the_bound_session_exits() {
        let leases = FreshAgentSessionLeases::new();
        leases.claim("codex", "sid-1", "req-a", 0);
        assert!(leases.complete("codex", "sid-1", "req-a", "live-key-1"));
        leases.clear_binding("codex", "sid-1");
        assert_eq!(leases.claim("codex", "sid-1", "req-b", 20), FreshSessionClaim::Acquired);
    }

    #[test]
    fn expired_with_kill_handle_needs_kill_then_force_release_reopens() {
        let leases = FreshAgentSessionLeases::new();
        leases.claim("claude", "sid-1", "req-a", 0);
        leases.set_kill_handle("claude", "sid-1", "req-a", 4242, "own-1");
        assert_eq!(
            leases.claim("claude", "sid-1", "req-b", TTL + 1),
            FreshSessionClaim::ExpiredNeedsKill { pid: 4242, ownership_id: "own-1".into() }
        );
        // lease is still held until the tree-kill is confirmed
        assert_eq!(
            leases.claim("claude", "sid-1", "req-c", TTL + 2),
            FreshSessionClaim::ExpiredNeedsKill { pid: 4242, ownership_id: "own-1".into() }
        );
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
        assert!(!leases.complete("opencode", "ses-1", "req-a", "live-x")); // revoked holder must tear down (no binding recorded)
        // fail() by the revoked holder proves no orphan exists and reopens
        leases.fail("opencode", "ses-1", "req-a");
        assert_eq!(leases.claim("opencode", "ses-1", "req-b", TTL + 2), FreshSessionClaim::Acquired);
    }

    #[test]
    fn set_kill_handle_by_foreign_request_is_a_no_op() {
        let leases = FreshAgentSessionLeases::new();
        leases.claim("claude", "sid-1", "req-a", 0);
        leases.set_kill_handle("claude", "sid-1", "req-INTRUDER", 999, "own-x");
        // still handle-less: expiry revokes instead of ExpiredNeedsKill
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
    kill_handle: Option<(u32 /* pid */, String /* ownership_id */)>,
    revoked: bool,
}

#[derive(Default)]
struct Inner {
    leases: HashMap<String, LeaseEntry>,
    /// durable key -> live sessions-map key, recorded by complete() UNDER THE SAME LOCK.
    bindings: HashMap<String, String>,
}

fn lease_key(provider: &str, session_id: &str) -> String {
    format!("{provider}\u{0}{session_id}")
}
```

`claim` logic (single lock scope over BOTH maps — the under-the-lock re-check):

```rust
pub fn claim(&self, provider: &str, session_id: &str, holder_request_id: &str, now_ms: u64) -> FreshSessionClaim {
    let mut inner = self.inner.lock().expect("fresh-agent lease lock poisoned");
    let key = lease_key(provider, session_id);
    // TOCTOU closure (registry.rs:1819-1844): a loser arriving after the winner's
    // complete() removed the lease sees the BINDING instead of an empty map.
    if let Some(live) = inner.bindings.get(&key) {
        return FreshSessionClaim::BoundLive { live_session_key: live.clone() };
    }
    match inner.leases.get_mut(&key) {
        None => {
            inner.leases.insert(key, LeaseEntry {
                holder_request_id: holder_request_id.to_string(),
                acquired_at_ms: now_ms, kill_handle: None, revoked: false,
            });
            FreshSessionClaim::Acquired
        }
        Some(lease) => {
            let expired = now_ms > lease.acquired_at_ms.saturating_add(fresh_agent_session_lease_ttl_ms());
            if !expired || lease.revoked {
                return FreshSessionClaim::Held { retry_after_ms: FRESH_AGENT_SESSION_RESERVED_RETRY_AFTER_MS };
            }
            match &lease.kill_handle {
                Some((pid, ownership_id)) => FreshSessionClaim::ExpiredNeedsKill {
                    pid: *pid, ownership_id: ownership_id.clone(),
                },
                None => {
                    lease.revoked = true;
                    tracing::error!(target: "invariant", provider, session_id,
                        holder = %lease.holder_request_id,
                        "fresh_agent_session_lease_revoked: expired handle-less holder — holding closed");
                    FreshSessionClaim::Held { retry_after_ms: FRESH_AGENT_SESSION_RESERVED_RETRY_AFTER_MS }
                }
            }
        }
    }
}
```

`complete`/`fail`/`set_kill_handle`/`clear_binding`/`force_release_after_confirmed_kill` follow directly (holder-checked; `complete` inserts `bindings[key] = live_session_key` and removes the lease inside ONE lock scope — registry.rs:1931-1940 — and returns `false` without removing OR binding when `revoked` or foreign; `fail` removes when holder matches, even if revoked; `force_release_after_confirmed_kill` removes the lease AND any binding — the whole tree is confirmed dead).

- [ ] **Step 4: Run tests to verify pass + gates**

```bash
cargo test -p freshell-freshagent session_lease
cargo fmt --all && cargo clippy -p freshell-freshagent --all-targets -- -D warnings
```
Expected: 8 tests PASS, clippy clean. (Host-run is fine for THIS suite: pure in-process unit tests, no pid is ever signaled — the sandbox rule bites in Tasks 12/13.)

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
- Test: `crates/freshell-ws/tests/freshagent_session_lease.rs` (create) + harness fake-sidecar knob extensions (Step 1a — shared with `freshagent_claude_attach.rs`)

**Interfaces:**
- Consumes: Task 11 primitive; Task 10b's claude durable→live plumbing.
- Produces:
  - Every claude/codex create-with-resume claims `(provider, resume_session_id)` before spawning; the claim happens INSIDE the existing per-`requestId` dedup guard scope, before any process spawn.
  - Loser answer: `freshAgent.create.failed { requestId, code: "SESSION_RESERVED", message: "Another resume for this session is in flight", retryable: true }` — reusing the existing create-failed frame; NO new protocol fields (deliberate: avoids a C3 wire change; the client re-drive uses a fixed floor).
  - **HAS-LIVE→ADOPT ARMS (new server behavior — V1 falsified "the runtime already does this"):**
    - claude `handle_create` (:228-345) has ZERO liveness check today — a loser re-send unconditionally `spawn_sidecar`s a second resume of the same transcript (claude.rs:236-278). Add: when `resume_session_id` is live (`has_live_session`, or the claim answers `BoundLive { live_session_key }`), do NOT spawn — reply `freshAgent.created` naming the adopted session (the durable id — send/attach route to it after Task 10b) with the loser's own `requestId`.
    - codex `handle_create` → `handle_create_resume` (:483-497/:572) checks only `is_known_dead_thread` (codex.rs:582 — a negative cache), never the live `sessions` map. Add the same adopt arm: thread live → `freshAgent.created` naming the durable threadId, no spawn.
    - **codex eviction guard:** `finish_create` (:727-742) today REPLACES the winner's live `CodexSession` entry under the same threadId — orphaning the winner's sidecar and stealing its binding (strictly worse than a duplicate). Guard it: if a LIVE entry already occupies the threadId at registration time, do NOT insert — tear down own sidecar (start_kill + `reap_owned_codex_sidecars(own ownership_id)`) and answer the create as an adopt of the incumbent.
  - **claude synchronous cli_index insert (V5 interleaving 2 closure):** on the create-resume path, insert `cli_index[resume_sid] = map_key` SYNCHRONOUSLY at session registration (the sessions-map insert, claude.rs:310-320), mirroring the attach path's synchronous insert (claude.rs:652-655) — NOT lazily at `sdk.session.init` (claude.rs:720-725, which lands hundreds of ms later and leaves `has_live_session` blind exactly when Task 14's 1s loser retry arrives). Keep the `sdk.session.init` write as a corrector for the case where the CLI reports a different id.
  - RAII guard: `FreshSessionLeaseGuard { leases, provider, session_id, request_id, armed: bool }`; `Drop` calls `fail()` when still armed AND no kill handle was set; if a kill handle WAS set (live child exists), Drop must NOT blanket-`fail()` — kill own child first or leave the lease held (V5 caveat (a): a panic between `set_kill_handle` and `complete` must never release un-killed); `disarm()` before `complete()`.
  - **Kill discipline (V6 rework — raw single-pid SIGKILL is falsified):** the recorded pid is the Node bridge; the artifact writer is the SDK-spawned `claude` CLI GRANDCHILD (claude.rs:933-935, :949-953), and the sidecar's cleanup handlers never run on SIGKILL (index.mjs:283-287) — an orphaned writer survives while ESRCH on the bridge pid "confirms" death. Therefore:
    - `set_kill_handle(pid, ownership_id)` immediately after each sidecar spawn (the ownership tag env the runtimes already stamp — `FRESHELL_CLAUDE_SIDECAR_ID` etc.).
    - `complete(live_session_key)` at the point the session is registered in the runtime's sessions map.
    - `ExpiredNeedsKill { pid, ownership_id }` → `kill_and_confirm_tree_dead(pid, &ownership_id)`: graceful SIGTERM to the child first (catchable — lets the SDK cleanly kill its own CLI grandchild, mirroring `handle_kill`, claude.rs:360-383), ESRCH-poll ≤500ms (20 × 25ms, `terminal.rs:1021-1029` pattern), SIGKILL fallback; THEN the ownership sweep — `reap_owned_claude_sidecars(ownership_id)` / `reap_owned_codex_sidecars(...)` (claude.rs:1086-1089; freshell-codex transport.rs:91-115) — re-scanned until the tagged /proc set is EMPTY (bounded retries). ONLY then `force_release_after_confirmed_kill` + re-claim ONCE; unconfirmed → hold closed + SESSION_RESERVED, never force-release.
    - Non-Linux: the /proc ownership sweep is a no-op (`#[cfg(target_os = "linux")]`, claude.rs:1113-1116) — there is NO way to confirm the grandchild died, so HOLD CLOSED (SESSION_RESERVED), never force-release. `#[cfg]`-gate accordingly.
    - CODEX_CMD caveat: as deployed via npm, `codex` on PATH is a Node launcher shim that `spawn`s the native binary as a CHILD — the recorded pid is a bridge there too; the ownership sweep, not the child pid, is what reaches the real rollout writer. Never rely on the child pid alone.

- [ ] **Step 1a: Extend the test harness FIRST (V9: the knobs the red tests need do NOT exist).** The `freshagent_claude_attach.rs` harness has NO sidecar "spec" mechanism: the fake sidecar is one inline JS string (`FAKE_CLAUDE_SIDECAR_SOURCE`, :33-58) installed via process-global env vars (:86-88) under a file-wide `CLAUDE_ENV_LOCK` (:21-24) — one script per test, serialized; concurrent different behaviors inside one test must be STATEFUL knobs of a single script (marker files), never two specs. (`session_ref_singleflight.rs`'s `sleeper_cli_spec` is a TERMINAL-side `CliCommandSpec` in a different harness, and it logs no argv — common/mod.rs:41-44 — do not model on it.) Build into the inline fake, all env-driven:
  1. **Slow spawn:** `FAKE_SIDECAR_CREATE_DELAY_MS` — `setTimeout` before emitting `created` (~5-10 lines; the server's `read_created` budget is 45s, plenty).
  2. **Fail-once-on-create:** `FAKE_SIDECAR_FAIL_ONCE_MARKER` — exit nonzero on the FIRST create if the marker file is absent, write it, succeed thereafter (precedent: `FAKE_CLAUDE_SIDECAR_HOLD_TURN_ONCE_MARKER` in the e2e fixture, fake-claude-sidecar.mjs:31/:113-118).
  3. **Spawn/create counting:** `FAKE_SIDECAR_REQUEST_LOG` — append `{pid, t, msg}` JSONL per inbound line (precedent: `FAKE_CLAUDE_SIDECAR_LOG`, fake-claude-sidecar.mjs:34/:43-47); distinct pids = spawn count, `msg.type === 'create'` rows carry `resumeSessionId`.
  4. **Tagged decoy grandchild (for the kill-sweep test, Linux):** `FAKE_SIDECAR_SPAWN_GRANDCHILD=1` — detached `sleep 300` child inheriting env (so `/proc/<pid>/environ` carries the ownership tag the sweep scans for).
  House the extended fake script + its env-install helper where BOTH `freshagent_session_lease.rs` and `freshagent_claude_attach.rs` can use them (a shared `tests/common` helper, or duplicate the ~60-line script into the new file following the same `CLAUDE_ENV_LOCK` discipline). Codex leg: no Rust ws-harness codex sidecar fake exists; point `CODEX_CMD` at the e2e fake app-server (`test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs` with `FAKE_CODEX_APP_SERVER_ARG_LOG`) — the runtime explicitly normalizes multi-token `CODEX_CMD` values like `"node /path/fake-app-server.mjs"` (codex.rs:1610-1614).

- [ ] **Step 1b: Write the failing integration tests** — create `crates/freshell-ws/tests/freshagent_session_lease.rs`. Model the harness on `crates/freshell-ws/tests/freshagent_claude_attach.rs` (fresh-agent-capable server + Step 1a fake) and the claim flow on `session_ref_singleflight.rs:125-172`. Read both files first and reuse their helpers verbatim (spawn helper, hello/ready negotiation, frame reader).

```rust
//! D8 for fresh agents: two clients resuming the SAME durable session id with
//! DIFFERENT requestIds must produce exactly one sidecar.

#[tokio::test]
async fn two_clients_same_freshagent_session_ref_yield_exactly_one_sidecar() {
    // 1. Spawn the ws test server with a SLOW fake claude sidecar (Step 1a's
    //    FAKE_SIDECAR_CREATE_DELAY_MS knob > 0 so the second create lands mid-resume).
    // 2. Connect two negotiated clients (hello with paneReconcileV1 + paneReconcileFreshAgentV1).
    // 3. Both send freshAgent.create { requestId: "req-A"/"req-B", sessionType: "freshclaude",
    //    provider: "claude", resumeSessionId: SID, sessionRef: {provider:"claude", sessionId: SID} }.
    // 4. Assert exactly ONE freshAgent.created lands; the other client receives
    //    freshAgent.create.failed { code: "SESSION_RESERVED", retryable: true }.
    // 5. Loser re-sends the SAME create after ~1s; the ADOPT ARM answers it with
    //    freshAgent.created NAMING the winner's durable session (no spawn), and the
    //    fake-sidecar request log shows spawn count STILL 1 (distinct pids == 1).
}

#[tokio::test]
async fn winner_dies_mid_resume_releases_the_lease_for_the_loser() {
    // FAKE_SIDECAR_FAIL_ONCE_MARKER knob (Step 1a): first spawn exits nonzero.
    // Client A creates (claims, spawn fails -> guard fail() releases, create.failed lands).
    // Client B creates the same sessionRef -> Acquired -> its (now-succeeding) spawn proceeds.
    // Assert client B gets freshAgent.created.
}

#[tokio::test]
async fn lease_applies_to_legacy_clients_and_retry_converges() {
    // DESIGN DECISION (implementer must honor; owner ratification flagged in
    // "Validated decisions"): unlike the terminal lease, the fresh-agent lease is
    // ALWAYS ON (runtime-level, not capability-gated) because the two-writers
    // corruption it prevents is real regardless of client generation. V4 proved a
    // legacy loser does NOT auto-retry: create.failed lands an error card whose
    // `retryable: true` feeds a MANUAL Retry button (FreshAgentView.tsx:2019-2040)
    // — a visible, human-recoverable stall, accepted per the amended frozen-client
    // invariant over silent JSONL corruption.
    // Test: a NON-negotiated connection (no capabilities in hello) racing a second
    // resume for the same durable id receives create.failed{SESSION_RESERVED,
    // retryable: true}; re-sending the same create after the winner binds (the
    // manual-Retry shape) converges via the ADOPT ARM; sidecar spawn count stays 1.
}

#[tokio::test]
async fn codex_loser_create_resume_adopts_and_never_clobbers_the_winner() {
    // CODEX_CMD -> the e2e fake app-server (Step 1a). Winner resumes thread T and
    // binds; loser sends create-with-resume for T with a different requestId.
    // Assert: loser gets freshAgent.created naming T with NO second app-server
    // spawn (FAKE_CODEX_APP_SERVER_ARG_LOG row count), and the winner's session
    // still works afterwards (send on T streams) — pinning the finish_create
    // eviction guard (codex.rs:727-742 REPLACED the winner's entry on base).
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn expired_lease_kill_sweeps_the_sidecar_tree_before_release() {
    // FRESHELL_FRESH_AGENT_LEASE_TTL_MS=100; FAKE_SIDECAR_CREATE_DELAY_MS=10_000;
    // FAKE_SIDECAR_SPAWN_GRANDCHILD=1 (Step 1a knobs).
    // Client A claims + spawns (kill handle set), never completes within TTL.
    // Client B creates the same sessionRef after expiry -> ExpiredNeedsKill path:
    // assert the DECOY GRANDCHILD is dead (its pid, read from the request log,
    // fails kill(pid, 0)) BEFORE client B's freshAgent.created lands — i.e. the
    // ownership sweep ran and confirmed empty prior to force-release. A raw
    // single-pid SIGKILL fails this test (the grandchild survives — V6).
}
```

Write these as real tests against the actual harness (the comments above are the spec for their bodies; the harness helpers give you frame send/recv). Spawn counting comes from the Step 1a request-log knob (distinct pids / create rows) — NOT from `sleeper_cli_spec`, which logs nothing.

- [ ] **Step 2: Run to verify failure** (SANDBOX-WRAPPED — this suite kills real processes by recorded pid, so AGENTS.md:35-37's destructive-suite rule applies; the may-skip clause in `docs/development/test-sandbox.md:74-85` excludes anything "touching real processes by PID/name"):

```bash
scripts/sandbox-test.sh "cargo test -p freshell-ws --test freshagent_session_lease"
```
Expected: FAIL — two sidecars spawn / no SESSION_RESERVED frame exists / the grandchild survives. (First sandbox run is slower: it warms its own cargo target volume — test-sandbox.md:48-49.)

- [ ] **Step 3: Implement**

1. `lib.rs`: `FreshSessionLeaseGuard` (RAII; ~30 lines, mirror `SessionRefLeaseGuard` at `crates/freshell-ws/src/terminal.rs:993-1017`). Add `leases: Arc<session_lease::FreshAgentSessionLeases>` to the claude/codex/opencode runtime state structs and constructors.
2. `main.rs`: `let fresh_agent_leases = Arc::new(FreshAgentSessionLeases::new());` passed to all three constructors.
3. `claude.rs` `handle_create`: when `msg.resume_session_id` is `Some(sid)` and `!self.has_live_session(&sid).await`, run the claim loop BEFORE `spawn_sidecar` (:250):

```rust
let mut lease_guard: Option<FreshSessionLeaseGuard> = None;
if let Some(sid) = resume_session_id.as_deref() {
    if self.has_live_session(sid).await {
        // Fast-path ADOPT: answer created against the live session, no spawn.
        self.emit_created_adopting_live(&request_id, sid).await;
        return;
    }
    for round in 0..2u8 {
        match self.leases.claim("claude", sid, &request_id, now_ms()) {
            FreshSessionClaim::Acquired => {
                lease_guard = Some(FreshSessionLeaseGuard::armed(self.leases.clone(), "claude", sid, &request_id));
                break;
            }
            FreshSessionClaim::BoundLive { live_session_key: _ } => {
                // Under-lock ADOPT: the winner completed between our pre-check and
                // the claim (the V5 TOCTOU window) — never Acquired here.
                self.emit_created_adopting_live(&request_id, sid).await;
                return;
            }
            FreshSessionClaim::Held { retry_after_ms: _ } => {
                self.emit_create_failed(&request_id, "SESSION_RESERVED",
                    "Another resume for this session is in flight", true).await;
                return;
            }
            FreshSessionClaim::ExpiredNeedsKill { pid, ownership_id } => {
                if round == 0 && kill_and_confirm_tree_dead(pid, &ownership_id).await {
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
```

`emit_create_failed` = the runtime's existing create-failed emission (find the exact helper each runtime uses for `freshAgent.create.failed`; reuse it, do not invent a new frame). `emit_created_adopting_live` = a `freshAgent.created` for the LOSER's `requestId` naming the adopted durable session (send/attach route to it: codex/opencode natively, claude via Task 10b) — the defined loser-convergence reply. `kill_and_confirm_tree_dead(pid, ownership_id)` = graceful SIGTERM + ESRCH poll (20 × 25ms) + SIGKILL fallback on the child, THEN `reap_owned_claude_sidecars(ownership_id)` (or the codex reaper) re-scanned until the tagged /proc set is empty — Linux-gated; on non-Linux return `false` (hold closed). Small shared fn in `session_lease.rs`. After `spawn_sidecar` returns a child handle: `self.leases.set_kill_handle("claude", sid, &request_id, child_pid, &ownership_id)` (only when a lease is armed). At session-registration success (the sessions-map insert, claude.rs:310-320): FIRST insert `cli_index[sid] = map_key` synchronously (the V5 fix — mirror claude.rs:652-655), THEN `if let Some(g) = lease_guard.take() { if !g.complete_or_teardown(&map_key) { /* kill own sidecar + reap own ownership tag, emit create.failed INTERNAL, return */ } }`. Wire `leases.clear_binding("claude", sid)` into the session exit/removal path (the exit watcher that removes the sessions-map entry) — a dead bound session must reopen the durable id. On any failure path the guard's Drop fires `fail()` (Drop checks for an armed kill handle first — see Interfaces).

4. `codex.rs`: identical claim loop at :483 (before `handle_create_resume`) with the adopt fast-path checking the live `sessions` map, locator `("codex", resume_session_id)`; `set_kill_handle` after the codex sidecar spawn inside `handle_create_resume` (:591 area); `complete(thread_id)` where the thread registers — INSIDE the guarded `finish_create` (:727-742), which now refuses to evict a live incumbent (see Interfaces); `clear_binding` in the codex exit watcher.

- [ ] **Step 4: Run tests to verify pass + gates** (lease suite sandbox-wrapped — it kills by pid):

```bash
scripts/sandbox-test.sh "cargo test -p freshell-ws --test freshagent_session_lease"
cargo test -p freshell-ws --test pane_reconcile_freshagent
cargo test -p freshell-freshagent
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-freshagent crates/freshell-server/src/main.rs crates/freshell-ws/tests
git commit -m "feat(freshagent): claude+codex create-resume claim the D8 lease - adopt arms, tree-kill-before-release, SESSION_RESERVED losers"
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
- Opencode: resume claims `("opencode", session_id)`; no per-session process exists, so `set_kill_handle` is never called → a hung opencode resume resolves via the handle-less revoke-and-hold-closed rule (documented decision: the shared `opencode serve` sidecar must NEVER be killed by the lease — it hosts other sessions). BECAUSE revoke-and-hold-closed makes a hang PERMANENT for that sessionRef (V5 caveat b), `get_session` must be bounded: `resume_durable_session` → `get_session` (opencode_ws.rs:918 → serve.rs:625-628) issues its HTTP request with `RequestOptions.timeout` defaulted to `None` (serve.rs:74/83/92; the transport applies a timeout only when `Some`, transport.rs:66-68) — a wedged-but-accepting `opencode serve` hangs the await forever and holds the sessionRef reserved until server restart. Wrap the call in `with_timeout` (a bounded budget, ~10s) so a hang resolves to an error → guard `fail()` → lease reopens.

- [ ] **Step 1a: Build the ws-level fake `opencode serve` (V9: it does NOT exist — budget it).** No `crates/freshell-ws/tests/*` file references opencode fakes; the only "healthy fake serve" fixtures are in-crate unit tests INSIDE `crates/freshell-freshagent/src/opencode_ws.rs` (~:1422, :1665, :1752, :1828, :1861), not importable by the ws harness. Create a harness-owned fake serve for `freshagent_session_lease.rs`: a small in-process axum/tokio server implementing the endpoints the runtime's attach-resume path actually calls (mirror the in-crate fixtures' route shapes), plus (a) an audit log of requests, (b) a controllable per-request delay (to hold a resume in flight), and (c) a stable recorded pid/liveness handle for the never-killed assertion. This is materially larger than the Task 12 claude knobs — it is budgeted HERE, before the red tests, not discovered mid-task.

- [ ] **Step 1b: Write the failing tests** — extend `freshagent_session_lease.rs`:

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
    // Uses the Step 1a fake serve. Two clients attach-resume the same durable ses_*
    // id concurrently (fake delays the first resume in flight).
    // Exactly one resume proceeds; the loser gets freshAgent.error{SESSION_RESERVED};
    // the shared opencode serve process is never killed (assert its pid unchanged
    // via the fake's audit log / process liveness).
}
```

Plus an in-crate unit test for the `get_session` bound (next to the existing fake-serve unit tests in `opencode_ws.rs` ~:1422 ff.): a fake serve that ACCEPTS the request and never responds → `resume_durable_session` errors within the `with_timeout` budget (instead of hanging) → the lease guard's `fail()` reopens the sessionRef.

- [ ] **Step 2: Run to verify failure** (sandbox-wrapped — same destructive-suite ruling as Task 12):

```bash
scripts/sandbox-test.sh "cargo test -p freshell-ws --test freshagent_session_lease"
cargo test -p freshell-freshagent opencode
```
Expected: new tests FAIL.

- [ ] **Step 3: Implement** — same claim-loop shape as Task 12 at each attach seam, with the loser emission swapped to the runtime's existing `freshAgent.error` emitter (each runtime has one — find it where `INVALID_SESSION_ID` is emitted and reuse with code `"SESSION_RESERVED"`). Skip the claim entirely when the session is already tracked live (the attach no-op arm — for claude that arm is now Task 10b's rebind+ack, which needs no lease: it spawns nothing). ALSO (V5 caveat b): wrap the opencode `get_session` call inside `resume_durable_session` (opencode_ws.rs:918) in the crate's `with_timeout` helper (~10s budget) — `RequestOptions` defaults `timeout: None` (serve.rs:74/83/92) so the HTTP await is unbounded today, and an unbounded hang under a held lease permanently reserves the sessionRef (handle-less revoke holds closed by design).

- [ ] **Step 4: Run tests to verify pass + gates**

```bash
scripts/sandbox-test.sh "cargo test -p freshell-ws --test freshagent_session_lease"
cargo test -p freshell-freshagent
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-freshagent crates/freshell-ws/tests
git commit -m "feat(freshagent): attach-resume paths claim the D8 lease (opencode shared sidecar never killed, get_session bounded)"
```

---

### Task 13b: Rust — cross-kind liveness guards (terminal↔fresh-agent two-writer hole)

**Files:**
- Modify: `crates/freshell-freshagent/src/lib.rs` (runtime state gains an injectable `terminal_liveness` probe) + the Task 12/13 claim seams (consult it)
- Modify: `crates/freshell-ws/src/terminal.rs` (D7 create-rung guard :1357-1410 gains an injectable `fresh_agent_liveness` probe)
- Modify: `crates/freshell-server/src/main.rs` (wire BOTH probes as closures — main.rs sees both crates, so the dep direction stays clean: freshell-freshagent never imports freshell-ws and vice versa)
- Test: `crates/freshell-ws/tests/cross_kind_liveness.rs` (create)

**Why (V7, binding — this is a CORRUPTION hole, not a nice-to-have):** the terminal and fresh-agent resume domains are NOT disjoint. Cross-kind reachability of the same `(provider, sessionId)` is a SHIPPED feature — "Reopen as freshclaude / Claude CLI" (menu-defs.ts:157-185, ContextMenuProvider.tsx:821-960) — and scenario B needs no timing luck: the reopen flow flips session metadata BEFORE killing (:882 vs :919) and has an abort path between the two (:901-908), after which any sidebar resume builds a fresh-agent pane whose `buildResumeContent` ignores `liveTerminal` entirely (session-type-utils.ts:104-142) → a sidecar resumes S while the terminal PTY on S is alive indefinitely. Reverse direction: the terminal D7 guard checks ONLY terminal identity/registry surfaces (terminal.rs:1357-1410) — a live freshclaude sidecar on S is invisible to it. Two lease maps both report "working" on one JSONL. Keep this minimal but real: two injected probes, two rejections, tests.

**Interfaces:**
- Consumes: Tasks 11-13 lease seams; the existing D7 guard; `has_live_session` on all three runtimes; `TerminalRegistry`/identity probes.
- Produces:
  - `main.rs` builds `terminal_liveness: Arc<dyn Fn(provider, session_id) -> bool + Send + Sync>` (async-adapted as the seam requires) over the SAME probes the D7 guard uses (`state.identity.find_by_session` + `state.registry.probe`/`directory()`), injected into all three fresh-agent runtime constructors. The Task 12/13 claim seams consult it FIRST: a live terminal PTY owning `(provider, sid)` ⇒ the create/attach loser answer (`SESSION_RESERVED`, retryable — the terminal may be closing) with a distinct log line; NO lease claim, NO spawn.
  - `main.rs` builds `fresh_agent_liveness: Arc<dyn Fn(mode, session_id) -> bool + Send + Sync>` over the three runtimes' `has_live_session`, injected into the ws server state; the D7 create-rung guard (:1357-1410) adds it to its liveness join — a live sidecar on S rejects `terminal.create` with the guard's EXISTING rejection frame, same as a live PTY.
  - Both probes default to "always false" closures in tests/constructors that don't wire them (behavior-preserving for every existing suite).

- [ ] **Step 1: Write the failing tests** — `crates/freshell-ws/tests/cross_kind_liveness.rs` (combine the two harness seams: `spawn_server_with_specs`' terminal `CliCommandSpec` sleepers from `common/mod.rs` + the `FRESHELL_CLAUDE_SIDECAR` fake from Task 12 Step 1a — both are env/spec inputs to ONE server spawn):

```rust
#[tokio::test]
async fn freshagent_resume_is_refused_while_a_terminal_pty_owns_the_session() {
    // 1. terminal.create with a sleeper CLI + sessionRef {claude, S} -> live PTY owns S.
    // 2. freshAgent.create { resumeSessionId: S } (V7 scenario B shape).
    // 3. Assert freshAgent.create.failed { code: "SESSION_RESERVED", retryable: true }
    //    and the fake sidecar request log shows ZERO spawns.
}

#[tokio::test]
async fn terminal_create_is_refused_while_a_live_sidecar_owns_the_session() {
    // 1. freshAgent.create resumes S (fake sidecar live).
    // 2. terminal.create with wire sessionRef {claude, S} (the D7 rung,
    //    terminal.rs:1302-1315 derives resume_session_id from it).
    // 3. Assert the guard's existing live-conflict rejection frame lands and no PTY
    //    spawns `claude --resume S` (sleeper argv log empty past the watermark).
}
```

- [ ] **Step 2: Run to verify failure**

```bash
scripts/sandbox-test.sh "cargo test -p freshell-ws --test cross_kind_liveness"
```
Expected: FAIL both — today each domain is blind to the other (V7 §4).

- [ ] **Step 3: Implement** per the Interfaces block. Keep the probe signatures minimal (provider/mode + session id → bool); no crate gains a dependency on the other — closures only, constructed in `main.rs`.

- [ ] **Step 4: Run tests to verify pass + gates**

```bash
scripts/sandbox-test.sh "cargo test -p freshell-ws --test cross_kind_liveness"
cargo test -p freshell-ws --test session_ref_singleflight
scripts/sandbox-test.sh "cargo test -p freshell-ws --test freshagent_session_lease"
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
```
Expected: PASS (singleflight + lease suites prove no regression from the probe injection).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-freshagent crates/freshell-ws/src/terminal.rs crates/freshell-server/src/main.rs crates/freshell-ws/tests/cross_kind_liveness.rs
git commit -m "fix(server): cross-kind liveness guards - terminal and fresh-agent resumes see each other (one-writer invariant)"
```

---

### Task 14: Client — SESSION_RESERVED bounded re-drive + automatic exhaustion resolution (fresh agents)

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentView.tsx` (create.failed handler :1292-1307; new re-drive machinery mirroring `TerminalView.tsx:3122-3160`)
- Modify: `src/lib/fresh-agent-ws.ts` (gate the GLOBAL `createFailed` projection at :134-144 — see Step 3; without this the error card renders from `pendingCreateFailures` no matter what the pane-level handler does)
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx` (extend)
- Test: `test/unit/client/lib/fresh-agent-ws.test.ts` (extend — the FreshAgentView harness does not exercise `handleFreshAgentMessage`, so the global gate needs its own test here, alongside the existing create.failed projection coverage at :137-154)

**Interfaces:**
- Consumes: server `freshAgent.create.failed { code: 'SESSION_RESERVED', retryable: true }` (Task 12) and `freshAgent.error { code: 'SESSION_RESERVED' }` (Task 13); single-pane reconcile + fold (Task 10 machinery).
- Produces (constants exported for tests):
  - `FRESH_AGENT_RESERVE_RETRY_WINDOW_MS = 30_000` (> 20s lease TTL + margin — same arithmetic as `TerminalView.tsx:162-168`), `FRESH_AGENT_RESERVE_RETRY_FLOOR_MS = 1_000`.
  - On `create.failed{SESSION_RESERVED}`: do NOT set `status: 'create-failed'`; open the window on first hit; `setTimeout(FLOOR)` then re-arm `createSentRef` and re-send the SAME create (same `createRequestId`). On window exhaustion: single-pane reconcile → fold (auto-resolve: winner live → `attach` verdict → silent attach; winner failed → `dead_session`/`fresh` with the visible panel/notice — council rule 8).
  - CRITICAL — two independent writers feed one error card: the card condition is `pendingCreateFailure || paneContent.createError` (FreshAgentView.tsx:2016), and `pendingCreateFailure` comes from the GLOBAL projection `handleFreshAgentMessage` → `dispatch(createFailed(...))` → `state.freshAgent.pendingCreateFailures[createRequestId]` (fresh-agent-ws.ts:134-144), NOT from the pane-level handler. Gating only the pane-content patch still flashes the card every retry cycle, exposes a manual Retry that re-mints `createRequestId` and races the same-requestId re-drive, and — because nothing clears `pendingCreateFailures` on attach (`clearPendingCreateFailure` fires only on create re-registration and effect cleanup) — leaves a permanent "Create failed" card on a pane that auto-resolved via a silent attach. Therefore the GLOBAL projection must also skip `SESSION_RESERVED && retryable` (Step 3), so no `pendingCreateFailures` entry ever exists for a transient reservation.
  - On `freshAgent.error{SESSION_RESERVED}` (attach loser): re-send the attach after `FLOOR` within the same window; exhaustion → same single-pane reconcile.

- [ ] **Step 1: Write the failing tests**

IMPORTANT — the `receiveWs` helper in these tests MUST deliver each message through BOTH paths: the global `handleFreshAgentMessage` from `src/lib/fresh-agent-ws.ts` AND the mounted view's ws listener. Model it on the existing dual-delivery helper `deliverThroughAppAndMountedView` (`FreshAgentView.test.tsx:1162-1176`). The default harness pattern (calling `wsMock.onMessage.mock.calls[0][0]` directly) never runs the global `createFailed` projection, which is exactly the path that breaks the contract — pane-only delivery would let the tests pass while the real app still shows the error card.

```ts
it('create.failed SESSION_RESERVED re-drives the same create after the floor', async () => {
  vi.useFakeTimers()
  renderFreshAgentPane({ status: 'creating', createRequestId: 'req-1', sessionRef: { provider: 'claude', sessionId: DURABLE } })
  await flushCreate() // first create sent
  receiveWs({ type: 'freshAgent.create.failed', requestId: 'req-1', code: 'SESSION_RESERVED', message: 'reserved', retryable: true })
  await flush()
  expect(leafContent(store.getState()).status).toBe('creating') // not create-failed
  // the GLOBAL projection must not have minted an error-card entry either:
  expect(store.getState().freshAgent.pendingCreateFailures['req-1']).toBeUndefined()
  expect(document.querySelector('.fresh-agent-error-card')).toBeNull()
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
  // council rule 8: SILENT attach — no stale error card may survive the auto-resolve
  expect(store.getState().freshAgent.pendingCreateFailures).toEqual({})
  expect(document.querySelector('.fresh-agent-error-card')).toBeNull()
})

it('non-reserved create.failed still lands create-failed status (regression)', async () => {
  renderFreshAgentPane({ status: 'creating', createRequestId: 'req-1' })
  await flushCreate()
  receiveWs({ type: 'freshAgent.create.failed', requestId: 'req-1', code: 'SPAWN_FAILED', message: 'x', retryable: false })
  await flush()
  expect(leafContent(store.getState()).status).toBe('create-failed')
})
```

And in `test/unit/client/lib/fresh-agent-ws.test.ts` (alongside the existing create.failed projection test at :137-154 — the FreshAgentView harness cannot cover this path on its own):

```ts
it('create.failed SESSION_RESERVED (retryable) is not projected into pendingCreateFailures and keeps the create route alive', () => {
  // mirror the setup of the existing create.failed projection test (:137-154):
  registerFreshAgentCreate(/* requestId: 'req-1', route as in the model test */)
  handleFreshAgentMessage({ type: 'freshAgent.create.failed', requestId: 'req-1', code: 'SESSION_RESERVED', message: 'reserved', retryable: true }, dispatch)
  expect(dispatched(createFailed)).toHaveLength(0) // no pendingCreateFailures entry
  // route NOT consumed — the same-requestId re-drive's eventual created/failed must still route:
  handleFreshAgentMessage({ type: 'freshAgent.create.failed', requestId: 'req-1', code: 'SPAWN_FAILED', message: 'x', retryable: false }, dispatch)
  expect(dispatched(createFailed)).toHaveLength(1) // non-reserved still projects (regression)
})
```

(Adapt the assertion helpers to the file's existing mock-dispatch idiom — the properties to prove are exactly: SESSION_RESERVED+retryable → no `createFailed` dispatch and no `consumeCreateRoute`; any other code → unchanged projection.)

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

In the `freshAgent.create.failed` handler (:1292-1307), before the generic arm — but AFTER the existing `releasePendingRebind()` call at :1293 (skipping it would leak a rebind-queue slot for 10s on every retry cycle):

```ts
if (message.code === 'SESSION_RESERVED' && message.retryable) {
  redriveAfterSessionReserved()
  return // keep status 'creating' — never create-failed for a transient reservation
}
```

In `src/lib/fresh-agent-ws.ts` `handleFreshAgentMessage`, gate the GLOBAL `create.failed` projection (:134-144) with the same predicate, placed BEFORE both `consumeCreateRoute(requestId)` and `dispatch(createFailed(...))`:

```ts
if (msg.code === 'SESSION_RESERVED' && msg.retryable) {
  return // transient reservation: no pendingCreateFailures entry (no error card / no Retry
         // racing the same-requestId re-drive), and the create route stays alive so the
         // re-driven create's eventual created/failed still routes to this pane
}
```

This is what makes the contract hold: with no `pendingCreateFailures[createRequestId]` entry ever minted for SESSION_RESERVED, the error card (condition `pendingCreateFailure || paneContent.createError`, FreshAgentView.tsx:2016) stays absent during the re-drive window, and nothing stale survives the exhaustion attach auto-resolve (whose fold never clears that slice — the only clears are create re-registration at fresh-agent-ws.ts:105 and the effect cleanup at FreshAgentView.tsx:2216-2221).

In `src/lib/fresh-agent-ws.ts` `freshAgent.error` projection (:325-335): leave global handling unchanged (SESSION_RESERVED ≠ INVALID_SESSION_ID so it flows to `sessionError` today) — instead intercept in FreshAgentView's ws listener: on `freshAgent.error` for this pane's session with `code === 'SESSION_RESERVED'`, call `redriveAfterSessionReserved()` (which re-arms attach via the same nudge — the attach effect keys on `sessionId` which is still set) and suppress the pane-level error banner for that code (check where `sessionErrorMessage` renders, :2046, and filter SESSION_RESERVED). Clear `reserveRedriveRef` (window + timer) on `freshAgent.created` and on unmount.

- [ ] **Step 4: Run tests to verify pass**

```bash
npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx "test/unit/client/components/fresh-agent/FreshAgentView.test.tsx" test/unit/client/lib/fresh-agent-ws.test.ts
```
Expected: PASS (including the pre-existing fresh-agent-ws create.failed projection test — the gate must not disturb non-reserved codes).

- [ ] **Step 5: Commit**

```bash
git add src/components/fresh-agent/FreshAgentView.tsx src/lib/fresh-agent-ws.ts test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx test/unit/client/lib/fresh-agent-ws.test.ts
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

- [ ] **Step 1: Run the freshclaude identity pin (P0.2 §2.8)** — EXPECTED OUTCOME: the pin REMAINS (V1/A15 falsified the flip expectation). The pin's identity function `leafDurableIdentity` (:245-251) is first-arm-wins on `content.sessionId`, and the pin's own recorded observation (:1160-1163) shows the pre-kill capture is the sidecar-minted PLACEHOLDER (`fc-e2e-…`), never the durable UUID — so even a perfect attach fold (which writes the durable ref) cannot equal `originalSessionId`. Worse, the pin's `server.restartAbrupt()` SIGKILL flow leaves the restarted server with an empty sessions map ⇒ the verdict is RESPAWN (reconcile_freshagent.rs:104-112, :245-257), never attach, and claude's `created` mints ANOTHER placeholder — reproducing the mismatch by construction. Closing it requires claude's create flow to adopt the durable id as the primary pre-kill handle, which is outside this lane:

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium \
  specs/restore-contract-wall-rust.spec.ts -g 'freshclaude' --workers=1 --reporter=list
```
- Expected FAIL (pin holds) → PRIMARY PATH: NARROW the pin's reason string to the proven residual, e.g. `EXPECTED-FAIL WALL PIN (narrowed 2026-07-26 by reconcile-completion): pre-kill content.sessionId is the sidecar-minted placeholder, not the durable ref; the SIGKILL flow yields a respawn verdict which mints a new placeholder — closing requires claude created/create to expose the durable id as the primary handle (not in C2 scope).` Never widen, never convert to `test.fixme`.
- Unexpected PASS reported by Playwright → only then FLIP: delete the `test.fail(...)` line at :1165 and replace its comment with `// HISTORY (2026-07-26): P0.2 client gap closed by reconcile-completion (fresh-agent attach verdicts + pre-verdict create wait).` Re-run to confirm green, and record in the task report WHY it passed (it implies the identity capture changed).

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
scripts/sandbox-test.sh "cargo test --workspace"
```
Expected: clean, all tests pass. The workspace test run is SANDBOX-WRAPPED because it includes the lease suites (`freshagent_session_lease`, `cross_kind_liveness`), which kill real processes by recorded pid — AGENTS.md:35-37's destructive-suite rule; the may-skip clause (test-sandbox.md:74-85) excludes anything "touching real processes by PID/name". (First sandbox run warms its own cargo target volume — schedule note, not a blocker.)

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

## Self-Review (author ran this against the spec; verdicts recorded — RE-RUN after the load-bearing-validation reconciliation over every touched task: 1, 3, 4, 6, 6b, 7, 8, 9, 10, 10b, 11, 12, 13, 13b, 16, 17 + Global Constraints)

**1. Spec coverage:**
- ITEM 1 (fresh-agent verdict client folding — request inclusion, fold per verdict, batched dead panel, legacy path as capability-gated fallback, B1 architecture parity): Tasks 1-7, 9, 10 — PLUS Task 10b, which the validation proved load-bearing: the fold's durable-ref data model is only valid for claude because the server gains durable→live resolution (attach rebind + ack, send routing via `cli_index`); Task 10b carries its own red tests (`freshagent_claude_attach.rs`) and the client attach frame now carries the durable in `resumeSessionId`/`sessionRef` (Task 9, per claude.rs:866-872). The `.lost` fold arm dispatches a NEW `clearSessionLost` reducer (Task 10 — V3 proved no counterpart exists and `removeSession` is destructive), with a loop-prevention test.
- ITEM 2 (fresh-agent per-sessionRef lease, SESSION_RESERVED losers, bounded re-drive + automatic exhaustion resolution, kill-before-release TTL; red tests two-clients/winner-dies/loser-attaches): Tasks 11-14. The primitive now carries the binding map + `BoundLive` + under-the-lock TOCTOU re-check (V5 falsified caller-pre-check-only; mirror of registry.rs:1819-1844/:1931-1940), `set_kill_handle(pid, ownership_id)` replaces `set_pid`, and kill-before-release is a TREE kill: graceful child kill + ownership sweep confirmed empty before any release, hold-closed on non-Linux (V6 falsified raw single-pid SIGKILL — the writer is the SDK's CLI grandchild). Claude create-resume inserts `cli_index` synchronously (V5 interleaving 2). Has-live→adopt arms are NEW SERVER WORK (V1 falsified "the runtime already does this"): claude + codex adopt with a defined `freshAgent.created` loser reply, and codex's `finish_create` gains an eviction guard (it REPLACED the winner's entry on base) — all pinned by red tests in Task 12 (`…adopts_and_never_clobbers…`, `expired_lease_kill_sweeps_the_sidecar_tree_before_release`). Named red tests all exist: `two_clients_same_freshagent_session_ref_yield_exactly_one_sidecar` (Task 12), `winner_dies_mid_resume_releases_the_lease_for_the_loser` (Task 12), `loser_attach_after_winner_binds_converges_to_the_live_session` (Task 13). Opencode `get_session` is timeout-bounded (Task 13, V5 caveat b) with a unit test. Cross-kind two-writer overlap (V7: reachable TODAY via "Reopen as …") is closed by Task 13b's injected liveness probes in both directions, with two red tests. Exhaustion auto-resolve = Task 14 (unchanged).
- ITEM 3 (reload-path pre-verdict create race; bounded wait with legacy fallback; double-restart 6x proof): Tasks 6, 6b, 7, 8, 9, 16. The AUTHORITATIVE gate is the Task 6b sender-level hold in ws-client (V2 proved the Redux-map-on-ready gate is structurally too late: the pre-ready create queue flushes before App's handler — ws-client.ts:184-189 vs :253-265); the Redux map remains as the view-level layer, and folds retract stale held creates via the existing `cancelCreate` mechanics (:136-149). TerminalView's ungated reconnect re-drive (:4576) is gated during the pending window (V3 caveat), with a test.
- E2E block (mixed-provider restart via verdicts with WS-traffic assertion; two contexts one sidecar; reload storm zero identity-less spawns; double-restart 6x; pin flips): Tasks 15, 16. Task 16 Step 1's expectation is INVERTED per V1/A15: the P0.2 freshclaude pin is expected to REMAIN (it asserts the pre-kill placeholder id and its SIGKILL flow yields a respawn verdict); narrowing the pin reason is the primary path, flipping only on an unexpected pass.
- Deliberate scope decisions (documented, not deferrals): (a) the fresh-agent lease is ALWAYS ON at the runtime seam rather than capability-gated — V4 PROVED this is NOT byte-identical for legacy clients (no auto-retry exists; `retryable` feeds only a manual Retry button, FreshAgentView.tsx:2019-2040; attach losers get a banner with no retry; hidden panes die silently), so the Global Constraints frozen-client invariant carries an explicit carve-out accepting a visible, human-recoverable stall over silent JSONL two-writer corruption, flagged for owner ratification (see "Validated decisions"); asserted by Task 12's dedicated legacy-client test. (b) The bounded-wait shape and the 4s constant are recorded in "Validated decisions" as owner-ratifiable (no campaign sanction exists; the constant is unmeasured and degrades gracefully).

**1b. No silent deferrals:** every requirement lands with production behavior + a proving test IN THIS PLAN — including all server work this reconciliation added: Task 10b (claude rebind/ack/send-routing — 3 red integration tests), Task 12's adopt arms + eviction guard + synchronous cli_index insert + tree-kill sweep (5 integration tests incl. the Linux-gated grandchild-sweep test and the codex no-clobber test via `CODEX_CMD` → the e2e fake app-server), Task 13's `with_timeout` (in-crate unit test), Task 13b's cross-kind probes (2 integration tests), Task 6b's sender hold (5 unit tests), Task 10's `clearSessionLost` (fold-arm test). Harness gaps found by V9 are BUDGETED as explicit pre-steps, not discovered mid-task: Task 12 Step 1a (fake-sidecar knobs: slow-spawn, fail-once, request log, decoy grandchild — the named "sleeper spec" mechanism did not exist), Task 13 Step 1a (the ws-level fake `opencode serve`, which does not exist). Fakes are used only in test harnesses (the repo's established deterministic-CI pattern — fake CLIs/sidecars exercised through the REAL server binary and REAL client SPA). No task leaves a stub for another lane. UNRESOLVED COVERAGE GAPS: none.

**2. Placeholder scan:** test bodies marked with `/* ... */` one-liners always sit beside at least one fully-written sibling in the same describe block that establishes the complete harness pattern; each one-liner names its exact assertion. Rust Task 10b/12/13/13b integration tests specify body-by-comment against named in-repo harnesses (`freshagent_claude_attach.rs` + its Step 1a knob extensions, `session_ref_singleflight.rs:125-172`, `common/mod.rs` CLI specs) with exact frames and assertions enumerated — the implementer's first step is reading those files. No TBD/TODO/"similar to Task N" references remain. The one prior false claim ("the legacy client simply retries into convergence") is REMOVED — replaced everywhere by the V4-accurate manual-Retry description.

**3. Type consistency check (performed):** `FreshSessionClaim` variants (`Acquired` / `Held{retry_after_ms}` / `ExpiredNeedsKill{pid, ownership_id}` / `BoundLive{live_session_key}`) consistent across Tasks 11-13; `set_kill_handle`/`complete(.., live_session_key)`/`clear_binding` signatures identical in Tasks 11 and 12/13 call sites; `applyFreshAgentReconcileAttach`/`resetFreshAgentPaneForReconcileCreate` payloads identical in Tasks 3, 4, 5, 8, 9, 10; `reconcilePendingPanes`/`setReconcilePendingPanes({paneKeys, startedAt})`/`clearReconcilePendingPane({paneKey})` consistent across Tasks 6-9; ws-client hold API (`setReconcilePendingCreates(requestIds)`/`clearReconcileCreateHold()`/widened `cancelCreate`) consistent across Tasks 6b and 7; `foldVerdicts(dispatch, request, result, opts?)`'s `onVerdictFolded` hook consistent between Tasks 4 and 7; `RECONCILE_VERDICT_WAIT_MS` defined ONCE (Task 6b, ws-client.ts) and imported in Tasks 8 and 9; `FRESH_AGENT_RESERVE_RETRY_*` defined in Task 14 only; `clearSessionLost` named identically in Task 10's reducer, dispatch site, and test; capability strings `paneReconcileV1`/`paneReconcileFreshAgentV1` match the server's exact parse keys (`crates/freshell-ws/src/lib.rs:608-621`).

**4. Destructive-test workflow check (added by the reconciliation, per V9/A16):** every cargo run of a suite that kills real processes by recorded pid (`freshagent_session_lease`, `cross_kind_liveness`, and Task 17's workspace run which includes them) is wrapped in `scripts/sandbox-test.sh` per AGENTS.md:35-37; pure in-process suites (Task 11 unit tests, `pane_reconcile_freshagent`, `freshagent_claude_attach`) remain host-run under the may-skip clause.
