pub const BELL_FLASH_MIN_INTERVAL_MS: f64 = 334.0;

const REMOVE_GRACE_MS: f64 = 60.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BellFlashEasing {
    Out,
    InOut,
    Linear,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BellFlashRequest {
    pub enabled: bool,
    pub duration_ms: f64,
    pub easing: BellFlashEasing,
    pub color: Option<String>,
    pub reduced_motion: bool,
    pub now: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BellFlashOverlay {
    pub duration_ms: f64,
    pub easing: BellFlashEasing,
    pub color: Option<String>,
    expires_at: f64,
}

#[derive(Debug)]
pub struct BellFlash {
    last: f64,
    overlay: Option<BellFlashOverlay>,
}

impl Default for BellFlash {
    fn default() -> Self {
        Self {
            last: f64::NEG_INFINITY,
            overlay: None,
        }
    }
}

impl BellFlash {
    pub fn flash(&mut self, request: &BellFlashRequest) -> bool {
        if !request.enabled || request.reduced_motion {
            return false;
        }
        let quiet = request.now - self.last >= request.duration_ms.max(BELL_FLASH_MIN_INTERVAL_MS);
        self.last = request.now;
        if !quiet {
            return false;
        }
        self.overlay = Some(BellFlashOverlay {
            duration_ms: request.duration_ms,
            easing: request.easing,
            color: request.color.clone().filter(|color| !color.is_empty()),
            expires_at: request.now + request.duration_ms + REMOVE_GRACE_MS,
        });
        true
    }

    pub fn overlay(&self, now: f64) -> Option<&BellFlashOverlay> {
        self.overlay
            .as_ref()
            .filter(|overlay| now < overlay.expires_at)
    }

    pub fn dispose(&mut self) {
        self.overlay = None;
    }
}
