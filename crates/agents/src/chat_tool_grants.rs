use std::path::PathBuf;
use std::sync::Arc;

use ostia_base::Result;
use ostia_base::json_store::{SaveOptions, load_json, save_json};
use ostia_contract::assist::CHAT_TOOL_NAME_PATTERN;
use parking_lot::Mutex;
use serde_json::{Value, json};

pub const CHAT_TOOL_GRANTS_MAX: usize = 256;

const READ_OUTSIDE_GRANT: &str = "read-outside";
const MCP_TOOL_PREFIX: &str = "mcp__";
const BUILTIN_ACT_TOOLS: [&str; 2] = ["open_file", "open_url"];
const BUILTIN_OTHER_TOOLS: [&str; 9] = [
    "read_file",
    "list_directory",
    "search_files",
    "terminal_context",
    "git_status",
    "load_skill",
    "propose_command",
    "edit_file",
    "write_file",
];

fn is_standing_chat_grant(key: &str) -> bool {
    if key == READ_OUTSIDE_GRANT {
        return true;
    }
    if BUILTIN_ACT_TOOLS.contains(&key) {
        return true;
    }
    if BUILTIN_OTHER_TOOLS.contains(&key) {
        return false;
    }
    key.starts_with(MCP_TOOL_PREFIX) && CHAT_TOOL_NAME_PATTERN.is_match(key)
}

fn stored_keys(file: &std::path::Path) -> Vec<String> {
    let Some(stored) = load_json(file) else {
        return Vec::new();
    };
    let Some(keys) = stored.get("keys").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for key in keys.iter().filter_map(Value::as_str) {
        if is_standing_chat_grant(key) && !out.iter().any(|kept| kept == key) {
            out.push(key.to_owned());
        }
    }
    out.truncate(CHAT_TOOL_GRANTS_MAX);
    out
}

#[derive(Clone, Debug)]
pub struct ChatToolGrants {
    file: PathBuf,
    keys: Arc<Mutex<Vec<String>>>,
}

impl ChatToolGrants {
    pub fn new(file: PathBuf) -> Self {
        let keys = stored_keys(&file);
        Self {
            file,
            keys: Arc::new(Mutex::new(keys)),
        }
    }

    pub fn list(&self) -> Vec<String> {
        self.keys.lock().clone()
    }

    pub fn add(&self, key: &Value) -> Result<bool> {
        let Some(key) = key.as_str().filter(|key| is_standing_chat_grant(key)) else {
            return Ok(false);
        };
        let mut keys = self.keys.lock();
        if keys.iter().any(|kept| kept == key) || keys.len() >= CHAT_TOOL_GRANTS_MAX {
            return Ok(false);
        }
        keys.push(key.to_owned());
        self.save(&keys)?;
        Ok(true)
    }

    pub fn remove(&self, key: &Value) -> Result<bool> {
        let Some(key) = key.as_str() else {
            return Ok(false);
        };
        let mut keys = self.keys.lock();
        if !keys.iter().any(|kept| kept == key) {
            return Ok(false);
        }
        keys.retain(|kept| kept != key);
        self.save(&keys)?;
        Ok(true)
    }

    fn save(&self, keys: &[String]) -> Result<()> {
        save_json(&self.file, &json!({"keys": keys}), SaveOptions::SECURE)
    }
}
