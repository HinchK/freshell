//! Fail-closed snapshot selection parsing for the tabs-sync REST surface
//! (`tabs_snapshots.rs`). Split into its own `#[path]`-included module to keep
//! the handler file under the repo's 1,000-line-per-file limit.
//! [`parse_selector`] validates the GET read endpoints' query params.

// The Err variant is a ready-to-send axum `Response` (the same pattern every
// handler in `tabs_snapshots.rs` uses); its size is irrelevant on this
// low-frequency, operator-driven path.
#![allow(clippy::result_large_err)]

use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use serde_json::json;

/// The parsed generation selector, or a 400 response. FAIL-CLOSED (`:1101`): an
/// invalid, negative, duplicated, or conflicting selector is a 400, never a
/// silent fall-through to the (broader) coherent union.
pub(super) enum Selector {
    Union,
    Index(usize),
    Id(String),
}

pub(super) fn parse_selector(params: &[(String, String)]) -> Result<Selector, Response> {
    let gens: Vec<&String> = params
        .iter()
        .filter(|(k, _)| k == "generation")
        .map(|(_, v)| v)
        .collect();
    let ids: Vec<&String> = params
        .iter()
        .filter(|(k, _)| k == "generationId")
        .map(|(_, v)| v)
        .collect();
    let bad = |msg: &str| (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response();
    if gens.len() > 1 {
        return Err(bad("duplicate `generation` selector"));
    }
    if ids.len() > 1 {
        return Err(bad("duplicate `generationId` selector"));
    }
    if !gens.is_empty() && !ids.is_empty() {
        return Err(bad("provide `generation` OR `generationId`, not both"));
    }
    if let Some(v) = gens.first() {
        // usize::from_str rejects negatives, non-numerics, and empty -> 400.
        return v
            .parse::<usize>()
            .map(Selector::Index)
            .map_err(|_| bad("`generation` must be a non-negative integer"));
    }
    if let Some(v) = ids.first() {
        if v.is_empty() {
            return Err(bad("`generationId` must be non-empty"));
        }
        return Ok(Selector::Id((*v).clone()));
    }
    Ok(Selector::Union)
}
