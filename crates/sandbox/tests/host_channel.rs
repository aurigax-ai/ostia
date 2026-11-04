#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ostia_base::process::current_uid;
use ostia_sandbox::host_channel::{
    HostChannelError, JsonLines, ListeningChannel, connect_host_channel, listen_host_channel,
    staging_path,
};
use ostia_sandbox::protocol::HOST_PROTOCOL_VERSION;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::net::unix::OwnedWriteHalf;
use tokio::task::JoinHandle;

const MESSAGE_MAX_BYTES: usize = 8 * 1024 * 1024;

type Seen = Arc<Mutex<Vec<Value>>>;

fn seen_len(seen: &Seen) -> usize {
    seen.lock().unwrap().len()
}

fn seen_all(seen: &Seen) -> Vec<Value> {
    seen.lock().unwrap().clone()
}

async fn until(mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("condition not reached in 3 s");
}

async fn quiet() {
    tokio::time::sleep(Duration::from_millis(100)).await;
}

struct Client {
    seen: Seen,
    writer: OwnedWriteHalf,
    reader: JoinHandle<()>,
}

impl Client {
    fn start(stream: UnixStream, keep_hello: bool) -> Self {
        let (mut read, writer) = stream.into_split();
        let seen: Seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let reader = tokio::spawn(async move {
            let mut lines = JsonLines::new(move |message: Value| {
                let hello = message.get("type").and_then(Value::as_str) == Some("hello");
                if keep_hello || !hello {
                    sink.lock().unwrap().push(message);
                }
            });
            let mut buffer = vec![0_u8; 8192];
            loop {
                match read.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => lines.push(&buffer[..n]),
                }
            }
        });
        Self {
            seen,
            writer,
            reader,
        }
    }

    async fn write(&mut self, message: &Value) {
        let mut line = serde_json::to_vec(message).unwrap();
        line.push(b'\n');
        self.writer.write_all(&line).await.unwrap();
    }

    fn closed(&self) -> bool {
        self.reader.is_finished()
    }

    async fn destroy(self) {
        self.reader.abort();
        let _ = self.reader.await;
        drop(self.writer);
    }
}

async fn client(path: &Path) -> Client {
    Client::start(
        connect_host_channel(path, current_uid()).await.unwrap(),
        false,
    )
}

struct Harness {
    _dir: TempDir,
    root: PathBuf,
}

fn harness() -> Harness {
    let dir = TempDir::new().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    Harness { _dir: dir, root }
}

async fn channel(h: &Harness, name: &str) -> (PathBuf, ListeningChannel, Seen) {
    let path = h.root.join(name);
    let received: Seen = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&received);
    let listening = listen_host_channel(&path, move |message, _respond| {
        sink.lock().unwrap().push(message);
    })
    .await
    .unwrap();
    (path, listening, received)
}

fn refused(error: &HostChannelError) -> bool {
    matches!(error, HostChannelError::Refused(_))
}

#[tokio::test]
async fn ksh_c51_holds_a_question_asked_while_no_ostia_is_connected_and_asks_the_next_one_that_connects()
 {
    let h = harness();
    let (path, listening, answers) = channel(&h, "h.sock").await;
    let ask = json!({"type": "ask", "askId": 1, "host": "example.org", "port": 443});
    listening.send(&ask);
    listening.send(&json!({"type": "violations", "lines": ["denied write /x"]}));
    let first = client(&path).await;
    until(|| seen_len(&first.seen) == 2).await;
    assert!(seen_all(&first.seen).contains(&ask));
    first.destroy().await;
    let mut second = client(&path).await;
    until(|| seen_len(&second.seen) == 1).await;
    assert_eq!(seen_all(&second.seen), vec![ask]);
    second
        .write(&json!({"type": "ask-answer", "askId": 1, "allow": true}))
        .await;
    until(|| seen_len(&answers) == 1).await;
    second.destroy().await;
    let third = client(&path).await;
    quiet().await;
    assert_eq!(seen_all(&third.seen), Vec::<Value>::new());
    third.destroy().await;
    listening.close();
}

#[tokio::test]
async fn ksh_c53_refuses_a_channel_path_that_is_a_symlink_a_plain_file_or_missing() {
    let h = harness();
    let (path, listening, _) = channel(&h, "h.sock").await;
    let link = h.root.join("link.sock");
    symlink(&path, &link).unwrap();
    let file = h.root.join("file.sock");
    fs::write(&file, "").unwrap();
    let uid = current_uid();
    for (label, target, who) in [
        ("symlink", link, uid),
        ("plain file", file, uid),
        ("missing", h.root.join("missing.sock"), uid),
        ("other uid", path.clone(), uid + 1),
    ] {
        let error = connect_host_channel(&target, who).await.unwrap_err();
        assert!(refused(&error), "{label}: {error}");
    }
    listening.close();
}

#[tokio::test]
async fn names_the_reason_a_channel_path_is_refused() {
    let h = harness();
    let missing = h.root.join("missing.sock");
    let error = connect_host_channel(&missing, 1000).await.unwrap_err();
    assert_eq!(
        error.to_string(),
        format!("no sandbox host is listening at {}", missing.display())
    );
    let file = h.root.join("file.sock");
    fs::write(&file, "").unwrap();
    let error = connect_host_channel(&file, 1000).await.unwrap_err();
    assert_eq!(
        error.to_string(),
        format!(
            "refusing {}: not a socket owned by uid 1000",
            file.display()
        )
    );
}

#[tokio::test]
async fn answers_a_request_only_to_the_ostia_that_asked_it() {
    let h = harness();
    let path = h.root.join("h.sock");
    let responders: Arc<Mutex<Vec<ostia_sandbox::host_channel::Respond>>> =
        Arc::new(Mutex::new(Vec::new()));
    let slot = Arc::clone(&responders);
    let listening = listen_host_channel(&path, move |message, respond| {
        if message.get("id").is_some() {
            slot.lock().unwrap().push(respond);
        }
    })
    .await
    .unwrap();
    let mut first = client(&path).await;
    first.write(&json!({"id": 1, "type": "cleanup"})).await;
    until(|| responders.lock().unwrap().len() == 1).await;
    first.destroy().await;
    let second = client(&path).await;
    let respond = Arc::clone(&responders.lock().unwrap()[0]);
    respond(json!({"id": 1, "ok": true}));
    quiet().await;
    assert_eq!(seen_all(&second.seen), Vec::<Value>::new());
    second.destroy().await;
    listening.close();
}

#[tokio::test]
async fn answers_a_request_on_the_connection_that_sent_it() {
    let h = harness();
    let path = h.root.join("h.sock");
    let listening = listen_host_channel(&path, |message, respond| {
        if let Some(id) = message.get("id") {
            respond(json!({"id": id, "ok": true}));
        }
    })
    .await
    .unwrap();
    let mut only = client(&path).await;
    only.write(&json!({"id": 7, "type": "cleanup"})).await;
    until(|| seen_len(&only.seen) == 1).await;
    assert_eq!(seen_all(&only.seen), vec![json!({"id": 7, "ok": true})]);
    only.destroy().await;
    listening.close();
}

#[tokio::test]
async fn greets_every_ostia_that_connects_with_its_protocol_version_first() {
    let h = harness();
    let (path, listening, _) = channel(&h, "h.sock").await;
    listening.send(&json!({"type": "violations", "lines": ["denied write /x"]}));
    let socket = Client::start(
        connect_host_channel(&path, current_uid()).await.unwrap(),
        true,
    );
    until(|| seen_len(&socket.seen) == 2).await;
    assert_eq!(
        seen_all(&socket.seen)[0],
        json!({"type": "hello", "protocol": HOST_PROTOCOL_VERSION})
    );
    socket.destroy().await;
    listening.close();
}

#[tokio::test]
async fn shows_the_channel_path_only_once_it_listens_private_and_no_longer_than_the_path() {
    let h = harness();
    let path = h.root.join("ready0.sock");
    let staged = staging_path(&path);
    assert_eq!(staged.parent(), path.parent());
    assert_ne!(staged.file_name(), path.file_name());
    assert_eq!(
        staged.as_os_str().as_encoded_bytes().len(),
        path.as_os_str().as_encoded_bytes().len()
    );
    let listening = listen_host_channel(&path, |_, _| {}).await.unwrap();
    assert!(!staged.exists());
    let meta = fs::symlink_metadata(&path).unwrap();
    assert!(meta.file_type().is_socket());
    assert_eq!(meta.permissions().mode() & 0o777, 0o600);
    assert_eq!(meta.uid(), current_uid());
    let names: Vec<_> = fs::read_dir(&h.root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(names, vec![path.file_name().unwrap().to_owned()]);
    client(&path).await.destroy().await;
    listening.close();
}

#[tokio::test]
async fn does_not_take_a_server_that_another_process_already_listens_on() {
    let h = harness();
    let path = h.root.join("busy.sock");
    let other = std::os::unix::net::UnixListener::bind(&path).unwrap();
    assert!(connect_host_channel(&path, current_uid()).await.is_ok());
    drop(other);
}

#[tokio::test]
async fn puts_a_new_connection_in_place_of_the_old_one_and_closes_the_old_one() {
    let h = harness();
    let (path, listening, _) = channel(&h, "h.sock").await;
    let first = client(&path).await;
    let second = client(&path).await;
    until(|| first.closed()).await;
    let note = json!({"type": "violations", "lines": ["now"]});
    listening.send(&note);
    until(|| seen_len(&second.seen) == 1).await;
    assert_eq!(seen_all(&second.seen), vec![note]);
    assert_eq!(seen_len(&first.seen), 0);
    first.destroy().await;
    second.destroy().await;
    listening.close();
}

#[tokio::test]
async fn keeps_the_first_200_notes_for_the_next_ostia_and_drops_the_rest() {
    let h = harness();
    let (path, listening, _) = channel(&h, "h.sock").await;
    for n in 0..205 {
        listening.send(&json!({"type": "violations", "lines": [n]}));
    }
    let late = client(&path).await;
    until(|| seen_len(&late.seen) == 200).await;
    quiet().await;
    let got = seen_all(&late.seen);
    assert_eq!(got.len(), 200);
    assert_eq!(got[0]["lines"][0], 0);
    assert_eq!(got[199]["lines"][0], 199);
    late.destroy().await;
    listening.close();
}

#[tokio::test]
async fn does_not_hold_a_response_for_a_later_connection() {
    let h = harness();
    let (path, listening, _) = channel(&h, "h.sock").await;
    listening.send(&json!({"id": 4, "ok": true}));
    let late = client(&path).await;
    quiet().await;
    assert_eq!(seen_all(&late.seen), Vec::<Value>::new());
    late.destroy().await;
    listening.close();
}

#[tokio::test]
async fn sends_to_the_connected_ostia_at_once_a_note_a_question_and_a_response() {
    let h = harness();
    let (path, listening, _) = channel(&h, "h.sock").await;
    let live = Client::start(
        connect_host_channel(&path, current_uid()).await.unwrap(),
        true,
    );
    until(|| seen_len(&live.seen) == 1).await;
    let sent = [
        json!({"type": "violations", "lines": ["a"]}),
        json!({"type": "ask", "askId": 9, "host": "h", "port": 1}),
        json!({"id": 3, "ok": true}),
    ];
    for message in &sent {
        listening.send(message);
    }
    until(|| seen_len(&live.seen) == 4).await;
    assert_eq!(seen_all(&live.seen)[1..].to_vec(), sent.to_vec());
    live.destroy().await;
    listening.close();
}

#[tokio::test]
async fn stops_asking_a_question_once_it_is_answered() {
    let h = harness();
    let (path, listening, answers) = channel(&h, "h.sock").await;
    listening.send(&json!({"type": "ask", "askId": 1, "host": "a", "port": 1}));
    listening.send(&json!({"type": "ask", "askId": 2, "host": "b", "port": 2}));
    let mut first = client(&path).await;
    until(|| seen_len(&first.seen) == 2).await;
    first
        .write(&json!({"type": "ask-answer", "askId": 1, "allow": false}))
        .await;
    until(|| seen_len(&answers) == 1).await;
    first.destroy().await;
    let second = client(&path).await;
    until(|| seen_len(&second.seen) == 1).await;
    quiet().await;
    assert_eq!(
        seen_all(&second.seen),
        vec![json!({"type": "ask", "askId": 2, "host": "b", "port": 2})]
    );
    second.destroy().await;
    listening.close();
}

#[tokio::test]
async fn passes_each_valid_line_on_and_ignores_a_line_that_is_not_json() {
    let h = harness();
    let (path, listening, received) = channel(&h, "h.sock").await;
    let mut only = client(&path).await;
    only.writer.write_all(b"not json\n").await.unwrap();
    only.write(&json!({"type": "cleanup", "id": 2})).await;
    until(|| seen_len(&received) == 1).await;
    quiet().await;
    assert_eq!(
        seen_all(&received),
        vec![json!({"type": "cleanup", "id": 2})]
    );
    only.destroy().await;
    listening.close();
}

#[tokio::test]
async fn removes_the_channel_file_and_drops_the_connection_when_it_closes() {
    let h = harness();
    let (path, listening, _) = channel(&h, "h.sock").await;
    let only = client(&path).await;
    listening.close();
    until(|| only.closed()).await;
    assert!(!path.exists());
    let error = connect_host_channel(&path, current_uid())
        .await
        .unwrap_err();
    assert!(refused(&error));
    only.destroy().await;
}

#[tokio::test]
async fn replaces_a_stale_staging_file_left_by_a_crash() {
    let h = harness();
    let path = h.root.join("h.sock");
    fs::write(staging_path(&path), "stale").unwrap();
    let listening = listen_host_channel(&path, |_, _| {}).await.unwrap();
    let greeted = Client::start(
        connect_host_channel(&path, current_uid()).await.unwrap(),
        true,
    );
    until(|| seen_len(&greeted.seen) == 1).await;
    assert!(!staging_path(&path).exists());
    greeted.destroy().await;
    listening.close();
}

#[tokio::test]
async fn fails_to_listen_in_a_folder_that_does_not_exist() {
    let h = harness();
    let path = h.root.join("no-such-folder").join("h.sock");
    assert!(listen_host_channel(&path, |_, _| {}).await.is_err());
}

#[tokio::test]
async fn fails_with_the_connect_error_when_the_socket_file_has_no_listener() {
    let h = harness();
    let path = h.root.join("dead.sock");
    drop(std::os::unix::net::UnixListener::bind(&path).unwrap());
    let error = connect_host_channel(&path, current_uid())
        .await
        .unwrap_err();
    assert!(!refused(&error));
}

fn collect(chunks: &[&[u8]]) -> Vec<Value> {
    let seen: Seen = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    let mut lines = JsonLines::new(move |message: Value| sink.lock().unwrap().push(message));
    for chunk in chunks {
        lines.push(chunk);
    }
    seen_all(&seen)
}

#[test]
fn json_lines_reads_one_message_for_each_line_in_one_chunk() {
    assert_eq!(
        collect(&[b"{\"a\":1}\n{\"b\":2}\n"]),
        vec![json!({"a": 1}), json!({"b": 2})]
    );
}

#[test]
fn json_lines_joins_a_line_that_arrives_in_pieces() {
    assert_eq!(
        collect(&[b"{\"a\"", b":1", b"}\n{\"b\":", b"2}\n"]),
        vec![json!({"a": 1}), json!({"b": 2})]
    );
}

#[test]
fn json_lines_joins_a_utf8_character_split_between_two_chunks() {
    let bytes = "{\"a\":\"é😀\"}\n".as_bytes().to_vec();
    let cut = bytes.iter().position(|b| *b == 0xc3).unwrap() + 1;
    assert_eq!(
        collect(&[&bytes[..cut], &bytes[cut..]]),
        vec![json!({"a": "é😀"})]
    );
}

#[test]
fn json_lines_waits_for_the_newline_before_it_reads_a_message() {
    assert_eq!(collect(&[b"{\"a\":1}"]), Vec::<Value>::new());
}

#[test]
fn json_lines_skips_a_line_that_is_not_json_and_reads_the_next() {
    assert_eq!(
        collect(&[b"nope\n\n{\"a\":1}\n{broken\n{\"b\":2}\n"]),
        vec![json!({"a": 1}), json!({"b": 2})]
    );
}

#[test]
fn json_lines_keeps_a_partial_line_up_to_8_mib() {
    let mut first = vec![b'"'];
    first.extend(std::iter::repeat_n(b'a', MESSAGE_MAX_BYTES - 1));
    assert_eq!(first.len(), MESSAGE_MAX_BYTES);
    let got = collect(&[&first, b"\"\n"]);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].as_str().unwrap().len(), MESSAGE_MAX_BYTES - 1);
}

#[test]
fn json_lines_drops_a_partial_line_longer_than_8_mib() {
    let mut first = vec![b'"'];
    first.extend(std::iter::repeat_n(b'a', MESSAGE_MAX_BYTES));
    assert_eq!(first.len(), MESSAGE_MAX_BYTES + 1);
    assert_eq!(
        collect(&[&first, b"\"\n", b"{\"a\":1}\n"]),
        vec![json!({"a": 1})]
    );
}

#[test]
fn builds_the_listen_future_on_a_thread_with_no_runtime_and_binds_nothing_until_polled() {
    let h = harness();
    let path = h.root.join("idle.sock");
    let listening = listen_host_channel(&path, |_, _| {});
    drop(listening);
    assert!(!path.exists());
}

#[tokio::test]
async fn keeps_questions_with_different_non_numeric_ids_apart() {
    let h = harness();
    let (path, listening, answers) = channel(&h, "h.sock").await;
    listening.send(&json!({"type": "ask", "askId": "a", "host": "a", "port": 1}));
    listening.send(&json!({"type": "ask", "askId": "b", "host": "b", "port": 2}));
    let mut first = client(&path).await;
    until(|| seen_len(&first.seen) == 2).await;
    first
        .write(&json!({"type": "ask-answer", "askId": "a", "allow": false}))
        .await;
    until(|| seen_len(&answers) == 1).await;
    first.destroy().await;
    let second = client(&path).await;
    until(|| seen_len(&second.seen) == 1).await;
    quiet().await;
    assert_eq!(
        seen_all(&second.seen),
        vec![json!({"type": "ask", "askId": "b", "host": "b", "port": 2})]
    );
    second.destroy().await;
    listening.close();
}
