// @vitest-environment node
import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

import { createFreshAgentProviderRegistry } from '../../../server/fresh-agent/provider-registry.js'
import { registerFreshAgentThreadRoutes } from '../../../server/fresh-agent/register-routes.js'
import { FreshAgentRuntimeManager } from '../../../server/fresh-agent/runtime-manager.js'
import type { FreshAgentRuntimeAdapter } from '../../../server/fresh-agent/runtime-adapter.js'

type ExpressLayer = {
  route?: { path?: unknown }
  regexp?: RegExp
  name?: string
  handle?: { stack?: ExpressLayer[] }
}

function createProductionFreshAgentRouteApp() {
  const adapter = {
    runtimeProvider: 'claude',
    create: vi.fn(),
    getSnapshot: vi.fn(async (thread: { threadId: string }) => ({
      sessionType: 'freshclaude',
      provider: 'claude',
      threadId: thread.threadId,
      sessionId: thread.threadId,
      revision: 1,
      status: 'idle',
      capabilities: {
        send: true,
        interrupt: false,
        approvals: false,
        questions: false,
        fork: false,
      },
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      pendingApprovals: [],
      pendingQuestions: [],
      worktrees: [],
      diffs: [],
      childThreads: [],
      turns: [],
      extensions: {},
    })),
  } as unknown as FreshAgentRuntimeAdapter
  const runtimeManager = new FreshAgentRuntimeManager({
    registry: createFreshAgentProviderRegistry([
      {
        sessionType: 'freshclaude',
        runtimeProvider: 'claude',
        adapter,
      },
    ]),
  })
  const app = express()
  app.use(express.json())
  registerFreshAgentThreadRoutes(app, { runtimeManager })
  return app
}

function collectExpressRouteStack(app: express.Express): string[] {
  const stack = ((app as unknown as { _router?: { stack?: ExpressLayer[] } })._router?.stack ?? [])
  const entries: string[] = []
  const visit = (layer: ExpressLayer): void => {
    if (typeof layer.route?.path === 'string') entries.push(layer.route.path)
    if (layer.regexp) entries.push(String(layer.regexp))
    if (layer.name) entries.push(layer.name)
    for (const child of layer.handle?.stack ?? []) visit(child)
  }
  for (const layer of stack) visit(layer)
  return entries
}

describe('fresh-agent removes legacy Claude history routes', () => {
  it('does not register legacy agent-session routes through the production fresh-agent route helper', () => {
    const app = createProductionFreshAgentRouteApp()
    const routes = collectExpressRouteStack(app)

    expect(routes.some((entry) => entry.includes('agent-sessions'))).toBe(false)
    expect(routes).toContain('/fresh-agent/threads/:sessionType/:provider/:threadId')
  })

  it('does not mount /api/agent-sessions routes while fresh-agent threads still resolve', async () => {
    const app = createProductionFreshAgentRouteApp()

    const legacyTimeline = await request(app)
      .get('/api/agent-sessions/sdk-session-1/timeline?revision=1')
    const legacyTurnBody = await request(app)
      .get('/api/agent-sessions/sdk-session-1/turns/turn-1?revision=1')
    const freshAgentThread = await request(app)
      .get('/api/fresh-agent/threads/freshclaude/claude/sdk-session-1?revision=1')

    expect(legacyTimeline.status).toBe(404)
    expect(legacyTurnBody.status).toBe(404)
    expect(freshAgentThread.status).toBe(200)
    expect(freshAgentThread.body).toMatchObject({
      sessionType: 'freshclaude',
      provider: 'claude',
      threadId: 'sdk-session-1',
      revision: 1,
    })
  })
})
