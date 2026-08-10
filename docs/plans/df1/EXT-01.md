# EXT-01 — Port the complete strict manifest schema

> **For agentic workers:** executed inline by df1-ext-01-manifest-schema (autonomous worker). Steps use checkbox syntax for tracking.

**Goal:** Port the legacy `server/extension-manifest.ts` zod-4 strict validator — every category requirement, default, timeout, capability flag, content schema, icon, command, create/resume identity, models, sandbox, permission field, and unknown-key rejection — to Rust, with pinned behavioral parity, and wire it into the live scan path so `freshell-server` rejects/accepts exactly what legacy does.

**Parity source:** `server/extension-manifest.ts` (zod **4.3.6** — the `package-lock.json` pin; the main checkout's `node_modules` carries a dirty 4.4.3 install that `npm ci` does NOT reproduce. All probes and the oracle are pinned to the LOCK version). Behavioral spec: `test/unit/server/extension-manifest.test.ts` (540 lines, 35 cases) plus the generated differential oracle (`port/contract/generate-manifest-oracle.ts` → `crates/freshell-extensions/fixtures/manifest-oracle.json`, 120 cases: 38 valid / 81 invalid-verdict / 1 invalid-JSON, hermetic byte-identical regeneration verified 2026-08-09).

**Tech stack:** Rust 1.96 / edition 2021, serde + serde_json (preserve_order), indexmap, tracing; oracle generator in TS run with repo `node_modules` zod.

## Global Constraints

- df1 worker contract: scoped cargo (cargo lease) + scoped vitest only; NO un-scoped `npm test`/`check`/`verify`; commits early/often; no push/PR.
- Server crate conventions: NodeNext/ESM rule does not apply here (Rust); workspace `rust-version = 1.96`, edition 2021; `serde_json` has `preserve_order` enabled workspace-wide (verified in root `Cargo.toml`).
- Additive-port philosophy: never modify `server/` or `shared/` source. The oracle generator is a NEW file under `port/contract/` (tooling, not legacy source); all other new code lands in `crates/`.
- Only `crates/freshell-server/src/extensions.rs` parses `freshell.json` today (verified by grep across `crates/`); it is the single rewiring site.

## Key design calls (recorded per dispatch)

### DC-1: Crate layout — NEW crate `crates/freshell-extensions`

- `crates/freshell-extensions/src/lib.rs` — crate docs + re-exports.
- `crates/freshell-extensions/src/manifest.rs` — typed manifest model (`ExtensionManifest` and friends) + `Serialize`/`Deserialize` for the *validated output* form.
- `crates/freshell-extensions/src/validate.rs` — the strict validator walking `serde_json::Value`, producing zod-parity issues.
- `crates/freshell-extensions/tests/oracle.rs` — differential test consuming the frozen oracle fixture.
- `crates/freshell-extensions/fixtures/manifest-oracle.json` — generated, committed.

Rationale: EXT-02…EXT-10 (discovery, reload, enable/disable, launch, serving, lifecycle, security, amplifier) all build on this schema; a dedicated crate mirrors the workspace's per-subsystem layout (`freshell-activity`, `freshell-sessions`, …) and keeps `freshell-server` from accumulating subsystem internals. `freshell-server` gains a path dependency and its `extensions.rs` becomes a thin consumer.

### DC-2: Validate from `serde_json::Value`, NOT derive-`Deserialize`

Legacy flow is `JSON.parse(raw)` → `ExtensionManifestSchema.safeParse(json)`. Two derive-based shortcuts would diverge:

1. **Duplicate JSON keys**: `JSON.parse('{"a":1,"a":2}')` last-wins (`{a:2}`) and zod validates the result; serde struct-derive REJECTS with "duplicate field". `serde_json::from_str::<Value>` last-wins like `JSON.parse`. → parse to `Value` first, then validate.
2. **`null` vs missing**: zod `.optional()` accepts `undefined` (absent key) but REJECTS `null` ("Invalid input: expected object, received null"). Derive `Option<T>` accepts both. → the validator distinguishes key-absent from `Value::Null`.

So the crate exposes:

```rust
pub enum ManifestError {
    InvalidJson(String),                 // legacy: 'invalid JSON in manifest' warn
    Invalid(Vec<ManifestIssue>),         // legacy: 'invalid manifest' warn w/ formatted issues
}
pub fn parse_manifest(json_text: &str) -> Result<ExtensionManifest, ManifestError>;
pub fn validate_manifest(value: &serde_json::Value) -> Result<ExtensionManifest, Vec<ManifestIssue>>;
```

### DC-3: Error-message mapping (clients/logs may surface them)

Legacy logs `result.error.format()` (zod nested format object) at `extension-manager.ts:106-109`; no REST route returns validation errors (verified: `extension-routes.ts` only 404/400s on lookup/category). So byte-parity of the `.format()` nesting is NOT a wire contract; **(code, path, message) parity of the flattened issues** is the meaningful, testable target — and is strictly more useful in structured logs.

`ManifestIssue { code: IssueCode, path: Vec<PathSeg>, message: String }` where `message` byte-matches zod 4.3.6 issue messages and `code` mirrors zod's code. `freshell-server` scan logs `tracing::warn!("Extension scan: invalid manifest", path=%…, issues=?…)` — same event wording as legacy's log line, flat issue list instead of `.format()` nesting (recorded divergence: content-equal, shape flattened).

Pinned zod 4.3.6 messages (probed empirically against the lock-pinned zod, then frozen by oracle generation):

| case | code | message |
|---|---|---|
| unknown keys (1) | `unrecognized_keys` | `Unrecognized key: "descripton"` |
| unknown keys (n) | `unrecognized_keys` | `Unrecognized keys: "aa", "bb"` |
| string min(1) | `too_small` | `Too small: expected string to have >=1 characters` |
| number positive fail | `too_small` | `Too small: expected number to be >0` |
| int upper bound | `too_big` | `Too big: expected int to be <=9007199254740991` |
| int lower bound | `too_small` | `Too small: expected int to be >=-9007199254740991` |
| enum (≥2 opts) | `invalid_value` | `Invalid option: expected one of "client"|"server"|"cli"` |
| enum (1 opt) | `invalid_value` | `Invalid input: expected "canvas"` |
| type mismatch | `invalid_type` | `Invalid input: expected object, received null` (…string/number/boolean/array/undefined/record variants) |
| int field, non-number input | `invalid_type` | `Invalid input: expected number, received string` (base-type name for non-numbers) |
| int field, non-integral number | `invalid_type` | `Invalid input: expected int, received number` |
| category/enum missing or wrong primitive | `invalid_value` | same `Invalid option: …` form (zod-4 enum treats missing/wrong-type as invalid_value, NOT invalid_type) |
| union fail | `invalid_union` | `Invalid input` |
| refine fail | `custom` | the refine's message (2 exist, verbatim) |

### DC-4: Zod-4 semantics the port must replicate (probed, each oracle-pinned)

1. **Issue ordering**: object property issues emit in SCHEMA-DEFINITION order (not input order); the single `unrecognized_keys` issue appends LAST (also at the end of that object's own issue run); nested objects' issues appear inline at their path; a refine's `custom` issue appends after its object's base issues (deeper objects first).
2. **Refine gating (abort rule)**: a `.refine` runs iff its subtree accumulated NO "aborting" issue. Aborting codes: `invalid_type`, `invalid_value`, `invalid_union`, `unrecognized_keys` (observed: every one gates). Non-aborting: `too_small`, `too_big` (observed: `name:''` too_small does NOT gate the manifest refine — both issues appear). Applies identically to the manifest-level refine (`category must have exactly its own config block (no others)`, path `[]`) and each contentSchema field's refine (`default value must match the declared field type`, path `["contentSchema", <key>]`).
3. **`z.number().int()` is SAFE-int**: integral f64 within ±2^53-1. `1e21` → `too_big` ("expected int to be <=9007199254740991"); `-2^53` → BOTH `too_small` (int lower bound) AND `too_small` (positive) — check failures accumulate, they do not short-circuit; `-1.5` → only `invalid_type` "expected int, received number" (type/format failures DO abort the chain).
4. **Missing key** → `invalid_type` with "received undefined" (not "absent").
5. **Defaults materialize in output**: `server.args=[]`, `server.readyTimeout=10000`, `server.singleton=true`, `cli.args=[]` when absent. No other defaults exist.
6. **`icon`/`url`/`envVar`/`readyPattern`/`healthCheck`/picker fields/`permissionModeEnvVar` are bare `z.string()`** — EMPTY STRING IS VALID (no min(1)). Only `name`/`version`/`label`/`description`/`client.entry`/`server.command`/`cli.command` have min(1).
7. **Enum case-sensitivity + single-option message form** (`"canvas"`).
8. **Top-level non-object** → `invalid_type` "expected object, received array/string/null/…".
9. **Category refine**: exactly one of `client`/`server`/`cli` blocks present AND it must match `category`; runs only per rule 2.
10. **contentSchema field `default`**: `z.union([string, number, boolean])`; union fail = `invalid_union` "Invalid input" at that path; refine compares JS `typeof` — NaN/`Infinity` cannot survive into zod's number check (`$ZodNumber` rejects non-finite). CORRECTION (from the independent review): `JSON.parse('1e400')` returns `Infinity` — the legacy side rejects via SCHEMA error (invalid_type, → 'invalid manifest' warn), while `serde_json` rejects `1e400` as unparseable (→ 'invalid JSON in manifest' warn). Verdict parity (skip + warn) holds; the WARN CLASS/log line differs for out-of-range float text. Accepted residual divergence (building a custom lenient float parser to align warn lines is disproportionate for pathological manifests).
11. **`__proto__` (added from independent review):** skipped silently in `z.record` VALUES (never validated, never kept — `$ZodRecord`), but a normal `unrecognized_keys` member in strict objects ($ZodObject/handleCatchall).
12. **JS own-key enumeration order (added from independent review):** canonical array-index keys (`String(ToNumber(k)) === k`, `< 2^32-1`) enumerate FIRST ascending, then insertion order — governs the `unrecognized_keys` member order AND record iteration/output order (contentSchema/env/permissionModeValues).

### DC-5: Numeric modeling

JSON numbers model as `serde_json::Number` during validation. `readyTimeout` validates as JS-safe-int (rule 4.3) and stores as `u64` — accept range is `1..=9007199254740991`, which fits u64 exactly; rejection cases are per zod messages above. `contentSchema` defaults keep an ordered union `DefaultValue::{String(String), Number(serde_json::Number), Boolean(bool)}`. Canonicalization (final, after the independent review): numbers always pass through f64 FIRST so integer text beyond 2^53 rounds to JS's double (never u64-exact), then integral values in ±(2^53-1) store as integers (matching `JSON.stringify`'s no-`.0` text); larger/non-integral store as f64 (the stored double equals JS's bit-for-bit). Known cosmetic residual: serde_json prints f64 ≥2^53 in exponent form where JS prints fixed digits (parsed-value-identical; both re-parse to the same double). EXT-04 note: `buildEnv`'s `String(field.default)` port will need a JS shortest-roundtrip formatter (ryu-based) if text-exact `String()` of >2^53 defaults ever matters.

### DC-6: Ordering maps

`contentSchema` and record fields (`env`, `permissionModeValues`) preserve JS own-key enumeration order (canonical array-index keys ascending first, then insertion order — rule 4.12) — legacy's client renders content-schema forms in that order. → `indexmap::IndexMap` (already in the dep tree via serde_json `preserve_order`), with keys INSERTED in JS enumeration order by the validator's `js_ordered_keys` helper.

### DC-7: Rewire scope (what "port" means here)

`freshell-server/src/extensions.rs` replaces its lenient subset structs with the strict crate: `scan()` calls `parse_manifest`, logs-and-skips on `InvalidJson`/`Invalid` (matching legacy's warn-skip-continue), keeps sorted-subdir determinism + first-wins dedup (already ported), and the public registry/detection surface (`ExtensionRegistry`, `CliDetectionSpec`, `detect_available_clis`, `resolve_extension_dirs`) keeps its signatures. One recorded micro-fix within scope: legacy `toClientRegistry` gates `iconUrl` on TRUTHY `manifest.icon` (`if (manifest.icon)` — empty string suppressed); the current Rust port checks `is_some()`. The strict validator admits `icon: ""`, so the port must check non-empty to stay output-faithful.

## Acceptance evidence (named up front)

1. **Differential oracle test**: `cargo test -p freshell-extensions` green — `tests/oracle.rs` asserts every fixture row's success/failure, full issue list `(code, path, message)` equality, and defaulted-output JS-double-semantic equality against `crates/freshell-extensions/fixtures/manifest-oracle.json` generated by REAL zod 4.3.6 (final: **130 cases** — 43 valid / 86 schema-invalid / 1 invalid-JSON; includes the review-added rows for `__proto__` record-skip, numeric own-key order, and >2^53 default rounding).
2. **Ported behavioral suite**: SUPERSEDED by (1) — instead of Rust-transcribing the 35 vitest cases (hand-copy drift risk), the generator mirrors them as oracle rows judged by the legacy schema itself; the reviewer verified all 35 have corresponding rows. CRATE unit tests cover only what the oracle cannot express (error-class split, log Display, own-key order text fidelity, union single-issue shape, CLI surface round-trip).
3. **Server rewiring green**: `cargo test -p freshell-server extensions` green, including NEW scan tests (unknown-key manifest skipped-with-warn while sibling loads; strict rejection of category/block mismatch) and a regression test that every bundled `extensions/*/freshell.json` validates.
4. **Hygiene**: `cargo fmt --check` + `cargo clippy -p freshell-extensions -p freshell-server -- -D warnings` clean; focused suites run twice to classify flakes.
5. Evidence file: `docs/plans/df1-evidence/EXT-01.md` with commands, SHAs, oracle generator output, flake classification, and the DC table.

**Playwright posture:** queue item has `pwMode: null`; no named spec in the evidence thread. Checklist PW-RUST line describes seeding manifests and asserting the registry — covered without a browser by (1)+(3) (schema + route/registry level). No pw lease taken.

## File map

- Create `port/contract/generate-manifest-oracle.ts` (new tooling; does NOT touch legacy source)
- Create `crates/freshell-extensions/Cargo.toml`
- Create `crates/freshell-extensions/src/lib.rs`
- Create `crates/freshell-extensions/src/manifest.rs`
- Create `crates/freshell-extensions/src/validate.rs`
- Create `crates/freshell-extensions/tests/oracle.rs`
- Create (generated) `crates/freshell-extensions/fixtures/manifest-oracle.json`
- Modify root `Cargo.toml` (`workspace.dependencies` += `freshell-extensions`; members glob already covers `crates/*`)
- Modify `crates/freshell-server/Cargo.toml` (dep += `freshell-extensions`)
- Modify `crates/freshell-server/src/extensions.rs` (consume strict schema; drop lenient structs; icon-truthiness fix)

## Tasks

### Task 1: Oracle generator + frozen fixture (the executable spec, written first)

**Files:**
- Create: `port/contract/generate-manifest-oracle.ts`
- Create: `crates/freshell-extensions/fixtures/manifest-oracle.json` (generated)

- [x] Step 1: Write the generator: a TS script importing `ExtensionManifestSchema` from the (UNMODIFIED) legacy `server/extension-manifest.ts` (via the repo's dev tsx runner — the same mechanism as `port/contract/generate-ws-contract.ts`) defining ~60 cases: 6 bundled manifests verbatim, all 35 vitest cases, every DC-4 rule probe (ordering, gating A–J, 2^53 bounds, pluralization, null-vs-absent, empty-string-where-allowed, per-enum values, union members, record value types, top-level non-objects, duplicate-key JSON text case serialized as pre-parsed LAST-WINS object + one raw-text case documented for the Rust JSON layer), each emitting `{ name, input, expected: { success, data?, issues? } }` with `issues = [{code, path, message}]` and `data` JSON-stringify-round-tripped.
- [x] Step 2: The generator writes the fixture itself (repo convention from `generate-ws-contract.ts`): `npx tsx port/contract/generate-manifest-oracle.ts` from the WORKTREE root; eyeball the diff-worthy rows (defaults rows must show `args:[]`, `readyTimeout:10000`, `singleton:true`).
- [x] Step 3: Validate the generator is hermetic: re-run, byte-identical output (git diff empty). Commit: `test(EXT-01): freeze zod manifest oracle fixture + generator`.

### Task 2: `freshell-extensions` crate — model + strict validator (TDD per behavior group)

**Files:**
- Create: `crates/freshell-extensions/Cargo.toml`, `src/lib.rs`, `src/manifest.rs`, `src/validate.rs`

Interfaces:
- Produces (consumed by freshell-server + EXT-02..10): `pub fn parse_manifest(&str) -> Result<ExtensionManifest, ManifestError>`, `pub fn validate_manifest(&Value) -> Result<ExtensionManifest, Vec<ManifestIssue>>`, types `ExtensionManifest { name, version, label, description, category: Category, icon: Option<String>, url: Option<String>, content_schema: Option<IndexMap<String, ContentSchemaField>>, picker: Option<PickerConfig>, client: Option<ClientConfig>, server: Option<ServerConfig>, cli: Option<CliConfig> }`, `ServerConfig { command, args: Vec<String> /*default []*/, env: Option<IndexMap<String,String>>, ready_pattern: Option<String>, ready_timeout: u64 /*default 10000*/, health_check: Option<String>, singleton: bool /*default true*/ }`, `CliConfig` (all 15 legacy fields incl. `permission_mode_env_var`, `permission_mode_values: Option<IndexMap<String,String>>`, `terminal_behavior`), `ClientConfig { entry: String }`, `ContentSchemaField { field_type: FieldType, label: String, required: Option<bool>, default: Option<DefaultValue> }`, `ManifestIssue { code, path, message }`.

- [x] Step 1: Skeleton + workspace wiring; `cargo check -p freshell-extensions` (cargo lease acquired).
- [x] Step 2: RED — unit tests (module `validate::tests`) for required-field presence + min(1) + enum categories + category/block refine (vitest cases 1–17 by order in the legacy file); run, confirm fail.
- [x] Step 3: GREEN — validator for scalars/objects/enums + top-level refine + defaults; tests pass.
- [x] Step 4: RED — strict unknown-key rejection at every object level + null-vs-absent + issue ordering (definition order, unrecognized last) + refine gating rule (aborting vs check codes) + 2^53 int bounds + accumulate-vs-abort chains (DC-4 probes A–J as literal test cases).
- [x] Step 5: GREEN — strict collector implementing DC-4.1/4.2/4.3 exactly.
- [x] Step 6: RED — contentSchema (field enums, union default, typeof refine, record paths), server block (timeout bounds/defaults), cli block (all templates, `permissionMode*`, terminalBehavior enums, single-option enum message), client block, empty-string-allowed fields, top-level non-objects.
- [x] Step 7: GREEN — remaining blocks; whole unit suite green. `cargo fmt` + `clippy`.
- [x] Step 8: Commit: `feat(EXT-01): strict manifest schema in freshell-extensions`.

### Task 3: Differential oracle test

- [x] Step 1: RED/GREEN—— `tests/oracle.rs`: iterate fixture rows; `parse_manifest(serde_json::to_string(input))` (plus the raw-text rows consumed as text); assert success, issue list equality `(code, path, message)`, and defaulted-data semantic equality (compare as `serde_json::Value` AFTER re-serializing the typed manifest — this also proves the output model is lossless for valid manifests, which Task 4's registry depends on).
- [x] Step 2: Loop until green; any mismatch → the fixture is the oracle (fix Rust, never the fixture rows, unless a GENERATOR bug is proven by re-probing zod; re-run generator if so).
- [x] Step 3: Run twice; flake-classify. Commit: `test(EXT-01): differential oracle parity green`.

### Task 4: Rewire `freshell-server` scan path

- [x] Step 1: RED — new tests in `extensions.rs` tests module: (a) manifest with unknown key is skipped (and a valid sibling still registers); (b) category/block-mismatch manifest skipped; (c) invalid-JSON manifest skipped; (d) tp — `icon: ""` registry entry has NO `iconUrl`; (e) bundled manifests all validate (walk `concat!(env!("CARGO_MANIFEST_DIR"), "/../../extensions")`).
- [x] Step 2: GREEN — replace lenient structs with `freshell_extensions::` types in `scan`/`is_valid_manifest`/`client_entry`; add `tracing::warn!` for the two reject classes; keep `cli_command_specs`/`cli_detection_specs`/`to_client_registry` signatures; icon-truthiness fix (DC-7).
- [x] Step 3: Full existing `extensions` module tests still green (they encode the frozen client-registry shape — this proves no consumer-visible regression, incl. `cli.args` now being `Vec` not `Option` at the spec boundary — keep `CliCommandSpec` field types unchanged by converting at the seam).
- [x] Step 4: `cargo fmt --check`, `clippy -p freshell-extensions -p freshell-server -- -D warnings`, `cargo test -p freshell-extensions` + `cargo test -p freshell-server extensions` — all green, twice.
- [x] Step 5: Commit: `feat(EXT-01): freshell-server scan consumes strict manifest schema`.

### Task 5: Evidence + self-check

- [x] Write `docs/plans/df1-evidence/EXT-01.md` (commands verbatim, SHAs, oracle row count, parities + recorded divergences from DC-3/DC-5, flake classification).
- [x] df1ctl update final state; review loop per dispatch.

## Self-review notes (run per writing-plans skill)

- Spec coverage: every checklist keyword maps — client/server/CLI category requirements (Task 2 steps 2/6 + refine), defaults (DC-4.5), timeouts (readyTimeout DC-4.3), capabilities (supports* flags), content schema (Task 2 step 6), icons (icon string + DC-7 truthiness), commands (command min(1) + args default), create/resume identity (createSessionArgs/resumeArgs templates), models (modelArgs/supportsModel), sandbox (sandboxArgs/supportsSandbox), permissions (permissionModeArgs/EnvVar/Values/supportsPermissionMode), unknown fields (DC-4 everywhere). ✓
- Placeholder scan: no TBD; each RED/GREEN pair names its cases; commands literal. ✓
- Type consistency: `ManifestIssue`/`ExtensionManifest`/`parse_manifest` identical across Tasks 2–4. ✓
