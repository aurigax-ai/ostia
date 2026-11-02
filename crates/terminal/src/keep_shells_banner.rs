use std::sync::LazyLock;

use ostia_base::js::{js_trim, static_regex};
use ostia_base::system_requirements::TMUX_MIN_VERSION;
use regex::{Captures, Regex};

static PLACEHOLDER: LazyLock<Regex> = LazyLock::new(|| static_regex(r"\{([A-Za-z0-9_]+)\}"));
static SPACE_RUN: LazyLock<Regex> = LazyLock::new(|| static_regex(r" {2,}"));

fn fill(template: &str, key: &str, value: &str) -> String {
    PLACEHOLDER
        .replace_all(template, |captures: &Captures| {
            if &captures[1] == key {
                value.to_owned()
            } else {
                captures[0].to_owned()
            }
        })
        .into_owned()
}

pub fn tmux_missing(template: &str) -> String {
    fill(template, "version", TMUX_MIN_VERSION)
}

fn one_line(text: &str) -> String {
    let spaced: String = text
        .chars()
        .map(|c| if c < ' ' || c == '\x7f' { ' ' } else { c })
        .collect();
    js_trim(&SPACE_RUN.replace_all(&spaced, " ")).to_owned()
}

pub fn keep_shells_notice(keep_shells: &str, keep_shells_lost: &str, reason: &str) -> String {
    format!(
        "\x1b[2m {}\r\n {keep_shells_lost}\x1b[0m\r\n",
        fill(keep_shells, "reason", &one_line(reason))
    )
}
