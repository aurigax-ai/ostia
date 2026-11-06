use std::future::Future;
use std::time::Duration;

use tokio::task::AbortHandle;
use tokio::time::{Instant, MissedTickBehavior, interval_at};

use crate::server_client::ServerError;

const HEARTBEAT: Duration = Duration::from_secs(24 * 60 * 60);

pub struct HeartbeatStop {
    task: AbortHandle,
}

impl HeartbeatStop {
    pub fn stop(&self) {
        self.task.abort();
    }
}

pub fn start_server_heartbeat<S, B, F>(signed_in: S, beat: B) -> HeartbeatStop
where
    S: Fn() -> bool + Send + 'static,
    B: Fn() -> F + Send + 'static,
    F: Future<Output = Result<(), ServerError>> + Send + 'static,
{
    let first = signed_in().then(&beat);
    let mut ticks = interval_at(Instant::now() + HEARTBEAT, HEARTBEAT);
    ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let task = tokio::spawn(async move {
        if let Some(first) = first {
            let _ = first.await;
        }
        loop {
            ticks.tick().await;
            if signed_in() {
                let _ = beat().await;
            }
        }
    });
    HeartbeatStop {
        task: task.abort_handle(),
    }
}
