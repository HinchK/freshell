# Amplifier Integration Fixes Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Fix freshell's Amplifier integration: stamp the user's active bundle into new session stubs, detach the Rust server from the login shell, stop the idle reaper from killing busy-but-quiet agent terminals, and ship a one-time backfill script that heals existing sessions.

**Architecture:** Four independent fixes on one branch. (1) A new best-effort YAML settings resolver in `freshell-sessions` feeds a `bundle` key into the stub `metadata.json` written by `ensure_session`. (2) `scripts/launch-rust.sh` gains `setsid` detachment plus an optional systemd user unit. (3) The `freshell-terminal` idle reaper gains a closed-list agent-mode exemption. (4) A standalone `tsx` script backfills `bundle` into existing freshell-created sessions with hard live-session safety rails.

**Tech Stack:** Rust (cargo workspace: `freshell-sessions`, `freshell-terminal`, `freshell-ws`, `freshell-server`), `saphyr` 0.0.11 (new YAML dep — `serde_yaml` is archived; `saphyr` is the actively maintained pure-Rust successor, last release 2026-07), bash (`scripts/launch-rust.sh`), systemd user unit, TypeScript via `tsx` + the `yaml` npm package, Vitest 3.

**Scope check:** The four items are independent subsystems, but each is small (one focused change + tests) and the spec mandates a single branch with a shared theme (Amplifier integration integrity). They are kept as separate task groups below; each group produces working, independently testable software, and Task 12 verifies the whole branch.

## Global Constraints

Copied from the spec — every task's requirements implicitly include these:

- **Worktree root (all work happens here):** `/home/dan/code/freshell/.worktrees/amplifier-integration-fixes` — branch `fix/amplifier-integration-fixes`. All commands below assume this as cwd unless stated.
- **Bundle stamp value:** bare name (e.g. `"foundation"`), **NOT** `"bundle:"`-prefixed. Stamp the string verbatim (trimmed) from settings.
- **Resolution semantics (must mirror Amplifier's merged settings precedence, later wins):** (1) `~/.amplifier/settings.yaml`, (2) `<resolved working dir>/.amplifier/settings.yaml`, (3) `<resolved working dir>/.amplifier/settings.local.yaml` — where `<resolved working dir>` is the stub's canonical working dir (`resolved` in `ensure_session`), NOT the server process cwd. Key path: `bundle.active`.
- **HARD SAFETY RULE (adversarial review):** stamp ONLY when the value is a plain non-empty YAML string scalar; on ANY surprise — an existing-but-unreadable file, unparseable YAML, non-string value, empty string — OMIT the bundle key entirely and never fail or delay stub creation. A missing stamp is healed by Amplifier's default; a WRONG stamp is trusted forever — asymmetric risk, bias hard toward omission.
- **Item 4 live-session safety:** skip a session if a running process matches `amplifier.*<session_id>` (ps check) OR the session dir's `events.jsonl` mtime is within the last 10 minutes. Atomic writes (temp file + rename), preserve all other metadata keys and formatting. `--dry-run` is the default; `--apply` writes. **Run `--dry-run` only; NEVER run `--apply`** (the user runs apply themselves). Summary must print scanned / eligible / skipped-live / updated counts.
- **Item 2:** `setsid` (detach from launching session) is the first-class mechanism; the systemd user unit is ADDITIONAL and optional (document that WSL2 systemd requirement — do not make systemd the only path).
- **Item 3:** minimal change consistent with the reaper's existing design. (Investigation is settled: the reaper at `crates/freshell-terminal/src/registry.rs:847-892` has NO child-liveness or mode exemption — only running/detached/threshold checks — and `crates/freshell-ws/tests/pane_reconcile.rs:759` proves agent-mode terminals are reaped today. The bug is real; behavior change is warranted, not speculative.)
- **Repo rules (AGENTS.md):** Red-Green-Refactor TDD; NEVER restart or stop the live self-hosted Rust server on port 3002 (manual verification uses port **3499**); no broad `pkill`; broad test runs go through the coordinator — use only the scoped commands given in each task; NodeNext ESM: relative TS imports carry `.js` extensions; every new Cargo dependency carries a justifying comment; no PR creation without explicit user approval.
- **Docs:** README.md is the only end-user markdown doc — this plan and code/unit-file comments are working docs. Server lifecycle behavior changes are documented in `AGENTS.md` §"Rust Server (Self-Hosted Production)" (the repo's server-lifecycle home) and in script/unit-file headers, not new markdown files.
- **Environment note:** this worktree has no `node_modules/`. Any task running TS tooling must first run `[ -d node_modules ] || npm install` (Task 3 Step 1 does this). Rust release builds are slow — allow 10+ minutes for `cargo build --release`.

---

## File Structure

```
crates/freshell-sessions/
  Cargo.toml                      MODIFY  add saphyr dependency (with justification comment)
  src/lib.rs                      MODIFY  register `pub mod bundle_config;`
  src/bundle_config.rs            CREATE  bundle.active resolver + unit tests (Task 1)
  src/amplifier_stub.rs           MODIFY  stamp bundle in ensure_session; doc comment; tests (Task 2)
crates/freshell-ws/tests/
  amplifier_launcher_identity.rs  MODIFY  flip NO-bundle assertion -> stamped-bundle assertion (Task 3)
  pane_reconcile.rs               MODIFY  reaper-integration updates (Task 8)
test/integration/real/
  amplifier-stub-adoption-contract.test.ts  MODIFY  mirror stub shape + adoption assertion (Task 4)
scripts/
  launch-rust.sh                  MODIFY  setsid detach + pid sanity check + header doc (Task 5)
  amplifier-backfill-bundle.ts    CREATE  one-time backfill script (Task 9)
installers/systemd/
  freshell-rust.service           CREATE  optional systemd user unit (Task 6)
AGENTS.md                         MODIFY  document detach behavior + systemd option (Task 6)
crates/freshell-terminal/
  src/registry.rs                 MODIFY  agent-mode idle-reap exemption + unit tests (Task 7)
test/unit/scripts/
  amplifier-backfill-bundle.test.ts  CREATE  backfill unit tests (Task 9)
package.json                      MODIFY  add `yaml` devDependency (Task 9)
```

Responsibilities: `bundle_config.rs` owns settings resolution (nothing else reads YAML); `amplifier_stub.rs` owns stub shape; `registry.rs` owns reap policy; the backfill script is standalone (imports nothing from `server/`; its resolver intentionally duplicates the Rust semantics because the two runtimes share no code — keep the two implementations' tests mirrored).

---

### Task 1: Bundle settings resolver (`bundle_config.rs`)

**Files:**
- Modify: `crates/freshell-sessions/Cargo.toml` (dependencies section, after the `chrono` entry at line 18)
- Modify: `crates/freshell-sessions/src/lib.rs:17-29` (module list)
- Create: `crates/freshell-sessions/src/bundle_config.rs`
- Test: same file (in-module `#[cfg(test)] mod tests`, crate convention)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `pub fn resolve_active_bundle(amplifier_home: &Path, working_dir: &Path) -> Option<String>` in module `freshell_sessions::bundle_config` — returns the bare bundle name or `None`. Never panics, never returns `Err`. Task 2 calls it as `crate::bundle_config::resolve_active_bundle(amplifier_home, &resolved)`.

- [ ] **Step 1: Add the saphyr dependency**

In `crates/freshell-sessions/Cargo.toml`, `[dependencies]`, insert after the `chrono = { workspace = true }` line (line 18):

```toml
# ITEM-1 bundle stamping (`bundle_config.rs`): read amplifier's settings.yaml
# `bundle.active` when pre-writing session stubs. saphyr is the maintained
# pure-Rust YAML 1.2 successor to the archived serde_yaml (release 2026-07;
# yaml-rust2's successor project). default-features off: we only need
# untyped `Yaml` access to one nested string key, no serde.
saphyr = { version = "0.0.11", default-features = false }
```

- [ ] **Step 2: Create the module with failing tests (stub implementation)**

In `crates/freshell-sessions/src/lib.rs`, add to the alphabetical module list (between `pub mod amplifier_stub;` line 18 and `pub mod codex_locator;` line 19):

```rust
pub mod bundle_config;
```

Create `crates/freshell-sessions/src/bundle_config.rs` with the doc header, a stub function, and the FULL test suite:

```rust
//! Best-effort resolution of the user's active Amplifier bundle
//! (`bundle.active`) from Amplifier's merged settings files.
//!
//! Mirrors the Amplifier CLI's merged-settings precedence (later wins):
//!   1. `<amplifier_home>/settings.yaml`                 (global, ~/.amplifier)
//!   2. `<working_dir>/.amplifier/settings.yaml`         (project)
//!   3. `<working_dir>/.amplifier/settings.local.yaml`   (project-local)
//!
//! HARD SAFETY RULE (adversarial review): return a value ONLY when it is a
//! plain non-empty YAML string scalar. On ANY surprise — an existing but
//! unreadable settings file, unparseable YAML, a `bundle.active` that is
//! present but not a plain non-empty string — return `None` for the WHOLE
//! resolution (not just that layer). A missing stamp is healed by
//! Amplifier's own default resolution; a WRONG stamp would be trusted
//! forever, so the risk is asymmetric and we bias hard toward omission.
//! Never fails or delays the caller: every error collapses to `None`.
//!
//! The TS twin lives in `scripts/amplifier-backfill-bundle.ts`
//! (`resolveActiveBundle`) — the two runtimes share no code, so keep the
//! semantics and their test matrices mirrored.

use std::path::Path;

/// Resolve the user's active Amplifier bundle for a session created under
/// `working_dir`. `amplifier_home` is the global settings root the caller
/// already resolved (`~/.amplifier` in production, a temp dir in tests).
/// Returns the bare bundle name (e.g. `"foundation"`) or `None` when
/// nothing resolves safely.
pub fn resolve_active_bundle(_amplifier_home: &Path, _working_dir: &Path) -> Option<String> {
    None // stub — Step 4 implements
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn unique_temp_dir(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "amp-bundle-{label}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, contents: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    #[test]
    fn resolves_from_global_settings_only() {
        let home = unique_temp_dir("global-only-home");
        let cwd = unique_temp_dir("global-only-cwd");
        write(&home.join("settings.yaml"), "bundle:\n  active: foundation\n");

        assert_eq!(
            resolve_active_bundle(&home, &cwd),
            Some("foundation".to_string())
        );
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn project_settings_override_global() {
        let home = unique_temp_dir("proj-wins-home");
        let cwd = unique_temp_dir("proj-wins-cwd");
        write(&home.join("settings.yaml"), "bundle:\n  active: foundation\n");
        write(
            &cwd.join(".amplifier").join("settings.yaml"),
            "bundle:\n  active: project-bundle\n",
        );

        assert_eq!(
            resolve_active_bundle(&home, &cwd),
            Some("project-bundle".to_string())
        );
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn local_settings_override_project_and_global() {
        let home = unique_temp_dir("local-wins-home");
        let cwd = unique_temp_dir("local-wins-cwd");
        write(&home.join("settings.yaml"), "bundle:\n  active: foundation\n");
        write(
            &cwd.join(".amplifier").join("settings.yaml"),
            "bundle:\n  active: project-bundle\n",
        );
        write(
            &cwd.join(".amplifier").join("settings.local.yaml"),
            "bundle:\n  active: local-bundle\n",
        );

        assert_eq!(
            resolve_active_bundle(&home, &cwd),
            Some("local-bundle".to_string())
        );
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn missing_files_resolve_to_none() {
        let home = unique_temp_dir("missing-home");
        let cwd = unique_temp_dir("missing-cwd");
        // No settings file at any layer -> nothing to stamp.
        assert_eq!(resolve_active_bundle(&home, &cwd), None);
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn garbage_yaml_in_any_existing_layer_poisons_the_whole_resolution() {
        // A valid global answer must NOT survive a later broken layer: we
        // can no longer faithfully mirror what Amplifier's own merge would
        // do, so the HARD SAFETY RULE says omit entirely.
        let home = unique_temp_dir("garbage-home");
        let cwd = unique_temp_dir("garbage-cwd");
        write(&home.join("settings.yaml"), "bundle:\n  active: foundation\n");
        write(
            &cwd.join(".amplifier").join("settings.local.yaml"),
            "bundle: [unclosed",
        );

        assert_eq!(resolve_active_bundle(&home, &cwd), None);
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn non_string_bundle_active_poisons_the_whole_resolution() {
        let home = unique_temp_dir("nonstring-home");
        let cwd = unique_temp_dir("nonstring-cwd");
        write(&home.join("settings.yaml"), "bundle:\n  active: foundation\n");
        write(
            &cwd.join(".amplifier").join("settings.yaml"),
            "bundle:\n  active: true\n",
        );

        assert_eq!(resolve_active_bundle(&home, &cwd), None);
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn empty_string_bundle_active_poisons_the_whole_resolution() {
        let home = unique_temp_dir("empty-home");
        let cwd = unique_temp_dir("empty-cwd");
        write(&home.join("settings.yaml"), "bundle:\n  active: \"\"\n");

        assert_eq!(resolve_active_bundle(&home, &cwd), None);
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn layer_without_the_key_does_not_clear_an_earlier_winner() {
        // A later settings file that simply has no bundle.active is normal
        // layering (it contributes nothing) — NOT a surprise.
        let home = unique_temp_dir("nokey-home");
        let cwd = unique_temp_dir("nokey-cwd");
        write(&home.join("settings.yaml"), "bundle:\n  active: foundation\n");
        write(
            &cwd.join(".amplifier").join("settings.yaml"),
            "ui:\n  theme: dark\n",
        );

        assert_eq!(
            resolve_active_bundle(&home, &cwd),
            Some("foundation".to_string())
        );
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn scalar_bundle_key_contributes_nothing() {
        // `bundle: foundation` (scalar, not a mapping) has no `active` key
        // path — Amplifier's own `bundle.active` lookup would find nothing
        // either, so this layer contributes nothing (it is not a surprise).
        let home = unique_temp_dir("scalar-home");
        let cwd = unique_temp_dir("scalar-cwd");
        write(&home.join("settings.yaml"), "bundle: foundation\n");

        assert_eq!(resolve_active_bundle(&home, &cwd), None);
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&cwd);
    }
}
```

- [ ] **Step 3: Run tests to verify the red state**

Run: `cargo test -p freshell-sessions bundle_config`
Expected: compiles; **4 FAIL** (`resolves_from_global_settings_only`, `project_settings_override_global`, `local_settings_override_project_and_global`, `layer_without_the_key_does_not_clear_an_earlier_winner` — the stub returns `None`), 5 pass.

- [ ] **Step 4: Implement the resolver**

Replace the stub `resolve_active_bundle` in `crates/freshell-sessions/src/bundle_config.rs` with:

```rust
use saphyr::{LoadableYamlNode, Yaml};

/// One settings layer's contribution to `bundle.active`.
enum Layer {
    /// File absent — the layer contributes nothing (normal).
    Absent,
    /// File present and parseable, but no `bundle.active` string reachable
    /// (missing key, empty doc, non-mapping doc/bundle) — no contribution.
    NoKey,
    /// A plain non-empty string scalar (trimmed).
    Value(String),
    /// Anything suspicious: existing-but-unreadable file, unparseable YAML,
    /// or `bundle.active` present but not a plain non-empty string.
    /// Poisons the WHOLE resolution (HARD SAFETY RULE).
    Surprise,
}

fn read_layer(path: &Path) -> Layer {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Layer::Absent,
        Err(_) => return Layer::Surprise,
    };
    let docs = match Yaml::load_from_str(&raw) {
        Ok(docs) => docs,
        Err(_) => return Layer::Surprise,
    };
    let Some(doc) = docs.first() else {
        return Layer::NoKey; // empty file — nothing to contribute
    };
    let Some(bundle) = doc.as_mapping_get("bundle") else {
        return Layer::NoKey; // no `bundle` key (or doc is not a mapping)
    };
    let Some(active) = bundle.as_mapping_get("active") else {
        return Layer::NoKey; // `bundle` has no `active` (or is not a mapping)
    };
    match active.as_str() {
        Some(s) if !s.trim().is_empty() => Layer::Value(s.trim().to_string()),
        // Present but empty, or a non-string scalar / sequence / mapping.
        _ => Layer::Surprise,
    }
}

/// Resolve the user's active Amplifier bundle for a session created under
/// `working_dir`. `amplifier_home` is the global settings root the caller
/// already resolved (`~/.amplifier` in production, a temp dir in tests).
/// Returns the bare bundle name (e.g. `"foundation"`) or `None` when
/// nothing resolves safely.
pub fn resolve_active_bundle(amplifier_home: &Path, working_dir: &Path) -> Option<String> {
    let layers = [
        amplifier_home.join("settings.yaml"),
        working_dir.join(".amplifier").join("settings.yaml"),
        working_dir.join(".amplifier").join("settings.local.yaml"),
    ];
    let mut winner: Option<String> = None;
    for path in &layers {
        match read_layer(path) {
            Layer::Absent | Layer::NoKey => {}
            Layer::Value(v) => winner = Some(v),
            Layer::Surprise => return None,
        }
    }
    winner
}
```

(Keep the module doc header from Step 2; delete the stub. Contingency: if `as_mapping_get` does not exist under this exact name in the pinned saphyr 0.0.11, check `docs.rs/saphyr/0.0.11` for the mapping accessor — it is the non-panicking counterpart of the `Index` impl, which PANICS on missing keys and must not be used.)

- [ ] **Step 5: Run tests to verify green**

Run: `cargo test -p freshell-sessions bundle_config`
Expected: **9 passed, 0 failed**.

- [ ] **Step 6: Format and commit**

```bash
cargo fmt -p freshell-sessions
git add crates/freshell-sessions/Cargo.toml crates/freshell-sessions/src/lib.rs crates/freshell-sessions/src/bundle_config.rs Cargo.lock
git commit -m "feat(sessions): resolve amplifier bundle.active from merged settings (saphyr)"
```

---

### Task 2: Stamp the bundle into new session stubs

**Files:**
- Modify: `crates/freshell-sessions/src/amplifier_stub.rs:94-110` (doc comment), `:193-198` (metadata construction), `:524-560` region (contract test), plus two new tests in `mod tests`

**Interfaces:**
- Consumes: `crate::bundle_config::resolve_active_bundle(amplifier_home: &Path, working_dir: &Path) -> Option<String>` (Task 1).
- Produces: `ensure_session` (signature UNCHANGED: `pub fn ensure_session(amplifier_home: &Path, session_id: &str, cwd: &str, terminal_id: &str) -> std::io::Result<EnsuredSession>`) now writes `"bundle": "<bare-name>"` into new stubs' `metadata.json` when resolution succeeds; omits the key otherwise. Found/adopted dirs stay untouched (`created: false` path never writes — unchanged). Tasks 3, 4 rely on this on-disk shape.

- [ ] **Step 1: Turn the existing contract test red**

In `ensure_session_writes_the_designed_stub_shape` (`amplifier_stub.rs:524`), after `let canonical = std::fs::canonicalize(&cwd_dir).unwrap();` (line 528) and BEFORE the `ensure_session(...)` call, add:

```rust
        // ITEM-1: a configured global bundle must be stamped into the stub.
        std::fs::write(home.join("settings.yaml"), "bundle:\n  active: foundation\n").unwrap();
```

Replace lines 557-558:

```rust
        // Omit `bundle` so the user's default bundle resolves.
        assert!(meta.get("bundle").is_none());
```

with:

```rust
        // ITEM-1: stamp the user's configured bundle (bare name). The CLI's
        // resume path never consults settings.yaml — an unstamped stub runs
        // the CLI's hardcoded default bundle and then persists a
        // self-perpetuating "bundle": "unknown".
        assert_eq!(meta["bundle"], "foundation");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p freshell-sessions ensure_session_writes_the_designed_stub_shape`
Expected: FAIL — `meta["bundle"]` is `null`, not `"foundation"` (stamping not implemented yet).

- [ ] **Step 3: Implement stamping in `ensure_session`**

In `amplifier_stub.rs`, change the metadata construction at lines 193-198 from:

```rust
    let metadata = serde_json::json!({
        "session_id": session_id,
        "created": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "working_dir": resolved.to_string_lossy(),
        "freshell_terminal_id": terminal_id,
    });
```

to:

```rust
    let mut metadata = serde_json::json!({
        "session_id": session_id,
        "created": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "working_dir": resolved.to_string_lossy(),
        "freshell_terminal_id": terminal_id,
    });
    // ITEM-1: stamp the user's active bundle (bare name, e.g. "foundation").
    // The CLI's `resume` path never consults settings `bundle.active`; an
    // unstamped stub silently runs the CLI's hardcoded default bundle and
    // then persists a self-perpetuating "bundle": "unknown". Best-effort by
    // design: `resolve_active_bundle` collapses every surprise to `None`
    // (HARD SAFETY RULE — a wrong stamp is trusted forever, a missing one
    // is healed), so stub creation can never fail or slow down here.
    // `amplifier_home` doubles as the global settings root: callers pass
    // `resolve_amplifier_home()` = `$HOME/.amplifier` in production (with
    // the FRESHELL_AMPLIFIER_HOME test override), which is exactly where
    // the CLI reads its global settings.yaml.
    if let Some(bundle) = crate::bundle_config::resolve_active_bundle(amplifier_home, &resolved) {
        metadata["bundle"] = serde_json::Value::String(bundle);
    }
```

- [ ] **Step 4: Update the `ensure_session` doc comment**

In the doc comment at `amplifier_stub.rs:103-110`, replace the stub-shape sentence (the one ending with "nothing keys off it), NO `bundle`; plus empty `transcript.jsonl` and empty") so the passage reads:

```rust
/// Stub shape (validated against the real CLI; see the Tier-1 contract
/// test): `metadata.json` with `session_id`, `created` (ISO-8601 UTC),
/// `working_dir` (canonical cwd), custom `freshell_terminal_id` (best-effort
/// durable-linkage bonus — validation observed a real turn's save REWRITE
/// metadata.json and add `*.backup` files, so the field may not survive use;
/// Freshell's own registry stays primary and nothing keys off it), plus a
/// best-effort `bundle` (bare name from the user's merged settings
/// `bundle.active` — see [`crate::bundle_config::resolve_active_bundle`];
/// stamped because the CLI's resume path never consults settings and would
/// otherwise run its hardcoded default bundle and persist a
/// self-perpetuating `"bundle": "unknown"`; omitted entirely when nothing
/// resolves safely); plus empty `transcript.jsonl` and empty
/// `events.jsonl` (the latter so the activity hub's create-time resolver
/// attach finds a file — see the module design note).
```

- [ ] **Step 5: Add the omission-path regression tests**

Append to `mod tests` in `amplifier_stub.rs` (after `ensure_session_rejects_ids_that_are_not_a_single_path_segment`):

```rust
    #[test]
    fn ensure_session_omits_bundle_when_no_settings_resolve() {
        // No settings file at any layer -> no stamp. Amplifier's own
        // default-bundle resolution heals a missing key; only a WRONG key
        // is unrecoverable (HARD SAFETY RULE).
        let home = unique_temp_home("no-bundle");
        let cwd_dir = home.join("workdir");
        std::fs::create_dir_all(&cwd_dir).unwrap();

        let ensured = ensure_session(
            &home,
            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            cwd_dir.to_str().unwrap(),
            "term-nb",
        )
        .unwrap();
        assert!(ensured.created);
        let meta: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(ensured.session_dir.join("metadata.json")).unwrap(),
        )
        .unwrap();
        assert!(meta.get("bundle").is_none());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn ensure_session_still_creates_stub_when_settings_are_garbage() {
        // Surprise settings must degrade to omission — NEVER fail or delay
        // stub creation.
        let home = unique_temp_home("garbage-bundle");
        let cwd_dir = home.join("workdir");
        std::fs::create_dir_all(&cwd_dir).unwrap();
        std::fs::write(home.join("settings.yaml"), "bundle: [unclosed").unwrap();

        let ensured = ensure_session(
            &home,
            "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
            cwd_dir.to_str().unwrap(),
            "term-gb",
        )
        .unwrap();
        assert!(
            ensured.created,
            "stub creation must never fail because settings were unreadable"
        );
        let meta: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(ensured.session_dir.join("metadata.json")).unwrap(),
        )
        .unwrap();
        assert!(meta.get("bundle").is_none());
        let _ = std::fs::remove_dir_all(&home);
    }
```

- [ ] **Step 6: Run the crate tests to verify green**

Run: `cargo test -p freshell-sessions`
Expected: all pass, including `ensure_session_writes_the_designed_stub_shape`, the two new tests, and the untouched adoption/GC tests (`ensure_session_finds_an_existing_dir_under_any_slug_and_does_not_touch_it`, `stub_is_unused_recognizes_only_the_never_used_signature`, `gc_stub_if_unused_deletes_only_unused_dirs` — stamping does not touch the found path, and GC keys only off `turn_count`).

- [ ] **Step 7: Commit**

```bash
cargo fmt -p freshell-sessions
git add crates/freshell-sessions/src/amplifier_stub.rs
git commit -m "feat(sessions): stamp user's active bundle into new amplifier session stubs"
```

---

### Task 3: Flip the freshell-ws integration contract (end-to-end stamp proof)

**Files:**
- Modify: `crates/freshell-ws/tests/amplifier_launcher_identity.rs:20-108` (the `fresh_amplifier_create_carries_launcher_assigned_session_ref_and_stub` test)

**Interfaces:**
- Consumes: Task 2's on-disk stub shape; the test harness `isolate_amplifier_home() -> PathBuf` (`crates/freshell-ws/tests/common/mod.rs:29-40` — OnceLock-memoized shared temp home per test binary, sets `FRESHELL_AMPLIFIER_HOME`).
- Produces: nothing new — a wire-level (REAL axum + REAL WS client) proof that `terminal.create {mode:"amplifier"}` produces a bundle-stamped stub.

- [ ] **Step 1: Install node modules (needed later in Task 4/9; harmless now)**

Run: `[ -d node_modules ] || npm install`
Expected: completes without error (skip if already present).

- [ ] **Step 2: Update the test — write settings, flip the assertion**

In `crates/freshell-ws/tests/amplifier_launcher_identity.rs`, after line 25 (`let amp_home = isolate_amplifier_home();`), add:

```rust
    // ITEM-1: the launcher must stamp the user's configured bundle into the
    // stub. NOTE: `isolate_amplifier_home()` is OnceLock-memoized — this
    // settings.yaml is visible to every test in this binary. That is safe:
    // no other test asserts on the bundle key, and a surprise partial read
    // degrades to omission by design.
    std::fs::write(
        amp_home.join("settings.yaml"),
        "bundle:\n  active: foundation\n",
    )
    .expect("write isolated settings.yaml");
```

Replace lines 102-105:

```rust
    assert!(
        meta.get("bundle").is_none(),
        "stub metadata must have NO bundle key so the user's default bundle resolves"
    );
```

with:

```rust
    assert_eq!(
        meta["bundle"], "foundation",
        "stub metadata must stamp the user's configured bundle (bare name): \
         the CLI's resume path never consults settings.yaml and would \
         otherwise run its hardcoded default bundle, got: {meta}"
    );
```

- [ ] **Step 3: Run the integration test**

Run: `cargo test -p freshell-ws --test amplifier_launcher_identity`
Expected: PASS (all tests in the file). If `fresh_amplifier_create_...` fails with `meta["bundle"]` = null, Task 2's wiring is broken — stop and fix there. (Scope note: run ONLY this test binary; the full `freshell-ws` suite has known pre-existing failures unrelated to this work.)

- [ ] **Step 4: Commit**

```bash
git add crates/freshell-ws/tests/amplifier_launcher_identity.rs
git commit -m "test(ws): amplifier stub contract now asserts stamped bundle end-to-end"
```

---

### Task 4: Mirror the new stub shape in the TS real-CLI contract test

**Files:**
- Modify: `test/integration/real/amplifier-stub-adoption-contract.test.ts:94-109` (the `writeStub` helper) and `:228-233` (adoption assertions)

**Interfaces:**
- Consumes: Task 2's stub shape (the stamped variant).
- Produces: the Tier-1 real-CLI contract now also validates that the Amplifier CLI adopts a bundle-stamped stub and leaves the key intact on zero-turn adoption.

- [ ] **Step 1: Update the stub-shape mirror**

In `writeStub` (lines 94-109), change the metadata literal (lines 100-105) from:

```ts
  await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify({
    session_id: sessionId,
    created: new Date().toISOString(),
    working_dir: resolvedCwd,
    freshell_terminal_id: 'contract-test-terminal',
  }))
```

to:

```ts
  await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify({
    session_id: sessionId,
    created: new Date().toISOString(),
    working_dir: resolvedCwd,
    freshell_terminal_id: 'contract-test-terminal',
    // ITEM-1: the Rust broker stamps the user's `bundle.active` (bare name)
    // when it resolves; this mirror models the stamped (common) variant.
    // When nothing resolves, the broker omits the key entirely.
    bundle: 'foundation',
  }))
```

Also update the helper's lead comment (line 94) from `// The exact stub shape the Rust broker writes (plan Global Constraints).` to:

```ts
// The exact stub shape the Rust broker writes (amplifier_stub.rs:193-198 +
// the ITEM-1 bundle stamp) — keep hand-mirrored with the Rust json! literal.
```

- [ ] **Step 2: Assert the CLI preserves the stamp on adoption**

In the first test (`adopts a broker-shaped pre-created stub under the cwd slug`), after line 231 (`expect(meta.freshell_terminal_id).toBe('contract-test-terminal')`), add:

```ts
      // ITEM-1: zero-turn adoption must leave the stamped bundle intact —
      // this is the key the CLI's resume path will trust.
      expect(meta.bundle).toBe('foundation')
```

- [ ] **Step 3: Run the file (skip-gated) to prove it still parses and skips cleanly**

Run: `npm run test:vitest -- run test/integration/real/amplifier-stub-adoption-contract.test.ts --config config/vitest/vitest.server.config.ts`
Expected: file loads and tests report **skipped** (this environment does not set `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1`); no compile/parse errors. Do NOT set the opt-in env var — the real-CLI run needs network + a real amplifier binary and is the user's call.

- [ ] **Step 4: Commit**

```bash
git add test/integration/real/amplifier-stub-adoption-contract.test.ts
git commit -m "test(contract): mirror bundle-stamped stub shape in real-CLI adoption test"
```

---

### Task 5: Detach freshell-server from the launching shell (`setsid`)

**Files:**
- Modify: `scripts/launch-rust.sh:160` (the launch line), `:164-175` (ready block — add a pid sanity check), `:1-24` (header docs)

Context (settled by investigation): `scripts/launch-rust.sh` is the canonical launcher (AGENTS.md §Rust Server); line 160 launches with `nohup "$BINARY" &`, which keeps the server in the login shell's session/process group. nohup's SIG_IGN is defeated because the server installs its own SIGHUP handler (`crates/freshell-server/src/main.rs:1447-1519` treats SIGHUP like SIGTERM; acknowledged in `docs/plans/2026-07-26-rust-wsl-crash-hardening.md:3428-3432`). So host-shell death delivers HUP/TERM cascades — the `shutdown_forensics` events — killing every child agent PTY. The fix is session detachment at launch; the server's signal handling stays UNCHANGED (graceful shutdown on a *deliberate* SIGTERM remains correct). `run-rust-server.sh` (repo root) is a deliberately-foreground legacy variant — leave it untouched.

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: a detached server process (own session, no controlling TTY); pid-file behavior unchanged (`~/.freshell/rust-server-<port>.pid`); `--stop`/`--restart` continue to work.

- [ ] **Step 1: Replace the launch line**

In `scripts/launch-rust.sh`, replace line 160:

```bash
PORT="$PORT" nohup "$BINARY" >> "$LOG_FILE" 2>&1 &
```

with:

```bash
# Detach into a NEW SESSION (setsid): the server gets its own session +
# process group and no controlling terminal, so the death of the launching
# shell (or its WSL2 relay) can no longer deliver the SIGHUP/SIGTERM
# cascades that killed the server and every child agent PTY at once
# (shutdown_forensics events in ~/.freshell/logs/rust-server.jsonl).
# nohup was useless here: the server installs its own SIGHUP handler, which
# replaces nohup's inherited SIG_IGN (docs/plans/2026-07-26-rust-wsl-crash-
# hardening.md A13/V5). stdin comes from /dev/null so no tty fd ties us to
# the console. setsid exec's WITHOUT forking here (a background job in a
# non-interactive script is not a process-group leader), so $! below is the
# server's real pid.
PORT="$PORT" setsid "$BINARY" < /dev/null >> "$LOG_FILE" 2>&1 &
```

- [ ] **Step 2: Add a pid sanity check to the ready block**

Inside the health-check success branch, immediately after the `echo "freshell-server is ready! (pid $SERVER_PID, port $PORT)"` line (line 168), add:

```bash
    if ! is_our_server_pid "$SERVER_PID"; then
      echo "WARNING: $PID_FILE may be stale — setsid forked unexpectedly;" >&2
      echo "         --stop/--restart may not find the server. Inspect with:" >&2
      echo "         ps -eo pid,sid,args | grep freshell-server" >&2
    fi
```

- [ ] **Step 3: Document in the script header**

In the header comment block (after the `--stop` usage line, line 16), add:

```bash
#
# DETACHMENT: the server is started in its own session (setsid, stdin from
# /dev/null). Closing the shell/console that ran this script does NOT stop
# the server or its child terminals. Stop it with:
#   scripts/launch-rust.sh --stop [--port N]
# Optional alternative for WSL2 with systemd enabled: see
# installers/systemd/freshell-rust.service.
```

- [ ] **Step 4: Verify detachment on a scratch port (NEVER port 3002)**

```bash
bash -n scripts/launch-rust.sh          # syntax check — expected: silent, exit 0
cargo build --release -p freshell-server   # allow 10+ minutes
AUTH_TOKEN=detach-test scripts/launch-rust.sh --skip-build --port 3499
```

Expected: `freshell-server is ready! (pid <PID>, port 3499)` and NO stale-pid warning.
Contingency: if the server exits during startup because `dist/client` is missing, build it once (`npm run build:client` — Task 3 Step 1 installed node_modules) or copy the main checkout's build: `cp -r /home/dan/code/freshell/dist ./dist`; then relaunch.

Then verify the session/TTY facts:

```bash
PID=$(cat ~/.freshell/rust-server-3499.pid)
ps -o pid=,sid=,pgid=,tty= -p "$PID"
```

Expected: `sid` equals `$PID` (session leader) and `tty` is `?` (no controlling terminal). That is the mechanical proof host-shell death cannot HUP/TERM-cascade into it.

```bash
curl -fsS http://127.0.0.1:3499/api/health && echo OK   # expected: OK
AUTH_TOKEN=detach-test scripts/launch-rust.sh --stop --port 3499
```

Expected: `Stopping freshell-server pid <PID> (port 3499)...` and clean exit (graceful SIGTERM path still works — that is the deliberate-stop contract).

- [ ] **Step 5: Commit**

```bash
git add scripts/launch-rust.sh
git commit -m "fix(scripts): detach freshell-server into its own session (setsid) so shell death cannot cascade-kill agent terminals"
```

---

### Task 6: Optional systemd user unit + lifecycle docs

**Files:**
- Create: `installers/systemd/freshell-rust.service`
- Modify: `AGENTS.md` (§"Rust Server (Self-Hosted Production)", lines 66-88 — append two bullets at the end of the section)

**Interfaces:**
- Consumes: the release binary path convention (`target/release/freshell-server`, loads `.env` from cwd) from Task 5's context.
- Produces: an install-by-hand user unit; no code consumes it (the existing `installers/systemd/freshell.service.template` + `electron/daemon/systemd.ts` pair is the NODE server's — untouched).

- [ ] **Step 1: Create the unit file**

Create `installers/systemd/freshell-rust.service`:

```ini
# Optional systemd USER unit for the self-hosted Rust freshell-server.
#
# This is an ALTERNATIVE to scripts/launch-rust.sh (which detaches via
# setsid and needs no systemd). Use this if you want supervised restarts.
#
# WSL2 REQUIREMENT: systemd must be enabled — /etc/wsl.conf:
#   [boot]
#   systemd=true
# then restart the distro (`wsl --shutdown` from Windows). Without systemd,
# use scripts/launch-rust.sh; do NOT install this unit.
#
# Install:
#   1. Build once:  cargo build --release -p freshell-server
#   2. mkdir -p ~/.config/systemd/user
#   3. cp installers/systemd/freshell-rust.service ~/.config/systemd/user/
#   4. EDIT WorkingDirectory/ExecStart below to your checkout path.
#      AUTH_TOKEN is read from WorkingDirectory/.env by the server itself.
#   5. systemctl --user daemon-reload
#   6. systemctl --user enable --now freshell-rust
#   7. Recommended on WSL2 (survive logout): loginctl enable-linger "$USER"
#
# Stop/status:
#   systemctl --user stop freshell-rust
#   systemctl --user status freshell-rust

[Unit]
Description=freshell Rust server (self-hosted)
After=network.target

[Service]
Type=simple
# EDIT: absolute path to your freshell checkout (the server loads .env and
# serves dist/client relative to its cwd).
WorkingDirectory=%h/code/freshell
ExecStart=%h/code/freshell/target/release/freshell-server
Environment=PORT=3002
# AUTH_TOKEN: the server reads it from WorkingDirectory/.env itself
# (main.rs:76-87). Alternatively make it explicit to systemd:
# EnvironmentFile=%h/code/freshell/.env
# REQUIRED EDIT: the claude sidecar resolves bare `node` via PATH
# (crates/freshell-freshagent/src/claude.rs:1372), and systemd user units
# get a minimal PATH that lacks nvm/fnm installs. Either extend PATH to a
# dir containing `node`, or point FRESHELL_CLAUDE_NODE at the binary:
Environment=PATH=/usr/local/bin:/usr/bin:/bin
# Environment=FRESHELL_CLAUDE_NODE=%h/.nvm/versions/node/v22.14.0/bin/node
# SINGLE lifecycle owner: when this unit is installed, systemd owns
# start/stop/restart on this port -- use `systemctl --user stop/restart
# freshell-rust`, NEVER scripts/launch-rust.sh on the same port (its
# pid-file stop and this Restart= policy would fight each other).
# Restart=on-failure does not resist a deliberate `systemctl --user stop`
# or a clean SIGTERM exit (exit 0).
Restart=on-failure
RestartSec=2
# Give the graceful-shutdown path (WS close 4009 + PTY teardown) time to run.
TimeoutStopSec=15

[Install]
WantedBy=default.target
```

- [ ] **Step 2: Best-effort unit lint**

Run: `systemd-analyze --user verify installers/systemd/freshell-rust.service 2>&1 | head -20 || true`
Expected: no syntax errors reported about THIS unit (warnings about unresolvable `%h` paths on this machine are acceptable; if systemd is unavailable in this environment, note that and move on — the file is documentation-installed, not code-consumed).

- [ ] **Step 3: Document the lifecycle change in AGENTS.md**

At the end of the "Rust Server (Self-Hosted Production)" section (after its last existing bullet/paragraph, before the next section heading), append:

```markdown
- **Detached launch:** `scripts/launch-rust.sh` starts the server in its own
  session (`setsid`, stdin from `/dev/null`). Closing the launching shell or
  WSL2 console does NOT stop the server or its child agent terminals (this
  fixed the SIGTERM/SIGHUP cascades visible as `shutdown_forensics` events).
  Stop it only via `scripts/launch-rust.sh --stop [--port N]`.
- **Optional systemd (WSL2 with systemd enabled):** install the user unit
  `installers/systemd/freshell-rust.service` (see its header for the
  `/etc/wsl.conf` requirement and `loginctl enable-linger`). systemd is NOT
  required — the setsid launcher is the default, dependency-free path.
```

- [ ] **Step 4: Commit**

```bash
git add installers/systemd/freshell-rust.service AGENTS.md
git commit -m "feat(installers): optional systemd user unit for the rust server; document detached lifecycle"
```

---

### Task 7: Exempt agent-mode terminals from the idle reaper (registry)

**Files:**
- Modify: `crates/freshell-terminal/src/registry.rs` — the `enforce_idle_kills` filter closure (lines 859-874) + its doc comment (lines 833-846), a new private helper, and new tests in `mod tests`

Context (settled by investigation): a terminal is idle-killed iff running + detached + `last_meaningful_activity_at` older than `autoKillIdleMinutes` (default 15). The meaningful-activity clock is fed ONLY by user input and non-noise PTY output — there is no child-process probe. So an agent that is mid-work but PTY-quiet (long LLM call, long tool run) or emitting only spinner repaints (deliberately classified as noise, DEV-0009) is killed. `s.mode` (`"shell" | "claude" | "codex" | "opencode" | "amplifier"`) is in scope in the filter closure; `status == Running` already encodes "the child is alive" (the row flips to Exited when the PTY child exits). The minimal change consistent with the design: a closed-list agent-mode exemption while Running. Unknown/future modes keep legacy reaping.

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `enforce_idle_kills` never returns agent-mode terminals; new private `fn is_agent_mode(mode: &str) -> bool` on `TerminalRegistry`. Task 8's integration tests rely on this behavior.

- [ ] **Step 1: Write the failing unit tests**

In `crates/freshell-terminal/src/registry.rs`, `#[cfg(test)] mod tests`, immediately after `enforce_idle_kills_reaps_detached_terminal_with_only_repaint_noise` (ends line 3903), add:

```rust
    #[test]
    fn enforce_idle_kills_spares_agent_mode_terminals_past_threshold() {
        // ITEM-3 (`terminal.killed by="idle"` forensics): agent CLIs are
        // legitimately PTY-silent far beyond any idle threshold while
        // mid-work (long LLM calls, long tool runs), and their spinner
        // repaints are deliberately noise-classified (DEV-0009). While the
        // child is alive (status == Running), PTY silence is NOT evidence
        // of idleness for these modes — never reap them.
        let reg = TerminalRegistry::new();
        reg.set_auto_kill_idle_minutes(5);
        for mode in ["claude", "codex", "opencode", "amplifier"] {
            let id = format!("T-{mode}");
            reg.register_headless(HeadlessTerminal {
                terminal_id: id.clone(),
                stream_id: format!("S-{mode}"),
                mode: mode.to_string(),
                resume_session_id: None,
                create_request_id: None,
                created_at: Some(now_ms()),
            });
            // 999 minutes stale vs a 5-minute threshold.
            reg.backdate_last_activity(&id, now_ms() - 999 * 60_000);
        }

        let killed = reg.enforce_idle_kills();

        assert!(
            killed.is_empty(),
            "agent-mode terminals with a live child must never be idle-reaped, got {killed:?}"
        );
        assert_eq!(reg.inventory().len(), 4);
    }

    #[test]
    fn enforce_idle_kills_mixed_sweep_reaps_only_the_shell() {
        // The exemption is a CLOSED list: plain shells (and unknown future
        // modes) keep the legacy reap behavior — the sweep still does its
        // resource-cleanup job.
        let reg = TerminalRegistry::new();
        reg.insert_headless("T-shell", "S-shell"); // fixture mode: "shell"
        reg.register_headless(HeadlessTerminal {
            terminal_id: "T-amp".to_string(),
            stream_id: "S-amp".to_string(),
            mode: "amplifier".to_string(),
            resume_session_id: None,
            create_request_id: None,
            created_at: Some(now_ms()),
        });
        reg.set_auto_kill_idle_minutes(5);
        reg.backdate_last_activity("T-shell", now_ms() - 6 * 60_000);
        reg.backdate_last_activity("T-amp", now_ms() - 6 * 60_000);

        let killed = reg.enforce_idle_kills();

        assert_eq!(killed, vec!["T-shell".to_string()]);
        assert_eq!(reg.inventory().len(), 1);
    }
```

- [ ] **Step 2: Run them to verify red**

Run: `cargo test -p freshell-terminal enforce_idle_kills`
Expected: the two NEW tests FAIL (agent terminals are currently killed); the six existing `enforce_idle_kills_*` tests pass.

- [ ] **Step 3: Implement the exemption**

In `registry.rs`, add a private helper directly ABOVE `pub fn enforce_idle_kills` (line 847):

```rust
    /// ITEM-3: agent-CLI terminals (long-running assistant sessions) are
    /// exempt from the idle-kill sweep while their child is alive
    /// (`status == Running` — the row flips to Exited when the PTY child
    /// dies, so Running IS the live-child signal). An agent mid-work can be
    /// PTY-silent far longer than any reasonable idle threshold (long LLM
    /// calls, long tool runs), and `terminal.killed by="idle"` forensics
    /// showed busy amplifier sessions being reaped. CLOSED list: unknown /
    /// future modes stay reapable (legacy resource-cleanup behavior).
    fn is_agent_mode(mode: &str) -> bool {
        matches!(mode, "claude" | "codex" | "opencode" | "amplifier")
    }
```

In the filter closure, after the subscribers check (lines 864-866), insert:

```rust
                    if Self::is_agent_mode(&s.mode) {
                        return None; // ITEM-3: live agent session — never idle-reap
                    }
```

And extend the `enforce_idle_kills` doc comment (after the sentence ending "...exempts the terminal regardless of idle time." at lines 838-839) with:

```rust
    /// Agent-mode terminals (see [`Self::is_agent_mode`]) are exempt while
    /// running — PTY silence is not idleness for an agent mid-work (ITEM-3).
```

- [ ] **Step 4: Run the reaper tests to verify green**

Run: `cargo test -p freshell-terminal enforce_idle_kills`
Expected: **all 8 pass** (6 existing + 2 new; the existing ones all use `insert_headless`, which seeds `mode: "shell"`, so they are unaffected).

- [ ] **Step 5: Run the whole crate**

Run: `cargo test -p freshell-terminal`
Expected: all pass. If the reconcile-section test using the in-crate `headless` helper (`registry.rs:4425`, hardcodes `mode: "claude"`) fails because it relied on reaping a claude terminal, inspect it: if it asserts an idle-reap of a claude terminal, convert its seeded mode or kill path exactly as Task 8 does for the ws twin, and record the change in the commit message (see Task 11).

- [ ] **Step 6: Commit**

```bash
cargo fmt -p freshell-terminal
git add crates/freshell-terminal/src/registry.rs
git commit -m "fix(terminal): exempt live agent-mode terminals from the idle reaper"
```

---

### Task 8: Reaper integration tests at the ws seam

**Files:**
- Modify: `crates/freshell-ws/tests/pane_reconcile.rs:750-816` (the existing idle-reap reconcile test) + one new test in the same file

**Interfaces:**
- Consumes: Task 7's exemption; the file-local helper `fn headless(server: &Server, id: &str, key: Option<&str>, mode: &str, created_at: i64)` (`pane_reconcile.rs:272-283`).
- Produces: integration pins for both sides of the new policy.

- [ ] **Step 1: Re-point the existing reconcile test at a reapable mode**

`idle_reaped_terminal_mid_reconcile_converges_to_respawn_not_attach` (line 760) exists to pin the reap x reconcile seam (a dead terminal mid-reconcile must converge to `respawn`), not reap policy. Under Task 7 its claude-mode seed is no longer reapable. Change the seed (lines 771-777) from:

```rust
    headless(
        &server,
        "T-reaped",
        Some("cr-reaped"),
        "claude",
        now_ms - 20 * 60_000,
    );
```

to:

```rust
    // ITEM-3: agent modes are now exempt from the idle sweep, so the
    // reap side of this seam is driven with a plain shell terminal; the
    // pane still re-presents as claude (verdict logic only consults disk
    // truth + liveness — the reaped row is gone either way).
    headless(
        &server,
        "T-reaped",
        Some("cr-reaped"),
        "shell",
        now_ms - 20 * 60_000,
    );
```

Also update the inline comment at lines 765-766 from `// A detached claude terminal whose meaningful-activity clock is 20 minutes` to `// A detached shell terminal whose meaningful-activity clock is 20 minutes`. Leave the doc comment (lines 752-758) unchanged — it is mode-neutral.

- [ ] **Step 2: Add the spared-agent integration test**

Append to `pane_reconcile.rs` (after line 816):

```rust
/// ITEM-3 regression pin: the idle sweep must NOT reap a detached
/// agent-mode terminal, however stale its meaningful-activity clock is —
/// agent CLIs are legitimately PTY-silent during long LLM calls and long
/// tool runs (`terminal.killed by="idle"` forensics).
#[tokio::test]
async fn idle_sweep_spares_detached_agent_terminals() {
    let probe = FlippingProbe::new(vec![freshell_ws::existence::SessionExistence::Present]);
    let server = spawn_server_with_probe(std::sync::Arc::new(probe), |_| {}).await;

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64;
    // 20 minutes stale vs the 15-minute default — reap-eligible by clock.
    headless(
        &server,
        "T-amp-busy",
        Some("cr-amp-busy"),
        "amplifier",
        now_ms - 20 * 60_000,
    );

    let killed = server.registry.enforce_idle_kills();

    assert!(
        killed.is_empty(),
        "a running agent-mode terminal must be spared, got {killed:?}"
    );
    assert!(server.registry.is_live("T-amp-busy"));
}
```

- [ ] **Step 3: Run the test binary**

Run: `cargo test -p freshell-ws --test pane_reconcile`
Expected: all pass, including the re-pointed reconcile test (respawn verdict unchanged) and the new spared-agent pin.

- [ ] **Step 4: Commit**

```bash
git add crates/freshell-ws/tests/pane_reconcile.rs
git commit -m "test(ws): pin idle-reaper agent exemption and re-point reap-reconcile seam at shell mode"
```

---

### Task 9: One-time backfill script (`amplifier-backfill-bundle.ts`)

**Files:**
- Modify: `package.json` (devDependencies — via `npm install`)
- Create: `scripts/amplifier-backfill-bundle.ts`
- Test: `test/unit/scripts/amplifier-backfill-bundle.test.ts`

**Interfaces:**
- Consumes: the resolution semantics of Task 1 (deliberately duplicated — no shared runtime with Rust; keep test matrices mirrored).
- Produces: exports `resolveActiveBundle(globalDir: string, workingDir: string | undefined): Promise<string | null>`, `detectIndent(raw: string): string | number`, `sessionLooksLive(sessionId: string, sessionDir: string, psOutput: string, nowMs: number): Promise<boolean>`, `backfillSession(metaPath: string, opts: { globalDir: string; apply: boolean; psOutput: string; nowMs: number }): Promise<SessionOutcome>`, `type SessionOutcome`, and `main(argv?: string[]): Promise<void>`. Task 10 runs `main` via `npx tsx` in dry-run mode.

- [ ] **Step 1: Add the yaml devDependency**

Run: `npm install --save-dev yaml@^2`
Expected: `package.json` devDependencies gains `"yaml": "^2..."`; lockfile updated. (`node_modules` exists from Task 3 Step 1.)

- [ ] **Step 2: Write the failing unit tests**

Create `test/unit/scripts/amplifier-backfill-bundle.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  resolveActiveBundle,
  detectIndent,
  sessionLooksLive,
  backfillSession,
} from '../../../scripts/amplifier-backfill-bundle.js'

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'amp-backfill-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function write(p: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, contents)
}

function dirs() {
  return { globalDir: path.join(root, 'home-amplifier'), workDir: path.join(root, 'work') }
}

describe('resolveActiveBundle (mirror of Rust bundle_config semantics)', () => {
  it('resolves from global settings only', async () => {
    const { globalDir, workDir } = dirs()
    await write(path.join(globalDir, 'settings.yaml'), 'bundle:\n  active: foundation\n')
    expect(await resolveActiveBundle(globalDir, workDir)).toBe('foundation')
  })

  it('later layers win: project then local override global', async () => {
    const { globalDir, workDir } = dirs()
    await write(path.join(globalDir, 'settings.yaml'), 'bundle:\n  active: foundation\n')
    await write(path.join(workDir, '.amplifier', 'settings.yaml'), 'bundle:\n  active: proj\n')
    expect(await resolveActiveBundle(globalDir, workDir)).toBe('proj')
    await write(
      path.join(workDir, '.amplifier', 'settings.local.yaml'),
      'bundle:\n  active: local\n',
    )
    expect(await resolveActiveBundle(globalDir, workDir)).toBe('local')
  })

  it('returns null when no files exist', async () => {
    const { globalDir, workDir } = dirs()
    expect(await resolveActiveBundle(globalDir, workDir)).toBeNull()
  })

  it('garbage YAML in any existing layer poisons the whole resolution', async () => {
    const { globalDir, workDir } = dirs()
    await write(path.join(globalDir, 'settings.yaml'), 'bundle:\n  active: foundation\n')
    await write(path.join(workDir, '.amplifier', 'settings.local.yaml'), 'bundle: [unclosed')
    expect(await resolveActiveBundle(globalDir, workDir)).toBeNull()
  })

  it('non-string or empty bundle.active poisons the whole resolution', async () => {
    const { globalDir, workDir } = dirs()
    await write(path.join(globalDir, 'settings.yaml'), 'bundle:\n  active: true\n')
    expect(await resolveActiveBundle(globalDir, workDir)).toBeNull()
    await write(path.join(globalDir, 'settings.yaml'), 'bundle:\n  active: ""\n')
    expect(await resolveActiveBundle(globalDir, workDir)).toBeNull()
  })

  it('a layer without the key does not clear an earlier winner', async () => {
    const { globalDir, workDir } = dirs()
    await write(path.join(globalDir, 'settings.yaml'), 'bundle:\n  active: foundation\n')
    await write(path.join(workDir, '.amplifier', 'settings.yaml'), 'ui:\n  theme: dark\n')
    expect(await resolveActiveBundle(globalDir, workDir)).toBe('foundation')
  })

  it('falls back to global-only when workingDir is undefined', async () => {
    const { globalDir } = dirs()
    await write(path.join(globalDir, 'settings.yaml'), 'bundle:\n  active: foundation\n')
    expect(await resolveActiveBundle(globalDir, undefined)).toBe('foundation')
  })
})

describe('detectIndent', () => {
  it('detects two-space, four-space, tab, and compact', () => {
    expect(detectIndent('{\n  "a": 1\n}')).toBe(2)
    expect(detectIndent('{\n    "a": 1\n}')).toBe(4)
    expect(detectIndent('{\n\t"a": 1\n}')).toBe('\t')
    expect(detectIndent('{"a":1}')).toBe(0)
  })
})

describe('sessionLooksLive', () => {
  it('flags a matching amplifier process', async () => {
    const sessionDir = path.join(root, 's1')
    await fs.mkdir(sessionDir, { recursive: true })
    const ps = '/usr/bin/python3 amplifier resume 123e4567-e89b-4000-8000-000000000001\n'
    expect(
      await sessionLooksLive('123e4567-e89b-4000-8000-000000000001', sessionDir, ps, Date.now()),
    ).toBe(true)
  })

  it('flags a recently-written events.jsonl and clears an old one', async () => {
    const sessionDir = path.join(root, 's2')
    await write(path.join(sessionDir, 'events.jsonl'), '')
    const now = Date.now()
    expect(await sessionLooksLive('deadbeef', sessionDir, '', now)).toBe(true) // just written
    expect(await sessionLooksLive('deadbeef', sessionDir, '', now + 11 * 60_000)).toBe(false)
  })
})

describe('backfillSession', () => {
  function sessionFixture(meta: Record<string, unknown>, indent = 2) {
    const sessionDir = path.join(
      root,
      'projects',
      '-w',
      'sessions',
      '123e4567-e89b-4000-8000-00000000000a',
    )
    const metaPath = path.join(sessionDir, 'metadata.json')
    return { sessionDir, metaPath, raw: JSON.stringify(meta, null, indent) + '\n' }
  }

  it('updates an eligible session, preserving other keys, order, indent', async () => {
    const { globalDir, workDir } = dirs()
    await write(path.join(globalDir, 'settings.yaml'), 'bundle:\n  active: foundation\n')
    const { metaPath, raw } = sessionFixture({
      session_id: '123e4567-e89b-4000-8000-00000000000a',
      created: '2026-01-01T00:00:00.000Z',
      working_dir: workDir,
      freshell_terminal_id: 'term-x',
    })
    await write(metaPath, raw)

    const outcome = await backfillSession(metaPath, {
      globalDir,
      apply: true,
      psOutput: '',
      nowMs: Date.now() + 11 * 60_000,
    })
    expect(outcome).toBe('updated')
    const after = await fs.readFile(metaPath, 'utf8')
    const parsed = JSON.parse(after)
    expect(parsed.bundle).toBe('foundation')
    expect(parsed.freshell_terminal_id).toBe('term-x')
    expect(Object.keys(parsed)).toEqual([
      'session_id',
      'created',
      'working_dir',
      'freshell_terminal_id',
      'bundle',
    ])
    expect(after).toMatch(/\n {2}"session_id"/) // 2-space indent preserved
    expect(after.endsWith('\n')).toBe(true)
  })

  it('replaces bundle "unknown" in place', async () => {
    const { globalDir, workDir } = dirs()
    await write(path.join(globalDir, 'settings.yaml'), 'bundle:\n  active: foundation\n')
    const { metaPath, raw } = sessionFixture({
      session_id: 'x',
      bundle: 'unknown',
      working_dir: workDir,
      freshell_terminal_id: 'term-x',
    })
    await write(metaPath, raw)
    const outcome = await backfillSession(metaPath, {
      globalDir,
      apply: true,
      psOutput: '',
      nowMs: Date.now() + 11 * 60_000,
    })
    expect(outcome).toBe('updated')
    const parsed = JSON.parse(await fs.readFile(metaPath, 'utf8'))
    expect(parsed.bundle).toBe('foundation')
    expect(Object.keys(parsed)).toEqual([
      'session_id',
      'bundle',
      'working_dir',
      'freshell_terminal_id',
    ]) // position preserved
  })

  it('is ineligible without freshell_terminal_id or with a real bundle', async () => {
    const { globalDir, workDir } = dirs()
    await write(path.join(globalDir, 'settings.yaml'), 'bundle:\n  active: foundation\n')
    const a = sessionFixture({ session_id: 'x', working_dir: workDir })
    await write(a.metaPath, a.raw)
    expect(
      await backfillSession(a.metaPath, {
        globalDir,
        apply: true,
        psOutput: '',
        nowMs: Date.now(),
      }),
    ).toBe('ineligible')

    const b = sessionFixture({
      session_id: 'x',
      working_dir: workDir,
      freshell_terminal_id: 't',
      bundle: 'foundation',
    })
    await write(b.metaPath, b.raw)
    expect(
      await backfillSession(b.metaPath, {
        globalDir,
        apply: true,
        psOutput: '',
        nowMs: Date.now(),
      }),
    ).toBe('ineligible')
  })

  it('skips live sessions and leaves the file untouched', async () => {
    const { globalDir, workDir } = dirs()
    await write(path.join(globalDir, 'settings.yaml'), 'bundle:\n  active: foundation\n')
    const { metaPath, raw } = sessionFixture({
      session_id: 'x',
      working_dir: workDir,
      freshell_terminal_id: 't',
    })
    await write(metaPath, raw)
    const ps = 'amplifier resume 123e4567-e89b-4000-8000-00000000000a\n'
    expect(
      await backfillSession(metaPath, {
        globalDir,
        apply: true,
        psOutput: ps,
        nowMs: Date.now() + 11 * 60_000,
      }),
    ).toBe('skipped-live')
    expect(await fs.readFile(metaPath, 'utf8')).toBe(raw)
  })

  it('skips when nothing resolves; dry-run never writes', async () => {
    const { globalDir, workDir } = dirs()
    const { metaPath, raw } = sessionFixture({
      session_id: 'x',
      working_dir: workDir,
      freshell_terminal_id: 't',
    })
    await write(metaPath, raw)
    expect(
      await backfillSession(metaPath, {
        globalDir,
        apply: true,
        psOutput: '',
        nowMs: Date.now() + 11 * 60_000,
      }),
    ).toBe('skipped-unresolved')

    await write(path.join(globalDir, 'settings.yaml'), 'bundle:\n  active: foundation\n')
    expect(
      await backfillSession(metaPath, {
        globalDir,
        apply: false,
        psOutput: '',
        nowMs: Date.now() + 11 * 60_000,
      }),
    ).toBe('would-update')
    expect(await fs.readFile(metaPath, 'utf8')).toBe(raw) // untouched
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:vitest -- run test/unit/scripts/amplifier-backfill-bundle.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — cannot resolve import `../../../scripts/amplifier-backfill-bundle.js` (script does not exist yet).

- [ ] **Step 4: Write the script**

Create `scripts/amplifier-backfill-bundle.ts`:

```ts
/**
 * One-time backfill: stamp the user's active Amplifier bundle into
 * freshell-created Amplifier session stubs whose metadata has no "bundle"
 * key, or the self-perpetuating "bundle": "unknown" the CLI persists.
 *
 * Why: freshell pre-writes session stubs without a bundle key and launches
 * panes via `amplifier resume <uuid>`; the CLI's resume path never consults
 * settings.yaml `bundle.active`, so those sessions silently run the wrong
 * bundle forever. New stubs are stamped at creation
 * (crates/freshell-sessions/src/bundle_config.rs — keep semantics + test
 * matrices mirrored with this file's resolveActiveBundle); this script
 * heals the existing corpus once.
 *
 * Run with: npx tsx scripts/amplifier-backfill-bundle.ts            # dry run (default)
 *           npx tsx scripts/amplifier-backfill-bundle.ts --apply    # write changes
 *
 * Safety:
 *  - only sessions with "freshell_terminal_id" (freshell-created) AND
 *    bundle missing-or-"unknown" are touched;
 *  - SKIPS possibly-live sessions: a running `amplifier ... <session_id>`
 *    process, or events.jsonl modified within the last 10 minutes;
 *  - resolution mirrors Amplifier's merged-settings precedence (later
 *    wins): ~/.amplifier/settings.yaml, <working_dir>/.amplifier/
 *    settings.yaml, <working_dir>/.amplifier/settings.local.yaml — a
 *    session is stamped ONLY with a plain non-empty string; ANY surprise
 *    (garbage YAML in an existing file, non-string, empty) skips it;
 *  - atomic write (temp file + rename), preserving key order + indentation.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import YAML from 'yaml'

const execFileP = promisify(execFile)

export type SessionOutcome =
  | 'ineligible'
  | 'skipped-live'
  | 'skipped-unresolved'
  | 'updated'
  | 'would-update'

/** Mirror of Rust `bundle_config::resolve_active_bundle` — see file header. */
export async function resolveActiveBundle(
  globalDir: string,
  workingDir: string | undefined,
): Promise<string | null> {
  const layers = [path.join(globalDir, 'settings.yaml')]
  if (workingDir) {
    layers.push(path.join(workingDir, '.amplifier', 'settings.yaml'))
    layers.push(path.join(workingDir, '.amplifier', 'settings.local.yaml'))
  }
  let winner: string | null = null
  for (const file of layers) {
    let raw: string
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue // layer absent — normal
      return null // existing-but-unreadable — surprise, omit
    }
    let doc: unknown
    try {
      doc = YAML.parse(raw)
    } catch {
      return null // unparseable YAML — surprise, omit (poisons the whole resolution)
    }
    if (doc === null || typeof doc !== 'object') continue // empty/scalar doc — no contribution
    const bundle = (doc as Record<string, unknown>).bundle
    if (bundle === null || bundle === undefined || typeof bundle !== 'object') continue
    if (!('active' in (bundle as Record<string, unknown>))) continue
    const active = (bundle as Record<string, unknown>).active
    if (typeof active !== 'string' || active.trim() === '') return null // surprise, omit
    winner = active.trim()
  }
  return winner
}

/** Best-effort JSON indent sniff so the rewrite matches the original file. */
export function detectIndent(raw: string): string | number {
  if (/\n\t"/.test(raw)) return '\t'
  const m = raw.match(/\n( +)"/)
  return m ? m[1].length : 0
}

/** A session is live if an amplifier process references its id, or its
 *  events.jsonl was written within the last 10 minutes. */
export async function sessionLooksLive(
  sessionId: string,
  sessionDir: string,
  psOutput: string,
  nowMs: number,
): Promise<boolean> {
  if (new RegExp(`amplifier.*${sessionId}`).test(psOutput)) return true
  try {
    const st = await fs.stat(path.join(sessionDir, 'events.jsonl'))
    if (nowMs - st.mtimeMs < 10 * 60_000) return true
  } catch {
    // no events.jsonl — cannot be live via recency
  }
  return false
}

export async function backfillSession(
  metaPath: string,
  opts: { globalDir: string; apply: boolean; psOutput: string; nowMs: number },
): Promise<SessionOutcome> {
  let raw: string
  try {
    raw = await fs.readFile(metaPath, 'utf8')
  } catch {
    return 'ineligible'
  }
  let meta: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'ineligible'
    meta = parsed as Record<string, unknown>
  } catch {
    return 'ineligible' // unparseable metadata — never touch
  }
  if (typeof meta.freshell_terminal_id !== 'string') return 'ineligible' // not freshell-created
  if (meta.bundle !== undefined && meta.bundle !== 'unknown') return 'ineligible'

  const sessionDir = path.dirname(metaPath)
  const sessionId = path.basename(sessionDir)
  if (await sessionLooksLive(sessionId, sessionDir, opts.psOutput, opts.nowMs)) {
    return 'skipped-live'
  }

  const workingDir = typeof meta.working_dir === 'string' ? meta.working_dir : undefined
  const bundle = await resolveActiveBundle(opts.globalDir, workingDir)
  if (bundle === null) return 'skipped-unresolved'

  meta.bundle = bundle // JS objects keep insertion order — an existing "unknown" keeps its slot
  const out = JSON.stringify(meta, null, detectIndent(raw)) + (raw.endsWith('\n') ? '\n' : '')
  if (!opts.apply) return 'would-update'
  const tmp = path.join(sessionDir, `.metadata.json.backfill-${process.pid}.tmp`)
  await fs.writeFile(tmp, out)
  await fs.rename(tmp, metaPath) // atomic on the same filesystem
  return 'updated'
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const apply = argv.includes('--apply')
  const unknown = argv.filter((a) => !['--apply', '--dry-run'].includes(a))
  if (unknown.length > 0) {
    console.error(
      'Usage: npx tsx scripts/amplifier-backfill-bundle.ts [--dry-run (default) | --apply]',
    )
    process.exit(1)
  }

  const globalDir = path.join(os.homedir(), '.amplifier')
  const projectsDir = path.join(globalDir, 'projects')

  let psOutput = ''
  try {
    psOutput = (await execFileP('ps', ['-eo', 'args='])).stdout
  } catch {
    console.error('WARNING: ps failed; process-based live detection disabled for this run.')
  }
  const nowMs = Date.now()

  const counts = { scanned: 0, eligible: 0, skippedLive: 0, skippedUnresolved: 0, updated: 0 }
  let projects: string[] = []
  try {
    projects = await fs.readdir(projectsDir)
  } catch {
    console.log(`No projects dir at ${projectsDir} — nothing to do.`)
  }
  for (const project of projects) {
    const sessionsDir = path.join(projectsDir, project, 'sessions')
    let sessions: string[] = []
    try {
      sessions = await fs.readdir(sessionsDir)
    } catch {
      continue
    }
    for (const session of sessions) {
      const metaPath = path.join(sessionsDir, session, 'metadata.json')
      try {
        await fs.access(metaPath)
      } catch {
        continue
      }
      counts.scanned += 1
      const outcome = await backfillSession(metaPath, { globalDir, apply, psOutput, nowMs })
      if (outcome === 'ineligible') continue
      counts.eligible += 1
      if (outcome === 'skipped-live') counts.skippedLive += 1
      else if (outcome === 'skipped-unresolved') counts.skippedUnresolved += 1
      else {
        counts.updated += 1
        console.log(`${apply ? 'updated' : 'would update'}: ${metaPath}`)
      }
    }
  }

  console.log(
    `${apply ? 'APPLY' : 'DRY RUN'} summary: scanned=${counts.scanned}` +
      ` eligible=${counts.eligible} skipped-live=${counts.skippedLive}` +
      ` skipped-unresolved=${counts.skippedUnresolved} updated=${counts.updated}`,
  )
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
```

- [ ] **Step 5: Run the unit tests to verify green**

Run: `npm run test:vitest -- run test/unit/scripts/amplifier-backfill-bundle.test.ts --config config/vitest/vitest.config.ts`
Expected: **all pass** (7 resolve tests, 1 indent, 2 liveness, 5 backfill).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json scripts/amplifier-backfill-bundle.ts test/unit/scripts/amplifier-backfill-bundle.test.ts
git commit -m "feat(scripts): one-time amplifier bundle backfill (dry-run default, live-session guards)"
```

---

### Task 10: Run the backfill dry-run (evidence for the final report)

**Files:** none modified.

**Interfaces:**
- Consumes: Task 9's `main` via `npx tsx`.
- Produces: the dry-run summary line for the final report / PR description.

- [ ] **Step 1: Dry-run against the real home (read-only by construction)**

Run: `npx tsx scripts/amplifier-backfill-bundle.ts | tee /tmp/amplifier-backfill-dry-run.txt`
Expected: a list of `would update: ...` lines (possibly empty) followed by exactly one summary line of the form:
`DRY RUN summary: scanned=N eligible=N skipped-live=N skipped-unresolved=N updated=N`
(`updated` counts would-updates in dry-run mode). **NEVER pass `--apply`** — the user runs apply themselves.

- [ ] **Step 2: Confirm read-only behavior and record the output**

Run the dry-run a second time and confirm the counts are identical (a pure read is idempotent; any drift means something wrote — investigate before proceeding). Keep `/tmp/amplifier-backfill-dry-run.txt`; its summary line goes verbatim into the branch's final report / PR text. Do NOT commit the capture file (README rule: no new end-user docs; evidence lives in the report).

- [ ] **Step 3: Verify clean tree**

Run: `git status --short`
Expected: empty — this task produces evidence, not files.

---

### Task 11: (conditional) in-crate reconcile-helper sweep for Task 7 fallout

**Files:**
- Possibly modify: `crates/freshell-terminal/src/registry.rs` reconcile-section tests (the `headless` free-fn at line 4425 hardcodes `mode: "claude"`)

This task exists ONLY if Task 7 Step 5 found failures. If `cargo test -p freshell-terminal` was fully green in Task 7, check the boxes and move on.

- [ ] **Step 1: Re-run the crate suite**

Run: `cargo test -p freshell-terminal`
Expected: all pass. If any reconcile-section test fails because it relied on idle-reaping a claude-mode headless terminal, apply the same policy split as Task 8: reap-side seeds become `mode: "shell"` (or the kill is driven through the non-idle kill path), spared-agent behavior gets its own assertion. Keep changes minimal and comment each with `// ITEM-3`.

- [ ] **Step 2: Commit if changes were needed**

```bash
git add crates/freshell-terminal/src/registry.rs
git commit -m "test(terminal): align reconcile-section fixtures with agent idle-reap exemption"
```

---

### Task 12: Full verification sweep

**Files:** none new; fix-ups only if checks fail.

- [ ] **Step 1: Rust format + lints**

```bash
cargo fmt --all -- --check
cargo clippy -p freshell-sessions -p freshell-terminal --all-targets -- -D warnings
```

Expected: clean. (Mirror `.github/workflows/rust-clippy.yml` if its flags differ — check that file and use its exact invocation for the touched crates. `freshell-ws` has known pre-existing test debt: run `cargo clippy -p freshell-ws --tests 2>&1 | tail -20` and require only that NO NEW warnings mention the two test files this branch touched.)

- [ ] **Step 2: Rust tests (scoped to touched surfaces)**

```bash
cargo test -p freshell-sessions
cargo test -p freshell-terminal
cargo test -p freshell-ws --test amplifier_launcher_identity
cargo test -p freshell-ws --test pane_reconcile
```

Expected: all pass.

- [ ] **Step 3: TS tests (scoped)**

```bash
npm run test:vitest -- run test/unit/scripts/amplifier-backfill-bundle.test.ts --config config/vitest/vitest.config.ts
npm run test:vitest -- run test/integration/real/amplifier-stub-adoption-contract.test.ts --config config/vitest/vitest.server.config.ts
```

Expected: unit file all pass; real-contract file skips cleanly (env-gated).

- [ ] **Step 4: Script syntax re-check + branch review**

```bash
bash -n scripts/launch-rust.sh
git log --oneline main..HEAD
git status --short
```

Expected: syntax OK; 8-10 focused commits matching Tasks 1-11; clean tree.

- [ ] **Step 5: Commit any verification fix-ups**

```bash
git add -A && git commit -m "chore: verification sweep fix-ups" # only if Steps 1-4 required changes
```

---

## Self-Review (performed while writing this plan)

**1. Spec coverage.**
- ITEM 1: resolver (Task 1), stamping + doc comment + unit contract flip (Task 2), ws integration flip (Task 3), TS contract mirror (Task 4), resolution unit tests global/project/local/missing/garbage/non-string (Task 1 Step 2), YAML crate selection with maintenance rationale (Task 1 Step 1), GC/adoption verified untouched (Task 2 Step 6). Covered.
- ITEM 2: investigation findings inlined (launch path = `scripts/launch-rust.sh:160`; nohup defeated by the server's SIGHUP handler); setsid first-class (Task 5); optional systemd user unit with WSL2 requirement documented, not the only path (Task 6); lifecycle documented where the repo documents it (AGENTS.md + script header). Covered.
- ITEM 3: investigation settled (bug confirmed with file:line evidence — reproduced in Task 7's context block, so the spec's "document instead of change" branch does not apply); minimal mode-exemption consistent with existing design precedents (`mode != "shell"` gate at registry.rs:1299, `mode == "amplifier"` case at registry.rs:933); unit + integration tests in both directions (Tasks 7, 8, 11). Covered.
- ITEM 4: script matches every spec clause — scan path, eligibility (freshell_terminal_id + bundle missing/unknown), per-session working_dir resolution with global fallback, skip-if-unresolved, ps + 10-minute-mtime live guards, atomic write preserving keys/formatting, --dry-run default/--apply, summary counts; dry-run executed and captured (Task 10); --apply never run. Covered.
- Deliverables: all on branch `fix/amplifier-integration-fixes`, tests per repo conventions (cargo scoped + vitest scoped via the coordinator passthrough), dry-run output captured. No UNRESOLVED COVERAGE GAPS.

**1b. No silent deferrals.** The only test doubles are: headless terminals (the registry's designed test seam — the production reap policy itself is what's exercised), and the skip-gated real-CLI contract (the stamping outcome observable in production is proven for real on this branch by Task 3's real-server WS test writing a real stub to disk; the real-CLI adoption run additionally exists for the user's opt-in environment). Task 5's detachment is proven against the real binary on a real port (sid/tty evidence), not simulated. No stub stands in for required behavior without a real-outcome test on this branch.

**2. Placeholder scan.** No TBDs/TODOs. Two bounded contingencies remain deliberately: the saphyr accessor-name check (Task 1 Step 4 — names the exact doc source and the panic trap to avoid) and dist/client-missing at launch verification (Task 5 Step 4 — two exact recovery commands). Task 11 is explicitly conditional with an exact trigger. These are instructions, not deferrals.

**3. Type consistency.** `resolve_active_bundle(&Path, &Path) -> Option<String>` is defined in Task 1 and consumed with the same signature in Task 2. TS exports in Task 9's script match the Task 9 test imports one-to-one (`resolveActiveBundle`, `detectIndent`, `sessionLooksLive`, `backfillSession`, `SessionOutcome`, `main`). `is_agent_mode` is defined and called as `Self::is_agent_mode` within the same impl. The ws `headless(&Server, id, Option<&str>, mode, created_at)` signature matches the verified file-local helper at `pane_reconcile.rs:272-283`. Fixture calls (`insert_headless`, `backdate_last_activity`, `register_headless(HeadlessTerminal{..})`, `TerminalRegistry::new()`, `set_auto_kill_idle_minutes`, `inventory()`) match the verified existing test code verbatim.
