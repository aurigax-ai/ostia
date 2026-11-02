#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::fs;
use std::path::{Path, PathBuf};

use ostia_contract::install_method::InstallMethod;
use ostia_contract::releases::UpdateChannel;
use ostia_sync::install_replace::PendingSweep;
use ostia_sync::update_wiring::{
    load_pending_sweep, pending_sweep_path, save_pending_sweep, update_dir,
};
use support::linux_host;
use tempfile::TempDir;

fn fixture(name: &str) -> Vec<u8> {
    fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../test/fixtures/rust")
            .join(name),
    )
    .unwrap()
}

fn pending() -> PendingSweep {
    PendingSweep {
        app_dir: PathBuf::from("/home/u/.local/share/ostia/app"),
        version: "0.6.0".to_owned(),
    }
}

#[test]
fn keeps_the_pending_sweep_in_install_replace_json_of_the_app_data_folder() {
    let host = linux_host(&[("XDG_DATA_HOME", "/data")]);
    assert_eq!(
        pending_sweep_path(&host),
        Path::new("/data/ostia-rs/install-replace.json")
    );
}

#[test]
fn writes_the_pending_sweep_and_its_clearing_with_the_bytes_the_ts_app_wrote() {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("install-replace.json");
    save_pending_sweep(&file, Some(&pending())).unwrap();
    assert_eq!(
        fs::read(&file).unwrap(),
        fixture("install-replace-pending.json")
    );
    save_pending_sweep(&file, None).unwrap();
    assert_eq!(
        fs::read(&file).unwrap(),
        fixture("install-replace-swept.json")
    );
}

#[test]
fn reads_a_pending_sweep_the_ts_app_wrote_and_nothing_from_a_cleared_or_missing_record() {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("install-replace.json");
    assert_eq!(load_pending_sweep(&file), None);
    fs::write(&file, fixture("install-replace-pending.json")).unwrap();
    assert_eq!(load_pending_sweep(&file), Some(pending()));
    fs::write(&file, fixture("install-replace-swept.json")).unwrap();
    assert_eq!(load_pending_sweep(&file), None);
}

#[test]
fn reads_nothing_from_a_record_with_the_wrong_shape() {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("install-replace.json");
    for (name, text) in [
        ("array", "[]"),
        ("no-version", r#"{"appDir":"/a"}"#),
        ("no-dir", r#"{"version":"1.0.0"}"#),
        ("numbers", r#"{"appDir":1,"version":2}"#),
        ("broken", r#"{"appDir":"/a","ver"#),
    ] {
        fs::write(&file, text).unwrap();
        assert_eq!(load_pending_sweep(&file), None, "{name}");
    }
}

#[test]
fn replaces_in_the_app_folder_only_where_the_install_method_and_channel_allow_it() {
    let dir = Some(PathBuf::from("/apps/ostia"));
    let table = [
        (InstallMethod::Tarball, UpdateChannel::Stable, true),
        (InstallMethod::Local, UpdateChannel::Main, true),
        (InstallMethod::Dmg, UpdateChannel::Stable, true),
        (InstallMethod::Brew, UpdateChannel::Stable, false),
        (InstallMethod::Brew, UpdateChannel::Beta, true),
        (InstallMethod::Apt, UpdateChannel::Stable, false),
        (InstallMethod::Dev, UpdateChannel::Main, false),
    ];
    for (method, channel, replaces) in table {
        assert_eq!(
            update_dir(method, channel, dir.clone()),
            replaces.then(|| PathBuf::from("/apps/ostia")),
            "{method:?} {channel:?}"
        );
    }
    assert_eq!(
        update_dir(InstallMethod::Tarball, UpdateChannel::Stable, None),
        None
    );
}
