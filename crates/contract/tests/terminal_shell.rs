#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io::Write;
use std::process::{Command, Stdio};

use ostia_contract::terminal_shell::{parse_shell_setting, shell_argv, shell_name};

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

const SHELL_PATH: &str = "/usr/bin:/bin";

fn run(setting: &str, fallback: &str, script: &str) -> String {
    let argv = shell_argv(setting, fallback);
    let mut child = Command::new(&argv[0])
        .args(&argv[1..])
        .env_clear()
        .env("PATH", SHELL_PATH)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(script.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn flags_of(out: &str) -> Option<&str> {
    let rest = out.split("flags=").nth(1)?;
    rest.split_whitespace().next()
}

#[test]
fn falls_back_to_the_login_shell_when_the_setting_is_empty() {
    assert_eq!(shell_argv("", "/bin/zsh"), strings(&["/bin/zsh"]));
    assert_eq!(shell_argv("   ", "/bin/zsh"), strings(&["/bin/zsh"]));
}

#[test]
fn splits_the_program_and_its_arguments_without_a_shell_keeping_quoted_words_whole() {
    assert_eq!(
        shell_argv("/usr/bin/fish", "/bin/zsh"),
        strings(&["/usr/bin/fish"])
    );
    assert_eq!(
        shell_argv("nu --config \"/home/me/my config.nu\"", "/bin/zsh"),
        strings(&["nu", "--config", "/home/me/my config.nu"])
    );
}

#[test]
fn treats_shell_syntax_as_plain_words() {
    assert_eq!(
        shell_argv("bash; rm -rf ~", "/bin/zsh"),
        strings(&["bash;", "rm", "-rf", "~"])
    );
}

#[test]
fn falls_back_on_an_unclosed_quote_an_empty_program_a_nul_byte_or_an_oversized_value() {
    assert_eq!(shell_argv("fish \"-l", "/bin/zsh"), strings(&["/bin/zsh"]));
    assert_eq!(shell_argv("\"\" -l", "/bin/zsh"), strings(&["/bin/zsh"]));
    assert_eq!(shell_argv("fish\0", "/bin/zsh"), strings(&["/bin/zsh"]));
    let oversized = format!("fish {}", "x".repeat(2000));
    assert_eq!(shell_argv(&oversized, "/bin/zsh"), strings(&["/bin/zsh"]));
}

#[test]
fn terminal_shell_starts_new_terminals_in_the_chosen_program_with_its_arguments() {
    let out = run(
        "/bin/sh -i",
        "/bin/false",
        "echo \"shell=$0 flags=$-\"\nexit\n",
    );
    assert!(out.contains("shell=/bin/sh"), "{out}");
    assert!(flags_of(&out).unwrap().contains('i'), "{out}");
}

#[test]
fn an_unusable_terminal_shell_falls_back_to_the_login_shell() {
    let out = run(
        "\"/bin/sh -i",
        "/bin/sh",
        "echo \"shell=$0 flags=$-\"\nexit\n",
    );
    assert!(out.contains("shell=/bin/sh"), "{out}");
    assert!(!flags_of(&out).unwrap().contains('i'), "{out}");
    assert_eq!(shell_argv("\"/bin/sh -i", "/bin/sh"), strings(&["/bin/sh"]));
}

#[test]
fn keeps_a_trimmed_string() {
    assert_eq!(parse_shell_setting("  /bin/fish  "), "/bin/fish");
}

#[test]
fn drops_a_value_over_the_length_limit_counted_in_utf16_units() {
    assert_eq!(parse_shell_setting(&"a".repeat(1024)), "a".repeat(1024));
    assert_eq!(parse_shell_setting(&"a".repeat(1025)), "");
    assert_eq!(parse_shell_setting(&"😀".repeat(512)), "😀".repeat(512));
    assert_eq!(parse_shell_setting(&"😀".repeat(513)), "");
}

#[test]
fn trims_the_javascript_space_set() {
    assert_eq!(parse_shell_setting("\u{feff} fish\u{a0}\n"), "fish");
}

#[test]
fn names_a_shell_by_the_last_part_of_its_program_path() {
    assert_eq!(shell_name("/usr/bin/zsh"), "zsh");
    assert_eq!(shell_name("/bin/bash"), "bash");
    assert_eq!(shell_name("fish"), "fish");
    assert_eq!(
        shell_name("C:\\Windows\\System32\\powershell.exe"),
        "powershell.exe"
    );
}

#[test]
fn is_empty_when_there_is_no_program_to_name() {
    assert_eq!(shell_name(""), "");
    assert_eq!(shell_name("/usr/bin/"), "");
}

#[test]
fn runs_the_shell_with_only_the_environment_the_test_gives() {
    let out = run("/bin/sh", "/bin/sh", "echo \"path=$PATH\"\n");
    assert!(out.contains(&format!("path={SHELL_PATH}\n")), "{out}");
}
