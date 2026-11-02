#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_base::{PaneId, WindowId, WorkspaceId};
use ostia_control::command_args::{SCRIPT_COMMANDS, external_pane_message, internal_pane_args};
use ostia_control::{IdRegistry, PaneIdentity, PaneInput};
use serde_json::json;

fn registry() -> IdRegistry {
    IdRegistry::new(&[3; 32])
}

fn pane(registry: &IdRegistry, id: &str) -> PaneIdentity {
    registry.register_pane(PaneInput {
        window_id: WindowId::new("w1"),
        workspace_id: WorkspaceId::new("s1"),
        pane_id: PaneId::new(id),
    })
}

#[test]
fn script_commands_lists_the_commands_a_script_token_may_run() {
    let expected = [
        "workspace.new",
        "pane.close",
        "workspace.close",
        "workspace.group",
        "workspace.groupColor",
        "workspace.groupRename",
        "workspace.groupDelete",
        "workspace.pin",
        "workspace.unpin",
        "workspace.ungroup",
        "workspace.newScratch",
    ];
    assert_eq!(SCRIPT_COMMANDS.len(), expected.len());
    for name in expected {
        assert!(SCRIPT_COMMANDS.contains(&name), "{name}");
    }
    assert!(!SCRIPT_COMMANDS.contains(&"pane.run"));
}

#[test]
fn internal_pane_args_passes_args_that_are_not_an_object_through_with_no_pane() {
    let registry = registry();
    for args in [
        json!(null),
        json!("pane"),
        json!(7),
        json!(true),
        json!(["p1"]),
    ] {
        let (out, pane) = internal_pane_args(&registry, &args).unwrap();
        assert_eq!(out, args, "{args}");
        assert!(pane.is_none(), "{args}");
    }
}

#[test]
fn internal_pane_args_passes_an_object_without_a_string_pane_id_through() {
    let registry = registry();
    for args in [
        json!({}),
        json!({"name": "x"}),
        json!({"paneId": 5}),
        json!({"paneId": null}),
        json!({"paneId": ["p1"]}),
    ] {
        let (out, pane) = internal_pane_args(&registry, &args).unwrap();
        assert_eq!(out, args, "{args}");
        assert!(pane.is_none(), "{args}");
    }
}

#[test]
fn internal_pane_args_refuses_an_unknown_pane_id_and_names_where_to_find_one() {
    let registry = registry();
    let error = internal_pane_args(&registry, &json!({"paneId": "nope"})).unwrap_err();
    assert_eq!(
        error,
        "unknown-pane: nope (use a paneId from ostia pane list)"
    );
}

#[test]
fn internal_pane_args_refuses_an_empty_pane_id() {
    let registry = registry();
    let error = internal_pane_args(&registry, &json!({"paneId": ""})).unwrap_err();
    assert_eq!(error, "unknown-pane:  (use a paneId from ostia pane list)");
}

#[test]
fn internal_pane_args_refuses_an_id_that_is_not_a_pane() {
    let registry = registry();
    let extension = registry.register_extension("ext.one");
    let script = registry.register_script("script-1");
    for identity in [extension, script] {
        let given = identity.external_id.as_str();
        let error = internal_pane_args(&registry, &json!({"paneId": given})).unwrap_err();
        assert_eq!(
            error,
            format!("unknown-pane: {given} (use a paneId from ostia pane list)")
        );
    }
}

#[test]
fn internal_pane_args_swaps_the_external_id_for_the_internal_pane_id_and_returns_the_pane() {
    let registry = registry();
    let identity = pane(&registry, "pane-internal-1");
    let args = json!({"paneId": identity.external_id.as_str(), "text": "ls", "enter": true});
    let (out, resolved) = internal_pane_args(&registry, &args).unwrap();
    assert_eq!(
        out,
        json!({"paneId": "pane-internal-1", "text": "ls", "enter": true})
    );
    assert_eq!(resolved.unwrap().external_id, identity.external_id);
}

#[test]
fn internal_pane_args_does_not_change_the_args_it_was_given() {
    let registry = registry();
    let identity = pane(&registry, "pane-internal-2");
    let args = json!({"paneId": identity.external_id.as_str()});
    let before = args.clone();
    internal_pane_args(&registry, &args).unwrap();
    assert_eq!(args, before);
}

#[test]
fn external_pane_message_returns_the_message_when_there_is_no_pane() {
    assert_eq!(
        external_pane_message("pane pane-internal-1 failed", None),
        "pane pane-internal-1 failed"
    );
}

#[test]
fn external_pane_message_swaps_every_internal_pane_id_for_the_external_id() {
    let registry = registry();
    let identity = pane(&registry, "pane-internal-3");
    let external = identity.external_id.as_str();
    assert_eq!(
        external_pane_message(
            "pane-internal-3 is busy, pane-internal-3 not closed",
            Some(&identity)
        ),
        format!("{external} is busy, {external} not closed")
    );
}

#[test]
fn external_pane_message_leaves_a_message_without_the_pane_id_unchanged() {
    let registry = registry();
    let identity = pane(&registry, "pane-internal-4");
    assert_eq!(
        external_pane_message("something else", Some(&identity)),
        "something else"
    );
}
