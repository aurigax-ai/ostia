use ostia_base::Result;
use ostia_base::js::{js_trim, utf16_len};
use ostia_contract::utf16_prefix::utf16_prefix;
use ostia_privacy::redaction::Redactor;
use ostia_privacy::redaction_scan::SecretScan;
use ostia_privacy::redaction_targets::redact_chat_session;
use serde_json::Value;

use crate::chat_sessions::{ChatSaveResult, ChatSessionStore, normalize_chat_session};

pub const SAVE_FILE_MAX: usize = 5 * 1024 * 1024;

const FILE_NAME_MAX: usize = 120;
const RESERVED_CHARS: &str = "\\/:*?\"<>|";

pub fn safe_name(raw: &Value, fallback: &str) -> String {
    let clean: String = raw
        .as_str()
        .unwrap_or_default()
        .chars()
        .map(|ch| {
            if u32::from(ch) < 0x20 || RESERVED_CHARS.contains(ch) {
                '-'
            } else {
                ch
            }
        })
        .collect();
    let name = utf16_prefix(js_trim(&clean), FILE_NAME_MAX);
    if name.is_empty() {
        fallback.to_owned()
    } else {
        name.to_owned()
    }
}

pub fn save_file_content(content: &Value) -> Option<&str> {
    content
        .as_str()
        .filter(|text| utf16_len(text) <= SAVE_FILE_MAX)
}

pub async fn save_redacted<S: SecretScan + Send + Sync>(
    store: &ChatSessionStore,
    raw: &Value,
    redactor: &Redactor<S>,
) -> Result<ChatSaveResult> {
    let Some(session) = normalize_chat_session(raw) else {
        return store.save(raw);
    };
    match redact_chat_session(&Value::Object(session), redactor).await {
        Ok(redacted) => store.save(&redacted),
        Err(_) => Ok(ChatSaveResult::Failed {
            error: "redaction-failed".to_owned(),
        }),
    }
}
