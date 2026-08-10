# EXT-01 — Evidence: Port the complete strict manifest schema

**Item:** EXT-01 — Port the complete strict manifest schema (P1 — Extensions).
**Worker:** df1-ext-01-manifest-schema, worktree `.worktrees/df1-ext-01-manifest-schema`, branch `df1/ext-01-manifest-schema` (base: `origin/df1/integration` @ `3dbba43c2`).
**Verdict:** PASS. Independent defect-first review (fresheyes, claude provider, FRESHPID 2196947) found 1 major + 8 minor/nit findings; ALL majors/minors fixed and re-verified, nits recorded. Review loop iterations used: 2 of ≤5 (gpt run died on SIGPIPE 141 infrastructure failure before producing findings; claude run completed).
**Plan:** `docs/plans/df1/EXT-01.md` (committed; contains the full design-call record DC-1…DC-7 incl. review-driven amendments DC-4.11/4.12, DC-5).

## What landed

1. **New crate `crates/freshell-extensions`** — the complete strict manifest validator:
   - `src/manifest.rs` — typed model (`ExtensionManifest`, `ClientConfig`, `ServerConfig` with materialized `args=[]`/`readyTimeout=10000`/`singleton=true`, full 15-field `CliConfig`, `PickerConfig`, `TerminalBehavior` with single/two-option enums, `ContentSchemaField` + `DefaultValue` union with JS-double-faithful canonicalization) with output-side `Serialize` reproducing zod's `result.data` shape. No `Deserialize` impls: the typed model is obtainable ONLY through validation.
   - `src/validate.rs` — hand-written `serde_json::Value` walker: strict unknown-key rejection at every object level; category↔config-block refine; content-schema field typeof-refine; zod-4 refine-gating abort rule; definition-order issue emission with `unrecognized_keys` last; JS-safe-int positive `readyTimeout` with accumulating checks; null-vs-absent `.optional()`; `__proto__` record-skip; JS own-key enumeration order; byte-exact zod 4.3.6 `(code, path, message)` triples.
   - `src/issue.rs` — the issue model (codes, path segments, `ManifestError` with legacy's two log classes).
   - `src/validate/tests.rs` — 10 focused unit tests (error-class split, log Display, error paths; own-key ORDER text fidelity incl. numeric keys; `__proto__` drop/reject asymmetry; union single-issue shape; full CLI surface round-trip; typeof-name coupling pin).
   - `tests/oracle.rs` + `fixtures/manifest-oracle.json` — **130-case differential oracle** (43 valid / 86 schema-invalid / 1 invalid-JSON-text) generated from the UNMODIFIED legacy schema. Comparator `js_value_eq` implements JS-double semantics (serde Number equality is variant-strict).
2. **Oracle generator** `port/contract/generate-manifest-oracle.ts` — runs the real zod schema over the pinned case list (all 35 legacy vitest cases, all 6 bundled manifests as raw text, duplicate-key/raw-text rows, every probed zod-4 semantic, 6 review-driven rows). Hard-refuses to generate if installed zod ≠ package-lock.json pin. Hermetic: byte-identical regeneration. Listed in `port/contract/README.md`.
3. **`crates/freshell-server/src/extensions.rs` rewired** to consume the crate: strict rejection with legacy's two warn lines (asserted by a new global-subscriber capture test, parallel-safe per the repo's documented pattern), icon gate corrected to legacy truthiness, UTF-8-lossy read matching `fs.readFileSync(…, 'utf-8')`, frozen public surface unchanged.

## Parity coverage vs the checklist keywords

| Checklist word | Where proven |
|---|---|
| client/server/CLI category requirements | oracle rows `server-category-without-server-block`, `client-category-without-client-block`, `cli-category-without-cli-block`, `server-category-with-extra-client-block`, `cli-category-with-all-three-blocks`, all refine-gating rows; server tests `scan_skips_category_block_mismatch_and_missing_blocks`, `scan_skips_client_and_server_manifests_without_their_blocks` |
| defaults | oracle rows `server-defaults-materialize`, `server-args-default-empty`, `cli-args-default-empty` assert output data `args:[]`, `readyTimeout:10000`, `singleton:true` |
| timeouts | oracle rows `server-readytimeout-{negative,zero,non-integer,negative-non-integer,below-safe-int,above-safe-int,text-beyond-2e53-rounds,wrong-type-string,max-safe-int}` |
| capabilities | `supportsPermissionMode`/`supportsModel`/`supportsSandbox` wrong-type rows + full-template row; registry shape tests |
| content schema | field-type rows, union default rows, typeof-refine rows, unknown-key row, `field-refine-gated-by-aborting-member`; order fidelity unit tests |
| icons | `empty-icon-string-valid` ("" valid) + `icon-null-rejected`; server test `empty_string_icon_produces_no_icon_url` |
| commands | command min(1)/type/absence rows for server + cli |
| create/resume identity | `cli-full-launch-templates-and-permission-mapping`, `cli-resumeargs-non-string-element`; registry `resumeCommandTemplate` shape tests |
| models | modelArgs row, `cli-supportsmodel-wrong-type` |
| sandbox | sandboxArgs row, `cli-supportssandbox-wrong-type` |
| permissions | permissionModeArgs/EnvVar/Values rows incl. wrong-type pins |
| unknown fields | `unknown-*` rows at all 7 object levels incl. pluralization + position pins |

## Load-bearing ledger (all VERIFIED by running code; method = direct execution against the lock-pinned zod)

| ID | Assumption | Status | Evidence |
|---|---|---|---|
| LB-1 | zod 4.3.6 issue codes/messages/ordering/gating semantics | VERIFIED | probe batches against `npx tsx` + oracle fixture (130 rows) |
| LB-2 | Only `freshell-server/src/extensions.rs` parses freshell.json in Rust land | VERIFIED | `grep -rn freshell.json crates/` — 5 hits, 4 comments |
| LB-3 | All 6 bundled manifests pass the strict schema | VERIFIED | tsx run over legacy schema (all VALID) + server test `all_bundled_manifests_validate_and_register_through_scan` |
| LB-4 | tsx runnable in-worktree for the generator | VERIFIED | node_modules/.bin/tsx, devDep ^4.19.2 |
| LB-5 | serde_json `preserve_order` workspace-enabled | VERIFIED | root Cargo.toml; IndexMap order tests green |
| LB-6 | Duplicate JSON keys: last-wins both sides | VERIFIED | JS probe `{"a":1,"a":2}`→`{"a":2}`; oracle row `duplicate-name-key-last-wins` passes in Rust |
| LB-7 | Integers >2^53: serde u64 vs JS IEEE rounding — verdict-identical | VERIFIED | oracle rows `server-readytimeout-{above-safe-int,below-safe-int,text-beyond-2e53-rounds,max-safe-int}` pass |
| LB-8 | Existing extensions.rs tests encode the frozen registry shape | VERIFIED | all 8 pre-existing tests stay green post-rewire |

**Falsified mid-flight (corrected):** "vendored zod is 4.4.3" — the main checkout's node_modules is dirty; the lock pin is 4.3.6. All probes were re-issued and the oracle generated against 4.3.6; the plan + this file reflect that.

## Recorded divergences (deliberate, behavior-preserving)

1. **Log shape:** legacy logs `result.error.format()` (nested object); Rust logs the flat issue list `?issues` next to legacy's message text. Content-equal, shape flattened. No client-visible surface carries validation errors (verified: `extension-routes.ts` only 404/400s lookups).
2. **Huge-magnitude number cosmetics:** content-schema defaults with |x| ≥ 1e21 re-serialize in exponent-form slightly differently than `JSON.stringify` ("1e21" vs "1e+21"); parsed-value equality holds. Integral f64 defaults in ±2^53 are canonicalized to ints, matching JS's no-`.0` output exactly.
3. **Pre-existing, kept intentionally:** subdirectory sort order for stable client arrays (documented in the module since Follow-up 3.19).

## Test discipline

- Scoped cargo only, cargo lease held (`acquire.sh cargo df1-ext-01-manifest-schema`).
- No npm test/check/verify, no un-scoped runs, no sandbox-needing destructive paths, no processes started (pure library + in-memory tests; temp dirs under `/tmp` per existing test helpers).
- Only files outside `crates/`: `port/contract/generate-manifest-oracle.ts` (new tooling; legacy `server/` untouched — verified by diff below) and docs.

## GREEN COMMANDS (verbatim, at final SHA)

```
cargo test -p freshell-extensions
cargo test -p freshell-server
cargo clippy -p freshell-extensions -p freshell-server --all-targets -- -D warnings
cargo fmt --check
```

Results at final SHA (see header/git log):
- `freshell-extensions`: 10 unit + 1 oracle (130 cases) green — 3 consecutive runs.
- `freshell-server`: full crate suite **614 passed, 0 failed, 1 ignored** (plus harness binaries green) — 3 consecutive runs; not flaky (hermetic; only fs use is per-test unique temp dirs).
- clippy `-D warnings`: clean. fmt: clean.

## Legacy-source integrity check

`git diff origin/df1/integration...HEAD --stat -- server/ shared/ test/` → EMPTY (no legacy source or legacy tests touched). The oracle derives from `server/extension-manifest.ts` read-only.

## Playwright posture

Queue item `pwMode: null`; the checklist's PW-RUST line describes seeding manifests + registry assertions with no named spec file. Per dispatch: crate tests carry the proof. The registry-level behavior (only valid extensions appear; every registry field matches fixtures; invalid manifests produce logged diagnostics without disturbing discovery) is pinned by the 7 new server scan/warn tests + the 130-case oracle. No pw lease taken.

## Review record

1. **Structured fresh-eyes self-review** (recorded): 34-point adversarial checklist over the diff; found and fixed 2 parity gaps (`field-refine-gated-by-aborting-member` oracle row; `from_utf8_lossy` read semantics) + 1 panic-hazard class found pre-commit during implementation (unguarded `opt_out` in block closures — eliminated via `bad!()` guards before first run) + 1 doc drift.
2. **Independent fresheyes review** (FRESHPID 1440188, gpt provider): DIED on infrastructure failure (exit 141 SIGPIPE, `runner_state: failed`, no findings produced) — retried on the claude provider per the skill's fallback rule.
3. **Independent fresheyes review** (FRESHPID 2196947, claude provider): completed, verdict **FAILED** with a real defect. Cross-checked the port against the vendored zod 4.3.6 SOURCE (`node_modules/zod/v4/core/*.js`), not just behavior. Findings and dispositions:
   - **[major] `__proto__` skipped by `z.record`** → accept/reject flip. VERIFIED by direct zod probe; FIXED (record walkers skip `__proto__`, strict objects still reject it) + 3 oracle rows + unit test.
   - **[minor] >2^53 integer defaults stayed u64-exact** (JS rounds). VERIFIED; FIXED (always-through-f64 canonicalization; typed value now bit-identical to JS's double) + 2 oracle rows.
   - **[minor] JS own-key order** (array-index keys first) not replicated. VERIFIED; FIXED (`js_ordered_keys` used by `unrecognized()` + both record walkers) + 1 oracle row (message text pin) + 2 order unit tests.
   - **[minor] oracle version pin advisory-only.** VERIFIED (this bit me mid-task); FIXED (generator hard-refuses on lock mismatch; crate test asserts exact `4.3.6`).
   - **[minor] scan warn lines untested.** FIXED (global-subscriber capture test; thread-local was nondeterministic under `cargo test` — resolved per the repo's documented OnceLock pattern; 6× parallel re-runs green).
   - **[minor] plan doc drift** (stale "4.4.3" labels, case counts, unchecked boxes, silently-replaced acceptance criterion, wrong NaN/Infinity reasoning). FIXED in `docs/plans/df1/EXT-01.md` (incl. DC-4.10 correction: `1e400` → JSON.parse yields `Infinity` → legacy warns 'invalid manifest', we warn 'invalid JSON in manifest' — verdict parity holds, warn CLASS diverges; accepted residual).
   - **[minor] evidence file untracked + self-contradictory.** FIXED (this file, committed, verdict consistent).
   - **[nit] generator `as const`, README discoverability, commit-splitting, redundant oracle row.** First two FIXED; commit history and the one redundant row left as-is (cosmetic; regenerating to drop a row churns the fixture for no behavioral gain).
4. **Unavailability note (per dispatch fallback rules):** no Task tool in this environment; the freshell fresh-agent review pane (ext01-review) never materialized a reachable tab (production server answered "no tabs"; no orphan terminal left — verified via list-terminals). Self-review + independent CLI-driven review were used instead; both recorded here.

## Fixture/regeneration discipline

- `npx tsx port/contract/generate-manifest-oracle.ts` — byte-identical output on re-run (sha256-stable), and hard-fails on zod/lock drift.
- NEVER hand-edit the fixture to match Rust; the legacy schema is the only oracle.

OUTCOME: COMPLETED — see verdict at top.
