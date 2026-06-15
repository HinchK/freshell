import { beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'http'
import WebSocket from 'ws'

vi.mock('../../../server/config-store.js', () => ({
  configStore: {
    snapshot: vi.fn(),
    pushRecentDirectory: vi.fn().mockResolvedValue([]),
  },
}))

import { WsHandler } from '../../../server/ws-handler.js'
import { TerminalRegistry } from '../../../server/terminal-registry.js'
import { configStore } from '../../../server/config-store.js'
import { createDefaultServerSettings } from '../../../shared/settings.js'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'

const TEST_AUTH_TOKEN = 'testtoken-testtoken'

function enabledConfig() {
  const settings = createDefaultServerSettings({ loggingDebug: false })
  settings.freshAgent.enabled = true
  return {
    version: 1 as const,
    settings,
    sessionOverrides: {},
    terminalOverrides: {},
    projectColors: {},
    recentDirectories: [],
  }
}

async function createServer(options: Record<string, unknown>) {
  const server = http.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const registry = new TerminalRegistry()
  const handler = new WsHandler(server, registry, options as never)
  return { server, registry, handler }
}

async function connectAndAuth(server: http.Server) {
  const addr = server.address()
  const port = typeof addr === 'object' ? addr!.port : 0
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const messages: any[] = []
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout waiting for ready')), 5000)
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'hello',
        token: TEST_AUTH_TOKEN,
        protocolVersion: WS_PROTOCOL_VERSION,
      }))
    })
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString())
      messages.push(message)
      if (message.type === 'ready') {
        clearTimeout(timeout)
        resolve()
      }
    })
    ws.on('error', reject)
  })
  return { ws, messages }
}

describe('WsHandler fresh-agent lifecycle parity', () => {
  beforeEach(() => {
    process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
    vi.mocked(configStore.snapshot).mockResolvedValue(enabledConfig())
  })

  it('forwards create/send payloads and normalizes live provider events', async () => {
    const listeners = new Map<string, (message: unknown) => void>()
    const runtimeManager = {
      create: vi.fn().mockResolvedValue({
        sessionId: 'claude-session-parity',
        sessionType: 'freshclaude',
        runtimeProvider: 'claude',
      }),
      subscribe: vi.fn().mockImplementation(async (locator: unknown, listener: (message: unknown) => void) => {
        listeners.set(JSON.stringify(locator), listener)
        return () => undefined
      }),
      send: vi.fn().mockResolvedValue(undefined),
    }
    const { server, registry, handler } = await createServer({ freshAgentRuntimeManager: runtimeManager })

    try {
      const { ws, messages } = await connectAndAuth(server)
      ws.send(JSON.stringify({
        type: 'freshAgent.create',
        requestId: 'req-claude-parity',
        sessionType: 'freshclaude',
        provider: 'claude',
        cwd: '/repo',
        resumeSessionId: 'cli-session-parity',
        model: 'claude-sonnet-4-6',
        modelSelection: { kind: 'fixed', modelId: 'claude-sonnet-4-6' },
        permissionMode: 'acceptEdits',
        effort: 'medium',
        plugins: ['/repo/.claude/plugin'],
      }))

      await vi.waitFor(() => {
        expect(runtimeManager.create).toHaveBeenCalledWith(expect.objectContaining({
          requestId: 'req-claude-parity',
          sessionType: 'freshclaude',
          provider: 'claude',
          cwd: '/repo',
          resumeSessionId: 'cli-session-parity',
          model: 'claude-sonnet-4-6',
          modelSelection: { kind: 'fixed', modelId: 'claude-sonnet-4-6' },
          permissionMode: 'acceptEdits',
          effort: 'medium',
          plugins: ['/repo/.claude/plugin'],
        }))
      })

      ws.send(JSON.stringify({
        type: 'freshAgent.send',
        sessionId: 'claude-session-parity',
        sessionType: 'freshclaude',
        provider: 'claude',
        text: 'inspect this',
        images: [{ mediaType: 'image/png', data: 'aW1n' }],
        settings: { model: 'claude-opus-4-6', effort: 'high' },
      }))

      await vi.waitFor(() => {
        expect(runtimeManager.send).toHaveBeenCalledWith({
          sessionId: 'claude-session-parity',
          sessionType: 'freshclaude',
          provider: 'claude',
        }, {
          text: 'inspect this',
          images: [{ mediaType: 'image/png', data: 'aW1n' }],
          settings: { model: 'claude-opus-4-6', effort: 'high' },
        })
      })

      listeners.get(JSON.stringify({
        sessionId: 'claude-session-parity',
        sessionType: 'freshclaude',
        provider: 'claude',
      }))?.({
        type: 'sdk.session.snapshot',
        sessionId: 'claude-session-parity',
        latestTurnId: 'turn-1',
        status: 'idle',
        revision: 3,
      })

      await vi.waitFor(() => {
        expect(messages).toContainEqual({
          type: 'freshAgent.event',
          sessionId: 'claude-session-parity',
          sessionType: 'freshclaude',
          provider: 'claude',
          event: {
            type: 'freshAgent.session.snapshot',
            sessionId: 'claude-session-parity',
            latestTurnId: 'turn-1',
            status: 'idle',
            revision: 3,
          },
        })
      })
    } finally {
      handler.close()
      registry.shutdown()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
