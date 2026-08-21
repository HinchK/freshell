//! # model_capabilities — `GET`/`POST /api/fresh-agent/model-capabilities/*`
//!
//! Port of the Node pair
//! * `server/fresh-agent/model-capabilities-router.ts` (route shape, 400/200/503
//!   statuses, cwd context resolution) and
//! * `server/fresh-agent/model-capability-registry.ts` (per-cwd TTL cache with
//!   in-flight single-flight coalescing, refresh bypass, static catalogs,
//!   typed-error envelopes),
//!
//! sitting on the [`freshell_opencode::catalog`] probe for the `freshopencode`
//! runtime. The response bodies conform to
//! `shared/fresh-agent-model-capabilities.ts` (`ok:true` success at 200,
//! `ok:false` `unavailable` + typed error at 503).
//!
//! ## Deviation (tracked)
//!
//! `freshclaude`/`kilroy`: Node probes the Claude Agent SDK's `supportedModels()`
//! (`registry.probeCatalog`). There is no Claude SDK in the Rust workspace, so this
//! module serves the shared static table for the claude providers as well (the
//! same list `createStaticSuccess` would build for `freshcodex` with claude
//! entries substituted). The endpoint stays uniformly functional; live claude
//! probing lands with the two-column model-selector slice.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::future::{FutureExt, Shared};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use freshell_opencode::catalog::{
    probe_enabled_model_catalog, CatalogConfig, CatalogDeps, ModelCapability,
};
use freshell_opencode::serve::BoxFuture;
use freshell_opencode::transport::{LoopbackPortAllocator, ReqwestServeHttp, TokioProcessSpawner};

use crate::{authorized, fail_json, FreshAgentState};

/// `FRESH_AGENT_MODEL_CAPABILITY_CACHE_TTL_MS`
/// (`shared/fresh-agent-model-capabilities.ts:3`).
pub const MODEL_CAPABILITY_CACHE_TTL: Duration = Duration::from_millis(5 * 60 * 1000);

// ── session types (FreshAgentModelCapabilitiesSessionTypeSchema) ───────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionType {
    FreshClaude,
    FreshCodex,
    Kilroy,
    FreshOpencode,
}

impl SessionType {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "freshclaude" => Some(Self::FreshClaude),
            "freshcodex" => Some(Self::FreshCodex),
            "kilroy" => Some(Self::Kilroy),
            "freshopencode" => Some(Self::FreshOpencode),
            _ => None,
        }
    }

    fn wire(self) -> &'static str {
        match self {
            Self::FreshClaude => "freshclaude",
            Self::FreshCodex => "freshcodex",
            Self::Kilroy => "kilroy",
            Self::FreshOpencode => "freshopencode",
        }
    }

    /// `FreshAgentModelCapabilitiesRuntimeProviderSchema` (the descriptor's
    /// `runtimeProvider`).
    fn runtime_provider(self) -> &'static str {
        match self {
            Self::FreshCodex => "codex",
            Self::FreshOpencode => "opencode",
            Self::FreshClaude | Self::Kilroy => "claude",
        }
    }
}

// ── errors (FreshAgentModelCapabilityErrorSchema) ───────────────────────────────

/// The typed catalog error carried in the `ok:false` envelope
/// (`code`/`message`/`retryable`).
#[derive(Clone, Debug, PartialEq)]
pub struct CapabilityError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

// ── the probe seam (registry's opencodeCatalogProvider) ────────────────────────

pub type CatalogOut = Result<Vec<ModelCapability>, CapabilityError>;

/// Injected probe — the port seam for the reference's `opencodeCatalogProvider`
/// dependency (`RegistryOptions.opencodeCatalogProvider`). Real impl spawns the
/// transient catalog serve; tests record cwd and script responses.
pub trait ModelCatalogProbe: Send + Sync {
    fn probe<'a>(&'a self, cwd: Option<&'a str>) -> BoxFuture<'a, CatalogOut>;
}

/// Production probe over the real transport: transient `opencode serve --pure`.
pub struct OpencodeCatalogProbe {
    deps: CatalogDeps,
    config: CatalogConfig,
}

impl OpencodeCatalogProbe {
    pub fn new(deps: CatalogDeps, config: CatalogConfig) -> Self {
        Self { deps, config }
    }
}

impl Default for OpencodeCatalogProbe {
    fn default() -> Self {
        Self::new(
            CatalogDeps {
                spawner: Arc::new(TokioProcessSpawner),
                http: Arc::new(ReqwestServeHttp::new()),
                ports: Arc::new(LoopbackPortAllocator),
            },
            CatalogConfig::default(),
        )
    }
}

impl ModelCatalogProbe for OpencodeCatalogProbe {
    fn probe<'a>(&'a self, cwd: Option<&'a str>) -> BoxFuture<'a, CatalogOut> {
        Box::pin(async move {
            probe_enabled_model_catalog(&self.deps, &self.config, cwd)
                .await
                .map_err(|e| CapabilityError {
                    // `probeOpencodeCatalog` wraps every untyped probe failure
                    // (model-capability-registry.ts:320-340).
                    code: "CAPABILITY_PROBE_FAILED".to_string(),
                    message: e.to_string(),
                    retryable: true,
                })
        })
    }
}

// ── registry (FreshAgentModelCapabilityRegistry) ───────────────────────────────

#[derive(Clone)]
struct CachedCatalog {
    fetched_at_ms: u64,
    models: Vec<ModelCapability>,
}

type SharedCatalogFuture = Shared<BoxFuture<'static, Result<CachedCatalog, CapabilityError>>>;

#[derive(Default)]
struct RegistryState {
    cache: HashMap<String, CachedCatalog>,
    inflight: HashMap<String, SharedCatalogFuture>,
}

/// cwd-keyed TTL cache + in-flight coalescing — `opencodeCacheByKey` /
/// `opencodeInFlightByKey` (`model-capability-registry.ts:193-194`).
pub struct ModelCapabilityRegistry {
    probe: Arc<dyn ModelCatalogProbe>,
    ttl: Duration,
    now: Arc<dyn Fn() -> u64 + Send + Sync>,
    state: Arc<Mutex<RegistryState>>,
}

fn system_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl ModelCapabilityRegistry {
    pub fn new(probe: Arc<dyn ModelCatalogProbe>) -> Self {
        Self {
            probe,
            ttl: MODEL_CAPABILITY_CACHE_TTL,
            now: Arc::new(system_now_ms),
            state: Arc::new(Mutex::new(RegistryState::default())),
        }
    }

    /// Test seam (`RegistryOptions{now, ttlMs}`): injected clock and TTL so cache
    /// aging is deterministic.
    pub fn with_clock(
        probe: Arc<dyn ModelCatalogProbe>,
        now: Arc<dyn Fn() -> u64 + Send + Sync>,
        ttl: Duration,
    ) -> Self {
        Self {
            probe,
            ttl,
            now,
            state: Arc::new(Mutex::new(RegistryState::default())),
        }
    }

    /// `getCapabilities` (`model-capability-registry.ts:211-234`): cache hit within
    /// TTL → `cached`; otherwise single-flight refresh → `fresh`; probe failure →
    /// the `unavailable` envelope at 503 (cache untouched). Non-opencode runtimes
    /// serve the static catalog (`createStaticSuccess`, `:354-378`) — for claude
    /// providers that is the documented deviation above.
    pub async fn get(&self, session_type: SessionType, cwd: Option<String>) -> (StatusCode, Value) {
        if session_type != SessionType::FreshOpencode {
            return (
                StatusCode::OK,
                success_body(
                    session_type,
                    "fresh",
                    (self.now)(),
                    static_models(session_type),
                ),
            );
        }
        let key = cache_key(cwd.as_deref());
        {
            let state = self.state.lock().await;
            if let Some(cached) = state.cache.get(&key) {
                // `:270-271`: `now - fetchedAt <= ttlMs`.
                let age_ms = (self.now)().saturating_sub(cached.fetched_at_ms);
                if age_ms <= self.ttl.as_millis() as u64 {
                    return (
                        StatusCode::OK,
                        success_body(
                            session_type,
                            "cached",
                            cached.fetched_at_ms,
                            cached.models.clone(),
                        ),
                    );
                }
            }
        }
        self.finish_opencode(session_type, key, cwd).await
    }

    /// `refreshCapabilities` (`:236-254`): skips the TTL check but shares any
    /// in-flight probe; a failed refresh leaves the last successful cache entry
    /// in place (`:223-266`, "keeps the last successful catalog").
    pub async fn refresh(
        &self,
        session_type: SessionType,
        cwd: Option<String>,
    ) -> (StatusCode, Value) {
        if session_type != SessionType::FreshOpencode {
            return (
                StatusCode::OK,
                success_body(
                    session_type,
                    "fresh",
                    (self.now)(),
                    static_models(session_type),
                ),
            );
        }
        self.finish_opencode(session_type, cache_key(cwd.as_deref()), cwd)
            .await
    }

    async fn finish_opencode(
        &self,
        session_type: SessionType,
        key: String,
        cwd: Option<String>,
    ) -> (StatusCode, Value) {
        match self.refreshed_catalog(key, cwd).await {
            Ok(catalog) => (
                StatusCode::OK,
                success_body(session_type, "fresh", catalog.fetched_at_ms, catalog.models),
            ),
            Err(err) => (
                StatusCode::SERVICE_UNAVAILABLE,
                failure_body(session_type, &err),
            ),
        }
    }

    /// `refreshOpencodeCatalog` (`:295-318`): the single-flight. The shared
    /// future removes itself from `inflight` and writes the cache on success —
    /// the reference's `.then(cache.set).finally(inflight.delete)`.
    async fn refreshed_catalog(
        &self,
        key: String,
        cwd: Option<String>,
    ) -> Result<CachedCatalog, CapabilityError> {
        let shared = {
            let mut state = self.state.lock().await;
            match state.inflight.get(&key) {
                Some(existing) => existing.clone(),
                None => {
                    let probe = self.probe.clone();
                    let now = self.now.clone();
                    let state_arc = self.state.clone();
                    let key_for_cleanup = key.clone();
                    // `:302-306`: only a non-blank cwd reaches the probe context.
                    let cwd = cwd.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
                    let key_for_cache = key.clone();
                    let future = async move {
                        let out = probe
                            .probe(cwd.as_deref())
                            .await
                            .map(|models| CachedCatalog {
                                fetched_at_ms: now(),
                                models,
                            });
                        let mut state = state_arc.lock().await;
                        state.inflight.remove(&key_for_cleanup);
                        if let Ok(catalog) = &out {
                            state.cache.insert(key_for_cache, catalog.clone());
                        }
                        out
                    };
                    let shared: SharedCatalogFuture = future.boxed().shared();
                    state.inflight.insert(key, shared.clone());
                    shared
                }
            }
        };
        shared.await
    }
}

/// `opencodeCacheKey` (`:256-261`).
fn cache_key(cwd: Option<&str>) -> String {
    let cwd = cwd.map(str::trim).filter(|s| !s.is_empty());
    format!("opencode:{}", cwd.unwrap_or("<default>"))
}

/// `createStaticSuccess` (`:354-378`): the shared
/// `FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE` tables
/// (`shared/fresh-agent-models.ts:21-84`) as capability rows.
fn static_models(session_type: SessionType) -> Vec<ModelCapability> {
    type Row = (&'static str, &'static str, &'static [&'static str]);
    let rows: &[Row] = match session_type {
        SessionType::FreshCodex => &[
            (
                "gpt-5.5",
                "GPT-5.5",
                &["none", "minimal", "low", "medium", "high", "max"],
            ),
            (
                "gpt-5.4-flash",
                "GPT-5.4 Flash",
                &["none", "minimal", "low", "medium", "high"],
            ),
            (
                "gpt-5.3-codex-spark",
                "GPT-5.3 Codex Spark",
                &["none", "minimal", "low", "medium", "high", "max"],
            ),
        ],
        // DEVIATION (module doc): Node probes the Claude SDK `supportedModels()`
        // for the claude providers; the Rust port serves the shared static table.
        SessionType::FreshClaude | SessionType::Kilroy => &[(
            "opus[1m]",
            "Claude Opus 5 (1M context)",
            &["low", "medium", "high", "xhigh", "max"],
        )],
        SessionType::FreshOpencode => &[],
    };
    rows.iter()
        .map(|(id, display_name, levels)| ModelCapability {
            id: id.to_string(),
            display_name: display_name.to_string(),
            provider: session_type.runtime_provider(),
            source: None,
            // `:359-366`: effort support derives from the levels list, not the flag.
            supports_effort: !levels.is_empty(),
            supported_effort_levels: levels.iter().map(|s| s.to_string()).collect(),
            supports_adaptive_thinking: !levels.is_empty(),
        })
        .collect()
}

/// `FreshAgentModelCapabilitiesSchema.extend({ok:true})` — the six keys, exactly.
fn success_body(
    session_type: SessionType,
    status: &'static str,
    fetched_at_ms: u64,
    models: Vec<ModelCapability>,
) -> Value {
    json!({
        "ok": true,
        "sessionType": session_type.wire(),
        "runtimeProvider": session_type.runtime_provider(),
        "status": status,
        "fetchedAt": fetched_at_ms,
        "models": models,
    })
}

/// `createFailure` (`model-capability-registry.ts:469-489`): no `fetchedAt` key
/// (the zod schema leaves it optional and the reference omits it).
fn failure_body(session_type: SessionType, err: &CapabilityError) -> Value {
    json!({
        "ok": false,
        "sessionType": session_type.wire(),
        "runtimeProvider": session_type.runtime_provider(),
        "status": "unavailable",
        "models": [],
        "error": {
            "code": err.code,
            "message": err.message,
            "retryable": err.retryable,
        },
    })
}

// ── HTTP surface (createFreshAgentModelCapabilitiesRouter) ─────────────────────

/// The two routes. Merged into [`crate::router`] so `freshell-server`'s `main.rs`
/// mounts this crate exactly once, unchanged.
pub fn router(state: FreshAgentState) -> Router {
    Router::new()
        .route(
            "/api/fresh-agent/model-capabilities/{session_type}",
            get(get_capabilities),
        )
        .route(
            "/api/fresh-agent/model-capabilities/{session_type}/refresh",
            post(refresh_capabilities),
        )
        .with_state(state)
}

/// `GET /:sessionType` (`model-capabilities-router.ts:33-47`).
async fn get_capabilities(
    State(state): State<FreshAgentState>,
    headers: HeaderMap,
    Path(session_type): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }
    let Some(st) = SessionType::parse(&session_type) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Invalid sessionType" })),
        )
            .into_response();
    };
    let (status, body) = state
        .model_capabilities
        .get(st, resolve_context(st, &query))
        .await;
    (status, Json(body)).into_response()
}

/// `POST /:sessionType/refresh` (`model-capabilities-router.ts:49-63`).
async fn refresh_capabilities(
    State(state): State<FreshAgentState>,
    headers: HeaderMap,
    Path(session_type): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }
    let Some(st) = SessionType::parse(&session_type) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Invalid sessionType" })),
        )
            .into_response();
    };
    let (status, body) = state
        .model_capabilities
        .refresh(st, resolve_context(st, &query))
        .await;
    (status, Json(body)).into_response()
}

/// `resolveContext` (`model-capabilities-router.ts:19-26`): only freshopencode
/// takes a `cwd` query param into the probe context.
fn resolve_context(session_type: SessionType, query: &HashMap<String, String>) -> Option<String> {
    if session_type != SessionType::FreshOpencode {
        return None;
    }
    query.get("cwd").cloned()
}

#[cfg(test)]
#[path = "model_capabilities_tests.rs"]
mod tests;
