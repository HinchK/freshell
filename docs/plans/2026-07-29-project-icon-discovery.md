# Project Icon Discovery Improvement Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Make Freshell's repo-icon discovery find icons far more consistently — deeper search, more filename patterns, manifest support for .NET projects, and `.icns` support — preferring SOMETHING over NOTHING whenever any plausible icon exists.

**Architecture:** All changes live in the Rust server (`crates/freshell-server`), which is production (port 3002 per AGENTS.md). The detector (`repo_icon_detect.rs`) gains: broader static candidate lists (Tier 2/3), a new Tier-1 `.csproj` `<ApplicationIcon>` manifest reader, a new bounded breadth-first recursive Tier-4 walk (depth/entry-capped, with exclusions), and `.icns` support with embedded-PNG extraction at serve time (`repo_icon.rs`). The HTTP surface, caching, security model, client, and meta payload are otherwise unchanged.

**Tech Stack:** Rust (axum server, `tempfile` test fixtures, inline `#[cfg(test)]` modules), cargo test/fmt/clippy. No Node/TypeScript changes.

## Global Constraints

- **Rust only.** Icon discovery exists ONLY in `crates/freshell-server` (`repo_icon_detect.rs`, `repo_icon_git.rs`, `repo_icon.rs`). The Node server (`server/`) has NO icon implementation and must not gain one (original design constraint, `docs/plans/2026-07-28-repo-icons-on-tabs.md:20`); the client's letter-avatar fallback is the Node-dev-server contract. "Keep Node consistent" is satisfied by keeping Node icon-free.
- **TDD (Red-Green-Refactor) for every task.** Write the failing test, run it and observe the failure, implement minimally, observe pass, refactor, commit.
- **Automated tests use `tempfile::tempdir()` fixtures ONLY** — never `/home/dan/code/glowforge` or `/home/dan/code/winpepper`. Real directories are touched only by the `#[ignore]`d manual probe test in Task 5.
- **Gates (run before every commit):** `cargo test -p freshell-server repo_icon`, `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings` (toolchain 1.96.0).
- **Never restart the live Rust server on port 3002** (requires the user's explicit "APPROVED" — not needed by this plan; verification uses tests, not the live server).
- **No protocol / meta-payload changes.** `GET /api/repo-icon` and `/api/repo-icon/meta` response shapes are unchanged. No client changes.
- **Commits:** author must be `Dan Shapiro <3732858+danshapiro@users.noreply.github.com>` (already configured — do not override). Never use `dan@danshapiro.com` as git author. Focused, atomic commits.
- **PR pre-approval:** the user has ALREADY EXPLICITLY APPROVED PR creation AND merge — verified verbatim in the root session transcript: "Do this first, with the usual, and land it on main via PR (approved)". Task 6 pushes the branch, creates the PR targeting `main`, waits for required checks, merges, and fast-forwards local `main`. This satisfies the AGENTS.md rule requiring explicit approval before `gh pr create`. **SCOPE BOUNDARY:** the approval covers the icon-discovery work ONLY — the same user message explicitly defers the follow-on work (placeholder pixel fix, uniform tab widths, tab color/state changes) as "not to be landed until I approve". The branch must contain nothing from that follow-on scope, and approval does not waive CI: merge only on green required checks (`typecheck-client`, `clippy` — enforced via repo rulesets).
- **No broad npm test runs needed** (no client code touched). If any broad run is ever needed, use the coordinated runner (`npm run test:unit` / `npm test`), never raw `npx vitest`.
- **`docs/index.html` is NOT updated** (no user-visible UI change; the original icon feature made the same call).
- **Ordering hazard:** `CandidateSink.order` is a global monotonic counter that advances even for missing paths (`repo_icon_detect.rs:311-322`). Adding candidate sites shifts every later order value and can change tiebreaks at equal score. After each task, run the FULL `cargo test -p freshell-server repo_icon` suite and fix any order-sensitive expectations honestly (adjust the test's fixture, not the assertion semantics).
- **Scoring hazard:** `scoring_tests` hard-code exact totals (e.g. 95, 55). This plan does NOT change existing modifiers in `score_candidate` — new tiers encode their bonuses/penalties via the `Candidate.extra` field at push time, so existing exact-score tests keep passing (except the `.icns` rejection change in Task 4, handled explicitly there).

## Current State (orientation for implementers)

`detect_icon()` (`crates/freshell-server/src/repo_icon_detect.rs:700-708`) runs `tier1` (manifest-declared, score 100) → `tier2` (24 fixed conventional paths, 80) → `tier3` (root/asset-dir shallow prefix scan, 60) → `pick_best`. **Maximum search depth today is ~2 directory levels and there is no recursion anywhere** — that's why icons like `src/Winpepper.App/Assets/AppIcon.ico` (depth 3, declared in a `.csproj`) and a sub-project's `public/favicon.svg` inside a container directory (depth 2 under a root with no manifest) are missed. `score_candidate` (`:181-263`) applies modifiers (+15 square, +10 dims 32–512, +5 stem=="icon", +5 png/ico/svg, −20 aspect>1.6) and hard rejections (aspect>2.5, raster w<16, >2MB / SVG>256KB, `REJECTED_PATH_COMPONENTS`, `REJECTED_EXTENSIONS` incl. `icns`, framework-default sha256 blacklist, dangerous SVG). `pick_best` (`:265-288`) sorts by score, then enumeration order, then shortest rel path, then lexicographic.

Real-world test cases this plan must fix (verified on this machine, see Task 5):
- `/home/dan/code/glowforge` — container dir of 4 sibling projects; zero images at root; root `public/` exists but is EMPTY. Real icons: `gf-creative-studio/public/glowforge-icon.svg` (depth 2), `gf-design-system/design-system-assets/icons/glowforge-icon.svg` (depth 3). CAUTION: `gf-creative-studio/public/favicon.svg` (depth 2, 9,522 B, referenced by that subproject's `index.html`) is byte-identical to the `vite-default-logo-2026` framework-default sha256 blacklist entry (`repo_icon_detect.rs:110-113`) — it is the stock Vite favicon and is hard-rejected BY DESIGN; do not "fix" that rejection. Verified expected winner: `gf-creative-studio/public/glowforge-icon.svg` (scores 54 — non-square aspect 1.21, so the modest score is expected — vs. the `icons.svg` sprite mine at 44). False-positive mines: `coverage/lcov-report/favicon.png` (istanbul), `.factory/**/assets/app-icon.png` (plugin cache), ~17,580 image files total (cypress fixtures/screenshots).
- `/home/dan/code/winpepper` — .NET app. Real icon: `src/Winpepper.App/Assets/AppIcon.ico` (depth 3, 41,230 B), declared at `src/Winpepper.App/Winpepper.App.csproj:17` as `<ApplicationIcon>Assets\AppIcon.ico</ApplicationIcon>`. Mines: `docs/assets/header.png` (687 KB wide README banner at depth 2), `tests/*/bin/**/EmptyFiles/image/empty.ico` NuGet placeholders, `bin/**/publish/Assets/` build copies, `.worktrees/` duplicates.

---

### Task 1: Broaden static candidate lists (Tier 2 fixed paths + Tier 3 root names and prefix scan)

**Files:**
- Modify: `crates/freshell-server/src/repo_icon_detect.rs:592-643` (tier2 `FIXED` list), `:632-698` (tier3 root literals + prefix list)
- Test: same file, new `#[cfg(test)] mod static_candidates_tests` appended after the existing `detect_tests` module (which ends at `repo_icon_detect.rs:1158`)

**Interfaces:**
- Consumes: existing `detect_icon(repo_root: &Path) -> Option<PathBuf>`, `CandidateSink`, `TIER2`, `TIER3`, `push_dir_prefix_matches(sink, dir, prefixes, tier)`.
- Produces: no new symbols — only extended candidate data. Later tasks rely on tier3's prefix list including `"appicon"` and `"favicon"`.

- [ ] **Step 1: Write the failing tests**

Append to `crates/freshell-server/src/repo_icon_detect.rs` (after the closing brace of `detect_tests`):

```rust
#[cfg(test)]
mod static_candidates_tests {
    use super::*;
    use std::path::Path;

    /// Synthetic PNG: signature + IHDR only (png_dimensions reads just the header).
    fn write_png(path: &Path, w: u32, h: u32) {
        let mut bytes: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        bytes.extend_from_slice(&13u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&w.to_be_bytes());
        bytes.extend_from_slice(&h.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
        std::fs::write(path, bytes).unwrap();
    }

    /// Minimal valid single-image ICO: 6-byte header + one 16-byte dir entry
    /// + zero-filled image data (ico_largest_dimensions reads the dir entry).
    fn write_ico(path: &Path, w: u8, h: u8) {
        let mut bytes = vec![0u8, 0, 1, 0, 1, 0];
        bytes.extend_from_slice(&[w, h, 0, 0, 1, 0, 32, 0]);
        bytes.extend_from_slice(&40u32.to_le_bytes());
        bytes.extend_from_slice(&22u32.to_le_bytes());
        bytes.resize(22 + 40, 0);
        std::fs::write(path, bytes).unwrap();
    }

    #[test]
    fn finds_android_mipmap_launcher_icon() {
        let dir = tempfile::tempdir().unwrap();
        let res = dir.path().join("android/app/src/main/res/mipmap-xxxhdpi");
        std::fs::create_dir_all(&res).unwrap();
        write_png(&res.join("ic_launcher.png"), 192, 192);
        assert_eq!(
            detect_icon(dir.path()),
            Some(res.join("ic_launcher.png"))
        );
    }

    #[test]
    fn finds_root_app_ico() {
        let dir = tempfile::tempdir().unwrap();
        write_ico(&dir.path().join("app.ico"), 64, 64);
        assert_eq!(detect_icon(dir.path()), Some(dir.path().join("app.ico")));
    }

    #[test]
    fn finds_root_appicon_png() {
        let dir = tempfile::tempdir().unwrap();
        write_png(&dir.path().join("appicon.png"), 128, 128);
        assert_eq!(
            detect_icon(dir.path()),
            Some(dir.path().join("appicon.png"))
        );
    }

    #[test]
    fn asset_dir_prefix_scan_matches_appicon_and_favicon() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("resources")).unwrap();
        write_png(&dir.path().join("resources/appicon-main.png"), 128, 128);
        assert_eq!(
            detect_icon(dir.path()),
            Some(dir.path().join("resources/appicon-main.png"))
        );

        let dir2 = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir2.path().join("assets")).unwrap();
        write_png(&dir2.path().join("assets/favicon.png"), 64, 64);
        assert_eq!(
            detect_icon(dir2.path()),
            Some(dir2.path().join("assets/favicon.png"))
        );
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p freshell-server static_candidates_tests`
Expected: FAIL — all four tests, `assertion failed` with `left: None` (no candidates match today).

- [ ] **Step 3: Implement**

In `tier2` (`repo_icon_detect.rs:592`), extend the `FIXED` array by appending after `"build/appicon.png"`:

```rust
        "android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png",
        "android/app/src/main/res/mipmap-xxhdpi/ic_launcher.png",
        "android/app/src/main/res/mipmap-xhdpi/ic_launcher.png",
        "android/app/src/main/res/mipmap-hdpi/ic_launcher.png",
```

In `tier3` (`repo_icon_detect.rs:632`), after the existing `sink.push(root.join("app-icon.png"), TIER3);` line, add root literals:

```rust
    sink.push(root.join("icon.ico"), TIER3);
    sink.push(root.join("app.ico"), TIER3);
    sink.push(root.join("favicon.svg"), TIER3);
    sink.push(root.join("favicon.png"), TIER3);
    for ext in ["png", "svg", "ico"] {
        sink.push(root.join(format!("appicon.{ext}")), TIER3);
    }
```

Still in `tier3`, change the prefix list for the 10-directory scan from `&["icon", "logo"]` to:

```rust
        push_dir_prefix_matches(
            sink,
            &root.join(dir),
            &["icon", "logo", "appicon", "app-icon", "app_icon", "favicon"],
            TIER3,
        );
```

(Leave the `.github/assets` call's `&["logo"]` prefix unchanged.)

- [ ] **Step 4: Run tests to verify they pass, plus the full icon suite**

Run: `cargo test -p freshell-server static_candidates_tests`
Expected: PASS (4 tests).
Run: `cargo test -p freshell-server repo_icon`
Expected: PASS. If any existing ordering-sensitive test fails, inspect it — the new pushes shift `order` values; fix the test fixture so its intent still holds (do not weaken assertions).

- [ ] **Step 5: Lint gates and commit**

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
git add crates/freshell-server/src/repo_icon_detect.rs
git commit -m "feat(repo-icon): broaden static icon candidates (android mipmap, root app/appicon/favicon, wider prefix scan)"
```

---

### Task 2: Tier-1 `.csproj` `<ApplicationIcon>` manifest support

**Files:**
- Modify: `crates/freshell-server/src/repo_icon_detect.rs` — add `walk_dir_excluded`, `extract_xml_tag_value`, `collect_csprojs`, `csproj_candidates`; call `csproj_candidates(sink)` at the end of `tier1` (`:545-590`)
- Test: same file — new tests inside the existing `tier1_tests` module (`repo_icon_detect.rs:923-1065`), which provides `candidates_for(root)` (runs only `tier1`) and `has(cands, root, rel)` helpers

**Interfaces:**
- Consumes: `CandidateSink::push`, `TIER1`, `REJECTED_PATH_COMPONENTS`.
- Produces (used by Task 3):
  - `fn walk_dir_excluded(name: &str) -> bool` — true for directory basenames that deep scans must not enter: hidden (leading `.`), any `REJECTED_PATH_COMPONENTS` entry, or `target`/`bin`/`obj`/`__pycache__`/`venv`/`__fixtures__` (the last because `REJECTED_PATH_COMPONENTS` matches `fixtures` exactly and misses the dunder convention).
  - `fn extract_xml_tag_value(text: &str, tag: &str) -> Option<String>` — first `<tag>…</tag>` inner text.
  - `fn collect_csprojs(dir: &Path, depth: usize, out: &mut Vec<PathBuf>)` — recursive to depth ≤ 2 (dir levels below root), skipping excluded/symlinked dirs.

- [ ] **Step 1: Write the failing tests**

Add inside the existing `tier1_tests` module (before its closing brace):

```rust
    #[test]
    fn csproj_application_icon_is_tier1_candidate() {
        let dir = tempfile::tempdir().unwrap();
        let proj = dir.path().join("src/Winpepper.App");
        std::fs::create_dir_all(proj.join("Assets")).unwrap();
        std::fs::write(
            proj.join("Winpepper.App.csproj"),
            r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <ApplicationIcon>Assets\AppIcon.ico</ApplicationIcon>
  </PropertyGroup>
</Project>"#,
        )
        .unwrap();
        std::fs::write(proj.join("Assets/AppIcon.ico"), b"stub").unwrap();
        let cands = candidates_for(dir.path());
        assert!(has(&cands, dir.path(), "src/Winpepper.App/Assets/AppIcon.ico"));
        let c = cands
            .iter()
            .find(|c| c.path.ends_with("Assets/AppIcon.ico"))
            .unwrap();
        assert_eq!(c.tier_base, TIER1);
    }

    #[test]
    fn csproj_icon_path_traversal_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("Evil.csproj"),
            "<Project><PropertyGroup><ApplicationIcon>..\\..\\etc\\passwd</ApplicationIcon></PropertyGroup></Project>",
        )
        .unwrap();
        let cands = candidates_for(dir.path());
        assert!(!cands.iter().any(|c| c.path.to_string_lossy().contains("passwd")));
    }

    #[test]
    fn csproj_scan_skips_excluded_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let hidden = dir.path().join(".worktrees/dup");
        std::fs::create_dir_all(&hidden).unwrap();
        std::fs::write(
            hidden.join("Dup.csproj"),
            "<Project><PropertyGroup><ApplicationIcon>x.ico</ApplicationIcon></PropertyGroup></Project>",
        )
        .unwrap();
        std::fs::write(hidden.join("x.ico"), b"stub").unwrap();
        let cands = candidates_for(dir.path());
        assert!(!cands.iter().any(|c| c.path.to_string_lossy().contains(".worktrees")));
    }
```

Note: `candidates_for` collects tier1 candidates without scoring, so a stub (non-image) `.ico` file is fine here — enumeration is what's under test. If `tier1_tests`' `has` helper compares exact relative paths, the assertions above match it; adapt call syntax to the existing helpers if their signatures differ slightly (they are at `repo_icon_detect.rs:923-1065`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-server tier1_tests`
Expected: FAIL — `csproj_application_icon_is_tier1_candidate` fails (candidate absent); the two negative tests pass vacuously (that's OK; the positive test is the red).

- [ ] **Step 3: Implement**

Add near the other tier1 helper functions (e.g. after `read_json` at `repo_icon_detect.rs:325-331`):

```rust
/// Directory basenames a deep scan must never enter.
fn walk_dir_excluded(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.starts_with('.')
        || REJECTED_PATH_COMPONENTS.contains(&lower.as_str())
        || matches!(
            lower.as_str(),
            "target" | "bin" | "obj" | "__pycache__" | "venv" | "__fixtures__"
        )
}

/// First `<tag>…</tag>` inner text (naive but sufficient for MSBuild props).
fn extract_xml_tag_value(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(text[start..end].trim().to_string())
}

/// Collect `*.csproj` files up to `depth` == 2 directory levels below root.
fn collect_csprojs(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let is_symlink = path
            .symlink_metadata()
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(true);
        if is_symlink {
            continue;
        }
        if path.is_dir() {
            if depth < 2 && !walk_dir_excluded(name) {
                collect_csprojs(&path, depth + 1, out);
            }
        } else if name.to_lowercase().ends_with(".csproj") {
            out.push(path);
        }
    }
}

/// .NET: `<ApplicationIcon>` in any .csproj near the root (WinPepper pattern).
fn csproj_candidates(sink: &mut CandidateSink) {
    let root = sink.repo_root.clone();
    let mut csprojs: Vec<PathBuf> = Vec::new();
    collect_csprojs(&root, 0, &mut csprojs);
    csprojs.sort();
    // 32, not 10: winpepper already has 14 csprojs within depth <= 2 and the
    // target sorts at index 5 today — keep headroom so new sibling dirs
    // (artifacts/, packaging/, ...) can't evict the real manifest.
    csprojs.truncate(32);
    for csproj in csprojs {
        let Ok(text) = std::fs::read_to_string(&csproj) else {
            continue;
        };
        if text.len() > 1_048_576 {
            continue;
        }
        let Some(icon_rel) = extract_xml_tag_value(&text, "ApplicationIcon") else {
            continue;
        };
        let normalized = icon_rel.replace('\\', "/");
        if normalized.is_empty() || normalized.starts_with('/') || normalized.contains("..") {
            continue;
        }
        let base = csproj.parent().unwrap_or(&root).to_path_buf();
        sink.push(base.join(normalized), TIER1);
    }
}
```

In `tier1` (`repo_icon_detect.rs:545-590`), add as the final step before the closing brace:

```rust
    // 7. .NET: csproj ApplicationIcon.
    csproj_candidates(sink);
}
```

- [ ] **Step 4: Run tests to verify they pass, plus the full icon suite**

Run: `cargo test -p freshell-server tier1_tests`
Expected: PASS (all, including the 3 new).
Run: `cargo test -p freshell-server repo_icon`
Expected: PASS (fix any order-shift fallout per Global Constraints).

- [ ] **Step 5: Lint gates and commit**

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
git add crates/freshell-server/src/repo_icon_detect.rs
git commit -m "feat(repo-icon): tier-1 support for .csproj ApplicationIcon manifests"
```

---

### Task 3: Tier-4 bounded recursive deep scan

**Files:**
- Modify: `crates/freshell-server/src/repo_icon_detect.rs` — add `TIER4`, walk constants, `stem_name_bonus`, `tier4_walk`, `tier4`; call `tier4(&mut sink)` in `detect_icon` (`:700-708`); add `use std::collections::VecDeque;` to the file's imports
- Test: same file — new `#[cfg(test)] mod tier4_tests` module

**Interfaces:**
- Consumes: `walk_dir_excluded(name: &str) -> bool` (Task 2), `CandidateSink::push_extra(path, tier_base, extra)`, `pick_best`.
- Produces:
  - `pub(crate) const TIER4: i64 = 40;`
  - `fn stem_name_bonus(stem_lower: &str) -> Option<i64>` — `None` = filename is not icon-like (file skipped); `Some(bonus)` = name-match strength bonus (10 strong exact, 5 strong prefix / exact "logo", 3 weak prefix/suffix).
  - `fn tier4_walk(sink: &mut CandidateSink, max_entries: usize)` — BFS walk, depth ≤ `MAX_WALK_DEPTH` (4), entry-budgeted, exclusion- and symlink-safe.
  - `fn tier4(sink: &mut CandidateSink)` — calls `tier4_walk(sink, MAX_WALK_ENTRIES)` (8000).

- [ ] **Step 1: Write the failing tests**

Append a new module after `static_candidates_tests`:

```rust
#[cfg(test)]
mod tier4_tests {
    use super::*;
    use std::path::Path;

    fn write_png(path: &Path, w: u32, h: u32) {
        let mut bytes: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        bytes.extend_from_slice(&13u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&w.to_be_bytes());
        bytes.extend_from_slice(&h.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
        std::fs::write(path, bytes).unwrap();
    }

    fn write_ico(path: &Path, w: u8, h: u8) {
        let mut bytes = vec![0u8, 0, 1, 0, 1, 0];
        bytes.extend_from_slice(&[w, h, 0, 0, 1, 0, 32, 0]);
        bytes.extend_from_slice(&40u32.to_le_bytes());
        bytes.extend_from_slice(&22u32.to_le_bytes());
        bytes.resize(22 + 40, 0);
        std::fs::write(path, bytes).unwrap();
    }

    const SQUARE_SVG: &str = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 128 128\"/>";

    /// Glowforge shape: container root, empty root public/, real icon two
    /// levels down inside a sub-project, plus false-positive mines.
    #[test]
    fn finds_subproject_favicon_in_container_repo() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("public")).unwrap(); // empty decoy
        std::fs::create_dir_all(root.join("gf-creative-studio/public")).unwrap();
        std::fs::write(
            root.join("gf-creative-studio/public/favicon.svg"),
            SQUARE_SVG,
        )
        .unwrap();
        std::fs::create_dir_all(
            root.join("gf-design-system/design-system-assets/icons"),
        )
        .unwrap();
        std::fs::write(
            root.join("gf-design-system/design-system-assets/icons/glowforge-icon.svg"),
            SQUARE_SVG,
        )
        .unwrap();
        // Mines: coverage report favicon and hidden plugin-cache icon.
        std::fs::create_dir_all(root.join("coverage/lcov-report")).unwrap();
        write_png(&root.join("coverage/lcov-report/favicon.png"), 32, 32);
        std::fs::create_dir_all(root.join(".factory/assets")).unwrap();
        write_png(&root.join(".factory/assets/app-icon.png"), 128, 128);

        assert_eq!(
            detect_icon(root),
            Some(root.join("gf-creative-studio/public/favicon.svg"))
        );
    }

    /// WinPepper shape (without the csproj — pure walk): depth-3 AppIcon.ico
    /// wins over a wide README banner; bin/ copies are never entered.
    #[test]
    fn finds_deep_appicon_and_ignores_banner_and_bin() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let assets = root.join("src/Winpepper.App/Assets");
        std::fs::create_dir_all(&assets).unwrap();
        write_ico(&assets.join("AppIcon.ico"), 64, 64);
        std::fs::create_dir_all(root.join("docs/assets")).unwrap();
        write_png(&root.join("docs/assets/header.png"), 2000, 400); // aspect 5 -> hard reject
        let bin = root.join("src/Winpepper.App/bin/Release/publish/Assets");
        std::fs::create_dir_all(&bin).unwrap();
        write_ico(&bin.join("AppIcon.ico"), 64, 64);

        assert_eq!(detect_icon(root), Some(assets.join("AppIcon.ico")));
    }

    #[test]
    fn shallower_candidate_wins_over_deeper_one() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::create_dir_all(root.join("b/c/d")).unwrap();
        write_png(&root.join("a/favicon.png"), 128, 128);
        write_png(&root.join("b/c/d/favicon.png"), 128, 128);
        assert_eq!(detect_icon(root), Some(root.join("a/favicon.png")));
    }

    #[test]
    fn walk_respects_entry_budget() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("zz")).unwrap();
        // Budget of 3 entries: aaa.txt, bbb.txt, then budget exhausts before zz/ contents.
        std::fs::write(root.join("aaa.txt"), b"x").unwrap();
        std::fs::write(root.join("bbb.txt"), b"x").unwrap();
        write_png(&root.join("zz/icon.png"), 64, 64);
        let mut sink = CandidateSink::new(root.to_path_buf());
        tier4_walk(&mut sink, 3);
        assert!(sink.out.is_empty());
        // Full budget finds it.
        let mut sink2 = CandidateSink::new(root.to_path_buf());
        tier4_walk(&mut sink2, 8000);
        assert_eq!(sink2.out.len(), 1);
    }

    #[test]
    fn walk_does_not_exceed_max_depth() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let deep = root.join("l1/l2/l3/l4/l5");
        std::fs::create_dir_all(&deep).unwrap();
        write_png(&deep.join("icon.png"), 64, 64); // depth 5 -> beyond MAX_WALK_DEPTH=4
        assert_eq!(detect_icon(root), None);
    }

    #[test]
    fn appiconset_contents_are_candidates() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let set = root.join("ios/App/Assets.xcassets/AppIcon.appiconset");
        std::fs::create_dir_all(&set).unwrap();
        write_png(&set.join("100.png"), 100, 100); // no icon-like stem; dir rule applies
        assert_eq!(detect_icon(root), Some(set.join("100.png")));
    }

    #[cfg(unix)]
    #[test]
    fn walk_skips_symlinked_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::os::unix::fs::symlink(root, root.join("a/loop")).unwrap();
        // Must terminate and find nothing.
        assert_eq!(detect_icon(root), None);
    }

    #[test]
    fn walk_is_deterministic() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("x")).unwrap();
        std::fs::create_dir_all(root.join("y")).unwrap();
        write_png(&root.join("x/logo.png"), 64, 64);
        write_png(&root.join("y/logo.png"), 64, 64);
        let first = detect_icon(root);
        for _ in 0..5 {
            assert_eq!(detect_icon(root), first);
        }
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-server tier4_tests`
Expected: COMPILE ERROR (`tier4_walk` not found) — that is the red state for this task.

- [ ] **Step 3: Implement**

Add `use std::collections::VecDeque;` to the imports at the top of `repo_icon_detect.rs`.

Add after the `TIER3` constant (`repo_icon_detect.rs:151`):

```rust
pub(crate) const TIER4: i64 = 40;
/// Deep-scan bounds: directory levels below the repo root, and total
/// directory entries examined (files + dirs) before the walk gives up.
const MAX_WALK_DEPTH: usize = 4;
const MAX_WALK_ENTRIES: usize = 8000;
```

Add after `tier3` (`repo_icon_detect.rs:698`):

```rust
/// Name-match strength for the deep scan. `None` = not icon-like at all.
fn stem_name_bonus(stem_lower: &str) -> Option<i64> {
    if matches!(
        stem_lower,
        "icon" | "appicon" | "app-icon" | "app_icon" | "favicon"
    ) {
        return Some(10);
    }
    if stem_lower.starts_with("appicon")
        || stem_lower.starts_with("app-icon")
        || stem_lower.starts_with("app_icon")
        || stem_lower.starts_with("favicon")
        || stem_lower.starts_with("icon-")
        || stem_lower.starts_with("icon_")
        || stem_lower == "logo"
    {
        return Some(5);
    }
    if stem_lower.starts_with("icon")
        || stem_lower.starts_with("logo")
        || stem_lower.ends_with("-icon")
        || stem_lower.ends_with("_icon")
        || stem_lower.ends_with("-logo")
        || stem_lower.ends_with("_logo")
    {
        return Some(3);
    }
    None
}

/// Tier 4: bounded breadth-first deep scan. BFS guarantees shallow candidates
/// enumerate first (winning `order` tiebreaks) and that the entry budget is
/// spent near the root where real icons live. Depth penalty (-2/level) plus
/// the name bonus ride the `extra` field so `score_candidate` stays untouched.
fn tier4_walk(sink: &mut CandidateSink, max_entries: usize) {
    const EXTS: &[&str] = &["svg", "png", "ico", "webp", "jpg", "jpeg", "gif"];
    let root = sink.repo_root.clone();
    let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::new();
    queue.push_back((root, 0));
    let mut visited = 0usize;
    while let Some((dir, depth)) = queue.pop_front() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let in_appiconset = dir
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.to_lowercase().ends_with(".appiconset"));
        let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
        paths.sort();
        for path in paths {
            visited += 1;
            if visited > max_entries {
                return;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let is_symlink = path
                .symlink_metadata()
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(true);
            if is_symlink {
                continue;
            }
            if path.is_dir() {
                if depth < MAX_WALK_DEPTH && !walk_dir_excluded(name) {
                    queue.push_back((path, depth + 1));
                }
                continue;
            }
            let ext_ok = path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| EXTS.contains(&e.to_lowercase().as_str()));
            if !ext_ok {
                continue;
            }
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_lowercase();
            let bonus = if in_appiconset {
                Some(5)
            } else {
                stem_name_bonus(&stem)
            };
            let Some(bonus) = bonus else {
                continue;
            };
            let depth_penalty = 2 * depth as i64;
            sink.push_extra(path.clone(), TIER4, bonus - depth_penalty);
        }
    }
}

fn tier4(sink: &mut CandidateSink) {
    tier4_walk(sink, MAX_WALK_ENTRIES);
}
```

Update `detect_icon` (`repo_icon_detect.rs:700-708`):

```rust
/// The detector entry point: bounded tiered scan, scored, deterministic.
pub(crate) fn detect_icon(repo_root: &Path) -> Option<PathBuf> {
    let mut sink = CandidateSink::new(repo_root.to_path_buf());
    tier1(&mut sink);
    tier2(&mut sink);
    tier3(&mut sink);
    tier4(&mut sink);
    let root = sink.repo_root.clone();
    pick_best(&root, sink.out)
}
```

Notes for the implementer:
- Hidden dirs are excluded from the walk (`walk_dir_excluded`), which covers `.git`, `.worktrees`, `.factory`, `.venv`, `.next`, `.cache`. Tier 3 still probes `.github` explicitly, so nothing regresses there.
- `coverage`, `fixtures`, `tests`, `dist`, `node_modules`, `vendor` etc. are pruned at walk time via `REJECTED_PATH_COMPONENTS` inside `walk_dir_excluded`, AND still hard-rejected at score time for candidates from other tiers — defense in depth.
- Files found by both tier3 and tier4 (e.g. root `icon.png`) simply become two candidates for the same path; `pick_best` handles that (higher-tier one wins).
- TIE-SAFETY (load-bearing, verified by exhaustive score enumeration): tier-4's maximum possible total (85) exactly EQUALS tier-1's minimum; the "tier-4 never beats tier-1" guarantee rests on ties breaking by enumeration order, i.e. on `detect_icon` pushing tiers sequentially (1→2→3→4) onto ONE sink. Do not reorder the tier calls or split enumeration across sinks.

- [ ] **Step 4: Run tests to verify they pass, plus the full icon suite**

Run: `cargo test -p freshell-server tier4_tests`
Expected: PASS (9 tests).
Run: `cargo test -p freshell-server repo_icon`
Expected: PASS — pay attention to `detect_tests::detection_is_deterministic` and `scoring_tests::pick_best_prefers_score_then_order_then_shortest_path`; fix any order-shift fallout per Global Constraints.

- [ ] **Step 5: Add an HTTP-level regression test (deep icon served end-to-end)**

In `crates/freshell-server/src/repo_icon.rs`, inside the existing `tests` module (`repo_icon.rs:285-557`), add a test following the exact pattern of the existing router tests (reuse the module's `test_state()`, `get()`, `body_json()` helpers — read a neighboring test first and mirror its setup):

```rust
    #[tokio::test]
    async fn serves_icon_found_by_deep_scan() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let assets = root.join("src/App/Assets");
        std::fs::create_dir_all(&assets).unwrap();
        // Minimal valid ICO (same byte layout as tier4_tests::write_ico).
        let mut ico = vec![0u8, 0, 1, 0, 1, 0];
        ico.extend_from_slice(&[64, 64, 0, 0, 1, 0, 32, 0]);
        ico.extend_from_slice(&40u32.to_le_bytes());
        ico.extend_from_slice(&22u32.to_le_bytes());
        ico.resize(22 + 40, 0);
        std::fs::write(assets.join("AppIcon.ico"), ico).unwrap();

        let (router, token) = test_state(root);
        let meta = get(&router, &token, &format!("/api/repo-icon/meta?cwd={}", urlencoding_encode(root))).await;
        assert_eq!(meta.status(), 200);
        assert_eq!(body_json(meta).await["hasIcon"], true);
        let icon = get(&router, &token, &format!("/api/repo-icon?cwd={}", urlencoding_encode(root))).await;
        assert_eq!(icon.status(), 200);
    }
```

(The helper names/signatures above mirror the report of `repo_icon.rs:285-557`; adjust the call shapes to the module's actual helpers — the assertions, fixture layout, and endpoints are the contract.)

Run: `cargo test -p freshell-server repo_icon::tests`
Expected: PASS including `serves_icon_found_by_deep_scan`.

- [ ] **Step 6: Lint gates and commit**

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
git add crates/freshell-server/src/repo_icon_detect.rs crates/freshell-server/src/repo_icon.rs
git commit -m "feat(repo-icon): tier-4 bounded recursive deep scan (BFS, depth/entry caps, exclusions)"
```

---

### Task 4: `.icns` support (accept, score via embedded PNG, serve extracted PNG)

**Files:**
- Modify: `crates/freshell-server/src/repo_icon_detect.rs` — remove `"icns"` from `REJECTED_EXTENSIONS` (`:168`); add `icns_embedded_png`; extend `score_candidate` dims/bonus handling; add `"icns"` to tier4 `EXTS` and to `push_dir_prefix_matches` `EXTS` (`:645-650`)
- Modify: `crates/freshell-server/src/repo_icon.rs` — serve-time PNG extraction for `.icns` winners
- Test: `repo_icon_detect.rs` probe/detect tests + one HTTP test in `repo_icon.rs`

**Interfaces:**
- Consumes: `png_dimensions(bytes: &[u8]) -> Option<(u32, u32)>` (`repo_icon_detect.rs:7`).
- Produces: `pub(crate) fn icns_embedded_png(bytes: &[u8]) -> Option<Vec<u8>>` — largest embedded PNG payload in an ICNS container, used by both scorer and HTTP server.

- [ ] **Step 1: Check for existing tests pinning `.icns` rejection**

Run: `grep -n "icns" crates/freshell-server/src/repo_icon_detect.rs crates/freshell-server/src/repo_icon.rs`
Any existing test asserting that `.icns` candidates are rejected must be UPDATED in Step 4 to assert the new, narrower rule: an `.icns` file **without** an embedded PNG is rejected; one **with** an embedded PNG is accepted. Keep the test names, change the fixtures/assertions to match the new contract.

- [ ] **Step 2: Write the failing tests**

Append a new module in `repo_icon_detect.rs`:

```rust
#[cfg(test)]
mod icns_tests {
    use super::*;
    use std::path::Path;

    fn png_bytes(w: u32, h: u32) -> Vec<u8> {
        let mut bytes: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        bytes.extend_from_slice(&13u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&w.to_be_bytes());
        bytes.extend_from_slice(&h.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
        bytes
    }

    /// ICNS container wrapping the given elements: (type, payload).
    fn icns_bytes(elements: &[(&[u8; 4], &[u8])]) -> Vec<u8> {
        let mut body: Vec<u8> = Vec::new();
        for (typ, data) in elements {
            body.extend_from_slice(*typ);
            body.extend_from_slice(&((data.len() as u32) + 8).to_be_bytes());
            body.extend_from_slice(data);
        }
        let mut out = b"icns".to_vec();
        out.extend_from_slice(&((body.len() as u32) + 8).to_be_bytes());
        out.extend_from_slice(&body);
        out
    }

    #[test]
    fn extracts_largest_embedded_png() {
        let small = png_bytes(32, 32);
        let large = png_bytes(256, 256);
        let icns = icns_bytes(&[(b"ic04", &small), (b"ic09", &large)]);
        let extracted = icns_embedded_png(&icns).unwrap();
        assert_eq!(png_dimensions(&extracted), Some((256, 256)));
    }

    #[test]
    fn icns_without_png_yields_none() {
        let icns = icns_bytes(&[(b"ic04", b"notapng")]);
        assert!(icns_embedded_png(&icns).is_none());
        assert!(icns_embedded_png(b"garbage").is_none());
    }

    #[test]
    fn detects_icns_icon_file(){
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("assets")).unwrap();
        let png = png_bytes(128, 128);
        let icns = icns_bytes(&[(b"ic07", &png)]);
        std::fs::write(root.join("assets/AppIcon.icns"), icns).unwrap();
        assert_eq!(
            detect_icon(root),
            Some(root.join("assets/AppIcon.icns"))
        );
    }

    #[test]
    fn icns_without_embedded_png_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let icns = icns_bytes(&[(b"is32", b"\x00\x01\x02\x03")]);
        std::fs::write(root.join("icon.icns"), icns).unwrap();
        assert_eq!(detect_icon(root), None);
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test -p freshell-server icns_tests`
Expected: COMPILE ERROR (`icns_embedded_png` not found) — red state.

- [ ] **Step 4: Implement detector-side**

In `repo_icon_detect.rs`:

1. Change `REJECTED_EXTENSIONS` (`:168`) to:

```rust
const REJECTED_EXTENSIONS: &[&str] = &["xml", "icon"];
```

2. Add near the byte probes (after `ico_largest_dimensions`):

```rust
/// ICNS container: 8-byte header (b"icns" + BE total len), then elements of
/// 4-byte type + 4-byte BE len (incl. the 8-byte element header) + payload.
/// Modern element types carry raw PNG; return the widest embedded PNG.
pub(crate) fn icns_embedded_png(bytes: &[u8]) -> Option<Vec<u8>> {
    const PNG_SIG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    if bytes.len() < 8 || &bytes[0..4] != b"icns" {
        return None;
    }
    let mut off = 8usize;
    let mut best: Option<(u32, Vec<u8>)> = None;
    while off + 8 <= bytes.len() {
        let len = u32::from_be_bytes([
            bytes[off + 4],
            bytes[off + 5],
            bytes[off + 6],
            bytes[off + 7],
        ]) as usize;
        if len < 8 || off + len > bytes.len() {
            break;
        }
        let data = &bytes[off + 8..off + len];
        if data.len() >= 8 && data[0..8] == PNG_SIG {
            let width = png_dimensions(data).map(|(w, _)| w).unwrap_or(0);
            if best.as_ref().is_none_or(|(bw, _)| width > *bw) {
                best = Some((width, data.to_vec()));
            }
        }
        off += len;
    }
    best.map(|(_, png)| png)
}
```

(Use `is_none_or`, not `map_or` — matches this file's clippy posture, see comments at `repo_icon_detect.rs:43,469`.)

3. In `score_candidate` (`:181-263`): add an `"icns"` arm to the `dims` match, and hard-reject PNG-less icns:

```rust
        "icns" => {
            let Some(png) = icns_embedded_png(&bytes) else {
                return None; // .icns with no embedded PNG cannot be served
            };
            png_dimensions(&png).map(|(w, h)| (f64::from(w), f64::from(h)))
        }
```

Also add `"icns"` to the `is_raster` matches list and to the final format-bonus list (`"png" | "ico" | "svg" | "icns"`) — it is served as PNG.

4. In `push_dir_prefix_matches` (`:645-650`) change `EXTS` to `&["svg", "png", "ico", "webp", "jpg", "icns"]`, and in `tier4_walk` change `EXTS` to `&["svg", "png", "ico", "webp", "jpg", "jpeg", "gif", "icns"]`.

- [ ] **Step 5: Run detector tests**

Run: `cargo test -p freshell-server icns_tests && cargo test -p freshell-server repo_icon_detect`
Expected: PASS. If Step 1's grep found old `.icns`-rejection tests, update them now as described there and re-run.

- [ ] **Step 6: Write the failing HTTP test (icns served as PNG)**

In `repo_icon.rs`'s `tests` module (mirror neighboring helper usage as in Task 3 Step 5):

```rust
    #[tokio::test]
    async fn serves_icns_winner_as_png() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        // Build an icns wrapping a 128x128 synthetic PNG (same layout as icns_tests).
        let mut png: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&128u32.to_be_bytes());
        png.extend_from_slice(&128u32.to_be_bytes());
        png.extend_from_slice(&[8, 6, 0, 0, 0]);
        let mut body = b"ic07".to_vec();
        body.extend_from_slice(&((png.len() as u32) + 8).to_be_bytes());
        body.extend_from_slice(&png);
        let mut icns = b"icns".to_vec();
        icns.extend_from_slice(&((body.len() as u32) + 8).to_be_bytes());
        icns.extend_from_slice(&body);
        std::fs::write(root.join("icon.icns"), icns).unwrap();

        let (router, token) = test_state(root);
        let resp = get(&router, &token, &format!("/api/repo-icon?cwd={}", urlencoding_encode(root))).await;
        assert_eq!(resp.status(), 200);
        assert_eq!(
            resp.headers().get("content-type").unwrap(),
            "image/png"
        );
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        assert_eq!(&bytes[0..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
    }
```

Run: `cargo test -p freshell-server repo_icon::tests::serves_icns_winner_as_png`
Expected: FAIL (content-type will be `application/octet-stream` and body raw icns, or the icon may be found but served wrong).

- [ ] **Step 7: Implement serve-time extraction**

In `crates/freshell-server/src/repo_icon.rs`, in `serve_icon` — after the winner's bytes are read from disk and before the response headers/body are assembled (the extension→content-type mapping is at `repo_icon.rs:161-172`; the SVG re-check is at `:231-235`) — add:

```rust
    // .icns cannot render in <img>; serve the embedded PNG instead.
    if ext.eq_ignore_ascii_case("icns") {
        match crate::repo_icon_detect::icns_embedded_png(&bytes) {
            Some(png) => {
                bytes = png;
                content_type = "image/png";
            }
            None => return StatusCode::NOT_FOUND.into_response(),
        }
    }
```

Adapt variable names (`ext`, `bytes`, `content_type`) to the actual locals in `serve_icon`; the behavior contract is: icns winner ⇒ body = extracted PNG bytes, `Content-Type: image/png`; extraction failure ⇒ 404 (defense in depth — the scorer already rejects PNG-less icns). The existing ETag (path|mtime|size) needs no change.

- [ ] **Step 8: Run tests to verify pass, plus the full icon suite**

Run: `cargo test -p freshell-server repo_icon`
Expected: PASS including `serves_icns_winner_as_png`.

- [ ] **Step 9: Lint gates and commit**

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
git add crates/freshell-server/src/repo_icon_detect.rs crates/freshell-server/src/repo_icon.rs
git commit -m "feat(repo-icon): accept .icns icons and serve their embedded PNG"
```

---

### Task 5: Full verification + manual probe against the real directories

**Files:**
- Modify: `crates/freshell-server/src/repo_icon_detect.rs` — add one `#[ignore]`d manual probe test
- No other files.

**Interfaces:**
- Consumes: `detect_icon`.
- Produces: `manual_real_dir_probe` (ignored test, env-driven) — the sanctioned way to run the detector against real local directories without touching any server.

- [ ] **Step 1: Add the ignored manual probe test**

Append inside `tier4_tests` (or as its own tiny module):

```rust
    /// Manual verification against real local directories. Never runs in CI.
    /// Usage:
    ///   ICON_PROBE_DIRS="/home/dan/code/glowforge:/home/dan/code/winpepper" \
    ///     cargo test -p freshell-server manual_real_dir_probe -- --ignored --nocapture
    #[test]
    #[ignore = "manual probe against real local directories via ICON_PROBE_DIRS"]
    fn manual_real_dir_probe() {
        let dirs = std::env::var("ICON_PROBE_DIRS").unwrap_or_default();
        assert!(!dirs.is_empty(), "set ICON_PROBE_DIRS=/path/a:/path/b");
        for dir in dirs.split(':').filter(|s| !s.is_empty()) {
            let start = std::time::Instant::now();
            let found = detect_icon(std::path::Path::new(dir));
            println!(
                "probe {dir}: {:?} ({} ms)",
                found,
                start.elapsed().as_millis()
            );
        }
    }
```

- [ ] **Step 2: Run the full icon suites and repo gates**

```bash
cargo test -p freshell-server repo_icon
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
```
Expected: all PASS / clean.

- [ ] **Step 3: Run the manual probe against the real directories**

```bash
ICON_PROBE_DIRS="/home/dan/code/glowforge:/home/dan/code/winpepper" \
  cargo test -p freshell-server manual_real_dir_probe -- --ignored --nocapture
```

Expected (acceptance criteria from the spec):
- **winpepper** MUST resolve to `Some(.../src/Winpepper.App/Assets/AppIcon.ico)` (Tier-1 csproj `<ApplicationIcon>`; the icon exists and must be found). Note: `detect_icon` runs on the repo root as given — if the probe prints a different-but-plausible AppIcon variant (e.g. one of the `AppIcon-*.ico` siblings), that still satisfies "SOMETHING over NOTHING" but investigate why the csproj-declared one didn't win before accepting it.
- **glowforge** MUST resolve to `Some(...)` — expected `.../gf-creative-studio/public/glowforge-icon.svg` (verified against the real tree: it outscores every reachable candidate). It must NOT be `gf-creative-studio/public/favicon.svg` — that file is the stock Vite favicon, byte-identical to the framework-default blacklist entry, and its rejection is correct behavior, not a regression. It must NOT be `coverage/lcov-report/favicon.png` or anything under a hidden directory.
- Each probe should complete in well under a second (bounded walk); if glowforge takes multiple seconds, reduce cost by checking the exclusion list against what the walk visits — do not raise the caps.

If either expectation fails, this task is NOT done: diagnose (add a temporary `--nocapture` println or a focused unit test reproducing the real layout in a tempdir fixture), fix in the appropriate earlier task's code, keep all tests green, and re-run the probe.

- [ ] **Step 4: Record what was found**

Copy the two probe output lines. They go verbatim into (a) this task's commit message body and (b) the PR description in Task 6 — this is the spec's required "report what was found there" for glowforge.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-server/src/repo_icon_detect.rs
git commit -m "test(repo-icon): add ignored manual probe for real-directory verification" \
  -m "Probe results on this machine:" \
  -m "<paste the two probe output lines here>"
```

---

### Task 6: Land it — push, PR, checks, merge, fast-forward main

**Pre-approval:** The user already explicitly approved BOTH PR creation and merge for this change — verified verbatim in the root session transcript: "Do this first, with the usual, and land it on main via PR (approved)". Do not ask again. The approval is scoped to icon discovery only (see Global Constraints SCOPE BOUNDARY) and does not waive required checks.

**Environment notes (verified):** gh 2.45.0 is authenticated as `danshapiro` (push+admin on origin `danshapiro/freshell`) — two gh accounts are configured; stay on the active `danshapiro` account. Non-interactive shells may lack `~/.cargo/bin` on PATH — if `cargo` is not found, `export PATH="$HOME/.cargo/bin:$PATH"` first. Required checks (`typecheck-client`, `clippy`) are enforced via repo rulesets, so `gh pr checks --watch` is meaningful (note: the classic branch-protection API 404s; rules live at `gh api repos/{owner}/{repo}/rules/branches/main` if ever needed).

**Files:** none (git/GitHub operations only).

**Interfaces:**
- Consumes: the completed, committed branch in this worktree.
- Produces: merged PR on `main`; local `main` fast-forwarded.

- [ ] **Step 1: Final gate run**

```bash
cd /home/dan/code/freshell/.worktrees/project-icon-discovery
cargo test -p freshell-server repo_icon
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
git status --short   # expect: clean (all work committed)
git log --oneline main..HEAD           # every commit must be icon-discovery scope
git diff --stat main...HEAD            # expect ONLY repo_icon* files + docs/plans/2026-07-29-project-icon-discovery.md
```

Scope gate: the user's pre-approval covers icon discovery ONLY. If the diff touches anything outside `crates/freshell-server/src/repo_icon*.rs` and this plan document (e.g. tab-width/tab-color/placeholder-pixel work), STOP — do not create the PR; that work needs separate approval.

- [ ] **Step 2: Push the branch**

```bash
BRANCH=$(git branch --show-current)
git push -u origin "$BRANCH"
```

- [ ] **Step 3: Create the PR targeting main**

```bash
gh pr create --base main --title "feat(repo-icon): much more thorough project icon discovery" --body "$(cat <<'EOF'
## Summary
- Tier-1: read `<ApplicationIcon>` from `*.csproj` (depth ≤ 2) — finds .NET app icons like WinPepper's
- Tier-2/3: more conventional paths (android mipmap ic_launcher, root app.ico/appicon.*/favicon.*, wider asset-dir prefixes incl. appicon/favicon)
- New Tier-4: bounded BFS deep scan (depth ≤ 4, ≤ 8000 entries, hidden/build/vendor dirs excluded, symlink-safe) with name-strength bonus and depth penalty — prefers SOMETHING over NOTHING
- `.icns` accepted; embedded PNG extracted and served as `image/png`
- Rust server only (production path); no client, protocol, or Node changes

## Real-directory verification (manual probe)
<paste the two probe output lines from Task 5 here>

## Testing
- `cargo test -p freshell-server repo_icon` (detector, git resolver, HTTP — incl. new static/tier4/icns/deep-serve tests, all tempdir fixtures)
- `cargo fmt --all --check` / `cargo clippy --workspace --all-targets -- -D warnings`

PR creation and merge pre-approved by the user: "land it on main via PR (approved)".
EOF
)"
```

- [ ] **Step 4: Wait for required checks**

```bash
gh pr checks --watch
```
Expected: all required checks pass. If a check fails, fix it on the branch (TDD applies), push, and watch again. Do not merge red.

- [ ] **Step 5: Merge (pre-approved) and fast-forward local main**

```bash
gh pr merge --merge
git -C /home/dan/code/freshell fetch origin
git -C /home/dan/code/freshell pull --ff-only origin main
```
Expected: PR merged into `main` (merge commit, matching repo history convention); local `main` at `/home/dan/code/freshell` fast-forwards cleanly. If `main` cannot fast-forward because another agent moved it, `git -C /home/dan/code/freshell pull --ff-only origin main` again after their operation completes — never force.

Note: deployment/restart of the live 3002 server is OUT OF SCOPE — a server restart requires the user's separate explicit "APPROVED" and is not part of this plan. The improvement takes effect for cached repos only after a restart or cache expiry; that's expected (positive icon cache re-validates by winner mtime+size; negative entries expire after 60 s).

---

## Self-Review (performed at plan-writing time)

**1. Spec coverage:**
- "Find existing icon-discovery code, understand strategy" — done during planning; documented in Current State (Rust-only, `repo_icon_detect.rs`, max depth ~2, no recursion).
- "Search deeper with sensible depth/inode limits and exclusions" — Task 3 (BFS, depth ≤ 4, ≤ 8000 entries, node_modules/.git(hidden)/target/dist/bin/obj/vendor/coverage/tests excluded, symlink-safe).
- "More filename patterns: icon.*, logo.*, favicon.*, app.ico, appicon.*, *.icns, public/assets/resources/build, src/assets, electron-builder/tauri/android/ios conventions, package.json/tauri.conf.json/manifest references" — electron-builder/tauri/web-manifest/index.html already exist (Tier 1/2); Task 1 adds android mipmap + root app.ico/appicon.*/favicon.* + appicon/favicon prefixes; Task 2 adds .csproj manifests; Task 3's walk covers src/assets and iOS `AppIcon.appiconset`; Task 4 adds `.icns`.
- "Prefer best candidate by heuristics (name strength, location, size/format), prefer SOME over none" — existing scoring retained; Task 3 adds name-strength bonus + depth penalty via `extra`; any surviving candidate beats none.
- "Verify against glowforge and WinPepper; report findings; automated tests use fixtures" — Task 5 (ignored env-driven probe, results recorded in commit + PR body); every automated test uses `tempfile::tempdir()`; glowforge/winpepper SHAPES are replicated as fixtures in Task 3.
- "Rust server is production; keep Node consistent" — all changes Rust-side; Node has no icon logic by design (Global Constraints).
- "TDD discipline" — every task is Red-Green-Refactor with exact commands and expected failures.
- "Pre-approved PR + merge + ff main" — Task 6.

**1b. No silent deferrals:** No stubs, mocks, or fake providers stand in for required behavior. The observable production outcomes: deep icons detected (tier4 unit + detect tests), served over the real router (Task 3 Step 5 HTTP test; Task 4 Step 6 icns HTTP test), and confirmed against the real directories (Task 5 probe). The only "stub" bytes are Task 2's tier-1 enumeration tests (enumeration ≠ scoring, and scoring of real ico bytes is covered by Task 3's tests and Task 3 Step 5 end-to-end). No requirement is moved to known limitations/future work. (The live-3002 restart exclusion is not a scope reduction — the spec's verification requirement is met by the real-directory probe, and restarting production explicitly requires separate user approval per AGENTS.md.)

**2. Placeholder scan:** No TBD/TODO/"handle edge cases" steps; every code step shows the code. Two tests (Task 3 Step 5, Task 4 Step 6) intentionally instruct mirroring existing in-module helper signatures (`test_state`, `get`, `body_json` at `repo_icon.rs:285-557`) — full test bodies are given; only helper call shapes may need mechanical adaptation to code the implementer can see right next to the test.

**Stage-2 load-bearing validation addendum (2026-07-29):** All 10 load-bearing assumptions verified against the real machine (ledger: `.worktrees/.the-usual-logs/project-icon-discovery/load-bearing-ledger.md`). Corrections applied: (a) glowforge's `favicon.svg` is the stock Vite favicon (byte-identical to the `vite-default-logo-2026` blacklist entry) — expected winner corrected to `glowforge-icon.svg` in Current State and Task 5; (b) `collect_csprojs` truncation raised 10→32 (14 csprojs already within depth ≤2 of winpepper); (c) `__fixtures__` added to `walk_dir_excluded`; (d) tier-4/tier-1 tie-safety note added to Task 3 (tier-4 max 85 = tier-1 min; sequential tier pushes are load-bearing); (e) Task 6 gained a verified pre-approval quote, a scope gate (approval covers icon discovery only — follow-on tab work must not land), and environment notes (gh account, PATH, ruleset-enforced checks). Verified baseline: current `repo_icon` suite 43/43 green, fmt+clippy clean, toolchain 1.96.0. Self-review re-run over edited tasks: no new stubs/deferrals (1b holds — edits only tighten acceptance criteria and bounds); no placeholders introduced; interface texts updated to match code changes (`walk_dir_excluded`, truncate).

**3. Type consistency:** `walk_dir_excluded(name: &str) -> bool` defined in Task 2, consumed in Task 3. `icns_embedded_png(bytes: &[u8]) -> Option<Vec<u8>>` defined `pub(crate)` in Task 4 detector, consumed by `repo_icon.rs` in the same task. `tier4_walk(sink: &mut CandidateSink, max_entries: usize)` matches its test usage. `TIER4: i64` matches `tier_base: i64`. `push_extra(path, tier_base, extra)` matches the existing sink signature (`repo_icon_detect.rs:146`). Consistent throughout.
