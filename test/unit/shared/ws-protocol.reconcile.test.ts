import { describe, it, expect } from 'vitest'
import {
  PaneReconcileRequestSchema,
  PaneReconcileResultSchema,
  ClientMessageSchema,
} from '@shared/ws-protocol'

describe('pane.reconcile schemas', () => {
  const request = {
    type: 'pane.reconcile.request',
    reconcileId: 'rec-1',
    panes: [{
      paneKey: 'tab1:paneA', kind: 'terminal', mode: 'claude',
      createRequestId: 'cr-1', terminalId: 'term-1',
      sessionRef: { provider: 'claude', sessionId: 's-1' }, status: 'running',
    }],
  }
  it('parses a valid request and accepts it in the client union', () => {
    expect(PaneReconcileRequestSchema.parse(request)).toBeTruthy()
    expect(ClientMessageSchema.safeParse(request).success).toBe(true)
  })
  it('rejects >200 panes', () => {
    const big = { ...request, panes: Array.from({ length: 201 }, (_, i) => ({ ...request.panes[0], paneKey: `t:${i}` })) }
    expect(PaneReconcileRequestSchema.safeParse(big).success).toBe(false)
  })
  it('parses a result with the 6-verdict enum and no retry', () => {
    const result = {
      type: 'pane.reconcile.result', reconcileId: 'rec-1', bootId: 'b1', serverInstanceId: 'srv1',
      verdicts: [
        { paneKey: 'tab1:paneA', verdict: 'attach', terminalId: 'term-1', corrected: true },
        { paneKey: 'tab1:paneB', verdict: 'error', reason: 'index_warming' },
      ],
    }
    expect(PaneReconcileResultSchema.parse(result)).toBeTruthy()
    expect(PaneReconcileResultSchema.safeParse({ ...result, verdicts: [{ paneKey: 'x', verdict: 'retry' }] }).success).toBe(false)
  })
})
