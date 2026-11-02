#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::approvals::{
    ALWAYS_ASK, APPROVAL_ANSWERS, APPROVAL_DETAIL_MAX, APPROVAL_HISTORY_MAX, APPROVAL_TIMEOUT_MS,
    ApprovalAnswer, ApprovalKind, ApprovalMode, ApprovalOutcome, ApprovalRecord, ApprovalRequest,
    ApprovalSettings, DEFAULT_APPROVAL_SETTINGS, auto_approves, offered_answers,
    parse_approval_settings,
};
use ostia_contract::capabilities::Capability;
use serde_json::{Value, json};

use ApprovalAnswer::{Always, Deny, Once, Session, Workspace};

const ALL_KINDS: [ApprovalKind; 9] = [
    ApprovalKind::Capability,
    ApprovalKind::SandboxDomain,
    ApprovalKind::SandboxPort,
    ApprovalKind::Secret,
    ApprovalKind::Package,
    ApprovalKind::PackageMalware,
    ApprovalKind::AccountSwitch,
    ApprovalKind::ReachGroup,
    ApprovalKind::ReachProject,
];

#[test]
fn keeps_the_approval_limits() {
    assert_eq!(APPROVAL_TIMEOUT_MS, 90_000);
    assert_eq!(APPROVAL_HISTORY_MAX, 100);
    assert_eq!(APPROVAL_DETAIL_MAX, 600);
}

#[test]
fn lists_the_approval_answers_in_order() {
    assert_eq!(APPROVAL_ANSWERS, [Once, Session, Always, Workspace, Deny]);
}

#[test]
fn always_asks_for_destructive_and_credentials() {
    assert_eq!(
        ALWAYS_ASK,
        [Capability::Destructive, Capability::Credentials]
    );
}

#[test]
fn offers_the_answers_of_each_kind() {
    let table = [
        (ApprovalKind::Capability, vec![Once, Session, Always, Deny]),
        (ApprovalKind::Secret, vec![Once, Session, Deny]),
        (ApprovalKind::Package, vec![Once, Workspace, Deny]),
        (ApprovalKind::PackageMalware, vec![Once, Deny]),
        (ApprovalKind::AccountSwitch, vec![Once, Deny]),
        (ApprovalKind::ReachGroup, vec![Workspace, Deny]),
        (ApprovalKind::ReachProject, vec![Workspace, Deny]),
        (ApprovalKind::SandboxDomain, vec![Workspace, Session, Deny]),
        (ApprovalKind::SandboxPort, vec![Workspace, Session, Deny]),
    ];
    for (kind, answers) in table {
        assert_eq!(
            offered_answers(Some(kind), &[Capability::Shell]),
            answers,
            "{kind:?}"
        );
    }
}

#[test]
fn offers_the_capability_answers_when_the_kind_is_missing() {
    assert_eq!(
        offered_answers(None, &[Capability::Shell]),
        [Once, Session, Always, Deny]
    );
    assert_eq!(offered_answers(None, &[]), [Once, Session, Always, Deny]);
}

#[test]
fn removes_the_standing_answers_when_a_capability_always_asks() {
    for cap in [Capability::Destructive, Capability::Credentials] {
        assert_eq!(offered_answers(None, &[cap]), [Once, Deny], "{cap:?}");
        assert_eq!(
            offered_answers(None, &[Capability::Shell, cap]),
            [Once, Deny],
            "{cap:?} with shell"
        );
    }
}

#[test]
fn removes_the_standing_answers_of_every_kind_when_a_capability_always_asks() {
    let table = [
        (ApprovalKind::Secret, vec![Once, Deny]),
        (ApprovalKind::Package, vec![Once, Workspace, Deny]),
        (ApprovalKind::PackageMalware, vec![Once, Deny]),
        (ApprovalKind::ReachGroup, vec![Workspace, Deny]),
        (ApprovalKind::SandboxDomain, vec![Workspace, Deny]),
        (ApprovalKind::SandboxPort, vec![Workspace, Deny]),
    ];
    for (kind, answers) in table {
        assert_eq!(
            offered_answers(Some(kind), &[Capability::Destructive]),
            answers,
            "{kind:?}"
        );
    }
}

#[test]
fn never_offers_an_answer_that_is_not_in_the_answer_list() {
    for kind in ALL_KINDS {
        for caps in [vec![], vec![Capability::Credentials]] {
            for answer in offered_answers(Some(kind), &caps) {
                assert!(APPROVAL_ANSWERS.contains(&answer), "{kind:?} {answer:?}");
            }
        }
    }
}

#[test]
fn defaults_the_approval_mode_to_ask() {
    assert_eq!(
        DEFAULT_APPROVAL_SETTINGS,
        ApprovalSettings {
            mode: ApprovalMode::Ask
        }
    );
}

#[test]
fn reads_a_valid_approval_mode_and_falls_back_to_ask() {
    assert_eq!(
        parse_approval_settings(&json!({"mode": "allow"})).mode,
        ApprovalMode::Allow
    );
    assert_eq!(
        parse_approval_settings(&json!({"mode": "ask"})).mode,
        ApprovalMode::Ask
    );
    let fallback: [Value; 10] = [
        json!(null),
        json!(1),
        json!("allow"),
        json!([]),
        json!({}),
        json!({"mode": "Allow"}),
        json!({"mode": ""}),
        json!({"mode": null}),
        json!({"mode": true}),
        json!({"mode": ["allow"]}),
    ];
    for raw in fallback {
        assert_eq!(
            parse_approval_settings(&raw).mode,
            ApprovalMode::Ask,
            "{raw}"
        );
    }
}

#[test]
fn auto_approves_only_a_capability_in_allow_mode_without_an_always_ask_capability() {
    let caps = [Capability::Shell, Capability::Notify];
    assert!(auto_approves(
        ApprovalMode::Allow,
        &caps,
        ApprovalKind::Capability
    ));
    assert!(auto_approves(
        ApprovalMode::Allow,
        &[],
        ApprovalKind::Capability
    ));
    assert!(!auto_approves(
        ApprovalMode::Ask,
        &caps,
        ApprovalKind::Capability
    ));
    assert!(!auto_approves(
        ApprovalMode::Ask,
        &[],
        ApprovalKind::Capability
    ));
}

#[test]
fn never_auto_approves_a_capability_that_always_asks() {
    for cap in [Capability::Destructive, Capability::Credentials] {
        assert!(
            !auto_approves(
                ApprovalMode::Allow,
                &[Capability::Shell, cap],
                ApprovalKind::Capability
            ),
            "{cap:?}"
        );
    }
}

#[test]
fn never_auto_approves_a_kind_other_than_capability() {
    for kind in ALL_KINDS
        .into_iter()
        .filter(|kind| *kind != ApprovalKind::Capability)
    {
        assert!(!auto_approves(ApprovalMode::Allow, &[], kind), "{kind:?}");
    }
}

#[test]
fn writes_modes_answers_kinds_and_outcomes_in_kebab_case() {
    assert_eq!(
        serde_json::to_value(ApprovalMode::Allow).unwrap(),
        json!("allow")
    );
    assert_eq!(serde_json::to_value(Workspace).unwrap(), json!("workspace"));
    assert_eq!(
        serde_json::to_value(ApprovalKind::PackageMalware).unwrap(),
        json!("package-malware")
    );
    assert_eq!(
        serde_json::to_value(ApprovalKind::SandboxDomain).unwrap(),
        json!("sandbox-domain")
    );
    assert_eq!(
        serde_json::to_value(ApprovalKind::ReachProject).unwrap(),
        json!("reach-project")
    );
    assert_eq!(
        serde_json::to_value(ApprovalOutcome::Auto).unwrap(),
        json!("auto")
    );
    assert_eq!(
        serde_json::to_value(ApprovalOutcome::Timeout).unwrap(),
        json!("timeout")
    );
    assert_eq!(
        serde_json::to_value(ApprovalOutcome::Answer(Session)).unwrap(),
        json!("session")
    );
}

#[test]
fn writes_a_request_in_field_order_and_omits_a_missing_kind_and_subject() {
    let request = ApprovalRequest {
        id: "a1".to_owned(),
        kind: None,
        subject: None,
        pane_id: "p1".to_owned(),
        workspace_id: "w1".to_owned(),
        caps: vec![Capability::Shell],
        action: "run".to_owned(),
        detail: "ls".to_owned(),
        at: 5,
    };
    assert_eq!(
        serde_json::to_string(&request).unwrap(),
        r#"{"id":"a1","paneId":"p1","workspaceId":"w1","caps":["shell"],"action":"run","detail":"ls","at":5}"#
    );
    let with_kind = ApprovalRequest {
        kind: Some(ApprovalKind::Secret),
        subject: Some("token".to_owned()),
        ..request
    };
    assert_eq!(
        serde_json::to_string(&with_kind).unwrap(),
        r#"{"id":"a1","kind":"secret","subject":"token","paneId":"p1","workspaceId":"w1","caps":["shell"],"action":"run","detail":"ls","at":5}"#
    );
}

#[test]
fn writes_a_record_with_the_request_fields_first() {
    let record = ApprovalRecord {
        request: ApprovalRequest {
            id: "a1".to_owned(),
            kind: None,
            subject: None,
            pane_id: "p1".to_owned(),
            workspace_id: "w1".to_owned(),
            caps: vec![],
            action: "run".to_owned(),
            detail: String::new(),
            at: 5,
        },
        outcome: ApprovalOutcome::Answer(Once),
        answered_at: 9,
        revocable: false,
    };
    assert_eq!(
        serde_json::to_string(&record).unwrap(),
        r#"{"id":"a1","paneId":"p1","workspaceId":"w1","caps":[],"action":"run","detail":"","at":5,"outcome":"once","answeredAt":9,"revocable":false}"#
    );
}
