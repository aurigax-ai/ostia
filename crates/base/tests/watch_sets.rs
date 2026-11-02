#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeSet;

use ostia_base::watch_sets::WatchSets;
use serde_json::{Value, json};

fn ids(items: &[&str]) -> BTreeSet<String> {
    items.iter().map(|id| (*id).to_owned()).collect()
}

#[test]
fn is_empty_until_a_window_names_a_workspace_and_again_once_every_window_stopped() {
    let mut sets = WatchSets::new();
    assert!(sets.is_empty());
    assert!(sets.set("w1", &json!(["a", "b"])));
    assert!(sets.set("w2", &json!(["b", "c"])));
    assert_eq!(sets.union(), ids(&["a", "b", "c"]));
    assert!(sets.set("w1", &json!([])));
    assert!(sets.drop_window("w2"));
    assert!(sets.is_empty());
}

#[test]
fn reports_no_change_for_the_same_set_in_another_order() {
    let mut sets = WatchSets::new();
    sets.set("w1", &json!(["a", "b"]));
    assert!(!sets.set("w1", &json!(["b", "a"])));
}

#[test]
fn keeps_only_non_empty_strings_from_what_a_window_sent() {
    let mut sets = WatchSets::new();
    sets.set("w1", &json!(["a", "", 3, null, {"id": "x"}]));
    assert_eq!(sets.union(), ids(&["a"]));
    assert!(sets.set("w1", &json!("a")));
    assert!(sets.is_empty());
}

#[test]
fn reports_no_change_for_an_empty_list_from_a_window_that_watches_nothing() {
    let mut sets = WatchSets::new();
    assert!(!sets.set("w1", &json!([])));
    assert!(!sets.set("w1", &Value::Null));
    assert!(!sets.set("w1", &json!({"a": 1})));
    assert!(sets.is_empty());
}

#[test]
fn reports_a_change_when_the_set_grows_shrinks_or_swaps() {
    let mut sets = WatchSets::new();
    assert!(sets.set("w1", &json!(["a"])));
    assert!(sets.set("w1", &json!(["a", "b"])));
    assert!(sets.set("w1", &json!(["b"])));
    assert!(sets.set("w1", &json!(["c"])));
    assert!(!sets.set("w1", &json!(["c", "c"])));
}

#[test]
fn keeps_at_most_500_entries_counting_duplicates_before_they_collapse() {
    let mut sets = WatchSets::new();
    let many: Vec<String> = (0..600).map(|n| format!("id-{n}")).collect();
    sets.set("w1", &json!(many));
    let union = sets.union();
    assert_eq!(union.len(), 500);
    assert!(union.contains("id-499"));
    assert!(!union.contains("id-500"));

    let mut copies: Vec<Value> = vec![json!("a"); 500];
    copies.push(json!("b"));
    let mut sets = WatchSets::new();
    sets.set("w1", &Value::Array(copies));
    assert_eq!(sets.union(), ids(&["a"]));
}

#[test]
fn counts_the_500_after_dropping_entries_that_are_not_strings() {
    let mut sets = WatchSets::new();
    let mut mixed: Vec<Value> = vec![json!(1); 100];
    mixed.extend((0..500).map(|n| json!(format!("id-{n}"))));
    sets.set("w1", &Value::Array(mixed));
    assert_eq!(sets.union().len(), 500);
}

#[test]
fn drops_a_window_once_and_says_so_only_when_it_was_there() {
    let mut sets = WatchSets::new();
    sets.set("w1", &json!(["a"]));
    assert!(sets.drop_window("w1"));
    assert!(!sets.drop_window("w1"));
    assert!(!sets.drop_window("never"));
}

#[test]
fn lists_the_windows_in_the_order_they_first_named_a_workspace() {
    let mut sets = WatchSets::new();
    sets.set("w2", &json!(["b"]));
    sets.set("w1", &json!(["a"]));
    sets.set("w2", &json!(["b", "c"]));
    assert_eq!(
        sets.windows(),
        vec![
            ("w2".to_owned(), ids(&["b", "c"])),
            ("w1".to_owned(), ids(&["a"]))
        ]
    );
}

#[test]
fn forgets_a_window_that_stopped_watching_in_the_window_list() {
    let mut sets = WatchSets::new();
    sets.set("w1", &json!(["a"]));
    sets.set("w2", &json!(["b"]));
    sets.set("w1", &json!([]));
    assert_eq!(sets.windows(), vec![("w2".to_owned(), ids(&["b"]))]);
}
