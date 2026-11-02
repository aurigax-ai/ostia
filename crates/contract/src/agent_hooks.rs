use serde_json::Value;

use crate::app_env::{EnvSource, app_env};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AgentHooks {
    pub claude: bool,
    pub codex: bool,
    pub agy: bool,
}

pub const DEFAULT_AGENT_HOOKS: AgentHooks = AgentHooks {
    claude: true,
    codex: true,
    agy: true,
};

pub fn parse_agent_hooks(raw: &Value) -> AgentHooks {
    let on = |name: &str| raw.get(name) != Some(&Value::Bool(false));
    AgentHooks {
        claude: on("claude"),
        codex: on("codex"),
        agy: on("agy"),
    }
}

pub fn agent_hooks_env(raw: &Value) -> EnvSource {
    let hooks = parse_agent_hooks(raw);
    let flag = |enabled: bool| if enabled { "" } else { "1" };
    app_env(&[
        ("NO_CLAUDE_HOOKS", flag(hooks.claude)),
        ("NO_CODEX_HOOKS", flag(hooks.codex)),
        ("NO_AGY_HOOKS", flag(hooks.agy)),
    ])
}
