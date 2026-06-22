# Settings UI Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the new Settings information architecture: Coding Agents, Panes, Naming, Network, Workspace, Appearance, and Advanced, with concise coding-agent enablement and no user-facing Extensions or global Fresh-agent Settings section.

**Architecture:** Keep the existing settings schema where possible, split the current large settings sections into focused React components, and wire section tabs from `SettingsView`. CLI agent switches continue to update `codingCli.enabledProviders`; Fresh-agent switches use the existing `freshAgent.enabled` gate plus per-session IDs in `extensions.disabled`, and the pane picker is updated to honor those per-session IDs.

**Tech Stack:** React 18, Redux Toolkit, TypeScript, Vitest + Testing Library, Playwright for screenshot inspection, existing Freshell settings APIs.

---

## File Structure

- Modify `src/components/SettingsView.tsx`: replace the old tab list and content switch with `Appearance`, `Coding Agents`, `Panes`, `Workspace`, `Naming`, `Network`, and `Advanced`; remove the visible Manage Extensions card.
- Create `src/components/settings/CodingAgentsSettings.tsx`: render one compact row per coding-agent surface with monochrome SVG icon, name, and switch.
- Create `src/components/settings/PanesSettings.tsx`: own pane behavior, tab completion, notifications, and editor settings, including the existing custom editor command conditional input.
- Create `src/components/settings/NamingSettings.tsx`: replace `AISettings` in the shell with the auto-naming focused label and copy.
- Create `src/components/settings/NetworkSettings.tsx`: move remote access, firewall repair, device link, and confirmation modal logic out of `SafetySettings`.
- Create `src/components/settings/RuntimeSettings.tsx`: move auto-kill and default working directory validation into Advanced as "Runtime".
- Create `src/components/settings/DevicesSettings.tsx`: move known-device rename/delete rows into Advanced.
- Modify `src/components/settings/AdvancedSettings.tsx`: keep terminal internals/debugging and render Runtime and Devices below it.
- Modify `src/components/settings/WorkspaceSettings.tsx`: leave only Sidebar and Keyboard shortcuts.
- Modify `src/components/panes/PanePicker.tsx`: hide Fresh-agent picker entries when their session type is in `extensions.disabled`.
- Modify `src/components/settings/settings-controls.tsx`: make rows and controls give dropdowns/segmented controls sufficient right-side breathing room and keep switches vertically aligned.
- Modify tests under `test/unit/client/components/SettingsView*.test.tsx` and `test/unit/client/components/panes/PanePicker.test.tsx`: update expectations to the new tabs and moved sections.
- Modify `test/e2e/network-setup.test.tsx`: update jsdom e2e navigation from removed `Safety` tab to `Network`.
- Modify `test/e2e/settings-devices-flow.test.tsx`: update jsdom e2e navigation/assertions now that `Network` and `Devices` live on separate tabs.
- Modify `test/unit/client/components/component-edge-cases.test.tsx`: update default-working-directory tests from removed `Safety` tab to `Advanced`.
- Modify `test/e2e-browser/specs/settings.spec.ts`: update Playwright settings smoke coverage from old `AI`/`Safety` tabs to new `Naming`/`Network` tabs.
- Modify `docs/index.html`: keep the static mock aligned with the shipped UI.

---

### Task 1: Lock the New Settings Shell With Failing Tests

**Files:**
- Modify: `test/unit/client/components/settings-view-test-utils.tsx`
- Modify: `test/unit/client/components/SettingsView.core.test.tsx`

- [ ] **Step 1: Update the settings tab helper type**

Replace the old `SettingsTab` union in `test/unit/client/components/settings-view-test-utils.tsx` with:

```ts
export type SettingsTab =
  | 'Appearance'
  | 'Coding Agents'
  | 'Panes'
  | 'Workspace'
  | 'Naming'
  | 'Network'
  | 'Advanced'
```

- [ ] **Step 2: Add failing shell tests**

In `test/unit/client/components/SettingsView.core.test.tsx`, update `renders tab buttons for all sections` so it expects only these labels:

```ts
it('renders tab buttons for the shipped settings sections', () => {
  const store = createSettingsViewStore()
  renderSettingsView(store)

  const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent?.trim())
  expect(tabs).toEqual([
    'Appearance',
    'Coding Agents',
    'Panes',
    'Workspace',
    'Naming',
    'Network',
    'Advanced',
  ])
  expect(screen.queryByRole('button', { name: /manage extensions/i })).not.toBeInTheDocument()
})
```

Update old tab-switching tests so they click and assert the new section homes:

```ts
it('switches to Coding Agents tab on click', () => {
  const store = createSettingsViewStore()
  renderSettingsView(store)

  fireEvent.click(screen.getByRole('tab', { name: 'Coding Agents' }))

  expect(screen.getByRole('heading', { name: 'Coding Agents' })).toBeInTheDocument()
})

it('switches to Panes tab on click', () => {
  const store = createSettingsViewStore()
  renderSettingsView(store)

  fireEvent.click(screen.getByRole('tab', { name: 'Panes' }))

  expect(screen.getByRole('heading', { name: 'Pane behavior' })).toBeInTheDocument()
  expect(screen.getByText('Editor pane')).toBeInTheDocument()
})

it('switches to Naming tab on click', () => {
  const store = createSettingsViewStore()
  renderSettingsView(store)

  fireEvent.click(screen.getByRole('tab', { name: 'Naming' }))

  expect(screen.getByRole('heading', { name: 'Naming' })).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'AI' })).not.toBeInTheDocument()
})

it('switches to Network tab on click', () => {
  const store = createSettingsViewStore()
  renderSettingsView(store)

  fireEvent.click(screen.getByRole('tab', { name: 'Network' }))

  expect(screen.getByRole('heading', { name: 'Network' })).toBeInTheDocument()
  expect(screen.getByText(/remote access/i)).toBeInTheDocument()
})

it('switches to Advanced tab on click', () => {
  const store = createSettingsViewStore()
  renderSettingsView(store)

  fireEvent.click(screen.getByRole('tab', { name: 'Advanced' }))

  expect(screen.getByRole('heading', { name: 'Advanced' })).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'Safety' })).not.toBeInTheDocument()
})
```

Leave the existing Workspace tab switch test focused on the Sidebar and terminal preview removal during Task 1. Do not assert `Notifications` absence until Task 4, because the Notifications section still lives in Workspace until `PanesSettings` is implemented.

```ts
it('switches to Workspace tab on click', () => {
  const store = createSettingsViewStore()
  renderSettingsView(store)

  fireEvent.click(screen.getByRole('tab', { name: 'Workspace' }))

  expect(screen.getByRole('heading', { name: 'Sidebar' })).toBeInTheDocument()
  expect(screen.getByText('Session list and navigation')).toBeInTheDocument()
  expect(screen.queryByTestId('terminal-preview')).not.toBeInTheDocument()
})
```

Leave the existing current-value test that reads auto-kill on `Safety` until Task 5 moves Runtime into Advanced. Do not change it in Task 1, because Advanced does not contain Runtime until later.

```ts
it('displays safety settings values', () => {
  const store = createSettingsViewStore({ settings: { safety: { autoKillIdleMinutes: 120 } } })
  renderSettingsView(store)
  switchSettingsTab('Safety')

  expect(screen.getByText('120')).toBeInTheDocument()
})
```

- [ ] **Step 3: Run the failing shell tests**

Run:

```bash
npm run test:vitest -- test/unit/client/components/SettingsView.core.test.tsx --run
```

Expected: fails because the production `SettingsView` still exposes the old tab labels and Manage Extensions card.

---

### Task 2: Implement the Settings Shell and Shared Row Polish

**Files:**
- Modify: `src/components/SettingsView.tsx`
- Modify: `src/components/settings/settings-controls.tsx`
- Create: `src/components/settings/CodingAgentsSettings.tsx`
- Create: `src/components/settings/PanesSettings.tsx`
- Create: `src/components/settings/NamingSettings.tsx`
- Create: `src/components/settings/NetworkSettings.tsx`

- [ ] **Step 1: Add temporary section stubs before rewiring**

Create `src/components/settings/CodingAgentsSettings.tsx`:

```tsx
import type { SettingsSectionProps } from './settings-types'
import { SettingsSection } from './settings-controls'

export default function CodingAgentsSettings(_props: SettingsSectionProps) {
  return <SettingsSection id="coding-agents" title="Coding Agents">Coming soon</SettingsSection>
}
```

Create `src/components/settings/PanesSettings.tsx`:

```tsx
import type { SettingsSectionProps } from './settings-types'
import { SettingsSection } from './settings-controls'

export default function PanesSettings(_props: SettingsSectionProps) {
  return (
    <>
      <SettingsSection id="panes" title="Pane behavior">Coming soon</SettingsSection>
      <SettingsSection title="Editor pane">Coming soon</SettingsSection>
    </>
  )
}
```

Create `src/components/settings/NamingSettings.tsx`:

```tsx
import type { SettingsSectionProps } from './settings-types'
import { SettingsSection } from './settings-controls'

export default function NamingSettings(_props: SettingsSectionProps) {
  return <SettingsSection id="naming" title="Naming">Coming soon</SettingsSection>
}
```

Create `src/components/settings/NetworkSettings.tsx`:

```tsx
import type { AppView } from '@/components/Sidebar'
import type { SettingsSectionProps } from './settings-types'
import { SettingsSection } from './settings-controls'

export interface NetworkSettingsProps extends SettingsSectionProps {
  onNavigate?: (view: AppView) => void
  onFirewallTerminal?: (cmd: { tabId: string; command: string }) => void
  onSharePanel?: () => void
}

export default function NetworkSettings(_props: NetworkSettingsProps) {
  return <SettingsSection id="network" title="Network">Remote access</SettingsSection>
}
```

These stubs are intentionally short-lived. They prevent Vite import-resolution failures while later tasks fill each section with real content.

- [ ] **Step 2: Replace the section list and imports in `SettingsView`**

Use these imports:

```ts
import AppearanceSettings from '@/components/settings/AppearanceSettings'
import WorkspaceSettings from '@/components/settings/WorkspaceSettings'
import AdvancedSettings from '@/components/settings/AdvancedSettings'
import CodingAgentsSettings from '@/components/settings/CodingAgentsSettings'
import PanesSettings from '@/components/settings/PanesSettings'
import NamingSettings from '@/components/settings/NamingSettings'
import NetworkSettings from '@/components/settings/NetworkSettings'
```

Remove these imports when deleting the Manage Extensions card:

```ts
import { Puzzle, ChevronRight } from 'lucide-react'
import { useEnsureExtensionsRegistry } from '@/hooks/useEnsureExtensionsRegistry'
```

Also remove the now-dead hook call from the component body:

```ts
useEnsureExtensionsRegistry()
```

Use this section list:

```ts
const sections = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'coding-agents', label: 'Coding Agents' },
  { id: 'panes', label: 'Panes' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'naming', label: 'Naming' },
  { id: 'network', label: 'Network' },
  { id: 'advanced', label: 'Advanced' },
] as const
```

Remove the visible Manage Extensions button/card from `SettingsView`.

- [ ] **Step 3: Replace the tab panel switch**

Render the new panels:

```tsx
<div role="tabpanel" aria-label={`${activeSection} settings`}>
  {activeSection === 'appearance' && <AppearanceSettings {...sectionProps} />}
  {activeSection === 'coding-agents' && <CodingAgentsSettings {...sectionProps} />}
  {activeSection === 'panes' && <PanesSettings {...sectionProps} />}
  {activeSection === 'workspace' && <WorkspaceSettings {...sectionProps} />}
  {activeSection === 'naming' && <NamingSettings {...sectionProps} />}
  {activeSection === 'network' && (
    <NetworkSettings
      {...sectionProps}
      onNavigate={onNavigate}
      onFirewallTerminal={onFirewallTerminal}
      onSharePanel={onSharePanel}
    />
  )}
  {activeSection === 'advanced' && <AdvancedSettings {...sectionProps} />}
</div>
```

- [ ] **Step 4: Polish shared controls**

In `SettingsRow`, keep rows stable and give controls right padding:

```tsx
<div className="flex w-full flex-col items-start gap-2 md:flex-row md:items-center md:justify-between md:gap-6">
  {description ? (
    <div className="min-w-0 flex flex-col gap-0.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-xs text-muted-foreground/60">{description}</span>
    </div>
  ) : (
    <span className="min-w-0 text-sm text-muted-foreground">{label}</span>
  )}
  <div className="w-full pr-1 md:w-auto md:pr-2">{children}</div>
</div>
```

In `Toggle`, add `inline-flex shrink-0 items-center` to the button class so switch thumbs align vertically with row text:

```ts
'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors'
```

In `SegmentedControl`, add a minimum width and keep wrapping stable:

```ts
'flex w-full min-w-0 flex-wrap rounded-md bg-muted p-0.5 md:w-auto md:min-w-[12rem]'
```

- [ ] **Step 5: Run shell tests again**

Run:

```bash
npm run test:vitest -- test/unit/client/components/SettingsView.core.test.tsx --run
```

Expected: shell tests pass because all imported section components now exist and render the headings the shell tests need.

---

### Task 3: Add Coding Agents Settings and Pane Picker Filtering

**Files:**
- Modify: `src/components/settings/CodingAgentsSettings.tsx`
- Modify: `src/components/panes/PanePicker.tsx`
- Modify: `test/unit/client/components/SettingsView.agent-chat.test.tsx`
- Modify: `test/unit/client/components/panes/PanePicker.test.tsx`

- [ ] **Step 1: Replace Fresh-agent settings tests with concise Coding Agents tests**

Replace `SettingsView.agent-chat.test.tsx` with tests that assert:

```ts
describe('SettingsView coding agents settings', () => {
  it('renders compact rows for CLI and Fresh coding agents', () => {
    const store = createSettingsViewStore()
    renderSettingsView(store)
    switchSettingsTab('Coding Agents')

    expect(screen.getByRole('heading', { name: 'Coding Agents' })).toBeInTheDocument()
    for (const name of [
      'Claude CLI',
      'Freshclaude',
      'Codex CLI',
      'Freshcodex',
      'OpenCode',
      'Freshopencode',
      'Gemini',
      'Kimi',
    ]) {
      expect(screen.getByRole('switch', { name })).toBeInTheDocument()
    }
    expect(screen.queryByText('Show thinking')).not.toBeInTheDocument()
    expect(screen.queryByText('Show tools')).not.toBeInTheDocument()
    expect(screen.queryByText('Show timecodes & model')).not.toBeInTheDocument()
    expect(screen.queryByText('Font size')).not.toBeInTheDocument()
  })

  it('toggles CLI agents through codingCli.enabledProviders', async () => {
    const store = createSettingsViewStore({
      settings: { codingCli: { enabledProviders: ['claude', 'codex'] } },
    })
    renderSettingsView(store)
    switchSettingsTab('Coding Agents')

    fireEvent.click(screen.getByRole('switch', { name: 'Codex CLI' }))

    expect(store.getState().settings.settings.codingCli.enabledProviders).toEqual(['claude'])
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.patch).toHaveBeenCalledWith('/api/settings', {
      codingCli: { enabledProviders: ['claude'] },
    })
  })

  it('toggles one Fresh agent independently through extensions.disabled', async () => {
    const store = createSettingsViewStore({
      settings: {
        freshAgent: { enabled: true },
        agentChat: { enabled: true },
        extensions: { disabled: ['freshcodex'] },
      },
    })
    renderSettingsView(store)
    switchSettingsTab('Coding Agents')

    expect(screen.getByRole('switch', { name: 'Freshcodex' })).not.toBeChecked()
    fireEvent.click(screen.getByRole('switch', { name: 'Freshcodex' }))

    expect(store.getState().settings.settings.extensions.disabled).not.toContain('freshcodex')
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.patch).toHaveBeenCalledWith('/api/settings', {
      freshAgent: { enabled: true },
      agentChat: { enabled: true },
      extensions: { disabled: [] },
    })
  })

  it('turns on only the selected Fresh agent from the default all-off state', async () => {
    const store = createSettingsViewStore()
    renderSettingsView(store)
    switchSettingsTab('Coding Agents')

    fireEvent.click(screen.getByRole('switch', { name: 'Freshcodex' }))

    expect(store.getState().settings.settings.freshAgent.enabled).toBe(true)
    expect(store.getState().settings.settings.extensions.disabled).toEqual(
      expect.arrayContaining(['freshclaude', 'freshopencode']),
    )
    expect(store.getState().settings.settings.extensions.disabled).not.toContain('freshcodex')
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.patch).toHaveBeenCalledWith('/api/settings', {
      freshAgent: { enabled: true },
      agentChat: { enabled: true },
      extensions: { disabled: ['freshclaude', 'freshopencode'] },
    })
  })
})
```

- [ ] **Step 2: Implement `CodingAgentsSettings`**

Create a compact component with this behavior:

```tsx
import { useMemo } from 'react'
import { ClaudeIcon, CodexIcon, FreshclaudeIcon, GeminiIcon, KimiIcon, OpencodeIcon } from '@/components/icons/provider-icons'
import type { CodingCliProviderName } from '@/lib/coding-cli-types'
import type { SettingsSectionProps } from './settings-types'
import { SettingsSection, Toggle } from './settings-controls'

type AgentRow =
  | { kind: 'cli'; id: CodingCliProviderName; label: string; icon: React.ComponentType<{ className?: string }> }
  | { kind: 'fresh'; id: 'freshclaude' | 'freshcodex' | 'freshopencode'; label: string; icon: React.ComponentType<{ className?: string }> }

const AGENT_ROWS: AgentRow[] = [
  { kind: 'cli', id: 'claude', label: 'Claude CLI', icon: ClaudeIcon },
  { kind: 'fresh', id: 'freshclaude', label: 'Freshclaude', icon: FreshclaudeIcon },
  { kind: 'cli', id: 'codex', label: 'Codex CLI', icon: CodexIcon },
  { kind: 'fresh', id: 'freshcodex', label: 'Freshcodex', icon: CodexIcon },
  { kind: 'cli', id: 'opencode', label: 'OpenCode', icon: OpencodeIcon },
  { kind: 'fresh', id: 'freshopencode', label: 'Freshopencode', icon: OpencodeIcon },
  { kind: 'cli', id: 'gemini', label: 'Gemini', icon: GeminiIcon },
  { kind: 'cli', id: 'kimi', label: 'Kimi', icon: KimiIcon },
]

export default function CodingAgentsSettings({ settings, applyServerSetting }: SettingsSectionProps) {
  const enabledProviders = settings.codingCli?.enabledProviders ?? []
  const disabledItems = settings.extensions?.disabled ?? []
  const freshEnabled = settings.freshAgent?.enabled ?? settings.agentChat?.enabled ?? false
  const freshIds = useMemo(
    () => AGENT_ROWS.filter((row): row is Extract<AgentRow, { kind: 'fresh' }> => row.kind === 'fresh').map((row) => row.id),
    [],
  )

  const setCliEnabled = (id: CodingCliProviderName, enabled: boolean) => {
    const next = enabled
      ? Array.from(new Set([...enabledProviders, id]))
      : enabledProviders.filter((provider) => provider !== id)
    applyServerSetting({ codingCli: { enabledProviders: next } })
  }

  const setFreshEnabled = (id: Extract<AgentRow, { kind: 'fresh' }>['id'], enabled: boolean) => {
    const disabledSet = new Set(disabledItems)
    if (enabled && !freshEnabled) {
      for (const freshId of freshIds) {
        if (freshId !== id) disabledSet.add(freshId)
      }
    }
    if (enabled) {
      disabledSet.delete(id)
    } else {
      disabledSet.add(id)
    }
    const nextDisabled = Array.from(disabledSet)
    const anyFreshEnabled = freshIds.some((freshId) => !disabledSet.has(freshId))
    applyServerSetting({
      freshAgent: { enabled: anyFreshEnabled },
      agentChat: { enabled: anyFreshEnabled },
      extensions: { disabled: nextDisabled },
    })
  }

  return (
    <SettingsSection id="coding-agents" title="Coding Agents">
      <div className="space-y-2">
        {AGENT_ROWS.map((row) => {
          const Icon = row.icon
          const checked = row.kind === 'cli'
            ? enabledProviders.includes(row.id)
            : freshEnabled && !disabledItems.includes(row.id)
          return (
            <div key={`${row.kind}-${row.id}`} className="flex min-h-12 items-center justify-between gap-4 rounded-md border border-border/30 px-3 py-2">
              <div className="flex min-w-0 items-center gap-3">
                <Icon className="h-5 w-5 shrink-0 text-foreground" />
                <span className="truncate text-sm font-medium">{row.label}</span>
              </div>
              <Toggle
                checked={checked}
                aria-label={row.label}
                onChange={(next) => {
                  if (row.kind === 'cli') setCliEnabled(row.id, next)
                  else setFreshEnabled(row.id, next)
                }}
              />
            </div>
          )
        })}
      </div>
    </SettingsSection>
  )
}
```

- [ ] **Step 3: Update PanePicker Fresh filtering**

In `PanePicker`, add a helper:

```ts
function isFreshAgentSessionDisabled(sessionType: string, disabledItems: readonly string[]): boolean {
  return disabledItems.includes(sessionType)
}
```

Apply it to both Fresh-agent sources:

```ts
.filter((config) => !isFreshAgentSessionDisabled(config.name, disabledExtensions))
```

and:

```ts
.filter((entry) => !isFreshAgentSessionDisabled(entry.sessionType, disabledExtensions))
```

Keep the existing runtime provider filter:

```ts
.filter((entry) => availableClis[entry.runtimeProvider] && enabledProviders.includes(entry.runtimeProvider) && !disabledExtensions.includes(entry.runtimeProvider))
```

- [ ] **Step 4: Add PanePicker regression tests**

Add tests to `PanePicker.test.tsx` that preload `extensions.disabled` through the test store and verify:

```ts
it('hides a Fresh-agent picker entry disabled by session type without hiding its CLI', () => {
  renderPicker({
    availableClis: { claude: true, codex: true },
    enabledProviders: ['claude', 'codex'],
    extensions: defaultCliExtensions,
    freshClientsEnabled: true,
    disabledExtensions: ['freshcodex'],
  })

  expect(screen.getByRole('button', { name: 'Freshclaude' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Codex CLI' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Freshcodex' })).not.toBeInTheDocument()
})
```

If `createStore` does not yet accept `disabledExtensions`, add it to the helper and preload:

```ts
settings: {
  settings: {
    ...
    extensions: { disabled: overrides?.disabledExtensions ?? [] },
  },
  loaded: true,
  lastSavedAt: null,
},
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm run test:vitest -- test/unit/client/components/SettingsView.agent-chat.test.tsx test/unit/client/components/panes/PanePicker.test.tsx --run
```

Expected: pass.

---

### Task 4: Move Panes, Editor, Notifications, Workspace, and Naming

**Files:**
- Modify: `src/components/settings/PanesSettings.tsx`
- Modify: `src/components/settings/NamingSettings.tsx`
- Modify: `src/components/settings/WorkspaceSettings.tsx`
- Delete: `src/components/settings/AISettings.tsx`
- Create: `test/unit/client/components/SettingsView.naming.test.tsx`
- Modify: `test/unit/client/components/SettingsView.panes.test.tsx`
- Modify: `test/unit/client/components/SettingsView.editor.test.tsx`
- Modify: `test/unit/client/components/SettingsView.behavior.test.tsx`

- [ ] **Step 1: Create `PanesSettings`**

Move the current `WorkspaceSettings` Panes section, Notifications section, and Editor section into `PanesSettings`. The component must accept `SettingsSectionProps`, keep the existing `Default new pane`, `Snap distance`, `Icons on tabs`, `Multi-row tabs`, `Tab completion indicator`, `Dismiss attention on`, `Sound on completion`, `External editor`, and conditional `Custom command` rows, and retain the existing `applyLocalSetting`, `applyServerSetting`, and `scheduleServerTextSettingSave` calls.

The headings should be:

```tsx
<SettingsSection id="panes" title="Pane behavior">
...
<SettingsSection title="Editor pane">
```

- [ ] **Step 2: Trim `WorkspaceSettings`**

Remove Panes, Notifications, Fresh agent, and Editor sections from `WorkspaceSettings`. Leave only:

```tsx
<SettingsSection id="workspace" title="Sidebar" description="Session list and navigation">
...
</SettingsSection>

<SettingsSection title="Keyboard shortcuts" description="Navigation and terminal">
...
</SettingsSection>
```

Remove now-unused imports from `WorkspaceSettings`:

```ts
SessionOpenMode
TabAttentionStyle
AttentionDismiss
FRESH_AGENT_FONT_SCALE_OPTIONS
FRESH_AGENT_FONT_SCALE_DEFAULT
SegmentedControl
RangeSlider
```

- [ ] **Step 3: Create `NamingSettings`**

Create a replacement for `AISettings` with naming-focused labels:

```tsx
import type { SettingsSectionProps } from './settings-types'
import { SettingsSection, SettingsRow, Toggle } from './settings-controls'

export default function NamingSettings({
  settings,
  applyServerSetting,
  scheduleServerTextSettingSave,
}: SettingsSectionProps) {
  return (
    <SettingsSection id="naming" title="Naming" description="Automatic session titles">
      <SettingsRow label="Gemini API key" description="Used for automatic session titles.">
        <input
          type="password"
          value={settings.ai?.geminiApiKey || ''}
          placeholder="Enter Gemini API key"
          onChange={(e) => {
            const key = e.target.value || undefined
            scheduleServerTextSettingSave('ai.geminiApiKey', { ai: { geminiApiKey: key } })
          }}
          className="h-10 w-full rounded-md border-0 bg-muted px-3 text-sm focus:outline-none focus:ring-1 focus:ring-border md:h-8"
        />
      </SettingsRow>
      <SettingsRow label="Auto-generate session titles">
        <Toggle
          checked={settings.sidebar?.autoGenerateTitles ?? true}
          onChange={(checked) => {
            applyServerSetting({ sidebar: { autoGenerateTitles: checked } })
          }}
          aria-label="Auto-generate session titles"
        />
      </SettingsRow>
      <SettingsRow label="Naming prompt" description="Instructions sent to Gemini for generated session titles.">
        <textarea
          value={settings.ai?.titlePrompt || ''}
          placeholder={'Generate a short title (3-8 words) for a coding assistant conversation.\nThe title should describe the task or topic, not the tool being used.\nReturn ONLY the title text. No quotes, no markdown, no explanation.'}
          onChange={(e) => {
            const prompt = e.target.value || undefined
            scheduleServerTextSettingSave('ai.titlePrompt', { ai: { titlePrompt: prompt } })
          }}
          rows={4}
          className="w-full rounded-md border-0 bg-muted px-3 py-2 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-border"
        />
      </SettingsRow>
    </SettingsSection>
  )
}
```

- [ ] **Step 4: Update tests to use new homes**

Update every `switchSettingsTab('Workspace')` that is testing pane/editor/notification behavior to `switchSettingsTab('Panes')`.

Update `SettingsView.core.test.tsx`'s Workspace tab switch test after moving Notifications:

```ts
expect(screen.getByText('Keyboard shortcuts')).toBeInTheDocument()
expect(screen.queryByText('Notifications')).not.toBeInTheDocument()
```

Update `SettingsView.panes.test.tsx`'s section-rendering assertion so it proves the section heading, not just the tab button:

```ts
expect(screen.getByRole('heading', { name: 'Pane behavior' })).toBeInTheDocument()
```

Update every `switchSettingsTab('Safety')` that is testing default working directory or auto-kill to `switchSettingsTab('Advanced')`.

Update naming-related tests to use `switchSettingsTab('Naming')` and assert `Naming prompt` instead of `Title prompt`.

Create `test/unit/client/components/SettingsView.naming.test.tsx` with direct behavior coverage:

```ts
import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, screen } from '@testing-library/react'
import {
  createSettingsViewStore,
  installSettingsViewHooks,
  renderSettingsView,
  switchSettingsTab,
} from './settings-view-test-utils'

vi.mock('@/lib/api', () => ({
  api: {
    patch: vi.fn().mockResolvedValue({}),
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}))

import { api } from '@/lib/api'

installSettingsViewHooks({ fakeTimers: true, mockFonts: true })

describe('SettingsView naming settings', () => {
  it('renders naming controls without the old AI heading', () => {
    const store = createSettingsViewStore()
    renderSettingsView(store)
    switchSettingsTab('Naming')

    expect(screen.getByRole('heading', { name: 'Naming' })).toBeInTheDocument()
    expect(screen.getByText('Gemini API key')).toBeInTheDocument()
    expect(screen.getByText('Auto-generate session titles')).toBeInTheDocument()
    expect(screen.getByText('Naming prompt')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'AI' })).not.toBeInTheDocument()
  })

  it('debounces Gemini API key saves', async () => {
    const store = createSettingsViewStore()
    renderSettingsView(store)
    switchSettingsTab('Naming')

    fireEvent.change(screen.getByPlaceholderText('Enter Gemini API key'), {
      target: { value: 'gemini-key' },
    })

    expect(store.getState().settings.settings.ai.geminiApiKey).toBe('gemini-key')
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(api.patch).toHaveBeenCalledWith('/api/settings', {
      ai: { geminiApiKey: 'gemini-key' },
    })
  })

  it('toggles automatic session titles through server settings', async () => {
    const store = createSettingsViewStore({
      settings: { sidebar: { autoGenerateTitles: true } },
    })
    renderSettingsView(store)
    switchSettingsTab('Naming')

    fireEvent.click(screen.getByRole('switch', { name: 'Auto-generate session titles' }))

    expect(store.getState().settings.settings.sidebar.autoGenerateTitles).toBe(false)
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.patch).toHaveBeenCalledWith('/api/settings', {
      sidebar: { autoGenerateTitles: false },
    })
  })

  it('debounces naming prompt saves', async () => {
    const store = createSettingsViewStore()
    renderSettingsView(store)
    switchSettingsTab('Naming')

    fireEvent.change(screen.getByPlaceholderText(/Generate a short title/), {
      target: { value: 'Name this session tersely.' },
    })

    expect(store.getState().settings.settings.ai.titlePrompt).toBe('Name this session tersely.')
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(api.patch).toHaveBeenCalledWith('/api/settings', {
      ai: { titlePrompt: 'Name this session tersely.' },
    })
  })
})
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm run test:vitest -- test/unit/client/components/SettingsView.panes.test.tsx test/unit/client/components/SettingsView.editor.test.tsx test/unit/client/components/SettingsView.behavior.test.tsx test/unit/client/components/SettingsView.naming.test.tsx --run
```

Expected: pass.

---

### Task 5: Split Network, Runtime, Devices, and Advanced

**Files:**
- Modify: `src/components/settings/NetworkSettings.tsx`
- Create: `src/components/settings/RuntimeSettings.tsx`
- Create: `src/components/settings/DevicesSettings.tsx`
- Modify: `src/components/settings/AdvancedSettings.tsx`
- Delete: `src/components/settings/SafetySettings.tsx`
- Modify: `test/unit/client/components/SettingsView.network-access.test.tsx`
- Modify: `test/unit/client/components/SettingsView.terminal-advanced.test.tsx`
- Modify: `test/unit/client/components/SettingsView.behavior.test.tsx`
- Modify: `test/e2e/network-setup.test.tsx`
- Modify: `test/e2e/settings-devices-flow.test.tsx`
- Modify: `test/unit/client/components/component-edge-cases.test.tsx`
- Modify: `test/e2e-browser/specs/settings.spec.ts`

- [ ] **Step 1: Create `NetworkSettings`**

Move the network access logic from `SafetySettings` into `NetworkSettings`. Keep:

```ts
SETTINGS_FIREWALL_POLL_INTERVAL_MS
SETTINGS_FIREWALL_POLL_MAX_ATTEMPTS
getFirewallDescription
isFirewallRefreshInProgress
shouldShowFirewallFix
getErrorMessage
PendingConfirmation
FirewallState
```

Keep these UI rows under:

```tsx
<SettingsSection id="network" title="Network" description="Remote access for this Freshell server">
```

Rows and behavior must remain:
- `Remote access` switch.
- Conditional `Firewall` row with `Fix` button.
- Conditional `Device access` row with `Get link`.
- Dev-mode restart warning.
- Admin approval `ConfirmModal`.

- [ ] **Step 2: Create `RuntimeSettings`**

Move auto-kill and default working directory validation from `SafetySettings` into:

```tsx
<SettingsSection title="Runtime" description="Process lifetime and launch defaults">
```

Preserve the debounce and validation behavior:

```ts
api.post<{ valid: boolean }>('/api/files/validate-dir', { path: trimmed })
```

Preserve save calls:

```ts
applyServerSetting({ safety: { autoKillIdleMinutes: v } })
applyServerSetting({ defaultCwd: nextValue })
```

- [ ] **Step 3: Create `DevicesSettings`**

Move known-device alias/delete logic into:

```tsx
<SettingsSection title="Devices" description="Rename devices for the Tabs workspace. Remote device aliases apply only on this machine.">
```

Preserve `buildKnownDevices`, `persistOwnDeviceLabel`, `persistDeviceAliasesForDevices`, `dismissDeviceIds`, and the `Save`/`Delete` button behavior.

- [ ] **Step 4: Update `AdvancedSettings`**

Render Advanced as a fragment with three settings groups:

```tsx
<>
  <SettingsSection id="advanced" title="Advanced" description="Terminal internals and debugging">
    ...
  </SettingsSection>
  <RuntimeSettings settings={settings} applyLocalSetting={applyLocalSetting} applyServerSetting={applyServerSetting} scheduleServerTextSettingSave={scheduleServerTextSettingSave} />
  <DevicesSettings settings={settings} applyLocalSetting={applyLocalSetting} applyServerSetting={applyServerSetting} scheduleServerTextSettingSave={scheduleServerTextSettingSave} />
</>
```

Add `scheduleServerTextSettingSave` to the destructured props even though Runtime can use direct `applyServerSetting`; this keeps prop forwarding simple and type-consistent.

- [ ] **Step 5: Update tests to use new tabs**

In `SettingsView.network-access.test.tsx`, replace every:

```ts
switchSettingsTab('Safety')
```

with:

```ts
switchSettingsTab('Network')
```

In behavior tests for default cwd, auto-kill, and devices, switch to:

```ts
switchSettingsTab('Advanced')
```

Update `SettingsView.core.test.tsx`'s current-value test after moving Runtime:

```ts
it('displays runtime settings values', () => {
  const store = createSettingsViewStore({ settings: { safety: { autoKillIdleMinutes: 120 } } })
  renderSettingsView(store)
  switchSettingsTab('Advanced')

  expect(screen.getByText('120')).toBeInTheDocument()
})
```

In `test/e2e/network-setup.test.tsx`, replace the helper that opens Safety:

```ts
fireEvent.click(screen.getByRole('tab', { name: /^network$/i }))
```

Then keep the remote-access assertions on the Network tab.

In `test/e2e/settings-devices-flow.test.tsx`, split the old combined Safety assertions into two navigations and keep device textbox assertions multi-match safe:

```ts
fireEvent.click(screen.getByRole('tab', { name: /^network$/i }))
expect(screen.getByRole('heading', { name: /^network$/i })).toBeInTheDocument()
expect(screen.getByRole('switch', { name: /remote access/i })).toBeInTheDocument()

fireEvent.click(screen.getByRole('tab', { name: /^advanced$/i }))
expect(screen.getByRole('heading', { name: /^devices$/i })).toBeInTheDocument()
expect(screen.getAllByLabelText(/device name/i).length).toBeGreaterThan(0)
```

In `test/unit/client/components/component-edge-cases.test.tsx`, replace every:

```ts
fireEvent.click(screen.getByRole('tab', { name: 'Safety' }))
```

with:

```ts
fireEvent.click(screen.getByRole('tab', { name: 'Advanced' }))
```

and keep the default-working-directory assertions unchanged.

In `test/e2e-browser/specs/settings.spec.ts`, update the tab smoke assertions:

```ts
await expect(page.getByRole('tab', { name: /^Naming$/i })).toBeVisible()
await expect(page.getByRole('tab', { name: /^Network$/i })).toBeVisible()
await expect(page.getByRole('tab', { name: /^Safety$/i })).toHaveCount(0)
await expect(page.getByRole('tab', { name: /^AI$/i })).toHaveCount(0)
```

Assert old labels are gone from the shell:

```ts
expect(screen.queryByRole('tab', { name: 'Safety' })).not.toBeInTheDocument()
expect(screen.queryByRole('heading', { name: 'Safety' })).not.toBeInTheDocument()
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
npm run test:vitest -- test/unit/client/components/SettingsView.network-access.test.tsx test/unit/client/components/SettingsView.terminal-advanced.test.tsx test/unit/client/components/SettingsView.behavior.test.tsx --run
```

Expected: pass.

- [ ] **Step 7: Run jsdom e2e settings consumers**

Run:

```bash
npm run test:vitest -- test/e2e/network-setup.test.tsx test/e2e/settings-devices-flow.test.tsx --run
```

Expected: pass.

- [ ] **Step 8: Run the additional settings edge-case unit file**

Run:

```bash
npm run test:vitest -- test/unit/client/components/component-edge-cases.test.tsx --run
```

Expected: pass.

---

### Task 6: Keep Static Prototype Aligned

**Files:**
- Modify: `docs/index.html`

- [ ] **Step 1: Verify the static mock still reflects production**

Check that the static mock has the same tabs:

```text
Appearance
Coding Agents
Panes
Workspace
Naming
Network
Advanced
```

Check Coding Agents rows:

```text
Claude CLI
Freshclaude
Codex CLI
Freshcodex
OpenCode
Freshopencode
Gemini
Kimi
```

Check there is no user-facing Settings text for:

```text
Extensions
Manage Extensions
Fresh agent
Safety
AI
Built-in panes
```

- [ ] **Step 2: Update any drift**

If the static mock differs from the production settings component names or grouping, update `docs/index.html` so it matches.

- [ ] **Step 3: Run static checks**

Run:

```bash
git diff --check
```

Expected: no whitespace errors.

---

### Task 7: Verification, Test Server, and Screenshot Inspection

**Files:**
- No source edits expected unless verification catches issues.

- [ ] **Step 1: Run focused unit coverage**

Run:

```bash
npm run test:vitest -- test/unit/client/components/SettingsView.core.test.tsx test/unit/client/components/SettingsView.agent-chat.test.tsx test/unit/client/components/SettingsView.panes.test.tsx test/unit/client/components/SettingsView.editor.test.tsx test/unit/client/components/SettingsView.network-access.test.tsx test/unit/client/components/SettingsView.terminal-advanced.test.tsx test/unit/client/components/SettingsView.behavior.test.tsx test/unit/client/components/SettingsView.naming.test.tsx test/unit/client/components/panes/PanePicker.test.tsx test/unit/client/components/component-edge-cases.test.tsx test/e2e/network-setup.test.tsx test/e2e/settings-devices-flow.test.tsx --run
```

Expected: pass.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: pass.

- [ ] **Step 3: Run the Playwright settings smoke spec**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/settings.spec.ts
```

Expected: pass.

- [ ] **Step 4: Build and start an isolated production test server**

Use a unique port, build the worktree, and record the PID:

```bash
npm run build
PORT=3379 npm start > /tmp/freshell-new-settings-ui-3379.log 2>&1 & echo $! > /tmp/freshell-new-settings-ui-3379.pid
```

Expected: build passes, `npm start` returns control immediately because it is backgrounded, and the PID file exists. Use `npm start`, not `node dist/server/index.js`, so `NODE_ENV=production` is set and the server serves the built client.

- [ ] **Step 5: Inspect each settings subpage with Playwright without toggling controls**

Use Playwright against `http://127.0.0.1:3379`. The production server serves the built client on this port. Open Settings, click each tab, take screenshots into `/tmp`, and for each tab run a separate DOM/layout assertion:

```ts
const expectedTabs = ['Appearance', 'Coding Agents', 'Panes', 'Workspace', 'Naming', 'Network', 'Advanced']
const forbiddenSettingsText = ['Manage Extensions', 'Fresh agent', 'Safety', 'AI', 'Built-in panes']
```

Validate each tab separately:
- Appearance: terminal preview visible, Cursor blink row switch center aligns with row midpoint within 6 px.
- Coding Agents: exactly eight agent rows, each row has one SVG, one name, one switch, and no descriptions/settings density.
- Panes: Pane behavior and Editor pane visible, no Built-in panes inventory, tab completion segmented control has at least 6 px right-side buffer.
- Workspace: Sidebar and Keyboard shortcuts visible, no Panes, Fresh agent, Editor pane, Network, or Devices sections.
- Naming: Gemini API key, Auto-generate session titles, Naming prompt visible; no `AI` heading.
- Network: Remote access visible, Firewall/Get link rows are conditional only; no Devices section.
- Advanced: Advanced, Runtime, and Devices visible; no Safety heading; Auto-kill slider displays a valid value.

- [ ] **Step 6: Stop only the isolated test server**

Before stopping, verify the PID belongs to this worktree:

```bash
ps -fp "$(cat /tmp/freshell-new-settings-ui-3379.pid)"
```

Then stop it:

```bash
kill "$(cat /tmp/freshell-new-settings-ui-3379.pid)" && rm -f /tmp/freshell-new-settings-ui-3379.pid
```

- [ ] **Step 7: Run broad verification if focused checks and screenshots pass**

Inspect coordinator status:

```bash
npm run test:status
```

If the coordinator is available, run:

```bash
FRESHELL_TEST_SUMMARY="settings ui refactor verification" npm run check
```

Expected: pass.

---

### Task 8: Final Review Loop

**Files:**
- No source edits expected unless review catches issues.

- [ ] **Step 1: Commit the completed implementation**

Run:

```bash
git status --short
git add src/components/SettingsView.tsx src/components/settings src/components/panes/PanePicker.tsx test/unit/client/components test/e2e/network-setup.test.tsx test/e2e/settings-devices-flow.test.tsx test/e2e-browser/specs/settings.spec.ts docs/index.html docs/superpowers/plans/2026-06-12-settings-ui-refactor.md
git commit -m "refactor settings tabs and coding agent controls"
```

- [ ] **Step 2: Run Fresh Eyes up to five times**

Use the `fresheyes` skill with this scope:

```text
Review the changes between origin/main and this branch using git diff origin/main...HEAD.
```

If the verdict fails, fix the blocking issues, rerun focused verification, commit the fix, and run Fresh Eyes again. Stop after the first pass or after five attempts, whichever comes first.

- [ ] **Step 3: Report considerations requiring product attention**

After fixes, report only remaining product decisions, such as whether per-agent Fresh switches should eventually move from `extensions.disabled` into a first-class `freshAgent.enabledSessionTypes` schema field.
Also report that the shipped UI intentionally removes global Fresh-agent display controls from Settings, and that Coding Agents currently shows the product's fixed set of agent surfaces rather than deriving rows only from installed CLI extension registry entries.

---

## Self-Review

**Spec coverage:** The plan covers the requested Settings refactor, Coding Agents as its own section, Panes as its own section, Naming replacing AI, Network as its own tab, Safety/Devices moved into Advanced, concise coding-agent rows, monochrome SVG icons, no static built-in pane inventory, dropdown/control buffer, cursor switch alignment, test-server screenshots, and Fresh Eyes review loops.

**Placeholder scan:** No `TBD`, `TODO`, or "write tests for the above" placeholders remain. Each task names exact files, code snippets, commands, and expected results.

**Type consistency:** Section ids match `SettingsView` tab ids. Test helper `SettingsTab` includes all tabs used by tests. Fresh session ids match `FRESH_AGENT_REGISTRY` visible rows: `freshclaude`, `freshcodex`, `freshopencode`.
