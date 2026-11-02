#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::attention::bell::{BellActions, BellMode, BellThrottle, bell_actions};

fn actions(attention: bool, sound: bool) -> BellActions {
    BellActions { attention, sound }
}

#[test]
fn raises_attention_for_a_pane_you_are_not_viewing_and_sounds_only_in_sound_mode() {
    assert_eq!(
        bell_actions(BellMode::Attention, false),
        actions(true, false)
    );
    assert_eq!(
        bell_actions(BellMode::Attention, true),
        actions(false, false)
    );
    assert_eq!(bell_actions(BellMode::Sound, false), actions(true, true));
    assert_eq!(bell_actions(BellMode::Sound, true), actions(false, true));
}

#[test]
fn does_nothing_when_the_bell_is_off() {
    assert_eq!(bell_actions(BellMode::Off, false), actions(false, false));
}

#[test]
fn lets_one_sound_through_per_interval_so_a_flood_of_bel_stays_one_beep() {
    let mut throttle = BellThrottle::new(500.0);
    assert!(throttle.allow(1000.0));
    assert!(!throttle.allow(1200.0));
    assert!(!throttle.allow(1499.0));
    assert!(throttle.allow(1500.0));
}

#[test]
fn the_default_interval_is_500_milliseconds() {
    let mut throttle = BellThrottle::default();
    assert!(throttle.allow(0.0));
    assert!(!throttle.allow(499.0));
    assert!(throttle.allow(500.0));
}
