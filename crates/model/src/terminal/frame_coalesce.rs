#[derive(Clone, Copy, Debug, Default)]
pub struct FrameCoalesce {
    pending: bool,
}

impl FrameCoalesce {
    pub fn request(&mut self) -> bool {
        if self.pending {
            return false;
        }
        self.pending = true;
        true
    }

    pub fn take_frame(&mut self) -> bool {
        std::mem::take(&mut self.pending)
    }

    pub fn cancel(&mut self) {
        self.pending = false;
    }
}
