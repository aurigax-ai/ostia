#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::terminal::history_search_store::HistorySearchStore;

#[test]
fn starts_closed_and_follows_set_open() {
    let mut store = HistorySearchStore::default();
    assert!(!store.is_open());

    store.set_open(true);
    assert!(store.is_open());

    store.set_open(true);
    assert!(store.is_open());

    store.set_open(false);
    assert!(!store.is_open());
}
