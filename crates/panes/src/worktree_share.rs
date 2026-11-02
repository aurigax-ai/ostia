use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use ostia_base::js::non_empty;
use parking_lot::Mutex;
use tokio::runtime::Handle;

const DEBOUNCE: Duration = Duration::from_millis(400);

#[derive(Clone, Debug)]
pub struct SharePane {
    pub pane_id: String,
    pub agent: Option<String>,
    pub cwd: Option<String>,
    pub hibernated: bool,
    pub agent_session_id: Option<String>,
}

pub trait WorktreeShareDeps: Send + Sync + 'static {
    type Error: Send + 'static;

    fn panes(&self) -> impl Future<Output = Result<Vec<SharePane>, Self::Error>> + Send;
    fn key(&self, cwd: &str) -> impl Future<Output = Result<Option<String>, Self::Error>> + Send;
    fn identity(&self, external_id: &str) -> Option<String>;
    fn remote(&self, pane_id: &str) -> bool;
}

#[derive(Clone)]
struct Cached {
    cwd: String,
    session: Option<String>,
    key: Option<String>,
}

struct Inner<D> {
    deps: D,
    runtime: Handle,
    keys: Mutex<HashMap<String, Cached>>,
    shared: Mutex<HashMap<String, Vec<String>>>,
    scheduled: AtomicBool,
}

pub struct WorktreeShare<D>(Arc<Inner<D>>);

impl<D> Clone for WorktreeShare<D> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

impl<D: WorktreeShareDeps> WorktreeShare<D> {
    pub fn new(deps: D, runtime: Handle) -> Self {
        Self(Arc::new(Inner {
            deps,
            runtime,
            keys: Mutex::new(HashMap::new()),
            shared: Mutex::new(HashMap::new()),
            scheduled: AtomicBool::new(false),
        }))
    }

    pub fn schedule(&self) {
        if self.0.scheduled.swap(true, Ordering::SeqCst) {
            return;
        }
        let share = self.clone();
        self.0.runtime.spawn(async move {
            tokio::time::sleep(DEBOUNCE).await;
            share.0.scheduled.store(false, Ordering::SeqCst);
            let _ = share.check().await;
        });
    }

    pub fn others(&self, external_id: &str) -> Vec<String> {
        self.0
            .shared
            .lock()
            .get(external_id)
            .cloned()
            .unwrap_or_default()
    }

    pub async fn check(&self) -> Result<(), D::Error> {
        let inner = &*self.0;
        let entries: Vec<SharePane> = inner
            .deps
            .panes()
            .await?
            .into_iter()
            .filter(|pane| {
                non_empty(pane.agent.as_deref()).is_some()
                    && !pane.hibernated
                    && non_empty(pane.cwd.as_deref()).is_some()
            })
            .collect();
        let live: HashSet<String> = entries.iter().map(|pane| pane.pane_id.clone()).collect();
        inner.keys.lock().retain(|id, _| live.contains(id));

        let mut groups: HashMap<String, Vec<String>> = HashMap::new();
        for pane in &entries {
            let Some(cwd) = non_empty(pane.cwd.as_deref()) else {
                continue;
            };
            let Some(identity) = inner.deps.identity(&pane.pane_id) else {
                continue;
            };
            if inner.deps.remote(&identity) {
                continue;
            }
            let known = inner.keys.lock().get(&pane.pane_id).cloned();
            let same = known
                .as_ref()
                .is_some_and(|k| k.cwd == cwd && k.session == pane.agent_session_id);
            let key = if same {
                known.and_then(|k| k.key)
            } else {
                inner.deps.key(cwd).await?
            };
            if !same {
                inner.keys.lock().insert(
                    pane.pane_id.clone(),
                    Cached {
                        cwd: cwd.to_owned(),
                        session: pane.agent_session_id.clone(),
                        key: key.clone(),
                    },
                );
            }
            if let Some(key) = key {
                groups.entry(key).or_default().push(pane.pane_id.clone());
            }
        }

        let mut shared: HashMap<String, Vec<String>> = HashMap::new();
        for members in groups.values().filter(|members| members.len() >= 2) {
            for member in members {
                let others = members
                    .iter()
                    .filter(|other| *other != member)
                    .cloned()
                    .collect();
                shared.insert(member.clone(), others);
            }
        }
        *inner.shared.lock() = shared;
        Ok(())
    }
}
