#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::path::PathBuf;

use ostia_extensions::extension_launches::ExtensionLaunches;
use serde_json::{Value, json};
use tempfile::TempDir;

fn file_in() -> (TempDir, PathBuf) {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("extension-launches.json");
    (dir, file)
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/rust")
        .join(name)
}

fn stored(file: &PathBuf) -> Value {
    serde_json::from_str(&fs::read_to_string(file).unwrap()).unwrap()
}

#[test]
fn keeps_the_ids_that_asked_to_start_with_the_window_across_a_reload() {
    let (_dir, file) = file_in();
    let launches = ExtensionLaunches::new(file.clone());
    launches.set("graphs", true).unwrap();
    launches.set("activity", true).unwrap();
    launches.set("activity", false).unwrap();
    assert_eq!(stored(&file), json!(["graphs"]));
    assert!(ExtensionLaunches::new(file.clone()).has("graphs"));
    assert!(!ExtensionLaunches::new(file).has("activity"));
}

#[test]
fn drops_what_is_not_an_extension_id() {
    let (_dir, file) = file_in();
    fs::write(&file, json!(["graphs", "../x", 7, "Bad"]).to_string()).unwrap();
    let launches = ExtensionLaunches::new(file);
    assert!(launches.has("graphs"));
    assert!(!launches.has("../x"));
    assert!(!launches.has("Bad"));
}

#[test]
fn accepts_only_ids_of_two_to_forty_lowercase_letters_digits_and_dashes() {
    let (_dir, file) = file_in();
    let launches = ExtensionLaunches::new(file);
    let forty = format!("a{}", "b".repeat(39));
    let forty_one = format!("a{}", "b".repeat(40));
    let rows = [
        ("a", false),
        ("ab", true),
        ("a-1", true),
        ("1ab", false),
        ("-ab", false),
        ("aB", false),
        ("a_b", false),
        ("ab\n", false),
        ("", false),
        (forty.as_str(), true),
        (forty_one.as_str(), false),
    ];
    for (id, valid) in rows {
        launches.set(id, true).unwrap();
        assert_eq!(launches.has(id), valid, "id {id:?}");
    }
}

#[test]
fn writes_nothing_when_the_change_is_a_no_op_or_the_id_is_refused() {
    let (_dir, file) = file_in();
    let launches = ExtensionLaunches::new(file.clone());
    launches.set("graphs", false).unwrap();
    launches.set("Bad", true).unwrap();
    launches.set("../x", false).unwrap();
    assert!(!file.exists());
    launches.set("graphs", true).unwrap();
    fs::remove_file(&file).unwrap();
    launches.set("graphs", true).unwrap();
    assert!(!file.exists());
}

#[test]
fn stops_adding_at_sixty_four_ids_and_still_removes() {
    let (_dir, file) = file_in();
    let launches = ExtensionLaunches::new(file.clone());
    for n in 0..70 {
        launches.set(&format!("ext-{n:02}"), true).unwrap();
    }
    assert_eq!(stored(&file).as_array().unwrap().len(), 64);
    assert!(launches.has("ext-63"));
    assert!(!launches.has("ext-64"));
    launches.set("ext-00", false).unwrap();
    launches.set("ext-64", true).unwrap();
    assert!(launches.has("ext-64"));
    assert!(!launches.has("ext-00"));
}

#[test]
fn reads_only_the_first_sixty_four_valid_entries_of_a_file_and_collapses_repeats() {
    let (_dir, file) = file_in();
    let mut ids: Vec<String> = (0..32).map(|n| format!("ext-{n:02}")).collect();
    ids.extend((0..32).map(|n| format!("ext-{n:02}")));
    ids.push("ext-40".to_owned());
    fs::write(&file, json!(ids).to_string()).unwrap();
    let launches = ExtensionLaunches::new(file.clone());
    assert!(launches.has("ext-31"));
    assert!(!launches.has("ext-40"));
    launches.set("ext-40", true).unwrap();
    assert!(launches.has("ext-40"));
    assert_eq!(stored(&file).as_array().unwrap().len(), 33);
}

#[test]
fn starts_empty_when_the_file_is_missing_corrupt_or_not_a_list() {
    let (_dir, file) = file_in();
    assert!(!ExtensionLaunches::new(file.clone()).has("graphs"));
    fs::write(&file, "not json").unwrap();
    assert!(!ExtensionLaunches::new(file.clone()).has("graphs"));
    fs::write(&file, json!({"graphs": true}).to_string()).unwrap();
    assert!(!ExtensionLaunches::new(file).has("graphs"));
}

#[test]
fn reads_a_file_the_ts_store_wrote_and_writes_the_same_bytes_as_the_ts_store() {
    let (_dir, file) = file_in();
    fs::copy(fixture("extension-launches-before.json"), &file).unwrap();
    let launches = ExtensionLaunches::new(file.clone());
    assert!(launches.has("graphs"));
    assert!(launches.has("activity"));
    assert!(launches.has("beta"));
    launches.set("activity", false).unwrap();
    assert_eq!(
        fs::read(&file).unwrap(),
        fs::read(fixture("extension-launches-after.json")).unwrap()
    );
}
