use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::capabilities::Capability;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetMode {
    Active,
    Explicit,
    None,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionCommandRef {
    pub ext_id: String,
    pub command: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandDescriptor {
    pub id: String,
    pub title: String,
    pub category: Option<String>,
    pub hidden: bool,
    pub args_schema: Option<Value>,
    pub result_schema: Option<Value>,
    pub capabilities: Vec<Capability>,
    pub target: TargetMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extension: Option<ExtensionCommandRef>,
}
