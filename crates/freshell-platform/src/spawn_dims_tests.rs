//! Node-parity tests for spawn geometry defaulting.
//!
//! Reference: `terminal-registry.ts:1572-1573` — `const cols = opts.cols || 120`,
//! `const rows = opts.rows || 30`. `||` is a falsy-coalesce, not a clamp: `0`
//! (the only falsy `u16`) falls back to the default; every non-zero value —
//! including values below the resize floor — passes through unchanged.

use super::{dim_or_default, DEFAULT_COLS, DEFAULT_ROWS};

#[test]
fn none_falls_back_to_default() {
    assert_eq!(dim_or_default(None, DEFAULT_COLS), 120);
    assert_eq!(dim_or_default(None, DEFAULT_ROWS), 30);
}

#[test]
fn zero_is_falsy_and_falls_back_to_default() {
    // Node: `0 || 120` → 120. The old Rust `unwrap_or` produced 0 here.
    assert_eq!(dim_or_default(Some(0), DEFAULT_COLS), 120);
    assert_eq!(dim_or_default(Some(0), DEFAULT_ROWS), 30);
}

#[test]
fn one_passes_through_because_spawn_has_no_floor() {
    // Node: `1 || 120` → 1 (truthy). Spawn is falsy-coalesce only, never a clamp.
    assert_eq!(dim_or_default(Some(1), DEFAULT_COLS), 1);
    assert_eq!(dim_or_default(Some(1), DEFAULT_ROWS), 1);
}

#[test]
fn normal_values_pass_through() {
    assert_eq!(dim_or_default(Some(95), DEFAULT_COLS), 95);
    assert_eq!(dim_or_default(Some(41), DEFAULT_ROWS), 41);
}
