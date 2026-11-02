#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::pty_api::KeptLink;
use ostia_model::terminal::kept_link_store::KeptLinkStore;

#[test]
fn keeps_a_down_link_for_the_pane_and_reports_a_change_only_when_it_differs() {
    let mut store = KeptLinkStore::default();
    assert!(store.of_pane("p1").is_none());

    assert!(store.set("p1", KeptLink::Reconnecting));
    assert_eq!(store.of_pane("p1"), Some(KeptLink::Reconnecting));
    assert!(!store.set("p1", KeptLink::Reconnecting));

    assert!(store.set("p1", KeptLink::Failed));
    assert_eq!(store.of_pane("p1"), Some(KeptLink::Failed));
    assert!(store.of_pane("p2").is_none());
}

#[test]
fn a_link_that_is_up_drops_the_pane_once_and_is_never_stored() {
    let mut store = KeptLinkStore::default();
    assert!(!store.set("p1", KeptLink::Up));
    assert!(store.of_pane("p1").is_none());

    store.set("p1", KeptLink::Failed);
    store.set("p2", KeptLink::Reconnecting);
    assert!(store.set("p1", KeptLink::Up));
    assert!(store.of_pane("p1").is_none());
    assert!(!store.set("p1", KeptLink::Up));
    assert_eq!(store.of_pane("p2"), Some(KeptLink::Reconnecting));
}
