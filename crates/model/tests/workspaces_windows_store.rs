#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::windows_api::WindowSummary;
use ostia_model::workspaces::windows_store::WindowsStore;

fn window(id: &str, detached: bool) -> WindowSummary {
    WindowSummary {
        window_id: id.to_owned(),
        detached,
        workspaces: Vec::new(),
    }
}

#[test]
fn starts_with_no_window_id_attached_and_an_empty_list() {
    let store = WindowsStore::default();
    assert_eq!(store.window_id(), None);
    assert!(!store.detached());
    assert!(store.list().is_empty());
}

#[test]
fn set_info_records_the_window_id_and_whether_it_is_detached() {
    let mut store = WindowsStore::default();
    assert!(store.set_info("w2", true));
    assert_eq!(store.window_id(), Some("w2"));
    assert!(store.detached());
    store.set_info("w3", false);
    assert_eq!(store.window_id(), Some("w3"));
    assert!(!store.detached());
}

#[test]
fn set_list_replaces_the_whole_list_and_leaves_the_window_info() {
    let mut store = WindowsStore::default();
    store.set_info("w1", false);
    assert!(store.set_list(vec![window("w1", false), window("w2", true)]));
    assert_eq!(store.list(), [window("w1", false), window("w2", true)]);
    store.set_list(vec![window("w2", true)]);
    assert_eq!(store.list(), [window("w2", true)]);
    assert_eq!(store.window_id(), Some("w1"));
}
