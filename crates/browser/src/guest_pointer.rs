use std::sync::Arc;

use ostia_base::clock::Clock;

pub const GUEST_POINTER_DOWN: &str = "guest-input:pointer-down";

pub trait PointerOwner: Send + Sync {
    fn is_destroyed(&self) -> bool;
    fn send_pointer_down(&self, guest_id: u32, at: i64);
}

#[derive(Clone)]
pub struct GuestPointer {
    guest_id: u32,
    owner: Arc<dyn PointerOwner>,
    clock: Clock,
}

pub fn announce_guest_pointer(
    guest_id: u32,
    owner: Arc<dyn PointerOwner>,
    clock: Clock,
) -> GuestPointer {
    GuestPointer {
        guest_id,
        owner,
        clock,
    }
}

impl GuestPointer {
    pub fn before_mouse_event(&self, kind: &str) {
        if kind == "mouseDown" && !self.owner.is_destroyed() {
            self.owner.send_pointer_down(self.guest_id, (self.clock)());
        }
    }
}
