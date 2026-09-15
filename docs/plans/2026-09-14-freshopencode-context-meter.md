# freshopencode Context Meter Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
- Freshopencode (OpenCode agent) panes in Freshell display the live context-window usage meter in the agent status strip — compact percent, context tokens used, and compaction threshold — computed server-side from real opencode session data, replacing the current muted "context —" state.

### Explicit constraints
- Treat the missing meter as a freshell bug (the sessions indexer stamps OpenCode sessions with no token usage), not a by-design limitation; correct the false plan-doc claim that "no opencode token usage exists upstream".
- Follow the adopted fix design: extend the OpenCode listing parser (crates/freshell-sessions/src/parse/opencode.rs) to read the session's model and a bounded last-`step-finish` token query; compute the TokenSummary (compactPercent, contextTokens, compactThresholdTokens) where crates/freshell-sessions/src/directory_index.rs:791 currently returns None; resolve model context-window limits via the existing opencode catalog (/config/providers) registry; unresolvable limits must leave the meter in the unknown state gracefully.
- Mirror opencode's own compaction semantics: maxOutputTokens = min(limit.output, 32000) || 32000; reserved = min(20000, maxOutputTokens); usable = limit.input ? max(0, limit.input - reserved) : max(0, limit.context - maxOutputTokens); the meter treats usable as the compaction threshold.
- Access the user's opencode database read-only; never restart the live shared opencode sidecar or the self-hosted Freshell production server (a production restart requires the user's explicit "APPROVED").
- Follow repo conventions: work in a .worktrees/<slug> worktree on a branch from origin/main, red/green/refactor TDD, do not create a PR without explicit user approval.
- Run this work through the-usual workflow (plan → load-bearing validation → independent plan review → task-by-task TDD execution → independent delta review → recap).

### Accepted tradeoffs and residuals
- Sessions whose model limits cannot be resolved from the catalog keep the muted unknown meter (graceful degradation accepted).
- The lunaroute model `limit` config edits on garageserver and dandesktop (WSL + Windows) were completed in a prior session; three nvfp4/ballast alias limits were extrapolated at the deployment's uniform 512K context cap (flagged and accepted).
- The live opencode sidecar may keep old in-memory model limits until it naturally restarts; no forced restart (accepted).

**Goal:** A freshopencode pane's status strip shows the live context meter (percent + tokens + threshold, "compacts at 100%" = opencode's actual auto-compact moment) instead of the muted `context —`, with zero functional client changes.

**Architecture:** Server-side only, four layers following the repo's inject-at-the-composition-root convention. (1) The opencode catalog parser keeps the per-model `limit {context, input?, output}` block it currently drops (`ModelCapability.limit`, `#[serde(skip_serializing)]` so the strict client zod wire schema is untouched); the freshagent `ModelCapabilityRegistry` gains a typed internal `models()` accessor sharing its existing TTL/single-flight path. (2) The sessions parser reads `session.model` (tolerating older schemas) and runs a bounded, index-searched last-`step-finish` usage query (the `FIRST_USER_MESSAGE_SQL` discipline), plus pure compaction-math functions mirroring opencode v1.18.31 `session/overflow.ts` (source-verified: count = `tokens.total || (input+output+cache.read+cache.write)` vs `usable`). (3) `opencode_session_to_indexed` replaces `token_usage: None` with a TokenSummary computed from usage + an injected sync model-limit resolver; `OpencodeSource` defaults to no resolver (all existing constructions stay meter-unknown). (4) freshell-server owns a sync `model id -> limits` snapshot refreshed by an async task that polls the registry (default catalog + the distinct cwds of the 16 most-recent opencode sessions, TTL-cached inside the registry), hands a read-closure to `OpencodeSource` at the `main.rs` construction site, and corrects the stale comments/docs. The wire chain past `IndexedSession.token_usage` (DirItem → `tokenUsage` → `contextUsageExtras` → client guard → strip) already works and is untouched.

**Tech Stack:** Rust workspace (rusqlite read-only queries, serde `skip_serializing`, tokio async wiring, axum test router via `tower::ServiceExt::oneshot`), React/TS client (comment-only change), Vitest/Playwright for existing client coverage, Cargo tests for all new behavior.

## Global Constraints

- TDD red/green/refactor for every change; never skip tests; keep the refactor step.
- Never restart the production freshell server (port 3001) or the live shared `opencode serve` sidecar (port 32855). Building and testing in the worktree is fine; `scripts/prebuild-guard.ts` already exits 0 in linked worktrees.
- The user's opencode DB (`~/.local/share/opencode/opencode.db`, multi-GB) is READ-ONLY in every context that touches it (`SQLITE_OPEN_READ_ONLY`); tests use writable fixture DBs in temp dirs, never the real DB.
- New per-session enrichment must degrade to `None` on ANY schema/query error — the `FIRST_USER_MESSAGE_SQL` precedent (`parse/opencode.rs:180-186`): older opencode schemas must never break listing.
- `ModelCapability` is serialized to the client whose zod schema is `.strict()` — the new `limit` field MUST be `#[serde(skip_serializing)]`, and the `normalize_matches_the_shared_probe_fixture` byte-parity test must stay green without touching the shared fixtures.
- The sessions crate must not gain a dependency on freshell-opencode/freshagent/protocol (freshell-freshagent already depends on freshell-sessions — a reverse edge would be a cycle). The resolver seam is the only coupling, injected from freshell-server.
- Rust style gates before push: `cargo fmt --all --check`, `cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings`.
- TypeScript relative imports need `.js` extensions (NodeNext/ESM).
- No PR creation without explicit user approval; do not push behavior changes to `origin/main`.
- Focused test commands (delegated, no coordinator gate): NARROWED selectors only — `cargo test -p <crate> --locked <test-file-or-name-filter>`, `npm run test:vitest -- run <file>`, `npm run typecheck`. Whole-crate/zero-filter cargo runs and the repo lanes (`npm run test:server`, `test:integration`, `test`, `check`, `verify`) are BROAD and coordinator-gated — never invoke them raw mid-task; the run's final full-suite verification goes through the coordinated gate at the end.
- On the wire, `contextTokens` / `compactThresholdTokens` / `compactPercent` are INDEPENDENT optionals (`TokenSummarySchema`, `shared/ws-protocol.ts:61-72`); the client guard (`src/lib/fresh-agent-context-usage.ts:67-80`) renders the meter only when ALL THREE are present. Emitting real usage (`contextTokens`) while limits are unresolvable (threshold/percent absent) is correct and renders muted — NEVER fabricate threshold/percent to "complete" the triple. `compactThresholdTokens` must be positive when present; `compactPercent` an integer 0–100; and `modelContextWindow` is positive-optional — NEVER emit 0 or negative (the wire zod is `.positive()` and both page consumers hard-`.parse` at `src/lib/api.ts:646`/`:681` — one violating item rejects the entire session-directory page for ALL providers).
- Server-side computation mirrors opencode v1.18.31 exactly (evidence: `reports/load-bearing-opencode-overflow-formula.md`): count = `tokens.total || (input + output + cache.read + cache.write)` (fallback omits `reasoning`, upstream's `||` semantics); `usable` returns 0 when `limit.context === 0` (upstream then disables auto-compaction — the meter must stay unknown, not divide by zero). opencode's `compaction.reserved`/`compaction.auto` user-config overrides are NOT visible to the server (accepted residual; the user's config sets neither).
- Structured logging (`tracing::debug!`/`warn!`) on every degrade/probe-failure path; no secrets/keys in logs.

---

### Task 1: Carry model limits through the opencode catalog and the capability registry

**Files:**
- Modify: `crates/freshell-opencode/src/catalog.rs` (struct + normalize + tests)
- Modify: `crates/freshell-freshagent/src/model_capabilities.rs` (typed `models()` accessor + re-export + tests)
- Modify: `crates/freshell-freshagent/src/lib.rs` (public registry accessor)

**Interfaces:**
- Produces: `freshell_opencode::catalog::ModelLimits { context: i64, input: Option<i64>, output: Option<i64> }` (derive Clone/Debug/PartialEq/Eq/Serialize); `ModelCapability.limit: Option<ModelLimits>` (`#[serde(skip_serializing)]`).
- Produces: `freshell_freshagent::model_capabilities::ModelCapabilityRegistry::models(&self, session_type: SessionType, cwd: Option<String>) -> Result<Vec<ModelCapability>, CapabilityError>` (same TTL/single-flight path as `get`); `pub use` re-export of `ModelCapability`/`ModelLimits` from the `model_capabilities` module; `FreshAgentState::model_capabilities() -> Arc<ModelCapabilityRegistry>` public accessor.
- Task 4 consumes these. Tasks 2–3 do not touch this crate pair.

- [ ] **Step 1: Write the failing tests**

In `crates/freshell-opencode/src/catalog.rs` (in the existing `mod tests`):

```rust
#[test]
fn normalize_reads_model_limits_from_provider_models() {
    let raw = serde_json::json!({
        "lunaroute": {
            "id": "lunaroute",
            "name": "Lunaroute",
            "models": {
                "glm-5.3-vision-background": {
                    "id": "glm-5.3-vision-background",
                    "name": "GLM 5.3 Vision Background",
                    "limit": { "context": 524288, "output": 131072 }
                },
                "deepseek-4.1-flash": {
                    "limit": { "context": 1048576, "input": 2000000, "output": 262144 }
                },
                "unlimited-model": { "id": "unlimited-model", "name": "No Limits" }
            }
        }
    });
    let models = normalize_enabled_model_catalog(&raw);
    let by_id = |id: &str| {
        models
            .iter()
            .find(|m| m.id == id)
            .unwrap_or_else(|| panic!("missing {id}"))
    };
    assert_eq!(
        by_id("lunaroute/glm-5.3-vision-background").limit,
        Some(ModelLimits { context: 524288, input: None, output: Some(131072) })
    );
    // no "id" key -> falls back to the models-map key; full triple parsed
    assert_eq!(
        by_id("lunaroute/deepseek-4.1-flash").limit,
        Some(ModelLimits { context: 1048576, input: Some(2000000), output: Some(262144) })
    );
    // no limit block declared -> None (unresolvable, meter stays unknown)
    assert_eq!(by_id("lunaroute/unlimited-model").limit, None);
}

#[test]
fn model_limits_never_serialize_to_the_strict_wire_schema() {
    let cap = ModelCapability {
        id: "lunaroute/glm-5.3".into(),
        display_name: "GLM 5.3".into(),
        provider: "opencode",
        source: None,
        supports_effort: false,
        supported_effort_levels: Vec::new(),
        supports_adaptive_thinking: false,
        limit: Some(ModelLimits { context: 524288, input: None, output: Some(131072) }),
    };
    let value = serde_json::to_value(&cap).unwrap();
    let obj = value.as_object().unwrap();
    assert!(!obj.contains_key("limit"), "limit must never reach the wire");
    for key in [
        "id",
        "displayName",
        "provider",
        "supportsEffort",
        "supportedEffortLevels",
        "supportsAdaptiveThinking",
    ] {
        assert!(obj.contains_key(key), "missing strict-schema key {key}");
    }
}
```

In `crates/freshell-freshagent/src/model_capabilities.rs` (in its test module — mirror the existing scripted-probe tests in that file; keep their `CountingProbe`-style seam conventions):

```rust
#[tokio::test]
async fn models_returns_typed_rows_with_limits_and_shares_the_ttl_cache() {
    let probe = Arc::new(ScriptedLimitProbe::default());
    let registry = ModelCapabilityRegistry::with_clock(
        probe.clone(),
        test_now(),                    // the same injected-clock seam the existing tests use
        MODEL_CAPABILITY_CACHE_TTL,
    );
    let first = registry
        .models(SessionType::FreshOpencode, None)
        .await
        .expect("catalog ok");
    assert_eq!(first.len(), 1);
    assert_eq!(
        first[0].limit,
        Some(freshell_opencode::catalog::ModelLimits {
            context: 524288,
            input: None,
            output: Some(131072),
        })
    );
    assert_eq!(probe.calls(), 1);
    // the HTTP envelope path shares the same cache: within TTL, get() must not re-probe
    let (status, _body) = registry.get(SessionType::FreshOpencode, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(probe.calls(), 1);
}
```

`ScriptedLimitProbe` implements `ModelCatalogProbe` returning one `ModelCapability` with `limit: Some(ModelLimits { context: 524288, input: None, output: Some(131072) })` and counts calls — write it next to the existing scripted probes in that module (they already exist for the `get()` tests; extend the nearest one's fixture rather than duplicating if cleaner).

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-opencode --locked --lib catalog`
Expected: FAIL — `ModelLimits` does not exist / `.limit` unknown field (compile error: the missing type/field is the missing behavior).

Run: `cargo test -p freshell-freshagent --locked --lib model_capabilities`
Expected: FAIL — `models()` does not exist on the registry (compile error).

- [ ] **Step 3: Add the minimal production implementation**

`crates/freshell-opencode/src/catalog.rs` — new type (near `ModelCapability`, ~line 45):

```rust
/// Per-model token limits from the raw `/config/providers` model object
/// (`models[id].limit { context, input?, output }`) — the inputs opencode's
/// own `session/overflow.ts` compaction check consumes. Server-internal
/// only: carried on [`ModelCapability::limit`] with
/// `#[serde(skip_serializing)]` so it never reaches the wire (the client's
/// `FreshAgentModelCapabilitySchema` is zod `.strict()`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ModelLimits {
    pub context: i64,
    pub input: Option<i64>,
    pub output: Option<i64>,
}
```

On `ModelCapability` (after `supports_adaptive_thinking`):

```rust
    /// Raw `limit { context, input?, output }` block when the provider
    /// config declares one; `None` when absent. Server-internal: NEVER
    /// serialized (see [`ModelLimits`]).
    #[serde(skip_serializing)]
    pub limit: Option<ModelLimits>,
```

In `normalize_enabled_model_catalog`, inside the per-model loop (the raw `model` object is in hand at `:215-217`), before the `models.push(...)`:

```rust
            let limit = read_model_limits(model.get("limit"));
```

and the push gains `limit,`. New private helper (near `read_non_empty_string`, ~line 268):

```rust
/// `models[id].limit { context, input?, output }`. Absent object -> `None`.
/// A present-but-partial object keeps `context` at 0 (opencode treats
/// `limit.context === 0` as "no auto-compaction"; the meter mirrors that
/// by staying unknown). Negative values are treated as absent — nonsense
/// input must not fabricate limits.
fn read_model_limits(raw: Option<&Value>) -> Option<ModelLimits> {
    let obj = raw?.as_object()?;
    let read_nonneg = |key: &str| obj.get(key).and_then(Value::as_i64).filter(|v| *v >= 0);
    Some(ModelLimits {
        context: read_nonneg("context").unwrap_or(0),
        input: read_nonneg("input"),
        output: read_nonneg("output"),
    })
}
```

Fix every other `ModelCapability { ... }` literal in the crate's tests (compile errors point at them): add `limit: None`.

`crates/freshell-freshagent/src/model_capabilities.rs`:
- Re-export for downstream crates (freshell-server must be able to name the types): change the `use freshell_opencode::catalog::{...}` import at `:35` to also `pub use freshell_opencode::catalog::{ModelCapability, ModelLimits};` (keep the private `use` for the rest).
- Extract the TTL-hit block shared by `get()` and the new accessor (DRY; `get()` at `:361-379` becomes a caller):

```rust
    /// Cached catalog within TTL, if fresh. Shared by the HTTP envelope
    /// path ([`Self::get`]) and the typed internal read ([`Self::models`]).
    async fn cached_within_ttl(&self, key: &str) -> Option<CachedCatalog> {
        let state = self.state.lock().await;
        let cached = state.cache.get(key)?;
        let age_ms = (self.now)().saturating_sub(cached.fetched_at_ms);
        (age_ms <= self.ttl.as_millis() as u64).then(|| cached.clone())
    }
```

- Typed accessor (after `refresh`, ~line 408):

```rust
    /// Typed internal read for server-side consumers (the session-directory
    /// context meter's model-limit snapshot): the same TTL/single-flight
    /// path as [`Self::get`], returning rows instead of the HTTP envelope.
    /// Codex resolves from its static table; a probe failure returns `Err`
    /// and leaves the last successful cache entry in place.
    pub async fn models(
        &self,
        session_type: SessionType,
        cwd: Option<String>,
    ) -> Result<Vec<ModelCapability>, CapabilityError> {
        if session_type == SessionType::FreshCodex {
            return Ok(static_models(session_type));
        }
        let key = catalog_cache_key(session_type, cwd.as_deref());
        if let Some(cached) = self.cached_within_ttl(&key).await {
            return Ok(cached.models);
        }
        self.refreshed_catalog(session_type, key, cwd)
            .await
            .map(|catalog| catalog.models)
    }
```

`crates/freshell-freshagent/src/lib.rs` — public accessor next to the `model_capabilities` field (~line 340; field stays `pub(crate)`):

```rust
    /// Shared read access to the model-capability registry for the HTTP
    /// routes and server-side consumers (the session-directory context
    /// meter's opencode limit snapshot). The field stays `pub(crate)`;
    /// this accessor is the public seam.
    pub fn model_capabilities(&self) -> std::sync::Arc<model_capabilities::ModelCapabilityRegistry> {
        self.model_capabilities.clone()
    }
```

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-opencode --locked --lib catalog`
Expected: PASS (including the untouched `normalize_matches_the_shared_probe_fixture` parity test — `skip_serializing` keeps the normalized bytes identical).

Run: `cargo test -p freshell-freshagent --locked --lib model_capabilities`
Expected: PASS.

- [ ] **Step 5: Refactor while green**

If the scripted-probe fixtures in `model_capabilities.rs` tests grew duplicated builders, fold them into the existing probe helper. No production-code refactor is expected beyond `cached_within_ttl`.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: every consumer of `ModelCapability` literals and the registry. `ModelCapability` gains a field, so all construction sites must compile — rg-verified they live ONLY in `crates/freshell-opencode/src/catalog.rs` and `crates/freshell-freshagent/src/model_capabilities.rs` (freshell-ws and freshell-server reference the type not at all). Narrowed, delegated runs:

Run: `cargo test -p freshell-opencode --locked --lib catalog && cargo test -p freshell-freshagent --locked --lib model_capabilities`
Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-opencode/src/catalog.rs crates/freshell-freshagent/src/model_capabilities.rs crates/freshell-freshagent/src/lib.rs
git commit -m "feat(opencode): carry model limits through the catalog and capability registry"
```

---

### Task 2: Sessions parser reads the session model and last step-finish usage (+ compaction math)

**Files:**
- Modify: `crates/freshell-sessions/src/parse/opencode.rs` (row/struct fields, SQL, math fns, in-file unit tests)
- Modify: `crates/freshell-sessions/src/parse/mod.rs` (re-exports)
- Test: `crates/freshell-sessions/tests/opencode_usage.rs` (new integration test file)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces (all re-exported from `freshell_sessions::parse`): `OpencodeModelLimits { context: i64, input: Option<i64>, output: Option<i64> }`; `OpencodeStepUsage { total: Option<i64>, input: i64, output: i64, cache_read: i64, cache_write: i64 }`; `OpencodeSession.model: Option<String>` (the `provider/model` composite) and `OpencodeSession.last_usage: Option<OpencodeStepUsage>`; `OpencodeSessionRow.model: Option<String>` (raw JSON); pure fns `opencode_max_output_tokens(Option<i64>) -> i64`, `opencode_usable_context(&OpencodeModelLimits) -> i64`, `opencode_context_count(&OpencodeStepUsage) -> i64`, `opencode_compact_percent(i64, i64) -> Option<i64>`; constants `OPENCODE_OUTPUT_TOKEN_MAX = 32_000`, `OPENCODE_COMPACTION_BUFFER_TOKENS = 20_000`.
- Task 3 consumes these.

- [ ] **Step 1: Write the failing tests**

New file `crates/freshell-sessions/tests/opencode_usage.rs` — mirror the TmpDir/writable-conn convention of `tests/opencode_first_message.rs` (schema helpers there; copy the `TmpDir` block verbatim). New schema adds the `model` column and seeds step-finish parts:

```rust
//! Bounded last-step-finish usage extraction from opencode.db — the numbers
//! opencode's own compaction trigger reads (`session/overflow.ts`
//! `isOverflow({ tokens: lastFinished.tokens, ... })`, verified against the
//! v1.18.31 source). Fixture DBs mirror the REAL schema shape (session.model
//! JSON column; message/part linkage + time as REAL columns; role/type/
//! tokens inside the JSON `data` column) — same convention as
//! tests/opencode_first_message.rs.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};

use freshell_sessions::parse::OpencodeProvider;
use rusqlite::Connection;

static COUNTER: AtomicU64 = AtomicU64::new(0);

struct TmpDir(PathBuf);
// ... identical TmpDir impl as tests/opencode_first_message.rs:17-44 ...

const PLACEHOLDER: &str = "New session - 2026-08-10T23:47:23.950Z";

fn create_schema(conn: &Connection) {
    conn.execute_batch(
        "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
         CREATE TABLE session (
            id TEXT PRIMARY KEY,
            directory TEXT,
            title TEXT,
            time_created INTEGER,
            time_updated INTEGER,
            time_archived INTEGER,
            project_id TEXT,
            parent_id TEXT,
            model TEXT
         );
         CREATE TABLE message (
            id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
         CREATE TABLE part (
            id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
            time_created INTEGER NOT NULL, time_updated INTEGER, data TEXT);",
    )
    .unwrap();
}

fn insert_session(conn: &Connection, id: &str, title: &str, model: Option<&str>) {
    conn.execute(
        "INSERT INTO session VALUES (?1, '/repo/x', ?2, 1000, 5000, NULL, NULL, NULL, ?3)",
        rusqlite::params![id, title, model],
    )
    .unwrap();
}

fn insert_message(conn: &Connection, id: &str, session_id: &str, time_created: i64, role: &str) {
    conn.execute(
        "INSERT INTO message VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![id, session_id, time_created, format!("{{\"role\":\"{role}\"}}")],
    )
    .unwrap();
}

fn insert_part(conn: &Connection, id: &str, message_id: &str, session_id: &str, data: &str) {
    // Real-schema fidelity: parts carry time_created (NOT NULL) +
    // time_updated. The usage WALK orders messages by time_created and a
    // message's parts by id; tests insert in story order, so a monotonic
    // counter mirrors "later insert = newer part" (the order lexicographic
    // ids would give).
    static PART_TIME: AtomicI64 = AtomicI64::new(1000);
    let time_created = PART_TIME.fetch_add(1, Ordering::SeqCst);
    conn.execute(
        "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
        rusqlite::params![id, message_id, session_id, time_created, data],
    )
    .unwrap();
}

const STEP_FINISH_FULL: &str = r#"{"reason":"stop","type":"step-finish","tokens":{"total":215242,"input":215,"output":434,"reasoning":1,"cache":{"write":0,"read":214592}},"cost":0}"#;
const STEP_FINISH_NO_TOTAL: &str = r#"{"reason":"stop","type":"step-finish","tokens":{"input":100,"output":50,"reasoning":7,"cache":{"write":10,"read":900}},"cost":0}"#;
const MODEL_JSON: &str = r#"{"id":"glm-5.3-vision-background","providerID":"lunaroute","variant":"default"}"#;

fn list_one(dir: &Path) -> freshell_sessions::parse::OpencodeSession {
    let provider = OpencodeProvider::new(dir.to_path_buf());
    let listing = provider.list_sessions(42).expect("read ok");
    assert_eq!(listing.sessions.len(), 1);
    listing.sessions.into_iter().next().unwrap()
}

#[test]
fn session_with_model_and_step_finish_extracts_usage() {
    let dir = TmpDir::new();
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    create_schema(&conn);
    insert_session(&conn, "ses_1", "Named", Some(MODEL_JSON));
    insert_message(&conn, "msg_1", "ses_1", 100, "user");
    insert_message(&conn, "msg_2", "ses_1", 200, "assistant");
    insert_part(&conn, "prt_2", "msg_2", "ses_1", STEP_FINISH_FULL);
    drop(conn);
    let s = list_one(&dir);
    assert_eq!(s.model.as_deref(), Some("lunaroute/glm-5.3-vision-background"));
    assert_eq!(
        s.last_usage,
        Some(freshell_sessions::parse::OpencodeStepUsage {
            total: Some(215242),
            input: 215,
            output: 434,
            cache_read: 214592,
            cache_write: 0,
        })
    );
}

#[test]
fn latest_assistant_step_finish_wins_even_with_trailing_user_message() {
    // the lastFinished semantic: a trailing (synthetic tool-result) user
    // message after the final assistant step must not hide the usage
    let dir = TmpDir::new();
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    create_schema(&conn);
    insert_session(&conn, "ses_1", "Named", Some(MODEL_JSON));
    insert_message(&conn, "msg_1", "ses_1", 100, "assistant");
    insert_part(&conn, "prt_1", "msg_1", "ses_1", r#"{"reason":"tool-calls","type":"step-finish","tokens":{"total":1000,"input":10,"output":20,"cache":{"write":0,"read":970}}}"#);
    insert_message(&conn, "msg_2", "ses_1", 200, "assistant");
    insert_part(&conn, "prt_2", "msg_2", "ses_1", STEP_FINISH_FULL);
    // trailing user (tool result) — newer than the last assistant
    insert_message(&conn, "msg_3", "ses_1", 300, "user");
    insert_part(&conn, "prt_3", "msg_3", "ses_1", r#"{"type":"text","text":"tool output","synthetic":true}"#);
    drop(conn);
    let s = list_one(&dir);
    assert_eq!(s.last_usage.as_ref().unwrap().total, Some(215242));
}

#[test]
fn in_flight_trailing_step_falls_back_to_previous_finished_step() {
    // The falsifier (live-DB proven, reports/load-bearing-strategist.md §2):
    // the newest assistant message is a RUNNING step — step-start/reasoning
    // parts only, NO step-finish. The meter must read the PREVIOUS finished
    // step's usage (opencode's `lastFinished`), not degrade to None.
    let dir = TmpDir::new();
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    create_schema(&conn);
    insert_session(&conn, "ses_1", "Named", Some(MODEL_JSON));
    insert_message(&conn, "msg_1", "ses_1", 100, "assistant");
    insert_part(&conn, "prt_1", "msg_1", "ses_1", r#"{"reason":"stop","type":"step-finish","tokens":{"total":1000,"input":10,"output":20,"cache":{"write":0,"read":970}}}"#);
    // the RUNNING newest step: assistant message with NO step-finish part
    insert_message(&conn, "msg_2", "ses_1", 200, "assistant");
    insert_part(&conn, "prt_2", "msg_2", "ses_1", r#"{"type":"step-start"}"#);
    insert_part(&conn, "prt_3", "msg_2", "ses_1", r#"{"type":"reasoning","text":"thinking"}"#);
    drop(conn);
    let s = list_one(&dir);
    assert_eq!(s.last_usage.as_ref().unwrap().total, Some(1000));
}

#[test]
fn usage_walk_caps_at_64_probes_and_degrades_to_none() {
    // 70 assistant messages; the ONLY step-finish sits on the OLDEST
    // (msg_000, time 100). The walk probes newest-first and must stop at
    // the 64-probe cap WITHOUT reaching msg_000 — None here proves the
    // cap fired (without it, the walk would find the old step-finish and
    // return Some(999)). A bounded, logged miss.
    let dir = TmpDir::new();
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    create_schema(&conn);
    insert_session(&conn, "ses_1", "Named", Some(MODEL_JSON));
    for i in 0..70 {
        let id = format!("msg_{i:03}");
        insert_message(&conn, &id, "ses_1", 100 + i, "assistant");
        if i == 0 {
            insert_part(&conn, "prt_000", &id, "ses_1", r#"{"reason":"stop","type":"step-finish","tokens":{"total":999,"input":9,"output":9,"cache":{"write":0,"read":972}}}"#);
        } else {
            insert_part(&conn, &format!("prt_{i:03}"), &id, "ses_1", r#"{"type":"step-start"}"#);
        }
    }
    drop(conn);
    let s = list_one(&dir);
    assert_eq!(s.last_usage, None);
}

#[test]
fn missing_tokens_total_falls_back_to_parsed_fields() {
    let dir = TmpDir::new();
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    create_schema(&conn);
    insert_session(&conn, "ses_1", "Named", Some(MODEL_JSON));
    insert_message(&conn, "msg_1", "ses_1", 100, "assistant");
    insert_part(&conn, "prt_1", "msg_1", "ses_1", STEP_FINISH_NO_TOTAL);
    drop(conn);
    let s = list_one(&dir);
    let usage = s.last_usage.expect("usage present");
    assert_eq!(usage.total, None);
    assert_eq!(usage.input, 100);
    assert_eq!(usage.output, 50);
    assert_eq!(usage.cache_read, 900);
    assert_eq!(usage.cache_write, 10);
}

#[test]
fn session_without_model_skips_usage_lookup() {
    let dir = TmpDir::new();
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    create_schema(&conn);
    insert_session(&conn, "ses_1", "Named", None);
    insert_message(&conn, "msg_1", "ses_1", 100, "assistant");
    insert_part(&conn, "prt_1", "msg_1", "ses_1", STEP_FINISH_FULL);
    drop(conn);
    let s = list_one(&dir);
    assert_eq!(s.model, None);
    assert_eq!(s.last_usage, None);
}

#[test]
fn malformed_model_json_degrades_to_none_without_breaking_listing() {
    let dir = TmpDir::new();
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    create_schema(&conn);
    insert_session(&conn, "ses_1", "Named", Some(r#"{"id": }"#));
    drop(conn);
    let s = list_one(&dir);
    assert_eq!(s.model, None);
    assert_eq!(s.last_usage, None);
}

#[test]
fn no_step_finish_yields_none() {
    let dir = TmpDir::new();
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    create_schema(&conn);
    insert_session(&conn, "ses_1", "Named", Some(MODEL_JSON));
    insert_message(&conn, "msg_1", "ses_1", 100, "assistant");
    insert_part(&conn, "prt_1", "msg_1", "ses_1", r#"{"type":"text","text":"partial turn, no finish yet"}"#);
    drop(conn);
    let s = list_one(&dir);
    assert!(s.model.is_some());
    assert_eq!(s.last_usage, None);
}

#[test]
fn legacy_schema_without_model_column_stays_listable() {
    // opencode_sqlite.rs's older fixtures have no session.model column; the
    // listing SELECT must tolerate it (NULL AS model), never fail.
    let dir = TmpDir::new();
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    conn.execute_batch(
        "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
         CREATE TABLE session (
            id TEXT PRIMARY KEY, directory TEXT, title TEXT,
            time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
            project_id TEXT, parent_id TEXT
         );
         CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
         CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO session VALUES ('ses_1', '/repo/x', 'Named', 1000, 5000, NULL, NULL, NULL)",
        [],
    )
    .unwrap();
    drop(conn);
    let s = list_one(&dir);
    assert_eq!(s.model, None);
    assert_eq!(s.last_usage, None);
}
```

In-file unit tests in `crates/freshell-sessions/src/parse/opencode.rs` (`mod tests`, next to `placeholder_title_tests`):

```rust
    #[test]
    fn opencode_math_mirrors_upstream_overflow_semantics() {
        use super::*;
        // maxOutputTokens: min(limit.output, 32000) || 32000
        assert_eq!(opencode_max_output_tokens(Some(131_072)), 32_000);
        assert_eq!(opencode_max_output_tokens(Some(8_192)), 8_192);
        assert_eq!(opencode_max_output_tokens(None), 32_000);
        assert_eq!(opencode_max_output_tokens(Some(0)), 32_000);
        // lunaroute case: context 524288, output 131072, no input limit
        let limits = OpencodeModelLimits { context: 524_288, input: None, output: Some(131_072) };
        assert_eq!(opencode_usable_context(&limits), 524_288 - 32_000);
        // input branch: reserved = min(20000, maxOutputTokens); input: 0 is
        // JS-falsy upstream and must take the CONTEXT branch, not yield 0
        let input_limited = OpencodeModelLimits { context: 1_000_000, input: Some(100_000), output: Some(131_072) };
        assert_eq!(opencode_usable_context(&input_limited), 100_000 - 20_000);
        let small_output = OpencodeModelLimits { context: 1_000_000, input: Some(100_000), output: Some(8_192) };
        assert_eq!(opencode_usable_context(&small_output), 100_000 - 8_192);
        let zero_input = OpencodeModelLimits { context: 524_288, input: Some(0), output: Some(131_072) };
        assert_eq!(opencode_usable_context(&zero_input), 524_288 - 32_000);
        // context 0 disables (upstream returns 0, never a threshold)
        assert_eq!(opencode_usable_context(&OpencodeModelLimits { context: 0, input: None, output: None }), 0);
        // count: total wins; fallback omits reasoning
        let usage = OpencodeStepUsage { total: Some(215_242), input: 215, output: 434, cache_read: 214_592, cache_write: 0 };
        assert_eq!(opencode_context_count(&usage), 215_242);
        let no_total = OpencodeStepUsage { total: None, input: 100, output: 50, cache_read: 900, cache_write: 10 };
        assert_eq!(opencode_context_count(&no_total), 1_060);
        let zero_total = OpencodeStepUsage { total: Some(0), input: 100, output: 50, cache_read: 900, cache_write: 10 };
        assert_eq!(opencode_context_count(&zero_total), 1_060);
        // percent: round-half-up, clamped
        assert_eq!(opencode_compact_percent(395_980, 492_288), Some(80));
        assert_eq!(opencode_compact_percent(492_288, 492_288), Some(100));
        assert_eq!(opencode_compact_percent(600_000, 492_288), Some(100));
        assert_eq!(opencode_compact_percent(0, 492_288), Some(0));
        assert_eq!(opencode_compact_percent(10, 0), None);
        assert_eq!(opencode_compact_percent(10, -1), None);
    }

    #[test]
    fn opencode_model_composite_joins_provider_and_id() {
        use super::*;
        assert_eq!(
            opencode_model_composite(r#"{"id":"glm-5.3","providerID":"lunaroute","variant":"default"}"#),
            Some("lunaroute/glm-5.3".to_string())
        );
        // org/name ids (44% of real sessions, e.g. Kimi-K3) compose verbatim —
        // the catalog builds the same triple-slash ids from its models-map keys
        assert_eq!(
            opencode_model_composite(r#"{"id":"moonshotai/Kimi-K3","providerID":"ms-runpod"}"#),
            Some("ms-runpod/moonshotai/Kimi-K3".to_string())
        );
        // id-side slashes are legal (no id guard; live-verified join contract)
        assert_eq!(
            opencode_model_composite(r#"{"id":"a/b","providerID":"p"}"#),
            Some("p/a/b".to_string())
        );
        assert_eq!(opencode_model_composite(r#"{"id":"x"}"#), None);          // no providerID
        assert_eq!(opencode_model_composite(r#"not json"#), None);
        // provider-side slash stays guarded (mirrors the catalog's provider skip)
        assert_eq!(opencode_model_composite(r#"{"id":"m","providerID":"p/x"}"#), None);
    }
```

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-sessions --locked --test opencode_usage`
Expected: FAIL (compile error — `OpencodeStepUsage`/fields do not exist).

Run: `cargo test -p freshell-sessions --locked --lib -- parse::opencode`
Expected: FAIL (compile error — math fns/types missing).

- [ ] **Step 3: Add the minimal production implementation**

In `crates/freshell-sessions/src/parse/opencode.rs`:

1. New types + math (place near the top, after the `OpencodeListing` struct):

```rust
/// Model context-window limits — the parsed counterpart of opencode's
/// `models[id].limit { context, input?, output }`. The directory-index
/// layer resolves these through an injected resolver (catalog-backed in
/// production freshell-server wiring; `None` in every other construction).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpencodeModelLimits {
    pub context: i64,
    pub input: Option<i64>,
    pub output: Option<i64>,
}

/// Token usage from a session's LAST `step-finish` part — the numbers
/// opencode's own compaction trigger reads (`session/overflow.ts`
/// `isOverflow({ tokens: lastFinished.tokens, ... })`, verified against
/// the v1.18.31 source; `prompt.ts` passes the last finished assistant
/// message's tokens).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpencodeStepUsage {
    /// `tokens.total` — present on every real step-finish; `None` on
    /// hand-trimmed payloads, where the sum fallback applies.
    pub total: Option<i64>,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
}

/// opencode `provider/transform.ts` `OUTPUT_TOKEN_MAX` (v1.18.31).
pub const OPENCODE_OUTPUT_TOKEN_MAX: i64 = 32_000;
/// opencode `session/overflow.ts` `COMPACTION_BUFFER`.
pub const OPENCODE_COMPACTION_BUFFER_TOKENS: i64 = 20_000;

/// `maxOutputTokens(model) = Math.min(model.limit.output, 32000) || 32000`.
/// A missing/zero output limit falls back to the 32k cap (JS `||` on a
/// falsy value); negatives are treated as absent (nonsense input).
pub fn opencode_max_output_tokens(output_limit: Option<i64>) -> i64 {
    match output_limit {
        Some(o) if o > 0 => o.min(OPENCODE_OUTPUT_TOKEN_MAX),
        _ => OPENCODE_OUTPUT_TOKEN_MAX,
    }
}

/// opencode `session/overflow.ts` `usable()`: the context-token budget the
/// auto-compaction trigger compares against (`count >= usable`). `context`
/// of 0 returns 0 exactly as upstream (auto-compaction disabled there).
/// The `input` branch mirrors JS truthiness: only a NON-ZERO `input` takes
/// the `input - reserved` branch — `input: 0` is falsy upstream and falls
/// through to the `context - maxOutputTokens` branch.
pub fn opencode_usable_context(limits: &OpencodeModelLimits) -> i64 {
    if limits.context == 0 {
        return 0;
    }
    match limits.input {
        Some(input) if input != 0 => {
            let reserved =
                OPENCODE_COMPACTION_BUFFER_TOKENS.min(opencode_max_output_tokens(limits.output));
            (input - reserved).max(0)
        }
        _ => (limits.context - opencode_max_output_tokens(limits.output)).max(0),
    }
}

/// The compaction count: `tokens.total || (input + output + cache.read +
/// cache.write)` — opencode's `isOverflow` count verbatim (the fallback
/// deliberately omits `reasoning`, mirroring upstream).
pub fn opencode_context_count(usage: &OpencodeStepUsage) -> i64 {
    usage.total.filter(|t| *t > 0).unwrap_or_else(|| {
        usage
            .input
            .saturating_add(usage.output)
            .saturating_add(usage.cache_read)
            .saturating_add(usage.cache_write)
            .max(0)
    })
}

/// Meter percent: `round(count / usable * 100)` (half-up) clamped to
/// 0..=100. `None` when `usable <= 0` — no meter, mirroring upstream
/// disabling auto-compaction at `limit.context === 0`.
pub fn opencode_compact_percent(context_count: i64, usable: i64) -> Option<i64> {
    if usable <= 0 || context_count < 0 {
        return None;
    }
    let pct = context_count
        .saturating_mul(100)
        .saturating_add(usable / 2)
        / usable;
    Some(pct.clamp(0, 100))
}

/// Parse the session row's `model` JSON (`{"id","providerID","variant"}`)
/// into the model-capability catalog's `provider/model` composite id
/// (`normalize_enabled_model_catalog` joins the same way — verbatim
/// `provider_id + "/" + model_id`). The id may itself contain slashes
/// (models.dev org/name ids like `moonshotai/Kimi-K3` — 44% of real
/// sessions; the catalog composes those ids verbatim too), so there is NO
/// id-side slash guard; the PROVIDER-side guard mirrors the catalog's own
/// provider-slash skip (catalog.rs:195-200 — such providers never appear in
/// the catalog, so the composite could never match). Degrades to `None` on
/// absent/malformed input — the meter stays unknown, the listing never
/// breaks.
fn opencode_model_composite(raw: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let id = v.get("id")?.as_str()?.trim();
    let provider = v.get("providerID")?.as_str()?.trim();
    if id.is_empty() || provider.is_empty() || provider.contains('/') {
        return None;
    }
    Some(format!("{provider}/{id}"))
}
```

2. `OpencodeSessionRow` gains `pub model: Option<String>` (raw JSON text); `OpencodeSession` gains:

```rust
    /// `provider/model` composite from the session row's `model` JSON —
    /// the same key the model-capability catalog uses. `None` when the
    /// column is absent (older schema), null, or malformed.
    pub model: Option<String>,
    /// Last `step-finish` token usage — what opencode's own compaction
    /// trigger reads. `None` when the session has no completed model step
    /// yet, has no model, or the bounded lookup degrades.
    pub last_usage: Option<OpencodeStepUsage>,
```

3. In `run_opencode_query_inner`: extend the existing `PRAGMA table_info(session)` scan (`:240-250`) to also detect a `model` column (`has_model`); after the `marker_expr` build, add:

```rust
    // Schema tolerance (the parent_id discipline): older opencode schemas
    // have no session.model column — a literal s.model would fail the whole
    // listing there. NULL AS model keeps those DBs listable, meter-unknown.
    let model_expr = if has_model { "s.model AS model" } else { "NULL AS model" };
```

and the SELECT gains `, {model_expr}` after `{marker_expr} AS hasThreeViewsMarker` (append as positional index 7); the row mapping closure gains `model: to_opt_string(&row.get::<_, SqlValue>(7)?),`.

4. Bounded usage lookup — a NEWEST-FIRST MESSAGE WALK with two `prepare_cached` statements (the `FIRST_USER_MESSAGE_SQL` degrade discipline; pure index searches via `message_session_time_created_id_idx` and `part_message_id_id_idx`). A single "newest step-finish of the session" scan was tried first and rejected in review: it reads EVERY part of the session and builds a temp B-tree per session per re-list — on this production DB (505k parts, re-lists on every WAL move) that is a proportional scan, not a bounded query. The walk instead probes `1 + (trailing unfinished steps)` MESSAGES, each probe an index search — live-validated read-only on the real DB (the running session's first probe misses its in-flight message, the second probe hits the previous step's usage; both EXPLAIN QUERY PLANs show index searches only — recorded in the round-1 review log):

```rust
/// Assistant messages of a session, newest-first — the usage walk's cursor.
/// EXPLAIN (live, read-only): `SEARCH m USING INDEX
/// message_session_time_created_id_idx (session_id=?)` — pure index walk.
const ASSISTANT_MESSAGES_NEWEST_FIRST_SQL: &str = "\
    SELECT m.id FROM message m \
    WHERE m.session_id = ?1 AND json_extract(m.data, '$.role') = 'assistant' \
    ORDER BY m.time_created DESC, m.id DESC";

/// One message's newest step-finish part — the usage walk's probe. EXPLAIN
/// (live, read-only): `SEARCH p USING INDEX part_message_id_id_idx
/// (message_id=?)`.
const MESSAGE_STEP_FINISH_SQL: &str = "\
    SELECT json_extract(p.data, '$.tokens.total'), \
           json_extract(p.data, '$.tokens.input'), \
           json_extract(p.data, '$.tokens.output'), \
           json_extract(p.data, '$.tokens.cache.read'), \
           json_extract(p.data, '$.tokens.cache.write') \
    FROM part p \
    WHERE p.message_id = ?1 AND json_extract(p.data, '$.type') = 'step-finish' \
    ORDER BY p.id DESC LIMIT 1";

/// Hard bound on the usage walk (fresh-eyes round-2 finding 2): the walk
/// may probe at most this many assistant messages before degrading to
/// `None`. Real sessions hit the step-finish on probe 1-2; a streak of 64
/// consecutive unfinished steps is pathological (flappy interrupts) and
/// the meter degrades there — a LOGGED miss, never a silent one, and
/// always bounded per session.
const USAGE_WALK_MAX_PROBES: u32 = 64;

/// Bounded per-session lookup: the NEWEST finished assistant step's token
/// usage — opencode's `lastFinished`. Walks assistant messages newest-first
/// (index order), probing each for a step-finish part; the FIRST hit is the
/// last finished step, so an in-flight or interrupted trailing step is
/// skipped naturally (live-DB verified: a running session's newest message
/// carries only step-start/reasoning parts). Work is at most
/// [`USAGE_WALK_MAX_PROBES`] message probes, each a pure index search —
/// never a whole-session part scan. Degrades to `None` on ANY
/// schema/query error or on hitting the cap.
fn last_step_finish_usage_for_session(conn: &Connection, session_id: &str) -> Option<OpencodeStepUsage> {
    let mut messages = match conn.prepare_cached(ASSISTANT_MESSAGES_NEWEST_FIRST_SQL) {
        Ok(stmt) => stmt,
        Err(e) => {
            tracing::debug!(
                session_id,
                error = %e,
                "opencode usage walk prepare failed; degrading to None"
            );
            return None;
        }
    };
    let mut probe = match conn.prepare_cached(MESSAGE_STEP_FINISH_SQL) {
        Ok(stmt) => stmt,
        Err(e) => {
            tracing::debug!(
                session_id,
                error = %e,
                "opencode usage probe prepare failed; degrading to None"
            );
            return None;
        }
    };
    let mut rows = match messages.query(rusqlite::params![session_id]) {
        Ok(rows) => rows,
        Err(e) => {
            tracing::debug!(
                session_id,
                error = %e,
                "opencode usage walk query failed; degrading to None"
            );
            return None;
        }
    };
    let mut probes: u32 = 0;
    loop {
        let message_id: Option<String> = match rows.next() {
            Ok(Some(row)) => match row.get(0) {
                Ok(id) => id,
                Err(e) => {
                    tracing::debug!(
                        session_id,
                        error = %e,
                        "opencode usage walk row read failed; degrading to None"
                    );
                    return None;
                }
            },
            Ok(None) => return None,
            Err(e) => {
                tracing::debug!(
                    session_id,
                    error = %e,
                    "opencode usage walk advance failed; degrading to None"
                );
                return None;
            }
        };
        let Some(message_id) = message_id else { continue };
        probes += 1;
        if probes >= USAGE_WALK_MAX_PROBES {
            // A bounded miss, never a silent one: 64 consecutive unfinished
            // assistant steps is pathological — degrade with observability
            // instead of walking the whole session.
            tracing::debug!(
                session_id,
                probes,
                "opencode usage walk hit the probe cap; degrading to None"
            );
            return None;
        }
        match probe.query_row(rusqlite::params![message_id], |row| {
            Ok(OpencodeStepUsage {
                total: row.get(0)?,
                input: row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                output: row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                cache_read: row.get::<_, Option<i64>>(3)?.unwrap_or(0),
                cache_write: row.get::<_, Option<i64>>(4)?.unwrap_or(0),
            })
        }) {
            Ok(usage) => {
                if probes > 8 {
                    // Observability, not truncation: a session with many
                    // trailing unfinished steps pays more probes — still
                    // bounded by its own message count, all index searches.
                    tracing::debug!(
                        session_id,
                        probes,
                        "opencode usage walk probed several messages"
                    );
                }
                return Some(usage);
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => continue,
            Err(e) => {
                tracing::debug!(
                    session_id,
                    error = %e,
                    "opencode step-finish probe failed; degrading to None"
                );
                return None;
            }
        }
    }
}
```

5. In `list_sessions`' row loop (after `first_user_message`):

```rust
            let model = row.model.as_deref().and_then(opencode_model_composite);
            // Bounded usage lookup, gated on a resolvable model: usage
            // without a model can never produce meter fields (limits are
            // resolved per model), so those sessions skip the query.
            let last_usage = if model.is_some() {
                last_step_finish_usage_for_session(&conn, &row.session_id)
            } else {
                None
            };
```

and the `OpencodeSession { ... }` construction gains `model,` and `last_usage,`.

6. `crates/freshell-sessions/src/parse/mod.rs` re-exports gain: `OpencodeModelLimits, OpencodeStepUsage, opencode_compact_percent, opencode_context_count, opencode_max_output_tokens, opencode_usable_context`.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-sessions --locked --test opencode_usage && cargo test -p freshell-sessions --locked --lib -- parse::opencode`
Expected: PASS.

- [ ] **Step 5: Refactor while green**

Check the two per-session bounded lookups (`first_user_message_for_session`, `last_step_finish_usage_for_session`) share the prepare-degrade/query-degrade skeleton; if a small `fn bounded_query_row<T>(...)` helper removes real duplication without obscuring the SQL constants, extract it. Otherwise state that the two constants stay separate deliberately (each documents its own index shape).

- [ ] **Step 6: Run impacted-test verification**

Impacted set: every suite touching the opencode parser and `OpencodeSession`/`OpencodeSessionRow` shape — listing parity, first-message, by-id probes, quarantine, directory_index lib tests, plus the server's fixture-driven suites that read opencode DBs. Narrowed, delegated runs:

Run: `cargo test -p freshell-sessions --locked --test opencode_usage --test opencode_first_message --test opencode_sqlite --test opencode_exists_by_id --test opencode_row_by_id --test opencode_subagent_by_id --test malformed_data_quarantine && cargo test -p freshell-sessions --locked --lib -- parse::opencode && cargo test -p freshell-server --locked -- session_directory:: existence auto_title_sweep`
Expected: PASS (server suites pass because the default construction is unchanged so far — `token_usage` is still `None` at this point).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-sessions/src/parse/opencode.rs crates/freshell-sessions/src/parse/mod.rs crates/freshell-sessions/tests/opencode_usage.rs
git commit -m "feat(sessions): parse opencode session model and last step-finish usage"
```

---

### Task 3: Compute the opencode TokenSummary via an injected model-limit resolver

**Files:**
- Modify: `crates/freshell-sessions/src/directory_index.rs` (resolver seam, `OpencodeSource`, `opencode_session_to_indexed`, fixture builders + tests)

**Interfaces:**
- Consumes (Task 2): `OpencodeSession.model/.last_usage`, `OpencodeModelLimits`, `opencode_usable_context`, `opencode_context_count`, `opencode_compact_percent`.
- Produces: `freshell_sessions::directory_index::OpencodeModelLimitResolver = Arc<dyn Fn(&str /* session cwd */, &str /* "provider/model" }) -> Option<parse::OpencodeModelLimits> + Send + Sync>`; `OpencodeSource::with_model_limit_resolver(OpencodeModelLimitResolver) -> Self`; `IndexedSession.token_usage` populated for opencode rows when usage + resolvable limits exist. Task 4 consumes the resolver seam.
- No changes to `IndexedSession`, `DirItem`, or any wire type.

- [ ] **Step 1: Write the failing tests**

In `directory_index.rs`'s in-file test module (`mod tests`, `pub(crate)` — the fixture builders live at `:3802-3866`):

1. Extend the fixture builder `opencode_data_home_with_sessions` so its session schema includes a `model TEXT` column (existing rows unaffected — NULL) and keep its signature; if the builder builds the DB through an internal writable conn helper, expose that conn (or a sibling builder) so tests can seed messages/parts. The fixture `message`/`part` tables must mirror the real schema's column shape (id/linkage/time as real columns — the usage walk orders messages by `time_created` and a message's parts by `id`; payloads in the JSON `data` column).
2. Add seed helpers next to it (same writable-conn convention as `seed_opencode_user_message` at `:3833-3866`):

```rust
    /// Seed an assistant message + its last step-finish part carrying the
    /// given tokens JSON (real-schema part shape: type/tokens inside the
    /// JSON `data` column).
    fn seed_opencode_step_finish(dir: &Path, session_id: &str, tokens_json: &str) {
        let conn = Connection::open(dir.join("opencode.db")).unwrap();
        conn.execute(
            "INSERT INTO message VALUES ('msg_usage', ?1, 200, '{\"role\":\"assistant\"}')",
            rusqlite::params![session_id],
        )
        .unwrap();
        // Column list must match the fixture part schema (id, message_id,
        // session_id, time_created NOT NULL, time_updated, data) — the usage
        // walk orders a message's parts by id; time columns are real-schema
        // fidelity, later inserts stamp later times.
        conn.execute(
            "INSERT INTO part VALUES ('prt_usage', 'msg_usage', ?1, 900, 900, ?2)",
            rusqlite::params![
                session_id,
                format!(r#"{{"reason":"stop","type":"step-finish","tokens":{tokens_json},"cost":0}}"#)
            ],
        )
        .unwrap();
    }

    fn set_opencode_session_model(dir: &Path, session_id: &str, model_json: &str) {
        let conn = Connection::open(dir.join("opencode.db")).unwrap();
        conn.execute(
            "UPDATE session SET model = ?1 WHERE id = ?2",
            rusqlite::params![model_json, session_id],
        )
        .unwrap();
    }
```

(Adjust table/column insert lists to the builder's real schema shape; the builders create `message`/`part` tables only in some fixtures — extend the schema creation accordingly.)

3. New tests:

```rust
    const OPENCODE_TEST_MODEL: &str = r#"{"id":"glm-5.3-vision-background","providerID":"lunaroute","variant":"default"}"#;

    fn canned_limits_resolver(
        pairs: Vec<(&'static str, freshell_sessions::parse::OpencodeModelLimits)>,
    ) -> freshell_sessions::directory_index::OpencodeModelLimitResolver {
        let map: std::collections::HashMap<String, freshell_sessions::parse::OpencodeModelLimits> =
            pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
        std::sync::Arc::new(move |_cwd: &str, model: &str| map.get(model).cloned())
    }

    #[test]
    fn opencode_resolver_receives_the_session_cwd() {
        // The resolver's FIRST parameter is the session cwd (per-catalog
        // provenance); the sessions crate must hand it through verbatim.
        let (dir, _guard) = opencode_data_home_with_sessions("usage-cwd", vec![("ses_cwd", "Named")]);
        set_opencode_session_model(&dir, "ses_cwd", OPENCODE_TEST_MODEL);
        seed_opencode_step_finish(
            &dir,
            "ses_cwd",
            r#"{"total":1000,"input":10,"output":20,"cache":{"write":0,"read":970}}"#,
        );
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen_for_resolver = seen.clone();
        let resolver: freshell_sessions::directory_index::OpencodeModelLimitResolver =
            std::sync::Arc::new(move |cwd: &str, model: &str| {
                seen_for_resolver.lock().unwrap().push((cwd.to_string(), model.to_string()));
                Some(freshell_sessions::parse::OpencodeModelLimits { context: 524_288, input: None, output: Some(131_072) })
            });
        let source = OpencodeSource::new(/* builder's data home */).with_model_limit_resolver(resolver);
        assert!(source.scan()[0].token_usage.is_some());
        assert_eq!(
            seen.lock().unwrap().as_slice(),
            [(/* builder's session directory */ "/repo/x".to_string(), "lunaroute/glm-5.3-vision-background".to_string())],
        );
    }

    #[test]
    fn opencode_source_maps_token_usage_with_resolved_limits() {
        let (dir, _guard) = opencode_data_home_with_sessions("usage-mapped", vec![("ses_usage", "Named")]);
        set_opencode_session_model(&dir, "ses_usage", OPENCODE_TEST_MODEL);
        seed_opencode_step_finish(
            &dir,
            "ses_usage",
            r#"{"total":395980,"input":31,"output":556,"reasoning":1,"cache":{"write":0,"read":395392}}"#,
        );
        let resolver = canned_limits_resolver(vec![(
            "lunaroute/glm-5.3-vision-background",
            freshell_sessions::parse::OpencodeModelLimits { context: 524_288, input: None, output: Some(131_072) },
        )]);
        let source = OpencodeSource::new(dir.join("opencode-data")) // adjust to the builder's data-home layout
            .with_model_limit_resolver(resolver);
        let sessions = source.scan();
        let usage = sessions[0].token_usage.as_ref().expect("token_usage present");
        assert_eq!(usage.input_tokens, 31);
        assert_eq!(usage.output_tokens, 556);
        assert_eq!(usage.cached_tokens, 395_392);
        assert_eq!(usage.total_tokens, 395_980);
        assert_eq!(usage.context_tokens, Some(395_980));
        assert_eq!(usage.model_context_window, Some(524_288));
        assert_eq!(usage.compact_threshold_tokens, Some(492_288));
        assert_eq!(usage.compact_percent, Some(80));
    }

    #[test]
    fn opencode_usage_without_resolver_keeps_meter_fields_absent() {
        // usage + model exist, no resolver injected: the four required
        // counters and contextTokens still surface; the meter's three
        // fields stay None (client guard -> muted "context —").
        let (dir, _guard) = opencode_data_home_with_sessions("usage-unresolved", vec![("ses_usage", "Named")]);
        set_opencode_session_model(&dir, "ses_usage", OPENCODE_TEST_MODEL);
        seed_opencode_step_finish(
            &dir,
            "ses_usage",
            r#"{"total":1000,"input":10,"output":20,"cache":{"write":0,"read":970}}"#,
        );
        let sessions = OpencodeSource::new(/* builder's data home */).scan();
        let usage = sessions[0].token_usage.as_ref().expect("token_usage present");
        assert_eq!(usage.context_tokens, Some(1_000));
        assert_eq!(usage.compact_threshold_tokens, None);
        assert_eq!(usage.compact_percent, None);
        assert_eq!(usage.model_context_window, None);
    }

    #[test]
    fn opencode_zero_context_limit_yields_no_meter() {
        // limit.context 0 == upstream disables auto-compaction: threshold,
        // percent AND modelContextWindow stay None (the wire zod is
        // `.positive()` — emitting 0 would reject the whole page parse).
        let (dir, _guard) = opencode_data_home_with_sessions("usage-zero-ctx", vec![("ses_usage", "Named")]);
        set_opencode_session_model(&dir, "ses_usage", OPENCODE_TEST_MODEL);
        seed_opencode_step_finish(
            &dir,
            "ses_usage",
            r#"{"total":100,"input":10,"output":10,"cache":{"write":0,"read":80}}"#,
        );
        let resolver = canned_limits_resolver(vec![(
            "lunaroute/glm-5.3-vision-background",
            freshell_sessions::parse::OpencodeModelLimits { context: 0, input: None, output: None },
        )]);
        let source = OpencodeSource::new(/* builder's data home */).with_model_limit_resolver(resolver);
        let usage = source.scan()[0].token_usage.as_ref().expect("token_usage present");
        assert_eq!(usage.model_context_window, None);
        assert_eq!(usage.compact_threshold_tokens, None);
        assert_eq!(usage.compact_percent, None);
    }

    #[test]
    fn opencode_session_without_usage_has_no_token_usage() {
        let (dir, _guard) = opencode_data_home_with_sessions("usage-absent", vec![("ses_plain", "Named")]);
        set_opencode_session_model(&dir, "ses_plain", OPENCODE_TEST_MODEL);
        let resolver = canned_limits_resolver(vec![(
            "lunaroute/glm-5.3-vision-background",
            freshell_sessions::parse::OpencodeModelLimits { context: 524_288, input: None, output: Some(131_072) },
        )]);
        let source = OpencodeSource::new(/* builder's data home */).with_model_limit_resolver(resolver);
        assert!(source.scan()[0].token_usage.is_none());
    }
```

(Adjust the `opencode_data_home_with_sessions` call shape to its real signature — it may return a data-home path directly rather than a tuple; mirror the existing tests at `:3868-3893`.)

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-sessions --locked --lib -- directory_index::tests::opencode`
Expected: FAIL — `with_model_limit_resolver` does not exist (compile error).

- [ ] **Step 3: Add the minimal production implementation**

In `crates/freshell-sessions/src/directory_index.rs`:

1. Resolver seam (above the `OpencodeSource` struct, ~line 676):

```rust
/// Sync model-limit resolver handed to [`OpencodeSource`] by the
/// freshell-server composition root: `(session cwd, model id
/// ("provider/model")) -> limits`. The directory sweep runs on
/// `spawn_blocking`, so the seam is synchronous by contract — production
/// reads a pre-warmed snapshot (cwd-keyed so a project-scoped catalog can
/// never leak another project's limits), and the default (no resolver)
/// always answers `None`, keeping every existing construction
/// meter-unknown.
pub type OpencodeModelLimitResolver = std::sync::Arc<
    dyn Fn(&str, &str) -> Option<crate::parse::OpencodeModelLimits> + Send + Sync,
>;
```

2. `OpencodeSource` gains the field + builder (keeping `new` signature unchanged — every existing call site stays valid):

```rust
pub struct OpencodeSource {
    provider: crate::parse::OpencodeProvider,
    model_limit_resolver: Option<OpencodeModelLimitResolver>,
}

impl OpencodeSource {
    pub fn new(data_home: PathBuf) -> Self {
        Self {
            provider: crate::parse::OpencodeProvider::new(data_home),
            model_limit_resolver: None,
        }
    }

    /// Inject the model-limit resolver (production wiring only; tests seed
    /// canned limits through it).
    pub fn with_model_limit_resolver(mut self, resolver: OpencodeModelLimitResolver) -> Self {
        self.model_limit_resolver = Some(resolver);
        self
    }

    // ... existing scan() unchanged ...
}
```

3. `direct_list` passes the resolver into the mapping:

```rust
    fn direct_list(&self) -> Result<Vec<IndexedSession>, String> {
        let listing = self
            .provider
            .list_sessions(now_ms())
            .map_err(|e| e.to_string())?;
        let resolver: Option<&dyn Fn(&str, &str) -> Option<crate::parse::OpencodeModelLimits>> =
            self.model_limit_resolver.as_deref();
        Ok(listing
            .sessions
            .into_iter()
            .map(|s| opencode_session_to_indexed(s, resolver))
            .collect())
    }
```

4. The compute site — replace the `token_usage: None` arm (and its false comment, `:789-791`) in `opencode_session_to_indexed`:

```rust
        // STATUS-STRIP: real step-finish usage + catalog-resolved limits —
        // opencode's own auto-compaction decision mirrored (see
        // parse/opencode.rs's overflow-semantics docs and
        // docs/plans/2026-09-14-freshopencode-context-meter.md).
        token_usage: opencode_token_usage(&s, resolver),
```

and the mapping fn gains the `resolver` parameter (signature:
`fn opencode_session_to_indexed(s: crate::parse::OpencodeSession, resolver: Option<&dyn Fn(&str, &str) -> Option<crate::parse::OpencodeModelLimits>>) -> IndexedSession`), plus the new assembly helper next to it:

```rust
/// Assemble the opencode [`TokenSummary`]: the four required counters plus
/// the meter trio, mirroring opencode v1.18.31's auto-compaction trigger
/// (`session/overflow.ts` `isOverflow` over the last finished assistant
/// step): count vs `usable`, so 100% == the exact auto-compact moment.
/// Usage with unresolvable limits still emits the required counters (the
/// client guard keeps the meter muted); no usage emits `None`.
fn opencode_token_usage(
    s: &crate::parse::OpencodeSession,
    resolver: Option<&dyn Fn(&str, &str) -> Option<crate::parse::OpencodeModelLimits>>,
) -> Option<crate::meta::TokenSummary> {
    let usage = s.last_usage.as_ref()?;
    let count = crate::parse::opencode_context_count(usage);
    let cached = usage.cache_read.max(0).saturating_add(usage.cache_write.max(0));
    let (model_context_window, compact_threshold_tokens, compact_percent) =
        match s.model.as_deref().and_then(|model| resolver?(s.cwd.as_str(), model)) {
            None => (None, None, None),
            Some(limits) => {
                let usable = crate::parse::opencode_usable_context(&limits);
                (
                    // NEVER emit 0/negative: the wire zod is `.positive()`
                    // and one violating item rejects the whole page parse
                    // (api.ts:646/:681). Zero-context resolves to None here.
                    (limits.context > 0).then_some(limits.context),
                    (usable > 0).then_some(usable),
                    crate::parse::opencode_compact_percent(count, usable),
                )
            }
        };
    Some(crate::meta::TokenSummary {
        input_tokens: usage.input.max(0),
        output_tokens: usage.output.max(0),
        cached_tokens: cached,
        total_tokens: count,
        context_tokens: Some(count),
        model_context_window,
        compact_threshold_tokens,
        compact_percent,
    })
}
```

(`resolver?(s.cwd.as_str(), model)` — the `?` on `Option<&dyn Fn…>` short-circuits to the `None` arm when no resolver is installed. The session cwd rides along so the server-side snapshot can resolve per-project catalogs without cross-project limit leaks.)

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-sessions --locked --lib -- directory_index::tests::opencode`
Expected: PASS.

- [ ] **Step 5: Refactor while green**

Keep `opencode_token_usage` beside `opencode_session_to_indexed`; no further refactor expected — state so if nothing emerges.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: the sessions crate's opencode surfaces (the mapping fn signature changed and `OpencodeSource` grew a field) plus every server suite that constructs `OpencodeSource` or asserts on opencode listings (existence, auto_title_sweep, session_directory fixture suites). Narrowed, delegated runs:

Run: `cargo test -p freshell-sessions --locked --lib -- directory_index::tests::opencode parse::opencode && cargo test -p freshell-sessions --locked --test opencode_usage --test opencode_first_message --test opencode_sqlite && cargo test -p freshell-server --locked -- session_directory:: existence auto_title_sweep`
Expected: PASS (server behavior unchanged — production wiring is still meter-unknown until Task 4).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-sessions/src/directory_index.rs
git commit -m "feat(sessions): compute opencode TokenSummary via injected model-limit resolver"
```

---

### Task 4: Wire the server snapshot, prove the HTTP contract, correct the stale claims

**Files:**
- Create: `crates/freshell-server/src/opencode_limits.rs` (snapshot + refresh task)
- Modify: `crates/freshell-server/src/main.rs` (module decl, snapshot, resolver wiring at the `OpencodeSource` construction ~line 711, refresh-task spawn)
- Modify: `crates/freshell-server/src/session_directory.rs` (stale comment `:156-161`; integration test in `mod tests`)
- Modify: `src/components/fresh-agent/FreshAgentView.tsx:629-632` (comment reword only)
- Modify: `docs/plans/2026-08-24-fresh-agent-status-strip.md:36` (correct the false claim)

**Interfaces:**
- Consumes (Task 1): `FreshAgentState::model_capabilities()`, `ModelCapabilityRegistry::models()`, `freshell_freshagent::model_capabilities::{ModelCapability, ModelLimits}`; (Task 3): `OpencodeSource::with_model_limit_resolver`, `OpencodeModelLimitResolver`; (Task 2): `freshell_sessions::parse::OpencodeModelLimits`.
- Produces: `opencode_limits::{snapshot() -> Snapshot, refresh_loop(...), build_opencode_limit_resolver(...)}` with `Snapshot = Arc<RwLock<HashMap<String /* bucket: "" = default catalog, else the cwd */, HashMap<String /* model id */, OpencodeModelLimits>>>>` (bucket PRESENCE records a successful probe — even an empty one; absence means unprobed, where default-catalog fallback is allowed); `main.rs` gains `pub(crate) fn build_session_sources(home: &Path, opencode_limits: &Snapshot) -> Vec<Arc<dyn SessionSource>>` — the composition root's exact source list, shared with the wiring test. No wire-protocol or client behavior changes.

- [ ] **Step 1: Write the failing tests**

1. Add `mod opencode_limits;` to `crates/freshell-server/src/main.rs` NOW (next to the other crate-local module declarations) — a bin-crate module file is undiscovered without the declaration, and the red step below must actually see these tests fail. Then create `crates/freshell-server/src/opencode_limits.rs` with its `mod tests` (the production parts come in Step 3; the helpers below are what the tests exercise):

```rust
    #[test]
    fn limit_map_keeps_limit_bearing_models() {
        let map = limit_map(vec![
            model_capability("lunaroute/glm-5.3", Some((524_288, None, Some(131_072)))),
            model_capability("lunaroute/unlimited", None),
        ]);
        assert_eq!(
            map.get("lunaroute/glm-5.3"),
            Some(&OpencodeModelLimits { context: 524_288, input: None, output: Some(131_072) })
        );
        assert!(!map.contains_key("lunaroute/unlimited"));
    }

    #[test]
    fn recent_opencode_cwds_distinct_recent_first_and_capped() {
        let sessions: Vec<IndexedSession> = (0..20)
            .map(|i| {
                let mut s = minimal_indexed_session(&format!("ses_{i}"), "opencode");
                s.cwd = Some(if i % 2 == 0 { "/repo/a" } else { "/repo/b" }.to_string());
                s.last_activity_at = i;
                s
            })
            .chain(std::iter::once({
                let mut s = minimal_indexed_session("ses_claude", "claude");
                s.cwd = Some("/repo/a".to_string());
                s.last_activity_at = 999;
                s
            }))
            .collect();
        let cwds = recent_opencode_cwds(&sessions, 2);
        assert_eq!(cwds, vec!["/repo/b".to_string(), "/repo/a".to_string()]);
    }

    #[test]
    fn replace_bucket_wholesale_learns_removals_and_reports_change() {
        // Wholesale bucket replacement: a catalog that DROPPED a limit
        // removes the stale entry (that model's sessions meter-unknown
        // again — never a permanently-stale threshold), and only real
        // content changes report `true` (the re-list nudge signal).
        let snap = snapshot();
        let a = OpencodeModelLimits { context: 1, input: None, output: None };
        assert!(replace_bucket(&snap, "/repo/a", [("m/x".into(), a.clone())].into())); // first fill: change
        assert!(!replace_bucket(&snap, "/repo/a", [("m/x".into(), a.clone())].into())); // identical: no change
        let changed = OpencodeModelLimits { context: 2, input: None, output: None };
        assert!(replace_bucket(&snap, "/repo/a", [("m/x".into(), changed)].into())); // value changed: change
        // a probe that now returns NO limit-bearing models keeps the
        // bucket PRESENT but empty (authoritative "unresolvable") and
        // reports change
        assert!(replace_bucket(&snap, "/repo/a", std::collections::HashMap::new()));
        assert!(resolve_from_snapshot(&snap, "/repo/a", "m/x").is_none());
        // ...and the DEFAULT catalog must NOT resurrect the model for
        // that cwd (empty-probed ≠ unprobed; wrong data is worse than an
        // unknown meter)
        let mut default_catalog = std::collections::HashMap::new();
        default_catalog.insert("m/x".to_string(), OpencodeModelLimits { context: 500_000, input: None, output: None });
        assert!(replace_bucket(&snap, "", default_catalog));
        assert!(resolve_from_snapshot(&snap, "/repo/a", "m/x").is_none());
        // an UNPROBED cwd still falls back to the default catalog
        assert_eq!(resolve_from_snapshot(&snap, "/repo/never-probed", "m/x").unwrap().context, 500_000);
    }

    #[test]
    fn resolver_prefers_session_cwd_bucket_then_default_with_effort_strip() {
        // cwd-keyed buckets: a project-scoped catalog can never leak
        // another project's limits, and a cwd without its own catalog falls
        // back to the default (cwd-less) one. Effort strip: 3+ segment
        // composites resolve their configured base; 2-segment misses stay
        // misses.
        let snap = snapshot();
        replace_bucket(
            &snap,
            "",
            [("lunaroute/deepseek-4.1-flash".into(), OpencodeModelLimits { context: 1_048_576, input: None, output: Some(262_144) })].into(),
        );
        replace_bucket(
            &snap,
            "/repo/a",
            [("lunaroute/glm-5.3".into(), OpencodeModelLimits { context: 200_000, input: None, output: Some(131_072) })].into(),
        );
        // the cwd bucket wins for its own project
        assert_eq!(resolve_from_snapshot(&snap, "/repo/a", "lunaroute/glm-5.3").unwrap().context, 200_000);
        // a probed cwd bucket that LACKS a model is authoritative: the
        // default catalog must NOT resurrect that model for this project
        assert_eq!(resolve_from_snapshot(&snap, "/repo/a", "lunaroute/deepseek-4.1-flash"), None);
        // an UNPROBED cwd (no bucket) falls back to the default catalog —
        // no leak of /repo/a's limits either
        assert_eq!(resolve_from_snapshot(&snap, "/repo/other", "lunaroute/glm-5.3"), None);
        assert_eq!(resolve_from_snapshot(&snap, "/repo/other", "lunaroute/deepseek-4.1-flash").unwrap().context, 1_048_576);
        // exact match is tried first; 2-segment misses never strip
        assert!(resolve_from_snapshot(&snap, "/repo/other", "lunaroute/unknown").is_none());
        // effort-suffixed composite (3+ segments) resolves its base
        assert_eq!(resolve_from_snapshot(&snap, "/repo/other", "lunaroute/deepseek-4.1-flash/low").unwrap().context, 1_048_576);
    }

    #[tokio::test]
    async fn refresh_once_fills_the_snapshot_relists_and_lights_the_meter() {
        // The production-wiring test (plan-review finding 5): registry →
        // refresh_once → snapshot → the PRODUCTION resolver closure →
        // mark_provider_dirty → re-list → meter visible — built from
        // `crate::build_session_sources`, the SAME factory `main` uses for
        // its source list, so dropping the resolver injection or the
        // snapshot plumbing from the factory FAILS this test. A REAL
        // `ModelCapabilityRegistry` built via its test seams with a
        // scripted catalog probe (one ModelCapability with a limit —
        // mirrors the registry's existing scripted-probe tests), a fixture
        // opencode.db under a temp data home (seeded with a model + a last
        // step-finish part, mirroring the Task 3 fixture helpers), and a
        // temp home dir for the other providers' sources. After ONE
        // `refresh_once(...)` cycle the test asserts, driving the index's
        // refresh the same way the existing mark_provider_dirty tests do
        // (directory_index.rs:5900+; generation-bump pins at :2925+):
        //   (a) the snapshot's default bucket contains the probe's limits;
        //   (b) `resolve_from_snapshot` now resolves the fixture session's
        //       model for its cwd;
        //   (c) the re-listed indexed row's `token_usage` carries
        //       compactThresholdTokens/compactPercent (the meter is lit)
        //       — WITHOUT any new opencode DB write (proves the F2 nudge);
        //   (d) the index's change generation advanced (broadcast armed).
        // The one seam no unit test can reach is main()'s three one-liners
        // (snapshot creation, factory call, refresh-loop spawn) — those
        // are verified by the Stage-5 independent delta review.
    }
```

(`model_capability`/`minimal_indexed_session` are test helpers — `minimal_indexed_session` builds an `IndexedSession` via the crate's existing test builder conventions; if none is reachable in a bin-crate `mod tests`, construct the struct literally, filling non-relevant fields with `None`/defaults — it has no `Default`, so a small local builder fn is fine.)

2. In `crates/freshell-server/src/session_directory.rs` `mod tests` — the HTTP contract test (the e2e-of-record for the data path: real fixture DB → real `OpencodeSource` → real index → real router). Locate the existing fixture-opencode.db wiring test (the `app.oneshot(...)` test whose body builds an inline opencode.db near `:4309-4323`) and mirror its app/router construction exactly; the new test:

```rust
    #[tokio::test]
    async fn opencode_session_directory_items_carry_context_meter_token_usage() {
        // fixture opencode.db: one session with model JSON + a last
        // step-finish carrying tokens, indexed through a REAL OpencodeSource
        // whose resolver returns the lunaroute deployment limits.
        let home = fixture_opencode_data_home_with_usage(); // new helper: mirrors the
        // inline fixture-db construction of the neighboring opencode wiring
        // tests (~:4309-4323), adding a `model` column value and an
        // assistant message + step-finish part.
        let resolver: freshell_sessions::directory_index::OpencodeModelLimitResolver =
            std::sync::Arc::new(|_cwd: &str, model: &str| match model {
                "lunaroute/glm-5.3-vision-background" => Some(
                    freshell_sessions::parse::OpencodeModelLimits { context: 524_288, input: None, output: Some(131_072) },
                ),
                _ => None,
            });
        let app = build_test_app_with_sources(vec![Arc::new(
            freshell_sessions::directory_index::OpencodeSource::new(home)
                .with_model_limit_resolver(resolver),
        )]); // mirror the neighboring test's app/state construction

        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/session-directory?tier=title")
                    .header("x-auth-token", "tok")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body: serde_json::Value =
            serde_json::from_slice(&axum::body::to_bytes(response.into_body(), 1 << 20).await.unwrap()).unwrap();
        let item = body["items"].as_array().unwrap().iter()
            .find(|i| i["provider"] == "opencode")
            .expect("opencode item present");
        let usage = &item["tokenUsage"];
        assert_eq!(usage["inputTokens"], 31);
        assert_eq!(usage["outputTokens"], 556);
        assert_eq!(usage["cachedTokens"], 395_392);
        assert_eq!(usage["totalTokens"], 395_980);
        assert_eq!(usage["contextTokens"], 395_980);
        assert_eq!(usage["modelContextWindow"], 524_288);
        assert_eq!(usage["compactThresholdTokens"], 492_288);
        assert_eq!(usage["compactPercent"], 80);
    }

    #[tokio::test]
    async fn opencode_items_without_resolver_omit_meter_fields_on_the_wire() {
        // same fixture, NO resolver: tokenUsage still present with the
        // required counters, and compactThresholdTokens/compactPercent
        // keys ABSENT (zod .optional() semantics) -> client meter muted.
        // ... mirror the construction above without with_model_limit_resolver ...
        let usage = &item["tokenUsage"];
        assert_eq!(usage["contextTokens"], 395_980);
        assert!(usage.get("compactThresholdTokens").is_none());
        assert!(usage.get("compactPercent").is_none());
    }

    #[tokio::test]
    async fn opencode_items_with_zero_context_limits_omit_window_and_meter_fields() {
        // F1's wire contract: a RESOLVED zero-context limit must NOT emit
        // modelContextWindow at all (zod `.positive()` — a 0 would reject the
        // whole page parse at api.ts:646/:681). Same fixture; the resolver
        // maps the model to {context: 0, input: None, output: None}.
        // ... mirror the first test's construction with the zero-context resolver ...
        let usage = &item["tokenUsage"];
        assert_eq!(usage["inputTokens"], 31);
        assert!(usage.get("modelContextWindow").is_none());
        assert!(usage.get("compactThresholdTokens").is_none());
        assert!(usage.get("compactPercent").is_none());
    }
```

(Adapt the request-building and app-construction helpers to the file's real test scaffolding — the neighboring tests are the authoritative harness shape; keep the JSON assertions byte-exact as written.)

3. Client comment reword (`src/components/fresh-agent/FreshAgentView.tsx:629-632`) — replace with:

```ts
    // Status-strip context meter source: the unified usage map stamped by
    // committed sidebar refreshes (fresh rows + out-of-band extras). Deliberately
    // NOT the fresh-agent snapshot tokenUsage — that channel never carries
    // compactPercent on any provider, so reading it would be a silent
    // "always unknown" bug. (The session-directory channel itself carries
    // complete opencode usage too — see
    // docs/plans/2026-09-14-freshopencode-context-meter.md.)
```

4. Plan-doc correction (`docs/plans/2026-08-24-fresh-agent-status-strip.md:36`) — replace the sentence
`freshopencode always renders the approved muted `context —` (no opencode token usage exists upstream — deliberate, not a bug).`
with:
``freshopencode rendered the approved muted `context —` at the time of this plan — the then-believed "no opencode token usage exists upstream" claim was WRONG (opencode persists step-finish token usage in opencode.db and exposes model limits via `/config/providers`); superseded by docs/plans/2026-09-14-freshopencode-context-meter.md, which computes the opencode TokenSummary server-side and lights the meter up.``

5. `crates/freshell-server/src/session_directory.rs:156-161` — the `token_usage` field doc currently ends "(opencode direct rows, live-terminal synthesized items)". Replace that parenthetical with "(live-terminal synthesized items; opencode direct rows carry real step-finish usage since the context-meter fix)".

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-server --locked -- opencode_limits`
Expected: FAIL — compile error (`mod opencode_limits;` is declared from Step 1, so the tests ARE discovered; `limit_map`/`replace_bucket`/`resolve_from_snapshot`/`build_opencode_limit_resolver`/`refresh_once` do not exist yet). A passing zero-test run here means the module declaration was forgotten — do not proceed on a vacuous green.

Run: `cargo test -p freshell-server --locked -- session_directory::tests`
Expected: FAIL (new tests fail: `with_model_limit_resolver` missing and/or tokenUsage absent on opencode items — compile-first, then assertion).

Run: `npm run typecheck`
Expected: PASS (comment-only client change) — run it here to catch accidental syntax damage from the reword.

- [ ] **Step 3: Add the minimal production implementation**

`crates/freshell-server/src/opencode_limits.rs` (new module):

```rust
//! Server-side opencode model-limit snapshot for the session-directory
//! context meter.
//!
//! The sessions indexer resolves per-session model limits through a SYNC
//! resolver (the directory sweep runs on `spawn_blocking`); the catalog
//! probe is async and process-spawning. This module owns the bridge: an
//! async refresh task reads the freshagent `ModelCapabilityRegistry`
//! (TTL/single-flight inside the registry) and stores per-catalog buckets
//! — `bucket ("" = the default cwd-less catalog, else the cwd) -> model id
//! -> limits` — in a sync-read snapshot; the resolver closure handed to
//! `OpencodeSource` (built by [`build_opencode_limit_resolver`], the exact
//! production wiring) reads it with the SESSION's cwd, so a project-scoped
//! catalog can never leak another project's limits. Buckets are replaced
//! WHOLESALE on every successful probe, so a config edit that removes a
//! limit is learned — that model's sessions meter-unknown again instead of
//! carrying a stale threshold forever. A cold or failed refresh keeps the
//! meter unknown — the accepted graceful degradation. A refresh that
//! CHANGES any bucket marks the opencode provider dirty so the index
//! re-lists and broadcasts without needing an opencode DB write (a warm
//! snapshot alone would leave frozen DirectEntry rows meter-muted until
//! unrelated activity). A cwd bucket's PRESENCE (even empty) records a
//! successful probe and is authoritative for that cwd — resolutions for
//! that project never fall back to the default catalog (wrong data is
//! worse than an unknown meter); only never-probed cwds fall back. The
//! resolver lookup is exact-match first with a
//! single effort-suffix strip (opencode stores the runtime model as
//! `model/effort`; the catalog keys base models only — live-verified).

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use freshell_freshagent::model_capabilities::{ModelCapability, ModelCapabilityRegistry, SessionType};
use freshell_sessions::directory_index::{IndexedSession, OpencodeModelLimitResolver, SessionIndex};
use freshell_sessions::parse::OpencodeModelLimits;

/// Refresh cadence. The registry's own 5-min TTL absorbs the ticks: a tick
/// is a cache read except once per TTL window per catalog.
pub const REFRESH_INTERVAL: Duration = Duration::from_secs(60);
/// Beyond the default (cwd-less) catalog, the per-cwd catalogs probed per
/// cycle: the distinct cwds of the most recent opencode sessions. Bounded
/// so a directory full of distinct worktrees can never spawn an
/// unbounded probe storm.
pub const PER_CWD_SESSION_WINDOW: usize = 16;
/// The bucket key for the cwd-less default catalog (mirrors the registry's
/// own blank-cwd-as-default discipline, `catalog_cache_key`).
pub const DEFAULT_BUCKET: &str = "";

/// `bucket -> (model id -> limits)`. Buckets keep per-project catalogs
/// separate; wholesale replacement keeps entries honest.
pub type Snapshot = Arc<RwLock<HashMap<String, HashMap<String, OpencodeModelLimits>>>>;

pub fn snapshot() -> Snapshot {
    Arc::new(RwLock::new(HashMap::new()))
}

/// The snapshot bucket a catalog belongs to: the trimmed cwd, or the
/// default bucket for a missing/blank cwd.
fn bucket_for_cwd(cwd: Option<&str>) -> String {
    cwd.map(str::trim)
        .filter(|c| !c.is_empty())
        .unwrap_or(DEFAULT_BUCKET)
        .to_string()
}

/// One successful catalog's limit-bearing models, keyed by composite model
/// id (models without a limit block are absent — unresolvable, meter
/// unknown).
pub(crate) fn limit_map(models: Vec<ModelCapability>) -> HashMap<String, OpencodeModelLimits> {
    models
        .into_iter()
        .filter_map(|model| {
            model.limit.map(|limit| {
                (
                    model.id,
                    OpencodeModelLimits { context: limit.context, input: limit.input, output: limit.output },
                )
            })
        })
        .collect()
}

/// Snapshot lookup for a session: its OWN cwd's bucket when that catalog
/// has been successfully probed (authoritative — a miss inside it is a
/// real "unresolvable"; a different limit must never be resurrected from
/// the default catalog, because wrong data is worse than an unknown
/// meter); only a NEVER-PROBED cwd (absent bucket) falls back to the
/// default catalog's bucket. Within each bucket: exact composite match
/// first; if that misses and the composite has 3+ segments
/// (`provider/model/effort` — opencode stores the runtime model with the
/// effort suffix; live-verified the catalog keys only base models), strip
/// ONE trailing segment and retry the base. Two-segment composites never
/// strip. Residual (accepted): a `provider/org/name/effort` id whose
/// stripped base is configured resolves the base's limits — the same
/// model family, the same base-then-variant resolution order opencode
/// itself uses.
pub(crate) fn resolve_from_snapshot(
    snap: &Snapshot,
    cwd: &str,
    model: &str,
) -> Option<OpencodeModelLimits> {
    let map = snap.read().ok()?;
    let try_bucket = |models: &HashMap<String, OpencodeModelLimits>| -> Option<OpencodeModelLimits> {
        if let Some(limits) = models.get(model) {
            return Some(limits.clone());
        }
        if model.matches('/').count() >= 2 {
            if let Some((base, _)) = model.rsplit_once('/') {
                return models.get(base).cloned();
            }
        }
        None
    };
    let bucket = bucket_for_cwd(Some(cwd));
    if !bucket.is_empty() {
        // Bucket PRESENCE (even an empty one) means the cwd's catalog was
        // successfully probed: it is authoritative for this cwd.
        if let Some(models) = map.get(&bucket) {
            return try_bucket(models);
        }
    }
    map.get(DEFAULT_BUCKET).and_then(try_bucket)
}

/// The production resolver closure `main.rs` hands to `OpencodeSource` —
/// factored out so the exact production wiring is unit-testable (the
/// plan-review chain test drives the same closure).
pub fn build_opencode_limit_resolver(snap: Snapshot) -> OpencodeModelLimitResolver {
    Arc::new(move |cwd: &str, model: &str| resolve_from_snapshot(&snap, cwd, model))
}

/// Record one catalog's limit map in its bucket, WHOLESALE — a catalog
/// that DROPPED a limit removes the stale entry (that model's sessions
/// meter-unknown again; never a permanently-stale threshold). Bucket
/// PRESENCE is the probe-authority marker: even an EMPTY limit map keeps
/// the bucket present, because a successfully probed catalog carrying no
/// limits is an authoritative "unresolvable" for that cwd (an empty
/// bucket must never be conflated with an unprobed one). Returns `true`
/// when the bucket content changed (the re-list nudge signal — an
/// identical refresh must not nudge). A poisoned lock returns false —
/// the next cycle retries.
pub(crate) fn replace_bucket(snap: &Snapshot, bucket: &str, fresh: HashMap<String, OpencodeModelLimits>) -> bool {
    let Ok(mut map) = snap.write() else {
        return false;
    };
    let changed = map.get(bucket) != Some(&fresh);
    map.insert(bucket.to_string(), fresh);
    changed
}

/// The distinct cwds of the `window` most recent opencode sessions,
/// most-recent first (deduped).
pub(crate) fn recent_opencode_cwds(sessions: &[IndexedSession], window: usize) -> Vec<String> {
    let mut opencode: Vec<&IndexedSession> = sessions
        .iter()
        .filter(|s| s.provider == "opencode")
        .collect();
    opencode.sort_by_key(|s| std::cmp::Reverse(s.last_activity_at));
    let mut seen = std::collections::HashSet::new();
    let mut cwds = Vec::new();
    for session in opencode {
        let Some(cwd) = session.cwd.as_deref().filter(|c| !c.is_empty()) else {
            continue;
        };
        if seen.insert(cwd.to_string()) {
            cwds.push(cwd.to_string());
            if cwds.len() == window {
                break;
            }
        }
    }
    cwds
}

async fn refresh_once(
    registry: &ModelCapabilityRegistry,
    session_index: &SessionIndex,
    snap: &Snapshot,
) {
    // `?e` (Debug): CapabilityError implements Debug, not Display.
    let mut nudge = false;
    match registry.models(SessionType::FreshOpencode, None).await {
        Ok(models) => {
            if replace_bucket(snap, DEFAULT_BUCKET, limit_map(models)) {
                nudge = true;
            }
        }
        Err(e) => tracing::warn!(error = ?e, "opencode default catalog probe failed; keeping previous limits"),
    }
    let sessions = session_index.snapshot().await;
    for cwd in recent_opencode_cwds(&sessions, PER_CWD_SESSION_WINDOW) {
        match registry.models(SessionType::FreshOpencode, Some(cwd.clone())).await {
            Ok(models) => {
                if replace_bucket(snap, &bucket_for_cwd(Some(&cwd)), limit_map(models)) {
                    nudge = true;
                }
            }
            Err(e) => tracing::debug!(cwd = %cwd, error = ?e, "opencode per-cwd catalog probe failed; keeping previous limits"),
        }
    }
    if nudge {
        // F2: a bucket changed (first fill after boot, a new model, a
        // config edit) — nudge a re-list so already-listed opencode rows
        // pick the new limits up without waiting for an unrelated opencode
        // DB write (DirectEntry rows are change-token/dirty-gated only).
        // The forced re-list counts as changed and advances the change
        // generation, so `subscribe_changes` consumers broadcast and idle
        // sessions' meters light up.
        session_index.mark_provider_dirty("opencode");
    }
}

/// Runs forever: refresh the snapshot every [`REFRESH_INTERVAL`].
pub async fn refresh_loop(
    registry: Arc<ModelCapabilityRegistry>,
    session_index: Arc<SessionIndex>,
    snap: Snapshot,
) -> ! {
    loop {
        refresh_once(&registry, &session_index, &snap).await;
        tokio::time::sleep(REFRESH_INTERVAL).await;
    }
}
```

`crates/freshell-server/src/main.rs`:

1. Module decl: already added in Step 1 (`mod opencode_limits;`).
2. Before the `session_index` construction (~line 703): `let opencode_limits = opencode_limits::snapshot();`
3. Factor the composition root's source list into a `pub(crate)` factory — `main` and the wiring test build the source list from the SAME fn, so dropping the resolver injection or the snapshot plumbing fails that test (the opencode data home is a parameter so the test can point it at a fixture DB; `main` passes `default_opencode_data_home()`):

```rust
/// The composition root's session-source list — the exact list `main`
/// installs into `SessionIndex`. Factored so the production wiring is the
/// tested artifact: the opencode_limits wiring test builds its index from
/// this same fn.
pub(crate) fn build_session_sources(
    home: &std::path::Path,
    opencode_data_home: std::path::PathBuf,
    opencode_limits: &opencode_limits::Snapshot,
) -> Vec<std::sync::Arc<dyn freshell_sessions::directory_index::SessionSource>> {
    vec![
        std::sync::Arc::new(freshell_sessions::directory_index::ClaudeSource::new(
            session_directory::claude_home(home),
        )) as std::sync::Arc<dyn freshell_sessions::directory_index::SessionSource>,
        std::sync::Arc::new(freshell_sessions::directory_index::CodexSource::new(
            session_directory::codex_home(home),
        )) as std::sync::Arc<dyn freshell_sessions::directory_index::SessionSource>,
        std::sync::Arc::new(
            freshell_sessions::directory_index::OpencodeSource::new(opencode_data_home)
                .with_model_limit_resolver(opencode_limits::build_opencode_limit_resolver(
                    opencode_limits.clone(),
                )),
        ) as std::sync::Arc<dyn freshell_sessions::directory_index::SessionSource>,
        std::sync::Arc::new(freshell_sessions::amplifier::AmplifierSource::new(
            freshell_sessions::amplifier::amplifier_home(home),
        )) as std::sync::Arc<dyn freshell_sessions::directory_index::SessionSource>,
    ]
}
```

and `main`'s `session_index` construction (~line 703) becomes:

```rust
    let session_index = session_directory::provider_home().as_ref().map(|h| {
        Arc::new(freshell_sessions::directory_index::SessionIndex::new(
            build_session_sources(
                h,
                freshell_sessions::parse::default_opencode_data_home(),
                &opencode_limits,
            ),
        ))
    });
```

(The remaining untestable seam is `main`'s three one-liners — snapshot creation, the factory call, the refresh-loop spawn — which the Stage-5 independent delta review verifies; every layer below them is test-covered.)

4. Refresh-task spawn — where BOTH the `FreshAgentState` (as `Arc`) and the `session_index` are in scope (locate the `FreshAgentState` construction in `main`; if it is constructed after the index, spawn there — the resolver closure only captured the snapshot, so ordering is free):

```rust
    if let (Some(index), Some(fresh_agent_state)) = (&session_index, &fresh_agent_state) {
        let registry = fresh_agent_state.model_capabilities();
        let snap = opencode_limits.clone();
        let idx = index.clone();
        tokio::spawn(async move {
            opencode_limits::refresh_loop(registry, idx, snap).await;
        });
    }
```

(If `fresh_agent_state` is not `Option`, drop the tuple-let accordingly. If `SessionIndex` is not `Arc`-shared in the shape shown, mirror how the existing sweep task obtains its index handle — the snapshot() API is async and the type is `Arc<SessionIndex>` at the construction site already.)

5. The session_directory.rs integration-test scaffolding from Step 1 gets its `fixture_opencode_data_home_with_usage` helper implemented (mirroring the neighboring inline fixture construction, with `model` column + assistant message + step-finish part) and its app construction adapted to inject the resolver-bearing `OpencodeSource`.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-server --locked -- opencode_limits && cargo test -p freshell-server --locked -- session_directory::`
Expected: PASS.

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Refactor while green**

If `session_index.snapshot()`'s `Arc<Vec<IndexedSession>>` forced an awkward `&sessions` borrow in `recent_opencode_cwds`, keep the slice parameter (already slice-typed). Confirm the wiring block reads cleanly; no further refactor expected.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: this task touches the server composition root, the directory response, and a client comment. Server: the new `opencode_limits` module tests + the session_directory suites (narrowed, delegated — the whole-crate run happens in the run's final coordinated full-suite gate, never as a raw broad cargo invocation mid-task). Client: the comment-only change touches `FreshAgentView` (its unit tests + the strip tests + the sessionsSlice tests that consume tokenUsage); the e2e fresh-agent specs exercise the meter render path end-to-end and are provider-agnostic (they seed the indexer directly, past the seam this change modified — the session_directory wire tests plus the `refresh_once` production-chain test added above are the e2e-of-record pair for the new data path; run the e2e fresh-agent spec once through the repo-owned lane to prove no regression on the cloud backend).

Run: `cargo test -p freshell-server --locked -- opencode_limits session_directory:: existence auto_title_sweep`
Expected: PASS.

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentStatusStrip.test.tsx test/unit/client/store/sessionsSlice.test.ts`
Expected: PASS.

Run: `npm run test:e2e -- test/e2e-browser/specs/fresh-agent.spec.ts`
Expected: PASS (coordinated cloud lane — this is the one broad-adjacent run of the task; it goes through the coordinator automatically via the repo-owned script).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-server/src/opencode_limits.rs crates/freshell-server/src/main.rs crates/freshell-server/src/session_directory.rs src/components/fresh-agent/FreshAgentView.tsx docs/plans/2026-08-24-fresh-agent-status-strip.md
git commit -m "feat(server): wire opencode model limits into the session-directory context meter"
```

---

## Post-execution stages (orchestrator-owned, required by the User Request)

Task 4's commit is NOT the end of the run. After execution completes, the orchestrator runs the remaining the-usual sequence:

1. **Coordinated full-suite gate on the final HEAD** — through the repo's shared test coordinator (the AGENTS.md lanes, never raw broad cargo invocations), with `FRESHELL_TEST_SUMMARY` set; environmental failures are ledger-recorded with receipts per the baseline discipline.
2. **Independent Fresh Eyes delta review** — the complete committed delta `base_ref...HEAD`, up to five rounds plus focused repair episodes per the-usual; every finding dispositioned under the scope rule.
3. **Recap** — stage-by-stage report, delivered result vs. the User Request, safe next-step options for the worktree and branch (no PR creation without explicit user approval; no production-server restart without explicit "APPROVED").

## Coverage summary (why no new Playwright spec)

The client needs zero functional changes: the wire chain (`DirItem.tokenUsage` → `contextUsageExtras` → `sessionsSlice.contextUsageByKey` → `guardContextUsageTokenSummary` → `FreshAgentStatusStrip`) is provider-agnostic and already covered by `test/unit/client/components/fresh-agent/FreshAgentStatusStrip.test.tsx`, `FreshAgentView.test.tsx`, and `test/e2e-browser/specs/fresh-agent.spec.ts` (which seeds the session indexer's tokenUsage directly — past the server seam this change modifies). The new behavior is the server data path, whose end-to-end proof is a pair added in Task 4: the `session_directory` integration tests (real fixture DB → real parser → real index → real axum router → exact wire JSON) and the `refresh_once` production-chain test (real registry with a scripted probe → real snapshot → the production resolver closure → dirty-mark → re-list → meter lit — so breaking the refresh task or the wiring CANNOT stay green), plus the Task 2/3 parser and indexer tests over real-schema fixture DBs. `docs/index.html` shows the meter provider-agnostically and needs no change.

Out-of-scope pre-existing finding (recorded, not addressed — scope rule): `parse/codex.rs:189`/`:234` can emit a non-positive `model_context_window` verbatim (`to_finite_number` filters only non-finiteness, not sign), which would violate the same zod `.positive()` rule today; sampled real rollouts carry 258400 (clean). Suggested follow-up: a one-line sign gate in the codex parser. This plan adds no new violating arm — the opencode arm gates per Task 3.

## Plan-code status

Code blocks above are pre-implementation drafts anchored to verified line numbers and signatures (see `reports/plan-opencode-indexer-seam.md`, `reports/plan-model-limit-chain.md`, `reports/plan-client-meter-contract.md`, `reports/load-bearing-opencode-overflow-formula.md`, and `reports/workspace-baseline.md` under the run's logs dir). Execution may adjust them to the live tree; the plan's prose — User Request block, Goal, Architecture, Global Constraints, and task intent — stays authoritative.
