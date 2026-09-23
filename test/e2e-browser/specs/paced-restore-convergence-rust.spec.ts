/**
 * PRC09 — incident-shaped paced-restore convergence (the end-to-end
 * requirement of the responsive-terminal-restore bounded-recovery
 * increment, docs/plans/2026-09-19-responsive-terminal-restore.md).
 *
 * Tasks 1-8 landed the increment: negotiated paced replay (credit-gated
 * pages), restore-contract bounds fields, client coverage-cursor resume
 * with bounded recovery (auto-kill removed), hidden-pane lifetime claims,
 * and spill-before-disconnect backpressure. Unit/integration coverage is
 * complete; THIS spec proves the user-visible outcome on the incident's
 * data shape in a real browser against the real Rust server:
 *
 *   ~7 terminal panes, each with ~3 MB of retained scrollback produced by
 *   a DETERMINISTIC seeded writer (one POSIX awk process per terminal
 *   emitting fixed-width, sequence-marked lines in ~45 KiB blocks — see
 *   BLOCK_ROWS for why block granularity is load-bearing), plus one
 *   retained-output-expired terminal for the honest-state case (early
 *   marker evicted by driving the ring past its cap with newer output).
 *
 * Incident fidelity (plan §"Incident report"): 7 x ~3 MB ≈ 21 MB of resent
 * history over ONE WebSocket — the aggregate that the pre-fix server turned
 * into a reconnect loop (sustained-backlog 4008 closes below the spill
 * threshold). Scrollback is pinned to 10,000 lines = the 3,000,000
 * UTF-16-unit retention cap (compute_scrollback_max_bytes) via the settings
 * route (the term13 donor's mechanism), BEFORE any terminal exists.
 *
 * Scenario 2 mechanism note (recorded deviation from the brief's wording):
 * the brief says "page reload, not server kill" for the mid-restore
 * disconnect, but ALSO requires "the WS traffic carried a sinceSeq > 0
 * delta attach". Those are incompatible as one mechanism: a page reload
 * lands on a FRESH surface instance, and the WS2 reload contract
 * (terminal-surface-checkpoint.ts) deliberately scopes checkpoints to
 * surface instances so a fresh surface can never claim progress it never
 * rendered — the post-reload attach is a sinceSeq=0 viewport hydrate BY
 * DESIGN. The sinceSeq>0 delta attach is the transport_reconnect contract
 * (same-page client-side connection drop: the exact incident shape of a
 * WS falling over mid-restore). So the restore is STARTED with the donor
 * reload pattern (page.reload), and the mid-restore disconnect is the
 * harness's client-side forceDisconnect — never a server kill. Every listed
 * assertion is satisfied and the pinned path is the one the incident
 * actually exercised.
 *
    * Scenario 4 mechanism note (the round-4 plan:166 reversal): there is
    * no WS-level fault-injection seam in helpers/; the honest page-level
    * seam is the harness's own forceDisconnect loop. Recovery accounting
    * resets ONLY on genuine parser progress or an explicit user retry —
    * "not merely on receiving attach.ready or another reconnect"
    * (plan:166). A converged idle pane's flaps re-attach with empty
    * cursor-CONFIRMED deltas that complete cleanly, and that clean
    * completion is NOT progress: no bytes applied, no coverage advance,
    * so the streak is never reset and the flap cycle EXHAUSTS to the
    * retry strip exactly like any progressless cycle. The bound therefore
    * trips for BOTH panes this fixture can build deterministically: the
    * retention-expired pane (T08), whose every reconnect attach is
    * gap-tainted with no coverage progress, AND the healthy converged
    * pane (a full-retention tag) whose flaps are clean but progressless.
    * In both shapes the content is PRESERVED at the strip and an
    * explicit retry re-arms the automatic recovery.
 *
 * Scenario 5 mechanism note: "any spill produces the honest gap notice" —
 * on the NEGOTIATED browser lane a spill is structurally unreachable
 * (paced delivery keeps per-terminal in-flight at ~1 page of 128 KiB, far
 * below the 16 MiB spill threshold — that is the increment's whole point),
 * so the e2e assertion is the connection staying open (zero 4008 /
 * lagged / catastrophic closes in the server log window) while all
 * sessions work through the restore. The spill gap-notice path itself is
 * pinned by the Rust integration lane (task 6).
 *
 * Cloud legality: SHELL terminals only (no provider CLIs), deterministic
 * seeded output, no provider-lifecycle timing dependence. This file is NOT
 * in CLOUD_SKIP_SPECS (playwright.cloud.config.ts) and must never join it.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { test, expect, createFreshE2ePage } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness, selectShellFromPicker } from '../helpers/test-harness.js'
import { installRecoveryOfferAutoDecline } from '../helpers/recovery-offer.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js'

// ---------------------------------------------------------------------------
// Incident-shape constants
// ---------------------------------------------------------------------------

/** 10,000 lines -> the 3,000,000 UTF-16-unit retention cap
 * (compute_scrollback_max_bytes = lines * 300, clamped). */
const SCROLLBACK_LINES = 10_000

/** Full-scrollback terminals: 63 blocks x 700 lines ≈ 2.87 MB — strictly
 * under the 3,000,000-unit cap, so the ENTIRE flood is retained (the restore
 * must reproduce it faithfully). */
const FULL_FLOOD_LINES = 44_100

/** Retention-expired terminal: 75 blocks ≈ 3.4 MB of newer output drives the
 * ring past the cap and evicts the early marker (and the first ~6,000
 * evict-flood lines) — the honest retention-loss case. */
const EVICT_FLOOD_LINES = 52_500

/** Lines per seeded-writer BLOCK. Block-granularity is a MEASURED fixture
 * requirement, not an aesthetic one: the paced page budget
 * (paced_page_build) charges every retained frame its full
 * batch-envelope cost (~400 serialized bytes), so per-`echo` 65-byte frames
 * shrink a 128 KiB page to ~22 KiB of real payload and stretch a
 * full-layout restore to minutes (~130 ms per credit round-trip, measured
 * 2026-09-21 via the write-event/credit probe). One awk process emitting
 * 700-line blocks (~45 KiB per write, whole flood in ~40 ms) keeps pages
 * ~2 frames (~91 KiB payload) — the same retained content, the same
 * deterministic per-seq lines, a CI-workable paced wall clock. */
const BLOCK_ROWS = 700

/** Fixed-width padding so every flood line is ~64 chars — short enough that
 * xterm never soft-wraps a logical line across two rendered rows at any
 * plausible pane width (the term13 donor's no-wrap discipline). */
const PAD = 'X'.repeat(48)

const TOTAL_TERMINALS = 8
const TAGS = ['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08'] as const
const EXPIRED_TAG = 'T08'
/** Assembled from split halves on the wire (see `splitForEcho`) so the PTY's
 * echo of the typed command never contains the contiguous marker — a
 * convergence assertion must not be satisfiable by the command's own echo
 * row. */
const EARLY_LOST_MARKER = 'PRC09T08-EARLY-LOST'
const DONE_MARKER_SUFFIX = 'DONE'

/** CI-generous bound for "all panes converged" (the one-second target is
 * the LATER screen-first increment's acceptance; actual timings are
 * recorded as attachments, never asserted below this bound). Measured
 * local wall clock for the full 8-pane layout: ~24 s (2026-09-21); the
 * bound leaves >3x headroom for the 2-CPU cloud lane. */
const CONVERGENCE_BOUND_MS = 90_000

type OwnedIncident = {
  server: RustServer
  info: E2eServerInfo
  context: BrowserContext
  page: Page
  harness: TestHarness
  sharedRoot: string
  doneDir: string
  logPath: string
  tabIds: string[]
  terminalIds: string[]
}

// ---------------------------------------------------------------------------
// Deterministic seeded writer
// ---------------------------------------------------------------------------

function expectedFloodLine(tag: string, seq: number): string {
  return `PRC09${tag}-${Math.floor(seq / BLOCK_ROWS)}-${seq % BLOCK_ROWS}-${PAD}`
}

function expectedDoneMarker(tag: string): string {
  return `PRC09${tag}-${DONE_MARKER_SUFFIX}`
}

/** Split a marker so the executed command's PTY-echoed row never contains
 * the contiguous marker (the shell prints `HALF1""HALF2`, the output row
 * prints the assembled marker). */
function splitForEcho(marker: string): string {
  const half = Math.floor(marker.length / 2)
  return `${marker.slice(0, half)}""${marker.slice(half)}`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** The seeded-writer awk program: `blocks` blocks of BLOCK_ROWS fixed-width
 * sequence-marked lines, one ~45 KiB write per block (see BLOCK_ROWS).
 * Pure POSIX — one fork per flood, no shell-isms, deterministic content:
 * line(seq) is exactly `PRC09<tag>-<block>-<row>-<pad>`. */
function seededWriterProgram(tag: string, lines: number): string {
  const blocks = Math.ceil(lines / BLOCK_ROWS)
  return (
    `awk 'BEGIN { pad="${PAD}"; for (b=0;b<${blocks};b++) { s=""; `
    + `for (r=0;r<${BLOCK_ROWS};r++) { s = s "PRC09${tag}-" b "-" r "-" pad "\\n" } `
    + `printf "%s", s } }'`
  )
}

/** The full-retention flood command. Flood lines embed block/row numbers,
 * so the echoed command never matches the `PRC09<tag>-<digits>-<digits>-`
 * line pattern either. */
function buildFullFloodCommand(tag: string, lines: number, doneFile: string): string {
  return (
    `${seededWriterProgram(tag, lines)}; `
    + `echo "${splitForEcho(expectedDoneMarker(tag))}"; `
    + `touch ${shellQuote(doneFile)}`
  )
}

/** The retention-expired terminal's command: a unique early marker FIRST,
 * then enough newer output to drive the ring past its cap (evicting the
 * early marker), then the done marker + done file. */
function buildEvictFloodCommand(tag: string, lines: number, doneFile: string): string {
  return (
    `echo "${splitForEcho(EARLY_LOST_MARKER)}"; `
    + `${seededWriterProgram(tag, lines)}; `
    + `echo "${splitForEcho(expectedDoneMarker(tag))}"; `
    + `touch ${shellQuote(doneFile)}`
  )
}

// ---------------------------------------------------------------------------
// Server log window (the authoritative disconnect-loop observable)
// ---------------------------------------------------------------------------

type LogWindowStats = {
  catastrophicClose: number
  laggedClose: number
  closed4008: number
  connectionCloses: Array<{ reason: string; code: number | null }>
  parseErrors: number
  totalLines: number
}

/**
 * Parse the server's JSONL tracing log (`rust-server.jsonl` — the real sink;
 * `info.debugLogPath` is never written, see the amplifier-lane donor's note)
 * and classify the disconnect-loop signatures: TERM-09's
 * `ws.terminal_stream.catastrophic_close`, SAFE-10's `ws.broadcast.lagged.close`
 * (both close with 4008), and any `ws.connection.closed` record carrying
 * `code: 4008`. Line-level JSON parsing — never substring-matching `4008`,
 * which would false-positive on byte counters.
 */
function analyzeLogWindow(text: string): LogWindowStats {
  const stats: LogWindowStats = {
    catastrophicClose: 0,
    laggedClose: 0,
    closed4008: 0,
    connectionCloses: [],
    parseErrors: 0,
    totalLines: 0,
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    stats.totalLines += 1
    let record: Record<string, unknown>
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      stats.parseErrors += 1
      continue
    }
    const msg = typeof record.msg === 'string' ? record.msg : ''
    if (msg === 'ws.terminal_stream.catastrophic_close') stats.catastrophicClose += 1
    if (msg === 'ws.broadcast.lagged.close') stats.laggedClose += 1
    if (msg === 'ws.connection.closed') {
      const code = typeof record.code === 'number' ? record.code : null
      const reason = typeof record.reason === 'string' ? record.reason : 'unknown'
      stats.connectionCloses.push({ reason, code })
      if (code === 4008) stats.closed4008 += 1
    }
  }
  return stats
}

/** Byte-accurate log window: read as bytes, slice at the captured byte
 * offset, then decode (a char-based slice would drift on any non-ASCII
 * record). */
async function readLogWindow(logPath: string, offsetBytes: number): Promise<string> {
  const buffer = await fs.readFile(logPath).catch(() => Buffer.alloc(0))
  const start = Math.max(0, Math.min(offsetBytes, buffer.length))
  return buffer.subarray(start).toString('utf8')
}

function assertNoDisconnectLoop(stats: LogWindowStats): void {
  expect(stats.catastrophicClose, 'ws.terminal_stream.catastrophic_close count').toBe(0)
  expect(stats.laggedClose, 'ws.broadcast.lagged.close count').toBe(0)
  expect(stats.closed4008, 'ws.connection.closed with code 4008 count').toBe(0)
}

async function logOffsetBytes(logPath: string): Promise<number> {
  const stat = await fs.stat(logPath).catch(() => null)
  return stat ? stat.size : 0
}

// ---------------------------------------------------------------------------
// Harness plumbing (per-spec copies per the suite's ownership convention;
// donors: restore-contract-wall-rust.spec.ts, term13-scrollback-boundary.spec.ts,
// terminal-background-freeze-catchup.spec.ts)
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForFile(filePath: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await fs.stat(filePath)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for file ${filePath}`)
    await sleep(100)
  }
}

async function patchScrollbackSetting(info: E2eServerInfo, lines: number): Promise<void> {
  const response = await fetch(`${info.baseUrl}/api/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': info.token },
    body: JSON.stringify({ terminal: { scrollback: lines } }),
  })
  expect(response.ok, `PATCH /api/settings (scrollback ${lines}): ${response.status}`).toBe(true)
}

/** POST /api/tabs {mode:'shell'} — the restore-contract-wall donor's REST
 * shell-tab creation (focus-neutral; the caller reveals tabs explicitly). */
async function createShellTabViaRest(info: E2eServerInfo, cwd: string): Promise<string> {
  const response = await fetch(`${info.baseUrl}/api/tabs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-auth-token': info.token },
    body: JSON.stringify({ mode: 'shell', cwd }),
  })
  const payload = await response.json() as { data?: { tabId?: string } } | null
  expect(response.ok, `POST /api/tabs: ${JSON.stringify(payload)}`).toBe(true)
  const tabId = payload?.data?.tabId
  expect(tabId, 'POST /api/tabs envelope data.tabId').toBeTruthy()
  return tabId as string
}

/** Drive a terminal's PTY stdin over the harness's WS connection —
 * focus-independent (works for hidden/claimed panes whose output the
 * client never sees; retention accumulates server-side regardless of
 * attachment, and the input lane has no attachment requirement). */
async function sendTerminalInput(page: Page, terminalId: string, data: string): Promise<void> {
  await page.evaluate(
    ({ tid, payload }) => {
      window.__FRESHELL_TEST_HARNESS__?.sendWsMessage({
        type: 'terminal.input',
        terminalId: tid,
        data: payload,
      })
    },
    { tid: terminalId, payload: data },
  )
}

async function flushPersistence(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
  })
}

/** Click a tab (user-equivalent tab-strip click) and wait for it to activate. */
async function selectTab(page: Page, harness: TestHarness, tabId: string): Promise<void> {
  await page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`).click()
  await expect.poll(async () => harness.getActiveTabId(), { timeout: 10_000 }).toBe(tabId)
}

/** The live terminal inventory (`GET /api/terminals`, the killAllTerminals
 * donor's read) — server-truth for the never-killed contract. */
async function terminalStatuses(info: E2eServerInfo): Promise<Map<string, string>> {
  const response = await fetch(`${info.baseUrl}/api/terminals`, {
    headers: { 'x-auth-token': info.token },
  })
  expect(response.ok, 'GET /api/terminals').toBe(true)
  const terminals = (await response.json()) as Array<{ terminalId?: string; status?: string }>
  const map = new Map<string, string>()
  for (const entry of terminals) {
    if (typeof entry.terminalId === 'string') {
      map.set(entry.terminalId, typeof entry.status === 'string' ? entry.status : 'unknown')
    }
  }
  return map
}

function collectTabIdsFromState(state: Record<string, any>): string[] {
  const tabs = state?.tabs?.tabs
  if (!Array.isArray(tabs)) return []
  return tabs.map((t: Record<string, any>) => t?.id).filter((id: unknown): id is string => typeof id === 'string')
}

function terminalIdOfTabFromState(state: Record<string, any>, tabId: string): string | null {
  const layout = state?.panes?.layouts?.[tabId]
  if (!layout) return null
  const queue = [layout]
  while (queue.length > 0) {
    const node = queue.shift()
    if (node?.type === 'leaf' && typeof node.content?.terminalId === 'string') {
      return node.content.terminalId
    }
    if (Array.isArray(node?.children)) queue.push(...node.children)
  }
  return null
}

/** Wait until every tab (in tab-strip order) has a terminal id, and return
 * `{ tabIds, terminalIds }` aligned by index. */
async function waitAllTerminalIds(
  harness: TestHarness,
  count: number,
  timeoutMs = 60_000,
): Promise<{ tabIds: string[]; terminalIds: string[] }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const state = (await harness.getState()) as Record<string, any>
    const tabIds = collectTabIdsFromState(state)
    if (tabIds.length === count) {
      const terminalIds = tabIds.map((tabId) => terminalIdOfTabFromState(state, tabId))
      if (terminalIds.every((id): id is string => typeof id === 'string')) {
        return { tabIds, terminalIds }
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for ${count} terminal ids; tabs=${tabIds.length} state=${JSON.stringify(tabIds)}`,
      )
    }
    await sleep(100)
  }
}

// ---------------------------------------------------------------------------
// Convergence + evidence
// ---------------------------------------------------------------------------

type PaneConvergence = {
  tag: string
  doneMarker: string
  spotLines: string[]
  minLineCount: number
}

/** Deterministic expected content for one terminal: the done marker, late
 * sequence spot-checks inside the client's ~10,000-line xterm window, and a
 * flood-line count floor. */
function convergenceFor(tag: string, floodLines: number): PaneConvergence {
  const lastSeq = floodLines - 1
  const firstSeqInWindow = Math.max(0, floodLines - 9_900)
  const spotSeqs = [
    firstSeqInWindow + Math.floor((lastSeq - firstSeqInWindow) / 2),
    lastSeq - 500,
    lastSeq,
  ]
  return {
    tag,
    doneMarker: expectedDoneMarker(tag),
    spotLines: spotSeqs.map((seq) => expectedFloodLine(tag, seq)),
    minLineCount: 9_000,
  }
}

function floodLineCount(buffer: string, tag: string): number {
  return (buffer.match(new RegExp(`PRC09${tag}-[0-9]+-[0-9]+-X`, 'g')) ?? []).length
}

async function paneBuffer(harness: TestHarness, terminalId: string): Promise<string> {
  const buffer = await harness.getTerminalBuffer(terminalId)
  return typeof buffer === 'string' ? buffer : ''
}

/** Poll one pane until its rendered buffer carries the complete, correct
 * screen: the done marker, every spot-check row, and the flood-line count
 * floor. `timeoutMs` is the REMAINING budget for the whole restore window —
 * callers pass a shared deadline's remainder so N panes cannot N-tuple the
 * bound. */
async function waitPaneConverged(
  harness: TestHarness,
  terminalId: string,
  expected: PaneConvergence,
  timeoutMs: number,
): Promise<{ lineCount: number; bufferLength: number }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const buffer = await paneBuffer(harness, terminalId)
    const lineCount = floodLineCount(buffer, expected.tag)
    if (
      buffer.includes(expected.doneMarker)
      && expected.spotLines.every((line) => buffer.includes(line))
      && lineCount >= expected.minLineCount
    ) {
      return { lineCount, bufferLength: buffer.length }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Pane ${expected.tag} (${terminalId}) did not converge within ${timeoutMs}ms: `
        + `done=${buffer.includes(expected.doneMarker)} `
        + `lines=${lineCount} `
        + `spots=${expected.spotLines.map((line) => buffer.includes(line)).join(',')}`,
      )
    }
    await sleep(150)
  }
}

/** Type a command into the VISIBLE pane's terminal (the real keyboard
 * path) — the input-echo proof. The marker is split on the wire so the
 * typed command's PTY echo never contains the contiguous output marker. */
async function typeEchoCommand(page: Page, marker: string): Promise<void> {
  await page.locator('.xterm:visible').first().click()
  await page.keyboard.type(`echo "${splitForEcho(marker)}"`)
  await page.keyboard.press('Enter')
}

type EvidenceTestInfo = {
  outputPath: (name: string) => string
  attach: (name: string, options: { contentType: string; path: string }) => Promise<void>
  annotations: Array<{ type: string; description?: string }>
}

async function attachEvidence(
  testInfo: EvidenceTestInfo,
  fileName: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const evidencePath = testInfo.outputPath(fileName)
  await fs.writeFile(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  await testInfo.attach(fileName.replace(/\.json$/, ''), {
    contentType: 'application/json',
    path: evidencePath,
  })
}

/** Distinct terminal ids with replay credits in the client's recent
 * sent-message ledger (the ledger holds the post-reload traffic; the paced
 * path's credit-gated evidence). */
async function distinctCreditTerminalIds(harness: TestHarness): Promise<string[]> {
  const sent = (await harness.getSentWsMessages()) as Array<Record<string, any>>
  return [...new Set(
    sent
      .filter((m) => m?.type === 'terminal.replay.credit')
      .map((m) => String(m.terminalId)),
  )]
}

// ---------------------------------------------------------------------------
// The incident builder (per-test own server: isolated log window, isolated
// home, process-safe by the RustServer fixture's ownership contract)
// ---------------------------------------------------------------------------

/**
 * Boot an OWNED Rust server, open a fresh browser context (own machine
 * identity), create the incident layout — 1 boot shell tab + 7 REST shell
 * tabs, then flood 7 terminals with ~3 MB retained scrollback and 1 with
 * retention-expired output — and wait for all floods to complete
 * server-side (done files: the deterministic completion gate, the
 * freeze-catchup donor's marker-file pattern).
 *
 * `options.activeIndex` selects which tab is active at the caller's reload
 * (and therefore restores foreground immediately); it is selected AFTER the
 * floods so the persisted activeTabId points at it.
 */
async function bootIncident(
  browser: Browser,
  options: { activeIndex: number },
): Promise<OwnedIncident> {
  const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-prc09-'))
  const projectDir = path.join(sharedRoot, 'project')
  const doneDir = path.join(sharedRoot, 'done')
  await fs.mkdir(projectDir, { recursive: true })
  await fs.mkdir(doneDir, { recursive: true })

  const server = new RustServer()
  let context: BrowserContext | undefined
  try {
    const info = await server.start()
    const owned = await createFreshE2ePage(browser, info)
    context = owned.context
    const page = owned.page
    installRecoveryOfferAutoDecline(page)

    await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1&perfAudit=1`)
    const harness = new TestHarness(page)
    await harness.waitForHarness()
    await harness.waitForConnection()

    // Pin the retention cap BEFORE any terminal exists (TERM-13's documented
    // scope: applies to terminals created after the call).
    await patchScrollbackSetting(info, SCROLLBACK_LINES)

    // The boot tab becomes terminal #1 (the picker's shell).
    await selectShellFromPicker(page)

    // Terminals #2-#8 via the REST agent lane (focus-neutral shell tabs).
    for (let i = 1; i < TOTAL_TERMINALS; i += 1) {
      await createShellTabViaRest(info, projectDir)
    }

    const { tabIds, terminalIds } = await waitAllTerminalIds(harness, TOTAL_TERMINALS)

    // Flood all terminals. Tab #1's pane is attached (its flood streams live
    // to the page); the REST tabs are hidden and claimed, so their output
    // accumulates in the server's retention ring with no client delivery —
    // the incident's background terminals. Completion is gated by each
    // shell's done-file write.
    for (let i = 0; i < TOTAL_TERMINALS; i += 1) {
      const doneFile = path.join(doneDir, `${TAGS[i]}.done`)
      const command = TAGS[i] === EXPIRED_TAG
        ? buildEvictFloodCommand(TAGS[i], EVICT_FLOOD_LINES, doneFile)
        : buildFullFloodCommand(TAGS[i], FULL_FLOOD_LINES, doneFile)
      await sendTerminalInput(page, terminalIds[i], `${command}\n`)
    }
    await Promise.all(TAGS.map((tag) => waitForFile(path.join(doneDir, `${tag}.done`))))

    // Make the caller's chosen tab active, then persist the layout so the
    // reload restores every pane with its terminal identity.
    await selectTab(page, harness, tabIds[options.activeIndex])
    await flushPersistence(page)

    return {
      server,
      info,
      context,
      page,
      harness,
      sharedRoot,
      doneDir,
      logPath: path.join(info.logsDir, 'rust-server.jsonl'),
      tabIds,
      terminalIds,
    }
  } catch (error) {
    await context?.close().catch(() => {})
    await server.stop().catch(() => {})
    await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function teardownIncident(incident: OwnedIncident): Promise<void> {
  await incident.context.close().catch(() => {})
  await incident.server.stop().catch(() => {})
  await fs.rm(incident.sharedRoot, { recursive: true, force: true }).catch(() => {})
}

/** The donor reload pattern: full client rehydrate of the persisted layout. */
async function reloadAndReconnect(incident: OwnedIncident): Promise<void> {
  await incident.page.reload({ waitUntil: 'domcontentloaded' })
  await incident.harness.waitForHarness()
  await incident.harness.waitForConnection()
}

// ---------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------

test.describe('paced-restore convergence (incident-shaped, rust)', () => {
  test.setTimeout(240_000)

  test('cold-client restore converges every pane without a disconnect loop', async ({ browser }, testInfo) => {
    const incident = await bootIncident(browser, { activeIndex: 0 })
    try {
      const { page, harness, info, terminalIds, tabIds, logPath } = incident
      const windowStartOffset = await logOffsetBytes(logPath)
      const restoreStartedAt = Date.now()
      await reloadAndReconnect(incident)

      // Reveal every tab in order (a claimed hidden pane starts its paced
      // hydration at reveal — the WS1 hidden-pane lifetime-claim contract —
      // and switching away does NOT stop a started session, so every
      // restore then runs to completion). The bound is ONE shared window:
      // all panes must converge within it, collectively.
      const revealAt: Record<string, number> = {}
      for (let i = 0; i < TOTAL_TERMINALS; i += 1) {
        revealAt[TAGS[i]] = Date.now() - restoreStartedAt
        await selectTab(page, harness, tabIds[i])
        await sleep(150)
      }
      const windowDeadline = restoreStartedAt + CONVERGENCE_BOUND_MS
      const timings: Array<Record<string, unknown>> = []
      for (let i = 0; i < TOTAL_TERMINALS; i += 1) {
        const tag = TAGS[i]
        const expected = convergenceFor(tag, tag === EXPIRED_TAG ? EVICT_FLOOD_LINES : FULL_FLOOD_LINES)
        const converged = await waitPaneConverged(
          harness,
          terminalIds[i],
          expected,
          Math.max(1, windowDeadline - Date.now()),
        )
        timings.push({
          tag,
          revealedMs: revealAt[TAGS[i]],
          convergedMs: Date.now() - restoreStartedAt,
          floodLinesInWindow: converged.lineCount,
          bufferChars: converged.bufferLength,
        })
      }
      const totalConvergeMs = Date.now() - restoreStartedAt
      expect(totalConvergeMs, 'all panes converged wall clock').toBeLessThan(CONVERGENCE_BOUND_MS)

      // Credit-gated paced delivery evidence: the negotiated path sends
      // terminal.replay.credit for consumed pages (the legacy burst sends
      // none). The post-reload ledger holds the whole restore's traffic, so
      // every full terminal must appear in it.
      const creditIds = await distinctCreditTerminalIds(harness)
      expect(creditIds.length, 'terminals with replay credits').toBeGreaterThanOrEqual(TOTAL_TERMINALS - 1)

      // Every terminal ran a paced session (the perf-audit record of the
      // paced attach.ready contract).
      const perfEvents = (await harness.getPerfAuditSnapshot())?.perfEvents ?? []
      const pacedReadyTerminalIds = new Set(
        perfEvents
          .filter((event) => event.event === 'terminal.restore.paced_ready')
          .map((event) => String((event as Record<string, unknown>).terminalId ?? '')),
      )
      expect(pacedReadyTerminalIds.size, 'terminals with paced replay sessions').toBeGreaterThanOrEqual(TOTAL_TERMINALS - 1)

      // Input echo works in the focused pane (the last-visited tab is
      // active).
      const echoMarker = `PRC09-ECHO-ALIVE-${Date.now().toString(36)}`
      await typeEchoCommand(page, echoMarker)
      await expect
        .poll(async () => (await paneBuffer(harness, terminalIds[TOTAL_TERMINALS - 1])).includes(echoMarker), {
          timeout: 15_000,
        })
        .toBe(true)

      // The retention-expired terminal restored to its honest state: the
      // early marker is gone, the retained tail is intact.
      const expiredBuffer = await paneBuffer(harness, terminalIds[TOTAL_TERMINALS - 1])
      expect(expiredBuffer).not.toContain(EARLY_LOST_MARKER)

      // No kill/replacement anywhere: every terminal identity is unchanged
      // and no terminal exited.
      const statuses = await terminalStatuses(info)
      for (const terminalId of terminalIds) {
        expect(statuses.get(terminalId), `terminal ${terminalId} inventory status`).toBe('running')
      }

      const stats = analyzeLogWindow(await readLogWindow(logPath, windowStartOffset))
      assertNoDisconnectLoop(stats)

      await attachEvidence(testInfo, 'prc09-cold-restore-evidence.json', {
        totalConvergeMs,
        convergenceBoundMs: CONVERGENCE_BOUND_MS,
        perPane: timings,
        creditTerminalIds: creditIds,
        pacedReadyTerminalIds: [...pacedReadyTerminalIds],
        serverLog: stats,
      })
      testInfo.annotations.push({
        type: 'prc09-cold-restore',
        description: `all 8 panes converged in ${totalConvergeMs}ms (bound ${CONVERGENCE_BOUND_MS}ms)`,
      })
    } finally {
      await teardownIncident(incident)
    }
  })

  test('mid-restore client-side disconnect resumes from coverage checkpoints with zero superseding refetches (in-flight-writes quarantine excepted)', async ({ browser }, testInfo) => {
    const targetIndex = 1
    const incident = await bootIncident(browser, { activeIndex: targetIndex })
    try {
      const { page, harness, info, terminalIds, tabIds, logPath } = incident
      const targetTag = TAGS[targetIndex]
      const targetTabId = tabIds[targetIndex]
      const targetTerminalId = terminalIds[targetIndex]
      const floodLinePattern = new RegExp(`PRC09${targetTag}-[0-9]+-[0-9]+-X`)
      const windowStartOffset = await logOffsetBytes(logPath)
      const restoreStartedAt = Date.now()
      await reloadAndReconnect(incident)

      // The target tab is the active one, so its paced hydrate starts at
      // reload. Wait until its surface has CONSUMED replay content (a flood
      // row is rendered), then kill the CLIENT-side connection mid-restore.
      let observedLine: string | null = null
      const disconnectDeadline = Date.now() + 30_000
      for (;;) {
        const buffer = await paneBuffer(harness, targetTerminalId)
        const match = buffer.match(floodLinePattern)
        if (match) {
          observedLine = match[0]
          break
        }
        if (Date.now() > disconnectDeadline) {
          throw new Error('Target pane never rendered replay content before the disconnect deadline')
        }
        await sleep(100)
      }
      const doneVisibleAtDisconnect = (await paneBuffer(harness, targetTerminalId))
        .includes(expectedDoneMarker(targetTag))
      const disconnectedAt = Date.now()

      await harness.clearSentWsMessages()
      await harness.forceDisconnect()
      await harness.waitForConnection()
      const reconnectedAt = Date.now()

      // Checkpoint resume: the reconnect re-attaches the SAME surface via a
      // transport_reconnect DELTA (sinceSeq > 0 from the coverage cursor) —
      // never a fresh viewport_hydrate (the full re-fetch the incident
      // looped on).
      const sentAfterDisconnect = (await harness.getSentWsMessages()) as Array<Record<string, any>>
      const targetAttaches = sentAfterDisconnect.filter(
        (m) => m?.type === 'terminal.attach' && m.terminalId === targetTerminalId,
      )
      const perfSnapshot = (await harness.getPerfAuditSnapshot())?.perfEvents ?? []
      const targetFallbacks = perfSnapshot.filter(
        (event) => event.event === 'terminal.catchup.full_hydrate_fallback'
          && String((event as Record<string, unknown>).terminalId ?? '') === targetTerminalId,
      )
      const hydrateAttaches = targetAttaches.filter((m) => m.intent === 'viewport_hydrate')
      // Zero superseding refetches (task-009b, goal 4): the ONLY tolerated
      // hydrate is the in-flight-writes quarantine — a write still mutating
      // the surface at attach time freezes the checkpoint decision
      // (terminal.catchup.full_hydrate_fallback reason 'in_flight_writes' /
      // terminal.catchup.surface_quarantined), and the drained repair ALWAYS
      // rebuilds once more (surface_quarantine_repair, M-2): at most the
      // quarantined attach plus its repair rebuild. Any hydrate outside that
      // shape is a supersede regression.
      const quarantineAdmitted = perfSnapshot.some(
        (event) => {
          const record = event as Record<string, unknown>
          return String(record.terminalId ?? '') === targetTerminalId
            && (
              (event.event === 'terminal.catchup.full_hydrate_fallback'
                && record.reason === 'in_flight_writes')
              || event.event === 'terminal.catchup.surface_quarantined'
            )
        },
      )

      // Diagnostics-first: this evidence lands even when an assertion below
      // fails, so the failure is self-explaining (attach intents + any
      // warm-delta fallback reasons observed on the wire).
      await attachEvidence(testInfo, 'prc09-mid-restore-disconnect-diagnostics.json', {
        disconnectedAtMs: disconnectedAt - restoreStartedAt,
        reconnectedAtMs: reconnectedAt - restoreStartedAt,
        doneMarkerVisibleAtDisconnect: doneVisibleAtDisconnect,
        observedLine,
        targetAttaches,
        hydrateFallbackEvents: targetFallbacks,
        supersedingHydrateAttaches: hydrateAttaches.length,
        quarantineAdmitted,
      })
      expect(targetAttaches.length, 'a terminal.attach for the target pane after the reconnect').toBeGreaterThan(0)
      const deltaAttaches = targetAttaches.filter(
        (m) => m.intent === 'transport_reconnect' && typeof m.sinceSeq === 'number' && m.sinceSeq > 0,
      )
      expect(deltaAttaches, 'a sinceSeq > 0 transport_reconnect delta attach').not.toEqual([])
      // The checkpoint delta resume is authoritative: the reconnect's
      // reconcile round (App re-sends pane.reconcile on every ready)
      // confirms the pane's unchanged identity and must NOT re-drive a full
      // viewport_hydrate — the pre-fix behavior superseded the delta with up
      // to two sinceSeq:0 refetches per pane per flap (the pending-window
      // re-drive and the verdict-fold re-drive).
      if (!quarantineAdmitted) {
        expect(
          hydrateAttaches.length,
          'zero superseding viewport_hydrate refetches for a healthy-checkpoint flap',
        ).toBe(0)
      } else {
        expect(
          hydrateAttaches.length,
          'quarantine-bounded: at most the quarantined attach plus its drained repair rebuild',
        ).toBeLessThanOrEqual(2)
      }

      // The previously-visible content survives the disconnect — the surface
      // is preserved (no blank-then-refetch wipe).
      expect(await paneBuffer(harness, targetTerminalId)).toContain(observedLine!)

      // The pane resumes and converges to the complete correct screen.
      const expected = convergenceFor(targetTag, FULL_FLOOD_LINES)
      const converged = await waitPaneConverged(
        harness,
        targetTerminalId,
        expected,
        CONVERGENCE_BOUND_MS,
      )

      // No kill/replacement: identity unchanged (client layout AND server
      // inventory) and the process answers a fresh command.
      const state = (await harness.getState()) as Record<string, any>
      expect(terminalIdOfTabFromState(state, targetTabId)).toBe(targetTerminalId)
      const statuses = await terminalStatuses(info)
      expect(statuses.get(targetTerminalId), 'target terminal inventory status').toBe('running')
      const procMarker = `PRC09${targetTag}-PROC-ALIVE-${Date.now().toString(36)}`
      await sendTerminalInput(page, targetTerminalId, `echo "${splitForEcho(procMarker)}"\n`)
      await expect
        .poll(async () => (await paneBuffer(harness, targetTerminalId)).includes(procMarker), { timeout: 15_000 })
        .toBe(true)

      const stats = analyzeLogWindow(await readLogWindow(logPath, windowStartOffset))
      assertNoDisconnectLoop(stats)

      await attachEvidence(testInfo, 'prc09-mid-restore-disconnect-evidence.json', {
        restoreStartedAtMs: 0,
        disconnectedAtMs: disconnectedAt - restoreStartedAt,
        reconnectedAtMs: reconnectedAt - restoreStartedAt,
        doneMarkerVisibleAtDisconnect: doneVisibleAtDisconnect,
        observedLine,
        deltaAttachSinceSeqs: deltaAttaches.map((m) => m.sinceSeq),
        converged,
        serverLog: stats,
      })
      testInfo.annotations.push({
        type: 'prc09-mid-restore-disconnect',
        description: `delta attach sinceSeq=${deltaAttaches.map((m) => m.sinceSeq).join(',')}; content preserved; converged`,
      })
    } finally {
      await teardownIncident(incident)
    }
  })

  test('retention-expired terminal shows the honest incomplete-history notice and never kills', async ({ browser }, testInfo) => {
    const expiredIndex = TOTAL_TERMINALS - 1
    const incident = await bootIncident(browser, { activeIndex: expiredIndex })
    try {
      const { page, harness, info, terminalIds, tabIds, logPath } = incident
      const expiredTag = TAGS[expiredIndex]
      const expiredTabId = tabIds[expiredIndex]
      const expiredTerminalId = terminalIds[expiredIndex]
      const windowStartOffset = await logOffsetBytes(logPath)
      await reloadAndReconnect(incident)

      // The expired tab is active: its restore runs immediately and lands
      // on the honest retention-loss state.
      const expected = convergenceFor(expiredTag, EVICT_FLOOD_LINES)
      const converged = await waitPaneConverged(harness, expiredTerminalId, expected, CONVERGENCE_BOUND_MS)

      // The honest incomplete-history notice: accessible (role=status),
      // visible, exact user-facing contract.
      const notice = page.getByTestId('restore-retention-loss-notice')
      await expect(notice).toBeVisible({ timeout: 15_000 })
      await expect(notice).toContainText('no longer available on the server')
      await expect(notice).toContainText('Live output continues')

      // The lost content is honestly absent; the retained tail intact.
      const buffer = await paneBuffer(harness, expiredTerminalId)
      expect(buffer).not.toContain(EARLY_LOST_MARKER)
      expect(buffer).toContain(expectedDoneMarker(expiredTag))

      // No kill/replacement: identity unchanged in the live layout AND the
      // server inventory, and LIVE output still arrives and renders.
      const state = (await harness.getState()) as Record<string, any>
      expect(terminalIdOfTabFromState(state, expiredTabId)).toBe(expiredTerminalId)
      const statuses = await terminalStatuses(info)
      expect(statuses.get(expiredTerminalId), 'expired terminal inventory status').toBe('running')
      const liveMarker = `PRC09${expiredTag}-LIVE-AFTER-RESTORE-${Date.now().toString(36)}`
      await sendTerminalInput(page, expiredTerminalId, `echo "${splitForEcho(liveMarker)}"\n`)
      await expect
        .poll(async () => (await paneBuffer(harness, expiredTerminalId)).includes(liveMarker), { timeout: 15_000 })
        .toBe(true)

      // The negotiated gap's bounds landed in the perf audit stream: the
      // retention loss is REPORTED (headSeq / oldestRetainedSeq), not silent.
      const perfEvents = (await harness.getPerfAuditSnapshot())?.perfEvents ?? []
      const retentionGap = perfEvents.find(
        (event) => event.event === 'terminal.restore.retention_gap'
          && String((event as Record<string, unknown>).terminalId ?? '') === expiredTerminalId,
      )
      expect(retentionGap, 'terminal.restore.retention_gap perf event for the expired pane').toBeTruthy()
      const gapFields = retentionGap as Record<string, unknown>
      expect(typeof gapFields.headSeq).toBe('number')
      expect(typeof gapFields.oldestRetainedSeq).toBe('number')
      expect(gapFields.oldestRetainedSeq as number, 'oldestRetainedSeq > 1 proves eviction happened').toBeGreaterThan(1)

      const stats = analyzeLogWindow(await readLogWindow(logPath, windowStartOffset))
      assertNoDisconnectLoop(stats)

      await attachEvidence(testInfo, 'prc09-retention-loss-evidence.json', {
        converged,
        gap: retentionGap ?? null,
        serverLog: stats,
      })
      testInfo.annotations.push({
        type: 'prc09-retention-loss',
        description: `oldestRetainedSeq=${String(gapFields.oldestRetainedSeq)} headSeq=${String(gapFields.headSeq)}; notice visible; process alive`,
      })
    } finally {
      await teardownIncident(incident)
    }
  })

  test('the recovery bound trips for a retention-pinned cycle and for clean converged-pane flaps (plan:166), preserving content and re-arming on retry', async ({ browser }, testInfo) => {
    // The BOUND pane: the retention-expired terminal (T08). Its every
    // reconnect attach resumes from the coverage-pinned cursor, hits the
    // retention loss again, and completes GAP-TAINTED with no coverage
    // progress and no cursor confirmation — the genuinely NON-CONVERGED
    // restore cycle the bound exists to stop. (The healthy converged
    // pane below pins the round-4 plan:166 reversal: its cursor-confirmed
    // CLEAN flaps are not progress either, so its cycle exhausts to the
    // same strip and only an explicit retry re-arms it.)
    const targetIndex = TAGS.indexOf(EXPIRED_TAG)
    const healthyIndex = 3
    const incident = await bootIncident(browser, { activeIndex: targetIndex })
    try {
      const { page, harness, info, terminalIds, tabIds, logPath } = incident
      const targetTag = TAGS[targetIndex]
      const targetTabId = tabIds[targetIndex]
      const targetTerminalId = terminalIds[targetIndex]
      const windowStartOffset = await logOffsetBytes(logPath)
      await reloadAndReconnect(incident)

      // Full retained-tail restore first (the retention-loss honest state:
      // the early marker is gone, the retained window converges). The
      // initial hydration attach is consumed; every subsequent
      // progressless, gap-tainted attach counts.
      const expected = convergenceFor(targetTag, EVICT_FLOOD_LINES)
      const converged = await waitPaneConverged(harness, targetTerminalId, expected, CONVERGENCE_BOUND_MS)

      // Four client-side disconnects on the retention-pinned pane. Each
      // flap re-attaches, the retention gap re-arrives with the resume,
      // and the cycle completes GAP-TAINTED with ZERO coverage progress —
      // one counted keyless attempt per flap. Each cycle SETTLES before
      // the next cut (the rebuild finishes deterministically), so the
      // strip-time screen is the COMPLETED converged content, never an
      // interrupted rebuild's partial screen. The recovery bound
      // (TERMINAL_RECOVERY_MAX_ATTEMPTS = 3) must STOP the automatic
      // cycling once the attempts are spent — visible in the strip, never
      // a loop, never a kill. Four flaps give margin over where exactly
      // the bound lands.
      for (let i = 0; i < 4; i += 1) {
        await harness.forceDisconnect()
        await harness.waitForConnection()
        // Settle: each gap-tainted cycle must COMPLETE its rebuild before
        // the next cut — the exhaustion cycle's shape is "repeated cuts on
        // a non-converged pane", and the strip-time preservation assertion
        // below requires the last completed cycle's screen.
        await waitPaneConverged(harness, targetTerminalId, expected, CONVERGENCE_BOUND_MS)
      }

      const retryStrip = page.getByTestId('restore-recovery-retry')
      await expect(retryStrip, 'the bounded-recovery retry strip is visible').toBeVisible({ timeout: 15_000 })
      await expect(retryStrip).toContainText('not making progress')
      await expect(retryStrip).toContainText('What is on screen is unchanged')

      // Diagnostics-first: the attach intents, recovery-exhaustion record,
      // and buffer state at strip time, so a preserved-content failure is
      // self-explaining.
      const stripBuffer = await paneBuffer(harness, targetTerminalId)
      const stripDiagnostics = {
        sentAttaches: ((await harness.getSentWsMessages()) as Array<Record<string, any>>)
          .filter((m) => m?.type === 'terminal.attach' && m.terminalId === targetTerminalId)
          .map((m) => ({ intent: m.intent, sinceSeq: m.sinceSeq })),
        exhaustion: ((await harness.getPerfAuditSnapshot())?.perfEvents ?? []).find(
          (event) => event.event === 'terminal.restore.recovery_exhausted',
        ) ?? null,
        hydrateFallbacks: ((await harness.getPerfAuditSnapshot())?.perfEvents ?? [])
          .filter((event) => event.event === 'terminal.catchup.full_hydrate_fallback')
          .map((event) => ({
            terminalId: (event as Record<string, unknown>).terminalId,
            reason: (event as Record<string, unknown>).reason,
          })),
        bufferAtStrip: {
          length: stripBuffer.length,
          floodRows: floodLineCount(stripBuffer, targetTag),
          doneVisible: stripBuffer.includes(expectedDoneMarker(targetTag)),
        },
      }
      await attachEvidence(testInfo, 'prc09-recovery-bound-diagnostics.json', stripDiagnostics)

      // RESTORED preserved-content assertion (round-2 finding 4): the
      // bound's contract is that exhaustion PRESERVES the visible
      // content — the pre-restore screen (the converged retained tail
      // this cycling began from, reconstructed identically by each
      // settled cycle's rebuild) must still be ON SCREEN at the retry
      // strip, in full: the done marker, every spot-check row, and the
      // flood-row floor. Content loss at the strip is never acceptable:
      // a cycle that clears the viewport and is interrupted mid-rebuild
      // leaves a partial screen here and FAILS this assertion — the
      // round-1 revision's removed floor let exactly that pass.
      const preservedBuffer = await paneBuffer(harness, targetTerminalId)
      expect(
        preservedBuffer.includes(expected.doneMarker),
        'the pre-restore done marker is still on screen at the retry strip',
      ).toBe(true)
      for (const spot of expected.spotLines) {
        expect(
          preservedBuffer.includes(spot),
          `a preserved spot-check row is missing at the retry strip: ${spot}`,
        ).toBe(true)
      }
      expect(
        floodLineCount(preservedBuffer, targetTag),
        'the pre-restore flood rows are preserved on screen at the retry strip',
      ).toBeGreaterThanOrEqual(expected.minLineCount)

      // The pane is NEVER killed or replaced at the bound (plan: "no
      // healthy process is killed or replaced"; the strip preserves the
      // pane).
      expect(
        ((await harness.getSentWsMessages()) as Array<Record<string, any>>).find(
          (m) => (m?.type === 'terminal.kill' || m?.type === 'terminal.create')
            && m.terminalId === targetTerminalId,
        ),
        'the bound never kills or replaces the pane',
      ).toBeUndefined()

      // The cycling STOPPED: no further automatic attaches for the target
      // past the bound.
      await harness.clearSentWsMessages()
      await sleep(1_500)
      const sentAfterExhaustion = (await harness.getSentWsMessages()) as Array<Record<string, any>>
      expect(
        sentAfterExhaustion.filter((m) => m?.type === 'terminal.attach' && m.terminalId === targetTerminalId),
        'no automatic attach after the recovery bound',
      ).toEqual([])

      // Identity never changed (no kill/replacement).
      const state = (await harness.getState()) as Record<string, any>
      expect(terminalIdOfTabFromState(state, targetTabId)).toBe(targetTerminalId)
      const statuses = await terminalStatuses(info)
      expect(statuses.get(targetTerminalId), 'target terminal inventory status').toBe('running')

      // Explicit retry re-arms: the strip clears, a fresh delta attach goes
      // out, and the pane FULLY RECOVERS — complete, correct screen again —
      // then the process still answers input.
      await harness.clearSentWsMessages()
      await page.getByRole('button', { name: /Retry terminal restore/i }).click()
      await expect(retryStrip).toBeHidden({ timeout: 10_000 })
      const sentAfterRetry = (await harness.getSentWsMessages()) as Array<Record<string, any>>
      const retryAttach = sentAfterRetry.find(
        (m) => m?.type === 'terminal.attach' && m.terminalId === targetTerminalId,
      )
      // The retry REQUESTS a transport_reconnect resume; when the surface
      // still has writes in flight the attach is legitimately quarantined
      // and re-driven as a hydrate (the in-flight-writes freeze, WS2) — the
      // contract is that an attach GOES OUT, the strip clears, and the pane
      // converges again, never which intent the surface state picked.
      expect(retryAttach, 'the retry sent a fresh attach').toBeTruthy()
      await waitPaneConverged(harness, targetTerminalId, expected, 90_000)

      const echoMarker = `PRC09${targetTag}-RETRY-ECHO-${Date.now().toString(36)}`
      await sendTerminalInput(page, targetTerminalId, `echo "${splitForEcho(echoMarker)}"\n`)
      await expect
        .poll(async () => (await paneBuffer(harness, targetTerminalId)).includes(echoMarker), { timeout: 15_000 })
        .toBe(true)

      const perfEvents = (await harness.getPerfAuditSnapshot())?.perfEvents ?? []
      const exhaustedEvent = perfEvents.find((event) => event.event === 'terminal.restore.recovery_exhausted')
      const retryEvent = perfEvents.find((event) => event.event === 'terminal.restore.recovery_retry')
      expect(exhaustedEvent, 'terminal.restore.recovery_exhausted perf event').toBeTruthy()
      expect(retryEvent, 'terminal.restore.recovery_retry perf event').toBeTruthy()

      // The HEALTHY counterpart (the round-4 plan:166 reversal): a
      // converged idle pane's reconnect restores complete cleanly — no
      // gap, and the server CONFIRMS the client's cursor on each delta
      // resume (full retention, so effectiveSinceSeq equals the requested
      // sinceSeq). Under plan:166 that clean completion is NOT progress —
      // nothing applied, no coverage advanced — so the streak is never
      // reset and the flap cycle EXHAUSTS to the retry strip exactly like
      // the retention-pinned cycle; only an explicit retry re-arms it.
      // The reveal attach below is the pane's INITIAL hydration (exempt);
      // every flap after it counts: three clean-but-progressless flaps
      // spend the bound, the fourth is declined, the fifth confirms the
      // decline. Each flap still SETTLES on the converged screen — what
      // stays through restores AND declines is the PRESERVED content.
      const healthyTag = TAGS[healthyIndex]
      const healthyTabId = tabIds[healthyIndex]
      const healthyTerminalId = terminalIds[healthyIndex]
      await selectTab(page, harness, healthyTabId)
      const healthyExpected = convergenceFor(healthyTag, FULL_FLOOD_LINES)
      await waitPaneConverged(harness, healthyTerminalId, healthyExpected, CONVERGENCE_BOUND_MS)
      for (let flap = 0; flap < 5; flap += 1) {
        await harness.forceDisconnect()
        await harness.waitForConnection()
        // Settle on the converged screen after every flap: the counted
        // flaps restore back to it (clean delta resumes never wipe), and
        // the declined flaps leave it untouched — the strip-time content
        // below must be the COMPLETED converged screen either way.
        await waitPaneConverged(harness, healthyTerminalId, healthyExpected, CONVERGENCE_BOUND_MS)
      }

      // The clean pane EXHAUSTS (plan:166): the strip shows with the same
      // preserved-content contract as the retention-pinned pane.
      const healthyStrip = page.getByTestId('restore-recovery-retry')
      await expect(
        healthyStrip,
        'a clean converged pane exhausts to the retry strip — a clean restore is not progress (plan:166)',
      ).toBeVisible({ timeout: 15_000 })
      await expect(healthyStrip).toContainText('not making progress')
      await expect(healthyStrip).toContainText('What is on screen is unchanged')

      // Preserved-content at the strip (focused-e1r1 finding 3's shape,
      // under the corrected semantics): the retained pane's restores are
      // checkpoint delta resumes — no destructive clear-and-rebuild ever
      // wipes the surface — and the DECLINED flaps mutate nothing either.
      // The strip-time screen is the full converged content: the done
      // marker and the pre-gap flood rows, never a mid-rebuild partial.
      const healthyPreservedBuffer = await paneBuffer(harness, healthyTerminalId)
      expect(
        healthyPreservedBuffer.includes(healthyExpected.doneMarker),
        'the converged done marker is still on screen at the healthy pane’s strip',
      ).toBe(true)
      expect(
        floodLineCount(healthyPreservedBuffer, healthyTag),
        'the retained pane’s pre-gap surface is preserved at its recovery strip',
      ).toBeGreaterThan(0)

      // The bound never kills or replaces the clean pane either.
      expect(
        ((await harness.getSentWsMessages()) as Array<Record<string, any>>).find(
          (m) => (m?.type === 'terminal.kill' || m?.type === 'terminal.create')
            && m.terminalId === healthyTerminalId,
        ),
        'the healthy pane’s bound never kills or replaces it',
      ).toBeUndefined()

      // The bound HOLDS: a further flap is declined — no automatic attach
      // for the exhausted clean pane.
      await harness.clearSentWsMessages()
      await harness.forceDisconnect()
      await harness.waitForConnection()
      await sleep(1_500)
      const sentAfterHealthyExhaustion = (await harness.getSentWsMessages()) as Array<Record<string, any>>
      expect(
        sentAfterHealthyExhaustion.filter((m) => m?.type === 'terminal.attach' && m.terminalId === healthyTerminalId),
        'no automatic attach for the exhausted clean pane on a further flap',
      ).toEqual([])

      // Exhaustion evidence for the clean pane (plan:166's own record):
      // diagnostics attach BEFORE the retry so a failure is self-explaining.
      const healthyEvents = (await harness.getPerfAuditSnapshot())?.perfEvents ?? []
      expect(
        healthyEvents.find(
          (event) => event.event === 'terminal.restore.recovery_exhausted'
            && String((event as Record<string, unknown>).terminalId) === healthyTerminalId,
        ),
        'the clean converged pane recorded a recovery exhaustion',
      ).toBeTruthy()
      await attachEvidence(testInfo, 'prc09-healthy-pane-diagnostics.json', {
        healthyTerminalId,
        healthyRecoveryEvents: healthyEvents
          .filter((event) => String((event as Record<string, unknown>).terminalId) === healthyTerminalId)
          .map((event) => ({
            event: event.event,
            attempts: (event as Record<string, unknown>).attempts,
            intent: (event as Record<string, unknown>).intent,
            reason: (event as Record<string, unknown>).reason,
          })),
        allExhaustions: healthyEvents
          .filter((event) => event.event === 'terminal.restore.recovery_exhausted')
          .map((event) => ({
            terminalId: (event as Record<string, unknown>).terminalId,
            attempts: (event as Record<string, unknown>).attempts,
          })),
      })

      // Explicit retry re-arms the clean pane too (the user's control —
      // plan:166's only other reset): the strip clears, a fresh attach
      // goes out, and the pane converges again on its preserved surface.
      await harness.clearSentWsMessages()
      await page.getByRole('button', { name: /Retry terminal restore/i }).click()
      await expect(healthyStrip).toBeHidden({ timeout: 10_000 })
      const healthyRetrySent = (await harness.getSentWsMessages()) as Array<Record<string, any>>
      expect(
        healthyRetrySent.find(
          (m) => m?.type === 'terminal.attach' && m.terminalId === healthyTerminalId,
        ),
        'the healthy pane’s retry sent a fresh attach',
      ).toBeTruthy()
      await waitPaneConverged(harness, healthyTerminalId, healthyExpected, 90_000)

      const stats = analyzeLogWindow(await readLogWindow(logPath, windowStartOffset))
      assertNoDisconnectLoop(stats)

      await attachEvidence(testInfo, 'prc09-recovery-bound-evidence.json', {
        converged,
        exhaustion: exhaustedEvent ?? null,
        retry: retryEvent ?? null,
        retryAttachSinceSeq: retryAttach?.sinceSeq ?? null,
        serverLog: stats,
      })
      testInfo.annotations.push({
        type: 'prc09-recovery-bound',
        description: 'the bound stopped both the retention-pinned and the clean converged cycles (plan:166) and re-armed each on retry',
      })
    } finally {
      await teardownIncident(incident)
    }
  })

  test('several panes restoring simultaneously keep the connection open', async ({ browser }, testInfo) => {
    const incident = await bootIncident(browser, { activeIndex: 0 })
    try {
      const { page, harness, terminalIds, tabIds, logPath } = incident
      const windowStartOffset = await logOffsetBytes(logPath)
      const restoreStartedAt = Date.now()
      await reloadAndReconnect(incident)

      // Rapid-cycle through every tab with a short settle: each reveal
      // starts a paced session, and switching away does NOT stop it — by
      // the end of the cycle every terminal's restore is running
      // CONCURRENTLY on the one connection (~22 MB aggregate in flight, the
      // incident's load shape).
      for (let i = 0; i < TOTAL_TERMINALS; i += 1) {
        await selectTab(page, harness, tabIds[i])
        await sleep(400)
      }

      // Simultaneity evidence (measurement, not a pass/fail bar): mid-window,
      // credits for several DISTINCT terminals flow through the sent-message
      // ledger — the paced sessions are interleaved, not serialized.
      let maxConcurrentCreditTerminals = 0
      const creditSampleDeadline = Date.now() + 8_000
      while (Date.now() < creditSampleDeadline) {
        const ids = await distinctCreditTerminalIds(harness)
        maxConcurrentCreditTerminals = Math.max(maxConcurrentCreditTerminals, ids.length)
        if (maxConcurrentCreditTerminals >= 3) break
        await sleep(250)
      }

      // The connection works through the queues: EVERY pane converges
      // (hidden panes keep draining — their buffers stay readable), inside
      // ONE shared window.
      const windowDeadline = restoreStartedAt + CONVERGENCE_BOUND_MS
      const perPane: Array<Record<string, unknown>> = []
      for (let i = 0; i < TOTAL_TERMINALS; i += 1) {
        const tag = TAGS[i]
        const expected = convergenceFor(tag, tag === EXPIRED_TAG ? EVICT_FLOOD_LINES : FULL_FLOOD_LINES)
        const converged = await waitPaneConverged(
          harness,
          terminalIds[i],
          expected,
          Math.max(1, windowDeadline - Date.now()),
        )
        perPane.push({ tag, convergedMs: Date.now() - restoreStartedAt, ...converged })
      }
      const totalConvergeMs = Date.now() - restoreStartedAt
      expect(totalConvergeMs).toBeLessThan(CONVERGENCE_BOUND_MS)

      // Credit-gated delivery flowed for every terminal.
      const creditIds = await distinctCreditTerminalIds(harness)
      expect(creditIds.length, 'terminals with replay credits').toBeGreaterThanOrEqual(TOTAL_TERMINALS - 1)

      // Every terminal ran a paced session.
      const perfEvents = (await harness.getPerfAuditSnapshot())?.perfEvents ?? []
      const pacedReadyTerminalIds = new Set(
        perfEvents
          .filter((event) => event.event === 'terminal.restore.paced_ready')
          .map((event) => String((event as Record<string, unknown>).terminalId ?? '')),
      )
      expect(pacedReadyTerminalIds.size, 'every terminal ran a paced session').toBe(TOTAL_TERMINALS)

      // The load-bearing assertion: through the whole simultaneous-restore
      // window the connection NEVER hit a backpressure close — zero 4008 /
      // broadcast-lagged / catastrophic closes in the server's log.
      const stats = analyzeLogWindow(await readLogWindow(logPath, windowStartOffset))
      assertNoDisconnectLoop(stats)

      await attachEvidence(testInfo, 'prc09-backpressure-survival-evidence.json', {
        maxConcurrentCreditTerminals,
        totalConvergeMs,
        perPane,
        creditTerminalIds: creditIds,
        pacedReadyTerminalIds: [...pacedReadyTerminalIds],
        serverLog: stats,
      })
      testInfo.annotations.push({
        type: 'prc09-backpressure-survival',
        description: `${pacedReadyTerminalIds.size} concurrent paced sessions; peak ${maxConcurrentCreditTerminals} interleaved credit streams; zero 4008 closes; converged in ${totalConvergeMs}ms`,
      })
    } finally {
      await teardownIncident(incident)
    }
  })
})
