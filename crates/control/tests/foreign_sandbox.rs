#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;

use ostia_control::foreign_sandbox::{
    Peer, escapes_sandbox, escapes_sandbox_command, parse_seccomp, parse_start_time, proc_fs,
    read_peer, sandboxed_by_kernel,
};
use serde_json::json;

fn stat(start: &str) -> String {
    format!("4242 (we ird) name) S 1 4242 4242 0 -1 4194304 1 0 0 0 0 0 0 0 20 0 1 0 {start} 1 1 0")
}

fn status(seccomp: u64) -> String {
    format!("Name:\tx\nSeccomp:\t{seccomp}\nSeccomp_filters:\t1\n")
}

fn fake_proc(files: &[(&str, String)]) -> impl Fn(&str) -> Option<String> + use<> {
    let files: HashMap<String, String> = files
        .iter()
        .map(|(path, text)| ((*path).to_owned(), text.clone()))
        .collect();
    move |path: &str| files.get(path).cloned()
}

fn caller(seccomp: u64) -> Peer {
    Peer {
        pid: 10,
        start_time: "55".to_owned(),
        seccomp,
    }
}

fn world(
    caller_seccomp: u64,
    shell_seccomp: u64,
    start: &str,
) -> impl Fn(&str) -> Option<String> + use<> {
    fake_proc(&[
        ("/proc/10/stat", stat(start)),
        ("/proc/10/status", status(caller_seccomp)),
        ("/proc/20/status", status(shell_seccomp)),
    ])
}

#[test]
fn reads_the_seccomp_mode_and_the_start_time() {
    assert_eq!(parse_seccomp(&status(2)), Some(2));
    assert_eq!(parse_seccomp("Name:\tx\n"), None);
    assert_eq!(parse_start_time(&stat("987654")), Some("987654".to_owned()));
    assert_eq!(parse_start_time("garbage"), None);
}

#[test]
fn reads_a_peer_only_when_the_start_time_is_stable_and_readable() {
    let proc = fake_proc(&[
        ("/proc/10/stat", stat("55")),
        ("/proc/10/status", status(2)),
    ]);
    assert_eq!(
        read_peer(10, &proc),
        Some(Peer {
            pid: 10,
            start_time: "55".to_owned(),
            seccomp: 2
        })
    );
    assert_eq!(read_peer(11, &proc), None);
    assert_eq!(
        read_peer(10, &fake_proc(&[("/proc/10/stat", stat("55"))])),
        None
    );
}

#[test]
fn finds_the_peer_through_the_socket_pid_reader() {
    let proc = fake_proc(&[
        ("/proc/10/stat", stat("55")),
        ("/proc/10/status", status(0)),
    ]);
    assert_eq!(read_peer(999_999_999, &proc_fs), None);
    assert_eq!(read_peer(10, &proc).unwrap().seccomp, 0);
}

#[test]
fn reads_a_peer_whose_start_time_changes_between_the_two_reads_as_no_peer() {
    let reads = std::cell::Cell::new(0);
    let proc = |path: &str| {
        if path.ends_with("status") {
            return Some(status(2));
        }
        reads.set(reads.get() + 1);
        Some(stat(if reads.get() == 1 { "1" } else { "2" }))
    };
    assert_eq!(read_peer(42, &proc), None);
}

#[test]
fn refuses_a_filtered_caller_whose_pane_shell_has_no_filter() {
    assert!(sandboxed_by_kernel(
        Some(&caller(2)),
        Some(20),
        &world(2, 0, "55")
    ));
}

#[test]
fn allows_a_caller_without_a_filter() {
    assert!(!sandboxed_by_kernel(
        Some(&caller(0)),
        Some(20),
        &world(0, 0, "55")
    ));
}

#[test]
fn allows_a_filtered_caller_when_its_pane_shell_has_the_filter_too() {
    assert!(!sandboxed_by_kernel(
        Some(&caller(2)),
        Some(20),
        &world(2, 2, "55")
    ));
}

#[test]
fn allows_when_the_peer_the_shell_or_the_shell_pid_is_unknown() {
    assert!(!sandboxed_by_kernel(None, Some(20), &world(2, 0, "55")));
    assert!(!sandboxed_by_kernel(
        Some(&caller(2)),
        Some(21),
        &world(2, 0, "55")
    ));
}

#[test]
fn refuses_a_filtered_caller_when_the_shell_pid_is_unknown() {
    assert!(sandboxed_by_kernel(
        Some(&caller(2)),
        None,
        &world(2, 0, "55")
    ));
    assert!(!sandboxed_by_kernel(
        Some(&caller(0)),
        None,
        &world(0, 0, "55")
    ));
}

#[test]
fn refuses_when_the_pid_now_belongs_to_another_process() {
    assert!(sandboxed_by_kernel(
        Some(&caller(2)),
        Some(20),
        &world(0, 2, "99")
    ));
}

#[test]
fn keeps_the_verdict_of_a_caller_that_has_exited() {
    let gone = fake_proc(&[("/proc/20/status", status(0))]);
    assert!(sandboxed_by_kernel(Some(&caller(2)), Some(20), &gone));
}

#[test]
fn always_refuses_process_and_agent_starts_and_resume_records() {
    for method in [
        "process.run",
        "process.kill",
        "process.restart",
        "agent.run",
        "pane.setResume",
    ] {
        assert!(escapes_sandbox(method, &json!({}), "pOwn"), "{method}");
    }
}

#[test]
fn refuses_pane_verbs_aimed_at_another_pane() {
    assert!(escapes_sandbox(
        "pane.input",
        &json!({"pane": "pOther", "text": "x"}),
        "pOwn"
    ));
    assert!(escapes_sandbox(
        "pane.close",
        &json!({"panes": ["pOwn", "pOther"]}),
        "pOwn"
    ));
    assert!(escapes_sandbox(
        "pane.wake",
        &json!({"panes": ["pOther"]}),
        "pOwn"
    ));
    assert!(escapes_sandbox(
        "pane.moveTo",
        &json!({"panes": "pOther"}),
        "pOwn"
    ));
}

#[test]
fn allows_pane_verbs_on_the_own_pane_and_every_other_verb() {
    assert!(!escapes_sandbox(
        "pane.input",
        &json!({"pane": "pOwn"}),
        "pOwn"
    ));
    assert!(!escapes_sandbox("pane.close", &json!({}), "pOwn"));
    assert!(!escapes_sandbox("bus.send", &json!({"to": "x"}), "pOwn"));
    assert!(!escapes_sandbox("process.list", &json!({}), "pOwn"));
}

#[test]
fn refuses_an_empty_pane_list_and_treats_null_as_not_given() {
    assert!(escapes_sandbox("pane.close", &json!({"panes": []}), "pOwn"));
    assert!(!escapes_sandbox(
        "pane.close",
        &json!({"panes": null}),
        "pOwn"
    ));
    assert!(!escapes_sandbox("pane.close", &json!(null), "pOwn"));
    assert!(escapes_sandbox("pane.input", &json!({"pane": 7}), "pOwn"));
}

#[test]
fn judges_a_command_by_its_id_and_target_pane() {
    assert!(escapes_sandbox_command(
        "pane.close",
        Some("pOther"),
        "pOwn"
    ));
    assert!(!escapes_sandbox_command("pane.close", Some("pOwn"), "pOwn"));
    assert!(!escapes_sandbox_command(
        "pane.splitRight",
        Some("pOther"),
        "pOwn"
    ));
    assert!(escapes_sandbox_command("process.run", Some("pOwn"), "pOwn"));
    assert!(escapes_sandbox_command("pane.close", None, "pOwn"));
}
