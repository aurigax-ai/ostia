use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use futures_util::StreamExt;
use parking_lot::Mutex;
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;
use tokio::sync::{mpsc, oneshot};
use tokio_util::codec::FramedRead;

use crate::error::RpcError;
use crate::frame::{CONTROL_MESSAGE_MAX, FrameCodec, encode_frame};
use crate::message::{Incoming, classify, parse_body, request_body};

type Pending = Arc<Mutex<Vec<(u64, oneshot::Sender<Result<Value, RpcError>>)>>>;

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error(transparent)]
    Rpc(#[from] RpcError),
    #[error("the connection closed")]
    Closed,
}

pub struct Client {
    next_id: AtomicU64,
    outgoing: mpsc::UnboundedSender<Vec<u8>>,
    pending: Pending,
}

fn answer(pending: &Pending, id: u64, outcome: Result<Value, RpcError>) {
    let mut waiting = pending.lock();
    if let Some(at) = waiting.iter().position(|(waiter, _)| *waiter == id) {
        let (_, reply) = waiting.swap_remove(at);
        let _ = reply.send(outcome);
    }
}

impl Client {
    pub async fn connect(path: &Path) -> std::io::Result<Self> {
        let (read, mut write) = UnixStream::connect(path).await?.into_split();
        let pending: Pending = Arc::default();
        let (outgoing, mut queue) = mpsc::unbounded_channel::<Vec<u8>>();
        let writer = tokio::spawn(async move {
            while let Some(frame) = queue.recv().await {
                if write.write_all(&frame).await.is_err() {
                    break;
                }
            }
        });
        let incoming = Arc::clone(&pending);
        tokio::spawn(async move {
            let mut frames = FramedRead::new(read, FrameCodec::new(CONTROL_MESSAGE_MAX));
            while let Some(Ok(body)) = frames.next().await {
                let Ok(message) = parse_body(&body) else {
                    break;
                };
                if let Incoming::Response { id, outcome } = classify(message) {
                    let outcome = outcome.map_err(|error| RpcError::from_json(&error));
                    if let Some(id) = id.as_u64() {
                        answer(&incoming, id, outcome);
                    }
                }
            }
            writer.abort();
            incoming.lock().clear();
        });
        Ok(Self {
            next_id: AtomicU64::new(0),
            outgoing,
            pending,
        })
    }

    pub async fn request(
        &self,
        method: &str,
        params: Option<&Value>,
    ) -> Result<Value, ClientError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (reply, waiting) = oneshot::channel();
        self.pending.lock().push((id, reply));
        self.outgoing
            .send(encode_frame(&request_body(id, method, params)))
            .map_err(|_| ClientError::Closed)?;
        Ok(waiting.await.map_err(|_| ClientError::Closed)??)
    }
}
