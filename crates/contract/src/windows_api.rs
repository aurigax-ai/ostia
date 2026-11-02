use serde::{Deserialize, Serialize};

use crate::attention::WorkspaceLiveState;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum QuitAnswer {
    Cancel,
    Quit,
    KeepShells,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningGroup {
    pub workspace_id: String,
    pub workspace: String,
    pub commands: Vec<String>,
    #[serde(default)]
    pub agents: Vec<String>,
    pub files: Vec<String>,
    #[serde(default)]
    pub scratch_files: usize,
    #[serde(default)]
    pub unanswered: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowPaneSummary {
    pub id: String,
    pub title: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowWorkspaceSummary {
    pub id: String,
    pub name: String,
    pub work_dir: String,
    pub state: WorkspaceLiveState,
    pub unread_at: i64,
    pub panes: Vec<WindowPaneSummary>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSummary {
    pub window_id: String,
    pub detached: bool,
    pub workspaces: Vec<WindowWorkspaceSummary>,
}
