# Decision log — pbh-20260807
- 02:15 Scope ratified: target = Rust crates/ only; Node server/ out of scope (reference only).
- 02:15 Severity matrix ratified (user-facing): S1 data-loss > S2 blocked > S3 wrong-silent > S4 confusion > S5 annoyance. Modulators: silent / irreversible / trunk-artery escalate one level (cap S1). Priority = severity × confidence.
- 02:15 Hunt wave 1 territories ratified: T1 reload/reconnect (above+below), T4 idle-reaper vs background-session, T3 provider resume, T5 attention truth, T6 freshAgent WS above-side, T7 remote access, T2 restart recovery, T8 crashed-agent resume.
- NOTE: acting as ratifier on the async user's behalf per their pre-authorized autonomous run; all calls surfaced in the final report for review.
- NOTE: agmsg not installed -> JSONL coordination-log equivalent used.
- NOTE: mapping deep-workers hung (opencode Explore-Agent stalls on huge crate reads); hung PIDs left running (no-kill), worked around. Skill fix queued: time-box workers + tighter task shapes.
