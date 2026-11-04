use std::fs;
use std::os::unix::fs::symlink;

use tempfile::TempDir;

use super::{Existing, create_content, existing_text, open_regular, search_file, store_content};

#[test]
fn a_rewrite_lands_in_the_file_that_was_checked_not_in_a_link_placed_afterwards() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("a.txt");
    let target = dir.path().join("target.txt");
    let held = dir.path().join("held.txt");
    fs::write(&path, "old").unwrap();
    fs::write(&target, "secret").unwrap();
    let current = existing_text(&path, true);
    assert!(matches!(current, Existing::Text { .. }));
    fs::rename(&path, &held).unwrap();
    symlink(&target, &path).unwrap();
    store_content(current, &path, "new").unwrap();
    assert_eq!(fs::read_to_string(&target).unwrap(), "secret");
    assert_eq!(fs::read_to_string(&held).unwrap(), "new");
}

#[test]
fn a_create_does_not_follow_a_link_placed_at_the_new_path() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("a.txt");
    let target = dir.path().join("target.txt");
    fs::write(&target, "secret").unwrap();
    symlink(&target, &path).unwrap();
    assert!(create_content(&path, "new").is_err());
    assert_eq!(fs::read_to_string(&target).unwrap(), "secret");
}

#[test]
fn a_file_that_is_a_link_is_refused_for_an_edit() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("a.txt");
    let target = dir.path().join("target.txt");
    fs::write(&target, "secret").unwrap();
    symlink(&target, &path).unwrap();
    assert!(matches!(existing_text(&path, true), Existing::Refused(_)));
}

#[test]
fn a_read_opens_no_link() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("a.txt");
    let target = dir.path().join("target.txt");
    fs::write(&target, "secret").unwrap();
    symlink(&target, &path).unwrap();
    assert!(open_regular(&path).is_err());
}

#[test]
fn a_search_does_not_return_lines_of_a_file_that_became_a_link() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("x");
    let target = dir.path().join("key");
    fs::write(&target, "secret line").unwrap();
    symlink(&target, &path).unwrap();
    let mut found = Vec::new();
    assert!(search_file(&path, "secret", &mut found).is_err());
    assert!(found.is_empty());
}
