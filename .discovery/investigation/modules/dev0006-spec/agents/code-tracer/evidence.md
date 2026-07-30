# DEV-0006 spec — Code-Tracer raw evidence

All excerpts from /home/dan/code/freshell working tree (branch main, HEAD 5bf73dbb), 2026-07-30.
Line numbers = working tree (`sed -n`/`grep -n` output).

## Uncommitted-diff hunks (git diff)

```
crates/freshell-ws/src/terminal.rs:      @@ -3862,18 +3862,12 @@  handle_auto_resume_cancel
                                         @@ -3927,6 +3921,16 @@   kill_and_broadcast
crates/freshell-freshagent/src/terminal_tabs.rs:  @@ -34,8 +34,7 @@ (imports)
                                         @@ -592,23 +591,12 @@  spawn_gate_error_response (net −11 lines)
crates/freshell-ws/src/lib.rs:           @@ -48,6 +48,18 @@  (adds pub(crate) fn env_parse)
                                         @@ -109,7 +121,10 @@ (auto_resume_cancels doc comment)
```
None of these hunks touch the codex managed-launch regions cited in findings.md, but
terminal_tabs.rs numbers below line ~600 differ by ~+11 in the committed state.

## Slice 1

```
remote_proxy_envelope.rs:27  pub const MAX_FULL_PARSE_BYTES: usize = 1024 * 1024;
remote_proxy_envelope.rs:31  pub const MAX_RAW_FORWARD_BYTES: usize = 64 * 1024 * 1024;
remote_proxy_envelope.rs:88  pub fn scan_json_rpc_envelope(input: &[u8]) -> ScanResult {
remote_proxy_envelope.rs:261 mod tests {

remote_proxy_side_effects.rs:356 pub fn extract_thread_start_response_candidate(
remote_proxy_side_effects.rs:382 pub fn extract_fork_response_candidate(
remote_proxy_side_effects.rs:454 pub fn extract_thread_started_notification_side_effects(
remote_proxy_side_effects.rs:494 pub fn extract_turn_notification_event(raw: &[u8]) -> SideEffectResult<TurnEvent> {
remote_proxy_side_effects.rs:559 pub fn extract_thread_lifecycle_event(raw: &[u8]) -> SideEffectResult<ThreadLifecycleEvent> {
remote_proxy_side_effects.rs:612 pub fn extract_fs_changed_repair_trigger(raw: &[u8]) -> SideEffectResult<FsChangedRepairTrigger> {
remote_proxy_side_effects.rs:667 pub fn rewrite_thread_fork_request_exclude_turns(raw: &[u8]) -> SideEffectResult<Vec<u8>> {
remote_proxy_side_effects.rs:726 pub fn normalize_thread_fork_response_for_tui(raw: &[u8]) -> SideEffectResult<Vec<u8>> {
remote_proxy_side_effects.rs:781 mod tests {

json_scan.rs:1-12  "Shared low-level byte-scanning primitives ... faithful merge of the two
  independent byte-scanning engines hand-rolled in json-rpc-envelope.ts and
  json-rpc-side-effects.ts ... preserves [the number-token bounding difference] via
  skip_value's max_number_token_bytes parameter."
```

## Slice 2 — remote_proxy.rs

```
:93   pub struct CodexRemoteProxyOptions {
:107  pub fn new(upstream_ws_url: impl Into<String>, require_candidate_persistence: bool)
:185  pub enum RemoteProxyEvent {
        Candidate(RemoteProxyCandidate), ThreadStarted(...), ThreadLifecycle(...),
        ThreadLifecycleLoss(...), TurnStarted(TurnEventParams), TurnCompleted(TurnEventParams),
        RepairTrigger(RemoteProxyRepairTrigger) }
:175-183 doc: "Mirrors the six `on*` handler sets in remote-proxy.ts:126-131 ... collapsed
        into one ordered stream rather than six separate closure-registration APIs"
:199  pub struct CodexRemoteProxy {
:211  pub async fn start( ... ) -> Result<(Self, mpsc::UnboundedReceiver<RemoteProxyEvent>), ProxyStartError>
:258  pub fn ws_url(&self) -> &str
:265  pub fn require_candidate_persistence(&self) -> bool
:272  pub async fn close(self)
:593-633  hub.emit(RemoteProxyEvent::RepairTrigger(...)) (ProxyClose/ProxyError/FsChanged)
:1352 mod tests {
tests/remote_proxy_relay.rs: 17 #[test]/#[tokio::test] fns
```

## Slice 3

```
launch_plan.rs:33  pub const CODEX_MANAGED_REMOTE_CONFIG_ARGS: [&str; 2] = ["-c", "features.apps=false"];
launch_plan.rs:36  pub const CODEX_INITIAL_LAUNCH_ATTEMPTS: u32 = 5;
launch_plan.rs:59  pub const FRESHELL_CODEX_MANAGED_LAUNCH_ENV: &str = "FRESHELL_CODEX_MANAGED_LAUNCH";
launch_plan.rs:64  pub fn codex_managed_launch_enabled(value: Option<&str>) -> bool { value == Some("1") }
launch_plan.rs:154 pub fn get_codex_session_binding_reason(
launch_plan.rs:183 pub struct CodexLaunchPlan {
launch_plan.rs:186   pub session_id: Option<String>,
launch_plan.rs:188   pub binding_reason: CodexSessionBindingReason,
launch_plan.rs:193   pub proxy_required: bool,
launch_plan.rs:197   pub require_candidate_persistence: bool,
launch_plan.rs:211 pub fn plan_codex_launch(
launch_plan.rs:216-222  binding_reason = Resume if resume_session_id (non-empty) else Start
launch_plan.rs:261 pub fn codex_remote_args(proxy_ws_url: &str) -> Result<[String; 4], ...>
launch_plan.rs:321 pub fn codex_sidecar_spawn_spec(listen_ws_url: &str, ownership_id: &str)
launch_plan.rs:357 pub fn plan_codex_launch_retry(
launch_plan.rs:374 mod tests {

launch_lifecycle.rs:134 pub struct CodexLaunchSidecar {
launch_lifecycle.rs:167   pub async fn adopt(&self, terminal_id: &str, generation: u64) -> Result<(), String>
launch_lifecycle.rs:180   pub async fn shutdown(&self) -> Result<(), String>
launch_lifecycle.rs:202 pub struct CodexTerminalLaunch {
   "A planned + started codex terminal launch ... plus the S3 pure plan (binding reason etc.
    for the S5 consumers) and the proxy's event stream (durability candidates / turn events —
    unconsumed until S5; hold it so the proxy's senders stay connected)."
   fields: session_id, remote_ws_url, plan: CodexLaunchPlan, sidecar: Arc<CodexLaunchSidecar>,
           events: mpsc::UnboundedReceiver<RemoteProxyEvent>
launch_lifecycle.rs:228 pub struct CodexLaunchPlanner {
launch_lifecycle.rs:259   pub async fn plan_create(
launch_lifecycle.rs:327   pub async fn plan_create_with_retry(
launch_lifecycle.rs:358   pub async fn shutdown(&self)
tests/launch_lifecycle.rs: 16 test fns
```

## Slice 4

```
launch_lifecycle.rs:382 pub struct CodexTerminalLaunchManager {
launch_lifecycle.rs:399   pub fn global() -> &'static CodexTerminalLaunchManager {
                            static GLOBAL: OnceLock<CodexTerminalLaunchManager> = OnceLock::new();
                            ... SpawnedCodexAppServerRuntime::new() ... }
launch_lifecycle.rs:410   pub async fn plan_create_with_retry(...)
launch_lifecycle.rs:423   pub async fn adopt(&self, terminal_id, launch, generation)
launch_lifecycle.rs:428-435  self.adopted.lock().unwrap().insert(terminal_id,
                              AdoptedTerminalLaunch { sidecar: launch.sidecar, _events: launch.events })
launch_lifecycle.rs:443   pub async fn discard(&self, launch: CodexTerminalLaunch)
launch_lifecycle.rs:450   pub fn notify_terminal_exit(&self, terminal_id: &str)
launch_lifecycle.rs:465   pub async fn shutdown(&self)
launch_lifecycle.rs:504 pub struct SpawnedCodexAppServerRuntime {
launch_lifecycle.rs:375   _events: mpsc::UnboundedReceiver<RemoteProxyEvent>,   // AdoptedTerminalLaunch

terminal.rs:1036-1042 /// DEV-0006 S4 gate (council fence: FLAG-GATED, default OFF)...
                      fn codex_create_uses_managed_launch(mode, flag_value) ->
                        mode == "codex" && freshell_codex::launch_plan::codex_managed_launch_enabled(flag_value)
terminal.rs:1106 async fn plan_codex_managed_launch(
terminal.rs:1113   std::env::var(freshell_codex::launch_plan::FRESHELL_CODEX_MANAGED_LAUNCH_ENV).ok();
terminal.rs:1135   CodexTerminalLaunchManager::global()   (plan call)
terminal.rs:2004-2030  handle_create codex branch ("plan the managed app-server launch
                       (planCodexLaunch, ws:2442-2449 ...) ... Flag OFF: today's plain-CLI launch,
                       byte-identical to the shipped deviation shape (golden G-X0)")
terminal.rs:2031-2032  let codex_remote_ws_url: Option<String> =
                           codex_launch.as_ref().map(|l| l.remote_ws_url.clone());
terminal.rs:2088       codex_remote_ws_url: codex_remote_ws_url.as_deref(),   (CliLaunchInputs)
terminal.rs:2332-2336  failed-spawn: CodexTerminalLaunchManager::global().discard(launch).await
terminal.rs:2375-2384  adopt: ...global().adopt(&terminal_id, launch, 0).await; on Err → registry.kill
terminal.rs:1333-1337  exit hook: "DEV-0006 S4: tear down this pane's managed codex sidecar +
                       remote proxy ... .notify_terminal_exit(&terminal_id);"
terminal.rs:2925-2929, 2978-2988  auto-resume respawn seam: same discard/adopt wiring

terminal_tabs.rs:524-532  DEV-0006 S4 gate, REST side ... fn codex_create_uses_managed_launch (:530)
terminal_tabs.rs:570      fn codex_launch_error_response(
terminal_tabs.rs:1271-1278 D-C-REVISIT(FRESHELL_CODEX_MANAGED_LAUNCH): ~226s permit-hold note
terminal_tabs.rs:1288-1311 managed_flag = std::env::var(...FRESHELL_CODEX_MANAGED_LAUNCH_ENV)...
                           CodexTerminalLaunchManager::global().plan_create_with_retry(&input,
                             CODEX_INITIAL_LAUNCH_ATTEMPTS)
terminal_tabs.rs:1313-1320 resumeSessionId ECHO (router.ts:177) via codex_effective_resume_session_id (fn :621)
terminal_tabs.rs:1346-1352 permission_mode/model/sandbox stripped when managed_codex
terminal_tabs.rs:1353-1358 codex_remote_ws_url: codex_launch.as_ref().map(|l| l.remote_ws_url.as_str())
terminal_tabs.rs:1445-1450 exit hook notify_terminal_exit
terminal_tabs.rs:1565-1572 failed create: discard ("cleanupUnadoptedCodexLaunch, router.ts:445")
terminal_tabs.rs:1585-1596 adopt ("router.ts:254,1591"); Err → kill + 500

crates/freshell-server/src/main.rs:1197-1206
  // DEV-0006 S4: stop accepting codex managed-launch plans and tear down every
  // launch sidecar + remote proxy ... (mirrors legacy's close-time codexLaunchPlanner.shutdown()
  // among the shutdown owners, server/index.ts:981-1049). Runs AFTER registry.kill_all() ...
  freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global().shutdown().await;

crates/freshell-ws/tests/codex_managed_launch_e2e.rs  (358 lines)
:4   //! - **Flag ON** (`FRESHELL_CODEX_MANAGED_LAUNCH=1`): the first four argv tokens are ...
:260 #[ignore = "host-gated e2e (needs node + repo node_modules); mutates process env — run
     alone with --ignored --test-threads=1"]
:301 std::env::set_var("FRESHELL_CODEX_MANAGED_LAUNCH", "1");
```

## Goldens (cli_launch_goldens.rs)

```
:260-286  /// G-X1 — codex, linux, live path, fresh.  fn g_x1_codex_live_fresh (:262)
          asserts args start ["--remote","ws://127.0.0.1:45012/codex","-c","features.apps=false", ...]
:288-307  fn g_x2_codex_live_resume (:290) — G-X1 args + ["resume","thread-abc123"] last
:311      fn g_x3_codex_no_app_server_model_sandbox
:607-639  fn g_w2_codex_ws_url_validation (:609) — two loopback-validation messages
:731-758  /// G-X0 — the ACTUAL SHIPPED codex live-path argv under deviation DEV-0006 ...
          fn g_x0_codex_shipped_deviation_shape_dev_0006 (:738): args are bel pair + notif +
          MCP TOML ONLY (no --remote), env empty. Doc: "When the codex app-server plan is wired
          into terminal.create, this golden is REPLACED by G-X1 as the live-path shape."
```

## binding_reason consumers

```
grep -rn "session_binding_reason|sessionBindingReason|binding_reason" crates/ (non-test):
  crates/freshell-platform/src/cli_launch.rs:84   (doc comment only, about claude)
  crates/freshell-codex/src/launch_plan.rs:*      (producer + its own tests)
  → nothing in freshell-ws / freshell-freshagent / freshell-terminal.
Legacy consumers:
  server/ws-handler.ts:2587   ? getCodexSessionBindingReason(m.mode, requestedCodexResumeSessionId)
  server/agent-api/router.ts:742, 1183, 1340, 1577
```

## S5 / DEV-0008 state

```
crates/freshell-ws/src/codex_identity.rs:1-5
  "Shared codex identity adoption tail ... Extracted from the retired client candidate
   channel (codex_candidate.rs, campaign §2.3.2) and now owned solely by the server-side
   rollout locator."
codex_identity.rs:60   pub(crate) async fn adopt_codex_identity(state, a: CodexAdoption)
codex_identity.rs:229-260  fans terminal.session.associated + TerminalMetaUpdated (:258)
crates/freshell-ws/src/lib.rs:296-306  WsState.codex_locator ("Lane B2 ... correlates a fresh
  codex PTY's first Enter with the new rollout JSONL")
crates/freshell-ws/src/lib.rs:307-313  WsState.activity (TERM-15/16 activity hub)
crates/freshell-activity/src/lib.rs:14
  "| [`codex`] | `server/coding-cli/codex-activity-tracker.ts` (PTY lane) |"
crates/freshell-protocol/src/server_messages.rs:121-122  #[serde(rename="terminal.meta.updated")]
crates/freshell-ws/src/terminal.rs:3256-3262  broadcast helper ("ws-handler.ts:3682-3695" citation);
  :3198 DEV-0008 comment; :4939-5116 create-time slice
tests: codex_candidate_inert.rs ("terminal.codex.candidate.persisted is RETIRED as a writer"),
  codex_session_ref_resume.rs, codex_locator_activity.rs, codex_fork_rebind.rs

Legacy: server/coding-cli/codex-activity-tracker.ts exists (21,100 bytes, mtime Jul 8)
server/ws-handler.ts:3842  broadcastTerminalMetaUpdated(msg: { upsert?; remove? })
```

## spawn_sidecar duplication

```
codex.rs:79    const CODEX_MANAGED_CONFIG_ARGS: &[&str] = &["-c", "features.apps=false"];
codex.rs:1959  async fn spawn_sidecar( ... )
codex.rs:1986-2000  builds its own tokio::process::Command; cmd.args(CODEX_MANAGED_CONFIG_ARGS);
                    cmd.args(["app-server", "--listen", &ws_url]); env(CODEX_SIDECAR_OWNERSHIP_ENV,...)
grep SpawnedCodexAppServerRuntime|codex_sidecar_spawn_spec in codex.rs → 0 hits.
```

## Raw resume

```
terminal_tabs.rs:65   const INVALID_RAW_CODEX_RESUME_MESSAGE: &str = "Restore requires sessionRef;
                      resumeSessionId is a legacy field and cannot be used as restore identity.";
terminal_tabs.rs:117-135  fn requested_resume_session_id_for_mode → Err(...) for codex raw legacy id (:127-131)
terminal_tabs.rs:491-509  derive_resume_identity calls it (:503-507)
terminal.rs: no INVALID_RAW_CODEX_RESUME occurrences.
terminal.rs:1668-1682  codex resume id = requested_ref.session_id, falling back to
                       create.resume_session_id (raw accept), non-empty filter.
```

## Legacy anchor spot-checks (server/ on main)

```
codex-launch-config.ts:22-28   export function getCodexSessionBindingReason(...)   [VALID]
codex-managed-config.ts:1-4    CODEX_MANAGED_REMOTE_CONFIG_ARGS = ['-c','features.apps=false']  [VALID]
restore-decision.ts:32 planCodexCreateRestoreDecision; :67-76 resolveCodexCreateRestoreDecision  [VALID]
launch-planner.ts:107 class CodexLaunchPlanner; :125 async planCreate; :177 async shutdown;
  :227 'cannot be adopted' guard; :236 adopt handler  [VALID approx]
remote-proxy.ts 52,046 bytes; json-rpc-envelope.ts 20,775; json-rpc-side-effects.ts 36,071
ws-handler.ts:970 private async planCodexLaunch(; :986 planCodexLaunchWithRetry({   [was 928-950]
ws-handler.ts:2528 requestedCodexResumeSessionId; :2533 await this.planCodexLaunch(; 
  :2540 pendingCodexPlan; :2587 getCodexSessionBindingReason; :2601 codexPlan.sidecar.adopt;
  :2605 publishCodexSidecar   [was 2438-2519]
router.ts:161-193 plan wiring; :737,:742; :1175; :1335; :1572-1585 (:1577 binding)  [VALID]
terminal-registry.ts:305-317 codexAppServer branch; :316 remoteArgs.push('--remote', wsUrl, ...)  [was 295-307]
index.ts:366 getCodexDisplayIdSecret; :368 displayIdSecret  [was 322-326]
index.ts:403 new CodexLaunchPlanner(() => new CodexAppServerRuntime({serverInstanceId}))  [was 359-365]
```

## DEVIATIONS.md / coding-cli.md

```
DEVIATIONS.md:517  ### DEV-0006 — codex terminal panes launch WITHOUT the --remote ... pair
DEVIATIONS.md:526  - closure_progress (2026-07-22, DEV-0006 S4, commits d5d6e423 + inc.2): ...
                   FLAG-GATED, default OFF (FRESHELL_CODEX_MANAGED_LAUNCH=1) ... S5 ... CLOSE this record;
                   G-X0 is retired for G-X1 at that flip, not before.
DEVIATIONS.md:527  - status: accepted (open gap, tracked for closure — mechanism landed dark ...)
DEVIATIONS.md:588  ### DEV-0008 — terminal.meta.updated push subsystem ... left unported ...
DEVIATIONS.md:609  ... PARTIAL port (create-upsert/exit-remove only) was REJECTED by council ...
DEVIATIONS.md:644-646  same tracked remaining-work item as DEV-0006's closure ...
DEVIATIONS.md:652-653  - status: accepted (terminals.changed parity CLOSED; terminal.meta.updated
                   open gap, tracked for closure with DEV-0006)
port/machine/specs/coding-cli.md:380  ### 4e. Launch planning / recovery (terminal-mode codex, ...)
```
