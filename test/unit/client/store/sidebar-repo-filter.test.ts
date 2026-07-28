import { describe, it, expect } from 'vitest'
import {
  ALL_REPOS,
  collectRepoFilterOptions,
  filterSessionItemsByRepo,
  type SidebarSessionItem,
} from '@/store/selectors/sidebarSelectors'

function makeItem(id: string, overrides?: Partial<SidebarSessionItem>): SidebarSessionItem {
  return {
    id: `session-claude-${id}`,
    sessionId: id,
    provider: 'claude',
    sessionType: 'claude',
    title: `Session ${id}`,
    timestamp: 0,
    hasTab: false,
    isRunning: false,
    hasTitle: true,
    ...overrides,
  }
}

describe('filterSessionItemsByRepo', () => {
  const items = [
    makeItem('a1', { repoPath: '/home/user/repo-alpha', projectPath: '/home/user/repo-alpha' }),
    makeItem('a2', { repoPath: '/home/user/repo-alpha', projectPath: '/home/user/repo-alpha/.worktrees/x' }),
    makeItem('b1', { repoPath: '/home/user/repo-beta', projectPath: '/home/user/repo-beta' }),
    makeItem('orphan', { projectPath: '/tmp/some-cwd' }),
  ]

  it('returns the same array when the filter is ALL_REPOS', () => {
    expect(filterSessionItemsByRepo(items, ALL_REPOS)).toBe(items)
  })

  it('keeps only items whose repoPath matches the selected repo', () => {
    const result = filterSessionItemsByRepo(items, '/home/user/repo-alpha')
    expect(result.map((i) => i.sessionId)).toEqual(['a1', 'a2'])
  })

  it('hides items without a repoPath when a specific repo is selected', () => {
    const result = filterSessionItemsByRepo(items, '/home/user/repo-beta')
    expect(result.map((i) => i.sessionId)).toEqual(['b1'])
  })
})

describe('collectRepoFilterOptions', () => {
  it('dedupes repo paths and sorts options by leaf-directory label', () => {
    const items = [
      makeItem('b1', { repoPath: '/home/user/zeta-repo' }),
      makeItem('a1', { repoPath: '/home/user/alpha-repo' }),
      makeItem('a2', { repoPath: '/home/user/alpha-repo' }),
    ]
    expect(collectRepoFilterOptions(items, ALL_REPOS)).toEqual([
      { value: '/home/user/alpha-repo', label: 'alpha-repo' },
      { value: '/home/user/zeta-repo', label: 'zeta-repo' },
    ])
  })

  it('ignores items without a repoPath', () => {
    const items = [
      makeItem('a1', { repoPath: '/home/user/alpha-repo' }),
      makeItem('orphan', { projectPath: '/tmp/some-cwd' }),
    ]
    expect(collectRepoFilterOptions(items, ALL_REPOS)).toEqual([
      { value: '/home/user/alpha-repo', label: 'alpha-repo' },
    ])
  })

  it('retains the selected repo as an option even when no loaded item belongs to it', () => {
    const items = [makeItem('a1', { repoPath: '/home/user/alpha-repo' })]
    expect(collectRepoFilterOptions(items, '/home/user/zeta-repo')).toEqual([
      { value: '/home/user/alpha-repo', label: 'alpha-repo' },
      { value: '/home/user/zeta-repo', label: 'zeta-repo' },
    ])
  })

  it('does not inject an extra option when the selection is ALL_REPOS', () => {
    expect(collectRepoFilterOptions([], ALL_REPOS)).toEqual([])
  })
})
