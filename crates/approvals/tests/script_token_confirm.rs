#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use futures_util::FutureExt;
use ostia_approvals::script_token_confirm::{
    PresenceAction, PresenceRequest, ScriptTokenConfirm, approval_caps, describe_expiry,
    describe_scope,
};
use ostia_approvals::user_presence::{PresenceFailure, PresenceResult, PresenceVia};
use ostia_contract::capabilities::Capability;
use ostia_contract::script_tokens::ScriptTokenScope;
use parking_lot::Mutex;

fn granted() -> PresenceResult {
    PresenceResult::Granted {
        via: PresenceVia::Confirm,
    }
}

fn refused(code: PresenceFailure, detail: &str) -> PresenceResult {
    PresenceResult::Refused {
        code,
        detail: detail.to_owned(),
        hint: None,
    }
}

fn request(action: PresenceAction, name: &str) -> PresenceRequest {
    PresenceRequest {
        action,
        name: name.to_owned(),
    }
}

fn limited(groups: &[&str], workspaces: &[&str], own: bool) -> ScriptTokenScope {
    ScriptTokenScope::Limited {
        groups: groups.iter().map(|s| (*s).to_owned()).collect(),
        workspaces: workspaces.iter().map(|s| (*s).to_owned()).collect(),
        own_workspaces: own,
    }
}

#[tokio::test]
async fn refuses_with_unavailable_until_a_presence_check_is_set() {
    let confirm = ScriptTokenConfirm::new();
    let result = confirm
        .check_user_presence(request(PresenceAction::Generate, "ci"))
        .await;
    assert_eq!(
        result,
        refused(
            PresenceFailure::Unavailable,
            "no user presence check is set up"
        )
    );
    let error = confirm
        .confirm_user_presence(request(PresenceAction::Generate, "ci"))
        .await
        .unwrap_err();
    assert_eq!(
        error.message,
        "presence-unavailable: could not confirm it is you to generate the script token \"ci\" (no user presence check is set up)"
    );
}

#[tokio::test]
async fn hands_the_request_to_the_check_that_was_set_and_returns_its_result() {
    let confirm = ScriptTokenConfirm::new();
    let seen: Arc<Mutex<Vec<PresenceRequest>>> = Arc::default();
    confirm.set_user_presence_check({
        let seen = Arc::clone(&seen);
        Arc::new(move |request| {
            seen.lock().push(request);
            async { granted() }.boxed()
        })
    });
    let result = confirm
        .check_user_presence(request(PresenceAction::Regenerate, "deploy"))
        .await;
    assert_eq!(result, granted());
    assert_eq!(
        *seen.lock(),
        vec![request(PresenceAction::Regenerate, "deploy")]
    );
    confirm
        .confirm_user_presence(request(PresenceAction::Generate, "ci"))
        .await
        .unwrap();
    assert_eq!(seen.lock().len(), 2);
}

#[tokio::test]
async fn a_later_check_replaces_the_earlier_one() {
    let confirm = ScriptTokenConfirm::new();
    confirm.set_user_presence_check(Arc::new(|_| async { granted() }.boxed()));
    confirm.set_user_presence_check(Arc::new(|_| {
        async { refused(PresenceFailure::Cancelled, "closed") }.boxed()
    }));
    let result = confirm
        .check_user_presence(request(PresenceAction::Generate, "ci"))
        .await;
    assert_eq!(result, refused(PresenceFailure::Cancelled, "closed"));
}

#[tokio::test]
async fn names_the_failure_code_the_action_and_the_token_in_the_refusal() {
    let rows = [
        (
            PresenceFailure::Cancelled,
            "presence-cancelled",
            PresenceAction::Generate,
            "generate",
        ),
        (
            PresenceFailure::Failed,
            "presence-failed",
            PresenceAction::Regenerate,
            "regenerate",
        ),
        (
            PresenceFailure::Timeout,
            "presence-timeout",
            PresenceAction::Generate,
            "generate",
        ),
        (
            PresenceFailure::Unavailable,
            "presence-unavailable",
            PresenceAction::Regenerate,
            "regenerate",
        ),
    ];
    for (code, prefix, action, word) in rows {
        let confirm = ScriptTokenConfirm::new();
        confirm.set_user_presence_check(Arc::new(move |_| {
            async move { refused(code, "the detail") }.boxed()
        }));
        let error = confirm
            .confirm_user_presence(request(action, "my token"))
            .await
            .unwrap_err();
        assert_eq!(
            error.message,
            format!(
                "{prefix}: could not confirm it is you to {word} the script token \"my token\" (the detail)"
            ),
            "{prefix}"
        );
    }
}

#[test]
fn describes_an_all_scope_as_every_workspace() {
    assert_eq!(describe_scope(&ScriptTokenScope::All), "every workspace");
}

#[test]
fn describes_a_limited_scope_with_groups_then_workspaces_then_own_workspaces() {
    assert_eq!(
        describe_scope(&limited(&["g1", "g2"], &["w1"], true)),
        "group g1, group g2, workspace w1, the workspaces it creates there"
    );
    assert_eq!(describe_scope(&limited(&["g1"], &[], false)), "group g1");
    assert_eq!(
        describe_scope(&limited(&[], &["w1", "w2"], false)),
        "workspace w1, workspace w2"
    );
    assert_eq!(
        describe_scope(&limited(&[], &[], true)),
        "the workspaces it creates there"
    );
    assert_eq!(describe_scope(&limited(&[], &[], false)), "");
}

#[test]
fn describes_a_missing_expiry_as_a_warning_and_a_set_one_as_a_date() {
    assert_eq!(
        describe_expiry(None),
        "NEVER expires (warning: it stays valid until revoked)"
    );
    assert_eq!(
        describe_expiry(Some("2027-01-01T00:00:00.000Z")),
        "expires 2027-01-01T00:00:00.000Z"
    );
}

#[test]
fn approval_caps_always_ask_for_settings_write_first_and_add_all_workspaces_for_an_all_scope() {
    assert_eq!(
        approval_caps(
            &[Capability::Shell, Capability::Notify],
            &limited(&[], &["w1"], false)
        ),
        vec![
            Capability::SettingsWrite,
            Capability::Shell,
            Capability::Notify
        ]
    );
    assert_eq!(
        approval_caps(&[Capability::Shell], &ScriptTokenScope::All),
        vec![
            Capability::SettingsWrite,
            Capability::Shell,
            Capability::AllWorkspaces
        ]
    );
    assert_eq!(
        approval_caps(&[], &ScriptTokenScope::All),
        vec![Capability::SettingsWrite, Capability::AllWorkspaces]
    );
}
