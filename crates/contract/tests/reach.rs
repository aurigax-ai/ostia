#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::reach::{
    AgentGroupPlacement, REACH_MODES, ReachMode, is_reach_mode, parse_reach_mode,
};
use serde_json::{Value, json};

#[test]
fn lists_the_reach_modes_in_order() {
    assert_eq!(
        REACH_MODES,
        [ReachMode::Workspace, ReachMode::Project, ReachMode::Group]
    );
}

#[test]
fn writes_each_reach_mode_as_its_lowercase_name() {
    for (mode, name) in [
        (ReachMode::Workspace, "workspace"),
        (ReachMode::Project, "project"),
        (ReachMode::Group, "group"),
    ] {
        assert_eq!(serde_json::to_value(mode).unwrap(), json!(name), "{name}");
    }
}

#[test]
fn accepts_only_a_string_that_names_a_reach_mode() {
    for name in ["workspace", "project", "group"] {
        assert!(is_reach_mode(&json!(name)), "{name}");
    }
    let refused: [Value; 9] = [
        json!(""),
        json!("Group"),
        json!("project "),
        json!("all"),
        json!(null),
        json!(1),
        json!(true),
        json!(["group"]),
        json!({"mode": "group"}),
    ];
    for raw in refused {
        assert!(!is_reach_mode(&raw), "{raw}");
    }
}

#[test]
fn keeps_a_valid_reach_mode_and_falls_back_to_project() {
    assert_eq!(parse_reach_mode(&json!("workspace")), ReachMode::Workspace);
    assert_eq!(parse_reach_mode(&json!("project")), ReachMode::Project);
    assert_eq!(parse_reach_mode(&json!("group")), ReachMode::Group);
    for raw in [json!("Group"), json!(""), json!(null), json!(3), json!({})] {
        assert_eq!(parse_reach_mode(&raw), ReachMode::Project, "{raw}");
    }
}

#[test]
fn writes_a_group_placement_with_camel_case_keys_in_field_order() {
    let placement = AgentGroupPlacement {
        workspace_id: "w1".to_owned(),
        group_id: "g1".to_owned(),
    };
    assert_eq!(
        serde_json::to_string(&placement).unwrap(),
        r#"{"workspaceId":"w1","groupId":"g1"}"#
    );
}
