//! Best-effort resolution of the user's active Amplifier bundle
//! (`bundle.active`) from Amplifier's merged settings files.
//!
//! Mirrors the Amplifier CLI's merged-settings precedence (later wins):
//!   1. `<amplifier_home>/settings.yaml`                 (global, ~/.amplifier)
//!   2. `<working_dir>/.amplifier/settings.yaml`         (project)
//!   3. `<working_dir>/.amplifier/settings.local.yaml`   (project-local)
//!
//! Known, deliberate divergences from the CLI (ledger A1/A10): the CLI
//! deep-merges layers and silently SKIPS malformed ones; we treat any
//! malformed layer — and any multi-document file, which the CLI's own
//! parser also rejects — as a Surprise poisoning the whole resolution.
//! Both divergences only ever push toward omission (the safe direction).
//!
//! HARD SAFETY RULE (adversarial review): return a value ONLY when it is a
//! plain non-empty YAML string scalar. On ANY surprise — an existing but
//! unreadable settings file, unparseable YAML, a `bundle.active` that is
//! present but not a plain non-empty string — return `None` for the WHOLE
//! resolution (not just that layer). A missing stamp is healed by
//! Amplifier's own default resolution; a WRONG stamp would be trusted
//! forever, so the risk is asymmetric and we bias hard toward omission.
//! Never fails or delays the caller: every error collapses to `None`.
//!
//! The TS twin lives in `scripts/amplifier-backfill-bundle.ts`
//! (`resolveActiveBundle`) — the two runtimes share no code, so keep the
//! semantics and their test matrices mirrored.

use saphyr::{LoadableYamlNode, Yaml};
use std::path::Path;

/// One settings layer's contribution to `bundle.active`.
enum Layer {
    /// File absent — the layer contributes nothing (normal).
    Absent,
    /// File present and parseable, but no `bundle.active` string reachable
    /// (missing key, empty doc, non-mapping doc/bundle) — no contribution.
    NoKey,
    /// A plain non-empty string scalar (trimmed).
    Value(String),
    /// Anything suspicious: existing-but-unreadable file, unparseable YAML,
    /// or `bundle.active` present but not a plain non-empty string.
    /// Poisons the WHOLE resolution (HARD SAFETY RULE).
    Surprise,
}

fn read_layer(path: &Path) -> Layer {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Layer::Absent,
        Err(_) => return Layer::Surprise,
    };
    let docs = match Yaml::load_from_str(&raw) {
        Ok(docs) => docs,
        Err(_) => return Layer::Surprise,
    };
    if docs.len() > 1 {
        // Multi-document settings: the CLI's own parser errors on these (and
        // silently skips the layer). Taking the first doc could stamp a value
        // the CLI would never resolve — Surprise (ledger A10).
        return Layer::Surprise;
    }
    let Some(doc) = docs.first() else {
        return Layer::NoKey; // empty file — nothing to contribute
    };
    let Some(bundle) = doc.as_mapping_get("bundle") else {
        return Layer::NoKey; // no `bundle` key (or doc is not a mapping)
    };
    let Some(active) = bundle.as_mapping_get("active") else {
        return Layer::NoKey; // `bundle` has no `active` (or is not a mapping)
    };
    match active.as_str() {
        Some(s) if !s.trim().is_empty() => Layer::Value(s.trim().to_string()),
        // Present but empty, or a non-string scalar / sequence / mapping.
        _ => Layer::Surprise,
    }
}

/// Resolve the user's active Amplifier bundle for a session created under
/// `working_dir`. `amplifier_home` is the global settings root the caller
/// already resolved (`~/.amplifier` in production, a temp dir in tests).
/// Returns the bare bundle name (e.g. `"foundation"`) or `None` when
/// nothing resolves safely.
pub fn resolve_active_bundle(amplifier_home: &Path, working_dir: &Path) -> Option<String> {
    let layers = [
        amplifier_home.join("settings.yaml"),
        working_dir.join(".amplifier").join("settings.yaml"),
        working_dir.join(".amplifier").join("settings.local.yaml"),
    ];
    let mut winner: Option<String> = None;
    for path in &layers {
        match read_layer(path) {
            Layer::Absent | Layer::NoKey => {}
            Layer::Value(v) => winner = Some(v),
            Layer::Surprise => return None,
        }
    }
    winner
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn unique_temp_dir(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("amp-bundle-{label}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, contents: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    #[test]
    fn resolves_from_global_settings_only() {
        let home = unique_temp_dir("global-only-home");
        let cwd = unique_temp_dir("global-only-cwd");
        write(
            &home.join("settings.yaml"),
            "bundle:\n  active: foundation\n",
        );

        assert_eq!(
            resolve_active_bundle(&home, &cwd),
            Some("foundation".to_string())
        );
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn project_settings_override_global() {
        let home = unique_temp_dir("proj-wins-home");
        let cwd = unique_temp_dir("proj-wins-cwd");
        write(
            &home.join("settings.yaml"),
            "bundle:\n  active: foundation\n",
        );
        write(
            &cwd.join(".amplifier").join("settings.yaml"),
            "bundle:\n  active: project-bundle\n",
        );

        assert_eq!(
            resolve_active_bundle(&home, &cwd),
            Some("project-bundle".to_string())
        );
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn local_settings_override_project_and_global() {
        let home = unique_temp_dir("local-wins-home");
        let cwd = unique_temp_dir("local-wins-cwd");
        write(
            &home.join("settings.yaml"),
            "bundle:\n  active: foundation\n",
        );
        write(
            &cwd.join(".amplifier").join("settings.yaml"),
            "bundle:\n  active: project-bundle\n",
        );
        write(
            &cwd.join(".amplifier").join("settings.local.yaml"),
            "bundle:\n  active: local-bundle\n",
        );

        assert_eq!(
            resolve_active_bundle(&home, &cwd),
            Some("local-bundle".to_string())
        );
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn missing_files_resolve_to_none() {
        let home = unique_temp_dir("missing-home");
        let cwd = unique_temp_dir("missing-cwd");
        // No settings file at any layer -> nothing to stamp.
        assert_eq!(resolve_active_bundle(&home, &cwd), None);
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn garbage_yaml_in_any_existing_layer_poisons_the_whole_resolution() {
        // A valid global answer must NOT survive a later broken layer: we
        // can no longer faithfully mirror what Amplifier's own merge would
        // do, so the HARD SAFETY RULE says omit entirely.
        let home = unique_temp_dir("garbage-home");
        let cwd = unique_temp_dir("garbage-cwd");
        write(
            &home.join("settings.yaml"),
            "bundle:\n  active: foundation\n",
        );
        write(
            &cwd.join(".amplifier").join("settings.local.yaml"),
            "bundle: [unclosed",
        );

        assert_eq!(resolve_active_bundle(&home, &cwd), None);
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn non_string_bundle_active_poisons_the_whole_resolution() {
        let home = unique_temp_dir("nonstring-home");
        let cwd = unique_temp_dir("nonstring-cwd");
        write(
            &home.join("settings.yaml"),
            "bundle:\n  active: foundation\n",
        );
        write(
            &cwd.join(".amplifier").join("settings.yaml"),
            "bundle:\n  active: true\n",
        );

        assert_eq!(resolve_active_bundle(&home, &cwd), None);
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn empty_string_bundle_active_poisons_the_whole_resolution() {
        let home = unique_temp_dir("empty-home");
        let cwd = unique_temp_dir("empty-cwd");
        write(&home.join("settings.yaml"), "bundle:\n  active: \"\"\n");

        assert_eq!(resolve_active_bundle(&home, &cwd), None);
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn layer_without_the_key_does_not_clear_an_earlier_winner() {
        // A later settings file that simply has no bundle.active is normal
        // layering (it contributes nothing) — NOT a surprise.
        let home = unique_temp_dir("nokey-home");
        let cwd = unique_temp_dir("nokey-cwd");
        write(
            &home.join("settings.yaml"),
            "bundle:\n  active: foundation\n",
        );
        write(
            &cwd.join(".amplifier").join("settings.yaml"),
            "ui:\n  theme: dark\n",
        );

        assert_eq!(
            resolve_active_bundle(&home, &cwd),
            Some("foundation".to_string())
        );
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn scalar_bundle_key_contributes_nothing() {
        // `bundle: foundation` (scalar, not a mapping) has no `active` key
        // path — Amplifier's own `bundle.active` lookup would find nothing
        // either, so this layer contributes nothing (it is not a surprise).
        let home = unique_temp_dir("scalar-home");
        let cwd = unique_temp_dir("scalar-cwd");
        write(&home.join("settings.yaml"), "bundle: foundation\n");

        assert_eq!(resolve_active_bundle(&home, &cwd), None);
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn multi_document_settings_poison_the_whole_resolution() {
        // The CLI's own parser errors on multi-document settings files (and
        // silently skips the layer); taking the first document could stamp
        // a value the CLI would never resolve. Surprise -> omit (ledger A10).
        let home = unique_temp_dir("multidoc-home");
        let cwd = unique_temp_dir("multidoc-cwd");
        write(
            &home.join("settings.yaml"),
            "bundle:\n  active: foundation\n---\nbundle:\n  active: other\n",
        );

        assert_eq!(resolve_active_bundle(&home, &cwd), None);
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn duplicate_active_keys_use_the_last_value() {
        // saphyr resolves duplicate mapping keys last-wins (verified against
        // the pinned crate); the TS twin passes `uniqueKeys: false` to match
        // (ledger A10) — keep both matrices pinned to this behavior.
        let home = unique_temp_dir("dupkey-home");
        let cwd = unique_temp_dir("dupkey-cwd");
        write(
            &home.join("settings.yaml"),
            "bundle:\n  active: one\n  active: two\n",
        );

        assert_eq!(resolve_active_bundle(&home, &cwd), Some("two".to_string()));
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&cwd);
    }
}
