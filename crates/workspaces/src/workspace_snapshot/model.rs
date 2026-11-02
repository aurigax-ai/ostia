use ostia_contract::agent_resume::AgentResume;
use serde::{Serialize, Serializer};

use crate::PanePlacementZone;
use crate::browser_device::BrowserDevice;
use crate::js_json::JsNumber;
use crate::stored_resume::ResumeFailure;
use crate::workspace_text::WorkspaceGroupColor;

pub fn is_false(value: &bool) -> bool {
    !*value
}

impl PanePlacementZone {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "left" => Some(Self::Left),
            "right" => Some(Self::Right),
            "top" => Some(Self::Top),
            "bottom" => Some(Self::Bottom),
            "center" => Some(Self::Center),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SurfaceKind {
    Terminal,
    Editor,
    Agent,
    Browser,
    Chat,
    Git,
    View,
}

impl SurfaceKind {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "terminal" => Some(Self::Terminal),
            "editor" => Some(Self::Editor),
            "agent" => Some(Self::Agent),
            "browser" => Some(Self::Browser),
            "chat" => Some(Self::Chat),
            "git" => Some(Self::Git),
            "view" => Some(Self::View),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BrowserProfile {
    Shared,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceKind {
    Terminal,
    Scratch,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SplitDirection {
    Horizontal,
    Vertical,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LeftPanel {
    Files,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanePlacement {
    pub pane_id: String,
    pub zone: PanePlacementZone,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneDrop {
    pub pane_id: String,
    pub workspace_id: String,
    pub placement: PanePlacement,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOrigin {
    pub workspace_id: String,
    pub index: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub beside: Option<PanePlacement>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct WindowBounds {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DetachedBounds(pub Vec<(String, WindowBounds)>);

impl Serialize for DetachedBounds {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_map(self.0.iter().map(|entry| (&entry.0, &entry.1)))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotGroup {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<WorkspaceGroupColor>,
    #[serde(skip_serializing_if = "is_false")]
    pub collapsed: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotPane {
    pub id: String,
    pub title: String,
    pub kind: SurfaceKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser_profile: Option<BrowserProfile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser_device: Option<BrowserDevice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume: Option<AgentResume>,
    #[serde(skip_serializing_if = "is_false")]
    pub agent_running: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub hibernated: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub keep_awake: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_failed: Option<ResumeFailure>,
    #[serde(skip_serializing_if = "is_false")]
    pub locked: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub default_title: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub title_pinned: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub collapsed: bool,
}

impl SnapshotPane {
    pub fn new(id: &str, title: &str, kind: SurfaceKind) -> Self {
        Self {
            id: id.to_owned(),
            title: title.to_owned(),
            kind,
            cwd: None,
            file_path: None,
            view_type: None,
            url: None,
            chat_session_id: None,
            agent_session_id: None,
            browser_profile: None,
            browser_device: None,
            view_name: None,
            resume: None,
            agent_running: false,
            hibernated: false,
            keep_awake: false,
            resume_failed: None,
            locked: false,
            default_title: false,
            title_pinned: false,
            collapsed: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum SnapshotNode {
    Pane(Box<SnapshotPane>),
    Split(SnapshotSplit),
    Tabs(SnapshotTabs),
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum SnapshotTabItem {
    Pane(Box<SnapshotPane>),
    Split(SnapshotSplit),
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotSplit {
    pub id: String,
    pub direction: SplitDirection,
    pub children: Vec<SnapshotNode>,
    pub sizes: Vec<JsNumber>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "is_false")]
    pub folded: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotTabs {
    pub id: String,
    pub children: Vec<SnapshotTabItem>,
    pub active_id: String,
}

impl SnapshotTabItem {
    pub fn into_node(self) -> SnapshotNode {
        match self {
            Self::Pane(pane) => SnapshotNode::Pane(pane),
            Self::Split(split) => SnapshotNode::Split(split),
        }
    }

    pub fn collect_pane_ids(&self, ids: &mut Vec<String>) {
        match self {
            Self::Pane(pane) => ids.push(pane.id.clone()),
            Self::Split(split) => split.collect_pane_ids(ids),
        }
    }
}

impl SnapshotSplit {
    pub fn collect_pane_ids(&self, ids: &mut Vec<String>) {
        for child in &self.children {
            child.collect_pane_ids(ids);
        }
    }
}

impl SnapshotNode {
    pub fn collect_pane_ids(&self, ids: &mut Vec<String>) {
        match self {
            Self::Pane(pane) => ids.push(pane.id.clone()),
            Self::Split(split) => split.collect_pane_ids(ids),
            Self::Tabs(tabs) => {
                for item in &tabs.children {
                    item.collect_pane_ids(ids);
                }
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotWorkspace {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "is_false")]
    pub pinned: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    pub kind: WorkspaceKind,
    pub work_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_dir: Option<String>,
    #[serde(skip_serializing_if = "is_false")]
    pub anchored: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<SnapshotNode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_pane_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<WorkspaceOrigin>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotWindow {
    pub id: String,
    pub bounds: WindowBounds,
    pub active_workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left_panel: Option<LeftPanel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right_panel: Option<String>,
    pub workspaces: Vec<SnapshotWorkspace>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
    pub v: u8,
    pub saved_at: String,
    pub active_workspace_id: Option<String>,
    pub workspaces: Vec<SnapshotWorkspace>,
    pub groups: Vec<SnapshotGroup>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left_panel: Option<LeftPanel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right_panel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<WindowBounds>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detached_bounds: Option<DetachedBounds>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub windows: Vec<SnapshotWindow>,
}
