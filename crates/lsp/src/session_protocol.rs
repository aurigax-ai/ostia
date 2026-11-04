use std::collections::HashMap;
use std::os::unix::process::ExitStatusExt;
use std::path::Path;
use std::process::ExitStatus;
use std::sync::Arc;

use futures_util::future::BoxFuture;
use futures_util::{FutureExt, StreamExt};
use nix::sys::signal::Signal;
use ostia_base::js::is_js_space;
use ostia_contract::language_server_config::{
    configuration_section, overlay_settings, substitute_json,
};
use ostia_contract::language_servers::{LSP_LOG_LINE_MAX, LspLogEntry, LspLogEvent, LspStopReason};
use ostia_diagnostics::app_log::{LogFields, redact_secrets};
use ostia_files::file_watch::TreeChange;
use ostia_files::watched_files::{
    FileWatcher, WATCHED_FILES_METHOD, parse_file_watchers, watched_file_events,
};
use ostia_rpc::frame::{FrameCodec, encode_frame};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::{mpsc, watch};
use tokio_util::codec::FramedRead;

use crate::server_spawn::{
    AttachRequest, EventLog, LanguageServerSource, NoteSink, RecordLookup,
    SessionProtocol as Attach, cut_to_units,
};

const SESSION_ID_PREFIX: &str = "lsp-";
const SESSION_ID_DIGITS_MAX: usize = 12;
const MAX_TRACKED_REQUESTS: usize = 2_000;
const INITIALIZED_TEXT_MAX: usize = 80;
const STDERR_CHUNK: usize = 8192;

pub type TreeSink = Arc<dyn Fn(Vec<TreeChange>) + Send + Sync>;
pub type Unwatch = Box<dyn FnOnce() + Send>;
pub type WatchTree = Arc<dyn Fn(&Path, TreeSink) -> Option<Unwatch> + Send + Sync>;
pub type PostMessage = Arc<dyn Fn(&str, &str, Option<Value>) + Send + Sync>;
pub type ExitSink = Arc<dyn Fn(&str, Option<i32>, Option<String>) + Send + Sync>;

pub struct SessionProtocolDeps {
    pub record: RecordLookup,
    pub note: NoteSink,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub post: PostMessage,
    pub watch_tree: Option<WatchTree>,
    pub log: Option<EventLog>,
    pub on_exit: ExitSink,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SessionSnapshot {
    pub id: String,
    pub slot: String,
    pub key: String,
    pub signature: String,
    pub window_id: String,
    pub root: String,
    pub started_at: i64,
    pub refs: u32,
    pub initialized: bool,
    pub stopping: Option<LspStopReason>,
    pub shutdown_id: Option<String>,
    pub requests: Vec<(Value, String)>,
    pub settings: Map<String, Value>,
    pub watcher_ids: Vec<String>,
    pub watching: bool,
}

enum Outgoing {
    Frame(Vec<u8>),
    Close,
}

struct Session {
    id: String,
    slot: String,
    key: String,
    signature: String,
    window_id: String,
    root: String,
    refs: u32,
    started_at: i64,
    requests: Vec<(Value, String)>,
    initialized: bool,
    stopping: Option<LspStopReason>,
    settings: Map<String, Value>,
    shutdown_id: Option<String>,
    file_watchers: Vec<(String, Vec<FileWatcher>)>,
    unwatch: Option<Unwatch>,
    writer: mpsc::UnboundedSender<Outgoing>,
    exited: watch::Receiver<bool>,
}

#[derive(Default)]
struct State {
    seq: u64,
    sessions: HashMap<String, Session>,
}

struct Inner {
    deps: SessionProtocolDeps,
    state: Mutex<State>,
}

#[derive(Clone)]
pub struct SessionProtocol {
    inner: Arc<Inner>,
}

fn base_settings(source: &LanguageServerSource, root: &str) -> Map<String, Value> {
    let configured = Value::Object(source.server.settings.clone().unwrap_or_default());
    let substituted = substitute_json(&configured, &source.dir, root);
    let paths = source.server.setting_paths.clone().unwrap_or_default();
    match overlay_settings(&substituted, &paths, &source.setting_values) {
        Value::Object(settings) => settings,
        _ => Map::new(),
    }
}

fn same_id(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => left.as_f64() == right.as_f64(),
        (Value::String(left), Value::String(right)) => left == right,
        _ => false,
    }
}

fn is_request_id(value: &Value) -> bool {
    value.is_string() || value.is_number()
}

fn is_session_id(text: &str) -> bool {
    text.strip_prefix(SESSION_ID_PREFIX).is_some_and(|digits| {
        (1..=SESSION_ID_DIGITS_MAX).contains(&digits.len())
            && digits.bytes().all(|byte| byte.is_ascii_digit())
    })
}

fn signal_name(status: &ExitStatus) -> Option<String> {
    let number = status.signal()?;
    Signal::try_from(number)
        .ok()
        .map(|signal| signal.as_str().to_owned())
}

fn clipped_text(text: &str) -> String {
    cut_to_units(&redact_secrets(text), LSP_LOG_LINE_MAX)
}

fn clipped_value(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .map_or_else(String::new, |text| cut_to_units(text, INITIALIZED_TEXT_MAX))
}

fn notification(method: &str, params: &Value) -> Value {
    json!({"jsonrpc": "2.0", "method": method, "params": params})
}

async fn run_writer(mut stdin: ChildStdin, mut outgoing: mpsc::UnboundedReceiver<Outgoing>) {
    let mut broken = false;
    while let Some(next) = outgoing.recv().await {
        match next {
            Outgoing::Frame(bytes) => {
                if !broken
                    && (stdin.write_all(&bytes).await.is_err() || stdin.flush().await.is_err())
                {
                    broken = true;
                }
            }
            Outgoing::Close => break,
        }
    }
    let _ = stdin.shutdown().await;
}

async fn read_server(protocol: SessionProtocol, id: String, stdout: ChildStdout) {
    let mut frames = FramedRead::new(stdout, FrameCodec::new(usize::MAX));
    while let Some(frame) = frames.next().await {
        let Ok(bytes) = frame else {
            break;
        };
        if let Ok(message) = serde_json::from_slice::<Value>(&bytes) {
            protocol.on_server_message(&id, &message);
        }
    }
    let mut rest = frames.into_inner();
    let _ = tokio::io::copy(&mut rest, &mut tokio::io::sink()).await;
}

async fn read_stderr(protocol: SessionProtocol, key: String, mut stderr: ChildStderr) {
    let mut chunk = vec![0_u8; STDERR_CHUNK];
    loop {
        match stderr.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(count) => protocol.on_stderr(&key, &chunk[..count]),
        }
    }
}

impl SessionProtocol {
    pub fn new(deps: SessionProtocolDeps) -> Self {
        Self {
            inner: Arc::new(Inner {
                deps,
                state: Mutex::new(State::default()),
            }),
        }
    }

    fn deps(&self) -> &SessionProtocolDeps {
        &self.inner.deps
    }

    fn with_session<R>(&self, id: &str, action: impl FnOnce(&mut Session) -> R) -> Option<R> {
        self.inner.state.lock().sessions.get_mut(id).map(action)
    }

    fn note(&self, key: &str, event: LspLogEvent) {
        (self.deps().note)(
            key,
            LspLogEntry {
                at: (self.deps().now)(),
                event,
            },
        );
    }

    pub fn snapshot(&self, id: &str) -> Option<SessionSnapshot> {
        self.with_session(id, |session| SessionSnapshot {
            id: session.id.clone(),
            slot: session.slot.clone(),
            key: session.key.clone(),
            signature: session.signature.clone(),
            window_id: session.window_id.clone(),
            root: session.root.clone(),
            started_at: session.started_at,
            refs: session.refs,
            initialized: session.initialized,
            stopping: session.stopping,
            shutdown_id: session.shutdown_id.clone(),
            requests: session.requests.clone(),
            settings: session.settings.clone(),
            watcher_ids: session
                .file_watchers
                .iter()
                .map(|(watcher_id, _)| watcher_id.clone())
                .collect(),
            watching: session.unwatch.is_some(),
        })
    }

    pub fn exited(&self, id: &str) -> Option<BoxFuture<'static, ()>> {
        let mut exited = self.with_session(id, |session| session.exited.clone())?;
        Some(
            async move {
                let _ = exited.wait_for(|done| *done).await;
            }
            .boxed(),
        )
    }

    pub fn forget(&self, id: &str) {
        let removed = self.inner.state.lock().sessions.remove(id);
        if let Some(unwatch) = removed.and_then(|session| session.unwatch) {
            unwatch();
        }
    }

    pub fn mark_stopping(&self, id: &str, reason: LspStopReason) {
        self.with_session(id, |session| session.stopping = Some(reason));
    }

    pub fn expect_shutdown(&self, id: &str, shutdown_id: &str) {
        self.with_session(id, |session| {
            session.shutdown_id = Some(shutdown_id.to_owned());
        });
    }

    fn attach_session(&self, request: AttachRequest) -> String {
        let (writer, outgoing) = mpsc::unbounded_channel();
        let (exited_sender, exited) = watch::channel(false);
        let settings = base_settings(&request.source, &request.root);
        let started_at = (self.deps().now)();
        let id = {
            let mut state = self.inner.state.lock();
            state.seq += 1;
            let id = format!("{SESSION_ID_PREFIX}{}", state.seq);
            state.sessions.insert(
                id.clone(),
                Session {
                    id: id.clone(),
                    slot: request.slot_key,
                    key: request.key.clone(),
                    signature: request.signature,
                    window_id: request.pane.window_id,
                    root: request.root,
                    refs: 0,
                    started_at,
                    requests: Vec::new(),
                    initialized: false,
                    stopping: None,
                    settings,
                    shutdown_id: None,
                    file_watchers: Vec::new(),
                    unwatch: None,
                    writer,
                    exited,
                },
            );
            id
        };
        let key = request.key;
        let pid = request
            .proc
            .as_ref()
            .map_or(0, |child| child.id().unwrap_or(0));
        self.note(
            &key,
            LspLogEvent::Start {
                pid,
                sandboxed: request.sandboxed,
            },
        );
        if let Some(log) = &self.deps().log {
            let mut fields = LogFields::new();
            fields.insert("server", key.as_str());
            fields.insert("sandboxed", request.sandboxed);
            log("lsp-start", fields);
        }
        match request.proc {
            Ok(child) => self.watch_child(&id, &key, child, outgoing, exited_sender),
            Err(failure) => {
                let protocol = self.clone();
                let id = id.clone();
                tokio::spawn(async move {
                    protocol.note(
                        &key,
                        LspLogEvent::SpawnFailed {
                            text: clipped_text(&failure.text),
                        },
                    );
                    (protocol.deps().on_exit)(&id, None, None);
                    let _ = exited_sender.send(true);
                });
            }
        }
        id
    }

    fn watch_child(
        &self,
        id: &str,
        key: &str,
        mut child: tokio::process::Child,
        outgoing: mpsc::UnboundedReceiver<Outgoing>,
        exited: watch::Sender<bool>,
    ) {
        if let Some(stdin) = child.stdin.take() {
            tokio::spawn(run_writer(stdin, outgoing));
        }
        if let Some(stdout) = child.stdout.take() {
            tokio::spawn(read_server(self.clone(), id.to_owned(), stdout));
        }
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(read_stderr(self.clone(), key.to_owned(), stderr));
        }
        let protocol = self.clone();
        let id = id.to_owned();
        tokio::spawn(async move {
            let status = child.wait().await.ok();
            let code = status.as_ref().and_then(ExitStatus::code);
            let signal = status.as_ref().and_then(signal_name);
            (protocol.deps().on_exit)(&id, code, signal);
            let _ = exited.send(true);
        });
    }

    pub fn push_settings(&self, id: &str, source: &LanguageServerSource) {
        let Some(root) = self.with_session(id, |session| session.root.clone()) else {
            return;
        };
        let settings = base_settings(source, &root);
        let send = self.with_session(id, |session| {
            if settings == session.settings {
                return false;
            }
            session.settings = settings;
            session.initialized
        });
        if send == Some(true) {
            self.send_settings(id);
        }
    }

    fn send_settings(&self, id: &str) {
        let Some(settings) = self.with_session(id, |session| session.settings.clone()) else {
            return;
        };
        self.write(
            id,
            &notification(
                "workspace/didChangeConfiguration",
                &json!({"settings": settings}),
            ),
        );
    }

    pub fn on_stderr(&self, key: &str, chunk: &[u8]) {
        for line in String::from_utf8_lossy(chunk).split('\n') {
            let text = line.trim_end_matches(is_js_space);
            if text.is_empty() {
                continue;
            }
            self.note(
                key,
                LspLogEvent::Stderr {
                    text: clipped_text(text),
                },
            );
        }
    }

    pub fn write(&self, id: &str, message: &Value) {
        self.with_session(id, |session| {
            let _ = session.writer.send(Outgoing::Frame(encode_frame(message)));
        });
    }

    pub fn on_server_message(&self, id: &str, message: &Value) {
        let Some(fields) = message.as_object() else {
            return;
        };
        let message_id = fields.get("id").filter(|value| is_request_id(value));
        if let Some(method) = fields.get("method").and_then(Value::as_str) {
            if method == "workspace/configuration"
                && let Some(request_id) = message_id
            {
                self.answer_configuration(id, request_id, fields.get("params"));
                return;
            }
            if method == "client/registerCapability" {
                self.watch_files(id, fields.get("params"));
            }
            if method == "client/unregisterCapability" {
                self.unwatch_files(id, fields.get("params"));
            }
        } else if let Some(response_id) = message_id {
            if self.is_shutdown_response(id, response_id) {
                self.finish_shutdown(id);
                return;
            }
            self.settle_request(id, response_id, fields);
        }
        let Some(window_id) = self.with_session(id, |session| session.window_id.clone()) else {
            return;
        };
        (self.deps().post)(&window_id, &format!("lsp:msg:{id}"), Some(message.clone()));
    }

    fn answer_configuration(&self, id: &str, request_id: &Value, params: Option<&Value>) {
        let items = params
            .and_then(Value::as_object)
            .and_then(|params| params.get("items"))
            .and_then(Value::as_array);
        let Some(settings) =
            self.with_session(id, |session| Value::Object(session.settings.clone()))
        else {
            return;
        };
        let result: Vec<Value> = items
            .into_iter()
            .flatten()
            .map(|item| {
                let section = item
                    .as_object()
                    .and_then(|item| item.get("section"))
                    .and_then(Value::as_str);
                configuration_section(&settings, section)
                    .cloned()
                    .unwrap_or(Value::Null)
            })
            .collect();
        self.write(
            id,
            &json!({"jsonrpc": "2.0", "id": request_id, "result": result}),
        );
    }

    fn is_shutdown_response(&self, id: &str, response_id: &Value) -> bool {
        self.with_session(id, |session| {
            response_id.as_str().is_some() && response_id.as_str() == session.shutdown_id.as_deref()
        })
        .unwrap_or(false)
    }

    fn settle_request(&self, id: &str, response_id: &Value, fields: &Map<String, Value>) {
        let Some((sent, key)) = self
            .with_session(id, |session| {
                let at = session
                    .requests
                    .iter()
                    .position(|(tracked, _)| same_id(tracked, response_id))?;
                Some((session.requests.remove(at).1, session.key.clone()))
            })
            .flatten()
        else {
            return;
        };
        if fields.contains_key("error") {
            let record = (self.deps().record)(&key);
            *record
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .errors
                .entry(sent)
                .or_insert(0) += 1;
        } else if sent == "initialize" {
            self.note_initialized(&key, fields.get("result"));
        }
    }

    fn note_initialized(&self, key: &str, result: Option<&Value>) {
        let info = result
            .and_then(Value::as_object)
            .and_then(|result| result.get("serverInfo"))
            .and_then(Value::as_object);
        self.note(
            key,
            LspLogEvent::Initialized {
                name: clipped_value(info.and_then(|info| info.get("name"))),
                version: clipped_value(info.and_then(|info| info.get("version"))),
            },
        );
    }

    fn watch_files(&self, id: &str, params: Option<&Value>) {
        let registrations = params
            .and_then(Value::as_object)
            .and_then(|params| params.get("registrations"))
            .and_then(Value::as_array);
        let Some(root) = self.with_session(id, |session| session.root.clone()) else {
            return;
        };
        for registration in registrations.into_iter().flatten() {
            let Some(registration) = registration.as_object() else {
                continue;
            };
            if registration.get("method").and_then(Value::as_str) != Some(WATCHED_FILES_METHOD) {
                continue;
            }
            let Some(watcher_id) = registration.get("id").and_then(Value::as_str) else {
                continue;
            };
            let options = registration.get("registerOptions").unwrap_or(&Value::Null);
            let watchers = parse_file_watchers(options, Path::new(&root));
            if watchers.is_empty() {
                continue;
            }
            self.with_session(id, |session| {
                match session
                    .file_watchers
                    .iter_mut()
                    .find(|(known, _)| known == watcher_id)
                {
                    Some(entry) => entry.1 = watchers,
                    None => session
                        .file_watchers
                        .push((watcher_id.to_owned(), watchers)),
                }
            });
        }
        let needed = self
            .with_session(id, |session| {
                !session.file_watchers.is_empty()
                    && session.unwatch.is_none()
                    && session.stopping.is_none()
            })
            .unwrap_or(false);
        if !needed {
            return;
        }
        let Some(watch_tree) = &self.deps().watch_tree else {
            return;
        };
        let protocol = self.clone();
        let session_id = id.to_owned();
        let sink: TreeSink = Arc::new(move |changes| protocol.on_tree_change(&session_id, changes));
        let Some(unwatch) = watch_tree(Path::new(&root), sink) else {
            return;
        };
        let mut spare = Some(unwatch);
        self.with_session(id, |session| {
            if session.unwatch.is_none() && session.stopping.is_none() {
                session.unwatch = spare.take();
            }
        });
        if let Some(extra) = spare {
            extra();
        }
    }

    fn unwatch_files(&self, id: &str, params: Option<&Value>) {
        let record = params.and_then(Value::as_object);
        let list = ["unregisterations", "unregistrations"]
            .iter()
            .find_map(|name| record.and_then(|record| record.get(*name)?.as_array()));
        for item in list.into_iter().flatten() {
            let Some(watcher_id) = item
                .as_object()
                .and_then(|item| item.get("id"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            self.with_session(id, |session| {
                session
                    .file_watchers
                    .retain(|(known, _)| known != watcher_id);
            });
        }
        if self
            .with_session(id, |session| session.file_watchers.is_empty())
            .unwrap_or(false)
        {
            self.stop_watching(id);
        }
    }

    pub fn stop_watching(&self, id: &str) {
        if let Some(Some(unwatch)) = self.with_session(id, |session| session.unwatch.take()) {
            unwatch();
        }
    }

    fn on_tree_change(&self, id: &str, changes: Vec<TreeChange>) {
        let events = self
            .with_session(id, |session| {
                if !session.initialized || session.stopping.is_some() {
                    return Vec::new();
                }
                let watchers: Vec<FileWatcher> = session
                    .file_watchers
                    .iter()
                    .flat_map(|(_, watchers)| watchers.iter().cloned())
                    .collect();
                watched_file_events(&watchers, &changes, Path::new(&session.root))
            })
            .unwrap_or_default();
        if events.is_empty() {
            return;
        }
        self.write(
            id,
            &notification(WATCHED_FILES_METHOD, &json!({"changes": events})),
        );
    }

    pub fn send(&self, window_id: &str, session_id: &Value, message: &Value) {
        let session_text = session_id.as_str();
        let known = session_text
            .and_then(|text| self.with_session(text, |session| session.window_id.clone()));
        let Some(owner) = known else {
            if let Some(text) = session_text.filter(|text| is_session_id(text)) {
                (self.deps().post)(window_id, &format!("lsp:exit:{text}"), None);
            }
            return;
        };
        let Some(id) = session_text else {
            return;
        };
        let stopping = self
            .with_session(id, |session| session.stopping.is_some())
            .unwrap_or(true);
        if owner != window_id || stopping {
            return;
        }
        let Some(fields) = message.as_object() else {
            return;
        };
        if let Some(method) = fields.get("method").and_then(Value::as_str) {
            match fields.get("id").filter(|value| is_request_id(value)) {
                Some(request_id) => self.track_request(id, request_id, method),
                None if method == "initialized" => {
                    self.with_session(id, |session| session.initialized = true);
                    self.write(id, message);
                    let has_settings = self
                        .with_session(id, |session| !session.settings.is_empty())
                        .unwrap_or(false);
                    if has_settings {
                        self.send_settings(id);
                    }
                    return;
                }
                None => {}
            }
        }
        self.write(id, message);
    }

    fn track_request(&self, id: &str, request_id: &Value, method: &str) {
        self.with_session(id, |session| {
            if session.requests.len() >= MAX_TRACKED_REQUESTS {
                return;
            }
            match session
                .requests
                .iter_mut()
                .find(|(tracked, _)| same_id(tracked, request_id))
            {
                Some(entry) => method.clone_into(&mut entry.1),
                None => session
                    .requests
                    .push((request_id.clone(), method.to_owned())),
            }
        });
    }

    fn finish_shutdown(&self, id: &str) {
        self.with_session(id, |session| {
            session.shutdown_id = None;
            let exit = json!({"jsonrpc": "2.0", "method": "exit"});
            let _ = session.writer.send(Outgoing::Frame(encode_frame(&exit)));
            let _ = session.writer.send(Outgoing::Close);
        });
    }
}

impl Attach for SessionProtocol {
    fn attach(&self, request: AttachRequest) -> String {
        self.attach_session(request)
    }
}
