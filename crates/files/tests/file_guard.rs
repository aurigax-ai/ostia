#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};

use ostia_files::file_guard::{FileGuard, FileGuardDeps, FileOpsBackend, guard_file_ops};
use ostia_files::{FileOpError, FileOpResult};
use serde_json::{Value, json};

fn ok() -> FileOpResult {
    FileOpResult::Ok {
        paths: vec!["/w/a.txt".to_owned()],
    }
}

fn refused(error: FileOpError) -> FileOpResult {
    FileOpResult::Err {
        error,
        paths: None,
        partial: None,
    }
}

#[derive(Clone, Debug, PartialEq)]
struct Call {
    name: &'static str,
    args: Vec<Value>,
}

#[derive(Clone, Default)]
struct Recorder {
    calls: Arc<Mutex<Vec<Call>>>,
}

impl Recorder {
    fn note(&self, name: &'static str, args: Vec<Value>) {
        self.calls.lock().unwrap().push(Call { name, args });
    }

    fn count(&self, name: &str) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| call.name == name)
            .count()
    }

    fn all(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }
}

impl FileOpsBackend for Recorder {
    async fn create(&self, dir: &Value, name: &Value, kind: &Value) -> FileOpResult {
        self.note("create", vec![dir.clone(), name.clone(), kind.clone()]);
        ok()
    }

    async fn rename(&self, path: &Value, name: &Value) -> FileOpResult {
        self.note("rename", vec![path.clone(), name.clone()]);
        ok()
    }

    async fn move_entries(&self, paths: &Value, dir: &Value) -> FileOpResult {
        self.note("move", vec![paths.clone(), dir.clone()]);
        ok()
    }

    async fn copy(&self, paths: &Value, dir: &Value) -> FileOpResult {
        self.note("copy", vec![paths.clone(), dir.clone()]);
        ok()
    }

    async fn trash(&self, paths: &Value) -> FileOpResult {
        self.note("trash", vec![paths.clone()]);
        ok()
    }

    async fn import_into(&self, paths: &Value, dir: &Value, move_entries: bool) -> FileOpResult {
        self.note(
            "importInto",
            vec![paths.clone(), dir.clone(), json!(move_entries)],
        );
        ok()
    }

    async fn draggable(&self, path: &Value) -> Option<String> {
        self.note("draggable", vec![path.clone()]);
        Some("/w/a.txt".to_owned())
    }
}

struct Setup {
    file_ops: Recorder,
    guard: FileGuard<Recorder>,
    asked: Arc<Mutex<Vec<(String, String)>>>,
}

fn setup(refusal: impl Fn(&str) -> Option<String> + Send + Sync + 'static) -> Setup {
    let file_ops = Recorder::default();
    let asked = Arc::new(Mutex::new(Vec::new()));
    let log = asked.clone();
    let guard = guard_file_ops(FileGuardDeps {
        file_ops: file_ops.clone(),
        window_of_workspace: Arc::new(|workspace_id| {
            (workspace_id == "ws1").then(|| "7".to_owned())
        }),
        sandbox_refusal: Arc::new(move |workspace_id, path| {
            log.lock()
                .unwrap()
                .push((workspace_id.to_owned(), path.to_owned()));
            refusal(path)
        }),
    });
    Setup {
        file_ops,
        guard,
        asked,
    }
}

fn open() -> Setup {
    setup(|_| None)
}

const CHANGING: [&str; 6] = ["create", "rename", "move", "copy", "trash", "importInto"];

async fn call(
    guard: &FileGuard<Recorder>,
    name: &str,
    sender: &str,
    workspace: &Value,
) -> FileOpResult {
    match name {
        "create" => {
            guard
                .create(sender, workspace, &json!("/w"), &json!("n"), &json!("file"))
                .await
        }
        "rename" => {
            guard
                .rename(sender, workspace, &json!("/w/a.txt"), &json!("b.txt"))
                .await
        }
        "move" => {
            guard
                .move_entries(sender, workspace, &json!(["/w/a.txt"]), &json!("/w/d"))
                .await
        }
        "copy" => {
            guard
                .copy(sender, workspace, &json!(["/w/a.txt"]), &json!("/w/d"))
                .await
        }
        "trash" => guard.trash(sender, workspace, &json!(["/w/a.txt"])).await,
        "importInto" => {
            guard
                .import_into(
                    sender,
                    workspace,
                    &json!(["/tmp/a.txt"]),
                    &json!("/w"),
                    &json!(true),
                )
                .await
        }
        other => panic!("unknown operation {other}"),
    }
}

#[tokio::test]
async fn runs_for_the_owner_window() {
    for name in CHANGING {
        let setup = open();
        assert_eq!(
            call(&setup.guard, name, "7", &json!("ws1")).await,
            ok(),
            "{name}"
        );
        assert_eq!(setup.file_ops.count(name), 1, "{name}");
    }
}

#[tokio::test]
async fn refuses_a_window_that_does_not_own_the_workspace() {
    for name in CHANGING {
        let setup = open();
        let outside = refused(FileOpError::Outside);
        assert_eq!(
            call(&setup.guard, name, "8", &json!("ws1")).await,
            outside,
            "{name}"
        );
        assert_eq!(
            call(&setup.guard, name, "7", &json!("ws2")).await,
            outside,
            "{name}"
        );
        assert_eq!(
            call(&setup.guard, name, "7", &json!(3)).await,
            outside,
            "{name}"
        );
        assert_eq!(setup.file_ops.count(name), 0, "{name}");
    }
}

#[tokio::test]
async fn refuses_a_path_the_sandbox_write_rules_leave_out() {
    for name in CHANGING {
        for reason in ["outside", "read-only"] {
            let setup = setup(move |_| Some(reason.to_owned()));
            assert_eq!(
                call(&setup.guard, name, "7", &json!("ws1")).await,
                refused(FileOpError::Sandboxed),
                "{name} {reason}"
            );
            assert_eq!(setup.file_ops.count(name), 0, "{name} {reason}");
        }
    }
}

#[tokio::test]
async fn checks_every_source_and_the_destination_of_a_move() {
    let setup = setup(|path| (path == "/etc/x").then(|| "outside".to_owned()));
    assert_eq!(
        setup
            .guard
            .move_entries(
                "7",
                &json!("ws1"),
                &json!(["/w/a.txt", "/etc/x"]),
                &json!("/w/d")
            )
            .await,
        refused(FileOpError::Sandboxed)
    );
    assert_eq!(
        setup
            .guard
            .move_entries("7", &json!("ws1"), &json!(["/w/a.txt"]), &json!("/etc/x"))
            .await,
        refused(FileOpError::Sandboxed)
    );
    assert_eq!(setup.file_ops.count("move"), 0);
}

#[tokio::test]
async fn refuses_a_relative_path_or_malformed_targets_before_the_sandbox_is_asked() {
    let setup = open();
    assert_eq!(
        setup
            .guard
            .trash("7", &json!("ws1"), &json!(["a.txt"]))
            .await,
        refused(FileOpError::Outside)
    );
    assert_eq!(
        setup.guard.trash("7", &json!("ws1"), &json!([4])).await,
        refused(FileOpError::Outside)
    );
    assert_eq!(setup.file_ops.count("trash"), 0);
    assert!(setup.asked.lock().unwrap().is_empty());
}

#[tokio::test]
async fn passes_the_move_choice_to_an_import() {
    let setup = open();
    setup
        .guard
        .import_into(
            "7",
            &json!("ws1"),
            &json!(["/tmp/a.txt"]),
            &json!("/w"),
            &json!("yes"),
        )
        .await;
    assert_eq!(
        setup.file_ops.all(),
        vec![Call {
            name: "importInto",
            args: vec![json!(["/tmp/a.txt"]), json!("/w"), json!(false)],
        }]
    );
}

#[tokio::test]
async fn starts_a_drag_only_for_the_owner_window_and_an_allowed_path() {
    let owned = open();
    assert_eq!(
        owned
            .guard
            .draggable("7", &json!("ws1"), &json!("/w/a.txt"))
            .await,
        Some("/w/a.txt".to_owned())
    );
    assert_eq!(
        owned
            .guard
            .draggable("8", &json!("ws1"), &json!("/w/a.txt"))
            .await,
        None
    );
    let sandboxed = setup(|_| Some("outside".to_owned()));
    assert_eq!(
        sandboxed
            .guard
            .draggable("7", &json!("ws1"), &json!("/w/a.txt"))
            .await,
        None
    );
    assert_eq!(sandboxed.file_ops.count("draggable"), 0);
}

#[tokio::test]
async fn checks_only_the_destination_of_a_copy_and_an_import() {
    let setup = setup(|path| (path == "/etc/x").then(|| "outside".to_owned()));
    assert_eq!(
        setup
            .guard
            .copy("7", &json!("ws1"), &json!(["/etc/x"]), &json!("/w/d"))
            .await,
        ok()
    );
    assert_eq!(
        setup
            .guard
            .import_into(
                "7",
                &json!("ws1"),
                &json!(["/etc/x"]),
                &json!("/w"),
                &json!(true)
            )
            .await,
        ok()
    );
    assert_eq!(
        setup
            .guard
            .copy("7", &json!("ws1"), &json!(["/w/a.txt"]), &json!("/etc/x"))
            .await,
        refused(FileOpError::Sandboxed)
    );
    assert_eq!(
        setup
            .guard
            .import_into(
                "7",
                &json!("ws1"),
                &json!(["/w/a.txt"]),
                &json!("/etc/x"),
                &json!(true)
            )
            .await,
        refused(FileOpError::Sandboxed)
    );
    assert_eq!(setup.file_ops.count("copy"), 1);
    assert_eq!(setup.file_ops.count("importInto"), 1);
}

#[tokio::test]
async fn checks_only_the_path_of_a_rename_and_the_directory_of_a_create() {
    let setup = setup(|path| (path == "/etc").then(|| "outside".to_owned()));
    assert_eq!(
        setup
            .guard
            .rename("7", &json!("ws1"), &json!("/w/a.txt"), &json!("/etc"))
            .await,
        ok()
    );
    assert_eq!(
        setup
            .guard
            .create(
                "7",
                &json!("ws1"),
                &json!("/etc"),
                &json!("n"),
                &json!("file")
            )
            .await,
        refused(FileOpError::Sandboxed)
    );
}

#[tokio::test]
async fn accepts_one_path_where_a_list_is_allowed() {
    let setup = open();
    assert_eq!(
        setup
            .guard
            .trash("7", &json!("ws1"), &json!("/w/a.txt"))
            .await,
        ok()
    );
    assert_eq!(
        setup
            .guard
            .move_entries("7", &json!("ws1"), &json!("/w/a.txt"), &json!("/w/d"))
            .await,
        ok()
    );
    let asked: Vec<String> = setup
        .asked
        .lock()
        .unwrap()
        .iter()
        .map(|(_, path)| path.clone())
        .collect();
    assert_eq!(asked, vec!["/w/a.txt", "/w/a.txt", "/w/d"]);
}

#[tokio::test]
async fn gives_the_sandbox_the_workspace_and_a_normalised_absolute_path() {
    let setup = open();
    setup
        .guard
        .trash(
            "7",
            &json!("ws1"),
            &json!(["/w/sub/../a.txt", "/w//b.txt/"]),
        )
        .await;
    assert_eq!(
        *setup.asked.lock().unwrap(),
        vec![
            ("ws1".to_owned(), "/w/a.txt".to_owned()),
            ("ws1".to_owned(), "/w/b.txt".to_owned()),
        ]
    );
}

#[tokio::test]
async fn sends_the_original_unnormalised_input_to_the_file_operations() {
    let setup = open();
    setup
        .guard
        .trash("7", &json!("ws1"), &json!(["/w/sub/../a.txt"]))
        .await;
    assert_eq!(
        setup.file_ops.all(),
        vec![Call {
            name: "trash",
            args: vec![json!(["/w/sub/../a.txt"])],
        }]
    );
}

#[tokio::test]
async fn refuses_a_window_that_does_not_own_the_workspace_before_the_sandbox_is_asked() {
    let setup = open();
    setup
        .guard
        .trash("8", &json!("ws1"), &json!(["/w/a.txt"]))
        .await;
    assert!(setup.asked.lock().unwrap().is_empty());
}
