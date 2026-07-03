# Codex Fork OOM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make terminal Codex `/fork` memory-safe in Freshell by preventing giant fork history payloads from being requested or fully parsed by the server proxy.

**Architecture:** Keep the fix in the Codex app-server remote proxy, because that is the terminal Codex path that observed the OOM. Rewrite outbound `thread/fork` JSON-RPC requests so upstream Codex receives `excludeTurns: true`, and refactor upstream forwarding so Freshell only performs bounded envelope inspection plus targeted parsing for messages it actually consumes. Do not change fresh-agent Codex behavior; it already forks with `excludeTurns: true`.

**Tech Stack:** Node.js 22, TypeScript/ESM, `ws`, Vitest, existing Freshell coordinated test scripts.

---

## Strategy Gate

The direct user-visible goal is that running `/fork` inside a terminal Codex pane should still create a usable fork, but Freshell should not ask Codex to return the full copied turn history and should not materialize a huge upstream response as a JavaScript object. Increasing Node heap size, restarting the self-hosted server, or hiding the crash with process supervision would treat the symptom and leave the same protocol hazard in place.

The clean steady-state design is a small proxy-level protocol guard:

- For terminal Codex `thread/fork`, Freshell always forwards `params.excludeTurns = true`. If the TUI sends `excludeTurns: false`, Freshell overrides it. If `params` is missing or invalid, Freshell still forwards an object containing `excludeTurns: true`; Codex remains responsible for returning the normal validation error for missing required fields such as `threadId`.
- For upstream responses, Freshell avoids full `JSON.parse` unless the message is small enough and belongs to behavior the proxy owns: candidate capture from `thread/start`, turn/lifecycle/fs notifications, and duplicate completed-turn interrupt bookkeeping. Regular responses such as `thread/fork` are forwarded without full parse.
- Text-vs-binary frame semantics must be preserved. Avoid `raw.toString()` for uninspected large text frames by sending raw bytes with `binary: false` when the original frame was text.
- Bounded JSON-RPC envelope inspection must only read top-level `id` and `method` fields. Do not use broad regex searches over the prefix; large Codex payloads commonly contain nested `id` fields in `thread.turns`, and treating those as response IDs can corrupt `pendingMethods`.

Important compatibility trade-off: the terminal Codex client will no longer receive the full `turns` array inside the immediate `thread/fork` result. That is intentional. The fork should remain server-side and the response still carries the forked thread metadata. If the Codex TUI needs turns later, it should fetch them through read/list APIs instead of receiving all history in the fork response.

No user decision is required. The user approved implementing the safer behavior, and the fresh-agent Codex path already establishes the same `excludeTurns` contract.

## File Structure

- Modify: `server/coding-cli/codex-app-server/remote-proxy.ts`
  - Owns terminal Codex WebSocket proxy behavior.
  - Add fork request rewriting.
  - Add bounded JSON-RPC envelope inspection helpers.
  - Add frame forwarding that preserves text frames without converting uninspected payloads to full strings.
  - Keep candidate/turn/lifecycle event emission behavior intact.

- Modify: `test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts`
  - Add regression coverage for terminal `thread/fork` request rewriting.
  - Add regression coverage that a `thread/fork` response is forwarded without `JSON.parse` in the proxy.
  - Keep existing candidate persistence, notification, and interrupt tests green.

- Do not modify: `server/fresh-agent/adapters/codex/adapter.ts`
  - Existing fresh-agent tests already assert `excludeTurns: true` on forks. This plan should not churn that code.

- Do not modify: `docs/index.html`
  - This is a server-side reliability fix, not a new user-facing feature or significant UI change.

## Contracts And Invariants

- Terminal Codex `/fork` must still forward a valid JSON-RPC `thread/fork` request upstream with the original `id`, `jsonrpc` field if present, `threadId`, cwd/model/sandbox/approval/config fields, and any other params the TUI supplied.
- Upstream must always see `params.excludeTurns === true` for `thread/fork`, even when the client omitted it or explicitly set it to `false`.
- The proxy must continue to hold `turn/start` until restore candidate persistence is marked complete.
- The proxy must continue to capture restore candidates from `thread/start` responses and `thread/started` notifications.
- The proxy must continue to emit `turn/started`, `turn/completed`, fs-change, and thread lifecycle events from notifications.
- The proxy must not fully parse large upstream responses that it does not need to inspect, especially `thread/fork` responses.
- Bounded upstream inspection must never use nested payload fields as JSON-RPC envelope fields. If a large response has `result.thread.turns[0].id` before the top-level response `id`, the proxy must forward it without clearing unrelated pending methods.
- Frame direction and type must remain correct: text frames stay text frames, binary frames stay binary frames.
- Logging should remain structured and should include method/id where bounded envelope inspection can identify them. Logs must not include full response bodies.

## Implementation Tasks

### Task 1: Add Red Tests For Terminal Fork Rewriting

**Files:**
- Modify: `test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts`
- Test: `test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test near the other forwarding tests in `describe('CodexRemoteProxy', ...)`:

```ts
  it('forces excludeTurns on terminal thread/fork requests before forwarding upstream', async () => {
    const upstream = await startUpstream((socket, message) => {
      if (message.method === 'thread/fork') {
        socket.send(JSON.stringify({
          id: message.id,
          result: {
            thread: { id: 'thread-fork-1', path: '/tmp/codex/fork.jsonl', ephemeral: false },
          },
        }))
      }
    })
    const proxy = await startProxy(upstream.wsUrl, { requireCandidatePersistence: false })
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 21,
      method: 'thread/fork',
      params: {
        threadId: 'thread-parent-1',
        cwd: '/repo',
        model: 'gpt-5.3-codex',
        excludeTurns: false,
      },
    }))

    await expect(nextResponseWithIdWithin(tui, 21, 100)).resolves.toMatchObject({
      id: 21,
      result: { thread: { id: 'thread-fork-1' } },
    })
    expect(upstream.messages).toEqual([
      {
        jsonrpc: '2.0',
        id: 21,
        method: 'thread/fork',
        params: {
          threadId: 'thread-parent-1',
          cwd: '/repo',
          model: 'gpt-5.3-codex',
          excludeTurns: true,
        },
      },
    ])
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts --testNamePattern "forces excludeTurns"
```

Expected: FAIL because upstream currently receives `excludeTurns: false`.

- [ ] **Step 3: Write minimal implementation**

In `server/coding-cli/codex-app-server/remote-proxy.ts`, update `handleClientMessage` to rewrite only `thread/fork` before storing the pending method, holding turn starts, or forwarding:

```ts
  private handleClientMessage(connection: ProxyConnection, raw: WebSocket.RawData, isBinary: boolean): void {
    const parsed = parseJson(raw)
    const method = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).method : undefined
    const id = jsonRpcId(parsed)
    const forward = method === 'thread/fork'
      ? rewriteThreadForkRequest(parsed, raw, isBinary)
      : createFrame(raw, isBinary)
    // keep the existing logging, completedTurnInterrupt, pendingMethods, turn/start hold,
    // and sendIfOpen flow, but pass `forward` instead of a raw string.
  }
```

Add the helper in the same file:

```ts
function rewriteThreadForkRequest(parsed: unknown, raw: WebSocket.RawData, isBinary: boolean): ProxyFrame {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return createFrame(raw, isBinary)
  const message = parsed as Record<string, unknown>
  if (message.method !== 'thread/fork') return createFrame(raw, isBinary)
  const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params)
    ? { ...(message.params as Record<string, unknown>), excludeTurns: true }
    : { excludeTurns: true }
  return {
    data: JSON.stringify({ ...message, params }),
    isBinary: false,
  }
}
```

This step can temporarily keep the existing `framePayload`/`sendIfOpen` shape if desired, as long as the test passes. Task 2 will refactor forwarding frames more completely.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts --testNamePattern "forces excludeTurns"
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Keep the fork rewrite small and isolated. Do not parse or validate Codex fork params in Freshell; validation belongs to the upstream Codex app-server and the existing typed fresh-agent client path.

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts
```

Expected: all tests in `remote-proxy.test.ts` PASS.

- [ ] **Step 6: Commit**

```bash
git add server/coding-cli/codex-app-server/remote-proxy.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts
git commit -m "fix: force codex fork responses to exclude turns"
```

### Task 2: Add Red Test For Raw Forwarding Of Fork Responses

**Files:**
- Modify: `test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts`
- Test: `test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts`

- [ ] **Step 1: Write the failing test**

Add these local helpers if they do not already exist:

```ts
async function waitForCondition(assertion: () => void, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await delay(5)
    }
  }
  if (lastError) throw lastError
  assertion()
}

function nextRawMessageFrame(socket: WebSocket): Promise<{ raw: WebSocket.RawData; isBinary: boolean }> {
  return new Promise((resolve) => {
    socket.once('message', (raw, isBinary) => resolve({ raw, isBinary }))
  })
}
```

Add the regression test:

```ts
  it('forwards terminal thread/fork responses without full proxy-side JSON parsing', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, { requireCandidatePersistence: false })
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({
      id: 31,
      method: 'thread/fork',
      params: { threadId: 'thread-parent-1' },
    }))
    await waitForCondition(() => {
      expect(upstream.messages).toHaveLength(1)
    })

    const rawFrame = nextRawMessageFrame(tui)
    const parseSpy = vi.spyOn(JSON, 'parse')
    parseSpy.mockClear()
    const response = JSON.stringify({
      id: 31,
      result: {
        thread: {
          id: 'thread-fork-1',
          path: '/tmp/codex/fork.jsonl',
          turns: Array.from({ length: 2_000 }, (_, index) => ({
            id: `turn-${index}`,
            items: [{ type: 'text', text: `large response body ${index}` }],
          })),
        },
      },
    })

    for (const socket of upstream.sockets) {
      socket.send(response)
    }

    const frame = await rawFrame
    expect(frame.isBinary).toBe(false)
    expect(frame.raw.toString()).toBe(response)
    const parsedPayloads = parseSpy.mock.calls.map(([payload]) => typeof payload === 'string' ? payload : String(payload))
    expect(parsedPayloads).not.toContain(response)
    expect(parsedPayloads.every((payload) => payload.length < 256)).toBe(true)
    parseSpy.mockRestore()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts --testNamePattern "forwards terminal thread/fork responses without full proxy-side JSON parsing"
```

Expected: FAIL because `handleUpstreamMessage` currently calls `parseJson(raw)`, which calls `JSON.parse` for the fork response.

- [ ] **Step 3: Write minimal implementation**

Refactor forwarding in `server/coding-cli/codex-app-server/remote-proxy.ts` around an explicit frame type:

```ts
type ProxyFrame = {
  data: WebSocket.RawData | string
  isBinary: boolean
}

const MAX_JSON_RPC_ENVELOPE_BYTES = 64 * 1024
const MAX_UPSTREAM_FULL_PARSE_BYTES = 1024 * 1024
```

Replace `framePayload` with helpers that do bounded inspection:

```ts
function createFrame(raw: WebSocket.RawData, isBinary: boolean): ProxyFrame {
  return { data: raw, isBinary }
}

function sendIfOpen(socket: WebSocket, frame: ProxyFrame | WebSocket.RawData | string): void {
  const send = () => {
    if (typeof frame === 'object' && frame !== null && 'data' in frame && 'isBinary' in frame) {
      socket.send(frame.data, { binary: frame.isBinary })
    } else {
      socket.send(frame)
    }
  }
  if (socket.readyState === WebSocket.OPEN) {
    send()
  } else if (socket.readyState === WebSocket.CONNECTING) {
    socket.once('open', () => {
      if (socket.readyState === WebSocket.OPEN) send()
    })
  }
}

function rawByteLength(raw: WebSocket.RawData | string): number {
  if (typeof raw === 'string') return Buffer.byteLength(raw)
  if (Buffer.isBuffer(raw)) return raw.byteLength
  if (raw instanceof ArrayBuffer) return raw.byteLength
  if (Array.isArray(raw)) return raw.reduce((sum, part) => sum + part.byteLength, 0)
  return Buffer.byteLength(String(raw))
}

function rawPrefix(raw: WebSocket.RawData, maxBytes: number): string {
  if (typeof raw === 'string') return raw.slice(0, maxBytes)
  if (Buffer.isBuffer(raw)) return raw.subarray(0, maxBytes).toString('utf8')
  if (raw instanceof ArrayBuffer) return Buffer.from(raw, 0, Math.min(raw.byteLength, maxBytes)).toString('utf8')
  if (Array.isArray(raw)) {
    const chunks: Buffer[] = []
    let remaining = maxBytes
    for (const part of raw) {
      if (remaining <= 0) break
      chunks.push(part.subarray(0, remaining))
      remaining -= Math.min(part.byteLength, remaining)
    }
    return Buffer.concat(chunks).toString('utf8')
  }
  return ''
}

function inspectJsonRpcEnvelope(raw: WebSocket.RawData, isBinary: boolean): { id?: JsonRpcId; method?: string } {
  if (isBinary) return {}
  const prefix = rawPrefix(raw, MAX_JSON_RPC_ENVELOPE_BYTES)
  return readTopLevelJsonRpcEnvelope(prefix)
}

function readTopLevelJsonRpcEnvelope(prefix: string): { id?: JsonRpcId; method?: string } {
  const envelope: { id?: JsonRpcId; method?: string } = {}
  let index = skipWhitespace(prefix, 0)
  if (prefix[index] !== '{') return envelope
  index += 1

  while (index < prefix.length) {
    index = skipWhitespace(prefix, index)
    if (prefix[index] === '}') return envelope

    const key = readJsonStringAt(prefix, index)
    if (!key) return envelope
    index = skipWhitespace(prefix, key.end)
    if (prefix[index] !== ':') return envelope
    index = skipWhitespace(prefix, index + 1)

    if (key.value === 'id') {
      const id = readJsonRpcIdAt(prefix, index)
      if (id.matched) envelope.id = id.value
      index = id.end
    } else if (key.value === 'method') {
      const method = readJsonStringAt(prefix, index)
      if (method) {
        envelope.method = method.value
        index = method.end
      } else {
        const next = skipJsonValue(prefix, index)
        if (next === undefined) return envelope
        index = next
      }
    } else {
      const next = skipJsonValue(prefix, index)
      if (next === undefined) return envelope
      index = next
    }

    index = skipWhitespace(prefix, index)
    if (prefix[index] === ',') {
      index += 1
      continue
    }
    if (prefix[index] === '}') return envelope
    return envelope
  }

  return envelope
}

function readJsonRpcIdAt(input: string, start: number): { matched: true; value: JsonRpcId; end: number } | { matched: false; end: number } {
  const stringValue = readJsonStringAt(input, start)
  if (stringValue) return { matched: true, value: stringValue.value, end: stringValue.end }

  const numeric = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(input.slice(start))
  if (!numeric) return { matched: false, end: start }
  const value = Number(numeric[0])
  return Number.isFinite(value)
    ? { matched: true, value, end: start + numeric[0].length }
    : { matched: false, end: start }
}

function readJsonStringAt(input: string, start: number): { value: string; end: number } | undefined {
  if (input[start] !== '"') return undefined
  let escaped = false
  for (let index = start + 1; index < input.length; index += 1) {
    const char = input[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') {
      try {
        const value = JSON.parse(input.slice(start, index + 1))
        return typeof value === 'string' ? { value, end: index + 1 } : undefined
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

function skipJsonValue(input: string, start: number): number | undefined {
  const first = input[start]
  if (first === '"') return readJsonStringAt(input, start)?.end
  if (first === '{' || first === '[') {
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < input.length; index += 1) {
      const char = input[index]
      if (inString) {
        if (escaped) {
          escaped = false
        } else if (char === '\\') {
          escaped = true
        } else if (char === '"') {
          inString = false
        }
        continue
      }
      if (char === '"') {
        inString = true
      } else if (char === '{' || char === '[') {
        depth += 1
      } else if (char === '}' || char === ']') {
        depth -= 1
        if (depth === 0) return index + 1
      }
    }
    return undefined
  }
  let index = start
  while (index < input.length && input[index] !== ',' && input[index] !== '}' && input[index] !== ']') {
    index += 1
  }
  return index > start ? index : undefined
}

function skipWhitespace(input: string, start: number): number {
  let index = start
  while (/\s/.test(input[index] ?? '')) index += 1
  return index
}

function parseJsonIfSmall(raw: WebSocket.RawData, isBinary: boolean): unknown {
  if (isBinary || rawByteLength(raw) > MAX_UPSTREAM_FULL_PARSE_BYTES) return undefined
  return parseJson(raw)
}
```

Then update `handleUpstreamMessage`:

```ts
  private handleUpstreamMessage(connection: ProxyConnection, raw: WebSocket.RawData, isBinary: boolean): void {
    const forward = createFrame(raw, isBinary)
    const envelope = inspectJsonRpcEnvelope(raw, isBinary)
    if (envelope.id !== undefined) {
      const method = connection.pendingMethods.get(envelope.id)
      connection.pendingMethods.delete(envelope.id)
      log.debug({ proxyWsUrl: this.endpoint ? this.wsUrl : undefined, upstreamWsUrl: this.upstreamWsUrl, method, id: envelope.id }, 'Codex remote proxy forwarding upstream response')
      if (method === 'thread/start') {
        this.maybeEmitThreadStartResponseCandidate(parseJsonIfSmall(raw, isBinary))
      }
    } else {
      const method = envelope.method
      if (typeof method === 'string') {
        log.debug({ proxyWsUrl: this.endpoint ? this.wsUrl : undefined, upstreamWsUrl: this.upstreamWsUrl, method }, 'Codex remote proxy forwarding upstream notification')
      }
      this.handleUpstreamNotification(parseJsonIfSmall(raw, isBinary))
    }
    sendIfOpen(connection.client, forward)
  }
```

Keep `parseJson(raw)` for client messages because those requests are small and the proxy needs method/id/interrupt details. Do not call `parseJsonIfSmall` in the client request path unless needed.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts --testNamePattern "forwards terminal thread/fork responses without full proxy-side JSON parsing"
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Tighten helper names and types:

- `ProxyFrame` should be used for all proxy forwarding paths, including held `turn/start` records.
- `sendJsonRpcError` and `sendJsonRpcSuccess` may keep sending strings, or may wrap them as `ProxyFrame`; either is acceptable if tests pass and frame type remains text.
- Avoid broad regex searches over raw response prefixes. Parsing a tiny JSON string literal while scanning a top-level key/value is acceptable because it is bounded and cannot match nested payload fields. The fork-response regression must assert that the full response body was not passed to `JSON.parse`, not that `JSON.parse` was never called for bounded scanner internals.
- If a large notification cannot be parsed, forward it and skip proxy side-effects rather than risking OOM. Add a debug or warn log only if it is useful and does not spam.

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts
npm run typecheck:server
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add server/coding-cli/codex-app-server/remote-proxy.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts
git commit -m "fix: avoid parsing large codex proxy responses"
```

### Task 3: Strengthen Coverage For Existing Proxy-Owned Messages

**Files:**
- Modify: `test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts`
- Test: `test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts`

- [ ] **Step 1: Identify or write the failing test**

First add a regression test that protects the bounded envelope scanner from treating nested payload IDs as top-level JSON-RPC IDs. This test may already pass before Task 2 because the current proxy fully parses responses; it is still required because it fails against the tempting but incorrect prefix-regex implementation.

```ts
  it('does not treat nested response body ids as JSON-RPC envelope ids', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, { requireCandidatePersistence: false })
    const candidates: unknown[] = []
    proxy.onCandidate((candidate) => candidates.push(candidate))
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({ id: 'pending-thread-start', method: 'thread/start', params: {} }))
    await waitForCondition(() => {
      expect(upstream.messages).toHaveLength(1)
    })

    const confusingLargeResponse = JSON.stringify({
      result: {
        id: 'pending-thread-start',
        thread: {
          id: 'fork-thread',
          turns: [
            ...Array.from({ length: 2_000 }, (_, index) => ({
              id: `turn-${index}`,
              items: [{ type: 'text', text: `large response body ${index}` }],
            })),
          ],
        },
      },
      id: 'unrelated-large-response',
    })
    for (const socket of upstream.sockets) {
      socket.send(confusingLargeResponse)
    }
    await nextRawMessageFrame(tui)

    for (const socket of upstream.sockets) {
      socket.send(JSON.stringify({
        id: 'pending-thread-start',
        result: {
          thread: {
            id: 'thread-1',
            path: '/tmp/codex/rollout.jsonl',
            ephemeral: false,
          },
        },
      }))
    }

    await waitForCondition(() => {
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
  })
```

The first nested `id` in this fixture must intentionally equal the pending `thread/start` request id while the real top-level response id appears after the large `result`. A broad prefix regex would clear the pending `thread/start` entry incorrectly; a top-level envelope reader should either identify only true top-level fields or return no id for this truncated prefix.

Run the existing tests that protect proxy-owned parsing behavior:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts --testNamePattern "captures a fresh candidate|captures a candidate|emits turn/completed|acks duplicate"
```

Expected before implementation may be PASS or may expose a regression from Task 2. If all pass, add no tautological tests beyond the nested-id regression above. If any fail, treat the existing failing behavior as the red test for this task.

- [ ] **Step 2: Run test to verify failure if needed**

If Task 2 broke candidate capture or notifications, keep the failing command and exact assertion failure in notes. Expected examples:

- `captures a fresh candidate from the thread/start response and forwards the response` fails because `thread/start` response was no longer parsed.
- `emits turn/completed notifications` fails because notifications were no longer parsed.
- `acks duplicate turn/interrupt after the turn already completed` fails because completed-turn bookkeeping was no longer updated.

Also run the nested-id regression directly after implementing bounded envelope inspection:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts --testNamePattern "does not treat nested response body ids"
```

Expected: PASS. If it fails, the bounded envelope inspector is probably matching nested payload fields rather than only top-level JSON-RPC fields.

- [ ] **Step 3: Write minimal implementation**

Fix `handleUpstreamMessage` and helpers so small `thread/start` responses and small notifications still call the existing parsing and event-emission functions. The intended behavior is:

```ts
if (method === 'thread/start') {
  this.maybeEmitThreadStartResponseCandidate(parseJsonIfSmall(raw, isBinary))
}

// For notifications only:
this.handleUpstreamNotification(parseJsonIfSmall(raw, isBinary))
```

Do not parse non-`thread/start` responses. Do not add special parsing for `thread/fork` responses.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts --testNamePattern "captures a fresh candidate|captures a candidate|emits turn/completed|acks duplicate|does not treat nested response body ids"
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Run the full remote proxy unit file:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts
```

Expected: PASS. Confirm the new fork tests pass alongside the existing candidate, lifecycle, and interrupt tests.

- [ ] **Step 6: Commit**

If this task required additional code or test edits beyond Tasks 1 and 2, commit them:

```bash
git add server/coding-cli/codex-app-server/remote-proxy.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts
git commit -m "test: preserve codex proxy event handling"
```

If no additional edits were needed, do not create an empty commit.

### Task 4: Run Required Verification And Final Commit Hygiene

**Files:**
- Modify: none expected beyond prior tasks
- Test: repository verification commands

- [ ] **Step 1: Inspect coordinated test status before broad runs**

Run:

```bash
npm run test:status
```

Expected: either no active broad-run holder, or a holder that can be waited on. Do not kill another agent's run.

- [ ] **Step 2: Run focused server checks**

Run:

```bash
npm run typecheck:server
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts --config vitest.server.config.ts
```

Expected: PASS.

- [ ] **Step 3: Run full repo-required check**

Run:

```bash
FRESHELL_TEST_SUMMARY="codex fork oom proxy fix" npm run check
```

Expected: PASS. If the coordinated gate is held, wait rather than killing the holder. If there is an advisory reusable baseline that the coordinator explicitly offers and it covers the unchanged areas, follow the repository's coordinator guidance; otherwise wait and run the check.

- [ ] **Step 4: Optional real-provider smoke only if already configured**

If the environment has real Codex provider contracts configured, run:

```bash
FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- run test/integration/real/codex-app-server-readiness-contract.test.ts --config vitest.server.config.ts
```

Expected: PASS or SKIP for environment-gated reasons. Do not block completion solely because the real Codex binary, credentials, or opt-in environment are unavailable.

- [ ] **Step 5: Review diff for accidental scope creep**

Run:

```bash
git diff -- server/coding-cli/codex-app-server/remote-proxy.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts
git status --short
```

Expected:

- Only `remote-proxy.ts` and `remote-proxy.test.ts` changed for implementation.
- No docs UI mock changes.
- No unrelated files modified.
- No generated logs, PID files, or local artifacts staged.

- [ ] **Step 6: Final commit if needed**

If Task 4 produced final cleanup edits, commit them:

```bash
git add server/coding-cli/codex-app-server/remote-proxy.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts
git commit -m "fix: harden codex fork proxy forwarding"
```

If all implementation edits were already committed in prior tasks, do not create an empty commit.

## Acceptance Criteria

- Terminal Codex `/fork` still receives a normal JSON-RPC response and can continue from the forked thread.
- Every terminal Codex `thread/fork` request sent through Freshell includes `excludeTurns: true` upstream.
- A large `thread/fork` response is forwarded to the client without proxy-side full `JSON.parse`.
- Existing candidate capture and notification behavior remains intact.
- Focused remote-proxy tests pass.
- `npm run typecheck:server` passes.
- `npm run check` passes or is blocked only by a clearly documented pre-existing/shared-run issue.

## Risks And Mitigations

- **Risk:** Bounded envelope inspection misses an unusual response where `id` appears after a large `result`.
  - **Mitigation:** Forward the response anyway. The only lost proxy behavior is pending-method cleanup/log method attribution for that unusual frame. Use a generous 64 KiB prefix because app-server JSON-RPC responses normally put `id` at the top.

- **Risk:** Sending raw `Buffer` data changes a text frame into a binary frame.
  - **Mitigation:** Use explicit `socket.send(frame.data, { binary: frame.isBinary })` and assert `isBinary === false` in tests.

- **Risk:** The Codex TUI expected full turns in the immediate fork response.
  - **Mitigation:** This is the deliberate trade-off approved for memory safety. Fresh-agent Codex already uses the same `excludeTurns: true` contract. If a manual terminal run later exposes missing history, fix the TUI flow to fetch turns separately rather than reintroducing giant fork responses.

- **Risk:** The `JSON.parse` spy test becomes brittle if test helpers parse the received response.
  - **Mitigation:** Use a raw message helper for that test and assert the spy before any test-side parse. Keep normal parsing helpers in other tests.
