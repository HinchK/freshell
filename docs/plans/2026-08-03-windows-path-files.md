# Windows-Path Handling in Rust Server File Endpoints Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Make the Rust freshell server's file endpoints (`validate-dir`, `complete`, `mkdir`) understand Windows-style paths (`C:\`, `D:\foo\bar`, `\\wsl.localhost\Ubuntu\…`) when the server runs in WSL, with suggestion/display paths rendered back in the user's input flavor — parity with the legacy Node server (`server/files-router.ts` + `server/path-utils.ts`).

**Architecture:** Reuse the already-ported conversion core in `crates/freshell-platform/src/path.rs` (`detect_user_path_flavor`, `win32_resolve`, `convert_windows_path_to_wsl_path`, `get_wsl_mount_prefix`). Add two small missing display helpers to freshell-platform (win32 display split + join — the Rust counterpart to Node's `path.win32.dirname/basename/join` usage in `files-router.ts`). Then add a single flavor-aware resolution seam in `crates/freshell-server/src/files.rs` (`resolve_user_path` → display path + native filesystem path) and route `validate_dir`, `complete`, and `mkdir` through it. POSIX/`~` inputs take the exact existing `normalize_user_path` code path — zero behavior change.

**Tech Stack:** Rust (workspace toolchain pinned 1.96.0), axum 0.8, serde_json, freshell-platform (in-workspace crate), tempfile (already a dev-dependency of both crates), tokio tests.

## Global Constraints

- Rust toolchain pinned **1.96.0** (`rust-version = "1.96"` in `[workspace.package]`); CI gate: `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings`. New code MUST be clippy-clean at every commit (watch for `dead_code` — never land an item in a commit where nothing outside `#[cfg(test)]` uses it).
- No new dependencies. `freshell-platform` is already a `[dependencies]` entry of `freshell-server`; `tempfile = "3"` is already a dev-dependency of both crates.
- **Scope guard:** touch ONLY `crates/freshell-server/src/files.rs`, `crates/freshell-platform/src/path.rs`, and `crates/freshell-platform/tests/path_tests.rs`. Do NOT change the Node server (`server/`), the client (`src/`), launch-cwd behavior (`resolve_launch_cwd`), or `crates/freshell-platform/src/lib.rs` (new helpers are imported via the public `freshell_platform::path::` module path — no re-export changes).
- **Do not change `normalize_user_path` in files.rs** (signature or behavior): `crates/freshell-server/src/repo_icon.rs:92` calls it, and POSIX/`~` regression safety depends on it. The new `resolve_user_path` is added *alongside* it.
- Existing JSON response shapes are hand-built `serde_json::json!` literals with camelCase string keys (`valid`, `resolvedPath`, `suggestions`, `path`, `isDirectory`, `created`, `existed`, `error`). Keep them byte-shape identical; do not introduce typed response structs.
- Commit convention: Conventional Commits with crate scope, lowercase imperative subject (e.g. `feat(server): …`), one focused commit per task. Committer identity MUST be `Dan Shapiro <3732858+danshapiro@users.noreply.github.com>`. Append the Amplifier trailers and record the verification run in the body (see commit steps).
- Rust tests are not CI-gated; local green is the only evidence. Run the listed cargo commands and record results in each commit body.
- `cargo clippy --workspace` may fail locally if GTK/WebKit libs for `freshell-tauri` are absent; scope clippy with `-p freshell-platform -p freshell-server` as the commands below do.
- Tests that mutate real process env (`std::env::set_var`) MUST serialize via the existing crate-wide test lock `crate::session_directory::HOME_ENV_TEST_LOCK` (`crates/freshell-server/src/session_directory.rs:463-464`, file-scope `#[cfg(test)] pub(crate) static Mutex<()>`) and restore prior values via RAII. Do NOT mint a files-local lock: freshell-server is a bin-only crate (all module tests share ONE bin test binary), and 11 existing tests (`session_directory.rs:1336-1516`, `main.rs:2460-2571`) already mutate `HOME`/`FRESHELL_HOME`/`USERPROFILE` under that lock — a second mutex would not serialize against them. Acquire poison-tolerantly: `.lock().unwrap_or_else(std::sync::PoisonError::into_inner)` (pattern: `main.rs:2460`). Bare `set_var` compiles fine here: workspace edition is 2021 (root `Cargo.toml:27`).
- Tests assume a Linux host (`host_os_live() == HostOs::Linux`); this matches the repo's dev/CI environment (WSL2) and the existing test suite's assumptions.

---

## Scope Check

Single subsystem (Rust server file endpoints + one helper pair in its platform crate). One plan.

**Boundary notes** (explicit, so nothing is silently deferred): spec requirement 4 says *any* sandbox check in files.rs must compare the converted native path — `read_file`/`stat_file`/`write_file` also call `is_path_allowed`, so Task 5 routes their sandbox target and filesystem access through the same seam (with Node's exact literal fallthrough for unaddressable inputs; their response shapes contain no paths, so nothing else changes). `validate_dir` today performs no sandbox check at all — load-bearing validation established this gap is NOT deliberate: Node applies `validatePath` to the route (`files-router.ts:232`, 403 pinned by `test/unit/server/files-router.test.ts:451-460`), and the gap's git history (`bda1c7315` enumerates sandboxed endpoints omitting validate-dir with no reason; `984294fe8` "close all 14 parity divergences" left it unchecked) records no intent. It is an unexplained Node-parity defect, so Task 5 closes it: `validate_dir` gains the same `is_path_allowed(resolved.sandbox_target(), …)` check as every other files.rs endpoint (zero behavior change for the default `allowed_file_paths: None`).

One documented divergence class (validated, deliberate): if a literal backslash-named entry (e.g. a directory named `C:\Users`) already exists under the server cwd — an artifact only the legacy Node hazard could create (`node-reference.md:734/:752`) — Node's validate-dir/complete would report it, while this port's unaddressable early-returns report `valid:false`/empty. Those artifacts are the hazard being removed, not directories to honor; the port stays fail-closed.

## File Structure

| File | Responsibility |
|---|---|
| `crates/freshell-platform/src/path.rs` (modify) | Add two pub display helpers: `split_windows_display_path` (win32 dirname/basename for absolute display paths) and `join_windows_display_path` (win32 join of a directory-entry name). Pure, deterministic, no env/IO. All conversion logic stays here — files.rs never reimplements it. |
| `crates/freshell-platform/tests/path_tests.rs` (modify) | Table-driven tests for the two new helpers, in the file's existing style. |
| `crates/freshell-server/src/files.rs` (modify) | Add `ResolvedUserPath` + `resolve_user_path` (flavor-aware display/native resolution seam, composing freshell-platform helpers). Rewrite the bodies of `validate_dir` (lines 132–157), `complete` (lines 282–355), `mkdir` (lines 371–411) to use it; re-point the `read_file` (159–198) / `stat_file` (200–235) / `write_file` (237–277) sandbox target + fs path through the same seam. Add test scaffolding (ENV_LOCK alias of the crate-wide `HOME_ENV_TEST_LOCK` + poison-tolerant `env_lock()`, EnvGuard, WslMountFixture, handler-call helpers) + new tests to the inline `#[cfg(test)] mod tests` (currently lines 575–704). |

Key pre-existing building blocks (verified signatures — do not re-derive):

```rust
// crates/freshell-platform — pub, reachable as shown:
freshell_platform::detect_user_path_flavor(input: &str) -> UserPathFlavor   // enum { Windows, Posix, Native }
freshell_platform::sanitize_user_path_input(input: &str) -> String
freshell_platform::path::win32_resolve(input: &str) -> Option<String>
    // Node path.win32.resolve port for ABSOLUTE inputs: separators -> `\`,
    // trailing separator stripped (drive root `C:\` kept), `..` collapsed,
    // drive-letter case PRESERVED as typed (`c:/foo` -> `c:\foo`).
    // Returns None for cwd-dependent inputs: `C:foo`, `\foo`, bare `C:`, relative.
    // UNC share root GAINS a trailing backslash: `\\srv\share` -> `\\srv\share\`.
freshell_platform::convert_windows_path_to_wsl_path(input: &str, env: &dyn Env, is_wsl_env: bool) -> Option<String>
    // `C:\Users` -> `/mnt/c/Users` (mount prefix from WSL_WINDOWS_SYS32, default `/mnt`).
    // NOTE: its drive branch works even when is_wsl_env == false — the CALLER must
    // gate on WSL-ness to match Node's resolveWindowsFlavorPath (path-utils.ts:208-215).
freshell_platform::path::get_wsl_mount_prefix(env: &dyn Env) -> String      // default "/mnt"
freshell_platform::detect::is_wsl_env_live() -> bool                        // Linux && truthy(WSL_DISTRO_NAME|WSL_INTEROP|WSLENV)
freshell_platform::RealEnv                                                  // impl Env over std::env
```

Behavioral reference (Node): `server/files-router.ts` complete :168–230, validate-dir :232–245, mkdir :247–280; `server/path-utils.ts` normalizeUserPath :54–73, resolveWindowsFlavorPath :208–215, isReachableDirectory :262–271.

---

### Task 1: freshell-platform windows display split/join helpers

**Files:**
- Modify: `crates/freshell-platform/src/path.rs` (append after `convert_windows_path_to_wsl_path`, which ends at line 420)
- Test: `crates/freshell-platform/tests/path_tests.rs`

**Interfaces:**
- Consumes: `win32_resolve` (private-module-internal reuse; already `pub` in `path.rs`).
- Produces (Tasks 3 depends on these exact signatures):
  - `pub fn split_windows_display_path(input: &str) -> Option<(String, String)>` — `(parent_display, leaf)`
  - `pub fn join_windows_display_path(parent: &str, name: &str) -> String`

- [ ] **Step 1: Write the failing tests**

Append to `crates/freshell-platform/tests/path_tests.rs` (extend the existing `use freshell_platform::path::{...}` import block at lines 6–10 with `split_windows_display_path, join_windows_display_path`):

```rust
// ===========================================================================
// Windows display split/join — the Rust counterpart of the files endpoints'
// `path.win32.dirname/basename/join` usage (files-router.ts:194-211).
// ===========================================================================

#[test]
fn split_windows_display_path_matrix() {
    let rows: &[(&str, Option<(&str, &str)>)] = &[
        ("C:\\Users\\dan", Some(("C:\\Users", "dan"))),
        // one level below the drive root: parent keeps the root backslash
        ("C:\\Us", Some(("C:\\", "Us"))),
        // drive root is its own parent with an empty leaf (win32.dirname("C:\\") == "C:\\")
        ("C:\\", Some(("C:\\", ""))),
        // forward slashes normalize to backslashes first
        ("C:/Users/dan", Some(("C:\\Users", "dan"))),
        // drive-letter case preserved as typed
        ("c:\\users", Some(("c:\\", "users"))),
        // trailing separator stripped by win32_resolve before splitting
        ("C:\\Users\\", Some(("C:\\", "Users"))),
        // UNC: share root keeps its trailing backslash (win32.dirname semantics)
        ("\\\\srv\\share\\dir", Some(("\\\\srv\\share\\", "dir"))),
        // deliberate deviation: Node win32.basename would give "share" here —
        // we return an empty leaf (endpoint-unreachable corner; see helper docs)
        ("\\\\srv\\share", Some(("\\\\srv\\share\\", ""))),
        // cwd-dependent inputs are not absolutely resolvable -> None
        ("C:foo", None),
        ("C:", None),
        ("\\foo", None),
        ("relative", None),
        ("", None),
    ];
    for (input, expected) in rows {
        let got = split_windows_display_path(input);
        let got_ref = got
            .as_ref()
            .map(|(parent, leaf)| (parent.as_str(), leaf.as_str()));
        assert_eq!(got_ref, *expected, "split_windows_display_path({input:?})");
    }
}

#[test]
fn join_windows_display_path_matrix() {
    let rows: &[(&str, &str, &str)] = &[
        // roots already end with the separator — no doubling (win32.join("C:\\","Users") == "C:\\Users")
        ("C:\\", "Users", "C:\\Users"),
        ("\\\\srv\\share\\", "dir", "\\\\srv\\share\\dir"),
        // deeper parents get a separator inserted
        ("C:\\Users", "dan", "C:\\Users\\dan"),
        // casing flows through untouched
        ("c:\\users", "dan", "c:\\users\\dan"),
    ];
    for (parent, name, expected) in rows {
        assert_eq!(
            join_windows_display_path(parent, name),
            *expected,
            "join_windows_display_path({parent:?}, {name:?})"
        );
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-platform --test path_tests split_windows -- --nocapture`
Expected: FAIL to compile — `cannot find function `split_windows_display_path``. (In Rust TDD the red step is a compile error; that counts as the expected failure.)

- [ ] **Step 3: Write the implementation**

Append to `crates/freshell-platform/src/path.rs`, directly after `convert_windows_path_to_wsl_path` (after line 420), before the `WslPathResolver` section:

```rust
// ===========================================================================
// §1.5 Windows display split/join — `path.win32.dirname/basename/join` as
// used by the files endpoints (`files-router.ts:194-211`). The files REST
// surface splits/joins the flavor-preserving DISPLAY path with win32
// semantics while doing filesystem access on the converted native path.
// ===========================================================================

/// `path.win32.dirname` + `path.win32.basename` in one step, for the
/// completion split (`files-router.ts:194-202`): resolve `input` to a
/// normalized absolute Windows display path, then split it into
/// `(parent display path, leaf)`.
///
/// Matches Node's win32 semantics for every shape `win32_resolve` produces,
/// with one deliberate share-root deviation (below):
/// - `C:\Users\dan`     -> (`C:\Users`, `dan`)
/// - `C:\Us`            -> (`C:\`, `Us`)   (parent keeps the root backslash)
/// - `C:\`              -> (`C:\`, ``)     (drive root is its own parent)
/// - `\\srv\share\dir`  -> (`\\srv\share\`, `dir`) (share root keeps `\`)
/// - `\\srv\share`      -> (`\\srv\share\`, ``)
///
/// Deviation (oracle-verified, Node v22): for a share ROOT itself, Node's
/// `win32.basename` returns the share name (`basename("\\srv\share\") ==
/// "share"`, `"Ubuntu"` for `\\wsl.localhost\Ubuntu\`) while `win32.dirname`
/// is the root itself. We return an EMPTY leaf instead, so callers list
/// rather than filter at a root. The corner is unreachable through the files
/// endpoints (addressable share roots stat as directories and skip the
/// split; unaddressable ones early-return first), so endpoint behavior is
/// Node-identical either way.
///
/// Returns `None` when the input is not absolutely resolvable (drive-relative
/// `C:foo`, rooted `\foo`, plain relative) — the same deterministic-core
/// boundary as [`win32_resolve`].
pub fn split_windows_display_path(input: &str) -> Option<(String, String)> {
    let normalized = win32_resolve(input)?;
    let root_len = windows_display_root_len(&normalized)?;
    if normalized.len() <= root_len {
        return Some((normalized, String::new()));
    }
    let tail = &normalized[root_len..];
    // `win32_resolve` output never has doubled separators, so `tail` never
    // starts with `\` and every found index splits parent/leaf cleanly.
    Some(match tail.rfind('\\') {
        Some(idx) => (
            normalized[..root_len + idx].to_string(),
            tail[idx + 1..].to_string(),
        ),
        None => (normalized[..root_len].to_string(), tail.to_string()),
    })
}

/// `path.win32.join(parent, name)` for the one shape the files endpoints
/// need (`files-router.ts:211`): append a single directory-entry name to an
/// absolute Windows display path. Roots (`C:\`, `\\srv\share\`) already end
/// with the separator; deeper parents need one inserted. Never doubles a
/// separator, never re-cases anything.
///
/// Oracle-verified equal to Node's `win32.join` for all well-behaved dirent
/// names (dots, spaces, embedded `\` mid-name). For pathological Linux names
/// that BEGIN with `\` or contain `\.`/`\..` segments, Node's join would
/// collapse/normalize where this concatenates verbatim — such names are
/// unrepresentable in a windows-flavor display path in BOTH servers, so the
/// divergence is cosmetic (`read_dir` never yields `.`/`..`).
pub fn join_windows_display_path(parent: &str, name: &str) -> String {
    if parent.ends_with('\\') {
        format!("{parent}{name}")
    } else {
        format!("{parent}\\{name}")
    }
}

/// Byte length of the device root of a `win32_resolve`-normalized path:
/// `C:\…` -> 3; `\\server\share\…` -> the share root INCLUDING its trailing
/// backslash. `None` for unrecognized shapes (defensive — `win32_resolve`
/// output always matches one of the two).
fn windows_display_root_len(normalized: &str) -> Option<usize> {
    let b = normalized.as_bytes();
    if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\' {
        return Some(3);
    }
    if let Some(rest) = normalized.strip_prefix("\\\\") {
        // `\\server\share\…`: skip the server component, then the share
        // component, and include the backslash that closes the share root.
        let server_end = rest.find('\\')?; // index within `rest`
        let after_server = 2 + server_end + 1; // index just past `\\server\`
        let root_end = match normalized[after_server..].find('\\') {
            Some(i) => after_server + i + 1, // include the trailing `\`
            None => normalized.len(), // bare `\\server\share` (lenient)
        };
        return Some(root_end);
    }
    None
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-platform --test path_tests`
Expected: PASS — all pre-existing path tests still green plus `split_windows_display_path_matrix` and `join_windows_display_path_matrix`.

- [ ] **Step 5: Format + lint**

Run: `cargo fmt --all && cargo clippy -p freshell-platform --all-targets -- -D warnings`
Expected: no diffs from fmt, clippy exits 0.

- [ ] **Step 6: Commit**

```bash
git -C /home/dan/code/freshell/.worktrees/windows-path-files add crates/freshell-platform/src/path.rs crates/freshell-platform/tests/path_tests.rs
git -C /home/dan/code/freshell/.worktrees/windows-path-files commit -m "feat(platform): add windows display-path split/join helpers" -m "Rust counterpart of the files endpoints' path.win32.dirname/basename/join
usage (files-router.ts:194-211), built on win32_resolve. Needed so the
Rust files REST surface can split/join flavor-preserving display paths
while doing filesystem access on converted native paths.

Verified: cargo fmt clean, clippy -p freshell-platform -D warnings clean,
cargo test -p freshell-platform => all passed.

Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240428069+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 2: files.rs flavor-aware resolution seam + validate_dir

**Files:**
- Modify: `crates/freshell-server/src/files.rs` (imports at lines 42–56; `validate_dir` body at lines 132–157; new code after `normalize_user_path` helpers around line 479; tests module at lines 575–704)

**Interfaces:**
- Consumes: `freshell_platform::{detect_user_path_flavor, sanitize_user_path_input, RealEnv, UserPathFlavor}`, `freshell_platform::path::{convert_windows_path_to_wsl_path, win32_resolve}`, `freshell_platform::detect::is_wsl_env_live`, existing `normalize_user_path(&str) -> String`.
- Produces (Tasks 3–4 rely on these exact items):
  - `pub(crate) struct ResolvedUserPath { pub display: String, pub fs_path: Option<String> }` (Task 3 adds a `flavor` field)
  - `pub(crate) fn resolve_user_path(input: &str) -> ResolvedUserPath`
  - Test scaffolding inside `mod tests`: `ENV_LOCK` (alias of the crate-wide `crate::session_directory::HOME_ENV_TEST_LOCK`) + poison-tolerant `fn env_lock() -> MutexGuard<'static, ()>`, `struct EnvGuard` with `fn set(pairs: &[(&'static str, Option<&str>)]) -> EnvGuard`, `struct WslMountFixture` with `fn new() -> WslMountFixture` and `fn mount(&self, drive: &str) -> std::path::PathBuf`, `fn test_state() -> FilesState`, `fn auth_headers() -> HeaderMap`, `async fn body_json(resp: Response) -> Value`.

- [ ] **Step 1: Write the failing tests**

In `crates/freshell-server/src/files.rs`, inside the existing `#[cfg(test)] mod tests` block (after `use super::*;`), add the scaffolding and tests:

```rust
    // `std::env::set_var` mutates whole-process state, and this bin test
    // binary ALREADY serializes env-mutating tests (session_directory.rs
    // provider_home tests, main.rs resolve-wiring tests) on the crate-wide
    // `HOME_ENV_TEST_LOCK` (session_directory.rs:463-464). Reuse THAT lock —
    // a files-local mutex would not serialize against those 11 tests.
    use crate::session_directory::HOME_ENV_TEST_LOCK as ENV_LOCK;

    /// Poison-tolerant acquisition (same pattern as `main.rs:2460`).
    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// RAII: set/remove a group of env vars, restoring prior values on drop.
    struct EnvGuard {
        saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
    }

    impl EnvGuard {
        /// `Some(v)` sets the var; `None` removes it. Prior state is restored
        /// (set-or-removed) on drop, even on panic.
        fn set(pairs: &[(&'static str, Option<&str>)]) -> Self {
            let saved = pairs
                .iter()
                .map(|(key, value)| {
                    let prior = std::env::var_os(key);
                    match value {
                        Some(v) => std::env::set_var(key, v),
                        None => std::env::remove_var(key),
                    }
                    (*key, prior)
                })
                .collect();
            EnvGuard { saved }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (key, prior) in self.saved.drain(..) {
                match prior {
                    Some(v) => std::env::set_var(key, v),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    /// A fake WSL drive mount under a tempdir: env says "this is WSL and
    /// drives are mounted at <root>" (WSL_DISTRO_NAME + WSL_WINDOWS_SYS32,
    /// the same knobs the freshell-platform tests and the Node plan
    /// docs/superpowers/plans/2026-06-10-windows-wsl-launch-cwd.md use), and
    /// real directories exist at <root>/c/{Users/dan,Windows/System32} and
    /// <root>/d/proj. WSL_WINDOWS_SYS32 must match the strict
    /// `^(.*)/[a-zA-Z]/Windows/System32$` shape or the mount prefix silently
    /// falls back to /mnt.
    struct WslMountFixture {
        _env: EnvGuard,
        root: tempfile::TempDir,
    }

    impl WslMountFixture {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let sys32 = root.path().join("c/Windows/System32");
            std::fs::create_dir_all(&sys32).unwrap();
            std::fs::create_dir_all(root.path().join("c/Users/dan")).unwrap();
            std::fs::write(root.path().join("c/Users/notes.txt"), b"x").unwrap();
            std::fs::create_dir_all(root.path().join("d/proj")).unwrap();
            let sys32_str = sys32.to_string_lossy().into_owned();
            let env = EnvGuard::set(&[
                ("WSL_DISTRO_NAME", Some("Ubuntu")),
                ("WSL_INTEROP", None),
                ("WSLENV", None),
                ("WSL_WINDOWS_SYS32", Some(sys32_str.as_str())),
            ]);
            WslMountFixture { _env: env, root }
        }

        /// The native directory a `X:\` drive maps to, e.g. `mount("c")`.
        fn mount(&self, drive: &str) -> std::path::PathBuf {
            self.root.path().join(drive)
        }
    }

    /// Env pinned to a plain (non-WSL) Linux host.
    fn non_wsl_env() -> EnvGuard {
        EnvGuard::set(&[
            ("WSL_DISTRO_NAME", None),
            ("WSL_INTEROP", None),
            ("WSLENV", None),
            ("WSL_WINDOWS_SYS32", None),
        ])
    }

    fn test_state() -> FilesState {
        FilesState {
            auth_token: Arc::new("tok".to_string()),
            settings: SettingsStore::load(None, Vec::new()),
            registry: TerminalRegistry::new(),
        }
    }

    fn auth_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-auth-token", "tok".parse().unwrap());
        headers
    }

    async fn body_json(resp: Response) -> Value {
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    // ---- resolve_user_path (R-WIN1: flavor-aware display/native seam) ----

    #[test]
    fn resolve_user_path_windows_drive_on_wsl_maps_to_mount() {
        let _guard = env_lock();
        let fixture = WslMountFixture::new();
        let mount_c = fixture.mount("c").to_string_lossy().into_owned();

        let r = resolve_user_path("C:\\");
        assert_eq!(r.display, "C:\\");
        assert_eq!(r.fs_path, Some(mount_c.clone()));

        let r = resolve_user_path("C:\\Users\\dan");
        assert_eq!(r.display, "C:\\Users\\dan");
        assert_eq!(r.fs_path, Some(format!("{mount_c}/Users/dan")));

        // Forward slashes + trailing separator normalize; drive case preserved
        // as typed (Node path.win32.resolve semantics).
        let r = resolve_user_path("c:/Users/");
        assert_eq!(r.display, "c:\\Users");
        assert_eq!(r.fs_path, Some(format!("{mount_c}/Users")));
    }

    #[test]
    fn resolve_user_path_windows_off_wsl_is_unaddressable() {
        let _guard = env_lock();
        let _env = non_wsl_env();
        let r = resolve_user_path("C:\\Users");
        assert_eq!(r.display, "C:\\Users");
        assert_eq!(r.fs_path, None);
    }

    #[test]
    fn resolve_user_path_windows_unresolvable_forms_are_unaddressable() {
        let _guard = env_lock();
        let _fixture = WslMountFixture::new();
        // Bare drive, rooted, and generic (non-WSL) UNC inputs have no native
        // address even on WSL. (NOTE: drive-relative `C:foo` is NOT Windows
        // flavor — Node's WINDOWS_DRIVE_PREFIX_RE requires a separator or
        // end-of-string after the colon, so `C:foo` stays `native` in both
        // servers and keeps today's literal behavior.)
        for input in ["C:", "\\rooted", "\\\\srv\\share\\x"] {
            let r = resolve_user_path(input);
            assert_eq!(r.fs_path, None, "{input:?}");
        }
    }

    #[test]
    fn resolve_user_path_posix_and_tilde_unchanged() {
        let _guard = env_lock();
        let _env = EnvGuard::set(&[("HOME", Some("/home/tester"))]);
        // POSIX: exact normalize_user_path behavior — display == fs path.
        let r = resolve_user_path("/tmp/x///");
        assert_eq!(r.display, "/tmp/x");
        assert_eq!(r.fs_path, Some("/tmp/x".to_string()));
        // Tilde: native flavor, expanded via HOME.
        let r = resolve_user_path("~/proj");
        assert_eq!(r.display, "/home/tester/proj");
        assert_eq!(r.fs_path, Some("/home/tester/proj".to_string()));
    }

    // ---- validate_dir (R-WIN2: Windows input on WSL resolves via the mount) ----

    #[tokio::test]
    async fn validate_dir_accepts_windows_drive_on_wsl() {
        let _guard = env_lock();
        let _fixture = WslMountFixture::new();
        let resp = validate_dir(
            State(test_state()),
            auth_headers(),
            Json(json!({ "path": "C:\\" })),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["valid"], true);
        assert_eq!(v["resolvedPath"], "C:\\");
    }

    #[tokio::test]
    async fn validate_dir_windows_deep_path_and_missing_dir() {
        let _guard = env_lock();
        let _fixture = WslMountFixture::new();
        // D:\proj exists in the fixture.
        let resp = validate_dir(
            State(test_state()),
            auth_headers(),
            Json(json!({ "path": "D:\\proj" })),
        )
        .await
        .into_response();
        let v = body_json(resp).await;
        assert_eq!(v["valid"], true);
        assert_eq!(v["resolvedPath"], "D:\\proj");
        // C:\Nope does not exist -> valid:false but the display path is still
        // returned (Node isReachableDirectory semantics).
        let resp = validate_dir(
            State(test_state()),
            auth_headers(),
            Json(json!({ "path": "C:\\Nope" })),
        )
        .await
        .into_response();
        let v = body_json(resp).await;
        assert_eq!(v["valid"], false);
        assert_eq!(v["resolvedPath"], "C:\\Nope");
    }

    #[tokio::test]
    async fn validate_dir_windows_input_invalid_off_wsl() {
        let _guard = env_lock();
        let _env = non_wsl_env();
        let resp = validate_dir(
            State(test_state()),
            auth_headers(),
            Json(json!({ "path": "C:\\" })),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["valid"], false);
        assert_eq!(v["resolvedPath"], "C:\\");
    }

    #[tokio::test]
    async fn validate_dir_posix_regression() {
        let _guard = env_lock();
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_string_lossy().into_owned();
        let resp = validate_dir(
            State(test_state()),
            auth_headers(),
            Json(json!({ "path": dir.as_str() })),
        )
        .await
        .into_response();
        let v = body_json(resp).await;
        assert_eq!(v["valid"], true);
        assert_eq!(v["resolvedPath"], dir);
        let bogus = format!("{}/freshell-nonexistent-xyz", tmp.path().display());
        let resp = validate_dir(
            State(test_state()),
            auth_headers(),
            Json(json!({ "path": bogus })),
        )
        .await
        .into_response();
        let v = body_json(resp).await;
        assert_eq!(v["valid"], false);
    }
```

Also update the two pre-existing env-mutating tests in this module to take the new lock, so they cannot interleave with the tests above (both currently call `std::env::set_var("HOME", "/home/tester")` bare):

In `expand_tilde_uses_home` (line 599) and `resolve_completion_input_honors_root_and_absolute` (line 631), insert as the first two lines of each test body:

```rust
        let _guard = env_lock();
        let _env = EnvGuard::set(&[("HOME", Some("/home/tester"))]);
```

and delete the now-redundant `std::env::set_var("HOME", "/home/tester");` line from each.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-server files::tests -- --nocapture`
Expected: FAIL to compile — `cannot find function `resolve_user_path` in this scope`.

- [ ] **Step 3: Write the implementation**

3a. Extend the imports block (lines 42–56). After `use freshell_terminal::TerminalRegistry;` add:

```rust
use freshell_platform::path::{convert_windows_path_to_wsl_path, win32_resolve};
use freshell_platform::{
    detect_user_path_flavor, sanitize_user_path_input, RealEnv, UserPathFlavor,
};
```

3b. Add the seam directly after `trim_trailing_separators` (after line 479):

```rust
/// A user path resolved for filesystem access: the flavor-preserving DISPLAY
/// string (what goes back to the client in `resolvedPath` / suggestion paths)
/// plus the native path used for actual filesystem operations.
/// `fs_path: None` means the input names a location this host cannot address
/// (a Windows path on a non-WSL Linux host, a bare drive `C:`, rooted
/// `\foo`, or a generic `\\server\share` UNC).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedUserPath {
    pub display: String,
    pub fs_path: Option<String>,
}

/// Port of `normalizeUserPath` + `toFilesystemPath` composed
/// (`path-utils.ts:54-73`, `:208-215`, `:241-245`) for this POSIX-host server.
///
/// - Posix/Native flavors (including `~`): EXACTLY the existing
///   [`normalize_user_path`] behavior — display and fs path are the same
///   string, so pre-existing callers observe zero change.
/// - Windows flavor: display = [`win32_resolve`] (Node's `path.win32.resolve`
///   semantics — separators to `\`, trailing separator stripped, `..`
///   collapsed, drive-letter case preserved as typed); fs path = the WSL
///   drive/UNC conversion, gated on the live WSL environment exactly like
///   Node's `resolveWindowsFlavorPath`. Where Node falls through to the
///   literal `C:\…` string on non-WSL hosts (and `fs` then treats it as a
///   relative POSIX name), this returns `fs_path: None` so callers can treat
///   the input as unaddressable instead of stat'ing/creating a literal
///   backslash-named entry — the mkdir hazard this fix removes.
pub(crate) fn resolve_user_path(input: &str) -> ResolvedUserPath {
    if detect_user_path_flavor(input) != UserPathFlavor::Windows {
        let normalized = normalize_user_path(input);
        return ResolvedUserPath {
            display: normalized.clone(),
            fs_path: Some(normalized),
        };
    }
    let sanitized = sanitize_user_path_input(input);
    let Some(display) = win32_resolve(&sanitized) else {
        // Bare drive (`C:`) / rooted (`\foo`): cwd-dependent inputs the
        // deterministic core refuses. Keep the sanitized input as the
        // display string; not addressable here. (Node would cwd-anchor via
        // path.win32.resolve — e.g. `C:` -> `C:\<server-cwd>` — but oracle
        // runs show `\foo` resolves to itself on POSIX, so the divergence is
        // limited to bare-drive forms, where both servers report
        // valid:false / empty suggestions and nothing is persisted.)
        return ResolvedUserPath {
            display: sanitized,
            fs_path: None,
        };
    };
    let fs_path = if freshell_platform::detect::is_wsl_env_live() {
        // `convert_windows_path_to_wsl_path`'s drive branch would convert even
        // off-WSL; the gate above is what makes this match Node's
        // resolveWindowsFlavorPath (conversion only when isWslEnvironment()).
        convert_windows_path_to_wsl_path(&display, &RealEnv, true)
    } else {
        None
    };
    ResolvedUserPath { display, fs_path }
}
```

3c. Rewrite the tail of `validate_dir` (replace lines 151–156, i.e. everything from `let normalized_path = …` through the final `Json(…)` line; the auth/400 guards above stay untouched):

```rust
    let resolved = resolve_user_path(trimmed);
    let is_dir = resolved
        .fs_path
        .as_deref()
        .map(|fs| {
            std::fs::metadata(fs)
                .map(|meta| meta.is_dir())
                .unwrap_or(false)
        })
        .unwrap_or(false);

    Json(json!({ "valid": is_dir, "resolvedPath": resolved.display })).into_response()
```

Also update `validate_dir`'s doc comment (lines 127–131) to note the Windows-flavor behavior, e.g. append: `/// Windows-flavor inputs (e.g. `C:\`) resolve through the WSL drive mount when running in WSL (path-utils.ts isReachableDirectory parity); on non-WSL hosts they are unaddressable and report valid:false.`

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-server files::tests`
Expected: PASS — all pre-existing `files::tests` cases plus the 9 new/updated ones.

- [ ] **Step 5: Format + lint**

Run: `cargo fmt --all && cargo clippy -p freshell-server --all-targets -- -D warnings`
Expected: clean. (`resolve_user_path` is used by `validate_dir`, so no `dead_code`.)

- [ ] **Step 6: Commit**

```bash
git -C /home/dan/code/freshell/.worktrees/windows-path-files add crates/freshell-server/src/files.rs
git -C /home/dan/code/freshell/.worktrees/windows-path-files commit -m "feat(server): resolve windows-flavor paths in files validate-dir" -m "Adds resolve_user_path — the flavor-aware display/native seam composing
freshell_platform::path (detect_user_path_flavor, win32_resolve,
convert_windows_path_to_wsl_path, WSL-env gate) — and routes validate-dir
through it. C:\\ on a WSL host now stats the drive mount and validates;
non-WSL hosts report valid:false (Node parity). POSIX/~ inputs keep the
exact normalize_user_path path.

Verified: cargo fmt clean, clippy -p freshell-server -D warnings clean,
cargo test -p freshell-server => all passed.

Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240428069+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 3: complete — Windows-flavor suggestions in the input's flavor

**Files:**
- Modify: `crates/freshell-server/src/files.rs` (imports; `ResolvedUserPath`/`resolve_user_path` from Task 2; `complete` body at lines 282–355 pre-Task-2 numbering; tests module)

**Interfaces:**
- Consumes: `resolve_user_path`, `ResolvedUserPath` (Task 2), `split_windows_display_path` / `join_windows_display_path` (Task 1), existing `resolve_completion_input`, `is_path_allowed`, `CompleteQuery`.
- Produces:
  - `ResolvedUserPath` gains `pub flavor: UserPathFlavor` (set by `resolve_user_path`; Windows branch sets `UserPathFlavor::Windows`, other branch sets the detected flavor).
  - `impl ResolvedUserPath { pub(crate) fn sandbox_target(&self) -> &str }` — the string sandbox checks compare: the converted native path when addressable, else the display string (Node's literal fallthrough in `validatePath`/`resolvePathForSandboxComparison`). Task 4 reuses it.

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `files.rs`:

```rust
    // ---- complete (R-WIN3: suggestions rendered in the INPUT's flavor) ----

    /// Call `complete` and return the suggestion path strings.
    async fn complete_paths(prefix: &str, root: Option<&str>, dirs: Option<&str>) -> Vec<String> {
        let resp = complete(
            State(test_state()),
            auth_headers(),
            Query(CompleteQuery {
                prefix: Some(prefix.to_string()),
                root: root.map(str::to_string),
                dirs: dirs.map(str::to_string),
            }),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        v["suggestions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["path"].as_str().unwrap().to_string())
            .collect()
    }

    #[tokio::test]
    async fn complete_windows_drive_root_lists_in_input_flavor() {
        let _guard = env_lock();
        let _fixture = WslMountFixture::new();
        // C:\ is a directory (the fixture's <root>/c) -> list all children,
        // display paths joined win32-style in the input's flavor.
        // Children of <root>/c: Users/ and Windows/ (dirs sort before files;
        // byte-order alphabetical within).
        let paths = complete_paths("C:\\", None, None).await;
        assert_eq!(paths, vec!["C:\\Users", "C:\\Windows"]);
    }

    #[tokio::test]
    async fn complete_windows_partial_leaf_filters_and_preserves_flavor() {
        let _guard = env_lock();
        let _fixture = WslMountFixture::new();
        // Partial leaf: split parent/leaf on the display path, filter by leaf.
        let paths = complete_paths("C:\\Us", None, None).await;
        assert_eq!(paths, vec!["C:\\Users"]);
        // Leaf matching is case-sensitive (Node files-router parity).
        let paths = complete_paths("C:\\us", None, None).await;
        assert!(paths.is_empty());
        // Drive-letter case flows through from the typed input.
        let paths = complete_paths("c:\\Us", None, None).await;
        assert_eq!(paths, vec!["c:\\Users"]);
    }

    #[tokio::test]
    async fn complete_windows_dirs_only_filters_files() {
        let _guard = env_lock();
        let _fixture = WslMountFixture::new();
        // C:\Users contains dan/ (dir) and notes.txt (file).
        let all = complete_paths("C:\\Users\\", None, None).await;
        assert_eq!(all, vec!["C:\\Users\\dan", "C:\\Users\\notes.txt"]);
        let dirs = complete_paths("C:\\Users\\", None, Some("true")).await;
        assert_eq!(dirs, vec!["C:\\Users\\dan"]);
    }

    #[tokio::test]
    async fn complete_windows_missing_parent_and_off_wsl_return_empty() {
        let _guard = env_lock();
        {
            let _fixture = WslMountFixture::new();
            // Parent C:\Nope doesn't exist -> readdir NotFound -> 200 { suggestions: [] }.
            assert!(complete_paths("C:\\Nope\\x", None, None).await.is_empty());
        }
        let _env = non_wsl_env();
        // Windows input on a non-WSL host is unaddressable -> empty suggestions.
        assert!(complete_paths("C:\\", None, None).await.is_empty());
    }

    #[tokio::test]
    async fn complete_windows_root_anchoring_composes() {
        let _guard = env_lock();
        let _fixture = WslMountFixture::new();
        // Relative prefix under a windows-flavor root: resolve_completion_input
        // joins with `/`, and win32_resolve then normalizes the mixed
        // separators into a windows display path.
        let paths = complete_paths("da", Some("C:\\Users"), None).await;
        assert_eq!(paths, vec!["C:\\Users\\dan"]);
    }

    #[tokio::test]
    async fn complete_wsl_unc_partial_leaf_round_trips() {
        let _guard = env_lock();
        let _fixture = WslMountFixture::new();
        // WSL-UNC inputs convert to native root-relative paths
        // (`\\wsl.localhost\Ubuntu\<p>` -> `/<p>`; distro matched
        // case-insensitively against WSL_DISTRO_NAME, path.rs:384-419) — so a
        // real tempdir exercises the full composed chain end-to-end:
        // split on the display path -> reconvert the parent -> join back.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("subdir")).unwrap();
        let tmp_unc = tmp
            .path()
            .to_string_lossy()
            .trim_start_matches('/')
            .replace('/', "\\");
        let prefix = format!("\\\\wsl.localhost\\Ubuntu\\{tmp_unc}\\su");
        let paths = complete_paths(&prefix, None, None).await;
        assert_eq!(
            paths,
            vec![format!("\\\\wsl.localhost\\Ubuntu\\{tmp_unc}\\subdir")]
        );
    }

    #[tokio::test]
    async fn complete_posix_regression_unchanged() {
        let _guard = env_lock();
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("subdir")).unwrap();
        std::fs::create_dir_all(tmp.path().join("subzero")).unwrap();
        let prefix = format!("{}/sub", tmp.path().display());
        let paths = complete_paths(&prefix, None, None).await;
        assert_eq!(
            paths,
            vec![
                format!("{}/subdir", tmp.path().display()),
                format!("{}/subzero", tmp.path().display()),
            ]
        );
    }

    #[test]
    fn sandbox_target_uses_converted_native_path() {
        let _guard = env_lock();
        let fixture = WslMountFixture::new();
        let mount_c = fixture.mount("c").to_string_lossy().into_owned();
        // R-WIN4: sandbox comparisons use the CONVERTED native path (Node's
        // validatePath resolves through toFilesystemPath before isPathAllowed).
        let r = resolve_user_path("C:\\Users");
        assert_eq!(r.sandbox_target(), format!("{mount_c}/Users"));
        // Unaddressable input falls back to its display string. With roots
        // configured, that literal never matches -> unconditional deny. This
        // is DELIBERATELY STRICTER than Node, which posix-resolves the
        // literal against the server cwd first (path-utils.ts:294) and so
        // ALLOWS it whenever the cwd sits under an allowed root (its /write
        // can then even create a literal `C:\...` entry there — oracle-
        // verified). Fail-closed here: we never allow a request Node denies.
        let r = resolve_user_path("\\\\srv\\share\\x");
        assert_eq!(r.sandbox_target(), "\\\\srv\\share\\x");
        // POSIX target is compared as-is.
        let r = resolve_user_path("/tmp/x");
        assert_eq!(r.sandbox_target(), "/tmp/x");
        // And the existing boundary logic operates on those native strings.
        let roots = vec![mount_c.clone()];
        assert!(is_path_allowed(
            resolve_user_path("C:\\Users").sandbox_target(),
            Some(&roots)
        ));
        assert!(!is_path_allowed(
            resolve_user_path("D:\\proj").sandbox_target(),
            Some(&roots)
        ));
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-server files::tests -- --nocapture`
Expected: FAIL to compile — `no method named `sandbox_target``; after Step 3's struct change compiles, the behavioral tests (`complete_windows_*`) fail with assertion mismatches (empty suggestion lists) until Step 3 is complete. Either red form counts.

- [ ] **Step 3: Write the implementation**

3a. Extend the platform import (from Task 2) to include the display helpers:

```rust
use freshell_platform::path::{
    convert_windows_path_to_wsl_path, join_windows_display_path, split_windows_display_path,
    win32_resolve,
};
```

3b. Add the `flavor` field and `sandbox_target` to `ResolvedUserPath`:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedUserPath {
    pub display: String,
    pub fs_path: Option<String>,
    pub flavor: UserPathFlavor,
}

impl ResolvedUserPath {
    /// The string sandbox checks compare — Node's `validatePath` resolves the
    /// request path through `toFilesystemPath` before `isPathAllowed`
    /// (`files-router.ts:75-78`), so comparisons use the CONVERTED native path
    /// when the input is addressable, and fall back to the literal display
    /// string when it is not (Node's non-WSL fallthrough).
    pub(crate) fn sandbox_target(&self) -> &str {
        self.fs_path.as_deref().unwrap_or(&self.display)
    }
}
```

Update `resolve_user_path` to populate it: the non-Windows early return becomes

```rust
    let flavor = detect_user_path_flavor(input);
    if flavor != UserPathFlavor::Windows {
        let normalized = normalize_user_path(input);
        return ResolvedUserPath {
            display: normalized.clone(),
            fs_path: Some(normalized),
            flavor,
        };
    }
```

and both Windows-branch constructors gain `flavor: UserPathFlavor::Windows,`.

3c. Rewrite `complete`'s body between the `dirs_only` line and the sort (replace lines 295–342 of the pre-Task-2 numbering — from `// Resolve the completion input …` through the `matches` collection — keeping auth/400 guards, sort, truncate, and the response construction untouched):

```rust
    // Resolve the completion input against `root` (unless the prefix is absolute).
    let completion_input = resolve_completion_input(&prefix, q.root.as_deref());
    let resolved = resolve_user_path(&completion_input);
    let settings = state.settings.get().await;
    if !is_path_allowed(resolved.sandbox_target(), settings.allowed_file_paths.as_deref()) {
        return forbidden();
    }
    let Some(fs_path) = resolved.fs_path.clone() else {
        // Windows-flavor input this host cannot address (non-WSL host, generic
        // UNC, drive-relative): Node's readdir would ENOENT -> empty suggestions.
        return Json(json!({ "suggestions": [] })).into_response();
    };
    let windows_flavor = resolved.flavor == UserPathFlavor::Windows;

    // If the input is itself a directory, list all its entries; otherwise treat the
    // basename as a partial and filter the parent's entries by it. The split is
    // done on the DISPLAY path with the INPUT's flavor semantics, and the parent
    // is re-converted for filesystem access (`files-router.ts:187-203`).
    let (dir_display, dir_fs, basename) = match std::fs::metadata(&fs_path) {
        Ok(meta) if meta.is_dir() => (resolved.display.clone(), fs_path, String::new()),
        _ if windows_flavor => {
            let Some((parent_display, leaf)) = split_windows_display_path(&resolved.display)
            else {
                return Json(json!({ "suggestions": [] })).into_response();
            };
            // `fs_path` was Some, so this request already established a live
            // WSL environment — the parent converts under the same regime.
            let Some(parent_fs) = convert_windows_path_to_wsl_path(&parent_display, &RealEnv, true)
            else {
                return Json(json!({ "suggestions": [] })).into_response();
            };
            (parent_display, parent_fs, leaf)
        }
        _ => {
            let p = Path::new(&resolved.display);
            let parent = p
                .parent()
                .map(|d| d.to_string_lossy().into_owned())
                .unwrap_or_else(|| "/".to_string());
            let base = p
                .file_name()
                .map(|b| b.to_string_lossy().into_owned())
                .unwrap_or_default();
            (parent.clone(), parent, base)
        }
    };

    let mut matches: Vec<(String, bool)> = match std::fs::read_dir(&dir_fs) {
        Ok(entries) => entries
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !name.starts_with(&basename) {
                    return None;
                }
                let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                if dirs_only && !is_dir {
                    return None;
                }
                // Suggestion paths are DISPLAY paths in the input's flavor
                // (`files-router.ts:211` — pathModule.join(dirDisplayPath, name)).
                let joined = if windows_flavor {
                    join_windows_display_path(&dir_display, &name)
                } else {
                    Path::new(&dir_display)
                        .join(&name)
                        .to_string_lossy()
                        .into_owned()
                };
                Some((joined, is_dir))
            })
            .collect(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(err) => return internal_error(&err.to_string()),
    };
```

(The subsequent sort / `truncate(20)` / `suggestions` mapping / `Json` response lines are unchanged.)

Note the POSIX/native path through this code is string-identical to the old code: `resolved.display == normalize_user_path(completion_input)` and `sandbox_target() == resolved.display` for those flavors.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-server files::tests`
Expected: PASS — all module tests including the 8 new ones.

- [ ] **Step 5: Format + lint**

Run: `cargo fmt --all && cargo clippy -p freshell-server --all-targets -- -D warnings`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git -C /home/dan/code/freshell/.worktrees/windows-path-files add crates/freshell-server/src/files.rs
git -C /home/dan/code/freshell/.worktrees/windows-path-files commit -m "feat(server): windows-flavor completion in files complete endpoint" -m "complete now resolves windows-flavor prefixes through the WSL mount for
filesystem access while splitting/joining suggestion paths on the display
string with win32 semantics — C:\\ lists /mnt/c but suggests C:\\Users,
C:\\Windows (files-router.ts:168-230 parity). Sandbox comparisons use the
converted native path (sandbox_target). POSIX/~ completion unchanged.

Verified: cargo fmt clean, clippy -p freshell-server -D warnings clean,
cargo test -p freshell-server => all passed.

Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240428069+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 4: mkdir — convert or reject

**Files:**
- Modify: `crates/freshell-server/src/files.rs` (`mkdir` body at lines 371–411 pre-Task-2 numbering; tests module)

**Interfaces:**
- Consumes: `resolve_user_path`, `ResolvedUserPath::sandbox_target` (Tasks 2–3), existing `is_path_allowed`, `bad_request`, `forbidden`, `forbidden_msg`, `internal_error`.
- Produces: no new items — final endpoint behavior.

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `files.rs`:

```rust
    // ---- mkdir (R-WIN5: convert windows-flavor input; reject unaddressable) ----

    async fn mkdir_resp(path: &str) -> Response {
        mkdir(
            State(test_state()),
            auth_headers(),
            Json(json!({ "path": path })),
        )
        .await
        .into_response()
    }

    #[tokio::test]
    async fn mkdir_windows_path_creates_under_mount() {
        let _guard = env_lock();
        let fixture = WslMountFixture::new();
        let resp = mkdir_resp("C:\\Users\\dan\\newproj").await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["created"], true);
        assert_eq!(v["existed"], false);
        // resolvedPath is the flavor-preserving DISPLAY path (Node parity).
        assert_eq!(v["resolvedPath"], "C:\\Users\\dan\\newproj");
        // The directory was created under the mount…
        assert!(fixture.mount("c").join("Users/dan/newproj").is_dir());
        // …and NOT as a literal backslash-named entry under the server cwd.
        assert!(!std::path::Path::new("C:\\Users\\dan\\newproj").exists());
    }

    #[tokio::test]
    async fn mkdir_rejects_unaddressable_windows_input_off_wsl() {
        let _guard = env_lock();
        let _env = non_wsl_env();
        let resp = mkdir_resp("C:\\").await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let v = body_json(resp).await;
        assert!(v["error"].as_str().unwrap().contains("cannot be resolved"));
        // The hazard this fix removes (old files.rs:387-393): no literal
        // `C:\` directory materializes under the process cwd.
        assert!(!std::path::Path::new("C:\\").exists());
    }

    #[tokio::test]
    async fn mkdir_rejects_unresolvable_windows_forms_even_on_wsl() {
        let _guard = env_lock();
        let _fixture = WslMountFixture::new();
        // Bare drive / rooted inputs are Windows flavor but have no absolute
        // native address, even on WSL. (`C:foo` is `native` flavor in both
        // servers — see resolve_user_path_windows_unresolvable_forms — so it
        // keeps today's behavior and is not asserted here.)
        for input in ["C:", "\\rooted"] {
            let resp = mkdir_resp(input).await;
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "{input:?}");
        }
    }

    #[tokio::test]
    async fn mkdir_posix_regression_unchanged() {
        let _guard = env_lock();
        let tmp = tempfile::tempdir().unwrap();
        let target = format!("{}/fresh-sub", tmp.path().display());
        let resp = mkdir_resp(&target).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["created"], true);
        assert_eq!(v["existed"], false);
        assert_eq!(v["resolvedPath"], target);
        assert!(std::path::Path::new(&target).is_dir());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-server files::tests::mkdir_rejects_unaddressable_windows_input_off_wsl -- --exact --nocapture`
Expected: FAIL — status is `200 OK` (today's mkdir happily `create_dir_all`s the literal string), not `400`. If a literal `C:\` directory gets created in the crate dir by this red run, delete it before proceeding: `rm -rf '/home/dan/code/freshell/.worktrees/windows-path-files/C:\'` (quote exactly).

- [ ] **Step 3: Write the implementation**

Replace `mkdir`'s body after the `path is required` guard (pre-Task-2 lines 387–410, i.e. from `let resolved = normalize_user_path(path);` to the end of the function):

```rust
    let resolved = resolve_user_path(path);
    let settings = state.settings.get().await;
    if !is_path_allowed(resolved.sandbox_target(), settings.allowed_file_paths.as_deref()) {
        return forbidden();
    }
    let Some(fs_path) = resolved.fs_path else {
        // Never create a literal `C:\…` entry under the server cwd — the
        // deliberate divergence from Node's non-WSL fallthrough hazard
        // (`files-router.ts:262` + `path-utils.ts:208-215`).
        return bad_request("path cannot be resolved to a directory on this host");
    };
    match std::fs::create_dir_all(&fs_path) {
        Ok(()) => Json(
            json!({ "created": true, "existed": false, "resolvedPath": resolved.display }),
        )
        .into_response(),
        Err(err) => match err.kind() {
            std::io::ErrorKind::PermissionDenied => forbidden_msg("Permission denied"),
            _ => {
                // A path component that exists but is not a directory → 409.
                if Path::new(&fs_path).exists() {
                    (
                        StatusCode::CONFLICT,
                        Json(json!({ "error": "Path exists but is not a directory" })),
                    )
                        .into_response()
                } else {
                    internal_error(&err.to_string())
                }
            }
        },
    }
```

Also extend `mkdir`'s doc comment (lines 357–370) with one line: `/// Windows-flavor inputs convert through the WSL mount before create_dir_all; inputs with no native address on this host are rejected with 400 instead of creating a literal backslash-named directory.`

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-server files::tests`
Expected: PASS — all module tests including the 4 new ones (and the pre-existing `mkdir_recreating_existing_dir_reports_existed_false`, whose POSIX behavior is unchanged).

- [ ] **Step 5: Format + lint**

Run: `cargo fmt --all && cargo clippy -p freshell-server --all-targets -- -D warnings`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git -C /home/dan/code/freshell/.worktrees/windows-path-files add crates/freshell-server/src/files.rs
git -C /home/dan/code/freshell/.worktrees/windows-path-files commit -m "fix(server): convert or reject windows-flavor paths in files mkdir" -m "mkdir now converts C:\\-style input through the WSL mount before
create_dir_all and returns 400 for inputs with no native address on this
host — it is no longer possible to create a literal backslash-named
directory (e.g. 'C:\\') under the server cwd. resolvedPath reports the
flavor-preserving display path (files-router.ts:247-280 parity); sandbox
comparison uses the converted native path. POSIX/~ mkdir unchanged.

Verified: cargo fmt clean, clippy -p freshell-server -D warnings clean,
cargo test -p freshell-server => all passed.

Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240428069+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 5: read/stat/write/validate_dir sandbox comparison via the seam; final verification

**Files:**
- Modify: `crates/freshell-server/src/files.rs` (`read_file` at lines 159–198, `stat_file` at 200–235, `write_file` at 237–277, pre-Task-2 numbering; `validate_dir` as rewritten by Task 2; tests module)

**Interfaces:**
- Consumes: `resolve_user_path`, `ResolvedUserPath::sandbox_target` (Tasks 2–3), existing handler bodies, `SettingsStore::patch` (test only; existing, exercised at `settings_store.rs:2077-2094`; `persist` no-ops when the store was loaded with `home: None`, `settings_store.rs:420-422`).
- Produces: no new items — spec requirement 4 ("any sandbox checks in files.rs compare the converted native path") now holds for every `is_path_allowed` call site in files.rs, and `validate_dir` gains the check it was missing (validated as an unexplained Node-parity defect — Node applies `validatePath` to the route, `files-router.ts:232`, 403 pinned by `test/unit/server/files-router.test.ts:451-460`).

All three read/stat/write handlers share the identical prelude `normalize_user_path` → `settings.get()` → `is_path_allowed(&resolved, …)` and then use `resolved` directly as the filesystem path. The change is the same three-line substitution in each: resolve through the seam, compare `sandbox_target()`, then rebind `resolved` to the native path with Node's exact literal fallthrough (`toFilesystemPath` on a non-WSL host returns the literal `C:\…` string, so a stat of it fails naturally — no new rejection semantics here; the mkdir-style 400 applies to mkdir only, per spec). The remainder of each handler body is untouched. `validate_dir` additionally gains the sandbox prelude it never had (see Step 3, last item).

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `files.rs`:

```rust
    // ---- read/stat/write (R-WIN4: sandbox + fs access via the converted path) ----

    #[tokio::test]
    async fn read_stat_write_follow_windows_conversion_on_wsl() {
        let _guard = env_lock();
        let fixture = WslMountFixture::new();
        // stat: the fixture file C:\Users\notes.txt exists via the mount.
        let resp = stat_file(
            State(test_state()),
            auth_headers(),
            Query(PathQuery {
                path: Some("C:\\Users\\notes.txt".to_string()),
            }),
        )
        .await
        .into_response();
        let v = body_json(resp).await;
        assert_eq!(v["exists"], true);
        // read: content comes back through the converted path.
        let resp = read_file(
            State(test_state()),
            auth_headers(),
            Query(PathQuery {
                path: Some("C:\\Users\\notes.txt".to_string()),
            }),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["content"], "x");
        // write: lands under the mount, not as a literal backslash-named entry.
        let resp = write_file(
            State(test_state()),
            auth_headers(),
            Json(json!({ "path": "C:\\Users\\dan\\note2.txt", "content": "hi" })),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["success"], true);
        assert_eq!(
            std::fs::read_to_string(fixture.mount("c").join("Users/dan/note2.txt")).unwrap(),
            "hi"
        );
        assert!(!std::path::Path::new("C:\\Users\\dan\\note2.txt").exists());
    }

    #[tokio::test]
    async fn stat_windows_path_off_wsl_reports_not_exists() {
        let _guard = env_lock();
        let _env = non_wsl_env();
        // Node parity: the literal `C:\…` string is handed to fs and the stat
        // fails naturally -> { exists: false } with HTTP 200.
        let resp = stat_file(
            State(test_state()),
            auth_headers(),
            Query(PathQuery {
                path: Some("C:\\Users\\notes.txt".to_string()),
            }),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["exists"], false);
    }

    // ---- validate_dir sandbox (closes the Node-parity gap: files-router.ts:232
    // applies validatePath to validate-dir; 403 pinned by Node's
    // test/unit/server/files-router.test.ts:451-460) ----

    #[tokio::test]
    async fn validate_dir_denies_path_outside_allowed_roots() {
        let _guard = env_lock();
        let fixture = WslMountFixture::new();
        let state = test_state();
        // Configure a sandbox root via the store's public patch API (persist
        // no-ops for home: None stores — settings_store.rs:420-422 — so this
        // touches no real config file).
        let root = fixture.mount("d").to_string_lossy().into_owned();
        state
            .settings
            .patch(&json!({ "allowedFilePaths": [root] }))
            .await
            .unwrap();
        // A windows path converting OUTSIDE the allowed root is denied…
        let resp = validate_dir(
            State(state.clone()),
            auth_headers(),
            Json(json!({ "path": "C:\\Users\\dan" })),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        // …while one INSIDE it (converted native path under the root) validates.
        let resp = validate_dir(
            State(state),
            auth_headers(),
            Json(json!({ "path": "D:\\proj" })),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["valid"], true);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-server files::tests::read_stat_write_follow_windows_conversion_on_wsl -- --exact --nocapture`
Expected: FAIL — `v["exists"]` is `false` and read returns 404 (today the literal `C:\Users\notes.txt` string is stat'd and not found). `validate_dir_denies_path_outside_allowed_roots` also fails red (status 200, no sandbox check yet).

- [ ] **Step 3: Write the implementation**

Apply the same substitution in each of the three handlers.

In `read_file`, replace lines 176–180:

```rust
    let resolved = normalize_user_path(&path);
    let settings = state.settings.get().await;
    if !is_path_allowed(&resolved, settings.allowed_file_paths.as_deref()) {
        return forbidden();
    }
```

with:

```rust
    let resolved = resolve_user_path(&path);
    let settings = state.settings.get().await;
    if !is_path_allowed(resolved.sandbox_target(), settings.allowed_file_paths.as_deref()) {
        return forbidden();
    }
    // Node's toFilesystemPath fallthrough (`path-utils.ts:208-215`): an
    // unaddressable input keeps its literal display string as the fs path,
    // so the stat below fails naturally on non-WSL hosts.
    let resolved = resolved.fs_path.unwrap_or(resolved.display);
```

In `stat_file`, replace lines 215–219:

```rust
    let resolved = normalize_user_path(&path);
    let settings = state.settings.get().await;
    if !is_path_allowed(&resolved, settings.allowed_file_paths.as_deref()) {
        return forbidden();
    }
```

with:

```rust
    let resolved = resolve_user_path(&path);
    let settings = state.settings.get().await;
    if !is_path_allowed(resolved.sandbox_target(), settings.allowed_file_paths.as_deref()) {
        return forbidden();
    }
    // Node's toFilesystemPath fallthrough — see read_file above.
    let resolved = resolved.fs_path.unwrap_or(resolved.display);
```

In `write_file`, replace lines 258–262:

```rust
    let resolved = normalize_user_path(path);
    let settings = state.settings.get().await;
    if !is_path_allowed(&resolved, settings.allowed_file_paths.as_deref()) {
        return forbidden();
    }
```

with:

```rust
    let resolved = resolve_user_path(path);
    let settings = state.settings.get().await;
    if !is_path_allowed(resolved.sandbox_target(), settings.allowed_file_paths.as_deref()) {
        return forbidden();
    }
    // Node's toFilesystemPath fallthrough — see read_file above.
    let resolved = resolved.fs_path.unwrap_or(resolved.display);
```

The rest of each handler already consumes `resolved` as a `String` filesystem path, so nothing else changes.

Finally, in `validate_dir` (as rewritten by Task 2), insert the sandbox prelude directly after `let resolved = resolve_user_path(trimmed);` (before the `is_dir` computation):

```rust
    let settings = state.settings.get().await;
    if !is_path_allowed(resolved.sandbox_target(), settings.allowed_file_paths.as_deref()) {
        return forbidden();
    }
```

and append one line to `validate_dir`'s doc comment: `/// With allowedFilePaths configured, targets outside the roots are rejected 403 like every other files endpoint (Node applies validatePath to this route — files-router.ts:232; closing a formerly-unexplained Rust parity gap).`

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-server files::tests`
Expected: PASS — all module tests including the 3 new ones.

- [ ] **Step 5: Full verification sweep**

Run, in order:

```bash
cargo fmt --all --check
cargo clippy -p freshell-platform -p freshell-server --all-targets -- -D warnings
cargo test -p freshell-platform
cargo test -p freshell-server
```

Expected: fmt no diffs; clippy exits 0; both test suites fully green (freshell-server also runs its `tests/` integration suites — unrelated to files.rs, must stay green).

- [ ] **Step 6: Commit**

```bash
git -C /home/dan/code/freshell/.worktrees/windows-path-files add crates/freshell-server/src/files.rs
git -C /home/dan/code/freshell/.worktrees/windows-path-files commit -m "feat(server): route files sandbox checks through path conversion" -m "Every is_path_allowed call site in files.rs now compares the converted
native path (Node validatePath parity), and read/stat/write access the
filesystem through the same conversion with Node's exact literal
fallthrough for unaddressable inputs. Windows-flavor paths now read/stat/
write through the WSL mount; POSIX/~ behavior is string-identical.
validate_dir gains the sandbox check it was missing (Node applies
validatePath to the route, files-router.ts:232 — the Rust gap was an
unexplained parity defect, not deliberate).

Verified: cargo fmt --all --check clean, clippy -p freshell-platform -p
freshell-server -D warnings clean, cargo test -p freshell-platform and
-p freshell-server => all passed.

Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240428069+microsoft-amplifier@users.noreply.github.com>"
```

---

## Spec-requirement → task coverage map

| Spec requirement | Covered by |
|---|---|
| 1. `validate_dir`: `C:\` / `D:\foo\bar` on WSL → valid:true via mount; non-WSL → invalid | Task 2 (impl + `validate_dir_accepts_windows_drive_on_wsl`, `validate_dir_windows_deep_path_and_missing_dir`, `validate_dir_windows_input_invalid_off_wsl`) |
| 2. `complete`: `C:\` lists `/mnt/c` but renders `C:\Users`, `C:\Windows`; partial `C:\Us` splits/filters/joins in input flavor; POSIX/`~` unchanged | Task 3 (impl + `complete_windows_*` tests, `complete_wsl_unc_partial_leaf_round_trips` end-to-end UNC composition, `complete_posix_regression_unchanged`); Task 2's `resolve_user_path_posix_and_tilde_unchanged` |
| 3. `mkdir`: convert windows input; 400-reject unresolvable; no literal `C:\` dir ever created | Task 4 (impl + `mkdir_windows_path_creates_under_mount`, `mkdir_rejects_unaddressable_windows_input_off_wsl`, `mkdir_rejects_unresolvable_windows_forms_even_on_wsl`) |
| 4. Sandbox checks compare the converted native path | Task 3 (`sandbox_target` + `sandbox_target_uses_converted_native_path`; wired into `complete`), Task 4 (wired into `mkdir`), Task 5 (wired into `read_file`/`stat_file`/`write_file` AND newly into `validate_dir` + `validate_dir_denies_path_outside_allowed_roots` — after Task 5, every files.rs endpoint checks `is_path_allowed` on the converted native path; the validate-dir gap was validated as an unexplained Node-parity defect and is closed, see Boundary notes). |
| 5. Reuse freshell-platform helpers; add missing ones there with unit tests | Task 1 (split/join helpers + tests); Tasks 2–4 compose only `freshell_platform::path` conversions — no conversion logic in files.rs |
| Testing: env-based WSL emulation w/ temp mount root; POSIX/~ regressions; no-literal-`C:\` test | Task 2 scaffolding (`WslMountFixture` via `WSL_DISTRO_NAME`/`WSL_WINDOWS_SYS32`); regression tests in Tasks 2–4; Task 4 Step 1 |
| Repo conventions: fmt/clippy/test per crate, standard checks | Every task's Steps 4–5; Task 4 Step 5 full sweep |
| Scope guard: Node server, client, launch-cwd untouched | Global Constraints; no task touches those paths |
