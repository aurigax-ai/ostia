use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use tokio::runtime::Handle;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CoreFeature {
    Git,
    Ports,
}

type Sink = dyn Fn(CoreFeature, Vec<String>) + Send + Sync;

#[derive(Default)]
struct FeatureWatch {
    counts: HashMap<String, usize>,
    queued: bool,
    sent: String,
}

#[derive(Default)]
struct WatchState {
    git: FeatureWatch,
    ports: FeatureWatch,
}

impl WatchState {
    fn feature(&self, feature: CoreFeature) -> &FeatureWatch {
        match feature {
            CoreFeature::Git => &self.git,
            CoreFeature::Ports => &self.ports,
        }
    }

    fn feature_mut(&mut self, feature: CoreFeature) -> &mut FeatureWatch {
        match feature {
            CoreFeature::Git => &mut self.git,
            CoreFeature::Ports => &mut self.ports,
        }
    }
}

struct Shared {
    runtime: Handle,
    state: Mutex<WatchState>,
    delivery: Mutex<()>,
    sink: Box<Sink>,
}

fn sorted_ids(counts: &HashMap<String, usize>) -> Vec<String> {
    let mut ids: Vec<String> = counts.keys().cloned().collect();
    ids.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    ids
}

#[derive(Clone)]
pub struct CoreWatch {
    shared: Arc<Shared>,
}

impl CoreWatch {
    pub fn new<F>(runtime: Handle, sink: F) -> Self
    where
        F: Fn(CoreFeature, Vec<String>) + Send + Sync + 'static,
    {
        Self {
            shared: Arc::new(Shared {
                runtime,
                state: Mutex::new(WatchState::default()),
                delivery: Mutex::new(()),
                sink: Box::new(sink),
            }),
        }
    }

    pub fn watch_workspace(&self, feature: CoreFeature, workspace_id: &str) -> WatchRelease {
        {
            let mut state = self.shared.state.lock();
            let counts = &mut state.feature_mut(feature).counts;
            *counts.entry(workspace_id.to_owned()).or_insert(0) += 1;
        }
        self.queue(feature);
        WatchRelease {
            watch: self.clone(),
            feature,
            workspace_id: workspace_id.to_owned(),
            released: false,
        }
    }

    pub fn watched_workspaces(&self, feature: CoreFeature) -> Vec<String> {
        let state = self.shared.state.lock();
        sorted_ids(&state.feature(feature).counts)
    }

    pub fn reset(&self) {
        *self.shared.state.lock() = WatchState::default();
    }

    fn unwatch(&self, feature: CoreFeature, workspace_id: &str) {
        {
            let mut state = self.shared.state.lock();
            let watch = state.feature_mut(feature);
            let left = watch.counts.get(workspace_id).copied().unwrap_or(1) - 1;
            if left > 0 {
                watch.counts.insert(workspace_id.to_owned(), left);
            } else {
                watch.counts.remove(workspace_id);
            }
        }
        self.queue(feature);
    }

    fn queue(&self, feature: CoreFeature) {
        let newly_queued = {
            let mut state = self.shared.state.lock();
            let watch = state.feature_mut(feature);
            let was_queued = watch.queued;
            watch.queued = true;
            !was_queued
        };
        if newly_queued {
            let this = self.clone();
            self.shared.runtime.spawn(async move {
                this.flush(feature);
            });
        }
    }

    fn flush(&self, feature: CoreFeature) {
        let _delivery = self.shared.delivery.lock();
        let ids = {
            let mut state = self.shared.state.lock();
            let watch = state.feature_mut(feature);
            watch.queued = false;
            let ids = sorted_ids(&watch.counts);
            let key = ids.join("\u{0}");
            if key == watch.sent {
                return;
            }
            watch.sent = key;
            ids
        };
        (self.shared.sink)(feature, ids);
    }
}

pub struct WatchRelease {
    watch: CoreWatch,
    feature: CoreFeature,
    workspace_id: String,
    released: bool,
}

impl WatchRelease {
    pub fn release(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        self.watch.unwatch(self.feature, &self.workspace_id);
    }
}

impl Drop for WatchRelease {
    fn drop(&mut self) {
        self.release();
    }
}
