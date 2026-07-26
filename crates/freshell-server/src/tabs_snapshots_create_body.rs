//! `pane_to_create_body` — extracted from `tabs_snapshots.rs` to honor the
//! 1,000-line file cap (port/AGENTS.md) when the createRequestId passthrough
//! was added. Included via `#[path]` from `tabs_snapshots.rs`, matching the
//! sibling pattern used by `tabs_snapshots_marker.rs` / `tabs_snapshots_tests.rs`.

use serde_json::{json, Value};

/// Map a snapshot pane to its `POST /api/tabs` body. Invalid session identity
/// fails before spawn; unsupported kinds are skips. Captured terminal, browser,
/// and editor options pass through to the restored pane.
pub(crate) fn pane_to_create_body(
    tab_name: Option<&Value>,
    pane: &Value,
) -> Result<Value, &'static str> {
    let payload = pane.get("payload").cloned().unwrap_or_else(|| json!({}));
    let kind = pane.get("kind").and_then(Value::as_str).unwrap_or("");
    let name = tab_name.cloned().unwrap_or(Value::Null);
    match kind {
        "terminal" => {
            let mode = payload
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or("shell");
            let mut b = json!({ "mode": mode, "name": name });
            if let Some(cwd) = payload.get("initialCwd").filter(|v| v.is_string()) {
                b["cwd"] = cwd.clone();
            }
            if let Some(shell) = payload.get("shell").filter(|v| v.is_string()) {
                b["shell"] = shell.clone();
            }
            // Stable pane identity key (reconciliation design §5.5): restore
            // re-creates the pane under its CAPTURED key so server-side state
            // keyed on it survives; absent on legacy snapshots (the REST
            // ingress mints one in that case).
            if let Some(crid) = payload.get("createRequestId").filter(|v| v.is_string()) {
                b["createRequestId"] = crid.clone();
            }
            if let Some(cd) = payload.get("codexDurability").filter(|v| v.is_object()) {
                if mode == "codex" {
                    b["codexDurability"] = cd.clone();
                }
            }
            // Present identity must be nonempty and match the terminal mode.
            if let Some(sref) = payload.get("sessionRef").filter(|v| !v.is_null()) {
                let ok = sref.is_object()
                    && sref.get("provider").and_then(Value::as_str) == Some(mode)
                    && sref
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .is_some_and(|s| !s.is_empty());
                if !ok {
                    return Err("session-identity-mismatch");
                }
                b["sessionRef"] = sref.clone();
            }
            Ok(b)
        }
        "browser" => match payload.get("url").and_then(Value::as_str) {
            Some(url) => {
                let mut b = json!({ "browser": url, "name": name });
                if let Some(dt) = payload.get("devToolsOpen").filter(|v| v.is_boolean()) {
                    b["devToolsOpen"] = dt.clone();
                }
                Ok(b)
            }
            None => Err("missing-url"),
        },
        "editor" => match payload.get("filePath") {
            Some(file_path) if file_path.is_string() || file_path.is_null() => {
                let mut b = json!({ "editor": file_path, "name": name });
                if let Some(lang) = payload.get("language").filter(|v| v.is_string()) {
                    b["language"] = lang.clone();
                }
                if let Some(ro) = payload.get("readOnly").filter(|v| v.is_boolean()) {
                    b["readOnly"] = ro.clone();
                }
                if let Some(vm) = payload.get("viewMode").filter(|v| v.is_string()) {
                    b["viewMode"] = vm.clone();
                }
                if let Some(ww) = payload.get("wordWrap").filter(|v| v.is_boolean()) {
                    b["wordWrap"] = ww.clone();
                }
                Ok(b)
            }
            _ => Err("missing-filePath"),
        },
        _ => Err("unsupported-kind"),
    }
}
