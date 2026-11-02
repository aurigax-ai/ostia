#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::agent_hooks::{AgentHooks, agent_hooks_env, parse_agent_hooks};
use ostia_contract::app_env::app_env;
use serde_json::json;

fn hooks(claude: bool, codex: bool, agy: bool) -> AgentHooks {
    AgentHooks { claude, codex, agy }
}

#[test]
fn keeps_every_agent_on_unless_a_switch_is_exactly_false() {
    assert_eq!(
        parse_agent_hooks(&serde_json::Value::Null),
        hooks(true, true, true)
    );
    assert_eq!(
        parse_agent_hooks(&json!({ "claude": false, "codex": "no", "agy": 0 })),
        hooks(false, true, true)
    );
    assert!(!parse_agent_hooks(&json!({ "agy": false })).agy);
}

#[test]
fn marks_the_agents_turned_off_in_the_spawn_environment_and_clears_an_inherited_mark() {
    assert_eq!(
        agent_hooks_env(&json!({})),
        app_env(&[
            ("NO_CLAUDE_HOOKS", ""),
            ("NO_CODEX_HOOKS", ""),
            ("NO_AGY_HOOKS", ""),
        ])
    );
    assert_eq!(
        agent_hooks_env(&json!({ "codex": false })),
        app_env(&[
            ("NO_CLAUDE_HOOKS", ""),
            ("NO_CODEX_HOOKS", "1"),
            ("NO_AGY_HOOKS", ""),
        ])
    );
    assert_eq!(
        agent_hooks_env(&json!({ "claude": false, "codex": false, "agy": false })),
        app_env(&[
            ("NO_CLAUDE_HOOKS", "1"),
            ("NO_CODEX_HOOKS", "1"),
            ("NO_AGY_HOOKS", "1"),
        ])
    );
}

#[test]
fn reads_a_non_object_as_every_agent_on() {
    for raw in [json!(null), json!(true), json!("claude"), json!([false])] {
        assert_eq!(
            parse_agent_hooks(&raw),
            hooks(true, true, true),
            "raw {raw}"
        );
    }
}
