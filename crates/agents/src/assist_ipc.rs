use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use futures_util::future::BoxFuture;
use ostia_contract::assist::{ASSIST_REQUEST_ID_PATTERN, AssistPoint};
use ostia_contract::string_enum::StringEnum;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

const MAX_ASSIST_REQUESTS_PER_WINDOW: usize = 8;

pub type ChunkSink = Arc<dyn Fn(&str) + Send + Sync>;
pub type DestroyListener = Box<dyn FnOnce() + Send>;
type HostSource = dyn Fn() -> Option<Arc<dyn AssistHost>> + Send + Sync;

#[derive(Clone)]
pub struct AssistCallOptions {
    pub token: CancellationToken,
    pub model: Option<Value>,
    pub on_chunk: ChunkSink,
}

pub trait AssistHost: Send + Sync {
    fn assist(
        &self,
        point: AssistPoint,
        input: Value,
        opts: AssistCallOptions,
    ) -> BoxFuture<'static, Value>;
}

pub trait AssistSender: Send + Sync {
    fn id(&self) -> u64;
    fn send(&self, channel: &str, payload: Value);
    fn is_destroyed(&self) -> bool;
    fn on_destroyed(&self, listener: DestroyListener);
}

#[derive(Default)]
struct Slots {
    live: HashMap<(u64, String), CancellationToken>,
    watched: HashSet<u64>,
}

struct Slot {
    slots: Arc<Mutex<Slots>>,
    key: (u64, String),
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.slots.lock().live.remove(&self.key);
    }
}

struct Prepared {
    slot: Slot,
    chunks: Arc<AtomicUsize>,
    call: BoxFuture<'static, Value>,
}

#[derive(Clone)]
pub struct AssistRouter {
    host: Arc<HostSource>,
    slots: Arc<Mutex<Slots>>,
}

fn refusal(error: &str) -> Value {
    json!({"ok": false, "error": error})
}

fn with_chunks(response: Value, chunks: usize) -> Value {
    match response {
        Value::Object(mut fields) => {
            fields.insert("chunks".to_owned(), json!(chunks));
            Value::Object(fields)
        }
        _ => json!({"chunks": chunks}),
    }
}

impl AssistRouter {
    pub fn new(host: impl Fn() -> Option<Arc<dyn AssistHost>> + Send + Sync + 'static) -> Self {
        Self {
            host: Arc::new(host),
            slots: Arc::default(),
        }
    }

    pub fn cancel(&self, sender_id: u64, request_id: &Value) {
        let Some(request_id) = request_id.as_str() else {
            return;
        };
        let token = self
            .slots
            .lock()
            .live
            .get(&(sender_id, request_id.to_owned()))
            .cloned();
        if let Some(token) = token {
            token.cancel();
        }
    }

    pub fn pending(&self) -> usize {
        self.slots.lock().live.len()
    }

    fn cancel_window(slots: &Mutex<Slots>, sender_id: u64) {
        let tokens: Vec<CancellationToken> = {
            let mut guard = slots.lock();
            guard.watched.remove(&sender_id);
            guard
                .live
                .iter()
                .filter(|((owner, _), _)| *owner == sender_id)
                .map(|(_, token)| token.clone())
                .collect()
        };
        for token in tokens {
            token.cancel();
        }
    }

    fn open_slot(
        &self,
        sender: &Arc<dyn AssistSender>,
        request_id: &str,
    ) -> Result<(Slot, CancellationToken), Value> {
        let sender_id = sender.id();
        let key = (sender_id, request_id.to_owned());
        let token = CancellationToken::new();
        let watch = {
            let mut guard = self.slots.lock();
            if guard.live.contains_key(&key) {
                return Err(refusal("invalid"));
            }
            let open = guard
                .live
                .keys()
                .filter(|(owner, _)| *owner == sender_id)
                .count();
            if open >= MAX_ASSIST_REQUESTS_PER_WINDOW {
                return Err(refusal("busy"));
            }
            let watch = guard.watched.insert(sender_id);
            guard.live.insert(key.clone(), token.clone());
            watch
        };
        if watch {
            let slots = Arc::clone(&self.slots);
            sender.on_destroyed(Box::new(move || Self::cancel_window(&slots, sender_id)));
        }
        let slot = Slot {
            slots: Arc::clone(&self.slots),
            key,
        };
        Ok((slot, token))
    }

    fn prepare(
        &self,
        sender: Arc<dyn AssistSender>,
        point: &Value,
        request_id: &Value,
        input: Value,
        model: Option<Value>,
    ) -> Result<Prepared, Value> {
        let host = (self.host)().ok_or_else(|| refusal("unavailable"))?;
        let point = point
            .as_str()
            .and_then(AssistPoint::parse)
            .ok_or_else(|| refusal("invalid"))?;
        let request_id = request_id
            .as_str()
            .filter(|id| ASSIST_REQUEST_ID_PATTERN.is_match(id))
            .ok_or_else(|| refusal("invalid"))?;
        let (slot, token) = self.open_slot(&sender, request_id)?;
        let chunks = Arc::new(AtomicUsize::new(0));
        let on_chunk: ChunkSink = {
            let chunks = Arc::clone(&chunks);
            let request_id = request_id.to_owned();
            Arc::new(move |text: &str| {
                if sender.is_destroyed() {
                    return;
                }
                chunks.fetch_add(1, Ordering::SeqCst);
                sender.send(
                    "assist:chunk",
                    json!({"requestId": request_id, "text": text}),
                );
            })
        };
        let opts = AssistCallOptions {
            token,
            model: model.filter(|value| !value.is_null()),
            on_chunk,
        };
        Ok(Prepared {
            slot,
            chunks,
            call: host.assist(point, input, opts),
        })
    }

    pub fn request(
        &self,
        sender: Arc<dyn AssistSender>,
        point: &Value,
        request_id: &Value,
        input: Value,
        model: Option<Value>,
    ) -> impl Future<Output = Value> + use<> {
        let prepared = self.prepare(sender, point, request_id, input, model);
        async move {
            match prepared {
                Err(refused) => refused,
                Ok(Prepared { slot, chunks, call }) => {
                    let response = call.await;
                    drop(slot);
                    match chunks.load(Ordering::SeqCst) {
                        0 => response,
                        count => with_chunks(response, count),
                    }
                }
            }
        }
    }
}
