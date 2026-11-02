use ostia_terminal::pty_flow::FLOW_LOW_WATERMARK;

pub const PTY_ACK_CHARS: i64 = FLOW_LOW_WATERMARK;

pub struct PtyAcker<F: FnMut(i64)> {
    unsent: i64,
    send: F,
}

impl<F: FnMut(i64)> PtyAcker<F> {
    pub fn new(send: F) -> Self {
        Self { unsent: 0, send }
    }

    pub fn written(&mut self, chars: i64) {
        self.unsent += chars;
        if self.unsent < PTY_ACK_CHARS {
            return;
        }
        (self.send)(self.unsent);
        self.unsent = 0;
    }
}
