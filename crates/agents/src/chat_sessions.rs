use std::collections::HashSet;
use std::fs::{self, DirBuilder};
use std::os::unix::fs::DirBuilderExt;
use std::path::PathBuf;
use std::sync::LazyLock;

use ostia_base::Result;
use ostia_base::atomic_write::{AtomicWriteOptions, write_file_atomic};
use ostia_base::error::io_error;
use ostia_base::js::{JS_SPACE_CLASS, js_trim, static_regex, utf16_len};
use ostia_base::js_json::parse_js_json;
use ostia_contract::assist_payloads::normalize_chat_context_item;
use ostia_contract::assist_reports::normalize_model_ref;
use ostia_contract::utf16_prefix::utf16_prefix;
use regex::Regex;
use serde_json::{Map, Number, Value, json};

pub const CHAT_EDIT_TEXT_MAX: usize = 64 * 1024;

const CHAT_TITLE_MAX: usize = 120;
const CHAT_SESSION_MAX_BYTES: usize = 512 * 1024;
const CHAT_TOTAL_MAX_BYTES: usize = 16 * 1024 * 1024;
const CHAT_SESSIONS_MAX: usize = 500;
const CHAT_SESSION_MESSAGES_MAX: usize = 400;
const CHAT_SESSION_EDITS_MAX: usize = 200;
const EDIT_DECISIONS_MAX: usize = 5000;
const EDIT_PATH_MAX: usize = 4096;
const TEXT_MAX: usize = 100_000;
const PART_JSON_MAX: usize = 64 * 1024;
const SHORT_MAX: usize = 200;
const ID_MAX: usize = 128;
const CLIP_STEPS: [usize; 4] = [16_000, 4000, 1000, 200];
const CLIP_MARK: &str = "…[truncated]";
const CLIP_DEPTH_MAX: usize = 8;
const ROLES: [&str; 3] = ["system", "user", "assistant"];
const SAFE_INTEGER_LIMIT: f64 = 9_007_199_254_740_992.0;

static CHAT_SESSION_ID_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9_-]{1,64}$"));
static VERSION_PATTERN: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[0-9a-f]{64}$"));
static PART_TYPE_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[a-z][a-z0-9-]{0,63}$"));
static SPACE_RUN: LazyLock<Regex> = LazyLock::new(|| static_regex(&format!("[{JS_SPACE_CLASS}]+")));

type Object = Map<String, Value>;

#[derive(Clone, Debug, PartialEq)]
pub enum ChatSaveResult {
    Saved {
        summary: Value,
        trimmed_messages: usize,
        evicted: Vec<String>,
    },
    Failed {
        error: String,
    },
}

#[derive(Clone, Debug)]
pub struct ChatSessionStoreOptions {
    pub dir: PathBuf,
    pub session_max_bytes: usize,
    pub total_max_bytes: usize,
    pub max_sessions: usize,
}

impl ChatSessionStoreOptions {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            session_max_bytes: CHAT_SESSION_MAX_BYTES,
            total_max_bytes: CHAT_TOTAL_MAX_BYTES,
            max_sessions: CHAT_SESSIONS_MAX,
        }
    }
}

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

fn chat_title(raw: Option<&Value>) -> String {
    let Some(text) = raw.and_then(Value::as_str) else {
        return String::new();
    };
    let folded = SPACE_RUN.replace_all(text, " ");
    utf16_prefix(js_trim(&folded), CHAT_TITLE_MAX).to_owned()
}

fn is_tool_part_type(kind: &str) -> bool {
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

fn tool_call_ids_of(messages: &[Value]) -> HashSet<String> {
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

pub(crate) fn normalize_chat_session(raw: &Value) -> Option<Object> {
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
    Some(session)
}

fn messages_of(session: &Object) -> &[Value] {
    match session.get("messages") {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

fn chat_summary(session: &Object) -> Value {
    let mut summary: Object = session
        .iter()
        .filter(|(key, _)| *key != "messages" && *key != "edits")
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    summary.insert("messageCount".to_owned(), json!(messages_of(session).len()));
    Value::Object(summary)
}

fn size_of(session: &Object) -> usize {
    serde_json::to_string(session).map_or(0, |text| text.len())
}

fn drop_orphan_edits(session: &mut Object) {
    let Some(Value::Array(current)) = session.get("edits") else {
        return;
    };
    let calls = tool_call_ids_of(messages_of(session));
    let kept: Vec<Value> = current
        .iter()
        .filter(|edit| {
            edit.get("toolCallId")
                .and_then(Value::as_str)
                .is_some_and(|id| calls.contains(id))
        })
        .cloned()
        .collect();
    if kept.is_empty() {
        session.shift_remove("edits");
    } else {
        session.insert("edits".to_owned(), Value::Array(kept));
    }
}

fn without_leading(session: &Object, count: usize) -> Object {
    let mut candidate: Object = session
        .iter()
        .filter(|(key, _)| *key != "messages")
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    let rest: Vec<Value> = messages_of(session).iter().skip(count).cloned().collect();
    candidate.insert("messages".to_owned(), Value::Array(rest));
    drop_orphan_edits(&mut candidate);
    candidate
}

fn leading_to_drop(session: &Object, max_bytes: usize) -> usize {
    let count = messages_of(session).len();
    if count <= 1 || size_of(session) <= max_bytes {
        return 0;
    }
    let mut low = 0;
    let mut high = count - 1;
    while low < high {
        let mid = (low + high) / 2;
        if size_of(&without_leading(session, mid)) <= max_bytes {
            high = mid;
        } else {
            low = mid + 1;
        }
    }
    low
}

fn first_role_is_user(session: &Object) -> bool {
    messages_of(session)
        .first()
        .and_then(|message| message.get("role"))
        .and_then(Value::as_str)
        == Some("user")
}

fn messages_mut(session: &mut Object) -> Option<&mut Vec<Value>> {
    session.get_mut("messages").and_then(Value::as_array_mut)
}

fn trim_session(session: &mut Object, max_bytes: usize) -> usize {
    let mut dropped = leading_to_drop(session, max_bytes);
    if let Some(messages) = messages_mut(session) {
        messages.drain(..dropped.min(messages.len()));
    }
    drop_orphan_edits(session);
    while !messages_of(session).is_empty() && !first_role_is_user(session) {
        if let Some(messages) = messages_mut(session) {
            messages.remove(0);
        }
        dropped += 1;
    }
    drop_orphan_edits(session);
    if dropped > 0 {
        session.insert("trimmed".to_owned(), Value::Bool(true));
    }
    let count = messages_of(session).len();
    session.insert("messageCount".to_owned(), json!(count));
    dropped
}

fn updated_at_of(session: &Object) -> f64 {
    session
        .get("updatedAt")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
}

struct EvictEntry {
    id: String,
    size: u64,
    updated_at: f64,
}

#[derive(Clone, Debug)]
pub struct ChatSessionStore {
    options: ChatSessionStoreOptions,
}

impl ChatSessionStore {
    pub fn new(options: ChatSessionStoreOptions) -> Self {
        Self { options }
    }

    fn file(&self, id: &str) -> PathBuf {
        self.options.dir.join(format!("{id}.json"))
    }

    fn read(&self, id: &str) -> Option<Object> {
        if !CHAT_SESSION_ID_PATTERN.is_match(id) {
            return None;
        }
        let bytes = fs::read(self.file(id)).ok()?;
        let parsed = parse_js_json(&String::from_utf8_lossy(&bytes)).ok()?;
        let session = normalize_chat_session(&parsed)?;
        (session.get("id").and_then(Value::as_str) == Some(id)).then_some(session)
    }

    fn ids(&self) -> Vec<String> {
        let Ok(entries) = fs::read_dir(&self.options.dir) else {
            return Vec::new();
        };
        entries
            .filter_map(std::result::Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name();
                let id = name.to_str()?.strip_suffix(".json")?.to_owned();
                CHAT_SESSION_ID_PATTERN.is_match(&id).then_some(id)
            })
            .collect()
    }

    fn write(&self, session: &Object) -> Result<()> {
        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&self.options.dir)
            .map_err(io_error(&self.options.dir))?;
        let id = session
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let text = serde_json::to_string(session).map_err(|source| ostia_base::Error::Json {
            path: self.file(id),
            source,
        })?;
        write_file_atomic(
            &self.file(id),
            text.as_bytes(),
            AtomicWriteOptions {
                mode: Some(0o600),
                dir_mode: None,
            },
        )
    }

    fn evict(&self, keep: &str) -> Result<Vec<String>> {
        let mut entries: Vec<EvictEntry> = self
            .ids()
            .into_iter()
            .filter_map(|id| {
                let size = fs::metadata(self.file(&id)).ok()?.len();
                let updated_at = self.read(&id).map_or(0.0, |s| updated_at_of(&s));
                Some(EvictEntry {
                    id,
                    size,
                    updated_at,
                })
            })
            .collect();
        entries.sort_by(|a, b| {
            a.updated_at
                .partial_cmp(&b.updated_at)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let total_max = u64::try_from(self.options.total_max_bytes).unwrap_or(u64::MAX);
        let mut total: u64 = entries.iter().map(|entry| entry.size).sum();
        let mut count = entries.len();
        let mut evicted = Vec::new();
        for entry in entries {
            if total <= total_max && count <= self.options.max_sessions {
                break;
            }
            if entry.id == keep {
                continue;
            }
            let path = self.file(&entry.id);
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => return Err(io_error(&path)(err)),
            }
            total = total.saturating_sub(entry.size);
            count -= 1;
            evicted.push(entry.id);
        }
        Ok(evicted)
    }

    pub fn list(&self) -> Vec<Value> {
        let mut sessions: Vec<Object> = self.ids().iter().filter_map(|id| self.read(id)).collect();
        sessions.sort_by(|a, b| {
            updated_at_of(b)
                .partial_cmp(&updated_at_of(a))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        sessions.iter().map(chat_summary).collect()
    }

    pub fn get(&self, id: &str) -> Option<Value> {
        self.read(id).map(Value::Object)
    }

    pub fn save(&self, raw: &Value) -> Result<ChatSaveResult> {
        let Some(mut session) = normalize_chat_session(raw) else {
            return Ok(ChatSaveResult::Failed {
                error: "invalid-session".to_owned(),
            });
        };
        let trimmed_messages = trim_session(&mut session, self.options.session_max_bytes);
        self.write(&session)?;
        let id = session
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        Ok(ChatSaveResult::Saved {
            summary: chat_summary(&session),
            trimmed_messages,
            evicted: self.evict(&id)?,
        })
    }

    pub fn rename(&self, id: &str, title: &str) -> Result<Option<Value>> {
        let session = self.read(id);
        let next = chat_title(Some(&Value::String(title.to_owned())));
        let Some(mut session) = session else {
            return Ok(None);
        };
        if next.is_empty() {
            return Ok(None);
        }
        session.insert("title".to_owned(), json!(next));
        self.write(&session)?;
        Ok(Some(chat_summary(&session)))
    }

    pub fn remove(&self, id: &str) -> Result<bool> {
        if !CHAT_SESSION_ID_PATTERN.is_match(id) || !self.file(id).exists() {
            return Ok(false);
        }
        let path = self.file(id);
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(io_error(&path)(err)),
        }
        Ok(true)
    }
}
