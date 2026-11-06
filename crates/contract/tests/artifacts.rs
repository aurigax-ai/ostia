#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use indexmap::IndexMap;
use ostia_contract::artifacts::{
    ArtifactChange, ArtifactChangeKind, ArtifactEntry, PAD_MAX_BYTES, artifact_changes,
    changed_artifacts, exceeds_pad, is_inside, is_pad_path,
};

fn entry(name: &str, modified: i64) -> ArtifactEntry {
    ArtifactEntry {
        name: name.to_owned(),
        path: format!("/a/{name}"),
        size: 1,
        modified,
    }
}

fn times(rows: &[(&str, i64)]) -> IndexMap<String, i64> {
    rows.iter()
        .map(|(path, modified)| ((*path).to_owned(), *modified))
        .collect()
}

fn change(path: &str, kind: ArtifactChangeKind) -> ArtifactChange {
    ArtifactChange {
        path: path.to_owned(),
        change: kind,
    }
}

#[test]
fn names_files_that_are_new_or_newer_than_last_seen() {
    let before = [entry("a.md", 10), entry("b.md", 10)];
    let after = [entry("a.md", 10), entry("b.md", 11), entry("c.md", 5)];
    assert_eq!(changed_artifacts(&before, &after), ["/a/b.md", "/a/c.md"]);
}

#[test]
fn names_nothing_when_a_file_only_went_away() {
    let before = [entry("a.md", 10), entry("b.md", 10)];
    let after = [entry("a.md", 10)];
    assert!(changed_artifacts(&before, &after).is_empty());
}

#[test]
fn is_true_only_below_the_folder() {
    assert!(is_inside(Some("/a/w1"), Some("/a/w1/report.md")));
    assert!(!is_inside(Some("/a/w1"), Some("/a/w1")));
    assert!(!is_inside(Some("/a/w1"), Some("/a/w10/report.md")));
    assert!(!is_inside(None, Some("/a/w1/report.md")));
    assert!(!is_inside(Some("/a/w1"), None));
}

#[test]
fn is_false_for_an_empty_folder_or_path() {
    assert!(!is_inside(Some(""), Some("/x")));
    assert!(!is_inside(Some("/a/w1"), Some("")));
    assert!(is_inside(Some("/a/w1"), Some("/a/w1/")));
}

#[test]
fn is_over_its_cap_by_bytes_not_characters() {
    assert!(!exceeds_pad(&"x".repeat(PAD_MAX_BYTES)));
    assert!(exceeds_pad(&"x".repeat(PAD_MAX_BYTES + 1)));
    assert!(!exceeds_pad(&"字".repeat(PAD_MAX_BYTES / 3)));
    assert!(exceeds_pad(&"字".repeat(PAD_MAX_BYTES / 3 + 1)));
}

#[test]
fn counts_a_four_byte_character_as_four_bytes() {
    assert!(!exceeds_pad(&"😀".repeat(PAD_MAX_BYTES / 4)));
    assert!(exceeds_pad(&"😀".repeat(PAD_MAX_BYTES / 4 + 1)));
}

#[test]
fn is_one_exact_path_of_the_listing() {
    let pad = Some("/a/w1/PAD.md");
    assert!(is_pad_path(pad, Some("/a/w1/PAD.md")));
    assert!(!is_pad_path(pad, Some("/a/w1/page/PAD.md")));
    assert!(!is_pad_path(None, Some("/a/w1/PAD.md")));
    assert!(!is_pad_path(pad, None));
}

#[test]
fn names_each_path_once_as_added_changed_or_removed() {
    let before = times(&[("a.md", 10), ("b.md", 10), ("gone.md", 10)]);
    let after = times(&[("a.md", 10), ("b.md", 12), ("new/c.html", 5)]);
    assert_eq!(
        artifact_changes(&before, &after),
        [
            change("b.md", ArtifactChangeKind::Changed),
            change("new/c.html", ArtifactChangeKind::Added),
            change("gone.md", ArtifactChangeKind::Removed),
        ]
    );
    assert!(artifact_changes(&after, &after).is_empty());
}

#[test]
fn does_not_name_a_file_that_got_older() {
    let before = times(&[("a.md", 10)]);
    let after = times(&[("a.md", 9)]);
    assert!(artifact_changes(&before, &after).is_empty());
}
