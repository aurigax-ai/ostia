use std::fs::DirBuilder;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ostia_base::Result;
use ostia_base::atomic_write::{AtomicWriteOptions, write_file_atomic};
use ostia_base::error::io_error;
use ostia_base::json_store::load_json;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use crate::git::GraphScope;
use crate::scope::parse_scope;

pub const MAX_REMEMBERED_REPOS: usize = 200;

#[derive(Debug, Default)]
pub struct ViewState {
    pub chosen: Vec<(String, Vec<String>)>,
}

pub fn parse_view_state(raw: &Value) -> ViewState {
    let Some(chosen) = raw.get("chosen").and_then(Value::as_object) else {
        return ViewState::default();
    };
    let entries: Vec<(&String, &Value)> = chosen.iter().collect();
    let newest = &entries[entries.len().saturating_sub(MAX_REMEMBERED_REPOS)..];
    let chosen = newest
        .iter()
        .filter(|(root, _)| root.starts_with('/'))
        .filter_map(
            |(root, refs)| match parse_scope(&json!({"kind": "chosen", "refs": refs}))? {
                GraphScope::Chosen { refs } => Some(((*root).clone(), refs)),
                GraphScope::Current | GraphScope::All => None,
            },
        )
        .collect();
    ViewState { chosen }
}

#[derive(Clone)]
pub struct ViewStateStore {
    file: Option<PathBuf>,
    state: Arc<Mutex<ViewState>>,
}

impl ViewStateStore {
    pub fn new(file: Option<PathBuf>) -> Self {
        let raw = file.as_deref().and_then(load_json).unwrap_or(Value::Null);
        Self {
            file,
            state: Arc::new(Mutex::new(parse_view_state(&raw))),
        }
    }

    pub fn chosen_for(&self, root: &str) -> Option<Vec<String>> {
        self.state
            .lock()
            .chosen
            .iter()
            .find(|(key, _)| key == root)
            .map(|(_, refs)| refs.clone())
    }

    pub fn set_chosen(&self, root: &str, refs: Option<&[String]>) -> Result<()> {
        let mut state = self.state.lock();
        state.chosen.retain(|(key, _)| key != root);
        if let Some(refs) = refs.filter(|refs| !refs.is_empty()) {
            state.chosen.push((root.to_owned(), refs.to_vec()));
        }
        let excess = state.chosen.len().saturating_sub(MAX_REMEMBERED_REPOS);
        state.chosen.drain(..excess);
        self.save(&state)
    }

    fn save(&self, state: &ViewState) -> Result<()> {
        let Some(file) = &self.file else {
            return Ok(());
        };
        let chosen: Map<String, Value> = state
            .chosen
            .iter()
            .map(|(root, refs)| (root.clone(), json!(refs)))
            .collect();
        let text =
            serde_json::to_string_pretty(&json!({ "chosen": chosen })).map_err(|source| {
                ostia_base::Error::Json {
                    path: file.clone(),
                    source,
                }
            })?;
        if let Some(folder) = file
            .parent()
            .filter(|folder| !folder.as_os_str().is_empty())
        {
            create_private_folder(folder)?;
        }
        write_file_atomic(
            file,
            text.as_bytes(),
            AtomicWriteOptions {
                mode: Some(0o600),
                dir_mode: None,
            },
        )
    }
}

fn create_private_folder(folder: &Path) -> Result<()> {
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(folder)
        .map_err(io_error(folder))
}
