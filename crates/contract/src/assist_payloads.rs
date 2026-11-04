use ostia_base::js::{js_trim, utf16_len};
use serde_json::{Map, Number, Value};

use crate::assist::{
    AssistPoint, AssistTask, CHAT_CONTEXT_MAX, CHAT_CONTEXT_TEXT_MAX, CHAT_MESSAGE_MAX,
    CHAT_MESSAGES_MAX, CHAT_REPLY_MAX, CHAT_TOOL_CALL_ID_MAX, CHAT_TOOL_CALLS_MAX,
    CHAT_TOOL_DESCRIPTION_MAX, CHAT_TOOL_ERROR_MAX, CHAT_TOOL_INPUT_MAX, CHAT_TOOL_NAME_PATTERN,
    CHAT_TOOL_OUTPUT_MAX, CHAT_TOOL_SCHEMA_MAX, CHAT_TOOLS_MAX, COMMAND_QUERY_MAX,
    COMMAND_SUGGESTIONS_MAX, COMMAND_TEXT_MAX, COMPLETION_NEIGHBOR_TEXT_MAX,
    COMPLETION_NEIGHBORS_MAX, COMPLETION_PREFIX_MAX, COMPLETION_SUFFIX_MAX, COMPLETION_TEXT_MAX,
    ChatContextKind, ChatToolState, INPUT_TEXT_MAX, REVIEW_NOTE_MAX, REVIEW_NOTES_MAX,
    TERMINAL_COMPLETION_MAX, TERMINAL_CONTEXT_MAX, TERMINAL_CONTEXT_TEXT_MAX,
    TERMINAL_HISTORY_COMMAND_MAX, TERMINAL_HISTORY_MAX, TERMINAL_LINE_MAX,
};
use crate::string_enum::StringEnum;
use crate::utf16_prefix::utf16_prefix;

pub const SHORT_MAX: usize = 200;
const PATH_MAX: usize = 4096;
const TOKEN_MAX: usize = 40;
const LABEL_MAX: usize = 80;

type Object = Map<String, Value>;

fn utf16_suffix(text: &str, units: usize) -> &str {
    let mut used = 0;
    for (index, ch) in text.char_indices().rev() {
        used += ch.len_utf16();
        if used > units {
            return &text[index + ch.len_utf8()..];
        }
    }
    text
}

fn js_integer(value: Option<&Value>) -> Option<Number> {
    let Value::Number(number) = value? else {
        return None;
    };
    if number.is_i64() || number.is_u64() {
        return Some(number.clone());
    }
    let float = number.as_f64()?;
    if !float.is_finite() || float.fract() != 0.0 {
        return None;
    }
    if float.abs() < 9.0e15 {
        Some(Number::from(float as i64))
    } else {
        Number::from_f64(float)
    }
}

fn line_number(value: Option<&Value>) -> Option<Number> {
    js_integer(value).filter(|number| number.as_f64().is_some_and(|float| float >= 1.0))
}

fn clip(value: Option<&Value>, max: usize) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(|text| utf16_prefix(text, max).to_string())
}

pub fn optional_short(value: Option<&Value>, max: usize) -> Option<String> {
    let text = utf16_prefix(js_trim(value?.as_str()?), max);
    (!text.is_empty()).then(|| text.to_string())
}

fn put<T: Into<Value>>(object: &mut Object, key: &str, value: Option<T>) {
    if let Some(value) = value {
        object.insert(key.to_string(), value.into());
    }
}

pub fn normalize_chat_context_item(raw: &Value) -> Option<Value> {
    let raw = raw.as_object()?;
    let kind = raw
        .get("kind")
        .and_then(Value::as_str)
        .filter(|kind| ChatContextKind::ALL.contains(kind))?;
    let label = optional_short(raw.get("label"), SHORT_MAX)?;
    let text = clip(raw.get("text"), CHAT_CONTEXT_TEXT_MAX).filter(|text| !text.is_empty())?;
    let mut item = Object::new();
    item.insert("kind".to_string(), kind.into());
    item.insert("label".to_string(), label.into());
    item.insert("text".to_string(), text.into());
    if let Some(path) =
        optional_short(raw.get("path"), PATH_MAX).filter(|path| path.starts_with('/'))
    {
        item.insert("path".to_string(), path.into());
        let start = line_number(raw.get("startLine"));
        let end = line_number(raw.get("endLine"));
        if let (Some(start), Some(end)) = (start, end)
            && end.as_f64() >= start.as_f64()
        {
            item.insert("startLine".to_string(), start.into());
            item.insert("endLine".to_string(), end.into());
        }
    }
    Some(Value::Object(item))
}

fn input_request(raw: &Object) -> Option<Value> {
    let text = clip(raw.get("text"), INPUT_TEXT_MAX)?;
    if js_trim(&text).is_empty() {
        return None;
    }
    let requested = raw
        .get("tasks")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let tasks: Vec<&str> = AssistTask::ALL
        .iter()
        .copied()
        .filter(|task| requested.iter().any(|item| item.as_str() == Some(*task)))
        .collect();
    if tasks.is_empty() {
        return None;
    }
    let mut out = Object::new();
    out.insert("text".to_string(), text.into());
    out.insert("tasks".to_string(), tasks.into());
    put(
        &mut out,
        "agent",
        optional_short(raw.get("agent"), TOKEN_MAX),
    );
    Some(Value::Object(out))
}

fn command_request(raw: &Object) -> Option<Value> {
    let query = clip(raw.get("query"), COMMAND_QUERY_MAX)?;
    let query = js_trim(&query);
    if query.is_empty() {
        return None;
    }
    let mut out = Object::new();
    out.insert("query".to_string(), query.into());
    put(&mut out, "cwd", optional_short(raw.get("cwd"), PATH_MAX));
    put(
        &mut out,
        "shell",
        optional_short(raw.get("shell"), TOKEN_MAX),
    );
    put(
        &mut out,
        "platform",
        optional_short(raw.get("platform"), TOKEN_MAX),
    );
    Some(Value::Object(out))
}

fn neighbors(raw: Option<&Value>) -> Option<Vec<Value>> {
    let list = raw?.as_array()?;
    let mut out = Vec::new();
    for item in list.iter().take(COMPLETION_NEIGHBORS_MAX) {
        let Some(item) = item.as_object() else {
            continue;
        };
        let path = optional_short(item.get("path"), PATH_MAX);
        let text = clip(item.get("text"), COMPLETION_NEIGHBOR_TEXT_MAX);
        if let (Some(path), Some(text)) = (path, text)
            && !text.is_empty()
        {
            let mut neighbor = Object::new();
            neighbor.insert("path".to_string(), path.into());
            neighbor.insert("text".to_string(), text.into());
            out.push(Value::Object(neighbor));
        }
    }
    (!out.is_empty()).then_some(out)
}

fn completion_request(raw: &Object) -> Option<Value> {
    let path = optional_short(raw.get("path"), PATH_MAX)?;
    let language = optional_short(raw.get("language"), TOKEN_MAX)?;
    let prefix = utf16_suffix(raw.get("prefix")?.as_str()?, COMPLETION_PREFIX_MAX);
    let suffix = clip(raw.get("suffix"), COMPLETION_SUFFIX_MAX)?;
    let mut out = Object::new();
    out.insert("path".to_string(), path.into());
    out.insert("language".to_string(), language.into());
    out.insert("prefix".to_string(), prefix.into());
    out.insert("suffix".to_string(), suffix.into());
    put(&mut out, "neighbors", neighbors(raw.get("neighbors")));
    Some(Value::Object(out))
}

fn terminal_request(raw: &Object) -> Option<Value> {
    let line = clip(raw.get("line"), TERMINAL_LINE_MAX)?;
    if js_trim(&line).is_empty() {
        return None;
    }
    let history_items = raw
        .get("history")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let history_start = history_items.len().saturating_sub(TERMINAL_HISTORY_MAX);
    let mut history = Vec::new();
    for item in &history_items[history_start..] {
        let Some(item) = item.as_object() else {
            continue;
        };
        let Some(command) = optional_short(item.get("command"), TERMINAL_HISTORY_COMMAND_MAX)
        else {
            continue;
        };
        let mut entry = Object::new();
        entry.insert("command".to_string(), command.into());
        if let Some(code) = js_integer(item.get("exitCode")) {
            entry.insert("exitCode".to_string(), code.into());
        }
        history.push(Value::Object(entry));
    }
    let context_items = raw
        .get("context")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut context = Vec::new();
    for item in context_items.iter().take(TERMINAL_CONTEXT_MAX) {
        let Some(item) = item.as_object() else {
            continue;
        };
        let label = optional_short(item.get("label"), LABEL_MAX);
        let text = optional_short(item.get("text"), TERMINAL_CONTEXT_TEXT_MAX);
        if let (Some(label), Some(text)) = (label, text) {
            let mut entry = Object::new();
            entry.insert("label".to_string(), label.into());
            entry.insert("text".to_string(), text.into());
            context.push(Value::Object(entry));
        }
    }
    let mut out = Object::new();
    out.insert("line".to_string(), line.into());
    put(&mut out, "cwd", optional_short(raw.get("cwd"), PATH_MAX));
    put(
        &mut out,
        "shell",
        optional_short(raw.get("shell"), TOKEN_MAX),
    );
    put(
        &mut out,
        "platform",
        optional_short(raw.get("platform"), TOKEN_MAX),
    );
    put(
        &mut out,
        "history",
        (!history.is_empty()).then_some(history),
    );
    put(
        &mut out,
        "context",
        (!context.is_empty()).then_some(context),
    );
    Some(Value::Object(out))
}

fn json_object(value: Option<&Value>, max: usize) -> Option<Object> {
    let object = value?.as_object()?;
    let json = serde_json::to_string(object).ok()?;
    (utf16_len(&json) <= max).then(|| object.clone())
}

fn tool_call(raw: &Value) -> Option<Value> {
    let raw = raw.as_object()?;
    let id = raw
        .get("id")
        .and_then(Value::as_str)
        .map_or("", |id| utf16_prefix(id, CHAT_TOOL_CALL_ID_MAX));
    let name = raw.get("name").and_then(Value::as_str).unwrap_or("");
    if id.is_empty() || !CHAT_TOOL_NAME_PATTERN.is_match(name) {
        return None;
    }
    let state = raw
        .get("state")
        .and_then(Value::as_str)
        .filter(|state| ChatToolState::ALL.contains(state))?;
    let input = match raw.get("input") {
        None | Some(Value::Null) => Object::new(),
        other => json_object(other, CHAT_TOOL_INPUT_MAX).unwrap_or_default(),
    };
    let mut call = Object::new();
    call.insert("id".to_string(), id.into());
    call.insert("name".to_string(), name.into());
    call.insert("input".to_string(), Value::Object(input));
    call.insert("state".to_string(), state.into());
    if state == "done" {
        let output = clip(raw.get("output"), CHAT_TOOL_OUTPUT_MAX).unwrap_or_default();
        call.insert("output".to_string(), output.into());
    }
    if state == "error" {
        let error = clip(raw.get("error"), CHAT_TOOL_ERROR_MAX)
            .filter(|error| !error.is_empty())
            .unwrap_or_else(|| "failed".to_string());
        call.insert("error".to_string(), error.into());
    }
    Some(Value::Object(call))
}

fn chat_message(item: &Value) -> Option<Value> {
    let item = item.as_object()?;
    let role = item
        .get("role")
        .and_then(Value::as_str)
        .filter(|role| matches!(*role, "user" | "assistant"))?;
    let content = clip(item.get("content"), CHAT_MESSAGE_MAX)?;
    let mut message = Object::new();
    message.insert("role".to_string(), role.into());
    message.insert("content".to_string(), content.into());
    let listed = item
        .get("tools")
        .and_then(Value::as_array)
        .filter(|tools| !tools.is_empty());
    if let (Some(listed), "assistant") = (listed, role) {
        let tools: Vec<Value> = listed
            .iter()
            .take(CHAT_TOOL_CALLS_MAX)
            .filter_map(tool_call)
            .collect();
        if !tools.is_empty() {
            message.insert("tools".to_string(), Value::Array(tools));
        }
    }
    Some(Value::Object(message))
}

fn tool_specs(raw: Option<&Value>) -> Option<Vec<Value>> {
    let list = raw?.as_array()?;
    let mut out: Vec<Value> = Vec::new();
    for item in list {
        if out.len() == CHAT_TOOLS_MAX {
            break;
        }
        let Some(item) = item.as_object() else {
            continue;
        };
        let Some(name) = item.get("name").and_then(Value::as_str) else {
            continue;
        };
        if !CHAT_TOOL_NAME_PATTERN.is_match(name)
            || out.iter().any(|tool| tool["name"].as_str() == Some(name))
        {
            continue;
        }
        let description = clip(item.get("description"), CHAT_TOOL_DESCRIPTION_MAX)
            .map(|text| js_trim(&text).to_string())
            .filter(|text| !text.is_empty());
        let schema = json_object(item.get("inputSchema"), CHAT_TOOL_SCHEMA_MAX);
        let (Some(description), Some(schema)) = (description, schema) else {
            continue;
        };
        if schema.get("type").and_then(Value::as_str) != Some("object") {
            continue;
        }
        let mut spec = Object::new();
        spec.insert("name".to_string(), name.into());
        spec.insert("description".to_string(), description.into());
        spec.insert("inputSchema".to_string(), Value::Object(schema));
        out.push(Value::Object(spec));
    }
    (!out.is_empty()).then_some(out)
}

fn ends_turn(messages: &[Value]) -> bool {
    messages.last().is_some_and(|last| {
        last["role"] == "user"
            || last["tools"]
                .as_array()
                .is_some_and(|tools| !tools.is_empty())
    })
}

fn chat_request(raw: &Object) -> Option<Value> {
    let list = raw.get("messages")?.as_array()?;
    let start = list.len().saturating_sub(CHAT_MESSAGES_MAX);
    let mut messages = Vec::new();
    for item in &list[start..] {
        messages.push(chat_message(item)?);
    }
    let first_user = messages
        .iter()
        .position(|message| message["role"] == "user")
        .unwrap_or(messages.len());
    messages.drain(..first_user);
    if !ends_turn(&messages) {
        return None;
    }
    let context_items = raw
        .get("context")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let context: Vec<Value> = context_items
        .iter()
        .take(CHAT_CONTEXT_MAX)
        .filter_map(normalize_chat_context_item)
        .collect();
    let mut out = Object::new();
    out.insert("messages".to_string(), Value::Array(messages));
    out.insert("context".to_string(), Value::Array(context));
    put(&mut out, "tools", tool_specs(raw.get("tools")));
    Some(Value::Object(out))
}

pub fn normalize_assist_request(point: AssistPoint, raw: &Value) -> Option<Value> {
    let raw = raw.as_object()?;
    match point {
        AssistPoint::Input => input_request(raw),
        AssistPoint::Command => command_request(raw),
        AssistPoint::Completion => completion_request(raw),
        AssistPoint::Terminal => terminal_request(raw),
        AssistPoint::Chat => chat_request(raw),
    }
}

fn input_result(raw: &Object) -> Value {
    let mut out = Object::new();
    if let Some(corrected) =
        clip(raw.get("corrected"), INPUT_TEXT_MAX).filter(|text| !js_trim(text).is_empty())
    {
        out.insert("corrected".to_string(), corrected.into());
    }
    if let Some(review) = raw.get("review").and_then(Value::as_object) {
        let notes: Vec<Value> = review
            .get("notes")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .filter_map(|note| optional_short(Some(note), REVIEW_NOTE_MAX))
            .take(REVIEW_NOTES_MAX)
            .map(Value::from)
            .collect();
        let mut entry = Object::new();
        entry.insert("notes".to_string(), Value::Array(notes));
        if let Some(score) = review.get("score").and_then(Value::as_f64) {
            let rounded = (score + 0.5).floor().clamp(1.0, 5.0);
            entry.insert("score".to_string(), Value::from(rounded as i64));
        }
        out.insert("review".to_string(), Value::Object(entry));
    }
    Value::Object(out)
}

fn command_result(raw: &Object) -> Value {
    let mut suggestions: Vec<Value> = Vec::new();
    let items = raw
        .get("suggestions")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    for item in items {
        let Some(item) = item.as_object() else {
            continue;
        };
        let Some(command) = clip(item.get("command"), COMMAND_TEXT_MAX) else {
            continue;
        };
        let command = js_trim(&command);
        if command.is_empty()
            || suggestions
                .iter()
                .any(|entry| entry["command"].as_str() == Some(command))
        {
            continue;
        }
        let mut entry = Object::new();
        entry.insert("command".to_string(), command.into());
        put(
            &mut entry,
            "description",
            optional_short(item.get("description"), SHORT_MAX),
        );
        suggestions.push(Value::Object(entry));
        if suggestions.len() == COMMAND_SUGGESTIONS_MAX {
            break;
        }
    }
    let mut out = Object::new();
    out.insert("suggestions".to_string(), Value::Array(suggestions));
    Value::Object(out)
}

fn text_result(text: String) -> Value {
    let mut out = Object::new();
    out.insert("text".to_string(), text.into());
    Value::Object(out)
}

pub fn normalize_assist_result(point: AssistPoint, raw: &Value) -> Value {
    let empty = Object::new();
    let raw = raw.as_object().unwrap_or(&empty);
    match point {
        AssistPoint::Input => input_result(raw),
        AssistPoint::Command => command_result(raw),
        AssistPoint::Completion => {
            text_result(clip(raw.get("text"), COMPLETION_TEXT_MAX).unwrap_or_default())
        }
        AssistPoint::Terminal => {
            let text = clip(raw.get("text"), TERMINAL_COMPLETION_MAX).unwrap_or_default();
            text_result(text.split('\n').next().unwrap_or_default().to_string())
        }
        AssistPoint::Chat => text_result(clip(raw.get("text"), CHAT_REPLY_MAX).unwrap_or_default()),
    }
}
