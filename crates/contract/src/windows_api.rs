use serde::{Deserialize, Serialize};

use crate::attention::{AttentionState, WorkspaceLiveState};

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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<String>,
    pub files: Vec<String>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub scratch_files: usize,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unanswered: bool,
}

fn is_zero(count: &usize) -> bool {
    *count == 0
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PaneAgentKind {
    Claude,
    Codex,
    Agy,
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowPaneReport {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub agent: Option<PaneAgentKind>,
    #[serde(default)]
    pub state: Option<AttentionState>,
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowWorkspaceReport {
    pub id: String,
    pub name: String,
    pub work_dir: String,
    pub state: WorkspaceLiveState,
    pub unread_at: i64,
    #[serde(default)]
    pub origin: Option<String>,
    pub panes: Vec<WindowPaneReport>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginAgentTarget {
    pub pane_id: String,
    pub title: String,
    pub agent: PaneAgentKind,
    pub state: AttentionState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginAgents {
    pub workspace_id: String,
    pub workspace_name: String,
    pub targets: Vec<OriginAgentTarget>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginReferenceRequest {
    pub workspace_id: String,
    pub pane_id: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceInsert {
    pub request_id: String,
    pub pane_id: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}
