use ostia_base::js::js_trim;
use serde_json::{Map, Value};

use crate::utf16_prefix::utf16_prefix;

const FIELD_MAX: usize = 200;
const PATH_MAX: usize = 4096;
const THOUSAND: u64 = 1000;
const MILLION: u64 = 1_000_000;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AgentSessionInfo {
    pub title: Option<String>,
    pub model: Option<String>,
    pub context_tokens: Option<u64>,
    pub context_window: Option<u64>,
    pub cwd: Option<String>,
    pub branch: Option<String>,
    pub version: Option<String>,
    pub mode: Option<String>,
    pub effort: Option<String>,
}

fn cut(value: Option<&Value>, max: usize) -> Option<String> {
    let trimmed = js_trim(value?.as_str()?);
    (!trimmed.is_empty()).then(|| utf16_prefix(trimmed, max).to_owned())
}

fn text(value: Option<&Value>) -> Option<String> {
    cut(value, FIELD_MAX)
}

fn path_text(value: Option<&Value>) -> Option<String> {
    cut(value, PATH_MAX)
}

fn count(value: Option<&Value>) -> Option<u64> {
    let number = value?.as_number()?.as_f64()?;
    if !number.is_finite() || number < 0.0 {
        return None;
    }
    let floor = number.floor();
    let rounded = if number - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    };
    Some(rounded as u64)
}

fn records(lines: &[String]) -> Vec<Map<String, Value>> {
    lines
        .iter()
        .filter(|line| !js_trim(line).is_empty())
        .filter_map(|line| match serde_json::from_str::<Value>(line) {
            Ok(Value::Object(entry)) => Some(entry),
            _ => None,
        })
        .collect()
}

fn keep<T>(next: Option<T>, current: &mut Option<T>) {
    if next.is_some() {
        *current = next;
    }
}

pub fn claude_session_info(lines: &[String]) -> AgentSessionInfo {
    let mut info = AgentSessionInfo::default();
    let mut custom_title: Option<String> = None;
    for entry in records(lines) {
        let kind = entry.get("type").and_then(Value::as_str);
        match kind {
            Some("ai-title") => keep(text(entry.get("aiTitle")), &mut info.title),
            Some("custom-title") => keep(text(entry.get("customTitle")), &mut custom_title),
            Some("permission-mode") => keep(text(entry.get("permissionMode")), &mut info.mode),
            _ => {}
        }
        if entry.get("isSidechain") == Some(&Value::Bool(true)) {
            continue;
        }
        if kind != Some("user") && kind != Some("assistant") {
            continue;
        }
        keep(path_text(entry.get("cwd")), &mut info.cwd);
        keep(text(entry.get("gitBranch")), &mut info.branch);
        keep(text(entry.get("version")), &mut info.version);
        let Some(message) = entry
            .get("message")
            .and_then(Value::as_object)
            .filter(|_| kind == Some("assistant"))
        else {
            continue;
        };
        keep(text(message.get("model")), &mut info.model);
        keep(text(entry.get("effort")), &mut info.effort);
        let Some(usage) = message.get("usage").and_then(Value::as_object) else {
            continue;
        };
        let parts = [
            count(usage.get("input_tokens")),
            count(usage.get("cache_creation_input_tokens")),
            count(usage.get("cache_read_input_tokens")),
        ];
        if parts.iter().any(Option::is_some) {
            info.context_tokens = Some(parts.iter().flatten().sum());
        }
    }
    if custom_title.is_some() {
        info.title = custom_title;
    }
    info
}

pub fn codex_session_info(lines: &[String]) -> AgentSessionInfo {
    let mut info = AgentSessionInfo::default();
    for entry in records(lines) {
        let Some(payload) = entry.get("payload").and_then(Value::as_object) else {
            continue;
        };
        match entry.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                keep(path_text(payload.get("cwd")), &mut info.cwd);
                keep(text(payload.get("cli_version")), &mut info.version);
                keep(
                    count(payload.get("context_window")),
                    &mut info.context_window,
                );
                if let Some(git) = payload.get("git").and_then(Value::as_object) {
                    keep(text(git.get("branch")), &mut info.branch);
                }
            }
            Some("turn_context") => {
                keep(text(payload.get("model")), &mut info.model);
                keep(path_text(payload.get("cwd")), &mut info.cwd);
                keep(text(payload.get("effort")), &mut info.effort);
                keep(text(payload.get("approval_policy")), &mut info.mode);
            }
            Some("event_msg")
                if payload.get("type").and_then(Value::as_str) == Some("token_count") =>
            {
                let Some(usage) = payload.get("info").and_then(Value::as_object) else {
                    continue;
                };
                keep(
                    count(usage.get("model_context_window")),
                    &mut info.context_window,
                );
                if let Some(last) = usage.get("last_token_usage").and_then(Value::as_object) {
                    keep(count(last.get("input_tokens")), &mut info.context_tokens);
                }
            }
            _ => {}
        }
    }
    info
}

fn to_fixed(value: f64, digits: i32) -> String {
    let places = digits as usize;
    let ties = value * 2f64.powi(digits + 1);
    let is_tie = ties.fract() == 0.0 && (ties as u64) % 2 == 1;
    if is_tie {
        let factor = 10f64.powi(digits);
        let scaled = (value * factor).floor() + 1.0;
        return format!("{:.places$}", scaled / factor);
    }
    format!("{value:.places$}")
}

pub fn format_tokens(n: u64) -> String {
    if n < THOUSAND {
        return n.to_string();
    }
    if n < MILLION {
        return format!("{}k", to_fixed(n as f64 / 1000.0, 1));
    }
    format!("{}M", to_fixed(n as f64 / 1_000_000.0, 2))
}
