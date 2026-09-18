//! Unified agent names (Task 1): wire-type fidelity for the session-name
//! DTOs, the internal native-location evidence types, and the new
//! `session.name.updated` broadcast frame.
//!
//! Round-trips use REAL payload shapes (camelCase wire fields, colon-containing
//! opaque provider session IDs) and validate the frame against the frozen
//! outbound contract, mirroring `roundtrip.rs`'s conformance discipline.

use std::path::PathBuf;

use freshell_protocol::*;
use serde_json::{json, Value};

fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(rel)
}

fn outbound_schema_for(type_name: &str) -> Value {
    let text = std::fs::read_to_string(repo_path("port/contract/ws-server-messages.schema.json"))
        .expect("read ws-server-messages.schema.json");
    let doc: Value = serde_json::from_str(&text).expect("parse ws-server-messages.schema.json");
    doc["messages"][type_name]
        .as_object()
        .map(|_| doc["messages"][type_name].clone())
        .expect("frozen schema exists for the frame")
}

fn assert_conforms(instance: &Value, schema: &Value, ctx: &str) {
    let validator = jsonschema::validator_for(schema).expect("compile frozen schema");
    if !validator.is_valid(instance) {
        let errs: Vec<String> = validator
            .iter_errors(instance)
            .map(|e| e.to_string())
            .collect();
        panic!(
            "FIDELITY GAP: `{ctx}` does not conform to the frozen contract:\n  - {}\n  serialized: {instance}",
            errs.join("\n  - ")
        );
    }
}

fn session_ref(provider: &str, session_id: &str) -> Value {
    json!({ "kind": "session", "provider": provider, "sessionId": session_id })
}

#[test]
fn session_name_ref_roundtrips_pending_and_session_with_colon_ids() {
    let pending_wire = json!({ "kind": "pending", "id": "freshopencode-req-1:extra" });
    let pending: SessionNameRef = serde_json::from_value(pending_wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(&pending).unwrap(), pending_wire);

    let session_wire = session_ref("codex", "ses_1:2:3");
    let session: SessionNameRef = serde_json::from_value(session_wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(&session).unwrap(), session_wire);
    match &session {
        SessionNameRef::Session {
            provider,
            session_id,
        } => {
            assert_eq!(*provider, NamedProvider::Codex);
            assert_eq!(session_id, "ses_1:2:3");
        }
        other => panic!("expected session variant, got {other:?}"),
    }
}

#[test]
fn session_name_record_roundtrips_manual_and_legacy_protected_shapes() {
    // Manual record with rename metadata: optional fields present.
    let manual_wire = json!({
        "ref": session_ref("claude", "0192:uuid-with-colons"),
        "name": "Ship the reorder panel",
        "source": "manual",
        "revision": 9,
        "manualRevision": 9,
        "renamedAt": 1739491200000i64,
    });
    let record: SessionNameRecord = serde_json::from_value(manual_wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(&record).unwrap(), manual_wire);
    assert_eq!(record.source, NameSource::Manual);
    assert_eq!(record.manual_revision, Some(9));

    // Migration-only legacy_protected record: legacyOrigin required on the
    // wire; renamedAt/manualRevision absent (unknown origin is never human).
    let legacy_wire = json!({
        "ref": { "kind": "pending", "id": "legacy-handle" },
        "name": "Old protected label",
        "source": "legacy_protected",
        "revision": 2,
        "legacyOrigin": "unknown",
    });
    let record: SessionNameRecord = serde_json::from_value(legacy_wire.clone()).unwrap();
    let back = serde_json::to_value(&record).unwrap();
    assert_eq!(back, legacy_wire);
    assert_eq!(record.source, NameSource::LegacyProtected);
    assert_eq!(record.legacy_origin, Some(LegacyOrigin::Unknown));
    assert!(
        back.get("manualRevision").is_none(),
        "no invented manual metadata"
    );
    assert!(back.get("renamedAt").is_none());
}

#[test]
fn session_name_update_roundtrips_full_payload_with_redirects() {
    let wire = json!({
        "record": {
            "ref": session_ref("opencode", "ses_9"),
            "name": "Fix auth flow",
            "source": "freshell_ai",
            "revision": 7,
        },
        "documentGeneration": 12,
        "redirects": [
            {
                "from": { "kind": "pending", "id": "freshopencode-req-1" },
                "to": session_ref("opencode", "ses_9"),
                "revision": 6,
            }
        ],
        "changed": true,
    });
    let update: SessionNameUpdate = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(&update).unwrap(), wire);
    assert_eq!(update.redirects.len(), 1);
    assert_eq!(update.redirects[0].revision, 6);
    assert!(update.changed);
}

#[test]
fn rename_session_name_request_roundtrips_with_and_without_optional_fields() {
    let minimal: RenameSessionNameRequest = serde_json::from_value(json!({
        "target": { "kind": "pending", "id": "h2" },
        "name": "New name",
    }))
    .unwrap();
    let back = serde_json::to_value(&minimal).unwrap();
    assert!(back.get("nameIntent").is_none());
    assert!(back.get("ifRevision").is_none());

    let full: RenameSessionNameRequest = serde_json::from_value(json!({
        "target": session_ref("codex", "ses_2"),
        "name": "Trim me",
        "nameIntent": "user",
        "ifRevision": 3,
    }))
    .unwrap();
    assert_eq!(full.name_intent, Some(NameIntent::User));
    assert_eq!(full.if_revision, Some(3));
    let back = serde_json::to_value(&full).unwrap();
    assert_eq!(back["nameIntent"], "user");
    assert_eq!(back["ifRevision"], 3);
}

#[test]
fn tab_name_source_roundtrips_session_and_legacy() {
    let owned: TabNameSource =
        serde_json::from_value(json!({ "kind": "session", "paneId": "pane-7" })).unwrap();
    assert_eq!(
        serde_json::to_value(&owned).unwrap(),
        json!({ "kind": "session", "paneId": "pane-7" })
    );
    let legacy: TabNameSource = serde_json::from_value(json!({ "kind": "legacy" })).unwrap();
    assert_eq!(
        serde_json::to_value(&legacy).unwrap(),
        json!({ "kind": "legacy" })
    );
}

#[test]
fn name_revision_ceiling_is_js_safe() {
    assert_eq!(MAX_NAME_REVISION, 9_007_199_254_740_991u64);
    // The full ceiling round-trips as an integer (never a float).
    let record = json!({
        "ref": { "kind": "pending", "id": "h" },
        "name": "x",
        "source": "directory",
        "revision": MAX_NAME_REVISION,
    });
    let parsed: SessionNameRecord = serde_json::from_value(record).unwrap();
    assert_eq!(parsed.revision, MAX_NAME_REVISION);
}

#[test]
fn native_location_types_roundtrip_provider_variants() {
    let claude = json!({
        "provider": "claude",
        "configRoot": "/home/dan/.config/claude",
        "transcriptPath": "/home/dan/.config/claude/projects/R-projects/0192.jsonl",
        "projectDirectoryKey": "R-projects",
        "transcriptCwd": "/home/dan/code/freshell",
    });
    let loc: NativeLocation = serde_json::from_value(claude.clone()).unwrap();
    assert_eq!(serde_json::to_value(&loc).unwrap(), claude);

    let codex = json!({
        "provider": "codex",
        "codexHome": "/tmp/harness/codex-home",
        "nativeThreadId": "thread_abc",
        "rolloutPath": "/tmp/harness/codex-home/sessions/rollout-1.jsonl",
        "persistenceEvidence": "thread_started_notification",
    });
    let loc: NativeLocation = serde_json::from_value(codex.clone()).unwrap();
    assert_eq!(serde_json::to_value(&loc).unwrap(), codex);

    let opencode = json!({
        "provider": "opencode",
        "databasePath": "/tmp/harness/.local/share/opencode/opencode.db",
        "nativeSessionId": "ses_1",
        "originalDirectory": "/home/dan/code/freshell",
        "ownedLocalEndpoint": "http://127.0.0.1:40123",
    });
    let loc: NativeLocation = serde_json::from_value(opencode.clone()).unwrap();
    assert_eq!(serde_json::to_value(&loc).unwrap(), opencode);
}

#[test]
fn native_acquisition_roundtrips_evidence_and_persistence_states() {
    let verified = json!({
        "location": {
            "provider": "opencode",
            "databasePath": "/x/opencode.db",
            "nativeSessionId": "ses_1",
        },
        "evidence": "initialized_runtime",
        "persistence": "verified",
    });
    let acq: NativeAcquisition = serde_json::from_value(verified.clone()).unwrap();
    assert_eq!(serde_json::to_value(&acq).unwrap(), verified);
    assert_eq!(acq.persistence, NativePersistence::Verified);
    assert_eq!(acq.evidence, NativeEvidenceKind::InitializedRuntime);

    let prospective = json!({
        "location": { "provider": "codex", "codexHome": "/y", "nativeThreadId": "t1" },
        "evidence": "persisted_metadata",
        "persistence": "prospective",
    });
    let acq: NativeAcquisition = serde_json::from_value(prospective).unwrap();
    assert_eq!(acq.persistence, NativePersistence::Prospective);
    assert_eq!(acq.evidence, NativeEvidenceKind::PersistedMetadata);
}

#[test]
fn session_name_updated_frame_roundtrips_and_conforms() {
    let wire = json!({
        "type": "session.name.updated",
        "record": {
            "ref": session_ref("claude", "0192-uuid"),
            "name": "Ship it",
            "source": "manual",
            "revision": 4,
            "manualRevision": 4,
            "renamedAt": 1739491200000i64,
        },
        "documentGeneration": 5,
        "redirects": [
            {
                "from": { "kind": "pending", "id": "h1" },
                "to": session_ref("claude", "0192-uuid"),
                "revision": 3,
            }
        ],
        "changed": true,
    });
    let msg: ServerMessage = serde_json::from_value(wire.clone()).unwrap();
    let back = serde_json::to_value(&msg).unwrap();
    assert_eq!(back, wire, "round-trip must preserve the frame byte-shape");
    match &msg {
        ServerMessage::SessionNameUpdated(u) => {
            assert_eq!(u.record.revision, 4);
            assert_eq!(u.document_generation, 5);
            assert!(u.changed);
            assert_eq!(
                u.redirects[0].from,
                SessionNameRef::Pending { id: "h1".into() }
            );
        }
        other => panic!("expected SessionNameUpdated, got {other:?}"),
    }
    assert_conforms(
        &back,
        &outbound_schema_for("session.name.updated"),
        "session.name.updated",
    );
}

#[test]
fn session_name_updated_elides_empty_redirects() {
    let wire = json!({
        "type": "session.name.updated",
        "record": {
            "ref": { "kind": "pending", "id": "h2" },
            "name": "freshell",
            "source": "directory",
            "revision": 1,
        },
        "documentGeneration": 1,
        "redirects": [],
        "changed": true,
    });
    let msg: ServerMessage = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(&msg).unwrap(), wire);
}

#[test]
fn legacy_frame_shapes_still_parse_after_the_naming_frame_addition() {
    // Non-regression: the naming addition must not disturb existing frames.
    let created: ServerMessage = serde_json::from_value(json!({
        "type": "terminal.created",
        "createdAt": 1700000000000i64,
        "requestId": "req-1",
        "terminalId": "t1",
    }))
    .unwrap();
    assert!(matches!(created, ServerMessage::TerminalCreated(_)));

    let changed: ServerMessage = serde_json::from_value(json!({
        "type": "sessions.changed",
        "revision": 42,
    }))
    .unwrap();
    assert!(matches!(changed, ServerMessage::SessionsChanged(_)));
}

#[test]
fn ui_layout_sync_roundtrips_tab_name_source() {
    use freshell_protocol::client_messages::UiLayoutSync;

    let wire = json!({
        "type": "ui.layout.sync",
        "tabs": [
            { "id": "t1", "title": "Owned", "nameSource": { "kind": "session", "paneId": "p-agent" } },
            { "id": "t2", "title": "Legacy", "nameSource": { "kind": "legacy" } },
            { "id": "t3", "title": "Unresolved" },
        ],
        "activeTabId": "t1",
        "layouts": {},
        "activePane": {},
        "timestamp": 1,
    });
    let sync: UiLayoutSync = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(sync.tabs.len(), 3);
    assert_eq!(
        sync.tabs[0].name_source,
        Some(TabNameSource::Session {
            pane_id: "p-agent".into()
        })
    );
    assert_eq!(sync.tabs[1].name_source, Some(TabNameSource::Legacy));
    assert_eq!(sync.tabs[2].name_source, None, "absent stays absent");

    // Re-serialization keeps the field and elides it when absent (the mirror
    // payload stays byte-compatible for pre-Task-6 clients).
    let roundtripped = serde_json::to_value(&sync).unwrap();
    assert_eq!(
        roundtripped["tabs"][0]["nameSource"],
        json!({ "kind": "session", "paneId": "p-agent" })
    );
    assert_eq!(
        roundtripped["tabs"][1]["nameSource"],
        json!({ "kind": "legacy" })
    );
    assert!(
        roundtripped["tabs"][2].get("nameSource").is_none(),
        "an absent pointer must be omitted, never null: {roundtripped}"
    );
}
