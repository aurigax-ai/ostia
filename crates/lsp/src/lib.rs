use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LanguageServerNodeRun {
    pub node: String,
    pub args: Vec<String>,
}
