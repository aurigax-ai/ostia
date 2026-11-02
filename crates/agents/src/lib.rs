pub mod agent_offer_relay;
pub mod agent_resumes;
pub mod bundled_skills;
pub mod bus_store;
mod bus_text;
pub mod codex_rpc;
pub mod codex_sockets;
pub mod codex_stream;
pub mod extension_agents;
mod iso_time;
pub mod mail_delivery;
pub mod mail_flag;
pub mod mail_pending;
pub mod mailers;
pub mod playbook_enabled;
pub mod playbook_files;
pub mod playbooks;
pub mod skill_directive;
pub mod stream_codex;
pub mod stream_pi;
pub mod stream_source;

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
