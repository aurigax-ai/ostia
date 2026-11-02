#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use ostia_terminal::mark_nonce::{is_mark_nonce, mark_nonce_file_for, write_mark_nonce};
use serde_json::{Value, json};
use tempfile::tempdir;

#[test]
fn names_the_nonce_file_after_the_state_file() {
    assert_eq!(
        mark_nonce_file_for("/run/ostia/pane.state"),
        PathBuf::from("/run/ostia/pane.state.mark")
    );
    assert_eq!(mark_nonce_file_for("state"), PathBuf::from("state.mark"));
}

#[test]
fn writes_a_nonce_of_32_lowercase_hex_digits_and_returns_the_same_text() {
    let dir = tempdir().unwrap();
    let file = dir.path().join("state.mark");
    let nonce = write_mark_nonce(&file).unwrap();
    assert_eq!(nonce.len(), 32);
    assert!(
        nonce
            .chars()
            .all(|ch| ch.is_ascii_digit() || ('a'..='f').contains(&ch))
    );
    assert_eq!(fs::read_to_string(&file).unwrap(), nonce);
}

#[test]
fn creates_the_file_readable_by_the_owner_only() {
    let dir = tempdir().unwrap();
    let file = dir.path().join("state.mark");
    write_mark_nonce(&file).unwrap();
    assert_eq!(
        fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn gives_a_new_nonce_each_time_and_replaces_the_old_text() {
    let dir = tempdir().unwrap();
    let file = dir.path().join("state.mark");
    let first = write_mark_nonce(&file).unwrap();
    let second = write_mark_nonce(&file).unwrap();
    assert_ne!(first, second);
    assert_eq!(fs::read_to_string(&file).unwrap(), second);
}

#[test]
fn fails_and_writes_nothing_when_the_folder_is_missing() {
    let dir = tempdir().unwrap();
    let file = dir.path().join("missing").join("state.mark");
    assert!(write_mark_nonce(&file).is_err());
    assert!(!dir.path().join("missing").exists());
}

#[test]
fn accepts_what_it_wrote() {
    let dir = tempdir().unwrap();
    let nonce = write_mark_nonce(&dir.path().join("state.mark")).unwrap();
    assert!(is_mark_nonce(&Value::String(nonce)));
}

#[test]
fn accepts_only_a_string_of_exactly_32_lowercase_hex_digits() {
    let good = "0123456789abcdef0123456789abcdef";
    let cases: Vec<(Value, bool)> = vec![
        (json!(good), true),
        (json!("0123456789ABCDEF0123456789abcdef"), false),
        (json!(&good[..31]), false),
        (json!(format!("{good}0")), false),
        (json!(format!("{good}\n")), false),
        (json!(format!("\n{good}")), false),
        (json!(format!(" {good}")), false),
        (json!("0123456789abcdef0123456789abcdeg"), false),
        (json!("０１２３４５６７８９abcdef0123456789abcdef"), false),
        (json!(""), false),
        (json!(12345), false),
        (json!(null), false),
        (json!(true), false),
        (json!([good]), false),
        (json!({"nonce": good}), false),
    ];
    for (raw, expected) in cases {
        assert_eq!(is_mark_nonce(&raw), expected, "{raw}");
    }
}
