#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;

use ostia_contract::agent_launch::{TypedLaunch, looks_secret, resume_flags, typed_launch};
use ostia_contract::agent_resume::{
    AgentResume, CannotFork, ResumableAgent, can_fork, fork_command, parse_agent_resume,
    parse_stored_resume, resume_command,
};
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

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

fn resume_of(agent: ResumableAgent, id: &str, args: &[&str]) -> AgentResume {
    AgentResume {
        agent,
        id: id.to_owned(),
        cwd: None,
        args: strings(args),
        typed: None,
    }
}

fn typed_claude() -> AgentResume {
    AgentResume {
        args: strings(&["--name", "Ostia 統籌", "--model", "opus"]),
        typed: Some(TypedLaunch {
            args: strings(&["--agent", "ostia", "--dangerously-skip-permissions"]),
            env: vec![
                (
                    "CLAUDE_CONFIG_DIR".to_owned(),
                    "/Users/j/.claude-profiles/twai".to_owned(),
                ),
                ("GL_ISSUE".to_owned(), "tracker#24".to_owned()),
            ],
        }),
        ..resume_of(ResumableAgent::Claude, "abc", &[])
    }
}

fn typed_codex() -> AgentResume {
    AgentResume {
        typed: Some(TypedLaunch {
            args: strings(&["--yolo", "-s", "danger-full-access"]),
            env: vec![("CODEX_HOME".to_owned(), "/c".to_owned())],
        }),
        ..resume_of(ResumableAgent::Codex, "r-9", &[])
    }
}

#[test]
fn never_takes_the_typed_launch_from_a_caller() {
    let from_caller = parse_agent_resume(&json!({
        "agent": "claude",
        "id": "abc",
        "args": ["--model", "opus"],
        "typed": {"args": ["--dangerously-skip-permissions"], "env": {"GL_ISSUE": "1"}},
    }))
    .unwrap();
    assert_eq!(from_caller.typed, None);
    assert_eq!(
        serde_json::to_string(&from_caller).unwrap(),
        r#"{"agent":"claude","id":"abc","args":["--model","opus"]}"#
    );
}

#[test]
fn takes_the_typed_launch_only_from_a_stored_record() {
    for resume in [typed_claude(), typed_codex()] {
        let raw = serde_json::to_value(&resume).unwrap();
        assert_eq!(parse_stored_resume(&raw), Some(resume));
    }
}

#[test]
fn filters_the_typed_launch_again_when_reading_a_stored_record() {
    let resume = parse_stored_resume(&json!({
        "agent": "claude",
        "id": "abc",
        "typed": {
            "args": ["--model", "opus", "--agent", "a"],
            "env": {"GH_TOKEN": "x", "BASH_ENV": "/x", "GL_ISSUE": "1"},
        },
    }))
    .unwrap();
    assert_eq!(
        resume.typed,
        Some(TypedLaunch {
            args: strings(&["--agent", "a"]),
            env: vec![("GL_ISSUE".to_owned(), "1".to_owned())],
        })
    );
    let empty = parse_stored_resume(&json!({
        "agent": "claude",
        "id": "abc",
        "typed": {"args": ["--yolo"], "env": {}},
    }))
    .unwrap();
    assert_eq!(empty.typed, None);
}

#[test]
fn keeps_the_typed_launch_when_a_stored_resume_builds_the_resume_and_fork_line() {
    let stored = parse_stored_resume(&serde_json::to_value(typed_claude()).unwrap()).unwrap();
    assert_eq!(
        resume_command(&stored),
        "CLAUDE_CONFIG_DIR=/Users/j/.claude-profiles/twai GL_ISSUE='tracker#24' 'claude' --resume abc --name 'Ostia 統籌' --model opus --agent ostia --dangerously-skip-permissions"
    );
    assert_eq!(
        fork_command(&stored).unwrap(),
        "CLAUDE_CONFIG_DIR=/Users/j/.claude-profiles/twai GL_ISSUE='tracker#24' 'claude' --resume abc --fork-session --name 'Ostia 統籌' --model opus --agent ostia --dangerously-skip-permissions"
    );
}

#[test]
fn builds_each_agents_own_resume_command() {
    assert_eq!(
        resume_command(&resume_of(ResumableAgent::Claude, "abc", &[])),
        "'claude' --resume abc"
    );
    assert_eq!(
        resume_command(&resume_of(ResumableAgent::Codex, "abc", &[])),
        "'codex' resume abc"
    );
}

#[test]
fn replays_the_flags_after_the_session_quoted_for_the_shell() {
    assert_eq!(
        resume_command(&resume_of(
            ResumableAgent::Claude,
            "abc",
            &["--model", "opus", "--append-system-prompt", "it's done"]
        )),
        "'claude' --resume abc --model opus --append-system-prompt 'it'\\''s done'"
    );
    assert_eq!(
        resume_command(&resume_of(
            ResumableAgent::Codex,
            "abc",
            &["-c", "model_reasoning_effort=\"high\""]
        )),
        "'codex' resume abc -c 'model_reasoning_effort=\"high\"'"
    );
}

#[test]
fn quotes_a_flag_value_that_holds_an_equals_sign() {
    assert_eq!(
        resume_command(&resume_of(
            ResumableAgent::Codex,
            "abc",
            &["-c", "model_verbosity=low"]
        )),
        "'codex' resume abc -c 'model_verbosity=low'"
    );
}

#[test]
fn never_replays_an_escaping_flag_even_from_a_record_built_by_hand() {
    assert_eq!(
        resume_command(&resume_of(
            ResumableAgent::Codex,
            "abc",
            &[
                "--yolo",
                "-s",
                "danger-full-access",
                "-c",
                "notify=[\"sh\"]",
                "-m",
                "gpt-5"
            ]
        )),
        "'codex' resume abc -m gpt-5"
    );
    assert_eq!(
        fork_command(&resume_of(
            ResumableAgent::Claude,
            "abc",
            &[
                "--dangerously-skip-permissions",
                "--agent",
                "x",
                "--model",
                "opus"
            ]
        ))
        .unwrap(),
        "'claude' --resume abc --fork-session --model opus"
    );
}

#[test]
fn builds_each_agents_own_fork_command() {
    assert_eq!(
        fork_command(&resume_of(ResumableAgent::Claude, "abc", &[])).unwrap(),
        "'claude' --resume abc --fork-session"
    );
    assert_eq!(
        fork_command(&resume_of(ResumableAgent::Codex, "abc", &[])).unwrap(),
        "'codex' fork abc"
    );
}

#[test]
fn carries_the_saved_flags_after_the_session_on_a_fork() {
    let claude = AgentResume {
        cwd: Some("/home/u/proj".to_owned()),
        ..resume_of(
            ResumableAgent::Claude,
            "abc",
            &["--model", "opus", "--append-system-prompt", "it's done"],
        )
    };
    assert_eq!(
        fork_command(&claude).unwrap(),
        "'claude' --resume abc --fork-session --model opus --append-system-prompt 'it'\\''s done'"
    );
    assert_eq!(
        fork_command(&resume_of(
            ResumableAgent::Codex,
            "abc",
            &["-c", "model_reasoning_effort=\"high\""]
        ))
        .unwrap(),
        "'codex' fork abc -c 'model_reasoning_effort=\"high\"'"
    );
}

#[test]
fn saves_no_fork_flag_for_the_forks_own_resume() {
    for agent in [ResumableAgent::Claude, ResumableAgent::Codex] {
        let line = fork_command(&resume_of(agent, "abc", &[])).unwrap();
        let words: Vec<&str> = line.split(' ').skip(2).collect();
        let parsed = parse_agent_resume(&json!({"agent": agent, "id": "new", "args": words}));
        assert_eq!(parsed, Some(resume_of(agent, "new", &[])));
    }
}

#[test]
fn resumes_agy_with_the_conversation_flag_and_keeps_only_the_allow_listed_flags() {
    assert_eq!(
        resume_command(&resume_of(
            ResumableAgent::Agy,
            "c-1",
            &[
                "--model",
                "Gemini 3",
                "--dangerously-skip-permissions",
                "--mode",
                "auto"
            ]
        )),
        "'agy' --conversation c-1 --model 'Gemini 3'"
    );
}

#[test]
fn has_no_agy_fork() {
    assert!(!can_fork(ResumableAgent::Agy));
    assert!(can_fork(ResumableAgent::Claude));
    let refused = fork_command(&resume_of(ResumableAgent::Agy, "c-1", &[])).unwrap_err();
    assert_eq!(refused, CannotFork(ResumableAgent::Agy));
    assert_eq!(refused.to_string(), "agy cannot fork");
}

#[test]
fn replays_the_typed_launch_in_front_of_and_after_the_session() {
    assert_eq!(
        resume_command(&typed_claude()),
        "CLAUDE_CONFIG_DIR=/Users/j/.claude-profiles/twai GL_ISSUE='tracker#24' 'claude' --resume abc --name 'Ostia 統籌' --model opus --agent ostia --dangerously-skip-permissions"
    );
    assert_eq!(
        fork_command(&typed_codex()).unwrap(),
        "CODEX_HOME=/c 'codex' fork r-9 --yolo -s danger-full-access"
    );
}

#[test]
fn reads_the_typed_launch_back_from_the_line_ostia_types() {
    for resume in [typed_claude(), typed_codex()] {
        assert_eq!(
            typed_launch(resume.agent, &resume_command(&resume)),
            resume.typed
        );
    }
}

fn has_shell(shell: &str) -> bool {
    Command::new(shell)
        .args(["-c", "true"])
        .status()
        .is_ok_and(|status| status.success())
}

fn fake_claude(dir: &Path) {
    let agent = dir.join("claude");
    std::fs::write(&agent, "#!/bin/sh\necho \"REAL $*\"\n").unwrap();
    std::fs::set_permissions(&agent, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn run_line(shell: &str, dir: &Path, line: &str) -> String {
    let script = "claude() { echo \"WRAPPED $*\"; command claude \"$@\"; }\nalias claude='echo ALIAS'\nalias ccr='claude --resume'\neval \"$LINE\"\n";
    let flags: &[&str] = if shell == "bash" {
        &["-O", "expand_aliases"]
    } else {
        &["-f"]
    };
    let output = Command::new(shell)
        .args(flags)
        .args(["-c", script])
        .env_clear()
        .env("PATH", format!("{}:/usr/bin:/bin", dir.display()))
        .env("LINE", line)
        .output()
        .unwrap();
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

#[test]
fn skips_the_humans_alias_but_keeps_ostias_claude_function_in_bash_and_zsh() {
    for shell in ["bash", "zsh"] {
        if !has_shell(shell) {
            continue;
        }
        let dir = tempfile::tempdir().unwrap();
        fake_claude(dir.path());
        let claude = resume_of(ResumableAgent::Claude, "abc", &[]);
        assert_eq!(
            run_line(shell, dir.path(), "claude --resume abc"),
            "ALIAS --resume abc",
            "{shell}"
        );
        assert_eq!(
            run_line(shell, dir.path(), &resume_command(&claude)),
            "WRAPPED --resume abc\nREAL --resume abc",
            "{shell}"
        );
        assert_eq!(
            run_line(shell, dir.path(), &fork_command(&claude).unwrap()),
            "WRAPPED --resume abc --fork-session\nREAL --resume abc --fork-session",
            "{shell}"
        );
    }
}

#[test]
fn runs_as_valid_fish_and_keeps_ostias_claude_function() {
    if !has_shell("fish") {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    fake_claude(dir.path());
    let line = resume_command(&resume_of(
        ResumableAgent::Claude,
        "abc",
        &["--model", "opus"],
    ));
    let output = Command::new("fish")
        .args([
            "--no-config",
            "-c",
            "function claude; echo \"WRAPPED $argv\"; command claude $argv; end; eval $LINE",
        ])
        .env_clear()
        .env("PATH", format!("{}:/usr/bin:/bin", dir.path().display()))
        .env("HOME", dir.path())
        .env("LINE", line)
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        "WRAPPED --resume abc --model opus\nREAL --resume abc --model opus"
    );
}
