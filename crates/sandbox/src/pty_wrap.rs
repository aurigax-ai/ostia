use ostia_base::host::{Host, Platform};
use ostia_contract::shell_quote::quote_arg;

const NEW_SESSION: &str = " --new-session --die-with-parent ";
const DIE_WITH_PARENT: &str = " --die-with-parent ";
const OUTER_TERMIOS: &str = "OSTIA_RELAY_TTY";
const RELAY_SHELL: &str = "/bin/sh";

pub const PTY_RELAY_ENV: &str = "SANDBOX_PTY_RELAY";

const FORWARD_RESIZE: &str = "( trap 'printf . 1<>\"$f\"' WINCH; sleep infinity & s=$!; trap 'kill \"$s\" 2>/dev/null' TERM; while kill -0 \"$s\" 2>/dev/null; do wait \"$s\"; done ) &";

pub fn relay_forced(is_packaged: bool, host: &Host) -> bool {
    !is_packaged && host.app_var(PTY_RELAY_ENV) == Some("1")
}

fn relayed_shell(shell_command: &str, shell_env: Option<&str>) -> String {
    let shell = match shell_env {
        None => "unset SHELL".to_owned(),
        Some(value) => format!("export SHELL={}", quote_arg(value)),
    };
    [
        format!("stty \"${OUTER_TERMIOS}\" 2>/dev/null"),
        format!("unset {OUTER_TERMIOS}"),
        shell,
        format!("exec {shell_command}"),
    ]
    .join("; ")
}

pub fn sandboxed_shell_command(
    shell_command: &str,
    shell_env: Option<&str>,
    resize_pipe: Option<&str>,
    port_bridge: Option<&str>,
) -> String {
    let helpers: Vec<String> = port_bridge
        .filter(|bridge| !bridge.is_empty())
        .map(str::to_owned)
        .into_iter()
        .collect();
    let Some(pipe) = resize_pipe.filter(|pipe| !pipe.is_empty()) else {
        if helpers.is_empty() {
            return shell_command.to_owned();
        }
        let mut lines = helpers;
        lines.push(format!("exec {shell_command}"));
        return lines.join("\n");
    };
    let mut lines = helpers;
    lines.push(format!(
        "{{ while read -r -n1 _; do kill -WINCH 0 2>/dev/null; done <>{}; }} &",
        quote_arg(pipe)
    ));
    lines.push(format!(
        "SHELL={RELAY_SHELL} script -qec {} /dev/null",
        quote_arg(&relayed_shell(shell_command, shell_env))
    ));
    lines.push("exit $?".to_owned());
    lines.join("\n")
}

fn relay_wrapper(wrapped: &str, resize_pipe: &str) -> String {
    [
        format!("f={}", quote_arg(resize_pipe)),
        "rm -f \"$f\"".to_owned(),
        "mkfifo -m 600 \"$f\" || exit 1".to_owned(),
        format!("{OUTER_TERMIOS}=$(stty -g) || exit 1"),
        format!("export {OUTER_TERMIOS}"),
        "stty -isig -icanon -echo".to_owned(),
        FORWARD_RESIZE.to_owned(),
        "w=$!".to_owned(),
        wrapped.to_owned(),
        "rc=$?".to_owned(),
        "kill \"$w\" 2>/dev/null".to_owned(),
        "rm -f \"$f\"".to_owned(),
        "exit \"$rc\"".to_owned(),
    ]
    .join("\n")
}

pub fn wrap_for_terminal(wrapped: &str, resize_pipe: Option<&str>, platform: Platform) -> String {
    if platform != Platform::Linux {
        return wrapped.to_owned();
    }
    match resize_pipe.filter(|pipe| !pipe.is_empty()) {
        Some(pipe) => relay_wrapper(wrapped, pipe),
        None => wrapped.replacen(NEW_SESSION, DIE_WITH_PARENT, 1),
    }
}
