use ostia_base::PaneId;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteCwd {
    pub host: String,
    pub cwd: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStateSnapshot {
    pub pane_id: PaneId,
    pub generation: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub running: bool,
    pub block_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_exit_code: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote: Option<RemoteCwd>,
}
