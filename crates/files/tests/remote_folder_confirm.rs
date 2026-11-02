#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use futures_util::future::BoxFuture;
use ostia_files::remote_folder_confirm::{ConfirmWindow, confirm_remote_folder};
use ostia_files::remote_folders::RemoteFolderConfirm;
use parking_lot::Mutex;
use serde_json::{Value, json};

struct FakeWindow {
    destroyed: bool,
    minimized: bool,
    answer: Value,
    log: Arc<Mutex<Vec<String>>>,
}

impl FakeWindow {
    fn new(answer: Value) -> Self {
        Self {
            destroyed: false,
            minimized: false,
            answer,
            log: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn calls(&self) -> Vec<String> {
        self.log.lock().clone()
    }
}

impl ConfirmWindow for FakeWindow {
    fn is_destroyed(&self) -> bool {
        self.destroyed
    }

    fn is_minimized(&self) -> bool {
        self.minimized
    }

    fn restore(&self) {
        self.log.lock().push("restore".to_owned());
    }

    fn focus(&self) {
        self.log.lock().push("focus".to_owned());
    }

    fn ask(&self, ask: RemoteFolderConfirm) -> BoxFuture<'static, Value> {
        self.log.lock().push(format!("ask {}", ask.path));
        let answer = self.answer.clone();
        Box::pin(async move { answer })
    }
}

fn ask() -> RemoteFolderConfirm {
    RemoteFolderConfirm {
        ext_id: "ext".to_owned(),
        workspace_id: "w1".to_owned(),
        ext_name: "Ext".to_owned(),
        host: "box".to_owned(),
        path: "/srv".to_owned(),
    }
}

#[tokio::test]
async fn refuses_when_there_is_no_window() {
    assert!(!confirm_remote_folder(None::<&FakeWindow>, ask()).await);
}

#[tokio::test]
async fn refuses_without_asking_when_the_window_is_destroyed() {
    let mut win = FakeWindow::new(json!(true));
    win.destroyed = true;
    assert!(!confirm_remote_folder(Some(&win), ask()).await);
    assert!(win.calls().is_empty());
}

#[tokio::test]
async fn focuses_the_window_and_asks_when_it_is_not_minimized() {
    let win = FakeWindow::new(json!(true));
    assert!(confirm_remote_folder(Some(&win), ask()).await);
    assert_eq!(win.calls(), ["focus", "ask /srv"]);
}

#[tokio::test]
async fn restores_a_minimized_window_before_it_focuses_and_asks() {
    let mut win = FakeWindow::new(json!(true));
    win.minimized = true;
    assert!(confirm_remote_folder(Some(&win), ask()).await);
    assert_eq!(win.calls(), ["restore", "focus", "ask /srv"]);
}

#[tokio::test]
async fn approves_only_when_the_answer_is_exactly_true() {
    for (answer, expected) in [
        (json!(true), true),
        (json!(false), false),
        (Value::Null, false),
        (json!("true"), false),
        (json!(1), false),
        (json!({"approved": true}), false),
    ] {
        let win = FakeWindow::new(answer.clone());
        assert_eq!(
            confirm_remote_folder(Some(&win), ask()).await,
            expected,
            "{answer}"
        );
    }
}
