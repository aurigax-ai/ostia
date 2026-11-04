#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::extension_locales::{
    EXTENSION_BASE_LOCALE, EXTENSION_LOCALES_DIR, EXTENSION_MESSAGE_MAX, EXTENSION_MESSAGES_MAX,
    LocaleStrings, extension_locale_file, format_message, localized, match_locale, parse_messages,
    translator_for,
};
use serde_json::{Map, Value, json};

fn vars(value: Value) -> Map<String, Value> {
    value.as_object().unwrap().clone()
}

fn no_vars() -> Map<String, Value> {
    Map::new()
}

fn strings(pairs: &[(&str, &str)]) -> LocaleStrings {
    pairs
        .iter()
        .map(|(key, text)| ((*key).to_owned(), (*text).to_owned()))
        .collect()
}

fn messages_of(raw: &Value) -> LocaleStrings {
    parse_messages(Some(raw)).messages
}

#[test]
fn picks_the_exact_tag_whatever_its_case() {
    assert_eq!(
        match_locale(Some("zh-hant"), &["fr", "zh-Hant"]),
        Some("zh-Hant")
    );
}

#[test]
fn drops_trailing_subtags_until_a_catalog_matches() {
    assert_eq!(
        match_locale(Some("zh-Hant-TW"), &["zh", "zh-Hant"]),
        Some("zh-Hant")
    );
    assert_eq!(match_locale(Some("pt-BR"), &["pt"]), Some("pt"));
}

#[test]
fn falls_back_to_the_first_catalog_of_the_same_language() {
    assert_eq!(
        match_locale(Some("zh-TW"), &["fr", "zh-Hant", "zh-Hans"]),
        Some("zh-Hant")
    );
}

#[test]
fn matches_nothing_for_another_language_or_no_locale() {
    assert_eq!(match_locale(Some("en"), &["zh-Hant"]), None);
    assert_eq!(match_locale(None, &["zh-Hant"]), None);
}

#[test]
fn matches_nothing_for_an_empty_locale_or_an_empty_list() {
    assert_eq!(match_locale(Some(""), &["en"]), None);
    assert_eq!(match_locale(Some("en"), &[]), None);
}

#[test]
fn prefers_the_longest_matching_tag_over_the_same_language() {
    assert_eq!(
        match_locale(Some("zh-Hant-TW"), &["zh-Hans", "zh", "zh-Hant-TW"]),
        Some("zh-Hant-TW")
    );
}

#[test]
fn returns_the_matching_catalog_and_english_otherwise() {
    let catalogs = [("en", "hello"), ("zh-Hant", "你好")];
    assert_eq!(localized(&catalogs, Some("zh-Hant")), Some(&"你好"));
    assert_eq!(localized(&catalogs, Some("fr")), Some(&"hello"));
    assert_eq!(localized(&catalogs, None), Some(&"hello"));
}

#[test]
fn fills_named_placeholders_and_leaves_unknown_ones_as_written() {
    assert_eq!(
        format_message(
            "{count} of {total} {unit}",
            &vars(json!({"count": 2, "total": 5}))
        ),
        "2 of 5 {unit}"
    );
}

#[test]
fn never_reads_a_placeholder_from_the_prototype() {
    assert_eq!(
        format_message("{constructor} {toString}", &no_vars()),
        "{constructor} {toString}"
    );
}

#[test]
fn writes_a_string_variable_as_it_is_and_every_repeat_of_a_placeholder() {
    assert_eq!(
        format_message("{name}, {name}!", &vars(json!({"name": "Ada"}))),
        "Ada, Ada!"
    );
    assert_eq!(
        format_message("no placeholder", &no_vars()),
        "no placeholder"
    );
    assert_eq!(
        format_message("{a-b} {}", &vars(json!({"a-b": "x"}))),
        "{a-b} {}"
    );
}

#[test]
fn keeps_strings_and_reports_everything_else() {
    let raw: Value = serde_json::from_str(
        r#"{"hello":"Hello","count":3,"nested":{"a":"b"},"__proto__":"x","constructor":"y","":"z"}"#,
    )
    .unwrap();
    let result = parse_messages(Some(&raw));
    assert_eq!(result.messages, strings(&[("hello", "Hello")]));
    assert_eq!(
        result.problems,
        [
            "messages.count: must be a string",
            "messages.nested: must be a string",
            "messages.__proto__: not a usable key",
            "messages.constructor: not a usable key",
            "messages.: not a usable key",
        ]
    );
}

#[test]
fn refuses_a_string_past_the_length_cap_and_anything_past_the_count_cap() {
    let long = parse_messages(Some(&json!({"a": "x".repeat(EXTENSION_MESSAGE_MAX + 1)})));
    assert!(long.messages.is_empty());
    assert_eq!(
        long.problems,
        [format!(
            "messages.a: longer than {EXTENSION_MESSAGE_MAX} characters"
        )]
    );
    let mut many = Map::new();
    for index in 0..EXTENSION_MESSAGES_MAX + 5 {
        many.insert(format!("k{index}"), json!("v"));
    }
    let result = parse_messages(Some(&Value::Object(many)));
    assert_eq!(result.messages.len(), EXTENSION_MESSAGES_MAX);
    assert!(result.messages.contains_key("k0"));
    assert!(
        result
            .messages
            .contains_key(&format!("k{}", EXTENSION_MESSAGES_MAX - 1))
    );
    assert!(
        !result
            .messages
            .contains_key(&format!("k{EXTENSION_MESSAGES_MAX}"))
    );
    assert_eq!(
        result.problems,
        [format!(
            "messages holds more than {EXTENSION_MESSAGES_MAX} strings"
        )]
    );
}

#[test]
fn treats_a_missing_section_as_empty_and_a_non_object_as_a_problem() {
    assert!(parse_messages(None).problems.is_empty());
    assert!(parse_messages(None).messages.is_empty());
    let result = parse_messages(Some(&json!(["a"])));
    assert_eq!(result.problems, ["messages must be an object of strings"]);
    assert!(result.messages.is_empty());
}

#[test]
fn keeps_a_message_at_the_length_cap_and_counts_it_in_utf16_units() {
    let at_cap = "x".repeat(EXTENSION_MESSAGE_MAX);
    let result = parse_messages(Some(&json!({"a": at_cap})));
    assert!(result.problems.is_empty());
    assert_eq!(result.messages.len(), 1);
    let emoji = "😀".repeat(EXTENSION_MESSAGE_MAX / 2 + 1);
    let over = parse_messages(Some(&json!({"a": emoji})));
    assert_eq!(
        over.problems,
        [format!(
            "messages.a: longer than {EXTENSION_MESSAGE_MAX} characters"
        )]
    );
}

#[test]
fn refuses_a_key_past_the_key_length_cap() {
    let long = "k".repeat(121);
    let mut map = Map::new();
    map.insert(long.clone(), json!("v"));
    map.insert("k".repeat(120), json!("ok"));
    let raw = Value::Object(map);
    let result = parse_messages(Some(&raw));
    assert_eq!(result.messages.len(), 1);
    assert_eq!(
        result.problems,
        [format!("messages.{long}: not a usable key")]
    );
}

#[test]
fn builds_the_path_of_a_locale_file() {
    assert_eq!(EXTENSION_LOCALES_DIR, "locales");
    assert_eq!(extension_locale_file("zh-Hant"), "locales/zh-Hant.json");
    assert_eq!(EXTENSION_BASE_LOCALE, "en");
}

fn catalogs() -> Vec<(&'static str, LocaleStrings)> {
    vec![
        (
            "en",
            strings(&[("greeting", "Hello, {name}"), ("bye", "Goodbye")]),
        ),
        ("zh-Hant", strings(&[("greeting", "你好，{name}")])),
    ]
}

#[test]
fn uses_the_catalog_of_the_locale() {
    let translate = translator_for(&catalogs(), Some("zh-Hant"));
    assert_eq!(
        translate.translate("greeting", &vars(json!({"name": "Ada"}))),
        "你好，Ada"
    );
}

#[test]
fn falls_back_per_message_to_english_then_to_the_key() {
    let translate = translator_for(&catalogs(), Some("zh-Hant"));
    assert_eq!(translate.translate("bye", &no_vars()), "Goodbye");
    assert_eq!(translate.translate("missing", &no_vars()), "missing");
}

#[test]
fn uses_english_for_a_locale_with_no_catalog() {
    assert_eq!(
        translator_for(&catalogs(), Some("fr"))
            .translate("greeting", &vars(json!({"name": "Ada"}))),
        "Hello, Ada"
    );
    assert_eq!(
        translator_for(&catalogs(), None).translate("bye", &no_vars()),
        "Goodbye"
    );
}

#[test]
fn never_resolves_a_key_from_the_prototype() {
    assert_eq!(
        translator_for(&catalogs(), Some("en")).translate("toString", &no_vars()),
        "toString"
    );
}

#[test]
fn falls_back_to_the_key_when_there_is_no_english_catalog() {
    let only_chinese = vec![("zh-Hant", strings(&[("greeting", "你好")]))];
    let translate = translator_for(&only_chinese, Some("fr"));
    assert_eq!(translate.translate("greeting", &no_vars()), "greeting");
    assert_eq!(
        translator_for(&only_chinese, Some("zh-Hant")).translate("greeting", &no_vars()),
        "你好"
    );
}

#[test]
fn formats_the_variables_into_the_message_that_it_finds() {
    let translate = translator_for(&catalogs(), Some("en"));
    assert_eq!(
        translate.translate("greeting", &vars(json!({"name": 7}))),
        "Hello, 7"
    );
    assert_eq!(translate.translate("greeting", &no_vars()), "Hello, {name}");
}

#[test]
fn reads_the_messages_that_parse_messages_keeps() {
    let kept = messages_of(&json!({"greeting": "Hi {name}", "bad": 1}));
    let translate = translator_for(&[("en", kept)], Some("en"));
    assert_eq!(
        translate.translate("greeting", &vars(json!({"name": "Bo"}))),
        "Hi Bo"
    );
    assert_eq!(translate.translate("bad", &no_vars()), "bad");
}
