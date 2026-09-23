//! Unified agent names (plan Task 3) — OpenCode native-name contract tests:
//! the supported PATCH `update_session_title` route (directory/endpoint
//! routing), the OPENCODE_DB effective-database context evaluation (absolute,
//! relative, `:memory:`) and the mismatch rejection before dispatch, and the
//! REAL `session.updated.properties.info.id` event shape (id + title), with
//! the observation never treating the event's `time.updated` as rename
//! recency. Fully faked serve IO — no real opencode binary (the
//! real-provider proof belongs to Task 8's sandbox smoke).

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use freshell_opencode::events::{
    parse_serve_event, serve_event_to_sdk, session_title_observation, SdkProviderEvent,
};
use freshell_opencode::serve::{
    default_opencode_database, resolve_opencode_database, EffectiveOpencodeDatabase, Endpoint,
    EventSink, EventSource, EventStreamHandle, HttpMethod, OpencodeServeManager, PortAllocator,
    ProcessSpawner, ServeConfig, ServeDeps, ServeHttp, ServeHttpError, ServeHttpRequest,
    ServeHttpResponse, ServeProcess, SpawnRequest,
};
use serde_json::json;

// ── fakes ────────────────────────────────────────────────────────────────────────

/// Records every request (method + url + body) and answers 200 `{}`.
#[derive(Default)]
struct RecordingHttp {
    requests: std::sync::Mutex<Vec<(HttpMethod, String, Option<String>)>>,
}

impl ServeHttp for RecordingHttp {
    fn request<'a>(
        &'a self,
        req: ServeHttpRequest,
    ) -> std::pin::Pin<
        Box<dyn Future<Output = Result<ServeHttpResponse, ServeHttpError>> + Send + 'a>,
    > {
        self.requests.lock().unwrap().push((
            req.method,
            req.url.clone(),
            req.body
                .as_ref()
                .map(|b| String::from_utf8_lossy(b).into_owned()),
        ));
        Box::pin(async { Ok(ServeHttpResponse::new(200, b"{}".to_vec())) })
    }
}

struct FakeAllocator;
impl PortAllocator for FakeAllocator {
    fn allocate(&self) -> Result<Endpoint, String> {
        Ok(Endpoint {
            hostname: "127.0.0.1".into(),
            port: 1,
        })
    }
}

struct NeverExitsProcess;
impl ServeProcess for NeverExitsProcess {
    fn exited(&self) -> Option<i32> {
        None
    }
    fn take_fatal_startup_error(&self) -> Option<String> {
        None
    }
    fn kill(&self) {}
}

struct FakeSpawner;
impl ProcessSpawner for FakeSpawner {
    fn spawn(&self, _req: SpawnRequest) -> Result<Box<dyn ServeProcess>, String> {
        Ok(Box::new(NeverExitsProcess))
    }
}

struct NeverConnects;
impl EventSource for NeverConnects {
    fn connect(&self, _url: String, _sink: EventSink) -> Box<dyn EventStreamHandle> {
        struct Handle;
        impl EventStreamHandle for Handle {}
        Box::new(Handle)
    }
}

/// A started manager over the recording fake. `env` layers the serve's spawn
/// environment (the OPENCODE_DB override evaluation reads the LAST entry).
async fn started_manager(env: Vec<(String, String)>) -> (OpencodeServeManager, Arc<RecordingHttp>) {
    let http = Arc::new(RecordingHttp::default());
    let deps = ServeDeps {
        spawner: Arc::new(FakeSpawner),
        http: http.clone() as Arc<dyn ServeHttp>,
        ports: Arc::new(FakeAllocator),
        events: Arc::new(NeverConnects),
    };
    let config = ServeConfig {
        env,
        health_timeout: Duration::from_millis(500),
        ..Default::default()
    };
    let manager = OpencodeServeManager::new(deps, config);
    manager.ensure_started().await.expect("fake serve starts");
    (manager, http)
}

// ── PATCH / GET dispatch with directory/endpoint routing ───────────────────────────

#[tokio::test]
async fn update_session_title_patches_the_routed_session() {
    let (manager, http) = started_manager(Vec::new()).await;
    let route = Some("/work/project".to_string());
    let answer = manager
        .update_session_title("ses_abc", "The Renamed Session", &route)
        .await
        .expect("the PATCH dispatches");
    assert_eq!(answer, json!({}));

    let requests = http.requests.lock().unwrap().clone();
    let patch = requests
        .iter()
        .find(|(method, url, _)| *method == HttpMethod::Patch && url.contains("/session/ses_abc"))
        .expect("a PATCH was dispatched");
    assert!(
        patch.1.contains("directory=%2Fwork%2Fproject")
            || patch.1.contains("directory=/work/project"),
        "the session's own directory routes the request: {}",
        patch.1
    );
    let body = patch.2.as_deref().expect("a JSON body");
    let parsed: serde_json::Value = serde_json::from_str(body).unwrap();
    assert_eq!(parsed, json!({ "title": "The Renamed Session" }));

    // The management GET beside it (the readback contract's other half).
    let got = manager
        .get_session("ses_abc", &route)
        .await
        .expect("GET answers");
    assert_eq!(got, json!({}));
    let requests = http.requests.lock().unwrap().clone();
    assert!(requests
        .iter()
        .any(|(method, url, _)| *method == HttpMethod::Get && url.contains("/session/ses_abc")));
}

// ── the OPENCODE_DB effective-database context ─────────────────────────────────────

#[test]
fn opencode_db_overrides_evaluate_absolute_relative_and_memory() {
    let default = std::path::PathBuf::from("/data/home/opencode/opencode.db");
    // Absent override: the ambient data home default.
    assert_eq!(
        resolve_opencode_database(None, default.clone(), std::path::Path::new("/cwd")),
        EffectiveOpencodeDatabase::File(default.clone())
    );
    // Absolute override: that file, never the directory.
    assert_eq!(
        resolve_opencode_database(
            Some("/pinned/custom.db"),
            default.clone(),
            std::path::Path::new("/cwd")
        ),
        EffectiveOpencodeDatabase::File(std::path::PathBuf::from("/pinned/custom.db"))
    );
    // Relative override: resolved against the serve's working directory.
    assert_eq!(
        resolve_opencode_database(
            Some("relative/custom.db"),
            default.clone(),
            std::path::Path::new("/srv")
        ),
        EffectiveOpencodeDatabase::File(std::path::PathBuf::from("/srv/relative/custom.db"))
    );
    // `:memory:`: an in-memory route that can never address a file database.
    assert_eq!(
        resolve_opencode_database(
            Some(":memory:"),
            default.clone(),
            std::path::Path::new("/cwd")
        ),
        EffectiveOpencodeDatabase::Memory
    );
    // A blank override falls back to the default, not an empty path.
    assert_eq!(
        resolve_opencode_database(Some("   "), default, std::path::Path::new("/cwd")),
        EffectiveOpencodeDatabase::File(std::path::PathBuf::from(
            "/data/home/opencode/opencode.db"
        ))
    );
    // The ambient default mirrors the session index's data-home resolution.
    let resolved = default_opencode_database();
    assert!(resolved.to_string_lossy().ends_with("opencode.db"));
}

#[tokio::test]
async fn a_database_mismatch_rejects_the_write_before_dispatch() {
    // The serve is PINNED (via its spawn env) to a database that does NOT
    // match the session's indexed database: the write must be rejected
    // BEFORE dispatch — never silently applied to the wrong store, never
    // silently using the session's directory as a store selector.
    let (manager, http) = started_manager(vec![(
        "OPENCODE_DB".to_string(),
        "/pinned/other.db".to_string(),
    )])
    .await;
    let rejection = manager
        .check_database_context(std::path::Path::new("/data/home/opencode/opencode.db"))
        .expect_err("a mismatched context rejects diagnostically");
    assert!(
        rejection.to_string().contains("mismatch"),
        "the diagnostic names the mismatch: {rejection}"
    );
    // No PATCH ever dispatched for the mismatch.
    assert!(
        !http
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|(method, _, _)| *method == HttpMethod::Patch),
        "a rejected context never dispatches"
    );

    // A matching context passes.
    manager
        .check_database_context(std::path::Path::new("/pinned/other.db"))
        .expect("a matching database context dispatches");
}

#[tokio::test]
async fn an_in_memory_route_rejects_diagnostically() {
    let (manager, http) =
        started_manager(vec![("OPENCODE_DB".to_string(), ":memory:".to_string())]).await;
    let rejection = manager
        .check_database_context(std::path::Path::new("/data/home/opencode/opencode.db"))
        .expect_err(":memory: can never address an indexed file database");
    assert!(
        rejection.to_string().contains("in-memory"),
        "the diagnostic names the in-memory route: {rejection}"
    );
    assert!(!http
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|(method, _, _)| *method == HttpMethod::Patch));
}

// ── the real session.updated info.id event shape ────────────────────────────────────

/// The REAL `session.updated` payload carries the session id at
/// `properties.info.id` and the title at `properties.info.title`.
#[test]
fn session_updated_resolves_the_session_id_from_properties_info_id() {
    let event = parse_serve_event(&json!({
        "type": "session.updated",
        "properties": {
            "info": {
                "id": "ses_real_shape",
                "title": "Externally Renamed",
                "time": { "created": 1, "updated": 1750000000000i64 }
            }
        }
    }))
    .expect("the real session.updated parses");
    assert_eq!(event.session_id.as_deref(), Some("ses_real_shape"));

    // The title observation exposes ONLY (id, title): the event's
    // `time.updated` bump is NOT rename recency (a native title change
    // touches it exactly like any other session mutation), so nothing in
    // the observation pipeline can mistake it for an explicit-rename time.
    let observed = session_title_observation(&event).expect("a title observation");
    assert_eq!(
        observed,
        (
            "ses_real_shape".to_string(),
            "Externally Renamed".to_string()
        )
    );

    // A title-less session.updated observes nothing.
    let bare = parse_serve_event(&json!({
        "type": "session.updated",
        "properties": { "info": { "id": "ses_bare" } }
    }))
    .expect("parses");
    assert!(session_title_observation(&bare).is_none());
}

#[test]
fn session_updated_maps_to_a_title_observation_sdk_event() {
    let parsed = parse_serve_event(&json!({
        "type": "session.updated",
        "properties": {
            "info": { "id": "ses_mapped", "title": "Renamed By Anything" }
        }
    }))
    .expect("parses");
    // The mapped event uses the OBSERVATION's own info.id — the real session
    // the title belongs to — and carries no intent of any kind.
    assert_eq!(
        serve_event_to_sdk(&parsed, "subscribed-placeholder"),
        Some(SdkProviderEvent::TitleObserved {
            session_id: "ses_mapped".to_string(),
            title: "Renamed By Anything".to_string(),
        })
    );
}
