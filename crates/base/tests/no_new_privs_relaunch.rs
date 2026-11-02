#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;

use ostia_base::no_new_privs_relaunch::relaunch_without_no_new_privs;

const MARKER: &str = "OSTIA_NO_NEW_PRIVS_RELAUNCHED";

struct Run {
    result: bool,
    env: BTreeMap<String, String>,
    launched: Vec<BTreeMap<String, String>>,
    warnings: Vec<String>,
}

fn run(no_new_privs: bool, env: &[(&str, &str)], launch_works: bool) -> Run {
    let mut env: BTreeMap<String, String> = env
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let mut launched = Vec::new();
    let mut warnings = Vec::new();
    let result = relaunch_without_no_new_privs(
        no_new_privs,
        &mut env,
        &mut |next| {
            launched.push(next.clone());
            launch_works
        },
        &mut |line| warnings.push(line.to_owned()),
    );
    Run {
        result,
        env,
        launched,
        warnings,
    }
}

#[test]
fn relaunches_once_with_the_loop_marker_when_the_flag_is_set() {
    let run = run(true, &[("PATH", "/usr/bin")], true);
    assert!(run.result);
    assert!(!run.env.contains_key(MARKER));
    assert_eq!(
        run.launched,
        vec![BTreeMap::from([
            ("PATH".to_owned(), "/usr/bin".to_owned()),
            (MARKER.to_owned(), "1".to_owned()),
        ])]
    );
    assert!(run.warnings.is_empty());
}

#[test]
fn does_nothing_when_the_flag_is_clear() {
    let run = run(false, &[("PATH", "/usr/bin")], true);
    assert!(!run.result);
    assert!(run.launched.is_empty());
    assert!(run.warnings.is_empty());
}

#[test]
fn never_relaunches_twice_and_says_the_flag_survived() {
    let run = run(true, &[(MARKER, "1")], true);
    assert!(!run.result);
    assert!(run.launched.is_empty());
    assert_eq!(run.warnings.len(), 1);
}

#[test]
fn removes_the_marker_so_panes_never_inherit_it() {
    let run = run(false, &[(MARKER, "1")], true);
    assert!(!run.env.contains_key(MARKER));
}

#[test]
fn starts_this_instance_and_warns_when_systemd_cannot_launch() {
    let run = run(true, &[("PATH", "/usr/bin")], false);
    assert!(!run.result);
    assert_eq!(run.warnings.len(), 1);
}

#[test]
fn reads_an_empty_marker_as_set_because_the_loop_guard_tests_presence() {
    let run = run(true, &[(MARKER, "")], true);
    assert!(!run.result);
    assert!(run.launched.is_empty());
}
