// SESSION-05 (project colors): the session-directory page's optional
// `projectColors` map must survive the zod parse and land on the project
// groups the client UI renders (HistoryView's header swatch reads
// `project.color`; the sidebar selectors read the same group field). After
// the read-model cutover the page items carry NO color and grouping was the
// only place a project group is constructed — so the map is overlaid here,
// at the single construction site fed by the page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchSidebarSessionsSnapshot, searchSessions } from '@/lib/api'

const mockFetch = vi.fn()

function mockJson(value: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    text: () => Promise.resolve(JSON.stringify(value)),
  }
}

function directoryPage(overrides: Record<string, unknown> = {}) {
  return {
    items: [
      {
        sessionId: 'session-alpha',
        provider: 'claude',
        projectPath: '/tmp/project-alpha',
        title: 'Alpha',
        isRunning: false,
        lastActivityAt: 1_000,
      },
      {
        sessionId: 'session-beta',
        provider: 'claude',
        projectPath: '/tmp/project-beta',
        title: 'Beta',
        isRunning: false,
        lastActivityAt: 900,
      },
    ],
    nextCursor: null,
    revision: 1,
    ...overrides,
  }
}

describe('project colors channel (SESSION-05)', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetchSidebarSessionsSnapshot overlays page projectColors onto the built groups', async () => {
    mockFetch.mockResolvedValueOnce(mockJson(directoryPage({
      projectColors: { '/tmp/project-alpha': '#ff8800', '/tmp/project-beta': '#00ff11' },
    })))

    const response = await fetchSidebarSessionsSnapshot()

    const alpha = response.projects.find((p: any) => p.projectPath === '/tmp/project-alpha')
    const beta = response.projects.find((p: any) => p.projectPath === '/tmp/project-beta')
    expect(alpha.color).toBe('#ff8800')
    expect(beta.color).toBe('#00ff11')
  })

  it('leaves color undefined when the page has no projectColors (pre-SESSION-05 server)', async () => {
    mockFetch.mockResolvedValueOnce(mockJson(directoryPage()))

    const response = await fetchSidebarSessionsSnapshot()

    for (const project of response.projects) {
      expect(project.color).toBeUndefined()
    }
  })

  it('searchSessions surfaces the page projectColors for the search window', async () => {
    mockFetch.mockResolvedValueOnce(mockJson(directoryPage({
      projectColors: { '/tmp/project-alpha': '#ff8800' },
    })))

    const response = await searchSessions({ query: 'Alpha' })

    expect(response.projectColors).toEqual({ '/tmp/project-alpha': '#ff8800' })
  })

  it('searchSessions omits projectColors when the page has none', async () => {
    mockFetch.mockResolvedValueOnce(mockJson(directoryPage()))

    const response = await searchSessions({ query: 'Alpha' })

    expect(response.projectColors).toBeUndefined()
  })
})
