#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::path::PathBuf;

use ostia_base::host::{Host, Platform};
use ostia_base::{APP_DIR_NAME, Error};
use tempfile::TempDir;

fn host(home: &TempDir, platform: Platform, env: &[(&str, &str)]) -> Host {
    Host {
        env: env
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect::<BTreeMap<_, _>>(),
        home: home.path().to_path_buf(),
        cwd: home.path().to_path_buf(),
        platform,
    }
}

#[test]
fn the_config_folder_of_linux_follows_xdg_config_home() {
    let home = TempDir::new().unwrap();
    assert_eq!(
        host(&home, Platform::Linux, &[]).app_config_dir(),
        home.path().join(".config").join(APP_DIR_NAME)
    );
    assert_eq!(
        host(&home, Platform::Linux, &[("XDG_CONFIG_HOME", "/x/cfg")]).app_config_dir(),
        PathBuf::from("/x/cfg").join(APP_DIR_NAME)
    );
}

#[test]
fn the_config_folder_of_macos_is_application_support_and_ignores_xdg() {
    let home = TempDir::new().unwrap();
    let expected = home
        .path()
        .join("Library")
        .join("Application Support")
        .join(APP_DIR_NAME);
    assert_eq!(
        host(&home, Platform::Darwin, &[("XDG_CONFIG_HOME", "/x/cfg")]).app_config_dir(),
        expected
    );
}

#[test]
fn a_fresh_install_gets_its_config_folder() {
    let home = TempDir::new().unwrap();
    let host = host(&home, Platform::Linux, &[]);
    assert!(!host.app_config_dir().exists());
    let dir = host.ensure_app_config_dir().unwrap();
    assert!(dir.is_dir());
    assert_eq!(host.ensure_app_config_dir().unwrap(), dir);
}

#[test]
fn the_config_folder_fails_when_a_file_is_in_the_way() {
    let home = TempDir::new().unwrap();
    let host = host(&home, Platform::Linux, &[]);
    std::fs::write(home.path().join(".config"), "x").unwrap();
    assert!(matches!(
        host.ensure_app_config_dir(),
        Err(Error::Io { .. })
    ));
}
