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
    let ts_text = "{\n  \"v\": 1,\n  \"items\": [\n    {\n      \"z\": \"é\",\n      \"a\": 5\n    }\n  ],\n  \"empty\": [],\n  \"none\": {}\n}";
    fs::write(&file, ts_text).unwrap();
    let value = load_json(&file).unwrap();
    assert_eq!(value["items"][0]["a"], json!(5));
    save_json(&file, &value, SaveOptions::default()).unwrap();
    assert_eq!(fs::read_to_string(&file).unwrap(), ts_text);
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
