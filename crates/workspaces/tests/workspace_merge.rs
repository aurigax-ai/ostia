#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;
use std::sync::Arc;

use ostia_contract::sandbox::SandboxMergeRefusal;
use ostia_workspaces::workspace_merge::{
    MergeChecks, WorkspaceMerge, WorkspaceMergeResult, check_merge, merge_workspaces,
};
use parking_lot::Mutex;
use serde_json::{Value, json};

type Calls = Arc<Mutex<Vec<(String, String)>>>;

#[derive(Default)]
struct Setup {
    owners: Option<Vec<(&'static str, &'static str)>>,
    managers: Vec<&'static str>,
    sandbox: Option<SandboxMergeRefusal>,
}

fn checks(setup: Setup) -> (MergeChecks, Calls) {
    let owners: HashMap<String, String> = setup
        .owners
        .unwrap_or_else(|| vec![("a", "7"), ("b", "7"), ("c", "9")])
        .into_iter()
        .map(|(workspace, window)| (workspace.to_owned(), window.to_owned()))
        .collect();
    let managers: Vec<String> = setup.managers.iter().map(|id| (*id).to_owned()).collect();
    let calls: Calls = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&calls);
    let sandbox = setup.sandbox;
    let checks = MergeChecks {
        owner_window: Arc::new(move |id| owners.get(id).cloned()),
        has_manager: Arc::new(move |id| managers.iter().any(|manager| manager == id)),
        sandbox_refusal: Arc::new(move |source, target| {
            seen.lock().push((source.to_owned(), target.to_owned()));
            sandbox
        }),
    };
    (checks, calls)
}

fn run(checks: &MergeChecks, window: &str, source: Value, target: Value) -> Value {
    serde_json::to_value(check_merge(checks, window, &source, &target)).unwrap()
}

fn ids(source: &str, target: &str) -> (Value, Value) {
    (json!(source), json!(target))
}

fn refused(error: &str) -> Value {
    json!({"ok": false, "error": error})
}

#[test]
fn allows_two_workspaces_the_sending_window_owns() {
    let (checks, _) = checks(Setup::default());
    let (source, target) = ids("a", "b");
    assert_eq!(run(&checks, "7", source, target), json!({"ok": true}));
}

#[test]
fn refuses_a_workspace_another_window_owns_an_unknown_one_or_a_merge_into_itself() {
    let (checks, _) = checks(Setup::default());
    let rows: Vec<(&str, Value, Value)> = vec![
        ("7", json!("a"), json!("c")),
        ("9", json!("a"), json!("b")),
        ("7", json!("a"), json!("zzz")),
        ("7", json!("a"), json!("a")),
        ("7", json!(1), json!("b")),
    ];
    for (window, source, target) in rows {
        assert_eq!(
            run(&checks, window, source.clone(), target.clone()),
            refused("not-owned"),
            "{window} {source} {target}"
        );
    }
}

#[test]
fn refuses_the_manager_workspace_on_either_side() {
    for manager in ["a", "b"] {
        let (checks, _) = checks(Setup {
            managers: vec![manager],
            ..Setup::default()
        });
        let (source, target) = ids("a", "b");
        assert_eq!(
            run(&checks, "7", source, target),
            refused("manager"),
            "manager {manager}"
        );
    }
}

#[test]
fn passes_the_sandbox_refusal_through() {
    let (checks, calls) = checks(Setup {
        sandbox: Some(SandboxMergeRefusal::Differs),
        ..Setup::default()
    });
    let (source, target) = ids("a", "b");
    assert_eq!(
        run(&checks, "7", source, target),
        refused("sandbox-differs")
    );
    assert_eq!(calls.lock().clone(), vec![("a".to_owned(), "b".to_owned())]);
}

#[test]
fn merges_in_main_over_workspace_merge_only_when_the_check_allows_it() {
    let (checks, _) = checks(Setup::default());
    let merged: Calls = Arc::new(Mutex::new(Vec::new()));
    let recorder = Arc::clone(&merged);
    let service = WorkspaceMerge {
        checks,
        merge: Arc::new(move |source, target| {
            recorder.lock().push((source.to_owned(), target.to_owned()));
        }),
    };

    let result = merge_workspaces(&service, "7", &json!("a"), &json!("c"));
    assert_eq!(serde_json::to_value(result).unwrap(), refused("not-owned"));
    assert!(merged.lock().is_empty());

    let result = merge_workspaces(&service, "7", &json!("a"), &json!("b"));
    assert_eq!(serde_json::to_value(result).unwrap(), json!({"ok": true}));
    assert_eq!(
        merged.lock().clone(),
        vec![("a".to_owned(), "b".to_owned())]
    );
}

#[test]
fn says_mixed_sandbox_workspaces_cannot_merge() {
    let (checks, _) = checks(Setup {
        sandbox: Some(SandboxMergeRefusal::Mixed),
        ..Setup::default()
    });
    let (source, target) = ids("a", "b");
    assert_eq!(run(&checks, "7", source, target), refused("sandbox-mixed"));
}

#[test]
fn refuses_a_source_or_target_that_is_not_a_string() {
    let (checks, calls) = checks(Setup::default());
    let rows: Vec<(Value, Value)> = vec![
        (json!("a"), Value::Null),
        (json!("a"), json!(7)),
        (json!("a"), json!(["b"])),
        (json!({"id": "a"}), json!("b")),
        (Value::Null, Value::Null),
        (json!(true), json!("b")),
    ];
    for (source, target) in rows {
        assert_eq!(
            run(&checks, "7", source.clone(), target.clone()),
            refused("not-owned"),
            "{source} {target}"
        );
    }
    assert!(calls.lock().is_empty());
}

#[test]
fn refuses_a_workspace_with_an_empty_id_that_nobody_owns() {
    let (checks, _) = checks(Setup::default());
    let (source, target) = ids("", "b");
    assert_eq!(run(&checks, "7", source, target), refused("not-owned"));
}

#[test]
fn does_not_ask_the_sandbox_when_the_owner_check_or_the_manager_check_already_refused() {
    let (checks, calls) = checks(Setup {
        managers: vec!["b"],
        sandbox: Some(SandboxMergeRefusal::Differs),
        ..Setup::default()
    });
    let (source, target) = ids("a", "c");
    assert_eq!(run(&checks, "7", source, target), refused("not-owned"));
    let (source, target) = ids("a", "b");
    assert_eq!(run(&checks, "7", source, target), refused("manager"));
    assert!(calls.lock().is_empty());
}

#[test]
fn refuses_on_the_owner_check_before_the_manager_check() {
    let (checks, _) = checks(Setup {
        managers: vec!["a", "c"],
        ..Setup::default()
    });
    let (source, target) = ids("a", "c");
    assert_eq!(run(&checks, "7", source, target), refused("not-owned"));
}

#[test]
fn a_workspace_with_no_owner_cannot_merge_even_for_a_window_with_the_same_text() {
    let (checks, _) = checks(Setup {
        owners: Some(vec![("a", "7")]),
        ..Setup::default()
    });
    let (source, target) = ids("a", "b");
    assert_eq!(run(&checks, "7", source, target), refused("not-owned"));
}

#[test]
fn does_not_merge_when_the_sandbox_or_the_manager_refuses() {
    let merged: Calls = Arc::new(Mutex::new(Vec::new()));
    for setup in [
        Setup {
            managers: vec!["a"],
            ..Setup::default()
        },
        Setup {
            sandbox: Some(SandboxMergeRefusal::Mixed),
            ..Setup::default()
        },
    ] {
        let (checks, _) = checks(setup);
        let recorder = Arc::clone(&merged);
        let service = WorkspaceMerge {
            checks,
            merge: Arc::new(move |source, target| {
                recorder.lock().push((source.to_owned(), target.to_owned()));
            }),
        };
        let result = merge_workspaces(&service, "7", &json!("a"), &json!("b"));
        assert!(matches!(result, WorkspaceMergeResult::Refused(_)));
    }
    assert!(merged.lock().is_empty());
}
