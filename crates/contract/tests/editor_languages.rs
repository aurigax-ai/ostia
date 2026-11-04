#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::editor_languages::{
    BUILTIN_EDITOR_LANGUAGE_IDS, EDITOR_LANGUAGE_EXTENSION_PATTERN,
    EDITOR_LANGUAGE_FILENAME_PATTERN, EDITOR_LANGUAGE_ID_PATTERN, EDITOR_LANGUAGE_NAME_MAX,
    EditorLanguageMapping, GRAMMAR_MAX_RULES, GRAMMAR_MAX_STATES, GRAMMAR_REGEX_MAX,
    MAX_EDITOR_LANGUAGES, MAX_LANGUAGE_FILE_PATTERNS, PLAIN_TEXT_LANGUAGE, SETTINGS_LANGUAGE_ID,
    file_extension, language_for_path, parse_editor_languages, validate_monarch_grammar,
};
use regex::Regex;
use serde_json::{Map, Value, json};

fn inside(path: &str) -> bool {
    !path.starts_with("..") && !path.starts_with('/')
}

fn language(extra: Value) -> Value {
    let mut base = json!({
        "id": "gleam",
        "name": "Gleam",
        "extensions": [".gleam"],
        "grammar": "gleam.monarch.json",
    });
    for (key, value) in extra.as_object().unwrap() {
        base[key] = value.clone();
    }
    base
}

fn without(mut value: Value, key: &str) -> Value {
    value.as_object_mut().unwrap().remove(key);
    value
}

fn problem(extra: Value) -> String {
    parse_editor_languages(Some(&json!([language(extra)])), &inside)
        .err()
        .unwrap_or_default()
}

fn parsed(raw: &Value) -> Value {
    serde_json::to_value(parse_editor_languages(Some(raw), &inside).unwrap()).unwrap()
}

fn matches(text: &str, pattern: &str) -> bool {
    Regex::new(pattern).unwrap().is_match(text)
}

fn mapping(id: &str, extensions: &[&str], filenames: &[&str]) -> EditorLanguageMapping {
    EditorLanguageMapping {
        id: id.to_owned(),
        extensions: extensions.iter().map(|item| (*item).to_owned()).collect(),
        filenames: filenames.iter().map(|item| (*item).to_owned()).collect(),
    }
}

fn grammar_problem(raw: &Value) -> String {
    validate_monarch_grammar(raw).err().unwrap_or_default()
}

#[test]
fn names_the_editor_language_by_file_extension_whatever_its_case() {
    assert_eq!(language_for_path("/p/a.ts", &[]), "typescript");
    assert_eq!(language_for_path("/p/App.TSX", &[]), "typescript");
    assert_eq!(language_for_path("/p/main.rs", &[]), "rust");
    assert_eq!(language_for_path("/p/x.hpp", &[]), "cpp");
    assert_eq!(language_for_path("/p/types.pyi", &[]), "python");
}

#[test]
fn falls_back_to_plain_text_for_an_unknown_or_missing_extension() {
    assert_eq!(language_for_path("/p/Makefile", &[]), "plaintext");
    assert_eq!(language_for_path("/p.d/notes", &[]), "plaintext");
    assert_eq!(language_for_path("/p/a.unknown", &[]), "plaintext");
    assert_eq!(language_for_path("/p/a.constructor", &[]), "plaintext");
}

#[test]
fn knows_a_contributed_language_by_file_name_then_by_its_longest_suffix() {
    let contributed = [
        mapping("gleam", &[".gleam"], &["gleam.toml"]),
        mapping("gleam-test", &[".test.gleam"], &[]),
        mapping("make", &[], &["Makefile"]),
    ];
    assert_eq!(language_for_path("/p/app.gleam", &contributed), "gleam");
    assert_eq!(language_for_path("/p/APP.GLEAM", &contributed), "gleam");
    assert_eq!(
        language_for_path("/p/app.test.gleam", &contributed),
        "gleam-test"
    );
    assert_eq!(language_for_path("/p/Makefile", &contributed), "make");
    assert_eq!(language_for_path("/p/.gleam", &contributed), "plaintext");
    assert_eq!(language_for_path("/p/notes.txt", &contributed), "plaintext");
}

#[test]
fn never_lets_a_contribution_take_a_file_the_editor_already_has_a_language_for() {
    let contributed = [mapping("mine", &[".ts", ".toml"], &["a.rs"])];
    assert_eq!(language_for_path("/p/a.ts", &contributed), "typescript");
    assert_eq!(language_for_path("/p/a.rs", &contributed), "rust");
    assert_eq!(language_for_path("/p/Cargo.toml", &contributed), "ini");
}

#[test]
fn reads_the_file_extension_from_the_base_name_in_lower_case() {
    assert_eq!(file_extension("/p/App.TSX"), "tsx");
    assert_eq!(file_extension("/p/archive.tar.gz"), "gz");
    assert_eq!(file_extension("/p/Makefile"), "");
    assert_eq!(file_extension("/p.d/notes"), "");
    assert_eq!(file_extension("/p/.gitignore"), "gitignore");
    assert_eq!(file_extension("/p/trailing."), "");
    assert_eq!(file_extension("plain.md"), "md");
}

#[test]
fn lets_a_longer_contributed_suffix_win_whatever_the_list_order() {
    let long_first = [
        mapping("long", &[".a.b"], &[]),
        mapping("short", &[".b"], &[]),
    ];
    let short_first = [
        mapping("short", &[".b"], &[]),
        mapping("long", &[".a.b"], &[]),
    ];
    assert_eq!(language_for_path("/p/x.a.b", &long_first), "long");
    assert_eq!(language_for_path("/p/x.a.b", &short_first), "long");
    assert_eq!(language_for_path("/p/x.c.b", &short_first), "short");
}

#[test]
fn keeps_the_first_contributed_language_on_a_suffix_of_equal_length() {
    let contributed = [
        mapping("first", &[".zz"], &[]),
        mapping("second", &[".zz"], &[]),
    ];
    assert_eq!(language_for_path("/p/x.zz", &contributed), "first");
}

#[test]
fn matches_a_contributed_file_name_exactly_and_with_case() {
    let contributed = [mapping("make", &[], &["Makefile"])];
    assert_eq!(language_for_path("/p/Makefile", &contributed), "make");
    assert_eq!(language_for_path("/p/makefile", &contributed), "plaintext");
}

#[test]
fn lists_the_builtin_ids_the_editor_already_has() {
    for id in [
        "typescript",
        "javascript",
        "rust",
        "plaintext",
        "ostia-settings",
        "ini",
        "shell",
    ] {
        assert!(BUILTIN_EDITOR_LANGUAGE_IDS.contains(id), "id: {id}");
    }
    assert!(!BUILTIN_EDITOR_LANGUAGE_IDS.contains("gleam"));
    assert_eq!(PLAIN_TEXT_LANGUAGE, "plaintext");
    assert_eq!(SETTINGS_LANGUAGE_ID, "ostia-settings");
}

#[test]
fn fills_defaults_and_keeps_the_comment_and_bracket_configuration() {
    let raw = json!([
        language(json!({
            "filenames": ["gleam.toml"],
            "configuration": {
                "lineComment": "//",
                "blockComment": ["/*", "*/"],
                "brackets": [["{", "}"]],
                "autoClosingPairs": [["\"", "\""]],
                "ignored": true,
            },
        })),
        without(
            language(json!({"id": "other", "filenames": ["Otherfile"]})),
            "extensions"
        ),
    ]);
    assert_eq!(
        parsed(&raw),
        json!([
            {
                "id": "gleam",
                "name": "Gleam",
                "extensions": [".gleam"],
                "filenames": ["gleam.toml"],
                "configuration": {
                    "lineComment": "//",
                    "blockComment": ["/*", "*/"],
                    "brackets": [["{", "}"]],
                    "autoClosingPairs": [["\"", "\""]],
                },
                "grammar": "gleam.monarch.json",
            },
            {
                "id": "other",
                "name": "Gleam",
                "extensions": [],
                "filenames": ["Otherfile"],
                "configuration": {},
                "grammar": "gleam.monarch.json",
            },
        ])
    );
    assert!(parse_editor_languages(None, &inside).unwrap().is_empty());
}

#[test]
fn refuses_an_id_the_editor_already_has_a_duplicate_and_a_bad_one() {
    assert!(matches(
        &problem(json!({"id": "typescript"})),
        "already has"
    ));
    assert!(matches(&problem(json!({"id": "plaintext"})), "already has"));
    assert!(matches(
        &problem(json!({"id": "ostia-settings"})),
        "already has"
    ));
    assert!(matches(&problem(json!({"id": "Bad Id"})), "invalid id"));
    let twice = json!([language(json!({})), language(json!({}))]);
    let duplicate = parse_editor_languages(Some(&twice), &inside).unwrap_err();
    assert!(matches(&duplicate, "duplicate id 'gleam'"), "{duplicate}");
    let many = Value::Array(vec![language(json!({})); 17]);
    let too_many = parse_editor_languages(Some(&many), &inside).unwrap_err();
    assert!(matches(&too_many, "at most 16"), "{too_many}");
}

#[test]
fn needs_a_name_a_file_pattern_and_a_grammar_file_inside_the_extension() {
    assert!(matches(&problem(json!({"name": ""})), "name must be"));
    assert!(matches(
        &problem(json!({"extensions": []})),
        "at least one extension or file name"
    ));
    assert!(matches(
        &problem(json!({"extensions": ["gleam"]})),
        "extensions must be"
    ));
    assert!(matches(
        &problem(json!({"extensions": [".a/b"]})),
        "extensions must be"
    ));
    assert!(matches(
        &problem(json!({"filenames": ["../x"]})),
        "filenames must be"
    ));
    assert!(matches(
        &problem(json!({"grammar": "../outside.json"})),
        "inside the extension"
    ));
    assert!(matches(
        &problem(json!({"grammar": "grammar.js"})),
        r"\.json file"
    ));
}

#[test]
fn takes_comments_and_brackets_only_as_short_strings() {
    assert!(matches(
        &problem(json!({"configuration": {"lineComment": "x".repeat(11)}})),
        "lineComment"
    ));
    assert!(matches(
        &problem(json!({"configuration": {"blockComment": ["/*"]}})),
        "blockComment"
    ));
    assert!(matches(
        &problem(json!({"configuration": {"brackets": [["{", 1]]}})),
        "brackets"
    ));
    assert!(matches(
        &problem(json!({"configuration": {"autoClosingPairs": "no"}})),
        "autoClosingPairs"
    ));
    assert!(matches(
        &problem(json!({"configuration": []})),
        "configuration must be an object"
    ));
}

#[test]
fn names_the_place_of_each_problem_by_index_and_path() {
    let raw = json!([
        language(json!({})),
        language(json!({"id": "second", "name": ""}))
    ]);
    let text = parse_editor_languages(Some(&raw), &inside).unwrap_err();
    assert_eq!(
        text,
        "contributes.editorLanguages[1]: name must be 1-80 characters"
    );
    assert_eq!(
        parse_editor_languages(Some(&json!("nope")), &inside).unwrap_err(),
        "contributes.editorLanguages must be an array of at most 16"
    );
    assert_eq!(
        parse_editor_languages(Some(&json!([7])), &inside).unwrap_err(),
        "contributes.editorLanguages[0]: must be an object"
    );
    assert_eq!(
        problem(json!({"configuration": {"lineComment": ""}})),
        "contributes.editorLanguages[0].configuration.lineComment must be a short string"
    );
}

#[test]
fn refuses_a_name_that_is_blank_or_longer_than_the_limit() {
    assert!(matches(&problem(json!({"name": "   "})), "name must be"));
    assert!(matches(
        &problem(json!({"name": "n".repeat(EDITOR_LANGUAGE_NAME_MAX + 1)})),
        "name must be"
    ));
    assert_eq!(
        problem(json!({"name": "n".repeat(EDITOR_LANGUAGE_NAME_MAX)})),
        ""
    );
    assert!(matches(&problem(json!({"name": 7})), "name must be"));
}

#[test]
fn caps_the_file_patterns_and_removes_repeats() {
    let many: Vec<String> = (0..=MAX_LANGUAGE_FILE_PATTERNS)
        .map(|index| format!(".e{index}"))
        .collect();
    assert!(matches(
        &problem(json!({"extensions": many})),
        "extensions must be at most 16 names"
    ));
    let result = parsed(&json!([language(json!({
        "extensions": [".a", ".b", ".a"],
        "filenames": ["x", "x"],
    }))]));
    assert_eq!(result[0]["extensions"], json!([".a", ".b"]));
    assert_eq!(result[0]["filenames"], json!(["x"]));
}

#[test]
fn takes_a_file_name_pattern_alone_and_refuses_a_non_string_in_the_list() {
    assert_eq!(
        problem(json!({"extensions": [], "filenames": ["Justfile"]})),
        ""
    );
    assert!(matches(
        &problem(json!({"extensions": [7]})),
        "extensions must be"
    ));
    assert!(matches(
        &problem(json!({"extensions": ".gleam"})),
        "extensions must be"
    ));
}

#[test]
fn limits_bracket_lists_to_sixteen_pairs() {
    let pairs = |count: usize| vec![json!(["(", ")"]); count];
    assert_eq!(
        problem(json!({"configuration": {"brackets": pairs(16)}})),
        ""
    );
    assert!(matches(
        &problem(json!({"configuration": {"brackets": pairs(17)}})),
        "brackets must be at most 16 pairs"
    ));
    assert!(matches(
        &problem(json!({"configuration": {"brackets": [["(", ")", "x"]]}})),
        "brackets must hold pairs of short strings"
    ));
    assert!(matches(
        &problem(json!({"configuration": {"brackets": [["", ")"]]}})),
        "brackets must hold pairs of short strings"
    ));
}

#[test]
fn matches_the_id_extension_and_file_name_patterns() {
    for id in ["gleam", "c++", "c#", "a-b+c", "x"] {
        assert!(EDITOR_LANGUAGE_ID_PATTERN.is_match(id), "id: {id}");
    }
    let long_id = "a".repeat(41);
    for id in ["", "Gleam", "1gleam", "-a", "a b", long_id.as_str()] {
        assert!(!EDITOR_LANGUAGE_ID_PATTERN.is_match(id), "id: {id}");
    }
    for extension in [".gleam", ".a", ".tar.gz", ".+x"] {
        assert!(
            EDITOR_LANGUAGE_EXTENSION_PATTERN.is_match(extension),
            "extension: {extension}"
        );
    }
    for extension in ["gleam", ".", "..a", ".a/b", ".a b"] {
        assert!(
            !EDITOR_LANGUAGE_EXTENSION_PATTERN.is_match(extension),
            "extension: {extension}"
        );
    }
    for name in ["Makefile", "a.b", "x+y", "_a"] {
        assert!(
            EDITOR_LANGUAGE_FILENAME_PATTERN.is_match(name),
            "name: {name}"
        );
    }
    let long_name = "a".repeat(61);
    for name in ["", "a/b", "a b", long_name.as_str()] {
        assert!(
            !EDITOR_LANGUAGE_FILENAME_PATTERN.is_match(name),
            "name: {name}"
        );
    }
    assert_eq!(MAX_EDITOR_LANGUAGES, 16);
}

fn grammar() -> Value {
    json!({
        "defaultToken": "invalid",
        "keywords": ["fn", "let"],
        "symbols": "[=><!~?:&|+\\-*/^%]+",
        "tokenizer": {
            "root": [
                ["[a-z_]\\w*", {"cases": {"@keywords": "keyword", "@default": "identifier"}}],
                ["@symbols", "operator"],
                {"include": "@whitespace"},
                {"regex": "\\d+", "action": "number"},
            ],
            "whitespace": [["[ \\t\\r\\n]+", ""]],
        },
    })
}

#[test]
fn accepts_a_grammar_whose_rules_all_start_with_a_regular_expression_that_compiles() {
    assert_eq!(validate_monarch_grammar(&grammar()).unwrap(), grammar());
}

#[test]
fn accepts_the_rules_a_javascript_regular_expression_accepts() {
    for rule in [
        "(?=\\()",
        "(['\"])\\1",
        "[^]",
        "{",
        "\\z",
        "[[:alpha:]]",
        "(?<n>x)\\k<n>",
    ] {
        let grammar = json!({"tokenizer": {"root": [[rule, "x"]]}});
        assert_eq!(
            validate_monarch_grammar(&grammar).unwrap(),
            grammar,
            "{rule}"
        );
    }
}

#[test]
fn refuses_the_rules_a_javascript_regular_expression_refuses() {
    for rule in ["(?i)select", "(?P<n>x)", "a{2,1}", "(?<=a"] {
        let grammar = json!({"tokenizer": {"root": [[rule, "x"]]}});
        assert!(validate_monarch_grammar(&grammar).is_err(), "{rule}");
    }
}

#[test]
fn drops_prototype_keys_and_anything_that_is_not_plain_data() {
    let dirty: Value = serde_json::from_str(
        r#"{"__proto__":{"x":1},"constructor":"x","tokenizer":{"root":[["a","b"]],"prototype":[]}}"#,
    )
    .unwrap();
    assert_eq!(
        validate_monarch_grammar(&dirty).unwrap(),
        json!({"tokenizer": {"root": [["a", "b"]]}})
    );
}

#[test]
fn refuses_a_grammar_without_states_with_a_rule_that_does_not_compile_or_too_many_rules() {
    assert!(matches(&grammar_problem(&json!([])), "JSON object"));
    assert!(matches(
        &grammar_problem(&json!({})),
        "tokenizer must be an object"
    ));
    assert!(matches(
        &grammar_problem(&json!({"tokenizer": {}})),
        "1-200 states"
    ));
    assert!(matches(
        &grammar_problem(&json!({"tokenizer": {"root": "x"}})),
        "must be an array"
    ));
    assert!(matches(
        &grammar_problem(&json!({"tokenizer": {"root": [["(unclosed", "x"]]}})),
        r"tokenizer\.root\[0\] does not start with a regular expression that compiles"
    ));
    assert!(matches(
        &grammar_problem(&json!({"tokenizer": {"root": [[42, "x"]]}})),
        r"root\[0\]"
    ));
    assert!(matches(
        &grammar_problem(&json!({"tokenizer": {"root": [{"action": "x"}]}})),
        r"root\[0\]"
    ));
    assert!(matches(
        &grammar_problem(&json!({"symbols": "[", "tokenizer": {"root": [["a", "b"]]}})),
        "symbols is not a regular expression"
    ));
    let rules = vec![json!(["a", "b"]); GRAMMAR_MAX_RULES + 1];
    assert!(matches(
        &grammar_problem(&json!({"tokenizer": {"root": rules}})),
        "at most 500 rules"
    ));
    assert!(matches(
        &grammar_problem(
            &json!({"tokenizer": {"root": [["a".repeat(GRAMMAR_REGEX_MAX + 1), "x"]]}})
        ),
        r"root\[0\]"
    ));
}

#[test]
fn caps_the_states_and_the_length_of_a_rule_regex() {
    let mut states = Map::new();
    for index in 0..=GRAMMAR_MAX_STATES {
        states.insert(format!("s{index}"), json!([["a", "b"]]));
    }
    assert!(matches(
        &grammar_problem(&json!({"tokenizer": states})),
        "1-200 states"
    ));
    let edge = "a".repeat(GRAMMAR_REGEX_MAX);
    assert!(validate_monarch_grammar(&json!({"tokenizer": {"root": [[edge, "x"]]}})).is_ok());
}

#[test]
fn lets_an_include_rule_stand_without_a_regular_expression() {
    assert!(
        validate_monarch_grammar(&json!({"tokenizer": {"root": [{"include": "@other"}]}})).is_ok()
    );
    assert!(matches(
        &grammar_problem(&json!({"tokenizer": {"root": [{"include": 7}]}})),
        r"root\[0\]"
    ));
}

#[test]
fn takes_a_rule_regex_from_a_list_head_or_a_regex_key_and_ignores_the_at_names() {
    assert!(validate_monarch_grammar(&json!({"tokenizer": {"root": [["@name(", "x"]]}})).is_err());
    assert!(validate_monarch_grammar(&json!({"tokenizer": {"root": [["@name+", "x"]]}})).is_ok());
    assert!(matches(
        &grammar_problem(&json!({"tokenizer": {"root": [{"regex": "(", "action": "x"}]}})),
        r"root\[0\]"
    ));
}

#[test]
fn leaves_the_default_token_alone_and_checks_every_other_string_key() {
    assert!(
        validate_monarch_grammar(
            &json!({"defaultToken": "(", "tokenizer": {"root": [["a", "b"]]}})
        )
        .is_ok()
    );
    assert!(matches(
        &grammar_problem(&json!({"escapes": "(", "tokenizer": {"root": [["a", "b"]]}})),
        "escapes is not a regular expression that compiles"
    ));
}

#[test]
fn drops_null_values_and_keeps_numbers_and_booleans() {
    let cleaned = validate_monarch_grammar(&json!({
        "ignoreCase": true,
        "size": 3,
        "gone": null,
        "tokenizer": {"root": [["a", "b"]]},
    }))
    .unwrap();
    assert_eq!(
        cleaned,
        json!({"ignoreCase": true, "size": 3, "tokenizer": {"root": [["a", "b"]]}})
    );
}

#[test]
fn drops_a_value_nested_deeper_than_twelve_levels() {
    let nest = |levels: usize| {
        let mut value = json!("x");
        for _ in 0..levels {
            value = json!({"a": value});
        }
        value
    };
    let cleaned = validate_monarch_grammar(&json!({
        "deep": nest(14),
        "tokenizer": {"root": [["a", "b"]]},
    }))
    .unwrap();
    let mut expected = json!({});
    for _ in 0..11 {
        expected = json!({"a": expected});
    }
    assert_eq!(cleaned["deep"], expected);
}
