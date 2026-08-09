import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle, type E2eServerHandle } from '../helpers/external-target.js'
import { TestHarness } from '../helpers/test-harness.js'
import type { TestServerInfo } from '../helpers/test-server.js'

/**
 * GIT BRANCH/DIRTY BADGES (Task 23, rust-only) -- e2e proof of the Rust
 * server's TerminalMetaRegistry + git enrichment (Tasks 17-18):
 *
 *  - the create-time async enrichment (`crates/freshell-ws/src/terminal.rs:1354-1369`
 *    -> `terminal_meta::enrich_from_cwd`, real `git` probes via
 *    `freshell_platform::git_meta`) fills `checkoutRoot`/`branch`/`isDirty`
 *    for a shell terminal created with a git cwd;
 *  - the `terminal.meta.updated` broadcast reaches the live SPA, whose pane
 *    header renders `basename (branch*)` (`formatPaneRuntimeLabel`,
 *    `src/lib/format-terminal-title-meta.ts:26-35`; rendered by
 *    `PaneHeader.tsx:177-184` via `PaneContainer.tsx:510-513`);
 *  - reload persistence: the WS handshake ships
 *    `terminal_meta: state.terminal_meta.list()` (`freshell-ws/src/lib.rs:413`),
 *    so a freshly-reloaded client shows the badge again without any live
 *    `terminal.meta.updated` frame.
 *
 * CLIENT-CREATE PATH (deviation from the brief's `POST /api/tabs {cwd}`,
 * documented in `sdd/task-23-report.md`): the ONLY create-time meta seeding
 * in the Rust port lives in the WS `terminal.create` handler
 * (`terminal.rs:1295-1369`). The REST `POST /api/tabs` pipeline
 * (`freshell-freshagent`, `spawn_terminal_pane`) never touches the
 * TerminalMetaRegistry (zero references in that crate), and the Task 18
 * sweep refresh only rebuilds records the create path ALREADY seeded
 * (`auto_title_sweep.rs:262-264`, Node `applySessionMetadata:184-185`
 * parity) -- so a REST-created shell terminal never gets a badge today
 * (empirically confirmed: handshake `terminalMeta` stays `[]`). Test 1
 * therefore drives the tab through the CLIENT create path (Redux `addTab`
 * with `initialCwd` -> `TerminalView` sends `terminal.create{cwd}`,
 * `TerminalView.tsx:2783-2787` -- the SAME path every user-created tab
 * takes), proving the badge feature end-to-end. Test 2 pins the brief's
 * exact REST flow as a KNOWN GAP via `test.fail()`
 * (rest-tab-persistence.spec.ts precedent).
 *
 * PER-TEST OWNED SERVERS (auto-title-rust.spec.ts / Task 21 precedent), with
 * the badge repo seeded INSIDE each server's isolated home by `setupHome`
 * (host `git` binary, isolated dir -- never a real checkout).
 */

const BADGE_LABEL = 'badgerepo (main*)'

interface BootedServer {
  server: E2eServerHandle
  info: TestServerInfo
  repoDir: string
}

/**
 * `git init -b main` + one commit + a dirty edit inside
 * `<home>/projects/badgerepo`. Identity/signing come from `-c` flags so the
 * isolated HOME (no global gitconfig) and any host signing config are both
 * irrelevant.
 */
async function seedBadgeRepo(homeDir: string): Promise<string> {
  const repoDir = path.join(homeDir, 'projects', 'badgerepo')
  await fs.mkdir(repoDir, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir })
  git('init', '-b', 'main')
  await fs.writeFile(path.join(repoDir, 'file.txt'), 'clean contents\n', 'utf8')
  git('add', '.')
  git(
    '-c', 'user.name=Freshell E2E',
    '-c', 'user.email=e2e@example.invalid',
    '-c', 'commit.gpgsign=false',
    'commit', '-m', 'initial commit',
  )
  // Dirty it: the badge must carry the `*` suffix.
  await fs.writeFile(path.join(repoDir, 'file.txt'), 'dirty contents\n', 'utf8')
  return repoDir
}

async function bootBadgeServer(): Promise<BootedServer> {
  let repoDir = ''
  const server = await createE2eServerHandle(process.env, {
    kind: 'rust',
    construct: {
      setupHome: async (homeDir: string) => {
        repoDir = await seedBadgeRepo(homeDir)
      },
    },
  })
  const info = await server.start()
  expect(repoDir, 'setupHome must have seeded the badge repo').toBeTruthy()
  return { server, info, repoDir }
}

async function connect(page: Page, info: TestServerInfo): Promise<TestHarness> {
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  return harness
}

test.describe('Git branch/dirty badges (Rust only)', () => {
  test.setTimeout(150_000)

  test('pane badge shows branch + dirty star for a git cwd and survives reload', async ({ page }) => {
    const { server, info, repoDir } = await bootBadgeServer()
    try {
      const harness = await connect(page, info)

      // Create a shell tab with cwd=<home>/projects/badgerepo through the
      // client create path: Redux `addTab` + `initLayout` with a fresh
      // terminal content -- the SAME two-dispatch sequence `openSessionTab`
      // uses for a cwd-carrying terminal tab (tabsSlice.ts:787-800).
      // `normalizePaneContent` mints the `createRequestId`
      // (panesSlice.ts:78-80), so the mounted TerminalView sends
      // `terminal.create{cwd}` (TerminalView.tsx:2728,2783-2787) -> the
      // create-time meta seed + async git enrichment (Task 18).
      const tabId = 'git-badge-e2e-tab'
      await page.evaluate((args) => {
        const harnessApi = (window as any).__FRESHELL_TEST_HARNESS__
        harnessApi.dispatch({
          type: 'tabs/addTab',
          payload: { id: args.tabId, mode: 'shell', title: 'badge-tab', initialCwd: args.repo },
        })
        harnessApi.dispatch({
          type: 'panes/initLayout',
          payload: {
            tabId: args.tabId,
            content: { kind: 'terminal', mode: 'shell', initialCwd: args.repo },
          },
        })
      }, { tabId, repo: repoDir })
      await expect.poll(() => harness.getActiveTabId(), { timeout: 10_000 }).toBe(tabId)
      const paneShell = page.locator(`[data-context="pane"][data-tab-id="${tabId}"]`)
      await expect(paneShell.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      // The pane header meta label: `basename(checkoutRoot) (branch*)` --
      // "badgerepo (main*)" (format-terminal-title-meta.ts:26-35; the dirty
      // edit in setupHome produces the `*`).
      await expect(paneShell.getByText(BADGE_LABEL, { exact: true })).toBeVisible({ timeout: 30_000 })

      // Reload: the badge must come back WITHOUT any live meta broadcast --
      // the pane rehydrates from localStorage and the meta record arrives on
      // the WS handshake's `terminal_meta` list. Flush the persist debounce
      // first (rest-tab-persistence.spec.ts pattern) so the tab itself
      // survives the reload deterministically.
      await page.evaluate(() => {
        (window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
      })
      await page.reload({ waitUntil: 'domcontentloaded' })
      await harness.waitForHarness()
      await harness.waitForConnection()

      await expect(paneShell.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      await expect(paneShell.getByText(BADGE_LABEL, { exact: true })).toBeVisible({ timeout: 30_000 })
    } finally {
      await server.stop().catch(() => {})
    }
  })

  // ---------------------------------------------------------------------
  // KNOWN GAP (test.fail): the brief's exact flow -- a REST-created shell
  // tab (`POST /api/tabs {cwd}`) -- never gets a git badge on the Rust
  // server today. Node parity note: the legacy server seeds a meta record
  // off the registry's 'terminal.created' EVENT for EVERY terminal
  // (`server/index.ts:647-655` -> `seedFromTerminal`), REST creates
  // included; the Rust port only seeds inside the WS `terminal.create`
  // handler (`crates/freshell-ws/src/terminal.rs:1295-1369`), and the REST
  // pipeline (`freshell-freshagent::spawn_terminal_pane`) never touches the
  // TerminalMetaRegistry. The Task 18 sweep can't fill the hole either: it
  // skips terminals the create path never seeded
  // (`auto_title_sweep.rs:262-264`).
  //
  // FLIP INSTRUCTION: when REST creates gain meta seeding (Node
  // `seedFromTerminal` parity), the badge assertion below will START
  // passing, which trips this `test.fail()` annotation into a hard failure
  // -- that is the signal to delete the annotation and let this run green
  // (same regime as rest-tab-persistence.spec.ts's flip note).
  // ---------------------------------------------------------------------
  test('KNOWN GAP: a REST-created shell tab (POST /api/tabs {cwd}) never shows a git badge', async ({ page }) => {
    test.fail()
    const { server, info, repoDir } = await bootBadgeServer()
    try {
      // Connect the browser FIRST: the `ui.command{tab.create}` broadcast is
      // the ONLY way a REST-created tab materializes in the SPA (no
      // list-current-tabs fetch backs this path --
      // rest-tab-persistence.spec.ts:146-155).
      await connect(page, info)

      const res = await page.request.post(`${info.baseUrl}/api/tabs`, {
        headers: { 'content-type': 'application/json', 'x-auth-token': info.token },
        data: { cwd: repoDir, name: 'badge-rest-tab' },
      })
      expect(res.status()).toBe(200)
      const body = await res.json()
      const tabId: string = body?.data?.tabId
      expect(tabId).toBeTruthy()
      expect(body?.data?.terminalId).toBeTruthy()

      // The tab materializes (this part works)...
      const tabStrip = page.locator('[data-testid="tab-strip"]')
      await expect(tabStrip.getByText('badge-rest-tab', { exact: true })).toBeVisible({ timeout: 15_000 })
      const paneShell = page.locator(`[data-context="pane"][data-tab-id="${tabId}"]`)
      await expect(paneShell.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      // ...but the badge never appears: no meta record is ever seeded for a
      // REST-created terminal, so this is the assertion that fails today and
      // flips when the gap is closed.
      await expect(paneShell.getByText(BADGE_LABEL, { exact: true })).toBeVisible({ timeout: 20_000 })
    } finally {
      await server.stop().catch(() => {})
    }
  })
})
