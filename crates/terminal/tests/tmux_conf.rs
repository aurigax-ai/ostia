#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_terminal::tmux_conf::tmux_conf;

#[test]
fn ksh_c68_leaves_window_size_alone_a_global_manual_size_crashes_tmux_before_3_7_on_a_new_window() {
    assert!(!tmux_conf("screen-256color").contains("window-size"));
}

#[test]
fn names_the_terminal_type_it_was_given() {
    assert!(tmux_conf("tmux-256color").contains("set -g default-terminal \"tmux-256color\""));
}

#[test]
fn writes_the_whole_config_one_command_per_line_with_a_closing_newline() {
    let expected = [
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
        "set -g default-terminal \"screen-256color\"",
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
    .join("\n");
    assert_eq!(tmux_conf("screen-256color"), expected);
}
