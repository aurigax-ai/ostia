#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::process::Command;

use ostia_contract::shell_quote::{quote_arg, quote_argv};

fn argv(words: &[&str]) -> Vec<String> {
    words.iter().map(|word| (*word).to_owned()).collect()
}

fn shell_words(line: &str) -> Vec<Vec<u8>> {
    let out = Command::new("/bin/sh")
        .arg("-c")
        .arg(format!("printf '%s\\0' {line}"))
        .output()
        .unwrap();
    assert!(out.status.success());
    let mut words: Vec<Vec<u8>> = out
        .stdout
        .split(|byte| *byte == 0)
        .map(<[u8]>::to_vec)
        .collect();
    words.pop();
    words
}

#[test]
fn leaves_plain_words_bare_so_the_command_reads_naturally() {
    assert_eq!(
        quote_argv(&argv(&[
            "sudo",
            "pacman",
            "-S",
            "--needed",
            "ripgrep",
            "libfoo-dev:amd64"
        ])),
        "sudo pacman -S --needed ripgrep libfoo-dev:amd64"
    );
}

#[test]
fn single_quotes_anything_with_shell_syntax_including_a_leading() {
    assert_eq!(quote_arg("a b"), "'a b'");
    assert_eq!(quote_arg("$(rm -rf ~)"), "'$(rm -rf ~)'");
    assert_eq!(quote_arg("=ls"), "'=ls'");
    assert_eq!(quote_arg("~/notes"), "'~/notes'");
    assert_eq!(quote_arg("a=b"), "'a=b'");
    assert_eq!(quote_arg(""), "''");
    assert_eq!(quote_arg("it's"), "'it'\\''s'");
}

#[test]
fn round_trips_hostile_arguments_through_a_real_shell_unchanged() {
    let words = argv(&[
        "echo", "it's", "$HOME", "`id`", "a;b", "*", "~", "x|y", "\"q\"", "\\n", "",
    ]);
    let expected: Vec<Vec<u8>> = words.iter().map(|word| word.as_bytes().to_vec()).collect();
    assert_eq!(shell_words(&quote_argv(&words)), expected);
}

#[test]
fn quotes_a_non_ascii_word_and_an_empty_argv() {
    assert_eq!(quote_arg("café"), "'café'");
    assert_eq!(quote_argv(&[]), "");
}
