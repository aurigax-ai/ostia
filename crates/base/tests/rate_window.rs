#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_base::rate_window::RateWindow;

#[test]
fn allows_calls_up_to_the_limit_and_refuses_the_next_one() {
    let mut window = RateWindow::new(1000);
    assert!(window.take(3, 0));
    assert!(window.take(3, 10));
    assert!(window.take(3, 20));
    assert!(!window.take(3, 30));
}

#[test]
fn frees_a_slot_once_a_call_is_a_full_window_old() {
    let mut window = RateWindow::new(1000);
    assert!(window.take(2, 0));
    assert!(window.take(2, 500));
    assert!(!window.take(2, 999));
    assert!(window.take(2, 1000));
    assert!(!window.take(2, 1001));
    assert!(window.take(2, 1500));
}

#[test]
fn does_not_record_a_call_it_refused() {
    let mut window = RateWindow::new(1000);
    assert!(window.take(1, 0));
    assert!(!window.take(1, 900));
    assert!(window.take(1, 1000));
}

#[test]
fn refuses_everything_with_a_limit_of_zero() {
    let mut window = RateWindow::new(1000);
    assert!(!window.take(0, 0));
    assert!(!window.take(0, 5000));
}

#[test]
fn applies_the_limit_of_each_call_to_the_calls_kept() {
    let mut window = RateWindow::new(1000);
    assert!(window.take(5, 0));
    assert!(window.take(5, 1));
    assert!(!window.take(2, 2));
    assert!(window.take(3, 2));
}
