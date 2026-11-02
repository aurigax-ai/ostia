#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use futures_util::FutureExt;
use ostia_contract::remote_folders::{REMOTE_FOLDER_ID_PATTERN, RemoteFilesRequest, RemoteFolder};
use ostia_files::remote_folders::{
    RemoteExtension, RemoteFolderConfirm, RemoteFolders, RemoteFoldersDeps, RemoteRefusal,
};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::Notify;

fn wire<T: Serialize>(value: T) -> Value {
    serde_json::to_value(value).unwrap()
}

fn ext() -> RemoteExtension {
    RemoteExtension {
        id: "shelf".into(),
        name: "Shelf".into(),
    }
}

struct Setup {
    folders: RemoteFolders,
    owners: Arc<Mutex<BTreeMap<String, String>>>,
    confirms: Arc<Mutex<Vec<RemoteFolderConfirm>>>,
    requests: Arc<Mutex<Vec<RemoteFilesRequest>>>,
    closed: Arc<Mutex<Vec<RemoteFolder>>>,
    published: Arc<AtomicUsize>,
    reply: Arc<Mutex<Result<Value, String>>>,
    gate: Arc<Mutex<Option<Arc<Notify>>>>,
}

impl Setup {
    fn new() -> Self {
        Self::build(true, true)
    }

    fn denying() -> Self {
        Self::build(false, true)
    }

    fn build(approve: bool, seeded_ids: bool) -> Self {
        let owners: Arc<Mutex<BTreeMap<String, String>>> = Arc::new(Mutex::new(
            [
                ("w1", "win1"),
                ("w2", "win2"),
                ("boxed", "win1"),
                ("scratch", "win1"),
            ]
            .into_iter()
            .map(|(w, win)| (w.to_owned(), win.to_owned()))
            .collect(),
        ));
        let confirms: Arc<Mutex<Vec<RemoteFolderConfirm>>> = Arc::default();
        let requests: Arc<Mutex<Vec<RemoteFilesRequest>>> = Arc::default();
        let closed: Arc<Mutex<Vec<RemoteFolder>>> = Arc::default();
        let published = Arc::new(AtomicUsize::new(0));
        let reply: Arc<Mutex<Result<Value, String>>> = Arc::new(Mutex::new(Ok(
            json!({"ok": true, "entries": [{"name": "a.txt", "dir": false}]}),
        )));
        let gate: Arc<Mutex<Option<Arc<Notify>>>> = Arc::default();
        let next = Arc::new(AtomicUsize::new(0));
        let deps = RemoteFoldersDeps {
            window_of_workspace: {
                let owners = owners.clone();
                Arc::new(move |id| owners.lock().get(id).cloned())
            },
            refusal: Arc::new(|id| match id {
                "boxed" => Some(RemoteRefusal::Sandboxed),
                "scratch" => Some(RemoteRefusal::Scratch),
                _ => None,
            }),
            confirm: {
                let confirms = confirms.clone();
                let gate = gate.clone();
                Arc::new(move |req| {
                    confirms.lock().push(req);
                    let waiting = gate.lock().clone();
                    async move {
                        if let Some(gate) = waiting {
                            gate.notified().await;
                        }
                        approve
                    }
                    .boxed()
                })
            },
            request: {
                let requests = requests.clone();
                let reply = reply.clone();
                Arc::new(move |_ext_id, req| {
                    requests.lock().push(req);
                    let answer = reply.lock().clone();
                    async move { answer }.boxed()
                })
            },
            closed: {
                let closed = closed.clone();
                Arc::new(move |folder| closed.lock().push(folder))
            },
            publish: {
                let published = published.clone();
                Arc::new(move || {
                    published.fetch_add(1, Ordering::SeqCst);
                })
            },
            new_id: seeded_ids.then(|| {
                let next = next.clone();
                Arc::new(move || format!("folder{:06}", next.fetch_add(1, Ordering::SeqCst) + 1))
                    as Arc<dyn Fn() -> String + Send + Sync>
            }),
        };
        Self {
            folders: RemoteFolders::new(deps),
            owners,
            confirms,
            requests,
            closed,
            published,
            reply,
            gate,
        }
    }

    fn answer(&self, value: Value) {
        *self.reply.lock() = Ok(value);
    }

    fn answer_error(&self, message: &str) {
        *self.reply.lock() = Err(message.to_owned());
    }

    fn published(&self) -> usize {
        self.published.load(Ordering::SeqCst)
    }

    fn closed_ids(&self) -> Vec<String> {
        self.closed.lock().iter().map(|f| f.id.clone()).collect()
    }

    async fn open(&self, params: Value) -> Value {
        wire(self.folders.open(&ext(), &params).await)
    }

    async fn opened(&self, workspace_id: &str, path: &str) -> String {
        let res = self
            .open(json!({"workspaceId": workspace_id, "host": "dev@db", "path": path}))
            .await;
        assert_eq!(res["ok"], json!(true), "{res}");
        res["folderId"].as_str().unwrap().to_owned()
    }

    fn folder_ids(&self, window: &str) -> Vec<String> {
        self.folders
            .for_window(window)
            .into_iter()
            .map(|f| f.id)
            .collect()
    }
}

fn error_of(res: &Value) -> &str {
    assert_eq!(res["ok"], json!(false), "{res}");
    res["error"].as_str().unwrap()
}

#[tokio::test]
async fn ssh_c58_registers_a_folder_for_the_owning_window_after_the_human_approved_host_and_path() {
    let s = Setup::new();
    let res = s
        .open(json!({"workspaceId": "w1", "host": "dev@db:2200", "path": "/srv//app/"}))
        .await;
    assert_eq!(res, json!({"ok": true, "folderId": "folder000001"}));
    assert_eq!(
        *s.confirms.lock(),
        vec![RemoteFolderConfirm {
            ext_id: "shelf".into(),
            workspace_id: "w1".into(),
            ext_name: "Shelf".into(),
            host: "dev@db:2200".into(),
            path: "/srv/app".into(),
        }]
    );
    assert_eq!(
        s.folders.for_window("win1"),
        vec![RemoteFolder {
            id: "folder000001".into(),
            workspace_id: "w1".into(),
            ext_id: "shelf".into(),
            ext_name: "Shelf".into(),
            host: "dev@db:2200".into(),
            root: "/srv/app".into(),
        }]
    );
    assert_eq!(s.folders.for_window("win2"), vec![]);
    assert_eq!(s.published(), 1);
}

#[tokio::test]
async fn returns_the_folder_that_is_already_open_without_asking_again() {
    let s = Setup::new();
    let first = s.opened("w1", "/srv/app").await;
    assert_eq!(s.opened("w1", "/srv/app").await, first);
    assert_eq!(s.confirms.lock().len(), 1);
}

#[tokio::test]
async fn ssh_c59_refuses_a_denied_dialog_unknown_scratch_and_sandboxed_workspaces_bad_hosts_and_paths()
 {
    let denied = Setup::denying();
    let res = denied
        .open(json!({"workspaceId": "w1", "host": "db", "path": "/srv"}))
        .await;
    assert_eq!(error_of(&res), "denied");
    assert_eq!(denied.folders.for_window("win1"), vec![]);
    assert_eq!(denied.published(), 0);

    let s = Setup::new();
    let attempts = [
        (
            json!({"workspaceId": "nope", "host": "db", "path": "/srv"}),
            "unknown-workspace",
        ),
        (json!({"host": "db", "path": "/srv"}), "unknown-workspace"),
        (
            json!({"workspaceId": "boxed", "host": "db", "path": "/srv"}),
            "sandboxed",
        ),
        (
            json!({"workspaceId": "scratch", "host": "db", "path": "/srv"}),
            "scratch",
        ),
        (
            json!({"workspaceId": "w1", "host": "db host", "path": "/srv"}),
            "invalid-params",
        ),
        (
            json!({"workspaceId": "w1", "host": "db;reboot", "path": "/srv"}),
            "invalid-params",
        ),
        (
            json!({"workspaceId": "w1", "host": "db", "path": "srv"}),
            "invalid-params",
        ),
        (
            json!({"workspaceId": "w1", "host": "db", "path": "/srv/../etc"}),
            "invalid-params",
        ),
        (
            json!({"workspaceId": "w1", "host": "db", "path": "/a\nb"}),
            "invalid-params",
        ),
        (Value::Null, "unknown-workspace"),
    ];
    for (params, error) in attempts {
        let res = s.open(params.clone()).await;
        assert_eq!(error_of(&res), error, "{params}");
    }
    assert!(s.confirms.lock().is_empty());
    assert_eq!(s.folders.for_window("win1"), vec![]);
}

#[tokio::test]
async fn ssh_c59_holds_at_most_eight_folders_per_workspace() {
    let s = Setup::new();
    for i in 0..8 {
        s.opened("w1", &format!("/srv/app{i}")).await;
    }
    let res = s
        .open(json!({"workspaceId": "w1", "host": "dev@db", "path": "/srv/more"}))
        .await;
    assert_eq!(error_of(&res), "too-many");
    assert_eq!(s.confirms.lock().len(), 8);
    assert_eq!(s.opened("w2", "/srv/more").await, "folder000009");
}

#[tokio::test]
async fn drops_the_folder_when_the_workspace_closed_while_the_human_was_asked() {
    let s = Setup::new();
    let gate = Arc::new(Notify::new());
    *s.gate.lock() = Some(gate.clone());
    let (res, ()) = tokio::join!(
        s.open(json!({"workspaceId": "w1", "host": "db", "path": "/srv"})),
        async {
            s.owners.lock().remove("w1");
            gate.notify_one();
        }
    );
    assert_eq!(error_of(&res), "unknown-workspace");
    assert_eq!(s.published(), 0);
    assert_eq!(s.folder_ids("win1"), Vec::<String>::new());
}

#[tokio::test]
async fn names_a_folder_with_twelve_lower_case_hex_digits_when_no_id_source_is_given() {
    let s = Setup::build(true, false);
    let first = s.opened("w1", "/a").await;
    let second = s.opened("w1", "/b").await;
    assert!(REMOTE_FOLDER_ID_PATTERN.is_match(&first), "{first}");
    assert!(first.bytes().all(|b| b.is_ascii_hexdigit()), "{first}");
    assert_ne!(first, second);
}

#[tokio::test]
async fn gives_each_refusal_its_error_and_message() {
    let s = Setup::new();
    let params = |workspace: &str, host: &str, path: &str| json!({"workspaceId": workspace, "host": host, "path": path});
    assert_eq!(
        s.open(params("nope", "db", "/srv")).await,
        json!({"ok": false, "error": "unknown-workspace", "message": "workspaceId is not an open workspace"})
    );
    assert_eq!(
        s.open(params("boxed", "db", "/srv")).await,
        json!({"ok": false, "error": "sandboxed", "message": "a sandboxed workspace has no remote folders"})
    );
    assert_eq!(
        s.open(params("scratch", "db", "/srv")).await,
        json!({"ok": false, "error": "scratch", "message": "a scratch workspace has no remote folders"})
    );
    assert_eq!(
        s.open(params("w1", "db host", "/srv")).await,
        json!({"ok": false, "error": "invalid-params", "message": "host must be a plain host name"})
    );
    assert_eq!(
        s.open(params("w1", "db", "srv")).await,
        json!({"ok": false, "error": "invalid-params", "message": "path must be absolute, without .."})
    );
    assert_eq!(
        Setup::denying().open(params("w1", "db", "/srv")).await,
        json!({"ok": false, "error": "denied", "message": "the human did not open the folder"})
    );
}

#[tokio::test]
async fn refuses_a_non_string_workspace_id_and_a_non_string_host() {
    let s = Setup::new();
    for params in [
        json!({"workspaceId": 7, "host": "db", "path": "/srv"}),
        json!({"workspaceId": "", "host": "db", "path": "/srv"}),
    ] {
        let res = s.open(params.clone()).await;
        assert_eq!(error_of(&res), "unknown-workspace", "{params}");
    }
    for params in [
        json!({"workspaceId": "w1", "path": "/srv"}),
        json!({"workspaceId": "w1", "host": 7, "path": "/srv"}),
        json!({"workspaceId": "w1", "host": "", "path": "/srv"}),
        json!({"workspaceId": "w1", "host": "h".repeat(331), "path": "/srv"}),
    ] {
        let res = s.open(params.clone()).await;
        assert_eq!(error_of(&res), "invalid-params", "{params}");
    }
    assert!(s.confirms.lock().is_empty());
}

#[tokio::test]
async fn keeps_one_folder_for_each_extension_host_and_root_and_opens_another_for_a_new_host() {
    let s = Setup::new();
    let first = s.opened("w1", "/srv/app").await;
    let other_host = s
        .open(json!({"workspaceId": "w1", "host": "other", "path": "/srv/app"}))
        .await;
    assert_ne!(other_host["folderId"], json!(first));
    let other_ext = wire(
        s.folders
            .open(
                &RemoteExtension {
                    id: "other".into(),
                    name: "Other".into(),
                },
                &json!({"workspaceId": "w1", "host": "dev@db", "path": "/srv/app/"}),
            )
            .await,
    );
    assert_ne!(other_ext["folderId"], json!(first));
    let same = s
        .open(json!({"workspaceId": "w1", "host": "dev@db", "path": "/srv//app/"}))
        .await;
    assert_eq!(same["folderId"], json!(first));
    assert_eq!(s.confirms.lock().len(), 3);
}

#[tokio::test]
async fn ssh_c60_closes_for_the_human_of_the_owning_window_the_workspace_and_the_extension() {
    let s = Setup::new();
    let a = s.opened("w1", "/a").await;
    let b = s.opened("w1", "/b").await;
    let c = s.opened("w2", "/c").await;
    assert!(!s.folders.close_by_window("win2", &a));
    assert!(s.folders.close_by_window("win1", &a));
    assert_eq!(s.closed_ids(), vec![a.clone()]);
    assert!(!s.folders.close_by_extension("other", &b));
    assert!(s.folders.close_by_extension("shelf", &b));
    assert_eq!(s.closed_ids(), vec![a.clone()]);
    s.folders.workspace_closed("w2");
    assert_eq!(s.closed_ids(), vec![a.clone(), c]);
    assert_eq!(s.folders.for_window("win1"), vec![]);
    assert_eq!(s.folders.for_window("win2"), vec![]);
    let d = s.opened("w1", "/d").await;
    s.folders.extension_gone("shelf");
    assert_eq!(s.folders.for_window("win1"), vec![]);
    assert!(!s.closed_ids().contains(&d));
}

#[tokio::test]
async fn publishes_once_for_each_close_that_removed_a_folder_and_never_for_one_that_did_not() {
    let s = Setup::new();
    let a = s.opened("w1", "/a").await;
    s.opened("w1", "/b").await;
    let before = s.published();
    assert!(!s.folders.close_by_window("win1", "nosuchid0000"));
    assert!(!s.folders.close_by_extension("shelf", "nosuchid0000"));
    s.folders.workspace_closed("w2");
    s.folders.extension_gone("other");
    assert_eq!(s.published(), before);
    assert!(s.folders.close_by_window("win1", &a));
    assert_eq!(s.published(), before + 1);
    s.folders.workspace_closed("w1");
    assert_eq!(s.published(), before + 2);
    assert_eq!(s.closed.lock().len(), 2);
    s.folders.extension_gone("shelf");
    assert_eq!(s.published(), before + 2);
}

#[tokio::test]
async fn follows_the_workspace_to_the_window_that_owns_it_now() {
    let s = Setup::new();
    let id = s.opened("w1", "/srv/app").await;
    s.owners.lock().insert("w1".into(), "win2".into());
    assert_eq!(s.folders.for_window("win1"), vec![]);
    assert_eq!(s.folder_ids("win2"), vec![id.clone()]);
    let res = wire(
        s.folders
            .list("win1", &json!(format!("remote://{id}/srv/app")))
            .await,
    );
    assert_eq!(res, json!({"ok": false, "error": "unknown-folder"}));
    s.published.store(0, Ordering::SeqCst);
    s.folders.owner_changed("w1");
    assert_eq!(s.published(), 1);
    s.folders.owner_changed("w2");
    assert_eq!(s.published(), 1);
}

#[tokio::test]
async fn asks_the_extension_with_the_folder_root_and_the_normalized_path() {
    let s = Setup::new();
    let id = s.opened("w1", "/srv/app").await;
    let res = wire(
        s.folders
            .list("win1", &json!(format!("remote://{id}/srv/app//src/")))
            .await,
    );
    assert_eq!(
        res,
        json!({"ok": true, "entries": [{"name": "a.txt", "dir": false}], "truncated": false})
    );
    assert_eq!(
        wire(&*s.requests.lock()),
        json!([{"op": "list", "folderId": id, "root": "/srv/app", "path": "/srv/app/src"}])
    );
}

#[tokio::test]
async fn ssh_c62_refuses_paths_outside_the_folder_bad_paths_and_other_windows_without_asking_the_extension()
 {
    let s = Setup::new();
    let id = s.opened("w1", "/srv/app").await;
    let bad = [
        (
            "win1",
            json!(format!("remote://{id}/srv/application/x")),
            "outside",
        ),
        (
            "win1",
            json!(format!("remote://{id}/etc/passwd")),
            "outside",
        ),
        (
            "win1",
            json!(format!("remote://{id}/srv/app/../../etc/passwd")),
            "invalid-path",
        ),
        (
            "win1",
            json!(format!("remote://{id}/srv/app/a\u{0}b")),
            "invalid-path",
        ),
        ("win1", json!("/srv/app/x"), "invalid-path"),
        (
            "win1",
            json!("remote://nosuchfolder/srv/app"),
            "unknown-folder",
        ),
        ("win1", json!({"path": "/srv/app"}), "invalid-path"),
        (
            "win2",
            json!(format!("remote://{id}/srv/app/x")),
            "unknown-folder",
        ),
    ];
    for (window, path, error) in bad {
        let failure = json!({"ok": false, "error": error});
        assert_eq!(wire(s.folders.list(window, &path).await), failure, "{path}");
        assert_eq!(wire(s.folders.stat(window, &path).await), failure, "{path}");
        assert_eq!(wire(s.folders.read(window, &path).await), failure, "{path}");
        assert_eq!(
            wire(
                s.folders
                    .write(window, &path, &json!("x"), &json!("any"))
                    .await
            ),
            failure,
            "{path}"
        );
    }
    assert!(s.requests.lock().is_empty());
}

#[tokio::test]
async fn allows_every_path_under_a_root_of_slash_and_the_root_itself() {
    let s = Setup::new();
    let id = s.opened("w1", "/").await;
    let res = wire(
        s.folders
            .stat("win1", &json!(format!("remote://{id}/etc/hosts")))
            .await,
    );
    assert_ne!(res["error"], json!("outside"));
    let root = wire(
        s.folders
            .list("win1", &json!(format!("remote://{id}/")))
            .await,
    );
    assert_eq!(root["ok"], json!(true));
    let paths: Vec<String> = s.requests.lock().iter().map(|r| r.path.clone()).collect();
    assert_eq!(paths, vec!["/etc/hosts".to_owned(), "/".to_owned()]);
}

#[tokio::test]
async fn validates_what_the_extension_answers_and_reports_a_dead_extension_as_unavailable() {
    let s = Setup::new();
    let id = s.opened("w1", "/srv/app").await;
    let file = json!(format!("remote://{id}/srv/app/a.txt"));
    s.answer(json!({"ok": true, "content": "text", "version": "5-4"}));
    assert_eq!(
        wire(s.folders.read("win1", &file).await),
        json!({"ok": true, "content": "text", "version": "5-4"})
    );
    s.answer(json!({"ok": true, "content": "a\u{0}", "version": "5-4"}));
    assert_eq!(
        wire(s.folders.read("win1", &file).await),
        json!({"ok": false, "error": "binary"})
    );
    s.answer(json!({"ok": true, "kind": "file", "version": "5-4"}));
    assert_eq!(
        wire(s.folders.stat("win1", &file).await),
        json!({"ok": true, "kind": "file", "version": "5-4"})
    );
    s.answer_error("gone");
    assert_eq!(
        wire(s.folders.read("win1", &file).await),
        json!({"ok": false, "error": "unavailable"})
    );
}

#[tokio::test]
async fn reports_a_dead_extension_as_unavailable_for_every_operation() {
    let s = Setup::new();
    let id = s.opened("w1", "/srv/app").await;
    let file = json!(format!("remote://{id}/srv/app/a.txt"));
    s.answer_error("gone");
    let unavailable = json!({"ok": false, "error": "unavailable"});
    assert_eq!(wire(s.folders.list("win1", &file).await), unavailable);
    assert_eq!(wire(s.folders.stat("win1", &file).await), unavailable);
    assert_eq!(wire(s.folders.read("win1", &file).await), unavailable);
    assert_eq!(
        wire(
            s.folders
                .write("win1", &file, &json!("x"), &json!("any"))
                .await
        ),
        unavailable
    );
    s.answer(json!({"ok": false, "error": "denied"}));
    assert_eq!(
        wire(s.folders.stat("win1", &file).await),
        json!({"ok": false, "error": "denied"})
    );
    s.answer(json!("not an object"));
    assert_eq!(
        wire(s.folders.stat("win1", &file).await),
        json!({"ok": false, "error": "failed"})
    );
}

#[tokio::test]
async fn sends_each_operation_with_its_own_op_and_no_write_fields() {
    let s = Setup::new();
    let id = s.opened("w1", "/srv/app").await;
    let file = json!(format!("remote://{id}/srv/app/a.txt"));
    s.folders.stat("win1", &file).await;
    s.folders.read("win1", &file).await;
    let sent = wire(&*s.requests.lock());
    assert_eq!(
        sent,
        json!([
            {"op": "stat", "folderId": id, "root": "/srv/app", "path": "/srv/app/a.txt"},
            {"op": "read", "folderId": id, "root": "/srv/app", "path": "/srv/app/a.txt"},
        ])
    );
}

#[tokio::test]
async fn writes_text_with_a_base_version_and_refuses_anything_else_before_asking() {
    let s = Setup::new();
    let id = s.opened("w1", "/srv/app").await;
    let file = json!(format!("remote://{id}/srv/app/a.txt"));
    s.answer(json!({"ok": true, "version": "7-3"}));
    assert_eq!(
        wire(
            s.folders
                .write("win1", &file, &json!("new"), &json!("5-4"))
                .await
        ),
        json!({"ok": true, "version": "7-3"})
    );
    assert_eq!(
        wire(s.requests.lock().last().unwrap()),
        json!({
            "op": "write",
            "folderId": id,
            "root": "/srv/app",
            "path": "/srv/app/a.txt",
            "content": "new",
            "baseVersion": "5-4",
        })
    );
    let asked = s.requests.lock().len();
    assert_eq!(
        wire(
            s.folders
                .write("win1", &file, &json!("a\u{0}"), &json!("5-4"))
                .await
        ),
        json!({"ok": false, "error": "binary"})
    );
    assert_eq!(
        wire(
            s.folders
                .write("win1", &file, &json!(7), &json!("5-4"))
                .await
        ),
        json!({"ok": false, "error": "binary"})
    );
    let huge = "x".repeat(3 * 1024 * 1024);
    assert_eq!(
        wire(
            s.folders
                .write("win1", &file, &json!(huge), &json!("5-4"))
                .await
        ),
        json!({"ok": false, "error": "too-large"})
    );
    assert_eq!(
        wire(
            s.folders
                .write("win1", &file, &json!("x"), &json!("not a version"))
                .await
        ),
        json!({"ok": false, "error": "failed"})
    );
    assert_eq!(
        wire(
            s.folders
                .write("win1", &file, &json!("x"), &Value::Null)
                .await
        ),
        json!({"ok": false, "error": "failed"})
    );
    assert_eq!(s.requests.lock().len(), asked);
    s.answer(json!({"ok": false, "error": "changed"}));
    assert_eq!(
        wire(
            s.folders
                .write("win1", &file, &json!("x"), &json!("new"))
                .await
        ),
        json!({"ok": false, "error": "changed"})
    );
}

#[tokio::test]
async fn limits_a_write_by_utf8_bytes_and_accepts_the_any_and_new_base_versions() {
    let s = Setup::new();
    let id = s.opened("w1", "/srv/app").await;
    let file = json!(format!("remote://{id}/srv/app/a.txt"));
    s.answer(json!({"ok": true, "version": "1-1"}));
    let limit = 2 * 1024 * 1024;
    let exact = "x".repeat(limit);
    assert_eq!(
        wire(
            s.folders
                .write("win1", &file, &json!(exact), &json!("any"))
                .await
        ),
        json!({"ok": true, "version": "1-1"})
    );
    let over = "x".repeat(limit + 1);
    assert_eq!(
        wire(
            s.folders
                .write("win1", &file, &json!(over), &json!("any"))
                .await
        ),
        json!({"ok": false, "error": "too-large"})
    );
    let wide = "é".repeat(limit / 2 + 1);
    assert_eq!(
        wire(
            s.folders
                .write("win1", &file, &json!(wide), &json!("new"))
                .await
        ),
        json!({"ok": false, "error": "too-large"})
    );
    let fits = "é".repeat(limit / 2);
    assert_eq!(
        wire(
            s.folders
                .write("win1", &file, &json!(fits), &json!("new"))
                .await
        ),
        json!({"ok": true, "version": "1-1"})
    );
    let empty = wire(
        s.folders
            .write("win1", &file, &json!(""), &json!("any"))
            .await,
    );
    assert_eq!(empty, json!({"ok": true, "version": "1-1"}));
    assert_eq!(s.requests.lock().len(), 4);
}
