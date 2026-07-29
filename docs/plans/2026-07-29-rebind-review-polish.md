# Rebind Review Polish Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Close out the nine minor findings deferred from the independent reviews of PR #567 (`fix/stale-resume-identity`, merged `3968a425`) and PR #568 (`feat/opencode-tui-rebind`, merged `67519888`) — a hygiene/robustness pass with no correctness blockers.

**Architecture:** Eight small, independent fixes across the rebind signal lanes: the claude SessionStart lane gains cross-kind guard parity with codex plus deterministic signal ordering; the injected claude hook nonce becomes POSIX-portable and timestamp-first; the codex fork-ambiguity warn becomes once-per-window; the opencode plugin's `file://` URL gets canonical percent-encoding; the opencode signal sweep gets explicit ignore-with-log + bounded cleanup for foreign/orphaned files; plus two mechanical hygiene items (test-module split, stale doc wording).

**Tech Stack:** Rust (cargo workspace, crates `freshell-platform`, `freshell-ws`, `freshell-sessions`), `tracing`/`tracing-subscriber`, `percent-encoding` 2.x, POSIX `sh`, tokio integration tests.

## Global Constraints

- **NEVER touch the production Rust server on port 3002.** A live drill may be running concurrently against a scratch server on port 3499: do **not** stop/kill any freshell server processes, and do **not** use port 3499 in tests. (The existing integration tests bind ephemeral ports; keep it that way. Audited 2026-07-29, load-bearing pass: all Rust test harnesses bind `127.0.0.1:0`; kills are own-child only; the npm test coordinator gates via a repo-hashed unix socket and signals only its own children — nothing binds 3002/3499 or pattern-kills processes.)
- Red-Green-Refactor TDD for all behavior changes (Tasks 1–3, 5–7). Doc-only changes (Task 8) and pure code-moves (Task 4) are the explicitly named exception per `AGENTS.md:7` ("Red-Green-Refactor TDD for all changes but the most trivial (e.g. doc changes)").
- Do not regress the rebind guarantees: **one-writer invariant, A13, D7/D8, ledger supersede semantics, and the "when unsure, do nothing" degradation policy** must all survive. The portability fix (Task 1) must not weaken nonce uniqueness.
- Rust gates (CI, `-D warnings`): `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo clippy -p freshell-opencode --features real-transport --all-targets -- -D warnings`. Run per task before committing.
- Full workspace tests (`cargo test --workspace`) are local-only (CI runs only `freshell-protocol`); run them in Task 9.
- Coordinated JS test runs only: broad TS runs go through `npm test` (the coordinator gate), never bare vitest. This plan touches no TS source; Task 9 runs the coordinated suite once as regression cover.
- Contract freeze must stay diff-clean: `npm run contract:generate && git diff --exit-code -- port/contract` (Task 9). No task here touches `port/contract`.
- Commits: Conventional Commits with crate scope (e.g. `fix(freshell-ws): ...`). Committer identity must be `Dan Shapiro <3732858+danshapiro@users.noreply.github.com>` (never `dan@danshapiro.com` — GH007).
- Do **NOT** create a PR. Per-task commits on the branch `chore/rebind-review-polish`; the workflow stops after pushing the branch (push is handled by the workflow, not by a task).
- Repo file-size limit: ≤1,000 lines per file (`port/AGENTS.md:82`) — Task 4 exists to honor it.
- README.md is the only end-user markdown doc; everything under `docs/plans/` is a working/agent doc (fine to edit).

## Deferred-items sweep (spec item 9) — decisions

The two committed plan docs (`docs/plans/2026-07-28-stale-resume-identity.md`, `docs/plans/2026-07-28-opencode-tui-rebind.md`) both attest "no silent deferrals"; there is **no repo-level deferred ledger** under `docs/` (per-effort ledgers live outside the repo in `.worktrees/.the-usual-logs/<slug>/`). A full unfiltered sweep found 20 recorded items (D-1…D-20). Decisions:

**Included in this plan:**
- **D-8** (clippy findings deferred to follow-up `fix:` commits — "confirm the gate is green"): closed by Task 9's full gate run; any finding it surfaces gets fixed there.
- The `.tmp` staging-file reap (a secondary bounded-cleanup gap recorded during the #568 review) is folded into Task 7 — it is the same "no unbounded accumulation" requirement as spec item 8.

**Found but explicitly NOT included, with reasons:**
- **D-12** (A2's missing crossTabSync rebind test): verified still missing (`test/unit/client/store/crossTabSync.test.ts` has one post-rebind *state-preservation* test at lines 252–308, none proving rebind orchestration). Excluded: crossTabSync is a client state-sync layer — whether it is *supposed* to orchestrate rebinds (vs. merely preserve rebound refs, which IS tested) is an open design question, and a meaningful new test against the 1,696-line suite is beyond the <30-min bar. Belongs to its own follow-up.
- **D-15** (re-verify the opencode plugin API against the currently installed opencode version) and **D-16** (re-run the mandatory real-opencode smoke): environmental verifications against a live `opencode` binary, not repo changes; no artifact to commit and the binary version on this machine is not this plan's to pin.
- **D-17** (A11: confirm the stacked base branch merged substantially unchanged): a one-time human judgment over merge history, already pinned by git history; no repo change results.
- **D-2** (in-TUI `/resume` to a *different* session is undetectable), **D-3** (A5 rebindable accept key / kitty CSI-u Enter), **D-4** (A6.1/A6.3 windowless-rollout misbind residual — accepted, pinned by test), **D-14** (signal-loss window when a pane dies before the plugin writes), **D-18** (future opencode version drift): accepted design residuals, larger than the <30-min bar and/or unfixable by design.
- **D-5** (future `SESSION_IDENTITY_MISMATCH` emission must be supersession-chain-aware): a recorded constraint on future work, not a task.
- **D-1, D-6, D-7, D-9, D-10, D-11, D-13, D-19, D-20**: recorded rationale, already-closed items, or upstream-owned research — nothing actionable.

## File Structure

| File | Change | Tasks |
|---|---|---|
| `crates/freshell-platform/src/cli_launch.rs` | Portable timestamp-first nonce in `CLAUDE_SESSION_START_COMMAND_UNIX` + new unit tests | 1 |
| `crates/freshell-platform/src/cli_launch_goldens.rs` | Update byte-pinned goldens embedding the old command | 1 |
| `crates/freshell-ws/src/claude_signal.rs` | Sorted drain; new cross-kind live-sidecar guard; unit test | 2, 3 |
| `crates/freshell-ws/tests/claude_session_rebind.rs` | New Phase 4 (live-sidecar refusal) + fake-sidecar harness | 3 |
| `crates/freshell-sessions/src/codex_locator.rs` | Test module replaced by `#[path]` stanza; `ForkWatch.ambiguity_warned` | 4, 5 |
| `crates/freshell-sessions/src/codex_locator_tests.rs` | New sibling test file (moved verbatim) + new warn-once test | 4, 5 |
| `crates/freshell-sessions/Cargo.toml` | Add `tracing-subscriber` dev-dependency | 5 |
| `crates/freshell-platform/Cargo.toml` | Add `percent-encoding = "2"` | 6 |
| `crates/freshell-platform/src/opencode_plugin.rs` | Canonical file-URL encoding + table test | 6 |
| `crates/freshell-ws/src/opencode_signal.rs` | `SignalDisposition` enum, foreign-provider ignore-with-log + consume, `.tmp` reap; unit test | 7 |
| `crates/freshell-ws/tests/opencode_switch_rebind.rs` | New Phase 10 (foreign-provider pane) | 7 |
| `docs/plans/2026-07-28-opencode-tui-rebind.md` | Update the stale pinned URL assertion (historical-note edit) | 6 |
| `docs/plans/2026-07-26-codex-rollout-locator.md` | Fix stale resume-behavior claims | 8 |

All line numbers below were verified on `origin/main` @ `e1f4d4c5` (this worktree's base) on 2026-07-29; re-verify with a quick grep if a file has drifted.

---

### Task 1: Portable, timestamp-first claude SessionStart nonce

Fixes review item 3 (GNU-only `date +%s%N`) and the *producer* half of item 2 (the nonce must sort lexicographically in emission order so Task 2's sorted drain is deterministic — this is exactly the design the opencode plugin already uses in `extensions/opencode/freshell-rebind-plugin.ts:76-79`).

**Files:**
- Modify: `crates/freshell-platform/src/cli_launch.rs:197-211` (doc comment + `CLAUDE_SESSION_START_COMMAND_UNIX`)
- Modify: `crates/freshell-platform/src/cli_launch_goldens.rs` (`CLAUDE_SETTINGS_UNIX` at `:10` and the unix argv goldens `g_c1_claude_linux_fresh_defaults_resolver_level` `:124`, `g_c2_claude_resume_permission_mode_plan` `:144`, `g_c3_claude_start_intent_session_id` `:168` — they embed the settings blob)
- Test: new unit tests in `crates/freshell-platform/src/cli_launch.rs`'s existing `#[cfg(test)] mod tests` (find it with `grep -n "mod tests" crates/freshell-platform/src/cli_launch.rs`)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the new nonce shape `<19-digit zero-stable timestamp>-<pid>` in signal filenames `<terminal_id>__<nonce>.json`. Task 2's sorted drain relies on: digits-and-`-` only (never contains `__`), timestamp-FIRST, fixed 19-digit width (so lexicographic sort == emission order wherever `date` has nanosecond precision; see the fallback-ordering residual below). `CLAUDE_SESSION_START_COMMAND_WINDOWS` is already timestamp-first (`[DateTime]::UtcNow.Ticks`) and is NOT changed.

**Design.** New shell nonce logic (POSIX-portable; GNU nanosecond precision when available, second-granularity zero-padded fallback elsewhere — same effective uniqueness as today's BSD degradation of `$$-<sec>N`, i.e. (second, pid), so uniqueness is NOT weakened):

```sh
n=$(date +%s%N 2>/dev/null); case "$n" in *[!0-9]*|"") n="$(date +%s)000000000";; esac
```

`%s` is 10 digits and `%s%N` 19 digits until year 2286; the fallback pads to 19, so all nonces are width-stable. Nonce becomes `$n-$$` (timestamp first, pid tiebreaker second — the reverse of today's pid-first `$$-$(date +%s%N)`).

**Fallback-ordering residual (validated 2026-07-29, load-bearing pass):** on non-GNU platforms the fallback timestamp is second-granularity, so two signals for the SAME terminal within the SAME second sort by the pid string — not guaranteed emission order (pid wraparound and digit-length boundaries both invert it). This is a documented residual, not a defect to fix here: it is strictly better than today's pid-first nonce (never time-ordered on ANY platform), it self-corrects on the next signal, and the alternatives fail (zero-padding `$$` fixes only the digit-length case, not wraparound; a per-invocation sequence is infeasible across separate `sh` processes — the opencode plugin's `seq` works only because it is one long-lived process). All doc-comment and commit wording below is scoped accordingly — keep it that way.

- [ ] **Step 1: Write the failing unit tests**

In `crates/freshell-platform/src/cli_launch.rs`'s `#[cfg(test)] mod tests`, add (adjust the `use super::*;` context to match the module's existing tests):

```rust
    /// Single source of truth for the portable nonce logic embedded in
    /// CLAUDE_SESSION_START_COMMAND_UNIX; the contains() test below keeps
    /// the two in sync so the executable tests exercise the real snippet.
    const CLAUDE_SIGNAL_NONCE_SNIPPET: &str =
        "n=$(date +%s%N 2>/dev/null); case \"$n\" in *[!0-9]*|\"\") n=\"$(date +%s)000000000\";; esac";

    #[test]
    fn session_start_command_embeds_the_portable_nonce_snippet() {
        assert!(
            CLAUDE_SESSION_START_COMMAND_UNIX.contains(CLAUDE_SIGNAL_NONCE_SNIPPET),
            "the unix SessionStart hook must build its nonce with the portable snippet"
        );
        assert!(
            !CLAUDE_SESSION_START_COMMAND_UNIX.contains("__$$-"),
            "nonce must be timestamp-first (pid last), not pid-first"
        );
    }

    /// BSD/macOS `date` has no %N: it echoes a literal `N`. The snippet must
    /// detect that and fall back to a zero-padded, digits-only nonce so the
    /// consumer's filename sort stays correct on every platform.
    #[cfg(unix)]
    #[test]
    fn nonce_snippet_is_all_digits_even_without_gnu_date() {
        let dir = std::env::temp_dir().join(format!(
            "freshell-bsd-date-stub-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let stub = dir.join("date");
        std::fs::write(
            &stub,
            "#!/bin/sh\nif [ \"$1\" = \"+%s%N\" ]; then echo 1769000000N; else echo 1769000000; fi\n",
        )
        .unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!(
                "PATH=\"{}:$PATH\"; {}; printf %s \"$n\"",
                dir.display(),
                CLAUDE_SIGNAL_NONCE_SNIPPET
            ))
            .output()
            .unwrap();
        let n = String::from_utf8(out.stdout).unwrap();
        assert_eq!(n, "1769000000000000000", "BSD fallback: seconds + 9 zero digits");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// GNU date passthrough: full nanosecond precision is preserved.
    #[cfg(unix)]
    #[test]
    fn nonce_snippet_preserves_gnu_precision() {
        let dir = std::env::temp_dir().join(format!(
            "freshell-gnu-date-stub-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let stub = dir.join("date");
        std::fs::write(
            &stub,
            "#!/bin/sh\nif [ \"$1\" = \"+%s%N\" ]; then echo 1769000000123456789; else echo 1769000000; fi\n",
        )
        .unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!(
                "PATH=\"{}:$PATH\"; {}; printf %s \"$n\"",
                dir.display(),
                CLAUDE_SIGNAL_NONCE_SNIPPET
            ))
            .output()
            .unwrap();
        assert_eq!(String::from_utf8(out.stdout).unwrap(), "1769000000123456789");
        let _ = std::fs::remove_dir_all(&dir);
    }
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cargo test -p freshell-platform --lib cli_launch`
Expected: FAIL — `session_start_command_embeds_the_portable_nonce_snippet` fails (current constant has neither the snippet nor a timestamp-first nonce). The two snippet-execution tests PASS already (they test the snippet itself); that is fine — the contains() test is the RED link binding snippet to constant.

- [ ] **Step 3: Update the byte-pinned goldens to the NEW intended bytes (second RED)**

In `crates/freshell-platform/src/cli_launch_goldens.rs`, in `CLAUDE_SETTINGS_UNIX` (`:10`) and in `g_c1`/`g_c2`/`g_c3` (every literal that embeds the unix settings blob — verify the full set with `grep -n 'date +%s%N' crates/freshell-platform/src/cli_launch_goldens.rs`), replace the old shell fragment

```
f="$d/${FRESHELL_TERMINAL_ID:-unknown}__$$-$(date +%s%N)"
```

with the new fragment

```
n=$(date +%s%N 2>/dev/null); case "$n" in *[!0-9]*|"") n="$(date +%s)000000000";; esac; f="$d/${FRESHELL_TERMINAL_ID:-unknown}__$n-$$"
```

**preserving each literal's existing escaping style** (the goldens store the JSON-encoded form of the command, so `"` appears as `\"` or `\\\"` depending on nesting — mirror exactly how the surrounding old bytes escape `$d`'s quotes). `g_c4_claude_native_windows_target` embeds the Windows settings and must NOT change (the grep above should not match it).

Run: `cargo test -p freshell-platform --lib cli_argv_goldens_file`
Expected: FAIL — `claude_settings_json_bytes_are_pinned` (and g_c1–g_c3) now pin the new bytes while the constant still produces the old ones. (The goldens file is mounted inside `cli_launch.rs` as `#[path = "cli_launch_goldens.rs"] mod cli_argv_goldens_file;`, so the test paths are `cli_launch::cli_argv_goldens_file::...` — the filter must be `cli_argv_goldens_file`, not the file name.)

- [ ] **Step 4: Change the constant (GREEN)**

In `crates/freshell-platform/src/cli_launch.rs:211`, change `CLAUDE_SESSION_START_COMMAND_UNIX` to:

```rust
pub const CLAUDE_SESSION_START_COMMAND_UNIX: &str = "sh -lc 'd=\"$HOME/.freshell/session-signals/claude\"; n=$(date +%s%N 2>/dev/null); case \"$n\" in *[!0-9]*|\"\") n=\"$(date +%s)000000000\";; esac; f=\"$d/${FRESHELL_TERMINAL_ID:-unknown}__$n-$$\"; mkdir -p \"$d\" && cat > \"$f.tmp\" && mv \"$f.tmp\" \"$f.json\"' 2>/dev/null || true";
```

Extend the doc comment above it (keep every existing sentence — the A7 degradation notes are load-bearing) with:

```rust
/// Nonce portability + ordering contract: `%N` is GNU-only (BSD/macOS echo a
/// literal `N`), so the nonce is built via a POSIX fallback -- timestamp
/// FIRST (19 digits, zero-stable width; second-granularity where %N is
/// unavailable), shell pid as tiebreaker. Digits and `-` only, so it can
/// never contain the `__` filename delimiter, and a lexicographic filename
/// sort in the consumer (`claude_signal.rs::drain`) is emission order on
/// nanosecond-precision `date` (GNU) -- deterministic last-write-wins under
/// rapid A->B->A switching. On the second-granularity fallback, same-second
/// same-terminal order degrades to pid-string order (not guaranteed emission
/// order) -- a residual sub-second ambiguity, corrected by the next signal.
```

- [ ] **Step 5: Run the full crate tests to verify they pass**

Run: `cargo test -p freshell-platform`
Expected: PASS (all, including the goldens and the three new tests).

- [ ] **Step 6: Gates and commit**

```bash
cargo fmt --all
cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings
git add crates/freshell-platform/src/cli_launch.rs crates/freshell-platform/src/cli_launch_goldens.rs
git commit -m "fix(freshell-platform): portable timestamp-first claude SessionStart nonce

date +%s%N is GNU-only; BSD/macOS degraded the nonce to a literal N and
made the timestamp useless for ordering. POSIX fallback keeps 19-digit
width-stable digits-only nonces, timestamp-first so the consumer's
filename sort (next commit) is emission order on GNU date (on the
second-granularity fallback, same-second order degrades to pid order --
documented residual, self-correcting). Uniqueness is preserved:
GNU keeps ns precision; elsewhere (second, pid) -- same as before."
```

---

### Task 2: Deterministic claude signal drain (sorted, oldest-first, last-write-wins)

Fixes review item 2 (consumer half): `ClaudeSignalWatcher::drain` enumerates with bare `read_dir` (OS hash order), so rapid A→B→A switching within one 1s sweep applies rebinds in nondeterministic order. Mirror the opencode lane (`crates/freshell-ws/src/opencode_signal.rs:96` already does `paths.sort()`).

**Files:**
- Modify: `crates/freshell-ws/src/claude_signal.rs:77-93` (`drain`) and its doc comment `:68-76`
- Test: the in-file `#[cfg(test)] mod tests` in the same file (existing test `drain_parses_and_deletes_signal_files` at `:238-268` shows the module's temp-dir and constructor idiom — mirror it)

**Interfaces:**
- Consumes: Task 1's nonce shape guarantee (timestamp-first, width-stable, digits-and-`-`). The sort is still correct-by-filename for the test nonces below regardless.
- Produces: `pub fn drain(&self) -> Vec<ClaudeSignal>` (signature unchanged) now returns signals sorted by filename ascending (oldest first). `drain_and_rebind_claude` applies them in sequence, so the newest signal per terminal wins deterministically. Task 3 relies on nothing here.

- [ ] **Step 1: Write the failing test**

Add to `claude_signal.rs`'s `mod tests` (mirror the existing test's watcher construction — the same way `drain_parses_and_deletes_signal_files` builds it from a root path):

```rust
    #[test]
    fn drain_returns_signals_sorted_by_filename_oldest_first() {
        let root = std::env::temp_dir().join(format!(
            "freshell-claude-sig-order-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        // Timestamp-first nonces (Task 1 shape). Written in REVERSE of
        // emission order so read_dir/creation order cannot fake a pass.
        let emissions = [
            ("1769000000000000001-11", "aaaaaaaa-0000-4000-8000-000000000001"),
            ("1769000000000000002-11", "aaaaaaaa-0000-4000-8000-000000000002"),
            ("1769000000000000003-99", "aaaaaaaa-0000-4000-8000-000000000003"),
            ("1769000000000000004-42", "aaaaaaaa-0000-4000-8000-000000000004"),
            ("1769000000000000005-42", "aaaaaaaa-0000-4000-8000-000000000005"),
            ("1769000000000000006-07", "aaaaaaaa-0000-4000-8000-000000000006"),
        ];
        for (nonce, sid) in emissions.iter().rev() {
            std::fs::write(
                root.join(format!("t1__{nonce}.json")),
                format!(r#"{{"session_id":"{sid}","source":"resume"}}"#),
            )
            .unwrap();
        }
        let watcher = ClaudeSignalWatcher::new(root.clone());
        let signals = watcher.drain();
        let got: Vec<&str> = signals.iter().map(|s| s.session_id.as_str()).collect();
        let want: Vec<&str> = emissions.iter().map(|(_, sid)| *sid).collect();
        assert_eq!(got, want, "drain must be filename-sorted (emission order)");
        // Existing delete-on-read semantics are unchanged.
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&root);
    }
```

(If the module's watcher constructor is not literally `ClaudeSignalWatcher::new(root)`, use whatever `drain_parses_and_deletes_signal_files` uses — the construction idiom two tests above it is the source of truth.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p freshell-ws --lib claude_signal`
Expected: FAIL on the order assertion (with 6 files, hash-order enumeration virtually never matches). If it passes by fluke, re-run once — an unsorted `read_dir` cannot pass repeatedly; then proceed.

- [ ] **Step 3: Implement the sorted drain**

Replace the body of `drain` (`claude_signal.rs:77-93`) with:

```rust
    pub fn drain(&self) -> Vec<ClaudeSignal> {
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return Vec::new(); // no dir yet: no claude pane has ever signaled
        };
        let mut paths: Vec<std::path::PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
            .collect();
        // Deterministic last-write-wins (mirrors opencode_signal.rs): the
        // producer nonce is timestamp-first and width-stable, so a filename
        // sort is emission order on nanosecond-precision `date` (GNU; on the
        // second-granularity fallback, same-second order degrades to pid
        // order -- see the producer's doc comment); the consumer applies
        // signals in sequence, so the newest signal per terminal wins.
        paths.sort();
        let mut signals = Vec::new();
        for path in paths {
            if let Some(sig) = parse_signal_file(&path) {
                signals.push(sig);
            }
            let _ = std::fs::remove_file(&path);
        }
        signals
    }
```

Append one line to the doc comment at `:68-76`: `/// drain() sorts by filename (timestamp-first nonces => deterministic last-write-wins under rapid A->B->A switching on nanosecond-precision date; the second-granularity fallback degrades same-second order to pid order).`

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-ws --lib claude_signal && cargo test -p freshell-ws --test claude_session_rebind`
Expected: PASS (unit + the existing 3-phase integration test).

- [ ] **Step 5: Gates and commit**

```bash
cargo fmt --all
cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings
git add crates/freshell-ws/src/claude_signal.rs
git commit -m "fix(freshell-ws): sort claude signal drain for deterministic last-write-wins

Bare read_dir order made rapid A->B->A switches within one sweep window
land nondeterministically. Filename sort over the timestamp-first nonces
(previous commit) makes drain order emission order on GNU date (the
second-granularity fallback degrades same-second order to pid order --
documented residual), matching the opencode lane's already-shipped
contract."
```

---

### Task 3: Claude guard-chain parity — live freshclaude sidecar check (D7 cross-kind)

Fixes review item 1. The claude SessionStart rebind lane (`drain_and_rebind_claude`, `crates/freshell-ws/src/claude_signal.rs:127`, guards at `:143-186`) has the A13 live-PTY check and the *durable ledger-row* fresh-agent check, but is missing the **in-memory live-sidecar session-map probe** that codex has at `crates/freshell-ws/src/codex_identity.rs:159` (`state.fresh_codex.has_live_session(...)`). A freshclaude sidecar with an open session on S whose ledger row hasn't landed yet is invisible — a racy/forged signal could move a terminal pane onto a JSONL a live sidecar is writing (one-writer violation).

Do NOT touch the lane's other documented deviation (no positive D7 old-owner predicate — that is deliberate and documented at `opencode_signal.rs:149-153`: the producer is per-terminal by construction).

**Files:**
- Modify: `crates/freshell-ws/src/claude_signal.rs` (insert one guard immediately BEFORE the existing `pane_ledger` fresh-agent guard at `:180`, keeping the two fresh-agent probes adjacent exactly as codex's `codex_claim_refused` does)
- Modify + Test: `crates/freshell-ws/tests/claude_session_rebind.rs` (harness tweak + new Phase 4)

**Interfaces:**
- Consumes: `pub async fn has_live_session(&self, session_id: &str) -> bool` on `FreshClaudeState` (`crates/freshell-freshagent/src/claude.rs:707`), reached via `state.fresh_claude` (`crates/freshell-ws/src/lib.rs:118`). Call-shape precedent: `crates/freshell-ws/src/terminal.rs:1716-1736` (Task 13b cross-kind liveness).
- Produces: nothing other tasks consume.

- [ ] **Step 1: Enable fresh-agent creates in the test harness**

In `crates/freshell-ws/tests/claude_session_rebind.rs`'s `spawn_server_returning_state` (`:116`), the `FreshCodexState::new(...)` call is seeded with `serde_json::json!({ "freshAgent": { "enabled": false } })`. Flip that literal to `{ "freshAgent": { "enabled": true } }` — the WS dispatch gate for ALL fresh-agent providers is `state.fresh_codex.is_enabled()` (`terminal.rs:675`), so with `false` a `freshAgent.create` is silently dropped and the sidecar never spawns.

- [ ] **Step 2: Add the fake-sidecar harness to the test file**

Add near the other helpers (this file is `#[cfg(unix)]` and its single test fn owns process env, so no env lock is needed). Donor: `crates/freshell-ws/tests/pane_reconcile_freshagent.rs:63-145` uses this exact shape.

```rust
/// Minimal fake claude sidecar speaking the newline-JSON protocol: answers
/// `create` with `created` + `sdk.session.init` (echoing resumeSessionId as
/// the durable cliSessionId), exits on `shutdown`.
const FAKE_CLAUDE_SIDECAR_SOURCE: &str = r#"import readline from 'node:readline'

let counter = 0
const rl = readline.createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return
  }
  if (msg.type === 'create') {
    counter += 1
    const sessionId = `fake-claude-session-${process.pid}-${counter}`
    process.stdout.write(JSON.stringify({ type: 'created', requestId: msg.requestId, sessionId }) + '\n')
    const cliSessionId = msg.resumeSessionId || 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    process.stdout.write(JSON.stringify({ type: 'sdk.session.init', sessionId, cliSessionId, model: 'fake-model', cwd: '/tmp', tools: [] }) + '\n')
    process.stdout.write(JSON.stringify({ type: 'sdk.status', sessionId, status: 'idle' }) + '\n')
  } else if (msg.type === 'shutdown') {
    process.exit(0)
  }
})
"#;

struct FakeClaudeEnv {
    dir: std::path::PathBuf,
}
impl FakeClaudeEnv {
    fn install() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "freshell-fake-claude-rebind-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create fake sidecar temp dir");
        let script = dir.join("fake-claude-sidecar.mjs");
        std::fs::write(&script, FAKE_CLAUDE_SIDECAR_SOURCE).expect("write fake sidecar");
        let store = dir.join("claude-store");
        std::fs::create_dir_all(&store).expect("create claude store dir");
        std::env::set_var("FRESHELL_CLAUDE_SIDECAR", &script);
        std::env::set_var("FRESHELL_CLAUDE_NODE", "node");
        std::env::set_var("CLAUDE_CONFIG_DIR", &store);
        Self { dir }
    }
}
impl Drop for FakeClaudeEnv {
    fn drop(&mut self) {
        std::env::remove_var("FRESHELL_CLAUDE_SIDECAR");
        std::env::remove_var("FRESHELL_CLAUDE_NODE");
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
```

- [ ] **Step 3: Write the failing Phase 4 at the end of the single test fn**

Append after Phase 3 (`:370-430`), reusing the fn's in-scope `state`, `registry`, `ws`, `signal_root`, and helpers (`send_create` `:249`, `frame_seen_within` `:222`, `registry_resume_id` `:99`). Create the fourth pane exactly the way Phase 1 creates its pane (same `send_create` body shape with a fresh terminal id and a fresh session id `D`); then:

```rust
    // ---- Phase 4: cross-kind (D7) -- a signal claiming a session owned by a
    // LIVE freshclaude sidecar must NOT move the pane (the ledger-row guard
    // is blind to a sidecar whose durable row hasn't landed; this phase
    // proves the in-memory session-map probe covers that window).
    let _fake_env = FakeClaudeEnv::install();
    let sidecar_sid = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        serde_json::json!({
            "type": "freshAgent.create",
            "requestId": "req-live-owner",
            "sessionType": "freshclaude",
            "provider": "claude",
            "cwd": "/tmp",
            "resumeSessionId": sidecar_sid,
            "sessionRef": { "provider": "claude", "sessionId": sidecar_sid },
        })
        .to_string(),
    ))
    .await
    .expect("send freshAgent.create");
    assert!(
        frame_seen_within(&mut ws, std::time::Duration::from_secs(15), |v| {
            v["type"] == "freshAgent.created" && v["requestId"] == "req-live-owner"
        })
        .await,
        "fake sidecar must come live"
    );
    // The resume path inserts cli_index[S] synchronously before `created`
    // (claude.rs:436), so the probe is authoritative now:
    assert!(state.fresh_claude.has_live_session(sidecar_sid).await);

    // Forge a SessionStart signal from the phase-4 pane claiming the
    // sidecar-owned session.
    std::fs::write(
        signal_root.join(format!("{tid4}__1769000000000000009-1.json")),
        format!(r#"{{"session_id":"{sidecar_sid}","source":"resume"}}"#),
    )
    .unwrap();
    drain_and_rebind_claude(&state, &watcher).await;

    // Refusal proof: the pane's identity did not move...
    assert_ne!(
        registry_resume_id(&registry, &tid4).as_deref(),
        Some(sidecar_sid),
        "a live-sidecar-owned session must never be claimed by a terminal pane"
    );
    // ...no association frame was emitted for it...
    assert!(
        !frame_seen_within(&mut ws, std::time::Duration::from_secs(2), |v| {
            v["type"] == "terminal.session.associated"
                && v["terminalId"] == tid4.as_str()
                && v["sessionRef"]["sessionId"] == sidecar_sid
        })
        .await,
        "no rebind frame may be emitted for a refused claim"
    );
    // ...and the refused signal file was still consumed (delete-on-read).
    assert!(!signal_root
        .join(format!("{tid4}__1769000000000000009-1.json"))
        .exists());

    state.fresh_claude.shutdown().await; // reap the fake node child
```

Mirror Phase 3's exact idioms for anything above that differs in this file (frame matching field names, how `watcher`/`signal_root` are named, `ws` send helper if one exists) — Phase 3 (`:370-430`) is the A13 twin of this phase and is the authoritative donor.

- [ ] **Step 4: Run to verify it fails**

Run: `cargo test -p freshell-ws --test claude_session_rebind`
Expected: FAIL — the forged signal passes every existing guard (A13 sees no live *PTY* owner; this harness's pane ledger is `PaneLedger::disabled()` so the ledger-row guard is inert; the sidecar's row is in no identity store) and the pane rebinds; the `assert_ne!` trips. **Contingency:** if the phase unexpectedly PASSES before the fix, find which guard refused (each refusal has a distinct `tracing::warn!` message — run with `--nocapture`); if the harness wires an identity sink that records sidecar sessions (making `find_by_session_including_retired` catch it), the live-map window this task closes is still real in production — keep the phase, and make it RED by asserting the refusal happens for the *right reason* is not needed; instead remove/disable the sink wiring for this harness so the test isolates the live-map probe.

- [ ] **Step 5: Implement the guard**

In `crates/freshell-ws/src/claude_signal.rs`, inside `drain_and_rebind_claude`'s guard chain, immediately BEFORE the `pane_ledger.lookup_by_session(...)` fresh-agent guard (`:180`), insert:

```rust
        // Cross-kind (D7): a LIVE freshclaude sidecar owning this session is
        // just as much "the one writer on S's JSONL" as a live PTY. The
        // durable ledger guard below is blind to a sidecar whose row hasn't
        // landed yet. Mirrors codex_claim_refused (codex_identity.rs:159).
        if state.fresh_claude.has_live_session(&sig.session_id).await {
            tracing::warn!(terminal_id = %sig.terminal_id, session_id = %sig.session_id,
                "claude_rebind_refused: freshagent_live_session");
            continue;
        }
```

- [ ] **Step 6: Run to verify it passes**

Run: `cargo test -p freshell-ws --test claude_session_rebind && cargo test -p freshell-ws --test cross_kind_liveness && cargo test -p freshell-ws --lib claude_signal`
Expected: PASS (all four phases + the cross-kind precedent suite unaffected).

- [ ] **Step 7: Gates and commit**

```bash
cargo fmt --all
cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings
git add crates/freshell-ws/src/claude_signal.rs crates/freshell-ws/tests/claude_session_rebind.rs
git commit -m "fix(freshell-ws): claude rebind lane checks live freshclaude sidecar map (D7 parity)

The codex lane probes fresh_codex.has_live_session before honoring a
claim; the claude lane only had the durable fresh-agent ledger-row twin,
leaving a window where a sidecar with an unlanded row was invisible.
Adds the in-memory probe in the same guard position codex uses."
```

---

### Task 4: Split `codex_locator.rs`'s in-file test module into a sibling file

Fixes review item 5 (repo testing convention + the ≤1K-lines limit; the file is 1,655 lines, 941 of which are the test module). Pure code-move, no behavior change — the existing 34 tests are the regression proof (TDD red/green does not apply per `AGENTS.md:7`). **Do this before Task 5**, whose new test lands in the new sibling file.

The tests use private items (`fn probe_rollout` `:639`, `enum Probe` `:606`), which is exactly why the repo convention is a `#[path]`-included **child module** (still sees privates via `use super::*;`), NOT the `tests/` integration dir (external crate, `pub`-only — blocked). Convention donors: `crates/freshell-ws/src/pane_ledger.rs:950-952`, `crates/freshell-server/src/tabs_snapshots.rs:146-148`, and 5 more `*_tests.rs` siblings.

**Files:**
- Modify: `crates/freshell-sessions/src/codex_locator.rs` (lines 715–1655)
- Create: `crates/freshell-sessions/src/codex_locator_tests.rs`

**Interfaces:**
- Consumes: nothing.
- Produces: `crates/freshell-sessions/src/codex_locator_tests.rs` — the module Task 5 adds its test to. Test helpers that move with it and that Task 5 uses: `unique_temp_dir(label: &str) -> PathBuf`, `write_rollout_full(root: &Path, rel_dir: &str, thread_id: &str, cwd: Option<&str>, forked_from: Option<&str>, thread_source: Option<&str>) -> PathBuf`, `const TID: &str = "11111111-2222-3333-4444-555555555555";`.

- [ ] **Step 1: Record the baseline**

Run: `cargo test -p freshell-sessions --lib codex_locator 2>&1 | tail -3`
Expected: `test result: ok. 34 passed` (note the exact count).

- [ ] **Step 2: Move the module body**

Create `crates/freshell-sessions/src/codex_locator_tests.rs` containing:

```rust
//! Unit tests for `crate::codex_locator`. Kept in a sibling file (the
//! `pane_ledger_tests.rs` convention: a `#[path]`-included child module) to
//! respect the repo's <=1K-lines file limit; `use super::*` still reaches
//! the parent's private items (`probe_rollout`, `Probe`).
```

followed by the CONTENTS of the `mod tests { ... }` block moved verbatim: everything between the `mod tests {` line (716) and its closing `}` (1655) — i.e. lines 717–1654, starting with `use super::*;` — with one level of indentation removed (the file body IS the module body now; `cargo fmt` in Step 4 normalizes any residue).

Then in `codex_locator.rs`, replace lines 715–1655 (from `#[cfg(test)]` through the final `}`) with exactly:

```rust
#[cfg(test)]
#[path = "codex_locator_tests.rs"]
mod tests;
```

- [ ] **Step 3: Verify the move is complete and clean**

Run: `wc -l crates/freshell-sessions/src/codex_locator.rs crates/freshell-sessions/src/codex_locator_tests.rs`
Expected: parent ~718 lines, sibling ~945 — both under 1,000.

- [ ] **Step 4: Run the tests — identical count, all green**

```bash
cargo fmt --all
cargo test -p freshell-sessions --lib codex_locator 2>&1 | tail -3
```
Expected: `test result: ok. 34 passed` — the same count as Step 1. Any drop means a test was lost in the move: diff and fix.

- [ ] **Step 5: Gates and commit**

```bash
cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings
git add crates/freshell-sessions/src/codex_locator.rs crates/freshell-sessions/src/codex_locator_tests.rs
git commit -m "refactor(freshell-sessions): split codex_locator tests into sibling file

Pure code-move to the repo's #[path]-included child-module convention
(pane_ledger_tests.rs et al.); both files now respect the <=1K-line
limit and the tests keep private-item access. 34 tests before and after."
```

---

### Task 5: Fork-ambiguity warn fires once per window, not once per tick

Fixes review item 4. `tick_forks`'s `n =>` ambiguity arm (`crates/freshell-sessions/src/codex_locator.rs:561-564` pre-split; find it post-split with `grep -n codex_fork_ambiguous crates/freshell-sessions/src/codex_locator.rs`) neither clears `window_until_ms` nor merges hits into `known_files` — **deliberately** (merging would permanently exclude a file that might become the sole candidate later; refusal-until-window-close is the "when unsure, do nothing" policy and MUST NOT change). But the warn re-fires every sweep tick for the whole window. Fix is **log-only**: a `warned` latch on the per-terminal `ForkWatch`, reset when a new window opens.

**Files:**
- Modify: `crates/freshell-sessions/src/codex_locator.rs` (`struct ForkWatch` `:176-183`; its single construction site `watch_fork` `:466-481`; `note_fork_submit` `:485-492`; the `n =>` arm)
- Modify: `crates/freshell-sessions/Cargo.toml` (add dev-dependency)
- Test: `crates/freshell-sessions/src/codex_locator_tests.rs` (from Task 4)

**Interfaces:**
- Consumes: Task 4's sibling test file and its helpers (`unique_temp_dir`, `write_rollout_full`, `TID` — signatures listed in Task 4's Produces block).
- Produces: private field `ForkWatch.ambiguity_warned: bool`. No public API change.

- [ ] **Step 1: Add the dev-dependency**

In `crates/freshell-sessions/Cargo.toml`, add (create the section if absent):

```toml
[dev-dependencies]
tracing-subscriber = "0.3"
```

- [ ] **Step 2: Write the failing test**

In `crates/freshell-sessions/src/codex_locator_tests.rs`, add:

```rust
    /// Log-capture layer counting WARN events whose fields mention a needle.
    struct WarnCounter {
        hits: std::sync::Arc<AtomicU64>,
        needle: &'static str,
    }
    impl<S: tracing::Subscriber> tracing_subscriber::layer::Layer<S> for WarnCounter {
        fn on_event(
            &self,
            event: &tracing::Event<'_>,
            _ctx: tracing_subscriber::layer::Context<'_, S>,
        ) {
            struct Buf(String);
            impl tracing::field::Visit for Buf {
                fn record_debug(
                    &mut self,
                    _f: &tracing::field::Field,
                    v: &dyn std::fmt::Debug,
                ) {
                    self.0.push_str(&format!("{v:?}"));
                }
            }
            let mut buf = Buf(String::new());
            event.record(&mut buf);
            if event.metadata().level() == &tracing::Level::WARN && buf.0.contains(self.needle) {
                self.hits.fetch_add(1, Ordering::SeqCst);
            }
        }
    }

    #[test]
    fn ambiguous_fork_warns_once_per_window_and_rearms_on_new_submit() {
        use tracing_subscriber::layer::SubscriberExt;
        const TID2: &str = "22222222-3333-4444-5555-666666666666";
        let hits = std::sync::Arc::new(AtomicU64::new(0));
        let subscriber = tracing_subscriber::registry().with(WarnCounter {
            hits: std::sync::Arc::clone(&hits),
            needle: "codex_fork_ambiguous",
        });
        // Thread-local: tick_forks runs on this thread, so the counter sees
        // exactly this test's events even under parallel test execution.
        let _guard = tracing::subscriber::set_default(subscriber);

        let root = unique_temp_dir("fork-ambiguity-warn-once");
        let locator = CodexLocator::new(root.clone());
        assert!(locator.watch_fork("t1", "aaaa-old"));
        assert!(locator.note_fork_submit("t1", 1_000));
        // TWO user forks of the same parent in one window -> ambiguous.
        write_rollout_full(&root, "2026/07/29", TID, Some("/tmp/x"), Some("aaaa-old"), Some("user"));
        write_rollout_full(&root, "2026/07/29", TID2, Some("/tmp/x"), Some("aaaa-old"), Some("user"));
        // Refusal semantics are unchanged on EVERY tick of the window...
        assert!(locator.tick_forks(1_100).is_empty());
        assert!(locator.tick_forks(1_200).is_empty());
        assert!(locator.tick_forks(1_300).is_empty());
        // ...but the warn fires once, not once per tick.
        assert_eq!(hits.load(Ordering::SeqCst), 1, "one warn per ambiguity window");
        // A NEW Enter opens a new window: the condition is fresh -> warn again.
        assert!(locator.note_fork_submit("t1", 5_000));
        assert!(locator.tick_forks(5_100).is_empty());
        assert_eq!(hits.load(Ordering::SeqCst), 2, "a new window re-arms the warn");
        let _ = std::fs::remove_dir_all(&root);
    }
```

(The file already has `use std::sync::atomic::{AtomicU64, Ordering};` from its counter helper; reuse it.)

- [ ] **Step 3: Run to verify it fails**

Run: `cargo test -p freshell-sessions --lib codex_locator 2>&1 | grep -A2 warns_once`
Expected: FAIL — `hits == 3` after three ticks (one warn per tick today).

- [ ] **Step 4: Implement the latch**

In `crates/freshell-sessions/src/codex_locator.rs`:

1. Add to `struct ForkWatch`:
```rust
    /// Latch: the >=2-candidate ambiguity warn fired for the CURRENT window.
    /// Log-only state -- refusal semantics never depend on it. Reset when a
    /// new window opens (note_fork_submit).
    ambiguity_warned: bool,
```
2. In `watch_fork`'s `ForkWatch { ... }` literal (the struct's only construction site), add `ambiguity_warned: false,`.
3. In `note_fork_submit`, where the watch's window is (re)opened (`window_until_ms` is set), also set `watch.ambiguity_warned = false;`.
4. Replace the `n =>` arm of `tick_forks`:
```rust
                n => {
                    if !watch.ambiguity_warned {
                        watch.ambiguity_warned = true;
                        tracing::warn!(terminal_id = %terminal_id, candidates = n,
                            "codex_fork_ambiguous: multiple forks of one session in one window; refusing (silent for the rest of this window)");
                    }
                }
```
Do NOT touch `window_until_ms` or `known_files` in this arm (the refusal-until-window-close behavior is load-bearing).

- [ ] **Step 5: Run to verify it passes**

Run: `cargo test -p freshell-sessions --lib codex_locator && cargo test -p freshell-ws --test codex_fork_rebind`
Expected: PASS — 35 unit tests (34 + new) and the fork integration suite unaffected.

- [ ] **Step 6: Gates and commit**

```bash
cargo fmt --all
cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings
git add crates/freshell-sessions/src/codex_locator.rs crates/freshell-sessions/src/codex_locator_tests.rs crates/freshell-sessions/Cargo.toml Cargo.lock
git commit -m "fix(freshell-sessions): rate-limit codex fork-ambiguity warn to once per window

The n>=2 refusal arm re-warned on every sweep tick for the whole fork
window. Adds a log-only latch on ForkWatch, re-armed by a new Enter
(note_fork_submit); refusal semantics and the deliberate no-merge of
ambiguous hits are unchanged."
```

---

### Task 6: Canonical percent-encoded `file://` plugin URL

Fixes review item 7. `plugin_file_spec` (`crates/freshell-platform/src/opencode_plugin.rs:32-39`) builds the URL with a raw `format!` — a home dir containing `#`/`?` truncates the path, `%`+hex silently decodes to the wrong path (Bun's `import()` then hard-fails **silently for the pane lifetime** — it caches failed imports), and space/non-ASCII break opencode's dedup-by-file-URL contract. Correct target: byte-identity with `pathToFileURL(p).href` as produced by opencode's own runtime — **oracle-verified 2026-07-29 (load-bearing pass) on the installed Bun 1.3.14 and Node v22.21.1, which agree byte-for-byte on posix paths**; opencode dedupes plugin entries by exact spec-string equality, so parity is load-bearing. Note this set is STRICTER than the WHATWG-minimal path set: `[ \ ] ^ | ~` are percent-encoded too, and a posix `\` is an ordinary byte to encode (%5C), never a separator. Use `percent-encoding` (2.3.2 is already in `Cargo.lock` — no new transitive tree; the full `url` crate is heavier than this crate's "pure std + injected IO" posture needs).

**Files:**
- Modify: `crates/freshell-platform/Cargo.toml` (add `percent-encoding = "2"`; amend the "no external crates" header comment if one exists there)
- Modify: `crates/freshell-platform/src/opencode_plugin.rs` (fn + doc + the pinning test at `:141-147`)
- Modify: `docs/plans/2026-07-28-opencode-tui-rebind.md:481` (the historical plan doc pins the buggy assertion — annotate it)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `pub fn plugin_file_spec(plugin_path: &Path) -> String` (signature unchanged) now returns canonical WHATWG file URLs. Sole caller `tui_config_content` (`:46`) is unchanged.

- [ ] **Step 1: Rewrite the pinning test into the failing table test**

Replace `file_spec_is_a_file_url` (`opencode_plugin.rs:141-147`) with:

```rust
    #[test]
    fn file_spec_is_a_canonical_file_url() {
        // Expected values match `pathToFileURL(p).href` under BOTH Node v22
        // and Bun 1.3.14 (opencode's runtime; oracle-verified 2026-07-29) --
        // the form Bun imports and opencode dedupes plugin origins by.
        let cases: &[(&str, &str)] = &[
            ("/a/b/p.ts", "file:///a/b/p.ts"),
            ("/a/b c/p.ts", "file:///a/b%20c/p.ts"),
            ("/a/b#c/p.ts", "file:///a/b%23c/p.ts"),
            ("/a/b?c/p.ts", "file:///a/b%3Fc/p.ts"),
            ("/a/b%41c/p.ts", "file:///a/b%2541c/p.ts"),
            ("/a/100%/p.ts", "file:///a/100%25/p.ts"),
            ("/home/\u{fc}n\u{ef}/p.ts", "file:///home/%C3%BCn%C3%AF/p.ts"),
            // pathToFileURL is stricter than the WHATWG-minimal path set:
            ("/a/x~y/p.ts", "file:///a/x%7Ey/p.ts"),
            ("/a/[b]/p.ts", "file:///a/%5Bb%5D/p.ts"),
            ("/a/b^c/p.ts", "file:///a/b%5Ec/p.ts"),
            ("/a/b|c/p.ts", "file:///a/b%7Cc/p.ts"),
            // posix backslash is an ordinary byte -- encoded, not a separator:
            (r"/a/b\c/p.ts", "file:///a/b%5Cc/p.ts"),
        ];
        for (input, expected) in cases {
            assert_eq!(
                &plugin_file_spec(Path::new(input)),
                expected,
                "input: {input}"
            );
        }
        // Windows drive path: forward slashes, third slash, ':' NOT escaped.
        assert_eq!(
            plugin_file_spec(Path::new(r"C:\Users\dev\p.ts")),
            "file:///C:/Users/dev/p.ts"
        );
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p freshell-platform opencode_plugin`
Expected: FAIL on the `%20`/`%23`/etc. cases (current output is unescaped).

- [ ] **Step 3: Add the dependency and implement**

`crates/freshell-platform/Cargo.toml` `[dependencies]`: add `percent-encoding = "2"`. If the crate/file header claims "no external crates", amend it to "std + serde_json + percent-encoding".

In `opencode_plugin.rs`, replace `plugin_file_spec` (and its doc comment at `:30-31`):

```rust
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};

/// File-URL *path* percent-encode set: byte-parity with `pathToFileURL` as
/// implemented by Node v22 AND Bun (opencode's runtime) -- oracle-verified
/// 2026-07-29 by differential sweep on the installed Bun 1.3.14 / Node
/// v22.21.1. STRICTER than the WHATWG-minimal path set: C0 controls + DEL
/// (both in `CONTROLS`), space, `"` `#` `<` `>` `?` backtick `[` `\` `]`
/// `^` `{` `|` `}` `~`, plus `%` itself so pre-existing escapes round-trip
/// literally. `/` separators and the Windows drive `:` stay bare; non-ASCII
/// bytes are always UTF-8 percent-encoded by `utf8_percent_encode`.
const FILE_URL_PATH_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}')
    .add(b'~');

/// `file://` spec for the tui.json `plugin` array. Unix: `file:///abs`.
/// Windows drive paths get forward slashes and a third slash. The path is
/// percent-encoded to `pathToFileURL` parity (Node v22 == Bun, opencode's
/// runtime): opencode dedupes plugin origins by exact file-URL string and
/// Bun's `import()` hard-fails (silently, for the pane lifetime) on raw
/// `#`/`?`/`%`, so byte-identical output is load-bearing.
pub fn plugin_file_spec(plugin_path: &Path) -> String {
    let raw = plugin_path.display().to_string();
    if raw.starts_with('/') {
        // Posix absolute path: `\` is an ordinary filename byte here --
        // percent-encoded (%5C, pathToFileURL parity), never a separator.
        format!("file://{}", utf8_percent_encode(&raw, FILE_URL_PATH_SET))
    } else {
        // Windows drive path: separators become `/`, third slash added.
        let s = raw.replace('\\', "/");
        format!("file:///{}", utf8_percent_encode(&s, FILE_URL_PATH_SET))
    }
}
```

- [ ] **Step 4: Run to verify it passes (goldens included)**

Run: `cargo test -p freshell-platform`
Expected: PASS — the table test, `tui_config_content_is_exactly_the_plugin_key_and_nothing_else` (its path is ASCII-safe, output unchanged), the installer test, and the cli_launch goldens (they pin `tui_config_path`, not the URL — unaffected).

- [ ] **Step 5: Annotate the historical plan doc**

In `docs/plans/2026-07-28-opencode-tui-rebind.md`, find the pinned assertion near line 481 (it asserts `"file:///a/b c/p.ts"`). Immediately after that code block, add:

```markdown
> **Historical note (2026-07-29, rebind-review-polish):** this pinned
> expectation was superseded — `plugin_file_spec` now percent-encodes to the
> canonical WHATWG form (`file:///a/b%20c/p.ts`); see
> `crates/freshell-platform/src/opencode_plugin.rs::file_spec_is_a_canonical_file_url`.
```

- [ ] **Step 6: Gates and commit**

```bash
cargo fmt --all
cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings
git add crates/freshell-platform/Cargo.toml Cargo.lock crates/freshell-platform/src/opencode_plugin.rs docs/plans/2026-07-28-opencode-tui-rebind.md
git commit -m "fix(freshell-platform): percent-encode the opencode plugin file:// URL

A home dir containing '#', '?', or '%'+hex produced a URL Bun resolves
to the wrong path (silent pane-lifetime import failure); space/non-ASCII
broke opencode's dedup-by-file-URL contract. Encode the path to the
canonical WHATWG form (pathToFileURL parity) via percent-encoding."
```

---

### Task 7: Explicit, bounded handling of foreign/orphaned opencode signal files

Fixes review item 8. Two silent-retain sites in `apply_opencode_signal` (`crates/freshell-ws/src/opencode_signal.rs`) drop foreign-provider signals with **no log** and leave the file to be re-read and re-rejected every 1s for up to 10 minutes: the identity-row check at `:304-306` and the `entry.mode != "opencode"` half of the registry check at `:288-293`. A pane's mode/provider never changes, so these signals are *permanently* unactionable — the honest bounded behavior is warn-once + consume (deleting a signal only degrades to no-rebind, which the module's documented degradation policy already accepts; pane identity is never touched, so "when unsure, do nothing" is preserved). Also: `.tmp` staging files orphaned by a dead writer are never reaped — bound them with the existing TTL.

*(Load-bearing validation, 2026-07-29: the permanence premise is verified — registry `mode` is stamped at row birth under lock with no foreign-provider mutation sites (the 2026-07-22 fix removed the old transient-"shell" window), identity `provider` is always the birth mode and only same-provider lanes rewrite it, and terminal ids are fresh UUIDv4, never recycled. The identity-row Discard below also matches `provider: None` rows — safe today because no production lane seeds provider-less identity rows; keep that behavior. All named rebind guarantees constrain acting, never require it, so consuming a file degrades only to no-rebind.)*

**Files:**
- Modify: `crates/freshell-ws/src/opencode_signal.rs` (`drain` `:87-120`, `drain_and_rebind_opencode` loop `:195-201`, `apply_opencode_signal` `:286-306`, module-header contract lines `:11-17`)
- Test: in-file `mod tests` (tmp reap) + `crates/freshell-ws/tests/opencode_switch_rebind.rs` (new Phase 10)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: private `enum SignalDisposition { Acted, Retain, Discard }`; `apply_opencode_signal` returns it instead of `bool`. Both are module-private — no external surface changes.

- [ ] **Step 1: Write the failing unit test for the `.tmp` reap**

In `opencode_signal.rs`'s `mod tests` (helpers `write_signal`/`remaining` at `:381-403`, backdating idiom at `:468-477`):

```rust
    #[test]
    fn drain_reaps_stale_tmp_staging_files_but_keeps_fresh_ones() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        write_signal(&root, "t1__00000000000001-000001-1.json", r#"{"session_id":"ses_abc123"}"#);
        write_signal(&root, "t1__00000000000002-000001-1.tmp", "in-flight");
        write_signal(&root, "t1__00000000000003-000001-1.tmp", "orphaned");
        let stale = std::time::SystemTime::now()
            - STALE_SIGNAL_MAX_AGE
            - std::time::Duration::from_secs(60);
        std::fs::OpenOptions::new()
            .write(true)
            .open(root.join("t1__00000000000003-000001-1.tmp"))
            .unwrap()
            .set_modified(stale)
            .unwrap();
        let watcher = OpencodeSignalWatcher::new(root.clone());
        let signals = watcher.drain();
        assert_eq!(signals.len(), 1, "the valid json still parses");
        assert_eq!(
            remaining(&root),
            vec![
                "t1__00000000000001-000001-1.json".to_string(), // retained: act-then-delete
                "t1__00000000000002-000001-1.tmp".to_string(),  // fresh staging: untouched
            ],
            "the orphaned stale .tmp must be reaped"
        );
    }
```

(Mirror the module's existing watcher construction if it is not literally `OpencodeSignalWatcher::new(root)` — `drain_reaps_stale_files_without_emitting` at `:459` is the donor.)

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p freshell-ws --lib opencode_signal`
Expected: FAIL — the stale `.tmp` survives (`remaining` has 3 entries).

- [ ] **Step 3: Write the failing integration Phase 10 (foreign-provider pane)**

In `crates/freshell-ws/tests/opencode_switch_rebind.rs`, append a Phase 10 at the end of the single test fn (donors: Phase 9 `:777` for the retention idiom, `write_opencode_signal` `:140-148`, `frame_seen_within` `:307`, `send_create` `:334`). Create a NON-opencode pane the same way the file's other phases create panes but with a shell mode (mirror `send_create`'s body, setting its mode field to `"shell"` — a plain shell pane needs no fake CLI spec), capture its `terminal_id` as `tid_foreign`, then:

```rust
    // ---- Phase 10: a signal addressed to a FOREIGN-provider pane is
    // explicitly ignored (logged) and CONSUMED -- it can never become
    // actionable (a pane's mode never changes), so retaining it would just
    // re-reject it silently every sweep for 10 minutes (unbounded noise).
    write_opencode_signal(&signal_root, &tid_foreign, 10, "ses_foreignclaim0001");
    drain_and_rebind_opencode(&state, &watcher).await;
    // The pane was not touched...
    assert!(
        !frame_seen_within(&mut ws, std::time::Duration::from_secs(2), |v| {
            v["type"] == "terminal.session.associated"
                && v["terminalId"] == tid_foreign.as_str()
        })
        .await,
        "a foreign-provider pane must never be rebound by an opencode signal"
    );
    // ...and the file was consumed, not silently retained.
    assert_eq!(
        std::fs::read_dir(&signal_root).unwrap().count(),
        0,
        "foreign-provider signal files must be consumed (bounded), not retained"
    );
```

(If Phase 9 leaves a retained file in `signal_root`, count relative to that baseline instead of asserting 0 — read Phase 9's tail state first. The warn log itself is asserted by code review, not by this test: the sweep may run off the test thread, so a thread-local subscriber capture would be flaky here.)

- [ ] **Step 4: Run to verify it fails**

Run: `cargo test -p freshell-ws --test opencode_switch_rebind`
Expected: FAIL — the foreign signal is silently retained today, so the file-count assertion trips.

- [ ] **Step 5: Implement**

In `crates/freshell-ws/src/opencode_signal.rs`:

1. Add the disposition enum (module-private, near `apply_opencode_signal`):
```rust
/// Outcome of applying one signal: `Acted` (rebind done), `Retain` (might
/// become actionable later -- keep the file for the next sweep), `Discard`
/// (permanently unactionable -- consume the file so it neither accumulates
/// nor re-logs; deleting a signal degrades only to no-rebind, per the
/// module's degradation policy).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SignalDisposition {
    Acted,
    Retain,
    Discard,
}
```
2. Change `apply_opencode_signal`'s return type from `bool` to `SignalDisposition`; mechanically map existing `return false` → `SignalDisposition::Retain` and the acted path → `SignalDisposition::Acted`, EXCEPT the two foreign-provider sites:
   - Registry site (`:288-293`): split the mode check out first:
   ```rust
        if entry.mode != "opencode" {
            // Foreign-provider pane (registry row): a pane's mode never
            // changes, so this signal can never become actionable. Explicit
            // ignore-with-log + consume (A8 detectability, bounded noise).
            tracing::warn!(terminal_id = %sig.terminal_id, session_id = %sig.session_id,
                mode = %entry.mode, source = ?sig.source,
                "opencode_signal_ignored: pane belongs to another provider, consuming file");
            return SignalDisposition::Discard;
        }
        if entry.status != freshell_protocol::TerminalRunStatus::Running
            || entry.resume_session_id.is_some()
        {
            return SignalDisposition::Retain; // not a live never-bound opencode pane
        }
   ```
   - Identity-row site (`:304-306`):
   ```rust
    if current.provider.as_deref() != Some("opencode") {
        // Foreign-provider identity row: never touch the pane (one-writer /
        // D7) -- and never actionable (a pane's provider does not change),
        // so consume instead of silently re-reading it every sweep.
        tracing::warn!(terminal_id = %sig.terminal_id, session_id = %sig.session_id,
            provider = ?current.provider, source = ?sig.source,
            "opencode_signal_ignored: identity row belongs to another provider, consuming file");
        return SignalDisposition::Discard;
    }
   ```
   The "no pane at all" site (`:286`) stays `Retain` **silently** — the pane may legitimately not exist *yet* (Phase 9 pins this).
3. Update the consumer loop in `drain_and_rebind_opencode` (`:195-201`):
```rust
    for sig in signals {
        match apply_opencode_signal(state, &sig).await {
            SignalDisposition::Acted | SignalDisposition::Discard => {
                let _ = std::fs::remove_file(&sig.path); // act/discard-then-delete (D1.1)
            }
            // Not actionable YET => the file stays for a later sweep.
            SignalDisposition::Retain => {}
        }
    }
```
4. Extend `drain` (`:87-120`) to reap stale `.tmp` staging files while collecting:
```rust
        let mut paths: Vec<PathBuf> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            match path.extension().and_then(|e| e.to_str()) {
                Some("json") => paths.push(path),
                Some("tmp") => {
                    // Orphaned atomic-write staging (writer died before the
                    // rename): reap on the same TTL so junk stays bounded.
                    let stale = std::fs::metadata(&path)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.elapsed().ok())
                        .is_some_and(|age| age > STALE_SIGNAL_MAX_AGE);
                    if stale {
                        let _ = std::fs::remove_file(&path);
                    }
                }
                _ => {}
            }
        }
        paths.sort();
```
(the rest of `drain` — the `.json` TTL reap and parse loop — is unchanged.)
5. Update the module-header contract lines (`:11-17`) to mention the two new behaviors: foreign-provider signals are ignored-with-log and consumed; stale `.tmp` staging files are reaped on the same TTL.

- [ ] **Step 6: Run to verify everything passes**

Run: `cargo test -p freshell-ws --lib opencode_signal && cargo test -p freshell-ws --test opencode_switch_rebind`
Expected: PASS — all unit tests (including the 4 pre-existing ones and the new tmp-reap test) and all 10 integration phases.

- [ ] **Step 7: Gates and commit**

```bash
cargo fmt --all
cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings
git add crates/freshell-ws/src/opencode_signal.rs crates/freshell-ws/tests/opencode_switch_rebind.rs
git commit -m "fix(freshell-ws): explicit bounded handling of foreign opencode signal files

Foreign-provider signals were silently retained and re-rejected every
sweep for 10 minutes -- the exact silently-never-firing shape the module
header warns against. They are permanently unactionable (pane mode and
identity provider never change), so: warn once, consume the file
(SignalDisposition::Discard). Also reaps orphaned .tmp staging files on
the existing TTL. Pane identity is never touched; all legitimate
retention (no-pane-yet, not-live-yet) is unchanged."
```

---

### Task 8: Fix stale wording in the 2026-07-26 codex-locator plan doc

Fixes review item 6. Doc-only (TDD exception per `AGENTS.md:7`). The doc flatly claims resumed codex sessions never create a new rollout file — contradicted by the shipped fork lane (in-TUI `/resume` MAY fork; upstream openai/codex#34972). Do NOT "fix" the sections verified still-accurate (`:277-287`, `:299-306`, `:307-316`, `:317-325`).

**Files:**
- Modify: `docs/plans/2026-07-26-codex-rollout-locator.md` (`:186`, `:327-330`, `:597-600`, and a note after the interface block `:240-269`)

**Interfaces:** none (doc-only).

- [ ] **Step 1: Fix the three stale resume claims**

At **`:327-330`**, replace:

```
- Resumed codex sessions append to their EXISTING rollout file (no new file)
  — consistent with the arm gate refusing resume panes. Compressed rollout
  artifacts (`.jsonl.zst`, present in 0.145.0 source) are excluded by the
  `.jsonl` suffix filter; fresh sessions always write plain `.jsonl`.
```

with (mirrors the shipped module doc, `crates/freshell-sessions/src/codex_locator.rs:66-77`):

```
- CLI-launch `codex resume <id>` appends to the EXISTING rollout file (no new
  file) — consistent with the arm gate refusing resume panes. In-TUI
  `/resume` is DIFFERENT: it MAY fork intermittently (upstream bug
  openai/codex#34972) into a NEW rollout file with a NEW session id,
  `forked_from_id` lineage and `thread_source:"user"`; the ForkWatch lane
  (added 2026-07-28, stale-resume-identity) exists for exactly that case.
  Compressed rollout artifacts (`.jsonl.zst`, present in 0.145.0 source) are
  excluded by the `.jsonl` suffix filter; fresh sessions always write plain
  `.jsonl`. *(Corrected 2026-07-29, rebind-review-polish.)*
```

At **`:597-600`** (the plan's embedded copy of the module doc, `//!`-prefixed), make the same correction in `//!` comment style — replace the four stale lines with the shipped module-doc text quoted verbatim from `crates/freshell-sessions/src/codex_locator.rs:66-77` (copy it from the source file so the embedded copy matches what shipped).

At **`:186`**, where the text leans on "the arm gate refusing resume panes" as if resume never produces a new file, append the qualifier: `(CLI-launch resume; in-TUI /resume may fork — see the corrected note below)`.

- [ ] **Step 2: Annotate the pinned interface block**

Immediately after the interface block at `:240-269` (which pins the arm/census-lane surface only), add:

```markdown
> **Historical note (2026-07-29, rebind-review-polish):** this interface
> block predates the fork lane added by the 2026-07-28 stale-resume-identity
> effort. The shipped `CodexLocator` additionally exposes
> `CODEX_FORK_WINDOW_MS`, `struct ForkLocated`, `watch_fork`,
> `note_fork_submit`, and `tick_forks` — see
> `crates/freshell-sessions/src/codex_locator.rs` for the authoritative
> surface.
```

- [ ] **Step 3: Verify and commit**

```bash
grep -n "no new file" docs/plans/2026-07-26-codex-rollout-locator.md   # only the corrected CLI-launch phrasing remains
git add docs/plans/2026-07-26-codex-rollout-locator.md
git commit -m "docs(plans): correct stale codex resume claims in the 2026-07-26 locator plan

In-TUI /resume may fork into a new rollout file (openai/codex#34972);
the flat 'no new file' claim predated the fork lane. Also annotates the
pinned interface block as pre-fork-lane. Historical doc, correction
markers included."
```

---

### Task 9: Full gate run (whole-workspace verification; closes deferred item D-8)

No new code. This is the whole-system proof that the eight changes compose, plus the repo's full gate set. Any failure found here is fixed here (with its own focused commit) — do not defer.

**Files:** none (unless a gate surfaces a fix).

**Interfaces:** none.

- [ ] **Step 0: Ensure JS deps are installed (fresh-worktree prerequisite)**

Run: `test -d node_modules || npm ci --no-audit --no-fund`
Why: `cargo test --workspace` DEPENDS on `node_modules` — the freshell-freshagent unit tests resolve the `tsx` MCP dependency from it (`mcp_inject.rs:126`); without it, 12 `terminal_tabs::tests` fail with `Unable to resolve MCP dependency "tsx"` and fail-fast leaves later crates untested (observed 2026-07-29 on this worktree before `npm ci` was run during plan validation). The coordinated `npm test` needs it too. `node_modules` was installed in this worktree during validation (npm ci, exit 0), so this step should be a no-op — the guard exists in case the workflow re-provisions the worktree.

- [ ] **Step 1: Rust gates (CI parity)**

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo clippy -p freshell-opencode --features real-transport --all-targets -- -D warnings
```
Expected: all clean. This closes deferred item D-8 ("confirm the clippy gate is green after the deferred `fix:` follow-ups").

- [ ] **Step 2: Full workspace tests (local-only gate)**

Run: `cargo test --workspace` (allow several minutes; the `freshell-ws` integration binaries boot real servers on ephemeral ports — they never touch 3002 or 3499)
Expected: all green. **Baseline recorded (2026-07-29, load-bearing pass, base + docs commit, after `npm ci`):** 44 test binaries green; one timing flake under heavy parallel machine load (`auto_resume_e2e::reconcile_after_replacement_attaches_to_the_new_terminal`, a 10s wait for `terminal.replaced` timed out) passed cleanly on immediate re-run (0.76s). If it trips again, re-run that one binary before treating it as a regression.

- [ ] **Step 3: Coordinated JS suite + contract freeze**

```bash
npm run test:status   # inspect the coordinator holder before a broad run
npm test              # coordinated full suite (never bare vitest for broad runs)
npm run contract:generate && git diff --exit-code -- port/contract
```
Expected: suite green; `git diff --exit-code` exits 0 (contract freeze diff-clean — no task here touches `port/contract`, so any diff is a regression to investigate, not commit).

- [ ] **Step 4: Rebind-guarantee spot-check (regression sweep of the guarantees named in the constraints)**

```bash
cargo test -p freshell-ws --test claude_session_rebind \
  && cargo test -p freshell-ws --test codex_fork_rebind \
  && cargo test -p freshell-ws --test opencode_switch_rebind \
  && cargo test -p freshell-ws --test cross_kind_liveness
```
Expected: all green — one-writer, A13, D7/D8, ledger supersede, and degradation-policy proofs all still hold.

- [ ] **Step 5: Confirm a clean tree**

Run: `git status --short`
Expected: empty (every change was committed in its task). Do **not** create a PR; do **not** push from this task — the workflow handles the push after review.

---

## Self-Review (completed by the plan author)

**1. Spec coverage:** item 1 → Task 3; item 2 → Tasks 1+2; item 3 → Task 1; item 4 → Task 5; item 5 → Task 4; item 6 → Task 8; item 7 → Task 6; item 8 → Task 7 (including the `.tmp` secondary gap); item 9 → the "Deferred-items sweep" section (D-8 closed by Task 9; all exclusions listed with reasons). Constraints → Global Constraints section. No gaps; no UNRESOLVED COVERAGE GAP entries.

**1b. No silent deferrals:** every behavior change lands with a production code path and a real test proving the observable outcome (golden bytes, sorted drain order, refused rebind, single warn, canonical URL, consumed foreign file). The fake claude sidecar in Task 3 and the fake CLIs in the integration suites are the repo's established harnesses for these lanes, not new stubs standing in for unbuilt behavior. The one intentionally untested assertion (the foreign-signal warn *log line* in Task 7's integration phase) is stated inline with its reason (cross-thread subscriber flakiness) and the behavior it accompanies (consume + no-rebind) IS tested.

**2. Placeholder scan:** no TBDs; every code step shows the code. Three steps intentionally defer to named donor code at exact file:line (Phase-1 pane-creation body in Task 3, watcher constructor idioms in Tasks 2/7) because the donor is existing committed code the implementer opens anyway — not an unwritten artifact.

**3. Type consistency:** `CLAUDE_SIGNAL_NONCE_SNIPPET` (Task 1, test-local const) is self-contained; `SignalDisposition` names match between Task 7's steps 5.1–5.3; `ambiguity_warned` matches between Task 5's steps 2/4; Task 5 consumes exactly the helper signatures Task 4's Produces block declares; `plugin_file_spec` signature is unchanged everywhere it is referenced.

**4. Load-bearing validation pass (2026-07-29, workflow Stage 2) — re-review of the edited tasks:** 11 assumptions were surfaced and adjudicated (7 verified, 3 falsified-and-fixed, 1 deferred with an in-plan contingency); full ledger at `.worktrees/.the-usual-logs/rebind-review-polish/load-bearing-ledger.md`. Plan edits from falsified assumptions: **Task 6** — encode set corrected to `pathToFileURL` parity oracle-verified against the installed Bun 1.3.14 / Node v22.21.1 (added `[ \ ] ^ | ~`; posix `\` now percent-encoded, with the `\`→`/` rewrite confined to the Windows branch; 5 new executable table cases); **Tasks 1+2** — the ordering-contract wording narrowed to GNU-deterministic with a documented, self-correcting second-granularity fallback residual (design unchanged — verified strictly better than today on every platform); **Task 9** — new Step 0 (npm ci prerequisite) after the fresh worktree's missing `node_modules` failed 12 freshell-freshagent tests (`tsx` MCP resolution), plus a recorded baseline. Re-running items 1–3 over the edited tasks: spec coverage unchanged (no review items added or dropped; item 7 still → Task 6, items 2/3 still → Tasks 1+2); no silent deferrals introduced (1b: every edited behavior claim remains pinned by an executable test — the new table cases run in Step 2/4; the narrowed ordering claim is doc/commit wording, and its residual is explicitly documented rather than silently deferred); no new placeholders (all edited code steps still show the code); type consistency holds (`FILE_URL_PATH_SET` shape matches between Task 6's doc text, constant, and table; `plugin_file_spec` signature unchanged).
