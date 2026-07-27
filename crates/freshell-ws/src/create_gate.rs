//! The gated restore-create path (WSL-outage RCA §6.3): reply-sink
//! abstraction (this task) + the spawned, permit-holding, cancellable
//! restore create (Task 6 adds `spawn_gated_restore_create`).

use freshell_protocol::ServerMessage;
use freshell_terminal::FrameSink;

/// Where a `terminal.create` reply goes.
pub(crate) enum CreateOutput<'a> {
    /// Direct socket sink — the inline (non-restore) path. A send failure
    /// propagates as `false`, which closes the connection (existing
    /// semantics, unchanged).
    Socket(&'a mut crate::terminal::WsSink),
    /// The connection's mpsc frame sink — the spawned (restore) path. The
    /// select loop drains it to the socket; pushing is non-blocking, so a
    /// stalled client can never wedge a gate permit. A dead connection just
    /// drops the frames.
    Channel(&'a FrameSink),
}

impl CreateOutput<'_> {
    pub(crate) async fn send(&mut self, msg: &ServerMessage) -> bool {
        match self {
            CreateOutput::Socket(ws_tx) => crate::terminal::send(ws_tx, msg).await,
            CreateOutput::Channel(sink) => {
                (sink)(msg.clone());
                true
            }
        }
    }
}

use freshell_protocol::client_messages::TerminalCreate;
use freshell_protocol::ErrorCode;

use crate::spawn_gate::SpawnGateError;
use crate::WsState;

/// Map a gate rejection to the client-facing error frame parts.
/// QueueFull -> RATE_LIMITED so the frozen client's retry ladder converts
/// overload into backoff-and-retry (by the retry, the queue has drained).
/// Timeout -> PTY_SPAWN_FAILED: fail loud; the pane shows a launch error.
pub(crate) fn spawn_gate_error_parts(err: SpawnGateError) -> (ErrorCode, &'static str) {
    match err {
        SpawnGateError::QueueFull => (ErrorCode::RateLimited, "Too many terminal.create requests"),
        SpawnGateError::Timeout => (
            ErrorCode::PtySpawnFailed,
            "Timed out waiting for a restore spawn slot",
        ),
        // Cancelled never reaches the client: the connection is gone (or the
        // server is closing it with 4009). Mapped defensively anyway.
        SpawnGateError::Cancelled => (
            ErrorCode::PtySpawnFailed,
            "Terminal create cancelled during shutdown",
        ),
    }
}

/// Run one `restore:true` create through the server-wide gate on a spawned
/// task, holding the permit from BEFORE the PTY spawn until the terminal is
/// settled (`terminal.created` + broadcasts queued — the end of
/// `handle_create`). Spawning (instead of awaiting inline like non-restore
/// creates) keeps the connection's select loop polling, which is what makes
/// cancellation REAL: on disconnect or server shutdown the loop exits, the
/// per-connection cancel watch fires (send or sender drop), and every queued
/// restore create for that connection unblocks as Cancelled WITHOUT spawning
/// a PTY.
pub(crate) fn spawn_gated_restore_create(
    create: TerminalCreate,
    state: &WsState,
    conn_sink: &freshell_terminal::FrameSink,
    mut cancel_rx: tokio::sync::watch::Receiver<bool>,
) {
    let state = state.clone();
    let sink = std::sync::Arc::clone(conn_sink);
    tokio::spawn(async move {
        let timeout =
            std::time::Duration::from_millis(state.create_protect.restore_spawn_timeout_ms);
        let permit = match state.spawn_gate.acquire(timeout, &mut cancel_rx).await {
            Ok(permit) => permit,
            Err(SpawnGateError::Cancelled) => {
                tracing::info!(
                    target: "freshell_ws::spawn_gate",
                    request_id = %create.request_id,
                    "restore_create_cancelled"
                );
                return; // Client gone or server shutting down: no PTY, no reply.
            }
            Err(err) => {
                let (code, msg) = spawn_gate_error_parts(err);
                let mut out = CreateOutput::Channel(&sink);
                let _ = crate::terminal::send_create_error(
                    &mut out,
                    code,
                    msg.to_string(),
                    &create.request_id,
                )
                .await;
                return;
            }
        };
        // Last-instant check: the permit may have been granted a beat after
        // the client vanished. Nothing has been spawned yet — abandon.
        if *cancel_rx.borrow() {
            tracing::info!(
                target: "freshell_ws::spawn_gate",
                request_id = %create.request_id,
                "restore_create_cancelled"
            );
            return;
        }
        // A10 shutdown-race pre-check (V3): kill_all snapshots ids once
        // (registry.rs:889-892); if shutdown already began, nothing has been
        // spawned yet — abandon instead of inserting a PTY the snapshot will
        // never visit.
        if state
            .shutdown_started
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            tracing::info!(
                target: "freshell_ws::spawn_gate",
                request_id = %create.request_id,
                "restore_create_abandoned_for_shutdown"
            );
            return;
        }
        // Permit held across the WHOLE async create: PTY spawn -> registry
        // insert -> meta/identity -> terminal.created -> broadcasts (the
        // spawn-to-settled requirement). Replies go through the non-blocking
        // conn sink, so no stalled client can wedge the permit — the exact
        // hazard prior art's da5d9b5c early release worked around does not
        // exist on this path.
        let mut out = CreateOutput::Channel(&sink);
        let request_id = create.request_id.clone();
        let _ = crate::terminal::handle_create(create, &mut out, &state).await;
        // A10 shutdown-race post-check (V3): shutdown may have begun DURING
        // the create, after main's kill_all snapshot. The server is reaping
        // everything anyway, so an idempotent kill_all here reaps our own
        // just-inserted terminal (and any other late insert). Belt to the
        // pre-check's braces; main.rs adds a drain re-sweep too (Task 7
        // Step 2b).
        if state
            .shutdown_started
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            let killed = state.registry.kill_all();
            tracing::info!(
                target: "freshell_ws::spawn_gate",
                request_id = %request_id,
                killed,
                "restore_create_settled_during_shutdown_reaped"
            );
        }
        drop(permit);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn channel_output_forwards_message_and_reports_success() {
        let captured: Arc<Mutex<Vec<ServerMessage>>> = Arc::new(Mutex::new(Vec::new()));
        let sink: FrameSink = {
            let captured = Arc::clone(&captured);
            Arc::new(move |msg| captured.lock().expect("lock").push(msg))
        };
        let mut out = CreateOutput::Channel(&sink);
        // Cheapest existing variant: `ServerMessage` has no unit variant
        // (the brief's `ServerMessage::Pong` is a tuple variant carrying
        // `Pong { timestamp }`) — the test only asserts forwarding.
        let msg = ServerMessage::Pong(freshell_protocol::Pong {
            timestamp: "t".to_string(),
        });
        assert!(out.send(&msg).await);
        assert_eq!(captured.lock().expect("lock").len(), 1);
    }
}
