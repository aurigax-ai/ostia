use ostia_contract::agent_plugins::{AgentHookEvent, HookAgent, hook_agents_for};
use ostia_contract::agent_skills::ExtensionAgentHook;
use serde_json::{Value, json};

pub const CLI_PATH: &str = "${OSTIA_CLI}";
pub const CLI_RUN: &str = r#"ELECTRON_RUN_AS_NODE=1 "${OSTIA_NODE}" "${OSTIA_CLI}""#;
pub const IN_PANE: &str = r#"[ -n "${OSTIA_SOCKET}" ]"#;
pub const AGENT_DIR: &str = "${OSTIA_AGENT_DIR}";

pub fn command_hook(command: &str) -> Value {
    json!({"type": "command", "command": command})
}

pub fn hook_command(cli_args: &str) -> String {
    format!("{IN_PANE} && {CLI_RUN} {cli_args} >/dev/null 2>&1 || true")
}

pub fn turn_hook_command(event: &str) -> String {
    format!(
        "{IN_PANE} && {{ input=$(cat); printf '%s' \"$input\" | {CLI_RUN} turn-hook {event} >/dev/null 2>&1 & }} || true"
    )
}

pub fn bus_hook_command(event: AgentHookEvent) -> String {
    format!(
        "{IN_PANE} && {CLI_RUN} bus hook {} 2>/dev/null || true",
        event.as_str()
    )
}

pub fn permission_hook_command(agent: HookAgent) -> String {
    format!(
        "{IN_PANE} && {CLI_RUN} permission-hook {} 2>/dev/null || true",
        agent.as_str()
    )
}

pub fn extension_hook_command(hook: &ExtensionAgentHook, agent: HookAgent) -> String {
    format!(
        "{IN_PANE} && {CLI_RUN} agent-hook {} {} {} {} 2>/dev/null || true",
        hook.ext_id,
        hook.command,
        agent.as_str(),
        hook.event.as_str()
    )
}

pub fn hooks_for(
    hooks: &[ExtensionAgentHook],
    agent: HookAgent,
    event: AgentHookEvent,
) -> Vec<String> {
    hooks
        .iter()
        .filter(|hook| hook.event == event && hook_agents_for(event).contains(&agent))
        .map(|hook| extension_hook_command(hook, agent))
        .collect()
}
