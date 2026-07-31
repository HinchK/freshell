//! First direct unit tests for derive_launch_prep (it previously had only
//! indirect integration coverage). Pins the ORIGIN semantics of
//! LaunchPrep.resume_id_from_wire: true only for wire-derived resume ids,
//! false for BOTH server-prealloc arms (claude fresh prealloc AND the
//! amplifier launcher-assigned identity) and for mode == "shell".
use super::*;

fn create_from_json(v: serde_json::Value) -> TerminalCreate {
    serde_json::from_value(v).expect("valid TerminalCreate json")
}

#[test]
fn wire_session_ref_restore_is_from_wire() {
    let create = create_from_json(serde_json::json!({
        "requestId": "r-wire-ref",
        "mode": "codex",
        "shell": "system",
        "restore": true,
        "sessionRef": { "provider": "codex", "sessionId": "stale-codex-id" }
    }));
    let prep = derive_launch_prep(&create, "codex");
    assert!(
        prep.resume_id_from_wire,
        "sessionRef carrier is wire-originated"
    );
    assert_eq!(prep.resume_session_id.as_deref(), Some("stale-codex-id"));
    assert!(!prep.claude_fresh_prealloc);
    assert!(matches!(prep.launch_intent, LaunchIntent::Resume));
}

#[test]
fn wire_legacy_resume_session_id_is_from_wire() {
    let create = create_from_json(serde_json::json!({
        "requestId": "r-wire-legacy",
        "mode": "amplifier",
        "shell": "system",
        "restore": true,
        "resumeSessionId": "stale-amp-id"
    }));
    let prep = derive_launch_prep(&create, "amplifier");
    assert!(
        prep.resume_id_from_wire,
        "legacy resumeSessionId carrier is wire-originated"
    );
    assert_eq!(prep.resume_session_id.as_deref(), Some("stale-amp-id"));
}

#[test]
fn claude_fresh_prealloc_is_server_allocated_not_wire() {
    let create = create_from_json(serde_json::json!({
        "requestId": "r-claude-fresh",
        "mode": "claude",
        "shell": "system"
    }));
    let prep = derive_launch_prep(&create, "claude");
    assert!(prep.claude_fresh_prealloc);
    assert!(matches!(prep.launch_intent, LaunchIntent::Start));
    let minted = prep.resume_session_id.expect("prealloc mints a fresh id");
    uuid::Uuid::parse_str(&minted).expect("minted id is a uuid");
    assert!(
        !prep.resume_id_from_wire,
        "server-preallocated claude id must NEVER be gate-eligible"
    );
}

#[test]
fn amplifier_fresh_prealloc_is_server_allocated_not_wire() {
    // THE TRAP CASE: amplifier prealloc mints a server id while
    // claude_fresh_prealloc stays false — the flag must still be false.
    let create = create_from_json(serde_json::json!({
        "requestId": "r-amp-fresh",
        "mode": "amplifier",
        "shell": "system"
    }));
    let prep = derive_launch_prep(&create, "amplifier");
    assert!(!prep.claude_fresh_prealloc);
    assert!(matches!(prep.launch_intent, LaunchIntent::Resume));
    let minted = prep
        .resume_session_id
        .expect("amplifier prealloc mints a fresh id");
    uuid::Uuid::parse_str(&minted).expect("minted id is a uuid");
    assert!(
        !prep.resume_id_from_wire,
        "server-minted amplifier id must NEVER be gate-eligible"
    );
}

#[test]
fn shell_mode_is_never_from_wire() {
    let create = create_from_json(serde_json::json!({
        "requestId": "r-shell",
        "mode": "shell",
        "shell": "system"
    }));
    let prep = derive_launch_prep(&create, "shell");
    assert!(!prep.resume_id_from_wire);
    assert!(prep.resume_session_id.is_none());
}
