#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use ostia_base::APP_DIR_NAME;
use ostia_base::host::{Host, Platform};
use ostia_base::private_tmp::{private_run_dir, private_tmp_dir, socket_path};
use tempfile::tempdir;

fn host(root: &Path, platform: Platform, env: &[(&str, &str)]) -> Host {
    let mut vars: BTreeMap<String, String> = env
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    vars.insert("TMPDIR".to_owned(), root.join("tmp").display().to_string());
    fs::create_dir_all(root.join("tmp")).unwrap();
    Host {
        env: vars,
        home: root.join("home"),
        cwd: root.to_path_buf(),
        platform,
    }
}

fn uid_of(path: &Path) -> u32 {
    fs::metadata(path).unwrap().uid()
}

const LONG_DIR: &str = "/private/var/folders/36/tjdph2t965j8snz9_vkdnw0r0000gn/T/ostia-sbx-501/12345/ws-abcdef-12/xxxxxxxxxxxxxxxxxxxx";

#[test]
fn creates_a_per_user_directory_only_the_owner_can_access() {
    let root = tempdir().unwrap();
    let host = host(root.path(), Platform::Linux, &[]);
    let dir = private_tmp_dir(&host, "ostia-test-1").unwrap();
    let meta = fs::metadata(&dir).unwrap();
    assert!(meta.is_dir());
    assert!(
        dir.to_string_lossy()
            .ends_with(&format!("-{}", uid_of(root.path())))
    );
    assert_eq!(meta.mode() & 0o077, 0);
}

#[test]
fn is_idempotent() {
    let root = tempdir().unwrap();
    let host = host(root.path(), Platform::Linux, &[]);
    assert_eq!(
        private_tmp_dir(&host, "ostia-test-idem").unwrap(),
        private_tmp_dir(&host, "ostia-test-idem").unwrap()
    );
}

#[test]
fn resolves_outside_the_real_home_folder_while_tests_run() {
    let root = tempdir().unwrap();
    let host = host(root.path(), Platform::Linux, &[]);
    let dir = private_run_dir(&host, "isolation-check").unwrap();
    assert!(dir.starts_with(root.path().join("tmp")));
    assert!(
        !dir.starts_with(
            std::env::home_dir().unwrap_or_else(|| PathBuf::from("/nonexistent-home"))
        )
    );
}

#[test]
fn is_a_private_folder_in_the_app_data_folder_on_macos_which_dirhelper_does_not_clean() {
    let root = tempdir().unwrap();
    let host = host(root.path(), Platform::Darwin, &[]);
    let dir = private_run_dir(&host, "shell-integration").unwrap();
    assert_eq!(
        dir,
        host.home
            .join(".local")
            .join("share")
            .join(APP_DIR_NAME)
            .join("run")
            .join("shell-integration")
    );
    assert_eq!(fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
    let xdg = root.path().join("home").join("d");
    let host = self::host(
        root.path(),
        Platform::Darwin,
        &[("XDG_DATA_HOME", xdg.to_str().unwrap())],
    );
    assert_eq!(
        private_run_dir(&host, "kept").unwrap(),
        xdg.join(APP_DIR_NAME).join("run").join("kept")
    );
}

#[test]
fn throws_on_macos_when_the_app_data_folder_cannot_hold_the_run_folder() {
    let root = tempdir().unwrap();
    let xdg = root.path().join("home").join("d");
    fs::create_dir_all(xdg.join(APP_DIR_NAME)).unwrap();
    fs::write(xdg.join(APP_DIR_NAME).join("run"), "").unwrap();
    let host = host(
        root.path(),
        Platform::Darwin,
        &[("XDG_DATA_HOME", xdg.to_str().unwrap())],
    );
    assert!(private_run_dir(&host, "kept").is_err());
}

#[test]
fn stays_in_the_private_temp_folder_on_linux() {
    let root = tempdir().unwrap();
    let host = host(root.path(), Platform::Linux, &[]);
    assert_eq!(
        private_run_dir(&host, "shell-integration").unwrap(),
        private_tmp_dir(&host, &format!("{APP_DIR_NAME}-shell-integration")).unwrap()
    );
}

#[test]
fn refuses_a_private_folder_that_is_a_symlink() {
    let root = tempdir().unwrap();
    let host = host(root.path(), Platform::Linux, &[]);
    let target = root.path().join("elsewhere");
    fs::create_dir(&target).unwrap();
    let link = host
        .tmp_dir()
        .join(format!("ostia-link-{}", uid_of(root.path())));
    std::os::unix::fs::symlink(&target, &link).unwrap();
    assert!(private_tmp_dir(&host, "ostia-link").is_err());
}

#[test]
fn tightens_a_private_folder_that_is_wider_than_0700() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempdir().unwrap();
    let host = host(root.path(), Platform::Linux, &[]);
    let dir = private_tmp_dir(&host, "ostia-wide").unwrap();
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
    private_tmp_dir(&host, "ostia-wide").unwrap();
    assert_eq!(fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
}

#[test]
fn keeps_a_path_that_fits_where_it_was_asked_for() {
    assert_eq!(
        socket_path(Path::new("/tmp/a"), "ostia-1.sock", Platform::Darwin).unwrap(),
        PathBuf::from("/tmp/a/ostia-1.sock")
    );
}

#[test]
fn moves_a_path_past_the_macos_limit_to_a_short_owned_folder() {
    let path = socket_path(Path::new(LONG_DIR), "agent.sock", Platform::Darwin).unwrap();
    assert!(path.as_os_str().len() <= 103);
    assert!(path.to_string_lossy().ends_with(".sock"));
    assert_eq!(
        fs::metadata(path.parent().unwrap()).unwrap().mode() & 0o077,
        0
    );
}

#[test]
fn keeps_the_socket_name_in_the_short_name_so_its_owner_can_be_read() {
    let path = socket_path(Path::new(LONG_DIR), "ostia-4242.sock", Platform::Darwin).unwrap();
    let name = path.file_name().unwrap().to_string_lossy().into_owned();
    let (digest, rest) = name.split_at(16);
    assert!(
        digest
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
    );
    assert_eq!(rest, "-ostia-4242.sock");
}

#[test]
fn gives_different_long_paths_different_short_names_and_the_same_path_the_same_one() {
    let a = socket_path(Path::new(LONG_DIR), "a.sock", Platform::Darwin).unwrap();
    assert_eq!(
        socket_path(Path::new(LONG_DIR), "a.sock", Platform::Darwin).unwrap(),
        a
    );
    assert_ne!(
        socket_path(Path::new(LONG_DIR), "b.sock", Platform::Darwin).unwrap(),
        a
    );
}

#[test]
fn leaves_a_linux_path_alone_until_it_passes_107_bytes() {
    let name = format!("{}.sock", "x".repeat(80));
    assert_eq!(
        socket_path(Path::new("/run/user/1000"), &name, Platform::Linux).unwrap(),
        PathBuf::from(format!("/run/user/1000/{name}"))
    );
    let moved = socket_path(Path::new(LONG_DIR), "agent.sock", Platform::Linux).unwrap();
    assert!(moved.as_os_str().len() <= 107);
}

#[test]
fn moves_a_path_of_exactly_one_byte_past_the_limit_and_keeps_one_at_the_limit() {
    let at_limit = format!("{}{}", "/d/", "y".repeat(107 - 3));
    let (dir, name) = at_limit.rsplit_once('/').unwrap();
    assert_eq!(at_limit.len(), 107);
    assert_eq!(
        socket_path(Path::new(dir), name, Platform::Linux).unwrap(),
        PathBuf::from(&at_limit)
    );
    let over = format!("{at_limit}y");
    let (dir, name) = over.rsplit_once('/').unwrap();
    assert_ne!(
        socket_path(Path::new(dir), name, Platform::Linux).unwrap(),
        PathBuf::from(&over)
    );
}
