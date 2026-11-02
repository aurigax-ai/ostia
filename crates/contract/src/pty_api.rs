use serde::de::{Error as _, Unexpected};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HumanInputSource {
    Key,
    Paste,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeptLink {
    Up,
    Reconnecting,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DownLink {
    Reconnecting,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PtyRole {
    Owner,
    Observer,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum PromptSeparator {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "%")]
    Percent,
    #[serde(rename = "$")]
    Dollar,
    #[serde(rename = ">")]
    Greater,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Held;

impl Serialize for Held {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(true)
    }
}

impl<'de> Deserialize<'de> for Held {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        if bool::deserialize(deserializer)? {
            Ok(Self)
        } else {
            Err(D::Error::invalid_value(Unexpected::Bool(false), &"true"))
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaneActivity {
    pub program: Option<String>,
    #[serde(rename = "agentRunning")]
    pub agent_running: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OstiaPromptSpawn {
    pub separator: PromptSeparator,
    pub same_line: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawnOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub cols: i64,
    pub rows: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<PtyRole>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since_cursor: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ostia_prompt: Option<OstiaPromptSpawn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attach_only: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PromptContextRequest {
    pub node: bool,
    pub kube: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptContext {
    pub user: String,
    pub host: String,
    pub home: String,
    pub virtual_env: Option<String>,
    pub conda_env: Option<String>,
    pub node_version: Option<String>,
    pub kube_context: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyAttachResult {
    pub created: bool,
    pub buffer: String,
    pub cursor: i64,
    pub dropped: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_seq_base: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandboxed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_stamp: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cols: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub held: Option<Held>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kept: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<DownLink>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reattached: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_running: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd_missing: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mark_nonce: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShellHistoryEntry {
    pub command: String,
    pub time: Option<i64>,
}
