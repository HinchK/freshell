# EXT-01 — Evidence: Port the complete strict manifest schema

**Item:** EXT-01 — Port the complete strict manifest schema (P1 — Extensions).
**Worker:** df1-ext-01-manifest-schema, worktree `.worktrees/df1-ext-01-manifest-schema`, branch `df1/ext-01-manifest-schema` (base: `origin/df1/integration` @ `3dbba43c2`).
**Verdict:** PASS (see review section for independent-review outcome).
**Plan:** `docs/plans/df1/EXT-01.md` (committed; contains the full design-call record DC-1…DC-7).

## What landed

1. **New crate `crates/freshell-extensions`** — the complete strict manifest validator:
   - `src/manifest.rs` — typed model (`ExtensionManifest`, `ClientConfig`, `ServerConfig` with materialized `args=[]`/`readyTimeout=10000`/`singleton=true`, full 15-field `CliConfig`, `PickerConfig`, `TerminalBehavior` with single/two-option enums, `ContentSchemaField` + `DefaultValue` union) with output-side `Serialize` reproducing zod's `result.data` shape exactly (camelCase, absent-optionals elided, defaults present). No `Deserialize` impls: the typed model is obtainable ONLY through validation.
   - `src/validate.rs` — hand-written `serde_json::Value` walker: strict unknown-key rejection at every object level; category↔config-block refine; content-schema field typeof-refine; zod-4 refine-gating abort rule; issue emission in schema-definition order with `unrecognized_keys` last per object; JS-safe-int positive `readyTimeout` with accumulating check failures; null-vs-absent `.optional()`; byte-exact zod 4.3.6 `(code, path, message)` triples.
   - `tests/oracle.rs` + `fixtures/manifest-oracle.json` — **124-case differential oracle** (39 valid / 84 schema-invalid / 1 invalid-JSON-text) generated from the UNMODIFIED legacy schema.
   - 7 focused unit tests (error-class split, log Display, insertion-order fidelity of contentSchema/env, single-issue union failure, full CLI surface round-trip, typeof-name coupling pin).
2. **Oracle generator** `port/contract/generate-manifest-oracle.ts` — runs the real zod schema over the pinned case list (mirrors all 35 legacy vitest cases, all bundled manifests as raw text, duplicate-key/raw-text edge rows, and every probed zod-4 semantic). Hermetic: byte-identical regeneration.
3. **`crates/freshell-server/src/extensions.rs` rewired** to consume the crate: strict rejection with legacy's two warn lines ('invalid JSON in manifest' / 'invalid manifest' + issues), icon gate corrected to legacy truthiness semantics, UTF-8-lossy read to match `fs.readFileSync(…, 'utf-8')`, frozen public surface (`ExtensionRegistry`/`CliDetectionSpec`/`detect_available_clis`/`resolve_extension_dirs`) unchanged.

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
| LB-1 | zod 4.3.6 issue codes/messages/ordering/gating semantics | VERIFIED | probe batches against `npx tsx` + oracle fixture (124 rows) |
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
- `freshell-extensions`: 7 unit + 1 oracle (124 cases) green — 3 consecutive runs.
- `freshell-server`: full crate suite **614 passed, 0 failed, 1 ignored** (plus harness binaries green) — 3 consecutive runs; not flaky (hermetic; only fs use is per-test unique temp dirs).
- clippy `-D warnings`: clean. fmt: clean.

## Legacy-source integrity check

`git diff origin/df1/integration...HEAD --stat -- server/ shared/ test/` → EMPTY (no legacy source or legacy tests touched). The oracle derives from `server/extension-manifest.ts` read-only.

## Playwright posture

Queue item `pwMode: null`; the checklist's PW-RUST line describes seeding manifests + registry assertions with no named spec file. Per dispatch: crate tests carry the proof. The registry-level behavior (only valid extensions appear; every registry field matches fixtures; invalid manifests produce logged diagnostics without disturbing discovery) is pinned by the 6 new server scan tests + the 124-case oracle. No pw lease taken.

## Review record

1. **Structured fresh-eyes self-review** (recorded): 34-point adversarial checklist over the diff; found and fixed 2 parity gaps (`field-refine-gated-by-aborting-member` oracle row; `from_utf8_lossy` read semantics) + 1 panic-hazard class found pre-commit during implementation (unguarded `opt_out` in block closures — eliminated via `bad!()` guards before first run). 1 doc drift fixed (plan Task-1 wording).
2. **Independent fresheyes review** (gpt provider, FRESHPID=1440188, scope: defect-first review of `git diff origin/df1/integration...HEAD` with the df1 review-agent brief): OUTCOME-BELOW.
3. Task-tool subagent + freshell fresh-agent pane were both attempted first and are unavailable in this environment (no Task tool; fresh-agent pane never materialized a reachable tab — production server answers `no tabs`).

OUTCOME: (pending — filled when the review completes)
