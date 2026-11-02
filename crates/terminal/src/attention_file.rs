use std::fs::OpenOptions;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use ostia_base::js::js_trim;
use ostia_base::js_json::parse_js_json;
use ostia_contract::attention::KeptAttentionState;
use ostia_contract::utf16_prefix::utf16_prefix;
use serde_json::{Value, json};

const ATTENTION_FILE_SUFFIX: &str = ".state";
const MESSAGE_MAX: usize = 300;
const FILE_MAX_BYTES: usize = 4096;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SavedAttention {
    pub state: KeptAttentionState,
    pub message: Option<String>,
}

impl SavedAttention {
    fn to_json(&self) -> String {
        let value = match &self.message {
            Some(message) => json!({"state": self.state.as_str(), "message": message}),
            None => json!({"state": self.state.as_str()}),
        };
        value.to_string()
    }
}

pub fn attention_file_for(token_file: &str) -> PathBuf {
    PathBuf::from(format!("{token_file}{ATTENTION_FILE_SUFFIX}"))
}

pub fn parse_saved_attention(raw: &str) -> Option<SavedAttention> {
    if raw.len() > FILE_MAX_BYTES {
        return None;
    }
    let parsed = parse_js_json(raw).ok()?;
    let state = KeptAttentionState::parse(parsed.get("state")?.as_str()?)?;
    let message = parsed
        .get("message")
        .and_then(Value::as_str)
        .map(|message| utf16_prefix(js_trim(message), MESSAGE_MAX).to_owned())
        .filter(|message| !message.is_empty());
    Some(SavedAttention { state, message })
}

pub fn write_saved_attention(
    file: &Path,
    attention: Option<&SavedAttention>,
) -> std::io::Result<()> {
    let text = attention.map_or_else(String::new, SavedAttention::to_json);
    let mut handle = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(file)?;
    handle.write_all(text.as_bytes())
}

pub fn read_saved_attention(file: &Path) -> Option<SavedAttention> {
    let bytes = std::fs::read(file).ok()?;
    parse_saved_attention(&String::from_utf8_lossy(&bytes))
}
