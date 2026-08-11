# Main-sync merge into `df1/integration` — merge b87c79c02

Origin/main advanced ~110 commits past the fork lineage while the campaign ran: the rust-port mainline landing (#633 + the `f1e377380` task sweep), opencode auto-titles (#637), remote status rings (#636), mobile context menu fix (#635), pty-captured-leak fix (#634). This document records why a merge (not a rebase), and how every conflict was resolved.

## Why merge, not rebase

- `--rebase-merges` was attempted and abort/reset: this branch's history embeds *main-sync merges* from its fork lineage (e.g. `6d613058f`, whose second parent `ab8d6ed46` is already inside new main). Replaying recreates each old sync against the mid-replay chain, re-litigating "old-main-vs-current-main" conflicts at every historical stop — degenerate, not careful.
- The branch was already pushed (`origin/df1/integration`); a merge preserves history without force-push.

## Conflict inventory (10 files) and resolutions

| File | Conflict | Resolution |
|---|---|---|
| `crates/freshell-freshagent/src/layout_store.rs` | add/add | **main's** (successor implementation; same feature lineage, evolved: split modules `layout_store_content`/`layout_tree`, richer API) |
| `crates/freshell-freshagent/src/layout_store_tests.rs` | add/add | **main's** (behavior split into `pane_ops_*_tests.rs` + this file) |
| `crates/freshell-freshagent/src/lib.rs` | content | **main's** (module map incl. `rename_persistence`, `pane_resize`, `target_resolver`) |
| `crates/freshell-freshagent/src/pane_ops.rs` | content | **main's** (REST route surface incl. resize + select + lifecycle routes) |
| `crates/freshell-freshagent/src/terminal_tabs.rs` | content | **main's** (evolved spawn pipeline) |
| `crates/freshell-server/src/session_directory.rs` | content ×4 | Union: main's Task-20 metadata read-join *plus* our SESSION-05 projectColors — production embed re-ported into the handler `Ok` arm verbatim (it sat inside the conflicted region and would otherwise have been dropped by the theirs-base), both SESSION-05 tests appended with `metadata:` added to their `SessionDirectoryState` literals |
| `crates/freshell-ws/src/tabs.rs` | content | main's extraction to `tabs_store_model` kept; our duplicated inline helpers dropped (identical semantics in the model); dead `touch_device` dropped (zero callers on main); `now_ms` kept as our HARNESS-14 clock-routed body on main's `pub(crate)` signature |
| `crates/freshell-ws/tests/ui_layout_sync.rs` | add/add | Rebuilt: main's self-contained harness + our 4 regression tests appended (`ingest_never_replies` — a pin only we had — `served_back_through_rest`, `last_write_wins_across_connections`, `updates_the_shared_layout_store`), `TestWs` renamed to `CommonTestWs` to avoid collision, accessors adapted (`state.layout`, `get_normalized_snapshot`) |
| `scripts/e2e-cloud.sh` | content ×4 | Union: our hardened blocks (gcloud PATH guard r1, dirty-tree always-rebuild r4, logs→latest-execution r1) + main's `--local-build`/`--account/--project-id/--region` plumbing; default cloud path uses Cloud Build with `--substitutions=_IMAGE=<base>:<content-tag>` so the r3 never-mutable-`:latest` pin holds in BOTH build paths; additionally hardened main's execution-ID parse (`|| true`) for `pipefail` |
| `test/e2e-browser/playwright.config.ts` | content ×2 | Union of both spec-registration lists (project-colors / harness-05/06 / create-dedupe / leak-metrics / layout-sync / cfg01 + main's title-sync / auto-title / settings-split / tabs-registry / automation-layout / git-badges) |

## Merge-induced follow-up fixes (found by compile, fixed pre-commit)

- `crates/freshell-ws/src/terminal.rs`: dropped our duplicate `ClientMessage::UiLayoutSync` match arm. Main's arm (`state.layout.update_from_ui`) sits at the same handler and matches first; ours was unreachable and referenced our removed `.layout_store()` accessor. Semantics identical (LWW replace, no reply, conn id as decimal string).
- `crates/freshell-ws/tests/common/mod.rs`: the 9 `WsState` literals needed main's new `layout`/`terminal_meta` fields (one literal lacked them — the merged remainder already had both).
- `crates/freshell-server/src/settings_store.rs`: one merged test literal gained `ai_key: AiKeyCell::default()` (main's new struct field).
- `scripts/test/cloud-run-wrapper.test.sh`: stub `gcloud` now captures `builds submit`; the "HEAD-addressed image published" and "dirty tree rebuilds" assertions accept either build path (local docker push OR Cloud Build substitution) — the content-addressed pin is unchanged.

## Auto-merge semantic audit (spot class beyond the conflicted set)

- `package.json` parses; script keys for both cloud paths present.
- All 9 HARNESS-14 clock-routing files intact; `tabs.rs` clock site restored by hand.
- `settings_store.rs` — both sides' extensions coexist (verified: our `projectColors` overlay + `firstChatExclusions` ×63, main's `completedMigrations` ×18 + Task-era `projectColors` defaulting + doc comments).
- `src/store/paneTitleSync.ts` deleted by main — zero remaining references post-merge.
- Remote-status-rings client surface (`tabsRegistrySelectors.ts`, `Sidebar.tsx`, `tab-registry-snapshot.ts`) auto-merged with our REGISTRY/sidebar items — validated by gates + targeted specs.

## Gate record

- `cargo test --workspace --no-run`: clean (0 errors) at the merge tip.
- `scripts/test/cloud-run-wrapper.test.sh`: 18/18 PASS, exit 0.
- Full post-merge gate (cargo full test, clippy `-D warnings`, fmt, npm test, typecheck, focused PW legs, significance sweep): see gate-agent report in the task log for `b87c79c02` (df1-postmerge); results appended below by the orchestrator once complete.

_…gate results to be appended…_
