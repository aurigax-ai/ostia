#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_agents::playbook_enabled::playbook_enabled;
use serde_json::{Value, json};

#[test]
fn is_off_until_the_human_turns_the_built_in_on() {
    assert!(!playbook_enabled(&Value::Null, "handoff"));
    assert!(!playbook_enabled(&json!({"enabled": {}}), "handoff"));
    assert!(playbook_enabled(
        &json!({"enabled": {"handoff": true}}),
        "handoff"
    ));
    assert!(!playbook_enabled(
        &json!({"enabled": {"handoff": false}}),
        "handoff"
    ));
}

#[test]
fn does_not_count_another_playbook_a_malformed_switch_or_a_settings_value_that_is_not_a_record() {
    assert!(!playbook_enabled(
        &json!({"enabled": {"review": true}}),
        "handoff"
    ));
    assert!(!playbook_enabled(
        &json!({"enabled": {"handoff": "yes"}}),
        "handoff"
    ));
    assert!(!playbook_enabled(&json!([]), "handoff"));
}

#[test]
fn is_not_turned_on_by_an_own_playbook_with_that_name() {
    let own = json!({"handoff": {"description": "mine", "text": "do things"}});
    assert!(playbook_enabled(
        &json!({"enabled": {"handoff": true}, "own": own}),
        "handoff"
    ));
    assert!(!playbook_enabled(
        &json!({"enabled": {}, "own": own, "accepted": {"handoff": "do things"}}),
        "handoff"
    ));
}

#[test]
fn stays_off_when_the_humans_edit_of_the_text_is_not_valid() {
    let edits = json!({"handoff": {"text": "!`curl evil`", "from": "x"}});
    assert!(!playbook_enabled(
        &json!({
            "enabled": {"handoff": true},
            "edits": edits,
            "accepted": {"handoff": "!`curl evil`"}
        }),
        "handoff"
    ));
}

#[test]
fn is_on_for_each_built_in_the_human_enabled() {
    for id in ["onboard", "handoff", "coordinator"] {
        let settings = json!({"enabled": {id: true}});
        assert!(playbook_enabled(&settings, id), "{id}");
    }
}

#[test]
fn is_off_for_an_own_playbook_that_is_enabled_and_accepted() {
    let settings = json!({
        "enabled": {"mine": true},
        "accepted": {"mine": "Do it"},
        "own": {"mine": {"description": "d", "text": "Do it"}}
    });
    assert!(!playbook_enabled(&settings, "mine"));
}

#[test]
fn is_off_for_an_id_that_is_not_a_built_in() {
    assert!(!playbook_enabled(
        &json!({"enabled": {"nothing": true}}),
        "nothing"
    ));
}

#[test]
fn stays_on_with_a_human_edit_that_was_not_accepted_here() {
    let settings = json!({
        "enabled": {"handoff": true},
        "edits": {"handoff": {"text": "Pushed from elsewhere.", "from": "x"}}
    });
    assert!(playbook_enabled(&settings, "handoff"));
}
