# HARNESS-11 — Make accessibility selectors a gate

> **For agentic workers:** df1 swarm worker document. TDD red-green-refactor per task; commit at every task boundary. Playwright posture for this item is **self-verify**: the gate's bite is proven at both the vitest level (committed probe fixtures) and the Playwright level (helper self-test against real main UI + deliberately-inaccessible fixture control).

**Item (verbatim):** *Make accessibility selectors a gate. Add reusable helpers/lint assertions requiring stable roles and accessible names; feature tests must not rely on CSS implementation details.*

**Playwright validation text (checklist):** *A helper self-test uses only roles/labels/keyboard on existing main UI controls and deliberately fails on an inaccessible fixture control. Full wizard/chooser/settings coverage belongs to `GATE-07` after those features exist.*

**Goal:** A reusable accessibility-selector contract for `test/e2e-browser/`: (1) runtime helper functions that only expose role/label/keyboard interactions and hard-fail on inaccessible controls, and (2) a static gate that scans spec sources and denies CSS-implementation-detail selectors (class names, structural combinators, xpath, DOM traversal), with a warn-turn-deny ratchet so the 96-spec baseline is reported, not mass-rewritten.

**Tech Stack:** Playwright 1.58 (`expect(locator).toHaveRole` / `.toHaveAccessibleName()` — both verified present in `node_modules/playwright/types/test.d.ts:9006,9207`; `page.accessibility` is REMOVED in 1.58 and must not be used), TypeScript compiler API (typescript 5.7 in devDependencies) for the AST-accurate static scan, vitest via the existing `test:e2e:helpers` config (`include: ['helpers/**/*.test.ts']` — new test files are picked up with zero config churn), tsx for the CLI.

## Design decision (recorded per dispatch)

Options weighed: **(a) custom ESLint rule** — rejected: the repo's flat `eslint.config.js` lints only `src/**` (`"lint": "eslint src --ext ..."`); e2e specs have never been linted, no `eslint-plugin-playwright` is installed, and ESLint has no maintained plug-in rule for "prefer role locators" — a custom local rule would bolt a second lint pipeline onto a tree that has none. **(b) shared locator-helper + spec-lint script** — chosen: matches how the e2e harness already enforces its own conventions (repo-owned helpers under `test/e2e-browser/helpers/`, helper unit tests via the dedicated `test:e2e:helpers` vitest config, CLI scripts via `tsx`). **(c) both** — chosen meaning of "both" is the (b) pair: runtime helpers + static gate, sharing one forbidden-selector policy module. The static gate uses the TypeScript compiler API (already a devDependency) rather than regex, so strings in comments/docs can never false-positive.

**Warn-turn-deny convention (the roll-up this campaign can reuse):** the gate denies CSS *implementation details* — class tokens (outside a tiny documented third-party widget-root exemption list: `.xterm`, `.monaco-editor`), `xpath=`, `..` parent traversal, `:nth-child`/`:first-child`-style structural pseudo-classes, and `>` child combinators. It is **silent** on `[data-*]` hooks, `[aria-label=]`/`[title=]` attribute selectors, `text=`/`:has-text()` content selectors, and `:visible` state — none of those are CSS implementation details. Existing baseline violations are enumerated into a committed `a11y-gate-baseline.json` (file → violation signature list) by `--write-baseline`; the default mode is **warn** (scan, report, exit 0); `--deny` fails on any violation **not** in the baseline AND on any baseline entry whose violation disappeared (stale entries force the ratchet down via `--write-baseline`). Escape hatch for genuinely-exempt new code: a same-line or preceding-line comment `// a11y-gate: allow -- <reason>`; a reasonless/short-reason directive is itself a violation (`allow-without-reason`). No existing spec is rewritten.

## Load-bearing audit (validated 2026-08-09, before implementation)

| # | Assumption | Validation | Verdict |
|---|---|---|---|
| 1 | `expect(locator).toHaveRole(role)` and `toHaveAccessibleName(name)` exist in installed Playwright | grep `node_modules/playwright/types/test.d.ts` (1.58.2): `toHaveAccessibleName` :9006, `toHaveRole` :9207 | **VERIFIED** |
| 2 | `page.accessibility.snapshot()` must NOT be used | probe launch: `typeof page.accessibility === 'undefined'` (removed in 1.58) | **VERIFIED** (constraint) |
| 3 | Main UI exposes stable role+name controls for the self-test | `src/components/Sidebar.tsx:659` `aria-label="Hide sidebar"`; `src/components/TabBar.tsx:596/673` `"Show sidebar"`, `"New shell tab"`; picker buttons by name in `fixtures.ts:40` | **VERIFIED** |
| 4 | New specs run without touching `playwright.config.ts` | config read: `chromium` project has no `testMatch` (matches all of `testDir`) and only `testIgnore: RUST_ONLY_SPECS` — a new non-rust spec auto-runs there; six sibling workers concurrently edit that config, so zero edits avoids churn | **VERIFIED** |
| 5 | Helper unit tests run without config changes | `test/e2e-browser/vitest.config.ts` `include: ['helpers/**/*.test.ts']` | **VERIFIED** |
| 6 | Static scan via TypeScript compiler API is dependency-free | `typescript ^5.7.2`, `tsx ^4.19.2` in devDependencies | **VERIFIED** |
| 7 | Baseline is too large to mass-fix | survey: 439 `.locator(` calls across 73 specs; class-token selectors ~262, of which ~210 are the `.xterm` widget root (exempt) | **VERIFIED** → warn-turn-deny ratchet, not rewrite |
| 8 | `freshellPage` fixture boots legacy TestServer under default `chromium` | `fixtures.ts`: `e2eServerKind` defaults to `'legacy'`; `freshellPage` navigates `?token=...&e2e=1`, waits harness+WS, kills terminals after | **VERIFIED** |
| 9 | The red leg (inaccessible control) fails deterministically | `<div class="btn" onclick>` has computed role `generic`, no accessible name, is not keyboard-focusable — all three assertions (`toHaveRole`, `toHaveAccessibleName`, keyboard-focus loop) fail | hypothesis to be proven RED→asserted at TDD task 4/5 |

## Global constraints

- Sibling workers concurrently active in `test/e2e-browser/`: **additive-only shared edits**; this item creates only item-scoped files plus ONE additive line in `package.json` scripts.
- No `npm test`/`check`/`verify` (gate lease); scoped vitest only (`test:e2e:helpers`); Playwright only under pw lease (`acquire.sh pw ...`), `nice -n 19`.
- No edits to `src/`, `server/`, `crates/` — this is test-infrastructure only.
- `page.accessibility` (removed) must not be used.
- Server uses NodeNext/ESM; relative imports in test helpers follow existing convention (`./fixtures.js` style) — match the surrounding files.

## File structure

- Create: `test/e2e-browser/helpers/accessible-interactions.ts` — runtime role/label/keyboard helpers.
- Create: `test/e2e-browser/helpers/a11y-selector-gate.ts` — pure static-gate core (`scanSource`, `scanFiles`, `evaluateScan`, exemption/allow-directive policy).
- Create: `test/e2e-browser/helpers/a11y-selector-gate-cli.ts` — tsx CLI (`--deny`, `--write-baseline`, `--json`).
- Create: `test/e2e-browser/helpers/a11y-selector-gate.test.ts` — vitest unit tests (the committed red/green bite proof, incl. reading the probe fixtures below from disk).
- Create: `test/e2e-browser/fixtures/a11y-gate/css-dependent.bad.ts` — committed probe WITH violations (scan target; `fixtures/` is excluded from the normal tree scan).
- Create: `test/e2e-browser/fixtures/a11y-gate/role-name.good.ts` — committed probe WITHOUT violations.
- Create: `test/e2e-browser/a11y-gate-baseline.json` — generated by `--write-baseline` (committed; the ratchet floor).
- Create: `test/e2e-browser/specs/harness-11-a11y-gate.spec.ts` — Playwright helper self-test (auto-runs under `chromium`; zero config edits).
- Modify: `package.json` — add `"test:e2e:a11y-gate": "tsx test/e2e-browser/helpers/a11y-selector-gate-cli.ts"`.
- Evidence: `docs/plans/df1-evidence/HARNESS-11.md`.

### Task 1: Runtime helper core (role/label gating)

**Files:** create `test/e2e-browser/helpers/accessible-interactions.ts`; test `test/e2e-browser/helpers/accessible-interactions.unit.test.ts` (pure-node parts only — selector-string validation, no browser).

**Interfaces produced:**
- `byRole(scope: Page | Locator, role: AriaRole, name: string | RegExp, options?): Locator` — throws synchronously (programmer error, not flaky test) when `name` is a string shorter than 2 non-space chars. Thin wrapper over `scope.getByRole(role, { name, ...options })`.
- `byLabel(scope, text: string | RegExp)`: same empty-guard, over `getByLabel`.
- `byTitle(scope, text)`: same guard, over `getByTitle`.
- `expectAccessible(locator: Locator, expected: { role: AriaRole; name: string | RegExp }): Promise<void>` — asserts `toHaveRole(role)` then `toHaveAccessibleName(name)`; both args required (a control you cannot name is exactly what the gate exists to catch). This is the deliberate-failure surface for inaccessible controls.
- `focusByKeyboard(page: Page, locator: Locator, options?: { maxTabs?: number }): Promise<void>` — presses Tab (≤ `maxTabs`, default 60) until `document.activeElement` is the locator's element; throws with guidance-including diagnostic when focus never lands (a non-focusable `<div onclick>` is the canonical miss).
- `ariaNamePattern(name: string): RegExp` — exact-match RegExp escape helper for stable names (`^Hide sidebar$` style), keeping specs free of hand-rolled escapes.
- `SELECTOR_ENGINE_GUIDANCE: string` — the shared diagnostic sentence fragments ("Use getByRole with an accessible name ... see docs/plans/df1-evidence/HARNESS-11.md") reused by helper errors, the static gate, and the spec doc comments (DRY).

- [ ] Write failing unit test for: empty/too-short name guard throws with guidance; valid name passes through (mock minimal `getByRole` receiver).
- [ ] Implement; green; commit.

### Task 2: Static gate core

**Files:** create `test/e2e-browser/helpers/a11y-selector-gate.ts`; test `test/e2e-browser/helpers/a11y-selector-gate.test.ts`.

**Interfaces produced:**
- `type ViolationCode = 'css-class' | 'xpath' | 'parent-traversal' | 'structural-pseudo' | 'structural-combinator' | 'allow-without-reason'`
- `type Violation = { file: string; line: number; column: number; method: string; selector: string; code: ViolationCode; message: string }`
- `scanSource(sourceText: string, fileName: string): Violation[]` — TS-AST walk of `CallExpression`s whose callee property name ∈ `{locator, frameLocator, waitForSelector, click, dblclick, tap, hover, fill, press, check, uncheck, selectOption, setChecked, isVisible, isEnabled, isDisabled, isEditable, textContent, innerText, innerHTML, inputValue, getAttribute, dispatchEvent, $, $$}` AND whose first arg is a plain string literal or no-substitution template. Classifies via `classifySelector(selector): ViolationCode | null`. Suppression: `a11y-gate: allow -- <reason≥8 chars>` trailing the same line or alone on the immediately preceding line (`allow-without-reason` when absent/short). Exemption: every class token in the selector ∈ widget-root subtrees (`.xterm`, `.xterm-*`, `.monaco-editor`, `.monaco-editor-*`).
- `classifySelector` rules: strip quoted attribute values before tokenizing; violation iff selector (after `css=` engine prefix normalization) contains `xpath=`/`..`/`:nth-child(`/`:nth-of-type(`)/`:first-child`/`:last-child`/ bare `>` combinator (outside quotes/brackets) / a class token failing the exemption. `text=` engine, `:has-text()`, `:visible`, `[attr=...]` selectors pass silently.
- `signatureOf(v)` → `"<method>:<code>:<selector-sha1-8>"` (line excluded — stable across edits).
- `evaluateScan(violations: Violation[], baseline: Baseline | null, mode: 'warn' | 'deny'): { exitCode: 0|1; report: string; stale: string[]; novel: string[] }`.
- `readBaselineFile` / `writeBaselineFile`, `BASELINE_REL = 'a11y-gate-baseline.json'`.
- `SCAN_DIRS = ['specs', 'helpers', 'perf']`; skip `*.test.ts`, `fixtures/`, and the gate's own three files (self-exclusion documented: the gate file names are filtered).

- [ ] Failing vitest cases first (inline sources + the committed probe pair read from disk): bad probe yields the expected multi-code violation list; good probe yields `[]`; directive with reason suppresses exactly its line; reasonless directive yields `allow-without-reason`; `.xterm` / `.xterm .xterm-viewport` exempt while `.fresh-agent-layout` denies; `text=`,`:visible`,`[data-context=...]`,`button[title=...]` pass; selector string inside a `/* comment */` never flags (the AST-vs-regex proof); `evaluateScan` deny on novel signature → exitCode 1, stale-only delta → exitCode 1, clean-vs-baseline → 0.
- [ ] Implement; green; commit.

### Task 3: CLI + baseline generation + npm script

**Files:** create `test/e2e-browser/helpers/a11y-selector-gate-cli.ts`; create `test/e2e-browser/a11y-gate-baseline.json` (generated); modify `package.json` (one additive `test:e2e:a11y-gate` script line).

- [ ] CLI: default warn (human-readable grouped report + summary-by-code + `next steps` footer, exit 0); `--deny` (same report, exit 1 iff novel or stale vs baseline); `--write-baseline` (regenerate from current scan, print delta); `--json` (machine report). Deterministic ordering (file, line).
- [ ] Run warn-mode over the real tree (no pw needed); run `--write-baseline`; commit baseline + CLI + script.
- [ ] RED/GREEN bite demo at CLI level (recorded verbatim into evidence): `tsx ... --deny` on the real tree exits 1 (novel violations exist pre-baseline... post-baseline re-run exits 0); probe-only temp scan of `css-dependent.bad.ts` denies. (Full outputs → evidence file.)

### Task 4: Playwright helper self-test — green leg (roles/labels/keyboard on real UI)

**Files:** create `test/e2e-browser/specs/harness-11-a11y-gate.spec.ts` (auto-runs under `chromium` project only).

- [ ] Leg A: on `freshellPage`, using ONLY `byRole`/`expectAccessible`/`focusByKeyboard` + `page.keyboard`: assert "Hide sidebar" button has role button + accessible name; activate it via keyboard (Tab-focus + Enter); assert sidebar landmark hidden and "Show sidebar" button now present with role+name; assert "New shell tab" button accessible. No `.locator(`, no CSS, no testids in the spec itself.
- [ ] Run under pw lease `--project=chromium`; iterate to green (T9 of the audit: if `not.toHaveAccessibleName` semantics differ from expectation, adjust helper internals — helper contract stays).

### Task 5: Playwright helper self-test — red leg (inaccessible fixture control)

**Files:** same spec.

- [ ] Leg B: `page.setContent('<div class="btn btn-primary" onclick="...">Deploy</div>')`; assert `expectAccessible(rawLocator)` rejects with the guidance diagnostic; assert `focusByKeyboard` rejects ("never received keyboard focus"); assert `byRole(page, 'button', '')` throws synchronously. Each deliberate failure is captured via `await expect(...).rejects.toThrow(...)`/`expect(() => ...).toThrow(...)` so the suite is green while proving the gate fails hard.
- [ ] Leg C (cheap, in-spec static bite): import `scanSource`, scan the committed probe pair from disk; assert bad probe non-empty with expected codes and good probe clean.
- [ ] Commit per leg.

### Task 6: Verify, evidence, review

- [ ] Focused green x2: `npm run test:e2e:helpers` (gate + helper unit tests) and the pw spec (pw lease) each twice (flaky protocol); `npx tsc --noEmit` scope for the new files via the repo's typecheck path; `npm run lint` unchanged clean (src-only).
- [ ] Gate report at baseline committed → counts + file list into `docs/plans/df1-evidence/HARNESS-11.md` (JAN-87-style), incl. verbatim red/green outputs, the design decision, the warn-turn-deny convention text, and GREEN COMMANDS.
- [ ] Fresh-eyes review loop via Task subagent with review-agent skill (≤5 rounds); fix findings; record in evidence.
- [ ] `df1ctl.py update HARNESS-11` state=review, terminal=COMPLETED.
