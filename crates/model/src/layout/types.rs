use std::sync::Arc;

use ostia_contract::agent_resume::AgentResume;
use ostia_workspaces::browser_device::BrowserDevice;
use ostia_workspaces::stored_resume::ResumeFailure;

pub use ostia_workspaces::PanePlacementZone as DropZone;
pub use ostia_workspaces::workspace_snapshot::model::{PanePlacement, SplitDirection as Direction};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SurfaceKind {
    Terminal,
    Editor,
    Agent,
    Browser,
    Diff,
    Chat,
    Git,
    View,
    Manager,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BrowserProfile {
    Shared,
    #[default]
    Isolated,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PaneNode {
    pub id: String,
    pub title: String,
    pub kind: SurfaceKind,
    pub cwd: Option<String>,
    pub file_path: Option<String>,
    pub view_type: Option<String>,
    pub url: Option<String>,
    pub chat_session_id: Option<String>,
    pub agent_session_id: Option<String>,
    pub manager_session: bool,
    pub view_name: Option<String>,
    pub browser_profile: Option<BrowserProfile>,
    pub browser_device: Option<BrowserDevice>,
    pub resume: Option<AgentResume>,
    pub hibernated: bool,
    pub keep_awake: bool,
    pub resume_pending: bool,
    pub spawn_dir: Option<String>,
    pub resume_folder_missing: Option<String>,
    pub resume_failed: Option<ResumeFailure>,
    pub locked: bool,
    pub default_title: bool,
    pub title_pinned: bool,
    pub collapsed: bool,
}

impl PaneNode {
    pub fn new(id: impl Into<String>, title: impl Into<String>, kind: SurfaceKind) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            kind,
            cwd: None,
            file_path: None,
            view_type: None,
            url: None,
            chat_session_id: None,
            agent_session_id: None,
            manager_session: false,
            view_name: None,
            browser_profile: None,
            browser_device: None,
            resume: None,
            hibernated: false,
            keep_awake: false,
            resume_pending: false,
            spawn_dir: None,
            resume_folder_missing: None,
            resume_failed: None,
            locked: false,
            default_title: false,
            title_pinned: false,
            collapsed: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SplitNode {
    pub id: String,
    pub direction: Direction,
    pub children: Vec<LayoutNode>,
    pub sizes: Vec<f64>,
    pub name: Option<String>,
    pub folded: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TabsNode {
    pub id: String,
    pub children: Vec<TabNode>,
    pub active_id: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum LayoutNode {
    Pane(Arc<PaneNode>),
    Split(Arc<SplitNode>),
    Tabs(Arc<TabsNode>),
}

#[derive(Clone, Debug, PartialEq)]
pub enum TabNode {
    Pane(Arc<PaneNode>),
    Split(Arc<SplitNode>),
}

impl LayoutNode {
    pub fn id(&self) -> &str {
        match self {
            Self::Pane(pane) => &pane.id,
            Self::Split(split) => &split.id,
            Self::Tabs(tabs) => &tabs.id,
        }
    }

    pub fn is_same(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Pane(a), Self::Pane(b)) => Arc::ptr_eq(a, b),
            (Self::Split(a), Self::Split(b)) => Arc::ptr_eq(a, b),
            (Self::Tabs(a), Self::Tabs(b)) => Arc::ptr_eq(a, b),
            _ => false,
        }
    }

    pub fn into_tab(self) -> Option<TabNode> {
        match self {
            Self::Pane(pane) => Some(TabNode::Pane(pane)),
            Self::Split(split) => Some(TabNode::Split(split)),
            Self::Tabs(_) => None,
        }
    }
}

impl TabNode {
    pub fn id(&self) -> &str {
        match self {
            Self::Pane(pane) => &pane.id,
            Self::Split(split) => &split.id,
        }
    }

    pub fn is_same(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Pane(a), Self::Pane(b)) => Arc::ptr_eq(a, b),
            (Self::Split(a), Self::Split(b)) => Arc::ptr_eq(a, b),
            _ => false,
        }
    }

    pub fn to_node(&self) -> LayoutNode {
        match self {
            Self::Pane(pane) => LayoutNode::Pane(pane.clone()),
            Self::Split(split) => LayoutNode::Split(split.clone()),
        }
    }
}

impl From<PaneNode> for LayoutNode {
    fn from(pane: PaneNode) -> Self {
        Self::Pane(Arc::new(pane))
    }
}

impl From<SplitNode> for LayoutNode {
    fn from(split: SplitNode) -> Self {
        Self::Split(Arc::new(split))
    }
}

impl From<TabsNode> for LayoutNode {
    fn from(tabs: TabsNode) -> Self {
        Self::Tabs(Arc::new(tabs))
    }
}

impl From<PaneNode> for TabNode {
    fn from(pane: PaneNode) -> Self {
        Self::Pane(Arc::new(pane))
    }
}

impl From<SplitNode> for TabNode {
    fn from(split: SplitNode) -> Self {
        Self::Split(Arc::new(split))
    }
}
