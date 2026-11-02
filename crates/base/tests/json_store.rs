#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::PathBuf;

use ostia_base::host::{Host, Platform};
use ostia_base::json_store::{
    SaveOptions, StoreScope, load_json, save_json, save_json_async, store_path,
};
use serde_json::json;
use tempfile::tempdir;

fn host(env: &[(&str, &str)]) -> Host {
    Host {
        env: env
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect::<BTreeMap<_, _>>(),
        home: PathBuf::from("/home/u"),
        cwd: PathBuf::from("/work/cwd"),
        platform: Platform::Linux,
    }
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/rust")
        .join(name)
}

fn mode(path: &std::path::Path) -> u32 {
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[test]
fn project_scope_resolves_under_the_work_dir() {
    let path = store_path(&host(&[]), "notes", StoreScope::Project, Some("/work/dir"));
    assert_eq!(path, PathBuf::from("/work/dir/.ostia/notes.json"));
}

#[test]
fn project_scope_with_a_blank_work_dir_uses_cwd() {
    let path = store_path(&host(&[]), "notes", StoreScope::Project, Some("  "));
    assert_eq!(path, PathBuf::from("/work/cwd/.ostia/notes.json"));
}

#[test]
fn global_scope_uses_the_data_home_of_the_new_app() {
    let path = store_path(
        &host(&[("XDG_DATA_HOME", "/data")]),
        "notes",
        StoreScope::Global,
        None,
    );
    assert_eq!(path, PathBuf::from("/data/ostia-rs/notes.json"));
}

#[test]
fn a_missing_or_broken_file_loads_as_none() {
    let dir = tempdir().unwrap();
    assert_eq!(load_json(&dir.path().join("none.json")), None);
    let broken = dir.path().join("broken.json");
    fs::write(&broken, "{nope").unwrap();
    assert_eq!(load_json(&broken), None);
}

#[test]
fn reads_a_file_the_ts_store_wrote_and_writes_the_same_bytes() {
    let dir = tempdir().unwrap();
    let file = dir.path().join("store.json");
    let ts_bytes = fs::read(fixture("json-store-pretty.json")).unwrap();
    fs::write(&file, &ts_bytes).unwrap();
    let value = load_json(&file).unwrap();
    assert_eq!(value["count"], json!(1700000000123_i64));
    save_json(&file, &value, SaveOptions::default()).unwrap();
    assert_eq!(fs::read(&file).unwrap(), ts_bytes);
}

#[tokio::test]
async fn the_async_save_writes_the_same_bytes_as_the_ts_store() {
    let dir = tempdir().unwrap();
    let file = dir.path().join("store.json");
    let ts_bytes = fs::read(fixture("json-store-compact.json")).unwrap();
    let value = load_json(&fixture("json-store-pretty.json")).unwrap();
    save_json_async(&file, &value, SaveOptions::default())
        .await
        .unwrap();
    assert_eq!(fs::read(&file).unwrap(), ts_bytes);
}

#[test]
fn a_secure_save_makes_the_file_0600_and_the_folder_0700() {
    let dir = tempdir().unwrap();
    let file = dir.path().join("deep/er/secret.json");
    save_json(&file, &json!({"a": 1}), SaveOptions::SECURE).unwrap();
    assert_eq!(mode(&file), 0o600);
    assert_eq!(mode(file.parent().unwrap()), 0o700);
}

#[test]
fn a_secure_save_tightens_a_folder_that_exists() {
    let dir = tempdir().unwrap();
    let folder = dir.path().join("open");
    fs::create_dir(&folder).unwrap();
    fs::set_permissions(&folder, fs::Permissions::from_mode(0o755)).unwrap();
    save_json(&folder.join("s.json"), &json!({}), SaveOptions::SECURE).unwrap();
    assert_eq!(mode(&folder), 0o700);
}

#[test]
fn a_save_replaces_a_symlink_and_leaves_its_target_alone() {
    let dir = tempdir().unwrap();
    let target = dir.path().join("target.json");
    fs::write(&target, "keep").unwrap();
    let link = dir.path().join("link.json");
    symlink(&target, &link).unwrap();
    save_json(&link, &json!({"a": 1}), SaveOptions::SECURE).unwrap();
    assert_eq!(fs::read_to_string(&target).unwrap(), "keep");
    assert!(
        !fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

#[test]
fn a_save_keeps_a_temp_of_another_host_and_leaves_no_temp_of_its_own() {
    let dir = tempdir().unwrap();
    let file = dir.path().join("s.json");
    save_json(&file, &json!({}), SaveOptions::default()).unwrap();
    let other = dir.path().join("s.json.zzzzzzzz.1.0000000000000000.tmp");
    fs::write(&other, "x").unwrap();
    save_json(&file, &json!({}), SaveOptions::default()).unwrap();
    assert!(other.exists());
    let names: Vec<_> = fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(names.len(), 2);
}

#[tokio::test]
async fn the_async_save_writes_compact_json() {
    let dir = tempdir().unwrap();
    let file = dir.path().join("s.json");
    save_json_async(&file, &json!({"z": 1, "a": [1, 2]}), SaveOptions::SECURE)
        .await
        .unwrap();
    assert_eq!(fs::read_to_string(&file).unwrap(), r#"{"z":1,"a":[1,2]}"#);
    assert_eq!(mode(&file), 0o600);
}

#[test]
fn project_scope_with_no_work_dir_falls_back_to_cwd() {
    let path = store_path(&host(&[]), "notes", StoreScope::Project, None);
    assert_eq!(path, PathBuf::from("/work/cwd/.ostia/notes.json"));
}

#[test]
fn global_scope_falls_back_to_the_local_share_folder_of_the_home_when_xdg_data_home_is_unset() {
    let path = store_path(&host(&[]), "notes", StoreScope::Global, None);
    assert_eq!(
        path,
        PathBuf::from("/home/u/.local/share/ostia-rs/notes.json")
    );
}

#[test]
fn global_scope_ignores_an_empty_xdg_data_home() {
    let path = store_path(
        &host(&[("XDG_DATA_HOME", "")]),
        "notes",
        StoreScope::Global,
        None,
    );
    assert_eq!(
        path,
        PathBuf::from("/home/u/.local/share/ostia-rs/notes.json")
    );
}

#[test]
fn round_trips_data_through_save_json_then_load_json() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("sub").join("store.json");
    let data = json!({"hello": "world", "n": 42});
    save_json(&path, &data, SaveOptions::default()).unwrap();
    assert_eq!(load_json(&path), Some(data));
}

#[test]
fn creates_parent_directories_as_needed() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("deep/nested/dir/store.json");
    save_json(&path, &json!({"a": 1}), SaveOptions::default()).unwrap();
    assert!(path.exists());
}

fn listing(dir: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

#[test]
fn leaves_no_temp_file_behind_after_an_atomic_write() {
    let dir = tempdir().unwrap();
    save_json(
        &dir.path().join("store.json"),
        &json!({"a": 1}),
        SaveOptions::default(),
    )
    .unwrap();
    assert_eq!(listing(dir.path()), vec!["store.json".to_owned()]);
}

#[test]
fn removes_the_temp_file_when_the_rename_fails() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("store.json");
    fs::create_dir_all(path.join("occupied")).unwrap();
    assert!(save_json(&path, &json!({"a": 1}), SaveOptions::default()).is_err());
    assert_eq!(listing(dir.path()), vec!["store.json".to_owned()]);
}

#[tokio::test]
async fn an_async_secure_save_makes_the_file_0600_and_its_new_folder_0700() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("secure").join("store.json");
    save_json_async(&path, &json!({"a": 1}), SaveOptions::SECURE)
        .await
        .unwrap();
    assert_eq!(mode(&path), 0o600);
    assert_eq!(mode(path.parent().unwrap()), 0o700);
}

#[tokio::test]
async fn tightens_an_existing_secure_folder_before_the_store_is_written() {
    let dir = tempdir().unwrap();
    let folder = dir.path().join("secure");
    fs::create_dir_all(&folder).unwrap();
    fs::set_permissions(&folder, fs::Permissions::from_mode(0o755)).unwrap();
    save_json(
        &folder.join("sync.json"),
        &json!({"a": 1}),
        SaveOptions::SECURE,
    )
    .unwrap();
    assert_eq!(mode(&folder), 0o700);
    fs::set_permissions(&folder, fs::Permissions::from_mode(0o755)).unwrap();
    save_json_async(
        &folder.join("async.json"),
        &json!({"a": 1}),
        SaveOptions::SECURE,
    )
    .await
    .unwrap();
    assert_eq!(mode(&folder), 0o700);
}

#[tokio::test]
async fn leaves_valid_json_from_one_of_two_concurrent_writes_to_the_same_store() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("store.json");
    let first = json!({"fill": "a".repeat(1 << 20)});
    let second = json!({"fill": "b".repeat(1 << 20)});
    let (one, two) = tokio::join!(
        save_json_async(&path, &first, SaveOptions::SECURE),
        save_json_async(&path, &second, SaveOptions::SECURE)
    );
    one.unwrap();
    two.unwrap();
    let stored = load_json(&path).unwrap();
    assert!(stored == first || stored == second);
    assert_eq!(listing(dir.path()), vec!["store.json".to_owned()]);
}

#[test]
fn loads_a_symlinked_store_replaced_by_a_save_as_the_new_data() {
    let dir = tempdir().unwrap();
    let target = dir.path().join("target.txt");
    let path = dir.path().join("store.json");
    fs::write(&target, "untouched").unwrap();
    symlink(&target, &path).unwrap();
    save_json(&path, &json!({"a": 1}), SaveOptions::default()).unwrap();
    assert_eq!(load_json(&path), Some(json!({"a": 1})));
    assert_eq!(fs::read_to_string(&target).unwrap(), "untouched");
}
