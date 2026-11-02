#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::settings::actions::{
    ACTION_TITLE_MAX, ACTIONS_MAX, ActionContext, ActionPlace, UserAction, action_fingerprint,
    actions_for, fill_args, parse_actions,
};
use serde_json::{Map, Value, json};

fn as_json(actions: &[UserAction]) -> Value {
    serde_json::to_value(actions).unwrap()
}

fn ids(actions: &[UserAction]) -> Vec<&str> {
    actions.iter().map(|a| a.id.as_str()).collect()
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        other => panic!("not an object: {other}"),
    }
}

fn one(entry: Value) -> Vec<UserAction> {
    parse_actions(&json!([entry]))
}

#[test]
fn keeps_well_formed_actions_and_drops_malformed_or_duplicate_ones() {
    let parsed = parse_actions(&json!([
        { "id": "docs", "title": "Docs", "command": "browser.open", "args": { "url": "https://x.dev" } },
        { "id": "docs", "title": "Again", "command": "pane.split" },
        { "id": "Bad Id", "title": "x", "command": "pane.split" },
        { "id": "icon", "title": "x", "command": "pane.split", "icon": "skull" },
        { "id": "place", "title": "x", "command": "pane.split", "in": ["statusBar"] },
        { "id": "cmd", "title": "x", "command": "rm -rf /" },
        {
            "id": "split",
            "title": "Split",
            "command": "pane.split",
            "icon": "terminal",
            "in": ["paneHeader"],
            "paneKinds": ["terminal"]
        }
    ]));
    assert_eq!(
        as_json(&parsed),
        json!([
            {
                "id": "docs",
                "title": "Docs",
                "command": "browser.open",
                "args": { "url": "https://x.dev" },
                "in": []
            },
            {
                "id": "split",
                "title": "Split",
                "command": "pane.split",
                "icon": "terminal",
                "in": ["paneHeader"],
                "paneKinds": ["terminal"]
            }
        ])
    );
}

#[test]
fn returns_an_empty_list_for_anything_that_is_not_an_array() {
    assert!(parse_actions(&json!({ "id": "x" })).is_empty());
    assert!(parse_actions(&Value::Null).is_empty());
    assert!(parse_actions(&json!("docs")).is_empty());
}

#[test]
fn fills_cwd_and_file_in_nested_strings_and_leaves_other_values_alone() {
    let args = object(json!({
        "url": "file://{file}",
        "nested": { "dir": "{cwd}/out", "list": ["{cwd}", 2] },
        "n": 1
    }));
    let ctx = ActionContext {
        cwd: Some("/w".to_owned()),
        file: Some("/w/a.md".to_owned()),
    };
    assert_eq!(
        fill_args(Some(&args), &ctx),
        Some(object(json!({
            "url": "file:///w/a.md",
            "nested": { "dir": "/w/out", "list": ["/w", 2] },
            "n": 1
        })))
    );
}

#[test]
fn returns_the_actions_for_a_place_and_pane_kind() {
    let actions = parse_actions(&json!([
        { "id": "a", "title": "A", "command": "x", "in": ["paneHeader"] },
        { "id": "b", "title": "B", "command": "x", "in": ["paneHeader"], "paneKinds": ["editor"] },
        { "id": "c", "title": "C", "command": "x", "in": ["tabMenu"] }
    ]));
    assert_eq!(
        ids(&actions_for(&actions, ActionPlace::PaneHeader, "terminal")),
        vec!["a"]
    );
    assert_eq!(
        ids(&actions_for(&actions, ActionPlace::PaneHeader, "editor")),
        vec!["a", "b"]
    );
}

#[test]
fn changes_when_the_command_or_its_arguments_change_not_the_title() {
    let base = action_fingerprint("x", Some(&object(json!({ "a": 1 }))));
    assert_eq!(
        base,
        action_fingerprint("x", Some(&object(json!({ "a": 1 }))))
    );
    assert_ne!(
        base,
        action_fingerprint("x", Some(&object(json!({ "a": 2 }))))
    );
    assert_ne!(
        base,
        action_fingerprint("y", Some(&object(json!({ "a": 1 }))))
    );
}

#[test]
fn writes_the_fingerprint_as_a_json_pair_with_null_for_missing_arguments() {
    assert_eq!(action_fingerprint("x", None), r#"["x",null]"#);
    assert_eq!(
        action_fingerprint("x", Some(&object(json!({ "a": [1, "b"] })))),
        r#"["x",{"a":[1,"b"]}]"#
    );
}

#[test]
fn drops_an_action_whose_id_is_not_a_lowercase_slug_of_at_most_forty_characters() {
    for (row, id) in [
        ("empty", String::new()),
        ("upper", "Docs".to_owned()),
        ("leading dash", "-docs".to_owned()),
        ("space", "do cs".to_owned()),
        ("underscore", "do_cs".to_owned()),
        ("too long", "a".repeat(41)),
    ] {
        assert!(
            one(json!({ "id": id, "title": "T", "command": "x" })).is_empty(),
            "row {row}"
        );
    }
    for (row, id) in [
        ("single", "a".to_owned()),
        ("digit first", "1a".to_owned()),
        ("dashes", "a-b-c".to_owned()),
        ("longest", "a".repeat(40)),
    ] {
        assert_eq!(
            one(json!({ "id": id, "title": "T", "command": "x" })).len(),
            1,
            "row {row}"
        );
    }
    assert!(one(json!({ "title": "T", "command": "x" })).is_empty());
    assert!(one(json!({ "id": 3, "title": "T", "command": "x" })).is_empty());
}

#[test]
fn drops_an_action_whose_title_is_blank_too_long_or_not_a_string() {
    assert_eq!(ACTION_TITLE_MAX, 60);
    for (row, title) in [
        ("empty", json!("")),
        ("blank", json!("  \t ")),
        ("too long", json!("t".repeat(61))),
        ("number", json!(5)),
        ("null", json!(null)),
    ] {
        assert!(
            one(json!({ "id": "a", "title": title, "command": "x" })).is_empty(),
            "row {row}"
        );
    }
    let longest = "t".repeat(60);
    assert_eq!(
        as_json(&one(json!({ "id": "a", "title": longest, "command": "x" })))[0]["title"],
        json!(longest)
    );
    let padded = " Docs ";
    assert_eq!(
        as_json(&one(json!({ "id": "a", "title": padded, "command": "x" })))[0]["title"],
        json!(padded)
    );
}

#[test]
fn counts_the_title_limit_in_utf16_units() {
    let thirty_emoji = "😀".repeat(30);
    let thirty_one_emoji = "😀".repeat(31);
    assert_eq!(
        one(json!({ "id": "a", "title": thirty_emoji, "command": "x" })).len(),
        1
    );
    assert!(one(json!({ "id": "a", "title": thirty_one_emoji, "command": "x" })).is_empty());
}

#[test]
fn drops_an_action_whose_command_is_not_a_dotted_identifier() {
    for (row, command) in [
        ("empty", json!("")),
        ("space", json!("pane split")),
        ("slash", json!("a/b")),
        ("leading dot", json!(".x")),
        ("too long", json!("c".repeat(101))),
        ("number", json!(1)),
    ] {
        assert!(
            one(json!({ "id": "a", "title": "T", "command": command })).is_empty(),
            "row {row}"
        );
    }
    for (row, command) in [
        ("dotted", "browser.open".to_owned()),
        ("underscore", "A_b-c.d".to_owned()),
        ("longest", "c".repeat(100)),
    ] {
        assert_eq!(
            one(json!({ "id": "a", "title": "T", "command": command })).len(),
            1,
            "row {row}"
        );
    }
}

#[test]
fn drops_an_action_whose_arguments_are_not_an_object_or_serialize_past_the_limit() {
    for (row, args) in [
        ("array", json!([1])),
        ("string", json!("x")),
        ("null", json!(null)),
        ("number", json!(0)),
    ] {
        assert!(
            one(json!({ "id": "a", "title": "T", "command": "x", "args": args })).is_empty(),
            "row {row}"
        );
    }
    let fits = json!({ "k": "a".repeat(4096 - 8) });
    assert_eq!(serde_json::to_string(&fits).unwrap().len(), 4096);
    assert_eq!(
        one(json!({ "id": "a", "title": "T", "command": "x", "args": fits })).len(),
        1
    );
    let over = json!({ "k": "a".repeat(4096 - 7) });
    assert_eq!(serde_json::to_string(&over).unwrap().len(), 4097);
    assert!(one(json!({ "id": "a", "title": "T", "command": "x", "args": over })).is_empty());
}

#[test]
fn keeps_empty_arguments_and_writes_the_fields_in_the_ts_order() {
    let parsed = one(json!({
        "paneKinds": ["git"],
        "in": ["tabMenu"],
        "icon": "bug",
        "args": {},
        "command": "x",
        "title": "T",
        "id": "a"
    }));
    let text = serde_json::to_string(&parsed).unwrap();
    assert_eq!(
        text,
        r#"[{"id":"a","title":"T","command":"x","args":{},"icon":"bug","in":["tabMenu"],"paneKinds":["git"]}]"#
    );
}

#[test]
fn accepts_every_listed_icon_and_refuses_others() {
    for icon in [
        "lightning",
        "play",
        "terminal",
        "globe",
        "folder",
        "file",
        "git-branch",
        "bug",
        "rocket",
        "sparkle",
        "robot",
        "code",
        "book",
        "gear",
        "wrench",
        "refresh",
        "search",
        "database",
        "package",
        "flask",
        "eye",
        "link",
        "chat",
        "checklist",
        "broom",
    ] {
        let parsed = one(json!({ "id": "a", "title": "T", "command": "x", "icon": icon }));
        assert_eq!(as_json(&parsed)[0]["icon"], json!(icon), "icon {icon}");
    }
    for (row, icon) in [
        ("unknown", json!("skull")),
        ("empty", json!("")),
        ("wrong case", json!("Bug")),
        ("number", json!(1)),
        ("null", json!(null)),
    ] {
        assert!(
            one(json!({ "id": "a", "title": "T", "command": "x", "icon": icon })).is_empty(),
            "row {row}"
        );
    }
}

#[test]
fn dedupes_places_and_pane_kinds_in_first_seen_order() {
    let parsed = one(json!({
        "id": "a",
        "title": "T",
        "command": "x",
        "in": ["tabMenu", "paneHeader", "tabMenu"],
        "paneKinds": ["editor", "terminal", "editor"]
    }));
    let value = as_json(&parsed);
    assert_eq!(value[0]["in"], json!(["tabMenu", "paneHeader"]));
    assert_eq!(value[0]["paneKinds"], json!(["editor", "terminal"]));
}

#[test]
fn drops_an_action_with_an_invalid_place_or_pane_kind_list() {
    for (row, places) in [
        ("string", json!("paneHeader")),
        ("null", json!(null)),
        ("unknown", json!(["paneHeader", "dock"])),
        ("not strings", json!([1])),
    ] {
        assert!(
            one(json!({ "id": "a", "title": "T", "command": "x", "in": places })).is_empty(),
            "in row {row}"
        );
    }
    for (row, kinds) in [
        ("string", json!("editor")),
        ("null", json!(null)),
        ("unknown", json!(["editor", "chat"])),
    ] {
        assert!(
            one(json!({ "id": "a", "title": "T", "command": "x", "paneKinds": kinds })).is_empty(),
            "paneKinds row {row}"
        );
    }
}

#[test]
fn accepts_every_pane_kind() {
    let parsed = one(json!({
        "id": "a",
        "title": "T",
        "command": "x",
        "paneKinds": ["terminal", "editor", "browser", "git", "diff", "view"]
    }));
    assert_eq!(
        as_json(&parsed)[0]["paneKinds"],
        json!(["terminal", "editor", "browser", "git", "diff", "view"])
    );
}

#[test]
fn keeps_an_empty_pane_kind_list_as_an_action_for_no_pane() {
    let parsed = parse_actions(&json!([
        { "id": "a", "title": "T", "command": "x", "in": ["paneHeader"], "paneKinds": [] }
    ]));
    assert_eq!(as_json(&parsed)[0]["paneKinds"], json!([]));
    assert!(actions_for(&parsed, ActionPlace::PaneHeader, "terminal").is_empty());
}

#[test]
fn drops_an_entry_that_is_not_an_object() {
    let parsed = parse_actions(&json!([
        null,
        1,
        "docs",
        [],
        { "id": "a", "title": "T", "command": "x" }
    ]));
    assert_eq!(ids(&parsed), vec!["a"]);
}

#[test]
fn reads_only_the_first_fifty_entries() {
    assert_eq!(ACTIONS_MAX, 50);
    let mut entries: Vec<Value> = (0..60)
        .map(|i| json!({ "id": format!("a{i}"), "title": "T", "command": "x" }))
        .collect();
    assert_eq!(parse_actions(&Value::Array(entries.clone())).len(), 50);
    entries.splice(0..10, (0..10).map(|_| json!(null)));
    assert_eq!(parse_actions(&Value::Array(entries)).len(), 40);
}

#[test]
fn keeps_the_first_of_two_actions_with_one_id() {
    let parsed = parse_actions(&json!([
        { "id": "a", "title": "First", "command": "x" },
        { "id": "a", "title": "Second", "command": "y" }
    ]));
    assert_eq!(as_json(&parsed)[0]["title"], json!("First"));
    assert_eq!(parsed.len(), 1);
}

#[test]
fn fills_a_missing_context_value_with_an_empty_string() {
    let args = object(json!({ "a": "{cwd}|{file}|{cwd}", "b": "{other}" }));
    let ctx = ActionContext {
        cwd: Some("/w".to_owned()),
        file: None,
    };
    assert_eq!(
        fill_args(Some(&args), &ctx),
        Some(object(json!({ "a": "/w||/w", "b": "{other}" })))
    );
}

#[test]
fn returns_no_arguments_when_there_are_none_to_fill() {
    assert_eq!(fill_args(None, &ActionContext::default()), None);
}

#[test]
fn fills_object_keys_never_and_leaves_null_and_bool_values() {
    let args = object(json!({ "{cwd}": "{cwd}", "z": null, "t": true }));
    let ctx = ActionContext {
        cwd: Some("/w".to_owned()),
        file: None,
    };
    assert_eq!(
        fill_args(Some(&args), &ctx),
        Some(object(json!({ "{cwd}": "/w", "z": null, "t": true })))
    );
}

#[test]
fn returns_the_actions_for_the_tab_menu_in_the_order_they_were_written() {
    let actions = parse_actions(&json!([
        { "id": "b", "title": "B", "command": "x", "in": ["tabMenu"] },
        { "id": "a", "title": "A", "command": "x", "in": ["tabMenu", "paneHeader"] },
        { "id": "c", "title": "C", "command": "x" }
    ]));
    assert_eq!(
        ids(&actions_for(&actions, ActionPlace::TabMenu, "view")),
        vec!["b", "a"]
    );
    assert_eq!(
        ids(&actions_for(&actions, ActionPlace::PaneHeader, "view")),
        vec!["a"]
    );
}
