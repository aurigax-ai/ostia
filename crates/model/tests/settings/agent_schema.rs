#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;

use ostia_model::settings::actions::{ACTION_ICONS, ACTION_TITLE_MAX, ACTIONS_MAX};
use ostia_model::settings::agent_schema::{
    actions_schema, agent_host_schema, agents_schema, approvals_schema, assistant_schema,
    capabilities_schema, manager_schema, playbooks_schema, privacy_schema, trusted_actions_schema,
};
use serde_json::{Value, json};

fn expected() -> Value {
    let file = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/rust/agent-schema.json");
    serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap()
}

#[test]
fn builds_every_settings_schema_the_ts_app_builds_with_the_same_text_and_key_order() {
    let table = expected();
    let built: [(&str, Value); 10] = [
        ("actionsSchema", actions_schema()),
        ("agentHostSchema", agent_host_schema()),
        ("agentsSchema", agents_schema()),
        ("approvalsSchema", approvals_schema()),
        ("assistantSchema", assistant_schema()),
        ("capabilitiesSchema", capabilities_schema()),
        ("managerSchema", manager_schema()),
        ("playbooksSchema", playbooks_schema()),
        ("privacySchema", privacy_schema()),
        ("trustedActionsSchema", trusted_actions_schema()),
    ];
    assert_eq!(table.as_object().unwrap().len(), built.len());
    for (name, schema) in built {
        let want = &table[name];
        assert_eq!(&schema, want, "{name}");
        assert_eq!(
            serde_json::to_string(&schema).unwrap(),
            serde_json::to_string(want).unwrap(),
            "{name} key order"
        );
    }
}

#[test]
fn takes_the_action_limits_and_icons_from_the_actions_module() {
    let schema = actions_schema();
    assert_eq!(schema["maxItems"], json!(ACTIONS_MAX));
    let properties = &schema["items"]["properties"];
    assert_eq!(properties["title"]["maxLength"], json!(ACTION_TITLE_MAX));
    assert_eq!(properties["icon"]["enum"], json!(ACTION_ICONS));
}
