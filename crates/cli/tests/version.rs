#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use ostia_cli::common::version::{build_info_path_at, build_version_at};
use serde_json::{Value, json};
use tempfile::TempDir;

fn out_dir(info: Option<Value>) -> (TempDir, PathBuf) {
    let out = TempDir::new().unwrap();
    let cli = out.path().join("cli");
    fs::create_dir(&cli).unwrap();
    if let Some(info) = info {
        fs::write(out.path().join("build-info.json"), info.to_string()).unwrap();
    }
    (out, cli)
}

fn packaged_cli_dir(info: Option<Value>) -> (TempDir, PathBuf) {
    let resources = TempDir::new().unwrap();
    let cli = resources.path().join("app.asar").join("out").join("cli");
    fs::create_dir_all(&cli).unwrap();
    if let Some(info) = info {
        fs::write(resources.path().join("build-info.json"), info.to_string()).unwrap();
    }
    (resources, cli)
}

#[test]
fn reads_the_full_build_version_from_the_stamp_beside_the_cli_folder() {
    let (_out, cli) = out_dir(Some(
        json!({"version": "0.5.9-rc.3+sha.1a2b3c.dirty", "builtAt": "2026-10-06T00:00:00Z"}),
    ));
    assert_eq!(
        build_version_at(&cli).as_deref(),
        Some("0.5.9-rc.3+sha.1a2b3c.dirty")
    );
}

#[test]
fn answers_nothing_without_a_valid_stamp() {
    assert_eq!(build_version_at(&out_dir(None).1), None);
    assert_eq!(
        build_version_at(&out_dir(Some(json!({"version": "0.5.9"}))).1),
        None
    );
}

#[test]
fn answers_nothing_for_a_stamp_that_is_not_a_record_with_two_strings() {
    let stamps = [
        json!(null),
        json!([]),
        json!("0.5.9"),
        json!({"version": 5, "builtAt": "t"}),
        json!({"version": "0.5.9", "builtAt": 5}),
        json!({"builtAt": "t"}),
    ];
    for stamp in stamps {
        let label = stamp.to_string();
        assert_eq!(build_version_at(&out_dir(Some(stamp)).1), None, "{label}");
    }
}

#[test]
fn answers_nothing_for_a_stamp_that_is_not_json() {
    let (out, cli) = out_dir(None);
    fs::write(out.path().join("build-info.json"), "{ not json").unwrap();
    assert_eq!(build_version_at(&cli), None);
}

#[test]
fn answers_nothing_for_a_cli_folder_that_does_not_exist() {
    let dir = TempDir::new().unwrap();
    assert_eq!(
        build_version_at(&dir.path().join("a").join("b").join("cli")),
        None
    );
}

#[test]
fn reads_the_stamp_from_the_resources_folder_beside_app_asar() {
    let (resources, cli) = packaged_cli_dir(Some(
        json!({"version": "0.5.12-rc.4+sha.1a2b3c", "builtAt": "2026-10-17T00:00:00Z"}),
    ));
    assert_eq!(
        build_info_path_at(&cli),
        resources.path().join("build-info.json")
    );
    assert_eq!(
        build_version_at(&cli).as_deref(),
        Some("0.5.12-rc.4+sha.1a2b3c")
    );
}

#[test]
fn does_not_look_inside_the_asar_for_a_stamp() {
    let (_resources, cli) = packaged_cli_dir(None);
    fs::write(
        cli.parent().unwrap().join("build-info.json"),
        json!({"version": "1.0.0", "builtAt": "t"}).to_string(),
    )
    .unwrap();
    assert_eq!(build_version_at(&cli), None);
}

#[test]
fn puts_the_stamp_path_by_how_deep_app_asar_sits_above_the_cli_folder() {
    let cases = [
        ("/r/app.asar/out/cli", "/r/build-info.json"),
        ("/r/out/cli", "/r/out/build-info.json"),
        ("/r/app.asar/cli", "/r/app.asar/build-info.json"),
        ("/r/app.asar/out/a/cli", "/r/app.asar/out/a/build-info.json"),
    ];
    for (cli, expected) in cases {
        assert_eq!(
            build_info_path_at(Path::new(cli)),
            PathBuf::from(expected),
            "{cli}"
        );
    }
}

fn installed_cli(info: Option<Value>) -> (TempDir, PathBuf) {
    let (out, cli) = out_dir(info);
    let exe = cli.join("ostia");
    fs::copy(env!("CARGO_BIN_EXE_ostia"), &exe).unwrap();
    (out, exe)
}

#[test]
fn prints_the_version_of_the_build_it_ships_with() {
    let (_out, exe) = installed_cli(Some(
        json!({"version": "0.5.12-rc.4+sha.1a2b3c", "builtAt": "2026-10-17T00:00:00Z"}),
    ));
    let run = Command::new(&exe)
        .arg("--version")
        .env_clear()
        .output()
        .unwrap();
    assert_eq!(run.status.code(), Some(0));
    assert_eq!(
        String::from_utf8(run.stdout).unwrap(),
        "0.5.12-rc.4+sha.1a2b3c\n"
    );
}

#[test]
fn prints_no_version_without_a_stamp() {
    let (_out, exe) = installed_cli(None);
    let run = Command::new(&exe)
        .arg("--version")
        .env_clear()
        .output()
        .unwrap();
    assert_eq!(run.status.code(), Some(1));
    assert_eq!(String::from_utf8(run.stdout).unwrap(), "");
    assert_eq!(
        String::from_utf8(run.stderr).unwrap(),
        "ostia: build-info.json is missing\n"
    );
}
