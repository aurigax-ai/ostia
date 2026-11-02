use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceLiveState {
    Idle,
    Working,
    Waiting,
    Done,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AttentionState {
    None,
    Working,
    Waiting,
    Done,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NotificationKind {
    Waiting,
    Approval,
    Done,
    Error,
    Message,
}

pub fn notification_kind_of(value: &Value) -> NotificationKind {
    match value.as_str() {
        Some("waiting") => NotificationKind::Waiting,
        Some("approval") => NotificationKind::Approval,
        Some("done") => NotificationKind::Done,
        Some("error") => NotificationKind::Error,
        _ => NotificationKind::Message,
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationEntry {
    pub id: String,
    pub ts: String,
    pub kind: NotificationKind,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    pub from: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ext_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub panel_path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPost {
    pub pane_id: String,
    pub kind: NotificationKind,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    pub desktop: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum LifecycleEvent {
    PaneCreated {
        workspace_id: String,
        pane_id: String,
    },
    PaneClosed {
        workspace_id: String,
        pane_id: String,
    },
    WorkspaceAdded {
        workspace_id: String,
        work_dir: String,
    },
    WorkspaceClosed {
        workspace_id: String,
    },
    WorkspaceActivated {
        workspace_id: String,
    },
    WorkspaceState {
        workspace_id: String,
        state: WorkspaceLiveState,
    },
    PaneAttention {
        pane_id: String,
        state: AttentionState,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeptAttentionState {
    Working,
    Waiting,
    Done,
    Error,
}

impl KeptAttentionState {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "working" => Some(Self::Working),
            "waiting" => Some(Self::Waiting),
            "done" => Some(Self::Done),
            "error" => Some(Self::Error),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Working => "working",
            Self::Waiting => "waiting",
            Self::Done => "done",
            Self::Error => "error",
        }
    }
}
