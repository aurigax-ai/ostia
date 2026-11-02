const BELL_SOUND_INTERVAL_MS: f64 = 500.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BellMode {
    Attention,
    Sound,
    Off,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BellActions {
    pub attention: bool,
    pub sound: bool,
}

pub fn bell_actions(mode: BellMode, viewed: bool) -> BellActions {
    if mode == BellMode::Off {
        return BellActions {
            attention: false,
            sound: false,
        };
    }
    BellActions {
        attention: !viewed,
        sound: mode == BellMode::Sound,
    }
}

#[derive(Clone, Debug)]
pub struct BellThrottle {
    interval_ms: f64,
    last: f64,
}

impl BellThrottle {
    pub fn new(interval_ms: f64) -> Self {
        Self {
            interval_ms,
            last: f64::NEG_INFINITY,
        }
    }

    pub fn allow(&mut self, now: f64) -> bool {
        if now - self.last < self.interval_ms {
            return false;
        }
        self.last = now;
        true
    }
}

impl Default for BellThrottle {
    fn default() -> Self {
        Self::new(BELL_SOUND_INTERVAL_MS)
    }
}
