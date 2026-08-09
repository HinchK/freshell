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
            // updateFromUi SEEDS derived titles (modeless terminal => "Shell"),
            // creating both per-tab maps (legacy seedPaneTitle).
            "paneTitles": { "tab_a": { "pane_1": "Shell" } },
            "paneTitleSetByUser": { "tab_a": {} },
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
        json!([{ "id": "pane_1", "index": 0, "kind": "terminal", "terminalId": "term_1", "title": "Shell" }])
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

// ── Task 3: title seeding + mutation ops + helper reads ──
// Port anchors: test/unit/server/agent-layout-store-write.test.ts +
// layout-store.ts::derivePaneTitle.

#[test]
fn derive_pane_title_terminal_modes_shells_and_fallbacks() {
    assert_eq!(
        derive_pane_title(&json!({ "kind": "terminal", "mode": "codex" })),
        Some("Codex CLI".to_string())
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "terminal", "mode": "claude" })),
        Some("Claude CLI".to_string())
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "terminal", "mode": "opencode" })),
        Some("OpenCode".to_string())
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "terminal", "shell": "powershell" })),
        Some("PowerShell".to_string())
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "terminal", "shell": "cmd" })),
        Some("Command Prompt".to_string())
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "terminal", "shell": "wsl" })),
        Some("WSL".to_string())
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "terminal" })),
        Some("Shell".to_string())
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "terminal", "shell": "system" })),
        Some("Shell".to_string())
    );
    assert_eq!(derive_pane_title(&json!({ "kind": "picker" })), None);
    assert_eq!(
        derive_pane_title(&json!({ "kind": "fresh-agent", "sessionType": "freshclaude" })),
        Some("Freshclaude".to_string())
    );
    // Legacy quirk: freshopencode derives "OpenCode" (not "Freshopencode").
    assert_eq!(
        derive_pane_title(&json!({ "kind": "fresh-agent", "sessionType": "freshopencode" })),
        Some("OpenCode".to_string())
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "fresh-agent", "sessionType": "kilroy" })),
        Some("Kilroy".to_string())
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "fresh-agent" })),
        Some("Fresh Agent".to_string())
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "extension", "extensionName": "notes" })),
        Some("notes".to_string())
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "extension" })),
        Some("Extension".to_string())
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "editor", "filePath": "/tmp/dir/example.txt" })),
        Some("example.txt".to_string())
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "editor", "filePath": "C:\\docs\\note.md" })),
        Some("note.md".to_string())
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "editor" })),
        Some("Editor".to_string())
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "browser", "url": "https://docs.example.com/a/b" })),
        Some("docs.example.com".to_string())
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "browser", "url": "https://user:pw@host.example:8443/x" })),
        Some("host.example".to_string())
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "browser", "url": "not a url" })),
        Some("Browser".to_string())
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "browser" })),
        Some("Browser".to_string())
    );
}

#[test]
fn sync_seeds_titles_for_unnamed_panes_only() {
    let store = LayoutStore::new();
    store.update_from_ui(
        &sync(
            json!([{ "id": "tab_a", "title": "alpha" }]),
            json!({
                "tab_a": {
                    "type": "split",
                    "id": "split_1",
                    "direction": "horizontal",
                    "sizes": [50, 50],
                    "children": [
                        { "type": "leaf", "id": "pane_1", "content": { "kind": "terminal", "mode": "codex" } },
                        { "type": "leaf", "id": "pane_2", "content": { "kind": "editor", "filePath": "/tmp/e.txt" } },
                    ],
                },
            }),
            json!({ "tab_a": "pane_1" }),
            Some("tab_a"),
            Some(json!({ "tab_a": { "pane_1": "user name" } })),
            Some(json!({ "tab_a": { "pane_1": true } })),
            1,
        ),
        "conn1",
    );
    let snap = store.get_normalized_snapshot(None);
    // User-set title survives; the unnamed editor pane got its derived title.
    assert_eq!(snap["paneTitles"]["tab_a"]["pane_1"], json!("user name"));
    assert_eq!(snap["paneTitles"]["tab_a"]["pane_2"], json!("e.txt"));
}

#[test]
fn create_tab_records_and_seeds_title() {
    let store = LayoutStore::new();
    store.create_tab("tab_1", "pane_1", Some("alpha".to_string()), json!({ "kind": "terminal" }));
    assert_eq!(
        store.get_normalized_snapshot(None),
        json!({
            "tabs": [{ "id": "tab_1", "title": "alpha" }],
            "activeTabId": "tab_1",
            "layouts": { "tab_1": { "type": "leaf", "id": "pane_1", "content": { "kind": "terminal" } } },
            "activePane": { "tab_1": "pane_1" },
            "paneTitles": { "tab_1": { "pane_1": "Shell" } },
            // Legacy seedPaneTitle goes through getPaneTitleMaps, which creates
            // BOTH per-tab maps — the setByUser inner map therefore exists.
            "paneTitleSetByUser": { "tab_1": {} },
        })
    );
}

#[test]
fn split_pane_replaces_leaf_in_place_and_seeds_new_pane() {
    let store = LayoutStore::new();
    store.create_tab("tab_1", "pane_1", None, json!({ "kind": "terminal", "terminalId": "term_1" }));
    let tab = store
        .split_pane(
            "pane_1",
            "horizontal",
            "pane_2",
            json!({ "kind": "editor", "filePath": "/tmp/example.txt" }),
        )
        .expect("split resolves");
    assert_eq!(tab, "tab_1");
    let snap = store.get_normalized_snapshot(Some("tab_1"));
    let node = &snap["layouts"]["tab_1"];
    assert_eq!(node["type"], json!("split"));
    assert_eq!(node["direction"], json!("horizontal"));
    assert_eq!(node["sizes"], json!([50.0, 50.0]));
    assert_eq!(node["children"][0]["id"], json!("pane_1"));
    assert_eq!(
        node["children"][0]["content"],
        json!({ "kind": "terminal", "terminalId": "term_1" })
    );
    assert_eq!(node["children"][1]["id"], json!("pane_2"));
    assert!(node["id"].as_str().is_some_and(|s| !s.is_empty()));
    assert_eq!(snap["activePane"]["tab_1"], json!("pane_2"));
    let panes = store.list_panes(Some("tab_1"));
    assert_eq!(panes.len(), 2);
    assert_eq!(panes[0].title.as_deref(), Some("Shell"));
    assert_eq!(panes[1].title.as_deref(), Some("example.txt"));
}

#[test]
fn split_of_unknown_pane_is_not_found() {
    let store = LayoutStore::new();
    store.create_tab("tab_1", "pane_1", None, json!({ "kind": "terminal" }));
    assert_eq!(store.split_pane("nope", "vertical", "p2", json!({"kind":"terminal"})), None);
}

#[test]
fn close_pane_guards_last_pane_then_rebuilds_grid() {
    let store = LayoutStore::new();
    store.create_tab("tab_1", "p1", None, json!({ "kind": "terminal" }));
    assert_eq!(store.close_pane("p1"), ClosePaneOutcome::LastPane);
    store.split_pane("p1", "horizontal", "p2", json!({ "kind": "terminal" })).unwrap();
    store.split_pane("p2", "vertical", "p3", json!({ "kind": "editor", "filePath": "/x" })).unwrap();
    assert_eq!(store.close_pane("nope"), ClosePaneOutcome::NotFound);
    assert_eq!(store.close_pane("p1"), ClosePaneOutcome::Closed("tab_1".to_string()));
    // Legacy buildGridLayout(2) = horizontal 50/50 split of the remaining two.
    let snap = store.get_normalized_snapshot(Some("tab_1"));
    let node = &snap["layouts"]["tab_1"];
    assert_eq!(node["type"], json!("split"));
    assert_eq!(node["direction"], json!("horizontal"));
    assert_eq!(node["sizes"], json!([50.0, 50.0]));
    assert_eq!(node["children"][0]["id"], json!("p2"));
    assert_eq!(node["children"][1]["id"], json!("p3"));
    // Active pane = LAST remaining leaf (legacy closePane).
    assert_eq!(snap["activePane"]["tab_1"], json!("p3"));
    // The closed pane's derived title metadata is gone (incl. empty-map cleanup).
    let titles = &snap["paneTitles"]["tab_1"];
    assert!(titles.get("p1").is_none());
}

#[test]
fn close_pane_three_remaining_builds_two_row_grid() {
    let store = LayoutStore::new();
    store.create_tab("t", "p1", None, json!({ "kind": "terminal" }));
    store.split_pane("p1", "horizontal", "p2", json!({ "kind": "terminal" })).unwrap();
    store.split_pane("p2", "horizontal", "p3", json!({ "kind": "terminal" })).unwrap();
    store.split_pane("p3", "horizontal", "p4", json!({ "kind": "terminal" })).unwrap();
    assert_eq!(store.close_pane("p1"), ClosePaneOutcome::Closed("t".to_string()));
    let node = store.get_normalized_snapshot(Some("t"))["layouts"]["t"].clone();
    // buildGridLayout(3): vertical split; top row = buildHorizontalRow(ceil(3/2)=2).
    assert_eq!(node["direction"], json!("vertical"));
    assert_eq!(node["children"][0]["direction"], json!("horizontal"));
    assert_eq!(node["children"][0]["children"][0]["id"], json!("p2"));
    assert_eq!(node["children"][0]["children"][1]["id"], json!("p3"));
    assert_eq!(node["children"][1], json!({ "type": "leaf", "id": "p4", "content": { "kind": "terminal" } }));
}

#[test]
fn select_pane_with_invalid_tab_id_falls_back_to_owning_tab() {
    let store = LayoutStore::new();
    store.create_tab("tab_1", "pane_1", Some("alpha".to_string()), json!({ "kind": "terminal" }));
    let (tab, pane) = store.select_pane(Some("missing_tab"), "pane_1").expect("resolved");
    assert_eq!((tab.as_str(), pane.as_str()), ("tab_1", "pane_1"));
    assert_eq!(store.active_tab_id().as_deref(), Some("tab_1"));
    assert_eq!(store.list_tabs()[0].active_pane_id.as_deref(), Some("pane_1"));
}

#[test]
fn rename_pane_sets_title_and_cascades_to_single_pane_tab() {
    let store = LayoutStore::new();
    store.update_from_ui(&basic_snapshot(1), "conn1");
    assert_eq!(
        store.rename_pane("pane_1", "Logs"),
        Some(("tab_a".to_string(), "pane_1".to_string()))
    );
    let snap = store.get_normalized_snapshot(None);
    assert_eq!(snap["paneTitles"]["tab_a"]["pane_1"], json!("Logs"));
    assert_eq!(snap["paneTitleSetByUser"]["tab_a"]["pane_1"], json!(true));
    assert_eq!(snap["tabs"][0]["title"], json!("Logs"));
    assert_eq!(store.rename_pane("missing", "x"), None);
}

#[test]
fn rename_tab_cascades_into_only_pane() {
    let store = LayoutStore::new();
    store.update_from_ui(&basic_snapshot(1), "conn1");
    assert!(store.rename_tab("tab_a", Some("Docs".to_string())));
    let snap = store.get_normalized_snapshot(None);
    assert_eq!(snap["tabs"][0]["title"], json!("Docs"));
    assert_eq!(snap["paneTitles"]["tab_a"]["pane_1"], json!("Docs"));
    assert_eq!(snap["paneTitleSetByUser"]["tab_a"]["pane_1"], json!(true));
    assert!(!store.rename_tab("missing", None));
}

#[test]
fn lists_pane_titles_from_pane_snapshot() {
    let store = LayoutStore::new();
    store.update_from_ui(
        &sync(
            json!([{ "id": "tab_a", "title": "Alpha" }]),
            json!({ "tab_a": { "type": "leaf", "id": "pane_1", "content": { "kind": "terminal", "terminalId": "term_1" } } }),
            json!({ "tab_a": "pane_1" }),
            Some("tab_a"),
            Some(json!({ "tab_a": { "pane_1": "Logs" } })),
            Some(json!({ "tab_a": { "pane_1": true } })),
            1,
        ),
        "conn1",
    );
    assert_eq!(
        serde_json::to_value(store.list_panes(Some("tab_a"))).expect("serializes"),
        json!([{ "id": "pane_1", "index": 0, "kind": "terminal", "terminalId": "term_1", "title": "Logs" }])
    );
}

#[test]
fn attach_replaces_content_and_reseeds_only_untouched_titles() {
    let store = LayoutStore::new();
    store.create_tab("tab_1", "pane_1", None, json!({ "kind": "terminal" }));
    store.rename_pane("pane_1", "Ops desk");
    assert!(store.attach_pane_content("tab_1", "pane_1", json!({ "kind": "browser", "url": "https://docs.example.com/runbook", "devToolsOpen": false })));
    let panes = store.list_panes(Some("tab_1"));
    assert_eq!(panes[0].kind.as_deref(), Some("browser"));
    assert_eq!(panes[0].title.as_deref(), Some("Ops desk"));
    // Untouched title: reseeds from the NEW content.
    let store2 = LayoutStore::new();
    store2.create_tab("tab_1", "pane_1", None, json!({ "kind": "terminal" }));
    assert!(store2.attach_pane_content("tab_1", "pane_1", json!({ "kind": "terminal", "terminalId": "term_2", "mode": "codex" })));
    assert_eq!(store2.list_panes(Some("tab_1"))[0].title.as_deref(), Some("Codex CLI"));
    assert!(!store2.attach_pane_content("missing_tab", "pane_1", json!({"kind":"terminal"})));
}

#[test]
fn swap_pane_swaps_content_and_titles() {
    let store = LayoutStore::new();
    store.update_from_ui(
        &sync(
            json!([{ "id": "tab_a", "title": "Alpha" }]),
            json!({
                "tab_a": {
                    "type": "split",
                    "id": "split_1",
                    "direction": "horizontal",
                    "sizes": [50, 50],
                    "children": [
                        { "type": "leaf", "id": "pane_1", "content": { "kind": "terminal", "terminalId": "term_1", "mode": "codex", "shell": "system" } },
                        { "type": "leaf", "id": "pane_2", "content": { "kind": "editor", "filePath": "/tmp/example.txt", "readOnly": false, "content": "", "viewMode": "source" } },
                    ],
                },
            }),
            json!({ "tab_a": "pane_1" }),
            Some("tab_a"),
            Some(json!({ "tab_a": { "pane_1": "Codex", "pane_2": "Editor" } })),
            Some(json!({ "tab_a": { "pane_1": true, "pane_2": true } })),
            1,
        ),
        "conn1",
    );
    assert_eq!(store.swap_pane(Some("tab_a"), "pane_1", "pane_2"), Some("tab_a".to_string()));
    let panes = store.list_panes(Some("tab_a"));
    assert_eq!(panes[0].kind.as_deref(), Some("editor"));
    assert_eq!(panes[0].title.as_deref(), Some("Editor"));
    assert_eq!(panes[1].terminal_id.as_deref(), Some("term_1"));
    assert_eq!(panes[1].title.as_deref(), Some("Codex"));
    // Cross-tab and unknown pairs are None ("panes not found").
    assert_eq!(store.swap_pane(Some("tab_a"), "pane_1", "nope"), None);
}

#[test]
fn close_tab_falls_forward_active_and_clears_metadata() {
    let store = LayoutStore::new();
    store.create_tab("tab_1", "p1", None, json!({ "kind": "terminal" }));
    store.create_tab("tab_2", "p2", None, json!({ "kind": "browser", "url": "https://x.io", "devToolsOpen": false }));
    assert_eq!(store.active_tab_id().as_deref(), Some("tab_2"));
    assert!(store.close_tab("tab_2"));
    assert!(!store.close_tab("tab_2"));
    // Legacy: activeTabId = nextTabs[0]?.id || null.
    assert_eq!(store.active_tab_id().as_deref(), Some("tab_1"));
    let snap = store.get_normalized_snapshot(None);
    assert!(snap["layouts"].get("tab_2").is_none());
    assert!(snap["paneTitles"].get("tab_2").is_none());
    assert!(snap["activePane"].get("tab_2").is_none());
    assert!(store.close_tab("tab_1"));
    assert_eq!(store.active_tab_id(), None);
}

#[test]
fn has_tab_matches_id_or_title() {
    let store = LayoutStore::new();
    assert!(!store.has_tab("anything"));
    store.create_tab("tab_1", "p1", Some("Alpha".to_string()), json!({ "kind": "terminal" }));
    assert!(store.has_tab("tab_1"));
    assert!(store.has_tab("Alpha"));
    assert!(!store.has_tab("nope"));
}

#[test]
fn resize_pane_sets_split_sizes() {
    let store = LayoutStore::new();
    store.create_tab("t", "p1", None, json!({ "kind": "terminal" }));
    store.split_pane("p1", "horizontal", "p2", json!({ "kind": "terminal" })).unwrap();
    let split_id = store.get_normalized_snapshot(None)["layouts"]["t"]["id"]
        .as_str()
        .expect("split id")
        .to_string();
    // No-tab filter resolution + sizes write.
    assert_eq!(store.resize_pane(None, &split_id, [30.0, 70.0]), Some("t".to_string()));
    assert_eq!(store.get_split_sizes(Some("t"), &split_id), Some((30.0, 70.0)));
    // Unknown split / wrong-length sizes.
    assert_eq!(store.get_split_sizes(None, "missing"), None);
    assert_eq!(store.resize_pane(None, "missing", [1.0, 2.0]), None);
}

#[test]
fn helper_lookups_find_panes_and_terminal_ids() {
    let store = LayoutStore::new();
    store.update_from_ui(&basic_snapshot(1), "conn1");
    let snap = store.get_pane_snapshot("pane_1").expect("found");
    assert_eq!(snap.tab_id, "tab_a");
    assert_eq!(snap.pane_id, "pane_1");
    assert_eq!(snap.index, 0);
    assert_eq!(
        snap.pane_content.expect("content")["terminalId"],
        json!("term_1")
    );
    assert_eq!(store.get_pane_snapshot("nope"), None);
    assert_eq!(store.resolve_pane_to_terminal("pane_1").as_deref(), Some("term_1"));
    assert_eq!(store.resolve_pane_to_terminal("nope"), None);
    assert_eq!(
        store.find_pane_by_terminal_id("term_1"),
        Some(("tab_a".to_string(), "pane_1".to_string()))
    );
    // After a split, the parent split is findable.
    store.create_tab("tab_b", "p1", None, json!({ "kind": "terminal" }));
    store.split_pane("p1", "vertical", "p2", json!({ "kind": "terminal" })).unwrap();
    let (tab, split_id) = store.find_split_for_pane("p2").expect("parent split");
    assert_eq!(tab, "tab_b");
    assert_eq!(store.get_split_sizes(Some("tab_b"), &split_id), Some((50.0, 50.0)));
    assert_eq!(store.find_split_for_pane("pane_1"), None);
}
