use ostia_base::js::js_round;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct UsageWindow {
    pub percent: f64,
    pub resets_at: i64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AccountUsage {
    pub session: Option<UsageWindow>,
    pub weekly: Option<UsageWindow>,
    pub checked_at: i64,
}

pub fn percent_now(window: Option<&UsageWindow>, now: i64) -> Option<i64> {
    let window = window?;
    if window.resets_at <= now {
        return Some(0);
    }
    Some(js_round(window.percent) as i64)
}
