#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::process::Command;

use ostia_terminal::pane_launcher::{
    OSTIA_LAUNCHER_NAME, ostia_launcher_script, with_launcher_on_path, write_ostia_launcher,
};
use ostia_testkit::fixture_text;
use tempfile::TempDir;

fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect()
}

#[test]
fn runs_the_cli_through_the_pane_node_with_electron_run_as_node_and_forwards_every_argument() {
    assert_eq!(
        ostia_launcher_script(),
        fixture_text("rust/pane-launcher.sh").unwrap()
    );
}

#[test]
fn writes_an_executable_file_only_the_owner_can_touch_and_rewrites_it_in_place() {
    let root = TempDir::new().unwrap();
    let dir = root.path().join("bin");
    write_ostia_launcher(&dir).unwrap();
    write_ostia_launcher(&dir).unwrap();
    let mode = fs::metadata(dir.join(OSTIA_LAUNCHER_NAME))
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o700);
    assert_eq!(
        fs::read_to_string(dir.join(OSTIA_LAUNCHER_NAME)).unwrap(),
        ostia_launcher_script()
    );
}

#[test]
fn is_found_by_a_non_interactive_shell_and_passes_arguments_and_the_pane_env_through() {
    let root = TempDir::new().unwrap();
    let dir = root.path().join("bin");
    write_ostia_launcher(&dir).unwrap();
    let fake_node = root.path().join("node");
    fs::write(&fake_node, "#!/bin/sh\necho \"$ELECTRON_RUN_AS_NODE|$@\"\n").unwrap();
    fs::set_permissions(&fake_node, fs::Permissions::from_mode(0o700)).unwrap();
    let dir_text = dir.to_str().unwrap();
    let env = with_launcher_on_path(
        &env(&[
            ("PATH", "/usr/bin:/bin"),
            ("OSTIA_NODE", fake_node.to_str().unwrap()),
            ("OSTIA_CLI", "cli.js"),
        ]),
        dir_text,
        ":",
    );
    let found = Command::new("/bin/sh")
        .args(["-c", "command -v ostia"])
        .env_clear()
        .envs(&env)
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8(found.stdout).unwrap().trim(),
        dir.join("ostia").to_str().unwrap()
    );
    let out = Command::new("/bin/sh")
        .args(["-c", "ostia pane list --help"])
        .env_clear()
        .envs(&env)
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8(out.stdout).unwrap().trim(),
        "1|cli.js pane list --help"
    );
}

#[test]
fn puts_the_launcher_directory_first_and_keeps_the_rest_in_order() {
    let out = with_launcher_on_path(&env(&[("PATH", "/usr/bin:/bin")]), "/ud/bin", ":");
    assert_eq!(out["PATH"], "/ud/bin:/usr/bin:/bin");
}

#[test]
fn does_not_repeat_the_directory_when_it_is_already_on_the_path() {
    let out = with_launcher_on_path(&env(&[("PATH", "/usr/bin:/ud/bin")]), "/ud/bin", ":");
    assert_eq!(out["PATH"], "/ud/bin:/usr/bin");
}

#[test]
fn sets_the_path_when_the_environment_has_none_and_leaves_other_keys_alone() {
    let out = with_launcher_on_path(&env(&[("HOME", "/h")]), "/ud/bin", ":");
    assert_eq!(out, env(&[("HOME", "/h"), ("PATH", "/ud/bin")]));
}

#[test]
fn drops_empty_entries_from_the_path() {
    let out = with_launcher_on_path(&env(&[("PATH", ":/usr/bin::/bin:")]), "/ud/bin", ":");
    assert_eq!(out["PATH"], "/ud/bin:/usr/bin:/bin");
}
