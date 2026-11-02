#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_control::foreign_sandbox::{
    Peer, escapes_sandbox, escapes_sandbox_command, parse_seccomp, parse_start_time, read_peer,
    sandboxed_by_kernel,
};
use serde_json::json;

fn stat(start: &str) -> String {
    let rest = (0..19).map(|n| n.to_string()).collect::<Vec<_>>().join(" ");
    format!("42 (a (b) c) {rest} {start} 1 2")
}

#[test]
fn reads_the_seccomp_mode_and_the_start_time() {
    assert_eq!(parse_seccomp("Name:\tx\nSeccomp:\t2\nGroups:\n"), Some(2));
    assert_eq!(parse_seccomp("Name:\tx\n"), None);
    assert_eq!(parse_start_time(&stat("777")), Some("777".to_owned()));
    assert_eq!(parse_start_time("garbage"), None);
}

#[test]
fn a_peer_that_changes_while_it_is_read_is_no_peer() {
    let reads = std::cell::Cell::new(0);
    let proc = |path: &str| {
        if path.ends_with("status") {
            return Some("Seccomp:\t2\n".to_owned());
        }
        reads.set(reads.get() + 1);
        Some(stat(if reads.get() == 1 { "1" } else { "2" }))
    };
    assert_eq!(read_peer(42, &proc), None);
    let steady = |path: &str| {
        Some(if path.ends_with("status") {
            "Seccomp:\t2\n".to_owned()
        } else {
            stat("1")
        })
    };
    let peer = read_peer(42, &steady).unwrap();
    assert_eq!(
        (peer.pid, peer.seccomp, peer.start_time.as_str()),
        (42, 2, "1")
    );
}

#[test]
fn a_peer_counts_as_sandboxed_only_if_seccomp_is_new_since_its_shell() {
    let peer = read_peer(42, &|path: &str| {
        Some(if path.ends_with("status") {
            "Seccomp:\t2\n".to_owned()
        } else {
            stat("1")
        })
    })
    .unwrap();
    let shell_free = |path: &str| {
        Some(match path {
            "/proc/42/stat" => stat("1"),
            "/proc/7/status" => "Seccomp:\t0\n".to_owned(),
            _ => String::new(),
        })
    };
    let shell_filtered = |path: &str| {
        Some(match path {
            "/proc/42/stat" => stat("1"),
            "/proc/7/status" => "Seccomp:\t2\n".to_owned(),
            _ => String::new(),
        })
    };
    let reused_pid = |path: &str| {
        Some(if path == "/proc/42/stat" {
            stat("9")
        } else {
            "Seccomp:\t2\n".to_owned()
        })
    };
    assert!(sandboxed_by_kernel(Some(&peer), Some(7), &shell_free));
    assert!(!sandboxed_by_kernel(Some(&peer), Some(7), &shell_filtered));
    assert!(sandboxed_by_kernel(Some(&peer), Some(7), &reused_pid));
    assert!(!sandboxed_by_kernel(None, Some(7), &shell_free));
}

#[test]
fn a_filtered_peer_with_no_known_shell_counts_as_sandboxed() {
    let filtered = Peer {
        pid: 42,
        start_time: "1".to_owned(),
        seccomp: 2,
    };
    let free = Peer {
        seccomp: 0,
        ..filtered.clone()
    };
    let proc = |_: &str| Some(stat("1"));
    assert!(sandboxed_by_kernel(Some(&filtered), None, &proc));
    assert!(!sandboxed_by_kernel(Some(&free), None, &proc));
}

#[test]
fn says_which_calls_leave_the_sandbox() {
    assert!(escapes_sandbox("agent.run", &json!({}), "me"));
    assert!(!escapes_sandbox("whoami", &json!({}), "me"));
    assert!(!escapes_sandbox("pane.input", &json!({}), "me"));
    assert!(!escapes_sandbox("pane.input", &json!({"pane": "me"}), "me"));
    assert!(escapes_sandbox(
        "pane.input",
        &json!({"pane": "other"}),
        "me"
    ));
    assert!(escapes_sandbox("pane.close", &json!({"panes": []}), "me"));
    assert!(!escapes_sandbox(
        "pane.close",
        &json!({"panes": ["me"]}),
        "me"
    ));
    assert!(escapes_sandbox(
        "pane.close",
        &json!({"panes": ["me", "other"]}),
        "me"
    ));
    assert!(escapes_sandbox_command("process.run", Some("me"), "me"));
    assert!(escapes_sandbox_command("pane.close", None, "me"));
    assert!(!escapes_sandbox_command("pane.close", Some("me"), "me"));
    assert!(!escapes_sandbox_command("pane.splitRight", None, "me"));
}
