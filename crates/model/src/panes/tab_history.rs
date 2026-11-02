use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;

use crate::layout::tab_focus::TabHistory;

const RECENT_LIMIT: usize = 64;

#[derive(Clone, Debug, Default)]
pub struct TabHistories {
    by_workspace: Arc<Mutex<HashMap<String, TabHistory>>>,
}

impl TabHistories {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn of(&self, workspace_id: &str) -> TabHistory {
        self.by_workspace
            .lock()
            .get(workspace_id)
            .cloned()
            .unwrap_or_default()
    }

    pub fn note_activated(&self, workspace_id: &str, from: &str, to: &str) {
        if from == to {
            return;
        }
        let mut by_workspace = self.by_workspace.lock();
        let history = by_workspace.entry(workspace_id.to_owned()).or_default();
        history.openers.remove(from);
        if history.openers.get(to).map(String::as_str) != Some(from) {
            history.openers.remove(to);
        }
        let recent: Vec<String> = [to.to_owned(), from.to_owned()]
            .into_iter()
            .chain(
                history
                    .recent
                    .iter()
                    .filter(|id| id.as_str() != to && id.as_str() != from)
                    .cloned(),
            )
            .take(RECENT_LIMIT)
            .collect();
        history.recent = recent;
    }

    pub fn note_opener(&self, workspace_id: &str, opened_id: &str, opener_id: &str) {
        if opened_id == opener_id {
            return;
        }
        self.by_workspace
            .lock()
            .entry(workspace_id.to_owned())
            .or_default()
            .openers
            .insert(opened_id.to_owned(), opener_id.to_owned());
    }

    pub fn forget_tab(&self, workspace_id: &str, pane_id: &str) {
        let mut by_workspace = self.by_workspace.lock();
        let Some(history) = by_workspace.get_mut(workspace_id) else {
            return;
        };
        history.recent.retain(|id| id.as_str() != pane_id);
        history.openers.remove(pane_id);
        history
            .openers
            .retain(|_, opener| opener.as_str() != pane_id);
    }

    pub fn forget_workspace_tabs(&self, workspace_id: &str) {
        self.by_workspace.lock().remove(workspace_id);
    }
}
