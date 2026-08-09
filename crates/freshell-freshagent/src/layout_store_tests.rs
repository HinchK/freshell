//! Port anchors: `test/unit/server/agent-layout-store.test.ts` (read surface).

use serde_json::json;

use super::*;

fn sync(
    tabs: serde_json::Value,
    layouts: serde_json::Value,
    active_pane: serde_json::Value,
    active_tab_id: Option<&str>,
    pane_titles: Option<serde_json::Value>,
    pane_title_set_by_user: Option<serde_json::Value>,
    timestamp: i64,
) -> UiLayoutSync {
    UiLayoutSync {
        tabs: serde_json::from_value(tabs).expect("tabs parse"),
        layouts,
        active_pane: serde_json::from_value(active_pane).expect("active_pane parses"),
        timestamp,
        active_tab_id: active_tab_id.map(|s| Some(s.to_string())),
        pane_title_set_by_user,
        pane_titles,
    }
}

/// The `snapshot` fixture from agent-layout-store.test.ts.
fn basic_snapshot(ts: i64) -> UiLayoutSync {
    sync(
        json!([{ "id": "tab_a", "title": "alpha" }]),
        json!({
            "tab_a": {
                "type": "leaf",
                "id": "pane_1",
                "content": { "kind": "terminal", "terminalId": "term_1" },
            }
        }),
        json!({ "tab_a": "pane_1" }),
        Some("tab_a"),
        None,
        None,
        ts,
    )
}

#[test]
fn never_fed_snapshot_is_the_legacy_six_key_empty_shape() {
    let store = LayoutStore::new();
    let snap = store.get_normalized_snapshot(None);
    // Legacy emptySnapshot(): exactly these six keys, no `timestamp`.
    assert_eq!(
        snap,
        json!({
            "tabs": [],
            "activeTabId": null,
            "layouts": {},
            "activePane": {},
            "paneTitles": {},
            "paneTitleSetByUser": {},
        })
    );
}

#[test]
fn update_from_ui_then_full_snapshot_echoes_everything() {
    let store = LayoutStore::new();
    store.update_from_ui(&basic_snapshot(1_720_000_000_000), "conn1");
    assert_eq!(
        store.get_normalized_snapshot(None),
        json!({
            "tabs": [{ "id": "tab_a", "title": "alpha" }],
            "activeTabId": "tab_a",
            "layouts": {
                "tab_a": {
                    "type": "leaf",
                    "id": "pane_1",
                    "content": { "kind": "terminal", "terminalId": "term_1" },
                }
            },
            "activePane": { "tab_a": "pane_1" },
            "paneTitles": {},
            "paneTitleSetByUser": {},
            "timestamp": 1_720_000_000_000_i64,
        })
    );
}

#[test]
fn filtered_snapshot_narrows_to_one_tab_with_timestamp() {
    let store = LayoutStore::new();
    store.update_from_ui(
        &sync(
            json!([{ "id": "tab_a", "title": "alpha" }, { "id": "tab_b", "title": "beta" }]),
            json!({
                "tab_a": { "type": "leaf", "id": "pane_a", "content": { "kind": "terminal", "terminalId": "term_a" } },
                "tab_b": { "type": "leaf", "id": "pane_b", "content": { "kind": "terminal", "terminalId": "term_b" } },
            }),
            json!({ "tab_a": "pane_a", "tab_b": "pane_b" }),
            Some("tab_b"),
            Some(json!({ "tab_a": { "pane_a": "Alpha pane" }, "tab_b": { "pane_b": "Beta pane" } })),
            Some(json!({ "tab_a": { "pane_a": true }, "tab_b": { "pane_b": true } })),
            42,
        ),
        "conn1",
    );
    assert_eq!(
        store.get_normalized_snapshot(Some("tab_b")),
        json!({
            "tabs": [{ "id": "tab_b", "title": "beta" }],
            "activeTabId": "tab_b",
            "layouts": {
                "tab_b": { "type": "leaf", "id": "pane_b", "content": { "kind": "terminal", "terminalId": "term_b" } },
            },
            "activePane": { "tab_b": "pane_b" },
            "paneTitles": { "tab_b": { "pane_b": "Beta pane" } },
            "paneTitleSetByUser": { "tab_b": { "pane_b": true } },
            "timestamp": 42,
        })
    );
}

#[test]
fn filtered_snapshot_for_missing_tab_is_empty_shape_but_keeps_timestamp() {
    let store = LayoutStore::new();
    store.update_from_ui(&basic_snapshot(7), "conn1");
    // Legacy: the filtered form always carries `timestamp` when the fed
    // snapshot has one (`layout-store.ts:208`), even when the tab is missing.
    assert_eq!(
        store.get_normalized_snapshot(Some("missing")),
        json!({
            "tabs": [],
            "activeTabId": null,
            "layouts": {},
            "activePane": {},
            "paneTitles": {},
            "paneTitleSetByUser": {},
            "timestamp": 7,
        })
    );
}

#[test]
fn returned_snapshots_are_detached_clones() {
    let store = LayoutStore::new();
    store.update_from_ui(&basic_snapshot(1), "conn1");
    let mut first = store.get_normalized_snapshot(None);
    first["tabs"][0]["title"] = json!("mutated");
    first["layouts"]["tab_a"]["content"]["kind"] = json!("mutated");
    let second = store.get_normalized_snapshot(None);
    assert_eq!(second["tabs"][0]["title"], json!("alpha"));
    assert_eq!(
        second["layouts"]["tab_a"]["content"]["kind"],
        json!("terminal")
    );
}

#[test]
fn source_connection_id_tracks_last_writer() {
    let store = LayoutStore::new();
    assert_eq!(store.source_connection_id(), None);
    store.update_from_ui(&basic_snapshot(1), "conn-abc");
    assert_eq!(store.source_connection_id().as_deref(), Some("conn-abc"));
    store.update_from_ui(&basic_snapshot(2), "conn-def");
    assert_eq!(store.source_connection_id().as_deref(), Some("conn-def"));
}

#[test]
fn last_write_wins_replace_not_merge() {
    let store = LayoutStore::new();
    store.update_from_ui(&basic_snapshot(1), "conn1");
    // A second sync with a DIFFERENT shape replaces the first wholesale.
    store.update_from_ui(
        &sync(
            json!([{ "id": "tab_z", "title": "zed" }]),
            json!({ "tab_z": { "type": "leaf", "id": "pane_z", "content": { "kind": "picker" } } }),
            json!({ "tab_z": "pane_z" }),
            Some("tab_z"),
            None,
            None,
            2,
        ),
        "conn1",
    );
    let snap = store.get_normalized_snapshot(None);
    assert_eq!(snap["tabs"], json!([{ "id": "tab_z", "title": "zed" }]));
    assert!(snap["layouts"].get("tab_a").is_none());
}

#[test]
fn list_tabs_and_panes_from_snapshot() {
    let store = LayoutStore::new();
    assert!(store.list_tabs().is_empty());
    assert!(store.list_panes(None).is_empty());
    store.update_from_ui(&basic_snapshot(1), "conn1");
    assert_eq!(
        serde_json::to_value(store.list_tabs()).expect("list_tabs serializes"),
        json!([{ "id": "tab_a", "title": "alpha", "activePaneId": "pane_1" }])
    );
    assert_eq!(
        serde_json::to_value(store.list_panes(Some("tab_a"))).expect("list_panes serializes"),
        json!([{ "id": "pane_1", "index": 0, "kind": "terminal", "terminalId": "term_1" }])
    );
}
