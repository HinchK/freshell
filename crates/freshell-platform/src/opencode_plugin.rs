//! Freshell's opencode TUI rebind plugin: embedded source and idempotent
//! install of TWO freshell-owned files into ~/.freshell/opencode/ — the
//! plugin itself and a plugin-only tui.json pointing at it. The tui.json
//! is injected per-pane via OPENCODE_TUI_CONFIG (cli_launch.rs); TUI config
//! sources merge and plugin arrays union, so a plugin-only file can never
//! shadow the user's own TUI config.

use std::io::Write;
use std::path::{Path, PathBuf};

/// The TUI plugin shipped with freshell (single source of truth lives in the
/// repo at extensions/opencode/freshell-rebind-plugin.ts; embedded at compile
/// time so the Rust server needs no runtime lookup).
pub const REBIND_PLUGIN_SOURCE: &str =
    include_str!("../../../extensions/opencode/freshell-rebind-plugin.ts");

pub fn rebind_plugin_path(home: &Path) -> PathBuf {
    home.join(".freshell")
        .join("opencode")
        .join("freshell-rebind-plugin.ts")
}

/// The freshell-owned TUI config injected per-pane via OPENCODE_TUI_CONFIG.
/// Lives under ~/.freshell/opencode/ — deliberately NOT an ancestor of any
/// pane cwd (opencode's project tui.json discovery walks up to `/`).
pub fn tui_config_path(home: &Path) -> PathBuf {
    home.join(".freshell").join("opencode").join("tui.json")
}

/// `file://` spec for the tui.json `plugin` array. Unix: `file:///abs`.
/// Windows drive paths get forward slashes and a third slash.
pub fn plugin_file_spec(plugin_path: &Path) -> String {
    let s = plugin_path.display().to_string().replace('\\', "/");
    if s.starts_with('/') {
        format!("file://{s}")
    } else {
        format!("file:///{s}")
    }
}

/// Exactly `{"plugin":[<spec>]}` — the plugin key and NOTHING else. TUI
/// config sources MERGE and plugin arrays UNION (dedup by file URL), so
/// this single-key file can never shadow the user's global/project
/// tui.json (validated on opencode 1.18.8/1.18.9, report V7). Load-bearing:
/// never add another key (pinned by unit test).
pub fn tui_config_content(plugin_path: &Path) -> String {
    serde_json::json!({ "plugin": [plugin_file_spec(plugin_path)] }).to_string()
}

fn write_atomic_if_changed(path: &Path, content: &str) -> std::io::Result<()> {
    if let Ok(existing) = std::fs::read_to_string(path) {
        if existing == content {
            return Ok(());
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

/// Idempotently materialize BOTH freshell-owned files into
/// `~/.freshell/opencode/`: the plugin source and the plugin-only tui.json
/// pointing at it. Atomic (tmp + rename); rewrites only when content
/// differs, so a running opencode never observes a torn file. Returns the
/// tui.json path — the value cli_launch.rs injects as OPENCODE_TUI_CONFIG.
/// Bun caches failed imports for the process lifetime, so this MUST run
/// (and succeed) before the TUI launches.
pub fn ensure_rebind_plugin_installed(home: &Path) -> std::io::Result<PathBuf> {
    let plugin = rebind_plugin_path(home);
    write_atomic_if_changed(&plugin, REBIND_PLUGIN_SOURCE)?;
    let tui_json = tui_config_path(home);
    write_atomic_if_changed(&tui_json, &tui_config_content(&plugin))?;
    Ok(tui_json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn plugin_source_is_embedded_and_nonempty() {
        assert!(REBIND_PLUGIN_SOURCE.contains("freshell-rebind"));
        assert!(REBIND_PLUGIN_SOURCE.contains("session-signals"));
    }

    #[test]
    fn install_writes_both_files_idempotently_and_heals_content_drift() {
        let home = tempfile::tempdir().unwrap();
        let tui_json = ensure_rebind_plugin_installed(home.path()).unwrap();
        assert_eq!(tui_json, tui_config_path(home.path()));
        let plugin = rebind_plugin_path(home.path());
        assert_eq!(
            std::fs::read_to_string(&plugin).unwrap(),
            REBIND_PLUGIN_SOURCE
        );
        assert_eq!(
            std::fs::read_to_string(&tui_json).unwrap(),
            tui_config_content(&plugin)
        );
        // Second call: no error, same content.
        ensure_rebind_plugin_installed(home.path()).unwrap();
        // Drifted content is healed (both files).
        std::fs::write(&plugin, "tampered").unwrap();
        std::fs::write(&tui_json, "tampered").unwrap();
        ensure_rebind_plugin_installed(home.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(&plugin).unwrap(),
            REBIND_PLUGIN_SOURCE
        );
        assert_eq!(
            std::fs::read_to_string(&tui_json).unwrap(),
            tui_config_content(&plugin)
        );
    }

    #[test]
    fn tui_config_content_is_exactly_the_plugin_key_and_nothing_else() {
        let content = tui_config_content(Path::new("/h/.freshell/opencode/p.ts"));
        let v: serde_json::Value = serde_json::from_str(&content).unwrap();
        // ONLY the plugin key — TUI config sources MERGE (scalar keys:
        // later-order source wins) and plugin arrays UNION, so a plugin-only
        // file can never shadow the user's own tui.json (plan Scope
        // Decision 5 / validation report V7). This pin is load-bearing:
        // never add another key.
        let obj = v.as_object().unwrap();
        assert_eq!(obj.len(), 1);
        assert_eq!(
            v["plugin"],
            serde_json::json!(["file:///h/.freshell/opencode/p.ts"])
        );
    }

    #[test]
    fn file_spec_is_a_file_url() {
        assert_eq!(
            plugin_file_spec(Path::new("/a/b c/p.ts")),
            "file:///a/b c/p.ts"
        );
    }
}
