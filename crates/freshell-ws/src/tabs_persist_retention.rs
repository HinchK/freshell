//! Device-directory retention: the device-count cap and its eviction policy.
//!
//! Split out of `tabs_persist.rs` (which sits at the repo's 1,000-line file
//! limit) following the `tabs_persist_validation.rs` precedent. Included from
//! `tabs_persist.rs` via `#[path]`, so `super::*` is the `tabs_persist`
//! module and this child can use its private items.

use super::*;

/// Enforce MAX_SNAPSHOT_DEVICES before a write. New targets reserve one slot;
/// existing targets also repair a previously over-cap root. Lease-protected
/// restores and the write target are never candidates. If no eligible victim
/// remains, fail with `WouldBlock` rather than creating another directory.
pub(super) fn enforce_device_cap(root: &Path, target_dir: &Path) -> std::io::Result<()> {
    let target_exists = target_dir.exists();
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err),
    };
    let mut dirs: Vec<(i64, PathBuf)> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .map(|p| {
            let newest = std::fs::read_dir(&p)
                .into_iter()
                .flatten()
                .flatten()
                .map(|f| f.path())
                .filter(|f| f.extension().is_some_and(|x| x == "json"))
                .filter_map(|f| {
                    serde_json::from_str::<Value>(&std::fs::read_to_string(&f).ok()?)
                        .ok()?
                        .get("capturedAt")
                        .and_then(Value::as_i64)
                })
                .max()
                .unwrap_or(0);
            (newest, p)
        })
        .collect();
    let mut device_count = dirs.len();
    let allowed_before_write = if target_exists {
        MAX_SNAPSHOT_DEVICES
    } else {
        MAX_SNAPSHOT_DEVICES.saturating_sub(1)
    };
    dirs.retain(|(_, path)| path != target_dir && !restore_protects(path));
    while device_count > allowed_before_write {
        if dirs.is_empty() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::WouldBlock,
                "snapshot device cap is exhausted: all eviction candidates are protected by active restores; retry the tabs-sync push",
            ));
        }
        dirs.sort_by_key(|(c, _)| *c);
        let (_, victim) = dirs.remove(0);
        remove_dir_all_logged(&victim)?;
        device_count -= 1;
    }
    Ok(())
}
