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

  // The REAL dual-id live FreshClaude shape (e1r1 review finding 1): the
  // SDK bridge mints a BARE nanoid runtime handle for the top-level
  // sessionId with NO placeholder→durable materialization
  // (crates/freshell-freshagent/src/claude.rs:15,343-344), while the
  // durable Claude UUID lives in sessionRef and keys the session
  // directory. Shape verified against panesPersistence.test.ts:384-447
  // (live 'fc-e2e-123' placeholder + sessionRef DURABLE round-trip;
  // persistence strips the top-level sessionId) and
  // fresh-agent-turn-complete.test.ts:143-184 (events keyed by the
  // runtime handle while sessionRef holds the durable id).
  const RUNTIME_HANDLE = 'claude-runtime-nanoid'
  const DURABLE_CLAUDE = '11111111-2222-4333-8444-555555555555'
  const liveClaudeContent: PaneContent = {
    kind: 'fresh-agent',
    sessionType: 'freshclaude',
    provider: 'claude',
    sessionId: RUNTIME_HANDLE,
    createRequestId: 'req-claude',
    status: 'connected',
    sessionRef: { provider: 'claude', sessionId: DURABLE_CLAUDE },
  }

  it('matches a fresh-agent pane by top-level provider+sessionId', () => {
    expect(paneContentMatchesSessionRef(freshAgentContent, 'opencode', 'sess-1')).toBe(true)
  })

  it('matches a live FreshClaude pane by its durable sessionRef while the top-level sessionId is a transient runtime handle (the dual-id failure case)', () => {
    expect(paneContentMatchesSessionRef(liveClaudeContent, 'claude', DURABLE_CLAUDE)).toBe(true)
  })

  it('does not match a live FreshClaude pane by its transient top-level runtime handle when a canonical sessionRef exists', () => {
    expect(paneContentMatchesSessionRef(liveClaudeContent, 'claude', RUNTIME_HANDLE)).toBe(false)
  })

  // Corrected contract (directory rows key on durable ids): when a
  // sessionRef exists it is canonical — a present-but-different
  // top-level sessionId is the ephemeral runtime handle, not a rival
  // durable identity. The previous repair pinned the opposite
  // ("present-but-different sessionId never matches"); this test now
  // pins the corrected rule.
  it('matches the canonical sessionRef even when the live top-level sessionId names something else', () => {
    const rebound = { ...freshAgentContent, sessionId: 'sess-2' } as PaneContent
    expect(paneContentMatchesSessionRef(rebound, 'opencode', 'sess-1')).toBe(true)
    expect(paneContentMatchesSessionRef(rebound, 'opencode', 'sess-2')).toBe(false)
  })

  it('matches a persisted-shape fresh-agent pane (sessionRef only, no top-level sessionId) by its sessionRef', () => {
    const { sessionId: _sessionId, ...persistedShape } = freshAgentContent
    expect(persistedShape).not.toHaveProperty('sessionId')
    expect(paneContentMatchesSessionRef(persistedShape as PaneContent, 'opencode', 'sess-1')).toBe(true)
  })

  it('falls back to the top-level provider+sessionId only when no sessionRef exists', () => {
    const { sessionRef: _sessionRef, ...noRef } = freshAgentContent
    expect(noRef).not.toHaveProperty('sessionRef')
    expect(paneContentMatchesSessionRef(noRef as PaneContent, 'opencode', 'sess-1')).toBe(true)
    expect(paneContentMatchesSessionRef(noRef as PaneContent, 'opencode', 'sess-9')).toBe(false)
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
