use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;

use futures_util::future::BoxFuture;
use ostia_base::{Platform, WorkspaceId};
use ostia_contract::approvals::{ApprovalAnswer, ApprovalOutcome};
use ostia_contract::sandbox::{PortsPolicy, check_expose_port};
use parking_lot::Mutex;

use crate::port_forwarder::{ExposeError, ExposeRefusal, ExposeResult, SandboxListener};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PortAskOrigin {
    Agent,
    Listener,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PortAsk {
    pub workspace_id: WorkspaceId,
    pub pane_id: Option<String>,
    pub port: u16,
    pub process: Option<String>,
    pub origin: PortAskOrigin,
}

pub trait PortForwarding: Send + Sync + 'static {
    fn listeners(&self, workspace_id: &WorkspaceId) -> Vec<SandboxListener>;
    fn exposed(&self, workspace_id: &WorkspaceId) -> Vec<u16>;
    fn refusal(&self, workspace_id: &WorkspaceId) -> Option<ExposeRefusal>;
    fn expose(
        &self,
        workspace_id: &WorkspaceId,
        port: u16,
    ) -> impl Future<Output = ExposeResult> + Send;
    fn unexpose(&self, workspace_id: &WorkspaceId, port: u16) -> impl Future<Output = ()> + Send;
}

impl PortForwarding for crate::port_forwarder::PortForwarder {
    fn listeners(&self, workspace_id: &WorkspaceId) -> Vec<SandboxListener> {
        Self::listeners(self, workspace_id)
    }

    fn exposed(&self, workspace_id: &WorkspaceId) -> Vec<u16> {
        Self::exposed(self, workspace_id)
    }

    fn refusal(&self, workspace_id: &WorkspaceId) -> Option<ExposeRefusal> {
        Self::refusal(self, workspace_id)
    }

    fn expose(
        &self,
        workspace_id: &WorkspaceId,
        port: u16,
    ) -> impl Future<Output = ExposeResult> + Send {
        Self::expose(self, workspace_id, port)
    }

    fn unexpose(&self, workspace_id: &WorkspaceId, port: u16) -> impl Future<Output = ()> + Send {
        Self::unexpose(self, workspace_id, port)
    }
}

pub type IsSandboxed = Arc<dyn Fn(&WorkspaceId) -> bool + Send + Sync>;
pub type PolicyOf = Arc<dyn Fn(&WorkspaceId) -> PortsPolicy + Send + Sync>;
pub type AskPort = Arc<dyn Fn(PortAsk) -> BoxFuture<'static, ApprovalOutcome> + Send + Sync>;

pub struct PortRequestsDeps<F> {
    pub platform: Platform,
    pub is_sandboxed: IsSandboxed,
    pub policy: PolicyOf,
    pub ask: AskPort,
    pub forwarder: F,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PortNotice {
    NotNeededOnMacos,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PortGrant {
    pub port: u16,
    pub notice: Option<PortNotice>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PortRequestError {
    InvalidPort,
    NotSandboxed,
    Denied,
    Expose(ExposeError),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeptExposure {
    pub port: u16,
    pub process: String,
    pub pid: Option<u32>,
    pub by_human: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PortRow {
    pub port: u16,
    pub process: Option<String>,
    pub exposed: bool,
}

fn same_program(kept: &KeptExposure, listener: &SandboxListener) -> bool {
    listener.process.as_deref() == Some(kept.process.as_str()) && kept.pid == listener.pid
}

fn granted(outcome: ApprovalOutcome) -> bool {
    matches!(
        outcome,
        ApprovalOutcome::Answer(ApprovalAnswer::Workspace | ApprovalAnswer::Session)
    )
}

fn by_port(listeners: &[SandboxListener]) -> Vec<SandboxListener> {
    let mut out: Vec<SandboxListener> = Vec::new();
    for listener in listeners {
        match out.iter_mut().find(|known| known.port == listener.port) {
            Some(known) => *known = listener.clone(),
            None => out.push(listener.clone()),
        }
    }
    out
}

#[derive(Default)]
struct State {
    seen: HashMap<WorkspaceId, Vec<SandboxListener>>,
    kept: HashMap<WorkspaceId, HashMap<u16, KeptExposure>>,
    by_human: HashMap<WorkspaceId, HashSet<u16>>,
}

struct Inner<F> {
    deps: PortRequestsDeps<F>,
    state: Mutex<State>,
}

pub struct PortRequests<F> {
    inner: Arc<Inner<F>>,
}

impl<F> Clone for PortRequests<F> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }
}

impl<F: PortForwarding> PortRequests<F> {
    pub fn new(deps: PortRequestsDeps<F>) -> Self {
        Self {
            inner: Arc::new(Inner {
                deps,
                state: Mutex::default(),
            }),
        }
    }

    pub async fn request(
        &self,
        workspace_id: &WorkspaceId,
        pane_id: &str,
        input: &str,
    ) -> Result<PortGrant, PortRequestError> {
        let deps = &self.inner.deps;
        let Some(port) = check_expose_port(input) else {
            return Err(PortRequestError::InvalidPort);
        };
        if !(deps.is_sandboxed)(workspace_id) {
            return Err(PortRequestError::NotSandboxed);
        }
        if deps.platform == Platform::Darwin {
            return Ok(PortGrant {
                port,
                notice: Some(PortNotice::NotNeededOnMacos),
            });
        }
        if deps.forwarder.exposed(workspace_id).contains(&port) {
            return Ok(PortGrant { port, notice: None });
        }
        if let Some(refusal) = deps.forwarder.refusal(workspace_id) {
            return Err(PortRequestError::Expose(refusal.into()));
        }
        let process = self
            .inner
            .state
            .lock()
            .seen
            .get(workspace_id)
            .and_then(|seen| seen.iter().find(|listener| listener.port == port))
            .and_then(|listener| listener.process.clone());
        let outcome = (deps.ask)(PortAsk {
            workspace_id: workspace_id.clone(),
            pane_id: Some(pane_id.to_owned()),
            port,
            process,
            origin: PortAskOrigin::Agent,
        })
        .await;
        if !granted(outcome) {
            return Err(PortRequestError::Denied);
        }
        deps.forwarder
            .expose(workspace_id, port)
            .await
            .map(|port| PortGrant { port, notice: None })
            .map_err(PortRequestError::Expose)
    }

    pub async fn expose_by_human(&self, workspace_id: &WorkspaceId, port: u16) -> ExposeResult {
        let result = self.inner.deps.forwarder.expose(workspace_id, port).await;
        if result.is_ok() {
            self.mark_by_human(workspace_id, port);
        }
        result
    }

    pub async fn unexpose_by_human(&self, workspace_id: &WorkspaceId, port: u16) {
        if let Some(human) = self.inner.state.lock().by_human.get_mut(workspace_id) {
            human.remove(&port);
        }
        self.inner.deps.forwarder.unexpose(workspace_id, port).await;
    }

    pub fn exposures(
        &self,
        workspace_id: &WorkspaceId,
        listening: Option<&[SandboxListener]>,
    ) -> Vec<KeptExposure> {
        let seen = match listening {
            Some(listening) => by_port(listening),
            None => self
                .inner
                .state
                .lock()
                .seen
                .get(workspace_id)
                .cloned()
                .unwrap_or_default(),
        };
        let human = self.inner.state.lock().by_human.get(workspace_id).cloned();
        let mut out = Vec::new();
        for port in self.inner.deps.forwarder.exposed(workspace_id) {
            let Some(listener) = seen.iter().find(|listener| listener.port == port) else {
                continue;
            };
            let Some(process) = listener.process.as_deref().filter(|name| !name.is_empty()) else {
                continue;
            };
            out.push(KeptExposure {
                port,
                process: process.to_owned(),
                pid: listener.pid,
                by_human: human.as_ref().is_some_and(|human| human.contains(&port)),
            });
        }
        out
    }

    pub fn ports(&self, workspace_id: &WorkspaceId) -> Vec<PortRow> {
        let exposed = self.inner.deps.forwarder.exposed(workspace_id);
        self.inner
            .state
            .lock()
            .seen
            .get(workspace_id)
            .into_iter()
            .flatten()
            .map(|listener| PortRow {
                port: listener.port,
                process: listener.process.clone(),
                exposed: exposed.contains(&listener.port),
            })
            .collect()
    }

    pub async fn scan(&self, workspace_id: &WorkspaceId) {
        let deps = &self.inner.deps;
        if deps.platform != Platform::Linux || !(deps.is_sandboxed)(workspace_id) {
            return;
        }
        let current = by_port(&deps.forwarder.listeners(workspace_id));
        let (previous, had_kept) = {
            let mut state = self.inner.state.lock();
            let previous = state
                .seen
                .insert(workspace_id.clone(), current.clone())
                .unwrap_or_default();
            (previous, state.kept.contains_key(workspace_id))
        };
        let is_current = |port: u16| current.iter().any(|listener| listener.port == port);
        for gone in previous
            .iter()
            .filter(|listener| !is_current(listener.port))
        {
            if let Some(human) = self.inner.state.lock().by_human.get_mut(workspace_id) {
                human.remove(&gone.port);
            }
            deps.forwarder.unexpose(workspace_id, gone.port).await;
        }
        for listener in &current {
            let was_seen = previous.iter().any(|known| known.port == listener.port);
            let is_kept = self
                .inner
                .state
                .lock()
                .kept
                .get(workspace_id)
                .is_some_and(|kept| kept.contains_key(&listener.port));
            if was_seen && !is_kept {
                continue;
            }
            self.on_new_listener(workspace_id, listener).await;
        }
        if had_kept
            && deps.forwarder.refusal(workspace_id).is_none()
            && let Some(kept) = self.inner.state.lock().kept.get_mut(workspace_id)
        {
            kept.retain(|port, _| is_current(*port));
        }
    }

    pub fn keep(&self, workspace_id: &WorkspaceId, exposures: &[KeptExposure]) {
        let mut state = self.inner.state.lock();
        if state.kept.contains_key(workspace_id) {
            return;
        }
        state.kept.insert(
            workspace_id.clone(),
            exposures
                .iter()
                .map(|exposure| (exposure.port, exposure.clone()))
                .collect(),
        );
    }

    pub fn forget(&self, workspace_id: &WorkspaceId) {
        let mut state = self.inner.state.lock();
        state.seen.remove(workspace_id);
        state.kept.remove(workspace_id);
        state.by_human.remove(workspace_id);
    }

    fn mark_by_human(&self, workspace_id: &WorkspaceId, port: u16) {
        self.inner
            .state
            .lock()
            .by_human
            .entry(workspace_id.clone())
            .or_default()
            .insert(port);
    }

    fn take_kept(&self, workspace_id: &WorkspaceId, port: u16) -> Option<KeptExposure> {
        self.inner
            .state
            .lock()
            .kept
            .get_mut(workspace_id)
            .and_then(|kept| kept.remove(&port))
    }

    async fn on_new_listener(&self, workspace_id: &WorkspaceId, listener: &SandboxListener) {
        let deps = &self.inner.deps;
        if deps
            .forwarder
            .exposed(workspace_id)
            .contains(&listener.port)
        {
            self.take_kept(workspace_id, listener.port);
            return;
        }
        if deps.forwarder.refusal(workspace_id).is_some() {
            return;
        }
        let restored = self.take_kept(workspace_id, listener.port);
        let policy = (deps.policy)(workspace_id);
        if let Some(restored) = restored
            && same_program(&restored, listener)
            && (policy != PortsPolicy::Deny || restored.by_human)
        {
            let result = deps.forwarder.expose(workspace_id, listener.port).await;
            if result.is_ok() && restored.by_human {
                self.mark_by_human(workspace_id, listener.port);
            }
            return;
        }
        if policy == PortsPolicy::Deny {
            return;
        }
        if policy == PortsPolicy::Ask {
            let outcome = (deps.ask)(PortAsk {
                workspace_id: workspace_id.clone(),
                pane_id: None,
                port: listener.port,
                process: listener.process.clone(),
                origin: PortAskOrigin::Listener,
            })
            .await;
            if !granted(outcome) {
                return;
            }
        }
        let _ = deps.forwarder.expose(workspace_id, listener.port).await;
    }
}
