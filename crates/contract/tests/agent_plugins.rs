#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_base::js::utf16_len;
use ostia_contract::agent_plugins::{
    AGENT_HOOK_CONTEXT_EVENTS, AGENT_HOOK_CONTEXT_MAX, AGENT_HOOK_EVENTS, AGENT_HOOK_INPUT_MAX,
    AGENT_PLUGIN_CAPABILITY, AGENT_SKILL_DESCRIPTION_MAX, AGENT_SKILL_ENTRY,
    AGENT_SKILL_FILE_MAX_BYTES, AGENT_SKILL_FILE_PATTERN, AGENT_SKILL_MAX_BYTES,
    AGENT_SKILL_NAME_PATTERN, HOOK_AGENTS, MAX_AGENT_HOOKS, MAX_AGENT_SKILL_FILES,
    MAX_AGENT_SKILLS, RESERVED_SKILL_IDS, agent_hook_output, agent_skill_id, hook_agents_for,
    is_agent_hook_event, is_hook_agent, skill_directive,
};
use serde_json::{Value, json};

#[test]
fn keeps_the_contract_constants() {
    assert_eq!(AGENT_PLUGIN_CAPABILITY, "agent-plugin");
    assert_eq!(HOOK_AGENTS, ["claude", "codex"]);
    assert_eq!(
        AGENT_HOOK_EVENTS,
        [
            "SessionStart",
            "UserPromptSubmit",
            "PreToolUse",
            "PostToolUse",
            "Stop",
            "SessionEnd",
            "Notification",
        ]
    );
    assert_eq!(
        AGENT_HOOK_CONTEXT_EVENTS,
        ["SessionStart", "UserPromptSubmit"]
    );
    assert_eq!(AGENT_SKILL_ENTRY, "SKILL.md");
    assert_eq!(MAX_AGENT_SKILLS, 8);
    assert_eq!(MAX_AGENT_SKILL_FILES, 16);
    assert_eq!(MAX_AGENT_HOOKS, 16);
    assert_eq!(AGENT_SKILL_FILE_MAX_BYTES, 262_144);
    assert_eq!(AGENT_SKILL_MAX_BYTES, 1_048_576);
    assert_eq!(AGENT_SKILL_DESCRIPTION_MAX, 1024);
    assert_eq!(AGENT_HOOK_INPUT_MAX, 1_048_576);
    assert_eq!(AGENT_HOOK_CONTEXT_MAX, 10_000);
    assert_eq!(RESERVED_SKILL_IDS, ["ostia", "ostia-manager"]);
}

#[test]
fn sends_the_notification_event_to_claude_only_and_every_other_event_to_both_agents() {
    assert_eq!(hook_agents_for("Notification"), ["claude"]);
    for event in AGENT_HOOK_EVENTS.iter().filter(|e| **e != "Notification") {
        assert_eq!(hook_agents_for(event), ["claude", "codex"], "{event}");
    }
}

#[test]
fn accepts_only_the_listed_hook_agents() {
    assert!(is_hook_agent(&json!("claude")));
    assert!(is_hook_agent(&json!("codex")));
    let refused = [
        json!("Claude"),
        json!("gemini"),
        json!(""),
        json!(1),
        Value::Null,
        json!(["claude"]),
        json!({"claude": true}),
    ];
    for value in refused {
        assert!(!is_hook_agent(&value), "{value}");
    }
}

#[test]
fn accepts_only_the_listed_hook_events() {
    for event in AGENT_HOOK_EVENTS {
        assert!(is_agent_hook_event(&json!(event)), "{event}");
    }
    let refused = [
        json!("sessionstart"),
        json!("PreCompact"),
        json!(""),
        json!(0),
        Value::Null,
        json!(["Stop"]),
    ];
    for value in refused {
        assert!(!is_agent_hook_event(&value), "{value}");
    }
}

#[test]
fn builds_a_skill_id_from_the_extension_id_and_the_skill_name() {
    assert_eq!(agent_skill_id("acme", "review"), "acme-review");
}

#[test]
fn accepts_a_lowercase_skill_name_of_up_to_40_characters() {
    let accepted = [
        "a",
        "review",
        "code-review-2",
        &format!("a{}", "b".repeat(39)),
    ];
    for name in accepted {
        assert!(AGENT_SKILL_NAME_PATTERN.is_match(name), "{name}");
    }
}

#[test]
fn refuses_a_skill_name_that_is_empty_too_long_or_not_lowercase_kebab() {
    let refused = [
        "",
        "1skill",
        "-skill",
        "Skill",
        "my_skill",
        "my skill",
        "skill\n",
        "skill.md",
        &format!("a{}", "b".repeat(40)),
    ];
    for name in refused {
        assert!(!AGENT_SKILL_NAME_PATTERN.is_match(name), "{name:?}");
    }
}

#[test]
fn accepts_a_markdown_or_text_skill_file_name_and_refuses_every_other_name() {
    let accepted = [
        "SKILL.md",
        "notes.txt",
        "a.md",
        "0.txt",
        "my_file-1.v2.md",
        &format!("a{}.md", "b".repeat(56)),
    ];
    for name in accepted {
        assert!(AGENT_SKILL_FILE_PATTERN.is_match(name), "{name}");
    }
    let refused = [
        "",
        ".md",
        "-a.md",
        "_a.md",
        "a.MD",
        "a.json",
        "a.md.exe",
        "a md.md",
        "dir/a.md",
        "../a.md",
        "a.md\n",
        &format!("a{}.md", "b".repeat(60)),
    ];
    for name in refused {
        assert!(!AGENT_SKILL_FILE_PATTERN.is_match(name), "{name:?}");
    }
}

#[test]
fn writes_hook_context_for_session_start_and_user_prompt_submit() {
    assert_eq!(
        agent_hook_output("SessionStart", Some("hello")).as_deref(),
        Some(
            r#"{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"hello"}}"#
        )
    );
    assert_eq!(
        agent_hook_output("UserPromptSubmit", Some("hi")).as_deref(),
        Some(
            r#"{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"hi"}}"#
        )
    );
}

#[test]
fn writes_no_hook_output_for_an_event_that_takes_no_context() {
    for event in AGENT_HOOK_EVENTS
        .iter()
        .filter(|e| !AGENT_HOOK_CONTEXT_EVENTS.contains(e))
    {
        assert_eq!(agent_hook_output(event, Some("hello")), None, "{event}");
    }
}

#[test]
fn writes_no_hook_output_for_missing_or_blank_text() {
    assert_eq!(agent_hook_output("SessionStart", None), None);
    assert_eq!(agent_hook_output("SessionStart", Some("")), None);
    assert_eq!(
        agent_hook_output("SessionStart", Some(" \t\r\n\u{feff}\u{a0}\u{2028}")),
        None
    );
}

#[test]
fn trims_the_hook_context_with_the_js_space_set_and_keeps_inner_text() {
    let output = agent_hook_output("SessionStart", Some("\u{feff} a  b \n")).unwrap();
    let parsed: Value = serde_json::from_str(&output).unwrap();
    assert_eq!(parsed["hookSpecificOutput"]["additionalContext"], "a  b");
}

#[test]
fn cuts_the_hook_context_to_10000_utf16_units_after_the_trim() {
    let long = format!("  {}", "é".repeat(AGENT_HOOK_CONTEXT_MAX + 5));
    let output = agent_hook_output("UserPromptSubmit", Some(&long)).unwrap();
    let parsed: Value = serde_json::from_str(&output).unwrap();
    let context = parsed["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap();
    assert_eq!(utf16_len(context), AGENT_HOOK_CONTEXT_MAX);
    assert!(context.chars().all(|c| c == 'é'));
}

#[test]
fn writes_the_hook_output_keys_in_the_order_ts_writes_them() {
    let output = agent_hook_output("SessionStart", Some("x\"y")).unwrap();
    assert_eq!(
        output,
        r#"{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"x\"y"}}"#
    );
}

#[test]
fn passes_a_skill_text_with_no_shell_injection() {
    assert_eq!(skill_directive(""), None);
    assert_eq!(
        skill_directive("# Skill\n\nUse `ls` to list. Say hi!\n"),
        None
    );
    assert_eq!(skill_directive("! `not adjacent`"), None);
    assert_eq!(skill_directive("``! only two ticks"), None);
    assert_eq!(skill_directive("~~ ! two tildes"), None);
    assert_eq!(skill_directive("price is 5$ !"), None);
}

#[test]
fn refuses_an_inline_shell_injection_and_names_the_line() {
    let message = "line 1: shell injection (!` or a ```! block) is not allowed";
    assert_eq!(skill_directive("!`rm -rf /`").as_deref(), Some(message));
    assert_eq!(skill_directive("run !$HOME now").as_deref(), Some(message));
    assert_eq!(
        skill_directive("ok\nok\nrun !`id`").as_deref(),
        Some("line 3: shell injection (!` or a ```! block) is not allowed")
    );
}

#[test]
fn refuses_a_fenced_shell_injection_with_backticks_or_tildes() {
    for text in [
        "```!\nid\n```",
        "````! id",
        "~~~!\nid",
        "```  \t$HOME",
        "~~~~$x",
    ] {
        assert!(skill_directive(text).is_some(), "{text:?}");
    }
}

#[test]
fn refuses_look_alike_characters_after_nfkc_folding() {
    let cases = [
        "\u{01c3}`id`",
        "!\u{02cb}id",
        "!\u{02f4}id",
        "!\u{2035}id",
        "\u{ff01}\u{ff40}id",
        "\u{02cb}\u{02cb}\u{02cb}!",
        "\u{2035}\u{2035}\u{2035}\u{01c3}",
        "~~~\u{ff01}",
    ];
    for text in cases {
        assert!(skill_directive(text).is_some(), "{text:?}");
    }
}

#[test]
fn counts_every_line_break_style_when_it_names_the_line() {
    let breaks = ["\n", "\r", "\r\n", "\u{85}", "\u{2028}", "\u{2029}"];
    for sep in breaks {
        let text = format!("a{sep}b{sep}!`x");
        assert_eq!(
            skill_directive(&text).as_deref(),
            Some("line 3: shell injection (!` or a ```! block) is not allowed"),
            "{sep:?}"
        );
    }
}

#[test]
fn does_not_join_two_lines_into_one_injection() {
    assert_eq!(skill_directive("!\n`id`"), None);
    assert_eq!(skill_directive("```\n!"), None);
}
