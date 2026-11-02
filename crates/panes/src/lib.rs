use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaneStatusChanges {
    pub first: bool,
    pub states: Vec<String>,
    pub commands: i64,
    pub failed: i64,
    pub closing: bool,
    pub mail: i64,
}
