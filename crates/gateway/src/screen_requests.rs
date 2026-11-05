use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use ostia_base::clock::Clock;
use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

const REQUEST_MS: u64 = 120_000;
const DECLINE_COOLDOWN_MS: i64 = 60_000;
const NO_ANSWER_COOLDOWN_MS: i64 = 15_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RequestedBy {
    Desktop,
    Agent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ScreenAgent {
    Claude,
    Codex,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenRequested {
    pub session_id: String,
    pub by: RequestedBy,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<ScreenAgent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentScreenAsk {
    pub session_id: String,
    pub reason: Option<String>,
    pub agent: Option<ScreenAgent>,
    pub pane: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PhoneScreenDeclineReason {
    Off,
    Unsupported,
    Denied,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "kebab-case")]
pub enum PhoneScreenAskOutcome {
    Started,
    Declined { reason: PhoneScreenDeclineReason },
    NoAnswer,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AskRefusal {
    Busy,
    Cooldown,
    NoPhone,
}

pub enum AskFromAgent {
    Asked(oneshot::Receiver<PhoneScreenAskOutcome>),
    Refused(AskRefusal),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScreenRequestTiming {
    pub wait_ms: u64,
    pub cooldown_ms: i64,
    pub no_answer_cooldown_ms: i64,
}

impl Default for ScreenRequestTiming {
    fn default() -> Self {
        Self {
            wait_ms: REQUEST_MS,
            cooldown_ms: DECLINE_COOLDOWN_MS,
            no_answer_cooldown_ms: NO_ANSWER_COOLDOWN_MS,
        }
    }
}

struct Waiting {
    session_id: String,
    asked: HashSet<String>,
    declined: HashMap<String, PhoneScreenDeclineReason>,
    resolve: oneshot::Sender<PhoneScreenAskOutcome>,
    timer: JoinHandle<()>,
}

#[derive(Default)]
struct State {
    waiting: HashMap<String, Waiting>,
    cooling: HashMap<String, i64>,
}

type Notified = Box<dyn Fn() -> Vec<String> + Send + Sync>;
type SendRequest = Box<dyn Fn(ScreenRequested, Vec<String>) + Send + Sync>;

struct Inner {
    notified: Notified,
    send: SendRequest,
    now: Clock,
    timing: ScreenRequestTiming,
    state: Mutex<State>,
}

#[derive(Clone)]
pub struct ScreenRequests {
    inner: Arc<Inner>,
}

fn decline_reason(
    declined: &HashMap<String, PhoneScreenDeclineReason>,
) -> PhoneScreenDeclineReason {
    let has = |wanted| declined.values().any(|reason| *reason == wanted);
    if has(PhoneScreenDeclineReason::Denied) {
        PhoneScreenDeclineReason::Denied
    } else if has(PhoneScreenDeclineReason::Off) {
        PhoneScreenDeclineReason::Off
    } else {
        PhoneScreenDeclineReason::Unsupported
    }
}

impl Inner {
    fn gate(&self, state: &mut State, session_id: &str) -> Result<HashSet<String>, AskRefusal> {
        let now = (self.now)();
        state.cooling.retain(|_, until| now < *until);
        if state.cooling.contains_key(session_id) {
            return Err(AskRefusal::Cooldown);
        }
        let mut busy = HashSet::new();
        for open in state.waiting.values() {
            if open.session_id == session_id {
                return Err(AskRefusal::Busy);
            }
            busy.extend(open.asked.iter().cloned());
        }
        Ok(busy)
    }

    fn settle_if_all_declined(&self, state: &mut State, request_id: &str) {
        let Some(open) = state.waiting.get(request_id) else {
            return;
        };
        if open.declined.len() < open.asked.len() {
            return;
        }
        let session_id = open.session_id.clone();
        let reason = decline_reason(&open.declined);
        state
            .cooling
            .insert(session_id, (self.now)() + self.timing.cooldown_ms);
        Self::settle(
            state,
            request_id,
            PhoneScreenAskOutcome::Declined { reason },
        );
    }

    fn unanswered(&self, state: &mut State, request_id: &str) {
        let Some(open) = state.waiting.get(request_id) else {
            return;
        };
        let session_id = open.session_id.clone();
        state
            .cooling
            .insert(session_id, (self.now)() + self.timing.no_answer_cooldown_ms);
        Self::settle(state, request_id, PhoneScreenAskOutcome::NoAnswer);
    }

    fn settle(state: &mut State, request_id: &str, outcome: PhoneScreenAskOutcome) -> bool {
        let Some(open) = state.waiting.remove(request_id) else {
            return false;
        };
        open.timer.abort();
        let _ = open.resolve.send(outcome);
        true
    }
}

impl ScreenRequests {
    pub fn new(
        notified: impl Fn() -> Vec<String> + Send + Sync + 'static,
        send: impl Fn(ScreenRequested, Vec<String>) + Send + Sync + 'static,
        now: Clock,
        timing: ScreenRequestTiming,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                notified: Box::new(notified),
                send: Box::new(send),
                now,
                timing,
                state: Mutex::new(State::default()),
            }),
        }
    }

    pub fn ask_from_agent(&self, request: AgentScreenAsk) -> AskFromAgent {
        let inner = &self.inner;
        if let Err(refusal) = inner.gate(&mut inner.state.lock(), &request.session_id) {
            return AskFromAgent::Refused(refusal);
        }
        let devices = (inner.notified)();
        let request_id = uuid::Uuid::new_v4().to_string();
        let (resolve, answer) = oneshot::channel();
        let free = {
            let mut state = inner.state.lock();
            let busy = match inner.gate(&mut state, &request.session_id) {
                Ok(busy) => busy,
                Err(refusal) => return AskFromAgent::Refused(refusal),
            };
            let free: Vec<String> = devices
                .iter()
                .filter(|device| !busy.contains(*device))
                .cloned()
                .collect();
            if devices.is_empty() {
                return AskFromAgent::Refused(AskRefusal::NoPhone);
            }
            if free.is_empty() {
                return AskFromAgent::Refused(AskRefusal::Busy);
            }
            let sleep = tokio::time::sleep(Duration::from_millis(inner.timing.wait_ms));
            let timer = {
                let inner = Arc::clone(inner);
                let request_id = request_id.clone();
                tokio::spawn(async move {
                    sleep.await;
                    let mut state = inner.state.lock();
                    inner.unanswered(&mut state, &request_id);
                })
            };
            state.waiting.insert(
                request_id.clone(),
                Waiting {
                    session_id: request.session_id.clone(),
                    asked: free.iter().cloned().collect(),
                    declined: HashMap::new(),
                    resolve,
                    timer,
                },
            );
            free
        };
        (inner.send)(
            ScreenRequested {
                session_id: request.session_id,
                by: RequestedBy::Agent,
                reason: request.reason,
                agent: request.agent,
                pane: request.pane,
                request_id: Some(request_id),
            },
            free,
        );
        AskFromAgent::Asked(answer)
    }

    pub fn decline(
        &self,
        request_id: &str,
        device_id: &str,
        reason: PhoneScreenDeclineReason,
    ) -> bool {
        let mut state = self.inner.state.lock();
        let Some(open) = state.waiting.get_mut(request_id) else {
            return false;
        };
        if !open.asked.contains(device_id) {
            return false;
        }
        open.declined.insert(device_id.to_owned(), reason);
        self.inner.settle_if_all_declined(&mut state, request_id);
        true
    }

    pub fn drop_device(&self, device_id: &str) {
        let mut state = self.inner.state.lock();
        let ids: Vec<String> = state.waiting.keys().cloned().collect();
        for request_id in ids {
            let Some(open) = state.waiting.get_mut(&request_id) else {
                continue;
            };
            if !open.asked.remove(device_id) {
                continue;
            }
            open.declined.remove(device_id);
            if open.asked.is_empty() {
                self.inner.unanswered(&mut state, &request_id);
            } else {
                self.inner.settle_if_all_declined(&mut state, &request_id);
            }
        }
    }

    pub fn started(&self, request_id: &str, device_id: &str, session_id: &str) {
        let mut state = self.inner.state.lock();
        let Some(open) = state.waiting.get(request_id) else {
            return;
        };
        if open.session_id != session_id || !open.asked.contains(device_id) {
            return;
        }
        Inner::settle(&mut state, request_id, PhoneScreenAskOutcome::Started);
    }

    pub fn cooling_sessions(&self) -> Vec<String> {
        let mut sessions: Vec<String> = self.inner.state.lock().cooling.keys().cloned().collect();
        sessions.sort();
        sessions
    }
}
