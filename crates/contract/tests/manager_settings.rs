#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;

use ostia_contract::manager_settings::{
    ManagerLimits, ManagerSettings, manager_agents, parse_manager_settings,
};
use serde_json::{Value, json};

fn argv(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| (*part).to_owned()).collect()
}

#[test]
fn mgr_c16_keeps_valid_presets_and_drops_bad_names_empty_argv_and_non_strings() {
    let parsed = parse_manager_settings(&json!({
        "agents": {
            "aider": ["aider", "--yes"],
            "bad name": ["x"],
            "empty": [],
            "num": [1],
            "blank": [""]
        }
    }));
    assert_eq!(
        parsed.agents,
        BTreeMap::from([("aider".to_owned(), argv(&["aider", "--yes"]))])
    );
}

#[test]
fn mgr_c16_falls_back_to_defaults_without_a_manager_section() {
    assert_eq!(
        parse_manager_settings(&Value::Null),
        ManagerSettings::default()
    );
    assert_eq!(
        parse_manager_settings(&json!(["x"])),
        ManagerSettings::default()
    );
}

#[test]
fn mgr_c28_keeps_absolute_skill_folders_only_without_duplicates_or_dot_dot() {
    let parsed = parse_manager_settings(&json!({
        "skills": ["/home/u/skills/a", "rel/b", "/home/u/../etc", "/home/u/skills/a", 3]
    }));
    assert_eq!(parsed.skills, argv(&["/home/u/skills/a"]));
}

#[test]
fn mgr_c30_turns_typing_into_panes_on_only_for_a_literal_true() {
    assert!(parse_manager_settings(&json!({ "allowInput": true })).allow_input);
    assert!(!parse_manager_settings(&json!({ "allowInput": "yes" })).allow_input);
}

#[test]
fn mgr_c37_clamps_limits_and_falls_back_to_defaults_for_non_numbers() {
    let parsed = parse_manager_settings(&json!({
        "limits": { "maxWorkers": 999, "spawnsPer10Min": -3, "busPerMinute": "x" }
    }));
    assert_eq!(
        parsed.limits,
        ManagerLimits {
            max_workers: 64,
            spawns_per_10_min: 0,
            bus_per_minute: 60,
        }
    );
}

#[test]
fn mgr_c16_merges_presets_over_the_built_in_claude_codex_and_agy_interactive_prompt_via_i() {
    let agents = manager_agents(&parse_manager_settings(&json!({
        "agents": { "claude": ["claude", "--model", "opus"], "aider": ["aider"] }
    })));
    assert_eq!(
        agents,
        BTreeMap::from([
            ("claude".to_owned(), argv(&["claude", "--model", "opus"])),
            ("codex".to_owned(), argv(&["codex"])),
            ("agy".to_owned(), argv(&["agy", "-i"])),
            ("aider".to_owned(), argv(&["aider"])),
        ])
    );
}

#[test]
fn does_not_let_settings_replace_the_reserved_name() {
    let agents = manager_agents(&parse_manager_settings(
        &json!({ "agents": { "pi": ["pi"] } }),
    ));
    assert!(!agents.contains_key("pi"));
}

#[test]
fn defaults_are_eight_workers_twenty_spawns_and_sixty_bus_messages() {
    let defaults = ManagerSettings::default();
    assert!(defaults.agents.is_empty());
    assert!(defaults.skills.is_empty());
    assert!(!defaults.allow_input);
    assert_eq!(
        defaults.limits,
        ManagerLimits {
            max_workers: 8,
            spawns_per_10_min: 20,
            bus_per_minute: 60,
        }
    );
}

#[test]
fn rounds_limits_and_accepts_numeric_strings_as_number_does() {
    let parsed = parse_manager_settings(&json!({
        "limits": { "maxWorkers": 2.5, "spawnsPer10Min": "7", "busPerMinute": "" }
    }));
    assert_eq!(parsed.limits.max_workers, 3);
    assert_eq!(parsed.limits.spawns_per_10_min, 7);
    assert_eq!(parsed.limits.bus_per_minute, 0);
}

#[test]
fn refuses_argv_over_the_count_and_length_caps() {
    let long = "a".repeat(4097);
    let many: Vec<String> = (0..65).map(|n| format!("a{n}")).collect();
    let at_cap: Vec<String> = (0..64).map(|n| format!("a{n}")).collect();
    let parsed = parse_manager_settings(&json!({
        "agents": { "long": [long], "many": many, "cap": at_cap, "fine": ["a".repeat(4096)] }
    }));
    let names: Vec<&str> = parsed.agents.keys().map(String::as_str).collect();
    assert_eq!(names, vec!["cap", "fine"]);
}

#[test]
fn checks_agent_names_against_the_manager_pattern() {
    let sixty_four = format!("a{}", "b".repeat(63));
    let sixty_five = format!("a{}", "b".repeat(64));
    let parsed = parse_manager_settings(&json!({
        "agents": {
            sixty_four.clone(): ["x"],
            sixty_five: ["x"],
            "-lead": ["x"],
            "a.b_c-d": ["x"],
            "é": ["x"]
        }
    }));
    let mut names: Vec<&str> = parsed.agents.keys().map(String::as_str).collect();
    names.sort_unstable();
    assert_eq!(names, vec!["a.b_c-d", sixty_four.as_str()]);
}

#[test]
fn caps_skills_at_thirty_two_and_refuses_a_path_over_4096_units() {
    let many: Vec<String> = (0..40).map(|n| format!("/s/{n}")).collect();
    let parsed = parse_manager_settings(&json!({ "skills": many }));
    assert_eq!(parsed.skills.len(), 32);
    assert_eq!(parsed.skills.first().map(String::as_str), Some("/s/0"));
    let long = format!("/{}", "a".repeat(4096));
    let parsed = parse_manager_settings(&json!({ "skills": [long, "/ok"] }));
    assert_eq!(parsed.skills, argv(&["/ok"]));
}

#[test]
fn ignores_a_skills_value_that_is_not_a_list() {
    assert!(
        parse_manager_settings(&json!({ "skills": "/a" }))
            .skills
            .is_empty()
    );
}
