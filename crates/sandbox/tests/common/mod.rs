#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::future::Future;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use ostia_sandbox::port_bridge::{PortBridge, control_socket_name, data_socket_name};
use parking_lot::Mutex;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, WriteHalf, split};
use tokio::net::{TcpListener, TcpSocket, TcpStream, UnixStream};
use tokio::task::JoinHandle;

pub const POLL_TIMEOUT: Duration = Duration::from_secs(5);
const POLL_INTERVAL: Duration = Duration::from_millis(10);

pub async fn wait_until<F, Fut>(mut probe: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    let deadline = Instant::now() + POLL_TIMEOUT;
    loop {
        if probe().await {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "the condition did not hold in time"
        );
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

pub async fn wait_for(mut probe: impl FnMut() -> bool) {
    wait_until(|| std::future::ready(probe())).await;
}

pub struct Conn<S> {
    writer: WriteHalf<S>,
    text: Arc<Mutex<Vec<u8>>>,
    ended: Arc<AtomicBool>,
    reader: JoinHandle<()>,
}

impl<S> Conn<S>
where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    pub fn new(stream: S) -> Self {
        let (mut read, writer) = split(stream);
        let text = Arc::new(Mutex::new(Vec::new()));
        let ended = Arc::new(AtomicBool::new(false));
        let reader = tokio::spawn({
            let text = text.clone();
            let ended = ended.clone();
            async move {
                let mut chunk = [0u8; 16 * 1024];
                loop {
                    match read.read(&mut chunk).await {
                        Ok(0) | Err(_) => break,
                        Ok(count) => text.lock().extend_from_slice(&chunk[..count]),
                    }
                }
                ended.store(true, Ordering::SeqCst);
            }
        });
        Self {
            writer,
            text,
            ended,
            reader,
        }
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.text.lock()).into_owned()
    }

    pub fn byte_count(&self) -> usize {
        self.text.lock().len()
    }

    pub fn ended(&self) -> bool {
        self.ended.load(Ordering::SeqCst)
    }

    pub async fn write(&mut self, text: &str) {
        let _ = self.writer.write_all(text.as_bytes()).await;
    }

    pub async fn write_bytes(&mut self, bytes: &[u8]) {
        let _ = self.writer.write_all(bytes).await;
    }

    pub async fn finish(&mut self) {
        let _ = self.writer.shutdown().await;
    }

    pub fn destroy(self) {
        self.reader.abort();
    }
}

impl<S> Drop for Conn<S> {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

pub async fn unix_conn(path: &Path) -> Conn<UnixStream> {
    Conn::new(UnixStream::connect(path).await.unwrap())
}

pub async fn tcp_conn(port: u16) -> Conn<TcpStream> {
    Conn::new(TcpStream::connect(("127.0.0.1", port)).await.unwrap())
}

pub async fn host_pair() -> (TcpStream, Conn<TcpStream>) {
    let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = server.local_addr().unwrap();
    let (browser, accepted) = tokio::join!(TcpStream::connect(address), server.accept());
    let (client, _) = accepted.unwrap();
    (client, Conn::new(browser.unwrap()))
}

pub struct HeldPort {
    socket: TcpSocket,
    pub port: u16,
}

impl HeldPort {
    pub fn new() -> Self {
        let socket = TcpSocket::new_v4().unwrap();
        socket.set_reuseaddr(true).unwrap();
        socket.bind(SocketAddr::from(([127, 0, 0, 1], 0))).unwrap();
        let port = socket.local_addr().unwrap().port();
        Self { socket, port }
    }
}

pub fn port_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

pub fn asked_ports(control: &Conn<UnixStream>) -> Vec<u16> {
    control
        .text()
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| line.parse().unwrap())
        .collect()
}

pub async fn open_bridge(dir: &Path) -> PortBridge {
    PortBridge::open(dir, None, None)
        .await
        .unwrap()
        .expect("the bridge did not open")
}

pub async fn supervise(dir: &Path, bridge: &PortBridge) -> Conn<UnixStream> {
    let control = unix_conn(&dir.join(control_socket_name(bridge.id()))).await;
    wait_for(|| bridge.connected()).await;
    control
}

pub type Reply = Arc<dyn Fn(u16) -> Vec<u8> + Send + Sync>;

pub struct FakePane {
    pub pid: u32,
    pub bridge: PortBridge,
    asked: Arc<Mutex<Vec<u16>>>,
    served: JoinHandle<()>,
}

impl FakePane {
    pub async fn start(dir: &Path, pid: u32, reply: Reply) -> Self {
        let bridge = open_bridge(dir).await;
        let mut control = UnixStream::connect(dir.join(control_socket_name(bridge.id())))
            .await
            .unwrap();
        let asked = Arc::new(Mutex::new(Vec::new()));
        let served = tokio::spawn({
            let asked = asked.clone();
            let dir = dir.to_path_buf();
            let id = bridge.id().to_owned();
            async move {
                let mut pending = String::new();
                let mut chunk = [0u8; 1024];
                loop {
                    let Ok(count) = control.read(&mut chunk).await else {
                        return;
                    };
                    if count == 0 {
                        return;
                    }
                    pending.push_str(&String::from_utf8_lossy(&chunk[..count]));
                    while let Some(at) = pending.find('\n') {
                        let line: String = pending.drain(..=at).collect();
                        let Ok(port) = line.trim().parse::<u16>() else {
                            continue;
                        };
                        asked.lock().push(port);
                        let path = dir.join(data_socket_name(&id, port));
                        let body = reply(port);
                        tokio::spawn(async move {
                            let Ok(mut inside) = UnixStream::connect(path).await else {
                                return;
                            };
                            let _ = inside.write_all(&body).await;
                            let _ = inside.shutdown().await;
                        });
                    }
                }
            }
        });
        wait_for(|| bridge.connected()).await;
        Self {
            pid,
            bridge,
            asked,
            served,
        }
    }

    pub fn asked(&self) -> Vec<u16> {
        self.asked.lock().clone()
    }
}

impl Drop for FakePane {
    fn drop(&mut self) {
        self.served.abort();
        self.bridge.close();
    }
}

pub fn named_reply(name: &'static str) -> Reply {
    Arc::new(move |port| format!("{name}:{port}").into_bytes())
}

pub async fn read_to_end(port: u16) -> String {
    let conn = tcp_conn(port).await;
    wait_for(|| conn.ended()).await;
    conn.text()
}
