//! Repo icon detection: bounded, tiered candidate scan with scoring.
//! Part 1 (this section): byte probes, hashing, framework-defaults blacklist.

// TEMPORARY (removed in Task 6 Step 7): until Task 6 wires `detect_icon`
// into the HTTP layer, the non-test build sees everything here as dead code
// and the per-task `clippy -D warnings` gates (Tasks 2-5) would fail without this.
#![allow(dead_code)]

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
