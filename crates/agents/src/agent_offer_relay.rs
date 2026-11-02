use std::collections::HashMap;
use std::future::{Future, ready};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use ostia_base::{PaneId, WindowId, WorkspaceId};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio::time::sleep;

pub const AGENT_OFFER_TIMEOUT_MS: u64 = 120_000;
pub const AGENT_OFFER_CHANNEL: &str = "extensions:agent-offer";
pub const AGENT_OFFER_WITHDRAWN_CHANNEL: &str = "extensions:agent-offer-withdrawn";
pub const AGENT_OFFER_RESULT_CHANNEL: &str = "extensions:agent-offer-result";

pub struct AgentOfferRelayDeps {
    pub window_of: Box<dyn Fn(&WorkspaceId) -> Option<WindowId> + Send + Sync>,
    pub send: Box<dyn Fn(&WindowId, &str, Value) -> bool + Send + Sync>,
    pub external_id_of: Box<dyn Fn(&PaneId) -> Option<String> + Send + Sync>,
    pub timeout: Option<Duration>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentOffer {
    pub ext_id: String,
    pub ext_name: String,
    pub workspace_id: WorkspaceId,
    pub label: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AgentOfferDelivery {
    NotDelivered,
    Delivered { pane_id: Option<String> },
}

enum Settled {
    Answered(Option<String>),
    TimedOut,
}

struct Pending {
    window: WindowId,
    finish: oneshot::Sender<Option<String>>,
}

#[derive(Default)]
struct State {
    seq: u64,
    pending: HashMap<String, Pending>,
}

struct Inner {
    deps: AgentOfferRelayDeps,
    state: Mutex<State>,
}

#[derive(Clone)]
pub struct AgentOfferRelay {
    inner: Arc<Inner>,
}

impl AgentOfferRelay {
    pub fn new(deps: AgentOfferRelayDeps) -> Self {
        Self {
            inner: Arc::new(Inner {
                deps,
                state: Mutex::new(State::default()),
            }),
        }
    }

    pub fn offer(
        &self,
        offer: AgentOffer,
    ) -> Pin<Box<dyn Future<Output = AgentOfferDelivery> + Send>> {
        let AgentOffer {
            ext_id,
            ext_name,
            workspace_id,
            label,
            text,
        } = offer;
        let Some(window) = (self.inner.deps.window_of)(&workspace_id) else {
            return Box::pin(ready(AgentOfferDelivery::NotDelivered));
        };
        let (finish, mut answered) = oneshot::channel();
        let request_id = {
            let mut state = self.inner.state.lock();
            state.seq += 1;
            let request_id = format!("offer-{}", state.seq);
            state.pending.insert(
                request_id.clone(),
                Pending {
                    window: window.clone(),
                    finish,
                },
            );
            request_id
        };
        let payload = json!({
            "extId": ext_id,
            "extName": ext_name,
            "workspaceId": workspace_id,
            "label": label,
            "text": text,
            "requestId": request_id,
        });
        if !(self.inner.deps.send)(&window, AGENT_OFFER_CHANNEL, payload) {
            self.inner.state.lock().pending.remove(&request_id);
            return Box::pin(ready(AgentOfferDelivery::NotDelivered));
        }
        let timer = sleep(
            self.inner
                .deps
                .timeout
                .unwrap_or(Duration::from_millis(AGENT_OFFER_TIMEOUT_MS)),
        );
        let relay = self.clone();
        Box::pin(async move {
            let settled = tokio::select! {
                answer = &mut answered => Settled::Answered(answer.ok().flatten()),
                () = timer => Settled::TimedOut,
            };
            match settled {
                Settled::Answered(pane_id) => AgentOfferDelivery::Delivered { pane_id },
                Settled::TimedOut => {
                    if relay.withdraw(&request_id) {
                        (relay.inner.deps.send)(
                            &window,
                            AGENT_OFFER_WITHDRAWN_CHANNEL,
                            json!(request_id),
                        );
                        AgentOfferDelivery::Delivered { pane_id: None }
                    } else {
                        AgentOfferDelivery::Delivered {
                            pane_id: answered.await.ok().flatten(),
                        }
                    }
                }
            }
        })
    }

    pub fn answer(&self, sender: &WindowId, request_id: &Value, pane_id: &Value) {
        let Some(request_id) = request_id.as_str() else {
            return;
        };
        let mut state = self.inner.state.lock();
        let owned = state
            .pending
            .get(request_id)
            .is_some_and(|entry| &entry.window == sender);
        let entry = if owned {
            state.pending.remove(request_id)
        } else {
            None
        };
        drop(state);
        let Some(entry) = entry else {
            return;
        };
        let external = pane_id
            .as_str()
            .filter(|pane| !pane.is_empty())
            .and_then(|pane| (self.inner.deps.external_id_of)(&PaneId::new(pane)));
        let _ = entry.finish.send(external);
    }

    fn withdraw(&self, request_id: &str) -> bool {
        self.inner.state.lock().pending.remove(request_id).is_some()
    }
}
