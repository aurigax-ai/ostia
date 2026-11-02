#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;

use ostia_base::clock::Clock;
use ostia_base::settings_file::SettingsFiles;
use serde_json::json;
use tempfile::{TempDir, tempdir};

fn fixed(ms: i64) -> Clock {
    Arc::new(move || ms)
}

fn files() -> (TempDir, SettingsFiles) {
    let dir = tempdir().unwrap();
    let files = SettingsFiles::new(dir.path().to_path_buf());
    (dir, files)
}

fn names(dir: &std::path::Path) -> Vec<String> {
    let mut found: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    found.sort();
    found
}

#[test]
fn moves_a_corrupt_settings_json_aside_with_mode_0600_and_writes_fresh_defaults() {
    let (dir, files) = files();
    let file = dir.path().join("settings.json");
    fs::write(&file, "{ \"terminal\": ").unwrap();
    files.recover_corrupt_settings(&fixed(42));
    let copy = dir.path().join("settings.json.corrupt-42");
    assert_eq!(fs::read_to_string(&copy).unwrap(), "{ \"terminal\": ");
    assert_eq!(
        fs::metadata(&copy).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(files.read_settings_file(), json!({}));
    assert_eq!(fs::read_to_string(&file).unwrap(), "{}\n");
    assert_eq!(files.recovered_settings_copy(), Some(copy));
}

#[test]
fn treats_json_that_is_not_an_object_as_corrupt() {
    let (dir, files) = files();
    fs::write(dir.path().join("settings.json"), "[1]").unwrap();
    files.recover_corrupt_settings(&fixed(7));
    assert_eq!(
        names(dir.path()),
        vec![
            "settings.json".to_owned(),
            "settings.json.corrupt-7".to_owned()
        ]
    );
}

#[test]
fn leaves_a_valid_file_alone() {
    let (dir, files) = files();
    fs::write(dir.path().join("settings.json"), "{\"locale\":\"en\"}").unwrap();
    files.recover_corrupt_settings(&fixed(1));
    assert_eq!(names(dir.path()), vec!["settings.json".to_owned()]);
    assert_eq!(
        fs::read_to_string(dir.path().join("settings.json")).unwrap(),
        "{\"locale\":\"en\"}"
    );
    assert_eq!(files.recovered_settings_copy(), None);
}

#[test]
fn leaves_a_missing_or_empty_file_alone() {
    let (dir, files) = files();
    files.recover_corrupt_settings(&fixed(1));
    fs::write(dir.path().join("settings.json"), "  ").unwrap();
    files.recover_corrupt_settings(&fixed(2));
    assert_eq!(names(dir.path()), vec!["settings.json".to_owned()]);
}

#[test]
fn reads_defaults_for_a_missing_or_broken_settings_file() {
    let (dir, files) = files();
    assert_eq!(files.read_settings_file(), json!({}));
    fs::write(dir.path().join("settings.json"), "{nope").unwrap();
    assert_eq!(files.read_settings_file(), json!({}));
}

#[test]
fn reads_the_settings_of_a_valid_file() {
    let (dir, files) = files();
    fs::write(
        dir.path().join("settings.json"),
        "{\"locale\":\"zh-TW\",\"terminal\":{\"shell\":\"/bin/zsh\"}}",
    )
    .unwrap();
    assert_eq!(
        files.read_settings_file(),
        json!({"locale": "zh-TW", "terminal": {"shell": "/bin/zsh"}})
    );
}

#[test]
fn tells_a_missing_file_from_a_broken_one() {
    let (dir, files) = files();
    assert_eq!(files.read_settings_file_or_none(), Some(json!({})));
    fs::write(dir.path().join("settings.json"), "{nope").unwrap();
    assert_eq!(files.read_settings_file_or_none(), None);
    fs::write(dir.path().join("settings.json"), "3").unwrap();
    assert_eq!(files.read_settings_file_or_none(), None);
    fs::write(dir.path().join("settings.json"), "null").unwrap();
    assert_eq!(files.read_settings_file_or_none(), None);
    fs::write(dir.path().join("settings.json"), "{\"assistant\":{}}").unwrap();
    assert_eq!(
        files.read_settings_file_or_none(),
        Some(json!({"assistant": {}}))
    );
}

#[test]
fn reads_the_locale_only_when_it_is_a_string() {
    let (dir, files) = files();
    assert_eq!(files.read_locale(), None);
    fs::write(dir.path().join("settings.json"), "{\"locale\":\"fr\"}").unwrap();
    assert_eq!(files.read_locale().as_deref(), Some("fr"));
    fs::write(dir.path().join("settings.json"), "{\"locale\":3}").unwrap();
    assert_eq!(files.read_locale(), None);
}

#[test]
fn remembers_nothing_about_a_copy_until_one_was_made() {
    let (_dir, files) = files();
    assert_eq!(files.recovered_settings_copy(), None);
}
