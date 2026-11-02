#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::path::PathBuf;

use ostia_base::host::{Host, Platform};
use ostia_sandbox::pty_wrap::{
    PTY_RELAY_ENV, relay_forced, sandboxed_shell_command, wrap_for_terminal,
};

const WRAPPED: &str = "bwrap --new-session --die-with-parent --dev /dev -- bash -c 'zsh -i'";
const PIPE: &str = "/tmp/ostia-sandbox-tmp/1/ws/resize-abc";
const BRIDGE: &str = "( socat -u UNIX-CONNECT:ports-ab12.sock - ) &";

fn host_with(env: &[(&str, &str)]) -> Host {
    Host {
        env: env
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect::<BTreeMap<_, _>>(),
        home: PathBuf::from("/home/u"),
        cwd: PathBuf::from("/"),
        platform: Platform::Linux,
    }
}

fn lines(text: &str) -> Vec<&str> {
    text.split('\n').collect()
}

#[test]
fn honours_the_switch_only_in_an_unpackaged_build() {
    assert_eq!(PTY_RELAY_ENV, "SANDBOX_PTY_RELAY");
    let on = host_with(&[("OSTIA_SANDBOX_PTY_RELAY", "1")]);
    assert!(relay_forced(false, &on));
    assert!(!relay_forced(true, &on));
    assert!(!relay_forced(false, &host_with(&[])));
    assert!(!relay_forced(
        false,
        &host_with(&[("OSTIA_SANDBOX_PTY_RELAY", "0")])
    ));
    assert!(!relay_forced(
        false,
        &host_with(&[("PINE_SANDBOX_PTY_RELAY", "1")])
    ));
}

#[test]
fn runs_the_shell_as_it_is_when_the_pane_terminal_is_its_own() {
    assert_eq!(
        sandboxed_shell_command("/usr/bin/zsh -i", Some("/usr/bin/zsh"), None, None),
        "/usr/bin/zsh -i"
    );
}

#[test]
fn runs_the_shell_on_an_inner_terminal_that_script_relays_with_the_pane_terminal_settings_and_shell()
 {
    let command = sandboxed_shell_command(
        "/usr/bin/zsh -i 'a b'",
        Some("/usr/bin/zsh"),
        Some(PIPE),
        None,
    );
    assert_eq!(
        lines(&command),
        vec![
            format!("{{ while read -r -n1 _; do kill -WINCH 0 2>/dev/null; done <>{PIPE}; }} &"),
            "SHELL=/bin/sh script -qec 'stty \"$OSTIA_RELAY_TTY\" 2>/dev/null; unset OSTIA_RELAY_TTY; export SHELL=/usr/bin/zsh; exec /usr/bin/zsh -i '\\''a b'\\''' /dev/null".to_owned(),
            "exit $?".to_owned(),
        ]
    );
}

#[test]
fn starts_the_port_bridge_beside_a_shell_that_keeps_the_pane_terminal_and_still_runs_it_as_the_command()
 {
    assert_eq!(
        sandboxed_shell_command("/usr/bin/zsh -i", Some("/usr/bin/zsh"), None, Some(BRIDGE)),
        format!("{BRIDGE}\nexec /usr/bin/zsh -i")
    );
}

#[test]
fn starts_the_port_bridge_before_the_relayed_shell() {
    let command = sandboxed_shell_command(
        "/usr/bin/zsh -i",
        Some("/usr/bin/zsh"),
        Some(PIPE),
        Some(BRIDGE),
    );
    let parts = lines(&command);
    assert_eq!(parts.len(), 4);
    assert_eq!(parts[0], BRIDGE);
    assert!(parts[2].contains("script -qec"));
}

#[test]
fn leaves_shell_unset_inside_when_the_pane_had_none() {
    assert!(
        sandboxed_shell_command("bash -i", None, Some(PIPE), None)
            .contains("; unset SHELL; exec bash -i")
    );
}

#[test]
fn quotes_a_resize_pipe_path_that_holds_spaces() {
    assert!(
        sandboxed_shell_command(
            "bash -i",
            Some("/bin/bash"),
            Some("/tmp/my ws/resize-1"),
            None
        )
        .contains("done <>'/tmp/my ws/resize-1'; } &")
    );
}

#[test]
fn treats_an_empty_resize_pipe_and_an_empty_port_bridge_as_none_and_quotes_an_empty_shell() {
    assert_eq!(
        sandboxed_shell_command("bash -i", Some("/bin/bash"), Some(""), Some("")),
        "bash -i"
    );
    assert!(
        sandboxed_shell_command("bash -i", Some(""), Some(PIPE), None)
            .contains("export SHELL='\\'''\\''; exec bash -i")
    );
}

#[test]
fn keeps_the_shell_on_the_pane_terminal_when_nothing_can_inject_keys_into_it() {
    assert_eq!(
        wrap_for_terminal(WRAPPED, None, Platform::Linux),
        "bwrap --die-with-parent --dev /dev -- bash -c 'zsh -i'"
    );
}

#[test]
fn removes_only_bwrap_own_flag_never_the_same_words_inside_the_command() {
    let inner =
        "bwrap --new-session --die-with-parent -- bash -c 'echo --new-session --die-with-parent x'";
    assert_eq!(
        wrap_for_terminal(inner, None, Platform::Linux),
        "bwrap --die-with-parent -- bash -c 'echo --new-session --die-with-parent x'"
    );
}

#[test]
fn keeps_the_new_session_behind_the_relay_and_forwards_window_changes_through_the_pipe() {
    let wrapped = wrap_for_terminal(WRAPPED, Some(PIPE), Platform::Linux);
    let parts = lines(&wrapped);
    let at = parts.iter().position(|line| *line == WRAPPED).unwrap();
    assert_eq!(
        parts[..at].to_vec(),
        vec![
            format!("f={PIPE}").as_str(),
            "rm -f \"$f\"",
            "mkfifo -m 600 \"$f\" || exit 1",
            "OSTIA_RELAY_TTY=$(stty -g) || exit 1",
            "export OSTIA_RELAY_TTY",
            "stty -isig -icanon -echo",
            "( trap 'printf . 1<>\"$f\"' WINCH; sleep infinity & s=$!; trap 'kill \"$s\" 2>/dev/null' TERM; while kill -0 \"$s\" 2>/dev/null; do wait \"$s\"; done ) &",
            "w=$!",
        ]
    );
    assert_eq!(
        parts[at + 1..].to_vec(),
        vec![
            "rc=$?",
            "kill \"$w\" 2>/dev/null",
            "rm -f \"$f\"",
            "exit \"$rc\"",
        ]
    );
}

#[test]
fn quotes_a_relay_pipe_path_that_holds_spaces_in_the_wrapper() {
    let wrapped = wrap_for_terminal(WRAPPED, Some("/tmp/my ws/resize-1"), Platform::Linux);
    assert_eq!(lines(&wrapped)[0], "f='/tmp/my ws/resize-1'");
}

#[test]
fn never_ignores_the_interrupt_keys_in_the_wrapper_which_the_shell_commands_would_inherit() {
    assert!(!wrap_for_terminal(WRAPPED, Some(PIPE), Platform::Linux).contains("trap '' "));
}

#[test]
fn leaves_another_platform_wrapper_untouched() {
    assert_eq!(
        wrap_for_terminal("sandbox-exec -p x zsh", None, Platform::Darwin),
        "sandbox-exec -p x zsh"
    );
    assert_eq!(
        wrap_for_terminal("sandbox-exec -p x zsh", Some(PIPE), Platform::Darwin),
        "sandbox-exec -p x zsh"
    );
}
