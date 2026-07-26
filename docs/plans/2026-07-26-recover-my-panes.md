# Recover My Panes Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** When a browser connects with no local layout while the server holds recoverable state (pane-identity ledger bindings and/or tabs-snapshots), offer the user "Restore N panes from server memory?" — accept recreates the panes (snapshot = layout, ledger = identity per the §4.2 authority chain), decline is remembered. This resolves campaign item P1.9 and kata h9vt.

**Architecture:** A new authenticated `GET /api/recovery/inventory` endpoint (axum, `crates/freshell-server/src/recovery_inventory.rs`) joins the newest tabs-snapshot generation union (excluding the requesting client's own pushes) with pane-ledger bindings and returns a recoverable inventory. The client captures "had persisted layout at boot" at module load, fetches the inventory when eligible, and shows a self-gating offer panel; accept recreates tabs client-side through the existing `addTab` + `restoreLayout` path (the same path `reopenClosedTab` uses). The operator-only `POST /api/tabs-sync/restore` endpoint and its marker/fence machinery are deleted (kata h9vt Option A disposition, see below).

**Tech Stack:** Rust (axum 0.8, tokio, serde_json), React 18 + Redux Toolkit + Vitest/Testing Library, Playwright e2e with owned `RustServer` instances.

## Kata h9vt Disposition (decided during planning — state in the final report)

**Option A — the tabs-snapshots store becomes load-bearing.** Snapshots are the only durable source of *layout* (the ledger has identity but no layout; localStorage is exactly what's lost in the browser-loss scenario), so ledger-only recovery (Option B) cannot restore tabs/splits/cwd — the store stays.

Within Option A, per the directive "reuse what serves the UI flow, DELETE what doesn't":
- **REUSED:** the write path (`tabs_persist.rs`, untouched), and the read selectors (`list_snapshot_devices`, `read_device_overview`, `read_generations_union_by_ids`) which feed the new inventory endpoint.
- **DELETED (Task 9):** `POST /api/tabs-sync/restore`, the write-ahead marker module (`tabs_snapshots_marker.rs`), the exactly-one-browser gate, the screenshot delivery-fence (explicitly flagged for deletion — an unreachable fence is context poison), `scripts/restore-tabs.sh`, and `tabs_snapshots_create_body.rs`. Rationale: all of that machinery exists to make a *blind server-push* to an operator-invisible browser safe. The UI flow is client-driven — the client fetches the inventory and recreates panes itself through the normal create path — so there is no server-push, no ambiguous target browser, nothing for a marker or fence to protect.

## Design Decisions

**D1 — Trigger conditions (Principle 4 compliance).** The offer appears iff ALL of:
1. `localStorage` had NO layout key (`freshell.layout.v3` and `freshell.layout.v3.bak` both absent) **captured at module load**, before the auto-shell-tab (`App.tsx:1423-1427`) and the 500 ms persist debounce can write one — OR a pending-offer flag from a prior undecided visit is set (see D3).
2. `GET /api/recovery/inventory` reports `recoverable: true`.
3. The inventory `contentId` is not in the dismissed list.

Consequences: *empty-never* and *empty-cleared* browsers (both have no layout key) get the offer — correct, both are genuinely new-browser situations. *Same-browser reload with intact localStorage* (key present) never sees the offer — even if the user deliberately closed all tabs (key present, zero tabs). Principle 4 ("never ask when we can act") is not violated: an empty client layout gives the server no client claim to adjudicate; silently materializing another device's layout onto a possibly-brand-new user's browser would be "silently wrong," so offering is the correct reading (the campaign plan's §4.4 itself says "offer"). `serverInstanceId` is NOT part of the trigger — snapshots and the ledger persist across restarts, and `restoreLayout` strips live-attach fields anyway.

**D2 — Self-pollution filter.** A fresh browser context mints a fresh per-window `clientInstanceId` (sessionStorage) and starts pushing snapshots (auto shell tab) within seconds. The inventory request carries `?clientInstanceId=<current>`; the server excludes that client's generations when building each device union, so the requester's own junk pushes never appear as "recoverable." (A fresh browser also mints a fresh `deviceId`, so its pushes usually land in a different device dir — the filter covers the selective-clear case where the deviceId survived.)

**D3 — Dismissal + pending persistence.** Decline writes the inventory `contentId` to `localStorage["freshell.recovery.dismissed.v1"]` (array, capped at 20). While the offer is shown but undecided, `localStorage["freshell.recovery.pending.v1"] = contentId` so a reload mid-decision (which by then has a persisted auto-tab layout) re-offers instead of silently losing the recovery chance; accept/decline clears it.

**D4 — Authority chain (§4.2): ledger identity beats snapshot claim.** For each snapshot pane with a `sessionRef`, the server joins the ledger and reports a verdict; the client uses `effectiveSessionRef`:
- ledger row chain (following `supersededBy`, max 10 hops) ends at a `bound` row → resume the **ledger's** `{provider, sessionId}` (snapshot claim overridden).
- row `retired` with reason `gc_expired` (no live successor) → keep the snapshot ref (the server attach path adjudicates revival — `pane_ledger_auto_resume`).
- row `retired` with reason `closed` → no resume; recreate a fresh pane in the same cwd/mode.
- no ledger row (e.g. fresh-agent sessions — the ledger has no rows for them) → the snapshot claim stands.

Bound ledger rows referenced by **no** snapshot pane are returned as `ledgerOnly` and recreated in an extra "Recovered sessions" tab, so ledger-known sessions are never dropped just because layout was lost.

**D5 — Recreation path.** Accept dispatches, per inventory tab: `addTab({id: nanoid(), title: tabName})` then `restoreLayout({tabId, layout, paneTitles})` — the exact path `reopenClosedTab` already exercises. `restoreLayout` re-mints `createRequestId`/`status` and strips `terminalId`, so after dispatch we read the post-normalization layout back from the store and arm terminal restore via `addTerminalRestoreRequestId(...)` for every terminal leaf carrying a `sessionRef` (the `App.tsx:1069` / `terminal-restore.ts` pattern) so the create goes out as a restore. Terminal panes get the D4 treatment; non-terminal kinds (`browser`, `editor`, `fresh-agent`, `extension`, `picker`) are recreated by passing the snapshot pane payload through as content (`{kind, ...payload}`) — the same normalize/strip path handles them, exactly as it does for `reopenClosedTab`. The auto-created empty shell tab from `App.tsx:1423` is left in place (deliberate: removing it would touch tab-lifecycle code other lanes own; it is one empty shell tab).

**D6 — Snapshot records have no split geometry** (flat `panes[]` per tab record), so recreation builds a right-leaning binary split chain (`direction: 'horizontal'`, `sizes: [50, 50]`) — panes come back, geometry is a default. This is what the store contains; not a deferral.

## Global Constraints

- Worktree: `/home/dan/code/freshell/.worktrees/recover-my-panes`, branch `feat/recover-my-panes`, base `origin/main@2dfbba58`. All commands below run from the worktree root.
- Rust: `cargo fmt --all` clean; `cargo clippy --workspace --all-targets -- -D warnings` green (required CI); `cargo test --workspace` green.
- Client: `npm run lint` green (jsx-a11y is a CI requirement); coordinated suites via `env -u FRESHELL_BIND_HOST npm test` (waits on the shared coordinator gate — WAIT if held, never kill a foreign holder; set `FRESHELL_TEST_SUMMARY="recover-my-panes lane B3"`); focused runs via `npm run test:vitest -- run <paths> [--config config/vitest/vitest.server.config.ts where noted]`.
- E2E: own `RustServer` instances on `findFreePort()` ephemeral ports — NEVER 3001/3002. Never restart the user's self-hosted server; never use broad kill patterns. ~78 GB disk — halt on ENOSPC.
- SCOPE FENCE — do NOT touch: `src/lib/ws-client.ts`; `App.tsx` regions 811-898, 900-981, 1002-1090, 1283-1325 (Lane B1); `crates/*/src/**/reconcile*` (B1); codex_candidate/locator (B2); `crates/freshell-freshagent/` (B4); the `tabs_persist.rs` WRITE path (read-only consumption is fine). No kimi/gemini work.
- Node test files use ESM: relative imports include `.js` extensions.
- PR policy: push the branch, STOP before `gh pr create`. Final report must state the kata h9vt disposition (Option A, restore endpoint + marker/fence deleted).
- Commit after every task with the trailer:

```
🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
```

## File Structure

| File | Responsibility |
|---|---|
| `crates/freshell-server/src/recovery_inventory.rs` (create) | Pure inventory builder + axum router/handler for `GET /api/recovery/inventory` |
| `crates/freshell-server/src/recovery_inventory_tests.rs` (create) | Sibling test module (house convention) |
| `crates/freshell-server/src/main.rs` (modify) | `mod recovery_inventory;` + one `.merge(...)` |
| `crates/freshell-server/src/tabs_snapshots.rs` (modify, Task 9) | Restore endpoint deleted; file shrinks to whatever the read side still needs |
| `crates/freshell-server/src/tabs_snapshots_marker.rs`, `tabs_snapshots_create_body.rs`, `tabs_snapshots_selectors.rs` (delete, Task 9) | Server-push machinery — no UI-flow consumer |
| `scripts/restore-tabs.sh` (delete, Task 9) | Operator curl wrapper for the deleted endpoint |
| `src/lib/recovery/boot-state.ts` (create) | Boot-time "had persisted layout" capture |
| `src/lib/recovery/dismissal.ts` (create) | Dismissed/pending localStorage persistence |
| `src/lib/recovery/types.ts` (create) | `RecoveryInventory` TS types |
| `src/lib/recovery/build-recovery-plan.ts` (create) | Pure inventory → (addTab payload, PaneNode layout) mapping incl. authority chain |
| `src/lib/api.ts` (modify) | `getRecoveryInventory` helper |
| `src/store/tabRegistrySync.ts` (modify) | Export the existing module-private clientInstanceId getter |
| `src/components/RecoveryOfferPanel.tsx` (create) | Self-gating offer panel (fetch, render, accept/decline) |
| `src/App.tsx` (modify) | One JSX line in a distinct `LANE B3` region next to `SetupWizard` (~line 1347-1362) |
| `test/unit/client/lib/recovery/*.test.ts` (create) | Unit tests for boot-state, dismissal, build-recovery-plan |
| `test/unit/client/components/RecoveryOfferPanel.test.tsx` (create) | Component tests |
| `test/e2e-browser/specs/recover-my-panes-rust.spec.ts` (create) | The browser-loss recovery e2e |

---

### Task 1: Server — pure inventory builder

**Files:**
- Create: `crates/freshell-server/src/recovery_inventory.rs`
- Create: `crates/freshell-server/src/recovery_inventory_tests.rs`
- Modify: `crates/freshell-server/src/main.rs` (add `mod recovery_inventory;` only)

**Interfaces:**
- Consumes: `freshell_ws::pane_ledger::BindingRow` (fields serialize camelCase: `provider`, `sessionId`, `mode`, `cwd`, `state: bound|retired`, `retiredReason?: superseded|closed|gc_expired`, `supersededBy?: {provider, sessionId}`, `updatedAt`). Snapshot union doc shape (from `tabs_persist.rs`): `{deviceId, deviceLabel, capturedAt, records: [{tabKey, tabId, tabName, revision, updatedAt, paneCount, panes: [{paneId, kind, payload: {mode?, shell?, initialCwd?, sessionRef?: {provider, sessionId}, createRequestId?, ...}}]}]}`.
- Produces: `pub struct DeviceUnion { pub device_id: String, pub union_doc: serde_json::Value }` and `pub fn build_inventory(device_unions: Vec<DeviceUnion>, bindings: Vec<BindingRow>) -> serde_json::Value` returning:

```json
{
  "recoverable": true,
  "contentId": "9f3a1c2e00112233",
  "device": {
    "deviceId": "dev1", "deviceLabel": "Dan's laptop", "capturedAt": 1000,
    "tabs": [
      { "tabKey": "k1", "tabName": "work",
        "panes": [
          { "paneId": "p1", "kind": "terminal", "mode": "claude", "shell": null,
            "cwd": "/home/dan/proj", "payload": { "...": "verbatim snapshot payload" },
            "sessionRef": { "provider": "claude", "sessionId": "S2" },
            "ledgerState": "bound" }
        ] }
    ]
  },
  "otherDevices": [ { "deviceId": "dev0", "deviceLabel": "old", "capturedAt": 500, "paneCount": 3 } ],
  "ledgerOnly": [ { "provider": "codex", "sessionId": "C9", "mode": "codex", "cwd": "/x" } ]
}
```

Rules encoded: `device` = the union with the greatest `capturedAt` that has ≥1 record; every pane's `sessionRef` in the response is the **effective** ref per Design Decision D4 (`ledgerState` ∈ `bound|closed|gc_expired|unknown`; `closed` ⇒ `sessionRef: null`); `ledgerOnly` = `state == bound` rows whose `(provider, sessionId)` matches no effective pane ref in the primary device; `contentId` = hex of `std::hash::DefaultHasher` over the sorted list of `<deviceId>:<capturedAt>` for all unions plus sorted `<provider>:<sessionId>:<updatedAt>` for all bound rows (`DefaultHasher::new()` is deterministic across runs); `recoverable` = primary device exists OR `ledgerOnly` non-empty. Empty input ⇒ `{"recoverable": false, "contentId": "...", "device": null, "otherDevices": [], "ledgerOnly": []}`.

- [ ] **Step 1: Write the failing tests**

Create `crates/freshell-server/src/recovery_inventory_tests.rs`. Use the sibling-module house convention. Construct `BindingRow` values directly (import from `freshell_ws::pane_ledger`; use its real field/enum names — open that file to copy them; e.g. if state is an enum use `BindingState::Bound`). Test bodies:

```rust
use super::*;
use serde_json::json;

fn union_doc(device: &str, captured_at: u64, panes: serde_json::Value) -> serde_json::Value {
    json!({
        "deviceId": device, "deviceLabel": format!("label-{device}"), "capturedAt": captured_at,
        "records": [{ "tabKey": "k1", "tabId": "t1", "tabName": "work", "revision": 1,
                      "updatedAt": captured_at, "paneCount": 1, "panes": panes }]
    })
}

#[test]
fn empty_inputs_not_recoverable() {
    let out = build_inventory(vec![], vec![]);
    assert_eq!(out["recoverable"], false);
    assert!(out["device"].is_null());
    assert_eq!(out["ledgerOnly"].as_array().unwrap().len(), 0);
}

#[test]
fn newest_device_wins_others_summarized() {
    let old = DeviceUnion { device_id: "dev0".into(), union_doc: union_doc("dev0", 500, json!([{ "paneId": "p0", "kind": "terminal", "payload": {"mode": "shell"} }])) };
    let new = DeviceUnion { device_id: "dev1".into(), union_doc: union_doc("dev1", 1000, json!([{ "paneId": "p1", "kind": "terminal", "payload": {"mode": "shell", "initialCwd": "/w"} }])) };
    let out = build_inventory(vec![old, new], vec![]);
    assert_eq!(out["recoverable"], true);
    assert_eq!(out["device"]["deviceId"], "dev1");
    assert_eq!(out["device"]["tabs"][0]["panes"][0]["cwd"], "/w");
    assert_eq!(out["otherDevices"][0]["deviceId"], "dev0");
    assert_eq!(out["otherDevices"][0]["paneCount"], 1);
}

#[test]
fn ledger_bound_row_overrides_snapshot_claim_via_superseded_chain() {
    // snapshot says S1; ledger: S1 retired(superseded -> S2), S2 bound
    let d = DeviceUnion { device_id: "dev1".into(), union_doc: union_doc("dev1", 1000,
        json!([{ "paneId": "p1", "kind": "terminal",
                 "payload": { "mode": "claude", "sessionRef": { "provider": "claude", "sessionId": "S1" } } }])) };
    let bindings = vec![
        binding_row("claude", "S1", retired_superseded_by("claude", "S2")),
        binding_row("claude", "S2", bound()),
    ];
    let out = build_inventory(vec![d], bindings);
    let pane = &out["device"]["tabs"][0]["panes"][0];
    assert_eq!(pane["ledgerState"], "bound");
    assert_eq!(pane["sessionRef"]["sessionId"], "S2"); // ledger identity beat the snapshot claim
    assert_eq!(out["ledgerOnly"].as_array().unwrap().len(), 0); // S2 is referenced, not ledger-only
}

#[test]
fn closed_row_strips_resume_gc_expired_keeps_snapshot_ref_unknown_passes_through() {
    let d = DeviceUnion { device_id: "dev1".into(), union_doc: union_doc("dev1", 1000, json!([
        { "paneId": "p1", "kind": "terminal", "payload": { "mode": "claude", "sessionRef": { "provider": "claude", "sessionId": "CLOSED" } } },
        { "paneId": "p2", "kind": "terminal", "payload": { "mode": "codex",  "sessionRef": { "provider": "codex",  "sessionId": "EXPIRED" } } },
        { "paneId": "p3", "kind": "fresh-agent", "payload": { "sessionRef": { "provider": "freshclaude", "sessionId": "NOROW" } } }
    ])) };
    let bindings = vec![
        binding_row("claude", "CLOSED", retired_closed()),
        binding_row("codex", "EXPIRED", retired_gc_expired()),
    ];
    let out = build_inventory(vec![d], bindings);
    let panes = out["device"]["tabs"][0]["panes"].as_array().unwrap();
    assert_eq!(panes[0]["ledgerState"], "closed");
    assert!(panes[0]["sessionRef"].is_null());
    assert_eq!(panes[1]["ledgerState"], "gc_expired");
    assert_eq!(panes[1]["sessionRef"]["sessionId"], "EXPIRED");
    assert_eq!(panes[2]["ledgerState"], "unknown");
    assert_eq!(panes[2]["sessionRef"]["sessionId"], "NOROW");
}

#[test]
fn unreferenced_bound_rows_become_ledger_only() {
    let out = build_inventory(vec![], vec![binding_row("codex", "C9", bound())]);
    assert_eq!(out["recoverable"], true);
    assert_eq!(out["ledgerOnly"][0]["sessionId"], "C9");
}

#[test]
fn content_id_is_stable_and_input_sensitive() {
    let a = build_inventory(vec![], vec![binding_row("codex", "C9", bound())]);
    let b = build_inventory(vec![], vec![binding_row("codex", "C9", bound())]);
    let c = build_inventory(vec![], vec![binding_row("codex", "C8", bound())]);
    assert_eq!(a["contentId"], b["contentId"]);
    assert_ne!(a["contentId"], c["contentId"]);
}
```

Write small local helpers `binding_row(provider, session_id, state_parts)`, `bound()`, `retired_closed()`, `retired_gc_expired()`, `retired_superseded_by(p, s)` that construct real `BindingRow` values (copy field names/enums from `crates/freshell-ws/src/pane_ledger.rs:93`; fill required timestamps with constants like `1000`).

Create `crates/freshell-server/src/recovery_inventory.rs` containing ONLY the types + an `unimplemented!()`-free stub that compiles but returns `json!(null)`, plus the test include:

```rust
#[cfg(test)]
#[path = "recovery_inventory_tests.rs"]
mod tests;
```

Add `mod recovery_inventory;` to `main.rs` (mirror how `mod tabs_snapshots;` is declared).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-server recovery_inventory -- --nocapture`
Expected: FAIL — assertions fail against the `null` stub (compilation must succeed; assertion failure is the red).

- [ ] **Step 3: Implement `build_inventory`**

In `recovery_inventory.rs`:

```rust
use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use freshell_ws::pane_ledger::BindingRow;
use serde_json::{json, Value};

pub struct DeviceUnion { pub device_id: String, pub union_doc: Value }

fn ref_key(provider: &str, session_id: &str) -> String { format!("{provider}\u{1}{session_id}") }

enum Verdict { Bound(String, String), Closed, GcExpired, Unknown }

fn resolve(provider: &str, session_id: &str, by_key: &HashMap<String, &BindingRow>) -> Verdict {
    let (mut p, mut s) = (provider.to_string(), session_id.to_string());
    for _ in 0..10 {
        match by_key.get(&ref_key(&p, &s)) {
            None => return if (p.as_str(), s.as_str()) == (provider, session_id) { Verdict::Unknown } else { Verdict::GcExpired },
            Some(row) if row_is_bound(row) => return Verdict::Bound(row_provider(row), row_session_id(row)),
            Some(row) => match row_successor(row) {
                Some((np, ns)) => { p = np; s = ns; }
                None => return if row_reason_is_closed(row) { Verdict::Closed } else { Verdict::GcExpired },
            },
        }
    }
    Verdict::GcExpired
}

pub fn build_inventory(device_unions: Vec<DeviceUnion>, bindings: Vec<BindingRow>) -> Value {
    let by_key: HashMap<String, &BindingRow> = bindings.iter()
        .map(|r| (ref_key(&row_provider(r), &row_session_id(r)), r)).collect();

    // contentId over ALL inputs (stable, order-independent)
    let mut ids: Vec<String> = device_unions.iter()
        .map(|d| format!("{}:{}", d.device_id, d.union_doc["capturedAt"])).collect();
    ids.extend(bindings.iter().filter(|r| row_is_bound(r))
        .map(|r| format!("{}:{}:{}", row_provider(r), row_session_id(r), row_updated_at(r))));
    ids.sort();
    let mut h = DefaultHasher::new();
    ids.hash(&mut h);
    let content_id = format!("{:016x}", h.finish());

    // pick primary device: greatest capturedAt with >=1 record
    let mut unions = device_unions;
    unions.sort_by_key(|d| std::cmp::Reverse(d.union_doc["capturedAt"].as_u64().unwrap_or(0)));
    let primary_idx = unions.iter().position(|d|
        d.union_doc["records"].as_array().map(|r| !r.is_empty()).unwrap_or(false));

    let mut referenced: Vec<String> = vec![];
    let device = primary_idx.map(|i| {
        let doc = &unions[i].union_doc;
        let tabs: Vec<Value> = doc["records"].as_array().unwrap().iter().map(|rec| {
            let panes: Vec<Value> = rec["panes"].as_array().cloned().unwrap_or_default().iter().map(|pane| {
                let payload = &pane["payload"];
                let snap_ref = payload.get("sessionRef").filter(|v| !v.is_null()).cloned();
                let (ledger_state, eff_ref) = match &snap_ref {
                    None => ("unknown", None),
                    Some(r) => {
                        let (p, s) = (r["provider"].as_str().unwrap_or(""), r["sessionId"].as_str().unwrap_or(""));
                        match resolve(p, s, &by_key) {
                            Verdict::Bound(bp, bs) => ("bound", Some(json!({"provider": bp, "sessionId": bs}))),
                            Verdict::Closed => ("closed", None),
                            Verdict::GcExpired => ("gc_expired", Some(r.clone())),
                            Verdict::Unknown => ("unknown", Some(r.clone())),
                        }
                    }
                };
                if let Some(er) = &eff_ref {
                    referenced.push(ref_key(er["provider"].as_str().unwrap_or(""), er["sessionId"].as_str().unwrap_or("")));
                }
                json!({
                    "paneId": pane["paneId"], "kind": pane["kind"],
                    "mode": payload.get("mode").cloned().unwrap_or(Value::Null),
                    "shell": payload.get("shell").cloned().unwrap_or(Value::Null),
                    "cwd": payload.get("initialCwd").cloned().unwrap_or(Value::Null),
                    "payload": payload.clone(),
                    "sessionRef": eff_ref.unwrap_or(Value::Null),
                    "ledgerState": ledger_state,
                })
            }).collect();
            json!({"tabKey": rec["tabKey"], "tabName": rec["tabName"], "panes": panes})
        }).collect();
        json!({"deviceId": doc["deviceId"], "deviceLabel": doc["deviceLabel"],
               "capturedAt": doc["capturedAt"], "tabs": tabs})
    });

    let other_devices: Vec<Value> = unions.iter().enumerate()
        .filter(|(i, _)| Some(*i) != primary_idx)
        .filter(|(_, d)| d.union_doc["records"].as_array().map(|r| !r.is_empty()).unwrap_or(false))
        .map(|(_, d)| {
            let pane_count: u64 = d.union_doc["records"].as_array().unwrap().iter()
                .map(|r| r["panes"].as_array().map(|p| p.len() as u64).unwrap_or(0)).sum();
            json!({"deviceId": d.union_doc["deviceId"], "deviceLabel": d.union_doc["deviceLabel"],
                   "capturedAt": d.union_doc["capturedAt"], "paneCount": pane_count})
        }).collect();

    let ledger_only: Vec<Value> = bindings.iter()
        .filter(|r| row_is_bound(r))
        .filter(|r| !referenced.contains(&ref_key(&row_provider(r), &row_session_id(r))))
        .map(|r| json!({"provider": row_provider(r), "sessionId": row_session_id(r),
                        "mode": row_mode(r), "cwd": row_cwd(r)}))
        .collect();

    let recoverable = device.is_some() || !ledger_only.is_empty();
    json!({"recoverable": recoverable, "contentId": content_id,
           "device": device.unwrap_or(Value::Null),
           "otherDevices": other_devices, "ledgerOnly": ledger_only})
}
```

The `row_*` accessor helpers (`row_provider`, `row_session_id`, `row_is_bound`, `row_reason_is_closed`, `row_successor`, `row_mode`, `row_cwd`, `row_updated_at`) are thin one-line wrappers over the actual `BindingRow` fields/enums — write them against the real definitions in `pane_ledger.rs:93` (they exist so this module compiles against whatever the exact enum spellings are; each is a single field access, not logic).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-server recovery_inventory`
Expected: PASS (all 6 tests).

- [ ] **Step 5: Format, lint, commit**

```bash
cargo fmt --all && cargo clippy -p freshell-server --all-targets -- -D warnings
git add crates/freshell-server/src/recovery_inventory.rs crates/freshell-server/src/recovery_inventory_tests.rs crates/freshell-server/src/main.rs
git commit -m "feat(server): pure recovery-inventory builder joining snapshots with pane-ledger (B3/P1.9)"
```

---

### Task 2: Server — `GET /api/recovery/inventory` route

**Files:**
- Modify: `crates/freshell-server/src/recovery_inventory.rs` (add state/router/handler)
- Modify: `crates/freshell-server/src/recovery_inventory_tests.rs` (add route tests)
- Modify: `crates/freshell-server/src/main.rs` (one `.merge(...)` in the router assembly at ~`main.rs:759+`)

**Interfaces:**
- Consumes: `freshell_ws::tabs_persist::{list_snapshot_devices, read_device_overview, read_generations_union_by_ids}` (sync `io::Result`, must run in `spawn_blocking`); `freshell_ws::pane_ledger::PaneLedger::list_bindings()` (sync, memory-only, callable directly); the per-handler auth helper used by `tabs_snapshots.rs` handlers (`is_authed(&headers, &state.auth_token)` — copy the exact import from that file); `build_inventory` from Task 1.
- Produces: `pub struct RecoveryInventoryState { pub auth_token: String, pub snapshots_dir: Option<std::path::PathBuf>, pub ledger: std::sync::Arc<freshell_ws::pane_ledger::PaneLedger> }` (`#[derive(Clone)]`) and `pub fn router(state: RecoveryInventoryState) -> axum::Router`. Route: `GET /api/recovery/inventory?clientInstanceId=<id>`.

Handler behavior: 401 without valid token (same check as every other handler); with `snapshots_dir: None` or missing dir → inventory built from ledger only; snapshot reads: `spawn_blocking` over `(dir, exclude_client)` doing — `list_snapshot_devices(&dir)` → for each device `read_device_overview(&dir, &device)` → from the overview's generation list select generation ids whose `clientInstanceId` != `exclude_client` → `read_generations_union_by_ids(&dir, &device, &ids)` → collect `DeviceUnion`. Devices with zero foreign generations are skipped. IO errors and `JoinError` → 500 + `tracing::error!` (fail-loud, three-arm match, same shape as the dryRun path at `tabs_snapshots.rs:330`). Then `build_inventory(unions, state.ledger.list_bindings())` → `Json(...)`.

- [ ] **Step 1: Write the failing route tests**

Append to `recovery_inventory_tests.rs` (reuse the `oneshot` helper pattern from `tabs_snapshots_tests.rs:79` — a `async fn get(router, uri, auth) -> (StatusCode, Value)` helper using `tower::ServiceExt::oneshot`). Snapshot fixture files are written directly with the store's real layout — `<dir>/<device>/<client>-<capturedAt:020>-r<rev:012>.json` (alphanumeric device/client ids need no escaping):

```rust
fn write_snapshot(dir: &std::path::Path, device: &str, client: &str, captured_at: u64, rev: u64, records: serde_json::Value) {
    let doc = json!({
        "deviceId": device, "deviceLabel": format!("label-{device}"), "clientInstanceId": client,
        "serverInstanceId": "srv-test", "snapshotRevision": rev, "capturedAt": captured_at,
        "records": records
    });
    let d = dir.join(device);
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(d.join(format!("{client}-{captured_at:020}-r{rev:012}.json")),
                   serde_json::to_vec(&doc).unwrap()).unwrap();
}

fn test_state(dir: Option<std::path::PathBuf>, ledger_root: Option<std::path::PathBuf>) -> RecoveryInventoryState {
    RecoveryInventoryState {
        auth_token: "tok".into(),
        snapshots_dir: dir,
        ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::new_locked(ledger_root)),
    }
}

#[tokio::test]
async fn route_requires_auth_and_serves_inventory() {
    let tmp = tempfile::tempdir().unwrap();
    write_snapshot(tmp.path(), "dev1", "clientA", 1000, 1, json!([
        {"tabKey":"k1","tabId":"t1","tabName":"work","status":"open","revision":1,"updatedAt":1000,
         "paneCount":1,"panes":[{"paneId":"p1","kind":"terminal","payload":{"mode":"shell","initialCwd":"/w"}}]}
    ]));
    let router = router(test_state(Some(tmp.path().to_path_buf()), None));
    // house convention: 401 case asserted alongside the happy path
    let (code, _) = get(router.clone(), "/api/recovery/inventory?clientInstanceId=me", None).await;
    assert_eq!(code, axum::http::StatusCode::UNAUTHORIZED);
    let (code, body) = get(router, "/api/recovery/inventory?clientInstanceId=me", Some("tok")).await;
    assert_eq!(code, axum::http::StatusCode::OK);
    assert_eq!(body["recoverable"], true);
    assert_eq!(body["device"]["deviceId"], "dev1");
    assert_eq!(body["device"]["tabs"][0]["panes"][0]["cwd"], "/w");
}

#[tokio::test]
async fn route_excludes_requesting_clients_own_generations() {
    let tmp = tempfile::tempdir().unwrap();
    write_snapshot(tmp.path(), "dev1", "oldclient", 1000, 1, json!([
        {"tabKey":"k1","tabId":"t1","tabName":"work","status":"open","revision":1,"updatedAt":1000,
         "paneCount":1,"panes":[{"paneId":"p1","kind":"terminal","payload":{"mode":"shell"}}]}
    ]));
    write_snapshot(tmp.path(), "dev1", "me", 2000, 1, json!([
        {"tabKey":"junk","tabId":"tj","tabName":"junk","status":"open","revision":1,"updatedAt":2000,
         "paneCount":1,"panes":[{"paneId":"pj","kind":"terminal","payload":{"mode":"shell"}}]}
    ]));
    let router = router(test_state(Some(tmp.path().to_path_buf()), None));
    let (_, body) = get(router, "/api/recovery/inventory?clientInstanceId=me", Some("tok")).await;
    let tabs = body["device"]["tabs"].as_array().unwrap();
    assert!(tabs.iter().all(|t| t["tabKey"] != "junk"), "requester's own push must be filtered out");
    assert!(tabs.iter().any(|t| t["tabKey"] == "k1"));
}

#[tokio::test]
async fn route_serves_ledger_only_recovery_without_snapshots() {
    // Seed a binding file the ledger boot-scan will load (BindingRow camelCase JSON).
    let home = tempfile::tempdir().unwrap();
    let broot = home.path().join("pane-ledger");
    std::fs::create_dir_all(broot.join("bindings").join("claude")).unwrap();
    std::fs::write(broot.join("bindings").join("claude").join("S1.json"), serde_json::to_vec(&json!({
        "ledgerVersion": 1, "provider": "claude", "sessionId": "S1", "mode": "claude",
        "cwd": "/w", "createdAt": 1, "updatedAt": 1, "lastObservedAt": 1, "state": "bound"
    })).unwrap()).unwrap();
    let router = router(test_state(None, Some(broot)));
    let (_, body) = get(router, "/api/recovery/inventory?clientInstanceId=me", Some("tok")).await;
    assert_eq!(body["recoverable"], true);
    assert_eq!(body["ledgerOnly"][0]["sessionId"], "S1");
}
```

(If the on-disk binding filename/JSON differs, copy the exact shape from `pane_ledger_tests.rs` fixtures — the test contract stands: a pre-seeded bound row surfaces in `ledgerOnly`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-server recovery_inventory`
Expected: FAIL to compile on missing `router`/`RecoveryInventoryState` — add compiling stubs (handler returns 500) — then FAIL on assertions.

- [ ] **Step 3: Implement state, router, handler**

```rust
use axum::{extract::{Query, State}, http::HeaderMap, response::{IntoResponse, Response}, routing::get, Json, Router};

#[derive(Clone)]
pub struct RecoveryInventoryState {
    pub auth_token: String,
    pub snapshots_dir: Option<std::path::PathBuf>,
    pub ledger: std::sync::Arc<freshell_ws::pane_ledger::PaneLedger>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct InventoryQuery { client_instance_id: Option<String> }

pub fn router(state: RecoveryInventoryState) -> Router {
    Router::new().route("/api/recovery/inventory", get(inventory_handler)).with_state(state)
}

async fn inventory_handler(State(state): State<RecoveryInventoryState>, headers: HeaderMap, Query(q): Query<InventoryQuery>) -> Response {
    if !is_authed(&headers, &state.auth_token) { return unauthorized(); } // same helper as tabs_snapshots.rs
    let exclude = q.client_instance_id.unwrap_or_default();
    let unions = match state.snapshots_dir.clone() {
        None => vec![],
        Some(dir) => {
            let job = tokio::task::spawn_blocking(move || read_foreign_unions(&dir, &exclude));
            match job.await {
                Ok(Ok(u)) => u,
                Ok(Err(e)) => { tracing::error!(error = %e, "recovery inventory snapshot read failed"); return internal_error(); }
                Err(e) => { tracing::error!(error = %e, "recovery inventory join failed"); return internal_error(); }
            }
        }
    };
    Json(build_inventory(unions, state.ledger.list_bindings())).into_response()
}

fn read_foreign_unions(dir: &std::path::Path, exclude_client: &str) -> std::io::Result<Vec<DeviceUnion>> {
    use freshell_ws::tabs_persist::{list_snapshot_devices, read_device_overview, read_generations_union_by_ids};
    let mut out = vec![];
    if !dir.is_dir() { return Ok(out); }
    for device in list_snapshot_devices(dir)? {
        let Some((_, generations)) = read_device_overview(dir, &device)? else { continue };
        let foreign: Vec<String> = generations.iter()
            .filter(|g| g["clientInstanceId"].as_str() != Some(exclude_client))
            .filter_map(|g| g["generationId"].as_str().map(String::from))
            .collect();
        if foreign.is_empty() { continue; }
        match read_generations_union_by_ids(dir, &device, &foreign) {
            Ok(union) => out.push(DeviceUnion { device_id: device, union_doc: union_value(union) }),
            Err(e) => return Err(e),
        }
    }
    Ok(out)
}
```

Notes for the implementer: `unauthorized()`/`internal_error()`/`is_authed` — import or replicate exactly what `tabs_snapshots.rs` handlers use (auth check is the first statement, constant-time compare, `x-auth-token` header then cookie). `read_generations_union_by_ids` returns a `ComponentsUnion` — `union_value(...)` is whatever accessor yields the union `Value` (see how the restore endpoint consumes it); if `Missing` is a variant, treat as skip-device. If the overview generation entries name the id field differently (e.g. `id`), match the actual field — the Step 1 tests, driven by real files, are the arbiter.

Wire in `main.rs` next to the existing `tabs_snapshots` merge (~`:783-795`):

```rust
.merge(recovery_inventory::router(recovery_inventory::RecoveryInventoryState {
    auth_token: auth_token.clone(),
    snapshots_dir: tabs_snapshots_dir.clone(),          // same value the tabs_snapshots state receives
    ledger: std::sync::Arc::clone(&pane_ledger),        // created at main.rs:426
}))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-server recovery_inventory`
Expected: PASS (all route + builder tests).

- [ ] **Step 5: Full crate check, commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings && cargo test -p freshell-server
git add -A crates/freshell-server/src
git commit -m "feat(server): GET /api/recovery/inventory - device-scoped recoverable-state read API (B3/P1.9)"
```

---

### Task 3: Client — boot eligibility + dismissal persistence

**Files:**
- Create: `src/lib/recovery/boot-state.ts`
- Create: `src/lib/recovery/dismissal.ts`
- Create: `test/unit/client/lib/recovery/boot-state.test.ts`
- Create: `test/unit/client/lib/recovery/dismissal.test.ts`

**Interfaces:**
- Consumes: `window.localStorage` (jsdom provides it in tests; clear it yourself — `console.error` throws in `afterEach`).
- Produces:
  - `boot-state.ts`: `export function computeHadPersistedLayout(storage: Pick<Storage, 'getItem'>): boolean` and `export const hadPersistedLayoutAtBoot: boolean` (evaluated at module import).
  - `dismissal.ts`: `export function isDismissed(contentId: string): boolean`, `export function recordDismissal(contentId: string): void` (cap 20, newest kept), `export function getPendingOffer(): string | null`, `export function setPendingOffer(contentId: string): void`, `export function clearPendingOffer(): void`.

- [ ] **Step 1: Write the failing tests**

`test/unit/client/lib/recovery/boot-state.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { computeHadPersistedLayout } from '@/lib/recovery/boot-state'

const store = (entries: Record<string, string>) => ({ getItem: (k: string) => entries[k] ?? null })

describe('computeHadPersistedLayout', () => {
  beforeEach(() => localStorage.clear())

  it('empty-never: no layout keys at all -> false (offer-eligible)', () => {
    expect(computeHadPersistedLayout(store({}))).toBe(false)
  })

  it('empty-cleared: only unrelated keys survive a clear -> false (offer-eligible)', () => {
    expect(computeHadPersistedLayout(store({ 'freshell.device-id.v2': 'dev' }))).toBe(false)
  })

  it('populated: layout key present -> true (no offer)', () => {
    expect(computeHadPersistedLayout(store({ 'freshell.layout.v3': '{"tabs":[{"id":"t1"}]}' }))).toBe(true)
  })

  it('deliberately emptied: layout key present with zero tabs -> true (no offer)', () => {
    expect(computeHadPersistedLayout(store({ 'freshell.layout.v3': '{"tabs":[]}' }))).toBe(true)
  })

  it('backup key alone counts as persisted layout', () => {
    expect(computeHadPersistedLayout(store({ 'freshell.layout.v3.bak': '{}' }))).toBe(true)
  })
})

describe('hadPersistedLayoutAtBoot capture', () => {
  it('is captured at module import time, before later writes', async () => {
    localStorage.clear()
    const { hadPersistedLayoutAtBoot } = await import('@/lib/recovery/boot-state?fresh=' + Date.now())
    localStorage.setItem('freshell.layout.v3', '{"tabs":[{"id":"auto"}]}') // simulates auto-tab persist
    expect(hadPersistedLayoutAtBoot).toBe(false)
  })
})
```

`test/unit/client/lib/recovery/dismissal.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { isDismissed, recordDismissal, getPendingOffer, setPendingOffer, clearPendingOffer } from '@/lib/recovery/dismissal'

describe('recovery dismissal persistence', () => {
  beforeEach(() => localStorage.clear())

  it('unknown contentId is not dismissed', () => expect(isDismissed('abc')).toBe(false))

  it('recordDismissal persists across module state (localStorage-backed)', () => {
    recordDismissal('abc')
    expect(isDismissed('abc')).toBe(true)
    expect(isDismissed('xyz')).toBe(false)
  })

  it('caps at 20, evicting oldest', () => {
    for (let i = 0; i < 21; i++) recordDismissal(`id-${i}`)
    expect(isDismissed('id-0')).toBe(false)
    expect(isDismissed('id-20')).toBe(true)
  })

  it('tolerates corrupt stored JSON', () => {
    localStorage.setItem('freshell.recovery.dismissed.v1', '{not json')
    expect(isDismissed('abc')).toBe(false)
    recordDismissal('abc')
    expect(isDismissed('abc')).toBe(true)
  })

  it('pending offer round-trips and clears', () => {
    expect(getPendingOffer()).toBeNull()
    setPendingOffer('abc')
    expect(getPendingOffer()).toBe('abc')
    clearPendingOffer()
    expect(getPendingOffer()).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- run test/unit/client/lib/recovery/`
Expected: FAIL — modules don't exist ("Failed to resolve import").

- [ ] **Step 3: Implement both modules**

`src/lib/recovery/boot-state.ts`:

```ts
const LAYOUT_KEY = 'freshell.layout.v3'
const LAYOUT_BAK_KEY = 'freshell.layout.v3.bak'

export function computeHadPersistedLayout(storage: Pick<Storage, 'getItem'>): boolean {
  return storage.getItem(LAYOUT_KEY) !== null || storage.getItem(LAYOUT_BAK_KEY) !== null
}

// Captured at module import — before the auto-created shell tab and the 500ms
// persist debounce can write a layout key (see docs/plans/2026-07-26-recover-my-panes.md D1).
export const hadPersistedLayoutAtBoot: boolean =
  typeof window !== 'undefined' && computeHadPersistedLayout(window.localStorage)
```

`src/lib/recovery/dismissal.ts` (same pattern as `src/lib/setup-wizard-dismissal.ts`):

```ts
const DISMISSED_KEY = 'freshell.recovery.dismissed.v1'
const PENDING_KEY = 'freshell.recovery.pending.v1'
const CAP = 20

function readDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function isDismissed(contentId: string): boolean {
  return readDismissed().includes(contentId)
}

export function recordDismissal(contentId: string): void {
  const next = [...readDismissed().filter((id) => id !== contentId), contentId].slice(-CAP)
  localStorage.setItem(DISMISSED_KEY, JSON.stringify(next))
}

export function getPendingOffer(): string | null {
  return localStorage.getItem(PENDING_KEY)
}

export function setPendingOffer(contentId: string): void {
  localStorage.setItem(PENDING_KEY, contentId)
}

export function clearPendingOffer(): void {
  localStorage.removeItem(PENDING_KEY)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/lib/recovery/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/recovery/boot-state.ts src/lib/recovery/dismissal.ts test/unit/client/lib/recovery/
git commit -m "feat(client): recovery trigger eligibility (boot-captured) and dismissal persistence (B3/P1.9)"
```

---

### Task 4: Client — inventory types, API helper, recovery-plan builder (authority chain)

**Files:**
- Create: `src/lib/recovery/types.ts`
- Create: `src/lib/recovery/build-recovery-plan.ts`
- Modify: `src/lib/api.ts` (add `getRecoveryInventory` next to `getBootstrap` at `api.ts:287-289`)
- Create: `test/unit/client/lib/recovery/build-recovery-plan.test.ts`

**Interfaces:**
- Consumes: `PaneNode` / `TerminalPaneContent` from `@/store/paneTypes` (`PaneNode = leaf{id, content} | split{id, direction, children:[PaneNode,PaneNode], sizes:[number,number]}`, `paneTypes.ts:274-276`; terminal content fields incl. `initialCwd`, `sessionRef: {provider, sessionId}`, non-optional `createRequestId`/`status`); `nanoid`; `api.get` + `buildQueryString` (`api.ts:276-285`).
- Produces:
  - `types.ts`: `RecoveryInventory`, `RecoveryPane` (`{paneId, kind, mode: string|null, shell: string|null, cwd: string|null, payload: Record<string, unknown>, sessionRef: {provider, sessionId}|null, ledgerState: 'bound'|'closed'|'gc_expired'|'unknown'}`), `RecoveryTab`, `LedgerOnlyEntry` — mirroring Task 1's response shape.
  - `api.ts`: `export async function getRecoveryInventory(clientInstanceId: string): Promise<RecoveryInventory>` → `api.get<RecoveryInventory>('/api/recovery/inventory' + buildQueryString({ clientInstanceId }))`.
  - `build-recovery-plan.ts`:

```ts
export interface RecoveryTabPlan { tabId: string; title: string; layout: PaneNode; paneTitles: Record<string, string> }
export function countRecoverablePanes(inv: RecoveryInventory): number
export function buildRecoveryPlan(inv: RecoveryInventory): RecoveryTabPlan[]
```

Rules: one `RecoveryTabPlan` per inventory tab (tabId = `nanoid()`); pane list → right-leaning binary split chain (`direction: 'horizontal'`, `sizes: [50, 50]`); terminal leaf content `{kind:'terminal', createRequestId: nanoid(), status: 'creating', mode, shell, initialCwd: cwd, sessionRef: sessionRef ?? undefined}` (fields with `null` inventory values omitted; `restoreLayout` re-mints ids/status — that's expected); non-terminal leaf content = `{...payload, kind}` passthrough (the `reopenClosedTab` restore path normalizes it); `ledgerOnly` entries, if any, become one extra final tab titled `Recovered sessions` whose panes are terminal content with `mode: entry.mode`, `initialCwd: entry.cwd ?? undefined`, `sessionRef: {provider, sessionId}`. `countRecoverablePanes` = device panes + ledgerOnly length.

- [ ] **Step 1: Write the failing tests**

`test/unit/client/lib/recovery/build-recovery-plan.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { buildRecoveryPlan, countRecoverablePanes } from '@/lib/recovery/build-recovery-plan'
import type { RecoveryInventory } from '@/lib/recovery/types'

vi.mock('nanoid', () => { let n = 0; return { nanoid: () => `nid-${++n}` } })

const pane = (over: Partial<RecoveryInventory['device']['tabs'][0]['panes'][0]> = {}) => ({
  paneId: 'p1', kind: 'terminal', mode: 'shell', shell: null, cwd: '/w',
  payload: {}, sessionRef: null, ledgerState: 'unknown' as const, ...over,
})
const inv = (panes: unknown[], ledgerOnly: unknown[] = []): RecoveryInventory => ({
  recoverable: true, contentId: 'cid',
  device: { deviceId: 'd', deviceLabel: 'l', capturedAt: 1, tabs: [{ tabKey: 'k', tabName: 'work', panes }] },
  otherDevices: [], ledgerOnly,
} as RecoveryInventory)

describe('buildRecoveryPlan', () => {
  it('single terminal pane -> one tab, leaf layout, cwd + mode carried', () => {
    const [tab] = buildRecoveryPlan(inv([pane()]))
    expect(tab.title).toBe('work')
    expect(tab.layout.type).toBe('leaf')
    const content = (tab.layout as { content: Record<string, unknown> }).content
    expect(content).toMatchObject({ kind: 'terminal', mode: 'shell', initialCwd: '/w' })
    expect(content.sessionRef).toBeUndefined()
  })

  it('ledger-corrected sessionRef is used verbatim (authority chain applied server-side)', () => {
    const [tab] = buildRecoveryPlan(inv([pane({ sessionRef: { provider: 'claude', sessionId: 'S2' }, ledgerState: 'bound', mode: 'claude' })]))
    const content = (tab.layout as { content: Record<string, unknown> }).content
    expect(content.sessionRef).toEqual({ provider: 'claude', sessionId: 'S2' })
  })

  it('closed panes come back fresh: no sessionRef, same cwd/mode', () => {
    const [tab] = buildRecoveryPlan(inv([pane({ ledgerState: 'closed', mode: 'claude' })]))
    const content = (tab.layout as { content: Record<string, unknown> }).content
    expect(content.sessionRef).toBeUndefined()
    expect(content).toMatchObject({ mode: 'claude', initialCwd: '/w' })
  })

  it('three panes -> right-leaning binary split chain', () => {
    const [tab] = buildRecoveryPlan(inv([pane({ paneId: 'a' }), pane({ paneId: 'b' }), pane({ paneId: 'c' })]))
    expect(tab.layout.type).toBe('split')
    const root = tab.layout as { children: [{ type: string }, { type: string }] }
    expect(root.children[0].type).toBe('leaf')
    expect(root.children[1].type).toBe('split')
  })

  it('non-terminal kinds pass payload through', () => {
    const [tab] = buildRecoveryPlan(inv([pane({ kind: 'browser', payload: { url: 'https://x.test' }, mode: null, cwd: null })]))
    const content = (tab.layout as { content: Record<string, unknown> }).content
    expect(content).toMatchObject({ kind: 'browser', url: 'https://x.test' })
  })

  it('ledgerOnly entries get a trailing Recovered sessions tab', () => {
    const plans = buildRecoveryPlan(inv([pane()], [{ provider: 'codex', sessionId: 'C9', mode: 'codex', cwd: '/x' }]))
    expect(plans).toHaveLength(2)
    expect(plans[1].title).toBe('Recovered sessions')
    const content = (plans[1].layout as { content: Record<string, unknown> }).content
    expect(content).toMatchObject({ kind: 'terminal', mode: 'codex', initialCwd: '/x', sessionRef: { provider: 'codex', sessionId: 'C9' } })
  })

  it('countRecoverablePanes sums device panes and ledgerOnly', () => {
    expect(countRecoverablePanes(inv([pane(), pane({ paneId: 'p2' })], [{ provider: 'codex', sessionId: 'C9', mode: 'codex', cwd: null }]))).toBe(3)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- run test/unit/client/lib/recovery/build-recovery-plan.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement types + builder + api helper**

`src/lib/recovery/types.ts` per the Interfaces block above. `src/lib/recovery/build-recovery-plan.ts`:

```ts
import { nanoid } from 'nanoid'
import type { PaneNode, PaneContent } from '@/store/paneTypes'
import type { RecoveryInventory, RecoveryPane, LedgerOnlyEntry } from './types'

function terminalContent(p: { mode: string | null; shell: string | null; cwd: string | null; sessionRef: { provider: string; sessionId: string } | null }): PaneContent {
  return {
    kind: 'terminal',
    createRequestId: nanoid(), // re-minted by restoreLayout normalization; required by the type
    status: 'creating',
    ...(p.mode ? { mode: p.mode } : {}),
    ...(p.shell ? { shell: p.shell } : {}),
    ...(p.cwd ? { initialCwd: p.cwd } : {}),
    ...(p.sessionRef ? { sessionRef: p.sessionRef } : {}),
  } as PaneContent
}

function paneContent(p: RecoveryPane): PaneContent {
  if (p.kind === 'terminal') return terminalContent(p)
  return { ...p.payload, kind: p.kind } as PaneContent
}

function leaf(content: PaneContent): PaneNode {
  return { type: 'leaf', id: nanoid(), content } as PaneNode
}

function chain(leaves: PaneNode[]): PaneNode {
  if (leaves.length === 1) return leaves[0]
  const [head, ...rest] = leaves
  return { type: 'split', id: nanoid(), direction: 'horizontal', children: [head, chain(rest)], sizes: [50, 50] } as PaneNode
}

export interface RecoveryTabPlan { tabId: string; title: string; layout: PaneNode; paneTitles: Record<string, string> }

export function countRecoverablePanes(inv: RecoveryInventory): number {
  const device = inv.device?.tabs.reduce((n, t) => n + t.panes.length, 0) ?? 0
  return device + inv.ledgerOnly.length
}

export function buildRecoveryPlan(inv: RecoveryInventory): RecoveryTabPlan[] {
  const plans: RecoveryTabPlan[] = (inv.device?.tabs ?? [])
    .filter((t) => t.panes.length > 0)
    .map((t) => ({ tabId: nanoid(), title: t.tabName || 'Recovered', layout: chain(t.panes.map((p) => leaf(paneContent(p)))), paneTitles: {} }))
  if (inv.ledgerOnly.length > 0) {
    plans.push({
      tabId: nanoid(),
      title: 'Recovered sessions',
      layout: chain(inv.ledgerOnly.map((e: LedgerOnlyEntry) =>
        leaf(terminalContent({ mode: e.mode, shell: null, cwd: e.cwd, sessionRef: { provider: e.provider, sessionId: e.sessionId } })))),
      paneTitles: {},
    })
  }
  return plans
}
```

In `src/lib/api.ts`, next to `getBootstrap`:

```ts
export async function getRecoveryInventory(clientInstanceId: string): Promise<RecoveryInventory> {
  return api.get<RecoveryInventory>(`/api/recovery/inventory${buildQueryString({ clientInstanceId })}`)
}
```

(Import the type; match `getBootstrap`'s exact call style including any options argument.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/lib/recovery/`
Expected: PASS. Also run `npx tsc --noEmit -p tsconfig.json` if a typecheck script isn't already part of `npm run check`; fix type mismatches against the real `paneTypes.ts` definitions (the casts above are the seam — prefer removing casts by matching the real types).

- [ ] **Step 5: Commit**

```bash
git add src/lib/recovery/ src/lib/api.ts test/unit/client/lib/recovery/build-recovery-plan.test.ts
git commit -m "feat(client): recovery inventory types, API helper, and recovery-plan builder honoring the ledger authority chain (B3/P1.9)"
```

---

### Task 5: Client — RecoveryOfferPanel component (fetch, offer, accept, decline)

**Files:**
- Create: `src/components/RecoveryOfferPanel.tsx`
- Modify: `src/store/tabRegistrySync.ts` (export the existing module-private clientInstanceId getter — a 2-line visibility change, e.g. `export function getClientInstanceId(): string` wrapping what the push envelope already uses; do not change its behavior)
- Create: `test/unit/client/components/RecoveryOfferPanel.test.tsx`

**Interfaces:**
- Consumes: `hadPersistedLayoutAtBoot`, dismissal module (Task 3), `getRecoveryInventory` (Task 4), `buildRecoveryPlan`/`countRecoverablePanes` (Task 4), `addTab` (`tabsSlice.ts:274-290` — payload accepts `id`; `activeTabId` set unconditionally), `restoreLayout` (`panesSlice.ts:910-926` — no-ops if the tab already has a layout), `addTerminalRestoreRequestId` (`src/lib/terminal-restore.ts`), `getClientInstanceId`.
- Produces: `export function RecoveryOfferPanel(): JSX.Element | null` — fully self-gating (no props), rendered unconditionally from App. Also `export function armRecoveredTerminalRestores(state: RootState, tabIds: string[]): void` — walks each tab's post-normalization layout in `state.panes`, and for every terminal leaf whose content has a `sessionRef`, calls `addTerminalRestoreRequestId(content.createRequestId)`.

Behavior:
1. On mount: if `(hadPersistedLayoutAtBoot && !getPendingOffer())` → render null forever. Otherwise fetch `getRecoveryInventory(getClientInstanceId())` once; on error or `recoverable: false` or `isDismissed(contentId)` → render null; else `setPendingOffer(contentId)` and show the panel.
2. Panel (modal-style, reuse the portal/overlay/focus pattern of `src/components/ui/confirm-modal.tsx`): heading `Restore N panes from server memory?` (N = `countRecoverablePanes`), a list of recoverable items — for device panes: `{tabName}: {mode ?? kind}` plus cwd when present; for ledgerOnly: `{mode} session — {cwd ?? 'unknown directory'}`; buttons `Restore` and `Not now`.
3. Accept: `clearPendingOffer()`; for each `RecoveryTabPlan`: `dispatch(addTab({ id: plan.tabId, title: plan.title }))`, `dispatch(restoreLayout({ tabId: plan.tabId, layout: plan.layout, paneTitles: plan.paneTitles }))`; then `armRecoveredTerminalRestores(store.getState(), planTabIds)`; hide panel.
4. Decline: `recordDismissal(contentId)`; `clearPendingOffer()`; hide panel. No further renders this or future visits for this contentId.
5. A11y: dialog has `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing at the heading id; list is a `<ul>`; both buttons are real `<button>` elements with visible text. `data-testid="recovery-offer-panel"`, `data-testid="recovery-accept"`, `data-testid="recovery-decline"` for e2e.

- [ ] **Step 1: Write the failing tests**

`test/unit/client/components/RecoveryOfferPanel.test.tsx` — per-test `configureStore` with the real `tabs` + `panes` reducers (import the same reducer wiring an existing store test uses); mock the api module:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getRecoveryInventory: vi.fn(),
}))
vi.mock('@/lib/recovery/boot-state', () => ({
  computeHadPersistedLayout: () => false,
  hadPersistedLayoutAtBoot: false, // simulate empty boot; per-test override via vi.mocked where needed
}))
vi.mock('@/store/tabRegistrySync', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getClientInstanceId: () => 'client-me',
}))

import { getRecoveryInventory } from '@/lib/api'
import { RecoveryOfferPanel } from '@/components/RecoveryOfferPanel'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'

// Local helper, defined in THIS test file (match default-export names to the real slice files):
function makeTestStore() {
  return configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } })
}

const INVENTORY = {
  recoverable: true, contentId: 'cid-1',
  device: { deviceId: 'd', deviceLabel: 'l', capturedAt: 1, tabs: [{ tabKey: 'k', tabName: 'work', panes: [
    { paneId: 'p1', kind: 'terminal', mode: 'claude', shell: null, cwd: '/w', payload: {},
      sessionRef: { provider: 'claude', sessionId: 'S2' }, ledgerState: 'bound' },
  ] }] },
  otherDevices: [], ledgerOnly: [],
}

describe('RecoveryOfferPanel', () => {
  beforeEach(() => { localStorage.clear(); vi.mocked(getRecoveryInventory).mockReset() })

  it('offers when eligible and inventory is recoverable', async () => {
    vi.mocked(getRecoveryInventory).mockResolvedValue(INVENTORY)
    render(<Provider store={makeTestStore()}><RecoveryOfferPanel /></Provider>)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText(/restore 1 pane/i)).toBeInTheDocument()
    expect(screen.getByText(/work/)).toBeInTheDocument()
  })

  it('accept creates the tabs and hides the panel', async () => {
    vi.mocked(getRecoveryInventory).mockResolvedValue(INVENTORY)
    const store = makeTestStore()
    render(<Provider store={store}><RecoveryOfferPanel /></Provider>)
    await userEvent.click(await screen.findByTestId('recovery-accept'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // Recreated pane carries the ledger-corrected ref (adjust access to the real slice shapes):
    expect(JSON.stringify(store.getState().tabs)).toContain('"work"')
    expect(JSON.stringify(store.getState().panes)).toContain('"S2"')
  })

  it('decline hides, records dismissal, and a remount stays quiet', async () => {
    vi.mocked(getRecoveryInventory).mockResolvedValue(INVENTORY)
    const store = makeTestStore()
    const first = render(<Provider store={store}><RecoveryOfferPanel /></Provider>)
    await userEvent.click(await screen.findByTestId('recovery-decline'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    first.unmount()
    render(<Provider store={makeTestStore()}><RecoveryOfferPanel /></Provider>)
    await waitFor(() => expect(vi.mocked(getRecoveryInventory)).toHaveBeenCalled())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('renders nothing when inventory is not recoverable', async () => {
    vi.mocked(getRecoveryInventory).mockResolvedValue({ ...INVENTORY, recoverable: false, device: null })
    render(<Provider store={makeTestStore()}><RecoveryOfferPanel /></Provider>)
    await waitFor(() => expect(vi.mocked(getRecoveryInventory)).toHaveBeenCalled())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
```

Adjust the state-shape assertions in the accept test to the real `tabs`/`panes` slice shapes (assert: at least one new tab exists whose title is `work`, and the panes layout for it contains a terminal leaf with `sessionRef.sessionId === 'S2'`). Also add a test that `hadPersistedLayoutAtBoot: true` + no pending flag renders nothing and never fetches (use a second mock variant via `vi.doMock` + dynamic import, or split into a separate test file with a different boot-state mock — whichever matches house style).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- run test/unit/client/components/RecoveryOfferPanel.test.tsx`
Expected: FAIL — component missing.

- [ ] **Step 3: Implement the component**

Implement per the Behavior contract above. Structure:

```tsx
export function RecoveryOfferPanel() {
  const dispatch = useAppDispatch()
  const store = useStore<RootState>()
  const [inventory, setInventory] = useState<RecoveryInventory | null>(null)
  const [resolved, setResolved] = useState(false)

  useEffect(() => {
    if (hadPersistedLayoutAtBoot && !getPendingOffer()) { setResolved(true); return }
    let cancelled = false
    getRecoveryInventory(getClientInstanceId())
      .then((inv) => {
        if (cancelled) return
        if (!inv.recoverable || isDismissed(inv.contentId)) { setResolved(true); return }
        setPendingOffer(inv.contentId)
        setInventory(inv)
      })
      .catch(() => { if (!cancelled) setResolved(true) })
    return () => { cancelled = true }
  }, [])

  const accept = () => {
    if (!inventory) return
    clearPendingOffer()
    const plans = buildRecoveryPlan(inventory)
    for (const plan of plans) {
      dispatch(addTab({ id: plan.tabId, title: plan.title }))
      dispatch(restoreLayout({ tabId: plan.tabId, layout: plan.layout, paneTitles: plan.paneTitles }))
    }
    armRecoveredTerminalRestores(store.getState(), plans.map((p) => p.tabId))
    setInventory(null); setResolved(true)
  }

  const decline = () => {
    if (inventory) recordDismissal(inventory.contentId)
    clearPendingOffer()
    setInventory(null); setResolved(true)
  }
  // render: null unless inventory; else portal dialog per Behavior item 2/5
}
```

`armRecoveredTerminalRestores(state, tabIds)`: for each tabId, read the tab's layout from the panes slice state, walk the tree, and for each leaf with `content.kind === 'terminal' && content.sessionRef` call `addTerminalRestoreRequestId(content.createRequestId)` (post-normalization id — the reducer re-minted it). Match how `App.tsx:1069` arms restores. Export it for direct unit testing if the component tests don't already cover it.

Export `getClientInstanceId` from `tabRegistrySync.ts` by adding `export` to (or a thin exported wrapper around) the existing private accessor the push envelope uses — no behavior change.

- [ ] **Step 4: Run tests + a11y lint**

Run: `npm run test:vitest -- run test/unit/client/components/RecoveryOfferPanel.test.tsx && npm run lint`
Expected: PASS, no jsx-a11y violations.

- [ ] **Step 5: Commit**

```bash
git add src/components/RecoveryOfferPanel.tsx src/store/tabRegistrySync.ts test/unit/client/components/
git commit -m "feat(client): self-gating recover-my-panes offer panel with accept/decline (B3/P1.9)"
```

---

### Task 6: Client — App.tsx wiring (distinct Lane B3 region)

**Files:**
- Modify: `src/App.tsx` (ONLY: one import + one JSX line adjacent to the `SetupWizard` render at ~`App.tsx:1347-1362`; do NOT touch regions 811-898, 900-981, 1002-1090, 1283-1325)
- Modify: `test/unit/client/components/RecoveryOfferPanel.test.tsx` (no changes expected; listed for the re-run)

**Interfaces:**
- Consumes: `RecoveryOfferPanel` (Task 5).
- Produces: the panel mounted app-wide.

- [ ] **Step 1: Make the change**

Import at the top of `App.tsx`:

```tsx
import { RecoveryOfferPanel } from '@/components/RecoveryOfferPanel'
```

Adjacent to the `SetupWizard` JSX:

```tsx
{/* LANE B3 (recover-my-panes): self-gating recovery offer — see docs/plans/2026-07-26-recover-my-panes.md */}
<RecoveryOfferPanel />
```

(The component is fully self-gating, so unconditional render is correct and keeps the App.tsx footprint to two lines — mechanical-merge-friendly with Lane B1.)

- [ ] **Step 2: Verify nothing regressed**

Run: `env -u FRESHELL_BIND_HOST FRESHELL_TEST_SUMMARY="B3 recover-my-panes: app wiring" npm run test:vitest -- run test/unit/client/`
Expected: PASS. Then `npm run lint` — PASS.

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(client): mount recovery offer panel in App (Lane B3 region) (B3/P1.9)"
```

---

### Task 7: Client — full coordinated suite checkpoint

**Files:** none new — verification gate before e2e work.

- [ ] **Step 1: Run the coordinated full suite**

Run: `env -u FRESHELL_BIND_HOST FRESHELL_TEST_SUMMARY="B3 recover-my-panes: pre-e2e checkpoint" npm test`
(WAIT if the coordinator gate is held by a sibling lane — check `npm run test:status`; never kill a foreign holder.)
Expected: green. Fix any breakage this lane introduced before proceeding (do not touch failures owned by other lanes' files — if a failure is in fenced files, record it and re-check `npm run test:status` for an advisory baseline before concluding it's ours).

- [ ] **Step 2: Run the Rust workspace suite**

Run: `cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`
Expected: green.

- [ ] **Step 3: Commit (only if fixes were needed)**

```bash
git add -A && git commit -m "test: stabilize recover-my-panes unit/integration coverage (B3)"
```

---

### Task 8: E2E — the browser-loss recovery spec

**Files:**
- Create: `test/e2e-browser/specs/recover-my-panes-rust.spec.ts`
- Modify: the two registration lists that `pane-ledger-restart-rust.spec.ts` appears in — `RUST_ONLY_SPECS` and the `rust-chromium` project `testMatch` (grep for `pane-ledger-restart-rust` to find both; add this spec the same way)

**Interfaces:**
- Consumes: `RustServer` (`test/e2e-browser/helpers/rust-server.ts` — `homeDir` defaults to a fresh mkdtemp; `findFreePort()`; `restart()`), the fake-CLI installation + claude-pane creation pattern from `test/e2e-browser/specs/pane-ledger-restart-rust.spec.ts:1-80` (`installFakeCli()` + fixtures `fake-claude-cli.mjs`), fresh-context storage-wipe pattern from `tabs-client-retire.spec.ts:6-38` (`browser.newContext()` = empty localStorage), `?token=<t>&e2e=1` URL scheme, `data-testid="recovery-offer-panel"` / `recovery-accept` / `recovery-decline` from Task 5.
- Produces: the campaign's first browser-loss recovery e2e.

Scenarios (all inside one spec file sharing one owned `RustServer` on an ephemeral port — NEVER 3001/3002; ESM imports use `.js` extensions):

**Scenario 1 — lose the browser, recover the panes (accept path):**
1. Start `RustServer` with its own `homeDir` and `installFakeCli()` (mirror `pane-ledger-restart-rust.spec.ts` setup).
2. Context A: `browser.newContext()` → `page.goto(baseUrl + '/?token=' + token + '&e2e=1')` → create a claude CLI pane exactly the way `pane-ledger-restart-rust.spec.ts` does (fake CLI) and let it bind (that spec's readiness waits) — this produces a ledger binding AND layout state.
3. Wait for a snapshot to exist on disk: poll `fs.readdir(path.join(homeDir, '.freshell', 'tabs-snapshots'))` until a device dir with ≥1 `.json` generation appears (timeout 30s — pushes fire on ready + every 5s).
4. `await contextA.close()` — the "lost browser".
5. `await server.restart()` — the campaign scenario restarts the server too.
6. Context B: fresh `browser.newContext()` (empty storage = new machine) → `goto` the same URL.
7. `await expect(pageB.getByTestId('recovery-offer-panel')).toBeVisible({ timeout: 15000 })` and assert the heading matches `/restore \d+ pane/i`.
8. `await pageB.getByTestId('recovery-accept').click()` → panel disappears → assert a recreated terminal pane renders and the fake claude session RESUMES (reuse the exact resumed-session assertion from `pane-ledger-restart-rust.spec.ts` — e.g. the fake CLI's resume marker text appearing in the recreated pane's terminal).
9. Same-browser reload guard: `await pageB.reload()` → wait for app ready → `await expect(pageB.getByTestId('recovery-offer-panel')).toHaveCount(0)` (localStorage now has a layout — no offer).

**Scenario 2 — decline path:**
1. Fresh context C against the same server (which still has snapshots + ledger rows from scenario 1's context A... note: context B's accepted layout also pushed snapshots — that is fine; recoverable state still exists).
2. Offer appears → `recovery-decline` click → panel gone → assert no recovered tabs were added (tab strip shows only the auto-created default tab).

Dismissal-across-reload persistence is proven at unit level (Task 3/5); e2e scenario 2 proves the user-visible decline behavior.

- [ ] **Step 1: Write the failing spec**

Write the spec per the scenarios above, copying the harness scaffolding verbatim from `pane-ledger-restart-rust.spec.ts` (imports with `.js` extensions, `ensureRustServerBuilt`, server lifecycle in `test.beforeAll`/`afterAll`, fake CLI install). Register it in both lists.

- [ ] **Step 2: Run to verify it fails only on the new assertions**

Run: `npx playwright test test/e2e-browser/specs/recover-my-panes-rust.spec.ts --project=rust-chromium`
Expected at this point: PASS (the feature is already implemented in Tasks 1-6) — but run it BEFORE trusting it: if it passes, deliberately verify the test tests something by temporarily commenting out the `<RecoveryOfferPanel />` line in `App.tsx` and re-running — it must FAIL on step 7's visibility assertion. Restore the line. (This is the red-verification for an e2e written after its feature tasks; do not skip it.)

- [ ] **Step 3: Stabilize**

Fix selector/timing issues until the spec passes 2 consecutive runs. Common traps already known: the auto-created shell tab races the offer (irrelevant — eligibility is boot-captured); snapshot push cadence is 5s (the fs poll in step 3 handles it); `RustServer` restart keeps the port.

- [ ] **Step 4: Commit**

```bash
git add test/e2e-browser/
git commit -m "test(e2e): browser-loss recover-my-panes proof - offer, accept-resume, reload guard, decline (B3/P1.9)"
```

---

### Task 9: Delete the operator restore endpoint + marker/fence machinery (kata h9vt cleanup)

**Files:**
- Modify: `crates/freshell-server/src/tabs_snapshots.rs` (remove the `POST /api/tabs-sync/restore` route + handler, `restore_lock`, the exactly-one-browser gate, marker usage, the delivery fence including the `send_capture_to` call at `tabs_snapshots.rs:241`, and `pane_to_create_body` usage; KEEP anything the crate still needs — if nothing remains, delete the file and its `mod` decl)
- Delete: `crates/freshell-server/src/tabs_snapshots_marker.rs`, `crates/freshell-server/src/tabs_snapshots_create_body.rs`, `crates/freshell-server/src/tabs_snapshots_selectors.rs` (the restore-body selector parser — delete only after confirming the inventory endpoint doesn't import it), their test siblings, `scripts/restore-tabs.sh`
- Modify: `crates/freshell-server/src/main.rs` (remove the restore route merge + dead `mod` decls)
- Modify: `crates/freshell-server/src/screenshot.rs` — ONLY if removing the fence caller makes `send_capture_to` dead (compiler/clippy will say): delete it and its now-dead helpers in the same commit (P2.17 sanctions exactly this deletion)

**Interfaces:**
- Consumes: nothing new. Preserves: `freshell_ws::tabs_persist` read selectors (used by Task 2) and the entire write path (untouched).
- Produces: no `POST /api/tabs-sync/restore`; the store's only consumers are the push write path and `GET /api/recovery/inventory`.

- [ ] **Step 1: Confirm the blast radius**

```bash
grep -rn "tabs-sync/restore\|tabs_snapshots_marker\|restore-tabs.sh\|pane_to_create_body\|send_capture_to" --include='*.rs' --include='*.sh' --include='*.ts' --include='*.md' crates/ scripts/ src/ test/ docs/development/ | grep -v docs/plans/
```
Expected consumers: the endpoint's own module/tests, `main.rs` wiring, the script, `screenshot.rs:244`. If ANYTHING else consumes these (another route, a doc under `docs/development/` describing operator procedure), list it in the commit message and update/delete it too. If a consumer exists that the UI flow does not replace — STOP and report (that would reopen the h9vt disposition).

- [ ] **Step 2: Delete, then let the compiler drive**

Remove the route merge from `main.rs` first, then the handler + machinery, then the files. Iterate `cargo check -p freshell-server` until clean; every `dead_code` warning that appears in touched modules is machinery the fence/marker existed for — delete it (context poison), do not `#[allow]` it.

- [ ] **Step 3: Verify the full workspace + client suites stay green**

Run: `cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`
Expected: PASS with the restore/marker test files gone; if any REMAINING test fails because it exercised restore machinery, that test belonged to the deleted feature — delete it; if it fails for any other reason, fix the code, not the test.
Run: `npx playwright test test/e2e-browser/specs/recover-my-panes-rust.spec.ts --project=rust-chromium`
Expected: PASS (proves the UI flow never depended on the deleted machinery).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(server): delete operator tabs-sync restore endpoint, write-ahead marker, and screenshot delivery fence

Kata h9vt disposition: Option A. The tabs-snapshots store is now load-bearing
via GET /api/recovery/inventory + the client recover-my-panes flow. The
server-push restore machinery (marker, one-browser gate, delivery fence,
scripts/restore-tabs.sh) served only the blind operator push and has no UI-flow
consumer; the unreachable fence was flagged for deletion in campaign P2.17."
```

---

### Task 10: Final verification + push

**Files:** none.

- [ ] **Step 1: Full gates, in order**

```bash
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
npm run lint
env -u FRESHELL_BIND_HOST FRESHELL_TEST_SUMMARY="B3 recover-my-panes: final verification" npm run check
npx playwright test test/e2e-browser/specs/recover-my-panes-rust.spec.ts --project=rust-chromium
```
Expected: all green. (`npm run check` = typecheck + coordinated full suite; WAIT on the coordinator gate if held.)

- [ ] **Step 2: Push the branch — STOP before any PR**

```bash
git push -u origin feat/recover-my-panes
```
Do NOT run `gh pr create` — PR creation is not approved for this lane.

- [ ] **Step 3: Report**

The lane's final report must include: branch name, the green-suite evidence (commands + outcomes), the e2e proof summary, and this kata disposition statement: **"Kata h9vt resolved as Option A: tabs-snapshots is now load-bearing (layout half of the recover-my-panes flow via GET /api/recovery/inventory); the operator POST /api/tabs-sync/restore endpoint, write-ahead marker, exactly-one-browser gate, screenshot delivery fence, and scripts/restore-tabs.sh were deleted as UI-flow-irrelevant per the 'reuse what serves the UI flow, delete what doesn't' directive and P2.17."**

---

## Self-Review Record

**1. Spec coverage:** (1) recover-my-panes flow — offer/trigger D1-D3 + Tasks 3/5/6; accept recreation honoring §4.2 D4-D5 + Tasks 1/4/5; decline remembered Task 3/5. (2) kata h9vt — disposition section + Task 9 (Option A kept, honest evaluation recorded; Option B rejected with reason: ledger has no layout). (3) read API — Tasks 1/2, device-scoped via snapshot device dirs + self-pollution filter, auth'd, fed by ledger + newest-generation union selectors. TDD red-first for trigger conditions, inventory API, authority chain, dismissal — Tasks 1-5 all test-first; Task 8's e2e includes an explicit red-verification step. E2E browser-loss scenario with own RustServer/ephemeral ports/server restart/fresh context/decline/same-browser-reload — Task 8. Scope fence, a11y lint, PR policy — Global Constraints + Task 10.

**1b. No silent deferrals:** no stubs or fake providers stand in for required behavior — the e2e uses the repo's established fake-CLI fixture (the same production-path proof used by the existing ledger restart e2e; it exercises the real create/resume path). Non-terminal pane recreation reuses the production `reopenClosedTab` restore path (passthrough, D5) — recreated, not deferred. Split geometry is not in the store (D6) — a data fact, not a deferral. No UNRESOLVED COVERAGE GAPS.

**2. Placeholder scan:** the `row_*` accessors (Task 1) and `union_value` (Task 2) are named single-field adapters against real definitions the implementer opens — each is bound to a concrete file/line source, with tests as the arbiter; no TBD/TODO/"handle edge cases" items remain.

**3. Type consistency:** `DeviceUnion`/`build_inventory` (Task 1) consumed verbatim in Task 2; `RecoveryInventory`/`RecoveryPane`/`RecoveryTabPlan` (Task 4) consumed in Task 5; `getClientInstanceId` exported in Task 5 and consumed there; testids `recovery-offer-panel`/`recovery-accept`/`recovery-decline` defined in Task 5, consumed in Task 8; `ledgerState` values (`bound|closed|gc_expired|unknown`) match between Task 1 output, Task 4 types, and tests.
