# GATE-01 Implementation Plan — unchanged legacy browser suite × {Node, Rust}

> df1 swarm worker plan. Analysis+execution item: the deliverable is a verified
> inventory (results table + baseline artifact + attributions + annotations),
> NOT product fixes.

**Goal:** Produce a machine-checkable record of what the unchanged legacy
browser suite says about each server kind (Node `legacy` and owned `rust`),
with every rust-red leg attributed (owning checklist item, or flake with
reproof) and every mandated `test.fail` annotation committed in campaign style.

**Architecture:** Reuse the HARNESS-02 `e2eServerKind` matrix mechanism via a
new additive Playwright config (`playwright.gate01.config.ts`) that selects
EXACTLY the legacy `chromium` project's effective spec list and runs it twice
(two projects differing only in `e2eServerKind`). A small collator folds
Playwright JSON reports into a committed baseline JSON per slice.

**Tech Stack:** Playwright 1.x, tsx, vitest (helper tests only), df1 lease
system (`acquire.sh`).

## Definitions (the contract of this item)

- **"The unchanged legacy browser suite"** = the effective test selection of
  the `chromium` project in `test/e2e-browser/playwright.config.ts` at the
  base ref: every `test/e2e-browser/specs/*.spec.ts` EXCEPT the 31 files in
  `RUST_ONLY_SPECS` (the project's `testIgnore`). At base SHA `3dbba43c2`
  that is **69 spec files**.
  - Rationale: this is precisely what runs against the Node server today via
    `npm run test:e2e:chromium` (and the match-all portion of `test:e2e`).
    `RUST_ONLY_SPECS` files hard-fail under legacy BY DESIGN (each carries a
    code comment saying why; they drive `RustServer` directly or assert
    `e2eServerKind === 'rust'`), so they were never part of the legacy suite.
  - "Unchanged" = no spec edited to change behavior-coverage; no file added
    to or dropped from the list. The ONLY permitted spec edits are additive
    conditional `test.fail(e2eServerKind === 'rust', ...)` pins with an
    owner-citing comment, per the campaign convention
    (`settings-persistence-split.spec.ts:163` is the style exemplar).
  - Inside the 69, files are tagged `bucket=harness` (8 `harness-*` probe
    specs — campaign harness self-checks, not product features) vs
    `bucket=product` (61 files). Harness probes still RUN on both legs (they
    are part of the unchanged lane); the tag exists so the evidence table can
    separate product parity from harness self-verification.
- **Leg** = one spec file run under one gate project (`gate01-legacy` =
  `e2eServerKind:'legacy'`, Node server; `gate01-rust` = `e2eServerKind:
  'rust'`, owned RustServer). **138 legs total** (69 × 2).
- **Verdicts per leg:** `pass` / `fail` / `flaky-reproven` / `skip-all`
  (every test skipped, e.g. a rust-only leg self-skipping on legacy via
  `test.skip`), with per-test detail in the baseline JSON.

## Mechanism decisions (with the evidence that forced them)

1. **New gate config instead of CLI filters.** `--project=legacy-chromium`
   is restricted by `testMatch: MATRIX_SPECS` (28 files); positional CLI file
   filters can only narrow `testMatch`, never widen it. The base config's own
   comment anticipates "a broader `testMatch` override" for this
   verification. `playwright.gate01.config.ts` imports the base config,
   inherits everything (testDir, timeouts, reporters, global setup), and
   overrides only `projects`. `RUST_ONLY_SPECS` gains an `export` keyword in
   the base config so the gate config's `testIgnore` is the SAME array (no
   drift); that is the entire base-config diff.
2. **`snapshotPathTemplate` pinned to the `-chromium-` token.** Committed
   visual baselines are named `<arg>-chromium-linux.png` (project-name
   segment). Both gate legs MUST compare against those same committed
   baselines — that is verbatim the checklist demand ("committed visual
   baselines pass for both"). Template:
   `{testFileDir}/{testFileName}-snapshots/{arg}-chromium-{platform}{ext}`.
3. **`FRESHELL_E2E_RUST_SERVER_BIN` pre-set for every slice.**
   `resolveRustServerBin()` (rust-server.ts:110) returns the override binary
   without invoking `ensureRustServerBuilt()`, so NO cargo build is triggered
   implicitly by any worker → no cargo lease is needed during pw runs. The
   binary is pre-built ONCE under (provision+)cargo lease. It stays valid
   because this item never touches rust sources; if the branch is ever
   rebased onto changed rust code, the binary MUST be rebuilt first
   (documented in the runner script header).
4. **Retries = 0** (non-CI default). Auto-retries would blur the pass/fail
   signal the gate exists to record. Flakes are proven by deliberate isolated
   re-runs instead.
5. **workers=2** (orchestrator's constraint), nice -n 19, pw lease held per
   slice with a 300 s heartbeat loop, lease released between slices.
6. **JSON reporter per slice** (`reporter` overridden in the gate config to
   `[['list'], ['json', {outputFile: $GATE01_JSON_OUTPUT}]]`), collated into
   `test/e2e-browser/gate01-baseline.json` by
   `test/e2e-browser/helpers/gate01-collate.ts` (committed, unit-tested).
7. **Screenshot artifacts:** `outputDir` stays default; failure screenshots
   land in `test-results/` (gitignored), so the baseline JSON stays the only
   committed result artifact.

## Global constraints (verbatim from dispatch)

- pw lease for every Playwright run; release between slices; box is shared.
- cargo lease for the one explicit `cargo build --release -p freshell-server`.
- NEVER `npm test`/`npm run check`/`npm run verify`/un-scoped vitest. Scoped
  vitest (`npm run test:e2e:helpers -- gate01-collate`) only for the collator
  helper test this item authors.
- Never touch: foreign processes, ports 3001/3002/17871/17872/17874, the main
  checkout, other worktrees, broad kills, push/PR/git-config, the checklist
  file.
- `df1ctl.py update GATE-01` at least every 15 min with phase/sha/note/tests.
- Base: `origin/df1/integration` @ `3dbba43c2` (worktree branch
  `df1/gate-01-unchanged-suite-both`).

## File structure

- Create: `test/e2e-browser/playwright.gate01.config.ts` — the 2-project gate config (~60 lines).
- Modify: `test/e2e-browser/playwright.config.ts` — add `export` to `RUST_ONLY_SPECS` (one keyword, zero behavior change).
- Create: `test/e2e-browser/helpers/gate01-collate.ts` — JSON-report → baseline-JSON collator (pure functions + `tsx` CLI main).
- Test: `test/e2e-browser/helpers/gate01-collate.test.ts` — vitest unit tests (red→green).
- Create: `test/e2e-browser/gate01-run-slice.sh` — slice runner: lease acquire + heartbeat + `playwright test` + collate + lease release. No auto-commit (I commit per slice).
- Create: `test/e2e-browser/gate01-baseline.json` — the committed, diffable artifact (schema below).
- Create: `docs/plans/df1-evidence/GATE-01.md` — human+machine-checkable results table + attributions.
- Possibly modify: individual spec files — conditional `test.fail` pins ONLY where attribution mandates (each with an owner-citing comment).

### Baseline JSON schema

```json
{
  "schema": 1,
  "item": "GATE-01",
  "generatedBy": "test/e2e-browser/helpers/gate01-collate.ts",
  "baseRef": "origin/df1/integration",
  "baseSha": "3dbba43c2…",
  "head": "<sha at run time>",
  "rustServerBinSha256": "<sha256 of FRESHELL_E2E_RUST_SERVER_BIN>",
  "suiteDefinition": {
    "selector": "specs/**/*.spec.ts minus RUST_ONLY_SPECS (playwright.config.ts chromium project)",
    "specCount": 69,
    "rustOnlyExcluded": ["…31 files…"]
  },
  "specs": {
    "<spec-file>": {
      "bucket": "product|harness",
      "legs": {
        "legacy": { "verdict": "pass|fail|flaky-reproven|skip-all",
                    "passed": 0, "failed": 0, "skipped": 0, "expectedFail": 0,
                    "durationMs": 0, "runs": ["<slice-id>"],
                    "attribution": null | {"kind":"gap","owner":"ITEM-ID"} | {"kind":"flake","reproof":["run-ids"]} | {"kind":"known-flake","ref":"…"} },
        "rust": { … }
      }
    }
  }
}
```

## Slice plan

69 files sorted into 10 slices of 6–8 files, grouped so heavy files
(restart/restore/fresh-agent/stress classes) are spread out and each slice
mixes buckets. Slice 0 doubles as the load-bearing validation run:

- **Slice 0 (validation):** `harness-02-matrix-bite.spec.ts`,
  `screenshot-baselines.spec.ts`, `editor-pane.spec.ts` — proves: gate config
  loads & lists 69×2, snapshot template hits committed baselines on BOTH
  legs, JSON report → collator → baseline works, rust binary override is
  used (bin sha recorded).
- **Slices 1–9:** the remaining 66 files (exact lists generated by the
  runner's `--print-slices`; committed in the evidence doc appendix).

Per slice:
1. `acquire.sh pw … --wait 3600`; start 300 s heartbeat loop.
2. `GATE01_JSON_OUTPUT=… nice -n 19 npx playwright test --config test/e2e-browser/playwright.gate01.config.ts --workers=2 <slice files>`
3. Stop heartbeat; `acquire.sh release pw …`.
4. `tsx helpers/gate01-collate.ts <slice.json>` → updates baseline JSON.
5. Inspect failures immediately (attribution triage while context is warm).
6. `df1ctl update` (phase/sha/tests/note) + commit baseline+annotations+evidence.

## Attribution protocol (per red leg)

For every non-green leg, decide in order:
1. **Annotated expected-fail already?** If the failure is a test already
   carrying `test.fail` for this kind → verdict `expected-fail (pinned)`, no
   further action (existing owner stands).
2. **Self-skip by design?** `test.skip(e2eServerKind …)` legs → `skip` with
   the spec's own KNOWN-DIVERGENCE comment quoted; NOT a gap.
3. **Flake?** Re-run the single failed test file in isolation (same project,
   `--workers=1`); if green, re-run once more. 2/2 isolated green ⇒ verdict
   `flaky-reproven`, record both reproof run-ids + the swarm-load context.
   Known pre-existing flakes get `known-flake` with the reference (e.g.
   `multi-client.spec.ts:217` class per df1 README lesson B002).
4. **Genuine gap (rust only):** find the owning checklist item by searching
   `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md` for the
   feature surface. If found → conditional `test.fail(e2eServerKind ===
   'rust', '<ID>: <one-liner> (2026-08-09)')` + comment, record the exact
   failing assertion in evidence (B001 lesson: the pin masks later
   assertions in the same test — name which one fired). If NO existing item
   scopes it → draft a one-line follow-up item in the evidence file
   (attribution `unscoped`), and pin with a `GATE-01:` comment.
5. **Genuine legacy-red:** shocking (this lane runs in CI today) — reproduce
   in isolation twice, root-cause to the extent needed to classify
   pre-existing product bug vs environment; record in evidence; annotate
   only if the campaign convention clearly applies (discussed in evidence).

## Verification (how a verifier checks this item)

```bash
# 1. Suite definition integrity: gate config test list == chromium lane (69 files)
node -e '/* snippet in evidence doc: diff --list output vs specs-minus-RUST_ONLY */'
npx playwright test --config test/e2e-browser/playwright.gate01.config.ts --list | tail -3

# 2. Collator tests
npm run test:e2e:helpers -- gate01-collate

# 3. Baseline self-consistency + counts (script in evidence doc)
node -e '/* tally verdicts from gate01-baseline.json; assert specs==69 */'

# 4. Spot-check a recorded green leg (cheap, deterministic)
GATE01 spot: harness-02 + screenshot-baselines both legs (slice 0 command)
```

## Load-bearing audit ledger (post-plan, pre-execution)

| ID | Assumption | Cost if false | Method | Status |
|----|-----------|---------------|--------|--------|
| A1 | chromium lane == specs−RUST_ONLY (69) defines "legacy suite" | high (wrong deliverable) | inspect config (done: 69 files enumerated) | verified |
| A2 | Importing base config into gate config has no side effects and `--list` enumerates 69×2 | high (mechanism dead) | run `playwright --list --config gate01…` | verified (280+280=560) |
| A3 | snapshotPathTemplate `-chromium-` pin hits committed baselines on both legs | high (false visual failures) | run screenshot-baselines + editor-pane both legs | verified (legacy 6/6 visual green vs committed baselines; FIRST attempt with `{testFileDir}/{testFileName}` falsified the naive template — EACCES mkdir at fs root; fixed to `{snapshotDir}/{testFilePath}`) |
| A4 | FRESHELL_E2E_RUST_SERVER_BIN suppresses ALL implicit cargo builds; binary override is what tests boot | medium | code-inspected (rust-server.ts:110-138); logs print the bin sha per worker | verified (all rust runs logged sha256=8728247…) |
| A5 | Conditional `test.fail(e2eServerKind==='rust')` is project-name independent | medium | code-inspected (fixtures.ts option plumbing) | verified (CFG-12 pin consumed as e1 under gate01-rust; my 3 pins verified post-hoc run `postpin-verify`) |
| A6 | JSON reporter carries expected-fail + skipped + per-test status | medium | inspect slice-0 JSON + all merges | verified |
| A7 | Box can run 2 workers × both legs under lease guards without systemic flake-out | medium | observe all slices | verified (legacy legs stable; rust reds explained by F1/gaps, not environment) |
| A8 | No spec outside RUST_ONLY hard-fails on legacy BY DESIGN | high (attribution inversion) | any legacy-red root-caused | FALSIFIED-but-contained: 6 files DO hard-fail on legacy by design (expect-guards) yet missing RUST_ONLY_SPECS — recorded as design-guard errata class, not product gaps |
| A9 | `playwright --list` / config import works under worktree path | low | slice 0 | verified |
| A10 | Existing conditional pins behave identically under gate project names | medium | settings-persistence-split e1 confirmed in slice-2 | verified |
