use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use ostia_base::ExternalId;
use ostia_base::clock::{Clock, system_clock};
use ostia_base::host::Host;
use ostia_base::json_store::load_json;
use ostia_contract::approvals::{
    APPROVAL_DETAIL_MAX, APPROVAL_HISTORY_MAX, APPROVAL_TIMEOUT_MS, ApprovalAnswer, ApprovalKind,
    ApprovalMode, ApprovalOutcome, ApprovalRecord, ApprovalRequest, ApprovalState, auto_approves,
    offered_answers, parse_approval_settings,
};
use ostia_contract::capabilities::Capability;
use ostia_contract::pick::clip;
use parking_lot::Mutex;
use serde_json::Value;
use tokio::sync::oneshot;
use tokio::task::AbortHandle;

use crate::capability_store::CapabilityStore;

#[derive(Clone, Debug)]
pub struct ApprovalAsk {
    pub external_id: ExternalId,
    pub window_id: String,
    pub pane_id: String,
    pub workspace_id: String,
    pub caps: Vec<Capability>,
    pub action: String,
    pub detail: String,
    pub kind: Option<ApprovalKind>,
    pub subject: Option<String>,
}

pub type OpenedListener = Box<dyn Fn(&ApprovalRequest) + Send + Sync>;
pub type SettledListener = Box<dyn Fn(&str, ApprovalOutcome) + Send + Sync>;
pub type PublishFn = Box<dyn Fn(&str, &ApprovalState) -> bool + Send + Sync>;
pub type GrantFn = Box<dyn Fn(&ExternalId, Capability) + Send + Sync>;
pub type AlwaysFn = Box<dyn Fn(&[Capability]) -> bool + Send + Sync>;
pub type RevealFn = Box<dyn Fn(&str) + Send + Sync>;

pub struct ApprovalDeps {
    pub mode: Box<dyn Fn() -> ApprovalMode + Send + Sync>,
    pub publish: PublishFn,
    pub grant: GrantFn,
    pub revoke: GrantFn,
    pub always: AlwaysFn,
    pub now: Clock,
    pub timeout_ms: u64,
    pub reveal: RevealFn,
    pub opened: Option<OpenedListener>,
    pub settled: Option<SettledListener>,
}

#[derive(Clone, Debug)]
pub struct OpenApproval {
    pub window_id: String,
    pub request: ApprovalRequest,
}

struct Pending {
    window_id: String,
    external_id: ExternalId,
    req: ApprovalRequest,
    tx: oneshot::Sender<ApprovalOutcome>,
    timer: Option<AbortHandle>,
    claimed: bool,
}

struct StoredRecord {
    window_id: String,
    external_id: ExternalId,
    record: ApprovalRecord,
}

#[derive(Default)]
struct State {
    pending: Vec<Pending>,
    history: Vec<StoredRecord>,
    counter: u64,
}

impl State {
    fn snapshot(&self, window_id: &str) -> ApprovalState {
        ApprovalState {
            pending: self
                .pending
                .iter()
                .filter(|p| p.window_id == window_id)
                .map(|p| p.req.clone())
                .collect(),
            history: self
                .history
                .iter()
                .filter(|r| r.window_id == window_id)
                .map(|r| r.record.clone())
                .collect(),
        }
    }

    fn record(
        &mut self,
        window_id: &str,
        external_id: &ExternalId,
        req: &ApprovalRequest,
        outcome: ApprovalOutcome,
        answered_at: i64,
    ) {
        let revocable =
            outcome == ApprovalOutcome::Answer(ApprovalAnswer::Session) && is_capability(req.kind);
        self.history.insert(
            0,
            StoredRecord {
                window_id: window_id.to_owned(),
                external_id: external_id.clone(),
                record: ApprovalRecord {
                    request: req.clone(),
                    outcome,
                    answered_at,
                    revocable,
                },
            },
        );
        self.history.truncate(APPROVAL_HISTORY_MAX);
    }
}

fn is_capability(kind: Option<ApprovalKind>) -> bool {
    kind.unwrap_or(ApprovalKind::Capability) == ApprovalKind::Capability
}

fn push_unique(list: &mut Vec<String>, window_id: &str) {
    if !list.iter().any(|existing| existing == window_id) {
        list.push(window_id.to_owned());
    }
}

fn answer_named(value: &Value) -> Option<ApprovalAnswer> {
    match value.as_str()? {
        "once" => Some(ApprovalAnswer::Once),
        "session" => Some(ApprovalAnswer::Session),
        "always" => Some(ApprovalAnswer::Always),
        "workspace" => Some(ApprovalAnswer::Workspace),
        "deny" => Some(ApprovalAnswer::Deny),
        _ => None,
    }
}

struct Inner {
    deps: ApprovalDeps,
    state: Mutex<State>,
    publish_gate: Mutex<()>,
}

#[derive(Clone)]
pub struct Approvals {
    inner: Arc<Inner>,
}

pub fn create_approvals(deps: ApprovalDeps) -> Approvals {
    Approvals {
        inner: Arc::new(Inner {
            deps,
            state: Mutex::new(State::default()),
            publish_gate: Mutex::new(()),
        }),
    }
}

impl Inner {
    fn publish(&self, window_id: &str) -> bool {
        let _gate = self.publish_gate.lock();
        let snapshot = self.state.lock().snapshot(window_id);
        (self.deps.publish)(window_id, &snapshot)
    }

    fn settle(&self, id: &str, outcome: ApprovalOutcome) -> bool {
        self.settle_as(id, outcome, false)
    }

    fn settle_as(&self, id: &str, outcome: ApprovalOutcome, claimer: bool) -> bool {
        let entry = {
            let mut state = self.state.lock();
            let Some(index) = state
                .pending
                .iter()
                .position(|p| p.req.id == id && p.claimed == claimer)
            else {
                return false;
            };
            let entry = state.pending.remove(index);
            state.record(
                &entry.window_id,
                &entry.external_id,
                &entry.req,
                outcome,
                (self.deps.now)(),
            );
            entry
        };
        if let Some(timer) = &entry.timer {
            timer.abort();
        }
        let standing = matches!(
            outcome,
            ApprovalOutcome::Answer(ApprovalAnswer::Session | ApprovalAnswer::Always)
        );
        if standing && is_capability(entry.req.kind) {
            for cap in &entry.req.caps {
                (self.deps.grant)(&entry.external_id, *cap);
            }
        }
        self.publish(&entry.window_id);
        if let Some(settled) = &self.deps.settled {
            settled(&entry.req.id, outcome);
        }
        let _ = entry.tx.send(outcome);
        true
    }
}

impl Inner {
    fn release_claim(&self, id: &str) {
        let timer_fired = {
            let mut state = self.state.lock();
            let Some(entry) = state.pending.iter_mut().find(|p| p.req.id == id) else {
                return;
            };
            entry.claimed = false;
            entry.timer.as_ref().is_some_and(AbortHandle::is_finished)
        };
        if timer_fired {
            self.settle(id, ApprovalOutcome::Timeout);
        }
    }
}

async fn waiting(rx: oneshot::Receiver<ApprovalOutcome>) -> ApprovalOutcome {
    rx.await
        .unwrap_or(ApprovalOutcome::Answer(ApprovalAnswer::Deny))
}

impl Approvals {
    pub fn request(
        &self,
        ask: ApprovalAsk,
    ) -> impl Future<Output = ApprovalOutcome> + Send + 'static + use<> {
        let inner = &self.inner;
        let kind = ask.kind.unwrap_or(ApprovalKind::Capability);
        let at = (inner.deps.now)();
        let (tx, rx) = oneshot::channel();
        let req = {
            let mut state = inner.state.lock();
            state.counter += 1;
            ApprovalRequest {
                id: format!("approval-{}", state.counter),
                kind: Some(kind),
                subject: ask.subject.clone(),
                pane_id: ask.pane_id.clone(),
                workspace_id: ask.workspace_id.clone(),
                caps: ask.caps.clone(),
                action: ask.action.clone(),
                detail: clip(&Value::String(ask.detail.clone()), APPROVAL_DETAIL_MAX),
                at,
            }
        };
        if auto_approves((inner.deps.mode)(), &req.caps, kind) {
            inner.state.lock().record(
                &ask.window_id,
                &ask.external_id,
                &req,
                ApprovalOutcome::Auto,
                (inner.deps.now)(),
            );
            inner.publish(&ask.window_id);
            let _ = tx.send(ApprovalOutcome::Auto);
            return waiting(rx);
        }
        let sleep = tokio::time::sleep(Duration::from_millis(inner.deps.timeout_ms));
        let timer = tokio::spawn({
            let inner = Arc::clone(inner);
            let id = req.id.clone();
            async move {
                sleep.await;
                inner.settle(&id, ApprovalOutcome::Timeout);
            }
        })
        .abort_handle();
        inner.state.lock().pending.push(Pending {
            window_id: ask.window_id.clone(),
            external_id: ask.external_id.clone(),
            req: req.clone(),
            tx,
            timer: Some(timer),
            claimed: false,
        });
        if let Some(opened) = &inner.deps.opened {
            opened(&req);
        }
        if inner.publish(&ask.window_id) {
            (inner.deps.reveal)(&ask.window_id);
        } else {
            inner.settle(&req.id, ApprovalOutcome::Answer(ApprovalAnswer::Deny));
        }
        waiting(rx)
    }

    pub fn answer(&self, window_id: &str, id: &str, value: &Value) -> bool {
        let inner = &self.inner;
        let Some(answer) = answer_named(value) else {
            return false;
        };
        let caps = {
            let mut state = inner.state.lock();
            let Some(entry) = state
                .pending
                .iter_mut()
                .find(|p| p.req.id == id && !p.claimed)
            else {
                return false;
            };
            if entry.window_id != window_id
                || !offered_answers(entry.req.kind, &entry.req.caps).contains(&answer)
            {
                return false;
            }
            if answer != ApprovalAnswer::Always {
                None
            } else {
                entry.claimed = true;
                Some(entry.req.caps.clone())
            }
        };
        let Some(caps) = caps else {
            return inner.settle(id, ApprovalOutcome::Answer(answer));
        };
        if (inner.deps.always)(&caps) {
            return inner.settle_as(id, ApprovalOutcome::Answer(answer), true);
        }
        inner.release_claim(id);
        false
    }

    pub fn revoke(&self, window_id: &str, id: &str) -> bool {
        let inner = &self.inner;
        let (external_id, caps) = {
            let mut state = inner.state.lock();
            let Some(entry) = state.history.iter_mut().find(|r| r.record.request.id == id) else {
                return false;
            };
            if entry.window_id != window_id || !entry.record.revocable {
                return false;
            }
            entry.record.revocable = false;
            (entry.external_id.clone(), entry.record.request.caps.clone())
        };
        for cap in caps {
            (inner.deps.revoke)(&external_id, cap);
        }
        inner.publish(window_id);
        true
    }

    pub fn state_for(&self, window_id: &str) -> ApprovalState {
        self.inner.state.lock().snapshot(window_id)
    }

    pub fn forget(&self, external_id: &ExternalId) {
        let inner = &self.inner;
        let ids: Vec<String> = inner
            .state
            .lock()
            .pending
            .iter()
            .filter(|p| p.external_id == *external_id)
            .map(|p| p.req.id.clone())
            .collect();
        for id in ids {
            inner.settle(&id, ApprovalOutcome::Answer(ApprovalAnswer::Deny));
        }
        let mut touched: Vec<String> = Vec::new();
        {
            let mut state = inner.state.lock();
            for entry in &mut state.history {
                if entry.external_id == *external_id && entry.record.revocable {
                    entry.record.revocable = false;
                    push_unique(&mut touched, &entry.window_id);
                }
            }
        }
        for window_id in touched {
            inner.publish(&window_id);
        }
    }

    pub fn rehome(&self, external_ids: &[ExternalId], window_id: &str) {
        let inner = &self.inner;
        let mut touched: Vec<String> = Vec::new();
        {
            let mut state = inner.state.lock();
            let State {
                pending, history, ..
            } = &mut *state;
            let owned = pending
                .iter_mut()
                .map(|p| (&p.external_id, &mut p.window_id))
                .chain(
                    history
                        .iter_mut()
                        .map(|r| (&r.external_id, &mut r.window_id)),
                );
            for (external_id, owner) in owned {
                if !external_ids.contains(external_id) || owner.as_str() == window_id {
                    continue;
                }
                push_unique(&mut touched, owner);
                *owner = window_id.to_owned();
            }
        }
        if touched.is_empty() {
            return;
        }
        push_unique(&mut touched, window_id);
        for id in touched {
            inner.publish(&id);
        }
    }

    pub fn open(&self) -> Vec<OpenApproval> {
        self.inner
            .state
            .lock()
            .pending
            .iter()
            .map(|p| OpenApproval {
                window_id: p.window_id.clone(),
                request: p.req.clone(),
            })
            .collect()
    }
}

pub fn read_approval_mode(host: &Host) -> ApprovalMode {
    let path = host.app_config_dir().join("settings.json");
    let raw = load_json(&path)
        .and_then(|settings| settings.get("approvals").cloned())
        .unwrap_or(Value::Null);
    parse_approval_settings(&raw).mode
}

pub struct RegisterApprovals {
    pub host: Host,
    pub caps: CapabilityStore,
    pub publish: PublishFn,
    pub reveal: RevealFn,
    pub settings_changed: Box<dyn Fn() + Send + Sync>,
    pub opened: Option<OpenedListener>,
    pub settled: Option<SettledListener>,
}

#[derive(Clone)]
pub struct RegisteredApprovals {
    pub approvals: Approvals,
    caps: CapabilityStore,
    settings_changed: Arc<dyn Fn() + Send + Sync>,
}

fn persist(settings_changed: &Arc<dyn Fn() + Send + Sync>, write: impl FnOnce() -> bool) -> bool {
    if !write() {
        return false;
    }
    settings_changed();
    true
}

impl RegisteredApprovals {
    pub fn remove_always(&self, cap: &Value) -> bool {
        match serde_json::from_value::<Capability>(cap.clone()) {
            Ok(cap) => persist(&self.settings_changed, || {
                self.caps.remove_standing_grant(cap)
            }),
            Err(_) => false,
        }
    }

    pub fn set_reach(&self, sender_is_window: bool, mode: &Value) -> bool {
        sender_is_window && persist(&self.settings_changed, || self.caps.set_reach_mode(mode))
    }
}

pub fn register_approvals(parts: RegisterApprovals) -> RegisteredApprovals {
    let RegisterApprovals {
        host,
        caps,
        publish,
        reveal,
        settings_changed,
        opened,
        settled,
    } = parts;
    let settings_changed: Arc<dyn Fn() + Send + Sync> = Arc::from(settings_changed);
    let deps = ApprovalDeps {
        mode: Box::new(move || read_approval_mode(&host)),
        publish,
        grant: Box::new({
            let caps = caps.clone();
            move |external_id, cap| caps.grant(external_id, cap)
        }),
        revoke: Box::new({
            let caps = caps.clone();
            move |external_id, cap| caps.revoke(external_id, cap)
        }),
        always: Box::new({
            let caps = caps.clone();
            let settings_changed = Arc::clone(&settings_changed);
            move |wanted| persist(&settings_changed, || caps.add_standing_grants(wanted))
        }),
        now: system_clock(),
        timeout_ms: APPROVAL_TIMEOUT_MS,
        reveal,
        opened,
        settled,
    };
    RegisteredApprovals {
        approvals: create_approvals(deps),
        caps,
        settings_changed,
    }
}
