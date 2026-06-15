# Fresh Agent Centralization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the obsolete agent-chat client/runtime surface in one migration so all agent panes, settings, history, and browser smoke coverage use the fresh-agent path.

**Architecture:** Treat `fresh-agent` as the only live agent UI and WebSocket contract. Keep only one-time migration at persistence/config boundaries so already-saved Freshell layouts and config records become fresh-agent records before render; do not keep live `agentChat` Redux state, UI branches, `/api/agent-chat/*`, `/api/agent-sessions/*`, or top-level `sdk.*` client messages. Move still-useful Claude history code and shared transcript widgets to fresh-agent-owned modules before deleting old paths.

**Tech Stack:** React 18, TypeScript, Redux Toolkit, Express, ws, Zod, Vitest, Testing Library, Playwright browser e2e, Tailwind CSS.

---

## Scope Check

This is intentionally one comprehensive migration. It touches client UI, Redux state, persisted layout migration, settings/config normalization, WebSocket protocol, server REST routes, Claude history internals, tests, and browser smoke coverage in the same branch. The implementation must land as a single cohesive PR because partial compatibility is exactly the state being removed.

Do not keep old live clients working. These are allowed because they are migration boundaries, not live obsolete infrastructure:

- Reading old persisted pane content with `kind: "agent-chat"` and converting it to `kind: "fresh-agent"` before render.
- Reading old stored config/local-settings keys named `agentChat` and converting them to `freshAgent` before the app sees settings.
- Internal Claude history code that still restores durable Claude transcripts, after it is renamed/moved under `server/fresh-agent`.

Everything else named `agent-chat`, `agentChat`, `AgentChat`, or top-level client `sdk.*` should either be deleted or renamed to fresh-agent ownership.

## File Structure

- Move/modify: `src/components/agent-chat/DiffView.tsx` -> `src/components/fresh-agent/shared/DiffView.tsx`
  - Shared diff renderer used by fresh-agent tool and approval cards.
- Move/modify: `src/components/agent-chat/SlotReel.tsx` -> `src/components/fresh-agent/shared/SlotReel.tsx`
  - Small activity-strip animation used by `FreshAgentTranscript`.
- Move/modify: `src/components/agent-chat/tool-preview.ts` -> `src/components/fresh-agent/shared/tool-preview.ts`
  - Tool input preview helpers used by fresh-agent transcript components.
- Modify: `src/components/fresh-agent/FreshAgentItemCard.tsx`
  - Import fresh-agent-owned shared helpers.
- Modify: `src/components/fresh-agent/FreshAgentApprovalCard.tsx`
  - Import fresh-agent-owned `DiffView`.
- Modify: `src/components/fresh-agent/FreshAgentTranscript.tsx`
  - Import fresh-agent-owned `SlotReel` and tool preview helper.
- Delete: `src/components/agent-chat/`
  - Remove `AgentChatView`, composer, banners, message bubbles, collapsed turns, old tool components, and old debounce hook after shared pieces are moved.
- Delete: `src/store/agentChatSlice.ts`, `src/store/agentChatThunks.ts`, `src/store/agentChatTypes.ts`
  - Remove legacy Redux state.
- Modify: `src/store/store.ts`
  - Remove `agentChat` reducer.
- Delete: `src/lib/sdk-message-handler.ts`
  - Remove top-level legacy `sdk.*` client message handling.
- Modify: `src/lib/fresh-agent-ws.ts`
  - Handle fresh-agent transport events only, with fresh-agent event names.
- Modify: `shared/ws-protocol.ts`
  - Remove legacy client/server `sdk.*` messages and define fresh-agent transport event payloads.
- Modify: `server/ws-handler.ts`
  - Remove client-facing `sdk.*` handlers and translate Claude SDK bridge events into fresh-agent transport event names before sending.
- Rename/modify: `shared/agent-chat-capabilities.ts` -> `shared/fresh-agent-capabilities.ts`
  - Fresh-agent provider capability contracts.
- Rename/modify: `src/lib/agent-chat-capabilities.ts` -> `src/lib/fresh-agent-capabilities.ts`
  - Client capability cache helpers against `/api/fresh-agent/capabilities`.
- Rename/modify: `server/agent-chat-capability-registry.ts` -> `server/fresh-agent/capability-registry.ts`
  - Server capability cache registry.
- Rename/modify: `server/agent-chat-capabilities-router.ts` -> `server/fresh-agent/capabilities-router.ts`
  - Mount at `/api/fresh-agent/capabilities`.
- Modify: `server/index.ts`
  - Remove `/api/agent-chat/capabilities` and `/api/agent-sessions/*`; mount fresh-agent capabilities route.
- Move/modify: `server/agent-timeline/history-source.ts` -> `server/fresh-agent/adapters/claude/history-source.ts`
- Move/modify: `server/agent-timeline/ledger.ts` -> `server/fresh-agent/adapters/claude/history-ledger.ts`
- Move/modify: `server/agent-timeline/service.ts` -> `server/fresh-agent/adapters/claude/history-service.ts`
- Move/modify: `server/agent-timeline/types.ts` -> `server/fresh-agent/adapters/claude/history-types.ts`
  - Claude durable history remains, but is no longer exposed as the legacy agent-timeline API.
- Delete: `server/agent-timeline/router.ts`
  - Remove legacy `/api/agent-sessions/:sessionId/timeline` and `/turns/:turnId`.
- Modify: `server/fresh-agent/adapters/claude/adapter.ts`
  - Import moved Claude history service/types.
- Modify: `server/sdk-bridge.ts`, `server/session-history-loader.ts`, `server/ws-handler.ts`
  - Import moved Claude history source/ledger helpers.
- Modify: `shared/settings.ts`, `server/config-store.ts`, `server/settings-router.ts`
  - Return and accept fresh-agent settings as canonical. Read old `agentChat` only during load/sanitize migration; never mirror it into responses.
- Modify: `src/components/settings/WorkspaceSettings.tsx`, `src/components/fresh-agent/FreshAgentSettingsButton.tsx`, `src/components/fresh-agent/FreshAgentView.tsx`, `src/components/panes/PanePicker.tsx`, `src/components/panes/PaneContainer.tsx`, `src/components/Sidebar.tsx`, `src/components/TabBar.tsx`, `src/components/MobileTabStrip.tsx`, `src/hooks/useAgentSessionTurnCompletion.ts`, `src/lib/pane-activity.ts`, `src/lib/session-type-utils.ts`, `src/lib/session-utils.ts`, `src/lib/derivePaneTitle.ts`, `src/lib/deriveTabName.ts`, `src/lib/coding-agent-detection.ts`, `src/lib/tab-directory-preference.ts`, `src/lib/tab-fallback-identity.ts`, `src/store/panesSlice.ts`, `src/store/tabsSlice.ts`, `src/store/persistMiddleware.ts`, `src/store/persistedState.ts`, `src/store/storage-migration.ts`, `src/store/paneTreeValidation.ts`
  - Remove live `agent-chat` branches and selectors; keep fresh-agent migration helpers only where persisted unknown input enters.
- Modify tests under `test/unit`, `test/integration`, `test/e2e`, and `test/e2e-browser`
  - Delete legacy-only agent-chat tests or convert their user-story coverage to fresh-agent tests.
- Create: `test/unit/architecture/fresh-agent-only-runtime.test.ts`
  - Runtime source architecture guard that fails if legacy live paths reappear.
- Create: `test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts`
  - Browser smoke test covering freshclaude, freshcodex, freshopencode, settings, migration, route removal, and absence of legacy UI/message paths.

---

### Task 1: Move Shared Transcript Widgets Out Of `agent-chat`

**Files:**
- Create: `src/components/fresh-agent/shared/DiffView.tsx`
- Create: `src/components/fresh-agent/shared/SlotReel.tsx`
- Create: `src/components/fresh-agent/shared/tool-preview.ts`
- Modify: `src/components/fresh-agent/FreshAgentItemCard.tsx:1-5`
- Modify: `src/components/fresh-agent/FreshAgentApprovalCard.tsx:1-8`
- Modify: `src/components/fresh-agent/FreshAgentTranscript.tsx:1-6`
- Test: `test/unit/client/components/fresh-agent/FreshAgentSharedWidgets.test.tsx`

- [ ] **Step 1: Write the failing shared-widget import test**

Create `test/unit/client/components/fresh-agent/FreshAgentSharedWidgets.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import DiffView from '@/components/fresh-agent/shared/DiffView'
import SlotReel from '@/components/fresh-agent/shared/SlotReel'
import { getToolPreview } from '@/components/fresh-agent/shared/tool-preview'

describe('fresh-agent shared transcript widgets', () => {
  it('renders the moved diff view from the fresh-agent namespace', () => {
    render(<DiffView oldStr={'alpha\nbeta'} newStr={'alpha\ngamma'} filePath="src/example.ts" />)
    expect(screen.getByText('src/example.ts')).toBeInTheDocument()
    expect(screen.getByText(/gamma/)).toBeInTheDocument()
  })

  it('renders the moved slot reel from the fresh-agent namespace', () => {
    render(<SlotReel values={['Read', 'Bash']} activeIndex={1} ariaLabel="Activity" />)
    expect(screen.getByLabelText('Activity')).toBeInTheDocument()
    expect(screen.getByText('Bash')).toBeInTheDocument()
  })

  it('keeps tool previews available without importing agent-chat modules', () => {
    expect(getToolPreview('Read', { file_path: '/tmp/example.txt' })).toBe('/tmp/example.txt')
    expect(getToolPreview('Bash', { command: 'npm test' })).toBe('npm test')
  })
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm run test:vitest -- test/unit/client/components/fresh-agent/FreshAgentSharedWidgets.test.tsx --run
```

Expected: FAIL because `@/components/fresh-agent/shared/DiffView`, `SlotReel`, and `tool-preview` do not exist yet.

- [ ] **Step 3: Move the three shared files**

Run:

```bash
mkdir -p src/components/fresh-agent/shared
git mv src/components/agent-chat/DiffView.tsx src/components/fresh-agent/shared/DiffView.tsx
git mv src/components/agent-chat/SlotReel.tsx src/components/fresh-agent/shared/SlotReel.tsx
git mv src/components/agent-chat/tool-preview.ts src/components/fresh-agent/shared/tool-preview.ts
```

- [ ] **Step 4: Update fresh-agent imports**

In `src/components/fresh-agent/FreshAgentItemCard.tsx`, replace the imports at the top with:

```tsx
import DiffView from '@/components/fresh-agent/shared/DiffView'
import { getToolPreview } from '@/components/fresh-agent/shared/tool-preview'
```

In `src/components/fresh-agent/FreshAgentApprovalCard.tsx`, replace the `DiffView` import with:

```tsx
import DiffView from '@/components/fresh-agent/shared/DiffView'
```

In `src/components/fresh-agent/FreshAgentTranscript.tsx`, replace the shared imports with:

```tsx
import SlotReel from '@/components/fresh-agent/shared/SlotReel'
import { getToolPreview } from '@/components/fresh-agent/shared/tool-preview'
```

- [ ] **Step 5: Run the focused test and existing fresh-agent transcript tests**

Run:

```bash
npm run test:vitest -- test/unit/client/components/fresh-agent/FreshAgentSharedWidgets.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx --run
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/fresh-agent/FreshAgentItemCard.tsx src/components/fresh-agent/FreshAgentApprovalCard.tsx src/components/fresh-agent/FreshAgentTranscript.tsx src/components/fresh-agent/shared test/unit/client/components/fresh-agent/FreshAgentSharedWidgets.test.tsx
git commit -m "Move transcript widgets into fresh-agent"
```

---

### Task 2: Make Settings Canonically `freshAgent`

**Files:**
- Modify: `shared/settings.ts:156-220`
- Modify: `shared/settings.ts:300-330`
- Modify: `shared/settings.ts:560-590`
- Modify: `shared/settings.ts:690-810`
- Modify: `shared/settings.ts:1015-1080`
- Modify: `shared/settings.ts:1145-1220`
- Modify: `shared/settings.ts:1250-1420`
- Modify: `server/config-store.ts:270-330`
- Modify: `server/settings-router.ts:70-80`
- Modify: `src/components/settings/WorkspaceSettings.tsx:265-310`
- Modify: `src/components/fresh-agent/FreshAgentSettingsButton.tsx:55-75`
- Modify: `src/components/fresh-agent/FreshAgentView.tsx:300-325`
- Test: `test/unit/shared/settings.test.ts`
- Test: `test/unit/server/config-store.fresh-agent-settings.test.ts`
- Test: `test/integration/server/settings-api.test.ts`

- [ ] **Step 1: Rewrite settings tests to require fresh-agent canonical output**

In `test/unit/shared/settings.test.ts`, replace old alias expectations with these tests:

```ts
it('accepts legacy agentChat input only as a migration source and returns freshAgent canonical settings', () => {
  const parsed = sanitizeServerSettingsPatch({
    agentChat: {
      enabled: true,
      defaultPlugins: ['/tmp/plugin'],
      providers: {
        freshcodex: { style: 'serif', effort: 'high' },
      },
    },
  } as never)

  expect(parsed).toEqual({
    freshAgent: {
      enabled: true,
      defaultPlugins: ['/tmp/plugin'],
      providers: {
        freshcodex: { style: 'serif', effort: 'high' },
      },
    },
  })
  expect('agentChat' in parsed).toBe(false)
})

it('merges server settings into freshAgent without mirroring agentChat', () => {
  const merged = mergeServerSettings(defaultSettings, {
    freshAgent: {
      enabled: true,
      providers: {
        freshclaude: { defaultPermissionMode: 'acceptEdits' },
      },
    },
  })

  expect(merged.freshAgent.enabled).toBe(true)
  expect(merged.freshAgent.providers.freshclaude).toEqual({ defaultPermissionMode: 'acceptEdits' })
  expect('agentChat' in merged).toBe(false)
})

it('resolves browser-local fresh-agent settings without exposing agentChat', () => {
  const resolved = resolveLocalSettings({
    agentChat: { showTools: true, showThinking: true, fontScale: 1.25 },
  } as never)

  expect(resolved.freshAgent.showTools).toBe(true)
  expect(resolved.freshAgent.showThinking).toBe(true)
  expect(resolved.freshAgent.fontScale).toBe(1.25)
  expect('agentChat' in resolved).toBe(false)
})
```

In `test/integration/server/settings-api.test.ts`, add:

```ts
it('returns only freshAgent settings after migrating a legacy agentChat patch', async () => {
  const res = await request(app)
    .patch('/api/settings')
    .send({
      agentChat: {
        enabled: true,
        defaultPlugins: ['/tmp/plugin'],
        providers: { freshcodex: { style: 'serif' } },
      },
    })
    .expect(200)

  expect(res.body.freshAgent.enabled).toBe(true)
  expect(res.body.freshAgent.defaultPlugins).toEqual(['/tmp/plugin'])
  expect(res.body.freshAgent.providers.freshcodex).toEqual({ style: 'serif' })
  expect(res.body.agentChat).toBeUndefined()
})
```

- [ ] **Step 2: Run focused settings tests and verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/shared/settings.test.ts test/unit/server/config-store.fresh-agent-settings.test.ts test/integration/server/settings-api.test.ts --run
```

Expected: FAIL because current settings still include and mirror `agentChat`.

- [ ] **Step 3: Remove `agentChat` from exported settings types and defaults**

In `shared/settings.ts`, remove `agentChat` from `ServerSettings`, `ServerSettingsPatch`, `LocalSettings`, `LocalSettingsPatch`, `ResolvedSettings`, schemas, and default objects. Keep a private input-only type for migration:

```ts
type LegacyAgentChatSettingsInput = Partial<ServerSettings['freshAgent'] & LocalSettings['freshAgent']> & {
  providers?: Record<string, unknown>
}

function readLegacyAgentChatInput(candidate: Record<string, unknown>): LegacyAgentChatSettingsInput | null {
  return isRecord(candidate.agentChat)
    ? candidate.agentChat as LegacyAgentChatSettingsInput
    : null
}
```

Update `sanitizeServerSettingsPatch` so this line:

```ts
const rawAgentChatInput = isRecord(candidate.agentChat) ? candidate.agentChat : null
```

becomes:

```ts
const rawAgentChatInput = readLegacyAgentChatInput(candidate)
```

Update the result assignment from:

```ts
sanitized.freshAgent = freshAgent
sanitized.agentChat = freshAgent
```

to:

```ts
sanitized.freshAgent = freshAgent
```

Update `mergeServerSettings` so it uses only:

```ts
const freshAgentPatch = normalizedPatch.freshAgent as Partial<ServerSettings['freshAgent']> | undefined
```

and remove the returned `agentChat` property entirely.

Update `resolveLocalSettings` so it uses:

```ts
const freshAgentPatch = patch?.freshAgent ?? (patch as Record<string, unknown> | undefined)?.agentChat as LocalSettingsPatch['freshAgent'] | undefined
```

and returns only:

```ts
freshAgent: normalizeLocalFreshAgent(mergeDefined(defaultLocalSettings.freshAgent, freshAgentPatch)),
```

- [ ] **Step 4: Update UI settings reads and writes**

In `src/components/settings/WorkspaceSettings.tsx`, replace the Fresh Agent section toggles so they read and write only `freshAgent`:

```tsx
checked={settings.freshAgent?.enabled ?? false}
onChange={(checked) => {
  applyServerSetting({ freshAgent: { enabled: checked } })
}}
```

```tsx
checked={settings.freshAgent?.showThinking ?? false}
onChange={(checked) => {
  applyLocalSetting({ freshAgent: { showThinking: checked } })
}}
```

```tsx
checked={settings.freshAgent?.showTools ?? false}
onChange={(checked) => {
  applyLocalSetting({ freshAgent: { showTools: checked } })
}}
```

```tsx
checked={settings.freshAgent?.showTimecodes ?? false}
onChange={(checked) => {
  applyLocalSetting({ freshAgent: { showTimecodes: checked } })
}}
```

In `src/components/fresh-agent/FreshAgentView.tsx`, replace provider settings fallback with:

```ts
const providerSettings = useAppSelector((state) =>
  state.settings.settings.freshAgent?.providers?.[paneContent.sessionType]
  ?? state.settings.serverSettings?.freshAgent?.providers?.[paneContent.sessionType]
)
const defaultShowTimecodes = useAppSelector((state) =>
  state.settings.localSettings.freshAgent?.showTimecodes
  ?? state.settings.settings.freshAgent?.showTimecodes
  ?? false
)
```

In `src/components/fresh-agent/FreshAgentSettingsButton.tsx`, replace any `agentChat` settings access with:

```ts
const freshAgentSettings = settings.freshAgent
const providerSettings = freshAgentSettings?.providers?.[sessionType]
```

- [ ] **Step 5: Run focused settings tests**

Run:

```bash
npm run test:vitest -- test/unit/shared/settings.test.ts test/unit/server/config-store.fresh-agent-settings.test.ts test/integration/server/settings-api.test.ts --run
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/settings.ts server/config-store.ts server/settings-router.ts src/components/settings/WorkspaceSettings.tsx src/components/fresh-agent/FreshAgentSettingsButton.tsx src/components/fresh-agent/FreshAgentView.tsx test/unit/shared/settings.test.ts test/unit/server/config-store.fresh-agent-settings.test.ts test/integration/server/settings-api.test.ts
git commit -m "Make fresh-agent settings canonical"
```

---

### Task 3: Remove `agent-chat` Pane Type From Live Client State

**Files:**
- Modify: `src/store/paneTypes.ts:153-204`
- Modify: `shared/fresh-agent.ts:104-151`
- Modify: `src/store/persistedState.ts:249-262`
- Modify: `src/store/storage-migration.ts:107-130`
- Modify: `src/store/persistMiddleware.ts:141-165`
- Modify: `src/store/panesSlice.ts:127-170`
- Modify: `src/store/paneTreeValidation.ts:95-112`
- Modify: `src/components/TabsView.tsx:150-205`
- Test: `test/unit/client/fresh-agent-pane-migration.test.ts`
- Test: `test/unit/server/agent-layout-schema.test.ts`

- [ ] **Step 1: Write the failing pane migration tests**

Create `test/unit/client/fresh-agent-pane-migration.test.ts`:

```ts
import { migrateLegacyFreshAgentContent } from '@shared/fresh-agent'
import { validatePaneTree } from '@/store/paneTreeValidation'

describe('fresh-agent pane migration', () => {
  it('converts legacy agent-chat pane content to fresh-agent before render', () => {
    const migrated = migrateLegacyFreshAgentContent({
      kind: 'agent-chat',
      provider: 'freshclaude',
      sessionId: 'live-1',
      createRequestId: 'req-1',
      status: 'idle',
      resumeSessionId: '00000000-0000-4000-8000-000000000001',
      initialCwd: '/work',
      permissionMode: 'acceptEdits',
      effort: 'high',
      plugins: ['/tmp/plugin'],
    })

    expect(migrated).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      sessionId: 'live-1',
      createRequestId: 'req-1',
      status: 'idle',
      resumeSessionId: '00000000-0000-4000-8000-000000000001',
      initialCwd: '/work',
      permissionMode: 'acceptEdits',
      effort: 'high',
      plugins: ['/tmp/plugin'],
    })
  })

  it('rejects agent-chat as a live pane tree kind after migration boundaries', () => {
    const tree = {
      type: 'leaf',
      id: 'pane-1',
      content: {
        kind: 'agent-chat',
        provider: 'freshclaude',
        createRequestId: 'req-1',
        status: 'idle',
      },
    }

    expect(validatePaneTree(tree as never).valid).toBe(false)
  })
})
```

- [ ] **Step 2: Run the focused migration test and verify it fails**

Run:

```bash
npm run test:vitest -- test/unit/client/fresh-agent-pane-migration.test.ts test/unit/server/agent-layout-schema.test.ts --run
```

Expected: FAIL because `agent-chat` is still accepted as a live pane kind.

- [ ] **Step 3: Remove `AgentChatPaneContent` from live pane types**

In `src/store/paneTypes.ts`, delete the `AgentChatPaneContent` type and update the union to:

```ts
export type PaneContent = TerminalPaneContent | BrowserPaneContent | EditorPaneContent
  | PickerPaneContent | FreshAgentPaneContent | ExtensionPaneContent
```

Where code needs to accept legacy raw input, use `Record<string, unknown>` and `migrateLegacyFreshAgentContent` before casting to `PaneContent`.

- [ ] **Step 4: Keep one migration helper and make its output fresh-agent only**

In `shared/fresh-agent.ts`, keep `migrateLegacyFreshAgentContent` but ensure the legacy branch returns fresh-agent content:

```ts
if (input.kind !== 'agent-chat') {
  return input
}

const sessionType = normalizeFreshAgentSessionType(input.provider)
const provider = resolveFreshAgentRuntimeProvider(sessionType)
if (!sessionType || !provider) {
  return input
}

return {
  ...input,
  kind: 'fresh-agent',
  provider,
  sessionType,
}
```

- [ ] **Step 5: Remove live `agent-chat` branches from pane normalization**

In `src/store/panesSlice.ts`, remove `sanitizeAgentChatContent` and every branch that returns `{ kind: 'agent-chat' }`. In `sanitizePaneContent`, keep this fresh-agent branch after migration:

```ts
if (input.kind === 'fresh-agent') {
  const style = normalizeFreshAgentStyleOverride(input.style)
  return {
    kind: 'fresh-agent',
    sessionType: input.sessionType,
    provider: input.provider,
    sessionId: input.sessionId,
    createRequestId: input.createRequestId || nanoid(),
    status: input.status || 'creating',
    resumeSessionId: input.resumeSessionId,
    sessionRef: sanitizeSessionRef(input.sessionRef),
    serverInstanceId: typeof input.serverInstanceId === 'string' ? input.serverInstanceId : undefined,
    restoreError: RestoreErrorSchema.safeParse(input.restoreError).success
      ? RestoreErrorSchema.parse(input.restoreError)
      : undefined,
    initialCwd: input.initialCwd,
    createError: input.createError,
    modelSelection: normalizeAgentChatModelSelection(input.modelSelection, input.model),
    model: input.model,
    permissionMode: input.permissionMode,
    sandbox: input.sandbox,
    effort: normalizeAgentChatEffortOverride(input.effort),
    plugins: input.plugins,
    ...(style ? { style } : {}),
    settingsDismissed: input.settingsDismissed,
  }
}
```

- [ ] **Step 6: Remove live `agent-chat` acceptance from validation**

In `src/store/paneTreeValidation.ts`, delete the `case 'agent-chat'` branch. The `fresh-agent` branch must validate `sessionType`, `provider`, `createRequestId`, and `status`.

- [ ] **Step 7: Run pane tests**

Run:

```bash
npm run test:vitest -- test/unit/client/fresh-agent-pane-migration.test.ts test/unit/server/agent-layout-schema.test.ts test/unit/client/panesSlice.test.ts --run
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add shared/fresh-agent.ts src/store/paneTypes.ts src/store/panesSlice.ts src/store/paneTreeValidation.ts src/store/persistedState.ts src/store/storage-migration.ts src/store/persistMiddleware.ts src/components/TabsView.tsx test/unit/client/fresh-agent-pane-migration.test.ts test/unit/server/agent-layout-schema.test.ts
git commit -m "Remove live agent-chat pane type"
```

---

### Task 4: Remove Legacy Agent Redux And UI Branches

**Files:**
- Modify: `src/store/store.ts:1-64`
- Modify: `src/components/panes/PaneContainer.tsx:1-890`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/TabBar.tsx`
- Modify: `src/components/MobileTabStrip.tsx`
- Modify: `src/hooks/useAgentSessionTurnCompletion.ts:1-118`
- Modify: `src/lib/pane-activity.ts:1-360`
- Modify: `src/lib/derivePaneTitle.ts`
- Modify: `src/lib/deriveTabName.ts`
- Modify: `src/lib/coding-agent-detection.ts`
- Modify: `src/lib/tab-directory-preference.ts`
- Modify: `src/lib/tab-fallback-identity.ts`
- Delete: `src/components/agent-chat/AgentChatView.tsx`
- Delete: `src/components/agent-chat/AgentChatSettings.tsx`
- Delete: `src/components/agent-chat/ChatComposer.tsx`
- Delete: `src/components/agent-chat/CollapsedTurn.tsx`
- Delete: `src/components/agent-chat/MessageBubble.tsx`
- Delete: `src/components/agent-chat/PermissionBanner.tsx`
- Delete: `src/components/agent-chat/QuestionBanner.tsx`
- Delete: `src/components/agent-chat/ThinkingIndicator.tsx`
- Delete: `src/components/agent-chat/ToolBlock.tsx`
- Delete: `src/components/agent-chat/ToolStrip.tsx`
- Delete: `src/components/agent-chat/useStreamDebounce.ts`
- Delete: `src/store/agentChatSlice.ts`
- Delete: `src/store/agentChatThunks.ts`
- Delete: `src/store/agentChatTypes.ts`
- Delete: `test/unit/client/agentChatSlice.test.ts`
- Delete: `test/unit/client/ws-client-sdk.test.ts`
- Delete: `test/e2e/agent-chat-polish-flow.test.tsx`
- Delete: `test/e2e/agent-chat-capability-settings-flow.test.tsx`
- Delete: `test/e2e/agent-chat-restore-flow.test.tsx`
- Delete: `test/e2e/tool-coalesce.test.tsx`

- [ ] **Step 1: Write the failing no-agent-chat Redux/UI test**

Create `test/unit/client/fresh-agent-only-ui-state.test.ts`:

```ts
import { store } from '@/store/store'
import { isCodingAgentPane } from '@/lib/coding-agent-detection'

describe('fresh-agent only UI state', () => {
  it('does not mount legacy agentChat Redux state', () => {
    expect(Object.keys(store.getState())).not.toContain('agentChat')
  })

  it('recognizes fresh-agent panes as coding agents without accepting agent-chat panes', () => {
    expect(isCodingAgentPane({ kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude' } as never)).toBe(true)
    expect(isCodingAgentPane({ kind: 'agent-chat', provider: 'freshclaude' } as never)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm run test:vitest -- test/unit/client/fresh-agent-only-ui-state.test.ts --run
```

Expected: FAIL because `store.getState()` still includes `agentChat`.

- [ ] **Step 3: Remove `agentChat` reducer from root store**

In `src/store/store.ts`, delete:

```ts
import agentChatReducer from './agentChatSlice'
```

and delete this reducer entry:

```ts
agentChat: agentChatReducer,
```

- [ ] **Step 4: Remove `AgentChatView` render path**

In `src/components/panes/PaneContainer.tsx`, delete the `AgentChatView` import and delete this branch:

```tsx
if (content.kind === 'agent-chat') {
  return (
    <ErrorBoundary key={paneId} label="Chat">
      <AgentChatView
        tabId={tabId}
        paneId={paneId}
        paneContent={content}
        hidden={hidden}
      />
    </ErrorBoundary>
  )
}
```

Keep the existing `content.kind === 'fresh-agent'` branch unchanged except for any type errors caused by removed agent-chat types.

- [ ] **Step 5: Remove `agentChatSessions` selectors and branches from activity surfaces**

In `src/hooks/useAgentSessionTurnCompletion.ts`, remove `ChatSessionState`, `EMPTY_AGENT_CHAT_SESSIONS`, `agentChatSessions`, and the `else if (content.kind === 'agent-chat')` block. The loop should only handle:

```ts
if (content.kind !== 'fresh-agent') {
  continue
}
const session = content.sessionId
  ? freshAgentSessions[makeFreshAgentSessionKey({
    sessionType: content.sessionType,
    provider: content.provider,
    sessionId: content.sessionId,
  })]
  : undefined
sessionKey = resolveFreshAgentSessionKey(content, session)
isBusy = isFreshAgentBusy(content, session)
hasPending = hasWaitingItems(session)
```

In `src/lib/pane-activity.ts`, remove `ChatSessionState`, `isAgentChatBusy`, `resolveAgentChatSessionKey`, and the `content.kind === 'agent-chat'` branches. The projection input should no longer include `agentChatSessions`.

- [ ] **Step 6: Delete old UI and store files**

Run:

```bash
git rm -r src/components/agent-chat
git rm src/store/agentChatSlice.ts src/store/agentChatThunks.ts src/store/agentChatTypes.ts
```

- [ ] **Step 7: Convert or delete legacy-only tests**

Run:

```bash
git rm test/unit/client/agentChatSlice.test.ts test/unit/client/ws-client-sdk.test.ts test/e2e/agent-chat-polish-flow.test.tsx test/e2e/agent-chat-capability-settings-flow.test.tsx test/e2e/agent-chat-restore-flow.test.tsx test/e2e/tool-coalesce.test.tsx
```

The user-story coverage from these files is carried by existing and new fresh-agent tests:

```bash
npm run test:vitest -- test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/components/fresh-agent/FreshAgentItemCard.test.tsx --run
```

- [ ] **Step 8: Run client typecheck and focused UI tests**

Run:

```bash
npm run typecheck:client
npm run test:vitest -- test/unit/client/fresh-agent-only-ui-state.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx --run
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src test
git commit -m "Remove legacy agent-chat UI state"
```

---

### Task 5: Rename Capabilities To Fresh-Agent And Remove `/api/agent-chat/capabilities`

**Files:**
- Move: `shared/agent-chat-capabilities.ts` -> `shared/fresh-agent-capabilities.ts`
- Move: `src/lib/agent-chat-capabilities.ts` -> `src/lib/fresh-agent-capabilities.ts`
- Move: `server/agent-chat-capability-registry.ts` -> `server/fresh-agent/capability-registry.ts`
- Move: `server/agent-chat-capabilities-router.ts` -> `server/fresh-agent/capabilities-router.ts`
- Modify: `src/components/fresh-agent/FreshAgentSettingsButton.tsx`
- Modify: `src/components/panes/PaneContainer.tsx`
- Modify: `src/store/tabsSlice.ts`
- Modify: `src/lib/api.ts`
- Modify: `server/index.ts`
- Test: `test/integration/server/fresh-agent-capabilities-router.test.ts`
- Test: `test/unit/server/fresh-agent/capability-registry.test.ts`
- Delete: `test/integration/server/agent-chat-capabilities-router.test.ts`
- Delete: `test/unit/server/agent-chat-capability-registry.test.ts`

- [ ] **Step 1: Write the failing fresh-agent capabilities route test**

Create `test/integration/server/fresh-agent-capabilities-router.test.ts` by adapting the existing agent-chat capabilities router test to this route:

```ts
import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createFreshAgentCapabilitiesRouter } from '../../../server/fresh-agent/capabilities-router.js'
import { FreshAgentCapabilityRegistry } from '../../../server/fresh-agent/capability-registry.js'

describe('fresh-agent capabilities router', () => {
  it('serves capabilities from /api/fresh-agent/capabilities/:provider', async () => {
    const app = express()
    const registry = new FreshAgentCapabilityRegistry()
    app.use('/api/fresh-agent/capabilities', createFreshAgentCapabilitiesRouter({ registry }))

    const res = await request(app).get('/api/fresh-agent/capabilities/freshclaude').expect(200)

    expect(res.body.provider).toBe('freshclaude')
    expect(res.body.status).toMatch(/fresh|cached|unavailable/)
  })
})
```

- [ ] **Step 2: Run the route test and verify it fails**

Run:

```bash
npm run test:vitest -- test/integration/server/fresh-agent-capabilities-router.test.ts --run
```

Expected: FAIL because `server/fresh-agent/capabilities-router.js` does not exist.

- [ ] **Step 3: Move capability modules**

Run:

```bash
git mv shared/agent-chat-capabilities.ts shared/fresh-agent-capabilities.ts
git mv src/lib/agent-chat-capabilities.ts src/lib/fresh-agent-capabilities.ts
git mv server/agent-chat-capability-registry.ts server/fresh-agent/capability-registry.ts
git mv server/agent-chat-capabilities-router.ts server/fresh-agent/capabilities-router.ts
```

Rename exported symbols:

```ts
AgentChatCapabilityRegistry -> FreshAgentCapabilityRegistry
createAgentChatCapabilitiesRouter -> createFreshAgentCapabilitiesRouter
AgentChatProviderCapabilities -> FreshAgentProviderCapabilities
AgentChatProviderCapabilitiesState -> FreshAgentProviderCapabilitiesState
```

- [ ] **Step 4: Update API route helpers**

In `src/lib/api.ts`, replace legacy capability helper URLs with:

```ts
export async function getFreshAgentCapabilities(provider: string, options?: ApiRequestOptions) {
  return parseFreshAgentProviderCapabilities(
    await api.get(`/api/fresh-agent/capabilities/${encodeURIComponent(provider)}`, options),
  )
}

export async function refreshFreshAgentCapabilities(provider: string, options?: ApiRequestOptions) {
  return parseFreshAgentProviderCapabilities(
    await api.post(`/api/fresh-agent/capabilities/${encodeURIComponent(provider)}/refresh`, {}, options),
  )
}
```

- [ ] **Step 5: Update server mount**

In `server/index.ts`, replace:

```ts
app.use('/api/agent-chat/capabilities', createAgentChatCapabilitiesRouter({
  registry: agentChatCapabilityRegistry,
}))
```

with:

```ts
app.use('/api/fresh-agent/capabilities', createFreshAgentCapabilitiesRouter({
  registry: freshAgentCapabilityRegistry,
}))
```

Rename the local registry variable:

```ts
const freshAgentCapabilityRegistry = new FreshAgentCapabilityRegistry()
```

- [ ] **Step 6: Delete legacy capability tests**

Run:

```bash
git rm test/integration/server/agent-chat-capabilities-router.test.ts test/unit/server/agent-chat-capability-registry.test.ts
```

- [ ] **Step 7: Run focused capability tests**

Run:

```bash
npm run test:vitest -- test/integration/server/fresh-agent-capabilities-router.test.ts test/unit/server/fresh-agent/capability-registry.test.ts --run
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add shared src server test
git commit -m "Rename capabilities to fresh-agent"
```

---

### Task 6: Move Claude History Internals Under Fresh-Agent And Delete Legacy Timeline Route

**Files:**
- Move: `server/agent-timeline/history-source.ts` -> `server/fresh-agent/adapters/claude/history-source.ts`
- Move: `server/agent-timeline/ledger.ts` -> `server/fresh-agent/adapters/claude/history-ledger.ts`
- Move: `server/agent-timeline/service.ts` -> `server/fresh-agent/adapters/claude/history-service.ts`
- Move: `server/agent-timeline/types.ts` -> `server/fresh-agent/adapters/claude/history-types.ts`
- Delete: `server/agent-timeline/router.ts`
- Modify: `server/fresh-agent/adapters/claude/adapter.ts`
- Modify: `server/sdk-bridge.ts`
- Modify: `server/session-history-loader.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/index.ts`
- Move/modify tests from `test/unit/server/agent-timeline-*` to `test/unit/server/fresh-agent/claude-history-*`
- Modify: `test/unit/server/fresh-agent/claude-restore-contract.test.ts`
- Delete: `test/integration/server/agent-timeline-router.test.ts`

- [ ] **Step 1: Write the failing route-removal integration test**

Create `test/integration/server/fresh-agent-removes-legacy-routes.test.ts`:

```ts
import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createFreshAgentRouter } from '../../../server/fresh-agent/router.js'
import { FreshAgentRuntimeManager } from '../../../server/fresh-agent/runtime-manager.js'
import { createFreshAgentProviderRegistry } from '../../../server/fresh-agent/provider-registry.js'

describe('fresh-agent route centralization', () => {
  it('keeps fresh-agent thread routes and does not mount legacy agent-session timeline routes', async () => {
    const app = express()
    const registry = createFreshAgentProviderRegistry()
    const runtimeManager = new FreshAgentRuntimeManager(registry)
    app.use('/api', createFreshAgentRouter({ runtimeManager }))

    await request(app).get('/api/agent-sessions/session-1/timeline?revision=1').expect(404)
    const res = await request(app).get('/api/fresh-agent/threads/freshclaude/claude/session-1?revision=1')
    expect([404, 409, 503]).toContain(res.status)
    expect(res.status).not.toBe(404)
  })
})
```

- [ ] **Step 2: Run the route-removal test and verify it fails only on missing fresh history imports**

Run:

```bash
npm run test:vitest -- test/integration/server/fresh-agent-removes-legacy-routes.test.ts --run
```

Expected: FAIL until imports and route mounting are updated.

- [ ] **Step 3: Move Claude history files**

Run:

```bash
git mv server/agent-timeline/history-source.ts server/fresh-agent/adapters/claude/history-source.ts
git mv server/agent-timeline/ledger.ts server/fresh-agent/adapters/claude/history-ledger.ts
git mv server/agent-timeline/service.ts server/fresh-agent/adapters/claude/history-service.ts
git mv server/agent-timeline/types.ts server/fresh-agent/adapters/claude/history-types.ts
git rm server/agent-timeline/router.ts
rmdir server/agent-timeline
```

- [ ] **Step 4: Rename exported history symbols**

In moved files, rename these public symbols:

```ts
AgentHistorySource -> ClaudeFreshAgentHistorySource
createAgentHistorySource -> createClaudeFreshAgentHistorySource
AgentTimelineService -> ClaudeFreshAgentHistoryService
createAgentTimelineService -> createClaudeFreshAgentHistoryService
AgentTimelinePage -> ClaudeFreshAgentHistoryPage
AgentTimelineTurn -> ClaudeFreshAgentHistoryTurn
AgentTimelineItem -> ClaudeFreshAgentHistoryItem
RestoreResolutionError -> ClaudeFreshAgentHistoryResolutionError
RestoreStaleRevisionError -> ClaudeFreshAgentStaleHistoryRevisionError
```

Keep the cursor, revision, and chronological behavior identical to the existing service unless a fresh-agent test already expects a different order.

- [ ] **Step 5: Update imports**

Use this search to drive import updates:

```bash
rg -n "agent-timeline|createAgentTimelineService|AgentTimelineService|createAgentHistorySource|AgentHistorySource|RestoreStaleRevisionError|RestoreResolutionError|synthesizeDeterministicMessageId|createDurableMessageFingerprint|synthesizeLiveMessageId" server test shared src
```

Every production hit should import from `server/fresh-agent/adapters/claude/history-*` or use the new symbol names.

In `server/fresh-agent/adapters/claude/adapter.ts`, the top imports should become:

```ts
import {
  ClaudeFreshAgentHistoryResolutionError,
  ClaudeFreshAgentStaleHistoryRevisionError,
  createClaudeFreshAgentHistoryService,
  type ClaudeFreshAgentHistoryService,
} from './history-service.js'
import type { ClaudeFreshAgentHistorySource } from './history-source.js'
import { synthesizeLiveMessageId, type RestoreResolution } from './history-ledger.js'
```

- [ ] **Step 6: Remove legacy route mount**

In `server/index.ts`, delete:

```ts
app.use('/api', createAgentTimelineRouter({
  service: createAgentTimelineService({
    agentHistorySource,
  }),
}))
```

and delete imports for `createAgentTimelineRouter` and `createAgentTimelineService`.

- [ ] **Step 7: Move and update history tests**

Run:

```bash
git mv test/unit/server/agent-timeline-history-source.test.ts test/unit/server/fresh-agent/claude-history-source.test.ts
git mv test/unit/server/agent-timeline-include-bodies.test.ts test/unit/server/fresh-agent/claude-history-include-bodies.test.ts
git rm test/integration/server/agent-timeline-router.test.ts
```

Update imports in the moved tests to the new paths and symbol names from Step 4.

- [ ] **Step 8: Run focused server history tests**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/fresh-agent/claude-history-source.test.ts test/unit/server/fresh-agent/claude-history-include-bodies.test.ts test/unit/server/fresh-agent/claude-restore-contract.test.ts test/integration/server/fresh-agent-removes-legacy-routes.test.ts --run
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server test
git commit -m "Move Claude history under fresh-agent"
```

---

### Task 7: Remove Legacy Top-Level `sdk.*` Client WebSocket Contract

**Files:**
- Modify: `shared/ws-protocol.ts:465-970`
- Modify: `src/App.tsx:60-72`
- Modify: `src/App.tsx:1119-1123`
- Modify: `src/lib/fresh-agent-ws.ts:1-186`
- Delete: `src/lib/sdk-message-handler.ts`
- Modify: `server/ws-handler.ts`
- Test: `test/unit/client/fresh-agent-ws.test.ts`
- Test: `test/unit/server/ws-fresh-agent-contract.test.ts`
- Delete: `test/unit/server/ws-sdk-session-history-cache.test.ts`

- [ ] **Step 1: Write the fresh-agent transport client test**

Create `test/unit/client/fresh-agent-ws.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { handleFreshAgentMessage } from '@/lib/fresh-agent-ws'
import {
  sessionSnapshotReceived,
  sessionInit,
  setSessionStatus,
} from '@/store/freshAgentSlice'

describe('fresh-agent websocket transport', () => {
  it('handles fresh-agent session events without top-level sdk message handling', () => {
    const dispatch = vi.fn()

    const handled = handleFreshAgentMessage(dispatch as never, {
      type: 'freshAgent.event',
      sessionId: 'sess-1',
      sessionType: 'freshclaude',
      provider: 'claude',
      event: {
        type: 'freshAgent.session.snapshot',
        latestTurnId: 'turn-1',
        status: 'idle',
        revision: 4,
      },
    })

    expect(handled).toBe(true)
    expect(dispatch).toHaveBeenCalledWith(sessionSnapshotReceived({
      sessionId: 'sess-1',
      sessionType: 'freshclaude',
      provider: 'claude',
      latestTurnId: 'turn-1',
      status: 'idle',
      revision: 4,
      timelineSessionId: undefined,
      streamingActive: undefined,
      streamingText: undefined,
    }))
  })

  it('ignores legacy top-level sdk messages', () => {
    const dispatch = vi.fn()
    expect(handleFreshAgentMessage(dispatch as never, {
      type: 'sdk.session.init',
      sessionId: 'sess-1',
    })).toBe(false)
    expect(dispatch).not.toHaveBeenCalledWith(sessionInit(expect.anything()))
    expect(dispatch).not.toHaveBeenCalledWith(setSessionStatus(expect.anything()))
  })
})
```

- [ ] **Step 2: Run the client transport test and verify it fails**

Run:

```bash
npm run test:vitest -- test/unit/client/fresh-agent-ws.test.ts --run
```

Expected: FAIL because `freshAgent.session.snapshot` is not handled yet and `App` still imports `sdk-message-handler`.

- [ ] **Step 3: Update fresh-agent event names**

In `src/lib/fresh-agent-ws.ts`, change handled inner event names:

```ts
case 'freshAgent.session.snapshot':
case 'freshAgent.session.init':
case 'freshAgent.session.metadata':
case 'freshAgent.status':
case 'freshAgent.error':
```

Map them to the existing `freshAgentSlice` actions exactly as the old `sdk.*` inner events did.

- [ ] **Step 4: Remove top-level SDK handling from `App`**

In `src/App.tsx`, delete:

```ts
import { handleSdkMessage } from '@/lib/sdk-message-handler'
```

and replace:

```ts
handleFreshAgentMessage(dispatch, msg as Record<string, unknown>, ws)
// Legacy SDK message handling
handleSdkMessage(dispatch, msg as Record<string, unknown>, ws)
```

with:

```ts
handleFreshAgentMessage(dispatch, msg as Record<string, unknown>, ws)
```

- [ ] **Step 5: Translate server provider events before sending to clients**

In `server/ws-handler.ts`, add:

```ts
function normalizeFreshAgentProviderEvent(event: unknown): unknown {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return event
  const record = event as Record<string, unknown>
  switch (record.type) {
    case 'sdk.session.snapshot':
      return { ...record, type: 'freshAgent.session.snapshot' }
    case 'sdk.session.init':
      return { ...record, type: 'freshAgent.session.init' }
    case 'sdk.session.metadata':
      return { ...record, type: 'freshAgent.session.metadata' }
    case 'sdk.status':
      return { ...record, type: 'freshAgent.status' }
    case 'sdk.error':
      return { ...record, type: 'freshAgent.error' }
    default:
      return event
  }
}
```

Then in `freshAgentEventMessage`, change:

```ts
event,
```

to:

```ts
event: normalizeFreshAgentProviderEvent(event),
```

- [ ] **Step 6: Remove legacy top-level `sdk.*` message schemas and handlers**

In `shared/ws-protocol.ts`, remove client message schemas for:

```ts
sdk.create
sdk.attach
sdk.send
sdk.interrupt
sdk.kill
sdk.permission.respond
sdk.question.respond
```

Remove server message union variants for:

```ts
sdk.created
sdk.create.failed
sdk.session.snapshot
sdk.session.init
sdk.session.metadata
sdk.assistant
sdk.stream
sdk.result
sdk.permission.request
sdk.question.request
sdk.status
sdk.exited
sdk.error
```

In `server/ws-handler.ts`, delete the switch cases that handle those top-level client messages. Keep SDK bridge internals used by the Claude fresh-agent adapter.

- [ ] **Step 7: Delete legacy client handler**

Run:

```bash
git rm src/lib/sdk-message-handler.ts
git rm test/unit/server/ws-sdk-session-history-cache.test.ts
```

- [ ] **Step 8: Run websocket focused tests and typechecks**

Run:

```bash
npm run typecheck
npm run test:vitest -- test/unit/client/fresh-agent-ws.test.ts test/unit/server/ws-fresh-agent-contract.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --run
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add shared/ws-protocol.ts src/App.tsx src/lib/fresh-agent-ws.ts server/ws-handler.ts test src/lib
git commit -m "Remove legacy sdk websocket surface"
```

---

### Task 8: Update Fresh-Agent Creation, Picker, Sidebar, And Naming Code

**Files:**
- Modify: `src/components/panes/PanePicker.tsx:119-160`
- Modify: `src/components/panes/PaneContainer.tsx:575-665`
- Modify: `src/store/tabsSlice.ts:580-745`
- Modify: `src/lib/session-type-utils.ts:1-135`
- Modify: `src/lib/agent-chat-utils.ts` -> `src/lib/fresh-agent-provider-utils.ts`
- Modify: `src/lib/agent-chat-types.ts` -> `src/lib/fresh-agent-provider-types.ts`
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Modify: `src/components/context-menu/menu-defs.ts`
- Modify: `server/mcp/freshell-tool.ts`
- Test: `test/unit/client/components/panes/PanePicker.test.tsx`
- Test: `test/unit/client/tabsSlice.test.ts`
- Test: `test/unit/server/mcp/freshell-tool.test.ts`

- [ ] **Step 1: Write the picker and resume behavior tests**

In `test/unit/client/components/panes/PanePicker.test.tsx`, add:

```tsx
it('labels fresh clients without any agent-chat live option wording', () => {
  renderPanePicker({
    settings: {
      freshAgent: { enabled: true, defaultPlugins: [], providers: {} },
    },
    availableClis: { claude: true, codex: true, opencode: true },
    enabledProviders: ['claude', 'codex', 'opencode'],
  })

  expect(screen.getByRole('button', { name: /Freshclaude/i })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Freshcodex/i })).toBeInTheDocument()
  expect(screen.queryByText(/agent chat/i)).not.toBeInTheDocument()
})
```

In `test/unit/client/tabsSlice.test.ts`, add:

```ts
it('reopens Claude agent sessions as fresh-agent panes', () => {
  const state = tabsReducer(initialTabsState, reopenSession({
    provider: 'claude',
    sessionId: '00000000-0000-4000-8000-000000000111',
    sessionType: 'freshclaude',
    cwd: '/repo',
  }))

  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId)
  const content = activeTab?.layout?.type === 'leaf' ? activeTab.layout.content : undefined
  expect(content).toMatchObject({
    kind: 'fresh-agent',
    sessionType: 'freshclaude',
    provider: 'claude',
    resumeSessionId: '00000000-0000-4000-8000-000000000111',
    initialCwd: '/repo',
  })
})
```

- [ ] **Step 2: Run focused tests and verify failures**

Run:

```bash
npm run test:vitest -- test/unit/client/components/panes/PanePicker.test.tsx test/unit/client/tabsSlice.test.ts --run
```

Expected: FAIL on stale `agentChat` naming/imports or missing helper renames.

- [ ] **Step 3: Rename provider helper modules**

Run:

```bash
git mv src/lib/agent-chat-utils.ts src/lib/fresh-agent-provider-utils.ts
git mv src/lib/agent-chat-types.ts src/lib/fresh-agent-provider-types.ts
```

Rename exported names:

```ts
AgentChatProviderName -> FreshAgentProviderName
AgentChatProviderConfig -> FreshAgentProviderConfig
AgentChatProviderSettings -> FreshAgentProviderSettings
isAgentChatProviderName -> isFreshAgentProviderName
getAgentChatProviderConfig -> getFreshAgentProviderConfig
getAgentChatProviderLabel -> getFreshAgentProviderLabel
```

- [ ] **Step 4: Update picker naming and settings sources**

In `src/components/panes/PanePicker.tsx`, rename local variables:

```ts
const visibleFreshAgentConfigs = freshClientsEnabled ? getVisibleFreshAgentConfigs(featureFlags) : []
const freshAgentOptions: PickerOption[] = visibleFreshAgentConfigs
```

and update comments to use "fresh-agent" or "fresh clients", not "agent chat".

In `src/components/panes/PaneContainer.tsx`, use only:

```ts
const freshAgentSettings = useAppSelector(
  (s) => s.settings?.settings?.freshAgent
    ?? s.settings?.serverSettings?.freshAgent
)
```

and set:

```ts
const providerSettings = freshAgentSettings?.providers?.[type]
plugins: freshAgentType.runtimeProvider === 'claude' ? freshAgentSettings?.defaultPlugins : undefined,
```

- [ ] **Step 5: Update MCP instructions**

In `server/mcp/freshell-tool.ts`, replace the pane-kind sentence with:

```ts
- Pane kinds: terminal, editor, browser, fresh-agent (Claude/Codex/OpenCode/etc.), picker (transient).
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
npm run test:vitest -- test/unit/client/components/panes/PanePicker.test.tsx test/unit/client/tabsSlice.test.ts test/unit/server/mcp/freshell-tool.test.ts --run
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src server test
git commit -m "Update agent creation to fresh-agent naming"
```

---

### Task 9: Add Runtime Architecture Guard Against Legacy Agent Infrastructure

**Files:**
- Create: `test/unit/architecture/fresh-agent-only-runtime.test.ts`

- [ ] **Step 1: Create the architecture guard**

Create `test/unit/architecture/fresh-agent-only-runtime.test.ts`:

```ts
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

function rg(pattern: string, paths: string[]): string {
  try {
    return execFileSync('rg', ['-n', pattern, ...paths], {
      encoding: 'utf8',
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const status = (error as { status?: number }).status
    if (status === 1) return ''
    throw error
  }
}

describe('fresh-agent-only runtime architecture', () => {
  it('has no live agent-chat runtime imports, routes, pane kinds, or Redux state', () => {
    const output = rg(
      String.raw`agent-chat|agentChat|AgentChat|sdk\.create|sdk\.send|sdk\.attach|/api/agent-chat|/api/agent-sessions|createAgentTimelineRouter`,
      ['src', 'server', 'shared'],
    )
      .split('\n')
      .filter(Boolean)
      .filter((line) => !line.includes('migrateLegacyFreshAgentContent'))
      .filter((line) => !line.includes('legacy agentChat input'))
      .filter((line) => !line.includes('readLegacyAgentChatInput'))

    expect(output).toEqual([])
  })
})
```

This is an architecture contract, not a copy test: it prevents the deleted runtime surface from being reintroduced.

- [ ] **Step 2: Run the guard and verify it fails before cleanup is complete**

Run:

```bash
npm run test:vitest -- test/unit/architecture/fresh-agent-only-runtime.test.ts --run
```

Expected before Tasks 2-8 are complete: FAIL with remaining legacy references. Expected after Tasks 2-8: PASS.

- [ ] **Step 3: Remove remaining production references reported by the guard**

For every guard hit in `src`, `server`, or `shared`, either:

- Rename it to fresh-agent ownership if the code is still needed.
- Delete it if it supports only the removed live agent-chat UI, routes, Redux state, or top-level `sdk.*` WebSocket surface.
- Keep it only if it is one of the three explicit migration-boundary names allowed in the filter.

- [ ] **Step 4: Run the guard**

Run:

```bash
npm run test:vitest -- test/unit/architecture/fresh-agent-only-runtime.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/unit/architecture/fresh-agent-only-runtime.test.ts src server shared
git commit -m "Guard fresh-agent-only runtime architecture"
```

---

### Task 10: Build Thorough Browser Smoke Coverage

**Files:**
- Create: `test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts`
- Modify: `test/e2e-browser/helpers/test-server.ts` only if route mocks need fresh-agent capabilities support

- [ ] **Step 1: Add the browser smoke test**

Create `test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts`:

```ts
import { expect, test } from '../helpers/fixtures'
import { openPanePicker, selectPaneType } from '../helpers/pane-picker'

test.describe('fresh-agent centralization smoke', () => {
  test('creates fresh agent panes without rendering legacy agent-chat UI', async ({ page }) => {
    const legacyRequests: string[] = []
    page.on('request', (request) => {
      const url = request.url()
      if (url.includes('/api/agent-chat') || url.includes('/api/agent-sessions')) {
        legacyRequests.push(url)
      }
    })

    await page.goto('/')

    await openPanePicker(page)
    await selectPaneType(page, 'Freshclaude')
    await expect(page.locator('[data-context="fresh-agent"]')).toBeVisible()
    await expect(page.locator('[data-context="agent-chat"]')).toHaveCount(0)

    await page.getByRole('button', { name: /split/i }).click()
    await openPanePicker(page)
    await selectPaneType(page, 'Freshcodex')
    await expect(page.locator('[data-context="fresh-agent"]')).toHaveCount(2)

    await page.getByRole('button', { name: /split/i }).click()
    await openPanePicker(page)
    await selectPaneType(page, 'Freshopencode')
    await expect(page.locator('[data-context="fresh-agent"]')).toHaveCount(3)

    await expect.poll(() => legacyRequests).toEqual([])
  })

  test('migrates a legacy persisted agent-chat pane to fresh-agent before render', async ({ page }) => {
    await page.addInitScript(() => {
      const legacyLayout = {
        version: 7,
        activeTabId: 'tab-legacy',
        tabs: [{
          id: 'tab-legacy',
          title: 'Legacy FreshClaude',
          mode: 'shell',
          layout: {
            type: 'leaf',
            id: 'pane-legacy',
            content: {
              kind: 'agent-chat',
              provider: 'freshclaude',
              sessionId: 'legacy-live-session',
              createRequestId: 'legacy-request',
              status: 'idle',
              resumeSessionId: '00000000-0000-4000-8000-000000000123',
              initialCwd: '/tmp/freshell',
            },
          },
        }],
      }
      window.localStorage.setItem('freshell:persisted-layout', JSON.stringify(legacyLayout))
    })

    await page.goto('/')

    await expect(page.locator('[data-context="fresh-agent"]')).toBeVisible()
    await expect(page.locator('[data-context="agent-chat"]')).toHaveCount(0)
    const contentKind = await page.evaluate(() => {
      const raw = window.localStorage.getItem('freshell:persisted-layout')
      return raw ? JSON.parse(raw).tabs[0].layout.content.kind : null
    })
    expect(contentKind).toBe('fresh-agent')
  })

  test('uses fresh-agent settings and routes only', async ({ page, request }) => {
    const settingsResponse = await request.patch('/api/settings', {
      data: {
        freshAgent: {
          enabled: true,
          providers: {
            freshcodex: { style: 'serif' },
          },
        },
      },
    })
    expect(settingsResponse.ok()).toBeTruthy()
    const settings = await settingsResponse.json()
    expect(settings.freshAgent.providers.freshcodex.style).toBe('serif')
    expect(settings.agentChat).toBeUndefined()

    const legacyCapabilities = await request.get('/api/agent-chat/capabilities/freshclaude')
    expect(legacyCapabilities.status()).toBe(404)

    const legacyTimeline = await request.get('/api/agent-sessions/session-1/timeline?revision=1')
    expect(legacyTimeline.status()).toBe(404)

    const freshCapabilities = await request.get('/api/fresh-agent/capabilities/freshclaude')
    expect(freshCapabilities.status()).toBe(200)

    await page.goto('/')
    await page.getByRole('button', { name: /settings/i }).click()
    await expect(page.getByText('Fresh agent')).toBeVisible()
    await expect(page.getByText(/agent chat/i)).toHaveCount(0)
  })
})
```

- [ ] **Step 2: Run the new browser smoke test and verify it fails before implementation is complete**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts
```

Expected before Tasks 2-9 are complete: FAIL on legacy routes, legacy settings field, or legacy UI branch. Expected after Tasks 2-9: PASS.

- [ ] **Step 3: Run existing fresh-agent browser specs**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent.spec.ts test/e2e-browser/specs/fresh-agent-mobile.spec.ts test/e2e-browser/specs/freshopencode-db-history.spec.ts test/e2e-browser/specs/pane-activity-indicator.spec.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts test/e2e-browser/helpers/test-server.ts
git commit -m "Add fresh-agent centralization smoke coverage"
```

---

### Task 11: Full Cleanup Verification And Documentation Sweep

**Files:**
- Modify: `docs/index.html` if the mock still references old agent-chat naming or routes
- Modify: `README.md` only if it documents `/api/agent-chat/*`, `/api/agent-sessions/*`, or agent-chat pane behavior
- Modify or delete stale tests reported by the commands below

- [ ] **Step 1: Run production-source legacy scans**

Run:

```bash
rg -n "agent-chat|agentChat|AgentChat|/api/agent-chat|/api/agent-sessions|sdk\\.create|sdk\\.send|sdk\\.attach|createAgentTimelineRouter" src server shared docs/index.html README.md
```

Expected: no production-source hits except explicit one-time migration helper names:

```text
migrateLegacyFreshAgentContent
readLegacyAgentChatInput
legacy agentChat input
```

- [ ] **Step 2: Run focused fresh-agent and settings tests**

Run:

```bash
npm run test:vitest -- test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/components/fresh-agent/FreshAgentItemCard.test.tsx test/unit/client/fresh-agent-pane-migration.test.ts test/unit/client/fresh-agent-only-ui-state.test.ts test/unit/shared/settings.test.ts test/unit/architecture/fresh-agent-only-runtime.test.ts --run
```

Expected: PASS.

- [ ] **Step 3: Run focused server tests**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/fresh-agent/claude-history-source.test.ts test/unit/server/fresh-agent/claude-history-include-bodies.test.ts test/unit/server/fresh-agent/claude-restore-contract.test.ts test/unit/server/fresh-agent/claude-adapter.test.ts test/unit/server/fresh-agent/codex-adapter.test.ts test/unit/server/fresh-agent/opencode-adapter.test.ts test/integration/server/fresh-agent-capabilities-router.test.ts test/integration/server/fresh-agent-removes-legacy-routes.test.ts test/integration/server/settings-api.test.ts --run
```

Expected: PASS.

- [ ] **Step 4: Run typecheck, lint, and coordinated test suite**

Run:

```bash
npm run typecheck
npm run lint
FRESHELL_TEST_SUMMARY="fresh-agent centralization cleanup" npm run test
```

Expected: PASS.

- [ ] **Step 5: Run browser smoke**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts test/e2e-browser/specs/fresh-agent.spec.ts test/e2e-browser/specs/fresh-agent-mobile.spec.ts test/e2e-browser/specs/freshopencode-db-history.spec.ts test/e2e-browser/specs/pane-activity-indicator.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 7: Manual smoke on a worktree test server**

Start a disposable server from this worktree only:

```bash
PORT=3388 VITE_PORT=5188 npm run dev > /tmp/freshell-agent-cleanup-3388.log 2>&1 & echo $! > /tmp/freshell-agent-cleanup-3388.pid
```

Open it in Windows Chrome from WSL:

```bash
cmd.exe /c start "" chrome --new-tab http://localhost:5188
```

Exercise these flows manually:

```text
1. Open Freshclaude from the picker. Confirm the pane body has fresh-agent styling and no "agent-chat" UI text.
2. Open Freshcodex in a split. Confirm settings show the per-pane style dropdown and saving a style does not affect Freshclaude.
3. Open Freshopencode in a split. Confirm the pane initializes and no request to /api/agent-chat or /api/agent-sessions appears in DevTools Network.
4. Send a short user turn in one available fresh-agent pane. Confirm activity status appears, the transcript appends in styled fresh-agent UI, and the tab attention state changes on completion.
5. Hard refresh. Confirm all panes restore as fresh-agent panes and no white screen appears.
6. Open Settings. Confirm the section is named "Fresh agent" and the response body from /api/settings has freshAgent but no agentChat.
```

Stop only the recorded worktree server:

```bash
kill "$(cat /tmp/freshell-agent-cleanup-3388.pid)" && rm -f /tmp/freshell-agent-cleanup-3388.pid
```

- [ ] **Step 8: Commit final sweep**

```bash
git add docs/index.html README.md src server shared test
git commit -m "Complete fresh-agent centralization cleanup"
```

---

## Self-Review

**Spec coverage:** The user asked to do the migration at once, with no old clients preserved, and to include a comprehensive migration plus thorough smoke test. Tasks 1-9 remove old live code paths in one branch. Task 10 adds browser smoke for freshclaude, freshcodex, freshopencode, settings, legacy pane migration, route removal, and absence of legacy UI. Task 11 verifies scans, focused tests, full suite, build, browser e2e, and manual smoke.

**Placeholder scan:** The plan contains no forbidden placeholder language and no open-ended edge-case instructions. Each implementation task lists exact files, test code or exact commands, and the expected result.

**Type consistency:** Canonical names are `freshAgent` for settings, `fresh-agent` for pane kind and route namespace, `FreshAgentCapabilityRegistry` for capabilities, and `ClaudeFreshAgentHistoryService` for moved Claude history. The only allowed legacy identifiers after implementation are migration-boundary names: `migrateLegacyFreshAgentContent`, `readLegacyAgentChatInput`, and explanatory test strings for legacy input conversion.
