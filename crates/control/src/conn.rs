use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use ostia_rpc::{RpcError, encode_frame, notification_body, request_body};
use parking_lot::Mutex;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

static NEXT_CONN_ID: AtomicU64 = AtomicU64::new(1);

type Waiting = HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>;

#[derive(Clone)]
pub struct ConnHandle {
    id: u64,
    next_request: Arc<AtomicU64>,
    outgoing: mpsc::UnboundedSender<Vec<u8>>,
    waiting: Arc<Mutex<Waiting>>,
    closed: CancellationToken,
}

impl ConnHandle {
    pub(crate) fn new(outgoing: mpsc::UnboundedSender<Vec<u8>>, closed: CancellationToken) -> Self {
        Self {
            id: NEXT_CONN_ID.fetch_add(1, Ordering::Relaxed),
            next_request: Arc::default(),
            outgoing,
            waiting: Arc::default(),
            closed,
        }
    }

    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn closed(&self) -> CancellationToken {
        self.closed.clone()
    }

    pub(crate) fn send_frame(&self, message: &Value) {
        let _ = self.outgoing.send(encode_frame(message));
    }

    pub fn notify(&self, method: &str, params: &Value) {
        self.send_frame(&notification_body(method, params));
    }

    pub async fn request(&self, method: &str, params: Option<&Value>) -> Result<Value, RpcError> {
        let id = self.next_request.fetch_add(1, Ordering::Relaxed);
        let (reply, answer) = oneshot::channel();
        self.waiting.lock().insert(id, reply);
        self.send_frame(&request_body(id, method, params));
        answer
            .await
            .map_err(|_| RpcError::thrown("the connection closed"))?
    }

    pub(crate) fn answer(&self, id: &Value, outcome: Result<Value, Value>) {
        let reply = id.as_u64().and_then(|id| self.waiting.lock().remove(&id));
        if let Some(reply) = reply {
            let _ = reply.send(outcome.map_err(|error| RpcError::from_json(&error)));
        }
    }

    pub(crate) fn fail_waiting(&self) {
        self.waiting.lock().clear();
    }
}
