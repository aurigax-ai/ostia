use serde_json::Value;

pub const ZOOM_MIN: i64 = 80;
pub const ZOOM_MAX: i64 = 150;
pub const ZOOM_STEP: i64 = 10;
pub const ZOOM_DEFAULT: i64 = 100;

fn clamp_percent(percent: Option<f64>) -> i64 {
    let rounded = percent
        .filter(|value| value.is_finite())
        .map_or(ZOOM_DEFAULT as f64, f64::round);
    rounded.clamp(ZOOM_MIN as f64, ZOOM_MAX as f64) as i64
}

pub fn clamp_zoom(percent: &Value) -> i64 {
    clamp_percent(percent.as_f64())
}

pub fn step_zoom(current: f64, direction: i64) -> i64 {
    let grid = (current / ZOOM_STEP as f64).round() * ZOOM_STEP as f64;
    clamp_percent(Some(grid + (direction * ZOOM_STEP) as f64))
}

pub fn zoom_factor(percent: &Value) -> f64 {
    clamp_zoom(percent) as f64 / 100.0
}
