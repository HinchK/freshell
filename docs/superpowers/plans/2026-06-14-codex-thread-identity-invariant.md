# Codex Thread Identity Invariant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make new Codex panes resume the correct Codex thread by construction by treating the Codex thread id as pane identity and terminal ids as disposable live plumbing.

**Architecture:** Freshell already captures Codex `candidateThreadId`, proves it from the rollout file, and persists `sessionRef`; this plan makes that existing identity contract authoritative on every create, attach, input, and resize path. Stale `liveTerminal` handles become recoverable implementation details: if they do not match the pane's expected Codex identity, they are ignored or repaired before any replay or input reaches a PTY.

**Tech Stack:** TypeScript, NodeNext/ESM, React 18, Redux Toolkit, WebSocket protocol schemas with Zod, Vitest, superwstest, Testing Library.

---

## Scope

This plan deliberately ignores heuristic recovery for already-corrupted historical panes. It does not add "latest Codex history", cwd/title/time matching, or prompt-recency guessing. If a pane has no pane-bound `sessionRef`, no pane-bound `codexDurability`, and no matching server-side Codex durability record, it follows the existing restore-unavailable/fresh-terminal path.

The fix is future-facing and invariant-based:

- A Codex pane's expected identity is its canonical `sessionRef.provider === "codex"` plus `sessionRef.sessionId`, or its durable `codexDurability.durableThreadId`.
- A `liveTerminal.terminalId` is reusable only when the server record proves it is running the same Codex identity.
- `terminal.attach`, `terminal.input`, and `terminal.resize` cannot operate on terminal id alone when the client knows the pane's expected Codex identity.
- Mismatch is not a normal user-facing end state. When the client has expected identity, mismatch clears stale live plumbing and triggers restore/create for the expected identity.

## Current Evidence

Existing implementation already has the core Codex identity machinery:

- `shared/codex-durability.ts` defines `candidateThreadId`, `rolloutPath`, `durableThreadId`, and durability states.
- `server/coding-cli/codex-app-server/remote-proxy.ts` captures candidates from `thread/start` responses and `thread/started` notifications.
- `server/coding-cli/codex-app-server/durability-store.ts` writes records under `~/.freshell/codex-durability/<terminalId>.json`.
- `server/coding-cli/codex-app-server/durability-proof.ts` proves the first rollout JSONL record is `session_meta` with matching `payload.id`.
- `server/terminal-registry.ts` persists candidates, promotes durable sessions, and broadcasts `terminal.session.associated`.
- `src/components/TerminalView.tsx` persists `terminal.session.associated` and `terminal.codex.durability.updated` into pane/tab state.

The observed incident shows the missing invariant: a pane can still be recreated, attached, or written to through stale live terminal plumbing or stale persisted identity without every path proving it matches the Codex thread the pane should own.

## File Structure

- Modify `shared/ws-protocol.ts`
  - Add optional `expectedSessionRef?: SessionLocator` to `terminal.attach`, `terminal.input`, and `terminal.resize`.
  - Add `SESSION_IDENTITY_MISMATCH` to `ErrorCode` and add optional `expectedSessionRef` / `actualSessionRef` fields to `ErrorMessage`.

- Create `server/terminal-session-identity.ts`
  - Central helper for comparing an expected session locator to a `TerminalRecord`.
  - Keeps the identity rule out of `ws-handler.ts`.

- Modify `server/ws-handler.ts`
  - Validate expected identity before terminal stream attach, input, and resize.
  - Prefer expected Codex `sessionRef` over stale `liveTerminal` during `terminal.create`.
  - Return a repairable mismatch response without replaying output or writing input.

- Modify `server/coding-cli/codex-app-server/restore-decision.ts`
  - Make live terminal reuse require same Codex identity when a requested `sessionRef` or durable `codexDurability` exists.
  - Remove or narrow any fallback where a requested live terminal wins because `codexDurability` is absent.

- Modify `src/components/TerminalView.tsx`
  - Send expected session identity with `terminal.attach`, `terminal.input`, and `terminal.resize`.
  - On mismatch, clear stale `liveTerminal`, preserve `sessionRef`/durable `codexDurability`, flush layout, and issue restore/create for the expected session.

- Modify `src/components/terminal-view-utils.ts`
  - Add a helper that derives the expected session locator from pane content.
  - Keep the derivation testable outside the large `TerminalView.tsx` component.

- Modify `src/lib/terminal-session-association.ts`
  - Preserve existing canonical association persistence.
  - Add regression coverage that `terminal.session.associated` clears stale live-only assumptions and keeps matching durable Codex state.

- Add tests:
  - `test/unit/server/terminal-session-identity.test.ts`
  - `test/server/ws-terminal-codex-identity-invariant.test.ts`
  - `test/unit/client/components/terminal-view-utils.test.ts`
  - `test/unit/client/components/TerminalView.codex-identity.test.tsx`
  - Extend `test/server/ws-terminal-create-reuse-running-codex.test.ts`

## Identity Rule

Use this exact rule everywhere:

```ts
type SessionLocator = {
  provider: 'codex' | 'claude' | 'opencode'
  sessionId: string
}

function terminalMatchesExpectedSession(record: TerminalRecord, expected: SessionLocator | undefined): boolean {
  if (!expected) return true
  if (record.mode !== expected.provider) return false
  if (record.resumeSessionId === expected.sessionId) return true
  if (record.codexDurability?.state === 'durable' && record.codexDurability.durableThreadId === expected.sessionId) {
    return true
  }
  if (record.codexDurability?.candidate?.candidateThreadId === expected.sessionId) {
    return true
  }
  return false
}
```

Non-Codex providers may use `resumeSessionId` only. Codex gets the extra durable/candidate checks because current records already store those identities.

## Task 1: Add Server Identity Helper

**Files:**
- Create: `server/terminal-session-identity.ts`
- Test: `test/unit/server/terminal-session-identity.test.ts`

- [ ] **Step 1: Write the failing unit tests**

Create `test/unit/server/terminal-session-identity.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { terminalMatchesExpectedSession } from '../../../server/terminal-session-identity.js'

function record(overrides: Record<string, unknown> = {}) {
  return {
    terminalId: 'term-1',
    mode: 'codex',
    status: 'running',
    resumeSessionId: undefined,
    codexDurability: undefined,
    ...overrides,
  } as any
}

describe('terminalMatchesExpectedSession', () => {
  it('accepts missing expected identity for backwards-compatible live-only paths', () => {
    expect(terminalMatchesExpectedSession(record(), undefined)).toBe(true)
  })

  it('accepts a matching resumeSessionId', () => {
    expect(terminalMatchesExpectedSession(
      record({ resumeSessionId: 'thread-1' }),
      { provider: 'codex', sessionId: 'thread-1' },
    )).toBe(true)
  })

  it('accepts a matching durable Codex thread id', () => {
    expect(terminalMatchesExpectedSession(
      record({
        codexDurability: {
          schemaVersion: 1,
          state: 'durable',
          durableThreadId: 'thread-1',
        },
      }),
      { provider: 'codex', sessionId: 'thread-1' },
    )).toBe(true)
  })

  it('accepts a matching captured Codex candidate before durable promotion', () => {
    expect(terminalMatchesExpectedSession(
      record({
        codexDurability: {
          schemaVersion: 1,
          state: 'captured_pre_turn',
          candidate: {
            provider: 'codex',
            candidateThreadId: 'thread-1',
            rolloutPath: '/home/dan/.codex/sessions/2026/06/14/rollout-thread-1.jsonl',
            source: 'thread_start_response',
            capturedAt: 1,
          },
        },
      }),
      { provider: 'codex', sessionId: 'thread-1' },
    )).toBe(true)
  })

  it('rejects a Codex terminal for the wrong thread', () => {
    expect(terminalMatchesExpectedSession(
      record({
        resumeSessionId: 'thread-old',
        codexDurability: {
          schemaVersion: 1,
          state: 'durable',
          durableThreadId: 'thread-old',
        },
      }),
      { provider: 'codex', sessionId: 'thread-new' },
    )).toBe(false)
  })

  it('rejects a provider mismatch', () => {
    expect(terminalMatchesExpectedSession(
      record({ mode: 'opencode', resumeSessionId: 'thread-1' }),
      { provider: 'codex', sessionId: 'thread-1' },
    )).toBe(false)
  })
})
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm run test:vitest -- test/unit/server/terminal-session-identity.test.ts --run
```

Expected: FAIL because `server/terminal-session-identity.ts` does not exist.

- [ ] **Step 3: Implement the helper**

Create `server/terminal-session-identity.ts`:

```ts
import type { SessionLocator } from '../shared/ws-protocol.js'
import type { TerminalRecord } from './terminal-registry.js'

export type SessionIdentityMismatch = {
  code: 'SESSION_IDENTITY_MISMATCH'
  terminalId: string
  expectedSessionRef: SessionLocator
  actualSessionRef?: SessionLocator
}

export function terminalActualSessionRef(record: Pick<TerminalRecord, 'mode' | 'resumeSessionId' | 'codexDurability'>): SessionLocator | undefined {
  if (record.mode === 'codex') {
    const durableThreadId = record.codexDurability?.state === 'durable'
      ? record.codexDurability.durableThreadId
      : undefined
    const candidateThreadId = record.codexDurability?.candidate?.candidateThreadId
    const sessionId = durableThreadId ?? record.resumeSessionId ?? candidateThreadId
    return sessionId ? { provider: 'codex', sessionId } : undefined
  }

  if (record.resumeSessionId && (record.mode === 'claude' || record.mode === 'opencode')) {
    return { provider: record.mode, sessionId: record.resumeSessionId }
  }

  return undefined
}

export function terminalMatchesExpectedSession(
  record: Pick<TerminalRecord, 'mode' | 'resumeSessionId' | 'codexDurability'>,
  expectedSessionRef: SessionLocator | undefined,
): boolean {
  if (!expectedSessionRef) return true
  if (record.mode !== expectedSessionRef.provider) return false

  if (record.resumeSessionId === expectedSessionRef.sessionId) return true

  if (expectedSessionRef.provider === 'codex') {
    if (
      record.codexDurability?.state === 'durable'
      && record.codexDurability.durableThreadId === expectedSessionRef.sessionId
    ) return true

    if (record.codexDurability?.candidate?.candidateThreadId === expectedSessionRef.sessionId) return true
  }

  return false
}

export function buildSessionIdentityMismatch(
  terminalId: string,
  record: Pick<TerminalRecord, 'mode' | 'resumeSessionId' | 'codexDurability'>,
  expectedSessionRef: SessionLocator,
): SessionIdentityMismatch {
  return {
    code: 'SESSION_IDENTITY_MISMATCH',
    terminalId,
    expectedSessionRef,
    ...(terminalActualSessionRef(record) ? { actualSessionRef: terminalActualSessionRef(record) } : {}),
  }
}
```

- [ ] **Step 4: Run the unit test**

Run:

```bash
npm run test:vitest -- test/unit/server/terminal-session-identity.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/terminal-session-identity.ts test/unit/server/terminal-session-identity.test.ts
git commit -m "test: define terminal session identity matching"
```

## Task 2: Add Expected Identity To WebSocket Protocol

**Files:**
- Modify: `shared/ws-protocol.ts`
- Test: `test/server/ws-protocol.test.ts`

- [ ] **Step 1: Write failing protocol tests**

Append tests to `test/server/ws-protocol.test.ts` near the existing attach/input/resize protocol tests:

```ts
it('terminal.attach accepts expectedSessionRef', async () => {
  const { ws, terminalId } = await createTerminal()
  ws.send(JSON.stringify({
    type: 'terminal.attach',
    terminalId,
    intent: 'viewport_hydrate',
    cols: 120,
    rows: 40,
    expectedSessionRef: { provider: 'codex', sessionId: 'thread-1' },
  }))
  const ready = await waitForMessage(ws, (msg) => msg.type === 'terminal.attach.ready' && msg.terminalId === terminalId)
  expect(ready.type).toBe('terminal.attach.ready')
})

it('terminal.input accepts expectedSessionRef', async () => {
  const { ws, terminalId } = await createTerminal()
  ws.send(JSON.stringify({
    type: 'terminal.input',
    terminalId,
    data: 'echo hello',
    expectedSessionRef: { provider: 'codex', sessionId: 'thread-1' },
  }))
  await expectNoInvalidMessage(ws)
})

it('terminal.resize accepts expectedSessionRef', async () => {
  const { ws, terminalId } = await createTerminal()
  ws.send(JSON.stringify({
    type: 'terminal.resize',
    terminalId,
    cols: 120,
    rows: 40,
    expectedSessionRef: { provider: 'codex', sessionId: 'thread-1' },
  }))
  await expectNoInvalidMessage(ws)
})
```

If the helpers in this file have different names, use the local existing helpers that create a terminal, wait for messages, and assert no protocol validation error. Do not weaken the assertions.

- [ ] **Step 2: Run the failing protocol tests**

Run:

```bash
npm run test:vitest -- test/server/ws-protocol.test.ts --run
```

Expected: FAIL because the schemas reject `expectedSessionRef`.

- [ ] **Step 3: Extend schemas**

Modify `shared/ws-protocol.ts`:

```ts
export const TerminalAttachSchema = z.object({
  type: z.literal('terminal.attach'),
  terminalId: z.string().min(1),
  sinceSeq: z.number().int().nonnegative().optional(),
  maxReplayBytes: z.number().int().positive().optional(),
  attachRequestId: z.string().min(1).optional(),
  intent: TerminalAttachIntentSchema,
  priority: TerminalAttachPrioritySchema.optional(),
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(2).max(500),
  expectedSessionRef: SessionLocatorSchema.optional(),
})

export const TerminalInputSchema = z.object({
  type: z.literal('terminal.input'),
  terminalId: z.string().min(1),
  data: z.string(),
  expectedSessionRef: SessionLocatorSchema.optional(),
})

export const TerminalResizeSchema = z.object({
  type: z.literal('terminal.resize'),
  terminalId: z.string().min(1),
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(2).max(500),
  expectedSessionRef: SessionLocatorSchema.optional(),
})
```

- [ ] **Step 4: Run protocol tests**

Run:

```bash
npm run test:vitest -- test/server/ws-protocol.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/ws-protocol.ts test/server/ws-protocol.test.ts
git commit -m "feat: carry expected session identity on terminal operations"
```

## Task 3: Enforce Identity Before Attach/Input/Resize

**Files:**
- Modify: `server/ws-handler.ts`
- Modify: `shared/ws-protocol.ts` if an error type is needed
- Test: `test/server/ws-terminal-codex-identity-invariant.test.ts`

- [ ] **Step 1: Write failing server tests**

Create `test/server/ws-terminal-codex-identity-invariant.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createTestServer, waitForMessage } from './helpers/ws-test-server.js'

describe('Codex terminal identity invariant', () => {
  it('rejects attach before replay when terminal id belongs to a different Codex thread', async () => {
    const app = await createTestServer()
    const ws = await app.openWs()
    const terminal = await app.createFakeTerminal({
      mode: 'codex',
      terminalId: 'term-old',
      resumeSessionId: 'thread-old',
      codexDurability: {
        schemaVersion: 1,
        state: 'durable',
        durableThreadId: 'thread-old',
      },
      output: 'old transcript must not replay',
    })

    ws.send(JSON.stringify({
      type: 'terminal.attach',
      terminalId: terminal.terminalId,
      intent: 'viewport_hydrate',
      cols: 120,
      rows: 40,
      expectedSessionRef: { provider: 'codex', sessionId: 'thread-new' },
    }))

    const error = await waitForMessage(ws, (msg) => msg.type === 'error' && msg.code === 'SESSION_IDENTITY_MISMATCH')
    expect(error).toMatchObject({
      code: 'SESSION_IDENTITY_MISMATCH',
      terminalId: 'term-old',
      expectedSessionRef: { provider: 'codex', sessionId: 'thread-new' },
      actualSessionRef: { provider: 'codex', sessionId: 'thread-old' },
    })
    expect(app.sentMessages()).not.toContainEqual(expect.objectContaining({ type: 'terminal.attach.ready' }))
    expect(app.sentOutput()).not.toContain('old transcript must not replay')
  })

  it('rejects input before writing to a mismatched Codex terminal', async () => {
    const app = await createTestServer()
    const ws = await app.openWs()
    const terminal = await app.createFakeTerminal({
      mode: 'codex',
      terminalId: 'term-old',
      resumeSessionId: 'thread-old',
      codexDurability: {
        schemaVersion: 1,
        state: 'durable',
        durableThreadId: 'thread-old',
      },
    })

    ws.send(JSON.stringify({
      type: 'terminal.input',
      terminalId: terminal.terminalId,
      data: 'Repeat the last 5 lines\\n',
      expectedSessionRef: { provider: 'codex', sessionId: 'thread-new' },
    }))

    const error = await waitForMessage(ws, (msg) => msg.type === 'error' && msg.code === 'SESSION_IDENTITY_MISMATCH')
    expect(error.terminalId).toBe('term-old')
    expect(terminal.inputWrites).toEqual([])
  })

  it('rejects resize before mutating a mismatched Codex terminal', async () => {
    const app = await createTestServer()
    const ws = await app.openWs()
    const terminal = await app.createFakeTerminal({
      mode: 'codex',
      terminalId: 'term-old',
      resumeSessionId: 'thread-old',
    })

    ws.send(JSON.stringify({
      type: 'terminal.resize',
      terminalId: terminal.terminalId,
      cols: 132,
      rows: 50,
      expectedSessionRef: { provider: 'codex', sessionId: 'thread-new' },
    }))

    const error = await waitForMessage(ws, (msg) => msg.type === 'error' && msg.code === 'SESSION_IDENTITY_MISMATCH')
    expect(error.terminalId).toBe('term-old')
    expect(terminal.resizeCalls).toEqual([])
  })
})
```

Use the existing server test helpers in `test/server/ws-protocol.test.ts` or `test/server/ws-terminal-create-reuse-running-codex.test.ts`. If there is no `createFakeTerminal` helper, create a local fake registry/terminal harness in this test that exercises `WsHandler` at the same abstraction level as the neighboring server tests.

- [ ] **Step 2: Run the failing tests**

Run:

```bash
npm run test:vitest -- test/server/ws-terminal-codex-identity-invariant.test.ts --run
```

Expected: FAIL because attach/input/resize only validate `terminalId`.

- [ ] **Step 3: Add mismatch guard in `ws-handler.ts`**

Import the helper:

```ts
import {
  buildSessionIdentityMismatch,
  terminalMatchesExpectedSession,
} from './terminal-session-identity.js'
```

Add a local guard near the terminal operation handlers:

```ts
const rejectSessionIdentityMismatch = (
  ws: AuthedWebSocket,
  terminalId: string,
  record: TerminalRecord,
  expectedSessionRef: SessionLocator | undefined,
  requestId?: string,
): boolean => {
  if (!expectedSessionRef) return false
  if (terminalMatchesExpectedSession(record, expectedSessionRef)) return false

  const mismatch = buildSessionIdentityMismatch(terminalId, record, expectedSessionRef)
  recordSessionLifecycleEvent({
    kind: 'terminal_session_identity_mismatch',
    provider: expectedSessionRef.provider,
    terminalId,
    sessionId: expectedSessionRef.sessionId,
    operation: 'terminal.operation',
  })
  this.sendError(ws, {
    code: mismatch.code,
    message: 'Terminal belongs to a different session than the pane expects.',
    terminalId,
    requestId,
    expectedSessionRef: mismatch.expectedSessionRef,
    actualSessionRef: mismatch.actualSessionRef,
  })
  return true
}
```

Apply the guard:

```ts
if (rejectSessionIdentityMismatch(ws, m.terminalId, record, m.expectedSessionRef, m.attachRequestId)) return
```

before `terminalStreamBroker.attach`.

```ts
const record = this.registry.get(m.terminalId)
if (record && rejectSessionIdentityMismatch(ws, m.terminalId, record, m.expectedSessionRef)) return
const result = this.registry.input(m.terminalId, m.data)
```

before `registry.input`.

```ts
const record = this.registry.get(m.terminalId)
if (record && rejectSessionIdentityMismatch(ws, m.terminalId, record, m.expectedSessionRef)) return
```

before `registry.resize`.

In `shared/ws-protocol.ts`, extend the protocol error shape:

```ts
export const ErrorCode = z.enum([
  'NOT_AUTHENTICATED',
  'INVALID_MESSAGE',
  'UNKNOWN_MESSAGE',
  'INVALID_TERMINAL_ID',
  'INVALID_SESSION_ID',
  'RESTORE_UNAVAILABLE',
  'INVALID_CREATE_REQUEST',
  'PTY_SPAWN_FAILED',
  'FILE_WATCHER_ERROR',
  'INTERNAL_ERROR',
  'RATE_LIMITED',
  'UNAUTHORIZED',
  'PROTOCOL_MISMATCH',
  'SESSION_IDENTITY_MISMATCH',
])

export type ErrorMessage = {
  type: 'error'
  code: ErrorCode
  message: string
  requestId?: string
  terminalId?: string
  timestamp: string
  expectedSessionRef?: SessionLocator
  actualSessionRef?: SessionLocator
}
```

- [ ] **Step 4: Run the focused server tests**

Run:

```bash
npm run test:vitest -- test/server/ws-terminal-codex-identity-invariant.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Run existing protocol coverage**

Run:

```bash
npm run test:vitest -- test/server/ws-protocol.test.ts --run
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/ws-handler.ts server/terminal-session-identity.ts shared/ws-protocol.ts test/server/ws-terminal-codex-identity-invariant.test.ts
git commit -m "fix: reject stale terminal operations for mismatched sessions"
```

## Task 4: Make Create Prefer Expected Codex Identity Over Stale Live Handles

**Files:**
- Modify: `server/ws-handler.ts`
- Modify: `server/coding-cli/codex-app-server/restore-decision.ts`
- Test: `test/server/ws-terminal-create-reuse-running-codex.test.ts`
- Test: `test/unit/server/coding-cli/codex-app-server/restore-decision.test.ts`

- [ ] **Step 1: Write failing create/reuse tests**

Add to `test/server/ws-terminal-create-reuse-running-codex.test.ts`:

```ts
it('does not reuse a live Codex terminal when sessionRef points at a different thread', async () => {
  const harness = await createCodexReuseHarness()
  const old = await harness.createRunningCodexTerminal({
    terminalId: 'term-old',
    sessionRef: { provider: 'codex', sessionId: 'thread-old' },
    codexDurability: {
      schemaVersion: 1,
      state: 'durable',
      durableThreadId: 'thread-old',
    },
  })

  harness.ws.send(JSON.stringify({
    type: 'terminal.create',
    requestId: 'restore-thread-new',
    mode: 'codex',
    cwd: '/home/dan/code/freshell',
    sessionRef: { provider: 'codex', sessionId: 'thread-new' },
    liveTerminal: {
      terminalId: old.terminalId,
      serverInstanceId: harness.serverInstanceId,
    },
    restore: true,
    tabId: 'tab-1',
    paneId: 'pane-1',
  }))

  const created = await harness.waitForCreated('restore-thread-new')
  expect(created.terminalId).not.toBe(old.terminalId)
  expect(harness.launches()).toContainEqual(expect.objectContaining({
    mode: 'codex',
    resumeSessionId: 'thread-new',
  }))
})
```

Add to `test/unit/server/coding-cli/codex-app-server/restore-decision.test.ts`:

```ts
it('requires live terminal identity to match requested durable sessionRef', () => {
  const decision = resolveCodexCreateRestoreDecision({
    restoreRequested: true,
    requestedSessionRef: { provider: 'codex', sessionId: 'thread-new' },
    codexDurability: undefined,
    requestedLiveTerminal: {
      terminalId: 'term-old',
      resumeSessionId: 'thread-old',
      codexDurability: {
        schemaVersion: 1,
        state: 'durable',
        durableThreadId: 'thread-old',
      },
    } as any,
  })

  expect(decision.kind).not.toBe('attach_live')
})
```

Adapt helper names to existing test helpers. Keep the assertion: a stale live terminal must not win over `sessionRef`.

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm run test:vitest -- test/server/ws-terminal-create-reuse-running-codex.test.ts test/unit/server/coding-cli/codex-app-server/restore-decision.test.ts --run
```

Expected: FAIL because a requested live terminal can still be reused without enough identity validation.

- [ ] **Step 3: Tighten create/reuse logic**

In `server/ws-handler.ts`, update the `requestedLiveTerminal()` path so it returns a record only when:

```ts
if (requestedSessionRef && !terminalMatchesExpectedSession(live, requestedSessionRef)) {
  recordSessionLifecycleEvent({
    kind: 'terminal_session_identity_mismatch',
    provider: requestedSessionRef.provider,
    terminalId: live.terminalId,
    sessionId: requestedSessionRef.sessionId,
    operation: 'terminal.create.liveTerminal',
  })
  return undefined
}
```

Apply the same check to any branch that attaches a requested live terminal because `codexDurabilityForDecision?.candidate` is absent. The rule is: if `sessionRef` exists, stale `liveTerminal` is ignored; restore/create proceeds from `sessionRef`.

In `restore-decision.ts`, make any `attach_live` decision require a matching expected Codex session when `requestedSessionRef` or durable `codexDurability` is present.

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm run test:vitest -- test/server/ws-terminal-create-reuse-running-codex.test.ts test/unit/server/coding-cli/codex-app-server/restore-decision.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/ws-handler.ts server/coding-cli/codex-app-server/restore-decision.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/unit/server/coding-cli/codex-app-server/restore-decision.test.ts
git commit -m "fix: prefer Codex session identity over stale live handles"
```

## Task 5: Send Expected Identity From TerminalView

**Files:**
- Modify: `src/components/terminal-view-utils.ts`
- Modify: `src/components/TerminalView.tsx`
- Test: `test/unit/client/components/terminal-view-utils.test.ts`
- Test: `test/unit/client/components/TerminalView.codex-identity.test.tsx`

- [ ] **Step 1: Write failing helper tests**

Add to `test/unit/client/components/terminal-view-utils.test.ts`:

```ts
import { getExpectedSessionRefForTerminalOperation } from '../../../src/components/terminal-view-utils'

describe('getExpectedSessionRefForTerminalOperation', () => {
  it('returns canonical sessionRef when present', () => {
    expect(getExpectedSessionRefForTerminalOperation({
      mode: 'codex',
      sessionRef: { provider: 'codex', sessionId: 'thread-1' },
      codexDurability: {
        schemaVersion: 1,
        state: 'durable',
        durableThreadId: 'thread-1',
      },
    } as any)).toEqual({ provider: 'codex', sessionId: 'thread-1' })
  })

  it('returns durable Codex identity when sessionRef is missing', () => {
    expect(getExpectedSessionRefForTerminalOperation({
      mode: 'codex',
      codexDurability: {
        schemaVersion: 1,
        state: 'durable',
        durableThreadId: 'thread-1',
      },
    } as any)).toEqual({ provider: 'codex', sessionId: 'thread-1' })
  })

  it('does not synthesize identity from cwd, title, or liveTerminal', () => {
    expect(getExpectedSessionRefForTerminalOperation({
      mode: 'codex',
      initialCwd: '/home/dan/code/freshell',
      liveTerminal: { terminalId: 'term-1', serverInstanceId: 'srv-1' },
    } as any)).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run failing helper tests**

Run:

```bash
npm run test:vitest -- test/unit/client/components/terminal-view-utils.test.ts --run
```

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement helper**

In `src/components/terminal-view-utils.ts`:

```ts
import type { SessionLocator, TerminalPaneContent } from '@/store/paneTypes'

export function getExpectedSessionRefForTerminalOperation(
  content: TerminalPaneContent | null | undefined,
): SessionLocator | undefined {
  if (!content) return undefined
  if (content.sessionRef) return content.sessionRef

  if (
    content.mode === 'codex'
    && content.codexDurability?.state === 'durable'
    && content.codexDurability.durableThreadId
  ) {
    return { provider: 'codex', sessionId: content.codexDurability.durableThreadId }
  }

  return undefined
}
```

- [ ] **Step 4: Wire helper into TerminalView sends**

In `src/components/TerminalView.tsx`, compute before each send:

```ts
const expectedSessionRef = getExpectedSessionRefForTerminalOperation(contentRef.current)
```

Add it to attach:

```ts
ws.send({
  type: 'terminal.attach',
  terminalId: tid,
  intent: effectiveIntent,
  cols,
  rows,
  sinceSeq,
  attachRequestId,
  priority: opts?.priority ?? 'foreground',
  ...(opts?.maxReplayBytes ? { maxReplayBytes: opts.maxReplayBytes } : {}),
  ...(expectedSessionRef ? { expectedSessionRef } : {}),
})
```

Add it to input:

```ts
ws.send({
  type: 'terminal.input',
  terminalId: tid,
  data,
  ...(expectedSessionRef ? { expectedSessionRef } : {}),
})
```

Add it to resize:

```ts
ws.send({
  type: 'terminal.resize',
  terminalId: tid,
  cols: term.cols,
  rows: term.rows,
  ...(expectedSessionRef ? { expectedSessionRef } : {}),
})
```

- [ ] **Step 5: Write TerminalView message regression test**

Create `test/unit/client/components/TerminalView.codex-identity.test.tsx`:

```ts
it('sends expected Codex session identity with terminal input', async () => {
  const ws = renderCodexTerminalView({
    content: {
      mode: 'codex',
      terminalId: 'term-1',
      sessionRef: { provider: 'codex', sessionId: 'thread-1' },
      shell: 'system',
      initialCwd: '/home/dan/code/freshell',
    },
  })

  await typeIntoTerminal('hello')

  expect(ws.sentMessages()).toContainEqual(expect.objectContaining({
    type: 'terminal.input',
    terminalId: 'term-1',
    expectedSessionRef: { provider: 'codex', sessionId: 'thread-1' },
  }))
})
```

Use existing TerminalView render helpers and xterm input helpers. If this repository already covers outbound messages in another TerminalView lifecycle test file, add the case there instead of creating a new harness.

- [ ] **Step 6: Run client tests**

Run:

```bash
npm run test:vitest -- test/unit/client/components/terminal-view-utils.test.ts test/unit/client/components/TerminalView.codex-identity.test.tsx --run
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/terminal-view-utils.ts src/components/TerminalView.tsx test/unit/client/components/terminal-view-utils.test.ts test/unit/client/components/TerminalView.codex-identity.test.tsx
git commit -m "feat: send pane session identity with terminal operations"
```

## Task 6: Client Repairs Stale Live Terminal Handles

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/store/panesSlice.ts` if a reducer helper is needed
- Test: `test/unit/client/components/TerminalView.codex-identity.test.tsx`

- [ ] **Step 1: Write failing client repair test**

Add:

```ts
it('clears stale liveTerminal and recreates expected Codex session after identity mismatch', async () => {
  const ws = renderCodexTerminalView({
    content: {
      mode: 'codex',
      terminalId: 'term-old',
      liveTerminal: { terminalId: 'term-old', serverInstanceId: 'srv-1' },
      sessionRef: { provider: 'codex', sessionId: 'thread-new' },
      shell: 'system',
      initialCwd: '/home/dan/code/freshell',
    },
  })

  ws.receive({
    type: 'error',
    code: 'SESSION_IDENTITY_MISMATCH',
    message: 'Terminal belongs to a different session than the pane expects.',
    terminalId: 'term-old',
    expectedSessionRef: { provider: 'codex', sessionId: 'thread-new' },
    actualSessionRef: { provider: 'codex', sessionId: 'thread-old' },
  })

  await waitFor(() => {
    expect(currentPaneContent()).toMatchObject({
      mode: 'codex',
      sessionRef: { provider: 'codex', sessionId: 'thread-new' },
    })
    expect(currentPaneContent().liveTerminal).toBeUndefined()
    expect(currentPaneContent().terminalId).toBeUndefined()
  })

  expect(ws.sentMessages()).toContainEqual(expect.objectContaining({
    type: 'terminal.create',
    mode: 'codex',
    sessionRef: { provider: 'codex', sessionId: 'thread-new' },
  }))
})
```

- [ ] **Step 2: Run failing client test**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.codex-identity.test.tsx --run
```

Expected: FAIL because mismatch errors are not repaired.

- [ ] **Step 3: Implement repair handling**

In the WebSocket message handler in `TerminalView.tsx`, add:

```ts
if (
  msg.type === 'error'
  && msg.code === 'SESSION_IDENTITY_MISMATCH'
  && msg.terminalId === tid
) {
  const expectedSessionRef = sanitizeSessionRef(msg.expectedSessionRef)
  if (expectedSessionRef) {
    updateContent({
      terminalId: undefined,
      liveTerminal: undefined,
      sessionRef: expectedSessionRef,
    })
    dispatch(flushPersistedLayoutNow())
    queueMicrotask(() => {
      const nextRequestId = nanoid()
      sendCreate(nextRequestId)
    })
  }
  return
}
```

Use local helper names for `updateContent`, request id generation, and `sendCreate`. If `sendCreate` is not in scope at the message handler, extract a small `scheduleRestoreCreateForExpectedSession` callback inside `TerminalView.tsx` that has access to the same refs.

- [ ] **Step 4: Run client repair test**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.codex-identity.test.tsx --run
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/TerminalView.tsx src/store/panesSlice.ts test/unit/client/components/TerminalView.codex-identity.test.tsx
git commit -m "fix: repair stale Codex live terminal handles"
```

## Task 7: Prove Association Flush Is The Persistence Boundary

**Files:**
- Modify: `src/lib/terminal-session-association.ts`
- Test: `test/unit/client/lib/terminal-session-association.test.ts`
- Test: `test/unit/server/terminal-registry.codex-sidecar.test.ts`

- [ ] **Step 1: Write failing client association test**

Add to `test/unit/client/lib/terminal-session-association.test.ts`:

```ts
it('persists canonical Codex sessionRef and keeps matching durable state on association', () => {
  const store = createTabsStoreWithPane({
    tabId: 'tab-1',
    paneId: 'pane-1',
    terminalId: 'term-1',
    content: {
      mode: 'codex',
      terminalId: 'term-1',
      codexDurability: {
        schemaVersion: 1,
        state: 'durable',
        durableThreadId: 'thread-1',
        candidate: {
          provider: 'codex',
          candidateThreadId: 'thread-1',
          rolloutPath: '/home/dan/.codex/sessions/2026/06/14/rollout-thread-1.jsonl',
          source: 'thread_start_response',
          capturedAt: 1,
        },
      },
    },
  })

  const reconciled = reconcileTerminalSessionAssociation({
    dispatch: store.dispatch,
    getState: store.getState,
    terminalId: 'term-1',
    sessionRef: { provider: 'codex', sessionId: 'thread-1' },
  })

  expect(reconciled).toBe(true)
  expect(selectPaneContent(store.getState(), 'tab-1', 'pane-1')).toMatchObject({
    sessionRef: { provider: 'codex', sessionId: 'thread-1' },
    resumeSessionId: undefined,
    codexDurability: {
      state: 'durable',
      durableThreadId: 'thread-1',
    },
  })
})
```

- [ ] **Step 2: Write failing server association test**

Add to `test/unit/server/terminal-registry.codex-sidecar.test.ts`:

```ts
it('broadcasts terminal.session.associated only after matching Codex rollout proof succeeds', async () => {
  const registry = createRegistryWithCodexDurabilityStore()
  const terminal = await registry.createCodexTerminalWithCandidate({
    terminalId: 'term-1',
    candidateThreadId: 'thread-1',
    rolloutPath: await writeCodexRollout({ threadId: 'thread-1' }),
  })

  await registry.handleCodexTurnCompletedForTest(terminal.terminalId, {
    threadId: 'thread-1',
    turnId: 'turn-1',
  })

  await vi.waitFor(() => {
    expect(registry.broadcasts()).toContainEqual(expect.objectContaining({
      type: 'terminal.session.associated',
      terminalId: 'term-1',
      sessionRef: { provider: 'codex', sessionId: 'thread-1' },
    }))
  })
})
```

Use existing helper names in this file; this test already has many Codex durability helpers.

- [ ] **Step 3: Run focused tests**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/terminal-session-association.test.ts test/unit/server/terminal-registry.codex-sidecar.test.ts --run
```

Expected: PASS when the existing association path already satisfies the invariant, or FAIL with a missing pane persistence / missing broadcast assertion.

- [ ] **Step 4: Confirm or apply the association persistence code**

Inspect `src/lib/terminal-session-association.ts`. It must preserve matching durable Codex state with this logic:

```ts
const nextCodexDurability = sessionRef.provider === 'codex'
  && content.codexDurability?.state === 'durable'
  && (
    content.codexDurability.durableThreadId === sessionRef.sessionId
    || content.codexDurability.candidate?.candidateThreadId === sessionRef.sessionId
  )
    ? content.codexDurability
    : undefined
```

Inspect `server/terminal-registry.ts`. It must keep this order after proof success:

```ts
this.broadcastCodexDurability(record, stored)
this.broadcastCodexSessionAssociated(record, proof.rolloutProofId)
```

Do not broadcast association before rollout proof succeeds.

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/terminal-session-association.test.ts test/unit/server/terminal-registry.codex-sidecar.test.ts --run
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/terminal-session-association.ts server/terminal-registry.ts test/unit/client/lib/terminal-session-association.test.ts test/unit/server/terminal-registry.codex-sidecar.test.ts
git commit -m "test: lock Codex association persistence boundary"
```

## Task 8: Incident-Shaped Component E2E Regression

**Files:**
- Create: `test/e2e/codex-wrong-thread-resume.test.tsx`

- [ ] **Step 1: Write the failing e2e regression**

Create `test/e2e/codex-wrong-thread-resume.test.tsx`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import { useAppSelector } from '@/store/hooks'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import TerminalView from '@/components/TerminalView'

const wsHarness = vi.hoisted(() => {
  const messageHandlers = new Set<(msg: any) => void>()
  const restoreRequestIds = new Set<string>()
  return {
    send: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn((handler: (msg: any) => void) => {
      messageHandlers.add(handler)
      return () => messageHandlers.delete(handler)
    }),
    onReconnect: vi.fn(() => () => {}),
    addRestoreRequestId(id: string) {
      restoreRequestIds.add(id)
    },
    consumeRestoreRequestId(id: string) {
      const hasId = restoreRequestIds.has(id)
      restoreRequestIds.delete(id)
      return hasId
    },
    emit(msg: any) {
      for (const handler of messageHandlers) handler(msg)
    },
    reset() {
      messageHandlers.clear()
      restoreRequestIds.clear()
      this.send.mockClear()
    },
  }
})

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsHarness.send,
    connect: wsHarness.connect,
    onMessage: wsHarness.onMessage,
    onReconnect: wsHarness.onReconnect,
  }),
}))

vi.mock('@/lib/terminal-restore', () => ({
  addTerminalRestoreRequestId: (id: string) => wsHarness.addRestoreRequestId(id),
  consumeTerminalRestoreRequestId: (id: string) => wsHarness.consumeRestoreRequestId(id),
  addTerminalFreshRecoveryRequestId: vi.fn(),
  consumeTerminalFreshRecoveryRequest: vi.fn(() => undefined),
}))

vi.mock('@/lib/terminal-themes', () => ({
  getTerminalTheme: () => ({}),
}))

vi.mock('@/components/terminal/terminal-runtime', () => ({
  createTerminalRuntime: () => ({
    attachAddons: vi.fn(),
    fit: vi.fn(),
    findNext: vi.fn(() => false),
    findPrevious: vi.fn(() => false),
    clearDecorations: vi.fn(),
    onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
    webglActive: vi.fn(() => false),
  }),
}))

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    open = vi.fn()
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }))
    onData = vi.fn(() => ({ dispose: vi.fn() }))
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    attachCustomKeyEventHandler = vi.fn()
    attachCustomWheelEventHandler = vi.fn()
    dispose = vi.fn()
    focus = vi.fn()
    getSelection = vi.fn(() => '')
    clear = vi.fn()
    write = vi.fn((data: string, cb?: () => void) => {
      cb?.()
      return data.length
    })
    writeln = vi.fn()
  }
  return { Terminal: MockTerminal }
})

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

function findLeaf(node: PaneNode | undefined, paneId: string): Extract<PaneNode, { type: 'leaf' }> | null {
  if (!node) return null
  if (node.type === 'leaf') return node.id === paneId ? node : null
  return findLeaf(node.children[0], paneId) || findLeaf(node.children[1], paneId)
}

function TerminalViewFromStore({ tabId, paneId }: { tabId: string; paneId: string }) {
  const paneContent = useAppSelector((state) => findLeaf(state.panes.layouts[tabId], paneId)?.content ?? null)
  if (!paneContent || paneContent.kind !== 'terminal') return null
  return <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
}

function createStore(content: TerminalPaneContent) {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [{
          id: 'tab-codex',
          mode: 'codex',
          status: 'running',
          title: 'Codex',
          titleSetByUser: false,
          createRequestId: 'tab-codex',
        }],
        activeTabId: 'tab-codex',
      },
      panes: {
        layouts: {
          'tab-codex': {
            type: 'leaf',
            id: 'pane-codex',
            content,
          },
        },
        activePane: { 'tab-codex': 'pane-codex' },
        paneTitles: {},
      },
      settings: { settings: defaultSettings, status: 'loaded' },
      connection: { status: 'ready', error: null, serverInstanceId: 'srv-new' },
    },
  })
}

function sentMessages() {
  return wsHarness.send.mock.calls.map(([msg]) => msg)
}

describe('Codex wrong-thread resume regression', () => {
  beforeEach(() => {
    wsHarness.reset()
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('repairs stale Codex terminal plumbing instead of continuing the wrong thread', async () => {
    const store = createStore({
      kind: 'terminal',
      createRequestId: 'req-old',
      status: 'running',
      mode: 'codex',
      shell: 'system',
      terminalId: 'term-old',
      serverInstanceId: 'srv-new',
      sessionRef: { provider: 'codex', sessionId: 'thread-new' },
      codexDurability: {
        schemaVersion: 1,
        state: 'durable',
        durableThreadId: 'thread-new',
      },
      initialCwd: '/home/dan/code/freshell',
    })

    render(
      <Provider store={store}>
        <TerminalViewFromStore tabId="tab-codex" paneId="pane-codex" />
      </Provider>,
    )

    await waitFor(() => {
      expect(sentMessages()).toContainEqual(expect.objectContaining({
        type: 'terminal.attach',
        terminalId: 'term-old',
        expectedSessionRef: { provider: 'codex', sessionId: 'thread-new' },
      }))
    })

    wsHarness.send.mockClear()
    wsHarness.emit({
      type: 'error',
      code: 'SESSION_IDENTITY_MISMATCH',
      message: 'Terminal belongs to a different session than the pane expects.',
      terminalId: 'term-old',
      timestamp: new Date().toISOString(),
      expectedSessionRef: { provider: 'codex', sessionId: 'thread-new' },
      actualSessionRef: { provider: 'codex', sessionId: 'thread-old' },
    })

    await waitFor(() => {
      expect(sentMessages()).toContainEqual(expect.objectContaining({
        type: 'terminal.create',
        mode: 'codex',
        restore: true,
        sessionRef: { provider: 'codex', sessionId: 'thread-new' },
      }))
    })

    const state = store.getState()
    const content = findLeaf(state.panes.layouts['tab-codex'], 'pane-codex')?.content
    expect(content).toMatchObject({
      kind: 'terminal',
      mode: 'codex',
      sessionRef: { provider: 'codex', sessionId: 'thread-new' },
    })
    expect((content as TerminalPaneContent).terminalId).toBeUndefined()
  })
})
```

This e2e regression is intentionally component-level because the existing restart recovery e2e tests are component-level. It proves the user-facing reload path: stale terminal plumbing is cleared and the recreate path targets the expected Codex `sessionRef`.

- [ ] **Step 2: Run the failing e2e test**

Run:

```bash
FRESHELL_TEST_SUMMARY="codex wrong-thread resume e2e" npm run test:vitest -- test/e2e/codex-wrong-thread-resume.test.tsx --run
```

Expected: FAIL before all identity guards and client repair are wired.

- [ ] **Step 3: Implement only production repair code**

Do not add fixture support for this task. The test file above owns its local mocks and should pass once Tasks 5 and 6 are implemented.

- [ ] **Step 4: Run e2e regression**

Run:

```bash
FRESHELL_TEST_SUMMARY="codex wrong-thread resume e2e" npm run test:vitest -- test/e2e/codex-wrong-thread-resume.test.tsx --run
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/codex-wrong-thread-resume.test.tsx
git commit -m "test: cover Codex wrong-thread resume regression"
```

## Task 9: Full Verification

**Files:**
- No production file changes unless verification exposes failures.

- [ ] **Step 1: Run status check**

Run:

```bash
npm run test:status
```

Expected: coordinator is idle or shows a reusable green baseline. If another agent holds the broad gate, wait rather than killing it.

- [ ] **Step 2: Run focused suites**

Run:

```bash
npm run test:vitest -- \
  test/unit/server/terminal-session-identity.test.ts \
  test/server/ws-terminal-codex-identity-invariant.test.ts \
  test/server/ws-terminal-create-reuse-running-codex.test.ts \
  test/unit/server/coding-cli/codex-app-server/restore-decision.test.ts \
  test/unit/client/components/terminal-view-utils.test.ts \
  test/unit/client/components/TerminalView.codex-identity.test.tsx \
  test/unit/client/lib/terminal-session-association.test.ts \
  test/unit/server/terminal-registry.codex-sidecar.test.ts \
  --run
```

Expected: PASS.

- [ ] **Step 3: Run repo check**

Run:

```bash
FRESHELL_TEST_SUMMARY="codex thread identity invariant final check" npm run check
```

Expected: PASS.

- [ ] **Step 4: Inspect git diff**

Run:

```bash
git status --short
git diff --stat
```

Expected: only files listed in this plan are changed.

- [ ] **Step 5: Final commit if verification caused changes**

```bash
git add shared/ws-protocol.ts server src test
git commit -m "fix: enforce Codex thread identity invariant"
```

## Self-Review

- Spec coverage: The plan covers the requested non-legacy approach. It uses the existing Codex durability system, makes it authoritative for create/attach/input/resize, rejects stale live terminal reuse, and repairs stale handles from the client.
- Placeholder scan: There is no heuristic recovery, no "latest history" matching, and no deferred legacy resolver. Test snippets identify the exact user-visible failure: input must not reach the old thread and restore must target the expected thread.
- Type consistency: The plan consistently uses `expectedSessionRef`, `sessionRef`, `candidateThreadId`, `durableThreadId`, and `SESSION_IDENTITY_MISMATCH`.
- Known implementation adjustment: Some test helper names in snippets may need to map onto the repo's existing fixtures. Preserve the behavior and assertion shape when adapting helper names.
