#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::json_located::parse_located_json;

#[test]
fn keeps_a_whole_number_a_whole_number() {
    let parsed = parse_located_json(r#"{"a":5,"b":-3,"c":5.0,"d":1e2,"e":0,"f":-0}"#).unwrap();
    assert_eq!(
        parsed.value.to_string(),
        r#"{"a":5,"b":-3,"c":5,"d":100,"e":0,"f":0}"#
    );
}

#[test]
fn keeps_a_fraction_a_fraction() {
    let parsed = parse_located_json(r#"{"a":0.5,"b":-2.25}"#).unwrap();
    assert_eq!(parsed.value.to_string(), r#"{"a":0.5,"b":-2.25}"#);
}

use ostia_contract::json_located::{JsonSyntaxError, LocatedJson};
use serde_json::{Value, json};

fn accepted(text: &str) -> LocatedJson {
    parse_located_json(text).unwrap_or_else(|err| panic!("refused: {}", err.message))
}

fn refused(text: &str) -> JsonSyntaxError {
    match parse_located_json(text) {
        Err(err) => err,
        Ok(_) => panic!("expected a refusal"),
    }
}

fn error(message: &str, line: usize, column: usize) -> JsonSyntaxError {
    JsonSyntaxError {
        message: message.to_owned(),
        line,
        column,
    }
}

fn nested_arrays(depth: usize) -> String {
    format!("{}{}", "[".repeat(depth), "]".repeat(depth))
}

fn nested_objects(depth: usize) -> String {
    format!("{}1{}", "{\"a\":".repeat(depth), "}".repeat(depth))
}

#[test]
fn refuses_a_duplicate_property_at_every_depth_and_points_at_the_second_key() {
    assert_eq!(
        refused(r#"{"a":1,"a":2}"#),
        error("duplicate property 'a'", 1, 8)
    );
    assert_eq!(
        refused(r#"{"x":{"a":1,"a":2}}"#).message,
        "duplicate property 'a'"
    );
    assert_eq!(
        refused(r#"[{"a":1,"a":2}]"#).message,
        "duplicate property 'a'"
    );
    let err = refused("{\n  \"a\": 1,\n  \"b\": 2,\n  \"a\": 3\n}");
    assert_eq!((err.line, err.column), (4, 3));
}

#[test]
fn refuses_a_duplicate_that_differs_only_by_escape() {
    assert_eq!(
        refused(r#"{"x":{"a":1,"\u0061":2}}"#).message,
        "duplicate property 'a'"
    );
}

#[test]
fn refuses_a_raw_control_character_in_a_string_and_points_at_it() {
    assert_eq!(
        refused("{\"a\":\"x\ty\"}"),
        error("control character in string", 1, 8)
    );
    assert_eq!(
        refused("{\"a\":\"x\u{0}y\"}").message,
        "control character in string"
    );
    assert_eq!(refused("{\"a\":\"\\\\\",\"b\":\"x\ty\"}").column, 17);
    assert_eq!(refused("{\"a\":\"\\\"\tz\"}").column, 9);
}

#[test]
fn accepts_escaped_control_characters_and_whitespace_between_tokens() {
    assert_eq!(
        accepted(r#"{"a":"x\u0000y"}"#).value,
        json!({"a": "x\u{0}y"})
    );
    assert_eq!(
        accepted("{\t\"a\":\t\"\\\\\"\r\n}").value,
        json!({"a": "\\"})
    );
}

#[test]
fn accepts_nesting_up_to_the_limit_and_refuses_one_level_more() {
    assert!(parse_located_json(&nested_arrays(65)).is_ok());
    assert_eq!(refused(&nested_arrays(66)).message, "nested too deeply");
    assert!(parse_located_json(&nested_objects(64)).is_ok());
    assert_eq!(refused(&nested_objects(65)).message, "nested too deeply");
}

#[test]
fn refuses_very_deep_input_without_overflowing_the_stack() {
    assert_eq!(refused(&"[".repeat(100_000)).message, "nested too deeply");
    assert_eq!(
        refused(&nested_objects(100_000)).message,
        "nested too deeply"
    );
}

#[test]
fn keeps_prototype_keys_as_plain_own_properties() {
    let text =
        r#"{"__proto__":{"polluted":true},"constructor":{"prototype":1},"x":{"__proto__":2}}"#;
    let value = accepted(text).value;
    let Value::Object(map) = &value else {
        panic!("not an object");
    };
    assert_eq!(
        map.keys().collect::<Vec<_>>(),
        ["__proto__", "constructor", "x"]
    );
    assert_eq!(value.to_string(), text);
    assert_eq!(
        value["x"].as_object().unwrap().keys().collect::<Vec<_>>(),
        ["__proto__"]
    );
}

#[test]
fn refuses_what_json_parse_refuses() {
    let rows = [
        ("a line comment", "{\"a\":1} // c"),
        ("a block comment", "{/* c */\"a\":1}"),
        ("a trailing comma in an object", "{\"a\":1,}"),
        ("a trailing comma in an array", "[1,2,]"),
        ("single quotes", "{'a':1}"),
        ("an unquoted key", "{a:1}"),
        ("NaN", "[NaN]"),
        ("Infinity", "[-Infinity]"),
        ("a leading zero", "[01]"),
        ("a leading plus", "[+1]"),
        ("a bare fraction", "[.5]"),
        ("a hex number", "[0x10]"),
        ("a byte order mark", "\u{feff}{\"a\":1}"),
        ("an empty input", ""),
        ("a second document", "{\"a\":1}{\"b\":2}"),
        ("a bad escape", "[\"\\x\"]"),
        ("a form feed between tokens", "{\u{c}\"a\":1}"),
    ];
    for (name, text) in rows {
        assert!(parse_located_json(text).is_err(), "{name}");
    }
}

#[test]
fn names_what_is_wrong_and_where() {
    assert_eq!(
        refused("{\n\"a\":1\n}\nxyz"),
        error("unexpected text after the document", 4, 1)
    );
    assert_eq!(
        refused("{\n  \"a\": 1,\n     \"b\": @\n}"),
        error("unexpected '@'", 3, 11)
    );
    assert_eq!(refused("{\"a\":\"abc"), error("unterminated string", 1, 10));
    assert_eq!(refused("{\"a\":1").message, "expected '}' before the end");
    assert_eq!(refused("{a:1}").message, "expected a quoted property name");
}

#[test]
fn parses_numbers_like_json_parse() {
    let text = "[12345678901234567890, 9007199254740993, 1e3, 1E+3, 1e-3, 1.5e300, -0.0, 0e0]";
    let value = accepted(text).value;
    let numbers: Vec<f64> = value
        .as_array()
        .unwrap()
        .iter()
        .map(|number| number.as_f64().unwrap())
        .collect();
    assert_eq!(
        numbers,
        [
            12_345_678_901_234_567_890.0,
            9_007_199_254_740_992.0,
            1000.0,
            1000.0,
            0.001,
            1.5e300,
            0.0,
            0.0
        ]
    );
}

#[test]
fn refuses_a_number_no_double_can_hold() {
    assert_eq!(refused("[1e999]").message, "number out of range");
}

#[test]
fn turns_a_lone_surrogate_into_the_replacement_character_and_keeps_a_pair() {
    assert_eq!(accepted(r#"["\ud800"]"#).value, json!(["\u{fffd}"]));
    assert_eq!(accepted(r#"["\udc00x"]"#).value, json!(["\u{fffd}x"]));
    assert_eq!(accepted(r#"["\ud83d\ude00"]"#).value, json!(["😀"]));
}

#[test]
fn records_the_line_of_every_path_quoting_keys_that_are_not_identifiers() {
    let text = "{\n \"we ird\": {\"a.b\": true,\n \"\": 1},\n \"x\": [1,\n {\"k y\": null}]\n}";
    let mut lines: Vec<(String, usize)> = accepted(text).lines.into_iter().collect();
    lines.sort();
    let mut expected: Vec<(String, usize)> = [
        ("", 1),
        ("[\"we ird\"]", 2),
        ("[\"we ird\"][\"a.b\"]", 2),
        ("[\"we ird\"][\"\"]", 3),
        ("x", 4),
        ("x[0]", 4),
        ("x[1]", 5),
        ("x[1][\"k y\"]", 5),
    ]
    .into_iter()
    .map(|(path, line)| (path.to_owned(), line))
    .collect();
    expected.sort();
    assert_eq!(lines, expected);
}
