import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { test, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle, type E2eServerHandle } from '../helpers/external-target.js'
import { TestHarness } from '../helpers/test-harness.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js'

/**
 * AUTO-TITLE PIPELINE (Task 21, rust-only) -- e2e proof of the Rust server's
 * background auto-name sweep (`crates/freshell-server/src/auto_title_sweep.rs`,
 * 2s tick: dir -> first-message -> Gemini AI ladder), the
 * `POST /api/sessions/:id/generate-title` route (`sessions.rs`), and the
 * `POST /api/ai/terminals/:id/summary` route (`ai_router.rs`). The
 * user-rename test also carries SESSION-04's stable-cold-restart clause:
 * the persisted ladder winner must survive a full `RustServer.restart()`.
 *
 * NO LIVE GEMINI CALLS, EVER: every AI branch in this file talks to a local
 * fake Gemini (plain `node:http` on 127.0.0.1:0) via the Rust-only
 * `FRESHELL_GEMINI_BASE_URL` seam (`main.rs:258-267`, Task 2). The seam is a
 * documented Rust-only superset (validator-A1); this spec is therefore
 * registered rust-only in `playwright.config.ts`.
 *
 * PER-TEST OWNED SERVERS (sidebar-click-resume.spec.ts precedent): the
 * process-local Gemini key cell is a ONE-WAY ratchet -- "blank never clears"
 * (`AiKeyCell::apply_settings_key_forced`, `ai_title.rs:99-104`) -- so a
 * no-key assertion can never run after ANY test seeded a key on a shared
 * worker server. Each test boots its own `RustServer` (isolated HOME,
 * ephemeral port) with exactly the key/env state it needs, which also makes
 * every test self-contained under `fullyParallel`.
 *
 * Every server is booted with `GOOGLE_GENERATIVE_AI_API_KEY: ''` so a key in
 * the host environment can never leak in (the fixture spreads `process.env`;
 * `main.rs:252-255` filters empty values back to "no key").
 */

const GEMINI_GENERATE_PATH = '/v1beta/models/gemini-3.5-flash-lite:generateContent'
const FAKE_GEMINI_KEY = 'e2e-task21-fake-gemini-key'

interface FakeGeminiRequest {
  method: string
  url: string
  apiKey: string | undefined
  body: string
}

interface FakeGemini {
  baseUrl: string
  requests: FakeGeminiRequest[]
  close: () => Promise<void>
}

/**
 * A local fake Gemini: answers
 * `POST /v1beta/models/gemini-3.5-flash-lite:generateContent` with a fixed
 * candidates payload and records every request's `x-goog-api-key` header so
 * tests can assert the seeded settings key actually arrived on the wire.
 */
interface FakeGemini {
  baseUrl: string
  requests: FakeGeminiRequest[]
  close: () => Promise<void>
  /** Hold every generateContent response until released (the in-request race pin). */
  holdResponses?: () => void
  releaseResponses?: () => void
}

/**
 * A local fake Gemini: answers
 * `POST /v1beta/models/gemini-3.5-flash-lite:generateContent` with a fixed
 * candidates payload and records every request's `x-goog-api-key` header so
 * tests can assert the seeded settings key actually arrived on the wire.
 * `opts.hold` parks each response until `releaseResponses()` — the
 * manual-wins-during-request pin.
 */
async function startFakeGemini(replyText: string, opts?: { hold?: boolean }): Promise<FakeGemini> {
  const requests: FakeGeminiRequest[] = []
  let held = opts?.hold === true
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        apiKey: typeof req.headers['x-goog-api-key'] === 'string' ? req.headers['x-goog-api-key'] : undefined,
        body,
      })
      if (req.method === 'POST' && req.url === GEMINI_GENERATE_PATH) {
        const answer = () => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            candidates: [{ content: { parts: [{ text: replyText }] } }],
          }))
        }
        if (held) {
          const timer = setInterval(() => {
            if (!held) {
              clearInterval(timer)
              answer()
            }
          }, 20)
        } else {
          answer()
        }
      } else {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{}')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}/v1beta`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    holdResponses: () => { held = true },
    releaseResponses: () => { held = false },
  }
}

/**
 * A minimal real-reader claude session JSONL: system/init + TWO user/assistant
 * turn pairs, NO `type:'summary'` record. Two user turns are load-bearing: a
 * single-user-message session is flagged `isNonInteractive`
 * (`parse/claude.rs:484-488`) and HIDDEN from the session directory by
 * default (`session_directory.rs:1086`), so it would never appear in the
 * sidebar at all. A summary record would mark the parsed title
 * `provider-generated` (`parse/claude.rs:521-526`), which blocks both the
 * sweep's AI branch and the generate-title route by design -- so none is
 * written. The FIRST user record is what `first_user_message` extracts.
 */
function buildClaudeSessionJsonl(input: {
  sessionId: string
  cwd: string
  firstMessage: string
  /** A `type:'summary'` record marks the parsed title provider-generated. */
  summary?: string
}): string {
  const lines: string[] = [
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: input.sessionId,
      uuid: `${input.sessionId}-system`,
      timestamp: '2026-08-08T08:00:00.000Z',
      cwd: input.cwd,
      git: { branch: 'main', dirty: false },
    }),
  ]
  let previousUuid = `${input.sessionId}-system`
  const userMessages = [input.firstMessage, 'Any progress on that request?']
  for (const [turnIndex, userMessage] of userMessages.entries()) {
    const userUuid = `${input.sessionId}-user-${turnIndex + 1}`
    const assistantUuid = `${input.sessionId}-assistant-${turnIndex + 1}`
    lines.push(JSON.stringify({
      parentUuid: previousUuid,
      cwd: input.cwd,
      sessionId: input.sessionId,
      version: '2.1.23',
      gitBranch: 'main',
      type: 'user',
      message: { role: 'user', content: userMessage },
      uuid: userUuid,
      timestamp: `2026-08-08T08:0${turnIndex}:01.000Z`,
    }))
    lines.push(JSON.stringify({
      parentUuid: userUuid,
      cwd: input.cwd,
      sessionId: input.sessionId,
      version: '2.1.23',
      gitBranch: 'main',
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-6-20260301',
        content: [{ type: 'text', text: `Working on it (${turnIndex + 1}).` }],
        usage: {
          input_tokens: 100,
          output_tokens: 40,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
      uuid: assistantUuid,
      timestamp: `2026-08-08T08:0${turnIndex}:02.000Z`,
    }))
    previousUuid = assistantUuid
  }
  if (input.summary !== undefined) {
    lines.push(JSON.stringify({
      type: 'summary',
      summary: input.summary,
      sessionId: input.sessionId,
      uuid: `${input.sessionId}-summary`,
    }))
  }
  return `${lines.join('\n')}\n`
}

/**
 * `installFakeClaudeCli` pattern): prints text then stays alive like the real
 * interactive TUI, so the resumed pane's terminal stays `running` for the
 * sweep's live-terminal match. Installed via the `CLAUDE_CMD` env override.
 */
async function installFakeClaudeCli(destDir: string): Promise<string> {
  await fs.mkdir(destDir, { recursive: true })
  const dest = path.join(destDir, 'fake-claude-cli.mjs')
  const script = `#!/usr/bin/env node
process.stdout.write('auto-title-rust fake claude resumed\\r\\n')
process.stdin.resume()
`
  await fs.writeFile(dest, script, 'utf8')
  await fs.chmod(dest, 0o755)
  return dest
}

interface SeededSession {
  sessionId: string
  firstMessage: string
  /** Basename of the per-home project dir (the sweep's `dir` placeholder). */
  projectDirName: string
  /** Optional provider summary record (provider-generated parsed title). */
  summary?: string
}

interface BootedServer {
  server: E2eServerHandle
  info: E2eServerInfo
  root: string
}

/**
 * Boot an owned Rust server with an isolated HOME, the fake claude CLI on
 * `CLAUDE_CMD`, an optional seeded claude session, and any extra env (e.g.
 * `FRESHELL_GEMINI_BASE_URL`). `GOOGLE_GENERATIVE_AI_API_KEY` is always
 * force-blanked so the host environment can never enable AI by accident.
 */
async function bootAutoTitleServer(opts: {
  session?: SeededSession
  env?: Record<string, string>
}): Promise<BootedServer> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-auto-title-'))
  const fakeClaudePath = await installFakeClaudeCli(path.join(root, 'bin'))
  const server = await createE2eServerHandle(process.env, {
    construct: {
      env: {
        CLAUDE_CMD: fakeClaudePath,
        GOOGLE_GENERATIVE_AI_API_KEY: '',
        ...opts.env,
      },
      setupHome: async (homeDir) => {
        const freshellDir = path.join(homeDir, '.freshell')
        await fs.mkdir(freshellDir, { recursive: true })
        // Seed config.json ONCE: `RustServer.restart()` re-runs `setupHome`
        // on the same home (rust-server.ts `boot()`), so an unconditional
        // wholesale write here would CLOBBER config state a test built up
        // before the restart (e.g. the persisted user rename the
        // stable-cold-restart clause asserts survives). Same trap
        // settings-split-rust.spec.ts:32 documents.
        const configPath = path.join(freshellDir, 'config.json')
        const configExists = await fs.access(configPath).then(() => true, () => false)
        if (!configExists) {
          await fs.writeFile(configPath, JSON.stringify({
            version: 1,
            settings: {
              codingCli: { enabledProviders: ['claude'] },
            },
          }, null, 2))
        }
        if (opts.session) {
          // The session's cwd is a REAL directory under the isolated home so
          // the resumed PTY's spawn cwd exists.
          const projectDir = path.join(homeDir, 'projects', opts.session.projectDirName)
          await fs.mkdir(projectDir, { recursive: true })
          const sessionDir = path.join(homeDir, '.claude', 'projects', 'auto-title-project')
          await fs.mkdir(sessionDir, { recursive: true })
          await fs.writeFile(
            path.join(sessionDir, `${opts.session.sessionId}.jsonl`),
            buildClaudeSessionJsonl({
              sessionId: opts.session.sessionId,
              cwd: projectDir,
              firstMessage: opts.session.firstMessage,
              summary: opts.session.summary,
            }),
          )
        }
      },
    },
  })
  const info = await server.start()
  return { server, info, root }
}

async function cleanup(booted: BootedServer, fake?: FakeGemini): Promise<void> {
  await booted.server.stop().catch(() => {})
  if (fake) await fake.close().catch(() => {})
  await fs.rm(booted.root, { recursive: true, force: true }).catch(() => {})
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

/**
 * Resume the seeded session with a deliberate sidebar CLICK. The WS
 * terminal.create path this drives is what registers the terminal's session
 * identity (`crates/freshell-ws/src/terminal.rs:1313`, `identity.upsert`) --
 * the live-terminal match the sweep's `find_all_by_session` needs.
 */
async function resumeSeededSession(
  page: import('@playwright/test').Page,
  harness: TestHarness,
  sessionId: string,
): Promise<{ tabId: string; terminalId: string }> {
  await expect(page.getByTestId('sidebar-session-list')).toBeVisible({ timeout: 15_000 })
  const row = page.locator(`[data-context="sidebar-session"][data-session-id="${sessionId}"]`)
  await expect(row).toBeVisible({ timeout: 15_000 })

  const tabCountBefore = await harness.getTabCount()
  await row.click()
  await expect(async () => {
    expect(await harness.getTabCount()).toBe(tabCountBefore + 1)
  }).toPass({ timeout: 15_000 })

  const tabId = (await harness.getActiveTabId())!
  expect(tabId).toBeTruthy()
  await expect.poll(async () => {
    return (await harness.getPaneLayout(tabId))?.content?.terminalId ?? null
  }, { timeout: 20_000 }).not.toBeNull()
  const terminalId = (await harness.getPaneLayout(tabId))?.content?.terminalId as string
  return { tabId, terminalId }
}

/** The directory read model's title for `claude:<sessionId>` (or null).
 * Unified agent names (Task 4): the naming record's current name rides the
 * additive `sessionName` field (the sidebar's authoritative surface); the
 * legacy `title` stays the pre-naming parsed value for non-manual records. */
async function directoryTitle(
  page: import('@playwright/test').Page,
  info: { baseUrl: string; token: string },
  sessionId: string,
): Promise<string | null> {
  const res = await page.request.get(
    `${info.baseUrl}/api/session-directory?priority=visible&limit=50`,
    { headers: { 'x-auth-token': info.token } },
  )
  if (!res.ok()) return null
  const payload = await res.json() as {
    items: Array<{
      provider: string
      sessionId: string
      title?: string
      sessionName?: string
    }>
  }
  const item = payload.items.find((i) => i.provider === 'claude' && i.sessionId === sessionId)
  return item?.sessionName ?? item?.title ?? null
}

/** The persisted `config.sessionOverrides[key]` row from the isolated home. */
async function sessionOverride(
  homeDir: string,
  key: string,
): Promise<{ titleOverride?: string; titleSource?: string } | null> {
  try {
    const raw = await fs.readFile(path.join(homeDir, '.freshell', 'config.json'), 'utf8')
    const config = JSON.parse(raw) as { sessionOverrides?: Record<string, { titleOverride?: string; titleSource?: string }> }
    return config.sessionOverrides?.[key] ?? null
  } catch {
    return null
  }
}

async function patchSettings(
  page: import('@playwright/test').Page,
  info: { baseUrl: string; token: string },
  body: Record<string, unknown>,
): Promise<void> {
  const res = await page.request.patch(`${info.baseUrl}/api/settings`, {
    headers: { 'x-auth-token': info.token, 'content-type': 'application/json' },
    data: body,
  })
  expect(res.ok()).toBe(true)
}

test.describe('Auto-title pipeline (rust)', () => {
  test.setTimeout(120_000)

  test('background sweep auto-names a live session: dir placeholder then first-message', async ({ page }) => {
    const SESSION_ID = '00000000-0000-4000-8000-00000000a101'
    const FIRST_MESSAGE = 'Repair the flux capacitor'
    const booted = await bootAutoTitleServer({
      session: { sessionId: SESSION_ID, firstMessage: FIRST_MESSAGE, projectDirName: 'fluxrepair' },
    })
    try {
      const harness = await bootAndConnect(page, booted.info)
      await resumeSeededSession(page, harness, SESSION_ID)

      // The sweep (2s tick) must converge the directory title onto the
      // first-message heuristic: with NO AI key, `compute_auto_title_patch`
      // resolves first-message over the dir placeholder (`auto_title.rs:54-66`).
      await expect.poll(
        () => directoryTitle(page, booted.info, SESSION_ID),
        { timeout: 15_000 },
      ).toBe(FIRST_MESSAGE)

      // Unified agent names (Task 4): the naming authority owns the title —
      // the settings ladder NEVER acquires a competing scoped row.
      await expect.poll(
        async () => (await sessionOverride(booted.info.homeDir, `claude:${SESSION_ID}`)) ?? null,
        { timeout: 10_000 },
      ).toBe(null)

      // Sidebar row shows the title with ZERO further client action (the
      // sweep's sessions.changed drives the refetch).
      await expect(
        page.getByTestId('sidebar-session-list').getByText(FIRST_MESSAGE, { exact: false }),
      ).toBeVisible({ timeout: 10_000 })

      // The PANE header converged too (terminal.title.updated push). Same
      // pane-header element every pane renders (PaneHeader.tsx); the
      // active tab's header is the visible one.
      await expect(
        page.locator('[data-context="pane-header"]:visible').first(),
      ).toContainText('Repair the flux', { timeout: 10_000 })
    } finally {
      await cleanup(booted)
    }
  })

  test('Gemini finalizes as ai when key + autoGenerateTitles are on (fake Gemini)', async ({ page }) => {
    const SESSION_ID = '00000000-0000-4000-8000-00000000a202'
    const FIRST_MESSAGE = 'Repair the flux capacitor'
    const AI_TITLE = 'Flux capacitor repair'
    // The fake Gemini MUST exist before the server boots: the base URL is a
    // boot-time env read (`main.rs:261-264`), not a live setting.
    const fake = await startFakeGemini(AI_TITLE)
    const booted = await bootAutoTitleServer({
      session: { sessionId: SESSION_ID, firstMessage: FIRST_MESSAGE, projectDirName: 'fluxrepair' },
      env: { FRESHELL_GEMINI_BASE_URL: fake.baseUrl },
    })
    try {
      // Seed the key BEFORE the terminal exists: once a live terminal is
      // matched by a no-key pass, the first-message write is FINALIZED and
      // the AI branch never fires for this session (title-source ladder).
      await patchSettings(page, booted.info, { ai: { geminiApiKey: FAKE_GEMINI_KEY } })

      const harness = await bootAndConnect(page, booted.info)
      await resumeSeededSession(page, harness, SESSION_ID)

      // Key present + autoGenerateTitles default-on: the sweep holds the dir
      // placeholder ("fluxrepair") and fires ONE Gemini call, which
      // finalizes the title as `ai`.
      await expect.poll(
        () => directoryTitle(page, booted.info, SESSION_ID),
        { timeout: 15_000 },
      ).toBe(AI_TITLE)
      // The naming record's accepted Freshell AI name is the durable rung —
      // and no scoped settings row exists.
      await expect.poll(
        async () => (await sessionOverride(booted.info.homeDir, `claude:${SESSION_ID}`)) ?? null,
        { timeout: 10_000 },
      ).toBe(null)

      // The wire contract actually exercised the fake: the generateContent
      // POST arrived with the seeded settings key in x-goog-api-key.
      const generateRequests = fake.requests.filter((r) => r.url === GEMINI_GENERATE_PATH)
      expect(generateRequests.length).toBeGreaterThan(0)
      expect(generateRequests[0].apiKey).toBe(FAKE_GEMINI_KEY)
    } finally {
      await cleanup(booted, fake)
    }
  })

  test('user rename is never clobbered by the sweep', async ({ page }) => {
    const SESSION_ID = '00000000-0000-4000-8000-00000000a303'
    const FIRST_MESSAGE = 'Repair the flux capacitor'
    const booted = await bootAutoTitleServer({
      session: { sessionId: SESSION_ID, firstMessage: FIRST_MESSAGE, projectDirName: 'fluxrepair' },
    })
    try {
      const harness = await bootAndConnect(page, booted.info)
      await resumeSeededSession(page, harness, SESSION_ID)

      // Test-1-style naming first: the sweep converges onto first-message.
      await expect.poll(
        () => directoryTitle(page, booted.info, SESSION_ID),
        { timeout: 15_000 },
      ).toBe(FIRST_MESSAGE)

      // User rename through the real PATCH route (titleSource:'user', the
      const res = await page.request.patch(
        `${booted.info.baseUrl}/api/sessions/${encodeURIComponent(`claude:${SESSION_ID}`)}`,
        {
          headers: { 'x-auth-token': booted.info.token, 'content-type': 'application/json' },
          data: { titleOverride: 'MINE', nameIntent: 'user' },
        },
      )
      expect(res.ok()).toBe(true)

      // Three full sweep ticks (2s cadence): the live terminal is still
      // matched every pass, so a clobbering sweep would strike within 7s.
      await page.waitForTimeout(7_000)

      expect(await directoryTitle(page, booted.info, SESSION_ID)).toBe('MINE')
      const override = await sessionOverride(booted.info.homeDir, `claude:${SESSION_ID}`)
      expect(override).toBe(null)

      // SESSION-04 stable-cold-restart clause: the ladder's final winner must
      // survive a full server stop/start on the same home (`RustServer.
      // restart()`: same home/port/token, waits for health). The directory
      // read model must re-serve 'MINE' from the persisted override on the
      // cold boot, and a further >=2 sweep ticks on the fresh process (the
      // client auto-reconnects and may respawn the terminal, re-arming the
      // live-session match) must not clobber the finalized 'user' rung.
      if (!booted.server.restart) {
        throw new Error('rust E2eServerHandle does not implement restart()')
      }
      await booted.server.restart()
      await expect.poll(
        () => directoryTitle(page, booted.info, SESSION_ID),
        { timeout: 20_000 },
      ).toBe('MINE')
      await page.waitForTimeout(5_000)
      expect(await directoryTitle(page, booted.info, SESSION_ID)).toBe('MINE')
      const postRestart = await sessionOverride(booted.info.homeDir, `claude:${SESSION_ID}`)
      expect(postRestart).toBe(null)
    } finally {
      await cleanup(booted)
    }
  })

  test('scoped generate-title compatibility route answers the saved name and writes nothing', async ({ page }) => {
    const SESSION_ID = '00000000-0000-4000-8000-00000000a404'
    const AI_TITLE = 'Flux capacitor repair'
    const fake = await startFakeGemini(AI_TITLE)
    // Session seeded but NOT resumed: no live terminal, so the background
    // sweep never touches it -- this test isolates the REST route. The route
    // gates on key presence ONLY, never on `settings.sidebar.autoGenerateTitles`
    // (real Node asymmetry, Scope Decision 7, `sessions.rs:379-403`).
    const booted = await bootAutoTitleServer({
      session: { sessionId: SESSION_ID, firstMessage: 'Repair the flux capacitor', projectDirName: 'fluxrepair' },
      env: { FRESHELL_GEMINI_BASE_URL: fake.baseUrl },
    })
    try {
      await patchSettings(page, booted.info, { ai: { geminiApiKey: FAKE_GEMINI_KEY } })

      const res = await page.request.post(
        `${booted.info.baseUrl}/api/sessions/${encodeURIComponent(`claude:${SESSION_ID}`)}/generate-title`,
        {
          headers: { 'x-auth-token': booted.info.token, 'content-type': 'application/json' },
          data: { firstMessage: 'Repair the flux capacitor before the storm hits' },
        },
      )
      expect(res.ok()).toBe(true)
      // Unified agent names (Task 4): claude is SCOPED — the route is the
      // compatibility arm only. The boot hydration installed the free
      // first-message fallback record, so it answers the SAVED name (never
      // the request's own text) and writes nothing.
      expect(await res.json()).toEqual({
        title: 'Repair the flux capacitor',
        source: 'first-message',
      })
      expect(fake.requests.filter((r) => r.url === GEMINI_GENERATE_PATH)).toHaveLength(0)
      expect(await sessionOverride(booted.info.homeDir, `claude:${SESSION_ID}`)).toBe(null)
    } finally {
      await cleanup(booted, fake)
    }
  })

  test('terminal summary endpoint returns heuristic without key and ai with fake key', async ({ page }) => {
    const AI_SUMMARY = 'Fake Gemini terminal summary for task 21'
    const fake = await startFakeGemini(AI_SUMMARY)
    // Boots with NO key: the heuristic half must run first because the key
    // cell is a one-way ratchet (blank never clears).
    const booted = await bootAutoTitleServer({
      env: { FRESHELL_GEMINI_BASE_URL: fake.baseUrl },
    })
    try {
      const harness = await bootAndConnect(page, booted.info)

      // The fixture-selected shell tab IS the terminal under test.
      const tabId = (await harness.getActiveTabId())!
      await expect.poll(async () => {
        return (await harness.getPaneLayout(tabId))?.content?.terminalId ?? null
      }, { timeout: 20_000 }).not.toBeNull()
      const terminalId = (await harness.getPaneLayout(tabId))?.content?.terminalId as string

      // Wait for real prompt output so the heuristic has scrollback to chew on.
      await expect.poll(async () => {
        const buffer = await harness.getTerminalBuffer(terminalId)
        return typeof buffer === 'string' && buffer.trim().length > 0
      }, { timeout: 15_000 }).toBe(true)

      // (1) Without key: 200 {source:'heuristic', description non-empty}.
      const heuristicRes = await page.request.post(
        `${booted.info.baseUrl}/api/ai/terminals/${encodeURIComponent(terminalId)}/summary`,
        { headers: { 'x-auth-token': booted.info.token } },
      )
      expect(heuristicRes.ok()).toBe(true)
      const heuristicBody = await heuristicRes.json() as { source: string; description: string }
      expect(heuristicBody.source).toBe('heuristic')
      expect(heuristicBody.description.length).toBeGreaterThan(0)
      // The no-key branch never reaches the transport.
      expect(fake.requests.length).toBe(0)

      // (2) Seed the key; the same endpoint now rides the fake Gemini.
      await patchSettings(page, booted.info, { ai: { geminiApiKey: FAKE_GEMINI_KEY } })
      const aiRes = await page.request.post(
        `${booted.info.baseUrl}/api/ai/terminals/${encodeURIComponent(terminalId)}/summary`,
        { headers: { 'x-auth-token': booted.info.token } },
      )
      expect(aiRes.ok()).toBe(true)
      expect(await aiRes.json()).toEqual({ source: 'ai', description: AI_SUMMARY })
      const generateRequests = fake.requests.filter((r) => r.url === GEMINI_GENERATE_PATH)
      expect(generateRequests.length).toBeGreaterThan(0)
      expect(generateRequests[0].apiKey).toBe(FAKE_GEMINI_KEY)
    } finally {
      await cleanup(booted, fake)
    }
  })

  test('a provider-generated title does not suppress AI naming (summary record)', async ({ page }) => {
    // Unified agent names (Task 4): a `type:'summary'` record marks the
    // parsed claude title provider-generated — the OLD pipeline blocked
    // both the sweep's AI branch and the generate-title route for such
    // sessions. Provider names are FALLBACKS now: the explicitly-open
    // session still gets its Freshell AI title.
    const SESSION_ID = '00000000-0000-4000-8000-00000000a505'
    const AI_TITLE = 'Summary session AI name'
    const fake = await startFakeGemini(AI_TITLE)
    const booted = await bootAutoTitleServer({
      session: {
        sessionId: SESSION_ID,
        firstMessage: 'Investigate the dropped connection',
        projectDirName: 'summaryproj',
        summary: 'Provider summary title',
      },
      env: { FRESHELL_GEMINI_BASE_URL: fake.baseUrl },
    })
    try {
      await patchSettings(page, booted.info, { ai: { geminiApiKey: FAKE_GEMINI_KEY } })
      const harness = await bootAndConnect(page, booted.info)
      await resumeSeededSession(page, harness, SESSION_ID)
      await expect.poll(
        () => directoryTitle(page, booted.info, SESSION_ID),
        { timeout: 20_000 },
      ).toBe(AI_TITLE)
      const generateRequests = fake.requests.filter((r) => r.url === GEMINI_GENERATE_PATH)
      expect(generateRequests.length).toBeGreaterThan(0)
    } finally {
      await cleanup(booted, fake)
    }
  })

  test('a manual rename during an in-flight AI request wins', async ({ page }) => {
    // Unified agent names (Task 4): the 20-second-bounded generation request
    // is held at the fake; the user's explicit rename mid-flight must commit
    // and the late AI answer must never clobber it.
    const SESSION_ID = '00000000-0000-4000-8000-00000000a606'
    const AI_TITLE = 'Late AI answer'
    const fake = await startFakeGemini(AI_TITLE, { hold: true })
    const booted = await bootAutoTitleServer({
      session: { sessionId: SESSION_ID, firstMessage: 'Rename me mid-flight', projectDirName: 'midflight' },
      env: { FRESHELL_GEMINI_BASE_URL: fake.baseUrl },
    })
    try {
      await patchSettings(page, booted.info, { ai: { geminiApiKey: FAKE_GEMINI_KEY } })
      const harness = await bootAndConnect(page, booted.info)
      await resumeSeededSession(page, harness, SESSION_ID)

      // The held request proves the generation attempt is in flight.
      await expect.poll(
        () => fake.requests.filter((r) => r.url === GEMINI_GENERATE_PATH).length,
        { timeout: 20_000 },
      ).toBeGreaterThan(0)

      // The manual rename commits while the provider operation is held.
      const res = await page.request.patch(
        `${booted.info.baseUrl}/api/sessions/${encodeURIComponent(`claude:${SESSION_ID}`)}`,
        {
          headers: { 'x-auth-token': booted.info.token, 'content-type': 'application/json' },
          data: { titleOverride: 'MINE MID-FLIGHT', nameIntent: 'user' },
        },
      )
      expect(res.ok()).toBe(true)
      expect(await directoryTitle(page, booted.info, SESSION_ID)).toBe('MINE MID-FLIGHT')

      // Release the late answer: the protected manual name rejects it.
      fake.releaseResponses!()
      await page.waitForTimeout(3_000)
      expect(await directoryTitle(page, booted.info, SESSION_ID)).toBe('MINE MID-FLIGHT')
    } finally {
      await cleanup(booted, fake)
    }
  })
})
