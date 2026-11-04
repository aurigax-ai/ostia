use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ostia_base::Result;
use ostia_base::json_store::{SaveOptions, load_json, save_json};
use ostia_contract::language_servers::{
    LanguageServerOverride, LanguageServerOverrideProblem, parse_language_server_override,
    split_language_server_key,
};
use ostia_contract::proto_guard::is_dangerous_segment;
use parking_lot::Mutex;
use rustix::fs::{Access, access};
use serde_json::{Map, Value};

const MAX_OVERRIDES: usize = 256;

pub fn override_file_problem(path: &Path) -> Option<LanguageServerOverrideProblem> {
    let Ok(meta) = fs::metadata(path) else {
        return Some(LanguageServerOverrideProblem::Missing);
    };
    if !meta.is_file() {
        return Some(LanguageServerOverrideProblem::NotFile);
    }
    if access(path, Access::EXEC_OK).is_err() {
        return Some(LanguageServerOverrideProblem::NotExecutable);
    }
    None
}

fn sanitize(raw: &Value) -> Vec<(String, LanguageServerOverride)> {
    let mut out = Vec::new();
    let Some(entries) = raw.as_object() else {
        return out;
    };
    for (key, value) in entries {
        if out.len() >= MAX_OVERRIDES {
            break;
        }
        if is_dangerous_segment(key)
            || split_language_server_key(&Value::String(key.clone())).is_none()
        {
            continue;
        }
        if let Ok(parsed) = parse_language_server_override(value) {
            out.push((key.clone(), parsed));
        }
    }
    out
}

struct Overrides {
    file: PathBuf,
    entries: Vec<(String, LanguageServerOverride)>,
}

impl Overrides {
    fn save(&self) -> Result<()> {
        let mut object = Map::new();
        for (key, value) in &self.entries {
            object.insert(
                key.clone(),
                serde_json::json!({"path": value.path, "args": value.args}),
            );
        }
        save_json(&self.file, &Value::Object(object), SaveOptions::default())
    }
}

#[derive(Clone)]
pub struct ServerOverrides {
    inner: Arc<Mutex<Overrides>>,
}

impl ServerOverrides {
    pub fn new(file: PathBuf) -> Self {
        let entries = sanitize(&load_json(&file).unwrap_or_else(|| Value::Object(Map::new())));
        Self {
            inner: Arc::new(Mutex::new(Overrides { file, entries })),
        }
    }

    pub fn get(&self, key: &str) -> Option<LanguageServerOverride> {
        self.inner
            .lock()
            .entries
            .iter()
            .find(|(known, _)| known == key)
            .map(|(_, value)| value.clone())
    }

    pub fn choose(&self, key: &str, raw: &Value) -> Result<Option<LanguageServerOverrideProblem>> {
        if split_language_server_key(&Value::String(key.to_owned())).is_none() {
            return Ok(Some(LanguageServerOverrideProblem::UnknownServer));
        }
        let mut state = self.inner.lock();
        if raw.is_null() {
            let before = state.entries.len();
            state.entries.retain(|(known, _)| known != key);
            if state.entries.len() != before {
                state.save()?;
            }
            return Ok(None);
        }
        let parsed = match parse_language_server_override(raw) {
            Ok(parsed) => parsed,
            Err(problem) => return Ok(Some(problem)),
        };
        if let Some(problem) = override_file_problem(Path::new(&parsed.path)) {
            return Ok(Some(problem));
        }
        match state.entries.iter_mut().find(|(known, _)| known == key) {
            Some(entry) => entry.1 = parsed,
            None => state.entries.push((key.to_owned(), parsed)),
        }
        state.save()?;
        Ok(None)
    }

    pub fn forget_extension(&self, ext_id: &str) -> Result<()> {
        let mut state = self.inner.lock();
        let before = state.entries.len();
        state.entries.retain(|(key, _)| {
            split_language_server_key(&Value::String(key.clone()))
                .is_none_or(|parts| parts.ext_id != ext_id)
        });
        if state.entries.len() != before {
            state.save()?;
        }
        Ok(())
    }
}
