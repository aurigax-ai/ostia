#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use ostia_agents::mcp_oauth::{McpOAuthRecord, McpOAuthStore};
use ostia_contract::chat_tools::McpServerSettings;
use ostia_testkit::repo_root;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::{Child, ChildStdin, Command};

pub fn node() -> String {
    let path = std::env::var_os("PATH").unwrap();
    std::env::split_paths(&path)
        .map(|dir| dir.join("node"))
        .find(|candidate| candidate.is_file())
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

pub fn fake_server_path() -> PathBuf {
    repo_root().join("test/fixtures/mcp/fake-server.mjs")
}

pub struct MemoryStore {
    records: Mutex<BTreeMap<String, McpOAuthRecord>>,
    encrypts: bool,
    slow_set: Mutex<Option<SlowSet>>,
}

struct SlowSet {
    entered: Arc<AtomicBool>,
    delay: Duration,
}

impl MemoryStore {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            records: Mutex::new(BTreeMap::new()),
            encrypts: true,
            slow_set: Mutex::new(None),
        })
    }

    pub fn without_encryption() -> Arc<Self> {
        Arc::new(Self {
            records: Mutex::new(BTreeMap::new()),
            encrypts: false,
            slow_set: Mutex::new(None),
        })
    }

    pub fn stored(&self) -> Value {
        let mut file = serde_json::Map::new();
        for (server, record) in self.records.lock().iter() {
            file.insert(
                server.clone(),
                json!({
                    "url": record.url,
                    "redirectUrl": record.redirect_url,
                    "client": record.client,
                    "tokens": record.tokens,
                    "expiresAt": record.expires_at,
                }),
            );
        }
        Value::Object(file)
    }

    pub fn slow_sets(&self, entered: Arc<AtomicBool>, delay: Duration) {
        *self.slow_set.lock() = Some(SlowSet { entered, delay });
    }

    pub fn raw(&self, server: &str) -> Option<McpOAuthRecord> {
        self.records.lock().get(server).cloned()
    }
}

impl McpOAuthStore for MemoryStore {
    fn get(&self, server: &str, url: &str) -> Option<McpOAuthRecord> {
        let mut records = self.records.lock();
        let record = records.get(server)?.clone();
        if record.url == url {
            return Some(record);
        }
        records.remove(server);
        None
    }

    fn set(&self, server: &str, record: McpOAuthRecord) -> Result<(), String> {
        if !self.encrypts {
            return Err("encryption-unavailable".to_owned());
        }
        let slow = self
            .slow_set
            .lock()
            .as_ref()
            .map(|slow| (Arc::clone(&slow.entered), slow.delay));
        if let Some((entered, delay)) = slow {
            entered.store(true, Ordering::SeqCst);
            std::thread::sleep(delay);
        }
        self.records.lock().insert(server.to_owned(), record);
        Ok(())
    }

    fn clear(&self, server: &str) {
        self.records.lock().remove(server);
    }

    fn prune(&self, servers: &[McpServerSettings]) {
        self.records.lock().retain(|name, record| {
            servers
                .iter()
                .find(|s| &s.name == name)
                .is_some_and(|s| s.url.as_deref() == Some(record.url.as_str()))
        });
    }

    fn can_store(&self) -> bool {
        self.encrypts
    }
}

pub struct FakeMcpHttp {
    pub url: String,
    pub origin: String,
    child: Child,
    _stdin: ChildStdin,
}

impl FakeMcpHttp {
    pub async fn start(oauth: bool) -> Self {
        Self::start_with(oauth, &[]).await
    }

    pub async fn start_with(oauth: bool, flags: &[&str]) -> Self {
        let mut command = Command::new(node());
        command.arg(fake_server_path()).arg("--http");
        if oauth {
            command.arg("--oauth");
        }
        command.args(flags);
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let line = lines.next_line().await.unwrap().unwrap();
        let url = serde_json::from_str::<Value>(&line).unwrap()["url"]
            .as_str()
            .unwrap()
            .to_owned();
        let parsed = reqwest::Url::parse(&url).unwrap();
        let origin = parsed.origin().ascii_serialization();
        Self {
            url,
            origin,
            child,
            _stdin: stdin,
        }
    }

    pub async fn stats(&self) -> Value {
        let text = reqwest::get(format!("{}/control", self.origin))
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        serde_json::from_str(&text).unwrap()
    }

    pub async fn control(&self, action: &str) -> Value {
        let text = reqwest::Client::new()
            .post(format!("{}/control", self.origin))
            .body(json!({ "action": action }).to_string())
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        serde_json::from_str(&text).unwrap()
    }

    pub async fn assert_stats(&self, expected: &[(&str, u64)]) {
        let stats = self.stats().await;
        for (key, value) in expected {
            assert_eq!(stats[*key], json!(value), "{key} in {stats}");
        }
    }

    pub fn close(&mut self) {
        let _ = self.child.start_kill();
    }
}

pub async fn refuses_connections(url: &str) -> bool {
    let parsed = reqwest::Url::parse(url).unwrap();
    let address = format!(
        "{}:{}",
        parsed.host_str().unwrap(),
        parsed.port_or_known_default().unwrap()
    );
    TcpStream::connect(address).await.is_err()
}

pub async fn status_with_host(port: u16, path: &str, host: &str) -> Option<u16> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.ok()?;
    let request = format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await.ok()?;
    let mut reply = String::new();
    stream.read_to_string(&mut reply).await.ok()?;
    reply.split_whitespace().nth(1)?.parse().ok()
}
