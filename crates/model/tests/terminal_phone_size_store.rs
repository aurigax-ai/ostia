#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use ostia_model::terminal::phone_size_store::{PhoneSizeStore, PhoneSized};

fn counting(cols: u16) -> (PhoneSized, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&calls);
    let sized = PhoneSized::new(cols, move || {
        seen.fetch_add(1, Ordering::SeqCst);
    });
    (sized, calls)
}

#[test]
fn holds_the_phone_size_of_a_pane_and_replaces_it_on_a_second_hold() {
    let mut store = PhoneSizeStore::default();
    assert!(store.of_pane("p1").is_none());
    let (first, _) = counting(42);
    assert!(store.hold("p1", first));
    assert_eq!(store.of_pane("p1").map(PhoneSized::cols), Some(42));
    let (second, _) = counting(60);
    assert!(store.hold("p1", second));
    assert_eq!(store.of_pane("p1").map(PhoneSized::cols), Some(60));
}

#[test]
fn keeps_the_size_of_each_pane_apart() {
    let mut store = PhoneSizeStore::default();
    let (one, _) = counting(40);
    let (two, _) = counting(50);
    store.hold("p1", one);
    store.hold("p2", two);
    assert!(store.release("p1"));
    assert!(store.of_pane("p1").is_none());
    assert_eq!(store.of_pane("p2").map(PhoneSized::cols), Some(50));
}

#[test]
fn releasing_a_pane_that_holds_nothing_changes_nothing() {
    let mut store = PhoneSizeStore::default();
    assert!(!store.release("p1"));
    let (sized, _) = counting(40);
    store.hold("p1", sized);
    assert!(store.release("p1"));
    assert!(!store.release("p1"));
}

#[test]
fn the_held_use_desktop_callback_runs_on_each_call_and_not_on_hold_or_release() {
    let mut store = PhoneSizeStore::default();
    let (sized, calls) = counting(40);
    store.hold("p1", sized);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    store.of_pane("p1").unwrap().use_desktop();
    store.of_pane("p1").unwrap().use_desktop();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    store.release("p1");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[test]
fn a_cloned_store_keeps_the_same_callback() {
    let mut store = PhoneSizeStore::default();
    let (sized, calls) = counting(40);
    store.hold("p1", sized);
    let copy = store.clone();
    copy.of_pane("p1").unwrap().use_desktop();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}
