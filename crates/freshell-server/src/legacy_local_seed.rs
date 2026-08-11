//! CFG-04: the `legacyLocalSettingsSeed` extraction/merge contract, ported from
//! `shared/settings.ts` (`extractLegacyLocalSettingsSeed` +
//! `normalizeExtractedLocalSeed` + the seed half of `mergeLocalSettings`).
//!
//! A legacy (pre-settings-split) `config.json` carries browser-local preferences
//! INSIDE `settings` (theme, uiScale, terminal font, sidebar presentation,
//! notification sound, ...). The legacy Node server
//! (`server/config-store.ts#ConfigStore.loadInternal`) extracts them once into a
//! top-level `legacyLocalSettingsSeed`, strips them from the live server-settings
//! tree, and serves the seed via `/api/bootstrap` so a fresh browser/WebView
//! profile can seed its local preferences exactly once (the client owns the
//! one-time marker; `src/lib/browser-preferences.ts`). This module owns the
//! pure extraction/merge half of that contract for the Rust server;
//! `crate::settings_store` owns the boot-time wiring.
//!
//! Fidelity: every test below pins output against the REAL legacy functions
//! executed via `tsx` on the frozen base (the "oracle battery"), including
//! byte-exact `JSON.stringify`-vs-`serde_json::to_string` comparisons — key
//! order (the workspace enables serde_json's `preserve_order`) and JS number
//! serialization (integral floats print as `1`, never `1.0`) are observable in
//! side-by-side operation with the legacy server on the same home, so they are
//! part of the contract, not an implementation detail.

use serde_json::{json, Map, Value};

/// `FRESH_AGENT_LOCAL_KEYS` (`shared/settings.ts`) — the only pick-list that
/// survives as a table; every other section's members are written out inline in
/// the extractor because each member carries its own normalization rule (enum /
/// clamp / typeof), and the inline sequence IS the pick list, in declaration
/// order.
const FRESH_AGENT_LOCAL_KEYS: [&str; 3] = ["showThinking", "showTools", "showTimecodes"];

const THEME_VALUES: [&str; 3] = ["system", "light", "dark"];
const TERMINAL_THEME_VALUES: [&str; 8] = [
    "auto",
    "dracula",
    "one-dark",
    "solarized-dark",
    "github-dark",
    "one-light",
    "solarized-light",
    "github-light",
];
const OSC52_CLIPBOARD_VALUES: [&str; 3] = ["ask", "always", "never"];
const TERMINAL_RENDERER_VALUES: [&str; 3] = ["auto", "webgl", "canvas"];
const TAB_ATTENTION_STYLE_VALUES: [&str; 4] = ["highlight", "pulse", "darken", "none"];
const ATTENTION_DISMISS_VALUES: [&str; 2] = ["click", "type"];
const SESSION_OPEN_MODE_VALUES: [&str; 2] = ["tab", "split"];
const SIDEBAR_SORT_MODE_VALUES: [&str; 4] = ["recency", "recency-pinned", "activity", "project"];
const WORKTREE_GROUPING_VALUES: [&str; 2] = ["repo", "worktree"];
const DECK_TILE_STYLE_VALUES: [&str; 2] = ["status-icons", "terminal-previews"];
const DECK_KEY_LAYOUT_VALUES: [&str; 3] = ["auto", "newest-first", "status-sorted"];

// Clamp ranges (`shared/settings.ts` constants).
const UI_SCALE_MIN: f64 = 0.75;
const UI_SCALE_MAX: f64 = 4.0;
const TERMINAL_FONT_SIZE_MIN: f64 = 12.0;
const TERMINAL_FONT_SIZE_MAX: f64 = 64.0;
const TERMINAL_LINE_HEIGHT_MIN: f64 = 1.0;
const TERMINAL_LINE_HEIGHT_MAX: f64 = 1.8;
const PANE_SNAP_THRESHOLD_MIN: f64 = 0.0;
const PANE_SNAP_THRESHOLD_MAX: f64 = 8.0;
const TAB_BAR_ROWS_MIN: f64 = 1.0;
const TAB_BAR_ROWS_MAX: f64 = 10.0;
const SIDEBAR_WIDTH_MIN: f64 = 200.0;
const SIDEBAR_WIDTH_MAX: f64 = 500.0;

pub fn extract_legacy_local_settings_seed(raw: &Value) -> Option<Value> {
    let obj = raw.as_object()?;

    let mut out: Map<String, Value> = Map::new();

    // theme / uiScale (top level, in the legacy normalize assignment order).
    if let Some(theme) = obj.get("theme").and_then(|v| enum_string(v, &THEME_VALUES)) {
        out.insert("theme".to_string(), theme);
    }
    if let Some(ui_scale) = normalize_clamped_number(obj.get("uiScale"), UI_SCALE_MIN, UI_SCALE_MAX)
    {
        out.insert("uiScale".to_string(), js_number(ui_scale));
    }

    if let Some(terminal) = obj.get("terminal").and_then(Value::as_object) {
        let mut section: Map<String, Value> = Map::new();
        if let Some(v) = normalize_rounded_clamped_number(
            terminal.get("fontSize"),
            TERMINAL_FONT_SIZE_MIN,
            TERMINAL_FONT_SIZE_MAX,
        ) {
            section.insert("fontSize".to_string(), js_number(v));
        }
        // `typeof === 'string'` — even an empty string survives (legacy fidelity).
        if let Some(v) = terminal.get("fontFamily").and_then(Value::as_str) {
            section.insert("fontFamily".to_string(), json!(v));
        }
        if let Some(v) = normalize_clamped_number(
            terminal.get("lineHeight"),
            TERMINAL_LINE_HEIGHT_MIN,
            TERMINAL_LINE_HEIGHT_MAX,
        ) {
            section.insert("lineHeight".to_string(), js_number(v));
        }
        if let Some(v) = terminal.get("cursorBlink").and_then(Value::as_bool) {
            section.insert("cursorBlink".to_string(), json!(v));
        }
        if let Some(v) = terminal
            .get("theme")
            .and_then(|v| enum_string(v, &TERMINAL_THEME_VALUES))
        {
            section.insert("theme".to_string(), v);
        }
        if let Some(v) = terminal.get("warnExternalLinks").and_then(Value::as_bool) {
            section.insert("warnExternalLinks".to_string(), json!(v));
        }
        if let Some(v) = terminal
            .get("osc52Clipboard")
            .and_then(|v| enum_string(v, &OSC52_CLIPBOARD_VALUES))
        {
            section.insert("osc52Clipboard".to_string(), v);
        }
        if let Some(v) = terminal
            .get("renderer")
            .and_then(|v| enum_string(v, &TERMINAL_RENDERER_VALUES))
        {
            section.insert("renderer".to_string(), v);
        }
        assign_section(&mut out, "terminal", section);
    }

    if let Some(panes) = obj.get("panes").and_then(Value::as_object) {
        let mut section: Map<String, Value> = Map::new();
        if let Some(v) = normalize_rounded_clamped_number(
            panes.get("snapThreshold"),
            PANE_SNAP_THRESHOLD_MIN,
            PANE_SNAP_THRESHOLD_MAX,
        ) {
            section.insert("snapThreshold".to_string(), js_number(v));
        }
        if let Some(v) = panes.get("iconsOnTabs").and_then(Value::as_bool) {
            section.insert("iconsOnTabs".to_string(), json!(v));
        }
        if let Some(v) = panes
            .get("tabAttentionStyle")
            .and_then(|v| enum_string(v, &TAB_ATTENTION_STYLE_VALUES))
        {
            section.insert("tabAttentionStyle".to_string(), v);
        }
        if let Some(v) = panes
            .get("attentionDismiss")
            .and_then(|v| enum_string(v, &ATTENTION_DISMISS_VALUES))
        {
            section.insert("attentionDismiss".to_string(), v);
        }
        if let Some(v) = panes
            .get("sessionOpenMode")
            .and_then(|v| enum_string(v, &SESSION_OPEN_MODE_VALUES))
        {
            section.insert("sessionOpenMode".to_string(), v);
        }
        if let Some(v) = panes.get("multirowTabs").and_then(Value::as_bool) {
            section.insert("multirowTabs".to_string(), json!(v));
        }
        if let Some(v) = panes.get("repoIconsOnTabs").and_then(Value::as_bool) {
            section.insert("repoIconsOnTabs".to_string(), json!(v));
        }
        if let Some(v) = normalize_rounded_clamped_number(
            panes.get("tabBarRows"),
            TAB_BAR_ROWS_MIN,
            TAB_BAR_ROWS_MAX,
        ) {
            section.insert("tabBarRows".to_string(), js_number(v));
        }
        assign_section(&mut out, "panes", section);
    }

    if let Some(sidebar) = obj.get("sidebar").and_then(Value::as_object) {
        // Present keys are picked raw (incl. null) and then normalized; the
        // `ignoreCodexSubagentSessions` legacy alias fills the canonical key
        // only when the canonical key is ABSENT (a present-but-invalid
        // canonical key suppresses the alias and drops — oracle-pinned).
        let mut section: Map<String, Value> = Map::new();
        if let Some(v) = sidebar.get("sortMode") {
            section.insert("sortMode".to_string(), normalize_local_sort_mode(v));
        }
        if let Some(v) = sidebar.get("worktreeGrouping") {
            section.insert(
                "worktreeGrouping".to_string(),
                normalize_worktree_grouping(v),
            );
        }
        if let Some(v) = sidebar.get("showProjectBadges").and_then(Value::as_bool) {
            section.insert("showProjectBadges".to_string(), json!(v));
        }
        if let Some(v) = sidebar.get("showSubagents").and_then(Value::as_bool) {
            section.insert("showSubagents".to_string(), json!(v));
        }
        let ignore_codex_subagents = sidebar
            .get("ignoreCodexSubagents")
            .and_then(Value::as_bool)
            .or_else(|| {
                if sidebar.contains_key("ignoreCodexSubagents") {
                    None
                } else {
                    sidebar
                        .get("ignoreCodexSubagentSessions")
                        .and_then(Value::as_bool)
                }
            });
        if let Some(v) = ignore_codex_subagents {
            section.insert("ignoreCodexSubagents".to_string(), json!(v));
        }
        if let Some(v) = sidebar
            .get("showNoninteractiveSessions")
            .and_then(Value::as_bool)
        {
            section.insert("showNoninteractiveSessions".to_string(), json!(v));
        }
        if let Some(v) = sidebar.get("hideEmptySessions").and_then(Value::as_bool) {
            section.insert("hideEmptySessions".to_string(), json!(v));
        }
        if let Some(v) = normalize_rounded_clamped_number(
            sidebar.get("width"),
            SIDEBAR_WIDTH_MIN,
            SIDEBAR_WIDTH_MAX,
        ) {
            section.insert("width".to_string(), js_number(v));
        }
        if let Some(v) = sidebar.get("collapsed").and_then(Value::as_bool) {
            section.insert("collapsed".to_string(), json!(v));
        }
        assign_section(&mut out, "sidebar", section);
    }

    // freshAgent local keys survive a legacy `agentChat` alias via a shallow
    // per-key alias-merge with the canonical `freshAgent` winning
    // (`migrateLegacyFreshAgentSettingsInput` restricted to the three local
    // boolean keys this seed can carry).
    let merged_fresh_agent = merge_alias_shallow(
        obj.get("agentChat").and_then(Value::as_object),
        obj.get("freshAgent").and_then(Value::as_object),
    );
    if let Some(fresh_agent) = merged_fresh_agent {
        let mut section: Map<String, Value> = Map::new();
        for key in FRESH_AGENT_LOCAL_KEYS {
            if let Some(v) = fresh_agent.get(key).and_then(Value::as_bool) {
                section.insert(key.to_string(), json!(v));
            }
        }
        assign_section(&mut out, "freshAgent", section);
    }

    if let Some(notifications) = obj.get("notifications").and_then(Value::as_object) {
        let mut section: Map<String, Value> = Map::new();
        if let Some(v) = notifications.get("soundEnabled").and_then(Value::as_bool) {
            section.insert("soundEnabled".to_string(), json!(v));
        }
        assign_section(&mut out, "notifications", section);
    }

    if let Some(stream_deck) = obj.get("streamDeck").and_then(Value::as_object) {
        let mut section: Map<String, Value> = Map::new();
        if let Some(v) = stream_deck.get("enabled").and_then(Value::as_bool) {
            section.insert("enabled".to_string(), json!(v));
        }
        // `brightness`/`idleBrightness`/`idleTimeoutSeconds` are typeof-checked
        // but deliberately NOT clamped on the legacy side.
        for key in ["brightness", "idleBrightness", "idleTimeoutSeconds"] {
            if let Some(v) = stream_deck.get(key).and_then(Value::as_f64) {
                if v.is_finite() {
                    section.insert(key.to_string(), js_number(v));
                }
            }
        }
        if let Some(v) = stream_deck
            .get("tileStyle")
            .and_then(|v| enum_string(v, &DECK_TILE_STYLE_VALUES))
        {
            section.insert("tileStyle".to_string(), v);
        }
        if let Some(v) = stream_deck
            .get("keyLayout")
            .and_then(|v| enum_string(v, &DECK_KEY_LAYOUT_VALUES))
        {
            section.insert("keyLayout".to_string(), v);
        }
        assign_section(&mut out, "streamDeck", section);
    }

    if out.is_empty() {
        None
    } else {
        Some(Value::Object(out))
    }
}

/// The seed merge of `config-store.ts#loadInternal`:
/// `stored ? mergeLocalSettings(extracted, stored) : extracted`. Both inputs are
/// already-normalized patches (or absent), so the full `mergeLocalSettings`
/// reduces to: start from extracted (key order kept), override `theme`/`uiScale`
/// when the stored patch owns them, and member-merge each section with the
/// stored patch's members winning (`mergeDefined`); empty sections vanish.
/// `mergeLocalSettings`'s sortMode/worktreeGrouping/freshAgent re-normalizations
/// are no-ops on already-normalized input and are intentionally not repeated.
pub fn merge_legacy_seeds(extracted: Option<&Value>, stored: Option<&Value>) -> Option<Value> {
    let Some(stored) = stored else {
        return extracted.cloned();
    };
    let stored_obj = stored.as_object();
    let mut out: Map<String, Value> = extracted
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(patch) = stored_obj {
        if let Some(v) = patch.get("theme") {
            out.insert("theme".to_string(), v.clone());
        }
        if let Some(v) = patch.get("uiScale") {
            out.insert("uiScale".to_string(), v.clone());
        }
        for section in [
            "terminal",
            "panes",
            "sidebar",
            "freshAgent",
            "notifications",
            "streamDeck",
        ] {
            let merged_section = merge_defined(
                out.get(section).and_then(Value::as_object),
                patch.get(section).and_then(Value::as_object),
            );
            if !merged_section.is_empty() {
                out.insert(section.to_string(), Value::Object(merged_section));
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(Value::Object(out))
    }
}

// ── helpers ────────────────────────────────────────────────────────────────

/// Legacy `clampNumber` (`Math.min(max, Math.max(min, value))`) behind the
/// `normalizeClampedNumber` typeof/finite gate; absent/wrong-typed → None.
fn normalize_clamped_number(value: Option<&Value>, min: f64, max: f64) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .map(|n| n.clamp(min, max))
}

/// `normalizeRoundedClampedNumber`: clamp, then `Math.round`.
fn normalize_rounded_clamped_number(value: Option<&Value>, min: f64, max: f64) -> Option<f64> {
    normalize_clamped_number(value, min, max).map(|n| n.round())
}

/// `z.enum(VALUES).safeParse(v).success ? v : dropped`. Only JSON strings
/// qualify (numbers/objects fail the parse identically on the Node side).
fn enum_string(value: &Value, allowed: &[&str]) -> Option<Value> {
    value
        .as_str()
        .filter(|s| allowed.contains(s))
        .map(|s| json!(s))
}

/// `normalizeLocalSortMode`: 'hybrid' → 'activity'; invalid (incl. null) →
/// 'activity'. The legacy assignment fires whenever the key is PRESENT —
/// including null — so this is a total function, not an Option.
fn normalize_local_sort_mode(value: &Value) -> Value {
    match value.as_str() {
        Some("hybrid") => json!("activity"),
        Some(s) if SIDEBAR_SORT_MODE_VALUES.contains(&s) => json!(s),
        _ => json!("activity"),
    }
}

/// `normalizeWorktreeGrouping`: invalid (incl. null) → 'repo'. Total function.
fn normalize_worktree_grouping(value: &Value) -> Value {
    match value.as_str() {
        Some(s) if WORKTREE_GROUPING_VALUES.contains(&s) => json!(s),
        _ => json!("repo"),
    }
}

/// JS `JSON.stringify` number parity: integral values persist as integers
/// (`1`, never `1.0`), non-integral as the shortest f64 form. serde_json's
/// `Value` distinguishes integer/float representations, so this conversion is
/// required for byte-stable side-by-side operation with the legacy server.
fn js_number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_992.0 {
        Value::from(n as i64)
    } else {
        Value::from(n)
    }
}

/// `maybeAssignNested`: an empty section is dropped, not persisted.
fn assign_section(out: &mut Map<String, Value>, key: &str, section: Map<String, Value>) {
    if !section.is_empty() {
        out.insert(key.to_string(), Value::Object(section));
    }
}

/// Shallow per-key alias merge `{...legacy, ...canonical}` (canonical wins),
/// restricted to object inputs (`readLegacyFreshAgentSettingsInput` +
/// `mergeFreshAgentAliasObjects` reduced to the semantics observable through
/// the three local boolean keys).
fn merge_alias_shallow(
    legacy: Option<&Map<String, Value>>,
    canonical: Option<&Map<String, Value>>,
) -> Option<Map<String, Value>> {
    if legacy.is_none() && canonical.is_none() {
        return None;
    }
    let mut merged = legacy.cloned().unwrap_or_default();
    if let Some(canonical) = canonical {
        for (k, v) in canonical {
            merged.insert(k.clone(), v.clone());
        }
    }
    Some(merged)
}

/// `mergeDefined(base, patch)` — `{...base}` overlaid with every patch entry
/// (JS `undefined` cannot occur in JSON, so every entry copies).
fn merge_defined(
    base: Option<&Map<String, Value>>,
    patch: Option<&Map<String, Value>>,
) -> Map<String, Value> {
    let mut merged = base.cloned().unwrap_or_default();
    if let Some(patch) = patch {
        for (k, v) in patch {
            merged.insert(k.clone(), v.clone());
        }
    }
    merged
}

#[cfg(test)]
mod tests {
    //! Every expectation below was produced by executing the REAL legacy
    //! `extractLegacyLocalSettingsSeed`/`mergeLocalSettings` (`shared/settings.ts`)
    //! under tsx on the frozen base and pasting its `JSON.stringify` output. Byte
    //! comparisons are `serde_json::to_string(result) == <oracle string>`.

    use super::*;

    fn extract(raw: Value) -> Option<Value> {
        extract_legacy_local_settings_seed(&raw)
    }

    fn as_json_string(value: &Value) -> String {
        serde_json::to_string(value).expect("serializable")
    }

    /// The crown jewel: a full legacy mixed config's seed, byte-identical to the
    /// legacy server's extraction (`JSON.stringify` on the Node side).
    #[test]
    fn full_mixed_seed_byte_matches_legacy() {
        let raw = json!({
            "theme": "light", "uiScale": 1.25,
            "terminal": { "scrollback": 4000, "fontSize": 18, "fontFamily": "Fira Code", "lineHeight": 1.4, "cursorBlink": false, "theme": "dracula", "warnExternalLinks": true, "osc52Clipboard": "always", "renderer": "canvas" },
            "panes": { "defaultNewPane": "shell", "snapThreshold": 3.6, "iconsOnTabs": true, "tabAttentionStyle": "pulse", "attentionDismiss": "type", "sessionOpenMode": "split", "multirowTabs": true, "repoIconsOnTabs": false, "tabBarRows": 5 },
            "sidebar": { "excludeFirstChatSubstrings": ["welcome"], "excludeFirstChatMustStart": false, "autoGenerateTitles": true, "sortMode": "project", "worktreeGrouping": "worktree", "showProjectBadges": false, "showSubagents": true, "ignoreCodexSubagents": true, "showNoninteractiveSessions": true, "hideEmptySessions": true, "width": 280, "collapsed": true },
            "freshAgent": { "showThinking": false, "showTools": true, "showTimecodes": true, "enabled": true },
            "notifications": { "soundEnabled": false },
            "streamDeck": { "enabled": true, "brightness": 2.5, "idleBrightness": 1, "idleTimeoutSeconds": 300, "tileStyle": "terminal-previews", "keyLayout": "newest-first" }
        });
        let seed = extract(raw).expect("seed extracted");
        assert_eq!(
            as_json_string(&seed),
            r#"{"theme":"light","uiScale":1.25,"terminal":{"fontSize":18,"fontFamily":"Fira Code","lineHeight":1.4,"cursorBlink":false,"theme":"dracula","warnExternalLinks":true,"osc52Clipboard":"always","renderer":"canvas"},"panes":{"snapThreshold":4,"iconsOnTabs":true,"tabAttentionStyle":"pulse","attentionDismiss":"type","sessionOpenMode":"split","multirowTabs":true,"repoIconsOnTabs":false,"tabBarRows":5},"sidebar":{"sortMode":"project","worktreeGrouping":"worktree","showProjectBadges":false,"showSubagents":true,"ignoreCodexSubagents":true,"showNoninteractiveSessions":true,"hideEmptySessions":true,"width":280,"collapsed":true},"freshAgent":{"showThinking":false,"showTools":true,"showTimecodes":true},"notifications":{"soundEnabled":false},"streamDeck":{"enabled":true,"brightness":2.5,"idleBrightness":1,"idleTimeoutSeconds":300,"tileStyle":"terminal-previews","keyLayout":"newest-first"}}"#
        );
    }

    /// Out-of-range numerics are CLAMPED, never dropped (legacy `clampNumber`);
    /// rounded members round (`snapThreshold` 3.6 -> 4 above; tabBarRows 0 -> min).
    #[test]
    fn clamps_min_side_byte_match() {
        let raw = json!({
            "uiScale": -5,
            "terminal": { "fontSize": 1_000_000, "lineHeight": 0.2 },
            "panes": { "snapThreshold": 99, "tabBarRows": 0 },
            "sidebar": { "width": 99999 }
        });
        let seed = extract(raw).expect("seed extracted");
        assert_eq!(
            as_json_string(&seed),
            r#"{"uiScale":0.75,"terminal":{"fontSize":64,"lineHeight":1},"panes":{"snapThreshold":8,"tabBarRows":1},"sidebar":{"width":500}}"#
        );
    }

    #[test]
    fn clamps_max_side_byte_match() {
        let raw = json!({
            "uiScale": 99,
            "terminal": { "fontSize": 1, "lineHeight": 9 },
            "panes": { "snapThreshold": -4, "tabBarRows": 99 },
            "sidebar": { "width": 1 }
        });
        let seed = extract(raw).expect("seed extracted");
        assert_eq!(
            as_json_string(&seed),
            r#"{"uiScale":4,"terminal":{"fontSize":12,"lineHeight":1.8},"panes":{"snapThreshold":0,"tabBarRows":10},"sidebar":{"width":200}}"#
        );
    }

    /// Invalid enum members are DROPPED; when nothing valid survives anywhere in
    /// the patch, the whole extraction is None (legacy `undefined`).
    #[test]
    fn invalid_enums_drop_leaving_none() {
        let raw = json!({
            "theme": "neon",
            "terminal": { "theme": "matrix", "renderer": "opengl", "osc52Clipboard": "sometimes" },
            "panes": { "tabAttentionStyle": "blink", "attentionDismiss": "hover", "sessionOpenMode": "drawer" },
            "streamDeck": { "tileStyle": "big", "keyLayout": "grid" }
        });
        assert_eq!(extract(raw), None);
    }

    /// `sortMode`/`worktreeGrouping` are DEFAULT-FILLED, not dropped, whenever the
    /// key is present: hybrid -> activity, unknown -> activity/repo, null ->
    /// activity/repo (legacy `hasOwn` + `normalizeLocalSortMode`).
    #[test]
    fn sort_mode_and_grouping_default_fill() {
        let hybrid =
            extract(json!({ "sidebar": { "sortMode": "hybrid", "worktreeGrouping": "banana" } }))
                .expect("seed extracted");
        assert_eq!(
            as_json_string(&hybrid),
            r#"{"sidebar":{"sortMode":"activity","worktreeGrouping":"repo"}}"#
        );
        let nulls = extract(json!({
            "theme": null, "terminal": null, "uiScale": null,
            "sidebar": { "sortMode": null, "width": null }
        }))
        .expect("seed extracted");
        assert_eq!(
            as_json_string(&nulls),
            r#"{"sidebar":{"sortMode":"activity"}}"#
        );
        let null_grouping =
            extract(json!({ "sidebar": { "worktreeGrouping": null } })).expect("seed extracted");
        assert_eq!(
            as_json_string(&null_grouping),
            r#"{"sidebar":{"worktreeGrouping":"repo"}}"#
        );
    }

    /// The `ignoreCodexSubagentSessions` legacy alias fills `ignoreCodexSubagents`
    /// ONLY when the canonical key is absent; a present-but-invalid canonical key
    /// suppresses the alias (and itself drops, yielding nothing).
    #[test]
    fn subagent_alias_semantics() {
        let alias = extract(json!({ "sidebar": { "ignoreCodexSubagentSessions": true } }))
            .expect("seed extracted");
        assert_eq!(
            as_json_string(&alias),
            r#"{"sidebar":{"ignoreCodexSubagents":true}}"#
        );
        let canonical_wins = extract(json!({
            "sidebar": { "ignoreCodexSubagentSessions": true, "ignoreCodexSubagents": false }
        }))
        .expect("seed extracted");
        assert_eq!(
            as_json_string(&canonical_wins),
            r#"{"sidebar":{"ignoreCodexSubagents":false}}"#
        );
        let canonical_invalid = extract(json!({
            "sidebar": { "ignoreCodexSubagentSessions": true, "ignoreCodexSubagents": "yes" }
        }));
        assert_eq!(canonical_invalid, None);
    }

    /// The `agentChat` -> `freshAgent` alias merges shallowly with canonical wins
    /// per key (`migrateLegacyFreshAgentSettingsInput`): `showThinking` comes from
    /// canonical (true), `showTools` survives from legacy (false).
    #[test]
    fn agent_chat_alias_canonical_wins_per_key() {
        let raw = json!({
            "agentChat": { "showThinking": false, "showTools": false, "enabled": true },
            "freshAgent": { "showThinking": true, "showTimecodes": true }
        });
        let seed = extract(raw).expect("seed extracted");
        assert_eq!(
            as_json_string(&seed),
            r#"{"freshAgent":{"showThinking":true,"showTools":false,"showTimecodes":true}}"#
        );
    }

    #[test]
    fn empty_and_non_object_inputs_yield_none() {
        assert_eq!(extract(json!({})), None);
        assert_eq!(extract(json!("not-an-object")), None);
        assert_eq!(extract(json!(null)), None);
        assert_eq!(extract(json!([])), None);
        assert_eq!(extract(json!({ "settings": {} })), None); // no local keys at top level
    }

    /// Wrong-typed members drop; if nothing remains, extraction is None.
    #[test]
    fn invalid_member_types_drop_leaving_none() {
        let raw = json!({
            "theme": 5, "uiScale": "big",
            "terminal": { "fontSize": "18", "fontFamily": null, "cursorBlink": "yes" },
            "notifications": { "soundEnabled": "no" }
        });
        assert_eq!(extract(raw), None);
    }

    /// JS number serialization: integral floats persist as integers (`1`, never
    /// `1.0`) — required for byte-stable side-by-side config operation with the
    /// legacy server (`JSON.stringify` number semantics).
    #[test]
    fn integral_floats_serialize_as_integers() {
        let raw = json!({
            "uiScale": 1.0,
            "terminal": { "fontSize": 18.0, "lineHeight": 1.0 },
            "panes": { "snapThreshold": 3.0 },
            "sidebar": { "width": 280.0 }
        });
        let seed = extract(raw).expect("seed extracted");
        assert_eq!(
            as_json_string(&seed),
            r#"{"uiScale":1,"terminal":{"fontSize":18,"lineHeight":1},"panes":{"snapThreshold":3},"sidebar":{"width":280}}"#
        );
    }

    /// `streamDeck` numerics are typeof-checked but NOT clamped.
    #[test]
    fn streamdeck_numbers_unclamped() {
        let seed =
            extract(json!({ "streamDeck": { "brightness": 2.5, "idleTimeoutSeconds": 12.75 } }))
                .expect("seed extracted");
        assert_eq!(
            as_json_string(&seed),
            r#"{"streamDeck":{"brightness":2.5,"idleTimeoutSeconds":12.75}}"#
        );
    }

    /// Canonically-ordered output regardless of input key order (the extract
    /// emits theme, uiScale, terminal, panes, sidebar, freshAgent, notifications,
    /// streamDeck — the legacy normalize function's assignment order).
    #[test]
    fn scrambled_input_emits_canonical_order() {
        let seed = extract(json!({
            "notifications": { "soundEnabled": false },
            "theme": "dark",
            "sidebar": { "sortMode": "project" }
        }))
        .expect("seed extracted");
        assert_eq!(
            as_json_string(&seed),
            r#"{"theme":"dark","sidebar":{"sortMode":"project"},"notifications":{"soundEnabled":false}}"#
        );
    }

    /// Node: `stored ? mergeLocalSettings(extracted, stored) : extracted` — the
    /// stored seed wins per key on conflict.
    #[test]
    fn merge_stored_wins_on_conflict() {
        let extracted = extract(json!({ "theme": "light", "uiScale": 1.5 }));
        let stored = extract(json!({ "theme": "dark" }));
        let merged = merge_legacy_seeds(extracted.as_ref(), stored.as_ref()).expect("merged");
        assert_eq!(as_json_string(&merged), r#"{"theme":"dark","uiScale":1.5}"#);
    }

    /// Sections merge member-wise; a base-only key keeps its position, patch-new
    /// top-level keys append in the legacy fixed order (theme before
    /// notifications), matching `mergeLocalSettings`'s assignment order.
    #[test]
    fn merge_sections_from_both_sides() {
        let extracted = extract(json!({ "terminal": { "fontSize": 20 } }));
        let stored =
            extract(json!({ "notifications": { "soundEnabled": false }, "theme": "dark" }));
        let merged = merge_legacy_seeds(extracted.as_ref(), stored.as_ref()).expect("merged");
        assert_eq!(
            as_json_string(&merged),
            r#"{"terminal":{"fontSize":20},"theme":"dark","notifications":{"soundEnabled":false}}"#
        );
    }

    /// With no stored seed, the extracted seed passes through
    /// (`config-store.ts:337-339`'s `stored ? merge : extracted`). With neither,
    /// the seed is None.
    #[test]
    fn merge_passthrough_and_empty() {
        let extracted = extract(json!({ "theme": "light" }));
        assert_eq!(
            merge_legacy_seeds(extracted.as_ref(), None),
            extracted.clone()
        );
        assert_eq!(merge_legacy_seeds(None, None), None);
    }
}
