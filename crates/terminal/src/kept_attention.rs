use std::collections::HashSet;
use std::sync::Arc;

use ostia_contract::attention::KeptAttentionState;
use parking_lot::Mutex;

use crate::attention_file::SavedAttention;

pub const KEPT_AGENT_UNREPORTED: &str =
    "its agent kept running across a restart and has not reported its state since";

#[derive(Clone, Default)]
pub struct KeptAttention {
    unreported: Arc<Mutex<HashSet<String>>>,
}

impl KeptAttention {
    pub fn reattached(&self, pane_id: &str, agent_running: bool) {
        let mut unreported = self.unreported.lock();
        if agent_running {
            unreported.insert(pane_id.to_owned());
        } else {
            unreported.remove(pane_id);
        }
    }

    pub fn reported(&self, pane_id: &str) {
        self.unreported.lock().remove(pane_id);
    }

    pub fn peek(&self, pane_id: &str) -> Option<SavedAttention> {
        self.unreported
            .lock()
            .contains(pane_id)
            .then(|| SavedAttention {
                state: KeptAttentionState::Waiting,
                message: Some(KEPT_AGENT_UNREPORTED.to_owned()),
            })
    }
}
