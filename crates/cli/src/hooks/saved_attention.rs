use std::fs::OpenOptions;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use serde_json::json;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeptAttentionState {
    Working,
    Waiting,
    Done,
    Error,
}

impl KeptAttentionState {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "working" => Some(Self::Working),
            "waiting" => Some(Self::Waiting),
            "done" => Some(Self::Done),
            "error" => Some(Self::Error),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Working => "working",
            Self::Waiting => "waiting",
            Self::Done => "done",
            Self::Error => "error",
        }
    }
}

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
    PathBuf::from(format!("{token_file}.state"))
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
