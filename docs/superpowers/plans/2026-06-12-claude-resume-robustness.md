# Claude Resume Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Claude terminal resume deterministic by assigning fresh Claude panes a durable UUID before launch, spawning fresh Claude with `--session-id`, restoring with `--resume` from the original cwd, and preventing ambiguous cwd/time-based wrong associations.

**Architecture:** Treat Claude more like Codex and OpenCode: Freshell owns the terminal-to-provider identity at launch time instead of waiting for the session indexer to infer it later. `TerminalRegistry` will support provider launch intent so a Claude UUID can be used either as fresh creation identity (`--session-id <uuid>`) or restore identity (`--resume <uuid>`). The existing Claude indexer association path remains only as legacy repair and must fail closed when more than one unassociated same-cwd terminal could match.

**Tech Stack:** Node.js/TypeScript ESM, `node-pty`, WebSocket protocol, React/Redux persistence, Vitest, superwstest, real Claude CLI contract tests.

---

## Files And Responsibilities

- Modify `server/extension-manifest.ts`: add strict manifest support for `cli.createSessionArgs`.
- Modify `server/index.ts`: compile manifest `createSessionArgs` templates into `CodingCliCommandSpec.createSessionArgs`.
- Modify `extensions/claude-code/freshell.json`: declare Claude fresh-session args as `["--session-id", "{{sessionId}}"]`.
- Modify `server/terminal-registry.ts`: add provider launch intent, manifest-driven Claude fresh-session args, immediate binding for preallocated fresh Claude UUIDs, and cwd-scoped Claude running-session lookup when cwd is available.
- Modify `server/ws-handler.ts`: reserve fresh Claude UUIDs by `requestId`, pass `sessionBindingReason: "start"`, skip resume-repair waits for fresh preallocated sessions, and emit structured lifecycle evidence.
- Modify `server/session-association-coordinator.ts`: keep legacy Claude heuristic association, but refuse ambiguous multiple-candidate matches instead of binding the oldest same-cwd terminal.
- Modify `src/components/BackgroundSessions.tsx`: preserve running terminal `cwd` when opening a background Claude session into a pane.
- Modify `shared/ws-protocol.ts` and `src/components/TerminalView.tsx`: include server-resolved `cwd` in `terminal.created` and preserve it as pane `initialCwd` when the pane did not already have one.
- Modify `server/terminal-stream/registry-events.ts` only if the existing `SessionBindingReason = "start" | "resume" | "association"` proves insufficient. The preferred implementation reuses `"start"`.
- Modify `test/unit/server/extension-manifest.test.ts`: prove `cli.createSessionArgs` is valid and strict schema still rejects unknown keys.
- Modify `test/unit/server/terminal-registry.test.ts`: prove Claude `start` uses manifest-driven `--session-id`, Claude `resume` still uses `--resume`, fresh starts expose `sessionRef`, and cwd-scoped Claude lookup does not reuse a different cwd.
- Modify `test/server/ws-terminal-create-reuse-running-claude.test.ts`: prove fresh Claude `terminal.create` returns a canonical `sessionRef` immediately, restore uses requested `sessionRef`, and duplicate create requests do not allocate conflicting UUIDs.
- Modify `test/unit/server/session-association-coordinator.test.ts`: prove ambiguous same-cwd legacy association is rejected.
- Modify `test/server/session-association.test.ts`: replace both existing same-cwd oldest-first expectations with fail-closed ambiguity behavior.
- Modify `test/unit/client/components/TerminalView.resumeSession.test.tsx` and `test/unit/client/components/BackgroundSessions.test.tsx` if needed: prove restored/opened Claude panes send both `sessionRef` and the provider cwd.
- Modify `test/integration/real/coding-cli-session-contract.test.ts`: refresh the Claude real-provider contract to assert cwd-scoped `--resume` lookup and explicit `--session-id` transcript creation when the local Claude probe is available; on this development machine, treat a failing available-Claude lookup contract as blocking even if model auth is unavailable.

## Task 1: Add Manifest Support For Fresh Session Args

**Files:**
- Modify: `server/extension-manifest.ts`
- Modify: `server/index.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `extensions/claude-code/freshell.json`
- Test: `test/unit/server/extension-manifest.test.ts`
- Test: `test/unit/server/terminal-registry.test.ts`

- [ ] **Step 1: Write the failing manifest schema tests**

Add tests in `test/unit/server/extension-manifest.test.ts`:

```ts
it('accepts cli.createSessionArgs templates', () => {
  const parsed = ExtensionManifestSchema.parse({
    schemaVersion: 1,
    id: 'test-claude',
    name: 'Test Claude',
    version: '1.0.0',
    pane: { type: 'terminal', command: 'claude' },
    cli: {
      command: 'claude',
      resumeArgs: ['--resume', '{{sessionId}}'],
      createSessionArgs: ['--session-id', '{{sessionId}}'],
    },
  })

  expect(parsed.cli?.createSessionArgs).toEqual(['--session-id', '{{sessionId}}'])
})
```

Keep the existing unknown-key strictness test green; do not loosen the manifest object broadly.

- [ ] **Step 2: Run the focused manifest test and verify it fails**

Run:

```bash
npm run test:vitest -- test/unit/server/extension-manifest.test.ts --run
```

Expected: the new test fails because `createSessionArgs` is not currently in the strict CLI schema.

- [ ] **Step 3: Add `createSessionArgs` to the manifest and runtime spec**

In `server/extension-manifest.ts`, add the optional field beside `resumeArgs`:

```ts
createSessionArgs: z.array(z.string()).optional(),
```

In `server/terminal-registry.ts`, add this field to `CodingCliCommandSpec`:

```ts
createSessionArgs?: (sessionId: string) => string[]
```

In `server/index.ts`, add a helper if one does not already exist for templated args:

```ts
const renderSessionArgs = (args: string[] | undefined, sessionId: string): string[] =>
  (args ?? []).map((arg) => arg.replaceAll('{{sessionId}}', sessionId))
```

When building each `CodingCliCommandSpec`, set:

```ts
createSessionArgs: manifest.cli.createSessionArgs
  ? (sessionId: string) => renderSessionArgs(manifest.cli!.createSessionArgs, sessionId)
  : undefined,
```

In `extensions/claude-code/freshell.json`, add:

```json
"createSessionArgs": ["--session-id", "{{sessionId}}"]
```

next to the existing `resumeArgs`.

- [ ] **Step 4: Prove manifest registration reaches spawn specs**

Add or extend a terminal-registry test that registers a Claude spec with `createSessionArgs` and asserts `buildSpawnSpec(..., "start")` uses `--session-id`. The test must fail if runtime registration drops `createSessionArgs`.

Run:

```bash
npm run test:vitest -- test/unit/server/extension-manifest.test.ts test/unit/server/terminal-registry.test.ts --run
```

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add server/extension-manifest.ts server/index.ts server/terminal-registry.ts extensions/claude-code/freshell.json test/unit/server/extension-manifest.test.ts test/unit/server/terminal-registry.test.ts
git commit -m "feat: add manifest fresh session args"
```

## Task 2: Add Launch Intent To Claude Spawn Args

**Files:**
- Modify: `server/terminal-registry.ts`
- Test: `test/unit/server/terminal-registry.test.ts`

- [ ] **Step 1: Write the failing Linux spawn tests**

Add these tests inside `describe('claude mode on Linux', ...)` in `test/unit/server/terminal-registry.test.ts`:

```ts
it('uses --session-id for a fresh Claude start with a preallocated UUID', () => {
  delete process.env.CLAUDE_CMD

  const spec = buildSpawnSpec(
    'claude',
    '/home/user/project',
    'system',
    VALID_CLAUDE_SESSION_ID,
    undefined,
    undefined,
    undefined,
    'start',
  )

  expect(spec.args).toContain('--session-id')
  expect(spec.args).toContain(VALID_CLAUDE_SESSION_ID)
  expect(spec.args).not.toContain('--resume')
  expectClaudeMcpArgs(spec.args)
  expect(spec.args.slice(-2)).toEqual(['--session-id', VALID_CLAUDE_SESSION_ID])
})

it('continues to use --resume for a Claude restore', () => {
  delete process.env.CLAUDE_CMD

  const spec = buildSpawnSpec(
    'claude',
    '/home/user/project',
    'system',
    VALID_CLAUDE_SESSION_ID,
    undefined,
    undefined,
    undefined,
    'resume',
  )

  expect(spec.args).toContain('--resume')
  expect(spec.args).toContain(VALID_CLAUDE_SESSION_ID)
  expect(spec.args).not.toContain('--session-id')
  expectClaudeMcpArgs(spec.args)
  expect(spec.args.slice(-2)).toEqual(['--resume', VALID_CLAUDE_SESSION_ID])
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm run test:vitest -- test/unit/server/terminal-registry.test.ts --run
```

Expected failure: TypeScript rejects the extra `buildSpawnSpec` argument, or the first new test sees `--resume` instead of `--session-id`.

- [ ] **Step 3: Implement provider launch intent**

In `server/terminal-registry.ts`, extend the CLI command spec and resolver:

```ts
type ProviderLaunchIntent = 'start' | 'resume'

export type CodingCliCommandSpec = {
  label: string
  envVar: string
  defaultCommand: string
  args?: string[]
  env?: Record<string, string>
  resumeArgs?: (sessionId: string) => string[]
  createSessionArgs?: (sessionId: string) => string[]
  modelArgs?: (model: string) => string[]
  sandboxArgs?: (sandbox: string) => string[]
  permissionModeArgs?: (permissionMode: string) => string[]
  permissionModeEnvVar?: string
  permissionModeEnvValues?: Record<string, string>
}
```

Set Claude fallback args:

```ts
['claude', {
  label: 'Claude CLI',
  envVar: 'CLAUDE_CMD',
  defaultCommand: 'claude',
  resumeArgs: (sessionId: string) => ['--resume', sessionId],
  createSessionArgs: (sessionId: string) => ['--session-id', sessionId],
  permissionModeArgs: (permissionMode: string) => ['--permission-mode', permissionMode],
}],
```

Update `resolveCodingCliCommand` to accept launch intent:

```ts
function resolveCodingCliCommand(
  mode: TerminalMode,
  resumeSessionId?: string,
  target: ProviderTarget = 'unix',
  providerSettings?: ProviderSettings,
  terminalId?: string,
  cwd?: string,
  launchIntent: ProviderLaunchIntent = 'resume',
) {
  // existing setup stays the same
  let resumeArgs: string[] = []
  if (resumeSessionId) {
    if (launchIntent === 'start' && spec.createSessionArgs) {
      resumeArgs = spec.createSessionArgs(resumeSessionId)
    } else if (spec.resumeArgs) {
      resumeArgs = spec.resumeArgs(resumeSessionId)
    } else {
      logger.warn({ mode, resumeSessionId }, 'Resume requested but no resume args configured')
    }
  }
  // existing return stays the same
}
```

Update `buildSpawnSpec` signature:

```ts
export function buildSpawnSpec(
  mode: TerminalMode,
  cwd: string | undefined,
  shell: ShellType,
  resumeSessionId?: string,
  providerSettings?: ProviderSettings,
  envOverrides?: Record<string, string>,
  terminalId?: string,
  launchIntent: ProviderLaunchIntent = 'resume',
) {
```

Thread `launchIntent` through every `resolveCodingCliCommand(...)` call in `buildSpawnSpec`.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
npm run test:vitest -- test/unit/server/terminal-registry.test.ts --run
```

Expected: the new Claude spawn tests pass, and existing terminal-registry tests still pass.

- [ ] **Step 5: Commit**

```bash
git add server/terminal-registry.ts test/unit/server/terminal-registry.test.ts
git commit -m "test: cover claude fresh session spawn intent"
```

## Task 3: Bind Fresh Claude Terminals At Creation

**Files:**
- Modify: `server/ws-handler.ts`
- Modify: `server/terminal-registry.ts`
- Test: `test/unit/server/terminal-registry.test.ts`
- Test: `test/server/ws-terminal-create-reuse-running-claude.test.ts`

- [ ] **Step 1: Write the failing registry test**

Add this test in the `TerminalRegistry` `resumeSessionId` coverage area:

```ts
it('binds a fresh Claude start immediately and exposes its sessionRef', async () => {
  const record = registry.create({
    mode: 'claude',
    cwd: '/home/user/project',
    resumeSessionId: VALID_CLAUDE_SESSION_ID,
    sessionBindingReason: 'start',
  })

  const pty = await import('node-pty')
  const spawnCall = vi.mocked(pty.spawn).mock.calls.at(-1)
  expect(spawnCall?.[0]).toBe('claude')
  expect(spawnCall?.[1]).toContain('--session-id')
  expect(spawnCall?.[1]).toContain(VALID_CLAUDE_SESSION_ID)
  expect(spawnCall?.[1]).not.toContain('--resume')

  expect(record.resumeSessionId).toBe(VALID_CLAUDE_SESSION_ID)
  expect(registry.isSessionBound('claude', VALID_CLAUDE_SESSION_ID)).toBe(true)
  expect(registry.list()[0]).toMatchObject({
    resumeSessionId: VALID_CLAUDE_SESSION_ID,
    sessionRef: {
      provider: 'claude',
      sessionId: VALID_CLAUDE_SESSION_ID,
    },
  })
})
```

- [ ] **Step 2: Write the failing WebSocket fresh-create test**

In `test/server/ws-terminal-create-reuse-running-claude.test.ts`, add a fake registry path or extend the existing `FakeRegistry` to capture create options. Add this test:

```ts
it('fresh Claude terminal.create returns a canonical sessionRef immediately', async () => {
  const requestId = 'fresh-claude-preallocated'
  const createdPromise = waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === requestId)

  ws.send(JSON.stringify({
    type: 'terminal.create',
    requestId,
    mode: 'claude',
    shell: 'system',
    cwd: '/home/user/project',
    tabId: 'tab-claude-fresh',
    paneId: 'pane-claude-fresh',
  }))

  const created = await createdPromise
  expect(created.sessionRef?.provider).toBe('claude')
  expect(created.sessionRef?.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
})
```

If the existing fake registry cannot allocate from server code, replace the assertion with inspection of `FakeRegistry.createCalls.at(-1)`:

```ts
expect(fakeRegistry.createCalls.at(-1)).toMatchObject({
  mode: 'claude',
  resumeSessionId: created.sessionRef.sessionId,
  sessionBindingReason: 'start',
})
```

- [ ] **Step 3: Run tests and verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/server/terminal-registry.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts --run
```

Expected: the WebSocket fresh-create test has no `sessionRef`, and the registry test may still spawn `--resume` until Task 1 is complete.

- [ ] **Step 4: Implement request-scoped preallocation in `ws-handler`**

Import `randomUUID`:

```ts
import { randomUUID } from 'crypto'
```

Extend `ClientState`:

```ts
claudeFreshSessionIdByRequestId: Map<string, string>
```

Initialize it with the other per-connection maps:

```ts
claudeFreshSessionIdByRequestId: new Map(),
```

Add a helper near `terminalCreateLockKey`:

```ts
private reserveClaudeFreshSessionId(state: ClientState, requestId: string): string {
  const existing = state.claudeFreshSessionIdByRequestId.get(requestId)
  if (existing) return existing
  const next = randomUUID()
  state.claudeFreshSessionIdByRequestId.set(requestId, next)
  return next
}
```

Near `effectiveResumeSessionId`, add:

```ts
let effectiveResumeSessionId: string | undefined
let sessionBindingReason: 'start' | 'resume' | undefined
```

After the existing requested-session logic, assign fresh Claude identity only for non-restore creates:

```ts
const shouldPreallocateFreshClaudeSession =
  m.mode === 'claude'
  && m.restore !== true
  && !requestedSessionRef
  && !m.resumeSessionId
  && !m.recoveryIntent

if (shouldPreallocateFreshClaudeSession) {
  effectiveResumeSessionId = this.reserveClaudeFreshSessionId(state, m.requestId)
  sessionBindingReason = 'start'
} else if (effectiveResumeSessionId && m.mode === 'claude') {
  sessionBindingReason = 'resume'
}
```

The reservation must happen before computing `terminalCreateLockKey(...)`, so duplicate `terminal.create` messages for the same `requestId` use the same lock key and the same future `sessionRef`.

Skip Claude session repair for fresh starts:

```ts
if (
  m.mode === 'claude'
  && sessionBindingReason !== 'start'
  && effectiveResumeSessionId
  && isValidClaudeSessionId(effectiveResumeSessionId)
  && this.sessionRepairService
) {
  // existing repair wait block
}
```

Pass the binding reason into registry create:

```ts
const record = this.registry.create({
  mode: m.mode as TerminalMode,
  shell: m.shell as 'system' | 'cmd' | 'powershell' | 'wsl',
  cwd: m.cwd,
  resumeSessionId: effectiveResumeSessionId,
  ...(sessionBindingReason ? { sessionBindingReason } : {}),
  ...(codexPlan
    ? {
        sessionBindingReason: getCodexSessionBindingReason(m.mode, requestedCodexResumeSessionId),
      }
    : {}),
  envContext: { tabId: m.tabId, paneId: m.paneId },
  providerSettings: spawnProviderSettings,
})
```

If TypeScript rejects duplicate `sessionBindingReason` spreads, compute a single local value before `registry.create`:

```ts
const terminalSessionBindingReason =
  codexPlan
    ? getCodexSessionBindingReason(m.mode, requestedCodexResumeSessionId)
    : sessionBindingReason
```

Then spread `terminalSessionBindingReason`.

Add lifecycle evidence when a fresh Claude UUID is allocated:

```ts
recordSessionLifecycleEvent({
  kind: 'terminal_create_requested',
  requestId: m.requestId,
  connectionId: ws.connectionId || 'unknown',
  ...(m.tabId ? { tabId: m.tabId } : {}),
  ...(m.paneId ? { paneId: m.paneId } : {}),
  ...(m.cwd ? { cwd: m.cwd } : {}),
  mode: m.mode as TerminalMode,
  restoreRequested: false,
  hasRequestedSessionRef: false,
  requestedSessionId: effectiveResumeSessionId,
})
```

If duplicating `terminal_create_requested` is too noisy, add a new `kind: "claude_fresh_session_preallocated"` to `server/session-observability.ts` with fields `terminalId?`, `requestId`, `connectionId`, `sessionId`, `tabId?`, `paneId?`, and `cwd?`, and record it once after UUID generation.

- [ ] **Step 5: Thread launch intent into registry spawn**

In `TerminalRegistry.create`, compute:

```ts
const launchIntent: ProviderLaunchIntent =
  opts.sessionBindingReason === 'start' ? 'start' : 'resume'
```

Pass it to `buildSpawnSpec(...)`:

```ts
const { file, args, env, cwd: procCwd, mcpCwd } = buildSpawnSpec(
  opts.mode,
  cwd,
  shell,
  resumeForSpawn,
  opts.providerSettings,
  baseEnv,
  terminalId,
  launchIntent,
)
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
npm run test:vitest -- test/unit/server/terminal-registry.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts --run
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add server/ws-handler.ts server/terminal-registry.ts server/session-observability.ts test/unit/server/terminal-registry.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts
git commit -m "feat: preallocate durable claude terminal sessions"
```

## Task 4: Fail Closed On Ambiguous Legacy Claude Association

**Files:**
- Modify: `server/session-association-coordinator.ts`
- Test: `test/unit/server/session-association-coordinator.test.ts`
- Test: `test/server/session-association.test.ts`

- [ ] **Step 1: Write failing ambiguity tests**

Add these tests:

```ts
it('refuses to heuristically associate a Claude session when multiple same-cwd terminals match', () => {
  const registry = {
    findUnassociatedTerminals: vi.fn(() => [
      { terminalId: 'stale-term', createdAt: 1_000 },
      { terminalId: 'new-term', createdAt: 1_100 },
    ]),
    bindSession: vi.fn(() => ({ ok: true, terminalId: 'stale-term', sessionId: 'session-main' })),
    isSessionBound: vi.fn(() => false),
  }
  const coordinator = new SessionAssociationCoordinator(registry as any, 30_000)

  const result = coordinator.associateSingleSession(createSession({ lastActivityAt: 2_000 }))

  expect(result).toEqual({ associated: false, reason: 'ambiguous_terminal_candidates' })
  expect(registry.bindSession).not.toHaveBeenCalled()
})

it('still allows one unassociated Claude terminal to be repaired by the legacy heuristic', () => {
  const registry = {
    findUnassociatedTerminals: vi.fn(() => [{ terminalId: 'term-1', createdAt: 1_000 }]),
    bindSession: vi.fn(() => ({ ok: true, terminalId: 'term-1', sessionId: 'session-main' })),
    isSessionBound: vi.fn(() => false),
  }
  const coordinator = new SessionAssociationCoordinator(registry as any, 30_000)

  const result = coordinator.associateSingleSession(createSession({ lastActivityAt: 2_000 }))

  expect(result).toEqual({ associated: true, terminalId: 'term-1' })
  expect(registry.bindSession).toHaveBeenCalledWith('term-1', 'claude', 'session-main', 'association')
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm run test:vitest -- test/unit/server/session-association-coordinator.test.ts --run
```

Expected: first test fails because the coordinator binds `stale-term`.

- [ ] **Step 3: Implement fail-closed ambiguity handling**

Update the result type:

```ts
export type SessionAssociationResult = {
  associated: boolean
  terminalId?: string
  reason?:
    | 'provider_managed'
    | 'provider_not_supported'
    | 'missing_cwd'
    | 'subagent'
    | 'non_interactive'
    | 'ambiguous_terminal_candidates'
}
```

Change selection:

```ts
const eligible = unassociated.filter(
  (candidate) => session.lastActivityAt >= candidate.createdAt - this.maxAssociationAgeMs,
)
if (eligible.length === 0) return { associated: false }
if (eligible.length > 1) return { associated: false, reason: 'ambiguous_terminal_candidates' }

const term = eligible[0]
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
npm run test:vitest -- test/unit/server/session-association-coordinator.test.ts --run
```

Expected: all association coordinator tests pass.

- [ ] **Step 5: Update both server integration same-cwd expectations**

In `test/server/session-association.test.ts`, replace both legacy same-cwd expectations:

- `should only associate the oldest terminal when multiple match same cwd`
- `should correctly associate two terminals when two sessions are created in sequence`

Both tests currently implement the unsafe behavior locally by taking `unassociated[0]`. Rework them to exercise the production `SessionAssociationCoordinator` instead of duplicating the old heuristic inside the test callback. The multiple-same-cwd test should create two unassociated Claude terminals in the same cwd, inject one new Claude session update, and assert no `terminal.session.associated` broadcast is emitted for either terminal. The sequential-session test should inject two sessions for the same cwd while both terminals remain unassociated and assert neither session is bound, because every attempt is ambiguous until only one eligible terminal remains.

Run:

```bash
npm run test:vitest -- test/server/session-association.test.ts --run
```

Expected: pass after the coordinator change.

- [ ] **Step 6: Commit**

```bash
git add server/session-association-coordinator.ts test/unit/server/session-association-coordinator.test.ts test/server/session-association.test.ts
git commit -m "fix: refuse ambiguous claude session association"
```

## Task 5: Preserve Claude Provider Cwd On Restore Paths

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `server/ws-handler.ts`
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/components/BackgroundSessions.tsx`
- Test: `test/unit/client/components/TerminalView.resumeSession.test.tsx`
- Test: `test/unit/client/components/BackgroundSessions.test.tsx`

- [ ] **Step 1: Inspect existing client restore coverage**

Run:

```bash
rg -n "initialCwd|terminal.create|sessionRef|restore" test/unit/client/components src/components/TerminalView.tsx src/components/terminal-view-utils.ts
```

Expected: identify the smallest existing test file that can assert the outgoing `terminal.create` payload.

- [ ] **Step 2: Add the failing or confirming restore payload test**

If using `TerminalView.resumeSession.test.tsx`, add a test that starts with terminal pane content:

```ts
const content = {
  kind: 'terminal',
  mode: 'claude',
  shell: 'system',
  initialCwd: '/home/user/original-project',
  sessionRef: {
    provider: 'claude',
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
  },
  status: 'starting',
} satisfies TerminalPaneContent
```

Assert the websocket send includes:

```ts
expect(sentCreate).toMatchObject({
  type: 'terminal.create',
  mode: 'claude',
  cwd: '/home/user/original-project',
  restore: true,
  sessionRef: {
    provider: 'claude',
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
  },
})
expect(sentCreate).not.toHaveProperty('resumeSessionId')
```

- [ ] **Step 3: Add the failing background-session cwd test**

In `test/unit/client/components/BackgroundSessions.test.tsx`, add a test that renders a running Claude terminal row with:

```ts
{
  terminalId: 'term-live-claude',
  mode: 'claude',
  cwd: '/home/user/live-project',
  sessionRef: {
    provider: 'claude',
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
  },
}
```

Click the row and assert the opened tab/pane content includes:

```ts
expect(openedPane.content).toMatchObject({
  kind: 'terminal',
  mode: 'claude',
  initialCwd: '/home/user/live-project',
  sessionRef: {
    provider: 'claude',
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
  },
})
```

This test covers the load-bearing counterexample where BackgroundSessions currently copies `sessionRef` but not `cwd`.

- [ ] **Step 4: Run the client focused tests**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.resumeSession.test.tsx --run
```

Expected: `TerminalView.resumeSession.test.tsx` may pass already; the new BackgroundSessions test should fail before production changes.

- [ ] **Step 5: Propagate cwd from server create and background inventory**

Update `shared/ws-protocol.ts`:

```ts
export type TerminalCreatedMessage = {
  type: 'terminal.created'
  requestId: string
  terminalId: string
  createdAt: number
  cwd?: string
  sessionRef?: SessionLocator
  clearCodexDurability?: boolean
  restoreError?: RestoreError
}
```

Update `server/ws-handler.ts` `terminal.created` send payload:

```ts
...(opts.record.cwd ? { cwd: opts.record.cwd } : {}),
```

Update `TerminalView.tsx` when handling `terminal.created`:

```ts
const createdCwd = typeof msg.cwd === 'string' && msg.cwd.trim() ? msg.cwd : undefined
updateContent({
  terminalId: newId,
  serverInstanceId: serverInstanceIdRef.current,
  streamId: undefined,
  status: 'running',
  ...(createdCwd && !contentRef.current?.initialCwd ? { initialCwd: createdCwd } : {}),
  ...(createdSessionUpdates ?? {}),
  ...(msg.clearCodexDurability ? { codexDurability: undefined } : {}),
  ...(msg.restoreError ? { restoreError: msg.restoreError } : {}),
})
```

Update `BackgroundSessions.tsx` so opening a live terminal with `t.cwd` sets both tab and pane `initialCwd` to that value.

- [ ] **Step 6: Re-run the focused tests**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.resumeSession.test.tsx test/unit/client/components/BackgroundSessions.test.tsx --run
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add shared/ws-protocol.ts server/ws-handler.ts src/components/TerminalView.tsx src/components/BackgroundSessions.tsx test/unit/client/components/TerminalView.resumeSession.test.tsx test/unit/client/components/BackgroundSessions.test.tsx
git commit -m "fix: preserve claude restore cwd"
```

## Task 6: Prove The Real Claude Provider Contract And Add Capability Guard

**Files:**
- Modify: `server/terminal-registry.ts`
- Modify: `test/unit/server/terminal-registry.test.ts`
- Modify: `test/integration/real/coding-cli-session-contract.test.ts`
- Modify: `docs/lab-notes/2026-05-13-coding-cli-session-restore-research.md` only if the machine-readable contract is used by this test and must be updated for current behavior.

- [ ] **Step 1: Run the local Claude provider experiment before enabling the implementation**

Before relying on cwd-blind running-session reuse for Claude, run an isolated real Claude probe on this machine. This is intentionally experimental and stateful; use temporary cwd values and generated UUIDs, and remove only the matching temporary test projects afterward.

Use a one-off script or the real-provider test harness to prove these facts with the installed Claude CLI:

- `claude -p --session-id <uuid>` creates a transcript with that UUID.
- `claude -p --resume <uuid>` succeeds from the same cwd.
- `claude -p --resume <uuid>` fails from a different cwd with no matching conversation.
- `claude -p --session-id <same-uuid>` from a different cwd with the same Claude home either fails as already in use or creates a second cwd-bucketed transcript before model completion. If it creates a second transcript, do not use cwd-blind running-terminal reuse for Claude when cwd is available.

Run with a timeout so the process cannot hang indefinitely. A representative command is:

```bash
timeout 180s node test/integration/real/run-claude-contract-probe.mjs
```

If adding a separate probe script is unnecessary because the Vitest real-provider test can be run directly, run that focused Vitest test instead. Do not proceed with cwd-blind Claude reuse if `claude` is installed and this lookup experiment fails.

- [ ] **Step 2: Write real-provider contract tests for cwd-scoped resume**

Inside the existing Claude real-provider `describe`, add coverage equivalent to:

```ts
it('treats Claude --resume UUID lookup as cwd-scoped', async () => {
  const claudePath = requireAvailableBinary(claudeBinary, claudeProbe)
  const workspace = await ProbeWorkspace.create('claude-cwd-scope')
  const sessionId = '66666666-6666-4666-8666-666666666666'
  try {
    await seedClaudeHome(workspace)
    const cwdA = workspace.inTemp('project-a')
    const cwdB = workspace.inTemp('project-b')
    await fsp.mkdir(cwdA, { recursive: true })
    await fsp.mkdir(cwdB, { recursive: true })

    const create = await workspace.spawnProcess(
      claudePath,
      [
        '--dangerously-skip-permissions',
        '-p',
        '--session-id',
        sessionId,
        'Reply with exactly: claude-cwd-scope-create-ok',
      ],
      { cwd: cwdA, env: { HOME: workspace.tempRoot } },
    )
    expect((await create.waitForExit(60_000)).code).toBe(0)
    expect(create.stdout().trim()).toBe('claude-cwd-scope-create-ok')

    const sameCwdResume = await workspace.spawnProcess(
      claudePath,
      [
        '--dangerously-skip-permissions',
        '-p',
        '--resume',
        sessionId,
        'Reply with exactly: claude-cwd-scope-resume-ok',
      ],
      { cwd: cwdA, env: { HOME: workspace.tempRoot } },
    )
    expect((await sameCwdResume.waitForExit(60_000)).code).toBe(0)
    expect(sameCwdResume.stdout().trim()).toBe('claude-cwd-scope-resume-ok')

    const otherCwdResume = await workspace.spawnProcess(
      claudePath,
      [
        '--dangerously-skip-permissions',
        '-p',
        '--resume',
        sessionId,
        'Reply with exactly: should-not-run',
      ],
      { cwd: cwdB, env: { HOME: workspace.tempRoot } },
    )
    const otherExit = await otherCwdResume.waitForExit(60_000)
    expect(otherExit.code).not.toBe(0)
    expect(otherCwdResume.stderr()).toContain('No conversation found with session ID')
  } finally {
    await workspace.cleanup().catch(() => undefined)
  }
}, 180_000)
```

Add a second real-provider test that attempts `--session-id <same-uuid>` in two different cwd values with the same temp `HOME`. Expected result for the current Claude contract should be recorded explicitly as one of two safe outcomes:

```ts
if (/already in use/i.test(secondOutput)) {
  expect(secondCreateExit.code).not.toBe(0)
} else {
  expect(await findClaudeTranscripts(workspace, sessionId)).toHaveLength(2)
}
```

If the observed provider behavior creates two transcripts instead, update implementation to make Claude running-terminal lookup cwd-scoped whenever cwd is available. Full binding-key migration to `(provider, sessionId, cwd)` is not required for the fresh UUID path because Freshell generates random UUIDs, but restore/reuse must not attach a different cwd.

- [ ] **Step 3: Add a runtime capability guard for fresh Claude identity**

Because real-provider Claude tests are skippable when Claude is unavailable, `TerminalRegistry` must not silently spawn `claude --session-id` when the active runtime spec lacks `createSessionArgs`. This guard does not prove installed-provider semantics; it prevents a misconfigured runtime manifest from pretending fresh durable Claude identity is supported. In `resolveCodingCliCommand`, fail clearly for launch intent `start` when `resumeSessionId` is present but `spec.createSessionArgs` is absent:

```ts
if (resumeSessionId) {
  if (launchIntent === 'start') {
    if (!spec.createSessionArgs) {
      throw new Error(`Fresh ${spec.label} launch requires createSessionArgs support.`)
    }
    resumeArgs = spec.createSessionArgs(resumeSessionId)
  } else if (spec.resumeArgs) {
    resumeArgs = spec.resumeArgs(resumeSessionId)
  } else {
    logger.warn({ mode, resumeSessionId }, 'Resume requested but no resume args configured')
  }
}
```

Add a unit test that registers a Claude spec with `resumeArgs` but no `createSessionArgs`, calls `buildSpawnSpec(..., "start")`, and expects a clear thrown error.

- [ ] **Step 4: Run only the real-provider contract if available**

Run:

```bash
npm run test:vitest -- test/integration/real/coding-cli-session-contract.test.ts --run
```

Expected: Claude tests run and pass on this machine when the local Claude CLI is available. If Claude is not available in another environment, Vitest may report the existing Claude skip reason and other real-provider tests should pass. The local experimental pass is the decision-controlling evidence for the Claude provider contract; the unit capability guard only protects runtime manifest misconfiguration.

- [ ] **Step 5: Commit**

```bash
git add server/terminal-registry.ts test/unit/server/terminal-registry.test.ts test/integration/real/coding-cli-session-contract.test.ts docs/lab-notes/2026-05-13-coding-cli-session-restore-research.md
git commit -m "test: document claude resume provider contract"
```

If the lab note did not need an edit, omit it from `git add`.

## Task 7: Run Verification And Prepare Review

**Files:**
- No expected source changes.

- [ ] **Step 1: Run focused verification**

Run:

```bash
npm run test:vitest -- \
  test/unit/server/terminal-registry.test.ts \
  test/unit/server/extension-manifest.test.ts \
  test/server/ws-terminal-create-reuse-running-claude.test.ts \
  test/unit/server/session-association-coordinator.test.ts \
  test/server/session-association.test.ts \
  test/unit/client/components/TerminalView.resumeSession.test.tsx \
  test/unit/client/components/BackgroundSessions.test.tsx \
  test/integration/real/coding-cli-session-contract.test.ts \
  --run
```

Expected: pass, with real Claude contract skipped only if the local probe prerequisites are unavailable.

- [ ] **Step 2: Run typecheck and coordinated tests**

Run:

```bash
npm run check
```

Expected: TypeScript and coordinated full suite pass.

- [ ] **Step 3: Inspect final diff**

Run:

```bash
git status --short
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
```

Expected: only planned files changed, and `git diff --check` reports no whitespace errors.

- [ ] **Step 4: Commit any remaining verification-only adjustments**

If tests forced small final fixes:

```bash
git add server src shared test extensions docs
git commit -m "fix: harden claude resume robustness"
```

Expected: no uncommitted production/test changes remain before review.

## Self-Review

**Spec coverage:** The plan covers the requested robustness goal by preallocating Claude identity, preserving restore cwd behavior, retaining `--resume` only for real restores, rejecting ambiguous legacy heuristic association, and adding real-provider evidence for cwd-scoped behavior.

**Placeholder scan:** The plan contains no unresolved implementation blanks, and every task has exact paths, commands, expected outcomes, and concrete code snippets.

**Type consistency:** The plan uses existing `SessionBindingReason` values (`start`, `resume`, `association`) and keeps `SessionLocator` unchanged. `ProviderLaunchIntent` intentionally mirrors the subset of `SessionBindingReason` that affects spawn args.
