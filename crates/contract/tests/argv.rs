#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::argv::split_args;

#[test]
fn splits_on_whitespace_and_keeps_quoted_runs_as_one_argument() {
    assert_eq!(
        split_args("subl  -w \"{file}:{line}\" '--flag x'").unwrap(),
        ["subl", "-w", "{file}:{line}", "--flag x"]
    );
}

#[test]
fn returns_null_for_an_unbalanced_quote() {
    assert_eq!(split_args("code \"-g {file}"), None);
}

#[test]
fn keeps_an_explicit_empty_argument() {
    assert_eq!(split_args("ed \"\" {file}").unwrap(), ["ed", "", "{file}"]);
}

#[test]
fn splits_on_the_js_whitespace_set_and_not_on_the_rust_one() {
    let rows = [
        ("a\u{feff}b", vec!["a", "b"]),
        ("a\u{a0}b", vec!["a", "b"]),
        ("a\u{2028}b", vec!["a", "b"]),
        ("a\tb\nc\rd", vec!["a", "b", "c", "d"]),
        ("a\u{85}b", vec!["a\u{85}b"]),
    ];
    for (line, expected) in rows {
        assert_eq!(split_args(line).unwrap(), expected, "line {line:?}");
    }
}

#[test]
fn joins_quoted_and_bare_text_in_one_token_and_ignores_the_other_quote_inside_a_quote() {
    let rows = [
        ("a\"b c\"d", vec!["ab cd".to_owned()]),
        ("'say \"hi\"'", vec!["say \"hi\"".to_owned()]),
        ("\"it's\"", vec!["it's".to_owned()]),
        ("--x=\"a b\"", vec!["--x=a b".to_owned()]),
    ];
    for (line, expected) in rows {
        assert_eq!(split_args(line).unwrap(), expected, "line {line:?}");
    }
}

#[test]
fn returns_no_tokens_for_an_empty_or_blank_line_and_keeps_empty_quotes_alone() {
    let rows = [
        ("", Vec::<&str>::new()),
        ("   \t ", vec![]),
        ("''", vec![""]),
        ("\"\" ''", vec!["", ""]),
    ];
    for (line, expected) in rows {
        assert_eq!(split_args(line).unwrap(), expected, "line {line:?}");
    }
}

#[test]
fn keeps_a_backslash_and_multibyte_text_as_they_are() {
    assert_eq!(
        split_args("a\\b \"日本語 😀\"").unwrap(),
        ["a\\b", "日本語 😀"]
    );
}
