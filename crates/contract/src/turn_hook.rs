use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TurnStepKind {
    Edit,
    Command,
    Search,
    Read,
    Subagent,
    Web,
    Other,
}
