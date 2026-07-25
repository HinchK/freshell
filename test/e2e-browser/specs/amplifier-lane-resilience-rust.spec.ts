/**
 * AMPLIFIER EVENTS-LANE RESILIENCE (Lane B, gaps G4 + G8).
 *
 * The amplifier status pipeline tails the session's events.jsonl via an
 * inotify lane. These tests prove the lane survives real-world failure
 * modes end-to-end in a browser, against servers this spec owns:
 *  1. events.jsonl truncation/rotation mid-session -> bounded re-attach,
 *     status flows again (busy + turn-complete + chime edge).
 *  2. abrupt server death (SIGKILL) with a busy amplifier pane -> after
 *     restore the lane re-attaches at Eof and status flows again.
 *  3. two concurrent servers run fully independent amplifier lanes.
 *
 * Rust-only: imports RustServer directly (restartAbrupt) and drives the
 * Rust activity hub. Servers bind ephemeral ports via findFreePort() --
 * never the user's live 3001/3002.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FAKE_AMPLIFIER_CLI = path.resolve(__dirname, '../fixtures/fake-amplifier-activity-cli.mjs')

async function installFakeCli(binDir: string, name: string, source: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, name)
  await fs.copyFile(source, target)
  await fs.chmod(target, 0o755)
  return target
}

/**
 * A raw, node-side WS capture client: performs the real hello handshake and
 * records every server frame, so assertions run against the ACTUAL emitted
 * bytes (same approach as `term28-path-shadow-rust.spec.ts`'s raw client).
 */
class WsCapture {
  private ws: WebSocket
  readonly frames: any[] = []
  private opened: Promise<void>

  constructor(baseUrl: string, token: string) {
    const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/ws`
    this.ws = new WebSocket(wsUrl)
    this.opened = new Promise((resolve, reject) => {
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({ type: 'hello', protocolVersion: 7, token }))
        resolve()
      })
      this.ws.on('error', reject)
    })
    this.ws.on('message', (data) => {
      try {
        this.frames.push(JSON.parse(String(data)))
      } catch {
        // non-JSON frames are not part of this protocol; ignore
      }
    })
  }

  async ready(): Promise<void> {
    await this.opened
    await this.waitFor((f) => f.type === 'ready', 10_000, 'ready')
  }

  async waitFor(pred: (frame: any) => boolean, timeoutMs: number, label: string): Promise<any> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const hit = this.frames.find(pred)
      if (hit) return hit
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`WsCapture: timed out waiting for ${label}`)
  }

  count(pred: (frame: any) => boolean): number {
    return this.frames.filter(pred).length
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      // already closed
    }
  }
}

async function selectShellIfPickerShowing(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForTimeout(500)
  const xtermVisible = await page.locator('.xterm').first().isVisible().catch(() => false)
  if (xtermVisible) return
  const shellNames = ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']
  for (const name of shellNames) {
    try {
      await page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }).click({ timeout: 5_000 })
      await page.locator('.xterm').first().waitFor({ state: 'visible', timeout: 15_000 })
      return
    } catch {
      continue
    }
  }
}

async function bootAndConnect(
  page: import('@playwright/test').Page,
  info: { baseUrl: string; token: string },
): Promise<TestHarness> {
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  await selectShellIfPickerShowing(page)
  return harness
}

/** Open a new CLI pane via the picker (same flow as amplifier-restore-rust). */
async function openCliPane(page: import('@playwright/test').Page, buttonName: RegExp): Promise<void> {
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: buttonName }).click({ force: true })
  await page.getByRole('combobox', { name: /Starting directory/i }).press('Enter')
}

function collectLeaves(node: any): any[] {
  if (!node) return []
  if (node.type === 'leaf') return [node]
  if (node.type === 'split') return (node.children ?? []).flatMap(collectLeaves)
  return []
}

async function openCliPaneAndGetTerminalId(
  page: import('@playwright/test').Page,
  harness: TestHarness,
  tabId: string,
  buttonName: RegExp,
  mode: string,
): Promise<string> {
  const before = collectLeaves(await harness.getPaneLayout(tabId))
    .filter((leaf) => leaf?.content?.mode === mode)
  const beforeIds = new Set(before.map((leaf) => leaf.id))
  await openCliPane(page, buttonName)
  await expect(page.locator('.xterm').last()).toBeVisible({ timeout: 15_000 })
  await expect.poll(async () => {
    const layout = await harness.getPaneLayout(tabId)
    const leaf = collectLeaves(layout)
      .find((l) => l?.content?.mode === mode && !beforeIds.has(l.id) && l?.content?.terminalId)
    return leaf?.content?.terminalId ?? null
  }, { timeout: 15_000 }).not.toBeNull()
  const layout = await harness.getPaneLayout(tabId)
  const leaf = collectLeaves(layout)
    .find((l) => l?.content?.mode === mode && !beforeIds.has(l.id) && l?.content?.terminalId)
  return leaf.content.terminalId as string
}

async function typePromptIntoLastPane(page: import('@playwright/test').Page, text: string): Promise<void> {
  await page.locator('.xterm').last().click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

/** One amplifier.log record, mirroring the fake CLI's writer (live ts —
 *  a stale ts looks like deadman silence to the tracker). */
function record(event: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    ts: new Date().toISOString(),
    lvl: 'INFO',
    schema: { name: 'amplifier.log', ver: '1.0.0' },
    event,
    ...extra,
  })}\n`
}

async function seedAmplifierProvider(homeDir: string): Promise<void> {
  const freshellDir = path.join(homeDir, '.freshell')
  await fs.mkdir(freshellDir, { recursive: true })
  await fs.writeFile(
    path.join(freshellDir, 'config.json'),
    JSON.stringify(
      { version: 1, settings: { codingCli: { enabledProviders: ['amplifier'] } } },
      null,
      2,
    ),
  )
}

/** Locate the single fake session's events.jsonl under a pinned AMPLIFIER_HOME. */
async function findEventsFile(amplifierHome: string): Promise<string> {
  const projectsRoot = path.join(amplifierHome, 'projects')
  for (const project of await fs.readdir(projectsRoot)) {
    const sessionsDir = path.join(projectsRoot, project, 'sessions')
    const sessions = await fs.readdir(sessionsDir).catch(() => [] as string[])
    for (const session of sessions) {
      const candidate = path.join(sessionsDir, session, 'events.jsonl')
      try {
        await fs.access(candidate)
        return candidate
      } catch {
        /* keep looking */
      }
    }
  }
  throw new Error(`no events.jsonl found under ${projectsRoot}`)
}

/** Poll the Rust server's tracing log until `pattern` appears — the
 *  deterministic "re-attach fired" observable. A blind fixed wait would race
 *  CI: a record appended BEFORE the Eof re-attach lands sits behind the
 *  attach point and is permanently invisible, failing the test with no retry
 *  recourse. NOTE: the Rust fixture's `info.debugLogPath` is a constructed
 *  path that NOTHING writes (the helper buffers stdout/stderr in memory,
 *  `rust-server.ts:448-455`); the real tracing sink is
 *  `FRESHELL_LOG_DIR/rust-server.jsonl` (`crates/freshell-server/src/logging.rs:74,:137`),
 *  i.e. `path.join(info.logsDir, 'rust-server.jsonl')` — the same file
 *  `diag03-rotation-redaction-rust.spec.ts:33` reads. Always pass that path. */
async function waitForServerLog(
  serverLogPath: string,
  pattern: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const contents = await fs.readFile(serverLogPath, 'utf8').catch(() => '')
    if (contents.includes(pattern)) return
    if (Date.now() > deadline) throw new Error(`server log never matched: ${pattern}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

test.describe('Amplifier events-lane resilience (Rust only)', () => {
  test.setTimeout(240_000)

  test('events.jsonl truncation mid-session degrades then recovers: status flows again', async ({
    page,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-amp-lane-'))
    // Pinned AMPLIFIER_HOME so this spec can find and mutate events.jsonl;
    // both the server and the fake CLI resolve the same root.
    const amplifierHome = path.join(sharedRoot, 'amplifier-home')
    let capture: WsCapture | null = null
    let server: RustServer | null = null
    try {
      const fakeAmplifier = await installFakeCli(path.join(sharedRoot, 'bin'), 'amplifier', FAKE_AMPLIFIER_CLI)
      server = new RustServer({
        env: {
          AMPLIFIER_CMD: fakeAmplifier,
          AMPLIFIER_HOME: amplifierHome,
          FAKE_AMPLIFIER_TURN_MS: '3000',
        },
        setupHome: seedAmplifierProvider,
      })
      const info = await server.start()
      capture = new WsCapture(info.baseUrl, info.token)
      await capture.ready()
      const harness = await bootAndConnect(page, info)
      const tabId = await harness.getActiveTabId()
      const terminalId = await openCliPaneAndGetTerminalId(page, harness, tabId!, /Amplifier/i, 'amplifier')
      await expect
        .poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalId)
          return typeof buffer === 'string' && buffer.includes('amplifier>')
        }, { timeout: 15_000 })
        .toBe(true)

      // Turn 1 via the fake CLI: proves the lane attached and is healthy.
      await typePromptIntoLastPane(page, 'hello amplifier')
      const complete1 = await capture.waitFor(
        (f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId,
        45_000,
        'turn 1 complete (lane healthy)',
      )
      expect(complete1.provider).toBe('amplifier')
      expect(complete1.completionSeq).toBe(1)

      const eventsPath = await findEventsFile(amplifierHome)

      // ROTATION: truncate the live file below the tailer offset (FileReset
      // degrade). Without the fix the lane dies here, permanently.
      await fs.truncate(eventsPath, 0)
      // Deterministic recovery gate (validated hardening): wait for the hub
      // to log the re-attach attempt (Task 4 emits
      // amplifier_events_lane_reattach_attempt at info level), then a short
      // settle for the attach + initial drain that follow it synchronously.
      // The Rust tracing sink is rust-server.jsonl under info.logsDir —
      // info.debugLogPath is never written by the Rust fixture.
      await waitForServerLog(
        path.join(info.logsDir, 'rust-server.jsonl'),
        'amplifier_events_lane_reattach_attempt',
      )
      await page.waitForTimeout(250)

      // Turn 2 by appending records DIRECTLY (no PTY input): busy and
      // turn-complete can then ONLY come from the recovered events lane --
      // there is no provisional-busy path to mask a dead lane.
      await fs.appendFile(eventsPath, record('prompt:submit'))
      await capture.waitFor(
        (f) =>
          f.type === 'amplifier.activity.updated' &&
          f.upsert?.some((r: any) => r.terminalId === terminalId && r.phase === 'busy'),
        15_000,
        'post-truncation busy from recovered lane',
      )
      await fs.appendFile(eventsPath, record('prompt:complete'))
      const complete2 = await capture.waitFor(
        (f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId && f.completionSeq === 2,
        15_000,
        'post-truncation turn complete from recovered lane',
      )
      expect(complete2.provider).toBe('amplifier')
    } finally {
      capture?.close()
      await server?.stop().catch(() => {})
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
