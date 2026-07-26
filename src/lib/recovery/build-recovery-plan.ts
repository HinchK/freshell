import { nanoid } from 'nanoid'
import type { PaneNode, PaneContent } from '@/store/paneTypes'
import type { RecoveryInventory, RecoveryPane, LedgerOnlyEntry } from './types'

function terminalContent(p: {
  mode: string | null
  shell: string | null
  cwd: string | null
  sessionRef: { provider: string; sessionId: string } | null
  live: boolean
}): PaneContent {
  return {
    kind: 'terminal',
    createRequestId: nanoid(), // re-minted by restoreLayout normalization; required by the type
    status: 'creating',
    ...(p.mode ? { mode: p.mode } : {}),
    ...(p.shell ? { shell: p.shell } : {}),
    ...(p.cwd ? { initialCwd: p.cwd } : {}),
    // D7: live sessions are left untouched - recreate the pane WITHOUT resume
    ...(p.sessionRef && !p.live ? { sessionRef: p.sessionRef } : {}),
  } as PaneContent
}

function paneContent(p: RecoveryPane): PaneContent {
  if (p.kind === 'terminal') return terminalContent(p)
  if (p.kind === 'editor') {
    // EditorPaneContent.content is required (paneTypes.ts:116-130) but snapshots never
    // capture buffer text - recreate with an empty buffer (data fact, D6)
    return { content: '', ...p.payload, kind: 'editor' } as PaneContent
  }
  if (p.kind === 'fresh-agent') {
    // normalize's existingRestoreError branch would drop sessionRef; strip restoreError
    // and let normalize re-validate the ref itself (A10)
    const { restoreError: _restoreError, ...payload } = p.payload
    return { ...payload, kind: 'fresh-agent' } as PaneContent
  }
  return { ...p.payload, kind: p.kind } as PaneContent
}

function leaf(content: PaneContent): PaneNode {
  return { type: 'leaf', id: nanoid(), content }
}

// D6: no split geometry in snapshots - right-leaning binary chain of even splits
function chain(leaves: PaneNode[]): PaneNode {
  if (leaves.length === 1) return leaves[0]
  const [head, ...rest] = leaves
  return { type: 'split', id: nanoid(), direction: 'horizontal', children: [head, chain(rest)], sizes: [50, 50] }
}

export interface RecoveryTabPlan { tabId: string; title: string; layout: PaneNode; paneTitles: Record<string, string> }

export function countRecoverablePanes(inv: RecoveryInventory): number {
  const device = inv.device?.tabs.reduce((n, t) => n + t.panes.length, 0) ?? 0
  return device + inv.ledgerOnly.length
}

export function buildRecoveryPlan(inv: RecoveryInventory): RecoveryTabPlan[] {
  const plans: RecoveryTabPlan[] = (inv.device?.tabs ?? [])
    .filter((t) => t.panes.length > 0)
    .map((t) => ({ tabId: nanoid(), title: t.tabName || 'Recovered', layout: chain(t.panes.map((p) => leaf(paneContent(p)))), paneTitles: {} }))
  if (inv.ledgerOnly.length > 0) {
    plans.push({
      tabId: nanoid(),
      title: 'Recovered sessions',
      layout: chain(inv.ledgerOnly.map((e: LedgerOnlyEntry) =>
        leaf(terminalContent({ mode: e.mode, shell: null, cwd: e.cwd, sessionRef: { provider: e.provider, sessionId: e.sessionId }, live: false })))),
      paneTitles: {},
    })
  }
  return plans
}
