#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::panes::tab_history::TabHistories;

fn recent(histories: &TabHistories, workspace: &str) -> Vec<String> {
    histories.of(workspace).recent
}

fn opener(histories: &TabHistories, workspace: &str, tab: &str) -> Option<String> {
    histories.of(workspace).openers.get(tab).cloned()
}

#[test]
fn gives_an_empty_history_for_a_workspace_it_has_not_seen() {
    let histories = TabHistories::new();
    let history = histories.of("w1");
    assert!(history.recent.is_empty());
    assert!(history.openers.is_empty());
}

#[test]
fn reading_a_history_does_not_create_one() {
    let histories = TabHistories::new();
    histories.of("w1");
    histories.forget_tab("w1", "a");
    assert!(recent(&histories, "w1").is_empty());
}

#[test]
fn puts_the_new_tab_first_and_the_old_tab_second_when_a_tab_is_activated() {
    let histories = TabHistories::new();
    histories.note_activated("w1", "a", "b");
    assert_eq!(recent(&histories, "w1"), vec!["b", "a"]);
    histories.note_activated("w1", "b", "c");
    assert_eq!(recent(&histories, "w1"), vec!["c", "b", "a"]);
}

#[test]
fn moves_a_tab_that_is_already_listed_to_the_front_without_a_copy() {
    let histories = TabHistories::new();
    histories.note_activated("w1", "a", "b");
    histories.note_activated("w1", "b", "c");
    histories.note_activated("w1", "c", "a");
    assert_eq!(recent(&histories, "w1"), vec!["a", "c", "b"]);
}

#[test]
fn ignores_an_activation_of_the_tab_that_is_already_active() {
    let histories = TabHistories::new();
    histories.note_activated("w1", "a", "b");
    histories.note_opener("w1", "b", "a");
    histories.note_activated("w1", "b", "b");
    assert_eq!(recent(&histories, "w1"), vec!["b", "a"]);
    assert_eq!(opener(&histories, "w1", "b").as_deref(), Some("a"));
}

#[test]
fn keeps_only_the_64_most_recent_tabs() {
    let histories = TabHistories::new();
    for index in 0..100 {
        histories.note_activated("w1", &format!("t{index}"), &format!("t{}", index + 1));
    }
    let recent = recent(&histories, "w1");
    assert_eq!(recent.len(), 64);
    assert_eq!(recent[0], "t100");
    assert_eq!(recent[1], "t99");
    assert_eq!(recent[63], "t37");
}

#[test]
fn keeps_the_history_of_each_workspace_apart() {
    let histories = TabHistories::new();
    histories.note_activated("w1", "a", "b");
    histories.note_activated("w2", "x", "y");
    assert_eq!(recent(&histories, "w1"), vec!["b", "a"]);
    assert_eq!(recent(&histories, "w2"), vec!["y", "x"]);
}

#[test]
fn drops_the_opener_of_the_tab_it_leaves_when_a_tab_is_activated() {
    let histories = TabHistories::new();
    histories.note_opener("w1", "a", "z");
    histories.note_activated("w1", "a", "b");
    assert_eq!(opener(&histories, "w1", "a"), None);
}

#[test]
fn keeps_the_opener_of_the_tab_it_goes_to_when_that_opener_is_the_tab_it_leaves() {
    let histories = TabHistories::new();
    histories.note_opener("w1", "b", "a");
    histories.note_activated("w1", "a", "b");
    assert_eq!(opener(&histories, "w1", "b").as_deref(), Some("a"));
}

#[test]
fn drops_the_opener_of_the_tab_it_goes_to_when_another_tab_opened_it() {
    let histories = TabHistories::new();
    histories.note_opener("w1", "b", "z");
    histories.note_activated("w1", "a", "b");
    assert_eq!(opener(&histories, "w1", "b"), None);
}

#[test]
fn records_which_tab_opened_another_tab() {
    let histories = TabHistories::new();
    histories.note_opener("w1", "child", "parent");
    assert_eq!(opener(&histories, "w1", "child").as_deref(), Some("parent"));
}

#[test]
fn replaces_the_opener_of_a_tab_that_is_opened_again() {
    let histories = TabHistories::new();
    histories.note_opener("w1", "child", "first");
    histories.note_opener("w1", "child", "second");
    assert_eq!(opener(&histories, "w1", "child").as_deref(), Some("second"));
}

#[test]
fn does_not_record_a_tab_as_its_own_opener() {
    let histories = TabHistories::new();
    histories.note_opener("w1", "a", "a");
    assert_eq!(opener(&histories, "w1", "a"), None);
    assert!(histories.of("w1").openers.is_empty());
}

#[test]
fn forgets_a_closed_tab_from_the_recent_list_and_from_the_openers() {
    let histories = TabHistories::new();
    histories.note_activated("w1", "a", "b");
    histories.note_opener("w1", "b", "a");
    histories.forget_tab("w1", "b");
    assert_eq!(recent(&histories, "w1"), vec!["a"]);
    assert_eq!(opener(&histories, "w1", "b"), None);
}

#[test]
fn forgets_the_tabs_that_a_closed_tab_opened() {
    let histories = TabHistories::new();
    histories.note_opener("w1", "c1", "parent");
    histories.note_opener("w1", "c2", "parent");
    histories.note_opener("w1", "c3", "other");
    histories.forget_tab("w1", "parent");
    assert_eq!(opener(&histories, "w1", "c1"), None);
    assert_eq!(opener(&histories, "w1", "c2"), None);
    assert_eq!(opener(&histories, "w1", "c3").as_deref(), Some("other"));
}

#[test]
fn ignores_forgetting_a_tab_in_a_workspace_with_no_history() {
    let histories = TabHistories::new();
    histories.forget_tab("w9", "a");
    assert!(histories.of("w9").recent.is_empty());
}

#[test]
fn forgets_every_tab_of_a_closed_workspace_and_no_other() {
    let histories = TabHistories::new();
    histories.note_activated("w1", "a", "b");
    histories.note_opener("w1", "b", "a");
    histories.note_activated("w2", "x", "y");
    histories.forget_workspace_tabs("w1");
    assert!(histories.of("w1").recent.is_empty());
    assert!(histories.of("w1").openers.is_empty());
    assert_eq!(recent(&histories, "w2"), vec!["y", "x"]);
}

#[test]
fn shares_one_history_between_clones() {
    let histories = TabHistories::new();
    let clone = histories.clone();
    clone.note_activated("w1", "a", "b");
    assert_eq!(recent(&histories, "w1"), vec!["b", "a"]);
}
