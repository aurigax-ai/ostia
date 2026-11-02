use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use ostia_base::WorkspaceId;
use ostia_contract::approvals::{ApprovalAnswer, ApprovalOutcome};
use parking_lot::Mutex;
use tokio::task::JoinHandle;

use crate::package_policy::PackageBlockReason;
use crate::packages::{PackageRef, package_version_key};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PackageAskKind {
    Package,
    PackageMalware,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlockedPackage {
    pub ref_: PackageRef,
    pub reason: PackageBlockReason,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PackageAsk {
    pub workspace_id: WorkspaceId,
    pub kind: PackageAskKind,
    pub packages: Vec<BlockedPackage>,
}

pub type AskPackages = Arc<dyn Fn(PackageAsk) -> BoxFuture<'static, ApprovalOutcome> + Send + Sync>;

pub type AllowPackage = Arc<dyn Fn(&WorkspaceId, &str) + Send + Sync>;

pub struct PackageRequestsDeps {
    pub ask: AskPackages,
    pub allow_workspace: AllowPackage,
    pub allow_until_restart: AllowPackage,
    pub batch_ms: u64,
}

struct Batch {
    id: u64,
    items: Vec<BlockedPackage>,
    timer: JoinHandle<()>,
}

#[derive(Default)]
struct State {
    batches: HashMap<WorkspaceId, Batch>,
    asked: HashMap<WorkspaceId, HashSet<String>>,
    next_batch: u64,
}

struct Inner {
    deps: PackageRequestsDeps,
    state: Mutex<State>,
}

#[derive(Clone)]
pub struct PackageRequests {
    inner: Arc<Inner>,
}

impl PackageRequests {
    pub fn new(deps: PackageRequestsDeps) -> Self {
        Self {
            inner: Arc::new(Inner {
                deps,
                state: Mutex::new(State::default()),
            }),
        }
    }

    pub fn blocked(
        &self,
        workspace_id: &WorkspaceId,
        ref_: PackageRef,
        reason: PackageBlockReason,
    ) {
        let key = package_version_key(&ref_);
        let mut state = self.inner.state.lock();
        if !state
            .asked
            .entry(workspace_id.clone())
            .or_default()
            .insert(key)
        {
            return;
        }
        let item = BlockedPackage { ref_, reason };
        if let Some(batch) = state.batches.get_mut(workspace_id) {
            batch.items.push(item);
            return;
        }
        let id = state.next_batch;
        state.next_batch += 1;
        let timer = self.start_timer(workspace_id.clone(), id);
        state.batches.insert(
            workspace_id.clone(),
            Batch {
                id,
                items: vec![item],
                timer,
            },
        );
    }

    pub fn forget(&self, workspace_id: &WorkspaceId) {
        let mut state = self.inner.state.lock();
        if let Some(batch) = state.batches.remove(workspace_id) {
            batch.timer.abort();
        }
        state.asked.remove(workspace_id);
    }

    fn start_timer(&self, workspace_id: WorkspaceId, id: u64) -> JoinHandle<()> {
        let wait = tokio::time::sleep(Duration::from_millis(self.inner.deps.batch_ms));
        let this = self.clone();
        tokio::spawn(async move {
            wait.await;
            this.flush(workspace_id, id).await;
        })
    }

    async fn flush(&self, workspace_id: WorkspaceId, id: u64) {
        let items = {
            let mut state = self.inner.state.lock();
            match state.batches.get(&workspace_id) {
                Some(batch) if batch.id == id => {}
                _ => return,
            }
            match state.batches.remove(&workspace_id) {
                Some(batch) => batch.items,
                None => return,
            }
        };
        let (malicious, others): (Vec<_>, Vec<_>) = items
            .into_iter()
            .partition(|item| item.reason == PackageBlockReason::Malware);
        if !malicious.is_empty() {
            self.decide(&workspace_id, malicious, true).await;
        }
        if !others.is_empty() {
            self.decide(&workspace_id, others, false).await;
        }
    }

    async fn decide(
        &self,
        workspace_id: &WorkspaceId,
        packages: Vec<BlockedPackage>,
        malware: bool,
    ) {
        let kind = if malware {
            PackageAskKind::PackageMalware
        } else {
            PackageAskKind::Package
        };
        let outcome = (self.inner.deps.ask)(PackageAsk {
            workspace_id: workspace_id.clone(),
            kind,
            packages: packages.clone(),
        })
        .await;
        let keys: Vec<String> = packages
            .iter()
            .map(|item| package_version_key(&item.ref_))
            .collect();
        if matches!(
            outcome,
            ApprovalOutcome::Answer(ApprovalAnswer::Deny) | ApprovalOutcome::Timeout
        ) {
            let mut state = self.inner.state.lock();
            if let Some(asked) = state.asked.get_mut(workspace_id) {
                asked.extend(keys.iter().cloned());
            }
        }
        for key in &keys {
            match outcome {
                ApprovalOutcome::Answer(ApprovalAnswer::Workspace) if !malware => {
                    (self.inner.deps.allow_workspace)(workspace_id, key);
                }
                ApprovalOutcome::Answer(ApprovalAnswer::Once) => {
                    (self.inner.deps.allow_until_restart)(workspace_id, key);
                }
                ApprovalOutcome::Answer(ApprovalAnswer::Session) if !malware => {
                    (self.inner.deps.allow_until_restart)(workspace_id, key);
                }
                _ => {}
            }
        }
    }
}
