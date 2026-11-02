use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use ostia_base::{PaneId, WorkspaceId};
use ostia_contract::approvals::{ApprovalAnswer, ApprovalOutcome};
use ostia_contract::sandbox::{DomainCheck, check_domain_pattern, host_matches};
use parking_lot::Mutex;
use tokio::sync::oneshot;

const WEB_PORT: u16 = 443;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DomainAskOrigin {
    Agent,
    Blocked,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DomainAsk {
    pub workspace_id: WorkspaceId,
    pub pane_id: Option<PaneId>,
    pub host: String,
    pub origin: DomainAskOrigin,
}

#[derive(Clone)]
pub struct DomainRequestsDeps {
    pub is_sandboxed: Arc<dyn Fn(&WorkspaceId) -> bool + Send + Sync>,
    pub blocked_domains: Arc<dyn Fn(&WorkspaceId) -> Vec<String> + Send + Sync>,
    pub ask: Arc<dyn Fn(DomainAsk) -> BoxFuture<'static, ApprovalOutcome> + Send + Sync>,
    pub allow_workspace: Arc<dyn Fn(&WorkspaceId, &str) + Send + Sync>,
    pub allow_until_restart: Arc<dyn Fn(&WorkspaceId, &str) + Send + Sync>,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DomainRequestError {
    InvalidDomain,
    NotSandboxed,
    Denied,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DomainRequestResult {
    Granted {
        domain: String,
    },
    Refused {
        error: DomainRequestError,
        reason: Option<&'static str>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DomainRefusal {
    pub host: String,
    pub count: u32,
    pub last: i64,
}

type Decision = Shared<BoxFuture<'static, bool>>;
type DecisionKey = (WorkspaceId, String);

#[derive(Default)]
struct State {
    pending: HashMap<DecisionKey, Decision>,
    denied: HashMap<WorkspaceId, HashMap<String, DomainRefusal>>,
    allowed: HashMap<WorkspaceId, HashSet<String>>,
}

impl State {
    fn mark_allowed(&mut self, workspace_id: &WorkspaceId, domain: &str) {
        self.allowed
            .entry(workspace_id.clone())
            .or_default()
            .insert(domain.to_owned());
    }
}

struct Inner {
    deps: DomainRequestsDeps,
    state: Mutex<State>,
}

#[derive(Clone)]
pub struct DomainRequests {
    inner: Arc<Inner>,
}

fn refused(error: DomainRequestError, reason: Option<&'static str>) -> DomainRequestResult {
    DomainRequestResult::Refused { error, reason }
}

impl DomainRequests {
    pub fn new(deps: DomainRequestsDeps) -> Self {
        Self {
            inner: Arc::new(Inner {
                deps,
                state: Mutex::new(State::default()),
            }),
        }
    }

    pub fn request(
        &self,
        workspace_id: &WorkspaceId,
        pane_id: &PaneId,
        host: &str,
    ) -> BoxFuture<'static, DomainRequestResult> {
        let domain = match check_domain_pattern(host) {
            DomainCheck::Valid(domain) => domain,
            DomainCheck::Refused(reason) => {
                return std::future::ready(refused(
                    DomainRequestError::InvalidDomain,
                    Some(reason),
                ))
                .boxed();
            }
        };
        if !(self.inner.deps.is_sandboxed)(workspace_id) {
            return std::future::ready(refused(DomainRequestError::NotSandboxed, None)).boxed();
        }
        if self.is_blocked(workspace_id, &domain) {
            return std::future::ready(refused(DomainRequestError::Denied, None)).boxed();
        }
        let pane_id = Some(pane_id.clone()).filter(|pane| !pane.is_empty());
        let decision = self.decide(
            workspace_id,
            domain.clone(),
            DomainAskOrigin::Agent,
            pane_id,
        );
        async move {
            if decision.await {
                DomainRequestResult::Granted { domain }
            } else {
                refused(DomainRequestError::Denied, None)
            }
        }
        .boxed()
    }

    fn is_blocked(&self, workspace_id: &WorkspaceId, domain: &str) -> bool {
        let blocked = (self.inner.deps.blocked_domains)(workspace_id);
        let bare = domain.strip_prefix("*.").unwrap_or(domain);
        let mut parts = bare.split(':');
        let host = parts.next().unwrap_or("");
        let port = parts
            .next()
            .filter(|port| !port.is_empty())
            .and_then(|port| port.parse::<u16>().ok())
            .unwrap_or(WEB_PORT);
        host_matches(host, port, &blocked)
    }

    pub fn on_blocked(
        &self,
        workspace_id: &WorkspaceId,
        host: &str,
        _port: Option<u16>,
    ) -> BoxFuture<'static, bool> {
        let domain = host.to_lowercase();
        let now = (self.inner.deps.now)();
        {
            let mut state = self.inner.state.lock();
            if state
                .allowed
                .get(workspace_id)
                .is_some_and(|allowed| allowed.contains(&domain))
            {
                return std::future::ready(true).boxed();
            }
            if let Some(refusal) = state
                .denied
                .get_mut(workspace_id)
                .and_then(|by_host| by_host.get_mut(&domain))
            {
                refusal.count += 1;
                refusal.last = now;
                return std::future::ready(false).boxed();
            }
        }
        self.decide(workspace_id, domain, DomainAskOrigin::Blocked, None)
    }

    pub fn allow_from_view(&self, workspace_id: &WorkspaceId, host: &str) {
        let domain = host.to_lowercase();
        {
            let mut state = self.inner.state.lock();
            if let Some(by_host) = state.denied.get_mut(workspace_id) {
                by_host.remove(&domain);
            }
            state.mark_allowed(workspace_id, &domain);
        }
        (self.inner.deps.allow_workspace)(workspace_id, &domain);
    }

    pub fn forget(&self, workspace_id: &WorkspaceId) {
        let mut state = self.inner.state.lock();
        state.denied.remove(workspace_id);
        state.allowed.remove(workspace_id);
    }

    fn decide(
        &self,
        workspace_id: &WorkspaceId,
        domain: String,
        origin: DomainAskOrigin,
        pane_id: Option<PaneId>,
    ) -> BoxFuture<'static, bool> {
        let key = (workspace_id.clone(), domain.clone());
        let (answer, receiver) = oneshot::channel::<bool>();
        let decision: Decision = async move { receiver.await.unwrap_or(false) }
            .boxed()
            .shared();
        {
            let mut state = self.inner.state.lock();
            if let Some(existing) = state.pending.get(&key) {
                return existing.clone().boxed();
            }
            state.pending.insert(key.clone(), decision.clone());
        }
        let asked = (self.inner.deps.ask)(DomainAsk {
            workspace_id: workspace_id.clone(),
            pane_id,
            host: domain,
            origin,
        });
        let requests = self.clone();
        tokio::spawn(async move {
            let outcome = asked.await;
            let allowed = requests.settle(&key, outcome);
            let _ = answer.send(allowed);
        });
        decision.boxed()
    }

    fn settle(&self, key: &DecisionKey, outcome: ApprovalOutcome) -> bool {
        let (workspace_id, domain) = key;
        let deps = &self.inner.deps;
        let permanent = match outcome {
            ApprovalOutcome::Answer(ApprovalAnswer::Workspace) => Some(true),
            ApprovalOutcome::Answer(ApprovalAnswer::Session) => Some(false),
            _ => None,
        };
        let Some(permanent) = permanent else {
            let now = (deps.now)();
            let mut state = self.inner.state.lock();
            state
                .denied
                .entry(workspace_id.clone())
                .or_default()
                .insert(
                    domain.clone(),
                    DomainRefusal {
                        host: domain.clone(),
                        count: 1,
                        last: now,
                    },
                );
            state.pending.remove(key);
            return false;
        };
        if permanent {
            (deps.allow_workspace)(workspace_id, domain);
        } else {
            (deps.allow_until_restart)(workspace_id, domain);
        }
        let mut state = self.inner.state.lock();
        state.mark_allowed(workspace_id, domain);
        state.pending.remove(key);
        true
    }
}
