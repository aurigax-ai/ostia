use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use ostia_contract::open_files::WaitOutcome;
use parking_lot::Mutex;
use tokio::sync::oneshot;

type Ended = Arc<dyn Fn(&str, &[String]) + Send + Sync>;

#[derive(Clone, Debug)]
pub struct WaitRequest {
    pub window_id: String,
    pub workspace_id: String,
    pub caller_pane_id: String,
    pub pane_ids: Vec<String>,
}

#[derive(Debug)]
pub struct StartedWait {
    pub id: u64,
    pub done: oneshot::Receiver<WaitOutcome>,
}

struct Wait {
    request: WaitRequest,
    left: HashSet<String>,
    settle: oneshot::Sender<WaitOutcome>,
}

struct State {
    waits: BTreeMap<u64, Wait>,
    next: u64,
    finished: Vec<(Wait, WaitOutcome)>,
}

impl State {
    fn finish(&mut self, id: u64, outcome: WaitOutcome) {
        if let Some(wait) = self.waits.remove(&id) {
            self.finished.push((wait, outcome));
        }
    }

    fn finish_where(&mut self, matches: impl Fn(&Wait) -> bool) {
        let ids: Vec<u64> = self
            .waits
            .iter()
            .filter(|(_, wait)| matches(wait))
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            self.finish(id, WaitOutcome::Gone);
        }
    }
}

#[derive(Clone)]
pub struct OpenWaits {
    state: Arc<Mutex<State>>,
    ended: Ended,
}

impl Default for OpenWaits {
    fn default() -> Self {
        Self::new(|_, _| {})
    }
}

impl OpenWaits {
    pub fn new(ended: impl Fn(&str, &[String]) + Send + Sync + 'static) -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                waits: BTreeMap::new(),
                next: 1,
                finished: Vec::new(),
            })),
            ended: Arc::new(ended),
        }
    }

    pub fn size(&self) -> usize {
        self.state.lock().waits.len()
    }

    pub fn start(&self, request: WaitRequest) -> StartedWait {
        let mut state = self.state.lock();
        let id = state.next;
        state.next += 1;
        let left: HashSet<String> = request.pane_ids.iter().cloned().collect();
        let (settle, done) = oneshot::channel();
        if left.is_empty() {
            let _ = settle.send(WaitOutcome::Gone);
        } else {
            state.waits.insert(
                id,
                Wait {
                    request,
                    left,
                    settle,
                },
            );
        }
        StartedWait { id, done }
    }

    fn change(&self, apply: impl FnOnce(&mut State)) {
        let finished = {
            let mut state = self.state.lock();
            apply(&mut state);
            std::mem::take(&mut state.finished)
        };
        for (wait, outcome) in finished {
            (self.ended)(&wait.request.window_id, &wait.request.pane_ids);
            let _ = wait.settle.send(outcome);
        }
    }

    pub fn pane_closed(&self, pane_id: &str) {
        self.change(|state| {
            let ids: Vec<u64> = state.waits.keys().copied().collect();
            for id in ids {
                let Some(wait) = state.waits.get_mut(&id) else {
                    continue;
                };
                if wait.request.caller_pane_id == pane_id {
                    state.finish(id, WaitOutcome::Gone);
                } else if wait.left.remove(pane_id) && wait.left.is_empty() {
                    state.finish(id, WaitOutcome::Closed);
                }
            }
        });
    }

    pub fn pane_moved(&self, pane_id: &str) {
        self.change(|state| {
            state.finish_where(|wait| {
                wait.left.contains(pane_id) || wait.request.caller_pane_id == pane_id
            });
        });
    }

    pub fn caller_exited(&self, pane_id: &str) {
        self.change(|state| state.finish_where(|wait| wait.request.caller_pane_id == pane_id));
    }

    pub fn workspace_closed(&self, workspace_id: &str) {
        self.change(|state| state.finish_where(|wait| wait.request.workspace_id == workspace_id));
    }

    pub fn window_gone(&self, window_id: &str) {
        self.change(|state| state.finish_where(|wait| wait.request.window_id == window_id));
    }

    pub fn cancel(&self, id: u64) {
        self.change(|state| state.finish(id, WaitOutcome::Gone));
    }
}
