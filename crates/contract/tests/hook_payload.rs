#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::hook_payload::{first_question, parse_payload, text};
use serde_json::{Value, json};

#[test]
fn reads_a_json_object_and_gives_an_empty_one_for_anything_else() {
    assert_eq!(
        Value::Object(parse_payload(r#"{"a":1,"b":[2]}"#)),
        json!({ "a": 1, "b": [2] })
    );
    for raw in [
        "[1]", "5", "\"x\"", "null", "true", "", "not json", "{", "{\"a\":",
    ] {
        assert!(parse_payload(raw).is_empty(), "{raw}");
    }
}

#[test]
fn trims_a_string_and_cuts_it_to_three_hundred_units() {
    assert_eq!(text(&json!("  hello \n")), "hello");
    assert_eq!(text(&json!("\u{feff} hi \u{a0}")), "hi");
    assert_eq!(text(&json!("\u{85}x")), "\u{85}x");
    assert_eq!(text(&json!("a".repeat(300))), "a".repeat(300));
    assert_eq!(text(&json!("a".repeat(301))), "a".repeat(300));
    assert_eq!(
        text(&json!(format!("  {}", "b".repeat(400)))),
        "b".repeat(300)
    );
    assert_eq!(
        text(&json!(format!("{} ", "c".repeat(299)))),
        "c".repeat(299)
    );
    assert_eq!(text(&json!("é".repeat(301))), "é".repeat(300));
    assert_eq!(text(&json!("   ")), "");
}

#[test]
fn gives_an_empty_text_for_a_value_that_is_not_a_string() {
    for value in [
        json!(5),
        json!(null),
        json!(true),
        json!(["a"]),
        json!({ "a": "b" }),
    ] {
        assert_eq!(text(&value), "", "{value}");
    }
}

#[test]
fn reads_the_first_question_of_an_ask_input() {
    assert_eq!(
        first_question(
            &json!({ "questions": [{ "question": "  Which one? " }, { "question": "Second" }] })
        ),
        "Which one?"
    );
    assert_eq!(
        first_question(&json!({ "questions": [{ "question": "q".repeat(400) }] })),
        "q".repeat(300)
    );
}

#[test]
fn gives_an_empty_question_when_the_input_has_no_usable_first_question() {
    for input in [
        json!(null),
        json!("text"),
        json!(5),
        json!([]),
        json!({}),
        json!({ "questions": null }),
        json!({ "questions": "x" }),
        json!({ "questions": {} }),
        json!({ "questions": [] }),
        json!({ "questions": [null] }),
        json!({ "questions": ["x"] }),
        json!({ "questions": [{}] }),
        json!({ "questions": [{ "question": 4 }] }),
        json!({ "questions": [{ "question": "  " }, { "question": "second" }] }),
        json!({ "questions": [[{ "question": "nested" }]] }),
    ] {
        assert_eq!(first_question(&input), "", "{input}");
    }
}
