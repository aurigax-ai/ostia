pub fn tmux_conf(default_terminal: &str) -> String {
    let default_terminal_line = format!("set -g default-terminal \"{default_terminal}\"");
    [
        "set -g prefix None",
        "set -g prefix2 None",
        "unbind-key -a",
        "unbind-key -a -T root",
        "unbind-key -a -T copy-mode",
        "unbind-key -a -T copy-mode-vi",
        "set -g status off",
        "set -g mouse off",
        "set -g allow-passthrough on",
        "set -g set-clipboard off",
        default_terminal_line.as_str(),
        "set -g history-limit 20000",
        "set -g remain-on-exit on",
        "set -g automatic-rename off",
        "set -g allow-rename off",
        "set -g escape-time 0",
        "set -g focus-events on",
        "set -g update-environment \"\"",
        "set -g destroy-unattached off",
        "set -g detach-on-destroy off",
        "set -g exit-empty off",
        "set -g visual-bell off",
        "set -g bell-action none",
        "",
    ]
    .join("\n")
}
