#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use ostia_git::view_state::{MAX_REMEMBERED_REPOS, ViewStateStore, parse_view_state};
use serde_json::{Map, Value, json};
use tempfile::TempDir;

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_owned()).collect()
}

fn entry(root: &str, refs: &[&str]) -> (String, Vec<String>) {
    (root.to_owned(), strings(refs))
}

fn roots(state: &ostia_git::view_state::ViewState) -> Vec<&str> {
    state.chosen.iter().map(|(root, _)| root.as_str()).collect()
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/rust")
        .join(name)
}

fn open(file: &std::path::Path) -> ViewStateStore {
    ViewStateStore::new(Some(file.to_path_buf()))
}

#[test]
fn starts_with_no_chosen_branches() {
    assert!(parse_view_state(&Value::Null).chosen.is_empty());
}

#[test]
fn keeps_valid_branch_lists_per_absolute_repository_root_and_drops_the_rest() {
    let state = parse_view_state(&json!({
        "chosen": {
            "/r/a": ["refs/heads/main", "--all"],
            "/r/b": ["--all"],
            "relative": ["refs/heads/main"],
        }
    }));
    assert_eq!(state.chosen, vec![entry("/r/a", &["refs/heads/main"])]);
}

#[test]
fn starts_empty_for_input_that_is_not_an_object_with_a_chosen_object() {
    let cases = [
        json!(1),
        json!("x"),
        json!(true),
        json!([]),
        json!({}),
        json!({"chosen": null}),
        json!({"chosen": "x"}),
        json!({"chosen": 3}),
        json!({"chosen": ["refs/heads/main"]}),
        json!({"chosen": {"/r/a": "refs/heads/main"}}),
        json!({"chosen": {"/r/a": null}}),
        json!({"chosen": {"/r/a": []}}),
    ];
    for raw in cases {
        assert!(parse_view_state(&raw).chosen.is_empty(), "{raw}");
    }
}

#[test]
fn keeps_the_file_order_and_the_scope_rules_of_the_refs() {
    let state = parse_view_state(&json!({
        "chosen": {
            "/r/z": ["refs/heads/b", "refs/heads/a", "refs/heads/b", 7, "refs/tags/v1", "refs/heads/has space"],
            "/r/a": ["refs/remotes/origin/main"],
        }
    }));
    assert_eq!(
        state.chosen,
        vec![
            entry("/r/z", &["refs/heads/b", "refs/heads/a"]),
            entry("/r/a", &["refs/remotes/origin/main"]),
        ]
    );
}

#[test]
fn reads_only_the_newest_repositories_past_the_cap_before_it_drops_invalid_ones() {
    let mut chosen = Map::new();
    chosen.insert("relative".to_owned(), json!(["refs/heads/m"]));
    for i in 0..MAX_REMEMBERED_REPOS {
        chosen.insert(format!("/r/{i}"), json!(["refs/heads/m"]));
    }
    let state = parse_view_state(&json!({"chosen": chosen}));
    assert_eq!(state.chosen.len(), MAX_REMEMBERED_REPOS);
    assert_eq!(roots(&state)[0], "/r/0");

    let mut over = Map::new();
    over.insert("/r/old".to_owned(), json!(["refs/heads/m"]));
    for i in 0..MAX_REMEMBERED_REPOS - 1 {
        over.insert(format!("relative{i}"), json!(["refs/heads/m"]));
    }
    over.insert("/r/new".to_owned(), json!(["refs/heads/m"]));
    let state = parse_view_state(&json!({"chosen": over}));
    assert_eq!(roots(&state), ["/r/new"]);
}

#[test]
fn remembers_chosen_branches_per_repository_across_restarts() {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("sub").join("view.json");
    let store = open(&file);
    assert_eq!(store.chosen_for("/r/a"), None);
    store
        .set_chosen("/r/a", Some(&strings(&["refs/heads/x"])))
        .unwrap();
    store
        .set_chosen("/r/b", Some(&strings(&["refs/remotes/origin/main"])))
        .unwrap();
    let again = open(&file);
    assert_eq!(again.chosen_for("/r/a"), Some(strings(&["refs/heads/x"])));
    assert_eq!(
        again.chosen_for("/r/b"),
        Some(strings(&["refs/remotes/origin/main"]))
    );
    again.set_chosen("/r/b", None).unwrap();
    let written: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    assert!(written["chosen"].get("/r/b").is_none());
    assert!(written["chosen"].get("/r/a").is_some());
}

#[test]
fn forgets_the_oldest_repositories_past_the_cap() {
    let dir = TempDir::new().unwrap();
    let store = open(&dir.path().join("view.json"));
    for i in 0..=MAX_REMEMBERED_REPOS {
        store
            .set_chosen(&format!("/r/{i}"), Some(&strings(&["refs/heads/m"])))
            .unwrap();
    }
    assert_eq!(store.chosen_for("/r/0"), None);
    assert_eq!(
        store.chosen_for(&format!("/r/{MAX_REMEMBERED_REPOS}")),
        Some(strings(&["refs/heads/m"]))
    );
    assert_eq!(store.chosen_for("/r/1"), Some(strings(&["refs/heads/m"])));
}

#[test]
fn starts_empty_when_the_file_is_unreadable() {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("view.json");
    fs::write(&file, "{nope").unwrap();
    assert_eq!(open(&file).chosen_for("/r/a"), None);
    let missing = dir.path().join("missing.json");
    assert_eq!(open(&missing).chosen_for("/r/a"), None);
}

#[test]
fn removes_a_repository_when_the_list_is_empty_or_null_and_moves_a_chosen_one_to_the_end() {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("view.json");
    let store = open(&file);
    for root in ["/r/a", "/r/b", "/r/c"] {
        store
            .set_chosen(root, Some(&strings(&["refs/heads/m"])))
            .unwrap();
    }
    store
        .set_chosen("/r/a", Some(&strings(&["refs/heads/n"])))
        .unwrap();
    store.set_chosen("/r/b", Some(&[])).unwrap();
    store.set_chosen("/r/missing", None).unwrap();
    assert_eq!(store.chosen_for("/r/b"), None);
    let written: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    let keys: Vec<&String> = written["chosen"].as_object().unwrap().keys().collect();
    assert_eq!(keys, ["/r/c", "/r/a"]);
}

#[test]
fn stores_the_refs_it_is_given_without_checking_them() {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("view.json");
    let store = open(&file);
    store
        .set_chosen("/r/a", Some(&strings(&["--all"])))
        .unwrap();
    assert_eq!(store.chosen_for("/r/a"), Some(strings(&["--all"])));
    assert_eq!(open(&file).chosen_for("/r/a"), None);
}

#[test]
fn keeps_choices_in_memory_and_writes_nothing_without_a_file() {
    let store = ViewStateStore::new(None);
    store
        .set_chosen("/r/a", Some(&strings(&["refs/heads/x"])))
        .unwrap();
    assert_eq!(store.chosen_for("/r/a"), Some(strings(&["refs/heads/x"])));
    store.set_chosen("/r/a", None).unwrap();
    assert_eq!(store.chosen_for("/r/a"), None);
}

#[test]
fn writes_a_private_file_in_a_private_folder() {
    let dir = TempDir::new().unwrap();
    let folder = dir.path().join("made").join("deep");
    let file = folder.join("view.json");
    open(&file)
        .set_chosen("/r/a", Some(&strings(&["refs/heads/x"])))
        .unwrap();
    assert_eq!(
        fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(&folder).unwrap().permissions().mode() & 0o777,
        0o700
    );
}

#[test]
fn keeps_the_change_in_memory_when_the_save_fails() {
    let dir = TempDir::new().unwrap();
    let blocker = dir.path().join("blocker");
    fs::write(&blocker, "x").unwrap();
    let store = open(&blocker.join("view.json"));
    let result = store.set_chosen("/r/a", Some(&strings(&["refs/heads/x"])));
    assert!(result.is_err());
    assert_eq!(store.chosen_for("/r/a"), Some(strings(&["refs/heads/x"])));
}

#[test]
fn reads_a_file_the_ts_store_wrote_and_writes_the_same_bytes_as_the_ts_store() {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("view.json");
    fs::copy(fixture("git-view-state-before.json"), &file).unwrap();
    let store = open(&file);
    assert_eq!(
        store.chosen_for("/r/a"),
        Some(strings(&["refs/heads/main", "refs/remotes/origin/dev"]))
    );
    assert_eq!(store.chosen_for("/r/b"), Some(strings(&["refs/heads/é"])));
    store.set_chosen("/r/b", None).unwrap();
    store
        .set_chosen("/r/a", Some(&strings(&["refs/heads/next"])))
        .unwrap();
    assert_eq!(
        fs::read(&file).unwrap(),
        fs::read(fixture("git-view-state-after.json")).unwrap()
    );
}

#[test]
fn leaves_the_permissions_of_a_folder_that_already_exists() {
    let dir = TempDir::new().unwrap();
    let folder = dir.path().join("shared");
    fs::create_dir(&folder).unwrap();
    fs::set_permissions(&folder, fs::Permissions::from_mode(0o755)).unwrap();
    open(&folder.join("view.json"))
        .set_chosen("/r/a", Some(&strings(&["refs/heads/x"])))
        .unwrap();
    assert_eq!(
        fs::metadata(&folder).unwrap().permissions().mode() & 0o777,
        0o755
    );
}
