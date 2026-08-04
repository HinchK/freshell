use sha2::{Digest, Sha256};
use std::fs;
use std::io;
use std::path::PathBuf;
use std::process;
use std::time::{SystemTime, UNIX_EPOCH};

/// Instance-scoped managed-remote-access-ports persistence.
/// Keyed by `sha256("{cwd}::{port}")`, honoring `FRESHELL_HOME`.
/// Atomic tmp+rename writes, with normalization: dedupe, drop 0, ascending sort.
pub struct ManagedPortsStore {
    home: Option<PathBuf>,
    cwd: PathBuf,
    port: u16,
}

impl ManagedPortsStore {
    /// Create a Windows managed ports store. (Consumed by Task 3.3)
    #[allow(dead_code)]
    pub fn windows(home: Option<PathBuf>, cwd: PathBuf, port: u16) -> Self {
        Self { home, cwd, port }
    }

    /// Create a WSL managed ports store. (Consumed by Task 3.3)
    #[allow(dead_code)]
    pub fn wsl(home: Option<PathBuf>, cwd: PathBuf, port: u16) -> Self {
        Self { home, cwd, port }
    }

    /// Compute the storage key as sha256("{cwd}::{port}").
    fn compute_key(&self) -> String {
        let input = format!("{}::{}", self.cwd.display(), self.port);
        let mut hasher = Sha256::new();
        hasher.update(input.as_bytes());
        let result = hasher.finalize();
        format!("{:x}", result)
    }

    /// Get the base directory for Windows managed ports.
    fn windows_dir(&self) -> Option<PathBuf> {
        self.home.as_ref().map(|h| {
            h.join(".freshell")
                .join("windows-managed-remote-access-ports")
        })
    }

    /// Get the base directory for WSL managed ports.
    fn wsl_dir(&self) -> Option<PathBuf> {
        self.home
            .as_ref()
            .map(|h| h.join(".freshell").join("wsl-managed-remote-access-ports"))
    }

    /// Normalize a slice of ports: dedupe, drop 0, ascending sort.
    fn normalize_ports(ports: &[u16]) -> Vec<u16> {
        let mut normalized: Vec<u16> = ports.iter().filter(|&&p| p != 0).copied().collect();
        normalized.sort_unstable();
        normalized.dedup();
        normalized
    }

    /// Read ports from a given directory.
    fn read_from_dir(&self, dir: Option<PathBuf>) -> Vec<u16> {
        let Some(dir) = dir else { return Vec::new() };
        let key = self.compute_key();
        let file_path = dir.join(format!("{}.json", key));

        match fs::read_to_string(&file_path) {
            Ok(content) => match serde_json::from_str::<serde_json::Value>(&content) {
                Ok(json) => {
                    if let Some(ports_array) = json.get("ports").and_then(|v| v.as_array()) {
                        ports_array
                            .iter()
                            .filter_map(|v| v.as_u64().and_then(|u| u16::try_from(u).ok()))
                            .collect()
                    } else {
                        Vec::new()
                    }
                }
                Err(_) => Vec::new(),
            },
            Err(_) => Vec::new(),
        }
    }

    /// Persist ports to a given directory.
    fn persist_to_dir(&self, dir: Option<PathBuf>, ports: &[u16]) -> io::Result<()> {
        let Some(dir) = dir else {
            // None home: in-memory only, just return Ok.
            return Ok(());
        };

        let normalized = Self::normalize_ports(ports);
        let key = self.compute_key();
        let file_path = dir.join(format!("{}.json", key));

        // Empty list: delete the file
        if normalized.is_empty() {
            match fs::remove_file(&file_path) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
            return Ok(());
        }

        // Ensure directory exists
        fs::create_dir_all(&dir)?;

        // Build JSON content with pretty-printing (2-space indent)
        let json_value = serde_json::json!({ "ports": normalized });
        let json_string =
            serde_json::to_string_pretty(&json_value).expect("JSON serialization failed");

        // Atomic tmp+rename write
        let pid = process::id();
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        let tmp_name = format!(".tmp-{}-{}", pid, nanos);
        let tmp_path = dir.join(&tmp_name);

        fs::write(&tmp_path, json_string)?;
        match fs::rename(&tmp_path, &file_path) {
            Ok(()) => Ok(()),
            Err(e) => {
                // Clean up the orphaned temporary file on error
                let _ = fs::remove_file(&tmp_path);
                Err(e)
            }
        }
    }

    /// Read Windows managed ports. (Consumed by Task 3.3)
    #[allow(dead_code)]
    pub fn read_windows(&self) -> Vec<u16> {
        self.read_from_dir(self.windows_dir())
    }

    /// Persist Windows managed ports. (Consumed by Task 3.3)
    pub fn persist_windows(&self, ports: &[u16]) -> io::Result<()> {
        self.persist_to_dir(self.windows_dir(), ports)
    }

    /// Clear Windows managed ports. (Consumed by Task 3.3)
    #[allow(dead_code)]
    pub fn clear_windows(&self) -> io::Result<()> {
        self.persist_windows(&[])
    }

    /// Read WSL managed ports. (Consumed by Task 3.3)
    #[allow(dead_code)]
    pub fn read_wsl(&self) -> Vec<u16> {
        self.read_from_dir(self.wsl_dir())
    }

    /// Persist WSL managed ports. (Consumed by Task 3.3)
    #[allow(dead_code)]
    pub fn persist_wsl(&self, ports: &[u16]) -> io::Result<()> {
        self.persist_to_dir(self.wsl_dir(), ports)
    }

    /// Clear WSL managed ports. (Consumed by Task 3.3)
    #[allow(dead_code)]
    pub fn clear_wsl(&self) -> io::Result<()> {
        self.persist_wsl(&[])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persist_read_roundtrip_and_normalization() {
        let home = tempfile::tempdir().unwrap();
        let store = ManagedPortsStore::windows(Some(home.path().into()), "/proj/a".into(), 3001);
        // Unsorted input proves the ascending sort; the duplicate proves
        // dedupe; 0 proves the drop-zero filter. (A >65535 literal such as
        // 70000 cannot even compile through `&[u16]` — the type enforces the
        // upper bound; do NOT try to test it.)
        store.persist_windows(&[8080, 3001, 3001, 0]).unwrap();
        assert_eq!(store.read_windows(), vec![3001, 8080]);
    }

    #[test]
    fn empty_list_deletes_the_file() {
        let home = tempfile::tempdir().unwrap();
        let store = ManagedPortsStore::windows(Some(home.path().into()), "/proj/a".into(), 3001);
        store.persist_windows(&[3001]).unwrap();
        store.persist_windows(&[]).unwrap();
        assert!(store.read_windows().is_empty());

        // Assert the file is actually deleted from disk
        let key = store.compute_key();
        let windows_dir = home
            .path()
            .join(".freshell")
            .join("windows-managed-remote-access-ports");
        let file_path = windows_dir.join(format!("{}.json", key));
        assert!(!file_path.exists(), "File should be deleted from disk");
    }

    #[test]
    fn clear_on_nonexistent_file_returns_ok() {
        let home = tempfile::tempdir().unwrap();
        let store = ManagedPortsStore::windows(Some(home.path().into()), "/proj/a".into(), 3001);
        // Clearing when no file exists should succeed
        assert!(store.clear_windows().is_ok());
    }

    #[test]
    fn out_of_range_ports_are_rejected() {
        let home = tempfile::tempdir().unwrap();
        let store = ManagedPortsStore::windows(Some(home.path().into()), "/proj/a".into(), 3001);

        // Manually write a JSON file with out-of-range port values
        let windows_dir = home
            .path()
            .join(".freshell")
            .join("windows-managed-remote-access-ports");
        fs::create_dir_all(&windows_dir).unwrap();
        let key = store.compute_key();
        let file_path = windows_dir.join(format!("{}.json", key));

        // Write JSON with out-of-range port (70000 exceeds u16 max of 65535)
        fs::write(&file_path, r#"{"ports":[70000, 3001]}"#).unwrap();

        // Reading should return only the valid port (3001)
        assert_eq!(store.read_windows(), vec![3001]);
    }

    #[test]
    fn two_instances_do_not_clobber_each_other() {
        let home = tempfile::tempdir().unwrap();
        let a = ManagedPortsStore::windows(Some(home.path().into()), "/proj/a".into(), 3001);
        let b = ManagedPortsStore::windows(Some(home.path().into()), "/proj/b".into(), 3001);
        a.persist_windows(&[3001]).unwrap();
        b.persist_windows(&[4001]).unwrap();
        assert_eq!(a.read_windows(), vec![3001]);
        assert_eq!(b.read_windows(), vec![4001]);
    }
}
