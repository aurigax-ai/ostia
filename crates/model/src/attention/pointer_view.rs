use std::sync::Arc;

use parking_lot::Mutex;

pub const POINTER_VIEW_MS: i64 = 10_000;

#[derive(Clone, Default)]
pub struct PointerView {
    pointed: Arc<Mutex<Option<(String, i64)>>>,
}

impl PointerView {
    pub fn point_at_pane(&self, pane_id: &str, at: i64) {
        *self.pointed.lock() = Some((pane_id.to_owned(), at));
    }

    pub fn leave_pane(&self, pane_id: &str) {
        let mut pointed = self.pointed.lock();
        if pointed.as_ref().is_some_and(|(id, _)| id == pane_id) {
            *pointed = None;
        }
    }

    pub fn is_pane_pointed_at(&self, pane_id: &str, now: i64) -> bool {
        self.pointed
            .lock()
            .as_ref()
            .is_some_and(|(id, at)| id == pane_id && now - at <= POINTER_VIEW_MS)
    }

    pub fn reset(&self) {
        *self.pointed.lock() = None;
    }
}
