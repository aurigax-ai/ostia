#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_git::git::{BlameLine, CommitFile, CommitRef, CommitSummary, RefKind, is_uncommitted};
use ostia_git::history::{
    FIELD_SEP, RECORD_SEP, parse_blame_porcelain, parse_decorations, parse_graph_log, parse_log,
    parse_name_status,
};

const SHA1: &str = "96756f7f86aa09fd43994e6c7ea5b835674f9eb3";
const SHA2: &str = "1b0124329a747e3e811541c2010dfd25241f4c6d";

fn zero() -> String {
    "0".repeat(40)
}

fn record(fields: &[&str]) -> String {
    format!("{}{RECORD_SEP}\n", fields.join(FIELD_SEP))
}

fn summary(sha: &str, author: &str, email: &str, time: i64, subject: &str) -> CommitSummary {
    CommitSummary {
        sha: sha.to_owned(),
        author: author.to_owned(),
        email: email.to_owned(),
        time,
        subject: subject.to_owned(),
    }
}

fn file(path: &str, orig_path: Option<&str>, code: &str) -> CommitFile {
    CommitFile {
        path: path.to_owned(),
        orig_path: orig_path.map(str::to_owned),
        code: code.to_owned(),
    }
}

fn reference(kind: RefKind, name: &str, current: bool) -> CommitRef {
    CommitRef {
        kind,
        name: name.to_owned(),
        current,
    }
}

#[test]
fn reads_sha_author_email_time_and_subject_from_each_record() {
    let out = record(&[SHA1, "Ann Lee", "t@e.com", "1700003600", "second"])
        + &record(&[SHA2, "Ann Lee", "t@e.com", "1700000000", "first line"]);
    assert_eq!(
        parse_log(&out),
        vec![
            summary(SHA1, "Ann Lee", "t@e.com", 1_700_003_600, "second"),
            summary(SHA2, "Ann Lee", "t@e.com", 1_700_000_000, "first line"),
        ]
    );
}

#[test]
fn keeps_separators_free_subjects_intact_and_skips_malformed_records() {
    let out = format!(
        "{}garbage{RECORD_SEP}",
        record(&[SHA1, "A", "a@x", "1", "fix: a | b"])
    );
    let subjects: Vec<String> = parse_log(&out).into_iter().map(|c| c.subject).collect();
    assert_eq!(subjects, vec!["fix: a | b".to_owned()]);
}

#[test]
fn reads_added_deleted_and_renamed_files_from_z_output() {
    assert_eq!(
        parse_name_status("A\0a.txt\0"),
        vec![file("a.txt", None, "A")]
    );
    assert_eq!(
        parse_name_status("D\0a.txt\0A\0b.txt\0R087\0old name.txt\0new name.txt\0"),
        vec![
            file("a.txt", None, "D"),
            file("b.txt", None, "A"),
            file("new name.txt", Some("old name.txt"), "R"),
        ]
    );
}

fn porcelain() -> String {
    let zero = zero();
    [
        format!("{SHA1} 1 1 3"),
        "author Ann Lee".to_owned(),
        "author-mail <t@e.com>".to_owned(),
        "author-time 1700003600".to_owned(),
        "author-tz -0500".to_owned(),
        "committer Ann Lee".to_owned(),
        "summary second".to_owned(),
        "filename b.txt".to_owned(),
        "\tone".to_owned(),
        format!("{SHA1} 2 2"),
        "\tTWO".to_owned(),
        format!("{SHA1} 3 3"),
        "\t\tthree".to_owned(),
        format!("{zero} 4 4 1"),
        "author Not Committed Yet".to_owned(),
        "author-time 1790782170".to_owned(),
        "summary Version of b.txt from b.txt".to_owned(),
        format!("previous {SHA1} b.txt"),
        "filename b.txt".to_owned(),
        "\tfour".to_owned(),
        String::new(),
    ]
    .join("\n")
}

#[test]
fn gives_every_line_its_commit_reusing_headers_a_commit_printed_once() {
    let lines = parse_blame_porcelain(&porcelain());
    assert_eq!(lines.len(), 4);
    assert_eq!(
        lines[0],
        BlameLine {
            line: 1,
            sha: SHA1.to_owned(),
            author: "Ann Lee".to_owned(),
            time: 1_700_003_600,
            summary: "second".to_owned(),
            text: "one".to_owned(),
        }
    );
    assert_eq!(lines[1].line, 2);
    assert_eq!(lines[1].sha, SHA1);
    assert_eq!(lines[1].author, "Ann Lee");
    assert_eq!(lines[1].text, "TWO");
    assert_eq!(lines[2].text, "\tthree");
    assert_eq!(lines[3].line, 4);
    assert_eq!(lines[3].sha, zero());
    assert_eq!(lines[3].text, "four");
}

#[test]
fn recognizes_lines_that_are_not_committed_yet() {
    assert!(is_uncommitted(&zero()));
    assert!(!is_uncommitted(SHA1));
}

#[test]
fn reads_parents_refs_and_subjects_of_each_commit() {
    let sha3 = "a".repeat(40);
    let parents = format!("{SHA2} {sha3}");
    let out = record(&[
        SHA1,
        &parents,
        "Ann",
        "ann@x",
        "1700000000",
        "HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1",
        "merge feature",
    ]) + &record(&[
        SHA2,
        "",
        "Bob",
        "bob@x",
        "1690000000",
        "",
        "root, with commas",
    ]);
    let commits = parse_graph_log(&out);
    assert_eq!(commits.len(), 2);
    assert_eq!(commits[0].sha, SHA1);
    assert_eq!(commits[0].parents, vec![SHA2.to_owned(), sha3]);
    assert_eq!(commits[0].author, "Ann");
    assert_eq!(commits[0].time, 1_700_000_000);
    assert_eq!(commits[0].subject, "merge feature");
    assert_eq!(
        commits[0].refs,
        vec![
            reference(RefKind::Branch, "main", true),
            reference(RefKind::Remote, "origin/main", false),
            reference(RefKind::Tag, "v1", false),
        ]
    );
    assert!(commits[1].parents.is_empty());
    assert!(commits[1].refs.is_empty());
    assert_eq!(commits[1].subject, "root, with commas");
}

#[test]
fn marks_a_detached_head_and_orders_it_first() {
    assert_eq!(
        parse_decorations("refs/heads/topic, HEAD"),
        vec![
            reference(RefKind::Head, "HEAD", false),
            reference(RefKind::Branch, "topic", false),
        ]
    );
}
