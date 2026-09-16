# Cloud-Lane Selection Integrity + Provider-Burst Deflake (katas 67jt, mv9m, 5prk, vpfr) Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
- The e2e cloud lane at main honors CLOUD_SKIP_SPECS (skip-listed spec files no longer execute in cloud full-lane runs), and the provider-pane specs that legitimately run no longer fail terminally under full-lane cloud load (the opencode-restart-recovery / freshopencode-db-history / freshopencode-first-send-reload-repro / fresh-agent burst, katas mv9m, 5prk, vpfr) — fixed together in this single the-usual run and landed via PR onto main.

### Explicit constraints
- Single the-usual run covering both recap suggestions: kata 67jt (the CLOUD_SKIP_SPECS selection leak) and katas mv9m/5prk/vpfr (the provider-load terminal-failure burst). This overrides the campaign's one-flake-per-run default by explicit user direction.
- Campaign pre-approval: land via PR onto main once this run's delta review finishes PASSED and checks pass; if the delta review does not finish PASSED, ask the user before merging.
- the-usual workflow: dedicated worktree under .worktrees/, TDD red/green/refactor, unit + e2e coverage of everything changed, independent Fresh Eyes reviews, never push behavior changes directly to main.
- Full e2e-lane gate at the run HEAD must show the named burst families fixed; other failures are dispositioned pre-existing per the campaign ledger (katas hsrh, d4qm, nxf6, m8pd, j96j-class receipts).

### Accepted tradeoffs and residuals
- Multi-flake scope in one run (user-directed): the skip-leak fix and the provider-burst deflakes may land as separate tasks/commits in one branch.
- Fixing 67jt removes skip-listed specs (fresh-agent-centralization-smoke, truly-idle-alerting) from the cloud lane; their failures then stop counting against the lane, but the specs remain covered locally.
- Some provider-burst specs may warrant skip-listing instead of deflaking if they fundamentally require provider binaries the cloud lane is designed not to guarantee — the plan must justify each treatment against the lane's design intent.
- Pre-existing flakes outside the named katas stay out of scope, ledger-recorded; a zero-flake e2e lane at main remains the campaign's end condition, not this run's alone.

**Goal:** Make the e2e cloud lane's skip-list contract a tested, pinned, self-proving guarantee, and make the provider-pane burst specs (katas mv9m, 5prk, vpfr) stop failing terminally under full-lane load — so that a full-lane run at the run HEAD shows zero terminal failures in the named burst families, every full-lane receipt self-identifies its lane, and the branch lands on main via one PR under the campaign pre-approval.

**Architecture:** Two independent halves in one branch. (1) Kata 67jt, premise-corrected: explorer investigation (verified by the orchestrator; see `reports/plan-runner-selection.md`) proved the cloud lane at main ALREADY honors CLOUD_SKIP_SPECS at every hop — single-task, multi-shard manifest, and focused-explicit-path invocations alike. The "skip-listed specs executed in full-lane runs" evidence came from LOCAL runs of the BASE config (`npm run test:e2e` silently defaults `FRESHELL_E2E_BACKEND` to local in non-interactive agent shells; the base config intentionally has no CLOUD_SKIP knowledge), and a prior gate receipt mislabeled those local runs as cloud runs. The deliverable for this half is therefore: a lane-provenance banner in `scripts/e2e-cloud.sh` (the local path states the config in effect and that CLOUD_SKIP_SPECS does not apply, so receipts can quote the lane from the log itself) plus selection-integrity pins in the existing `selection-nonvacuity` suite (per-entry cloud exclusion, per-entry base coverage, grepInvert non-vacuity, explicit-path no-bypass, and a loud all-skip failure pin) — converting a verified-once fact into an automated regression contract. (2) Katas mv9m/5prk/vpfr: per-spec, spec-local deflakes inside each spec's own envelope — a strict-mode-safe scoped-locator fix plus a deterministic forced-ambiguity poll (db-history), an expect.poll conversion of a one-shot state read (first-send), an expect.poll conversion of a one-shot capture fetch plus a visibility budget (centralization-smoke), and evidence-sized sub-budget raises (opencode-restart-recovery session/association waits; fresh-agent settings-modal waits). The failing lane is LOCAL, so these changes are unconditional (an `isCloudLaneWindowConfigured()` gate would never fire on the observed lane); every change stays inside the spec files; no shared wiring, no CLOUD_SKIP_SPECS membership change, no test-deadline change.

**Tech Stack:** Bash (`scripts/e2e-cloud.sh`), TypeScript/NodeNext-ESM test files (relative imports carry `.js`), Playwright 1.58.2 (testIgnore/grepInvert selection semantics — CLI file args are an intersection with testIgnore, never a bypass; `expect.poll`; strict-mode-safe locators), Vitest via the e2e-helpers config (`test/e2e-browser/vitest.config.ts`), the repo e2e lane wrapper (local + Cloud Run Jobs, gcloud-robot identity).

## Global Constraints

- **TDD red/green/refactor** for every change but the trivial; unit + e2e coverage of everything changed. Never reduce coverage, never skip or exclude specs to hide flakes, never loosen an assertion to make a flake pass.
- **Never push behavior changes directly to main.** All work happens on the run branch `the-usual/cloudlane-skip-provider-burst` in the worktree `.worktrees/cloudlane-skip-provider-burst`; landing is via PR targeting `main` ONLY after this run's delta review finishes PASSED (campaign pre-approval); if the delta review does not finish PASSED, ask the user before merging. Commits use the repo identity already configured (`Dan Shapiro <3732858+danshapiro@users.noreply.github.com>`) — never `dan@danshapiro.com` as git author.
- **PR #785 contracts are inviolable** (landed at base_ref 6ee5cf4b2; inventory in `reports/plan-constraints-priorart.md` §1):
  - The wiring NEVER modifies any test's own deadline. Budgets apply only via the `freshellPage` fixture's own timeout slot. This run touches no wiring at all; all budget changes are explicit per-assertion/sub-wait literals inside spec files.
  - Never touch `DEFAULT_TEST_TIMEOUT_MS` (60_000) or any spec's declared `test.setTimeout` envelope. All raises stay inside the existing describe envelopes (opencode-restart-recovery 240s, db-history 180s, first-send 90s; fresh-agent and centralization-smoke keep the 60s default — the raised sub-waits sum below it).
  - Keep `waitForHarness`'s no-arg default 0 (UNLIMITED) and the production boot call site's explicit `CLOUD_LANE_HARNESS_WAIT_BOUND_MS` untouched.
  - `isCloudLaneWindowConfigured()` gating is the precedent ONLY for cloud-lane-specific deadlines (settings.spec.ts). The provider burst was observed on the LOCAL lane, so the deflakes here are unconditional — a cloud-gated bump would not fire on the observed lane and must not be used for these fixes.
  - Any CLOUD_SKIP_SPECS edit must keep the selection pins green: no duplicates; `mcp-qa-smoke-rust.spec.ts` stays IN; `server-build-mismatch-rust.spec.ts` and `tabs-client-retire.spec.ts` stay OUT; all LOCAL_ONLY_SPECS included; `e2e-budget-contract.spec.ts` stays cloud-runnable. **This run makes NO CLOUD_SKIP_SPECS membership changes** — no new entries, no removals.
- **Lane-pinning protocol for every gate invocation** (this run's adopted correction): pin the backend explicitly (`npm run test:e2e:local` / `npm run test:e2e:cloud`, or `FRESHELL_E2E_BACKEND=<lane>`), never rely on ambient shell env — non-interactive agent shells do not source `~/.bashrc`. Receipts record the lane from the run log's own `[e2e-cloud]` banner (Task 1 makes that banner self-identifying), not from invocation intent. Never silently fall back from the configured cloud backend to local (repo backend-fallback policy).
- **Process safety:** never use broad kill patterns (`pkill -f vite`, `pkill node`, etc.); stop only PID-file-verified processes that belong to this worktree. The self-hosted production server (Rust server on port 3001) must never be restarted without the user's explicit "APPROVED" — nothing in this plan touches it; all builds/test servers are worktree-local and ephemeral.
- **Cloud identity:** cloud lanes never require interactive `gcloud auth login`. For this run's cloud commands, pin `FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com` (ambient gcloud is expired).
- **Test coordination:** broad repo-supported runs (`npm test`) wait for the shared coordinator gate — if another agent holds it, wait, never kill a foreign holder; set `FRESHELL_TEST_SUMMARY` for holder visibility. The e2e helpers suite (`npm run test:e2e:helpers`) and focused Playwright runs are not coordinated lanes; run them directly from the worktree (the helpers globalSetup prebuild fails closed on the main checkout while production is live — the worktree is exempt).
- **TypeScript NodeNext/ESM:** relative imports in test files carry `.js` extensions. Note `npm run typecheck:client` (tsconfig.json) covers only `src`, `shared`, and `config/vite` — test/e2e-browser files are compile-checked by actually running them (Playwright/Vitest esbuild), so the focused run IS the compile proof.
- **Budget-sizing discipline** (repo precedent): raises are per-assertion, evidence-sized (observed overruns were 1-4x the failing budgets), and fit inside existing describe envelopes. A budget that can be shown decorative (never consulted) fails its red phase — every raised literal must be demonstrated live (mutation red) before it is trusted.
- Pre-existing flakes outside the named katas stay out of scope, ledger-recorded (see Residuals below).

## Kata premise reconciliation, per-spec treatment justification, and residuals

### Premise reconciliation (kata 67jt)

The kata's original framing ("cloud lane executes CLOUD_SKIP_SPECS-listed specs — shard manifest/testIgnore not honored") is **falsified**: at base_ref 6ee5cf4b2 the cloud lane excludes every skip-listed spec at every hop (cloud `--list` = 499 tests/120 files vs base 539/138; the difference is exactly CLOUD_SKIP_SPECS + LOCAL_ONLY_SPECS + one grepInvert hit; Playwright 1.58.2 treats explicit positional file args as an intersection with testIgnore — verified against `node_modules/playwright/lib/runner/loadUtils.js:59-71` and by the real cloud focused rerun that was handed 8 spec files, 5 of them skip-listed, and executed only the 3 cloud-legal files' 32 tests). The observed "leak" executions were LOCAL full-lane runs of the base config (all three evidence logs begin `[e2e-cloud] Running locally...`), which the prior run's gate receipt mislabeled as cloud runs. The receipt/kata records were already corrected by the orchestrator; this plan delivers the remaining code+test parts: the lane-provenance banner (Task 1) and the selection-integrity pins (Task 2). The user-visible outcome stands: skip-listed specs provably never execute in cloud full-lane runs, full-lane receipts self-identify their lane, and the provider families stop failing terminally.

### Per-spec treatment justification against the lane's design intent

The cloud lane's documented design intent (playwright.cloud.config.ts:26-29) is to exclude specs that "require external CLI binaries ... or ... depend on environment-specific rendering/timing that differs in cloud". Every named burst spec installs hermetic FAKE provider CLIs from `test/e2e-browser/fixtures/` (fake-opencode.cjs etc.) onto the spawned server's PATH — none fundamentally requires network-installed binaries. Their failures are budget races of the provider-pane boot/lifecycle pipeline under parallel load (the focused rerun passed 32/32 in 1.6m; the burst reproduced identically at base_ref — load-correlated, pre-existing, not delta-caused). Therefore:

| family | cloud membership decision | local full-lane treatment |
|---|---|---|
| opencode-restart-recovery (mv9m, 6 failures) | keep skip-listed (provider-boot timing under load is exactly the class the lane excludes) | Task 5: raise the two failing sub-budgets (30s→60s session materialization wait, 15s→30s REST association poll) inside the 240s envelope |
| freshopencode-db-history (5prk, 3 failures) | keep skip-listed | Task 3: scoped strict-mode-safe transcript locators (the :245 strict-mode violation) + 30s→60s on the two failing polls/waits |
| freshopencode-first-send-reload-repro (5prk, 1 failure) | keep skip-listed | Task 4: convert the one-shot status read to a bounded expect.poll |
| fresh-agent.spec.ts (vpfr, 2-3 failures) | NOT skip-listed — route-mocked, zero-provider, cloud-legal by the lane's own standard (the freshopencode-model-picker precedent) — do not add it | Task 6: raise the three 5s settings-modal tab waits to 15s |
| fresh-agent-centralization-smoke (vpfr, 2 failures) | keep skip-listed (mocked WS/REST, no binaries; excluded for load/timing sensitivity) | Task 7: poll the capture route until its pinned 422 contract answer + explicit 30s on the settings visibility |

**No new CLOUD_SKIP_SPECS entries and no removals** — skip-listing the cloud-legal specs would remove real cloud coverage of contracts the lane currently holds green; un-skip-listing the others would widen the lane beyond its design intent. Task 2 corrects the stale skip-reason comments in place ("requires opencode binary" → the truthful provider-pipeline-timing rationale) so the lane's recorded design intent matches reality.

### Singleton flicker decision (explicit, per plan requirements)

The four singleton flickers — `freshclaude-identity-persistence-rust.spec.ts:528` (30s deadSessionAdjudication poll), `pane-ledger-restart-rust.spec.ts:265` (5s durability wall), `fresh-agent-control-rust.spec.ts:1193` (60s post-restart stdin frame), `truly-idle-alerting.spec.ts:73` (10s blue-class window) — are each n≤2 membership flickers, and **none of them live in a file this run otherwise touches**. Per the decision rule (include only same-file, same-class one-liners), **all four are recorded as ledger residuals, not fixed here**. They remain locally covered (three are cloud-legal and cloud-green in the 32/32 focused rerun; truly-idle is skip-listed and environment-sensitive by its own documented reason). Task 8's disposition standard covers any recurrence: Form A (identical base_ref reproduction) or within-family variance, per the prior run's receipt practice.

### Residuals (ledger-recorded, out of scope)

1. Cargo-lock noise: 464 "Blocking waiting for file lock" events + 108 release builds during local full-lane runs (per-worker `ensureRustServerBuilt()`). A latent amplifier for every flake family; deserves its own kata (e.g. a local-lane prebuild). Not this run's scope.
2. `docker/cloud-run/test-durations.txt` carries stale entries for skip-listed specs — harmless (discovery governs); cosmetic hygiene only.
3. AGENTS.md:188 says cloud e2e runs are "4 shards" while `npm run test:e2e` defaults to shards=1 (the campaign's practiced cloud gate shape). OPTIONAL doc nit; not required by the User Request (the gate pins its lane explicitly regardless). Likewise OPTIONAL: a one-sentence AGENTS.md note that non-interactive agent shells do not inherit `~/.bashrc` exports. The recap may list both as suggestions.
4. The cloud banner's `Config:` line (Task 1) has no automated test (stubbing the full gcloud path is disproportionate); it is proven by Task 8's real cloud run receipt.
5. The container entrypoint's bash manifest (docker/cloud-run/entrypoint.sh:181-197) is deliberately NOT unit-tested: it is a pure function of the cloud config's `--list` output, which Task 2's pins prove clean (testIgnore removes skip-listed files before the list prints, so the sed extractor cannot surface them); the Dockerfile's build-time entrypoint smoke (docker/cloud-run/Dockerfile:129-132) covers execution shape. A bash-side skip-list guard (explorer A's Candidate C) was considered and rejected — it would be a second, sync-hazard encoding of the skip list with no new guarantee. `docker/cloud-run/entrypoint.sh` is read-only for this run.

## File responsibilities (the complete change map)

| File | Responsibility in this run |
|---|---|
| `scripts/e2e-cloud.sh` (modify :460-466, :511-515) | Lane-provenance banners ONLY. No change to backend resolution, arg normalization, receipt logic, or job lifecycle. |
| `test/e2e-browser/helpers/e2e-cloud-lane-banner.test.ts` (create) | Behavior pin of the wrapper's default-local path: self-identifying banner + the base-config exec, via a stubbed `npx` that records its args. |
| `test/e2e-browser/playwright.cloud.config.ts` (modify :31-33, :45-46, :72) | Export `CLOUD_SKIP_TITLES` (additive; consumed by the selection pins) + truthful skip-reason comments. NO membership changes. |
| `test/e2e-browser/helpers/selection-nonvacuity.test.ts` (modify) | Selection-integrity pins (kata 67jt's tested contract). |
| `test/e2e-browser/specs/freshopencode-db-history.spec.ts` (modify) | Strict-mode-safe scoped locators + forced-ambiguity poll + two budget raises (kata 5prk). |
| `test/e2e-browser/specs/freshopencode-first-send-reload-repro.spec.ts` (modify) | Poll conversion of the one-shot status read (kata 5prk). |
| `test/e2e-browser/specs/opencode-restart-recovery.spec.ts` (modify) | Two sub-budget raises (kata mv9m). |
| `test/e2e-browser/specs/fresh-agent.spec.ts` (modify) | Three settings-modal wait budgets (kata vpfr). |
| `test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts` (modify) | Capture-route poll conversion + explicit visibility budget (kata vpfr). |

No `src/`, `crates/`, `docker/`, or config/vite changes. No user-facing UI change → `docs/index.html` and `README.md` untouched.

---

### Task 1: Lane-provenance banner in the e2e wrapper (kata 67jt, gate-integrity half)

**Files:**
- Modify: `scripts/e2e-cloud.sh:461` (local-path banner) and `scripts/e2e-cloud.sh:511-515` (cloud banner block)
- Test: `test/e2e-browser/helpers/e2e-cloud-lane-banner.test.ts` (new)

**Interfaces:**
- Consumes: `scripts/e2e-cloud.sh` `cmd_run` backend resolution (:449-458) and local exec path (:460-466); package.json script entries `test:e2e:local` / `test:e2e:cloud` (package.json:76-77).
- Produces: the lane-provenance banner contract consumed by every Task 8 receipt — local runs print one stdout line beginning `[e2e-cloud] Running locally... (config: test/e2e-browser/playwright.config.ts; CLOUD_SKIP_SPECS does not apply on this lane; FRESHELL_E2E_BACKEND=<value or <unset>>)`; cloud runs print a `Config:` line naming `playwright.cloud.config.ts`. No consumer parses the pre-change banner text (verified: nothing greps for `Running locally...` beyond the script itself), so extending it is safe.

- [ ] **Step 1: Write the failing behavioral test**

Create `test/e2e-browser/helpers/e2e-cloud-lane-banner.test.ts`:

```ts
import { spawnSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = path.resolve(import.meta.dirname, '../../..')

// Kata 67jt (premise-corrected): a "full e2e lane" receipt must be able to
// quote WHICH lane produced it from the run log itself. A prior campaign
// gate misread local runs (base config, no skip list) as cloud runs because
// `npm run test:e2e` silently defaults FRESHELL_E2E_BACKEND to local in
// non-interactive agent shells. This test pins the wrapper's local path:
// with the backend env unset (the exact incident condition) the run must
// announce the lane, the config in effect, and that CLOUD_SKIP_SPECS does
// not apply — before exec'ing Playwright against the BASE config.
describe('e2e-cloud wrapper lane provenance', () => {
  it('the default-local path prints a self-identifying lane banner and runs the base config', async () => {
    const stubDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-e2e-cloud-stub-'))
    const argsFile = path.join(stubDir, 'npx-args.txt')
    const npxStub = path.join(stubDir, 'npx')
    await fsp.writeFile(npxStub, [
      '#!/usr/bin/env bash',
      `printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}`,
      'exit 0',
    ].join('\n'))
    await fsp.chmod(npxStub, 0o755)

    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env.FRESHELL_E2E_BACKEND
    env.PATH = `${stubDir}${path.delimiter}${env.PATH ?? ''}`

    const result = spawnSync('bash', [
      path.join(projectRoot, 'scripts/e2e-cloud.sh'),
      'run',
    ], { cwd: projectRoot, env, encoding: 'utf8', timeout: 30_000 })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('[e2e-cloud] Running locally...')
    expect(result.stdout).toContain('test/e2e-browser/playwright.config.ts')
    expect(result.stdout).toContain('CLOUD_SKIP_SPECS does not apply')
    expect(result.stdout).toContain('FRESHELL_E2E_BACKEND=<unset>')

    const npxArgs = (await fsp.readFile(argsFile, 'utf8')).split('\n').filter(Boolean)
    expect(npxArgs).toEqual([
      'playwright',
      'test',
      '--config',
      'test/e2e-browser/playwright.config.ts',
    ])
    await fsp.rm(stubDir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:e2e:helpers -- e2e-cloud-lane-banner`

Expected: FAIL — the banner-provenance assertions fail (`toContain('test/e2e-browser/playwright.config.ts')`, `toContain('CLOUD_SKIP_SPECS does not apply')`, `toContain('FRESHELL_E2E_BACKEND=<unset>')`) because the current banner is only `[e2e-cloud] Running locally...`. The stubbed-`npx` assertions PASS pre-change, proving the spawn harness itself works — the failure is the missing provenance content, not a setup accident.

- [ ] **Step 3: Add the minimal production implementation**

In `scripts/e2e-cloud.sh`, replace line 461 with:

```bash
    echo "[e2e-cloud] Running locally... (config: test/e2e-browser/playwright.config.ts; CLOUD_SKIP_SPECS does not apply on this lane; FRESHELL_E2E_BACKEND=${FRESHELL_E2E_BACKEND:-<unset>})"
```

(`${FRESHELL_E2E_BACKEND:-<unset>}` is safe under `set -u`; it renders the resolved default honestly — receipts can distinguish an unset-env default from an explicit `--local` / `FRESHELL_E2E_BACKEND=local` choice by the banner alone.)

And in the cloud banner block, add one line after the `Args:` line (currently :515):

```bash
  echo "[e2e-cloud]   Config:  test/e2e-browser/playwright.cloud.config.ts (CLOUD_SKIP_SPECS testIgnore + CLOUD_SKIP_TITLES grepInvert apply on this lane)"
```

- [ ] **Step 4: Run the focused test**

Run: `npm run test:e2e:helpers -- e2e-cloud-lane-banner`

Expected: PASS

- [ ] **Step 5: Refactor while green**

No refactor needed — a two-line banner extension and one behavior test; nothing to consolidate.

- [ ] **Step 6: Run impacted-test verification**

The banner change touches the wrapper every e2e invocation uses, but no other test asserts wrapper output; the impacted set is the helpers suite the new file joins. Nothing in `src/` changes, so `npm run typecheck:client` is unaffected (tsconfig.json covers only `src`, `shared`, `config/vite`).

Run: `npm run test:e2e:helpers`

Expected: PASS (the full helpers suite, including the pre-existing selection/fixture/leak-metrics pins)

- [ ] **Step 7: Commit the task**

```bash
git add scripts/e2e-cloud.sh test/e2e-browser/helpers/e2e-cloud-lane-banner.test.ts
git commit -m "test(e2e): self-identifying lane banners in the e2e wrapper (kata 67jt gate provenance)"
```

### Task 2: Selection-integrity pins + truthful skip-reason comments (kata 67jt, contract half)

**Files:**
- Modify: `test/e2e-browser/playwright.cloud.config.ts:31-33` (stale opencode-block comment), `:45-46` (stale centralization comment), `:72` (export `CLOUD_SKIP_TITLES`)
- Test: `test/e2e-browser/helpers/selection-nonvacuity.test.ts` (extend; imports at :1 and :6, base `it` at :105-116, cloud `it` at :118-159)

**Interfaces:**
- Consumes: `CLOUD_SKIP_SPECS` (playwright.cloud.config.ts:30-68, existing export), `CLOUD_SKIP_TITLES` (playwright.cloud.config.ts:72-75, newly exported by this task), `LOCAL_ONLY_SPECS` (playwright.config.ts:12-16), and the suite's existing `cleanEnvironment` / `resolvedConfig` / `listedProjects` helpers (selection-nonvacuity.test.ts:25-83) plus `playwrightCli` (:13) and `projectRoot` (:11).
- Produces: the tested cloud-selection contract consumed by Task 8 — (a) every `CLOUD_SKIP_SPECS` entry is absent from the cloud selection, (b) every entry is present in the base/local selection (cloud-skip never means "not covered"), (c) `CLOUD_SKIP_TITLES` grepInvert is non-vacuous and honored, (d) explicit positional file args are an intersection with testIgnore (no bypass), (e) an all-skip focused invocation fails loudly (exit 1, "No tests found") rather than silently reading as a green zero-test run.

- [ ] **Step 1: Write the failing behavioral test (pins + the additive export)**

First, in `test/e2e-browser/playwright.cloud.config.ts:72`, make the titles list importable:

```ts
export const CLOUD_SKIP_TITLES = [
```

(the array contents at :72-75 stay byte-identical; only `export` is added).

Then in `test/e2e-browser/helpers/selection-nonvacuity.test.ts`:

1. Extend the imports:

```ts
import { execFileSync, spawnSync } from 'node:child_process'
```

```ts
import { CLOUD_SKIP_SPECS, CLOUD_SKIP_TITLES } from '../playwright.cloud.config.js'
```

2. Inside the base-lane `it` (`selects a non-vacuous Chromium lane and all CI application projects`), after the `expect(chromium.files).toBeGreaterThanOrEqual(86)` line, add:

```ts
    // Local coverage pin (kata 67jt): every CLOUD_SKIP_SPECS entry must
    // remain listed on the base/local lane — cloud-skip never means "not
    // covered"; it means "covered locally". A renamed or deleted spec that
    // forgets the list fails here.
    for (const spec of CLOUD_SKIP_SPECS) {
      expect(chromium.output, `base lane must still list ${spec}`).toContain(spec)
    }
    // CLOUD_SKIP_TITLES non-vacuity: each grepInvert title must actually
    // select a test in the base lane — else the cloud exclusion would be
    // vacuously green after an edit (today's known hit: editor-pane.spec.ts
    // "loads the editor lazily and requests a new JS asset after the click").
    expect(CLOUD_SKIP_TITLES.length).toBeGreaterThan(0)
    for (const title of CLOUD_SKIP_TITLES) {
      expect(chromium.output, `grepInvert source must exist in the base lane: ${title.source}`).toMatch(title)
    }
```

3. Inside the cloud `it` (`creates Rust fixtures and selects the supported cloud projects`), after the `expect(cloud.files).toBeGreaterThan(0)` line (currently :147), add:

```ts
    // Cloud exclusion pin (kata 67jt): no skip-listed spec may appear in
    // the cloud selection at all — a pattern typo, a minimatch-semantics
    // change, or a config refactor that drops the testIgnore mapping all
    // fail here.
    for (const spec of CLOUD_SKIP_SPECS) {
      expect(cloud.output, `cloud lane must not list ${spec}`).not.toContain(spec)
    }
    // grepInvert honored at selection level: excluded titles absent from
    // the cloud list while their spec files still run there.
    for (const title of CLOUD_SKIP_TITLES) {
      expect(cloud.output, `cloud lane must not list excluded title: ${title.source}`).not.toMatch(title)
    }

    // Explicit positional file args are an INTERSECTION with testIgnore,
    // never a bypass (Playwright 1.58.2 cliFileMatcher semantics): a mixed
    // focused invocation must keep its cloud-legal member and silently drop
    // the skip-listed one — so even a contaminated manifest or filter could
    // not execute skip-listed specs under the cloud config.
    const mixed = listedProjects(cleanEnvironment(), cloudConfig, [
      'test/e2e-browser/specs/truly-idle-alerting.spec.ts',
      'test/e2e-browser/specs/host-stats-pane.spec.ts',
    ])
    expect(mixed.output).toContain('host-stats-pane.spec.ts')
    expect(mixed.output).not.toContain('truly-idle-alerting')
    expect(mixed.files).toBe(1)

    // An ALL-skip focused invocation fails LOUDLY (exit 1, "No tests
    // found") instead of silently reading as a green zero-test run — a
    // vacuous focused cloud proof can never masquerade as coverage.
    const allSkip = spawnSync(process.execPath, [
      playwrightCli,
      'test',
      '--config', cloudConfig,
      '--list',
      'test/e2e-browser/specs/truly-idle-alerting.spec.ts',
    ], { cwd: projectRoot, env: cleanEnvironment(), encoding: 'utf8' })
    expect(allSkip.status).toBe(1)
    expect(`${allSkip.stdout}\n${allSkip.stderr}`).toContain('No tests found')
```

- [ ] **Step 2: Run the test and verify the intended failure (mutation red — three scratch mutations, each reverted)**

These pins guard already-correct behavior (the file's established pattern for regression pins), so the red phase demonstrates each new assertion failing against a deliberate contract break, then reverts it. Run `npm run test:e2e:helpers -- selection-nonvacuity` after each mutation:

Mutation M1 — comment out the `'truly-idle-alerting.spec.ts',` entry (playwright.cloud.config.ts:58). Expected: FAIL — the mixed-list pin receives `mixed.files` = 2 and `mixed.output` containing `truly-idle-alerting`; the all-skip pin receives `allSkip.status` = 0 (tests were found). These are the exact contamination classes the pins exist to catch. Revert M1.

Mutation M2 — change that same entry to `'truly-idle-alerting-missing.spec.ts',`. Expected: FAIL — the base-coverage loop reports `base lane must still list truly-idle-alerting-missing.spec.ts` (the base list lacks the bogus name), proving the local-coverage pin is live. Revert M2.

Mutation M3 — comment out the `grepInvert: CLOUD_SKIP_TITLES,` line (playwright.cloud.config.ts:100). Expected: FAIL — the cloud grepInvert pin reports the excluded title now matching the cloud list (editor-pane's screenshot test reappears). Revert M3.

- [ ] **Step 3: Land the production-file content change (truthful skip-reason comments) and confirm the mutations are reverted**

The selection behavior itself is already correct at main (the premise inversion) — the production delta in this task is the truthful record of the lane's design intent in `playwright.cloud.config.ts`, so a future reader cannot repeat the 67jt misdiagnosis ("requires opencode binary" led two runs astray). Replace the comment block at :31-33 with:

```ts
  // Provider-pane boot/lifecycle pipelines under parallel load: these
  // specs install hermetic FAKE opencode CLIs (fixtures/fake-opencode.cjs on
  // the spawned server's PATH), so no network binary is required — the
  // cloud lane excludes them because it does not guarantee provider-boot
  // timing under 2-CPU/2-worker contention (the same class that bursts on
  // the 48-worker local lane). (freshopencode-model-picker.spec.ts IS
  // cloud-legal: every fetch is routed and the sidecar is suppressed via
  // the test harness, so it needs no binary and no pane lifecycle.)
```

and the comment at :45-46 with:

```ts
  // Provider-pane lifecycle surfaces over mocked WS/REST (no binaries
  // needed): excluded because its server-side layout-sync/registry
  // propagation and settings-modal render waits are timing-sensitive under
  // cloud load.
```

NO list entries change. Verify `git diff test/e2e-browser/playwright.cloud.config.ts` shows only the two comment blocks, the `export` keyword, and nothing else.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:e2e:helpers -- selection-nonvacuity`

Expected: PASS — all pre-existing pins (mcp-qa membership, duplicate-free list, testIgnore shape, migrated-pair focused selection, non-vacuity floors) plus the new pins. Runtime cost of the additions: ~4s (one ~2s focused mixed `--list` + one ~2s all-skip spawn; the per-entry and grepInvert loops reuse already-captured output).

- [ ] **Step 5: Refactor while green**

No refactor needed — additive assertions in the established suite layout; the two new `listedProjects`/`spawnSync` uses follow the file's existing helper shapes.

- [ ] **Step 6: Run impacted-test verification**

Only `selection-nonvacuity.test.ts` imports `playwright.cloud.config.ts` (verified), and `scripts/test/cloud-run-config.test.sh` smoke-executes the cloud config (unaffected by an additive export and comments, but cheap to confirm if available). The config is also consumed at runtime by every cloud e2e run — covered behaviorally by Task 8's cloud lane. The impacted automated set is the helpers suite:

Run: `npm run test:e2e:helpers`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/playwright.cloud.config.ts test/e2e-browser/helpers/selection-nonvacuity.test.ts
git commit -m "test(e2e): pin cloud-lane selection integrity; truthful skip-reason comments (kata 67jt)"
```

### Task 3: freshopencode-db-history deflake — strict-mode-safe locators + load-tolerant budgets (kata 5prk)

**Files:**
- Modify: `test/e2e-browser/specs/freshopencode-db-history.spec.ts:283-284` (test :245, first leg), `:304-305` (test :245, post-reload leg), `:359` (test :324, run-audit poll budget), `:461-462` (test :379, repair-path render)
- Test: the spec itself (the e2e run is the behavior-protecting test — no unit harness exists for browser locators, and a static/prose check would not qualify)

**Interfaces:**
- Consumes: the spec's own donor helpers (`getFreshOpencodePaneState`, `sendFreshAgentPrompt`, `installFakeOpencode`, `seedLegacyOpencodeSession`) and the fake-opencode PATH seam; the app's auto-title pipeline (first prompt copied into tab/pane/session titles — the documented behavior that produced the observed strict-mode violation).
- Produces: nothing cross-task. All changes stay inside this spec file; the describe's declared `test.setTimeout(180_000)` (:243) is untouched.

**Diagnosis being fixed (from `reports/plan-provider-burst.md` §2.2):** test :245 failed at :284 with a strict-mode violation — bare `getByText(prompt)` resolved to 3-4 elements (tab-strip span, pane-header title, sidebar session button, transcript `<p>`) once the auto-title pipeline landed; under load the title sweep wins the race, unloaded it usually loses. Tests :324/:379 failed as 30s pipeline-starvation timeouts (run-audit poll :356-362; DB-render visibility :461).

- [ ] **Step 1: Write the failing behavioral test (deterministic repro of the strict-mode hazard)**

In test :245, insert a forced-ambiguity poll immediately before the current `:284` assertion, leaving the bare locator in place for now:

```ts
      await expect(page.getByText(response)).toBeVisible({ timeout: 30_000 })
      // Force the auto-title pipeline's propagation before asserting: the
      // first prompt is copied into the tab/pane/session titles (under
      // full-lane load this made the bare getByText below resolve to 3-4
      // elements — the strict-mode violation this spec terminally failed
      // on). Waiting for the propagation makes the ambiguity deterministic
      // instead of load-dependent, so the transcript-scoped locator that
      // replaces this assertion is exercised against the real condition
      // every run.
      await expect.poll(async () => page.getByText(prompt).count(), { timeout: 30_000 }).toBeGreaterThan(1)
      await expect(page.getByText(prompt)).toBeVisible({ timeout: 30_000 })
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:e2e:local -- test/e2e-browser/specs/freshopencode-db-history.spec.ts --grep "restores Freshopencode turns from DB history"`

Expected: FAIL — once the count-poll observes propagation (`count() > 1`), the bare `getByText(prompt)` assertion throws the exact lane failure: a Playwright strict-mode violation ("resolved to 3 elements" class). This reproduces the terminal lane failure deterministically and focusedly. Contingency: if the count-poll itself times out focusedly (propagation does not land within 30s unloaded), do not chase it — record the observation, revert the poll, and proceed with the locator fix using the lane-log evidence as the red (the scoped locator remains correct under either outcome); note it in the task receipt.

- [ ] **Step 3: Add the minimal production implementation (scoped locators + budget raises)**

1. Replace the bare prompt assertion at :284 with the transcript-scoped locator (the idiom this spec's sibling repro already uses at freshopencode-first-send-reload-repro.spec.ts:171-172):

```ts
      const transcript = page.locator('[data-context="fresh-agent-transcript"]')
      await expect(transcript.getByText(prompt, { exact: true })).toBeVisible({ timeout: 30_000 })
```

2. Same test, post-reload leg — replace the bare prompt assertion at :304 (the persisted tab title already holds the prompt after reload, so the ambiguity is inherent there):

```ts
      await expect(transcript.getByText(prompt, { exact: true })).toBeVisible({ timeout: 30_000 })
```

(the `transcript` locator is lazy and re-queries after the reload; keep the response assertion at :305 unchanged — response text never propagates to titles).

3. Test :324 — raise the run-audit poll budget at :359 from `{ timeout: 30_000 }` to `{ timeout: 60_000 }` (the observed failure was `Received: null / Timeout 30000ms exceeded` waiting for the fake's `run` audit event; the 180s envelope has room).

4. Test :379 — replace the bare prompt assertion at :461 with the scoped locator and raise its budget (the observed failure was a pipeline-starvation timeout at 30s):

```ts
      const transcript = page.locator('[data-context="fresh-agent-transcript"]')
      await expect(transcript.getByText(prompt, { exact: true })).toBeVisible({ timeout: 60_000 })
```

(keep the response assertion at :462 at its current 30s — it never failed).

- [ ] **Step 4: Run the focused test**

Run: `npm run test:e2e:local -- test/e2e-browser/specs/freshopencode-db-history.spec.ts`

Expected: PASS — all three tests, with the forced-ambiguity poll still in place: the count-poll proves propagation landed, and the scoped locator matches exactly the transcript `<p>` even while the tab/pane/session titles hold the prompt.

- [ ] **Step 5: Refactor while green**

No refactor needed — the forced-ambiguity poll is deliberate test structure (it converts a load-dependent race into a deterministic condition), and the scoped-locator idiom now matches the sibling repro spec.

- [ ] **Step 6: Run impacted-test verification**

The change is file-local: no shared helper, fixture, config, or wiring is touched, so the impacted set is the spec's own full focused run (Step 4 runs all three tests, not just the edited one — `getFreshOpencodePaneState`/`sendFreshAgentPrompt` here are this file's own copies, and no other spec imports from this file). The spec is cloud-skip-listed, so no cloud rerun applies — its coverage lane is local, per the accepted tradeoff.

Run: (Step 4's command is the complete impacted set.)

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/freshopencode-db-history.spec.ts
git commit -m "test(e2e): deflake freshopencode-db-history (scoped transcript locators, forced-ambiguity poll, 60s pipeline budgets)"
```

### Task 4: freshopencode-first-send deflake — poll the status broadcast instead of a one-shot read (kata 5prk)

**Files:**
- Modify: `test/e2e-browser/specs/freshopencode-first-send-reload-repro.spec.ts:178-181`
- Test: the spec itself

**Interfaces:**
- Consumes: the spec's `getFreshOpencodePaneState(page)` (:109-123), the `FAKE_OPENCODE_HANG_SESSION_CREATE=1` server env (:66 — pins the turn in flight so `running` is a stable steady state), and the audit-file poll at :173-176.
- Produces: nothing cross-task. The describe's declared `test.setTimeout(90_000)` (:134) is untouched; the new poll's 30s bound keeps the worst-case wait sum (15s pane state + 5s transcript + 15s audit + 30s status) at 65s, inside the envelope.

**Diagnosis:** after the 15s audit-event poll succeeds, the test did ONE synchronous `getFreshOpencodePaneState(page)` read and asserted `status === 'running'`. The audit-file write (fake CLI process) and the client's status broadcast (WS → Redux) are different pipelines; under 48-worker load the broadcast lags the audit event, so the one-shot read observed pre-turn `idle` (lane failure: `Expected: "running" Received: "idle"` at :180, in both HEAD runs). Unloaded the broadcast always wins — a focused red is not feasible without fabricating app-side delays, so the red evidence is the lane log plus a bound-liveness mutation below.

- [ ] **Step 1: Reproduce the failing condition as far as it is focusedly reproducible (bound-liveness mutation)**

Apply the fix-shaped poll but with a dead bound, temporarily, to prove the assertion shape fails loudly at its bound rather than hanging (the repo's decorative-timeout lesson class). Temporarily replace :178-181 with:

```ts
      await expect.poll(async () => getFreshOpencodePaneState(page), { timeout: 1 }).toMatchObject({
        sessionId: expect.stringMatching(/^freshopencode-/),
        status: 'running',
        sessionRef: {
          sessionId: expect.stringMatching(/^freshopencode-/),
        },
      })
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:e2e:local -- test/e2e-browser/specs/freshopencode-first-send-reload-repro.spec.ts`

Expected: FAIL with `Timeout: 1ms exceeded` while polling `getFreshOpencodePaneState` (the received value shows the pre-turn state) — proving the poll is bounded and the bound is live. The REAL red is the lane evidence (both HEAD full-lane runs failed at :180 with `Expected: "running" Received: "idle"`); the race window (audit write → WS status broadcast) only opens under load.

- [ ] **Step 3: Add the minimal production implementation**

Set the real bound (same block, `{ timeout: 1 }` → `{ timeout: 30_000 }`) and add the rationale comment:

```ts
      // The audit write (fake CLI process) and the client's status broadcast
      // (WS -> Redux) are different pipelines: under full-lane load the
      // broadcast lags the audit event, so a one-shot read raced and could
      // observe the pre-turn 'idle' (the lane failure: Expected "running",
      // Received "idle"). Poll instead: FAKE_OPENCODE_HANG_SESSION_CREATE=1
      // pins the turn in flight, so 'running' is a stable steady state —
      // polling to it does not weaken the pinned contract (the submitted
      // prompt must stay visible across reload while materialization is
      // pending).
      await expect.poll(async () => getFreshOpencodePaneState(page), { timeout: 30_000 }).toMatchObject({
        sessionId: expect.stringMatching(/^freshopencode-/),
        status: 'running',
        sessionRef: {
          sessionId: expect.stringMatching(/^freshopencode-/),
        },
      })
```

The poll replaces the `const duringSend = ...` one-shot read entirely — delete the `duringSend` binding and its three `expect(...)` lines (nothing else references `duringSend`). The negative leg is inherent: the poll fails loudly at 30s if the turn never starts, and the subsequent reload leg still pins "materialization pending" via `FAKE_OPENCODE_HANG_SESSION_CREATE`.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:e2e:local -- test/e2e-browser/specs/freshopencode-first-send-reload-repro.spec.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

The `duringSend` removal in Step 3 IS the cleanup (the one-shot binding existed only for the removed asserts); nothing further.

- [ ] **Step 6: Run impacted-test verification**

File-local change; no shared surface touched (the spec owns its helpers). The impacted set is the spec's focused run (Step 4, the file's single test). Cloud-skip-listed spec — the local lane is its coverage lane.

Run: (Step 4's command is the complete impacted set.)

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/freshopencode-first-send-reload-repro.spec.ts
git commit -m "test(e2e): deflake freshopencode-first-send (poll the status broadcast, 30s bound)"
```

### Task 5: opencode-restart-recovery deflake — load-tolerant session/association budgets (kata mv9m)

**Files:**
- Modify: `test/e2e-browser/specs/opencode-restart-recovery.spec.ts:201` (`waitForOpenCodeSessions` budget), `:823` (REST sessionRef poll budget)
- Test: the spec itself

**Interfaces:**
- Consumes: the spec's donor helpers `waitForOpenCodeSessions` (:184-203) and `waitForRunningTerminals` (:205+, unchanged), `runRestartScenario` (:449+), and the fake-opencode PATH seam.
- Produces: nothing cross-task. The describe's declared `test.setTimeout(240_000)` (:627) is untouched; both raises sit well inside it. Adjacent budgets that did NOT fail (`waitForRunningTerminals` 45s, picker/dialog 15s waits) are deliberately left alone.

**Diagnosis:** all six failing tests timed out inside two fixed sub-budgets while each owned-server + fake-CLI-PTY + discovery/association pipeline ran under 48-way parallelism (plus cargo-lock storms): five at `waitForOpenCodeSessions`' 30s `page.waitForFunction` (spawn → session-event → association → broadcast pipeline) and one at the :714 test's 15s `expect.poll` over `GET /api/terminals` (gate-release → session-event → association-scan → REST reflection). Every failure was a latency overrun, never a wrong value — the focused cloud rerun passed 32/32.

- [ ] **Step 1: Reproduce the failing condition as far as it is focusedly reproducible (bound-liveness mutation)**

Temporarily change the `waitForOpenCodeSessions` budget at :201 from `{ timeout: 30_000 }` to `{ timeout: 1 }`.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:e2e:local -- test/e2e-browser/specs/opencode-restart-recovery.spec.ts --grep "reattaches a UI-created OpenCode pane"`

Expected: FAIL with `TimeoutError: page.waitForFunction: Timeout 1ms exceeded` raised from `waitForOpenCodeSessions` (:185) — the exact stack of the five lane failures (which read `Timeout 30000ms exceeded` at the same frame), proving the budget literal is live, not decorative. The REAL red is the lane evidence: five tests at this frame with 30000ms exceeded plus one `expect.poll` 15000ms overrun at :813. Revert the mutation.

- [ ] **Step 3: Add the minimal production implementation**

1. At :201: `{ timeout: 30_000 }` → `{ timeout: 60_000 }` (2x the observed-failing budget, per the repo's evidence-sizing discipline).
2. At :823 (the :714 test's REST association poll): `{ timeout: 15_000 }` → `{ timeout: 30_000 }` (2x).

- [ ] **Step 4: Run the focused test**

Run: `npm run test:e2e:local -- test/e2e-browser/specs/opencode-restart-recovery.spec.ts --grep "reattaches a UI-created OpenCode pane"`

Expected: PASS

- [ ] **Step 5: Refactor while green**

No refactor needed — two literal changes in the spec's own donor helpers; the helpers' structure is unchanged.

- [ ] **Step 6: Run impacted-test verification**

`waitForOpenCodeSessions` is called by all six tests in this file (the loop at :486-489, :497, :665, and inside `runRestartScenario` used by the three restart tests), and the REST poll only by the :714 test — all inside this file; no other spec imports these donor helpers (the per-spec-ownership convention keeps them copied). The impacted set is therefore the whole spec's focused run:

Run: `npm run test:e2e:local -- test/e2e-browser/specs/opencode-restart-recovery.spec.ts`

Expected: PASS (all six tests; each boots its own Rust server, so allow several minutes)

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/opencode-restart-recovery.spec.ts
git commit -m "test(e2e): deflake opencode-restart-recovery (60s session materialization, 30s REST association budgets)"
```

### Task 6: fresh-agent settings-modal waits (kata vpfr, cloud-legal member)

**Files:**
- Modify: `test/e2e-browser/specs/fresh-agent.spec.ts:1847`, `:1899`, `:1946` (the three `getByRole('tab', { name: /^Coding Agents$/i })` visibility budgets)
- Test: the spec itself

**Interfaces:**
- Consumes: the shared `freshellPage` fixture chain (fixtures.ts — untouched) and the spec's `seedCollapsePane` helper (:94-137, route-mocked freshcodex pane; zero provider machinery).
- Produces: nothing cross-task. The file declares NO `test.setTimeout` (config default 60s, untouched). The three 15s waits keep the worst-case body of test :1831 (which does TWO settings round-trips) inside the 60s deadline.

**Diagnosis:** after clicking the sidebar Settings button (which unmounts and remounts the pane tree — App.tsx:1788-1796), the three expansion tests wait for the `Coding Agents` settings tab with a 5s `toBeVisible` budget; under 48-worker load the modal render exceeded 5s (`element(s) not found` at :1847/:1899/:1946 in the failing runs). The spec is route-mocked and cloud-legal — it runs on BOTH lanes and is the cloud lane's exposed member of the vpfr family.

- [ ] **Step 1: Reproduce the failing condition as far as it is focusedly reproducible (bound-liveness mutation)**

Temporarily change the budget at :1847 from `{ timeout: 5_000 }` to `{ timeout: 1 }`.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:e2e:local -- test/e2e-browser/specs/fresh-agent.spec.ts --grep "the Expand tools setting starts strips expanded"`

Expected: FAIL with a locator timeout (`Timeout: 1ms exceeded`, `element(s) not found` for `getByRole('tab', { name: /^Coding Agents$/i })`) — the exact lane failure shape (which read `Timeout: 5000ms`), proving the budget literal is live. The REAL red is the lane evidence: 2/1/3 terminal failures across the three runs at these three sites. Revert the mutation.

- [ ] **Step 3: Add the minimal production implementation**

At :1847, :1899, and :1946, change:

```ts
    await expect(page.getByRole('tab', { name: /^Coding Agents$/i })).toBeVisible({ timeout: 5_000 })
```

to:

```ts
    await expect(page.getByRole('tab', { name: /^Coding Agents$/i })).toBeVisible({ timeout: 15_000 })
```

(3x the observed-failing budget, matching the file family's established 15s picker/dialog budget idiom; the surrounding pane waits already use 10s. The follow-up `.click()` legs at :1872/:1918/:1947 carry no explicit budget and are bounded by the test deadline — unchanged.)

**Escalation ladder (gate-evidence-driven, stays inside this task if needed):** if Task 8's lane runs show a terminal failure at these waits, raise to `{ timeout: 30_000 }` AND add an unconditional `test.setTimeout(120_000)` to the three expansion tests (the repo's dominant declaration convention — per-spec body deadlines are the spec's own decision and unconditional declarations are precedented). Do not preemptively declare: the minimal raise goes first, evidence decides the rest.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:e2e:local -- test/e2e-browser/specs/fresh-agent.spec.ts --grep "the Expand tools setting starts strips expanded"`

Expected: PASS

- [ ] **Step 5: Refactor while green**

No refactor needed — three identical literal changes. (Extracting a shared `openCodingAgentsSettings` helper was considered and rejected: fresh-agent.spec.ts owns no settings-helper convention, centralization-smoke's variant differs, and a shared helper is new architecture for a deflake run — per the per-spec-ownership convention the budgets stay per-spec.)

- [ ] **Step 6: Run impacted-test verification**

File-local literal changes inside three tests of this file; the shared fixtures are untouched. The impacted set is the whole spec's focused run (25 tests share the fixture chain whose behavior is unaffected):

Run: `npm run test:e2e:local -- test/e2e-browser/specs/fresh-agent.spec.ts`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/fresh-agent.spec.ts
git commit -m "test(e2e): deflake fresh-agent settings-modal waits (5s -> 15s under full-lane load)"
```

### Task 7: fresh-agent-centralization-smoke deflake — capture poll + settings visibility budget (kata vpfr)

**Files:**
- Modify: `test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts:425-430` (the one-shot capture fetch; its test begins at :408 in the current file — the kata ledger cites it as :401 from the prior commit's numbering) and `:488` (the `Fresh agent` visibility; its test begins at :454 — kata ledger :447)
- Test: the spec itself

**Interfaces:**
- Consumes: the spec's `fetchWithAuth(serverInfo, path, init?)` (:248-257), `sendLegacyLayoutSync` (:230-246), and the shared `freshellPage` fixture chain (untouched).
- Produces: nothing cross-task. The file declares NO `test.setTimeout` (60s default, untouched); the two raised waits (30s poll + 30s visibility) sit in different tests, so no single body can sum them past its deadline.

**Diagnosis:** the capture test (kata ledger :401; begins at :408 in the current file) failed at :425-426 because the one-shot `GET /api/panes/pane-legacy-agent/capture` raced the server-side layout-sync → pane-registry propagation: the preceding `expect.poll` for the normalized `/api/panes` snapshot had already passed, but the capture route's pane lookup still 404'd (`Received: 404` where the pinned contract answer is 422 "pane kind fresh-agent is unsupported for capture"). The settings test (kata ledger :447; begins at :454 in the current file) failed at :488 waiting for the `Fresh agent` settings text at the 10s default expect timeout — the same settings-modal render starvation as Task 6. The spec is skip-listed from cloud (its failures stop counting there once 67jt's selection contract is pinned); the local lane is where it must hold.

- [ ] **Step 1: Reproduce the failing conditions as far as they are focusedly reproducible (bound-liveness mutations)**

1. Temporarily set the new capture poll's bound to `{ timeout: 1 }` (write the poll from Step 3 first, with the dead bound).
2. Temporarily change :488 to `await expect(page.getByText('Fresh agent')).toBeVisible({ timeout: 1 })`.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:e2e:local -- test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts --grep "normalizes remote legacy layout sync|keeps fresh-agent settings"`

Expected: FAIL — both tests fail at their 1ms bounds (the capture poll with the received mid-sync status; the visibility wait with `element(s) not found`), proving both bounds are live, not decorative. The REAL red is the lane evidence (the 404-vs-422 race at the capture assertion, :425-426 in the current file; the 10s element-not-found at :488). Revert both mutations (the capture poll keeps its real bound from Step 3).

- [ ] **Step 3: Add the minimal production implementation**

1. Replace :425-430:

```ts
    const capture = await fetchWithAuth(serverInfo, '/api/panes/pane-legacy-agent/capture')
    expect(capture.status).toBe(422)
    expect(await capture.json()).toMatchObject({
      status: 'error',
      message: expect.stringContaining('pane kind "fresh-agent"'),
    })
```

with:

```ts
    // The capture route's pane lookup 404s until the legacy layout-sync has
    // fully propagated into the server pane registry — a mid-sync transient
    // under load (observed: Received 404 where the pinned contract answer is
    // 422). Poll until the pinned contract answer; any other status fails
    // loudly at the bound, preserving the "fresh-agent is unsupported for
    // capture" contract.
    await expect.poll(async () => {
      const capture = await fetchWithAuth(serverInfo, '/api/panes/pane-legacy-agent/capture')
      const body = await capture.json().catch(() => undefined)
      return { status: capture.status, bodyStatus: body?.status, message: body?.message }
    }, { timeout: 30_000 }).toMatchObject({
      status: 422,
      bodyStatus: 'error',
      message: expect.stringContaining('pane kind "fresh-agent"'),
    })
```

2. At :488, make the visibility budget explicit and load-tolerant (the observed failure was the 10s default):

```ts
    await expect(page.getByText('Fresh agent')).toBeVisible({ timeout: 30_000 })
```

- [ ] **Step 4: Run the focused test**

Run: `npm run test:e2e:local -- test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts --grep "normalizes remote legacy layout sync|keeps fresh-agent settings"`

Expected: PASS

- [ ] **Step 5: Refactor while green**

No refactor needed — the poll preserves the original assertions exactly (status 422, body status 'error', message substring) while adding retry; the visibility change is a literal.

- [ ] **Step 6: Run impacted-test verification**

File-local changes inside two tests; no shared surface touched (the spec owns `fetchWithAuth`/`sendLegacyLayoutSync` copies). The impacted set is the whole spec's focused run:

Run: `npm run test:e2e:local -- test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts
git commit -m "test(e2e): deflake fresh-agent-centralization-smoke (capture poll until 422, 30s settings visibility)"
```

### Task 8: Final gate — full-lane proof on both lanes + disposition standard (T-last)

**Files:**
- Modify: none (verification task; receipts are written outside the tracked tree, under the run's logs dir)
- Test: everything above, plus the two full e2e lanes

**Interfaces:**
- Consumes: all prior tasks' outputs; the lane-pinning protocol and banner contract (Task 1); the selection contract (Task 2); the campaign's gate criterion and Form A/B disposition standard; the gcloud-robot cloud identity; the shared test coordinator (for the standard suite only).
- Produces: the gate receipts (under `<logs_dir>/reports/`, one per lane run, each quoting the run's own `[e2e-cloud]` banner line verbatim as lane provenance) that the run's delta review and PR will cite.

The gate's acceptance criterion, quoting the User Request: "Full e2e-lane gate at the run HEAD must show the named burst families fixed; other failures are dispositioned pre-existing per the campaign ledger." The named burst families are: opencode-restart-recovery, freshopencode-db-history, freshopencode-first-send-reload-repro, fresh-agent.spec.ts, fresh-agent-centralization-smoke.

- [ ] **Step 1: Run the helpers suites (the 67jt contract pins + all e2e helper unit pins)**

Run: `npm run test:e2e:helpers`

Expected: PASS — includes the Task 1 wrapper pin and the Task 2 selection pins, plus all pre-existing helper pins (test-harness budget pins, fixtures, leak metrics, selection non-vacuity).

- [ ] **Step 2: Run the standard coordinated suite**

Run: `FRESHELL_TEST_SUMMARY="cloudlane-skip-provider-burst gate: standard suite at run HEAD" npm test`

(This is a coordinated run — if another agent holds the shared gate, wait; never kill a foreign holder.)

Expected: PASS. Known pre-existing exception: the kata-hsrh rust budget flake (`claude::tests::session_init_with_all_blank_settings_records_no_binding`, load-sensitive, isolation-green, ledger-recorded) — if it recurs, disposition it per the ledger and confirm with an isolation rerun; anything else new is a blocker to investigate before proceeding.

- [ ] **Step 3: Run the LOCAL full lane twice at HEAD (the lane where the burst reproduced)**

Run (twice, sequentially; each ~25-30 min on the 96-core host):

```bash
npm run test:e2e:local > /tmp/e2e-gate-local-1.log 2>&1; echo "exit=$?"
npm run test:e2e:local > /tmp/e2e-gate-local-2.log 2>&1; echo "exit=$?"
```

Expected: exit=0 on both runs, or exit=1 with every terminal failure OUTSIDE the named burst families and dispositioned per Step 6. Specifically: ZERO terminal failures in opencode-restart-recovery, freshopencode-db-history, freshopencode-first-send-reload-repro, fresh-agent.spec.ts, fresh-agent-centralization-smoke. Each receipt quotes the log's own banner line (post-Task-1: `[e2e-cloud] Running locally... (config: test/e2e-browser/playwright.config.ts; CLOUD_SKIP_SPECS does not apply on this lane; ...)`) as lane provenance. Two consecutive clean-of-burst runs match the campaign's repeat standard for load-correlated flakes.

- [ ] **Step 4: Run one real CLOUD full lane at HEAD (backend pinned explicitly)**

Run:

```bash
FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com \
  npm run test:e2e:cloud > /tmp/e2e-gate-cloud-1.log 2>&1; echo "exit=$?"
```

(The wrapper's default shards=1 is the campaign's practiced cloud gate shape — baseline B. The image is content-addressed to the HEAD commit and builds once.)

Expected: exit=0 with a zero-flake receipt — the wrapper fails the run on ANY recovered Playwright retry (`recoveredRetryCount > 0`), so "passed with retries" is NOT gate-green here. Verify in the log/receipt: (a) the cloud banner + `Config:` line appear (Task 1's cloud-side provenance); (b) NO skip-listed spec appears in the executed roster (the 67jt contract, now also pinned by Task 2); (c) fresh-agent.spec.ts (the burst family's cloud-legal member) is green.

- [ ] **Step 5: Focused reruns of the affected specs on both lanes**

Local (all five deflaked files):

```bash
npm run test:e2e:local -- test/e2e-browser/specs/freshopencode-db-history.spec.ts \
  test/e2e-browser/specs/freshopencode-first-send-reload-repro.spec.ts \
  test/e2e-browser/specs/opencode-restart-recovery.spec.ts \
  test/e2e-browser/specs/fresh-agent.spec.ts \
  test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts
```

Expected: PASS (all five files; note the first local invocation pays the globalSetup client+Rust build).

Cloud (the cloud-legal member only — a focused cloud invocation of the four skip-listed files yields the Task 2-pinned loud "No tests found" exit 1 BY DESIGN, which is the contract working, not coverage; their coverage lane is local):

```bash
FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com \
  npm run test:e2e:cloud -- test/e2e-browser/specs/fresh-agent.spec.ts
```

Expected: PASS (the ~25 fresh-agent tests).

- [ ] **Step 6: Disposition anything else that appears (Form A/B standard) + write the receipts**

For every terminal failure or recovered retry OUTSIDE the named burst families:

- **Form A (preferred, strongest):** reproduce identically at base_ref 6ee5cf4b2 in a fresh scratch worktree, same-day environment, same lane — identical test, line, and failure shape. Record the reproduction command and log path.
- **Form B:** code-cited mechanistic impossibility (why this run's delta cannot create the failure) + population receipts (prior runs showing the same failure at base) + kata filing if it is a new recurring flake.

Ledger katas available for pre-existing disposition: hsrh (rust session-init budget under full-suite load), d4qm, nxf6, m8pd (standing cloud-evidenced e2e retry flakes), j96j-class receipts, 38hj/5kyg/ebp6 (campaign baseline). The four singleton flickers (freshclaude-identity-persistence:528, pane-ledger-restart:265, fresh-agent-control-rust:1193, truly-idle:73) are pre-recorded as within-family variance / ledger residuals — a Form A reproduction or a within-family disposition covers a recurrence; a SECOND consecutive recurrence of any singleton escalates it to a new kata filing in the recap (not a fix in this run).

Write the gate receipts to `<logs_dir>/reports/` (e.g. `gate-e2e-local-1.md`, `gate-e2e-local-2.md`, `gate-e2e-cloud-1.md`, `gate-focused.md`): each receipt records the command, the exit code, the lane banner line quoted from the log itself, the pass/fail counts, and the disposition (or burst-family absence proof) for every failure.

- [ ] **Step 7: Confirm the worktree is clean and push the branch**

```bash
git status --porcelain   # expected: empty (all seven prior tasks committed their files)
git push -u origin the-usual/cloudlane-skip-provider-burst
```

(The push runs the pre-push gate's cheap checks — cargo fmt/typecheck/clippy filtered by what the push changes; a test-file-only push should be a no-op there. Bypassing with `--no-verify` is NOT authorized for this run.)

Landing: PR creation and merge happen ONLY under the campaign pre-approval — after this run's delta review finishes PASSED, open the PR targeting `main`, wait for required checks, merge, fast-forward local `main` from `origin/main`, and clean up the worktree. If the delta review does not finish PASSED, stop and ask the user before merging. Do not create the PR before that verdict.
