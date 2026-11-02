pub mod agent_offer_relay;
pub mod agent_resumes;
pub mod bundled_skills;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentBusyReason {
    Subagent,
    BackgroundTask,
    ScheduledTask,
    ChildProcess,
    Unknown,
}
