use std::collections::{HashMap, VecDeque};
use std::fmt::Display;
use std::fs;
use std::io::ErrorKind;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use ostia_base::error::io_error;
use ostia_base::random::random_bytes;
use ostia_base::{Platform, Result};
use ostia_contract::shell_quote::quote_arg;
use parking_lot::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt, copy_bidirectional};
use tokio::net::{TcpStream, UnixListener, UnixStream};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

const ACCEPT_RETRY: Duration = Duration::from_millis(100);
const DIAL_TIMEOUT: Duration = Duration::from_millis(5000);

pub fn bridges_ports(platform: Platform, unix_sockets: bool) -> bool {
    platform == Platform::Linux && unix_sockets
}

pub fn control_socket_name(id: &str) -> String {
    format!("ports-{id}.sock")
}

pub fn data_socket_name(id: &str, port: impl Display) -> String {
    format!("ports-{id}-{port}.sock")
}

pub fn port_bridge_command(dir: &Path, id: &str) -> String {
    [
        "(".to_owned(),
        "trap '' INT QUIT TSTP;".to_owned(),
        format!("cd {} || exit;", quote_arg(&dir.to_string_lossy())),
        "exec </dev/null >/dev/null 2>&1;".to_owned(),
        "shell=$$;".to_owned(),
        "while kill -0 \"$shell\" 2>/dev/null; do".to_owned(),
        format!(
            "socat -u UNIX-CONNECT:{} - | while read -r port; do",
            control_socket_name(id)
        ),
        "case \"$port\" in ''|*[!0-9]*) continue;; esac;".to_owned(),
        format!(
            "socat UNIX-CONNECT:{} TCP:127.0.0.1:\"$port\" &",
            data_socket_name(id, "\"$port\"")
        ),
        "done;".to_owned(),
        "sleep 1;".to_owned(),
        "done".to_owned(),
        ") &".to_owned(),
    ]
    .join(" ")
}

struct Waiter {
    id: u64,
    hand_over: oneshot::Sender<UnixStream>,
}

type Waiting = Arc<Mutex<VecDeque<Waiter>>>;

struct Channel {
    waiting: Waiting,
    path: PathBuf,
}

struct Control {
    generation: u64,
    ports: mpsc::UnboundedSender<u16>,
    cancel: CancellationToken,
}

#[derive(Default)]
struct State {
    control: Option<Control>,
    channels: HashMap<u16, Channel>,
}

struct Shared {
    id: String,
    command: String,
    dir: PathBuf,
    dial_timeout: Duration,
    cancel: CancellationToken,
    state: Mutex<State>,
    counter: AtomicU64,
}

#[derive(Clone)]
pub struct PortBridge {
    shared: Arc<Shared>,
}

impl PortBridge {
    pub async fn open(
        dir: &Path,
        dial_timeout: Option<Duration>,
        id: Option<&str>,
    ) -> Result<Option<Self>> {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .map_err(io_error(dir))?;
        let id = id.map_or_else(|| hex::encode(random_bytes::<4>()), str::to_owned);
        let Ok(listener) = UnixListener::bind(dir.join(control_socket_name(&id))) else {
            return Ok(None);
        };
        let shared = Arc::new(Shared {
            command: port_bridge_command(dir, &id),
            id,
            dir: dir.to_path_buf(),
            dial_timeout: dial_timeout.unwrap_or(DIAL_TIMEOUT),
            cancel: CancellationToken::new(),
            state: Mutex::default(),
            counter: AtomicU64::new(0),
        });
        tokio::spawn(accept_control(shared.clone(), listener));
        Ok(Some(Self { shared }))
    }

    pub fn id(&self) -> &str {
        &self.shared.id
    }

    pub fn command(&self) -> &str {
        &self.shared.command
    }

    pub fn connected(&self) -> bool {
        self.shared.state.lock().control.is_some()
    }

    pub async fn dial(&self, port: u16, client: TcpStream) {
        self.dial_until(port, client, &CancellationToken::new())
            .await;
    }

    pub async fn dial_until(&self, port: u16, client: TcpStream, cancel: &CancellationToken) {
        let shared = &self.shared;
        let (waiting, ports) = {
            let mut state = shared.state.lock();
            let Some(waiting) = channel(shared, &mut state, port) else {
                return;
            };
            let Some(control) = &state.control else {
                return;
            };
            (waiting, control.ports.clone())
        };
        let id = shared.counter.fetch_add(1, Ordering::Relaxed);
        let (hand_over, handed) = oneshot::channel();
        waiting.lock().push_back(Waiter { id, hand_over });
        tokio::spawn(serve_client(
            client,
            handed,
            waiting,
            id,
            shared.dial_timeout,
            shared.cancel.child_token(),
            cancel.clone(),
        ));
        let _ = ports.send(port);
    }

    pub fn close(&self) {
        let (control, channels) = {
            let mut state = self.shared.state.lock();
            if self.shared.cancel.is_cancelled() {
                return;
            }
            self.shared.cancel.cancel();
            (state.control.take(), std::mem::take(&mut state.channels))
        };
        if let Some(control) = control {
            control.cancel.cancel();
        }
        let _ = fs::remove_file(self.shared.dir.join(control_socket_name(&self.shared.id)));
        for channel in channels.values() {
            let _ = fs::remove_file(&channel.path);
        }
    }
}

async fn accept_control(shared: Arc<Shared>, listener: UnixListener) {
    loop {
        let stream = tokio::select! {
            () = shared.cancel.cancelled() => return,
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => stream,
                Err(_) => {
                    tokio::time::sleep(ACCEPT_RETRY).await;
                    continue;
                }
            },
        };
        let (ports, requests) = mpsc::unbounded_channel();
        let generation = shared.counter.fetch_add(1, Ordering::Relaxed);
        let cancel = shared.cancel.child_token();
        {
            let mut state = shared.state.lock();
            if state.control.is_some() || shared.cancel.is_cancelled() {
                continue;
            }
            state.control = Some(Control {
                generation,
                ports,
                cancel: cancel.clone(),
            });
        }
        tokio::spawn(run_control(
            shared.clone(),
            stream,
            requests,
            generation,
            cancel,
        ));
    }
}

async fn run_control(
    shared: Arc<Shared>,
    stream: UnixStream,
    mut requests: mpsc::UnboundedReceiver<u16>,
    generation: u64,
    cancel: CancellationToken,
) {
    let (mut reader, mut writer) = stream.into_split();
    let mut sink = [0u8; 1024];
    loop {
        tokio::select! {
            () = cancel.cancelled() => break,
            read = reader.read(&mut sink) => match read {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            },
            request = requests.recv() => {
                let Some(port) = request else { break };
                if writer.write_all(format!("{port}\n").as_bytes()).await.is_err() {
                    break;
                }
            }
        }
    }
    let mut state = shared.state.lock();
    if state
        .control
        .as_ref()
        .is_some_and(|control| control.generation == generation)
    {
        state.control = None;
    }
}

fn channel(shared: &Arc<Shared>, state: &mut State, port: u16) -> Option<Waiting> {
    if let Some(existing) = state.channels.get(&port) {
        return Some(existing.waiting.clone());
    }
    if shared.cancel.is_cancelled() {
        return None;
    }
    let path = shared.dir.join(data_socket_name(&shared.id, port));
    match fs::remove_file(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(_) => return None,
    }
    let listener = UnixListener::bind(&path).ok()?;
    let waiting: Waiting = Arc::default();
    state.channels.insert(
        port,
        Channel {
            waiting: waiting.clone(),
            path,
        },
    );
    tokio::spawn(accept_data(
        shared.cancel.child_token(),
        listener,
        waiting.clone(),
    ));
    Some(waiting)
}

async fn accept_data(cancel: CancellationToken, listener: UnixListener, waiting: Waiting) {
    loop {
        let peer = tokio::select! {
            () = cancel.cancelled() => return,
            accepted = listener.accept() => match accepted {
                Ok((peer, _)) => peer,
                Err(_) => {
                    tokio::time::sleep(ACCEPT_RETRY).await;
                    continue;
                }
            },
        };
        let mut peer = Some(peer);
        while let Some(next) = peer.take() {
            let Some(waiter) = waiting.lock().pop_front() else {
                break;
            };
            peer = waiter.hand_over.send(next).err();
        }
    }
}

async fn client_closed(client: &TcpStream) {
    let mut probe = [0u8; 1];
    match client.peek(&mut probe).await {
        Ok(count) if count > 0 => std::future::pending::<()>().await,
        _ => {}
    }
}

async fn serve_client(
    mut client: TcpStream,
    handed: oneshot::Receiver<UnixStream>,
    waiting: Waiting,
    id: u64,
    dial_timeout: Duration,
    bridge_cancel: CancellationToken,
    dial_cancel: CancellationToken,
) {
    let mut peer = tokio::select! {
        () = bridge_cancel.cancelled() => return,
        () = dial_cancel.cancelled() => return,
        () = tokio::time::sleep(dial_timeout) => None,
        () = client_closed(&client) => None,
        handed = handed => handed.ok(),
    };
    let Some(peer) = peer.as_mut() else {
        waiting.lock().retain(|waiter| waiter.id != id);
        return;
    };
    tokio::select! {
        () = bridge_cancel.cancelled() => {}
        () = dial_cancel.cancelled() => {}
        _ = copy_bidirectional(&mut client, peer) => {}
    }
}
