# Tab Strip Order Restore (tabs-union-order) Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Fix the tab-order regression on restart/refresh via the server-side fix: make the Rust tabs-registry union preserve the client's pushed tab-strip record order (instead of deduping into a HashMap and sorting records by tabKey), so the recovery inventory — and the machine-identity workspace restore that consumes it — rebuilds tabs in the user's original tab-strip order.

### Explicit constraints
- Run the-usual workflow (worktree under .worktrees/, plan, load-bearing validation, fresh-eyes plan review, TDD execution with per-task reviews, fresh-eyes delta review, recap).
- Server-side fix only (Rust: crates/freshell-ws/src/tabs_persist.rs and its inventory consumers); do not redesign the client-side machine-workspace restore path.
- Lift the final delta-review cap from 5 to 15 rounds for this run (explicit user override of the-usual's Stage 5 cap).
- Follow repo rules: TDD red/green/refactor, no PR creation without explicit user approval, commit plan docs, respect the shared test coordinator gate.
- Multi-client unions must remain deterministic (same inputs → same output order).

### Accepted tradeoffs and residuals
- The client-side alternative (skip clear+rebuild when a fresh local layout exists — the approach another in-flight branch is taking) is accepted as complementary, not a substitute; when a restore does happen, its order must still be the strip order.
- Deterministic foreign-key ordering for records absent from the winning generation (e.g. tabKey sort for the appended tail) is acceptable; exact cross-client interleaving order is not guaranteed.

**Goal:** After a restart/refresh that goes through the machine-identity workspace restore, the tab strip comes back in the user's tab-strip order instead of tabKey-sorted (effectively random) order.

**Architecture:** One behavioral change in `union_of_newest_per_client` (crates/freshell-ws/src/tabs_persist.rs:583-660): the per-tabKey dedupe-rank winner semantics stay EXACTLY as-is, but records are emitted in FIRST-SEEN order across deterministically ranked sources (each client's newest generation, ranked newest-first by the same tuple `label_src` uses — `(capturedAt, snapshotRevision, clientInstanceId, generationId)` descending; within a source, the pushed record array order, which the client builds from its tab strip in `tabRegistrySync.ts buildRecords`). A tab's POSITION is its slot in the newest source that knows it; a tab's CONTENT is still the existing dedupe-rank winner. Downstream consumers are already order-preserving and were verified order-sensitive in exactly one place: `build_inventory` maps union records to `device.tabs` in order (recovery_inventory.rs:697-702), and the client's `restoreMachineWorkspace`/`buildRecoveryPlan` dispatch `addTab` in that order. The `tabs.sync.snapshot` replies on BOTH servers re-sort by `updatedAt` and are unaffected; the recovery `contentId` sorts its substance lines before hashing and is order-independent; no on-disk generation file, digest, or bundle name is computed from union output.

**Tech Stack:** Rust workspace (`cargo test -p freshell-ws`, `-p freshell-server`), Vitest client unit tests (`npm run test:vitest --`), Playwright rust-chromium e2e (`scripts/e2e-cloud.sh run --local --project=rust-chromium`).

## Global Constraints

- **File size:** ≤1,000 lines per file (`port/AGENTS.md:81`). `tabs_persist.rs` is pre-existing at 1038 lines — keep additions minimal, no in-lane restructuring (precedent: `docs/plans/2026-07-27-rest-spawn-gate.md` for pre-existing over-limit files). New Rust unit tests go in the existing `#[cfg(test)] #[path = "tabs_persist_tests.rs"]` sibling.
- **Determinism (explicit user constraint):** same union inputs must produce the same output order. Source ranking is a total order (tuple above); within one source the on-disk record array order is fixed.
- **Rust gates:** `cargo fmt --all --check` and `cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings` must pass before each Rust commit.
- **Vitest:** repo-owned path only — `npm run test:vitest -- run <paths>` (never raw `npx vitest`). Client-side pins in this plan are green contract pins (the bug is server-fed order, so they pass at base by design); they protect the client's order-preservation contract.
- **E2e:** rust-only specs run LOCALLY — `bash scripts/e2e-cloud.sh run --local --project=rust-chromium <spec-path>` (the cloud lane skips the rust-chromium project by design, `playwright.cloud.config.ts:54`). The spec must be registered in BOTH `RUST_ONLY_SPECS` (so the default `chromium` project ignores it) and the `rust-chromium` project's `testMatch` in `test/e2e-browser/playwright.config.ts`.
- **Test coordinator:** the end-of-execution full-suite gate (`npm test`) is a coordinated run. In non-login shells, `~/.bashrc` is not sourced: export `FRESHELL_VITEST_BACKEND=cloud` and `GCLOUD_IDENT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com` explicitly on every cloud-lane invocation from this agent (machine identity fix recorded in run-state).
- **No PR creation.** Commit locally on `the-usual/tabs-union-order`.
- **No client restore-path redesign:** `src/lib/machine-workspace.ts` and `src/App.tsx` are not modified by this plan.
- **docs/index.html:** no update — this is a bug fix (order restoration), not a user-facing feature or UI change.

## Verified ground truth (explorer reports + coordinator code reads)

- The client pushes `records` in exact strip order (`src/store/tabRegistrySync.ts:200` `buildRecords` iterates `state.tabs.tabs`); the Rust WS ingestion (`validate_tabs_push` → `replace_client_snapshot` → `persist_generation`) persists the array verbatim; tabKeys are unique within one push.
- Only ONE order-sensitive consumer chain exists: union records → `build_inventory` `device.tabs` (in order) → `buildRecoveryPlan` (order-preserving, `src/lib/recovery/build-recovery-plan.ts:313`) → `restoreMachineWorkspace`'s `addTab` loop (`src/lib/machine-workspace.ts:65-75`).
- The recovery inventory EXCLUDES the requester's own clientInstanceId generations (`select_foreign_recent_generation_ids`, A15/A16) — so a reload restores pre-reload tabs only when the reloaded page has a NEW clientInstanceId (sessionStorage cleared or new tab). The e2e below forces exactly that.
- One existing test pins the current tabKey sort incidentally: `union_by_ids_resolves_exact_generation_files_when_digests_repeat_across_clients` (`tabs_persist_tests.rs:1013-1019`).
- Machine resolution on reload: the auto-created machine id is persisted to localStorage (`machine-identity.ts persistSelectedMachineId`), so the reloaded page resolves `'selected'` and runs `restoreMachineWorkspace` before the WS starts.

---

### Task 1: E2E spec pinning tab order across reload (RED at base)

**Files:**
- Create: `test/e2e-browser/specs/machine-tab-order-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (`RUST_ONLY_SPECS` array ~:187; `rust-chromium` project `testMatch` ~:430)

**Interfaces:**
- Consumes: existing e2e fixtures (`helpers/fixtures.js` → `page`, `serverInfo`, `harness`), `TestHarness.waitForHarness/waitForConnection/getState/getSentWsMessages`, the real e2e Rust server's `/api/machines` + `/api/recovery/inventory`, Redux dispatch seam `window.__FRESHELL_TEST_HARNESS__?.dispatch` (precedent: `remote-tab-linkage-rust.spec.ts:257`, `pane-activity-indicator.spec.ts`).
- Produces: the spec `machine-tab-order-rust.spec.ts` (consumed by Task 2's impacted-test step).

- [ ] **Step 1: Write the failing e2e test**

Create `test/e2e-browser/specs/machine-tab-order-rust.spec.ts`:

```typescript
import { test, expect } from '../helpers/fixtures.js'

/**
 * MACHINE-TAB-ORDER (the-usual/tabs-union-order): the tab strip's ORDER must
 * survive a reload that goes through the machine-identity workspace restore.
 *
 * The regression: `union_of_newest_per_client`
 * (crates/freshell-ws/src/tabs_persist.rs) deduped the tabs-registry
 * generations into a HashMap keyed by tabKey and emitted the union records
 * SORTED BY TABKEY — arbitrary relative to the strip (tabKey is
 * `<machineId>:<tabId>`). On every boot with a resolved machine,
 * `restoreMachineWorkspace` (src/lib/machine-workspace.ts) replaces the
 * local tabs with `inv.device.tabs` in union order — so a restart/refresh
 * scrambled the strip.
 *
 * Deterministic failure shape: tabs are created with EXPLICIT ids
 * (tab-mango, tab-apple, tab-zebra) in that order, so the buggy tabKey sort
 * yields exactly [tab-apple, tab-mango, tab-zebra] — distinct from the
 * creation order.
 *
 * Why the restore sees the pre-reload tabs: sessionStorage is cleared on
 * every navigation (addInitScript below), so the reloaded page mints a NEW
 * clientInstanceId; the recovery inventory then treats the pre-reload
 * generations as a FOREIGN client's (A15/A16: captured before this boot)
 * and `build_inventory` rebuilds `device.tabs` from them. The machine id
 * itself lives in localStorage and survives the reload, so resolution is
 * 'selected' (not the chooser) and the restore path runs before the WS.
 */
test.describe('machine workspace restore keeps tab order', () => {
  test('a reload restores the tab strip in the pushed strip order', async ({ page, serverInfo, harness }) => {
    await page.addInitScript(() => { sessionStorage.clear() })
    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await harness.waitForHarness()
    await harness.waitForConnection()

    // Three tabs with explicit ids, created in an order that differs from
    // tabKey sort. Editor panes: no PTY spawn, and the recovery plan
    // round-trips editor payloads (build-recovery-plan.ts, the D6 rule).
    const tabs = [
      { id: 'tab-mango', title: 'Mango', file: '/tmp/mango.md' },
      { id: 'tab-apple', title: 'Apple', file: '/tmp/apple.md' },
      { id: 'tab-zebra', title: 'Zebra', file: '/tmp/zebra.md' },
    ]
    for (const tab of tabs) {
      await page.evaluate((t: typeof tabs[number]) => {
        window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'tabs/addTab', payload: { id: t.id, title: t.title } })
        window.__FRESHELL_TEST_HARNESS__?.dispatch({
          type: 'panes/initLayout',
          payload: {
            tabId: t.id,
            paneId: `${t.id}-pane`,
            content: {
              kind: 'editor', filePath: t.file, language: null,
              readOnly: false, content: '', viewMode: 'source', wordWrap: true,
            },
          },
        })
      }, tab)
    }

    // Wait until the server holds a tabs-registry generation carrying all
    // three tabKeys: tabs.sync.push fires on the lifecycle change (with a
    // 5s interval fallback), and persist_generation writes it durably.
    await expect.poll(async () => {
      const sent = await harness.getSentWsMessages()
      return sent.some((m: any) =>
        m?.type === 'tabs.sync.push'
        && ['tab-mango', 'tab-apple', 'tab-zebra'].every((id) =>
          JSON.stringify(m?.records ?? []).includes(id)))
    }, { timeout: 20_000 }).toBe(true)

    await page.reload({ waitUntil: 'domcontentloaded' })
    await harness.waitForHarness()
    await harness.waitForConnection()

    // The restore replaced the local strip before the WS connected; wait
    // for all three tabs and pin the exact order. Before the union fix the
    // received order is the tabKey sort ['Apple', 'Mango', 'Zebra'].
    await expect.poll(async () => {
      const state = await harness.getState()
      return (state?.tabs?.tabs ?? []).map((t: any) => t.title)
    }, { timeout: 20_000 }).toEqual(['Mango', 'Apple', 'Zebra'])
  })
})
```

Register in `test/e2e-browser/playwright.config.ts`. In the `RUST_ONLY_SPECS` array (after the `/freshagent-live-model-convergence-rust\.spec\.ts$/` entry):

```typescript
  // MACHINE-TAB-ORDER (the-usual/tabs-union-order): reload-through-restore
  // keeps the tab strip order. Rust-only: drives the REAL /api/machines +
  // /api/recovery/inventory (the machine-identity workspace restore path);
  // the legacy Node server implements neither API.
  /machine-tab-order-rust\.spec\.ts$/,
```

And the same regex plus comment inside the `rust-chromium` project's `testMatch` array.

- [ ] **Step 2: Run the spec and verify the intended failure**

Run: `bash scripts/e2e-cloud.sh run --local --project=rust-chromium test/e2e-browser/specs/machine-tab-order-rust.spec.ts`

Expected: FAIL — the final `expect.poll` receives `['Apple', 'Mango', 'Zebra']` (the tabKey-sorted permutation) against expected `['Mango', 'Apple', 'Zebra']`. This is the regression, observed end to end. If the spec fails ANY OTHER way (zero tabs restored, a machine-chooser dialog visible, a timeout before three titles exist), the restore-path assumptions are wrong: STOP and investigate rather than adjusting the spec — record the surprise in the progress ledger and surface it to the coordinator (it would falsify this plan's verified-ground-truth section).

- [ ] **Step 3: Commit the task**

```bash
git add test/e2e-browser/specs/machine-tab-order-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): pin tab strip order across a reload-through-restore (red)"
```

(The spec stays red until Task 2 lands the union fix; Task 2's impacted-test step turns it green. The full `npm test` suite does not run Playwright, so no coordinated suite goes red meanwhile.)

### Task 2: Rust union preserves pushed record order (RED → GREEN)

**Files:**
- Modify: `crates/freshell-ws/src/tabs_persist.rs:652-658` (emission block inside `union_of_newest_per_client`)
- Test: `crates/freshell-ws/src/tabs_persist_tests.rs` (three new tests + one assertion flip)

**Interfaces:**
- Consumes: `newest_per_client` (unchanged), `label_src` ranking tuple `(capturedAt, generation_rank().0, clientInstanceId, snapshot_generation_id)` (unchanged), `by_key` dedupe rank `(revision, updatedAt, clientInstanceId, generationId)` (unchanged winner semantics).
- Produces: `union_of_newest_per_client` record order = first-seen across newest-first sources (consumed by `read_device_union`, `read_generations_union_by_ids`, `read_device_overview` — none change signature).

- [ ] **Step 1: Write the failing behavioral tests**

In `crates/freshell-ws/src/tabs_persist_tests.rs` (uses the existing `put`/`union`/`open_record` helpers):

```rust
#[test]
fn union_preserves_the_newest_sources_pushed_record_order() {
    // The regression: the union deduped into a HashMap and emitted records
    // sorted by tabKey, so the recovery inventory rebuilt the tab strip in
    // an order unrelated to the user's strip. The client pushes records in
    // strip order (tabRegistrySync's buildRecords iterates state.tabs.tabs);
    // a single-client union must return them in exactly that pushed order.
    let dir = tempfile::tempdir().unwrap();
    put(
        dir.path(),
        "dev",
        "clientA",
        3,
        1000,
        vec![
            open_record("dev:k3", "Third", 30),
            open_record("dev:k1", "First", 10),
            open_record("dev:k2", "Second", 20),
        ],
    );
    let out = union(dir.path(), "dev").unwrap();
    let keys: Vec<&str> = out["records"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|r| r["tabKey"].as_str())
        .collect();
    assert_eq!(keys, vec!["dev:k3", "dev:k1", "dev:k2"]);
}

#[test]
fn union_positions_keys_by_first_seen_source_and_content_by_dedupe_rank() {
    // POSITION: a tab's slot comes from the NEWEST source that knows it
    // (deterministic source order: capturedAt desc, then the label_src
    // tie-break tuple). CONTENT: the per-key dedupe-rank winner is
    // unchanged — client B's older push carries the highest-rank record
    // for dev:y, so dev:y sits in client A's slot (index 1) but with B's
    // newer record content.
    let dir = tempfile::tempdir().unwrap();
    put(
        dir.path(),
        "dev",
        "clientA",
        1,
        2000,
        vec![open_record("dev:x", "X", 10), open_record("dev:y", "Y-old", 10)],
    );
    put(
        dir.path(),
        "dev",
        "clientB",
        1,
        1000,
        vec![
            open_record("dev:z", "Z", 10),
            open_record("dev:y", "Y-new", 5000),
            open_record("dev:w", "W", 10),
        ],
    );
    let out = union(dir.path(), "dev").unwrap();
    let records = out["records"].as_array().unwrap();
    let keys: Vec<&str> = records
        .iter()
        .filter_map(|r| r["tabKey"].as_str())
        .collect();
    assert_eq!(keys, vec!["dev:x", "dev:y", "dev:z", "dev:w"]);
    let y = records
        .iter()
        .find(|r| r["tabKey"] == json!("dev:y"))
        .unwrap();
    assert_eq!(
        y["tabName"],
        json!("Y-new"),
        "content winner stays the dedupe-rank winner"
    );
}
```

And flip the one incidental order pin in `union_by_ids_resolves_exact_generation_files_when_digests_repeat_across_clients` (~:1013-1019) — replace:

```rust
    assert_eq!(keys, vec!["dev:x", "dev:y"]);
```

with:

```rust
    // First-seen order: the picked bundle's newest source is clientB's
    // generation (capturedAt 1001 > 1000), so dev:y precedes dev:x. The
    // test's subject is exact-file resolution (both records present);
    // the order assertion documents the union's ordering contract.
    assert_eq!(keys, vec!["dev:y", "dev:x"]);
```

- [ ] **Step 2: Run the tests and verify the intended failures**

Run: `cargo test -p freshell-ws --lib tabs_persist`

Expected: FAIL — `union_preserves_the_newest_sources_pushed_record_order` receives `["dev:k1", "dev:k2", "dev:k3"]`; `union_positions_keys_by_first_seen_source_and_content_by_dedupe_rank` receives `["dev:x", "dev:y", "dev:z", "dev:w"]` sorted by tabKey (`dev:w`, `dev:x`, `dev:y`, `dev:z`); the flipped bundle test receives `["dev:x", "dev:y"]`. All three fail because the tabKey sort still governs, not for setup/syntax reasons.

- [ ] **Step 3: Add the minimal production implementation**

In `crates/freshell-ws/src/tabs_persist.rs`, replace the emission block at the end of `union_of_newest_per_client` (:652-658) — the two statements

```rust
    let mut records: Vec<Value> = by_key.into_values().map(|(rec, _)| rec).collect();
    records.sort_by_key(|r| {
        r.get("tabKey")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    });
```

with:

```rust
    // FIRST-SEEN emission (the tab-order regression fix): the client pushes
    // each generation's records in its tab-strip order, so a tab's union
    // POSITION is its slot in the NEWEST source that knows it — the most
    // recent view of the user's strip — while its CONTENT stays the per-key
    // dedupe-rank winner chosen above (unchanged semantics). Sources are
    // ranked newest-first by the same tuple `label_src` uses, so HashMap
    // iteration order never decides user-visible record order (the
    // determinism the old `sort_by_key(tabKey)` existed to provide).
    let mut sources: Vec<(&String, &(i64, PathBuf, Value))> = newest.iter().collect();
    sources.sort_by(|a, b| {
        let key = |s: &(&String, &(i64, PathBuf, Value))| {
            (
                captured_at(&s.1.2),
                generation_rank(&s.1.2).0,
                s.0.clone(),
                snapshot_generation_id(&s.1.2),
            )
        };
        key(b).cmp(&key(a))
    });
    let mut seen: HashSet<&str> = HashSet::new();
    let mut records: Vec<Value> = Vec::new();
    for (_, (_, _, snap)) in &sources {
        for rec in snap
            .get("records")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let tab_key = rec.get("tabKey").and_then(Value::as_str).unwrap_or("");
            if seen.insert(tab_key) {
                if let Some((winner, _)) = by_key.get(tab_key) {
                    records.push(winner.clone());
                }
            }
        }
    }
```

Keep the surrounding code (label_src selection, the `by_key` rank loop) byte-identical. Import change: line 5 is `use std::collections::HashMap;` — change to `use std::collections::{HashMap, HashSet};` (HashSet is not currently imported; verified against the file's use block). Net growth ≈ +21 lines on a pre-existing over-limit file — accepted under the Global Constraints precedent; do not restructure.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-ws --lib tabs_persist`

Expected: PASS (the two new tests, the flipped bundle test, and every existing tabs_persist test).

- [ ] **Step 5: Refactor while green**

Add the determinism pin (green before and after; protects the new emission's core guarantee):

```rust
#[test]
fn union_record_order_is_independent_of_file_scan_order() {
    // Same generations written in reverse creation order must union to the
    // SAME record order: the first-seen rule ranks SOURCES, never files or
    // scan order (the determinism contract of the user request).
    let build = |reverse: bool| {
        let dir = tempfile::tempdir().unwrap();
        let a = vec![open_record("dev:x", "X", 10), open_record("dev:y", "Y-old", 10)];
        let b = vec![
            open_record("dev:z", "Z", 10),
            open_record("dev:y", "Y-new", 5000),
            open_record("dev:w", "W", 10),
        ];
        let mut writes: Vec<(&str, i64, Vec<Value>)> = vec![
            ("clientA", 2000, a),
            ("clientB", 1000, b),
        ];
        if reverse {
            writes.reverse();
        }
        for (client, captured, recs) in writes {
            put(dir.path(), "dev", client, 1, captured, recs);
        }
        union(dir.path(), "dev").unwrap()
    };
    assert_eq!(build(false), build(true));
}
```

No other refactor: the change is already minimal and sits inside the existing function.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: every consumer of `union_of_newest_per_client` and every suite touching tabs-persist or the recovery inventory (per the explorer map: `read_device_union` → tabs_snapshots REST; `read_generations_union_by_ids` → recovery inventory; `read_device_overview` → machines import + evidence), plus the Task 1 e2e.

Run all of:

```bash
cargo test -p freshell-ws --lib tabs
cargo test -p freshell-server --lib recovery_inventory
cargo test -p freshell-server --lib tabs_snapshots
cargo test -p freshell-server --lib machines
cargo test -p freshell-ws --test ui_layout_sync
cargo test -p freshell-ws --test sessions_prefs
cargo fmt --all --check
cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings
bash scripts/e2e-cloud.sh run --local --project=rust-chromium test/e2e-browser/specs/machine-tab-order-rust.spec.ts
```

Expected: all cargo suites PASS (including `ui_layout_sync`/`sessions_prefs`, which explorer analysis says never touch the union — they prove it); fmt/clippy clean; the e2e from Task 1 now PASSES (received order `['Mango', 'Apple', 'Zebra']`).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ws/src/tabs_persist.rs crates/freshell-ws/src/tabs_persist_tests.rs
git commit -m "fix(tabs-persist): union preserves the client's pushed tab-strip order (first-seen emission)"
```

### Task 3: Recovery inventory preserves union order into device.tabs (green cross-crate pin)

**Files:**
- Test: `crates/freshell-server/src/recovery_inventory_tests.rs` (add one test)

**Interfaces:**
- Consumes: `build_inventory`'s `device.tabs` mapping (recovery_inventory.rs:697-702) — order-preserving today; this pin locks the contract at the crate boundary so a future reorder inside `build_inventory` cannot hide behind the union's tests.
- Produces: none (test-only).

- [ ] **Step 1: Add the pinning test**

Follow the existing fixture helpers in `recovery_inventory_tests.rs` (`union_doc_with_tab_key`, `no_live()`, `no_evidence()`, `no_closes()` — see `:47-70`):

```rust
#[test]
fn device_tabs_preserve_the_union_record_order() {
    // The client's workspace restore rebuilds its tab strip from
    // device.tabs IN ORDER (restoreMachineWorkspace -> buildRecoveryPlan),
    // so the inventory must never re-order the union's records. The union
    // owns the strip-order fix; this pins the inventory's pass-through.
    // Two tab records in the union's record array, in a non-alphabetical
    // order: k2 first, k1 second (union_doc_with_tab_key builds one-record
    // docs, so build the two-record doc with json! directly, mirroring
    // union_doc's shape).
    let doc = json!({
        "deviceId": "dev",
        "deviceLabel": "Dev",
        "capturedAt": 1000,
        "snapshotRevision": 1,
        "records": [
            {
                "tabKey": "k2", "tabId": "k2", "tabName": "Second", "status": "open",
                "revision": 10, "updatedAt": 10, "createdAt": 10,
                "titleSetByUser": false, "paneCount": 1,
                "panes": [{ "paneId": "p-late", "kind": "editor",
                            "payload": { "filePath": "/tmp/late.md" } }]
            },
            {
                "tabKey": "k1", "tabId": "k1", "tabName": "First", "status": "open",
                "revision": 10, "updatedAt": 10, "createdAt": 10,
                "titleSetByUser": false, "paneCount": 1,
                "panes": [{ "paneId": "p-early", "kind": "editor",
                            "payload": { "filePath": "/tmp/early.md" } }]
            }
        ]
    });
    let union = DeviceUnion { device_id: "dev".to_string(), union_doc: doc };
    let out = build_inventory(vec![union], vec![], no_live(), &no_evidence(), &no_closes());
    let keys: Vec<&str> = out["device"]["tabs"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|t| t["tabKey"].as_str())
        .collect();
    assert_eq!(keys, vec!["k2", "k1"]);
}
```

GREEN is required at first run — if this test is red, `build_inventory` re-orders somewhere the explorers missed: STOP and investigate before touching production code, and record the finding.

- [ ] **Step 2: Run the focused test**

Run: `cargo test -p freshell-server --lib recovery_inventory`

Expected: PASS (the new test plus every existing one).

- [ ] **Step 3: Refactor while green**

None — test-only addition.

- [ ] **Step 4: Run impacted-test verification**

Run: `cargo test -p freshell-server --lib recovery_inventory && cargo fmt --all --check && cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings`

Expected: PASS.

- [ ] **Step 5: Commit the task**

```bash
git add crates/freshell-server/src/recovery_inventory_tests.rs
git commit -m "test(recovery-inventory): pin device.tabs to the union record order"
```

### Task 4: Client contract pins — restore consumes inventory order verbatim (green pins)

**Files:**
- Test: `test/unit/client/lib/machine-workspace.test.ts` (add one test)
- Test: `test/unit/client/lib/recovery/build-recovery-plan.test.ts` (add one test)

**Interfaces:**
- Consumes: `restoreMachineWorkspace` (src/lib/machine-workspace.ts:47), `buildRecoveryPlan` (src/lib/recovery/build-recovery-plan.ts:304).
- Produces: none (tests only; the client behavior is already order-preserving — these pins make sure no future client-side re-sort can reintroduce the regression silently).

- [ ] **Step 1: Add the machine-workspace order test**

In `test/unit/client/lib/machine-workspace.test.ts`, extend `inventoryFor`'s usage with a two-tab variant inside a new `it` (reuse the existing `pane()`-style shape — the file builds `tabs` inline in `inventoryFor`; add a `tabs` override):

```typescript
  it('restores the workspace tabs in the inventory device.tabs order', async () => {
    const store = createStore()
    addForeignWorkspace(store)
    const base = inventoryFor(MACHINE_ID)
    const pane = base.device!.tabs[0].panes[0]
    const mkTab = (key: string, name: string) => ({
      tabKey: key, tabName: name, panes: [{ ...pane, paneId: `${key}-pane` }],
    })
    vi.mocked(getRecoveryInventory).mockResolvedValue({
      ...base,
      device: {
        ...base.device!,
        // Deliberately NOT tabKey/alphabetical order.
        tabs: [mkTab(`${MACHINE_ID}:tab-mango`, 'Mango'), mkTab(`${MACHINE_ID}:tab-apple`, 'Apple')],
      },
    })

    await restoreMachineWorkspace(store, MACHINE_ID)

    expect(store.getState().tabs.tabs.map((tab) => tab.title)).toEqual(['Mango', 'Apple'])
  })
```

- [ ] **Step 2: Add the build-recovery-plan order test**

In `test/unit/client/lib/recovery/build-recovery-plan.test.ts` (uses the existing `pane`/`inv` helpers; `inv` builds a single-tab device — add a multi-tab `it` that constructs the device's `tabs` directly):

```typescript
  it('produces one plan per device tab, in the inventory device.tabs order', () => {
    const p = () => pane()
    const inventory = {
      recoverable: true, contentId: 'cid',
      device: {
        deviceId: 'd', deviceLabel: 'l', capturedAt: 1,
        tabs: [
          { tabKey: 'd:tab-mango', tabName: 'Mango', panes: [p()] },
          { tabKey: 'd:tab-apple', tabName: 'Apple', panes: [p()] },
          { tabKey: 'd:tab-zebra', tabName: 'Zebra', panes: [p()] },
        ],
      },
      otherDevices: [], ledgerOnly: [],
    } as RecoveryInventory
    const plans = buildRecoveryPlan(inventory)
    expect(plans.map((plan) => plan.title)).toEqual(['Mango', 'Apple', 'Zebra'])
  })
```

- [ ] **Step 3: Run the focused tests (both green contract pins)**

Run: `npm run test:vitest -- run test/unit/client/lib/machine-workspace.test.ts test/unit/client/lib/recovery/build-recovery-plan.test.ts`

Expected: PASS — both files, all tests (these pins pass at base by design: the client bug was the server-fed order; they lock the client's order-preservation contract). If either is red, the client re-sorts somewhere and that is a finding to investigate, not a test to loosen.

- [ ] **Step 4: Refactor while green**

None.

- [ ] **Step 5: Run impacted-test verification**

The touched test files are self-contained client unit suites; run them together (the Step 3 command) plus lint on the touched files:

```bash
npm run test:vitest -- run test/unit/client/lib/machine-workspace.test.ts test/unit/client/lib/recovery/build-recovery-plan.test.ts
npx eslint test/unit/client/lib/machine-workspace.test.ts test/unit/client/lib/recovery/build-recovery-plan.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the task**

```bash
git add test/unit/client/lib/machine-workspace.test.ts test/unit/client/lib/recovery/build-recovery-plan.test.ts
git commit -m "test(client): pin machine-workspace restore and recovery-plan tab order"
```

## Verification summary (whole plan)

- RED evidence: Task 1 e2e fails at base with the tabKey-sorted strip; Task 2's two new union tests and one flipped pin fail for the missing order-preservation.
- GREEN evidence: all focused suites, the e2e, fmt/clippy, and the client pins pass; the end-of-execution full-suite gate (`npm test`, coordinated) passes at final HEAD.
- The user-visible contract: after a restart/refresh that triggers a restore, the strip order is the pre-restart order.
