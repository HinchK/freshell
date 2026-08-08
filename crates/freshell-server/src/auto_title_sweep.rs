//! Background auto-title sweep — the port of Node's per-session auto-name
//! pass (`server/index.ts:868-950`). Per session with >=1 live matching
//! terminal (`find_all_by_session`, cwd-scoped for claude): compute the sync
//! plan (`compute_session_title_sync` — dir -> first-message -> Gemini AI),
//! persist the `overridePatch` through the title-source ladder
//! (`patch_session_override`), push the canonical title to out-of-sync
//! terminals (`registry.update_title` + `terminal.title.updated` broadcast),
//! and fire ONE Gemini call per session key guarded by the in-process
//! `pending_ai_titles` set. `terminal.title.updated` is emitted ONLY from
//! this sweep and its AI-completion path (Node's two emit sites). One
//! `sessions.changed` per pass when anything changed; the AI completion
//! broadcasts its own (Node: `codingCliIndexer.refresh()` -> sessionsSync
//! publish). Only THIS background sweep honors
//! `settings.sidebar.autoGenerateTitles` — the REST generate-title route
//! (Task 6) does not.

use std::collections::HashSet;
use std::sync::atomic::AtomicI64;
use std::sync::{Arc, Mutex};

/// Everything one pass needs, shaped so tests can construct it without a
/// real server (fake Gemini transport, tempdir-backed settings, throwaway
/// registry). All fields are cheap clones (Arc-backed).
pub struct AutoTitleSweepState {
    pub settings: crate::settings_store::SettingsStore,
    pub identity: freshell_ws::identity::TerminalIdentityRegistry,
    pub registry: freshell_terminal::TerminalRegistry,
    pub broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    pub sessions_revision: Arc<AtomicI64>,
    pub ai_key: crate::ai_title::AiKeyCell,
    pub gemini: Arc<dyn crate::ai_title::GeminiTransport>,
    /// Node's module-level `pendingAiTitles` set (`server/index.ts:866`):
    /// at most ONE in-flight Gemini call per `provider:sessionId` key.
    pub pending_ai_titles: Arc<Mutex<HashSet<String>>>,
}

/// One session as the pass consumes it — decoupled from `IndexedSession` so
/// tests can inject sessions without a real index. `title` must be the
/// OVERRIDE-APPLIED session title (what `/api/session-directory` serves);
/// [`spawn_auto_title_sweep`] applies that overlay when mapping.
pub struct SweepSession {
    pub provider: String,
    pub session_id: String,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub first_user_message: Option<String>,
    /// The PARSED (pre-override) title source — only compared against
    /// `"provider-generated"` (`server/auto-title.ts:88`).
    pub title_source: Option<String>,
}

/// One of Node's two `terminal.title.updated` emit sites (the sweep push and
/// the AI-completion push both route through here) — no new WS message
/// types; the frame is the immutable `shared/ws-protocol.ts` shape.
pub fn emit_terminal_title_updated(
    tx: &tokio::sync::broadcast::Sender<String>,
    terminal_id: &str,
    title: &str,
) {
    use freshell_protocol::{ServerMessage, TerminalTitleUpdated};
    let msg = ServerMessage::TerminalTitleUpdated(TerminalTitleUpdated {
        terminal_id: terminal_id.to_string(),
        title: title.to_string(),
    });
    if let Ok(frame) = serde_json::to_string(&msg) {
        let _ = tx.send(frame);
    }
}

fn broadcast_sessions_changed(state: &AutoTitleSweepState) {
    // same shape sessions.rs:204-211 sends
    let rev = state
        .sessions_revision
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1;
    let _ = state
        .broadcast_tx
        .send(serde_json::json!({"type": "sessions.changed", "revision": rev}).to_string());
}

/// One auto-name pass over `sessions` (`server/index.ts:877-950`). Returns
/// "anything changed" (an override write or a terminal push happened).
/// Every per-session failure is non-fatal: persistence errors are
/// best-effort (matching `patch_session_override`'s own contract) and AI
/// failures log a warning inside the one-shot task.
pub async fn run_auto_title_pass(state: &AutoTitleSweepState, sessions: &[SweepSession]) -> bool {
    use crate::auto_title::{compute_session_title_sync, SessionTerminal};
    let settings = state.settings.get().await; // hoisted, like server/index.ts:878
    let ai_will_auto_name = state.ai_key.enabled() && settings.sidebar.auto_generate_titles;
    let overrides = state.settings.session_overrides(); // freshness-reloading read
    let mut changed = false;

    for s in sessions {
        // BOUNDED to live terminals only (server/index.ts:885); Node passes
        // session.cwd for the cwd-scoped claude match (index.ts:884, Task 3).
        let matching =
            state
                .identity
                .find_all_by_session(&s.provider, &s.session_id, s.cwd.as_deref());
        if matching.is_empty() {
            continue;
        }
        let key = format!("{}:{}", s.provider, s.session_id);
        let row = overrides.get(&key).and_then(|v| v.as_object());
        let override_title = row
            .and_then(|r| r.get("titleOverride"))
            .and_then(|v| v.as_str());
        let override_source = row
            .and_then(|r| r.get("titleSource"))
            .and_then(|v| v.as_str());
        // current live titles come from the registry (DirectoryEntry.title)
        let terminals: Vec<SessionTerminal> = matching
            .iter()
            .map(|t| SessionTerminal {
                terminal_id: t.terminal_id.clone(),
                title: state.registry.title_of(&t.terminal_id),
            })
            .collect();
        let plan = compute_session_title_sync(
            s.title.as_deref(),
            override_title,
            override_source,
            s.cwd.as_deref(),
            s.first_user_message.as_deref(),
            ai_will_auto_name,
            s.title_source.as_deref(),
            &terminals,
        );
        if let Some(patch) = &plan.override_patch {
            let _ = state
                .settings
                .patch_session_override(
                    &key,
                    &[
                        (
                            "titleOverride",
                            Some(serde_json::json!(patch.title_override)),
                        ),
                        ("titleSource", Some(serde_json::json!(patch.title_source))),
                    ],
                )
                .await;
            changed = true;
        }
        if let Some(canon) = &plan.canonical_title {
            for tid in &plan.terminal_ids_to_update {
                state.registry.update_title(tid, canon);
                emit_terminal_title_updated(&state.broadcast_tx, tid, canon);
                changed = true;
            }
        }
        if plan.should_generate_ai {
            if let Some(first) = s.first_user_message.clone() {
                let should_spawn = {
                    let mut pending = state.pending_ai_titles.lock().expect("pending lock");
                    pending.insert(key.clone()) // false when already in flight
                };
                if should_spawn {
                    spawn_ai_title_task(
                        state,
                        key.clone(),
                        s.provider.clone(),
                        s.session_id.clone(),
                        s.cwd.clone(),
                        first,
                        settings.ai.title_prompt.clone(),
                    );
                }
            }
        }
    }
    if changed {
        broadcast_sessions_changed(state);
    }
    changed
}

/// The Gemini one-shot (port of `server/index.ts:914-938`): generate, persist
/// `titleSource:'ai'` through the ladder, re-push + re-broadcast to the live
/// terminals, refresh the sidebar (`sessions.changed`). ALWAYS clears the
/// pending-set entry — success, empty result, or failure alike.
fn spawn_ai_title_task(
    state: &AutoTitleSweepState,
    key: String,
    provider: String,
    session_id: String,
    cwd: Option<String>,
    first_message: String,
    title_prompt: Option<String>,
) {
    let settings = state.settings.clone();
    let identity = state.identity.clone();
    let registry = state.registry.clone();
    let broadcast_tx = state.broadcast_tx.clone();
    let sessions_revision = state.sessions_revision.clone();
    let gemini = state.gemini.clone();
    let pending = state.pending_ai_titles.clone();
    tokio::spawn(async move {
        let result = crate::ai_title::generate_ai_session_title(
            &*gemini,
            &first_message,
            title_prompt.as_deref(),
        )
        .await;
        match result {
            Ok(Some(title)) => {
                let _ = settings
                    .patch_session_override(
                        &key,
                        &[
                            ("titleOverride", Some(serde_json::json!(title))),
                            ("titleSource", Some(serde_json::json!("ai"))),
                        ],
                    )
                    .await;
                // Node's AI completion re-fans-out with session.cwd too
                // (server/index.ts:914-938 uses the same cwd-scoped lookup).
                for term in identity.find_all_by_session(&provider, &session_id, cwd.as_deref()) {
                    registry.update_title(&term.terminal_id, &title);
                    emit_terminal_title_updated(&broadcast_tx, &term.terminal_id, &title);
                }
                // Node: codingCliIndexer.refresh() -> sessionsSync publish.
                let rev = sessions_revision.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                let _ = broadcast_tx.send(
                    serde_json::json!({"type": "sessions.changed", "revision": rev}).to_string(),
                );
            }
            Ok(None) => {}
            Err(e) => tracing::warn!(error = %e, key = %key, "Gemini auto-title failed"),
        }
        pending.lock().expect("pending lock").remove(&key);
    });
}

/// The background loop — same shape as `spawn_sessions_sweep` (main.rs):
/// `tokio::time::interval` with `MissedTickBehavior::Skip`; per tick,
/// snapshot the index with the SAME accessor (`SessionIndex::snapshot`),
/// map `IndexedSession` -> [`SweepSession`] (the `title` is the
/// OVERRIDE-APPLIED title: `overrides[key].titleOverride` when present,
/// else the parsed title), then [`run_auto_title_pass`].
pub fn spawn_auto_title_sweep(
    state: AutoTitleSweepState,
    index: Arc<freshell_sessions::directory_index::SessionIndex>,
    interval: std::time::Duration,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            let items = index.snapshot().await;
            let overrides = state.settings.session_overrides();
            let sessions: Vec<SweepSession> = items
                .iter()
                .map(|s| {
                    let key = s.key();
                    let title = overrides
                        .get(&key)
                        .and_then(|row| row.get("titleOverride"))
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                        .or_else(|| s.title.clone());
                    SweepSession {
                        provider: s.provider.clone(),
                        session_id: s.session_id.clone(),
                        cwd: s.cwd.clone(),
                        title,
                        first_user_message: s.first_user_message.clone(),
                        title_source: s.title_source.clone(),
                    }
                })
                .collect();
            run_auto_title_pass(&state, &sessions).await;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Registers a REAL (but throwaway) terminal in the shared
    /// `TerminalRegistry` so the canonical-title push
    /// (`registry.update_title`) has an actual entry to mutate. Copied from
    /// `sessions.rs`'s module-private helper of the same name (its doc
    /// explains why a minimal `sleep` child substitutes for the
    /// crate-private `insert_headless`).
    fn spawn_headless_terminal_for_test(
        registry: &freshell_terminal::TerminalRegistry,
        terminal_id: &str,
    ) {
        use freshell_platform::spawn::{SpawnSpec, DEFAULT_COLS, DEFAULT_ROWS};
        let spec = SpawnSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "sleep 5".into()],
            env_overrides: Default::default(),
            cwd: None,
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
        };
        registry
            .create(
                &spec,
                &std::collections::BTreeMap::new(),
                terminal_id.to_string(),
                "stream-test".to_string(),
                "shell",
                None,
                None,
                None,
            )
            .expect("spawn headless test terminal");
    }

    fn sweep_state(
        dir: &std::path::Path,
        ai_key: Option<&str>,
    ) -> (
        AutoTitleSweepState,
        tokio::sync::broadcast::Receiver<String>,
    ) {
        let settings = crate::settings_store::SettingsStore::load(Some(dir), vec![]);
        let (tx, rx) = tokio::sync::broadcast::channel::<String>(64);
        let state = AutoTitleSweepState {
            settings,
            identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
            registry: freshell_terminal::TerminalRegistry::new(),
            broadcast_tx: std::sync::Arc::new(tx),
            sessions_revision: std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0)),
            ai_key: crate::ai_title::AiKeyCell::init(ai_key.map(str::to_string), None),
            gemini: std::sync::Arc::new(FakeGemini(Ok("AI Title".into()))),
            pending_ai_titles: Default::default(),
        };
        (state, rx)
    }
    struct FakeGemini(Result<String, String>);
    impl crate::ai_title::GeminiTransport for FakeGemini {
        fn generate_content(
            &self,
            _p: String,
            _m: u32,
        ) -> crate::ai_title::BoxFuture<Result<String, String>> {
            let r = self.0.clone();
            Box::pin(async move { r })
        }
    }
    fn session(provider: &str, id: &str, cwd: &str, first: Option<&str>) -> SweepSession {
        SweepSession {
            provider: provider.into(),
            session_id: id.into(),
            cwd: Some(cwd.into()),
            title: None,
            first_user_message: first.map(str::to_string),
            title_source: None,
        }
    }

    #[tokio::test]
    async fn session_without_live_terminal_is_skipped_entirely() {
        let dir = tempfile::tempdir().unwrap();
        let (state, _rx) = sweep_state(dir.path(), None);
        let changed =
            run_auto_title_pass(&state, &[session("claude", "s1", "/x/proj", Some("hi"))]).await;
        assert!(!changed);
        assert!(state
            .settings
            .session_overrides()
            .get("claude:s1")
            .is_none());
    }

    #[tokio::test]
    async fn no_key_first_message_finalizes_and_pushes_terminal_title_with_broadcast() {
        let dir = tempfile::tempdir().unwrap();
        let (state, mut rx) = sweep_state(dir.path(), None);
        let tid = "term-1";
        spawn_headless_terminal_for_test(&state.registry, tid);
        state
            .identity
            .upsert(tid, Some("claude"), Some("s1"), Some("/x/proj"), 1);
        let changed = run_auto_title_pass(
            &state,
            &[session(
                "claude",
                "s1",
                "/x/proj",
                Some("Fix the flux\nrest"),
            )],
        )
        .await;
        assert!(changed);
        let ov = state.settings.session_overrides();
        let row = ov.get("claude:s1").unwrap();
        assert_eq!(row["titleOverride"], "Fix the flux");
        assert_eq!(row["titleSource"], "first-message");
        // terminal push + broadcast frame
        let mut saw_title_updated = false;
        let mut saw_sessions_changed = false;
        while let Ok(frame) = rx.try_recv() {
            let v: serde_json::Value = serde_json::from_str(&frame).unwrap();
            if v["type"] == "terminal.title.updated" {
                assert_eq!(v["terminalId"], json!(tid));
                assert_eq!(v["title"], "Fix the flux");
                saw_title_updated = true;
            }
            if v["type"] == "sessions.changed" {
                saw_sessions_changed = true;
            }
        }
        assert!(saw_title_updated && saw_sessions_changed);
    }

    #[tokio::test]
    async fn ai_enabled_holds_dir_then_finalizes_ai_exactly_once() {
        let dir = tempfile::tempdir().unwrap();
        let (state, _rx) = sweep_state(dir.path(), Some("key"));
        let tid = "term-1";
        spawn_headless_terminal_for_test(&state.registry, tid);
        state
            .identity
            .upsert(tid, Some("claude"), Some("s1"), Some("/x/proj"), 1);
        let s = [session("claude", "s1", "/x/proj", Some("Fix the flux"))];
        run_auto_title_pass(&state, &s).await;
        // pass 1: dir placeholder persisted (never first-message when AI on)
        let row = state
            .settings
            .session_overrides()
            .get("claude:s1")
            .cloned()
            .unwrap();
        assert_eq!(row["titleSource"], "dir");
        // AI one-shot lands asynchronously; wait for it
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            let row = state
                .settings
                .session_overrides()
                .get("claude:s1")
                .cloned()
                .unwrap();
            if row["titleSource"] == "ai" {
                break;
            }
        }
        let row = state
            .settings
            .session_overrides()
            .get("claude:s1")
            .cloned()
            .unwrap();
        assert_eq!(row["titleOverride"], "AI Title");
        assert_eq!(row["titleSource"], "ai");
        // a second pass with the AI title already finalized changes nothing
        assert!(state.pending_ai_titles.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn user_rename_is_never_clobbered_and_sweep_pushes_it_to_stale_terminals() {
        let dir = tempfile::tempdir().unwrap();
        let (state, mut rx) = sweep_state(dir.path(), None);
        let tid = "term-1";
        spawn_headless_terminal_for_test(&state.registry, tid);
        state
            .identity
            .upsert(tid, Some("claude"), Some("s1"), Some("/x/proj"), 1);
        state
            .settings
            .patch_session_override(
                "claude:s1",
                &[
                    ("titleOverride", Some(json!("My Name"))),
                    ("titleSource", Some(json!("user"))),
                ],
            )
            .await;
        let mut s = session("claude", "s1", "/x/proj", Some("hi"));
        s.title = Some("My Name".into()); // override-applied session title
        run_auto_title_pass(&state, &[s]).await;
        let row = state
            .settings
            .session_overrides()
            .get("claude:s1")
            .cloned()
            .unwrap();
        assert_eq!(row["titleOverride"], "My Name"); // untouched
                                                     // canonical push to the stale terminal still happens
        let frames: Vec<String> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
        assert!(frames
            .iter()
            .any(|f| f.contains("terminal.title.updated") && f.contains("My Name")));
    }

    #[tokio::test]
    async fn autogenerate_titles_off_disables_ai_but_keeps_heuristics() {
        let dir = tempfile::tempdir().unwrap();
        let (state, _rx) = sweep_state(dir.path(), Some("key"));
        state
            .settings
            .patch(&json!({"sidebar": {"autoGenerateTitles": false}}))
            .await
            .unwrap();
        let tid = "term-1";
        spawn_headless_terminal_for_test(&state.registry, tid);
        state
            .identity
            .upsert(tid, Some("claude"), Some("s1"), Some("/x/proj"), 1);
        run_auto_title_pass(
            &state,
            &[session("claude", "s1", "/x/proj", Some("Fix it"))],
        )
        .await;
        let row = state
            .settings
            .session_overrides()
            .get("claude:s1")
            .cloned()
            .unwrap();
        assert_eq!(row["titleSource"], "first-message"); // heuristic path, no Gemini
        assert!(state.pending_ai_titles.lock().unwrap().is_empty());
    }
}
