# RESTORE-01 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the rust server's recover-my-panes offer stop hanging the unchanged legacy browser suite on rust legs — NOT by changing the product, but by adding ONE harness-level affordance that answers the offer exactly as an uninterested user would (fetch inventory → panel renders → click "Not now" through the real UI), so all 22 F1-affected rust legs run dialog-free with no per-spec dismissal dances.

**Verdict (with evidence — see docs/plans/df1-evidence/RESTORE-01.md):** **rust is correct; legacy is blind.** The panel is the DESIGNED D1/D2/D3 browser-loss recovery flow (`docs/plans/2026-07-26-recover-my-panes.md`), pinned by `recover-my-panes-rust.spec.ts` (3 scenarios incl. the over-offer/live-note trade-off) and promise P23. In e2e, a fresh Playwright context against the worker-shared rust server is indistinguishable from a real new browser connecting after the old one vanished: empty localStorage (D1), prior clients' snapshot generations survive the A15/A16 filters (server-stamped, seconds-old). Legacy is silent only because the feature does not exist there (`GET /api/recovery/inventory` 404s server-side — no route on legacy; SESSION-05 even calls this out as a documented KNOWN DIVERGENCE). The offered "junk" (picker panes, `Tab 1 (exit 0): shell`) comes from the **tabs-snapshot union** — the real layout records of the vanished client, which D5 deliberately restores wholesale (shells get recreated fresh, `restoreLayout` strips live-attach fields). Filtering picker/shell/exited panes out of the offer would gut the actual user feature (restoring shell layouts is its primary content) and still could not silence tests without deleting the offer itself. **Therefore: harness-level affordance, not a rust fix.**

**Architecture:** A single watcher installed per page by the SHARED e2e harness. It listens for the `/api/recovery/inventory` response (fires once per mount, seconds before specs start interacting); if the body says `recoverable: true` it waits for the panel, clicks `data-testid="recovery-decline"` (the real button — exercising the real dismissal path), and waits for detach. The harness is thus just a fast, deterministic user. Zero product-code changes on ANY code path (rust crates, client src, legacy server all untouched); zero changes on legacy legs (watcher is gated to `e2eServerKind === 'rust'`, and is a documented no-op elsewhere anyway since the fetch 404s).

**Tech Stack:** Playwright 1.52 test fixtures, TypeScript, Vitest (helper unit tests via `test/e2e-browser/vitest.config.ts`), gate01 slice runner for rust/legacy legs.

## Global Constraints

- Worktree `/home/dan/code/freshell/.worktrees/df1-restore-01-panel-inert`, branch `df1/restore-01-panel-inert`, base `origin/df1/integration`.
- NO product behavior change: no `crates/`, no `src/`, no `server/` edits.
- Legacy legs must behave bit-identically (watcher gated to rust server kind).
- Specs that TEST the panel (`recover-my-panes-rust`, `sidebar-registry-sync-rust`, `restore-contract-wall-rust`) must keep full ownership of panel interactions (opt out of automation explicitly).
- No per-spec dismissal dances (the SESSION-05 `bootFreshPage` dance in `project-colors-matrix.spec.ts` is REMOVED in favor of the shared affordance).
- Leases: own pw runs only with the pw lease (`DF1_HOLDER=df1-restore-01-panel-inert`); cargo lease for builds; NO `npm test|check|verify`, no un-coordinated runs. Dist builds happen inside Playwright global-setup (automatic).
- `npx` for playwright/vitest invocations must run from `test/e2e-browser` or repo root as each command specifies.
- The rust binary is prebuilt at `$PWD/target/release/freshell-server` and passed via `FRESHELL_E2E_RUST_SERVER_BIN` (skip per-worker cargo builds).

## File Structure

| File | Responsibility |
|---|---|
| `test/e2e-browser/helpers/recovery-offer.ts` (create) | Pure decision predicate + per-page/context auto-decline installer |
| `test/e2e-browser/helpers/recovery-offer.test.ts` (create) | Vitest unit tests (decision predicate + watcher wiring with a fake Page) |
| `test/e2e-browser/helpers/fixtures.ts` (modify) | `recoveryOfferHandling` test option (default `auto-decline`) + override of built-in `context` fixture to install the watcher on rust legs |
| `test/e2e-browser/specs/multi-client.spec.ts` (modify) | Adopt shared installer in ONE local `newClientContext` helper (7 `browser.newContext()` sites collapse to it) |
| `test/e2e-browser/specs/tabs-client-retire.spec.ts` (modify) | Adopt installer inside `newDevicePage` (one place) |
| `test/e2e-browser/specs/project-colors-matrix.spec.ts` (modify) | REMOVE the SESSION-05 per-spec dance; adopt installer for its manual `contextB` |
| `test/e2e-browser/specs/sidebar-registry-sync-rust.spec.ts` (modify) | `test.use({ recoveryOfferHandling: 'manual' })` — it owns panel assertions incl. decline |
| `test/e2e-browser/specs/restore-contract-wall-rust.spec.ts` (modify) | `test.use({ recoveryOfferHandling: 'manual' })` — it asserts panel presence at boot |
| `test/e2e-browser/gate01-baseline.json` (modify, verification-time) | Sampled legs re-run green get merged; stale `gap-unscoped` F1 attributions on THOSE legs removed with notes in evidence doc |

`test/e2e-browser/specs/recover-my-panes-rust.spec.ts` needs NO opt-out: its tests consume only `{ browser }` and build contexts manually — the `context`/`page` fixture chain never instantiates for it, so the watcher never attaches. (Verified: every `test(...async ({` destructure in that file lists only `browser`/`e2eServerKind`.)

## TDD protocol for a harness change

RED = the F1 signature reproduced on pristine code; GREEN = same legs green post-change with NO spec-local dismissal and assertions unweakened. Helper unit tests are ordinary vitest RED→GREEN. The RED e2e runs MUST execute before any harness/spec edit lands (pristine head `5521f3aba`).

---

### Task 1: Watcher helper + unit tests

**Files:**
- Create: `test/e2e-browser/helpers/recovery-offer.ts`
- Test: `test/e2e-browser/helpers/recovery-offer.test.ts`

**Interfaces:**
- Produces:
  - `export function shouldAnswerRecoveryOffer(probe: { url: string; ok: boolean; body: unknown }): boolean`
  - `export function installRecoveryOfferAutoDecline(page: Page): void`
  - `export function installRecoveryOfferAutoDeclineOnContext(context: BrowserContext): void`
  - `export const RECOVERY_PANEL_TESTID = 'recovery-offer-panel'`, `export const RECOVERY_DECLINE_TESTID = 'recovery-decline'`
- Consumed by: `fixtures.ts` (context override) and the adopting specs' local helpers.

- [ ] **Step 1: Write the failing unit tests** (`test/e2e-browser/helpers/recovery-offer.test.ts`)

Cover, with a minimal fake Page (an EventEmitter-ish object recording listeners + a `getByTestId` factory returning recording locators):

1. `shouldAnswerRecoveryOffer`: true only when url contains `/api/recovery/inventory` AND `ok` AND `body.recoverable === true`; false for: other urls, `ok:false` (legacy 404), non-JSON body (null), `recoverable:false`, missing `recoverable`.
2. Listener registered for `response` events on install.
3. A matching non-ok response triggers NO decline (legacy).
4. A matching ok response with `recoverable:false` triggers NO decline.
5. A matching recoverable response declines: waits panel `visible`, clicks decline, waits `detached` — in that order (record the call sequence).
6. Response `.json()` rejection is swallowed (no unhandled rejection, no decline).
7. Decline-click rejection is swallowed (page mid-close) — future responses still processed chained (chain resilience).
8. `installRecoveryOfferAutoDeclineOnContext` attaches to future `page` events AND already-present `context.pages()`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:e2e:helpers -- recovery-offer`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement `test/e2e-browser/helpers/recovery-offer.ts`**

```ts
import type { BrowserContext, Page, Response } from '@playwright/test'

export const RECOVERY_PANEL_TESTID = 'recovery-offer-panel'
export const RECOVERY_DECLINE_TESTID = 'recovery-decline'
const INVENTORY_URL_MARKER = '/api/recovery/inventory'
const PANEL_VISIBLE_TIMEOUT_MS = 30_000 // f3wp: panel can render >10 s after the response under load
const PANEL_DETACH_TIMEOUT_MS = 10_000

/** Pure: should the harness answer this inventory response with a decline? */
export function shouldAnswerRecoveryOffer(probe: {
  url: string
  ok: boolean
  body: unknown
}): boolean {
  if (!probe.url.includes(INVENTORY_URL_MARKER)) return false
  if (!probe.ok) return false // legacy 404s the route — nothing to answer
  const body = probe.body as { recoverable?: unknown } | null
  return body?.recoverable === true
}

const declineChains = new WeakMap<Page, Promise<void>>()

async function answerOffer(page: Page): Promise<void> {
  const panel = page.getByTestId(RECOVERY_PANEL_TESTID)
  await panel.waitFor({ state: 'visible', timeout: PANEL_VISIBLE_TIMEOUT_MS })
  console.log('[recovery-auto-decline] recovery offer made; harness clicking "Not now"')
  await page.getByTestId(RECOVERY_DECLINE_TESTID).click()
  await panel.waitFor({ state: 'detached', timeout: PANEL_DETACH_TIMEOUT_MS })
}

function onInventoryResponse(page: Page, response: Response): void {
  if (!response.url().includes(INVENTORY_URL_MARKER)) return
  const previous = declineChains.get(page) ?? Promise.resolve()
  const next = previous
    .then(async () => {
      const body = response.ok() ? await response.json().catch(() => null) : null
      if (!shouldAnswerRecoveryOffer({ url: response.url(), ok: response.ok(), body })) return
      await answerOffer(page)
    })
    .catch((err) => {
      // The watcher must NEVER fail a test: a page closing mid-decline, a
      // body evicted from the cache, a click racing detach are all benign.
      console.log(`[recovery-auto-decline] non-fatal decline failure: ${String(err)}`)
    })
  declineChains.set(page, next)
}

/**
 * Watch a single page: when the rust server offers pane recovery, answer
 * with the real "Not now" button (the real dismissal path — no product
 * bypass). Best-effort: never throws into the test.
 */
export function installRecoveryOfferAutoDecline(page: Page): void {
  page.on('response', (response) => onInventoryResponse(page, response))
}

/** Watch every page of a context (existing and future). */
export function installRecoveryOfferAutoDeclineOnContext(context: BrowserContext): void {
  context.on('page', (page) => installRecoveryOfferAutoDecline(page))
  for (const page of context.pages()) installRecoveryOfferAutoDecline(page)
}
```

(Full rationale doc-block at top of the real file: the verdict + why harness-not-product, citing `docs/plans/2026-07-26-recover-my-panes.md` D1/D2/D3 and the SESSION-05/sidebar-registry idioms.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:e2e:helpers -- recovery-offer`
Expected: PASS all new tests; existing helper suites untouched.

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit -p test/e2e-browser/tsconfig.browser01-check.json` only if that config includes helpers (verify; otherwise the repo's `npm run typecheck` equivalent for the e2e dir — find in package.json: there is no separate e2e tsc script; the playwright run itself compiles via ts-node; gate on `npm run test:e2e:helpers` + playwright compile).
Then: `git add test/e2e-browser/helpers/recovery-offer.ts test/e2e-browser/helpers/recovery-offer.test.ts && git commit -m "df1(RESTORE-01): recovery-offer auto-decline watcher + unit tests"`

### Task 2: Fixtures integration (option + context override)

**Files:**
- Modify: `test/e2e-browser/helpers/fixtures.ts`

**Interfaces:**
- Consumes: Task 1's `installRecoveryOfferAutoDeclineOnContext`.
- Produces: test option `recoveryOfferHandling: 'auto-decline' | 'manual'` (default `'auto-decline'`), settable via `test.use`.

- [ ] **Step 1: Write the failing integration test**

There is no vitest harness for Playwright fixture wiring; the RED/GREEN for this task is the sampled rust-leg lifecycle (Task 0 RED already captured on pristine code; Task 4 GREEN re-runs). Add one more unit assertion instead via the fake page: none needed — the pieces are unit-tested in Task 1, the wiring is validated end-to-end by the legs. (Documented choice, recorded in evidence.)

- [ ] **Step 2: Implement fixtures.ts changes**

In the `base.extend<...>` generic's first type param add `recoveryOfferHandling: 'auto-decline' | 'manual'`. In the fixture object add:

```ts
// RESTORE-01 — rust's recover-my-panes offer is DESIGNED behavior (see
// recovery-offer.ts). On rust legs the harness answers it like a user:
// click "Not now". 'manual' opts out for specs that own panel assertions.
recoveryOfferHandling: ['auto-decline', { option: true }],

context: async ({ context, e2eServerKind, recoveryOfferHandling }, use) => {
  if (e2eServerKind === 'rust' && recoveryOfferHandling === 'auto-decline') {
    installRecoveryOfferAutoDeclineOnContext(context)
  }
  await use(context)
},
```

with `import { installRecoveryOfferAutoDeclineOnContext } from './recovery-offer.js'`.

- [ ] **Step 3: Sanity-check compilation**

Run a trivial rust-leg of a tiny F1 spec file (harness-02 is the cheap gate spec — but it uses fixtures' test? verify; else use `editor-pane.spec.ts -g <one test>`) and confirm green. This is the first GREEN signal for the wiring, done under the pw lease. Details in Task 4.

- [ ] **Step 4: Commit**

`git add test/e2e-browser/helpers/fixtures.ts && git commit -m "df1(RESTORE-01): fixtures — rust legs auto-decline the recovery offer via shared watcher"`

### Task 3: Spec adoptions (collapse dances, opt-outs)

**Files:**
- Modify: `test/e2e-browser/specs/multi-client.spec.ts`
- Modify: `test/e2e-browser/specs/tabs-client-retire.spec.ts`
- Modify: `test/e2e-browser/specs/project-colors-matrix.spec.ts`
- Modify: `test/e2e-browser/specs/sidebar-registry-sync-rust.spec.ts`
- Modify: `test/e2e-browser/specs/restore-contract-wall-rust.spec.ts`

- [ ] **Step 1: multi-client** — add local helper `newClientContext(browser)` = `browser.newContext()` + `installRecoveryOfferAutoDeclineOnContext(context)`; replace all 7 `await browser.newContext()` sites. Import `Browser, BrowserContext` types if absent.

- [ ] **Step 2: tabs-client-retire** — inside `newDevicePage`, call `installRecoveryOfferAutoDeclineOnContext(context)` right after `browser.newContext()`.

- [ ] **Step 3: project-colors-matrix** — DELETE `declineRecoveryOfferIfMade` and the inventory response-waiter inside `bootFreshPage` (collapse it to the plain boot), let the default page ride the fixture watcher, and add `installRecoveryOfferAutoDeclineOnContext(contextB)` at the `browser.newContext()` site (:225). Remove unused `Response` import. Leave a comment pointing at RESTORE-01/replacing SESSION-05 fix2.

- [ ] **Step 4: opt-outs** — add `test.use({ recoveryOfferHandling: 'manual' })` at file top-level to `sidebar-registry-sync-rust.spec.ts` and `restore-contract-wall-rust.spec.ts` (both use the default `page` fixture AND own panel assertions; their existing idioms stay authoritative).

- [ ] **Step 5: Verify compile of edited specs + commit**

Run: harness-02 quick leg (Task 4 will cover these files). Commit:
`git add test/e2e-browser/specs/{multi-client,tabs-client-retire,project-colors-matrix,sidebar-registry-sync-rust,restore-contract-wall-rust}.spec.ts && git commit -m "df1(RESTORE-01): specs adopt shared recovery auto-decline; panel-owning specs opt out"`

### Task 4: E2E verification matrix (the item's self-verify bar)

All pw runs under the pw lease; DF1_HOLDER=df1-restore-01-panel-inert. `FRESHELL_E2E_RUST_SERVER_BIN=$PWD/target/release/freshell-server`.

- [ ] **Step 1 (RED, pristine head 5521f3aba, BEFORE any code edit):** rust-only reproof of 3 sampled legs:
  `FRESHELL_E2E_RUST_SERVER_BIN=$PWD/target/release/freshell-server GATE01_PROJECTS=gate01-rust GATE01_WORKERS=2 DF1_HOLDER=df1-restore-01-panel-inert test/e2e-browser/gate01-run-slice.sh restore01-red editor-pane.spec.ts settings.spec.ts terminal-lifecycle.spec.ts`
  Expected: ≥1 rust leg red with the F1 signature (dialog in error context). Verify a red test's `test-results/**/error-context.md` or the merged failures contain the Restore dialog trace before proceeding.

- [ ] **Step 2 (GREEN, post-implementation): sampled legs.** Sample (≥4, spanning signatures): `editor-pane.spec.ts` (waitForTerminal flavor), `settings.spec.ts` (click-intercept flavor), `tab-management.spec.ts` (5/5 dialog), `multi-client.spec.ts` (manual-context flavor), `terminal-lifecycle.spec.ts` (13-test whack-a-mole). Run rust legs TWICE consecutively (whack-a-mole killer):
  `... GATE01_PROJECTS=gate01-rust test/e2e-browser/gate01-run-slice.sh restore01-green-rust-1 <5 specs>` then `restore01-green-rust-2`.
  Expected: all 5 rust legs green BOTH runs (10/10 tallies; counters merged into baseline).

- [ ] **Step 3: legacy legs of the sample stay green:**
  `... GATE01_PROJECTS=gate01-legacy test/e2e-browser/gate01-run-slice.sh restore01-green-legacy <5 sample specs>`
  Expected: pass (tabs-client-retire is NOT in the sample — its legacy leg has a documented preexisting red).

- [ ] **Step 4: panel-owning specs still fully exercise the panel:**
  - `FRESHELL_E2E_RUST_SERVER_BIN=... npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium recover-my-panes-rust.spec.ts` — 3/3 green.
  - `--project=rust-chromium sidebar-registry-sync-rust.spec.ts` — green (opt-out honored; its decline idiom intact).
  - project-colors-matrix both legs: `GATE01_PROJECTS=gate01-legacy,gate01-rust ... gate01-run-slice.sh restore01-colors project-colors-matrix.spec.ts` — green, dance removed.
  (The first two runs use the main config: acquire pw lease manually around them.)

- [ ] **Step 5: harness-regression sanity:** `... test/e2e-browser/gate01-run-slice.sh restore01-harness harness-02-matrix-bite.spec.ts harness-03-provider-fixtures.spec.ts` (both legs) — proves the shared fixture change didn't perturb the harness bucket. (GATE-01's baseline names harness-01..06, 11, 14 pass/pass; the dispatch's extra harness-regression requirement applies only to a rust-side fix, but the shared-fixtures touch justifies this cheap proof.)

- [ ] **Step 6: baseline bookkeeping.** For each sampled leg verified green (both runs), merge happens via the slice script; then REMOVE the stale `attribution` on those legs (JSON edit — the collator has no un-attribute CLI and `gap-unscoped` attribution force-pins verdict to `fail`) and record each in the evidence doc. Do NOT touch the 17 un-rerun F1 legs' attributions.

- [ ] **Step 7: fmt/clippy/typecheck + helper tests + commit**
  - `cargo fmt --all -- --check` (no rust edits — expect clean)
  - `cargo clippy --workspace --all-targets -- -D warnings` is heavy; scoped: no rust files changed → record "no-op by diff" + spot-run `cargo clippy -p freshell-server --all-targets -- -D warnings` on the untouched tree only if cheap; else skip with recorded rationale.
  - `npm run lint` on edited files? Repo lint is full-tree; use `npx eslint test/e2e-browser/helpers/recovery-offer.ts test/e2e-browser/helpers/fixtures.ts <edited specs>`.
  - `npm run test:e2e:helpers` (full helper suite, incl. gate01-collate tests).
  - Final commit + evidence doc.

## Self-review notes

- Spec coverage: verdict decision ✓ (Task 0-1), harness affordance ✓ (Tasks 1-2), manual-context coverage ✓ (multi-client/tabs-client-retire adoption), panel-owning specs unaffected ✓ (opt-outs + recover-my-panes verified untouched), sample ≥4 ✓, legacy green ✓, no per-spec dances ✓ (project-colors dance removed).
- Whack-a-mole: two consecutive green runs of the sample + biggest offender (terminal-lifecycle, 13 tests).
- Residual risk (recorded): 3 self-extending specs (`rest-tab-persistence`, `agent-continuity-matrix`, `harness-04-session-corpus`) extend `base` NOT `fixtures.test`, so they don't consume the watcher; all were gate-green and none boot through paths F1 hit; future float into them would surface in the campaign's full re-gate and gets the same one-line adoption.
