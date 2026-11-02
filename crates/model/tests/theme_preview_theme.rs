#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;

use ostia_model::theme::preview_theme::preview_theme;

fn tokens(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(name, value)| ((*name).to_string(), (*value).to_string()))
        .collect()
}

#[test]
fn maps_each_preview_variable_to_its_app_token() {
    let computed = tokens(&[
        ("--surface-1", "#111"),
        ("--surface-2", "#222"),
        ("--fg", "#eee"),
        ("--fg-muted", "#999"),
        ("--line", "#333"),
        ("--brand", "#0af"),
        ("--font-ui", "Inter"),
        ("--font-code", "Geist Mono"),
    ]);
    let theme = preview_theme(true, |token| computed.get(token).cloned());
    assert!(theme.dark);
    assert_eq!(
        theme.vars,
        tokens(&[
            ("--ostia-bg", "#111"),
            ("--ostia-surface", "#222"),
            ("--ostia-fg", "#eee"),
            ("--ostia-muted", "#999"),
            ("--ostia-line", "#333"),
            ("--ostia-accent", "#0af"),
            ("--ostia-font", "Inter"),
            ("--ostia-font-mono", "Geist Mono"),
        ])
    );
}

#[test]
fn trims_a_value_and_leaves_out_an_empty_one() {
    let computed = tokens(&[("--fg", "  #eee \n"), ("--line", "   "), ("--brand", "")]);
    let theme = preview_theme(false, |token| computed.get(token).cloned());
    assert!(!theme.dark);
    assert_eq!(theme.vars, tokens(&[("--ostia-fg", "#eee")]));
}

#[test]
fn has_no_variables_when_the_app_defines_no_token() {
    let theme = preview_theme(false, |_| None);
    assert!(theme.vars.is_empty());
}
