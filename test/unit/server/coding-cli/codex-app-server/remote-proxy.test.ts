import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexRemoteProxy } from '../../../../../server/coding-cli/codex-app-server/remote-proxy.js'
import { MAX_FULL_PARSE_BYTES } from '../../../../../server/coding-cli/codex-app-server/json-rpc-envelope.js'

type UpstreamHandle = {
  server: WebSocketServer
  wsUrl: string
  messages: unknown[]
  binaryFlags: boolean[]
  frames: Array<{
    raw: Buffer
    text: string
    isBinary: boolean
  }>
  sockets: Set<WebSocket>
}

const upstreams = new Set<UpstreamHandle>()
const proxies = new Set<CodexRemoteProxy>()

afterEach(async () => {
  try {
    await Promise.all([...proxies].map(async (proxy) => {
      proxies.delete(proxy)
      await proxy.close()
    }))
    await Promise.all([...upstreams].map(async (upstream) => {
      upstreams.delete(upstream)
      for (const socket of upstream.sockets) socket.close()
      await new Promise<void>((resolve) => upstream.server.close(() => resolve()))
    }))
  } finally {
    vi.useRealTimers()
  }
})

async function startUpstream(handler?: (socket: WebSocket, message: any) => void): Promise<UpstreamHandle> {
  const sockets = new Set<WebSocket>()
  const messages: unknown[] = []
  const binaryFlags: boolean[] = []
  const frames: UpstreamHandle['frames'] = []
  const server = await new Promise<WebSocketServer>((resolve, reject) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    const onListening = () => {
      wss.off('error', onError)
      resolve(wss)
    }
    const onError = (error: Error) => {
      wss.off('listening', onListening)
      reject(error)
    }
    wss.once('listening', onListening)
    wss.once('error', onError)
    wss.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.on('message', (raw, isBinary) => {
        const rawBuffer = rawDataToBuffer(raw)
        frames.push({
          raw: rawBuffer,
          text: rawBuffer.toString(),
          isBinary,
        })
        binaryFlags.push(isBinary)
        let message: unknown
        try {
          message = JSON.parse(rawBuffer.toString())
        } catch {
          message = undefined
        }
        messages.push(message)
        if (message !== undefined) handler?.(socket, message)
      })
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new Error('Upstream WebSocket server did not expose a localhost port.')
  }
  const handle = {
    server,
    wsUrl: `ws://127.0.0.1:${address.port}`,
    messages,
    binaryFlags,
    frames,
    sockets,
  }
  upstreams.add(handle)
  return handle
}

async function startProxy(upstreamWsUrl: string, options: {
  requestHoldTimeoutMs?: number
  candidateCaptureTimeoutMs?: number
  requireCandidatePersistence?: boolean
  maxRawForwardBytes?: number
} = {}): Promise<CodexRemoteProxy> {
  const proxy = new CodexRemoteProxy({ upstreamWsUrl, ...options })
  await proxy.start()
  proxies.add(proxy)
  return proxy
}

async function connect(wsUrl: string): Promise<WebSocket> {
  const socket = new WebSocket(wsUrl)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
  return socket
}

function nextMessage(socket: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    socket.once('message', (raw) => resolve(JSON.parse(raw.toString())))
  })
}

function nextMessageWithin(socket: WebSocket, ms: number): Promise<any> {
  return Promise.race([
    nextMessage(socket),
    delay(ms).then(() => {
      throw new Error(`Timed out waiting ${ms}ms for websocket message.`)
    }),
  ])
}

async function nextResponseWithIdWithin(socket: WebSocket, id: number, ms: number): Promise<any> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now())
    const message = await nextMessageWithin(socket, remainingMs)
    if (message?.id === id) return message
  }
  throw new Error(`Timed out waiting ${ms}ms for websocket response ${id}.`)
}

function nextMessageFrame(socket: WebSocket): Promise<{ message: any; isBinary: boolean }> {
  return new Promise((resolve) => {
    socket.once('message', (raw, isBinary) => resolve({
      message: JSON.parse(raw.toString()),
      isBinary,
    }))
  })
}

function collectRawFrames(socket: WebSocket, count: number): Promise<Array<{ raw: Buffer; isBinary: boolean }>> {
  return new Promise((resolve) => {
    const frames: Array<{ raw: Buffer; isBinary: boolean }> = []
    const onMessage = (raw: WebSocket.RawData, isBinary: boolean) => {
      frames.push({
        raw: rawDataToBuffer(raw),
        isBinary,
      })
      if (frames.length === count) {
        socket.off('message', onMessage)
        resolve(frames)
      }
    }
    socket.on('message', onMessage)
  })
}

function socketClosed(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve()
      return
    }
    socket.once('close', () => resolve())
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function rawDataToBuffer(raw: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw
  if (Array.isArray(raw)) return Buffer.concat(raw.map((part) => Buffer.from(part)))
  return Buffer.from(raw)
}

describe('CodexRemoteProxy', () => {
  it('preserves text and binary frames across client and upstream forwarding', async () => {
    const upstream = await startUpstream((socket, message) => {
      if (message.method === 'initialize') {
        socket.send('{ "jsonrpc" : "2.0" , "id" : 1 , "result" : { "text" : true } }', { binary: false })
      } else if (message.method === 'custom/binary') {
        socket.send(Buffer.from('{"jsonrpc":"2.0","id":2,"result":{"binary":true}}'), { binary: true })
      }
    })
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    const tui = await connect(proxy.wsUrl)
    const responseFrames = collectRawFrames(tui, 2)

    const textRequest = '{ "id" : 1 , "method" : "initialize" , "params" : { "keep" : "spacing" } }'
    const binaryRequest = Buffer.from('{"id":2,"method":"custom/binary","params":{"raw":true}}')
    tui.send(textRequest, { binary: false })
    tui.send(binaryRequest, { binary: true })

    await vi.waitFor(() => expect(upstream.frames).toHaveLength(2))
    expect(upstream.frames[0]).toMatchObject({ text: textRequest, isBinary: false })
    expect(upstream.frames[1]).toMatchObject({ text: binaryRequest.toString(), isBinary: true })

    await expect(responseFrames).resolves.toEqual([
      {
        raw: Buffer.from('{ "jsonrpc" : "2.0" , "id" : 1 , "result" : { "text" : true } }'),
        isBinary: false,
      },
      {
        raw: Buffer.from('{"jsonrpc":"2.0","id":2,"result":{"binary":true}}'),
        isBinary: true,
      },
    ])
  })

  it('captures a fresh candidate from the thread/start response and forwards the response', async () => {
    const upstream = await startUpstream((socket, message) => {
      if (message.method === 'thread/start') {
        socket.send(JSON.stringify({
          id: message.id,
          result: {
            thread: {
              id: 'thread-1',
              path: '/tmp/codex/rollout.jsonl',
              ephemeral: false,
            },
          },
        }))
      }
    })
    const proxy = await startProxy(upstream.wsUrl)
    const candidates: unknown[] = []
    proxy.onCandidate((candidate) => {
      candidates.push(candidate)
      proxy.markCandidatePersisted()
    })
    const tui = await connect(proxy.wsUrl)
    const responsePromise = nextMessageFrame(tui)

    tui.send(JSON.stringify({ id: 1, method: 'thread/start', params: {} }))

    await expect(responsePromise).resolves.toMatchObject({
      isBinary: false,
      message: {
        id: 1,
        result: {
          thread: {
            id: 'thread-1',
            path: '/tmp/codex/rollout.jsonl',
          },
        },
      },
    })
    expect(upstream.binaryFlags).toEqual([false])
    expect(candidates).toEqual([
      {
        source: 'thread_start_response',
        thread: {
          id: 'thread-1',
          path: '/tmp/codex/rollout.jsonl',
          ephemeral: false,
        },
      },
    ])
  })

  it('captures a candidate from thread/started notification', async () => {
    const upstream = await startUpstream((socket, message) => {
      if (message.method === 'initialize') {
        socket.send(JSON.stringify({ id: message.id, result: {} }))
        socket.send(JSON.stringify({
          method: 'thread/started',
          params: {
            thread: {
              id: 'thread-notified',
              path: '/tmp/codex/notified.jsonl',
            },
          },
        }))
      }
    })
    const proxy = await startProxy(upstream.wsUrl)
    const candidate = new Promise((resolve) => {
      proxy.onCandidate((event) => {
        proxy.markCandidatePersisted()
        resolve(event)
      })
    })
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({ id: 1, method: 'initialize', params: {} }))

    await expect(candidate).resolves.toEqual({
      source: 'thread_started_notification',
      thread: {
        id: 'thread-notified',
        path: '/tmp/codex/notified.jsonl',
        ephemeral: false,
      },
    })
  })

  it('holds turn/start until candidate persistence is marked complete', async () => {
    const upstream = await startUpstream((socket, message) => {
      if (message.method === 'turn/start') {
        socket.send(JSON.stringify({ id: message.id, result: { ok: true } }))
      }
    })
    const proxy = await startProxy(upstream.wsUrl, { candidateCaptureTimeoutMs: 1_000 })
    const tui = await connect(proxy.wsUrl)
    const responsePromise = nextMessage(tui)

    tui.send(JSON.stringify({ id: 7, method: 'turn/start', params: { threadId: 'thread-1' } }))
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(upstream.messages).toHaveLength(0)

    proxy.markCandidatePersisted()

    await expect(responsePromise).resolves.toEqual({ id: 7, result: { ok: true } })
    expect(upstream.messages).toEqual([
      { id: 7, method: 'turn/start', params: { threadId: 'thread-1' } },
    ])
  })

  it('holds turn/start text frames and releases them with text framing intact', async () => {
    const upstream = await startUpstream((socket, message) => {
      if (message.method === 'turn/start') {
        socket.send(JSON.stringify({ id: message.id, result: { ok: true } }))
      }
    })
    const proxy = await startProxy(upstream.wsUrl, {
      candidateCaptureTimeoutMs: 1_000,
    })
    const tui = await connect(proxy.wsUrl)

    const rawTurnStart = '{ "id" : 70 , "method" : "turn/start" , "params" : { "threadId" : "thread-1" } }'
    tui.send(rawTurnStart, { binary: false })
    await delay(25)
    expect(upstream.messages).toHaveLength(0)

    proxy.markCandidatePersisted()

    await vi.waitFor(() => expect(upstream.frames).toHaveLength(1))
    expect(upstream.frames[0]).toMatchObject({
      text: rawTurnStart,
      isBinary: false,
    })
  })

  it('holds malformed huge-param turn/start frames without parsing params while initial_capture is pending', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      candidateCaptureTimeoutMs: 1_000,
    })
    const tui = await connect(proxy.wsUrl)
    const rawTurnStart = JSON.stringify({
      id: 78,
      method: 'turn/start',
      params: {
        threadId: 42,
        padding: 'x'.repeat(64 * 1024),
      },
    })
    const originalParse: typeof JSON.parse = JSON.parse
    const parseSpy = vi.spyOn(JSON, 'parse').mockImplementation(((text, reviver) => {
      if (text === rawTurnStart) {
        throw new Error('turn/start params should not be parsed while initial_capture is pending')
      }
      return originalParse(text, reviver)
    }) as typeof JSON.parse)

    tui.send(rawTurnStart)
    await delay(25)

    expect(parseSpy.mock.calls.some(([text]) => text === rawTurnStart)).toBe(false)
    expect(upstream.messages).toEqual([])

    parseSpy.mockRestore()
    proxy.markCandidatePersisted()

    await vi.waitFor(() => expect(upstream.frames).toHaveLength(1))
    expect(upstream.frames[0]).toMatchObject({
      text: rawTurnStart,
      isBinary: false,
    })
  })

  it('raw-forwards a large valid non-fork request below the active cap', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    const tui = await connect(proxy.wsUrl)
    const payload = 'x'.repeat(MAX_FULL_PARSE_BYTES + 1_024)
    const raw = JSON.stringify({
      id: 71,
      method: 'initialize',
      params: { payload },
    })

    tui.send(raw)

    await vi.waitFor(() => expect(upstream.frames).toHaveLength(1))
    expect(upstream.frames[0]).toMatchObject({
      text: raw,
      isBinary: false,
    })
  })

  it('returns proxy_error and does not forward above-cap client requests', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      maxRawForwardBytes: 256,
      requireCandidatePersistence: false,
    })
    const repairTriggers: unknown[] = []
    proxy.onRepairTrigger((event) => repairTriggers.push(event))
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({
      id: 72,
      method: 'initialize',
      params: { payload: 'x'.repeat(512) },
    }))

    await expect(nextMessageWithin(tui, 100)).resolves.toMatchObject({
      id: 72,
      error: { message: expect.stringContaining('too large') },
    })
    await socketClosed(tui)
    expect(upstream.messages).toEqual([])
    expect(repairTriggers).toContainEqual(expect.objectContaining({ kind: 'proxy_error' }))
  })

  it('holds large turn/start requests and raw-forwards them after candidate persistence', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      candidateCaptureTimeoutMs: 1_000,
    })
    const tui = await connect(proxy.wsUrl)
    const raw = JSON.stringify({
      id: 73,
      method: 'turn/start',
      params: {
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'x'.repeat(MAX_FULL_PARSE_BYTES + 1_024) }],
      },
    })

    tui.send(raw)
    await delay(25)
    expect(upstream.messages).toEqual([])

    proxy.markCandidatePersisted()

    await vi.waitFor(() => expect(upstream.frames).toHaveLength(1))
    expect(upstream.frames[0]).toMatchObject({
      text: raw,
      isBinary: false,
    })
  })

  it('fails initial_capture when held turn/start frames overflow the held-byte cap', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      candidateCaptureTimeoutMs: 1_000,
      maxRawForwardBytes: 512,
    })
    const repairTriggers: unknown[] = []
    proxy.onRepairTrigger((event) => repairTriggers.push(event))
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({
      id: 74,
      method: 'turn/start',
      params: { threadId: 'thread-1', input: 'x'.repeat(260) },
    }))
    tui.send(JSON.stringify({
      id: 75,
      method: 'turn/start',
      params: { threadId: 'thread-1', input: 'x'.repeat(260) },
    }))

    await expect(Promise.race([
      socketClosed(tui).then(() => 'closed'),
      delay(100).then(() => 'timeout'),
    ])).resolves.toBe('closed')
    expect(upstream.messages).toEqual([])
    expect(repairTriggers).toContainEqual(expect.objectContaining({ kind: 'candidate_capture_timeout' }))
  })

  it('fails initial_capture when held turn/start frame count overflows', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      candidateCaptureTimeoutMs: 1_000,
    })
    const tui = await connect(proxy.wsUrl)

    for (let index = 0; index < 40; index += 1) {
      tui.send(JSON.stringify({
        id: 760 + index,
        method: 'turn/start',
        params: { threadId: 'thread-1', input: String(index) },
      }))
    }

    await expect(Promise.race([
      socketClosed(tui).then(() => 'closed'),
      delay(100).then(() => 'timeout'),
    ])).resolves.toBe('closed')
    expect(upstream.messages).toEqual([])
  })

  it('holds fork_handoff turn/start frames and releases them through candidate persistence', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    ;(proxy as any).identityGate = {
      reason: 'fork_handoff',
      heldFrames: [],
      heldBytes: 0,
    }
    const tui = await connect(proxy.wsUrl)
    const rawTurnStart = JSON.stringify({
      id: 77,
      method: 'turn/start',
      params: { threadId: 'thread-child' },
    })

    tui.send(rawTurnStart)
    await delay(25)
    expect(upstream.messages).toEqual([])

    proxy.markCandidatePersisted()

    await vi.waitFor(() => expect(upstream.frames).toHaveLength(1))
    expect(upstream.frames[0]).toMatchObject({
      text: rawTurnStart,
      isBinary: false,
    })
  })

  it('fails the overflow-causing fork_handoff turn/start request with an error and closes that client', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      maxRawForwardBytes: 512,
      requireCandidatePersistence: false,
    })
    ;(proxy as any).identityGate = {
      reason: 'fork_handoff',
      heldFrames: [],
      heldBytes: 0,
    }
    const firstTui = await connect(proxy.wsUrl)
    const overflowTui = await connect(proxy.wsUrl)
    const overflowResponse = nextMessage(overflowTui)
    const overflowClosed = socketClosed(overflowTui)

    firstTui.send(JSON.stringify({
      id: 79,
      method: 'turn/start',
      params: { threadId: 'thread-child', input: 'x'.repeat(260) },
    }))
    await delay(25)
    expect(upstream.messages).toEqual([])

    overflowTui.send(JSON.stringify({
      id: 80,
      method: 'turn/start',
      params: { threadId: 'thread-child', input: 'x'.repeat(260) },
    }))

    await expect(overflowResponse).resolves.toMatchObject({
      id: 80,
      error: { message: expect.stringContaining('fork handoff') },
    })
    await expect(overflowClosed).resolves.toBeUndefined()
    expect(upstream.messages).toEqual([])
  })

  it('fails held turn/start and closes sockets when candidate persistence times out', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      requestHoldTimeoutMs: 20,
      candidateCaptureTimeoutMs: 1_000,
    })
    const repairTriggers: unknown[] = []
    proxy.onRepairTrigger((event) => repairTriggers.push(event))
    const tui = await connect(proxy.wsUrl)
    const responsePromise = nextMessage(tui)

    tui.send(JSON.stringify({ id: 9, method: 'turn/start', params: { threadId: 'thread-1' } }))

    await expect(responsePromise).resolves.toMatchObject({
      id: 9,
      error: {
        code: -32000,
        message: expect.stringContaining('persist Codex restore identity'),
      },
    })
    await socketClosed(tui)
    expect(upstream.messages).toHaveLength(0)
    expect(repairTriggers).toContainEqual({ kind: 'candidate_capture_timeout' })
  })

  it('does not hold turn/start or arm candidate-capture timeout when candidate persistence is not required', async () => {
    const upstream = await startUpstream((socket, message) => {
      if (message.method === 'turn/start') {
        socket.send(JSON.stringify({ id: message.id, result: { ok: true } }))
      }
    })
    const proxy = await startProxy(upstream.wsUrl, {
      requestHoldTimeoutMs: 20,
      candidateCaptureTimeoutMs: 20,
      requireCandidatePersistence: false,
    })
    const repairTriggers: unknown[] = []
    proxy.onRepairTrigger((event) => repairTriggers.push(event))
    const tui = await connect(proxy.wsUrl)
    const responsePromise = nextMessage(tui)

    tui.send(JSON.stringify({ id: 11, method: 'turn/start', params: { threadId: 'durable-thread-1' } }))

    await expect(responsePromise).resolves.toEqual({ id: 11, result: { ok: true } })
    expect(upstream.messages).toEqual([
      { id: 11, method: 'turn/start', params: { threadId: 'durable-thread-1' } },
    ])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(tui.readyState).toBe(WebSocket.OPEN)
    expect(repairTriggers).toEqual([])
  })

  it('closes an idle TUI when candidate capture times out before user input', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      candidateCaptureTimeoutMs: 20,
    })
    const repairTriggers: unknown[] = []
    proxy.onRepairTrigger((event) => repairTriggers.push(event))
    const tui = await connect(proxy.wsUrl)

    await socketClosed(tui)
    expect(upstream.messages).toHaveLength(0)
    expect(repairTriggers).toContainEqual({ kind: 'candidate_capture_timeout' })
  })

  it('times out candidate capture even when the TUI never connects to the proxy', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      candidateCaptureTimeoutMs: 20,
    })
    const repairTriggers: unknown[] = []
    proxy.onRepairTrigger((event) => repairTriggers.push(event))

    await delay(50)

    expect(upstream.messages).toHaveLength(0)
    expect(repairTriggers).toContainEqual({ kind: 'candidate_capture_timeout' })
  })

  it('keeps candidate capture paused when a real client connection would otherwise rearm the timer', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      candidateCaptureTimeoutMs: 20,
    })
    const repairTriggers: unknown[] = []
    proxy.onRepairTrigger((event) => repairTriggers.push(event))

    proxy.pauseCandidateCapture('startup_update_prompt')
    const tui = await connect(proxy.wsUrl)

    await delay(50)

    expect(tui.readyState).toBe(WebSocket.OPEN)
    expect(upstream.sockets.size).toBe(1)
    expect(upstream.messages).toEqual([])
    expect(repairTriggers).toEqual([])

    tui.close()
    await socketClosed(tui)
  })

  it('resumes candidate capture timeout so a later timeout still fires', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      candidateCaptureTimeoutMs: 20,
    })
    const repairTriggers: unknown[] = []
    proxy.onRepairTrigger((event) => repairTriggers.push(event))

    proxy.pauseCandidateCapture('startup_update_prompt')
    await delay(50)
    expect(repairTriggers).toEqual([])

    proxy.resumeCandidateCapture('startup_update_prompt_skipped')
    await delay(50)

    expect(repairTriggers).toContainEqual({ kind: 'candidate_capture_timeout' })
  })

  it('leaves pause and resume as no-ops after candidate persistence', () => {
    vi.useFakeTimers()
    const proxy = new CodexRemoteProxy({
      upstreamWsUrl: 'ws://127.0.0.1:1',
      candidateCaptureTimeoutMs: 1_000,
    })
    proxies.add(proxy)
    const repairTriggers: unknown[] = []
    proxy.onRepairTrigger((event) => repairTriggers.push(event))

    proxy.markCandidatePersisted()
    proxy.pauseCandidateCapture('after_persistence')
    proxy.resumeCandidateCapture('after_persistence')
    vi.advanceTimersByTime(5_000)

    expect(repairTriggers).toEqual([])
  })

  it('leaves pause and resume as no-ops after candidate timeout failure', () => {
    vi.useFakeTimers()
    const proxy = new CodexRemoteProxy({
      upstreamWsUrl: 'ws://127.0.0.1:1',
      candidateCaptureTimeoutMs: 1_000,
    })
    proxies.add(proxy)
    const repairTriggers: unknown[] = []
    proxy.onRepairTrigger((event) => repairTriggers.push(event))

    proxy.failCandidateCapture()
    proxy.pauseCandidateCapture('after_timeout_failure')
    proxy.resumeCandidateCapture('after_timeout_failure')
    vi.advanceTimersByTime(5_000)

    expect(repairTriggers).toEqual([{ kind: 'candidate_capture_timeout' }])
  })

  it('leaves pause and resume as no-ops when candidate persistence is not required', () => {
    vi.useFakeTimers()
    const proxy = new CodexRemoteProxy({
      upstreamWsUrl: 'ws://127.0.0.1:1',
      candidateCaptureTimeoutMs: 1_000,
      requireCandidatePersistence: false,
    })
    proxies.add(proxy)
    const repairTriggers: unknown[] = []
    proxy.onRepairTrigger((event) => repairTriggers.push(event))

    proxy.pauseCandidateCapture('durable_resume')
    proxy.resumeCandidateCapture('durable_resume')
    vi.advanceTimersByTime(5_000)

    expect(repairTriggers).toEqual([])
  })

  it('does not arm the no-client candidate-capture timeout for durable resumes', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      candidateCaptureTimeoutMs: 20,
      requireCandidatePersistence: false,
    })
    const repairTriggers: unknown[] = []
    proxy.onRepairTrigger((event) => repairTriggers.push(event))

    await delay(50)

    expect(upstream.messages).toHaveLength(0)
    expect(repairTriggers).toEqual([])
  })

  it('emits turn/completed notifications', async () => {
    const upstream = await startUpstream((socket, message) => {
      if (message.method === 'initialize') {
        socket.send(JSON.stringify({ id: message.id, result: {} }))
        socket.send(JSON.stringify({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turnId: 'turn-1', status: 'completed' },
        }))
      }
    })
    const proxy = await startProxy(upstream.wsUrl)
    const completed = new Promise((resolve) => {
      proxy.onTurnCompleted((event) => {
        proxy.markCandidatePersisted()
        resolve(event)
      })
    })
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({ id: 1, method: 'initialize', params: {} }))

    await expect(completed).resolves.toEqual({
      threadId: 'thread-1',
      turnId: 'turn-1',
      params: { threadId: 'thread-1', turnId: 'turn-1', status: 'completed' },
    })
  })

  it('acks duplicate turn/interrupt after the turn already completed', async () => {
    const interruptRequests: unknown[] = []
    const upstream = await startUpstream((socket, message) => {
      if (message.method !== 'turn/interrupt') return
      interruptRequests.push(message)
      if (interruptRequests.length !== 1) return

      socket.send(JSON.stringify({ id: message.id, result: {} }))
      socket.send(JSON.stringify({
        method: 'thread/status/changed',
        params: { threadId: 'thread-1', status: { type: 'idle' } },
      }))
      socket.send(JSON.stringify({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turnId: 'turn-1' },
      }))
    })
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    const completed = new Promise((resolve) => {
      proxy.onTurnCompleted((event) => resolve(event))
    })
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({
      id: 1,
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    }))
    await expect(nextMessageWithin(tui, 100)).resolves.toEqual({ id: 1, result: {} })
    await expect(completed).resolves.toMatchObject({ threadId: 'thread-1', turnId: 'turn-1' })

    tui.send(JSON.stringify({
      id: 2,
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    }))

    await expect(nextResponseWithIdWithin(tui, 2, 50)).resolves.toEqual({ id: 2, result: {} })
    await delay(25)
    expect(interruptRequests).toHaveLength(1)
  })

  it('forwards large turn/interrupt frames instead of parsing params for duplicate ack', async () => {
    const interruptRequests: unknown[] = []
    const upstream = await startUpstream((socket, message) => {
      if (message.method !== 'turn/interrupt') return
      interruptRequests.push(message)
      if (interruptRequests.length !== 1) return

      socket.send(JSON.stringify({ id: message.id, result: {} }))
      socket.send(JSON.stringify({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turnId: 'turn-1' },
      }))
    })
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    const completed = new Promise((resolve) => {
      proxy.onTurnCompleted((event) => resolve(event))
    })
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({
      id: 81,
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    }))
    await expect(nextMessageWithin(tui, 100)).resolves.toEqual({ id: 81, result: {} })
    await expect(completed).resolves.toMatchObject({ threadId: 'thread-1', turnId: 'turn-1' })

    const largeDuplicateInterrupt = JSON.stringify({
      id: 82,
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
      padding: 'x'.repeat(MAX_FULL_PARSE_BYTES + 1_024),
    })
    tui.send(largeDuplicateInterrupt)

    await vi.waitFor(() => expect(interruptRequests).toHaveLength(2))
    expect(upstream.frames[1]).toMatchObject({
      text: largeDuplicateInterrupt,
      isBinary: false,
    })
  })

  it('forces terminal thread/fork requests to exclude turns before forwarding upstream', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({
      id: 21,
      method: 'thread/fork',
      params: {
        threadId: 'thread-parent',
        cwd: '/repo',
        excludeTurns: false,
        nested: { excludeTurns: false },
      },
    }))

    await vi.waitFor(() => expect(upstream.messages).toHaveLength(1))
    expect(upstream.messages[0]).toEqual({
      id: 21,
      method: 'thread/fork',
      params: {
        threadId: 'thread-parent',
        cwd: '/repo',
        excludeTurns: true,
        nested: { excludeTurns: false },
      },
    })
  })

  it('forces large terminal thread/fork requests to exclude turns before forwarding upstream', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({
      id: 83,
      method: 'thread/fork',
      params: {
        threadId: 'thread-parent',
        cwd: '/repo',
        excludeTurns: false,
        metadata: 'x'.repeat(MAX_FULL_PARSE_BYTES + 1_024),
      },
    }))

    await vi.waitFor(() => expect(upstream.messages).toHaveLength(1))
    expect(upstream.messages[0]).toMatchObject({
      id: 83,
      method: 'thread/fork',
      params: {
        threadId: 'thread-parent',
        cwd: '/repo',
        excludeTurns: true,
      },
    })
  })

  it('returns an error for unrewriteable thread/fork requests without forwarding upstream', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({
      id: 84,
      method: 'thread/fork',
      params: {
        threadId: 'thread-parent',
        excludeTurns: 'nope',
      },
    }))

    await expect(nextMessageWithin(tui, 100)).resolves.toMatchObject({
      id: 84,
      error: { message: expect.stringContaining('thread/fork') },
    })
    await delay(25)
    expect(upstream.messages).toEqual([])
  })

  it('returns an error for malformed thread/fork requests without forwarding upstream', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    const tui = await connect(proxy.wsUrl)

    tui.send('{"id":85,"method":"thread/fork","params":{"threadId":"thread-parent","excludeTurns":false}')

    await expect(nextMessageWithin(tui, 100)).resolves.toMatchObject({
      error: { message: expect.stringContaining('malformed_json') },
    })
    await delay(25)
    expect(upstream.messages).toEqual([])
  })

  it('rejects nested thread/fork requests while a fork_handoff gate is active', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    ;(proxy as any).identityGate = {
      reason: 'fork_handoff',
      heldFrames: [],
      heldBytes: 0,
    }
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({
      id: 86,
      method: 'thread/fork',
      params: { threadId: 'thread-child' },
    }))

    await expect(nextMessageWithin(tui, 100)).resolves.toMatchObject({
      id: 86,
      error: { message: expect.stringContaining('fork handoff') },
    })
    await delay(25)
    expect(upstream.messages).toEqual([])
  })

  it('treats root array batches as unsafe instead of forwarding possible fork traffic', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify([
      { id: 31, method: 'thread/fork', params: { threadId: 'thread-parent' } },
    ]))

    await expect(nextMessageWithin(tui, 100)).resolves.toMatchObject({
      error: { message: expect.stringContaining('batch') },
    })
    await socketClosed(tui)
    expect(upstream.messages).toEqual([])
  })

  it('stages fork response candidates and holds post-fork stateful traffic until persistence is acknowledged', async () => {
    const upstream = await startUpstream((socket, message) => {
      if (message.method === 'thread/fork') {
        socket.send(JSON.stringify({
          id: message.id,
          result: {
            thread: {
              id: 'thread-child',
              path: '/tmp/codex/fork-child-rollout.jsonl',
              ephemeral: false,
            },
          },
        }))
      }
    })
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    const candidates: unknown[] = []
    proxy.onCandidate((candidate) => candidates.push(candidate))
    const tui = await connect(proxy.wsUrl)
    const forkResponse = nextMessageFrame(tui)

    tui.send(JSON.stringify({
      id: 41,
      method: 'thread/fork',
      params: { threadId: 'thread-parent', excludeTurns: false },
    }))

    await expect(forkResponse).resolves.toMatchObject({
      isBinary: false,
      message: {
        id: 41,
        result: {
          thread: {
            id: 'thread-child',
            path: '/tmp/codex/fork-child-rollout.jsonl',
            turns: [],
          },
        },
      },
    })
    expect(candidates).toEqual([
      {
        source: 'thread_fork_response',
        thread: {
          id: 'thread-child',
          path: '/tmp/codex/fork-child-rollout.jsonl',
          ephemeral: false,
        },
      },
    ])

    tui.send(JSON.stringify({
      id: 42,
      method: 'turn/start',
      params: {
        threadId: 'thread-child',
        input: [{ type: 'text', text: 'held until staged' }],
      },
    }))

    await delay(50)
    expect(upstream.messages).toHaveLength(1)
    proxy.markCandidatePersisted()
    await vi.waitFor(() => expect(upstream.messages).toHaveLength(2))
    expect(upstream.messages[1]).toMatchObject({
      id: 42,
      method: 'turn/start',
      params: { threadId: 'thread-child' },
    })
  })
})
