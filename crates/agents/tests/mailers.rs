#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use ostia_agents::mail_delivery::{EVENT_BATCH_MS, MAIL_TURNS_MAX, MAIL_TURNS_WINDOW_MS};
use ostia_agents::mailers::{MailerState, Mailers};

fn mailers() -> (Mailers, Arc<AtomicI64>) {
    let clock = Arc::new(AtomicI64::new(1_000_000));
    let reader = Arc::clone(&clock);
    (
        Mailers::new(Arc::new(move || reader.load(Ordering::SeqCst))),
        clock,
    )
}

fn advance(clock: &AtomicI64, ms: i64) {
    clock.fetch_add(ms, Ordering::SeqCst);
}

#[test]
fn knows_a_pane_has_a_live_mailer_and_whether_the_human_is_drafting_until_it_is_cleared() {
    let (m, _clock) = mailers();
    assert_eq!(m.state("p"), None);
    m.set("p", false);
    assert_eq!(m.state("p"), Some(MailerState { draft: false }));
    m.set("p", true);
    assert_eq!(m.state("p"), Some(MailerState { draft: true }));
    m.clear("p");
    assert_eq!(m.state("p"), None);
}

#[test]
fn limits_mail_turns_to_the_maximum_per_window_and_frees_them_as_the_window_moves() {
    let (m, clock) = mailers();
    for _ in 0..MAIL_TURNS_MAX {
        assert!(!m.limited("p"));
        m.record_turn("p");
        advance(&clock, 1000);
    }
    assert!(m.limited("p"));
    assert!(!m.limited("other"));
    advance(&clock, MAIL_TURNS_WINDOW_MS);
    assert!(!m.limited("p"));
}

#[test]
fn says_how_long_until_the_oldest_turn_leaves_the_window_and_takes_a_turn_back() {
    let (m, clock) = mailers();
    assert_eq!(m.limited_ms("p"), 0);
    for _ in 0..MAIL_TURNS_MAX {
        m.record_turn("p");
        advance(&clock, 1000);
    }
    assert_eq!(
        m.limited_ms("p"),
        MAIL_TURNS_WINDOW_MS - i64::try_from(MAIL_TURNS_MAX).unwrap() * 1000
    );
    m.unrecord_turn("p");
    assert!(!m.limited("p"));
    assert_eq!(m.limited_ms("p"), 0);
}

#[test]
fn holds_events_for_the_batch_window_after_they_were_taken_and_not_before() {
    let (m, clock) = mailers();
    assert_eq!(m.events_wait_ms("p"), 0);
    m.mark_events("p");
    advance(&clock, 10_000);
    assert_eq!(m.events_wait_ms("p"), EVENT_BATCH_MS - 10_000);
    advance(&clock, EVENT_BATCH_MS);
    assert_eq!(m.events_wait_ms("p"), 0);
}

#[test]
fn forgets_a_panes_turns_and_batch_clock_with_it() {
    let (m, _clock) = mailers();
    for _ in 0..MAIL_TURNS_MAX {
        m.record_turn("p");
    }
    m.mark_events("p");
    m.clear("p");
    assert!(!m.limited("p"));
    assert_eq!(m.events_wait_ms("p"), 0);
}

#[test]
fn limits_a_pane_exactly_at_the_maximum_and_not_one_turn_before() {
    let (m, _clock) = mailers();
    for _ in 0..MAIL_TURNS_MAX - 1 {
        m.record_turn("p");
    }
    assert!(!m.limited("p"));
    assert_eq!(m.limited_ms("p"), 0);
    m.record_turn("p");
    assert!(m.limited("p"));
    assert_eq!(m.limited_ms("p"), MAIL_TURNS_WINDOW_MS);
}

#[test]
fn counts_a_turn_at_the_edge_of_the_window_as_already_gone() {
    let (m, clock) = mailers();
    m.record_turn("p");
    advance(&clock, MAIL_TURNS_WINDOW_MS - 1);
    for _ in 1..MAIL_TURNS_MAX {
        m.record_turn("p");
    }
    assert!(m.limited("p"));
    assert_eq!(m.limited_ms("p"), 1);
    advance(&clock, 1);
    assert!(!m.limited("p"));
}

#[test]
fn keeps_the_turns_and_batch_clock_of_each_pane_apart() {
    let (m, clock) = mailers();
    for _ in 0..MAIL_TURNS_MAX {
        m.record_turn("p");
    }
    m.mark_events("p");
    advance(&clock, 1000);
    assert!(m.limited("p"));
    assert!(!m.limited("q"));
    assert_eq!(m.events_wait_ms("q"), 0);
    assert_eq!(m.events_wait_ms("p"), EVENT_BATCH_MS - 1000);
}

#[test]
fn takes_back_nothing_for_a_pane_with_no_turns() {
    let (m, _clock) = mailers();
    m.unrecord_turn("p");
    assert!(!m.limited("p"));
    assert_eq!(m.limited_ms("p"), 0);
}

#[test]
fn clearing_a_pane_does_not_touch_another() {
    let (m, _clock) = mailers();
    m.set("p", true);
    m.set("q", false);
    m.mark_events("q");
    m.clear("p");
    assert_eq!(m.state("q"), Some(MailerState { draft: false }));
    assert_eq!(m.events_wait_ms("q"), EVENT_BATCH_MS);
}
