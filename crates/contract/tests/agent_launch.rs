#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::agent_launch::{
    AGENT_ARGS_SEPARATOR, TypedLaunch, captured_args, leads_with_flag, looks_secret, resume_flags,
    typed_launch, typed_launch_of,
};
use ostia_contract::agent_resume::{ResumableAgent, parse_agent_resume};
use ostia_contract::app_env::app_env;
use serde_json::{Map, Value, json};

use ResumableAgent::{Agy, Claude, Codex};

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

fn flags(agent: ResumableAgent, argv: &[&str]) -> Vec<String> {
    resume_flags(agent, &strings(argv))
}

fn launch(args: &[&str], env: &[(&str, &str)]) -> TypedLaunch {
    TypedLaunch {
        args: strings(args),
        env: env
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect(),
    }
}

fn joined(items: &[&str]) -> String {
    items.join(AGENT_ARGS_SEPARATOR)
}

#[test]
fn keeps_the_model_effort_and_a_permission_mode_that_never_accepts_on_its_own_in_both_spellings() {
    assert_eq!(
        flags(
            Claude,
            &[
                "--model=opus",
                "--effort",
                "high",
                "--permission-mode",
                "plan"
            ]
        ),
        [
            "--model",
            "opus",
            "--effort",
            "high",
            "--permission-mode",
            "plan"
        ]
    );
    for mode in ["manual", "dontAsk", "plan"] {
        assert_eq!(
            flags(Claude, &["--permission-mode", mode]),
            ["--permission-mode", mode],
            "mode {mode}"
        );
    }
}

#[test]
fn keeps_the_shape_a_coordinator_starts_a_line_with() {
    assert_eq!(
        flags(
            Claude,
            &[
                "--agent",
                "twai-yushan",
                "-n",
                "Slack 推播上線",
                "--dangerously-skip-permissions"
            ]
        ),
        ["--name", "Slack 推播上線"]
    );
    assert_eq!(flags(Claude, &["--name=修 probe"]), ["--name", "修 probe"]);
}

#[test]
fn drops_the_prompt_print_mode_an_old_session_and_flags_that_conflict_with_resume() {
    assert_eq!(
        flags(
            Claude,
            &[
                "-p",
                "--resume",
                "old-id",
                "-r",
                "--continue",
                "-c",
                "--session-id",
                "0b7c6a52-1111-2222-3333-444455556666",
                "--fork-session",
                "--from-pr",
                "12",
                "--output-format",
                "json",
                "--model",
                "sonnet",
                "fix the tests",
            ]
        ),
        ["--model", "sonnet"]
    );
}

#[test]
fn stops_at_and_treats_everything_after_it_as_the_prompt() {
    assert_eq!(
        flags(Claude, &["--verbose", "--", "--model", "opus"]),
        ["--verbose"]
    );
}

#[test]
fn keeps_list_and_optional_value_flags_only_when_their_value_is_attached_so_a_prompt_is_never_stored()
 {
    assert_eq!(
        flags(
            Claude,
            &[
                "--tools=Read,Edit",
                "--disallowedTools=Bash(rm *)",
                "--debug=api,hooks",
                "-dhooks",
                "-d",
                "--bare",
            ]
        ),
        [
            "--tools=Read,Edit",
            "--disallowedTools=Bash(rm *)",
            "--debug=api,hooks",
            "--debug=hooks",
            "--debug",
            "--bare",
        ]
    );
    let prompts: [&[&str]; 5] = [
        &["--tools", "Read", "fix the login bug"],
        &["--betas", "x", "fix the login bug"],
        &["--disallowedTools", "Edit", "fix the login bug"],
        &["--debug", "fix the login bug"],
        &["-d", "fix the login bug"],
    ];
    for argv in prompts {
        let mut full = argv.to_vec();
        full.extend(["--model", "opus"]);
        assert_eq!(flags(Claude, &full), ["--model", "opus"], "argv {argv:?}");
    }
    assert_eq!(flags(Claude, &["--debug"]), ["--debug"]);
}

#[test]
fn reads_back_the_flags_it_replays_the_same_way() {
    let once = flags(
        Claude,
        &[
            "--disallowed-tools=Bash(rm *)",
            "--debug=api",
            "--model",
            "opus",
            "-n",
            "x",
        ],
    );
    assert_eq!(resume_flags(Claude, &once), once);
}

#[test]
fn drops_a_flag_that_carries_a_secret_a_control_character_or_a_value_that_is_too_long() {
    let secret = format!("use {}-{}", "sk", "a".repeat(20));
    let long = "x".repeat(2049);
    assert_eq!(
        flags(
            Claude,
            &[
                "--append-system-prompt",
                &secret,
                "--append-system-prompt",
                "a\u{1b}b",
                "--system-prompt",
                &long,
                "--model",
                "opus",
            ]
        ),
        ["--model", "opus"]
    );
}

#[test]
fn refuses_a_value_that_starts_with_a_dash_so_a_dropped_flag_never_becomes_the_value() {
    assert_eq!(
        flags(
            Claude,
            &[
                "--model",
                "--dangerously-skip-permissions",
                "--name=-x",
                "-n",
                "ok"
            ]
        ),
        ["--name", "ok"]
    );
    assert_eq!(
        flags(
            Codex,
            &["-m", "--yolo", "-c", "-model=\"x\"", "-m", "gpt-5"]
        ),
        ["-m", "gpt-5"]
    );
}

#[test]
fn drops_a_value_flag_that_has_no_value_and_a_boolean_flag_given_one() {
    assert!(flags(Claude, &["--verbose=yes", "--model"]).is_empty());
}

#[test]
fn keeps_whole_flags_only_up_to_the_size_limit() {
    let many: Vec<&str> = (0..40).flat_map(|_| ["--model", "a"]).collect();
    let out = flags(Claude, &many);
    assert_eq!(out.len(), 64);
    assert_eq!(out[out.len() - 2], "--model");
}

#[test]
fn keeps_model_model_config_sandbox_and_approval_flags_that_stay_sandboxed_short_or_long() {
    assert_eq!(
        flags(
            Codex,
            &[
                "-m",
                "gpt-5",
                "-c",
                "model_reasoning_effort=\"high\"",
                "--sandbox=workspace-write",
                "-a",
                "on-request",
                "--search",
                "fix it",
            ]
        ),
        [
            "-m",
            "gpt-5",
            "-c",
            "model_reasoning_effort=\"high\"",
            "--sandbox",
            "workspace-write",
            "-a",
            "on-request",
            "--search",
        ]
    );
}

#[test]
fn drops_the_resume_and_fork_subcommands_with_their_session_the_prompt_images_and_the_folder() {
    assert_eq!(
        flags(
            Codex,
            &[
                "resume",
                "01a0f04c-15fd-7b22-8538-ca8250a46988",
                "--last",
                "--all",
                "-i",
                "shot.png",
                "-C",
                "/elsewhere",
                "--worktree",
                "-m",
                "gpt-5",
                "continue",
            ]
        ),
        ["-m", "gpt-5"]
    );
    assert_eq!(flags(Codex, &["fork", "--last", "--oss"]), ["--oss"]);
}

#[test]
fn drops_a_config_override_that_holds_a_key_a_password_or_an_environment() {
    for config in [
        "model_providers.x.api_key=\"abc\"",
        "mcp_servers.gh.env.GH=\"x\"",
        "env.FOO=\"bar\"",
        "shell_environment_policy.set.DB_PW=\"x\"",
        "x.password=\"x\"",
        "x.pin=\"1234\"",
    ] {
        assert_eq!(
            flags(Codex, &["-c", config, "--oss"]),
            ["--oss"],
            "{config}"
        );
        assert_eq!(
            flags(Codex, &[&format!("--config={config}"), "--oss"]),
            ["--oss"],
            "{config}"
        );
    }
    assert_eq!(
        flags(Codex, &["-c", "model=\"gpt-5\""]),
        ["-c", "model=\"gpt-5\""]
    );
}

#[test]
fn replays_only_flags_codex_resume_accepts_never_one_the_hook_args_already_pass() {
    assert_eq!(
        flags(Codex, &["--oss", "--no-daemon", "--full-auto", "--last"]),
        ["--oss"]
    );
}

const CLAUDE_ESCAPES: &[&str] = &[
    "--agent",
    "ostia",
    "--permission-mode",
    "acceptEdits",
    "--dangerously-skip-permissions",
    "--allow-dangerously-skip-permissions",
    "--permission-mode",
    "bypassPermissions",
    "--permission-mode=auto",
    "--settings",
    "/tmp/s.json",
    "--setting-sources",
    "project",
    "--mcp-config=/tmp/m.json",
    "--plugin-dir",
    "/tmp/p",
    "--plugin-url",
    "https://example.com/p.zip",
    "--agents",
    "/tmp/a.json",
    "--add-dir=/",
    "--allowedTools=Bash",
    "--allowed-tools=Bash",
    "--system-prompt-file",
    "/tmp/p.md",
    "--append-system-prompt-file",
    "/tmp/p.md",
    "--debug-file",
    "/home/j/.bashrc",
    "--chrome",
];

const CODEX_ESCAPES: &[&str] = &[
    "--dangerously-bypass-approvals-and-sandbox",
    "--yolo",
    "-s",
    "danger-full-access",
    "--sandbox=danger-full-access",
    "-a",
    "never",
    "--ask-for-approval=never",
    "-c",
    "sandbox_mode=\"danger-full-access\"",
    "-c",
    "approval_policy=\"never\"",
    "-c",
    "notify=[\"sh\",\"-c\",\"id\"]",
    "--config=mcp_servers.x.command=\"sh\"",
    "-c",
    "sandbox_workspace_write.network_access=true",
    "-c",
    "shell_environment_policy.inherit=\"all\"",
    "-c",
    "default_permissions=\"full\"",
    "-c",
    "environment_name=\"x\"",
    "--add-dir",
    "/",
    "-p",
    "yolo",
    "--profile=yolo",
    "--enable",
    "computer_use",
    "--disable",
    "guardian_approval",
    "--approve-for-me",
    "--dangerously-bypass-hook-trust",
    "--remote",
    "ws://h:1",
    "--remote-auth-token-env",
    "T",
];

#[test]
fn drops_each_claude_flag_that_skips_permissions_or_loads_settings_plugins_tools_or_files() {
    assert_eq!(
        flags(Claude, &[CLAUDE_ESCAPES, &["--model", "opus"]].concat()),
        ["--model", "opus"]
    );
}

#[test]
fn drops_each_codex_flag_that_leaves_the_sandbox_or_its_approvals_or_loads_config() {
    assert_eq!(
        flags(Codex, &[CODEX_ESCAPES, &["-m", "gpt-5"]].concat()),
        ["-m", "gpt-5"]
    );
}

#[test]
fn reads_the_arguments_the_shell_function_recorded_for_that_agent_only() {
    let recorded = joined(&["--name", "two words", "say hi"]);
    let env = app_env(&[("CLAUDE_ARGS", &recorded)]);
    assert_eq!(
        captured_args(Claude, &env),
        Some(strings(&["--name", "two words"]))
    );
    assert_eq!(captured_args(Codex, &env), None);
    assert_eq!(
        captured_args(Claude, &app_env(&[("CLAUDE_ARGS", "")])),
        Some(Vec::new())
    );
    assert_eq!(captured_args(Claude, &app_env(&[])), None);
}

#[test]
fn never_reports_a_flag_that_leaves_the_sandbox_or_skips_approvals() {
    let codex = joined(&[CODEX_ESCAPES, &["-m", "gpt-5"]].concat());
    assert_eq!(
        captured_args(Codex, &app_env(&[("CODEX_ARGS", &codex)])),
        Some(strings(&["-m", "gpt-5"]))
    );
    let claude = joined(&[CLAUDE_ESCAPES, &["--model", "opus"]].concat());
    assert_eq!(
        captured_args(Claude, &app_env(&[("CLAUDE_ARGS", &claude)])),
        Some(strings(&["--model", "opus"]))
    );
}

#[test]
fn spots_common_token_shapes_and_leaves_paths_and_ids_alone() {
    let secrets = [
        format!("gh{}_{}", "p", "a1".repeat(15)),
        format!("gl{}-abc", "pat"),
        format!("xo{}-1-2", "xb"),
        format!("AK{}{}", "IA", "B".repeat(16)),
        format!("ey{}hbGciOiJIUzI1NiJ9.payload", "J"),
        format!("https://user:{}@example.com", "pass"),
        "A".repeat(40),
    ];
    for text in &secrets {
        assert!(looks_secret(text), "{text}");
    }
    for text in [
        "/Users/someone/Projects/AurigaX/ostia-685/worktrees/fix",
        "0b7c6a52-1111-2222-3333-444455556666",
        "opus",
        "model_reasoning_effort=\"high\"",
    ] {
        assert!(!looks_secret(text), "{text}");
    }
}

const COORDINATOR_LINE: &str = "CLAUDE_CONFIG_DIR='/Users/j/.claude-profiles/twai' GL_ISSUE='HomeProjects/tracker#24' claude --agent ostia -n 'Ostia 統籌' --model opus --effort high --dangerously-skip-permissions";

#[test]
fn keeps_the_variables_and_the_flags_the_allow_list_drops_from_a_line_the_human_typed() {
    let typed = launch(
        &["--agent", "ostia", "--dangerously-skip-permissions"],
        &[
            ("CLAUDE_CONFIG_DIR", "/Users/j/.claude-profiles/twai"),
            ("GL_ISSUE", "HomeProjects/tracker#24"),
        ],
    );
    assert_eq!(typed_launch(Claude, COORDINATOR_LINE), Some(typed.clone()));
    assert_eq!(
        typed_launch(Claude, &format!("cd '/Users/j/w' && {COORDINATOR_LINE}")),
        Some(typed.clone())
    );
    assert_eq!(
        typed_launch(
            Claude,
            &format!("(true) && cd \"$HOME/w\"; {COORDINATOR_LINE}")
        ),
        Some(typed)
    );
}

#[test]
fn keeps_every_permission_and_sandbox_escape_a_human_can_type_for_each_agent() {
    assert_eq!(
        typed_launch(
            Claude,
            "claude --permission-mode bypassPermissions --settings /p/s.json --add-dir=/x --plugin-dir /p"
        ),
        Some(launch(
            &[
                "--permission-mode",
                "bypassPermissions",
                "--settings",
                "/p/s.json",
                "--add-dir=/x",
                "--plugin-dir",
                "/p",
            ],
            &[]
        ))
    );
    assert_eq!(
        typed_launch(
            Codex,
            "CODEX_HOME=/c codex --yolo -s danger-full-access -a never -c 'sandbox_mode=danger-full-access' -m gpt-5 --add-dir /x"
        ),
        Some(launch(
            &[
                "--yolo",
                "-s",
                "danger-full-access",
                "-a",
                "never",
                "-c",
                "sandbox_mode=danger-full-access",
                "--add-dir",
                "/x",
            ],
            &[("CODEX_HOME", "/c")]
        ))
    );
}

#[test]
fn reads_the_line_ostia_types_back_on_resume_so_the_next_resume_keeps_it_all() {
    assert_eq!(
        typed_launch(
            Claude,
            "CLAUDE_CONFIG_DIR=/p GL_ISSUE='24#1' 'claude' --resume abc --name n --agent ostia --dangerously-skip-permissions"
        ),
        Some(launch(
            &["--agent", "ostia", "--dangerously-skip-permissions"],
            &[("CLAUDE_CONFIG_DIR", "/p"), ("GL_ISSUE", "24#1")]
        ))
    );
    assert_eq!(
        typed_launch(Codex, "CODEX_HOME=/c 'codex' resume abc --yolo"),
        Some(launch(&["--yolo"], &[("CODEX_HOME", "/c")]))
    );
}

#[test]
fn never_stores_a_variable_whose_name_looks_secret_loads_code_or_belongs_to_ostia() {
    assert_eq!(
        typed_launch(
            Claude,
            "GH_TOKEN=x API_KEY=y DB_PASSWORD=z OSTIA_TOKEN=t NODE_OPTIONS=--x PATH=/b CLAUDE_CONFIG_DIR=rel GL_ISSUE=7 claude"
        ),
        Some(launch(&[], &[("GL_ISSUE", "7")]))
    );
    assert_eq!(
        typed_launch(Claude, &format!("GL_ISSUE={} claude", "x".repeat(40))),
        None
    );
}

#[test]
fn keeps_the_session_log_switch_a_coordinator_sets_though_its_name_says_session() {
    assert_eq!(
        typed_launch(
            Claude,
            "CLAUDE_SKIP_SESSION_LOG=1 CLAUDE_SESSION_TOKEN=x SESSION_ID=y claude"
        ),
        Some(launch(&[], &[("CLAUDE_SKIP_SESSION_LOG", "1")]))
    );
}

#[test]
fn never_stores_a_variable_that_points_the_agent_git_or_an_interpreter_at_other_code() {
    for name in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_SSH",
        "GIT_ASKPASS",
        "CLAUDE_CODE_SHELL_PREFIX",
        "CLAUDE_CODE_SHELL",
        "ANTHROPIC_BASE_URL",
        "OPENAI_BASE_URL",
        "HTTPS_PROXY",
        "https_proxy",
        "PYTHONHOME",
        "RUBYLIB",
        "PERLLIB",
        "CLASSPATH",
        "SHELL",
        "NPM_CONFIG_PREFIX",
        "path",
    ] {
        assert_eq!(
            typed_launch(Claude, &format!("{name}=/x GL_ISSUE=1 claude")),
            Some(launch(&[], &[("GL_ISSUE", "1")])),
            "{name}"
        );
    }
}

#[test]
fn reads_one_value_of_a_list_flag_written_with_a_space_with_the_same_value_rules() {
    assert_eq!(
        typed_launch(
            Claude,
            r#"claude --add-dir /a --mcp-config /m.json --mcp-config '{"x":1}' --add-dir --agent b fix"#
        ),
        Some(launch(
            &["--add-dir=/a", "--mcp-config=/m.json", "--agent", "b"],
            &[]
        ))
    );
    assert_eq!(
        typed_launch(Codex, "codex --add-dir /a"),
        Some(launch(&["--add-dir", "/a"], &[]))
    );
}

#[test]
fn drops_a_value_it_cannot_read_without_running_the_shell_or_one_that_looks_secret() {
    assert_eq!(
        typed_launch(
            Claude,
            r#"GL_ISSUE="$X" claude --agent $A --settings '{"env":{}}' --agent ok"#
        ),
        Some(launch(&["--agent", "ok"], &[]))
    );
    assert_eq!(
        typed_launch(
            Codex,
            "codex -c 'env.OPENAI_API_KEY=x' -c 'auth_token=y' --yolo"
        ),
        Some(launch(&["--yolo"], &[]))
    );
}

#[test]
fn reads_nothing_when_the_line_does_not_start_that_agent() {
    assert_eq!(
        typed_launch(Codex, "claude --dangerously-skip-permissions"),
        None
    );
    assert_eq!(typed_launch(Claude, "echo claude --agent x"), None);
    assert_eq!(typed_launch(Claude, "my-claude --agent x"), None);
    assert_eq!(typed_launch(Claude, "claude --agent 'x"), None);
    assert_eq!(typed_launch(Claude, "claude --model opus"), None);
}

#[test]
fn keeps_only_the_variables_in_front_of_the_agent_itself() {
    assert_eq!(typed_launch(Claude, "GL_ISSUE=1; claude"), None);
    assert_eq!(typed_launch(Claude, "export GL_ISSUE=1 && claude"), None);
    assert_eq!(
        typed_launch(Claude, "A=1 cd /w && B=2 claude"),
        Some(launch(&[], &[("B", "2")]))
    );
}

#[test]
fn stops_at_the_end_of_the_agents_own_command() {
    assert_eq!(
        typed_launch(
            Claude,
            "claude --agent a && rm -rf --dangerously-skip-permissions"
        ),
        Some(launch(&["--agent", "a"], &[]))
    );
}

#[test]
fn filters_a_stored_record_again_so_it_never_holds_a_carried_unknown_or_unsafe_part() {
    assert_eq!(
        typed_launch_of(
            Claude,
            &json!({
                "args": [
                    "--model",
                    "opus",
                    "--resume",
                    "x",
                    "--agent",
                    "a",
                    "--dangerously-skip-permissions"
                ],
                "env": { "GL_ISSUE": "1", "GH_TOKEN": "x", "LD_PRELOAD": "/x.so" },
            })
        ),
        Some(launch(
            &["--agent", "a", "--dangerously-skip-permissions"],
            &[("GL_ISSUE", "1")]
        ))
    );
    assert_eq!(
        typed_launch_of(Claude, &json!({ "args": "--agent a", "env": [] })),
        None
    );
    assert_eq!(typed_launch_of(Claude, &Value::Null), None);
}

#[test]
fn keeps_only_the_agy_model_and_effort_flags() {
    assert_eq!(
        flags(
            Agy,
            &["--model", "m", "--effort", "high", "--yolo", "--verbose"]
        ),
        ["--model", "m", "--effort", "high"]
    );
    assert_eq!(
        typed_launch(Agy, "agy --model m --yolo"),
        None,
        "agy has no typed flag beyond the carried ones"
    );
}

#[test]
fn sees_a_dash_or_a_plus_after_leading_space_as_a_flag() {
    for (text, expected) in [
        ("--model", true),
        ("-m", true),
        ("+x", true),
        ("  \t--model", true),
        ("\u{feff}-x", true),
        ("fix the tests", false),
        ("", false),
        ("a -b", false),
    ] {
        assert_eq!(leads_with_flag(text), expected, "text {text:?}");
    }
}

#[test]
fn refuses_a_line_longer_than_the_command_limit() {
    let at_limit = format!("claude --agent a {}", "# ".repeat(10));
    assert!(typed_launch(Claude, &at_limit).is_some());
    let padded = format!("claude --agent a{}", " ".repeat(16384));
    assert_eq!(typed_launch(Claude, &padded), None);
}

#[test]
fn keeps_at_most_32_variables_in_the_order_given() {
    let env: Map<String, Value> = (0..40)
        .map(|n| (format!("V{n}"), Value::String("1".to_owned())))
        .collect();
    let typed = typed_launch_of(Claude, &json!({ "env": env })).unwrap();
    assert_eq!(typed.env.len(), 32);
    assert_eq!(typed.env[0].0, "V0");
    assert_eq!(typed.env[31].0, "V31");
}

#[test]
fn keeps_an_env_value_up_to_1024_units_and_drops_a_longer_one() {
    let at_limit = "a ".repeat(512);
    let over = format!("{at_limit}a");
    let typed = typed_launch_of(
        Claude,
        &json!({ "env": { "A": at_limit, "B": over, "C": 5 } }),
    )
    .unwrap();
    assert_eq!(typed.env, vec![("A".to_owned(), at_limit)]);
}

#[test]
fn keeps_an_absolute_config_dir_of_either_style_and_drops_a_relative_one() {
    let typed = typed_launch_of(
        Claude,
        &json!({ "env": {
            "CLAUDE_CONFIG_DIR": "C:\\Users\\j",
            "CODEX_HOME": "d:/codex",
            "GL_ISSUE": "rel",
        } }),
    )
    .unwrap();
    assert_eq!(
        typed.env,
        vec![
            ("CLAUDE_CONFIG_DIR".to_owned(), "C:\\Users\\j".to_owned()),
            ("CODEX_HOME".to_owned(), "d:/codex".to_owned()),
            ("GL_ISSUE".to_owned(), "rel".to_owned()),
        ]
    );
    assert_eq!(
        typed_launch_of(Claude, &json!({ "env": { "CODEX_HOME": "codex" } })),
        None
    );
}

#[test]
fn drops_a_variable_name_that_is_not_a_shell_name() {
    let long = "A".repeat(65);
    assert_eq!(
        typed_launch_of(
            Claude,
            &json!({ "env": { "1A": "x", "A-B": "x", "": "x", long: "x", "A_1": "x" } })
        ),
        Some(launch(&[], &[("A_1", "x")]))
    );
}

#[test]
fn serializes_a_typed_launch_without_empty_parts_and_with_env_as_an_object() {
    let typed = launch(&["--agent", "a"], &[("GL_ISSUE", "1"), ("B", "2")]);
    assert_eq!(
        serde_json::to_string(&typed).unwrap(),
        r#"{"args":["--agent","a"],"env":{"GL_ISSUE":"1","B":"2"}}"#
    );
    assert_eq!(
        serde_json::to_string(&launch(&[], &[("B", "2")])).unwrap(),
        r#"{"env":{"B":"2"}}"#
    );
    assert_eq!(
        serde_json::to_string(&launch(&["--yolo"], &[])).unwrap(),
        r#"{"args":["--yolo"]}"#
    );
}

#[test]
fn keeps_the_typed_launch_of_a_stored_resume_after_filtering_it_again() {
    let resume = parse_agent_resume(&json!({
        "agent": "claude",
        "id": "abc",
        "typed": {
            "args": ["--model", "opus", "--agent", "a"],
            "env": { "GL_ISSUE": "1", "GH_TOKEN": "x" },
        },
    }))
    .unwrap();
    assert_eq!(
        resume.typed,
        Some(launch(&["--agent", "a"], &[("GL_ISSUE", "1")]))
    );
    assert_eq!(
        serde_json::to_string(&resume).unwrap(),
        r#"{"agent":"claude","id":"abc","typed":{"args":["--agent","a"],"env":{"GL_ISSUE":"1"}}}"#
    );
}

#[test]
fn leaves_the_typed_launch_out_of_a_stored_resume_that_has_nothing_to_keep() {
    for typed in [
        json!(null),
        json!("x"),
        json!({}),
        json!({ "args": ["--model", "opus"], "env": { "GH_TOKEN": "x" } }),
    ] {
        let resume = parse_agent_resume(&json!({
            "agent": "claude",
            "id": "abc",
            "typed": typed,
        }))
        .unwrap();
        assert_eq!(resume.typed, None, "typed {typed}");
        assert_eq!(
            serde_json::to_string(&resume).unwrap(),
            r#"{"agent":"claude","id":"abc"}"#,
            "typed {typed}"
        );
    }
}
