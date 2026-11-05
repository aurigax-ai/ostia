pub mod agent_left;
pub mod agent_offer_relay;
pub mod agent_resumes;
pub mod agent_running;
pub mod agent_transcript;
pub mod assist_ipc;
pub mod bundled_skills;
pub mod bus_store;
mod bus_text;
pub mod chat_fs_tools;
pub mod chat_sessions;
pub mod chat_sessions_ipc;
pub mod chat_skills;
pub mod chat_tool_grants;
pub mod codex_rpc;
pub mod codex_sockets;
pub mod extension_agents;
mod iso_time;
pub mod mail_delivery;
pub mod mail_flag;
pub mod mail_pending;
pub mod mailers;
pub mod manager;
pub mod manager_session;
mod mcp_client;
pub mod mcp_host;
pub mod origin_agents;
pub mod playbook_enabled;
pub mod playbook_files;
pub mod playbooks;
pub mod portal_caller;
mod skill_front_matter;
pub mod stream_claude;
pub mod stream_codex;
pub mod stream_pi;
pub mod stream_source;
pub mod transcript_files;
pub mod trust_place;

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
