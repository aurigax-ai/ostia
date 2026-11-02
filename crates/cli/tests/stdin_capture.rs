#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::io;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use chrono::{NaiveDate, NaiveDateTime};
use futures_util::stream::{self, Stream};
use ostia_cli::common::stdin_capture::{
    CaptureInput, NO_ARTIFACT_FOLDER, STDIN_MAX_BYTES, TTY_NOTICE, capture_stdin,
    default_stdin_name, read_capped, stdin_file_name,
};
use tempfile::TempDir;

fn now() -> NaiveDateTime {
    NaiveDate::from_ymd_opt(2026, 10, 8)
        .unwrap()
        .and_hms_opt(9, 5, 7)
        .unwrap()
}

fn chunks(parts: &[&[u8]]) -> impl Stream<Item = io::Result<Vec<u8>>> + use<> {
    stream::iter(
        parts
            .iter()
            .map(|part| Ok(part.to_vec()))
            .collect::<Vec<_>>(),
    )
}

fn names(dir: &Path) -> Vec<String> {
    let mut found: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    found.sort();
    found
}

async fn capture(
    dir: Option<&Path>,
    name: Option<&str>,
    input: &[&[u8]],
    max: Option<usize>,
) -> Result<PathBuf, String> {
    capture_stdin(CaptureInput {
        dir,
        name,
        stream: chunks(input),
        now: now(),
        max,
    })
    .await
}

async fn capture_named(dir: &Path, name: &str) -> Result<PathBuf, String> {
    capture(Some(dir), Some(name), &[b"hello\n"], None).await
}

#[test]
fn names_an_unnamed_capture_by_its_time() {
    assert_eq!(default_stdin_name(now()), "stdin-20261008-090507.txt");
    assert_eq!(
        stdin_file_name(None, now()).unwrap(),
        "stdin-20261008-090507.txt"
    );
}

#[test]
fn pads_every_part_of_the_time_to_two_digits() {
    let early = NaiveDate::from_ymd_opt(2026, 1, 2)
        .unwrap()
        .and_hms_opt(0, 0, 0)
        .unwrap();
    assert_eq!(default_stdin_name(early), "stdin-20260102-000000.txt");
    let late = NaiveDate::from_ymd_opt(2026, 12, 31)
        .unwrap()
        .and_hms_opt(23, 59, 59)
        .unwrap();
    assert_eq!(default_stdin_name(late), "stdin-20261231-235959.txt");
}

#[test]
fn takes_a_plain_file_name_which_also_picks_the_viewer() {
    assert_eq!(
        stdin_file_name(Some("change.diff"), now()).unwrap(),
        "change.diff"
    );
    assert_eq!(
        stdin_file_name(Some("plan v2.md"), now()).unwrap(),
        "plan v2.md"
    );
}

#[test]
fn refuses_a_path_a_leading_dot_an_empty_or_an_overlong_name() {
    let long = "x".repeat(201);
    let names = [
        "a/b.md",
        "../b.md",
        "/tmp/b.md",
        "a\\b.md",
        ".env",
        "..",
        "",
        long.as_str(),
    ];
    for name in names {
        assert!(stdin_file_name(Some(name), now()).is_err(), "{name:?}");
    }
}

#[test]
fn gives_each_refusal_its_own_message() {
    let long = "x".repeat(201);
    let table = [
        ("a/b.md", "ostia: --name is a file name, not a path"),
        ("a\\b.md", "ostia: --name is a file name, not a path"),
        ("a\0b", "ostia: --name is a file name, not a path"),
        (".env", "ostia: --name cannot start with a dot"),
        ("..", "ostia: --name cannot start with a dot"),
        ("", "ostia: --name must be 1 to 200 characters"),
        (long.as_str(), "ostia: --name must be 1 to 200 characters"),
    ];
    for (name, message) in table {
        assert_eq!(
            stdin_file_name(Some(name), now()).unwrap_err(),
            message,
            "{name:?}"
        );
    }
}

#[test]
fn counts_the_name_length_in_utf16_units() {
    assert!(stdin_file_name(Some(&"x".repeat(200)), now()).is_ok());
    assert!(stdin_file_name(Some(&"é".repeat(200)), now()).is_ok());
    assert!(stdin_file_name(Some(&"😀".repeat(100)), now()).is_ok());
    assert_eq!(
        stdin_file_name(Some(&"😀".repeat(101)), now()).unwrap_err(),
        "ostia: --name must be 1 to 200 characters"
    );
}

#[test]
fn keeps_a_dot_that_is_not_the_first_character() {
    assert_eq!(stdin_file_name(Some("a.b"), now()).unwrap(), "a.b");
    assert_eq!(stdin_file_name(Some("a."), now()).unwrap(), "a.");
}

#[tokio::test]
async fn joins_the_chunks_of_a_stream_within_the_cap() {
    let out = read_capped(chunks(&[b"ab", b"cd", b"e"]), 5).await.unwrap();
    assert_eq!(out.as_deref(), Some(&b"abcde"[..]));
}

#[tokio::test]
async fn gives_nothing_once_the_stream_is_over_the_cap() {
    assert_eq!(
        read_capped(chunks(&[&[0; 3], &[0; 3]]), 5).await.unwrap(),
        None
    );
}

#[tokio::test]
async fn takes_a_stream_that_ends_exactly_on_the_cap_and_an_empty_stream() {
    let out = read_capped(chunks(&[b"abc", b"de"]), 5).await.unwrap();
    assert_eq!(out.as_deref(), Some(&b"abcde"[..]));
    let empty = read_capped(chunks(&[]), 5).await.unwrap();
    assert_eq!(empty.as_deref(), Some(&b""[..]));
}

#[tokio::test]
async fn passes_a_stream_failure_on_as_an_io_error() {
    let failing = stream::iter(vec![
        Ok(b"ab".to_vec()),
        Err(io::Error::other("pipe broke")),
    ]);
    assert_eq!(
        read_capped(failing, 5).await.unwrap_err().to_string(),
        "pipe broke"
    );
}

#[test]
fn caps_at_16_mib() {
    assert_eq!(STDIN_MAX_BYTES, 16 * 1024 * 1024);
}

#[test]
fn tells_the_user_how_to_end_input_from_the_terminal() {
    assert_eq!(
        TTY_NOTICE,
        "ostia: reading from the terminal; end with Ctrl+D"
    );
    assert_eq!(NO_ARTIFACT_FOLDER, "ostia: stdin needs an artifact folder");
}

#[tokio::test]
async fn writes_stdin_as_a_private_regular_file_in_the_artifact_folder() {
    let dir = TempDir::new().unwrap();
    let path = capture_named(dir.path(), "report.md").await.unwrap();
    assert_eq!(path, dir.path().join("report.md"));
    assert_eq!(fs::read_to_string(&path).unwrap(), "hello\n");
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[tokio::test]
async fn names_the_file_by_its_time_when_no_name_is_given() {
    let dir = TempDir::new().unwrap();
    let path = capture(Some(dir.path()), None, &[b"x"], None)
        .await
        .unwrap();
    assert_eq!(path, dir.path().join("stdin-20261008-090507.txt"));
}

#[tokio::test]
async fn never_overwrites_a_second_capture_of_the_same_name_gets_a_number() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("report.md"), "first").unwrap();
    fs::write(dir.path().join("PAD.md"), "the pad").unwrap();
    assert_eq!(
        capture_named(dir.path(), "report.md").await.unwrap(),
        dir.path().join("report-2.md")
    );
    assert_eq!(
        capture_named(dir.path(), "PAD.md").await.unwrap(),
        dir.path().join("PAD-2.md")
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("report.md")).unwrap(),
        "first"
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("PAD.md")).unwrap(),
        "the pad"
    );
}

#[tokio::test]
async fn counts_up_past_every_taken_number() {
    let dir = TempDir::new().unwrap();
    let first = capture_named(dir.path(), "report.md").await.unwrap();
    let second = capture_named(dir.path(), "report.md").await.unwrap();
    let third = capture_named(dir.path(), "report.md").await.unwrap();
    assert_eq!(first, dir.path().join("report.md"));
    assert_eq!(second, dir.path().join("report-2.md"));
    assert_eq!(third, dir.path().join("report-3.md"));
}

#[tokio::test]
async fn puts_the_number_before_the_last_extension_only() {
    let table = [
        ("notes", "notes-2"),
        ("archive.tar.gz", "archive.tar-2.gz"),
        ("a.", "a-2."),
        ("a.b.c", "a.b-2.c"),
    ];
    for (name, numbered) in table {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(name), "taken").unwrap();
        assert_eq!(
            capture_named(dir.path(), name).await.unwrap(),
            dir.path().join(numbered),
            "{name}"
        );
    }
}

#[tokio::test]
async fn never_follows_a_link_that_has_the_wanted_name() {
    let dir = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    let target = outside.path().join("target.txt");
    fs::write(&target, "outside").unwrap();
    symlink(&target, dir.path().join("report.md")).unwrap();
    symlink(
        outside.path().join("nothing"),
        dir.path().join("dangling.md"),
    )
    .unwrap();
    assert_eq!(
        capture_named(dir.path(), "report.md").await.unwrap(),
        dir.path().join("report-2.md")
    );
    assert_eq!(
        capture_named(dir.path(), "dangling.md").await.unwrap(),
        dir.path().join("dangling-2.md")
    );
    assert_eq!(fs::read_to_string(&target).unwrap(), "outside");
    assert!(!outside.path().join("nothing").exists());
}

#[tokio::test]
async fn needs_an_artifact_folder_and_never_falls_back_to_another_place() {
    let dir = TempDir::new().unwrap();
    assert_eq!(
        capture(None, Some("a.md"), &[b"x"], None).await,
        Err(NO_ARTIFACT_FOLDER.to_owned())
    );
    assert_eq!(
        capture(
            Some(&dir.path().join("missing")),
            Some("a.md"),
            &[b"x"],
            None
        )
        .await,
        Err(NO_ARTIFACT_FOLDER.to_owned())
    );
    let file = dir.path().join("a-file");
    fs::write(&file, "").unwrap();
    assert_eq!(
        capture(Some(&file), Some("a.md"), &[b"x"], None).await,
        Err(NO_ARTIFACT_FOLDER.to_owned())
    );
}

#[tokio::test]
async fn refuses_a_link_to_a_folder_as_the_artifact_folder() {
    let real = TempDir::new().unwrap();
    let holder = TempDir::new().unwrap();
    let link = holder.path().join("artifacts");
    symlink(real.path(), &link).unwrap();
    assert_eq!(
        capture(Some(&link), Some("a.md"), &[b"x"], None).await,
        Err(NO_ARTIFACT_FOLDER.to_owned())
    );
    assert_eq!(names(real.path()), Vec::<String>::new());
}

#[tokio::test]
async fn writes_nothing_when_stdin_is_over_the_cap() {
    let dir = TempDir::new().unwrap();
    let res = capture(Some(dir.path()), None, &[&[0; 11]], Some(10)).await;
    assert!(res.is_err());
    assert_eq!(names(dir.path()), Vec::<String>::new());
}

#[tokio::test]
async fn names_the_cap_in_whole_mebibytes_in_its_message() {
    let dir = TempDir::new().unwrap();
    assert_eq!(
        capture(Some(dir.path()), None, &[&[0; 11]], Some(10)).await,
        Err("ostia: stdin is over 0 MiB; nothing was written".to_owned())
    );
    let three = 3 * 1024 * 1024;
    assert_eq!(
        capture(Some(dir.path()), None, &[&vec![0; three + 1]], Some(three)).await,
        Err("ostia: stdin is over 3 MiB; nothing was written".to_owned())
    );
    assert_eq!(names(dir.path()), Vec::<String>::new());
}

#[tokio::test]
async fn takes_stdin_that_is_exactly_the_cap() {
    let dir = TempDir::new().unwrap();
    let path = capture(Some(dir.path()), Some("a.bin"), &[&[7; 10]], Some(10))
        .await
        .unwrap();
    assert_eq!(fs::read(path).unwrap(), vec![7; 10]);
}

#[tokio::test]
async fn writes_an_empty_file_for_empty_stdin() {
    let dir = TempDir::new().unwrap();
    let path = capture(Some(dir.path()), Some("a.md"), &[], None)
        .await
        .unwrap();
    assert_eq!(fs::read(path).unwrap(), Vec::<u8>::new());
}

#[tokio::test]
async fn writes_nothing_for_a_bad_name_without_reading_stdin() {
    let dir = TempDir::new().unwrap();
    let read = AtomicBool::new(false);
    let stream = stream::once(async {
        read.store(true, Ordering::SeqCst);
        Ok::<Vec<u8>, io::Error>(b"x".to_vec())
    });
    let res = capture_stdin(CaptureInput {
        dir: Some(dir.path()),
        name: Some("../escape.md"),
        stream,
        now: now(),
        max: None,
    })
    .await;
    assert_eq!(
        res,
        Err("ostia: --name is a file name, not a path".to_owned())
    );
    assert!(!read.load(Ordering::SeqCst));
    assert_eq!(names(dir.path()), Vec::<String>::new());
}

#[tokio::test]
async fn checks_the_name_before_the_folder() {
    assert_eq!(
        capture(None, Some("../escape.md"), &[b"x"], None).await,
        Err("ostia: --name is a file name, not a path".to_owned())
    );
}

#[tokio::test]
async fn checks_the_folder_before_it_reads_stdin() {
    let read = AtomicBool::new(false);
    let stream = stream::once(async {
        read.store(true, Ordering::SeqCst);
        Ok::<Vec<u8>, io::Error>(b"x".to_vec())
    });
    let res = capture_stdin(CaptureInput {
        dir: None,
        name: Some("a.md"),
        stream,
        now: now(),
        max: None,
    })
    .await;
    assert_eq!(res, Err(NO_ARTIFACT_FOLDER.to_owned()));
    assert!(!read.load(Ordering::SeqCst));
}
