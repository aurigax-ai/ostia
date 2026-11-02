#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use ostia_agents::mail_flag::MailFlags;
use tempfile::TempDir;

fn counts<const N: usize>(entries: [(&str, usize); N]) -> HashMap<String, usize> {
    entries
        .into_iter()
        .map(|(id, count)| (id.to_owned(), count))
        .collect()
}

fn flag(path: &Path) -> (usize, u64) {
    let text = fs::read_to_string(path).unwrap();
    let body = text.strip_suffix('\n').unwrap();
    let (count, sequence) = body.split_once(':').unwrap();
    (count.parse().unwrap(), sequence.parse().unwrap())
}

#[test]
fn writes_a_0600_file_for_a_pane_whose_queued_count_changed_and_only_then() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("a.mail");
    let flags = MailFlags::new();
    flags.register("a", path.clone());
    flags.sync(&counts([]));
    assert!(path.exists());
    let first = fs::read_to_string(&path).unwrap();
    assert_eq!(flag(&path).0, 0);
    flags.sync(&counts([]));
    assert_eq!(fs::read_to_string(&path).unwrap(), first);
    flags.sync(&counts([("a", 2)]));
    assert_eq!(flag(&path).0, 2);
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn leaves_a_pane_that_was_not_registered_alone_and_removes_the_file_when_the_pane_is_forgotten() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("b.mail");
    let flags = MailFlags::new();
    flags.register("b", path.clone());
    flags.sync(&counts([("unknown", 3)]));
    assert_eq!(flag(&path).0, 0);
    assert!(!dir.path().join("unknown").exists());
    flags.forget("b");
    assert!(!path.exists());
    flags.sync(&counts([("b", 1)]));
    assert!(!path.exists());
}

#[test]
fn does_not_fail_when_the_folder_is_gone() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("missing").join("c.mail");
    let flags = MailFlags::new();
    flags.register("c", path.clone());
    flags.sync(&counts([("c", 1)]));
    assert!(path.exists());
}

#[test]
fn numbers_every_write_with_a_rising_sequence_across_panes() {
    let dir = TempDir::new().unwrap();
    let first = dir.path().join("1.mail");
    let second = dir.path().join("2.mail");
    let flags = MailFlags::new();
    flags.register("one", first.clone());
    flags.register("two", second.clone());
    flags.sync(&counts([("one", 1), ("two", 1)]));
    let (_, sequence_one) = flag(&first);
    let (_, sequence_two) = flag(&second);
    assert_ne!(sequence_one, sequence_two);
    flags.sync(&counts([("one", 2), ("two", 1)]));
    assert!(flag(&first).1 > sequence_one.max(sequence_two));
}

#[test]
fn writes_again_after_a_new_registration_even_when_the_count_is_the_same() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("d.mail");
    let flags = MailFlags::new();
    flags.register("d", path.clone());
    flags.sync(&counts([("d", 4)]));
    let (_, before) = flag(&path);
    flags.sync(&counts([("d", 4)]));
    assert_eq!(flag(&path).1, before);
    flags.register("d", path.clone());
    flags.sync(&counts([("d", 4)]));
    assert!(flag(&path).1 > before);
}

#[test]
fn tries_a_failed_write_again_on_the_next_sync() {
    let dir = TempDir::new().unwrap();
    let folder = dir.path().join("later");
    let path = folder.join("e.mail");
    fs::write(&folder, "").unwrap();
    let flags = MailFlags::new();
    flags.register("e", path.clone());
    flags.sync(&counts([("e", 0)]));
    assert!(!path.exists());
    fs::remove_file(&folder).unwrap();
    fs::create_dir(&folder).unwrap();
    flags.sync(&counts([("e", 0)]));
    assert_eq!(flag(&path).0, 0);
}
