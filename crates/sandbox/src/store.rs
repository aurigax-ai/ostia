use std::path::{Path, PathBuf};
use std::sync::Arc;

use ostia_base::Result;
use ostia_base::WorkspaceId;
use ostia_base::json_store::{SaveOptions, load_json, save_json};
use ostia_contract::sandbox::WorkspaceSandbox;
use ostia_contract::sandbox_parse::parse_workspace_sandbox;
use parking_lot::Mutex;
use serde::{Serialize, Serializer};
use serde_json::Value;

#[derive(Default)]
struct State {
    entries: Vec<(WorkspaceId, WorkspaceSandbox)>,
    corrupt: bool,
}

impl State {
    fn position(&self, workspace_id: &WorkspaceId) -> Option<usize> {
        self.entries.iter().position(|(id, _)| id == workspace_id)
    }
}

struct Entries<'a>(&'a [(WorkspaceId, WorkspaceSandbox)]);

impl Serialize for Entries<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.collect_map(self.0.iter().map(|(id, sandbox)| (id.as_str(), sandbox)))
    }
}

#[derive(Clone)]
pub struct SandboxStore {
    path: Arc<PathBuf>,
    state: Arc<Mutex<State>>,
}

fn load(path: &Path) -> State {
    if !path.exists() {
        return State::default();
    }
    match parse_file(path) {
        Some(entries) => State {
            entries,
            corrupt: false,
        },
        None => State {
            entries: Vec::new(),
            corrupt: true,
        },
    }
}

fn parse_file(path: &Path) -> Option<Vec<(WorkspaceId, WorkspaceSandbox)>> {
    let Value::Object(raw) = load_json(path)? else {
        return None;
    };
    raw.iter()
        .map(|(id, value)| {
            Some((
                WorkspaceId::new(id.as_str()),
                parse_workspace_sandbox(value)?,
            ))
        })
        .collect()
}

impl SandboxStore {
    pub fn new(path: PathBuf) -> Self {
        let state = load(&path);
        Self {
            path: Arc::new(path),
            state: Arc::new(Mutex::new(state)),
        }
    }

    pub fn is_corrupt(&self) -> bool {
        self.state.lock().corrupt
    }

    pub fn get(&self, workspace_id: &WorkspaceId) -> WorkspaceSandbox {
        let state = self.state.lock();
        state
            .position(workspace_id)
            .map_or_else(WorkspaceSandbox::empty, |index| {
                state.entries[index].1.clone()
            })
    }

    pub fn has(&self, workspace_id: &WorkspaceId) -> bool {
        self.state.lock().position(workspace_id).is_some()
    }

    pub fn set(
        &self,
        workspace_id: &WorkspaceId,
        next: WorkspaceSandbox,
    ) -> Result<WorkspaceSandbox> {
        let mut state = self.state.lock();
        match state.position(workspace_id) {
            Some(index) => state.entries[index].1 = next.clone(),
            None => state.entries.push((workspace_id.clone(), next.clone())),
        }
        self.save(&state)?;
        Ok(next)
    }

    pub fn remove(&self, workspace_id: &WorkspaceId) -> Result<()> {
        let mut state = self.state.lock();
        let Some(index) = state.position(workspace_id) else {
            return Ok(());
        };
        state.entries.remove(index);
        self.save(&state)
    }

    fn save(&self, state: &State) -> Result<()> {
        if state.corrupt {
            return Ok(());
        }
        save_json(&self.path, &Entries(&state.entries), SaveOptions::SECURE)
    }
}
