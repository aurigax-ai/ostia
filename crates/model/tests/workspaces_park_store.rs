#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::workspaces::park_store::{PARK_NOTICE_MS, ParkNotice, ParkNoticeKind, ParkStore};

fn parked(workspace: &str, title: &str) -> ParkNoticeKind {
    ParkNoticeKind::Parked {
        workspace_id: workspace.to_owned(),
        title: title.to_owned(),
    }
}

fn refused(reason: &str) -> ParkNoticeKind {
    ParkNoticeKind::Refused {
        workspace_id: "w1".to_owned(),
        pane_id: "p1".to_owned(),
        title: "Claude".to_owned(),
        reason: reason.to_owned(),
    }
}

fn resume_failed(reason: &str) -> ParkNoticeKind {
    ParkNoticeKind::ResumeFailed {
        workspace_id: "w1".to_owned(),
        pane_id: "p1".to_owned(),
        title: "Claude".to_owned(),
        reason: reason.to_owned(),
    }
}

fn seq_of(store: &ParkStore) -> u64 {
    store.notice().map(ParkNotice::seq).unwrap()
}

#[test]
fn the_notice_stays_for_fifteen_seconds() {
    assert_eq!(PARK_NOTICE_MS, 15_000);
}

#[test]
fn starts_with_no_notice() {
    assert!(ParkStore::default().notice().is_none());
}

#[test]
fn show_notice_keeps_each_kind_with_its_fields() {
    for kind in [
        parked("w1", "Claude"),
        resume_failed("folder-missing"),
        refused("no-session"),
    ] {
        let mut store = ParkStore::default();
        assert!(store.show_notice(kind.clone()), "kind {kind:?}");
        assert_eq!(store.notice().map(ParkNotice::kind), Some(&kind));
    }
}

#[test]
fn every_notice_gets_a_higher_sequence_number() {
    let mut store = ParkStore::default();
    store.show_notice(parked("w1", "a"));
    let first = seq_of(&store);
    store.show_notice(parked("w1", "a"));
    let second = seq_of(&store);
    assert!(second > first);
}

#[test]
fn a_new_notice_replaces_the_one_that_is_open() {
    let mut store = ParkStore::default();
    store.show_notice(parked("w1", "a"));
    store.show_notice(refused("working"));
    assert_eq!(
        store.notice().map(ParkNotice::kind),
        Some(&refused("working"))
    );
}

#[test]
fn expire_clears_the_notice_that_has_the_sequence_number() {
    let mut store = ParkStore::default();
    store.show_notice(parked("w1", "a"));
    let seq = seq_of(&store);
    assert!(store.expire(seq));
    assert!(store.notice().is_none());
}

#[test]
fn the_timer_of_a_replaced_notice_does_not_clear_the_new_one() {
    let mut store = ParkStore::default();
    store.show_notice(parked("w1", "a"));
    let old = seq_of(&store);
    store.show_notice(parked("w1", "b"));
    let current = seq_of(&store);
    assert!(!store.expire(old));
    assert_eq!(
        store.notice().map(ParkNotice::kind),
        Some(&parked("w1", "b"))
    );
    assert!(store.expire(current));
    assert!(store.notice().is_none());
}

#[test]
fn expire_changes_nothing_when_no_notice_is_open() {
    let mut store = ParkStore::default();
    assert!(!store.expire(1));
}

#[test]
fn dismiss_notice_closes_the_notice_and_its_timer_finds_nothing_to_clear() {
    let mut store = ParkStore::default();
    store.show_notice(parked("w1", "a"));
    let seq = seq_of(&store);
    store.dismiss_notice();
    assert!(store.notice().is_none());
    assert!(!store.expire(seq));
}

#[test]
fn a_dismissed_store_numbers_the_next_notice_above_the_old_one() {
    let mut store = ParkStore::default();
    store.show_notice(parked("w1", "a"));
    let old = seq_of(&store);
    store.dismiss_notice();
    store.show_notice(parked("w1", "b"));
    assert!(seq_of(&store) > old);
    assert!(!store.expire(old));
    assert!(store.notice().is_some());
}
