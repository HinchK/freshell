import { describe, it, expect, vi } from 'vitest'
import { buildRecoveryPlan, countRecoverablePanes } from '@/lib/recovery/build-recovery-plan'
import type { RecoveryInventory } from '@/lib/recovery/types'

vi.mock('nanoid', () => { let n = 0; return { nanoid: () => `nid-${++n}` } })

const pane = (over: Partial<RecoveryInventory['device']['tabs'][0]['panes'][0]> = {}) => ({
  paneId: 'p1', kind: 'terminal', mode: 'shell', shell: null, cwd: '/w',
  payload: {}, sessionRef: null, ledgerState: 'unknown' as const, live: false, ...over,
})
const inv = (panes: unknown[], ledgerOnly: unknown[] = []): RecoveryInventory => ({
  recoverable: true, contentId: 'cid',
  device: { deviceId: 'd', deviceLabel: 'l', capturedAt: 1, tabs: [{ tabKey: 'k', tabName: 'work', panes }] },
  otherDevices: [], ledgerOnly,
} as RecoveryInventory)

describe('buildRecoveryPlan', () => {
  it('single terminal pane -> one tab, leaf layout, cwd + mode carried', () => {
    const [tab] = buildRecoveryPlan(inv([pane()]))
    expect(tab.title).toBe('work')
    expect(tab.layout.type).toBe('leaf')
    const content = (tab.layout as { content: Record<string, unknown> }).content
    expect(content).toMatchObject({ kind: 'terminal', mode: 'shell', initialCwd: '/w' })
    expect(content.sessionRef).toBeUndefined()
  })

  it('ledger-corrected sessionRef is used verbatim (authority chain applied server-side)', () => {
    const [tab] = buildRecoveryPlan(inv([pane({ sessionRef: { provider: 'claude', sessionId: 'S2' }, ledgerState: 'bound', mode: 'claude' })]))
    const content = (tab.layout as { content: Record<string, unknown> }).content
    expect(content.sessionRef).toEqual({ provider: 'claude', sessionId: 'S2' })
  })

  it('closed panes come back fresh: no sessionRef, same cwd/mode', () => {
    const [tab] = buildRecoveryPlan(inv([pane({ ledgerState: 'closed', mode: 'claude' })]))
    const content = (tab.layout as { content: Record<string, unknown> }).content
    expect(content.sessionRef).toBeUndefined()
    expect(content).toMatchObject({ mode: 'claude', initialCwd: '/w' })
  })

  it('three panes -> right-leaning binary split chain', () => {
    const [tab] = buildRecoveryPlan(inv([pane({ paneId: 'a' }), pane({ paneId: 'b' }), pane({ paneId: 'c' })]))
    expect(tab.layout.type).toBe('split')
    const root = tab.layout as { children: [{ type: string }, { type: string }] }
    expect(root.children[0].type).toBe('leaf')
    expect(root.children[1].type).toBe('split')
  })

  it('live panes are recreated WITHOUT resume: sessionRef stripped, cwd/mode kept (D7)', () => {
    const [tab] = buildRecoveryPlan(inv([pane({ sessionRef: { provider: 'claude', sessionId: 'S2' }, ledgerState: 'bound', mode: 'claude', live: true })]))
    const content = (tab.layout as { content: Record<string, unknown> }).content
    expect(content.sessionRef).toBeUndefined()
    expect(content).toMatchObject({ kind: 'terminal', mode: 'claude', initialCwd: '/w' })
  })

  it('non-terminal kinds pass payload through', () => {
    const [tab] = buildRecoveryPlan(inv([pane({ kind: 'browser', payload: { url: 'https://x.test' }, mode: null, cwd: null })]))
    const content = (tab.layout as { content: Record<string, unknown> }).content
    expect(content).toMatchObject({ kind: 'browser', url: 'https://x.test' })
  })

  it('editor panes get the required content default (buffer text is never captured)', () => {
    const [tab] = buildRecoveryPlan(inv([pane({ kind: 'editor', payload: { filePath: '/f.txt' }, mode: null, cwd: null })]))
    const content = (tab.layout as { content: Record<string, unknown> }).content
    expect(content).toMatchObject({ kind: 'editor', filePath: '/f.txt', content: '' })
  })

  it('fresh-agent restoreError is stripped so normalize keeps the sessionRef', () => {
    const [tab] = buildRecoveryPlan(inv([pane({ kind: 'fresh-agent',
      payload: { sessionRef: { provider: 'freshclaude', sessionId: 'F1' }, restoreError: 'stale' }, mode: null, cwd: null })]))
    const content = (tab.layout as { content: Record<string, unknown> }).content
    expect(content.restoreError).toBeUndefined()
    expect(content).toMatchObject({ kind: 'fresh-agent', sessionRef: { provider: 'freshclaude', sessionId: 'F1' } })
  })

  it('extension and picker payloads pass through', () => {
    const [tab] = buildRecoveryPlan(inv([
      pane({ paneId: 'x1', kind: 'extension', payload: { extensionId: 'ext.foo' }, mode: null, cwd: null }),
      pane({ paneId: 'x2', kind: 'picker', payload: {}, mode: null, cwd: null }),
    ]))
    const root = tab.layout as { children: [{ content: Record<string, unknown> }, { content: Record<string, unknown> }] }
    expect(root.children[0].content).toMatchObject({ kind: 'extension', extensionId: 'ext.foo' })
    expect(root.children[1].content).toMatchObject({ kind: 'picker' })
  })

  it('ledgerOnly entries get a trailing Recovered sessions tab', () => {
    const plans = buildRecoveryPlan(inv([pane()], [{ provider: 'codex', sessionId: 'C9', mode: 'codex', cwd: '/x' }]))
    expect(plans).toHaveLength(2)
    expect(plans[1].title).toBe('Recovered sessions')
    const content = (plans[1].layout as { content: Record<string, unknown> }).content
    expect(content).toMatchObject({ kind: 'terminal', mode: 'codex', initialCwd: '/x', sessionRef: { provider: 'codex', sessionId: 'C9' } })
  })

  it('countRecoverablePanes sums device panes and ledgerOnly', () => {
    expect(countRecoverablePanes(inv([pane(), pane({ paneId: 'p2' })], [{ provider: 'codex', sessionId: 'C9', mode: 'codex', cwd: null }]))).toBe(3)
  })
})
