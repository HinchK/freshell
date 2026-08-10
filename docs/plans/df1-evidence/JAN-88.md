# JAN-88 — Fix 3 novel a11y-gate violations in harness-06-misc-fixtures.spec.ts — df1 evidence

**Branch:** `df1/fix-h06-a11y` (base `origin/df1/integration` @ `5521f3aba`, the EXT-01 merge) · **Date:** 2026-08-09 · **Scope:** test-spec + evidence only — NO product code (`src/`, `server/`, `rust/`, `crates/` untouched); the gate, its baseline, and the HARNESS-11 helpers are all byte-untouched.

## Why

Gate batch B004 found `npm run test:e2e:a11y-gate:deny` exiting **1** with 3 novel selector
signatures — all inside `test/e2e-browser/specs/harness-06-misc-fixtures.spec.ts`, introduced by
HARNESS-06's own spec (the gate + `a11y-gate-baseline.json` are byte-untouched since B003, so these
were new violations the spec itself brought in).

Pre-edit red capture (`npm run test:e2e:a11y-gate:deny`, exit 1):

```
NOVEL violations (not in baseline): 3
  specs/harness-06-misc-fixtures.spec.ts -> locator:css-class:f32f1bbf
  specs/harness-06-misc-fixtures.spec.ts -> locator:css-class:f996e427
  specs/harness-06-misc-fixtures.spec.ts -> locator:css-class:f996e427
```

The 3 violation sites (all in the ws-echo test, `target server: ws echo round-trips text+binary …`):

| Line | Selector | Flag |
|---|---|---|
| L133:33 | `locator('#ws-log .ws-open')` | css-class |
| L139:33 | `locator('#ws-log .ws-message', …)` | css-class |
| L146:33 | `locator('#ws-log .ws-message', …)` | css-class |

## How fixed (per the gate's own conventions — HARNESS-11)

`a11y-selector-gate.ts` denies `.class` tokens as CSS implementation details and is *permitted
silently* on user-visible text (`text=` / `:has-text()` / `getByText`), `[data-*]` hooks, and ID
selectors (`#ws-log` alone was never flagged). Role/name helpers (`byRole` and friends) don't apply
here — the ws-page log entries are plain non-interactive text entries, not controls.

Fix: scope to the `#ws-log` ID hook, then locate **by user-visible text** with
`getByText(…, { exact: true })` — semantically stronger than the original assertions and zero false
positives (the log divs are the only text nodes on the fixture page):

- L133 `page.locator('#ws-log .ws-open')` + `toHaveText('open:freshell.test')` →
  `page.locator('#ws-log').getByText('open:freshell.test', { exact: true })` + `toBeVisible()`
  (same assertion: the open entry's full text is exactly that string).
- L139 `page.locator('#ws-log .ws-message', { hasText: 'text:hello-e2e ünï' })` →
  `page.locator('#ws-log').getByText('text:hello-e2e ünï', { exact: true })` + `toBeVisible()`.
- L146 ``page.locator('#ws-log .ws-message', { hasText: `bin:${binaryB64}` })`` →
  ``page.locator('#ws-log').getByText(`bin:${binaryB64}`, { exact: true })`` + `toBeVisible()`.

No `// a11y-gate: allow` directives needed (nothing here is an xterm/monaco-class widget root), no
fixture edits (`.ws-open`/`.ws-message` classes remain the fixture's own CSS, only the *locators*
were CSS-coupled), and the baseline was NOT edited.

## Verification runs (all in this worktree; pw runs under pw lease, `nice -n 19`)

| Command | Result |
|---|---|
| `npm run test:e2e:a11y-gate:deny` (pre-edit) | exit 1 — 3 novel signatures in this spec (capture above) |
| `npm run test:e2e:a11y-gate:deny` (post-edit) | **exit 0** — `deny: scan matches baseline — no novel violations, no stale entries.` |
| `npm run test:e2e:helpers` | **green** — 19 test files / 256 tests passed, exit 0 (184s wall under `nice -n 19` load) |
| `npx playwright test --config test/e2e-browser/playwright.config.ts harness-06-misc-fixtures.spec.ts --project=chromium --project=legacy-chromium --project=rust-chromium --reporter=line` (run 1) | **30 passed (20.1s)**, exit 0 |
| same (run 2) | **30 passed (21.7s)**, exit 0 |

Leases: `provision` (npm ci) and `pw` (both playwright runs) acquired and released via
`df1-control/scripts/acquire.sh`.
