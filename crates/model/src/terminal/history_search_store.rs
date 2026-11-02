#[derive(Clone, Copy, Debug, Default)]
pub struct HistorySearchStore {
    open: bool,
}

impl HistorySearchStore {
    pub fn is_open(&self) -> bool {
        self.open
    }

    pub fn set_open(&mut self, open: bool) {
        self.open = open;
    }
}
