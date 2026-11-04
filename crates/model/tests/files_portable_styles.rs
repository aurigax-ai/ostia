#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;

use ostia_model::files::portable_styles::with_root_variables;

fn values<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> String + 'a {
    let table: HashMap<&str, &str> = pairs.iter().copied().collect();
    move |name| table.get(name).copied().unwrap_or("").to_owned()
}

#[test]
fn returns_the_css_alone_when_it_uses_no_variable() {
    let css = "a{color:red}";
    assert_eq!(with_root_variables(css, values(&[("--a", "1")])), css);
}

#[test]
fn puts_the_variables_a_rule_uses_in_a_root_rule_before_the_css() {
    let css = "a{color:var(--a)}";
    assert_eq!(
        with_root_variables(css, values(&[("--a", "red")])),
        ":root{--a:red}\na{color:var(--a)}"
    );
}

#[test]
fn lists_the_last_used_variable_first() {
    let css = "p{a:var(--a);b:var(--b)}";
    assert_eq!(
        with_root_variables(css, values(&[("--a", "1"), ("--b", "2")])),
        ":root{--b:2;--a:1}\np{a:var(--a);b:var(--b)}"
    );
}

#[test]
fn lists_a_variable_used_twice_once() {
    let css = "p{a:var(--a);b:var(--a)}";
    assert_eq!(
        with_root_variables(css, values(&[("--a", "1")])),
        ":root{--a:1}\np{a:var(--a);b:var(--a)}"
    );
}

#[test]
fn follows_variables_that_a_value_uses() {
    let css = "p{a:var(--a)}";
    let table = [("--a", "var(--c) var(--d)"), ("--c", "3"), ("--d", "4")];
    assert_eq!(
        with_root_variables(css, values(&table)),
        ":root{--a:var(--c) var(--d);--d:4;--c:3}\np{a:var(--a)}"
    );
}

#[test]
fn stops_at_variables_that_use_each_other() {
    let css = "p{a:var(--a)}";
    let table = [("--a", "var(--b)"), ("--b", "var(--a)")];
    assert_eq!(
        with_root_variables(css, values(&table)),
        ":root{--a:var(--b);--b:var(--a)}\np{a:var(--a)}"
    );
}

#[test]
fn leaves_out_a_variable_with_no_value() {
    let css = "p{a:var(--a);b:var(--b)}";
    assert_eq!(
        with_root_variables(css, values(&[("--b", "1")])),
        ":root{--b:1}\np{a:var(--a);b:var(--b)}"
    );
    assert_eq!(with_root_variables(css, values(&[("--a", "  ")])), css);
}

#[test]
fn trims_the_value_the_way_javascript_does() {
    let css = "p{a:var(--a);b:var(--b)}";
    let table = [("--a", "  red \n"), ("--b", "\u{feff}blue\u{a0}")];
    assert_eq!(
        with_root_variables(css, values(&table)),
        ":root{--b:blue;--a:red}\np{a:var(--a);b:var(--b)}"
    );
}

#[test]
fn reads_the_name_after_spaces_and_ignores_a_fallback() {
    let css = "p{a:var(  --x, 1px)}";
    assert_eq!(
        with_root_variables(css, values(&[("--x", "2px")])),
        ":root{--x:2px}\np{a:var(  --x, 1px)}"
    );
}

#[test]
fn names_use_ascii_letters_digits_underscore_and_hyphen() {
    let css = "p{a:var(--a-b_1)}";
    assert_eq!(
        with_root_variables(css, values(&[("--a-b_1", "1")])),
        ":root{--a-b_1:1}\np{a:var(--a-b_1)}"
    );
    let triple = "p{a:var(---)}";
    assert_eq!(
        with_root_variables(triple, values(&[("---", "1")])),
        ":root{---:1}\np{a:var(---)}"
    );
}

#[test]
fn a_name_stops_at_a_non_ascii_letter() {
    let css = "p{a:var(--a\u{e9}b)}";
    assert_eq!(
        with_root_variables(css, values(&[("--a", "1")])),
        ":root{--a:1}\np{a:var(--a\u{e9}b)}"
    );
    let none = "p{a:var(--\u{e9})}";
    assert_eq!(
        with_root_variables(none, values(&[("--\u{e9}", "1")])),
        none
    );
}

#[test]
fn does_not_read_single_dash_names_or_an_empty_name() {
    for css in [
        "p{a:var(-x)}",
        "p{a:var(--)}",
        "p{a:var()}",
        "p{a:vars(--x)}",
    ] {
        assert_eq!(
            with_root_variables(css, values(&[("--x", "1"), ("-x", "1"), ("--", "1")])),
            css,
            "{css}"
        );
    }
}
