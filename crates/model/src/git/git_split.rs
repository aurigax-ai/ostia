use ostia_base::js::{js_number_text, js_round};

const SPLIT_KEY_STEP: f64 = 16.0;
const SPLIT_PAGE_STEP: f64 = 64.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SplitBounds {
    pub min: f64,
    pub max: f64,
    pub collapsed: bool,
}

fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

pub fn split_bounds(total: f64, min_first: f64, min_second: f64) -> SplitBounds {
    let max = js_max(0.0, total - min_second);
    SplitBounds {
        min: js_min(min_first, max),
        max,
        collapsed: total < min_first + min_second,
    }
}

pub fn clamp_position(position: f64, bounds: &SplitBounds) -> f64 {
    js_min(bounds.max, js_max(bounds.min, position))
}

pub fn fraction_of(position: f64, total: f64, bounds: &SplitBounds) -> f64 {
    if total <= 0.0 {
        return 0.0;
    }
    clamp_position(position, bounds) / total
}

pub fn key_position(key: &str, position: f64, bounds: &SplitBounds) -> Option<f64> {
    let moved = match key {
        "ArrowUp" => position - SPLIT_KEY_STEP,
        "ArrowDown" => position + SPLIT_KEY_STEP,
        "PageUp" => position - SPLIT_PAGE_STEP,
        "PageDown" => position + SPLIT_PAGE_STEP,
        "Home" => bounds.min,
        "End" => bounds.max,
        _ => return None,
    };
    Some(clamp_position(moved, bounds))
}

pub fn percent_of(position: f64, total: f64) -> i64 {
    if total > 0.0 {
        js_round(position / total * 100.0) as i64
    } else {
        0
    }
}

pub fn split_basis(fraction: f64, min_first: f64, min_second: f64) -> String {
    format!(
        "clamp({}px, {}%, calc(100% - {}px))",
        js_number_text(min_first),
        js_number_text(fraction * 100.0),
        js_number_text(min_second)
    )
}
