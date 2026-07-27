//! Bounded auto-resume for crashed coding-agent terminals (Lane D1).
//!
//! Policy: a coding-agent terminal (mode ∈ AUTO_RESUME_MODES) that exits
//! NON-ZERO is auto-resumed up to `delays.len()` times with backoff, from its
//! server-side identity (identity registry / pane ledger). Clean exits
//! (code 0) and user kills (structurally excluded upstream — `kill_internal`
//! removes the registry row so `finish_pty_exit` returns `false` and no
//! CrashEvent is ever sent) NEVER auto-resume. The registry's
//! respawn-generation cap is the outer loop bound (campaign plan §7.5).
//! Schedule shape mirrors the repo exemplar `activity.rs::lane_retry_delay_ms`.

#[allow(dead_code)] // consumed in Task 2
pub(crate) const AUTO_RESUME_MODES: [&str; 4] = ["claude", "codex", "opencode", "amplifier"];

/// Backoff before retry N (index = attempts already made). 2 retries max
/// per user ruling 2026-07-27. After the last entry: exhausted and LOUD.
pub(crate) const AUTO_RESUME_DEFAULT_DELAYS_MS: [u64; 2] = [2_000, 10_000];

/// A crashed generation that lived at least this long proves the previous
/// resume was healthy — the attempt counter resets (mirrors
/// `DEFAULT_RESPAWN_LIVENESS_WINDOW_MS` in freshell-terminal).
#[allow(dead_code)] // consumed in Task 2
pub(crate) const AUTO_RESUME_HEALTHY_LIFETIME_MS: i64 = 30_000;

/// Crash notification from the PTY exit hook. Only sent for NATURAL exits
/// (`finish_pty_exit` returned `true`) — user kills never produce one.
#[derive(Debug, Clone)]
#[allow(dead_code)] // consumed in Task 2
pub(crate) struct CrashEvent {
    pub terminal_id: String,
    pub exit_code: i64,
    pub mode: String,
    pub create_request_id: Option<String>,
    /// `now - created_at` of the generation that just died.
    pub lifetime_ms: i64,
}

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)] // consumed in Task 2
pub(crate) struct CrashContext<'a> {
    pub exit_code: i64,
    pub mode: &'a str,
    pub create_request_id: Option<&'a str>,
    pub has_resumable_identity: bool,
    pub lifetime_ms: i64,
    /// Consecutive auto-resume attempts already made for this createRequestId.
    pub prior_attempts: u32,
    /// `registry.respawn_exhausted(create_request_id)` — outer loop bound.
    pub cap_exhausted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)] // consumed in Task 2
pub(crate) enum AutoResumeDecision {
    Resume { attempt: u32, delay_ms: u64 },
    SettleExited { reason: &'static str },
}

#[allow(dead_code)] // consumed in Task 2
pub(crate) fn decide(ctx: &CrashContext<'_>, delays: &[u64]) -> AutoResumeDecision {
    use AutoResumeDecision::SettleExited;
    if ctx.exit_code == 0 {
        return SettleExited {
            reason: "clean_exit",
        };
    }
    if !AUTO_RESUME_MODES.contains(&ctx.mode) {
        return SettleExited {
            reason: "not_agent_mode",
        };
    }
    if ctx.create_request_id.is_none() {
        return SettleExited {
            reason: "no_create_request_id",
        };
    }
    if !ctx.has_resumable_identity {
        return SettleExited {
            reason: "no_resumable_identity",
        };
    }
    if ctx.cap_exhausted {
        return SettleExited {
            reason: "respawn_cap_exhausted",
        };
    }
    let effective_prior = if ctx.lifetime_ms >= AUTO_RESUME_HEALTHY_LIFETIME_MS {
        0
    } else {
        ctx.prior_attempts
    };
    match delays.get(effective_prior as usize).copied() {
        Some(delay_ms) => AutoResumeDecision::Resume {
            attempt: effective_prior + 1,
            delay_ms,
        },
        None => SettleExited {
            reason: "retries_exhausted",
        },
    }
}

/// `FRESHELL_AUTO_RESUME_DELAYS_MS="2000,10000"` — e2e tests set tiny values.
pub(crate) fn parse_delays_env(raw: &str) -> Option<Vec<u64>> {
    let parsed: Option<Vec<u64>> = raw
        .split(',')
        .map(|s| s.trim().parse::<u64>().ok().filter(|v| *v > 0))
        .collect();
    parsed.filter(|v| !v.is_empty())
}

#[allow(dead_code)] // consumed in Task 2
pub(crate) fn auto_resume_delays() -> Vec<u64> {
    std::env::var("FRESHELL_AUTO_RESUME_DELAYS_MS")
        .ok()
        .and_then(|raw| parse_delays_env(&raw))
        .unwrap_or_else(|| AUTO_RESUME_DEFAULT_DELAYS_MS.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx<'a>() -> CrashContext<'a> {
        CrashContext {
            exit_code: 1,
            mode: "claude",
            create_request_id: Some("cr-1"),
            has_resumable_identity: true,
            lifetime_ms: 5_000,
            prior_attempts: 0,
            cap_exhausted: false,
        }
    }
    const DELAYS: [u64; 2] = [2_000, 10_000];

    #[test]
    fn nonzero_agent_exit_resumes_with_schedule() {
        assert_eq!(
            decide(&ctx(), &DELAYS),
            AutoResumeDecision::Resume {
                attempt: 1,
                delay_ms: 2_000
            }
        );
        let c = CrashContext {
            prior_attempts: 1,
            ..ctx()
        };
        assert_eq!(
            decide(&c, &DELAYS),
            AutoResumeDecision::Resume {
                attempt: 2,
                delay_ms: 10_000
            }
        );
    }

    #[test]
    fn clean_exit_never_resumes() {
        let c = CrashContext {
            exit_code: 0,
            ..ctx()
        };
        assert_eq!(
            decide(&c, &DELAYS),
            AutoResumeDecision::SettleExited {
                reason: "clean_exit"
            }
        );
    }

    #[test]
    fn shell_mode_never_resumes() {
        let c = CrashContext {
            mode: "shell",
            ..ctx()
        };
        assert_eq!(
            decide(&c, &DELAYS),
            AutoResumeDecision::SettleExited {
                reason: "not_agent_mode"
            }
        );
        // Unknown future modes are fail-safe too:
        let c = CrashContext {
            mode: "mystery",
            ..ctx()
        };
        assert_eq!(
            decide(&c, &DELAYS),
            AutoResumeDecision::SettleExited {
                reason: "not_agent_mode"
            }
        );
    }

    #[test]
    fn all_four_agent_modes_are_eligible() {
        for mode in AUTO_RESUME_MODES {
            let c = CrashContext { mode, ..ctx() };
            assert!(
                matches!(decide(&c, &DELAYS), AutoResumeDecision::Resume { .. }),
                "mode {mode}"
            );
        }
    }

    #[test]
    fn missing_identity_settles_exited_immediately() {
        let c = CrashContext {
            has_resumable_identity: false,
            ..ctx()
        };
        assert_eq!(
            decide(&c, &DELAYS),
            AutoResumeDecision::SettleExited {
                reason: "no_resumable_identity"
            }
        );
        let c = CrashContext {
            create_request_id: None,
            ..ctx()
        };
        assert_eq!(
            decide(&c, &DELAYS),
            AutoResumeDecision::SettleExited {
                reason: "no_create_request_id"
            }
        );
    }

    #[test]
    fn respawn_cap_exhaustion_settles_exited() {
        let c = CrashContext {
            cap_exhausted: true,
            ..ctx()
        };
        assert_eq!(
            decide(&c, &DELAYS),
            AutoResumeDecision::SettleExited {
                reason: "respawn_cap_exhausted"
            }
        );
    }

    #[test]
    fn retries_are_bounded_and_exhaust_loudly() {
        let c = CrashContext {
            prior_attempts: 2,
            ..ctx()
        };
        assert_eq!(
            decide(&c, &DELAYS),
            AutoResumeDecision::SettleExited {
                reason: "retries_exhausted"
            }
        );
    }

    #[test]
    fn healthy_lifetime_resets_the_attempt_counter() {
        // A generation that lived >= 30s means the previous resume was healthy:
        // this crash starts a fresh budget even with prior attempts recorded.
        let c = CrashContext {
            prior_attempts: 2,
            lifetime_ms: AUTO_RESUME_HEALTHY_LIFETIME_MS,
            ..ctx()
        };
        assert_eq!(
            decide(&c, &DELAYS),
            AutoResumeDecision::Resume {
                attempt: 1,
                delay_ms: 2_000
            }
        );
    }

    #[test]
    fn delays_env_override_is_parsed_and_bad_values_fall_back() {
        assert_eq!(parse_delays_env("50,100"), Some(vec![50, 100]));
        assert_eq!(parse_delays_env("2000"), Some(vec![2000]));
        assert_eq!(parse_delays_env(""), None);
        assert_eq!(parse_delays_env("fast,slow"), None);
        assert_eq!(parse_delays_env("0"), None); // zero-delay loops are forbidden
    }
}
