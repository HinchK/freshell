# Managed Codex Sidecar MCP Context Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Fix managed Codex startup so the Codex TUI and its separate app-server receive the same Freshell MCP configuration and terminal context, eliminating the indefinite “Booting MCP server: node_repl” state while preserving the Freshell MCP’s working tool access.

### Explicit constraints
- Use the-usual repair-and-review workflow.
- Work in a dedicated repository worktree; do not modify or restart the live self-hosted Freshell server without explicit APPROVED authorization.
- Preserve the managed Codex launch architecture and verify the affected behavior with meaningful automated coverage.

### Accepted tradeoffs and residuals
- Starting the Freshell MCP alongside node_repl may add roughly half a second to the startup round; the servers start concurrently.

**Goal:** A newly spawned managed Codex app-server and its TUI use one immutable Freshell MCP/terminal-context snapshot, so Codex sees every configured MCP server and can use Freshell tools immediately.

**Architecture:** Represent the already-resolved Codex configuration as an owned sidecar launch context: additive Codex `-c` arguments plus a deterministic environment override map. Carry that context through the existing managed launch plan to the spawned sidecar while the WS terminal path reuses the same snapshot for the TUI. For restore-class preplanning, mint and retain the terminal identity with that snapshot so the eventual PTY never receives a different MCP definition or `FRESHELL_*` context.

**Tech Stack:** Rust 2021 workspace; Tokio process spawning and WebSocket proxy; existing `freshell-platform` MCP injection and CLI spawn builders; deterministic Rust unit/integration fixtures.

## Global Constraints

- Work only in `/home/dan/code/freshell/.worktrees/codex-mcp-sidecar-config` on `the-usual/codex-mcp-sidecar-config`; do not modify the live server or restart it.
- Keep the existing managed Codex topology: one app-server, one loopback proxy, and one TUI. Preserve sidecar ownership tags, isolated `CODEX_HOME`, startup retry/queue behavior, reattachment behavior, and the explicit `FRESHELL_CODEX_MANAGED_LAUNCH=0` plain-CLI opt-out.
- Build the MCP command only once per terminal launch attempt. The same resolved Codex config args must appear before `app-server` in the sidecar command and in the TUI’s normal Codex config segment.
- Pass terminal context only to the spawned child process; do not place it in global process environment, durable sidecar records, logs, error strings, or `Debug` output. Any diagnostic formatting for the new context may expose environment keys but never their values.
- Use the native sidecar working directory derived for MCP/config work, so a default or WSL-normalized terminal does not give the app-server a different usable directory than the MCP command and terminal launch.
- Preserve survivor reattachment: an already-running sidecar cannot be retroactively reconfigured, so this change affects newly spawned sidecars and retry/recovery spawns without forcing a survivor restart.
- Run focused Rust checks through Cargo, run the ignored managed-launch integration test alone, format with `cargo fmt --all`, and use the repository-coordinated broad gate only at the stage that requires it.

## File Responsibilities

| File | Responsibility in this change |
| --- | --- |
| `crates/freshell-codex/src/launch_plan.rs` | Own the redacted, immutable sidecar launch context and turn it into deterministic app-server argv/env. |
| `crates/freshell-codex/src/launch_lifecycle.rs` | Keep the context attached to a managed plan and apply it only when spawning a new app-server. |
| `crates/freshell-codex/src/runtime_select.rs` | Give a newly selected spawned runtime the plan’s context while leaving a reattached survivor unchanged. |
| `crates/freshell-freshagent/src/codex.rs` | Explicitly retain its existing empty sidecar context when using the shared spawn-spec helper. |
| `crates/freshell-ws/src/terminal.rs` | Build one Codex launch snapshot and reuse it across interactive create, restore preplanning, and PTY recovery. |
| `crates/freshell-ws/tests/codex_managed_launch_e2e.rs` | Observe both actual child processes and assert MCP/context parity through the real Rust proxy path. |

---

### Task 1: Make managed sidecar configuration an owned, redacted spawn input

**Files:**

- Modify: `crates/freshell-codex/src/launch_plan.rs:172-342`
- Modify: `crates/freshell-codex/src/launch_lifecycle.rs:46-53, 376-404, 1008-1167`
- Modify: `crates/freshell-codex/src/runtime_select.rs:12-40`
- Modify: `crates/freshell-freshagent/src/codex.rs:3714-3745`
- Test: `crates/freshell-codex/src/launch_plan.rs:673-704`
- Test: `crates/freshell-codex/tests/launch_lifecycle.rs`

**Interfaces:**

- Consumes: the existing `McpInjection { args, env }` and terminal base environment produced by the WS layer.
- Produces: `CodexSidecarLaunchContext { config_args, env }`, carried in `CodexLaunchPlanInput`/`CodexLaunchPlan` and consumed only by `SpawnedCodexAppServerRuntime`.
- Preserves: `CodexLaunchRuntime::ensure_ready(cwd)`, runtime selection, reattached sidecar behavior, and the `CODEX_MANAGED_REMOTE_CONFIG_ARGS`/ownership-tag order.

- [ ] **Step 1: Write the failing behavioral test**

Add a focused golden proving that a supplied launch context is added between the existing managed config pair and `app-server`, that context environment reaches the spawn spec, and that the ownership key wins over an accidental same-name value. Keep the test values synthetic.

```rust
#[test]
fn sidecar_spawn_spec_includes_context_without_exposing_or_losing_ownership() {
    let context = CodexSidecarLaunchContext {
        config_args: vec![
            "-c".to_string(),
            "mcp_servers.freshell.command='node'".to_string(),
            "-c".to_string(),
            "mcp_servers.freshell.args=['--import','tsx','server/mcp/server.ts']".to_string(),
        ],
        env: BTreeMap::from([
            ("FRESHELL_TERMINAL_ID".to_string(), "term-test".to_string()),
            ("FRESHELL_TOKEN".to_string(), "test-token".to_string()),
            (
                CODEX_SIDECAR_OWNERSHIP_ENV.to_string(),
                "must-not-win".to_string(),
            ),
        ]),
    };

    let spec = codex_sidecar_spawn_spec(
        "ws://127.0.0.1:41234",
        "codex-sidecar-abc",
        &context,
    );

    assert_eq!(
        spec.args,
        vec![
            "-c", "features.apps=false",
            "-c", "mcp_servers.freshell.command='node'",
            "-c", "mcp_servers.freshell.args=['--import','tsx','server/mcp/server.ts']",
            "app-server", "--listen", "ws://127.0.0.1:41234",
        ]
    );
    assert_eq!(
        spec.env.into_iter().collect::<BTreeMap<_, _>>(),
        BTreeMap::from([
            ("FRESHELL_TERMINAL_ID".to_string(), "term-test".to_string()),
            ("FRESHELL_TOKEN".to_string(), "test-token".to_string()),
            (
                CODEX_SIDECAR_OWNERSHIP_ENV.to_string(),
                "codex-sidecar-abc".to_string(),
            ),
        ])
    );
}
```

Also add a runtime-level fake-app-server assertion that a context supplied through a plan reaches the actual spawned process, while a default context remains empty for existing direct-runtime and fresh-agent callers.

- [ ] **Step 2: Run the test and verify the intended failure**

Run:

```bash
cargo test -p freshell-codex sidecar_spawn_spec_includes_context_without_exposing_or_losing_ownership
```

Expected: FAIL because `CodexSidecarLaunchContext` and the third spawn-spec parameter do not yet exist, and the current sidecar argv stops after `features.apps=false` before `app-server`.

- [ ] **Step 3: Add the minimal production implementation**

In `launch_plan.rs`, define an owned context beside `CodexSidecarSpawnSpec`. Its custom `Debug` implementation must retain config-argument visibility for test diagnostics but render only sorted environment keys, never values.

```rust
#[derive(Clone, PartialEq, Eq, Default)]
pub struct CodexSidecarLaunchContext {
    pub config_args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

impl std::fmt::Debug for CodexSidecarLaunchContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CodexSidecarLaunchContext")
            .field("config_args", &self.config_args)
            .field("env_keys", &self.env.keys().collect::<Vec<_>>())
            .finish()
    }
}
```

Add `sidecar_context: CodexSidecarLaunchContext` to `CodexLaunchPlanInput` and `CodexLaunchPlan`; `plan_codex_launch` clones it without interpreting it. Preserve default construction so existing non-context callers receive an empty context, and update every explicit `CodexLaunchPlan` golden in this file to expect `CodexSidecarLaunchContext::default()` unless that test deliberately supplies a context. Change the pure spawn builder to append `context.config_args` before `app-server`, merge `context.env` into a `BTreeMap`, then insert `CODEX_SIDECAR_OWNERSHIP_ENV` last before producing the deterministic vector.

```rust
pub fn codex_sidecar_spawn_spec(
    listen_ws_url: &str,
    ownership_id: &str,
    context: &CodexSidecarLaunchContext,
) -> CodexSidecarSpawnSpec {
    let mut args = CODEX_MANAGED_REMOTE_CONFIG_ARGS
        .iter()
        .map(|value| (*value).to_string())
        .collect::<Vec<_>>();
    args.extend(context.config_args.iter().cloned());
    args.extend([
        "app-server".to_string(),
        "--listen".to_string(),
        listen_ws_url.to_string(),
    ]);

    let mut env = context.env.clone();
    env.insert(CODEX_SIDECAR_OWNERSHIP_ENV.to_string(), ownership_id.to_string());
    CodexSidecarSpawnSpec { args, env: env.into_iter().collect() }
}
```

Construct `SpawnedCodexAppServerRuntime` with the context copied from its plan and call the new spawn builder in `ensure_ready`. `runtime_select::select_codex_runtime` must pass the plan context only to `SpawnedCodexAppServerRuntime`; a `ReattachedCodexAppServerRuntime` stays untouched because it never starts a child. Keep existing public constructors as empty-context convenience constructors and add context-taking constructors for the selector/tests. Update the fresh-agent use of the shared builder to pass `&CodexSidecarLaunchContext::default()` so that its unrelated launch remains byte-for-byte equivalent.

- [ ] **Step 4: Run the focused test**

Run:

```bash
cargo test -p freshell-codex sidecar_spawn_spec_includes_context_without_exposing_or_losing_ownership
```

Expected: PASS, including exact argument ordering and ownership-tag precedence.

- [ ] **Step 5: Refactor while green**

Remove any duplicated ad-hoc argv/environment merge introduced while making the test pass. Keep context construction in the WS layer and process construction in `freshell-codex`; do not add a callback or global mutable configuration path.

- [ ] **Step 6: Run impacted-test verification**

The altered types and shared sidecar spawn helper affect the Codex planner/lifecycle and fresh Codex compilation paths. Run:

```bash
cargo test -p freshell-codex
cargo test -p freshell-freshagent codex
cargo check -p freshell-ws --all-targets
cargo fmt --all -- --check
```

Expected: PASS. If the fresh-agent crate has no matching `codex` filter, Cargo may report zero selected tests only after `cargo check -p freshell-freshagent --all-targets` passes; do not treat a filter mismatch as coverage.

- [ ] **Step 7: Commit the task**

```bash
git add -- crates/freshell-codex/src/launch_plan.rs crates/freshell-codex/src/launch_lifecycle.rs crates/freshell-codex/src/runtime_select.rs crates/freshell-codex/tests/launch_lifecycle.rs crates/freshell-freshagent/src/codex.rs
git commit -m "fix: carry Codex sidecar launch context"
```

### Task 2: Reuse one context for create, restore preplanning, recovery, and the real dual-process launch

**Files:**

- Modify: `crates/freshell-ws/src/terminal.rs:2021-2073, 2488-2526, 2644-2709, 2946-3513, 4330-4406`
- Modify: `crates/freshell-ws/tests/codex_managed_launch_e2e.rs:65-104, 302-420`
- Test: `crates/freshell-ws/src/terminal.rs:7004-7038`
- Test: `crates/freshell-ws/tests/codex_managed_launch_e2e.rs:302-420`

**Interfaces:**

- Consumes: resolved terminal id, effective native MCP cwd, `McpInjection`, tab/pane identity, and `build_terminal_base_env` output.
- Produces: one `CodexManagedLaunchSetup` containing the TUI injection, terminal environment, native sidecar cwd, and `CodexSidecarLaunchContext` for the same launch attempt.
- Preserves: pre-gate restore planning, prepared-launch cleanup, proxy adoption, resume ordering, recovery spawning, non-Codex modes, and managed-launch opt-out.

- [ ] **Step 1: Write the failing behavioral test**

Extend the ignored dual-role integration fixture so its dispatcher writes both TUI argv and only these environment fields to `CODEX_ARGV_CAPTURE_PATH`; retain the fake app-server’s existing `FAKE_CODEX_APP_SERVER_ARG_LOG` observation. Add helpers that extract only the Freshell MCP `-c` values and the six `FRESHELL_*` fields. For the managed fresh and managed-resume legs, assert equality of those normalized values and matching terminal id; continue asserting the live `initialize` relay.

```rust
#[derive(Debug, Deserialize)]
struct CapturedCodexProcess {
    argv: Vec<String>,
    env: BTreeMap<String, Option<String>>,
}

fn freshell_mcp_config(argv: &[String]) -> Vec<String> {
    argv.windows(2)
        .filter_map(|pair| {
            (pair[0] == "-c" && pair[1].starts_with("mcp_servers.freshell."))
                .then(|| pair[1].clone())
        })
        .collect()
}

fn assert_freshell_launch_parity(
    tui: &CapturedCodexProcess,
    sidecar: &CapturedCodexProcess,
    terminal_id: &str,
) {
    assert_eq!(freshell_mcp_config(&tui.argv), freshell_mcp_config(&sidecar.argv));
    assert_eq!(tui.env, sidecar.env);
    assert_eq!(tui.env["FRESHELL_TERMINAL_ID"].as_deref(), Some(terminal_id));
    assert!(sidecar.argv.iter().position(|arg| arg == "app-server").is_some());
}
```

Use non-secret fixture values. The test must include `tabId` and `paneId` on the fresh create so it proves those optional terminal-context fields are also identical. The app-server log must be read before `registry.kill`, and each phase must use its own capture file.

- [ ] **Step 2: Run the test and verify the intended failure**

Run:

```bash
cargo test -p freshell-ws --test codex_managed_launch_e2e -- --ignored --test-threads=1
```

Expected: FAIL on the managed fresh leg because the app-server observation has no Freshell MCP config arguments or `FRESHELL_TERMINAL_ID`, while the TUI observation does. The plain opt-out leg must remain unmodified.

- [ ] **Step 3: Add the minimal production implementation**

Add a private setup value in `terminal.rs`, with no `Debug` implementation that could reveal the configured token.

```rust
#[derive(Clone)]
struct CodexManagedLaunchSetup {
    terminal_id: String,
    runtime_cwd: Option<String>,
    mcp_injection: McpInjection,
    terminal_env: BTreeMap<String, String>,
    sidecar_context: freshell_codex::launch_plan::CodexSidecarLaunchContext,
}
```

Create it in one helper after `resolve_mcp_cwd` and before managed sidecar planning. The helper must generate the Codex `McpInjection` once, build the terminal base environment once, merge `mcp_injection.env` then `terminal_env` into the sidecar environment, and pass the resolved native MCP cwd as `runtime_cwd`. Its central construction is:

```rust
let mcp_injection = generate_mcp_injection(
    &RealMcpRuntime,
    "codex",
    terminal_id,
    mcp_cwd.as_deref(),
    target,
)?;
let terminal_env = build_terminal_base_env(&RealEnv, terminal_id, tab_id, pane_id);
let mut sidecar_env = mcp_injection.env.clone();
sidecar_env.extend(terminal_env.clone());
let setup = CodexManagedLaunchSetup {
    terminal_id: terminal_id.to_string(),
    runtime_cwd: mcp_cwd,
    sidecar_context: CodexSidecarLaunchContext {
        config_args: mcp_injection.args.clone(),
        env: sidecar_env,
    },
    mcp_injection,
    terminal_env,
};
```

Change `plan_codex_managed_launch` to accept the resolved sidecar cwd and context, place a clone in `CodexLaunchPlanInput`, and leave its early return untouched when managed launch is disabled or mode is not Codex. In the ordinary create path, construct this setup before calling that helper, pass its context to the sidecar plan, then use the same `mcp_injection` for `CliLaunchInputs` and the same `terminal_env` for the PTY spawn spec.

For the restore pre-gate branch, mint the terminal id before planning only when a Codex resume sidecar will be materialized, construct the same setup from the final resolved cwd and requested tab/pane identifiers, and store both setup and launch in `PreparedCodexLaunch`. `handle_create` must reuse the stored terminal id/setup rather than minting or generating a second one; its existing `Drop` implementation must still discard an unadopted sidecar on every early return. Do not change the fresh restore exclusion, queue class, cancellation behavior, or resume validation order.

In the auto-resume/recovery path, build the setup from the existing terminal id and its intentional `None` tab/pane identifiers before planning. Reuse its injection/environment for the replacement TUI and pass its sidecar context to the replacement app-server plan. Non-Codex paths retain their existing MCP construction and cleanup path unchanged.

- [ ] **Step 4: Run the focused test**

Run:

```bash
cargo test -p freshell-ws --test codex_managed_launch_e2e -- --ignored --test-threads=1
```

Expected: PASS. The fresh and resume managed legs show equal Freshell MCP config and terminal-context maps for the actual TUI and actual sidecar, the proxy relays `initialize`, and the explicit opt-out still has no `--remote`.

- [ ] **Step 5: Refactor while green**

Collapse any duplicated Codex setup construction into the one helper, keep `McpInjection` generation at the IO layer, and remove any one-off environment merging. Confirm an unprepared interactive create and a prepared restore both consume the same setup type without modifying shell, Claude, OpenCode, or survivor-reattach code.

- [ ] **Step 6: Run impacted-test verification**

The change crosses terminal creation, managed sidecar planning, lifecycle selection, recovery, and the dual-process integration harness. Run:

```bash
cargo test -p freshell-codex
cargo test -p freshell-ws
cargo test -p freshell-ws --test codex_managed_launch_e2e -- --ignored --test-threads=1
cargo check --workspace --all-targets
cargo fmt --all -- --check
```

Expected: PASS. The ignored e2e is run separately because it mutates process-global environment and uses the singleton launch manager.

- [ ] **Step 7: Commit the task**

```bash
git add -- crates/freshell-ws/src/terminal.rs crates/freshell-ws/tests/codex_managed_launch_e2e.rs
git commit -m "fix: share Codex MCP context with app server"
```

## Final Verification

After both tasks and their task-level reviews, run the workflow’s final coordinated broad gate from the clean worktree branch. Preserve the baseline ledger distinction: the base had no reproducible failures after its clean retry. Record the exact command, result, and evidence in the external run state before independent complete-delta review.
