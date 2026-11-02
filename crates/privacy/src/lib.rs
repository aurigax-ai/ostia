use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedactionSettings {
    pub enabled: bool,
    pub patterns: Vec<String>,
}
