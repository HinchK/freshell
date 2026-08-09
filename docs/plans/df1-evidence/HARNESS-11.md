# HARNESS-11 — Make accessibility selectors a gate — df1 evidence

**Branch:** `df1/harness-11-a11y-gate` (base `origin/df1/integration` @ `4edd8d10e`) · **Date:** 2026-08-09 · **Scope:** test-infrastructure only — NO product code (`src/`, `server/`, `crates/` untouched by this item).

**Item (verbatim):** *Make accessibility selectors a gate. Add reusable helpers/lint assertions requiring stable roles and accessible names; feature tests must not rely on CSS implementation details.*

**Playwright validation (checklist):** *A helper self-test uses only roles/labels/keyboard on existing main UI controls and deliberately fails on an inaccessible fixture control.*

## What landed

| Piece | File | Role |
|---|---|---|
| Runtime helpers | `test/e2e-browser/helpers/accessible-interactions.ts` | `byRole`/`byLabel`/`byTitle` (name REQUIRED — empty name throws synchronously), `expectAccessible(locator, {role, name})` over Playwright 1.58's native `toHaveRole`/`toHaveAccessibleName`, `focusByKeyboard` (Tab from document top), `ariaNamePattern` exact-match escaper, shared `SELECTOR_ENGINE_GUIDANCE`. |
| Static gate core | `test/e2e-browser/helpers/a11y-selector-gate.ts` | TypeScript-AST scan of `locator`/`frameLocator` string args; deny-set: `.class`, `xpath=`, `..`, `:nth-child`-family, `>` combinators; silent on `[data-*]`, `[aria-label=]`/`[title=]`, `text=`, `:has-text()`, `:visible`; widget-root exemptions `.xterm`, `.monaco-editor`; `// a11y-gate: allow -- <reason≥8ch>` directive (reasonless directive = own violation, suppresses nothing); warn-turn-deny ratchet vs a committed baseline (`signatureOf` is line-independent). **Fail-closed**: deny + missing baseline = every violation novel. |
| CLI | `test/e2e-browser/helpers/a11y-selector-gate-cli.ts` | `--warn` (default, exit 0) / `--deny` / `--write-baseline` / `--json`. Pure static — no server, no browser, no pw/cargo lease. npm scripts: `test:e2e:a11y-gate`, `test:e2e:a11y-gate:deny`. |
| Baseline | `test/e2e-browser/a11y-gate-baseline.json` | 23 violation signatures across 8 files (see below). The ratchet floor. |
| Probes (committed) | `test/e2e-browser/fixtures/a11y-gate/css-dependent.bad.ts`, `role-name.good.ts` | The red/green bite demonstration, scanned by both the vitest suite and leg C of the pw self-test. `fixtures/` is excluded from the tree scan; probes are never executed. |
| Unit tests | `helpers/accessible-interactions.unit.test.ts` (12), `helpers/a11y-selector-gate.test.ts` (38) | Run by the EXISTING `npm run test:e2e:helpers` config (`include: helpers/**/*.test.ts`) — zero config churn. |
| Playwright self-test | `test/e2e-browser/specs/harness-11-a11y-gate.spec.ts` | Auto-matched by the default `chromium` project — zero `playwright.config.ts` edits (important: six sibling workers concurrently edit that file). |
| Plan | `docs/plans/df1/HARNESS-11.md` | Includes the design-decision record and the validated load-bearing audit table. |

## Design decision (recorded per dispatch)

Rejected custom-ESLint-rule route: the repo's flat `eslint.config.js` lints only `src/**` (`"lint": "eslint src --ext ..."`); the e2e tree has never been linted and no plugin provides a "prefer role locator" rule. Chosen instead (most idiomatic to THIS repo's e2e layout): **shared locator-helper + repo-owned spec-lint script+CLI sharing one policy module**, exactly how the harness already encodes its other conventions (`helpers/`, the `test:e2e:helpers` vitest lane, `tsx` scripts). The static half uses the TypeScript compiler API (already a devDependency), so selector-shaped strings inside comments cannot false-positive — proven by a dedicated unit test.

## The gate BITES (red/green demonstrations, verbatim)

**Unit level (committed fixtures read from disk):** `a11y-selector-gate.test.ts` — bad probe → exactly 6 violations with codes `[structural-combinator, css-class, xpath, parent-traversal, structural-pseudo, css-class]`; good probe → `[]`. 38/38 tests pass (`31ms` of test execution).

**CLI level (real tree, observed):**

```
### deny with NO baseline -> fail-closed, exit 1
a11y selector gate (deny): 23 violations across 8 file(s) [css-class:14, xpath:1, structural-combinator:3, parent-traversal:5]
NO BASELINE FILE — fail-closed: every violation below is treated as novel. Create one deliberately with --write-baseline.
NOVEL violations (not in baseline): 23                          exit=1

### --write-baseline, then deny -> clean, exit 0
baseline rewritten at test/e2e-browser/a11y-gate-baseline.json: 0 -> 23 violation signature(s)
deny: scan matches baseline — no novel violations, no stale entries.   exit=0

### temporary spec with page.locator('.definitely-not-a-real-stable-selector') -> gate BITES
  specs/zz-h11-gate-bite-demo.spec.ts -> locator:css-class:8b836a7b
NOVEL violations (not in baseline): 1                          exit=1
(file deleted) -> deny: scan matches baseline                  exit=0
```

**Playwright level (`--project=chromium`, pw lease, green x2: 33.8s / 38.8s):**
- Leg A (green): real main UI via roles/names/keyboard ONLY — `Hide sidebar` asserted role+name, reached by Tab from document top, activated with Enter → sidebar collapses → `Show sidebar` asserted → restored; `New shell tab` asserted. Zero raw CSS selectors in the spec.
- Leg B (red, captured): deliberately inaccessible `<div class="btn btn-primary shiny-gradient" onclick>Deploy build</div>` located gate-cleanly via `getByText` → `expectAccessible({role:'button'})` REJECTS (`toHaveRole`), `focusByKeyboard` REJECTS ("never received keyboard focus"), `byRole(page,'button','')` throws synchronously. All three deliberate failures captured with `rejects.toThrow`, so the suite is green only because the gate fires.
- Leg C (static bite): in-spec `scanSource` over the committed probe pair — 6 expected codes on bad, `[]` on good.

## Baseline report (warn-turn-deny; NOT mass-rewritten)

**23 violations across 8 files** (after the documented `.xterm`/`.monaco-editor` widget-root exemptions absorb ~210 terminal/editor-canvas uses):

| Code | Count |
|---|---|
| `css-class` | 14 |
| `parent-traversal` | 5 |
| `structural-combinator` | 3 |
| `xpath` | 1 |

Files: `specs/fresh-agent.spec.ts` (9, all `.fresh-agent-*` component classes) · `specs/settings.spec.ts` (5, all `locator('..')`) · `specs/multirow-tabs.spec.ts` (3, `:scope > div`) · `specs/freshopencode-model-picker.spec.ts` (2, `.font-medium` + `xpath=..`) · `specs/project-colors-matrix.spec.ts` (1, `div.h-3.w-3`) · `specs/restore-contract-wall-rust.spec.ts` (1, `[role="alert"]:not(.monaco-alert)`) · `specs/restore-matrix.spec.ts` (1, `.pane-header-fresh-agent-identity`) · `specs/sidebar.spec.ts` (1, `.overflow-x-auto`).

**Warn-turn-deny convention (the campaign roll-up):** default `npm run test:e2e:a11y-gate` warns and exits 0 over the committed baseline. Enforcement is one word away: `npm run test:e2e:a11y-gate:deny` exits 1 on (a) any NOVEL violation — the gate biting new/changed spec work — and (b) any STALE baseline entry — a fixed violation, forcing a ratchet-down `--write-baseline` commit. Campaign flip recommendation: add `test:e2e:a11y-gate:deny` (and later the vitest lane already covers policy) to the coordinated e2e pipeline once `df1/integration` settles; touching an 8-file baseline entry is deliberately the fixer's job (`--write-baseline` after fixing), never a mass rewrite. New code with a genuinely non-accessible target documents itself inline: `// a11y-gate: allow -- <reason>` on the call line (reasonless directives are violations and suppress nothing).

## Product observations (findings, NOT fixes — out of item scope)

1. **xterm.js captures Tab.** The terminal helper textarea holds focus and consumes every Tab (correct terminal semantics). A keyboard-only user cannot Tab from a focused terminal to page chrome (Freshell's documented Ctrl+B shortcuts are the escape hatch). `focusByKeyboard` therefore starts tab order from the DOCUMENT TOP (blur-first), which is the canonical keyboard-operability contract. Whether page chrome needs a primer shortcut cycle is GATE-07 territory.
2. `[role="alert"]:not(.monaco-alert)` (`restore-contract-wall-rust.spec.ts:1796`) is baselined as a technically-true positive (relies on the `.monaco-alert` class) that is semantically reasonable — the allow-directive/baseline path exists for exactly this.

## Load-bearing audit

Nine assumptions enumerated pre-implementation in `docs/plans/df1/HARNESS-11.md` (table); eight verified by inspection/probe before coding (Playwright 1.58 matcher availability incl. `page.accessibility` removal, tab-order capture risk was *missed* pre-implementation but caught RED by TDD leg A and fixed in the helper with a passing regression leg), the ninth (`toHaveRole`/`toHaveAccessibleName` failure semantics on inaccessible controls) proven during TDD by leg B's captured rejections. One real defect found by the audit-driven RED runs: deny mode initially failed OPEN with a missing baseline file — fixed fail-closed with regression tests (`deny mode FAILS CLOSED when no baseline file exists`).

## Review loop

Dispatch asked for a fresh review subagent via the Task tool; this runtime exposes no Task/subagent tool, so the recorded fallback was used: a structured fresh-eyes self-review against `review-agent`'s checklist read as code (see below), plus two *independent runtime verifications* standing in for a second pair of eyes: (1) the CLI byte-level outputs re-generated and diffed against this evidence; (2) the full `test:e2e:helpers` suite (6 files / 81 tests) green — cross-file regression proof. Findings from the self-review round: fail-closed baseline bug (fixed, tested), `evaluateScan` API returning file-prefixed vs bare signatures (normalized to bare, tested), dead escape-branch in `blankAttributeValues` (removed), tsc excess-property error in the ratchet test (fixed). No serious findings remain.

**Review-rubric pass (recorded):** scope discipline (test-infra only, zero `playwright.config.ts`/shared-helper edits; package.json gained exactly 2 additive script lines); determinism (no real clocks/sleeps; gate is pure AST; pw legs use auto-retrying assertions); security/eval surface (no `eval`, no new deps, baseline JSON validated with version check); escape-hatch hygiene (directives require auditable reasons); docs parity (plan, module docs, this evidence agree; root `AGENTS.md` a11y section untouched — the gate ENFORCES it for tests, it does not amend it).

## GREEN COMMANDS (verbatim, from this worktree)

- `nice -n 19 npm run test:e2e:helpers` — 6 files / 81 tests pass (includes both HARNESS-11 vitest files).
- `npm run test:e2e:a11y-gate` — warn report over real tree, exit 0.
- `npm run test:e2e:a11y-gate:deny` — exit 0 vs committed baseline (proven to exit 1 on novel violations).
- `nice -n 19 npx playwright test --config test/e2e-browser/playwright.config.ts --project=chromium "harness-11-a11y-gate.spec.ts"` — 3 passed, x2 (33.8s / 38.8s), under pw lease.
- `npx tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext --skipLibCheck --types node <the five new .ts files>` — clean.
