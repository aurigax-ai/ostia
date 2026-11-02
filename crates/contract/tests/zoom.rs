#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::zoom::{ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN, clamp_zoom, step_zoom, zoom_factor};
use serde_json::{Value, json};

#[test]
fn keeps_values_inside_80_to_150_and_rounds_to_a_whole_percent() {
    assert_eq!(clamp_zoom(&json!(10)), ZOOM_MIN);
    assert_eq!(clamp_zoom(&json!(400)), ZOOM_MAX);
    assert_eq!(clamp_zoom(&json!(112.6)), 113);
}

#[test]
fn falls_back_to_100_for_anything_that_is_not_a_finite_number() {
    assert_eq!(clamp_zoom(&json!("120")), ZOOM_DEFAULT);
    assert_eq!(clamp_zoom(&json!(f64::NAN)), ZOOM_DEFAULT);
    assert_eq!(clamp_zoom(&Value::Null), ZOOM_DEFAULT);
}

#[test]
fn moves_in_10_point_steps_and_stops_at_the_limits() {
    assert_eq!(step_zoom(100.0, 1), 110);
    assert_eq!(step_zoom(100.0, -1), 90);
    assert_eq!(step_zoom(150.0, 1), 150);
    assert_eq!(step_zoom(80.0, -1), 80);
}

#[test]
fn snaps_an_off_grid_value_to_the_grid_before_stepping() {
    assert_eq!(step_zoom(113.0, 1), 120);
    assert_eq!(step_zoom(113.0, -1), 100);
}

#[test]
fn converts_percent_to_an_electron_zoom_factor_within_range() {
    assert_eq!(zoom_factor(&json!(125)), 1.25);
    assert_eq!(zoom_factor(&json!(500)), 1.5);
    assert_eq!(zoom_factor(&json!(0)), 0.8);
}
