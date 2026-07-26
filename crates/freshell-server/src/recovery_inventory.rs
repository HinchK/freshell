//! B3/P1.9 Task 1 — the PURE recovery-inventory builder: joins tabs-snapshot
//! device unions with pane-ledger binding rows into the `/api/recovery`
//! inventory shape. No I/O here — Task 2 (the HTTP route) feeds it from the
//! snapshot store, the ledger, and the terminal registry, and consumes
//! `select_foreign_recent_generation_ids` when composing each device's union.
#![allow(dead_code)] // consumed by Task 2 (the /api/recovery route wiring)

use freshell_ws::pane_ledger::{BindingRow, RetiredReason, RowState};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub struct DeviceUnion {
    pub device_id: String,
    pub union_doc: Value,
}

const STALE_CLIENT_MS: u64 = 15 * 60 * 1000; // heartbeat cadence is 5 min (tabRegistrySync.ts:21, 475-477)

/// A15 staleness + A16 concurrent-client rules (D2): drop the requester's own
/// generations; drop clients ALL of whose retained generations postdate
/// `boot_cutoff_ms` (a client born after this browser session booted is a
/// concurrently-opened fresh window, never lost data — a lost client's pushes
/// all predate the fresh boot, so retention depth cannot misclassify it); then
/// drop clients whose newest generation is >15 min older than the device max
/// over the REMAINING clients (junk must never stale-out real recovery data).
pub fn select_foreign_recent_generation_ids(
    generations: &[Value],
    exclude_client: &str,
    boot_cutoff_ms: u64,
) -> Vec<String> {
    let foreign: Vec<&Value> = generations
        .iter()
        .filter(|g| g["clientInstanceId"].as_str() != Some(exclude_client))
        .collect();
    let mut oldest_by_client: HashMap<&str, u64> = HashMap::new();
    let mut newest_by_client: HashMap<&str, u64> = HashMap::new();
    for g in &foreign {
        let c = g["clientInstanceId"].as_str().unwrap_or("");
        let t = g["capturedAt"].as_u64().unwrap_or(0);
        let o = oldest_by_client.entry(c).or_insert(u64::MAX);
        if t < *o {
            *o = t;
        }
        let e = newest_by_client.entry(c).or_insert(0);
        if t > *e {
            *e = t;
        }
    }
    let pre_boot = |c: &str| oldest_by_client.get(c).copied().unwrap_or(u64::MAX) < boot_cutoff_ms;
    let device_max = newest_by_client
        .iter()
        .filter(|(c, _)| pre_boot(c))
        .map(|(_, t)| *t)
        .max()
        .unwrap_or(0);
    foreign
        .iter()
        .filter(|g| {
            let c = g["clientInstanceId"].as_str().unwrap_or("");
            pre_boot(c)
                && newest_by_client.get(c).copied().unwrap_or(0) + STALE_CLIENT_MS >= device_max
        })
        .filter_map(|g| g["generationId"].as_str().map(String::from))
        .collect()
}

fn ref_key(provider: &str, session_id: &str) -> String {
    format!("{provider}\u{1}{session_id}")
}

enum Verdict {
    Bound(String, String),
    Closed,
    GcExpired,
    Unknown,
}

/// Resolve a snapshot's sessionRef claim to its EFFECTIVE identity per D4 by
/// walking the ledger's superseded chain (bounded — a cycle degrades to
/// `GcExpired`, never loops).
fn resolve(provider: &str, session_id: &str, by_key: &HashMap<String, &BindingRow>) -> Verdict {
    let (mut p, mut s) = (provider.to_string(), session_id.to_string());
    for _ in 0..10 {
        match by_key.get(&ref_key(&p, &s)) {
            None => {
                return if (p.as_str(), s.as_str()) == (provider, session_id) {
                    Verdict::Unknown
                } else {
                    Verdict::GcExpired
                }
            }
            Some(row) if row_is_bound(row) => {
                return Verdict::Bound(row_provider(row), row_session_id(row))
            }
            Some(row) => match row_successor(row) {
                Some((np, ns)) => {
                    p = np;
                    s = ns;
                }
                None => {
                    return if row_reason_is_closed(row) {
                        Verdict::Closed
                    } else {
                        Verdict::GcExpired
                    }
                }
            },
        }
    }
    Verdict::GcExpired
}

pub fn build_inventory(
    device_unions: Vec<DeviceUnion>,
    bindings: Vec<BindingRow>,
    live_session_keys: HashSet<(String, String)>,
) -> Value {
    let by_key: HashMap<String, &BindingRow> = bindings
        .iter()
        .map(|r| (ref_key(&row_provider(r), &row_session_id(r)), r))
        .collect();
    let is_live = |p: &str, s: &str| live_session_keys.contains(&(p.to_string(), s.to_string()));

    // sort newest-first; primary device = greatest capturedAt with >=1 record
    let mut unions = device_unions;
    unions.sort_by_key(|d| std::cmp::Reverse(d.union_doc["capturedAt"].as_u64().unwrap_or(0)));

    // Pass 1 - resolve EVERY pane in EVERY union (not just the primary): effective refs
    // feed the cross-device ledgerOnly rule (A4) and the contentId substance (A5/A6);
    // the primary union's tabs feed `device`.
    let mut referenced: HashSet<String> = HashSet::new();
    let mut substance: Vec<String> = Vec::new();
    let mut tabs_per_union: Vec<Vec<Value>> = Vec::new();
    for d in &unions {
        let doc = &d.union_doc;
        let device_id = doc["deviceId"].as_str().unwrap_or("").to_string();
        let tabs: Vec<Value> = doc["records"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|rec| {
                let panes: Vec<Value> = rec["panes"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .map(|pane| {
                        let payload = &pane["payload"];
                        let snap_ref = payload.get("sessionRef").filter(|v| !v.is_null()).cloned();
                        let (ledger_state, eff_ref) = match &snap_ref {
                            None => ("unknown", None),
                            Some(r) => {
                                let (p, s) = (
                                    r["provider"].as_str().unwrap_or(""),
                                    r["sessionId"].as_str().unwrap_or(""),
                                );
                                match resolve(p, s, &by_key) {
                                    Verdict::Bound(bp, bs) => {
                                        ("bound", Some(json!({"provider": bp, "sessionId": bs})))
                                    }
                                    Verdict::Closed => ("closed", None),
                                    Verdict::GcExpired => ("gc_expired", Some(r.clone())),
                                    Verdict::Unknown => ("unknown", Some(r.clone())),
                                }
                            }
                        };
                        let eff_str = eff_ref
                            .as_ref()
                            .map(|r| {
                                format!(
                                    "{}:{}",
                                    r["provider"].as_str().unwrap_or(""),
                                    r["sessionId"].as_str().unwrap_or("")
                                )
                            })
                            .unwrap_or_else(|| "-".into());
                        let live = eff_ref
                            .as_ref()
                            .map(|r| {
                                is_live(
                                    r["provider"].as_str().unwrap_or(""),
                                    r["sessionId"].as_str().unwrap_or(""),
                                )
                            })
                            .unwrap_or(false);
                        if let Some(er) = &eff_ref {
                            referenced.insert(ref_key(
                                er["provider"].as_str().unwrap_or(""),
                                er["sessionId"].as_str().unwrap_or(""),
                            ));
                        }
                        // TIMESTAMP-FREE substance line: capturedAt/updatedAt deliberately absent (D3)
                        substance.push(format!(
                            "{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}",
                            device_id,
                            rec["tabKey"].as_str().unwrap_or(""),
                            pane["paneId"].as_str().unwrap_or(""),
                            pane["kind"].as_str().unwrap_or(""),
                            eff_str
                        ));
                        json!({
                            "paneId": pane["paneId"], "kind": pane["kind"],
                            "mode": payload.get("mode").cloned().unwrap_or(Value::Null),
                            "shell": payload.get("shell").cloned().unwrap_or(Value::Null),
                            "cwd": payload.get("initialCwd").cloned().unwrap_or(Value::Null),
                            "payload": payload.clone(),
                            "sessionRef": eff_ref.unwrap_or(Value::Null),
                            "ledgerState": ledger_state,
                            "live": live,
                        })
                    })
                    .collect();
                json!({"tabKey": rec["tabKey"], "tabName": rec["tabName"], "panes": panes})
            })
            .collect();
        tabs_per_union.push(tabs);
    }

    let primary_idx = unions.iter().position(|d| {
        d.union_doc["records"]
            .as_array()
            .map(|r| !r.is_empty())
            .unwrap_or(false)
    });

    let device = primary_idx.map(|i| {
        let doc = &unions[i].union_doc;
        json!({"deviceId": doc["deviceId"], "deviceLabel": doc["deviceLabel"],
               "capturedAt": doc["capturedAt"], "tabs": tabs_per_union[i].clone()})
    });

    let other_devices: Vec<Value> = unions
        .iter()
        .enumerate()
        .filter(|(i, _)| Some(*i) != primary_idx)
        .filter(|(_, d)| {
            d.union_doc["records"]
                .as_array()
                .map(|r| !r.is_empty())
                .unwrap_or(false)
        })
        .map(|(_, d)| {
            let pane_count: u64 = d.union_doc["records"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| r["panes"].as_array().map(|p| p.len() as u64).unwrap_or(0))
                .sum();
            json!({"deviceId": d.union_doc["deviceId"], "deviceLabel": d.union_doc["deviceLabel"],
                   "capturedAt": d.union_doc["capturedAt"], "paneCount": pane_count})
        })
        .collect();

    let ledger_only: Vec<Value> = bindings
        .iter()
        .filter(|r| row_is_bound(r))
        // vs effective refs across ALL unions (A4), not just the primary device
        .filter(|r| !referenced.contains(&ref_key(&row_provider(r), &row_session_id(r))))
        // live rows are excluded: sessions still running are never offered for resume (D7)
        .filter(|r| !is_live(&row_provider(r), &row_session_id(r)))
        .map(|r| {
            json!({"provider": row_provider(r), "sessionId": row_session_id(r),
                   "mode": row_mode(r), "cwd": row_cwd(r)})
        })
        .collect();

    // contentId: sha256 over the sorted TIMESTAMP-FREE substance (A5/A6, D3)
    substance.extend(ledger_only.iter().map(|e| {
        format!(
            "{}:{}",
            e["provider"].as_str().unwrap_or(""),
            e["sessionId"].as_str().unwrap_or("")
        )
    }));
    substance.sort();
    let content_id = digest16(&substance);

    let recoverable = device.is_some() || !ledger_only.is_empty();
    json!({"recoverable": recoverable, "contentId": content_id,
           "device": device.unwrap_or(Value::Null),
           "otherDevices": other_devices, "ledgerOnly": ledger_only})
}

// Thin accessors over the real `BindingRow` fields/enums
// (`crates/freshell-ws/src/pane_ledger.rs:93`) — single field accesses, no logic.

fn row_provider(r: &BindingRow) -> String {
    r.provider.clone()
}

fn row_session_id(r: &BindingRow) -> String {
    r.session_id.clone()
}

fn row_is_bound(r: &BindingRow) -> bool {
    r.state == RowState::Bound
}

fn row_reason_is_closed(r: &BindingRow) -> bool {
    r.retired_reason == Some(RetiredReason::Closed)
}

fn row_successor(r: &BindingRow) -> Option<(String, String)> {
    r.superseded_by
        .as_ref()
        .map(|l| (l.provider.clone(), l.session_id.clone()))
}

fn row_mode(r: &BindingRow) -> String {
    r.mode.clone()
}

fn row_cwd(r: &BindingRow) -> Option<String> {
    r.cwd.clone()
}

/// The `contentId` digest: sha256 over the parts joined with `\u{1}`,
/// hex-encoded, truncated to 16 chars (the tabs-persist digest convention,
/// `crates/freshell-ws/src/tabs_persist.rs:82-87`, at half width).
fn digest16(parts: &[String]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(parts.join("\u{1}").as_bytes());
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
#[path = "recovery_inventory_tests.rs"]
mod tests;
