# B005 WRAP batch — gate evidence

Gatekeeper: `df1-b005` · Integration branch: `df1/integration` (gate worktree `.worktrees/df1-gate`) · Tip at batch start: `36b7e09b4`

Items merged in order: JAN-88, RESTORE-01, SESSION-13, CFG-01. Each entry: freshness re-audit, rebase content check, verbatim green verification summaries, merge sha. Freshness note: the naive `git diff --stat 4c2297667..<branch>` includes the whole moved-integration delta (branches are based on `5521f3aba`+); the scope check is therefore done against each branch's merge-base with the integration tip (equals its declared base), plus `git range-diff` for rebase content preservation.

---

## JAN-88 — fix 3 novel a11y-gate violations in harness-06-misc-fixtures spec

- Branch: `df1/fix-h06-a11y` · attested head `ec53c451067f7361c90651f9eae27ecdbd190353`
- Freshness: `git rev-parse df1/fix-h06-a11y` = attested sha ✓. Merge-base with integration = declared base `5521f3aba` ✓. Own commits: exactly one (`df1(JAN-88): fix 3 novel a11y-gate violations…`) touching only `docs/plans/df1-evidence/JAN-88.md` + `test/e2e-browser/specs/harness-06-misc-fixtures.spec.ts` — in declared scope ✓. Spec test `target server: ws echo round-trips text+binary …` present (L125) with the `getByText` fixes at L135/141/148; remaining `ws-open`/`ws-message` matches are ledger event kinds, not CSS locators ✓.
- Rebase onto `36b7e09b4`: clean, no conflicts. New head `7147286fd5aaa89133c564c6a1645ea9ea655bce`. `git range-diff 5521f3aba..ec53c4510 36b7e09b4..7147286fd` → `1: ec53c4510 = 1: 7147286fd` (patch-identical); attested→new-head file list identical to the base-delta (`5521f3aba..36b7e09b4`) file list — zero conflict resolutions ✓.
- Verification (all in item worktree, `nice -n 19`; pw legs under `pw` lease `df1-b005`, released after):
  - `npm run test:e2e:a11y-gate:deny` → **exit 0**: `deny: scan matches baseline — no novel violations, no stale entries.`
  - `npx playwright test --config test/e2e-browser/playwright.config.ts harness-06-misc-fixtures.spec.ts --project=chromium` → **`10 passed (1.3m)`, exit 0**
  - `npm run test:e2e:helpers` → run 1 exit 1 with all tests green (`Test Files 19 passed (19)`, `Tests 256 passed (256)`) plus one vitest teardown-phase unhandled error; allowed flake-rerun: run 2 **exit 0, no error lines** (19 files / 256 tests).
  - `npm run typecheck` → **exit 0**
- **Merge: `41aae0e9e`** `df1(B005): JAN-88 fix 3 novel a11y-gate violations in harness-06-misc-fixtures spec` (merge via ort, spec+evidence only — 2 files, +68/−3)

---
