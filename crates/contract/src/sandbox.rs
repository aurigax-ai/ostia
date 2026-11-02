use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSandbox {
    pub enabled: bool,
    pub allow_read: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_write: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deny_read: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deny_write: Option<Vec<String>>,
    pub domains: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub denied_domains: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_sockets: Option<Vec<String>>,
    pub controls: Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub switches: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ports: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secrets: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub packages: Option<Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxMergeRefusal {
    Mixed,
    Differs,
}

impl WorkspaceSandbox {
    pub fn empty() -> Self {
        Self {
            enabled: false,
            allow_read: Vec::new(),
            allow_write: None,
            deny_read: None,
            deny_write: None,
            domains: Vec::new(),
            denied_domains: None,
            allow_sockets: None,
            controls: Map::new(),
            switches: None,
            ports: None,
            secrets: None,
            packages: None,
        }
    }
}

fn canonical(value: Value) -> Value {
    match value {
        Value::Array(items) => {
            let mut texts: Vec<String> = items
                .into_iter()
                .map(|item| canonical(item).to_string())
                .collect();
            texts.sort();
            Value::Array(texts.into_iter().map(Value::String).collect())
        }
        Value::Object(map) => {
            let mut entries: Vec<(String, Value)> = map
                .into_iter()
                .map(|(key, item)| (key, canonical(item)))
                .collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            Value::Object(entries.into_iter().collect())
        }
        other => other,
    }
}

pub fn same_workspace_sandbox(a: &WorkspaceSandbox, b: &WorkspaceSandbox) -> bool {
    serde_json::to_value(a).ok().map(canonical) == serde_json::to_value(b).ok().map(canonical)
}

pub fn sandbox_merge_refusal(
    source: &WorkspaceSandbox,
    target: &WorkspaceSandbox,
) -> Option<SandboxMergeRefusal> {
    if source.enabled != target.enabled {
        return Some(SandboxMergeRefusal::Mixed);
    }
    if source.enabled && !same_workspace_sandbox(source, target) {
        return Some(SandboxMergeRefusal::Differs);
    }
    None
}
