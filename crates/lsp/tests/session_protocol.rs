#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ostia_contract::language_servers::{
    LSP_LOG_LINE_MAX, LanguageServerContribution, LanguageServerNodeRun, LanguageServerRun,
    LspLogEntry, LspLogEvent, LspStopReason,
};
use ostia_diagnostics::app_log::{LogFields, redact_secrets};
use ostia_files::file_watch::{TreeChange, TreeChangeKind};
use ostia_lsp::server_spawn::{
    AttachRequest, LanguageServerSource, PaneRef, RecordHandle, SessionProtocol as _, SpawnFailure,
};
use ostia_lsp::session_protocol::{SessionProtocol, SessionProtocolDeps, TreeSink, Unwatch};
use serde_json::{Map, Value, json};
use tempfile::TempDir;
use tokio::process::{Child, Command};

const WINDOW: &str = "window-1";

fn frame(value: &Value) -> String {
    let body = value.to_string();
    format!("Content-Length: {}\r\n\r\n{body}", body.len())
}

fn parse_frames(text: &str) -> Vec<Value> {
    let mut frames = Vec::new();
    let mut rest = text;
    while let Some((head, tail)) = rest.split_once("\r\n\r\n") {
        let length: usize = head
            .strip_prefix("Content-Length: ")
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        frames.push(serde_json::from_str(&tail[..length]).unwrap());
        rest = &tail[length..];
    }
    frames
}

async fn eventually<F: Fn() -> bool>(what: &str, ready: F) {
    for _ in 0..500 {
        if ready() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {what}");
}

fn spawn_server(script: &str, args: &[&str]) -> Child {
    Command::new("sh")
        .arg("-c")
        .arg(script)
        .arg("sh")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap()
}

fn capturing_server(out: &Path) -> Child {
    spawn_server("cat > \"$1\"", &[out.to_str().unwrap()])
}

fn talking_server(frames: &str, out: &Path) -> Child {
    spawn_server(
        "printf '%s' \"$1\"; cat > \"$2\"",
        &[frames, out.to_str().unwrap()],
    )
}

fn contribution() -> LanguageServerContribution {
    LanguageServerContribution {
        id: "ls".to_owned(),
        name: "LS".to_owned(),
        languages: vec!["gleam".to_owned()],
        document_language_ids: None,
        run: LanguageServerRun::Node(LanguageServerNodeRun {
            node: "server.js".to_owned(),
            args: Vec::new(),
        }),
        root_markers: Vec::new(),
        initialization_options: None,
        settings: None,
        setting_paths: None,
    }
}

fn object(value: Value) -> Map<String, Value> {
    value.as_object().unwrap().clone()
}

type Post = (String, String, Option<Value>);
type Exit = (String, Option<i32>, Option<String>);

struct Rig {
    _dir: TempDir,
    root: PathBuf,
    out: PathBuf,
    protocol: SessionProtocol,
    posts: Arc<Mutex<Vec<Post>>>,
    notes: Arc<Mutex<Vec<(String, LspLogEntry)>>>,
    exits: Arc<Mutex<Vec<Exit>>>,
    logs: Arc<Mutex<Vec<(String, Value)>>>,
    records: Arc<Mutex<HashMap<String, RecordHandle>>>,
    watches: Arc<Mutex<Vec<PathBuf>>>,
    unwatched: Arc<AtomicU32>,
    sink: Arc<Mutex<Option<TreeSink>>>,
}

fn rig_with(watching: bool) -> Rig {
    let dir = TempDir::new().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let out = root.join("server-input");
    let posts = Arc::new(Mutex::new(Vec::new()));
    let notes = Arc::new(Mutex::new(Vec::new()));
    let exits = Arc::new(Mutex::new(Vec::new()));
    let logs = Arc::new(Mutex::new(Vec::new()));
    let records: Arc<Mutex<HashMap<String, RecordHandle>>> = Arc::new(Mutex::new(HashMap::new()));
    let watches = Arc::new(Mutex::new(Vec::new()));
    let unwatched = Arc::new(AtomicU32::new(0));
    let sink: Arc<Mutex<Option<TreeSink>>> = Arc::new(Mutex::new(None));
    let deps = SessionProtocolDeps {
        record: {
            let records = records.clone();
            Arc::new(move |key| {
                records
                    .lock()
                    .unwrap()
                    .entry(key.to_owned())
                    .or_default()
                    .clone()
            })
        },
        note: {
            let notes = notes.clone();
            Arc::new(move |key, entry| notes.lock().unwrap().push((key.to_owned(), entry)))
        },
        now: Arc::new(|| 5_000),
        post: {
            let posts = posts.clone();
            Arc::new(move |window, channel, message| {
                posts
                    .lock()
                    .unwrap()
                    .push((window.to_owned(), channel.to_owned(), message));
            })
        },
        watch_tree: watching.then(|| {
            let watches = watches.clone();
            let unwatched = unwatched.clone();
            let sink = sink.clone();
            let watch: ostia_lsp::session_protocol::WatchTree = Arc::new(move |root, on_change| {
                watches.lock().unwrap().push(root.to_path_buf());
                *sink.lock().unwrap() = Some(on_change);
                let unwatched = unwatched.clone();
                let unwatch: Unwatch = Box::new(move || {
                    unwatched.fetch_add(1, Ordering::SeqCst);
                });
                Some(unwatch)
            });
            watch
        }),
        log: {
            let logs = logs.clone();
            Some(Arc::new(move |event: &str, fields: LogFields| {
                logs.lock()
                    .unwrap()
                    .push((event.to_owned(), fields.to_json()));
            }))
        },
        on_exit: {
            let exits = exits.clone();
            Arc::new(move |id, code, signal| {
                exits.lock().unwrap().push((id.to_owned(), code, signal));
            })
        },
    };
    Rig {
        _dir: dir,
        root,
        out,
        protocol: SessionProtocol::new(deps),
        posts,
        notes,
        exits,
        logs,
        records,
        watches,
        unwatched,
        sink,
    }
}

fn rig() -> Rig {
    rig_with(true)
}

fn request(
    rig: &Rig,
    source: LanguageServerSource,
    proc: Result<Child, SpawnFailure>,
) -> AttachRequest {
    AttachRequest {
        slot_key: "ext\nls\n/work".to_owned(),
        key: "ext\nls".to_owned(),
        signature: "sig".to_owned(),
        source,
        pane: PaneRef {
            window_id: WINDOW.to_owned(),
            workspace_id: "ws-1".to_owned(),
        },
        root: rig.root.to_string_lossy().into_owned(),
        proc,
        sandboxed: true,
    }
}

fn plain_source() -> LanguageServerSource {
    LanguageServerSource::new("/ext/dir".to_owned(), contribution())
}

fn source_with_settings(settings: Value) -> LanguageServerSource {
    let mut source = plain_source();
    source.server.settings = Some(object(settings));
    source
}

impl Rig {
    fn attach_capturing(&self) -> String {
        self.attach_source(plain_source())
    }

    fn attach_source(&self, source: LanguageServerSource) -> String {
        let child = capturing_server(&self.out);
        self.protocol.attach(request(self, source, Ok(child)))
    }

    fn events(&self) -> Vec<LspLogEvent> {
        self.notes
            .lock()
            .unwrap()
            .iter()
            .map(|(_, entry)| entry.event.clone())
            .collect()
    }

    fn posted(&self) -> Vec<Post> {
        self.posts.lock().unwrap().clone()
    }

    fn errors(&self, key: &str) -> HashMap<String, u32> {
        self.records
            .lock()
            .unwrap()
            .get(key)
            .map(|record| record.lock().unwrap().errors.clone())
            .unwrap_or_default()
    }

    fn initialized(&self, id: &str) {
        self.protocol.send(
            WINDOW,
            &json!(id),
            &json!({"jsonrpc": "2.0", "method": "initialized"}),
        );
    }

    async fn written_before_sentinel(&self, id: &str) -> Vec<Value> {
        let sentinel = json!({"jsonrpc": "2.0", "method": "sentinel"});
        self.protocol.write(id, &sentinel);
        let out = self.out.clone();
        let mut frames = Vec::new();
        for _ in 0..500 {
            let text = std::fs::read_to_string(&out).unwrap_or_default();
            frames = parse_frames(&text);
            if frames.last() == Some(&sentinel) {
                frames.pop();
                return frames;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("the sentinel never arrived, got {frames:?}");
    }
}

async fn within<F: Future>(future: F) -> F::Output {
    tokio::time::timeout(Duration::from_secs(5), future)
        .await
        .unwrap()
}

fn watch_registration(id: &str, pattern: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": 9,
        "method": "client/registerCapability",
        "params": {"registrations": [{
            "id": id,
            "method": "workspace/didChangeWatchedFiles",
            "registerOptions": {"watchers": [{"globPattern": pattern}]}
        }]}
    })
}

#[tokio::test]
async fn numbers_sessions_in_order() {
    let rig = rig();
    assert_eq!(rig.attach_capturing(), "lsp-1");
    assert_eq!(rig.attach_capturing(), "lsp-2");
}

#[tokio::test]
async fn records_the_new_session_with_its_slot_window_root_and_start_time() {
    let rig = rig();
    let id = rig.attach_capturing();
    let session = rig.protocol.snapshot(&id).unwrap();
    assert_eq!(session.id, id);
    assert_eq!(session.slot, "ext\nls\n/work");
    assert_eq!(session.key, "ext\nls");
    assert_eq!(session.signature, "sig");
    assert_eq!(session.window_id, WINDOW);
    assert_eq!(session.root, rig.root.to_string_lossy());
    assert_eq!(session.started_at, 5_000);
    assert_eq!(session.refs, 0);
    assert!(!session.initialized);
    assert_eq!(session.stopping, None);
    assert_eq!(session.shutdown_id, None);
    assert!(session.requests.is_empty());
    assert!(session.settings.is_empty());
}

#[tokio::test]
async fn notes_and_logs_the_start_with_the_pid_and_the_sandbox_flag() {
    let rig = rig();
    let child = capturing_server(&rig.out);
    let pid = child.id().unwrap();
    rig.protocol
        .attach(request(&rig, plain_source(), Ok(child)));
    assert_eq!(
        rig.events(),
        vec![LspLogEvent::Start {
            pid,
            sandboxed: true
        }]
    );
    assert_eq!(rig.notes.lock().unwrap()[0].0, "ext\nls");
    assert_eq!(rig.notes.lock().unwrap()[0].1.at, 5_000);
    assert_eq!(
        rig.logs.lock().unwrap().clone(),
        vec![(
            "lsp-start".to_owned(),
            json!({"server": "ext\nls", "sandboxed": true})
        )]
    );
}

#[tokio::test]
async fn builds_the_settings_from_the_server_settings_and_the_setting_values() {
    let rig = rig();
    let mut source = source_with_settings(json!({
        "gleam": {"dir": "{extensionDir}/x", "root": "{root}", "mode": "loose"}
    }));
    source.server.setting_paths = Some(object(
        json!({"mode": "gleam.mode", "extra": "gleam.extra"}),
    ));
    source.setting_values = object(json!({"mode": "strict"}));
    let id = rig.attach_source(source);
    let root = rig.root.to_string_lossy().into_owned();
    assert_eq!(
        Value::Object(rig.protocol.snapshot(&id).unwrap().settings),
        json!({"gleam": {"dir": "/ext/dir/x", "root": root, "mode": "strict"}})
    );
}

#[tokio::test]
async fn posts_the_messages_the_server_writes_to_the_window() {
    let rig = rig();
    let first =
        json!({"jsonrpc": "2.0", "method": "window/logMessage", "params": {"message": "hi"}});
    let second = json!({"jsonrpc": "2.0", "method": "$/progress", "params": {"value": 1}});
    let frames = format!("{}{}", frame(&first), frame(&second));
    let child = talking_server(&frames, &rig.out);
    let id = rig
        .protocol
        .attach(request(&rig, plain_source(), Ok(child)));
    eventually("two posts", || rig.posted().len() == 2).await;
    assert_eq!(
        rig.posted(),
        vec![
            (WINDOW.to_owned(), format!("lsp:msg:{id}"), Some(first)),
            (WINDOW.to_owned(), format!("lsp:msg:{id}"), Some(second)),
        ]
    );
}

#[tokio::test]
async fn ignores_a_broken_message_stream_from_the_server() {
    let rig = rig();
    let child = talking_server("this is not a framed message\r\n\r\n", &rig.out);
    let id = rig
        .protocol
        .attach(request(&rig, plain_source(), Ok(child)));
    rig.protocol
        .write(&id, &json!({"jsonrpc": "2.0", "method": "ping"}));
    eventually("the ping reaches the server", || {
        std::fs::read_to_string(&rig.out).is_ok_and(|text| text.contains("ping"))
    })
    .await;
    assert!(rig.posted().is_empty());
    assert!(rig.exits.lock().unwrap().is_empty());
}

#[tokio::test]
async fn notes_each_stderr_line_trimmed_and_without_blank_lines() {
    let rig = rig();
    rig.protocol
        .on_stderr("k", b"first line   \n\n  \nsecond\t\r\nlast");
    assert_eq!(
        rig.events(),
        vec![
            LspLogEvent::Stderr {
                text: "first line".to_owned()
            },
            LspLogEvent::Stderr {
                text: "second".to_owned()
            },
            LspLogEvent::Stderr {
                text: "last".to_owned()
            },
        ]
    );
}

#[tokio::test]
async fn redacts_and_truncates_a_stderr_line() {
    let rig = rig();
    let long = "ab ".repeat(300);
    rig.protocol.on_stderr("k", long.as_bytes());
    rig.protocol.on_stderr(
        "k",
        b"Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCDEF",
    );
    let events = rig.events();
    let expected_long: String = redact_secrets(long.trim_end())
        .chars()
        .take(LSP_LOG_LINE_MAX)
        .collect();
    assert_eq!(
        events[0],
        LspLogEvent::Stderr {
            text: expected_long
        }
    );
    let LspLogEvent::Stderr { text } = &events[1] else {
        panic!("expected a stderr note");
    };
    assert!(
        !text.contains("abcdefghijklmnopqrstuvwxyz0123456789ABCDEF"),
        "{text}"
    );
}

#[tokio::test]
async fn decodes_stderr_bytes_that_are_not_utf8_as_replacement_characters() {
    let rig = rig();
    rig.protocol.on_stderr("k", &[b'a', 0xff, b'b']);
    assert_eq!(
        rig.events(),
        vec![LspLogEvent::Stderr {
            text: "a\u{fffd}b".to_owned()
        }]
    );
}

#[tokio::test]
async fn notes_the_stderr_the_process_writes() {
    let rig = rig();
    let child = spawn_server("echo oops >&2; cat > /dev/null", &[]);
    rig.protocol
        .attach(request(&rig, plain_source(), Ok(child)));
    eventually("the stderr note", || {
        rig.events().contains(&LspLogEvent::Stderr {
            text: "oops".to_owned(),
        })
    })
    .await;
}

#[tokio::test]
async fn notes_a_spawn_failure_with_a_redacted_clipped_text_and_reports_the_exit() {
    let rig = rig();
    let text = format!("spawn failed {}", "word ".repeat(200));
    let id = rig.protocol.attach(request(
        &rig,
        plain_source(),
        Err(SpawnFailure { text: text.clone() }),
    ));
    let expected: String = redact_secrets(&text)
        .chars()
        .take(LSP_LOG_LINE_MAX)
        .collect();
    eventually("the exit", || !rig.exits.lock().unwrap().is_empty()).await;
    assert_eq!(
        rig.events(),
        vec![
            LspLogEvent::Start {
                pid: 0,
                sandboxed: true
            },
            LspLogEvent::SpawnFailed { text: expected },
        ]
    );
    assert_eq!(rig.exits.lock().unwrap().clone(), vec![(id, None, None)]);
}

#[tokio::test]
async fn reports_the_exit_code_of_the_process() {
    let rig = rig();
    let child = spawn_server("exit 3", &[]);
    let id = rig
        .protocol
        .attach(request(&rig, plain_source(), Ok(child)));
    eventually("the exit", || !rig.exits.lock().unwrap().is_empty()).await;
    assert_eq!(rig.exits.lock().unwrap().clone(), vec![(id, Some(3), None)]);
}

#[tokio::test]
async fn reports_the_signal_that_ended_the_process() {
    let rig = rig();
    let child = spawn_server("kill -KILL $$", &[]);
    let id = rig
        .protocol
        .attach(request(&rig, plain_source(), Ok(child)));
    eventually("the exit", || !rig.exits.lock().unwrap().is_empty()).await;
    assert_eq!(
        rig.exits.lock().unwrap().clone(),
        vec![(id, None, Some("SIGKILL".to_owned()))]
    );
}

#[tokio::test]
async fn resolves_the_exited_promise_for_a_session_when_the_process_ends() {
    let rig = rig();
    let child = spawn_server("exit 0", &[]);
    let id = rig
        .protocol
        .attach(request(&rig, plain_source(), Ok(child)));
    within(rig.protocol.exited(&id).unwrap()).await;
}

#[tokio::test]
async fn ignores_a_message_that_is_not_an_object() {
    let rig = rig();
    let id = rig.attach_capturing();
    for message in [
        json!("text"),
        json!(4),
        json!(null),
        json!([1]),
        json!(true),
    ] {
        rig.protocol.on_server_message(&id, &message);
    }
    assert!(rig.posted().is_empty());
    assert!(rig.written_before_sentinel(&id).await.is_empty());
}

#[tokio::test]
async fn answers_a_configuration_request_from_the_settings_and_does_not_post_it() {
    let rig = rig();
    let settings = json!({"a": {"b": 1}, "c": true});
    let id = rig.attach_source(source_with_settings(settings.clone()));
    rig.protocol.on_server_message(
        &id,
        &json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "workspace/configuration",
            "params": {"items": [
                {"section": "a"},
                {"section": "a.b"},
                {"section": "missing"},
                {"section": ""},
                {},
                "junk"
            ]}
        }),
    );
    assert!(rig.posted().is_empty());
    assert_eq!(
        rig.written_before_sentinel(&id).await,
        vec![json!({
            "jsonrpc": "2.0",
            "id": 7,
            "result": [{"b": 1}, 1, null, settings, settings, settings]
        })]
    );
}

#[tokio::test]
async fn answers_a_configuration_request_with_a_string_id_and_no_items() {
    let rig = rig();
    let id = rig.attach_capturing();
    rig.protocol.on_server_message(
        &id,
        &json!({"id": "abc", "method": "workspace/configuration", "params": {"items": "no"}}),
    );
    rig.protocol
        .on_server_message(&id, &json!({"id": 8, "method": "workspace/configuration"}));
    assert_eq!(
        rig.written_before_sentinel(&id).await,
        vec![
            json!({"jsonrpc": "2.0", "id": "abc", "result": []}),
            json!({"jsonrpc": "2.0", "id": 8, "result": []}),
        ]
    );
}

#[tokio::test]
async fn posts_a_configuration_notification_that_has_no_id() {
    let rig = rig();
    let id = rig.attach_capturing();
    let message = json!({"method": "workspace/configuration", "params": {"items": [{}]}});
    rig.protocol.on_server_message(&id, &message);
    assert_eq!(
        rig.posted(),
        vec![(WINDOW.to_owned(), format!("lsp:msg:{id}"), Some(message))]
    );
    assert!(rig.written_before_sentinel(&id).await.is_empty());
}

#[tokio::test]
async fn posts_other_requests_and_notifications_from_the_server() {
    let rig = rig();
    let id = rig.attach_capturing();
    let request = json!({"jsonrpc": "2.0", "id": 3, "method": "window/showMessageRequest"});
    let note = json!({"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics"});
    rig.protocol.on_server_message(&id, &request);
    rig.protocol.on_server_message(&id, &note);
    assert_eq!(
        rig.posted(),
        vec![
            (WINDOW.to_owned(), format!("lsp:msg:{id}"), Some(request)),
            (WINDOW.to_owned(), format!("lsp:msg:{id}"), Some(note)),
        ]
    );
}

#[tokio::test]
async fn counts_an_error_response_by_the_method_that_was_sent() {
    let rig = rig();
    let id = rig.attach_capturing();
    for request_id in [1, 2, 3] {
        rig.protocol.send(
            WINDOW,
            &json!(id),
            &json!({"jsonrpc": "2.0", "id": request_id, "method": "textDocument/hover"}),
        );
    }
    rig.protocol.send(
        WINDOW,
        &json!(id),
        &json!({"jsonrpc": "2.0", "id": "s", "method": "textDocument/definition"}),
    );
    for request_id in [json!(1), json!(2), json!("s")] {
        rig.protocol.on_server_message(
            &id,
            &json!({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32603, "message": "x"}}),
        );
    }
    let errors = rig.errors("ext\nls");
    assert_eq!(errors.get("textDocument/hover"), Some(&2));
    assert_eq!(errors.get("textDocument/definition"), Some(&1));
    assert_eq!(rig.protocol.snapshot(&id).unwrap().requests.len(), 1);
    assert_eq!(rig.posted().len(), 3);
}

#[tokio::test]
async fn forgets_a_request_when_its_response_arrives_and_does_not_count_a_second_error() {
    let rig = rig();
    let id = rig.attach_capturing();
    rig.protocol.send(
        WINDOW,
        &json!(id),
        &json!({"jsonrpc": "2.0", "id": 1, "method": "textDocument/hover"}),
    );
    let error = json!({"jsonrpc": "2.0", "id": 1, "error": {"code": 1, "message": "x"}});
    rig.protocol.on_server_message(&id, &error);
    rig.protocol.on_server_message(&id, &error);
    assert_eq!(rig.errors("ext\nls").get("textDocument/hover"), Some(&1));
    assert_eq!(rig.posted().len(), 2);
}

#[tokio::test]
async fn treats_a_number_id_and_a_string_id_as_different_requests() {
    let rig = rig();
    let id = rig.attach_capturing();
    rig.protocol.send(
        WINDOW,
        &json!(id),
        &json!({"jsonrpc": "2.0", "id": 1, "method": "textDocument/hover"}),
    );
    rig.protocol.on_server_message(
        &id,
        &json!({"jsonrpc": "2.0", "id": "1", "error": {"code": 1, "message": "x"}}),
    );
    assert!(rig.errors("ext\nls").is_empty());
    assert_eq!(rig.protocol.snapshot(&id).unwrap().requests.len(), 1);
}

#[tokio::test]
async fn notes_the_server_name_and_version_from_the_initialize_result() {
    let rig = rig();
    let id = rig.attach_capturing();
    rig.protocol.send(
        WINDOW,
        &json!(id),
        &json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}),
    );
    rig.protocol.on_server_message(
        &id,
        &json!({"jsonrpc": "2.0", "id": 1, "result": {"serverInfo": {"name": "gleam-ls", "version": "1.2.3"}}}),
    );
    assert!(rig.events().contains(&LspLogEvent::Initialized {
        name: "gleam-ls".to_owned(),
        version: "1.2.3".to_owned()
    }));
    assert_eq!(rig.posted().len(), 1);
}

#[tokio::test]
async fn clips_the_initialized_name_to_eighty_units_and_blanks_values_that_are_not_text() {
    let rig = rig();
    let id = rig.attach_capturing();
    for (request_id, result) in [
        (
            1,
            json!({"serverInfo": {"name": "n".repeat(100), "version": 3}}),
        ),
        (2, json!({"serverInfo": "no"})),
        (3, json!(null)),
    ] {
        rig.protocol.send(
            WINDOW,
            &json!(id),
            &json!({"jsonrpc": "2.0", "id": request_id, "method": "initialize"}),
        );
        rig.protocol.on_server_message(
            &id,
            &json!({"jsonrpc": "2.0", "id": request_id, "result": result}),
        );
    }
    let initialized: Vec<LspLogEvent> = rig
        .events()
        .into_iter()
        .filter(|event| matches!(event, LspLogEvent::Initialized { .. }))
        .collect();
    assert_eq!(
        initialized,
        vec![
            LspLogEvent::Initialized {
                name: "n".repeat(80),
                version: String::new()
            },
            LspLogEvent::Initialized {
                name: String::new(),
                version: String::new()
            },
            LspLogEvent::Initialized {
                name: String::new(),
                version: String::new()
            },
        ]
    );
}

#[tokio::test]
async fn does_not_note_initialized_for_an_error_response_or_another_method() {
    let rig = rig();
    let id = rig.attach_capturing();
    rig.protocol.send(
        WINDOW,
        &json!(id),
        &json!({"jsonrpc": "2.0", "id": 1, "method": "initialize"}),
    );
    rig.protocol.on_server_message(
        &id,
        &json!({"jsonrpc": "2.0", "id": 1, "error": {"code": 1, "message": "x"}, "result": {}}),
    );
    rig.protocol.send(
        WINDOW,
        &json!(id),
        &json!({"jsonrpc": "2.0", "id": 2, "method": "textDocument/hover"}),
    );
    rig.protocol
        .on_server_message(&id, &json!({"jsonrpc": "2.0", "id": 2, "result": null}));
    assert!(
        !rig.events()
            .iter()
            .any(|event| matches!(event, LspLogEvent::Initialized { .. }))
    );
}

#[tokio::test]
async fn finishes_a_shutdown_by_sending_exit_and_closing_the_input() {
    let rig = rig();
    let id = rig.attach_capturing();
    rig.protocol.expect_shutdown(&id, "shutdown-1");
    rig.protocol.on_server_message(
        &id,
        &json!({"jsonrpc": "2.0", "id": "shutdown-1", "result": null}),
    );
    assert!(rig.posted().is_empty());
    assert_eq!(rig.protocol.snapshot(&id).unwrap().shutdown_id, None);
    eventually("the process to end", || {
        !rig.exits.lock().unwrap().is_empty()
    })
    .await;
    assert_eq!(rig.exits.lock().unwrap()[0], (id.clone(), Some(0), None));
    let text = std::fs::read_to_string(&rig.out).unwrap();
    assert_eq!(
        parse_frames(&text),
        vec![json!({"jsonrpc": "2.0", "method": "exit"})]
    );
}

#[tokio::test]
async fn posts_a_response_whose_id_is_not_the_shutdown_id() {
    let rig = rig();
    let id = rig.attach_capturing();
    rig.protocol.expect_shutdown(&id, "shutdown-1");
    let message = json!({"jsonrpc": "2.0", "id": "other", "result": null});
    rig.protocol.on_server_message(&id, &message);
    assert_eq!(rig.posted().len(), 1);
    assert_eq!(
        rig.protocol.snapshot(&id).unwrap().shutdown_id,
        Some("shutdown-1".to_owned())
    );
}

#[tokio::test]
async fn sends_a_message_from_the_window_to_the_server() {
    let rig = rig();
    let id = rig.attach_capturing();
    let notification =
        json!({"jsonrpc": "2.0", "method": "textDocument/didOpen", "params": {"a": 1}});
    let response = json!({"jsonrpc": "2.0", "id": 5, "result": null});
    rig.protocol.send(WINDOW, &json!(id), &notification);
    rig.protocol.send(WINDOW, &json!(id), &response);
    assert_eq!(
        rig.written_before_sentinel(&id).await,
        vec![notification, response]
    );
    assert!(rig.protocol.snapshot(&id).unwrap().requests.is_empty());
}

#[tokio::test]
async fn tracks_a_request_by_its_id_and_sends_it() {
    let rig = rig();
    let id = rig.attach_capturing();
    let hover = json!({"jsonrpc": "2.0", "id": 4, "method": "textDocument/hover"});
    let named = json!({"jsonrpc": "2.0", "id": "x", "method": "textDocument/definition"});
    rig.protocol.send(WINDOW, &json!(id), &hover);
    rig.protocol.send(WINDOW, &json!(id), &named);
    assert_eq!(
        rig.protocol.snapshot(&id).unwrap().requests,
        vec![
            (json!(4), "textDocument/hover".to_owned()),
            (json!("x"), "textDocument/definition".to_owned())
        ]
    );
    assert_eq!(rig.written_before_sentinel(&id).await, vec![hover, named]);
}

#[tokio::test]
async fn stops_tracking_after_two_thousand_requests_but_still_sends() {
    let rig = rig();
    let id = rig.attach_capturing();
    for request_id in 0..2_001 {
        rig.protocol.send(
            WINDOW,
            &json!(id),
            &json!({"jsonrpc": "2.0", "id": request_id, "method": "textDocument/hover"}),
        );
    }
    assert_eq!(rig.protocol.snapshot(&id).unwrap().requests.len(), 2_000);
    let written = rig.written_before_sentinel(&id).await;
    assert_eq!(written.len(), 2_001);
    assert_eq!(written[2_000]["id"], 2_000);
}

#[tokio::test]
async fn tells_the_window_when_the_session_is_unknown() {
    let rig = rig();
    rig.protocol
        .send("window-9", &json!("lsp-12"), &json!({"method": "x"}));
    rig.protocol
        .send(WINDOW, &json!("lsp-999999999999"), &json!({"method": "x"}));
    assert_eq!(
        rig.posted(),
        vec![
            ("window-9".to_owned(), "lsp:exit:lsp-12".to_owned(), None),
            (
                WINDOW.to_owned(),
                "lsp:exit:lsp-999999999999".to_owned(),
                None
            ),
        ]
    );
}

#[tokio::test]
async fn ignores_a_send_to_an_id_that_is_not_a_session_id() {
    let rig = rig();
    for session in [
        json!("lsp-"),
        json!("lsp-1234567890123"),
        json!("lsp-1x"),
        json!("LSP-1"),
        json!("other"),
        json!(""),
        json!(5),
        json!(null),
        json!({"id": "lsp-1"}),
    ] {
        rig.protocol.send(WINDOW, &session, &json!({"method": "x"}));
    }
    assert!(rig.posted().is_empty());
}

#[tokio::test]
async fn ignores_a_send_from_another_window_to_a_stopping_session_or_with_a_bad_message() {
    let rig = rig();
    let id = rig.attach_capturing();
    rig.protocol.send(
        "window-2",
        &json!(id),
        &json!({"jsonrpc": "2.0", "method": "foreign"}),
    );
    for message in [json!("text"), json!(null), json!([1]), json!(3)] {
        rig.protocol.send(WINDOW, &json!(id), &message);
    }
    rig.protocol.mark_stopping(&id, LspStopReason::Idle);
    rig.protocol.send(
        WINDOW,
        &json!(id),
        &json!({"jsonrpc": "2.0", "method": "late"}),
    );
    assert!(rig.protocol.snapshot(&id).unwrap().requests.is_empty());
    assert!(rig.posted().is_empty());
    assert!(rig.written_before_sentinel(&id).await.is_empty());
}

#[tokio::test]
async fn does_not_track_a_request_whose_method_is_not_text() {
    let rig = rig();
    let id = rig.attach_capturing();
    let odd = json!({"jsonrpc": "2.0", "id": 1, "method": 5});
    rig.protocol.send(WINDOW, &json!(id), &odd);
    assert!(rig.protocol.snapshot(&id).unwrap().requests.is_empty());
    assert_eq!(rig.written_before_sentinel(&id).await, vec![odd]);
}

#[tokio::test]
async fn sends_the_settings_after_the_initialized_notification() {
    let rig = rig();
    let settings = json!({"gleam": {"mode": "strict"}});
    let id = rig.attach_source(source_with_settings(settings.clone()));
    rig.initialized(&id);
    assert!(rig.protocol.snapshot(&id).unwrap().initialized);
    assert_eq!(
        rig.written_before_sentinel(&id).await,
        vec![
            json!({"jsonrpc": "2.0", "method": "initialized"}),
            json!({"jsonrpc": "2.0", "method": "workspace/didChangeConfiguration", "params": {"settings": settings}}),
        ]
    );
}

#[tokio::test]
async fn sends_no_settings_after_initialized_when_there_are_none() {
    let rig = rig();
    let id = rig.attach_capturing();
    rig.initialized(&id);
    assert_eq!(
        rig.written_before_sentinel(&id).await,
        vec![json!({"jsonrpc": "2.0", "method": "initialized"})]
    );
}

#[tokio::test]
async fn pushes_changed_settings_to_an_initialized_session_only() {
    let rig = rig();
    let mut source = source_with_settings(json!({"gleam": {"mode": "loose"}}));
    source.server.setting_paths = Some(object(json!({"mode": "gleam.mode"})));
    let id = rig.attach_source(source.clone());
    source.setting_values = object(json!({"mode": "strict"}));
    rig.protocol.push_settings(&id, &source);
    assert_eq!(
        Value::Object(rig.protocol.snapshot(&id).unwrap().settings),
        json!({"gleam": {"mode": "strict"}})
    );
    assert!(rig.written_before_sentinel(&id).await.is_empty());
    rig.initialized(&id);
    source.setting_values = object(json!({"mode": "off"}));
    rig.protocol.push_settings(&id, &source);
    let written = rig.written_before_sentinel(&id).await;
    assert_eq!(written.len(), 3);
    assert_eq!(
        written[2],
        json!({"jsonrpc": "2.0", "method": "workspace/didChangeConfiguration", "params": {"settings": {"gleam": {"mode": "off"}}}})
    );
}

#[tokio::test]
async fn does_not_push_settings_that_did_not_change() {
    let rig = rig();
    let source = source_with_settings(json!({"gleam": {"mode": "loose"}}));
    let id = rig.attach_source(source.clone());
    rig.initialized(&id);
    rig.protocol.push_settings(&id, &source);
    assert_eq!(rig.written_before_sentinel(&id).await.len(), 2);
}

#[tokio::test]
async fn swallows_a_write_to_a_process_that_has_ended() {
    let rig = rig();
    let child = spawn_server("exit 0", &[]);
    let id = rig
        .protocol
        .attach(request(&rig, plain_source(), Ok(child)));
    within(rig.protocol.exited(&id).unwrap()).await;
    rig.protocol
        .write(&id, &json!({"jsonrpc": "2.0", "method": "late"}));
    rig.protocol.send(
        WINDOW,
        &json!(id),
        &json!({"jsonrpc": "2.0", "method": "late"}),
    );
}

#[tokio::test]
async fn starts_watching_the_folder_when_the_server_registers_file_watchers() {
    let rig = rig();
    let id = rig.attach_capturing();
    let message = watch_registration("w1", "**/*.gleam");
    rig.protocol.on_server_message(&id, &message);
    assert_eq!(rig.watches.lock().unwrap().clone(), vec![rig.root.clone()]);
    assert_eq!(
        rig.protocol.snapshot(&id).unwrap().watcher_ids,
        vec!["w1".to_owned()]
    );
    assert_eq!(
        rig.posted(),
        vec![(WINDOW.to_owned(), format!("lsp:msg:{id}"), Some(message))]
    );
}

#[tokio::test]
async fn watches_the_folder_once_for_several_registrations() {
    let rig = rig();
    let id = rig.attach_capturing();
    rig.protocol
        .on_server_message(&id, &watch_registration("w1", "**/*.gleam"));
    rig.protocol
        .on_server_message(&id, &watch_registration("w2", "**/*.toml"));
    assert_eq!(rig.watches.lock().unwrap().len(), 1);
    assert_eq!(
        rig.protocol.snapshot(&id).unwrap().watcher_ids,
        vec!["w1".to_owned(), "w2".to_owned()]
    );
}

#[tokio::test]
async fn ignores_registrations_that_are_not_valid_file_watchers() {
    let rig = rig();
    let id = rig.attach_capturing();
    let cases = [
        json!({"params": {"registrations": [{"id": "a", "method": "workspace/didChangeConfiguration", "registerOptions": {"watchers": [{"globPattern": "**"}]}}]}}),
        json!({"params": {"registrations": [{"id": 5, "method": "workspace/didChangeWatchedFiles", "registerOptions": {"watchers": [{"globPattern": "**"}]}}]}}),
        json!({"params": {"registrations": [{"id": "b", "method": "workspace/didChangeWatchedFiles", "registerOptions": {"watchers": []}}]}}),
        json!({"params": {"registrations": [{"id": "c", "method": "workspace/didChangeWatchedFiles", "registerOptions": {"watchers": [{"globPattern": ""}]}}]}}),
        json!({"params": {"registrations": "no"}}),
        json!({"params": "no"}),
        json!({}),
        json!({"params": {"registrations": ["x", null, 4]}}),
    ];
    for (index, case) in cases.iter().enumerate() {
        let mut message = case.clone();
        let fields = message.as_object_mut().unwrap();
        fields.insert("jsonrpc".to_owned(), json!("2.0"));
        fields.insert("id".to_owned(), json!(index));
        fields.insert("method".to_owned(), json!("client/registerCapability"));
        rig.protocol.on_server_message(&id, &message);
    }
    assert!(rig.watches.lock().unwrap().is_empty());
    assert!(rig.protocol.snapshot(&id).unwrap().watcher_ids.is_empty());
    assert_eq!(rig.posted().len(), cases.len());
}

#[tokio::test]
async fn does_not_start_watching_for_a_stopping_session() {
    let rig = rig();
    let id = rig.attach_capturing();
    rig.protocol.mark_stopping(&id, LspStopReason::Restart);
    rig.protocol
        .on_server_message(&id, &watch_registration("w1", "**/*.gleam"));
    assert!(rig.watches.lock().unwrap().is_empty());
    assert_eq!(
        rig.protocol.snapshot(&id).unwrap().watcher_ids,
        vec!["w1".to_owned()]
    );
}

#[tokio::test]
async fn keeps_the_registration_when_no_tree_watcher_is_available() {
    let rig = rig_with(false);
    let id = rig.attach_capturing();
    rig.protocol
        .on_server_message(&id, &watch_registration("w1", "**/*.gleam"));
    assert_eq!(
        rig.protocol.snapshot(&id).unwrap().watcher_ids,
        vec!["w1".to_owned()]
    );
    assert!(!rig.protocol.snapshot(&id).unwrap().watching);
}

#[tokio::test]
async fn stops_watching_when_the_last_registration_is_removed() {
    let rig = rig();
    let id = rig.attach_capturing();
    rig.protocol
        .on_server_message(&id, &watch_registration("w1", "**/*.gleam"));
    rig.protocol
        .on_server_message(&id, &watch_registration("w2", "**/*.toml"));
    let unregister = |ids: &[&str], key: &str| {
        json!({
            "jsonrpc": "2.0",
            "id": 20,
            "method": "client/unregisterCapability",
            "params": {key: ids.iter().map(|item| json!({"id": item, "method": "workspace/didChangeWatchedFiles"})).collect::<Vec<_>>()}
        })
    };
    rig.protocol
        .on_server_message(&id, &unregister(&["w1"], "unregisterations"));
    assert_eq!(rig.unwatched.load(Ordering::SeqCst), 0);
    assert!(rig.protocol.snapshot(&id).unwrap().watching);
    rig.protocol
        .on_server_message(&id, &unregister(&["w2"], "unregistrations"));
    assert_eq!(rig.unwatched.load(Ordering::SeqCst), 1);
    let session = rig.protocol.snapshot(&id).unwrap();
    assert!(!session.watching);
    assert!(session.watcher_ids.is_empty());
    assert_eq!(rig.posted().len(), 4);
}

#[tokio::test]
async fn ignores_an_unregistration_that_is_malformed() {
    let rig = rig();
    let id = rig.attach_capturing();
    rig.protocol
        .on_server_message(&id, &watch_registration("w1", "**/*.gleam"));
    for params in [
        json!(null),
        json!({}),
        json!({"unregisterations": "no"}),
        json!({"unregisterations": [{"id": 4}, "x", null]}),
        json!({"unregisterations": [{"id": "other"}]}),
    ] {
        rig.protocol.on_server_message(
            &id,
            &json!({"jsonrpc": "2.0", "id": 21, "method": "client/unregisterCapability", "params": params}),
        );
    }
    assert_eq!(
        rig.protocol.snapshot(&id).unwrap().watcher_ids,
        vec!["w1".to_owned()]
    );
    assert_eq!(rig.unwatched.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn prefers_the_misspelled_unregisterations_list_when_both_are_present() {
    let rig = rig();
    let id = rig.attach_capturing();
    rig.protocol
        .on_server_message(&id, &watch_registration("w1", "**/*.gleam"));
    rig.protocol.on_server_message(
        &id,
        &json!({"jsonrpc": "2.0", "id": 22, "method": "client/unregisterCapability", "params": {
            "unregisterations": [{"id": "nope"}],
            "unregistrations": [{"id": "w1"}]
        }}),
    );
    assert_eq!(
        rig.protocol.snapshot(&id).unwrap().watcher_ids,
        vec!["w1".to_owned()]
    );
}

#[tokio::test]
async fn stop_watching_calls_the_unwatch_once() {
    let rig = rig();
    let id = rig.attach_capturing();
    rig.protocol
        .on_server_message(&id, &watch_registration("w1", "**/*.gleam"));
    rig.protocol.stop_watching(&id);
    rig.protocol.stop_watching(&id);
    assert_eq!(rig.unwatched.load(Ordering::SeqCst), 1);
    assert!(!rig.protocol.snapshot(&id).unwrap().watching);
}

#[tokio::test]
async fn forwards_matching_tree_changes_to_an_initialized_server() {
    let rig = rig();
    let id = rig.attach_capturing();
    rig.initialized(&id);
    rig.protocol
        .on_server_message(&id, &watch_registration("w1", "**/*.gleam"));
    let sink = rig.sink.lock().unwrap().clone().unwrap();
    let hit = rig.root.join("src/main.gleam");
    sink(vec![
        TreeChange {
            path: hit.clone(),
            kind: TreeChangeKind::Changed,
        },
        TreeChange {
            path: rig.root.join("README.md"),
            kind: TreeChangeKind::Changed,
        },
    ]);
    let written = rig.written_before_sentinel(&id).await;
    assert_eq!(
        written[1],
        json!({
            "jsonrpc": "2.0",
            "method": "workspace/didChangeWatchedFiles",
            "params": {"changes": [{"uri": format!("file://{}", hit.display()), "type": 2}]}
        })
    );
    assert_eq!(written.len(), 2);
}

#[tokio::test]
async fn sends_nothing_for_tree_changes_before_initialized_or_while_stopping_or_with_no_match() {
    let rig = rig();
    let id = rig.attach_capturing();
    rig.protocol
        .on_server_message(&id, &watch_registration("w1", "**/*.gleam"));
    let sink = rig.sink.lock().unwrap().clone().unwrap();
    let hit = TreeChange {
        path: rig.root.join("a.gleam"),
        kind: TreeChangeKind::Created,
    };
    sink(vec![hit.clone()]);
    rig.initialized(&id);
    sink(vec![TreeChange {
        path: rig.root.join("a.md"),
        kind: TreeChangeKind::Created,
    }]);
    rig.protocol.mark_stopping(&id, LspStopReason::Idle);
    sink(vec![hit]);
    let written = rig.written_before_sentinel(&id).await;
    assert_eq!(
        written,
        vec![json!({"jsonrpc": "2.0", "method": "initialized"})]
    );
}
