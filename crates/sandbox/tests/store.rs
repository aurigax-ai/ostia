#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use ostia_base::WorkspaceId;
use ostia_contract::sandbox::WorkspaceSandbox;
use ostia_contract::sandbox_parse::parse_workspace_sandbox;
use ostia_sandbox::store::SandboxStore;
use serde_json::{Value, json};
use tempfile::TempDir;

fn file_in() -> (TempDir, PathBuf) {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("sandboxes.json");
    (dir, file)
}

fn w(id: &str) -> WorkspaceId {
    WorkspaceId::new(id)
}

fn sandbox(value: Value) -> WorkspaceSandbox {
    parse_workspace_sandbox(&value).unwrap()
}

fn enabled(domain: &str) -> WorkspaceSandbox {
    sandbox(json!({"enabled": true, "allowRead": [], "domains": [domain], "controls": {}}))
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/rust")
        .join(name)
}

#[test]
fn starts_empty_and_not_corrupt_when_there_is_no_file() {
    let (_dir, file) = file_in();
    let store = SandboxStore::new(file.clone());
    assert!(!store.is_corrupt());
    assert!(!store.has(&w("a")));
    assert_eq!(store.get(&w("a")), WorkspaceSandbox::empty());
    assert!(!file.exists());
}

#[test]
fn sets_an_entry_returns_it_and_keeps_it_across_a_reload() {
    let (_dir, file) = file_in();
    let store = SandboxStore::new(file.clone());
    let next = enabled("example.com");
    assert_eq!(store.set(&w("a"), next.clone()).unwrap(), next);
    assert!(store.has(&w("a")));
    assert_eq!(store.get(&w("a")), next);
    let reloaded = SandboxStore::new(file);
    assert!(!reloaded.is_corrupt());
    assert_eq!(reloaded.get(&w("a")), next);
    assert_eq!(reloaded.get(&w("b")), WorkspaceSandbox::empty());
}

#[test]
fn writes_the_file_private_to_the_user() {
    let (_dir, file) = file_in();
    let store = SandboxStore::new(file.clone());
    store.set(&w("a"), enabled("example.com")).unwrap();
    assert_eq!(
        fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn removes_an_entry_and_saves_and_leaves_the_file_alone_for_an_unknown_one() {
    let (_dir, file) = file_in();
    let store = SandboxStore::new(file.clone());
    store.remove(&w("ghost")).unwrap();
    assert!(!file.exists());
    store.set(&w("a"), enabled("a.example.com")).unwrap();
    store.set(&w("b"), enabled("b.example.com")).unwrap();
    store.remove(&w("a")).unwrap();
    assert!(!store.has(&w("a")));
    let before = fs::read(&file).unwrap();
    store.remove(&w("a")).unwrap();
    assert_eq!(fs::read(&file).unwrap(), before);
    let reloaded = SandboxStore::new(file);
    assert!(!reloaded.has(&w("a")));
    assert!(reloaded.has(&w("b")));
}

#[test]
fn treats_a_file_that_is_not_an_object_as_corrupt_and_empty() {
    for text in ["[]", "5", "\"x\"", "null", "not json", ""] {
        let (_dir, file) = file_in();
        fs::write(&file, text).unwrap();
        let store = SandboxStore::new(file);
        assert!(store.is_corrupt(), "{text:?}");
        assert_eq!(store.get(&w("a")), WorkspaceSandbox::empty(), "{text:?}");
    }
}

#[test]
fn drops_the_whole_file_when_one_entry_does_not_parse() {
    let (_dir, file) = file_in();
    let good = json!({"enabled": true, "allowRead": [], "domains": [], "controls": {}});
    let bad = json!({"enabled": "yes", "allowRead": [], "domains": [], "controls": {}});
    fs::write(&file, json!({"a": good, "b": bad}).to_string()).unwrap();
    let store = SandboxStore::new(file);
    assert!(store.is_corrupt());
    assert!(!store.has(&w("a")));
    assert!(!store.has(&w("b")));
}

#[test]
fn never_writes_over_a_corrupt_file_but_keeps_changes_in_memory() {
    let (_dir, file) = file_in();
    fs::write(&file, "not json").unwrap();
    let store = SandboxStore::new(file.clone());
    let next = enabled("example.com");
    assert_eq!(store.set(&w("a"), next.clone()).unwrap(), next);
    assert_eq!(store.get(&w("a")), next);
    store.remove(&w("a")).unwrap();
    assert!(!store.has(&w("a")));
    assert_eq!(fs::read_to_string(&file).unwrap(), "not json");
}

#[test]
fn reads_a_file_the_ts_store_wrote_and_writes_the_same_bytes_as_the_ts_store() {
    let (_dir, file) = file_in();
    fs::copy(fixture("sandboxes-before.json"), &file).unwrap();
    let store = SandboxStore::new(file.clone());
    assert!(!store.is_corrupt());
    let first = store.get(&w("w1"));
    assert!(first.enabled);
    assert_eq!(first.allow_read, ["~/notes"]);
    assert_eq!(
        first.allow_write.as_deref(),
        Some(&["~/builds".to_owned()][..])
    );
    assert_eq!(first.ports.as_deref(), Some("deny"));
    assert!(!store.get(&w("w2")).enabled);
    assert_eq!(store.get(&w("w3")).domains, ["é.example.com"]);
    store.remove(&w("w3")).unwrap();
    assert_eq!(
        fs::read(&file).unwrap(),
        fs::read(fixture("sandboxes-after.json")).unwrap()
    );
}
