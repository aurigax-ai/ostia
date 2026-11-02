mod hidden_text;
pub mod pane_names;
pub mod pane_waking;
pub mod phone_agent;
pub mod start_confirm;
pub mod wake_reason;
pub mod worktree_share;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaneStatusChanges {
    pub first: bool,
    pub states: Vec<String>,
    pub commands: i64,
    pub failed: i64,
    pub closing: bool,
    pub mail: i64,
}
