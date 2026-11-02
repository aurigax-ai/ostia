use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::time::Duration;

use ostia_base::EventHub;
use ostia_base::clock::{Clock, system_clock};
use parking_lot::Mutex;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WakeEnd {
    Started,
    Failed,
    Closed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WakeWaitResult {
    Started,
    Timeout,
    Failed { pane_id: String },
    Closed { pane_id: String },
}

#[derive(Default)]
struct WakingState {
    panes: HashSet<String>,
    ends: HashMap<String, WakeEnd>,
    reasons: HashMap<String, String>,
    started_at: HashMap<String, i64>,
}

pub struct PaneWaking {
    state: Mutex<WakingState>,
    now: Clock,
    ended: EventHub<(String, WakeEnd)>,
    changes: EventHub<()>,
}

impl PaneWaking {
    pub fn new() -> Self {
        Self::with_clock(system_clock())
    }

    pub fn with_clock(now: Clock) -> Self {
        Self {
            state: Mutex::new(WakingState::default()),
            now,
            ended: EventHub::default(),
            changes: EventHub::default(),
        }
    }

    pub fn subscribe(&self) -> UnboundedReceiver<(String, WakeEnd)> {
        self.ended.subscribe()
    }

    pub fn changes(&self) -> &EventHub<()> {
        &self.changes
    }

    pub fn has(&self, pane_id: &str) -> bool {
        self.state.lock().panes.contains(pane_id)
    }

    pub fn since(&self, pane_id: &str) -> Option<i64> {
        self.state.lock().started_at.get(pane_id).copied()
    }

    pub fn last_end(&self, pane_id: &str) -> Option<WakeEnd> {
        let state = self.state.lock();
        if state.panes.contains(pane_id) {
            None
        } else {
            state.ends.get(pane_id).copied()
        }
    }

    pub fn last_reason(&self, pane_id: &str) -> Option<String> {
        self.state.lock().reasons.get(pane_id).cloned()
    }

    pub fn start(&self, pane_id: &str) {
        let mut state = self.state.lock();
        state.panes.insert(pane_id.to_owned());
        state.started_at.insert(pane_id.to_owned(), (self.now)());
        state.ends.remove(pane_id);
        state.reasons.remove(pane_id);
    }

    pub fn abandon(&self, pane_id: &str) {
        let mut state = self.state.lock();
        state.panes.remove(pane_id);
        state.started_at.remove(pane_id);
    }

    pub fn end(&self, pane_id: &str, how: WakeEnd, reason: Option<&str>) {
        {
            let mut state = self.state.lock();
            if !state.panes.remove(pane_id) {
                return;
            }
            state.started_at.remove(pane_id);
            state.ends.insert(pane_id.to_owned(), how);
            if let Some(reason) = reason.filter(|reason| !reason.is_empty()) {
                state.reasons.insert(pane_id.to_owned(), reason.to_owned());
            }
        }
        self.ended.emit((pane_id.to_owned(), how));
        self.changes.emit(());
    }

    pub fn until(
        &self,
        pane_ids: &[&str],
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> impl Future<Output = WakeWaitResult> + Send + use<> {
        let mut left: HashSet<String> = {
            let state = self.state.lock();
            pane_ids
                .iter()
                .filter(|pane_id| state.panes.contains(**pane_id))
                .map(|pane_id| (*pane_id).to_owned())
                .collect()
        };
        let mut ended = self.ended.subscribe();
        let cancel = cancel.clone();
        async move {
            if left.is_empty() {
                return WakeWaitResult::Started;
            }
            let deadline = tokio::time::sleep(timeout);
            tokio::pin!(deadline);
            loop {
                tokio::select! {
                    () = &mut deadline => return WakeWaitResult::Timeout,
                    () = cancel.cancelled() => return WakeWaitResult::Timeout,
                    Some((pane_id, how)) = ended.recv() => {
                        if left.remove(&pane_id) {
                            match how {
                                WakeEnd::Started => {
                                    if left.is_empty() {
                                        return WakeWaitResult::Started;
                                    }
                                }
                                WakeEnd::Failed => return WakeWaitResult::Failed { pane_id },
                                WakeEnd::Closed => return WakeWaitResult::Closed { pane_id },
                            }
                        }
                    }
                }
            }
        }
    }
}

impl Default for PaneWaking {
    fn default() -> Self {
        Self::new()
    }
}
