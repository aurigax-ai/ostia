#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_base::{PaneId, WindowId, WorkspaceId};
use ostia_contract::script_tokens::{ScriptTokenCallOutcome, ScriptTokenCallTarget};
use ostia_control::script_call_usage::{
    CallOutcome, called_method, called_target, error_outcome, result_outcome,
};
use ostia_control::{IdRegistry, PaneIdentity, PaneInput};
use serde_json::json;

fn registry() -> IdRegistry {
    IdRegistry::new(&[5; 32])
}

fn pane(registry: &IdRegistry, workspace: &str, id: &str) -> PaneIdentity {
    registry.register_pane(PaneInput {
        window_id: WindowId::new("w1"),
        workspace_id: WorkspaceId::new(workspace),
        pane_id: PaneId::new(id),
    })
}

fn outcome(outcome: ScriptTokenCallOutcome, code: Option<&str>) -> Option<CallOutcome> {
    Some(CallOutcome {
        outcome,
        code: code.map(str::to_owned),
    })
}

fn workspace_only(id: &str) -> ScriptTokenCallTarget {
    ScriptTokenCallTarget {
        workspace_id: Some(id.to_owned()),
        pane_id: None,
    }
}

#[test]
fn called_method_returns_the_method_name_when_it_is_not_command_exec() {
    assert_eq!(
        called_method("pane.list", &json!({"id": "workspace.new"})),
        "pane.list"
    );
}

#[test]
fn called_method_returns_the_command_id_for_command_exec() {
    assert_eq!(
        called_method("command.exec", &json!({"id": "workspace.new"})),
        "workspace.new"
    );
}

#[test]
fn called_method_keeps_command_exec_when_the_id_is_missing_or_not_a_string() {
    for params in [
        json!({}),
        json!({"id": 4}),
        json!(null),
        json!("x"),
        json!(["a"]),
    ] {
        assert_eq!(
            called_method("command.exec", &params),
            "command.exec",
            "{params}"
        );
    }
}

#[test]
fn called_method_keeps_command_exec_when_the_id_is_not_a_safe_method_name() {
    let too_long = "a".repeat(81);
    for id in ["", "has space", "a/b", "a\n", "é", "x;y", too_long.as_str()] {
        assert_eq!(
            called_method("command.exec", &json!({"id": id})),
            "command.exec",
            "{id:?}"
        );
    }
}

#[test]
fn called_method_accepts_an_id_of_80_word_dot_and_dash_characters() {
    let longest = "a".repeat(80);
    for id in ["a", "A_b-c.d9", longest.as_str()] {
        assert_eq!(
            called_method("command.exec", &json!({"id": id})),
            id,
            "{id:?}"
        );
    }
}

#[test]
fn called_target_resolves_a_pane_to_its_workspace_and_external_id() {
    let registry = registry();
    let identity = pane(&registry, "s1", "p1");
    let target = called_target(&registry, &json!({"pane": identity.external_id.as_str()}));
    assert_eq!(
        target,
        ScriptTokenCallTarget {
            workspace_id: Some("s1".to_owned()),
            pane_id: Some(identity.external_id.as_str().to_owned()),
        }
    );
}

#[test]
fn called_target_reads_the_pane_from_pane_then_pane_id_then_args_pane_id() {
    let registry = registry();
    let first = pane(&registry, "s1", "p1");
    let second = pane(&registry, "s2", "p2");
    let third = pane(&registry, "s3", "p3");
    let (a, b, c) = (
        first.external_id.as_str(),
        second.external_id.as_str(),
        third.external_id.as_str(),
    );
    let all = called_target(
        &registry,
        &json!({"pane": a, "paneId": b, "args": {"paneId": c}}),
    );
    assert_eq!(all.pane_id.as_deref(), Some(a));
    let without_pane = called_target(&registry, &json!({"paneId": b, "args": {"paneId": c}}));
    assert_eq!(without_pane.pane_id.as_deref(), Some(b));
    let only_args = called_target(&registry, &json!({"args": {"paneId": c}}));
    assert_eq!(only_args.pane_id.as_deref(), Some(c));
    assert_eq!(only_args.workspace_id.as_deref(), Some("s3"));
}

#[test]
fn called_target_skips_a_pane_field_that_is_not_a_string() {
    let registry = registry();
    let identity = pane(&registry, "s1", "p1");
    let target = called_target(
        &registry,
        &json!({"pane": 3, "paneId": identity.external_id.as_str()}),
    );
    assert_eq!(
        target.pane_id.as_deref(),
        Some(identity.external_id.as_str())
    );
}

#[test]
fn called_target_does_not_try_the_next_pane_field_after_a_string_that_is_not_a_pane() {
    let registry = registry();
    let identity = pane(&registry, "s1", "p1");
    let target = called_target(
        &registry,
        &json!({"pane": "nope", "paneId": identity.external_id.as_str()}),
    );
    assert_eq!(target, ScriptTokenCallTarget::default());
}

#[test]
fn called_target_ignores_an_id_that_is_not_a_pane() {
    let registry = registry();
    let extension = registry.register_extension("ext.one");
    let target = called_target(&registry, &json!({"pane": extension.external_id.as_str()}));
    assert_eq!(target, ScriptTokenCallTarget::default());
}

#[test]
fn called_target_falls_back_to_the_workspace_when_the_pane_is_unknown() {
    let registry = registry();
    let target = called_target(&registry, &json!({"pane": "nope", "workspace": "ws-1"}));
    assert_eq!(target, workspace_only("ws-1"));
}

#[test]
fn called_target_reads_the_workspace_from_target_then_workspace_then_workspace_id() {
    let registry = registry();
    assert_eq!(
        called_target(
            &registry,
            &json!({"target": {"workspaceId": "a"}, "workspace": "b", "workspaceId": "c"})
        ),
        workspace_only("a")
    );
    assert_eq!(
        called_target(&registry, &json!({"workspace": "b", "workspaceId": "c"})),
        workspace_only("b")
    );
    assert_eq!(
        called_target(&registry, &json!({"workspaceId": "c"})),
        workspace_only("c")
    );
}

#[test]
fn called_target_skips_a_workspace_value_that_is_not_a_safe_reference() {
    let registry = registry();
    let too_long = "a".repeat(101);
    for bad in [
        json!(""),
        json!("has space"),
        json!("a/b"),
        json!(4),
        json!(too_long),
    ] {
        let target = called_target(
            &registry,
            &json!({"target": {"workspaceId": bad}, "workspace": "ok"}),
        );
        assert_eq!(target, workspace_only("ok"), "{bad}");
    }
}

#[test]
fn called_target_accepts_workspace_references_of_100_word_dot_colon_at_and_dash_characters() {
    let registry = registry();
    let longest = "a".repeat(100);
    for id in ["a", "ws:1.2@host-x_y", longest.as_str()] {
        assert_eq!(
            called_target(&registry, &json!({"workspace": id})),
            workspace_only(id),
            "{id:?}"
        );
    }
}

#[test]
fn called_target_is_empty_when_nothing_names_a_pane_or_workspace() {
    let registry = registry();
    for params in [
        json!({}),
        json!(null),
        json!("x"),
        json!([1]),
        json!({"args": 3}),
    ] {
        assert_eq!(
            called_target(&registry, &params),
            ScriptTokenCallTarget::default(),
            "{params}"
        );
    }
}

#[test]
fn result_outcome_is_ok_unless_the_result_says_ok_false() {
    for result in [
        json!({"ok": true}),
        json!({}),
        json!(null),
        json!("done"),
        json!(5),
        json!({"ok": 0}),
        json!({"ok": null}),
    ] {
        assert_eq!(
            result_outcome(&result),
            CallOutcome {
                outcome: ScriptTokenCallOutcome::Ok,
                code: None
            },
            "{result}"
        );
    }
}

#[test]
fn result_outcome_reads_the_code_from_the_error_up_to_the_first_colon() {
    let result = json!({"ok": false, "error": {"code": "needs-elevation: shell"}});
    assert_eq!(
        result_outcome(&result),
        CallOutcome {
            outcome: ScriptTokenCallOutcome::Error,
            code: Some("needs-elevation".to_owned())
        }
    );
    let plain = json!({"ok": false, "error": {"code": "command-failed"}});
    assert_eq!(
        result_outcome(&plain),
        CallOutcome {
            outcome: ScriptTokenCallOutcome::Error,
            code: Some("command-failed".to_owned())
        }
    );
}

#[test]
fn result_outcome_uses_the_code_error_when_the_error_has_no_readable_code() {
    for result in [
        json!({"ok": false}),
        json!({"ok": false, "error": "x"}),
        json!({"ok": false, "error": {"code": 4}}),
        json!({"ok": false, "error": {"code": "Bad Code"}}),
        json!({"ok": false, "error": {"code": ""}}),
    ] {
        assert_eq!(
            result_outcome(&result),
            CallOutcome {
                outcome: ScriptTokenCallOutcome::Error,
                code: Some("error".to_owned())
            },
            "{result}"
        );
    }
}

#[test]
fn error_outcome_is_none_for_an_unknown_identity() {
    assert_eq!(error_outcome("unknown identity"), None);
}

#[test]
fn error_outcome_reads_the_code_before_the_first_colon() {
    assert_eq!(
        error_outcome("unknown-pane: p1 (use a paneId from ostia pane list)"),
        outcome(ScriptTokenCallOutcome::Error, Some("unknown-pane"))
    );
    assert_eq!(
        error_outcome("denied"),
        outcome(ScriptTokenCallOutcome::Error, Some("denied"))
    );
}

#[test]
fn error_outcome_uses_the_code_error_when_the_message_does_not_start_with_a_code() {
    for message in [
        "",
        "Something broke",
        ": x",
        "9lives: x",
        "-x: y",
        " denied",
    ] {
        assert_eq!(
            error_outcome(message),
            outcome(ScriptTokenCallOutcome::Error, Some("error")),
            "{message:?}"
        );
    }
}

#[test]
fn error_outcome_reads_a_code_of_up_to_41_characters() {
    let longest = format!("a{}", "b".repeat(40));
    assert_eq!(
        error_outcome(&format!("{longest}: x")),
        outcome(ScriptTokenCallOutcome::Error, Some(longest.as_str()))
    );
    let too_long = format!("a{}", "b".repeat(41));
    assert_eq!(
        error_outcome(&format!("{too_long}: x")),
        outcome(ScriptTokenCallOutcome::Error, Some("error"))
    );
}

#[test]
fn error_outcome_marks_a_needs_elevation_cap_as_a_missing_permission() {
    assert_eq!(
        error_outcome("needs-elevation: shell"),
        outcome(
            ScriptTokenCallOutcome::MissingPermission,
            Some("needs-elevation: shell")
        )
    );
    assert_eq!(
        error_outcome("needs-elevation:   type-other-pane  "),
        outcome(
            ScriptTokenCallOutcome::MissingPermission,
            Some("needs-elevation: type-other-pane")
        )
    );
}

#[test]
fn error_outcome_marks_a_needs_elevation_for_all_workspaces_as_out_of_scope() {
    assert_eq!(
        error_outcome("needs-elevation: all-workspaces"),
        outcome(
            ScriptTokenCallOutcome::OutOfScope,
            Some("needs-elevation: all-workspaces")
        )
    );
}

#[test]
fn error_outcome_keeps_only_the_code_for_a_needs_elevation_with_a_cap_that_is_not_a_name() {
    for message in [
        "needs-elevation",
        "needs-elevation:",
        "needs-elevation: Shell",
        "needs-elevation: 1x",
        "needs-elevation: a b",
        "needs-elevation: /etc/passwd",
    ] {
        assert_eq!(
            error_outcome(message),
            outcome(
                ScriptTokenCallOutcome::MissingPermission,
                Some("needs-elevation")
            ),
            "{message:?}"
        );
    }
}

#[test]
fn error_outcome_accepts_a_cap_name_of_up_to_41_lowercase_letters_and_dashes() {
    let longest = format!("a{}", "b".repeat(40));
    assert_eq!(
        error_outcome(&format!("needs-elevation: {longest}")),
        outcome(
            ScriptTokenCallOutcome::MissingPermission,
            Some(format!("needs-elevation: {longest}").as_str())
        )
    );
    let too_long = format!("a{}", "b".repeat(41));
    assert_eq!(
        error_outcome(&format!("needs-elevation: {too_long}")),
        outcome(
            ScriptTokenCallOutcome::MissingPermission,
            Some("needs-elevation")
        )
    );
}
