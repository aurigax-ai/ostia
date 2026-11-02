#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::snippets::{SnippetEntry, SnippetListing, SnippetProblem, SnippetSource};
use ostia_model::terminal::snippets_store::SnippetsStore;

fn entry(name: &str) -> SnippetEntry {
    SnippetEntry {
        name: name.to_owned(),
        command: format!("echo {name}"),
        description: None,
        tags: Vec::new(),
        arguments: Vec::new(),
        shells: None,
        author: None,
        source_url: None,
        source: SnippetSource::User,
        origin: "user".to_owned(),
    }
}

fn listing(names: &[&str]) -> SnippetListing {
    SnippetListing {
        snippets: names.iter().map(|name| entry(name)).collect(),
        problems: vec![SnippetProblem {
            source: SnippetSource::Workspace,
            origin: "w".to_owned(),
            error: "bad".to_owned(),
        }],
    }
}

#[test]
fn starts_closed_with_an_empty_listing_and_nothing_chosen_or_saved() {
    let store = SnippetsStore::default();
    assert!(!store.picker_open());
    assert!(store.listing().snippets.is_empty());
    assert!(store.listing().problems.is_empty());
    assert!(store.target_pane_id().is_none());
    assert!(store.chosen().is_none());
    assert!(store.save_command().is_none());
}

#[test]
fn show_picker_opens_it_with_the_listing_and_target_and_clears_the_choice() {
    let mut store = SnippetsStore::default();
    store.choose(Some(entry("old")));
    store.show_picker(listing(&["a", "b"]), Some("p1"));
    assert!(store.picker_open());
    assert_eq!(store.listing(), &listing(&["a", "b"]));
    assert_eq!(store.target_pane_id(), Some("p1"));
    assert!(store.chosen().is_none());
}

#[test]
fn show_picker_without_a_target_clears_the_target() {
    let mut store = SnippetsStore::default();
    store.show_picker(listing(&["a"]), Some("p1"));
    store.show_picker(listing(&["b"]), None);
    assert!(store.target_pane_id().is_none());
    assert_eq!(store.listing(), &listing(&["b"]));
}

#[test]
fn close_picker_closes_it_and_clears_the_choice_but_keeps_the_listing_and_target() {
    let mut store = SnippetsStore::default();
    store.show_picker(listing(&["a"]), Some("p1"));
    store.choose(Some(entry("a")));
    store.close_picker();
    assert!(!store.picker_open());
    assert!(store.chosen().is_none());
    assert_eq!(store.listing(), &listing(&["a"]));
    assert_eq!(store.target_pane_id(), Some("p1"));
}

#[test]
fn choose_sets_and_clears_the_chosen_snippet() {
    let mut store = SnippetsStore::default();
    store.choose(Some(entry("a")));
    assert_eq!(store.chosen(), Some(&entry("a")));
    store.choose(Some(entry("b")));
    assert_eq!(store.chosen(), Some(&entry("b")));
    store.choose(None);
    assert!(store.chosen().is_none());
}

#[test]
fn start_save_sets_and_clears_the_command_to_save() {
    let mut store = SnippetsStore::default();
    store.start_save(Some("ls -la"));
    assert_eq!(store.save_command(), Some("ls -la"));
    store.show_picker(listing(&["a"]), None);
    assert_eq!(store.save_command(), Some("ls -la"));
    store.start_save(None);
    assert!(store.save_command().is_none());
}
