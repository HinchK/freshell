//! Device-directory retention: the device-count cap and its eviction policy.
//!
//! Split out of `tabs_persist.rs` (which sits at the repo's 1,000-line file
//! limit) following the `tabs_persist_validation.rs` precedent. Included from
//! `tabs_persist.rs` via `#[path]`, so `super::*` is the `tabs_persist`
//! module and this child can use its private items.

use super::*;

/// The honest result of one persistence attempt. `tabs.sync.push` surfaces
/// non-persistence on the ack (`persisted:false` + reason) instead of
/// silently ACKing (campaign fail-loud principle, P2.17 defect 2).
#[must_use]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PersistOutcome {
    /// The generation was durably written.
    Persisted,
    /// Deliberately not written (policy: oversize or malformed identifiers).
    Skipped { reason: &'static str },
    /// The write was attempted and failed (io error / cap unenforceable).
    Failed { reason: String },
}

/// One device dir's health for eviction scoring.
struct DeviceDirHealth {
    /// Max `capturedAt` over cleanly-parseable files (`i64::MIN` when the dir
    /// holds no parseable generation at all, e.g. an empty dir).
    newest: i64,
    /// Files (or the dir listing itself) that failed to read, parse, or carry
    /// an i64 `capturedAt`.
    unreadable: usize,
    path: PathBuf,
}

fn scan_device_dir(path: PathBuf) -> DeviceDirHealth {
    let mut newest = i64::MIN;
    let mut unreadable = 0usize;
    match std::fs::read_dir(&path) {
        // An unlistable dir is unreadable evidence, not an empty dir.
        Err(_) => unreadable += 1,
        Ok(entries) => {
            for f in entries.flatten().map(|e| e.path()) {
                if f.extension().is_none_or(|x| x != "json") {
                    continue;
                }
                let captured = std::fs::read_to_string(&f)
                    .ok()
                    .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                    .and_then(|v| v.get("capturedAt").and_then(Value::as_i64));
                match captured {
                    Some(c) => newest = newest.max(c),
                    None => unreadable += 1,
                }
            }
        }
    }
    DeviceDirHealth {
        newest,
        unreadable,
        path,
    }
}

/// Enforce MAX_SNAPSHOT_DEVICES before a write. New targets reserve one slot;
/// existing targets also repair a previously over-cap root. Lease-protected
/// restores, the write target, and — fail-loud, campaign P2.17 defect 1 —
/// any dir holding unreadable generation files are never candidates: corrupt
/// dirs are forensic evidence, not the cheapest victim. If no cleanly
/// parseable victim remains, fail the incoming write with `WouldBlock`
/// rather than destroying evidence or creating another directory.
pub(super) fn enforce_device_cap(root: &Path, target_dir: &Path) -> std::io::Result<()> {
    let target_exists = target_dir.exists();
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err),
    };
    let dirs: Vec<DeviceDirHealth> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .map(scan_device_dir)
        .collect();
    let mut device_count = dirs.len();
    let allowed_before_write = if target_exists {
        MAX_SNAPSHOT_DEVICES
    } else {
        MAX_SNAPSHOT_DEVICES.saturating_sub(1)
    };
    if device_count <= allowed_before_write {
        return Ok(());
    }
    // Under eviction pressure only: classify candidates. Corrupt dirs are
    // exempt AND loud (bounded: this only logs while over-cap).
    let mut corrupt_exempt = 0usize;
    let mut candidates: Vec<(i64, PathBuf)> = Vec::new();
    for d in dirs {
        if d.path == *target_dir || restore_protects(&d.path) {
            continue;
        }
        if d.unreadable > 0 {
            corrupt_exempt += 1;
            tracing::error!(target: "freshell_ws::invariants",
                path = %d.path.display(), unreadable = d.unreadable,
                "tabs_snapshot_corrupt_dir_exempt_from_eviction: device dir holds unreadable generation files; exempting it from cap eviction to preserve forensic evidence");
            continue;
        }
        candidates.push((d.newest, d.path));
    }
    candidates.sort_by_key(|(c, _)| *c);
    let mut candidates = candidates.into_iter();
    while device_count > allowed_before_write {
        let Some((_, victim)) = candidates.next() else {
            tracing::error!(target: "freshell_ws::invariants",
                root = %root.display(), corrupt_exempt,
                "tabs_snapshot_device_cap_unenforceable: no cleanly-parseable eviction candidate remains; failing the incoming write instead of destroying evidence");
            return Err(std::io::Error::new(
                std::io::ErrorKind::WouldBlock,
                "snapshot device cap is exhausted: remaining candidates are protected by active restores or hold unreadable (corrupt) generations; refusing to evict",
            ));
        };
        tracing::warn!(target: "freshell_ws::tabs", path = %victim.display(),
            "tabs_snapshot_device_evicted: device cap reached; evicting the least-recently-written clean device dir");
        remove_dir_all_logged(&victim)?;
        device_count -= 1;
    }
    Ok(())
}
