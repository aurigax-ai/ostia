use ostia_base::{EventHub, ExternalId};
use ostia_contract::agent_resume::AgentResume;
use tokio::sync::mpsc::UnboundedReceiver;

#[derive(Clone, Default)]
pub struct AgentResumes {
    hub: EventHub<(ExternalId, AgentResume)>,
}

impl AgentResumes {
    pub fn subscribe(&self) -> UnboundedReceiver<(ExternalId, AgentResume)> {
        self.hub.subscribe()
    }

    pub fn emit(&self, external_pane_id: ExternalId, resume: AgentResume) {
        self.hub.emit((external_pane_id, resume));
    }
}
