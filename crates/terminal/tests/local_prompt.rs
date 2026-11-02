#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::terminal_shell::shell_argv;
use ostia_terminal::local_prompt::{PromptOwner, at_local_prompt, busy_program, shell_idle};

fn owner(foreground: &str, shell: &str, sandboxed: bool) -> PromptOwner {
    PromptOwner {
        foreground: foreground.to_owned(),
        shell: shell.to_owned(),
        sandboxed,
    }
}

#[test]
fn is_true_while_the_panes_own_shell_holds_the_terminal() {
    assert!(at_local_prompt(&owner("zsh", "/usr/bin/zsh", false)));
    assert!(at_local_prompt(&owner("-zsh", "/bin/zsh", false)));
}

#[test]
fn is_false_while_another_program_holds_it_such_as_ssh_showing_a_remote_prompt() {
    assert!(!at_local_prompt(&owner("ssh", "/usr/bin/zsh", false)));
    assert!(!at_local_prompt(&owner("docker", "/bin/bash", false)));
}

#[test]
fn does_not_guess_when_the_shell_runs_wrapped_or_the_name_is_unknown() {
    assert!(at_local_prompt(&owner("bwrap", "/bin/sh", true)));
    assert!(at_local_prompt(&owner("", "/usr/bin/zsh", false)));
    assert!(at_local_prompt(&owner("zsh", "", false)));
}

#[test]
fn names_the_program_that_holds_the_terminal_instead_of_the_shell() {
    let fish = owner("/usr/bin/sleep", "/usr/bin/fish", false);
    assert_eq!(busy_program(&fish), Some("sleep".to_owned()));
    assert_eq!(
        busy_program(&owner("ssh", "/bin/zsh", false)),
        Some("ssh".to_owned())
    );
}

#[test]
fn names_nothing_at_the_shells_own_prompt_or_when_it_cannot_tell() {
    assert_eq!(busy_program(&owner("fish", "/usr/bin/fish", false)), None);
    assert_eq!(busy_program(&owner("sleep", "/bin/sh", true)), None);
    assert_eq!(busy_program(&owner("", "/bin/zsh", false)), None);
}

#[test]
fn quitting_with_an_idle_shell_without_blocks_shows_no_dialog() {
    let argv = shell_argv("/bin/sh -i", "/bin/zsh");
    assert_eq!(argv.first().map(String::as_str), Some("/bin/sh"));
    assert_eq!(busy_program(&owner("sh", &argv[0], false)), None);
}

#[test]
fn is_true_only_when_the_shell_itself_is_in_the_foreground_and_the_owner_is_known() {
    assert!(shell_idle(&owner("bash", "/bin/bash", false)));
    assert!(!shell_idle(&owner("claude", "/bin/bash", false)));
    assert!(!shell_idle(&owner("", "/bin/bash", false)));
    assert!(!shell_idle(&owner("bash", "/bin/bash", true)));
}

#[test]
fn strips_one_leading_dash_from_both_names_and_only_one() {
    assert!(at_local_prompt(&owner("-zsh", "-zsh", false)));
    assert!(!at_local_prompt(&owner("--zsh", "zsh", false)));
    assert_eq!(
        busy_program(&owner("/usr/bin/-ssh", "/bin/zsh", false)),
        Some("ssh".to_owned())
    );
}

#[test]
fn compares_program_names_with_the_folder_removed_and_not_the_whole_path() {
    assert!(at_local_prompt(&owner("/opt/a/zsh", "/usr/bin/zsh", false)));
    assert!(!at_local_prompt(&owner(
        "/usr/bin/zsh2",
        "/usr/bin/zsh",
        false
    )));
}

#[test]
fn a_sandboxed_shell_is_never_idle_and_never_busy() {
    let sandboxed = owner("claude", "/bin/bash", true);
    assert!(at_local_prompt(&sandboxed));
    assert_eq!(busy_program(&sandboxed), None);
    assert!(!shell_idle(&sandboxed));
}
