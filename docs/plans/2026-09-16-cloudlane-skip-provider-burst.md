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

**Architecture:** Two independent halves in one branch. (1) Kata 67jt, premise-corrected: explorer investigation (verified by the orchestrator; see `reports/plan-runner-selection.md`) proved the cloud lane at main ALREADY honors CLOUD_SKIP_SPECS at every hop — single-task, multi-shard manifest, and focused-explicit-path invocations alike. The "skip-listed specs executed in full-lane runs" evidence came from LOCAL runs of the BASE config (`npm run test:e2e` silently defaults `FRESHELL_E2E_BACKEND` to local in non-interactive agent shells; the base config intentionally has no CLOUD_SKIP knowledge), and a prior gate receipt mislabeled those local runs as cloud runs. The deliverable for this half is therefore: a lane-provenance banner in `scripts/e2e-cloud.sh` (the local path states the config in effect and that CLOUD_SKIP_SPECS does not apply, so receipts can quote the lane from the log itself) plus selection-integrity pins in the existing `selection-nonvacuity` suite (per-entry cloud exclusion, per-entry base coverage, grepInvert non-vacuity, explicit-path no-bypass, and a loud all-skip failure pin) — converting a verified-once fact into an automated regression contract. (2) Katas mv9m/5prk/vpfr: per-spec, spec-local deflakes inside each spec's own envelope — a strict-mode-safe scoped-locator fix plus a deterministic forced-ambiguity poll (db-history), an expect.poll conversion of a one-shot state read (first-send), an eviction-proof capture path in centralization-smoke (re-send the crafted legacy layout sync whenever the page's own debounced layout mirror evicts it — a 404/empty observation inside a bounded poll, never a bare poll-until-422; see Task 7 and `reports/load-bearing-validator-LB-2.md`) plus explicit visibility and pane-poll bounds, and load-tolerant sub-budget raises (opencode-restart-recovery session/association waits; fresh-agent settings-modal waits). The failing lane is LOCAL, so these changes are unconditional (an `isCloudLaneWindowConfigured()` gate would never fire on the observed lane); every change stays inside the spec files plus one spec-owned helper seam (`test/e2e-browser/helpers/rust-server.ts` gains a public `kill(signal)` method — kata mv9m's deterministic TypeError fix, see Task 5); no `src/` app wiring, no CLOUD_SKIP_SPECS membership change, no test-deadline change.

**Tech Stack:** Bash (`scripts/e2e-cloud.sh`), TypeScript/NodeNext-ESM test files (relative imports carry `.js`), Playwright 1.58.2 (testIgnore/grepInvert selection semantics — CLI file args are an intersection with testIgnore, never a bypass; `expect.poll`; strict-mode-safe locators), Vitest via the e2e-helpers config (`test/e2e-browser/vitest.config.ts`), the repo e2e lane wrapper (local + Cloud Run Jobs, gcloud-robot identity).

## Global Constraints

- **TDD red/green/refactor** for every change but the trivial; unit + e2e coverage of everything changed. Never reduce coverage, never skip or exclude specs to hide flakes, never loosen an assertion to make a flake pass.
- **Never push behavior changes directly to main.** All work happens on the run branch `the-usual/cloudlane-skip-provider-burst` in the worktree `.worktrees/cloudlane-skip-provider-burst`; landing is via PR targeting `main` ONLY after this run's delta review finishes PASSED (campaign pre-approval); if the delta review does not finish PASSED, ask the user before merging. Commits use the repo identity already configured (`Dan Shapiro <3732858+danshapiro@users.noreply.github.com>`) — never `dan@danshapiro.com` as git author.
- **PR #785 contracts are inviolable** (landed at base_ref 6ee5cf4b2; inventory in `reports/plan-constraints-priorart.md` §1):
  - The wiring NEVER modifies any test's own deadline. Budgets apply only via the `freshellPage` fixture's own timeout slot. This run touches no wiring at all; all budget changes are explicit per-assertion/sub-wait literals inside spec files.
  - Never touch `DEFAULT_TEST_TIMEOUT_MS` (60_000) or any spec's declared `test.setTimeout` envelope. All raises are per-assertion literals individually well inside the existing describe envelopes (opencode-restart-recovery 240s, db-history 180s, first-send 90s; fresh-agent and centralization-smoke keep the 60s default). All-max chain sums are NOT the sizing criterion: the pre-change chains already exceeded these envelopes as full-chain worst-case sums with passing history (see `reports/load-bearing-validator-LB-6.md` for the per-test table), so no `test.setTimeout` declaration is added anywhere in this run.
  - Keep `waitForHarness`'s no-arg default 0 (UNLIMITED) and the production boot call site's explicit `CLOUD_LANE_HARNESS_WAIT_BOUND_MS` untouched.
  - `isCloudLaneWindowConfigured()` gating is the precedent ONLY for cloud-lane-specific deadlines (settings.spec.ts). The provider burst was observed on the LOCAL lane, so the deflakes here are unconditional — a cloud-gated bump would not fire on the observed lane and must not be used for these fixes.
  - Any CLOUD_SKIP_SPECS edit must keep the selection pins green: no duplicates; `mcp-qa-smoke-rust.spec.ts` stays IN; `server-build-mismatch-rust.spec.ts` and `tabs-client-retire.spec.ts` stay OUT; all LOCAL_ONLY_SPECS included; `e2e-budget-contract.spec.ts` stays cloud-runnable. **This run makes NO CLOUD_SKIP_SPECS membership changes** — no new entries, no removals.
- **Lane-pinning protocol for every gate invocation** (this run's adopted correction): pin the backend explicitly (`npm run test:e2e:local` / `npm run test:e2e:cloud`, or `FRESHELL_E2E_BACKEND=<lane>`), never rely on ambient shell env — non-interactive agent shells do not source `~/.bashrc`. Receipts record the lane from the run log's own `[e2e-cloud]` banner (Task 1 makes that banner self-identifying), not from invocation intent. Never silently fall back from the configured cloud backend to local (repo backend-fallback policy).
- **Process safety:** never use broad kill patterns (`pkill -f vite`, `pkill node`, etc.); stop only PID-file-verified processes that belong to this worktree. The self-hosted production server (Rust server on port 3001) must never be restarted without the user's explicit "APPROVED" — nothing in this plan touches it; all builds/test servers are worktree-local and ephemeral.
- **Cloud identity:** cloud lanes never require interactive `gcloud auth login`. For this run's cloud commands, pin `FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com` (ambient gcloud is expired).
- **Test coordination:** broad repo-supported runs (`npm test`) wait for the shared coordinator gate — if another agent holds it, wait, never kill a foreign holder; set `FRESHELL_TEST_SUMMARY` for holder visibility. The e2e helpers suite (`npm run test:e2e:helpers`) and focused Playwright runs are not coordinated lanes; run them directly from the worktree (the helpers globalSetup prebuild fails closed on the main checkout while production is live — the worktree is exempt).
- **TypeScript NodeNext/ESM:** relative imports in test files carry `.js` extensions. Note `npm run typecheck:client` (tsconfig.json) covers only `src`, `shared`, and `config/vite` — test/e2e-browser files are compile-checked by actually running them (Playwright/Vitest esbuild), so the focused run IS the compile proof.
- **Budget-sizing discipline** (corrected per `reports/load-bearing-validator-LB-1.md` §5): raises are per-assertion, sized at 2-3x the budgets that demonstrably fired under load. The aborting lane timeouts prove only latency ≥ the old bound — no eventual-completion time is measured anywhere in the evidence corpus, so no "observed overrun multiple" can be cited; each raise's sufficiency is a gate-tested hypothesis, not a measured latency. A budget that can be shown decorative (never consulted) fails its red phase — every raised literal must be demonstrated live (mutation red) before it is trusted.
- Pre-existing flakes outside the named katas stay out of scope, ledger-recorded (see Residuals below).

## Kata premise reconciliation, per-spec treatment justification, and residuals

### Premise reconciliation (kata 67jt)

The kata's original framing ("cloud lane executes CLOUD_SKIP_SPECS-listed specs — shard manifest/testIgnore not honored") is **falsified**: at base_ref 6ee5cf4b2 the cloud lane excludes every skip-listed spec at every hop (cloud `--list` = 499 tests/120 files vs base 539/138; the difference is exactly CLOUD_SKIP_SPECS + LOCAL_ONLY_SPECS + one grepInvert hit; Playwright 1.58.2 treats explicit positional file args as an intersection with testIgnore — verified against `node_modules/playwright/lib/runner/loadUtils.js:59-71` and by the real cloud focused rerun that was handed 8 spec files, 5 of them skip-listed, and executed only the 3 cloud-legal files' 32 tests). The observed "leak" executions were LOCAL full-lane runs of the base config (all three evidence logs begin `[e2e-cloud] Running locally...`), which the prior run's gate receipt mislabeled as cloud runs. The receipt/kata records were already corrected by the orchestrator; this plan delivers the remaining code+test parts: the lane-provenance banner (Task 1) and the selection-integrity pins (Task 2). The user-visible outcome stands: skip-listed specs provably never execute in cloud full-lane runs, full-lane receipts self-identify their lane, and the provider families stop failing terminally.

### Per-spec treatment justification against the lane's design intent

The cloud lane's documented design intent (playwright.cloud.config.ts:26-29) is to exclude specs that "require external CLI binaries ... or ... depend on environment-specific rendering/timing that differs in cloud". Every named burst spec installs hermetic FAKE provider CLIs from `test/e2e-browser/fixtures/` (fake-opencode.cjs etc.) onto the spawned server's PATH — none fundamentally requires network-installed binaries. Their failures are budget races of the provider-pane boot/lifecycle pipeline under parallel load (the burst reproduced identically at base_ref — load-correlated, pre-existing, not delta-caused). Evidence-class honesty (per `reports/load-bearing-validator-LB-1.md`): the prior run's "focused rerun 32/32" was a CLOUD run — five of the eight handed spec files are CLOUD_SKIP_SPECS-listed and contributed ZERO tests (freshopencode-db-history, freshopencode-first-send-reload-repro, opencode-restart-recovery, fresh-agent-centralization-smoke, truly-idle-alerting); the 32 executed tests came from fresh-agent (25), freshclaude-identity-persistence (4), and pane-ledger-restart (3); fresh-agent-control-rust was never rerun. The skip-listed families were therefore never measured even unloaded. Per-family evidence classes: fresh-agent modal waits = transience-proven (a loaded pass at the old 5s budget exists) + unloaded-bounded (whole bodies fit ≤9s in the rerun); centralization-smoke capture = transience-proven (a full 48-worker loaded pass exists); opencode-restart-recovery, db-history :324/:379, first-send, and centralization-smoke settings visibility = gate-measured (zero passes anywhere in the corpus — their only proof is Task 8's local lane runs, with the escalation ladder armed). Therefore:

| family | cloud membership decision | local full-lane treatment |
|---|---|---|
| opencode-restart-recovery (mv9m, 6 failures) | keep skip-listed (provider-boot timing under load is exactly the class the lane excludes) | Task 5: raise the two failing sub-budgets (30s→60s session materialization wait, 15s→30s REST association poll) inside the 240s envelope, AND add the public `RustServer.kill(signal)` the spec's kill branch calls (a deterministic TypeError no budget raise can fix — see `reports/load-bearing-validator-LB-6.md` §5) |
| freshopencode-db-history (5prk, 3 failures) | keep skip-listed | Task 3: scoped strict-mode-safe transcript locators (the :245 strict-mode violation) + 30s→60s on the two failing polls/waits |
| freshopencode-first-send-reload-repro (5prk, 1 failure) | keep skip-listed | Task 4: convert the one-shot status read to a bounded expect.poll |
| fresh-agent.spec.ts (vpfr, 2-3 failures) | NOT skip-listed — route-mocked, zero-provider, cloud-legal by the lane's own standard (the freshopencode-model-picker precedent) — do not add it | Task 6: raise the three 5s settings-modal tab waits to 15s |
| fresh-agent-centralization-smoke (vpfr, 2 failures) | keep skip-listed (mocked WS/REST, no binaries; excluded for load/timing sensitivity) | Task 7: eviction-proof the capture path (re-send the crafted legacy sync whenever an evicted observation — capture 404 or empty panes — appears inside bounded polls; see `reports/load-bearing-validator-LB-2.md`) + explicit 30s bounds on the `/api/panes` poll and the settings visibility |

**No new CLOUD_SKIP_SPECS entries and no removals** — skip-listing the cloud-legal specs would remove real cloud coverage of contracts the lane currently holds green; un-skip-listing the others would widen the lane beyond its design intent. Task 2 corrects the stale skip-reason comments in place ("requires opencode binary" → the truthful provider-pipeline-timing rationale) so the lane's recorded design intent matches reality.

### Singleton flicker decision (explicit, per plan requirements)

The four singleton flickers — `freshclaude-identity-persistence-rust.spec.ts:528` (30s deadSessionAdjudication poll), `pane-ledger-restart-rust.spec.ts:265` (5s durability wall), `fresh-agent-control-rust.spec.ts:1193` (60s post-restart stdin frame), `truly-idle-alerting.spec.ts:73` (10s blue-class window) — are each n≤2 membership flickers, and **none of them live in a file this run otherwise touches**. Per the decision rule (include only same-file, same-class one-liners), **all four are recorded as ledger residuals, not fixed here**. They remain locally covered; unloaded evidence honesty (per `reports/load-bearing-validator-LB-1.md` §4): only two of the four ran in the prior focused cloud rerun and both were green (freshclaude-identity-persistence's 4 tests, pane-ledger-restart's 3 tests); fresh-agent-control-rust was NOT part of the rerun's 8-file handoff and has no unloaded measurement; truly-idle is skip-listed and environment-sensitive by its own documented reason. Task 8's disposition standard covers any recurrence: Form A (identical base_ref reproduction) or within-family variance, per the prior run's receipt practice.

### Residuals (ledger-recorded, out of scope)

1. Cargo-lock noise: 464 "Blocking waiting for file lock" events + 108 release builds during local full-lane runs (per-worker `ensureRustServerBuilt()`). A latent amplifier for every flake family; deserves its own kata (e.g. a local-lane prebuild). Not this run's scope.
2. `docker/cloud-run/test-durations.txt` carries stale entries for skip-listed specs — harmless (discovery governs); cosmetic hygiene only.
3. AGENTS.md:188 says cloud e2e runs are "4 shards" while `npm run test:e2e` defaults to shards=1 (the campaign's practiced cloud gate shape). OPTIONAL doc nit; not required by the User Request (the gate pins its lane explicitly regardless). Likewise OPTIONAL: a one-sentence AGENTS.md note that non-interactive agent shells do not inherit `~/.bashrc` exports. The recap may list both as suggestions.
4. The container entrypoint's bash manifest (docker/cloud-run/entrypoint.sh:181-197) is deliberately NOT unit-tested: it is a pure function of the cloud config's `--list` output, which Task 2's pins prove clean (testIgnore removes skip-listed files before the list prints, so the sed extractor cannot surface them); the Dockerfile's build-time entrypoint smoke (docker/cloud-run/Dockerfile:129-132) covers execution shape. A bash-side skip-list guard (explorer A's Candidate C) was considered and rejected — it would be a second, sync-hazard encoding of the skip list with no new guarantee. `docker/cloud-run/entrypoint.sh` is read-only for this run. (The cloud banner's `Config:` line WAS originally listed here as untested; plan review round 1 Finding 2 corrected that — Task 1 now asserts it in `scripts/test/cloud-run-wrapper.test.sh`'s stubbed cloud path, so it is no longer a residual.)

## File responsibilities (the complete change map)

| File | Responsibility in this run |
|---|---|
| `scripts/e2e-cloud.sh` (modify :460-466, :511-515) | Lane-provenance banners ONLY. No change to backend resolution, arg normalization, receipt logic, or job lifecycle. |
| `scripts/test/cloud-run-wrapper.test.sh` (modify — add cloud `Config:` provenance check) | Automated assertion of the cloud-path banner line in the suite's existing stubbed-cloud output (plan review round 1, Finding 2). |
| `test/e2e-browser/helpers/e2e-cloud-lane-banner.test.ts` (create) | Behavior pin of the wrapper's default-local path: self-identifying banner + the base-config exec, via a stubbed `npx` that records its args. |
| `test/e2e-browser/playwright.cloud.config.ts` (modify :31-33, :45-46, :72) | Export `CLOUD_SKIP_TITLES` (additive; consumed by the selection pins) + truthful skip-reason comments. NO membership changes. |
| `test/e2e-browser/helpers/selection-nonvacuity.test.ts` (modify) | Selection-integrity pins (kata 67jt's tested contract). |
| `test/e2e-browser/specs/freshopencode-db-history.spec.ts` (modify) | Strict-mode-safe scoped locators + forced-ambiguity poll + two budget raises (kata 5prk). |
| `test/e2e-browser/specs/freshopencode-first-send-reload-repro.spec.ts` (modify) | Poll conversion of the one-shot status read (kata 5prk). |
| `test/e2e-browser/specs/opencode-restart-recovery.spec.ts` (modify) | Two sub-budget raises (kata mv9m); the `:525` kill call site itself is unchanged (it becomes valid via the helper seam below). |
| `test/e2e-browser/helpers/rust-server.ts` (modify) | Add the public `kill(signal)` method — hard process-group kill WITHOUT reboot, the deterministic TypeError fix for the spec's kill branch (kata mv9m; `reports/load-bearing-validator-LB-6.md` §5). Additive only: `restart()`/`restartAbrupt()`/`stop()` are untouched. |
| `test/e2e-browser/specs/fresh-agent.spec.ts` (modify) | Three settings-modal wait budgets (kata vpfr). |
| `test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts` (modify) | Eviction-proof capture-path polls (re-send the crafted legacy sync on evicted observations; `reports/load-bearing-validator-LB-2.md`) + explicit 30s bounds (kata vpfr). |

No `src/`, `crates/`, `docker/`, or config/vite changes. No user-facing UI change → `docs/index.html` and `README.md` untouched.

---

### Task 1: Lane-provenance banner in the e2e wrapper (kata 67jt, gate-integrity half)

**Files:**
- Modify: `scripts/e2e-cloud.sh:461` (local-path banner) and `scripts/e2e-cloud.sh:511-515` (cloud banner block)
- Modify: `scripts/test/cloud-run-wrapper.test.sh` (add a cloud-path `Config:` banner assertion to the existing stubbed-cloud checks)
- Test: `test/e2e-browser/helpers/e2e-cloud-lane-banner.test.ts` (new)

**Interfaces:**
- Consumes: `scripts/e2e-cloud.sh` `cmd_run` backend resolution (:449-458) and local exec path (:460-466); package.json script entries `test:e2e:local` / `test:e2e:cloud` (package.json:76-77).
- Produces: the lane-provenance banner contract consumed by every Task 8 receipt — local runs print one stdout line beginning `[e2e-cloud] Running locally... (config: test/e2e-browser/playwright.config.ts; CLOUD_SKIP_SPECS does not apply on this lane; backend=local; source: <flag --local | env FRESHELL_E2E_BACKEND=<value> | default>)`; cloud runs print a `Config:` line naming `playwright.cloud.config.ts`. The banner prints the RESOLVED lane and its selection source (never the raw env value, which misleads when a flag overrides it — plan review round 3, Finding 3). CONSUMER CONSTRAINT (LB-4, see `reports/load-bearing-finder.md`): `scripts/test/cloud-run-wrapper.test.sh` DOES parse this output — its checks 9 (:127) and 10 (:146) grep the local-path output for the substring `Running locally`, and check 11 (:212) asserts that substring's ABSENCE on the cloud path. The banner design must therefore preserve the exact `Running locally` substring verbatim; additions after it are safe (all the suite's greps are substring matches on the preserved prefix). The cloud-side `Config:` line is ALSO pinned by this task in the wrapper suite itself: the suite already runs a fully stubbed cloud path and captures the cloud-path output (the `CLOUD_STUB_OUTPUT` variable, as consumed by check 11), so an inexpensive additional check there asserts the cloud path prints the `Config:  test/e2e-browser/playwright.cloud.config.ts` line — closing the provenance contract's cloud half with automated coverage (plan review round 1, Finding 2).

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
    expect(result.stdout).toContain('backend=local; source: default')

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

Expected: FAIL — the banner-provenance assertions fail (`toContain('test/e2e-browser/playwright.config.ts')`, `toContain('CLOUD_SKIP_SPECS does not apply')`, `toContain('backend=local; source: default')`) because the current banner is only `[e2e-cloud] Running locally...`. The stubbed-`npx` assertions PASS pre-change, proving the spawn harness itself works — the failure is the missing provenance content, not a setup accident.

- [ ] **Step 3: Add the minimal production implementation**

In `scripts/e2e-cloud.sh`, replace line 461 with:

```bash
    echo "[e2e-cloud] Running locally... (config: test/e2e-browser/playwright.config.ts; CLOUD_SKIP_SPECS does not apply on this lane; backend=local; source: ${backend_source})"
```

and record the selection source at the resolution site (the backend-resolution block at :449-458) so the banner prints the RESOLVED lane and HOW it was chosen — not the raw env value, which misleads when a `--local` flag overrides `FRESHELL_E2E_BACKEND=cloud` (plan review round 3, Finding 3):

```bash
  # Resolve backend: explicit flags override env var; env var defaults to local.
  local backend_source="default"
  if $cloud_mode; then
    local_mode=false
    backend_source="flag --cloud"
  elif $local_mode; then
    backend_source="flag --local"
  elif [ "${FRESHELL_E2E_BACKEND:-local}" = "cloud" ]; then
    cloud_mode=true
    backend_source="env FRESHELL_E2E_BACKEND=cloud"
  else
    local_mode=true
    if [ -n "${FRESHELL_E2E_BACKEND:-}" ]; then
      backend_source="env FRESHELL_E2E_BACKEND=$FRESHELL_E2E_BACKEND"
    fi
  fi
```

(Reconcile with the block's actual initialization just above it — if `$local_mode` is initialized true rather than set only by the `--local` flag, distinguish the flag case by checking the parsed args the same way the block already does for `--cloud`/`--local`; the requirement is that the three sources — flag, env, default — are distinguishable and truthful in the banner. `set -u` safety: the `${FRESHELL_E2E_BACKEND:-}` forms keep the unbound case rendering as `default`.)

And in the cloud banner block, add one line after the `Args:` line (currently :515):

```bash
  echo "[e2e-cloud]   Config:  test/e2e-browser/playwright.cloud.config.ts (CLOUD_SKIP_SPECS testIgnore + CLOUD_SKIP_TITLES grepInvert apply on this lane)"
```

Then close the cloud half's automated coverage (plan review round 1, Finding 2): in `scripts/test/cloud-run-wrapper.test.sh`, inside the stubbed-cloud section — immediately after the existing `Running locally`-absence check (the `if echo "$CLOUD_STUB_OUTPUT" | grep -q "Running locally"; then ... fi` block at :212) — add:

```bash
# cloud-path provenance (kata 67jt, gate-integrity half): the cloud lane
# must self-identify its CONFIG file and the selection rules in force.
if ! printf '%s' "$CLOUD_STUB_OUTPUT" | grep -q 'Config:  test/e2e-browser/playwright.cloud.config.ts'; then
  echo "FAIL: cloud path is missing the Config provenance line"
  printf '%s' "$CLOUD_STUB_OUTPUT" | tail -20
  rm -rf "$STUB_DIR"
  exit 1
fi
```

(Mirror the suite's exact failure idiom — `echo "FAIL: ..."`, `tail -20` context, `rm -rf "$STUB_DIR"`, `exit 1`, as the :212 check does; there is no `fail()` helper in this suite. The grep target string must equal the banner line added above, so keep both literals in sync. `$CLOUD_STUB_OUTPUT` is the same captured cloud-path output the :212 check consumes.)

- [ ] **Step 4: Run the focused test**

Run: `npm run test:e2e:helpers -- e2e-cloud-lane-banner`

Expected: PASS

- [ ] **Step 5: Refactor while green**

No refactor needed — a two-line banner extension, one behavior test, and one wrapper-suite check; nothing to consolidate.

- [ ] **Step 6: Run impacted-test verification**

The banner change touches the wrapper every e2e invocation uses. Two impacted consumer sets: (a) the helpers suite the new file joins; (b) `scripts/test/cloud-run-wrapper.test.sh` — the established wrapper-output suite (its local-path greps at :127/:146 match `Running locally`, the cloud-path check at :212 asserts that substring's absence, the image-tag/arg checks at :218-247 and :293+ pin invocation shape, and this task's new cloud `Config:` provenance check extends the stubbed-cloud section); the j90s run used exactly this suite as the impacted set for a wrapper change (see `reports/load-bearing-finder.md`, LB-4). It has no package.json script (verified) — run it directly. Caveat: it executes real local Playwright through the base config's globalSetup (a dist rebuild), so it runs from this worktree, never from the main checkout (the prebuild guard fails closed there while production is live). Nothing in `src/` changes, so `npm run typecheck:client` is unaffected (tsconfig.json covers only `src`, `shared`, `config/vite`).

Run: `npm run test:e2e:helpers && bash scripts/test/cloud-run-wrapper.test.sh`

Expected: PASS — the full helpers suite including the pre-existing selection/fixture/leak-metrics pins, and the wrapper suite (all its banner greps are substring matches on the preserved `Running locally` prefix; the cloud-path absence assertion is unaffected by a local-path-only extension; the new cloud `Config:` check passes with the banner line in place)

- [ ] **Step 7: Commit the task**

```bash
git add scripts/e2e-cloud.sh scripts/test/cloud-run-wrapper.test.sh test/e2e-browser/helpers/e2e-cloud-lane-banner.test.ts
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

### Task 3: freshopencode-db-history deflake (kata 5prk) — AMENDED after the first implementation attempt's evidence

**Amendment provenance (2026-09-16):** the first implementer (report: `<git-dir>/usual-sdd/task-003-report.md`, no commit — worktree reverted clean at a1cd9f437) live-proved the locator treatment AND discovered that two of the spec's three tests have been DETERMINISTICALLY red since 2026-06-15: their audit assertions await the fake's CLI `opencode run` audit event, a delivery path retired by 56c55ac97 ("rewrite adapter create+send over opencode serve HTTP/SSE") — the product is serve-only (Rust: `opencode_ws.rs` `create_session` → `prompt_async`, serve.rs; no `Command::new(... run ...)` anywhere in crates/). The spec is CLOUD_SKIP_SPECS-listed, so the cloud gate never runs it and no focused measurement ever surfaced the break (the Sept-16 lane failures fired at earlier assertions first: the strict-mode violation at :284 and the run-audit poll timeout at :356-362 ARE the stale layer under load, not starvation). Test :379's placeholder-repair pipeline additionally does not complete even unloaded at 60s (pane never adopts the seeded session; sidebar discovery works) — cause un-diagnosed (test-setup drift vs product regression). The lane evidence therefore conflated TWO layers: the load-dependent strict-mode flake (real, fixed below) and a pre-existing deterministic stale-contract layer (Form A at base_ref by construction — it reproduces anywhere, any load). Spot-verified by the orchestrator: the fake's serve flow writes `prompt_async` audit events carrying the prompt text (fake-opencode.cjs:1244-1254); the fake retains the retired `run` subcommand (fake-opencode.cjs:588-595) which nothing invokes.

**Files:**
- Modify: `test/e2e-browser/specs/freshopencode-db-history.spec.ts` — `:283-284` (test :245 first leg, scoped locator + forced-ambiguity poll), `:304-305` (test :245 post-reload leg, scoped locator), `:315-316` (test :245 audit pair, re-specified to the serve contract), test :324 (serve-era investigation + rewrite or class-(f) disposition), `:461-462` (test :379, scoped locator + diagnosis with retained logs)
- Test: the spec itself (the e2e run is the behavior-protecting test)

**Interfaces:**
- Consumes: the spec's own donor helpers (`getFreshOpencodePaneState`, `sendFreshAgentPrompt`, `installFakeOpencode`, `seedLegacyOpencodeSession`); the fake-opencode PATH seam; the app's auto-title pipeline (first prompt copied into tab/pane/session titles — the documented behavior that produced the observed strict-mode violation); the fake's `prompt_async` audit event (serve-era delivery proof).
- Produces: nothing cross-task. All changes stay inside this spec file; the describe's declared `test.setTimeout(180_000)` (:243) is untouched. NO production/server change is in this task's scope — if :379's diagnosis shows a product regression, it is kata-filed and class-(f) dispositioned, NOT fixed here.

- [ ] **Step 1: Restore the validated locator treatment (RED first)**

Re-apply the first implementer's reverted diff (report §1, byte-for-byte) in two parts. First the forced-ambiguity poll before the current `:284` bare assertion, and run the focused test to observe the strict-mode red OR its documented contingency:

```ts
      await expect(page.getByText(response)).toBeVisible({ timeout: 30_000 })
      await expect.poll(async () => page.getByText(prompt).count(), { timeout: 30_000 }).toBeGreaterThan(1)
      await expect(page.getByText(prompt)).toBeVisible({ timeout: 30_000 })
```

Run: `npm run test:e2e:local -- test/e2e-browser/specs/freshopencode-db-history.spec.ts --grep "restores Freshopencode turns from DB history"`

Expected: FAIL — the count-poll proves propagation live; the bare assertion throws the lane's strict-mode violation when the title sweep wins, OR (documented by the first attempt, unloaded) the durable session title overwrites the prompt title before the bare assertion re-queries and the test proceeds to the stale-audit failure at :326 — in that case the lane-log strict-mode red (quoted in the first attempt's report §2.2) stands as the locator red; record which branch you observed. Do NOT delete the poll: it stays permanently (it makes the ambiguity condition deterministic for every future run).

- [ ] **Step 2: Scoped locators (GREEN for the locator layer)**

Replace the bare prompt assertions with the transcript-scoped locator (the sibling repro's idiom) — both `:284` legs in test :245:

```ts
      const transcript = page.locator('[data-context="fresh-agent-transcript"]')
      await expect(transcript.getByText(prompt, { exact: true })).toBeVisible({ timeout: 30_000 })
```

and the post-reload leg at `:304`:

```ts
      await expect(transcript.getByText(prompt, { exact: true })).toBeVisible({ timeout: 30_000 })
```

- [ ] **Step 3: Re-specify test :245's audit pair to the serve contract (the retired `run` event is architecturally impossible)**

At `:315-316` (HEAD numbering), replace the stale pair —

```ts
      expect(auditEvents.some((event) => event.event === 'run' && event.prompt === prompt)).toBe(true)
      expect(auditEvents.some((event) => event.event === 'export')).toBe(false)
```

— with the serve-era equivalent (delivery proof: the fake writes `prompt_async` carrying the prompt text on the real turn path):

```ts
      expect(auditEvents.some((event) => event.event === 'prompt_async' && event.prompt === prompt)).toBe(true)
      expect(auditEvents.some((event) => event.event === 'export')).toBe(false)
      expect(auditEvents.some((event) => event.event === 'run')).toBe(false)
```

(The added third assertion pins the RETIREMENT itself: a serve-era turn must never write the CLI `run` event — the test now protects the current contract in both directions.) Run the focused test; expected: test :245 now passes end-to-end. If the `prompt_async` event's shape differs (read fake-opencode.cjs:1244-1258 first and match the real field names), adapt the assertion to the actual serve contract and record the adaptation — never loosen to a vacuous check (e.g., do not drop the prompt-equality).

- [ ] **Step 4: Test :324 — investigate the serve-era guarantee, then rewrite or disposition**

Test :324's premise (CLI `run` output omitting the top-level sessionID; the pane must not infer session ids from DB rows) tests the retired CLI path. Investigate whether the underlying GUARANTEE has a serve-era equivalent: read the Rust placeholder/session-id rules (`crates/freshell-opencode/src/opencode_ws.rs` — session materialization, placeholder resolution, DB-row adoption rules) and the test's own seeding to determine what "never materialize from DB rows without a session id" means post-56c55ac97.

- If a serve-era equivalent guarantee exists: rewrite the test around it (keep the test's protective intent: a pane must not adopt a DB session it was never bound to), with the same audit-shape honesty as Step 3 (assert the real events, both directions where meaningful). Run focused; expected PASS.
- If NO equivalent guarantee exists (the guarantee itself was part of the retired CLI contract): the test protects nothing in the current product — record that finding with code citations, leave the test failing as-is, and disposition it class (f) (Task 8's amended table). Do NOT delete or skip the test in this run (coverage-reduction requires the user's decision — the recap asks).

- [ ] **Step 5: Test :379 — diagnose with retained logs, then fix-or-disposition**

Re-apply the scoped locator at `:461` (the same transcript idiom; keep the `:462` response assertion unchanged). Then diagnose why the placeholder-repair pipeline stalls (first attempt's evidence: sidebar row discovered, pane never adopts the seeded session, no alert, 60s insufficient even unloaded). Retain the Rust server log this run: before the spec's `finally` cleanup removes the tmp root, copy the server's logDir contents into the test-results dir (or run once with `FRESHELL_LOG_DIR` pointing at a retained path) — the first attempt flagged log loss as the gap. Read the logs against `crates/freshell-opencode` placeholder/repair code paths.

- If the diagnosis shows TEST-SIDE drift (the June-era dispatched pane content shape no longer matches today's repair contract — the server expects a different placeholder/sessionRef shape than the test seeds): fix the test's seeding to the current contract; run focused; expected PASS.
- If the diagnosis shows a PRODUCT regression (the server should repair the placeholder but doesn't): do NOT fix production in this task — file a kata (product bug, new family, with the log evidence), leave the test failing as-is, disposition class (f), and record the kata ID in the task receipt and progress ledger.

- [ ] **Step 6: Run the focused spec and record the honest per-test outcome**

Run: `npm run test:e2e:local -- test/e2e-browser/specs/freshopencode-db-history.spec.ts`

Expected: test :245 PASS (locator + serve-era audit contract). Tests :324/:379: PASS if Steps 4/5 landed a serve-era rewrite/test-side fix; otherwise FAILED with the class-(f) disposition recorded per Step 4/5 (the task still commits — the locator layer and the audit re-spec are complete, verified work; the receipts must state exactly which legs pass and which are class-(f) with their evidence paths).

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/freshopencode-db-history.spec.ts
git commit -m "test(e2e): deflake freshopencode-db-history flake layer (scoped locators, forced-ambiguity poll) + re-specify the audit pair to the serve contract (kata 5prk)"
```

(If Steps 4/5 produced dispositions rather than rewrites, the commit message stays the same — the receipt, not the message, carries the per-leg outcomes.)

### Task 4: freshopencode-first-send deflake — poll the status broadcast instead of a one-shot read (kata 5prk)

**Files:**
- Modify: `test/e2e-browser/specs/freshopencode-first-send-reload-repro.spec.ts:178-181`
- Test: the spec itself

**Interfaces:**
- Consumes: the spec's `getFreshOpencodePaneState(page)` (:109-123), the `FAKE_OPENCODE_HANG_SESSION_CREATE=1` server env (:66 — pins the turn in flight so `running` is a stable steady state), and the audit-file poll at :173-176.
- Produces: nothing cross-task. The describe's declared `test.setTimeout(90_000)` (:134) is untouched; the 30s poll bound is an explicit per-assertion literal inside that envelope. Sizing rationale (corrected per `reports/load-bearing-validator-LB-6.md`): the full-chain all-max worst case (~239.5s pre-change, ~269.5s post) ALREADY exceeded the 90s envelope with passing history, so all-max arithmetic was never this envelope's property — the operative regime is the criterion (the 15s one-shot position is where the old bound demonstrably fired under load in all three runs; the whole body passes unloaded in seconds; the envelope is PR-#785-frozen). No `test.setTimeout` declaration is added; the new bound's loaded reachability is gate-measured by Task 8's local lane runs.

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

### Task 5: opencode-restart-recovery deflake — load-tolerant budgets + the RustServer kill seam (kata mv9m)

**Files:**
- Modify: `test/e2e-browser/specs/opencode-restart-recovery.spec.ts:201` (`waitForOpenCodeSessions` budget), `:823` (REST sessionRef poll budget). The `:525` call site (`await server1.kill('SIGKILL')`) is NOT changed — it becomes valid once the helper seam below exists.
- Modify: `test/e2e-browser/helpers/rust-server.ts` (add a public `kill(signal)` method after `restartAbrupt()`, which ends at :495)
- Test: the spec itself (the e2e run is the behavior-protecting test — the deterministic TypeError red below is the strongest possible anchor), plus the helper's own behavior spec in Step 6

**Interfaces:**
- Consumes: the spec's donor helpers `waitForOpenCodeSessions` (:184-203) and `waitForRunningTerminals` (:205+, unchanged), `runRestartScenario` (:449+), and the fake-opencode PATH seam; `RustServer`'s existing process-group kill machinery — `restartAbrupt`'s group-SIGKILL half (rust-server.ts:466-492), `ownedDescendantPids`, and `reapSurvivingChildren` (:675-698) — under the class's documented process-group ownership contract (:25-35).
- Produces: `RustServer.prototype.kill(signal: NodeJS.Signals = 'SIGKILL'): Promise<void>` — a hard process-group kill WITHOUT reboot (the caller owns the restart decision), consumed by the spec's kill branch (:525). Nothing cross-task; `restart()`/`restartAbrupt()`/`stop()` are untouched. The describe's declared `test.setTimeout(240_000)` (:627) is untouched; each raised literal is individually well inside it. Adjacent budgets that did NOT fail (`waitForRunningTerminals` 45s, picker/dialog 15s waits) are deliberately left alone.

**Diagnosis:** all six failing tests timed out inside two fixed sub-budgets while each owned-server + fake-CLI-PTY + discovery/association pipeline ran under 48-way parallelism (plus cargo-lock storms): five at `waitForOpenCodeSessions`' 30s `page.waitForFunction` (spawn → session-event → association → broadcast pipeline) and one at the :714 test's 15s `expect.poll` over `GET /api/terminals` (gate-release → session-event → association-scan → REST reflection). Every observed failure was a latency overrun, never a wrong value. Evidence class (per `reports/load-bearing-validator-LB-1.md`): gate-measured — this spec is cloud-skip-listed, contributed zero tests to the prior focused cloud rerun, and has zero loaded or unloaded passes anywhere in the corpus; the raises' sufficiency is proven only by Task 8's local lane runs.

**Second, deterministic defect (NEW, per `reports/load-bearing-validator-LB-6.md` §5):** the `kill` restart-mode branch at :525 calls `await server1.kill('SIGKILL')`, but `RustServer` has NO public `kill` method (public API: `restart()` :439, `restartAbrupt()` :461, `stop()` :497; the process-group kill machinery is private — `killCurrentProcess` :629). Reaching :525 therefore throws `TypeError: server1.kill is not a function` — a deterministic terminal failure no budget raise can fix — so the :1053 test ("restores multiple OpenCode panes after hard server kill") can NEVER pass as written. It was masked in all three loaded runs because they died earlier at the :488 wait. The fix decision, made from the source: `restartAbrupt()` is NOT the right substitute — it kills AND reboots on the same port, which would collide with the spec's own `server2` (constructed at :528-536 and started at :536 on `info1.port`). The spec needs a method that kills WITHOUT rebooting: a public `kill(signal)` on `RustServer`, mirroring `restartAbrupt`'s group-kill semantics (group-SIGKILL + ownership-safe descendant sweep) minus the boot.

- [ ] **Step 1: Reproduce the failing conditions as far as they are focusedly reproducible (deterministic TypeError red + bound-liveness mutation)**

1. Deterministic red (the kill seam): run the :1053 test focused locally with NO changes — unloaded, the pre-kill waits (`waitForOpenCodeSessions` at :488/:497) pass in seconds and the test reaches :525.
2. Bound-liveness mutation (the budget raises): temporarily change the `waitForOpenCodeSessions` budget at :201 from `{ timeout: 30_000 }` to `{ timeout: 1 }`.

- [ ] **Step 2: Run the tests and verify the intended failures**

Run: `npm run test:e2e:local -- test/e2e-browser/specs/opencode-restart-recovery.spec.ts --grep "restores multiple OpenCode panes after hard server kill"`

Expected: FAIL with `TypeError: server1.kill is not a function` raised inside `runRestartScenario` — the deterministic red proving the kill seam is broken (the first deterministic red of this run; no mutation needed, no load needed).

Run: `npm run test:e2e:local -- test/e2e-browser/specs/opencode-restart-recovery.spec.ts --grep "reattaches a UI-created OpenCode pane"`

Expected: FAIL with `TimeoutError: page.waitForFunction: Timeout 1ms exceeded` raised from `waitForOpenCodeSessions` (:185) — the exact stack of the five lane failures (which read `Timeout 30000ms exceeded` at the same frame), proving the budget literal is live, not decorative. The REAL red for the raises is the lane evidence: five tests at this frame with 30000ms exceeded plus one `expect.poll` 15000ms overrun at :813. Revert the mutation.

- [ ] **Step 3: Add the minimal production implementation**

1. In `test/e2e-browser/helpers/rust-server.ts`, add the public kill method after `restartAbrupt()` (ends :495), before `stop()` (:497):

```ts
  /**
   * HARD-kill the current server process WITHOUT rebooting and WITHOUT the
   * graceful shutdown path (no SIGTERM first, no clean WS close frames, so
   * the server's own PTY-reaping Drop path never ran — see the class doc
   * comment's process-group boundary). Same kill semantics as
   * `restartAbrupt`'s first half: signal the server's OWN process group
   * (negative pid — ownership-safe by construction), then run the
   * ownership-safe descendant sweep (`reapSurvivingChildren`) as the
   * PRIMARY reap, since the graceful reap never ran. Unlike
   * `restartAbrupt`, does NOT boot a replacement: the caller owns the
   * restart decision (e.g. opencode-restart-recovery boots its own
   * server2 bound to the same port and token).
   */
  async kill(signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
    const proc = this.process
    const pid = proc?.pid
    this.process = null

    if (!proc || !pid) return

    const childPidsBeforeKill = ownedDescendantPids(pid)

    await new Promise<void>((resolve) => {
      // Signal delivery is effectively immediate, but keep a hard cap so a
      // pathological wait can never hang the fixture.
      const timeout = setTimeout(resolve, 5000)
      proc.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
      try {
        // Negative pid targets the server's OWN process group only (see the
        // class doc comment and `killCurrentProcess` for the ownership
        // rationale). Does NOT reach PTY shell children — the sweep below
        // backstops those.
        process.kill(-pid, signal)
      } catch {
        clearTimeout(timeout)
        resolve()
      }
    })

    await this.reapSurvivingChildren(childPidsBeforeKill)
  }
```

(Additive only — `restartAbrupt`'s body is deliberately NOT refactored to delegate; see Step 5.)

2. At `opencode-restart-recovery.spec.ts:201`: `{ timeout: 30_000 }` → `{ timeout: 60_000 }` (2x the observed-firing budget, per the corrected sizing discipline).
3. At `:823` (the :714 test's REST association poll): `{ timeout: 15_000 }` → `{ timeout: 30_000 }` (2x).

- [ ] **Step 4: Run the focused tests**

Run: `npm run test:e2e:local -- test/e2e-browser/specs/opencode-restart-recovery.spec.ts --grep "reattaches a UI-created OpenCode pane|restores multiple OpenCode panes after hard server kill"`

Expected: PASS — both the budget-raised reattach test and the kill-mode test (which now survives :525, boots its own server2, and completes the post-kill restore assertions).

- [ ] **Step 5: Refactor while green**

Considered and rejected: extracting `restartAbrupt`'s group-kill half into a shared private helper that both `restartAbrupt` and `kill` call. It would put `restartAbrupt`'s 30+ call sites across ~20 restart-resilience specs into this task's impacted set for zero behavior change — the additive method keeps the blast radius bounded (DRY yields to the bounded-impacted-set rule for a deflake run; the ~25-line parallel is documented against `restartAbrupt`'s doc comment). No refactor.

- [ ] **Step 6: Run impacted-test verification**

`waitForOpenCodeSessions` is called by all six tests in this file (the loop at :486-489, :497, :665, and inside `runRestartScenario` used by the three restart tests), and the REST poll only by the :714 test — all inside this file; no other spec imports these donor helpers (the per-spec-ownership convention keeps them copied). The helper change is purely additive (no existing method touched), so `restartAbrupt`'s many callers are provably unimpacted; the helper's own behavior contract is additionally pinned by `test/e2e-browser/specs/harness-01-rust-server.spec.ts` ("boots, survives restart, and reaps only its own process group"), which exercises the same class methods and must stay green. The impacted set is the whole spec's focused run plus that helper spec:

Run: `npm run test:e2e:local -- test/e2e-browser/specs/opencode-restart-recovery.spec.ts test/e2e-browser/specs/harness-01-rust-server.spec.ts`

Expected: PASS (all six restart-recovery tests plus the helper spec; each boots its own Rust server, so allow several minutes)

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/opencode-restart-recovery.spec.ts test/e2e-browser/helpers/rust-server.ts
git commit -m "test(e2e): deflake opencode-restart-recovery (60s session/30s REST budgets; public RustServer.kill for the hard-kill branch)"
```

### Task 6: fresh-agent settings-modal waits (kata vpfr, cloud-legal member)

**Files:**
- Modify: `test/e2e-browser/specs/fresh-agent.spec.ts:1847`, `:1899`, `:1946` (the three `getByRole('tab', { name: /^Coding Agents$/i })` visibility budgets)
- Test: the spec itself

**Interfaces:**
- Consumes: the shared `freshellPage` fixture chain (fixtures.ts — untouched) and the spec's `seedCollapsePane` helper (:94-137, route-mocked freshcodex pane; zero provider machinery).
- Produces: nothing cross-task. The file declares NO `test.setTimeout` (config default 60s, untouched); the raises are per-assertion literals inside that default. Sizing rationale (corrected per `reports/load-bearing-validator-LB-6.md`): the all-max worst-case body of :1831 (~190s pre-change, ~200s post — dominated by unbudgeted asserts counted at their 10s ceiling) ALREADY exceeded the 60s deadline with both loaded and unloaded passing history, so "the body fits 60s" was never true in the all-max reading — the operative regime is the criterion: the 5s bounds demonstrably fired at exactly these three sites under load (six `Timeout: 5000ms` instances), unloaded the whole bodies fit ≤9s (rerun dispatch timing), and the 15s raise exceeds the entire unloaded body duration. No declaration is added; the escalation ladder below stays the armed instrument, and full new-bound reachability is gate-measured.

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

**Escalation ladder (gate-evidence-driven, stays inside this task if needed):** if Task 8's lane runs show a terminal failure at these waits, raise to `{ timeout: 30_000 }` (per-assertion literal; allowed by the Global Constraints — the modal tab wait's operative chain at 30s remains within the 60s default deadline under the operative-regime criterion, per `reports/load-bearing-validator-LB-6.md`). If a terminal failure persists at 30s, do NOT raise further and do NOT add any `test.setTimeout` declaration — the inviolable constraints (declared envelopes untouched, PR #785 declared-timeout pins byte-identical) leave no budget-only escape at that point. Instead treat it as a falsified budget-race hypothesis for this family: investigate the stall driver under lane load (the gate run's failure output is the evidence; the modal is route-mocked with zero providers, so a >30s stall indicates a harness/store defect or a load-amplification mechanism, not starvation), and bring the finding back through the run's review loop as a plan amendment — the amendment, not the implementer, decides whether a declared-envelope change (and the corresponding PR #785 contract-pin amendment) is ever justified.

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

### Task 7: fresh-agent-centralization-smoke deflake — eviction-proof capture path + explicit bounds (kata vpfr)

**Files:**
- Modify: `test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts` — `:414-423` (the `/api/panes` poll: explicit 30s bound + eviction re-send), `:425-430` (the one-shot capture fetch → eviction-proof poll; its test begins at :408 in the current file — the kata ledger cites it as :401 from the prior commit's numbering), `:259-303` (`fetchNormalizedLayoutProducedByLegacySync` gains a `page` param + explicit 30s bound + eviction re-send; its call site is :432), `:488` (the `Fresh agent` visibility, explicit 30s; its test begins at :454 — kata ledger :447), plus a permanent deterministic eviction trigger inserted after :423
- Test: the spec itself

**Interfaces:**
- Consumes: the spec's `fetchWithAuth(serverInfo, path, init?)` (:248-257) and `sendLegacyLayoutSync(page)` (:230-246 — re-consumed as the eviction re-send), the shared `freshellPage` fixture chain (untouched), the page's own layout mirror (`src/store/layoutMirrorMiddleware.ts:16-54` — change-gated on the serialized layout payload and debounced 1000ms initial / 200ms on change; consumed as the eviction source, NOT modified), and `window.__FRESHELL_TEST_HARNESS__`'s `dispatch` (the eviction trigger — the file's own `tabs/addTab` idiom at :326-342).
- Produces: nothing cross-task. The file declares NO `test.setTimeout` (60s default, untouched); the raises are per-assertion literals at the observed stall points (the r1 capture 404; the r3 `/api/panes` implicit-10s stall; the :488 implicit-10s visibility). Sizing note (per `reports/load-bearing-validator-LB-6.md`): the capture test's all-max body (~71s pre-change) already exceeded the 60s deadline with a loaded pass in the corpus (transience-proven) — no all-max fit is claimed and no `test.setTimeout` declaration is added; reachability is gate-measured (Task 8), with the vpfr escalation ladder (Task 6) as the family's armed instrument.

**Diagnosis (corrected per `reports/load-bearing-validator-LB-2.md` — the original propagation-race framing was FALSIFIED):** the capture test (kata ledger :401; begins at :408 in the current file) failed at :425-426 with `Expected: 422 / Received: 404`, and in the base-ref run the same test failed EARLIER, at the `/api/panes` poll (:414-423), with `Received: []` sustained for a full 10s window. There is NO layout-sync → pane-registry propagation to wait out: the capture route and the `/api/panes` poll read the SAME server-side LayoutStore, whose ingest normalizes `agent-chat` → `fresh-agent` atomically before the pane is visible to either reader (same-key retain-drop at `crates/freshell-freshagent/src/layout_store.rs:292-300`; connection-keyed ingest at `crates/freshell-ws/src/terminal.rs:1588`). By elimination (see the validator's full decision-tree trace), the 404/empty states require the crafted legacy layout entry to have been EVICTED mid-test by the page's own debounced `ui.layout.sync` — the layout mirror sends the REAL Redux layout on the same WsClient and hence the same connection key, so the server's same-key ingest REPLACES the crafted entry — and NO writer re-inserts `pane-legacy-agent` before the test's render step (:433, which is sequenced after the capture). A bare poll-until-422 would therefore re-time the failure (instant 404 → 30s timeout) without fixing it; the fix must be eviction-proof (re-send the crafted sync whenever the evicted state is observed, then keep polling for the pinned 422). The settings test (kata ledger :447; begins at :454 in the current file) failed at :488 waiting for the `Fresh agent` settings text at the 10s default expect timeout — the same settings-modal render starvation as Task 6 (gate-measured class). The spec is cloud-absent BY DESIGN (cloud selection at main is already clean; Task 2 pins it as a tested contract) — the local lane is where it must hold.

- [ ] **Step 1: Reproduce the failing conditions as far as they are focusedly reproducible (deterministic eviction reds + bound-liveness mutation)**

Three temporary states, each run then superseded (the Task 2 mutation-red pattern):

1. **RED A — the deterministic eviction (the C2 red):** temporarily insert, between the `/api/panes` poll and the CURRENT one-shot capture fetch, the eviction trigger plus an await that the eviction landed:

```ts
    // TEMPORARY red-phase trigger (Step 3 keeps a permanent version):
    // dispatch a layout-visible change through the harness so the page's
    // own mirror MUST re-sync (change-gated, 200ms debounce) and evict the
    // crafted entry — the final-head lane window, now under the test's own
    // control.
    await page.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'tabs/addTab',
        payload: { id: 'tab-eviction-trigger', title: 'Eviction trigger', status: 'running' },
      })
    })
    await expect.poll(async () => {
      const capture = await fetchWithAuth(serverInfo, '/api/panes/pane-legacy-agent/capture')
      return capture.status
    }, { timeout: 5_000 }).toBe(404)
```

2. **RED B — the bare-poll falsifier (LB-2's mechanism demonstrated live):** temporarily move that same trigger BEFORE the `/api/panes` poll, leave the poll in its CURRENT bare shape but give it the planned explicit 30s bound (`}, { timeout: 30_000 })`), and remove the eviction-await (not needed — the poll itself now observes the evicted state).

3. **RED C — the :488 bound-liveness mutation:** temporarily change :488 to `await expect(page.getByText('Fresh agent')).toBeVisible({ timeout: 1 })`.

- [ ] **Step 2: Run the tests and verify the intended failures**

RED A — Run: `npm run test:e2e:local -- test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts --grep "normalizes remote legacy layout sync"`

Expected: FAIL — the eviction-await PASSES (the capture status deterministically reaches 404: the crafted entry is GONE, proven live — not a mid-sync transient), then the CURRENT one-shot capture assertion fails with `Expected: 422 / Received: 404`, the exact final-head lane shape, now deterministic. Remove RED A's temporary block.

RED B — Run: `npm run test:e2e:local -- test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts --grep "normalizes remote legacy layout sync"`

Expected: FAIL — the `/api/panes` poll returns `Received: []` for its ENTIRE 30s bound and fails at 30s: after the eviction nothing re-inserts the pane, so the bare poll cannot converge (the validator's falsifier, demonstrated live rather than statically). This red is what the re-send machinery in Step 3 exists to close. Remove RED B's temporary block.

RED C — Run: `npm run test:e2e:local -- test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts --grep "keeps fresh-agent settings"`

Expected: FAIL with `Timeout: 1ms exceeded`, `element(s) not found` for `getByText('Fresh agent')` — the exact lane failure shape (which read `Timeout: 10000ms`), proving the visibility bound is live. Revert RED C.

The REAL red for both stall points is the lane evidence (r1's 404 at the one-shot capture; r3's `Received: []` 10s stall at the `/api/panes` poll).

- [ ] **Step 3: Add the minimal production implementation**

1. At :414-423, give the `/api/panes` poll its explicit 30s bound and the eviction re-send:

```ts
    await expect.poll(async () => {
      const response = await fetchWithAuth(serverInfo, '/api/panes?tabId=tab-remote-legacy')
      const body = await response.json()
      const panes: Array<{ id?: string }> = body?.data?.panes ?? []
      if (!panes.some((pane) => pane.id === 'pane-legacy-agent')) {
        // Evicted by the page's own debounced mirror sync (same WS
        // connection key): the server's same-key ingest REPLACED the
        // crafted entry, and no writer re-inserts it before the render
        // step — re-craft it (per reports/load-bearing-validator-LB-2.md).
        await sendLegacyLayoutSync(page)
      }
      return panes
    }, { timeout: 30_000 }).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'pane-legacy-agent',
        kind: 'fresh-agent',
      }),
    ]))
```

2. Insert the PERMANENT deterministic eviction exercise right after that poll (RED A's block, kept — with its eviction-landed poll raised to the family's 30s bound: the red-phase temporary copy may keep 5s because it runs focused/unloaded, but the permanent copy runs under full-lane 48-worker load where related layout observations already exceeded 5-10s; a 5s prerequisite here would replace the original flake with its own timeout — plan review round 3, Finding 2): the `tabs/addTab` dispatch through the harness plus the `expect.poll(..., { timeout: 30_000 }).toBe(404)` await that the eviction landed. This converts the lane's load-dependent eviction into a condition the test exercises every run, in the exact final-head window (between the panes read and the capture read).

3. At :425-430, replace the one-shot capture fetch with the eviction-proof poll:

```ts
    // Capture contract: the pinned answer is 422 "pane kind \"fresh-agent\"
    // is unsupported for capture-pane". The crafted entry is evictable at
    // any pre-render moment by the page's own debounced ui.layout.sync (the
    // mirror sends the REAL Redux layout on the same WsClient; the server
    // keys layout-store entries by connection id and same-key ingest
    // replaces the crafted entry). After eviction NO writer re-inserts
    // pane-legacy-agent before the render step, so a bare poll would re-time
    // the failure (every iteration 404 until the bound). Re-send the
    // crafted sync whenever the evicted state (404) is observed and keep
    // polling for the pinned contract answer; any other non-422 status
    // fails the contract assertion loudly at the bound.
    await expect.poll(async () => {
      const capture = await fetchWithAuth(serverInfo, '/api/panes/pane-legacy-agent/capture')
      if (capture.status === 404) {
        await sendLegacyLayoutSync(page)
        return { status: 404 }
      }
      const body = await capture.json().catch(() => undefined)
      return { status: capture.status, bodyStatus: body?.status, message: body?.message }
    }, { timeout: 30_000 }).toMatchObject({
      status: 422,
      bodyStatus: 'error',
      message: expect.stringContaining('pane kind "fresh-agent"'),
    })
```

4. In `fetchNormalizedLayoutProducedByLegacySync` (:259-303), add a leading `page: Page` parameter, give its `expect.poll` the explicit 30s bound, and add the same eviction re-send when the normalized snapshot lacks the pane (the hazard window spans EVERY pre-render read — the validator's writer enumeration shows nothing re-inserts until the render step at :433; its call site at :432 becomes `fetchNormalizedLayoutProducedByLegacySync(page, serverInfo, 'tab-remote-legacy')`):

```ts
async function fetchNormalizedLayoutProducedByLegacySync(page: Page, serverInfo: E2eServerInfo, tabId: string): Promise<LayoutSnapshot> {
  await expect.poll(async () => {
    const response = await fetchWithAuth(serverInfo, `/api/layout/snapshot?tabId=${encodeURIComponent(tabId)}`)
    const body = await response.json()
    const layout = body?.data?.layouts?.[tabId] as PaneNode | undefined
    const leaves = collectLeaves(layout)
    if (!leaves.some((leaf) => leaf.id === 'pane-legacy-agent')) {
      // Same eviction exposure as the two reads above (same hazard window):
      // re-craft — nothing re-inserts the pane before the render step.
      await sendLegacyLayoutSync(page)
    }
    return leaves.map((leaf) => ({
      id: leaf.id,
      kind: leaf.content?.kind,
      createRequestId: leaf.content?.createRequestId,
    }))
  }, { timeout: 30_000 }).toEqual(expect.arrayContaining([
    { id: 'pane-legacy-agent', kind: 'fresh-agent', createRequestId: 'req-legacy-agent' },
    { id: 'pane-legacy-agent-nested', kind: 'fresh-agent', createRequestId: 'req-legacy-agent-nested' },
    { id: 'pane-shell', kind: 'terminal', createRequestId: 'req-shell' },
  ]))

  // The follow-up one-shot snapshot fetch has the SAME adjacent-read
  // eviction exposure (an eviction can land between the poll's success and
  // this fetch — plan review round 3, Finding 1): shield it too. The poll
  // hands the snapshot out via closure once the entry is present.
  let snapshot: LayoutSnapshot | undefined
  await expect.poll(async () => {
    const response = await fetchWithAuth(serverInfo, `/api/layout/snapshot?tabId=${encodeURIComponent(tabId)}`)
    if (response.status !== 200) return { status: response.status, present: false }
    const body = await response.json()
    const candidate = body.data as LayoutSnapshot
    if (!collectLeaves(candidate.layouts[tabId]).some((leaf) => leaf.id === 'pane-legacy-agent')) {
      await sendLegacyLayoutSync(page)
      return { status: response.status, present: false }
    }
    snapshot = candidate
    return { status: response.status, present: true }
  }, { timeout: 30_000 }).toMatchObject({ status: 200, present: true })
```

(the remainder of the helper — the `serialized`/leaf assertions and the `return snapshot` — runs unchanged against the now-protected `snapshot` closure value; `snapshot!` is safe because the poll cannot pass without setting it).
```

Liveness note for this fourth literal: unloaded, the fast path sees the re-sent entry immediately and passes even at a dead bound, so an isolated mutation red is not feasible without fabricating eviction timing; its bound is the same expect.poll mechanism proven live by RED B, and its re-send is the same machinery exercised deterministically every run by the permanent trigger (item 2). The eviction re-send, not the bound, is the load-bearing change here.

5. At :488, make the visibility budget explicit and load-tolerant (the observed failure was the 10s default):

```ts
    await expect(page.getByText('Fresh agent')).toBeVisible({ timeout: 30_000 })
```

- [ ] **Step 4: Run the focused test**

Run: `npm run test:e2e:local -- test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts --grep "normalizes remote legacy layout sync|keeps fresh-agent settings"`

Expected: PASS — with the deterministic eviction exercised every run: the trigger evicts, the await proves the 404 state landed, and the eviction-proof capture poll re-sends and converges on the pinned 422 with its full contract-body assertion.

- [ ] **Step 5: Refactor while green**

Considered and rejected: extracting the re-send-on-evicted-observation discipline into a shared helper. The three polls observe different shapes (panes array membership / capture status / layout leaves), so an abstraction would take a callback per read and obscure each read's own contract; the two-line evicted-observation check stays inline at each read, mirroring the file's existing per-helper ownership convention. The trigger uses the file's own `tabs/addTab` dispatch idiom (:326-342). No refactor.

- [ ] **Step 6: Run impacted-test verification**

File-local changes inside two tests; no shared surface touched (the spec owns `fetchWithAuth`/`sendLegacyLayoutSync` copies; the layout mirror is consumed, not modified). The impacted set is the whole spec's focused run:

Run: `npm run test:e2e:local -- test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts
git commit -m "test(e2e): deflake fresh-agent-centralization-smoke (eviction-proof capture path, 30s explicit bounds)"
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

Run (twice, sequentially; each ~25-30 min on the 96-core host). Logs go to the run's durable reports directory under run-scoped names — never shared fixed `/tmp` names (plan review round 2, Finding 1):

```bash
LOGS=/home/dan/code/freshell/.worktrees/.the-usual-logs/cloudlane-skip-provider-burst/reports
npm run test:e2e:local > "$LOGS/gate-e2e-local-1.log" 2>&1; echo "exit=$?"
```

**Durability rule (binding):** immediately after EACH lane exits — before any other gate command runs — write that lane's own receipt to `$LOGS/gate-e2e-local-1.md` (and `-2.md` for the second run), recording the command, the exit code, the lane banner line quoted from the log itself (post-Task-1: `[e2e-cloud] Running locally... (config: test/e2e-browser/playwright.config.ts; CLOUD_SKIP_SPECS does not apply on this lane; ...)`), and the pass/fail counts. Step 6 later EXTENDS these receipts with outcome classifications; it never back-fills evidence that did not already land durably.

Then the second run, same procedure:

```bash
npm run test:e2e:local > "$LOGS/gate-e2e-local-2.log" 2>&1; echo "exit=$?"
```

Expected: exit=0 on both runs, or exit=1 with every terminal failure OUTSIDE the named burst families and dispositioned per Step 6. Specifically: ZERO terminal failures in opencode-restart-recovery, freshopencode-db-history, freshopencode-first-send-reload-repro, fresh-agent.spec.ts, fresh-agent-centralization-smoke. Two consecutive clean-of-burst runs match the campaign's repeat standard for load-correlated flakes.

- [ ] **Step 4: Run one real CLOUD full lane at HEAD (backend pinned explicitly)**

Run (same durability rule — log to the run-scoped durable path, write `gate-e2e-cloud-1.md` immediately after exit, before any further gate command):

```bash
LOGS=/home/dan/code/freshell/.worktrees/.the-usual-logs/cloudlane-skip-provider-burst/reports
FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com \
  npm run test:e2e:cloud > "$LOGS/gate-e2e-cloud-1.log" 2>&1; echo "exit=$?"
```

(The wrapper's default shards=1 is the campaign's practiced cloud gate shape — baseline B. The image is content-addressed to the HEAD commit and builds once.)

Expected: exit=0 with a zero-flake receipt — the wrapper fails the run on ANY recovered Playwright retry (`recoveredRetryCount > 0`), so "passed with retries" is NOT gate-green by itself; an exit=1 run is acceptable ONLY when every failure and recovered retry classifies per the Step 6 table as (c) standing-ledger or (d) singleton-residual (recorded, not blocking). A recovered retry INSIDE fresh-agent.spec.ts is class (b): a gate failure for this run unless it reproduces identically at base_ref under Form A. Verify in the log/receipt: (a) the cloud banner + `Config:` line appear (Task 1's cloud-side provenance); (b) NO skip-listed spec appears in the executed roster (the 67jt contract, now also pinned by Task 2); (c) fresh-agent.spec.ts (the burst family's cloud-legal member) is green.

- [ ] **Step 5: Focused reruns of the affected specs on both lanes**

Local (all five deflaked files; same durability rule as Steps 3-4 — run-scoped durable log, receipt written immediately after exit):

```bash
LOGS=/home/dan/code/freshell/.worktrees/.the-usual-logs/cloudlane-skip-provider-burst/reports
npm run test:e2e:local -- test/e2e-browser/specs/freshopencode-db-history.spec.ts \
  test/e2e-browser/specs/freshopencode-first-send-reload-repro.spec.ts \
  test/e2e-browser/specs/opencode-restart-recovery.spec.ts \
  test/e2e-browser/specs/fresh-agent.spec.ts \
  test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts \
  > "$LOGS/gate-focused-local.log" 2>&1; echo "exit=$?"
```

Expected: PASS (all five files; note the first local invocation pays the globalSetup client+Rust build).

Cloud (the cloud-legal member only; same durability rule):

```bash
LOGS=/home/dan/code/freshell/.worktrees/.the-usual-logs/cloudlane-skip-provider-burst/reports
FRESHELL_GCP_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com \
  npm run test:e2e:cloud -- test/e2e-browser/specs/fresh-agent.spec.ts \
  > "$LOGS/gate-focused-cloud.log" 2>&1; echo "exit=$?"
```

Expected: PASS (the ~25 fresh-agent tests).

**Lane-coverage honesty for the skip-listed families (explicit):** for every skip-listed family — the four burst families (opencode-restart-recovery, freshopencode-db-history, freshopencode-first-send-reload-repro, fresh-agent-centralization-smoke) plus truly-idle-alerting — a focused CLOUD rerun selects ZERO tests BY DESIGN (Playwright 1.58.2 treats explicit positional file args as an intersection with testIgnore, so the skip-listed files contribute nothing). The cloud lane's gate role is selection integrity + no regression on the cloud-running specs; the burst families' REAL proof is the LOCAL lane runs (this step's focused local run, then Step 3's full ×2). Any focused cloud invocation that touches a skip-listed family must be reported in the receipt as `0 tests selected (expected)` (all-skip invocations fail loudly with exit 1 "No tests found" — the Task 2-pinned contract working; mixed invocations show the skip-listed member absent from the executed roster) — a vacuous focused-cloud green is NEVER coverage and must never be cited as such.

- [ ] **Step 6: Classify every observed outcome, disposition anything else, and write the receipts**

Classify FIRST against this table (every observed outcome class, per the LB-7 finding), then apply the Form A/B standard below:

| class | observed outcome | disposition |
|---|---|---|
| (a) | terminal failure in a named burst family, post-fix | gate FAIL — never disposition as pre-existing; investigate the fix and iterate within the task's escalation room |
| (b) | recovered retry in a named burst family, post-fix (e.g. a fresh-agent modal retry) | still a gate failure for this run — the fix should eliminate the retry, not just the terminal failure — UNLESS it reproduces identically at base_ref under Form A (then it is the pre-existing condition the fix narrowed, recorded as such) |
| (c) | recovered retry in a standing ledger family (d4qm / nxf6 / m8pd-class) | pre-existing exit-1 item under Form A — it fails the zero-flake receipt but is dispositioned pre-existing, recorded, NOT blocking |
| (d) | singleton flicker (freshclaude-identity-persistence-rust:528, pane-ledger-restart-rust:265, fresh-agent-control-rust:1193, truly-idle-alerting:73) | ledger residual — Form A reproduction or within-family disposition covers a recurrence; a SECOND consecutive recurrence escalates to a new kata filing in the recap (not a fix in this run) |
| (e) | any other/new family (terminal or retry, either lane) | investigate + Form A/B disposition BEFORE accepting — a new family is never automatically pre-existing |
| (f) | deterministic pre-existing failure in a NAMED family's non-flake layer (execution-discovered: e.g. freshopencode-db-history's stale CLI-`run` audit assertions, terminally red since 56c55ac97 retired the CLI path; and :379's placeholder-repair stall if diagnosed as product regression) | pre-existing deterministic break, NOT a load flake — Form A by construction (reproduces at base_ref, any load); the flake layer of the same family IS expected green post-fix; kata-filed for a dedicated modernization/repair run; recorded with its evidence path and PROMINENTLY listed in the recap for the user's follow-up decision. Such a leg does NOT fail this run's gate, and is NEVER silently skipped or deleted |

Then apply the disposition mechanics to everything that is not class (a):

- **Form A (preferred, strongest):** reproduce identically at base_ref 6ee5cf4b2 in a fresh scratch worktree, same-day environment, same lane — identical test, line, and failure shape. Record the reproduction command and log path.
- **Form B:** code-cited mechanistic impossibility (why this run's delta cannot create the failure) + population receipts (prior runs showing the same failure at base) + kata filing if it is a new recurring flake.

Ledger katas available for pre-existing disposition: hsrh (rust session-init budget under full-suite load), d4qm, nxf6, m8pd (standing cloud-evidenced e2e retry flakes), j96j-class receipts, 38hj/5kyg/ebp6 (campaign baseline). The four singleton flickers (freshclaude-identity-persistence:528, pane-ledger-restart:265, fresh-agent-control-rust:1193, truly-idle:73) are pre-recorded as within-family variance / ledger residuals — a Form A reproduction or a within-family disposition covers a recurrence; a SECOND consecutive recurrence of any singleton escalates it to a new kata filing in the recap (not a fix in this run).

Write the focused-rerun receipts the same way (durable, run-scoped, immediately after each exits): `gate-focused-local.md`, `gate-focused-cloud.md`. Then, with ALL lane receipts already durably written per-step, this step EXTENDS each receipt with its classification content: for every failure or recovered retry, its classification class plus the Form A/B evidence or burst-family absence proof; focused cloud lines touching skip-listed families record `0 tests selected (expected)` per Step 5, never as coverage.

- [ ] **Step 7: Confirm the worktree is clean and push the branch**

```bash
git status --porcelain   # expected: empty (all seven prior tasks committed their files)
git push -u origin the-usual/cloudlane-skip-provider-burst
```

(The push runs the pre-push gate's cheap checks — cargo fmt/typecheck/clippy filtered by what the push changes; a test-file-only push should be a no-op there. Bypassing with `--no-verify` is NOT authorized for this run.)

Landing: PR creation and merge happen ONLY under the campaign pre-approval — after this run's delta review finishes PASSED, open the PR targeting `main`, wait for required checks, merge, fast-forward local `main` from `origin/main`, and clean up the worktree. If the delta review does not finish PASSED, stop and ask the user before merging. Do not create the PR before that verdict.

**Definitive-gate ordering rule (plan review round 2, Finding 2):** this task's gate evidence is the EXECUTION gate — it proves the plan's implementation, not the final review state. The DEFINITIVE full-HEAD gate is the delta-review stage's own full-suite gate, per the-usual Stage 5: after the delta review loop ends, if ANY review-fix commit landed after this task's Step 7 push, the full-suite gate (standard suite + the full e2e lanes of this task, same commands, fresh run-scoped receipts) reruns ONCE at the final HEAD before the PR is created; if NO review-fix commit landed (HEAD unchanged from this task's gate), this task's receipts remain the final-HEAD evidence and no rerun is needed. The User Request's constraint ("full e2e-lane gate at the run HEAD") is satisfied by the LATER of the two — the PR may never carry lane receipts attached to a HEAD older than the PR's own branch tip.
