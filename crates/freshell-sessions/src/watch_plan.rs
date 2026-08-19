//! Pure watch-set planning for the amplifier provider's managed inotify
//! watch set (kata v0h9 follow-up, design doc
//! `docs/superpowers/plans/2026-08-17-amplifier-watch-reduction.md`).
//!
//! Everything here is either pure (string/path classification, set
//! arithmetic, error classification) or ONE standalone readdir scan. No
//! watcher state, no index knowledge — the `session_watcher` module owns
//! arming; this module owns "what SHOULD be armed".

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;

static SUBAGENT_BASENAME_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9a-f]{16}-[0-9a-f]{16}_").expect("static regex"));
static UUID_BASENAME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
        .expect("static regex")
});

/// Basename classification of a session-dir name (design: classification is
/// by the session dir's BASENAME only, never the full path — 782/1,235 real
/// project names contain underscores).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BasenameClass {
    /// `^[0-9a-f]{16}-[0-9a-f]{16}_` — a delegated subagent session dir.
    /// NEVER watched (design: subagent dirs and everything below them are
    /// excluded from the watch set).
    Subagent,
    /// Lowercase 8-4-4-4-12 UUID — a root session dir. Watched forever.
    UuidRoot,
    /// Anything else — oddballs and unknown formats FAIL SAFE toward
    /// watching (a misclassified subagent would silently lose freshness; an
    /// over-watched oddball only costs one watch and feeds the drift alarm).
    Unknown,
}

pub(crate) fn classify_basename(name: &str) -> BasenameClass {
    if SUBAGENT_BASENAME_RE.is_match(name) {
        BasenameClass::Subagent
    } else if UUID_BASENAME_RE.is_match(name) {
        BasenameClass::UuidRoot
    } else {
        BasenameClass::Unknown
    }
}

/// Only subagent dirs are excluded (design's fail-safe default).
pub(crate) fn is_watch_target(class: BasenameClass) -> bool {
    !matches!(class, BasenameClass::Subagent)
}

/// The desired amplifier watch set for one `<amplifier_home>/projects` root
/// (design "Watch set" items 1-4, excluding the root itself which the
/// engine always attempts first).
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct PlanTargets {
    /// Whether `<projects>` itself exists (drives root absence tracking).
    pub root_exists: bool,
    /// `<project>/sessions` dirs that exist — permanent watches.
    pub sessions_dirs: Vec<PathBuf>,
    /// `<project>` dirs with no `sessions/` child — watched as stand-ins so
    /// a later-created `sessions/` is observed (design item 2).
    pub standins: Vec<PathBuf>,
    /// Root-classified session dirs (UuidRoot or Unknown) — permanent
    /// watches. Subagent-classified dirs never appear here.
    pub root_session_dirs: Vec<PathBuf>,
    /// Count of `root_session_dirs` entries classified Unknown — the
    /// drift-alarm counter input.
    pub unknown_format_arms: usize,
    /// Stray non-dir entries at project depth (e.g. `repl_history`) — never
    /// armed, counted for the regression-17 pin.
    pub stray_file_projects: usize,
}

/// ONE readdir sweep (never recursive) building the managed watch set.
/// Root-open semantics match the discover contract (`open_root_dir`): a
/// missing projects root is `Ok(plan with root_exists:false)`, other root
/// errors PROPAGATE (a transient EACCES/EIO must not look like "nothing to
/// arm"). Nested reads are STRICT, not tolerant like
/// `discover_project_session_metadata`: ANY readdir/stat error at ANY depth
/// (projects-root entry, a `sessions/` stat or readdir, a session entry,
/// an entry's `file_type`) fails the WHOLE plan with `Err` — never a
/// partial plan. The plan is authoritative for Task 6's replan unwatch
/// diff; a partial plan over a transient nested error would tear every
/// healthy root watch it failed to see. A plain MISSING `sessions/` dir
/// (NotFound) is NOT an error — it yields the stand-in — and a non-dir
/// `sessions` FILE is not an error either (classification by entry
/// file_type stays; only ERRORS fail the plan).
pub(crate) fn plan_amplifier_targets(projects_root: &Path) -> Result<PlanTargets, std::io::Error> {
    let mut plan = PlanTargets::default();
    let Some(entries) = crate::directory_index::open_root_dir(projects_root)? else {
        return Ok(plan);
    };
    plan.root_exists = true;
    let mut projects: Vec<PathBuf> = Vec::new();
    for entry in entries {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            projects.push(entry.path());
        } else {
            plan.stray_file_projects += 1;
        }
    }
    projects.sort(); // determinism (readdir order is filesystem-dependent)
    for project in projects {
        let sessions = project.join("sessions");
        match std::fs::metadata(&sessions) {
            // Plain missing `sessions/` ⇒ stand-in. NOT an error.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                plan.standins.push(project);
            }
            // Strict: any stat error fails the whole plan.
            Err(e) => return Err(e),
            // `sessions` exists but is a FILE — treat like the stand-in
            // (classification by file_type stays; never a doomed arm).
            Ok(meta) if !meta.is_dir() => {
                plan.standins.push(project);
            }
            Ok(_) => {
                plan.sessions_dirs.push(sessions.clone());
                // Strict: the readdir AND every entry/file_type error
                // propagate — no partial plans.
                let mut dirs: Vec<PathBuf> = Vec::new();
                for entry in std::fs::read_dir(&sessions)? {
                    let entry = entry?;
                    if entry.file_type()?.is_dir() {
                        dirs.push(entry.path());
                    }
                }
                dirs.sort();
                for session_dir in dirs {
                    let name = session_dir
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("");
                    match classify_basename(name) {
                        BasenameClass::Subagent => {} // never watched
                        BasenameClass::UuidRoot => plan.root_session_dirs.push(session_dir),
                        BasenameClass::Unknown => {
                            plan.root_session_dirs.push(session_dir);
                            plan.unknown_format_arms += 1;
                        }
                    }
                }
            }
        }
    }
    Ok(plan)
}

/// The arm semantics of one managed-watch target (design "Watch set"
/// items 1-3). Carried end-to-end — plan → diff → retry entry → arm call —
/// so no consumer re-derives (or loses) the kind: a `SessionsDir` arm
/// cascades its root-session children, a `Standin` arm performs the
/// stand-in swap, a `SessionDir` arm does the watch-then-scan scoped
/// file-state mark, and `ProjectsRoot` alone re-enters absence tracking.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ArmKind {
    /// `<amplifier_home>/projects` itself — depth-0 structural watch.
    ProjectsRoot,
    /// `<project>/sessions` — arm + cascade its root-classified children.
    SessionsDir,
    /// `<project>` with no `sessions/` yet — arm + post-arm recheck swap.
    Standin,
    /// A root-classified session dir — arm + scoped metadata.json mark.
    SessionDir,
}

/// One path to arm, tagged with the semantics its arm must apply.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ArmTarget {
    pub path: PathBuf,
    pub kind: ArmKind,
}

/// Set difference between the desired (kind-tagged) and currently-armed
/// paths (sorted by path — call sites log/apply deterministically).
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct PlanDiff {
    pub arm: Vec<ArmTarget>,
    pub unwatch: Vec<PathBuf>,
}

pub(crate) fn diff_armed(
    desired: &std::collections::HashMap<PathBuf, ArmKind>,
    armed: &HashSet<PathBuf>,
) -> PlanDiff {
    let mut arm: Vec<ArmTarget> = desired
        .iter()
        .filter(|(path, _)| !armed.contains(*path))
        .map(|(path, kind)| ArmTarget {
            path: path.clone(),
            kind: *kind,
        })
        .collect();
    arm.sort_by(|a, b| a.path.cmp(&b.path));
    let mut unwatch: Vec<PathBuf> = armed
        .iter()
        .filter(|p| !desired.contains_key(*p))
        .cloned()
        .collect();
    unwatch.sort();
    PlanDiff { arm, unwatch }
}

/// Arm-failure classification (design: ENOENT/ENOTDIR entries are dropped
/// immediately — a dir's reappearance arrives as a fresh structural create;
/// everything else is a transient error that gets bounded backoff retry).
/// Arms fail with `notify::Error` (`watch()` returns
/// `Result<(), notify::Error>`), so the classifier consumes that type and
/// matches its pub `kind` field, never a bare `std::io::Error`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ArmErr {
    Deterministic,
    Transient,
}

pub(crate) fn classify_arm_error(err: &notify::Error) -> ArmErr {
    match &err.kind {
        notify::ErrorKind::PathNotFound => ArmErr::Deterministic,
        notify::ErrorKind::Io(io) => match io.kind() {
            std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory => {
                ArmErr::Deterministic
            }
            _ => ArmErr::Transient,
        },
        // `ErrorKind::MaxFilesWatch` → Transient via this default arm:
        // watch-limit exhaustion clears and evicted paths re-arm after the
        // pressure releases. Pinned in the classifier test via
        // `notify::Error::new(notify::ErrorKind::MaxFilesWatch)`.
        _ => ArmErr::Transient,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn unique_temp_dir(label: &str) -> PathBuf {
        static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        std::env::temp_dir().join(format!(
            "freshell-watch-plan-{label}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ))
    }

    fn mkdir(p: &Path) {
        std::fs::create_dir_all(p).unwrap();
    }

    #[test]
    fn classify_basename_pins_the_amplifier_naming_contract() {
        // Subagent: ^[0-9a-f]{16}-[0-9a-f]{16}_ — incl. the all-zeros first
        // segment observed on the real machine.
        assert_eq!(
            classify_basename("0000000000000000-014b6af1c2ac4ab5_foundation-session-analyst"),
            BasenameClass::Subagent
        );
        assert_eq!(
            classify_basename("0123456789abcdef-fedcba9876543210_x"),
            BasenameClass::Subagent
        );

        // Root UUID (real sample): lowercase 8-4-4-4-12.
        assert_eq!(
            classify_basename("012584be-9478-4801-a62d-4e5da428b3a0"),
            BasenameClass::UuidRoot
        );

        // Fail safe toward watching: 16hex-16hex WITHOUT the `_name` suffix
        // (real oddball `3857d6bf9587425b-345eb38395044eab`), arbitrary
        // oddballs, uppercase hex, empty — all Unknown (watched, drift-counted).
        assert_eq!(
            classify_basename("3857d6bf9587425b-345eb38395044eab"),
            BasenameClass::Unknown
        );
        assert_eq!(classify_basename("tmp-usual-bench"), BasenameClass::Unknown);
        assert_eq!(classify_basename("sess-identity-1"), BasenameClass::Unknown);
        assert_eq!(
            classify_basename("0123456789ABCDEF-fedcBA9876543210_x"),
            BasenameClass::Unknown
        );
        assert_eq!(classify_basename(""), BasenameClass::Unknown);
        for class in [BasenameClass::UuidRoot, BasenameClass::Unknown] {
            assert!(is_watch_target(class));
        }
        assert!(!is_watch_target(BasenameClass::Subagent));
    }

    #[test]
    fn classifier_never_confuses_project_name_underscores() {
        // 782/1,235 real project names contain `_`. Classification consumes the
        // SESSION-DIR basename only; a project-named string must never satisfy
        // the subagent pattern unless it genuinely matches ^16hex-16hex_.
        assert_eq!(
            classify_basename("-home-dan-code-my_project"),
            BasenameClass::Unknown
        );
        assert_eq!(classify_basename("recipe-sessions"), BasenameClass::Unknown);
    }

    #[test]
    fn planner_ignores_stray_files_at_project_depth() {
        // Regression 17a: a stray file at project depth (`repl_history` exists
        // on the real machine) never generates a doomed `<file>/sessions` arm.
        let root = unique_temp_dir("planner-stray");
        let projects = root.join("projects");
        std::fs::create_dir_all(&projects).unwrap();
        std::fs::write(projects.join("repl_history"), b"nope").unwrap();
        mkdir(
            &projects
                .join("my_proj_x")
                .join("sessions")
                .join("012584be-9478-4801-a62d-4e5da428b3a0"),
        );
        mkdir(
            &projects
                .join("my_proj_x")
                .join("sessions")
                .join("0000000000000000-014b6af1c2ac4ab5_a"),
        );
        mkdir(&projects.join("no_sessions_proj")); // stand-in

        let plan = plan_amplifier_targets(&projects).unwrap();
        assert!(plan.root_exists);
        assert_eq!(
            plan.sessions_dirs,
            vec![projects.join("my_proj_x").join("sessions")]
        );
        assert_eq!(plan.standins, vec![projects.join("no_sessions_proj")]);
        assert_eq!(
            plan.root_session_dirs,
            vec![projects
                .join("my_proj_x")
                .join("sessions")
                .join("012584be-9478-4801-a62d-4e5da428b3a0"),]
        );
        assert_eq!(plan.unknown_format_arms, 0);
        assert_eq!(plan.stray_file_projects, 1);
        // The stray file appears nowhere:
        let flat: Vec<&PathBuf> = plan
            .sessions_dirs
            .iter()
            .chain(plan.standins.iter())
            .chain(plan.root_session_dirs.iter())
            .collect();
        assert!(!flat.iter().any(|p| p.ends_with("repl_history")));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn planner_counts_unknown_format_root_dirs_as_drift_input() {
        let root = unique_temp_dir("planner-drift");
        let projects = root.join("projects");
        mkdir(
            &projects
                .join("p")
                .join("sessions")
                .join("3857d6bf9587425b-345eb38395044eab"),
        ); // oddball
        mkdir(
            &projects
                .join("p")
                .join("sessions")
                .join("012584be-9478-4801-a62d-4e5da428b3a0"),
        );
        let plan = plan_amplifier_targets(&projects).unwrap();
        assert_eq!(plan.unknown_format_arms, 1);
        assert_eq!(plan.root_session_dirs.len(), 2); // both are watched
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn planner_missing_root_is_absent_not_error() {
        let root = unique_temp_dir("planner-absent");
        let plan = plan_amplifier_targets(&root.join("projects")).unwrap();
        assert!(!plan.root_exists);
        assert!(
            plan.sessions_dirs.is_empty()
                && plan.root_session_dirs.is_empty()
                && plan.standins.is_empty()
        );
    }

    /// A nested read error ANYWHERE (here: one project's `sessions/` dir is
    /// unreadable while the projects root and the project dir list fine)
    /// fails the WHOLE plan — never a partial plan. Task 6's replan aborts
    /// on `Err`, so a transient nested EACCES/EIO tears nothing down.
    #[cfg(unix)]
    #[test]
    fn planner_nested_scan_error_fails_the_whole_plan() {
        use std::os::unix::fs::PermissionsExt;
        let root = unique_temp_dir("planner-nested-err");
        let projects = root.join("projects");
        mkdir(
            &projects
                .join("good")
                .join("sessions")
                .join("012584be-9478-4801-a62d-4e5da428b3a0"),
        );
        let bad_sessions = projects.join("bad").join("sessions");
        mkdir(&bad_sessions.join("aa2584be-9478-4801-a62d-4e5da428b3a0"));
        std::fs::set_permissions(&bad_sessions, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read_dir(&bad_sessions).is_ok() {
            eprintln!("skipping: euid can list a 0o000 dir");
            std::fs::set_permissions(&bad_sessions, std::fs::Permissions::from_mode(0o755))
                .unwrap();
            std::fs::remove_dir_all(&root).ok();
            return;
        }
        assert!(
            plan_amplifier_targets(&projects).is_err(),
            "a nested readdir error fails the whole plan (no partial plans)"
        );
        std::fs::set_permissions(&bad_sessions, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn diff_armed_partitions_missing_and_extra_and_keeps_kinds() {
        // Desired targets carry their ArmKind; the diff's arm entries must
        // keep it so replan applies each arm with its own semantics (never
        // a flattened bare-path arm).
        let desired: std::collections::HashMap<PathBuf, ArmKind> = [
            (PathBuf::from("/a"), ArmKind::SessionsDir),
            (PathBuf::from("/b"), ArmKind::SessionDir),
        ]
        .into_iter()
        .collect();
        let armed: std::collections::HashSet<PathBuf> =
            ["/b", "/c"].iter().map(PathBuf::from).collect();
        let diff = diff_armed(&desired, &armed);
        assert_eq!(
            diff.arm,
            vec![ArmTarget {
                path: PathBuf::from("/a"),
                kind: ArmKind::SessionsDir,
            }]
        );
        assert_eq!(diff.unwatch, vec![PathBuf::from("/c")]);
    }

    #[test]
    fn classify_arm_error_splits_deterministic_io_from_transient() {
        use std::io::ErrorKind;
        // notify 6.1.1 API (verified against the vendored error.rs):
        // `Error::new`, `Error::io`, and `Error::path_not_found` are pub
        // constructors, so every variant below is constructed directly.
        assert!(matches!(
            classify_arm_error(&notify::Error::path_not_found()),
            ArmErr::Deterministic
        ));
        assert!(matches!(
            classify_arm_error(&notify::Error::io(std::io::Error::from(
                ErrorKind::NotFound
            ))),
            ArmErr::Deterministic
        ));
        assert!(matches!(
            classify_arm_error(&notify::Error::io(std::io::Error::from(
                ErrorKind::NotADirectory
            ))),
            ArmErr::Deterministic
        ));
        assert!(matches!(
            classify_arm_error(&notify::Error::io(std::io::Error::from(
                ErrorKind::PermissionDenied
            ))),
            ArmErr::Transient
        ));
        assert!(matches!(
            classify_arm_error(&notify::Error::io(std::io::Error::from(ErrorKind::Other))),
            ArmErr::Transient
        ));
        // Watch-limit exhaustion is transient: pressure clears and evicted
        // paths re-arm on retry.
        assert!(matches!(
            classify_arm_error(&notify::Error::new(notify::ErrorKind::MaxFilesWatch)),
            ArmErr::Transient
        ));
    }
}
