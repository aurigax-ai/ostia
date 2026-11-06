#![allow(dead_code)]

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use ostia_gateway::server_client::{ServerClient, ServerClientDeps};
use parking_lot::Mutex;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Clone, Debug)]
pub struct Recorded {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Recorded {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    pub fn text(&self) -> String {
        String::from_utf8(self.body.clone()).unwrap()
    }

    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap()
    }
}

#[derive(Clone, Debug)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub hang: bool,
}

impl Reply {
    pub fn empty(status: u16) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: Vec::new(),
            hang: false,
        }
    }

    pub fn json(status: u16, body: &Value) -> Self {
        Self {
            body: serde_json::to_vec(body).unwrap(),
            ..Self::empty(status)
        }
    }

    pub fn raw(status: u16, body: &[u8]) -> Self {
        Self {
            body: body.to_vec(),
            ..Self::empty(status)
        }
    }

    pub fn hanging() -> Self {
        Self {
            hang: true,
            ..Self::empty(200)
        }
    }

    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_owned(), value.to_owned()));
        self
    }
}

pub struct MockServer {
    pub origin: String,
    seen: Arc<Mutex<Vec<Recorded>>>,
}

impl MockServer {
    pub async fn start(replies: Vec<Reply>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let replies = Arc::new(replies);
        let accepted = seen.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let seen = accepted.clone();
                let replies = replies.clone();
                tokio::spawn(async move {
                    serve_one(stream, seen, replies).await;
                });
            }
        });
        Self { origin, seen }
    }

    pub fn requests(&self) -> Vec<Recorded> {
        self.seen.lock().clone()
    }

    pub fn only_request(&self) -> Recorded {
        let seen = self.requests();
        assert_eq!(seen.len(), 1, "expected exactly one request: {seen:?}");
        seen[0].clone()
    }
}

pub async fn dead_origin() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    origin
}

async fn serve_one(
    mut stream: TcpStream,
    seen: Arc<Mutex<Vec<Recorded>>>,
    replies: Arc<Vec<Reply>>,
) {
    let Some(request) = read_request(&mut stream).await else {
        return;
    };
    let index = {
        let mut seen = seen.lock();
        seen.push(request);
        seen.len() - 1
    };
    let reply = replies[index.min(replies.len() - 1)].clone();
    if reply.hang {
        std::future::pending::<()>().await;
    }
    let mut head = format!("HTTP/1.1 {} Reply\r\n", reply.status);
    for (name, value) in &reply.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str(&format!(
        "content-length: {}\r\nconnection: close\r\n\r\n",
        reply.body.len()
    ));
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(&reply.body).await;
    let _ = stream.shutdown().await;
}

async fn read_request(stream: &mut TcpStream) -> Option<Recorded> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break position;
        }
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    };
    let head = String::from_utf8_lossy(&buffer[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next()?.split(' ');
    let method = request_line.next()?.to_owned();
    let path = request_line.next()?.to_owned();
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    let length: usize = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse().ok())
        .unwrap_or(0);
    let mut body = buffer[head_end + 4..].to_vec();
    while body.len() < length {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(length);
    Some(Recorded {
        method,
        path,
        headers,
        body,
    })
}

pub struct Harness {
    pub client: ServerClient,
    pub pauses: Arc<Mutex<Vec<Duration>>>,
    pub times: Arc<Mutex<Vec<i64>>>,
}

pub fn harness(origin: &str) -> Harness {
    harness_with_timeout(origin, Duration::from_secs(15))
}

pub fn harness_with_timeout(origin: &str, timeout: Duration) -> Harness {
    let pauses = Arc::new(Mutex::new(Vec::new()));
    let times = Arc::new(Mutex::new(Vec::new()));
    let origin = origin.to_owned();
    let recorded_pauses = pauses.clone();
    let recorded_times = times.clone();
    let client = ServerClient::new(ServerClientDeps {
        base_url: Arc::new(move || Some(origin.clone())),
        timeout,
        pause: Arc::new(
            move |wait: Duration| -> Pin<Box<dyn Future<Output = ()> + Send>> {
                recorded_pauses.lock().push(wait);
                Box::pin(std::future::ready(()))
            },
        ),
        on_server_time: Some(Arc::new(move |served: i64| {
            recorded_times.lock().push(served)
        })),
    });
    Harness {
        client,
        pauses,
        times,
    }
}

pub fn no_server_client() -> ServerClient {
    ServerClient::new(ServerClientDeps {
        base_url: Arc::new(|| None),
        timeout: Duration::from_secs(15),
        pause: Arc::new(|_: Duration| -> Pin<Box<dyn Future<Output = ()> + Send>> {
            Box::pin(std::future::ready(()))
        }),
        on_server_time: None,
    })
}

pub fn headers_of(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
        .collect()
}
