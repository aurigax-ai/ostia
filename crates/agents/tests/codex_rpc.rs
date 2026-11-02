#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use ostia_agents::codex_rpc::connect_codex_rpc;
use ostia_agents::stream_codex::{CodexNotice, CodexRequestError, CodexRpc};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc::{self, UnboundedSender};
use tokio_tungstenite::tungstenite::Message;

enum Out {
    Text(String),
    Close,
}

type Hung = Arc<Mutex<Option<(UnboundedSender<Out>, i64)>>>;

#[derive(Clone)]
struct Shared {
    received: Arc<Mutex<Vec<Value>>>,
    clients: Arc<Mutex<Vec<UnboundedSender<Out>>>>,
    hung: Hung,
    dropped: Arc<AtomicBool>,
}

struct Server {
    dir: TempDir,
    path: PathBuf,
    shared: Shared,
}

async fn serve(stream: UnixStream, shared: Shared) {
    let Ok(ws) = tokio_tungstenite::accept_async(stream).await else {
        return;
    };
    let (mut sink, mut incoming) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Out>();
    shared.clients.lock().push(tx.clone());
    tokio::spawn(async move {
        while let Some(out) = rx.recv().await {
            match out {
                Out::Text(text) => {
                    if sink.send(Message::text(text)).await.is_err() {
                        break;
                    }
                }
                Out::Close => {
                    let _ = sink.close().await;
                    break;
                }
            }
        }
    });
    while let Some(Ok(Message::Text(text))) = incoming.next().await {
        let Ok(message) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        shared.received.lock().push(message.clone());
        let Some(id) = message.get("id").and_then(Value::as_i64) else {
            continue;
        };
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match method {
            "hang" => *shared.hung.lock() = Some((tx.clone(), id)),
            "boom" => {
                let _ = tx.send(Out::Text(
                    json!({"id": id, "error": {"message": "nope"}}).to_string(),
                ));
            }
            "big" => {
                let _ = tx.send(Out::Text(
                    json!({"id": id, "result": {"text": "x".repeat(20 * 1024 * 1024)}}).to_string(),
                ));
            }
            "drop" => {
                shared.dropped.store(true, Ordering::SeqCst);
                let _ = tx.send(Out::Close);
            }
            other => {
                let _ = tx.send(Out::Text(
                    json!({"id": id, "result": {"echoed": other}}).to_string(),
                ));
            }
        }
    }
}

fn start_server() -> Server {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("s.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let shared = Shared {
        received: Arc::new(Mutex::new(Vec::new())),
        clients: Arc::new(Mutex::new(Vec::new())),
        hung: Arc::new(Mutex::new(None)),
        dropped: Arc::new(AtomicBool::new(false)),
    };
    let accepting = shared.clone();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(serve(stream, accepting.clone()));
        }
    });
    Server { dir, path, shared }
}

fn push_to_clients(server: &Server, text: &str) {
    for client in server.shared.clients.lock().iter() {
        let _ = client.send(Out::Text(text.to_owned()));
    }
}

async fn wait_for(mut check: impl FnMut() -> bool) {
    for _ in 0..500 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("condition not met in time");
}

async fn connect(server: &Server, version: &str, notice: Option<CodexNotice>) -> Arc<dyn CodexRpc> {
    connect_codex_rpc(&server.path, version, notice)
        .await
        .unwrap()
}

async fn finish(rpc: &Arc<dyn CodexRpc>) {
    rpc.close();
    tokio::time::timeout(Duration::from_secs(5), rpc.closed())
        .await
        .unwrap();
}

#[tokio::test]
async fn hands_the_server_notifications_with_their_params_to_the_listener() {
    let server = start_server();
    let notices: Arc<Mutex<Vec<(String, Value)>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&notices);
    let notice: CodexNotice = Arc::new(move |method, params| {
        sink.lock().push((method.to_owned(), params.clone()));
    });
    let rpc = connect(&server, "1", Some(notice)).await;
    push_to_clients(
        &server,
        &json!({"method": "item/agentMessage/delta", "params": {"delta": "hi"}}).to_string(),
    );
    push_to_clients(&server, &json!({"method": "turn/completed"}).to_string());
    wait_for(|| notices.lock().len() >= 2).await;
    assert_eq!(
        *notices.lock(),
        vec![
            ("item/agentMessage/delta".to_owned(), json!({"delta": "hi"})),
            ("turn/completed".to_owned(), Value::Null),
        ]
    );
    finish(&rpc).await;
}

#[tokio::test]
async fn initializes_as_ostia_then_sends_initialized_before_it_hands_the_client_out() {
    let server = start_server();
    let rpc = connect(&server, "1.2.3", None).await;
    assert_eq!(
        server.shared.received.lock()[0],
        json!({
            "id": 1,
            "method": "initialize",
            "params": {"clientInfo": {"name": "ostia", "title": "ostia", "version": "1.2.3"}}
        })
    );
    wait_for(|| server.shared.received.lock().len() >= 2).await;
    assert_eq!(
        server.shared.received.lock()[1],
        json!({"method": "initialized"})
    );
    finish(&rpc).await;
}

#[tokio::test]
async fn ignores_a_message_that_is_not_an_object_and_keeps_working() {
    let server = start_server();
    let rpc = connect(&server, "1", None).await;
    for raw in ["null", "{not json", "7"] {
        push_to_clients(&server, raw);
    }
    assert_eq!(
        rpc.request("turn/start", json!({})).await.unwrap(),
        json!({"echoed": "turn/start"})
    );
    rpc.close();
}

#[tokio::test]
async fn never_answers_a_server_request_and_never_mistakes_one_for_the_reply_to_its_own() {
    let server = start_server();
    let rpc = connect(&server, "1", None).await;
    let settled = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&settled);
    let request = rpc.request("hang", json!({}));
    let waiting = tokio::spawn(async move {
        let result = request.await;
        flag.store(true, Ordering::SeqCst);
        result
    });
    wait_for(|| server.shared.hung.lock().is_some()).await;
    let (tx, id) = server.shared.hung.lock().clone().unwrap();
    let _ = tx.send(Out::Text(
        json!({"id": id, "method": "item/commandExecution/requestApproval", "params": {}})
            .to_string(),
    ));
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(!settled.load(Ordering::SeqCst));
    assert!(
        server
            .shared
            .received
            .lock()
            .iter()
            .all(|message| message.get("method").is_some())
    );
    let _ = tx.send(Out::Text(
        json!({"id": id, "result": {"ok": true}}).to_string(),
    ));
    let result = tokio::time::timeout(Duration::from_secs(5), waiting)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.unwrap(), json!({"ok": true}));
    rpc.close();
}

#[tokio::test]
async fn answers_a_request_with_its_result_and_a_refusal_as_an_error() {
    let server = start_server();
    let rpc = connect(&server, "1", None).await;
    assert_eq!(
        rpc.request("turn/start", json!({"threadId": "t"}))
            .await
            .unwrap(),
        json!({"echoed": "turn/start"})
    );
    assert_eq!(
        rpc.request("boom", json!({})).await.unwrap_err(),
        CodexRequestError::new("nope")
    );
    rpc.close();
}

#[tokio::test]
async fn rejects_what_was_asked_when_the_server_drops_the_connection_and_says_it_closed() {
    let server = start_server();
    let rpc = connect(&server, "1", None).await;
    assert_eq!(
        rpc.request("drop", json!({})).await.unwrap_err(),
        CodexRequestError::new("codex closed the connection")
    );
    tokio::time::timeout(Duration::from_secs(5), rpc.closed())
        .await
        .unwrap();
    assert!(server.shared.dropped.load(Ordering::SeqCst));
}

#[tokio::test]
async fn rejects_when_nothing_listens_on_the_socket() {
    let server = start_server();
    let missing = server.dir.path().join("missing.sock");
    assert!(connect_codex_rpc(&missing, "1", None).await.is_err());
}

#[tokio::test]
async fn reads_a_reply_of_20_mib_in_one_frame() {
    let server = start_server();
    let rpc = connect(&server, "1", None).await;
    let reply = rpc.request("big", json!({})).await.unwrap();
    assert_eq!(reply["text"].as_str().unwrap().len(), 20 * 1024 * 1024);
    finish(&rpc).await;
}
