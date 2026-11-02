#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::incident::{
    INCIDENT_BLOCK_TAG, INCIDENT_EVENTS_MAX, INCIDENT_KEEP_MS, INCIDENT_KEPT_MAX,
    INCIDENT_PANES_MAX, INCIDENT_PERIODS, INCIDENT_STALL_MS, INCIDENT_WINDOW_MS,
    INCIDENT_WORDS_MAX, IncidentPeriod, parse_incident_block, trigger_words,
};
use serde_json::{Value, json};

fn snapshot() -> Value {
    json!({"agent": "claude", "state": "idle", "drafting": false, "mail": 0, "alive": true})
}

fn block() -> Value {
    json!({
        "version": 1,
        "app": "0.5.9",
        "platform": "linux",
        "agent": {"kind": "claude", "version": "2.1.0"},
        "settings": {"hooks": true, "wake": false},
        "pane": "P1",
        "trigger": "call-open",
        "events": [
            {"k": "call", "at": 10, "method": "agent.send", "from": "P2", "phase": "start",
             "name": "send", "ms": 5, "code": "ok", "before": snapshot(), "after": snapshot()},
            {"k": "state", "at": 20, "to": "busy", "from": "idle"},
            {"k": "hook", "at": 30, "ok": true, "code": "stop"},
            {"k": "mail", "at": 40, "code": "queued", "age": 3},
            {"k": "wake", "at": 50, "code": "idle", "ms": 7}
        ],
        "unseen": ["queued"],
        "counts": {"call.start": 4},
        "sinceMin": 12
    })
}

fn with(path: &[&str], value: Value) -> Value {
    let mut root = block();
    let mut node = &mut root;
    for key in &path[..path.len() - 1] {
        node = match key.parse::<usize>() {
            Ok(index) => &mut node[index],
            Err(_) => &mut node[*key],
        };
    }
    let last = path[path.len() - 1];
    match last.parse::<usize>() {
        Ok(index) => node[index] = value,
        Err(_) => node[last] = value,
    }
    root
}

fn without(path: &[&str]) -> Value {
    let mut root = block();
    let mut node = &mut root;
    for key in &path[..path.len() - 1] {
        node = match key.parse::<usize>() {
            Ok(index) => &mut node[index],
            Err(_) => &mut node[*key],
        };
    }
    node.as_object_mut().unwrap().remove(path[path.len() - 1]);
    root
}

fn accepts(value: &Value) -> bool {
    parse_incident_block(value).is_some()
}

#[test]
fn holds_the_incident_limits_and_names() {
    assert_eq!(INCIDENT_WINDOW_MS, 300_000);
    assert_eq!(INCIDENT_EVENTS_MAX, 50);
    assert_eq!(INCIDENT_PANES_MAX, 32);
    assert_eq!(INCIDENT_STALL_MS, 8000);
    assert_eq!(INCIDENT_KEPT_MAX, 20);
    assert_eq!(INCIDENT_KEEP_MS, 2_592_000_000);
    assert_eq!(INCIDENT_BLOCK_TAG, "ostia-incident");
    assert_eq!(INCIDENT_WORDS_MAX, 2000);
}

#[test]
fn maps_each_period_to_its_name_and_length_in_milliseconds() {
    let table = [
        (IncidentPeriod::Day, "24h", 86_400_000),
        (IncidentPeriod::Week, "7d", 604_800_000),
        (IncidentPeriod::Month, "30d", INCIDENT_KEEP_MS),
    ];
    assert_eq!(
        INCIDENT_PERIODS,
        [
            IncidentPeriod::Day,
            IncidentPeriod::Week,
            IncidentPeriod::Month
        ]
    );
    for (period, name, ms) in table {
        assert_eq!(period.as_str(), name);
        assert_eq!(period.window_ms(), ms, "{name}");
        assert_eq!(IncidentPeriod::parse(name), Some(period), "{name}");
    }
    assert_eq!(IncidentPeriod::parse("1h"), None);
    assert_eq!(IncidentPeriod::parse(""), None);
}

#[test]
fn words_every_known_trigger() {
    let table = [
        ("call-open", "A call never returned"),
        ("slow-call", "A call was slow"),
        ("call-cancelled", "A call was cancelled"),
        ("not-submitted", "Enter not submitted"),
        ("not-queued", "Message not queued"),
        ("not-started", "Agent did not start"),
        ("not-recorded", "Result not recorded"),
        ("still-open", "Pane did not close"),
        ("wake-not-ready", "Wake never got ready"),
        ("lease-timeout", "Mail waited too long"),
        ("pane-closed", "Mail target closed"),
        ("agent-refused", "Agent refused mail"),
        ("inbox-full", "Inbox full"),
        ("hook-failed", "A hook failed"),
        (
            "folder-not-trusted",
            "Agent run refused: folder not trusted",
        ),
        ("undelivered-hooks-off", "Mail not delivered: hooks off"),
        (
            "undelivered-idle-no-wake",
            "Mail not delivered: agent idle, not woken",
        ),
        (
            "undelivered-hibernated",
            "Mail not delivered: agent hibernated",
        ),
        (
            "undelivered-no-agent",
            "Mail not delivered: no agent in the pane",
        ),
        (
            "undelivered-rate-limited",
            "Mail not delivered: wake limit reached",
        ),
    ];
    for (code, words) in table {
        assert_eq!(trigger_words(code), words, "{code}");
    }
}

#[test]
fn words_an_unknown_trigger_by_replacing_every_dash_with_a_space() {
    let table = [
        ("some-new-code", "some new code"),
        ("plain", "plain"),
        ("", ""),
        ("-a-", " a "),
        ("Call-Open", "Call Open"),
    ];
    for (code, words) in table {
        assert_eq!(trigger_words(code), words, "{code:?}");
    }
}

#[test]
fn accepts_a_full_block_and_writes_it_back_unchanged() {
    let parsed = parse_incident_block(&block()).unwrap();
    assert_eq!(serde_json::to_value(&parsed).unwrap(), block());
}

#[test]
fn writes_the_fields_in_schema_order_whatever_the_input_order() {
    let shuffled = json!({
        "sinceMin": 12,
        "counts": {},
        "unseen": [],
        "events": [{"phase": "end", "method": "agent.send", "at": 1, "k": "call"}],
        "trigger": "call-open",
        "pane": "P1",
        "settings": {},
        "agent": {"version": "1.0", "kind": "claude"},
        "platform": "linux",
        "app": "0.5.9",
        "version": 1
    });
    let text = serde_json::to_string(&parse_incident_block(&shuffled).unwrap()).unwrap();
    assert_eq!(
        text,
        r#"{"version":1,"app":"0.5.9","platform":"linux","agent":{"kind":"claude","version":"1.0"},"settings":{},"pane":"P1","trigger":"call-open","events":[{"k":"call","at":1,"method":"agent.send","phase":"end"}],"unseen":[],"counts":{},"sinceMin":12}"#
    );
}

#[test]
fn omits_an_optional_field_that_is_absent() {
    let minimal = without(&["agent", "version"]);
    let parsed = parse_incident_block(&minimal).unwrap();
    assert_eq!(
        serde_json::to_value(&parsed).unwrap()["agent"],
        json!({"kind": "claude"})
    );
}

#[test]
fn refuses_a_missing_required_field() {
    for key in [
        "version", "app", "platform", "agent", "settings", "pane", "trigger", "events", "unseen",
        "counts", "sinceMin",
    ] {
        assert!(!accepts(&without(&[key])), "{key}");
    }
    assert!(!accepts(&without(&["agent", "kind"])));
    assert!(!accepts(&without(&["events", "0", "method"])));
    assert!(!accepts(&without(&["events", "0", "at"])));
}

#[test]
fn refuses_an_unknown_field_at_every_level() {
    let mut top = block();
    top["extra"] = json!(1);
    assert!(!accepts(&top));
    assert!(!accepts(&with(
        &["agent"],
        json!({"kind": "claude", "extra": 1})
    )));
    assert!(!accepts(&with(
        &["events", "1"],
        json!({"k": "state", "at": 1, "to": "busy", "extra": 1})
    )));
    let mut call = block()["events"][0].clone();
    call["before"]["extra"] = json!(1);
    assert!(!accepts(&with(&["events", "0"], call)));
}

#[test]
fn accepts_only_version_one() {
    assert!(accepts(&with(&["version"], json!(1))));
    for version in [json!(2), json!(0), json!("1"), json!(null), json!(1.5)] {
        assert!(!accepts(&with(&["version"], version.clone())), "{version}");
    }
}

#[test]
fn checks_the_app_and_agent_version_pattern() {
    let at_limit = "1".repeat(40);
    let over_limit = "1".repeat(41);
    let table = [
        ("0.5.9", true),
        ("1.0.0-rc.1", true),
        ("1.0+build", true),
        ("a", true),
        ("", false),
        ("has space", false),
        ("under_score", false),
        ("é", false),
        (at_limit.as_str(), true),
        (over_limit.as_str(), false),
    ];
    for (text, ok) in table {
        assert_eq!(accepts(&with(&["app"], json!(text))), ok, "app {text:?}");
        assert_eq!(
            accepts(&with(&["agent", "version"], json!(text))),
            ok,
            "agent version {text:?}"
        );
    }
}

#[test]
fn checks_the_code_pattern_for_platform_trigger_and_agent_kind() {
    let long_ok = format!("a{}", "b".repeat(40));
    let long_bad = format!("a{}", "b".repeat(41));
    let table = [
        ("linux", true),
        ("a", true),
        ("a.b-c", true),
        ("a-", true),
        (long_ok.as_str(), true),
        (long_bad.as_str(), false),
        ("", false),
        ("1a", false),
        ("-a", false),
        (".a", false),
        ("A", false),
        ("a_b", false),
        ("a b", false),
        ("a\n", false),
    ];
    for (text, ok) in table {
        assert_eq!(
            accepts(&with(&["platform"], json!(text))),
            ok,
            "platform {text:?}"
        );
        assert_eq!(
            accepts(&with(&["trigger"], json!(text))),
            ok,
            "trigger {text:?}"
        );
        assert_eq!(
            accepts(&with(&["agent", "kind"], json!(text))),
            ok,
            "kind {text:?}"
        );
        assert_eq!(
            accepts(&with(&["unseen"], json!([text]))),
            ok,
            "unseen {text:?}"
        );
    }
}

#[test]
fn checks_the_pane_alias_pattern() {
    let table = [
        ("P1", true),
        ("P9", true),
        ("P10", true),
        ("P99", true),
        ("P0", false),
        ("P01", false),
        ("P100", false),
        ("p1", false),
        ("P", false),
        ("", false),
        ("P1\n", false),
    ];
    for (alias, ok) in table {
        assert_eq!(
            accepts(&with(&["pane"], json!(alias))),
            ok,
            "pane {alias:?}"
        );
        assert_eq!(
            accepts(&with(&["events", "0", "from"], json!(alias))),
            ok,
            "from {alias:?}"
        );
    }
}

#[test]
fn checks_the_method_pattern() {
    let long_ok = format!("a{}", "b".repeat(60));
    let long_bad = format!("a{}", "b".repeat(61));
    let table = [
        ("agent.send", true),
        ("a", true),
        ("aB.c", true),
        (long_ok.as_str(), true),
        (long_bad.as_str(), false),
        ("", false),
        ("Agent", false),
        ("a-b", false),
        ("a_b", false),
        ("a1", false),
        (".a", false),
    ];
    for (method, ok) in table {
        assert_eq!(
            accepts(&with(&["events", "0", "method"], json!(method))),
            ok,
            "{method:?}"
        );
    }
}

#[test]
fn caps_events_at_fifty_and_unseen_at_twenty() {
    let event = json!({"k": "state", "at": 1, "to": "busy"});
    assert!(accepts(&with(&["events"], json!(vec![event.clone(); 50]))));
    assert!(!accepts(&with(&["events"], json!(vec![event; 51]))));
    assert!(accepts(&with(&["events"], json!([]))));
    assert!(accepts(&with(&["unseen"], json!(vec!["queued"; 20]))));
    assert!(!accepts(&with(&["unseen"], json!(vec!["queued"; 21]))));
}

#[test]
fn takes_each_event_kind_and_refuses_an_unknown_or_missing_kind() {
    for index in 0..5 {
        let event = block()["events"][index].clone();
        assert!(
            accepts(&with(&["events", &index.to_string()], event)),
            "{index}"
        );
    }
    assert!(!accepts(&with(
        &["events", "1"],
        json!({"k": "other", "at": 1, "to": "busy"})
    )));
    assert!(!accepts(&with(
        &["events", "1"],
        json!({"at": 1, "to": "busy"})
    )));
    assert!(!accepts(&with(
        &["events", "1"],
        json!({"k": null, "at": 1, "to": "busy"})
    )));
}

#[test]
fn refuses_a_field_that_belongs_to_another_event_kind() {
    assert!(!accepts(&with(
        &["events", "1"],
        json!({"k": "state", "at": 1, "to": "busy", "ms": 1})
    )));
    assert!(!accepts(&with(
        &["events", "2"],
        json!({"k": "hook", "at": 1, "ok": true, "method": "a"})
    )));
    assert!(!accepts(&with(
        &["events", "3"],
        json!({"k": "mail", "at": 1, "code": "queued", "ms": 1})
    )));
    assert!(!accepts(&with(
        &["events", "4"],
        json!({"k": "wake", "at": 1, "code": "idle", "ms": 1, "age": 1})
    )));
}

#[test]
fn requires_the_fields_of_each_event_kind() {
    assert!(!accepts(&with(
        &["events", "1"],
        json!({"k": "state", "at": 1})
    )));
    assert!(!accepts(&with(
        &["events", "2"],
        json!({"k": "hook", "at": 1})
    )));
    assert!(!accepts(&with(
        &["events", "3"],
        json!({"k": "mail", "at": 1})
    )));
    assert!(!accepts(&with(
        &["events", "4"],
        json!({"k": "wake", "at": 1, "code": "idle"})
    )));
    assert!(!accepts(&with(
        &["events", "0"],
        json!({"k": "call", "at": 1, "method": "a"})
    )));
    assert!(accepts(&with(
        &["events", "0"],
        json!({"k": "call", "at": 1, "method": "a", "phase": "cancel"})
    )));
}

#[test]
fn takes_only_the_four_call_phases() {
    for phase in ["start", "end", "cancel", "phase"] {
        assert!(
            accepts(&with(&["events", "0", "phase"], json!(phase))),
            "{phase}"
        );
    }
    for phase in ["", "Start", "stop", "end "] {
        assert!(
            !accepts(&with(&["events", "0", "phase"], json!(phase))),
            "{phase:?}"
        );
    }
    assert!(!accepts(&with(&["events", "0", "phase"], json!(1))));
}

#[test]
fn holds_every_millisecond_field_to_whole_numbers_from_zero_to_twice_the_window() {
    let paths: [(&str, &[&str]); 5] = [
        ("at", &["events", "0", "at"]),
        ("call ms", &["events", "0", "ms"]),
        ("mail age", &["events", "3", "age"]),
        ("wake ms", &["events", "4", "ms"]),
        ("state at", &["events", "1", "at"]),
    ];
    let max = INCIDENT_WINDOW_MS * 2;
    for (name, path) in paths {
        assert!(accepts(&with(path, json!(0))), "{name} 0");
        assert!(accepts(&with(path, json!(max))), "{name} max");
        assert!(!accepts(&with(path, json!(max + 1))), "{name} over");
        assert!(!accepts(&with(path, json!(-1))), "{name} negative");
        assert!(!accepts(&with(path, json!(1.5))), "{name} fraction");
        assert!(!accepts(&with(path, json!("5"))), "{name} string");
        assert!(!accepts(&with(path, json!(null))), "{name} null");
    }
}

#[test]
fn counts_a_whole_number_written_with_a_fraction_part_as_an_integer() {
    let text = serde_json::to_string(&block())
        .unwrap()
        .replace(r#""at":10"#, r#""at":10.0"#)
        .replace(r#""sinceMin":12"#, r#""sinceMin":12.0"#);
    let value: Value = serde_json::from_str(&text).unwrap();
    let parsed = parse_incident_block(&value).unwrap();
    let written = serde_json::to_value(&parsed).unwrap();
    assert_eq!(written["events"][0]["at"], json!(10));
    assert_eq!(written["sinceMin"], json!(12));
}

#[test]
fn refuses_null_for_an_optional_field() {
    for path in [
        &["events", "0", "from"][..],
        &["events", "0", "name"],
        &["events", "0", "ms"],
        &["events", "0", "code"],
        &["events", "0", "before"],
        &["events", "0", "after"],
        &["events", "1", "from"],
        &["events", "2", "code"],
        &["events", "3", "age"],
        &["agent", "version"],
    ] {
        assert!(!accepts(&with(path, json!(null))), "{path:?}");
    }
}

#[test]
fn checks_the_snapshot_fields() {
    let table = [
        ("mail", json!(999), true),
        ("mail", json!(0), true),
        ("mail", json!(1000), false),
        ("mail", json!(-1), false),
        ("mail", json!(1.5), false),
        ("drafting", json!("no"), false),
        ("alive", json!(null), false),
        ("agent", json!("Claude"), false),
        ("state", json!(""), false),
    ];
    for (field, value, ok) in table {
        let mut snap = snapshot();
        snap[field] = value.clone();
        assert_eq!(
            accepts(&with(&["events", "0", "before"], snap.clone())),
            ok,
            "before {field} {value}"
        );
        assert_eq!(
            accepts(&with(&["events", "0", "after"], snap)),
            ok,
            "after {field} {value}"
        );
    }
}

#[test]
fn checks_the_settings_keys_and_holds_every_value_to_a_boolean() {
    assert!(accepts(&with(&["settings"], json!({}))));
    assert!(accepts(&with(&["settings"], json!({"a.b-c": false}))));
    assert!(!accepts(&with(&["settings"], json!({"Bad": true}))));
    assert!(!accepts(&with(&["settings"], json!({"": true}))));
    assert!(!accepts(&with(&["settings"], json!({"ok": 1}))));
    assert!(!accepts(&with(&["settings"], json!({"ok": null}))));
    assert!(!accepts(&with(&["settings"], json!([]))));
}

#[test]
fn checks_the_count_keys_and_limits_every_value_to_a_million() {
    let long_ok = format!("a{}", "b".repeat(70));
    let long_bad = format!("a{}", "b".repeat(71));
    assert!(accepts(&with(&["counts"], json!({}))));
    assert!(accepts(&with(
        &["counts"],
        json!({"aB.c-d": 0, long_ok: 1_000_000})
    )));
    assert!(!accepts(&with(&["counts"], json!({long_bad: 1}))));
    for key in ["", "1a", "a_b", ".a", "a b"] {
        assert!(!accepts(&with(&["counts"], json!({key: 1}))), "{key:?}");
    }
    for value in [
        json!(1_000_001),
        json!(-1),
        json!(1.5),
        json!("1"),
        json!(null),
    ] {
        assert!(
            !accepts(&with(&["counts"], json!({"a": value.clone()}))),
            "{value}"
        );
    }
}

#[test]
fn limits_the_minutes_since_to_a_whole_number_up_to_one_hundred_thousand() {
    assert!(accepts(&with(&["sinceMin"], json!(0))));
    assert!(accepts(&with(&["sinceMin"], json!(100_000))));
    for value in [
        json!(100_001),
        json!(-1),
        json!(0.5),
        json!("1"),
        json!(null),
    ] {
        assert!(!accepts(&with(&["sinceMin"], value.clone())), "{value}");
    }
}

#[test]
fn refuses_a_value_that_is_not_an_object() {
    for value in [json!(null), json!([]), json!("x"), json!(1), json!(true)] {
        assert!(!accepts(&value), "{value}");
    }
}

#[test]
fn exposes_the_parsed_block_fields_and_serializes_it_back() {
    let parsed = parse_incident_block(&block()).unwrap();
    assert_eq!(parsed.pane, "P1");
    assert_eq!(parsed.since_min, 12);
    assert_eq!(parsed.agent.kind, "claude");
    assert_eq!(parsed.events.len(), 5);
    assert_eq!(serde_json::to_value(&parsed).unwrap(), block());
}
