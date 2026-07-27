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
    // Constructed by Task 6's `spawn_gated_restore_create` (this task lands
    // only the reply-sink half); the allow dies with that task.
    #[allow(dead_code)]
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
