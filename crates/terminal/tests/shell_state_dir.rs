#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::os::unix::fs::MetadataExt;

use ostia_base::private_tmp::private_run_dir;
use ostia_base::process::current_uid;
use ostia_base::{APP_DIR_NAME, Host, Platform};
use ostia_terminal::shell_state_dir::shell_state_dir;
use tempfile::TempDir;

fn host(root: &TempDir, platform: Platform) -> Host {
    let tmp = root.path().join("tmp");
    std::fs::create_dir_all(&tmp).unwrap();
    Host {
        env: BTreeMap::from([("TMPDIR".to_owned(), tmp.to_str().unwrap().to_owned())]),
        home: root.path().join("home"),
        cwd: root.path().to_path_buf(),
        platform,
    }
}

#[test]
fn lives_in_the_app_data_folder_on_macos_which_dirhelper_does_not_reap() {
    let root = TempDir::new().unwrap();
    let host = host(&root, Platform::Darwin);
    assert_eq!(
        shell_state_dir(&host).unwrap(),
        host.home
            .join(".local")
            .join("share")
            .join(APP_DIR_NAME)
            .join("run")
            .join("shell-state")
    );
    assert_eq!(
        private_run_dir(&host, "codex").unwrap(),
        host.home
            .join(".local")
            .join("share")
            .join(APP_DIR_NAME)
            .join("run")
            .join("codex")
    );
}

#[test]
fn lives_in_a_private_temp_folder_owned_by_the_user_on_linux() {
    let root = TempDir::new().unwrap();
    let host = host(&root, Platform::Linux);
    let dir = shell_state_dir(&host).unwrap();
    assert_eq!(
        dir,
        root.path()
            .join("tmp")
            .join(format!("{APP_DIR_NAME}-shell-state-{}", current_uid()))
    );
    let meta = std::fs::metadata(&dir).unwrap();
    assert_eq!(meta.mode() & 0o777, 0o700);
}
