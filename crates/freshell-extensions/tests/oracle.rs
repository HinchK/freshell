//! Differential oracle conformance test (df1 EXT-01).
//!
//! Iterates `fixtures/manifest-oracle.json` — generated from the UNMODIFIED
//! legacy zod-4.3.6 schema by `port/contract/generate-manifest-oracle.ts` —
//! and asserts, for every case:
//!   * same verdict class (valid / invalid-manifest / invalid-JSON-text)
//!   * on success: the typed manifest re-serializes to EXACTLY zod's output
//!     value (defaults materialized; order-insensitive map equality, vector
//!     order strict)
//!   * on schema failure: the flattened (code, path, message) issue list
//!     matches byte-for-byte IN ORDER
//!
//! NEVER patch this test's expectations or the fixture to match the crate.
//! The legacy schema is the oracle; fix the crate (or regenerate the fixture
//! from the legacy schema after a deliberate legacy change / zod bump).

use freshell_extensions::{parse_manifest, ManifestError};

const FIXTURE: &str = include_str!("../fixtures/manifest-oracle.json");

#[test]
fn oracle_conformance() {
    let fixture: serde_json::Value = serde_json::from_str(FIXTURE).expect("oracle fixture parses");
    let meta = &fixture["meta"];
    assert_eq!(
        meta["schemaSource"].as_str().unwrap(),
        "server/extension-manifest.ts (UNMODIFIED legacy zod schema)"
    );
    assert!(
        meta["zodVersion"].as_str().unwrap().starts_with("4."),
        "fixture pinned to zod 4.x, got {}",
        meta["zodVersion"]
    );

    let cases = fixture["cases"].as_array().expect("cases array");
    assert!(
        cases.len() >= 100,
        "fixture should carry >=100 cases (truncation guard), got {}",
        cases.len()
    );

    let mut names = std::collections::HashSet::new();
    let mut valid = 0usize;
    let mut invalid = 0usize;
    let mut parse_error = 0usize;

    for case in cases {
        let name = case["name"].as_str().expect("case name");
        assert!(names.insert(name.to_string()), "duplicate case name {name}");
        let raw_text = case["rawText"].as_str().expect("rawText");
        let expected = &case["expected"];

        let result = parse_manifest(raw_text);

        if expected["parseError"].as_bool().unwrap_or(false) {
            parse_error += 1;
            match &result {
                Err(ManifestError::InvalidJson(_)) => {}
                Err(ManifestError::Invalid(issues)) => {
                    panic!("case {name}: expected InvalidJson class, got issues {issues:?}")
                }
                Ok(m) => panic!("case {name}: expected InvalidJson class, got valid {m:?}"),
            }
            continue;
        }

        if expected["success"].as_bool().unwrap() {
            valid += 1;
            match result {
                Ok(manifest) => {
                    let got = manifest.to_zod_output_value();
                    let want = &expected["data"];
                    assert_eq!(
                        got,
                        *want,
                        "case {name}: zod-output mismatch.\n got: {}\nwant: {}",
                        serde_json::to_string_pretty(&got).unwrap(),
                        serde_json::to_string_pretty(want).unwrap()
                    );
                }
                Err(e) => panic!("case {name}: expected VALID, got {e}"),
            }
        } else {
            invalid += 1;
            match result {
                Err(ManifestError::Invalid(issues)) => {
                    let got = serde_json::to_value(&issues).unwrap();
                    let want = &expected["issues"];
                    assert_eq!(
                        got,
                        *want,
                        "case {name}: issue-list mismatch.\n got: {}\nwant: {}",
                        serde_json::to_string_pretty(&got).unwrap(),
                        serde_json::to_string_pretty(want).unwrap()
                    );
                }
                Err(ManifestError::InvalidJson(e)) => {
                    panic!("case {name}: expected schema-invalid, got JSON error: {e}")
                }
                Ok(m) => panic!("case {name}: expected schema-invalid, got valid {m:?}"),
            }
        }
    }

    // Sanity spread so a degenerate fixture can't pass vacuously.
    assert!(valid >= 35, "expected plenty of valid cases, got {valid}");
    assert!(
        invalid >= 60,
        "expected plenty of invalid cases, got {invalid}"
    );
    assert!(parse_error >= 1, "expected at least one parse-error case");
    eprintln!("oracle conformance: {valid} valid / {invalid} invalid / {parse_error} parse-error cases ALL MATCH");
}
