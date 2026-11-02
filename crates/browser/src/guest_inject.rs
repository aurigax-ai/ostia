use std::collections::HashSet;
use std::sync::Arc;

use parking_lot::Mutex;

#[derive(Debug, Clone, Default)]
pub struct GuestInject {
    injecting: Arc<Mutex<HashSet<u32>>>,
}

struct Release<'a> {
    injecting: &'a Mutex<HashSet<u32>>,
    guest_id: u32,
    nested: bool,
}

impl Drop for Release<'_> {
    fn drop(&mut self) {
        if !self.nested {
            self.injecting.lock().remove(&self.guest_id);
        }
    }
}

impl GuestInject {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_injecting(&self, guest_id: u32) -> bool {
        self.injecting.lock().contains(&guest_id)
    }

    pub fn inject_into<T>(&self, guest_id: u32, send: impl FnOnce() -> T) -> T {
        let nested = !self.injecting.lock().insert(guest_id);
        let _release = Release {
            injecting: &self.injecting,
            guest_id,
            nested,
        };
        send()
    }
}
