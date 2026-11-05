#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::view_bindings::{
    ViewFormat, ViewScope, lookup, resolve_args, resolve_text, resolve_value,
};
use serde_json::{Value, json};

const NOW: f64 = 1_767_268_800_000.0;

fn fmt() -> ViewFormat {
    ViewFormat {
        now: NOW,
        locale: "en".to_owned(),
    }
}

fn scope() -> ViewScope {
    let Value::Object(map) = json!({
        "workspace": {"name": "ostia", "unread": 3, "tags": ["a", "b"], "empty": []},
        "workspaces": [{"name": "one"}, {"name": "two"}],
        "clock": {"now": NOW},
    }) else {
        panic!("scope is an object")
    };
    map
}

fn path(text: &str) -> Vec<String> {
    text.split('.').map(str::to_owned).collect()
}

fn found(scope: &ViewScope, text: &str) -> Option<Value> {
    lookup(scope, &path(text)).cloned()
}

#[test]
fn follows_own_properties_and_array_indices() {
    let scope = scope();
    assert_eq!(found(&scope, "workspace.name"), Some(json!("ostia")));
    assert_eq!(found(&scope, "workspaces.1.name"), Some(json!("two")));
}

#[test]
fn returns_undefined_for_missing_paths() {
    let scope = scope();
    for text in ["workspace.missing.deeper", "nothing", "workspaces.9.name"] {
        assert_eq!(found(&scope, text), None, "{text}");
    }
}

#[test]
fn never_reaches_prototypes_or_built_in_members() {
    let scope = scope();
    for text in [
        "workspace.__proto__",
        "workspace.constructor",
        "workspace.toString",
        "workspace.name.length",
        "workspaces.length",
        "workspaces.map",
    ] {
        assert_eq!(found(&scope, text), None, "{text}");
    }
    let Value::Object(other) = json!({"d": 0, "e": "text", "f": true, "g": null}) else {
        panic!("object")
    };
    for text in ["d.getTime", "e.length", "f.valueOf", "g.anything"] {
        assert_eq!(found(&other, text), None, "{text}");
    }
}

#[test]
fn fills_bindings_inside_text_and_blanks_missing_ones() {
    let scope = scope();
    let fmt = fmt();
    assert_eq!(
        resolve_text("Hi {{workspace.name}}!", &scope, &fmt),
        "Hi ostia!"
    );
    assert_eq!(resolve_text("[{{workspace.nope}}]", &scope, &fmt), "[]");
    assert_eq!(resolve_text("{{workspace}}", &scope, &fmt), "");
}

#[test]
fn applies_filters_left_to_right() {
    let scope = scope();
    let fmt = fmt();
    assert_eq!(
        resolve_text("{{workspace.name | upper}}", &scope, &fmt),
        "OSTIA"
    );
    assert_eq!(resolve_text("{{workspaces | count}}", &scope, &fmt), "2");
    assert_eq!(
        resolve_text("{{workspace.empty | count}}", &scope, &fmt),
        "0"
    );
    assert_eq!(
        resolve_text("{{workspace.nope | count}}", &scope, &fmt),
        "0"
    );
    assert_eq!(
        resolve_value("{{workspace.empty | not}}", &scope, &fmt),
        json!(true)
    );
    assert_eq!(
        resolve_value("{{workspace.tags | not}}", &scope, &fmt),
        json!(false)
    );
}

#[test]
fn formats_times_relative_to_now() {
    let scope = scope();
    let fmt = fmt();
    assert_eq!(
        resolve_text("{{clock.now | relative}}", &scope, &fmt),
        "now"
    );
    let Value::Object(earlier) = json!({"t": NOW - 5.0 * 60_000.0}) else {
        panic!("object")
    };
    assert_eq!(
        resolve_text("{{t | relative}}", &earlier, &fmt),
        "5 minutes ago"
    );
    let Value::Object(text) = json!({"t": "x"}) else {
        panic!("object")
    };
    assert_eq!(resolve_text("{{t | time}}", &text, &fmt), "");
}

#[test]
fn counts_a_relative_time_in_days_hours_minutes_or_seconds() {
    let relative = |offset: f64, locale: &str| -> String {
        let Value::Object(scope) = json!({"t": NOW + offset}) else {
            panic!("object")
        };
        let fmt = ViewFormat {
            now: NOW,
            locale: locale.to_owned(),
        };
        resolve_text("{{t | relative}}", &scope, &fmt)
    };
    let table: [(f64, &str, &str); 12] = [
        (-400.0, "en", "now"),
        (-600.0, "en", "1 second ago"),
        (600.0, "en", "in 1 second"),
        (-45_000.0, "en", "45 seconds ago"),
        (-59_600.0, "en", "60 seconds ago"),
        (-60_000.0, "en", "1 minute ago"),
        (-89.0 * 60_000.0, "en", "1 hour ago"),
        (-23.0 * 3_600_000.0, "en", "23 hours ago"),
        (-24.0 * 3_600_000.0, "en", "yesterday"),
        (-365.0 * 86_400_000.0, "en", "365 days ago"),
        (2.0 * 3_600_000.0, "en", "in 2 hours"),
        (-45_000.0, "zh-Hant", "45 秒前"),
    ];
    for (offset, locale, expected) in table {
        assert_eq!(relative(offset, locale), expected, "{offset} {locale}");
    }
    let Value::Object(nan) = json!({"t": f64::NAN}) else {
        panic!("object")
    };
    assert_eq!(resolve_text("{{t | relative}}", &nan, &fmt()), "");
}

#[test]
fn keeps_the_type_of_a_whole_string_binding_and_fills_nested_strings() {
    let resolved = resolve_args(
        &json!({"index": "{{workspace.unread}}", "name": "ws {{workspace.name}}", "n": 1}),
        &scope(),
        &fmt(),
    );
    assert_eq!(resolved, json!({"index": 3, "name": "ws ostia", "n": 1}));
}
