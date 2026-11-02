#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_approvals::script_token_requests::{
    ReachGroup, ReachListing, ReachWorkspace, ScopeRequest, TokenChanges, TokenRequest,
    confirm_still_never, fail, held_caps, ids, parse_token_changes, parse_token_request,
    regenerates, resolve_scope,
};
use ostia_contract::capabilities::Capability;
use ostia_contract::script_tokens::{DEFAULT_TOKEN_EXPIRY, NEVER_EXPIRES, ScriptTokenScope};
use ostia_rpc::{RpcError, codes};
use serde_json::{Value, json};

const NAME_REFUSAL: &str = "bad-request: name (1-60 letters, digits, space, . _ @ -)";
const SCOPE_MISSING: &str =
    "bad-request: scope (pass --scope all, group:<name|id> or workspace:<name|id>)";
const SCOPE_EMPTY: &str = "bad-request: scope (all, or at least one group or workspace)";
const EXPIRES_FORMAT: &str = "use 7d, 30d, 90d, 1y, YYYY-MM-DD or never";

fn refusal(message: &str) -> RpcError {
    RpcError::invalid_request(message)
}

fn request(raw: Value) -> Result<TokenRequest, RpcError> {
    parse_token_request(&raw)
}

fn changes(raw: Value) -> Result<TokenChanges, RpcError> {
    parse_token_changes(&raw)
}

fn valid() -> Value {
    json!({"name": "ci bot", "caps": ["read-board"], "scope": {"kind": "all"}})
}

fn with(base: Value, key: &str, value: Value) -> Value {
    let mut object = base;
    object[key] = value;
    object
}

fn limited(groups: &[&str], workspaces: &[&str], own_workspaces: bool) -> ScopeRequest {
    ScopeRequest::Limited {
        groups: groups.iter().map(|g| (*g).to_owned()).collect(),
        workspaces: workspaces.iter().map(|w| (*w).to_owned()).collect(),
        own_workspaces,
    }
}

fn listing() -> ReachListing {
    ReachListing {
        workspaces: vec![
            ReachWorkspace {
                workspace_id: "w1".to_owned(),
                name: "api".to_owned(),
                work_dir: "/home/u/api".to_owned(),
                group_id: None,
            },
            ReachWorkspace {
                workspace_id: "w2".to_owned(),
                name: "web".to_owned(),
                work_dir: "/home/u/web".to_owned(),
                group_id: Some("g1".to_owned()),
            },
            ReachWorkspace {
                workspace_id: "w3".to_owned(),
                name: "web".to_owned(),
                work_dir: "/home/u/web2".to_owned(),
                group_id: None,
            },
        ],
        groups: vec![
            ReachGroup {
                group_id: "g1".to_owned(),
                name: "backend".to_owned(),
                color: None,
            },
            ReachGroup {
                group_id: "g2".to_owned(),
                name: "docs".to_owned(),
                color: Some("blue".to_owned()),
            },
            ReachGroup {
                group_id: "g3".to_owned(),
                name: "docs".to_owned(),
                color: None,
            },
        ],
    }
}

#[test]
fn fail_is_an_invalid_request_with_the_given_text() {
    let error = fail("bad-request: caps");
    assert_eq!(error.code, codes::INVALID_REQUEST);
    assert_eq!(error.message, "bad-request: caps");
}

#[test]
fn held_caps_keeps_only_script_capabilities_in_script_order_and_never_all_workspaces() {
    let held = held_caps(&json!([
        "notify",
        "shell",
        "all-workspaces",
        "read-board",
        "process",
        7
    ]));
    assert_eq!(
        held,
        vec![
            Capability::ReadBoard,
            Capability::Process,
            Capability::Notify
        ]
    );
}

#[test]
fn held_caps_is_empty_when_the_value_is_not_a_list() {
    for raw in [
        json!(null),
        json!("notify"),
        json!({"0": "notify"}),
        json!(5),
    ] {
        assert_eq!(held_caps(&raw), Vec::<Capability>::new(), "{raw}");
    }
}

#[test]
fn ids_gives_the_strings_once_each_in_the_order_first_seen() {
    assert_eq!(
        ids(&json!(["b", "a", "b", "c", "a"])),
        Some(vec!["b".to_owned(), "a".to_owned(), "c".to_owned()])
    );
    assert_eq!(ids(&json!([])), Some(Vec::new()));
}

#[test]
fn ids_refuses_a_value_that_is_not_a_list_of_non_empty_strings() {
    for raw in [
        json!(null),
        json!("a"),
        json!({"a": 1}),
        json!(["a", ""]),
        json!(["a", 1]),
        json!(["a", null]),
    ] {
        assert_eq!(ids(&raw), None, "{raw}");
    }
}

#[test]
fn parses_a_full_request_trimmed_and_in_script_order() {
    let parsed = request(json!({
        "name": "  ci bot.v2@home  ",
        "caps": ["notify", "read-board", "process"],
        "scope": {"kind": "limited", "groups": ["g1"], "workspaces": ["w1", "w1"], "ownWorkspaces": true},
        "expires": "30d"
    }))
    .unwrap();
    assert_eq!(parsed.name, "ci bot.v2@home");
    assert_eq!(
        parsed.caps,
        vec![
            Capability::ReadBoard,
            Capability::Process,
            Capability::Notify
        ]
    );
    assert_eq!(parsed.scope, limited(&["g1"], &["w1"], true));
    assert_eq!(parsed.expires, "30d");
}

#[test]
fn expires_in_ninety_days_when_the_request_gives_no_time() {
    let parsed = request(valid()).unwrap();
    assert_eq!(parsed.expires, DEFAULT_TOKEN_EXPIRY);
    assert_eq!(parsed.expires, "90d");
}

#[test]
fn refuses_a_name_that_is_missing_empty_too_long_or_has_other_characters() {
    let long = "a".repeat(61);
    let rows = [
        json!(null),
        json!(7),
        json!(""),
        json!("   "),
        json!(long),
        json!("a/b"),
        json!("naïve"),
        json!("tab\tname"),
        json!("a;b"),
    ];
    for name in rows {
        assert_eq!(
            request(with(valid(), "name", name.clone())),
            Err(refusal(NAME_REFUSAL)),
            "{name}"
        );
    }
    assert_eq!(
        request(json!({"caps": ["read-board"], "scope": {"kind": "all"}})),
        Err(refusal(NAME_REFUSAL))
    );
}

#[test]
fn accepts_a_name_of_sixty_letters_digits_and_the_allowed_marks() {
    let name = format!("{}.@_- 9", "a".repeat(54));
    assert_eq!(name.len(), 60);
    assert_eq!(
        request(with(valid(), "name", json!(name.clone())))
            .unwrap()
            .name,
        name
    );
}

#[test]
fn a_request_that_is_not_an_object_has_no_name() {
    for raw in [json!(null), json!("x"), json!([1]), json!(3)] {
        assert_eq!(request(raw.clone()), Err(refusal(NAME_REFUSAL)), "{raw}");
    }
}

#[test]
fn refuses_caps_that_are_missing_empty_or_not_a_list() {
    for caps in [json!(null), json!([]), json!("read-board"), json!({})] {
        assert_eq!(
            request(with(valid(), "caps", caps.clone())),
            Err(refusal("bad-request: caps")),
            "{caps}"
        );
    }
    assert_eq!(
        request(json!({"name": "ci", "scope": {"kind": "all"}})),
        Err(refusal("bad-request: caps"))
    );
}

#[test]
fn names_every_capability_a_script_token_cannot_hold() {
    assert_eq!(
        request(with(
            valid(),
            "caps",
            json!(["read-board", "shell", "vault-read", 5])
        )),
        Err(refusal(
            "bad-request: a script token can hold only read-board, read-other-pane, type-other-pane, all-workspaces, process, send-other-pane, kill-pane, notify (got shell, vault-read, 5)"
        ))
    );
}

#[test]
fn checks_the_name_before_the_caps_and_the_caps_before_the_scope() {
    assert_eq!(
        request(json!({"name": "", "caps": [], "scope": "x"})),
        Err(refusal(NAME_REFUSAL))
    );
    assert_eq!(
        request(json!({"name": "ci", "caps": [], "scope": "x", "expires": 3})),
        Err(refusal("bad-request: caps"))
    );
    assert_eq!(
        request(json!({"name": "ci", "caps": ["read-board"], "scope": "x", "expires": 3})),
        Err(refusal(SCOPE_EMPTY))
    );
}

#[test]
fn a_request_with_all_workspaces_and_no_scope_reaches_all() {
    let parsed = request(json!({"name": "ci", "caps": ["all-workspaces", "notify"]})).unwrap();
    assert_eq!(parsed.scope, ScopeRequest::All);
    assert_eq!(parsed.caps, vec![Capability::Notify]);
}

#[test]
fn all_workspaces_alone_leaves_no_held_capability() {
    let parsed = request(json!({"name": "ci", "caps": ["all-workspaces"]})).unwrap();
    assert_eq!(parsed.caps, Vec::<Capability>::new());
    assert_eq!(parsed.scope, ScopeRequest::All);
}

#[test]
fn a_request_with_no_scope_and_no_all_workspaces_is_refused() {
    assert_eq!(
        request(json!({"name": "ci", "caps": ["read-board"]})),
        Err(refusal(SCOPE_MISSING))
    );
}

#[test]
fn the_scope_all_is_accepted_without_all_workspaces() {
    let parsed = request(with(valid(), "scope", json!({"kind": "all", "groups": 5}))).unwrap();
    assert_eq!(parsed.scope, ScopeRequest::All);
}

#[test]
fn a_limited_scope_needs_at_least_one_group_or_workspace() {
    let rows = [
        json!({"kind": "limited"}),
        json!({"kind": "limited", "groups": [], "workspaces": []}),
        json!({"kind": "limited", "groups": "g1"}),
        json!({"kind": "limited", "workspaces": ["w1", ""]}),
        json!({"kind": "limited", "groups": ["g1"], "workspaces": [1]}),
        json!({"kind": "other", "groups": ["g1"]}),
        json!({"groups": ["g1"]}),
        json!({"kind": "limited", "groups": null}),
        json!("all"),
        json!(5),
        json!(null),
        json!([]),
    ];
    for scope in rows {
        assert_eq!(
            request(with(valid(), "scope", scope.clone())),
            Err(refusal(SCOPE_EMPTY)),
            "{scope}"
        );
    }
}

#[test]
fn a_limited_scope_lists_each_id_once_and_owns_workspaces_only_on_true() {
    let rows = [
        (json!(true), true),
        (json!(false), false),
        (json!("true"), false),
        (json!(1), false),
        (json!(null), false),
    ];
    for (own, expected) in rows {
        let scope = json!({"kind": "limited", "groups": ["g1", "g1"], "ownWorkspaces": own});
        assert_eq!(
            request(with(valid(), "scope", scope)).unwrap().scope,
            limited(&["g1"], &[], expected),
            "{own}"
        );
    }
}

#[test]
fn a_limited_scope_cannot_hold_all_workspaces() {
    let raw = json!({
        "name": "ci",
        "caps": ["all-workspaces", "read-board"],
        "scope": {"kind": "limited", "workspaces": ["w1"]}
    });
    assert_eq!(
        request(raw),
        Err(refusal("bad-request: all-workspaces needs the scope all"))
    );
}

#[test]
fn refuses_an_expires_that_is_not_a_non_empty_string() {
    for expires in [
        json!(null),
        json!(""),
        json!(30),
        json!(true),
        json!(["30d"]),
    ] {
        assert_eq!(
            request(with(valid(), "expires", expires.clone())),
            Err(refusal("bad-request: expires")),
            "{expires}"
        );
    }
}

#[test]
fn expires_never_needs_confirm_never_expires_to_be_exactly_true() {
    let needs = refusal("bad-request: expires never needs confirmNeverExpires: true");
    for confirm in [json!(null), json!(false), json!("true"), json!(1)] {
        let raw = with(
            with(valid(), "expires", json!(NEVER_EXPIRES)),
            "confirmNeverExpires",
            confirm.clone(),
        );
        assert_eq!(request(raw), Err(needs.clone()), "{confirm}");
    }
    assert_eq!(
        request(with(valid(), "expires", json!(NEVER_EXPIRES))),
        Err(needs)
    );
    let raw = with(
        with(valid(), "expires", json!(NEVER_EXPIRES)),
        "confirmNeverExpires",
        json!(true),
    );
    assert_eq!(request(raw).unwrap().expires, "never");
}

#[test]
fn accepts_the_relative_and_dated_forms_of_expires_as_given() {
    for expires in ["7d", "30d", "90d", "9999d", "1y", "10y", "2999-12-31"] {
        assert_eq!(
            request(with(valid(), "expires", json!(expires)))
                .unwrap()
                .expires,
            expires,
            "{expires}"
        );
    }
}

#[test]
fn explains_an_expires_it_cannot_read() {
    for expires in [
        "tomorrow",
        "0d",
        "10000d",
        "01d",
        "1w",
        "d",
        "1.5y",
        " 7d",
        "7d ",
        "2999-1-1",
        "2999-02-30",
        "2999-13-01",
        "2999-12-32",
        "Never",
        "NEVER",
    ] {
        assert_eq!(
            request(with(valid(), "expires", json!(expires))),
            Err(refusal(&format!(
                "bad-request: expires: {expires} ({EXPIRES_FORMAT})"
            ))),
            "{expires}"
        );
    }
}

#[test]
fn refuses_a_date_that_is_already_past() {
    assert_eq!(
        request(with(valid(), "expires", json!("2000-01-01"))),
        Err(refusal("bad-request: expires: 2000-01-01 is in the past"))
    );
}

#[test]
fn changes_need_the_id_of_a_token() {
    for raw in [
        json!({"name": "x"}),
        json!({"id": "", "name": "x"}),
        json!({"id": 4, "name": "x"}),
        json!({"id": null}),
        json!(null),
        json!("t1"),
        json!([]),
    ] {
        assert_eq!(
            changes(raw.clone()),
            Err(refusal("bad-request: id")),
            "{raw}"
        );
    }
}

#[test]
fn changes_with_nothing_to_change_are_refused() {
    let nothing = refusal("bad-request: nothing to change (name, caps, scope or expires)");
    for raw in [
        json!({"id": "t1"}),
        json!({"id": "t1", "confirmNeverExpires": true}),
        json!({"id": "t1", "unknown": 1}),
    ] {
        assert_eq!(changes(raw.clone()), Err(nothing.clone()), "{raw}");
    }
}

#[test]
fn a_rename_changes_only_the_name_and_trims_it() {
    let parsed = changes(json!({"id": "t1", "name": "  renamed  "})).unwrap();
    assert_eq!(parsed.reference, "t1");
    assert_eq!(parsed.name.as_deref(), Some("renamed"));
    assert_eq!(parsed.caps, None);
    assert_eq!(parsed.scope, None);
    assert_eq!(parsed.expires, None);
    assert!(!parsed.confirm_never_expires);
}

#[test]
fn a_bad_name_in_changes_is_refused_with_the_name_text() {
    for name in [json!(null), json!(""), json!("a/b"), json!(5)] {
        assert_eq!(
            changes(json!({"id": "t1", "name": name.clone()})),
            Err(refusal(NAME_REFUSAL)),
            "{name}"
        );
    }
}

#[test]
fn new_caps_in_changes_keep_script_order_and_drop_all_workspaces() {
    let parsed =
        changes(json!({"id": "t1", "caps": ["notify", "all-workspaces", "read-board"]})).unwrap();
    assert_eq!(
        parsed.caps,
        Some(vec![Capability::ReadBoard, Capability::Notify])
    );
    assert_eq!(parsed.scope, Some(ScopeRequest::All));
}

#[test]
fn caps_in_changes_without_all_workspaces_leave_the_scope_alone() {
    let parsed = changes(json!({"id": "t1", "caps": ["notify"]})).unwrap();
    assert_eq!(parsed.caps, Some(vec![Capability::Notify]));
    assert_eq!(parsed.scope, None);
}

#[test]
fn bad_caps_in_changes_are_refused_as_in_a_request() {
    assert_eq!(
        changes(json!({"id": "t1", "caps": []})),
        Err(refusal("bad-request: caps"))
    );
    assert_eq!(
        changes(json!({"id": "t1", "caps": ["shell"]})),
        Err(refusal(
            "bad-request: a script token can hold only read-board, read-other-pane, type-other-pane, all-workspaces, process, send-other-pane, kill-pane, notify (got shell)"
        ))
    );
}

#[test]
fn a_new_scope_in_changes_is_read_without_the_caps() {
    let parsed = changes(json!({
        "id": "t1",
        "scope": {"kind": "limited", "workspaces": ["w2"], "ownWorkspaces": true}
    }))
    .unwrap();
    assert_eq!(parsed.scope, Some(limited(&[], &["w2"], true)));
    assert_eq!(
        changes(json!({"id": "t1", "scope": {"kind": "all"}}))
            .unwrap()
            .scope,
        Some(ScopeRequest::All)
    );
    assert_eq!(
        changes(json!({"id": "t1", "scope": {"kind": "limited"}})),
        Err(refusal(SCOPE_EMPTY))
    );
}

#[test]
fn a_limited_scope_in_changes_with_all_workspaces_in_the_caps_is_refused() {
    assert_eq!(
        changes(json!({
            "id": "t1",
            "caps": ["all-workspaces"],
            "scope": {"kind": "limited", "groups": ["g1"]}
        })),
        Err(refusal("bad-request: all-workspaces needs the scope all"))
    );
}

#[test]
fn a_new_expires_in_changes_is_checked_like_a_request() {
    assert_eq!(
        changes(json!({"id": "t1", "expires": "1y"}))
            .unwrap()
            .expires
            .as_deref(),
        Some("1y")
    );
    assert_eq!(
        changes(json!({"id": "t1", "expires": "soon"})),
        Err(refusal(&format!(
            "bad-request: expires: soon ({EXPIRES_FORMAT})"
        )))
    );
    assert_eq!(
        changes(json!({"id": "t1", "expires": "never"})),
        Err(refusal(
            "bad-request: expires never needs confirmNeverExpires: true"
        ))
    );
    let confirmed =
        changes(json!({"id": "t1", "expires": "never", "confirmNeverExpires": true})).unwrap();
    assert_eq!(confirmed.expires.as_deref(), Some("never"));
    assert!(confirmed.confirm_never_expires);
}

#[test]
fn changes_keep_the_never_confirmation_only_when_it_is_exactly_true() {
    let kept = changes(json!({"id": "t1", "name": "x", "confirmNeverExpires": true})).unwrap();
    assert!(kept.confirm_never_expires);
    for confirm in [json!(false), json!("true"), json!(1), json!(null)] {
        let dropped =
            changes(json!({"id": "t1", "name": "x", "confirmNeverExpires": confirm.clone()}))
                .unwrap();
        assert!(!dropped.confirm_never_expires, "{confirm}");
    }
}

#[test]
fn regenerating_a_token_that_never_expires_needs_the_confirmation_again() {
    let plain = changes(json!({"id": "t1", "caps": ["notify"]})).unwrap();
    assert_eq!(
        confirm_still_never(&plain, None, "deploy"),
        Err(refusal(
            "bad-request: the script token \"deploy\" never expires, so regenerating it needs confirmNeverExpires: true (ostia token update --yes-never-expires)"
        ))
    );
    let confirmed =
        changes(json!({"id": "t1", "caps": ["notify"], "confirmNeverExpires": true})).unwrap();
    assert_eq!(confirm_still_never(&confirmed, None, "deploy"), Ok(()));
}

#[test]
fn a_token_that_expires_needs_no_confirmation_to_regenerate() {
    let plain = changes(json!({"id": "t1", "caps": ["notify"]})).unwrap();
    assert_eq!(
        confirm_still_never(&plain, Some("2999-01-01T00:00:00.000Z"), "deploy"),
        Ok(())
    );
}

#[test]
fn only_new_caps_scope_or_expires_regenerate_the_token() {
    let rows = [
        (json!({"id": "t1", "name": "x"}), false),
        (
            json!({"id": "t1", "name": "x", "confirmNeverExpires": true}),
            false,
        ),
        (json!({"id": "t1", "caps": ["notify"]}), true),
        (json!({"id": "t1", "scope": {"kind": "all"}}), true),
        (json!({"id": "t1", "expires": "7d"}), true),
        (json!({"id": "t1", "name": "x", "expires": "7d"}), true),
    ];
    for (raw, expected) in rows {
        assert_eq!(
            regenerates(&changes(raw.clone()).unwrap()),
            expected,
            "{raw}"
        );
    }
}

#[test]
fn resolves_all_as_all() {
    assert_eq!(
        resolve_scope(&ScopeRequest::All, &listing()),
        Ok(ScriptTokenScope::All)
    );
}

#[test]
fn resolves_groups_and_workspaces_by_id_or_by_unique_name() {
    let resolved = resolve_scope(
        &limited(&["backend", "g2"], &["api", "w2"], true),
        &listing(),
    );
    assert_eq!(
        resolved,
        Ok(ScriptTokenScope::Limited {
            groups: vec!["g1".to_owned(), "g2".to_owned()],
            workspaces: vec!["w1".to_owned(), "w2".to_owned()],
            own_workspaces: true,
        })
    );
}

#[test]
fn resolving_lists_each_id_once_in_the_order_first_asked() {
    let resolved = resolve_scope(
        &limited(&["g1", "backend", "g1"], &["w2", "w2", "api"], false),
        &listing(),
    );
    assert_eq!(
        resolved,
        Ok(ScriptTokenScope::Limited {
            groups: vec!["g1".to_owned()],
            workspaces: vec!["w2".to_owned(), "w1".to_owned()],
            own_workspaces: false,
        })
    );
}

#[test]
fn an_unknown_group_or_workspace_is_named_in_the_refusal() {
    assert_eq!(
        resolve_scope(&limited(&["nope"], &[], false), &listing()),
        Err(refusal("unknown-group: nope"))
    );
    assert_eq!(
        resolve_scope(&limited(&["g1"], &["nope"], false), &listing()),
        Err(refusal("unknown-workspace: nope"))
    );
    assert_eq!(
        resolve_scope(
            &limited(&["g1"], &["w1"], false),
            &ReachListing {
                workspaces: vec![],
                groups: vec![]
            }
        ),
        Err(refusal("unknown-group: g1"))
    );
}

#[test]
fn a_name_that_two_groups_share_must_be_given_by_id() {
    assert_eq!(
        resolve_scope(&limited(&["docs"], &[], false), &listing()),
        Err(refusal("ambiguous-group: docs (pass its id)"))
    );
    assert_eq!(
        resolve_scope(&limited(&["g2", "g3"], &[], false), &listing()),
        Ok(ScriptTokenScope::Limited {
            groups: vec!["g2".to_owned(), "g3".to_owned()],
            workspaces: vec![],
            own_workspaces: false,
        })
    );
}

#[test]
fn an_id_wins_over_a_name_that_matches_another_entry() {
    let mut crossed = listing();
    crossed.workspaces[0].name = "w2".to_owned();
    assert_eq!(
        resolve_scope(&limited(&[], &["w2"], false), &crossed),
        Ok(ScriptTokenScope::Limited {
            groups: vec![],
            workspaces: vec!["w2".to_owned()],
            own_workspaces: false,
        })
    );
}

#[test]
fn resolves_groups_before_workspaces_when_both_are_unknown() {
    assert_eq!(
        resolve_scope(&limited(&["gone"], &["gone"], false), &listing()),
        Err(refusal("unknown-group: gone"))
    );
}
