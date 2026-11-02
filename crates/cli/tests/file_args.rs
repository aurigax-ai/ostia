#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::{Path, PathBuf};

use ostia_cli::common::file_args::{
    FileProbe, OpenTarget, diff_refusal_line, open_target, parse_file_arg, refusal_line,
    reveal_refusal_line,
};
use ostia_contract::open_files::{FileTarget, OpenFileError};

fn probe(files: &[&str], dirs: &[&str]) -> FileProbe {
    let files: Vec<PathBuf> = files.iter().map(PathBuf::from).collect();
    let dirs: Vec<PathBuf> = dirs.iter().map(PathBuf::from).collect();
    FileProbe {
        cwd: PathBuf::from("/w/project"),
        home: PathBuf::from("/home/u"),
        is_file: Box::new(move |path: &Path| files.iter().any(|file| file == path)),
        is_dir: Some(Box::new(move |path: &Path| {
            dirs.iter().any(|dir| dir == path)
        })),
    }
}

fn target(path: &str, line: Option<u64>, column: Option<u64>) -> FileTarget {
    FileTarget {
        path: PathBuf::from(path),
        line,
        column,
    }
}

#[test]
fn resolves_a_relative_path_against_the_caller_folder_and_tilde_against_home() {
    let p = probe(&[], &[]);
    assert_eq!(
        parse_file_arg("src/a.ts", &p),
        target("/w/project/src/a.ts", None, None)
    );
    assert_eq!(parse_file_arg("../b.ts", &p), target("/w/b.ts", None, None));
    assert_eq!(
        parse_file_arg("/var/log/x.log", &p),
        target("/var/log/x.log", None, None)
    );
    assert_eq!(
        parse_file_arg("~/todo.md", &p),
        target("/home/u/todo.md", None, None)
    );
}

#[test]
fn splits_file_line_and_file_line_col_off_a_path() {
    let p = probe(&["/w/project/a.ts"], &[]);
    assert_eq!(
        parse_file_arg("a.ts:12", &p),
        target("/w/project/a.ts", Some(12), None)
    );
    assert_eq!(
        parse_file_arg("a.ts:12:4", &p),
        target("/w/project/a.ts", Some(12), Some(4))
    );
    assert_eq!(
        parse_file_arg("/tmp/b.ts:3", &p),
        target("/tmp/b.ts", Some(3), None)
    );
}

#[test]
fn keeps_a_colon_that_belongs_to_an_existing_file_name() {
    let p = probe(&["/w/project/log:2"], &[]);
    assert_eq!(
        parse_file_arg("log:2", &p),
        target("/w/project/log:2", None, None)
    );
    assert_eq!(
        parse_file_arg("a.ts:0", &p),
        target("/w/project/a.ts:0", None, None)
    );
}

#[test]
fn drops_a_column_of_zero_and_resolves_home_in_the_path_before_the_position() {
    let p = probe(&[], &[]);
    assert_eq!(
        parse_file_arg("a.ts:12:0", &p),
        target("/w/project/a.ts", Some(12), None)
    );
    assert_eq!(
        parse_file_arg("~/a.ts:3:2", &p),
        target("/home/u/a.ts", Some(3), Some(2))
    );
}

#[test]
fn keeps_a_word_without_digits_after_the_colon_as_a_plain_path() {
    let p = probe(&[], &[]);
    assert_eq!(
        parse_file_arg("a.ts:x", &p),
        target("/w/project/a.ts:x", None, None)
    );
    assert_eq!(
        parse_file_arg("a.ts:1.5", &p),
        target("/w/project/a.ts:1.5", None, None)
    );
}

#[test]
fn names_the_path_and_the_reason() {
    assert_eq!(
        refusal_line("/tmp/dir", OpenFileError::Directory),
        "ostia: /tmp/dir: is a directory"
    );
    assert!(refusal_line("/etc/x", OpenFileError::OutsideSandbox).contains("sandboxed workspace"));
}

#[test]
fn gives_every_open_error_its_own_reason() {
    for (error, reason) in [
        (OpenFileError::NotFound, "no such file"),
        (OpenFileError::Directory, "is a directory"),
        (OpenFileError::NotAFile, "not a regular file"),
        (OpenFileError::Unreadable, "permission denied"),
        (
            OpenFileError::OutsideSandbox,
            "outside what a sandboxed workspace may open",
        ),
    ] {
        assert_eq!(
            refusal_line("/p", error),
            format!("ostia: /p: {reason}"),
            "{error:?}"
        );
    }
}

#[test]
fn sorts_each_word_into_a_url_stdin_a_folder_or_a_file() {
    let p = probe(
        &["/w/project/a.ts"],
        &["/w/project", "/w/project/src", "/home/u"],
    );
    assert_eq!(
        open_target("https://example.com/x?y=1", &p),
        OpenTarget::Url("https://example.com/x?y=1".to_owned())
    );
    assert_eq!(open_target("-", &p), OpenTarget::Stdin);
    assert_eq!(
        open_target(".", &p),
        OpenTarget::Folder(PathBuf::from("/w/project"))
    );
    assert_eq!(
        open_target("src", &p),
        OpenTarget::Folder(PathBuf::from("/w/project/src"))
    );
    assert_eq!(
        open_target("~", &p),
        OpenTarget::Folder(PathBuf::from("/home/u"))
    );
    assert_eq!(
        open_target("a.ts:3:2", &p),
        OpenTarget::File(target("/w/project/a.ts", Some(3), Some(2)))
    );
    assert_eq!(
        open_target("example.com", &p),
        OpenTarget::File(target("/w/project/example.com", None, None))
    );
    assert_eq!(
        open_target("missing", &p),
        OpenTarget::File(target("/w/project/missing", None, None))
    );
}

#[test]
fn names_the_folder_and_why_it_was_not_shown() {
    assert_eq!(
        reveal_refusal_line("/srv/x", "outside-home", None),
        "ostia: /srv/x: folders show only under the home folder"
    );
    assert_eq!(
        reveal_refusal_line("/home/u/x", "not-found", None),
        "ostia: /home/u/x: no such folder"
    );
    assert_eq!(
        reveal_refusal_line("/home/u/x", "command-failed", Some("no window")),
        "ostia: /home/u/x: no window"
    );
}

#[test]
fn reveal_refusal_covers_every_known_reason_and_falls_back_to_the_code() {
    for (error, reason) in [
        ("outside-home", "folders show only under the home folder"),
        ("not-found", "no such folder"),
        ("not-a-directory", "not a folder"),
        (
            "outside-sandbox",
            "a sandboxed workspace cannot show folders",
        ),
        ("odd-code", "odd-code"),
    ] {
        assert_eq!(
            reveal_refusal_line("/p", error, None),
            format!("ostia: /p: {reason}"),
            "{error}"
        );
    }
    assert_eq!(
        reveal_refusal_line("/p", "not-found", Some("ignored")),
        "ostia: /p: no such folder"
    );
}

#[test]
fn names_the_side_a_diff_could_not_read() {
    assert_eq!(
        diff_refusal_line(Some("/a/x.bin"), "binary", None),
        "ostia diff: /a/x.bin: is not a text file"
    );
    assert_eq!(
        diff_refusal_line(Some("/a/x"), "not-found", None),
        "ostia diff: /a/x: no such file"
    );
    assert_eq!(
        diff_refusal_line(None, "invalid-args", Some("expected two files")),
        "ostia diff: expected two files"
    );
}

#[test]
fn diff_refusal_covers_the_open_reasons_the_diff_only_reasons_and_the_fallbacks() {
    for (error, reason) in [
        ("directory", "is a directory"),
        ("not-a-file", "not a regular file"),
        ("unreadable", "permission denied"),
        (
            "outside-sandbox",
            "outside what a sandboxed workspace may open",
        ),
        ("too-large", "is too large to compare"),
        ("odd-code", "odd-code"),
    ] {
        assert_eq!(
            diff_refusal_line(Some("/p"), error, None),
            format!("ostia diff: /p: {reason}"),
            "{error}"
        );
    }
    assert_eq!(
        diff_refusal_line(None, "odd-code", None),
        "ostia diff: odd-code"
    );
}

#[test]
fn opens_the_file_for_a_line_or_column_too_large_for_a_number() {
    let p = probe(&[], &[]);
    assert_eq!(
        parse_file_arg("f.ts:99999999999999999999", &p),
        target("/w/project/f.ts", Some(u64::MAX), None)
    );
    assert_eq!(
        parse_file_arg("f.ts:3:99999999999999999999", &p),
        target("/w/project/f.ts", Some(3), Some(u64::MAX))
    );
}
