#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::extensions::{
    COMMAND_ARGUMENT_MAX, EXEC_ENV_MAX, EXEC_ENV_VALUE_MAX, EXEC_OUTPUT_DEFAULT, EXEC_OUTPUT_MAX,
    EXEC_TIMEOUT_MAX_MS, EXTENSION_SETTING_STRING_MAX, EXTENSION_VERB_PATTERN, ExtensionIcon,
    ExtensionSettingContribution, INBOX_ITEMS_MAX, INBOX_TEXT_MAX, PANE_CHIP_ITEM_TEXT_MAX,
    PANE_CHIP_ITEMS_MAX, PANEL_PATH_MAX, SIDEBAR_BADGE_PATTERN, SIDEBAR_URL_MAX, SidebarKind,
    SidebarTone, command_argument, effective_setting_values, pane_chip_items, panel_path,
    sidebar_item_url, valid_setting_value,
};
use serde_json::{Value, json};

fn setting(raw: Value) -> ExtensionSettingContribution {
    serde_json::from_value(raw).unwrap()
}

fn chips(raw: &Value) -> Option<Value> {
    pane_chip_items(raw).map(|items| serde_json::to_value(items).unwrap())
}

fn chips_text(raw: &Value) -> String {
    serde_json::to_string(&pane_chip_items(raw).unwrap()).unwrap()
}

fn effective(settings: &[Value], stored: &Value) -> Value {
    let parsed: Vec<ExtensionSettingContribution> = settings.iter().cloned().map(setting).collect();
    serde_json::to_value(effective_setting_values(&parsed, stored)).unwrap()
}

#[test]
fn accepts_http_and_https_urls_normalized() {
    assert_eq!(
        sidebar_item_url(&json!("http://localhost:3000")).as_deref(),
        Some("http://localhost:3000/")
    );
    assert_eq!(
        sidebar_item_url(&json!("https://example.com/a?b=1")).as_deref(),
        Some("https://example.com/a?b=1")
    );
}

#[test]
fn refuses_other_schemes_junk_and_oversized_values() {
    let long = format!("http://x/{}", "a".repeat(SIDEBAR_URL_MAX));
    let bad = [
        json!("file:///etc/passwd"),
        json!("javascript:alert(1)"),
        json!("not a url"),
        json!(42),
        json!(long),
    ];
    for value in bad {
        assert_eq!(sidebar_item_url(&value), None, "{value}");
    }
}

#[test]
fn sidebar_url_refuses_empty_text_and_every_non_string() {
    let bad = [
        json!(""),
        Value::Null,
        json!(true),
        json!([]),
        json!({}),
        json!(["http://x/"]),
        json!({"href": "http://x/"}),
        json!("ftp://example.com/"),
        json!("mailto:a@b.c"),
        json!("data:text/html,x"),
        json!("//example.com/"),
        json!("example.com"),
    ];
    for value in bad {
        assert_eq!(sidebar_item_url(&value), None, "{value}");
    }
}

#[test]
fn sidebar_url_normalizes_scheme_host_default_port_and_keeps_fragment() {
    let rows = [
        ("HTTP://Example.COM", "http://example.com/"),
        ("https://example.com:443/a", "https://example.com/a"),
        ("http://example.com:80/", "http://example.com/"),
        (
            "http://example.com:8080/x#top",
            "http://example.com:8080/x#top",
        ),
        ("https://example.com/a b", "https://example.com/a%20b"),
        ("http://user:pw@example.com/", "http://user:pw@example.com/"),
        ("http://a/b/../c", "http://a/c"),
    ];
    for (raw, want) in rows {
        assert_eq!(
            sidebar_item_url(&json!(raw)).as_deref(),
            Some(want),
            "{raw}"
        );
    }
}

#[test]
fn sidebar_url_limit_counts_utf16_units_of_the_raw_text() {
    let at_limit = format!("http://x/{}", "a".repeat(SIDEBAR_URL_MAX - 9));
    assert_eq!(at_limit.len(), SIDEBAR_URL_MAX);
    assert!(sidebar_item_url(&json!(at_limit)).is_some());
    let over = format!("http://x/{}", "a".repeat(SIDEBAR_URL_MAX - 8));
    assert_eq!(sidebar_item_url(&json!(over)), None);
    let emoji = format!("http://x/{}", "😀".repeat(1020));
    assert_eq!(emoji.chars().count(), 1029);
    assert_eq!(sidebar_item_url(&json!(emoji)), None);
}

#[test]
fn rpf_c10_keeps_the_port_of_an_item_and_refuses_a_bad_one() {
    assert_eq!(
        chips(&json!([{"text": ":3000", "port": {"remote": 3000, "local": 3000}}])),
        Some(json!([{"text": ":3000", "port": {"remote": 3000, "local": 3000}}]))
    );
    assert_eq!(
        chips(&json!([{"text": ":8080", "port": {"remote": 8080}}])),
        Some(json!([{"text": ":8080", "port": {"remote": 8080}}]))
    );
    assert_eq!(chips(&json!([{"text": ":0", "port": {"remote": 0}}])), None);
    assert_eq!(
        chips(&json!([{"text": ":1", "port": {"remote": 1, "local": 70000}}])),
        None
    );
}

#[test]
fn keeps_an_item_detail_trimmed_and_capped_and_drops_an_empty_or_non_text_one() {
    let long = "x".repeat(PANE_CHIP_ITEM_TEXT_MAX + 5);
    let kept = "x".repeat(PANE_CHIP_ITEM_TEXT_MAX);
    let got = chips(&json!([
        {"text": ":5173", "detail": " node ", "url": "http://localhost:5173"},
        {"text": ":8000", "detail": long},
        {"text": ":9000", "detail": " "},
        {"text": ":9001", "detail": 42},
    ]));
    assert_eq!(
        got,
        Some(json!([
            {"text": ":5173", "detail": "node", "url": "http://localhost:5173/"},
            {"text": ":8000", "detail": kept},
            {"text": ":9000"},
            {"text": ":9001"},
        ]))
    );
}

#[test]
fn chip_items_refuse_a_non_array_an_empty_array_and_too_many_items() {
    let bad = [
        Value::Null,
        json!("text"),
        json!(1),
        json!({"text": "a"}),
        json!([]),
    ];
    for value in bad {
        assert_eq!(chips(&value), None, "{value}");
    }
    let at_max: Vec<Value> = (0..PANE_CHIP_ITEMS_MAX)
        .map(|i| json!({"text": format!("item {i}")}))
        .collect();
    assert_eq!(chips(&json!(at_max)).unwrap().as_array().unwrap().len(), 64);
    let over: Vec<Value> = (0..=PANE_CHIP_ITEMS_MAX)
        .map(|i| json!({"text": format!("item {i}")}))
        .collect();
    assert_eq!(chips(&json!(over)), None);
}

#[test]
fn chip_items_refuse_the_whole_list_for_one_entry_with_no_usable_text() {
    let bad = [
        json!([{"text": "ok"}, Value::Null]),
        json!([{"text": "ok"}, {}]),
        json!([{"text": "ok"}, 5]),
        json!([{"text": "ok"}, "text"]),
        json!([{"text": "ok"}, []]),
        json!([{"text": "ok"}, {"text": ""}]),
        json!([{"text": "ok"}, {"text": "  \t "}]),
        json!([{"text": "ok"}, {"text": 7}]),
        json!([{"text": "ok"}, {"text": Value::Null}]),
        json!([{"text": "ok"}, {"detail": "only detail"}]),
    ];
    for value in bad {
        assert_eq!(chips(&value), None, "{value}");
    }
}

#[test]
fn chip_item_text_is_trimmed_with_the_js_space_set_and_cut_to_the_cap() {
    let long = "y".repeat(PANE_CHIP_ITEM_TEXT_MAX + 20);
    let kept = "y".repeat(PANE_CHIP_ITEM_TEXT_MAX);
    let got = chips(&json!([
        {"text": "  :80  "},
        {"text": "\u{feff}:81\u{a0}"},
        {"text": long},
        {"text": format!("{}{}", " ".repeat(10), "z".repeat(PANE_CHIP_ITEM_TEXT_MAX + 3))},
    ]));
    assert_eq!(
        got,
        Some(json!([
            {"text": ":80"},
            {"text": ":81"},
            {"text": kept},
            {"text": "z".repeat(PANE_CHIP_ITEM_TEXT_MAX)},
        ]))
    );
}

#[test]
fn chip_item_ports_accept_the_whole_port_range_and_a_short_error() {
    let got = chips(&json!([
        {"text": "a", "port": {"remote": 1, "local": 65535}},
        {"text": "b", "port": {"remote": 65535, "error": "in use"}},
        {"text": "c", "port": {"remote": 22, "local": 2222, "error": "e".repeat(64)}},
    ]));
    assert_eq!(
        got,
        Some(json!([
            {"text": "a", "port": {"remote": 1, "local": 65535}},
            {"text": "b", "port": {"remote": 65535, "error": "in use"}},
            {"text": "c", "port": {"remote": 22, "local": 2222, "error": "e".repeat(64)}},
        ]))
    );
}

#[test]
fn chip_item_ports_refuse_every_bad_shape() {
    let ports = [
        json!({"remote": 65536}),
        json!({"remote": -1}),
        json!({"remote": 80.5}),
        json!({"remote": "80"}),
        json!({"remote": Value::Null}),
        json!({}),
        json!({"local": 80}),
        json!({"remote": 80, "local": 0}),
        json!({"remote": 80, "local": 65536}),
        json!({"remote": 80, "local": 1.5}),
        json!({"remote": 80, "local": "80"}),
        json!({"remote": 80, "local": Value::Null}),
        json!({"remote": 80, "error": 5}),
        json!({"remote": 80, "error": Value::Null}),
        json!({"remote": 80, "error": "e".repeat(65)}),
        Value::Null,
        json!("80"),
        json!(80),
        json!(true),
        json!([80]),
        json!([]),
    ];
    for port in ports {
        let list = json!([{"text": "a", "port": port}]);
        assert_eq!(chips(&list), None, "{port}");
    }
}

#[test]
fn chip_item_port_error_limit_counts_utf16_units() {
    let at_limit = json!([{"text": "a", "port": {"remote": 80, "error": "é".repeat(64)}}]);
    assert!(chips(&at_limit).is_some());
    let over = json!([{"text": "a", "port": {"remote": 80, "error": "😀".repeat(33)}}]);
    assert_eq!(chips(&over), None);
}

#[test]
fn chip_item_url_is_normalized_and_a_bad_one_refuses_the_whole_list() {
    assert_eq!(
        chips(&json!([{"text": "a", "url": "HTTP://Localhost:80"}])),
        Some(json!([{"text": "a", "url": "http://localhost/"}]))
    );
    let bad = [
        json!("file:///etc/passwd"),
        json!("javascript:alert(1)"),
        json!(""),
        json!(5),
        Value::Null,
    ];
    for url in bad {
        let list = json!([{"text": "ok"}, {"text": "a", "url": url}]);
        assert_eq!(chips(&list), None, "{url}");
    }
}

#[test]
fn chip_item_keys_come_out_as_text_detail_port_url_and_port_keys_as_remote_local_error() {
    let list = json!([{
        "url": "http://localhost:3000",
        "port": {"error": "busy", "local": 3001, "remote": 3000},
        "detail": "vite",
        "text": ":3000",
    }]);
    assert_eq!(
        chips_text(&list),
        r#"[{"text":":3000","detail":"vite","port":{"remote":3000,"local":3001,"error":"busy"},"url":"http://localhost:3000/"}]"#
    );
}

#[test]
fn chip_items_drop_unknown_fields() {
    assert_eq!(
        chips(&json!([{"text": "a", "extra": 1, "port": {"remote": 80, "other": true}}])),
        Some(json!([{"text": "a", "port": {"remote": 80}}]))
    );
}

#[test]
fn accepts_a_trimmed_command_argument_and_refuses_the_rest() {
    let rows = [
        ("main", Some("main")),
        ("  main  ", Some("main")),
        ("two words", Some("two words")),
        ("line\n", Some("line")),
        ("\r\n x \n", Some("x")),
        ("é ü 日本", Some("é ü 日本")),
        ("\u{feff}x\u{a0}", Some("x")),
        ("\u{85}x", Some("\u{85}x")),
        ("", None),
        ("   ", None),
        ("\n\t", None),
        ("a\tb", None),
        ("a\nb", None),
        ("a\rb", None),
        ("a\u{0}b", None),
        ("a\u{1f}b", None),
        ("a\u{7f}b", None),
    ];
    for (raw, want) in rows {
        assert_eq!(command_argument(&json!(raw)).as_deref(), want, "{raw:?}");
    }
}

#[test]
fn command_argument_refuses_every_non_string() {
    let bad = [
        Value::Null,
        json!(1),
        json!(true),
        json!([]),
        json!(["a"]),
        json!({}),
    ];
    for value in bad {
        assert_eq!(command_argument(&value), None, "{value}");
    }
}

#[test]
fn command_argument_limit_applies_after_trim_and_counts_utf16_units() {
    let at_limit = "a".repeat(COMMAND_ARGUMENT_MAX);
    assert_eq!(
        command_argument(&json!(at_limit)).as_deref(),
        Some(at_limit.as_str())
    );
    assert_eq!(
        command_argument(&json!(format!("  {at_limit}  "))).as_deref(),
        Some(at_limit.as_str())
    );
    assert_eq!(
        command_argument(&json!("a".repeat(COMMAND_ARGUMENT_MAX + 1))),
        None
    );
    assert_eq!(command_argument(&json!("😀".repeat(501))), None);
    assert!(command_argument(&json!("😀".repeat(500))).is_some());
}

#[test]
fn accepts_an_absolute_panel_path_and_refuses_the_rest() {
    let good = [
        "/",
        "/index.html",
        "/a/b/c.html?x=1#y",
        "/é",
        "/日本",
        "/a%20b",
        "/a/../b",
        "/😀",
    ];
    for raw in good {
        assert_eq!(panel_path(&json!(raw)).as_deref(), Some(raw), "{raw:?}");
    }
    let bad = [
        "",
        "a",
        "index.html",
        "./a",
        "//host/a",
        "//",
        "/a b",
        "/a\tb",
        "/a\nb",
        "/a\u{0}b",
        "/a\u{1f}b",
        "/a\u{7f}b",
        "/a\\b",
        "\\a",
        "http://x/",
    ];
    for raw in bad {
        assert_eq!(panel_path(&json!(raw)), None, "{raw:?}");
    }
}

#[test]
fn panel_path_refuses_every_non_string() {
    let bad = [Value::Null, json!(1), json!(true), json!([]), json!({})];
    for value in bad {
        assert_eq!(panel_path(&value), None, "{value}");
    }
}

#[test]
fn panel_path_limit_is_2048_units() {
    let at_limit = format!("/{}", "a".repeat(PANEL_PATH_MAX - 1));
    assert_eq!(panel_path(&json!(at_limit.clone())), Some(at_limit));
    let over = format!("/{}", "a".repeat(PANEL_PATH_MAX));
    assert_eq!(panel_path(&json!(over)), None);
    let emoji = format!("/{}", "😀".repeat(1024));
    assert_eq!(panel_path(&json!(emoji)), None);
    let emoji_ok = format!("/{}", "😀".repeat(1023));
    assert!(panel_path(&json!(emoji_ok)).is_some());
}

#[test]
fn a_string_setting_takes_text_up_to_the_cap_in_utf16_units() {
    let s = setting(json!({"key": "k", "type": "string", "default": "d", "description": "x"}));
    assert!(valid_setting_value(&s, &json!("")));
    assert!(valid_setting_value(
        &s,
        &json!("a".repeat(EXTENSION_SETTING_STRING_MAX))
    ));
    assert!(!valid_setting_value(
        &s,
        &json!("a".repeat(EXTENSION_SETTING_STRING_MAX + 1))
    ));
    assert!(valid_setting_value(&s, &json!("😀".repeat(500))));
    assert!(!valid_setting_value(&s, &json!("😀".repeat(501))));
    let bad = [json!(1), json!(true), Value::Null, json!([]), json!({})];
    for value in bad {
        assert!(!valid_setting_value(&s, &value), "{value}");
    }
}

#[test]
fn a_number_setting_takes_finite_numbers_inside_its_minimum_and_maximum() {
    let bounded = setting(json!({
        "key": "k", "type": "number", "default": 5, "description": "x",
        "minimum": 1, "maximum": 10
    }));
    for value in [json!(1), json!(5), json!(10), json!(2.5)] {
        assert!(valid_setting_value(&bounded, &value), "{value}");
    }
    for value in [json!(0), json!(0.99), json!(10.01), json!(-3)] {
        assert!(!valid_setting_value(&bounded, &value), "{value}");
    }
    let lower = setting(json!({
        "key": "k", "type": "number", "default": 5, "description": "x", "minimum": 0
    }));
    assert!(valid_setting_value(&lower, &json!(1e300)));
    assert!(!valid_setting_value(&lower, &json!(-1)));
    let upper = setting(json!({
        "key": "k", "type": "number", "default": 5, "description": "x", "maximum": 0
    }));
    assert!(valid_setting_value(&upper, &json!(-1e300)));
    assert!(!valid_setting_value(&upper, &json!(1)));
    let open = setting(json!({"key": "k", "type": "number", "default": 5, "description": "x"}));
    assert!(valid_setting_value(&open, &json!(-1e300)));
    assert!(valid_setting_value(&open, &json!(0)));
}

#[test]
fn a_number_setting_refuses_text_booleans_null_and_containers() {
    let s = setting(json!({"key": "k", "type": "number", "default": 5, "description": "x"}));
    let bad = [
        json!("5"),
        json!(""),
        json!(true),
        Value::Null,
        json!([5]),
        json!({"v": 5}),
    ];
    for value in bad {
        assert!(!valid_setting_value(&s, &value), "{value}");
    }
}

#[test]
fn a_boolean_setting_takes_only_booleans() {
    let s = setting(json!({"key": "k", "type": "boolean", "default": false, "description": "x"}));
    assert!(valid_setting_value(&s, &json!(true)));
    assert!(valid_setting_value(&s, &json!(false)));
    let bad = [
        json!(0),
        json!(1),
        json!("true"),
        json!(""),
        Value::Null,
        json!([]),
    ];
    for value in bad {
        assert!(!valid_setting_value(&s, &value), "{value}");
    }
}

#[test]
fn an_enum_setting_takes_only_a_listed_string() {
    let s = setting(json!({
        "key": "k", "type": "enum", "default": "a", "description": "x", "values": ["a", "b"]
    }));
    assert!(valid_setting_value(&s, &json!("a")));
    assert!(valid_setting_value(&s, &json!("b")));
    let bad = [
        json!("c"),
        json!("A"),
        json!("a "),
        json!(""),
        json!(1),
        json!(true),
        Value::Null,
        json!(["a"]),
    ];
    for value in bad {
        assert!(!valid_setting_value(&s, &value), "{value}");
    }
}

#[test]
fn an_enum_setting_with_no_values_refuses_every_value() {
    let s = setting(json!({"key": "k", "type": "enum", "default": "a", "description": "x"}));
    for value in [json!("a"), json!(""), json!(1), Value::Null] {
        assert!(!valid_setting_value(&s, &value), "{value}");
    }
    let empty = setting(json!({
        "key": "k", "type": "enum", "default": "a", "description": "x", "values": []
    }));
    assert!(!valid_setting_value(&empty, &json!("a")));
}

#[test]
fn effective_values_use_a_valid_stored_value_and_the_default_for_the_rest() {
    let settings = [
        json!({"key": "name", "type": "string", "default": "d", "description": "x"}),
        json!({"key": "count", "type": "number", "default": 3, "description": "x", "minimum": 1, "maximum": 9}),
        json!({"key": "on", "type": "boolean", "default": true, "description": "x"}),
        json!({"key": "mode", "type": "enum", "default": "a", "description": "x", "values": ["a", "b"]}),
        json!({"key": "gone", "type": "string", "default": "g", "description": "x"}),
    ];
    let stored = json!({
        "name": "mine",
        "count": 20,
        "on": false,
        "mode": "z",
        "unlisted": "dropped"
    });
    assert_eq!(
        effective(&settings, &stored),
        json!({"name": "mine", "count": 3, "on": false, "mode": "a", "gone": "g"})
    );
}

#[test]
fn effective_values_use_every_default_when_the_stored_value_is_not_an_object() {
    let settings = [
        json!({"key": "a", "type": "string", "default": "x", "description": "x"}),
        json!({"key": "b", "type": "number", "default": 2, "description": "x"}),
    ];
    let want = json!({"a": "x", "b": 2});
    let bad = [
        Value::Null,
        json!([]),
        json!([{"a": "y"}]),
        json!("a"),
        json!(1),
        json!(true),
    ];
    for stored in bad {
        assert_eq!(effective(&settings, &stored), want, "{stored}");
    }
    assert_eq!(effective(&settings, &json!({})), want);
}

#[test]
fn effective_values_for_no_settings_is_an_empty_object() {
    assert_eq!(effective(&[], &json!({"a": 1})), json!({}));
    assert_eq!(effective(&[], &Value::Null), json!({}));
}

#[test]
fn effective_values_keep_the_order_of_the_settings_and_a_later_duplicate_key_wins() {
    let settings = [
        json!({"key": "z", "type": "boolean", "default": false, "description": "x"}),
        json!({"key": "a", "type": "boolean", "default": false, "description": "x"}),
        json!({"key": "m", "type": "boolean", "default": false, "description": "x"}),
    ];
    let got = {
        let parsed: Vec<ExtensionSettingContribution> =
            settings.iter().cloned().map(setting).collect();
        serde_json::to_string(&effective_setting_values(&parsed, &json!({"a": true}))).unwrap()
    };
    assert_eq!(got, r#"{"z":false,"a":true,"m":false}"#);
    let twice = [
        json!({"key": "k", "type": "string", "default": "first", "description": "x"}),
        json!({"key": "k", "type": "number", "default": 2, "description": "x"}),
    ];
    assert_eq!(effective(&twice, &json!({})), json!({"k": 2}));
    assert_eq!(effective(&twice, &json!({"k": "text"})), json!({"k": 2}));
    assert_eq!(effective(&twice, &json!({"k": 7})), json!({"k": 7}));
}

#[test]
fn effective_values_read_only_own_keys_whatever_their_names() {
    let settings = [
        json!({"key": "toString", "type": "string", "default": "d", "description": "x"}),
        json!({"key": "__proto__", "type": "string", "default": "p", "description": "x"}),
        json!({"key": "constructor", "type": "string", "default": "c", "description": "x"}),
    ];
    assert_eq!(
        effective(&settings, &json!({})),
        json!({"toString": "d", "__proto__": "p", "constructor": "c"})
    );
}

#[test]
fn effective_values_keep_a_stored_number_with_a_fraction_and_a_stored_integer_as_written() {
    let settings = [
        json!({"key": "ratio", "type": "number", "default": 1, "description": "x"}),
        json!({"key": "n", "type": "number", "default": 1, "description": "x"}),
    ];
    let got = {
        let parsed: Vec<ExtensionSettingContribution> =
            settings.iter().cloned().map(setting).collect();
        serde_json::to_string(&effective_setting_values(
            &parsed,
            &json!({"ratio": 0.5, "n": 5}),
        ))
        .unwrap()
    };
    assert_eq!(got, r#"{"ratio":0.5,"n":5}"#);
}

#[test]
fn the_badge_pattern_takes_one_to_six_ascii_letters_or_digits() {
    for good in ["a", "Z", "0", "abc123", "ABCDEF", "123456"] {
        assert!(SIDEBAR_BADGE_PATTERN.is_match(good), "{good}");
    }
    for bad in [
        "", "abcdefg", "a b", "a-b", "é", "日", "a\n", "\na", "a_b", " a", "a ", "٣",
    ] {
        assert!(!SIDEBAR_BADGE_PATTERN.is_match(bad), "{bad:?}");
    }
}

#[test]
fn the_verb_pattern_takes_two_to_twenty_lowercase_letters_digits_and_dashes() {
    for good in [
        "ab",
        "a1",
        "a-",
        "go",
        "open-in-ide",
        "a1234567890123456789",
    ] {
        assert!(EXTENSION_VERB_PATTERN.is_match(good), "{good}");
    }
    for bad in [
        "",
        "a",
        "A1",
        "1a",
        "-a",
        "aB",
        "a_b",
        "a b",
        "a123456789012345678901",
        "é1",
        "ab\n",
        "\nab",
    ] {
        assert!(!EXTENSION_VERB_PATTERN.is_match(bad), "{bad:?}");
    }
}

#[test]
fn the_limits_have_the_values_the_contract_states() {
    assert_eq!(SIDEBAR_URL_MAX, 2048);
    assert_eq!(PANE_CHIP_ITEMS_MAX, 64);
    assert_eq!(PANE_CHIP_ITEM_TEXT_MAX, 80);
    assert_eq!(COMMAND_ARGUMENT_MAX, 1000);
    assert_eq!(PANEL_PATH_MAX, 2048);
    assert_eq!(EXTENSION_SETTING_STRING_MAX, 1000);
    assert_eq!(INBOX_ITEMS_MAX, 50);
    assert_eq!(INBOX_TEXT_MAX, 500);
    assert_eq!(EXEC_TIMEOUT_MAX_MS, 600_000);
    assert_eq!(EXEC_OUTPUT_DEFAULT, 64 * 1024);
    assert_eq!(EXEC_OUTPUT_MAX, 1024 * 1024);
    assert_eq!(EXEC_ENV_MAX, 16);
    assert_eq!(EXEC_ENV_VALUE_MAX, 4096);
}

#[test]
fn icons_tones_and_kinds_use_the_wire_names() {
    let icons = [
        (ExtensionIcon::Puzzle, "puzzle"),
        (ExtensionIcon::Kanban, "kanban"),
        (ExtensionIcon::BookOpen, "book-open"),
        (ExtensionIcon::GitBranch, "git-branch"),
        (ExtensionIcon::Globe, "globe"),
        (ExtensionIcon::Bell, "bell"),
        (ExtensionIcon::Server, "server"),
        (ExtensionIcon::Terminal, "terminal"),
        (ExtensionIcon::Circle, "circle"),
        (ExtensionIcon::Check, "check"),
        (ExtensionIcon::Alert, "alert"),
        (ExtensionIcon::Shield, "shield"),
        (ExtensionIcon::Chat, "chat"),
        (ExtensionIcon::Plugs, "plugs"),
        (ExtensionIcon::MagnifyingGlass, "magnifying-glass"),
        (ExtensionIcon::Graph, "graph"),
        (ExtensionIcon::Toolbox, "toolbox"),
        (ExtensionIcon::Plus, "plus"),
        (ExtensionIcon::Refresh, "refresh"),
    ];
    for (icon, name) in icons {
        assert_eq!(serde_json::to_value(icon).unwrap(), json!(name));
        assert_eq!(
            serde_json::from_value::<ExtensionIcon>(json!(name)).unwrap(),
            icon
        );
    }
    assert!(serde_json::from_value::<ExtensionIcon>(json!("star")).is_err());
    let tones = [
        (SidebarTone::Neutral, "neutral"),
        (SidebarTone::Brand, "brand"),
        (SidebarTone::Ok, "ok"),
        (SidebarTone::Warn, "warn"),
        (SidebarTone::Error, "error"),
    ];
    for (tone, name) in tones {
        assert_eq!(serde_json::to_value(tone).unwrap(), json!(name));
    }
    assert!(serde_json::from_value::<SidebarTone>(json!("info")).is_err());
    assert_eq!(
        serde_json::to_value(SidebarKind::Location).unwrap(),
        json!("location")
    );
    assert_eq!(
        serde_json::to_value(SidebarKind::Live).unwrap(),
        json!("live")
    );
    assert!(serde_json::from_value::<SidebarKind>(json!("other")).is_err());
}
