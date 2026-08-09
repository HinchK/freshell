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

// ── Task 2: normalization port (`shared/fresh-agent.ts`, legacy schema tests) ──

/// Full-JSON equality asserts (the migration is exact-shape, not subset).
fn migrate(content: serde_json::Value) -> serde_json::Value {
    let store = LayoutStore::new();
    store.update_from_ui(
        &sync(
            json!([{ "id": "tab_x", "title": "x" }]),
            json!({ "tab_x": { "type": "leaf", "id": "pane_x", "content": content } }),
            json!({ "tab_x": "pane_x" }),
            Some("tab_x"),
            None,
            None,
            1,
        ),
        "conn",
    );
    store.get_normalized_snapshot(Some("tab_x"))["layouts"]["tab_x"]["content"].clone()
}

#[test]
fn agent_chat_freshclaude_provider_becomes_fresh_agent_with_session_ref() {
    assert_eq!(
        migrate(json!({
            "kind": "agent-chat",
            "provider": "freshclaude",
            "sessionId": "live-1",
            "createRequestId": "req-1",
            "status": "idle",
            "resumeSessionId": "00000000-0000-4000-8000-000000000001",
            "initialCwd": "/work",
            "permissionMode": "acceptEdits",
            "effort": "high",
            "plugins": ["/tmp/plugin"],
        })),
        json!({
            "kind": "fresh-agent",
            "sessionType": "freshclaude",
            "provider": "claude",
            "sessionId": "live-1",
            "createRequestId": "req-1",
            "status": "idle",
            "resumeSessionId": "00000000-0000-4000-8000-000000000001",
            "initialCwd": "/work",
            "permissionMode": "acceptEdits",
            "effort": "high",
            "plugins": ["/tmp/plugin"],
            "sessionRef": { "provider": "claude", "sessionId": "00000000-0000-4000-8000-000000000001" },
        })
    );
}

#[test]
fn agent_chat_claude_provider_with_canonical_resume_gets_session_ref() {
    assert_eq!(
        migrate(json!({
            "kind": "agent-chat",
            "provider": "claude",
            "createRequestId": "req-old",
            "status": "idle",
            "resumeSessionId": "00000000-0000-4000-8000-000000000123",
        })),
        json!({
            "kind": "fresh-agent",
            "sessionType": "freshclaude",
            "provider": "claude",
            "createRequestId": "req-old",
            "status": "idle",
            "resumeSessionId": "00000000-0000-4000-8000-000000000123",
            "sessionRef": { "provider": "claude", "sessionId": "00000000-0000-4000-8000-000000000123" },
        })
    );
}

#[test]
fn agent_chat_named_alias_resume_becomes_restore_error() {
    assert_eq!(
        migrate(json!({
            "kind": "agent-chat",
            "provider": "claude",
            "createRequestId": "req-bad",
            "status": "idle",
            "resumeSessionId": "named-alias",
        })),
        json!({
            "kind": "fresh-agent",
            "sessionType": "freshclaude",
            "provider": "claude",
            "createRequestId": "req-bad",
            "status": "idle",
            "restoreError": { "code": "RESTORE_UNAVAILABLE", "reason": "invalid_legacy_restore_target" },
        })
    );
}

#[test]
fn agent_chat_alias_session_ref_dropped_and_errored() {
    assert_eq!(
        migrate(json!({
            "kind": "agent-chat",
            "provider": "claude",
            "createRequestId": "req-alias",
            "status": "idle",
            "sessionRef": { "provider": "claude", "sessionId": "named-alias" },
        })),
        json!({
            "kind": "fresh-agent",
            "sessionType": "freshclaude",
            "provider": "claude",
            "createRequestId": "req-alias",
            "status": "idle",
            "restoreError": { "code": "RESTORE_UNAVAILABLE", "reason": "invalid_legacy_restore_target" },
        })
    );
}

#[test]
fn alias_session_ref_wins_over_canonical_resume_id_both_dropped() {
    assert_eq!(
        migrate(json!({
            "kind": "agent-chat",
            "provider": "freshclaude",
            "createRequestId": "req-alias-with-resume",
            "status": "idle",
            "sessionRef": { "provider": "claude", "sessionId": "named-alias" },
            "resumeSessionId": "00000000-0000-4000-8000-000000000777",
        })),
        json!({
            "kind": "fresh-agent",
            "sessionType": "freshclaude",
            "provider": "claude",
            "createRequestId": "req-alias-with-resume",
            "status": "idle",
            "restoreError": { "code": "RESTORE_UNAVAILABLE", "reason": "invalid_legacy_restore_target" },
        })
    );
}

#[test]
fn fresh_agent_alias_session_ref_becomes_restore_error() {
    assert_eq!(
        migrate(json!({
            "kind": "fresh-agent",
            "sessionType": "freshclaude",
            "provider": "claude",
            "createRequestId": "req-fresh-alias",
            "status": "idle",
            "sessionRef": { "provider": "claude", "sessionId": "named-alias" },
            "initialCwd": "/work",
            "showTools": true,
        })),
        json!({
            "kind": "fresh-agent",
            "sessionType": "freshclaude",
            "provider": "claude",
            "createRequestId": "req-fresh-alias",
            "status": "idle",
            "restoreError": { "code": "RESTORE_UNAVAILABLE", "reason": "invalid_legacy_restore_target" },
            "initialCwd": "/work",
            "showTools": true,
        })
    );
}

#[test]
fn display_overrides_survive_migration() {
    let out = migrate(json!({
        "kind": "agent-chat",
        "provider": "freshclaude",
        "createRequestId": "req-display",
        "status": "idle",
        "showThinking": false,
        "showTools": true,
        "showTimecodes": true,
        "resumeSessionId": "00000000-0000-4000-8000-000000000456",
    }));
    assert_eq!(out["showThinking"], json!(false));
    assert_eq!(out["showTools"], json!(true));
    assert_eq!(out["showTimecodes"], json!(true));
}

#[test]
fn timeline_session_id_is_the_resume_fallback() {
    let out = migrate(json!({
        "kind": "agent-chat",
        "provider": "claude",
        "createRequestId": "req-timeline",
        "status": "idle",
        "timelineSessionId": "00000000-0000-4000-8000-000000000abc",
    }));
    assert_eq!(
        out["sessionRef"],
        json!({ "provider": "claude", "sessionId": "00000000-0000-4000-8000-000000000abc" })
    );
    assert!(out.get("timelineSessionId").is_none());
    // resumeSessionId only echoes when the INPUT had a string resumeSessionId.
    assert!(out.get("resumeSessionId").is_none());
}

#[test]
fn opencode_agent_chat_maps_to_freshopencode() {
    let out = migrate(json!({
        "kind": "agent-chat",
        "provider": "freshopencode",
        "createRequestId": "req-oc",
        "status": "idle",
        "resumeSessionId": "ses_abc123",
    }));
    assert_eq!(out["sessionType"], json!("freshopencode"));
    assert_eq!(out["provider"], json!("opencode"));
    assert_eq!(
        out["sessionRef"],
        json!({ "provider": "opencode", "sessionId": "ses_abc123" })
    );
}

#[test]
fn unrecognizable_agent_chat_gets_restore_error_with_defaults() {
    // No provider/sessionType and no usable identity: legacy still converts,
    // defaulting to freshclaude/claude with the restore error
    // (shared/fresh-agent.ts:317-333).
    let out = migrate(json!({
        "kind": "agent-chat",
        "createRequestId": "req-unknown",
        "status": "idle",
    }));
    assert_eq!(out["kind"], json!("fresh-agent"));
    assert_eq!(out["sessionType"], json!("freshclaude"));
    assert_eq!(out["provider"], json!("claude"));
    assert_eq!(
        out["restoreError"],
        json!({ "code": "RESTORE_UNAVAILABLE", "reason": "invalid_legacy_restore_target" })
    );
}

#[test]
fn fresh_agent_with_unresolvable_identity_is_returned_unchanged() {
    // shared/fresh-agent.ts:214-216 — neither sessionType nor provider can be
    // resolved: legacy returns the input as-is.
    let input = json!({
        "kind": "fresh-agent",
        "createRequestId": "req-passthrough",
        "status": "idle",
    });
    let out = migrate(input.clone());
    assert_eq!(out, input);
}

#[test]
fn non_agent_kinds_pass_through_untouched() {
    for input in [
        json!({ "kind": "terminal", "createRequestId": "r", "status": "running", "mode": "shell" }),
        json!({ "kind": "browser", "url": "https://example.com", "devToolsOpen": false }),
        json!({ "kind": "picker" }),
        json!({ "kind": "something-future", "extra": 1 }),
    ] {
        let out = migrate(input.clone());
        assert_eq!(out, input);
    }
}

#[test]
fn nested_splits_are_migrated_recursively_and_agent_chat_is_gone() {
    let store = LayoutStore::new();
    store.update_from_ui(
        &sync(
            json!([{ "id": "tab_n", "title": "nested" }]),
            json!({
                "tab_n": {
                    "type": "split",
                    "id": "split_root",
                    "direction": "horizontal",
                    "sizes": [55, 45],
                    "children": [
                        {
                            "type": "leaf",
                            "id": "pane_agent",
                            "content": {
                                "kind": "agent-chat",
                                "provider": "claude",
                                "createRequestId": "req_agent",
                                "resumeSessionId": "11111111-1111-4111-8111-111111111111",
                            },
                        },
                        {
                            "type": "split",
                            "id": "split_nested",
                            "direction": "vertical",
                            "sizes": [50, 50],
                            "children": [
                                {
                                    "type": "leaf",
                                    "id": "pane_agent_nested",
                                    "content": {
                                        "kind": "agent-chat",
                                        "provider": "freshclaude",
                                        "createRequestId": "req_nested",
                                        "sessionId": "legacy-live",
                                        "resumeSessionId": "11111111-1111-4111-8111-111111111111",
                                    },
                                },
                                {
                                    "type": "leaf",
                                    "id": "pane_shell",
                                    "content": { "kind": "terminal", "createRequestId": "req_shell", "status": "idle", "mode": "shell" },
                                },
                            ],
                        },
                    ],
                }
            }),
            json!({ "tab_n": "pane_agent" }),
            Some("tab_n"),
            None,
            None,
            1,
        ),
        "conn1",
    );
    let snap = store.get_normalized_snapshot(Some("tab_n"));
    let serialized = serde_json::to_string(&snap).expect("serializes");
    assert!(serialized.contains("\"fresh-agent\""), "{serialized}");
    assert!(!serialized.contains("\"agent-chat\""), "{serialized}");
    let layouts = &snap["layouts"]["tab_n"];
    assert_eq!(layouts["type"], json!("split"));
    assert_eq!(layouts["sizes"], json!([55, 45]));
    assert_eq!(
        layouts["children"][0]["content"]["sessionRef"],
        json!({ "provider": "claude", "sessionId": "11111111-1111-4111-8111-111111111111" })
    );
    assert_eq!(
        layouts["children"][1]["children"][0]["content"]["sessionRef"],
        json!({ "provider": "claude", "sessionId": "11111111-1111-4111-8111-111111111111" })
    );
    assert_eq!(
        layouts["children"][1]["children"][1]["content"],
        json!({ "kind": "terminal", "createRequestId": "req_shell", "status": "idle", "mode": "shell" })
    );
}
