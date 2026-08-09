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

    /// `ensureSnapshot` + `createTab` (`layout-store.ts:212-217,431-460`):
    /// server-side pane/tab birth. Ids are caller-minted (the routes own id
    /// minting for their `ui.command` payloads — legacy mints them inside
    /// `createTab` with nanoid, the Rust surface mints uuid4 upstream); the
    /// tab becomes active and its pane the active pane, exactly like legacy.
    pub fn create_tab(&self, tab_id: &str, pane_id: &str, title: Option<String>, content: Value) {
        let mut g = self.guard();
        g.fed = true;
        g.tabs.push(freshell_protocol::UiLayoutTab {
            id: tab_id.to_string(),
            fallback_session_ref: None,
            title,
        });
        g.layouts.insert(
            tab_id.to_string(),
            serde_json::json!({ "type": "leaf", "id": pane_id, "content": content }),
        );
        g.active_tab_id = Some(tab_id.to_string());
        g.active_pane
            .insert(tab_id.to_string(), pane_id.to_string());
        if let Some(node) = g.layouts.get(tab_id) {
            if let Some(content) = node.get("content").cloned() {
                g.seed_pane_title(tab_id, pane_id, &content);
            }
        }
    }

    /// `splitPane` (`layout-store.ts:462-499`): replace the source leaf
    /// in-place with a `{type:'split', id:<minted>, direction, sizes:[50,50],
    /// children:[sourceLeaf, newLeaf]}` node, make the new pane active, seed
    /// its derived title. `None` when the pane is in no tab ("pane not found").
    pub fn split_pane(
        &self,
        pane_id: &str,
        direction: &str,
        new_pane_id: &str,
        new_content: Value,
    ) -> Option<String> {
        let mut g = self.guard();
        for tab in g.tabs.clone() {
            let Some(root) = g.layouts.get(&tab.id) else {
                continue;
            };
            let Some(source) = collect_leaves(root)
                .into_iter()
                .find(|leaf| leaf.id == pane_id)
            else {
                continue;
            };
            let split = serde_json::json!({
                "type": "split",
                "id": uuid::Uuid::new_v4().to_string(),
                "direction": direction,
                "sizes": [50.0, 50.0],
                "children": [
                    leaf_value(pane_id, source.content),
                    leaf_value(new_pane_id, Some(new_content.clone())),
                ],
            });
            let replaced = find_and_replace(root, pane_id, &split)?;
            g.layouts.insert(tab.id.clone(), replaced);
            g.active_pane
                .insert(tab.id.clone(), new_pane_id.to_string());
            g.seed_pane_title(&tab.id, new_pane_id, &new_content);
            return Some(tab.id.clone());
        }
        None
    }

    /// `closePane` (`layout-store.ts:501-516`): refuse the tab's LAST pane;
    /// otherwise REBUILD the tree with `buildGridLayout(remaining)` — the
    /// geometry-losing rebuild is legacy behavior, mirrored exactly — move the
    /// active pane to the last remaining leaf, and drop the pane's title
    /// metadata (incl. empty-map cleanup).
    pub fn close_pane(&self, pane_id: &str) -> ClosePaneOutcome {
        let mut g = self.guard();
        for tab in g.tabs.clone() {
            let Some(root) = g.layouts.get(&tab.id) else {
                continue;
            };
            let leaves = collect_leaves(root);
            let total = leaves.len();
            let remaining: Vec<Leaf> = leaves
                .into_iter()
                .filter(|leaf| leaf.id != pane_id)
                .collect();
            // Length-preserved means this tab never contained the pane.
            if remaining.len() == total {
                continue;
            }
            if remaining.is_empty() {
                return ClosePaneOutcome::LastPane;
            }
            let last_id = remaining.last().expect("nonempty").id.clone();
            let rebuilt = build_grid_layout(remaining);
            g.layouts.insert(tab.id.clone(), rebuilt);
            g.active_pane.insert(tab.id.clone(), last_id);
            g.remove_pane_metadata(&tab.id, pane_id);
            return ClosePaneOutcome::Closed(tab.id.clone());
        }
        ClosePaneOutcome::NotFound
    }

    /// `selectTab` (`layout-store.ts:518-524`).
    pub fn select_tab(&self, tab_id: &str) -> bool {
        let mut g = self.guard();
        if !g.tabs.iter().any(|t| t.id == tab_id) {
            return false;
        }
        g.active_tab_id = Some(tab_id.to_string());
        true
    }

    /// `selectPane` (`layout-store.ts:526-540`): an explicit valid tabId wins;
    /// otherwise the first tab containing the pane. Also activates the tab.
    pub fn select_pane(&self, tab_id: Option<&str>, pane_id: &str) -> Option<(String, String)> {
        let mut g = self.guard();
        let explicit = tab_id.filter(|t| g.tabs.iter().any(|tab| &tab.id == t));
        let target = explicit.map(str::to_string).or_else(|| {
            g.tabs.iter().find_map(|tab| {
                g.layouts
                    .get(&tab.id)
                    .filter(|root| collect_leaves(root).iter().any(|l| l.id == pane_id))
                    .map(|_| tab.id.clone())
            })
        })?;
        g.active_pane.insert(target.clone(), pane_id.to_string());
        g.active_tab_id = Some(target.clone());
        Some((target, pane_id.to_string()))
    }

    /// `renameTab` (`layout-store.ts:542-556`): renames the tab; a single-pane
    /// tab cascades the title into its only pane (marked user-set).
    pub fn rename_tab(&self, tab_id: &str, title: Option<String>) -> bool {
        let mut g = self.guard();
        let Some(idx) = g.tabs.iter().position(|t| t.id == tab_id) else {
            return false;
        };
        g.tabs[idx].title = title.clone();
        let single = g.single_pane_id(tab_id);
        if let (Some(pane_id), Some(title)) = (single, title) {
            g.ensure_pane_title_maps(tab_id);
            if let Some(m) = g.pane_titles.get_mut(tab_id).and_then(Value::as_object_mut) {
                m.insert(pane_id.clone(), Value::from(title));
            }
            if let Some(m) = g
                .pane_title_set_by_user
                .get_mut(tab_id)
                .and_then(Value::as_object_mut)
            {
                m.insert(pane_id, Value::from(true));
            }
        }
        true
    }

    /// `renamePane` (`layout-store.ts:558-575`): sets the user-set title (and
    /// cascades into the tab title when this pane is the tab's only pane).
    pub fn rename_pane(&self, pane_id: &str, title: &str) -> Option<(String, String)> {
        let tab_id = self.get_pane_snapshot(pane_id)?.tab_id;
        let mut g = self.guard();
        g.ensure_pane_title_maps(&tab_id);
        if let Some(m) = g
            .pane_titles
            .get_mut(&tab_id)
            .and_then(Value::as_object_mut)
        {
            m.insert(pane_id.to_string(), Value::from(title));
        }
        if let Some(m) = g
            .pane_title_set_by_user
            .get_mut(&tab_id)
            .and_then(Value::as_object_mut)
        {
            m.insert(pane_id.to_string(), Value::from(true));
        }
        if g.single_pane_id(&tab_id).as_deref() == Some(pane_id) {
            if let Some(tab) = g.tabs.iter_mut().find(|t| t.id == tab_id) {
                tab.title = Some(title.to_string());
            }
        }
        Some((tab_id, pane_id.to_string()))
    }

    /// `closeTab` (`layout-store.ts:577-587`): removes the tab, its layout,
    /// active-pane entry, and ALL title metadata; the active tab falls forward
    /// to the first remaining tab (or null).
    pub fn close_tab(&self, tab_id: &str) -> bool {
        let mut g = self.guard();
        let next_tabs: Vec<freshell_protocol::UiLayoutTab> =
            g.tabs.iter().filter(|t| t.id != tab_id).cloned().collect();
        if next_tabs.len() == g.tabs.len() {
            return false;
        }
        g.layouts.remove(tab_id);
        g.active_pane.remove(tab_id);
        g.pane_titles.remove(tab_id);
        g.pane_title_set_by_user.remove(tab_id);
        g.tabs = next_tabs;
        g.active_tab_id = g.tabs.first().map(|t| t.id.clone());
        true
    }

    /// `swapPane` (`layout-store.ts:609-654`): exchange the CONTENT of two
    /// panes in one tab (tree position untouched), titles + setByUser flags
    /// traveling WITH the content. `None` when no single tab holds both.
    pub fn swap_pane(&self, tab_id: Option<&str>, a_id: &str, b_id: &str) -> Option<String> {
        let mut g = self.guard();
        let target = tab_id.map(str::to_string).or_else(|| {
            g.tabs.iter().find_map(|tab| {
                g.layouts.get(&tab.id).and_then(|root| {
                    let leaves = collect_leaves(root);
                    (leaves.iter().any(|l| l.id == a_id) && leaves.iter().any(|l| l.id == b_id))
                        .then(|| tab.id.clone())
                })
            })
        })?;
        let root = g.layouts.get(&target)?;
        let leaves = collect_leaves(root);
        let a_content = leaves.iter().find(|l| l.id == a_id)?.content.clone();
        let b_content = leaves.iter().find(|l| l.id == b_id)?.content.clone();
        let with_a = find_and_replace(root, a_id, &leaf_value(a_id, b_content))?;
        let with_both = find_and_replace(&with_a, b_id, &leaf_value(b_id, a_content))?;
        g.layouts.insert(target.clone(), with_both);
        g.swap_title_entry(&target, a_id, b_id);
        Some(target)
    }

    /// `resizePane` (`layout-store.ts:656-678`): set the sizes of the split
    /// node `split_id`. Tab resolution: the explicit `tab_id` when given,
    /// else the first tab whose tree CONTAINS A NODE with that id (legacy's
    /// stack walk accepts any node type, not just splits). A missing layout
    /// root for an explicit tab no-ops (legacy assigns `undefined`, dropped
    /// on read — an unobservable corner the route never reaches).
    pub fn resize_pane(
        &self,
        tab_id: Option<&str>,
        split_id: &str,
        sizes: [f64; 2],
    ) -> Option<String> {
        let mut g = self.guard();
        let target = tab_id.map(str::to_string).or_else(|| {
            g.tabs.iter().find_map(|tab| {
                let root = g.layouts.get(&tab.id)?;
                contains_node_id(root, split_id).then(|| tab.id.clone())
            })
        })?;
        if let Some(root) = g.layouts.get(&target) {
            let resized = set_split_sizes(root, split_id, sizes);
            g.layouts.insert(target.clone(), resized);
        }
        Some(target)
    }

    /// `attachPaneContent` (`layout-store.ts:680-694`): replace a leaf's
    /// content (normalized) and re-seed its title if the user never named it.
    /// The tab must exist; a missing pane is a no-op (legacy parity).
    pub fn attach_pane_content(&self, tab_id: &str, pane_id: &str, content: Value) -> bool {
        let mut g = self.guard();
        let Some(root) = g.layouts.get(tab_id) else {
            return false;
        };
        let normalized = migrate_content(&content);
        let leaf = serde_json::json!({ "type": "leaf", "id": pane_id, "content": normalized });
        let updated = find_and_replace(root, pane_id, &leaf);
        if let Some(updated) = updated {
            g.layouts.insert(tab_id.to_string(), updated);
        }
        g.seed_pane_title(tab_id, pane_id, leaf.get("content").unwrap_or(&Value::Null));
        true
    }

    /// `hasTab` (`layout-store.ts:336-339`): match by id OR title.
    pub fn has_tab(&self, target: &str) -> bool {
        let g = self.guard();
        g.tabs
            .iter()
            .any(|t| t.id == target || t.title.as_deref() == Some(target))
    }

    /// The current `activeTabId` (`getActiveTabId`).
    pub fn active_tab_id(&self) -> Option<String> {
        self.guard().active_tab_id.clone()
    }

    /// `getPaneSnapshot` (`layout-store.ts:379-397`): first-match tab order.
    pub fn get_pane_snapshot(&self, pane_id: &str) -> Option<PaneSnapshot> {
        let g = self.guard();
        for tab in &g.tabs {
            let Some(root) = g.layouts.get(&tab.id) else {
                continue;
            };
            let leaves = collect_leaves(root);
            if let Some(index) = leaves.iter().position(|l| l.id == pane_id) {
                return Some(PaneSnapshot {
                    tab_id: tab.id.clone(),
                    pane_id: pane_id.to_string(),
                    index,
                    pane_content: leaves.into_iter().nth(index).and_then(|l| l.content),
                });
            }
        }
        None
    }

    /// `resolvePaneToTerminal` (`layout-store.ts:357-364`).
    pub fn resolve_pane_to_terminal(&self, pane_id: &str) -> Option<String> {
        self.get_pane_snapshot(pane_id)?
            .pane_content?
            .get("terminalId")?
            .as_str()
            .map(str::to_string)
    }

    /// `findPaneByTerminalId` (`layout-store.ts:368-377`).
    pub fn find_pane_by_terminal_id(&self, terminal_id: &str) -> Option<(String, String)> {
        let g = self.guard();
        for tab in &g.tabs {
            let Some(root) = g.layouts.get(&tab.id) else {
                continue;
            };
            if let Some(leaf) = collect_leaves(root).into_iter().find(|leaf| {
                leaf.content
                    .as_ref()
                    .and_then(|c| c.get("terminalId"))
                    .and_then(Value::as_str)
                    == Some(terminal_id)
            }) {
                return Some((tab.id.clone(), leaf.id));
            }
        }
        None
    }

    /// `findSplitForPane` (`layout-store.ts:399-407`): the DIRECT parent
    /// split of this leaf (legacy `findParentSplitId`).
    pub fn find_split_for_pane(&self, pane_id: &str) -> Option<(String, String)> {
        let g = self.guard();
        for tab in &g.tabs {
            if let Some(split_id) = g
                .layouts
                .get(&tab.id)
                .and_then(|root| find_parent_split_id(root, pane_id))
            {
                return Some((tab.id.clone(), split_id));
            }
        }
        None
    }

    /// `getSplitSizes` (`layout-store.ts:409-424`): `[number, number]` only.
    pub fn get_split_sizes(&self, tab_id: Option<&str>, split_id: &str) -> Option<(f64, f64)> {
        let g = self.guard();
        let candidates: Vec<String> = tab_id
            .map(|t| vec![t.to_string()])
            .unwrap_or_else(|| g.tabs.iter().map(|t| t.id.clone()).collect());
        for candidate in candidates {
            let Some(node) = g
                .layouts
                .get(&candidate)
                .and_then(|root| find_split_by_id(root, split_id))
            else {
                continue;
            };
            let sizes = node.get("sizes")?.as_array()?;
            if sizes.len() != 2 {
                return None;
            }
            let first = sizes[0].as_f64()?;
            let second = sizes[1].as_f64()?;
            if !first.is_finite() || !second.is_finite() {
                return None;
            }
            return Some((first, second));
        }
        None
    }
}
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

/// The outcome of `close_pane` (legacy result shapes: `{message:'pane not
/// found'}` / `'cannot close only pane'` / `{tabId}`).
#[derive(Debug, Clone, PartialEq)]
pub enum ClosePaneOutcome {
    NotFound,
    LastPane,
    Closed(String),
}

/// One located pane (`layout-store.ts::getPaneSnapshot` subset: the
/// `kind`/`terminalId` fields are read off `pane_content` by callers).
#[derive(Debug, Clone, PartialEq)]
pub struct PaneSnapshot {
    pub tab_id: String,
    pub pane_id: String,
    pub index: usize,
    pub pane_content: Option<Value>,
}

/// One leaf of a layout tree.
#[derive(Clone)]
struct Leaf {
    id: String,
    content: Option<Value>,
}

/// `findAndReplace` (`layout-store.ts:299-315`): replace the node whose `id`
/// matches (leaf OR split, root included) with `replacement`, rebuilding the
/// path; `None` when nothing matched.
fn find_and_replace(node: &Value, target_id: &str, replacement: &Value) -> Option<Value> {
    let obj = node.as_object()?;
    if obj.get("id").and_then(Value::as_str) == Some(target_id) {
        return Some(replacement.clone());
    }
    if obj.get("type").and_then(Value::as_str) != Some("split") {
        return None;
    }
    let children = obj.get("children")?.as_array()?;
    if let Some(left) = children.first() {
        if let Some(left_result) = find_and_replace(left, target_id, replacement) {
            let mut out = obj.clone();
            let mut new_children = children.clone();
            new_children[0] = left_result;
            out.insert("children".to_string(), Value::Array(new_children));
            return Some(Value::Object(out));
        }
    }
    if let Some(right) = children.get(1) {
        if let Some(right_result) = find_and_replace(right, target_id, replacement) {
            let mut out = obj.clone();
            let mut new_children = children.clone();
            new_children[1] = right_result;
            out.insert("children".to_string(), Value::Array(new_children));
            return Some(Value::Object(out));
        }
    }
    None
}

/// `findSplitById` (`layout-store.ts:241-245`): splits only — a matching leaf
/// or non-split root never resolves.
fn find_split_by_id(node: &Value, split_id: &str) -> Option<Value> {
    let obj = node.as_object()?;
    if obj.get("type").and_then(Value::as_str) != Some("split") {
        return None;
    }
    if obj.get("id").and_then(Value::as_str) == Some(split_id) {
        return Some(node.clone());
    }
    let children = obj.get("children")?.as_array()?;
    children
        .first()
        .and_then(|c| find_split_by_id(c, split_id))
        .or_else(|| children.get(1).and_then(|c| find_split_by_id(c, split_id)))
}

/// `findParentSplitId` (`layout-store.ts:232-239`): the split whose DIRECT
/// child leaf bears `pane_id`.
fn find_parent_split_id(node: &Value, pane_id: &str) -> Option<String> {
    let obj = node.as_object()?;
    if obj.get("type").and_then(Value::as_str) != Some("split") {
        return None;
    }
    let children = obj.get("children")?.as_array()?;
    let direct = children.iter().take(2).any(|child| {
        child.get("type").and_then(Value::as_str) == Some("leaf")
            && child.get("id").and_then(Value::as_str) == Some(pane_id)
    });
    if direct {
        return obj.get("id").and_then(Value::as_str).map(str::to_string);
    }
    children
        .first()
        .and_then(|c| find_parent_split_id(c, pane_id))
        .or_else(|| {
            children
                .get(1)
                .and_then(|c| find_parent_split_id(c, pane_id))
        })
}

/// `setSplitSizes` — legacy's `update` walk inside `resizePane`
/// (`layout-store.ts:670-675`): leafs and unknown nodes are returned
/// unchanged; the `sizes` write lands on the node whose id matches.
fn set_split_sizes(node: &Value, split_id: &str, sizes: [f64; 2]) -> Value {
    let Some(obj) = node.as_object() else {
        return node.clone();
    };
    if obj.get("type").and_then(Value::as_str) == Some("leaf") {
        return node.clone();
    }
    if obj.get("id").and_then(Value::as_str) == Some(split_id) {
        let mut out = obj.clone();
        out.insert("sizes".to_string(), serde_json::json!([sizes[0], sizes[1]]));
        return Value::Object(out);
    }
    if obj.get("type").and_then(Value::as_str) != Some("split") {
        return node.clone();
    }
    let Some(children) = obj.get("children").and_then(Value::as_array) else {
        return node.clone();
    };
    let updated: Vec<Value> = children
        .iter()
        .map(|c| set_split_sizes(c, split_id, sizes))
        .collect();
    let mut out = obj.clone();
    out.insert("children".to_string(), Value::Array(updated));
    Value::Object(out)
}

/// Legacy `resizePane`'s tab-resolution stack walk (`layout-store.ts:658-667`):
/// true when ANY node in the tree bears this id.
fn contains_node_id(node: &Value, id: &str) -> bool {
    let mut stack = vec![node];
    while let Some(node) = stack.pop() {
        let Some(obj) = node.as_object() else {
            continue;
        };
        if obj.get("id").and_then(Value::as_str) == Some(id) {
            return true;
        }
        if obj.get("type").and_then(Value::as_str) == Some("split") {
            if let Some(children) = obj.get("children").and_then(Value::as_array) {
                stack.extend(children.iter());
            }
        }
    }
    false
}

/// A `{type:'leaf', id, content?}` node; `content` is OMITTED when absent
/// (legacy spread leaves an `undefined` the JSON read drops — omitting is the
/// wire-identical shape).
fn leaf_value(id: &str, content: Option<Value>) -> Value {
    let mut out = Map::new();
    out.insert("type".to_string(), Value::from("leaf"));
    out.insert("id".to_string(), Value::from(id));
    if let Some(content) = content {
        out.insert("content".to_string(), content);
    }
    Value::Object(out)
}

/// `buildGridLayout`/`buildHorizontalRow` (`layout-store.ts:253-297`) — the
/// layout REGENERATION closePane performs; split ids are minted (uuid4,
/// legacy uses nanoid — the minting source already differs crate-wide).
fn build_grid_layout(leaves: Vec<Leaf>) -> Value {
    fn node_of(leaf: &Leaf) -> Value {
        leaf_value(&leaf.id, leaf.content.clone())
    }
    fn split(direction: &str, left: Value, right: Value) -> Value {
        serde_json::json!({
            "type": "split",
            "id": uuid::Uuid::new_v4().to_string(),
            "direction": direction,
            "sizes": [50.0, 50.0],
            "children": [left, right],
        })
    }
    fn horizontal_row(leaves: &[Leaf]) -> Value {
        match leaves.len() {
            1 => node_of(&leaves[0]),
            2 => split("horizontal", node_of(&leaves[0]), node_of(&leaves[1])),
            n => {
                let mid = n.div_ceil(2);
                split(
                    "horizontal",
                    horizontal_row(&leaves[..mid]),
                    horizontal_row(&leaves[mid..]),
                )
            }
        }
    }
    match leaves.len() {
        0 => Value::Null,
        1 => node_of(&leaves[0]),
        2 => split("horizontal", node_of(&leaves[0]), node_of(&leaves[1])),
        n => {
            let top = n.div_ceil(2);
            split(
                "vertical",
                horizontal_row(&leaves[..top]),
                horizontal_row(&leaves[top..]),
            )
        }
    }
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
        let Value::Object(panes) = panes else {
            continue;
        };
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

// ── Normalization (`shared/fresh-agent.ts` + `shared/session-contract.ts`) ──

/// `migrateLegacyFreshAgentNode` (`shared/fresh-agent.ts:340-359`): leaf
/// contents migrate, split children recurse, everything else passes through.
fn migrate_node(node: &Value) -> Value {
    let Some(obj) = node.as_object() else {
        return node.clone();
    };
    match obj.get("type").and_then(Value::as_str) {
        Some("leaf") => {
            let content = obj
                .get("content")
                .filter(|c| c.is_object())
                .map(migrate_content);
            let Some(content) = content else {
                return node.clone();
            };
            let mut out = obj.clone();
            out.insert("content".to_string(), content);
            Value::Object(out)
        }
        Some("split") => {
            let Some(children) = obj.get("children").and_then(Value::as_array) else {
                return node.clone();
            };
            let migrated: Vec<Value> = children.iter().map(migrate_node).collect();
            let mut out = obj.clone();
            out.insert("children".to_string(), Value::Array(migrated));
            Value::Object(out)
        }
        _ => node.clone(),
    }
}

/// `isCanonicalClaudeSessionId` (`session-contract.ts:69-81`): UUID shape
/// `8-4-4-4-12` hex, version `[1-5]`, variant `[89ab]`, ASCII case-insensitive.
fn is_canonical_claude_session_id(value: &str) -> bool {
    let segs: Vec<&str> = value.split('-').collect();
    let lens = [8usize, 4, 4, 4, 12];
    if segs.len() != 5 || segs.iter().zip(lens).any(|(s, l)| s.len() != l) {
        return false;
    }
    let hex = |s: &str| s.bytes().all(|b| b.is_ascii_hexdigit());
    segs[..].iter().all(|s| hex(s))
        && segs[2].as_bytes()[0].is_ascii_digit()
        && (b'1'..=b'5').contains(&segs[2].as_bytes()[0])
        && matches!(
            segs[3].as_bytes()[0].to_ascii_lowercase(),
            b'8' | b'9' | b'a' | b'b'
        )
}

/// Session types legacy recognizes (`FRESH_AGENT_DESCRIPTORS`).
fn normalize_session_type(value: Option<&Value>) -> Option<&'static str> {
    match value.and_then(Value::as_str) {
        Some("freshclaude") => Some("freshclaude"),
        Some("freshcodex") => Some("freshcodex"),
        Some("kilroy") => Some("kilroy"),
        Some("freshopencode") => Some("freshopencode"),
        _ => None,
    }
}

/// `resolveFreshAgentRuntimeProvider` (`shared/fresh-agent.ts:116-120`).
fn runtime_provider(session_type: Option<&str>) -> Option<&'static str> {
    match session_type {
        Some("freshclaude") | Some("kilroy") => Some("claude"),
        Some("freshcodex") => Some("codex"),
        Some("freshopencode") => Some("opencode"),
        _ => None,
    }
}

/// `sanitizeSessionRef` (`session-contract.ts:90-97`): an object with
/// non-empty string `provider` + `sessionId`.
fn sanitize_session_ref(value: Option<&Value>) -> Option<(String, String)> {
    let obj = value?.as_object()?;
    let provider = obj.get("provider")?.as_str().filter(|s| !s.is_empty())?;
    let session_id = obj.get("sessionId")?.as_str().filter(|s| !s.is_empty())?;
    Some((provider.to_string(), session_id.to_string()))
}

/// `buildRestoreError(reason)` (`session-contract.ts:83-88`).
fn build_restore_error(reason: &str) -> Value {
    serde_json::json!({ "code": "RESTORE_UNAVAILABLE", "reason": reason })
}

/// `readRestoreError` (`shared/fresh-agent.ts:190-197`): only the five known
/// reasons, only the exact code.
fn read_restore_error(value: Option<&Value>) -> Option<Value> {
    let obj = value?.as_object()?;
    if obj.get("code")?.as_str()? != "RESTORE_UNAVAILABLE" {
        return None;
    }
    let reason = obj.get("reason")?.as_str()?;
    const REASONS: [&str; 5] = [
        "missing_canonical_identity",
        "invalid_legacy_restore_target",
        "dead_live_handle",
        "provider_runtime_failed",
        "durable_artifact_missing",
    ];
    REASONS
        .contains(&reason)
        .then(|| build_restore_error(reason))
}

/// The restored identity a migration derived: either a usable `sessionRef`
/// or a `restoreError` (`migrateLegacyFreshAgentDurableState`,
/// `shared/fresh-agent.ts:140-188` with `rejectNonCanonicalClaudeSessionRef:
/// true` — the only call shape any of these paths use).
#[derive(Clone)]
enum DurableState {
    Ref(String, String),
    RestoreError,
    Empty,
}

fn migrate_durable_state(
    provider: Option<&str>,
    session_ref: Option<&Value>,
    resume_session_id: Option<&str>,
) -> DurableState {
    if let Some((ref_provider, ref_session_id)) = sanitize_session_ref(session_ref) {
        if ref_provider == "claude" && !is_canonical_claude_session_id(&ref_session_id) {
            return DurableState::RestoreError;
        }
        return DurableState::Ref(ref_provider, ref_session_id);
    }
    let (Some(provider), Some(resume_session_id)) = (provider, resume_session_id) else {
        return DurableState::Empty;
    };
    if provider == "claude" {
        if is_canonical_claude_session_id(resume_session_id) {
            return DurableState::Ref(provider.to_string(), resume_session_id.to_string());
        }
        return DurableState::RestoreError;
    }
    DurableState::Ref(provider.to_string(), resume_session_id.to_string())
}

/// The resume-id input fallthrough (`resumeSessionId ?? timelineSessionId ??
/// cliSessionId`), all reads string-typed.
fn resume_id_of(obj: &Map<String, Value>) -> Option<&str> {
    ["resumeSessionId", "timelineSessionId", "cliSessionId"]
        .iter()
        .find_map(|k| obj.get(*k).and_then(Value::as_str))
}

/// The identity keys every migration output rebuilds from scratch
/// (`shared/fresh-agent.ts`'s destructuring rest-omissions).
const STRIPPED_KEYS: [&str; 7] = [
    "kind",
    "provider",
    "sessionRef",
    "resumeSessionId",
    "timelineSessionId",
    "cliSessionId",
    "restoreError",
];

fn rest_without_identity(obj: &Map<String, Value>) -> Map<String, Value> {
    obj.iter()
        .filter(|(k, _)| !STRIPPED_KEYS.contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

fn restore_error_ref() -> Value {
    build_restore_error("invalid_legacy_restore_target")
}

/// `migrateLegacyFreshAgentContent` (`shared/fresh-agent.ts:199-334`).
fn migrate_content(content: &Value) -> Value {
    let Some(obj) = content.as_object() else {
        return content.clone();
    };
    let kind = obj.get("kind").and_then(Value::as_str);
    let raw_resume = obj.get("resumeSessionId").and_then(Value::as_str);

    let finish = |session_type: &str,
                  provider: &str,
                  durable: Option<DurableState>,
                  existing_error: Option<Value>|
     -> Value {
        let mut out = rest_without_identity(obj);
        out.insert("kind".to_string(), Value::from("fresh-agent"));
        out.insert("provider".to_string(), Value::from(provider));
        out.insert("sessionType".to_string(), Value::from(session_type));
        let error = existing_error.or(durable.clone().and_then(|d| match d {
            DurableState::RestoreError => Some(restore_error_ref()),
            _ => None,
        }));
        if let Some(error) = error {
            // Invalid-legacy errors DROP the pre-adoption resume breadcrumbs;
            // every other error echo of `resumeSessionId` happens only when
            // the input carried a real string resumeSessionId (never the
            // timeline/cli fallthrough) — `shared/fresh-agent.ts:236-238,323-327`.
            let reason = error.get("reason").and_then(Value::as_str);
            if reason != Some("invalid_legacy_restore_target") {
                if let Some(resume) = raw_resume {
                    out.insert("resumeSessionId".to_string(), Value::from(resume));
                }
            }
            out.insert("restoreError".to_string(), error);
            return Value::Object(out);
        }
        if let Some(resume) = raw_resume {
            out.insert("resumeSessionId".to_string(), Value::from(resume));
        }
        if let Some(DurableState::Ref(provider, session_id)) = durable {
            out.insert(
                "sessionRef".to_string(),
                serde_json::json!({ "provider": provider, "sessionId": session_id }),
            );
        }
        Value::Object(out)
    };

    if kind == Some("fresh-agent") {
        let session_type = normalize_session_type(obj.get("sessionType"))
            .or_else(|| normalize_session_type(obj.get("provider")));
        let provider = match obj.get("provider").and_then(Value::as_str) {
            Some(p @ ("claude" | "codex" | "opencode")) => Some(p),
            _ => runtime_provider(session_type),
        };
        let (Some(session_type), Some(provider)) = (session_type, provider) else {
            return content.clone();
        };
        if let Some(existing) = read_restore_error(obj.get("restoreError")) {
            return finish(session_type, provider, None, Some(existing));
        }
        let durable =
            migrate_durable_state(Some(provider), obj.get("sessionRef"), resume_id_of(obj));
        return finish(session_type, provider, Some(durable), None);
    }

    if kind != Some("agent-chat") {
        return content.clone();
    }

    let raw_provider = obj.get("provider").and_then(Value::as_str);
    let session_type = normalize_session_type(obj.get("provider")).or(raw_provider
        .filter(|p| *p == "claude")
        .map(|_| "freshclaude"));
    let provider = runtime_provider(session_type)
        .or(raw_provider.filter(|p| *p == "claude").map(|_| "claude"));
    let durable = migrate_durable_state(provider, obj.get("sessionRef"), resume_id_of(obj));
    let has_usable_identity = matches!(durable, DurableState::Ref(..))
        || obj
            .get("sessionId")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty());
    let existing = read_restore_error(obj.get("restoreError"));
    let derived_error = match durable {
        DurableState::RestoreError => Some(restore_error_ref()),
        _ if session_type.is_none() || provider.is_none() || !has_usable_identity => {
            Some(restore_error_ref())
        }
        _ => None,
    };
    let durable = match (existing.is_some() || derived_error.is_some(), durable) {
        (true, _) => None,
        (false, DurableState::Empty) => None,
        (false, d) => Some(d),
    };
    finish(
        session_type.unwrap_or("freshclaude"),
        provider.unwrap_or("claude"),
        durable,
        existing.or(derived_error),
    )
}

impl LayoutState {
    /// `ensurePaneTitleMaps` (`layout-store.ts:52-58`).
    fn ensure_pane_title_maps(&mut self, tab_id: &str) {
        self.pane_titles
            .entry(tab_id.to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        self.pane_title_set_by_user
            .entry(tab_id.to_string())
            .or_insert_with(|| Value::Object(Map::new()));
    }

    /// `seedPaneTitle` (`layout-store.ts:161-167`): never overwrites a
    /// user-set title; `getPaneTitleMaps` creates BOTH per-tab maps, so a
    /// seeded tab's setByUser map may exist while EMPTY.
    fn seed_pane_title(&mut self, tab_id: &str, pane_id: &str, content: &Value) {
        let Some(title) = derive_pane_title(content) else {
            return;
        };
        self.ensure_pane_title_maps(tab_id);
        let user_set = self
            .pane_title_set_by_user
            .get(tab_id)
            .and_then(|m| m.get(pane_id))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if user_set {
            return;
        }
        if let Some(m) = self
            .pane_titles
            .get_mut(tab_id)
            .and_then(Value::as_object_mut)
        {
            m.insert(pane_id.to_string(), Value::from(title));
        }
    }

    /// `removePaneMetadata` (`layout-store.ts:71-85`): drop the pane's entries
    /// and prune the per-tab maps when they turn empty.
    fn remove_pane_metadata(&mut self, tab_id: &str, pane_id: &str) {
        for map in [&mut self.pane_titles, &mut self.pane_title_set_by_user] {
            let prune = match map.get_mut(tab_id).and_then(Value::as_object_mut) {
                Some(m) => {
                    m.remove(pane_id);
                    m.is_empty()
                }
                None => false,
            };
            if prune {
                map.remove(tab_id);
            }
        }
    }

    /// `getSinglePaneId` (`layout-store.ts:247-251`).
    fn single_pane_id(&self, tab_id: &str) -> Option<String> {
        let root = self.layouts.get(tab_id)?;
        if root.get("type").and_then(Value::as_str) != Some("leaf") {
            return None;
        }
        root.get("id").and_then(Value::as_str).map(str::to_string)
    }

    /// The title-map side of `swapPane` (`layout-store.ts:625-652`): titles
    /// and setByUser flags travel with content; an absent counterpart deletes
    /// the entry (legacy's `undefined` assignment semantics).
    fn swap_title_entry(&mut self, tab_id: &str, a_id: &str, b_id: &str) {
        // Legacy gates the whole swap on the title map EXISTING for the tab.
        if self.pane_titles.get(tab_id).is_some() {
            let (ta, tb) = {
                let m = self.pane_titles.get(tab_id);
                (
                    m.and_then(|m| m.get(a_id)).cloned(),
                    m.and_then(|m| m.get(b_id)).cloned(),
                )
            };
            let entries = [(a_id, tb), (b_id, ta)];
            if let Some(m) = self
                .pane_titles
                .get_mut(tab_id)
                .and_then(Value::as_object_mut)
            {
                for (pane, value) in entries {
                    match value {
                        Some(v) => {
                            m.insert(pane.to_string(), v);
                        }
                        None => {
                            m.remove(pane);
                        }
                    }
                }
            }
        }
        if self.pane_title_set_by_user.get(tab_id).is_some() {
            let (ta, tb) = {
                let m = self.pane_title_set_by_user.get(tab_id);
                (
                    m.and_then(|m| m.get(a_id)).cloned(),
                    m.and_then(|m| m.get(b_id)).cloned(),
                )
            };
            let entries = [(a_id, tb), (b_id, ta)];
            if let Some(m) = self
                .pane_title_set_by_user
                .get_mut(tab_id)
                .and_then(Value::as_object_mut)
            {
                for (pane, value) in entries {
                    match value {
                        Some(v) => {
                            m.insert(pane.to_string(), v);
                        }
                        None => {
                            m.remove(pane);
                        }
                    }
                }
            }
        }
    }
}

/// `derivePaneTitle` (`layout-store.ts:93-159`). `None` == "no derivable
/// title" (legacy `undefined`).
fn derive_pane_title(content: &Value) -> Option<String> {
    let obj = content.as_object()?;
    match obj.get("kind").and_then(Value::as_str) {
        Some("editor") => {
            let file_path = obj.get("filePath").and_then(Value::as_str).unwrap_or("");
            if file_path.is_empty() {
                return Some("Editor".to_string());
            }
            let last = file_path
                .replace('\\', "/")
                .rsplit('/')
                .next()
                .unwrap_or("")
                .to_string();
            Some(if last.is_empty() {
                "Editor".to_string()
            } else {
                last
            })
        }
        Some("browser") => {
            let url = obj.get("url").and_then(Value::as_str).unwrap_or("");
            if url.is_empty() {
                return Some("Browser".to_string());
            }
            Some(url_hostname(url).unwrap_or_else(|| "Browser".to_string()))
        }
        Some("fresh-agent") => Some(
            match obj.get("sessionType").and_then(Value::as_str) {
                Some("freshclaude") => "Freshclaude",
                Some("freshcodex") => "Freshcodex",
                Some("freshopencode") => "OpenCode",
                Some("kilroy") => "Kilroy",
                _ => "Fresh Agent",
            }
            .to_string(),
        ),
        Some("extension") => Some(
            obj.get("extensionName")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or("Extension")
                .to_string(),
        ),
        Some("terminal") => Some(
            match obj.get("mode").and_then(Value::as_str) {
                Some("claude") => "Claude CLI",
                Some("codex") => "Codex CLI",
                Some("gemini") => "Gemini",
                Some("opencode") => "OpenCode",
                Some("kimi") => "Kimi",
                _ => match obj.get("shell").and_then(Value::as_str) {
                    Some("powershell") => "PowerShell",
                    Some("cmd") => "Command Prompt",
                    Some("wsl") => "WSL",
                    _ => "Shell",
                },
            }
            .to_string(),
        ),
        _ => None,
    }
}

/// `new URL(raw).hostname` for the URL shapes the legacy browser pane ever
/// carries (absolute `<scheme>://authority/...`), without pulling in a URL
/// crate: scheme must be `[A-Za-z][A-Za-z0-9+.-]*://`; authority strips
/// userinfo (`@`) and port (`:` after a non-`[` host), `[v6]` literals keep
/// their brackets. Anything else (relative, garbage) is `None` — which
/// `derive_pane_title` maps to "Browser", exactly like the legacy
/// `new URL()` throw path.
fn url_hostname(raw: &str) -> Option<String> {
    let scheme_end = raw.find("://")?;
    let scheme = &raw[..scheme_end];
    let mut chars = scheme.bytes();
    if !chars.next().is_some_and(|b| b.is_ascii_alphabetic())
        || !chars.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'))
    {
        return None;
    }
    let authority = &raw[scheme_end + 3..];
    let authority = authority.split(['/', '?', '#']).next().unwrap_or(authority);
    let no_userinfo = authority.rsplit('@').next().unwrap_or(authority);
    if no_userinfo.is_empty() {
        return None;
    }
    let host = if let Some(rest) = no_userinfo.strip_prefix('[') {
        let close = rest.find(']')?;
        &no_userinfo[..close + 2]
    } else {
        no_userinfo.split(':').next().unwrap_or(no_userinfo)
    };
    if host.is_empty() {
        return None;
    }
    Some(host.to_string())
}

#[cfg(test)]
#[path = "layout_store_tests.rs"]
mod tests;
