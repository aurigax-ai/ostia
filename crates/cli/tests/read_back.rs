#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use ostia_cli::common::read_back::{
    OpenedFile, confirm_files_open, confirm_pane_open, confirm_workspace,
};
use ostia_rpc::{
    CONTROL_MESSAGE_MAX, Client, ClientError, FrameCodec, Incoming, classify, encode_frame,
    parse_body, success_body,
};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::io::AsyncWriteExt;
use tokio::net::{UnixListener, UnixStream};
use tokio_util::codec::FramedRead;

type Rows = Arc<Mutex<Vec<Value>>>;

struct FakeApp {
    socket: PathBuf,
    panes: Rows,
    workspaces: Rows,
    _dir: TempDir,
}

async fn answer(stream: UnixStream, panes: Rows, workspaces: Rows) {
    let (read, mut write) = stream.into_split();
    let mut frames = FramedRead::new(read, FrameCodec::new(CONTROL_MESSAGE_MAX));
    while let Some(Ok(body)) = frames.next().await {
        let Ok(message) = parse_body(&body) else {
            break;
        };
        let Incoming::Request { id, method, .. } = classify(message) else {
            continue;
        };
        let rows = match method.as_str() {
            "pane.list" => panes.lock().unwrap().clone(),
            "workspace.list" => workspaces.lock().unwrap().clone(),
            _ => Vec::new(),
        };
        let reply = encode_frame(&success_body(&id, Value::Array(rows)));
        if write.write_all(&reply).await.is_err() {
            break;
        }
    }
}

impl FakeApp {
    fn start() -> Self {
        let dir = TempDir::new().unwrap();
        let socket = dir.path().join("app.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let panes = Rows::default();
        let workspaces = Rows::default();
        let (served_panes, served_workspaces) = (panes.clone(), workspaces.clone());
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(answer(
                    stream,
                    served_panes.clone(),
                    served_workspaces.clone(),
                ));
            }
        });
        Self {
            socket,
            panes,
            workspaces,
            _dir: dir,
        }
    }

    async fn client(&self) -> Client {
        Client::connect(&self.socket).await.unwrap()
    }

    fn show_pane(&self, row: Value) {
        self.panes.lock().unwrap().push(row);
    }

    fn show_workspace(&self, id: &str) {
        self.workspaces
            .lock()
            .unwrap()
            .push(json!({"workspaceId": id}));
    }
}

fn opened(path: &str, pane_id: &str) -> OpenedFile {
    OpenedFile {
        path: path.to_owned(),
        pane_id: pane_id.to_owned(),
    }
}

async fn closed_client() -> (TempDir, Client) {
    let dir = TempDir::new().unwrap();
    let socket = dir.path().join("closed.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            drop(stream);
        }
    });
    let client = Client::connect(&socket).await.unwrap();
    (dir, client)
}

#[tokio::test]
async fn confirms_every_file_with_the_pane_that_shows_it() {
    let app = FakeApp::start();
    app.show_pane(json!({"paneId": "p1", "filePath": "/w/a.md"}));
    app.show_pane(json!({"paneId": "p2"}));
    app.show_pane(json!({"paneId": "p3", "filePath": "/w/b.md"}));
    let client = app.client().await;
    let settled = confirm_files_open(&client, &["/w/b.md", "/w/a.md"])
        .await
        .unwrap();
    assert_eq!(
        settled,
        Ok(vec![opened("/w/b.md", "p3"), opened("/w/a.md", "p1")])
    );
}

#[tokio::test]
async fn takes_the_first_pane_when_two_show_the_same_file() {
    let app = FakeApp::start();
    app.show_pane(json!({"paneId": "p1", "filePath": "/w/a.md"}));
    app.show_pane(json!({"paneId": "p2", "filePath": "/w/a.md"}));
    let client = app.client().await;
    assert_eq!(
        confirm_files_open(&client, &["/w/a.md"]).await.unwrap(),
        Ok(vec![opened("/w/a.md", "p1")])
    );
}

#[tokio::test]
async fn confirms_no_files_at_once() {
    let app = FakeApp::start();
    let client = app.client().await;
    let started = Instant::now();
    assert_eq!(confirm_files_open(&client, &[]).await.unwrap(), Ok(vec![]));
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[tokio::test]
async fn waits_for_a_file_that_gets_its_tab_after_the_first_look() {
    let app = FakeApp::start();
    app.show_pane(json!({"paneId": "p1", "filePath": "/w/a.md"}));
    let late = app.panes.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        late.lock()
            .unwrap()
            .push(json!({"paneId": "p2", "filePath": "/w/b.md"}));
    });
    let client = app.client().await;
    let started = Instant::now();
    let settled = confirm_files_open(&client, &["/w/a.md", "/w/b.md"])
        .await
        .unwrap();
    assert_eq!(
        settled,
        Ok(vec![opened("/w/a.md", "p1"), opened("/w/b.md", "p2")])
    );
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[tokio::test]
async fn names_the_file_that_has_no_tab_after_three_seconds() {
    let app = FakeApp::start();
    app.show_pane(json!({"paneId": "p1", "filePath": "/w/a.md"}));
    let client = app.client().await;
    let started = Instant::now();
    let settled = confirm_files_open(&client, &["/w/a.md", "/w/missing.md", "/w/other.md"])
        .await
        .unwrap();
    assert_eq!(
        settled,
        Err("ostia open: /w/missing.md has no tab after opening it".to_owned())
    );
    assert!(started.elapsed() >= Duration::from_millis(2900));
}

#[tokio::test]
async fn passes_a_connection_failure_on_instead_of_waiting_for_the_timeout() {
    let (_dir, client) = closed_client().await;
    let started = Instant::now();
    let outcome = confirm_files_open(&client, &["/w/a.md"]).await;
    assert!(matches!(outcome, Err(ClientError::Closed)));
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(matches!(
        confirm_pane_open(&client, "p1", "a viewer").await,
        Err(ClientError::Closed)
    ));
    assert!(matches!(
        confirm_workspace(&client, "w1").await,
        Err(ClientError::Closed)
    ));
}

#[tokio::test]
async fn confirms_a_pane_that_is_in_the_list() {
    let app = FakeApp::start();
    app.show_pane(json!({"paneId": "p1"}));
    app.show_pane(json!({"paneId": "p2"}));
    let client = app.client().await;
    assert_eq!(
        confirm_pane_open(&client, "p2", "the browser")
            .await
            .unwrap(),
        Ok("p2".to_owned())
    );
}

#[tokio::test]
async fn waits_for_a_pane_that_appears_after_the_first_look() {
    let app = FakeApp::start();
    let late = app.panes.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        late.lock().unwrap().push(json!({"paneId": "p9"}));
    });
    let client = app.client().await;
    assert_eq!(
        confirm_pane_open(&client, "p9", "the browser")
            .await
            .unwrap(),
        Ok("p9".to_owned())
    );
}

#[tokio::test]
async fn names_what_was_opened_when_its_pane_never_shows_up() {
    let app = FakeApp::start();
    app.show_pane(json!({"paneId": "p1"}));
    let client = app.client().await;
    let started = Instant::now();
    assert_eq!(
        confirm_pane_open(&client, "p2", "the browser")
            .await
            .unwrap(),
        Err("ostia open: the browser has no pane after opening it".to_owned())
    );
    assert!(started.elapsed() >= Duration::from_millis(2900));
}

#[tokio::test]
async fn confirms_a_workspace_that_is_in_the_list() {
    let app = FakeApp::start();
    app.show_workspace("w1");
    app.show_workspace("w2");
    let client = app.client().await;
    assert_eq!(
        confirm_workspace(&client, "w2").await.unwrap(),
        Ok("w2".to_owned())
    );
}

#[tokio::test]
async fn waits_for_a_workspace_that_appears_after_the_first_look() {
    let app = FakeApp::start();
    let late = app.workspaces.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        late.lock().unwrap().push(json!({"workspaceId": "w3"}));
    });
    let client = app.client().await;
    assert_eq!(
        confirm_workspace(&client, "w3").await.unwrap(),
        Ok("w3".to_owned())
    );
}

#[tokio::test]
async fn names_the_workspace_that_is_not_in_the_list_after_three_seconds() {
    let app = FakeApp::start();
    app.show_workspace("w1");
    let client = app.client().await;
    let started = Instant::now();
    assert_eq!(
        confirm_workspace(&client, "w2").await.unwrap(),
        Err("ostia workspace new: workspace w2 is not in the workspace list".to_owned())
    );
    assert!(started.elapsed() >= Duration::from_millis(2900));
}
