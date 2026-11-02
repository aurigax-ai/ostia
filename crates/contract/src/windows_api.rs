use serde::Serialize;

use crate::attention::WorkspaceLiveState;

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
