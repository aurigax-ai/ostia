#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use ostia_base::clock::Clock;
use ostia_gateway::push::push_limits::{PingLimits, TicketLimits};

const START: i64 = 1_700_000_000_000;
const SECOND: i64 = 1000;
const HOUR: i64 = 3_600_000;
const TEN_MINUTES: i64 = 600_000;

fn clock() -> (Arc<AtomicI64>, Clock) {
    let now = Arc::new(AtomicI64::new(START));
    let reader = Arc::clone(&now);
    (now, Arc::new(move || reader.load(Ordering::SeqCst)))
}

fn tick(now: &AtomicI64, ms: i64) {
    now.fetch_add(ms, Ordering::SeqCst);
}

#[test]
fn allows_a_first_ping_and_refuses_another_inside_thirty_seconds() {
    let (now, clock) = clock();
    let limits = PingLimits::new(clock);
    assert!(limits.permit("h"));
    assert!(!limits.permit("h"));
    tick(&now, 29_999);
    assert!(!limits.permit("h"));
    tick(&now, 1);
    assert!(limits.permit("h"));
}

#[test]
fn a_refused_ping_does_not_move_the_thirty_second_gap() {
    let (now, clock) = clock();
    let limits = PingLimits::new(clock);
    assert!(limits.permit("h"));
    tick(&now, 20 * SECOND);
    assert!(!limits.permit("h"));
    tick(&now, 10 * SECOND);
    assert!(limits.permit("h"));
}

#[test]
fn allows_sixty_pings_an_hour_and_the_next_after_the_oldest_is_an_hour_old() {
    let (now, clock) = clock();
    let limits = PingLimits::new(clock);
    for n in 0..60 {
        assert!(limits.permit("h"), "ping {n}");
        tick(&now, 30 * SECOND);
    }
    assert!(!limits.permit("h"));
    tick(&now, HOUR - 60 * 30 * SECOND - 1);
    assert!(!limits.permit("h"));
    tick(&now, 1);
    assert!(limits.permit("h"));
}

#[test]
fn keeps_each_handle_apart() {
    let (_now, clock) = clock();
    let limits = PingLimits::new(clock);
    assert!(limits.permit("a"));
    assert!(limits.permit("b"));
    assert!(!limits.permit("a"));
    assert!(!limits.permit("b"));
}

#[test]
fn blocks_a_handle_for_the_seconds_it_is_told() {
    let (now, clock) = clock();
    let limits = PingLimits::new(clock);
    assert!(limits.permit("h"));
    limits.block_for("h", 120.0);
    tick(&now, 31 * SECOND);
    assert!(!limits.permit("h"));
    tick(&now, 88 * SECOND);
    assert!(!limits.permit("h"));
    tick(&now, SECOND);
    assert!(limits.permit("h"));
}

#[test]
fn keeps_the_fraction_of_a_second_in_a_block() {
    let (now, clock) = clock();
    let limits = PingLimits::new(clock);
    assert!(limits.permit("h"));
    limits.block_for("h", 40.5);
    tick(&now, 40 * SECOND);
    assert!(!limits.permit("h"));
    tick(&now, SECOND);
    assert!(limits.permit("h"));
}

#[test]
fn a_huge_block_never_wraps_into_the_past() {
    let (now, clock) = clock();
    let limits = PingLimits::new(clock);
    assert!(limits.permit("h"));
    limits.block_for("h", 1e17);
    tick(&now, 3_600 * SECOND);
    assert!(!limits.permit("h"));
}

#[test]
fn a_block_on_a_handle_that_never_pinged_does_nothing() {
    let (_now, clock) = clock();
    let limits = PingLimits::new(clock);
    limits.block_for("h", 600.0);
    assert!(limits.permit("h"));
}

#[test]
fn forgets_one_handle_or_all_of_them() {
    let (_now, clock) = clock();
    let limits = PingLimits::new(clock);
    assert!(limits.permit("a"));
    assert!(limits.permit("b"));
    limits.forget("a");
    assert!(limits.permit("a"));
    assert!(!limits.permit("b"));
    limits.clear();
    assert!(limits.permit("a"));
    assert!(limits.permit("b"));
}

#[test]
fn allows_three_tickets_in_ten_minutes_and_refuses_the_fourth() {
    let (_now, clock) = clock();
    let limits = TicketLimits::new(clock);
    for n in 0..3 {
        assert!(limits.permit("d"), "ticket {n}");
    }
    assert!(!limits.permit("d"));
}

#[test]
fn counts_a_refused_ask_toward_the_window() {
    let (now, clock) = clock();
    let limits = TicketLimits::new(clock);
    for _ in 0..3 {
        assert!(limits.permit("d"));
    }
    tick(&now, TEN_MINUTES / 2);
    for _ in 0..3 {
        assert!(!limits.permit("d"));
    }
    tick(&now, TEN_MINUTES / 2);
    assert!(!limits.permit("d"));
    tick(&now, TEN_MINUTES / 2);
    assert!(limits.permit("d"));
}

#[test]
fn lets_an_ask_through_once_the_old_ones_are_ten_minutes_old() {
    let (now, clock) = clock();
    let limits = TicketLimits::new(clock);
    for _ in 0..3 {
        assert!(limits.permit("d"));
    }
    tick(&now, TEN_MINUTES - 1);
    assert!(!limits.permit("d"));
    tick(&now, 1);
    assert!(limits.permit("d"));
}

#[test]
fn keeps_each_device_apart_for_tickets() {
    let (_now, clock) = clock();
    let limits = TicketLimits::new(clock);
    for _ in 0..4 {
        limits.permit("a");
    }
    assert!(limits.permit("b"));
}
