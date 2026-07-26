//! Codex terminal-pane association controller (Lane B2): arm the
//! CodexLocator at create, feed Enter submits, and on resolution adopt the
//! identity through the shared `codex_identity::adopt_codex_identity` tail.
//! Structure mirrors `opencode_association.rs` — deliberately (spec §5-shape
//! duplication over a premature provider-generic controller). One deliberate
//! deviation: the locator's windows are ENTER-ANCHORED ONLY (no spawn
//! window) — real codex materializes its rollout only at the first user
//! prompt, so `maybe_arm` only takes the snapshot and `note_possible_submit`
//! is what opens a correlation window (async: the FIRST submit re-snapshots
//! `known_files` on the blocking pool and MUST complete before the Enter is
//! written to the PTY — see the terminal.rs seam).

use freshell_protocol::TerminalRunStatus;

use crate::terminal::now_ms;
use crate::WsState;

/// Deliberate one-line duplicate of `opencode_association::is_submit_input`
/// (itself a duplicate of `amplifier_association`'s — spec §5: "a one-liner,
/// duplication acceptable"): the input is ONLY a run of CR/LF bytes — an
/// Enter keypress, possibly repeated.
pub(crate) fn is_submit_input(data: &str) -> bool {
    !data.is_empty() && data.chars().all(|c| c == '\r' || c == '\n')
}

/// Arm the locator for a freshly-created terminal, iff it's a fresh
/// (non-resuming) `codex` pane with a resolved cwd. No-ops when the locator
/// is unavailable (`WsState::codex_locator` is `None`) or the mode isn't
/// `codex`. Arming only takes the known-files snapshot — windows are
/// Enter-anchored and open in `note_possible_submit` (see module doc). The
/// snapshot walks the sessions tree, so the caller runs this on the
/// blocking pool (see the terminal.rs arm-at-create seam).
pub(crate) fn maybe_arm(
    state: &WsState,
    terminal_id: &str,
    mode: &str,
    cwd: Option<&str>,
    resume_session_id: Option<&str>,
) {
    if mode != "codex" {
        return;
    }
    let Some(locator) = &state.codex_locator else {
        return;
    };
    locator.arm(terminal_id, mode, true, resume_session_id, cwd);
}

/// Feed a `terminal.input` write to the locator iff it's submit-shaped
/// (Enter). Async, unlike the opencode sibling: the FIRST `note_submit`
/// re-snapshots `known_files` (a bounded sessions-tree walk), so it runs on
/// the blocking pool, and the CALLER MUST AWAIT this BEFORE writing the
/// Enter to the PTY — codex materializes the rollout in response to that
/// very Enter, and a re-snapshot racing after the write could capture
/// (permanently exclude) the pane's own file. Non-submit data returns
/// immediately; later submits are a cheap mutex hop.
pub(crate) async fn note_possible_submit(state: &WsState, terminal_id: &str, data: &str) {
    if !is_submit_input(data) {
        return;
    }
    let Some(locator) = &state.codex_locator else {
        return;
    };
    let locator = std::sync::Arc::clone(locator);
    let terminal_id = terminal_id.to_string();
    let at_ms = now_ms();
    if let Err(join_error) =
        tokio::task::spawn_blocking(move || locator.note_submit(&terminal_id, at_ms)).await
    {
        tracing::warn!(
            error = %join_error,
            "codex_note_submit_panicked: blocking submit task panicked"
        );
    }
}

/// Drive one locator polling cycle and adopt every association it resolved
/// this tick through the shared `codex_identity::adopt_codex_identity` tail.
/// The tick does bounded filesystem walks + first-line reads — never on an
/// async worker (same `spawn_blocking` discipline as the opencode sweep).
pub(crate) async fn drain_and_associate(state: &WsState) {
    let Some(locator) = &state.codex_locator else {
        return;
    };
    let locator = std::sync::Arc::clone(locator);
    let now = now_ms();
    let located = match tokio::task::spawn_blocking(move || locator.tick(now)).await {
        Ok(located) => located,
        Err(join_error) => {
            tracing::warn!(
                error = %join_error,
                "codex_locator_tick_panicked: sweep tick task panicked, skipping this cycle"
            );
            return;
        }
    };
    for hit in located {
        // Defense-in-depth rejects against registry truth (mirrors
        // opencode_association.rs's drain checks): a terminal could
        // legitimately be killed between `Located` and this draining tick.
        let Some(entry) = state
            .registry
            .directory()
            .into_iter()
            .find(|e| e.terminal_id == hit.terminal_id)
        else {
            tracing::warn!(
                terminal_id = %hit.terminal_id,
                thread_id = %hit.thread_id,
                "codex_association_rejected: terminal_missing"
            );
            continue;
        };
        if entry.mode != "codex" || entry.status != TerminalRunStatus::Running {
            tracing::warn!(
                terminal_id = %hit.terminal_id,
                mode = %entry.mode,
                "codex_association_rejected: terminal_not_codex_or_not_running"
            );
            continue;
        }
        if entry.resume_session_id.is_some() {
            tracing::warn!(
                terminal_id = %hit.terminal_id,
                "codex_association_rejected: terminal_already_bound"
            );
            continue;
        }
        // The shared adoption tail (codex_identity.rs): binds both identity
        // homes, awaits the durable ledger row, broadcasts the pinned
        // associated/meta pair, and feeds the activity hub (including the
        // rollout attach for the reconcile lane).
        crate::codex_identity::adopt_codex_identity(
            state,
            crate::codex_identity::CodexAdoption {
                terminal_id: &hit.terminal_id,
                thread_id: &hit.thread_id,
                rollout_path: Some(hit.rollout_path.as_path()),
                cwd: entry.cwd.as_deref(),
            },
        )
        .await;
    }
}

/// The sweep-timer wiring (mirrors `spawn_opencode_locator_sweep`):
/// periodically drive the locator's polling cycle and process any resolved
/// associations, off the per-connection select loops.
pub fn spawn_codex_locator_sweep(state: WsState, interval: std::time::Duration) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        loop {
            ticker.tick().await;
            drain_and_associate(&state).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::now_ms;
    use crate::WsState;
    use freshell_sessions::codex_locator::CodexLocator;
    use std::sync::Arc as StdArc;

    fn state_with_locator(
        data_home: std::path::PathBuf,
    ) -> (WsState, tokio::sync::broadcast::Receiver<String>) {
        let auth_token = StdArc::new("s3cr3t-token-abcdef".to_string());
        let broadcast_tx = StdArc::new(tokio::sync::broadcast::channel::<String>(16).0);
        let rx = broadcast_tx.subscribe();
        let state = WsState {
            pane_ledger: std::sync::Arc::new(crate::pane_ledger::PaneLedger::disabled()),
            identity: crate::identity::TerminalIdentityRegistry::new(),
            auth_token: StdArc::clone(&auth_token),
            server_instance_id: StdArc::new("srv-1111".to_string()),
            boot_id: StdArc::new("boot-2222".to_string()),
            settings: StdArc::new(
                serde_json::from_value(serde_json::json!({
                    "ai": {},
                    "codingCli": { "enabledProviders": [], "mcpServer": true, "providers": {} },
                    "editor": { "externalEditor": "auto" },
                    "extensions": { "disabled": [] },
                    "freshAgent": { "defaultPlugins": [], "enabled": false, "providers": {} },
                    "logging": { "debug": false },
                    "network": { "configured": true, "host": "127.0.0.1" },
                    "panes": { "defaultNewPane": "ask" },
                    "safety": { "autoKillIdleMinutes": 15 },
                    "sidebar": {
                        "autoGenerateTitles": true,
                        "excludeFirstChatMustStart": false,
                        "excludeFirstChatSubstrings": []
                    },
                    "terminal": { "scrollback": 10000 }
                }))
                .unwrap(),
            ),
            broadcast_tx: StdArc::clone(&broadcast_tx),
            fresh_codex: freshell_freshagent::FreshCodexState::new(
                StdArc::clone(&auth_token),
                StdArc::clone(&broadcast_tx),
                serde_json::json!({ "freshAgent": { "enabled": false } }),
            ),
            fresh_claude: freshell_freshagent::FreshClaudeState::new(StdArc::clone(&broadcast_tx)),
            fresh_opencode: freshell_freshagent::FreshOpencodeState::new(
                freshell_freshagent::FreshAgentState::new(auth_token, StdArc::clone(&broadcast_tx)),
            ),
            registry: freshell_terminal::TerminalRegistry::new(),
            shutdown: StdArc::new(tokio::sync::Notify::new()),
            tabs: crate::tabs::TabsRegistry::new(),
            screenshots: crate::screenshot::ScreenshotBroker::new(broadcast_tx),
            terminals_revision: StdArc::new(std::sync::atomic::AtomicI64::new(0)),
            sessions_revision: StdArc::new(std::sync::atomic::AtomicI64::new(0)),
            cli_commands: StdArc::new(Vec::new()),
            ping_interval_ms: 30_000,
            hello_timeout_ms: 5_000,
            allowed_origins: StdArc::new(crate::origin::default_allowed_origins()),
            ws_max_payload_bytes: 16 * 1024 * 1024,
            term09: crate::backpressure::Term09Config::default(),
            create_protect: crate::create_limit::CreateProtectConfig::default(),
            spawn_gate: std::sync::Arc::new(crate::spawn_gate::SpawnGate::new(4, 64)),
            config_fallback: None,
            amplifier_locator: None,
            opencode_locator: None,
            codex_locator: Some(StdArc::new(CodexLocator::new(data_home))),
            activity: None,
            session_existence: std::sync::Arc::new(crate::existence::NoIndexProbe::default()),
        };
        (state, rx)
    }

    fn unique_temp_dir(label: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "freshell-codex-association-test-{label}-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn is_submit_input_matches_enter_only_sequences() {
        for yes in ["\r", "\n", "\r\n", "\r\r\n\n"] {
            assert!(is_submit_input(yes), "{yes:?} should be a submit");
        }
        for no in ["", "hello", "hello\r\n", "\u{1b}[A"] {
            assert!(!is_submit_input(no), "{no:?} should not be a submit");
        }
    }

    #[test]
    fn maybe_arm_arms_a_fresh_codex_terminal_and_ignores_others() {
        let dir = unique_temp_dir("assoc-arm");
        let (state, _rx) = state_with_locator(dir.clone());
        let locator = state.codex_locator.as_ref().unwrap().clone();
        maybe_arm(&state, "t1", "opencode", Some("/tmp"), None); // wrong mode
        assert_eq!(locator.armed_count(), 0);
        maybe_arm(&state, "t1", "codex", Some("/tmp"), Some("resume-id")); // resuming
        assert_eq!(locator.armed_count(), 0);
        maybe_arm(&state, "t1", "codex", Some("/tmp"), None); // fresh
        assert_eq!(locator.armed_count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn note_possible_submit_feeds_only_enter_sequences() {
        let dir = unique_temp_dir("assoc-submit");
        let (state, _rx) = state_with_locator(dir.clone());
        let locator = state.codex_locator.as_ref().unwrap().clone();
        maybe_arm(&state, "t1", "codex", Some("/tmp"), None);
        note_possible_submit(&state, "t1", "hello").await;
        // Observable proof via the locator's own seam: "hello" must not have
        // consumed the window — a direct note_submit still returns true.
        assert!(locator.note_submit("t1", now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
