use std::fs::{self, Permissions};
use std::future::{Ready, ready};
use std::io::ErrorKind;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::protocol::HOST_PROTOCOL_VERSION;

const NEWLINE: u8 = 0x0a;
const QUEUE_MAX: usize = 200;
const MESSAGE_MAX_BYTES: usize = 8 * 1024 * 1024;
const READ_CHUNK_BYTES: usize = 64 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum HostChannelError {
    #[error("{0}")]
    Refused(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

type MessageHandler = Box<dyn FnMut(Value) + Send>;

pub struct JsonLines {
    pending: Vec<u8>,
    on_message: MessageHandler,
}

impl JsonLines {
    pub fn new(on_message: impl FnMut(Value) + Send + 'static) -> Self {
        Self {
            pending: Vec::new(),
            on_message: Box::new(on_message),
        }
    }

    pub fn push(&mut self, chunk: &[u8]) {
        let mut scan = self.pending.len();
        self.pending.extend_from_slice(chunk);
        let mut start = 0;
        while let Some(offset) = self.pending[scan..]
            .iter()
            .position(|byte| *byte == NEWLINE)
        {
            let end = scan + offset;
            let line = String::from_utf8_lossy(&self.pending[start..end]);
            if let Ok(message) = serde_json::from_str::<Value>(&line) {
                (self.on_message)(message);
            }
            start = end + 1;
            scan = start;
        }
        self.pending.drain(..start);
        if self.pending.len() > MESSAGE_MAX_BYTES {
            self.pending = Vec::new();
        }
    }
}

pub type Respond = Arc<dyn Fn(Value) + Send + Sync>;

type MessageCallback = dyn Fn(Value, Respond) + Send + Sync;

type AskKey = Option<u64>;

fn write_line(outbox: &UnboundedSender<Vec<u8>>, message: &Value) {
    let mut line = message.to_string().into_bytes();
    line.push(NEWLINE);
    let _ = outbox.send(line);
}

fn check_host_channel(path: &Path, uid: u32) -> Result<(), HostChannelError> {
    let meta = fs::symlink_metadata(path).map_err(|_| {
        HostChannelError::Refused(format!(
            "no sandbox host is listening at {}",
            path.display()
        ))
    })?;
    if !meta.file_type().is_socket() || meta.uid() != uid {
        return Err(HostChannelError::Refused(format!(
            "refusing {}: not a socket owned by uid {uid}",
            path.display()
        )));
    }
    Ok(())
}

pub async fn connect_host_channel(path: &Path, uid: u32) -> Result<UnixStream, HostChannelError> {
    check_host_channel(path, uid)?;
    Ok(UnixStream::connect(path).await?)
}

pub fn staging_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let rest: String = name.chars().skip(1).collect();
    let folder = match path.parent() {
        Some(parent) if parent.as_os_str().is_empty() => Path::new("."),
        Some(parent) => parent,
        None => path,
    };
    folder.join(format!(".{rest}"))
}

fn ask_key(message: &Value) -> AskKey {
    let id = message.get("askId")?.as_f64()?;
    let same_value_zero = if id == 0.0 { 0.0 } else { id };
    Some(same_value_zero.to_bits())
}

fn is_ask(message: &Value) -> bool {
    message.get("type").and_then(Value::as_str) == Some("ask")
}

struct Connection {
    id: u64,
    outbox: UnboundedSender<Vec<u8>>,
    kill: CancellationToken,
}

#[derive(Default)]
struct State {
    current: Option<Connection>,
    queue: Vec<Value>,
    asks: Vec<(AskKey, Value)>,
    next_id: u64,
}

impl State {
    fn remember_ask(&mut self, message: &Value) {
        let key = ask_key(message);
        match self.asks.iter_mut().find(|(known, _)| *known == key) {
            Some(slot) => slot.1 = message.clone(),
            None => self.asks.push((key, message.clone())),
        }
    }

    fn forget_ask(&mut self, key: AskKey) {
        self.asks.retain(|(known, _)| *known != key);
    }
}

pub struct ListeningChannel {
    state: Arc<Mutex<State>>,
    accept: JoinHandle<()>,
    path: PathBuf,
}

impl ListeningChannel {
    pub fn send(&self, message: &Value) {
        let ask = is_ask(message);
        let mut state = self.state.lock();
        if ask {
            state.remember_ask(message);
        }
        if let Some(current) = &state.current {
            write_line(&current.outbox, message);
        } else if !ask && message.get("id").is_none() && state.queue.len() < QUEUE_MAX {
            state.queue.push(message.clone());
        }
    }

    pub fn close(&self) {
        let current = self.state.lock().current.take();
        if let Some(current) = current {
            current.kill.cancel();
        }
        self.accept.abort();
        if let Err(error) = fs::remove_file(&self.path)
            && error.kind() != ErrorKind::NotFound
        {
            tracing::error!(%error, path = %self.path.display(), "cannot remove the sandbox host channel");
        }
    }
}

fn deliver(state: &Mutex<State>, on_message: &MessageCallback, respond: &Respond, message: Value) {
    if message.is_null() {
        return;
    }
    if message.get("type").and_then(Value::as_str) == Some("ask-answer") {
        state.lock().forget_ask(ask_key(&message));
    }
    on_message(message, Arc::clone(respond));
}

async fn read_loop(mut reader: OwnedReadHalf, mut lines: JsonLines, kill: CancellationToken) {
    let mut buffer = vec![0_u8; READ_CHUNK_BYTES];
    loop {
        tokio::select! {
            () = kill.cancelled() => break,
            read = reader.read(&mut buffer) => match read {
                Ok(0) | Err(_) => break,
                Ok(count) => lines.push(&buffer[..count]),
            },
        }
    }
    kill.cancel();
}

async fn write_loop(
    mut writer: OwnedWriteHalf,
    mut inbox: UnboundedReceiver<Vec<u8>>,
    kill: CancellationToken,
) {
    loop {
        let bytes = tokio::select! {
            () = kill.cancelled() => break,
            next = inbox.recv() => match next {
                Some(bytes) => bytes,
                None => break,
            },
        };
        tokio::select! {
            () = kill.cancelled() => break,
            written = writer.write_all(&bytes) => {
                if written.is_err() {
                    break;
                }
            }
        }
    }
    kill.cancel();
}

async fn serve(
    stream: UnixStream,
    inbox: UnboundedReceiver<Vec<u8>>,
    outbox: UnboundedSender<Vec<u8>>,
    kill: CancellationToken,
    id: u64,
    state: Arc<Mutex<State>>,
    on_message: Arc<MessageCallback>,
) {
    let (reader, writer) = stream.into_split();
    let respond: Respond = Arc::new(move |response: Value| write_line(&outbox, &response));
    let lines = JsonLines::new({
        let state = Arc::clone(&state);
        move |message| deliver(&state, &*on_message, &respond, message)
    });
    tokio::join!(
        read_loop(reader, lines, kill.clone()),
        write_loop(writer, inbox, kill)
    );
    let mut state = state.lock();
    if state
        .current
        .as_ref()
        .is_some_and(|current| current.id == id)
    {
        state.current = None;
    }
}

fn attach(state: &Arc<Mutex<State>>, on_message: &Arc<MessageCallback>, stream: UnixStream) {
    let (outbox, inbox) = unbounded_channel();
    let kill = CancellationToken::new();
    let id = {
        let mut guard = state.lock();
        if let Some(old) = guard.current.take() {
            old.kill.cancel();
        }
        guard.next_id += 1;
        let id = guard.next_id;
        write_line(
            &outbox,
            &json!({"type": "hello", "protocol": HOST_PROTOCOL_VERSION}),
        );
        for message in guard.queue.drain(..) {
            write_line(&outbox, &message);
        }
        for (_, ask) in &guard.asks {
            write_line(&outbox, ask);
        }
        guard.current = Some(Connection {
            id,
            outbox: outbox.clone(),
            kill: kill.clone(),
        });
        id
    };
    tokio::spawn(serve(
        stream,
        inbox,
        outbox,
        kill,
        id,
        Arc::clone(state),
        Arc::clone(on_message),
    ));
}

fn accept_loop(
    listener: UnixListener,
    state: Arc<Mutex<State>>,
    on_message: Arc<MessageCallback>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => attach(&state, &on_message, stream),
                Err(error) => {
                    tracing::error!(%error, "the sandbox host channel stopped accepting");
                    break;
                }
            }
        }
    })
}

fn listen(
    path: &Path,
    on_message: Arc<MessageCallback>,
) -> Result<ListeningChannel, HostChannelError> {
    let staging = staging_path(path);
    match fs::remove_file(&staging) {
        Err(error) if error.kind() != ErrorKind::NotFound => return Err(error.into()),
        _ => {}
    }
    let listener = UnixListener::bind(&staging)?;
    fs::set_permissions(&staging, Permissions::from_mode(0o600))?;
    fs::rename(&staging, path)?;
    let state = Arc::new(Mutex::new(State::default()));
    let accept = accept_loop(listener, Arc::clone(&state), on_message);
    Ok(ListeningChannel {
        state,
        accept,
        path: path.to_path_buf(),
    })
}

pub fn listen_host_channel(
    path: &Path,
    on_message: impl Fn(Value, Respond) + Send + Sync + 'static,
) -> Ready<Result<ListeningChannel, HostChannelError>> {
    ready(listen(path, Arc::new(on_message)))
}
