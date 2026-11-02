use std::collections::HashSet;
use std::sync::Arc;

use parking_lot::Mutex;

#[derive(Clone, Debug, Default)]
pub struct AgentSplitTabs {
    made_by_agents: Arc<Mutex<HashSet<String>>>,
}

impl AgentSplitTabs {
    pub fn mark_agent_split_tab(&self, tab_id: &str) {
        self.made_by_agents.lock().insert(tab_id.to_owned());
    }

    pub fn is_agent_split_tab(&self, tab_id: &str) -> bool {
        self.made_by_agents.lock().contains(tab_id)
    }

    pub fn forget_agent_split_tab(&self, tab_id: &str) {
        self.made_by_agents.lock().remove(tab_id);
    }
}
