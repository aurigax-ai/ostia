use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}

pub fn system_clock() -> Clock {
    Arc::new(now_ms)
}
