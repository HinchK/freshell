//! AUTO-01 — the Rust port of the legacy `LayoutStore`
//! (`server/agent-api/layout-store.ts`).
//!
//! The connected browser UI mirrors its real Redux layout to the server as
//! `ui.layout.sync` WS frames (`src/store/layoutMirrorMiddleware.ts`,
//! `ClientMessage::UiLayoutSync`). This store ingests those frames — replacing
//! the whole snapshot, normalizing legacy `agent-chat`/legacy fresh-agent
//! content exactly like `shared/fresh-agent.ts`, and seeding derived pane
//! titles — and serves the REST read surface (`GET /api/layout/snapshot`,
//! `GET /api/tabs`, `GET /api/panes`, `GET /api/tabs/has`) so browser, REST,
//! CLI, and MCP all share ONE authoritative layout.
//!
//! Parity is legacy-exact semantics (whole-snapshot last-write-wins replace,
//! no replies/broadcasts on ingest, six-key empty shape before first feed,
//! filtered-snapshot rules, ordered `listTabs`/`listPanes` rows). Internal
//! mutation ops (`create_tab`, `split_pane`, ...) are the write-through
//! substrate the EXISTING Rust mutation routes call to stay coherent pre-sync
//! — their route contracts (rollback, broadcasts, status codes) are owned by
//! AUTO-02..AUTO-11 and are NOT changed by this module.

use std::sync::Mutex;

use serde::Serialize;
use serde_json::{Map, Value};

use freshell_protocol::UiLayoutSync;

/// One `listTabs` row (`layout-store.ts:327-334`). `title` already carries the
/// legacy `t.title || t.id` fallback.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedTab {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_pane_id: Option<String>,
}

/// One `listPanes` row (`layout-store.ts:348-354`): legacy key set only —
/// the owning tab id is carried unserialized
/// (`GET /api/panes` adds its additive `tabId` at the route layer).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedPane {
    #[serde(skip)]
    pub tab_id: String,
    pub id: String,
    pub index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Default)]
struct LayoutState {
    fed: bool,
    tabs: Vec<freshell_protocol::UiLayoutTab>,
    layouts: Map<String, Value>,
    active_pane: std::collections::BTreeMap<String, String>,
    active_tab_id: Option<String>,
    pane_titles: Map<String, Value>,
    pane_title_set_by_user: Map<String, Value>,
    timestamp: Option<i64>,
    source_connection_id: Option<String>,
}

/// The shared, cheaply-cloneable store. All state lives behind ONE mutex so
/// ingest and reads can never interleave mid-replace (legacy's single-threaded
/// replace has the same atomicity).
#[derive(Default)]
pub struct LayoutStore {
    state: Mutex<LayoutState>,
}

impl LayoutStore {
    pub fn new() -> Self {
        Self::default()
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, LayoutState> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// `updateFromUi(snapshot, connectionId)` (`layout-store.ts:169-181`):
    /// whole-snapshot replace (last write wins), layouts normalized on ingest,
    /// derived titles seeded for panes the user never named, source recorded.
    pub fn update_from_ui(&self, m: &UiLayoutSync, source_connection_id: &str) {
        let mut g = self.guard();
        g.fed = true;
        g.tabs = m.tabs.clone();
        g.layouts = match &m.layouts {
            Value::Object(map) => map
                .iter()
                .map(|(tab_id, node)| (tab_id.clone(), migrate_node(node)))
                .collect(),
            _ => Map::new(),
        };
        g.active_pane = m.active_pane.clone();
        g.active_tab_id = m.active_tab_id.clone().flatten();
        g.pane_titles = parse_nested_str_map(m.pane_titles.as_ref());
        g.pane_title_set_by_user = parse_nested_bool_map(m.pane_title_set_by_user.as_ref());
        g.timestamp = Some(m.timestamp);
        g.source_connection_id = Some(source_connection_id.to_string());
        let seeding: Vec<(String, String, Value)> = g
            .tabs
            .iter()
            .filter_map(|tab| {
                g.layouts
                    .get(&tab.id)
                    .map(|root| (tab.id.clone(), collect_leaves(root)))
            })
            .flat_map(|(tab_id, leaves)| {
                leaves
                    .into_iter()
                    .filter_map(|leaf| {
                        leaf.content
                            .clone()
                            .map(|content| (tab_id.clone(), leaf.id, content))
                    })
                    .collect::<Vec<_>>()
            })
            .collect();
        for (tab_id, pane_id, content) in seeding {
            g.seed_pane_title(&tab_id, &pane_id, &content);
        }
    }

    /// `getNormalizedSnapshot(tabId?)` (`layout-store.ts:191-210`). Legacy
    /// shapes, exactly: never-fed => the six-key empty shape WITHOUT
    /// `timestamp`; fed unfiltered => full echo + `timestamp` when present;
    /// fed filtered => one-tab subset (missing tab => empty maps) and
    /// `activeTabId` = the tab when found (even if it is not the active tab),
    /// ALWAYS carrying `timestamp` when the fed snapshot had one
    /// (`layout-store.ts:208`).
    pub fn get_normalized_snapshot(&self, tab_id: Option<&str>) -> Value {
        let g = self.guard();
        if !g.fed {
            return empty_snapshot(None);
        }
        let Some(filter) = tab_id.filter(|s| !s.is_empty()) else {
            let mut out = serde_json::json!({
                "tabs": g.tabs,
                "activeTabId": g.active_tab_id,
                "layouts": Value::Object(g.layouts.clone()),
                "activePane": g.active_pane,
                "paneTitles": Value::Object(g.pane_titles.clone()),
                "paneTitleSetByUser": Value::Object(g.pane_title_set_by_user.clone()),
            });
            if let Some(ts) = g.timestamp {
                out["timestamp"] = Value::from(ts);
            }
            return out;
        };
        let found = g.tabs.iter().find(|t| t.id == filter);
        let tab_rows: Vec<freshell_protocol::UiLayoutTab> = found.cloned().into_iter().collect();
        let subset = |map: &Map<String, Value>| -> Value {
            map.get(filter).cloned().map_or_else(
                || Value::Object(Map::new()),
                |v| serde_json::json!({ filter: v }),
            )
        };
        let active_pane = g.active_pane.get(filter).cloned().map_or_else(
            || Value::Object(Map::new()),
            |pane| serde_json::json!({ filter: pane }),
        );
        let mut out = serde_json::json!({
            "tabs": tab_rows,
            "activeTabId": found.map(|t| t.id.clone()),
            "layouts": subset(&g.layouts),
            "activePane": active_pane,
            "paneTitles": subset(&g.pane_titles),
            "paneTitleSetByUser": subset(&g.pane_title_set_by_user),
        });
        if let Some(ts) = g.timestamp {
            out["timestamp"] = Value::from(ts);
        }
        out
    }

    /// `getSourceConnectionId()` (`layout-store.ts:183-185`).
    pub fn source_connection_id(&self) -> Option<String> {
        self.guard().source_connection_id.clone()
    }

    /// `listTabs()` (`layout-store.ts:327-334`): ordered rows; un-set title
    /// falls back to the tab id.
    pub fn list_tabs(&self) -> Vec<ListedTab> {
        let g = self.guard();
        if !g.fed {
            return Vec::new();
        }
        g.tabs
            .iter()
            .map(|t| ListedTab {
                id: t.id.clone(),
                title: t.title.clone().unwrap_or_else(|| t.id.clone()),
                active_pane_id: g.active_pane.get(&t.id).cloned(),
            })
            .collect()
    }

    /// `listPanes(tabId?)` (`layout-store.ts:341-355`): resolves
    /// `tabId || activeTabId || tabs[0].id` (an empty filter string is no
    /// filter — legacy truthiness), leaves in tree order.
    pub fn list_panes(&self, tab_id: Option<&str>) -> Vec<ListedPane> {
        let g = self.guard();
        if !g.fed {
            return Vec::new();
        }
        let resolved = tab_id
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| g.active_tab_id.clone())
            .or_else(|| g.tabs.first().map(|t| t.id.clone()));
        let Some(resolved) = resolved else {
            return Vec::new();
        };
        let Some(root) = g.layouts.get(&resolved) else {
            return Vec::new();
        };
        collect_leaves(root)
            .into_iter()
            .enumerate()
            .map(|(index, leaf)| {
                let title = g
                    .pane_titles
                    .get(&resolved)
                    .and_then(|m| m.get(&leaf.id))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                ListedPane {
                    tab_id: resolved.clone(),
                    id: leaf.id,
                    index,
                    kind: leaf
                        .content
                        .as_ref()
                        .and_then(|c| c.get("kind"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    terminal_id: leaf
                        .content
                        .as_ref()
                        .and_then(|c| c.get("terminalId"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    title,
                }
            })
            .collect()
    }
}

/// The legacy six-key empty shape (`layout-store.ts::emptySnapshot`), with
/// `timestamp` only when the caller's variant carries one.
fn empty_snapshot(timestamp: Option<i64>) -> Value {
    let mut out = serde_json::json!({
        "tabs": [],
        "activeTabId": Value::Null,
        "layouts": {},
        "activePane": {},
        "paneTitles": {},
        "paneTitleSetByUser": {},
    });
    if let Some(ts) = timestamp {
        out["timestamp"] = Value::from(ts);
    }
    out
}

/// One leaf of a layout tree.
struct Leaf {
    id: String,
    content: Option<Value>,
}

/// `collectLeaves` (`layout-store.ts:219-230`): `leaf` nodes yield their id +
/// content; `split` nodes recurse over `children` (any length); anything else
/// stops silently.
fn collect_leaves(node: &Value) -> Vec<Leaf> {
    let mut out = Vec::new();
    collect_leaves_into(node, &mut out);
    out
}

fn collect_leaves_into(node: &Value, out: &mut Vec<Leaf>) {
    let Some(obj) = node.as_object() else { return };
    match obj.get("type").and_then(Value::as_str) {
        Some("leaf") => {
            if let Some(id) = obj.get("id").and_then(Value::as_str) {
                out.push(Leaf {
                    id: id.to_string(),
                    content: obj.get("content").cloned(),
                });
            }
        }
        Some("split") => {
            if let Some(children) = obj.get("children").and_then(Value::as_array) {
                for child in children {
                    collect_leaves_into(child, out);
                }
            }
        }
        _ => {}
    }
}

/// Tolerant `Record<tabId, Record<paneId, string>>` read of the wire's
/// `pane_titles` (protocol type: opaque `Option<Value>`).
fn parse_nested_str_map(raw: Option<&Value>) -> Map<String, Value> {
    nested_map(raw, |v| v.as_str().map(str::to_string).map(Value::from))
}

/// Tolerant `Record<tabId, Record<paneId, boolean>>`.
fn parse_nested_bool_map(raw: Option<&Value>) -> Map<String, Value> {
    nested_map(raw, |v| v.as_bool().map(Value::from))
}

fn nested_map<F>(raw: Option<&Value>, pick: F) -> Map<String, Value>
where
    F: Fn(&Value) -> Option<Value>,
{
    let mut out = Map::new();
    let Some(Value::Object(tabs)) = raw else {
        return out;
    };
    for (tab_id, panes) in tabs {
        let Value::Object(panes) = panes else { continue };
        let mut inner = Map::new();
        for (pane_id, value) in panes {
            if let Some(v) = pick(value) {
                inner.insert(pane_id.clone(), v);
            }
        }
        out.insert(tab_id.clone(), Value::Object(inner));
    }
    out
}

/// Placeholder for Task 2's normalization port — identity until the
/// `migrateLegacyFreshAgentNode` table lands (RED next).
fn migrate_node(node: &Value) -> Value {
    node.clone()
}

impl LayoutState {
    /// `seedPaneTitle` (`layout-store.ts:161-167`): Task 3 lands
    /// `derive_pane_title`; until then this intentionally seeds nothing.
    fn seed_pane_title(&mut self, _tab_id: &str, _pane_id: &str, _content: &Value) {}
}

#[cfg(test)]
#[path = "layout_store_tests.rs"]
mod tests;
