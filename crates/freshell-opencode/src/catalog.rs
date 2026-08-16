//! # catalog — the **transient** `opencode serve --pure` model-catalog probe
//!
//! Port of `server/fresh-agent/adapters/opencode/model-catalog.ts`
//! (`createOpencodeModelCatalogProvider` + `normalizeOpencodeEnabledModelCatalog`),
//! which backs `GET /api/fresh-agent/model-capabilities/freshopencode`.
//!
//! Unlike the long-lived session sidecar ([`crate::serve::OpencodeServeManager`]), the
//! catalog probe spawns an **isolated, short-lived** serve per request — cwd-scoped so
//! project-level `opencode.json` provider config is honored — fetches
//! `/config/providers`, normalizes the enabled provider→model list into the shared
//! `FreshAgentModelCapability` wire shape
//! (`shared/fresh-agent-model-capabilities.ts`), and kills the child on every exit
//! path (`ChildGuard`, the `finally { killChildGroup(child) }` analog).

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::time::Instant;

use crate::serve::{
    is_healthy_response, PortAllocator, ProcessSpawner, ServeError, ServeHttp, ServeHttpRequest,
    ServeProcess, SpawnRequest, OPENCODE_SIDECAR_OWNERSHIP_ENV,
};

/// `DEFAULT_HEALTH_TIMEOUT_MS` (`model-catalog.ts:8`).
pub const CATALOG_HEALTH_TIMEOUT_MS: u64 = 20_000;
/// The per-probe bound applied to each `/global/health` poll — the SAME DEV-0001
/// discipline as the sidecar manager (the reference's catalog probe shares the
/// un-bounded-health bug; we do NOT port it).
pub const CATALOG_HEALTH_PROBE_TIMEOUT_MS: u64 = 2_000;
/// `DEFAULT_HEALTH_POLL_INTERVAL_MS` (`model-catalog.ts:10`).
pub const CATALOG_HEALTH_RETRY_INTERVAL_MS: u64 = 150;
/// `DEFAULT_REQUEST_TIMEOUT_MS` (`model-catalog.ts:9`) — 5 s, distinct from the
/// sidecar manager's 30 s request timeout.
pub const CATALOG_REQUEST_TIMEOUT_MS: u64 = 5_000;
/// `MAX_DISPLAY_NAME_LENGTH` (`model-catalog.ts:11`).
const MAX_DISPLAY_NAME_LENGTH: usize = 120;

/// The fixed thinking-level list the shared contract serves for opencode models
/// today (`normalizeOpencodeEnabledModelCatalog`,
/// `model-catalog.ts:334`): `[minimal, low, medium, high, max]`. NOTE: this is the
/// known placeholder — per-model real levels (from the `/config/providers`
/// `variants` map) are a follow-up slice that must land in Node and Rust together.
pub const OPENCODE_PLACEHOLDER_EFFORT_LEVELS: [&str; 5] =
    ["minimal", "low", "medium", "high", "max"];

/// One capability row, serialized camelCase to match
/// `FreshAgentModelCapabilitySchema` (`shared/fresh-agent-model-capabilities.ts`)
/// byte-for-byte-key-for-key. `source` is omitted (not null) when absent, matching
/// the zod `.strict()` schema where the key is optional.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ModelCapability {
    pub id: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub provider: &'static str,
    #[serde(rename = "source", skip_serializing_if = "Option::is_none")]
    pub source: Option<ModelCapabilitySource>,
    #[serde(rename = "supportsEffort")]
    pub supports_effort: bool,
    #[serde(rename = "supportedEffortLevels")]
    pub supported_effort_levels: Vec<String>,
    #[serde(rename = "supportsAdaptiveThinking")]
    pub supports_adaptive_thinking: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ModelCapabilitySource {
    pub id: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
}

/// Injected IO for the probe — the same three seams [`crate::serve::ServeDeps`]
/// uses, minus the SSE event source a catalog probe never opens.
#[derive(Clone)]
pub struct CatalogDeps {
    pub spawner: Arc<dyn ProcessSpawner>,
    pub http: Arc<dyn ServeHttp>,
    pub ports: Arc<dyn PortAllocator>,
}

/// Timing/command knobs, defaulted to the reference values. `command` honors
/// `OPENCODE_CMD` exactly like [`crate::serve::ServeConfig::default`] so the two
/// opencode-spawning paths resolve the same binary.
#[derive(Clone, Debug)]
pub struct CatalogConfig {
    pub command: String,
    pub env: Vec<(String, String)>,
    pub health_timeout: Duration,
    pub health_probe_timeout: Duration,
    pub health_retry_interval: Duration,
    pub request_timeout: Duration,
}

impl Default for CatalogConfig {
    fn default() -> Self {
        Self {
            command: std::env::var("OPENCODE_CMD")
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "opencode".to_string()),
            env: Vec::new(),
            health_timeout: Duration::from_millis(CATALOG_HEALTH_TIMEOUT_MS),
            health_probe_timeout: Duration::from_millis(CATALOG_HEALTH_PROBE_TIMEOUT_MS),
            health_retry_interval: Duration::from_millis(CATALOG_HEALTH_RETRY_INTERVAL_MS),
            request_timeout: Duration::from_millis(CATALOG_REQUEST_TIMEOUT_MS),
        }
    }
}

/// Spawn the transient probe serve, wait (bounded) for health, fetch
/// `/config/providers`, normalize the enabled model list, and kill the child —
/// `getCatalog` (`model-catalog.ts:165-202`) + normalize.
///
/// `cwd` (trimmed, non-empty) selects project-config resolution
/// (`model-catalog.ts:168-170,178`).
pub async fn probe_enabled_model_catalog(
    deps: &CatalogDeps,
    config: &CatalogConfig,
    cwd: Option<&str>,
) -> Result<Vec<ModelCapability>, ServeError> {
    // `model-catalog.ts:168-170`: blank cwd means the default (process) cwd.
    let cwd = cwd.map(str::trim).filter(|s| !s.is_empty());
    let endpoint = deps.ports.allocate().map_err(ServeError::PortAllocation)?;
    let base_url = format!("http://{}:{}", endpoint.hostname, endpoint.port);
    let ownership_id = uuid::Uuid::new_v4().to_string();

    let mut env = config.env.clone();
    env.push((
        OPENCODE_SIDECAR_OWNERSHIP_ENV.to_string(),
        ownership_id.clone(),
    ));
    let process = deps
        .spawner
        .spawn(SpawnRequest {
            command: config.command.clone(),
            hostname: endpoint.hostname,
            port: endpoint.port,
            ownership_id,
            env,
            pure: true,
            cwd: cwd.map(|s| s.to_string()),
        })
        .map_err(ServeError::Spawn)?;
    // `finally { killChildGroup(child) }` (`model-catalog.ts:199-201`): the guard
    // kills on EVERY exit path below — success, health failure, HTTP error, decode
    // error.
    let guard = ChildGuard(process);

    wait_for_catalog_health(deps, config, &base_url, guard.process()).await?;

    let url = format!("{base_url}/config/providers");
    let req = ServeHttpRequest::get(url.clone()).with_timeout(config.request_timeout);
    let res = match tokio::time::timeout(config.request_timeout, deps.http.request(req)).await {
        Ok(result) => result.map_err(ServeError::Transport)?,
        Err(_) => {
            return Err(ServeError::RequestTimeout {
                method: "GET".to_string(),
                url,
                timeout_ms: config.request_timeout.as_millis() as u64,
            });
        }
    };
    if !res.ok() {
        // `model-catalog.ts:194-196`.
        return Err(ServeError::Http {
            method: "GET".to_string(),
            url,
            status: res.status,
            body: String::from_utf8_lossy(&res.body).into_owned(),
        });
    }
    let raw: Value =
        serde_json::from_slice(&res.body).map_err(|e| ServeError::Decode(e.to_string()))?;
    // `guard` drops here (end of scope), killing the probe child on the success
    // path too — the reference's `finally`.
    Ok(normalize_enabled_model_catalog(&raw))
}

/// `normalizeOpencodeEnabledModelCatalog` (`model-catalog.ts:308-340`): accept the
/// providers payload as a record OR the 1.17.x array form (`readProvidersField`,
/// `:245-260`), skip slash-containing provider ids (`:315`), sanitize display names
/// (`cleanDisplayName`, `:233-240`), and NEVER copy credential-shaped model fields
/// (api-key/options/headers/description) into the output.
pub fn normalize_enabled_model_catalog(raw: &Value) -> Vec<ModelCapability> {
    let mut models = Vec::new();
    for (provider_key, raw_provider) in read_provider_entries(raw) {
        let Some(provider) = raw_provider.as_object() else {
            continue;
        };
        // `model-catalog.ts:314-316`: id → key fallback; slash ids skipped (they
        // would collide with the `provider/model` id join).
        let provider_id = read_non_empty_string(provider.get("id")).unwrap_or(provider_key);
        if provider_id.is_empty() || provider_id.contains('/') {
            continue;
        }
        let provider_display_name = {
            let cleaned = clean_display_name(
                &read_non_empty_string(provider.get("name")).unwrap_or_else(|| provider_id.clone()),
            );
            if cleaned.is_empty() {
                provider_id.clone()
            } else {
                cleaned
            }
        };
        let Some(raw_models) = provider.get("models").and_then(Value::as_object) else {
            continue;
        };
        for (model_key, raw_model) in raw_models {
            let Some(model) = raw_model.as_object() else {
                continue;
            };
            let model_id =
                read_non_empty_string(model.get("id")).unwrap_or_else(|| model_key.clone());
            if model_id.is_empty() {
                continue;
            }
            // `model-catalog.ts:322-327`: name → displayName → display_name → id.
            let display = clean_display_name(
                &read_non_empty_string(model.get("name"))
                    .or_else(|| read_non_empty_string(model.get("displayName")))
                    .or_else(|| read_non_empty_string(model.get("display_name")))
                    .unwrap_or_else(|| model_id.clone()),
            );
            let display_name = if display.is_empty() {
                model_id.clone()
            } else {
                display
            };
            models.push(ModelCapability {
                id: format!("{provider_id}/{model_id}"),
                display_name,
                provider: "opencode",
                source: Some(ModelCapabilitySource {
                    id: provider_id.clone(),
                    display_name: provider_display_name.clone(),
                }),
                supports_effort: true,
                supported_effort_levels: OPENCODE_PLACEHOLDER_EFFORT_LEVELS
                    .iter()
                    .map(|s| s.to_string())
                    .collect(),
                supports_adaptive_thinking: true,
            });
        }
    }
    // `compareBySourceThenNameThenId` (`model-catalog.ts:297-306`): localeCompare
    // with `sensitivity: 'base'` — case-insensitive ordering, ties fall through.
    models.sort_by(|a, b| {
        let a_src = a.source.as_ref().map(|s| s.id.as_str()).unwrap_or("");
        let b_src = b.source.as_ref().map(|s| s.id.as_str()).unwrap_or("");
        ci_cmp(a_src, b_src)
            .then_with(|| ci_cmp(&a.display_name, &b.display_name))
            .then_with(|| ci_cmp(&a.id, &b.id))
    });
    models
}

/// `readNonEmptyString` (`model-catalog.ts:227-231`).
fn read_non_empty_string(value: Option<&Value>) -> Option<String> {
    let trimmed = value?.as_str()?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// `cleanDisplayName` (`model-catalog.ts:233-240`): strip C0 control chars + DEL
/// (`CONTROL_CHAR_PATTERN`), trim, cap at [`MAX_DISPLAY_NAME_LENGTH`].
fn clean_display_name(value: &str) -> String {
    let stripped: String = value
        .chars()
        .filter(|c| !matches!(*c, '\u{0}'..='\u{1F}' | '\u{7F}'))
        .collect();
    let trimmed = stripped.trim();
    if trimmed.chars().count() > MAX_DISPLAY_NAME_LENGTH {
        trimmed.chars().take(MAX_DISPLAY_NAME_LENGTH).collect()
    } else {
        trimmed.to_string()
    }
}

/// Case-insensitive compare standing in for `localeCompare(_, 'base')`.
fn ci_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.to_lowercase().cmp(&b.to_lowercase())
}

/// `readProvidersField`/`readProviderMap` (`model-catalog.ts:245-284`): the
/// providers field arrives as a record (current) OR a 1.17.x array of Info
/// objects; array entries key by their own `id`.
fn read_provider_entries(raw: &Value) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    match raw.get("providers") {
        Some(Value::Object(map)) => {
            for (key, value) in map {
                out.push((key.clone(), value.clone()));
            }
        }
        Some(Value::Array(items)) => {
            for entry in items {
                if entry.is_object() {
                    if let Some(id) = read_non_empty_string(entry.get("id")) {
                        out.push((id, entry.clone()));
                    }
                }
            }
        }
        _ => {}
    }
    out
}

/// Kills the probe child exactly once on drop — the `finally` analog.
struct ChildGuard(Box<dyn ServeProcess>);

impl ChildGuard {
    fn process(&self) -> &dyn ServeProcess {
        self.0.as_ref()
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        self.0.kill();
    }
}

/// Bounded health wait for the probe serve — the same DEV-0001 discipline as
/// [`crate::serve::OpencodeServeManager::wait_for_health`] (each probe bounded by
/// `health_probe_timeout`, `take_fatal_startup_error`/`exited` checked per poll,
/// retry cadence, outer deadline → [`ServeError::NotHealthy`]). The reference's
/// catalog wait (`model-catalog.ts:91-163`) additionally watches an abort signal;
/// nothing upstream threads one in, so the port omits it.
async fn wait_for_catalog_health(
    deps: &CatalogDeps,
    config: &CatalogConfig,
    base_url: &str,
    process: &dyn ServeProcess,
) -> Result<(), ServeError> {
    let deadline = Instant::now() + config.health_timeout;
    loop {
        if let Some(stderr) = process.take_fatal_startup_error() {
            return Err(ServeError::StartupFailed(stderr));
        }
        if let Some(code) = process.exited() {
            return Err(ServeError::ProcessExited { code });
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }

        let probe_budget = config.health_probe_timeout.min(remaining);
        let req =
            ServeHttpRequest::get(format!("{base_url}/global/health")).with_timeout(probe_budget);
        match tokio::time::timeout(probe_budget, deps.http.request(req)).await {
            Ok(Ok(resp)) if resp.ok() && is_healthy_response(&resp.body) => return Ok(()),
            _ => {}
        }

        let sleep_for = config
            .health_retry_interval
            .min(deadline.saturating_duration_since(Instant::now()));
        if sleep_for.is_zero() {
            break;
        }
        tokio::time::sleep(sleep_for).await;
    }
    Err(ServeError::NotHealthy {
        timeout_ms: config.health_timeout.as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::serve::{Endpoint, ServeHttpResponse};
    use serde_json::json;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    // ── fakes (the serve.rs trait seams) ────────────────────────────────────────

    #[derive(Default)]
    struct FakeProcessState {
        exited: Option<i32>,
        fatal_stderr: Option<String>,
        kill_calls: usize,
    }

    struct FakeProcess {
        state: Arc<Mutex<FakeProcessState>>,
    }

    impl ServeProcess for FakeProcess {
        fn exited(&self) -> Option<i32> {
            self.state.lock().unwrap().exited
        }
        fn take_fatal_startup_error(&self) -> Option<String> {
            self.state.lock().unwrap().fatal_stderr.take()
        }
        fn kill(&self) {
            self.state.lock().unwrap().kill_calls += 1;
        }
    }

    #[derive(Default)]
    struct FakeSpawner {
        requests: Mutex<Vec<SpawnRequest>>,
        process_state: Arc<Mutex<FakeProcessState>>,
    }

    impl FakeSpawner {
        fn kill_calls(&self) -> usize {
            self.process_state.lock().unwrap().kill_calls
        }
    }

    impl ProcessSpawner for FakeSpawner {
        fn spawn(&self, req: SpawnRequest) -> Result<Box<dyn ServeProcess>, String> {
            self.requests.lock().unwrap().push(req);
            Ok(Box::new(FakeProcess {
                state: self.process_state.clone(),
            }))
        }
    }

    #[derive(Default)]
    struct ScriptedHttpState {
        health: VecDeque<Result<ServeHttpResponse, String>>,
        providers: VecDeque<Result<ServeHttpResponse, String>>,
        requests: Vec<String>,
    }

    #[derive(Default)]
    struct ScriptedHttp {
        state: Mutex<ScriptedHttpState>,
    }

    impl ScriptedHttp {
        fn push_health(&self, r: Result<ServeHttpResponse, String>) {
            self.state.lock().unwrap().health.push_back(r);
        }
        fn push_providers(&self, r: Result<ServeHttpResponse, String>) {
            self.state.lock().unwrap().providers.push_back(r);
        }
        fn requests(&self) -> Vec<String> {
            self.state.lock().unwrap().requests.clone()
        }
    }

    impl ServeHttp for ScriptedHttp {
        fn request<'a>(
            &'a self,
            req: ServeHttpRequest,
        ) -> crate::serve::BoxFuture<'a, Result<ServeHttpResponse, String>> {
            let url = req.url.clone();
            let next = {
                let mut state = self.state.lock().unwrap();
                state.requests.push(url.clone());
                if url.ends_with("/global/health") {
                    state.health.pop_front()
                } else if url.ends_with("/config/providers") {
                    state.providers.pop_front()
                } else {
                    None
                }
            };
            Box::pin(async move {
                next.unwrap_or_else(|| Err(format!("no scripted response for {url}")))
            })
        }
    }

    struct FixedPorts;

    impl PortAllocator for FixedPorts {
        fn allocate(&self) -> Result<Endpoint, String> {
            Ok(Endpoint {
                hostname: "127.0.0.1".to_string(),
                port: 48123,
            })
        }
    }

    fn js_status_ok(body: Value) -> Result<ServeHttpResponse, String> {
        Ok(ServeHttpResponse::new(
            200,
            serde_json::to_vec(&body).unwrap(),
        ))
    }

    fn test_deps(spawner: Arc<FakeSpawner>, http: Arc<ScriptedHttp>) -> CatalogDeps {
        CatalogDeps {
            spawner,
            http,
            ports: Arc::new(FixedPorts),
        }
    }

    fn fast_config() -> CatalogConfig {
        CatalogConfig {
            command: "opencode".to_string(),
            env: Vec::new(),
            health_timeout: Duration::from_millis(5_000),
            health_probe_timeout: Duration::from_millis(2_000),
            health_retry_interval: Duration::from_millis(150),
            request_timeout: Duration::from_millis(500),
        }
    }

    // ── probe behavior (the spawn→health→fetch→kill lifecycle) ──────────────────

    /// Port of `opencode-model-catalog.test.ts` "starts an isolated short-lived
    /// serve process, fetches cwd-scoped /config/providers, and stops only that
    /// child" (`:29-68`).
    #[tokio::test(start_paused = true)]
    async fn probe_spawns_pure_cwd_scoped_serve_fetches_config_providers_and_kills_child() {
        let spawner = Arc::new(FakeSpawner::default());
        let http = Arc::new(ScriptedHttp::default());
        http.push_health(js_status_ok(json!({ "healthy": true })));
        http.push_providers(js_status_ok(json!({
            "providers": {
                "opencode-go": {
                    "id": "opencode-go",
                    "name": "opencode-go",
                    "models": { "glm-5.2": { "id": "glm-5.2", "name": "GLM 5.2" } },
                },
            },
            "default": { "opencode-go": "glm-5.2" },
        })));

        let result = probe_enabled_model_catalog(
            &test_deps(spawner.clone(), http.clone()),
            &fast_config(),
            Some("/repo/project-a"),
        )
        .await
        .expect("happy-path probe succeeds");

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "opencode-go/glm-5.2");
        assert_eq!(result[0].display_name, "GLM 5.2");

        let spawned = spawner.requests.lock().unwrap();
        assert_eq!(spawned.len(), 1, "exactly one probe child spawned");
        let req = &spawned[0];
        assert_eq!(req.command, "opencode");
        assert_eq!(req.hostname, "127.0.0.1");
        assert_eq!(req.port, 48123);
        assert!(req.pure, "the catalog probe must spawn with --pure");
        assert_eq!(req.cwd.as_deref(), Some("/repo/project-a"));
        assert!(
            req.env
                .iter()
                .any(|(k, v)| k == OPENCODE_SIDECAR_OWNERSHIP_ENV && !v.is_empty()),
            "the probe child carries the ownership tag so kill() can reap the group"
        );
        drop(spawned);

        assert_eq!(
            http.requests(),
            vec![
                "http://127.0.0.1:48123/global/health".to_string(),
                "http://127.0.0.1:48123/config/providers".to_string(),
            ]
        );
        assert_eq!(
            spawner.kill_calls(),
            1,
            "the probe child is killed exactly once"
        );
    }

    /// Port of "fast-fails when the serve child exits before becoming healthy"
    /// (`:108-128`): an exit during startup short-circuits the health wait.
    #[tokio::test(start_paused = true)]
    async fn probe_fails_fast_when_child_exits_before_healthy() {
        let spawner = Arc::new(FakeSpawner::default());
        {
            spawner.process_state.lock().unwrap().exited = Some(1);
        }
        let http = Arc::new(ScriptedHttp::default());
        http.push_health(Ok(ServeHttpResponse::new(503, b"{}".to_vec())));

        let err =
            probe_enabled_model_catalog(&test_deps(spawner.clone(), http), &fast_config(), None)
                .await
                .expect_err("early exit fails the probe");
        assert_eq!(err, ServeError::ProcessExited { code: 1 });
        assert_eq!(spawner.kill_calls(), 1);
    }

    /// Port of "fast-fails when the serve child emits an error (e.g. ENOENT) before
    /// becoming healthy" (`:130-150`): the fatal-stderr path (the reference greps
    /// stderr; the port reads `take_fatal_startup_error`, same seam the sidecar uses).
    #[tokio::test(start_paused = true)]
    async fn probe_fails_fast_when_stderr_reports_serve_error() {
        let spawner = Arc::new(FakeSpawner::default());
        {
            spawner.process_state.lock().unwrap().fatal_stderr =
                Some("ServeError: EADDRINUSE port 48123".to_string());
        }
        let http = Arc::new(ScriptedHttp::default());
        http.push_health(Ok(ServeHttpResponse::new(503, b"{}".to_vec())));

        let err =
            probe_enabled_model_catalog(&test_deps(spawner.clone(), http), &fast_config(), None)
                .await
                .expect_err("fatal stderr fails the probe");
        assert!(
            matches!(&err, ServeError::StartupFailed(msg) if msg.contains("EADDRINUSE")),
            "fatal stderr surfaced via StartupFailed, got {err:?}"
        );
        assert_eq!(spawner.kill_calls(), 1);
    }

    /// A serve that never becomes healthy within the outer deadline fails as
    /// `NotHealthy` — the DEV-0001 bounded-probe discipline, kept in the catalog
    /// probe even though the Node reference's catalog wait shares the un-bounded bug.
    #[tokio::test(start_paused = true)]
    async fn probe_fails_not_healthy_at_the_outer_deadline() {
        let spawner = Arc::new(FakeSpawner::default());
        let http = Arc::new(ScriptedHttp::default());
        // Health polls that always fail (transport-side, e.g. connection refused);
        // under paused time the loop burns through the deadline instantly.
        for _ in 0..256 {
            http.push_health(Err("connection refused".to_string()));
        }

        let err =
            probe_enabled_model_catalog(&test_deps(spawner.clone(), http), &fast_config(), None)
                .await
                .expect_err("wedged serve fails as NotHealthy");
        assert_eq!(err, ServeError::NotHealthy { timeout_ms: 5_000 });
        assert_eq!(spawner.kill_calls(), 1);
    }

    /// `model-catalog.ts:194-196`: a non-2xx `/config/providers` is a hard error.
    #[tokio::test(start_paused = true)]
    async fn probe_fails_when_config_providers_is_not_ok() {
        let spawner = Arc::new(FakeSpawner::default());
        let http = Arc::new(ScriptedHttp::default());
        http.push_health(js_status_ok(json!({ "healthy": true })));
        http.push_providers(Ok(ServeHttpResponse::new(500, b"boom".to_vec())));

        let err =
            probe_enabled_model_catalog(&test_deps(spawner.clone(), http), &fast_config(), None)
                .await
                .expect_err("non-2xx providers response fails the probe");
        assert!(
            matches!(&err, ServeError::Http { status: 500, .. }),
            "providers 500 surfaces as Http{{status:500}}, got {err:?}"
        );
        assert_eq!(spawner.kill_calls(), 1);
    }

    /// Health polls retry at the configured cadence until a healthy response lands.
    #[tokio::test(start_paused = true)]
    async fn probe_retries_health_until_healthy() {
        let spawner = Arc::new(FakeSpawner::default());
        let http = Arc::new(ScriptedHttp::default());
        http.push_health(Err("connection refused".to_string()));
        http.push_health(Ok(ServeHttpResponse::new(503, b"{}".to_vec())));
        http.push_health(js_status_ok(json!({ "healthy": true })));
        http.push_providers(js_status_ok(json!({ "providers": {}, "default": {} })));

        let result = probe_enabled_model_catalog(
            &test_deps(spawner.clone(), http.clone()),
            &fast_config(),
            None,
        )
        .await
        .expect("recovers once the serve comes up");
        assert!(result.is_empty(), "empty providers → empty model list");
        assert_eq!(
            http.requests().len(),
            4,
            "three health polls then the providers fetch"
        );
    }

    // ── normalization (pure function) ───────────────────────────────────────────

    /// Port of "sanitizes enabled provider models and does not copy
    /// credential-shaped fields or descriptions" (`:70-106`).
    #[test]
    fn normalize_sanitizes_models_and_never_leaks_credentials() {
        let models = normalize_enabled_model_catalog(&json!({
            "providers": {
                "deepseek": {
                    "id": "deepseek",
                    "name": "deepseek",
                    "apiKey": "must-not-leak",
                    "models": {
                        "deepseek-v4-pro": {
                            "id": "deepseek-v4-pro",
                            "name": "DeepSeek V4 Pro",
                            "description": "must-not-leak-description",
                            "options": { "apiKey": "must-not-leak" },
                            "headers": { "authorization": "must-not-leak" },
                        },
                    },
                },
                "bad/source": {
                    "id": "bad/source",
                    "models": { "one": { "id": "one" } },
                },
            },
        }));

        assert_eq!(
            models,
            vec![ModelCapability {
                id: "deepseek/deepseek-v4-pro".to_string(),
                display_name: "DeepSeek V4 Pro".to_string(),
                provider: "opencode",
                source: Some(ModelCapabilitySource {
                    id: "deepseek".to_string(),
                    display_name: "deepseek".to_string(),
                }),
                supports_effort: true,
                supported_effort_levels: OPENCODE_PLACEHOLDER_EFFORT_LEVELS
                    .iter()
                    .map(|s| s.to_string())
                    .collect(),
                supports_adaptive_thinking: true,
            }]
        );
        let rendered = serde_json::to_string(&models).unwrap();
        assert!(
            !rendered.contains("must-not-leak")
                && !rendered.contains("authorization")
                && !rendered.contains("apiKey")
                && !rendered.contains("description"),
            "credential-shaped fields never reach the serialized output: {rendered}"
        );
    }

    /// Port of "normalizes array-format providers from opencode 1.17.x
    /// /config/providers" (`:152-203`), incl. the source→displayName→id sort.
    #[test]
    fn normalize_accepts_the_1_17_array_provider_format_and_sorts() {
        let models = normalize_enabled_model_catalog(&json!({
            "providers": [
                {
                    "id": "deepseek",
                    "name": "deepseek",
                    "models": {
                        "deepseek-v4-pro": { "id": "deepseek-v4-pro", "name": "DeepSeek V4 Pro" },
                        "deepseek-v4-flash": { "id": "deepseek-v4-flash", "name": "DeepSeek V4 Flash" },
                    },
                },
                {
                    "id": "opencode-go",
                    "name": "opencode-go",
                    "models": { "glm-5.2": { "id": "glm-5.2", "name": "GLM 5.2" } },
                },
            ],
            "default": { "opencode-go": "glm-5.2" },
        }));

        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "deepseek/deepseek-v4-flash",
                "deepseek/deepseek-v4-pro",
                "opencode-go/glm-5.2"
            ]
        );
        assert!(models.iter().all(|m| m.supports_effort
            && m.supported_effort_levels
                == OPENCODE_PLACEHOLDER_EFFORT_LEVELS
                    .iter()
                    .map(|s| s.to_string())
                    .collect::<Vec<_>>()
            && m.supports_adaptive_thinking));
    }

    /// `model-catalog.ts:314,320`: empty/missing ids fall back to the MAP KEY; a
    /// provider with a slash (or empty id AND key) is skipped; model entries that
    /// are not objects are skipped.
    #[test]
    fn normalize_falls_back_to_map_keys_and_skips_malformed_entries() {
        let models = normalize_enabled_model_catalog(&json!({
            "providers": {
                "keyprovider": {
                    "models": {
                        "keymodel": { "name": "Keyed Name" },
                        "garbage": 42,
                    },
                },
                "nested/slash": {
                    "id": "nested/slash",
                    "models": { "x": {} },
                },
            },
        }));

        assert_eq!(
            models,
            vec![ModelCapability {
                id: "keyprovider/keymodel".to_string(),
                display_name: "Keyed Name".to_string(),
                provider: "opencode",
                source: Some(ModelCapabilitySource {
                    id: "keyprovider".to_string(),
                    display_name: "keyprovider".to_string(),
                }),
                supports_effort: true,
                supported_effort_levels: OPENCODE_PLACEHOLDER_EFFORT_LEVELS
                    .iter()
                    .map(|s| s.to_string())
                    .collect(),
                supports_adaptive_thinking: true,
            }]
        );
    }

    /// `cleanDisplayName` (`:233-240`): control characters stripped, trimmed,
    /// capped at 120 chars; display-name fallback chain
    /// name → displayName → display_name → id (`:322-327`).
    #[test]
    fn normalize_cleans_display_names_and_follows_the_fallback_chain() {
        let long = "x".repeat(300);
        let provided = json!({
            "providers": {
                "p": {
                    "id": "p",
                    "name": "\u{7}Providers\u{1} Name\u{7f}",
                    "models": {
                        "a": { "id": "a", "name": "  Named With Spaces  " },
                        "b": { "id": "b", "displayName": "Camel Display" },
                        "c": { "id": "c", "display_name": "Snake Display" },
                        "d": { "id": "d" },
                        "e": { "id": "e", "name": long },
                        "f": { "id": "f", "name": "\u{0}-\u{1f}" },
                    },
                },
            },
        });

        let models = normalize_enabled_model_catalog(&provided);
        let by_id: std::collections::HashMap<&str, &ModelCapability> =
            models.iter().map(|m| (m.id.as_str(), m)).collect();

        assert_eq!(by_id["p/a"].display_name, "Named With Spaces");
        assert_eq!(by_id["p/b"].display_name, "Camel Display");
        assert_eq!(by_id["p/c"].display_name, "Snake Display");
        assert_eq!(by_id["p/d"].display_name, "d");
        assert_eq!(by_id["p/e"].display_name.len(), MAX_DISPLAY_NAME_LENGTH);
        assert_eq!(by_id["p/f"].display_name, "-");
        assert_eq!(
            by_id["p/a"].source.as_ref().unwrap().display_name,
            "Providers Name"
        );
    }

    /// A `null`/garbage providers field normalizes to an empty list, not a panic
    /// (`readProvidersField`, `:245-260`).
    #[test]
    fn normalize_tolerates_missing_or_wrong_typed_providers_field() {
        assert!(normalize_enabled_model_catalog(&json!({ "providers": null })).is_empty());
        assert!(normalize_enabled_model_catalog(&json!({ "providers": "nope" })).is_empty());
        assert!(normalize_enabled_model_catalog(&json!({})).is_empty());
    }
}
