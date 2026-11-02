use std::time::Duration;

pub const PRIMARY_WRITE_DELAY_MS: u64 = 150;

const MIDDLE_BUTTON: u8 = 1;

#[derive(Clone, Copy, Debug, Default)]
pub struct PrimaryDebounce {
    due: Option<Duration>,
}

impl PrimaryDebounce {
    pub fn changed(&mut self, now: Duration) {
        self.due = Some(now + Duration::from_millis(PRIMARY_WRITE_DELAY_MS));
    }

    pub fn settled(&mut self, now: Duration) -> bool {
        match self.due {
            Some(due) if now >= due => {
                self.due = None;
                true
            }
            _ => false,
        }
    }

    pub fn cancel(&mut self) {
        self.due = None;
    }
}

pub fn primary_text(enabled: bool, selection: Option<&str>) -> Option<&str> {
    if !enabled {
        return None;
    }
    selection.filter(|text| !text.is_empty())
}

pub fn blocks_middle_click(button: u8, enabled: bool) -> bool {
    button == MIDDLE_BUTTON && !enabled
}
