import { describe, expect, it } from 'vitest'
import {
  buildFreshAgentVisibleMru,
  loadFreshAgentModelLevelMru,
  loadFreshAgentModelMru,
  recordFreshAgentModelLevelUse,
  recordFreshAgentModelUse,
  resolveFreshAgentModelLastUsedLevel,
} from '@/lib/freshopencode-model-mru'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
}

const capability = (id: string, displayName = id, provider: 'opencode' | 'codex' = 'opencode') => ({
  id,
  displayName,
  provider,
  source: { id: id.split('/')[0], displayName: id.split('/')[0] },
  supportsEffort: true,
  supportedEffortLevels: ['high'],
  supportsAdaptiveThinking: true,
})

const capabilities = {
  sessionType: 'freshopencode',
  runtimeProvider: 'opencode',
  status: 'fresh',
  fetchedAt: 1_000,
  models: [
    capability('opencode-go/current', 'Current'),
    capability('opencode-go/a', 'Alpha'),
    capability('opencode-go/b', 'Beta'),
  ],
} as const

describe('fresh-agent model MRU', () => {
  it('records unique verified entries with display metadata, cwd scope, and most recent first', () => {
    const storage = memoryStorage()
    recordFreshAgentModelUse('freshopencode', capability('opencode-go/a', 'Alpha'), '/repo/a', 1_000, storage)
    recordFreshAgentModelUse('freshopencode', capability('opencode-go/b', 'Beta'), '/repo/a', 2_000, storage)
    recordFreshAgentModelUse('freshopencode', capability('opencode-go/a', 'Alpha'), '/repo/a', 3_000, storage)

    expect(loadFreshAgentModelMru('freshopencode', storage)).toEqual([
      {
        id: 'opencode-go/a',
        displayName: 'Alpha',
        source: { id: 'opencode-go', displayName: 'opencode-go' },
        cwdKey: '/repo/a',
        lastVerifiedAt: 3_000,
      },
      {
        id: 'opencode-go/b',
        displayName: 'Beta',
        source: { id: 'opencode-go', displayName: 'opencode-go' },
        cwdKey: '/repo/a',
        lastVerifiedAt: 2_000,
      },
    ])
  })

  it('keeps the freshopencode storage key stable and isolates freshcodex into its own key', () => {
    const storage = memoryStorage()
    recordFreshAgentModelUse('freshopencode', capability('opencode-go/a', 'Alpha'), '/repo/a', 1_000, storage)
    recordFreshAgentModelUse('freshcodex', capability('gpt-5.5', 'GPT-5.5', 'codex'), '/repo/a', 2_000, storage)

    expect(loadFreshAgentModelMru('freshopencode', storage).map((entry) => entry.id)).toEqual(['opencode-go/a'])
    expect(loadFreshAgentModelMru('freshcodex', storage).map((entry) => entry.id)).toEqual(['gpt-5.5'])
    expect(storage.getItem('freshopencode.modelMru.v2')).toContain('opencode-go/a')
    expect(storage.getItem('freshcodex.modelMru.v2')).toContain('gpt-5.5')
  })

  it('renders same-cwd cached MRU immediately before the live catalog resolves', () => {
    const entries = [
      { id: 'opencode-go/current', displayName: 'Current', source: { id: 'opencode-go', displayName: 'opencode-go' }, cwdKey: '/repo/a', lastVerifiedAt: 1_000 },
      { id: 'opencode-go/a', displayName: 'Alpha', source: { id: 'opencode-go', displayName: 'opencode-go' }, cwdKey: '/repo/a', lastVerifiedAt: 1_000 },
      { id: 'opencode-go/b', displayName: 'Beta', source: { id: 'opencode-go', displayName: 'opencode-go' }, cwdKey: '/repo/b', lastVerifiedAt: 1_000 },
    ]

    expect(buildFreshAgentVisibleMru('freshopencode', {
      currentModelId: 'opencode-go/current',
      cwdKey: '/repo/a',
      entries,
      capabilities: undefined,
      now: 1_000,
      maxVisible: 3,
    }).map((entry) => [entry.model.id, entry.stale])).toEqual([
      ['opencode-go/current', true],
      ['opencode-go/a', true],
    ])
  })

  it('reconstructs stale cached entries with the runtime provider matching the MRU scope', () => {
    const entries = [
      { id: 'gpt-5.5', displayName: 'GPT-5.5', source: { id: 'openai', displayName: 'openai' }, cwdKey: '/repo/a', lastVerifiedAt: 1_000 },
    ]

    const visible = buildFreshAgentVisibleMru('freshcodex', {
      cwdKey: '/repo/a',
      entries,
      capabilities: undefined,
      now: 1_000,
      maxVisible: 3,
    })

    expect(visible).toEqual([
      { model: expect.objectContaining({ id: 'gpt-5.5', provider: 'codex' }), stale: true },
    ])
  })

  it('uses the live enabled catalog to remove stale cached entries after refresh', () => {
    const entries = [
      { id: 'opencode-go/current', displayName: 'Current', source: { id: 'opencode-go', displayName: 'opencode-go' }, cwdKey: '/repo/a', lastVerifiedAt: 1_000 },
      { id: 'missing/model', displayName: 'Missing', source: { id: 'missing', displayName: 'missing' }, cwdKey: '/repo/a', lastVerifiedAt: 1_000 },
    ]

    expect(buildFreshAgentVisibleMru('freshopencode', {
      currentModelId: 'opencode-go/current',
      cwdKey: '/repo/a',
      entries,
      capabilities,
      now: 2_000,
      maxVisible: 3,
    }).map((entry) => [entry.model.id, entry.stale])).toEqual([
      ['opencode-go/current', false],
    ])
  })
})

describe('fresh-agent model last-used-level store', () => {
  it('records and resolves the last-used level per provider, cwd, and model', () => {
    const storage = memoryStorage()
    recordFreshAgentModelLevelUse('freshopencode', { modelId: 'opencode-go/a', level: 'high', cwdKey: '/repo/a' }, 1_000, storage)
    recordFreshAgentModelLevelUse('freshopencode', { modelId: 'opencode-go/b', level: 'low', cwdKey: '/repo/a' }, 2_000, storage)

    expect(resolveFreshAgentModelLastUsedLevel('freshopencode', { modelId: 'opencode-go/a', cwdKey: '/repo/a' }, storage)).toBe('high')
    expect(resolveFreshAgentModelLastUsedLevel('freshopencode', { modelId: 'opencode-go/b', cwdKey: '/repo/a' }, storage)).toBe('low')
    expect(resolveFreshAgentModelLastUsedLevel('freshopencode', { modelId: 'opencode-go/missing', cwdKey: '/repo/a' }, storage)).toBeUndefined()
  })

  it('overwrites the level for the same provider, cwd, and model (most recent wins)', () => {
    const storage = memoryStorage()
    recordFreshAgentModelLevelUse('freshopencode', { modelId: 'opencode-go/a', level: 'high', cwdKey: '/repo/a' }, 1_000, storage)
    recordFreshAgentModelLevelUse('freshopencode', { modelId: 'opencode-go/a', level: 'low', cwdKey: '/repo/a' }, 2_000, storage)

    expect(resolveFreshAgentModelLastUsedLevel('freshopencode', { modelId: 'opencode-go/a', cwdKey: '/repo/a' }, storage)).toBe('low')
    expect(loadFreshAgentModelLevelMru('freshopencode', storage)).toHaveLength(1)
  })

  it('scopes entries by provider and cwd so freshcodex and other directories stay separate', () => {
    const storage = memoryStorage()
    recordFreshAgentModelLevelUse('freshopencode', { modelId: 'shared/model', level: 'high', cwdKey: '/repo/a' }, 1_000, storage)
    recordFreshAgentModelLevelUse('freshopencode', { modelId: 'shared/model', level: 'low', cwdKey: '/repo/b' }, 2_000, storage)
    recordFreshAgentModelLevelUse('freshcodex', { modelId: 'shared/model', level: 'max', cwdKey: '/repo/a' }, 3_000, storage)

    expect(resolveFreshAgentModelLastUsedLevel('freshopencode', { modelId: 'shared/model', cwdKey: '/repo/a' }, storage)).toBe('high')
    expect(resolveFreshAgentModelLastUsedLevel('freshopencode', { modelId: 'shared/model', cwdKey: '/repo/b' }, storage)).toBe('low')
    expect(resolveFreshAgentModelLastUsedLevel('freshcodex', { modelId: 'shared/model', cwdKey: '/repo/a' }, storage)).toBe('max')
  })

  it('rejects blank model ids, levels, and cwd keys instead of writing unusable entries', () => {
    const storage = memoryStorage()
    recordFreshAgentModelLevelUse('freshopencode', { modelId: '  ', level: 'high', cwdKey: '/repo/a' }, 1_000, storage)
    recordFreshAgentModelLevelUse('freshopencode', { modelId: 'opencode-go/a', level: ' ', cwdKey: '/repo/a' }, 1_000, storage)
    recordFreshAgentModelLevelUse('freshopencode', { modelId: 'opencode-go/a', level: 'high', cwdKey: ' ' }, 1_000, storage)

    expect(loadFreshAgentModelLevelMru('freshopencode', storage)).toEqual([])
  })

  it('bounds the store by evicting the least recently used entries', () => {
    const storage = memoryStorage()
    for (let index = 0; index < 60; index += 1) {
      recordFreshAgentModelLevelUse('freshopencode', { modelId: `m/model-${index}`, level: 'high', cwdKey: '/repo/a' }, index, storage)
    }

    const entries = loadFreshAgentModelLevelMru('freshopencode', storage)
    expect(entries.length).toBeLessThan(60)
    expect(entries.length).toBeGreaterThan(0)
    expect(entries[0]).toMatchObject({ modelId: 'm/model-59' })
    expect(entries.some((entry) => entry.modelId === 'm/model-0')).toBe(false)
  })

  it('skips corrupt entries when loading instead of failing the whole store', () => {
    const storage = memoryStorage()
    storage.setItem('freshopencode.modelLevelMru.v1', JSON.stringify([
      { modelId: 'opencode-go/a', level: 'high', cwdKey: '/repo/a', lastUsedAt: 1_000 },
      { modelId: '', level: 'high', cwdKey: '/repo/a', lastUsedAt: 1_000 },
      { modelId: 'opencode-go/b', level: 7, cwdKey: '/repo/a', lastUsedAt: 1_000 },
      null,
      'garbage',
    ]))

    expect(loadFreshAgentModelLevelMru('freshopencode', storage)).toEqual([
      { modelId: 'opencode-go/a', level: 'high', cwdKey: '/repo/a', lastUsedAt: 1_000 },
    ])
  })
})
