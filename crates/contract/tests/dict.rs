#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::PRODUCT_DISPLAY_NAME;
use ostia_contract::dict::{
    Dict, en, fmt, merge_catalog, with_default_product_name, with_product_name, zh_hant,
};
use serde_json::{Value, json};

const IDENTIFIERS: [&str; 7] = [
    "the ostia command",
    "ostia settings set",
    "ostia view schema",
    "ostia <agent>",
    "ostia <name>",
    "ostia <名稱>",
    "ostia 指令",
];

fn entries(strings: &Value, path: &str) -> Vec<(String, String)> {
    let Some(object) = strings.as_object() else {
        return Vec::new();
    };
    object
        .iter()
        .flat_map(|(key, value)| {
            let at = if path.is_empty() {
                key.clone()
            } else {
                format!("{path}.{key}")
            };
            match value.as_str() {
                Some(text) => vec![(at, text.to_owned())],
                None => entries(value, &at),
            }
        })
        .collect()
}

fn without_identifiers(text: &str) -> String {
    IDENTIFIERS
        .iter()
        .fold(text.to_owned(), |rest, identifier| {
            rest.replace(identifier, "")
        })
}

fn fixture(name: &str) -> Value {
    let text = match name {
        "dict-en.json" => include_str!("../../../test/fixtures/rust/dict-en.json"),
        "dict-zh-hant.json" => include_str!("../../../test/fixtures/rust/dict-zh-hant.json"),
        "dict-en-merged.json" => include_str!("../../../test/fixtures/rust/dict-en-merged.json"),
        "dict-zh-hant-merged.json" => {
            include_str!("../../../test/fixtures/rust/dict-zh-hant-merged.json")
        }
        other => panic!("no fixture {other}"),
    };
    serde_json::from_str(text).unwrap()
}

fn merged(catalog: &Value) -> Dict {
    merge_catalog(catalog)
}

fn text<'a>(dict: &'a Dict, pointer: &str) -> &'a str {
    dict.pointer(pointer).and_then(Value::as_str).unwrap()
}

#[test]
fn replaces_every_product_placeholder() {
    assert_eq!(
        with_product_name("While {product} is focused, {product} polls", "Ostia"),
        "While Ostia is focused, Ostia polls"
    );
}

#[test]
fn uses_the_product_name_by_default_and_leaves_other_text_alone() {
    assert_eq!(with_default_product_name("{product}"), PRODUCT_DISPLAY_NAME);
    assert_eq!(
        with_default_product_name("No braces {here}"),
        "No braces {here}"
    );
}

#[test]
fn never_spells_the_product_name_it_writes_the_placeholder() {
    for (name, catalog) in [("en", en()), ("zhHant", zh_hant())] {
        let hardcoded: Vec<String> = entries(catalog, "")
            .into_iter()
            .filter(|(_, text)| {
                let rest = without_identifiers(text).to_lowercase();
                rest.contains("pine") || rest.contains("ostia")
            })
            .map(|(path, text)| format!("{path}: {text}"))
            .collect();
        assert_eq!(hardcoded, Vec::<String>::new(), "{name}");
    }
}

#[test]
fn still_names_the_cli_where_a_string_tells_the_human_what_to_type() {
    let all: Vec<(String, String)> = [en(), zh_hant()]
        .into_iter()
        .flat_map(|catalog| entries(catalog, ""))
        .collect();
    let used: Vec<&str> = IDENTIFIERS
        .into_iter()
        .filter(|identifier| all.iter().any(|(_, text)| text.contains(identifier)))
        .collect();
    assert_eq!(used, IDENTIFIERS);
}

#[test]
fn builds_the_english_and_traditional_chinese_catalogues_the_ts_dictionary_holds() {
    for (name, built, fixture_name) in [
        ("en", en(), "dict-en.json"),
        ("zhHant", zh_hant(), "dict-zh-hant.json"),
    ] {
        assert_eq!(built, &fixture(fixture_name), "{name}");
        assert_eq!(
            serde_json::to_string(built).unwrap(),
            serde_json::to_string(&fixture(fixture_name)).unwrap(),
            "{name} key order"
        );
    }
}

#[test]
fn gives_the_traditional_chinese_catalogue_the_keys_of_the_english_one() {
    let paths = |catalog: &Dict| -> Vec<String> {
        entries(catalog, "")
            .into_iter()
            .map(|(path, _)| path)
            .collect()
    };
    assert_eq!(paths(en()), paths(zh_hant()));
}

#[test]
fn fills_a_placeholder_from_a_string_or_a_number() {
    assert_eq!(
        fmt(
            "{name} has {count} files",
            &json!({ "name": "src", "count": 3 })
        ),
        "src has 3 files"
    );
    assert_eq!(fmt("{ratio}", &json!({ "ratio": 1.5 })), "1.5");
    assert_eq!(fmt("{n}", &json!({ "n": 0 })), "0");
    assert_eq!(fmt("{s}", &json!({ "s": "" })), "");
}

#[test]
fn fills_a_repeated_placeholder_each_time() {
    assert_eq!(fmt("{a}-{a}-{b}", &json!({ "a": "x", "b": "y" })), "x-x-y");
}

#[test]
fn keeps_a_placeholder_that_has_no_value() {
    assert_eq!(fmt("{a} and {b}", &json!({ "a": "x" })), "x and {b}");
    assert_eq!(fmt("{a}", &json!({})), "{a}");
}

#[test]
fn reads_a_placeholder_name_as_ascii_word_characters_only() {
    assert_eq!(
        fmt(
            "{é} {a-b} {a b} {} {a_1}",
            &json!({ "é": "1", "a-b": "2", "a b": "3", "": "4", "a_1": "5" })
        ),
        "{é} {a-b} {a b} {} 5"
    );
}

#[test]
fn merges_an_empty_catalogue_into_english_with_the_product_name_filled_in() {
    let dict = merged(&json!({}));
    assert_eq!(dict, fixture("dict-en-merged.json"));
    assert_eq!(
        serde_json::to_string(&dict).unwrap(),
        serde_json::to_string(&fixture("dict-en-merged.json")).unwrap()
    );
    assert!(
        entries(&dict, "")
            .iter()
            .all(|(_, text)| !text.contains("{product}"))
    );
}

#[test]
fn merges_the_traditional_chinese_catalogue_into_the_same_shape_as_the_ts_merge() {
    let dict = merged(zh_hant());
    assert_eq!(dict, fixture("dict-zh-hant-merged.json"));
    assert_eq!(
        serde_json::to_string(&dict).unwrap(),
        serde_json::to_string(&fixture("dict-zh-hant-merged.json")).unwrap()
    );
}

#[test]
fn replaces_a_string_with_the_translation_and_fills_in_the_product_name_there() {
    let dict = merged(&json!({ "native": { "tray": { "show": "Zeige {product}" } } }));
    assert_eq!(
        text(&dict, "/native/tray/show"),
        format!("Zeige {PRODUCT_DISPLAY_NAME}")
    );
    assert_eq!(
        text(&dict, "/native/tray/quit"),
        text(&merged(&json!({})), "/native/tray/quit")
    );
}

#[test]
fn keeps_every_string_the_catalogue_leaves_out() {
    let dict = merged(&json!({ "native": { "tray": { "show": "Afficher" } } }));
    let english = merged(&json!({}));
    assert_eq!(text(&dict, "/native/tray/show"), "Afficher");
    assert_eq!(
        dict.pointer("/native/quit"),
        english.pointer("/native/quit")
    );
    assert_eq!(dict.pointer("/rail"), english.pointer("/rail"));
}

#[test]
fn ignores_a_catalogue_key_that_english_does_not_have() {
    let dict = merged(&json!({ "extra": "x", "native": { "tray": { "extra": "y" } } }));
    assert_eq!(dict, merged(&json!({})));
}

#[test]
fn keeps_english_where_the_catalogue_has_the_wrong_kind_of_value() {
    let english = merged(&json!({}));
    let dict = merged(&json!({
        "native": { "tray": "flat", "quit": null, "updateTitle": { "a": "b" } },
        "rail": 5,
        "formats": { "unknownDate": ["x"] }
    }));
    assert_eq!(dict, english);
}

#[test]
fn reads_a_catalogue_that_is_not_an_object_as_empty() {
    let english = merged(&json!({}));
    for catalog in [json!(null), json!("x"), json!(3), json!([1])] {
        assert_eq!(merged(&catalog), english, "{catalog}");
    }
}
