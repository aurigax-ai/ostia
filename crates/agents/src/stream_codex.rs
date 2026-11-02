use std::collections::HashSet;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use futures_util::future::{BoxFuture, FutureExt, Shared, ready};
use ostia_base::js::static_regex;
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{Value, json};
use tokio::task::JoinHandle;
use tokio::time::Sleep;

use crate::stream_source::{Backfill, Emit, StreamSource, StreamSourceError};
use ostia_contract::agent_stream::{StreamEnd, StreamEvent, last_turns};
use ostia_contract::codex_stream::{codex_notification, codex_turn};

const RESUBSCRIBE_MS: u64 = 1000;
const RESUBSCRIBE_MAX: usize = 300;

static NO_ROLLOUT: LazyLock<Regex> = LazyLock::new(|| static_regex("(?i)no rollout"));

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodexRequestError {
    message: String,
}

impl CodexRequestError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    fn is_no_rollout(&self) -> bool {
        NO_ROLLOUT.is_match(&self.message)
    }
}

impl From<CodexRequestError> for StreamSourceError {
    fn from(err: CodexRequestError) -> Self {
        Self::new(err.message)
    }
}

pub trait CodexRpc: Send + Sync {
    fn request(
        &self,
        method: &str,
        params: Value,
    ) -> BoxFuture<'static, Result<Value, CodexRequestError>>;
    fn close(&self);
    fn closed(&self) -> BoxFuture<'static, ()>;
}

pub type CodexNotice = Arc<dyn Fn(&str, &Value) + Send + Sync>;

pub type CodexConnect = Box<
    dyn Fn(CodexNotice) -> BoxFuture<'static, Result<Arc<dyn CodexRpc>, CodexRequestError>>
        + Send
        + Sync,
>;

pub struct CodexSourceDeps {
    pub thread_id: String,
    pub connect: CodexConnect,
    pub closed: Box<dyn Fn(StreamEnd) + Send + Sync>,
}

type Subscription = Shared<BoxFuture<'static, Result<bool, CodexRequestError>>>;

#[derive(Default)]
struct Inner {
    rpc: Option<Arc<dyn CodexRpc>>,
    subscribed: bool,
    subscribing: Option<Subscription>,
    sink: Option<Emit>,
    buffered: Vec<StreamEvent>,
    retry: Option<JoinHandle<()>>,
    attempts: usize,
    shown: usize,
    emitted: HashSet<String>,
}

struct Core {
    thread_id: String,
    connect: CodexConnect,
    closed: Box<dyn Fn(StreamEnd) + Send + Sync>,
    inner: Mutex<Inner>,
}

pub struct CodexSource {
    core: Arc<Core>,
}

pub fn codex_source(deps: CodexSourceDeps) -> CodexSource {
    CodexSource {
        core: Arc::new(Core {
            thread_id: deps.thread_id,
            connect: deps.connect,
            closed: deps.closed,
            inner: Mutex::new(Inner::default()),
        }),
    }
}

fn dedupe_key(event: &StreamEvent) -> Option<String> {
    match event {
        StreamEvent::TurnStarted { turn } => Some(format!("turn:{turn}")),
        StreamEvent::TurnEnded { turn, .. } => Some(format!("end:{turn}")),
        StreamEvent::Prompt {
            id, append: false, ..
        } => Some(format!("prompt:{id}")),
        StreamEvent::ToolResult {
            id, append: false, ..
        } => Some(format!("tool.result:{id}")),
        _ => None,
    }
}

fn fresh(inner: &mut Inner, events: Vec<StreamEvent>) -> Vec<StreamEvent> {
    events
        .into_iter()
        .filter(|event| match dedupe_key(event) {
            None => true,
            Some(key) => inner.emitted.insert(key),
        })
        .collect()
}

fn turns_of(response: &Value) -> Vec<&Value> {
    response
        .get("data")
        .and_then(Value::as_array)
        .map_or_else(Vec::new, |list| list.iter().rev().collect())
}

fn trailing_message_dropped(turn: &Value) -> Value {
    let Some(object) = turn.as_object() else {
        return turn.clone();
    };
    if object.get("status").and_then(Value::as_str) != Some("inProgress") {
        return turn.clone();
    }
    let Some(items) = object.get("items").and_then(Value::as_array) else {
        return turn.clone();
    };
    let last_is_message = items
        .last()
        .and_then(Value::as_object)
        .and_then(|item| item.get("type"))
        .and_then(Value::as_str)
        == Some("agentMessage");
    if !last_is_message {
        return turn.clone();
    }
    let mut copy = object.clone();
    copy.insert(
        "items".to_owned(),
        Value::Array(items[..items.len() - 1].to_vec()),
    );
    Value::Object(copy)
}

async fn stored(
    core: &Arc<Core>,
    client: &Arc<dyn CodexRpc>,
    turns: usize,
) -> Result<Vec<StreamEvent>, StreamSourceError> {
    let request = client.request(
        "thread/turns/list",
        json!({
            "threadId": core.thread_id,
            "limit": turns,
            "itemsView": "full",
            "sortDirection": "desc",
        }),
    );
    let response = match request.await {
        Ok(value) => value,
        Err(err) if err.is_no_rollout() => Value::Null,
        Err(err) => return Err(err.into()),
    };
    let events: Vec<StreamEvent> = turns_of(&response)
        .into_iter()
        .flat_map(|turn| codex_turn(&trailing_message_dropped(turn)))
        .collect();
    let fresh_events = fresh(&mut core.inner.lock(), events);
    Ok(last_turns(&fresh_events, turns))
}

fn subscribe(core: &Arc<Core>) -> BoxFuture<'static, Result<bool, CodexRequestError>> {
    let mut inner = core.inner.lock();
    if inner.subscribed {
        return ready(Ok(true)).boxed();
    }
    let Some(client) = inner.rpc.clone() else {
        return ready(Ok(false)).boxed();
    };
    if let Some(pending) = &inner.subscribing {
        return pending.clone().boxed();
    }
    let request = client.request(
        "thread/resume",
        json!({"threadId": core.thread_id, "excludeTurns": true}),
    );
    let owner = Arc::clone(core);
    let pending: Subscription = async move {
        let outcome = match request.await {
            Ok(_) => {
                owner.inner.lock().subscribed = true;
                Ok(true)
            }
            Err(err) if err.is_no_rollout() => Ok(false),
            Err(err) => Err(err),
        };
        owner.inner.lock().subscribing = None;
        outcome
    }
    .boxed()
    .shared();
    inner.subscribing = Some(pending.clone());
    pending.boxed()
}

fn subscribe_later(core: &Arc<Core>, ms: u64) {
    let mut inner = core.inner.lock();
    if inner.subscribed || inner.retry.is_some() || inner.sink.is_none() {
        return;
    }
    let owner = Arc::clone(core);
    let timer = tokio::time::sleep(Duration::from_millis(ms));
    inner.retry = Some(tokio::spawn(retry_subscribe(owner, timer)));
}

async fn retry_subscribe(core: Arc<Core>, timer: Sleep) {
    timer.await;
    let client = {
        let mut inner = core.inner.lock();
        inner.retry = None;
        if inner.subscribed {
            return;
        }
        let Some(client) = inner.rpc.clone() else {
            return;
        };
        inner.attempts += 1;
        client
    };
    let subscribed = subscribe(&core).await.unwrap_or(false);
    if !subscribed {
        let attempts = core.inner.lock().attempts;
        if attempts >= RESUBSCRIBE_MAX {
            (core.closed)(StreamEnd::Unavailable);
        } else {
            subscribe_later(&core, RESUBSCRIBE_MS);
        }
        return;
    }
    let shown = core.inner.lock().shown;
    let missed = stored(&core, &client, shown).await.unwrap_or_default();
    let sink = core.inner.lock().sink.clone();
    if let Some(sink) = sink
        && !missed.is_empty()
    {
        sink(missed);
    }
}

fn on_notice(core: &Arc<Core>, method: &str, params: &Value) {
    let resubscribe_now = {
        let mut inner = core.inner.lock();
        if method == "thread/status/changed" && !inner.subscribed && inner.sink.is_some() {
            if let Some(retry) = inner.retry.take() {
                retry.abort();
            }
            true
        } else {
            false
        }
    };
    if resubscribe_now {
        subscribe_later(core, 0);
    }
    let Some(object) = params.as_object() else {
        return;
    };
    if object.get("threadId").and_then(Value::as_str) != Some(core.thread_id.as_str()) {
        return;
    }
    let events = codex_notification(method, params);
    if events.is_empty() {
        return;
    }
    let mut inner = core.inner.lock();
    let sink = inner.sink.clone();
    match sink {
        Some(sink) => {
            let out = fresh(&mut inner, events);
            drop(inner);
            if !out.is_empty() {
                sink(out);
            }
        }
        None => inner.buffered.extend(events),
    }
}

impl StreamSource for CodexSource {
    fn backfill(&self, turns: usize) -> BoxFuture<'_, Result<Backfill, StreamSourceError>> {
        let core = Arc::clone(&self.core);
        let weak = Arc::downgrade(&self.core);
        let notice: CodexNotice = Arc::new(move |method: &str, params: &Value| {
            if let Some(core) = weak.upgrade() {
                on_notice(&core, method, params);
            }
        });
        let connecting = (core.connect)(notice);
        async move {
            let client = connecting.await?;
            {
                let mut inner = core.inner.lock();
                inner.rpc = Some(Arc::clone(&client));
                inner.shown = turns;
            }
            let ended = client.closed();
            let watch = Arc::clone(&core);
            let watched = Arc::clone(&client);
            tokio::spawn(async move {
                ended.await;
                let current = watch
                    .inner
                    .lock()
                    .rpc
                    .as_ref()
                    .is_some_and(|rpc| Arc::ptr_eq(rpc, &watched));
                if current {
                    (watch.closed)(StreamEnd::AgentClosed);
                }
            });
            subscribe(&core).await?;
            let events = stored(&core, &client, turns).await?;
            Ok::<Backfill, StreamSourceError>(Backfill {
                events,
                truncated: false,
            })
        }
        .boxed()
    }

    fn live(&self, emit: Emit) {
        let pending = {
            let mut inner = self.core.inner.lock();
            inner.sink = Some(Arc::clone(&emit));
            let buffered = std::mem::take(&mut inner.buffered);
            fresh(&mut inner, buffered)
        };
        if !pending.is_empty() {
            emit(pending);
        }
        subscribe_later(&self.core, RESUBSCRIBE_MS);
    }

    fn close(&self) {
        let rpc = {
            let mut inner = self.core.inner.lock();
            inner.sink = None;
            if let Some(retry) = inner.retry.take() {
                retry.abort();
            }
            inner.rpc.take()
        };
        if let Some(rpc) = rpc {
            rpc.close();
        }
    }
}
