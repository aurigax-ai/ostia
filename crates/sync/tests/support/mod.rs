#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ostia_base::host::{Host, Platform};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

pub fn host(env: &[(&str, &str)], platform: Platform) -> Host {
    Host {
        env: env
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect::<BTreeMap<_, _>>(),
        home: PathBuf::from("/home/u"),
        cwd: PathBuf::from("/"),
        platform,
    }
}

pub fn linux_host(env: &[(&str, &str)]) -> Host {
    host(env, Platform::Linux)
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

pub fn write(path: &Path, text: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, text).unwrap();
}

pub fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

pub fn tar_gz(parent: &Path, folder: &str, file: &Path) {
    let status = Command::new("tar")
        .arg("-C")
        .arg(parent)
        .arg("-czf")
        .arg(file)
        .arg(folder)
        .status()
        .unwrap();
    assert!(status.success());
}

pub fn names(dir: &Path) -> Vec<String> {
    let mut found: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    found.sort();
    found
}

pub fn is_root() -> bool {
    ostia_base::process::current_uid() == 0
}

pub async fn eventually(what: &str, mut condition: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while !condition() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {what}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[derive(Clone, Debug)]
pub enum Reply {
    Status(u16),
    Body {
        status: u16,
        body: Vec<u8>,
        location: Option<String>,
    },
    Redirect(String),
    Hang,
}

impl Reply {
    pub fn ok(body: impl Into<Vec<u8>>) -> Self {
        Self::Body {
            status: 200,
            body: body.into(),
            location: None,
        }
    }

    pub fn with_status(status: u16, body: impl Into<Vec<u8>>) -> Self {
        Self::Body {
            status,
            body: body.into(),
            location: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Seen {
    pub path: String,
    pub headers: HashMap<String, String>,
}

type Routes = Arc<Mutex<HashMap<String, Reply>>>;
type Later = Arc<Mutex<Vec<Reply>>>;

pub struct FakeHttp {
    pub url: String,
    seen: Arc<Mutex<Vec<Seen>>>,
    routes: Routes,
    default: Arc<Mutex<Reply>>,
    later: Later,
    tasks: Arc<Mutex<Vec<JoinHandle<()>>>>,
    accept: JoinHandle<()>,
}

impl FakeHttp {
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
        let routes: Routes = Arc::default();
        let later: Later = Arc::default();
        let default = Arc::new(Mutex::new(Reply::Status(404)));
        let tasks: Arc<Mutex<Vec<JoinHandle<()>>>> = Arc::default();
        let accept = tokio::spawn({
            let seen = Arc::clone(&seen);
            let routes = Arc::clone(&routes);
            let later = Arc::clone(&later);
            let default = Arc::clone(&default);
            let tasks = Arc::clone(&tasks);
            async move {
                loop {
                    let Ok((stream, _)) = listener.accept().await else {
                        return;
                    };
                    let handle = tokio::spawn(handle_connection(
                        stream,
                        Arc::clone(&seen),
                        Arc::clone(&routes),
                        Arc::clone(&later),
                        Arc::clone(&default),
                    ));
                    tasks.lock().unwrap().push(handle);
                }
            }
        });
        Self {
            url: format!("http://127.0.0.1:{port}"),
            seen,
            routes,
            default,
            later,
            tasks,
            accept,
        }
    }

    pub fn route(&self, path: &str, reply: Reply) {
        self.routes.lock().unwrap().insert(path.to_owned(), reply);
    }

    pub fn reply_all(&self, reply: Reply) {
        *self.default.lock().unwrap() = reply;
    }

    pub fn queue(&self, replies: Vec<Reply>) {
        let mut replies = replies;
        replies.reverse();
        *self.later.lock().unwrap() = replies;
    }

    pub fn requests(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    pub fn paths(&self) -> Vec<String> {
        self.requests().into_iter().map(|seen| seen.path).collect()
    }

    pub fn clear_requests(&self) {
        self.seen.lock().unwrap().clear();
    }

    pub async fn close(&self) {
        self.accept.abort();
        for task in self.tasks.lock().unwrap().drain(..) {
            task.abort();
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

impl Drop for FakeHttp {
    fn drop(&mut self) {
        self.accept.abort();
        for task in self.tasks.lock().unwrap().drain(..) {
            task.abort();
        }
    }
}

async fn handle_connection(
    mut stream: tokio::net::TcpStream,
    seen: Arc<Mutex<Vec<Seen>>>,
    routes: Routes,
    later: Later,
    default: Arc<Mutex<Reply>>,
) {
    let mut raw = Vec::new();
    let mut chunk = [0u8; 1024];
    while !raw.windows(4).any(|window| window == b"\r\n\r\n") {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(read) => raw.extend_from_slice(&chunk[..read]),
        }
    }
    let text = String::from_utf8_lossy(&raw).into_owned();
    let mut lines = text.split("\r\n");
    let path = lines
        .next()
        .unwrap_or_default()
        .split(' ')
        .nth(1)
        .unwrap_or_default()
        .to_owned();
    let headers = lines
        .filter_map(|line| line.split_once(": "))
        .map(|(name, value)| (name.to_ascii_lowercase(), value.to_owned()))
        .collect();
    seen.lock().unwrap().push(Seen {
        path: path.clone(),
        headers,
    });
    let routed = routes.lock().unwrap().get(&path).cloned();
    let queued = {
        let mut queue = later.lock().unwrap();
        if routed.is_none() { queue.pop() } else { None }
    };
    let reply = routed
        .or(queued)
        .unwrap_or_else(|| default.lock().unwrap().clone());
    let bytes = match reply {
        Reply::Hang => std::future::pending().await,
        Reply::Status(status) => head(status, 0, None),
        Reply::Redirect(location) => head(302, 0, Some(&location)),
        Reply::Body {
            status,
            body,
            location,
        } => {
            let mut bytes = head(status, body.len(), location.as_deref());
            bytes.extend_from_slice(&body);
            bytes
        }
    };
    let _ = stream.write_all(&bytes).await;
    let _ = stream.shutdown().await;
}

fn head(status: u16, length: usize, location: Option<&str>) -> Vec<u8> {
    let location = location
        .map(|value| format!("Location: {value}\r\n"))
        .unwrap_or_default();
    format!(
        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {length}\r\n{location}Connection: close\r\n\r\n"
    )
    .into_bytes()
}
