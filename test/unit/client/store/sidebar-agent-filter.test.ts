import { describe, it, expect } from 'vitest'
import {
  ALL_AGENTS,
  collectAgentFilterOptions,
  filterSessionItemsByAgent,
  type SidebarSessionItem,
} from '@/store/selectors/sidebarSelectors'

function createItem(overrides: Partial<SidebarSessionItem>): SidebarSessionItem {
  return {
    id: 'session-claude-test',
    sessionId: 'test',
    provider: 'claude',
    sessionType: 'claude',
    title: 'Test Session',
    hasTitle: true,
    timestamp: 1000,
    hasTab: false,
    isRunning: false,
    ...overrides,
  }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

describe('filterSessionItemsByAgent', () => {
  it('returns the same array reference for ALL_AGENTS', () => {
    const items = [createItem({ sessionType: 'claude' })]
    expect(filterSessionItemsByAgent(items, ALL_AGENTS)).toBe(items)
  })

  it('filters items to the selected sessionType', () => {
    const items = [
      createItem({ id: '1', sessionId: 's1', sessionType: 'claude' }),
      createItem({ id: '2', sessionId: 's2', sessionType: 'codex' }),
      createItem({ id: '3', sessionId: 's3', sessionType: 'freshclaude' }),
    ]
    expect(filterSessionItemsByAgent(items, 'codex').map((i) => i.id)).toEqual(['2'])
    expect(filterSessionItemsByAgent(items, 'freshclaude').map((i) => i.id)).toEqual(['3'])
  })

  it('returns an empty array when no items match', () => {
    const items = [createItem({ sessionType: 'claude' })]
    expect(filterSessionItemsByAgent(items, 'opencode')).toEqual([])
  })
})

describe('collectAgentFilterOptions', () => {
  it('dedupes agent kinds and sorts by label', () => {
    const items = [
      createItem({ id: '1', sessionId: 's1', sessionType: 'codex' }),
      createItem({ id: '2', sessionId: 's2', sessionType: 'claude' }),
      createItem({ id: '3', sessionId: 's3', sessionType: 'claude' }),
    ]
    expect(collectAgentFilterOptions(items, ALL_AGENTS, capitalize)).toEqual([
      { value: 'claude', label: 'Claude' },
      { value: 'codex', label: 'Codex' },
    ])
  })

  it('labels options through the provided getLabel function', () => {
    const items = [createItem({ sessionType: 'codex' })]
    const options = collectAgentFilterOptions(items, ALL_AGENTS, () => 'Codex CLI')
    expect(options).toEqual([{ value: 'codex', label: 'Codex CLI' }])
  })

  it('retains the current selection even when its rows are absent', () => {
    const items = [createItem({ sessionType: 'claude' })]
    const options = collectAgentFilterOptions(items, 'codex', capitalize)
    expect(options.map((o) => o.value)).toEqual(['claude', 'codex'])
  })

  it('does not add a retention entry for ALL_AGENTS', () => {
    const options = collectAgentFilterOptions([], ALL_AGENTS, capitalize)
    expect(options).toEqual([])
  })
})
