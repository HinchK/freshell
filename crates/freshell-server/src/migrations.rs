//! One-time boot migrations ported from Node's `startBackgroundTasks()`
//! (`server/index.ts:1039-1054`). Exactly one exists today:
//! `ai-title-shadow-cleanup`. Marker I/O lives on `SettingsStore`
//! (`is_migration_done` / `mark_migration_done`) because the config path and
//! `ConfigLock` are private to `settings_store.rs`.

use serde_json::Value;

/// Node's authoritative-title provider set: providers whose sessions always
/// carry their own AI-generated title. Derived in Node from
/// `providesAuthoritativeTitle()` -- amplifier is the ONLY implementer
/// (`server/coding-cli/providers/amplifier.ts:319-323`); Claude is NOT in
/// the set. Hardcoded: one implementer on both sides, a capability trait
/// would be speculative generality.
pub const AUTHORITATIVE_TITLE_PROVIDERS: [&str; 1] = ["amplifier"];

/// The migration id / `completedMigrations` marker string.
pub const AI_TITLE_SHADOW_CLEANUP: &str = "ai-title-shadow-cleanup";

/// Port of `overrideKeysToClear`
/// (`server/coding-cli/provider-title-cleanup.ts:17-30`). A key qualifies
/// when ALL hold: its provider (parsed from the composite key; a key with no
/// ':' is legacy provider "claude", `types.ts:122-131`, never authoritative)
/// is in `authoritative`; the row carries a truthy `titleOverride` (absent /
/// null / "" all disqualify -- JS truthiness); and `titleSource != "user"`
/// (absent titleSource ALSO qualifies). Explicit user renames are always
/// preserved.
pub fn override_keys_to_clear(
    session_overrides: &serde_json::Map<String, Value>,
    authoritative: &[&str],
) -> Vec<String> {
    let mut keys = Vec::new();
    for (key, row) in session_overrides {
        let provider = match key.split_once(':') {
            Some((p, _)) => p,
            None => "claude",
        };
        if !authoritative.contains(&provider) {
            continue;
        }
        let has_title = row
            .get("titleOverride")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty());
        if !has_title {
            continue;
        }
        if row.get("titleSource").and_then(Value::as_str) == Some("user") {
            continue;
        }
        keys.push(key.clone());
    }
    keys
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn overrides(v: Value) -> serde_json::Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    // Ports of test/unit/server/coding-cli/provider-title-cleanup.test.ts
    // (4 cases) plus the two edge cases Node's parser implies.

    #[test]
    fn clears_authoritative_auto_written_titles() {
        let ov = overrides(json!({
            "amplifier:a1": { "titleOverride": "Auto", "titleSource": "ai" }
        }));
        assert_eq!(
            override_keys_to_clear(&ov, &AUTHORITATIVE_TITLE_PROVIDERS),
            vec!["amplifier:a1".to_string()]
        );
    }

    #[test]
    fn skips_non_authoritative_provider() {
        let ov = overrides(json!({
            "claude:c1": { "titleOverride": "Auto", "titleSource": "ai" }
        }));
        assert!(override_keys_to_clear(&ov, &AUTHORITATIVE_TITLE_PROVIDERS).is_empty());
    }

    #[test]
    fn skips_user_renames() {
        let ov = overrides(json!({
            "amplifier:a1": { "titleOverride": "Mine", "titleSource": "user" }
        }));
        assert!(override_keys_to_clear(&ov, &AUTHORITATIVE_TITLE_PROVIDERS).is_empty());
    }

    #[test]
    fn skips_rows_without_title_override() {
        let ov = overrides(json!({
            "amplifier:a1": { "titleSource": "ai" },
            "amplifier:a2": { "titleOverride": "", "titleSource": "ai" },
            "amplifier:a3": { "titleOverride": null, "titleSource": "ai" }
        }));
        assert!(override_keys_to_clear(&ov, &AUTHORITATIVE_TITLE_PROVIDERS).is_empty());
    }

    #[test]
    fn absent_title_source_still_qualifies() {
        let ov = overrides(json!({
            "amplifier:a1": { "titleOverride": "Auto" }
        }));
        assert_eq!(
            override_keys_to_clear(&ov, &AUTHORITATIVE_TITLE_PROVIDERS),
            vec!["amplifier:a1".to_string()]
        );
    }

    #[test]
    fn legacy_unprefixed_key_parses_as_claude_and_is_skipped() {
        let ov = overrides(json!({
            "legacykey": { "titleOverride": "Auto", "titleSource": "ai" }
        }));
        assert!(override_keys_to_clear(&ov, &AUTHORITATIVE_TITLE_PROVIDERS).is_empty());
    }
}
