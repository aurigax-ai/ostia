pub mod chips;
pub mod darwin;
pub mod procfs;
pub mod scan;
pub mod sidebar;
pub mod ssh;

use serde::{Deserialize, Serialize};

pub use ostia_contract::boards_ports::PortHost;

use crate::ssh::SshLogin;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListeningPort {
    pub port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeInfo {
    pub ports: Vec<ListeningPort>,
    pub ssh: Option<SshLogin>,
}
