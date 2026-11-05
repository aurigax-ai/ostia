use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use ostia_contract::PRODUCT_DISPLAY_NAME;
use parking_lot::Mutex;
use reqwest::header::{ACCEPT, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue};
use reqwest::{Client, Response, Url};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

const PROTOCOL_VERSION: &str = "2025-06-18";
const CLOSED: &str = "The connection closed";
const SERVER_EXITED: &str = "The server exited.";
const TIMED_OUT: &str = "Request timed out";
const SESSION_HEADER: &str = "mcp-session-id";
const PROTOCOL_HEADER: &str = "mcp-protocol-version";

type Reply = Result<Value, String>;
type Waiters = HashMap<u64, oneshot::Sender<Reply>>;
pub(crate) type ExitCallback = Arc<dyn Fn() + Send + Sync>;

#[derive(Default)]
struct ExitWatch {
    exited: bool,
    callback: Option<ExitCallback>,
}

struct Shared {
    next_id: AtomicU64,
    closed: CancellationToken,
    pending: Mutex<Waiters>,
    watch: Mutex<ExitWatch>,
}

pub(crate) struct StdioSpec {
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: PathBuf,
}

pub(crate) struct HttpSpec {
    pub url: Url,
    pub headers: BTreeMap<String, String>,
}

struct HttpLink {
    client: Client,
    url: Url,
    headers: HeaderMap,
    session: Mutex<Option<String>>,
    protocol: Mutex<Option<String>>,
}

enum Link {
    Stdio(mpsc::UnboundedSender<String>),
    Http(Arc<HttpLink>),
}

pub(crate) struct McpClient {
    shared: Arc<Shared>,
    link: Link,
}

fn reply_of(message: &Value) -> Reply {
    if let Some(error) = message.get("error") {
        return Err(error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("request failed")
            .to_owned());
    }
    Ok(message.get("result").cloned().unwrap_or(Value::Null))
}

fn answer_in(body: &Value, id: u64) -> Option<Reply> {
    match body {
        Value::Array(items) => items.iter().find_map(|item| answer_in(item, id)),
        Value::Object(fields)
            if fields.get("id").and_then(Value::as_u64) == Some(id)
                && !fields.contains_key("method") =>
        {
            Some(reply_of(body))
        }
        _ => None,
    }
}

impl Shared {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            next_id: AtomicU64::new(1),
            closed: CancellationToken::new(),
            pending: Mutex::new(HashMap::new()),
            watch: Mutex::new(ExitWatch::default()),
        })
    }

    fn resolve(&self, message: &Value) {
        let Some(id) = message.get("id").and_then(Value::as_u64) else {
            return;
        };
        let waiter = self.pending.lock().remove(&id);
        if let Some(waiter) = waiter {
            let _ = waiter.send(reply_of(message));
        }
    }

    fn fail_all(&self, message: &str) {
        let waiters: Vec<_> = self
            .pending
            .lock()
            .drain()
            .map(|(_, waiter)| waiter)
            .collect();
        for waiter in waiters {
            let _ = waiter.send(Err(message.to_owned()));
        }
    }

    fn handle_line(&self, line: &str, reply: &mpsc::UnboundedSender<String>) {
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            self.resolve(&message);
            return;
        };
        let Some(id) = message.get("id") else {
            return;
        };
        let answer = if method == "ping" {
            json!({"jsonrpc": "2.0", "id": id, "result": {}})
        } else {
            json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "Method not found"}})
        };
        let _ = reply.send(answer.to_string());
    }

    fn finish_exit(&self) {
        let by_us = self.closed.is_cancelled();
        self.fail_all(if by_us { CLOSED } else { SERVER_EXITED });
        self.closed.cancel();
        let callback = {
            let mut watch = self.watch.lock();
            watch.exited = !by_us;
            watch.callback.take()
        };
        if let Some(callback) = callback
            && !by_us
        {
            callback();
        }
    }
}

async fn read_stdio(
    mut child: Child,
    stdout: ChildStdout,
    reply: mpsc::UnboundedSender<String>,
    shared: Arc<Shared>,
) {
    let mut lines = BufReader::new(stdout).lines();
    loop {
        tokio::select! {
            () = shared.closed.cancelled() => break,
            line = lines.next_line() => match line {
                Ok(Some(line)) => shared.handle_line(&line, &reply),
                _ => break,
            },
        }
    }
    let _ = child.start_kill();
    let _ = child.wait().await;
    shared.finish_exit();
}

async fn write_stdio(
    mut stdin: ChildStdin,
    mut lines: mpsc::UnboundedReceiver<String>,
    closed: CancellationToken,
) {
    loop {
        tokio::select! {
            () = closed.cancelled() => break,
            next = lines.recv() => {
                let Some(mut line) = next else { break };
                line.push('\n');
                if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                    break;
                }
            }
        }
    }
}

fn header_map(headers: &BTreeMap<String, String>) -> Result<HeaderMap, String> {
    let mut map = HeaderMap::new();
    for (key, value) in headers {
        let name = HeaderName::from_bytes(key.as_bytes())
            .map_err(|_| format!("Invalid header name {key}"))?;
        let mut value =
            HeaderValue::from_str(value).map_err(|_| format!("Invalid value for header {key}"))?;
        value.set_sensitive(true);
        map.insert(name, value);
    }
    Ok(map)
}

fn sse_messages(buffer: &mut Vec<u8>) -> Vec<Value> {
    let mut messages = Vec::new();
    while let Some(end) = buffer.windows(2).position(|pair| pair == b"\n\n") {
        let event: Vec<u8> = buffer.drain(..end + 2).collect();
        let text = String::from_utf8_lossy(&event);
        let data: Vec<&str> = text
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(|rest| rest.strip_prefix(' ').unwrap_or(rest))
            .collect();
        if let Ok(message) = serde_json::from_str::<Value>(&data.join("\n")) {
            messages.push(message);
        }
    }
    messages
}

impl HttpLink {
    async fn read_stream(&self, mut response: Response, id: u64) -> Reply {
        let mut buffer = Vec::new();
        loop {
            let chunk = response.chunk().await.map_err(|err| err.to_string())?;
            let Some(chunk) = chunk else {
                return Err("No response from the server".to_owned());
            };
            buffer.extend(chunk.iter().filter(|byte| **byte != b'\r'));
            for message in sse_messages(&mut buffer) {
                if let Some(reply) = answer_in(&message, id) {
                    return reply;
                }
            }
        }
    }

    async fn post(&self, body: &Value, id: Option<u64>) -> Reply {
        let mut request = self
            .client
            .post(self.url.clone())
            .headers(self.headers.clone())
            .header(ACCEPT, "application/json, text/event-stream")
            .header(CONTENT_TYPE, "application/json")
            .body(body.to_string());
        if let Some(session) = self.session.lock().clone() {
            request = request.header(SESSION_HEADER, session);
        }
        if let Some(version) = self.protocol.lock().clone() {
            request = request.header(PROTOCOL_HEADER, version);
        }
        let response = request.send().await.map_err(|err| err.to_string())?;
        let status = response.status();
        if let Some(session) = response
            .headers()
            .get(SESSION_HEADER)
            .and_then(|value| value.to_str().ok())
        {
            *self.session.lock() = Some(session.to_owned());
        }
        if !status.is_success() {
            return Err(format!("HTTP {status}"));
        }
        let Some(id) = id else {
            return Ok(Value::Null);
        };
        let streamed = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|kind| kind.contains("text/event-stream"));
        if streamed {
            return self.read_stream(response, id).await;
        }
        let text = response.text().await.map_err(|err| err.to_string())?;
        let parsed: Value = serde_json::from_str(&text).map_err(|err| err.to_string())?;
        answer_in(&parsed, id).unwrap_or_else(|| Err("No response from the server".to_owned()))
    }
}

impl McpClient {
    pub(crate) fn start_stdio(spec: &StdioSpec) -> Result<Self, String> {
        let mut command = Command::new(&spec.command);
        command
            .args(&spec.args)
            .env_clear()
            .envs(&spec.env)
            .current_dir(&spec.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|err| format!("{}: {err}", spec.command))?;
        let stdin = child.stdin.take().ok_or("The server has no input")?;
        let stdout = child.stdout.take().ok_or("The server has no output")?;
        let shared = Shared::new();
        let (out, lines) = mpsc::unbounded_channel();
        tokio::spawn(write_stdio(stdin, lines, shared.closed.clone()));
        tokio::spawn(read_stdio(child, stdout, out.clone(), Arc::clone(&shared)));
        Ok(Self {
            shared,
            link: Link::Stdio(out),
        })
    }

    pub(crate) fn start_http(spec: HttpSpec) -> Result<Self, String> {
        let link = HttpLink {
            client: Client::builder().build().map_err(|err| err.to_string())?,
            url: spec.url,
            headers: header_map(&spec.headers)?,
            session: Mutex::new(None),
            protocol: Mutex::new(None),
        };
        Ok(Self {
            shared: Shared::new(),
            link: Link::Http(Arc::new(link)),
        })
    }

    pub(crate) fn is_stdio(&self) -> bool {
        matches!(self.link, Link::Stdio(_))
    }

    pub(crate) fn on_exit(&self, callback: ExitCallback) {
        let fire = {
            let mut watch = self.shared.watch.lock();
            if watch.exited {
                true
            } else {
                watch.callback = Some(Arc::clone(&callback));
                false
            }
        };
        if fire {
            callback();
        }
    }

    pub(crate) fn close(&self) {
        self.shared.closed.cancel();
        let Link::Http(http) = &self.link else {
            return;
        };
        let session = http.session.lock().take();
        let (Some(session), Ok(runtime)) = (session, tokio::runtime::Handle::try_current()) else {
            return;
        };
        let http = Arc::clone(http);
        runtime.spawn(async move {
            let _ = http
                .client
                .delete(http.url.clone())
                .headers(http.headers.clone())
                .header(SESSION_HEADER, session)
                .send()
                .await;
        });
    }

    fn abandon(&self, id: u64) {
        self.shared.pending.lock().remove(&id);
        if let Link::Stdio(out) = &self.link {
            let message = json!({
                "jsonrpc": "2.0",
                "method": "notifications/cancelled",
                "params": {"requestId": id, "reason": "abandoned"},
            });
            let _ = out.send(message.to_string());
        }
    }

    async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Reply {
        let id = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
        let message = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        match &self.link {
            Link::Stdio(out) => {
                let (waiter, reply) = oneshot::channel();
                self.shared.pending.lock().insert(id, waiter);
                if out.send(message.to_string()).is_err() {
                    self.shared.pending.lock().remove(&id);
                    return Err(CLOSED.to_owned());
                }
                tokio::select! {
                    biased;
                    answer = reply => answer.unwrap_or_else(|_| Err(CLOSED.to_owned())),
                    () = cancel.cancelled() => {
                        self.abandon(id);
                        Err("cancelled".to_owned())
                    }
                    () = self.shared.closed.cancelled() => {
                        self.shared.pending.lock().remove(&id);
                        Err(CLOSED.to_owned())
                    }
                    () = tokio::time::sleep(timeout) => {
                        self.abandon(id);
                        Err(TIMED_OUT.to_owned())
                    }
                }
            }
            Link::Http(http) => {
                tokio::select! {
                    biased;
                    answer = http.post(&message, Some(id)) => answer,
                    () = cancel.cancelled() => Err("cancelled".to_owned()),
                    () = self.shared.closed.cancelled() => Err(CLOSED.to_owned()),
                    () = tokio::time::sleep(timeout) => Err(TIMED_OUT.to_owned()),
                }
            }
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let message = json!({"jsonrpc": "2.0", "method": method, "params": params});
        match &self.link {
            Link::Stdio(out) => out.send(message.to_string()).map_err(|_| CLOSED.to_owned()),
            Link::Http(http) => http.post(&message, None).await.map(|_| ()),
        }
    }

    pub(crate) async fn initialize(&self, timeout: Duration) -> Result<(), String> {
        let params = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": PRODUCT_DISPLAY_NAME, "version": env!("CARGO_PKG_VERSION")},
        });
        let result = self
            .request("initialize", params, timeout, &CancellationToken::new())
            .await?;
        if let Link::Http(http) = &self.link {
            *http.protocol.lock() = result
                .get("protocolVersion")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        self.notify("notifications/initialized", json!({})).await
    }

    pub(crate) async fn list_tools(&self, timeout: Duration) -> Result<Vec<Value>, String> {
        let result = self
            .request("tools/list", json!({}), timeout, &CancellationToken::new())
            .await?;
        Ok(result
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    pub(crate) async fn call_tool(
        &self,
        name: &str,
        arguments: Map<String, Value>,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Reply {
        let params = json!({"name": name, "arguments": arguments});
        self.request("tools/call", params, timeout, cancel).await
    }
}
