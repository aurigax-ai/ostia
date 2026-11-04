use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::join_all;
use parking_lot::Mutex;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::sleep;

pub const SAVE_WAIT: Duration = Duration::from_secs(10);

type Waiter = (u64, watch::Receiver<()>);

#[derive(Default)]
struct State {
    next_id: u64,
    by_path: HashMap<String, Vec<Waiter>>,
}

#[derive(Clone, Default)]
pub struct PendingSaves {
    state: Arc<Mutex<State>>,
}

struct Entry {
    state: Arc<Mutex<State>>,
    path: String,
    id: u64,
    _done: watch::Sender<()>,
}

impl Drop for Entry {
    fn drop(&mut self) {
        let mut state = self.state.lock();
        if let Some(waiters) = state.by_path.get_mut(&self.path) {
            waiters.retain(|(id, _)| *id != self.id);
            if waiters.is_empty() {
                state.by_path.remove(&self.path);
            }
        }
    }
}

impl PendingSaves {
    pub fn track<T, Save>(&self, file_path: &str, save: Save) -> JoinHandle<T>
    where
        Save: Future<Output = T> + Send + 'static,
        T: Send + 'static,
    {
        let (done, waiting) = watch::channel(());
        let id = {
            let mut state = self.state.lock();
            let id = state.next_id;
            state.next_id += 1;
            state
                .by_path
                .entry(file_path.to_owned())
                .or_default()
                .push((id, waiting));
            id
        };
        let entry = Entry {
            state: Arc::clone(&self.state),
            path: file_path.to_owned(),
            id,
            _done: done,
        };
        tokio::spawn(async move {
            let _entry = entry;
            save.await
        })
    }

    pub fn settle(
        &self,
        file_paths: &[&str],
        timeout: Duration,
    ) -> impl Future<Output = ()> + use<> {
        let waits: Vec<watch::Receiver<()>> = {
            let state = self.state.lock();
            file_paths
                .iter()
                .flat_map(|path| state.by_path.get(*path).into_iter().flatten())
                .map(|(_, waiting)| waiting.clone())
                .collect()
        };
        let limit = (!waits.is_empty() && !timeout.is_zero()).then(|| sleep(timeout));
        async move {
            let Some(limit) = limit else {
                return;
            };
            let all_done = join_all(waits.into_iter().map(|mut waiting| async move {
                let _ = waiting.changed().await;
            }));
            tokio::select! {
                _ = all_done => {}
                () = limit => {}
            }
        }
    }
}
