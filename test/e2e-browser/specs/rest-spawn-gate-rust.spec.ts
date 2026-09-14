/**
 * Kata enn3 (REST spawn gate): a 16-burst of REST pane creates against a
 * REAL freshell-server must be concurrency-bounded by the SHARED spawn gate
 * (FRESHELL_SPAWN_GATE_CONCURRENCY=1 makes queueing deterministic), every
 * pane must still be created (FIFO drain, nothing dropped), and the server
 * must stay responsive to a concurrent WS client throughout. Owns its
 * RustServer (ephemeral port — NEVER the user's live 3001/3002). Helpers
 * copied per per-spec-ownership. RUST_LOG=info is mandatory: the bounded-
 * concurrency evidence is the spawn_gate_queued INFO event in the server log.
 *
 * API+WS only — no browser page, so none of the storm spec's settings/picker
 * gotchas apply (and plain @playwright/test keeps the worker from booting the
 * fixtures.ts default server this spec never uses).
 */
import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import WebSocket from 'ws'
import { RustServer } from '../helpers/rust-server.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-version.js'

const BURST_SIZE = 16

test.setTimeout(300_000)

type Frame = Record<string, unknown> & { type: string }

type CreatedTerminalTab = {
  tabId: string
  paneId: string
  terminalId: string
}

function requireCreatedTerminalTab(body: unknown, requestIndex: number): CreatedTerminalTab {
  const data = (body as { data?: unknown } | null)?.data as Partial<CreatedTerminalTab> | undefined
  if (
    typeof data?.tabId !== 'string'
    || typeof data.paneId !== 'string'
    || typeof data.terminalId !== 'string'
  ) {
    throw new Error(`POST /api/tabs burst request ${requestIndex} returned an unrecognized create envelope: ${JSON.stringify(body)}`)
  }
  return { tabId: data.tabId, paneId: data.paneId, terminalId: data.terminalId }
}

/** Raw synthetic client (copied per per-spec-ownership from
 *  create-protection-isolation-rust.spec.ts; itself copied from
 *  reconcile-handshake-rust.spec.ts — connect/send/waitFor/close only). */
class SyntheticClient {
  private ws: WebSocket
  private frames: Frame[] = []
  private waiters: Array<{ match: (f: Frame) => boolean; resolve: (f: Frame) => void }> = []

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.on('message', (data) => {
      let frame: Frame
      try {
        frame = JSON.parse(String(data)) as Frame
      } catch {
        return
      }
      this.frames.push(frame)
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        if (this.waiters[i].match(frame)) {
          const [waiter] = this.waiters.splice(i, 1)
          waiter.resolve(frame)
        }
      }
    })
  }

  static async connect(info: E2eServerInfo): Promise<SyntheticClient> {
    const ws = new WebSocket(info.wsUrl)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    const client = new SyntheticClient(ws)
    client.send({
      type: 'hello',
      protocolVersion: WS_PROTOCOL_VERSION,
      token: info.token,
    })
    await client.waitFor((f) => f.type === 'ready')
    return client
  }

  send(frame: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(frame))
  }

  waitFor(match: (f: Frame) => boolean, timeoutMs = 15_000): Promise<Frame> {
    const seen = this.frames.find(match)
    if (seen) return Promise.resolve(seen)
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for frame (have: ${this.frames.map((f) => f.type).join(', ')})`)),
        timeoutMs,
      )
      this.waiters.push({
        match,
        resolve: (f) => {
          clearTimeout(timer)
          resolve(f)
        },
      })
    })
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      /* already closed */
    }
  }
}

/** Concatenate every file in the server's log dir (donor pattern:
 *  create-protection-restore-storm-rust.spec.ts:62-69). Reads ALL files, not
 *  just `*.jsonl`: the active file is `rust-server.jsonl` but rotated backups
 *  are suffixed `.1`/`.2` (crates/freshell-server/src/logging.rs), and the
 *  evidence line must not be missable to rotation. */
async function readServerLogs(logsDir: string): Promise<string> {
  const files = await fs.readdir(logsDir).catch(() => [] as string[])
  let combined = ''
  for (const f of files) {
    combined += await fs.readFile(path.join(logsDir, f), 'utf8').catch(() => '')
  }
  return combined
}

test('REST create burst is gate-bounded, drains fully, and WS stays responsive', async () => {
  const server = new RustServer({
    // FRESHELL_SPAWN_GATE_TIMEOUT_MS=60000: de-flake, not behavior change —
    // 16 serialized spawns must all acquire within the permit-wait; on a
    // loaded CI host the 10s default leaves little margin (load-bearing
    // check A7). Production defaults (Global Constraints) are untouched.
    // RUST_LOG=info: an inherited RUST_LOG=error would suppress the INFO
    // spawn_gate_queued evidence (the fixture spreads process.env) — pin it.
    env: {
      RUST_LOG: 'info',
      FRESHELL_SPAWN_GATE_CONCURRENCY: '1',
      FRESHELL_SPAWN_GATE_TIMEOUT_MS: '60000',
    },
  })
  const info = await server.start()
  try {
    // WS client connected BEFORE the burst.
    const ws = await SyntheticClient.connect(info)

    // 16 concurrent REST creates.
    const burst = Array.from({ length: BURST_SIZE }, () =>
      fetch(`${info.baseUrl}/api/tabs`, {
        method: 'POST',
        headers: {
          'x-auth-token': info.token,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ mode: 'shell', cwd: os.tmpdir() }),
      }),
    )

    // While the burst queues through the 1-permit gate, the server keeps
    // answering: health stays ok.
    const health = await fetch(`${info.baseUrl}/api/health`)
    expect(health.ok).toBe(true)

    const responses = await Promise.all(burst)
    const createdTabs: CreatedTerminalTab[] = []
    for (const [i, res] of responses.entries()) {
      expect(res.status, `POST /api/tabs burst request ${i}`).toBe(200)
      createdTabs.push(requireCreatedTerminalTab(await res.json(), i))
    }

    // Every response owns a distinct tab, pane, and terminal. The concurrent
    // order is intentionally unspecified, but a 200 create must never lose
    // or alias another burst member.
    expect(new Set(createdTabs.map(({ tabId }) => tabId)).size).toBe(BURST_SIZE)
    expect(new Set(createdTabs.map(({ paneId }) => paneId)).size).toBe(BURST_SIZE)
    expect(new Set(createdTabs.map(({ terminalId }) => terminalId)).size).toBe(BURST_SIZE)

    // The unqualified endpoint intentionally lists only the active tab's
    // leaves. A burst creates sixteen one-pane tabs, so verify that one
    // active row here and interrogate every tab explicitly below.
    const panesRes = await fetch(`${info.baseUrl}/api/panes`, {
      headers: { 'x-auth-token': info.token },
    })
    expect(panesRes.status).toBe(200)
    const panesBody = (await panesRes.json()) as { status?: string; data?: { panes?: unknown } }
    const panes = panesBody?.data?.panes
    if (!Array.isArray(panes)) {
      throw new Error(
        `Unrecognized GET /api/panes envelope (expected {status,data:{panes:[...]}}): ${
          JSON.stringify(panesBody).slice(0, 500)}`,
      )
    }
    expect(panes).toHaveLength(1)

    const tabsRes = await fetch(`${info.baseUrl}/api/tabs`, {
      headers: { 'x-auth-token': info.token },
    })
    expect(tabsRes.status).toBe(200)
    const tabsBody = await tabsRes.json() as {
      data?: { tabs?: Array<{ id?: unknown }>; activeTabId?: unknown }
    }
    const tabs = tabsBody.data?.tabs
    const activeTabId = tabsBody.data?.activeTabId
    if (!Array.isArray(tabs) || typeof activeTabId !== 'string') {
      throw new Error(`Unrecognized GET /api/tabs envelope: ${JSON.stringify(tabsBody).slice(0, 500)}`)
    }
    expect(tabs).toHaveLength(BURST_SIZE)
    expect(new Set(tabs.map((tab) => tab.id)).size).toBe(BURST_SIZE)
    expect(new Set(tabs.map((tab) => tab.id))).toEqual(new Set(createdTabs.map(({ tabId }) => tabId)))
    expect(createdTabs.some(({ tabId }) => tabId === activeTabId)).toBe(true)

    const activeCreatedTab = createdTabs.find(({ tabId }) => tabId === activeTabId)
    expect(activeCreatedTab).toBeDefined()
    expect(panes[0]).toMatchObject({
      id: activeCreatedTab!.paneId,
      terminalId: activeCreatedTab!.terminalId,
    })

    const snapshotRes = await fetch(`${info.baseUrl}/api/layout/snapshot`, {
      headers: { 'x-auth-token': info.token },
    })
    expect(snapshotRes.status).toBe(200)
    const snapshotBody = await snapshotRes.json() as {
      data?: { tabs?: Array<{ id?: unknown }>; layouts?: Record<string, unknown> }
    }
    const snapshotTabs = snapshotBody.data?.tabs
    const layouts = snapshotBody.data?.layouts
    if (!Array.isArray(snapshotTabs) || !layouts || typeof layouts !== 'object') {
      throw new Error(`Unrecognized GET /api/layout/snapshot envelope: ${JSON.stringify(snapshotBody).slice(0, 500)}`)
    }
    expect(snapshotTabs).toHaveLength(BURST_SIZE)
    expect(new Set(snapshotTabs.map((tab) => tab.id))).toEqual(new Set(createdTabs.map(({ tabId }) => tabId)))
    expect(Object.keys(layouts)).toHaveLength(BURST_SIZE)
    expect(new Set(Object.keys(layouts))).toEqual(new Set(createdTabs.map(({ tabId }) => tabId)))

    for (const created of createdTabs) {
      const perTabPanesRes = await fetch(`${info.baseUrl}/api/panes?tabId=${encodeURIComponent(created.tabId)}`, {
        headers: { 'x-auth-token': info.token },
      })
      expect(perTabPanesRes.status, `GET /api/panes for ${created.tabId}`).toBe(200)
      const perTabPanesBody = await perTabPanesRes.json() as { data?: { panes?: unknown } }
      const perTabPanes = perTabPanesBody.data?.panes
      if (!Array.isArray(perTabPanes)) {
        throw new Error(`Unrecognized GET /api/panes?tabId envelope: ${JSON.stringify(perTabPanesBody).slice(0, 500)}`)
      }
      expect(perTabPanes, `one leaf for ${created.tabId}`).toEqual([
        expect.objectContaining({ id: created.paneId, terminalId: created.terminalId }),
      ])
    }

    // Bounded concurrency observed: the burst QUEUED through the gate
    // (non-vacuous: with concurrency 1 and 16 near-simultaneous creates,
    // queueing is guaranteed).
    expect(await readServerLogs(info.logsDir)).toContain('spawn_gate_queued')

    // WS door still works after the REST burst (shared budget drained).
    // Message shape matches the sibling isolation spec's storm creates.
    ws.send({
      type: 'terminal.create',
      requestId: 'ws-after-burst',
      mode: 'shell',
      shell: 'system',
      cwd: os.tmpdir(),
    })
    const created = await ws.waitFor(
      (f) =>
        (f.type === 'terminal.created' || f.type === 'error') &&
        f.requestId === 'ws-after-burst',
      60_000,
    )
    expect(created.type, `WS create after burst: ${JSON.stringify(created).slice(0, 300)}`)
      .toBe('terminal.created')
    ws.close()
  } finally {
    await server.stop().catch(() => {})
  }
})
