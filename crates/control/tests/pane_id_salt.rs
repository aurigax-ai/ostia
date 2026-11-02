#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use ostia_control::pane_id_salt::load_pane_id_salt;
use serde_json::Value;
use tempfile::TempDir;

fn salt_file() -> (TempDir, PathBuf) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("pane-id-salt.json");
    (dir, path)
}

#[test]
fn creates_a_32_byte_salt_once_and_returns_the_same_one_on_the_next_launch() {
    let (_dir, path) = salt_file();
    let first = load_pane_id_salt(&path);
    let second = load_pane_id_salt(&path);

    assert_eq!(first.len(), 32);
    assert_eq!(second, first);
    let stored: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(stored["salt"], Value::String(hex::encode(&first)));
}

#[test]
fn keeps_the_salt_file_private_to_the_user() {
    let (_dir, path) = salt_file();
    load_pane_id_salt(&path);
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn replaces_a_damaged_salt_file_with_a_new_salt() {
    let (_dir, path) = salt_file();
    std::fs::write(&path, r#"{"salt":"not-hex"}"#).unwrap();
    let salt = load_pane_id_salt(&path);

    assert_eq!(salt.len(), 32);
    assert_eq!(load_pane_id_salt(&path), salt);
}
