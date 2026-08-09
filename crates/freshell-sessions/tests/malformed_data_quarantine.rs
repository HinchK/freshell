//! SESSION-16 — "Tolerate malformed and partially written provider data."
//!
//! Integration pins over the REAL `SessionIndex` + REAL `SessionSource` impls
//! (`ClaudeSource` / `CodexSource` / `AmplifierSource` / `OpencodeSource`) against real
//! on-disk corpora, proving the three acceptance clauses at the index seam:
//!
//! 1. **Healthy sessions stay available** — quarantine-class records (empty,
//!    all-malformed, cwd-invisible from parse) are excluded per-record; sibling healthy
//!    records are indexed and stable no matter what sits next to them. For the
//!    single-db provider (OpenCode) a corrupt database records a scan failure and
//!    preserves the healthy cached sessions instead of serving a silent healthy-empty.
//! 2. **Bad records are quarantined** — they never appear in a snapshot, and a cached
//!    exclusion is never re-parsed while the file's `(mtime, size)` sits unchanged.
//! 3. **A record is indexed once it becomes valid** — a partially-written record
//!    (truncated mid-line write, permanently corrupt first line followed by a valid
//!    append, truncated-then-rewritten metadata doc) becomes indexed when its content
//!    becomes parseable, WITHOUT a restart, because the exclusion cache entry is keyed
//!    on `(mtime, size)` which the completing write moves.
//!
//! Parity source (frozen legacy `server/` at the base SHA):
//! `server/coding-cli/session-indexer.ts` `readLightweightMeta` (per-file/per-line
//! `try/catch { continue }`, `if (!meta.cwd) continue` R10b gate) + `providers/claude.ts`
//! `parseSessionContent` + `providers/codex.ts` (same per-line skip) +
//! `providers/opencode.ts` (`listSessionsDirect` re-throws read errors so the indexer
//! keeps previously-listed sessions; rows without a cwd are skipped) +
//! `providers/amplifier.ts` (`parseAmplifierMetadata` malformed → `{}` → cwd-less skip).
//!
//! INTENTIONALLY NOT quarantined (legacy parity — asserted as indexed below):
//! - invalid-UTF-8 transcripts (Node's `fs.readFile(f, 'utf8')` is lossy U+FFFD; the
//!   record is indexed with replacement chars — regression class "bug #7"),
//! - truncated-with-valid-prefix records (the parseable prefix is indexed; the
//!   truncated tail is skipped).
//!
//! Cross-checks for the audit ledger `docs/plans/df1/SESSION-16.md` (A1–A5): every test
//! here PASSES against the un-modified base implementation — these are characterization
//! pins of already-correct behavior (class-P item: behavior present, evidence missing),
//! each verified teeth-bearing by task-0 mutation spot-checks recorded in the evidence
//! file (`docs/plans/df1-evidence/SESSION-16.md`).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use freshell_sessions::amplifier::AmplifierSource;
use freshell_sessions::directory_index::{
    ClaudeSource, CodexSource, FileStat, IndexedSession, OpencodeSource, SessionIndex,
    SessionSource,
};

/// Short TTL so a next-`snapshot()` call almost immediately re-sweeps.
const TTL: Duration = Duration::from_millis(10);
/// Poll budget for observing a detached background sweep settle (stale-while-revalidate
/// means a post-TTL `snapshot()` returns the STALE generation while the re-sweep runs).
const SETTLE: Duration = Duration::from_secs(5);

// ── fixtures/helpers ─────────────────────────────────────────────────────────

/// A real temp dir that removes itself on drop (every corpus lives under one).
struct TmpDir(PathBuf);
impl TmpDir {
    fn new(label: &str) -> Self {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "freshell-s16-{label}-{}-{nanos}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        TmpDir(dir)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for TmpDir {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).ok();
    }
}

fn mk_index(sources: Vec<Arc<dyn SessionSource>>) -> SessionIndex {
    // Persistence disabled: tests stay hermetic (no real `~/.freshell` cache file).
    SessionIndex::with_ttl_and_cache_path(sources, TTL, None)
}

/// Poll `snapshot()` until `pred` holds on a published generation or `timeout` elapses.
/// Each call past the TTL spawns a detached background sweep, so repeated polling is how
/// the (deliberately un-awaited) refresh is observed settling.
async fn poll_until(
    index: &SessionIndex,
    timeout: Duration,
    mut pred: impl FnMut(&[IndexedSession]) -> bool,
) -> Option<Vec<IndexedSession>> {
    let start = std::time::Instant::now();
    loop {
        let snap = index.snapshot().await;
        if pred(&snap) {
            return Some(snap.to_vec());
        }
        if start.elapsed() >= timeout {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// One minimal valid claude record line (mirrors
/// `directory_index.rs`'s in-crate `write_session_file` shape: a single user record
/// carrying cwd + sessionId + a user message -> title).
fn claude_line(session_id: &str, cwd: &str, timestamp: &str, message: &str) -> String {
    format!(
        "{{\"parentUuid\":null,\"isSidechain\":false,\"userType\":\"external\",\"cwd\":\"{cwd}\",\"sessionId\":\"{session_id}\",\"version\":\"1.0.0\",\"gitBranch\":\"main\",\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"{message}\"}},\"uuid\":\"{session_id}\",\"timestamp\":\"{timestamp}\"}}\n"
    )
}

/// Canonical-looking claude session id (`is_canonical_claude_session_id` passes).
fn claude_id(n: usize) -> String {
    format!("{n:08x}-0000-4000-8000-000000000000")
}

fn keys(items: &[IndexedSession]) -> Vec<String> {
    items.iter().map(|s| s.key()).collect()
}

/// Wraps a file-based source to count `parse()` calls — the quarantine-economics pin:
/// a cached exclusion must never be re-parsed while `(mtime, size)` hold.
struct CountParse<S: SessionSource> {
    inner: S,
    parse_calls: Arc<AtomicUsize>,
}
impl<S: SessionSource> CountParse<S> {
    fn new(inner: S) -> (Self, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        (
            Self {
                inner,
                parse_calls: Arc::clone(&calls),
            },
            calls,
        )
    }
}
impl<S: SessionSource> SessionSource for CountParse<S> {
    fn discover(&self) -> Vec<FileStat> {
        self.inner.discover()
    }
    fn parse(&self, path: &Path) -> Option<IndexedSession> {
        self.parse_calls.fetch_add(1, Ordering::SeqCst);
        self.inner.parse(path)
    }
    fn provider_name(&self) -> Option<&'static str> {
        self.inner.provider_name()
    }
    fn discover_checked(&self) -> Result<Vec<FileStat>, std::io::Error> {
        self.inner.discover_checked()
    }
}

// ── claude ───────────────────────────────────────────────────────────────────

/// Clause 1+2 (claude): a healthy session stays indexed across every quarantine class
/// sitting next to it, and the corpus is STABLE across a second sweep (quarantined
/// records don't wobble in/out).
#[tokio::test]
async fn claude_healthy_session_survives_a_matrix_of_quarantined_siblings() {
    let home = TmpDir::new("claude-matrix");
    let claude_home = home.path().join(".claude");
    let project = claude_home.join("projects").join("-p");
    std::fs::create_dir_all(&project).unwrap();

    // The healthy session — present in every assertion below.
    std::fs::write(
        project.join(format!("{}.jsonl", claude_id(1))),
        claude_line(
            &claude_id(1),
            "/p/healthy",
            "2026-01-30T08:00:00.000Z",
            "healthy request",
        ),
    )
    .unwrap();
    // (a) 0-byte file — never had a first write flush.
    std::fs::write(project.join(format!("{}.jsonl", claude_id(2))), "").unwrap();
    // (b) whitespace-only.
    std::fs::write(
        project.join(format!("{}.jsonl", claude_id(3))),
        "\n  \n\r\n\t\n",
    )
    .unwrap();
    // (c) every line malformed (mixed garbage shapes).
    std::fs::write(
        project.join(format!("{}.jsonl", claude_id(4))),
        "not json at all\n{\"unclosed\":\n\x00\x01\x02 binary junk\n[1,2,\n",
    )
    .unwrap();
    // (d) well-formed JSON lines but NO cwd anywhere (R10b discovery gate).
    std::fs::write(
        project.join(format!("{}.jsonl", claude_id(5))),
        format!(
            "{}\n{}\n",
            "{\"type\":\"summary\",\"summary\":\"a cwd-less record\"}",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}"
        ),
    )
    .unwrap();
    // (e) truncated mid-line: the entire file is ONE incomplete JSON object.
    let full = claude_line(
        &claude_id(6),
        "/p/truncated",
        "2026-01-30T08:01:00.000Z",
        "cut off",
    );
    std::fs::write(
        project.join(format!("{}.jsonl", claude_id(6))),
        &full[..full.len() / 3],
    )
    .unwrap();
    // (f) truncated-with-VALID-prefix: the cwd-bearing line survived; only the tail line
    // is cut. NOT quarantined (legacy indexes the parseable prefix) — this is the
    // "partially written but already useful" class.
    let mut partial = claude_line(
        &claude_id(7),
        "/p/prefix",
        "2026-01-30T08:02:00.000Z",
        "prefix kept",
    );
    let tail = claude_line(
        &claude_id(7),
        "/p/prefix",
        "2026-01-30T08:03:00.000Z",
        "cut tail",
    );
    partial.push_str(&tail[..tail.len() / 3]);
    std::fs::write(project.join(format!("{}.jsonl", claude_id(7))), partial).unwrap();

    let index = mk_index(vec![Arc::new(ClaudeSource::new(claude_home.clone()))]);

    let snap = index.snapshot().await;
    // Sort order is lastActivityAt DESC: (f) (08:02, only the prefix line parses) ranks
    // above the healthy seed (08:00). Quarantine set (a)-(e) never appears.
    assert_eq!(
        keys(&snap),
        vec![
            format!("claude:{}", claude_id(7)),
            format!("claude:{}", claude_id(1))
        ],
        "healthy + valid-prefix indexed; empty/whitespace/all-malformed/cwd-less/truncated-only quarantined"
    );

    // Clause-2 stability: a second sweep (past TTL, nothing changed) serves the same set.
    let mut settled: Vec<IndexedSession> = snap.to_vec();
    assert!(
        poll_until(&index, SETTLE, |items| {
            let k = keys(items);
            if k.len() == 2 && k == keys(&snap) {
                settled = items.to_vec();
                true
            } else {
                false
            }
        })
        .await
        .is_some(),
        "quarantine matrix is stable across an unchanged re-sweep"
    );
    assert_eq!(keys(&settled), keys(&snap));
}

/// Clause 1+2 (claude, LIVE source path): an invalid-UTF-8 transcript is NOT
/// quarantined — Node's `fs.readFile(f, 'utf8')` is lossy and the record is indexed with
/// U+FFFD replacement chars (regression class "bug #7": `read_to_string` previously
/// dropped the whole file). Pinned at the oracle seam by
/// `session_directory.rs::invalid_utf8_transcript_is_indexed_lossily_like_node`; this is
/// the LIVE `ClaudeSource`/`SessionIndex` equivalent plus a healthy sibling.
#[tokio::test]
async fn claude_invalid_utf8_record_is_indexed_lossily_not_quarantined() {
    let home = TmpDir::new("claude-utf8");
    let claude_home = home.path().join(".claude");
    let project = claude_home.join("projects").join("-home-dan-proj");
    std::fs::create_dir_all(&project).unwrap();

    // Invalid UTF-8 subsequences inside an otherwise-valid JSON record (same byte shape
    // as the oracle-path regression test).
    let mut bytes: Vec<u8> = Vec::new();
    bytes.extend_from_slice(br#"{"parentUuid":null,"cwd":"/home/dan/proj","sessionId":"cccc1111-2222-4333-8444-555566667777","type":"user","message":{"role":"user","content":"bad "#);
    bytes.extend_from_slice(&[0xC3, 0x28, 0x20, 0xE2, 0x82, 0x20, 0xF0, 0x9F, 0x98]);
    bytes.extend_from_slice(br#" end"},"uuid":"cccc0001-0000-4000-8000-000000000001","timestamp":"2026-01-30T08:00:00.000Z"}"#);
    bytes.push(b'\n');
    std::fs::write(
        project.join("cccc1111-2222-4333-8444-555566667777.jsonl"),
        bytes,
    )
    .unwrap();

    // A healthy sibling must be unaffected by the corrupt neighbor.
    std::fs::write(
        project.join(format!("{}.jsonl", claude_id(42))),
        claude_line(
            &claude_id(42),
            "/p/healthy",
            "2026-01-30T09:00:00.000Z",
            "healthy neighbor",
        ),
    )
    .unwrap();

    let index = mk_index(vec![Arc::new(ClaudeSource::new(claude_home.clone()))]);
    let snap = index.snapshot().await;
    let mut k = keys(&snap);
    k.sort();
    assert_eq!(
        k,
        vec![
            format!("claude:{}", claude_id(42)),
            "claude:cccc1111-2222-4333-8444-555566667777".to_string()
        ],
        "invalid-UTF-8 record is indexed (lossy), healthy sibling intact"
    );
    let lossy = snap
        .iter()
        .find(|s| s.session_id == "cccc1111-2222-4333-8444-555566667777")
        .expect("lossy record present");
    let title = lossy.title.as_deref().unwrap_or("");
    assert!(
        title.contains('\u{FFFD}'),
        "title carries U+FFFD replacements (lossy read parity), got {title:?}"
    );
    assert_eq!(lossy.cwd.as_deref(), Some("/home/dan/proj"));
}

/// Clause 3 (claude): a partially-written record is quarantined only while it has no
/// parseable identity, and is indexed — WITHOUT restart — by exactly the completing
/// write. Two completion shapes:
///   (a) the line left truncated mid-write is itself completed by appending its missing
///       tail bytes (the true "completed partial write"),
///   (b) the first line stays corrupt forever (a crash mid-write) and a LATER complete
///       line supplies identity/cwd (append-only log reality).
#[tokio::test]
async fn claude_partial_record_is_indexed_once_it_becomes_valid() {
    let home = TmpDir::new("claude-becomes-valid");
    let claude_home = home.path().join(".claude");
    let project = claude_home.join("projects").join("-p");
    std::fs::create_dir_all(&project).unwrap();

    // Healthy sibling — the never-moving control.
    std::fs::write(
        project.join(format!("{}.jsonl", claude_id(10))),
        claude_line(
            &claude_id(10),
            "/p/healthy",
            "2026-01-30T08:00:00.000Z",
            "healthy control",
        ),
    )
    .unwrap();

    // (a) truncated mid-line — complete valid record exists only as prefix bytes.
    let path_a = project.join(format!("{}.jsonl", claude_id(11)));
    let full_a = claude_line(
        &claude_id(11),
        "/p/partial-a",
        "2026-01-30T08:05:00.000Z",
        "partial a",
    );
    let cut_a = full_a.len() * 2 / 3;
    std::fs::write(&path_a, &full_a[..cut_a]).unwrap();

    // (b) first line permanently corrupt (mid-write crash shape).
    let path_b = project.join(format!("{}.jsonl", claude_id(12)));
    std::fs::write(&path_b, "{\"type\":\"user\",\"message\":{\"role\":\"use").unwrap();

    let index = mk_index(vec![Arc::new(ClaudeSource::new(claude_home.clone()))]);

    let snap0 = index.snapshot().await;
    assert_eq!(
        keys(&snap0),
        vec![format!("claude:{}", claude_id(10))],
        "partial records quarantined while invalid, healthy sibling indexed"
    );

    // Complete (a): append exactly the missing tail bytes of the truncated line.
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .open(&path_a)
        .unwrap();
    use std::io::Write as _;
    f.write_all(full_a[cut_a..].as_bytes()).unwrap();
    drop(f);
    // Complete (b): the corrupt first line is never FIXED — it is TERMINATED (the `\n`
    // of a later append lands) and a complete record arrives after it. Appending a bare
    // line directly after the newline-less fragment would just extend the corrupt line
    // forever; the newline-first append is the faithful healing shape for append-only
    // JSONL providers.
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .open(&path_b)
        .unwrap();
    f.write_all(b"\n").unwrap();
    f.write_all(
        claude_line(
            &claude_id(12),
            "/p/partial-b",
            "2026-01-30T08:06:00.000Z",
            "partial b",
        )
        .as_bytes(),
    )
    .unwrap();
    drop(f);

    let settled = poll_until(&index, SETTLE, |items| items.len() == 3)
        .await
        .expect("both completed partial records become indexed without a restart");
    let mut k = keys(&settled);
    k.sort();
    assert_eq!(
        k,
        vec![
            format!("claude:{}", claude_id(10)),
            format!("claude:{}", claude_id(11)),
            format!("claude:{}", claude_id(12))
        ],
        "exactly the two completed records join the index (one live addition each)"
    );
    // The healthy control is byte-identical (same parsed fields) before and after.
    let before = snap0
        .iter()
        .find(|s| s.session_id == claude_id(10))
        .unwrap();
    let after = settled
        .iter()
        .find(|s| s.session_id == claude_id(10))
        .unwrap();
    assert_eq!(
        before, after,
        "healthy sibling record untouched by completions"
    );
}

/// Clause-2 economics pin: quarantined records are cached as exclusions — an unchanged
/// corpus is never re-parsed, including the exclusions.
#[tokio::test]
async fn claude_exclusions_are_cached_and_never_reparsed_while_unchanged() {
    let home = TmpDir::new("claude-exclusion-cache");
    let claude_home = home.path().join(".claude");
    let project = claude_home.join("projects").join("-p");
    std::fs::create_dir_all(&project).unwrap();

    std::fs::write(
        project.join(format!("{}.jsonl", claude_id(20))),
        claude_line(
            &claude_id(20),
            "/p/healthy",
            "2026-01-30T08:00:00.000Z",
            "healthy",
        ),
    )
    .unwrap();
    std::fs::write(project.join(format!("{}.jsonl", claude_id(21))), "").unwrap();
    std::fs::write(
        project.join(format!("{}.jsonl", claude_id(22))),
        "garbage\n{not json\n",
    )
    .unwrap();

    let (source, parse_calls) = CountParse::new(ClaudeSource::new(claude_home.clone()));
    let index = mk_index(vec![Arc::new(source)]);

    let snap = index.snapshot().await;
    assert_eq!(snap.len(), 1);
    assert_eq!(
        parse_calls.load(Ordering::SeqCst),
        3,
        "each file parsed once"
    );

    // Two settled sweeps later, still exactly 3 parse calls — neither the healthy entry
    // nor the cached exclusions are re-parsed while (mtime, size) hold.
    let mut last: Vec<IndexedSession> = snap.to_vec();
    for _ in 0..2 {
        tokio::time::sleep(Duration::from_millis(40)).await;
        last = index.snapshot().await.to_vec();
        tokio::time::sleep(Duration::from_millis(40)).await; // let the bg sweep publish
    }
    assert_eq!(last.len(), 1);
    assert_eq!(
        parse_calls.load(Ordering::SeqCst),
        3,
        "no re-parse of healthy entry or cached exclusion while files are unchanged"
    );
}

// ── codex ────────────────────────────────────────────────────────────────────

/// Codex rollout layout helpers: `<codex_home>/sessions/YYYY/MM/DD/<file>.jsonl`
/// (recursive nesting; the source walks all of it).
fn write_codex_rollout(sessions_root: &Path, name: &str, lines: &str) {
    let dir = sessions_root.join("2026").join("07").join("18");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(name), lines).unwrap();
}

/// The healthy codex rollout: `session_meta` (+cwd) and one user message (title/tier
/// data) — the same shape `session-directory-matrix.spec.ts` seeds.
fn codex_healthy(session_id: &str, cwd: &str) -> String {
    [
        "{\"timestamp\":\"2026-07-18T08:00:00.000Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\""
            .to_string()
            + session_id
            + "\",\"cwd\":\""
            + cwd
            + "\"}}",
        "{\"timestamp\":\"2026-07-18T08:00:01.000Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"codex healthy request\"}]}}".to_string(),
        "{\"timestamp\":\"2026-07-18T08:00:02.000Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"codex healthy reply\"}]}}".to_string(),
    ]
    .join("\n")
        + "\n"
}

/// Clause 1+2 (codex): the same quarantine matrix as claude, provider-adjusted.
#[tokio::test]
async fn codex_healthy_session_survives_a_matrix_of_quarantined_siblings() {
    let home = TmpDir::new("codex-matrix");
    let codex_home = home.path().join(".codex");
    let sessions = codex_home.join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();

    write_codex_rollout(
        &sessions,
        "codex-healthy-16.jsonl",
        &codex_healthy("codex-healthy-16", "/p/codex-healthy"),
    );
    // (a) 0-byte.
    write_codex_rollout(&sessions, "codex-empty-16.jsonl", "");
    // (b) whitespace only.
    write_codex_rollout(&sessions, "codex-ws-16.jsonl", "\n \r\n\n");
    // (c) all lines malformed.
    write_codex_rollout(
        &sessions,
        "codex-garbage-16.jsonl",
        "!!!\n{\"x\":\n\x00 junk\n",
    );
    // (d) well-formed session_meta WITHOUT cwd (R10b).
    write_codex_rollout(
        &sessions,
        "codex-cwdless-16.jsonl",
        "{\"timestamp\":\"2026-07-18T08:00:00.000Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"codex-cwdless-16\"}}\n",
    );
    // (e) truncated-only: the session_meta line (the FIRST line) cut mid-write — no
    // complete line anywhere in the file. (Cutting across the multi-line document at a
    // fixed fraction would leave line 1 intact, which is the valid-prefix class, NOT
    // this class.)
    let full = codex_healthy("codex-truncated-16", "/p/codex-truncated");
    let meta_line_end = full.find('\n').unwrap();
    let meta_line = &full[..meta_line_end];
    write_codex_rollout(
        &sessions,
        "codex-truncated-16.jsonl",
        &meta_line[..meta_line.len() * 2 / 3],
    );

    let index = mk_index(vec![Arc::new(CodexSource::new(codex_home.clone()))]);
    let snap = index.snapshot().await;
    assert_eq!(
        keys(&snap),
        vec!["codex:codex-healthy-16".to_string()],
        "only the healthy codex rollout is indexed; every quarantine class is excluded"
    );

    // Stable across a settled re-sweep.
    assert!(
        poll_until(&index, SETTLE, |items| items.len() == 1
            && items[0].session_id == "codex-healthy-16")
        .await
        .is_some(),
        "codex quarantine matrix stable across an unchanged re-sweep"
    );
}

/// Clause 3 (codex): a rollout whose `session_meta` line was flushed truncated mid-write
/// becomes indexed WITHOUT restart once the completing bytes land.
#[tokio::test]
async fn codex_partial_record_is_indexed_once_it_becomes_valid() {
    let home = TmpDir::new("codex-becomes-valid");
    let codex_home = home.path().join(".codex");
    let sessions = codex_home.join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();

    write_codex_rollout(
        &sessions,
        "codex-control-16.jsonl",
        &codex_healthy("codex-control-16", "/p/codex-control"),
    );

    // Partial: session_meta line cut mid-write (no trailing newline — the write stopped).
    let meta_line = "{\"timestamp\":\"2026-07-18T09:00:00.000Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"codex-partial-16\",\"cwd\":\"/p/codex-partial\"}}\n";
    let cut = meta_line.len() * 2 / 3;
    let partial_name = "codex-partial-16.jsonl";
    write_codex_rollout(&sessions, partial_name, &meta_line[..cut]);

    let index = mk_index(vec![Arc::new(CodexSource::new(codex_home.clone()))]);
    let snap0 = index.snapshot().await;
    assert_eq!(
        keys(&snap0),
        vec!["codex:codex-control-16".to_string()],
        "truncated session_meta quarantined while invalid"
    );

    // The writer resumes: the remaining bytes of the SAME line land.
    let target = sessions
        .join("2026")
        .join("07")
        .join("18")
        .join(partial_name);
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .open(&target)
        .unwrap();
    use std::io::Write as _;
    f.write_all(meta_line[cut..].as_bytes()).unwrap();
    // A turn follows, as it would in a real rollout.
    f.write_all(b"{\"timestamp\":\"2026-07-18T09:00:01.000Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"resumed codex request\"}]}}\n").unwrap();
    drop(f);

    let settled = poll_until(&index, SETTLE, |items| items.len() == 2)
        .await
        .expect("completed codex rollout becomes indexed without a restart");
    let mut k = keys(&settled);
    k.sort();
    assert_eq!(
        k,
        vec![
            "codex:codex-control-16".to_string(),
            "codex:codex-partial-16".to_string()
        ],
        "exactly one live addition: the completed rollout"
    );
    let completed = settled
        .iter()
        .find(|s| s.session_id == "codex-partial-16")
        .expect("completed record present");
    assert_eq!(completed.cwd.as_deref(), Some("/p/codex-partial"));
}

// ── amplifier ────────────────────────────────────────────────────────────────

/// Amplifier session-dir writers: `<amp_home>/projects/<slug>/sessions/<id>/metadata.json`
/// (+ optional sibling `transcript.jsonl` for the first-user-message preview).
fn write_amplifier_session(amp_home: &Path, id: &str, metadata: &str, transcript: Option<&str>) {
    let dir = amp_home
        .join("projects")
        .join("s16-project")
        .join("sessions")
        .join(id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("metadata.json"), metadata).unwrap();
    if let Some(t) = transcript {
        std::fs::write(dir.join("transcript.jsonl"), t).unwrap();
    }
}

fn amplifier_healthy_metadata(id: &str, working_dir: &str, name: &str) -> String {
    format!(
        "{{\"session_id\":\"{id}\",\"working_dir\":\"{working_dir}\",\"created\":\"2026-08-01T00:00:00.000Z\",\"description_updated_at\":\"2026-08-01T00:00:02.000Z\",\"name\":\"{name}\",\"description\":\"{name} summary\"}}"
    )
}

/// Clause 1+2+3 (amplifier): quarantine classes for the metadata-doc provider, plus the
/// becomes-valid transition when a truncated `metadata.json` is completed (metadata.json
/// is (re)written whole by the provider, so completion = content replace, not append).
#[tokio::test]
async fn amplifier_healthy_survives_quarantined_siblings_and_partial_completes() {
    let home = TmpDir::new("amplifier-matrix");
    let amp_home = home.path().join(".amplifier");

    write_amplifier_session(
        &amp_home,
        "amp-healthy-16",
        &amplifier_healthy_metadata("amp-healthy-16", "/p/amp-healthy", "s16 amplifier healthy"),
        Some("{\"role\":\"user\",\"content\":\"s16 amplifier healthy request\"}\n"),
    );
    // Malformed metadata doc (`parseAmplifierMetadata` -> `{}` -> cwd-less -> skip).
    write_amplifier_session(&amp_home, "amp-malformed-16", "{not json at all", None);
    // Empty metadata doc.
    write_amplifier_session(&amp_home, "amp-empty-16", "", None);
    // Valid doc missing `working_dir` (R10b).
    write_amplifier_session(
        &amp_home,
        "amp-cwdless-16",
        "{\"session_id\":\"amp-cwdless-16\",\"name\":\"no working dir\"}",
        None,
    );
    // Partial: truncated mid-doc.
    let full_partial =
        amplifier_healthy_metadata("amp-partial-16", "/p/amp-partial", "s16 amplifier partial");
    let cut = full_partial.len() * 2 / 3;
    write_amplifier_session(&amp_home, "amp-partial-16", &full_partial[..cut], None);

    let index = mk_index(vec![Arc::new(AmplifierSource::new(amp_home.clone()))]);
    let snap0 = index.snapshot().await;
    assert_eq!(
        keys(&snap0),
        vec!["amplifier:amp-healthy-16".to_string()],
        "only the healthy amplifier session is indexed; malformed/empty/cwd-less/partial quarantined"
    );

    // The provider completes the partial metadata doc with a full rewrite.
    write_amplifier_session(&amp_home, "amp-partial-16", &full_partial, None);
    let settled = poll_until(&index, SETTLE, |items| items.len() == 2)
        .await
        .expect("completed amplifier metadata.json becomes indexed without a restart");
    let mut k = keys(&settled);
    k.sort();
    assert_eq!(
        k,
        vec![
            "amplifier:amp-healthy-16".to_string(),
            "amplifier:amp-partial-16".to_string()
        ],
        "exactly one live addition: the completed amplifier record"
    );
    let completed = settled
        .iter()
        .find(|s| s.session_id == "amp-partial-16")
        .expect("completed record present");
    assert_eq!(completed.cwd.as_deref(), Some("/p/amp-partial"));
}

// ── opencode ─────────────────────────────────────────────────────────────────

/// Build a real (valid) opencode.db with the canonical minimal schema + rows, using a
/// writable connection (same idiom as `tests/opencode_sqlite.rs`).
fn write_opencode_db(db_path: &Path, rows: &[(&str, Option<&str>, &str, i64, i64)]) {
    let conn = rusqlite::Connection::open(db_path).unwrap();
    conn.execute_batch(
        "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
         CREATE TABLE session (
            id TEXT PRIMARY KEY, directory TEXT, title TEXT,
            time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
            project_id TEXT, parent_id TEXT
         );",
    )
    .unwrap();
    for (id, cwd, title, created, updated) in rows {
        match cwd {
            Some(cwd) => conn
                .execute(
                    "INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?1, ?2, ?3, ?4, ?5)",
                    rusqlite::params![id, cwd, title, created, updated],
                )
                .unwrap(),
            None => conn
                .execute(
                    "INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?1, NULL, ?2, ?3, ?4)",
                    rusqlite::params![id, title, created, updated],
                )
                .unwrap(),
        };
    }
    drop(conn);
}

/// Clause 1+2 (opencode, row level): rows the reference's row-mapping tolerates/skips
/// behave identically — a NULL-directory row is quarantined while its healthy sibling in
/// the SAME database stays listed.
#[tokio::test]
async fn opencode_quarantined_rows_do_not_poison_healthy_rows_in_the_same_db() {
    let home = TmpDir::new("oc-rows");
    let data_home = home.path().join("share").join("opencode");
    std::fs::create_dir_all(&data_home).unwrap();
    write_opencode_db(
        &data_home.join("opencode.db"),
        &[
            ("ses_ok", Some("/repo/ok"), "OpenCode healthy", 1000, 5000),
            ("ses_nocwd", None, "OpenCode no-directory row", 2000, 6000),
        ],
    );

    let index = mk_index(vec![Arc::new(OpencodeSource::new(data_home.clone()))]);
    let snap = index.snapshot().await;
    assert_eq!(
        keys(&snap),
        vec!["opencode:ses_ok".to_string()],
        "NULL-directory row quarantined; healthy row listed; no scan failure recorded"
    );
    assert!(index.scan_failures().is_empty());
}

/// Clause 1 (opencode, db level, COLD): a corrupt database at boot is a recorded scan
/// failure with an empty listing — never a silent healthy "no sessions" snapshot.
#[tokio::test]
async fn opencode_corrupt_db_at_cold_boot_records_a_scan_failure_not_a_healthy_empty() {
    let home = TmpDir::new("oc-cold-corrupt");
    let data_home = home.path().join("share").join("opencode");
    std::fs::create_dir_all(&data_home).unwrap();
    std::fs::write(
        data_home.join("opencode.db"),
        b"not a sqlite database, deliberately corrupted",
    )
    .unwrap();

    let index = mk_index(vec![Arc::new(OpencodeSource::new(data_home.clone()))]);
    let snap = index.snapshot().await;
    assert!(snap.is_empty(), "a corrupt db lists nothing");
    assert_eq!(
        index.scan_failures(),
        vec!["opencode".to_string()],
        "the outage is RECORDED (degraded/unsearchable), never presented as healthy-empty"
    );
}

/// Clause 1+3 (opencode, db level, WARM): corrupting the db mid-run (mtime MOVED — the
/// re-query leg, unlike the unchanged-mtime health-check leg already pinned in-crate)
/// preserves the cached sessions AND records the failure; restoring a healthy db clears
/// the failure and re-lists, without a restart.
#[tokio::test]
async fn opencode_corrupt_replace_preserves_sessions_and_healthy_restore_recovers() {
    let home = TmpDir::new("oc-warm-corrupt");
    let data_home = home.path().join("share").join("opencode");
    std::fs::create_dir_all(&data_home).unwrap();
    let db = data_home.join("opencode.db");
    write_opencode_db(&db, &[("ses_a", Some("/repo/a"), "Session A", 1000, 5000)]);

    let index = mk_index(vec![Arc::new(OpencodeSource::new(data_home.clone()))]);
    let snap0 = index.snapshot().await;
    assert_eq!(keys(&snap0), vec!["opencode:ses_a".to_string()]);
    assert!(index.scan_failures().is_empty(), "sanity: healthy at boot");

    // Corrupt the db (content replace moves mtime AND size -> change-token forces a
    // re-query, and the re-query errors on the garbage page).
    tokio::time::sleep(Duration::from_millis(30)).await;
    std::fs::write(&db, b"corrupted to garbage mid-run, no longer sqlite").unwrap();

    // The failure becomes visible within one settled sweep while the cached session is
    // preserved (never a healthy-empty lie, never a dropped corpus).
    let mut saw_failure = false;
    let start = std::time::Instant::now();
    while start.elapsed() < SETTLE {
        let items = index.snapshot().await;
        if index.scan_failures() == vec!["opencode".to_string()] {
            assert_eq!(
                keys(&items),
                vec!["opencode:ses_a".to_string()],
                "cached opencode sessions preserved through the corruption"
            );
            saw_failure = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(saw_failure, "corrupt db is recorded as a scan failure");

    // Restore a healthy db (the provider repaired itself): failure clears, sessions
    // re-list — without a restart. The garbage file must go first: sqlite cannot `CREATE
    // TABLE` over a non-database file.
    tokio::time::sleep(Duration::from_millis(30)).await;
    std::fs::remove_file(&db).unwrap();
    write_opencode_db(&db, &[("ses_a", Some("/repo/a"), "Session A", 1000, 5000)]);
    let mut recovered = false;
    let start = std::time::Instant::now();
    while start.elapsed() < SETTLE {
        let items = index.snapshot().await;
        if index.scan_failures().is_empty() && keys(&items) == vec!["opencode:ses_a".to_string()] {
            recovered = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(
        recovered,
        "restored healthy db clears the failure and re-lists"
    );
}
