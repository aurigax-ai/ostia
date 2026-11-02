use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaneGitStatus {
    pub branch: Option<String>,
    pub ahead: i64,
    pub behind: i64,
    pub changed: i64,
}
