# Terminal Session Rebind Hardening Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Port 4 vetted salvage pieces from the discarded
`salvage/opencode-rebind-on-drift` branch (tab metadata re-keying on rebind,
stale identity-mismatch bounce suppression, duplicate-rebind idempotence
tests, an opencode rebind browser e2e) plus one new improvement (an opencode
plugin-alive heartbeat), all against main's server-authoritative
`previousSessionId` rebind mechanism.

**Architecture:** All five deliverables harden ONE mechanism: CLI-emitted
signal files drained by serialized Rust sweeper tasks that run a guarded
rebind lane and broadcast `terminal.session.associated` with
`previousSessionId`, which the client folds via a deterministic supersession
handshake (`src/lib/terminal-session-association.ts`). Deliverable 1 fixes a
real latent client bug (stranded `tab.sessionMetadataByKey` entries).
Deliverable 2 adds the missing Rust input-path identity guard (Node parity)
plus client-side suppression of the self-healing race it creates.
Deliverables 3 and 4 are pure coverage. Deliverable 5 adds log-only
observability for silent plugin death.

**Tech Stack:** Rust (axum/tokio, `crates/freshell-ws`,
`crates/freshell-protocol`), TypeScript/React/Redux Toolkit client, Vitest
(coordinator-gated), Playwright browser e2e, an opencode TUI plugin in
TypeScript (`extensions/opencode/freshell-rebind-plugin.ts`, embedded into
the Rust binary via `include_str!`).

## Global Constraints

- Base branch: `origin/main` @ `62fa0ff1`; work on branch
  `feat/rebind-salvage-hardening` in worktree
  `/home/dan/code/freshell/.worktrees/rebind-salvage-hardening`. All
  commands below run from that worktree root.
- Reference branch `salvage/opencode-rebind-on-drift` is LOCAL-ONLY: never
  push it, never merge it wholesale. Read files with
  `git show salvage/opencode-rebind-on-drift:<path>`.
- OUT OF SCOPE: the Node/TypeScript server (exists, not production — add NO
  Node server functionality), the branch's drift FSM/watchers/SSE mechanism
  (do not resurrect any inference-based detection), the branch's
  `opencode_roots` resolver, its `try_adopt` CAS, its `test_state.rs`
  refactor, and its `allowRebind` client API (main replaced it with
  `previousSessionId`; the branch also added a `'rebound'` status — do not
  port either).
- Strict red-green-refactor TDD for every task (verify each failing test
  fails for the right reason before implementing).
- Vitest: focused runs via `npm run test:vitest -- <paths> --run` (never
  raw `npx vitest`); broad runs via `FRESHELL_TEST_SUMMARY="..." npm test`
  which WAITS on the shared coordinator gate — if another agent holds it,
  wait (check `npm run test:status`), never kill a foreign holder.
- Rust gates (all must be clean before the final commit):
  `cargo fmt --all --check`,
  `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo test -p freshell-ws`, `cargo test -p freshell-protocol --locked`.
- Known pre-existing flake: `crates/freshell-ws` test binary
  `auto_resume_e2e` can fail under load — retry once
  (`cargo test -p freshell-ws --test auto_resume_e2e`); it is not a
  regression from this work.
- NodeNext/ESM: `server/**` and `scripts/**` relative imports need `.js`
  extensions. Client code under `src/` uses aliases (`@/` → `src/`,
  `@shared/` → `shared/`, `@test/` → `test/`) with no extension.
- `npm run lint` (eslint incl. jsx-a11y over `src/`) and
  `npm run typecheck` must pass (CI requirements). No visible UI is added by
  this plan.
- NEVER restart the live Rust server on port 3002 (requires the literal
  word "APPROVED" from the user; not needed for this work — e2e specs boot
  their own throwaway servers on ephemeral ports).
- Do NOT create a PR (handled outside this run). Commit locally per task
  with Conventional Commit subjects.
- README.md is the only end-user markdown doc; this plan under `docs/plans/`
  is a working/agent doc. Create no other markdown files.
- e2e runs (`npm run test:e2e -- ...`) are separate from `npm test` and not
  coordinator-gated; the rust e2e fixture builds/launches the Rust server,
  so `cargo` must be on PATH.

---

## Deliverable 2 precondition finding (investigated; drives Task 4)

The spec mandated verifying whether main's Rust server populates
`actual_session_ref` on the SESSION_IDENTITY_MISMATCH rejection path.
Finding (static analysis of `62fa0ff1`):

- **Main's Rust server has NO SESSION_IDENTITY_MISMATCH path at all.**
  `ErrorCode::SessionIdentityMismatch` is declared
  (`crates/freshell-protocol/src/common.rs:79`) and never constructed
  anywhere in `crates/`. All 9 `ErrorMsg` constructions hardcode
  `actual_session_ref: None`, and none carries that code.
- **Worse: the `ClientMessage::TerminalInput` arm
  (`crates/freshell-ws/src/terminal.rs:628-657`) parses
  `expected_session_ref` and ignores it** — a stale-ref input frame right
  after a rebind is silently delivered to the PTY. The Node reference
  implementation rejects it (`server/ws-handler.ts:2902-2925`) and populates
  `actualSessionRef` (`server/ws-handler.ts:939-966`).
- **The wire contract already carries the field end-to-end** — TS type
  (`shared/ws-protocol.ts:716`), JSON schema
  (`port/contract/ws-server-messages.schema.json` `error.actualSessionRef`),
  Rust struct (`crates/freshell-protocol/src/server_messages.rs:511`), and a
  serde roundtrip fixture already exercising `actualSessionRef`
  (`crates/freshell-protocol/tests/roundtrip.rs:214-222`). **Zero
  protocol/schema work is needed.**
- The canonical value Rust needs is available synchronously:
  `state.identity.session_ref_for(&terminal_id) -> Option<SessionLocator>`
  (`crates/freshell-ws/src/identity.rs:145`, already used at
  `terminal.rs:3673`).

**Resolution (per the spec's "ALSO populate it there" branch):** Deliverable
2 is NOT dropped. Task 4 adds the input-path identity guard to the Rust
server (Node parity, emitting SESSION_IDENTITY_MISMATCH with
`actual_session_ref: Some(..)` — the first non-`None` in the Rust tree), and
Task 5 ports the client suppression helper. One deliberate deviation from
Node: when the client sends an expectation but the identity registry has not
resolved yet (`(Some, None)`), the Rust guard **fails open** (delivers the
input) instead of bouncing — the codex/opencode locators resolve within a
~2s correlation window after spawn, and bouncing keystrokes during pane
startup would be a regression Node does not have an equivalent exposure to.
The suppression helper itself fails toward the visible path on any
absent/unparseable ref, as the spec requires.

Ordering constraint: the client suppression only fires when the rebind fold
has already synced `contentRef.current` (main does this synchronously on a
`'reconciled'` result, `TerminalView.tsx:~4288`), so Tasks 4–5 land after
the Deliverable-1 tasks.

## File structure (locked decomposition)

| File | Responsibility | Tasks |
|---|---|---|
| `src/store/persistControl.ts` | Modify: `buildTerminalDurableSessionRefUpdate` gains `tabSessionMetadataByKey` + re-key via existing `mergeSessionMetadataForPreferredResumeId` | 1 |
| `test/unit/client/store/persistControl.test.ts` | Modify: new re-key describe block | 1 |
| `src/lib/terminal-session-association.ts` | Modify: one-line caller wiring | 2 |
| `test/unit/client/lib/terminal-session-association.test.ts` | Modify: `createState` tab-overrides param, re-key fold test, idempotence regression guards | 2, 3 |
| `crates/freshell-ws/src/terminal.rs` | Modify: input-path identity guard + pure helpers + in-module tests | 4 |
| `crates/freshell-ws/tests/opencode_switch_rebind.rs` | Modify: new Phase 1b (stale-input bounce over the wire) | 4 |
| `crates/freshell-protocol/tests/roundtrip.rs` | Modify: SESSION_IDENTITY_MISMATCH fixture | 4 |
| `src/components/terminal-view-utils.ts` | Modify: add `isStaleSessionIdentityMismatch` | 5 |
| `test/unit/client/components/terminal-view-utils.session-mismatch.test.ts` | Create: pure helper tests | 5 |
| `src/components/TerminalView.tsx` | Modify: 4-line suppression early-return | 5 |
| `test/unit/client/components/TerminalView.codex-identity.test.tsx` | Modify: suppression wiring test | 5 |
| `crates/freshell-ws/src/opencode_signal.rs` | Modify: hello discrimination in the drain, hello tracker, heartbeat WARN + in-module tests | 6 |
| `extensions/opencode/freshell-rebind-plugin.ts` | Modify: `emitHello` at TUI startup | 7 |
| `test/unit/server/opencode-rebind-plugin.test.ts` | Modify: hello emission tests | 7 |
| `test/e2e-browser/specs/opencode-rebind-rust.spec.ts` | Create: signal-driven rebind browser e2e (rust-only) | 8 |
| `test/e2e-browser/playwright.config.ts` | Modify: register the rust-only spec in both lists | 8 |

Scope check: all five deliverables harden one subsystem (terminal session
rebind) and share test surfaces; one plan is correct. Deliverables 1–3 and 5
are independent; 4 (e2e) lands last so it exercises the finished stack.

---

### Task 1: Tab session-metadata re-key in `buildTerminalDurableSessionRefUpdate`

**Files:**
- Modify: `src/store/persistControl.ts:13-67` (`buildTerminalDurableSessionRefUpdate`)
- Test: `test/unit/client/store/persistControl.test.ts`

**Interfaces:**
- Consumes: `mergeSessionMetadataForPreferredResumeId` (same file, `:121-205`,
  unchanged) and `SessionListMetadata` (already imported at the top of
  `persistControl.ts` — no import change needed).
- Produces: `buildTerminalDurableSessionRefUpdate` accepts a NEW optional
  param `tabSessionMetadataByKey?: Record<string, SessionListMetadata>`;
  when re-keying occurs, the returned `tabUpdates` carries
  `sessionMetadataByKey: Record<string, SessionListMetadata>`. Task 2's
  caller passes `tab.sessionMetadataByKey` into it. All existing params and
  the return shape are unchanged; `shouldFlush` semantics are unchanged (a
  metadata-only change yields `shouldFlush: false` from this function — the
  Task-2 caller force-flushes on non-empty `tabUpdates`).

Background: the fresh-agent path (`buildFreshAgentPersistedIdentityUpdate`,
same file `:207-284`) already re-keys metadata with exactly this idiom; this
task copies that idiom into the terminal path, as the salvage branch did
(`git diff main..salvage/opencode-rebind-on-drift -- src/store/persistControl.ts`).

- [ ] **Step 1: Write the failing tests**

Append a new top-level describe block at the end of
`test/unit/client/store/persistControl.test.ts`, and add
`buildTerminalDurableSessionRefUpdate` to the existing
`@/store/persistControl` import list:

```ts
import {
  buildTerminalDurableSessionRefUpdate,
  flushPersistedLayoutNow,
  getCanonicalDurableSessionId,
  getPreferredResumeSessionId,
} from '@/store/persistControl'
```

```ts
describe('buildTerminalDurableSessionRefUpdate metadata re-key', () => {
  it('moves sessionMetadataByKey from the old session key to the new one on rebind', () => {
    const update = buildTerminalDurableSessionRefUpdate({
      provider: 'opencode',
      sessionId: 'ses_new',
      paneSessionRef: { provider: 'opencode', sessionId: 'ses_old' },
      tabSessionRef: { provider: 'opencode', sessionId: 'ses_old' },
      paneResumeSessionId: undefined,
      tabResumeSessionId: undefined,
      tabSessionMetadataByKey: {
        'opencode:ses_old': { sessionType: 'opencode', firstUserMessage: 'hello world' },
      },
    })
    expect(update?.tabUpdates?.sessionMetadataByKey).toBeDefined()
    expect(update!.tabUpdates!.sessionMetadataByKey!['opencode:ses_new']).toMatchObject({ firstUserMessage: 'hello world' })
    expect(update!.tabUpdates!.sessionMetadataByKey!['opencode:ses_old']).toBeUndefined()
  })

  it('returns null when nothing needs re-keying (metadata already under the new key)', () => {
    const update = buildTerminalDurableSessionRefUpdate({
      provider: 'opencode',
      sessionId: 'ses_new',
      paneSessionRef: { provider: 'opencode', sessionId: 'ses_new' },
      tabSessionRef: { provider: 'opencode', sessionId: 'ses_new' },
      paneResumeSessionId: undefined,
      tabResumeSessionId: undefined,
      tabSessionMetadataByKey: {
        'opencode:ses_new': { sessionType: 'opencode' },
      },
    })
    expect(update).toBeNull()
  })

  it('does not add a sessionMetadataByKey update when the metadata map is absent or empty', () => {
    for (const tabSessionMetadataByKey of [undefined, {}]) {
      const update = buildTerminalDurableSessionRefUpdate({
        provider: 'opencode',
        sessionId: 'ses_new',
        paneSessionRef: { provider: 'opencode', sessionId: 'ses_old' },
        tabSessionRef: { provider: 'opencode', sessionId: 'ses_old' },
        paneResumeSessionId: undefined,
        tabResumeSessionId: undefined,
        tabSessionMetadataByKey,
      })
      expect(update?.tabUpdates?.sessionRef).toEqual({ provider: 'opencode', sessionId: 'ses_new' })
      expect(update?.tabUpdates !== undefined && 'sessionMetadataByKey' in update.tabUpdates).toBe(false)
    }
  })
})
```

(Note: the salvage branch's second test used a weak optional-chain
assertion; the `expect(update).toBeNull()` above is the strengthened form —
with pane and tab already on `ses_new`, no resume ids, and metadata
unchanged, the function's final guard returns `null`.)

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npm run test:vitest -- test/unit/client/store/persistControl.test.ts --run
```
Expected: FAIL — first test fails with `tabSessionMetadataByKey` being an
excess/unknown property (TS) or `update.tabUpdates.sessionMetadataByKey`
undefined at runtime. The other two may pass incidentally; the first MUST
fail. (Typecheck failures on the unknown param count as the right reason.)

- [ ] **Step 3: Implement the re-key**

In `src/store/persistControl.ts`, replace the whole
`buildTerminalDurableSessionRefUpdate` function (currently lines 13-67) with:

```ts
export function buildTerminalDurableSessionRefUpdate({
  provider,
  sessionId,
  paneSessionRef,
  tabSessionRef,
  paneResumeSessionId,
  tabResumeSessionId,
  tabSessionMetadataByKey,
}: {
  provider?: CodingCliProviderName
  sessionId?: string
  paneSessionRef?: SessionRef
  tabSessionRef?: SessionRef
  paneResumeSessionId?: string
  tabResumeSessionId?: string
  tabSessionMetadataByKey?: Record<string, SessionListMetadata>
}): {
  paneUpdates?: { sessionRef?: SessionRef; resumeSessionId?: undefined }
  tabUpdates?: Partial<Tab>
  shouldFlush: boolean
} | null {
  const sessionRef = provider && sessionId
    ? sanitizeSessionRef({ provider, sessionId })
    : undefined
  if (!sessionRef) return null

  const paneNeedsSessionRef = !sessionRefEquals(paneSessionRef, sessionRef)
  const tabNeedsSessionRef = !sessionRefEquals(tabSessionRef, sessionRef)
  const paneNeedsResumeClear = typeof paneResumeSessionId === 'string'
  const tabNeedsResumeClear = typeof tabResumeSessionId === 'string'

  const paneUpdates = paneNeedsSessionRef || paneNeedsResumeClear
    ? {
        ...(paneNeedsSessionRef ? { sessionRef } : {}),
        ...(paneNeedsResumeClear ? { resumeSessionId: undefined } : {}),
      }
    : undefined

  const nextTabUpdates: Partial<Tab> = {
    ...(tabNeedsSessionRef ? { sessionRef } : {}),
    ...(tabNeedsResumeClear ? { resumeSessionId: undefined } : {}),
  }

  // Rebind metadata re-key (same idiom as buildFreshAgentPersistedIdentityUpdate
  // below): merge whatever the tab knew under the superseded id(s) into the
  // `${provider}:${sessionId}` key of the new canonical id, deleting the old
  // keys. The merge helper ALWAYS returns a fresh object, so deep-compare
  // before writing to avoid churn updates on every broadcast.
  const nextSessionMetadataByKey = mergeSessionMetadataForPreferredResumeId({
    localSessionMetadataByKey: tabSessionMetadataByKey,
    remoteSessionMetadataByKey: tabSessionMetadataByKey,
    existingSessionMetadataByKey: tabSessionMetadataByKey,
    provider,
    localResumeSessionId: tabSessionRef?.sessionId ?? tabResumeSessionId,
    remoteResumeSessionId: paneSessionRef?.sessionId ?? paneResumeSessionId,
    preferredResumeSessionId: sessionRef.sessionId,
  })

  if (JSON.stringify(nextSessionMetadataByKey ?? {}) !== JSON.stringify(tabSessionMetadataByKey ?? {})) {
    nextTabUpdates.sessionMetadataByKey = nextSessionMetadataByKey
  }

  const tabUpdates = Object.keys(nextTabUpdates).length > 0 ? nextTabUpdates : undefined

  const shouldFlush = paneNeedsSessionRef || tabNeedsSessionRef || paneNeedsResumeClear || tabNeedsResumeClear

  if (!paneUpdates && !tabUpdates && !shouldFlush) {
    return null
  }

  return {
    paneUpdates,
    tabUpdates,
    shouldFlush,
  }
}
```

No import changes: `SessionListMetadata` is already imported, and
`mergeSessionMetadataForPreferredResumeId` is defined later in the same file
(function hoisting makes the forward reference legal — this matches how the
fresh-agent path already uses it).

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npm run test:vitest -- test/unit/client/store/persistControl.test.ts --run
```
Expected: PASS (all tests in the file, including the pre-existing ones).

- [ ] **Step 5: Refactor check**

Re-read the modified function against
`buildFreshAgentPersistedIdentityUpdate` — the two re-key idioms should now
be visibly parallel. Do not extract a shared helper (the fresh-agent path
carries extra `restoreError`/`codingCliProvider`/`sessionType` concerns;
forcing them together would obscure both). Run:
```bash
npm run typecheck && npm run lint
```
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/store/persistControl.ts test/unit/client/store/persistControl.test.ts
git commit -m "feat(client): re-key tab session metadata to the new id in buildTerminalDurableSessionRefUpdate"
```

---

### Task 2: Caller wiring — pass `tab.sessionMetadataByKey` through the rebind fold

**Files:**
- Modify: `src/lib/terminal-session-association.ts:~130` (the
  `buildTerminalDurableSessionRefUpdate` call site)
- Test: `test/unit/client/lib/terminal-session-association.test.ts`

**Interfaces:**
- Consumes: Task 1's `tabSessionMetadataByKey` param.
- Produces: after an accepted rebind broadcast, the dispatched
  `updateTab({ id, updates })` payload carries the re-keyed
  `sessionMetadataByKey`, and (because the caller already forces
  `shouldFlush = true` on any non-empty `tabUpdates`)
  `flushPersistedLayoutNow()` is dispatched. Also produces the test
  fixture change other tasks rely on: `createState(content, tabOverrides)`
  (Task 3 uses `tabOverrides`).

- [ ] **Step 1: Extend the test fixture and write the failing test**

In `test/unit/client/lib/terminal-session-association.test.ts`:

1. Add `updateTab` to the imports:

```ts
import { describe, expect, it, vi } from 'vitest'
import { reconcileTerminalSessionAssociation } from '@/lib/terminal-session-association'
import { reconcileTerminalSessionRefByTerminalId } from '@/store/panesSlice'
import { flushPersistedLayoutNow } from '@/store/persistControl'
import { updateTab } from '@/store/tabsSlice'
```

2. Give `createState` a tab-overrides param (existing callers are
   unaffected — the default is `{}`):

```ts
function createState(content: Record<string, unknown>, tabOverrides: Record<string, unknown> = {}) {
  return {
    panes: {
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content,
        },
      },
    },
    tabs: {
      tabs: [{
        id: 'tab-1',
        title: 'Tab 1',
        status: 'running',
        ...tabOverrides,
      }],
    },
  } as any
}
```

3. Append this test inside the existing
   `describe('server-authoritative rebind (previousSessionId)')` block:

```ts
  it('re-keys tab session metadata from the superseded id to the new id on rebind', () => {
    const dispatched: any[] = []
    const dispatch = vi.fn((action) => dispatched.push(action))
    const getState = () => createState(
      {
        kind: 'terminal',
        terminalId: 'term-1',
        createRequestId: 'req-1',
        status: 'running',
        mode: 'opencode',
        shell: 'system',
        sessionRef: { provider: 'opencode', sessionId: 'ses_old' },
      },
      {
        sessionRef: { provider: 'opencode', sessionId: 'ses_old' },
        sessionMetadataByKey: {
          'opencode:ses_old': { sessionType: 'opencode', firstUserMessage: 'hello world' },
        },
      },
    )
    const result = reconcileTerminalSessionAssociation({
      dispatch,
      getState,
      terminalId: 'term-1',
      sessionRef: { provider: 'opencode', sessionId: 'ses_new' },
      previousSessionId: 'ses_old',
    })
    expect(result).toBe('reconciled')
    const tabUpdate = dispatched.find((action) => action.type === updateTab.type)
    expect(tabUpdate).toBeDefined()
    expect(tabUpdate.payload.updates.sessionMetadataByKey).toEqual({
      'opencode:ses_new': { sessionType: 'opencode', firstUserMessage: 'hello world' },
    })
    expect(dispatched.map((action) => action.type)).toContain(flushPersistedLayoutNow.type)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npm run test:vitest -- test/unit/client/lib/terminal-session-association.test.ts --run -t "re-keys tab session metadata"
```
Expected: FAIL — `tabUpdate.payload.updates.sessionMetadataByKey` is
`undefined` (the caller does not pass the metadata map yet). All
pre-existing tests in the file must still pass:
```bash
npm run test:vitest -- test/unit/client/lib/terminal-session-association.test.ts --run
```

- [ ] **Step 3: Wire the caller (one line)**

In `src/lib/terminal-session-association.ts`, at the
`buildTerminalDurableSessionRefUpdate` call (~line 121-128), add the final
argument line:

```ts
    const durableIdentityUpdate = buildTerminalDurableSessionRefUpdate({
      provider: sessionRef.provider as CodingCliProviderName,
      sessionId: sessionRef.sessionId,
      paneSessionRef: content.sessionRef,
      tabSessionRef: tab.sessionRef,
      paneResumeSessionId: content.resumeSessionId,
      tabResumeSessionId: tab.resumeSessionId,
      tabSessionMetadataByKey: tab.sessionMetadataByKey,
    })
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npm run test:vitest -- test/unit/client/lib/terminal-session-association.test.ts test/unit/client/store/persistControl.test.ts --run
```
Expected: PASS (all).

- [ ] **Step 5: Guard against collateral damage in adjacent suites**

The fold participates in cross-tab sync and App-level handling; run the
neighboring suites:
```bash
npm run test:vitest -- test/unit/client/store/crossTabSync.test.ts --run
npm run typecheck && npm run lint
```
Expected: PASS / clean. (Do NOT port the salvage branch's
`crossTabSync.test.ts` rewrite — it is a cosmetic rename with zero
behavioral delta.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/terminal-session-association.ts test/unit/client/lib/terminal-session-association.test.ts
git commit -m "feat(client): carry tab session metadata through the terminal rebind fold"
```

Known accepted limitation (do not "fix" silently): tab-side updates —
including this re-key — only fire for single-pane tabs
(`isSinglePaneTerminalMatch`). That is main's existing invariant for ALL
tab-side rebind state, not a regression introduced here.

---

### Task 3: Duplicate-rebind idempotence regression guards (tests only)

**Files:**
- Test: `test/unit/client/lib/terminal-session-association.test.ts`
- Modify (ONLY if the second test genuinely fails):
  `src/lib/terminal-session-association.ts`

**Interfaces:**
- Consumes: Task 2's `createState(content, tabOverrides)` fixture and
  main's `previousSessionId` API. Do NOT copy the salvage branch's
  `allowRebind: true` test API.
- Produces: regression coverage for the repeat-broadcast path. No exported
  surface changes.

Expectation setting (from static analysis of the fold): both tests are
expected to PASS on main as written — they are characterization guards for
a path main never tested. The load-bearing fixture detail is the tab
override: after the first rebind's flush the persisted tab also carries the
new ref, and only a tab whose `sessionRef` already matches suppresses the
tab-side flush (`buildTerminalDurableSessionRefUpdate`'s
`tabNeedsSessionRef`). A fixture without it observes a flush that is a
fixture artifact, not a bug.

- [ ] **Step 1: Write the two tests**

Append a new top-level describe block at the end of
`test/unit/client/lib/terminal-session-association.test.ts`:

```ts
describe('duplicate rebind broadcasts (idempotence regression guards)', () => {
  const boundPane = {
    kind: 'terminal' as const,
    terminalId: 'term-1',
    createRequestId: 'req-1',
    status: 'running' as const,
    mode: 'opencode' as const,
    shell: 'system' as const,
    sessionRef: { provider: 'opencode', sessionId: 'ses_old' },
  }

  it('a stale repeat whose previousSessionId no longer matches the pane current ref dispatches nothing', () => {
    // The pane has already moved on to ses_new2; an old rebind broadcast
    // (ses_old -> ses_new) arrives late. The supersession handshake must
    // veto it: previousSessionId (ses_old) is not the pane's current ref.
    const dispatched: any[] = []
    const dispatch = vi.fn((action) => dispatched.push(action))
    const result = reconcileTerminalSessionAssociation({
      dispatch,
      getState: () => createState(
        { ...boundPane, sessionRef: { provider: 'opencode', sessionId: 'ses_new2' } },
        { sessionRef: { provider: 'opencode', sessionId: 'ses_new2' } },
      ),
      terminalId: 'term-1',
      sessionRef: { provider: 'opencode', sessionId: 'ses_new' },
      previousSessionId: 'ses_old',
    })
    expect(result).toBe('conflict')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('an identical repeat neither re-dispatches updateTab nor flushes the persisted layout again', () => {
    // Post-first-rebind state: pane AND tab already carry ses_new. The tab
    // override is REQUIRED: after the first rebind's flush, the persisted
    // tab also carries the new ref -- and only a tab whose sessionRef
    // already matches suppresses the tab-side flush
    // (buildTerminalDurableSessionRefUpdate's tabNeedsSessionRef).
    const dispatched: any[] = []
    const dispatch = vi.fn((action) => dispatched.push(action))
    const result = reconcileTerminalSessionAssociation({
      dispatch,
      getState: () => createState(
        { ...boundPane, sessionRef: { provider: 'opencode', sessionId: 'ses_new' } },
        { sessionRef: { provider: 'opencode', sessionId: 'ses_new' } },
      ),
      terminalId: 'term-1',
      sessionRef: { provider: 'opencode', sessionId: 'ses_new' },
      previousSessionId: 'ses_old',
    })
    expect(result).toBe('reconciled')
    const types = dispatched.map((action) => action.type)
    expect(types).not.toContain(flushPersistedLayoutNow.type)
    expect(types).not.toContain(updateTab.type)
  })
})
```

- [ ] **Step 2: Run and interpret honestly**

Run:
```bash
npm run test:vitest -- test/unit/client/lib/terminal-session-association.test.ts --run
```

- Expected: PASS (both). These are then committed as regression guards —
  the spec explicitly frames this deliverable as "tests only" unless a real
  bug surfaces.
- If the SECOND test FAILS with `flushPersistedLayoutNow` (or `updateTab`)
  in the dispatched types, that is a real double-flush bug. Diagnose which
  gate leaked: log the `updateTab` payload — if it contains
  `sessionMetadataByKey`, Task 1's JSON deep-compare guard regressed (fix
  there: the compare must run against `tabSessionMetadataByKey ?? {}` on
  both sides exactly as written in Task 1 Step 3); if it contains
  `sessionRef`, the state fixture is missing the tab override (fixture bug,
  fix the test); if `flushPersistedLayoutNow` fires with an EMPTY
  dispatched `updateTab` absent, the leak is
  `terminalPaneNeedsDurableIdentityUpdate` — fix minimally in
  `src/lib/terminal-session-association.ts` by making the leaking predicate
  arm value-guarded, and keep the fix to the single predicate. Re-run until
  green, and note the fix in the commit message.

- [ ] **Step 3: Commit**

```bash
git add test/unit/client/lib/terminal-session-association.test.ts
git commit -m "test(client): duplicate-rebind idempotence regression guards for the association fold"
```
(If Step 2 required a fold fix, also `git add src/lib/terminal-session-association.ts`
and use subject `fix(client): make the rebind fold idempotent on repeat broadcasts`.)

---

### Task 4: Rust input-path identity guard emitting SESSION_IDENTITY_MISMATCH with `actual_session_ref`

**Files:**
- Modify: `crates/freshell-ws/src/terminal.rs` — the
  `ClientMessage::TerminalInput` arm (currently `:628-657`) + two new pure
  helpers + a new in-module test mod
- Modify: `crates/freshell-ws/tests/opencode_switch_rebind.rs` — new
  "Phase 1b" after Phase 1
- Modify: `crates/freshell-protocol/tests/roundtrip.rs` — add a
  SESSION_IDENTITY_MISMATCH error fixture

**Interfaces:**
- Consumes: `state.identity.session_ref_for(&terminal_id) -> Option<SessionLocator>`
  (`crates/freshell-ws/src/identity.rs:145`); `ErrorMsg` / `ErrorCode::SessionIdentityMismatch`
  / `SessionLocator` from `freshell-protocol` (all existing); the arm's
  existing `send(ws_tx, &msg).await` helper (see the adjacent
  `unknown_terminal_input_blocked` bounce in the same arm for the exact
  send-and-return shape).
- Produces: on a `terminal.input` frame whose `expected_session_ref` is
  `Some` AND the terminal's canonical identity is `Some` AND they differ,
  the server sends
  `error{code: SESSION_IDENTITY_MISMATCH, terminalId, expectedSessionRef, actualSessionRef: Some(canonical)}`
  and does NOT write to the PTY. `(None, _)` and `(Some, None)` deliver as
  before (fail-open — see the precondition finding above). Task 5's client
  suppression consumes the `actualSessionRef` echo. Wire message string
  matches Node: `"Terminal session does not match the expected session."`.

- [ ] **Step 1: Write the failing unit tests**

In `crates/freshell-ws/src/terminal.rs`, next to the existing
`mod attach_geometry_tests` (`:4866`), add:

```rust
#[cfg(test)]
mod input_identity_tests {
    use super::{input_session_identity_mismatch_error, input_session_identity_ok};
    use freshell_protocol::SessionLocator;

    fn locator(provider: &str, session_id: &str) -> SessionLocator {
        SessionLocator {
            provider: provider.to_string(),
            session_id: session_id.to_string(),
        }
    }

    #[test]
    fn no_expectation_always_ok() {
        assert!(input_session_identity_ok(None, None));
        assert!(input_session_identity_ok(None, Some(&locator("opencode", "ses_a"))));
    }

    #[test]
    fn unresolved_identity_fails_open() {
        // Deliberately laxer than attach_geometry_identity_ok: during the
        // codex/opencode locator correlation window (~2s) canonical identity
        // is None while a restored client already sends an expectation.
        // Never drop keystrokes at pane startup.
        assert!(input_session_identity_ok(
            Some(&locator("opencode", "ses_a")),
            None
        ));
    }

    #[test]
    fn matching_expectation_ok() {
        assert!(input_session_identity_ok(
            Some(&locator("opencode", "ses_a")),
            Some(&locator("opencode", "ses_a"))
        ));
    }

    #[test]
    fn differing_expectation_is_a_mismatch() {
        assert!(!input_session_identity_ok(
            Some(&locator("opencode", "ses_a")),
            Some(&locator("opencode", "ses_b"))
        ));
    }

    #[test]
    fn mismatch_error_serializes_with_actual_session_ref() {
        let msg = input_session_identity_mismatch_error(
            "term-1",
            locator("opencode", "ses_a"),
            Some(locator("opencode", "ses_b")),
        );
        let value = serde_json::to_value(&msg).expect("serialize");
        assert_eq!(value["type"], "error");
        assert_eq!(value["code"], "SESSION_IDENTITY_MISMATCH");
        assert_eq!(value["terminalId"], "term-1");
        assert_eq!(value["expectedSessionRef"]["sessionId"], "ses_a");
        assert_eq!(value["actualSessionRef"]["sessionId"], "ses_b");
        assert_eq!(
            value["message"],
            "Terminal session does not match the expected session."
        );
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run:
```bash
cargo test -p freshell-ws input_identity_tests
```
Expected: COMPILE FAILURE — `input_session_identity_ok` and
`input_session_identity_mismatch_error` do not exist yet. That is the
correct RED for new pure functions.

- [ ] **Step 3: Implement the pure helpers**

In `crates/freshell-ws/src/terminal.rs`, next to
`attach_geometry_identity_ok` (`:3597` region), add:

```rust
/// Input-path identity guard (Node parity: `server/ws-handler.ts:2902-2925`
/// `inputIfSessionMatches`). Deliberately LAXER than
/// `attach_geometry_identity_ok` in the `(Some, None)` case: during the
/// codex/opencode locator correlation window the client may already hold a
/// restored sessionRef while the identity registry has not resolved yet --
/// attach's silent resize-skip is harmless there, a dropped keystroke is
/// not, so unresolved identity FAILS OPEN and the input is delivered.
fn input_session_identity_ok(
    expected: Option<&SessionLocator>,
    canonical: Option<&SessionLocator>,
) -> bool {
    match (expected, canonical) {
        (None, _) => true,
        (Some(_), None) => true,
        (Some(e), Some(c)) => e == c,
    }
}

/// The bounce frame for a stale-expectation `terminal.input`: the FIRST
/// `actual_session_ref: Some(..)` emitter in the Rust tree. The client's
/// stale-window suppression (terminal-view-utils.ts
/// isStaleSessionIdentityMismatch) keys on that echo, so it must carry the
/// canonical ref whenever one exists (and the guard only fires when it does).
fn input_session_identity_mismatch_error(
    terminal_id: &str,
    expected: SessionLocator,
    actual: Option<SessionLocator>,
) -> ServerMessage {
    ServerMessage::Error(ErrorMsg {
        code: ErrorCode::SessionIdentityMismatch,
        message: "Terminal session does not match the expected session.".to_string(),
        timestamp: crate::now_iso(),
        actual_session_ref: actual,
        expected_session_ref: Some(expected),
        request_id: None,
        retry_after_ms: None,
        terminal_exit_code: None,
        terminal_id: Some(terminal_id.to_string()),
    })
}
```

(Match the surrounding file's existing imports — `ErrorMsg`, `ErrorCode`,
`ServerMessage`, `SessionLocator` are already in scope in this file; if any
is missing at this location, extend the existing `use freshell_protocol::…`
line rather than adding a new one.)

Run:
```bash
cargo test -p freshell-ws input_identity_tests
```
Expected: PASS (5 tests).

- [ ] **Step 4: Wire the guard into the TerminalInput arm and add the wire-level integration proof (RED first)**

4a. Add "Phase 1b" to
`crates/freshell-ws/tests/opencode_switch_rebind.rs`, immediately after
Phase 1's final assertion (registry resume follows the rebind, ~line 469)
and before Phase 2. Phase 1 has just rebound terminal `tid1` from session
`A` to session `B`, so its canonical identity is `B`:

```rust
    // ────── Phase 1b — stale-expectation input bounce (Node parity,
    // server/ws-handler.ts:2902-2925): an in-flight terminal.input still
    // carrying the OLD ref A after the A→B rebind is bounced with
    // SESSION_IDENTITY_MISMATCH echoing actualSessionRef=B and is NOT
    // delivered; a frame carrying the NEW ref B is delivered with no error.
    send_json(
        &mut ws,
        json!({
            "type": "terminal.input",
            "terminalId": tid1,
            "data": "stale-ref-keystroke",
            "expectedSessionRef": { "provider": "opencode", "sessionId": A },
        }),
    )
    .await;
    let bounce = wait_for_frame(&mut ws, "phase1b/mismatch", |v| {
        v["type"] == "error"
            && v["code"] == "SESSION_IDENTITY_MISMATCH"
            && v["terminalId"] == json!(tid1)
    })
    .await;
    assert_eq!(
        bounce["actualSessionRef"],
        json!({ "provider": "opencode", "sessionId": B }),
        "bounce must echo the canonical (post-rebind) ref: {bounce}"
    );
    assert_eq!(
        bounce["expectedSessionRef"],
        json!({ "provider": "opencode", "sessionId": A }),
        "bounce must echo the stale expectation: {bounce}"
    );

    send_json(
        &mut ws,
        json!({
            "type": "terminal.input",
            "terminalId": tid1,
            "data": "fresh-ref-keystroke\r",
            "expectedSessionRef": { "provider": "opencode", "sessionId": B },
        }),
    )
    .await;
    let bounced_again = frame_seen_within(&mut ws, Duration::from_secs(1), |v| {
        v["type"] == "error" && v["code"] == "SESSION_IDENTITY_MISMATCH"
    })
    .await;
    assert!(
        !bounced_again,
        "a matching expectedSessionRef must be delivered, not bounced"
    );
```

Adaptation notes (do these against the file as it exists — its helpers are
private to the file):
- `frame_seen_within` already exists in this file; reuse it.
- For `send_json` and `wait_for_frame`: FIRST check how this file's
  existing helpers (`send_create`, `next_associated_frame` at ~`:232-256`)
  send/receive frames, and reuse or generalize them. If no generic
  raw-send/raw-wait helpers exist, add these two next to
  `write_opencode_signal`, matching the ws client type used by
  `send_create` (same crate-internal test idiom):

```rust
async fn send_json(ws: &mut WsClient, value: serde_json::Value) {
    // Mirror EXACTLY how send_create transmits its frame (same sink type,
    // same Message::Text construction) -- generalized to any payload.
}

async fn wait_for_frame(
    ws: &mut WsClient,
    label: &str,
    pred: impl Fn(&serde_json::Value) -> bool,
) -> serde_json::Value {
    // Mirror next_associated_frame's deadline-poll loop (10s budget),
    // generalized to an arbitrary predicate; panic with `label` on timeout.
}
```

(`WsClient` here stands for whatever concrete ws type `send_create` takes in
this file — use that exact type.)

4b. Run to verify RED:
```bash
cargo test -p freshell-ws --test opencode_switch_rebind
```
Expected: FAIL at `phase1b/mismatch` timeout — the server currently ignores
`expectedSessionRef` on input, so no error frame ever arrives. If instead
Phase 1b fails on the `actualSessionRef` assertion AFTER Step 4c, the
identity registry did not follow the rebind — investigate
`state.identity.session_ref_for(&tid1)` at that point before proceeding
(the rebind lane is expected to update it; Phase 1's registry assertion
covers the meta registry, this covers the identity registry).

4c. GREEN — wire the guard. In the `ClientMessage::TerminalInput` arm
(`crates/freshell-ws/src/terminal.rs:628`), insert the guard as the FIRST
statement of the arm (before `codex_association::note_possible_submit` —
a bounced frame must not arm the codex first-submit lane either):

```rust
        ClientMessage::TerminalInput(input) => {
            // Node parity (server/ws-handler.ts:2902-2925): a terminal.input
            // frame whose expectedSessionRef no longer matches the terminal's
            // canonical identity is bounced with SESSION_IDENTITY_MISMATCH
            // (actualSessionRef populated) instead of being written to a PTY
            // the client no longer means. Unresolved identity fails open --
            // see input_session_identity_ok.
            if let Some(expected) = input.expected_session_ref.as_ref() {
                let canonical = state.identity.session_ref_for(&input.terminal_id);
                if !input_session_identity_ok(Some(expected), canonical.as_ref()) {
                    return send(
                        ws_tx,
                        &input_session_identity_mismatch_error(
                            &input.terminal_id,
                            expected.clone(),
                            canonical,
                        ),
                    )
                    .await;
                }
            }
            // ...existing arm body unchanged (note_possible_submit,
            // registry.input, unknown_terminal_input_blocked, opencode
            // note_possible_submit, `true`)...
        }
```

(Follow the arm's existing bounce for the exact `return send(...).await`
shape — the `unknown_terminal_input_blocked` path a few lines below does
exactly this.)

- [ ] **Step 5: Run the integration test to verify it passes**

```bash
cargo test -p freshell-ws --test opencode_switch_rebind
cargo test -p freshell-ws input_identity_tests
```
Expected: PASS. Then guard against collateral regressions in the
suites that exercise input/attach/restore paths:
```bash
cargo test -p freshell-ws
```
Expected: PASS (retry `--test auto_resume_e2e` once if it flakes — known,
pre-existing).

- [ ] **Step 6: Extend the protocol roundtrip fixture**

In `crates/freshell-protocol/tests/roundtrip.rs`, find the error-message
fixture block (~lines 214-222, which already roundtrips an error carrying
`actualSessionRef`) and add a sibling fixture that pins the
SESSION_IDENTITY_MISMATCH code together with a populated `actualSessionRef`
— copy the adjacent entry's exact structure, changing only
`"code": "SESSION_IDENTITY_MISMATCH"` and the two session refs (e.g.
expected `ses_a` / actual `ses_b`). Run:
```bash
cargo test -p freshell-protocol --locked
```
Expected: PASS.

- [ ] **Step 7: Rust hygiene + commit**

```bash
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
git add crates/freshell-ws/src/terminal.rs crates/freshell-ws/tests/opencode_switch_rebind.rs crates/freshell-protocol/tests/roundtrip.rs
git commit -m "feat(ws): bounce stale-identity terminal.input with SESSION_IDENTITY_MISMATCH carrying actualSessionRef"
```

---

### Task 5: Client suppression of stale identity-mismatch bounces

**Files:**
- Modify: `src/components/terminal-view-utils.ts` (add import + private
  helper + exported `isStaleSessionIdentityMismatch`)
- Create: `test/unit/client/components/terminal-view-utils.session-mismatch.test.ts`
- Modify: `src/components/TerminalView.tsx` (import + 4-line early return
  at `:~4352`)
- Modify: `test/unit/client/components/TerminalView.codex-identity.test.tsx`
  (one wiring test)

**Interfaces:**
- Consumes: `msg.actualSessionRef` on the error frame (already on the TS
  type, `shared/ws-protocol.ts:716`; populated by Task 4's server change);
  `sanitizeSessionRef` from `@shared/session-contract`;
  `contentRef.current?.sessionRef` inside the TerminalView handler.
- Produces:
  `export function isStaleSessionIdentityMismatch(currentSessionRef: unknown, actualSessionRef: unknown): boolean`
  in `src/components/terminal-view-utils.ts` — returns `true` (suppress)
  iff BOTH refs sanitize to full `{provider, sessionId}` refs AND they are
  equal; any absent/partial/unparseable ref returns `false` (fail toward
  the visible path).

- [ ] **Step 1: Create the failing pure-helper test file**

Create
`test/unit/client/components/terminal-view-utils.session-mismatch.test.ts`
(ported verbatim from the salvage branch):

```ts
import { describe, it, expect } from 'vitest'
import { isStaleSessionIdentityMismatch } from '@/components/terminal-view-utils'

describe('isStaleSessionIdentityMismatch (rebind swap-window suppression)', () => {
  const sesB = { provider: 'opencode', sessionId: 'ses_B' }

  it('suppresses when actualSessionRef matches the pane current ref (fold already applied; stale bounce)', () => {
    expect(isStaleSessionIdentityMismatch(sesB, { provider: 'opencode', sessionId: 'ses_B' })).toBe(true)
  })

  it('does not suppress when actualSessionRef differs from the current ref (a REAL mismatch)', () => {
    expect(isStaleSessionIdentityMismatch(sesB, { provider: 'opencode', sessionId: 'ses_A' })).toBe(false)
    expect(isStaleSessionIdentityMismatch({ provider: 'opencode', sessionId: 'ses_A' }, sesB)).toBe(false)
  })

  it('does not suppress when either ref is absent or unparseable (fail toward the visible path)', () => {
    expect(isStaleSessionIdentityMismatch(sesB, undefined)).toBe(false)
    expect(isStaleSessionIdentityMismatch(undefined, sesB)).toBe(false)
    expect(isStaleSessionIdentityMismatch(sesB, { provider: 'opencode' })).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm run test:vitest -- test/unit/client/components/terminal-view-utils.session-mismatch.test.ts --run
```
Expected: FAIL — `isStaleSessionIdentityMismatch` is not exported.

- [ ] **Step 3: Implement the helper**

In `src/components/terminal-view-utils.ts`:

1. Add as line 2 (after the existing type import):
```ts
import { sanitizeSessionRef } from '@shared/session-contract'
```

2. Append at the end of the file:
```ts
function sessionRefsEqual(
  left?: { provider?: string; sessionId?: string },
  right?: { provider?: string; sessionId?: string },
): boolean {
  return left?.provider === right?.provider && left?.sessionId === right?.sessionId
}

/** The rebind swap window (~1 WS RTT) can bounce in-flight input sent with
 *  the OLD ref. When the server's error echoes an actualSessionRef that
 *  already equals the pane's CURRENT sessionRef, the rebind fold has
 *  applied and this is a stale-window bounce: suppress it silently (no
 *  notice, no repair). Unparseable/absent refs fail toward the visible path. */
export function isStaleSessionIdentityMismatch(
  currentSessionRef: unknown,
  actualSessionRef: unknown,
): boolean {
  const current = sanitizeSessionRef(currentSessionRef)
  const actual = sanitizeSessionRef(actualSessionRef)
  if (!current || !actual) return false
  return sessionRefsEqual(current, actual)
}
```

(Known, ACCEPTED redundancy: `sessionRefsEqual` duplicates a private helper
in `TerminalView.tsx:281`; keeping the util module free of a React-file
import is deliberate — do not DRY it into a circular import.)

Run the Step-2 command again. Expected: PASS (3 tests).

- [ ] **Step 4: Write the failing wiring test**

In `test/unit/client/components/TerminalView.codex-identity.test.tsx`, next
to the existing test
`'repairs stale runtime plumbing on SESSION_IDENTITY_MISMATCH and reissues a restore create'`
(~`:306`), add (reusing that file's `createStore`, `TerminalViewFromStore`,
`wsHarness`, `sentMessages`, `findLeaf` helpers exactly as the existing
test does):

```tsx
  it('suppresses the mismatch repair path when actualSessionRef already equals the pane current ref (stale rebind-window bounce)', async () => {
    const store = createStore({
      kind: 'terminal',
      createRequestId: 'req-old',
      status: 'running',
      mode: 'codex',
      shell: 'system',
      terminalId: 'term-old',
      serverInstanceId: 'srv-old',
      streamId: 'stream-old',
      sessionRef: {
        provider: 'codex',
        sessionId: 'thread-new',
      },
      codexDurability: {
        schemaVersion: 1,
        state: 'durable',
        durableThreadId: 'thread-new',
      },
    })

    render(
      <Provider store={store}>
        <TerminalViewFromStore tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(sentMessages().some((msg) => msg?.type === 'terminal.attach' && msg.terminalId === 'term-old')).toBe(true)
    })

    wsHarness.send.mockClear()

    act(() => {
      wsHarness.emit({
        type: 'error',
        code: 'SESSION_IDENTITY_MISMATCH',
        terminalId: 'term-old',
        expectedSessionRef: { provider: 'codex', sessionId: 'thread-old' },
        // The echoed actual ref equals the pane's CURRENT ref: the rebind
        // fold already applied; this bounce is the self-healing race.
        actualSessionRef: { provider: 'codex', sessionId: 'thread-new' },
        message: 'stale bounce',
      })
    })

    // Nothing happens: no teardown, no repair create, pane untouched.
    const leaf = findLeaf(store.getState().panes.layouts['tab-1'], 'pane-1')
    expect(leaf?.content.kind).toBe('terminal')
    expect((leaf?.content as TerminalPaneContent).terminalId).toBe('term-old')
    expect((leaf?.content as TerminalPaneContent).status).toBe('running')
    expect(sentMessages().filter((msg) => msg?.type === 'terminal.create')).toHaveLength(0)
  })
```

(The pre-existing repair test doubles as the REAL-mismatch guard: its frame
carries `actualSessionRef: thread-old` ≠ current `thread-new`, so the full
repair path must still run — it must keep passing untouched.)

Run:
```bash
npm run test:vitest -- test/unit/client/components/TerminalView.codex-identity.test.tsx --run
```
Expected: the new test FAILS (the handler currently runs the repair/notice
path — `terminalId` gets cleared / a `terminal.create` is reissued). All
pre-existing tests pass.

- [ ] **Step 5: Wire the early return**

In `src/components/TerminalView.tsx`:

1. Add `isStaleSessionIdentityMismatch` to the existing import from
   `@/components/terminal-view-utils` (~line 54-57):
```ts
import {
  buildTerminalAttachMessage,
  buildTerminalInputMessage,
  buildTerminalResizeMessage,
  getCreateSessionStateFromRef,
  isStaleSessionIdentityMismatch,
} from '@/components/terminal-view-utils'
```
(Keep whatever symbols the import block already lists — only ADD the new
one.)

2. Insert the early return as the FIRST statements inside the mismatch
   handler at `:~4352`:
```tsx
        if (msg.type === 'error' && msg.code === 'SESSION_IDENTITY_MISMATCH' && msg.terminalId === tid) {
          // Stale-window bounce after a rebind -- the pane already folded
          // the new ref; the dropped frame carried the old one. Silent.
          if (isStaleSessionIdentityMismatch(contentRef.current?.sessionRef, msg.actualSessionRef)) {
            return
          }
          const staleTerminalId = tid
          ...
```

Accepted, documented behavior: a suppressed bounce means that ONE input
frame was dropped (the server did not write it to the PTY). Node has the
identical semantics; there is no retry — the user's next keystroke carries
the new ref.

- [ ] **Step 6: Run tests to verify green**

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.codex-identity.test.tsx test/unit/client/components/terminal-view-utils.session-mismatch.test.ts --run
npm run typecheck && npm run lint
```
Expected: PASS / clean.

- [ ] **Step 7: Commit**

```bash
git add src/components/terminal-view-utils.ts src/components/TerminalView.tsx test/unit/client/components/terminal-view-utils.session-mismatch.test.ts test/unit/client/components/TerminalView.codex-identity.test.tsx
git commit -m "feat(client): suppress stale rebind-window SESSION_IDENTITY_MISMATCH bounces"
```

---

### Task 6: Rust hello consumption + plugin-alive heartbeat WARN

**Files:**
- Modify: `crates/freshell-ws/src/opencode_signal.rs` (hello discrimination
  in the parse/drain, `OpencodeDrainOutcome`, `HelloTracker` on the
  watcher, `warn_opencode_panes_without_hello`, in-module tests)

**Interfaces:**
- Consumes: `TerminalRegistry::identity_probe_rows() -> Vec<IdentityProbeRow>`
  (`crates/freshell-terminal/src/registry.rs:290-305` — fields
  `terminal_id, mode, status, created_at, resume_session_id, cwd`, all pub;
  mirror `crates/freshell-ws/src/invariants.rs`'s imports for
  `IdentityProbeRow`/`TerminalRunStatus`); the `#[cfg(test)]`
  `invariants::capture::capture()` tracing harness (`invariants.rs:196-215`,
  `pub(crate)` — which is why the WARN tests live in-crate, in this
  module); `crate::terminal::now_ms()`.
- Produces:
  - Hello signal contract (Task 7's producer writes it): a file named
    `<terminalId>__<nonce>.json` in the SAME opencode signal dir, body
    `{"hello":true,"source":"opencode-tui-plugin"}`. Discrimination is by
    the payload's `"hello": true` — checked BEFORE `session_id`
    validation, so a hello never hits the `opencode_signal_rejected`
    warn+delete lane. Hello files are delete-on-read (proof of life, not a
    command); rebind files stay act-then-delete.
  - `pub struct OpencodeDrainOutcome { pub rebinds: Vec<OpencodeSignal>, pub hellos: Vec<String> }`
    — `drain()`'s new return type (`hellos` = terminalIds consumed this
    pass).
  - `pub(crate) const OPENCODE_HELLO_GRACE_MS: i64 = 120_000;`
  - One rate-limited (once per terminalId) `tracing::warn!` with message
    prefix `opencode_rebind_heartbeat_missing` when a RUNNING
    `mode == "opencode"` pane is older than the grace window and its
    terminalId never said hello — suppressed entirely when the server
    process env shows injection was deliberately skipped.
  - `drain_and_rebind_opencode(state, watcher)`'s public signature is
    UNCHANGED (the tracker lives inside the watcher behind an
    `Arc<Mutex<..>>`), so the 9 call sites in
    `tests/opencode_switch_rebind.rs` and the sweep spawner need no edits.

Design decisions (documented here so the implementer does not relitigate):
- **Same directory, payload-discriminated** (not a sibling dir): one sweep,
  one naming convention, one staleness reap; the cost is updating `drain()`'s
  return type and its in-module tests.
- **WARN hosted in the opencode signal sweep** (not the unconditional
  invariants sweep): the tracker and the hello source live here, and the
  sweep's `default_root().is_some()` boot condition is acceptable because a
  server that cannot resolve HOME also cannot receive hellos AND skips
  plugin injection (`opencode_rebind_precompute` returns `None`) — no-WARN
  is the correct behavior in that degenerate state.
- **Grace = 120_000 ms** (spec allows 60–120s; generous end chosen):
  budget = opencode TUI cold start + Bun plugin load + one 1s sweep tick,
  with slack for loaded CI machines. Pinned by a test.
- **Env gate covers what the server can cheaply see**: the
  `FRESHELL_OPENCODE_REBIND=0|false` kill switch and a user-set
  `OPENCODE_TUI_CONFIG` in the server's own process env. Per-pane env
  overrides and opencode's `--pure` are NOT visible at warn time — the
  WARN text names them as possible causes and is explicitly advisory (the
  spec authorizes exactly this).

- [ ] **Step 1: Write the failing drain-discrimination tests**

In `crates/freshell-ws/src/opencode_signal.rs`'s existing `#[cfg(test)]`
module (which already has `write_signal` and `remaining` helpers — reuse
them), add:

```rust
    #[test]
    fn drain_consumes_hello_files_and_reports_their_terminal_ids() {
        let dir = tempfile::tempdir().unwrap();
        write_signal(
            dir.path(),
            "term-h__00000000000001-000000-1.json",
            r#"{"hello":true,"source":"opencode-tui-plugin"}"#,
        );
        write_signal(
            dir.path(),
            "term-h__00000000000002-000001-1.json",
            r#"{"session_id":"ses_aaa","source":"opencode-tui-plugin"}"#,
        );
        let watcher = OpencodeSignalWatcher::new(dir.path().to_path_buf());
        let outcome = watcher.drain();
        assert_eq!(outcome.hellos, vec!["term-h".to_string()]);
        assert_eq!(outcome.rebinds.len(), 1);
        assert_eq!(outcome.rebinds[0].session_id, "ses_aaa");
        // Hello is delete-on-read; the rebind file is retained
        // (act-then-delete happens in the consumer, not the drain).
        assert_eq!(
            remaining(dir.path()),
            vec!["term-h__00000000000002-000001-1.json".to_string()]
        );
    }

    #[test]
    fn hello_files_never_hit_the_reject_warn_lane() {
        let (events, _guard) = crate::invariants::capture::capture();
        let dir = tempfile::tempdir().unwrap();
        write_signal(
            dir.path(),
            "term-h__00000000000001-000000-1.json",
            r#"{"hello":true}"#,
        );
        let watcher = OpencodeSignalWatcher::new(dir.path().to_path_buf());
        let outcome = watcher.drain();
        assert_eq!(outcome.hellos, vec!["term-h".to_string()]);
        let events = events.lock().unwrap();
        assert!(
            !events.iter().any(|e| e.message.contains("opencode_signal_rejected")),
            "a hello must not be warn-logged as a reject"
        );
    }
```

(Adapt the captured-event field access to `capture`'s actual
`CapturedEvent` shape — see its existing consumer at
`invariants.rs:259-286` for the exact field names.)

- [ ] **Step 2: Run to verify failure**

```bash
cargo test -p freshell-ws opencode_signal
```
Expected: COMPILE FAILURE — `drain()` returns `Vec<OpencodeSignal>`, not an
outcome struct. Correct RED for a return-type change.

- [ ] **Step 3: Implement hello discrimination in the drain**

In `crates/freshell-ws/src/opencode_signal.rs`:

1. New types + parse change:

```rust
/// One drain pass over the signal root, split by payload kind.
#[derive(Debug, Default)]
pub struct OpencodeDrainOutcome {
    /// Rebind signals, oldest first. The consumer act-then-deletes these.
    pub rebinds: Vec<OpencodeSignal>,
    /// terminalIds whose plugin-alive hello was consumed this pass
    /// (delete-on-read: a hello is proof of life, not a command).
    pub hellos: Vec<String>,
}

enum ParsedSignal {
    Rebind(OpencodeSignal),
    /// `{"hello":true,...}` -- written once at TUI startup by the rebind
    /// plugin as a plugin-alive heartbeat. Carries no session id and can
    /// never enter the rebind ladder.
    Hello { terminal_id: String },
}
```

2. In `parse_signal_file`, change the return type to
`Option<ParsedSignal>`, and insert the hello branch after the body parses
as JSON but BEFORE the `session_id` extraction/validation:

```rust
fn parse_signal_file(path: &Path) -> Option<ParsedSignal> {
    let stem = path.file_stem()?.to_str()?;
    let (terminal_id, _nonce) = stem.rsplit_once("__")?; // LAST "__" — load-bearing
    if terminal_id.is_empty() {
        return None;
    }
    let raw = std::fs::read_to_string(path).ok()?;
    let body: serde_json::Value = serde_json::from_str(&raw).ok()?;
    if body.get("hello").and_then(serde_json::Value::as_bool) == Some(true) {
        return Some(ParsedSignal::Hello {
            terminal_id: terminal_id.to_string(),
        });
    }
    let session_id = body.get("session_id")?.as_str()?;
    if !is_valid_opencode_session_id(session_id) {
        return None;
    }
    Some(ParsedSignal::Rebind(OpencodeSignal {
        path: path.to_path_buf(),
        terminal_id: terminal_id.to_string(),
        session_id: session_id.to_string(),
        source: body.get("source").and_then(|v| v.as_str()).map(str::to_string),
    }))
}
```

3. In `drain()`, change the return type to `OpencodeDrainOutcome` and the
match to:

```rust
            match parse_signal_file(&path) {
                Some(ParsedSignal::Rebind(sig)) => outcome.rebinds.push(sig),
                Some(ParsedSignal::Hello { terminal_id }) => {
                    let _ = std::fs::remove_file(&path); // delete-on-read
                    outcome.hellos.push(terminal_id);
                }
                None => {
                    tracing::warn!(path = %path.display(),
                        "opencode_signal_rejected: bad terminal id or session_id shape, consuming file");
                    let _ = std::fs::remove_file(&path);
                }
            }
```

(with `let mut outcome = OpencodeDrainOutcome::default();` replacing the
`signals` vec, returned at the end; the stale-reap and `.json`-filter logic
is untouched — helloes older than `STALE_SIGNAL_MAX_AGE` are reaped like
any file, which is fine: a stale hello's pane has either long said its
piece or long exited).

4. Fix the compile fallout: the existing in-module tests that call
`watcher.drain()` (3 sites) destructure the new type
(`let outcome = watcher.drain();` + use `outcome.rebinds` where they used
the vec — the exhaustive `remaining()` assertions are unchanged since those
tests contain no hello files), and `drain_and_rebind_opencode`'s internal
use of the drain result iterates `outcome.rebinds`.

Run:
```bash
cargo test -p freshell-ws opencode_signal
```
Expected: PASS (including the two new tests and all pre-existing ones).

- [ ] **Step 4: Write the failing heartbeat-WARN tests**

Same test module, add:

```rust
    fn probe_row(terminal_id: &str, mode: &str, created_at: i64) -> IdentityProbeRow {
        IdentityProbeRow {
            terminal_id: terminal_id.to_string(),
            mode: mode.to_string(),
            status: TerminalRunStatus::Running,
            created_at,
            resume_session_id: None,
            cwd: None,
        }
    }

    #[test]
    fn warns_once_for_an_opencode_pane_past_grace_with_no_hello() {
        let (events, _guard) = crate::invariants::capture::capture();
        let mut tracker = HelloTracker::default();
        let rows = vec![probe_row("term-1", "opencode", 0)];
        let now = OPENCODE_HELLO_GRACE_MS + 1;
        warn_opencode_panes_without_hello(&rows, &mut tracker, false, now);
        warn_opencode_panes_without_hello(&rows, &mut tracker, false, now + 10_000);
        let events = events.lock().unwrap();
        let warns: Vec<_> = events
            .iter()
            .filter(|e| e.message.contains("opencode_rebind_heartbeat_missing"))
            .collect();
        assert_eq!(warns.len(), 1, "once per terminal, ever: {warns:?}");
    }

    #[test]
    fn no_warn_when_hello_seen_young_non_opencode_or_injection_disabled() {
        let (events, _guard) = crate::invariants::capture::capture();
        let now = OPENCODE_HELLO_GRACE_MS + 1;

        // hello seen
        let mut tracker = HelloTracker::default();
        tracker.seen.insert("term-1".to_string());
        warn_opencode_panes_without_hello(&[probe_row("term-1", "opencode", 0)], &mut tracker, false, now);

        // young pane (inside grace)
        let mut tracker = HelloTracker::default();
        warn_opencode_panes_without_hello(&[probe_row("term-2", "opencode", now - 1_000)], &mut tracker, false, now);

        // non-opencode pane
        let mut tracker = HelloTracker::default();
        warn_opencode_panes_without_hello(&[probe_row("term-3", "codex", 0)], &mut tracker, false, now);

        // injection deliberately skipped (kill switch / user OPENCODE_TUI_CONFIG)
        let mut tracker = HelloTracker::default();
        warn_opencode_panes_without_hello(&[probe_row("term-4", "opencode", 0)], &mut tracker, true, now);

        let events = events.lock().unwrap();
        assert!(
            !events.iter().any(|e| e.message.contains("opencode_rebind_heartbeat_missing")),
            "no warn in any suppressed case"
        );
    }

    #[test]
    fn hello_grace_stays_generous() {
        // TUI cold start + Bun plugin load + one 1s sweep tick, with slack.
        assert_eq!(OPENCODE_HELLO_GRACE_MS, 120_000);
    }
```

Run:
```bash
cargo test -p freshell-ws opencode_signal
```
Expected: COMPILE FAILURE — `HelloTracker`, `OPENCODE_HELLO_GRACE_MS`,
`warn_opencode_panes_without_hello` do not exist.

- [ ] **Step 5: Implement the tracker + WARN**

In `crates/freshell-ws/src/opencode_signal.rs`:

1. Imports: mirror `invariants.rs` for `IdentityProbeRow` and
`TerminalRunStatus` (same crate-internal source it uses), plus
`std::collections::HashSet`, `std::sync::{Arc, Mutex}`.

2. Tracker + watcher field:

```rust
/// Plugin-alive heartbeat state, owned by the watcher so
/// `drain_and_rebind_opencode`'s signature stays unchanged (WsState is an
/// exhaustive struct literal in ~27 test files -- deliberately not touched).
#[derive(Debug, Default)]
pub(crate) struct HelloTracker {
    /// terminalIds that have ever said hello (plugin proven alive).
    pub(crate) seen: HashSet<String>,
    /// terminalIds already warned about -- once per terminal, ever.
    pub(crate) warned: HashSet<String>,
}

#[derive(Clone)]
pub struct OpencodeSignalWatcher {
    root: PathBuf,
    hello: Arc<Mutex<HelloTracker>>,
}

impl OpencodeSignalWatcher {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            hello: Arc::default(),
        }
    }
    // ...default_root() and drain() unchanged apart from Step 3...
}
```

3. Const + env gate + pure warn fn:

```rust
/// How long an opencode pane may run without the rebind plugin's startup
/// hello before the heartbeat alarm fires once. 120s (the generous end of
/// the 60-120s design range): opencode TUI cold start + Bun plugin load +
/// one 1s sweep tick, with slack for loaded CI machines. Pinned by
/// `hello_grace_stays_generous`.
pub(crate) const OPENCODE_HELLO_GRACE_MS: i64 = 120_000;

/// Injection skips the server CAN see at warn time, re-derived from its own
/// process env with zero plumbing: the FRESHELL_OPENCODE_REBIND kill switch
/// and a user-set OPENCODE_TUI_CONFIG. Per-pane env overrides and opencode's
/// `--pure` are NOT visible here -- the WARN text names them and stays
/// advisory for those.
fn opencode_injection_disabled_by_env() -> bool {
    let kill_switch = matches!(
        std::env::var("FRESHELL_OPENCODE_REBIND").ok().as_deref(),
        Some("0") | Some("false")
    );
    kill_switch || std::env::var("OPENCODE_TUI_CONFIG").is_ok()
}

/// One heartbeat pass (invariants.rs `warn_unresolved_terminal_identities`
/// pattern: pure fn, injected now_ms, once-per-terminal HashSet bound):
/// WARN for every RUNNING opencode pane older than
/// [`OPENCODE_HELLO_GRACE_MS`] whose terminalId never said hello.
pub(crate) fn warn_opencode_panes_without_hello(
    rows: &[IdentityProbeRow],
    tracker: &mut HelloTracker,
    injection_disabled: bool,
    now_ms: i64,
) {
    if injection_disabled {
        return;
    }
    for row in rows {
        if row.mode != "opencode"
            || row.status != TerminalRunStatus::Running
            || tracker.seen.contains(&row.terminal_id)
            || tracker.warned.contains(&row.terminal_id)
        {
            continue;
        }
        let age_ms = now_ms - row.created_at;
        if age_ms <= OPENCODE_HELLO_GRACE_MS {
            continue;
        }
        tracker.warned.insert(row.terminal_id.clone());
        tracing::warn!(
            terminal_id = %row.terminal_id,
            age_ms = age_ms,
            "opencode_rebind_heartbeat_missing: opencode pane has run past the \
             hello grace window without a plugin-alive signal -- mid-session \
             rebind is likely degraded (plugin not loaded / opencode plugin \
             API drift / plugins disabled via --pure or a per-pane config). \
             Advisory: per-pane injection skips are not visible to this check."
        );
    }
}
```

4. Wire into `drain_and_rebind_opencode` (public signature unchanged):
after the drain outcome is available and before the rebind loop, add:

```rust
    {
        let mut tracker = watcher.hello.lock().expect("hello tracker poisoned");
        tracker.seen.extend(outcome.hellos.iter().cloned());
        let injection_disabled = opencode_injection_disabled_by_env();
        warn_opencode_panes_without_hello(
            &state.registry.identity_probe_rows(),
            &mut tracker,
            injection_disabled,
            crate::terminal::now_ms(),
        );
    }
```

(Adapt placement to the function's actual body: the drain currently runs
under `spawn_blocking` — take the outcome it returns, then do the tracker
block, then the existing per-signal rebind loop over `outcome.rebinds`.)

- [ ] **Step 6: Run to verify green + full-crate safety**

```bash
cargo test -p freshell-ws opencode_signal
cargo test -p freshell-ws --test opencode_switch_rebind
cargo test -p freshell-ws
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
```
Expected: PASS / clean. (The integration test's 9
`drain_and_rebind_opencode` calls now also run the warn pass — its panes
are far younger than 120s, so no warns fire; its Phase 4 invalid-shape
signal still hits the reject lane because it carries no `"hello":true`.)

- [ ] **Step 7: Commit**

```bash
git add crates/freshell-ws/src/opencode_signal.rs
git commit -m "feat(ws): consume opencode plugin-alive hello signals and warn once when a pane never says hello"
```

---

### Task 7: opencode plugin hello emission at TUI startup

**Files:**
- Modify: `extensions/opencode/freshell-rebind-plugin.ts`
- Test: `test/unit/server/opencode-rebind-plugin.test.ts`

**Interfaces:**
- Consumes: Task 6's hello contract (MUST land after Task 6, or every pane
  start warn-logs `opencode_signal_rejected` on servers built from this
  branch): filename `<terminalId>__<nonce>.json` (nonce digits/`-` only —
  can never contain the `__` delimiter), body
  `{"hello":true,"source":"opencode-tui-plugin"}`, atomic tmp+rename into
  `<home>/.freshell/session-signals/opencode/`.
- Produces: `export function emitHello(deps: EmitterDeps): void` and a
  shared private `resolveSignalTarget(env)` used by both `emitHello` and
  `createEmitter`. `plugin.tui()` writes the hello as its FIRST action —
  before the `api` cast — so it proves *plugin-alive*, not
  *route-API-alive*, and fires even against a hostile/absent api surface.
  The plugin's hard rule stands: never throw into the TUI.
- Note: the plugin source is embedded into the Rust binary via
  `include_str!` (`crates/freshell-platform/src/opencode_plugin.rs:14-15`)
  and installed write-if-changed — no packaging step, but touching the TS
  file means the next `cargo build`/test run recompiles `freshell-platform`.

- [ ] **Step 1: Write the failing tests**

In `test/unit/server/opencode-rebind-plugin.test.ts`:

1. Add `emitHello` to the plugin import (alongside the existing
   `createEmitter`/`extractSessionId`/default imports), and add
   `import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'`,
   `import { join } from 'node:path'`, `import { tmpdir } from 'node:os'`
   if not already present.

2. New describe block, mirroring the existing `createEmitter` DI style:

```ts
describe('emitHello', () => {
  const writes: Array<{ dir: string; name: string; body: string }> = []
  const deps = (env: EmitterDeps['env']): EmitterDeps => ({
    env,
    writeFile: (dir, name, body) => writes.push({ dir, name, body }),
    now: () => 1_700_000_000_000,
  })
  beforeEach(() => writes.splice(0))

  it('writes a hello signal named <terminalId>__<nonce> into the opencode signal dir', () => {
    emitHello(deps({ HOME: '/home/u', FRESHELL_TERMINAL_ID: 'term-1' }))
    expect(writes).toHaveLength(1)
    expect(writes[0].dir).toBe('/home/u/.freshell/session-signals/opencode')
    expect(writes[0].name).toMatch(/^term-1__\d{14}-\d{6}-\d+$/)
    expect(writes[0].name.split('__')).toHaveLength(2) // nonce never contains the __ delimiter
    expect(JSON.parse(writes[0].body)).toEqual({
      hello: true,
      source: 'opencode-tui-plugin',
    })
  })

  it('never writes without a home dir or FRESHELL_TERMINAL_ID', () => {
    emitHello(deps({ FRESHELL_TERMINAL_ID: 'term-1' }))
    emitHello(deps({ HOME: '/home/u' }))
    expect(writes).toHaveLength(0)
  })

  it('swallows writer exceptions (never surfaces into the TUI)', () => {
    expect(() => emitHello({
      env: { HOME: '/home/u', FRESHELL_TERMINAL_ID: 'term-1' },
      writeFile: () => { throw new Error('disk full') },
    })).not.toThrow()
  })
})
```

3. In the existing `default export (TuiPluginModule)` describe block (which
   already uses `vi.useFakeTimers()` + `vi.stubEnv`), add a hello-at-startup
   test using a REAL temp home (the default writer is exercised end to end,
   including tmp+rename atomicity):

```ts
  it('writes a plugin-alive hello at tui() startup, even against a hostile api surface', () => {
    const home = mkdtempSync(join(tmpdir(), 'freshell-hello-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('FRESHELL_TERMINAL_ID', 'term-hello')

    const hostileApi = new Proxy({}, {
      get() { throw new Error('API drift') },
    })
    expect(() => plugin.tui(hostileApi)).not.toThrow()

    const dir = join(home, '.freshell', 'session-signals', 'opencode')
    const files = readdirSync(dir).filter((name) => name.endsWith('.json'))
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^term-hello__\d{14}-\d{6}-\d+\.json$/)
    expect(JSON.parse(readFileSync(join(dir, files[0]), 'utf-8'))).toEqual({
      hello: true,
      source: 'opencode-tui-plugin',
    })
  })
```

(Adapt the `plugin` identifier to however the file already imports the
default export, and place the test so the block's existing
`beforeEach`/`afterEach` timer + env-stub hygiene applies. If the hostile
`tui()` call starts the 1s poll interval, the block's existing fake-timer
teardown already covers it.)

- [ ] **Step 2: Run to verify failure**

```bash
npm run test:vitest -- test/unit/server/opencode-rebind-plugin.test.ts --run
```
Expected: FAIL — `emitHello` is not exported; the startup test finds no
signal dir. Pre-existing tests still pass.

- [ ] **Step 3: Implement**

In `extensions/opencode/freshell-rebind-plugin.ts`:

1. Extract the home/terminalId/dir resolution out of `createEmitter` into a
shared helper (placed above `createEmitter`), and add `emitHello`:

```ts
function resolveSignalTarget(
  env: EmitterDeps['env'],
): { dir: string; terminalId: string } | null {
  // Mirror the Rust consumer's home resolution (OpencodeSignalWatcher::
  // default_root is cfg-gated: USERPROFILE only on Windows, HOME otherwise)
  // — otherwise a Windows git-bash/MSYS shell with HOME set would emit
  // signals into a directory the server never sweeps.
  const home =
    process.platform === 'win32'
      ? (env.USERPROFILE ?? env.HOME)
      : (env.HOME ?? env.USERPROFILE)
  const terminalId = env.FRESHELL_TERMINAL_ID
  if (!home || !terminalId) return null
  return { dir: join(home, '.freshell', 'session-signals', 'opencode'), terminalId }
}

/** Plugin-alive heartbeat: written ONCE at TUI startup, before any opencode
 *  API surface is touched, so it proves the plugin LOADED (not that the
 *  route API still exists). The server's sweeper consumes it silently as
 *  liveness proof and warns when an opencode pane never says hello. */
export function emitHello(deps: EmitterDeps): void {
  try {
    const target = resolveSignalTarget(deps.env)
    if (!target) return
    const write = deps.writeFile ?? defaultWriteFile
    const now = deps.now ?? Date.now
    const nonce = `${String(now()).padStart(14, '0')}-000000-${process.pid}`
    write(
      target.dir,
      `${target.terminalId}__${nonce}`,
      JSON.stringify({ hello: true, source: 'opencode-tui-plugin' }),
    )
  } catch {
    // Losing the hello degrades to no-heartbeat. Never surface into the TUI.
  }
}
```

2. Refactor `createEmitter`'s first lines to use the shared helper (its
behavior is pinned by existing tests — they must stay green):

```ts
export function createEmitter(deps: EmitterDeps): (candidate: unknown) => void {
  const target = resolveSignalTarget(deps.env)
  if (!target) return () => {}
  const { dir, terminalId } = target
  const write = deps.writeFile ?? defaultWriteFile
  const now = deps.now ?? Date.now
  // ...rest unchanged...
```

3. In the default export's `tui(api)`, make the hello the FIRST statement
inside the outer `try`, BEFORE `createEmitter` and before the `api` cast:

```ts
  tui(api: unknown): void {
    try {
      emitHello({ env: process.env })
      const emit = createEmitter({ env: process.env })
      // ...rest unchanged...
```

- [ ] **Step 4: Run tests to verify green**

```bash
npm run test:vitest -- test/unit/server/opencode-rebind-plugin.test.ts --run
npm run typecheck
cargo test -p freshell-platform
```
Expected: PASS / clean. (The `freshell-platform` run recompiles the
embedded plugin source and re-runs the installer's pinned tests — the
plugin-only `tui.json` must remain `{"plugin":[…]}` and NOTHING else; this
task does not touch it.)

- [ ] **Step 5: Commit**

```bash
git add extensions/opencode/freshell-rebind-plugin.ts test/unit/server/opencode-rebind-plugin.test.ts
git commit -m "feat(opencode-plugin): emit a plugin-alive hello signal at TUI startup"
```

---

### Task 8: Browser e2e for the signal-driven opencode rebind flow (rust-only)

**Files:**
- Create: `test/e2e-browser/specs/opencode-rebind-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (register in BOTH
  `RUST_ONLY_SPECS` and the `rust-chromium` project's `testMatch`, each
  with a one-line justifying comment — house convention)

**Interfaces:**
- Consumes: main's fake opencode terminal fixture
  `test/e2e-browser/fixtures/fake-opencode-terminal.mjs` AS-IS (no fixture
  edits: it already logs argv JSONL via `FAKE_OPENCODE_TERMINAL_ARGV_LOG`,
  prints `opencode: session <id> started` on first Enter, and
  `opencode: resumed session <id>` under `--session`); helpers
  `createE2eServerHandle` (`../helpers/external-target.js`), `TestHarness`
  (`../helpers/test-harness.js`), `WsCapture` (`../helpers/ws-capture.js`),
  `openPanePicker` (`../helpers/pane-picker.js`); the server's signal dir
  `<info.homeDir>/.freshell/session-signals/opencode` swept every 1s
  (`OPENCODE_SIGNAL_SWEEP_INTERVAL`), filename `<terminalId>__<nonce>.json`,
  payload `{"session_id":"ses_<alnum>","source":"opencode-tui-plugin"}`.
- Produces: the repo's first browser-level proof that the full rebind stack
  composes. No production code changes. Do NOT add the spec to
  `MATRIX_SPECS` (the Node server has no signal-drain rebind).

Hard constraints baked into the spec below (violations produce
head-scratcher failures):
- `is_valid_opencode_session_id` requires `ses_` + PURE alnum — the fake's
  own generated ids (`ses_e2e_<ts>_<pid>`) contain underscores and are
  VALID as prior/bound ids but INVALID inside a signal payload. Every id
  this spec writes into a signal must be `ses_` + alnum only.
- Atomic writes: write `<name>.json.tmp`, then rename to `<name>.json` —
  the drain filters on the `.json` extension so it can never read a torn
  file.
- The 1s sweep cadence: positive waits are generous (30–60s poll budgets);
  the never-steal negative window is 3s (≥3 ticks); file-consumption polls
  allow ~5s. No fixed sleeps anywhere — bounded polling only.
- Rebind signals are act-then-delete and refused signals are also consumed
  — `fs.access` failing on the signal path is a real assertion channel
  proving the sweep ran.

- [ ] **Step 1: Register the spec (rust-only)**

In `test/e2e-browser/playwright.config.ts`:

1. Add to `RUST_ONLY_SPECS`:
```ts
  // Signal-file rebind lane exists only on the Rust server (opencode_signal.rs).
  /opencode-rebind-rust\.spec\.ts$/,
```
2. Add the same regex (with the same comment) to the `rust-chromium`
   project's `testMatch` array.

- [ ] **Step 2: Write the spec**

Create `test/e2e-browser/specs/opencode-rebind-rust.spec.ts`. Copy the
scaffolding helpers verbatim from
`test/e2e-browser/specs/opencode-terminal-restore-rust.spec.ts`
(`installFakeOpencodeTerminal`, `selectShellIfPickerShowing`,
`bootAndConnect`, `openOpencodePane`, `collectLeaves`, `findOpencodeLeaves`,
`openOpencodePaneAndGetLeaf`) — that file is the closest precedent and its
helpers are file-private. Then the spec body:

```ts
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle } from '../helpers/external-target.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import { WsCapture, type WsFrame } from '../helpers/ws-capture.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_OPENCODE_TERMINAL_SOURCE = path.resolve(__dirname, '../fixtures/fake-opencode-terminal.mjs')
const SESSION_MARKER_RE = /opencode: session (ses_e2e_\S+) started/

// >>> paste installFakeOpencodeTerminal, selectShellIfPickerShowing,
// >>> bootAndConnect, openOpencodePane, collectLeaves, findOpencodeLeaves,
// >>> openOpencodePaneAndGetLeaf verbatim from
// >>> opencode-terminal-restore-rust.spec.ts here <<<

/**
 * Write one opencode rebind signal the way the TUI plugin does:
 * <terminalId>__<nonce>.json into the server's signal dir, atomically
 * (tmp + rename; the 1s sweep filters on the .json extension so it can
 * never read a torn file). Returns the final path so consumption
 * (act-then-delete) is assertable.
 */
async function writeOpencodeSignal(
  homeDir: string,
  terminalId: string,
  seq: number,
  sessionId: string,
): Promise<string> {
  const dir = path.join(homeDir, '.freshell', 'session-signals', 'opencode')
  await fs.mkdir(dir, { recursive: true })
  // Timestamp-first, zero-padded: lexicographic order == emission order,
  // digits and '-' only so the nonce can never contain the __ delimiter.
  const nonce = `${String(Date.now()).padStart(14, '0')}-${String(seq).padStart(6, '0')}-${process.pid}`
  const name = `${terminalId}__${nonce}`
  const tmpPath = path.join(dir, `${name}.json.tmp`)
  const finalPath = path.join(dir, `${name}.json`)
  await fs.writeFile(tmpPath, JSON.stringify({ session_id: sessionId, source: 'opencode-tui-plugin' }))
  await fs.rename(tmpPath, finalPath)
  return finalPath
}

/** Bounded-wait NEGATIVE helper over WsCapture frames (no fixed sleeps). */
async function expectNoMatchingFrame(
  capture: WsCapture,
  pred: (frame: WsFrame) => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = capture.all.find(pred)
    if (hit) {
      throw new Error(`Expected NO frame matching ${label}, but got: ${JSON.stringify(hit)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

test.describe('OpenCode signal-driven rebind (Rust only)', () => {
  test.setTimeout(240_000)

  test('signal file rebinds the pane end to end: broadcast, fold, persistence, respawn argv, never-steal', async ({ page, e2eServerKind }) => {
    // Registered ONLY under rust-chromium; fail loudly on any other kind.
    expect(e2eServerKind).toBe('rust')

    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-opencode-rebind-'))
    const argLogPath = path.join(sharedRoot, 'fake-opencode-terminal-argv.jsonl')
    try {
      const fakeOpencodePath = await installFakeOpencodeTerminal(path.join(sharedRoot, 'bin'))

      const server = await createE2eServerHandle(process.env, {
        kind: e2eServerKind,
        construct: {
          env: {
            OPENCODE_CMD: fakeOpencodePath,
            FAKE_OPENCODE_TERMINAL_ARGV_LOG: argLogPath,
          },
          setupHome: async (homeDir: string) => {
            const freshellDir = path.join(homeDir, '.freshell')
            await fs.mkdir(freshellDir, { recursive: true })
            await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
              version: 1,
              settings: {
                codingCli: { enabledProviders: ['opencode'] },
              },
            }, null, 2))
          },
        },
      })
      const info = await server.start()

      type ArgvEntry = { pid: number; t: number; argv: string[] }
      async function readArgvEntries(): Promise<ArgvEntry[]> {
        try {
          const raw = await fs.readFile(argLogPath, 'utf-8')
          return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as ArgvEntry)
        } catch {
          return []
        }
      }
      function argvValue(argv: string[], flag: string): string | undefined {
        const index = argv.indexOf(flag)
        return index >= 0 ? argv[index + 1] : undefined
      }

      // Server-side raw WS capture, opened BEFORE any opencode pane exists
      // so it sees the FIRST association frame too.
      const capture = new WsCapture(info.wsUrl, info.token)
      await capture.ready()

      const harness = await bootAndConnect(page, info)
      const tabId = await harness.getActiveTabId()
      expect(tabId).toBeTruthy()

      /** Re-read the (possibly reshuffled) leaf for a given pane id. */
      async function findLeafById(tid: string, paneId: string): Promise<any> {
        const layout = await harness.getPaneLayout(tid)
        return collectLeaves(layout).find((leaf: any) => leaf.id === paneId)
      }

      /** Deterministic typing into a SPECIFIC terminal (CR as its own frame:
       *  the opencode locator's is_submit_input arms on enter-only input). */
      async function typeLineIntoTerminal(terminalId: string, text: string): Promise<void> {
        await page.evaluate(({ tid, data }) => {
          const testHarness = (window as any).__FRESHELL_TEST_HARNESS__
          if (!testHarness) throw new Error('Freshell test harness is not installed')
          testHarness.sendWsMessage({ type: 'terminal.input', terminalId: tid, data })
        }, { tid: terminalId, data: text })
        await page.evaluate(({ tid }) => {
          (window as any).__FRESHELL_TEST_HARNESS__?.sendWsMessage({ type: 'terminal.input', terminalId: tid, data: '\r' })
        }, { tid: terminalId })
      }

      /** Scrape the fake's fresh-session marker out of a terminal buffer. */
      async function scrapeSessionId(terminalId: string): Promise<string> {
        let sessionId: string | null = null
        await expect.poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalId)
          const unwrapped = typeof buffer === 'string' ? buffer.replace(/\n/g, '') : ''
          const match = SESSION_MARKER_RE.exec(unwrapped)
          sessionId = match?.[1] ?? null
          return sessionId
        }, { timeout: 30_000 }).not.toBeNull()
        return sessionId!
      }

      // ── Setup: one opencode pane, freshly bound to sesA by the locator.
      const pane1Leaf = await openOpencodePaneAndGetLeaf(page, harness, tabId!)
      const pane1Id: string = pane1Leaf.id
      const terminalId1: string = pane1Leaf.content.terminalId
      await expect.poll(async () => {
        const buffer = await harness.getTerminalBuffer(terminalId1)
        return typeof buffer === 'string' && buffer.includes('opencode> ')
      }, { timeout: 15_000 }).toBe(true)
      await typeLineIntoTerminal(terminalId1, 'hello from the rebind spec')
      const sesA = await scrapeSessionId(terminalId1)
      await capture.waitFor(
        (frame) => frame.type === 'terminal.session.associated'
          && frame.terminalId === terminalId1
          && frame.sessionRef?.sessionId === sesA,
        60_000,
        `fresh association terminal=${terminalId1} session=${sesA}`,
      )

      // ── Leg 1: signal file → rebind broadcast, exact sequence [sesA, sesB].
      // Signal payload ids must be ses_ + PURE alnum
      // (is_valid_opencode_session_id rejects underscores).
      const sesB = `ses_e2edrift${Date.now()}`
      const signalPath = await writeOpencodeSignal(info.homeDir, terminalId1, 1, sesB)
      const rebindFrame = await capture.waitFor(
        (frame) => frame.type === 'terminal.session.associated'
          && frame.terminalId === terminalId1
          && frame.sessionRef?.sessionId === sesB,
        60_000,
        `signal rebind terminal=${terminalId1} session=${sesB}`,
      )
      expect(rebindFrame.previousSessionId).toBe(sesA)

      // Acted ⇒ deleted (act-then-delete): consumption proves the sweep ran.
      await expect.poll(async () => {
        try {
          await fs.access(signalPath)
          return 'still-present'
        } catch {
          return 'consumed'
        }
      }, { timeout: 5_000 }).toBe('consumed')

      // No frame ever reported an unbound/cleared identity between the two:
      // every association frame for this terminal carried a truthy session
      // id, and the distinct id sequence is exactly [sesA, sesB].
      const associationFrames = capture.all.filter(
        (frame) => frame.type === 'terminal.session.associated' && frame.terminalId === terminalId1,
      )
      for (const frame of associationFrames) {
        expect(frame.sessionRef?.provider).toBe('opencode')
        expect(frame.sessionRef?.sessionId).toBeTruthy()
      }
      const distinctSequence: string[] = []
      for (const frame of associationFrames) {
        const id = frame.sessionRef.sessionId as string
        if (distinctSequence[distinctSequence.length - 1] !== id) distinctSequence.push(id)
      }
      expect(distinctSequence).toEqual([sesA, sesB])

      // ── Leg 2: the browser client folded the rebind into the pane (real Redux).
      await expect.poll(async () => {
        const leaf = await findLeafById(tabId!, pane1Id)
        return leaf?.content?.sessionRef?.sessionId ?? null
      }, { timeout: 30_000 }).toBe(sesB)

      // ── Leg 3: the pane is still interactive after the rebind.
      await page.evaluate(({ tid }) => {
        (window as any).__FRESHELL_TEST_HARNESS__?.sendWsMessage({
          type: 'terminal.input', terminalId: tid, data: 'still-interactive-after-rebind',
        })
      }, { tid: terminalId1 })
      await expect.poll(async () => {
        const buffer = await harness.getTerminalBuffer(terminalId1)
        const unwrapped = typeof buffer === 'string' ? buffer.replace(/\n/g, '') : ''
        return unwrapped.includes('still-interactive-after-rebind')
      }, { timeout: 15_000 }).toBe(true)
      const pane1AfterRebind = await findLeafById(tabId!, pane1Id)
      expect(pane1AfterRebind?.content?.status).not.toBe('error')

      // ── Leg 4: reload persistence — freshell.layout.v3 carries the new id.
      await page.evaluate(() => {
        (window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
      })
      await page.reload({ waitUntil: 'domcontentloaded' })
      await harness.waitForHarness()
      await harness.waitForConnection()
      await expect.poll(async () => {
        const leaf = await findLeafById(tabId!, pane1Id)
        return leaf?.content?.sessionRef?.sessionId ?? null
      }, { timeout: 30_000 }).toBe(sesB)
      const persistedRaw: string = await page.evaluate(() => {
        (window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
        const raw = window.localStorage.getItem('freshell.layout.v3')
        if (!raw) throw new Error('Missing persisted layout freshell.layout.v3')
        return raw
      })
      const persisted = JSON.parse(persistedRaw)
      const persistedPane1 = collectLeaves(persisted.panes?.layouts?.[tabId!])
        .find((leaf: any) => leaf.id === pane1Id)
      expect(persistedPane1?.content?.sessionRef?.sessionId).toBe(sesB)

      // ── Leg 5: server restart → respawn argv carries --session sesB, never sesA.
      const terminalIdBeforeRestart: string = (await findLeafById(tabId!, pane1Id))!.content.terminalId
      capture.close()
      if (!server.restart) {
        throw new Error(`${e2eServerKind} E2eServerHandle does not implement restart()`)
      }
      await server.restart()
      await page.reload({ waitUntil: 'domcontentloaded' })
      await harness.waitForHarness()
      await harness.waitForConnection()

      const restoredTerminalId1: string = await expect
        .poll(async () => {
          const leaf = await findLeafById(tabId!, pane1Id)
          if (leaf?.content?.status === 'error') return null
          const tid = leaf?.content?.terminalId
          return tid && tid !== terminalIdBeforeRestart ? tid : null
        }, { timeout: 45_000 })
        .not.toBeNull()
        .then(async () => (await findLeafById(tabId!, pane1Id))!.content.terminalId)
      expect(restoredTerminalId1).not.toBe(terminalIdBeforeRestart)

      await expect.poll(async () => {
        const buffer = await harness.getTerminalBuffer(restoredTerminalId1)
        const unwrapped = typeof buffer === 'string' ? buffer.replace(/\n/g, '') : ''
        return unwrapped.includes(`opencode: resumed session ${sesB}`)
      }, { timeout: 30_000 }).toBe(true)

      const argvEntries: ArgvEntry[] = await expect.poll(async () => {
        const entries = await readArgvEntries()
        return entries.some((entry) => argvValue(entry.argv, '--session') === sesB) ? entries : null
      }, { timeout: 30_000 }).not.toBeNull().then(readArgvEntries)
      const newestEntry = argvEntries[argvEntries.length - 1]
      expect(argvValue(newestEntry.argv, '--session')).toBe(sesB)
      expect(argvEntries.every((entry) => argvValue(entry.argv, '--session') !== sesA)).toBe(true)

      // ── Leg 6: never-steal refusal + liveness control.
      // Fresh capture: the pre-restart WS died with the old server process.
      const capture2 = new WsCapture(info.wsUrl, info.token)
      await capture2.ready()

      // Pane 2, freshly bound, then signal-rebound to the alnum-safe sesC so
      // the steal target is a LIVE-OWNED session with a signal-lane history.
      const pane2Leaf = await openOpencodePaneAndGetLeaf(page, harness, tabId!)
      const pane2Id: string = pane2Leaf.id
      const terminalId2: string = pane2Leaf.content.terminalId
      await expect.poll(async () => {
        const buffer = await harness.getTerminalBuffer(terminalId2)
        return typeof buffer === 'string' && buffer.includes('opencode> ')
      }, { timeout: 15_000 }).toBe(true)
      await typeLineIntoTerminal(terminalId2, 'hello from pane two')
      const sesC0 = await scrapeSessionId(terminalId2)
      await capture2.waitFor(
        (frame) => frame.type === 'terminal.session.associated'
          && frame.terminalId === terminalId2
          && frame.sessionRef?.sessionId === sesC0,
        60_000,
        `pane2 fresh association terminal=${terminalId2} session=${sesC0}`,
      )
      const sesC = `ses_e2eowned${Date.now()}`
      await writeOpencodeSignal(info.homeDir, terminalId2, 2, sesC)
      await capture2.waitFor(
        (frame) => frame.type === 'terminal.session.associated'
          && frame.terminalId === terminalId2
          && frame.sessionRef?.sessionId === sesC,
        60_000,
        `pane2 signal rebind terminal=${terminalId2} session=${sesC}`,
      )

      // The steal attempt: a signal for PANE 1 naming pane-2-owned sesC.
      const stealPath = await writeOpencodeSignal(info.homeDir, restoredTerminalId1, 3, sesC)
      await expectNoMatchingFrame(
        capture2,
        (frame) => frame.type === 'terminal.session.associated'
          && frame.terminalId === restoredTerminalId1
          && frame.sessionRef?.sessionId === sesC,
        3_000,
        `steal rebind terminal=${restoredTerminalId1} -> ${sesC}`,
      )
      // The refusal is act-then-delete: consumption proves the sweep SAW and
      // REFUSED the signal (not that it never ran).
      await expect.poll(async () => {
        try {
          await fs.access(stealPath)
          return 'still-present'
        } catch {
          return 'consumed'
        }
      }, { timeout: 5_000 }).toBe('consumed')

      // Both panes kept their identities across a reload.
      await page.evaluate(() => {
        (window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
      })
      await page.reload({ waitUntil: 'domcontentloaded' })
      await harness.waitForHarness()
      await harness.waitForConnection()
      await expect.poll(async () => {
        const leaf = await findLeafById(tabId!, pane1Id)
        return leaf?.content?.sessionRef?.sessionId ?? null
      }, { timeout: 30_000 }).toBe(sesB)
      await expect.poll(async () => {
        const leaf = await findLeafById(tabId!, pane2Id)
        return leaf?.content?.sessionRef?.sessionId ?? null
      }, { timeout: 30_000 }).toBe(sesC)

      // POSITIVE LIVENESS CONTROL: prove the same channel (same dir, same
      // sweep, same pane) was alive by rebinding pane 1 to an UNOWNED
      // session on it and observing success. Deliberately LAST: it moves
      // pane 1 off sesB after every sesB persistence assertion completed.
      const sesD = `ses_e2eliveness${Date.now()}`
      await writeOpencodeSignal(info.homeDir, restoredTerminalId1, 4, sesD)
      await capture2.waitFor(
        (frame) => frame.type === 'terminal.session.associated'
          && frame.terminalId === restoredTerminalId1
          && frame.sessionRef?.sessionId === sesD,
        60_000,
        `post-refusal liveness control rebind terminal=${restoredTerminalId1} session=${sesD}`,
      )
      // Re-assert the negative over the FULL frame history: even while the
      // channel was provably consuming signals, no frame ever rebound pane 1
      // to the pane-2-owned sesC.
      const stealFrame = capture2.all.find(
        (frame) => frame.type === 'terminal.session.associated'
          && frame.terminalId === restoredTerminalId1
          && frame.sessionRef?.sessionId === sesC,
      )
      expect(stealFrame).toBeUndefined()

      capture2.close()
      await server.stop()
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })
})
```

Adaptation notes:
- The `>>> paste ... <<<` marker is the ONLY intentional indirection: those
  seven helpers must be copied character-for-character from
  `opencode-terminal-restore-rust.spec.ts` (they are file-private there and
  battle-tested; do not "improve" them).
- If `WsCapture`'s frame type is exported under a different name than
  `WsFrame`, match `helpers/ws-capture.ts`'s actual export.
- `bootAndConnect`'s `info` parameter type in the restore spec is
  `{ baseUrl: string; token: string }` — the started handle's `info`
  satisfies it.

- [ ] **Step 3: Run the spec and iterate to green**

This is coverage of behavior that already exists (server rebind lane + the
D1/D2 client hardening from earlier tasks), so the honest cycle is
run-and-fix rather than red-green. Run:
```bash
npm run test:e2e -- --project=rust-chromium opencode-rebind-rust
```
Expected: PASS (budget several minutes: global-setup builds the client and
the Rust server; `cargo` must be on PATH). Debugging channels when it does
not pass first try: the server log at `info.debugLogPath` (grep
`opencode_signal_rejected` for payload-shape mistakes and
`opencode_rebind_refused` for guard refusals), and signal-file
presence/absence in the signal dir.

- [ ] **Step 4: Sanity-check the negative is not vacuous**

Deliberately break the liveness control once (change `sesD`'s write to use
terminalId `'term-bogus'`), re-run, and confirm the spec FAILS at the
liveness `waitFor` — proving the never-steal negative is guarded by a live
channel. Revert the breakage and re-run to green.

- [ ] **Step 5: Commit**

```bash
git add test/e2e-browser/specs/opencode-rebind-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): signal-driven opencode rebind browser spec (rust-only)"
```

---

### Task 9: Full verification sweep

**Files:** none created; fixes only if gates fail.

**Interfaces:**
- Consumes: everything above.
- Produces: a branch where every repo gate is green.

- [ ] **Step 1: TypeScript gates**

```bash
npm run typecheck
npm run lint
FRESHELL_TEST_SUMMARY="rebind-salvage-hardening: full suite" npm test
```
Expected: all green. `npm test` waits on the shared coordinator gate — if
another agent holds it, wait (monitor `npm run test:status`); never kill a
foreign holder.

- [ ] **Step 2: Rust gates**

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p freshell-ws
cargo test -p freshell-protocol --locked
```
Expected: all green. If `auto_resume_e2e` fails, retry once
(`cargo test -p freshell-ws --test auto_resume_e2e`) — known pre-existing
flake under load, not a regression; anything else that fails gets fixed,
not retried.

- [ ] **Step 3: e2e re-run**

```bash
npm run test:e2e -- --project=rust-chromium opencode-rebind-rust
```
Expected: PASS.

- [ ] **Step 4: Final tidy commit (only if Steps 1–3 required fixes)**

```bash
git add -A ':!docs/plans'
git commit -m "fix: address full-suite verification fallout for rebind salvage hardening"
```
(Skip if nothing changed. Do NOT push, do NOT create a PR — handled outside
this run. Never push the local `salvage/opencode-rebind-on-drift` branch.)

---

## Self-review record

**1. Spec coverage.**
- Deliverable 1 (metadata re-key): Tasks 1–2. Acceptance mapped: old→new
  key move (Task 1 test 1, Task 2 fold test), covered by unit tests, no-op
  on absent/empty map (Task 1 tests 2–3).
- Deliverable 2 (bounce suppression + Rust field): precondition
  investigation done and documented above (path did not exist; spec's
  "ALSO populate it there" branch taken); Task 4 (Rust guard + emission +
  wire-level integration + roundtrip), Task 5 (helper + fail-toward-visible
  + wiring + both suppress/real-mismatch unit coverage). Not dropped; not
  dead code — Task 4 creates the emitter the suppression consumes.
- Deliverable 3 (idempotence tests): Task 3, written against
  `previousSessionId`, with the honest expected-PASS framing and a bounded
  contingency if (b) exposes a real double-flush.
- Deliverable 4 (browser e2e): Task 8 — signal-file driven, rust-only (both
  registration lists, not MATRIX_SPECS), all six legs kept incl. the
  liveness control, control-plane fake machinery never introduced (main's
  fixture used as-is), bounded polling keyed to the 1s sweep cadence.
- Deliverable 5 (heartbeat): Tasks 6–7 — hello via the same signal-file
  transport with a distinguishable payload, atomic tmp+rename, never-throw,
  silent consumption, single once-per-terminal WARN at a documented 120s
  threshold, env-visible skips gated, non-visible skips documented as
  advisory; plugin tests + Rust hello/WARN/no-WARN tests.

**1b. No silent deferrals.** No stubs or fake providers stand in for
production behavior anywhere: the e2e fake opencode CLI is main's existing
e2e fixture (the sanctioned harness for this stack, already used by shipped
specs), and every client/server behavior added here is exercised at unit +
integration level, with Task 8 as the composed end-to-end proof. The one
scope-bounded behavior note (tab-side re-key fires only for single-pane
tabs) is main's pre-existing invariant for ALL tab-side rebind state, not a
deferral introduced by this plan — it is flagged in Task 2 rather than
hidden.

**2. Placeholder scan.** Two intentional adapt-in-place points remain, both
concrete and source-anchored rather than "TBD": Task 8's
copy-these-seven-helpers-verbatim marker (exact source file named) and Task
4's `send_json`/`wait_for_frame` mirror-the-file's-own-helper instruction
(exact reference helpers and line regions named, with skeletons). Everything
else carries complete code, exact commands, and expected outputs.

**3. Type consistency.** Verified: `tabSessionMetadataByKey?: Record<string,
SessionListMetadata>` (Tasks 1→2), `isStaleSessionIdentityMismatch(currentSessionRef:
unknown, actualSessionRef: unknown): boolean` (Task 5 helper/tests/wiring),
`OpencodeDrainOutcome { rebinds, hellos }` + `HelloTracker { seen, warned }`
+ `warn_opencode_panes_without_hello(rows, tracker, injection_disabled,
now_ms)` (Task 6 impl/tests), `emitHello(deps: EmitterDeps)` (Task 7),
`input_session_identity_ok(expected, canonical)` /
`input_session_identity_mismatch_error(terminal_id, expected, actual)`
(Task 4 impl/tests/arm), signal payload `{"session_id", "source"}` vs hello
`{"hello": true, "source"}` consistent across Tasks 6, 7, and 8.
