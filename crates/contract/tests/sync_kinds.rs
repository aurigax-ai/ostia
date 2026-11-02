#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::sync_kinds::{SYNC_KINDS, SyncKind, off_kinds, parse_sync_kinds};
use serde_json::{Value, json};

fn all_on() -> Value {
    json!({"settings": true, "snippets": true, "completions": true, "views": true, "extensions": true})
}

fn parsed(raw: &Value) -> Value {
    serde_json::to_value(parse_sync_kinds(raw)).unwrap()
}

#[test]
fn lists_the_five_kinds_in_order() {
    let names: Vec<&str> = SYNC_KINDS.iter().map(|kind| kind.as_str()).collect();
    assert_eq!(
        names,
        ["settings", "snippets", "completions", "views", "extensions"]
    );
}

#[test]
fn turns_every_kind_on_when_the_input_is_not_an_object() {
    for raw in [
        Value::Null,
        json!(true),
        json!(0),
        json!("settings"),
        json!([false, false]),
    ] {
        assert_eq!(parsed(&raw), all_on(), "raw: {raw}");
    }
}

#[test]
fn turns_every_kind_on_for_an_empty_object() {
    assert_eq!(parsed(&json!({})), all_on());
}

#[test]
fn turns_a_kind_off_only_for_the_value_false() {
    assert_eq!(
        parsed(&json!({"snippets": false, "views": false})),
        json!({"settings": true, "snippets": false, "completions": true, "views": false, "extensions": true})
    );
}

#[test]
fn keeps_a_kind_on_for_a_value_that_only_looks_false() {
    for value in [json!(0), json!(null), json!(""), json!("false"), json!([])] {
        let raw = json!({"settings": value});
        assert_eq!(parsed(&raw), all_on(), "value: {value}");
    }
}

#[test]
fn ignores_keys_that_are_not_kinds() {
    assert_eq!(parsed(&json!({"theme": false, "extra": 1})), all_on());
}

#[test]
fn reads_a_kind_flag_through_get() {
    let kinds = parse_sync_kinds(&json!({"completions": false}));
    for kind in SYNC_KINDS {
        assert_eq!(
            kinds.get(kind),
            kind != SyncKind::Completions,
            "kind: {}",
            kind.as_str()
        );
    }
}

#[test]
fn writes_the_kinds_in_the_order_of_the_list() {
    let text = serde_json::to_string(&parse_sync_kinds(&json!({"extensions": false}))).unwrap();
    assert_eq!(
        text,
        r#"{"settings":true,"snippets":true,"completions":true,"views":true,"extensions":false}"#
    );
}

#[test]
fn gives_no_off_kinds_when_the_input_is_not_an_object() {
    for raw in [Value::Null, json!(1), json!("views"), json!([false])] {
        assert_eq!(off_kinds(&raw), None, "raw: {raw}");
    }
}

#[test]
fn gives_no_off_kinds_when_nothing_is_false() {
    assert_eq!(off_kinds(&json!({})), None);
    assert_eq!(off_kinds(&all_on()), None);
    assert_eq!(off_kinds(&json!({"settings": 0, "views": null})), None);
}

#[test]
fn lists_only_the_kinds_that_are_false() {
    assert_eq!(
        off_kinds(&json!({"settings": true, "views": false, "snippets": false})),
        Some(json!({"snippets": false, "views": false}))
    );
}

#[test]
fn lists_off_kinds_in_the_order_of_the_list_and_not_the_input() {
    let off = off_kinds(&json!({"extensions": false, "settings": false})).unwrap();
    assert_eq!(
        serde_json::to_string(&off).unwrap(),
        r#"{"settings":false,"extensions":false}"#
    );
}

#[test]
fn lists_every_kind_when_all_are_false() {
    let raw = json!({"settings": false, "snippets": false, "completions": false, "views": false, "extensions": false});
    assert_eq!(off_kinds(&raw), Some(raw));
}
