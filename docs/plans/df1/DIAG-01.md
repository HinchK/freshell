# DIAG-01 — Structured JSONL Rust Server Logs: Completion Plan

> **For agentic workers:** executed inline by df1 worker `df1-diag-01-jsonl-logs`. Steps use checkbox syntax. TDD: every task is RED → GREEN → (refactor) → commit.

**Goal:** Complete the DIAG-01 acceptance text for the Rust server: every JSONL log line carries timestamp, severity, component/event, request/connection/process ownership, **app version**, and **lifecycle context** — with the schema kept Tauri-ready (documented field contract a Tauri producer can emit verbatim; Tauri-side producers are host-limited per the dispatch brief).

**Architecture:** A `tracing_subscriber::Layer` (existing `JsonLayer` in `crates/freshell-server/src/logging.rs`) formats every `tracing` event as one JSONL line through a redacting, size-rotating writer. This plan (1) stamps `app_version` + `server_pid` on **every** line at the layer, (2) adds a per-WS-connection `tracing` span so every event emitted while serving a connection carries its `connection_id` (including spawned handler tasks, via `Span::current()` instrumentation at spawn sites), and (3) adds explicit `server.started` / `server.stopping` / `server.stopped` lifecycle events in `main.rs`. Proof is at two levels: in-crate capture tests (fast) and one black-box integration test driving the compiled binary through auth/terminal/provider/error/restart/quit flows, parsing every emitted line.

**Tech Stack:** Rust, `tracing` + `tracing-subscriber`, axum, tokio; cargo workspace (`crates/freshell-server`, `crates/freshell-ws`).

## Global Constraints (df1 worker contract)

- Scoped runs only: cargo under the cargo lease (`acquire.sh cargo df1-diag-01-jsonl-logs --wait 3600`); NO `npm test`/`check`/`verify`; destructive suites only via `scripts/sandbox-test.sh`.
- Ports 3001/3002/17871/17872/17874 are off-limits; tests use ephemeral loopback ports only.
- No push/PR/git-config/checklist edits. Evidence lands in `docs/plans/df1-evidence/DIAG-01.md`.
- The legacy Node server (`server/`) is frozen — do not touch it.
- Playwright posture: **deferred per dispatch**. Log assertions are file-artifact assertions best done in the Rust black-box test (real binary, real HTTP+WS+SIGTERM, deterministic `FRESHELL_LOG_DIR`+temp `HOME`); a PW browser run adds indirection and cannot drive SIGTERM/restart. Decision recorded in evidence.

## Current state (base = origin/df1/integration @ 3dbba43c2)

Already landed (verified by reading the code):
- `d5a526d3` — `logging.rs`: JSONL layer (`ts`/`level`/`target`/`msg` + flattened fields), rotation, from-first-byte redaction, HTTP request middleware (`request_id`/`route`/`method`/`status`/`duration_ms`, warn on 4xx / error on 5xx), `x-request-id` echo.
- `c200a656c` — WS (`ws.connection.established`/`closed`/`hello.rejected`/`keepalive.terminated`), terminal (`terminal.created`/`exited`/`killed`/`idle_reap`), fresh-agent codex lifecycle events — as event-level fields.
- `shutdown_forensics` event at signal receipt; black-box tests `diag01_diag03_logging.rs` (HTTP/rotation/redaction) and `safe11_term22_shutdown_reaping.rs` (WS + SIGTERM plumbing pattern, incl. `libc::kill` + fake-codex `CODEX_CMD` fixture).

Gaps vs the DIAG-01 acceptance text:
1. **`app version` absent** from every log line (version const exists in `main.rs:73` but never reaches logging).
2. **Process ownership** per line absent (only `request_id`'s embedded pid and per-event `pid` fields on spawn events).
3. **Connection ownership** exists only on the two WS lifecycle events; events emitted while *serving* a connection (e.g. `terminal.created` from the create handler) carry no `connection_id`.
4. **Server lifecycle context** incomplete: no `server.started`/`server.stopping`/`server.stopped` structured events (the boot line is stderr-text only).
5. Stale module doc in `logging.rs` still claims WS/terminal wiring is "NOT in scope" (was completed by `c200a656c`); the schema contract is undocumented (needed for Tauri-readiness).

## Canonical schema (the Tauri-ready contract, documented in `logging.rs`)

Every line: `ts` (RFC3339-millis-Z, UTC), `level` (`INFO`/`WARN`/`ERROR`/`DEBUG`/`TRACE`), `target` (component = crate::module), `msg` (human summary or dotted event name), `app_version` (string), `server_pid` (u64).
Context fields (flattened, present when applicable): `request_id`+`route`+`method`+`status`+`duration_ms` (HTTP), `connection_id`+`origin_kind` (WS connection span), `terminal_id`+`pid` (owned PTY child), `session_id`+`provider` (fresh agent), `boot_id`/`instance_id`/`commit`/`dirty` (boot lifecycle).
Event names are dotted strings (`ws.connection.closed`, `terminal.created`, `server.started`) either as `msg` or an `event` field. A Tauri producer emitting this same shape (its own `app_version`, its process's pid) merges into the same stream coherently.

---

### Task 1: Stamp `app_version` + `server_pid` on every line (logging.rs + main.rs)

**Files:**
- Modify: `crates/freshell-server/src/logging.rs` (config + layer + unit tests)
- Modify: `crates/freshell-server/src/main.rs` (resolve `app_version` before `logging::init`, pass it through)

**Interfaces:**
- Consumes: `main.rs`'s `app_version: Arc<String>` resolution (`FRESHELL_APP_VERSION` env → `APP_VERSION` const `"0.7.0"`).
- Produces: `LoggingConfig { log_dir, max_bytes, max_backups, secret, app_version }`; every JSONL line gains `"app_version":"…"` and `"server_pid":<u64>`; `request_logging_middleware` unchanged.

- [ ] **Step 1: failing unit test in `logging.rs`'s `#[cfg(test)] mod tests`**

```rust
#[test]
fn every_line_stamps_app_version_and_server_pid() {
    let dir = std::env::temp_dir().join(format!(
        "freshell-logging-stamp-test-{}-{:?}",
        std::process::id(),
        std::time::SystemTime::now()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("rust-server.jsonl");
    let writer =
        RotatingWriter::create(path.clone(), 1 << 20, 1, String::new()).unwrap();
    let layer = JsonLayer {
        writer,
        app_version: "9.9.9-test".to_string(),
        server_pid: 424242,
    };
    let subscriber = tracing_subscriber::registry().with(layer);
    tracing::subscriber::with_default(subscriber, || {
        tracing::info!(route = "/api/health", "http_request");
    });
    let content = std::fs::read_to_string(&path).unwrap();
    let line: serde_json::Value = serde_json::from_str(content.lines().next().unwrap()).unwrap();
    assert_eq!(line["app_version"], serde_json::json!("9.9.9-test"));
    assert_eq!(line["server_pid"], serde_json::json!(424242));
    // The pre-existing envelope fields must still be there.
    assert!(line["ts"].as_str().unwrap().ends_with('Z'));
    assert_eq!(line["level"], serde_json::json!("INFO"));
    assert_eq!(line["msg"], serde_json::json!("http_request"));
    assert_eq!(line["route"], serde_json::json!("/api/health"));
    let _ = std::fs::remove_dir_all(&dir);
}
```

- [ ] **Step 2: run RED** — `cargo test -p freshell-server --bin freshell-server logging::tests` → FAIL (`JsonLayer` has no such fields).
- [ ] **Step 3: implement** — add `app_version: String` to `LoggingConfig`; `resolve_config(home, secret, app_version)` takes the resolved version (main.rs owns env resolution; logging stays env-free for the version so tests can inject); `JsonLayer { writer, app_version, server_pid }` where `server_pid = std::process::id() as u64`; in `on_event`, insert `app_version`/`server_pid` into the base `map` BEFORE merging span/event fields (an event-level field of either name would override — a pre-flight `rg` check confirms no call site uses either name).
- [ ] **Step 4: main.rs plumbing** — move the `app_version` resolution block (currently ~line 172) ABOVE the `logging::resolve_config(...)` call (~line 121) and pass `app_version.as_str().to_string()` (it is a pure env read + constant; no dependency on anything built between). Update the resolve_config call sites (unit tests in logging.rs that call `resolve_config`).
- [ ] **Step 5: run GREEN** — same test passes; existing `logging.rs` unit tests still pass.
- [ ] **Step 6: commit** — `feat(rust-server): stamp app_version + server_pid on every JSONL log line (DIAG-01)`

### Task 2: Per-connection `connection_id` propagation (freshell-ws)

**Files:**
- Modify: `crates/freshell-ws/src/terminal.rs` (`run()` — wrap post-handshake body in an instrumented span; instrument spawn sites inside the loop)
- Test: `crates/freshell-ws/tests/diag01_lifecycle_events.rs` (span-aware capture layer + propagation proof)

**Interfaces:**
- Consumes: existing `conn_id` (`state.registry.new_connection_id()`), existing `ws.connection.established`/`closed` events.
- Produces: a `tracing::info_span!("ws_conn", connection_id, origin_kind)` entered for the whole connection loop so every event emitted while serving the connection (same-task or spawned) carries `connection_id`.

- [ ] **Step 1: failing test** — upgrade the test file's `CaptureLayer` to merge span fields (walk `ctx.event_scope(event)` root→leaf reading a `SpanFields`-style extension, same technique as `JsonLayer::on_new_span`/`on_event`; the capture layer must implement `on_new_span` storing recorded fields in span extensions). New test: `terminal_create_event_carries_connection_id` — boot real axum server + real WS client (existing harness convention), `hello` → `ready`, send `terminal.create` (shell mode), await `terminal.created` frame, then assert the captured `terminal.created` event has `connection_id` equal to the one on `ws.connection.established`.
- [ ] **Step 2: run RED** — `cargo test -p freshell-ws --test diag01_lifecycle_events` → FAIL (event lacks `connection_id`).
- [ ] **Step 3: implement** — in `run()`, after `conn_id` is known, build `let span = tracing::info_span!("ws_conn", connection_id = conn_id, origin_kind = origin_kind);` and drive the remainder of the function via `async move { …existing body… }.instrument(span.clone()).await` (do NOT `span.enter()` across `.await` — a held `Entered` guard leaks the span into other tasks parked on the same thread). At each `tokio::spawn(...)` site inside the loop (fresh-agent create/attach/send/interrupt/kill dispatch, ~lines 727-825, and `create_gate::spawn_gated_restore_create`'s internal spawn), wrap the spawned future with `.instrument(tracing::Span::current())` — `Span::current()` at spawn time IS the `ws_conn` span because the spawn site is polled inside it.
- [ ] **Step 4: run GREEN** — propagation test passes; full `cargo test -p freshell-ws` stays green.
- [ ] **Step 5: commit** — `feat(freshell-ws): propagate connection_id to every in-connection log event (DIAG-01)`

### Task 3: Server lifecycle events + doc/schema refresh (main.rs + logging.rs)

**Files:**
- Modify: `crates/freshell-server/src/main.rs` (three events)
- Modify: `crates/freshell-server/src/logging.rs` (module doc: canonical schema contract; remove stale "NOT in scope" section)
- Test: `crates/freshell-server/tests/diag01_lifecycle_logging.rs` (new, black-box — written RED first below)

**Interfaces:**
- Produces events:
  - `server.started` fields: `bind` (e.g. `"127.0.0.1"`), `port` (u16), `boot_id`, `instance_id`, `commit` (`diag::build_commit()`), `dirty` (`diag::build_dirty_str()`) — emitted immediately after `rebind.serve_on(boot_ip)` succeeds, beside the existing stderr boot line.
  - `server.stopping` field: `signal` (`"SIGINT"|"SIGTERM"|"SIGHUP"`) — in `shutdown_signal` right after the select, BEFORE `shutdown_forensics::log_shutdown_forensics` (which keeps its own richer record).
  - `server.stopped` (no extra fields) — last statement before `ExitCode::SUCCESS`, after all shutdown owners run; the synchronous-flush writer guarantees it is on disk before exit.

- [ ] **Step 1: write the black-box test file RED** (full code in Task 4 — the same file covers both; write it now, run, watch it fail on missing `server.started`/`app_version` schema fields).
- [ ] **Step 2: run RED** — `cargo test -p freshell-server --test diag01_lifecycle_logging` → FAIL (no `server.started` line).
- [ ] **Step 3: implement** the three events + `logging.rs` doc refresh (replace the stale "NOT in scope" bullets with the canonical schema section from this plan's header).
- [ ] **Step 4: run GREEN** (both new tests pass).
- [ ] **Step 5: commit** — `feat(rust-server): server.started/stopping/stopped lifecycle events + schema doc (DIAG-01)`

### Task 4: Black-box acceptance test — full flows + restart

**Files:**
- Create: `crates/freshell-server/tests/diag01_lifecycle_logging.rs`

**Test 1 `diag01_full_flow_log_schema_and_correlation`:** boot the compiled binary (`discover_server_binary()` copied from `diag01_diag03_logging.rs`) with temp `HOME`/`FRESHELL_HOME`, `FRESHELL_LOG_DIR` unset (assert the default `<home>/.freshell/logs/rust-server.jsonl` path), ephemeral port, real token. Then:
1. **auth flow:** `GET /api/settings` with a WRONG token → 401; with the right token → 200.
2. **WS flow:** real `tokio-tungstenite` client, `hello` (good token) → `ready`; send `ping` → `pong`. This ONE socket stays open through steps 3-4.
3. **terminal flow:** `terminal.create` (shell mode, cwd=temp) → `terminal.created` frame (capture `terminalId`); `terminal.kill` → the kill's `terminal.exit` wire frame fans out to ATTACHED viewers only and this test never attaches, so await the `terminal.killed` JSONL event in the log file directly (synchronous flush) rather than a wire frame.
4. **provider flow (same socket):** `freshAgent.create { sessionType: "freshcodex" }` with `CODEX_CMD` pointed at the committed fake fixture (`test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`, same pattern as `safe11_term22_shutdown_reaping.rs`) → await create success frame. THEN close the WS (once, here), so the log gains one coherent established->closed connection lifecycle.
5. **recoverable-error flow:** `GET /api/session-directory/missing-id` (authenticated) → 404.
6. **quit flow:** `libc::kill(pid, SIGTERM)` → expect exit 0 within 5s.

Then parse the log file and assert:
- **Every** non-empty line: valid JSON; `ts` parses as RFC3339; `level` ∈ the five levels; `target` non-empty; `msg` is a string; `app_version` equals the binary's reported version (cross-check `GET /api/version`'s `currentVersion` observed during the run); `server_pid` == the child pid.
- **Lifecycle:** exactly one `server.started` (fields: `bind`,`port`,`boot_id`,`instance_id`,`commit`,`dirty`); exactly one `server.stopping` with `signal == "SIGTERM"`, one `shutdown_forensics`, one `server.stopped`; and their relative order started < stopping < stopped (line indices).
- **Correlation:** `ws.connection.established` and `ws.connection.closed` share one non-empty `connection_id`; `terminal.created` carries `terminal_id` == the returned id, a `pid` > 0, and the same `connection_id`; `terminal.killed` (by="api") and/or `terminal.exited` reference the same `terminal_id`; `freshagent.session.created` has `provider == "codex"`, non-empty `session_id`.
- **Error entries:** a warn-level 401 line for `/api/settings` and a warn-level 404 line for the missing session path, each with distinct non-empty `request_id`s.
- **No secret:** the raw file bytes never contain the token.

**Test 2 `diag01_restart_writes_two_coherent_lifecycles`:** same home; boot A → SIGTERM → wait exit; boot B (new port) → SIGTERM → wait exit. Parse the single appended log: two `server.started` and two `server.stopped` events in interleavable-free order (A.started < A.stopped < B.started < B.stopped by line index), A and B share `instance_id` (CFG-07 persistence) but differ in `boot_id` and `server_pid`; `ts` values are non-decreasing in file order; every line still satisfies the per-line schema assertions.

- [ ] **Step 1:** write both tests (helper `parse_lines(path) -> Vec<serde_json::Value>` shared in-file).
- [ ] **Step 2:** run RED during Task 3 as its failing test; after Task 3 impl, run GREEN.
- [ ] **Step 3:** run the file twice (flake check) green.
- [ ] **Step 4:** commit — `test(rust-server): DIAG-01 black-box full-flow + restart log acceptance`

### Task 5: Scoped verification, evidence, wrap-up

- [ ] Full scoped suites green: `cargo test -p freshell-server`, `cargo test -p freshell-ws`, `cargo test -p freshell-terminal`, `cargo test -p freshell-freshagent`; `cargo clippy -p freshell-server -p freshell-ws -- -D warnings`; `cargo fmt --check`.
- [ ] Write `docs/plans/df1-evidence/DIAG-01.md`: what landed, green commands verbatim, Tauri-readiness note (schema contract above; Tauri producers host-limited), Playwright-deferral rationale.
- [ ] `df1ctl.py update DIAG-01` → `{"state":"review","terminal":"COMPLETED", ...}`.

## Self-review notes

- Spec coverage: timestamp/severity/component/event ✔ (existing), request ownership ✔ (existing), connection ownership ✔ (Task 2), process ownership ✔ (Task 1 `server_pid` + existing child `pid` fields), app version ✔ (Task 1), lifecycle context ✔ (Task 3). PW spec → deferred-to-Rust decision recorded (dispatch-sanctioned). Tauri → schema Tauri-ready + note (host-limited producers).
- Type consistency: `app_version: String` everywhere; `server_pid: u64`; `connection_id` is the registry's id type (`u64`, recorded as integer) — capture layer records via `record_u64`.
- No placeholders: all test code is specified above or referenced to existing copyable harnesses (`diag01_diag03_logging.rs`, `safe11_term22_shutdown_reaping.rs`, `diag01_lifecycle_events.rs`).
