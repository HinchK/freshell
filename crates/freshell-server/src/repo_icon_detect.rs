//! Repo icon detection: bounded, tiered candidate scan with scoring.
//! Part 1 (this section): byte probes, hashing, framework-defaults blacklist.

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
        let w = if bytes[off] == 0 {
            256
        } else {
            bytes[off] as u32
        };
        let h = if bytes[off + 1] == 0 {
            256
        } else {
            bytes[off + 1] as u32
        };
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
        r#"(?i)viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([.\d]+)[\s,]+([.\d]+)"#,
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
    (
        "4a748afd443918bb16591c834c401dae33e87861ab5dbad0811c3a3b4a9214fb",
        "vite-default-logo",
    ),
    // new Vite logo after the Jan 2026 rebrand; scaffolds ship it as public/favicon.svg
    (
        "61bc9a161de58248288e6905425d7180f0624c2865007b97d763fdac12043a66",
        "vite-default-logo-2026",
    ),
    // CRA >= 3.3 (cra-template era, frozen upstream since 2019; repo archived)
    (
        "c386396ec70db3608075b5fbfaac4ab1ccaa86ba05a68ab393ec551eb66c3e00",
        "cra-logo192",
    ),
    (
        "9ea4f4da7050c0cc408926f6a39c253624e9babb1d43c7977cd821445a60b461",
        "cra-logo512",
    ),
    // CRA 3.0-3.2 (react-scripts template era) shipped different bytes
    (
        "15d08b02d78823c12616b72d1b5adb0520940016b89bae1f758e6f1a105597ff",
        "cra-logo192-legacy",
    ),
    (
        "6c9a88867fefa2489b91fb85dab7cbec88f1022193ede7320da0ac3c45429519",
        "cra-logo512-legacy",
    ),
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

use std::path::{Path, PathBuf};

pub(crate) const TIER1: i64 = 100;
pub(crate) const TIER2: i64 = 80;
pub(crate) const TIER3: i64 = 60;

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SVG_BYTES: u64 = 256 * 1024;
const REJECTED_PATH_COMPONENTS: &[&str] = &[
    "node_modules",
    "vendor",
    "third_party",
    "test",
    "tests",
    "fixtures",
    "example",
    "template",
    "dist",
    "out",
    "coverage",
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
    let is_raster = matches!(
        ext.as_str(),
        "png" | "ico" | "jpg" | "jpeg" | "gif" | "webp"
    );
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

pub(crate) struct CandidateSink {
    pub repo_root: PathBuf,
    pub out: Vec<Candidate>,
    next_order: u32,
}

impl CandidateSink {
    pub(crate) fn new(repo_root: PathBuf) -> Self {
        Self {
            repo_root,
            out: Vec::new(),
            next_order: 0,
        }
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
            self.out.push(Candidate {
                path,
                tier_base,
                order,
                extra,
            });
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
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let cleaned = if name.ends_with(".json5") {
            strip_json5(&raw)
        } else {
            raw
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&cleaned) else {
            continue;
        };
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
        let dir = if base.is_empty() {
            root.clone()
        } else {
            root.join(base)
        };
        for name in ["manifest.json", "site.webmanifest", "manifest.webmanifest"] {
            let Some(v) = read_json(&dir.join(name)) else {
                continue;
            };
            // Icons must be an ARRAY (distinguishes web manifests from
            // browser-extension manifests, whose icons is an object).
            let Some(icons) = v.get("icons").and_then(|i| i.as_array()) else {
                continue;
            };
            let mut best: Option<(i64, String)> = None; // (rank, src)
            for icon in icons {
                let Some(src) = icon.get("src").and_then(|s| s.as_str()) else {
                    continue;
                };
                let purpose = icon
                    .get("purpose")
                    .and_then(|p| p.as_str())
                    .unwrap_or("any");
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
    let Ok(link_re) = regex::Regex::new(r"(?is)<link\b[^>]*>") else {
        return;
    };
    let Ok(rel_re) = regex::Regex::new(r#"(?i)\brel\s*=\s*[\"']([^\"']+)[\"']"#) else {
        return;
    };
    let Ok(href_re) = regex::Regex::new(r#"(?i)\bhref\s*=\s*[\"']([^\"']+)[\"']"#) else {
        return;
    };
    let Ok(sizes_re) = regex::Regex::new(r#"(?i)\bsizes\s*=\s*[\"'](\d+)"#) else {
        return;
    };
    for base in ["", "public", "src"] {
        let dir = if base.is_empty() {
            root.clone()
        } else {
            root.join(base)
        };
        let Ok(raw) = std::fs::read_to_string(dir.join("index.html")) else {
            continue;
        };
        let head = raw.get(..raw.len().min(64 * 1024)).unwrap_or(&raw);
        let mut found: Vec<(i64, String)> = Vec::new(); // (rank, href)
        for tag in link_re.find_iter(head) {
            let tag = tag.as_str();
            let Some(rel) = rel_re.captures(tag).map(|c| c[1].to_lowercase()) else {
                continue;
            };
            if !["icon", "shortcut icon", "apple-touch-icon"].contains(&rel.as_str()) {
                continue;
            }
            let Some(href) = href_re.captures(tag).map(|c| c[1].to_string()) else {
                continue;
            };
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
        found.sort_by_key(|b| std::cmp::Reverse(b.0));
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

fn tier2(sink: &mut CandidateSink) {
    let root = sink.repo_root.clone();
    const FIXED: &[&str] = &[
        "app/icon.svg",
        "app/icon.png",
        "app/icon.ico",
        "src/app/icon.svg",
        "src/app/icon.png",
        "src/app/icon.ico",
        "app/favicon.ico",
        "src/app/favicon.ico",
        "app/apple-icon.png",
        "public/favicon.svg",
        "public/favicon.ico",
        "public/favicon.png",
        "static/favicon.svg",
        "static/favicon.ico",
        "static/favicon.png",
        "public/apple-touch-icon.png",
        "public/icon-192.png",
        "public/logo192.png",
        "favicon.ico",
        "src-tauri/icons/128x128.png",
        "src-tauri/icons/icon.png",
        "build/icon.png",
        "build/icon.ico",
        "build/appicon.png",
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
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
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
        "assets",
        "static",
        "public",
        "resources",
        "media",
        "images",
        "img",
        "branding",
        "docs",
        "doc",
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
        assert!(svg_is_dangerous(
            "<!ENTITY xxe SYSTEM \"file:///etc/passwd\">"
        ));
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
        assert_eq!(
            score_candidate(&root, &cand(&root, "small.png", TIER3, 0)),
            None
        );
        write_png(&root.join("node_modules/pkg/icon.png"), 128, 128);
        assert_eq!(
            score_candidate(&root, &cand(&root, "node_modules/pkg/icon.png", TIER3, 0)),
            None
        );
        fs::write(root.join("icon.icns"), b"whatever").unwrap();
        assert_eq!(
            score_candidate(&root, &cand(&root, "icon.icns", TIER3, 0)),
            None
        );
        // outside the repo root -> rejected
        let outside = tmp.path().join("elsewhere.png");
        write_png(&outside, 128, 128);
        let c = Candidate {
            path: outside,
            tier_base: TIER3,
            order: 0,
            extra: 0,
        };
        assert_eq!(score_candidate(&root.join("sub"), &c), None);
    }

    #[test]
    fn oversized_files_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        fs::write(root.join("big.svg"), vec![b'a'; 300 * 1024]).unwrap(); // svg > 256KB
        assert_eq!(
            score_candidate(&root, &cand(&root, "big.svg", TIER3, 0)),
            None
        );
    }

    #[test]
    fn dangerous_svg_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        fs::write(root.join("evil.svg"), "<!DOCTYPE svg><svg/>").unwrap();
        assert_eq!(
            score_candidate(&root, &cand(&root, "evil.svg", TIER3, 0)),
            None
        );
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
        fs::write(
            root.join("public/favicon.svg"),
            "<svg viewBox=\"0 0 16 16\"/>",
        )
        .unwrap();
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
        fs::write(
            root.join("public/favicon.svg"),
            "<svg viewBox=\"0 0 16 16\"/>",
        )
        .unwrap();
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
