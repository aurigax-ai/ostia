#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::agent_skills::ExtensionAgentHook;
use ostia_terminal::agent_hook_commands::{
    AGENT_DIR, CLI_PATH, CLI_RUN, IN_PANE, bus_hook_command, command_hook, extension_hook_command,
    hook_command, hooks_for, permission_hook_command, turn_hook_command,
};
use serde_json::json;

const EVENTS: [&str; 7] = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "SessionEnd",
    "Notification",
];

fn hook(ext_id: &str, event: &str, command: &str) -> ExtensionAgentHook {
    ExtensionAgentHook {
        ext_id: ext_id.to_owned(),
        event: event.to_owned(),
        command: command.to_owned(),
    }
}

#[test]
fn names_the_cli_the_socket_check_and_the_agent_folder_as_shell_variables() {
    assert_eq!(CLI_PATH, "${OSTIA_CLI}");
    assert_eq!(
        CLI_RUN,
        r#"ELECTRON_RUN_AS_NODE=1 "${OSTIA_NODE}" "${OSTIA_CLI}""#
    );
    assert_eq!(IN_PANE, r#"[ -n "${OSTIA_SOCKET}" ]"#);
    assert_eq!(AGENT_DIR, "${OSTIA_AGENT_DIR}");
}

#[test]
fn wraps_a_command_as_a_command_hook_with_type_first() {
    let hook = command_hook("echo hi");
    assert_eq!(hook, json!({"type": "command", "command": "echo hi"}));
    assert_eq!(
        hook.to_string(),
        r#"{"type":"command","command":"echo hi"}"#
    );
}

#[test]
fn runs_the_cli_quietly_inside_a_pane_and_never_fails_the_hook() {
    assert_eq!(
        hook_command("notify --kind done"),
        r#"[ -n "${OSTIA_SOCKET}" ] && ELECTRON_RUN_AS_NODE=1 "${OSTIA_NODE}" "${OSTIA_CLI}" notify --kind done >/dev/null 2>&1 || true"#
    );
}

#[test]
fn passes_the_turn_hook_input_to_a_background_cli_run() {
    assert_eq!(
        turn_hook_command("Stop"),
        r#"[ -n "${OSTIA_SOCKET}" ] && { input=$(cat); printf '%s' "$input" | ELECTRON_RUN_AS_NODE=1 "${OSTIA_NODE}" "${OSTIA_CLI}" turn-hook Stop >/dev/null 2>&1 & } || true"#
    );
}

#[test]
fn runs_the_bus_hook_for_each_event_and_keeps_its_error_output_off() {
    for event in EVENTS {
        let name = event;
        assert_eq!(
            bus_hook_command(event),
            format!(
                r#"[ -n "${{OSTIA_SOCKET}}" ] && ELECTRON_RUN_AS_NODE=1 "${{OSTIA_NODE}}" "${{OSTIA_CLI}}" bus hook {name} 2>/dev/null || true"#
            ),
            "{name}"
        );
    }
}

#[test]
fn runs_the_permission_hook_for_each_agent() {
    assert_eq!(
        permission_hook_command("claude"),
        r#"[ -n "${OSTIA_SOCKET}" ] && ELECTRON_RUN_AS_NODE=1 "${OSTIA_NODE}" "${OSTIA_CLI}" permission-hook claude 2>/dev/null || true"#
    );
    assert_eq!(
        permission_hook_command("codex"),
        r#"[ -n "${OSTIA_SOCKET}" ] && ELECTRON_RUN_AS_NODE=1 "${OSTIA_NODE}" "${OSTIA_CLI}" permission-hook codex 2>/dev/null || true"#
    );
}

#[test]
fn runs_an_extension_hook_with_its_extension_command_agent_and_event() {
    let hook = hook("acme.notes", "PreToolUse", "check");
    assert_eq!(
        extension_hook_command(&hook, "codex"),
        r#"[ -n "${OSTIA_SOCKET}" ] && ELECTRON_RUN_AS_NODE=1 "${OSTIA_NODE}" "${OSTIA_CLI}" agent-hook acme.notes check codex PreToolUse 2>/dev/null || true"#
    );
}

#[test]
fn keeps_only_the_hooks_for_the_event_in_the_order_given() {
    let hooks = vec![
        hook("a", "Stop", "one"),
        hook("b", "SessionStart", "skip"),
        hook("c", "Stop", "two"),
    ];
    let commands = hooks_for(&hooks, "claude", "Stop");
    assert_eq!(
        commands,
        vec![
            extension_hook_command(&hooks[0], "claude"),
            extension_hook_command(&hooks[2], "claude"),
        ]
    );
}

#[test]
fn gives_a_claude_only_event_to_claude_and_not_to_codex() {
    let hooks = vec![hook("a", "Notification", "ping")];
    assert_eq!(
        hooks_for(&hooks, "claude", "Notification"),
        vec![extension_hook_command(&hooks[0], "claude")]
    );
    assert_eq!(
        hooks_for(&hooks, "codex", "Notification"),
        Vec::<String>::new()
    );
}

#[test]
fn gives_every_other_event_to_both_agents() {
    for event in EVENTS.into_iter().filter(|event| *event != "Notification") {
        let hooks = vec![hook("a", event, "run")];
        for agent in ["claude", "codex"] {
            assert_eq!(
                hooks_for(&hooks, agent, event),
                vec![extension_hook_command(&hooks[0], agent)],
                "{event:?} {agent:?}"
            );
        }
    }
}

#[test]
fn returns_nothing_when_there_are_no_hooks() {
    assert_eq!(hooks_for(&[], "claude", "Stop"), Vec::<String>::new());
}
