use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReachMode {
    Workspace,
    Project,
    Group,
}

impl ReachMode {
    pub fn parse(raw: &Value) -> Option<Self> {
        match raw.as_str()? {
            "workspace" => Some(Self::Workspace),
            "project" => Some(Self::Project),
            "group" => Some(Self::Group),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Workspace => "workspace",
            Self::Project => "project",
            Self::Group => "group",
        }
    }
}

pub fn parse_reach_mode(raw: Option<&Value>) -> ReachMode {
    raw.and_then(ReachMode::parse).unwrap_or(ReachMode::Project)
}
