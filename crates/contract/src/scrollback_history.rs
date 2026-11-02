use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;

pub const SCROLLBACK_HISTORY_MIN_MIB: i64 = 64;
pub const SCROLLBACK_HISTORY_MAX_MIB: i64 = 1_048_576;
pub const DEFAULT_SCROLLBACK_HISTORY: ScrollbackHistory = ScrollbackHistory::Unlimited;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScrollbackHistory {
    Off,
    Unlimited,
    Mib(i64),
}

impl Serialize for ScrollbackHistory {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Off => serializer.serialize_str("off"),
            Self::Unlimited => serializer.serialize_str("unlimited"),
            Self::Mib(mib) => serializer.serialize_i64(*mib),
        }
    }
}

pub fn parse_scrollback_history(raw: &Value) -> ScrollbackHistory {
    match raw {
        Value::String(keyword) if keyword == "off" => ScrollbackHistory::Off,
        Value::String(keyword) if keyword == "unlimited" => ScrollbackHistory::Unlimited,
        Value::Number(number) => match number.as_f64() {
            Some(value) if value.is_finite() => {
                let rounded = (value + 0.5).floor();
                let clamped = rounded.clamp(
                    SCROLLBACK_HISTORY_MIN_MIB as f64,
                    SCROLLBACK_HISTORY_MAX_MIB as f64,
                );
                ScrollbackHistory::Mib(clamped as i64)
            }
            _ => DEFAULT_SCROLLBACK_HISTORY,
        },
        _ => DEFAULT_SCROLLBACK_HISTORY,
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryPage {
    pub first: i64,
    pub end: i64,
    pub from: i64,
    pub lines: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySearchOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub case_sensitive: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub regex: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub whole_word: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryMatch {
    pub line: i64,
    pub start: i64,
    pub end: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistorySearchResult {
    pub count: i64,
    pub matches: Vec<HistoryMatch>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryBlockRange {
    pub start: i64,
    pub end: i64,
}
