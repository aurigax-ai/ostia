#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::workspaces::id_namespace::IdNamespace;

#[test]
fn joins_the_prefix_and_the_number_with_a_dash_when_no_namespace_is_set() {
    let ids = IdNamespace::new();
    assert_eq!(ids.namespaced_id("tab", 3), "tab-3");
}

#[test]
fn puts_the_namespace_between_the_prefix_and_the_number() {
    let ids = IdNamespace::new();
    ids.set("w2");
    assert_eq!(ids.namespaced_id("tab", 3), "tab-w2-3");
}

#[test]
fn uses_the_given_separator_after_the_prefix_only() {
    let ids = IdNamespace::new();
    assert_eq!(ids.namespaced_id_with("tab", 3, ":"), "tab:3");
    ids.set("w2");
    assert_eq!(ids.namespaced_id_with("tab", 3, ":"), "tab:w2-3");
}

#[test]
fn drops_the_namespace_again_when_it_is_set_to_an_empty_text() {
    let ids = IdNamespace::new();
    ids.set("w2");
    ids.set("");
    assert_eq!(ids.namespaced_id("tab", 3), "tab-3");
}

#[test]
fn shares_the_namespace_between_clones() {
    let ids = IdNamespace::new();
    let other = ids.clone();
    other.set("w9");
    assert_eq!(ids.namespaced_id("pane", 0), "pane-w9-0");
}
