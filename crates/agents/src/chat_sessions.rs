use std::fs::{self, DirBuilder};
use std::os::unix::fs::DirBuilderExt;
use std::path::PathBuf;

use ostia_base::Result;
use ostia_base::atomic_write::{AtomicWriteOptions, write_file_atomic};
use ostia_base::error::io_error;
use ostia_base::js_json::parse_js_json;
pub use ostia_contract::chat_sessions::CHAT_EDIT_TEXT_MAX;
use ostia_contract::chat_sessions::{
    CHAT_SESSION_ID_PATTERN, CHAT_SESSION_MAX_BYTES, CHAT_SESSIONS_MAX, CHAT_TOTAL_MAX_BYTES,
    Object, chat_summary_object, chat_title, normalize_chat_session, tool_call_ids_of,
};
use serde_json::{Value, json};

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

pub fn normalized_object(raw: &Value) -> Option<Object> {
    match normalize_chat_session(raw)? {
        Value::Object(session) => Some(session),
        _ => None,
    }
}

fn messages_of(session: &Object) -> &[Value] {
    match session.get("messages") {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
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
        let session = normalized_object(&parsed)?;
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
        sessions.iter().map(chat_summary_object).collect()
    }

    pub fn get(&self, id: &str) -> Option<Value> {
        self.read(id).map(Value::Object)
    }

    pub fn save(&self, raw: &Value) -> Result<ChatSaveResult> {
        let Some(mut session) = normalized_object(raw) else {
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
            summary: chat_summary_object(&session),
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
        Ok(Some(chat_summary_object(&session)))
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
