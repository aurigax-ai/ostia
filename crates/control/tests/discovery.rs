#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use ostia_base::APP_DIR_NAME;
use ostia_base::host::{Host, Platform};
use ostia_control::discovery::{
    clear_control_info, control_info_path, pane_control_socket, read_control_socket,
    write_control_info,
};
use tempfile::TempDir;

fn host_with(env: &[(&str, &str)]) -> Host {
    Host {
        env: env
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect::<BTreeMap<_, _>>(),
        home: PathBuf::from("/home/u"),
        cwd: PathBuf::from("/"),
        platform: Platform::Linux,
    }
}

fn touch(dir: &TempDir, name: &str) -> PathBuf {
    let path = dir.path().join(name);
    std::fs::write(&path, "").unwrap();
    path
}

#[test]
fn lives_in_the_app_data_folder() {
    let host = host_with(&[("XDG_DATA_HOME", "/data")]);
    assert_eq!(
        control_info_path(&host),
        PathBuf::from(format!("/data/{APP_DIR_NAME}/control.json"))
    );
}

#[test]
fn points_scripts_at_the_socket_of_the_running_app_privately() {
    let dir = TempDir::new().unwrap();
    let info = dir.path().join("control.json");
    let socket = touch(&dir, "ostia-1.sock");
    write_control_info(&info, &socket, 1);

    assert_eq!(read_control_socket(&info), Some(socket));
    assert_eq!(
        std::fs::metadata(&info).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn finds_nothing_when_the_socket_is_gone_or_the_file_is_missing() {
    let dir = TempDir::new().unwrap();
    let info = dir.path().join("control.json");
    assert_eq!(read_control_socket(&info), None);
    write_control_info(&info, &dir.path().join("gone.sock"), 1);
    assert_eq!(read_control_socket(&info), None);
}

#[test]
fn clears_the_file_only_for_its_own_socket() {
    let dir = TempDir::new().unwrap();
    let info = dir.path().join("control.json");
    let socket = touch(&dir, "a.sock");
    write_control_info(&info, &socket, 1);
    clear_control_info(&info, &dir.path().join("b.sock"));
    assert_eq!(read_control_socket(&info), Some(socket.clone()));
    clear_control_info(&info, &socket);
    assert_eq!(read_control_socket(&info), None);
}

#[test]
fn keeps_the_socket_a_pane_was_started_with_even_when_it_is_gone() {
    let dir = TempDir::new().unwrap();
    let info = dir.path().join("control.json");
    let current = touch(&dir, "ostia-2.sock");
    let moved = dir.path().join("kept-old.sock");
    write_control_info(&info, &current, 2);

    let moved_text = moved.to_str().unwrap();
    assert_eq!(
        pane_control_socket(Some(moved_text), false, &info),
        Some(moved.clone())
    );
    assert_eq!(
        pane_control_socket(Some(moved_text), true, &info),
        Some(moved)
    );
}

#[test]
fn finds_the_running_app_only_for_a_script_with_no_socket_of_its_own() {
    let dir = TempDir::new().unwrap();
    let info = dir.path().join("control.json");
    let gone = dir.path().join("gone.sock");
    assert_eq!(
        pane_control_socket(Some(gone.to_str().unwrap()), false, &info),
        Some(gone)
    );
    let current = touch(&dir, "ostia-3.sock");
    write_control_info(&info, &current, 3);
    assert_eq!(pane_control_socket(None, false, &info), None);
    assert_eq!(pane_control_socket(None, true, &info), Some(current));
}
