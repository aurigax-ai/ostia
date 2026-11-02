#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::process::Command;

use ostia_base::process::is_running;

#[test]
fn is_alive_for_the_current_process() {
    assert!(is_running(i32::try_from(std::process::id()).unwrap()));
}

#[test]
fn is_alive_for_a_process_that_belongs_to_another_user() {
    assert!(is_running(1));
}

#[test]
fn is_dead_for_a_child_that_has_been_waited_for() {
    let mut child = Command::new("true").spawn().unwrap();
    let pid = i32::try_from(child.id()).unwrap();
    child.wait().unwrap();
    assert!(!is_running(pid));
}

#[test]
fn is_dead_for_a_pid_no_process_holds() {
    assert!(!is_running(i32::MAX));
}
