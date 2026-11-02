#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::attention::bell_flash::{
    BELL_FLASH_MIN_INTERVAL_MS, BellFlash, BellFlashEasing, BellFlashRequest,
};

fn base() -> BellFlashRequest {
    BellFlashRequest {
        enabled: true,
        duration_ms: 400.0,
        easing: BellFlashEasing::Out,
        color: None,
        reduced_motion: false,
        now: 10_000.0,
    }
}

fn at(now: f64) -> BellFlashRequest {
    BellFlashRequest { now, ..base() }
}

fn flashes(bell: &BellFlash, now: f64) -> usize {
    usize::from(bell.overlay(now).is_some())
}

#[test]
fn adds_one_overlay_that_carries_the_duration_and_easing_then_removes_it() {
    let mut bell = BellFlash::default();
    assert!(bell.flash(&BellFlashRequest {
        easing: BellFlashEasing::Linear,
        ..base()
    }));
    let overlay = bell.overlay(10_000.0).unwrap();
    assert_eq!(overlay.duration_ms, 400.0);
    assert_eq!(overlay.easing, BellFlashEasing::Linear);
    assert_eq!(flashes(&bell, 10_459.0), 1);
    assert_eq!(flashes(&bell, 10_460.0), 0);
    assert_eq!(flashes(&bell, 10_500.0), 0);
}

#[test]
fn flashes_once_for_repeated_bells_inside_the_duration() {
    let mut bell = BellFlash::default();
    assert!(bell.flash(&at(10_000.0)));
    assert!(!bell.flash(&at(10_100.0)));
    assert!(!bell.flash(&at(10_399.0)));
    assert_eq!(flashes(&bell, 10_399.0), 1);
}

#[test]
fn flashes_once_for_a_continuous_stream_and_again_once_it_has_been_quiet_for_the_duration() {
    let mut bell = BellFlash::default();
    let mut flashed = 0;
    for step in 0..20 {
        if bell.flash(&at(30_000.0 + f64::from(step) * 100.0)) {
            flashed += 1;
        }
    }
    assert_eq!(flashed, 1);
    assert!(!bell.flash(&at(30_000.0 + 1900.0 + 399.0)));
    assert!(bell.flash(&at(30_000.0 + 1900.0 + 399.0 + 400.0)));
}

#[test]
fn carries_the_theme_colour_onto_the_overlay_and_leaves_it_unset_otherwise() {
    let mut bell = BellFlash::default();
    bell.flash(&BellFlashRequest {
        color: Some("#abcdef".to_owned()),
        now: 40_000.0,
        ..base()
    });
    assert_eq!(
        bell.overlay(40_000.0).unwrap().color.as_deref(),
        Some("#abcdef")
    );
    bell.flash(&at(50_000.0));
    assert_eq!(bell.overlay(50_000.0).unwrap().color, None);
}

#[test]
fn flashes_again_once_the_duration_has_passed() {
    let mut bell = BellFlash::default();
    assert!(bell.flash(&at(10_000.0)));
    assert!(bell.flash(&at(10_400.0)));
    assert_eq!(flashes(&bell, 10_400.0), 1);
}

#[test]
fn never_flashes_more_than_three_times_a_second_even_for_a_very_short_duration() {
    let mut bell = BellFlash::default();
    let short = |now| BellFlashRequest {
        duration_ms: 50.0,
        now,
        ..base()
    };
    let min = BELL_FLASH_MIN_INTERVAL_MS;
    assert!(bell.flash(&short(20_000.0)));
    assert!(!bell.flash(&short(20_000.0 + min - 1.0)));
    assert!(bell.flash(&short(20_000.0 + min * 2.0 - 1.0)));
    assert!(min * 3.0 > 1000.0);
}

#[test]
fn does_nothing_when_the_setting_is_off() {
    let mut bell = BellFlash::default();
    assert!(!bell.flash(&BellFlashRequest {
        enabled: false,
        ..base()
    }));
    assert_eq!(flashes(&bell, 10_000.0), 0);
}

#[test]
fn does_nothing_under_reduced_motion_and_does_not_start_the_rate_limit() {
    let mut bell = BellFlash::default();
    assert!(!bell.flash(&BellFlashRequest {
        reduced_motion: true,
        ..base()
    }));
    assert_eq!(flashes(&bell, 10_000.0), 0);
    assert!(bell.flash(&at(base().now + 1.0)));
}

#[test]
fn removes_a_running_overlay_on_dispose() {
    let mut bell = BellFlash::default();
    bell.flash(&base());
    bell.dispose();
    assert_eq!(flashes(&bell, base().now), 0);
}

#[test]
fn a_disabled_request_does_not_start_the_rate_limit() {
    let mut bell = BellFlash::default();
    assert!(!bell.flash(&BellFlashRequest {
        enabled: false,
        ..base()
    }));
    assert!(bell.flash(&at(base().now + 1.0)));
}
