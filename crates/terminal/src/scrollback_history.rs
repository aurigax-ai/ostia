use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScrollbackHistory {
    Off,
    Unlimited,
    Mib(u64),
}

pub const SCROLLBACK_HISTORY_MIN_MIB: u64 = 64;
pub const SCROLLBACK_HISTORY_MAX_MIB: u64 = 1_048_576;
pub const DEFAULT_SCROLLBACK_HISTORY: ScrollbackHistory = ScrollbackHistory::Unlimited;

pub fn parse_scrollback_history(raw: &Value) -> ScrollbackHistory {
    match raw {
        Value::String(text) if text == "off" => ScrollbackHistory::Off,
        Value::String(text) if text == "unlimited" => ScrollbackHistory::Unlimited,
        Value::Number(number) => match number.as_f64() {
            Some(value) if value.is_finite() => {
                let rounded = (value + 0.5).floor();
                let clamped = rounded.clamp(
                    SCROLLBACK_HISTORY_MIN_MIB as f64,
                    SCROLLBACK_HISTORY_MAX_MIB as f64,
                );
                ScrollbackHistory::Mib(clamped as u64)
            }
            _ => DEFAULT_SCROLLBACK_HISTORY,
        },
        _ => DEFAULT_SCROLLBACK_HISTORY,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryPage {
    pub first: u64,
    pub end: u64,
    pub from: u64,
    pub lines: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HistoryMatch {
    pub line: u64,
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistorySearchResult {
    pub count: u64,
    pub matches: Vec<HistoryMatch>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HistoryBlockRange {
    pub start: u64,
    pub end: u64,
}
