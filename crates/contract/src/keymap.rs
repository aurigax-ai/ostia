use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const KEYMAP_LABEL_MAX: usize = 40;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeymapPlatform {
    Darwin,
    Linux,
}

pub const KEYMAP_PLATFORMS: [KeymapPlatform; 2] = [KeymapPlatform::Darwin, KeymapPlatform::Linux];

impl KeymapPlatform {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Darwin => "darwin",
            Self::Linux => "linux",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeymapContribution {
    pub id: String,
    pub label: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<KeymapPlatform>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeymapInfo {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<KeymapPlatform>,
}

pub fn keymap_ref(ext_id: &str, id: &str) -> String {
    format!("{ext_id}/{id}")
}

pub fn is_keymap_platform(value: &Value) -> bool {
    value.as_str().is_some_and(|name| {
        KEYMAP_PLATFORMS
            .iter()
            .any(|platform| platform.as_str() == name)
    })
}

pub fn keymap_offered(platform: Option<KeymapPlatform>, current: &str) -> bool {
    platform.is_none_or(|platform| platform.as_str() == current)
}
