#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::scrollback_history::{HistoryMatch, HistorySearchOptions};
use ostia_model::terminal::history_view_store::{HistoryFind, HistoryTarget, HistoryViewStore};

fn find() -> HistoryFind {
    HistoryFind {
        query: "error".to_owned(),
        options: HistorySearchOptions {
            case_sensitive: Some(true),
            regex: None,
            whole_word: None,
        },
        matches: vec![HistoryMatch {
            line: 12,
            start: 3,
            end: 8,
        }],
        index: 0,
    }
}

#[test]
fn shows_a_target_for_one_pane_and_replaces_it_on_the_next_show() {
    let mut store = HistoryViewStore::default();
    assert!(store.of_pane("p1").is_none());

    store.show("p1", HistoryTarget::AboveLive);
    assert_eq!(store.of_pane("p1"), Some(&HistoryTarget::AboveLive));
    assert!(store.of_pane("p2").is_none());

    store.show("p1", HistoryTarget::Line(40));
    assert_eq!(store.of_pane("p1"), Some(&HistoryTarget::Line(40)));

    store.show("p2", HistoryTarget::Match(find()));
    assert_eq!(store.of_pane("p2"), Some(&HistoryTarget::Match(find())));
    assert_eq!(store.of_pane("p1"), Some(&HistoryTarget::Line(40)));
}

#[test]
fn close_drops_the_target_once_and_changes_nothing_for_a_pane_that_is_not_open() {
    let mut store = HistoryViewStore::default();
    assert!(!store.close("p1"));

    store.show("p1", HistoryTarget::AboveLive);
    store.show("p2", HistoryTarget::Line(1));
    assert!(store.close("p1"));
    assert!(store.of_pane("p1").is_none());
    assert!(!store.close("p1"));
    assert_eq!(store.of_pane("p2"), Some(&HistoryTarget::Line(1)));
}
