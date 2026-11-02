pub mod agent_stream;
pub mod codex_stream;
pub mod mail_delivery;
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
