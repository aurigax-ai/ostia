#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::panic::{AssertUnwindSafe, catch_unwind};

use ostia_browser::guest_inject::GuestInject;

#[test]
fn reports_a_guest_as_not_injecting_by_default() {
    let inject = GuestInject::new();
    assert!(!inject.is_injecting(7));
}

#[test]
fn marks_the_guest_while_the_send_runs_and_clears_it_after() {
    let inject = GuestInject::new();
    let seen = inject.inject_into(7, || inject.is_injecting(7));
    assert!(seen);
    assert!(!inject.is_injecting(7));
}

#[test]
fn returns_what_the_send_returns() {
    let inject = GuestInject::new();
    assert_eq!(inject.inject_into(7, || 42), 42);
}

#[test]
fn marks_only_the_guest_that_is_injected_into() {
    let inject = GuestInject::new();
    let other = inject.inject_into(7, || inject.is_injecting(8));
    assert!(!other);
}

#[test]
fn keeps_the_mark_until_the_outer_send_ends_when_sends_nest() {
    let inject = GuestInject::new();
    inject.inject_into(7, || {
        inject.inject_into(7, || ());
        assert!(inject.is_injecting(7));
    });
    assert!(!inject.is_injecting(7));
}

#[test]
fn clears_the_mark_when_the_send_panics() {
    let inject = GuestInject::new();
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        inject.inject_into(7, || panic!("send failed"));
    }));
    assert!(outcome.is_err());
    assert!(!inject.is_injecting(7));
}

#[test]
fn clears_only_the_inner_mark_when_a_nested_send_panics_and_the_outer_goes_on() {
    let inject = GuestInject::new();
    inject.inject_into(7, || {
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            inject.inject_into(7, || panic!("send failed"));
        }));
        assert!(outcome.is_err());
        assert!(inject.is_injecting(7));
    });
    assert!(!inject.is_injecting(7));
}

#[test]
fn shares_the_marks_between_clones() {
    let inject = GuestInject::new();
    let clone = inject.clone();
    let seen = inject.inject_into(7, || clone.is_injecting(7));
    assert!(seen);
}
