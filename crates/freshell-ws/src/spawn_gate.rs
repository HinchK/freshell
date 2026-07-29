//! Moved to `freshell-freshagent` (see docs/plans/2026-07-27-rest-spawn-gate.md):
//! the REST create pipeline must share the ONE server-wide gate and
//! `freshell-freshagent` cannot import this crate (dependency direction —
//! AD-1 of the rust-create-protection lane). This re-export keeps every
//! existing `crate::spawn_gate::*` path and `WsState { spawn_gate: … }`
//! literal compiling unchanged.
pub use freshell_freshagent::spawn_gate::{SpawnGate, SpawnGateError};
