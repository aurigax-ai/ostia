use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReachMode {
    Workspace,
    Project,
    Group,
}

impl ReachMode {
    pub fn name(self) -> &'static str {
        match self {
            Self::Workspace => "workspace",
            Self::Project => "project",
            Self::Group => "group",
        }
    }
}

pub const REACH_MODES: [ReachMode; 3] =
    [ReachMode::Workspace, ReachMode::Project, ReachMode::Group];

const DEFAULT_REACH_MODE: ReachMode = ReachMode::Project;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentGroupPlacement {
    pub workspace_id: String,
    pub group_id: String,
}

fn reach_mode(raw: &Value) -> Option<ReachMode> {
    match raw.as_str()? {
        "workspace" => Some(ReachMode::Workspace),
        "project" => Some(ReachMode::Project),
        "group" => Some(ReachMode::Group),
        _ => None,
    }
}

pub fn is_reach_mode(raw: &Value) -> bool {
    reach_mode(raw).is_some()
}

pub fn parse_reach_mode(raw: &Value) -> ReachMode {
    reach_mode(raw).unwrap_or(DEFAULT_REACH_MODE)
}
