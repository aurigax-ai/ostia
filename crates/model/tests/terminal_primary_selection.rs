#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::time::Duration;

use ostia_model::terminal::primary_selection::{
    PRIMARY_WRITE_DELAY_MS, PrimaryDebounce, blocks_middle_click, primary_text,
};

fn at(ms: u64) -> Duration {
    Duration::from_millis(ms)
}

#[test]
fn puts_the_settled_terminal_selection_in_the_primary_selection_once() {
    let mut debounce = PrimaryDebounce::default();
    debounce.changed(at(0));
    debounce.changed(at(0));
    assert!(!debounce.settled(at(PRIMARY_WRITE_DELAY_MS - 1)));
    assert!(debounce.settled(at(PRIMARY_WRITE_DELAY_MS)));
    assert!(!debounce.settled(at(PRIMARY_WRITE_DELAY_MS + 1)));
    assert_eq!(primary_text(true, Some("git status")), Some("git status"));
}

#[test]
fn writes_nothing_and_blocks_the_middle_click_paste_while_it_is_off() {
    assert_eq!(primary_text(false, Some("git status")), None);
    assert!(blocks_middle_click(1, false));
    assert!(!blocks_middle_click(0, false));
}

#[test]
fn leaves_the_middle_click_alone_while_it_is_on_and_stops_after_removal() {
    assert!(!blocks_middle_click(1, true));
    let mut debounce = PrimaryDebounce::default();
    debounce.changed(at(0));
    debounce.cancel();
    assert!(!debounce.settled(at(PRIMARY_WRITE_DELAY_MS)));
}

#[test]
fn each_change_restarts_the_wait() {
    let mut debounce = PrimaryDebounce::default();
    debounce.changed(at(0));
    debounce.changed(at(100));
    assert!(!debounce.settled(at(PRIMARY_WRITE_DELAY_MS)));
    assert!(!debounce.settled(at(249)));
    assert!(debounce.settled(at(100 + PRIMARY_WRITE_DELAY_MS)));
}

#[test]
fn nothing_is_due_before_the_first_change() {
    let mut debounce = PrimaryDebounce::default();
    assert!(!debounce.settled(at(10_000)));
}

#[test]
fn a_change_after_a_settled_write_starts_a_new_wait() {
    let mut debounce = PrimaryDebounce::default();
    debounce.changed(at(0));
    assert!(debounce.settled(at(PRIMARY_WRITE_DELAY_MS)));
    debounce.changed(at(1_000));
    assert!(!debounce.settled(at(1_000 + PRIMARY_WRITE_DELAY_MS - 1)));
    assert!(debounce.settled(at(1_000 + PRIMARY_WRITE_DELAY_MS)));
}

#[test]
fn an_empty_selection_is_not_written() {
    assert_eq!(primary_text(true, Some("")), None);
    assert_eq!(primary_text(true, None), None);
}

#[test]
fn only_the_middle_button_is_blocked() {
    for button in [0u8, 2, 3, 4] {
        assert!(!blocks_middle_click(button, false), "button {button}");
    }
}
