use std::collections::HashMap;

use ostia_base::clock::Clock;
use parking_lot::Mutex;

const PING_GAP_MS: i64 = 30_000;
const PINGS_PER_HOUR: usize = 60;
const HOUR_MS: i64 = 3_600_000;
const TICKETS_PER_WINDOW: usize = 3;
const TICKET_WINDOW_MS: i64 = 600_000;

#[derive(Default)]
struct PingState {
    last: i64,
    recent: Vec<i64>,
    blocked_until: i64,
}

pub struct PingLimits {
    now: Clock,
    states: Mutex<HashMap<String, PingState>>,
}

impl PingLimits {
    pub fn new(now: Clock) -> Self {
        Self {
            now,
            states: Mutex::new(HashMap::new()),
        }
    }

    pub fn permit(&self, handle: &str) -> bool {
        let now = (self.now)();
        let mut states = self.states.lock();
        let state = states.entry(handle.to_owned()).or_default();
        state.recent.retain(|at| now - at < HOUR_MS);
        let allowed = now - state.last >= PING_GAP_MS
            && now >= state.blocked_until
            && state.recent.len() < PINGS_PER_HOUR;
        if allowed {
            state.last = now;
            state.recent.push(now);
        }
        allowed
    }

    pub fn block_for(&self, handle: &str, seconds: i64) {
        let now = (self.now)();
        if let Some(state) = self.states.lock().get_mut(handle) {
            state.blocked_until = now + seconds * 1000;
        }
    }

    pub fn forget(&self, handle: &str) {
        self.states.lock().remove(handle);
    }

    pub fn clear(&self) {
        self.states.lock().clear();
    }
}

pub struct TicketLimits {
    now: Clock,
    asked: Mutex<HashMap<String, Vec<i64>>>,
}

impl TicketLimits {
    pub fn new(now: Clock) -> Self {
        Self {
            now,
            asked: Mutex::new(HashMap::new()),
        }
    }

    pub fn permit(&self, device_id: &str) -> bool {
        let now = (self.now)();
        let mut asked = self.asked.lock();
        let times = asked.entry(device_id.to_owned()).or_default();
        times.retain(|at| now - at < TICKET_WINDOW_MS);
        let allowed = times.len() < TICKETS_PER_WINDOW;
        times.push(now);
        allowed
    }
}
