#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;
use std::process::Command;

use ostia_contract::app_env::{
    ENV_PREFIX, EnvSource, app_env, env_name, is_app_env_name, read_env, shell_env, without_env,
};

fn source(pairs: &[(&str, &str)]) -> EnvSource {
    pairs
        .iter()
        .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
        .collect()
}

#[test]
fn reads_the_ostia_name_and_never_a_pine_one() {
    let both = source(&[("OSTIA_SOCKET", "/new"), ("PINE_SOCKET", "/old")]);
    assert_eq!(read_env("SOCKET", &both).as_deref(), Some("/new"));
    let old_only = source(&[("PINE_SOCKET", "/old")]);
    assert_eq!(read_env("SOCKET", &old_only), None);
}

#[test]
fn treats_an_empty_value_as_unset() {
    assert_eq!(read_env("SOCKET", &source(&[("OSTIA_SOCKET", "")])), None);
    assert_eq!(read_env("SOCKET", &HashMap::new()), None);
}

#[test]
fn sets_every_variable_under_its_ostia_name_only() {
    assert_eq!(
        app_env(&[("SOCKET", "/s"), ("TOKEN", "t")]),
        source(&[("OSTIA_SOCKET", "/s"), ("OSTIA_TOKEN", "t")])
    );
}

#[test]
fn drops_the_named_variables_and_keeps_the_rest() {
    let env = source(&[
        ("OSTIA_PANE_ID", "p"),
        ("OSTIA_SOCKET", "/s"),
        ("PATH", "/bin"),
    ]);
    assert_eq!(
        without_env(&env, &["PANE_ID"]),
        source(&[("OSTIA_SOCKET", "/s"), ("PATH", "/bin")])
    );
}

#[test]
fn matches_the_ostia_prefix_only() {
    assert!(is_app_env_name("OSTIA_TOKEN"));
    assert!(!is_app_env_name("PINE_TOKEN"));
    assert!(!is_app_env_name("NOT_OSTIA_TOKEN"));
}

fn expand(env: &[(&str, &str)]) -> String {
    let script = format!("printf '%s' \"{}\"", shell_env("CLI"));
    let output = Command::new("/bin/sh")
        .args(["-c", &script])
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .envs(env.iter().copied())
        .output()
        .unwrap();
    String::from_utf8(output.stdout).unwrap()
}

#[test]
fn expands_the_ostia_variable_in_a_posix_shell_and_ignores_a_pine_one() {
    assert_eq!(expand(&[("OSTIA_CLI", "/new")]), "/new");
    assert_eq!(expand(&[("PINE_CLI", "/old")]), "");
}

#[test]
fn builds_names_and_shell_references_from_the_prefix() {
    assert_eq!(ENV_PREFIX, "OSTIA_");
    assert_eq!(env_name("TOKEN"), "OSTIA_TOKEN");
    assert_eq!(shell_env("CLI"), "${OSTIA_CLI}");
}
