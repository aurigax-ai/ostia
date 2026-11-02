#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::path::Path;

use ostia_sync::app_version::{packaged_build_info_path, read_build_info};
use support::write;
use tempfile::TempDir;

#[test]
fn reads_the_version_and_build_time_of_a_stamp() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("build-info.json");
    write(
        &path,
        r#"{"version":"1.2.3+sha.abc","builtAt":"2026-10-07T00:00:00Z","server":"https://s.example"}"#,
    );
    let info = read_build_info(&path).unwrap();
    assert_eq!(info.version, "1.2.3+sha.abc");
    assert_eq!(info.built_at, "2026-10-07T00:00:00Z");
    assert_eq!(info.server.as_deref(), Some("https://s.example"));
}

#[test]
fn reads_nothing_from_a_missing_file_a_broken_file_or_a_stamp_of_the_wrong_shape() {
    let dir = TempDir::new().unwrap();
    assert_eq!(read_build_info(&dir.path().join("missing.json")), None);
    for (name, text) in [
        ("empty", ""),
        ("half", r#"{"version":"1.0.0","buil"#),
        ("array", "[]"),
        ("no-time", r#"{"version":"1.0.0"}"#),
        ("number", r#"{"version":1,"builtAt":"x"}"#),
    ] {
        let path = dir.path().join(format!("{name}.json"));
        write(&path, text);
        assert_eq!(read_build_info(&path), None, "{name}");
    }
}

#[test]
fn finds_the_packaged_stamp_in_the_resources_folder() {
    assert_eq!(
        packaged_build_info_path(Path::new("/opt/ostia/resources")),
        Path::new("/opt/ostia/resources/build-info.json")
    );
}
