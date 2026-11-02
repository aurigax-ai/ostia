use std::sync::Arc;

use parking_lot::Mutex;

#[derive(Default)]
struct State {
    work_dirs: Vec<(String, String)>,
    windows: Vec<(String, String)>,
}

fn put(entries: &mut Vec<(String, String)>, key: &str, value: &str) {
    match entries.iter_mut().find(|(known, _)| known == key) {
        Some(entry) => entry.1 = value.to_owned(),
        None => entries.push((key.to_owned(), value.to_owned())),
    }
}

fn get(entries: &[(String, String)], key: &str) -> Option<String> {
    entries
        .iter()
        .find(|(known, _)| known == key)
        .map(|(_, value)| value.clone())
}

#[derive(Clone, Default)]
pub struct WorkspaceRegistry {
    state: Arc<Mutex<State>>,
}

impl WorkspaceRegistry {
    pub fn set_work_dir(&self, workspace_id: &str, work_dir: &str, window_id: Option<&str>) {
        let mut state = self.state.lock();
        put(&mut state.work_dirs, workspace_id, work_dir);
        if let Some(window_id) = window_id.filter(|id| !id.is_empty()) {
            put(&mut state.windows, workspace_id, window_id);
        }
    }

    pub fn remove(&self, workspace_id: &str) {
        let mut state = self.state.lock();
        state.work_dirs.retain(|(known, _)| known != workspace_id);
        state.windows.retain(|(known, _)| known != workspace_id);
    }

    pub fn work_dir_for(&self, workspace_id: Option<&str>) -> Option<String> {
        let workspace_id = workspace_id.filter(|id| !id.is_empty())?;
        get(&self.state.lock().work_dirs, workspace_id)
    }

    pub fn known(&self) -> Vec<String> {
        self.state
            .lock()
            .work_dirs
            .iter()
            .map(|(id, _)| id.clone())
            .collect()
    }

    pub fn window_for(&self, workspace_id: &str) -> Option<String> {
        get(&self.state.lock().windows, workspace_id)
    }
}
