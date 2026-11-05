use std::collections::HashMap;
use std::sync::Arc;

use ostia_base::clock::Clock;
use parking_lot::Mutex;

type WorkspaceOf = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PaneChange {
    Attention { state: Option<String> },
    State,
    Closed,
}

pub struct WaitingSince {
    now: Clock,
    workspace_of: WorkspaceOf,
    since: Mutex<HashMap<String, i64>>,
}

impl WaitingSince {
    pub fn new(
        now: Clock,
        workspace_of: impl Fn(&str) -> Option<String> + Send + Sync + 'static,
    ) -> Self {
        Self {
            now,
            workspace_of: Arc::new(workspace_of),
            since: Mutex::new(HashMap::new()),
        }
    }

    pub fn observe(&self, pane_id: &str, change: &PaneChange) {
        match change {
            PaneChange::Closed => {
                self.since.lock().remove(pane_id);
            }
            PaneChange::Attention { state } => self.change(pane_id, state.as_deref()),
            PaneChange::State => {}
        }
    }

    pub fn any(&self) -> bool {
        !self.since.lock().is_empty()
    }

    fn change(&self, pane_id: &str, state: Option<&str>) {
        let mut since = self.since.lock();
        if state != Some("waiting") {
            since.remove(pane_id);
            return;
        }
        if !since.contains_key(pane_id) {
            since.insert(pane_id.to_owned(), (self.now)());
        }
    }

    pub fn of_pane(&self, pane_id: &str) -> Option<i64> {
        self.since.lock().get(pane_id).copied()
    }

    pub fn of_workspace(&self, workspace_id: &str) -> Option<i64> {
        let waiting: Vec<(String, i64)> = self
            .since
            .lock()
            .iter()
            .map(|(pane, at)| (pane.clone(), *at))
            .collect();
        let mut newest: Option<i64> = None;
        for (pane_id, at) in waiting {
            let in_workspace = (self.workspace_of)(&pane_id).as_deref() == Some(workspace_id);
            if in_workspace && newest.is_none_or(|best| at > best) {
                newest = Some(at);
            }
        }
        newest
    }
}
