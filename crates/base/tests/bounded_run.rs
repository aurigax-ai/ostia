#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::path::Path;
use std::time::{Duration, Instant};

use ostia_base::bounded_run::{MAX_OUTPUT, run_bounded};

fn path_env() -> BTreeMap<String, String> {
    BTreeMap::from([("PATH".to_owned(), std::env::var("PATH").unwrap())])
}

fn shell(script: &str, env: &BTreeMap<String, String>, timeout: Duration) -> Option<String> {
    run_bounded(
        Path::new("/bin/sh"),
        &["-c".to_owned(), script.to_owned()],
        env,
        timeout,
    )
}

#[test]
fn gives_the_child_only_the_environment_it_is_passed() {
    let given = BTreeMap::from([
        ("KEPT".to_owned(), "1".to_owned()),
        ("DRI_PRIME".to_owned(), "pci-0000_01_00_0".to_owned()),
    ]);
    let out = run_bounded(
        Path::new("/usr/bin/env"),
        &[],
        &given,
        Duration::from_secs(5),
    )
    .unwrap();
    let mut seen: Vec<&str> = out.lines().collect();
    seen.sort_unstable();
    assert_eq!(seen, ["DRI_PRIME=pci-0000_01_00_0", "KEPT=1"]);
    let empty = run_bounded(
        Path::new("/usr/bin/env"),
        &[],
        &BTreeMap::new(),
        Duration::from_secs(5),
    )
    .unwrap();
    assert_eq!(empty, "");
}

#[test]
fn returns_the_output_of_a_child_that_succeeds() {
    assert_eq!(
        shell("printf hello", &path_env(), Duration::from_secs(5)).as_deref(),
        Some("hello")
    );
    assert_eq!(shell("exit 3", &path_env(), Duration::from_secs(5)), None);
}

#[test]
fn gives_up_at_the_deadline_when_a_grandchild_keeps_stdout_open() {
    let started = Instant::now();
    let out = shell(
        "sleep 6 & echo started",
        &path_env(),
        Duration::from_millis(500),
    );
    assert_eq!(out, None);
    assert!(started.elapsed() < Duration::from_secs(4));
}

#[test]
fn accepts_output_of_exactly_the_cap_and_refuses_one_byte_more() {
    let exact = shell(
        &format!("head -c {MAX_OUTPUT} /dev/zero"),
        &path_env(),
        Duration::from_secs(10),
    );
    assert_eq!(exact.map(|text| text.len()), Some(MAX_OUTPUT));
    let over = shell(
        &format!("head -c {} /dev/zero", MAX_OUTPUT + 1),
        &path_env(),
        Duration::from_secs(10),
    );
    assert_eq!(over, None);
}

#[test]
fn stops_a_child_that_never_stops_writing_once_the_cap_is_passed() {
    let started = Instant::now();
    let out = shell("yes", &path_env(), Duration::from_secs(20));
    assert_eq!(out, None);
    assert!(started.elapsed() < Duration::from_secs(10));
}
