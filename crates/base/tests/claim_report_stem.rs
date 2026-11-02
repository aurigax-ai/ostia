#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::PermissionsExt;

use ostia_base::claim_report_stem::claim_report_stem;
use tempfile::tempdir;

fn names(dir: &std::path::Path) -> Vec<String> {
    let mut found: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    found.sort();
    found
}

#[test]
fn reserves_the_stem_it_names_by_creating_its_report_file() {
    let dir = tempdir().unwrap();
    let stem = claim_report_stem(dir.path(), |_| "capture-1".to_owned()).unwrap();
    assert_eq!(stem, dir.path().join("capture-1"));
    assert_eq!(names(dir.path()), vec!["capture-1.md".to_owned()]);
}

#[test]
fn asks_again_when_another_process_took_the_stem_between_listing_and_creating() {
    let dir = tempdir().unwrap();
    let mut seen: Vec<Vec<String>> = Vec::new();
    let stem = claim_report_stem(dir.path(), |listed| {
        seen.push(listed.to_vec());
        if seen.len() == 1 {
            fs::write(dir.path().join("capture-1.md"), "theirs").unwrap();
        }
        let taken = listed.iter().filter(|name| name.ends_with(".md")).count();
        format!("capture-{}", taken + 1)
    })
    .unwrap();
    assert_eq!(stem, dir.path().join("capture-2"));
    assert_eq!(seen.len(), 2);
    assert_eq!(
        fs::read_to_string(dir.path().join("capture-1.md")).unwrap(),
        "theirs"
    );
}

#[test]
fn lets_any_other_failure_through() {
    let dir = tempdir().unwrap();
    assert!(claim_report_stem(&dir.path().join("missing"), |_| "capture-1".to_owned()).is_err());
}

#[test]
fn creates_an_empty_report_file_only_the_owner_can_use() {
    let dir = tempdir().unwrap();
    claim_report_stem(dir.path(), |_| "capture-1".to_owned()).unwrap();
    let file = dir.path().join("capture-1.md");
    assert_eq!(fs::read(&file).unwrap(), b"");
    assert_eq!(
        fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn passes_the_names_in_the_folder_to_the_namer() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("a.txt"), "").unwrap();
    fs::write(dir.path().join("b.md"), "").unwrap();
    let mut listed = Vec::new();
    claim_report_stem(dir.path(), |names| {
        listed = names.to_vec();
        "c".to_owned()
    })
    .unwrap();
    listed.sort();
    assert_eq!(listed, vec!["a.txt".to_owned(), "b.md".to_owned()]);
}
