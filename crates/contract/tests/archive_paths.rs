#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::archive_paths::{
    ArchivePath, archive_root, is_archive_path, parse_archive_path,
};

fn archive_path(archive: &str, entry: &str) -> ArchivePath {
    ArchivePath {
        archive: archive.to_owned(),
        entry: entry.to_owned(),
    }
}

#[test]
fn round_trips_an_archive_path_also_when_the_real_path_holds_bang_and_percent() {
    let real = "/home/u/a!b%20c/report.zip";
    let root = archive_root(real);
    assert_eq!(root, "archive:%2Fhome%2Fu%2Fa%21b%2520c%2Freport.zip!");
    assert_eq!(parse_archive_path(&root), Some(archive_path(real, "")));
    assert_eq!(
        parse_archive_path(&format!("{root}/data/a!.csv")),
        Some(archive_path(real, "data/a!.csv"))
    );
}

#[test]
fn refuses_anything_that_is_not_an_absolute_archive_path() {
    for path in [
        "archive:",
        "archive:%2Fa.zip",
        "archive:a.zip!",
        "archive:%2Fa.zip!x",
        "/a.zip",
    ] {
        assert_eq!(parse_archive_path(path), None, "{path}");
    }
    assert!(!is_archive_path(Some("/home/a.zip")));
    assert!(!is_archive_path(None));
}

#[test]
fn trims_leading_and_trailing_slashes_from_the_entry_and_refuses_a_bad_escape() {
    assert_eq!(
        parse_archive_path("archive:%2Fa.zip!//dir/sub//"),
        Some(archive_path("/a.zip", "dir/sub"))
    );
    assert_eq!(
        parse_archive_path("archive:%2Fa.zip!/"),
        Some(archive_path("/a.zip", ""))
    );
    assert_eq!(parse_archive_path("archive:!/x"), None);
    assert_eq!(parse_archive_path("archive:%E0%A4%A!/x"), None);
    assert!(is_archive_path(Some("archive:")));
}
