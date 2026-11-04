#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_model::git::git_split::{
    SplitBounds, clamp_position, fraction_of, key_position, percent_of, split_basis, split_bounds,
};

fn bounds(min: f64, max: f64) -> SplitBounds {
    SplitBounds {
        min,
        max,
        collapsed: false,
    }
}

#[test]
fn bounds_keep_room_for_the_second_pane() {
    assert_eq!(
        split_bounds(500.0, 100.0, 150.0),
        SplitBounds {
            min: 100.0,
            max: 350.0,
            collapsed: false
        }
    );
}

#[test]
fn bounds_are_collapsed_when_both_minimums_do_not_fit() {
    assert_eq!(
        split_bounds(200.0, 100.0, 150.0),
        SplitBounds {
            min: 50.0,
            max: 50.0,
            collapsed: true
        }
    );
    assert!(!split_bounds(250.0, 100.0, 150.0).collapsed);
    assert!(split_bounds(249.0, 100.0, 150.0).collapsed);
}

#[test]
fn bounds_never_go_below_zero() {
    assert_eq!(
        split_bounds(100.0, 100.0, 150.0),
        SplitBounds {
            min: 0.0,
            max: 0.0,
            collapsed: true
        }
    );
    assert_eq!(split_bounds(0.0, 100.0, 150.0).max, 0.0);
}

#[test]
fn clamps_a_position_into_the_bounds() {
    let b = bounds(100.0, 350.0);
    assert_eq!(clamp_position(50.0, &b), 100.0);
    assert_eq!(clamp_position(200.0, &b), 200.0);
    assert_eq!(clamp_position(900.0, &b), 350.0);
}

#[test]
fn the_fraction_is_the_clamped_position_over_the_total() {
    let b = bounds(100.0, 350.0);
    assert_eq!(fraction_of(200.0, 400.0, &b), 0.5);
    assert_eq!(fraction_of(10.0, 400.0, &b), 0.25);
    assert_eq!(fraction_of(999.0, 400.0, &b), 0.875);
}

#[test]
fn the_fraction_is_zero_for_no_room() {
    let b = bounds(0.0, 0.0);
    assert_eq!(fraction_of(10.0, 0.0, &b), 0.0);
    assert_eq!(fraction_of(10.0, -5.0, &b), 0.0);
}

#[test]
fn arrow_keys_move_by_sixteen_and_page_keys_by_sixty_four() {
    let b = bounds(100.0, 350.0);
    assert_eq!(key_position("ArrowUp", 200.0, &b), Some(184.0));
    assert_eq!(key_position("ArrowDown", 200.0, &b), Some(216.0));
    assert_eq!(key_position("PageUp", 200.0, &b), Some(136.0));
    assert_eq!(key_position("PageDown", 200.0, &b), Some(264.0));
}

#[test]
fn home_and_end_go_to_the_bounds() {
    let b = bounds(100.0, 350.0);
    assert_eq!(key_position("Home", 200.0, &b), Some(100.0));
    assert_eq!(key_position("End", 200.0, &b), Some(350.0));
}

#[test]
fn a_key_move_stops_at_the_bounds() {
    let b = bounds(100.0, 350.0);
    assert_eq!(key_position("ArrowUp", 100.0, &b), Some(100.0));
    assert_eq!(key_position("PageUp", 120.0, &b), Some(100.0));
    assert_eq!(key_position("ArrowDown", 345.0, &b), Some(350.0));
    assert_eq!(key_position("PageDown", 340.0, &b), Some(350.0));
}

#[test]
fn other_keys_give_no_move() {
    let b = bounds(100.0, 350.0);
    for key in ["Enter", "ArrowLeft", "ArrowRight", "a", "", "arrowup", " "] {
        assert_eq!(key_position(key, 200.0, &b), None, "{key:?}");
    }
}

#[test]
fn the_percent_is_the_rounded_share_of_the_total() {
    assert_eq!(percent_of(200.0, 400.0), 50);
    assert_eq!(percent_of(1.0, 3.0), 33);
    assert_eq!(percent_of(2.0, 3.0), 67);
    assert_eq!(percent_of(1.0, 8.0), 13);
    assert_eq!(percent_of(0.0, 400.0), 0);
}

#[test]
fn the_percent_is_zero_for_no_room() {
    assert_eq!(percent_of(10.0, 0.0), 0);
    assert_eq!(percent_of(10.0, -4.0), 0);
}

#[test]
fn the_percent_rounds_a_half_up_like_javascript() {
    assert_eq!(percent_of(1.0, 200.0), 1);
    assert_eq!(percent_of(-1.0, 200.0), 0);
    assert_eq!(percent_of(-3.0, 200.0), -1);
}

#[test]
fn the_basis_clamps_the_share_between_the_two_minimums() {
    assert_eq!(
        split_basis(0.5, 100.0, 200.0),
        "clamp(100px, 50%, calc(100% - 200px))"
    );
    assert_eq!(
        split_basis(0.25, 120.0, 80.0),
        "clamp(120px, 25%, calc(100% - 80px))"
    );
}

#[test]
fn the_basis_writes_the_percent_as_javascript_does() {
    assert_eq!(
        split_basis(0.3, 100.0, 100.0),
        "clamp(100px, 30.000000000000004%, calc(100% - 100px))"
    );
    assert_eq!(
        split_basis(0.0, 0.0, 0.0),
        "clamp(0px, 0%, calc(100% - 0px))"
    );
    assert_eq!(
        split_basis(12.5, 10.5, 20.0),
        "clamp(10.5px, 1250%, calc(100% - 20px))"
    );
}
