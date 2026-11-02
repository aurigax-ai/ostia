#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::agent_launch::{looks_secret, resume_flags};
use ostia_contract::agent_resume::{ResumableAgent, parse_agent_resume};
use serde_json::json;

fn flags(agent: ResumableAgent, argv: &[&str]) -> Vec<String> {
    let argv: Vec<String> = argv.iter().map(|arg| (*arg).to_owned()).collect();
    resume_flags(agent, &argv)
}

#[test]
fn keeps_an_allowed_flag_and_drops_one_that_skips_permissions() {
    assert_eq!(
        flags(
            ResumableAgent::Claude,
            &["--dangerously-skip-permissions", "--model", "opus"]
        ),
        ["--model", "opus"]
    );
}

#[test]
fn reads_a_short_alias_with_and_without_a_space() {
    assert_eq!(
        flags(ResumableAgent::Claude, &["-n", "work"]),
        ["--name", "work"]
    );
    assert_eq!(
        flags(ResumableAgent::Claude, &["-nwork"]),
        ["--name", "work"]
    );
    assert_eq!(
        flags(ResumableAgent::Claude, &["-n=work"]),
        ["--name", "work"]
    );
}

#[test]
fn keeps_only_the_allowed_values_of_a_checked_flag() {
    assert_eq!(
        flags(ResumableAgent::Claude, &["--permission-mode", "plan"]),
        ["--permission-mode", "plan"]
    );
    assert!(
        flags(
            ResumableAgent::Claude,
            &["--permission-mode", "bypassPermissions"]
        )
        .is_empty()
    );
    assert_eq!(
        flags(ResumableAgent::Codex, &["-s", "read-only"]),
        ["-s", "read-only"]
    );
    assert!(flags(ResumableAgent::Codex, &["-s", "danger-full-access"]).is_empty());
    assert_eq!(
        flags(ResumableAgent::Codex, &["-c", "model=x"]),
        ["-c", "model=x"]
    );
    assert!(flags(ResumableAgent::Codex, &["-c", "shell_environment=x"]).is_empty());
}

#[test]
fn an_optional_flag_never_takes_the_next_word() {
    assert!(flags(ResumableAgent::Claude, &["--debug", "api"]).is_empty());
    assert_eq!(
        flags(ResumableAgent::Claude, &["--debug=api"]),
        ["--debug=api"]
    );
    assert_eq!(flags(ResumableAgent::Claude, &["--debug"]), ["--debug"]);
}

#[test]
fn a_list_flag_needs_an_inline_value() {
    assert!(flags(ResumableAgent::Claude, &["--tools", "Bash"]).is_empty());
    assert_eq!(
        flags(ResumableAgent::Claude, &["--tools=Bash"]),
        ["--tools=Bash"]
    );
}

#[test]
fn stops_at_the_double_dash_and_skips_plain_words() {
    assert_eq!(
        flags(
            ResumableAgent::Claude,
            &["word", "--verbose", "--", "--bare"]
        ),
        ["--verbose"]
    );
}

#[test]
fn drops_a_value_that_looks_secret_or_starts_with_a_dash() {
    assert!(looks_secret("sk-0123456789abcdef0123"));
    assert!(looks_secret("https://me:pw@example.com"));
    assert!(!looks_secret("opus"));
    assert!(
        flags(
            ResumableAgent::Claude,
            &["--model", "sk-0123456789abcdef0123"]
        )
        .is_empty()
    );
    assert!(flags(ResumableAgent::Claude, &["--model", "--verbose"]).is_empty());
}

#[test]
fn parses_a_resume_and_writes_only_what_is_set() {
    let resume =
        parse_agent_resume(&json!({"agent": "claude", "id": "s1", "cwd": "/home/u"})).unwrap();
    assert_eq!(
        serde_json::to_string(&resume).unwrap(),
        r#"{"agent":"claude","id":"s1","cwd":"/home/u"}"#
    );
}

#[test]
fn refuses_an_unknown_agent_or_a_bad_id() {
    assert!(parse_agent_resume(&json!({"agent": "other", "id": "s1"})).is_none());
    assert!(parse_agent_resume(&json!({"agent": "claude", "id": "--bad"})).is_none());
    assert!(parse_agent_resume(&json!({"agent": "claude"})).is_none());
    assert!(parse_agent_resume(&json!("claude")).is_none());
}

#[test]
fn drops_a_relative_cwd_and_args_that_are_not_all_strings() {
    let resume = parse_agent_resume(
        &json!({"agent": "codex", "id": "s", "cwd": "rel", "args": ["--oss", 1]}),
    )
    .unwrap();
    assert_eq!(resume.cwd, None);
    assert!(resume.args.is_empty());
}
