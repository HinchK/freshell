import { configureStore } from '@reduxjs/toolkit'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FreshAgentSettingsButton } from '@/components/fresh-agent/FreshAgentSettingsButton'
import { useAppSelector } from '@/store/hooks'
import panesReducer, { initLayout } from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'

const saveServerSettingsPatchSpy = vi.hoisted(() => vi.fn((patch: unknown) => ({
  type: 'settings/saveServerSettingsPatch',
  payload: patch,
})))

const getFreshAgentModelCapabilitiesSpy = vi.hoisted(() => vi.fn())

vi.mock('@/store/settingsThunks', () => ({
  saveServerSettingsPatch: (patch: unknown) => saveServerSettingsPatchSpy(patch),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    getFreshAgentModelCapabilities: (...args: unknown[]) => getFreshAgentModelCapabilitiesSpy(...args),
  }
})

const CATALOG_RESPONSE = {
  ok: true as const,
  sessionType: 'freshopencode' as const,
  runtimeProvider: 'opencode' as const,
  status: 'fresh' as const,
  fetchedAt: 1_234,
  models: [
    {
      id: 'opencode-go/glm-5.2',
      displayName: 'GLM 5.2',
      provider: 'opencode' as const,
      source: { id: 'opencode-go', displayName: 'OpenCode Go' },
      supportsEffort: true,
      supportedEffortLevels: ['low', 'high', 'max'],
      supportsAdaptiveThinking: true,
    },
    {
      id: 'deepseek/deepseek-v4-pro',
      displayName: 'DeepSeek V4 Pro',
      provider: 'opencode' as const,
      source: { id: 'deepseek', displayName: 'DeepSeek' },
      supportsEffort: true,
      supportedEffortLevels: ['low', 'high'],
      supportsAdaptiveThinking: true,
    },
  ],
}

const CLAUDE_CATALOG_RESPONSE = {
  ok: true as const,
  sessionType: 'freshclaude' as const,
  runtimeProvider: 'claude' as const,
  status: 'fresh' as const,
  fetchedAt: 1_234,
  models: [
    {
      id: 'opus[1m]',
      displayName: 'Opus (1M context)',
      provider: 'claude' as const,
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high'],
      supportsAdaptiveThinking: true,
    },
    {
      id: 'sonnet',
      displayName: 'Sonnet',
      provider: 'claude' as const,
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high'],
      supportsAdaptiveThinking: false,
    },
  ],
}

function createStore() {
  return configureStore({
    reducer: {
      panes: panesReducer,
      settings: settingsReducer,
    },
  })
}

function seedPane(
  store: ReturnType<typeof createStore>,
  content: Record<string, unknown>,
) {
  store.dispatch(initLayout({
    tabId: 'tab-1',
    paneId: 'pane-1',
    content: {
      kind: 'fresh-agent',
      createRequestId: 'req-settings',
      sessionId: 'thread-settings',
      status: 'idle',
      ...content,
    },
  }))
}

function StoreBackedFreshAgentSettingsButton({
  tabId,
  paneId,
}: {
  tabId: string
  paneId: string
}) {
  const paneContent = useAppSelector((state) => {
    const layout = state.panes.layouts[tabId]
    if (!layout || layout.type !== 'leaf' || layout.id !== paneId || layout.content.kind !== 'fresh-agent') {
      throw new Error(`Missing fresh-agent pane ${paneId}`)
    }
    return layout.content
  })
  return <FreshAgentSettingsButton tabId={tabId} paneId={paneId} paneContent={paneContent} />
}

function renderButton(store: ReturnType<typeof createStore>) {
  return render(
    <Provider store={store}>
      <StoreBackedFreshAgentSettingsButton tabId="tab-1" paneId="pane-1" />
    </Provider>,
  )
}

beforeEach(() => {
  saveServerSettingsPatchSpy.mockClear()
  getFreshAgentModelCapabilitiesSpy.mockReset()
  getFreshAgentModelCapabilitiesSpy.mockResolvedValue(CATALOG_RESPONSE)
  window.localStorage.removeItem('freshopencode.modelMru.v2')
  window.localStorage.removeItem('freshcodex.modelMru.v2')
  window.localStorage.removeItem('freshopencode.modelLevelMru.v1')
  window.localStorage.removeItem('freshcodex.modelLevelMru.v1')
})

afterEach(() => {
  cleanup()
})

describe('FreshAgentSettingsButton', () => {
  it('keeps the simple model radio list and Thinking dropdown for freshclaude', () => {
    const store = createStore()
    seedPane(store, {
      sessionType: 'freshclaude',
      provider: 'claude',
      model: 'claude-opus-4-6',
      effort: 'high',
    })

    renderButton(store)
    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))

    expect(screen.getByRole('radio', { name: 'Claude Opus 4.6' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Thinking level' })).toBeInTheDocument()
    // the shared dialog path is not offered to freshclaude
    expect(screen.queryByRole('button', { name: /Change/ })).not.toBeInTheDocument()
  })

  it('merges the probed claude catalog (aliases included) into the freshclaude model radio list', async () => {
    getFreshAgentModelCapabilitiesSpy.mockResolvedValue(CLAUDE_CATALOG_RESPONSE)
    const store = createStore()
    seedPane(store, {
      sessionType: 'freshclaude',
      provider: 'claude',
      model: 'claude-opus-4-6',
      effort: 'high',
      initialCwd: '/repo/project-b',
    })

    renderButton(store)
    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))

    await waitFor(() => {
      expect(getFreshAgentModelCapabilitiesSpy).toHaveBeenCalledTimes(1)
    })
    expect(getFreshAgentModelCapabilitiesSpy).toHaveBeenCalledWith('freshclaude', expect.objectContaining({ cwd: '/repo/project-b' }))

    // statics render instantly and stay first; probed rows swap in when the fetch resolves
    expect(screen.getByRole('radio', { name: 'Claude Opus 4.6' })).toBeInTheDocument()
    expect(await screen.findByRole('radio', { name: 'Opus (1M context)' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Sonnet' })).toBeInTheDocument()

    // one row per unique id: 1 static + 2 probed
    expect(screen.getAllByRole('radio')).toHaveLength(3)
    // the checked radio is the persisted static model
    expect(screen.getByRole('radio', { name: 'Claude Opus 4.6' })).toBeChecked()
  })

  it('fires exactly one capabilities fetch for a kilroy popover via its claude provider', async () => {
    getFreshAgentModelCapabilitiesSpy.mockResolvedValue({
      ...CLAUDE_CATALOG_RESPONSE,
      sessionType: 'kilroy',
    })
    const store = createStore()
    seedPane(store, {
      sessionType: 'kilroy',
      provider: 'claude',
      model: 'claude-opus-4-6',
      effort: 'high',
    })

    renderButton(store)
    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))

    await waitFor(() => {
      expect(getFreshAgentModelCapabilitiesSpy).toHaveBeenCalledTimes(1)
    })
    expect(getFreshAgentModelCapabilitiesSpy).toHaveBeenCalledWith('kilroy', expect.anything())
    expect(await screen.findByRole('radio', { name: 'Opus (1M context)' })).toBeInTheDocument()
  })

  it('shows a compact Model row for freshcodex and retires the radio list and Thinking dropdown', () => {
    const store = createStore()
    seedPane(store, {
      sessionType: 'freshcodex',
      provider: 'codex',
      model: 'gpt-5.5',
      effort: 'max',
    })

    renderButton(store)
    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))

    expect(screen.getByRole('button', { name: /GPT-5\.5 · max.*Change/ })).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: 'GPT-5.4 Flash' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Thinking level' })).not.toBeInTheDocument()
  })

  it('opens the shared dialog from the freshcodex Change… button and persists the committed choice', async () => {
    const store = createStore()
    seedPane(store, {
      sessionType: 'freshcodex',
      provider: 'codex',
      model: 'gpt-5.5',
      effort: 'max',
    })

    renderButton(store)
    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))
    fireEvent.click(screen.getByRole('button', { name: /Change/ }))

    await screen.findByRole('dialog', { name: 'Model and thinking level' })
    fireEvent.click(screen.getByRole('option', { name: /GPT-5\.4 Flash/ }))
    const levelsList = screen.getByRole('listbox', { name: 'Thinking levels for GPT-5.4 Flash' })
    const lowOption = Array.from(levelsList.querySelectorAll('[role="option"]')).find((el) => el.textContent?.includes('low'))
    expect(lowOption).toBeDefined()
    fireEvent.click(lowOption!)
    fireEvent.click(screen.getByRole('button', { name: 'Use GPT-5.4 Flash · low' }))

    await waitFor(() => {
      expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
        freshAgent: {
          providers: {
            freshcodex: {
              modelSelection: { kind: 'exact', modelId: 'gpt-5.4-flash' },
              effort: 'low',
            },
          },
        },
      })
    })
    expect(screen.queryByRole('dialog', { name: 'Model and thinking level' })).not.toBeInTheDocument()
  })

  it('shows a compact Model row for freshopencode fed by the live catalog, and opens the dialog from Change…', async () => {
    const store = createStore()
    seedPane(store, {
      sessionType: 'freshopencode',
      provider: 'opencode',
      model: 'opencode-go/glm-5.2',
      effort: 'max',
      initialCwd: '/repo/project-a',
    })

    renderButton(store)
    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))

    expect(await screen.findByRole('button', { name: /GLM 5\.2 · max.*Change/ })).toBeInTheDocument()
    expect(getFreshAgentModelCapabilitiesSpy).toHaveBeenCalledWith('freshopencode', expect.objectContaining({ cwd: '/repo/project-a' }))
    // retired: recent-model tiles and the modal search entry point
    expect(screen.queryByRole('searchbox', { name: /Search enabled models/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Use model:/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Thinking level' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Change/ }))
    expect(await screen.findByRole('dialog', { name: 'Model and thinking level' })).toBeInTheDocument()
    expect(screen.getByRole('searchbox', { name: 'Filter models' })).toBeInTheDocument()
  })

  it('replaces the freshopencode Model row with the unavailable notice when the catalog probe fails', async () => {
    getFreshAgentModelCapabilitiesSpy.mockRejectedValue(new Error('network down'))
    const store = createStore()
    seedPane(store, {
      sessionType: 'freshopencode',
      provider: 'opencode',
      model: 'opencode-go/glm-5.2',
      effort: 'max',
      initialCwd: '/repo/project-a',
    })

    renderButton(store)
    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))

    expect(await screen.findByText('Model catalog unavailable — try again')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Change/ })).not.toBeInTheDocument()
  })
})
