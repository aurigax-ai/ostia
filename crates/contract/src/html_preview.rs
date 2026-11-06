use std::sync::LazyLock;

use indexmap::IndexMap;
use ostia_base::js::{JS_SPACE_CLASS, is_js_space, js_trim, static_regex, utf16_len};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

use crate::utf16_prefix::utf16_prefix;

pub const PREVIEW_SCHEME: &str = "ostia-preview";
const PREVIEW_PARTITION_PREFIX: &str = "ostia-preview-";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewLimits {
    pub not_responding_ms: u64,
    pub stop_unresponsive_ms: u64,
    pub memory_bytes: u64,
    pub hidden_ms: u64,
    pub busy_ms: u64,
    pub per_window: u64,
    pub load_bytes: u64,
    pub error_bytes: usize,
    pub reload_debounce_ms: u64,
}

pub const PREVIEW_LIMITS: PreviewLimits = PreviewLimits {
    not_responding_ms: 5_000,
    stop_unresponsive_ms: 15_000,
    memory_bytes: 512 * 1024 * 1024,
    hidden_ms: 60_000,
    busy_ms: 30_000,
    per_window: 4,
    load_bytes: 16 * 1024 * 1024,
    error_bytes: 8 * 1024,
    reload_debounce_ms: 300,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PreviewStopReason {
    Unresponsive,
    Memory,
    Hidden,
    Limit,
    Crashed,
    Human,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreviewOpened {
    pub id: String,
    pub partition: String,
    pub url: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PreviewErrorKind {
    Error,
    Blocked,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreviewError {
    pub kind: PreviewErrorKind,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PreviewEvent {
    Loading {
        id: String,
    },
    Error {
        id: String,
        error: PreviewError,
    },
    Vitals {
        id: String,
        responding: bool,
        busy: bool,
    },
    Link {
        id: String,
        url: String,
    },
    Activity {
        id: String,
    },
    Stopped {
        id: String,
        reason: PreviewStopReason,
    },
}

fn ends_with_ignore_ascii_case(text: &str, suffix: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() >= suffix.len()
        && bytes[bytes.len() - suffix.len()..].eq_ignore_ascii_case(suffix.as_bytes())
}

fn starts_with_ignore_ascii_case(text: &str, prefix: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() >= prefix.len() && bytes[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

pub fn is_component_path(path: Option<&str>) -> bool {
    path.is_some_and(|path| {
        ends_with_ignore_ascii_case(path, ".jsx") || ends_with_ignore_ascii_case(path, ".tsx")
    })
}

pub fn is_preview_path(path: Option<&str>) -> bool {
    path.is_some_and(|path| {
        ends_with_ignore_ascii_case(path, ".html")
            || ends_with_ignore_ascii_case(path, ".htm")
            || is_component_path(Some(path))
    })
}

const THEME_NAME_PREFIX: &str = "--ostia-";
const THEME_NAME_MAX: usize = 32;
const THEME_VALUE_MAX: usize = 160;
const THEME_VARS_MAX: usize = 16;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PreviewTheme {
    pub dark: bool,
    pub vars: IndexMap<String, String>,
}

fn is_theme_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(THEME_NAME_PREFIX) else {
        return false;
    };
    let mut chars = rest.chars();
    chars.next().is_some_and(|first| first.is_ascii_lowercase())
        && rest.len() <= THEME_NAME_MAX
        && chars.all(|ch| ch.is_ascii_lowercase() || ch == '-')
}

fn is_theme_value(text: &str) -> bool {
    let units = utf16_len(text);
    (1..=THEME_VALUE_MAX).contains(&units)
        && text
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || "_#(),.%\"'-".contains(ch) || is_js_space(ch))
}

pub fn normalize_preview_theme(value: &Value) -> PreviewTheme {
    let mut vars = IndexMap::new();
    let given = value
        .get("vars")
        .and_then(Value::as_object)
        .into_iter()
        .flatten();
    for (name, text) in given {
        if vars.len() >= THEME_VARS_MAX {
            break;
        }
        if let Some(text) = text.as_str()
            && is_theme_name(name)
            && is_theme_value(text)
        {
            vars.insert(name.clone(), js_trim(text).to_owned());
        }
    }
    PreviewTheme {
        dark: value.get("dark") == Some(&Value::Bool(true)),
        vars,
    }
}

pub fn preview_partition(nonce: &str) -> String {
    format!("{PREVIEW_PARTITION_PREFIX}{nonce}")
}

pub fn is_preview_partition(partition: Option<&str>) -> bool {
    partition.is_some_and(|partition| partition.starts_with(PREVIEW_PARTITION_PREFIX))
}

pub fn allows_preview_request(url: &str) -> bool {
    url.strip_prefix(PREVIEW_SCHEME)
        .is_some_and(|rest| rest.starts_with(':'))
}

pub fn blocked_host(url: &str) -> String {
    match Url::parse(url) {
        Ok(parsed) => match parsed.host_str().filter(|host| !host.is_empty()) {
            Some(host) => match parsed.port() {
                Some(port) => format!("{host}:{port}"),
                None => host.to_owned(),
            },
            None => parsed.scheme().to_owned(),
        },
        Err(_) => utf16_prefix(url, 80).to_owned(),
    }
}

static REMOTE_URL: LazyLock<Regex> = LazyLock::new(|| {
    static_regex(&format!(
        r#"(?:[Hh][Tt][Tt][Pp][Ss]?|[Ww][Ss][Ss]?|[Ff][Tt][Pp])://[^{JS_SPACE_CLASS}'"]+"#
    ))
});

pub fn blocked_by_policy(message: &str) -> Option<String> {
    if !message
        .to_ascii_lowercase()
        .contains("content security policy")
    {
        return None;
    }
    let found = REMOTE_URL.find(message)?.as_str();
    let url = found.trim_end_matches(['.', ',', ';', ':']);
    Some(blocked_host(url))
}

pub fn is_web_link(url: &str) -> bool {
    starts_with_ignore_ascii_case(url, "http://") || starts_with_ignore_ascii_case(url, "https://")
}

pub fn keep_errors(
    errors: &[PreviewError],
    next: PreviewError,
    max_bytes: usize,
) -> Vec<PreviewError> {
    let mut kept: Vec<PreviewError> = errors.to_vec();
    kept.push(next);
    let mut bytes: usize = kept.iter().map(|error| utf16_len(&error.message)).sum();
    let mut first = 0;
    while kept.len() - first > 1 && bytes > max_bytes {
        bytes -= utf16_len(&kept[first].message);
        first += 1;
    }
    let mut kept = kept.split_off(first);
    if utf16_len(&kept[0].message) > max_bytes {
        kept[0].message = utf16_prefix(&kept[0].message, max_bytes).to_owned();
    }
    kept
}

pub fn preview_error_line(error: &PreviewError) -> String {
    let Some(line) = error.line else {
        return error.message.clone();
    };
    let place = match error.source.as_deref().filter(|source| !source.is_empty()) {
        Some(source) => format!("{source}:{line}"),
        None => format!("line {line}"),
    };
    format!("{} ({place})", error.message)
}
