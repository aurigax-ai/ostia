use std::sync::LazyLock;

use ostia_base::js::static_regex;
use regex::Regex;
use serde::{Serialize, Serializer};
use serde_json::{Map, Value};

pub const EXTENSION_CONNECTIONS_MAX: usize = 32;
pub const EXTENSION_CONNECTION_VALUE_MAX: usize = 2048;

pub static EXTENSION_CONNECTION_NAME_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[a-z][a-z0-9-]{0,39}$"));

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExtensionConnectionFieldType {
    String,
    Enum,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExtensionConnectionField {
    pub key: String,
    pub title: String,
    pub description: Option<String>,
    pub field_type: ExtensionConnectionFieldType,
    pub enum_values: Option<Vec<String>>,
    pub default: Option<String>,
    pub required: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExtensionConnectionSecret {
    pub key: String,
    pub title: String,
    pub description: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExtensionConnectionKind {
    pub kind: String,
    pub title: String,
    pub description: Option<String>,
    pub fields: Vec<ExtensionConnectionField>,
    pub secrets: Vec<ExtensionConnectionSecret>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionConnectionEntry {
    pub name: String,
    pub kind: String,
    pub fields: Map<String, Value>,
    pub secrets_set: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ConnectionInfo {
    pub name: String,
    pub kind: String,
}

#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct ConnectionValue {
    pub name: String,
    pub kind: String,
    pub fields: Map<String, Value>,
    pub secrets: Map<String, Value>,
}

impl std::fmt::Debug for ConnectionValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectionValue")
            .field("name", &self.name)
            .field("kind", &self.kind)
            .field("fields", &self.fields)
            .field("secrets", &"<hidden>")
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExtensionConnectionResult {
    Saved,
    Refused(String),
}

impl Serialize for ExtensionConnectionResult {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut out = Map::new();
        match self {
            Self::Saved => {
                out.insert("ok".to_owned(), Value::Bool(true));
            }
            Self::Refused(error) => {
                out.insert("ok".to_owned(), Value::Bool(false));
                out.insert("error".to_owned(), Value::String(error.clone()));
            }
        }
        out.serialize(serializer)
    }
}
