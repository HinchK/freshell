//! ejh6 Task 1: the shared frozen refusal text is byte-exact and lives in
//! freshell-protocol so both freshell-freshagent and freshell-ws reference
//! one source of truth.
use freshell_protocol::LEGACY_RESUME_IDENTITY_REFUSAL;

#[test]
fn legacy_reject_frozen_text() {
    assert_eq!(
        LEGACY_RESUME_IDENTITY_REFUSAL,
        "Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."
    );
}
