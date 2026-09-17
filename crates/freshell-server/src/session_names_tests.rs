//! Store behavior tests for the durable name authority (plan Task 1).
//!
//! Every test drives REAL temp-file service methods through the strict
//! transaction path — including a two-real-process `cross_process_transactions`
//! run that re-executes this exact test selector in child roles. Destructive
//! process death is deliberately NOT here (Task 8's container case).

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use freshell_freshagent::naming::{NameActivityReason, NativeNameOrigin};
use freshell_protocol::native_location::{NativeEvidenceKind, NativePersistence};
use freshell_protocol::session_names::{NameIntent, NameSource, NamedProvider};
use serde_json::{json, Value};

use super::*;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn temp_data_dir() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

fn open_store(dir: &Path) -> Arc<SessionNames> {
    SessionNames::open(dir.to_path_buf()).expect("open store")
}

fn pending(id: &str) -> SessionNameRef {
    SessionNameRef::Pending { id: id.to_string() }
}

fn session(provider: NamedProvider, id: &str) -> SessionNameRef {
    SessionNameRef::Session {
        provider,
        session_id: id.to_string(),
    }
}

async fn ensure(
    store: &Arc<SessionNames>,
    handle: &str,
    provider: NamedProvider,
    cwd: Option<&str>,
) -> Result<SessionNameUpdate, NameError> {
    store
        .ensure_pending(PendingNameInput {
            handle: handle.to_string(),
            provider,
            cwd: cwd.map(str::to_string),
        })
        .await
}

async fn rename_user(
    store: &Arc<SessionNames>,
    target: SessionNameRef,
    name: &str,
) -> Result<SessionNameUpdate, NameError> {
    store
        .rename(RenameNameInput {
            target,
            name: name.to_string(),
            intent: NameIntent::User,
            if_revision: None,
        })
        .await
}

async fn rename_user_cas(
    store: &Arc<SessionNames>,
    target: SessionNameRef,
    name: &str,
    if_revision: NameRevision,
) -> Result<SessionNameUpdate, NameError> {
    store
        .rename(RenameNameInput {
            target,
            name: name.to_string(),
            intent: NameIntent::User,
            if_revision: Some(if_revision),
        })
        .await
}

async fn rename_automatic(
    store: &Arc<SessionNames>,
    target: SessionNameRef,
    name: &str,
) -> Result<SessionNameUpdate, NameError> {
    store
        .rename(RenameNameInput {
            target,
            name: name.to_string(),
            intent: NameIntent::Automatic,
            if_revision: None,
        })
        .await
}

async fn get_one(store: &Arc<SessionNames>, target: SessionNameRef) -> Option<SessionNameUpdate> {
    let updates = store.get(vec![target]).await.expect("get succeeds");
    updates.into_iter().next()
}

async fn activity(
    store: &Arc<SessionNames>,
    target: SessionNameRef,
    event_id: &str,
    reason: NameActivityReason,
    first_user_message: Option<&str>,
) -> Result<SessionNameUpdate, NameError> {
    store
        .activity(NameActivity {
            target,
            mode: "claude".to_string(),
            event_id: event_id.to_string(),
            reason,
            first_user_message: first_user_message.map(str::to_string),
            cwd: None,
        })
        .await
}

fn claude_acquisition(config_root: &str, persistence: NativePersistence) -> NativeAcquisition {
    NativeAcquisition {
        location: NativeLocation::Claude {
            config_root: config_root.to_string(),
            transcript_path: Some(format!("{config_root}/projects/R/0192.jsonl")),
            project_directory_key: Some("R".to_string()),
            transcript_cwd: Some("/w/proj".to_string()),
            effective_project_key_override: None,
        },
        evidence: NativeEvidenceKind::SelectedTranscript,
        persistence,
    }
}

fn codex_acquisition(codex_home: &str, persistence: NativePersistence) -> NativeAcquisition {
    NativeAcquisition {
        location: NativeLocation::Codex {
            codex_home: codex_home.to_string(),
            native_thread_id: Some("thread_1".to_string()),
            rollout_path: Some(format!("{codex_home}/rollout-1.jsonl")),
            persistence_evidence: Some("thread_started_notification".to_string()),
        },
        evidence: NativeEvidenceKind::InitializedRuntime,
        persistence,
    }
}

fn observe(
    target: SessionNameRef,
    title: &str,
    origin: NativeNameOrigin,
    location_revision: NameRevision,
) -> NativeNameObservation {
    NativeNameObservation {
        target,
        title: title.to_string(),
        origin,
        location_revision,
        event_id: None,
    }
}

fn read_raw_document(dir: &Path) -> StoredDocument {
    let bytes = std::fs::read(dir.join(DOCUMENT_FILE_NAME)).expect("raw document exists");
    parse_document(&bytes).expect("raw document parses")
}

/// Bypass helper for corruption fixtures: serialize and write a raw document
/// UNDER the sidecar lock, mirroring the strict path's discipline.
fn write_raw_document(dir: &Path, document: &StoredDocument) {
    let bytes = serialize_document(document).expect("serialize raw document");
    write_raw_document_bytes(dir, &bytes);
}

/// Bypass helper writing EXACT raw bytes (restore fixtures) UNDER the
/// sidecar lock, mirroring the strict path's discipline.
fn write_raw_document_bytes(dir: &Path, bytes: &[u8]) {
    let lock = open_lock_file(&dir.join(LOCK_FILE_NAME)).expect("open lock for raw write");
    lock.try_lock().expect("lock for raw write");
    std::fs::write(dir.join(DOCUMENT_FILE_NAME), bytes).expect("write raw document");
}

/// The contract rank order (independent of the implementation's helper).
fn contract_rank(source: NameSource) -> u8 {
    match source {
        NameSource::Directory => 0,
        NameSource::FirstMessage => 1,
        NameSource::ProviderAi => 2,
        NameSource::FreshellAi => 3,
        NameSource::LegacyProtected => 4,
        NameSource::Manual => 5,
    }
}

// ---------------------------------------------------------------------------
// The five named store tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn manual_survives_reload_and_ai_race() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = pending("h-manual");
    let ensured = ensure(&store, "h-manual", NamedProvider::Claude, Some("/w/myproj"))
        .await
        .expect("ensure pending");
    assert_eq!(ensured.record.name, "myproj");
    assert_eq!(ensured.record.source, NameSource::Directory);

    let renamed = rename_user(&store, target.clone(), "Ship it")
        .await
        .expect("rename");
    assert_eq!(renamed.record.name, "Ship it");
    assert_eq!(renamed.record.source, NameSource::Manual);
    assert!(renamed.record.renamed_at.is_some());
    assert_eq!(
        renamed.record.manual_revision,
        Some(renamed.record.revision)
    );

    // Late Freshell AI output loses to the committed manual name.
    let ai = store
        .offer(
            target.clone(),
            "AI idea".to_string(),
            NameSource::FreshellAi,
        )
        .await
        .expect("offer runs");
    assert!(!ai.changed, "AI cannot override a manual name");
    assert_eq!(ai.record.name, "Ship it");
    assert_eq!(ai.record.source, NameSource::Manual);
    assert_eq!(ai.record.revision, renamed.record.revision);

    // Same race through the completion seam: a late generation answer can
    // never land on a protected record (no series exists for it).
    let late = store
        .complete_generation(
            target.clone(),
            "bogus-series".to_string(),
            "Late AI".to_string(),
        )
        .await;
    assert!(
        matches!(late, Err(NameError::NotFound(_))),
        "a manual record has no generation series to complete"
    );

    // An automatic agent suggestion stays provider_ai rank and cannot freeze.
    let suggestion = rename_automatic(&store, target.clone(), "Agent suggestion")
        .await
        .expect("automatic rename runs");
    assert!(!suggestion.changed);

    // Reload: a second store instance reads the ACTUAL file and keeps the
    // manual name, revision and metadata.
    let reloaded = open_store(dir.path());
    let from_file = get_one(&reloaded, target.clone())
        .await
        .expect("record survives");
    assert_eq!(from_file.record.name, "Ship it");
    assert_eq!(from_file.record.source, NameSource::Manual);
    assert_eq!(from_file.record.revision, renamed.record.revision);
    assert!(from_file.record.renamed_at.is_some());

    // The reload assertion reads the persisted bytes themselves.
    let raw = read_raw_document(dir.path());
    let stored = raw
        .records
        .get(&name_ref_key(&target))
        .expect("raw record present");
    assert_eq!(stored.name, "Ship it");
    assert_eq!(stored.source, NameSource::Manual);
}

#[tokio::test]
async fn pending_bind_is_atomic_and_keeps_manual_name() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let handle = pending("h-bind");
    ensure(&store, "h-bind", NamedProvider::Claude, Some("/w/bind"))
        .await
        .expect("ensure pending");
    rename_user(&store, handle.clone(), "Fix auth")
        .await
        .expect("manual pre-bind rename");

    let before = read_raw_document(dir.path()).document_generation;

    // Prospective evidence must never authorize binding.
    let prospective = store
        .bind_pending(BindNameInput {
            pending: handle.clone(),
            target: session(NamedProvider::Claude, "ses_1:2:3"),
            acquisition: claude_acquisition("/w/homes/claude", NativePersistence::Prospective),
        })
        .await;
    assert!(
        matches!(prospective, Err(NameError::IdentityAmbiguous(_))),
        "prospective bind evidence is rejected"
    );

    let bound = store
        .bind_pending(BindNameInput {
            pending: handle.clone(),
            target: session(NamedProvider::Claude, "ses_1:2:3"),
            acquisition: claude_acquisition("/w/homes/claude", NativePersistence::Verified),
        })
        .await
        .expect("bind pending");
    let session_key = name_ref_key(&session(NamedProvider::Claude, "ses_1:2:3"));

    // The manual name, its rename metadata and its rank transfer atomically.
    assert_eq!(
        bound.record.name_ref,
        session(NamedProvider::Claude, "ses_1:2:3")
    );
    assert_eq!(bound.record.name, "Fix auth");
    assert_eq!(bound.record.source, NameSource::Manual);
    assert!(bound.changed);
    assert!(
        bound.record.revision > 2,
        "binding allocates a fresh revision"
    );
    assert_eq!(bound.record.manual_revision, Some(2));
    assert!(bound.record.renamed_at.is_some());
    assert_eq!(bound.redirects.len(), 1);
    assert_eq!(bound.redirects[0].from, handle);
    assert_eq!(
        bound.redirects[0].to,
        session(NamedProvider::Claude, "ses_1:2:3")
    );

    // One commit: exactly one generation advanced, the pending record is gone
    // and exactly one durable record + one redirect exist.
    let raw = read_raw_document(dir.path());
    assert_eq!(
        raw.document_generation,
        before + 1,
        "bind advanced one generation"
    );
    assert!(!raw.records.contains_key(&name_ref_key(&handle)));
    assert_eq!(raw.records.len(), 1);
    assert_eq!(raw.redirects.len(), 1);
    assert_eq!(raw.records[&session_key].name, "Fix auth");

    // Late operations addressing the pending handle resolve through the
    // redirect to the durable record.
    let via_pending = get_one(&store, handle.clone())
        .await
        .expect("pending ref resolves");
    assert_eq!(
        via_pending.record.name_ref,
        session(NamedProvider::Claude, "ses_1:2:3")
    );
    assert_eq!(via_pending.redirects.len(), 1);

    // A re-bind of the same handle to the same target is idempotent.
    let rebind = store
        .bind_pending(BindNameInput {
            pending: handle.clone(),
            target: session(NamedProvider::Claude, "ses_1:2:3"),
            acquisition: claude_acquisition("/w/homes/claude", NativePersistence::Verified),
        })
        .await
        .expect("idempotent re-bind");
    assert!(!rebind.changed);
}

#[tokio::test]
async fn automatic_precedence_is_monotonic() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let all_sources = [
        NameSource::Manual,
        NameSource::LegacyProtected,
        NameSource::FreshellAi,
        NameSource::ProviderAi,
        NameSource::FirstMessage,
        NameSource::Directory,
    ];

    for (index, existing) in all_sources.iter().enumerate() {
        for (offer_index, offered) in all_sources.iter().enumerate() {
            let handle = format!("h-{index}-{offer_index}");
            let target = pending(&handle);
            // Seed a record at `existing` through real service operations.
            ensure(&store, &handle, NamedProvider::Claude, Some("/w/seed"))
                .await
                .expect("seed ensure");
            match existing {
                NameSource::Directory => {}
                NameSource::FirstMessage => {
                    activity(
                        &store,
                        target.clone(),
                        &format!("seed-{handle}"),
                        NameActivityReason::AcceptedUserMessage,
                        Some(&format!("Seed message {handle}")),
                    )
                    .await
                    .expect("seed first message");
                }
                NameSource::ProviderAi => {
                    store
                        .observe_native(observe(
                            target.clone(),
                            &format!("Seed provider title {handle}"),
                            NativeNameOrigin::Snapshot,
                            0,
                        ))
                        .await
                        .expect("seed provider title");
                }
                NameSource::FreshellAi => {
                    store
                        .offer(
                            target.clone(),
                            format!("Seed freshell {handle}"),
                            NameSource::FreshellAi,
                        )
                        .await
                        .expect("seed freshell ai");
                }
                NameSource::LegacyProtected => {
                    store
                        .offer(
                            target.clone(),
                            format!("Seed legacy {handle}"),
                            NameSource::LegacyProtected,
                        )
                        .await
                        .expect("seed migration protection");
                }
                NameSource::Manual => {
                    rename_user(&store, target.clone(), &format!("Seed manual {handle}"))
                        .await
                        .expect("seed manual");
                }
            }
            let seeded = get_one(&store, target.clone())
                .await
                .expect("seeded record");
            assert_eq!(seeded.record.source, *existing, "seed rank for {handle}");

            let expected_accept = contract_rank(*offered) > contract_rank(*existing)
                || *offered == NameSource::Manual;

            let outcome = if *offered == NameSource::Manual {
                rename_user(&store, target.clone(), "Offered manual").await
            } else {
                store
                    .offer(target.clone(), "Offered automatic".to_string(), *offered)
                    .await
            };
            let update = outcome.expect("offer runs");
            let after = get_one(&store, target.clone())
                .await
                .expect("post-offer record");
            if expected_accept {
                assert_eq!(
                    after.record.source, *offered,
                    "{handle}: expected promotion"
                );
                assert!(
                    after.record.revision > seeded.record.revision,
                    "{handle}: accepted offer advances revision"
                );
                let expected_name = if *offered == NameSource::Manual {
                    "Offered manual"
                } else {
                    "Offered automatic"
                };
                assert_eq!(after.record.name, expected_name, "{handle}");
            } else {
                assert_eq!(
                    after.record.source, *existing,
                    "{handle}: rank must not regress"
                );
                assert_eq!(after.record.name, seeded.record.name, "{handle}");
                assert_eq!(after.record.revision, seeded.record.revision, "{handle}");
            }
            assert_eq!(
                update.record, after.record,
                "{handle}: response returns the winner"
            );
        }
    }
}

#[tokio::test]
async fn failed_commit_never_publishes() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = pending("h-fail");
    ensure(&store, "h-fail", NamedProvider::Claude, Some("/w/fail"))
        .await
        .expect("ensure pending");
    let mut subscriber = store.subscribe();

    let gen_before = read_raw_document(dir.path()).document_generation;
    set_test_hooks(dir.path(), vec![TestHook::PreReplace]);
    let failed = rename_user(&store, target.clone(), "Never lands").await;
    assert!(
        matches!(failed, Err(NameError::Persistence(_))),
        "pre-replace failure keeps old state intact"
    );
    // Nothing published, nothing changed on disk.
    assert!(
        subscriber.try_recv().is_err(),
        "no success frame on failure"
    );
    assert_eq!(
        read_raw_document(dir.path()).document_generation,
        gen_before,
        "the document was not replaced"
    );
    let still = get_one(&store, target.clone())
        .await
        .expect("old record intact");
    assert_eq!(still.record.name, "fail");

    // A reopened store sees the intact old state too.
    clear_test_hooks(dir.path());
    let reopened = open_store(dir.path());
    let from_file = get_one(&reopened, target.clone())
        .await
        .expect("record after reopen");
    assert_eq!(from_file.record.name, "fail");
    assert_eq!(from_file.record.source, NameSource::Directory);

    // After the fault clears, the rename commits and publishes exactly once.
    let committed = rename_user(&store, target.clone(), "Lands now")
        .await
        .expect("rename after fault clears");
    assert!(committed.changed);
    assert_eq!(
        read_raw_document(dir.path()).document_generation,
        gen_before + 1
    );
    let published = subscriber
        .try_recv()
        .expect("the successful commit publishes session.name.updated");
    assert!(published.changed);
    assert_eq!(published.record.name, "Lands now");
}

#[tokio::test]
async fn post_replace_error_fences_until_reconciled() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = pending("h-uncertain");
    ensure(&store, "h-uncertain", NamedProvider::Claude, Some("/w/unc"))
        .await
        .expect("ensure pending");
    let mut subscriber = store.subscribe();

    set_test_hooks(dir.path(), vec![TestHook::PostReplace]);
    let uncertain = rename_user(&store, target.clone(), "Uncertain name").await;
    assert!(
        matches!(uncertain, Err(NameError::CommitUncertain(_))),
        "post-replace failure is uncertainty, not a clean failure"
    );
    assert!(
        subscriber.try_recv().is_err(),
        "uncertainty publishes nothing"
    );
    // The replacement IS installed on disk (the rename landed) — but it is
    // NOT established: no participant may adopt or publish it until
    // durability reconciliation succeeds.
    let raw = read_raw_document(dir.path());
    let on_disk = raw
        .records
        .get(&name_ref_key(&target))
        .expect("replacement installed");
    assert_eq!(on_disk.name, "Uncertain name");

    // The writer self-heals on its next transaction via reconciliation; a
    // forced reconciliation failure keeps the fence up.
    set_test_hooks(dir.path(), vec![TestHook::FailReconcile]);
    let still_fenced = store.get(vec![target.clone()]).await;
    assert!(
        matches!(still_fenced, Err(NameError::CommitUncertain(_))),
        "adoption stays fenced until durability reconciliation succeeds"
    );
    let fresh_open_fenced = SessionNames::open(dir.path().to_path_buf());
    assert!(
        matches!(fresh_open_fenced, Err(NameError::CommitUncertain(_))),
        "a fresh process cannot adopt an unreconciled replacement"
    );

    clear_test_hooks(dir.path());
    let adopted = get_one(&store, target.clone())
        .await
        .expect("reconciliation succeeds on the next transaction");
    assert_eq!(adopted.record.name, "Uncertain name");
    let fresh = open_store(dir.path());
    let from_fresh = get_one(&fresh, target.clone())
        .await
        .expect("fresh open adopts");
    assert_eq!(from_fresh.record.name, "Uncertain name");
    assert_eq!(from_fresh.record.source, NameSource::Manual);
}

#[tokio::test]
async fn vanished_document_fences_established_store() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = pending("h-vanished");
    ensure(
        &store,
        "h-vanished",
        NamedProvider::Claude,
        Some("/w/vanish"),
    )
    .await
    .expect("ensure pending");
    rename_user(&store, target.clone(), "Accepted before vanish")
        .await
        .expect("rename");
    let doc_path = dir.path().join(DOCUMENT_FILE_NAME);
    let original_bytes = std::fs::read(&doc_path).expect("read the established document");
    let established = store.core.current_view();
    assert!(established.document.document_generation >= 1);

    // The document disappears under the running store (an external
    // delete/move by a good-faith cleanup or backup tool).
    std::fs::remove_file(&doc_path).expect("document vanishes");

    // The next operation fences instead of silently reinitializing.
    let fenced = store.get(vec![target.clone()]).await;
    assert!(
        matches!(fenced, Err(NameError::Persistence(ref message)) if message.contains("vanished")),
        "a vanished document is an error, not reinitialization: {fenced:?}"
    );

    // The established view is retained and no fresh document is written.
    assert_eq!(
        store.core.current_view().document,
        established.document,
        "the fence keeps the established view"
    );
    assert!(
        !doc_path.exists(),
        "the fence never writes a fresh document"
    );
    let fenced_rename = rename_user(&store, target.clone(), "Must not land").await;
    assert!(
        matches!(fenced_rename, Err(NameError::Persistence(_))),
        "mutations are fenced too"
    );

    // Restoring the exact document resumes operation with state intact.
    write_raw_document_bytes(dir.path(), &original_bytes);
    let resumed = get_one(&store, target.clone())
        .await
        .expect("operation resumes after restore");
    assert_eq!(resumed.record.name, "Accepted before vanish");
    assert_eq!(resumed.record.source, NameSource::Manual);
    let after = rename_user(&store, target.clone(), "Alive again")
        .await
        .expect("mutations resume after restore");
    assert_eq!(after.record.name, "Alive again");
}

// ---------------------------------------------------------------------------
// Cross-process discipline (two REAL processes via the test binary itself)
// ---------------------------------------------------------------------------

const ROLE_ENV: &str = "FRESHELL_TEST_SNAMES_ROLE";
const DIR_ENV: &str = "FRESHELL_TEST_SNAMES_DIR";
const ARG_ENV: &str = "FRESHELL_TEST_SNAMES_ARG";
const RESULT_ENV: &str = "FRESHELL_TEST_SNAMES_RESULT";
const HOOKS_ENV: &str = "FRESHELL_TEST_SNAMES_HOOKS";

fn parse_hooks(raw: &str) -> Vec<TestHook> {
    raw.split(',')
        .filter(|s| !s.is_empty())
        .map(|s| match s {
            "pre_replace" => TestHook::PreReplace,
            "post_replace" => TestHook::PostReplace,
            "fail_reconcile" => TestHook::FailReconcile,
            other => TestHook::HoldLock(
                other
                    .strip_prefix("hold_lock:")
                    .and_then(|ms| ms.parse().ok())
                    .unwrap_or(0),
            ),
        })
        .collect()
}

fn record_line(result_path: &Path, value: Value) {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(result_path)
        .expect("open child result file");
    writeln!(file, "{value}").expect("write child result line");
}

/// Child-role entry: executes bounded store operations against the private
/// data-dir environment and exits normally. The parent asserts both
/// processes' results.
async fn run_child_role(role: &str) {
    let dir = PathBuf::from(std::env::var(DIR_ENV).expect("child data dir"));
    let arg = std::env::var(ARG_ENV).unwrap_or_default();
    let result_path = PathBuf::from(std::env::var(RESULT_ENV).expect("child result path"));
    let hooks = parse_hooks(&std::env::var(HOOKS_ENV).unwrap_or_default());
    set_test_hooks(&dir, hooks);

    match role {
        "init" => match SessionNames::open(dir.clone()) {
            Ok(store) => {
                let outcome =
                    ensure(&store, "h1", NamedProvider::Claude, Some("/w/childproj")).await;
                record_line(
                    &result_path,
                    match outcome {
                        Ok(update) => {
                            json!({"op": "ensure", "ok": true, "name": update.record.name, "revision": update.record.revision})
                        }
                        Err(e) => json!({"op": "ensure", "ok": false, "error": e.code()}),
                    },
                );
            }
            Err(e) => record_line(
                &result_path,
                json!({"op": "open", "ok": false, "error": e.code()}),
            ),
        },
        "cas_stale" => {
            let store = open_store(&dir);
            let expected: NameRevision = arg.parse().unwrap_or(0);
            let outcome =
                rename_user_cas(&store, pending("h1"), "Child stale rename", expected).await;
            record_line(
                &result_path,
                match outcome {
                    Ok(update) => {
                        json!({"op": "cas", "ok": true, "revision": update.record.revision})
                    }
                    Err(e) => json!({
                        "op": "cas", "ok": false, "error": e.code(),
                        "current_revision": match e {
                            NameError::Conflict { current: Some(rec), .. } => rec.revision,
                            _ => 0,
                        },
                    }),
                },
            );
        }
        "writer_b" => {
            let store = open_store(&dir);
            // Ensure → rename → bind through the SAME acquisition the
            // bookkeeper replays, so its first identical-evidence call is a
            // true no-op.
            let outcome = async {
                ensure(&store, "h2", NamedProvider::Codex, Some("/w/childb")).await?;
                rename_user(&store, pending("h2"), "Child B name").await?;
                store
                    .bind_pending(BindNameInput {
                        pending: pending("h2"),
                        target: session(NamedProvider::Codex, "ses_childb"),
                        acquisition: codex_acquisition(
                            "/w/homes/codex",
                            NativePersistence::Verified,
                        ),
                    })
                    .await
            }
            .await;
            record_line(
                &result_path,
                match outcome {
                    Ok(update) => {
                        json!({"op": "rename_b", "ok": true, "name": update.record.name, "revision": update.record.revision})
                    }
                    Err(e) => json!({"op": "rename_b", "ok": false, "error": e.code()}),
                },
            );
        }
        "bookkeeper" => {
            let store = open_store(&dir);
            let target = pending("h2");
            // Identical evidence to the bind's own acquisition: a no-op.
            let first = store
                .record_acquisition(
                    target.clone(),
                    codex_acquisition("/w/homes/codex", NativePersistence::Verified),
                )
                .await;
            // Changed evidence: one bookkeeping-only generation.
            let second = store
                .record_acquisition(
                    target,
                    codex_acquisition("/w/homes/codex-b", NativePersistence::Verified),
                )
                .await;
            record_line(
                &result_path,
                match (first, second) {
                    (Ok(a), Ok(b)) => json!({
                        "op": "bookkeeping", "ok": true,
                        "gen_first": a.document_generation, "gen_second": b.document_generation,
                        "name": b.record.name,
                    }),
                    (a, b) => json!({
                        "op": "bookkeeping", "ok": false,
                        "error": a.err().or(b.err()).map(|e| e.code()).unwrap_or("unknown"),
                    }),
                },
            );
        }
        "holder" => {
            let store = open_store(&dir);
            let outcome = rename_user(&store, pending("h1"), "Child held name").await;
            record_line(
                &result_path,
                match outcome {
                    Ok(update) => {
                        json!({"op": "held_rename", "ok": true, "name": update.record.name})
                    }
                    Err(e) => json!({"op": "held_rename", "ok": false, "error": e.code()}),
                },
            );
        }
        "uncertain" => {
            let store = open_store(&dir);
            let outcome = rename_user(&store, pending("h1"), "Uncertain name").await;
            record_line(
                &result_path,
                match outcome {
                    Ok(_) => json!({"op": "uncertain_rename", "ok": true}),
                    Err(e) => json!({"op": "uncertain_rename", "ok": false, "error": e.code()}),
                },
            );
        }
        other => panic!("unknown child role {other}"),
    }
    std::process::exit(0);
}

fn spawn_child(role: &str, dir: &Path, arg: &str, hooks: &str) -> (std::process::Child, PathBuf) {
    let result_path = dir.join(format!(".child-result-{role}-{}", uuid::Uuid::new_v4()));
    let exe = std::env::current_exe().expect("test binary path");
    let child = std::process::Command::new(exe)
        .args([
            "--exact",
            "session_names::tests::cross_process_transactions",
        ])
        .env(ROLE_ENV, role)
        .env(DIR_ENV, dir)
        .env(ARG_ENV, arg)
        .env(RESULT_ENV, &result_path)
        .env(HOOKS_ENV, hooks)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawn child test process");
    (child, result_path)
}

fn finish_child(child: std::process::Child, result_path: &Path) -> Vec<Value> {
    let output = child.wait_with_output().expect("child runs to completion");
    assert!(
        output.status.success(),
        "child role failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = std::fs::read_to_string(result_path).unwrap_or_default();
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("child result line parses"))
        .collect()
}

/// Poll the holder child's readiness sentinel: the contended phase may only
/// begin once the child provably holds the document lock. Bounded, so a child
/// that never acquires fails loudly instead of hanging the lane.
async fn wait_for_lock_held_sentinel(dir: &Path) {
    let sentinel = dir.join(LOCK_HELD_SENTINEL_NAME);
    let deadline = Instant::now() + Duration::from_secs(15);
    while !sentinel.exists() {
        assert!(
            Instant::now() < deadline,
            "holder child never signaled that it acquired the document lock"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cross_process_transactions() {
    if let Ok(role) = std::env::var(ROLE_ENV) {
        if !role.is_empty() {
            run_child_role(&role).await;
        }
    }

    let dir = temp_data_dir();
    let data_dir = dir.path().to_path_buf();
    let lock_path = data_dir.join(LOCK_FILE_NAME);

    // -- concurrent initialization: both processes open the same empty dir --
    let (init_child, init_result) = spawn_child("init", &data_dir, "", "");
    let parent_store = open_store(&data_dir);
    let init = finish_child(init_child, &init_result);
    assert_eq!(init[0]["op"], "ensure", "child opened and ran concurrently");
    assert!(
        init[0]["ok"].as_bool().unwrap(),
        "concurrent init succeeds: {init:?}"
    );
    assert_eq!(init[0]["name"], "childproj");
    assert_eq!(init[0]["revision"], 1);

    let h1 = pending("h1");
    let parent_view = parent_store.refresh_current().await.expect("refresh");
    assert!(
        parent_view.iter().any(|u| u.record.name == "childproj"),
        "the parent adopts the child's initialization/record"
    );

    // The sidecar now exists: its inode must never change for the data dir's
    // lifetime, no matter how many processes transact through it.
    #[cfg(unix)]
    let lock_inode_before = {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(&lock_path)
            .map(|m| m.ino())
            .expect("the sidecar lock exists after the first open")
    };

    // -- same-record CAS: the parent wins, the child's stale CAS conflicts --
    let parent_cas = rename_user_cas(&parent_store, h1.clone(), "Parent name", 1)
        .await
        .expect("parent CAS at revision 1 wins");
    assert_eq!(parent_cas.record.revision, 2);

    let (cas_child, cas_result) = spawn_child("cas_stale", &data_dir, "1", "");
    let cas = finish_child(cas_child, &cas_result);
    assert!(
        !cas[0]["ok"].as_bool().unwrap(),
        "stale CAS conflicts: {cas:?}"
    );
    assert_eq!(cas[0]["error"], "NAME_REVISION_CONFLICT");
    assert_eq!(
        cas[0]["current_revision"], 2,
        "conflict carries the accepted record"
    );
    let after_cas = get_one(&parent_store, h1.clone())
        .await
        .expect("record read");
    assert_eq!(after_cas.record.name, "Parent name");

    // -- different-record writes: both processes commit independently --
    let (writer_child, writer_result) = spawn_child("writer_b", &data_dir, "", "");
    let parent_other = ensure(
        &parent_store,
        "h4",
        NamedProvider::Opencode,
        Some("/w/parentd"),
    )
    .await
    .expect("parent second record");
    assert_eq!(parent_other.record.name, "parentd");
    let writer = finish_child(writer_child, &writer_result);
    assert!(
        writer[0]["ok"].as_bool().unwrap(),
        "child B writes: {writer:?}"
    );
    assert_eq!(writer[0]["name"], "Child B name");
    let refreshed = parent_store.refresh_current().await.expect("refresh");
    assert!(refreshed.iter().any(|u| u.record.name == "Child B name"));
    assert!(refreshed.iter().any(|u| u.record.name == "parentd"));

    // -- bookkeeping-only transactions advance generations without renaming --
    let gen_before_bookkeeping = read_raw_document(&data_dir).document_generation;
    let (book_child, book_result) = spawn_child("bookkeeper", &data_dir, "", "");
    let book = finish_child(book_child, &book_result);
    assert!(
        book[0]["ok"].as_bool().unwrap(),
        "bookkeeper runs: {book:?}"
    );
    assert_eq!(
        book[0]["gen_first"], gen_before_bookkeeping,
        "identical-evidence acquisition is a no-op"
    );
    assert_eq!(
        book[0]["gen_second"],
        gen_before_bookkeeping + 1,
        "one bookkeeping-only generation for the changed evidence"
    );
    let gen_after_bookkeeping = read_raw_document(&data_dir).document_generation;
    assert_eq!(
        gen_after_bookkeeping,
        gen_before_bookkeeping + 1,
        "one bookkeeping-only generation"
    );
    let child_b_still = get_one(&parent_store, pending("h2"))
        .await
        .expect("h2 resolves");
    assert_eq!(
        child_b_still.record.name, "Child B name",
        "bookkeeping never renames"
    );

    // -- alias directory paths reach the same document and lock --
    std::fs::create_dir_all(data_dir.join("sub")).expect("alias component");
    let alias_store = open_store(&data_dir.join("sub").join(".."));
    let via_alias = get_one(&alias_store, h1.clone())
        .await
        .expect("alias reads same doc");
    assert_eq!(via_alias.record.name, "Parent name");
    #[cfg(unix)]
    {
        let link = data_dir.join("alias-link");
        std::os::unix::fs::symlink(&data_dir, &link).expect("symlink alias");
        let link_store = open_store(&link);
        let via_link = get_one(&link_store, h1.clone())
            .await
            .expect("symlink reads same doc");
        assert_eq!(via_link.record.name, "Parent name");
    }

    // -- lock contention: a held child transaction fences the parent --
    let (holder_child, holder_result) = spawn_child("holder", &data_dir, "", "hold_lock:2500");
    // The contended rename may only start once the child provably holds the
    // document lock — a fixed post-spawn sleep was a start race under load.
    wait_for_lock_held_sentinel(&data_dir).await;
    let started = Instant::now();
    let contended = rename_user(&parent_store, h1.clone(), "Parent during hold").await;
    let elapsed = started.elapsed();
    assert!(
        matches!(contended, Err(NameError::LockUnavailable(_))),
        "contention returns LockUnavailable, got {contended:?}"
    );
    assert!(
        elapsed >= Duration::from_millis(900) && elapsed < Duration::from_millis(2100),
        "the retry budget is one bounded second (took {elapsed:?})"
    );
    let held = finish_child(holder_child, &holder_result);
    assert!(
        held[0]["ok"].as_bool().unwrap(),
        "holder committed: {held:?}"
    );
    let after_hold = rename_user(&parent_store, h1.clone(), "Parent after hold")
        .await
        .expect("lock released after the holder exits");
    assert_eq!(after_hold.record.name, "Parent after hold");

    // -- uncertain replacement fences a second process until reconciliation --
    let (uncertain_child, uncertain_result) =
        spawn_child("uncertain", &data_dir, "", "post_replace");
    let uncertain = finish_child(uncertain_child, &uncertain_result);
    assert!(
        !uncertain[0]["ok"].as_bool().unwrap() && uncertain[0]["error"] == "NAME_COMMIT_UNCERTAIN",
        "child reports uncertainty: {uncertain:?}"
    );

    // The sidecar lock is never replaced or unlinked: same inode throughout.
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let lock_inode_after = std::fs::metadata(&lock_path)
            .map(|m| m.ino())
            .expect("the sidecar lock still exists");
        assert_eq!(
            lock_inode_before, lock_inode_after,
            "sidecar inode lifetime"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_wait_retains_executing_lock() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = pending("h-cancel");
    ensure(&store, "h-cancel", NamedProvider::Claude, Some("/w/cancel"))
        .await
        .expect("ensure pending");

    set_test_hooks(dir.path(), vec![TestHook::HoldLock(2000)]);
    let rename_fut = rename_user(&store, target.clone(), "First writer");

    // The outer wait is cancelled while the transaction still executes.
    let cancelled = tokio::time::timeout(Duration::from_millis(150), rename_fut).await;
    assert!(cancelled.is_err(), "the outer wait elapses");

    // The still-executing transaction retains its guard: a second mutation
    // hits LockUnavailable, proving the lock was NOT released by the drop.
    let second = rename_user(&store, target.clone(), "Second writer").await;
    assert!(
        matches!(second, Err(NameError::LockUnavailable(_))),
        "the dropped wait must not release the executing transaction's lock"
    );

    // Once the executing transaction completes, the lock is free again.
    tokio::time::sleep(Duration::from_millis(2200)).await;
    let third = rename_user(&store, target.clone(), "Third writer").await;
    assert!(
        third.is_ok(),
        "lock releases when the transaction completes"
    );
    assert_eq!(third.expect("third").record.name, "Third writer");
}

// ---------------------------------------------------------------------------
// Refresh / corruption / publication ordering
// ---------------------------------------------------------------------------

#[tokio::test]
async fn full_read_same_mtime_refresh_uses_file_not_mtime() {
    let dir = temp_data_dir();
    let store_a = open_store(dir.path());
    let target = pending("h-mtime");
    ensure(&store_a, "h-mtime", NamedProvider::Claude, Some("/w/mtime"))
        .await
        .expect("ensure pending");

    let doc_path = dir.path().join(DOCUMENT_FILE_NAME);
    let mtime_before = std::fs::metadata(&doc_path)
        .and_then(|m| m.modified())
        .expect("capture mtime");

    let store_b = open_store(dir.path());
    rename_user(&store_b, target.clone(), "Committed by B")
        .await
        .expect("second store commits");

    // Rewind the mtime: refresh must be a FULL read, never an mtime shortcut.
    std::fs::File::open(&doc_path)
        .expect("open doc for mtime rewind")
        .set_times(std::fs::FileTimes::new().set_modified(mtime_before))
        .expect("rewind mtime");

    let updates = store_a.refresh_current().await.expect("refresh");
    let record = updates
        .iter()
        .find(|u| u.record.name_ref == target)
        .expect("refresh returns the record");
    assert_eq!(record.record.name, "Committed by B");
    assert!(
        record.document_generation > 2,
        "refresh adopted the externally committed generation"
    );
}

#[tokio::test]
async fn decreasing_and_equal_generation_corruption_are_errors() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = pending("h-corrupt");
    ensure(
        &store,
        "h-corrupt",
        NamedProvider::Claude,
        Some("/w/corrupt"),
    )
    .await
    .expect("ensure pending");
    rename_user(&store, target.clone(), "Honest name")
        .await
        .expect("rename");
    let established_generation = read_raw_document(dir.path()).document_generation;

    // Decreasing generation: an older document can never displace the view.
    let mut older = read_raw_document(dir.path());
    older.document_generation = 1;
    write_raw_document(dir.path(), &older);
    let decreased = store.get(vec![target.clone()]).await;
    assert!(
        matches!(decreased, Err(NameError::Persistence(_))),
        "decreasing generations are errors"
    );

    // Equal generation with different content: protocol error.
    let mut tampered = read_raw_document(dir.path());
    tampered.document_generation = established_generation;
    let key = name_ref_key(&target);
    tampered.records.get_mut(&key).expect("tamper target").name = "Tampered".to_string();
    write_raw_document(dir.path(), &tampered);
    let equal = store.get(vec![target.clone()]).await;
    assert!(
        matches!(equal, Err(NameError::Persistence(_))),
        "equal generation with different content is an error"
    );

    // A strictly newer document clears the fence and is adopted.
    let mut newer = read_raw_document(dir.path());
    newer.document_generation = established_generation + 1;
    write_raw_document(dir.path(), &newer);
    let recovered = get_one(&store, target.clone())
        .await
        .expect("newer generation adopted after corruption");
    assert_eq!(recovered.record.name, "Tampered");
}

#[tokio::test]
async fn locally_delayed_publication_cannot_revert_newer_state() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = pending("h-delayed");
    ensure(
        &store,
        "h-delayed",
        NamedProvider::Claude,
        Some("/w/delayed"),
    )
    .await
    .expect("ensure pending");

    // Capture the current adopted document (generation N), then commit a
    // newer generation, then attempt the stale adoption — it must be refused
    // and must publish nothing.
    let stale = store.core.current_view();
    rename_user(&store, target.clone(), "Newer state")
        .await
        .expect("newer commit");
    let mut subscriber = store.subscribe();

    let bytes = serialize_document(&stale.document).expect("serialize stale doc");
    let digest = digest_bytes(&bytes);
    let adopted = adopt_if_newer(&store.core, stale.document.clone(), digest, true);
    assert!(!adopted, "a stale projection cannot overwrite newer state");
    assert!(
        subscriber.try_recv().is_err(),
        "a refused adoption publishes nothing"
    );

    let current = get_one(&store, target.clone())
        .await
        .expect("current record");
    assert_eq!(current.record.name, "Newer state");

    // Commits publish in local generation order.
    let mut order_subscriber = store.subscribe();
    for name in ["Ordered one", "Ordered two", "Ordered three"] {
        rename_user(&store, target.clone(), name)
            .await
            .expect("ordered rename");
    }
    let mut generations = Vec::new();
    for _ in 0..3 {
        let update = order_subscriber
            .try_recv()
            .expect("three ordered publications");
        generations.push(update.document_generation);
    }
    let mut sorted = generations.clone();
    sorted.sort_unstable();
    assert_eq!(
        generations, sorted,
        "publications arrive in generation order"
    );
}

// ---------------------------------------------------------------------------
// Acceptance, identity and binding details
// ---------------------------------------------------------------------------

#[tokio::test]
async fn same_text_user_promotion() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = pending("h-promote");
    let ensured = ensure(
        &store,
        "h-promote",
        NamedProvider::Claude,
        Some("/w/promote"),
    )
    .await
    .expect("ensure pending");
    assert_eq!(ensured.record.name, "promote");

    // Renaming to the SAME text is still an explicit user rename: the source
    // promotes to manual, the revision advances, rename metadata is assigned.
    let promoted = rename_user(&store, target.clone(), "promote")
        .await
        .expect("same-text rename");
    assert!(promoted.changed);
    assert_eq!(promoted.record.name, "promote");
    assert_eq!(promoted.record.source, NameSource::Manual);
    assert!(promoted.record.revision > ensured.record.revision);
    assert_eq!(
        promoted.record.manual_revision,
        Some(promoted.record.revision)
    );
    assert!(promoted.record.renamed_at.is_some());
}

#[tokio::test]
async fn cross_provider_opaque_ids_do_not_collide() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());

    let claude_target = session(NamedProvider::Claude, "a:b:c");
    let codex_target = session(NamedProvider::Codex, "a:b:c");
    assert_ne!(name_ref_key(&claude_target), name_ref_key(&codex_target));

    for (handle, target, provider) in [
        ("h-claude", claude_target.clone(), NamedProvider::Claude),
        ("h-codex", codex_target.clone(), NamedProvider::Codex),
    ] {
        ensure(&store, handle, provider, Some("/w/opaque"))
            .await
            .expect("ensure pending");
        store
            .bind_pending(BindNameInput {
                pending: pending(handle),
                target: target.clone(),
                acquisition: if provider == NamedProvider::Claude {
                    claude_acquisition("/w/homes/claude", NativePersistence::Verified)
                } else {
                    codex_acquisition("/w/homes/codex", NativePersistence::Verified)
                },
            })
            .await
            .expect("bind");
    }

    rename_user(&store, claude_target.clone(), "Claude session name")
        .await
        .expect("rename claude record");
    let codex_record = get_one(&store, codex_target.clone())
        .await
        .expect("codex record distinct");
    assert_eq!(
        codex_record.record.name, "opaque",
        "renaming one provider's opaque id never touches the other"
    );
}

#[tokio::test]
async fn location_changes_without_name_changes() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let handle = pending("h-loc");
    ensure(&store, "h-loc", NamedProvider::Claude, Some("/w/loc"))
        .await
        .expect("ensure pending");
    let target = session(NamedProvider::Claude, "ses_loc");
    store
        .bind_pending(BindNameInput {
            pending: handle,
            target: target.clone(),
            acquisition: claude_acquisition("/w/homes/one", NativePersistence::Verified),
        })
        .await
        .expect("bind with verified location");
    let key = name_ref_key(&target);
    let after_bind = read_raw_document(dir.path());
    assert_eq!(
        after_bind.locations[&key]
            .verified
            .as_ref()
            .expect("verified location")
            .location_revision,
        1,
        "first verified acquisition assigns locationRevision 1"
    );
    let name_at_bind = get_one(&store, target.clone())
        .await
        .expect("record")
        .record;

    // Same verified evidence again: a no-op, no generation consumed.
    let gen_before = read_raw_document(dir.path()).document_generation;
    let same = store
        .record_acquisition(
            target.clone(),
            claude_acquisition("/w/homes/one", NativePersistence::Verified),
        )
        .await
        .expect("identical evidence accepted");
    assert!(!same.changed);
    assert_eq!(
        read_raw_document(dir.path()).document_generation,
        gen_before,
        "identical routing evidence persists nothing"
    );

    // Changed verified evidence: the location revision advances and the
    // generation moves — with NO visible name change.
    let changed = store
        .record_acquisition(
            target.clone(),
            claude_acquisition("/w/homes/two", NativePersistence::Verified),
        )
        .await
        .expect("changed evidence accepted");
    assert!(!changed.changed, "locations never change names");
    assert_eq!(changed.record, name_at_bind);
    let after_change = read_raw_document(dir.path());
    assert_eq!(
        after_change.locations[&key]
            .verified
            .as_ref()
            .expect("verified")
            .location_revision,
        2
    );
    assert!(after_change.document_generation > gen_before);

    // Prospective evidence is retained for routing but never verified.
    let prospective = store
        .record_acquisition(
            target.clone(),
            claude_acquisition("/w/homes/live", NativePersistence::Prospective),
        )
        .await
        .expect("prospective retained");
    assert!(!prospective.changed);
    let after_prospective = read_raw_document(dir.path());
    assert!(
        after_prospective.locations[&key].prospective.is_some(),
        "prospective routing retained"
    );
    assert_eq!(
        after_prospective.locations[&key]
            .verified
            .as_ref()
            .expect("verified")
            .location_revision,
        2,
        "prospective evidence never advances the verified revision"
    );
}

#[tokio::test]
async fn pending_collision_budget_union_and_redirects() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let durable = session(NamedProvider::Codex, "ses_union");

    // Target side: bind P0 with an armed, once-consumed series.
    ensure(&store, "h-union-0", NamedProvider::Codex, Some("/w/union0"))
        .await
        .expect("ensure p0");
    activity(
        &store,
        pending("h-union-0"),
        "e-target",
        NameActivityReason::AcceptedUserMessage,
        Some("Target side message"),
    )
    .await
    .expect("arm target series");
    store
        .claim_generation_start(pending("h-union-0"), "attempt-target".to_string())
        .await
        .expect("consume one target start");
    store
        .bind_pending(BindNameInput {
            pending: pending("h-union-0"),
            target: durable.clone(),
            acquisition: codex_acquisition("/w/homes/codex", NativePersistence::Verified),
        })
        .await
        .expect("bind target side");

    // Pending side: an armed series with two consumed starts.
    ensure(&store, "h-union-1", NamedProvider::Codex, Some("/w/union1"))
        .await
        .expect("ensure p1");
    activity(
        &store,
        pending("h-union-1"),
        "e-pending",
        NameActivityReason::AcceptedUserMessage,
        Some("Pending side message"),
    )
    .await
    .expect("arm pending series");
    for attempt in ["attempt-pending-1", "attempt-pending-2"] {
        store
            .claim_generation_start(pending("h-union-1"), attempt.to_string())
            .await
            .expect("consume pending start");
    }

    // Colliding bind: equal automatic ranks favor the durable record; the
    // budgets union (1 + 2 = 3 => exhausted at the cap).
    let collided = store
        .bind_pending(BindNameInput {
            pending: pending("h-union-1"),
            target: durable.clone(),
            acquisition: codex_acquisition("/w/homes/codex", NativePersistence::Verified),
        })
        .await
        .expect("colliding bind resolves deterministically");
    assert_eq!(
        collided.record.name, "Target side message",
        "durable record wins equal ranks"
    );

    let key = name_ref_key(&durable);
    let raw = read_raw_document(dir.path());
    let series = raw.generation.get(&key).expect("union series");
    assert_eq!(series.consumed, 3, "combined starts cap at three");
    assert_eq!(series.status, GenerationStatus::Exhausted);
    assert!(series.exhausted_at.is_some(), "exhaustion time recorded");
    assert!(series.attempt_ids.contains(&"attempt-target".to_string()));
    assert!(series
        .attempt_ids
        .contains(&"attempt-pending-1".to_string()));
    assert_eq!(
        raw.redirects.len(),
        2,
        "both handles redirect to the durable record"
    );
    assert!(
        raw.recovery
            .values()
            .any(|entry| entry.record.name == "Pending side message"),
        "losing evidence is retained in recovery, never active"
    );

    // Exhaustion is final: neither new activity nor claims rearm the series.
    activity(
        &store,
        durable.clone(),
        "e-after-exhaustion",
        NameActivityReason::AcceptedUserMessage,
        Some("Message after exhaustion"),
    )
    .await
    .expect("activity folds");
    let after = read_raw_document(dir.path());
    let series = after.generation.get(&key).expect("series after activity");
    assert_eq!(series.consumed, 3, "exhaustion never re-arms");
    assert_eq!(series.status, GenerationStatus::Exhausted);
    store
        .claim_generation_start(durable.clone(), "attempt-beyond".to_string())
        .await
        .expect("claim beyond the cap is a bounded no-op");
    let final_doc = read_raw_document(dir.path());
    assert_eq!(final_doc.generation[&key].consumed, 3);

    // Both pending handles resolve through their redirects.
    for handle in ["h-union-0", "h-union-1"] {
        let resolved = get_one(&store, pending(handle))
            .await
            .expect("redirect resolves");
        assert_eq!(resolved.record.name_ref, durable);
    }
}

#[tokio::test]
async fn if_revision_cas_conflicts() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = pending("h-cas");
    let ensured = ensure(&store, "h-cas", NamedProvider::Claude, Some("/w/cas"))
        .await
        .expect("ensure pending");
    let first_revision = ensured.record.revision;

    let winner = rename_user_cas(&store, target.clone(), "CAS winner", first_revision)
        .await
        .expect("correct revision wins");
    assert_eq!(winner.record.name, "CAS winner");

    let stale = rename_user_cas(&store, target.clone(), "CAS loser", first_revision).await;
    match stale {
        Err(NameError::Conflict { current, .. }) => {
            let current = current.expect("conflict carries the accepted record");
            assert_eq!(current.revision, winner.record.revision);
            assert_eq!(current.name, "CAS winner");
        }
        other => panic!("expected a conflict, got {other:?}"),
    }

    // No CAS: user operations serialize by server commit order.
    let serialized = rename_user(&store, target.clone(), "No CAS")
        .await
        .expect("without ifRevision the rename serializes");
    assert_eq!(serialized.record.name, "No CAS");
}

#[tokio::test]
async fn get_omits_unknown_and_rename_unknown_is_not_found() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());

    let unknown = store
        .get(vec![session(NamedProvider::Opencode, "ses_missing")])
        .await
        .expect("get runs");
    assert!(unknown.is_empty(), "unknown refs are omitted");

    let missing_rename =
        rename_user(&store, session(NamedProvider::Opencode, "ses_missing"), "x").await;
    assert!(matches!(missing_rename, Err(NameError::NotFound(_))));

    // ensure_pending is idempotent per handle.
    let handle = pending("h-idem");
    let first = ensure(&store, "h-idem", NamedProvider::Opencode, Some("/w/idem"))
        .await
        .expect("first ensure");
    assert!(first.changed);
    let second = ensure(&store, "h-idem", NamedProvider::Opencode, Some("/w/idem"))
        .await
        .expect("re-ensure");
    assert!(!second.changed);
    assert_eq!(second.record, first.record);

    // After binding, ensuring the same handle resolves the durable record.
    store
        .bind_pending(BindNameInput {
            pending: handle,
            target: session(NamedProvider::Opencode, "ses_idem"),
            acquisition: NativeAcquisition {
                location: NativeLocation::Opencode {
                    database_path: "/w/homes/opencode/opencode.db".to_string(),
                    native_session_id: Some("ses_idem".to_string()),
                    original_directory: Some("/w/idem".to_string()),
                    owned_local_endpoint: None,
                },
                evidence: NativeEvidenceKind::PersistedMetadata,
                persistence: NativePersistence::Verified,
            },
        })
        .await
        .expect("bind");
    let via_handle = ensure(&store, "h-idem", NamedProvider::Opencode, Some("/w/idem"))
        .await
        .expect("ensure after bind");
    assert!(!via_handle.changed);
    assert_eq!(
        via_handle.record.name_ref,
        session(NamedProvider::Opencode, "ses_idem")
    );
}

#[tokio::test]
async fn observe_native_folds_provider_titles_and_own_write_echoes() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = pending("h-observe");
    ensure(
        &store,
        "h-observe",
        NamedProvider::Claude,
        Some("/w/observe"),
    )
    .await
    .expect("ensure pending");

    // A native snapshot folds as an automatic provider_ai candidate.
    let folded = store
        .observe_native(observe(
            target.clone(),
            "Native title",
            NativeNameOrigin::Snapshot,
            0,
        ))
        .await
        .expect("snapshot folds");
    assert!(folded.changed);
    assert_eq!(folded.record.name, "Native title");
    assert_eq!(folded.record.source, NameSource::ProviderAi);

    // An own-write echo is provenance only: never promoted, never renaming.
    let echo = store
        .observe_native(observe(
            target.clone(),
            "Freshell wrote this",
            NativeNameOrigin::OwnWrite,
            0,
        ))
        .await
        .expect("echo recorded");
    assert!(!echo.changed, "own echoes never promote");
    assert_eq!(echo.record.name, "Native title");
    assert_eq!(echo.record.source, NameSource::ProviderAi);

    // An old-location observation cannot change the current accepted name.
    store
        .record_acquisition(
            target.clone(),
            claude_acquisition("/w/homes/obs", NativePersistence::Verified),
        )
        .await
        .expect("verified location");
    let stale = store
        .observe_native(observe(
            target.clone(),
            "Stale location title",
            NativeNameOrigin::Snapshot,
            0,
        ))
        .await
        .expect("stale observation retained");
    assert!(!stale.changed, "old-location observations never fold names");
    assert_eq!(stale.record.name, "Native title");

    // Equal-rank automatic observations preserve the accepted value.
    let equal = store
        .observe_native(observe(
            target.clone(),
            "Different provider title",
            NativeNameOrigin::ProviderAi,
            1,
        ))
        .await
        .expect("equal-rank observation");
    assert!(!equal.changed);
    assert_eq!(equal.record.name, "Native title");

    // Invalid titles are visible validation errors.
    let oversize = store
        .observe_native(observe(
            target.clone(),
            &"x".repeat(201),
            NativeNameOrigin::Snapshot,
            1,
        ))
        .await;
    assert!(matches!(oversize, Err(NameError::InvalidName(_))));
}

#[tokio::test]
async fn activity_first_message_fallback_and_dedupe() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = pending("h-activity");

    // A directory-basename record is created with a cwd.
    let ensured = ensure(
        &store,
        "h-activity",
        NamedProvider::Claude,
        Some("/w/activity"),
    )
    .await
    .expect("ensure pending");
    assert_eq!(ensured.record.name, "activity");

    // Opened with no first user message: no fallback, no eligibility arming.
    let gen_before = read_raw_document(dir.path()).document_generation;
    let opened = activity(
        &store,
        target.clone(),
        "e-open-empty",
        NameActivityReason::Opened,
        None,
    )
    .await
    .expect("opened without message");
    assert!(!opened.changed);
    assert_eq!(
        read_raw_document(dir.path()).document_generation,
        gen_before,
        "nothing to arm without a first message"
    );
    let unclaimed = store
        .claim_generation_start(target.clone(), "attempt-unarmed".to_string())
        .await;
    assert!(
        matches!(unclaimed, Err(NameError::NotFound(_))),
        "no series was armed"
    );

    // Accepted input upgrades the fallback without waiting for generation.
    let upgraded = activity(
        &store,
        target.clone(),
        "e-msg-1",
        NameActivityReason::AcceptedUserMessage,
        Some("Fix the login bug\nmore detail"),
    )
    .await
    .expect("accepted message upgrades");
    assert!(upgraded.changed);
    assert_eq!(upgraded.record.name, "Fix the login bug");
    assert_eq!(upgraded.record.source, NameSource::FirstMessage);

    // The series is armed and immediately ready: a start can be claimed.
    store
        .claim_generation_start(target.clone(), "attempt-1".to_string())
        .await
        .expect("armed series is claimable");

    // Duplicate delivery of the same event/message is a no-op.
    let gen_after_claim = read_raw_document(dir.path()).document_generation;
    let duplicate = activity(
        &store,
        target.clone(),
        "e-msg-1",
        NameActivityReason::AcceptedUserMessage,
        Some("Fix the login bug\nmore detail"),
    )
    .await
    .expect("duplicate folds");
    assert!(!duplicate.changed);
    assert_eq!(
        read_raw_document(dir.path()).document_generation,
        gen_after_claim,
        "duplicate delivery persists nothing"
    );

    // A manual name stops generation entirely.
    rename_user(&store, target.clone(), "Manual stop")
        .await
        .expect("manual rename");
    let post_manual = activity(
        &store,
        target.clone(),
        "e-msg-2",
        NameActivityReason::AcceptedUserMessage,
        Some("Another message"),
    )
    .await
    .expect("activity on a protected record");
    assert!(!post_manual.changed, "manual names stop generation input");
    assert_eq!(post_manual.record.name, "Manual stop");
}

#[tokio::test]
async fn name_validation_rejects_blank_and_oversize() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = pending("h-validate");
    ensure(
        &store,
        "h-validate",
        NamedProvider::Claude,
        Some("/w/validate"),
    )
    .await
    .expect("ensure pending");

    for bad in [
        "",
        "   ",
        "\t\n",
        &"y".repeat(201),
        "bad\u{1}name",
        "\u{7}control",
    ] {
        let outcome = rename_user(&store, target.clone(), bad).await;
        assert!(
            matches!(outcome, Err(NameError::InvalidName(_))),
            "rejecting {bad:?}"
        );
    }

    // 200 Unicode scalars are legal; surrounding whitespace is trimmed; the
    // name is kept as entered otherwise (no shortness normalization).
    let exact = rename_user(&store, target.clone(), &"z".repeat(200))
        .await
        .expect("200 scalars accepted");
    assert_eq!(exact.record.name.len(), 200);

    let trimmed = rename_user(&store, target.clone(), "  Padded name  ")
        .await
        .expect("trim accepted");
    assert_eq!(trimmed.record.name, "Padded name");

    let unicode = rename_user(&store, target.clone(), "Fix café shipping — now")
        .await
        .expect("unicode accepted");
    assert_eq!(unicode.record.name, "Fix café shipping — now");
}

#[tokio::test]
async fn ensure_pending_pathological_cwd_falls_back_to_provider_label() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());

    // A control-character basename can never be installed as a name.
    let control = ensure(
        &store,
        "h-bad-cwd",
        NamedProvider::Claude,
        Some("/w/bad\u{7}dir"),
    )
    .await
    .expect("ensure with a control-character cwd");
    assert_eq!(
        control.record.name, "Claude",
        "the provider label is the fallback, not {:?}",
        control.record.name
    );
    assert_eq!(control.record.source, NameSource::Directory);

    // An oversize basename (>200 scalars) falls back too.
    let oversize_cwd = format!("/w/{}", "y".repeat(201));
    let oversize = ensure(
        &store,
        "h-long-cwd",
        NamedProvider::Opencode,
        Some(&oversize_cwd),
    )
    .await
    .expect("ensure with an oversize cwd");
    assert_eq!(
        oversize.record.name,
        "OpenCode",
        "the provider label is the fallback, not {} chars",
        oversize.record.name.chars().count()
    );
    assert_eq!(oversize.record.source, NameSource::Directory);

    // A usable basename still wins, and fallback records are ordinary
    // rename targets.
    let usable = ensure(
        &store,
        "h-good-cwd",
        NamedProvider::Codex,
        Some("/w/gooddir"),
    )
    .await
    .expect("ensure with a usable cwd");
    assert_eq!(usable.record.name, "gooddir");
    let renamed = rename_user(&store, pending("h-bad-cwd"), "Fixed later")
        .await
        .expect("the fallback record is a normal rename target");
    assert_eq!(renamed.record.name, "Fixed later");
}

#[tokio::test]
async fn worker_guard_try_acquire_is_exclusive() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let first = store
        .try_background_guard()
        .expect("worker lock opens")
        .expect("first acquisition succeeds");
    let second = store.try_background_guard().expect("worker lock opens");
    assert!(
        second.is_none(),
        "a second acquisition in the same home is refused while held"
    );
    drop(first);
    let third = store
        .try_background_guard()
        .expect("worker lock opens")
        .expect("release on drop allows re-acquisition");
    drop(third);
}

// ── unified agent names (Task 2 review, M1): the naming publisher's lag
// recovery ─────────────────────────────────────────────────────────────────

/// A `Lagged` recv — a burst of commits overran the broadcast history while
/// the publisher was slow — must re-adopt the full document
/// (`refresh_current`) and re-diff EVERY record through the same push, so
/// the missed frames cannot leave a registry display cache or a WS client
/// stale until the record changes again; the buffered tail still publishes
/// normally; and a `Closed` channel ENDS the task (never a busy-loop). The
/// publisher's receiver is a parameter, so the test drives it with a tiny
/// capacity-2 channel — three sends without a recv lag it deterministically,
/// and dropping the sender ends the loop through the Closed arm.
#[tokio::test]
async fn publisher_recovers_a_lagged_subscription_by_re_diffing_every_record() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());

    // One durable record the store knows about, with a name the caches have
    // never seen (the lag recovery must surface it WITHOUT a new commit).
    ensure(
        &store,
        "handle-lag",
        NamedProvider::Claude,
        Some("/w/homes/claude/proj"),
    )
    .await
    .expect("ensure the pending record");
    store
        .bind_pending(BindNameInput {
            pending: pending("handle-lag"),
            target: session(NamedProvider::Claude, "sess-lag"),
            acquisition: claude_acquisition("/w/homes/claude", NativePersistence::Verified),
        })
        .await
        .expect("bind the durable record");
    rename_user(
        &store,
        session(NamedProvider::Claude, "sess-lag"),
        "Lag Recovery Name",
    )
    .await
    .expect("name the durable record");

    // A terminal bound to that record — the publisher's write-through target.
    let registry = freshell_terminal::TerminalRegistry::new();
    registry.register_headless(freshell_terminal::registry::HeadlessTerminal {
        terminal_id: "t-lag".into(),
        stream_id: "s-lag".into(),
        mode: "claude".into(),
        resume_session_id: None,
        create_request_id: None,
        created_at: None,
    });
    registry.set_naming(
        "t-lag",
        Some(session(NamedProvider::Claude, "sess-lag")),
        None,
    );
    assert!(
        registry.session_name_of("t-lag").is_none(),
        "precondition: the display cache has never seen the record"
    );

    // Lag the publisher's receiver deterministically: capacity 2, three
    // sends, nobody recv'ing. The two freshest updates stay buffered; the
    // first recv reports the lag. Dropping the sender closes the channel
    // after the buffered tail, which must END the loop.
    let (tx, rx) = tokio::sync::broadcast::channel::<SessionNameUpdate>(2);
    let dummy = |id: &str| SessionNameUpdate {
        redirects: Vec::new(),
        record: SessionNameRecord {
            name_ref: session(NamedProvider::Claude, id),
            name: "unused".into(),
            source: NameSource::Directory,
            revision: 1,
            manual_revision: None,
            renamed_at: None,
            legacy_origin: None,
        },
        document_generation: 1,
        changed: true,
        native_sync: None,
    };
    tx.send(dummy("buried-1")).expect("send 1");
    tx.send(dummy("buried-2")).expect("send 2");
    tx.send(dummy("buried-3")).expect("send 3");
    drop(tx);

    let (broadcast_tx, mut client) = tokio::sync::broadcast::channel::<String>(64);
    let sessions_revision = std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0));

    // The publisher must RUN TO COMPLETION once the channel closes — a
    // Closed channel may never busy-loop (the timeout makes that defect a
    // loud failure instead of a hang).
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        run_naming_publisher(
            store.clone(),
            rx,
            registry.clone(),
            std::sync::Arc::new(broadcast_tx),
            sessions_revision.clone(),
        ),
    )
    .await
    .expect("the publisher must end on a closed channel");

    // The lag recovery re-diffed the store's record to the bound terminal.
    let cached = registry
        .session_name_of("t-lag")
        .expect("the recovery must refresh every bound terminal's display cache");
    assert_eq!(cached.name, "Lag Recovery Name");

    // The canonical frame reached the WS channel (the recovery re-publishes
    // the record), and the session directory was invalidated.
    let mut saw_name_update = false;
    let mut saw_sessions_changed = false;
    while let Ok(frame) = client.try_recv() {
        if frame.contains("session.name.updated") && frame.contains("Lag Recovery Name") {
            saw_name_update = true;
        }
        if frame.contains("sessions.changed") {
            saw_sessions_changed = true;
        }
    }
    assert!(
        saw_name_update,
        "the lag recovery must re-publish the record as a session.name.updated frame"
    );
    assert!(
        saw_sessions_changed,
        "the lag recovery must invalidate the session directory"
    );
    assert!(
        sessions_revision.load(std::sync::atomic::Ordering::SeqCst) >= 3,
        "every pushed update (recovery + buffered tail) bumps the revision"
    );
}
