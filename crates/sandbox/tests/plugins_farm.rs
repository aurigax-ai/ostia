#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use ostia_sandbox::plugins_farm::{ensure_plugins_farm, link_plugins_farm};
use tempfile::TempDir;

struct Layout {
    _root: TempDir,
    source: PathBuf,
    farm: PathBuf,
    data: PathBuf,
}

fn layout() -> Layout {
    let root = TempDir::new().unwrap();
    let source = root.path().join("plugins");
    let farm = root.path().join("farm");
    let data = root.path().join("data");
    fs::create_dir_all(source.join("data/codex")).unwrap();
    fs::create_dir(source.join("cache")).unwrap();
    fs::write(source.join("installed_plugins.json"), "{}").unwrap();
    Layout {
        _root: root,
        source,
        farm,
        data,
    }
}

fn names(dir: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn links_every_real_entry_except_data_and_points_data_at_a_folder_of_its_own() {
    let l = layout();
    link_plugins_farm(&l.farm, &l.data, &l.source).unwrap();
    assert_eq!(
        fs::read_link(l.farm.join("cache")).unwrap(),
        l.source.join("cache")
    );
    assert_eq!(
        fs::read_link(l.farm.join("installed_plugins.json")).unwrap(),
        l.source.join("installed_plugins.json")
    );
    assert_eq!(fs::read_link(l.farm.join("data")).unwrap(), l.data);
    assert!(names(&l.data).is_empty());
    assert_eq!(
        fs::symlink_metadata(&l.farm).unwrap().permissions().mode() & 0o777,
        0o700
    );
}

#[test]
fn follows_the_real_folder_on_the_next_call_and_keeps_the_data_the_sandbox_wrote() {
    let l = layout();
    link_plugins_farm(&l.farm, &l.data, &l.source).unwrap();
    fs::write(l.data.join("state.json"), "{}").unwrap();
    fs::create_dir(l.source.join("marketplaces")).unwrap();
    fs::remove_dir_all(l.source.join("cache")).unwrap();
    link_plugins_farm(&l.farm, &l.data, &l.source).unwrap();
    assert!(l.farm.join("marketplaces").exists());
    assert!(fs::symlink_metadata(l.farm.join("cache")).is_err());
    assert!(l.data.join("state.json").exists());
}

#[test]
fn makes_only_the_data_link_when_the_real_plugins_folder_does_not_exist() {
    let l = layout();
    let missing = l.source.parent().unwrap().join("missing");
    link_plugins_farm(&l.farm, &l.data, &missing).unwrap();
    assert_eq!(names(&l.farm), vec!["data"]);
}

#[test]
fn creates_the_data_folder_and_the_farm_with_mode_0700_and_links_data() {
    let l = layout();
    ensure_plugins_farm(&l.farm, &l.data).unwrap();
    assert_eq!(
        fs::metadata(&l.data).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(&l.farm).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(fs::read_link(l.farm.join("data")).unwrap(), l.data);
    assert_eq!(names(&l.farm), vec!["data"]);
}

#[test]
fn replaces_a_data_entry_that_is_not_the_right_link_and_keeps_a_right_link() {
    let l = layout();
    fs::create_dir_all(l.farm.join("data/inner")).unwrap();
    ensure_plugins_farm(&l.farm, &l.data).unwrap();
    assert_eq!(fs::read_link(l.farm.join("data")).unwrap(), l.data);
    fs::write(l.data.join("keep"), "1").unwrap();
    ensure_plugins_farm(&l.farm, &l.data).unwrap();
    assert_eq!(fs::read_link(l.farm.join("data")).unwrap(), l.data);
    assert!(l.data.join("keep").exists());
}

#[test]
fn replaces_a_link_that_points_elsewhere_and_a_plain_file_in_the_way() {
    let l = layout();
    fs::create_dir_all(&l.farm).unwrap();
    std::os::unix::fs::symlink("/nowhere", l.farm.join("cache")).unwrap();
    fs::write(l.farm.join("installed_plugins.json"), "plain").unwrap();
    link_plugins_farm(&l.farm, &l.data, &l.source).unwrap();
    assert_eq!(
        fs::read_link(l.farm.join("cache")).unwrap(),
        l.source.join("cache")
    );
    assert_eq!(
        fs::read_link(l.farm.join("installed_plugins.json")).unwrap(),
        l.source.join("installed_plugins.json")
    );
}

#[test]
fn never_links_the_data_entry_of_the_real_folder() {
    let l = layout();
    link_plugins_farm(&l.farm, &l.data, &l.source).unwrap();
    assert_ne!(
        fs::read_link(l.farm.join("data")).unwrap(),
        l.source.join("data")
    );
}
