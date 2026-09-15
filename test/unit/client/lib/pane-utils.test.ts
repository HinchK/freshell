import { describe, it, expect } from 'vitest'
import {
  buildPaneRefreshTarget,
  collectPaneContents,
  paneContentMatchesSessionRef,
  paneRefreshTargetMatchesContent,
} from '@/lib/pane-utils'
import type { PaneNode, PaneContent } from '@/store/paneTypes'

function leaf(id: string, content: PaneContent): PaneNode {
  return { type: 'leaf', id, content }
}

function split(children: [PaneNode, PaneNode]): PaneNode {
  return { type: 'split', id: 'split-1', direction: 'horizontal', children, sizes: [50, 50] }
}

const shellContent: PaneContent = {
  kind: 'terminal', mode: 'shell', shell: 'system', createRequestId: 'r1', status: 'running',
}
const claudeContent: PaneContent = {
  kind: 'terminal', mode: 'claude', shell: 'system', createRequestId: 'r2', status: 'running',
}
const browserContent: PaneContent = {
  kind: 'browser', browserInstanceId: 'browser-1', url: 'https://example.com', devToolsOpen: false,
}

describe('collectPaneContents', () => {
  it('returns content array from a single leaf', () => {
    const result = collectPaneContents(leaf('p1', shellContent))
    expect(result).toEqual([shellContent])
  })

  it('returns contents from both children of a split', () => {
    const result = collectPaneContents(split([
      leaf('p1', shellContent),
      leaf('p2', claudeContent),
    ]))
    expect(result).toEqual([shellContent, claudeContent])
  })

  it('traverses nested splits depth-first', () => {
    const nested = split([
      split([leaf('p1', shellContent), leaf('p2', claudeContent)]),
      leaf('p3', browserContent),
    ])
    const result = collectPaneContents(nested)
    expect(result).toEqual([shellContent, claudeContent, browserContent])
  })
})

describe('buildPaneRefreshTarget', () => {
  it('returns null for terminal panes without terminalId', () => {
    expect(buildPaneRefreshTarget({
      kind: 'terminal',
      mode: 'shell',
      createRequestId: 'req-1',
      status: 'running',
    })).toBeNull()
  })

  it('returns a terminal target for attached terminals', () => {
    expect(buildPaneRefreshTarget({
      kind: 'terminal',
      mode: 'shell',
      createRequestId: 'req-1',
      terminalId: 'term-1',
      status: 'running',
    })).toEqual({ kind: 'terminal', createRequestId: 'req-1' })
  })

  it('returns null for blank browser panes', () => {
    expect(buildPaneRefreshTarget({
      kind: 'browser',
      browserInstanceId: 'browser-1',
      url: '',
      devToolsOpen: false,
    })).toBeNull()
  })

  it('returns a browser target keyed by browserInstanceId', () => {
    expect(buildPaneRefreshTarget({
      kind: 'browser',
      browserInstanceId: 'browser-1',
      url: 'https://example.test/a',
      devToolsOpen: false,
    })).toEqual({ kind: 'browser', browserInstanceId: 'browser-1' })
  })

  it('returns null instead of throwing for malformed browser content', () => {
    expect(() => buildPaneRefreshTarget({
      kind: 'browser',
      browserInstanceId: 'browser-1',
      url: undefined as any,
      devToolsOpen: false,
    } as any)).not.toThrow()

    expect(buildPaneRefreshTarget({
      kind: 'browser',
      browserInstanceId: 'browser-1',
      url: undefined as any,
      devToolsOpen: false,
    } as any)).toBeNull()
  })
})

describe('paneRefreshTargetMatchesContent', () => {
  it('keeps matching the same browser instance even when url changes', () => {
    expect(
      paneRefreshTargetMatchesContent(
        { kind: 'browser', browserInstanceId: 'browser-1' },
        {
          kind: 'browser',
          browserInstanceId: 'browser-1',
          url: 'https://example.test/b',
          devToolsOpen: false,
        },
      ),
    ).toBe(true)
  })

  it('does not match a different browser instance even when the url is the same', () => {
    expect(
      paneRefreshTargetMatchesContent(
        { kind: 'browser', browserInstanceId: 'browser-1' },
        {
          kind: 'browser',
          browserInstanceId: 'browser-2',
          url: 'https://example.test/a',
          devToolsOpen: false,
        },
      ),
    ).toBe(false)
  })

  it('returns false instead of throwing for malformed browser content', () => {
    expect(() => paneRefreshTargetMatchesContent(
      { kind: 'browser', browserInstanceId: 'browser-1' },
      {
        kind: 'browser',
        browserInstanceId: 'browser-1',
        url: undefined as any,
        devToolsOpen: false,
      } as any,
    )).not.toThrow()

    expect(
      paneRefreshTargetMatchesContent(
        { kind: 'browser', browserInstanceId: 'browser-1' },
        {
          kind: 'browser',
          browserInstanceId: 'browser-1',
          url: undefined as any,
          devToolsOpen: false,
        } as any,
      ),
    ).toBe(false)
  })
})

describe('paneContentMatchesSessionRef', () => {
  const freshAgentContent: PaneContent = {
    kind: 'fresh-agent',
    sessionType: 'freshopencode',
    provider: 'opencode',
    sessionId: 'sess-1',
    createRequestId: 'req-1',
    status: 'idle',
    sessionRef: { provider: 'opencode', sessionId: 'sess-1' },
  }

  it('matches a fresh-agent pane by top-level provider+sessionId', () => {
    expect(paneContentMatchesSessionRef(freshAgentContent, 'opencode', 'sess-1')).toBe(true)
  })

  it('matches a persisted-shape fresh-agent pane (sessionRef only, no top-level sessionId) by its sessionRef', () => {
    const { sessionId: _sessionId, ...persistedShape } = freshAgentContent
    expect(persistedShape).not.toHaveProperty('sessionId')
    expect(paneContentMatchesSessionRef(persistedShape as PaneContent, 'opencode', 'sess-1')).toBe(true)
  })

  it('does not match a fresh-agent pane whose live sessionId names a different session, even with a stale sessionRef', () => {
    const rebound = { ...freshAgentContent, sessionId: 'sess-2' } as PaneContent
    expect(paneContentMatchesSessionRef(rebound, 'opencode', 'sess-1')).toBe(false)
  })

  it('does not match a fresh-agent pane when the provider differs', () => {
    expect(paneContentMatchesSessionRef(freshAgentContent, 'claude', 'sess-1')).toBe(false)
  })

  it('matches a terminal pane by its sessionRef', () => {
    const terminalContent: PaneContent = {
      kind: 'terminal',
      mode: 'claude',
      createRequestId: 'req-2',
      status: 'running',
      sessionRef: { provider: 'claude', sessionId: 's1' },
    }
    expect(paneContentMatchesSessionRef(terminalContent, 'claude', 's1')).toBe(true)
    expect(paneContentMatchesSessionRef(terminalContent, 'claude', 's2')).toBe(false)
  })
})
