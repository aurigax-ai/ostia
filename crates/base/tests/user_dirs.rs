#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use ostia_base::APP_DIR_NAME;
use ostia_base::host::{Host, Platform};
use ostia_base::user_dirs::{
    DirMove, MoveHooks, MoveResult, move_old_dir, old_app_running, old_dir_moves, preview_old_dir,
    project_dir_moves, saved_workspace_folders,
};
use tempfile::{TempDir, tempdir};

fn home() -> (TempDir, PathBuf) {
    let dir = tempdir().unwrap();
    let real = fs::canonicalize(dir.path()).unwrap();
    (dir, real)
}

fn host(home: &Path, env: &[(&str, PathBuf)]) -> Host {
    Host {
        env: env
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.display().to_string()))
            .collect::<BTreeMap<_, _>>(),
        home: home.to_path_buf(),
        cwd: home.to_path_buf(),
        platform: Platform::Linux,
    }
}

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn write_mode(path: &Path, text: &str, mode: u32) {
    write(path, text);
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap()
}

fn mv(from: &Path, to: &Path) -> DirMove {
    DirMove {
        from: from.to_path_buf(),
        to: to.to_path_buf(),
        leave: Vec::new(),
        drop: Vec::new(),
    }
}

fn strings(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| (*part).to_owned()).collect()
}

fn result(moved: &[&str], replaced: &[&str]) -> MoveResult {
    MoveResult {
        moved: strings(moved),
        replaced: strings(replaced),
    }
}

fn pairs(moves: &[DirMove]) -> Vec<(PathBuf, PathBuf)> {
    moves
        .iter()
        .map(|m| (m.from.clone(), m.to.clone()))
        .collect()
}

#[test]
fn names_only_the_ostia_folders_honouring_xdg_config_home_and_xdg_data_home() {
    let (_guard, home) = home();
    let plain = host(&home, &[]);
    assert_eq!(
        plain.app_config_dir(),
        home.join(".config").join(APP_DIR_NAME)
    );
    assert_eq!(
        plain.app_data_dir(),
        home.join(".local/share").join(APP_DIR_NAME)
    );
    let set = host(
        &home,
        &[
            ("XDG_CONFIG_HOME", home.join("cfg")),
            ("XDG_DATA_HOME", home.join("data")),
        ],
    );
    assert_eq!(set.app_config_dir(), home.join("cfg").join(APP_DIR_NAME));
    assert_eq!(set.app_data_dir(), home.join("data").join(APP_DIR_NAME));
}

#[test]
fn finds_nothing_when_no_pine_folder_exists() {
    let (_guard, home) = home();
    assert_eq!(
        old_dir_moves(&home.join(".config"), false, &host(&home, &[])),
        Vec::new()
    );
}

#[test]
fn finds_the_pine_config_and_data_folders_and_folds_chromium_user_data_into_config_on_linux() {
    let (_guard, home) = home();
    write(&home.join(".config/pine/settings.json"), "{}");
    write(&home.join(".local/share/pine/workspaces.json"), "{}");
    let moves = old_dir_moves(&home.join(".config"), false, &host(&home, &[]));
    assert_eq!(
        pairs(&moves),
        vec![
            (
                home.join(".config/pine"),
                home.join(".config").join(APP_DIR_NAME)
            ),
            (
                home.join(".local/share/pine"),
                home.join(".local/share").join(APP_DIR_NAME)
            ),
        ]
    );
    assert!(moves[0].drop.contains(&"GPUCache".to_owned()));
    assert_eq!(moves[1].leave, strings(&["app"]));
}

#[test]
fn adds_a_separate_user_data_folder_where_it_is_not_the_config_folder_as_on_macos() {
    let (_guard, home) = home();
    let app_data = home.join("Library/Application Support");
    write(&app_data.join("pine/Local Storage/x"), "x");
    let moves = old_dir_moves(&app_data, false, &host(&home, &[]));
    assert_eq!(
        pairs(&moves),
        vec![(app_data.join("pine"), app_data.join(APP_DIR_NAME))]
    );
}

#[test]
fn skips_a_data_folder_that_holds_only_the_installed_app_and_user_data_under_user_data_dir() {
    let (_guard, home) = home();
    fs::create_dir_all(home.join(".local/share/pine/app")).unwrap();
    write(&home.join(".config/pine/GPUCache/x"), "x");
    assert_eq!(
        old_dir_moves(&home.join(".config"), false, &host(&home, &[])),
        Vec::new()
    );
    fs::remove_dir_all(home.join(".config/pine")).unwrap();
    write(&home.join("Library/pine/Cookies"), "c");
    assert_eq!(
        old_dir_moves(&home.join("Library"), true, &host(&home, &[])),
        Vec::new()
    );
}

#[test]
fn says_the_old_app_is_running_while_its_single_instance_lock_is_there() {
    let (_guard, home) = home();
    let from = home.join(".config/pine");
    write(&from.join("settings.json"), "{}");
    let moves = [mv(&from, &home.join(".config/ostia"))];
    assert!(!old_app_running(&moves));
    write(&from.join("SingletonLock"), "");
    assert!(old_app_running(&moves));
}

#[test]
fn says_the_old_app_is_running_for_a_lock_that_is_a_dangling_symlink() {
    let (_guard, home) = home();
    let from = home.join(".config/pine");
    fs::create_dir_all(&from).unwrap();
    std::os::unix::fs::symlink("12345", from.join("SingletonLock")).unwrap();
    assert!(old_app_running(&[mv(&from, &home.join(".config/ostia"))]));
}

#[test]
fn moves_every_entry_keeps_file_modes_and_deletes_the_old_folder() {
    let (_guard, home) = home();
    let from = home.join(".local/share/pine");
    let to = home.join(".local/share/ostia");
    write(&from.join("workspaces.json"), "{\"w\":1}");
    write_mode(&from.join("vault.json"), "{\"K\":\"cipher\"}", 0o600);
    write(&from.join("scrollback/pane-1.txt"), "history");

    let outcome = move_old_dir(&mv(&from, &to), MoveHooks::default()).unwrap();

    assert_eq!(
        outcome,
        result(&["scrollback", "vault.json", "workspaces.json"], &[])
    );
    assert_eq!(read(&to.join("workspaces.json")), "{\"w\":1}");
    assert_eq!(read(&to.join("scrollback/pane-1.txt")), "history");
    assert_eq!(
        fs::metadata(to.join("vault.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert!(!from.exists());
}

#[test]
fn keeps_what_ostia_already_has_and_deletes_the_old_copy_of_it() {
    let (_guard, home) = home();
    let from = home.join(".config/pine");
    let to = home.join(".config/ostia");
    write(&from.join("settings.json"), "old");
    write(&from.join("views/a.json"), "{}");
    write(&to.join("settings.json"), "new");

    assert_eq!(
        preview_old_dir(&mv(&from, &to)),
        result(&["views"], &["settings.json"])
    );
    assert_eq!(read(&from.join("settings.json")), "old");

    assert_eq!(
        move_old_dir(&mv(&from, &to), MoveHooks::default()).unwrap(),
        result(&["views"], &["settings.json"])
    );
    assert_eq!(read(&to.join("settings.json")), "new");
    assert!(to.join("views/a.json").exists());
    assert!(!from.exists());
}

#[test]
fn drops_chromium_caches_leaves_the_installed_app_and_renames_the_shared_browser_profile() {
    let (_guard, home) = home();
    let from = home.join(".config/pine");
    let to = home.join(".config/ostia");
    write(&from.join("GPUCache/data"), "cache");
    write(&from.join("Partitions/pine-browser/Cookies"), "logins");
    write(&from.join("Partitions/other/Cookies"), "other");
    write(&to.join("Partitions/other/Cookies"), "kept");
    fs::create_dir(from.join("app")).unwrap();

    let outcome = move_old_dir(
        &DirMove {
            leave: strings(&["app"]),
            drop: strings(&["GPUCache"]),
            ..mv(&from, &to)
        },
        MoveHooks::default(),
    )
    .unwrap();

    assert_eq!(
        outcome,
        result(&["Partitions/pine-browser"], &["Partitions/other"])
    );
    assert_eq!(read(&to.join("Partitions/ostia-browser/Cookies")), "logins");
    assert_eq!(read(&to.join("Partitions/other/Cookies")), "kept");
    assert!(!to.join("GPUCache").exists());
    let left: Vec<_> = fs::read_dir(&from)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(left, strings(&["app"]));
}

#[test]
fn copies_then_deletes_when_the_folders_are_on_different_filesystems() {
    let (_guard, home) = home();
    let from = home.join(".local/share/pine");
    let to = home.join(".local/share/ostia");
    write(&from.join("notes/a.md"), "note");
    let cross_device = |_: &Path, _: &Path| Err(io::Error::from_raw_os_error(libc::EXDEV));

    let outcome = move_old_dir(
        &mv(&from, &to),
        MoveHooks {
            rename: Some(Box::new(cross_device)),
        },
    )
    .unwrap();

    assert_eq!(outcome.moved, strings(&["notes"]));
    assert_eq!(read(&to.join("notes/a.md")), "note");
    assert!(!from.exists());
}

#[test]
fn stops_and_keeps_the_rest_in_the_old_folder_when_a_rename_fails_for_another_reason() {
    let (_guard, home) = home();
    let from = home.join(".local/share/pine");
    let to = home.join(".local/share/ostia");
    write(&from.join("a.json"), "a");
    let denied = |_: &Path, _: &Path| Err(io::Error::from(io::ErrorKind::PermissionDenied));
    let outcome = move_old_dir(
        &mv(&from, &to),
        MoveHooks {
            rename: Some(Box::new(denied)),
        },
    );
    assert!(outcome.is_err());
    assert_eq!(read(&from.join("a.json")), "a");
}

#[test]
fn leaves_an_old_folder_that_still_holds_an_entry_it_was_told_to_leave() {
    let (_guard, home) = home();
    let from = home.join(".local/share/pine");
    let to = home.join(".local/share/ostia");
    write(&from.join("a.json"), "a");
    fs::create_dir(from.join("app")).unwrap();
    move_old_dir(
        &DirMove {
            leave: strings(&["app"]),
            ..mv(&from, &to)
        },
        MoveHooks::default(),
    )
    .unwrap();
    assert!(from.join("app").is_dir());
    assert!(!from.join("a.json").exists());
}

#[test]
fn reads_the_workspace_folders_saved_by_either_version_expanding_tilde() {
    let (_guard, home) = home();
    write(
        &home.join("old.json"),
        r#"{"workspaces":[{"workDir":"~/code/a"},{"workDir":"~"},{"workDir":3}]}"#,
    );
    write(
        &home.join("new.json"),
        r#"{"workspaces":[{"workDir":"~/code/a"}]}"#,
    );
    assert_eq!(
        saved_workspace_folders(
            &[
                home.join("old.json"),
                home.join("new.json"),
                home.join("none")
            ],
            &home
        ),
        vec![home.join("code/a"), home.clone()]
    );
}

#[test]
fn skips_a_saved_file_that_is_not_json_has_no_workspace_list_or_has_empty_work_dirs() {
    let (_guard, home) = home();
    write(&home.join("bad.json"), "{nope");
    write(
        &home.join("nolist.json"),
        r#"{"workspaces":{"workDir":"/x"}}"#,
    );
    write(
        &home.join("empty.json"),
        r#"{"workspaces":[{"workDir":""},null,{"other":1},{"workDir":"/kept"}]}"#,
    );
    assert_eq!(
        saved_workspace_folders(
            &[
                home.join("bad.json"),
                home.join("nolist.json"),
                home.join("empty.json")
            ],
            &home
        ),
        vec![PathBuf::from("/kept")]
    );
}

#[test]
fn offers_to_move_a_project_pine_folder_to_ostia_only_where_one_holds_something() {
    let (_guard, home) = home();
    write(&home.join("a/.pine/vault.json"), "{}");
    fs::create_dir_all(home.join("b/.pine")).unwrap();
    fs::create_dir_all(home.join("c")).unwrap();
    assert_eq!(
        project_dir_moves(&[home.join("a"), home.join("b"), home.join("c")]),
        vec![DirMove {
            from: home.join("a/.pine"),
            to: home.join("a/.ostia"),
            leave: Vec::new(),
            drop: Vec::new(),
        }]
    );
}
