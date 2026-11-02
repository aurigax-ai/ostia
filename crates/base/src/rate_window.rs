use std::collections::VecDeque;

#[derive(Debug)]
pub struct RateWindow {
    window_ms: i64,
    stamps: VecDeque<i64>,
}

impl RateWindow {
    pub fn new(window_ms: i64) -> Self {
        Self {
            window_ms,
            stamps: VecDeque::new(),
        }
    }

    pub fn take(&mut self, limit: usize, now: i64) -> bool {
        while self
            .stamps
            .front()
            .is_some_and(|stamp| now - stamp >= self.window_ms)
        {
            self.stamps.pop_front();
        }
        if self.stamps.len() >= limit {
            return false;
        }
        self.stamps.push_back(now);
        true
    }
}
