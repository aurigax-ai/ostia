#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::PermissionsExt;

use ostia_base::clock::now_ms;
use ostia_terminal::kept_owner::{
    KeptOwner, current_owner, kept_owner_file, read_kept_owner, same_owner, write_kept_owner,
};
use tempfile::TempDir;

#[test]
fn names_this_process_and_the_time_it_started() {
    let owner = current_owner();
    assert_eq!(owner.pid, i64::from(std::process::id()));
    let now = now_ms();
    assert!(owner.started_at <= now);
    assert!(now - owner.started_at < 600_000);
}

#[test]
fn writes_the_owner_to_a_0600_file_next_to_the_socket_and_reads_it_back() {
    let dir = TempDir::new().unwrap();
    let file = kept_owner_file(dir.path(), "k");
    assert_eq!(file, dir.path().join("k.owner.json"));
    write_kept_owner(
        &file,
        &KeptOwner {
            pid: 42,
            started_at: 1000,
        },
    )
    .unwrap();
    assert_eq!(
        read_kept_owner(&file),
        Some(KeptOwner {
            pid: 42,
            started_at: 1000
        })
    );
    assert_eq!(
        fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let names: Vec<String> = fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(names, vec!["k.owner.json".to_owned()]);
}

#[test]
fn reads_a_missing_broken_or_partial_record_as_unknown() {
    let dir = TempDir::new().unwrap();
    let file = kept_owner_file(dir.path(), "k");
    assert_eq!(read_kept_owner(&file), None);
    for text in [
        "{\"pid\":",
        "{\"pid\":0,\"startedAt\":5}",
        "{\"pid\":\"12\",\"startedAt\":5}",
        "null",
    ] {
        fs::write(&file, text).unwrap();
        assert_eq!(read_kept_owner(&file), None, "{text}");
    }
    assert!(!dir.path().join("k.owner.json.partial").exists());
}

#[test]
fn counts_the_owner_as_the_same_only_when_pid_and_start_time_both_match() {
    let owner = KeptOwner {
        pid: 7,
        started_at: 100,
    };
    assert!(same_owner(
        Some(&KeptOwner {
            pid: 7,
            started_at: 100
        }),
        &owner
    ));
    assert!(!same_owner(
        Some(&KeptOwner {
            pid: 8,
            started_at: 100
        }),
        &owner
    ));
    assert!(!same_owner(
        Some(&KeptOwner {
            pid: 7,
            started_at: 101
        }),
        &owner
    ));
    assert!(!same_owner(None, &owner));
}

#[test]
fn writes_the_record_as_one_json_object_with_pid_then_started_at() {
    let dir = TempDir::new().unwrap();
    let file = kept_owner_file(dir.path(), "k");
    write_kept_owner(
        &file,
        &KeptOwner {
            pid: 42,
            started_at: 1000,
        },
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        "{\"pid\":42,\"startedAt\":1000}"
    );
}

#[test]
fn refuses_to_write_when_the_folder_is_missing() {
    let dir = TempDir::new().unwrap();
    let file = kept_owner_file(&dir.path().join("missing"), "k");
    assert!(
        write_kept_owner(
            &file,
            &KeptOwner {
                pid: 1,
                started_at: 1
            }
        )
        .is_err()
    );
    assert!(!dir.path().join("missing").exists());
}

#[test]
fn reads_a_record_as_unknown_when_a_field_is_missing_negative_fractional_or_not_a_number() {
    let dir = TempDir::new().unwrap();
    let file = kept_owner_file(dir.path(), "k");
    for text in [
        "{\"pid\":5}",
        "{\"startedAt\":5}",
        "{\"pid\":-1,\"startedAt\":5}",
        "{\"pid\":5,\"startedAt\":-5}",
        "{\"pid\":1.5,\"startedAt\":5}",
        "{\"pid\":5,\"startedAt\":0}",
        "{\"pid\":5,\"startedAt\":null}",
        "[]",
        "\"text\"",
        "5",
    ] {
        fs::write(&file, text).unwrap();
        assert_eq!(read_kept_owner(&file), None, "{text}");
    }
}

#[test]
fn reads_a_whole_number_written_with_an_exponent_as_an_integer() {
    let dir = TempDir::new().unwrap();
    let file = kept_owner_file(dir.path(), "k");
    fs::write(&file, "{\"pid\":1e3,\"startedAt\":5.0}").unwrap();
    assert_eq!(
        read_kept_owner(&file),
        Some(KeptOwner {
            pid: 1000,
            started_at: 5
        })
    );
}

#[test]
fn ignores_extra_fields_in_the_record() {
    let dir = TempDir::new().unwrap();
    let file = kept_owner_file(dir.path(), "k");
    fs::write(&file, "{\"pid\":3,\"startedAt\":4,\"extra\":true}").unwrap();
    assert_eq!(
        read_kept_owner(&file),
        Some(KeptOwner {
            pid: 3,
            started_at: 4
        })
    );
}
