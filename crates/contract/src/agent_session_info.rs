use serde::Serialize;
use serde_json::{Map, Value};

use crate::utf16_prefix::utf16_prefix;
use ostia_base::js::{JsNumber, js_trim};

const FIELD_MAX: usize = 200;
const PATH_MAX: usize = 4096;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionInfo {
    pub title: Option<String>,
    pub model: Option<String>,
    pub context_tokens: Option<JsNumber>,
    pub context_window: Option<JsNumber>,
    pub cwd: Option<String>,
    pub branch: Option<String>,
    pub version: Option<String>,
    pub mode: Option<String>,
    pub effort: Option<String>,
}

fn clipped(value: Option<&Value>, max: usize) -> Option<String> {
    let text = js_trim(value?.as_str()?);
    (!text.is_empty()).then(|| utf16_prefix(text, max).to_owned())
}

fn text(value: Option<&Value>) -> Option<String> {
    clipped(value, FIELD_MAX)
}

fn path_text(value: Option<&Value>) -> Option<String> {
    clipped(value, PATH_MAX)
}

fn count(value: Option<&Value>) -> Option<f64> {
    let number = value?.as_f64().filter(|n| n.is_finite() && *n >= 0.0)?;
    Some((number + 0.5).floor())
}

fn records(lines: &[String]) -> Vec<Map<String, Value>> {
    lines
        .iter()
        .filter(|line| !js_trim(line).is_empty())
        .filter_map(|line| match serde_json::from_str::<Value>(line) {
            Ok(Value::Object(record)) => Some(record),
            _ => None,
        })
        .collect()
}

fn kind(entry: &Map<String, Value>) -> Option<&str> {
    entry.get("type").and_then(Value::as_str)
}

fn record_of(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

pub fn claude_session_info(lines: &[String]) -> AgentSessionInfo {
    let mut info = AgentSessionInfo::default();
    let mut custom_title: Option<String> = None;
    for entry in records(lines) {
        let entry_type = kind(&entry);
        match entry_type {
            Some("ai-title") => info.title = text(entry.get("aiTitle")).or(info.title),
            Some("custom-title") => {
                custom_title = text(entry.get("customTitle")).or(custom_title);
            }
            Some("permission-mode") => info.mode = text(entry.get("permissionMode")).or(info.mode),
            _ => {}
        }
        if entry.get("isSidechain") == Some(&Value::Bool(true)) {
            continue;
        }
        if entry_type != Some("user") && entry_type != Some("assistant") {
            continue;
        }
        info.cwd = path_text(entry.get("cwd")).or(info.cwd);
        info.branch = text(entry.get("gitBranch")).or(info.branch);
        info.version = text(entry.get("version")).or(info.version);
        let Some(message) = record_of(entry.get("message")) else {
            continue;
        };
        if entry_type != Some("assistant") {
            continue;
        }
        info.model = text(message.get("model")).or(info.model);
        info.effort = text(entry.get("effort")).or(info.effort);
        let Some(usage) = record_of(message.get("usage")) else {
            continue;
        };
        let parts: Vec<Option<f64>> = [
            "input_tokens",
            "cache_creation_input_tokens",
            "cache_read_input_tokens",
        ]
        .iter()
        .map(|key| count(usage.get(*key)))
        .collect();
        if parts.iter().any(Option::is_some) {
            let sum: f64 = parts.iter().map(|part| part.unwrap_or(0.0)).sum();
            info.context_tokens = Some(JsNumber(sum));
        }
    }
    if let Some(title) = custom_title.filter(|title| !title.is_empty()) {
        info.title = Some(title);
    }
    info
}

pub fn codex_session_info(lines: &[String]) -> AgentSessionInfo {
    let mut info = AgentSessionInfo::default();
    for entry in records(lines) {
        let Some(payload) = record_of(entry.get("payload")) else {
            continue;
        };
        match kind(&entry) {
            Some("session_meta") => {
                info.cwd = path_text(payload.get("cwd")).or(info.cwd);
                info.version = text(payload.get("cli_version")).or(info.version);
                info.context_window = count(payload.get("context_window"))
                    .map(JsNumber)
                    .or(info.context_window);
                if let Some(git) = record_of(payload.get("git")) {
                    info.branch = text(git.get("branch")).or(info.branch);
                }
            }
            Some("turn_context") => {
                info.model = text(payload.get("model")).or(info.model);
                info.cwd = path_text(payload.get("cwd")).or(info.cwd);
                info.effort = text(payload.get("effort")).or(info.effort);
                info.mode = text(payload.get("approval_policy")).or(info.mode);
            }
            Some("event_msg")
                if payload.get("type").and_then(Value::as_str) == Some("token_count") =>
            {
                let Some(usage) = record_of(payload.get("info")) else {
                    continue;
                };
                info.context_window = count(usage.get("model_context_window"))
                    .map(JsNumber)
                    .or(info.context_window);
                if let Some(last) = record_of(usage.get("last_token_usage")) {
                    info.context_tokens = count(last.get("input_tokens"))
                        .map(JsNumber)
                        .or(info.context_tokens);
                }
            }
            _ => {}
        }
    }
    info
}
