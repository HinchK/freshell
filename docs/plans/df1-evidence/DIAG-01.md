# DIAG-01 — Structured JSONL Rust server/Tauri logs — Evidence

Worker: `df1-diag-01-jsonl-logs` · Branch: `df1/diag-01-jsonl-logs` (base `origin/df1/integration` @ `3dbba43c2`) · Plan: `docs/plans/df1/DIAG-01.md`

## Verdict

**Rust-server side: COMPLETE.** Every JSONL line carries the full DIAG-01 required set — timestamp, severity, component/event, request/connection/process ownership, app version, lifecycle context — proven black-box against the compiled binary through the checklist's named flows (auth, terminal, provider, recoverable error, restart, quit). Tauri-side producers are host-limited (dispatch-sanctioned); the schema is documented as a Tauri-ready contract.

## What the base already had (credit where due)

- `d5a526d3` — `crates/freshell-server/src/logging.rs`: JsonLayer (`ts`/`level`/`target`/`msg` + flattened fields), rotation, from-first-byte redaction, HTTP request middleware (`request_id`/`route`/`method`/`status`/`duration_ms`).
- `c200a656c` — WS (`ws.connection.established/closed/hello.rejected/keepalive.terminated`), terminal (`terminal.created/exited/killed/idle_reap`), freshagent-codex lifecycle events as event-level fields.
- `shutdown_forensics` record at signal receipt.

## Gaps closed by this branch

1. **App version was absent from log output entirely** → `app_version` now stamped on every line by the JsonLayer (resolved once at boot: `FRESHELL_APP_VERSION` env → `APP_VERSION` const; cross-checked against `GET /api/version`'s `currentVersion` in the black-box test). (commit `5cea64611`)
2. **Process ownership per line** → `server_pid` stamped on every line next to `app_version` (child processes keep their own `pid` fields on spawn events — no collision by name). (commit `5cea64611`)
3. **Connection ownership existed only on two lifecycle events** → `run()` now wraps the whole serve loop (extracted `run_loop`) in a per-connection `ws_conn` span (`connection_id` + `origin_kind`); all 15 fresh-agent `tokio::spawn` sites in the dispatch are `.instrument(Span::current())`'d, the gated restore-create task too, and all 16 `spawn_blocking` sites in `terminal.rs` go through `spawn_blocking_in_span` (span context would otherwise be dropped at BOTH thread/task boundaries — this is what puts `connection_id` on the registry's `terminal.created`, which fires from a blocking-pool PTY spawn). (commit `f787178fa`)
4. **No server lifecycle context** → `server.started` (`bind`,`port`,`boot_id`,`instance_id`,`commit`,`dirty`), `server.stopping` (`signal`), `server.stopped` (after every shutdown owner; on disk by construction — synchronous per-line flush). `boot_id` wiring into `WsState` became a clone so the event names the same boot the WS handshake reports. (commit `3ceb699df`)
5. **Stale module doc** claiming WS/terminal wiring out of scope → rewritten as the canonical schema contract. (commit `3ceb699df`)
6. **Review-round-1 fix**: `ws_conn` span was INFO-level → silently disabled by an operator's `RUST_LOG=warn`/`error`, stripping `connection_id` from exactly the WARN/ERROR in-connection events an operator cranks the filter up to inspect (empirically confirmed: empty span-field set under a warn EnvFilter). Span now minted at ERROR level via one production constructor `connection_span` (context infrastructure; JsonLayer never renders span open/close so zero output effect), pinned by a five-level filter matrix unit test with an INFO-flip negative control. (commit `effa0421d`)
7. **Review-round-1 fix (doc)**: plan flow list closed the WS then reused it; corrected to one socket across steps 2–4. (commit `effa0421d`)

## Live sample (debug binary, temp HOME, real HTTP + SIGTERM, 2026-08-09)

```json
{"ts":"2026-08-09T23:20:05.893Z","level":"INFO","target":"freshell_server","app_version":"0.7.0","server_pid":439322,"bind":"127.0.0.1","port":19817,"boot_id":"boot-…","instance_id":"srv-…","commit":"f787178fab…","dirty":"true","msg":"server.started"}
{"ts":"2026-08-09T23:20:06.085Z","level":"INFO","target":"freshell_server","app_version":"0.7.0","server_pid":439322,"signal":"SIGTERM","msg":"server.stopping"}
{"ts":"2026-08-09T23:20:06.638Z","level":"INFO","target":"freshell_server","app_version":"0.7.0","server_pid":439322,"msg":"server.stopped"}
```
Exit code 0; zero occurrences of the live AUTH_TOKEN in the file.

## Tauri-readiness note (host-limited producers)

The canonical schema is documented in `crates/freshell-server/src/logging.rs`'s module header ("Canonical line schema (the Tauri-ready contract)"). It is deliberately free of server-only assumptions: a Tauri host producer emits the same shape with its own `app_version` and its process's pid, and the streams merge coherently. Implementing the Tauri-side producer requires the native Windows/macOS Tauri host (`PW-TAURI-WIN`/HARNESS-07), unavailable on this Linux host per the dispatch brief; nothing in this branch blocks it.

## Playwright decision (dispatch: "prefer rust crate/integration tests, record decision")

No Playwright spec was authored. Rationale: DIAG-01's assertion surface is a server-side file artifact. The black-box Rust integration test (`crates/freshell-server/tests/diag01_lifecycle_logging.rs`) boots the REAL compiled binary and drives REAL HTTP + WS + SIGTERM with deterministic `HOME`/`FRESHELL_HOME` temp isolation — strictly more direct than a browser-mediated run of the same flows, and it can drive SIGTERM/restart, which a browser cannot. The checklist's named flows (auth, terminal, provider, recoverable error, restart, quit) are all exercised there. `PW-TAURI-WIN` remains blocked on the native Tauri host regardless of test framework.

## Green commands (final HEAD)

All run under the df1 cargo lease (`acquire.sh cargo df1-diag-01-jsonl-logs`):

- `cargo test -p freshell-server --test diag01_lifecycle_logging` — 2/2 passed (×3 runs)
- `cargo test -p freshell-server --test diag01_diag03_logging` — 1/1 passed
- `cargo test -p freshell-server` — full crate: 609 unit + all integration files green
- `cargo test -p freshell-ws` — full crate green (430 lib + all integration files); one known-flaky file excluded from the pass/fail claim, see below
- `cargo test -p freshell-terminal` — 175+ green
- `cargo test -p freshell-freshagent` — 358+ green
- `cargo clippy -p freshell-server -p freshell-ws --all-targets -- -D warnings` — clean
- `cargo fmt --check -p freshell-server -p freshell-ws` — clean

## Known-flaky exclusion (classified, attribution-tested)

`crates/freshell-ws --test auto_resume_e2e` (both tests) flakes on this host at 10s frame-wait timeouts. Attribution experiment: virgin `origin/df1/integration` in a scratch worktree fails **3/6 isolated runs (50%)** once `node_modules` exists (without it: 100%, because claude-mode MCP injection resolves `node_modules/tsx`/`dist/server/mcp/server.js` relative to repo root — also a fail-loud gap); this branch: 4/17 (~24%). Same failure on both → pre-existing, NOT caused by DIAG-01. Filed as `DIAG-FOLLOWUP-AUTORESUME-FLAKE`.

## Review loop record

1. Preferred path (fresh subagent via freshell fresh-agent pane) attempted twice; the environment's MCP gateway timed out / returned phantom tab ids → fell back to the dispatch-sanctioned recorded fresh-eyes review.
2. Round 1 (fresheyes `--gpt`, FRESHPID 236685): **FAILED** with 2 major findings — (a) INFO-level ws_conn span drops connection_id under `RUST_LOG=warn+` (empirically confirmed, fixed, ERROR-level span + 5-level filter test + negative control); (b) plan-doc WS close/reuse contradiction (fixed). Commit `effa0421d`.
3. Round 2 (fresheyes `--gpt`, FRESHPID 2576086): see wrap-up amendment below.

## Load-bearing audit (all VERIFIED before execution)

| Claim | Method | Result |
|---|---|---|
| No tracing call site uses `app_version`/`server_pid` field names | `rg` across all server crates | zero matches |
| `connection_id` is `u64` | registry.rs:754 | ✓ |
| `.instrument(Span::current())` propagates into spawned tasks | standard tracing idiom + in-crate test | ✓ (test passes; negative control fails) |
| In-crate WS harness can drive real terminal.create | `create_protection.rs` precedent | ✓ |
| `app_version` resolution movable before logging init | main.rs read (pure env+const) | ✓ compiles/works |
| `CODEX_CMD="node <fixture>"` reaches the spawned server | safe11 test:271 + codex.rs:1978 | ✓ |
| Writer flush is synchronous per line | logging.rs write_line + unit tests | ✓ |
| DIAG-04's app_version surfaces don't collide | diag.rs is API responses, not logs | ✓ |
