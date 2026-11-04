#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::completion_spec::{
    SPEC_FILE_MAX_BYTES, is_spec_command, parse_completion_spec,
};
use serde_json::{Value, json};

fn parsed(raw: Value) -> Value {
    serde_json::to_value(parse_completion_spec(&raw).unwrap()).unwrap()
}

fn refused(raw: Value) -> &'static str {
    parse_completion_spec(&raw).unwrap_err()
}

#[test]
fn accepts_a_command_name_of_letters_digits_and_a_few_marks() {
    for name in ["git", "g++", "a.b_c-d", "7z", &"a".repeat(64)] {
        assert!(is_spec_command(name), "{name}");
    }
    for name in [
        "",
        "-x",
        ".x",
        "a b",
        "a/b",
        "a;b",
        &"a".repeat(65),
        "git\n",
    ] {
        assert!(!is_spec_command(name), "{name:?}");
    }
}

#[test]
fn caps_a_spec_file_at_four_mebibytes() {
    assert_eq!(SPEC_FILE_MAX_BYTES, 4 * 1024 * 1024);
}

#[test]
fn keeps_a_minimal_command_with_only_its_names() {
    assert_eq!(
        parsed(json!({ "names": ["git"] })),
        json!({ "names": ["git"] })
    );
}

#[test]
fn needs_one_to_twenty_names_that_are_non_empty_strings_of_at_most_200_units() {
    let message = "names must be a non-empty array";
    assert_eq!(refused(json!({})), message);
    assert_eq!(refused(json!({ "names": [] })), message);
    assert_eq!(refused(json!({ "names": "git" })), message);
    let twenty: Vec<String> = (0..20).map(|i| format!("n{i}")).collect();
    assert_eq!(
        parsed(json!({ "names": twenty })),
        json!({ "names": twenty })
    );
    let twenty_one: Vec<String> = (0..21).map(|i| format!("n{i}")).collect();
    assert_eq!(refused(json!({ "names": twenty_one })), message);
    let each = "each name must be a non-empty string";
    assert_eq!(refused(json!({ "names": [""] })), each);
    assert_eq!(refused(json!({ "names": [1] })), each);
    assert_eq!(refused(json!({ "names": ["a", null] })), each);
    assert_eq!(refused(json!({ "names": ["a".repeat(201)] })), each);
    let edge = "a".repeat(200);
    assert_eq!(
        parsed(json!({ "names": [edge] })),
        json!({ "names": [edge] })
    );
}

#[test]
fn refuses_a_command_or_a_part_that_is_not_an_object() {
    assert_eq!(refused(json!(null)), "command must be an object");
    assert_eq!(refused(json!([1])), "command must be an object");
    assert_eq!(
        refused(json!({ "names": ["a"], "subcommands": [3] })),
        "command must be an object"
    );
    assert_eq!(
        refused(json!({ "names": ["a"], "options": [3] })),
        "option must be an object"
    );
    assert_eq!(
        refused(json!({ "names": ["a"], "args": [3] })),
        "arg must be an object"
    );
    assert_eq!(
        refused(json!({ "names": ["a"], "options": [{ "names": ["-x"], "args": ["s"] }] })),
        "arg must be an object"
    );
}

#[test]
fn refuses_a_list_field_that_is_not_an_array() {
    for field in ["subcommands", "options", "args"] {
        assert_eq!(
            refused(json!({ "names": ["a"], field: {} })),
            "expected an array",
            "{field}"
        );
    }
    assert_eq!(
        refused(json!({ "names": ["a"], "args": [{ "suggestions": "x" }] })),
        "expected an array"
    );
}

#[test]
fn drops_empty_lists_and_empty_or_non_string_descriptions() {
    assert_eq!(
        parsed(json!({
            "names": ["a"], "description": "", "subcommands": [], "options": [], "args": []
        })),
        json!({ "names": ["a"] })
    );
    assert_eq!(
        parsed(json!({ "names": ["a"], "description": 5 })),
        json!({ "names": ["a"] })
    );
}

#[test]
fn clips_a_description_to_400_units_and_a_arg_name_to_200() {
    let long = "d".repeat(500);
    let out = parsed(json!({
        "names": ["a"], "description": long, "args": [{ "name": "n".repeat(300), "description": long }]
    }));
    assert_eq!(out["description"], json!("d".repeat(400)));
    assert_eq!(out["args"][0]["name"], json!("n".repeat(200)));
    assert_eq!(out["args"][0]["description"], json!("d".repeat(400)));
}

#[test]
fn keeps_options_with_their_flags_and_args_and_writes_keys_in_the_ts_order() {
    let out = parsed(json!({
        "names": ["git"],
        "description": "vcs",
        "subcommands": [{ "names": ["commit", "ci"], "description": "record" }],
        "options": [{
            "names": ["-m", "--message"],
            "description": "text",
            "args": [{ "name": "msg" }],
            "isPersistent": true,
            "isRepeatable": true
        }],
        "args": [{ "name": "path", "template": ["filepaths", "folders"], "isOptional": true, "isVariadic": true }]
    }));
    let expected = json!({
        "names": ["git"],
        "description": "vcs",
        "subcommands": [{ "names": ["commit", "ci"], "description": "record" }],
        "options": [{
            "names": ["-m", "--message"],
            "description": "text",
            "args": [{ "name": "msg" }],
            "isPersistent": true,
            "isRepeatable": true
        }],
        "args": [{
            "name": "path",
            "template": ["filepaths", "folders"],
            "isOptional": true,
            "isVariadic": true
        }]
    });
    assert_eq!(out.to_string(), expected.to_string());
}

#[test]
fn sets_a_flag_only_for_the_boolean_true() {
    let out = parsed(json!({
        "names": ["a"],
        "options": [{ "names": ["-x"], "isPersistent": "yes", "isRepeatable": 1 }],
        "args": [{ "isOptional": false, "isVariadic": null }]
    }));
    assert_eq!(
        out,
        json!({ "names": ["a"], "options": [{ "names": ["-x"] }], "args": [{}] })
    );
}

#[test]
fn keeps_only_the_known_templates_and_refuses_a_template_that_is_not_a_list() {
    let out = parsed(json!({
        "names": ["a"],
        "args": [{ "template": ["filepaths", "nope", 3, "folders"] }, { "template": ["nope"] }]
    }));
    assert_eq!(out["args"][0]["template"], json!(["filepaths", "folders"]));
    assert_eq!(out["args"][1], json!({}));
    assert_eq!(
        refused(json!({ "names": ["a"], "args": [{ "template": "filepaths" }] })),
        "template must be an array"
    );
}

#[test]
fn needs_a_suggestion_to_have_a_name_of_at_most_200_units() {
    let message = "suggestion needs a name";
    for bad in [
        json!(1),
        json!({}),
        json!({ "name": "" }),
        json!({ "name": 4 }),
    ] {
        assert_eq!(
            refused(json!({ "names": ["a"], "args": [{ "suggestions": [bad] }] })),
            message
        );
    }
    let too_long = json!({ "name": "s".repeat(201) });
    assert_eq!(
        refused(json!({ "names": ["a"], "args": [{ "suggestions": [too_long] }] })),
        message
    );
    let out = parsed(json!({
        "names": ["a"],
        "args": [{ "suggestions": [{ "name": "one", "description": "first" }, { "name": "two", "description": "" }] }]
    }));
    assert_eq!(
        out["args"][0]["suggestions"],
        json!([{ "name": "one", "description": "first" }, { "name": "two" }])
    );
}

#[test]
fn keeps_an_arg_name_only_when_it_is_a_non_empty_string() {
    let out =
        parsed(json!({ "names": ["a"], "args": [{ "name": "" }, { "name": 3 }, { "name": "x" }] }));
    assert_eq!(out["args"], json!([{}, {}, { "name": "x" }]));
}

#[test]
fn allows_twelve_levels_of_subcommands_and_refuses_a_thirteenth() {
    fn nested(levels: usize) -> Value {
        let mut spec = json!({ "names": ["leaf"] });
        for _ in 0..levels {
            spec = json!({ "names": ["node"], "subcommands": [spec] });
        }
        spec
    }
    assert!(parse_completion_spec(&nested(12)).is_ok());
    assert_eq!(refused(nested(13)), "spec is nested too deeply");
}

#[test]
fn refuses_a_spec_with_more_than_20000_items_and_counts_every_nested_item() {
    let options: Vec<Value> = (0..20000).map(|_| json!({ "names": ["-x"] })).collect();
    assert!(parse_completion_spec(&json!({ "names": ["a"], "options": options })).is_ok());
    let over: Vec<Value> = (0..20001).map(|_| json!({ "names": ["-x"] })).collect();
    assert_eq!(
        refused(json!({ "names": ["a"], "options": over })),
        "spec is too large"
    );
    let args: Vec<Value> = (0..10000).map(|_| json!({})).collect();
    let spread = json!({ "names": ["a"], "options": [], "args": args });
    assert!(parse_completion_spec(&spread).is_ok());
    let halves: Vec<Value> = (0..10001).map(|_| json!({ "names": ["-x"] })).collect();
    let shared = json!({
        "names": ["a"],
        "options": halves,
        "args": (0..10000).map(|_| json!({})).collect::<Vec<_>>()
    });
    assert_eq!(refused(shared), "spec is too large");
}

#[test]
fn reports_the_first_failure_in_subcommands_options_args_order() {
    let out = refused(json!({
        "names": ["a"],
        "subcommands": [{ "names": [] }],
        "options": [3],
        "args": [3]
    }));
    assert_eq!(out, "names must be a non-empty array");
    let out = refused(json!({ "names": ["a"], "options": [3], "args": [3] }));
    assert_eq!(out, "option must be an object");
}
