use std::future::Future;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ostia_base::host::Host;
use ostia_base::json_store::{SaveOptions, StoreScope, load_json, save_json_async, store_path};
use ostia_base::{Error, Result};
use ostia_contract::proto_guard::is_dangerous_segment;
use ostia_terminal::pty_ring_buffer::tail_cut;
use parking_lot::Mutex;
use serde_json::{Map, Value};
use tokio::runtime::Handle;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::workspace_snapshot::{MAX_PANES, snapshot_path};

pub const SCROLLBACK_CAP_BYTES: usize = 131_072;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RestoreOutcome {
    Ok,
    None,
    Failed,
}

pub fn scrollback_path(host: &Host) -> PathBuf {
    store_path(host, "scrollback", StoreScope::Global, None)
}

pub fn trim_scrollback(data: &str, cap_bytes: usize) -> String {
    let units: Vec<u16> = data.encode_utf16().collect();
    let cut = tail_cut(data, cap_bytes);
    String::from_utf16_lossy(&units[cut..])
}

pub fn scrollback_to_save(
    by_pane: &[(String, String)],
    unsaved: &dyn Fn(&str) -> bool,
) -> Vec<(String, String)> {
    let mut kept = Vec::new();
    for (pane_id, data) in by_pane {
        if kept.len() >= MAX_PANES {
            break;
        }
        if data.is_empty() || is_dangerous_segment(pane_id) || unsaved(pane_id) {
            continue;
        }
        kept.push((pane_id.clone(), trim_scrollback(data, SCROLLBACK_CAP_BYTES)));
    }
    kept
}

#[derive(Default)]
struct State {
    restored: Vec<(String, String)>,
    epoch: u64,
    writes: Option<oneshot::Receiver<()>>,
}

#[derive(Clone)]
pub struct SavedScrollback {
    host: Host,
    state: Arc<Mutex<State>>,
}

impl SavedScrollback {
    pub fn new(host: Host) -> Self {
        Self {
            host,
            state: Arc::new(Mutex::new(State::default())),
        }
    }

    fn queue<Fut>(&self, work: Fut) -> Result<JoinHandle<Result<()>>>
    where
        Fut: Future<Output = Result<()>> + Send + 'static,
    {
        let runtime = Handle::try_current().map_err(|error| Error::Task(error.to_string()))?;
        let (done, finished) = oneshot::channel::<()>();
        let before = self.state.lock().writes.replace(finished);
        Ok(runtime.spawn(async move {
            if let Some(before) = before {
                let _ = before.await;
            }
            let outcome = work.await;
            let _ = done.send(());
            outcome
        }))
    }

    pub fn save_scrollback(
        &self,
        by_pane: &[(String, String)],
        unsaved: &dyn Fn(&str) -> bool,
    ) -> impl Future<Output = Result<()>> + use<> {
        let started_at = self.state.lock().epoch;
        let data = scrollback_to_save(by_pane, unsaved);
        let record: Map<String, Value> = data
            .into_iter()
            .map(|(pane_id, text)| (pane_id, Value::String(text)))
            .collect();
        let path = scrollback_path(&self.host);
        let state = Arc::clone(&self.state);
        let handle = self.queue(async move {
            let current = state.lock().epoch;
            if current != started_at {
                return Ok(());
            }
            save_json_async(&path, &record, SaveOptions::default()).await
        });
        async move {
            handle?
                .await
                .map_err(|error| Error::Task(error.to_string()))?
        }
    }

    pub fn load_restored_scrollback(&self) -> RestoreOutcome {
        let path = scrollback_path(&self.host);
        if !path.exists() {
            self.state.lock().restored.clear();
            return RestoreOutcome::None;
        }
        let Some(Value::Object(record)) = load_json(&path) else {
            self.state.lock().restored.clear();
            return RestoreOutcome::Failed;
        };
        let restored = record
            .into_iter()
            .filter_map(|(pane_id, data)| match data {
                Value::String(text) if !text.is_empty() && !is_dangerous_segment(&pane_id) => {
                    Some((pane_id, text))
                }
                _ => None,
            })
            .collect();
        self.state.lock().restored = restored;
        RestoreOutcome::Ok
    }

    pub fn take_restored_scrollback(&self, pane_id: &str) -> Option<String> {
        let mut state = self.state.lock();
        let index = state.restored.iter().position(|(id, _)| id == pane_id)?;
        Some(state.restored.remove(index).1)
    }

    pub fn stash_scrollback(&self, pane_id: &str, data: &str) {
        if data.is_empty() || is_dangerous_segment(pane_id) {
            return;
        }
        let text = trim_scrollback(data, SCROLLBACK_CAP_BYTES);
        let mut state = self.state.lock();
        if let Some(index) = state.restored.iter().position(|(id, _)| id == pane_id) {
            state.restored[index].1 = text;
        } else {
            state.restored.push((pane_id.to_owned(), text));
        }
    }

    pub fn pending_restored_scrollback(&self) -> Vec<(String, String)> {
        self.state.lock().restored.clone()
    }

    pub fn drop_restored_scrollback(&self, pane_id: &str) {
        let mut state = self.state.lock();
        if let Some(index) = state.restored.iter().position(|(id, _)| id == pane_id) {
            state.restored.remove(index);
        }
    }

    pub fn clear_persisted(&self) -> impl Future<Output = Result<()>> + use<> {
        {
            let mut state = self.state.lock();
            state.restored.clear();
            state.epoch += 1;
        }
        let scrollback = scrollback_path(&self.host);
        let outcome = remove_if_present(&snapshot_path(&self.host))
            .and_then(|()| remove_if_present(&scrollback));
        let handle = self.queue(async move { remove_if_present(&scrollback) });
        async move {
            outcome?;
            handle?
                .await
                .map_err(|error| Error::Task(error.to_string()))?
        }
    }
}

fn remove_if_present(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(source) if source.kind() == ErrorKind::NotFound => Ok(()),
        Err(source) => Err(Error::Io {
            path: path.to_path_buf(),
            source,
        }),
    }
}
