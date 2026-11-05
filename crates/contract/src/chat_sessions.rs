use std::collections::HashSet;
use std::sync::LazyLock;

use ostia_base::js::{
    JS_SPACE_CLASS, is_js_space, js_number_text, js_trim, static_regex, utf16_len,
};
use regex::Regex;
use serde_json::{Map, Number, Value, json};

use crate::assist_payloads::normalize_chat_context_item;
use crate::assist_reports::normalize_model_ref;
use crate::utf16_prefix::utf16_prefix;

pub const CHAT_EDIT_TEXT_MAX: usize = 64 * 1024;

pub const CHAT_TITLE_MAX: usize = 120;
pub const CHAT_SESSION_MAX_BYTES: usize = 512 * 1024;
pub const CHAT_TOTAL_MAX_BYTES: usize = 16 * 1024 * 1024;
pub const CHAT_SESSIONS_MAX: usize = 500;
const CHAT_SESSION_MESSAGES_MAX: usize = 400;
const CHAT_SESSION_EDITS_MAX: usize = 200;
const EDIT_DECISIONS_MAX: usize = 5000;
const EDIT_PATH_MAX: usize = 4096;
const TEXT_MAX: usize = 100_000;
const PART_JSON_MAX: usize = 64 * 1024;
const SHORT_MAX: usize = 200;
const ID_MAX: usize = 128;
const CLIP_STEPS: [usize; 4] = [16_000, 4000, 1000, 200];
const MARKDOWN_TOOL_MAX: usize = 4000;
const CLIP_MARK: &str = "…[truncated]";
const CLIP_DEPTH_MAX: usize = 8;
const ROLES: [&str; 3] = ["system", "user", "assistant"];
const SAFE_INTEGER_LIMIT: f64 = 9_007_199_254_740_992.0;

pub static CHAT_SESSION_ID_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9_-]{1,64}$"));
static VERSION_PATTERN: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[0-9a-f]{64}$"));
static PART_TYPE_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[a-z][a-z0-9-]{0,63}$"));
static SPACE_RUN: LazyLock<Regex> = LazyLock::new(|| static_regex(&format!("[{JS_SPACE_CLASS}]+")));

pub type Object = Map<String, Value>;

fn finite(value: Option<&Value>) -> Option<Number> {
    match value {
        Some(Value::Number(number)) => Some(number.clone()),
        _ => None,
    }
}

fn short(value: Option<&Value>, max: usize) -> Option<String> {
    let text = utf16_prefix(js_trim(value?.as_str()?), max);
    (!text.is_empty()).then(|| text.to_owned())
}

pub fn chat_title(raw: Option<&Value>) -> String {
    let Some(text) = raw.and_then(Value::as_str) else {
        return String::new();
    };
    let folded = SPACE_RUN.replace_all(text, " ");
    utf16_prefix(js_trim(&folded), CHAT_TITLE_MAX).to_owned()
}

pub fn is_tool_part_type(kind: &str) -> bool {
    kind == "dynamic-tool" || kind.starts_with("tool-")
}

fn clip_strings(value: &Value, max: usize, depth: usize) -> Value {
    if let Value::String(text) = value {
        return if utf16_len(text) > max {
            Value::String(format!("{}{CLIP_MARK}", utf16_prefix(text, max)))
        } else {
            value.clone()
        };
    }
    if depth > CLIP_DEPTH_MAX {
        return Value::Null;
    }
    match value {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| clip_strings(item, max, depth + 1))
                .collect(),
        ),
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, item)| (key.clone(), clip_strings(item, max, depth + 1)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn json_fits(value: &Value) -> bool {
    serde_json::to_string(value).is_ok_and(|text| utf16_len(&text) <= PART_JSON_MAX)
}

fn part(raw: &Value) -> Option<Value> {
    let fields = raw.as_object()?;
    let kind = fields
        .get("type")?
        .as_str()
        .filter(|kind| PART_TYPE_PATTERN.is_match(kind))?;
    if kind == "text" || kind == "reasoning" {
        let text = fields.get("text")?.as_str()?;
        return Some(json!({"type": kind, "text": utf16_prefix(text, TEXT_MAX)}));
    }
    if json_fits(raw) {
        return Some(raw.clone());
    }
    if !is_tool_part_type(kind) {
        return None;
    }
    CLIP_STEPS
        .iter()
        .map(|max| clip_strings(raw, *max, 0))
        .find(json_fits)
}

fn context(raw: Option<&Value>) -> Option<Value> {
    let items: Vec<Value> = raw?
        .as_array()?
        .iter()
        .filter_map(normalize_chat_context_item)
        .collect();
    (!items.is_empty()).then_some(Value::Array(items))
}

fn metadata(raw: Option<&Value>) -> Option<Value> {
    let fields = raw?.as_object()?;
    let mut out = Object::new();
    if let Some(created_at) = finite(fields.get("createdAt")) {
        out.insert("createdAt".to_owned(), Value::Number(created_at));
    }
    if let Some(items) = context(fields.get("context")) {
        out.insert("context".to_owned(), items);
    }
    if let Some(model) = short(fields.get("model"), SHORT_MAX) {
        out.insert("model".to_owned(), Value::String(model));
    }
    if let Some(error) = short(fields.get("error"), 500) {
        out.insert("error".to_owned(), Value::String(error));
    }
    if fields.get("stopped") == Some(&Value::Bool(true)) {
        out.insert("stopped".to_owned(), Value::Bool(true));
    }
    (!out.is_empty()).then_some(Value::Object(out))
}

fn message(raw: &Value) -> Option<Value> {
    let fields = raw.as_object()?;
    let role = fields
        .get("role")?
        .as_str()
        .filter(|role| ROLES.contains(role))?;
    let id = fields
        .get("id")?
        .as_str()
        .filter(|id| utf16_len(id) <= ID_MAX && !id.is_empty())?;
    let parts: Vec<Value> = fields
        .get("parts")?
        .as_array()?
        .iter()
        .filter_map(part)
        .collect();
    let mut out = Object::new();
    out.insert("id".to_owned(), json!(id));
    out.insert("role".to_owned(), json!(role));
    out.insert("parts".to_owned(), Value::Array(parts));
    if let Some(meta) = metadata(fields.get("metadata")) {
        out.insert("metadata".to_owned(), meta);
    }
    Some(Value::Object(out))
}

fn edit_path(value: Option<&Value>) -> Option<&str> {
    value?
        .as_str()
        .filter(|path| path.starts_with('/') && utf16_len(path) <= EDIT_PATH_MAX)
}

fn decision(value: &Value) -> Value {
    match value.as_str() {
        Some(kind @ ("accepted" | "rejected")) => json!(kind),
        _ => Value::Null,
    }
}

fn kept_text(value: Option<&Value>) -> Option<&str> {
    value?
        .as_str()
        .filter(|text| utf16_len(text) <= CHAT_EDIT_TEXT_MAX)
}

fn floored(seq: &Number) -> Number {
    if seq.is_i64() || seq.is_u64() {
        return seq.clone();
    }
    let value = seq.as_f64().unwrap_or(0.0).floor();
    if value.abs() < SAFE_INTEGER_LIMIT {
        Number::from(value as i64)
    } else {
        Number::from_f64(value).unwrap_or_else(|| Number::from(0))
    }
}

fn flag(fields: &Object, key: &str) -> Value {
    Value::Bool(fields.get(key) == Some(&Value::Bool(true)))
}

fn normalize_chat_edit(raw: &Value) -> Option<Object> {
    let fields = raw.as_object()?;
    let tool_call_id = fields
        .get("toolCallId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && utf16_len(id) <= ID_MAX)?;
    let path = edit_path(fields.get("path"))?;
    let root = edit_path(fields.get("root"))?;
    let seq = finite(fields.get("seq")).filter(|seq| seq.as_f64().is_some_and(|v| v >= 0.0))?;
    let state = fields
        .get("state")
        .and_then(Value::as_str)
        .filter(|state| *state == "applied" || *state == "undone")?;
    let version = match fields.get("version") {
        Some(Value::Null) => Value::Null,
        Some(Value::String(text)) if VERSION_PATTERN.is_match(text) => json!(text),
        _ => return None,
    };
    let decisions: Vec<Value> = match fields.get("decisions") {
        Some(Value::Array(items)) => items
            .iter()
            .take(EDIT_DECISIONS_MAX)
            .map(decision)
            .collect(),
        _ => Vec::new(),
    };
    let mut edit = Object::new();
    edit.insert("toolCallId".to_owned(), json!(tool_call_id));
    edit.insert("path".to_owned(), json!(path));
    edit.insert("root".to_owned(), json!(root));
    edit.insert("existed".to_owned(), flag(fields, "existed"));
    edit.insert("outside".to_owned(), flag(fields, "outside"));
    edit.insert("symlink".to_owned(), flag(fields, "symlink"));
    edit.insert("auto".to_owned(), flag(fields, "auto"));
    edit.insert("state".to_owned(), json!(state));
    edit.insert("version".to_owned(), version);
    edit.insert("seq".to_owned(), Value::Number(floored(&seq)));
    edit.insert("decisions".to_owned(), Value::Array(decisions));
    if let (Some(before), Some(after)) = (
        kept_text(fields.get("before")),
        kept_text(fields.get("after")),
    ) {
        edit.insert("before".to_owned(), json!(before));
        edit.insert("after".to_owned(), json!(after));
    }
    Some(edit)
}

pub fn tool_call_ids_of(messages: &[Value]) -> HashSet<String> {
    messages
        .iter()
        .filter_map(|message| message.get("parts")?.as_array())
        .flatten()
        .filter(|part| {
            part.get("type")
                .and_then(Value::as_str)
                .is_some_and(is_tool_part_type)
        })
        .filter_map(|part| part.get("toolCallId")?.as_str())
        .map(str::to_owned)
        .collect()
}

fn seq_of(edit: &Object) -> f64 {
    edit.get("seq").and_then(Value::as_f64).unwrap_or(0.0)
}

fn edits(raw: Option<&Value>, messages: &[Value]) -> Vec<Value> {
    let Some(Value::Array(items)) = raw else {
        return Vec::new();
    };
    let calls = tool_call_ids_of(messages);
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<Object> = Vec::new();
    for item in items {
        let Some(edit) = normalize_chat_edit(item) else {
            continue;
        };
        let id = edit
            .get("toolCallId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if seen.contains(&id) || !calls.contains(&id) {
            continue;
        }
        seen.insert(id);
        out.push(edit);
    }
    out.sort_by(|a, b| {
        seq_of(a)
            .partial_cmp(&seq_of(b))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let skip = out.len().saturating_sub(CHAT_SESSION_EDITS_MAX);
    out.into_iter().skip(skip).map(Value::Object).collect()
}

pub fn normalize_chat_session(raw: &Value) -> Option<Value> {
    let fields = raw.as_object()?;
    let id = fields
        .get("id")?
        .as_str()
        .filter(|id| CHAT_SESSION_ID_PATTERN.is_match(id))?;
    let created_at = finite(fields.get("createdAt"))?;
    let updated_at = finite(fields.get("updatedAt"))?;
    let all: Vec<Value> = fields
        .get("messages")?
        .as_array()?
        .iter()
        .filter_map(message)
        .collect();
    let skip = all.len().saturating_sub(CHAT_SESSION_MESSAGES_MAX);
    let messages: Vec<Value> = all.into_iter().skip(skip).collect();
    let mut session = Object::new();
    session.insert("id".to_owned(), json!(id));
    let title = chat_title(fields.get("title"));
    session.insert(
        "title".to_owned(),
        json!(if title.is_empty() {
            "Chat"
        } else {
            title.as_str()
        }),
    );
    session.insert("createdAt".to_owned(), Value::Number(created_at));
    session.insert("updatedAt".to_owned(), Value::Number(updated_at));
    session.insert("messageCount".to_owned(), json!(messages.len()));
    let kept = edits(fields.get("edits"), &messages);
    session.insert("messages".to_owned(), Value::Array(messages));
    if let Some(workspace_id) = short(fields.get("workspaceId"), 64) {
        session.insert("workspaceId".to_owned(), json!(workspace_id));
    }
    if let Some(model) = short(fields.get("model"), SHORT_MAX) {
        session.insert("model".to_owned(), json!(model));
    }
    if let Some(model_ref) = fields.get("modelRef").and_then(normalize_model_ref) {
        session.insert("modelRef".to_owned(), serde_json::to_value(model_ref).ok()?);
    }
    if fields.get("trimmed") == Some(&Value::Bool(true)) {
        session.insert("trimmed".to_owned(), Value::Bool(true));
    }
    if !kept.is_empty() {
        session.insert("edits".to_owned(), Value::Array(kept));
    }
    Some(Value::Object(session))
}

pub fn chat_summary_object(session: &Object) -> Value {
    let mut summary: Object = session
        .iter()
        .filter(|(key, _)| *key != "messages" && *key != "edits")
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    let count = session
        .get("messages")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    summary.insert("messageCount".to_owned(), json!(count));
    Value::Object(summary)
}

pub fn chat_summary(session: &Value) -> Value {
    session.as_object().map_or(Value::Null, chat_summary_object)
}

fn fence(text: &str, lang: &str) -> [String; 3] {
    let ticks = if text.contains("```") { "````" } else { "```" };
    [format!("{ticks}{lang}"), text.to_owned(), ticks.to_owned()]
}

fn clipped(text: &str) -> String {
    if utf16_len(text) > MARKDOWN_TOOL_MAX {
        format!("{}{CLIP_MARK}", utf16_prefix(text, MARKDOWN_TOOL_MAX))
    } else {
        text.to_owned()
    }
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => js_number_text(number.as_f64().unwrap_or(0.0)),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

fn tool_name(part: &Object, kind: &str) -> String {
    if kind == "dynamic-tool" {
        return match part.get("toolName") {
            None | Some(Value::Null) => "tool".to_owned(),
            Some(name) => js_string(name),
        };
    }
    kind.strip_prefix("tool-").unwrap_or_default().to_owned()
}

fn state_label(state: &str) -> &'static str {
    match state {
        "output-available" => "done",
        "output-error" => "failed",
        "output-denied" => "denied",
        _ => "not run",
    }
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

fn tool_markdown(part: &Object, kind: &str) -> Vec<String> {
    let state = part
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut lines = vec![
        format!("> Tool `{}`: {}", tool_name(part, kind), state_label(state)),
        String::new(),
    ];
    if let Some(input) = part.get("input")
        && serde_json::to_string(input).unwrap_or_default() != "{}"
    {
        lines.extend(fence(&clipped(&pretty(input)), "json"));
        lines.push(String::new());
    }
    if state == "output-available" {
        let output = match part.get("output") {
            None => String::new(),
            Some(Value::String(text)) => text.clone(),
            Some(other) => pretty(other),
        };
        lines.extend(fence(&clipped(&output), ""));
        lines.push(String::new());
    }
    if state == "output-error"
        && let Some(Value::String(text)) = part.get("errorText")
    {
        lines.extend(fence(&clipped(text), ""));
        lines.push(String::new());
    }
    lines
}

fn flush(text: &mut String, lines: &mut Vec<String>) {
    if !js_trim(text).is_empty() {
        lines.push(std::mem::take(text));
        lines.push(String::new());
    } else {
        text.clear();
    }
}

fn context_markdown(message: &Value, lines: &mut Vec<String>) {
    let items = message
        .get("metadata")
        .and_then(|meta| meta.get("context"))
        .and_then(Value::as_array);
    for item in items.into_iter().flatten() {
        let label = item.get("label").map_or_else(String::new, js_string);
        let text = item.get("text").map_or_else(String::new, js_string);
        lines.push(format!("> {label}"));
        lines.push(String::new());
        lines.push("```".to_owned());
        lines.push(text);
        lines.push("```".to_owned());
        lines.push(String::new());
    }
}

pub fn chat_markdown(session: &Value) -> String {
    let title = session.get("title").map_or_else(String::new, js_string);
    let mut lines = vec![format!("# {title}"), String::new()];
    if let Some(model) = session
        .get("model")
        .and_then(Value::as_str)
        .filter(|model| !model.is_empty())
    {
        lines.push(format!("Model: {model}"));
        lines.push(String::new());
    }
    let messages = session
        .get("messages")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    for message in messages {
        let role = message.get("role").and_then(Value::as_str);
        if role == Some("system") {
            continue;
        }
        let heading = if role == Some("user") {
            "## You"
        } else {
            "## Assistant"
        };
        lines.push(heading.to_owned());
        lines.push(String::new());
        context_markdown(message, &mut lines);
        let mut text = String::new();
        let parts = message
            .get("parts")
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice);
        for part in parts {
            let Some(fields) = part.as_object() else {
                continue;
            };
            let kind = fields
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if kind == "text" {
                if let Some(Value::String(chunk)) = fields.get("text") {
                    text.push_str(chunk);
                }
            } else if is_tool_part_type(kind) {
                flush(&mut text, &mut lines);
                lines.extend(tool_markdown(fields, kind));
            }
        }
        flush(&mut text, &mut lines);
    }
    format!("{}\n", lines.join("\n").trim_end_matches(is_js_space))
}
