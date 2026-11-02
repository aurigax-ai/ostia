#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_terminal::shell_exit::{STARTUP_FAILURE_MS, ShellExit, closes_pane_on_exit};

#[test]
fn closes_the_pane_when_the_shell_ends_by_itself_whatever_its_last_command_returned() {
    assert!(closes_pane_on_exit(ShellExit {
        own_exit: true,
        code: 0,
        lived_ms: 10,
    }));
    assert!(closes_pane_on_exit(ShellExit {
        own_exit: true,
        code: 127,
        lived_ms: STARTUP_FAILURE_MS,
    }));
}

#[test]
fn keeps_the_pane_when_the_shell_failed_right_after_starting_so_its_error_stays_readable() {
    assert!(!closes_pane_on_exit(ShellExit {
        own_exit: true,
        code: 1,
        lived_ms: STARTUP_FAILURE_MS - 1,
    }));
}

#[test]
fn keeps_the_pane_when_ostia_itself_stopped_the_shell() {
    assert!(!closes_pane_on_exit(ShellExit {
        own_exit: false,
        code: 0,
        lived_ms: 60_000,
    }));
}
