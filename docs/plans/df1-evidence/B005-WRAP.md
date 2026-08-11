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

## RESTORE-01 — recover-my-panes offer inert for e2e harness (auto-decline watcher)

- Branch: `df1/restore-01-panel-inert` · attested head `1e4f3162aa883a72f9c40242bfa6f517c3dd6ba4`
- Freshness: rev-parse = attested ✓. Merge-base with integration = declared base `5521f3aba` ✓. 5 own commits, diff confined to `docs/plans` + `test/e2e-browser` (zero product code) ✓. Branch tests remain: 13 `it(...)` in `test/e2e-browser/helpers/recovery-offer.test.ts`, `recover-my-panes-rust.spec.ts` scenarios 1–3, `tsconfig.restore01-check.json` ✓. Worktree carried uncommitted `gate01-baseline.json` collate bookkeeping (run-record appends matching the verifier's re-runs incl. the known 5p/1f multi-client divergence; head/sha stamp to attested sha; zero verdict/attribution flips — verified by diff inspection) — benign tool output, left uncommitted; stashed aside for the rebase and restored after.
- Rebase onto `aab9065ed`: clean, no conflicts. New head `5b8b563d53ada0d960aab125a0360cc893e6dc28`. `git range-diff 5521f3aba..1e4f3162 aab9065ed..5b8b563d5` → all 5 commits patch-identical (`=`); attested→new-head file list identical to base-delta file list ✓.
- Verification (item worktree, `nice -n 19`; pw legs under `pw` lease `df1-b005`, released after):
  - `FRESHELL_E2E_RUST_SERVER_BIN=$PWD/../../target/release/freshell-server npx playwright test --config playwright.config.ts --project=rust-chromium recover-my-panes-rust.spec.ts` (from `test/e2e-browser`) → **`3 passed (2.1m)`, exit 0** — offer accept/decline/D7 scenarios pin the panel itself.
  - `npm run test:e2e:helpers` → **`Test Files 20 passed (20)`, `Tests 269 passed (269)`, exit 0** (includes the 13 recovery-offer unit tests).
  - `npx tsc -p test/e2e-browser/tsconfig.restore01-check.json` → exit 2; per the config's own contract ("zero error lines attributable to the files RESTORE-01 created or edited"), ALL errors are the declared base-reproducible noise: 2× TS2459 `TestServerInfo` in the two rust-only specs (named in evidence) + TS2339/TS2304 in `src/lib/client-logger.ts`, `src/lib/perf-logger.ts`, `src/store/settingsSlice.ts` — pre-existing dependency files byte-identical to base (RESTORE-01 touches no `src/`). **Zero item-attributable errors.**
  - `npm run typecheck` → **exit 0**
- KNOWN divergence noted (not failed for): rust reconnect attach multiplicity on `multi-client.spec.ts` "reconnecting second viewer…" (3 reconnect-shaped `terminal.attach` vs bound ≤2; probe-proofed watcher-independent per item evidence; candidate owner: reconcile lane). Also handed off: sidebar-registry-sync-rust case-c pre-existing red at base.
- **Merge: `d375ae565`** `df1(B005): RESTORE-01 recover-my-panes offer inert for e2e harness (auto-decline watcher)` (ort, 12 files, +1264/−268)

---

## SESSION-13 — legacy-parity PATCH write path for sidebar first-chat exclusions

- Branch: `df1/session-13-first-chat-exclusions` · attested head `0124d2dad332d475ff2a86d757a85f610620fff2`
- Freshness: rev-parse = attested ✓. Merge-base with integration = declared base `5521f3aba` ✓. 3 own commits; diff = `crates/freshell-server/src/{settings_store.rs, session_directory.rs}` + `docs/plans` + `playwright.config.ts` + the item spec + `sidebarSelectors.visibility.test.ts` — in declared scope ✓. Worktree clean at attested head ¶ Item tests remain (spec + unit selector test + 73 settings-scoped crate tests).
- Rebase onto `8a14230ed`: base delta also touched `settings_store.rs` (project_color rollback, 3 hunks) but disjoint from SESSION-13's PATCH-write-path hunks → **no conflicts**. New head `57bbd0db805c2e1379f2fa210069f0f791e6ec63`. `git range-diff 5521f3aba..0124d2dad 8a14230ed..57bbd0db8` → all 3 commits patch-identical (`=`); attested→new-head file list identical to base-delta list ✓.
- Verification (item worktree, `nice -n 19`; rust tree changed by rebase → release binary **rebuilt under cargo lease**; TMPDIR=`$HOME/.freshell/df1/tmp/s13-b005` — evidence-documented stray empty `/tmp/.git` poisons default-TMPDIR `repo_icon_git` test; confirmed clean TMPDIR has no git ancestor):
  - `cargo build --release -p freshell-server` → exit 0 (1m22s)
  - `cargo test -p freshell-server settings` (cargo lease) → **`73 passed; 0 failed`** (bin target; all other targets 0 matched-fail), exit 0
  - `npm run test:vitest -- run test/integration/server/settings-api.test.ts --config config/vitest/vitest.server.config.ts` → **`Test Files 1 passed (1)`, `Tests 16 passed (16)`, exit 0**
  - pw lease → `FRESHELL_E2E_RUST_SERVER_BIN=$PWD/target/release/freshell-server npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium test/e2e-browser/specs/session-13-first-chat-exclusions.spec.ts` → **`1 passed (26.7s)`, exit 0** (harness logged slot binary sha256 4e38f60d…)
  - `npm run typecheck` → exit 0
  - Leases `cargo` + `pw` acquired/released as `df1-b005`.
- **Merge: `b990df909`** `df1(B005): SESSION-13 legacy-parity PATCH write path for sidebar first-chat exclusions` (ort, 7 files, +1342/−2)

---
