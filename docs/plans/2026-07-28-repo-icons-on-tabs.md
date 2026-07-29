# Repo Icons on Tabs — Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Show a small repo icon (detected from the repo's own files, or a deterministic letter avatar) immediately left of each coding-agent icon on tabs, gated by a new `panes.repoIconsOnTabs` setting (default ON), served by a new Rust-server endpoint.

**Architecture:** A new Rust (`crates/freshell-server`) module resolves a repo root from a supplied cwd (pure `.git` filesystem walk, worktree-aware), runs a tiered icon-detection heuristic over a bounded set of candidate paths, and serves the winning file over `GET /api/repo-icon?cwd=…` (cookie-authed, ETag-cached) plus a JSON probe `GET /api/repo-icon/meta?cwd=…`. The client derives a per-pane cwd hint from existing Redux data (`terminalMeta` → `initialCwd` → `tab.initialCwd`), probes the meta endpoint once per distinct cwd (cached in a new `repoIcons` slice), and renders a new `RepoIcon` component (server `<img>` or letter-avatar SVG) in `TabItem.renderIcons`, deduped per repo. No WS-protocol or `port/contract` changes.

**Tech Stack:** Rust (axum 0.8, serde_json, sha2, regex — all existing deps; no new crates), React 18 + Redux Toolkit + TypeScript, Vitest + Testing Library, cargo test with `tempfile`.

## Global Constraints

- TDD (Red-Green-Refactor) mandatory for every task; run the failing test before implementing.
- Coding-agent panes only: terminal panes with non-shell `mode` + `fresh-agent` panes. Plain shell tabs are OUT OF SCOPE (no OSC-7 / cwd tracking is added).
- Fallback when no icon detected: letter avatar — first letter of repo name (uppercase), in a circle, deterministic hue from repo name hash. Client-rendered, no server bytes.
- Setting `panes.repoIconsOnTabs`, default **ON**, browser-local — follow the exact `panes.iconsOnTabs`/`multirowTabs` pattern. No per-repo user override mechanism.
- Server side is **Rust only** (`crates/freshell-server`). Do NOT implement in the Node `server/`. Client must degrade gracefully when the endpoint is absent (Node dev server): fall back to the letter avatar.
- Detection scope v1: the tiered detector below only. Skip README-image parsing, .desktop/hicolor, .icns extraction, name-matching icon CDNs.
- Security: canonicalize (realpath) both the supplied path and the winning candidate; candidate MUST be inside the repo root after symlink resolution. The `allowed_file_paths` sandbox is enforced THREE times: on the raw normalized cwd (files.rs parity), re-checked on the CANONICAL cwd (symlink-escape defense — parity with Node's realpath-before-allowlist in `server/path-utils.ts:291-313`), and on the CANONICAL resolved repo root (the `.git` walk goes upward and must never serve bytes from an ancestor outside the sandbox). SVG served with `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`, `Content-Disposition: inline`; SVGs containing `<!DOCTYPE` or `<!ENTITY` are rejected. Client renders icons ONLY via `<img src>` (never inline SVG into the DOM).
- Auth for the icon `<img>`: the existing `freshell-auth` cookie (accepted by `boot::is_authed`). Do NOT invent a `?token=` query pattern.
- No protocol changes: no new `TerminalMeta`/WS fields, so no `crates/freshell-protocol` or `port/contract/*.schema.json` changes.
- `npm run lint` (jsx-a11y) is a CI gate; new client code must be lint-clean. Rust CI gate: `cargo fmt --all --check` + `cargo clippy --workspace --all-targets -- -D warnings` (pinned toolchain 1.96.0).
- Do NOT restart the live Rust server on port 3002 (requires the user's explicit "APPROVED"). Building is fine. Scratch testing uses `scripts/launch-rust.sh --port 3499` only.
- Do NOT deploy as part of this work. `docs/index.html` is NOT updated (a small tab icon is not a major visible change).
- Work in the worktree `/home/dan/code/freshell/.worktrees/repo-icons-on-tabs` (branch `feat/repo-icons-on-tabs`). Commit after every task; focused, atomic commits.
- All commands below run from the worktree root unless stated otherwise.

## File Structure

**Rust (new files, all in `crates/freshell-server/src/`):**
- `repo_icon_git.rs` — pure-fs git root resolution (`resolve_repo`): checkout root vs repo root, worktree `commondir`, submodule handling. No `git` subprocess.
- `repo_icon_detect.rs` — the detector: byte probes (PNG/ICO/SVG dims), sha256 + framework-defaults blacklist, candidate scoring, tier 1/2/3 enumeration, `detect_icon`.
- `repo_icon.rs` — axum router (`/api/repo-icon`, `/api/repo-icon/meta`), auth, path sandboxing, in-process cache, ETag/304, SVG headers.
- `main.rs` (modify) — `mod` declarations + `.merge(repo_icon::router(...))`.
- `files.rs` (modify) — widen visibility of `normalize_user_path`, `is_path_allowed`, `bad_request`, `forbidden`, `not_found` to `pub(crate)` for reuse.
- `crates/freshell-server/testdata/vite.svg` (new) — blacklist test fixture.

**Client (new):**
- `src/lib/repo-icon.ts` — pure helpers: `resolvePaneRepoCwd`, `pathBasename`, `buildRepoIconUrl`.
- `src/components/icons/RepoIcon.tsx` — `<img>`-or-letter-avatar component + `hueFromString`.
- `src/store/repoIconsSlice.ts` — per-cwd probe cache + `fetchRepoIconMeta` thunk.

**Client (modify):**
- `shared/settings.ts`, `src/store/browserPreferencesPersistence.ts`, `src/components/settings/PanesSettings.tsx` — the `panes.repoIconsOnTabs` setting.
- `src/components/TabBar.tsx` — setting selector, `repoCwd` on pane entries, probe dispatch, prop threading (3 render sites).
- `src/components/TabItem.tsx` — grouped/deduped repo-icon rendering in `renderIcons`.
- `src/components/panes/PaneHeader.tsx` — parity surface (repo icon next to the pane icon).
- `src/store/store.ts` — register `repoIcons` reducer.

**Tests:**
- Rust: inline `#[cfg(test)] mod tests` in each new module (tempdir fixtures).
- Client: `test/unit/shared/settings.test.ts`, `test/unit/client/components/SettingsView.panes.test.tsx`, `test/unit/client/lib/repo-icon.test.ts`, `test/unit/client/components/icons/RepoIcon.test.tsx`, `test/unit/client/store/repoIconsSlice.test.ts`, `test/unit/client/components/TabItem.test.tsx`, `test/unit/client/components/TabBar.test.tsx`, `test/unit/client/components/panes/PaneHeader.test.tsx`, `test/e2e/repo-icon-tab-flow.test.tsx`.

**Command cheatsheet (used throughout):**
- One client test file: `npm run test:vitest -- run <file> --config config/vitest/vitest.config.ts`
- Rust tests: `cargo test -p freshell-server repo_icon`
- Rust gate: `cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings`

---

### Task 1: Rust git-root resolver (`repo_icon_git.rs`)

**Files:**
- Create: `crates/freshell-server/src/repo_icon_git.rs`
- Modify: `crates/freshell-server/src/main.rs` (add `mod repo_icon_git;`)

**Interfaces:**
- Consumes: nothing (std only).
- Produces: `pub(crate) struct RepoInfo { pub checkout_root: PathBuf, pub repo_root: PathBuf }` and `pub(crate) fn resolve_repo(start: &Path) -> RepoInfo`. Fallback semantics (port of Node `server/coding-cli/utils.ts:169-245`): if no `.git` found walking up, both roots = `start`. Task 6 consumes these.

- [ ] **Step 1: Declare the module and write the failing tests**

In `crates/freshell-server/src/main.rs`, next to the existing `mod files;`-style declarations, add:

```rust
mod repo_icon_git;
```

Create `crates/freshell-server/src/repo_icon_git.rs` containing ONLY the tests for now (plus a stub so it compiles is NOT allowed — let it fail to compile first, run the test, observe the failure, then implement):

```rust
//! Repo-root resolution from a cwd via a pure filesystem `.git` walk.
//!
//! Port of the semantics of `server/coding-cli/utils.ts:169-245`
//! (`walkForGitRoot` / `resolveFromGitFile` / `resolveWorktreeRoot`):
//! - `.git` directory        -> that dir is both checkout root and repo root
//! - `.git` file (worktree)  -> checkout root = dir containing the `.git` file;
//!                              repo root = parent of the shared `.git` dir
//!                              (via `gitdir:` -> `commondir`)
//! - `.git` file (submodule, gitdir contains `/.git/modules/`)
//!                            -> treated as an independent repo (both roots = that dir)
//! - no `.git` anywhere      -> both roots = the starting path
//! No `git` subprocess is spawned (deliberate, matching the Node reference).

// TEMPORARY (removed in Task 6 Step 7): until Task 6 wires `resolve_repo`
// into the HTTP layer, the non-test build sees everything here as dead code
// and the per-task `clippy -D warnings` gate would fail without this.
#![allow(dead_code)]

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn mkrepo(dir: &std::path::Path) {
        fs::create_dir_all(dir.join(".git")).unwrap();
    }

    #[test]
    fn plain_repo_root_from_subdir() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("myrepo");
        mkrepo(&repo);
        let sub = repo.join("src").join("deep");
        fs::create_dir_all(&sub).unwrap();
        let info = resolve_repo(&sub);
        assert_eq!(info.repo_root, repo);
        assert_eq!(info.checkout_root, repo);
    }

    #[test]
    fn no_git_falls_back_to_start() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("plain");
        fs::create_dir_all(&dir).unwrap();
        let info = resolve_repo(&dir);
        assert_eq!(info.repo_root, dir);
        assert_eq!(info.checkout_root, dir);
    }

    #[test]
    fn worktree_resolves_repo_root_via_commondir() {
        let tmp = tempfile::tempdir().unwrap();
        let main_repo = tmp.path().join("mainrepo");
        mkrepo(&main_repo);
        let wt_gitdir = main_repo.join(".git").join("worktrees").join("wt1");
        fs::create_dir_all(&wt_gitdir).unwrap();
        // commondir points (relatively) back at the shared .git dir
        fs::write(wt_gitdir.join("commondir"), "../..\n").unwrap();
        let worktree = tmp.path().join("wt1");
        fs::create_dir_all(&worktree).unwrap();
        fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", wt_gitdir.display()),
        )
        .unwrap();
        let info = resolve_repo(&worktree);
        assert_eq!(info.checkout_root, worktree);
        // Canonicalize both sides: commondir resolution canonicalizes.
        assert_eq!(
            info.repo_root,
            std::fs::canonicalize(&main_repo).unwrap()
        );
    }

    #[test]
    fn submodule_stays_independent_repo() {
        let tmp = tempfile::tempdir().unwrap();
        let outer = tmp.path().join("outer");
        mkrepo(&outer);
        let sub_gitdir = outer.join(".git").join("modules").join("sub");
        fs::create_dir_all(&sub_gitdir).unwrap();
        let sub = outer.join("sub");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join(".git"), format!("gitdir: {}\n", sub_gitdir.display())).unwrap();
        let info = resolve_repo(&sub);
        assert_eq!(info.repo_root, sub);
        assert_eq!(info.checkout_root, sub);
    }

    #[test]
    fn malformed_git_file_treats_dir_as_root() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("weird");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(".git"), "not a gitdir line\n").unwrap();
        let info = resolve_repo(&dir);
        assert_eq!(info.repo_root, dir);
        assert_eq!(info.checkout_root, dir);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p freshell-server repo_icon_git`
Expected: FAIL to compile — `cannot find struct/function ... resolve_repo`.

- [ ] **Step 3: Implement `resolve_repo`**

Add above the tests in `repo_icon_git.rs`:

```rust
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub(crate) struct RepoInfo {
    pub checkout_root: PathBuf,
    pub repo_root: PathBuf,
}

/// Walk up from `start` looking for `.git`; see module docs for semantics.
pub(crate) fn resolve_repo(start: &Path) -> RepoInfo {
    let mut current = start.to_path_buf();
    loop {
        let git_path = current.join(".git");
        match std::fs::symlink_metadata(&git_path) {
            Ok(meta) if meta.is_dir() => {
                return RepoInfo {
                    checkout_root: current.clone(),
                    repo_root: current,
                };
            }
            Ok(meta) if meta.is_file() => {
                let repo_root =
                    resolve_from_git_file(&current, &git_path).unwrap_or_else(|| current.clone());
                return RepoInfo {
                    checkout_root: current,
                    repo_root,
                };
            }
            _ => {}
        }
        match current.parent() {
            Some(parent) => current = parent.to_path_buf(),
            None => break,
        }
    }
    RepoInfo {
        checkout_root: start.to_path_buf(),
        repo_root: start.to_path_buf(),
    }
}

/// `.git` FILE handling: parse `gitdir:`; submodule -> independent repo;
/// worktree -> shared `.git` dir's parent via `commondir`; unknown -> the dir itself.
fn resolve_from_git_file(dot_git_dir: &Path, git_file: &Path) -> Option<PathBuf> {
    let content = std::fs::read_to_string(git_file).ok()?;
    let gitdir_raw = content
        .lines()
        .find_map(|line| line.strip_prefix("gitdir:"))?
        .trim();
    let gitdir = if Path::new(gitdir_raw).is_absolute() {
        PathBuf::from(gitdir_raw)
    } else {
        dot_git_dir.join(gitdir_raw)
    };
    let gitdir_str = gitdir.to_string_lossy().replace('\\', "/");
    if gitdir_str.contains("/.git/modules/") {
        return Some(dot_git_dir.to_path_buf());
    }
    if gitdir_str.contains("/.git/worktrees/") {
        let commondir_content = std::fs::read_to_string(gitdir.join("commondir")).ok()?;
        let common = gitdir.join(commondir_content.trim());
        // Canonicalize to collapse the relative `../..` commondir path.
        let common = std::fs::canonicalize(&common).ok()?;
        return common.parent().map(|p| p.to_path_buf());
    }
    Some(dot_git_dir.to_path_buf())
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p freshell-server repo_icon_git`
Expected: PASS (5 tests). Note: on macOS `tempdir` paths involve `/private` symlinks — the worktree test already compares against the canonicalized main repo, and the other tests compare non-canonicalized paths built from the same tempdir, so they are stable on Linux (the dev/CI platform here).

- [ ] **Step 5: Lint and commit**

```bash
cargo fmt --all
cargo clippy -p freshell-server --all-targets -- -D warnings
git add crates/freshell-server/src/repo_icon_git.rs crates/freshell-server/src/main.rs
git commit -m "feat(rust): repo-root resolver for repo icons (pure .git walk, worktree-aware)"
```

---

### Task 2: Byte probes, hashing, and the framework-defaults blacklist (`repo_icon_detect.rs`, part 1)

**Files:**
- Create: `crates/freshell-server/src/repo_icon_detect.rs`
- Create: `crates/freshell-server/testdata/vite.svg`
- Modify: `crates/freshell-server/src/main.rs` (add `mod repo_icon_detect;`)

**Interfaces:**
- Consumes: `sha2` (existing dep).
- Produces (all `pub(crate)`, consumed by Tasks 3–6): `png_dimensions(&[u8]) -> Option<(u32,u32)>`, `ico_largest_dimensions(&[u8]) -> Option<(u32,u32)>`, `svg_dimensions(&str) -> Option<(f64,f64)>`, `svg_is_dangerous(&str) -> bool`, `sha256_hex(&[u8]) -> String`, `framework_default_name(&[u8]) -> Option<&'static str>`.

- [ ] **Step 1: Create the blacklist test fixture (offline — seed digests are pre-verified)**

The blacklist is an easily-extended `sha256 -> name` table seeded with well-known scaffold defaults. The six seed digests in Step 4 were **pre-verified on 2026-07-28** against upstream pinned refs AND real scaffolded repos on this machine (see `.worktrees/.the-usual-logs/repo-icons-on-tabs/reports/validator-A1-A2.md`) — do NOT re-derive them from `main`-branch fetches: the classic `vite.svg` was rebranded and then renamed to `favicon.svg` upstream in Jan 2026, so the plan's original `main` URL now 404s.

The test fixture comes from inside this repo (an unmodified create-vite scaffold copy):

```bash
mkdir -p crates/freshell-server/testdata
cp examples/demo-projects/synth/public/vite.svg crates/freshell-server/testdata/vite.svg
sha256sum crates/freshell-server/testdata/vite.svg
```

Expected: exactly `4a748afd443918bb16591c834c401dae33e87861ab5dbad0811c3a3b4a9214fb` — this MUST match the `vite-default-logo` row in Step 4's table (the fixture and the table row are the same bytes; the test depends on it). If you want to independently re-verify any seed, use these pinned-ref URLs (all verified working; never use unpinned `main` for vite):

```bash
# classic vite.svg (all create-vite templates, Jun 2022 - Jan 2026), expect 4a748afd…
curl -fsSL https://raw.githubusercontent.com/vitejs/vite/v5.4.0/packages/create-vite/template-react/public/vite.svg | sha256sum
# new Vite logo (post-Jan-2026 scaffolds ship it as public/favicon.svg), expect 61bc9a16…
curl -fsSL https://raw.githubusercontent.com/vitejs/vite/main/packages/create-vite/template-react/public/favicon.svg | sha256sum
# CRA >= 3.3 (cra-template, frozen since 2019 — repo archived), expect c386396e… / 9ea4f4da…
curl -fsSL https://raw.githubusercontent.com/facebook/create-react-app/main/packages/cra-template/template/public/logo192.png | sha256sum
curl -fsSL https://raw.githubusercontent.com/facebook/create-react-app/main/packages/cra-template/template/public/logo512.png | sha256sum
# CRA 3.0-3.2 (react-scripts template era), expect 15d08b02… / 6c9a8886…
curl -fsSL https://raw.githubusercontent.com/facebook/create-react-app/v3.2.0/packages/react-scripts/template/public/logo192.png | sha256sum
curl -fsSL https://raw.githubusercontent.com/facebook/create-react-app/v3.2.0/packages/react-scripts/template/public/logo512.png | sha256sum
```

(Always keep `-f`/`--fail` on these curls: without it a 404 body gets hashed — `d5558cd4…` — and silently poisons the table.)

- [ ] **Step 2: Declare the module and write the failing tests**

In `crates/freshell-server/src/main.rs`, next to `mod repo_icon_git;`, add:

```rust
mod repo_icon_detect;
```

Create `crates/freshell-server/src/repo_icon_detect.rs` with the module doc and tests:

```rust
//! Repo icon detection: bounded, tiered candidate scan with scoring.
//! Part 1 (this section): byte probes, hashing, framework-defaults blacklist.

// TEMPORARY (removed in Task 6 Step 7): until Task 6 wires `detect_icon`
// into the HTTP layer, the non-test build sees everything here as dead code
// and the per-task `clippy -D warnings` gates (Tasks 2-5) would fail without this.
#![allow(dead_code)]

#[cfg(test)]
mod probe_tests {
    use super::*;

    fn png_bytes(width: u32, height: u32) -> Vec<u8> {
        let mut b = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        b.extend_from_slice(&13u32.to_be_bytes()); // IHDR length
        b.extend_from_slice(b"IHDR");
        b.extend_from_slice(&width.to_be_bytes());
        b.extend_from_slice(&height.to_be_bytes());
        b.extend_from_slice(&[8, 6, 0, 0, 0]); // bit depth etc (ignored)
        b
    }

    #[test]
    fn png_dimensions_parses_ihdr() {
        assert_eq!(png_dimensions(&png_bytes(128, 64)), Some((128, 64)));
    }

    #[test]
    fn png_dimensions_rejects_non_png() {
        assert_eq!(png_dimensions(b"not a png at all, definitely"), None);
        assert_eq!(png_dimensions(&[]), None);
    }

    #[test]
    fn ico_largest_entry_wins_and_zero_means_256() {
        // ICONDIR: reserved=0, type=1, count=2; two 16-byte entries.
        let mut b = vec![0, 0, 1, 0, 2, 0];
        let mut e1 = [0u8; 16];
        e1[0] = 16; // 16x16
        e1[1] = 16;
        let mut e2 = [0u8; 16];
        e2[0] = 0; // 0 => 256
        e2[1] = 0;
        b.extend_from_slice(&e1);
        b.extend_from_slice(&e2);
        assert_eq!(ico_largest_dimensions(&b), Some((256, 256)));
    }

    #[test]
    fn svg_dimensions_from_attrs_and_viewbox() {
        assert_eq!(
            svg_dimensions(r#"<svg width="32px" height="16" xmlns="x">"#),
            Some((32.0, 16.0))
        );
        assert_eq!(
            svg_dimensions(r#"<svg viewBox="0 0 24 24" xmlns="x">"#),
            Some((24.0, 24.0))
        );
        assert_eq!(svg_dimensions("<svg xmlns=\"x\">"), None);
    }

    #[test]
    fn svg_danger_detection_is_case_insensitive() {
        assert!(svg_is_dangerous("<!DOCTYPE svg PUBLIC ...><svg/>"));
        assert!(svg_is_dangerous("<!doctype svg><svg/>"));
        assert!(svg_is_dangerous("<!ENTITY xxe SYSTEM \"file:///etc/passwd\">"));
        assert!(!svg_is_dangerous("<svg><circle r=\"4\"/></svg>"));
    }

    #[test]
    fn sha256_hex_known_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn vite_default_logo_is_blacklisted() {
        let bytes = include_bytes!("../testdata/vite.svg");
        assert_eq!(framework_default_name(bytes), Some("vite-default-logo"));
    }

    #[test]
    fn arbitrary_content_is_not_blacklisted() {
        assert_eq!(framework_default_name(b"<svg>my real logo</svg>"), None);
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test -p freshell-server repo_icon_detect`
Expected: FAIL to compile — probe functions not defined.

- [ ] **Step 4: Implement the probes, hash, and blacklist**

Add above the tests:

```rust
use sha2::{Digest, Sha256};

/// PNG: 8-byte signature, then IHDR with big-endian u32 width/height at 16/20.
pub(crate) fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    const SIG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    if bytes.len() < 24 || bytes[..8] != SIG || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let h = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    if w == 0 || h == 0 {
        return None;
    }
    Some((w, h))
}

/// ICO: 6-byte ICONDIR then 16-byte entries; width/height byte 0 means 256.
/// Returns the largest entry's dimensions.
pub(crate) fn ico_largest_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 6 || bytes[0..2] != [0, 0] || bytes[2..4] != [1, 0] {
        return None;
    }
    let count = u16::from_le_bytes([bytes[4], bytes[5]]) as usize;
    let mut best: Option<(u32, u32)> = None;
    for i in 0..count {
        let off = 6 + i * 16;
        if bytes.len() < off + 16 {
            break;
        }
        let w = if bytes[off] == 0 { 256 } else { bytes[off] as u32 };
        let h = if bytes[off + 1] == 0 { 256 } else { bytes[off + 1] as u32 };
        // `is_none_or` (not `map_or(true, …)`) — clippy::unnecessary_map_or fires under -D warnings.
        if best.is_none_or(|(bw, _)| w > bw) {
            best = Some((w, h));
        }
    }
    best
}

/// Best-effort SVG dimensions from width/height attributes or viewBox.
/// Unknown dimensions are acceptable (caller treats `None` as "no aspect data").
pub(crate) fn svg_dimensions(text: &str) -> Option<(f64, f64)> {
    let head = text.get(..text.len().min(4096)).unwrap_or(text);
    fn attr(head: &str, name: &str) -> Option<f64> {
        let re = regex::Regex::new(&format!(r#"(?i)\b{name}\s*=\s*["']([^"']+)["']"#)).ok()?;
        let raw = re.captures(head)?.get(1)?.as_str();
        raw.trim().trim_end_matches("px").trim().parse::<f64>().ok()
    }
    if let (Some(w), Some(h)) = (attr(head, "width"), attr(head, "height")) {
        if w > 0.0 && h > 0.0 {
            return Some((w, h));
        }
    }
    let vb = regex::Regex::new(
        r#"(?i)viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)"#,
    )
    .ok()?;
    let caps = vb.captures(head)?;
    let w = caps.get(1)?.as_str().parse::<f64>().ok()?;
    let h = caps.get(2)?.as_str().parse::<f64>().ok()?;
    if w > 0.0 && h > 0.0 {
        Some((w, h))
    } else {
        None
    }
}

/// SVGs with DOCTYPE/ENTITY are rejected outright (XXE / entity-expansion hygiene).
pub(crate) fn svg_is_dangerous(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("<!doctype") || lower.contains("<!entity")
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Known framework scaffold defaults, by content sha256. Rejected so every
/// Vite/CRA project doesn't show the same framework logo on tabs.
/// EXTEND FREELY: one `("<sha256>", "<name>")` row per known default.
/// All six digests below were verified 2026-07-28 against upstream pinned
/// refs AND real scaffolded repos (see the pinned-ref curl commands in this
/// task's Step 1). Content-hash (not filename) matching is deliberate: real
/// users customize `logo192.png`/`favicon.svg` in place, and a name-based
/// rejection would suppress those genuine custom icons.
const FRAMEWORK_DEFAULTS: &[(&str, &str)] = &[
    // create-vite public/vite.svg, ALL templates (react/vue/vanilla/svelte), Jun 2022 - Jan 2026
    ("4a748afd443918bb16591c834c401dae33e87861ab5dbad0811c3a3b4a9214fb", "vite-default-logo"),
    // new Vite logo after the Jan 2026 rebrand; scaffolds ship it as public/favicon.svg
    ("61bc9a161de58248288e6905425d7180f0624c2865007b97d763fdac12043a66", "vite-default-logo-2026"),
    // CRA >= 3.3 (cra-template era, frozen upstream since 2019; repo archived)
    ("c386396ec70db3608075b5fbfaac4ab1ccaa86ba05a68ab393ec551eb66c3e00", "cra-logo192"),
    ("9ea4f4da7050c0cc408926f6a39c253624e9babb1d43c7977cd821445a60b461", "cra-logo512"),
    // CRA 3.0-3.2 (react-scripts template era) shipped different bytes
    ("15d08b02d78823c12616b72d1b5adb0520940016b89bae1f758e6f1a105597ff", "cra-logo192-legacy"),
    ("6c9a88867fefa2489b91fb85dab7cbec88f1022193ede7320da0ac3c45429519", "cra-logo512-legacy"),
    // Worthwhile extension (hash it yourself before adding — do NOT guess):
    // create-next-app ships a Vercel-logo `app/favicon.ico` that tier-2 fixed
    // paths WILL pick up on fresh Next.js repos. Scaffold one (`npx
    // create-next-app`) or fetch the template file at a pinned ref, sha256 it,
    // and add a ("<hex>", "nextjs-default-favicon") row.
];

pub(crate) fn framework_default_name(bytes: &[u8]) -> Option<&'static str> {
    let hash = sha256_hex(bytes);
    FRAMEWORK_DEFAULTS
        .iter()
        .find(|(h, _)| *h == hash)
        .map(|(_, name)| *name)
}
```

All digests above are complete, pre-verified values — nothing to paste. Sanity gate before commit: Step 1's `sha256sum crates/freshell-server/testdata/vite.svg` must print `4a748afd…214fb` (the `vite-default-logo` row), or the fixture test below cannot pass.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p freshell-server repo_icon_detect`
Expected: PASS (8 tests), including `vite_default_logo_is_blacklisted`.

- [ ] **Step 6: Lint and commit**

```bash
cargo fmt --all
cargo clippy -p freshell-server --all-targets -- -D warnings
git add crates/freshell-server/src/repo_icon_detect.rs crates/freshell-server/src/main.rs crates/freshell-server/testdata/vite.svg
git commit -m "feat(rust): repo-icon byte probes, sha256, framework-defaults blacklist"
```

---

### Task 3: Candidate scoring and deterministic tiebreak (`repo_icon_detect.rs`, part 2)

**Files:**
- Modify: `crates/freshell-server/src/repo_icon_detect.rs`

**Interfaces:**
- Consumes: Task 2's probes/blacklist.
- Produces: `pub(crate) struct Candidate { pub path: PathBuf, pub tier_base: i64, pub order: u32, pub extra: i64 }`, `pub(crate) fn score_candidate(repo_root: &Path, cand: &Candidate) -> Option<i64>` (None = rejected), `pub(crate) fn pick_best(repo_root: &Path, candidates: Vec<Candidate>) -> Option<PathBuf>`. Tier bases: `TIER1 = 100`, `TIER2 = 80`, `TIER3 = 60` (`pub(crate) const`).

- [ ] **Step 1: Write the failing tests**

Append to `repo_icon_detect.rs`:

```rust
#[cfg(test)]
mod scoring_tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn write_png(path: &PathBuf, w: u32, h: u32) {
        let mut b = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        b.extend_from_slice(&13u32.to_be_bytes());
        b.extend_from_slice(b"IHDR");
        b.extend_from_slice(&w.to_be_bytes());
        b.extend_from_slice(&h.to_be_bytes());
        b.extend_from_slice(&[8, 6, 0, 0, 0]);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b).unwrap();
    }

    fn cand(root: &std::path::Path, rel: &str, tier: i64, order: u32) -> Candidate {
        Candidate {
            path: root.join(rel),
            tier_base: tier,
            order,
            extra: 0,
        }
    }

    #[test]
    fn square_icon_in_range_scores_bonuses() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        write_png(&root.join("icon.png"), 128, 128);
        let score = score_candidate(&root, &cand(&root, "icon.png", TIER3, 0)).unwrap();
        // 60 base + 15 square + 10 size + 5 basename 'icon' + 5 png format = 95
        assert_eq!(score, 95);
    }

    #[test]
    fn wide_wordmark_is_rejected_and_medium_wide_penalized() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        write_png(&root.join("logo.png"), 600, 200); // aspect 3.0 -> reject
        assert_eq!(
            score_candidate(&root, &cand(&root, "logo.png", TIER3, 0)),
            None
        );
        write_png(&root.join("banner.png"), 200, 100); // aspect 2.0 -> -20
        let score = score_candidate(&root, &cand(&root, "banner.png", TIER3, 0)).unwrap();
        // 60 - 20 + 10 (size in range) + 5 (png) = 55
        assert_eq!(score, 55);
    }

    #[test]
    fn tiny_and_huge_and_bad_paths_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        write_png(&root.join("small.png"), 8, 8); // raster width < 16
        assert_eq!(score_candidate(&root, &cand(&root, "small.png", TIER3, 0)), None);
        write_png(&root.join("node_modules/pkg/icon.png"), 128, 128);
        assert_eq!(
            score_candidate(&root, &cand(&root, "node_modules/pkg/icon.png", TIER3, 0)),
            None
        );
        fs::write(root.join("icon.icns"), b"whatever").unwrap();
        assert_eq!(score_candidate(&root, &cand(&root, "icon.icns", TIER3, 0)), None);
        // outside the repo root -> rejected
        let outside = tmp.path().join("elsewhere.png");
        write_png(&outside, 128, 128);
        let c = Candidate { path: outside, tier_base: TIER3, order: 0, extra: 0 };
        assert_eq!(score_candidate(&root.join("sub"), &c), None);
    }

    #[test]
    fn oversized_files_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        fs::write(root.join("big.svg"), vec![b'a'; 300 * 1024]).unwrap(); // svg > 256KB
        assert_eq!(score_candidate(&root, &cand(&root, "big.svg", TIER3, 0)), None);
    }

    #[test]
    fn dangerous_svg_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        fs::write(root.join("evil.svg"), "<!DOCTYPE svg><svg/>").unwrap();
        assert_eq!(score_candidate(&root, &cand(&root, "evil.svg", TIER3, 0)), None);
    }

    #[test]
    fn pick_best_prefers_score_then_order_then_shortest_path() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        write_png(&root.join("a/icon.png"), 128, 128); // tier1
        write_png(&root.join("logo.png"), 128, 128); // tier3
        let best = pick_best(
            &root,
            vec![
                cand(&root, "logo.png", TIER3, 5),
                cand(&root, "a/icon.png", TIER1, 0),
            ],
        );
        assert_eq!(best, Some(root.join("a/icon.png")));
        // Equal score -> earlier enumeration order wins.
        write_png(&root.join("b/icon.png"), 128, 128);
        let best = pick_best(
            &root,
            vec![
                cand(&root, "b/icon.png", TIER1, 1),
                cand(&root, "a/icon.png", TIER1, 2),
            ],
        );
        assert_eq!(best, Some(root.join("b/icon.png")));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p freshell-server repo_icon_detect::scoring`
Expected: FAIL to compile — `Candidate`, `score_candidate`, `pick_best`, `TIER*` not defined.

- [ ] **Step 3: Implement scoring**

Add to `repo_icon_detect.rs` (above the test modules):

```rust
use std::path::{Path, PathBuf};

pub(crate) const TIER1: i64 = 100;
pub(crate) const TIER2: i64 = 80;
pub(crate) const TIER3: i64 = 60;

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SVG_BYTES: u64 = 256 * 1024;
const REJECTED_PATH_COMPONENTS: &[&str] = &[
    "node_modules", "vendor", "third_party", "test", "tests", "fixtures",
    "example", "template", "dist", "out", "coverage",
];
const REJECTED_EXTENSIONS: &[&str] = &["icns", "xml", "icon"];

#[derive(Debug, Clone)]
pub(crate) struct Candidate {
    /// Absolute path (under the repo root; out-of-root candidates are rejected).
    pub path: PathBuf,
    pub tier_base: i64,
    /// Stable enumeration sequence — encodes "first match in listed order within a tier".
    pub order: u32,
    /// Spec-mandated extra (e.g. +5 for root `icon.*` over `logo.*`).
    pub extra: i64,
}

/// Score a candidate; `None` = hard rejection.
pub(crate) fn score_candidate(repo_root: &Path, cand: &Candidate) -> Option<i64> {
    let rel = cand.path.strip_prefix(repo_root).ok()?;
    for comp in rel.components() {
        let c = comp.as_os_str().to_string_lossy().to_lowercase();
        if REJECTED_PATH_COMPONENTS.contains(&c.as_str()) {
            return None;
        }
    }
    let ext = cand
        .path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if REJECTED_EXTENSIONS.contains(&ext.as_str()) {
        return None;
    }
    let meta = std::fs::metadata(&cand.path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return None;
    }
    if ext == "svg" && meta.len() > MAX_SVG_BYTES {
        return None;
    }
    let bytes = std::fs::read(&cand.path).ok()?;
    if framework_default_name(&bytes).is_some() {
        return None;
    }

    let mut score = cand.tier_base + cand.extra;
    let is_raster = matches!(ext.as_str(), "png" | "ico" | "jpg" | "jpeg" | "gif" | "webp");
    let dims: Option<(f64, f64)> = match ext.as_str() {
        "png" => png_dimensions(&bytes).map(|(w, h)| (f64::from(w), f64::from(h))),
        "ico" => ico_largest_dimensions(&bytes).map(|(w, h)| (f64::from(w), f64::from(h))),
        "svg" => {
            let text = String::from_utf8_lossy(&bytes);
            if svg_is_dangerous(&text) {
                return None;
            }
            svg_dimensions(&text)
        }
        _ => None,
    };
    if let Some((w, h)) = dims {
        if w <= 0.0 || h <= 0.0 {
            return None;
        }
        let aspect = (w / h).max(h / w);
        if aspect > 2.5 {
            return None;
        }
        if is_raster && w < 16.0 {
            return None;
        }
        if aspect > 1.6 {
            score -= 20;
        }
        if (w / h - 1.0).abs() < 0.05 {
            score += 15;
        }
        let max_dim = w.max(h);
        if (32.0..=512.0).contains(&max_dim) {
            score += 10;
        }
    }
    let stem = cand
        .path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    if stem == "icon" {
        score += 5;
    }
    if matches!(ext.as_str(), "png" | "ico" | "svg") {
        score += 5;
    }
    Some(score)
}

/// Deterministic winner: highest score, then earliest enumeration order,
/// then shortest relative path, then lexicographic.
pub(crate) fn pick_best(repo_root: &Path, candidates: Vec<Candidate>) -> Option<PathBuf> {
    let mut scored: Vec<(i64, u32, usize, String, PathBuf)> = candidates
        .into_iter()
        .filter_map(|cand| {
            let score = score_candidate(repo_root, &cand)?;
            let rel = cand
                .path
                .strip_prefix(repo_root)
                .ok()?
                .to_string_lossy()
                .into_owned();
            Some((score, cand.order, rel.len(), rel, cand.path))
        })
        .collect();
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then(a.1.cmp(&b.1))
            .then(a.2.cmp(&b.2))
            .then(a.3.cmp(&b.3))
    });
    scored.into_iter().next().map(|(_, _, _, _, path)| path)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p freshell-server repo_icon_detect`
Expected: PASS (all probe + scoring tests).

- [ ] **Step 5: Lint and commit**

```bash
cargo fmt --all
cargo clippy -p freshell-server --all-targets -- -D warnings
git add crates/freshell-server/src/repo_icon_detect.rs
git commit -m "feat(rust): repo-icon candidate scoring with aspect/size/blacklist rejection"
```

---

### Task 4: Tier 1 manifest candidate enumeration (`repo_icon_detect.rs`, part 3)

**Files:**
- Modify: `crates/freshell-server/src/repo_icon_detect.rs`

**Interfaces:**
- Consumes: `Candidate`, `TIER1`, probes from Tasks 2–3; `serde_json`, `regex` (existing deps).
- Produces: `struct CandidateSink { repo_root: PathBuf, out: Vec<Candidate>, next_order: u32 }` with `push`/`push_extra`, and `fn tier1(sink: &mut CandidateSink)` covering: VS Code extension (`package.json` `icon` iff `engines.vscode`), browser-extension `manifest.json` (`manifest_version` → `icons["128"] || icons["48"] || largest`), Tauri (`src-tauri/tauri.conf.json` / `.json5` / `Tauri.toml` → `bundle.icon` v2 or `tauri.bundle.icon` v1, png closest to 128), electron-builder (`package.json` `build.icon`), web app manifest (icons ARRAY, purpose absent/`any`, size closest ≥64, `/x` → public|static|root), and `index.html` (root/public/src) `<link rel="icon"|"shortcut icon"|"apple-touch-icon">` preferring svg > largest png > ico. Task 5 wires `tier1` into `detect_icon`.

- [ ] **Step 1: Write the failing tests**

Append to `repo_icon_detect.rs`:

```rust
#[cfg(test)]
mod tier1_tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    fn write_png_at(path: &Path, w: u32, h: u32) {
        let mut b = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        b.extend_from_slice(&13u32.to_be_bytes());
        b.extend_from_slice(b"IHDR");
        b.extend_from_slice(&w.to_be_bytes());
        b.extend_from_slice(&h.to_be_bytes());
        b.extend_from_slice(&[8, 6, 0, 0, 0]);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b).unwrap();
    }

    fn candidates_for(root: &Path) -> Vec<Candidate> {
        let mut sink = CandidateSink::new(root.to_path_buf());
        tier1(&mut sink);
        sink.out
    }

    fn has(cands: &[Candidate], root: &Path, rel: &str) -> bool {
        cands.iter().any(|c| c.path == root.join(rel))
    }

    #[test]
    fn vscode_extension_icon_requires_engines_vscode() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_png_at(&root.join("images/ext.png"), 128, 128);
        fs::write(
            root.join("package.json"),
            r#"{ "icon": "images/ext.png", "engines": { "vscode": "^1.80.0" } }"#,
        )
        .unwrap();
        assert!(has(&candidates_for(root), root, "images/ext.png"));
        // Without engines.vscode the icon field is ignored.
        fs::write(root.join("package.json"), r#"{ "icon": "images/ext.png" }"#).unwrap();
        assert!(!has(&candidates_for(root), root, "images/ext.png"));
    }

    #[test]
    fn browser_extension_manifest_prefers_128() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_png_at(&root.join("i48.png"), 48, 48);
        write_png_at(&root.join("i128.png"), 128, 128);
        fs::write(
            root.join("manifest.json"),
            r#"{ "manifest_version": 3, "icons": { "48": "i48.png", "128": "i128.png" } }"#,
        )
        .unwrap();
        let cands = candidates_for(root);
        assert!(has(&cands, root, "i128.png"));
        assert!(!has(&cands, root, "i48.png"));
    }

    #[test]
    fn tauri_v2_picks_png_closest_to_128() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_png_at(&root.join("src-tauri/icons/32x32.png"), 32, 32);
        write_png_at(&root.join("src-tauri/icons/128x128.png"), 128, 128);
        fs::write(
            root.join("src-tauri/tauri.conf.json"),
            r#"{ "bundle": { "icon": ["icons/32x32.png", "icons/128x128.png", "icons/icon.icns"] } }"#,
        )
        .unwrap();
        let cands = candidates_for(root);
        assert!(has(&cands, root, "src-tauri/icons/128x128.png"));
        assert!(!has(&cands, root, "src-tauri/icons/32x32.png"));
    }

    #[test]
    fn electron_builder_icon_from_package_json() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_png_at(&root.join("build/app.png"), 256, 256);
        fs::write(
            root.join("package.json"),
            r#"{ "build": { "icon": "build/app.png" } }"#,
        )
        .unwrap();
        assert!(has(&candidates_for(root), root, "build/app.png"));
    }

    #[test]
    fn web_manifest_picks_size_closest_to_64_and_maps_absolute_src() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_png_at(&root.join("public/i32.png"), 32, 32);
        write_png_at(&root.join("public/i96.png"), 96, 96);
        write_png_at(&root.join("public/i512.png"), 512, 512);
        fs::write(
            root.join("public/manifest.json"),
            r#"{ "icons": [
                { "src": "/i32.png", "sizes": "32x32" },
                { "src": "/i96.png", "sizes": "96x96" },
                { "src": "/i512.png", "sizes": "512x512", "purpose": "maskable" }
            ] }"#,
        )
        .unwrap();
        let cands = candidates_for(root);
        assert!(has(&cands, root, "public/i96.png")); // smallest >= 64, purpose ok
        assert!(!has(&cands, root, "public/i512.png")); // maskable filtered out
    }

    #[test]
    fn web_manifest_requires_icons_array() {
        // A browser-extension manifest (icons OBJECT) must not be treated as a web manifest.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_png_at(&root.join("public/i128.png"), 128, 128);
        fs::write(
            root.join("public/manifest.json"),
            r#"{ "icons": { "128": "i128.png" } }"#,
        )
        .unwrap();
        // No manifest_version either -> neither rule fires; no candidates.
        assert!(candidates_for(root).is_empty());
    }

    #[test]
    fn index_html_link_prefers_svg_then_largest_png_then_ico() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(root.join("fav.svg"), "<svg viewBox=\"0 0 16 16\"/>").unwrap();
        write_png_at(&root.join("fav48.png"), 48, 48);
        fs::write(
            root.join("index.html"),
            r#"<html><head>
                <link rel="icon" sizes="48x48" href="/fav48.png">
                <link rel="icon" href="/fav.svg">
            </head></html>"#,
        )
        .unwrap();
        let cands = candidates_for(root);
        assert!(has(&cands, root, "fav.svg"));
        assert!(!has(&cands, root, "fav48.png"));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p freshell-server repo_icon_detect::tier1`
Expected: FAIL to compile — `CandidateSink` / `tier1` not defined.

- [ ] **Step 3: Implement the sink and tier 1**

Add to `repo_icon_detect.rs`:

```rust
pub(crate) struct CandidateSink {
    pub repo_root: PathBuf,
    pub out: Vec<Candidate>,
    next_order: u32,
}

impl CandidateSink {
    pub(crate) fn new(repo_root: PathBuf) -> Self {
        Self { repo_root, out: Vec::new(), next_order: 0 }
    }

    pub(crate) fn push(&mut self, path: PathBuf, tier_base: i64) {
        self.push_extra(path, tier_base, 0);
    }

    /// Only existing regular files become candidates; the order counter always
    /// advances so enumeration order is stable regardless of what exists.
    pub(crate) fn push_extra(&mut self, path: PathBuf, tier_base: i64, extra: i64) {
        let order = self.next_order;
        self.next_order += 1;
        if path.is_file() {
            self.out.push(Candidate { path, tier_base, order, extra });
        }
    }
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > 1_048_576 {
        return None;
    }
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// Resolve a web-style src: relative to its document dir; absolute `/x`
/// probed against public/, static/, then the repo root. Remote/data URLs skipped.
fn resolve_web_src(root: &Path, doc_dir: &Path, src: &str) -> Vec<PathBuf> {
    if src.starts_with("http://") || src.starts_with("https://") || src.starts_with("data:") {
        return Vec::new();
    }
    if let Some(rest) = src.strip_prefix('/') {
        return vec![
            root.join("public").join(rest),
            root.join("static").join(rest),
            root.join(rest),
        ];
    }
    vec![doc_dir.join(src)]
}

/// First contiguous digit run in the basename ("128x128.png" -> 128).
fn filename_size_hint(name: &str) -> Option<i64> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let digits: String = base
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

/// Best-effort JSON5 -> JSON: strip `//` line comments (outside strings,
/// approximated by "no quote earlier on the line") and trailing commas.
fn strip_json5(raw: &str) -> String {
    let no_comments: String = raw
        .lines()
        .map(|line| match line.find("//") {
            Some(idx) if !line[..idx].contains('"') => &line[..idx],
            _ => line,
        })
        .collect::<Vec<_>>()
        .join("\n");
    match regex::Regex::new(r",\s*([}\]])") {
        Ok(re) => re.replace_all(&no_comments, "$1").into_owned(),
        Err(_) => no_comments,
    }
}

fn tauri_candidates(sink: &mut CandidateSink) {
    let dir = sink.repo_root.join("src-tauri");
    let mut icon_lists: Vec<Vec<String>> = Vec::new();
    for name in ["tauri.conf.json", "tauri.conf.json5"] {
        let path = dir.join(name);
        let Ok(raw) = std::fs::read_to_string(&path) else { continue };
        let cleaned = if name.ends_with(".json5") { strip_json5(&raw) } else { raw };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&cleaned) else { continue };
        let arr = v
            .pointer("/bundle/icon") // Tauri v2
            .or_else(|| v.pointer("/tauri/bundle/icon")); // Tauri v1
        if let Some(items) = arr.and_then(|a| a.as_array()) {
            icon_lists.push(
                items
                    .iter()
                    .filter_map(|i| i.as_str().map(str::to_string))
                    .collect(),
            );
        }
    }
    // Tauri.toml best-effort: regex the `icon = [ ... ]` array.
    if let Ok(raw) = std::fs::read_to_string(dir.join("Tauri.toml")) {
        if let Ok(re) = regex::Regex::new(r#"icon\s*=\s*\[([^\]]*)\]"#) {
            if let Some(cap) = re.captures(&raw) {
                let items: Vec<String> = cap[1]
                    .split(',')
                    .map(|s| s.trim().trim_matches(|c| c == '"' || c == '\'').to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                if !items.is_empty() {
                    icon_lists.push(items);
                }
            }
        }
    }
    for items in icon_lists {
        // Pick the .png closest to 128px by filename size hint.
        let best = items
            .iter()
            .filter(|i| i.to_lowercase().ends_with(".png"))
            .min_by_key(|i| filename_size_hint(i).map_or(i64::MAX, |s| (s - 128).abs()));
        if let Some(rel) = best {
            sink.push(dir.join(rel), TIER1);
        }
    }
}

fn web_manifest_candidates(sink: &mut CandidateSink) {
    let root = sink.repo_root.clone();
    for base in ["public", "static", "app", ""] {
        let dir = if base.is_empty() { root.clone() } else { root.join(base) };
        for name in ["manifest.json", "site.webmanifest", "manifest.webmanifest"] {
            let Some(v) = read_json(&dir.join(name)) else { continue };
            // Icons must be an ARRAY (distinguishes web manifests from
            // browser-extension manifests, whose icons is an object).
            let Some(icons) = v.get("icons").and_then(|i| i.as_array()) else { continue };
            let mut best: Option<(i64, String)> = None; // (rank, src)
            for icon in icons {
                let Some(src) = icon.get("src").and_then(|s| s.as_str()) else { continue };
                let purpose = icon.get("purpose").and_then(|p| p.as_str()).unwrap_or("any");
                if !purpose.split_whitespace().any(|p| p == "any") {
                    continue;
                }
                let size = icon
                    .get("sizes")
                    .and_then(|s| s.as_str())
                    .and_then(|s| s.split(['x', 'X']).next())
                    .and_then(|w| w.trim().parse::<i64>().ok())
                    .unwrap_or(0);
                // Rank: prefer the smallest size >= 64; else the largest below 64.
                let rank = if size >= 64 { 1_000_000 - size } else { size };
                // `is_none_or` (not `map_or(true, …)`) — clippy::unnecessary_map_or fires under -D warnings.
                if best.as_ref().is_none_or(|(r, _)| rank > *r) {
                    best = Some((rank, src.to_string()));
                }
            }
            if let Some((_, src)) = best {
                for resolved in resolve_web_src(&root, &dir, &src) {
                    sink.push(resolved, TIER1);
                }
            }
        }
    }
}

fn index_html_candidates(sink: &mut CandidateSink) {
    let root = sink.repo_root.clone();
    let Ok(link_re) = regex::Regex::new(r"(?is)<link\b[^>]*>") else { return };
    let Ok(rel_re) = regex::Regex::new(r#"(?i)\brel\s*=\s*["']([^"']+)["']"#) else { return };
    let Ok(href_re) = regex::Regex::new(r#"(?i)\bhref\s*=\s*["']([^"']+)["']"#) else { return };
    let Ok(sizes_re) = regex::Regex::new(r#"(?i)\bsizes\s*=\s*["'](\d+)"#) else { return };
    for base in ["", "public", "src"] {
        let dir = if base.is_empty() { root.clone() } else { root.join(base) };
        let Ok(raw) = std::fs::read_to_string(dir.join("index.html")) else { continue };
        let head = raw.get(..raw.len().min(64 * 1024)).unwrap_or(&raw);
        let mut found: Vec<(i64, String)> = Vec::new(); // (rank, href)
        for tag in link_re.find_iter(head) {
            let tag = tag.as_str();
            let Some(rel) = rel_re.captures(tag).map(|c| c[1].to_lowercase()) else { continue };
            if !["icon", "shortcut icon", "apple-touch-icon"].contains(&rel.as_str()) {
                continue;
            }
            let Some(href) = href_re.captures(tag).map(|c| c[1].to_string()) else { continue };
            let lower = href.to_lowercase();
            let size = sizes_re
                .captures(tag)
                .and_then(|c| c[1].parse::<i64>().ok())
                .unwrap_or(0);
            // svg > largest png > ico > anything else.
            let rank = if lower.ends_with(".svg") {
                3_000_000
            } else if lower.ends_with(".png") {
                2_000_000 + size
            } else if lower.ends_with(".ico") {
                1_000_000
            } else {
                0
            };
            found.push((rank, href));
        }
        found.sort_by(|a, b| b.0.cmp(&a.0));
        if let Some((_, href)) = found.into_iter().next() {
            for resolved in resolve_web_src(&root, &dir, &href) {
                sink.push(resolved, TIER1);
            }
        }
    }
}

pub(crate) fn tier1(sink: &mut CandidateSink) {
    let root = sink.repo_root.clone();
    let pkg = read_json(&root.join("package.json"));
    // 1. VS Code extension: icon field, only with engines.vscode present.
    if let Some(pkg) = &pkg {
        if pkg.pointer("/engines/vscode").is_some() {
            if let Some(icon) = pkg.get("icon").and_then(|v| v.as_str()) {
                sink.push(root.join(icon.trim_start_matches('/')), TIER1);
            }
        }
    }
    // 2. Browser extension manifest.json (icons is an OBJECT keyed by size).
    if let Some(manifest) = read_json(&root.join("manifest.json")) {
        if manifest.get("manifest_version").is_some() {
            if let Some(icons) = manifest.get("icons").and_then(|v| v.as_object()) {
                let pick = icons
                    .get("128")
                    .or_else(|| icons.get("48"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                    .or_else(|| {
                        icons
                            .iter()
                            .filter_map(|(k, v)| Some((k.parse::<u32>().ok()?, v.as_str()?)))
                            .max_by_key(|(size, _)| *size)
                            .map(|(_, src)| src.to_string())
                    });
                if let Some(src) = pick {
                    sink.push(root.join(src.trim_start_matches('/')), TIER1);
                }
            }
        }
    }
    // 3. Tauri.
    tauri_candidates(sink);
    // 4. electron-builder: package.json build.icon (its default paths are Tier 2).
    if let Some(pkg) = &pkg {
        if let Some(icon) = pkg.pointer("/build/icon").and_then(|v| v.as_str()) {
            sink.push(root.join(icon.trim_start_matches('/')), TIER1);
        }
    }
    // 5. Web app manifest.
    web_manifest_candidates(sink);
    // 6. index.html <link rel=icon>.
    index_html_candidates(sink);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p freshell-server repo_icon_detect`
Expected: PASS (all probe + scoring + tier1 tests).

- [ ] **Step 5: Lint and commit**

```bash
cargo fmt --all
cargo clippy -p freshell-server --all-targets -- -D warnings
git add crates/freshell-server/src/repo_icon_detect.rs
git commit -m "feat(rust): tier-1 manifest icon candidate enumeration"
```

---

### Task 5: Tier 2/3 enumeration + `detect_icon` integration (`repo_icon_detect.rs`, part 4)

**Files:**
- Modify: `crates/freshell-server/src/repo_icon_detect.rs`

**Interfaces:**
- Consumes: `CandidateSink`, `tier1`, `pick_best` from Tasks 3–4.
- Produces: `pub(crate) fn detect_icon(repo_root: &Path) -> Option<PathBuf>` — the single entry point Task 6 calls. Bounded scan only (fixed paths + three shallow `read_dir`s: `build/icons`, `.github/assets`, the tier-3 asset dirs); no full-tree walk.

- [ ] **Step 1: Write the failing tests**

Append to `repo_icon_detect.rs`:

```rust
#[cfg(test)]
mod detect_tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    fn write_png_at(path: &Path, w: u32, h: u32) {
        let mut b = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        b.extend_from_slice(&13u32.to_be_bytes());
        b.extend_from_slice(b"IHDR");
        b.extend_from_slice(&w.to_be_bytes());
        b.extend_from_slice(&h.to_be_bytes());
        b.extend_from_slice(&[8, 6, 0, 0, 0]);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b).unwrap();
    }

    #[test]
    fn tier2_favicon_beats_tier3_logo() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("public")).unwrap();
        fs::write(root.join("public/favicon.svg"), "<svg viewBox=\"0 0 16 16\"/>").unwrap();
        write_png_at(&root.join("logo.png"), 100, 100);
        assert_eq!(detect_icon(root), Some(root.join("public/favicon.svg")));
    }

    #[test]
    fn tier1_web_manifest_beats_tier2_favicon() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_png_at(&root.join("public/pwa-192.png"), 192, 192);
        fs::write(
            root.join("public/manifest.json"),
            r#"{ "icons": [{ "src": "/pwa-192.png", "sizes": "192x192" }] }"#,
        )
        .unwrap();
        fs::write(root.join("public/favicon.svg"), "<svg viewBox=\"0 0 16 16\"/>").unwrap();
        assert_eq!(detect_icon(root), Some(root.join("public/pwa-192.png")));
    }

    #[test]
    fn blacklisted_default_falls_through_to_next_candidate() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("public")).unwrap();
        // Vite scaffold default at a tier-2 path...
        fs::copy(
            concat!(env!("CARGO_MANIFEST_DIR"), "/testdata/vite.svg"),
            root.join("public/favicon.svg"),
        )
        .unwrap();
        // ...and a real logo at tier 3.
        write_png_at(&root.join("logo.png"), 100, 100);
        assert_eq!(detect_icon(root), Some(root.join("logo.png")));
    }

    #[test]
    fn no_candidates_yields_none() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(detect_icon(tmp.path()), None);
    }

    #[test]
    fn tier3_prefix_scan_finds_assets_logo() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_png_at(&root.join("assets/logo-dark.png"), 200, 200);
        assert_eq!(detect_icon(root), Some(root.join("assets/logo-dark.png")));
    }

    #[test]
    fn detection_is_deterministic() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_png_at(&root.join("assets/icon-a.png"), 128, 128);
        write_png_at(&root.join("assets/icon-b.png"), 128, 128);
        let first = detect_icon(root);
        for _ in 0..5 {
            assert_eq!(detect_icon(root), first);
        }
        assert_eq!(first, Some(root.join("assets/icon-a.png"))); // lexicographic dir order
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p freshell-server repo_icon_detect::detect`
Expected: FAIL to compile — `detect_icon` not defined.

- [ ] **Step 3: Implement tier 2, tier 3, and `detect_icon`**

Add to `repo_icon_detect.rs`:

```rust
fn tier2(sink: &mut CandidateSink) {
    let root = sink.repo_root.clone();
    const FIXED: &[&str] = &[
        "app/icon.svg", "app/icon.png", "app/icon.ico",
        "src/app/icon.svg", "src/app/icon.png", "src/app/icon.ico",
        "app/favicon.ico", "src/app/favicon.ico", "app/apple-icon.png",
        "public/favicon.svg", "public/favicon.ico", "public/favicon.png",
        "static/favicon.svg", "static/favicon.ico", "static/favicon.png",
        "public/apple-touch-icon.png", "public/icon-192.png", "public/logo192.png",
        "favicon.ico",
        "src-tauri/icons/128x128.png", "src-tauri/icons/icon.png",
        "build/icon.png", "build/icon.ico", "build/appicon.png",
    ];
    for rel in FIXED {
        sink.push(root.join(rel), TIER2);
    }
    // build/icons/*.png -> largest by probed PNG width (electron-builder default dir).
    if let Ok(entries) = std::fs::read_dir(root.join("build/icons")) {
        let mut pngs: Vec<(u32, PathBuf)> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| e.eq_ignore_ascii_case("png"))
            })
            .filter_map(|p| {
                let bytes = std::fs::read(&p).ok()?;
                Some((png_dimensions(&bytes).map(|(w, _)| w).unwrap_or(0), p))
            })
            .collect();
        pngs.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        if let Some((_, p)) = pngs.into_iter().next() {
            sink.push(p, TIER2);
        }
    }
}

/// Shallow scan of `dir` for files whose lowercase basename starts with one of
/// `prefixes` and has an icon-ish extension. Lexicographic order for determinism.
fn push_dir_prefix_matches(sink: &mut CandidateSink, dir: &Path, prefixes: &[&str], tier: i64) {
    const EXTS: &[&str] = &["svg", "png", "ico", "webp", "jpg"];
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        let lower = name.to_lowercase();
        let ext_ok = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| EXTS.contains(&e.to_lowercase().as_str()));
        if ext_ok && prefixes.iter().any(|p| lower.starts_with(p)) {
            sink.push(path.clone(), tier);
        }
    }
}

fn tier3(sink: &mut CandidateSink) {
    let root = sink.repo_root.clone();
    // Root icon.* gets +5 over logo.* (spec).
    sink.push_extra(root.join("icon.svg"), TIER3, 5);
    sink.push_extra(root.join("icon.png"), TIER3, 5);
    for ext in ["png", "jpg", "jpeg", "gif", "svg", "webp"] {
        sink.push(root.join(format!("logo.{ext}")), TIER3); // GitLab parity
    }
    sink.push(root.join("app-icon.png"), TIER3);
    for name in ["logo", "icon"] {
        for ext in ["png", "svg"] {
            sink.push(root.join(".github").join(format!("{name}.{ext}")), TIER3);
        }
    }
    push_dir_prefix_matches(sink, &root.join(".github/assets"), &["logo"], TIER3);
    for dir in [
        "assets", "static", "public", "resources", "media", "images", "img",
        "branding", "docs", "doc",
    ] {
        push_dir_prefix_matches(sink, &root.join(dir), &["icon", "logo"], TIER3);
    }
}

/// The v1 detector entry point: bounded tiered scan, scored, deterministic.
pub(crate) fn detect_icon(repo_root: &Path) -> Option<PathBuf> {
    let mut sink = CandidateSink::new(repo_root.to_path_buf());
    tier1(&mut sink);
    tier2(&mut sink);
    tier3(&mut sink);
    let root = sink.repo_root.clone();
    pick_best(&root, sink.out)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p freshell-server repo_icon_detect`
Expected: PASS (all detect-module tests; ~20 total in the file).

- [ ] **Step 5: Lint and commit**

```bash
cargo fmt --all
cargo clippy -p freshell-server --all-targets -- -D warnings
git add crates/freshell-server/src/repo_icon_detect.rs
git commit -m "feat(rust): tier-2/3 icon enumeration and detect_icon entry point"
```

---

### Task 6: HTTP endpoints, cache, and security (`repo_icon.rs` + registration)

**Files:**
- Create: `crates/freshell-server/src/repo_icon.rs`
- Modify: `crates/freshell-server/src/files.rs` (visibility only)
- Modify: `crates/freshell-server/src/main.rs` (mod + state + merge)

**Interfaces:**
- Consumes: `repo_icon_git::resolve_repo`, `repo_icon_detect::{detect_icon, sha256_hex, svg_is_dangerous}`, `crate::boot::{is_authed, unauthorized}`, `crate::files::{normalize_user_path, is_path_allowed, bad_request, forbidden, not_found}`, `SettingsStore` (same type `FilesState` uses).
- Produces (HTTP contract consumed by client Tasks 9–10):
  - `GET /api/repo-icon/meta?cwd=<abs path>` → `200 {"repoRoot": string, "checkoutRoot": string, "repoName": string, "hasIcon": boolean}`; `400` missing/relative cwd; `401` unauthenticated; `403` path not allowed; `404` cwd does not exist.
  - `GET /api/repo-icon?cwd=<abs path>` → `200` icon bytes (`Content-Type` by extension, `Cache-Control: private, max-age=60`, `ETag`, `X-Content-Type-Options: nosniff`; SVG adds `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'` and `Content-Disposition: inline`); `304` on `If-None-Match` match; `404` when no icon detected; same 400/401/403 as meta.

- [ ] **Step 1: Widen `files.rs` helper visibility**

In `crates/freshell-server/src/files.rs`, change these five function signatures from `fn` to `pub(crate) fn` (bodies untouched): `normalize_user_path` (~line 439), `is_path_allowed` (~line 492), and the response helpers `bad_request`, `forbidden`, `not_found` (~lines 539–570). Run `cargo build -p freshell-server` — expected: compiles with no warnings (if clippy later flags them as unused-`pub(crate)`, this task's remaining steps add the uses).

- [ ] **Step 2: Declare the module and write the failing tests**

In `crates/freshell-server/src/main.rs`, next to the other new mods, add:

```rust
mod repo_icon;
```

Create `crates/freshell-server/src/repo_icon.rs` with module doc + tests:

```rust
//! `GET /api/repo-icon` and `GET /api/repo-icon/meta` — detect and serve the
//! icon of the git repo containing a supplied cwd. Cookie/header authed
//! (`boot::is_authed`), sandboxed (`files::is_path_allowed` + canonicalize
//! containment), cached in-process per repo root.

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use std::fs;
    use std::sync::Arc;
    use tower::util::ServiceExt;

    use crate::settings_store::SettingsStore;

    fn test_state() -> RepoIconState {
        RepoIconState {
            auth_token: Arc::new("tok".to_string()),
            settings: SettingsStore::load(None, Vec::new()),
            cache: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        }
    }

    fn mkrepo_with_icon(tmp: &tempfile::TempDir) -> std::path::PathBuf {
        let repo = tmp.path().join("proj");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(repo.join("public")).unwrap();
        fs::write(
            repo.join("public/favicon.svg"),
            "<svg viewBox=\"0 0 16 16\"><circle r=\"8\"/></svg>",
        )
        .unwrap();
        repo
    }

    async fn get(router: axum::Router, uri: &str, auth: bool, extra: &[(&str, &str)]) -> axum::response::Response {
        let mut req = Request::builder().method("GET").uri(uri);
        if auth {
            req = req.header("x-auth-token", "tok");
        }
        for (k, v) in extra {
            req = req.header(*k, *v);
        }
        router.oneshot(req.body(Body::empty()).unwrap()).await.unwrap()
    }

    async fn body_json(resp: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn icon_uri(repo: &std::path::Path) -> String {
        format!(
            "/api/repo-icon?cwd={}",
            urlencoding_encode(&repo.to_string_lossy())
        )
    }

    /// Minimal percent-encoder for test URIs (only what a path needs).
    fn urlencoding_encode(s: &str) -> String {
        s.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                    (b as char).to_string()
                }
                _ => format!("%{b:02X}"),
            })
            .collect()
    }

    #[tokio::test]
    async fn unauthenticated_is_401() {
        let resp = get(router(test_state()), "/api/repo-icon?cwd=/tmp", false, &[]).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn relative_cwd_is_400_and_missing_dir_is_404() {
        let router1 = router(test_state());
        let resp = get(router1, "/api/repo-icon/meta?cwd=relative/path", true, &[]).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let router2 = router(test_state());
        let resp = get(
            router2,
            "/api/repo-icon/meta?cwd=/definitely/not/a/real/dir/anywhere",
            true,
            &[],
        )
        .await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn disallowed_path_is_forbidden() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = mkrepo_with_icon(&tmp);
        let state = test_state();
        let outcome = resolve_repo_and_icon(
            &state,
            &repo.to_string_lossy(),
            Some(&["/some/other/allowed/root".to_string()]),
        );
        assert!(matches!(outcome, Err(ResolveFailure::Forbidden)));
    }

    #[tokio::test]
    async fn meta_reports_repo_and_icon() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = mkrepo_with_icon(&tmp);
        let sub = repo.join("src");
        fs::create_dir_all(&sub).unwrap();
        let uri = format!(
            "/api/repo-icon/meta?cwd={}",
            urlencoding_encode(&sub.to_string_lossy())
        );
        let resp = get(router(test_state()), &uri, true, &[]).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["repoName"], "proj");
        assert_eq!(v["hasIcon"], true);
        let canonical = std::fs::canonicalize(&repo).unwrap();
        assert_eq!(v["repoRoot"], canonical.to_string_lossy());
    }

    #[tokio::test]
    async fn icon_serves_svg_with_security_headers_and_etag_304() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = mkrepo_with_icon(&tmp);
        let uri = icon_uri(&repo);
        let resp = get(router(test_state()), &uri, true, &[]).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let headers = resp.headers().clone();
        assert_eq!(headers["content-type"], "image/svg+xml");
        assert_eq!(headers["x-content-type-options"], "nosniff");
        assert_eq!(
            headers["content-security-policy"],
            "default-src 'none'; style-src 'unsafe-inline'"
        );
        assert_eq!(headers["content-disposition"], "inline");
        assert_eq!(headers["cache-control"], "private, max-age=60");
        let etag = headers["etag"].to_str().unwrap().to_string();
        let resp2 = get(router(test_state()), &uri, true, &[("if-none-match", etag.as_str())]).await;
        assert_eq!(resp2.status(), StatusCode::NOT_MODIFIED);
    }

    #[tokio::test]
    async fn no_icon_is_404_and_meta_has_icon_false() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("bare");
        fs::create_dir_all(repo.join(".git")).unwrap();
        let resp = get(router(test_state()), &icon_uri(&repo), true, &[]).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        let uri = format!(
            "/api/repo-icon/meta?cwd={}",
            urlencoding_encode(&repo.to_string_lossy())
        );
        let resp = get(router(test_state()), &uri, true, &[]).await;
        let v = body_json(resp).await;
        assert_eq!(v["hasIcon"], false);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlink_escape_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().join("outside.png");
        // A valid square PNG outside the repo.
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&128u32.to_be_bytes());
        png.extend_from_slice(&128u32.to_be_bytes());
        png.extend_from_slice(&[8, 6, 0, 0, 0]);
        fs::write(&outside, png).unwrap();
        let repo = tmp.path().join("proj");
        fs::create_dir_all(repo.join(".git")).unwrap();
        std::os::unix::fs::symlink(&outside, repo.join("logo.png")).unwrap();
        let resp = get(router(test_state()), &icon_uri(&repo), true, &[]).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn repo_root_outside_allowlist_is_forbidden() {
        // cwd is inside an allowed root, but the `.git` walk resolves the repo
        // root to an ANCESTOR outside every allowed root -> Forbidden. The
        // upward walk must never serve bytes from outside the sandbox.
        let tmp = tempfile::tempdir().unwrap();
        let repo = mkrepo_with_icon(&tmp); // tmp/proj: has .git + icon
        let inner = repo.join("workdir");
        fs::create_dir_all(&inner).unwrap();
        let state = test_state();
        let outcome = resolve_repo_and_icon(
            &state,
            &inner.to_string_lossy(),
            Some(&[inner.to_string_lossy().into_owned()]), // only workdir allowed
        );
        assert!(matches!(outcome, Err(ResolveFailure::Forbidden)));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinked_cwd_escaping_allowlist_is_forbidden() {
        // A symlink INSIDE an allowed root pointing OUTSIDE it: the raw path
        // passes the string-prefix check, so the canonical path must be
        // re-checked (Node realpath parity).
        let tmp = tempfile::tempdir().unwrap();
        let outside_repo = mkrepo_with_icon(&tmp); // tmp/proj, outside allowed
        let allowed = tmp.path().join("allowed");
        fs::create_dir_all(&allowed).unwrap();
        std::os::unix::fs::symlink(&outside_repo, allowed.join("link")).unwrap();
        let state = test_state();
        let outcome = resolve_repo_and_icon(
            &state,
            &allowed.join("link").to_string_lossy(),
            Some(&[allowed.to_string_lossy().into_owned()]),
        );
        assert!(matches!(outcome, Err(ResolveFailure::Forbidden)));
    }

    #[tokio::test]
    async fn cache_invalidates_when_icon_deleted() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = mkrepo_with_icon(&tmp);
        let state = test_state();
        let r1 = router(state.clone());
        assert_eq!(get(r1, &icon_uri(&repo), true, &[]).await.status(), StatusCode::OK);
        fs::remove_file(repo.join("public/favicon.svg")).unwrap();
        let r2 = router(state);
        assert_eq!(
            get(r2, &icon_uri(&repo), true, &[]).await.status(),
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn worktree_cwd_resolves_to_main_repo_icon() {
        let tmp = tempfile::tempdir().unwrap();
        let main_repo = mkrepo_with_icon(&tmp); // "proj", has public/favicon.svg
        let wt_gitdir = main_repo.join(".git/worktrees/wt1");
        fs::create_dir_all(&wt_gitdir).unwrap();
        fs::write(wt_gitdir.join("commondir"), "../..\n").unwrap();
        let worktree = tmp.path().join("wt1");
        fs::create_dir_all(&worktree).unwrap();
        fs::write(worktree.join(".git"), format!("gitdir: {}\n", wt_gitdir.display())).unwrap();
        let uri = format!(
            "/api/repo-icon/meta?cwd={}",
            urlencoding_encode(&worktree.to_string_lossy())
        );
        let resp = get(router(test_state()), &uri, true, &[]).await;
        let v = body_json(resp).await;
        assert_eq!(v["repoName"], "proj");
        assert_eq!(v["hasIcon"], true);
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test -p freshell-server repo_icon::tests`
Expected: FAIL to compile — `RepoIconState`, `router`, `resolve_repo_and_icon`, `ResolveFailure` not defined.

- [ ] **Step 4: Implement the module**

Add above the tests in `repo_icon.rs`:

```rust
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::repo_icon_detect::{detect_icon, sha256_hex, svg_is_dangerous};
use crate::repo_icon_git::{resolve_repo, RepoInfo};
use crate::settings_store::SettingsStore;

const NEGATIVE_CACHE_TTL: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub struct RepoIconState {
    pub auth_token: Arc<String>,
    pub settings: SettingsStore,
    pub cache: Arc<Mutex<HashMap<PathBuf, CacheEntry>>>,
}

#[derive(Clone)]
pub struct CacheEntry {
    pub icon: Option<IconFile>,
    pub checked_at: Instant,
}

#[derive(Clone)]
pub struct IconFile {
    pub path: PathBuf,
    pub mtime: SystemTime,
    pub size: u64,
}

#[derive(Debug, Deserialize)]
struct CwdQuery {
    cwd: Option<String>,
}

pub fn router(state: RepoIconState) -> Router {
    Router::new()
        .route("/api/repo-icon", get(serve_icon))
        .route("/api/repo-icon/meta", get(icon_meta))
        .with_state(state)
}

#[derive(Debug)]
enum ResolveFailure {
    BadRequest(&'static str),
    Forbidden,
    NotFound,
}

fn failure_response(failure: ResolveFailure) -> Response {
    match failure {
        ResolveFailure::BadRequest(msg) => crate::files::bad_request(msg),
        ResolveFailure::Forbidden => crate::files::forbidden(),
        ResolveFailure::NotFound => crate::files::not_found("Path not found"),
    }
}

/// Sandbox + resolve + detect (with cache). The `allowed_file_paths` sandbox
/// is a hard security boundary for file disclosure (see the "security-relevant"
/// R3/FILE-05 notes in files.rs and the rest-parity report), and this surface
/// walks UPWARD from the cwd — so the allowlist is enforced three times:
/// 1. on the raw normalized cwd (parity with the files.rs surfaces),
/// 2. re-checked on the CANONICAL cwd — a symlinked cwd inside an allowed root
///    must not escape it (parity with Node's realpath-before-allowlist in
///    `isPathAllowed`, `server/path-utils.ts:291-313`; the Rust
///    `files::is_path_allowed` does NOT canonicalize),
/// 3. on the CANONICAL resolved repo root — the `.git` walk can land on an
///    ancestor outside every allowed root, and everything served comes from
///    under it.
/// Separately, the winning candidate is canonicalized and must stay inside the
/// repo root after symlink resolution (repo-root containment, not allowlist).
fn resolve_repo_and_icon(
    state: &RepoIconState,
    cwd_param: &str,
    allowed_roots: Option<&[String]>,
) -> Result<(RepoInfo, Option<IconFile>), ResolveFailure> {
    let normalized = crate::files::normalize_user_path(cwd_param);
    if !Path::new(&normalized).is_absolute() {
        return Err(ResolveFailure::BadRequest("cwd must be an absolute path"));
    }
    // (1) raw-path check first: clearly-disallowed paths get Forbidden without
    // an existence probe (matches files.rs ordering).
    if !crate::files::is_path_allowed(&normalized, allowed_roots) {
        return Err(ResolveFailure::Forbidden);
    }
    let canonical_cwd =
        std::fs::canonicalize(&normalized).map_err(|_| ResolveFailure::NotFound)?;
    // (2) re-check the canonical cwd: symlink-escape defense.
    if !crate::files::is_path_allowed(&canonical_cwd.to_string_lossy(), allowed_roots) {
        return Err(ResolveFailure::Forbidden);
    }
    let repo = resolve_repo(&canonical_cwd);
    let repo_root =
        std::fs::canonicalize(&repo.repo_root).map_err(|_| ResolveFailure::NotFound)?;
    // (3) the upward `.git` walk must not leave the sandbox: bytes are served
    // from under repo_root, so repo_root itself must be allowed.
    if !crate::files::is_path_allowed(&repo_root.to_string_lossy(), allowed_roots) {
        return Err(ResolveFailure::Forbidden);
    }
    let repo = RepoInfo {
        checkout_root: repo.checkout_root,
        repo_root: repo_root.clone(),
    };

    if let Ok(cache) = state.cache.lock() {
        if let Some(entry) = cache.get(&repo_root).cloned() {
            match &entry.icon {
                Some(icon) => {
                    if let Ok(meta) = std::fs::metadata(&icon.path) {
                        if meta.modified().ok() == Some(icon.mtime) && meta.len() == icon.size {
                            return Ok((repo, entry.icon));
                        }
                    }
                    // Winner changed or vanished -> fall through to re-detect.
                }
                None => {
                    if entry.checked_at.elapsed() < NEGATIVE_CACHE_TTL {
                        return Ok((repo, None));
                    }
                }
            }
        }
    }

    let icon = detect_icon(&repo_root)
        .and_then(|path| std::fs::canonicalize(&path).ok())
        .filter(|canonical| canonical.starts_with(&repo_root))
        .and_then(|canonical| {
            let meta = std::fs::metadata(&canonical).ok()?;
            Some(IconFile {
                path: canonical,
                mtime: meta.modified().ok()?,
                size: meta.len(),
            })
        });
    if let Ok(mut cache) = state.cache.lock() {
        cache.insert(
            repo_root,
            CacheEntry { icon: icon.clone(), checked_at: Instant::now() },
        );
    }
    Ok((repo, icon))
}

fn content_type_for(ext: &str) -> &'static str {
    // Mirrors serve_client.rs's hand-rolled table for the image surface.
    match ext {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

async fn icon_meta(
    State(state): State<RepoIconState>,
    headers: HeaderMap,
    Query(q): Query<CwdQuery>,
) -> Response {
    if !crate::boot::is_authed(&headers, &state.auth_token) {
        return crate::boot::unauthorized();
    }
    let Some(cwd) = q.cwd.filter(|c| !c.is_empty()) else {
        return crate::files::bad_request("cwd query parameter required");
    };
    let settings = state.settings.get().await;
    match resolve_repo_and_icon(&state, &cwd, settings.allowed_file_paths.as_deref()) {
        Ok((repo, icon)) => {
            let repo_name = repo
                .repo_root
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| repo.repo_root.to_string_lossy().into_owned());
            Json(json!({
                "repoRoot": repo.repo_root.to_string_lossy(),
                "checkoutRoot": repo.checkout_root.to_string_lossy(),
                "repoName": repo_name,
                "hasIcon": icon.is_some(),
            }))
            .into_response()
        }
        Err(failure) => failure_response(failure),
    }
}

async fn serve_icon(
    State(state): State<RepoIconState>,
    headers: HeaderMap,
    Query(q): Query<CwdQuery>,
) -> Response {
    if !crate::boot::is_authed(&headers, &state.auth_token) {
        return crate::boot::unauthorized();
    }
    let Some(cwd) = q.cwd.filter(|c| !c.is_empty()) else {
        return crate::files::bad_request("cwd query parameter required");
    };
    let settings = state.settings.get().await;
    let icon = match resolve_repo_and_icon(&state, &cwd, settings.allowed_file_paths.as_deref()) {
        Ok((_, Some(icon))) => icon,
        Ok((_, None)) => return crate::files::not_found("No repo icon detected"),
        Err(failure) => return failure_response(failure),
    };
    let Ok(bytes) = std::fs::read(&icon.path) else {
        return crate::files::not_found("No repo icon detected");
    };
    let ext = icon
        .path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    // Belt-and-braces: the detector already rejects dangerous SVGs, but the
    // file may have changed between detection and serving.
    if ext == "svg" && svg_is_dangerous(&String::from_utf8_lossy(&bytes)) {
        return crate::files::not_found("No repo icon detected");
    }
    let mtime_ms = icon
        .mtime
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let etag_input = format!("{}|{}|{}", icon.path.display(), mtime_ms, icon.size);
    let etag = format!("\"{}\"", &sha256_hex(etag_input.as_bytes())[..16]);
    let etag_header = HeaderValue::from_str(&etag).ok();
    if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        == Some(etag.as_str())
    {
        let mut resp = StatusCode::NOT_MODIFIED.into_response();
        if let Some(v) = etag_header {
            resp.headers_mut().insert(header::ETAG, v);
        }
        return resp;
    }
    let mut resp = (StatusCode::OK, bytes).into_response();
    let h = resp.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(content_type_for(&ext)),
    );
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=60"),
    );
    if let Some(v) = etag_header {
        h.insert(header::ETAG, v);
    }
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    if ext == "svg" {
        h.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("default-src 'none'; style-src 'unsafe-inline'"),
        );
        h.insert(header::CONTENT_DISPOSITION, HeaderValue::from_static("inline"));
    }
    resp
}
```

Notes for the implementer:
- Confirm the `SettingsStore` import path by copying whatever `use` line `files.rs` has for it (it constructs `FilesState { settings: SettingsStore, .. }`); adjust `use crate::settings_store::SettingsStore;` if the actual module path differs.
- Confirm `settings.get().await` and `settings.allowed_file_paths` by mirroring the exact calls in `files.rs::read_file` (lines ~184–185). If the settings getter or field names differ, mirror `files.rs` exactly.
- Blocking `std::fs` in async handlers is the established `files.rs` pattern in this crate — keep it.

- [ ] **Step 5: Register the router in `main.rs`**

In `crates/freshell-server/src/main.rs`, find where `files_state` is constructed (just before `.merge(files::router(files_state))`, ~line 959). Immediately after it, construct the repo-icon state **reusing the same auth-token Arc and SettingsStore that `files_state` receives** (clone the exact same expressions used there — do not introduce a second token source):

```rust
    let repo_icon_state = repo_icon::RepoIconState {
        auth_token: /* same Arc<String> expression files_state uses */,
        settings: /* same SettingsStore expression files_state uses (clone it) */,
        cache: std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
    };
```

(The two `/* … */` slots are filled by copying the two corresponding field initializers verbatim from the adjacent `files_state` literal — e.g. if files uses `auth_token: Arc::clone(&auth_token)`, use exactly that.)

Then add to the router chain, after `.merge(files::router(files_state))`:

```rust
        .merge(repo_icon::router(repo_icon_state))
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cargo test -p freshell-server repo_icon`
Expected: PASS (git + detect + HTTP tests, ~35 total across the three modules).

- [ ] **Step 7: Remove the temporary dead-code allows, run the full Rust gate, and commit**

Now that the router wires `resolve_repo` and `detect_icon` into the non-test build, delete the `#![allow(dead_code)]` line (and its `// TEMPORARY …` comment) from BOTH `crates/freshell-server/src/repo_icon_git.rs` and `crates/freshell-server/src/repo_icon_detect.rs` (added in Tasks 1–2). The clippy gate below then verifies nothing is actually dead.

```bash
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p freshell-server
git add crates/freshell-server/src/repo_icon.rs crates/freshell-server/src/files.rs crates/freshell-server/src/main.rs crates/freshell-server/src/repo_icon_git.rs crates/freshell-server/src/repo_icon_detect.rs
git commit -m "feat(rust): /api/repo-icon + /api/repo-icon/meta endpoints with sandboxing, ETag, SVG hardening"
```

---

### Task 7: `panes.repoIconsOnTabs` setting (browser-local, default ON)

**Files:**
- Modify: `shared/settings.ts` (4 registration points)
- Modify: `src/store/browserPreferencesPersistence.ts:106-115`
- Modify: `src/components/settings/PanesSettings.tsx` (after the `multirowTabs` row, ~line 87)
- Test: `test/unit/shared/settings.test.ts`, `test/unit/client/components/SettingsView.panes.test.tsx`

**Interfaces:**
- Consumes: the existing `iconsOnTabs`/`multirowTabs` local-setting pattern.
- Produces: `settings.panes.repoIconsOnTabs: boolean` (resolved settings, default `true`) readable via `useAppSelector((s) => s.settings?.settings?.panes?.repoIconsOnTabs ?? true)`. Tasks 10–11 consume it.

- [ ] **Step 1: Write the failing shared-settings tests**

In `test/unit/shared/settings.test.ts`, find the existing `multirowTabs` local-key block (lines ~566–604) and add a sibling block immediately after it, reusing the exact same imports and schema construction that block uses:

```ts
describe('panes.repoIconsOnTabs (browser-local)', () => {
  it('defaults to true', () => {
    const local = resolveLocalSettings(undefined)
    expect(local.panes.repoIconsOnTabs).toBe(true)
  })

  it('applies a boolean patch', () => {
    const local = resolveLocalSettings({ panes: { repoIconsOnTabs: false } })
    expect(local.panes.repoIconsOnTabs).toBe(false)
  })

  it('merges patches preserving other pane keys', () => {
    const merged = mergeLocalSettings(
      { panes: { iconsOnTabs: false } },
      { panes: { repoIconsOnTabs: false } },
    )
    expect(merged.panes?.iconsOnTabs).toBe(false)
    expect(merged.panes?.repoIconsOnTabs).toBe(false)
  })

  it('is rejected by the server patch schema (stays local)', () => {
    // Construct the schema exactly as the multirowTabs test above does.
    expect(schema.safeParse({ panes: { repoIconsOnTabs: true } }).success).toBe(false)
  })
})
```

(For the last test, copy the `schema` construction line verbatim from the `multirowTabs` test at line ~604 — it already builds `buildServerSettingsPatchSchema(...)` with the right arguments.)

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:vitest -- run test/unit/shared/settings.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — `repoIconsOnTabs` missing from defaults/type (TS error or `undefined !== true`).

- [ ] **Step 3: Register the key in `shared/settings.ts` (4 points)**

1. Line ~74 — add to `PANES_LOCAL_KEYS`:
```ts
const PANES_LOCAL_KEYS = ['snapThreshold', 'iconsOnTabs', 'tabAttentionStyle', 'attentionDismiss', 'sessionOpenMode', 'multirowTabs', 'repoIconsOnTabs'] as const
```
2. `LocalSettings['panes']` (~line 195-202) — add:
```ts
    repoIconsOnTabs: boolean
```
3. In the local-patch normalizer's `panes` block (~line 547-549), clone the `multirowTabs` guard:
```ts
    if (typeof patch.panes.repoIconsOnTabs === 'boolean') {
      panes.repoIconsOnTabs = patch.panes.repoIconsOnTabs as boolean
    }
```
4. `defaultLocalSettings.panes` (~line 837-844) — add:
```ts
    repoIconsOnTabs: true,
```

- [ ] **Step 4: Register persistence**

In `src/store/browserPreferencesPersistence.ts` (~line 106-115), after the `multirowTabs` line add:

```ts
  assignChangedScalar(panes, localSettings.panes, defaultLocalSettings.panes, 'repoIconsOnTabs')
```

- [ ] **Step 5: Run the shared tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/shared/settings.test.ts --config config/vitest/vitest.config.ts`
Expected: PASS (including the 4 new tests).

- [ ] **Step 6: Write the failing UI test**

In `test/unit/client/components/SettingsView.panes.test.tsx`, next to the existing `iconsOnTabs` test (~line 209), add:

```tsx
  it('toggles repo icons on tabs locally without calling /api/settings', async () => {
    const store = createTestStore('ask', { panes: { repoIconsOnTabs: true } })
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )
    switchSettingsTab('Panes')

    // Do NOT copy the iconsOnTabs test's `closest('div')` pattern here: this
    // row has a `description`, so SettingsRow nests the label inside an inner
    // text-only div and `closest('div')` would return that div (no button in
    // it). Select the switch by its accessible name instead — Step 7's Toggle
    // sets aria-label="Toggle repo icons on tabs".
    const toggle = screen.getByRole('switch', { name: 'Toggle repo icons on tabs' })
    fireEvent.click(toggle)

    expect(store.getState().settings.settings.panes.repoIconsOnTabs).toBe(false)

    await act(async () => {
      vi.advanceTimersByTime(600)
    })

    expect(api.patch).not.toHaveBeenCalled()
  })
```

Run: `npm run test:vitest -- run test/unit/client/components/SettingsView.panes.test.tsx --config config/vitest/vitest.config.ts`
Expected: FAIL — `Unable to find an accessible element with the role "switch" and name "Toggle repo icons on tabs"` (the row and its Toggle are added in Step 7).

- [ ] **Step 7: Add the toggle UI**

In `src/components/settings/PanesSettings.tsx`, after the `Multi-row tabs` row (~line 87), add:

```tsx
        <SettingsRow label="Repo icons on tabs" description="Show the repository's icon next to each coding-agent icon on tabs.">
          <Toggle
            checked={settings.panes?.repoIconsOnTabs ?? true}
            aria-label="Toggle repo icons on tabs"
            onChange={(checked) => {
              applyLocalSetting({ panes: { repoIconsOnTabs: checked } })
            }}
          />
        </SettingsRow>
```

- [ ] **Step 8: Run tests, lint, commit**

```bash
npm run test:vitest -- run test/unit/client/components/SettingsView.panes.test.tsx --config config/vitest/vitest.config.ts
npm run test:vitest -- run test/unit/shared/settings.test.ts --config config/vitest/vitest.config.ts
npm run lint
npm run typecheck:client
git add shared/settings.ts src/store/browserPreferencesPersistence.ts src/components/settings/PanesSettings.tsx test/unit/shared/settings.test.ts test/unit/client/components/SettingsView.panes.test.tsx
git commit -m "feat(settings): panes.repoIconsOnTabs browser-local toggle (default on)"
```

Expected: all PASS; lint clean.

---

### Task 8: `RepoIcon` component + repo-icon client helpers

**Files:**
- Create: `src/lib/repo-icon.ts`
- Create: `src/components/icons/RepoIcon.tsx`
- Test: `test/unit/client/lib/repo-icon.test.ts`, `test/unit/client/components/icons/RepoIcon.test.tsx`

**Interfaces:**
- Consumes: `PaneContent` (`@/store/paneTypes`), `Tab` (`@/store/types`), `TerminalMetaRecord` (`@/store/terminalMetaSlice`), `isNonShellMode` (`@/lib/coding-cli-utils`), `cn` (`@/lib/utils`).
- Produces (consumed by Tasks 9–11):
  - `src/lib/repo-icon.ts`: `resolvePaneRepoCwd(content: PaneContent, tab: Tab | undefined, terminalMetaById: Record<string, TerminalMetaRecord>): string | undefined`, `pathBasename(p: string): string`, `buildRepoIconUrl(cwd: string): string`.
  - `src/components/icons/RepoIcon.tsx`: default export `RepoIcon({ info, className }: { info: RepoIconInfo; className?: string })`, `export interface RepoIconInfo { repoKey: string; repoName: string; iconUrl?: string }`, `export function hueFromString(input: string): number`.

- [ ] **Step 1: Write the failing helper tests**

Create `test/unit/client/lib/repo-icon.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolvePaneRepoCwd, pathBasename, buildRepoIconUrl } from '@/lib/repo-icon'
import type { PaneContent } from '@/store/paneTypes'
import type { Tab } from '@/store/types'
import type { TerminalMetaRecord } from '@/store/terminalMetaSlice'

const NO_META: Record<string, TerminalMetaRecord> = {}

function terminalContent(overrides: Partial<Extract<PaneContent, { kind: 'terminal' }>> = {}): PaneContent {
  return {
    kind: 'terminal',
    createRequestId: 'req-1',
    status: 'running',
    mode: 'claude',
    ...overrides,
  } as PaneContent
}

describe('resolvePaneRepoCwd', () => {
  it('returns undefined for plain shell terminals', () => {
    expect(resolvePaneRepoCwd(terminalContent({ mode: 'shell', initialCwd: '/x' }), undefined, NO_META)).toBeUndefined()
  })

  it('uses initialCwd for coding-CLI terminals', () => {
    expect(resolvePaneRepoCwd(terminalContent({ initialCwd: '/home/u/proj' }), undefined, NO_META)).toBe('/home/u/proj')
  })

  it('prefers terminalMeta repoRoot over initialCwd (Node server enrichment)', () => {
    const meta: Record<string, TerminalMetaRecord> = {
      't1': { terminalId: 't1', updatedAt: 1, cwd: '/home/u/proj/sub', repoRoot: '/home/u/proj' },
    }
    expect(
      resolvePaneRepoCwd(terminalContent({ terminalId: 't1', initialCwd: '/home/u/proj/sub' }), undefined, meta),
    ).toBe('/home/u/proj')
  })

  it('falls back to the tab initialCwd', () => {
    const tab = { id: 'tab-1', initialCwd: '/from/tab' } as Tab
    expect(resolvePaneRepoCwd(terminalContent(), tab, NO_META)).toBe('/from/tab')
  })

  it('uses initialCwd for fresh-agent panes', () => {
    const content = {
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      createRequestId: 'req-2',
      status: 'running',
      initialCwd: '/home/u/agent-proj',
    } as unknown as PaneContent
    expect(resolvePaneRepoCwd(content, undefined, NO_META)).toBe('/home/u/agent-proj')
  })

  it('returns undefined for browser/editor/picker panes', () => {
    const browser = { kind: 'browser', url: 'https://x', createRequestId: 'r' } as unknown as PaneContent
    expect(resolvePaneRepoCwd(browser, undefined, NO_META)).toBeUndefined()
  })
})

describe('pathBasename', () => {
  it('handles trailing slashes and both separators', () => {
    expect(pathBasename('/home/u/proj')).toBe('proj')
    expect(pathBasename('/home/u/proj/')).toBe('proj')
    expect(pathBasename('C:\\code\\proj')).toBe('proj')
    expect(pathBasename('proj')).toBe('proj')
  })
})

describe('buildRepoIconUrl', () => {
  it('percent-encodes the cwd', () => {
    expect(buildRepoIconUrl('/home/u/my proj')).toBe('/api/repo-icon?cwd=%2Fhome%2Fu%2Fmy%20proj')
  })
})
```

Run: `npm run test:vitest -- run test/unit/client/lib/repo-icon.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — module `@/lib/repo-icon` not found.

- [ ] **Step 2: Implement `src/lib/repo-icon.ts`**

```ts
import { isNonShellMode } from '@/lib/coding-cli-utils'
import type { PaneContent } from '@/store/paneTypes'
import type { Tab } from '@/store/types'
import type { TerminalMetaRecord } from '@/store/terminalMetaSlice'

/**
 * The cwd hint used to identify a pane's repo, for coding-agent panes only.
 * Terminal panes: terminalMeta (repoRoot > checkoutRoot > cwd — populated by
 * the Node server; identity-only on Rust) then the pane/tab initialCwd.
 * Fresh-agent panes: their initialCwd. Plain shells and non-terminal panes
 * are out of scope (return undefined).
 */
export function resolvePaneRepoCwd(
  content: PaneContent,
  tab: Tab | undefined,
  terminalMetaById: Record<string, TerminalMetaRecord>,
): string | undefined {
  if (content.kind === 'terminal') {
    if (!isNonShellMode(content.mode)) return undefined
    const meta = content.terminalId ? terminalMetaById[content.terminalId] : undefined
    return meta?.repoRoot || meta?.checkoutRoot || meta?.cwd || content.initialCwd || tab?.initialCwd
  }
  if (content.kind === 'fresh-agent') {
    return content.initialCwd || tab?.initialCwd
  }
  return undefined
}

/** Last path segment, tolerant of trailing separators and backslashes. */
export function pathBasename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

/** Relative same-origin URL; auth rides the freshell-auth cookie (img cannot set headers). */
export function buildRepoIconUrl(cwd: string): string {
  return `/api/repo-icon?cwd=${encodeURIComponent(cwd)}`
}
```

Run the test again. Expected: PASS.

- [ ] **Step 3: Write the failing component tests**

Create `test/unit/client/components/icons/RepoIcon.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import RepoIcon, { hueFromString } from '@/components/icons/RepoIcon'

afterEach(cleanup)

describe('RepoIcon', () => {
  it('renders an <img> when iconUrl is provided', () => {
    render(<RepoIcon info={{ repoKey: '/r', repoName: 'freshell', iconUrl: '/api/repo-icon?cwd=%2Fr' }} className="h-3 w-3" />)
    const img = document.querySelector('img')!
    expect(img).toBeTruthy()
    expect(img.getAttribute('src')).toBe('/api/repo-icon?cwd=%2Fr')
    expect(img.getAttribute('aria-hidden')).toBe('true')
    expect(img.getAttribute('alt')).toBe('')
  })

  it('falls back to the letter avatar when the image errors', () => {
    render(<RepoIcon info={{ repoKey: '/r', repoName: 'freshell', iconUrl: '/api/repo-icon?cwd=%2Fr' }} />)
    fireEvent.error(document.querySelector('img')!)
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText('F')).toBeTruthy()
  })

  it('renders the uppercased first letter when no iconUrl', () => {
    render(<RepoIcon info={{ repoKey: '/r', repoName: 'freshell' }} />)
    expect(screen.getByText('F')).toBeTruthy()
    const svg = document.querySelector('svg')!
    expect(svg.getAttribute('aria-hidden')).toBe('true')
  })

  it('uses a deterministic hue per repo name', () => {
    expect(hueFromString('freshell')).toBe(hueFromString('freshell'))
    expect(hueFromString('freshell')).not.toBe(hueFromString('other-repo'))
    const h = hueFromString('anything at all')
    expect(h).toBeGreaterThanOrEqual(0)
    expect(h).toBeLessThan(360)
  })

  it('renders ? for an empty repo name', () => {
    render(<RepoIcon info={{ repoKey: '/r', repoName: '' }} />)
    expect(screen.getByText('?')).toBeTruthy()
  })
})
```

Run: `npm run test:vitest -- run test/unit/client/components/icons/RepoIcon.test.tsx --config config/vitest/vitest.config.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/components/icons/RepoIcon.tsx`**

```tsx
import { useState } from 'react'
import { cn } from '@/lib/utils'

export interface RepoIconInfo {
  /** Canonical repo identity (repoRoot when known, else the cwd hint). */
  repoKey: string
  /** Display name — basename of the repo root (all worktrees share it). */
  repoName: string
  /** Set when the server reports a detected icon. */
  iconUrl?: string
}

interface RepoIconProps {
  info: RepoIconInfo
  className?: string
}

/** djb2 string hash -> stable hue in [0, 360). */
export function hueFromString(input: string): number {
  let hash = 5381
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0
  }
  return Math.abs(hash) % 360
}

/**
 * Decorative repo identity icon: the repo's own icon via the server when
 * available, else a letter avatar (uppercase first letter on a circle with a
 * deterministic per-repo hue). Rendered ONLY via <img src> for server bytes —
 * remote SVG is never inlined into the DOM.
 */
export default function RepoIcon({ info, className }: RepoIconProps) {
  const [imgFailed, setImgFailed] = useState(false)
  if (info.iconUrl && !imgFailed) {
    return (
      <img
        src={info.iconUrl}
        alt=""
        aria-hidden="true"
        className={cn('shrink-0 rounded-[2px] object-contain', className)}
        onError={() => setImgFailed(true)}
      />
    )
  }
  const letter = (info.repoName.trim()[0] || '?').toUpperCase()
  // 60% saturation / 42% lightness keeps white text readable on the circle
  // in both light and dark themes.
  const hue = hueFromString(info.repoName)
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={cn('shrink-0', className)}>
      <circle cx="8" cy="8" r="8" fill={`hsl(${hue}, 60%, 42%)`} />
      <text
        x="8"
        y="8.5"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="9"
        fontWeight="600"
        fill="white"
      >
        {letter}
      </text>
    </svg>
  )
}
```

- [ ] **Step 5: Run tests, lint, commit**

```bash
npm run test:vitest -- run test/unit/client/lib/repo-icon.test.ts test/unit/client/components/icons/RepoIcon.test.tsx --config config/vitest/vitest.config.ts
npm run lint
npm run typecheck:client
git add src/lib/repo-icon.ts src/components/icons/RepoIcon.tsx test/unit/client/lib/repo-icon.test.ts test/unit/client/components/icons/RepoIcon.test.tsx
git commit -m "feat(client): RepoIcon component with letter-avatar fallback + repo cwd resolution helpers"
```

Expected: all PASS; lint clean.

---

### Task 9: `repoIcons` Redux slice + probe thunk

**Files:**
- Create: `src/store/repoIconsSlice.ts`
- Modify: `src/store/store.ts` (register reducer)
- Test: `test/unit/client/store/repoIconsSlice.test.ts`

**Interfaces:**
- Consumes: `api.get` (`@/lib/api`), `pathBasename` (`@/lib/repo-icon`), Task 6's meta endpoint contract.
- Produces (consumed by Tasks 10–11):
  - State `state.repoIcons.byCwd: Record<string, RepoIconEntry>` with `export type RepoIconEntry = { status: 'loading' | 'ready' | 'error'; repoRoot?: string; checkoutRoot?: string; repoName?: string; hasIcon?: boolean }`.
  - `export const fetchRepoIconMeta: AsyncThunk` keyed by cwd string; safe to dispatch repeatedly (a `condition` prevents duplicate probes — the "no 404 storm / remembered in Redux" requirement).

- [ ] **Step 1: Write the failing slice tests**

Create `test/unit/client/store/repoIconsSlice.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import repoIconsReducer, { fetchRepoIconMeta } from '@/store/repoIconsSlice'

describe('repoIconsSlice', () => {
  it('marks loading on pending', () => {
    const state = repoIconsReducer(undefined, {
      type: fetchRepoIconMeta.pending.type,
      meta: { arg: '/home/u/proj' },
    })
    expect(state.byCwd['/home/u/proj']).toEqual({ status: 'loading' })
  })

  it('stores meta on fulfilled', () => {
    const state = repoIconsReducer(undefined, {
      type: fetchRepoIconMeta.fulfilled.type,
      meta: { arg: '/home/u/proj' },
      payload: { repoRoot: '/home/u/proj', checkoutRoot: '/home/u/proj', repoName: 'proj', hasIcon: true },
    })
    expect(state.byCwd['/home/u/proj']).toEqual({
      status: 'ready',
      repoRoot: '/home/u/proj',
      checkoutRoot: '/home/u/proj',
      repoName: 'proj',
      hasIcon: true,
    })
  })

  it('falls back to cwd basename on rejection (endpoint absent, e.g. Node dev server)', () => {
    const state = repoIconsReducer(undefined, {
      type: fetchRepoIconMeta.rejected.type,
      meta: { arg: '/home/u/code/myrepo' },
      error: { message: 'Not found' },
    })
    expect(state.byCwd['/home/u/code/myrepo']).toEqual({
      status: 'error',
      hasIcon: false,
      repoName: 'myrepo',
    })
  })
})
```

Run: `npm run test:vitest -- run test/unit/client/store/repoIconsSlice.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement the slice**

Create `src/store/repoIconsSlice.ts`:

```ts
import { createAsyncThunk, createSlice } from '@reduxjs/toolkit'
import { api } from '@/lib/api'
import { pathBasename } from '@/lib/repo-icon'

export type RepoIconEntry = {
  status: 'loading' | 'ready' | 'error'
  repoRoot?: string
  checkoutRoot?: string
  repoName?: string
  hasIcon?: boolean
}

export type RepoIconsState = {
  byCwd: Record<string, RepoIconEntry>
}

type RepoIconMetaResponse = {
  repoRoot: string
  checkoutRoot: string
  repoName: string
  hasIcon: boolean
}

const initialState: RepoIconsState = { byCwd: {} }

/**
 * Probe the repo-icon meta endpoint once per distinct cwd. Rejections
 * (including a 404 from the Node dev server, which has no such endpoint)
 * are remembered as "no icon" so the letter avatar renders without re-probing.
 */
export const fetchRepoIconMeta = createAsyncThunk(
  'repoIcons/fetchMeta',
  async (cwd: string) =>
    api.get<RepoIconMetaResponse>(`/api/repo-icon/meta?cwd=${encodeURIComponent(cwd)}`),
  {
    condition: (cwd, { getState }) => {
      const state = getState() as { repoIcons?: RepoIconsState }
      return !state.repoIcons?.byCwd[cwd]
    },
  },
)

const repoIconsSlice = createSlice({
  name: 'repoIcons',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchRepoIconMeta.pending, (state, action) => {
        state.byCwd[action.meta.arg] = { status: 'loading' }
      })
      .addCase(fetchRepoIconMeta.fulfilled, (state, action) => {
        state.byCwd[action.meta.arg] = {
          status: 'ready',
          repoRoot: action.payload.repoRoot,
          checkoutRoot: action.payload.checkoutRoot,
          repoName: action.payload.repoName,
          hasIcon: action.payload.hasIcon,
        }
      })
      .addCase(fetchRepoIconMeta.rejected, (state, action) => {
        state.byCwd[action.meta.arg] = {
          status: 'error',
          hasIcon: false,
          repoName: pathBasename(action.meta.arg),
        }
      })
  },
})

export default repoIconsSlice.reducer
```

- [ ] **Step 3: Register the reducer**

In `src/store/store.ts`: add the import next to the other slice imports —

```ts
import repoIconsReducer from './repoIconsSlice'
```

and in the reducer map (lines ~41-62), next to `terminalMeta`:

```ts
    repoIcons: repoIconsReducer,
```

- [ ] **Step 4: Run tests, lint, commit**

```bash
npm run test:vitest -- run test/unit/client/store/repoIconsSlice.test.ts --config config/vitest/vitest.config.ts
npm run lint
npm run typecheck:client
git add src/store/repoIconsSlice.ts src/store/store.ts test/unit/client/store/repoIconsSlice.test.ts
git commit -m "feat(client): repoIcons slice with once-per-cwd meta probe and graceful 404 fallback"
```

Expected: PASS; lint clean.

---

### Task 10: TabBar/TabItem wiring — repo icons on tabs, deduped per repo

**Files:**
- Modify: `src/components/TabItem.tsx`
- Modify: `src/components/TabBar.tsx`
- Test: `test/unit/client/components/TabItem.test.tsx`, `test/unit/client/components/TabBar.test.tsx`

**Interfaces:**
- Consumes: `RepoIcon`/`RepoIconInfo` (Task 8), `resolvePaneRepoCwd`/`pathBasename`/`buildRepoIconUrl` (Task 8), `fetchRepoIconMeta` + `state.repoIcons.byCwd` (Task 9), `settings.panes.repoIconsOnTabs` (Task 7).
- Produces: `TabItemProps` gains `repoIconsOnTabs?: boolean` (default `true`) and `repoIcons?: Record<string, RepoIconInfo>` (keyed by `repoCwd`); `TabPaneEntry` gains `repoCwd?: string`. `MobileTabStrip.tsx` needs NO change (it renders its own markup and consumes neither `iconsOnTabs` nor `paneEntries`).

- [ ] **Step 1: Write the failing TabItem tests**

In `test/unit/client/components/TabItem.test.tsx`:

1. Add a `RepoIcon` mock right after the existing `PaneIcon` mock (~line 21):

```tsx
vi.mock('@/components/icons/RepoIcon', () => ({
  default: ({ info, className }: { info: any; className?: string }) => (
    <svg data-testid="repo-icon" data-repo-key={info?.repoKey} data-repo-name={info?.repoName} className={className} />
  ),
}))
```

2. Add a helper and a new describe block at the end of the file:

```tsx
describe('repo icons', () => {
  const codingContent = (initialCwd: string): PaneContent =>
    ({ kind: 'terminal', mode: 'claude', createRequestId: 'r', status: 'running', initialCwd } as PaneContent)

  const repoIcons = {
    '/repo/a': { repoKey: '/repo/a', repoName: 'a', iconUrl: '/api/repo-icon?cwd=%2Frepo%2Fa' },
    '/repo/b': { repoKey: '/repo/b', repoName: 'b' },
  }

  const entries = (cwds: Array<string | undefined>) =>
    cwds.map((repoCwd, i) => ({
      paneId: `pane-${i}`,
      content: codingContent(repoCwd ?? '/none'),
      repoCwd,
    }))

  it('renders one repo icon per distinct repo, left of that repo group', () => {
    render(
      <TabItem
        {...defaultProps}
        paneEntries={entries(['/repo/a', '/repo/a', '/repo/b'])}
        repoIcons={repoIcons}
      />,
    )
    const repoIconsRendered = screen.getAllByTestId('repo-icon')
    expect(repoIconsRendered).toHaveLength(2)
    expect(repoIconsRendered[0].getAttribute('data-repo-key')).toBe('/repo/a')
    expect(repoIconsRendered[1].getAttribute('data-repo-key')).toBe('/repo/b')
    expect(screen.getAllByTestId('pane-icon')).toHaveLength(3)
    // The first repo icon precedes the first pane icon in DOM order.
    const first = repoIconsRendered[0]
    const firstPane = screen.getAllByTestId('pane-icon')[0]
    expect(first.compareDocumentPosition(firstPane) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('sizes repo icons h-3 w-3 like agent icons', () => {
    render(<TabItem {...defaultProps} paneEntries={entries(['/repo/a'])} repoIcons={repoIcons} />)
    const icon = screen.getByTestId('repo-icon')
    expect(icon.getAttribute('class') || '').toContain('h-3 w-3')
  })

  it('renders no repo icons when repoIconsOnTabs is false', () => {
    render(
      <TabItem
        {...defaultProps}
        paneEntries={entries(['/repo/a'])}
        repoIcons={repoIcons}
        repoIconsOnTabs={false}
      />,
    )
    expect(screen.queryByTestId('repo-icon')).toBeNull()
    expect(screen.getAllByTestId('pane-icon')).toHaveLength(1)
  })

  it('renders no repo icon for entries without repoCwd or without loaded info', () => {
    render(
      <TabItem
        {...defaultProps}
        paneEntries={entries([undefined, '/repo/unknown'])}
        repoIcons={repoIcons}
      />,
    )
    expect(screen.queryByTestId('repo-icon')).toBeNull()
    expect(screen.getAllByTestId('pane-icon')).toHaveLength(2)
  })
})
```

Run: `npm run test:vitest -- run test/unit/client/components/TabItem.test.tsx --config config/vitest/vitest.config.ts`
Expected: FAIL — new tests fail (`repo-icon` testid never rendered); existing tests still pass.

- [ ] **Step 2: Implement TabItem changes**

In `src/components/TabItem.tsx`:

1. Add the import:
```tsx
import RepoIcon, { type RepoIconInfo } from '@/components/icons/RepoIcon'
```
2. Extend the entry type and props:
```tsx
type TabPaneEntry = {
  paneId: string
  content: PaneContent
  /** cwd hint identifying this pane's repo (coding-agent panes only). */
  repoCwd?: string
}
```
In `TabItemProps` add:
```tsx
  repoIconsOnTabs?: boolean
  repoIcons?: Record<string, RepoIconInfo>
```
In the destructuring add `repoIconsOnTabs = true,` and `repoIcons,`.
3. Replace the body of `renderIcons` (lines ~73-105) with:

```tsx
  const renderIcons = () => {
    if (!iconsOnTabs || !paneEntries || paneEntries.length === 0) {
      return <StatusDot status={tab.status} busy={busy} />
    }

    const visible = paneEntries.slice(0, MAX_TAB_ICONS)
    const overflow = paneEntries.length - MAX_TAB_ICONS
    const hiddenBusyPane = paneEntries
      .slice(MAX_TAB_ICONS)
      .some((entry) => busyPaneIds.includes(entry.paneId))

    // Group visible entries by repo identity (first-appearance order) so each
    // distinct repo icon renders once, immediately left of that repo's agent
    // icons. Entries without repo info keep their position as singleton groups.
    type Group = { key: string; info?: RepoIconInfo; entries: typeof visible }
    const groups: Group[] = []
    const groupIndex = new Map<string, number>()
    for (const entry of visible) {
      const info = repoIconsOnTabs && entry.repoCwd ? repoIcons?.[entry.repoCwd] : undefined
      const key = info ? `repo:${info.repoKey}` : `pane:${entry.paneId}`
      const existing = groupIndex.get(key)
      if (existing !== undefined) {
        groups[existing].entries.push(entry)
        continue
      }
      groupIndex.set(key, groups.length)
      groups.push({ key, info, entries: [entry] })
    }

    return (
      <span className="flex items-center gap-0.5">
        {groups.map((group) => (
          <span key={group.key} className="flex items-center gap-0.5">
            {group.info && <RepoIcon info={group.info} className="h-3 w-3 shrink-0" />}
            {group.entries.map(({ paneId, content }) => {
              const status: TerminalStatus = content.kind === 'terminal' ? content.status : 'running'
              const isBusy = busyPaneIds.includes(paneId)
              return (
                <PaneIcon
                  key={paneId}
                  content={content}
                  className={cn(
                    'h-3 w-3 shrink-0',
                    isBusy ? 'text-blue-500' : getTerminalStatusIconClassName(status),
                  )}
                />
              )
            })}
          </span>
        ))}
        {overflow > 0 && (
          <span className={cn('text-[10px] leading-none', hiddenBusyPane ? 'text-blue-500' : 'text-muted-foreground')}>+{overflow}</span>
        )}
      </span>
    )
  }
```

(The `MAX_TAB_ICONS` overflow behavior is unchanged: the cap applies to pane entries as before; repo icons — at most a couple per tab — render in addition to the visible group.)

- [ ] **Step 3: Run TabItem tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/components/TabItem.test.tsx --config config/vitest/vitest.config.ts`
Expected: PASS (new tests AND all pre-existing tests — the grouped markup keeps pane icons and the `+N` badge intact).

- [ ] **Step 4: Write the failing TabBar test**

In `test/unit/client/components/TabBar.test.tsx`:

1. Add the same `RepoIcon` mock used in TabItem tests (after the PaneIcon mock, ~line 67).
2. Add `repoIcons` and `terminalMeta` reducers to the store factory's `configureStore` reducer map (~lines 144-175):
```ts
import repoIconsReducer from '@/store/repoIconsSlice'
import terminalMetaReducer from '@/store/terminalMetaSlice'
// in the reducer map:
        repoIcons: repoIconsReducer,
        terminalMeta: terminalMetaReducer,
```
3. Mock the api module (top of file, with the other mocks) so the probe thunk never hits the network:
```ts
vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn().mockRejectedValue(new Error('no server in tests')),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}))
```
   (If the file already mocks `@/lib/api`, extend that mock with `get` instead.)
4. Add tests near the existing `iconsOnTabs` describe (~line 1314):

```tsx
    it('renders a repo icon for a coding pane once meta is known', () => {
      const tab = createTab({ id: 'tab-1', title: 'Tab 1', status: 'running' })
      const store = createStore({ tabs: [tab], activeTabId: 'tab-1' })
      store.dispatch({
        type: 'panes/setLayout',
        payload: {
          tabId: 'tab-1',
          layout: {
            type: 'leaf',
            id: 'pane-1',
            content: { kind: 'terminal', mode: 'claude', createRequestId: 'r', status: 'running', initialCwd: '/repo/a' },
          },
        },
      })
      store.dispatch({
        type: 'repoIcons/fetchMeta/fulfilled',
        meta: { arg: '/repo/a' },
        payload: { repoRoot: '/repo/a', checkoutRoot: '/repo/a', repoName: 'a', hasIcon: true },
      })
      renderWithStore(<TabBar />, store)
      expect(screen.getAllByTestId('repo-icon').length).toBeGreaterThanOrEqual(1)
    })

    it('renders no repo icon when panes.repoIconsOnTabs is disabled', () => {
      const tab = createTab({ id: 'tab-1', title: 'Tab 1', status: 'running' })
      const store = createStore({ tabs: [tab], activeTabId: 'tab-1' })
      store.dispatch({
        type: 'panes/setLayout',
        payload: {
          tabId: 'tab-1',
          layout: {
            type: 'leaf',
            id: 'pane-1',
            content: { kind: 'terminal', mode: 'claude', createRequestId: 'r', status: 'running', initialCwd: '/repo/a' },
          },
        },
      })
      store.dispatch({
        type: 'repoIcons/fetchMeta/fulfilled',
        meta: { arg: '/repo/a' },
        payload: { repoRoot: '/repo/a', checkoutRoot: '/repo/a', repoName: 'a', hasIcon: true },
      })
      store.dispatch({
        type: 'settings/updateSettingsLocal',
        payload: { panes: { repoIconsOnTabs: false } },
      })
      renderWithStore(<TabBar />, store)
      expect(screen.queryByTestId('repo-icon')).toBeNull()
    })
```

IMPORTANT: the `panes/setLayout` action shape above is illustrative — copy the exact pane-layout seeding used by the existing TabBar tests (they already seed `panes.layouts` in `preloadedState`; if so, seed `preloadedState.panes.layouts['tab-1']` with the leaf node instead of dispatching, matching the surrounding tests' style verbatim).

Run: `npm run test:vitest -- run test/unit/client/components/TabBar.test.tsx --config config/vitest/vitest.config.ts`
Expected: FAIL — the two new tests fail; existing tests pass.

- [ ] **Step 5: Implement TabBar changes**

In `src/components/TabBar.tsx`:

1. Imports:
```tsx
import { useEffect, useMemo } from 'react' // merge into the existing react import
import { resolvePaneRepoCwd, pathBasename, buildRepoIconUrl } from '@/lib/repo-icon'
import { fetchRepoIconMeta } from '@/store/repoIconsSlice'
import type { RepoIconInfo } from '@/components/icons/RepoIcon'
```
2. Selectors, next to `iconsOnTabs` (~line 177) — module-level frozen empties above the component (PaneContainer's `EMPTY_*` pattern):
```tsx
const EMPTY_REPO_ICONS: Record<string, import('@/store/repoIconsSlice').RepoIconEntry> = {}
const EMPTY_TERMINAL_META: Record<string, import('@/store/terminalMetaSlice').TerminalMetaRecord> = {}
```
```tsx
  const repoIconsOnTabs = useAppSelector((s) => s.settings?.settings?.panes?.repoIconsOnTabs ?? true)
  const repoIconsByCwd = useAppSelector((s) => s.repoIcons?.byCwd ?? EMPTY_REPO_ICONS)
  const terminalMetaById = useAppSelector((s) => s.terminalMeta?.byTerminalId ?? EMPTY_TERMINAL_META)
```
3. Extend `getPaneEntries` (~line 189) to attach `repoCwd` — wrap its existing return values:
```tsx
  const getPaneEntries = useCallback((tab: Tab): Array<{ paneId: string; content: PaneContent; repoCwd?: string }> | undefined => {
    const layout = paneLayouts[tab.id]
    const base = layout
      ? collectPaneEntries(layout)
      : tab.mode
        ? [{
            paneId: tab.id,
            content: {
              kind: 'terminal' as const,
              mode: tab.mode,
              shell: tab.shell,
              createRequestId: tab.createRequestId,
              status: tab.status,
              sessionRef: tab.sessionRef,
              initialCwd: tab.initialCwd,
            },
          }]
        : undefined
    return base?.map((entry) => ({
      ...entry,
      repoCwd: resolvePaneRepoCwd(entry.content, tab, terminalMetaById),
    }))
  }, [paneLayouts, terminalMetaById])
```
4. Probe effect (below the selectors):
```tsx
  useEffect(() => {
    if (!repoIconsOnTabs) return
    const cwds = new Set<string>()
    for (const tab of tabs) {
      const entries = getPaneEntries(tab)
      if (!entries) continue
      for (const entry of entries) {
        if (entry.repoCwd) cwds.add(entry.repoCwd)
      }
    }
    for (const cwd of cwds) {
      if (!repoIconsByCwd[cwd]) void dispatch(fetchRepoIconMeta(cwd))
    }
  }, [tabs, getPaneEntries, repoIconsOnTabs, repoIconsByCwd, dispatch])
```
(`tabs` is the existing tabs array TabBar already selects; use its actual variable name.)
5. Display map:
```tsx
  const repoIconInfoByCwd = useMemo(() => {
    const out: Record<string, RepoIconInfo> = {}
    for (const [cwd, entry] of Object.entries(repoIconsByCwd)) {
      if (entry.status === 'loading') continue
      const repoKey = entry.repoRoot || cwd
      out[cwd] = {
        repoKey,
        repoName: entry.repoName || pathBasename(repoKey),
        iconUrl: entry.hasIcon ? buildRepoIconUrl(cwd) : undefined,
      }
    }
    return out
  }, [repoIconsByCwd])
```
6. Prop threading — mirror `iconsOnTabs` at every site the settings report enumerates:
   - `SortableTabProps` (~line 67): add `repoIconsOnTabs?: boolean` and `repoIcons?: Record<string, RepoIconInfo>` (and `repoCwd?: string` on its `paneEntries` element type, ~line 62).
   - `SortableTab` destructuring (~line 88): add both.
   - `SortableTab` → `TabItem` (~line 128): `repoIconsOnTabs={repoIconsOnTabs} repoIcons={repoIcons}`.
   - `renderSortableTab` → `SortableTab` (~line 297): `repoIconsOnTabs={repoIconsOnTabs} repoIcons={repoIconInfoByCwd}`.
   - `renderSortableTab` dep array (~line 333-347): add `repoIconsOnTabs`, `repoIconInfoByCwd`.
   - Drag-overlay `TabItem` (~line 555): `repoIconsOnTabs={repoIconsOnTabs} repoIcons={repoIconInfoByCwd}`.

- [ ] **Step 6: Run TabBar + TabItem tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/components/TabBar.test.tsx test/unit/client/components/TabItem.test.tsx --config config/vitest/vitest.config.ts`
Expected: PASS, including all pre-existing TabBar suites (also run `TabBar.a11y`, `TabBar.multirow`, `TabBar.overflow`, `TabBar.mobile` siblings if they exist as separate files: `npm run test:vitest -- run test/unit/client/components --config config/vitest/vitest.config.ts`).

- [ ] **Step 7: Lint, typecheck, commit**

```bash
npm run lint
npm run typecheck:client
git add src/components/TabItem.tsx src/components/TabBar.tsx test/unit/client/components/TabItem.test.tsx test/unit/client/components/TabBar.test.tsx
git commit -m "feat(tabs): repo icons on tabs, deduped per repo, left of agent icons"
```

---

### Task 11: PaneHeader parity (repo icon next to the pane icon)

**Files:**
- Modify: `src/components/panes/PaneHeader.tsx`
- Test: `test/unit/client/components/panes/PaneHeader.test.tsx`

**Interfaces:**
- Consumes: `resolvePaneRepoCwd`, `pathBasename`, `buildRepoIconUrl`, `RepoIcon`, `state.repoIcons.byCwd`, `settings.panes.repoIconsOnTabs`.
- Produces: nothing new (leaf UI). PaneHeader does NOT dispatch probes — TabBar already probes every pane's repo; PaneHeader only renders what is cached.

- [ ] **Step 1: Write the failing test**

In `test/unit/client/components/panes/PaneHeader.test.tsx`:
1. Add the `RepoIcon` mock (same shape as TabItem's) next to the existing `PaneIcon` mock.
2. Add `repoIcons`, `settings`, and `terminalMeta` reducers to the test store: extend the existing `configureStore({ reducer: { freshAgent: freshAgentReducer } })` to also include `repoIcons: repoIconsReducer, terminalMeta: terminalMetaReducer` (imports from `@/store/repoIconsSlice` and `@/store/terminalMetaSlice`). Settings can stay absent — the selector defaults to enabled via `?? true`.
3. Add:

```tsx
  it('renders a repo icon next to the pane icon when repo meta is cached', () => {
    const store = createStore() // the file's existing store factory
    store.dispatch({
      type: 'repoIcons/fetchMeta/fulfilled',
      meta: { arg: '/repo/a' },
      payload: { repoRoot: '/repo/a', checkoutRoot: '/repo/a', repoName: 'a', hasIcon: false },
    })
    render(
      <Provider store={store}>
        <PaneHeader
          {...defaultProps}
          content={{ kind: 'terminal', mode: 'claude', createRequestId: 'r', status: 'running', initialCwd: '/repo/a' } as PaneContent}
        />
      </Provider>,
    )
    expect(screen.getByTestId('repo-icon')).toBeTruthy()
    expect(screen.getByTestId('repo-icon').getAttribute('class') || '').toContain('h-3.5 w-3.5')
  })

  it('renders no repo icon for plain shell panes', () => {
    const store = createStore()
    render(
      <Provider store={store}>
        <PaneHeader
          {...defaultProps}
          content={{ kind: 'terminal', mode: 'shell', createRequestId: 'r', status: 'running', initialCwd: '/repo/a' } as PaneContent}
        />
      </Provider>,
    )
    expect(screen.queryByTestId('repo-icon')).toBeNull()
  })
```

(Adapt `createStore`/`defaultProps` names to the file's existing helpers — reuse them verbatim.)

Run: `npm run test:vitest -- run test/unit/client/components/panes/PaneHeader.test.tsx --config config/vitest/vitest.config.ts`
Expected: FAIL — no `repo-icon` testid.

- [ ] **Step 2: Implement**

In `src/components/panes/PaneHeader.tsx`:

1. Imports:
```tsx
import { useAppSelector } from '@/store/hooks'
import RepoIcon, { type RepoIconInfo } from '@/components/icons/RepoIcon'
import { resolvePaneRepoCwd, pathBasename, buildRepoIconUrl } from '@/lib/repo-icon'
import type { RepoIconEntry } from '@/store/repoIconsSlice'
import type { TerminalMetaRecord } from '@/store/terminalMetaSlice'
```
(If PaneHeader has no `useAppSelector` import yet, confirm the hooks path other components use — `@/store/hooks` — and match it.)
2. Module-level empties above the component:
```tsx
const EMPTY_REPO_ICONS: Record<string, RepoIconEntry> = {}
const EMPTY_TERMINAL_META: Record<string, TerminalMetaRecord> = {}
```
3. Inside the component, near the top:
```tsx
  const repoIconsOnTabs = useAppSelector((s) => s.settings?.settings?.panes?.repoIconsOnTabs ?? true)
  const repoIconsByCwd = useAppSelector((s) => s.repoIcons?.byCwd ?? EMPTY_REPO_ICONS)
  const terminalMetaById = useAppSelector((s) => s.terminalMeta?.byTerminalId ?? EMPTY_TERMINAL_META)
  const repoCwd = repoIconsOnTabs ? resolvePaneRepoCwd(content, undefined, terminalMetaById) : undefined
  const repoEntry = repoCwd ? repoIconsByCwd[repoCwd] : undefined
  const repoIconInfo: RepoIconInfo | undefined =
    repoCwd && repoEntry && repoEntry.status !== 'loading'
      ? {
          repoKey: repoEntry.repoRoot || repoCwd,
          repoName: repoEntry.repoName || pathBasename(repoEntry.repoRoot || repoCwd),
          iconUrl: repoEntry.hasIcon ? buildRepoIconUrl(repoCwd) : undefined,
        }
      : undefined
```
4. In the JSX, immediately BEFORE the existing `{!isFreshAgentPane ? (<PaneIcon …/>) : null}` block (~line 110), add:
```tsx
      {!isFreshAgentPane && repoIconInfo ? (
        <RepoIcon info={repoIconInfo} className="h-3.5 w-3.5 shrink-0" />
      ) : null}
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/components/panes/PaneHeader.test.tsx --config config/vitest/vitest.config.ts`
Expected: PASS (new + all pre-existing PaneHeader tests — existing tests render with a store lacking `repoIcons`, which the `?? EMPTY` selectors tolerate).

- [ ] **Step 4: Lint and commit**

```bash
npm run lint
npm run typecheck:client
git add src/components/panes/PaneHeader.tsx test/unit/client/components/panes/PaneHeader.test.tsx
git commit -m "feat(panes): repo icon parity in PaneHeader"
```

---

### Task 12: End-to-end jsdom flow test (real RepoIcon, real store, mocked HTTP)

**Files:**
- Test: `test/e2e/repo-icon-tab-flow.test.tsx` (this suite runs inside `npm test` — the default vitest config includes `test/e2e/**`)

**Interfaces:**
- Consumes: everything from Tasks 7–10 assembled: real `TabBar` + real `repoIconsSlice` + real `RepoIcon` (NOT mocked), with `@/lib/api` mocked at the HTTP boundary. This is the user-story proof: "a tab whose pane works in repo X shows repo X's icon (or its letter avatar) next to the agent icon."

- [ ] **Step 1: Write the flow test (it should pass immediately if Tasks 7–10 are correct; if it fails, that is a real integration bug to fix, not a test to adjust)**

Create `test/e2e/repo-icon-tab-flow.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import TabBar from '@/components/TabBar'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import repoIconsReducer from '@/store/repoIconsSlice'
import terminalMetaReducer from '@/store/terminalMetaSlice'
import codexActivityReducer from '@/store/codexActivitySlice'
import opencodeActivityReducer from '@/store/opencodeActivitySlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({ state: 'ready', send: vi.fn() }),
}))

const apiGet = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}))

// NOTE: PaneIcon and lucide-react are NOT mocked here on purpose — this is the
// integration proof. If lucide imports crash jsdom in this suite, mirror the
// exhaustive lucide mock from TabBar.test.tsx, but keep RepoIcon REAL.

function makeStore() {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      repoIcons: repoIconsReducer,
      terminalMeta: terminalMetaReducer,
      codexActivity: codexActivityReducer,
      opencodeActivity: opencodeActivityReducer,
      turnCompletion: turnCompletionReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [
          {
            id: 'tab-1',
            title: 'Agent Tab',
            mode: 'claude',
            status: 'running',
            createRequestId: 'req-1',
            createdAt: 1,
            initialCwd: '/home/u/myrepo',
          },
        ],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
      },
      panes: {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'claude',
              createRequestId: 'req-1',
              status: 'running',
              initialCwd: '/home/u/myrepo',
            },
          },
        },
        activePane: {},
        paneTitles: {},
      },
    } as any,
  })
}

describe('repo icon tab flow', () => {
  beforeEach(() => {
    apiGet.mockReset()
  })

  it('probes the meta endpoint and renders the server icon image on the tab', async () => {
    apiGet.mockResolvedValue({
      repoRoot: '/home/u/myrepo',
      checkoutRoot: '/home/u/myrepo',
      repoName: 'myrepo',
      hasIcon: true,
    })
    render(
      <Provider store={makeStore()}>
        <TabBar />
      </Provider>,
    )
    await waitFor(() => {
      const img = document.querySelector('img[src^="/api/repo-icon?cwd="]')
      expect(img).toBeTruthy()
    })
    expect(apiGet).toHaveBeenCalledWith(
      `/api/repo-icon/meta?cwd=${encodeURIComponent('/home/u/myrepo')}`,
    )
    expect(apiGet).toHaveBeenCalledTimes(1) // once per distinct repo, remembered in Redux
  })

  it('falls back to the letter avatar when the endpoint is absent (Node dev server)', async () => {
    apiGet.mockRejectedValue(new Error('404 Not Found'))
    render(
      <Provider store={makeStore()}>
        <TabBar />
      </Provider>,
    )
    await waitFor(() => {
      expect(screen.getByText('M')).toBeTruthy() // 'myrepo' -> 'M'
    })
    expect(document.querySelector('img[src^="/api/repo-icon"]')).toBeNull()
  })
})
```

Adapt the `preloadedState` shapes to the real slice initial-state fields if TypeScript complains (compare with `TabBar.test.tsx`'s store factory and reuse its exact `tabs`/`panes` shapes; the `as any` is acceptable in the test to keep the seed minimal).

- [ ] **Step 2: Run it**

Run: `npm run test:vitest -- run test/e2e/repo-icon-tab-flow.test.tsx --config config/vitest/vitest.config.ts`
Expected: PASS (2 tests). If it fails, debug the integration (probe effect, selector defaults, URL building) — do not weaken the assertions.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/repo-icon-tab-flow.test.tsx
git commit -m "test(e2e): repo icon tab flow — server icon and letter-avatar fallback"
```

---

### Task 13: Full verification gates + scratch-server smoke

**Files:**
- No new files (verification only; fix regressions if any gate fails).

**Interfaces:**
- Consumes: everything above.
- Produces: a green branch ready for review.

- [ ] **Step 1: Full client gates**

```bash
npm run lint
npm run typecheck:client
npm run test:vitest -- run test/unit/client test/unit/shared test/e2e/repo-icon-tab-flow.test.tsx --config config/vitest/vitest.config.ts
```
Expected: lint clean (jsx-a11y), typecheck clean, all tests pass. Fix any regression before proceeding (in particular: any new lucide import in touched components must be added to the exhaustive `vi.mock('lucide-react', …)` blocks in `TabItem.test.tsx` / `TabBar.test.tsx` / `PaneHeader.test.tsx` — this plan introduces no new lucide imports, so none should be needed).

- [ ] **Step 2: Full Rust gates (mirrors CI)**

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p freshell-server
```
Expected: all clean/pass.

- [ ] **Step 3: Scratch-port live smoke of the Rust endpoint**

⚠️ NEVER touch port 3002 (the live server — restart requires the user's explicit "APPROVED"). This smoke uses a scratch port from the worktree, whose pid/log files (`~/.freshell/rust-server-3499.pid`) are separate from 3002's.

```bash
cd /home/dan/code/freshell/.worktrees/repo-icons-on-tabs
scripts/launch-rust.sh --port 3499
# The script prints http://localhost:3499/?token=<AUTH_TOKEN>. Then:
TOKEN=$(grep -oP '^AUTH_TOKEN=\K.*' .env)
curl -s -H "x-auth-token: $TOKEN" \
  "http://127.0.0.1:3499/api/repo-icon/meta?cwd=$(python3 -c 'import urllib.parse;print(urllib.parse.quote("/home/dan/code/freshell"))')"
# Expected: {"checkoutRoot":"/home/dan/code/freshell","hasIcon":true|false,"repoName":"freshell","repoRoot":"/home/dan/code/freshell"}
curl -s -o /dev/null -w '%{http_code}\n' \
  "http://127.0.0.1:3499/api/repo-icon/meta?cwd=%2Fhome%2Fdan%2Fcode%2Ffreshell"
# Expected: 401 (no auth)
scripts/launch-rust.sh --port 3499 --stop
```
Expected: authenticated meta returns the JSON shape above with `repoName: "freshell"`; unauthenticated returns 401; the scratch server stops cleanly. (`hasIcon` may be true or false depending on freshell's own files — either is a valid smoke result; the JSON shape and repoName are the assertions.) If `launch-rust.sh` requires `AUTH_TOKEN` and `.env` lacks it in the worktree, run with `AUTH_TOKEN=smoketest scripts/launch-rust.sh --port 3499 --skip-build` after a manual `npm run build:client && cargo build --release -p freshell-server`, and use `x-auth-token: smoketest`.

- [ ] **Step 4: Final commit (if the smoke/gates required fixes)**

```bash
git status --short   # expect only intentional changes
git add -A && git commit -m "chore: verification fixes for repo icons on tabs"  # only if there are changes
```

---

## Self-Review (completed by the plan author)

**1. Spec coverage:**
- Repo icon left of agent icon, h-3 w-3, spaced → Task 10 (grouped render, `gap-0.5`, sizing test).
- Coding-agent panes only; shells out of scope → `resolvePaneRepoCwd` (Task 8) + tests (Task 8, 10, 11).
- Letter avatar fallback (uppercase first letter, circle, deterministic hue, client-rendered) → Task 8 + flow test (Task 12).
- Setting default ON following `iconsOnTabs` pattern (declaration + default + patch handling + UI + TabBar consumption) → Task 7 + Task 10.
- No per-repo override mechanism → none added anywhere.
- Rust-only server implementation; Node untouched; graceful client degradation on Node (rejected probe → avatar) → Tasks 1–6 (Rust only), Task 9 rejected-case, Task 12 fallback test.
- Detection heuristic v1 (tiers 1/2/3, all listed paths, score modifiers, rejections, blacklist table + seeds, PNG/ICO header probing, SVG best-effort dims, deterministic tiebreak, bounded scan) → Tasks 2–5. The "path contains" rejection is implemented as path-component equality (strictly safer; documented in Task 3).
- Serving & security (auth, repo-root resolution reusing/paralleling server git logic — none existed in Rust, so Task 1 ports the Node reference; canonicalize both sides; candidate inside root; `is_path_allowed` sandbox enforced three times — raw cwd, canonical cwd (symlink escape), canonical repo root (upward-walk escape) — each with a dedicated Forbidden test in Task 6; SVG headers + DOCTYPE/ENTITY rejection; `<img src>`-only rendering; Cache-Control + ETag/304; in-process HashMap cache with stat-based invalidation; cheap probe endpoint remembered in Redux) → Tasks 6, 8, 9.
- Client repo identity: promoted a shared pure resolver (`resolvePaneRepoCwd` in `src/lib/repo-icon.ts`) instead of moving `resolvePaneRuntimeMeta` wholesale — verified reality first: the Rust server emits identity-only terminalMeta (cwd, no repoRoot) and an empty inventory snapshot, so the resolver prefers terminalMeta when present (Node) and falls back to pane/tab `initialCwd` (works on Rust); the endpoint accepts a cwd and resolves the root server-side, exactly as the spec's contingency prescribes. `PaneContainer.resolvePaneRuntimeMeta` is left untouched (it serves a different, richer purpose; duplicating its ladder for icons would violate YAGNI).
- Dedupe per repo on a tab; overflow respected → Task 10 (grouping algorithm + tests; `MAX_TAB_ICONS` behavior unchanged and covered by existing overflow tests).
- PaneHeader parity (nice-to-have) → Task 11.
- Worktree avatar naming from repoRoot basename → server meta returns repoRoot-derived `repoName` (Task 6 worktree test); client prefers it (Tasks 9–10).
- Redux availability cache (no re-probe per render) → Task 9 (`condition` + flow-test single-call assertion).
- Protocol/port: no TerminalMeta/WS changes anywhere → no `freshell-protocol` / `port/contract` updates needed (explicitly verified: the design is pure HTTP keyed by cwd).
- Repo rules: TDD everywhere; unit + e2e (jsdom flow suite under `test/e2e/` runs in `npm test`; Rust HTTP integration via oneshot; live scratch-server smoke in Task 13 — Playwright browser e2e is not in CI and is intentionally not added); worktree usage; lint gate; no 3002 restart; no deploy; `docs/index.html` judged not required (stated in Global Constraints).

**1b. No silent deferrals:** No stubs/mocks stand in for production behavior. HTTP mocking appears only in client unit/flow tests, with the real Rust endpoint proven by `cargo test` integration tests (Task 6) AND a real-server smoke against a scratch port (Task 13 Step 3). The blacklist seed digests are pre-verified constants (validated 2026-07-28 against pinned upstream refs and real scaffolded repos) and the test fixture is sourced offline from an in-repo scaffold copy — no network dependency and no degraded path needed. The commented Next.js blacklist row is an explicit optional extension (spec permits "add others as practical"), with exact instructions, not a deferral of required behavior. No known-limitations section exists and no requirement was moved to future work.

**2. Placeholder scan:** No digest placeholders remain — Task 2's six sha256 rows are complete pre-verified hex values, gated by Step 1's fixture-hash check (`sha256sum testdata/vite.svg` must print the `vite-default-logo` digest). The only intentional fill-ins are (a) Task 6 Step 5's two state-field initializers — copied verbatim from the adjacent `files_state` literal, named precisely; (b) small "reuse the file's existing helper verbatim" notes where the helper already exists in the test file being edited. All code steps carry complete code.

**3. Load-bearing validation (Stage 2, 2026-07-28):** 8 load-bearing assumptions surfaced and validated (ledger: `.worktrees/.the-usual-logs/repo-icons-on-tabs/load-bearing-ledger.md`). Verified: cwd-hint availability across all create/restore/resume paths (A3), detector real-repo safety — 0/82 wrong picks (A4), existing TabItem/TabBar suites tolerate the grouped markup (A5), Task 12's minimal store is viable with a passing smaller-store precedent (A6), the default-ON probe is harmless to the existing test corpus (A8). Falsified and fixed in this plan: stale blacklist seed URLs/digests (A1/A2 → Task 2 rewritten with pre-verified digests + offline fixture), and the allowlist sandbox gap on the upward-walking endpoint (A7 → Task 6 triple allowlist enforcement + two new Forbidden tests).

**3. Type consistency:** `RepoIconInfo { repoKey, repoName, iconUrl? }` defined in Task 8, consumed with those exact fields in Tasks 10–12. `RepoIconEntry { status, repoRoot?, checkoutRoot?, repoName?, hasIcon? }` defined in Task 9, consumed in Tasks 10–11. Rust: `RepoInfo { checkout_root, repo_root }` (Task 1) consumed in Task 6; `Candidate { path, tier_base, order, extra }` (Task 3) consumed in Tasks 4–5; `detect_icon(&Path) -> Option<PathBuf>` (Task 5) consumed in Task 6. Endpoint JSON is camelCase (`repoRoot`, `checkoutRoot`, `repoName`, `hasIcon`) in both the Rust `json!` literal and the TS `RepoIconMetaResponse`. `panes.repoIconsOnTabs` is spelled identically across all 8 registration points and every selector.
