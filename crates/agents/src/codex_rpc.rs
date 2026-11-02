use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use futures_util::future::{BoxFuture, FutureExt, ready};
use futures_util::{SinkExt, StreamExt};
use ostia_base::PRODUCT_NAME;
use ostia_base::js::js_number_text;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::Instant;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::error::Error as WsError;

use crate::stream_codex::{CodexNotice, CodexRequestError, CodexRpc};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_millis(5000);
const CLOSE_TIMEOUT: Duration = Duration::from_millis(1000);

type Reply = Result<Value, CodexRequestError>;

enum Outgoing {
    Text { id: Option<i64>, text: String },
    Close,
}

struct Shared {
    pending: Mutex<HashMap<i64, oneshot::Sender<Reply>>>,
    next_id: AtomicI64,
    outgoing: mpsc::UnboundedSender<Outgoing>,
    closed: watch::Sender<bool>,
}

fn closed_error() -> CodexRequestError {
    CodexRequestError::new("codex closed the connection")
}

impl Shared {
    fn fail(&self, error: &CodexRequestError) {
        let entries: Vec<_> = self.pending.lock().drain().collect();
        for (_, reply) in entries {
            let _ = reply.send(Err(error.clone()));
        }
    }

    fn settle(&self, id: i64, reply: Reply) {
        let entry = self.pending.lock().remove(&id);
        if let Some(entry) = entry {
            let _ = entry.send(reply);
        }
    }
}

struct Client {
    shared: Arc<Shared>,
}

impl CodexRpc for Client {
    fn request(&self, method: &str, params: Value) -> BoxFuture<'static, Reply> {
        let shared = Arc::clone(&self.shared);
        let id = shared.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let (reply, answer) = oneshot::channel();
        shared.pending.lock().insert(id, reply);
        let deadline = tokio::time::sleep(REQUEST_TIMEOUT);
        let text = json!({"id": id, "method": method, "params": params}).to_string();
        let sent = shared.outgoing.send(Outgoing::Text { id: Some(id), text });
        if sent.is_err() {
            shared.pending.lock().remove(&id);
            return ready(Err(closed_error())).boxed();
        }
        let method = method.to_owned();
        async move {
            tokio::select! {
                answer = answer => answer.unwrap_or_else(|_| Err(closed_error())),
                () = deadline => {
                    shared.pending.lock().remove(&id);
                    Err(CodexRequestError::new(format!("{method} timed out")))
                }
            }
        }
        .boxed()
    }

    fn close(&self) {
        let _ = self.shared.outgoing.send(Outgoing::Close);
    }

    fn closed(&self) -> BoxFuture<'static, ()> {
        let mut closed = self.shared.closed.subscribe();
        async move {
            let _ = closed.wait_for(|done| *done).await;
        }
        .boxed()
    }
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number
            .as_f64()
            .map_or_else(|| number.to_string(), js_number_text),
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64() != Some(0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn refusal_of(error: &Value) -> CodexRequestError {
    let message = error
        .get("message")
        .filter(|message| !message.is_null())
        .map_or_else(|| "codex refused".to_owned(), js_string);
    CodexRequestError::new(message)
}

fn id_of(message: &Map<String, Value>) -> Option<i64> {
    let number = message.get("id")?.as_number()?;
    if let Some(whole) = number.as_i64() {
        return Some(whole);
    }
    let value = number.as_f64()?;
    (value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0).then_some(value as i64)
}

fn handle_message(shared: &Shared, notice: Option<&CodexNotice>, text: &str) {
    let Ok(Value::Object(message)) = serde_json::from_str::<Value>(text) else {
        return;
    };
    if let Some(method) = message.get("method").and_then(Value::as_str) {
        if !message.contains_key("id")
            && let Some(notice) = notice
        {
            notice(method, message.get("params").unwrap_or(&Value::Null));
        }
        return;
    }
    let Some(id) = id_of(&message) else {
        return;
    };
    let reply = match message.get("error") {
        Some(error) if is_truthy(error) => Err(refusal_of(error)),
        _ => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
    };
    shared.settle(id, reply);
}

async fn drive(
    socket: WebSocketStream<UnixStream>,
    mut outgoing: mpsc::UnboundedReceiver<Outgoing>,
    shared: Arc<Shared>,
    notice: Option<CodexNotice>,
) {
    let (mut sink, mut incoming) = socket.split();
    let mut close_deadline: Option<Instant> = None;
    loop {
        let expiry = async move {
            match close_deadline {
                Some(at) => tokio::time::sleep_until(at).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            out = outgoing.recv(), if close_deadline.is_none() => match out {
                Some(Outgoing::Text { id, text }) => {
                    if let Err(error) = sink.send(Message::text(text)).await {
                        if let Some(id) = id {
                            shared.settle(id, Err(CodexRequestError::new(error.to_string())));
                        }
                        break;
                    }
                }
                Some(Outgoing::Close) | None => {
                    let _ = sink.close().await;
                    close_deadline = Some(Instant::now() + CLOSE_TIMEOUT);
                }
            },
            frame = incoming.next() => match frame {
                None => break,
                Some(Err(WsError::ConnectionClosed | WsError::AlreadyClosed)) => break,
                Some(Err(error)) => {
                    shared.fail(&CodexRequestError::new(error.to_string()));
                    break;
                }
                Some(Ok(Message::Text(text))) => {
                    handle_message(&shared, notice.as_ref(), text.as_str());
                }
                Some(Ok(Message::Binary(bytes))) => {
                    handle_message(&shared, notice.as_ref(), &String::from_utf8_lossy(&bytes));
                }
                Some(Ok(Message::Close(_))) => {
                    let _ = sink.close().await;
                    break;
                }
                Some(Ok(_)) => {}
            },
            () = expiry => break,
        }
    }
    outgoing.close();
    shared.fail(&closed_error());
    shared.closed.send_replace(true);
}

async fn open(path: &Path) -> Result<WebSocketStream<UnixStream>, CodexRequestError> {
    let handshake = async {
        let stream = UnixStream::connect(path)
            .await
            .map_err(|error| CodexRequestError::new(error.to_string()))?;
        tokio_tungstenite::client_async("ws://localhost/", stream)
            .await
            .map(|(socket, _)| socket)
            .map_err(|error| CodexRequestError::new(error.to_string()))
    };
    tokio::time::timeout(CONNECT_TIMEOUT, handshake)
        .await
        .unwrap_or_else(|_| Err(CodexRequestError::new("Opening handshake has timed out")))
}

pub async fn connect_codex_rpc(
    socket_path: &Path,
    version: &str,
    notice: Option<CodexNotice>,
) -> Result<Arc<dyn CodexRpc>, CodexRequestError> {
    let socket = open(socket_path).await?;
    let (outgoing, queued) = mpsc::unbounded_channel();
    let (closed, _) = watch::channel(false);
    let shared = Arc::new(Shared {
        pending: Mutex::new(HashMap::new()),
        next_id: AtomicI64::new(0),
        outgoing,
        closed,
    });
    tokio::spawn(drive(socket, queued, Arc::clone(&shared), notice));
    let client = Client { shared };
    let info =
        json!({"clientInfo": {"name": PRODUCT_NAME, "title": PRODUCT_NAME, "version": version}});
    match client.request("initialize", info).await {
        Ok(_) => {
            let text = json!({"method": "initialized"}).to_string();
            let _ = client
                .shared
                .outgoing
                .send(Outgoing::Text { id: None, text });
            Ok(Arc::new(client))
        }
        Err(error) => {
            client.close();
            Err(error)
        }
    }
}
